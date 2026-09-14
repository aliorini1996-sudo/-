// ============================================================================
// ZATCA المرحلة الثانية (Z1) — مُسلسِل UBL 2.1 غير الموقَّع (حتمي بايتاً ببايت)
// ----------------------------------------------------------------------------
// تجزئة الفاتورة (C-S1) تشمل كل مسافة خارج الكتل الثلاث المحذوفة قبل التجزئة
// (ext:UBLExtensions · cac:Signature · مرجع QR). لذا:
//   • ترتيب العناصر ثابت (C-O1/C-O2) ومسافة بادئة 4 فراغات وأسطر LF وUTF-8 بلا BOM.
//   • قالب التوقيع منسوخ من عيّنة الـSDK بمسافاتها حرفياً مع **قيم فارغة** يملؤها Z2
//     (نصّاً فقط)؛ كتلة SignedProperties تبدأ عند 32 فراغاً كما يتطلب C-S7.
//   • لا يتغيّر بعد هذه المرحلة إلا النص داخل الكتل الثلاث (design §3 Z1 Serializer).
// الإشعار الدائن والمدين يستعملان جذر <Invoice> مع BillingReference وInstructionNote (C-H1).
// لا عنصر فارغاً أبداً (BR-KSA-F-03) — عدا خانات القالب التي يملؤها Z2.
// ============================================================================

import { UblAddress, UblDocument, UblLine, UblParty } from './model';
import { sanitizeText } from './validators';

export { sanitizeText };

const NS_INVOICE = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
const NS_CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const NS_CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const NS_EXT = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';

/** الملف يبدأ بهذا حرفياً (الإعلان + وسم الجذر، ثم ext:UBLExtensions على نفس السطر كعيّنة الـSDK). */
export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
export const ROOT_OPEN = `<Invoice xmlns="${NS_INVOICE}" xmlns:cac="${NS_CAC}" xmlns:cbc="${NS_CBC}" xmlns:ext="${NS_EXT}">`;

/**
 * قالب ext:UBLExtensions من عيّنة الـSDK (xml report §4.1) بخانات فارغة. السطر الأول يُلصق
 * بوسم الجذر بلا فاصل. خانات Z2 (بالترتيب): DigestValue للفاتورة، DigestValue للخصائص الموقَّعة،
 * SignatureValue، X509Certificate، SigningTime، DigestValue للشهادة، X509IssuerName، X509SerialNumber.
 */
export const UBL_EXTENSIONS_TEMPLATE: readonly string[] = [
  '<ext:UBLExtensions>',
  '    <ext:UBLExtension>',
  '        <ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>',
  '        <ext:ExtensionContent>',
  '            <sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2" xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2">',
  '                <sac:SignatureInformation>',
  '                    <cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID>',
  '                    <sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>',
  '                    <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="signature">',
  '                        <ds:SignedInfo>',
  '                            <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>',
  '                            <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>',
  '                            <ds:Reference Id="invoiceSignedData" URI="">',
  '                                <ds:Transforms>',
  '                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">',
  '                                        <ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath>',
  '                                    </ds:Transform>',
  '                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">',
  '                                        <ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath>',
  '                                    </ds:Transform>',
  '                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">',
  "                                        <ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath>",
  '                                    </ds:Transform>',
  '                                    <ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>',
  '                                </ds:Transforms>',
  '                                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>',
  '                                <ds:DigestValue></ds:DigestValue>',
  '                            </ds:Reference>',
  '                            <ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties">',
  '                                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>',
  '                                <ds:DigestValue></ds:DigestValue>',
  '                            </ds:Reference>',
  '                        </ds:SignedInfo>',
  '                        <ds:SignatureValue></ds:SignatureValue>',
  '                        <ds:KeyInfo>',
  '                            <ds:X509Data>',
  '                                <ds:X509Certificate></ds:X509Certificate>',
  '                            </ds:X509Data>',
  '                        </ds:KeyInfo>',
  '                        <ds:Object>',
  '                            <xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="signature">',
  '                                <xades:SignedProperties Id="xadesSignedProperties">',
  '                                    <xades:SignedSignatureProperties>',
  '                                        <xades:SigningTime></xades:SigningTime>',
  '                                        <xades:SigningCertificate>',
  '                                            <xades:Cert>',
  '                                                <xades:CertDigest>',
  '                                                    <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>',
  '                                                    <ds:DigestValue></ds:DigestValue>',
  '                                                </xades:CertDigest>',
  '                                                <xades:IssuerSerial>',
  '                                                    <ds:X509IssuerName></ds:X509IssuerName>',
  '                                                    <ds:X509SerialNumber></ds:X509SerialNumber>',
  '                                                </xades:IssuerSerial>',
  '                                            </xades:Cert>',
  '                                        </xades:SigningCertificate>',
  '                                    </xades:SignedSignatureProperties>',
  '                                </xades:SignedProperties>',
  '                            </xades:QualifyingProperties>',
  '                        </ds:Object>',
  '                    </ds:Signature>',
  '                </sac:SignatureInformation>',
  '            </sig:UBLDocumentSignatures>',
  '        </ext:ExtensionContent>',
  '    </ext:UBLExtension>',
  '</ext:UBLExtensions>',
];

/** خانة QR الفارغة التي يملؤها Z2 (داخل مرجع QR المحذوف قبل التجزئة). */
export const QR_PLACEHOLDER_LINE = '            <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain"></cbc:EmbeddedDocumentBinaryObject>';

// ─────────────────────────────────────────────────────────────────────────────
// تهريب النص
// ─────────────────────────────────────────────────────────────────────────────

// sanitizeText (validators.ts) يطبّقه mapInvoice على كل نص قبل البناء؛ إعادته هنا احتياط لمستند
// بُني خارج ذلك المسار — والفحص المسبق يمنع مثل هذا المستند قبل الوصول إلى هنا (XML-TEXT).

/** تهريب نص عنصر. */
export function escapeText(s: string): string {
  return sanitizeText(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** تهريب قيمة سمة (بين علامتي تنصيص مزدوجتين). */
export function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;');
}

// ─────────────────────────────────────────────────────────────────────────────
// كاتب الأسطر
// ─────────────────────────────────────────────────────────────────────────────

class Writer {
  readonly out: string[] = [];
  private ind(depth: number) { return '    '.repeat(depth); }
  open(depth: number, tag: string) { this.out.push(`${this.ind(depth)}<${tag}>`); }
  close(depth: number, tag: string) { this.out.push(`${this.ind(depth)}</${tag}>`); }
  /** عنصر نصّي؛ يُحذف كلياً إن كانت القيمة فارغة (لا عناصر فارغة). */
  leaf(depth: number, tag: string, value: string | number | undefined | null, attrs?: Record<string, string>) {
    if (value === undefined || value === null) return;
    const text = escapeText(String(value));
    if (text.trim() === '') return;
    const a = attrs ? Object.entries(attrs).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('') : '';
    this.out.push(`${this.ind(depth)}<${tag}${a}>${text}</${tag}>`);
  }
  raw(line: string) { this.out.push(line); }
}

const hasText = (v: string | undefined | null) => typeof v === 'string' && sanitizeText(v).trim() !== '';

function taxScheme(w: Writer, depth: number) {
  w.open(depth, 'cac:TaxScheme');
  w.leaf(depth + 1, 'cbc:ID', 'VAT');
  w.close(depth, 'cac:TaxScheme');
}

function address(w: Writer, depth: number, a: UblAddress | undefined) {
  if (!a) return;
  const fields = [a.street, a.buildingNumber, a.additionalNumber, a.district, a.city, a.postalZone, a.country];
  if (!fields.some(hasText)) return;
  w.open(depth, 'cac:PostalAddress');
  // C-O2: StreetName, BuildingNumber, PlotIdentification, CitySubdivisionName, CityName, PostalZone, Country
  w.leaf(depth + 1, 'cbc:StreetName', a.street);
  w.leaf(depth + 1, 'cbc:BuildingNumber', a.buildingNumber);
  w.leaf(depth + 1, 'cbc:PlotIdentification', a.additionalNumber);
  w.leaf(depth + 1, 'cbc:CitySubdivisionName', a.district);
  w.leaf(depth + 1, 'cbc:CityName', a.city);
  w.leaf(depth + 1, 'cbc:PostalZone', a.postalZone);
  if (hasText(a.country)) {
    w.open(depth + 1, 'cac:Country');
    w.leaf(depth + 2, 'cbc:IdentificationCode', a.country);
    w.close(depth + 1, 'cac:Country');
  }
  w.close(depth, 'cac:PostalAddress');
}

function party(w: Writer, depth: number, wrapper: string, p: UblParty) {
  w.open(depth, wrapper);
  const d = depth + 1;
  const hasId = !!p.otherId && hasText(p.otherId.value);
  const hasAddr = !!p.address && [p.address.street, p.address.buildingNumber, p.address.additionalNumber, p.address.district, p.address.city, p.address.postalZone, p.address.country].some(hasText);
  if (hasId || hasAddr || hasText(p.vatNumber) || hasText(p.registrationName)) {
    w.open(d, 'cac:Party');
    // ترتيب cac:Party: PartyIdentification, PostalAddress, PartyTaxScheme, PartyLegalEntity
    if (hasId) {
      w.open(d + 1, 'cac:PartyIdentification');
      w.leaf(d + 2, 'cbc:ID', p.otherId!.value, { schemeID: p.otherId!.scheme });
      w.close(d + 1, 'cac:PartyIdentification');
    }
    address(w, d + 1, p.address);
    if (hasText(p.vatNumber)) {
      w.open(d + 1, 'cac:PartyTaxScheme');
      w.leaf(d + 2, 'cbc:CompanyID', p.vatNumber);
      taxScheme(w, d + 2);
      w.close(d + 1, 'cac:PartyTaxScheme');
    }
    if (hasText(p.registrationName)) {
      w.open(d + 1, 'cac:PartyLegalEntity');
      w.leaf(d + 2, 'cbc:RegistrationName', p.registrationName);
      w.close(d + 1, 'cac:PartyLegalEntity');
    }
    w.close(d, 'cac:Party');
  }
  w.close(depth, wrapper);
}

function taxCategory(w: Writer, depth: number, tag: string, c: { category: string; percent: string; exemptionCode?: string; exemptionReason?: string }) {
  w.open(depth, tag);
  // ID, Percent, TaxExemptionReasonCode, TaxExemptionReason, TaxScheme
  w.leaf(depth + 1, 'cbc:ID', c.category);
  w.leaf(depth + 1, 'cbc:Percent', c.percent);
  w.leaf(depth + 1, 'cbc:TaxExemptionReasonCode', c.exemptionCode);
  w.leaf(depth + 1, 'cbc:TaxExemptionReason', c.exemptionReason);
  taxScheme(w, depth + 1);
  w.close(depth, tag);
}

function invoiceLine(w: Writer, l: UblLine, cur: string) {
  const amt = { currencyID: cur };
  w.open(1, 'cac:InvoiceLine');
  // ID, InvoicedQuantity, LineExtensionAmount, AllowanceCharge*, TaxTotal, Item, Price
  w.leaf(2, 'cbc:ID', String(l.id));
  w.leaf(2, 'cbc:InvoicedQuantity', l.quantity, { unitCode: l.unitCode });
  w.leaf(2, 'cbc:LineExtensionAmount', l.lineExtension, amt);
  if (l.allowance) {
    w.open(2, 'cac:AllowanceCharge');
    // ChargeIndicator, AllowanceChargeReason, MultiplierFactorNumeric, Amount, BaseAmount
    w.leaf(3, 'cbc:ChargeIndicator', 'false');
    w.leaf(3, 'cbc:AllowanceChargeReason', l.allowance.reason);
    w.leaf(3, 'cbc:MultiplierFactorNumeric', l.allowance.multiplier);
    w.leaf(3, 'cbc:Amount', l.allowance.amount, amt);
    w.leaf(3, 'cbc:BaseAmount', l.allowance.baseAmount, amt);
    w.close(2, 'cac:AllowanceCharge');
  }
  w.open(2, 'cac:TaxTotal');
  w.leaf(3, 'cbc:TaxAmount', l.taxAmount, amt);
  w.leaf(3, 'cbc:RoundingAmount', l.roundingAmount, amt);
  w.close(2, 'cac:TaxTotal');
  w.open(2, 'cac:Item');
  w.leaf(3, 'cbc:Name', l.name);
  // التصنيف على مستوى البند بلا رمز إعفاء؛ الرمز والنص في TaxSubtotal (BT-120/121)
  taxCategory(w, 3, 'cac:ClassifiedTaxCategory', { category: l.vat.category, percent: l.vat.percent });
  w.close(2, 'cac:Item');
  w.open(2, 'cac:Price');
  w.leaf(3, 'cbc:PriceAmount', l.priceAmount, amt);
  w.close(2, 'cac:Price');
  w.close(1, 'cac:InvoiceLine');
}

/**
 * يُسلسل المستند إلى XML غير موقَّع (UTF-8 بلا BOM، LF، مسافة 4). حتمي: نفس المستند ⇒ نفس البايتات.
 * لا يحسب ولا يتحقق — الفحص المسبق (preflight.ts) مسؤول عن الصلاحية قبل الاستدعاء.
 */
export function serializeUnsigned(doc: UblDocument): string {
  const w = new Writer();
  const cur = doc.currency;
  const amt = { currencyID: cur };

  w.raw(XML_DECLARATION);
  w.raw(ROOT_OPEN + UBL_EXTENSIONS_TEMPLATE[0]);
  for (let i = 1; i < UBL_EXTENSIONS_TEMPLATE.length; i++) w.raw(UBL_EXTENSIONS_TEMPLATE[i]);

  // ═══ الترويسة (C-O1) ═══
  w.leaf(1, 'cbc:ProfileID', 'reporting:1.0');
  w.leaf(1, 'cbc:ID', doc.id);
  w.leaf(1, 'cbc:UUID', doc.uuid);
  w.leaf(1, 'cbc:IssueDate', doc.issueDate);
  w.leaf(1, 'cbc:IssueTime', doc.issueTime);
  w.leaf(1, 'cbc:InvoiceTypeCode', doc.typeCode, { name: doc.typeName });
  w.leaf(1, 'cbc:DocumentCurrencyCode', cur);
  w.leaf(1, 'cbc:TaxCurrencyCode', 'SAR');
  for (const ref of doc.billingReferences ?? []) {
    if (!hasText(ref)) continue;
    w.open(1, 'cac:BillingReference');
    w.open(2, 'cac:InvoiceDocumentReference');
    w.leaf(3, 'cbc:ID', ref);
    w.close(2, 'cac:InvoiceDocumentReference');
    w.close(1, 'cac:BillingReference');
  }

  // ICV → PIH → QR (C-H8)
  w.open(1, 'cac:AdditionalDocumentReference');
  w.leaf(2, 'cbc:ID', 'ICV');
  w.leaf(2, 'cbc:UUID', String(doc.icv));
  w.close(1, 'cac:AdditionalDocumentReference');
  w.open(1, 'cac:AdditionalDocumentReference');
  w.leaf(2, 'cbc:ID', 'PIH');
  w.open(2, 'cac:Attachment');
  w.leaf(3, 'cbc:EmbeddedDocumentBinaryObject', doc.pih, { mimeCode: 'text/plain' });
  w.close(2, 'cac:Attachment');
  w.close(1, 'cac:AdditionalDocumentReference');
  w.open(1, 'cac:AdditionalDocumentReference');
  w.leaf(2, 'cbc:ID', 'QR');
  w.open(2, 'cac:Attachment');
  w.raw(QR_PLACEHOLDER_LINE);
  w.close(2, 'cac:Attachment');
  w.close(1, 'cac:AdditionalDocumentReference');

  w.open(1, 'cac:Signature');
  w.leaf(2, 'cbc:ID', 'urn:oasis:names:specification:ubl:signature:Invoice');
  w.leaf(2, 'cbc:SignatureMethod', 'urn:oasis:names:specification:ubl:dsig:enveloped:xades');
  w.close(1, 'cac:Signature');

  party(w, 1, 'cac:AccountingSupplierParty', doc.supplier);
  party(w, 1, 'cac:AccountingCustomerParty', doc.customer);

  if (hasText(doc.supplyDate)) {
    w.open(1, 'cac:Delivery');
    w.leaf(2, 'cbc:ActualDeliveryDate', doc.supplyDate);
    w.close(1, 'cac:Delivery');
  }
  if (hasText(doc.paymentMeansCode) || hasText(doc.instructionNote)) {
    w.open(1, 'cac:PaymentMeans');
    w.leaf(2, 'cbc:PaymentMeansCode', doc.paymentMeansCode);
    w.leaf(2, 'cbc:InstructionNote', doc.instructionNote);
    w.close(1, 'cac:PaymentMeans');
  }

  for (const a of doc.docAllowances) {
    w.open(1, 'cac:AllowanceCharge');
    // ChargeIndicator, AllowanceChargeReasonCode, AllowanceChargeReason, Amount, TaxCategory (BR-32)
    w.leaf(2, 'cbc:ChargeIndicator', 'false');
    w.leaf(2, 'cbc:AllowanceChargeReasonCode', a.reasonCode);
    w.leaf(2, 'cbc:AllowanceChargeReason', a.reason);
    w.leaf(2, 'cbc:Amount', a.amount, amt);
    taxCategory(w, 2, 'cac:TaxCategory', { category: a.category, percent: a.percent });
    w.close(1, 'cac:AllowanceCharge');
  }

  // TaxTotal الأول بلا تفصيل، والثاني بتفصيل لكل (فئة، نسبة) — C-A2
  w.open(1, 'cac:TaxTotal');
  w.leaf(2, 'cbc:TaxAmount', doc.totals.taxTotal, amt);
  w.close(1, 'cac:TaxTotal');
  w.open(1, 'cac:TaxTotal');
  w.leaf(2, 'cbc:TaxAmount', doc.totals.taxTotal, amt);
  for (const s of doc.subtotals) {
    w.open(2, 'cac:TaxSubtotal');
    w.leaf(3, 'cbc:TaxableAmount', s.taxable, amt);
    w.leaf(3, 'cbc:TaxAmount', s.tax, amt);
    taxCategory(w, 3, 'cac:TaxCategory', s);
    w.close(2, 'cac:TaxSubtotal');
  }
  w.close(1, 'cac:TaxTotal');

  const t = doc.totals;
  w.open(1, 'cac:LegalMonetaryTotal');
  w.leaf(2, 'cbc:LineExtensionAmount', t.lineExtension, amt);
  w.leaf(2, 'cbc:TaxExclusiveAmount', t.taxExclusive, amt);
  w.leaf(2, 'cbc:TaxInclusiveAmount', t.taxInclusive, amt);
  w.leaf(2, 'cbc:AllowanceTotalAmount', t.allowanceTotal, amt);
  w.leaf(2, 'cbc:PrepaidAmount', t.prepaid, amt);
  w.leaf(2, 'cbc:PayableRoundingAmount', t.payableRounding, amt);
  w.leaf(2, 'cbc:PayableAmount', t.payable, amt);
  w.close(1, 'cac:LegalMonetaryTotal');

  for (const l of doc.lines) invoiceLine(w, l, cur);

  w.raw('</Invoice>');
  return w.out.join('\n') + '\n';
}
