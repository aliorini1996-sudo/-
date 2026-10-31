// ============================================================================
// ZATCA المرحلة الثانية (Z5.2) — نواة الإصدار النقيّة: من فاتورة المنصّة إلى مصدر Z1، والتحضير قبل القفل، والمبالغ المخزَّنة
// ----------------------------------------------------------------------------
// z5_plan §2.2 (قبل المعاملة) + §2.4 (D6) + §3 Z5.2 (issue.ts) + نقد الخطة (12، 19، 24، 26) + قرارات المالك D2/Q2 وD6 وD9:
//   • buildInvoiceSource: البائع من CompanySettings (sellerSourceFromSettings)، المشتري من صفّ العميل بأرقام لاتينية
//     (buyerSourceFromCustomer — كما تحكم قائمة D2)، البنود بترتيب الطلب (seq = 1..n) بفئة الصنف الضريبية وtaxPct = item ?? الشركة،
//     وحدة القياس رمز وحدة البند من لقطتها وإلا PCE (Product.unitCode رمز ETA لا يُقرأ)، والكمية والسعر بوحدة البند معاً،
//     وطريقة الدفع INSTALLMENT لخطة الأقساط وإلا type.
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
//   • «فك قيد الرقم الضريبي والعنوان الوطني» (طلب المالك ٣١ أكتوبر ٢٠٢٦، CompanySettings.buyerVatAddressRelaxed يُقرأ مع البائع):
//     فاتورة منشأة/جهة حكومية بياناتها لا تكفي للضريبية (01) تصدر **مبسطة (02)** بطرف مشترٍ آمن (simplifiedBuyerSource: الاسم
//     والمعرّف الصريح الصحيح وحده) بدل 422 — قبل أي قفل أو ICV، والمبالغ والضريبة لا تتغيّر (لا تعتمد على النوع الفرعي)، ومعها
//     buyerNotice للردّ. والإشعار يرث نوع أصله دائماً: على فاتورة ضريبية (01) يبقى 422 حتى مع فكّ القيد. مطفأ ⇒ كما قبله حرفياً.
// لا قاعدة بيانات ولا شبكة ولا services/gl. لا يستدعي الهيئة أبداً.
// ============================================================================

import { classifyBuyerSubtype, mapBuyerPartyLike } from './buyerParty';
import {
  BUYER_BILLING_FIELDS, BUYER_FIELD_LABELS_AR, buyerIssuanceDecision, buyerSourceFromCustomer, customerBuyerStatus, missingBuyerFormFields,
  simplifiedBuyerSource, type BuyerField, type BuyerRowLike,
} from './buyerData';
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
import { buyerIssues } from './validators';

// ─── المدخلات ───

/**
 * وحدة القياس الافتراضية في المرحلة الثانية (UN/ECE Rec 20) — لوحدة الأساس ولكلّ بندٍ بلا لقطة وحدة. ولا يُقرأ
 * Product.unitCode هنا: هو رمز ETA (جدول مزوّد مصر)، فبند الأساس يبقى PCE كما قبل الوحدات المتعددة حرفياً.
 */
export const PHASE2_UNIT_CODE = 'PCE';

/** شكل رمز UN/ECE Rec 20/21: حرفان أو ثلاثة لاتينية أو أرقام (PCE، CT، XBX، C62). */
const UNIT_CODE_SHAPE = /^[A-Z0-9]{2,3}$/;

/**
 * رمز وحدة سطر الـXML من رمز وحدة البند (ProductUnit.unitCode في لقطته)، وإلا PCE. رمزٌ ليس بشكل الرمز (نصٌّ حرّ
 * مثل «كرتون» كُتب في حقل الرمز) لا يدخل مستنداً ضريبياً: يُكتب PCE والكمية والسعر بوحدة البند كما هما.
 */
export function phase2UnitCode(code: string | null | undefined): string {
  const c = typeof code === 'string' ? code.trim().toUpperCase() : '';
  return UNIT_CODE_SHAPE.test(c) ? c : PHASE2_UNIT_CODE;
}
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
  /** بوحدة البند (كرتون) — والسعر لوحدة البند نفسها: الاثنان متّسقان في الـXML ولا يُحوَّلان إلى الأساس */
  qty: number;
  unitPrice: number;
  discountPct?: number | null;
  taxPct?: number | null;
  /** رمز وحدة البند الضريبي من لقطتها (ProductUnit.unitCode)؛ غائبٌ = وحدة الأساس ⇒ PCE */
  unitCode?: string | null;
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
  /** فكّ القيد: إشعارٌ على أصلٍ من المرحلة الأولى قرّرته الأهليّة مبسطاً بدل ضريبيٍّ ناقص (noteEligibility) — غيابه = لا */
  buyerSimplified?: true;
  /** النوع من تصنيف العميل الحيّ (أصلٌ من المرحلة الأولى) لا من أصلٍ ضريبيّ — فلا تُقال رسالة «يتبع نوع فاتورته الأصلية» */
  originalClassified?: true;
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
  /**
   * Z5.5: بنود جاهزة تحلّ محلّ `request.items` وبطاقات الأصناف — الإشعار يُبنى من **بنود الفاتورة الأصلية**
   * (سعرها وخصمها ونسبتها وفئتها كما صدرت) لا من أسعار اليوم ولا من بطاقة صنفٍ تغيّرت بعد البيع. غيابها =
   * المسار القديم حرفاً بحرف (الفواتير).
   */
  lines?: readonly LineSource[];
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

/** النوع الفرعي المجمَّد: الإشعار يرث أصله؛ الفاتورة من بيانات العميل الحالية (D2/Q2). دلالة القيد القائم (issuanceSubtypeDecision بلا فكّه). */
export function issuanceSubtype(customer: BuyerRowLike, kind: DocumentKind = 'INVOICE', note?: IssuanceNoteContext | null): InvoiceSubtype {
  if (kind !== 'INVOICE' && note && (note.originalSubtype === '01' || note.originalSubtype === '02')) return note.originalSubtype;
  return classifyBuyerSubtype(buyerSourceFromCustomer(customer));
}

// ─── فكّ قيد الرقم الضريبي والعنوان الوطني (طلب المالك ٣١ أكتوبر ٢٠٢٦) ───

/** إعداد الشركة كما حمّله الإصدار مع البائع (SELLER_SELECT) — غيابه أو null = مطفأ. */
export function buyerRelaxedOf(s: { buyerVatAddressRelaxed?: boolean | null } | null | undefined): boolean {
  return s?.buyerVatAddressRelaxed === true;
}

export const ZATCA_BUYER_SIMPLIFIED = 'ZATCA_BUYER_SIMPLIFIED';
export const BUYER_SIMPLIFIED_AUDIT_EVENT = 'ZATCA_BUYER_SIMPLIFIED';

export interface IssuanceSubtypeDecision {
  subtype: InvoiceSubtype;
  /** 01⇒02 بفكّ القيد (فاتورة)، أو إشعارٌ على أصلٍ من المرحلة الأولى قرّرته الأهليّة كذلك */
  buyerSimplified: boolean;
  /** ⇒ 422 ZATCA_BUYER_INCOMPLETE */
  blocked: boolean;
  /** الحجب سببه أنّ الإشعار يتبع أصلاً ضريبياً (01) — لرسالة أوضح حين يكون القيد مفكوكاً */
  noteOnStandard: boolean;
  issues: ZatcaIssue[];
  fields: BuyerField[];
}

/**
 * قرار النوع الفرعي قبل أي قفل: الإشعار يرث نوع أصله (لا يُغيَّر هنا) وحجبُ D2 لأصلٍ ضريبي قائمٌ أياً كان الإعداد؛ والفاتورة
 * buyerIssuanceDecision (ضريبية مكتملة، مبسطة طبيعية، ناقصة ⇒ محجوبة أو مبسطة بفكّ القيد). relaxed = false ⇒ issuanceSubtype + D2 حرفياً.
 */
export function issuanceSubtypeDecision(
  customer: BuyerRowLike, kind: DocumentKind, note: IssuanceNoteContext | null | undefined, relaxed: boolean,
): IssuanceSubtypeDecision {
  if (kind !== 'INVOICE' && note && (note.originalSubtype === '01' || note.originalSubtype === '02')) {
    const subtype = note.originalSubtype;
    const buyerSimplified = note.buyerSimplified === true;
    const st = customerBuyerStatus(customer);
    const blocked = subtype === '01' && !st.complete;
    const explain = blocked || buyerSimplified;
    return {
      subtype, buyerSimplified, blocked, noteOnStandard: blocked && note.originalClassified !== true,
      issues: explain ? st.issues.filter(i => i.severity === 'error') : [],
      fields: explain ? missingBuyerFormFields(st) : [],
    };
  }
  // فاتورة (أو إشعار بلا سياق أصلٍ صالح — يرفضه issuancePaymentType بعدها): قاعدة الفاتورة، وفكّ القيد للفاتورة وحدها
  const d = buyerIssuanceDecision(customer, kind === 'INVOICE' && relaxed);
  return { subtype: d.subtype, buyerSimplified: d.simplifiedByRelax, blocked: d.blocked, noteOnStandard: false, issues: d.issues, fields: d.fields };
}

/** إعلام الردّ (201) بأنّ المستند صدر مبسطاً بفكّ القيد — حقول البطاقة الناقصة أسماء أعمدة لا قيم. */
export interface BuyerSimplifiedNotice {
  code: typeof ZATCA_BUYER_SIMPLIFIED;
  message: string;
  fields: BuyerField[];
}

export function buyerSimplifiedNotice(kind: DocumentKind, fields: readonly BuyerField[]): BuyerSimplifiedNotice {
  const list = fields.filter(f => (BUYER_BILLING_FIELDS as readonly string[]).includes(f));
  const head = kind === 'INVOICE'
    ? 'صدرت فاتورة ضريبية مبسطة لأن بيانات العميل لا تكفي للفاتورة الضريبية وفك القيد مفعّل في إعدادات الشركة — لا يستطيع العميل خصم ضريبتها'
    : 'صدر الإشعار مبسطاً لأن بيانات العميل لا تكفي للفاتورة الضريبية وفك القيد مفعّل في إعدادات الشركة — لا يستطيع العميل خصم ضريبته';
  const tail = list.length ? '. الناقص: ' + list.map(f => BUYER_FIELD_LABELS_AR[f]).join('، ') : '';
  return { code: ZATCA_BUYER_SIMPLIFIED, message: head + tail, fields: [...list] };
}

const auditId = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, 128) : null);

/** سطر تدقيق (JSON) لمستندٍ صدر مبسطاً بفكّ القيد — معرّفات وأسماء حقول فقط، لا قيم. */
export function buyerSimplifiedAuditLine(f: {
  tenantId: string; customerId: string; invoiceId: string; number: string; kind?: DocumentKind; fields: readonly string[];
}): string {
  return JSON.stringify({
    event: BUYER_SIMPLIFIED_AUDIT_EVENT,
    tenantId: auditId(f.tenantId),
    customerId: auditId(f.customerId),
    invoiceId: auditId(f.invoiceId),
    number: auditId(f.number),
    kind: f.kind ?? 'INVOICE',
    fields: f.fields.filter(x => (BUYER_BILLING_FIELDS as readonly string[]).includes(x)),
  });
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
  // فكّ القيد (طلب المالك ٣١ أكتوبر ٢٠٢٦): القرار نفسه الذي تحجب به prepareIssuance — والختم داخل القفل يعيد src المحفوظ نفسه
  const relaxed = buyerRelaxedOf(input.settings);
  const decision = issuanceSubtypeDecision(input.customer, kind, input.note, relaxed);
  const subtype = decision.subtype;
  const rawBuyer = buyerSourceFromCustomer(input.customer);
  // فكّ القيد: المبسّط بفكّه طرفُه آمنٌ دائماً؛ والمبسّط الطبيعي (أو الموروث) يُؤمَّن حين يفشل طرفه الخام قواعد المبسّطة وحدها
  // (معرّفٌ قديم خاطئ) — والصحيح يبقى صفّ العميل نفسه بايتاً ببايت
  const safeBuyer = relaxed && subtype === '02'
    && (decision.buyerSimplified || buyerIssues('simplified', mapBuyerPartyLike(rawBuyer, '02')).some(i => i.severity === 'error'));
  const byId = new Map(input.products.map(p => [p.id, p]));
  const missing: ZatcaIssue[] = [];
  const items: LineSource[] = input.lines ? input.lines.map(l => ({ ...l })) : input.request.items.map((it, i) => {
    const p = byId.get(it.productId);
    if (!p) missing.push(issue('BR-25', `items[${i}].productId`, `الصنف في البند ${i + 1} غير موجود أو غير نشط`));
    const line: LineSource = {
      itemName: p?.name ?? '',
      // رمز وحدة البند لا PCE ثابتاً: «2 CT» بسعر الكرتون، لا «2 PCE» والمقصود كرتونان
      unitCode: phase2UnitCode(it.unitCode),
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
    // فكّ القيد: الطرف المبسّط الآمن (بلا رقم ضريبي ولا سجل ولا عنوان، ومعرّفٌ صريح صحيح وحده) فلا يفشل buyerIssues('simplified')
    // بسببها. مطفأ ⇒ صفّ العميل كما هو
    buyer: safeBuyer ? simplifiedBuyerSource(rawBuyer) : rawBuyer,
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
  /** فكّ القيد: صدر مبسطاً (02) بدل ضريبي ناقص — غائبٌ في غيره */
  buyerSimplified?: true;
  /** إعلام الردّ (notice) — مع buyerSimplified وحده */
  buyerNotice?: BuyerSimplifiedNotice;
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
  // D2 + فكّ القيد (طلب المالك ٣١ أكتوبر ٢٠٢٦): ضريبية ناقصة ⇒ 422، أو مبسطة حين يكون القيد مفكوكاً وطرفها المبسّط صحيحاً
  const relaxed = buyerRelaxedOf(input.settings);
  const d = issuanceSubtypeDecision(input.customer, kind, input.note, relaxed);
  const subtype = d.subtype;
  if (d.blocked) {
    // data.fields: حقول بطاقة العميل الناقصة لنافذة الإكمال (Z5.6b) — أسماء أعمدة لا نصوص
    const base = buyerIncompleteError(input.customer.id, d.issues, relaxed && d.noteOnStandard ? { noteOnStandard: true } : undefined);
    throw new ZatcaHttpError('ZATCA_BUYER_INCOMPLETE', { messageAr: base.messageAr, issues: base.issues, customerId: input.customer.id, data: { fields: d.fields } });
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
  if (d.buyerSimplified) {
    prepared.buyerSimplified = true;
    prepared.buyerNotice = buyerSimplifiedNotice(kind, d.fields);
  }
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
