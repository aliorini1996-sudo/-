/**
 * الشراء النقدي/الآجل ومرتجع المورّد في «مخزون الشركة» على الجوال (/m) — «ربط الدفاتر» L1 (طلب المالك ١٣ نوفمبر ٢٠٢٦).
 * دوال صرفة بلا React ولا api/client، فتُختبر في node (f2-mPurchaseLogic.test.ts).
 *
 * الحساب نفسه لا يُكتب هنا ثانيةً: المعاينة والأجسام من components/purchases/purchaseCalc.ts (مرآة entryBillTotals وreverseEntryTx
 * في الخادم، ويحرسها fix-purchasePreviewParity.test.ts بالمتجهات الذهبية المشتركة) — فما يراه مستخدم الجوال قبل الحفظ هو ما تراه
 * اللوحة وما يُقيَّد في كشف المورّد بفرق صفر. ما هنا خاصٌّ بالجوال: سطر النموذج بخانته النصية للنسبة، ووقائع صفّ السجلّ، وأسماء
 * مفاتيح الكاش.
 *
 * ⚠️ حارس «إزالة الضريبة» (taxOffMScreens.test.ts) يقرأ كل ملفٍّ في src/m: لا عبارة ضريبةٍ مرئية في هذا الملف — العبارات
 * في الشاشات خلف `!taxOff &&`.
 */
import type { PurchaseEntry, PurchaseEntryItem } from '../components/purchases/purchaseTypes';
import {
  adjustReasonLabel, dayOf, draftBillLines, draftBillTotals, entryActions, hasReturns, lineTaxPct, paidFromOf, remainingByItem,
  PURCHASE_ERROR_TEXT, serverCodeOf, type BillCostLine, type BillTotals,
} from '../components/purchases/purchaseCalc';
import type { PurchasePaidFrom, PurchasePaymentMode } from '../api/client';
import { LOT_CACHE_KEYS } from './mLotsLogic';

// ═══ سطر نموذج الوارد ═══

/** ما يلزم من سطر نموذج الجوال لحساب الشراء: الكمية والسعر نصّان كما كُتبا، ونسبة الصنف، والنسبة المكتوبة للسطر */
export interface MPurchaseRow {
  qty: string;
  unitCost: string;
  /** نسبة ضريبة الصنف (الافتراض) — رقم */
  taxPct: number;
  /** نسبة السطر كما كُتبت في الشراء المصنَّف — فارغةً تعني نسبة الصنف */
  taxText: string;
}

/**
 * نسبة السطر كما تُستعمل: المكتوبة، وفارغةً نسبة الصنف — فسطر «تسوية» من صفّ الرصيد قُلب وارداً (نسبته لم تُكتب) لا يُحسب
 * بصفرٍ صامت، ومسح الخانة لإعادة الكتابة لا يقفز بالرقم أثناء الكتابة (الخانة تعرض النصّ الخام والافتراض في placeholder)
 */
export function lineTaxText(r: Pick<MPurchaseRow, 'taxPct' | 'taxText'>): string {
  return r.taxText.trim() !== '' ? r.taxText : String(Number.isFinite(r.taxPct) ? r.taxPct : 0);
}

/** النسبة المرسَلة في سطر الشراء المصنَّف — صفرٌ مع «إزالة الضريبة» (المكتوب هو التكلفة) */
export function rowTaxPct(r: Pick<MPurchaseRow, 'taxPct' | 'taxText'>, taxOff: boolean): number {
  return lineTaxPct(lineTaxText(r), taxOff);
}

/** أسطر فاتورة المورّد من أسطر النموذج كما يكتبها الخادم: السعر كما كُتب ونسبة كل سطر الفعلية */
export function mDraftBillLines(rows: readonly MPurchaseRow[], opts: { inclusive: boolean; taxOff: boolean }): BillCostLine[] {
  return draftBillLines(rows.map(r => ({ qty: r.qty, unitCost: r.unitCost, taxPct: lineTaxText(r) })), opts);
}

/** ملخّص الشراء المصنَّف في نموذج الجوال = ما يقيّده الخادم (draftBillTotals ⇐ entryBillTotals) — كاللوحة حرفاً */
export function mDraftBillTotals(rows: readonly MPurchaseRow[], opts: { inclusive: boolean; taxOff: boolean }, decimals: number): BillTotals {
  return draftBillTotals(rows.map(r => ({ qty: r.qty, unitCost: r.unitCost, taxPct: lineTaxText(r) })), opts, decimals);
}

/**
 * قيمة السطر الصافية في الشراء المصنَّف = حصّته الدقيقة من صافي الفاتورة: الكمية × السعر المكتوب، ومن الشامل ÷ (١+النسبة) — بلا
 * تقريب الوحدة لأربع منازل (الخادم لا يحسب الفاتورة بالتكلفة المخزَّنة). فمجموع حصص الأسطر قبل التقريب = صافي الملخّص قبل تقريبه
 * (الخادم يقرّب لكل نسبة على مجموعها، فقد يخالف مجموعُ الأسطر المقرَّبة الصافيَ بهللة كأي فاتورة). null لسطرٍ بلا سعرٍ صالح
 * أو بكمية غير موجبة
 */
export function purchaseLineNet(r: MPurchaseRow, opts: { inclusive: boolean; taxOff: boolean }): number | null {
  const l = mDraftBillLines([r], opts)[0];
  if (!l || l.enteredUnitCost == null) return null;
  const pct = l.taxPct ?? 0;
  const gross = l.qty * l.enteredUnitCost;
  return opts.inclusive && !opts.taxOff && pct > 0 ? gross / (1 + pct / 100) : gross;
}

/** خانات النسبة لفحص purchaseProblem: السعر كما كُتب والنسبة الفعلية للسطر */
export function problemLines(rows: readonly MPurchaseRow[]): { unitCost: string; taxPct: string }[] {
  return rows.map(r => ({ unitCost: r.unitCost, taxPct: lineTaxText(r) }));
}

// ═══ الأخطاء ═══

/** نصّ رمز الشراء المعروف (قبل tr) وحده — وغيره null فتبقى رسالة الخادم كما كانت (لا يتغيّر عرض أخطاء الوارد القديمة) */
export function knownPurchaseError(e: unknown): string | null {
  const code = serverCodeOf(e);
  return code && Object.prototype.hasOwnProperty.call(PURCHASE_ERROR_TEXT, code) ? PURCHASE_ERROR_TEXT[code] : null;
}

// ═══ السجلّ ═══

/** صفّ السجلّ بلا اسم مورّدٍ نصّي (وارد الربط البرمجي بمعرّف المورّد وحده) يأخذ اسم المورّد المسجَّل — للعرض والإشعار المطبوع */
export function withVendorSupplier<E extends { supplier: string | null; vendor?: { name: string } | null }>(rows: readonly E[]): E[] {
  return rows.map(e => (!e.supplier && e.vendor?.name ? { ...e, supplier: e.vendor.name } : e));
}

export type MEntryKind = 'RECEIVE' | 'ADJUST' | 'RETURN';
/** نوع الحركة للعرض — نوعٌ لا تعرفه الواجهة يُعرض تسويةً كما كان */
export function entryKindOf(type: string): MEntryKind {
  return type === 'RECEIVE' ? 'RECEIVE' : type === 'RETURN' ? 'RETURN' : 'ADJUST';
}

/** وقائع صفّ السجلّ لسطر الشراء (مرآة EntryPurchaseInfo في اللوحة) */
export interface MEntryFacts {
  kind: MEntryKind;
  cancelled: boolean;
  /** في السجلّ حركة مرتجع تابعة لهذا الوارد */
  returned: boolean;
  mode: PurchasePaymentMode | null;
  paidFrom: { kind: PurchasePaidFrom; repId?: string } | null;
  /** وارد بلا نوع شراء (ليس افتتاحياً) — يُصنَّف من زرّه */
  unclassified: boolean;
  opening: boolean;
  api: boolean;
  /** وسم سبب التسوية (قبل tr) */
  reason: string | null;
  supplierRef: string | null;
  billDay: string | null;
  dueDay: string | null;
  /** المبالغ للمصنَّف وللمرتجع وحدهما — الوارد غير المصنَّف يبقى بقيمة البضاعة القائمة */
  showTotals: boolean;
  net: number;
  tax: number;
  total: number;
  /** المتبقّي على الآجل (null إن لم يرسله الخادم) */
  outstanding: number | null;
  overdue: boolean;
}

const EPS = 1e-9;
const isMode = (m: unknown): m is PurchasePaymentMode => m === 'CASH' || m === 'CREDIT';

/**
 * وقائع الصفّ — null حين لا يرسل الخادم حالة الحركة (خادمٌ أقدم): الصفّ يبقى كما كان حرفاً. `today` يوم 'YYYY-MM-DD' للمقارنة
 * بالاستحقاق (يوم الجهاز كاللوحة)
 */
export function entryFacts(e: PurchaseEntry, all: readonly PurchaseEntry[], today: string): MEntryFacts | null {
  if (e.status == null) return null;
  const kind = entryKindOf(e.type);
  const mode = isMode(e.paymentMode) ? e.paymentMode : null;
  const cancelled = e.status === 'CANCELLED';
  const dueDay = dayOf(e.dueDate);
  const outstanding = typeof e.outstanding === 'number' && Number.isFinite(e.outstanding) ? e.outstanding : null;
  return {
    kind,
    cancelled,
    returned: kind === 'RECEIVE' && hasReturns(e.id, all),
    mode: kind === 'RECEIVE' ? mode : null,
    paidFrom: kind === 'RECEIVE' && mode === 'CASH' ? paidFromOf(e.paidAccountRef) : null,
    unclassified: kind === 'RECEIVE' && !mode && e.source !== 'OPENING_IMPORT',
    opening: e.source === 'OPENING_IMPORT',
    api: e.source === 'API',
    reason: kind === 'ADJUST' ? adjustReasonLabel(e.reason) : null,
    supplierRef: e.supplierRef ? e.supplierRef : null,
    billDay: dayOf(e.billDate),
    dueDay,
    showTotals: typeof e.total === 'number' && Number.isFinite(e.total) && (mode !== null || kind === 'RETURN'),
    // المرتجع يصل بإشارته السالبة — يُعرض بقيمته المطلقة ونوعه يقول اتجاهه
    net: Math.abs(e.net ?? 0),
    tax: Math.abs(e.tax ?? 0),
    total: Math.abs(e.total ?? 0),
    outstanding,
    overdue: mode === 'CREDIT' && !cancelled && outstanding != null && outstanding > EPS && !!dueDay && dueDay < today,
  };
}

/** أفعال الصفّ في الجوال: من يصل شاشة المستودع يسجّل حركاتها (القسم خلف صلاحية مخزون السيارات)، والخادم هو الحَكَم */
export function mEntryActions(e: PurchaseEntry, all: readonly PurchaseEntry[]): { classify: boolean; ret: boolean; cancel: boolean } {
  const anyRemaining = e.type === 'RECEIVE' && isMode(e.paymentMode) && [...remainingByItem(e, all).values()].some(q => q > EPS);
  return entryActions(e, { canEdit: true, anyRemaining });
}

export type MEntryTypeFilter = '' | 'RECEIVE' | 'ADJUST' | 'RETURN';
export const ENTRY_TYPE_FILTERS: readonly MEntryTypeFilter[] = ['', 'RECEIVE', 'ADJUST', 'RETURN'];
export const ENTRY_TYPE_FILTER_LABELS: Record<MEntryTypeFilter, string> = {
  '': 'كل الحركات', RECEIVE: 'وارد', ADJUST: 'تسوية', RETURN: 'مرتجع للمورد',
};

/** معاملات فلتر السجلّ — بلا فلتر undefined فيبقى الطلب كما كان حرفاً (GET /warehouse/entries بلا معاملات) */
export function entriesFilterOf(vendorId: string | null | undefined, type: MEntryTypeFilter): { vendorId?: string; type?: 'RECEIVE' | 'ADJUST' | 'RETURN' } | undefined {
  if (!vendorId && !type) return undefined;
  return { ...(vendorId && { vendorId }), ...(type && { type }) };
}

// ═══ التصنيف والمرتجع والإلغاء ═══
// ملخّصا التصنيف والمرتجع لا يُحسبان هنا: classifyPreview وreturnPreview من purchaseCalc مباشرةً (مرآة الخادم نفسها التي تستعملها اللوحة)

/** يوم الاستلام بتوقيت الجهاز — افتراض تاريخ فاتورة المورّد في التصنيف لواردٍ لم يُسجَّل له تاريخ */
export function receiptDayOf(createdAt: string, now: () => Date = () => new Date()): string {
  const d = new Date(createdAt);
  return (Number.isNaN(d.getTime()) ? now() : d).toLocaleDateString('en-CA');
}

const pricedCost = (i: Pick<PurchaseEntryItem, 'unitCost'>): number | null =>
  typeof i.unitCost === 'number' && Number.isFinite(i.unitCost) && i.unitCost > 0 ? i.unitCost : null;

/** أسطر الوارد في التصنيف: الموجبة وحدها (الوارد كميّاته موجبة) */
export function classifyItems<I extends Pick<PurchaseEntryItem, 'qty'>>(items: readonly I[]): I[] {
  return items.filter(i => i.qty > 0);
}

/** الأسطر غير المسعَّرة — ما يُكتب سعره في التصنيف (السعر القائم لا يتغيّر) */
export function unpricedItems<I extends Pick<PurchaseEntryItem, 'qty' | 'unitCost'>>(items: readonly I[]): I[] {
  return classifyItems(items).filter(i => pricedCost(i) == null);
}

/**
 * عرض المرتجع بلا ضريبة (سطرا الصافي والضريبة مخفيّان): «إزالة الضريبة» أو وارد مسجَّل بلا ضريبة (vatTreatment NONE). للعرض وحده —
 * الحساب (returnPreview) بمعاملة ضريبة الوارد كما يفعل الخادم
 */
export function returnNoTax(e: Pick<PurchaseEntry, 'vatTreatment'>, taxOff: boolean): boolean {
  return taxOff || e.vatTreatment === 'NONE';
}

/** افتراض تسوية قيمة المرتجع: النقدي يُستردّ إلى مصدر دفعه (البنك للبنك وإلا الصندوق)، والآجل يُخصم من المستحقّ */
export function returnDefaults(e: Pick<PurchaseEntry, 'paymentMode' | 'paidAccountRef'>): { refundMode: 'CREDIT' | 'CASH'; refundTo: 'MAIN_CASH' | 'BANK' } {
  return {
    refundMode: e.paymentMode === 'CASH' ? 'CASH' : 'CREDIT',
    refundTo: paidFromOf(e.paidAccountRef)?.kind === 'BANK' ? 'BANK' : 'MAIN_CASH',
  };
}

/** آجلٌ عليه دفعات سارية — الإلغاء ممنوع حتى تُلغى سنداته (409 BILL_HAS_PAYMENTS)؛ يُقال قبل الإرسال */
export function paidOnCredit(e: Pick<PurchaseEntry, 'paymentMode' | 'paid'>): boolean {
  return e.paymentMode === 'CREDIT' && (e.paid ?? 0) > EPS;
}

/** آثار الإلغاء كما تُقال للمستخدم قبل التأكيد (قبل tr) */
export function cancelEffects(e: Pick<PurchaseEntry, 'paymentMode'>): string[] {
  const mode = isMode(e.paymentMode) ? e.paymentMode : null;
  return [
    'تسجل حركة مرتجع بكل ما بقي من بضاعة الوارد فتخرج كمياتها من رصيد المستودع',
    ...(mode === 'CASH' ? ['يلغى سند الصرف الآلي للمورد وتعود قيمته إلى مصدر الدفع'] : []),
    ...(mode === 'CREDIT' ? ['يعكس المستحق للمورد عن هذه الفاتورة'] : []),
    'تبقى الحركة في السجل موسومة ملغاة ولا يمكن التراجع عن الإلغاء',
  ];
}

// ═══ الكاش ═══

/** مفاتيح الجوال لشاشة المستودع — تُبطل مع مفاتيح اللوحة (الحزمة واحدة والكاش مشترك) */
export const M_WH_KEYS = ['m-wh-stock', 'm-wh-entries'] as const;

/** ما يُبطل بعد حركة شراء أو تصنيف أو مرتجع أو إلغاء: الجوال + `base` (مفاتيح اللوحة والموردين) + التشغيلات حين الميزة مفعّلة — بلا تكرار */
export function invalidateKeys(base: readonly string[], lotOn: boolean): string[] {
  return [...new Set<string>([...M_WH_KEYS, ...base, ...(lotOn ? LOT_CACHE_KEYS : [])])];
}

// ═══ سبب تسوية سيارة المندوب ═══

/** أسباب تسوية السيارة (VAN_ADJUST_REASONS في الخادم) ووسومها — SHORTAGE_REP عجزٌ يُحمَّل على المندوب */
export const VAN_REASON_LABELS: Record<string, string> = {
  COUNT: 'جرد', DAMAGE: 'تالف', EXPIRY: 'منتهي الصلاحية', SHORTAGE_REP: 'عجز على المندوب', SAMPLE: 'عينات', OTHER: 'أخرى',
};

/** وسم سبب تسوية السيارة لحركة ADJUST وحدها — سببٌ غائب أو مجهول ⇒ null فلا يُعرض شيء (خادمٌ أقدم كما كان) */
export function vanReasonLabel(m: { kind: string; reason?: string | null }): string | null {
  if (m.kind !== 'ADJUST' || !m.reason) return null;
  return Object.prototype.hasOwnProperty.call(VAN_REASON_LABELS, m.reason) ? VAN_REASON_LABELS[m.reason] : null;
}
