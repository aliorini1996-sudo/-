// ============================================================================
// ZATCA المرحلة الثانية (Z2) — قراءة شهادة CSID (X.509) لما يحتاجه الختم وQR
// ----------------------------------------------------------------------------
// • C-S9: binarySecurityToken من واجهة الهيئة = base64 لنصّ base64 الشهادة (DER).
// • C-S4: نصّ base64 هذا بعينه يُكتب في ds:X509Certificate ويُجزَّأ لـCertDigest — لذا نثبّته
//   بصيغة base64 قانونية بسطر واحد (لا PEM ولا فواصل أسطر) ونرفض ما سواها بدل تطبيعه بصمت.
// • C-S5: X509IssuerName = مكوّنات RDN للمُصدِر معكوسة ومفصولة بـ", " (صيغة Java X500Name كما
//   في العيّنة "CN=PRZEINVOICESCA4-CA, DC=extgazt, DC=gov, DC=local")؛ X509SerialNumber عشرياً.
// • C-Q3: وسم QR 8 = SubjectPublicKeyInfo بصيغة DER (88 بايت لـsecp256k1)، ووسم 9 = محتوى
//   BIT STRING لتوقيع الشهادة (توقيع ECDSA بصيغة DER، 70–72 بايت).
// القراءة بـder.ts ثم مطابقة متقاطعة مع X509Certificate في node:crypto (OpenSSL).
// ============================================================================

import crypto from 'crypto';
import {
  DerError, DerNode, TAG, childrenOf, decodeBitString, decodeInteger, decodeOid, decodeString, decodeTime, expectTag, parseDer,
} from './der';
import { clipMessage, isXmlCharCode } from './xml';

/** هل كل نقاط النص محارف XML 1.0 (بلا U+FFFE/U+FFFF ولا بدائل منفردة) وبلا محارف تحكّم C0/C1؟ */
export function isXmlSafeText(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (!isXmlCharCode(cp) || cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return false;
  }
  return true;
}

/** كل أخطاء قراءة الشهادة تحمل code ثابتاً كي يصنّفها Z4 (رمز CSID معيب ⇒ CONFIG) وZ5 دون تحليل نصوص. */
export class CsidCertError extends Error {
  readonly code = 'CERT_INVALID' as const;
  /** الخطأ الأصلي (DerError أو غيره) — lib ES2020 لا يعرّف Error.cause فيُحفظ هنا. */
  readonly cause?: unknown;
  constructor(message: string, options?: { cause?: unknown }) {
    super(clipMessage(`CSID: ${message}`));
    this.name = 'CsidCertError';
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

/**
 * حدود المُدخل قبل أي فكّ: شهادة CSID نحو 1KB (base64 ≈ 1.3KB). بلا حدّ كان رمزٌ ضخم من TLVات صغيرة
 * يُسقط Node بنفاد الذاكرة قبل أن يُرفض بنيوياً.
 */
export const MAX_CERT_B64_LENGTH = 8192;
export const MAX_CERT_DER_NODES = 512;
/** أطول رقم تسلسلي مقبول: RFC 5280 يحدّه بـ20 بايت، ونسمح بهامش. */
const MAX_SERIAL_BYTES = 32;

export interface CsidCert {
  /** نصّ base64 القانوني للشهادة (DER) كما يُكتب في ds:X509Certificate. */
  certB64: string;
  issuerName: string;
  serialDecimal: string;
  spkiDer: Uint8Array;
  certSignatureDer: Uint8Array;
  notBefore: Date;
  notAfter: Date;
  publicKeyPem: string;
}

export const OID = Object.freeze({
  EC_PUBLIC_KEY: '1.2.840.10045.2.1',
  SECP256K1: '1.3.132.0.10',
  ECDSA_WITH_SHA256: '1.2.840.10045.4.3.2',
});

/** الأسماء المختصرة كما يطبعها Java X500Name (RFC 2253/1779). غيرها ⇒ رفض لا تخمين. */
const RDN_SHORT: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.9': 'STREET',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '0.9.2342.19200300.100.1.25': 'DC',
  '0.9.2342.19200300.100.1.1': 'UID',
};

/** base64 قانوني صارم: الترميز العكسي يطابق النص حرفياً. */
export function isCanonicalBase64(s: string): boolean {
  return typeof s === 'string' && s.length > 0 && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s)
    && Buffer.from(s, 'base64').toString('base64') === s;
}

function formatName(name: DerNode): string {
  const rdns = childrenOf(expectTag(name, TAG.SEQUENCE, 'Name'), 'Name');
  const parts = rdns.map(rdn => {
    const atvs = childrenOf(expectTag(rdn, TAG.SET, 'RDN'), 'RDN');
    // RDN متعدّد القيم: فاصل Java (" + ") وترتيبه غير مؤكَّدين لأسماء الهيئة — نرفض بدل التخمين
    if (atvs.length !== 1) throw new CsidCertError(`RDN بعدد قيم ${atvs.length} غير مدعوم في اسم المُصدِر`);
    return atvs.slice(0, 1).map(atv => {
      const [typeNode, valueNode, ...rest] = childrenOf(expectTag(atv, TAG.SEQUENCE, 'AttributeTypeAndValue'));
      if (!typeNode || !valueNode || rest.length) throw new CsidCertError('AttributeTypeAndValue غير صالح');
      const oid = decodeOid(typeNode);
      const short = RDN_SHORT[oid];
      if (!short) throw new CsidCertError(`نوع RDN غير مدعوم في اسم المُصدِر: ${oid}`);
      const value = decodeString(valueNode);
      // تهريب Java للمحارف الخاصّة غير مؤكَّد لأسماء الهيئة: نرفض بدل إنتاج اسم قد لا يطابق.
      // Java AVA.toKeywordValueString يضع القيمة بين علامتي تنصيص أيضاً عند فراغين متتاليين داخلها (CN="A  B")،
      // وOpenSSL لا يفعل فلا تكشفه المطابقة المتقاطعة — فيُرفض صراحةً.
      if (value === '' || /[,+"\\<>;=#\n\r]/.test(value) || /^\s|\s$/.test(value) || /\s\s/.test(value)) {
        throw new CsidCertError(`قيمة RDN بمحارف خاصّة غير مدعومة: «${value}»`);
      }
      // الاسم يُكتب في ds:X509IssuerName: محرف خارج XML 1.0 (U+FFFE مثلاً) كان يمرّ من OpenSSL ثم يُفشل كل ختم كخطأ بيانات
      if (!isXmlSafeText(value)) throw new CsidCertError('قيمة RDN فيها محارف لا تصلح في XML');
      return `${short}=${value}`;
    })[0];
  });
  return parts.reverse().join(', ');
}

/** العنصر رقم i من أبناء عقدة مركّبة، أو CsidCertError إن غاب (لا TypeError من تفكيك undefined). */
function nth(node: DerNode | undefined, i: number, what: string): DerNode {
  if (!node) throw new CsidCertError(`${what}: مفقود`);
  const c = childrenOf(node, what)[i];
  if (!c) throw new CsidCertError(`${what}: العنصر ${i} مفقود`);
  return c;
}

/**
 * يقرأ شهادة CSID من نصّ base64 (DER). يرمي CsidCertError **فقط** (code = CERT_INVALID) عند أي خلل أو
 * عدم تطابق؛ أخطاء DER وأي خطأ غير متوقَّع تُلفّ فيه مع cause.
 */
export function parseCsidCertificate(certB64: string): CsidCert {
  try {
    return parseCsidCertificateUnsafe(certB64);
  } catch (e) {
    if (e instanceof CsidCertError) throw e;
    throw new CsidCertError(e instanceof DerError ? e.message : `شهادة غير صالحة: ${(e as Error)?.message ?? String(e)}`, { cause: e });
  }
}

function parseCsidCertificateUnsafe(certB64: string): CsidCert {
  if (typeof certB64 !== 'string') throw new CsidCertError('نصّ الشهادة ليس نصاً');
  if (certB64.length > MAX_CERT_B64_LENGTH) throw new CsidCertError(`نصّ الشهادة أطول من ${MAX_CERT_B64_LENGTH} محرفاً`);
  if (!isCanonicalBase64(certB64)) throw new CsidCertError('نصّ الشهادة ليس base64 قانونياً بسطر واحد (بلا PEM ولا فراغات)');
  const der = Buffer.from(certB64, 'base64');
  const cert = parseDer(der, MAX_CERT_DER_NODES);
  const [tbs, sigAlg, sigValue, ...extra] = childrenOf(expectTag(cert, TAG.SEQUENCE, 'Certificate'), 'Certificate');
  if (!tbs || !sigAlg || !sigValue || extra.length) throw new CsidCertError('بنية Certificate غير صالحة');
  const t = childrenOf(expectTag(tbs, TAG.SEQUENCE, 'TBSCertificate'), 'TBSCertificate');
  let i = 0;
  if (t[0]?.tag === 0xa0) {
    if (decodeInteger(nth(t[0], 0, 'version')) !== BigInt(2)) throw new CsidCertError('الشهادة ليست X.509 v3');
    i = 1;
  } else {
    throw new CsidCertError('الشهادة ليست X.509 v3');
  }
  const serialNode = t[i++];
  const tbsSigAlg = t[i++];
  const issuerNode = t[i++];
  const validity = t[i++];
  i++; // subject
  const spkiNode = t[i++];
  if (!serialNode || !tbsSigAlg || !issuerNode || !validity || !spkiNode) throw new CsidCertError('TBSCertificate ناقص');

  const serial = decodeInteger(serialNode, MAX_SERIAL_BYTES);
  if (serial <= BigInt(0)) throw new CsidCertError('الرقم التسلسلي يجب أن يكون موجباً');

  const algOid = (n: DerNode) => decodeOid(nth(expectTag(n, TAG.SEQUENCE, 'AlgorithmIdentifier'), 0, 'AlgorithmIdentifier'));
  if (algOid(sigAlg) !== OID.ECDSA_WITH_SHA256 || algOid(tbsSigAlg) !== OID.ECDSA_WITH_SHA256) {
    throw new CsidCertError('خوارزمية توقيع الشهادة ليست ecdsa-with-SHA256');
  }
  if (!Buffer.from(sigAlg.raw).equals(Buffer.from(tbsSigAlg.raw))) throw new CsidCertError('خوارزمية التوقيع في TBS تخالف الخارجية');

  expectTag(validity, TAG.SEQUENCE, 'Validity');
  const notBefore = decodeTime(nth(validity, 0, 'Validity.notBefore'));
  const notAfter = decodeTime(nth(validity, 1, 'Validity.notAfter'));
  if (notAfter.getTime() < notBefore.getTime()) throw new CsidCertError('notAfter قبل notBefore');

  const spkiAlg = expectTag(nth(expectTag(spkiNode, TAG.SEQUENCE, 'SubjectPublicKeyInfo'), 0, 'SubjectPublicKeyInfo'), TAG.SEQUENCE, 'AlgorithmIdentifier');
  const spkiAlgParts = childrenOf(spkiAlg, 'AlgorithmIdentifier');
  if (!spkiAlgParts[0] || decodeOid(spkiAlgParts[0]) !== OID.EC_PUBLIC_KEY || !spkiAlgParts[1] || decodeOid(spkiAlgParts[1]) !== OID.SECP256K1) {
    throw new CsidCertError('المفتاح العام ليس EC على secp256k1');
  }

  const sigBits = decodeBitString(sigValue);
  if (sigBits.unusedBits !== 0) throw new CsidCertError('BIT STRING التوقيع بحشو غير صفري');
  if (sigBits.bytes.length > 80) throw new CsidCertError('توقيع الشهادة أطول من توقيع ECDSA على منحنى 256 بت');
  const ecdsa = parseDer(sigBits.bytes, 8);
  const rs = childrenOf(expectTag(ecdsa, TAG.SEQUENCE, 'ECDSA-Sig-Value'));
  if (rs.length !== 2 || decodeInteger(rs[0], 33) <= BigInt(0) || decodeInteger(rs[1], 33) <= BigInt(0)) throw new CsidCertError('توقيع الشهادة ليس ECDSA-Sig-Value صالحاً');

  const issuerName = formatName(issuerNode);
  const serialDecimal = serial.toString(10);
  const spkiDer = Uint8Array.from(spkiNode.raw);
  const certSignatureDer = Uint8Array.from(sigBits.bytes);

  // ─── مطابقة متقاطعة مع OpenSSL ───
  let x509: crypto.X509Certificate;
  try {
    x509 = new crypto.X509Certificate(der);
  } catch (e) {
    throw new CsidCertError(`OpenSSL رفض الشهادة: ${(e as Error).message}`);
  }
  const nodeIssuer = x509.issuer.split('\n').reverse().join(', ');
  if (nodeIssuer !== issuerName) throw new CsidCertError(`اسم المُصدِر لا يطابق OpenSSL («${issuerName}» ≠ «${nodeIssuer}»)`);
  if (BigInt(`0x${x509.serialNumber}`) !== serial) throw new CsidCertError('الرقم التسلسلي لا يطابق OpenSSL');
  const pub = x509.publicKey;
  if (pub.asymmetricKeyType !== 'ec' || pub.asymmetricKeyDetails?.namedCurve !== 'secp256k1') throw new CsidCertError('OpenSSL: المفتاح ليس secp256k1');
  const nodeSpki = pub.export({ type: 'spki', format: 'der' });
  if (!nodeSpki.equals(Buffer.from(spkiDer))) throw new CsidCertError('SPKI لا يطابق OpenSSL');
  // DER هو المرجع؛ نصّ OpenSSL ("Jan 11 09:19:30 2024 GMT") يُطابَق فقط إن أمكن تحليله
  const openSslTime = (s: string, want: Date, what: string) => {
    const t = Date.parse(s);
    if (Number.isFinite(t) && t !== want.getTime()) throw new CsidCertError(`${what} لا يطابق OpenSSL («${s}»)`);
  };
  openSslTime(x509.validFrom, notBefore, 'notBefore');
  openSslTime(x509.validTo, notAfter, 'notAfter');

  return {
    certB64,
    issuerName,
    serialDecimal,
    spkiDer,
    certSignatureDer,
    notBefore,
    notAfter,
    publicKeyPem: pub.export({ type: 'spki', format: 'pem' }) as string,
  };
}

/** C-S9: binarySecurityToken = base64(نصّ base64 للشهادة). */
export function parseCsidToken(binarySecurityToken: string): CsidCert {
  if (typeof binarySecurityToken !== 'string') throw new CsidCertError('binarySecurityToken ليس نصاً');
  if (binarySecurityToken.length > Math.ceil(MAX_CERT_B64_LENGTH / 3) * 4) throw new CsidCertError('binarySecurityToken أطول من الحدّ');
  if (!isCanonicalBase64(binarySecurityToken)) throw new CsidCertError('binarySecurityToken ليس base64 قانونياً');
  const inner = Buffer.from(binarySecurityToken, 'base64').toString('latin1');
  return parseCsidCertificate(inner);
}
