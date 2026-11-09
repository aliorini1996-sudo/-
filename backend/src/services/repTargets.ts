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
// ============================================================================
import type { RepTarget } from '@prisma/client';
import prisma from '../config/database';
import { tenantTz } from './invoiceExpiry';
import { addMonths, daysInMonth, todayLocal, zonedStartOfDay } from './gl/dates';
import { cleanMoney, isReturnInvoice, netSales } from './netSales';
import { baseQtyOf, factorOf, roundQty, type UnitSnapshot } from './units';

export const TARGET_KINDS = ['SALES_AMOUNT', 'PRODUCT_QTY', 'COLLECTION_PCT'] as const;
export type TargetKind = typeof TARGET_KINDS[number];
export const REWARD_KINDS = ['COMMISSION_SALES_PCT', 'SALARY_PCT', 'FIXED_AMOUNT'] as const;
export type RewardKind = typeof REWARD_KINDS[number];

/** حدّ قيمة الهدف لكل نوع (أكبر من صفر دائماً): مبلغ، كمية بوحدة الهدف، نسبة */
export const TARGET_VALUE_MAX: Readonly<Record<TargetKind, number>> = { SALES_AMOUNT: 1e12, PRODUCT_QTY: 1e9, COLLECTION_PCT: 100 };
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
});
export type TargetCode = keyof typeof TARGET_MESSAGES;

/** ديونٌ مفتوحة دون هذا = لا ديون (غبار الهللات) */
export const BASE_EPS = 0.004;
const DONE_EPS = 1e-6;

/** تقريبٌ لمنزلة واحدة، و‎-0 صفر */
export const round1 = (n: number): number => (Math.round(n * 10) / 10) || 0;
const round4 = (n: number): number => (Math.round(n * 1e4) / 1e4) || 0;

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
  /** الإشعارات الدائنة المؤكَّدة عليها قبل بداية الشهر (المستدعي يرشّحها؛ وغير المؤكَّد/غير المرتجع يُهمل هنا أيضاً) */
  adjustments: ReadonlyArray<{ total: number; status?: string | null; type?: string | null }>;
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

/** ما يحتاجه حساب التقدّم من الشهر: صافي المبيعات، وصافي كمية كل صنف بالأساس، وتحصيل الديون السابقة */
export interface ProgressContext {
  monthNetSales: number;
  productBase: ReadonlyMap<string, number>;
  collection: { base: number; collected: number };
}

/** النسبة بلا سقف (الواجهة تقصّ الشريط عند ١٠٠) — وبلا هدفٍ موجب لا نسبة */
export const pctOf = (achieved: number, goal: number): number | null => (goal > 0 ? round1((achieved / goal) * 100) : null);
const isDone = (achieved: number, goal: number): boolean => goal > 0 && achieved >= goal - DONE_EPS;

export type TargetLike = Pick<RepTarget, 'kind' | 'targetValue' | 'productId' | 'unitFactor' | 'rewardKind' | 'rewardValue'>;

export function targetProgress(t: TargetLike, ctx: ProgressContext): TargetProgress {
  const goalValue = Number(t.targetValue) || 0;
  if (t.kind === 'PRODUCT_QTY') {
    if (!t.productId) return { state: 'PRODUCT_DELETED', achieved: 0, goal: goalValue, pct: null, done: false };
    // الهدف بالأساس = القيمة × المعامل، فالمحقَّق بوحدة الهدف = صافي الأساس ÷ المعامل
    const achieved = round4((ctx.productBase.get(t.productId) ?? 0) / factorOf({ unitFactor: t.unitFactor }));
    return { state: 'OK', achieved, goal: goalValue, pct: pctOf(achieved, goalValue), done: isDone(achieved, goalValue) };
  }
  if (t.kind === 'COLLECTION_PCT') {
    const { base, collected } = ctx.collection;
    const goal = cleanMoney(base * goalValue / 100);
    if (base <= BASE_EPS) return { state: 'NO_BASE', achieved: collected, goal, pct: null, done: false, base, collectedPct: null };
    return {
      state: 'OK', achieved: collected, goal, pct: pctOf(collected, goal), done: isDone(collected, goal),
      base, collectedPct: round1((collected / base) * 100),
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

export interface RepTargetView {
  id: string; month: string; kind: string; targetValue: number;
  productId: string | null; productName: string | null; unitId: string | null; unitName: string | null; unitFactor: number;
  rewardKind: string; rewardValue: number; note: string | null; createdByName: string | null; createdAt: Date; updatedAt: Date;
  progress: TargetProgress;
  reward: TargetReward;
}

export function toTargetView(t: RepTarget, ctx: ProgressContext): RepTargetView {
  const progress = targetProgress(t, ctx);
  return {
    id: t.id, month: t.month, kind: t.kind, targetValue: t.targetValue,
    productId: t.productId, productName: t.productName, unitId: t.unitId, unitName: t.unitName, unitFactor: t.unitFactor,
    rewardKind: t.rewardKind, rewardValue: t.rewardValue, note: t.note, createdByName: t.createdByName, createdAt: t.createdAt, updatedAt: t.updatedAt,
    progress,
    reward: targetReward(t, ctx.monthNetSales, progress.done),
  };
}

// ═══ المحمّل (قاعدة البيانات) ═══

/**
 * سياق التقدّم لمندوبٍ في شهر — ما تحتاجه أهدافه وحدها: صافي المبيعات دائماً (هدف المبيعات والعمولة وسطر الملخّص)، وبنود
 * أصناف أهداف الكمية في استعلامٍ واحد، والديون السابقة مرةً واحدة لكل أهداف التحصيل.
 */
export async function loadProgressContext(tid: string, repId: string, win: Pick<MonthWindow, 'from' | 'to'>, targets: readonly Pick<RepTarget, 'kind' | 'productId'>[]): Promise<ProgressContext> {
  const { from, to } = win;
  const docs = { tenantId: tid, salesRepId: repId, status: 'CONFIRMED' };
  const productIds = [...new Set(targets.filter((t) => t.kind === 'PRODUCT_QTY' && t.productId).map((t) => t.productId as string))];
  const needsCollection = targets.some((t) => t.kind === 'COLLECTION_PCT');
  const [sales, returns, items, credit] = await Promise.all([
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
          total: true,
          receiptItems: {
            where: { receipt: { status: 'ACTIVE', receiptDate: { lt: to } } },
            select: { amount: true, receipt: { select: { receiptDate: true, status: true } } },
          },
          adjustments: {
            where: { status: 'CONFIRMED', type: 'RETURN', invoiceDate: { lt: from } },
            select: { total: true, status: true, type: true },
          },
        },
      })
      : Promise.resolve([]),
  ]);
  return {
    monthNetSales: netSales(sales._sum.total, returns._sum.total),
    productBase: productNetBaseQty(items),
    collection: needsCollection ? collectionFold(credit, from, to) : { base: 0, collected: 0 },
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

/** أهداف المندوب في شهرٍ بتقدّمها ومكافآتها (الشهر الغائب = الجاري بتوقيت الشركة)، بترتيب إنشائها */
export async function repTargetsMonth(tid: string, repId: string, month?: string | null, now: Date = new Date()): Promise<RepTargetsMonth> {
  const tz = await tenantTz(tid);
  const win = monthWindow(month || currentMonthOf(now, tz), tz, now);
  const targets = await prisma.repTarget.findMany({
    where: { tenantId: tid, salesRepId: repId, month: win.month },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const ctx = await loadProgressContext(tid, repId, win, targets);
  return {
    month: win.month, from: win.from.toISOString(), to: win.to.toISOString(), isCurrent: win.isCurrent, daysLeft: win.daysLeft,
    monthNetSales: ctx.monthNetSales,
    targets: targets.map((t) => toTargetView(t, ctx)),
  };
}

/** هدفٌ واحد محسوبٌ لشهره (ردّ الإنشاء والتعديل) */
export async function repTargetViewOf(tid: string, target: RepTarget, now: Date = new Date()): Promise<RepTargetView> {
  const tz = await tenantTz(tid);
  const win = monthWindow(target.month, tz, now);
  const ctx = await loadProgressContext(tid, target.salesRepId, win, [target]);
  return toTargetView(target, ctx);
}
