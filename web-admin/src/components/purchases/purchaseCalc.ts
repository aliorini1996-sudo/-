/**
 * الشراء النقدي/الآجل ومرتجع المورّد في واجهة المستودع («ربط الدفاتر» L1، طلب المالك ١٣ نوفمبر ٢٠٢٦) — دوال صرفة بلا React.
 *
 * المعاينة الحيّة (الصافي والضريبة والإجمالي) مرآةٌ حرفية لحساب الخادم، فما يراه المستخدم قبل الحفظ هو ما يُقيَّد في كشف
 * المورّد بفرق صفر:
 *   - إجماليات المستند = backend/src/services/suppliers/warehouseBills.ts `entryBillTotals` (مرآتها هنا بالاسم نفسه): **السعر كما
 *     أُدخل** (enteredUnitCost) لا التكلفة المخزَّنة بأربع منازل — والأسعار الشاملة يُجمع شاملُها لكل نسبة ثم يُفصل (الإجمالي =
 *     تقريب Σ الشامل، والصافي = تقريب Σ الشامل ÷ (١+النسبة)، والضريبة = الفرق)، وغير الشاملة بـ`computeBillTotals` (core.ts):
 *     الصافي Σ(الكمية × السعر) مقرَّباً نصف-لأعلى إلى منازل العملة، والضريبة لكل نسبة على مجموع صافي سطورها. كل الجمع **بالملّي**
 *     (أعداد صحيحة لا غبار عائمة).
 *     لماذا لا التكلفة المخزَّنة: الصافي بأربع منازل كان يُري ألف وحدة بسعر ١٠ شاملاً 10,000.06 والخادم يقيّد 10,000.00 (والسعر
 *     ١٫٢٣٤٥٦ × ١٠٠٠ يُرى 1,234.60 ويُقيَّد 1,234.56)، وفي «غير مستردة» التكلفة تشمل الضريبة فكانت تُضاف مرّتين.
 *   - المرتجع = `reverseEntryTx`: الجزئي بالسعر المُدخل للسطر الأصلي و«شاملة الضريبة» ومعاملة ضريبة الوارد نفسه، مقيَّداً بالمتبقّي
 *     من الفاتورة؛ والمستنفِد لما بقي يأخذ المتبقّي حرفياً (الفاتورة − المرتجعات السابقة: residualTotals/capTotals).
 *   - تكلفة الوحدة الصافية للعرض = backend/src/services/warehouseCost.ts `netUnitCost` (الردّ من الشامل ثم أربع منازل).
 * التقريب roundHalfUp من lib/money (نسخةٌ حرفية لنسخة الخادم). والمتجهات الذهبية المشتركة مع الخادم في purchaseBillGolden.json
 * (fix-purchasePreviewParity.test.ts يطابقها بالمرآة، وبدالّة الخادم نفسها متى أمكن استيرادها).
 */
import { roundHalfUp } from '../../lib/money';
import type {
  PurchasePaidFrom, PurchasePaymentMode, WarehouseAdjustReason, WarehouseClassifyBody, WarehousePurchaseFields, WarehouseReturnBody,
  WarehouseVatTreatment,
} from '../../api/client';

// ═══ الثوابت ═══

/** خانات تكلفة الوحدة المخزَّنة (COST_DECIMALS في الخادم) */
export const COST_DECIMALS = 4;
/** أقصى طول لرقم فاتورة المورّد (supplierRef ≤ 60 في الخادم) */
export const SUPPLIER_REF_MAX = 60;

export const PURCHASE_MODES: readonly PurchasePaymentMode[] = ['CASH', 'CREDIT'];
export const PURCHASE_MODE_LABELS: Record<PurchasePaymentMode, string> = { CASH: 'نقدي', CREDIT: 'آجل' };

export const PAID_FROM_OPTIONS: readonly PurchasePaidFrom[] = ['MAIN_CASH', 'BANK', 'REP_CUSTODY'];
export const PAID_FROM_LABELS: Record<PurchasePaidFrom, string> = { MAIN_CASH: 'الصندوق الرئيسي', BANK: 'البنك', REP_CUSTODY: 'عهدة مندوب' };

/** أسباب تسوية المستودع — WAREHOUSE_ADJUST_REASONS في الخادم بترتيبها */
export const WAREHOUSE_ADJUST_REASONS: readonly WarehouseAdjustReason[] = ['COUNT', 'DAMAGE', 'EXPIRY', 'SAMPLE', 'OTHER'];
export const ADJUST_REASON_LABELS: Record<WarehouseAdjustReason, string> = {
  COUNT: 'جرد', DAMAGE: 'تالف', EXPIRY: 'منتهي الصلاحية', SAMPLE: 'عينات', OTHER: 'أخرى',
};
/** أسباب تسوية سيارة المندوب — VAN_ADJUST_REASONS في الخادم (SHORTAGE_REP عجزٌ يُحمَّل على المندوب) */
export const VAN_ADJUST_REASONS = ['COUNT', 'DAMAGE', 'EXPIRY', 'SHORTAGE_REP', 'SAMPLE', 'OTHER'] as const;
export type VanAdjustReason = (typeof VAN_ADJUST_REASONS)[number];
/** إتلاف تشغيلةٍ منتهية لم تُبع في السيارة (تسوية نقص بوسم EXPIRED_UNSOLD_DESTROY) سببه «منتهي الصلاحية» */
export const VAN_DESTROY_REASON: VanAdjustReason = 'EXPIRY';

/** وسم سببٍ محفوظ — سببٌ لا تعرفه الواجهة (أو غائب) ⇒ null فلا يُعرض شيء */
export function adjustReasonLabel(r: string | null | undefined): string | null {
  return r && (WAREHOUSE_ADJUST_REASONS as readonly string[]).includes(r) ? ADJUST_REASON_LABELS[r as WarehouseAdjustReason] : null;
}

// ═══ قراءة الخانات ═══

/** خانة سعرٍ موجب: فارغة أو غير رقم أو ≤ 0 ⇒ null «بلا سعر» — قاعدة الحفظ القائمة نفسها (الصفر ليس سعراً) */
export function parsePositive(s: string | number | null | undefined): number | null {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** نسبة ضريبة السطر ٠..١٠٠ — فارغة أو خارج المدى ⇒ null (غير صالحة) */
export function parseTaxPct(s: string | number | null | undefined): number | null {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/** يوم 'YYYY-MM-DD' صالحٌ تقويمياً (كـparseDay في الخادم) */
export function isValidDay(s: string | null | undefined): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** يوم التاريخ من قيمة الخادم (@db.Date يصل '2026-11-13T00:00:00.000Z' أو '2026-11-13') — null لغيره */
export function dayOf(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const d = v.slice(0, 10);
  return isValidDay(d) ? d : null;
}

// ═══ الحساب (مرآة الخادم) ═══

/** مرآة warehouseCost.netUnitCost: الصافي من المكتوب (شاملاً أو صافياً) بأربع منازل */
export function netUnitCost(entered: number, taxPct: number, inclusive: boolean): number {
  if (!Number.isFinite(entered) || entered < 0) return 0;
  const pct = Number.isFinite(taxPct) && taxPct > 0 ? taxPct : 0;
  const net = inclusive && pct > 0 ? entered / (1 + pct / 100) : entered;
  return roundHalfUp(net, COST_DECIMALS);
}

export interface BillLine {
  /** الكمية بوحدة السطر (تُؤخذ مطلقةً: المرتجع يمرّر سطوره موجبة أو سالبة سواء) */
  qty: number;
  /** سعر الوحدة صافياً قبل الضريبة */
  unitCost: number;
  /** نسبة ضريبة السطر ٪ */
  taxPct: number;
}
export interface BillTotals { net: number; tax: number; total: number }

/** معاملة ضريبة الوارد (vatTreatment) — null/غائبة ⇒ RECOVERABLE كما يفترض الخادم */
export type VatTreatment = WarehouseVatTreatment;

/** إجماليات بالملّي (أعداد صحيحة) — الحساب الداخلي كلّه بها، والعرض ÷ ١٠٠٠ */
interface MilliTotals { net: number; tax: number }
const fromMilli = (m: MilliTotals): BillTotals => ({ net: m.net / 1000, tax: m.tax / 1000, total: (m.net + m.tax) / 1000 });
/** مبلغٌ من ردّ الخادم (milliToNumber: ملّي ÷ ١٠٠٠) ⇐ ملّيه بقيمته المطلقة (المرتجع قد يصل بإشارته) — غير الرقم صفر */
const milliOfAmount = (x: number | null | undefined) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(Math.abs(x) * 1000) : 0);

const clampDecimals = (d: number) => (Number.isInteger(d) && d >= 0 && d <= 3 ? d : 2);
/** مبلغ ⇐ ملّي صحيح مقرَّب نصف-لأعلى إلى منازل العملة (toMilliAmount في الخادم) */
const toMilli = (x: number, decimals: number) => Math.round(roundHalfUp(x, decimals) * 1000);

/** مرآة computeBillTotals بالملّي (dec مقيَّدة مسبقاً) */
function billMilli(lines: readonly BillLine[], dec: number, noTax: boolean): MilliTotals {
  let net = 0;
  const byRate = new Map<number, number>();
  for (const l of lines) {
    const qty = Math.abs(l.qty);
    if (!Number.isFinite(qty) || !Number.isFinite(l.unitCost) || l.unitCost < 0) continue;
    const lineNet = qty * l.unitCost;
    net += lineNet;
    const pct = noTax ? 0 : Math.max(0, Number.isFinite(l.taxPct) ? l.taxPct : 0);
    if (pct > 0) byRate.set(pct, (byRate.get(pct) ?? 0) + lineNet);
  }
  const netM = toMilli(net, dec);
  let taxM = 0;
  for (const [pct, base] of byRate) taxM += toMilli((base * pct) / 100, dec);
  return { net: netM, tax: taxM };
}

/**
 * مرآة computeBillTotals (أسطرٌ صافية). `noTax` = vatTreatment NONE (أو «إزالة الضريبة») ⇒ ضريبة صفر.
 * سطرٌ غير صالح (كمية أو تكلفة ليست رقماً، أو تكلفة سالبة) يُتجاوز هنا — الخادم يرفضه، والنموذج يمنع الحفظ قبله.
 * المعاينات لا تستدعيها مباشرة: entryBillTotals (أدناه) هي ما يكتب به الخادم فاتورة المورّد، وهذه جزؤها للأسعار غير الشاملة.
 */
export function billTotals(lines: readonly BillLine[], decimals: number, noTax = false): BillTotals {
  return fromMilli(billMilli(lines, clampDecimals(decimals), noTax));
}

/** سطرٌ كما يدخل إجماليات المستند (BillCostLine في الخادم): الكمية بإشارتها أيّاً كانت، والتكلفة المخزَّنة، والسعر المُدخل، والنسبة */
export interface BillCostLine {
  qty: number;
  /** تكلفة المخزون المخزَّنة (unitCost) — تُستعمل وحدها لسطرٍ بلا سعرٍ مُدخل (سبق الميزة: صافية دائماً) */
  unitCost: number | null;
  /** السعر كما أُدخل (شاملاً أو صافياً بحسب costsIncludeTax) — به تُحسب الفاتورة متى وُجد */
  enteredUnitCost?: number | null;
  taxPct?: number | null;
}
export interface BillCostOpts {
  /** «الأسعار المدخلة شاملة الضريبة» للمستند */
  costsIncludeTax: boolean;
  vatTreatment: VatTreatment | null | undefined;
  decimals: number;
}

/** مرآة entryBillTotals بالملّي — السطر غير الصالح يُتجاوز (الخادم يرميه، والنموذج يمنع الحفظ قبله) */
function entryBillMilli(lines: readonly BillCostLine[], opts: BillCostOpts): MilliTotals {
  const dec = clampDecimals(opts.decimals);
  const vt = opts.vatTreatment ?? 'RECOVERABLE';
  const pctOf = (l: BillCostLine) => (vt === 'NONE' ? 0 : Math.max(0, Number.isFinite(l.taxPct ?? NaN) ? (l.taxPct as number) : 0));
  const exclusive: BillLine[] = [];
  const grossByRate = new Map<number, number>();
  for (const l of lines) {
    const qty = Math.abs(l.qty);
    if (!Number.isFinite(qty)) continue;
    const entered = l.enteredUnitCost;
    if (entered != null && opts.costsIncludeTax) {
      if (!Number.isFinite(entered) || entered < 0) continue;
      const pct = pctOf(l);
      grossByRate.set(pct, (grossByRate.get(pct) ?? 0) + qty * entered);
      continue;
    }
    const net = entered != null ? entered : l.unitCost;
    if (net == null) continue;
    exclusive.push({ qty, unitCost: net, taxPct: pctOf(l) });
  }
  const ex = billMilli(exclusive, dec, vt === 'NONE');
  let net = ex.net;
  let tax = ex.tax;
  for (const [pct, gross] of grossByRate) {
    const total = toMilli(gross, dec);
    const n = pct > 0 ? toMilli(gross / (1 + pct / 100), dec) : total;
    net += n;
    tax += total - n;
  }
  return { net, tax };
}

/**
 * مرآة warehouseBills.entryBillTotals — إجماليات فاتورة المورّد كما يكتبها الخادم (الوارد المصنَّف، والتصنيف، والمرتجع الجزئي):
 *   - سطرٌ بسعرٍ مُدخل والأسعار شاملة ⇒ يُجمع شاملُه لكل نسبة ثم يُفصل: الإجمالي = تقريب Σ الشامل، والصافي = تقريب (Σ الشامل ÷
 *     (١+النسبة))، والضريبة = الفرق — فيطابق الإجمالي فاتورة المورّد الشاملة حرفياً.
 *   - وغيره ⇒ computeBillTotals على الصافي: السعر المُدخل كما هو (بلا تقريبٍ لأربع منازل)، وإلا التكلفة المخزَّنة.
 * vatTreatment NONE ⇒ ضريبة صفر. والكميات بقيمتها المطلقة.
 */
export function entryBillTotals(lines: readonly BillCostLine[], opts: BillCostOpts): BillTotals {
  return fromMilli(entryBillMilli(lines, opts));
}

/** مرآة residualTotals: متبقّي الفاتورة بعد مرتجعاتها السابقة — كلٌّ من الصافي والضريبة على حدة، ولا يقلّ عن صفر */
function residualMilli(bill: MilliTotals, prior: readonly MilliTotals[]): MilliTotals {
  let n = bill.net;
  let t = bill.tax;
  for (const p of prior) { n -= p.net; t -= p.tax; }
  return { net: Math.max(0, n), tax: Math.max(0, t) };
}

/** مرآة capTotals: مرتجعٌ جزئي لا يتجاوز المتبقّي بتقريبه (صافياً وضريبةً) */
const capMilli = (t: MilliTotals, cap: MilliTotals): MilliTotals => ({ net: Math.min(t.net, cap.net), tax: Math.min(t.tax, cap.tax) });

/** استحقاق الآجل = تاريخ الفاتورة + مدة سداد المورّد (computeDueDate في الخادم؛ بلا مدة ⇒ يومها) — null لتاريخٍ غير صالح */
export function dueDateOf(billDay: string, paymentDays: number | null | undefined): string | null {
  if (!isValidDay(billDay)) return null;
  const days = Number.isInteger(paymentDays) && (paymentDays as number) > 0 ? (paymentDays as number) : 0;
  return new Date(new Date(`${billDay}T00:00:00.000Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

// ═══ مسودة الشراء في نموذج الاستلام ═══

export interface PurchaseDraft {
  /** null = وارد غير مصنَّف كما كان */
  mode: PurchasePaymentMode | null;
  paidFrom: PurchasePaidFrom;
  paidFromRepId: string;
  supplierRef: string;
  billDate: string;
}
export const emptyPurchaseDraft = (today: string): PurchaseDraft => ({ mode: null, paidFrom: 'MAIN_CASH', paidFromRepId: '', supplierRef: '', billDate: today });

export type PurchaseProblem = 'VENDOR_REQUIRED' | 'REP_REQUIRED' | 'SUPPLIER_REF_TOO_LONG' | 'BILL_DATE_INVALID' | 'PRICE_REQUIRED' | 'TAX_INVALID';
export const PURCHASE_PROBLEM_TEXT: Record<PurchaseProblem, string> = {
  VENDOR_REQUIRED: 'اختر المورد للشراء النقدي أو الآجل',
  REP_REQUIRED: 'اختر المندوب الذي دفع من عهدته',
  SUPPLIER_REF_TOO_LONG: 'رقم فاتورة المورد أطول من 60 حرفا',
  BILL_DATE_INVALID: 'تاريخ فاتورة المورد غير صالح',
  PRICE_REQUIRED: 'سعر الوحدة مطلوب لكل صنف في الشراء النقدي أو الآجل',
  TAX_INVALID: 'نسبة الضريبة بين 0 و100',
};

/**
 * ما يمنع حفظ الشراء المصنَّف (أول مشكلة) — بلا نوع شراء لا شيء (السلوك القديم). `lines` خانات السطور كما كُتبت؛
 * والنسبة لا تُفحص مع «إزالة الضريبة» (لا خانة لها، والمرسَل صفر)
 */
export function purchaseProblem(
  d: PurchaseDraft, vendorId: string | null | undefined, lines: readonly { unitCost: string; taxPct: string }[], opts: { taxOff: boolean },
): PurchaseProblem | null {
  if (!d.mode) return null;
  if (!vendorId) return 'VENDOR_REQUIRED';
  if (d.mode === 'CASH' && d.paidFrom === 'REP_CUSTODY' && !d.paidFromRepId) return 'REP_REQUIRED';
  if (d.supplierRef.trim().length > SUPPLIER_REF_MAX) return 'SUPPLIER_REF_TOO_LONG';
  if (d.billDate && !isValidDay(d.billDate)) return 'BILL_DATE_INVALID';
  if (lines.some(l => parsePositive(l.unitCost) == null)) return 'PRICE_REQUIRED';
  if (!opts.taxOff && lines.some(l => parseTaxPct(l.taxPct) == null)) return 'TAX_INVALID';
  return null;
}

/** نسبة السطر المرسَلة: صفرٌ مع «إزالة الضريبة» (المكتوب هو التكلفة فلا ضريبة تُحسب عليه)، وإلا ما كُتب */
export function lineTaxPct(s: string, taxOff: boolean): number {
  return taxOff ? 0 : (parseTaxPct(s) ?? 0);
}

/**
 * حقول الشراء في جسم الإنشاء — بلا نوع شراء {} فالجسم كما كان حرفاً. vendorId يُضاف خارجها (يُرسل للوارد غير المصنَّف أيضاً).
 * «إزالة الضريبة» ⇒ vatTreatment NONE صراحةً مع نسب الأسطر صفراً: الإجمالي ما كُتب، لا ضريبةٌ مضافة على تكلفةٍ مدفوعة
 */
export function purchaseBodyFields(d: PurchaseDraft, opts: { taxOff: boolean }): WarehousePurchaseFields {
  if (!d.mode) return {};
  const ref = d.supplierRef.trim();
  return {
    paymentMode: d.mode,
    ...(d.mode === 'CASH' && { paidFrom: d.paidFrom }),
    ...(d.mode === 'CASH' && d.paidFrom === 'REP_CUSTODY' && d.paidFromRepId && { paidFromRepId: d.paidFromRepId }),
    ...(ref && { supplierRef: ref.slice(0, SUPPLIER_REF_MAX) }),
    ...(isValidDay(d.billDate) && { billDate: d.billDate }),
    ...(opts.taxOff && { vatTreatment: 'NONE' as const }),
  };
}

/**
 * أسطر النموذج كما يكتبها الخادم (purchaseLineCols): السعر كما كُتب (enteredUnitCost) ونسبة السطر المرسَلة، والتكلفة المخزَّنة
 * للعرض (الصافي بأربع منازل — لا تدخل الإجمالي ما دام السعر المُدخل موجوداً). السطر بلا سعرٍ صالح أو بكمية غير موجبة خارجها
 */
export function draftBillLines(
  rows: readonly { qty: string; unitCost: string; taxPct: string }[], opts: { inclusive: boolean; taxOff: boolean },
): BillCostLine[] {
  const out: BillCostLine[] = [];
  for (const r of rows) {
    const q = Number(r.qty);
    const c = parsePositive(r.unitCost);
    if (!Number.isFinite(q) || q <= 0 || c == null) continue;
    const pct = lineTaxPct(r.taxPct, opts.taxOff);
    out.push({ qty: q, unitCost: netUnitCost(c, pct, opts.inclusive && !opts.taxOff), enteredUnitCost: c, taxPct: pct });
  }
  return out;
}

/** خيارات فاتورة الوارد الجديد كما يحلّها الخادم من جسم النموذج: «إزالة الضريبة» ⇒ NONE (والجسم يرسلها)، وإلا الافتراض RECOVERABLE */
export function draftBillOpts(opts: { inclusive: boolean; taxOff: boolean }, decimals: number): BillCostOpts {
  return { costsIncludeTax: opts.inclusive && !opts.taxOff, vatTreatment: opts.taxOff ? 'NONE' : 'RECOVERABLE', decimals };
}

/**
 * ملخّص الوارد المصنَّف قبل الحفظ = ما يكتبه الخادم في قيد BILL وسند الصرف الآلي (purchaseEntryCols ⇐ entryBillTotals) —
 * فـ«يصرف كامل المبلغ» في النقدي هو مبلغ السند حرفياً
 */
export function draftBillTotals(
  rows: readonly { qty: string; unitCost: string; taxPct: string }[], opts: { inclusive: boolean; taxOff: boolean }, decimals: number,
): BillTotals {
  return entryBillTotals(draftBillLines(rows, opts), draftBillOpts(opts, decimals));
}

// ═══ مصدر الدفع المحفوظ ═══

/** WarehouseEntry.paidAccountRef ⇐ MAIN_CASH | BANK | REP_CUSTODY:<salesRepId> (parsePaidAccountRef في الخادم) */
export function paidFromOf(ref: string | null | undefined): { kind: PurchasePaidFrom; repId?: string } | null {
  if (!ref) return null;
  if (ref === 'MAIN_CASH' || ref === 'BANK') return { kind: ref };
  const m = /^REP_CUSTODY:(.+)$/.exec(ref);
  return m ? { kind: 'REP_CUSTODY', repId: m[1] } : null;
}

// ═══ رسائل الخادم بالرمز ═══

/** نصوص رموز الخادم بالعربية (تمرّ بـtr في الواجهة) — رمزٌ غير معروف ⇒ رسالة الخادم نفسها */
export const PURCHASE_ERROR_TEXT: Record<string, string> = {
  PURCHASE_VENDOR_REQUIRED: 'اختر المورد للشراء النقدي أو الآجل',
  PURCHASE_PRICE_REQUIRED: 'سعر الوحدة مطلوب لكل صنف في الشراء النقدي أو الآجل',
  ENTRY_ALREADY_CLASSIFIED: 'هذه الحركة صنفت من قبل',
  RETURN_EXCEEDS_RECEIVED: 'كمية المرتجع أكبر من المتبقي من الوارد',
  BILL_HAS_PAYMENTS: 'على هذه الفاتورة دفعات سارية ألغ سندات الصرف المخصصة لها أولا',
  SUPPLIER_CODE_EXISTS: 'رمز المورد مستعمل لمورد آخر',
  SUPPLIER_VAT_EXISTS: 'الرقم الضريبي مسجل لمورد آخر',
};

export function serverCodeOf(e: unknown): string | null {
  const c = (e as { response?: { data?: { code?: unknown } } } | null | undefined)?.response?.data?.code;
  return typeof c === 'string' && c ? c : null;
}

/** نصّ الخطأ للعرض (قبل tr): نصّ الرمز المعروف، وإلا رسالة الخادم، وإلا null */
export function purchaseErrorText(e: unknown): string | null {
  const code = serverCodeOf(e);
  if (code && PURCHASE_ERROR_TEXT[code]) return PURCHASE_ERROR_TEXT[code];
  const m = (e as { response?: { data?: { message?: unknown } } } | null | undefined)?.response?.data?.message;
  return typeof m === 'string' && m ? m : null;
}

// ═══ المرتجع والإلغاء ═══

export interface ReturnSourceItem {
  id: string;
  productId?: string | null;
  qty: number;
  unitFactor?: number | null;
  baseQty?: number | null;
  lot?: { lotNumber?: string | null } | null;
  /** المتبقّي بوحدة السطر إن أرسله الخادم — يُقدَّم على الحساب من السجلّ */
  remainingQty?: number | null;
}
export interface ReturnSourceEntry {
  id: string;
  type: string;
  returnOfEntryId?: string | null;
  /** حركة المرتجع الملغاة لا تُحسب (الخادم يستثنيها من المتبقّي) */
  status?: string | null;
  items: readonly ReturnSourceItem[];
}

/** صفوف السجلّ مدموجةً بلا تكرار (بالمعرّف، الأول يغلب) — السجلّ المعروض ومرتجعات المورّد المجلوبة لمعاينة المرتجع */
export function mergeEntries<E extends { id: string }>(...lists: readonly (readonly E[] | null | undefined)[]): E[] {
  const seen = new Set<string>();
  const out: E[] = [];
  for (const list of lists) {
    for (const e of list ?? []) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
  }
  return out;
}

/** حركات المرتجع السارية التابعة لهذا الوارد في الصفوف */
const priorReturnsOf = <E extends ReturnSourceEntry>(entryId: string, all: readonly E[]): E[] =>
  all.filter(r => r.type === 'RETURN' && r.returnOfEntryId === entryId && r.status !== 'CANCELLED');

const factorOf = (it: ReturnSourceItem) => (typeof it.unitFactor === 'number' && it.unitFactor > 0 ? it.unitFactor : 1);
const baseOf = (it: ReturnSourceItem) => Math.abs(typeof it.baseQty === 'number' && Number.isFinite(it.baseQty) ? it.baseQty : it.qty * factorOf(it));
const lineKey = (it: ReturnSourceItem) => `${it.productId ?? ''}|${it.lot?.lotNumber ?? ''}`;
const round4 = (n: number) => roundHalfUp(n, 4);

/**
 * المتبقّي القابل للإرجاع من كل سطرٍ في الوارد (بوحدة السطر): كميته − ما في حركات RETURN التابعة له (returnOfEntryId)
 * للصنف والتشغيلة نفسيهما، يُوزَّع على أسطره بترتيبها — بالأساس ثم يُعاد إلى وحدة السطر. السجلّ آخر ١٠٠ حركة فقد يغيب
 * مرتجعٌ قديم؛ لذا يُقدَّم remainingQty من الخادم متى وصل، والخادم هو الحَكَم (409 RETURN_EXCEEDS_RECEIVED)
 */
export function remainingByItem(entry: ReturnSourceEntry, all: readonly ReturnSourceEntry[]): Map<string, number> {
  if (entry.items.length && entry.items.every(i => typeof i.remainingQty === 'number' && Number.isFinite(i.remainingQty))) {
    return new Map(entry.items.map(i => [i.id, Math.max(0, round4(i.remainingQty as number))]));
  }
  const pool = new Map<string, number>();
  for (const r of priorReturnsOf(entry.id, all)) {
    for (const it of r.items) pool.set(lineKey(it), (pool.get(lineKey(it)) ?? 0) + baseOf(it));
  }
  const out = new Map<string, number>();
  for (const it of entry.items) {
    const base = baseOf(it);
    const k = lineKey(it);
    const avail = pool.get(k) ?? 0;
    const used = Math.min(avail, base);
    pool.set(k, avail - used);
    out.set(it.id, Math.max(0, round4((base - used) / factorOf(it))));
  }
  return out;
}

/** هل لهذا الوارد حركة مرتجع في السجلّ؟ */
export function hasReturns(entryId: string, all: readonly { type: string; returnOfEntryId?: string | null }[]): boolean {
  return all.some(r => r.type === 'RETURN' && r.returnOfEntryId === entryId);
}

export interface ActionEntry {
  type: string;
  status?: string | null;
  source?: string | null;
  paymentMode?: string | null;
  zeroRunId?: string | null;
}

/**
 * أفعال الصفّ في السجلّ: «تصنيف» لوارد غير مصنَّف، و«مرتجع للمورّد» لمصنَّف بقي منه شيء، و«إلغاء الحركة» لوارد سارٍ.
 * خادمٌ أقدم لا يرسل status ⇒ لا فعل (المسارات غير موجودة). والافتتاحي المستورد ليس شراءً (له تراجع الاستيراد)
 */
export function entryActions(e: ActionEntry, opts: { canEdit: boolean; anyRemaining: boolean }): { classify: boolean; ret: boolean; cancel: boolean } {
  const none = { classify: false, ret: false, cancel: false };
  if (!opts.canEdit || e.status == null || e.type !== 'RECEIVE' || e.status === 'CANCELLED' || e.zeroRunId) return none;
  if (e.source === 'OPENING_IMPORT') return none;
  const classified = e.paymentMode === 'CASH' || e.paymentMode === 'CREDIT';
  return { classify: !classified, ret: classified && opts.anyRemaining, cancel: true };
}

/** فلتر السجلّ على الصفوف (يكرّر فلتر الخادم فيصحّ ولو تجاهله خادمٌ أقدم) */
export function filterEntries<E extends { type: string; vendorId?: string | null }>(
  rows: readonly E[], f: { type?: string | null; vendorId?: string | null },
): E[] {
  return rows.filter(e => (!f.type || e.type === f.type) && (!f.vendorId || e.vendorId === f.vendorId));
}

// ═══ أجسام التصنيف والمرتجع ═══

export interface ClassifyPriceDraft { itemId: string; unitCost: string; taxPct: string }

/** أسعار التصنيف المرسَلة: ما كُتب بسعرٍ موجب وحده، والنسبة صفرٌ مع «إزالة الضريبة» — يقرؤها الجسم والمعاينة معاً */
function classifyPrices(prices: readonly ClassifyPriceDraft[], taxOff: boolean): { itemId: string; unitCost: number; taxPct: number }[] {
  return prices.flatMap(p => {
    const c = parsePositive(p.unitCost);
    return c == null ? [] : [{ itemId: p.itemId, unitCost: c, taxPct: lineTaxPct(p.taxPct, taxOff) }];
  });
}

/** جسم التصنيف: الأسعار للأسطر غير المسعَّرة وحدها (ما كُتب فيها)، والنسبة صفرٌ مع «إزالة الضريبة» */
export function classifyBody(args: {
  vendorId: string; draft: PurchaseDraft & { mode: PurchasePaymentMode }; costsIncludeTax: boolean; taxOff: boolean; prices: readonly ClassifyPriceDraft[];
}): WarehouseClassifyBody {
  const f = purchaseBodyFields(args.draft, { taxOff: args.taxOff });
  const prices = classifyPrices(args.prices, args.taxOff);
  return {
    vendorId: args.vendorId,
    paymentMode: args.draft.mode,
    ...(f.paidFrom && { paidFrom: f.paidFrom }),
    ...(f.paidFromRepId && { paidFromRepId: f.paidFromRepId }),
    ...(f.supplierRef && { supplierRef: f.supplierRef }),
    ...(f.billDate && { billDate: f.billDate }),
    ...(prices.length > 0 && { costsIncludeTax: !args.taxOff && args.costsIncludeTax }),
    ...(f.vatTreatment && { vatTreatment: f.vatTreatment }),
    ...(prices.length > 0 && { prices }),
  };
}

/** سطر الوارد كما يلزم معاينة التصنيف والمرتجع (من GET /warehouse/entries) */
export interface BillSourceItem {
  id: string;
  productId?: string | null;
  qty: number;
  /** تكلفة المخزون المخزَّنة — null لسطرٍ غير مسعَّر */
  unitCost: number | null;
  /** السعر كما أُدخل — null لسطرٍ سبق الميزة (تكلفته صافية) */
  enteredUnitCost?: number | null;
  taxPct?: number | null;
}

/**
 * معاملة الضريبة في التصنيف كما يحلّها الخادم (classifyEntryTx ⇐ resolveEntryPurchase): الجسم يرسل NONE مع «إزالة الضريبة» وحدها،
 * وإلا المحفوظة على الحركة (وارد الربط البرمجي قد يحمل «غير مستردة» أو «بلا ضريبة»)، وإلا الافتراض RECOVERABLE
 */
export function classifyVatTreatment(saved: VatTreatment | null | undefined, taxOff: boolean): VatTreatment {
  return taxOff ? 'NONE' : saved ?? 'RECOVERABLE';
}

/**
 * «شاملة الضريبة» مقيَّدة بالحركة: سطرٌ مسعَّر بسعرٍ مُدخل ⇒ تُدخل الأسعار الجديدة بالطريقة نفسها (وإلا رفض الخادم PURCHASE_INVALID:
 * «أسعار الوارد القائمة شاملة/غير شاملة») — فالخانة تُعرض بقيمة الحركة ولا تُغيَّر
 */
export function classifyInclusiveLocked(items: readonly Pick<BillSourceItem, 'unitCost' | 'enteredUnitCost'>[]): boolean {
  return items.some(i => i.unitCost != null && i.enteredUnitCost != null);
}

/**
 * ملخّص التصنيف = classifyEntryTx في الخادم: السطر المسعَّر بسعره المُدخل (وإلا تكلفته المخزَّنة) ونسبته المحفوظة أو نسبة صنفه،
 * والناقص بالسعر المكتوب ونسبته المكتوبة — و«شاملة الضريبة» المرسلة مع الأسعار، وإلا المحفوظة على الحركة (الخادم يأخذها حين
 * لا تُرسل). السطر الناقص بلا سعرٍ مكتوب خارج الملخّص (purchaseProblem يمنع الحفظ)
 */
export function classifyPreview(args: {
  items: readonly BillSourceItem[];
  saved: { costsIncludeTax?: boolean | null; vatTreatment?: VatTreatment | null };
  prices: readonly ClassifyPriceDraft[];
  inclusive: boolean;
  taxOff: boolean;
  productPct: (productId?: string) => number;
  decimals: number;
}): { lines: BillCostLine[]; totals: BillTotals } {
  const sent = classifyPrices(args.prices, args.taxOff);
  const costsIncludeTax = sent.length > 0 ? !args.taxOff && args.inclusive : !!args.saved.costsIncludeTax;
  const vatTreatment = classifyVatTreatment(args.saved.vatTreatment, args.taxOff);
  const byItem = new Map<string, { unitCost: number; taxPct: number }>();
  for (const p of sent) if (!byItem.has(p.itemId)) byItem.set(p.itemId, p);
  const lines: BillCostLine[] = [];
  for (const i of args.items) {
    // الخادم: السعر للسطر غير المسعَّر وحده (المسعَّر لا يتغيّر سعره ولو أُرسل له سعر)
    const price = i.unitCost == null ? byItem.get(i.id) : undefined;
    const pct = vatTreatment === 'NONE' ? 0 : price?.taxPct ?? i.taxPct ?? args.productPct(i.productId ?? undefined);
    if (price) lines.push({ qty: i.qty, unitCost: netUnitCost(price.unitCost, pct, costsIncludeTax), enteredUnitCost: price.unitCost, taxPct: pct });
    else if (i.unitCost != null) lines.push({ qty: i.qty, unitCost: i.unitCost, enteredUnitCost: i.enteredUnitCost ?? null, taxPct: pct });
  }
  return { lines, totals: entryBillTotals(lines, { costsIncludeTax, vatTreatment, decimals: args.decimals }) };
}

export type ReturnProblem = 'NOTHING' | 'QTY_INVALID' | 'OVER_REMAINING' | 'SUPPLIER_REF_TOO_LONG' | 'BILL_DATE_INVALID';
export const RETURN_PROBLEM_TEXT: Record<ReturnProblem, string> = {
  NOTHING: 'اكتب كمية مرتجع لصنف واحد على الأقل',
  QTY_INVALID: 'كمية المرتجع غير صالحة',
  OVER_REMAINING: 'كمية المرتجع أكبر من المتبقي من الوارد',
  SUPPLIER_REF_TOO_LONG: 'رقم فاتورة المورد أطول من 60 حرفا',
  BILL_DATE_INVALID: 'تاريخ فاتورة المورد غير صالح',
};

/** مشكلة المرتجع: كمياتٌ موجبة لا تتجاوز المتبقّي، وسطرٌ واحد على الأقل */
export function returnProblem(
  qtys: ReadonlyMap<string, string>, remaining: ReadonlyMap<string, number>, opts: { supplierRef: string; billDate: string },
): ReturnProblem | null {
  let any = false;
  for (const [id, s] of qtys) {
    if (!s.trim()) continue;
    const q = Number(s);
    if (!Number.isFinite(q) || q < 0) return 'QTY_INVALID';
    if (q === 0) continue;
    any = true;
    if (q > (remaining.get(id) ?? 0) + 1e-9) return 'OVER_REMAINING';
  }
  if (!any) return 'NOTHING';
  if (opts.supplierRef.trim().length > SUPPLIER_REF_MAX) return 'SUPPLIER_REF_TOO_LONG';
  if (opts.billDate && !isValidDay(opts.billDate)) return 'BILL_DATE_INVALID';
  return null;
}

export function returnBody(args: {
  qtys: ReadonlyMap<string, string>; note: string; supplierRef: string; billDate: string;
  refundMode: 'CREDIT' | 'CASH'; refundTo: 'MAIN_CASH' | 'BANK';
}): WarehouseReturnBody {
  const items: { itemId: string; qty: number }[] = [];
  for (const [itemId, s] of args.qtys) {
    const q = Number(s);
    if (s.trim() && Number.isFinite(q) && q > 0) items.push({ itemId, qty: q });
  }
  const note = args.note.trim();
  const ref = args.supplierRef.trim();
  return {
    items,
    ...(note && { note: note.slice(0, 300) }),
    ...(ref && { supplierRef: ref.slice(0, SUPPLIER_REF_MAX) }),
    ...(isValidDay(args.billDate) && { billDate: args.billDate }),
    refundMode: args.refundMode,
    ...(args.refundMode === 'CASH' && { refundTo: args.refundTo }),
  };
}

/** الوارد المصنَّف كما يلزم معاينة مرتجعه: أسطره بأسعارها المُدخلة، و«شاملة الضريبة» ومعاملة الضريبة وإجماليات فاتورته */
export interface ReturnBillEntry extends ReturnSourceEntry {
  items: readonly (ReturnSourceItem & BillSourceItem)[];
  costsIncludeTax?: boolean | null;
  vatTreatment?: VatTreatment | null;
  net?: number | null;
  tax?: number | null;
  total?: number | null;
}
/** صفّ السجلّ كما يلزم المرتجعات السابقة: إجمالياتها (الخادم يخزّنها موجبة، وتُؤخذ مطلقةً احتياطاً) */
export type ReturnBillRow = ReturnSourceEntry & { net?: number | null; tax?: number | null };

const QTY_EPS = 1e-9;

/**
 * معاينة «مرتجع للمورد» = reverseEntryTx في الخادم:
 *   - الأسطر: الكمية المكتوبة لكل سطر بسعره **المُدخل** ونسبته و«شاملة الضريبة» ومعاملة ضريبة الوارد نفسه — لا تكلفة المخزون
 *     (في «غير مستردة» تشمل الضريبة فكانت تُضاف مرّتين: وحدة بسعر ١٠٠ تُرى 132.25 والخادم يقيّد 115).
 *   - المتبقّي من الفاتورة = إجمالياتها − المرتجعات السابقة السارية (residualTotals)، والمرتجع الذي يستنفد ما بقي من كل سطر يأخذه
 *     حرفياً، وغيره حسابه مقيَّداً به (capTotals) — فمرتجع كامل ألف وحدة بسعر ١٠ شاملاً يُرى 10,000.00 كما يُقيَّد.
 * `all` صفوف السجلّ (مع مرتجعات المورّد المجلوبة) — منها المرتجعات السابقة؛ خادمٌ أقدم بلا إجماليات للوارد ⇒ الحساب بلا قيد.
 * `lines` عدد الأسطر الداخلة (صفر ⇒ لا ملخّص).
 */
export function returnPreview(
  entry: ReturnBillEntry, all: readonly ReturnBillRow[], qtys: ReadonlyMap<string, string>, decimals: number,
): { lines: number; totals: BillTotals } {
  const remaining = remainingByItem(entry, all);
  const want = new Map<string, number>();
  const lines: BillCostLine[] = [];
  for (const i of entry.items) {
    const q = Number(qtys.get(i.id) ?? '');
    if (!Number.isFinite(q) || q <= 0) continue;
    if (i.unitCost == null && i.enteredUnitCost == null) continue;
    want.set(i.id, q);
    lines.push({ qty: q, unitCost: i.unitCost, enteredUnitCost: i.enteredUnitCost ?? null, taxPct: i.taxPct ?? null });
  }
  const opts: BillCostOpts = { costsIncludeTax: !!entry.costsIncludeTax, vatTreatment: entry.vatTreatment ?? 'RECOVERABLE', decimals };
  const computed = entryBillMilli(lines, opts);
  if (!lines.length || typeof entry.total !== 'number' || !Number.isFinite(entry.total)) return { lines: lines.length, totals: fromMilli(computed) };
  const residual = residualMilli(
    { net: milliOfAmount(entry.net), tax: milliOfAmount(entry.tax) },
    priorReturnsOf(entry.id, all).map(r => ({ net: milliOfAmount(r.net), tax: milliOfAmount(r.tax) })),
  );
  const exhausts = entry.items.every(i => Math.abs((remaining.get(i.id) ?? 0) - (want.get(i.id) ?? 0)) <= QTY_EPS);
  return { lines: lines.length, totals: fromMilli(exhausts ? residual : capMilli(computed, residual)) };
}
