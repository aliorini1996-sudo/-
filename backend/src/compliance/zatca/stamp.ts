// ============================================================================
// ZATCA المرحلة الثانية (Z2) — ختم المستند: تجزئة + توقيع + XAdES + QR + تحقّق ذاتي
// ----------------------------------------------------------------------------
// design §3 Z2 «stampDocument steps» 1–8:
//   1 invoiceHash = computeInvoiceHash(unsigned)             (C-S1)
//   2 signatureB64 = signer.signHash(32 بايت التجزئة)          (C-S3: SHA256withECDSA فوق البايتات الخام)
//   3 certDigest = base64(hex(sha256(certB64)))               (C-S4)
//   4 signingTime = توقيت الرياض YYYY-MM-DDTHH:mm:ss          (C-S6، UNVERIFIED(U2) للاحقة Z)
//   5 spDigest = base64(hex(sha256(SignedProperties)))        (C-S7)
//   6 qr = buildPhase2Qr(...) — 1–8، و9 للمبسّطة فقط           (C-Q1..Q4)
//   7 ملء الخانات **نصّاً فقط** داخل قالب Z1 (لا إعادة تسلسل)
//   8 تحقّق ذاتي كامل قبل الإعادة، وأي فشل يرمي فتُلغى المعاملة.
// لا شيء هنا يتصل بقاعدة بيانات أو شبكة؛ الموقِّع يُحقن (HashSigner) كي يصلح لاحقاً لمفتاح في KMS.
// ============================================================================

import crypto from 'crypto';
import { HashExclusionLayout, assertNoForeignSignature, computeInvoiceHash, UBL_NS } from './c14n';
import { CsidCert, CsidCertError, isCanonicalBase64, parseCsidCertificate } from './cert';
import { verifySha256 } from './crypto';
import { childrenOf, decodeInteger, expectTag, parseDer, TAG } from './der';
import { UblDocument } from './model';
import { buildPhase2Qr, decodeQr, MAX_QR_DECODE_LENGTH, QR_MAX_BASE64_LENGTH, QrError, QrXmlSource, readQrSourceFromXml } from './qr';
import { TLV_MAX_VALUE_BYTES, maxSellerNameBytes } from './qrBudget';
import { isIsoDate, isIsoTime } from './time';

import { serializeUnsigned } from './ubl';
import { sanitizeText } from './validators';
import { riyadhDateTime } from './time';
import {
  SignatureSlots, assertCacSignature, assertSignatureTemplate, certDigest as computeCertDigest, isValidSigningTime,
  embeddedSignedPropertiesString, locateSignatureSlots, signedPropertiesDigest, signedPropertiesDigestOf,
} from './xades';
import { STAMP_XML_LIMITS, XmlDocument, XmlElement, XmlError, attr, childElements, clipMessage, directText, fillEmptyElements, parseXml } from './xml';
import { isXmlSafeText } from './cert';

export type StampKind = 'standard' | 'simplified';

/**
 * كل ما يرميه stampXml/stampDocument/verifyStampedXml هو StampError بأحد هذه الأكواد (لا TypeError ولا
 * أخطاء OpenSSL خام) كي يفرّق Z5 بين خطأ بيانات (422 باسم الحقل) وعطل داخلي (503 + تنبيه المالك):
 *   بيانات/إدخال: INPUT · KIND_MISMATCH · DOC_MISMATCH · SLOT_NOT_EMPTY · QR_TOO_LONG · XML_INVALID
 *   إعداد الوحدة: CERT_INVALID · CERT_KEY_MISMATCH · CERT_NOT_VALID · SIGNER
 *   فحص ذاتي/داخلي: SELF_CHECK_* · INTERNAL
 */
export type StampErrorCode =
  | 'INPUT' | 'KIND_MISMATCH' | 'DOC_MISMATCH' | 'SLOT_NOT_EMPTY' | 'QR_TOO_LONG' | 'XML_INVALID'
  | 'CERT_INVALID' | 'CERT_KEY_MISMATCH' | 'CERT_NOT_VALID' | 'SIGNER'
  | 'SELF_CHECK_HASH' | 'SELF_CHECK_SIGNATURE' | 'SELF_CHECK_QR' | 'SELF_CHECK_SIGNED_PROPERTIES' | 'SELF_CHECK_CERT'
  | 'SELF_CHECK_LAYOUT' | 'INTERNAL';

export class StampError extends Error {
  readonly code: StampErrorCode;
  /** الحقل في نموذج المستند حين يكون الخطأ خطأ بيانات قابلاً للتصحيح (مثل supplier.registrationName). */
  readonly field?: string;
  /** الخطأ الأصلي (XmlError/QrError/CsidCertError/…) — lib ES2020 لا يعرّف Error.cause. */
  readonly cause?: unknown;
  constructor(code: StampErrorCode, message: string, extra: { field?: string; cause?: unknown } = {}) {
    super(clipMessage(`${code}: ${message}`));
    this.name = 'StampError';
    this.code = code;
    if (extra.field !== undefined) this.field = extra.field;
    if ('cause' in extra) this.cause = extra.cause;
  }
}

/** يحوّل أي خطأ إلى StampError مصنَّف؛ fallback للأخطاء غير المتوقَّعة في مسار بعينه. */
const LIMIT_CODES: ReadonlySet<string> = new Set(['SIZE', 'NODES', 'DEPTH', 'ATTRS', 'NS_LIMIT']);

/** مستند مسار الختم: نصّ أو بايتات UTF-8 (تُحلَّل بحدود الختم) أو XmlDocument محلَّل؛ غير ذلك INPUT. */
function stampPathDocument(xml: unknown): XmlDocument {
  if (typeof xml === 'string' || xml instanceof Uint8Array) return parseXml(xml, STAMP_XML_LIMITS);
  if (xml && typeof xml === 'object' && 'root' in xml && 'source' in xml) return xml as XmlDocument;
  throw new StampError('INPUT', 'المستند يجب أن يكون نصاً أو بايتات UTF-8 أو XmlDocument');
}

function toStampError(e: unknown, fallback: StampErrorCode = 'INTERNAL'): StampError {
  if (e instanceof StampError) return e;
  if (e instanceof QrError) {
    return e.code === 'QR_TOO_LONG'
      ? new StampError('QR_TOO_LONG', e.message, { field: 'supplier.registrationName', cause: e })
      : new StampError('SELF_CHECK_QR', e.message, { cause: e });
  }
  if (e instanceof CsidCertError) return new StampError('CERT_INVALID', e.message, { cause: e });
  // تجاوز حدود الحجم/العقد/العمق/السمات: مستند أكبر من المدعوم (خطأ مدخلات) لا XML مشوّه
  if (e instanceof XmlError && LIMIT_CODES.has(e.code)) return new StampError('INPUT', `المستند أكبر من الحدّ المدعوم للختم: ${e.message}`, { field: 'lines', cause: e });
  if (e instanceof XmlError) return new StampError('XML_INVALID', e.message, { cause: e });
  return new StampError(fallback, (e as Error)?.message ?? String(e), { cause: e });
}

/** موقِّع التجزئة: توقيع ECDSA-SHA256 بصيغة DER فوق 32 بايت التجزئة، base64. */
export interface HashSigner {
  signHash(hash32: Uint8Array): Promise<string>;
  /** SPKI بصيغة DER إن كان معروفاً — يُطابَق مع مفتاح الشهادة (التقاط زوج مفتاح/شهادة خاطئ). */
  readonly publicKeySpkiDer?: Uint8Array;
}

/**
 * موقِّع الخادم من مفتاح secp256k1: PEM (SEC1 أو PKCS#8)، أو base64/بايتات DER (SEC1 ثم PKCS#8)، أو KeyObject.
 * crypto.sign('sha256', bytes, key) = Z0 signSha256 على Buffer (C-S3).
 */
export function createServerSigner(privateKey: string | Uint8Array | crypto.KeyObject): HashSigner {
  let key: crypto.KeyObject;
  const fromDer = (der: Buffer) => {
    try { return crypto.createPrivateKey({ key: der, format: 'der', type: 'sec1' }); } catch { /* جرّب PKCS#8 */ }
    return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  };
  try {
    if (privateKey instanceof crypto.KeyObject) key = privateKey;
    else if (typeof privateKey === 'string') key = privateKey.includes('-----BEGIN') ? crypto.createPrivateKey(privateKey) : fromDer(Buffer.from(privateKey.trim(), 'base64'));
    else key = fromDer(Buffer.from(privateKey));
  } catch (e) {
    throw new StampError('SIGNER', `تعذّر تحميل المفتاح الخاص: ${(e as Error).message}`);
  }
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'secp256k1') {
    throw new StampError('SIGNER', 'المفتاح ليس مفتاحاً خاصاً EC على secp256k1');
  }
  const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  return {
    publicKeySpkiDer: Uint8Array.from(spki),
    async signHash(hash32: Uint8Array): Promise<string> {
      if (!(hash32 instanceof Uint8Array) || hash32.length !== 32) throw new StampError('SIGNER', 'التجزئة يجب أن تكون 32 بايت');
      return crypto.sign('sha256', hash32, key).toString('base64');
    },
  };
}

export interface StampResult {
  xml: string;
  invoiceHash: string;
  signatureB64: string;
  qr: string;
  signingTime: string;
  certDigest: string;
  signedPropertiesDigest: string;
}

export interface StampOptions {
  /** سقف طول QR (UNVERIFIED(U1): 700 مقابل 1000 — design §6.2). */
  qrMaxLength?: number;
  /** قيم الوسوم 1–5 المتوقَّعة من النموذج؛ أي اختلاف عن الـXML يرمي DOC_MISMATCH. */
  expected?: Omit<QrXmlSource, 'subtype' | 'issueDate' | 'issueTime'>;
}

interface StampLayout {
  doc: XmlDocument;
  slots: SignatureSlots;
  qrSlot: XmlElement;
}

/**
 * مواضع الكتلتين المحذوفتين من التجزئة بين أبناء الجذر (تسلسل XSD كما يكتبه ubl.ts وكما في عيّنات الهيئة كلها):
 * مرجع ICV ← مرجع PIH ← مرجع QR ← cac:Signature ← cac:AccountingSupplierParty. نقل أيٍّ منهما لا يغيّر
 * التجزئة ولا التوقيع، لكنه يكسر مخطط الهيئة — فيُرفض هنا.
 */
function assertTemplatePositions(doc: XmlDocument, qrRef: XmlElement, cacSig: XmlElement): void {
  const kids = childElements(doc.root);
  const i = kids.indexOf(qrRef);
  const refId = (e: XmlElement | undefined) => (e && e.ns === UBL_NS.CAC && e.local === 'AdditionalDocumentReference'
    ? childElements(e, UBL_NS.CBC, 'ID').map(directText)[0] : undefined);
  const is = (e: XmlElement | undefined, local: string) => !!e && e.ns === UBL_NS.CAC && e.local === local;
  if (i < 2 || refId(kids[i - 1]) !== 'PIH' || refId(kids[i - 2]) !== 'ICV') {
    throw new XmlError('STRUCTURE', 'مرجع QR يجب أن يلي مرجعَي ICV ثم PIH مباشرة', qrRef.start);
  }
  if (kids[i + 1] !== cacSig || !is(kids[i + 2], 'AccountingSupplierParty')) {
    throw new XmlError('STRUCTURE', 'cac:Signature يجب أن يلي مرجع QR مباشرة ويسبق AccountingSupplierParty', cacSig.start);
  }
}

/**
 * مرجع QR — الكتلة الثالثة المحذوفة قبل التجزئة وغير الموقَّعة: بالضبط cbc:ID=QR ثم cac:Attachment فيه
 * cbc:EmbeddedDocumentBinaryObject وحده بسمة mimeCode="text/plain" وحدها. بلا هذا يمرّ cbc:ID مكرّر أو سمات
 * زائدة (يرفضها XSD الهيئة) عبر كل الفحوص الذاتية.
 */
function assertQrReference(ref: XmlElement): void {
  const fail = (why: string): never => { throw new XmlError('STRUCTURE', `مرجع QR يخالف القالب: ${why}`, ref.start); };
  const noText = (e: XmlElement) => e.children.every(c => c.kind !== 'text' || c.value.replace(/[ \t\n\r]/g, '') === '') || fail(`نصّ داخل <${e.qname}>`);
  if (ref.attributes.length) fail('سمات على AdditionalDocumentReference');
  noText(ref);
  const kids = childElements(ref);
  if (kids.length !== 2) fail(`${kids.length} عناصر بدل cbc:ID وcac:Attachment`);
  const [id, att] = kids;
  if (id.ns !== UBL_NS.CBC || id.local !== 'ID' || id.attributes.length || childElements(id).length || directText(id) !== 'QR') fail('cbc:ID ليس «QR» حرفياً');
  if (att.ns !== UBL_NS.CAC || att.local !== 'Attachment' || att.attributes.length) fail('cac:Attachment مفقود أو بسمات');
  noText(att);
  const objs = childElements(att);
  if (objs.length !== 1) fail(`${objs.length} عناصر داخل cac:Attachment`);
  const obj = objs[0];
  if (obj.ns !== UBL_NS.CBC || obj.local !== 'EmbeddedDocumentBinaryObject' || childElements(obj).length
    || obj.attributes.length !== 1 || attr(obj, 'mimeCode') !== 'text/plain') {
    fail('EmbeddedDocumentBinaryObject يجب أن يحمل mimeCode="text/plain" وحدها');
  }
}

function layoutOf(doc: XmlDocument): StampLayout {
  let layout: HashExclusionLayout;
  try {
    layout = assertNoForeignSignature(doc);
  } catch (e) {
    // كتلة قالب ناقصة/مكرّرة/في غير موضعها = خلل قالب (SELF_CHECK_LAYOUT)؛ عنصر Signature غريب في الجسم أو جذر
    // ليس Invoice = محتوى المستند (يبقى XML_INVALID عبر toStampError)
    if (e instanceof XmlError && e.code === 'STRUCTURE') throw new StampError('SELF_CHECK_LAYOUT', e.message, { cause: e });
    throw e;
  }
  let slots: SignatureSlots;
  try {
    // كل مخالفة لقالب C-S8 (خوارزمية، معرّف، XPath، ExtensionURI، موضع) كود واحد: SELF_CHECK_LAYOUT
    slots = locateSignatureSlots(layout.dsSignature);
    assertTemplatePositions(doc, layout.qrReference, layout.cacSignature);
    // C-S8 كاملاً (قبل أي عمل على الكتلة: يحدّ حجمها أيضاً فلا يُحرق CPU في دفع النطاقات على مستند محشوّ)
    assertSignatureTemplate(layout.ublExtensions, slots);
    assertCacSignature(layout.cacSignature);
    assertQrReference(layout.qrReference);
  } catch (e) {
    throw new StampError('SELF_CHECK_LAYOUT', (e as Error).message, { cause: e });
  }
  const atts = childElements(layout.qrReference, UBL_NS.CAC, 'Attachment');
  const objs = atts.length === 1 ? childElements(atts[0], UBL_NS.CBC, 'EmbeddedDocumentBinaryObject') : [];
  if (objs.length !== 1 || attr(objs[0], 'mimeCode') !== 'text/plain') {
    throw new StampError('SELF_CHECK_LAYOUT', 'مرجع QR بلا Attachment/EmbeddedDocumentBinaryObject[mimeCode=text/plain] واحد');
  }
  return { doc, slots, qrSlot: objs[0] };
}

const FILLED_SLOTS: Array<keyof SignatureSlots> = [
  'invoiceDigest', 'signedPropertiesDigest', 'signatureValue', 'certificate', 'signingTime', 'certDigest', 'issuerName', 'serialNumber',
];

function allSlots(l: StampLayout): XmlElement[] {
  return [...FILLED_SLOTS.map(k => l.slots[k]), l.qrSlot];
}

/** يعيد المستند المختوم إلى صورته قبل الختم (يُفرغ الخانات التسع نصّاً) — لإثبات أن لا بايت آخر تغيّر. */
export function unstampedForm(xml: string | Uint8Array | XmlDocument): string {
  try {
    return unstampedFormUnsafe(xml);
  } catch (e) {
    throw toStampError(e);
  }
}

function unstampedFormUnsafe(xml: string | Uint8Array | XmlDocument): string {
  const doc = stampPathDocument(xml);
  const l = layoutOf(doc);
  const ranges = allSlots(l).map(e => {
    if (e.selfClosing || e.children.some(c => c.kind !== 'text')) throw new StampError('SELF_CHECK_LAYOUT', `الخانة <${e.qname}> ليست نصّية`);
    return [e.openEnd, e.closeStart] as const;
  }).sort((a, b) => b[0] - a[0]);
  // مرور واحد تصاعدياً
  const asc = [...ranges].reverse();
  const parts: string[] = [];
  let pos = 0;
  for (const [a, b] of asc) { parts.push(doc.source.slice(pos, a)); pos = b; }
  parts.push(doc.source.slice(pos));
  return parts.join('');
}

function subtypeOfXml(doc: XmlDocument): string {
  const tc = childElements(doc.root, UBL_NS.CBC, 'InvoiceTypeCode')[0];
  return tc ? (attr(tc, 'name') ?? '').slice(0, 2) : '';
}

function assertKind(doc: XmlDocument, kind: StampKind): void {
  if (kind !== 'standard' && kind !== 'simplified') throw new StampError('INPUT', `نوع غير صالح ${String(kind)}`);
  const sub = subtypeOfXml(doc);
  const expected = kind === 'standard' ? '01' : '02';
  if (sub !== expected) throw new StampError('KIND_MISMATCH', `النوع ${kind} لا يطابق InvoiceTypeCode/@name (${sub || 'مفقود'})`);
}

/** توقيع ECDSA على secp256k1 بصيغة DER ≤ 72 بايت ⇒ ≤ 96 محرف base64. */
const MAX_SIGNATURE_B64_LENGTH = 96;

/** code: SIGNER لمخرَج الموقِّع وقت الختم، SELF_CHECK_SIGNATURE لنصّ مقروء من مستند عند التحقّق. */
function assertEcdsaDer(sigB64: string, code: 'SIGNER' | 'SELF_CHECK_SIGNATURE'): void {
  // الطول أولاً وبزمن ثابت: النصّ يأتي من مستند قد يكون عدائياً (SignatureValue خارج التجزئة)
  if (typeof sigB64 !== 'string' || sigB64.length > MAX_SIGNATURE_B64_LENGTH) throw new StampError(code, 'التوقيع أطول من توقيع ECDSA على منحنى 256 بت');
  if (!isCanonicalBase64(sigB64)) throw new StampError(code, 'التوقيع ليس base64 قانونياً');
  try {
    const seq = childrenOf(expectTag(parseDer(Buffer.from(sigB64, 'base64'), 8), TAG.SEQUENCE, 'ECDSA-Sig-Value'));
    if (seq.length !== 2 || decodeInteger(seq[0], 33) <= BigInt(0) || decodeInteger(seq[1], 33) <= BigInt(0)) throw new Error('r/s');
  } catch (e) {
    throw new StampError(code, `التوقيع ليس ECDSA-Sig-Value بصيغة DER: ${(e as Error).message}`);
  }
}

const bytesEqual = (a: Uint8Array | undefined, b: Uint8Array | undefined) => !!a && !!b && Buffer.from(a).equals(Buffer.from(b));

export interface VerifyExpectations {
  invoiceHash?: string;
  signatureB64?: string;
  qr?: string;
  signingTime?: string;
  signedPropertiesDigest?: string;
}

/**
 * التحقّق الكامل من مستند مختوم مقابل شهادة: التجزئة، التوقيع، XAdES، الشهادة، وQR (round-trip + مطابقة الـXML).
 * يرمي StampError عند أول مخالفة، ويعيد القيم المستخرجة.
 */
export function verifyStampedXml(xml: string | Uint8Array | XmlDocument, cert: CsidCert, kind: StampKind, exp: VerifyExpectations = {}): Omit<StampResult, 'xml'> {
  try {
    return verifyStampedXmlUnsafe(xml, cert, kind, exp);
  } catch (e) {
    throw toStampError(e);
  }
}

/** توقيت الرياض الثابت UTC+3 (لا توقيت صيفي) — SigningTime يُكتب به. */
const riyadhToDate = (t: string) => new Date(`${t}+03:00`);

/** يطابق كائن CsidCert مع الشهادة المُعاد تحليلها — كل الحقول بما فيها التواريخ (كائن من ذاكرة مؤقتة قد يكذب). */
function assertCertObjectMatches(reparsed: CsidCert, cert: CsidCert, code: StampErrorCode): void {
  const sameDate = (a: Date, b: Date) => a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (reparsed.certB64 !== cert.certB64 || reparsed.issuerName !== cert.issuerName || reparsed.serialDecimal !== cert.serialDecimal
    || !bytesEqual(reparsed.spkiDer, cert.spkiDer) || !bytesEqual(reparsed.certSignatureDer, cert.certSignatureDer)
    || reparsed.publicKeyPem !== cert.publicKeyPem
    || !sameDate(reparsed.notBefore, cert.notBefore) || !sameDate(reparsed.notAfter, cert.notAfter)) {
    throw new StampError(code, 'كائن CsidCert لا يطابق الشهادة (أحد الحقول أو تاريخا السريان مختلف)');
  }
}

function verifyStampedXmlUnsafe(xml: string | Uint8Array | XmlDocument, cert: CsidCert, kind: StampKind, exp: VerifyExpectations): Omit<StampResult, 'xml'> {
  if (!cert || typeof cert !== 'object') throw new StampError('INPUT', 'الشهادة مفقودة');
  const doc = stampPathDocument(xml);
  assertKind(doc, kind);
  const l = layoutOf(doc);
  const s = l.slots;
  const text = (k: keyof SignatureSlots) => directText(s[k]);
  const eq = (code: StampErrorCode, what: string, got: string | undefined, want: string | undefined) => {
    if (want !== undefined && got !== want) throw new StampError(code, `${what}: «${got}» ≠ «${want}»`);
  };

  // ─── الشهادة ───
  const certText = text('certificate');
  eq('SELF_CHECK_CERT', 'X509Certificate', certText, cert.certB64);
  const reparsed = parseCsidCertificate(certText);
  assertCertObjectMatches(reparsed, cert, 'SELF_CHECK_CERT');
  const cd = computeCertDigest(certText);
  eq('SELF_CHECK_CERT', 'CertDigest', text('certDigest'), cd);
  eq('SELF_CHECK_CERT', 'X509IssuerName', text('issuerName'), cert.issuerName);
  eq('SELF_CHECK_CERT', 'X509SerialNumber', text('serialNumber'), cert.serialDecimal);

  // ─── التجزئة ───
  const invoiceHash = computeInvoiceHash(doc);
  eq('SELF_CHECK_HASH', 'DigestValue(invoiceSignedData)', text('invoiceDigest'), invoiceHash);
  eq('SELF_CHECK_HASH', 'invoiceHash', invoiceHash, exp.invoiceHash);

  // ─── التوقيع ───
  const signatureB64 = text('signatureValue');
  eq('SELF_CHECK_SIGNATURE', 'SignatureValue', signatureB64, exp.signatureB64);
  assertEcdsaDer(signatureB64, 'SELF_CHECK_SIGNATURE');
  if (!verifySha256(Buffer.from(invoiceHash, 'base64'), signatureB64, cert.publicKeyPem)) {
    throw new StampError('SELF_CHECK_SIGNATURE', 'التوقيع لا يتحقق بمفتاح الشهادة فوق بايتات التجزئة');
  }

  // ─── SignedProperties ───
  const signingTime = text('signingTime');
  if (!isValidSigningTime(signingTime)) throw new StampError('SELF_CHECK_SIGNED_PROPERTIES', `SigningTime ليس تاريخاً صالحاً «${signingTime}»`);
  eq('SELF_CHECK_SIGNED_PROPERTIES', 'SigningTime', signingTime, exp.signingTime);
  const signedAt = riyadhToDate(signingTime).getTime();
  if (!(signedAt >= reparsed.notBefore.getTime() && signedAt <= reparsed.notAfter.getTime())) {
    throw new StampError('CERT_NOT_VALID', `الشهادة لم تكن سارية وقت التوقيع ${signingTime}`);
  }
  const spFromTemplate = signedPropertiesDigest(signingTime, cd, cert.issuerName, cert.serialDecimal);
  const spEmbedded = signedPropertiesDigestOf(embeddedSignedPropertiesString(doc, s));
  eq('SELF_CHECK_SIGNED_PROPERTIES', 'SignedProperties (المضمَّنة مقابل القالب)', spEmbedded, spFromTemplate);
  eq('SELF_CHECK_SIGNED_PROPERTIES', 'DigestValue(xadesSignedProperties)', text('signedPropertiesDigest'), spFromTemplate);
  eq('SELF_CHECK_SIGNED_PROPERTIES', 'signedPropertiesDigest', spFromTemplate, exp.signedPropertiesDigest);

  // ─── QR ─── (النصّ الخام حرفياً: لا قصّ لأي فراغ — القارئ يفكّ ما هو مكتوب بالضبط)
  const qr = directText(l.qrSlot);
  if (qr === '') throw new StampError('SELF_CHECK_QR', 'QR مفقود');
  if (qr.length > MAX_QR_DECODE_LENGTH) throw new StampError('SELF_CHECK_QR', `نصّ QR أطول من ${MAX_QR_DECODE_LENGTH} محرفاً`);
  eq('SELF_CHECK_QR', 'QR', qr, exp.qr);
  const src = readQrSourceFromXml(doc);
  let d: ReturnType<typeof decodeQr>;
  try {
    d = decodeQr(qr);
  } catch (e) {
    throw new StampError('SELF_CHECK_QR', `QR غير قابل للفكّ حرفياً: ${(e as Error).message}`, { cause: e });
  }
  eq('SELF_CHECK_QR', 'وسم 1', d.sellerName, src.sellerName);
  eq('SELF_CHECK_QR', 'وسم 2', d.vat, src.vat);
  eq('SELF_CHECK_QR', 'وسم 3', d.timestamp, src.timestamp);
  eq('SELF_CHECK_QR', 'وسم 4', d.totalWithVat, src.totalWithVat);
  eq('SELF_CHECK_QR', 'وسم 5', d.vatTotal, src.vatTotal);
  if (d.invoiceHash === undefined) throw new StampError('SELF_CHECK_QR', 'QR بلا وسوم المرحلة الثانية');
  eq('SELF_CHECK_QR', 'وسم 6', d.invoiceHash, invoiceHash);
  eq('SELF_CHECK_QR', 'وسم 7', d.signatureB64, signatureB64);
  if (!bytesEqual(d.spkiDer, cert.spkiDer)) throw new StampError('SELF_CHECK_QR', 'وسم 8 لا يطابق مفتاح الشهادة');
  if (kind === 'simplified') {
    if (!bytesEqual(d.certSignatureDer, cert.certSignatureDer)) throw new StampError('SELF_CHECK_QR', 'وسم 9 مفقود أو لا يطابق توقيع الشهادة');
  } else if (d.certSignatureDer !== undefined) {
    throw new StampError('SELF_CHECK_QR', 'وسم 9 لا يُكتب في المستند القياسي');
  }
  const rebuilt = buildPhase2Qr({
    sellerName: d.sellerName, vat: d.vat, timestamp: d.timestamp, totalWithVat: d.totalWithVat, vatTotal: d.vatTotal,
    invoiceHash: d.invoiceHash, signatureB64: d.signatureB64!, spkiDer: d.spkiDer!, certSignatureDer: d.certSignatureDer,
  }, Number.MAX_SAFE_INTEGER);
  eq('SELF_CHECK_QR', 'QR round-trip', rebuilt, qr);

  return { invoiceHash, signatureB64, qr, signingTime, certDigest: cd, signedPropertiesDigest: spFromTemplate };
}

/**
 * الختم على مستوى الـXML (بلا نموذج). الخطوات 1–8؛ القيم 1–5 للـQR تُقرأ من الـXML نفسه وتُطابَق
 * مع opts.expected إن مُرِّرت.
 */
export async function stampXml(
  unsignedXml: string, signer: HashSigner, cert: CsidCert, now: Date, kind: StampKind, opts: StampOptions = {},
): Promise<StampResult> {
  try {
    return await stampXmlUnsafe(unsignedXml, signer, cert, now, kind, opts);
  } catch (e) {
    throw toStampError(e);
  }
}

async function stampXmlUnsafe(
  unsignedXml: string, signer: HashSigner, cert: CsidCert, now: Date, kind: StampKind, opts: StampOptions,
): Promise<StampResult> {
  if (typeof unsignedXml !== 'string') throw new StampError('INPUT', 'المستند يجب أن يكون نصاً');
  if (!cert || typeof cert !== 'object' || typeof cert.certB64 !== 'string') throw new StampError('INPUT', 'الشهادة مفقودة');
  const qrMaxLength = opts.qrMaxLength ?? QR_MAX_BASE64_LENGTH;
  if (typeof qrMaxLength !== 'number' || !Number.isSafeInteger(qrMaxLength) || qrMaxLength < 1) {
    throw new StampError('INPUT', `سقف طول QR غير صالح: ${String(opts.qrMaxLength)}`);
  }
  if (!signer || typeof signer.signHash !== 'function') throw new StampError('INPUT', 'موقِّع غير صالح');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new StampError('INPUT', 'وقت الختم غير صالح');
  // الخطوات 1–7 في دالة مستقلّة: شجرة المستند غير المختوم لا تبقى حيّة أثناء تحليل المختوم (ذروة ذاكرة شجرة واحدة)
  const p = await prepareStamp(unsignedXml, signer, cert, now, kind, opts, qrMaxLength);
  // 8
  const stamped = parseXml(p.xml, STAMP_XML_LIMITS);
  const verified = verifyStampedXml(stamped, cert, kind, {
    invoiceHash: p.invoiceHash, signatureB64: p.signatureB64, qr: p.qr, signingTime: p.signingTime, signedPropertiesDigest: p.spDigest,
  });
  if (unstampedForm(stamped) !== unsignedXml) throw new StampError('SELF_CHECK_LAYOUT', 'تغيّر بايت خارج خانات الختم');
  return { xml: p.xml, ...verified };
}

/** قيم QR 1–5 المقروءة من الـXML يجب أن تكون صالحة قبل التوقيع؛ خطؤها خطأ بيانات يسمّي الحقل لا عطل داخلي. */
function assertQrSourceValues(src: QrXmlSource): void {
  const bad = (field: string, msg: string): never => { throw new StampError('INPUT', msg, { field }); };
  const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
  if (src.sellerName.trim() === '') bad('supplier.registrationName', 'الاسم القانوني للمنشأة مفقود أو فارغ في المستند');
  if (src.vat.trim() === '') bad('supplier.vatNumber', 'الرقم الضريبي للمنشأة مفقود أو فارغ في المستند');
  if (bytes(src.vat) > TLV_MAX_VALUE_BYTES) bad('supplier.vatNumber', `الرقم الضريبي أطول من ${TLV_MAX_VALUE_BYTES} بايت`);
  // نصّا العنصرين منفصلين (الختم المجمَّع بـT غامض إن احتوى أحدهما T: «10:15:30T00» كان يمرّ ثم يفشل QR داخلياً)
  const date = src.issueDate ?? src.timestamp.split('T')[0];
  const time = src.issueTime ?? src.timestamp.split('T').slice(1).join('T');
  if (!isIsoDate(date)) bad('issueDate', `تاريخ الإصدار «${String(date).slice(0, 40)}» ليس تاريخاً صالحاً بصيغة YYYY-MM-DD`);
  if (!isIsoTime(time)) bad('issueTime', `وقت الإصدار «${String(time).slice(0, 40)}» ليس بصيغة HH:mm:ss`);
  // حارس أخير: ما يقبله هذا الفحص يقبله بناء QR حرفياً
  if (!isValidSigningTime(src.timestamp)) bad('issueTime', `الختم الزمني «${String(src.timestamp).slice(0, 40)}» ليس بصيغة YYYY-MM-DDTHH:mm:ss`);
  if (!/^\d+(\.\d+)?$/.test(src.totalWithVat)) bad('totals.payable', `المبلغ المستحق «${src.totalWithVat.slice(0, 40)}» مفقود أو ليس عدداً عشرياً غير سالب`);
  if (bytes(src.totalWithVat) > TLV_MAX_VALUE_BYTES) bad('totals.payable', `المبلغ المستحق أطول من ${TLV_MAX_VALUE_BYTES} بايت`);
  if (!/^\d+(\.\d+)?$/.test(src.vatTotal)) bad('totals.taxTotal', `إجمالي الضريبة «${src.vatTotal.slice(0, 40)}» مفقود أو ليس عدداً عشرياً غير سالب`);
  if (bytes(src.vatTotal) > TLV_MAX_VALUE_BYTES) bad('totals.taxTotal', `إجمالي الضريبة أطول من ${TLV_MAX_VALUE_BYTES} بايت`);
}

/** حين يتجاوز الـQR سقفه: الحقل المسؤول فعلاً (الاسم فوق ميزانيته، وإلا الرقم الضريبي غير القياسي، وإلا المبالغ). */
function qrOverflowField(src: QrXmlSource, kind: StampKind, qrMaxLength: number): string {
  const amounts = { totalWithVat: src.totalWithVat, vatTotal: src.vatTotal, simplified: kind === 'simplified' };
  const nameBudget = maxSellerNameBytes(amounts, qrMaxLength);
  const longerAmount = src.totalWithVat.length >= src.vatTotal.length ? 'totals.payable' : 'totals.taxTotal';
  // الحقل الشاذّ أولاً: مبلغ غير واقعي الطول أو رقم ضريبي غير قياسي يضيّق ميزانية الاسم، فلا يُلام الاسم العادي
  if (nameBudget < 0 || src.totalWithVat.length > 20 || src.vatTotal.length > 20) return longerAmount;
  if (Buffer.byteLength(src.vat, 'utf8') > 15) return 'supplier.vatNumber';
  return 'supplier.registrationName';
}

/** أقصى نموّ ممكن للمستند بملء الخانات التسع (لا يُوقَّع مستندٌ يفشل تحليله بعد الملء لتجاوزه الحدّ). */
function fillGrowthBound(cert: CsidCert, qrMaxLength: number): number {
  const esc = (s: string) => Buffer.byteLength(s, 'utf8') * 5; // & < > قد تُهرَّب حتى 5 أضعاف
  return cert.certB64.length + esc(cert.issuerName) + cert.serialDecimal.length + 44 + 88 + 96 + 88 + 19 + qrMaxLength + 64;
}

async function prepareStamp(
  unsignedXml: string, signer: HashSigner, cert: CsidCert, now: Date, kind: StampKind, opts: StampOptions, qrMaxLength: number,
): Promise<{ xml: string; invoiceHash: string; signatureB64: string; qr: string; signingTime: string; spDigest: string }> {
  const doc = parseXml(unsignedXml, STAMP_XML_LIMITS);
  assertKind(doc, kind);
  const l = layoutOf(doc);
  for (const e of allSlots(l)) {
    if (e.selfClosing || e.openEnd !== e.closeStart) throw new StampError('SLOT_NOT_EMPTY', `الخانة <${e.qname}> ليست فارغة — المستند مختوم مسبقاً أو ليس قالب Z1`);
  }

  // ─── المفتاح والشهادة ─── (كل قرار يُبنى على الشهادة المُعاد تحليلها لا على حقول الكائن الممرَّر)
  const reparsed = parseCsidCertificate(cert.certB64);
  assertCertObjectMatches(reparsed, cert, 'CERT_KEY_MISMATCH');
  let pemSpki: Buffer;
  try {
    pemSpki = crypto.createPublicKey(cert.publicKeyPem).export({ type: 'spki', format: 'der' });
  } catch (e) {
    throw new StampError('CERT_KEY_MISMATCH', `publicKeyPem غير صالح: ${(e as Error).message}`, { cause: e });
  }
  if (!bytesEqual(pemSpki, reparsed.spkiDer)) {
    throw new StampError('CERT_KEY_MISMATCH', 'publicKeyPem في CsidCert لا يطابق spkiDer');
  }
  if (signer.publicKeySpkiDer !== undefined && !bytesEqual(signer.publicKeySpkiDer, reparsed.spkiDer)) {
    throw new StampError('CERT_KEY_MISMATCH', 'مفتاح الموقِّع لا يطابق المفتاح العام في الشهادة');
  }
  if (now.getTime() < reparsed.notBefore.getTime() || now.getTime() > reparsed.notAfter.getTime()) {
    throw new StampError('CERT_NOT_VALID', `الشهادة غير سارية وقت الختم (${reparsed.notBefore.toISOString()} – ${reparsed.notAfter.toISOString()})`);
  }

  // ─── قيم QR من الـXML ومطابقتها بالنموذج ───
  const src = readQrSourceFromXml(doc, { lenient: true });
  assertQrSourceValues(src);
  if (Buffer.byteLength(unsignedXml, 'utf8') + fillGrowthBound(cert, qrMaxLength) > STAMP_XML_LIMITS.maxBytes) {
    throw new StampError('INPUT', `المستند قريب من حدّ الحجم (${STAMP_XML_LIMITS.maxBytes} بايت) ولن يُقبل بعد ملء خانات الختم`, { field: 'lines' });
  }
  // 3–5 قبل الموقِّع: كل مدخلاتها من الشهادة والساعة، فخللها خلل إعداد يظهر قبل أي استدعاء لـKMS
  const cd = computeCertDigest(cert.certB64);
  const signingTime = riyadhDateTime(now);
  let spDigest: string;
  try {
    spDigest = signedPropertiesDigest(signingTime, cd, cert.issuerName, cert.serialDecimal);
  } catch (e) {
    throw new StampError('CERT_INVALID', `تعذّر بناء SignedProperties من الشهادة: ${(e as Error)?.message ?? String(e)}`, { cause: e });
  }
  if (opts.expected) {
    for (const k of ['sellerName', 'vat', 'timestamp', 'totalWithVat', 'vatTotal'] as const) {
      if (opts.expected[k] !== src[k]) throw new StampError('DOC_MISMATCH', `${k}: النموذج «${opts.expected[k]}» ≠ الـXML «${src[k]}»`);
    }
  }

  // 1
  const invoiceHash = computeInvoiceHash(doc);
  const hashBytes = Buffer.from(invoiceHash, 'base64');
  // 2
  let signatureB64: string;
  try {
    signatureB64 = await signer.signHash(Uint8Array.from(hashBytes));
  } catch (e) {
    if (e instanceof StampError) throw e;
    throw new StampError('SIGNER', `فشل التوقيع: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  assertEcdsaDer(signatureB64, 'SIGNER');
  // 6
  let qr: string;
  try {
    qr = buildPhase2Qr({
      sellerName: src.sellerName, vat: src.vat, timestamp: src.timestamp, totalWithVat: src.totalWithVat, vatTotal: src.vatTotal,
      invoiceHash, signatureB64, spkiDer: cert.spkiDer, certSignatureDer: kind === 'simplified' ? cert.certSignatureDer : undefined,
    }, qrMaxLength);
  } catch (e) {
    if (e instanceof QrError && e.code === 'QR_TOO_LONG') throw new StampError('QR_TOO_LONG', e.message, { field: qrOverflowField(src, kind, qrMaxLength), cause: e });
    throw e;
  }
  // 7
  const s = l.slots;
  const xml = fillEmptyElements(doc, [
    { element: s.invoiceDigest, text: invoiceHash },
    { element: s.signedPropertiesDigest, text: spDigest },
    { element: s.signatureValue, text: signatureB64 },
    { element: s.certificate, text: cert.certB64 },
    { element: s.signingTime, text: signingTime },
    { element: s.certDigest, text: cd },
    { element: s.issuerName, text: cert.issuerName },
    { element: s.serialNumber, text: cert.serialDecimal },
    { element: l.qrSlot, text: qr },
  ]);
  return { xml, invoiceHash, signatureB64, qr, signingTime, spDigest };
}

/** design §3 Z2: stampDocument — يطابق الـXML مع النموذج (المعرّف، UUID، ICV، PIH، النوع، قيم QR) ثم يختم. */
export async function stampDocument(
  unsignedXml: string, doc: UblDocument, signer: HashSigner, cert: CsidCert, now: Date, kind: StampKind, opts: Omit<StampOptions, 'expected'> = {},
): Promise<StampResult> {
  try {
    return await stampDocumentUnsafe(unsignedXml, doc, signer, cert, now, kind, opts);
  } catch (e) {
    throw toStampError(e);
  }
}

async function stampDocumentUnsafe(
  unsignedXml: string, doc: UblDocument, signer: HashSigner, cert: CsidCert, now: Date, kind: StampKind, opts: Omit<StampOptions, 'expected'>,
): Promise<StampResult> {
  if (typeof unsignedXml !== 'string') throw new StampError('INPUT', 'المستند يجب أن يكون نصاً');
  if (!doc || typeof doc !== 'object' || typeof doc.typeName !== 'string') throw new StampError('INPUT', 'نموذج المستند مفقود');
  // في دالتين منفصلتين لا تُعيدان شيئاً: شجرة المطابقة ونصّ التسلسل المتوقَّع يتحرّران قبل الختم، فلا تعيش
  // شجرتان معاً وقت التوقيع (كان ذلك يضاعف ذروة الذاكرة على فاتورة بآلاف البنود)
  assertModelFieldsMatchXml(unsignedXml, doc);
  assertModelSerializationMatches(unsignedXml, doc);
  const expectedKind: StampKind = doc.typeName.slice(0, 2) === '01' ? 'standard' : 'simplified';
  if (expectedKind !== kind) throw new StampError('KIND_MISMATCH', `النوع ${kind} لا يطابق نموذج المستند (${doc.typeName})`);
  return stampXml(unsignedXml, signer, cert, now, kind, {
    ...opts,
    expected: {
      sellerName: doc.supplier.registrationName ?? '',
      vat: doc.supplier.vatNumber ?? '',
      timestamp: `${doc.issueDate}T${doc.issueTime}`,
      totalWithVat: doc.totals.payable,
      vatTotal: doc.totals.taxTotal,
    },
  });
}

/** المعرّفات والسلسلة والنوع ومراجع الفوترة: تسمية الحقل المختلف في الحالات الشائعة. */
function assertModelFieldsMatchXml(unsignedXml: string, doc: UblDocument): void {
  const parsed = parseXml(unsignedXml, STAMP_XML_LIMITS);
  const root = parsed.root;
  const cbc = (local: string) => {
    const el = childElements(root, UBL_NS.CBC, local)[0];
    return el ? directText(el) : undefined;
  };
  const adr = (id: string) => childElements(root, UBL_NS.CAC, 'AdditionalDocumentReference')
    .find(r => childElements(r, UBL_NS.CBC, 'ID').some(i => directText(i) === id));
  const icv = adr('ICV');
  const pih = adr('PIH');
  const icvText = icv ? childElements(icv, UBL_NS.CBC, 'UUID').map(directText)[0] : undefined;
  const pihText = pih ? childElements(pih, UBL_NS.CAC, 'Attachment').flatMap(a => childElements(a, UBL_NS.CBC, 'EmbeddedDocumentBinaryObject')).map(directText)[0] : undefined;
  const checks: Array<[string, string | undefined, string]> = [
    ['cbc:ID', cbc('ID'), doc.id],
    ['cbc:UUID', cbc('UUID'), doc.uuid],
    ['ICV', icvText, String(doc.icv)],
    ['PIH', pihText, doc.pih],
    ['InvoiceTypeCode/@name', (() => { const tc = childElements(root, UBL_NS.CBC, 'InvoiceTypeCode')[0]; return tc ? attr(tc, 'name') : undefined; })(), doc.typeName],
    // النوع نفسه (388/381/383): بلا هذا يُختم نموذج إشعار دائن على XML فاتورة بنفس المعرّفات، فيُقيَّد في السجلّ شيءٌ والمختوم غيره
    ['InvoiceTypeCode', cbc('InvoiceTypeCode'), doc.typeCode],
  ];
  for (const [what, got, want] of checks) {
    if (got !== want) throw new StampError('DOC_MISMATCH', `${what}: الـXML «${got}» ≠ النموذج «${want}»`);
  }
  // BillingReference (BT-25): نفس القيم بنفس الترتيب والعدد — بقاعدة المُسلسِل نفسها (المرجع الفارغ لا يُكتب)
  const xmlRefs = childElements(root, UBL_NS.CAC, 'BillingReference')
    .map(b => childElements(b, UBL_NS.CAC, 'InvoiceDocumentReference').flatMap(r => childElements(r, UBL_NS.CBC, 'ID')).map(directText));
  const modelRefs = (doc.billingReferences ?? []).filter(r => typeof r === 'string' && sanitizeText(r).trim() !== '');
  if (xmlRefs.some(r => r.length !== 1) || xmlRefs.length !== modelRefs.length || xmlRefs.some((r, i) => r[0] !== modelRefs[i])) {
    throw new StampError('DOC_MISMATCH', `BillingReference: الـXML [${xmlRefs.map(r => r.join('+')).join(', ')}] ≠ النموذج [${modelRefs.join(', ')}]`);
  }
}

/** المستند كاملاً: ما يُختم هو بالضبط تسلسل النموذج (سبب الإشعار، العميل، البنود، تاريخ التوريد…). */
function assertModelSerializationMatches(unsignedXml: string, doc: UblDocument): void {
  let expectedXml: string;
  try {
    expectedXml = serializeUnsigned(doc);
  } catch (e) {
    throw new StampError('DOC_MISMATCH', `تعذّر تسلسل النموذج للمطابقة: ${(e as Error).message}`, { cause: e });
  }
  const actualXml = unsignedXml.replace(/\r\n?/g, '\n');
  if (expectedXml !== actualXml) {
    const a = expectedXml.split('\n'), b = actualXml.split('\n');
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    throw new StampError('DOC_MISMATCH', `الـXML لا يطابق تسلسل النموذج عند السطر ${i + 1}: الـXML «${(b[i] ?? '∅').trim().slice(0, 120)}» ≠ النموذج «${(a[i] ?? '∅').trim().slice(0, 120)}»`);
  }
}
