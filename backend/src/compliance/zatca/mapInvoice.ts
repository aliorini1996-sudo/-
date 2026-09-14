// ============================================================================
// ZATCA المرحلة الثانية (Z1) — تحويل بيانات الفاتورة إلى مستند UBL + اللقطة المحفوظة
// ----------------------------------------------------------------------------
// المُدخل InvoiceSource بيانات صرفة (بلا Prisma): يبنيها Z5 من CompanySettings وCustomer
// وInvoiceItem وقت الإصدار. قواعد التحويل من design §3 Z1 «Mapping rules»:
//   • النوع الفرعي 01/02 يُحسم مرة ويُجمَّد (Invoice.invoiceSubtype)؛ الإشعار يرث نوع أصله.
//   • IssueDate/IssueTime من riyadhParts(issuedAt) — وقت الخادم لا وقت الجهاز.
//   • تاريخ التوريد = deliveryDate ?? تاريخ الإصدار (إلزامي في 388 الضريبية، BR-KSA-15).
//   • البنود مرقّمة 1..n بترتيب الإرسال (UNVERIFIED(U14): ترتيب البنود العائد من قاعدة البيانات — design §6.2؛ فلا نعتمده).
//   • unitCode الافتراضي PCE؛ الفئة الضريبية الفارغة مع نسبة > 0 ⇒ S، ومع 0% ⇒ خطأ إدخال.
// لا يتحقق هذا الملف من اكتمال البيانات — ذاك دور preflight.ts؛ هنا فقط ما يستحيل معه البناء.
// ============================================================================

import { computeUblAmounts } from './amounts';
import { decFromNumber, formatDec } from './decimal';
import { riyadhParts, isIsoDate } from './time';
import {
  InvoiceTypeCode, UblAddress, UblDocument, UblLine, UblParty, UblSubtotal, VatCategory, VAT_CATEGORIES,
  ZatcaInputError, ZatcaIssue,
} from './model';
import { sanitizeText } from './validators';

export type DocumentKind = 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE';
export type InvoiceSubtype = '01' | '02';

/** بيانات البائع — حقول CompanySettings المضافة في design §1.3. */
export interface SellerSource {
  legalName?: string | null;       // BT-27
  taxNumber?: string | null;       // BT-31
  commercialReg?: string | null;
  sellerIdScheme?: string | null;  // null ⇒ CRN
  sellerIdValue?: string | null;   // null ⇒ commercialReg
  addrStreet?: string | null;
  addrBuildingNo?: string | null;
  addrAdditionalNo?: string | null;
  addrDistrict?: string | null;
  addrCity?: string | null;
  addrPostalCode?: string | null;
  countryCode?: string | null;     // null ⇒ SA
}

/** بيانات المشتري — حقول Customer الحالية والمضافة. */
export interface BuyerSource {
  name?: string | null;
  businessName?: string | null;
  taxNumber?: string | null;
  commercialReg?: string | null;
  buyerType?: string | null;       // INDIVIDUAL | BUSINESS | GOVERNMENT | null
  buyerIdScheme?: string | null;
  buyerIdValue?: string | null;    // null + CRN ⇒ commercialReg
  addrStreet?: string | null;
  addrBuildingNo?: string | null;
  addrAdditionalNo?: string | null;
  addrPostalCode?: string | null;
  district?: string | null;
  city?: string | null;
  countryCode?: string | null;     // null ⇒ SA
}

export interface LineSource {
  itemName: string;                // لقطة اسم الصنف
  unitCode?: string | null;        // null ⇒ PCE
  qty: number;
  unitPrice: number;               // حسب pricesIncludeTax
  discountPct?: number | null;
  taxPct: number;                  // مُحلَّلة (item.taxPct ?? companyVat)
  vatCategory?: string | null;
  vatExemptionCode?: string | null;
  vatExemptionReason?: string | null;
}

export interface InvoiceSource {
  kind: DocumentKind;
  number: string;                          // Invoice.number (BT-1)
  currency: string;                        // عملة الشركة الفعلية (يجب SAR — D9)
  pricesIncludeTax: boolean;
  invoiceDiscountPct?: number | null;
  paymentType?: string | null;             // CASH | CREDIT | INSTALLMENT
  supplyDate?: Date | string | null;       // deliveryDate، أو تاريخ الإدخال اليدوي للمدير (لا يصير IssueDate)
  subtype?: InvoiceSubtype | null;         // Invoice.invoiceSubtype المجمَّد (الإشعار: نوع الأصل)
  billingReferences?: string[] | null;     // للإشعارات فقط (BT-25)
  noteReason?: string | null;              // للإشعارات فقط (KSA-10)
  seller: SellerSource;
  buyer: BuyerSource;
  items: LineSource[];
}

export interface ChainValues {
  icv: number;
  pih: string;
  uuid: string;
  issuedAt: Date;
}

const TYPE_CODE: Record<DocumentKind, InvoiceTypeCode> = { INVOICE: '388', CREDIT_NOTE: '381', DEBIT_NOTE: '383' };

/**
 * كل نص يدخل المستند يمرّ من هنا: الصيغة النهائية (sanitizeText: حذف محارف التحكّم وتوحيد الأسطر)
 * ثم القصّ — فالنموذج واللقطة ومصدر QR تحمل النص نفسه الذي يكتبه المُسلسِل حرفياً (model.ts).
 * نصّ من محارف تحكّم فقط = غائب، فيُبلَّغ عنه الفحص المسبق بدل أن يختفي عنصره من الـXML.
 */
const clean = (v: string | null | undefined): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = sanitizeText(v).trim();
  return t === '' ? undefined : t;
};

/**
 * النوع الفرعي: 01 للمنشأة أو الجهة الحكومية؛ ما دام نوع المشتري غير مصنَّف (قبل D2)
 * فـ 01 عند وجود رقم ضريبي أو سجل تجاري، وإلا 02.
 */
export function classifySubtype(buyer: BuyerSource): InvoiceSubtype {
  const t = clean(buyer.buyerType)?.toUpperCase();
  if (t === 'BUSINESS' || t === 'GOVERNMENT') return '01';
  if (t === 'INDIVIDUAL') return '02';
  return clean(buyer.taxNumber) || clean(buyer.commercialReg) ? '01' : '02';
}

/** CASH ⇒ 10 ، CREDIT/INSTALLMENT ⇒ 30. UNVERIFIED(U5): هذا الربط — design §6.2. */
export function paymentMeansCodeFor(paymentType: string | null | undefined): string | undefined {
  const t = clean(paymentType)?.toUpperCase();
  if (t === 'CASH') return '10';
  if (t === 'CREDIT' || t === 'INSTALLMENT') return '30';
  return undefined;
}

/** فئة الضريبة: المُدخلة إن صحّت؛ الفارغة ⇒ S إذا النسبة > 0؛ وإلا null (غير قابلة للاستنتاج). */
export function resolveVatCategory(raw: string | null | undefined, taxPct: number): VatCategory | null {
  const c = clean(raw)?.toUpperCase();
  if (c !== undefined) return (VAT_CATEGORIES as readonly string[]).includes(c) ? (c as VatCategory) : null;
  return Number.isFinite(taxPct) && taxPct > 0 ? 'S' : null;
}

export function mapSellerParty(s: SellerSource): UblParty {
  const party: UblParty = {};
  const name = clean(s.legalName);
  if (name) party.registrationName = name;
  const vat = clean(s.taxNumber);
  if (vat) party.vatNumber = vat;
  const idValue = clean(s.sellerIdValue) ?? clean(s.commercialReg);
  if (idValue) party.otherId = { scheme: clean(s.sellerIdScheme)?.toUpperCase() ?? 'CRN', value: idValue };
  const address: UblAddress = {
    street: clean(s.addrStreet) ?? '',
    buildingNumber: clean(s.addrBuildingNo) ?? '',
    district: clean(s.addrDistrict) ?? '',
    city: clean(s.addrCity) ?? '',
    postalZone: clean(s.addrPostalCode) ?? '',
    country: clean(s.countryCode)?.toUpperCase() ?? 'SA',
  };
  const extra = clean(s.addrAdditionalNo);
  if (extra) address.additionalNumber = extra;
  party.address = address;
  return party;
}

/**
 * طرف المشتري. الضريبية (01): الاسم والعنوان الكامل والرقم الضريبي و/أو المعرّف الآخر.
 * المبسطة (02): الاسم، والمعرّف الآخر **فقط إن أُدخل صريحاً بنوعه وقيمته** (بلا استنتاج CRN من السجل
 * التجاري) — إعفاء التعليم/الصحة للمواطن مبسطٌ بطبيعته ويتطلب هوية NAT (BR-KSA-49). بلا عنوان:
 * عنوان جزئي قد يستدعي قواعد العنوان السعودي بلا داعٍ، ولا نكتب عناصر فارغة أبداً.
 * UNVERIFIED(U12): قبول طرف مشترٍ بلا اسم — design §6.2.
 */
export function mapBuyerParty(b: BuyerSource, subtype: InvoiceSubtype): UblParty {
  const party: UblParty = {};
  const name = clean(b.businessName) ?? clean(b.name);
  if (name) party.registrationName = name;
  const explicitScheme = clean(b.buyerIdScheme)?.toUpperCase();
  if (subtype === '02') {
    const explicitValue = clean(b.buyerIdValue);
    if (explicitScheme && explicitValue) party.otherId = { scheme: explicitScheme, value: explicitValue };
    return party;
  }

  const vat = clean(b.taxNumber);
  if (vat) party.vatNumber = vat;
  const cr = clean(b.commercialReg);
  const scheme = explicitScheme ?? (cr ? 'CRN' : undefined);
  const value = clean(b.buyerIdValue) ?? (scheme === 'CRN' ? cr : undefined);
  if (scheme && value) party.otherId = { scheme, value };
  const address: UblAddress = {
    street: clean(b.addrStreet) ?? '',
    buildingNumber: clean(b.addrBuildingNo) ?? '',
    district: clean(b.district) ?? '',
    city: clean(b.city) ?? '',
    postalZone: clean(b.addrPostalCode) ?? '',
    country: clean(b.countryCode)?.toUpperCase() ?? 'SA',
  };
  const extra = clean(b.addrAdditionalNo);
  if (extra) address.additionalNumber = extra;
  party.address = address;
  return party;
}

/** تاريخ ووقت ISO بإزاحة صريحة (Z أو ±HH:MM) — بلا إزاحة يفسّره Date.parse بمنطقة الخادم (ECMA-262). */
const ISO_DATE_TIME_WITH_OFFSET = /^([0-9]{4}-[0-9]{2}-[0-9]{2})T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})$/;

function resolveSupplyDate(v: Date | string | null | undefined, issueDate: string): string | null {
  if (v === null || v === undefined || v === '') return issueDate;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? riyadhParts(v).date : null;
  const s = v.trim();
  if (isIsoDate(s)) return s; // تاريخ فقط من المدير: يُكتب كما هو بلا إزاحة منطقة
  // تاريخ ووقت: بإزاحة صريحة فقط (وإلا تغيّر KSA-5 المجزَّأ بمنطقة الخادم — U14)، وتاريخ تقويمي حقيقي
  // (Date.parse يقلب 2026-02-30 إلى مارس بصمت)
  const m = ISO_DATE_TIME_WITH_OFFSET.exec(s);
  if (m && isIsoDate(m[1]) && Number.isFinite(Date.parse(s))) return riyadhParts(new Date(s)).date;
  return null;
}

/** يحوّل بيانات الفاتورة وقيم السلسلة إلى مستند UBL كامل (غير موقَّع). */
export function mapInvoiceToUbl(src: InvoiceSource, chain: ChainValues): UblDocument {
  const issues: ZatcaIssue[] = [];
  const typeCode = TYPE_CODE[src.kind];
  if (!typeCode) {
    issues.push({ rule: 'BR-KSA-05', field: 'kind', messageAr: `نوع المستند غير مدعوم (${String(src.kind)})`, severity: 'error' });
  }
  const { date: issueDate, time: issueTime } = riyadhParts(chain.issuedAt);
  const supplyDate = resolveSupplyDate(src.supplyDate, issueDate);
  if (supplyDate === null) {
    issues.push({ rule: 'BR-KSA-F-01', field: 'supplyDate', messageAr: 'تاريخ التوريد غير صالح (المطلوب YYYY-MM-DD)', severity: 'error' });
  }

  const items = src.items ?? [];
  const categories = items.map((it, i) => {
    const cat = resolveVatCategory(it.vatCategory, it.taxPct);
    if (cat === null) {
      const label = clean(it.itemName) ?? `البند ${i + 1}`;
      issues.push({
        rule: 'BR-KSA-18', field: `items[${i}].vatCategory`,
        messageAr: clean(it.vatCategory)
          ? `فئة الضريبة للصنف «${label}» غير صالحة (المسموح S أو Z أو E أو O)`
          : `فئة الضريبة للصنف «${label}» غير محددة — النسبة 0% تتطلب اختيار فئة (Z أو E أو O) ورمز الإعفاء في بطاقة المنتج`,
        severity: 'error',
      });
    }
    return cat;
  });
  if (issues.length) throw new ZatcaInputError('MAPPING_INPUT', issues);

  const amounts = computeUblAmounts({
    pricesIncludeTax: !!src.pricesIncludeTax,
    invoiceDiscountPct: src.invoiceDiscountPct ?? 0,
    lines: items.map((it, i) => ({
      qty: it.qty, unitPrice: it.unitPrice, discountPct: it.discountPct ?? 0, vatPct: it.taxPct, category: categories[i]!,
    })),
  });

  const lines: UblLine[] = items.map((it, i) => {
    const a = amounts.lines[i];
    const category = categories[i]!;
    // نفس تطبيع النسبة الذي يجمّع به amounts.ts التفاصيل (15 و15.00 ⇒ "15.00")
    const vat: UblLine['vat'] = { category, percent: formatDec(decFromNumber(it.taxPct), 2) };
    if (category !== 'S') {
      const code = clean(it.vatExemptionCode)?.toUpperCase();
      const reason = clean(it.vatExemptionReason);
      if (code) vat.exemptionCode = code;
      if (reason) vat.exemptionReason = reason;
    }
    const line: UblLine = {
      id: i + 1,
      name: clean(it.itemName) ?? '',
      quantity: a.quantity,
      unitCode: clean(it.unitCode) ?? 'PCE',
      priceAmount: a.priceAmount,
      lineExtension: a.lineExtension,
      vat,
      taxAmount: a.taxAmount,
      roundingAmount: a.roundingAmount,
    };
    if (a.allowance) line.allowance = a.allowance;
    return line;
  });

  // رمز الإعفاء ونصّه على مستوى التفصيل (BT-120/121) من أول بند في الفئة بترتيب seq؛
  // اختلاف الرموز داخل فئة واحدة يمنعه الفحص المسبق.
  const subtotals: UblSubtotal[] = amounts.subtotals.map(s => {
    const out: UblSubtotal = { ...s };
    if (s.category !== 'S') {
      const first = lines.find(l => l.vat.category === s.category && l.vat.percent === s.percent);
      if (first?.vat.exemptionCode) out.exemptionCode = first.vat.exemptionCode;
      if (first?.vat.exemptionReason) out.exemptionReason = first.vat.exemptionReason;
    }
    return out;
  });

  const subtype: InvoiceSubtype = src.subtype === '01' || src.subtype === '02' ? src.subtype : classifySubtype(src.buyer ?? {});
  const isNote = src.kind === 'CREDIT_NOTE' || src.kind === 'DEBIT_NOTE';

  const doc: UblDocument = {
    id: clean(src.number) ?? '',
    uuid: chain.uuid,
    issueDate,
    issueTime,
    typeCode: typeCode!,
    typeName: `${subtype}00000`, // فاتورة طرف ثالث/اسمية/تصدير/ملخّصة/ذاتية: غير مدعومة في v1
    currency: clean(src.currency)?.toUpperCase() ?? '',
    icv: chain.icv,
    pih: chain.pih,
    supplyDate: supplyDate!,
    supplier: mapSellerParty(src.seller ?? {}),
    customer: mapBuyerParty(src.buyer ?? {}, subtype),
    docAllowances: amounts.docAllowances,
    subtotals,
    totals: amounts.totals,
    lines,
  };
  const pm = paymentMeansCodeFor(src.paymentType);
  if (pm) doc.paymentMeansCode = pm;
  if (isNote) {
    const refs = (src.billingReferences ?? []).map(r => clean(r)).filter((r): r is string => !!r);
    if (refs.length) doc.billingReferences = refs;
    const note = clean(src.noteReason);
    if (note) doc.instructionNote = note;
  }
  return doc;
}

export function subtypeOf(doc: Pick<UblDocument, 'typeName'>): InvoiceSubtype | null {
  const s = doc.typeName?.slice(0, 2);
  return s === '01' || s === '02' ? s : null;
}

/** نوع الفحص المسبق المشتقّ من المستند. */
export function preflightKindOf(doc: Pick<UblDocument, 'typeName'>): 'standard' | 'simplified' {
  return subtypeOf(doc) === '01' ? 'standard' : 'simplified';
}

/** شكل اللقطة المحفوظة في Invoice.einvoiceSnapshot (الإصدار 1). */
export interface ZatcaSnapshotV1 {
  v: 1;
  currency: string;
  id: string;
  issueDate: string;
  issueTime: string;
  typeCode: InvoiceTypeCode;
  typeName: string;
  subtype: InvoiceSubtype | null;
  supplyDate?: string;
  paymentMeansCode?: string;
  billingReferences?: string[];
  instructionNote?: string;
  supplier: UblParty;
  customer: UblParty;
  lines: UblLine[];
  docAllowances: UblDocument['docAllowances'];
  subtotals: UblSubtotal[];
  totals: UblDocument['totals'];
}

/**
 * لقطة البائع والمشتري والبنود والمبالغ **كما كُتبت في الـXML** لإعادة الطباعة (G7).
 * تستبعد قيم السلسلة (uuid/icv/pih) لأنها تخصّ محاولة ZatcaDocument بعينها، وتبقى
 * اللقطة ثابتة عبر إعادة الإصدار بنفس الرقم والتاريخ. نسخة JSON عميقة بترتيب مفاتيح ثابت.
 */
export function buildSnapshot(doc: UblDocument): ZatcaSnapshotV1 {
  const snap: ZatcaSnapshotV1 = {
    v: 1,
    currency: doc.currency,
    id: doc.id,
    issueDate: doc.issueDate,
    issueTime: doc.issueTime,
    typeCode: doc.typeCode,
    typeName: doc.typeName,
    subtype: subtypeOf(doc),
    supplyDate: doc.supplyDate,
    paymentMeansCode: doc.paymentMeansCode,
    billingReferences: doc.billingReferences,
    instructionNote: doc.instructionNote,
    supplier: doc.supplier,
    customer: doc.customer,
    lines: doc.lines,
    docAllowances: doc.docAllowances,
    subtotals: doc.subtotals,
    totals: doc.totals,
  };
  return JSON.parse(JSON.stringify(snap)) as ZatcaSnapshotV1;
}
