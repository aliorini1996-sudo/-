/**
 * «تقرير الربح» — مجمل الربح قبل المصروفات (طلب المالك: تبويبات تقارير المشتريات والربح والضرائب).
 *
 * مجمل الربح = المبيعات الصافية − تكلفة البضاعة المباعة، لكل صنف أو مندوب أو عميل أو شهر:
 *
 * - **المبيعات الصافية**: فواتير البيع المؤكَّدة ناقص المرتجع المؤكَّد في المدى والنطاق نفسيهما (services/netSales.ts)،
 *   و**قبل الضريبة**: صافي البند = lineTotal − taxAmt (lineTotal شاملٌ الضريبة في الوضعين ومعه حصّته من خصم الفاتورة —
 *   lib/invoiceCalc.ts). ومجموع صوافي بنود الفاتورة = total − taxAmt؛ فاتورةٌ قديمة يخالفه مجموعُ بنودها (خصمٌ كلّيٌّ قبل
 *   تصحيح المحرّك) يُوزَّع صافيها على بنودها بأكبر الباقي فيبقى رقم الفاتورة هو الحكم.
 * - **التكلفة** لكل بند، بمصدرين:
 *   ١) الشركة ذات الدفاتر المربوطة (LINKED) ولبندها لقطة GlCostSnapshot (رجل البيع OUT أو المرتجع RET): أثر لقطاته على
 *      حساب تكلفة المبيعات بالجدول الوحيد (costing/accounts.ts cogsImpactMilli) — البيع موجب، والمرتجع العائد للمخزون أو
 *      المشطوب يعكسه (الشطب خسارة تلفٍ تُقيَّد مصروفاً لا تكلفة بيع، فلا يدخل «قبل المصروفات»)، وتبديل «الإعادة للمخزون» معه.
 *      وكميةٌ في اللقطة بلا تكلفة معروفة لحظة البيع (uncostedQty — بيعٌ من سيارةٍ أو مستودعٍ بلا رصيدٍ مقيَّم) تُكمَّل بمتوسّط
 *      الشراء (٢) وتُضاف إلى أثر اللقطة: الدفاتر تُثبت تكلفتها لاحقاً فرقاً على حركة سدّ الفجوة (VAN_LOAD وغيرها — absorbIn)
 *      لا على لقطة الفاتورة، فتركها صفراً يضخّم الربح عمّا في قائمة الدخل وعمّا تُظهره الشركة غير المربوطة للبيع نفسه.
 *   ٢) وإلا: متوسّط تكلفة الشراء المرجّح لوحدة الأساس من الوارد المسعَّر (RECEIVE مُرحَّل، unitCost > 0 صافٍ قبل الضريبة
 *      ÷ unitFactor، مرجَّحاً بكمية الأساس) حتى نهاية الفترة — والمرتجع يعيد تكلفته بالمتوسّط نفسه.
 *   صنفٌ بلا سعر شراء (لا لقطة مقيَّمة ولا وارد مسعَّر): تكلفته صفر وعَلَمه «بلا تكلفة» (noCost) وعدده في رأس التقرير. والإشعار
 *   المدين (بنودٌ بلا أصناف) إيرادٌ بلا تكلفة بطبيعته فلا يُعلَّم.
 * - المبالغ نصف-لأعلى بمنازل عملة الشركة (lib/money roundHalfUp)، وتكلفة البند تُقرَّب مرّةً واحدة فيتّسق المجموع مع الصفوف.
 * - حدود الأيام والشهور بتوقيت الشركة لا UTC (gl/dates zonedStartOfDay وlocalDate).
 * - عزل الشركة شرطٌ في كل استعلام، ونطاق المستخدم المقيَّد (scopedRecordWhere) وفلاتر المندوب/العميل/الموقع/الفريق كتقرير
 *   المبيعات. بلا N+1: معرّفات الفواتير باستعلامٍ واحد، وبنودها واللقطات والأسماء دفعاتٍ بالمعرّفات، والمتوسّط تجميعٌ في القاعدة.
 * - **سقفٌ معلن:** أحدث PROFIT_MAX_INVOICES فاتورة في المدى (بتاريخها ثم معرّفها تنازلياً)، وما زاد يُعلَن meta.truncated/limit
 *   كتقريري المشتريات والتشغيلات — لا تُحمَّل بنود تاريخ الشركة كله في ذاكرة الخادم الواحد لكل الشركات («إلى» وحده أو «من» بعيد).
 * - **الصلاحية:** التكلفة لكل صنف تكشف تكلفة شراء الوحدة (التكلفة ÷ الكمية) — فبحارس تقريرَي المشتريات والضرائب نفسه
 *   (canSeePurchaseCost: جلسة المالك، أو مستخدمٌ نشط لم يُمنع canManageVanStock)، وغيره ٤٠٣ كتقرير المشتريات.
 * - «إزالة الضريبة»: لا ضريبة في الردّ أصلاً، و`taxOff` يُعلم الواجهة فلا تكتب «قبل الضريبة».
 *
 * الصرف (profitRange، lineNetsOf، snapshotCostsByItem، averageCostMap، lineCostOf، buildProfitReport) بلا قاعدة ليُختبر
 * وحده (tests/reports3-profit.test.ts)، والمعالج profitReportHandler يُركَّب في routes/reports.ts.
 */
import { Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { tenantId } from '../../middleware/auth';
import { AuthRequest } from '../../types';
import { scopedRecordWhere, SHAPE_INVOICE_RECEIPT } from '../adminScope';
import { reportTeamOf, teamDocWhere } from '../teams';
import { locationDocWhere, locationFilterOf } from '../locations';
import { companyZoneOf } from '../invoiceExpiry';
import { isLinked } from '../booksMode';
import { isTaxOff } from '../taxMode';
import { baseQtyOf, roundQty, QTY_EPS } from '../units';
import { netSales as netOf } from '../netSales';
import { addDays, isLocalDate, localDate, todayLocal, zonedStartOfDay } from '../gl/dates';
import { cogsImpactMilli } from '../costing/accounts';
import { MOVE_KINDS, type LocationKey, type MoveKind } from '../costing/types';
import { distributeAmount, roundHalfUp } from '../../lib/money';
import { currencyDecimalsOf, getCountryTax } from '../../config/countries';
import { canSeePurchaseCost } from './taxReport';

// ═══ المعاملات ═══

export type ProfitGroup = 'product' | 'rep' | 'customer' | 'month';
export const PROFIT_GROUPS: readonly ProfitGroup[] = ['product', 'rep', 'customer', 'month'];
/** التجميع الافتراضي حين لا يُمرَّر */
export const DEFAULT_PROFIT_GROUP: ProfitGroup = 'product';
/** النافذة الافتراضية بلا مدى — كتقرير المبيعات (آخر ٩٠ يوماً)، بأيام الشركة */
export const PROFIT_DEFAULT_DAYS = 90;
/** سقف فواتير التقرير (الأحدث أولاً) — يُعلَن meta.truncated فلا يُقرأ ربحٌ مقصوص على أنه شامل (كـLOT_SALES_MAX_INVOICES) */
export const PROFIT_MAX_INVOICES = 20_000;

/** التجميع: الغائب أو الفارغ undefined (الافتراضي)، والمجهول null (٤٠٠) — لا يُستبدل بتجميعٍ آخر صامتاً */
export function profitGroupOf(v: unknown): ProfitGroup | null | undefined {
  if (v === undefined || v === '') return undefined;
  return typeof v === 'string' && (PROFIT_GROUPS as readonly string[]).includes(v) ? (v as ProfitGroup) : null;
}

/**
 * معرّف فلتر (مندوب/عميل/موقع): كـreportIdOf في routes/reports.ts حرفاً — نصٌّ مقصوص بحدّ ٦٤، والغائب والفارغ بلا فلتر،
 * وغير النصّ أو الأطول false (٤٠٠). نسخةٌ محلية عمداً: الاستيراد من routes/reports يصنع حلقة (المسار يستورد هذا الملف).
 */
export function profitIdOf(v: unknown): string | undefined | false {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s) return undefined;
  return s.length <= 64 ? s : false;
}

export interface ProfitRangeOk {
  ok: true;
  /** أيام الشركة YYYY-MM-DD؛ from null = بلا حدّ أدنى («إلى» وحده) */
  from: string | null;
  to: string;
  gte: Date | null;
  lt: Date;
  defaulted: boolean;
}

/**
 * المدى بأيام الشركة: «من» و«إلى» شاملان يومَيهما كاملين بتوقيتها. بلا طرفين: آخر ٩٠ يوماً حتى اليوم (defaulted)؛
 * «من» وحده: حتى اليوم (أو يومه إن كان في المستقبل)؛ «إلى» وحده: بلا حدٍّ أدنى. والتاريخ الفاسد أو المقلوب ٤٠٠.
 * و«إلى» نهاية الفترة التي يُحسب حتّاها متوسّط تكلفة الشراء.
 */
export function profitRange(rawFrom: unknown, rawTo: unknown, tz: string, now: Date = new Date()): ProfitRangeOk | { ok: false; message: string } {
  const given = (v: unknown) => v !== undefined && v !== null && v !== '';
  if ((given(rawFrom) && !isLocalDate(rawFrom)) || (given(rawTo) && !isLocalDate(rawTo))) return { ok: false, message: 'تاريخ غير صالح' };
  const today = todayLocal(now, tz);
  const fromIn = isLocalDate(rawFrom) ? rawFrom : null;
  const toIn = isLocalDate(rawTo) ? rawTo : null;
  const defaulted = !fromIn && !toIn;
  const to = toIn ?? (fromIn && fromIn > today ? fromIn : today);
  const from = defaulted ? addDays(today, -(PROFIT_DEFAULT_DAYS - 1)) : fromIn;
  if (from && from > to) return { ok: false, message: 'تاريخ البداية بعد تاريخ النهاية' };
  return { ok: true, from, to, gte: from ? zonedStartOfDay(from, tz) : null, lt: zonedStartOfDay(addDays(to, 1), tz), defaulted };
}

// ═══ صافي البند قبل الضريبة ═══

export interface ProfitDocIn {
  id: string;
  type: string;
  documentKind?: string | null;
  invoiceDate: Date;
  total: number;
  taxAmt: number;
  salesRepId: string | null;
  customerId: string;
}

export interface ProfitItemIn {
  id: string;
  invoiceId: string;
  productId: string | null;
  itemName: string | null;
  qty: number;
  unitName?: string | null;
  unitFactor?: number | null;
  baseQty?: number | null;
  lineTotal: number;
  taxAmt: number;
  invoice: ProfitDocIn;
}

/**
 * صافي كل بند قبل الضريبة (موجباً كما خُزّن) — lineTotal − taxAmt، ومجموعها لكل فاتورة = total − taxAmt. فاتورةٌ يخالف
 * مجموعُ بنودها صافيَها بأكثر من نصف أصغر وحدة عملة يُوزَّع صافيها على بنودها بنسبها بأكبر الباقي (distributeAmount).
 */
export function lineNetsOf(items: readonly ProfitItemIn[], dec: number): Map<string, number> {
  const out = new Map<string, number>();
  const byInvoice = new Map<string, ProfitItemIn[]>();
  for (const it of items) {
    const list = byInvoice.get(it.invoiceId) ?? [];
    list.push(it);
    byInvoice.set(it.invoiceId, list);
  }
  const half = Math.pow(10, -dec) / 2;
  for (const list of byInvoice.values()) {
    const raw = list.map((it) => roundHalfUp(Number(it.lineTotal || 0) - Number(it.taxAmt || 0), dec));
    const sum = roundHalfUp(raw.reduce((s, v) => s + v, 0), dec);
    const inv = list[0].invoice;
    const target = roundHalfUp(Number(inv.total || 0) - Number(inv.taxAmt || 0), dec);
    const weightsOk = raw.some((v) => v > 0);
    const nets = Math.abs(sum - target) > half && target > 0 && weightsOk ? distributeAmount(target, raw, dec) : raw;
    list.forEach((it, i) => out.set(it.id, nets[i]));
  }
  return out;
}

// ═══ التكلفة ═══

/** لقطة تكلفة كما تُقرأ من gl_cost_snapshots */
export interface ProfitSnapshotIn {
  sourceKey: string;
  kind: string;
  itemId: string;
  location: string;
  toLocation: string | null;
  baseQty: number;
  uncostedQty: number;
  valueMilli: bigint;
  varianceMilli: bigint;
  memoMilli: bigint;
}

/** أثر لقطات بندٍ على تكلفة المبيعات: hasLeg = للبند رجل بيعٍ أو مرتجع (OUT/RET)، وإلا يُكلَّف بالمتوسّط */
export interface SnapshotCost { milli: bigint; uncostedQty: number; hasLeg: boolean }

const isMoveKind = (k: string): k is MoveKind => (MOVE_KINDS as readonly string[]).includes(k);
const legOf = (sourceKey: string): string | null => /^COST:INVOICE:[^:]+:(OUT|CANCEL|RET|RETCANCEL)$/.exec(sourceKey)?.[1] ?? null;

/** Σ أثر لقطات كل بند على تكلفة المبيعات (بالملّي، موجب = تكلفة) — لقطةٌ بنوعٍ مجهول تُهمل ولا تُسقط التقرير */
export function snapshotCostsByItem(snaps: readonly ProfitSnapshotIn[]): Map<string, SnapshotCost> {
  const out = new Map<string, SnapshotCost>();
  for (const s of snaps) {
    if (!isMoveKind(s.kind)) continue;
    let cogs: bigint;
    try {
      cogs = cogsImpactMilli({
        kind: s.kind, location: s.location as LocationKey, toLocation: (s.toLocation as LocationKey | null) ?? null,
        valueMilli: BigInt(s.valueMilli), varianceMilli: BigInt(s.varianceMilli), memoMilli: BigInt(s.memoMilli), reason: null,
      });
    } catch { continue; }
    const acc = out.get(s.itemId) ?? { milli: 0n, uncostedQty: 0, hasLeg: false };
    acc.milli += cogs;
    const leg = legOf(s.sourceKey);
    if (leg === 'OUT' || leg === 'RET') {
      acc.hasLeg = true;
      acc.uncostedQty += Math.abs(Number(s.uncostedQty) || 0);
    }
    out.set(s.itemId, acc);
  }
  return out;
}

/** صفّ تجميع الوارد المسعَّر لكل صنف: Σ (unitCost ÷ unitFactor × كمية الأساس) وΣ كمية الأساس */
export interface AvgCostAggRow { productId: string; value: number | string | null; base: number | string | null }

/** متوسّط تكلفة وحدة الأساس لكل صنف (غير مقرَّب — التقريب على تكلفة البند) — صنفٌ بلا وارد مسعَّر غائب */
export function averageCostMap(rows: readonly AvgCostAggRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const value = Number(r.value);
    const base = Number(r.base);
    if (Number.isFinite(value) && Number.isFinite(base) && base > QTY_EPS && value > 0) out.set(r.productId, value / base);
  }
  return out;
}

export type CostSource = 'SNAPSHOT' | 'AVERAGE' | 'NONE';
export interface LineCost {
  cost: number;
  noCostQty: number;
  source: CostSource;
  /** كمية الأساس التي لا تكلفة لها في اللقطة فأُكملت بالمتوسّط (يُعلن مصدر التقرير «مختلطاً») — غائبٌ حين لا شيء */
  averagedQty?: number;
}

/**
 * تكلفة بندٍ بإشارتها (المرتجع سالب): اللقطة إن كان للبند رجلها — وكميتها بلا تكلفة (uncostedQty) تُكمَّل بالمتوسّط إن وُجد،
 * وإلا تبقى «بلا تكلفة» — وإلا الكمية بالأساس × المتوسّط، وإلا صفرٌ و«بلا تكلفة» لكميته كلها. التقريب نصف-لأعلى بمنازل
 * العملة مرّةً واحدة. بندٌ بلا صنف ولا لقطة (الإشعار المدين) صفرٌ بلا عَلَم (noCostQty 0).
 */
export function lineCostOf(
  item: { id: string; productId: string | null; qty: number; unitFactor?: number | null; baseQty?: number | null; unitName?: string | null },
  isReturn: boolean,
  snaps: ReadonlyMap<string, SnapshotCost>,
  avg: ReadonlyMap<string, number>,
  dec: number,
  adjustment = false,
): LineCost {
  const qty = Math.abs(baseQtyOf(item));
  const sign = isReturn ? -1 : 1;
  const s = snaps.get(item.id);
  if (s?.hasLeg) {
    const snapCost = Number(s.milli) / 1000;
    const uncosted = roundQty(Math.min(qty, s.uncostedQty)) || 0;
    const fill = uncosted > QTY_EPS && item.productId ? avg.get(item.productId) : undefined;
    if (fill !== undefined) {
      return { cost: roundHalfUp(snapCost + sign * uncosted * fill, dec) || 0, noCostQty: 0, source: 'SNAPSHOT', averagedQty: uncosted };
    }
    return { cost: roundHalfUp(snapCost, dec) || 0, noCostQty: uncosted, source: 'SNAPSHOT' };
  }
  const a = item.productId ? avg.get(item.productId) : undefined;
  if (a !== undefined) return { cost: (sign * roundHalfUp(qty * a, dec)) || 0, noCostQty: 0, source: 'AVERAGE' };
  return { cost: 0, noCostQty: adjustment ? 0 : qty, source: 'NONE' };
}

// ═══ التجميع ═══

export interface ReportUnitOut { id?: string; name: string; factor: number }
export interface ProfitProductInfo { name: string; code: string | null; unit: string; primaryUnitId: string | null; units: ReportUnitOut[] }
export interface ProfitNames {
  products: ReadonlyMap<string, ProfitProductInfo>;
  reps: ReadonlyMap<string, string>;
  customers: ReadonlyMap<string, string>;
  /** «رقم العميل» (٢٣ نوفمبر ٢٠٢٦) لتجميع العميل وحده — خريطةٌ موازية للأسماء فلا يتغيّر شكل `customers`؛ غيابها ⇒ null */
  customerNumbers?: ReadonlyMap<string, number | null>;
}

/** مفتاحا الصفّين الخاصّين: بلا مندوب، وبنود الإشعارات المدينة (تعديل سعرٍ بلا صنف) */
export const NO_REP_KEY = '—';
export const ADJUSTMENT_KEY = '__adjustments';

export interface ProfitRow {
  key: string;
  name: string;
  /** للصنف: كوده ووحداته و«الوحدة الرئيسية» للعارض؛ الكمية صافيةٌ بالأساس (البيع − المرتجع) */
  code?: string | null;
  /** لتجميع العميل وحده: «رقم العميل» (null قبل ترقيمه) — يُعرض بجانب الاسم ويطابقه البحث تماماً */
  number?: number | null;
  qty?: number;
  unit?: string;
  units?: ReportUnitOut[];
  primaryUnitId?: string | null;
  /** عدد فواتير البيع في المجموعة (المرتجع لا يُعدّ) */
  count: number;
  netSales: number;
  cost: number;
  grossProfit: number;
  /** مجمل الربح ÷ المبيعات الصافية × ١٠٠ بمنزلتين — null حين لا مبيعات صافية موجبة */
  marginPct: number | null;
  /** في المجموعة كميةٌ بلا تكلفة معروفة (عُدّت تكلفتها صفراً) */
  noCost: boolean;
  /** كمية الأساس بلا تكلفة (للصنف وحده) */
  noCostQty?: number;
}

export interface ProfitSummary {
  netSales: number;
  cost: number;
  grossProfit: number;
  marginPct: number | null;
  /** صافي فواتير البيع قبل المرتجع (قبل الضريبة)، والمرتجع موجباً */
  salesTotal: number;
  returnsTotal: number;
  invoicesCount: number;
  returnsCount: number;
  /** الأصناف التي بيعت (أو أُرجعت) بلا تكلفة معروفة في الفترة — عددها وقائمتها */
  noCostProducts: number;
  noCostList: { key: string; productId: string | null; name: string; code: string | null; qty: number }[];
  /** مصدر التكلفة: لقطات الدفاتر، أو متوسّط الشراء، أو كلاهما، أو لا شيء */
  costSource: 'SNAPSHOT' | 'AVERAGE' | 'MIXED' | 'NONE';
}

export interface ProfitLineIn {
  item: ProfitItemIn;
  net: number;
  cost: LineCost;
  month: string;
}

const marginOf = (profit: number, sales: number): number | null => (sales > 0 ? roundHalfUp((profit / sales) * 100, 2) : null);

/**
 * الصفوف والملخّص من البنود المسعَّرة. الصنف المحذوف (productId فارغ) يُجمع باسمه المحفوظ في البند، وبنود الإشعار المدين
 * صفٌّ واحد «تعديلات أسعار» (لا ذكر لمستندٍ ضريبي في اسمه — «إزالة الضريبة»). الشهر بترتيبه الزمني، وغيره من الأعلى مجملَ ربح.
 */
export function buildProfitReport(lines: readonly ProfitLineIn[], groupBy: ProfitGroup, names: ProfitNames, dec: number): { rows: ProfitRow[]; summary: ProfitSummary } {
  type Acc = { key: string; name: string; productId: string | null; code: string | null; base: number; net: number; cost: number; invoices: Set<string>; noCostQty: number; adjustment: boolean };
  const groups = new Map<string, Acc>();
  const products = new Map<string, Acc>();
  const sales = new Set<string>();
  const returns = new Set<string>();
  let salesNet = 0;
  let returnsNet = 0;
  const sources = new Set<CostSource>();

  const productKeyOf = (it: ProfitItemIn): { key: string; name: string; productId: string | null; code: string | null; adjustment: boolean } => {
    if (it.productId) {
      const p = names.products.get(it.productId);
      return { key: it.productId, name: p?.name ?? it.itemName ?? 'صنف محذوف', productId: it.productId, code: p?.code ?? null, adjustment: false };
    }
    if (it.invoice.documentKind === 'DEBIT_NOTE') return { key: ADJUSTMENT_KEY, name: 'تعديلات أسعار', productId: null, code: null, adjustment: true };
    const nm = (it.itemName ?? '').trim();
    return { key: `deleted:${nm}`, name: nm || 'صنف محذوف', productId: null, code: null, adjustment: false };
  };
  const groupOf = (l: ProfitLineIn) => {
    const inv = l.item.invoice;
    if (groupBy === 'product') return productKeyOf(l.item);
    if (groupBy === 'rep') {
      const id = inv.salesRepId;
      return { key: id ?? NO_REP_KEY, name: id ? names.reps.get(id) ?? '—' : 'بلا مندوب', productId: null, code: null, adjustment: false };
    }
    if (groupBy === 'customer') return { key: inv.customerId, name: names.customers.get(inv.customerId) ?? '—', productId: null, code: null, adjustment: false };
    return { key: l.month, name: l.month, productId: null, code: null, adjustment: false };
  };
  const slot = (map: Map<string, Acc>, g: ReturnType<typeof groupOf>): Acc => {
    let a = map.get(g.key);
    if (!a) map.set(g.key, (a = { ...g, base: 0, net: 0, cost: 0, invoices: new Set(), noCostQty: 0 }));
    return a;
  };

  for (const l of lines) {
    const inv = l.item.invoice;
    const isReturn = inv.type === 'RETURN';
    const sign = isReturn ? -1 : 1;
    const qty = Math.abs(baseQtyOf(l.item));
    if (isReturn) { returns.add(inv.id); returnsNet += l.net; } else { sales.add(inv.id); salesNet += l.net; }
    if (l.cost.source !== 'NONE') sources.add(l.cost.source);
    if ((l.cost.averagedQty ?? 0) > QTY_EPS) sources.add('AVERAGE');
    for (const a of [slot(groups, groupOf(l)), slot(products, productKeyOf(l.item))]) {
      a.base += sign * qty;
      a.net += sign * l.net;
      a.cost += l.cost.cost;
      a.noCostQty += l.cost.noCostQty;
      if (!isReturn) a.invoices.add(inv.id);
    }
  }

  const rows: ProfitRow[] = [...groups.values()].map((a) => {
    const netSales = roundHalfUp(a.net, dec) || 0;
    const cost = roundHalfUp(a.cost, dec) || 0;
    const grossProfit = roundHalfUp(netSales - cost, dec) || 0;
    const row: ProfitRow = {
      key: a.key, name: a.name, count: a.invoices.size, netSales, cost, grossProfit, marginPct: marginOf(grossProfit, netSales),
      noCost: a.noCostQty > QTY_EPS,
    };
    if (groupBy === 'product') {
      const p = a.productId ? names.products.get(a.productId) : undefined;
      Object.assign(row, {
        code: a.code, qty: roundQty(a.base) || 0, unit: p?.unit ?? '', units: p?.units ?? [], primaryUnitId: p?.primaryUnitId ?? null,
        noCostQty: roundQty(a.noCostQty) || 0,
      });
    }
    // صفّ العميل يحمل رقمه — مفتاحه معرّف العميل (groupOf)
    if (groupBy === 'customer') row.number = names.customerNumbers?.get(a.key) ?? null;
    return row;
  });
  if (groupBy === 'month') rows.sort((x, y) => x.key.localeCompare(y.key));
  else rows.sort((x, y) => y.grossProfit - x.grossProfit || y.netSales - x.netSales || x.name.localeCompare(y.name, 'ar'));

  const noCostList = [...products.values()]
    .filter((p) => p.noCostQty > QTY_EPS)
    .map((p) => ({ key: p.key, productId: p.productId, name: p.name, code: p.code, qty: roundQty(p.noCostQty) || 0 }))
    .sort((x, y) => x.name.localeCompare(y.name, 'ar'));

  // المبيعات الصافية = صافي البيع − صافي المرتجع (services/netSales.ts)، والتكلفة مجموع الصفوف المعروضة — المبالغ كلها بمنازل
  // العملة (صافي البند وتكلفته مقرَّبان مرّةً) فيساوي الإجماليُّ مجموعَ الصفوف في كل تجميع بلا فرق تقريب
  const salesTotal = roundHalfUp(salesNet, dec) || 0;
  const returnsTotal = roundHalfUp(returnsNet, dec) || 0;
  const netSales = roundHalfUp(netOf(salesTotal, returnsTotal), dec) || 0;
  const cost = roundHalfUp(rows.reduce((s, r) => s + r.cost, 0), dec) || 0;
  const grossProfit = roundHalfUp(netSales - cost, dec) || 0;
  return {
    rows,
    summary: {
      netSales, cost, grossProfit, marginPct: marginOf(grossProfit, netSales),
      salesTotal, returnsTotal,
      invoicesCount: sales.size, returnsCount: returns.size,
      noCostProducts: noCostList.length, noCostList,
      costSource: sources.size === 0 ? 'NONE' : sources.size === 2 ? 'MIXED' : sources.has('SNAPSHOT') ? 'SNAPSHOT' : 'AVERAGE',
    },
  };
}

// ═══ المعالج ═══

/** دفعات معرّفات IN — لا يبلغ استعلامٌ حدّ معاملات Postgres مهما كبرت الفترة */
const ID_CHUNK = 2000;
const chunks = <T>(arr: readonly T[], n = ID_CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

const bad = (res: Response, message = 'معامل غير صالح'): void => { res.status(400).json({ success: false, message }); };

/**
 * GET /reports/profit — يُركَّب خلف حرّاس مسار التقارير (authenticate، requireAdmin، canViewReports). ويحرس هنا صلاحية تكلفة
 * الشراء (canSeePurchaseCost — كتقريرَي المشتريات والضرائب: التكلفة ÷ الكمية تكلفة شراء الوحدة) بـ٤٠٣ قبل أي قراءة، والمحاسبة
 * المطفأة (٤٠٣ ACCOUNTING_NOT_ALLOWED كتقييم الأداء بمعياره المالي): الربح رقمٌ ماليّ خالص.
 */
export async function profitReportHandler(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!(await canSeePurchaseCost(req))) {
      res.status(403).json({ success: false, message: 'لا تملك صلاحية الوصول لهذا القسم' });
      return;
    }
    const tid = tenantId(req);
    const q = req.query as Record<string, unknown>;
    const g = profitGroupOf(q.groupBy);
    if (g === null) { bad(res); return; }
    const groupBy = g ?? DEFAULT_PROFIT_GROUP;
    const salesRepId = profitIdOf(q.salesRepId);
    const customerId = profitIdOf(q.customerId);
    const locationId = profitIdOf(q.locationId);
    if (salesRepId === false || customerId === false || locationId === false) { bad(res); return; }

    const [tenant, company, gl] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tid }, select: { accountingEnabled: true } }),
      prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { countryCode: true, currency: true, taxDisabled: true } }),
      prisma.glSettings.findUnique({ where: { tenantId: tid }, select: { timezone: true, setupMethod: true, activatedAt: true } }),
    ]);
    if (tenant?.accountingEnabled === false) {
      res.status(403).json({ success: false, code: 'ACCOUNTING_NOT_ALLOWED', message: 'النظام المحاسبي غير مفعّل لهذه الشركة تواصل مع مزود الخدمة' });
      return;
    }
    const tz = companyZoneOf(gl?.timezone, company?.countryCode);
    const dec = currencyDecimalsOf(company?.currency ?? getCountryTax(company?.countryCode).currency);
    const range = profitRange(q.from, q.to, tz);
    if (!range.ok) { bad(res, range.message); return; }

    const invoiceWhere: Prisma.InvoiceWhereInput = {
      tenantId: tid,
      // نطاق المستخدم: لا تدخل التقرير فاتورةٌ لعميل أو مندوب خارج نطاقه
      ...(await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT)),
      status: 'CONFIRMED',
      invoiceDate: { ...(range.gte ? { gte: range.gte } : {}), lt: range.lt },
      ...(salesRepId && { salesRepId }),
      ...(customerId && { customerId }),
      ...locationDocWhere(locationFilterOf(locationId)),
      ...teamDocWhere(reportTeamOf(q.teamId)),
    };
    // السقف: معرّفات أحدث الفواتير أولاً (صفٌّ زائد شاهدُ «يوجد المزيد»)، ثم بنودها دفعاتٍ بالمعرّفات — لا قراءة بلا حدّ
    const head = await prisma.invoice.findMany({
      where: invoiceWhere,
      select: { id: true },
      orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }],
      take: PROFIT_MAX_INVOICES + 1,
    });
    const truncated = head.length > PROFIT_MAX_INVOICES;
    const readIds = (truncated ? head.slice(0, PROFIT_MAX_INVOICES) : head).map((h) => h.id);
    const itemSelect = {
      id: true, invoiceId: true, productId: true, itemName: true, qty: true, unitName: true, unitFactor: true, baseQty: true,
      lineTotal: true, taxAmt: true,
      invoice: { select: { id: true, type: true, documentKind: true, invoiceDate: true, total: true, taxAmt: true, salesRepId: true, customerId: true } },
    } as const;
    const rawItems: Prisma.InvoiceItemGetPayload<{ select: typeof itemSelect }>[] = [];
    for (const ids of chunks(readIds)) {
      // الشركة شرطٌ على فاتورة البند أيضاً (المعرّفات من استعلامها نفسه)
      const part = await prisma.invoiceItem.findMany({ where: { invoiceId: { in: ids }, invoice: { tenantId: tid } }, select: itemSelect });
      for (const row of part) rawItems.push(row); // لا نشر (...) لدفعةٍ قد تتجاوز حدّ وسائط الدالّة
    }
    const items: ProfitItemIn[] = rawItems.map((i) => ({
      ...i, qty: Number(i.qty), unitFactor: Number(i.unitFactor), baseQty: i.baseQty == null ? null : Number(i.baseQty),
      lineTotal: Number(i.lineTotal), taxAmt: Number(i.taxAmt),
      invoice: { ...i.invoice, total: Number(i.invoice.total), taxAmt: Number(i.invoice.taxAmt) },
    }));

    const invoiceIds = [...new Set(items.map((i) => i.invoiceId))];
    const returnItemIds = items.filter((i) => i.invoice.type === 'RETURN').map((i) => i.id);
    const productIds = [...new Set(items.map((i) => i.productId).filter((x): x is string => !!x))];
    const repIds = [...new Set(items.map((i) => i.invoice.salesRepId).filter((x): x is string => !!x))];
    const customerIds = [...new Set(items.map((i) => i.invoice.customerId))];

    // لقطات التكلفة للشركة المربوطة وحدها: رجلا البيع والمرتجع (refId الفاتورة) وتبديل «الإعادة للمخزون» (itemId بند المرتجع)
    const snapSelect = {
      sourceKey: true, kind: true, itemId: true, location: true, toLocation: true, baseQty: true, uncostedQty: true,
      valueMilli: true, varianceMilli: true, memoMilli: true,
    } as const;
    const linked = isLinked(gl);
    const snapRows: ProfitSnapshotIn[] = [];
    if (linked && items.length) {
      for (const ids of chunks(invoiceIds)) {
        snapRows.push(...await prisma.glCostSnapshot.findMany({ where: { tenantId: tid, refType: 'INVOICE', refId: { in: ids } }, select: snapSelect }));
      }
      for (const ids of chunks(returnItemIds)) {
        snapRows.push(...await prisma.glCostSnapshot.findMany({ where: { tenantId: tid, refType: 'RESTOCK_LOG', itemId: { in: ids } }, select: snapSelect }));
      }
    }
    const snaps = snapshotCostsByItem(snapRows);

    // المتوسّط لأصنافٍ بنودها بلا لقطة، أو في لقطتها كميةٌ بلا تكلفة: تجميعٌ في القاعدة على الوارد المسعَّر المرحَّل حتى نهاية الفترة
    const needAvg = [...new Set(items.filter((i) => {
      if (!i.productId) return false;
      const s = snaps.get(i.id);
      return !s?.hasLeg || s.uncostedQty > QTY_EPS;
    }).map((i) => i.productId as string))];
    const avgRows: AvgCostAggRow[] = [];
    for (const ids of chunks(needAvg)) {
      avgRows.push(...await prisma.$queryRaw<AvgCostAggRow[]>`
        SELECT i."productId" AS "productId",
               SUM(i."unitCost" / CASE WHEN i."unitFactor" > 0 THEN i."unitFactor" ELSE 1 END
                   * COALESCE(i."baseQty", i.qty * CASE WHEN i."unitFactor" > 0 THEN i."unitFactor" ELSE 1 END))::float8 AS value,
               SUM(COALESCE(i."baseQty", i.qty * CASE WHEN i."unitFactor" > 0 THEN i."unitFactor" ELSE 1 END))::float8 AS base
        FROM "warehouse_entry_items" i
        JOIN "warehouse_entries" e ON e.id = i."entryId"
        WHERE e."tenantId" = ${tid} AND e.type = 'RECEIVE' AND e.status = 'POSTED'
          AND e."createdAt" < ${range.lt} AND i."unitCost" IS NOT NULL AND i."unitCost" > 0 AND i.qty > 0
          AND i."productId" = ANY(${ids}::text[])
        GROUP BY i."productId"`);
    }
    const avg = averageCostMap(avgRows);

    // الأسماء دفعةً واحدة لكل بُعد — الأصناف دائماً (قائمة «بلا تكلفة»)، والمناديب والعملاء لتجميعهم وحده
    const [productRows, unitRows, repRows, customerRows] = await Promise.all([
      productIds.length
        ? prisma.product.findMany({ where: { tenantId: tid, id: { in: productIds } }, select: { id: true, name: true, code: true, unit: true, primaryUnitId: true } })
        : Promise.resolve([]),
      groupBy === 'product' && productIds.length
        ? prisma.productUnit.findMany({
          where: { tenantId: tid, productId: { in: productIds }, isActive: true },
          select: { id: true, productId: true, name: true, factor: true }, orderBy: { factor: 'desc' },
        })
        : Promise.resolve([]),
      groupBy === 'rep' && repIds.length
        ? prisma.salesRep.findMany({ where: { tenantId: tid, id: { in: repIds } }, select: { id: true, name: true } })
        : Promise.resolve([]),
      groupBy === 'customer' && customerIds.length
        ? prisma.customer.findMany({ where: { tenantId: tid, id: { in: customerIds } }, select: { id: true, name: true, number: true } })
        : Promise.resolve([]),
    ]);
    const unitsOf = new Map<string, ReportUnitOut[]>();
    for (const u of unitRows) {
      const list = unitsOf.get(u.productId) ?? [];
      list.push({ id: u.id, name: u.name, factor: Number(u.factor) });
      unitsOf.set(u.productId, list);
    }
    const names: ProfitNames = {
      products: new Map(productRows.map((p) => [p.id, { name: p.name, code: p.code ?? null, unit: p.unit ?? '', primaryUnitId: p.primaryUnitId ?? null, units: unitsOf.get(p.id) ?? [] }])),
      reps: new Map(repRows.map((r) => [r.id, r.name])),
      customers: new Map(customerRows.map((c) => [c.id, c.name])),
      customerNumbers: new Map(customerRows.map((c) => [c.id, c.number ?? null])),
    };

    const nets = lineNetsOf(items, dec);
    const lines: ProfitLineIn[] = items.map((it) => ({
      item: it,
      net: nets.get(it.id) ?? 0,
      cost: lineCostOf(it, it.invoice.type === 'RETURN', snaps, avg, dec, !it.productId && it.invoice.documentKind === 'DEBIT_NOTE'),
      month: localDate(it.invoice.invoiceDate, tz).slice(0, 7),
    }));
    const { rows, summary } = buildProfitReport(lines, groupBy, names, dec);

    res.json({
      success: true,
      data: { groupBy, rows, summary, taxOff: isTaxOff(company), currencyDecimals: dec, linked },
      meta: { appliedRange: { from: range.from, to: range.to, defaulted: range.defaulted }, truncated, limit: PROFIT_MAX_INVOICES },
    });
  } catch (err) { next(err); }
}
