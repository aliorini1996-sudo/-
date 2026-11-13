// ============================================================================
// «هدف الشهر» — أهداف المندوب الشهرية (طلب المالك ٩ نوفمبر ٢٠٢٦).
//
// لكل مندوبٍ أهدافٌ في الشهر (حتى MAX_TARGETS_PER_MONTH)، لكلٍّ مكافأته وشريط تقدّمه:
//   • SALES_AMOUNT   مبيعات الشهر بمبلغ — صافي المبيعات (البيع − المرتجع) كما في كل شاشةٍ أخرى (services/netSales.ts).
//   • PRODUCT_QTY    كمية صنفٍ بوحدةٍ مختارة — صافي الكمية بالأساس ÷ لقطة معامل الوحدة (services/units.ts).
//   • COLLECTION_PCT تحصيل نسبةٍ من ديون المندوب الآجلة المفتوحة في بداية الشهر — collectionFold أدناه.
// والمكافأة: عمولة % من المبيعات، أو % من الراتب (نصٌّ وحده — الراتب لا يُخزَّن)، أو مبلغ محدد.
//
// التقدّم يُحسب حيّاً ولا يُخزَّن، من المستندات المؤكَّدة وحدها (الملغى لا يُعدّ أبداً)، وحدود الشهر بتوقيت الشركة
// (tenantTz) لا بتوقيت الخادم ولا الجهاز — فيرى المدير والمندوب الرقم نفسه. والطيّات صرفةٌ تُختبر بلا قاعدة؛ والمحمّل
// (repTargetsMonth / repTargetViewOf) يجمع صفوفها في ثلاثة استعلاماتٍ متوازية على الأكثر لكل ردّ.
// ومسارات الإدارة تمرّر نطاق المستخدم (RepTargetDocScope) فيرى المقيَّد ومشرف الفرق ما في نطاقه وحده؛ و/mine بلا نطاق.
// ============================================================================
import type { RepTarget } from '@prisma/client';
import prisma from '../config/database';
import { currencyDecimalsOf, getCountryTax } from '../config/countries';
import { tenantTz } from './invoiceExpiry';
import { addDays, addMonths, daysInMonth, diffDays, isLocalDate, todayLocal, zonedStartOfDay } from './gl/dates';
import { cleanMoney, isReturnInvoice, netSales } from './netSales';
import { baseQtyOf, factorOf, roundQty, type UnitSnapshot } from './units';
import { asVisitLike, mergeVisitsByRep } from './workDay';

// VISITS_COUNT وNEW_CUSTOMERS (طلب المالك ١١ نوفمبر ٢٠٢٦): عدد زيارات الشهر، وعملاء جدد نشطون فتحهم المندوب في الشهر
export const TARGET_KINDS = ['SALES_AMOUNT', 'PRODUCT_QTY', 'COLLECTION_PCT', 'VISITS_COUNT', 'NEW_CUSTOMERS'] as const;
export type TargetKind = typeof TARGET_KINDS[number];
export const REWARD_KINDS = ['COMMISSION_SALES_PCT', 'SALARY_PCT', 'FIXED_AMOUNT'] as const;
export type RewardKind = typeof REWARD_KINDS[number];

/** حدّ قيمة الهدف لكل نوع (أكبر من صفر دائماً): مبلغ، كمية بوحدة الهدف، نسبة */
export const TARGET_VALUE_MAX: Readonly<Record<TargetKind, number>> = {
  SALES_AMOUNT: 1e12, PRODUCT_QTY: 1e9, COLLECTION_PCT: 100, VISITS_COUNT: 1e6, NEW_CUSTOMERS: 1e6,
};
/** أصناف هدف الكمية الواحد (الأول + الإضافية) */
export const MAX_TARGET_PRODUCTS = 20;
/** حدّ قيمة المكافأة لكل نوع (أكبر من صفر دائماً): نسبة من المبيعات، نسبة من الراتب، مبلغ */
export const REWARD_VALUE_MAX: Readonly<Record<RewardKind, number>> = { COMMISSION_SALES_PCT: 100, SALARY_PCT: 1000, FIXED_AMOUNT: 1e9 };
/** أهداف المندوب في الشهر الواحد — سقفٌ يحمي الرئيسية من الازدحام */
export const MAX_TARGETS_PER_MONTH = 20;
export const NOTE_MAX = 300;
/** الشهر 'YYYY-MM' */
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** رموز الرفض ورسائلها — الواجهة تتفرّع على الرمز (web-admin/src/lib/repTargets.ts targetErrorMessage) */
export const TARGET_MESSAGES = Object.freeze({
  REP_NOT_FOUND: 'المندوب غير موجود',
  TARGET_NOT_FOUND: 'الهدف غير موجود',
  TARGET_PRODUCT_INVALID: 'اختر صنفاً صحيحاً',
  TARGET_UNIT_INVALID: 'وحدة الصنف غير صحيحة',
  TARGET_LIMIT: `وصلت للحد الأعلى من الأهداف لهذا الشهر (${MAX_TARGETS_PER_MONTH})`,
  TARGET_PRODUCT_DUPLICATE: 'الصنف مكرر في الهدف',
  TARGET_COMBO_INVALID: 'اختر هدفين أو أكثر لنفس المندوب في نفس الشهر',
  TARGET_IN_COMBO: 'أحد الأهداف مدمج مع أهداف أخرى افصله أولا',
  // «مدة الهدف»: أعضاء الهدف المدمج بنافذةٍ واحدة (الشهر كله، أو الفترة المخصّصة نفسها) — وإلا ظهر عضوٌ ممتدٌّ وحده في شهرٍ
  // لاحق بمكافأةٍ «مستحقة» بتحققه وحده، واختلفت عمولة المدمج بحسب ترتيب أعضائه
  TARGET_COMBO_PERIOD: 'الأهداف المدمجة يجب أن تكون بنفس المدة',
});
export type TargetCode = keyof typeof TARGET_MESSAGES;

/** ديونٌ مفتوحة دون هذا = لا ديون (غبار الهللات) */
export const BASE_EPS = 0.004;
const DONE_EPS = 1e-6;

/** تقريبٌ لمنزلة واحدة، و‎-0 صفر */
export const round1 = (n: number): number => (Math.round(n * 10) / 10) || 0;
const round4 = (n: number): number => (Math.round(n * 1e4) / 1e4) || 0;

/**
 * تقريبٌ لأعلى إلى خانات العملة بعد نقص غبار العائمة بـtoPrecision(12) كـroundHalfUp (lib/money.ts): ١٦٦٫٦٦٥ ⇒ ١٦٦٫٦٧ —
 * فهدف التحصيل المعروض هو العتبة نفسها، ومن حصّله بلغ النسبة
 */
export function ceilToDecimals(n: number, decimals: number): number {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** decimals;
  return (Math.ceil(Number((n * f).toPrecision(12))) / f) || 0;
}

// ═══ نافذة الشهر ═══

export interface MonthWindow {
  month: string;
  from: Date;
  to: Date;
  isCurrent: boolean;
  /** الشهر الجاري: الأيام الباقية مع اليوم (بتوقيت الشركة)؛ الماضي ٠؛ المقبل أيام الشهر كلها */
  daysLeft: number;
}

/** الشهر الجاري بتوقيت الشركة */
export const currentMonthOf = (now: Date, tz: string): string => todayLocal(now, tz).slice(0, 7);

/** حدود الشهر [from, to) بتوقيت الشركة: منتصف ليل أوله ومنتصف ليل أول الشهر التالي — صرفةٌ (المنطقة والساعة مُدخلان) */
export function monthWindow(month: string, tz: string, now: Date): MonthWindow {
  const first = `${month}-01`;
  const from = zonedStartOfDay(first, tz);
  const to = zonedStartOfDay(addMonths(first, 1), tz);
  const today = todayLocal(now, tz);
  const current = today.slice(0, 7);
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const total = daysInMonth(y, m);
  const isCurrent = month === current;
  const daysLeft = isCurrent ? total - Number(today.slice(8, 10)) + 1 : month < current ? 0 : total;
  return { month, from, to, isCurrent, daysLeft };
}

// ═══ مدة الهدف: الشهر كله أو فترةٌ مخصّصة (طلب المالك ١٣ نوفمبر ٢٠٢٦) ═══

/** أطول فترةٍ مخصّصة بالأيام (سنةٌ كبيسة) — وأقصرها يومٌ واحد */
export const PERIOD_MAX_DAYS = 366;

export type PeriodState = 'UPCOMING' | 'ACTIVE' | 'ENDED';
/** فترة الهدف كما تُعرض: أول يومٍ وآخره شاملاً بتوقيت الشركة، ومخصّصةٌ أم الشهر، وحالها اليوم */
export interface TargetPeriod {
  from: string;
  to: string;
  custom: boolean;
  state: PeriodState;
  /** الجارية: الأيام الباقية مع اليوم · المقبلة: أيامها كلها · المنتهية ٠ */
  daysLeft: number;
}
/** نافذة الحساب [from, to) وفترة العرض */
export interface TargetWindow { from: Date; to: Date; period: TargetPeriod }

/** نافذة فترةٍ من يومٍ إلى يوم (شاملاً) بتوقيت الشركة — صرفةٌ (المنطقة والساعة مُدخلان) */
export function periodWindow(fromDate: string, toDate: string, tz: string, now: Date, custom = true): TargetWindow {
  const today = todayLocal(now, tz);
  const total = diffDays(fromDate, toDate) + 1;
  const state: PeriodState = today < fromDate ? 'UPCOMING' : today > toDate ? 'ENDED' : 'ACTIVE';
  const daysLeft = state === 'ACTIVE' ? diffDays(today, toDate) + 1 : state === 'UPCOMING' ? total : 0;
  return {
    from: zonedStartOfDay(fromDate, tz),
    to: zonedStartOfDay(addDays(toDate, 1), tz),
    period: { from: fromDate, to: toDate, custom, state, daysLeft },
  };
}

/** الشهر كله نافذةً (فترة غير مخصّصة) */
export function monthPeriod(month: string, tz: string, now: Date): TargetWindow {
  const first = `${month}-01`;
  return periodWindow(first, addDays(addMonths(first, 1), -1), tz, now, false);
}

/** فترةٌ مخصّصة صالحة: يومان حقيقيان، البداية قبل النهاية أو هي، وحتى PERIOD_MAX_DAYS — وإلا null (مُدخلٌ من الجسم) */
export function validPeriod(from: unknown, to: unknown): { from: string; to: string } | null {
  if (!isLocalDate(from) || !isLocalDate(to) || from > to) return null;
  const y = Number(from.slice(0, 4));
  if (y < 2000 || Number(to.slice(0, 4)) > 2100) return null;
  return diffDays(from, to) + 1 <= PERIOD_MAX_DAYS ? { from, to } : null;
}

/** النافذة نفسها: الشهر كله في الشهر نفسه، أو الفترة المخصّصة نفسها — شرط أعضاء الهدف المدمج */
export const sameWindow = (a: { month: string; periodFrom?: string | null; periodTo?: string | null },
  b: { month: string; periodFrom?: string | null; periodTo?: string | null }): boolean =>
  a.month === b.month && (a.periodFrom ?? null) === (b.periodFrom ?? null) && (a.periodTo ?? null) === (b.periodTo ?? null);

/** سقف صفوف الزيارات المقروءة لنافذة: ٢٠٠٠٠ لكل ٣١ يوماً (الشهر كما كان) — فلا تُقصّ فترةٌ طويلة عند حدّ الشهر */
export const visitRowsCap = (from: Date, to: Date): number =>
  Math.min(240_000, 20_000 * Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86_400_000 / 31)));

/** فترة الهدف المخصّصة المحفوظة، أو null (الشهر كله) */
export const customPeriodOf = (t: { periodFrom?: string | null; periodTo?: string | null }): { from: string; to: string } | null =>
  (t.periodFrom && t.periodTo ? validPeriod(t.periodFrom, t.periodTo) : null);

// ═══ الطيّات الصرفة ═══

/** بند فاتورةٍ كما يُقرأ لهدف الكمية: الكمية ولقطة وحدتها ونوع فاتورته */
export type TargetItemRow = { productId: string | null; qty: number; baseQty?: number | null; invoice: { type?: string | null } } & UnitSnapshot;

/**
 * صافي كمية كل صنفٍ **بالأساس**: البيع موجبٌ والمرتجع (والإشعار الدائن) سالب — كمعيار «الصنف» في تقييم الأداء
 * (routes/reports.ts productQtyByRep). والمستدعي يمرّر بنود فواتير المندوب المؤكَّدة في الشهر وحدها
 */
export function productNetBaseQty(rows: readonly TargetItemRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!r.productId) continue;
    out.set(r.productId, (out.get(r.productId) ?? 0) + (isReturnInvoice(r.invoice) ? -1 : 1) * baseQtyOf(r));
  }
  for (const [k, v] of out) out.set(k, roundQty(v));
  return out;
}

/** فاتورةٌ آجلة مرشَّحة لتحصيل الشهر: إجماليها، وتخصيصات سندات القبض عليها، وإشعاراتها الدائنة */
export interface CollectionInvoiceRow {
  total: number;
  receiptItems: ReadonlyArray<{ amount: number; receipt: { receiptDate: Date; status?: string | null } }>;
  /** الإشعارات الدائنة المؤكَّدة عليها قبل بداية الشهر، ومرتجعات المرحلة الأولى المرتبطة بها (withLinkedReturns) — المستدعي
   *  يرشّحها؛ وغير المؤكَّد/غير المرتجع يُهمل هنا أيضاً */
  adjustments: ReadonlyArray<{ id?: string; total: number; status?: string | null; type?: string | null }>;
}

/**
 * تحصيل الشهر من ديون المندوب السابقة. S بداية الشهر وE بداية التالي:
 *   الافتتاحي لكل فاتورة = max(0, الإجمالي − تخصيصات السندات القائمة قبل S − إشعاراتها الدائنة قبل S)،
 *   والأساس = Σ الافتتاحي (الدين المفتوح أول الشهر)،
 *   والمحصَّل = Σ min(الافتتاحي، تخصيصات السندات القائمة في [S, E)) — أيّاً كان المحصِّل (المندوب أو المكتب أو رابط الدفع):
 *   دين مبيعاته حُصِّل. وسطر تخصيصٍ لسندٍ ملغى يبقى في القاعدة فيُهمل هنا (status ≠ ACTIVE)، وما بعد E لا يُعدّ.
 */
export function collectionFold(rows: readonly CollectionInvoiceRow[], S: Date, E: Date): { base: number; collected: number } {
  const s = S.getTime();
  const e = E.getTime();
  let base = 0;
  let collected = 0;
  for (const inv of rows) {
    let before = 0;
    let during = 0;
    for (const it of inv.receiptItems) {
      if (it.receipt.status != null && it.receipt.status !== 'ACTIVE') continue;
      const t = new Date(it.receipt.receiptDate).getTime();
      const amt = Number(it.amount) || 0;
      if (t < s) before += amt;
      else if (t < e) during += amt;
    }
    let credits = 0;
    for (const a of inv.adjustments) {
      if (a.status != null && a.status !== 'CONFIRMED') continue;
      if (a.type != null && a.type !== 'RETURN') continue;
      credits += Number(a.total) || 0;
    }
    const opening = Math.max(0, (Number(inv.total) || 0) - before - credits);
    if (opening <= BASE_EPS) continue;
    base += opening;
    collected += Math.min(opening, Math.max(0, during));
  }
  return { base: cleanMoney(base), collected: cleanMoney(collected) };
}

/** بند مرتجعٍ مرتبط بفاتورة بيع في المرحلة الأولى (returnOfItemId = بند البيع) بفاتورته المؤكَّدة قبل الشهر */
export interface LinkedReturnLine {
  returnOfItemId: string | null;
  invoice: { id: string; total: number; status?: string | null; type?: string | null };
}

/**
 * مرتجع المرحلة الأولى المرتبط لا يُنقص باقي فاتورة البيع ولا يكتب originalInvoiceId، فلم يكن يُطرح من افتتاحيّها بينما إشعار
 * المرحلة الثانية الدائن (adjustments) يُطرح — فتضخّم الأساس لكل شركةٍ خارج المرحلة الثانية. يُضاف هنا إلى إشعاراتها فتتّفق
 * المرحلتان: إجمالي كل مرتجعٍ مرةً واحدة على فاتورة بيعه (المرتجع المرتبط من فاتورةٍ واحدة؛ وبنودٌ على أكثر من فاتورة تُنسب
 * للأولى فلا يُطرح مرتين)، ومستندٌ قُرئ إشعاراً لا يتكرّر. أما ائتمان العميل بلا فاتورة (مرتجعٌ حرّ، إشعارٌ بلا أصل، سندٌ يفيض
 * عن الفواتير) فلا فاتورة يُنسب إليها فيبقى خارج الأساس. صرفةٌ.
 */
export function withLinkedReturns<T extends CollectionInvoiceRow & { items?: ReadonlyArray<{ id: string }> | null }>(
  rows: readonly T[], lines: readonly LinkedReturnLine[],
): T[] {
  const rowOfItem = new Map<string, number>();
  rows.forEach((r, i) => { for (const it of r.items ?? []) rowOfItem.set(it.id, i); });
  const added = new Map<number, CollectionInvoiceRow['adjustments'][number][]>();
  const taken = new Set<string>();
  for (const l of lines) {
    const i = l.returnOfItemId != null ? rowOfItem.get(l.returnOfItemId) : undefined;
    if (i === undefined || taken.has(l.invoice.id)) continue;
    taken.add(l.invoice.id);
    const own = rows[i].adjustments;
    if (own.some((a) => a.id === l.invoice.id)) continue;
    added.set(i, [...(added.get(i) ?? []), { id: l.invoice.id, total: l.invoice.total, status: l.invoice.status, type: l.invoice.type }]);
  }
  return rows.map((r, i) => (added.has(i) ? { ...r, adjustments: [...r.adjustments, ...added.get(i)!] } : r));
}

// ═══ التقدّم والمكافأة ═══

export type ProgressState = 'OK' | 'NO_BASE' | 'PRODUCT_DELETED';
export interface TargetProgress {
  state: ProgressState;
  achieved: number;
  goal: number;
  pct: number | null;
  done: boolean;
  /** COLLECTION_PCT وحده: الدين المفتوح أول الشهر، ونسبة ما حُصّل منه */
  base?: number;
  collectedPct?: number | null;
}
export interface TargetReward { kind: string; value: number; amount: number | null; earned: boolean }

/** ما يحتاجه حساب التقدّم من الشهر: صافي المبيعات، وصافي كمية كل صنف بالأساس، وتحصيل الديون السابقة، والزيارات والعملاء الجدد */
export interface ProgressContext {
  monthNetSales: number;
  productBase: ReadonlyMap<string, number>;
  collection: { base: number; collected: number };
  /** وقفات الزيارة بعد الدمج (تعريف «أداء المندوب» نفسه — services/workDay.ts mergeVisitsByRep) */
  visits?: number;
  /** عملاء أضافهم المندوب في الشهر ولهم فاتورة بيع مؤكَّدة حتى نهايته */
  newCustomers?: number;
  /** خانات عملة الشركة — يُقرَّب بها هدف التحصيل لأعلى (الغائب = ٢) */
  currencyDecimals?: number;
}

const isDone = (achieved: number, goal: number): boolean => goal > 0 && achieved >= goal - DONE_EPS;
/** أعلى نسبةٍ تُعرض لهدفٍ لم يتحقق: round1 كان يرفع ٩٩٫٩٥٪ فما فوق إلى ١٠٠٪ بلا شارة التحقق */
const PCT_NOT_DONE_MAX = 99.9;
/** النسبة بلا سقف (الواجهة تقصّ الشريط عند ١٠٠) إلا أنها دون ١٠٠ ما لم يتحقق الهدف — وبلا هدفٍ موجب لا نسبة */
export const pctOf = (achieved: number, goal: number): number | null => {
  if (!(goal > 0)) return null;
  const p = round1((achieved / goal) * 100);
  return p >= 100 && !isDone(achieved, goal) ? PCT_NOT_DONE_MAX : p;
};

/** صنفٌ إضافي في هدف الكمية (RepTargetProduct) كما يحتاجه الحساب */
export type TargetExtraProduct = { productId: string | null; unitFactor: number };
export type TargetLike = Pick<RepTarget, 'kind' | 'targetValue' | 'productId' | 'unitFactor' | 'rewardKind' | 'rewardValue'> & {
  extraProducts?: readonly TargetExtraProduct[] | null;
};

export function targetProgress(t: TargetLike, ctx: ProgressContext): TargetProgress {
  const goalValue = Number(t.targetValue) || 0;
  if (t.kind === 'PRODUCT_QTY') {
    // هدفٌ بعدة أصناف (الأول + الإضافية): المُنجَز = Σ صافي أساس كل صنفٍ ÷ معامل وحدته. والمحذوف (productId فارغ) لا يُعدّ،
    // وكلّها محذوفة ⇒ PRODUCT_DELETED
    const parts = [{ productId: t.productId, unitFactor: t.unitFactor }, ...(t.extraProducts ?? [])].filter((p) => !!p.productId);
    if (!parts.length) return { state: 'PRODUCT_DELETED', achieved: 0, goal: goalValue, pct: null, done: false };
    // الهدف بالأساس = القيمة × المعامل، فالمحقَّق بوحدة الهدف = صافي الأساس ÷ المعامل
    const achieved = round4(parts.reduce((s, p) => s + (ctx.productBase.get(p.productId as string) ?? 0) / factorOf({ unitFactor: p.unitFactor }), 0));
    return { state: 'OK', achieved, goal: goalValue, pct: pctOf(achieved, goalValue), done: isDone(achieved, goalValue) };
  }
  if (t.kind === 'VISITS_COUNT' || t.kind === 'NEW_CUSTOMERS') {
    const achieved = (t.kind === 'VISITS_COUNT' ? ctx.visits : ctx.newCustomers) ?? 0;
    return { state: 'OK', achieved, goal: goalValue, pct: pctOf(achieved, goalValue), done: isDone(achieved, goalValue) };
  }
  if (t.kind === 'COLLECTION_PCT') {
    const { base, collected } = ctx.collection;
    // لأعلى بخانات العملة: ٥٠٪ من ٣٣٣٫٣٣ = ١٦٦٫٦٧ لا ١٦٦٫٦٦٥ — المعروض هو ما يحقّق الهدف، والتحقق بالنسبة الصارمة كما هو.
    // ولا يتجاوز الأساس: المحصَّل لا يفوقه أبداً (Σ min(الافتتاحي، المحصَّل))، فأساسٌ بكسرٍ أدق من خانات العملة (سند ١٠٠٠٫٥
    // بالدينار العراقي، أو ثلاث خانات بالريال عبر API) كان يُرفع فوقه فيستحيل «تحصيل ١٠٠٪» ومكافأته
    const goal = Math.min(ceilToDecimals(cleanMoney(base * goalValue / 100), ctx.currencyDecimals ?? 2), cleanMoney(base));
    if (base <= BASE_EPS) return { state: 'NO_BASE', achieved: collected, goal, pct: null, done: false, base, collectedPct: null };
    return {
      state: 'OK', achieved: collected, goal, pct: pctOf(collected, goal), done: isDone(collected, goal),
      base, collectedPct: pctOf(collected, base),
    };
  }
  // SALES_AMOUNT (وأيّ نوعٍ مجهول يُقرأ مبيعاتٍ فلا يُسقط الشاشة)
  const achieved = ctx.monthNetSales;
  return { state: 'OK', achieved, goal: goalValue, pct: pctOf(achieved, goalValue), done: isDone(achieved, goalValue) };
}

/** المكافأة: العمولة من صافي مبيعات الشهر (لا سالب)، والمبلغ المحدد كما هو، ونسبة الراتب بلا مبلغ (الراتب لا يُخزَّن) */
export function targetReward(t: TargetLike, monthNetSales: number, done: boolean): TargetReward {
  const value = Number(t.rewardValue) || 0;
  const amount = t.rewardKind === 'COMMISSION_SALES_PCT' ? cleanMoney(Math.max(0, monthNetSales) * value / 100)
    : t.rewardKind === 'FIXED_AMOUNT' ? value
      : null;
  return { kind: t.rewardKind, value, amount, earned: done };
}

/** صنفٌ في هدف الكمية كما يُعرض: الأول ثم الإضافية بترتيبها */
export interface TargetProductView { productId: string | null; productName: string | null; unitId: string | null; unitName: string | null; unitFactor: number }
export type RepTargetRow = RepTarget & { extraProducts?: ReadonlyArray<TargetProductView & { sortOrder?: number }> | null };

export interface RepTargetView {
  id: string; month: string; kind: string; targetValue: number;
  /** مدة الهدف: الشهر كله (custom=false) أو فترته المخصّصة — بحالها اليوم. والأرقام كلها محسوبةٌ داخلها */
  period?: TargetPeriod;
  productId: string | null; productName: string | null; unitId: string | null; unitName: string | null; unitFactor: number;
  /** هدف الكمية: كل أصنافه (الأول أولاً) — وغيره فارغ */
  products: TargetProductView[];
  /** «دمج الأهداف»: معرّف الهدف المدمج (null = مستقل) — ومكافأة العضو تُستحق بتحقق الأعضاء كلهم */
  comboId: string | null;
  rewardKind: string; rewardValue: number; note: string | null; createdByName: string | null; createdAt: Date; updatedAt: Date;
  progress: TargetProgress;
  reward: TargetReward;
}

export function toTargetView(t: RepTargetRow, ctx: ProgressContext, period?: TargetPeriod): RepTargetView {
  const progress = targetProgress(t, ctx);
  const extras = t.kind === 'PRODUCT_QTY' ? [...(t.extraProducts ?? [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)) : [];
  return {
    id: t.id, month: t.month, kind: t.kind, targetValue: t.targetValue,
    productId: t.productId, productName: t.productName, unitId: t.unitId, unitName: t.unitName, unitFactor: t.unitFactor,
    products: t.kind === 'PRODUCT_QTY'
      ? [{ productId: t.productId, productName: t.productName, unitId: t.unitId, unitName: t.unitName, unitFactor: t.unitFactor },
        ...extras.map((e) => ({ productId: e.productId, productName: e.productName, unitId: e.unitId, unitName: e.unitName, unitFactor: e.unitFactor }))]
      : [],
    rewardKind: t.rewardKind, rewardValue: t.rewardValue, note: t.note, createdByName: t.createdByName, createdAt: t.createdAt, updatedAt: t.updatedAt,
    comboId: t.comboId ?? null,
    ...(period && { period }),
    progress,
    reward: targetReward(t, ctx.monthNetSales, progress.done),
  };
}

/**
 * «دمج الأهداف»: مكافأة الهدف المدمج واحدة تُستحق بتحقق أعضائه كلهم — فيُكتب `earned` لكل عضوٍ بحال المجموعة. والعضو الوحيد
 * (حُذف الباقون) كالمستقل. صرفةٌ على عروضٍ محسوبة.
 */
export function applyCombos(views: RepTargetView[]): RepTargetView[] {
  const byCombo = new Map<string, RepTargetView[]>();
  for (const v of views) if (v.comboId) byCombo.set(v.comboId, [...(byCombo.get(v.comboId) ?? []), v]);
  return views.map((v) => {
    const group = v.comboId ? byCombo.get(v.comboId) ?? [v] : [v];
    if (group.length < 2) return v;
    const allDone = group.every((m) => m.progress.done);
    return { ...v, reward: { ...v.reward, earned: allDone } };
  });
}

// ═══ المحمّل (قاعدة البيانات) ═══

/**
 * نطاق المستند لقراءة الإدارة: قيود Prisma يبنيها المسار من نطاق المستخدم، فيرى المقيَّد بالقوائم ومشرف الفرق أرقام المندوب فيما
 * يقع في نطاقه وحده — كـGET /sales-reps/:id/stats وتقرير أداء المناديب (وإلا كشف «صافي مبيعات الشهر» عمل الفريق الآخر).
 * الغائب أو {} = بلا قيد (المدير غير المقيَّد، و/mine: المندوب يرى عمله كله).
 *   • doc — scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT): البيع والمرتجع، وبنود الكمية، والآجلة (أساس التحصيل)، وبيع العميل الجديد.
 *   • visit — scopedRecordWhere(req, SHAPE_VISIT): زيارات الشهر.
 *   • customer — adminCustomerFilter(req): العملاء الجدد (مشرف الفرق {}: العملاء مشتركون بين الفرق).
 * كلٌّ يُنثر في شرطه كما يردّه مساعده (مفتاح AND واحد أو adminScopes) — فلا يحمل OR في مستواه الأعلى، والمحمّل ينثر OR بعده.
 * وتخصيصات السندات والإشعارات والمرتجعات على آجلةٍ في النطاق تُقرأ بلا قيد عمداً: الدين دين الفاتورة وباقيها ظاهرٌ لمن يراها،
 * وقصّها بنطاق السند يُبقي سداداً تمّ قبل الشهر ديناً فيضخّم الأساس.
 */
export interface RepTargetDocScope {
  doc?: Record<string, unknown>;
  visit?: Record<string, unknown>;
  customer?: Record<string, unknown>;
}

/**
 * سياق التقدّم لمندوبٍ في شهر — ما تحتاجه أهدافه وحدها: صافي المبيعات دائماً (هدف المبيعات والعمولة وسطر الملخّص)، وبنود
 * أصناف أهداف الكمية في استعلامٍ واحد، والديون السابقة مرةً واحدة لكل أهداف التحصيل. `scope` لمسارات الإدارة (RepTargetDocScope).
 */
export async function loadProgressContext(tid: string, repId: string, win: Pick<MonthWindow, 'from' | 'to'>,
  targets: readonly (Pick<RepTarget, 'kind' | 'productId'> & { extraProducts?: ReadonlyArray<{ productId: string | null }> | null })[],
  scope?: RepTargetDocScope | null): Promise<ProgressContext> {
  const { from, to } = win;
  const docScope = scope?.doc ?? {};
  const docs = { tenantId: tid, salesRepId: repId, status: 'CONFIRMED', ...docScope };
  const productIds = [...new Set(targets.filter((t) => t.kind === 'PRODUCT_QTY')
    .flatMap((t) => [t.productId, ...(t.extraProducts ?? []).map((e) => e.productId)])
    .filter((x): x is string => !!x))];
  const needsCollection = targets.some((t) => t.kind === 'COLLECTION_PCT');
  const needsVisits = targets.some((t) => t.kind === 'VISITS_COUNT');
  const needsCustomers = targets.some((t) => t.kind === 'NEW_CUSTOMERS');
  const [sales, returns, items, credit, visitRows, newCustomers, company] = await Promise.all([
    prisma.invoice.aggregate({ where: { ...docs, type: { not: 'RETURN' }, invoiceDate: { gte: from, lt: to } }, _sum: { total: true } }),
    prisma.invoice.aggregate({ where: { ...docs, type: 'RETURN', invoiceDate: { gte: from, lt: to } }, _sum: { total: true } }),
    productIds.length
      ? prisma.invoiceItem.findMany({
        where: { productId: { in: productIds }, invoice: { ...docs, invoiceDate: { gte: from, lt: to } } },
        select: { productId: true, qty: true, unitFactor: true, baseQty: true, invoice: { select: { type: true } } },
      })
      : Promise.resolve([]),
    needsCollection
      ? prisma.invoice.findMany({
        where: {
          ...docs, type: 'CREDIT', invoiceDate: { lt: from },
          // فاتورةٌ سُدّدت كلها قبل الشهر لا تدخل: الباقي اليوم صفر ولا سند ولا إشعار عليها من أول الشهر
          OR: [
            { remainingAmt: { gt: BASE_EPS } },
            { receiptItems: { some: { receipt: { receiptDate: { gte: from } } } } },
            { adjustments: { some: { invoiceDate: { gte: from } } } },
          ],
        },
        select: {
          id: true,
          total: true,
          receiptItems: {
            where: { receipt: { status: 'ACTIVE', receiptDate: { lt: to } } },
            select: { amount: true, receipt: { select: { receiptDate: true, status: true } } },
          },
          adjustments: {
            where: { status: 'CONFIRMED', type: 'RETURN', invoiceDate: { lt: from } },
            select: { id: true, total: true, status: true, type: true },
          },
          // بنودها: يُربط بها مرتجع المرحلة الأولى (returnOfItemId) — withLinkedReturns
          items: { select: { id: true } },
        },
      })
      : Promise.resolve([]),
    // زيارات الشهر: كل سجلّات المندوب ثم الدمج إلى وقفات (الزيارة المؤقّتة وملاحظتها وقفةٌ واحدة) — كتقرير أداء المندوب
    needsVisits
      ? prisma.repVisit.findMany({
        where: { tenantId: tid, salesRepId: repId, createdAt: { gte: from, lt: to }, ...(scope?.visit ?? {}) },
        select: { salesRepId: true, customerId: true, createdAt: true, startedAt: true, durationSec: true, lat: true, lng: true, customer: { select: { name: true } } },
        orderBy: { createdAt: 'asc' }, take: visitRowsCap(from, to),
      })
      : Promise.resolve([]),
    // عملاء جدد نشطون: أضافهم المندوب في الشهر، ولكلٍّ فاتورة بيعٍ مؤكَّدة حتى نهاية الشهر (لا يُعدّ عميلٌ أُضيف ولم يشترِ).
    // والعدّ بـcreatedAt وحده: إعادة المندوب دون اتصال (X-FS-Replay) تكتبه عند الإنشاء بلحظة جهازه المحصورة المصحَّحة الانحراف
    // (routes/customers.ts)، فعميل ٢٢:٠٠ آخر الشهر المرفوع صباحاً في شهره — ولا تأريخ بلحظة الجهاز هنا: clientCreatedAt يُرسل مع
    // كل إنشاء ولو متصلاً وبلا تصحيح ساعة، فكان يُسقط عميلاً من الشهرين
    needsCustomers
      ? prisma.customer.count({
        where: {
          tenantId: tid, createdBySalesRepId: repId, createdAt: { gte: from, lt: to }, status: { not: 'DELETED' }, ...(scope?.customer ?? {}),
          invoices: { some: { status: 'CONFIRMED', type: { not: 'RETURN' }, invoiceDate: { lt: to }, ...docScope } },
        },
      })
      : Promise.resolve(0),
    // خانات العملة لهدف التحصيل (كحساب الفاتورة: عملة الشركة وإلا عملة دولتها)
    needsCollection
      ? prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { currency: true, countryCode: true } })
      : Promise.resolve(null),
  ]);
  // مرتجعات المرحلة الأولى المرتبطة ببنود الآجلة المرشَّحة — بعد قراءتها، ولا استعلام بلا بنود
  const saleItemIds = needsCollection ? [...new Set(credit.flatMap((r) => (r.items ?? []).map((i) => i.id)))] : [];
  const linkedReturns: LinkedReturnLine[] = saleItemIds.length
    ? await prisma.invoiceItem.findMany({
      where: { returnOfItemId: { in: saleItemIds }, invoice: { tenantId: tid, status: 'CONFIRMED', type: 'RETURN', invoiceDate: { lt: from } } },
      select: { returnOfItemId: true, invoice: { select: { id: true, total: true, status: true, type: true } } },
    })
    : [];
  return {
    monthNetSales: netSales(sales._sum.total, returns._sum.total),
    productBase: productNetBaseQty(items),
    collection: needsCollection ? collectionFold(withLinkedReturns(credit, linkedReturns), from, to) : { base: 0, collected: 0 },
    ...(needsVisits && { visits: mergeVisitsByRep(visitRows.map(asVisitLike)).length }),
    ...(needsCustomers && { newCustomers }),
    ...(needsCollection && { currencyDecimals: currencyDecimalsOf(company?.currency ?? getCountryTax(company?.countryCode).currency) }),
  };
}

export interface RepTargetsMonth {
  month: string;
  from: string;
  to: string;
  isCurrent: boolean;
  daysLeft: number;
  monthNetSales: number;
  targets: RepTargetView[];
}

/**
 * أهداف المندوب في شهرٍ بتقدّمها ومكافآتها (الشهر الغائب = الجاري بتوقيت الشركة)، بترتيب إنشائها — و`scope` لمسارات الإدارة.
 * «مدة الهدف»: أهداف الشهر (شهرها هذا: الشهر كله أو فترةٌ تبدأ فيه)، ومعها فتراتٌ مخصّصة بدأت قبله وتمتد إليه — وكل هدفٍ يُحسب
 * في نافذته: سياقٌ لكل فترةٍ مختلفة (بالتسلسل، فلا تتضاعف استعلامات القاعدة المتوازية)، وسياق الشهر دائماً (صافي مبيعاته للملخّص)
 */
export async function repTargetsMonth(tid: string, repId: string, month?: string | null, now: Date = new Date(),
  scope?: RepTargetDocScope | null): Promise<RepTargetsMonth> {
  const tz = await tenantTz(tid);
  const win = monthWindow(month || currentMonthOf(now, tz), tz, now);
  const orderBy = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
  const include = { extraProducts: { orderBy: { sortOrder: 'asc' as const } } };
  const [own, spanning] = await Promise.all([
    prisma.repTarget.findMany({ where: { tenantId: tid, salesRepId: repId, month: win.month }, orderBy, include }),
    // فتراتٌ مخصّصة بدأت في شهرٍ سابق وما زالت تمسّ هذا الشهر (شهر الهدف = شهر أول يومٍ في فترته) — أحدثها حتى سقف الشهر،
    // فلا يزدحم شهرٌ بفترات أشهرٍ كثيرة سابقة (ولا تتكاثر سياقات الحساب)
    prisma.repTarget.findMany({
      where: { tenantId: tid, salesRepId: repId, month: { lt: win.month }, periodTo: { gte: `${win.month}-01` } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: MAX_TARGETS_PER_MONTH, include,
    }),
  ]);
  const targets = [...own, ...spanning.filter((t) => customPeriodOf(t))]
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // نافذة كل هدف: فترته المخصّصة أو الشهر — والأهداف بالنافذة نفسها تتشارك سياقاً واحداً
  const monthWin = monthPeriod(win.month, tz, now);
  const keyOf = (t: RepTargetRow): string => { const p = customPeriodOf(t); return p ? `${p.from}~${p.to}` : ''; };
  const windows = new Map<string, { win: TargetWindow; rows: RepTargetRow[] }>([['', { win: monthWin, rows: [] }]]);
  for (const t of targets) {
    const k = keyOf(t);
    if (!windows.has(k)) { const p = customPeriodOf(t)!; windows.set(k, { win: periodWindow(p.from, p.to, tz, now), rows: [] }); }
    windows.get(k)!.rows.push(t);
  }
  const ctxs = new Map<string, ProgressContext>();
  for (const [k, w] of windows) ctxs.set(k, await loadProgressContext(tid, repId, w.win, w.rows, scope));
  return {
    month: win.month, from: win.from.toISOString(), to: win.to.toISOString(), isCurrent: win.isCurrent, daysLeft: win.daysLeft,
    monthNetSales: ctxs.get('')!.monthNetSales,
    targets: applyCombos(targets.map((t) => { const k = keyOf(t); return toTargetView(t, ctxs.get(k)!, windows.get(k)!.win.period); })),
  };
}

/** هدفٌ واحد محسوبٌ لشهره (ردّ الإنشاء والتعديل) — و`scope` نطاق المستخدم كما في GET */
export async function repTargetViewOf(tid: string, target: RepTargetRow, now: Date = new Date(),
  scope?: RepTargetDocScope | null): Promise<RepTargetView> {
  // عضوٌ في هدفٍ مدمج: مكافأته تُستحق بتحقق الأعضاء كلهم (applyCombos) — فيُقرأ من شهره كما يقرؤه GET
  if (target.comboId) {
    const month = await repTargetsMonth(tid, target.salesRepId, target.month, now, scope);
    const hit = month.targets.find((v) => v.id === target.id);
    if (hit) return hit;
  }
  const tz = await tenantTz(tid);
  const p = customPeriodOf(target);
  const win = p ? periodWindow(p.from, p.to, tz, now) : monthPeriod(target.month, tz, now);
  const ctx = await loadProgressContext(tid, target.salesRepId, win, [target], scope);
  return toTargetView(target, ctx, win.period);
}
