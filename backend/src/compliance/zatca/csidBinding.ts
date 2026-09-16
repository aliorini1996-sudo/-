// ============================================================================
// ZATCA المرحلة الثانية (Z4) — ربط شهادة CSID بالوحدة: المفتاح العام والرقم الضريبي
// ----------------------------------------------------------------------------
// design §3 Z4: قبل أن تُخزَّن شهادة امتثال (CCSID) أو إنتاج (PCSID) لوحدة، يُتحقَّق أنها صدرت **لهذه الوحدة**:
//   • SubjectPublicKeyInfo في الشهادة = مفتاح الوحدة العام بايتاً بايتاً (وإلا فكل توقيع سيُرفض، أو أسوأ: شهادة غيرنا).
//   • الرقم الضريبي UID (0.9.2342.19200300.100.1.1) في subjectAltName ‹directoryName› = الرقم الضريبي المجمَّد للوحدة
//     — حيث وضعته الهيئة في عيّنتي Swagger (CCSID وPCSID، report §7.2) وحيث وضعناه في CSR (csr.ts).
//     الهيئة ترفض مستنداً رقمه الضريبي غير رقم الشهادة (report §4.2 «VAT must match»).
// نقيّ: يقرأ certB64 الذي تحقّق منه parseCsidCertificate (cert.ts) بـder.ts ولا شيء غيره.
// UNVERIFIED(report §8، S19): شهادات sandbox قد تحمل الرقم الوهمي 399999999900003 أياً كان الطلب — الربط الصارم
// يرفضها عمداً؛ اختبار sandbox اليدوي (G3) يستعمل الرقم الوهمي نفسه في بيانات البائع.
// ============================================================================

import { CsidCert, CsidCertError, MAX_CERT_DER_NODES } from './cert';
import { CSR_OID } from './csr';
import { DerError, DerNode, TAG, childrenOf, decodeOid, decodeString, expectTag, parseDer } from './der';

export interface CsidBinding {
  /** كل قيم UID في directoryName داخل subjectAltName (المتوقَّع قيمة واحدة). */
  sanVatNumbers: string[];
  /** قيم SN (2.5.4.4) في directoryName داخل subjectAltName. */
  sanSerialNumbers: string[];
  /** CN في subject إن وُجد مرة واحدة. */
  subjectCommonName: string | null;
  spkiDer: Uint8Array;
}

const SAN_OID = '2.5.29.17';
const DIRECTORY_NAME_TAG = 0xa4;
const EXTENSIONS_TAG = 0xa3;

/** قيم سمات Name (RDNs) كأزواج OID/نصّ؛ RDN متعدّد القيم يُقرأ كلّه. */
function nameAttributes(name: DerNode, what: string): Array<{ oid: string; value: string }> {
  const out: Array<{ oid: string; value: string }> = [];
  for (const rdn of childrenOf(expectTag(name, TAG.SEQUENCE, what), what)) {
    for (const atv of childrenOf(expectTag(rdn, TAG.SET, `${what} RDN`), `${what} RDN`)) {
      const parts = childrenOf(expectTag(atv, TAG.SEQUENCE, `${what} ATV`), `${what} ATV`);
      if (parts.length !== 2) throw new DerError(`${what}: AttributeTypeAndValue غير صالح`, atv.offset);
      out.push({ oid: decodeOid(parts[0]), value: decodeString(parts[1]) });
    }
  }
  return out;
}

/**
 * يقرأ حقول الربط من شهادة CSID محلَّلة. يرمي CsidCertError (CERT_INVALID) عند خلل بنيوي في subject أو الامتدادات؛
 * غياب subjectAltName لا يرمي (sanVatNumbers فارغة ⇒ csidBindingIssue يعيد VAT_MISSING).
 */
export function readCsidBinding(cert: CsidCert): CsidBinding {
  try {
    if (!cert || typeof cert.certB64 !== 'string' || !(cert.spkiDer instanceof Uint8Array)) throw new CsidCertError('شهادة CSID مفقودة');
    const der = Buffer.from(cert.certB64, 'base64');
    const root = childrenOf(expectTag(parseDer(der, MAX_CERT_DER_NODES), TAG.SEQUENCE, 'Certificate'), 'Certificate');
    const tbs = childrenOf(expectTag(root[0], TAG.SEQUENCE, 'TBSCertificate'), 'TBSCertificate');
    // v3 مؤكَّد في cert.ts: [0] version, serial, sigAlg, issuer, validity, subject, spki, ([1] [2])? [3] extensions
    if (tbs.length < 7 || tbs[0].tag !== 0xa0) throw new CsidCertError('TBSCertificate ناقص');
    const subject = nameAttributes(tbs[5], 'subject');
    const cns = subject.filter(a => a.oid === CSR_OID.COMMON_NAME).map(a => a.value);

    const sanVatNumbers: string[] = [];
    const sanSerialNumbers: string[] = [];
    const extWrapper = tbs.slice(7).find(n => n.tag === EXTENSIONS_TAG);
    if (extWrapper) {
      const exts = childrenOf(expectTag(childrenOf(extWrapper, 'extensions')[0], TAG.SEQUENCE, 'Extensions'), 'Extensions');
      const sans = exts.filter(ext => {
        const parts = childrenOf(expectTag(ext, TAG.SEQUENCE, 'Extension'), 'Extension');
        return decodeOid(parts[0]) === SAN_OID;
      });
      if (sans.length > 1) throw new CsidCertError('امتداد subjectAltName مكرّر');
      if (sans.length === 1) {
        const parts = childrenOf(sans[0], 'Extension');
        const octet = expectTag(parts[parts.length - 1], TAG.OCTET_STRING, 'extnValue');
        const names = childrenOf(expectTag(parseDer(octet.value, 256), TAG.SEQUENCE, 'GeneralNames'), 'GeneralNames');
        for (const gn of names) {
          if (gn.tag !== DIRECTORY_NAME_TAG) continue;
          const inner = childrenOf(gn, 'directoryName');
          if (inner.length !== 1) throw new CsidCertError('directoryName يجب أن يلفّ Name واحداً');
          for (const a of nameAttributes(inner[0], 'subjectAltName')) {
            if (a.oid === CSR_OID.UID) sanVatNumbers.push(a.value);
            if (a.oid === CSR_OID.SERIAL_NUMBER_SN) sanSerialNumbers.push(a.value);
          }
        }
      }
    }
    return { sanVatNumbers, sanSerialNumbers, subjectCommonName: cns.length === 1 ? cns[0] : null, spkiDer: Uint8Array.from(cert.spkiDer) };
  } catch (e) {
    if (e instanceof CsidCertError) throw e;
    throw new CsidCertError(e instanceof DerError ? e.message : 'تعذّرت قراءة حقول ربط الشهادة', { cause: e });
  }
}

export type CsidBindingIssue = 'PUBLIC_KEY' | 'VAT_MISSING' | 'VAT';

export interface CsidBindingExpectation {
  /** SubjectPublicKeyInfo (DER) لمفتاح الوحدة. */
  spkiDer: Uint8Array;
  /** الرقم الضريبي المجمَّد للوحدة. */
  vatNumber: string;
}

/**
 * أول مخالفة ربط أو null: المفتاح العام أولاً، ثم UID واحد بالضبط يساوي رقم الوحدة. قيمتان مختلفتان للـUID ⇒ VAT
 * (شهادة ملتبسة لا تُقبل). يرمي CsidCertError فقط لخلل بنيوي.
 */
export function csidBindingIssue(cert: CsidCert, expected: CsidBindingExpectation): CsidBindingIssue | null {
  const b = readCsidBinding(cert);
  const want = expected.spkiDer;
  if (!(want instanceof Uint8Array) || !Buffer.from(b.spkiDer).equals(Buffer.from(want.buffer, want.byteOffset, want.byteLength))) return 'PUBLIC_KEY';
  if (b.sanVatNumbers.length === 0) return 'VAT_MISSING';
  if (b.sanVatNumbers.some(v => v !== expected.vatNumber)) return 'VAT';
  return null;
}
