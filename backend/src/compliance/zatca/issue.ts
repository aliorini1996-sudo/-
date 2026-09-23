// ============================================================================
// ZATCA المرحلة الثانية (Z5.2) — نواة الإصدار النقيّة: من فاتورة المنصّة إلى مصدر Z1، والتحضير قبل القفل، والمبالغ المخزَّنة
// ----------------------------------------------------------------------------
// z5_plan §2.2 (قبل المعاملة) + §2.4 (D6) + §3 Z5.2 (issue.ts) + نقد الخطة (12، 19، 24، 26) + قرارات المالك D2/Q2 وD6 وD9:
//   • buildInvoiceSource: البائع من CompanySettings (sellerSourceFromSettings)، المشتري من صفّ العميل بأرقام لاتينية
//     (buyerSourceFromCustomer — كما تحكم قائمة D2)، البنود بترتيب الطلب (seq = 1..n) بفئة الصنف الضريبية وtaxPct = item ?? الشركة،
//     وحدة القياس PCE (Product.unitCode رمز ETA؛ ربطه خارج v1)، وطريقة الدفع INSTALLMENT لخطة الأقساط وإلا type.
//   • النوع الفرعي (D2/Q2): classifyBuyerSubtype — النوع الصريح BUSINESS/GOVERNMENT أو رقم ضريبي أو سجل تجاري ⇒ 01؛ غير المصنّف
//     (قناة، اسم منشأة، معرّف منشأة وحده) مبسّطة 02 حتى يُصنَّف — القاعدة الحيّة نفسها في customerBuyerStatus (Z5.1a).
//   • 01 ببيانات مشترٍ ناقصة ⇒ 422 ZATCA_BUYER_INCOMPLETE (قبل أي قفل)؛ العملة غير SAR ⇒ 422 ZATCA_CURRENCY (D9).
//   • تاريخ التوريد (نقد 24، F16): طلب المدير للقياسية وحدها — لا بعد تاريخ الإصدار، ولا أقدم من أول الشهر السابق إن صدرت
//     الفاتورة حتى اليوم 15 (وإلا أول الشهر الجاري) — اللائحة التنفيذية م53: الفاتورة الضريبية خلال 15 يوماً من نهاية شهر التوريد.
//     المبسّطة: تاريخ التوريد = تاريخ الإصدار دائماً (يُهمل المُرسل).
//   • مخالفات بيانات البائع ⇒ 503 ZATCA_UNIT_UNAVAILABLE (SELLER_NOT_READY) لا 422 على المندوب (نقد 12): يصحّحها المدير.
//   • المبالغ المخزَّنة لصفوف المرحلة الثانية (§2.4): taxAmt = TaxTotal، وضريبة كل بند = ضريبة سطره في الـXML، وsubtotal − discountAmt
//     = TaxExclusive (discountAmt قيمة المحرّك والفرق في subtotal)، وtotal = إجمالي المحرّك = PayableAmount (السعر المعلن، D6)،
//     فيكون total − subtotal + discountAmt − taxAmt = PayableRoundingAmount («فرق تقريب») ∈ {0.00، 0.01، 0.02}.
//   • تصنيف P2002 (نقد 26): clientRef ⇒ الفاتورة القائمة؛ number ⇒ إعادة الترقيم؛ قيود zatca_documents ⇒ تعارض سلسلة بلا إعادة.
// لا قاعدة بيانات ولا شبكة ولا services/gl. لا يستدعي الهيئة أبداً.
// ============================================================================

import { classifyBuyerSubtype } from './buyerParty';
import { buyerSourceFromCustomer, customerBuyerStatus, missingBuyerFormFields, type BuyerRowLike } from './buyerData';
import { INITIAL_PIH, newInvoiceUuid } from './crypto';
import { parseAmount } from './decimal';
import { DocumentBytesError } from './documentStore';
import {
  buyerIncompleteError, isChainUniqueViolation, preflightHttpError, toZatcaHttpError, UNIT_UNAVAILABLE_MESSAGES, ZatcaHttpError,
} from './errors';
import {
  buildSnapshot, mapInvoiceToUbl, preflightKindOf, type ChainValues, type DocumentKind, type InvoiceSource, type InvoiceSubtype, type LineSource,
  type ZatcaSnapshotV1,
} from './mapInvoice';
import { ZatcaInputError, type InvoiceTypeCode, type UblDocument, type ZatcaIssue } from './model';
import { sellerSourceFromSettings } from './onboarding';
import type { SellerSettingsRecord } from './onboardingStore';
import { preflightIssues } from './preflight';
import { mirrorQrOf, mirrorStatusOf, type InvoiceMirrorStatus } from './status';
import { riyadhParts } from './time';

// ─── المدخلات ───

/** وحدة القياس في المرحلة الثانية (UN/ECE Rec 20): Product.unitCode رمز ETA وربطه خارج v1. */
export const PHASE2_UNIT_CODE = 'PCE';
/** رقم مؤقت بشكل الرقم الحقيقي للتحويل قبل القفل (الرقم الفعلي يُولَّد داخل القفل؛ لا يدخل المبالغ ولا QR). */
export const PLACEHOLDER_INVOICE_NUMBER = 'INV-0000-000000';
export const ISSUANCE_CURRENCY = 'SAR';

/** CompanySettings كما يحمّلها الإصدار (بيانات البائع + الدولة والعملة والمزوّد). */
export type IssuanceSellerSettings = SellerSettingsRecord;

/** صفّ العميل (أعمدة الفوترة + الاسم والقناة) بمعرّفه. */
export type IssuanceCustomer = BuyerRowLike & { id: string };

export interface IssuanceProduct {
  id: string;
  name: string;
  vatCategory?: string | null;
  vatExemptionCode?: string | null;
  vatExemptionReason?: string | null;
}

export interface IssuanceItemInput {
  productId: string;
  qty: number;
  unitPrice: number;
  discountPct?: number | null;
  taxPct?: number | null;
}

/** جسم POST /invoices بعد تحقق zod (الحقول التي تمسّ المستند وحدها). */
export interface IssuanceRequest {
  type: string;
  paymentPlan?: string | null;
  pricesIncludeTax: boolean;
  /** خصم الفاتورة الكلّي %. */
  discountPct?: number | null;
  items: readonly IssuanceItemInput[];
  /** تاريخ التوريد الذي يطلبه المدير (invoiceDate من اللوحة و/m) — null لتطبيق المندوب. يُحترم للقياسية وحدها. */
  supplyDate?: string | null;
}

/** الإشعارات (Z5.5): الأصل ونوعه وطريقة دفعه وسبب الإشعار. */
export interface IssuanceNoteContext {
  originalNumber: string;
  originalSubtype: InvoiceSubtype;
  originalPaymentType: string;
  reason: string;
}

export interface BuildInvoiceSourceInput {
  settings: IssuanceSellerSettings;
  customer: IssuanceCustomer;
  products: readonly IssuanceProduct[];
  request: IssuanceRequest;
  /** ضريبة الشركة الافتراضية (defaultVatPct ?? 15) — نفسها التي مُرِّرت للمحرّك. */
  companyVat: number;
  kind?: DocumentKind;
  note?: IssuanceNoteContext | null;
  /** رقم الفاتورة (داخل القفل)؛ غيابه ⇒ PLACEHOLDER_INVOICE_NUMBER. */
  number?: string;
}

const issue = (rule: string, field: string, messageAr: string): ZatcaIssue => ({ rule, field, messageAr, severity: 'error' });

/** العملة الفعلية للمستند: تجاوز العملة إن ضُبط وإلا عملة الدولة (بأحرف كبيرة). */
export function effectiveIssuanceCurrency(settings: Pick<IssuanceSellerSettings, 'currency' | 'currencyOverride'>): string {
  const o = typeof settings.currencyOverride === 'string' ? settings.currencyOverride.trim().toUpperCase() : '';
  return o !== '' ? o : String(settings.currency ?? '').trim().toUpperCase();
}

/** D9: عملة الشركة SAR وتجاوزها فارغ أو SAR. */
export function currencyAllowed(settings: Pick<IssuanceSellerSettings, 'currency' | 'currencyOverride'>): boolean {
  const base = String(settings.currency ?? '').trim().toUpperCase();
  const o = typeof settings.currencyOverride === 'string' ? settings.currencyOverride.trim().toUpperCase() : '';
  return base === ISSUANCE_CURRENCY && (o === '' || o === ISSUANCE_CURRENCY);
}

/** النوع الفرعي المجمَّد: الإشعار يرث أصله؛ الفاتورة من بيانات العميل الحالية (D2/Q2). */
export function issuanceSubtype(customer: BuyerRowLike, kind: DocumentKind = 'INVOICE', note?: IssuanceNoteContext | null): InvoiceSubtype {
  if (kind !== 'INVOICE' && note && (note.originalSubtype === '01' || note.originalSubtype === '02')) return note.originalSubtype;
  return classifyBuyerSubtype(buyerSourceFromCustomer(customer));
}

/** CASH | CREDIT | INSTALLMENT للفاتورة؛ طريقة دفع الأصل للإشعار (BR-49). RETURN على فاتورة ⇒ 422 يلزم الأصل. */
export function issuancePaymentType(request: Pick<IssuanceRequest, 'type' | 'paymentPlan'>, kind: DocumentKind = 'INVOICE', note?: IssuanceNoteContext | null): string {
  if (kind !== 'INVOICE') {
    if (!note || typeof note.originalPaymentType !== 'string' || note.originalPaymentType === '') {
      throw new ZatcaInputError('MAPPING_INPUT', [issue('BR-49', 'paymentMeansCode', 'طريقة دفع الفاتورة الأصلية مفقودة للإشعار')]);
    }
    return note.originalPaymentType;
  }
  if (request.type === 'RETURN') throw new ZatcaHttpError('ZATCA_RETURN_NEEDS_ORIGINAL');
  return request.paymentPlan === 'INSTALLMENT' ? 'INSTALLMENT' : request.type;
}

/** مصدر Z1 من فاتورة المنصّة (نقيّ، لا يفحص الاكتمال — ذاك prepareIssuance وpreflight). */
export function buildInvoiceSource(input: BuildInvoiceSourceInput): InvoiceSource {
  const kind: DocumentKind = input.kind ?? 'INVOICE';
  const subtype = issuanceSubtype(input.customer, kind, input.note);
  const byId = new Map(input.products.map(p => [p.id, p]));
  const missing: ZatcaIssue[] = [];
  const items: LineSource[] = input.request.items.map((it, i) => {
    const p = byId.get(it.productId);
    if (!p) missing.push(issue('BR-25', `items[${i}].productId`, `الصنف في البند ${i + 1} غير موجود أو غير نشط`));
    const line: LineSource = {
      itemName: p?.name ?? '',
      unitCode: PHASE2_UNIT_CODE,
      qty: it.qty,
      unitPrice: it.unitPrice,
      discountPct: it.discountPct ?? 0,
      taxPct: it.taxPct ?? input.companyVat,
      vatCategory: p?.vatCategory ?? null,
      vatExemptionCode: p?.vatExemptionCode ?? null,
      vatExemptionReason: p?.vatExemptionReason ?? null,
    };
    return line;
  });
  if (missing.length) throw new ZatcaInputError('MAPPING_INPUT', missing);
  const src: InvoiceSource = {
    kind,
    number: input.number ?? PLACEHOLDER_INVOICE_NUMBER,
    currency: effectiveIssuanceCurrency(input.settings),
    pricesIncludeTax: input.request.pricesIncludeTax === true,
    invoiceDiscountPct: input.request.discountPct ?? 0,
    paymentType: issuancePaymentType(input.request, kind, input.note),
    // F16/نقد 24: تاريخ المدير للقياسية وحدها؛ null ⇒ تاريخ الإصدار (mapInvoice)
    supplyDate: subtype === '01' && typeof input.request.supplyDate === 'string' && input.request.supplyDate.trim() !== '' ? input.request.supplyDate.trim() : null,
    subtype,
    seller: sellerSourceFromSettings(input.settings),
    buyer: buyerSourceFromCustomer(input.customer),
    items,
  };
  if (kind !== 'INVOICE' && input.note) {
    src.billingReferences = [input.note.originalNumber];
    src.noteReason = input.note.reason;
  }
  return src;
}

// ─── تاريخ التوريد ───

const pad2 = (n: number) => String(n).padStart(2, '0');

/** أقدم تاريخ توريد مقبول لفاتورة ضريبية تصدر في issueDate (YYYY-MM-DD بتوقيت الرياض). */
export function supplyDateLowerBound(issueDate: string): string {
  const [y, m, d] = issueDate.split('-').map(Number);
  let yy = y;
  let mm = m;
  if (d <= 15) {
    mm -= 1;
    if (mm === 0) { mm = 12; yy -= 1; }
  }
  return `${String(yy).padStart(4, '0')}-${pad2(mm)}-01`;
}

/** قاعدة تاريخ التوريد على المستند المبني (القياسية وحدها): لا مستقبلي، ولا أقدم من الحدّ. */
export function supplyDateIssues(doc: Pick<UblDocument, 'typeName' | 'issueDate' | 'supplyDate'>): ZatcaIssue[] {
  if (typeof doc.typeName !== 'string' || !doc.typeName.startsWith('01')) return [];
  const s = doc.supplyDate;
  if (typeof s !== 'string' || s === '' || s === doc.issueDate) return [];
  if (s > doc.issueDate) {
    return [issue('KSA-VATIR-53', 'supplyDate', `تاريخ التوريد (${s}) بعد تاريخ إصدار الفاتورة (${doc.issueDate}) — لا يُقبل تاريخ توريد مستقبلي`)];
  }
  const lb = supplyDateLowerBound(doc.issueDate);
  if (s < lb) {
    return [issue('KSA-VATIR-53', 'supplyDate', `تاريخ التوريد (${s}) أقدم من المسموح — الفاتورة الضريبية تُصدر خلال 15 يوماً من نهاية شهر التوريد (أقدم تاريخ مقبول ${lb})`)];
  }
  return [];
}

// ─── المخالفات ⇒ خطأ HTTP ───

/**
 * مخالفات الفحص المسبق (وقاعدة تاريخ التوريد) ⇒ خطأ الإصدار، أو null إن لم تمنع. بيانات البائع (supplier.*) لا يصحّحها المندوب:
 * 503 ZATCA_UNIT_UNAVAILABLE بسبب SELLER_NOT_READY وبالقائمة (نقد 12)؛ وغيرها preflightHttpError (422).
 */
export function issuanceIssuesError(issues: readonly ZatcaIssue[]): ZatcaHttpError | null {
  const blocking = issues.filter(i => i.severity === 'error');
  if (blocking.length === 0) return null;
  if (blocking.some(i => i.field === 'supplier' || i.field.startsWith('supplier.'))) {
    return new ZatcaHttpError('ZATCA_UNIT_UNAVAILABLE', {
      reason: 'SELLER_NOT_READY', messageAr: UNIT_UNAVAILABLE_MESSAGES.SELLER_NOT_READY, issues: [...issues],
      logDetail: { source: 'PREFLIGHT', code: 'SELLER' },
    });
  }
  return preflightHttpError(issues);
}

/** يحوّل ويفحص: ZatcaInputError من التحويل ⇒ ZatcaHttpError؛ المخالفات المانعة ⇒ ZatcaHttpError. يعيد المستند والتحذيرات. */
export function mapAndCheck(src: InvoiceSource, chain: ChainValues, opts: { qrMaxLength?: number } = {}): { doc: UblDocument; warnings: ZatcaIssue[] } {
  let doc: UblDocument;
  try {
    doc = mapInvoiceToUbl(src, chain);
  } catch (e) {
    if (e instanceof ZatcaInputError) throw toZatcaHttpError(e) as ZatcaHttpError;
    throw e;
  }
  const issues = [...preflightIssues(doc, preflightKindOf(doc), { qrMaxLength: opts.qrMaxLength }), ...supplyDateIssues(doc)];
  const err = issuanceIssuesError(issues);
  if (err) throw err;
  return { doc, warnings: issues.filter(i => i.severity !== 'error') };
}

// ─── المبالغ المخزَّنة (§2.4، D6) ───

/** ما يعيده computeInvoiceTotals (lib/invoiceCalc.ts) — بخانتين (SAR). */
export interface EngineTotals {
  subtotal: number;
  discountAmt: number;
  taxAmt: number;
  total: number;
  items: ReadonlyArray<{ taxAmt: number }>;
}

export interface StoredAmounts {
  subtotal: number;
  discountAmt: number;
  taxAmt: number;
  total: number;
  /** «فرق تقريب» المطبوع = BT-114 (0 حين لا يُكتب). */
  payableRounding: number;
  /** ضريبة كل بند = KSA-11 لسطره، بترتيب البنود. */
  items: Array<{ taxAmt: number }>;
  /** subtotal المخزَّن − subtotal المحرّك بالهللات (0 في الحصري؛ ±هللة لكل نسبة في الشامل) — للتتبّع. */
  subtotalAdjustmentHalalas: number;
}

const amountsConflict = (rule: string, messageAr: string) => new ZatcaInputError('ENGINE_ROUNDING_CONFLICT', [issue(rule, 'totals', messageAr)]);

function engineHalalas(x: number, what: string): bigint {
  const scaled = x * 100;
  const h = Math.round(scaled);
  if (!Number.isFinite(x) || !Number.isSafeInteger(h) || Math.abs(scaled - h) > 1e-6) {
    throw amountsConflict('ENGINE-DECIMALS', `قيمة المحرّك ${what} ليست مبلغاً بخانتين عشريتين`);
  }
  return BigInt(h);
}

const halalasToNumber = (h: bigint): number => Number(h) / 100;

/**
 * §2.4: مبالغ صفّ المرحلة الثانية من المحرّك ومستند UBL. يرمي ZatcaInputError(ENGINE_ROUNDING_CONFLICT) ⇒ 422 ZATCA_AMOUNTS
 * إن لم يطابق إجمالي المحرّك PayableAmount (السعر المعلن)، أو اختلف عدد البنود، أو خرج التقريب عن نطاقه.
 */
/** ما يحتاجه حساب المبالغ من المستند (UblDocument أو ناتج computeUblAmountsDetailed). */
export interface AmountsDocLike {
  totals: UblDocument['totals'];
  lines: ReadonlyArray<{ taxAmount: string }>;
  subtotals: ReadonlyArray<{ category: string }>;
}

export function storedAmounts(engine: EngineTotals, doc: AmountsDocLike, opts: { pricesIncludeTax: boolean }): StoredAmounts {
  const t = doc.totals;
  const payable = parseAmount(t.payable);
  const taxTotal = parseAmount(t.taxTotal);
  const taxExclusive = parseAmount(t.taxExclusive);
  const taxInclusive = parseAmount(t.taxInclusive);
  const rounding = t.payableRounding === undefined ? 0n : parseAmount(t.payableRounding);
  const engineTotal = engineHalalas(engine.total, 'total');
  const engineDiscount = engineHalalas(engine.discountAmt, 'discountAmt');
  const engineSubtotal = engineHalalas(engine.subtotal, 'subtotal');
  const engineTax = engineHalalas(engine.taxAmt, 'taxAmt');

  if (engineTotal !== payable) {
    throw amountsConflict('D6-PAYABLE', `إجمالي الفاتورة (${halalasToNumber(engineTotal).toFixed(2)}) لا يطابق المبلغ المستحق في المستند (${t.payable})`);
  }
  if (engine.items.length !== doc.lines.length) throw amountsConflict('D6-LINES', 'عدد بنود المحرّك لا يطابق بنود المستند');
  const lineTaxes = doc.lines.map(l => parseAmount(l.taxAmount));
  if (lineTaxes.reduce((s, v) => s + v, 0n) !== taxTotal) throw amountsConflict('BR-CO-14', 'مجموع ضرائب البنود لا يساوي إجمالي الضريبة');
  if (payable - taxInclusive !== rounding) throw amountsConflict('BR-CO-16', 'فرق التقريب لا يساوي المستحق ناقص الإجمالي شامل الضريبة');
  // بقية كل نسبة قياسية ∈ {0، هللة} (برهان amounts.ts)؛ الفئات Z/E/O بلا بقية
  const standardBuckets = BigInt(doc.subtotals.filter(s => s.category === 'S').length);
  if (rounding < 0n || rounding > standardBuckets) throw amountsConflict('D6-ROUNDING', `فرق التقريب ${t.payableRounding} خارج النطاق المسموح`);

  const subtotal = taxExclusive + engineDiscount;
  if (subtotal < 0n) throw amountsConflict('D6-SUBTOTAL', 'الإجمالي قبل الخصم سالب');
  if (!opts.pricesIncludeTax && (subtotal !== engineSubtotal || taxTotal !== engineTax || rounding !== 0n)) {
    // الحصري: المحرّك والمستند متطابقان بالبناء (amounts.ts) — أي فرق خلل لا تقريب
    throw amountsConflict('D6-EXCLUSIVE', 'مبالغ الفاتورة (الأسعار قبل الضريبة) لا تطابق المستند');
  }
  return {
    subtotal: halalasToNumber(subtotal),
    discountAmt: halalasToNumber(engineDiscount),
    taxAmt: halalasToNumber(taxTotal),
    total: halalasToNumber(engineTotal),
    payableRounding: halalasToNumber(rounding),
    items: lineTaxes.map(v => ({ taxAmt: halalasToNumber(v) })),
    subtotalAdjustmentHalalas: Number(subtotal - engineSubtotal),
  };
}

// ─── التحضير قبل القفل (§2.2 «Before the transaction») ───

export interface IssuanceItemSnapshot {
  seq: number;
  itemName: string;
  unitCode: string;
  vatCategory: string;
  vatExemptionCode: string | null;
  vatExemptionReason: string | null;
  taxAmt: number;
}

export interface PrepareIssuanceInput extends BuildInvoiceSourceInput {
  engine: EngineTotals;
  now: Date;
  qrMaxLength?: number;
  newUuid?: () => string;
}

export interface PreparedIssuance {
  kind: DocumentKind;
  subtype: InvoiceSubtype;
  stampKind: 'standard' | 'simplified';
  typeCode: InvoiceTypeCode;
  typeName: string;
  customerId: string;
  /** مصدر Z1 برقم مؤقت (الرقم الحقيقي داخل القفل). */
  src: InvoiceSource;
  amounts: StoredAmounts;
  items: IssuanceItemSnapshot[];
  /** بصمة مبالغ المستند (لا تعتمد على السلسلة): تُطابَق داخل القفل. */
  amountsFingerprint: string;
  warnings: ZatcaIssue[];
  qrMaxLength?: number;
}

/** بصمة المبالغ والبنود كما ستُكتب (بلا الرقم والتواريخ وقيم السلسلة). */
export function amountsFingerprintOf(doc: Pick<UblDocument, 'totals' | 'subtotals' | 'docAllowances' | 'lines'>): string {
  return JSON.stringify({
    totals: doc.totals, subtotals: doc.subtotals, docAllowances: doc.docAllowances,
    lines: doc.lines.map(l => [l.id, l.name, l.quantity, l.unitCode, l.priceAmount, l.allowance ?? null, l.lineExtension, l.vat, l.taxAmount, l.roundingAmount]),
  });
}

function itemSnapshotsOf(doc: UblDocument, amounts: StoredAmounts): IssuanceItemSnapshot[] {
  return doc.lines.map((l, i) => ({
    seq: l.id,
    itemName: l.name,
    unitCode: l.unitCode,
    vatCategory: l.vat.category,
    vatExemptionCode: l.vat.exemptionCode ?? null,
    vatExemptionReason: l.vat.exemptionReason ?? null,
    taxAmt: amounts.items[i].taxAmt,
  }));
}

/**
 * §2.2 قبل المعاملة: النوع الفرعي ⇒ حجب D2 للقياسية الناقصة ⇒ العملة (D9) ⇒ التحويل بقيم سلسلة مؤقتة والفحص المسبق ⇒ المبالغ
 * المخزَّنة. كل رفض هنا قبل أي قفل أو ICV. يرمي ZatcaHttpError فقط (أو خطأ برمجي غير متوقَّع).
 */
export function prepareIssuance(input: PrepareIssuanceInput): PreparedIssuance {
  const kind: DocumentKind = input.kind ?? 'INVOICE';
  if (kind === 'INVOICE' && input.request.type === 'RETURN') throw new ZatcaHttpError('ZATCA_RETURN_NEEDS_ORIGINAL');
  const subtype = issuanceSubtype(input.customer, kind, input.note);
  if (subtype === '01') {
    const status = customerBuyerStatus(input.customer);
    if (!status.complete) {
      // data.fields: حقول بطاقة العميل الناقصة لنافذة الإكمال (Z5.6b) — أسماء أعمدة لا نصوص
      const base = buyerIncompleteError(input.customer.id, status.issues.filter(i => i.severity === 'error'));
      throw new ZatcaHttpError('ZATCA_BUYER_INCOMPLETE', { messageAr: base.messageAr, issues: base.issues, customerId: input.customer.id, data: { fields: missingBuyerFormFields(status) } });
    }
  }
  if (!currencyAllowed(input.settings)) {
    throw new ZatcaHttpError('ZATCA_CURRENCY', {
      issues: [issue('ZATCA_CURRENCY', 'currency', `عملة الشركة ${effectiveIssuanceCurrency(input.settings) || 'غير محددة'} — المرحلة الثانية بالريال السعودي SAR وحده`)],
    });
  }
  let src: InvoiceSource;
  try {
    src = buildInvoiceSource({ ...input, kind, number: PLACEHOLDER_INVOICE_NUMBER });
  } catch (e) {
    if (e instanceof ZatcaInputError) throw toZatcaHttpError(e) as ZatcaHttpError;
    throw e;
  }
  const newUuid = input.newUuid ?? newInvoiceUuid;
  const { doc, warnings } = mapAndCheck(src, { icv: 1, pih: INITIAL_PIH, uuid: newUuid(), issuedAt: input.now }, { qrMaxLength: input.qrMaxLength });
  let amounts: StoredAmounts;
  try {
    amounts = storedAmounts(input.engine, doc, { pricesIncludeTax: src.pricesIncludeTax });
  } catch (e) {
    if (e instanceof ZatcaInputError) throw toZatcaHttpError(e) as ZatcaHttpError;
    throw e;
  }
  const prepared: PreparedIssuance = {
    kind, subtype, stampKind: subtype === '01' ? 'standard' : 'simplified', typeCode: doc.typeCode, typeName: doc.typeName,
    customerId: input.customer.id, src, amounts, items: itemSnapshotsOf(doc, amounts), amountsFingerprint: amountsFingerprintOf(doc),
    warnings,
  };
  if (input.qrMaxLength !== undefined) prepared.qrMaxLength = input.qrMaxLength;
  return prepared;
}

// ─── صفّ الفاتورة (أعمدة المرحلة الثانية) ───

export interface SignedInvoiceMirror {
  einvoiceProvider: 'zatca';
  einvoiceStatus: InvoiceMirrorStatus;
  einvoiceUuid: string;
  einvoiceHash: string;
  einvoicePih: string;
  einvoiceIcv: number;
  /** المبسّطة: ختمنا؛ القياسية: null حتى الاعتماد (لا يُكشف رمز قياسية لم تُعتمد). */
  einvoiceQr: string | null;
  einvoiceWarnings: null;
}

export function signedInvoiceMirror(input: { subtype: InvoiceSubtype; uuid: string; invoiceHash: string; pih: string; icv: number; qr: string }): SignedInvoiceMirror {
  const status = mirrorStatusOf('SIGNED', input.subtype);
  if (!status) throw new Error('signedInvoiceMirror: تركيبة حالة مستحيلة');
  return {
    einvoiceProvider: 'zatca', einvoiceStatus: status, einvoiceUuid: input.uuid, einvoiceHash: input.invoiceHash, einvoicePih: input.pih,
    einvoiceIcv: input.icv, einvoiceQr: mirrorQrOf({ subtype: input.subtype, status: 'SIGNED', qr: input.qr, clearedQr: null }), einvoiceWarnings: null,
  };
}

/** ما يكتبه الإصدار في صفّ الفاتورة داخل المعاملة (مع بيانات الإنشاء القديمة نفسها). */
export interface IssuedInvoiceRecord {
  tenantId: string;
  number: string;
  issuedAt: Date;
  kind: DocumentKind;
  subtype: InvoiceSubtype;
  typeName: string;
  snapshot: ZatcaSnapshotV1;
  amounts: StoredAmounts;
  items: IssuanceItemSnapshot[];
  mirror: SignedInvoiceMirror;
}

/**
 * أعمدة صفّ Invoice للمرحلة الثانية (§2.4): zatcaPhase=2، النوع المجمَّد، لحظة الإصدار = invoiceDate، اللقطة، المرآة، والمبالغ
 * المخزَّنة. البقية (العميل، المندوب، الأقساط، الدفع…) كما يكتبها المسار القديم.
 */
export function phase2InvoiceColumns(r: IssuedInvoiceRecord) {
  return {
    zatcaPhase: 2 as const,
    documentKind: r.kind,
    invoiceSubtype: r.subtype,
    issuedAt: r.issuedAt,
    invoiceDate: r.issuedAt,
    einvoiceSnapshot: r.snapshot,
    subtotal: r.amounts.subtotal,
    discountAmt: r.amounts.discountAmt,
    taxAmt: r.amounts.taxAmt,
    total: r.amounts.total,
    ...r.mirror,
  };
}

/** أعمدة InvoiceItem للمرحلة الثانية: seq واسم الصنف ووحدته وفئته وإعفاؤه لحظة الإصدار، وضريبة سطره في الـXML. */
export function phase2ItemColumns(item: IssuanceItemSnapshot) {
  return {
    seq: item.seq, itemName: item.itemName, unitCode: item.unitCode, vatCategory: item.vatCategory, vatExemptionCode: item.vatExemptionCode,
    vatExemptionReason: item.vatExemptionReason, taxAmt: item.taxAmt,
  };
}

/** اللقطة المحفوظة من المستند المختوم (بلا قيم السلسلة). */
export function snapshotOf(doc: UblDocument): ZatcaSnapshotV1 {
  return buildSnapshot(doc);
}

// ─── الترقيم (نقد 8، F17) ───

/** بادئة رقم المرحلة الثانية بشهر الرياض للحظة الإصدار: INV-YYMM- / RET-YYMM-. */
export function phase2NumberPrefix(kind: 'INV' | 'RET', issuedAt: Date): string {
  const { date } = riyadhParts(issuedAt);
  return `${kind}-${date.slice(2, 4)}${date.slice(5, 7)}-`;
}

/** الرقم التالي بعد آخر رقم بالبادئة (خوارزمية utils/helpers.ts نفسها: ستّ خانات). */
export function nextNumberAfter(prefix: string, lastNumber: string | null | undefined): string {
  const lastSeq = lastNumber ? parseInt(lastNumber.slice(prefix.length), 10) || 0 : 0;
  return prefix + String(lastSeq + 1).padStart(6, '0');
}

// ─── تصنيف القيود الفريدة وأخطاء الإصدار (نقد 26) ───

export type IssuanceUniqueTarget = 'chain' | 'clientRef' | 'number' | 'other';

function uniqueMeta(err: unknown): { model: string | null; target: string } {
  const meta = err && typeof err === 'object' ? (err as { meta?: unknown }).meta : undefined;
  const m = meta && typeof meta === 'object' ? (meta as { modelName?: unknown; target?: unknown }) : {};
  const t = m.target;
  return { model: typeof m.modelName === 'string' ? m.modelName : null, target: Array.isArray(t) ? t.join(',') : typeof t === 'string' ? t : '' };
}

/**
 * P2002 أثناء الإصدار: chain (قيود zatca_documents: egsUnitId+icv، uuid، invoiceId+attemptNo — تنبيه بلا إعادة)، clientRef (رفع
 * مكرّر ⇒ الفاتورة القائمة بإسقاطها)، number (تصادم ترقيم ⇒ إعادة المعاملة)، other. null لغير P2002.
 */
export function classifyIssuanceUniqueViolation(err: unknown): IssuanceUniqueTarget | null {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  if (code !== 'P2002') return null;
  if (isChainUniqueViolation(err)) return 'chain';
  const { model, target } = uniqueMeta(err);
  if (model !== null && model !== 'Invoice') return 'other';
  if (/clientRef/i.test(target)) return 'clientRef';
  if (/number/i.test(target)) return 'number';
  return 'other';
}

/**
 * خطأ الإصدار ⇒ ZatcaHttpError، أو null حين يعالجه المستدعي بنفسه (P2002 على clientRef: يعيد الفاتورة القائمة) أو لا يخصّ الفوترة
 * (يمضي إلى معالج الأخطاء العام). تصادم ترقيم استنفد إعاداته ⇒ ZATCA_UNIT_BUSY؛ خلل ضغط البايتات ⇒ ZATCA_STAMP_FAILED.
 */
export function issuanceHttpError(err: unknown): ZatcaHttpError | null {
  if (err instanceof ZatcaHttpError) return err;
  const unique = classifyIssuanceUniqueViolation(err);
  if (unique === 'clientRef') return null;
  if (unique === 'number') return new ZatcaHttpError('ZATCA_UNIT_BUSY', { logDetail: { source: 'P2002', code: 'number' } });
  if (err instanceof DocumentBytesError) return new ZatcaHttpError('ZATCA_STAMP_FAILED', { logDetail: { source: 'DocumentBytesError', code: err.code } });
  return toZatcaHttpError(err);
}
