// ============================================================================
// ZATCA المرحلة الثانية (Z4) — مستندات فحص الامتثال (POST /compliance/invoices) بعد إصدار CCSID
// ----------------------------------------------------------------------------
// design §3 Z4 «onboardUnit» خطوة 3 وreport §4.3/§8:
//   • خريطة 1100 ⇒ ستة مستندات: فاتورة ضريبية، إشعار دائن ضريبي، إشعار مدين ضريبي، ثم الثلاثة المبسّطة
//     (بترتيب خطوات الهيئة في رسالة Missing-ComplianceSteps [S10])؛ 1000 ⇒ الثلاثة الضريبية؛ 0100 ⇒ الثلاثة المبسّطة.
//   • كل مستند يمرّ بخط الإصدار نفسه: mapInvoiceToUbl ← preflightIssues (أي مخالفة مانعة ⇒ خطأ مصنَّف بقائمتها)
//     ← serializeUnsigned ← stampDocument (بشهادة CCSID وموقِّع الوحدة) — لا مسار مختصر خاص بالامتثال.
//   • سلسلة خاصة في الذاكرة: ICV 1..n من INITIAL_PIH، وكل PIH = تجزئة المستند السابق. لا تُحفظ في ZatcaDocument
//     ولا تمسّ سلسلة الوحدة الحيّة. UNVERIFIED(U7): هل تتوقّع الهيئة أن تستمرّ السلسلة الحيّة بعد عيّنات الامتثال
//     (design: continueChainFromCompliance=false حتى Z6).
//   • البائع = ملف الشركة؛ المشتريان اصطناعيان: منشأة سعودية بعنوان وطني كامل ورقم ضريبي، وعميل نقدي بالاسم.
//     UNVERIFIED(U12): قبول الهيئة لمعرّفات مشترٍ اصطناعية في فحوص الامتثال.
//   • الإشعاران يرجعان إلى رقم الفاتورة من النوع نفسه (BR-KSA-56) مع سبب (KSA-10) وطريقة دفع (BR-49).
//   • محتوى حتمي بالكامل عدا UUID (عشوائي افتراضياً) والتوقيعات (ECDSA عشوائي)؛ الوقت = now الممرَّر.
// لا قاعدة بيانات ولا شبكة ولا ملفات: الناتج جاهز لـFatooraClient.checkComplianceInvoice ولا يُحفظ شيء هنا.
// ============================================================================

import type { InvoiceBody } from './api';
import type { CsidCert } from './cert';
import type { FunctionMap } from './csr';
import { INITIAL_PIH, newInvoiceUuid } from './crypto';
import { BuyerSource, DocumentKind, InvoiceSource, InvoiceSubtype, SellerSource, mapInvoiceToUbl } from './mapInvoice';
import { InvoiceTypeCode, UblDocument, ZatcaInputError, ZatcaIssue } from './model';
import { hasBlockingIssues, preflightIssues } from './preflight';
import { HashSigner, StampError, StampErrorCode, StampKind, stampDocument } from './stamp';
import { serializeUnsigned } from './ubl';

/** أسماء خطوات الامتثال كما تسردها الهيئة في Missing-ComplianceSteps [S10]. */
export type ComplianceStep =
  | 'standard-compliant' | 'standard-credit-note-compliant' | 'standard-debit-note-compliant'
  | 'simplified-compliant' | 'simplified-credit-note-compliant' | 'simplified-debit-note-compliant';

export interface ComplianceSampleSpec {
  readonly step: ComplianceStep;
  readonly kind: DocumentKind;
  readonly subtype: InvoiceSubtype;
  readonly number: string;
  /** للإشعارات: رقم الفاتورة المرجعية من النوع نفسه. */
  readonly references?: string;
}

/**
 * ثوابت الوحدة مجمَّدة (المواصفات والمصفوفات): complianceSpecsFor يعيد الكائنات نفسها لكل مستدعٍ، فمواصفة قابلة للتعديل
 * كانت تجعل تعديل مستدعٍ واحد (معاينة تعيد ترقيم مستند مثلاً) يغيّر مستندات كل ربط لاحق في العملية — لشركات أخرى أيضاً.
 */
const frozenSpec = (s: ComplianceSampleSpec): ComplianceSampleSpec => Object.freeze({ ...s });

const STANDARD_SPECS: readonly ComplianceSampleSpec[] = Object.freeze([
  frozenSpec({ step: 'standard-compliant', kind: 'INVOICE', subtype: '01', number: 'FS-COMPLIANCE-STD-INV' }),
  frozenSpec({ step: 'standard-credit-note-compliant', kind: 'CREDIT_NOTE', subtype: '01', number: 'FS-COMPLIANCE-STD-CRN', references: 'FS-COMPLIANCE-STD-INV' }),
  frozenSpec({ step: 'standard-debit-note-compliant', kind: 'DEBIT_NOTE', subtype: '01', number: 'FS-COMPLIANCE-STD-DBN', references: 'FS-COMPLIANCE-STD-INV' }),
]);

const SIMPLIFIED_SPECS: readonly ComplianceSampleSpec[] = Object.freeze([
  frozenSpec({ step: 'simplified-compliant', kind: 'INVOICE', subtype: '02', number: 'FS-COMPLIANCE-SMP-INV' }),
  frozenSpec({ step: 'simplified-credit-note-compliant', kind: 'CREDIT_NOTE', subtype: '02', number: 'FS-COMPLIANCE-SMP-CRN', references: 'FS-COMPLIANCE-SMP-INV' }),
  frozenSpec({ step: 'simplified-debit-note-compliant', kind: 'DEBIT_NOTE', subtype: '02', number: 'FS-COMPLIANCE-SMP-DBN', references: 'FS-COMPLIANCE-SMP-INV' }),
]);

const SPECS_BY_MAP: Readonly<Record<FunctionMap, readonly ComplianceSampleSpec[]>> = Object.freeze({
  '1100': Object.freeze([...STANDARD_SPECS, ...SIMPLIFIED_SPECS]),
  '1000': STANDARD_SPECS,
  '0100': SIMPLIFIED_SPECS,
});

/** المستندات المطلوبة لكل خريطة وظائف [S4 §3.3.4.2، S10، S21] بترتيب الإرسال — مصفوفة مجمَّدة من مواصفات مجمَّدة. */
export function complianceSpecsFor(functionMap: FunctionMap): readonly ComplianceSampleSpec[] {
  if (typeof functionMap !== 'string' || !Object.prototype.hasOwnProperty.call(SPECS_BY_MAP, functionMap)) {
    throw new ComplianceSampleError('INPUT', 'خريطة الوظائف يجب أن تكون 1000 أو 0100 أو 1100', { field: 'functionMap' });
  }
  return SPECS_BY_MAP[functionMap];
}

/** مشترٍ منشأة اصطناعي: رقم ضريبي بصيغة صحيحة (الخانة 11 ليست 1 فلا مجموعة ضريبية) وعنوان وطني سعودي كامل. */
export const COMPLIANCE_STANDARD_BUYER: Readonly<BuyerSource> = Object.freeze({
  name: 'Compliance Test Buyer',
  businessName: 'شركة مشتري اختبار الامتثال | Compliance Test Buyer Co',
  taxNumber: '300000000000003',
  commercialReg: null,
  buyerType: 'BUSINESS',
  addrStreet: 'طريق الملك فهد | King Fahd Road',
  addrBuildingNo: '1234',
  addrAdditionalNo: null,
  addrPostalCode: '12211',
  district: 'العليا | Al Olaya',
  city: 'الرياض | Riyadh',
  countryCode: 'SA',
});

/** عميل نقدي اصطناعي للمبسّطة: الاسم وحده (الفحص المسبق يمنع طرفاً فارغاً تماماً — U12). */
export const COMPLIANCE_WALK_IN_BUYER: Readonly<BuyerSource> = Object.freeze({
  name: 'عميل نقدي | Walk-in Customer',
  buyerType: 'INDIVIDUAL',
});

const ITEM_NAME = 'صنف اختبار الامتثال | Compliance Test Item';

/** بنود حتمية بأسعار صافية ونسبة 15%: الفاتورة 2 × 100، الدائن مرتجع 1 × 100، المدين فرق سعر 1 × 10. */
function itemsFor(kind: DocumentKind): InvoiceSource['items'] {
  const [qty, unitPrice] = kind === 'INVOICE' ? [2, 100] : kind === 'CREDIT_NOTE' ? [1, 100] : [1, 10];
  return [{ itemName: ITEM_NAME, unitCode: 'PCE', qty, unitPrice, discountPct: 0, taxPct: 15, vatCategory: 'S' }];
}

const NOTE_REASON: Readonly<Record<Exclude<DocumentKind, 'INVOICE'>, string>> = Object.freeze({
  CREDIT_NOTE: 'إرجاع بضاعة | Goods returned',
  DEBIT_NOTE: 'تعديل السعر | Price adjustment',
});

/** مصدر المستند الحتمي لخطوة (مُصدَّر للاختبار ولعرض المعاينة). */
export function complianceInvoiceSource(spec: ComplianceSampleSpec, seller: SellerSource): InvoiceSource {
  const src: InvoiceSource = {
    kind: spec.kind,
    number: spec.number,
    currency: 'SAR',
    pricesIncludeTax: false,
    invoiceDiscountPct: 0,
    paymentType: 'CASH',
    supplyDate: null,
    subtype: spec.subtype,
    seller,
    buyer: { ...(spec.subtype === '01' ? COMPLIANCE_STANDARD_BUYER : COMPLIANCE_WALK_IN_BUYER) },
    items: itemsFor(spec.kind),
  };
  if (spec.kind !== 'INVOICE') {
    src.billingReferences = [spec.references!];
    src.noteReason = NOTE_REASON[spec.kind];
  }
  return src;
}

export interface ComplianceSample {
  step: ComplianceStep;
  kind: DocumentKind;
  subtype: InvoiceSubtype;
  stampKind: StampKind;
  typeCode: InvoiceTypeCode;
  number: string;
  /** رقم الفاتورة المرجعية (للإشعارات). */
  references?: string;
  icv: number;
  pih: string;
  uuid: string;
  invoiceHash: string;
  /** الـXML المختوم حرفياً (البايتات التي تُرمَّز في body.invoice). */
  xml: string;
  /** جاهز لـFatooraClient.checkComplianceInvoice(creds, body). */
  body: InvoiceBody;
  /** نموذج UBL الذي خُتم (للسجلّ والاختبار). */
  doc: UblDocument;
  /** تحذيرات الفحص المسبق غير المانعة. */
  warnings: ZatcaIssue[];
}

export interface BuildComplianceSamplesInput {
  seller: SellerSource;
  /** شهادة CCSID (parseCsidToken على binarySecurityToken من POST /compliance). */
  cert: CsidCert;
  /** موقِّع مفتاح الوحدة الذي بُني منه الـCSR. */
  signer: HashSigner;
  now: Date;
  functionMap: FunctionMap;
  /** مولّد UUID (افتراضياً crypto.randomUUID) — يُحقن للاختبار الحتمي فقط. */
  newUuid?: () => string;
}

export type ComplianceSampleErrorCode = 'INPUT' | 'PREFLIGHT' | 'STAMP';

/**
 * INPUT: مدخلات الاستدعاء نفسها (خريطة، وقت، شهادة، موقِّع، UUID).
 * PREFLIGHT: بيانات الشركة لا تكفي لمستند صالح — issues بصيغة الفحص المسبق (قاعدة، حقل، رسالة عربية) لكل الخطوات دفعة واحدة.
 * STAMP: فشل الختم — stampCode من تصنيف StampError (CERT_KEY_MISMATCH، CERT_NOT_VALID، …) والحقل إن وُجد.
 */
export class ComplianceSampleError extends Error {
  readonly code: ComplianceSampleErrorCode;
  readonly field?: string;
  readonly issues: ZatcaIssue[];
  /** الخطوات التي فشلت (PREFLIGHT) أو الخطوة الجارية (STAMP). */
  readonly steps: ComplianceStep[];
  readonly stampCode?: StampErrorCode;
  /** lib ES2020 بلا Error.cause. */
  readonly cause?: unknown;
  constructor(
    code: ComplianceSampleErrorCode,
    message: string,
    extra: { field?: string; issues?: ZatcaIssue[]; steps?: ComplianceStep[]; stampCode?: StampErrorCode; cause?: unknown } = {},
  ) {
    super(`ZATCA_COMPLIANCE_SAMPLES ${code}: ${message}`);
    this.name = 'ComplianceSampleError';
    this.code = code;
    this.issues = extra.issues ?? [];
    this.steps = extra.steps ?? [];
    if (extra.field !== undefined) this.field = extra.field;
    if (extra.stampCode !== undefined) this.stampCode = extra.stampCode;
    if ('cause' in extra) this.cause = extra.cause;
  }
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const stampKindOf = (subtype: InvoiceSubtype): StampKind => (subtype === '01' ? 'standard' : 'simplified');

/** يربط مستنداً بمصدره وقيم سلسلته ويفحصه؛ ZatcaInputError من التحويل = مخالفات فحص مسبق بالشكل نفسه. */
function mapAndPreflight(spec: ComplianceSampleSpec, seller: SellerSource, icv: number, pih: string, uuid: string, now: Date):
  { doc: UblDocument | null; issues: ZatcaIssue[] } {
  let doc: UblDocument;
  try {
    doc = mapInvoiceToUbl(complianceInvoiceSource(spec, seller), { icv, pih, uuid, issuedAt: now });
  } catch (e) {
    if (e instanceof ZatcaInputError) return { doc: null, issues: e.issues };
    throw e;
  }
  return { doc, issues: preflightIssues(doc, stampKindOf(spec.subtype)) };
}

/**
 * design §3 Z4: يبني ويختم مستندات فحص الامتثال لخريطة الوظائف. غير متزامن لأن الموقِّع قد يكون خارجياً (KMS).
 * الفحص المسبق يجري على كل الخطوات **قبل** أي توقيع، فتُعاد كل المخالفات دفعة واحدة.
 */
export async function buildComplianceSamples(input: BuildComplianceSamplesInput): Promise<ComplianceSample[]> {
  if (!input || typeof input !== 'object') throw new ComplianceSampleError('INPUT', 'المدخلات مفقودة');
  const { seller, cert, signer, now, functionMap } = input;
  const specs = complianceSpecsFor(functionMap);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new ComplianceSampleError('INPUT', 'وقت الإصدار غير صالح', { field: 'now' });
  if (!seller || typeof seller !== 'object') throw new ComplianceSampleError('INPUT', 'بيانات البائع مفقودة', { field: 'seller' });
  if (!cert || typeof cert !== 'object' || typeof cert.certB64 !== 'string') throw new ComplianceSampleError('INPUT', 'شهادة CCSID مفقودة', { field: 'cert' });
  if (!signer || typeof signer.signHash !== 'function') throw new ComplianceSampleError('INPUT', 'الموقِّع مفقود', { field: 'signer' });
  const makeUuid = input.newUuid ?? newInvoiceUuid;
  if (typeof makeUuid !== 'function') throw new ComplianceSampleError('INPUT', 'newUuid يجب أن يكون دالّة', { field: 'newUuid' });

  const uuids = specs.map(() => makeUuid());
  uuids.forEach((u, i) => {
    if (typeof u !== 'string' || !UUID_RE.test(u)) throw new ComplianceSampleError('INPUT', `UUID غير صالح للخطوة ${specs[i].step}`, { field: 'newUuid' });
  });
  if (new Set(uuids.map(u => u.toLowerCase())).size !== uuids.length) throw new ComplianceSampleError('INPUT', 'UUID مكرّر بين المستندات', { field: 'newUuid' });

  // ─── الجولة 1: فحص مسبق لكل الخطوات قبل أي توقيع (PIH مؤقتة بصيغة صحيحة؛ الفحص لا يعتمد على قيمتها) ───
  const allIssues: ZatcaIssue[] = [];
  const seen = new Set<string>();
  const failed: ComplianceStep[] = [];
  specs.forEach((spec, i) => {
    const { issues } = mapAndPreflight(spec, seller, i + 1, INITIAL_PIH, uuids[i], now);
    if (!hasBlockingIssues(issues)) return;
    failed.push(spec.step);
    for (const issue of issues.filter(x => x.severity === 'error')) {
      const key = `${issue.rule}|${issue.field}|${issue.messageAr}`;
      if (!seen.has(key)) { seen.add(key); allIssues.push(issue); }
    }
  });
  if (failed.length) {
    throw new ComplianceSampleError('PREFLIGHT', `بيانات المنشأة لا تكفي لمستندات الامتثال: ${allIssues.map(x => `${x.rule}@${x.field}`).join('، ')}`, {
      issues: allIssues, steps: failed,
    });
  }

  // ─── الجولة 2: السلسلة الخاصة والختم ───
  const out: ComplianceSample[] = [];
  let pih = INITIAL_PIH;
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const icv = i + 1;
    const stampKind = stampKindOf(spec.subtype);
    const { doc, issues } = mapAndPreflight(spec, seller, icv, pih, uuids[i], now);
    if (!doc || hasBlockingIssues(issues)) {
      // لا يحدث إلا إن تغيّر ناتج الفحص بين الجولتين (قيم السلسلة) — خلل داخلي يُبلَّغ بقائمته
      throw new ComplianceSampleError('PREFLIGHT', `مخالفات في ${spec.step} بعد ربط السلسلة`, { issues: issues.filter(x => x.severity === 'error'), steps: [spec.step] });
    }
    const unsigned = serializeUnsigned(doc);
    let stamped;
    try {
      stamped = await stampDocument(unsigned, doc, signer, cert, now, stampKind);
    } catch (e) {
      const se = e instanceof StampError ? e : undefined;
      throw new ComplianceSampleError('STAMP', `فشل ختم ${spec.step}: ${se ? se.code : 'INTERNAL'}`, {
        steps: [spec.step], stampCode: se?.code ?? 'INTERNAL', ...(se?.field !== undefined ? { field: se.field } : {}), cause: e,
      });
    }
    const body: InvoiceBody = {
      invoiceHash: stamped.invoiceHash,
      uuid: doc.uuid,
      invoice: Buffer.from(stamped.xml, 'utf8').toString('base64'),
    };
    const sample: ComplianceSample = {
      step: spec.step,
      kind: spec.kind,
      subtype: spec.subtype,
      stampKind,
      typeCode: doc.typeCode,
      number: doc.id,
      icv,
      pih,
      uuid: doc.uuid,
      invoiceHash: stamped.invoiceHash,
      xml: stamped.xml,
      body,
      doc,
      warnings: issues.filter(x => x.severity !== 'error'),
    };
    if (spec.references !== undefined) sample.references = spec.references;
    out.push(sample);
    pih = stamped.invoiceHash;
  }
  return out;
}
