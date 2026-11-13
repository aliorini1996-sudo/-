/**
 * فواتير المورّد على حركات المستودع («ربط الدفاتر» L1، طلب المالك ١٣ نوفمبر ٢٠٢٦): الشراء النقدي/الآجل في الوارد، وتصنيف الوارد
 * لاحقاً، ومرتجع المورّد الجزئي، وإلغاء الوارد بمرتجعٍ كامل. المسار routes/warehouse.ts رفيعٌ: يقرأ الطلب ويأخذ الأقفال، وكل الحساب
 * والكتابة هنا في معاملة المستدعي (دوالٌ تأخذ tx ولا تفتح معاملة).
 *
 * ═══ ما يُكتب ═══
 *   - على WarehouseEntry: المورّد ونوع الشراء ومصدر الدفع ورقم فاتورة المورّد وتاريخها واستحقاقها ومعاملة الضريبة والإجماليات بالملّي.
 *   - على كل سطر: نسبة ضريبته (taxPct) والسعر كما أُدخل (enteredUnitCost)، وunitCost تكلفة المخزون (انظر inventoryUnitCost).
 *   - كشف المورّد (supplier_ledger_entries): BILL للوارد المصنَّف، RETURN للمرتجع، REFUND_IN لما ردّه المورّد نقداً.
 *   - سند الصرف الآلي للنقدي عبر services/suppliers/payments.ts (createSupplierPaymentTx) — لا يُعاد بناؤه هنا.
 *   - **لا شيء في gl_***: gl_vendors يُقرأ وحده (الشرط المُلزِم لـL1؛ الدفاتر المربوطة تُبنى من هذه الصفوف في L6).
 *
 * ═══ الدقّة ═══
 *   الإجماليات بالملّي (BigInt) بقاعدة المستند: الصافي مقرَّب نصف-لأعلى، والضريبة لكل نسبة على مجموع صافي سطورها (computeBillTotals).
 *   والأسعار **الشاملة** تُجمع شاملةً ثم تُفصل لكل نسبة (entryBillTotals): الصافي المخزَّن بأربع منازل كان يجعل إجمالي ألف وحدة
 *   بسعر ١٠ شاملاً 10,000.05 لا 10,000 — فرقٌ عن فاتورة المورّد يكسر مطابقة كشفه.
 *   والمرتجع الذي يستنفد ما بقي من الفاتورة (والإلغاء) يأخذ **المتبقّي** (الفاتورة − ما سبق ردّه) لا حاصل ضربٍ جديد: فمجموع المرتجعات
 *   يساوي الفاتورة بالملّي ورصيد المورّد بعد الإلغاء صفرٌ حرفياً، والمرتجع الجزئي لا يتجاوز المتبقّي بتقريبه.
 */
import type { Prisma } from '@prisma/client';
import { netUnitCost } from '../warehouseCost';
import { tenantCurrencyDecimals } from '../warehouseStock';
import { unitFields } from '../units';
import { isTaxOff } from '../taxMode';
import { companyDay, type LotEventActor } from '../lotsDb';
import { planWarehouseEntryInTx, type LotLocks } from '../lotsWarehouse';
import type { LotActor, LotWarning } from '../lots';
import type { StockWarning } from '../stockLenient';
import {
  computeBillTotals,
  computeDueDate,
  dayString,
  formatPaidAccountRef,
  milliToNumber,
  parseDay,
  parsePaidAccountRef,
  paymentMethodOfPaidFrom,
  signedLedgerAmount,
  toMilliAmount,
  VAT_TREATMENTS,
  type BillTotals,
  type PaidFrom,
  type PurchasePaymentMode,
  type VatTreatment,
} from './core';
import { SupplierError, cancelSupplierPaymentTx, createSupplierPaymentTx, supplierPaymentDisplayNumber } from './payments';
import { loadBillSettlements, utcDay } from './statement';
import { CLIENT_REF_SCHEMA } from '../stockClientRef';
import { OPENING_STOCK_ENTRY_TYPE, OPENING_STOCK_KIND, OPENING_STOCK_NOTE, parseBatchRecordIds } from '../importLedger';

// ═══ الأخطاء والتحذيرات ═══

/** رموز هذه الوحدة وحالتها — تُرمى SupplierError (الصنف نفسه لمسارات الموردين) فيحوّلها المسار بـsupplierErrorBody */
export const WAREHOUSE_BILL_ERROR_STATUS = Object.freeze({
  PURCHASE_VENDOR_REQUIRED: 400,
  PURCHASE_PRICE_REQUIRED: 400,
  PURCHASE_INVALID: 400,
  ADJUST_REASON_INVALID: 400,
  RETURN_INVALID: 400,
  ENTRY_NOT_FOUND: 404,
  ENTRY_ALREADY_CLASSIFIED: 409,
  ENTRY_NOT_CLASSIFIABLE: 409,
  ENTRY_NOT_CLASSIFIED: 409,
  ENTRY_NOT_RETURNABLE: 409,
  ENTRY_ALREADY_CANCELLED: 409,
  RETURN_EXCEEDS_RECEIVED: 409,
  BILL_HAS_PAYMENTS: 409,
  /** مرجع المرتجع clientRef مستعملٌ لحركةٍ أخرى (وارد، أو مرتجع وارد آخر) — يولّد العميل مرجعاً لكل حفظ */
  CLIENT_REF_REUSED: 409,
} as const);
export type WarehouseBillErrorCode = keyof typeof WAREHOUSE_BILL_ERROR_STATUS;

const fail = (code: WarehouseBillErrorCode, message: string, detail?: Record<string, unknown>) =>
  new SupplierError(code, message, WAREHOUSE_BILL_ERROR_STATUS[code], detail);

/** تحذيرات «الربط لا يُرفض» لمفتاح API (والتنبيهات العامة) — في ردّ النجاح بجانب تحذيرات المخزون */
export const PURCHASE_WARNING = Object.freeze({
  /** الوارد حُفظ غير مصنَّف (paymentMode null) لنقص بيانات الشراء — الرسالة تذكر السبب */
  UNCLASSIFIED: 'PURCHASE_UNCLASSIFIED',
  /** حقلٌ غير صالح أُهمل أو قُصّ (تاريخ الفاتورة، رقمها، معاملة الضريبة، نسبة سطر) — والحركة كما هي */
  FIELD_ADJUSTED: 'PURCHASE_FIELD_ADJUSTED',
  /** بيانات شراء مع تسوية ADJUST: التسوية جردٌ أو تالف لا شراء */
  FIELDS_IGNORED: 'PURCHASE_FIELDS_IGNORED',
  /** سببٌ غير معروف لتسوية من مفتاح API: أُهمل والتسوية بلا سبب */
  ADJUST_REASON_IGNORED: 'ADJUST_REASON_IGNORED',
  /** الشركة بلا ضريبة فلا تُستردّ ضريبة مدخلات: «مستردة» صارت «بلا ضريبة» */
  VAT_TREATMENT_ADJUSTED: 'VAT_TREATMENT_ADJUSTED',
  /** سعرٌ في التصنيف لسطرٍ مسعَّر مسبقاً: لا يُغيَّر سعرٌ قائم */
  PRICE_IGNORED: 'PRICE_IGNORED_EXISTING',
} as const);

// ═══ سبب التسوية ═══

/**
 * سبب التسوية من قائمةٍ ثابتة: غائبٌ ⇒ null (كما كان). غير الصالح ⇒ للواجهة 400 ADJUST_REASON_INVALID، ولمفتاح API يُهمل بتحذير
 * ADJUST_REASON_IGNORED (لا تُرفض حركة مخزون بسبب وسمٍ وصفيّ).
 */
export function resolveAdjustReason<T extends string>(raw: unknown, allowed: readonly T[], isApi: boolean, warnings: StockWarning[]): T | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const v = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if ((allowed as readonly string[]).includes(v)) return v as T;
  if (!isApi) throw fail('ADJUST_REASON_INVALID', `سبب التسوية غير معروف — اختر من: ${allowed.join('، ')}`, { allowed: [...allowed] });
  warnings.push({ code: PURCHASE_WARNING.ADJUST_REASON_IGNORED, message: `سبب التسوية «${String(raw).slice(0, 40)}» غير معروف فأُهمل` });
  return null;
}

// ═══ الحساب الصرف ═══

/** تكلفة الأربع منازل (COST_DECIMALS في warehouseCost) — netUnitCost(x, 0, false) يقرّب بها وحدها */
const cost4 = (x: number): number => netUnitCost(x, 0, false);

/**
 * تكلفة المخزون لوحدة السطر من السعر المُدخل (WarehouseEntryItem.unitCost):
 *   - RECOVERABLE (الافتراضي) وNONE: الصافي — netUnitCost نفسها التي يستعملها الوارد القائم حرفياً (NONE نسبتها صفر فالصافي ما كُتب).
 *   - NON_RECOVERABLE: ضريبةٌ لا تُستردّ (مورّد بلا رقم ضريبي، أو الشركة بلا تسجيل) **تُرسمَل في التكلفة** (الخطة D9): الإجمالي
 *     الشامل — الشامل كما كُتب، والصافي × (١ + النسبة). وإلا قيّم المستودعُ البضاعةَ بأقلّ مما دُفع فيها فعلاً.
 */
export function inventoryUnitCost(entered: number, taxPct: number, costsIncludeTax: boolean, vatTreatment: VatTreatment): number {
  if (vatTreatment === 'NON_RECOVERABLE') {
    const pct = Number.isFinite(taxPct) && taxPct > 0 ? taxPct : 0;
    return cost4(costsIncludeTax ? entered : entered * (1 + pct / 100));
  }
  return netUnitCost(entered, vatTreatment === 'NONE' ? 0 : taxPct, costsIncludeTax);
}

/** سطرٌ كما يدخل حساب إجماليات الفاتورة: الكمية (بإشارتها أيّاً كانت) والتكلفة المخزَّنة والسعر المُدخل والنسبة */
export interface BillCostLine {
  qty: number;
  unitCost: number | null;
  enteredUnitCost?: number | null;
  taxPct?: number | null;
}

/**
 * إجماليات المستند (الصافي والضريبة والإجمالي بالملّي) من أسطره:
 *   - سطرٌ بسعرٍ مُدخل والأسعار شاملة ⇒ مجموعة «الشامل»: لكل نسبة يُجمع الشامل ثم يُفصل (الإجمالي = تقريب Σ الشامل، والصافي =
 *     تقريب Σ الشامل ÷ (١+النسبة)، والضريبة = الفرق) — فيطابق الإجمالي فاتورة المورّد الشاملة حرفياً.
 *   - وغيره ⇒ computeBillTotals على الصافي: المُدخل إن وُجد (الأسعار غير شاملة)، وإلا التكلفة المخزَّنة (سطرٌ سبق الميزة: صافية دائماً).
 * vatTreatment NONE ⇒ ضريبة صفر. الكميات بقيمتها المطلقة (المرتجع يمرّر سطوره بإشارتها).
 */
export function entryBillTotals(
  lines: readonly BillCostLine[],
  opts: { costsIncludeTax: boolean; vatTreatment: VatTreatment | null | undefined; decimals: number },
): BillTotals {
  const vt = opts.vatTreatment ?? 'RECOVERABLE';
  const pctOf = (l: BillCostLine) => (vt === 'NONE' ? 0 : Math.max(0, Number.isFinite(l.taxPct ?? NaN) ? (l.taxPct as number) : 0));
  const exclusive: { qty: number; unitCost: number; taxPct: number }[] = [];
  const grossByRate = new Map<number, number>();
  for (const l of lines) {
    const qty = Math.abs(l.qty);
    const entered = l.enteredUnitCost;
    if (entered != null && opts.costsIncludeTax) {
      if (!Number.isFinite(entered) || entered < 0 || !Number.isFinite(qty)) throw new RangeError('سطر فاتورة مورّد غير صالح');
      const pct = pctOf(l);
      grossByRate.set(pct, (grossByRate.get(pct) ?? 0) + qty * entered);
      continue;
    }
    const net = entered != null ? entered : l.unitCost;
    if (net == null) throw new RangeError('سطر فاتورة مورّد بلا سعر');
    exclusive.push({ qty, unitCost: net, taxPct: pctOf(l) });
  }
  const ex = computeBillTotals(exclusive, opts.decimals, vt);
  let net = ex.netMilli;
  let tax = ex.taxMilli;
  for (const [pct, gross] of grossByRate) {
    const total = toMilliAmount(gross, opts.decimals);
    const n = pct > 0 ? toMilliAmount(gross / (1 + pct / 100), opts.decimals) : total;
    net += n;
    tax += total - n;
  }
  return { netMilli: net, taxMilli: tax, totalMilli: net + tax };
}

const ZERO_TOTALS: BillTotals = { netMilli: 0n, taxMilli: 0n, totalMilli: 0n };

/** متبقّي الفاتورة بعد مرتجعاتها السابقة — كلٌّ من الصافي والضريبة والإجمالي على حدة، ولا يقلّ عن صفر */
export function residualTotals(bill: BillTotals, prior: readonly BillTotals[]): BillTotals {
  let n = bill.netMilli;
  let t = bill.taxMilli;
  for (const p of prior) { n -= p.netMilli; t -= p.taxMilli; }
  if (n < 0n) n = 0n;
  if (t < 0n) t = 0n;
  return { netMilli: n, taxMilli: t, totalMilli: n + t };
}

/** مرتجعٌ جزئي لا يتجاوز المتبقّي بتقريبه (صافياً وضريبةً) */
export function capTotals(t: BillTotals, cap: BillTotals): BillTotals {
  const n = t.netMilli > cap.netMilli ? cap.netMilli : t.netMilli;
  const x = t.taxMilli > cap.taxMilli ? cap.taxMilli : t.taxMilli;
  return { netMilli: n, taxMilli: x, totalMilli: n + x };
}

// ═══ المتبقّي من كل سطر (المرتجع لا يتجاوز ما ورد) ═══

/** سطر الوارد الأصلي كما يلزم الحساب */
export interface OrigLine {
  id: string;
  productId: string;
  qty: number;
  unitName: string | null;
  unitFactor: number;
  unitCost: number | null;
  taxPct: number | null;
  enteredUnitCost: number | null;
  lotId: string | null;
}

/** سطر مرتجعٍ سابق (كميته سالبة) */
export interface PriorReturnLine {
  productId: string;
  qty: number;
  unitName: string | null;
  unitFactor: number;
  unitCost: number | null;
  taxPct: number | null;
  enteredUnitCost: number | null;
  lotId: string | null;
}

const QTY_EPS = 1e-9;
const cleanQty = (x: number): number => Math.round(x * 1e6) / 1e6;

/**
 * مفتاح مطابقة سطر المرتجع بسطر أصله: الصنف ولقطة الوحدة والتكلفة والنسبة والسعر المُدخل — فالمرتجع ينسخها حرفياً من أصله.
 * اللوط ليس في المفتاح عمداً: المرتجع يُكتب بلوط الخطة (والميزة مطفأة أو الصنف غير متتبَّع ⇒ بلا لوط، كتسوية الإنقاص)، فلو كان
 * في المفتاح لما عُرف مرتجعٌ بلا لوط لسطرٍ له لوط فتجاوز المرتجعُ ما ورد. واللوط يُفضَّل في التوزيع أدناه.
 */
function lineKey(l: { productId: string; unitName: string | null; unitFactor: number; unitCost: number | null; taxPct: number | null; enteredUnitCost: number | null }): string {
  return [l.productId, l.unitName ?? '', l.unitFactor, l.unitCost ?? 'null', l.taxPct ?? 'null', l.enteredUnitCost ?? 'null'].join('|');
}

/**
 * المتبقّي من كل سطرٍ أصلي (بوحدة السطر) بعد المرتجعات السابقة: يُوزَّع كل مرتجعٍ على سطور مفتاحه — مطابق اللوط أولاً ثم بترتيب
 * السطور. وما زاد على مجموعة مفتاحه (لا يقع إلا بكتابةٍ خارج هذه الوحدة) يُهمل فلا يصير المتبقّي سالباً.
 */
export function remainingByItem(orig: readonly OrigLine[], prior: readonly PriorReturnLine[]): Map<string, number> {
  const left = new Map(orig.map((o) => [o.id, Math.max(0, o.qty)]));
  const byKey = new Map<string, OrigLine[]>();
  for (const o of orig) {
    const k = lineKey(o);
    byKey.set(k, [...(byKey.get(k) ?? []), o]);
  }
  const take = (lines: readonly OrigLine[], want: number): number => {
    let rest = want;
    for (const o of lines) {
      if (rest <= QTY_EPS) break;
      const have = left.get(o.id) ?? 0;
      if (have <= QTY_EPS) continue;
      const t = Math.min(have, rest);
      left.set(o.id, cleanQty(have - t));
      rest = cleanQty(rest - t);
    }
    return rest;
  };
  const pending: { lines: OrigLine[]; qty: number }[] = [];
  for (const r of prior) {
    const lines = byKey.get(lineKey(r)) ?? [];
    const q = Math.abs(r.qty);
    if (!lines.length || q <= QTY_EPS) continue;
    // اللوط المطابق أولاً (مرتجع اللوط من سطر لوطه)، والباقي بعد انتهاء كل المطابقات
    const rest = r.lotId != null ? take(lines.filter((o) => o.lotId === r.lotId), q) : q;
    if (rest > QTY_EPS) pending.push({ lines, qty: rest });
  }
  for (const p of pending) take(p.lines, p.qty);
  return left;
}

// ═══ الإنشاء: بيانات الشراء في POST /entries ═══

/** حقول الشراء في جسم الطلب كما وصلت (تُفحص هنا: الواجهة 400 ومفتاح API تحذير) */
export interface PurchaseRequest {
  vendorId?: unknown;
  paymentMode?: unknown;
  paidFrom?: unknown;
  paidFromRepId?: unknown;
  supplierRef?: unknown;
  billDate?: unknown;
  vatTreatment?: unknown;
}

const PURCHASE_FIELDS = ['vendorId', 'paymentMode', 'paidFrom', 'paidFromRepId', 'supplierRef', 'billDate', 'vatTreatment'] as const;
const given = (v: unknown): boolean => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');

/** هل في الطلب حقلٌ من حقول الشراء؟ لا ⇒ الوارد كما كان حرفياً (بلا استعلامٍ زائد) */
export function hasPurchaseFields(r: PurchaseRequest): boolean {
  return PURCHASE_FIELDS.some((k) => given(r[k]));
}

/** سطر الحركة كما يلزم الشراء: موضعه في الطلب والصنف والكمية بوحدته والسعر المُدخل ونسبة الضريبة المرسلة */
export interface PurchaseLine {
  at: number;
  productId: string;
  qty: number;
  unitCost?: number | null;
  taxPct?: unknown;
}

export interface PurchaseVendor { id: string; name: string; paymentDays: number | null }

/** خطة الشراء للحركة — تُحلّ قبل المعاملة ثم تُطبَّق على أسطرها وصفّها (purchaseLineCols / purchaseEntryCols) */
export interface EntryPurchasePlan {
  vendor: PurchaseVendor | null;
  /** نوع الشراء للوارد الموجب: null = غير مصنَّف */
  paymentMode: PurchasePaymentMode | null;
  /** مصدر الدفع للنقدي، أو مستلم ما ردّه المورّد للمرتجع النقدي */
  paidFrom: PaidFrom | null;
  /** الوضع المطلوب في الطلب (قبل التنزيل) — للمرتجع: نقدي ⇒ استردادٌ نقدي */
  requestedMode: PurchasePaymentMode | null;
  supplierRef: string | null;
  billDate: Date;
  vatTreatment: VatTreatment;
  costsIncludeTax: boolean;
  decimals: number;
  /** الأسطر السالبة تحمل مورّداً وسعراً ⇒ حركة RETURN لا تسوية */
  negAsReturn: boolean;
  /** نسبة كل سطر بموضعه في الطلب (at) */
  taxPctByAt: Map<number, number>;
}

/** ما تحتاجه قراءات خطة الشراء — العميل العام أو عميل معاملة */
export type PurchaseDb = Pick<Prisma.TransactionClient, 'glVendor' | 'salesRep' | 'companySettings' | 'glSettings'>;

const PAID_FROM_KINDS = ['MAIN_CASH', 'BANK', 'REP_CUSTODY'] as const;
const SUPPLIER_REF_MAX = 60;

/** نسبة سطرٍ مُرسلة: رقمٌ 0..100 أو غائب — غير الصالح null مع علمٍ بالخطأ */
function lineTaxPct(raw: unknown): { ok: true; pct: number | null } | { ok: false } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, pct: null };
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? { ok: true, pct: n } : { ok: false };
}

/**
 * نطاق المستخدم على المناديب (adminRepFilter من services/adminScope) — دالّةٌ كسولة تُقرأ عند «الدفع من عهدة مندوب» وحده، فالوارد
 * بلا عهدة بلا استعلامٍ زائد. غائبةٌ أو فارغةُ الفلتر ⇒ بلا تقييد (المستخدم غير المقيَّد).
 */
export type RepScopeOf = () => Promise<Record<string, unknown>>;

/**
 * مصدر الدفع من الطلب: MAIN_CASH (الافتراضي) | BANK | REP_CUSTODY بمندوبٍ من الشركة **وفي نطاق المستخدم**. خطأٌ ⇒ رسالةٌ لا رمي
 * (المستدعي يقرّر: الواجهة 400، ومفتاح API وارد غير مصنَّف).
 * النطاق في استعلام المندوب نفسه: المستخدم المقيَّد (قوائم أو مشرف فرق) كان يحمّل شراءه على عهدة مندوبٍ لا يملكه بطلبٍ مصنوع —
 * وسند الصرف المباشر (routes/supplierPayments.ts) يرفض ذلك بـcanAccessRep. ومندوبٌ خارج النطاق يُرفض برسالة غير الموجود نفسها
 * (لا يُكشف وجوده).
 */
async function resolvePaidFrom(db: PurchaseDb, tid: string, kind: unknown, repId: unknown, repScope?: RepScopeOf, allowed: readonly string[] = PAID_FROM_KINDS): Promise<{ ok: true; paidFrom: PaidFrom } | { ok: false; message: string }> {
  const k = given(kind) ? String(kind).trim().toUpperCase() : 'MAIN_CASH';
  if (!allowed.includes(k)) return { ok: false, message: `مصدر الدفع غير معروف — اختر من: ${allowed.join('، ')}` };
  if (k !== 'REP_CUSTODY') return { ok: true, paidFrom: { kind: k as 'MAIN_CASH' | 'BANK' } };
  const id = typeof repId === 'string' ? repId.trim() : '';
  if (!id) return { ok: false, message: 'الدفع من عهدة مندوب يتطلب اختيار المندوب' };
  const scope = repScope ? await repScope() : {};
  // AND لا نشرٌ في الشرط: فلترٌ يحمل مفتاحاً باسم id أو tenantId لا يطغى على المعرّف المطلوب
  const rep = await db.salesRep.findFirst({ where: { id, tenantId: tid, ...(Object.keys(scope).length > 0 && { AND: [scope] }) }, select: { id: true } });
  if (!rep) return { ok: false, message: 'مندوب العهدة غير موجود في الشركة' };
  return { ok: true, paidFrom: { kind: 'REP_CUSTODY', salesRepId: id } };
}

/**
 * يحلّ بيانات الشراء لحركة POST /entries قبل المعاملة. بلا حقل شراء ⇒ null (الوارد كما كان حرفياً بلا أي استعلام).
 *   - التسوية ADJUST: حقول الشراء تُهمل بتحذير PURCHASE_FIELDS_IGNORED (كما يُهمل سعرها) ⇒ null.
 *   - الوارد مع paymentMode: المورّد إلزامي وكل سطرٍ مسعَّر — الواجهة 400 (PURCHASE_VENDOR_REQUIRED / PURCHASE_PRICE_REQUIRED /
 *     PURCHASE_INVALID)، ومفتاح API يُحفظ ورده غير مصنَّف بتحذير PURCHASE_UNCLASSIFIED بسببه («الربط لا يُرفض»).
 *   - الأسطر السالبة بمورّدٍ صالح وكلها مسعَّرة ⇒ حركة RETURN (negAsReturn)؛ وإلا تسوية إنقاص كما كانت.
 *   - تاريخ الفاتورة الافتراضي يوم الشركة الآن، ومعاملة الضريبة الافتراضية: الشركة بلا ضريبة ⇒ NONE، وإلا RECOVERABLE (تكلفةٌ
 *     صافية كما يحسبها الوارد القائم) — NON_RECOVERABLE صريحٌ وحده.
 */
export async function resolveEntryPurchase(
  db: PurchaseDb,
  tid: string,
  req: PurchaseRequest & { type: 'RECEIVE' | 'ADJUST'; costsIncludeTax: boolean },
  ctx: { isApi: boolean; lines: readonly PurchaseLine[]; products: readonly { id: string; taxPct: number }[]; warnings: StockWarning[]; repScope?: RepScopeOf },
): Promise<EntryPurchasePlan | null> {
  if (!hasPurchaseFields(req)) return null;
  const { isApi, warnings } = ctx;
  if (req.type !== 'RECEIVE') {
    warnings.push({ code: PURCHASE_WARNING.FIELDS_IGNORED, message: 'بيانات الشراء (المورّد ونوع الدفع) تسجَّل مع الوارد لا مع التسوية — أُهملت' });
    return null;
  }
  /** سببٌ يجعل الوارد غير مصنَّف: للواجهة رفض، ولمفتاح API يُجمع في تحذير واحد */
  const unclassify: string[] = [];
  const reject = (code: WarehouseBillErrorCode, message: string, detail?: Record<string, unknown>): void => {
    if (!isApi) throw fail(code, message, detail);
    unclassify.push(message);
  };
  const adjusted = (message: string, index?: number): void => {
    if (!isApi) throw fail('PURCHASE_INVALID', message, index != null ? { index } : undefined);
    warnings.push({ code: PURCHASE_WARNING.FIELD_ADJUSTED, message, ...(index != null && { index }) });
  };

  // ── المورّد ──
  let vendor: PurchaseVendor | null = null;
  if (given(req.vendorId)) {
    const id = typeof req.vendorId === 'string' ? req.vendorId.trim() : '';
    const row = id ? await db.glVendor.findFirst({ where: { id, tenantId: tid }, select: { id: true, name: true, paymentDays: true } }) : null;
    if (row) vendor = { id: row.id, name: row.name, paymentDays: row.paymentDays ?? null };
    else reject('PURCHASE_VENDOR_REQUIRED', 'المورّد غير موجود في الشركة — اختر مورّداً من القائمة', { vendorId: String(req.vendorId).slice(0, 64) });
  }

  // ── نوع الشراء ──
  let mode: PurchasePaymentMode | null = null;
  if (given(req.paymentMode)) {
    const m = String(req.paymentMode).trim().toUpperCase();
    if (m === 'CASH' || m === 'CREDIT') mode = m;
    else reject('PURCHASE_INVALID', 'نوع الشراء غير معروف — نقدي (CASH) أو آجل (CREDIT)', { field: 'paymentMode' });
  }
  const requestedMode = mode;
  if (mode && !vendor && !given(req.vendorId)) reject('PURCHASE_VENDOR_REQUIRED', 'اختر المورّد لتسجيل الشراء نقداً أو آجلاً');

  // ── الأسطر: الأسعار والنسب ──
  const pos = ctx.lines.filter((l) => l.qty > 0);
  const neg = ctx.lines.filter((l) => l.qty < 0);
  const unpriced = (ls: readonly PurchaseLine[]) => ls.filter((l) => l.unitCost == null);
  if (mode && !isApi && unpriced(ctx.lines).length) {
    const at = unpriced(ctx.lines).map((l) => l.at);
    throw fail('PURCHASE_PRICE_REQUIRED', `أدخل سعر الوحدة لكل سطر في الشراء ${mode === 'CASH' ? 'النقدي' : 'الآجل'} (السطر ${at[0] + 1})`, { indexes: at });
  }
  if (mode && unpriced(pos).length) unclassify.push(`سطر ${unpriced(pos)[0].at + 1} بلا سعر`);

  // ── مصدر الدفع (النقدي، أو المرتجع النقدي) ──
  let paidFrom: PaidFrom | null = null;
  if (mode === 'CASH') {
    const p = await resolvePaidFrom(db, tid, req.paidFrom, req.paidFromRepId, ctx.repScope);
    if (p.ok) paidFrom = p.paidFrom;
    else reject('PURCHASE_INVALID', p.message, { field: 'paidFrom' });
  }

  // ── رقم فاتورة المورّد وتاريخها ──
  let supplierRef: string | null = null;
  if (given(req.supplierRef)) {
    if (typeof req.supplierRef !== 'string' && typeof req.supplierRef !== 'number') adjusted('رقم فاتورة المورّد غير صالح — أُهمل');
    else {
      const s = String(req.supplierRef).trim();
      if (s.length > SUPPLIER_REF_MAX) {
        adjusted(`رقم فاتورة المورّد أطول من ${SUPPLIER_REF_MAX} حرفاً — قُصّ`);
        supplierRef = s.slice(0, SUPPLIER_REF_MAX);
      } else supplierRef = s;
    }
  }
  let billDate: Date | null = null;
  if (given(req.billDate)) {
    billDate = parseDay(typeof req.billDate === 'string' ? req.billDate.trim() : req.billDate);
    if (!billDate) adjusted('تاريخ فاتورة المورّد غير صالح (YYYY-MM-DD) — سُجّل يوم الاستلام');
  }
  if (!billDate) billDate = parseDay((await companyDay(db as Prisma.TransactionClient, tid)).day) ?? utcDay(new Date());

  // ── معاملة الضريبة ──
  const taxOff = isTaxOff(await db.companySettings.findUnique({ where: { tenantId: tid }, select: { taxDisabled: true } }));
  let vt: VatTreatment | null = null;
  if (given(req.vatTreatment)) {
    const v = String(req.vatTreatment).trim().toUpperCase();
    if ((VAT_TREATMENTS as readonly string[]).includes(v)) vt = v as VatTreatment;
    else adjusted(`معاملة الضريبة غير معروفة — اختر من: ${VAT_TREATMENTS.join('، ')}`);
  }
  if (vt === 'RECOVERABLE' && taxOff) {
    // تنبيهٌ لا رفض: واجهةٌ ترسل «مستردة» افتراضاً لشركةٍ أطفأت ضريبتها — والتكلفة كما يحسبها الوارد القائم لها (ما كُتب)
    warnings.push({ code: PURCHASE_WARNING.VAT_TREATMENT_ADJUSTED, message: 'الشركة بلا ضريبة فلا تُستردّ ضريبة المشتريات — سُجّلت الفاتورة بلا ضريبة' });
    vt = 'NONE';
  }
  const vatTreatment: VatTreatment = vt ?? (taxOff ? 'NONE' : 'RECOVERABLE');
  const productTax = new Map(ctx.products.map((p) => [p.id, p.taxPct]));
  const taxPctByAt = new Map<number, number>();
  for (const l of ctx.lines) {
    const t = lineTaxPct(l.taxPct);
    let pct: number | null = null;
    if (t.ok) pct = t.pct;
    else adjusted(`نسبة ضريبة السطر ${l.at + 1} غير صالحة (0 إلى 100) — استُعملت نسبة الصنف`, l.at);
    // NONE ⇒ صفر (العقد)؛ وإلا المرسلة أو نسبة الصنف — والشركة بلا ضريبة ومعاملة غير صريحة صارت NONE أعلاه
    taxPctByAt.set(l.at, vatTreatment === 'NONE' ? 0 : pct ?? productTax.get(l.productId) ?? 0);
  }

  // ── التصنيف النهائي ──
  if (mode && unclassify.length) {
    warnings.push({ code: PURCHASE_WARNING.UNCLASSIFIED, message: `حُفظ الوارد غير مصنَّف (نقدي/آجل): ${unclassify.join('؛ ')} — صنّفه لاحقاً من سجلّ الحركات` });
    mode = null;
    paidFrom = null;
  } else if (!mode && unclassify.length && isApi) {
    warnings.push({ code: PURCHASE_WARNING.UNCLASSIFIED, message: `${unclassify.join('؛ ')} — حُفظت الحركة بلا مورّد` });
  }
  // المرتجع النقدي (أسطر سالبة ونوع الشراء نقدي): مستلم ما ردّه المورّد — يُحلّ ولو سقط تصنيف الموجب بسببٍ يخصّه
  if (requestedMode === 'CASH' && !paidFrom && neg.length && vendor) {
    const p = await resolvePaidFrom(db, tid, req.paidFrom, req.paidFromRepId, ctx.repScope);
    if (p.ok) paidFrom = p.paidFrom;
  }
  const negAsReturn = !!vendor && neg.length > 0 && unpriced(neg).length === 0;

  return {
    vendor,
    paymentMode: pos.length ? mode : null,
    paidFrom,
    requestedMode,
    supplierRef,
    billDate,
    vatTreatment,
    costsIncludeTax: req.costsIncludeTax === true,
    decimals: await tenantCurrencyDecimals(tid),
    negAsReturn,
    taxPctByAt,
  };
}

/** أعمدة سطرٍ مسعَّر في وارد/مرتجعٍ بخطة شراء: تكلفة المخزون ونسبة الضريبة والسعر كما أُدخل */
export function purchaseLineCols(plan: EntryPurchasePlan, line: { at: number; unitCost?: number | null }): { unitCost: number | null; taxPct: number; enteredUnitCost: number | null } {
  const taxPct = plan.taxPctByAt.get(line.at) ?? 0;
  if (line.unitCost == null) return { unitCost: null, taxPct, enteredUnitCost: null };
  return {
    unitCost: inventoryUnitCost(line.unitCost, taxPct, plan.costsIncludeTax, plan.vatTreatment),
    taxPct,
    enteredUnitCost: line.unitCost,
  };
}

/**
 * أعمدة صفّ الحركة بخطة الشراء:
 *   - RECEIVE: المورّد ورقم فاتورته وتاريخها ومعاملة الضريبة دائماً؛ والمصنَّف (paymentMode) يضيف مصدر الدفع والاستحقاق (الآجل:
 *     تاريخ الفاتورة + مدة المورّد) والإجماليات. غير المصنَّف إجمالياته null (تُحسب عند تصنيفه).
 *   - RETURN (أسطر سالبة بمورّدٍ وسعر): الإجماليات دائماً، ونقديٌّ ⇒ paymentMode CASH ومستلم المردود (REFUND_IN)، وإلا CREDIT.
 */
export function purchaseEntryCols(plan: EntryPurchasePlan, type: 'RECEIVE' | 'RETURN', lines: readonly { at: number; qty: number; unitCost?: number | null }[]) {
  const base = {
    ...(plan.vendor && { vendorId: plan.vendor.id }),
    supplierRef: plan.supplierRef,
    billDate: plan.billDate,
    costsIncludeTax: plan.costsIncludeTax,
    vatTreatment: plan.vatTreatment,
  };
  const totalsOf = () => entryBillTotals(lines.map((l) => ({ qty: l.qty, ...purchaseLineCols(plan, l) })), plan);
  if (type === 'RETURN') {
    const t = totalsOf();
    const cash = plan.requestedMode === 'CASH' && plan.paidFrom != null;
    return {
      ...base,
      paymentMode: cash ? 'CASH' : 'CREDIT',
      paidAccountRef: cash ? formatPaidAccountRef(plan.paidFrom as PaidFrom) : null,
      netMilli: t.netMilli, taxMilli: t.taxMilli, totalMilli: t.totalMilli,
    };
  }
  if (!plan.paymentMode) return base;
  const t = totalsOf();
  return {
    ...base,
    paymentMode: plan.paymentMode,
    paidAccountRef: plan.paymentMode === 'CASH' && plan.paidFrom ? formatPaidAccountRef(plan.paidFrom) : null,
    dueDate: plan.paymentMode === 'CREDIT' ? computeDueDate(plan.billDate, plan.vendor?.paymentDays) : null,
    netMilli: t.netMilli, taxMilli: t.taxMilli, totalMilli: t.totalMilli,
  };
}

// ═══ قيود الكشف وسند الصرف الآلي ═══

/** صفّ الحركة المكتوب كما يلزم قيوده — يُقرأ من الصفّ نفسه فيكتب الكشفُ ما حُفظ حرفياً */
export interface WrittenEntry {
  id: string;
  type: string;
  vendorId?: string | null;
  paymentMode?: string | null;
  paidAccountRef?: string | null;
  supplierRef?: string | null;
  billDate?: Date | null;
  dueDate?: Date | null;
  netMilli?: bigint | null;
  taxMilli?: bigint | null;
  totalMilli?: bigint | null;
  note?: string | null;
}

export interface PurchasePaymentRef { id: string; number: number; displayNumber: string }

/** قيد فاتورة المورّد BILL (+الإجمالي) بتاريخ الفاتورة واستحقاقها */
async function writeBillLedgerTx(tx: Prisma.TransactionClient, tid: string, e: WrittenEntry, by: string | null): Promise<void> {
  await tx.supplierLedgerEntry.create({
    data: {
      tenantId: tid, vendorId: e.vendorId as string, kind: 'BILL', amountMilli: signedLedgerAmount('BILL', e.totalMilli as bigint),
      netMilli: e.netMilli ?? null, taxMilli: e.taxMilli ?? null, warehouseEntryId: e.id,
      docDate: e.billDate as Date, dueDate: e.dueDate ?? null, ref: e.supplierRef ?? null, note: e.note ?? null, createdBy: by,
    },
  });
}

/** قيد المرتجع RETURN (−الإجمالي)، ومعه REFUND_IN (+) حين ردّ المورّد المال نقداً — كلاهما على حركة المرتجع نفسها */
async function writeReturnLedgerTx(tx: Prisma.TransactionClient, tid: string, e: WrittenEntry, opts: { by: string | null; ref: string | null; refund: boolean }): Promise<void> {
  const total = e.totalMilli as bigint;
  await tx.supplierLedgerEntry.create({
    data: {
      tenantId: tid, vendorId: e.vendorId as string, kind: 'RETURN', amountMilli: signedLedgerAmount('RETURN', total),
      netMilli: e.netMilli ?? null, taxMilli: e.taxMilli ?? null, warehouseEntryId: e.id,
      docDate: e.billDate as Date, ref: opts.ref, note: e.note ?? null, createdBy: opts.by,
    },
  });
  if (opts.refund) {
    await tx.supplierLedgerEntry.create({
      data: {
        tenantId: tid, vendorId: e.vendorId as string, kind: 'REFUND_IN', amountMilli: signedLedgerAmount('REFUND_IN', total),
        warehouseEntryId: e.id, docDate: e.billDate as Date, ref: opts.ref, note: e.note ?? null, createdBy: opts.by,
      },
    });
  }
}

/**
 * قيود الوارد المصنَّف بعد كتابة صفّه في المعاملة نفسها: BILL، وللنقدي سند صرفٍ آلي بالمبلغ كاملاً مخصَّصاً له (autoForEntryId) بتاريخ
 * الفاتورة ومن مصدر دفعه — فرصيد المورّد صفرٌ بعده. وغير المصنَّف وما إجماليه صفر: لا شيء (ولا استعلام).
 */
export async function writeReceiveBillTx(tx: Prisma.TransactionClient, tid: string, e: WrittenEntry, by: string | null): Promise<PurchasePaymentRef | null> {
  if (e.type !== 'RECEIVE' || !e.vendorId || !e.paymentMode || e.totalMilli == null || e.totalMilli <= 0n || !e.billDate) return null;
  await writeBillLedgerTx(tx, tid, e, by);
  if (e.paymentMode !== 'CASH') return null;
  const paidFrom = parsePaidAccountRef(e.paidAccountRef) ?? { kind: 'MAIN_CASH' as const };
  const p = await createSupplierPaymentTx(tx, {
    tenantId: tid,
    vendorId: e.vendorId,
    amountMilli: e.totalMilli,
    method: paymentMethodOfPaidFrom(paidFrom),
    salesRepId: paidFrom.kind === 'REP_CUSTODY' ? paidFrom.salesRepId : null,
    paidAt: e.billDate,
    reference: e.supplierRef ?? null,
    createdBy: by,
    autoForEntryId: e.id,
    allocations: [],
  });
  return { id: p.id, number: p.number, displayNumber: supplierPaymentDisplayNumber(p.number) };
}

/**
 * قيود حركات POST /entries بخطة الشراء: الوارد المصنَّف (BILL ± سند آلي) والمرتجع من أسطرٍ سالبة (RETURN ± REFUND_IN). بلا خطة ⇒
 * لا شيء ولا استعلام (المسار القائم حرفياً).
 */
export async function writeEntryPurchaseTx(
  tx: Prisma.TransactionClient,
  tid: string,
  plan: EntryPurchasePlan | null,
  written: { main: WrittenEntry; split: WrittenEntry | null },
  by: string | null,
): Promise<{ payment: PurchasePaymentRef | null }> {
  if (!plan) return { payment: null };
  let payment: PurchasePaymentRef | null = null;
  for (const e of [written.split, written.main]) {
    if (!e) continue;
    if (e.type === 'RECEIVE') payment = (await writeReceiveBillTx(tx, tid, e, by)) ?? payment;
    else if (e.type === 'RETURN' && e.vendorId && e.totalMilli != null && e.totalMilli > 0n && e.billDate) {
      await writeReturnLedgerTx(tx, tid, e, { by, ref: e.supplierRef ?? null, refund: e.paymentMode === 'CASH' });
    }
  }
  return { payment };
}

// ═══ الردّ (BigInt لا يمرّ في res.json) ═══

/**
 * صفّ الحركة للردّ: الإجماليات بالملّي ⇒ net/tax/total أرقاماً بوحدة العملة (null لغير المسعَّر)، وتاريخا الفاتورة واستحقاقها
 * YYYY-MM-DD. صفٌّ بلا أعمدة الإجماليات (قراءةٌ بـselect) يمرّ كما هو.
 */
export function entryJson<T extends object>(e: T): Record<string, unknown> {
  if (!e || typeof e !== 'object') return e as unknown as Record<string, unknown>;
  const r: Record<string, unknown> = { ...(e as Record<string, unknown>) };
  for (const [k, out] of [['netMilli', 'net'], ['taxMilli', 'tax'], ['totalMilli', 'total']] as const) {
    if (!(k in r)) continue;
    const v = r[k];
    delete r[k];
    r[out] = v == null ? null : milliToNumber(typeof v === 'bigint' ? v : BigInt(v as number));
  }
  for (const k of ['billDate', 'dueDate'] as const) if (r[k] instanceof Date) r[k] = dayString(r[k] as Date);
  return r;
}

/** المدفوع والمتبقّي لحركات الآجل في صفحة السجلّ — استعلامات ثابتة العدد (loadBillSettlements)، ولا شيء حين لا آجل */
export async function creditSettlementsOf(
  db: Parameters<typeof loadBillSettlements>[0],
  tid: string,
  entries: readonly { id: string; type: string; paymentMode?: string | null }[],
): Promise<Map<string, { paid: number; outstanding: number }>> {
  const ids = entries.filter((e) => e.type === 'RECEIVE' && e.paymentMode === 'CREDIT').map((e) => e.id);
  const out = new Map<string, { paid: number; outstanding: number }>();
  if (!ids.length) return out;
  for (const s of await loadBillSettlements(db, tid, { billIds: ids })) {
    out.set(s.bill.id, { paid: milliToNumber(s.paidMilli), outstanding: milliToNumber(s.outstandingMilli) });
  }
  return out;
}

/**
 * المتبقّي للإرجاع من كل سطرٍ (بوحدة السطر) لواردات الصفحة المصنَّفة غير الملغاة — remainingByItem نفسها التي يحكم بها المرتجع
 * (409 RETURN_EXCEEDS_RECEIVED)، على كل مرتجعاتها السارية لا ما ظهر منها في الصفحة (السجلّ آخر ١٠٠ حركة وقد يكون مفلتراً).
 * استعلامٌ واحد، ولا شيء حين لا وارد مصنَّف في الصفحة (السجلّ القائم بلا استعلام زائد).
 */
export async function returnRemainingOf(
  db: { warehouseEntry: { findMany(args: object): Promise<unknown[]> } },
  tid: string,
  entries: readonly { id: string; type: string; status?: string | null; paymentMode?: string | null; items: readonly OrigLine[] }[],
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  const bills = entries.filter((e) => e.type === 'RECEIVE' && !!e.paymentMode && e.status !== 'CANCELLED');
  if (!bills.length) return out;
  const prior = (await db.warehouseEntry.findMany({
    where: { tenantId: tid, type: 'RETURN', returnOfEntryId: { in: bills.map((e) => e.id) }, status: { not: 'CANCELLED' } },
    select: { returnOfEntryId: true, items: { select: ITEM_SELECT } },
  })) as { returnOfEntryId: string | null; items: PriorReturnLine[] }[];
  for (const e of bills) {
    const lines = prior.filter((r) => r.returnOfEntryId === e.id).flatMap((r) => r.items);
    out.set(e.id, remainingByItem(e.items, lines));
  }
  return out;
}

// ═══ الحركة القائمة: القفل والقراءة ═══

/**
 * قفل صفّ الحركة FOR UPDATE قبل قراءتها في كل معاملة تصنيف/مرتجع/إلغاء — فتتسلسل العمليات على الفاتورة الواحدة ومع تخصيص سندات
 * الصرف (payments.ts يقفل الصفّ نفسه). يأتي بعد أقفال الأصناف (المسار) وقبل قفل سند الصرف.
 */
export async function lockEntryRow(tx: Prisma.TransactionClient, tid: string, entryId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM warehouse_entries WHERE id = ${entryId} AND "tenantId" = ${tid} FOR UPDATE`;
  return rows.length > 0;
}

const ITEM_SELECT = {
  id: true, productId: true, qty: true, unitName: true, unitFactor: true, baseQty: true, unitCost: true, taxPct: true, enteredUnitCost: true,
  lotId: true, lineRef: true,
} as const;

const ENTRY_SELECT = {
  id: true, tenantId: true, type: true, status: true, source: true, note: true, supplier: true, vendorId: true, paymentMode: true,
  paidAccountRef: true, supplierRef: true, billDate: true, dueDate: true, costsIncludeTax: true, vatTreatment: true,
  netMilli: true, taxMilli: true, totalMilli: true, createdAt: true, returnOfEntryId: true,
  items: { select: ITEM_SELECT },
} as const;

type EntryRow = {
  id: string; tenantId: string; type: string; status: string; source: string; note: string | null; supplier: string | null;
  vendorId: string | null; paymentMode: string | null; paidAccountRef: string | null; supplierRef: string | null;
  billDate: Date | null; dueDate: Date | null; costsIncludeTax: boolean; vatTreatment: string | null;
  netMilli: bigint | null; taxMilli: bigint | null; totalMilli: bigint | null; createdAt: Date; returnOfEntryId: string | null;
  items: (OrigLine & { baseQty: number | null; lineRef: string | null })[];
};

async function readEntry(db: Prisma.TransactionClient, tid: string, entryId: string): Promise<EntryRow | null> {
  return (await db.warehouseEntry.findFirst({ where: { id: entryId, tenantId: tid }, select: ENTRY_SELECT })) as EntryRow | null;
}

// ═══ المخزون الافتتاحي: ليس شراءً من مورّد ═══

/** ما يلزم قراءة دفعات الاستيراد (العميل العام أو عميل معاملة) */
type ImportBatchDb = { importBatch: { findMany(a: object): Promise<{ recordIds: string | null }[]> } };

/** حركةٌ بأعمدة الحكم على «الافتتاحي» */
interface OpeningCandidate { id: string; type: string; source?: string | null; note?: string | null }

/**
 * مرشّحةٌ لأن تكون حركة «استيراد المخزون الافتتاحي» كُتبت قبل عمود المصدر: `db push` وضع 'MANUAL' في كل صفٍّ قائم، وسكربت الملء
 * (scripts/backfillWarehouseEntrySource.ts) لا يُشغَّل آلياً في النشر — فالعمود وحده لا يكفي حارساً. والاستيراد كتب دائماً واردَه
 * بملاحظته الثابتة (OPENING_STOCK_NOTE)، فالملاحظة تحصر المرشّحات بلا استعلام، والحَكَم دفعات الاستيراد نفسها (معرّف الحركة في
 * recordIds لدفعة opening_stock) — لا نصّ ملاحظةٍ قد يكتبه مستخدمٌ يدوياً.
 */
const legacyOpeningCandidate = (e: OpeningCandidate): boolean =>
  e.type === OPENING_STOCK_ENTRY_TYPE && (e.source ?? 'MANUAL') === 'MANUAL' && e.note === OPENING_STOCK_NOTE;

/**
 * معرّفات حركات «المخزون الافتتاحي» السابقة لعمود المصدر بين حركاتٍ معطاة (المرشّحة وحدها، ثم دفعات opening_stock للشركة في
 * استعلامٍ واحد). لا مرشّحة ⇒ لا استعلام.
 */
export async function legacyOpeningImportIds(db: ImportBatchDb, tid: string, entries: readonly OpeningCandidate[]): Promise<Set<string>> {
  const cand = entries.filter(legacyOpeningCandidate).map((e) => e.id);
  if (!cand.length) return new Set();
  const batches = await db.importBatch.findMany({ where: { tenantId: tid, kind: OPENING_STOCK_KIND }, select: { recordIds: true } });
  const ids = new Set(batches.flatMap((b) => parseBatchRecordIds(b.recordIds).records));
  return new Set(cand.filter((id) => ids.has(id)));
}

/** حركة «المخزون الافتتاحي»: بعمودها، أو سابقةٌ له بدفعتها (legacyOpeningImportIds) */
export async function isOpeningImportEntry(db: ImportBatchDb, tid: string, e: OpeningCandidate): Promise<boolean> {
  if (e.source === 'OPENING_IMPORT') return true;
  return (await legacyOpeningImportIds(db, tid, [e])).has(e.id);
}

/** أصناف الحركة كما تلزم المسار قبل المعاملة: الأساس (حارس الوحدة) والتتبّع (طريق اللوط) والاسم */
export interface ReversalProduct { id: string; name: string; unit: string; taxPct: number; lotTracked: boolean | null; shelfLifeEnabled?: boolean | null; shelfLifeValue?: number | null; shelfLifeUnit?: string | null }

/** قراءة ما قبل المعاملة للتصنيف/المرتجع/الإلغاء: الحركة وأصناف أسطرها — null ⇒ 404 (حركةُ شركةٍ أخرى كأنها غير موجودة) */
export async function loadEntryContext(db: Prisma.TransactionClient, tid: string, entryId: string): Promise<{ entry: EntryRow; products: ReversalProduct[] } | null> {
  const entry = await readEntry(db, tid, entryId);
  if (!entry) return null;
  const ids = [...new Set(entry.items.map((i) => i.productId))];
  const products = ids.length ? (await db.product.findMany({
    where: { id: { in: ids }, tenantId: tid },
    select: { id: true, name: true, unit: true, taxPct: true, lotTracked: true, shelfLifeEnabled: true, shelfLifeValue: true, shelfLifeUnit: true },
  })) as ReversalProduct[] : [];
  return { entry, products };
}

// ═══ التصنيف اللاحق ═══

export interface ClassifyInput {
  tenantId: string;
  entryId: string;
  by: string | null;
  body: Record<string, unknown>;
  /** نطاق المستخدم على المناديب لـ«الدفع من عهدة مندوب» — غائبٌ ⇒ بلا تقييد */
  repScope?: RepScopeOf;
}

/**
 * يصنّف وارداً غير مصنَّف (نقدي/آجل) بعد قفل صفّه: يملأ أسعار السطور غير المسعَّرة وحدها (لا يغيّر سعراً قائماً)، ونسبة ضريبة كل سطر،
 * ثم يكتب ما يكتبه الإنشاء المصنَّف حرفياً: أعمدة الشراء والإجماليات، وقيد BILL، وللنقدي سند الصرف الآلي. الإدخال صارم (400) لكل
 * مُصدِر: لا حركة مخزون تضيع برفضه.
 */
export async function classifyEntryTx(tx: Prisma.TransactionClient, input: ClassifyInput): Promise<{ entryId: string; payment: PurchasePaymentRef | null; warnings: StockWarning[] }> {
  const { tenantId: tid, entryId, by, body } = input;
  if (!(await lockEntryRow(tx, tid, entryId))) throw fail('ENTRY_NOT_FOUND', 'الحركة غير موجودة');
  const e = await readEntry(tx, tid, entryId);
  if (!e) throw fail('ENTRY_NOT_FOUND', 'الحركة غير موجودة');
  if (e.type !== 'RECEIVE') throw fail('ENTRY_NOT_CLASSIFIABLE', 'التصنيف للوارد وحده — التسوية والمرتجع لا يُصنَّفان');
  // بالعمود أو بدفعة الاستيراد (الحركات السابقة للعمود 'MANUAL' حتى يُشغَّل سكربت الملء): تصنيفه نقداً كان يصرف من الصندوق ثمنَ
  // جردٍ أُدخل، وآجلاً يُنشئ ذمّةً وهمية للمورّد يمنع قيدُها تراجعَ الاستيراد (P2003)
  if (await isOpeningImportEntry(tx as unknown as ImportBatchDb, tid, e)) {
    throw fail('ENTRY_NOT_CLASSIFIABLE', 'المخزون الافتتاحي ليس شراءً من مورّد فلا يُصنَّف', { source: 'OPENING_IMPORT' });
  }
  if (e.status === 'CANCELLED') throw fail('ENTRY_ALREADY_CANCELLED', 'الوارد ملغى');
  if (e.paymentMode) throw fail('ENTRY_ALREADY_CLASSIFIED', 'الوارد مصنَّف مسبقاً (نقدي/آجل)', { paymentMode: e.paymentMode });

  const warnings: StockWarning[] = [];
  const products = await tx.product.findMany({ where: { id: { in: [...new Set(e.items.map((i) => i.productId))] }, tenantId: tid }, select: { id: true, taxPct: true } });
  const plan = await resolveEntryPurchase(tx, tid, {
    vendorId: body.vendorId ?? e.vendorId, paymentMode: body.paymentMode, paidFrom: body.paidFrom, paidFromRepId: body.paidFromRepId,
    supplierRef: body.supplierRef ?? e.supplierRef ?? undefined,
    // يوم الاستلام بتوقيت الشركة افتراضاً (لا يوم التصنيف): الفاتورة بتاريخ البضاعة
    billDate: body.billDate ?? (e.billDate ? dayString(e.billDate) : (await companyDay(tx, tid, e.createdAt)).day),
    vatTreatment: body.vatTreatment ?? e.vatTreatment ?? undefined,
    type: 'RECEIVE',
    costsIncludeTax: typeof body.costsIncludeTax === 'boolean' ? body.costsIncludeTax : e.costsIncludeTax,
  }, {
    isApi: false,
    // الأسطر للحكم على المورّد والنوع وحدهما (الأسعار تُفحص أدناه بعد دمج prices)
    lines: e.items.map((i, at) => ({ at, productId: i.productId, qty: Math.abs(i.qty) || 1, unitCost: 1, taxPct: i.taxPct ?? undefined })),
    products,
    warnings,
    repScope: input.repScope,
  });
  if (!plan || !plan.vendor) throw fail('PURCHASE_VENDOR_REQUIRED', 'اختر المورّد لتصنيف الوارد');
  if (!plan.paymentMode) throw fail('PURCHASE_INVALID', 'اختر نوع الشراء: نقدي (CASH) أو آجل (CREDIT)', { field: 'paymentMode' });

  // ── أسعار السطور ──
  const raw = Array.isArray(body.prices) ? (body.prices as unknown[]) : body.prices == null ? [] : null;
  if (raw == null) throw fail('PURCHASE_INVALID', 'الأسعار prices قائمة [{itemId, unitCost, taxPct?}]', { field: 'prices' });
  const byItem = new Map<string, { unitCost: number; taxPct: number | null }>();
  for (const [k, p] of raw.entries()) {
    const o = (p ?? {}) as Record<string, unknown>;
    const itemId = typeof o.itemId === 'string' ? o.itemId : '';
    const item = e.items.find((i) => i.id === itemId);
    if (!item) throw fail('PURCHASE_INVALID', `السطر ${k + 1} في الأسعار ليس من هذه الحركة`, { index: k, itemId: itemId.slice(0, 64) });
    const unitCost = typeof o.unitCost === 'number' ? o.unitCost : Number(o.unitCost);
    if (!Number.isFinite(unitCost) || unitCost <= 0 || unitCost > 1e9) throw fail('PURCHASE_INVALID', `سعر الوحدة في السطر ${k + 1} غير صالح`, { index: k, itemId });
    const t = lineTaxPct(o.taxPct);
    if (!t.ok) throw fail('PURCHASE_INVALID', `نسبة الضريبة في السطر ${k + 1} غير صالحة (0 إلى 100)`, { index: k, itemId });
    if (byItem.has(itemId)) throw fail('PURCHASE_INVALID', 'سطرٌ مكرّر في الأسعار', { itemId });
    if (item.unitCost != null) {
      warnings.push({ code: PURCHASE_WARNING.PRICE_IGNORED, message: `السطر ${e.items.indexOf(item) + 1} مسعَّر مسبقاً فلم يُغيَّر سعره`, index: e.items.indexOf(item) });
      continue;
    }
    byItem.set(itemId, { unitCost, taxPct: t.pct });
  }
  const missing = e.items.filter((i) => i.unitCost == null && !byItem.has(i.id));
  if (missing.length) {
    throw fail('PURCHASE_PRICE_REQUIRED', `أدخل سعر الوحدة لكل سطر غير مسعَّر (السطر ${e.items.indexOf(missing[0]) + 1})`, { itemIds: missing.map((i) => i.id) });
  }
  // الأسعار القائمة لا تُغيَّر: فمعاملة الضريبة وطريقة إدخال الأسعار لا تخالفان ما حُسبت به تكاليفها
  const pricedBefore = e.items.filter((i) => i.unitCost != null);
  if (pricedBefore.length) {
    if (plan.vatTreatment === 'NON_RECOVERABLE' && e.vatTreatment !== 'NON_RECOVERABLE') {
      throw fail('PURCHASE_INVALID', 'أسعار الوارد القائمة صافية فلا يُصنَّف بضريبةٍ غير مستردة — سجّل مرتجعاً وأعد الاستلام', { field: 'vatTreatment' });
    }
    if (e.vatTreatment && plan.vatTreatment !== e.vatTreatment) {
      throw fail('PURCHASE_INVALID', 'معاملة الضريبة تخالف ما سُعّرت به أسطر الوارد القائمة', { field: 'vatTreatment', vatTreatment: e.vatTreatment });
    }
    if (pricedBefore.some((i) => i.enteredUnitCost != null) && plan.costsIncludeTax !== e.costsIncludeTax) {
      throw fail('PURCHASE_INVALID', `أسعار الوارد القائمة ${e.costsIncludeTax ? 'شاملة' : 'غير شاملة'} للضريبة — أدخل الأسعار الجديدة بالطريقة نفسها`, { field: 'costsIncludeTax' });
    }
  }

  // ── كتابة الأسطر: السعر الجديد، ونسبة كل سطرٍ بلا نسبة ──
  const productTax = new Map(products.map((p) => [p.id, p.taxPct]));
  const lines: BillCostLine[] = [];
  for (const i of e.items) {
    const price = byItem.get(i.id);
    const pct = plan.vatTreatment === 'NONE' ? 0 : price?.taxPct ?? i.taxPct ?? productTax.get(i.productId) ?? 0;
    if (price) {
      const unitCost = inventoryUnitCost(price.unitCost, pct, plan.costsIncludeTax, plan.vatTreatment);
      await tx.warehouseEntryItem.update({ where: { id: i.id }, data: { unitCost, enteredUnitCost: price.unitCost, taxPct: pct } });
      lines.push({ qty: i.qty, unitCost, enteredUnitCost: price.unitCost, taxPct: pct });
    } else {
      if (i.taxPct !== pct) await tx.warehouseEntryItem.update({ where: { id: i.id }, data: { taxPct: pct } });
      lines.push({ qty: i.qty, unitCost: i.unitCost, enteredUnitCost: i.enteredUnitCost, taxPct: pct });
    }
  }
  const t = entryBillTotals(lines, plan);
  const cols = {
    vendorId: plan.vendor.id,
    ...(!e.supplier && { supplier: plan.vendor.name }),
    paymentMode: plan.paymentMode,
    paidAccountRef: plan.paymentMode === 'CASH' && plan.paidFrom ? formatPaidAccountRef(plan.paidFrom) : null,
    supplierRef: plan.supplierRef,
    billDate: plan.billDate,
    dueDate: plan.paymentMode === 'CREDIT' ? computeDueDate(plan.billDate, plan.vendor.paymentDays) : null,
    costsIncludeTax: plan.costsIncludeTax,
    vatTreatment: plan.vatTreatment,
    netMilli: t.netMilli, taxMilli: t.taxMilli, totalMilli: t.totalMilli,
  };
  await tx.warehouseEntry.update({ where: { id: e.id }, data: cols });
  const payment = await writeReceiveBillTx(tx, tid, { id: e.id, type: 'RECEIVE', note: e.note, ...cols }, by);
  return { entryId: e.id, payment, warnings };
}

// ═══ المرتجع والإلغاء ═══

export interface ReturnRequest {
  items: { itemId: string; qty: number }[];
  note: string | null;
  supplierRef: string | null;
  billDate: Date | null;
  refundMode: 'CREDIT' | 'CASH';
  refundTo: PaidFrom;
  /**
   * مفتاح منع التكرار (نمط D8 للوارد، وclientRef سندات الصرف): واحدٌ لكل محاولة حفظ يُعاد مع إعادتها — ضاع الردّ بعد الالتزام فأُعيد
   * الطلب ⇒ يُردّ المرتجع القائم 200 بلا مرتجعٍ ثانٍ ولا قيد RETURN مكرَّر. غائبٌ ⇒ كما كان
   */
  clientRef: string | null;
}

/** جسم POST /entries/:id/return — صارمٌ لكل مُصدِر (400 RETURN_INVALID): لا حركة تضيع برفضه */
export function parseReturnBody(body: unknown): ReturnRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(b.items) || !b.items.length) throw fail('RETURN_INVALID', 'اختر الأسطر المرتجعة وكمياتها', { field: 'items' });
  const items = (b.items as unknown[]).map((x, k) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const itemId = typeof o.itemId === 'string' ? o.itemId.trim() : '';
    const qty = typeof o.qty === 'number' ? o.qty : Number(o.qty);
    if (!itemId) throw fail('RETURN_INVALID', `السطر ${k + 1}: itemId مطلوب`, { index: k });
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1e9) throw fail('RETURN_INVALID', `السطر ${k + 1}: الكمية المرتجعة يجب أن تكون أكبر من صفر`, { index: k });
    return { itemId, qty };
  });
  const text = (v: unknown, max: number, field: string): string | null => {
    if (v == null || v === '') return null;
    if (typeof v !== 'string' && typeof v !== 'number') throw fail('RETURN_INVALID', `${field} غير صالح`, { field });
    const s = String(v).trim();
    if (s.length > max) throw fail('RETURN_INVALID', `${field} أطول من ${max} حرفاً`, { field });
    return s || null;
  };
  let billDate: Date | null = null;
  if (b.billDate != null && b.billDate !== '') {
    billDate = parseDay(b.billDate);
    if (!billDate) throw fail('RETURN_INVALID', 'تاريخ المرتجع غير صالح (YYYY-MM-DD)', { field: 'billDate' });
  }
  const mode = b.refundMode == null || b.refundMode === '' ? 'CREDIT' : String(b.refundMode).toUpperCase();
  if (mode !== 'CREDIT' && mode !== 'CASH') throw fail('RETURN_INVALID', 'طريقة التسوية: CREDIT (خصم من الرصيد) أو CASH (ردّ نقدي)', { field: 'refundMode' });
  const to = b.refundTo == null || b.refundTo === '' ? 'MAIN_CASH' : String(b.refundTo).toUpperCase();
  if (to !== 'MAIN_CASH' && to !== 'BANK') throw fail('RETURN_INVALID', 'مستلم الردّ النقدي: MAIN_CASH أو BANK', { field: 'refundTo' });
  // المرجع بشكل مراجع المخزون نفسه (CLIENT_REF_SCHEMA) — الفارغ كالغائب
  let clientRef: string | null = null;
  if (b.clientRef != null && b.clientRef !== '') {
    if (typeof b.clientRef !== 'string' || !CLIENT_REF_SCHEMA.safeParse(b.clientRef).success) {
      throw fail('RETURN_INVALID', 'clientRef: حروف لاتينية وأرقام و - و _ حتى 64', { field: 'clientRef' });
    }
    clientRef = b.clientRef;
  }
  return {
    items,
    note: text(b.note, 300, 'note'),
    supplierRef: text(b.supplierRef, SUPPLIER_REF_MAX, 'supplierRef'),
    billDate,
    refundMode: mode,
    refundTo: { kind: to },
    clientRef,
  };
}

/**
 * المرتجع المحفوظ بمرجع العميل (clientRef) لهذا الوارد — null حين لا شيء بمرجعه. والمرجع مستعملٌ لحركةٍ أخرى (وارد أو تسوية، أو
 * مرتجع واردٍ آخر) ⇒ 409 CLIENT_REF_REUSED: إعادته لا تعني هذا المرتجع. المراجع في عمود حركات المستودع نفسه (warehouse_entries.clientRef)
 * فيُقفل بمفتاح الوارد نفسه (lockClientRef 'warehouse-entry') — المسار يقفله أول المعاملة ثم يبحث هنا.
 */
export async function findReturnByClientRef(
  db: Pick<Prisma.TransactionClient, 'warehouseEntry'>,
  tid: string,
  entryId: string,
  clientRef: string,
): Promise<{ id: string } | null> {
  const prior = await db.warehouseEntry.findFirst({
    where: { tenantId: tid, clientRef }, orderBy: { createdAt: 'asc' }, select: { id: true, type: true, returnOfEntryId: true },
  });
  if (!prior) return null;
  if (prior.type !== 'RETURN' || prior.returnOfEntryId !== entryId) {
    throw fail('CLIENT_REF_REUSED', 'مرجع الحفظ clientRef مستعملٌ لحركةٍ أخرى — ولّد مرجعاً جديداً لكل حفظ');
  }
  return { id: prior.id };
}

/** جسم POST /entries/:id/cancel: سببٌ اختياري ≤ ٣٠٠ */
export function parseCancelBody(body: unknown): { reason: string | null } {
  const r = (body as { reason?: unknown } | null)?.reason;
  if (r == null || r === '') return { reason: null };
  if (typeof r !== 'string') throw fail('RETURN_INVALID', 'سبب الإلغاء نصّ', { field: 'reason' });
  const s = r.trim();
  if (s.length > 300) throw fail('RETURN_INVALID', 'سبب الإلغاء أطول من 300 حرف', { field: 'reason' });
  return { reason: s || null };
}

/** سياق اللوط للمرتجع (الميزة مفعّلة وفي الحركة صنفٌ متتبَّع): الأصناف مقفلة سلفاً، واليوم والفاعل */
export interface ReversalLotContext {
  locked: LotLocks;
  day: string;
  actor: LotActor;
  eventActor: LotEventActor;
}

export interface ReversalInput {
  kind: 'return' | 'cancel';
  tenantId: string;
  entryId: string;
  isApi: boolean;
  by: string | null;
  products: readonly ReversalProduct[];
  ret?: ReturnRequest;
  reason?: string | null;
}

export interface ReversalResult {
  /** حركة المرتجع المكتوبة (null: لا شيء متبقٍّ يُرجَع في الإلغاء) */
  returnEntryId: string | null;
  status: 'POSTED' | 'CANCELLED';
  /** سند الصرف الآلي الذي أُلغي مع إلغاء الوارد النقدي */
  cancelledPayment: PurchasePaymentRef | null;
  lotWarnings: LotWarning[];
}

const RETURN_NOTE_CANCEL = 'إلغاء الوارد';

/**
 * مرتجعٌ جزئي (kind=return) أو إلغاءٌ بمرتجعٍ كامل للمتبقّي (kind=cancel) لوارد، بعد قفل صفّه وأقفال أصنافه (المسار):
 *   - حركة RETURN جديدة مرتبطة بأصلها (returnOfEntryId) بكمياتٍ **سالبة** وبلقطة وحدة كل سطرٍ أصلي وتكلفته ونسبة ضريبته وسعره
 *     المُدخل — ولوطه عبر خطة اللوط (كتسوية إنقاصٍ سالبة؛ الميزة مطفأة أو الصنف غير متتبَّع ⇒ بلا لوط وبلا حارس رصيد، كسياسة
 *     التسوية السالبة القائمة).
 *   - لا يتجاوز المرتجع المتبقّي من كل سطر (409 RETURN_EXCEEDS_RECEIVED).
 *   - المصنَّف: قيد RETURN (−إجمالي المرتجع)، وCASH ⇒ REFUND_IN (+) — المورّد ردّ المال. الإجمالي: المتبقّي من الفاتورة حين يستنفد
 *     المرتجعُ ما بقي (والإلغاء دائماً)، وإلا حسابه مقيَّداً بالمتبقّي.
 *   - الإلغاء: الآجل بدفعاتٍ سارية ⇒ 409 BILL_HAS_PAYMENTS؛ النقدي ⇒ يُلغى سنده الآلي (PAYMENT_REV) ما لم يسبق للفاتورة مرتجع —
 *     وبعد أي مرتجعٍ (نقدياً كان أو خصماً من المستحق) يبقى السند ويُسجَّل ما بقي استرداداً نقدياً REFUND_IN: فلا يُحسب مال المرتجع
 *     النقدي مرّتين، ولا يُمحى إشعار مرتجع الخصم من رصيد المورّد. وغير المصنَّف: حركة RETURN بلا قيود مورّد. ثم status = CANCELLED.
 *   - المخزون الافتتاحي (بعموده أو بدفعة استيراده) لا يُلغى ولا يُرجَع: 409 ENTRY_NOT_RETURNABLE — يُصحَّح بتراجع دفعته.
 *   - مرجع العميل (ret.clientRef) يُحفظ على حركة المرتجع — المسار يقفله ويبحث به قبل هذه الدالّة (findReturnByClientRef).
 */
export async function reverseEntryTx(tx: Prisma.TransactionClient, input: ReversalInput, lot: ReversalLotContext | null): Promise<ReversalResult> {
  const { tenantId: tid, entryId, kind } = input;
  if (!(await lockEntryRow(tx, tid, entryId))) throw fail('ENTRY_NOT_FOUND', 'الحركة غير موجودة');
  const e = await readEntry(tx, tid, entryId);
  if (!e) throw fail('ENTRY_NOT_FOUND', 'الحركة غير موجودة');
  if (e.type !== 'RECEIVE') throw fail('ENTRY_NOT_RETURNABLE', kind === 'cancel' ? 'الإلغاء للوارد وحده — التسوية تُعكس بتسوية' : 'المرتجع للمورّد من وارد وحده');
  // المخزون الافتتاحي (بعموده أو بدفعة استيراده — الحركات السابقة للعمود 'MANUAL'): إلغاؤه حركة RETURN بكمياتٍ سالبة يعدّها حارس
  // «تراجع الاستيراد» نقصاً بعد الاستيراد فيحجب التراجع، ويحجب إعادة رفع الملف (الدفعة لم يُتراجع عنها والصنف صار له حركة) — طريقٌ
  // مسدود. تصحيحه بتراجع دفعته من صفحة الاستيراد (أو بتسوية مخزون)، لا بمرتجعٍ لمورّدٍ لا وجود له
  if (await isOpeningImportEntry(tx as unknown as ImportBatchDb, tid, e)) {
    throw fail('ENTRY_NOT_RETURNABLE', 'المخزون الافتتاحي لا يُلغى ولا يُرجَع لمورّد — صحّحه بـ«تراجع» دفعة الاستيراد من صفحة الاستيراد، أو بتسوية مخزون', { source: 'OPENING_IMPORT' });
  }
  if (e.status === 'CANCELLED') throw fail('ENTRY_ALREADY_CANCELLED', 'الوارد ملغى مسبقاً');
  const classified = !!e.paymentMode && !!e.vendorId && e.totalMilli != null;
  if (kind === 'return' && !classified) {
    throw fail('ENTRY_NOT_CLASSIFIED', 'صنّف الوارد (نقدي/آجل) قبل مرتجعه للمورّد — أو ألغه كاملاً');
  }

  // ── المرتجعات السابقة والمتبقّي من كل سطر ──
  const prior = (await tx.warehouseEntry.findMany({
    where: { tenantId: tid, type: 'RETURN', returnOfEntryId: e.id, status: { not: 'CANCELLED' } },
    select: { id: true, netMilli: true, taxMilli: true, totalMilli: true, items: { select: ITEM_SELECT } },
  })) as { id: string; netMilli: bigint | null; taxMilli: bigint | null; totalMilli: bigint | null; items: EntryRow['items'] }[];
  const left = remainingByItem(e.items, prior.flatMap((p) => p.items));

  // ── أسطر المرتجع: المطلوبة (مجمَّعة لكل سطر) أو كل المتبقّي ──
  const want = new Map<string, number>();
  if (kind === 'return') {
    for (const r of input.ret!.items) {
      if (!e.items.some((i) => i.id === r.itemId)) throw fail('RETURN_INVALID', 'السطر ليس من هذه الحركة', { itemId: r.itemId.slice(0, 64) });
      want.set(r.itemId, cleanQty((want.get(r.itemId) ?? 0) + r.qty));
    }
    for (const [itemId, q] of want) {
      const remaining = left.get(itemId) ?? 0;
      if (q > remaining + QTY_EPS) {
        const at = e.items.findIndex((i) => i.id === itemId);
        throw fail('RETURN_EXCEEDS_RECEIVED', `الكمية المرتجعة من السطر ${at + 1} أكبر من المتبقّي منه (${remaining})`, { itemId, requested: q, remaining });
      }
    }
  } else {
    for (const i of e.items) {
      const q = left.get(i.id) ?? 0;
      if (q > QTY_EPS) want.set(i.id, q);
    }
  }
  const retItems = e.items.filter((i) => want.has(i.id)).map((i) => ({ orig: i, qty: want.get(i.id) as number }));

  // ── الإلغاء: الآجل بدفعاتٍ سارية لا يُلغى ──
  if (kind === 'cancel' && classified && e.paymentMode === 'CREDIT') {
    const allocs = await tx.supplierPaymentAllocation.findMany({ where: { tenantId: tid, warehouseEntryId: e.id }, select: { paymentId: true } });
    const ids = [...new Set(allocs.map((a) => a.paymentId))];
    const live = ids.length ? await tx.supplierPayment.count({ where: { tenantId: tid, id: { in: ids }, status: { not: 'CANCELLED' } } }) : 0;
    if (live > 0) throw fail('BILL_HAS_PAYMENTS', 'على الفاتورة دفعات سارية — ألغِ سندات الصرف أولاً ثم ألغِ الوارد', { payments: live });
  }

  // ── التاريخ المحاسبي: المطلوب، وإلا يوم الشركة؛ ولا يسبق تاريخ الفاتورة ──
  const today = parseDay((await companyDay(tx, tid)).day) ?? utcDay(new Date());
  const billDay = e.billDate ? utcDay(e.billDate) : null;
  let docDate = input.ret?.billDate ?? today;
  if (billDay && docDate.getTime() < billDay.getTime()) {
    if (input.ret?.billDate) throw fail('RETURN_INVALID', 'تاريخ المرتجع قبل تاريخ فاتورة المورّد', { billDate: dayString(billDay) });
    docDate = billDay;
  }

  // ── الإجماليات (المصنَّف) ──
  let totals: BillTotals | null = null;
  if (classified && retItems.length) {
    const bill = { netMilli: e.netMilli ?? 0n, taxMilli: e.taxMilli ?? 0n, totalMilli: e.totalMilli as bigint };
    const residual = residualTotals(bill, prior.map((p) => ({ netMilli: p.netMilli ?? 0n, taxMilli: p.taxMilli ?? 0n, totalMilli: p.totalMilli ?? 0n })));
    const exhausts = e.items.every((i) => Math.abs((left.get(i.id) ?? 0) - (want.get(i.id) ?? 0)) <= QTY_EPS);
    totals = exhausts
      ? residual
      : capTotals(entryBillTotals(retItems.map((r) => ({ qty: r.qty, unitCost: r.orig.unitCost, enteredUnitCost: r.orig.enteredUnitCost, taxPct: r.orig.taxPct })), {
        costsIncludeTax: e.costsIncludeTax, vatTreatment: (e.vatTreatment as VatTreatment | null) ?? 'RECOVERABLE', decimals: await tenantCurrencyDecimals(tid),
      }), residual);
  }

  // ── خطة اللوط (الصنف المتتبَّع والميزة مفعّلة): نقصٌ من لوط السطر الأصلي كتسويةٍ سالبة ──
  let lotWarnings: LotWarning[] = [];
  const lotIdOf = new Map<number, string | null>();
  if (lot && retItems.length) {
    const byId = new Map(input.products.map((p) => [p.id, p]));
    const plan = await planWarehouseEntryInTx(tx, {
      tenantId: tid, type: 'RETURN', actor: lot.actor, createdBy: input.by, day: lot.day, allowUnknown: true, locked: lot.locked, eventActor: lot.eventActor,
      lines: retItems.map((r, idx) => {
        const tracked = lot.locked.tracked.has(r.orig.productId);
        return {
          idx, productId: r.orig.productId, productName: byId.get(r.orig.productId)?.name ?? '', shelfLifeOn: false,
          qty: unitFields(-r.qty, { name: r.orig.unitName, factor: r.orig.unitFactor }).baseQty, unitFactor: r.orig.unitFactor,
          // المتتبَّع: لوط سطره الأصلي صراحةً (أو غير المسمّى null) — والصريح لا يُقسَم على تشغيلات. وغيره بلا لوط (لا D9)
          ...(tracked && { lotId: r.orig.lotId ?? null }),
        };
      }),
    });
    lotWarnings = plan.warnings;
    for (const [idx, id] of plan.lotIdByLine) lotIdOf.set(idx, id);
  }

  // ── إلغاء النقدي: سنده الآلي يُلغى ما لم يسبق للفاتورة مرتجع؛ وبعد أي مرتجعٍ يبقى ويُستردّ ما بقي (يُحسم قبل الكتابة) ──
  let voidPayment: { id: string; number: number } | null = null;
  let refundRest = false;
  if (kind === 'cancel' && classified && e.paymentMode === 'CASH') {
    const auto = await tx.supplierPayment.findFirst({ where: { tenantId: tid, autoForEntryId: e.id, status: 'POSTED' }, select: { id: true, number: true } });
    if (auto) {
      // إلغاء السند كاملاً يقول «عاد إلينا كل المدفوع» — صحيحٌ حين لم يُرجَع شيءٌ قبله وحده. فبعد أي مرتجعٍ سابق يبقى السند ويُستردّ
      // المتبقّي وحده (REFUND_IN)، وأثر المرتجع السابق كما سُجّل:
      //   - مرتجعٌ رُدّ نقداً (REFUND_IN): مالُه عاد فعلاً، وإلغاء السند كاملاً يحسبه مرّتين.
      //   - مرتجعٌ «خصمٌ من المستحق» (CREDIT): إشعارٌ دائن لنا على المورّد — إلغاء السند كاملاً كان يحوّله نقداً عائداً بصمت ويمحو
      //     الإشعار من رصيده، وبمعاملةٍ تخالف الحالة الأولى (السند يبقى إن وُجد معه مرتجعٌ نقدي). فالخصم يبقى رصيداً مديناً على المورّد
      //     في الحالتين، والصندوق يستردّ ما ردّه المورّد فعلاً عن البضاعة الباقية.
      if (prior.length === 0) voidPayment = auto;
      else refundRest = true;
    }
  }

  // ── حركة المرتجع وقيودها ──
  let returnEntryId: string | null = null;
  const note = kind === 'cancel' ? (input.reason ?? RETURN_NOTE_CANCEL) : input.ret?.note ?? null;
  const refund = (kind === 'return' && input.ret?.refundMode === 'CASH') || refundRest;
  const refundRef = kind === 'return' ? formatPaidAccountRef(input.ret!.refundTo) : e.paidAccountRef ?? 'MAIN_CASH';
  if (retItems.length) {
    const created = await tx.warehouseEntry.create({
      data: {
        tenantId: tid, type: 'RETURN', returnOfEntryId: e.id, status: 'POSTED', source: input.isApi ? 'API' : 'MANUAL',
        note, supplier: e.supplier, createdBy: input.by,
        // مرجع منع التكرار للمرتجع الجزئي — بالنشر الشرطي: غائبٌ ⇒ العمود null كما كان
        ...(kind === 'return' && input.ret?.clientRef && { clientRef: input.ret.clientRef }),
        ...(e.vendorId && { vendorId: e.vendorId }),
        supplierRef: input.ret?.supplierRef ?? null,
        billDate: docDate,
        costsIncludeTax: e.costsIncludeTax,
        vatTreatment: e.vatTreatment,
        ...(classified && {
          paymentMode: refund ? 'CASH' : 'CREDIT',
          paidAccountRef: refund ? refundRef : null,
        }),
        ...(totals && { netMilli: totals.netMilli, taxMilli: totals.taxMilli, totalMilli: totals.totalMilli }),
        items: {
          create: retItems.map((r, idx) => ({
            productId: r.orig.productId,
            ...unitFields(-r.qty, { name: r.orig.unitName, factor: r.orig.unitFactor }),
            unitCost: r.orig.unitCost,
            taxPct: r.orig.taxPct,
            enteredUnitCost: r.orig.enteredUnitCost,
            lotId: lotIdOf.get(idx) ?? null,
            ...(r.orig.lineRef != null && { lineRef: r.orig.lineRef }),
          })),
        },
      },
      select: { id: true },
    });
    returnEntryId = created.id;
    if (classified && totals && totals.totalMilli > 0n) {
      await writeReturnLedgerTx(tx, tid, {
        id: created.id, type: 'RETURN', vendorId: e.vendorId, billDate: docDate, note,
        netMilli: totals.netMilli, taxMilli: totals.taxMilli, totalMilli: totals.totalMilli,
      }, { by: input.by, ref: input.ret?.supplierRef ?? e.supplierRef, refund });
    }
  }

  // ── الإلغاء: السند الآلي (PAYMENT_REV بتاريخ الإلغاء)، ثم الحالة ──
  let cancelledPayment: PurchasePaymentRef | null = null;
  if (voidPayment) {
    await cancelSupplierPaymentTx(tx, tid, voidPayment.id, { allowAuto: true, by: input.by, reason: input.reason ?? RETURN_NOTE_CANCEL, docDate });
    cancelledPayment = { id: voidPayment.id, number: voidPayment.number, displayNumber: supplierPaymentDisplayNumber(voidPayment.number) };
  }
  if (kind === 'cancel') await tx.warehouseEntry.update({ where: { id: e.id }, data: { status: 'CANCELLED' } });
  return { returnEntryId, status: kind === 'cancel' ? 'CANCELLED' : 'POSTED', cancelledPayment, lotWarnings };
}

/** حركةٌ بأسطرها للردّ بعد التصنيف/المرتجع/الإلغاء — بالشكل نفسه للسجلّ (entryJson) */
export async function readEntryForReply(db: Prisma.TransactionClient, tid: string, entryId: string, withLots: boolean): Promise<Record<string, unknown> | null> {
  const row = await db.warehouseEntry.findFirst({
    where: { id: entryId, tenantId: tid },
    include: {
      items: { include: { product: { select: { id: true, name: true, unit: true, primaryUnitId: true } }, ...(withLots && { lot: { select: { lotNumber: true, productionDate: true, expiryDate: true } } }) } },
      vendor: { select: { id: true, name: true } },
    },
  });
  return row ? entryJson(row) : null;
}
