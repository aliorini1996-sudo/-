/**
 * نواة الموردين والمشتريات («ربط الدفاتر» L1، طلب المالك ١٣ نوفمبر ٢٠٢٦) — دوال صرفة بلا قاعدة بيانات.
 *
 * كشف المورّد سجلٌّ إلحاقيّ (supplier_ledger_entries) كـAccountEntry للعميل. الإشارة الموحّدة:
 *   amountMilli موجب = يزيد ما ندين به للمورّد (دائن في حسابه): BILL، PAYMENT_REV، REFUND_IN، OPENING الدائن
 *   amountMilli سالب = ينقصه (مدين في حسابه):               PAYMENT، RETURN، BILL_REV، OPENING المدين
 *   الرصيد = Σ amountMilli (موجب = مستحقّ للمورّد).
 *
 * المبالغ بالملّي (١/١٠٠٠ من وحدة العملة، BigInt) كمحرّك الدفاتر: تُقرَّب المستندات نصف-لأعلى إلى منازل العملة ثم
 * تُحوَّل — فكشف المورّد يطابق القيود بفرق صفر. ⚠️ BigInt لا يمرّ في res.json: حوّل بـmilliToNumber قبل الإرسال.
 */
import { roundHalfUp } from '../../lib/money';

// ═══ الثوابت (نصوص في القاعدة لا enum) ═══

export const SUPPLIER_LEDGER_KINDS = ['BILL', 'BILL_REV', 'PAYMENT', 'PAYMENT_REV', 'RETURN', 'REFUND_IN', 'OPENING'] as const;
export type SupplierLedgerKind = (typeof SUPPLIER_LEDGER_KINDS)[number];

/** نوع الشراء على حركة الوارد: نقدي (سند صرف آلي) أو آجل (ذمم دائنة) — null = غير مصنَّف */
export const PURCHASE_PAYMENT_MODES = ['CASH', 'CREDIT'] as const;
export type PurchasePaymentMode = (typeof PURCHASE_PAYMENT_MODES)[number];

/** طريقة سداد المورّد */
export const SUPPLIER_PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'CHEQUE', 'REP_CUSTODY'] as const;
export type SupplierPaymentMethod = (typeof SUPPLIER_PAYMENT_METHODS)[number];

export const VAT_TREATMENTS = ['RECOVERABLE', 'NON_RECOVERABLE', 'NONE'] as const;
export type VatTreatment = (typeof VAT_TREATMENTS)[number];

export const WAREHOUSE_ENTRY_SOURCES = ['MANUAL', 'API', 'OPENING_IMPORT', 'STOCK_ZERO', 'NEG_SPLIT'] as const;
export type WarehouseEntrySource = (typeof WAREHOUSE_ENTRY_SOURCES)[number];

/** أنواع حركة المستودع: RETURN (مرتجع للمورّد) كميّاته سالبة ويُعامَل في المخزون كتسوية إنقاص */
export const WAREHOUSE_ENTRY_TYPES = ['RECEIVE', 'ADJUST', 'RETURN'] as const;
export type WarehouseEntryType = (typeof WAREHOUSE_ENTRY_TYPES)[number];

export const WAREHOUSE_ADJUST_REASONS = ['COUNT', 'DAMAGE', 'EXPIRY', 'SAMPLE', 'OTHER'] as const;
export type WarehouseAdjustReason = (typeof WAREHOUSE_ADJUST_REASONS)[number];

export const VAN_ADJUST_REASONS = ['COUNT', 'DAMAGE', 'EXPIRY', 'SHORTAGE_REP', 'SAMPLE', 'OTHER'] as const;
export type VanAdjustReason = (typeof VAN_ADJUST_REASONS)[number];

// ═══ الملّي ═══

/** مبلغ عشري ⇐ ملّي مقرَّب نصف-لأعلى إلى منازل العملة (مطابق لـservices/gl/money.toMilli للأرقام) */
export function toMilliAmount(x: number, decimals: number): bigint {
  if (!Number.isFinite(x)) throw new RangeError(`مبلغ غير منتهٍ: ${x}`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 3) throw new RangeError(`منازل عملة غير مدعومة: ${decimals}`);
  return BigInt(Math.round(roundHalfUp(x, decimals) * 1000));
}

/** ملّي ⇐ رقم للعرض/JSON (دقيق حتى ٩×١٠^١٢ وحدة) */
export function milliToNumber(m: bigint | null | undefined): number {
  if (m == null) return 0;
  return Number(m) / 1000;
}

// ═══ إشارة كشف المورّد ═══

const INCREASES: ReadonlySet<SupplierLedgerKind> = new Set(['BILL', 'PAYMENT_REV', 'REFUND_IN']);
const DECREASES: ReadonlySet<SupplierLedgerKind> = new Set(['PAYMENT', 'RETURN', 'BILL_REV']);

/**
 * المبلغ بإشارته من قيمته المطلقة. OPENING يُمرَّر بإشارته كما هو (موجب = رصيد دائن للمورّد).
 * قيمة مطلقة سالبة لغير OPENING خطأ برمجي.
 */
export function signedLedgerAmount(kind: SupplierLedgerKind, absMilli: bigint): bigint {
  if (kind === 'OPENING') return absMilli;
  if (absMilli < 0n) throw new RangeError(`مبلغ سالب لقيد ${kind}`);
  if (INCREASES.has(kind)) return absMilli;
  if (DECREASES.has(kind)) return -absMilli;
  throw new RangeError(`نوع قيد مورّد غير معروف: ${kind}`);
}

/** القيد العكسيّ لكل نوع (التصحيح بالعكس لا بالحذف) */
export function reversalKindOf(kind: SupplierLedgerKind): SupplierLedgerKind | null {
  if (kind === 'BILL') return 'BILL_REV';
  if (kind === 'PAYMENT') return 'PAYMENT_REV';
  return null;
}

/** رصيد المورّد = Σ amountMilli (موجب = مستحقّ له) */
export function supplierBalanceMilli(rows: readonly { amountMilli: bigint }[]): bigint {
  let s = 0n;
  for (const r of rows) s += r.amountMilli;
  return s;
}

// ═══ كشف الحساب ═══

export interface StatementSourceRow {
  id: string;
  kind: SupplierLedgerKind | string;
  amountMilli: bigint;
  docDate: Date;
  createdAt: Date;
}

export interface StatementLine<T extends StatementSourceRow> {
  row: T;
  /** مدين في حساب المورّد (دفعة/مرتجع/عكس فاتورة) — موجب */
  debitMilli: bigint;
  /** دائن في حساب المورّد (فاتورة/عكس دفعة/استرداد) — موجب */
  creditMilli: bigint;
  /** الرصيد الجاري بعد السطر (موجب = مستحقّ للمورّد) */
  balanceMilli: bigint;
}

/** ترتيب الكشف الحتمي: تاريخ المستند ثم لحظة الكتابة ثم المعرّف */
export function compareStatementRows(a: StatementSourceRow, b: StatementSourceRow): number {
  const d = a.docDate.getTime() - b.docDate.getTime();
  if (d) return d;
  const c = a.createdAt.getTime() - b.createdAt.getTime();
  if (c) return c;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * كشف حساب مورّد لفترة: الرصيد الافتتاحي = Σ ما قبل from، والسطور [from, to] بالترتيب الحتمي ورصيدٍ جارٍ.
 * from/to تواريخ يوم (UTC منتصف الليل كـ@db.Date)؛ غيابهما = كل التاريخ.
 */
export function buildSupplierStatement<T extends StatementSourceRow>(rows: readonly T[], from?: Date | null, to?: Date | null): {
  openingMilli: bigint;
  lines: StatementLine<T>[];
  closingMilli: bigint;
  totalDebitMilli: bigint;
  totalCreditMilli: bigint;
} {
  const sorted = [...rows].sort(compareStatementRows);
  let opening = 0n;
  const inRange: T[] = [];
  for (const r of sorted) {
    if (from && r.docDate.getTime() < from.getTime()) { opening += r.amountMilli; continue; }
    if (to && r.docDate.getTime() > to.getTime()) continue;
    inRange.push(r);
  }
  let bal = opening;
  let td = 0n;
  let tc = 0n;
  const lines = inRange.map((row) => {
    bal += row.amountMilli;
    const debitMilli = row.amountMilli < 0n ? -row.amountMilli : 0n;
    const creditMilli = row.amountMilli > 0n ? row.amountMilli : 0n;
    td += debitMilli;
    tc += creditMilli;
    return { row, debitMilli, creditMilli, balanceMilli: bal };
  });
  return { openingMilli: opening, lines, closingMilli: bal, totalDebitMilli: td, totalCreditMilli: tc };
}

// ═══ إجماليات فاتورة المورّد ═══

export interface BillLineInput {
  /** الكمية بوحدة السطر المُدخلة (موجبة للوارد) */
  qty: number;
  /** تكلفة الوحدة صافيةً قبل الضريبة (WarehouseEntryItem.unitCost) */
  unitCost: number;
  /** نسبة ضريبة السطر ٪ (0..100) */
  taxPct: number;
}

export interface BillTotals {
  netMilli: bigint;
  taxMilli: bigint;
  totalMilli: bigint;
}

/**
 * إجماليات المستند: الصافي = تقريب نصف-لأعلى لـΣ(الكمية × التكلفة)، والضريبة لكل نسبة على مجموع صافي سطورها ثم الجمع
 * (taxRoundingMethod PER_TAX الافتراضي)، والإجمالي = الصافي + الضريبة. vatTreatment NONE ⇒ ضريبة صفر.
 * الكميات تُؤخذ بقيمتها المطلقة (المرتجع يمرّر سطوره موجبة).
 */
export function computeBillTotals(lines: readonly BillLineInput[], decimals: number, vatTreatment: VatTreatment | null | undefined): BillTotals {
  let net = 0;
  const byRate = new Map<number, number>();
  for (const l of lines) {
    const qty = Math.abs(l.qty);
    if (!Number.isFinite(qty) || !Number.isFinite(l.unitCost) || l.unitCost < 0) throw new RangeError('سطر فاتورة مورّد غير صالح');
    const lineNet = qty * l.unitCost;
    net += lineNet;
    const pct = vatTreatment === 'NONE' ? 0 : Math.max(0, Number.isFinite(l.taxPct) ? l.taxPct : 0);
    if (pct > 0) byRate.set(pct, (byRate.get(pct) ?? 0) + lineNet);
  }
  const netMilli = toMilliAmount(net, decimals);
  let taxMilli = 0n;
  for (const [pct, base] of byRate) taxMilli += toMilliAmount((base * pct) / 100, decimals);
  return { netMilli, taxMilli, totalMilli: netMilli + taxMilli };
}

/** صافي الوحدة من سعرٍ شاملٍ للضريبة (يُحفظ unitCost صافياً دائماً) — بأربع منازل كتكلفة الدفاتر */
export function netFromGross(gross: number, taxPct: number): number {
  const pct = Number.isFinite(taxPct) && taxPct > 0 ? taxPct : 0;
  return roundHalfUp(gross / (1 + pct / 100), 4);
}

// ═══ تواريخ الفاتورة ═══

/** يوم UTC (منتصف الليل) لتاريخ @db.Date من 'YYYY-MM-DD' — null لغير الصالح */
export function parseDay(s: unknown): Date | null {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
}

/** 'YYYY-MM-DD' ليوم UTC */
export function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** استحقاق فاتورة آجلة: تاريخ الفاتورة + مدة سداد المورّد (بلا مدة ⇒ مستحقّة في يومها) */
export function computeDueDate(billDate: Date, paymentDays?: number | null): Date {
  const days = Number.isInteger(paymentDays) && (paymentDays as number) > 0 ? (paymentDays as number) : 0;
  return new Date(billDate.getTime() + days * 86_400_000);
}

// ═══ مصدر الدفع للشراء النقدي ═══

export type PaidFrom = { kind: 'MAIN_CASH' } | { kind: 'BANK' } | { kind: 'REP_CUSTODY'; salesRepId: string };

/** WarehouseEntry.paidAccountRef ⇐ مصدر الدفع: MAIN_CASH | BANK | REP_CUSTODY:<salesRepId> */
export function formatPaidAccountRef(p: PaidFrom): string {
  return p.kind === 'REP_CUSTODY' ? `REP_CUSTODY:${p.salesRepId}` : p.kind;
}

export function parsePaidAccountRef(ref: string | null | undefined): PaidFrom | null {
  if (!ref) return null;
  if (ref === 'MAIN_CASH') return { kind: 'MAIN_CASH' };
  if (ref === 'BANK') return { kind: 'BANK' };
  const m = /^REP_CUSTODY:(.+)$/.exec(ref);
  return m ? { kind: 'REP_CUSTODY', salesRepId: m[1] } : null;
}

/** طريقة سند الصرف الآلي من مصدر الدفع */
export function paymentMethodOfPaidFrom(p: PaidFrom): SupplierPaymentMethod {
  return p.kind === 'MAIN_CASH' ? 'CASH' : p.kind === 'BANK' ? 'BANK_TRANSFER' : 'REP_CUSTODY';
}

// ═══ المتبقّي على فاتورة المورّد وأعمار الذمم ═══

/**
 * المتبقّي على فاتورة آجلة = إجماليها − تخصيصات الدفعات السارية − إجماليات مرتجعاتها. لا يقلّ عن صفر،
 * والفاتورة الملغاة (CANCELLED) متبقّيها صفر (ألغتها حركة RETURN كاملة).
 */
export function billOutstandingMilli(
  bill: { totalMilli: bigint | null; status: string },
  allocations: readonly { amountMilli: bigint; paymentStatus: string }[],
  returns: readonly { totalMilli: bigint | null }[],
): bigint {
  if (bill.status === 'CANCELLED' || bill.totalMilli == null) return 0n;
  let out = bill.totalMilli;
  for (const a of allocations) if (a.paymentStatus !== 'CANCELLED') out -= a.amountMilli;
  for (const r of returns) out -= r.totalMilli ?? 0n;
  return out > 0n ? out : 0n;
}

export const AGING_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** شريحة العمر بأيام التأخير بعد الاستحقاق (asOf وdueDate يوما UTC) */
export function agingBucketOf(dueDate: Date, asOf: Date): AgingBucket {
  const days = Math.floor((asOf.getTime() - dueDate.getTime()) / 86_400_000);
  if (days <= 0) return 'current';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90_plus';
}
