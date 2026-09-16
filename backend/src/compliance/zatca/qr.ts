// ============================================================================
// ZATCA المرحلة الثانية (Z2) — رمز QR للمرحلة الثانية (TLV ثم base64)
// ----------------------------------------------------------------------------
// C-Q1: كل وسم = [رقم الوسم بايت][الطول بايت][القيمة]، متتالية بلا فواصل، ثم base64.
// C-Q2/C-Q3 كما تحقّقنا على عيّنات الـSDK 3.4.8 الرسمية التسع عشرة:
//   1 اسم البائع UTF-8 · 2 الرقم الضريبي · 3 IssueDate + 'T' + IssueTime (بلا Z)
//   4 **PayableAmount (BT-115) كنصّه في الـXML** — لا TaxInclusiveAmount: عيّنات الدفعات المقدَّمة
//     الثلاث وعيّنة PayableRoundingAmount تحمل في الوسم 4 قيمة PayableAmount (1035/1135/1000.00) بينما
//     TaxInclusiveAmount = 2185/1000.01؛ وفي بقية العيّنات القيمتان متساويتان. (يخالف C-Q2 في التصميم، ويمسّ فعلاً
//     فواتير المندوب الشاملة ذات PayableRoundingAmount — التأكيد النهائي بـ fatoora -qr في G2 والمحاكاة في G4: U1/U5.)
//   5 إجمالي الضريبة: TaxTotal/TaxAmount بعملة الضريبة (TaxCurrencyCode) كنصّه ("0.6" لا "0.60")
//   6 نصّ base64 لتجزئة الفاتورة (44 بايت ASCII) · 7 نصّ base64 لـSignatureValue
//   8 SubjectPublicKeyInfo بصيغة DER (88 بايت) · 9 توقيع الشهادة DER — للمبسّطة وإشعاراتها فقط.
// UNVERIFIED(U1) — design §6.2:
//   • ترميز الطول للقيم 128–255 بايت: نكتب بايتاً واحداً كما في SEC §4.1 (ويُحذَّر مسبقاً فوق 127 بايت).
//   • سقف الطول الكلّي: 700 محرف base64 (SEC §4.1) مقابل 1000 في الـSDK (مصدر ثانوي) — نفرض 700
//     افتراضياً (الأحوط: لا يدخل السلسلة مستندٌ قد يُرفض)، والقيمة قابلة للتمرير صراحةً بعد حسم G2/G4.
// ============================================================================

import { UBL_NS, isQrReference, qrReferenceText, toDocument, XmlInput } from './c14n';
import { XmlDocument, XmlElement, XmlError, childElements, childPath, clipMessage, directText, attr } from './xml';
import { isCanonicalBase64 } from './cert';
import { QR_MAX_BASE64_LENGTH, TLV_MAX_VALUE_BYTES, assertQrMaxLength } from './qrBudget';

export { QR_MAX_BASE64_LENGTH, TLV_MAX_VALUE_BYTES } from './qrBudget';

/** QR_TOO_LONG: تجاوز السقف (خطأ بيانات يُعاد 422 باسم الحقل) · QR_INVALID: ما سواه. */
export type QrErrorCode = 'QR_TOO_LONG' | 'QR_INVALID';

export class QrError extends Error {
  readonly code: QrErrorCode;
  constructor(message: string, code: QrErrorCode = 'QR_INVALID') {
    super(clipMessage(`QR: ${message}`));
    this.name = 'QrError';
    this.code = code;
  }
}

/** C-Q1: TLV. يرمي إن تجاوزت قيمة 255 بايت أو كان الوسم خارج 1..255. */
export function tlv(tags: Array<[number, Uint8Array]>): Uint8Array {
  const parts: Buffer[] = [];
  for (const [tag, value] of tags) {
    if (!Number.isInteger(tag) || tag < 1 || tag > 255) throw new QrError(`رقم وسم غير صالح ${tag}`);
    if (!(value instanceof Uint8Array)) throw new QrError(`قيمة الوسم ${tag} ليست بايتات`);
    if (value.length > TLV_MAX_VALUE_BYTES) throw new QrError(`قيمة الوسم ${tag} = ${value.length} بايت (> ${TLV_MAX_VALUE_BYTES})`);
    parts.push(Buffer.from([tag, value.length]), Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(parts);
}

/** أقصى عدد وسوم يُقرأ: المرحلة الثانية 9 — لا مصفوفة بملايين العُقد من TLVات فارغة. */
export const MAX_QR_TAGS = 9;
/** أطول نصّ QR يُفكّ: ضعف أعلى سقف مطروح (1000) بهامش — يُفحص بزمن ثابت قبل أي فكّ. */
export const MAX_QR_DECODE_LENGTH = 2048;

/** يفكّ TLV بصرامة (لا بايتات مبتورة، ولا أكثر من maxTags وسماً). */
export function decodeTlv(bytes: Uint8Array, maxTags = MAX_QR_TAGS): Array<[number, Uint8Array]> {
  const out: Array<[number, Uint8Array]> = [];
  let i = 0;
  while (i < bytes.length) {
    if (out.length >= maxTags) throw new QrError(`أكثر من ${maxTags} وسوم`);
    if (i + 2 > bytes.length) throw new QrError(`TLV مبتور عند ${i}`);
    const tag = bytes[i], len = bytes[i + 1];
    if (tag === 0) throw new QrError(`وسم صفري عند ${i}`);
    if (i + 2 + len > bytes.length) throw new QrError(`قيمة الوسم ${tag} مبتورة`);
    out.push([tag, bytes.subarray(i + 2, i + 2 + len)]);
    i += 2 + len;
  }
  return out;
}

export interface Phase2QrFields {
  sellerName: string;
  vat: string;
  /** IssueDate + 'T' + IssueTime */
  timestamp: string;
  /** الوسم 4: PayableAmount (BT-115) كنصّه في الـXML — راجع الترويسة. */
  totalWithVat: string;
  /** الوسم 5: TaxTotal/TaxAmount بعملة الضريبة كنصّه في الـXML. */
  vatTotal: string;
  invoiceHash: string;
  signatureB64: string;
  spkiDer: Uint8Array;
  /** للمبسّطة وإشعاراتها فقط. */
  certSignatureDer?: Uint8Array;
}

const utf8 = (s: string) => Buffer.from(s, 'utf8');

/** C-Q1..Q4: يبني QR المرحلة الثانية base64. */
export function buildPhase2Qr(f: Phase2QrFields, maxBase64Length = QR_MAX_BASE64_LENGTH): string {
  try {
    assertQrMaxLength(maxBase64Length);
  } catch (e) {
    throw new QrError((e as Error).message);
  }
  const text = (v: unknown, what: string) => {
    if (typeof v !== 'string' || v.trim() === '') throw new QrError(`${what} مفقود`);
    return v;
  };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(text(f.timestamp, 'الختم الزمني'))) {
    throw new QrError(`الختم الزمني بصيغة غير YYYY-MM-DDTHH:mm:ss (UNVERIFIED(U2)): «${f.timestamp}»`);
  }
  if (!/^\d+(\.\d+)?$/.test(text(f.totalWithVat, 'الإجمالي')) || !/^\d+(\.\d+)?$/.test(text(f.vatTotal, 'الضريبة'))) {
    throw new QrError('المبالغ يجب أن تكون أعداداً عشرية غير سالبة كنصّها في الـXML');
  }
  if (!isCanonicalBase64(f.invoiceHash) || Buffer.from(f.invoiceHash, 'base64').length !== 32) throw new QrError('تجزئة الفاتورة ليست base64 لـ32 بايت');
  if (!isCanonicalBase64(f.signatureB64)) throw new QrError('التوقيع ليس base64 قانونياً');
  if (!(f.spkiDer instanceof Uint8Array) || f.spkiDer.length === 0) throw new QrError('المفتاح العام مفقود');
  // اسم البائع فوق 255 بايت خطأ بيانات يصحّحه المستخدم (كالتجاوز الكلّي للسقف) — لا عطل داخلي
  const nameBytes = utf8(text(f.sellerName, 'اسم البائع')).length;
  if (nameBytes > TLV_MAX_VALUE_BYTES) throw new QrError(`اسم البائع ${nameBytes} بايت (> ${TLV_MAX_VALUE_BYTES}) لا يتّسع له وسم QR 1`, 'QR_TOO_LONG');
  const tags: Array<[number, Uint8Array]> = [
    [1, utf8(text(f.sellerName, 'اسم البائع'))],
    [2, utf8(text(f.vat, 'الرقم الضريبي'))],
    [3, utf8(f.timestamp)],
    [4, utf8(f.totalWithVat)],
    [5, utf8(f.vatTotal)],
    [6, utf8(f.invoiceHash)],
    [7, utf8(f.signatureB64)],
    [8, f.spkiDer],
  ];
  if (f.certSignatureDer !== undefined) {
    if (!(f.certSignatureDer instanceof Uint8Array) || f.certSignatureDer.length === 0) throw new QrError('توقيع الشهادة (الوسم 9) فارغ');
    tags.push([9, f.certSignatureDer]);
  }
  const b64 = Buffer.from(tlv(tags)).toString('base64');
  if (b64.length > maxBase64Length) {
    throw new QrError(`طول QR ${b64.length} محرفاً > ${maxBase64Length} (UNVERIFIED(U1): 700 مقابل 1000) — غالباً اسم البائع طويل (${utf8(f.sellerName).length} بايت)`, 'QR_TOO_LONG');
  }
  return b64;
}

export interface DecodedQr {
  tags: Array<[number, Uint8Array]>;
  sellerName: string;
  vat: string;
  timestamp: string;
  totalWithVat: string;
  vatTotal: string;
  invoiceHash?: string;
  signatureB64?: string;
  spkiDer?: Uint8Array;
  certSignatureDer?: Uint8Array;
}

const strictUtf8 = (b: Uint8Array, tag: number) => {
  const s = Buffer.from(b).toString('utf8');
  if (!Buffer.from(s, 'utf8').equals(Buffer.from(b))) throw new QrError(`الوسم ${tag} ليس UTF-8 صالحاً`);
  return s;
};

/** يفكّ QR (المرحلة الأولى 1–5 أو الثانية 1–8/9): وسوم مرتّبة تصاعدياً بلا تكرار ولا وسوم مجهولة. */
export function decodeQr(b64: string): DecodedQr {
  // الطول أولاً وبزمن ثابت: نصّ QR خارج التجزئة والتوقيع فقد يكون عدائياً
  if (typeof b64 !== 'string' || b64.length > MAX_QR_DECODE_LENGTH) throw new QrError(`نصّ QR أطول من ${MAX_QR_DECODE_LENGTH} محرفاً`);
  if (!isCanonicalBase64(b64)) throw new QrError('النص ليس base64 قانونياً');
  const tags = decodeTlv(Buffer.from(b64, 'base64'));
  const nums = tags.map(t => t[0]);
  const phase1 = [1, 2, 3, 4, 5];
  const ok = [phase1, [...phase1, 6, 7, 8], [...phase1, 6, 7, 8, 9]].some(seq => seq.length === nums.length && seq.every((n, i) => nums[i] === n));
  if (!ok) throw new QrError(`تسلسل وسوم غير متوقَّع [${nums.slice(0, MAX_QR_TAGS).join(',')}]`);
  const get = (n: number) => tags.find(t => t[0] === n)?.[1];
  const out: DecodedQr = {
    tags,
    sellerName: strictUtf8(get(1)!, 1),
    vat: strictUtf8(get(2)!, 2),
    timestamp: strictUtf8(get(3)!, 3),
    totalWithVat: strictUtf8(get(4)!, 4),
    vatTotal: strictUtf8(get(5)!, 5),
  };
  if (get(6)) {
    out.invoiceHash = strictUtf8(get(6)!, 6);
    out.signatureB64 = strictUtf8(get(7)!, 7);
    out.spkiDer = Uint8Array.from(get(8)!);
  }
  if (get(9)) out.certSignatureDer = Uint8Array.from(get(9)!);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// من الـXML
// ─────────────────────────────────────────────────────────────────────────────

/** مرجع QR الأعلى (ابن مباشر للجذر) أو undefined؛ يرمي إن تكرّر. */
export function qrReferenceElement(doc: XmlDocument): XmlElement | undefined {
  // نفس مطابقة invoice.xsl (normalize-space) كي لا يختلف ما نقرؤه عمّا يُحذف من التجزئة
  const refs = childElements(doc.root, UBL_NS.CAC, 'AdditionalDocumentReference').filter(isQrReference);
  if (refs.length > 1) throw new XmlError('STRUCTURE', 'أكثر من مرجع QR', refs[1].start);
  return refs[0];
}

/**
 * نصّ QR المضمَّن في الفاتورة، أو null إن غاب أو كان فارغاً. يُقصّ **فراغ XML فقط** (فراغ، TAB، LF، CR) —
 * لا String.prototype.trim الذي يزيل NBSP وBOM وU+3000 فيقبل نصاً لا يفكّه قارئ الهيئة.
 * التحقّق من مستند مختوم (verifyStampedXml) يقارن النصّ الخام حرفياً بلا أي قصّ.
 */
export function extractQrFromXml(xml: XmlInput): string | null {
  const doc = toDocument(xml);
  const ref = qrReferenceElement(doc);
  if (!ref) return null;
  const t = qrReferenceText(ref);
  if (t === undefined) return null;
  // مسح خطّي بالفهارس (التعبير /[ \t\n\r]+$/ غير المرسى من البداية تربيعيّ على فراغ طويل داخلي)
  const isWs = (c: number) => c === 0x20 || c === 0x9 || c === 0xa || c === 0xd;
  let a = 0, b = t.length;
  while (a < b && isWs(t.charCodeAt(a))) a++;
  while (b > a && isWs(t.charCodeAt(b - 1))) b--;
  return a === b ? null : t.slice(a, b);
}

export interface QrXmlSource {
  sellerName: string;
  vat: string;
  timestamp: string;
  totalWithVat: string;
  vatTotal: string;
  /** '01' قياسي أو '02' مبسّط (أول خانتين من InvoiceTypeCode/@name). */
  subtype: string;
  /** نصّا IssueDate وIssueTime منفصلين: الختم الزمني المجمَّع بـT لا يُفكّ بلا غموض إن احتوى أحدهما T. */
  issueDate?: string;
  issueTime?: string;
}

const onlyText = (el: XmlElement | undefined, what: string): string => {
  if (!el) throw new XmlError('STRUCTURE', `${what} مفقود`);
  return directText(el);
};

/**
 * قيم الوسوم 1–5 كما هي مكتوبة في الـXML (المصدر المرجعي للتحقق الذاتي والاختبار الذهبي).
 * lenient: العنصر المفقود يُقرأ '' بدل رمي STRUCTURE — فيصنّفه الختم خطأ بيانات باسم الحقل (المُسلسِل يُسقط
 * العنصر الفارغ أصلاً، فلا يصل «فارغ» إلى هنا إلا مفقوداً).
 */
export function readQrSourceFromXml(xml: XmlInput, opts: { lenient?: boolean } = {}): QrXmlSource {
  const doc = toDocument(xml);
  const root = doc.root;
  const { CAC, CBC } = UBL_NS;
  const text = opts.lenient ? (el: XmlElement | undefined) => (el ? directText(el) : '') : onlyText;
  const party = childPath(root, [[CAC, 'AccountingSupplierParty'], [CAC, 'Party']]);
  if (!party && !opts.lenient) throw new XmlError('STRUCTURE', 'AccountingSupplierParty/Party مفقود');
  const sellerName = text(party && childPath(party, [[CAC, 'PartyLegalEntity'], [CBC, 'RegistrationName']]), 'RegistrationName');
  const vat = text(party && childPath(party, [[CAC, 'PartyTaxScheme'], [CBC, 'CompanyID']]), 'CompanyID');
  const issueDate = text(childElements(root, CBC, 'IssueDate')[0], 'IssueDate');
  const issueTime = text(childElements(root, CBC, 'IssueTime')[0], 'IssueTime');
  const payable = text(childPath(root, [[CAC, 'LegalMonetaryTotal'], [CBC, 'PayableAmount']]), 'PayableAmount');
  const taxCurrency = childElements(root, CBC, 'TaxCurrencyCode')[0];
  const cur = taxCurrency ? directText(taxCurrency).trim() : 'SAR';
  const taxAmounts = childElements(root, CAC, 'TaxTotal')
    .map(t => childElements(t, CBC, 'TaxAmount')[0])
    .filter((a): a is XmlElement => !!a && attr(a, 'currencyID') === cur);
  const typeCode = childElements(root, CBC, 'InvoiceTypeCode')[0];
  const name = typeCode ? attr(typeCode, 'name') ?? '' : '';
  if (!taxAmounts.length && !opts.lenient) throw new XmlError('STRUCTURE', `لا TaxTotal/TaxAmount بعملة الضريبة ${cur}`);
  return {
    sellerName,
    vat,
    timestamp: `${issueDate}T${issueTime}`,
    issueDate,
    issueTime,
    totalWithVat: payable,
    vatTotal: taxAmounts.length ? directText(taxAmounts[0]) : '',
    subtype: name.slice(0, 2),
  };
}
