// شهادات اختبار Z2 مبنيّة داخل الاختبار بـ der.ts + node:crypto (لا ملفات، لا شبكة، لا حزمة SDK).
// «CA» تجريبية تصدر شهادة EGS على secp256k1 بتوقيع ecdsa-with-SHA256 — بنية شهادة CSID نفسها،
// فيُختبر بها المسار الملتزَم كاملاً (cert/xades/qr/stamp) دون أي بيانات من الهيئة.
import crypto from 'crypto';
import {
  encBitString, encBoolean, encContext, encIa5String, encInteger, encOctetString, encOid, encPrintableString, encSequence, encSet,
  encUtcTime, encUtf8String,
} from '../der';
import { OID } from '../cert';

export type RdnSpec = Array<[oid: string, value: string, type: 'printable' | 'utf8' | 'ia5']>;

export const DC = '0.9.2342.19200300.100.1.25';
export const CN = '2.5.4.3';

/** ترتيب DER (من الجذر): DC=local, DC=gov, DC=extgazt, CN=… ⇒ معكوساً "CN=…, DC=extgazt, DC=gov, DC=local". */
export const TEST_ISSUER: RdnSpec = [[DC, 'local', 'ia5'], [DC, 'gov', 'ia5'], [DC, 'extgazt', 'ia5'], [CN, 'TSTZATCA-TEST-CA', 'printable']];
export const TEST_ISSUER_NAME = 'CN=TSTZATCA-TEST-CA, DC=extgazt, DC=gov, DC=local';

export function encName(rdns: RdnSpec): Uint8Array {
  return encSequence(rdns.map(([oid, value, type]) => encSet([
    encSequence([encOid(oid), type === 'printable' ? encPrintableString(value) : type === 'ia5' ? encIa5String(value) : encUtf8String(value)]),
  ])));
}

export interface TestCertOptions {
  subjectKey?: crypto.KeyObject;   // مفتاح EGS العام يُؤخذ منه (خاص أو عام)
  caKey?: crypto.KeyObject;        // مفتاح «CA» الخاص للتوقيع (افتراضياً جديد)
  serial?: bigint;
  notBefore?: Date;
  notAfter?: Date;
  issuer?: RdnSpec;
  issuerDer?: Uint8Array;          // اسم مُصدِر جاهز بصيغة DER (يتقدّم على issuer)
  subject?: RdnSpec;
  version?: 2 | 0;                 // 2 = v3 (الافتراضي)
  signatureOid?: string;
}

export interface TestCert {
  certB64: string;
  der: Buffer;
  tbs: Uint8Array;
  signatureDer: Buffer;
  egsPrivateKey: crypto.KeyObject;
  egsPublicKey: crypto.KeyObject;
  caPrivateKey: crypto.KeyObject;
  caPublicKey: crypto.KeyObject;
  serial: bigint;
  notBefore: Date;
  notAfter: Date;
}

export function newSecp256k1(): { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject } {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
}

export function buildTestCert(o: TestCertOptions = {}): TestCert {
  const egs = o.subjectKey
    ? { privateKey: o.subjectKey.type === 'private' ? o.subjectKey : (null as unknown as crypto.KeyObject), publicKey: crypto.createPublicKey(o.subjectKey) }
    : newSecp256k1();
  const caPrivateKey = o.caKey ?? newSecp256k1().privateKey;
  const caPublicKey = crypto.createPublicKey(caPrivateKey);
  const serial = o.serial ?? BigInt('379112742831380471835263969587287663520528387') + BigInt(1);
  const notBefore = o.notBefore ?? new Date('2026-01-01T00:00:00Z');
  const notAfter = o.notAfter ?? new Date('2031-01-01T00:00:00Z');
  const sigAlg = encSequence([encOid(o.signatureOid ?? OID.ECDSA_WITH_SHA256)]);
  const spki = egs.publicKey.export({ type: 'spki', format: 'der' });
  const extensions = encContext(3, encSequence([
    // keyUsage (critical): digitalSignature
    encSequence([encOid('2.5.29.15'), encBoolean(true), encOctetString(encBitString(Uint8Array.from([0x80]), 7))]),
  ]));
  const tbsParts = [
    ...(o.version === 0 ? [] : [encContext(0, encInteger(o.version ?? 2))]),
    encInteger(serial),
    sigAlg,
    o.issuerDer ?? encName(o.issuer ?? TEST_ISSUER),
    encSequence([encUtcTime(notBefore), encUtcTime(notAfter)]),
    encName(o.subject ?? [[CN, 'EGS-UNIT-TEST-1', 'utf8']]),
    spki,
    ...(o.version === 0 ? [] : [extensions]),
  ];
  const tbs = encSequence(tbsParts);
  const signatureDer = crypto.sign('sha256', tbs, caPrivateKey);
  const der = Buffer.from(encSequence([tbs, sigAlg, encBitString(signatureDer)]));
  return {
    certB64: der.toString('base64'), der, tbs, signatureDer, egsPrivateKey: egs.privateKey, egsPublicKey: egs.publicKey,
    caPrivateKey, caPublicKey, serial, notBefore, notAfter,
  };
}
