// شهادات CSID اختبارية لـZ4 مبنيّة داخل الاختبار (لا ملفات، لا شبكة، لا بيانات من الهيئة): بنية z2-testcert.ts نفسها
// (encName وTEST_ISSUER وsecp256k1 وecdsa-with-SHA256) مع امتداد subjectAltName ‹directoryName› يحمل SN وUID (الرقم الضريبي)
// وtitle وregisteredAddress وbusinessCategory — كما في عيّنتي CCSID/PCSID الرسميتين (report §7.2).
import crypto from 'crypto';
import { OID } from '../cert';
import { CSR_OID } from '../csr';
import { encBitString, encBoolean, encContext, encInteger, encOctetString, encOid, encSequence, encUtcTime } from '../der';
import { CN, RdnSpec, TEST_ISSUER, encName, newSecp256k1 } from './z2-testcert';

/** مُصدِر CCSID كما في عيّنة Swagger (CN=eInvoicing). */
export const CCSID_ISSUER: RdnSpec = [[CN, 'eInvoicing', 'printable']];

export interface CsidCertSpec {
  /** مفتاح الوحدة (عام أو خاص) الذي تصدر له الشهادة. */
  subjectKey: crypto.KeyObject;
  /** قيم UID في SAN؛ [] ⇒ SAN بلا UID؛ null ⇒ بلا امتداد SAN إطلاقاً. */
  vatNumbers?: string[] | null;
  serialNumber?: string;
  commonName?: string;
  issuer?: RdnSpec;
  serial?: bigint;
  notBefore: Date;
  notAfter: Date;
}

export interface CsidCertOut {
  certB64: string;
  /** binarySecurityToken = base64(نصّ base64 الشهادة) (C-S9). */
  token: string;
  serial: bigint;
  notBefore: Date;
  notAfter: Date;
}

const rdn = (oid: string, value: string): RdnSpec[number] => [oid, value, 'utf8'];

export function buildCsidCert(spec: CsidCertSpec): CsidCertOut {
  const caKey = newSecp256k1().privateKey;
  const serial = spec.serial ?? BigInt(`0x${crypto.randomBytes(12).toString('hex')}`) + BigInt(1);
  const sigAlg = encSequence([encOid(OID.ECDSA_WITH_SHA256)]);
  const pub = spec.subjectKey.type === 'public' ? spec.subjectKey : crypto.createPublicKey(spec.subjectKey);
  const spki = pub.export({ type: 'spki', format: 'der' });
  const exts: Uint8Array[] = [
    encSequence([encOid('2.5.29.15'), encBoolean(true), encOctetString(encBitString(Uint8Array.from([0x80]), 7))]),
  ];
  if (spec.vatNumbers !== null) {
    const dir: RdnSpec = [rdn(CSR_OID.SERIAL_NUMBER_SN, spec.serialNumber ?? '1-TST|2-TST|3-00000000-0000-4000-8000-000000000000')];
    for (const v of spec.vatNumbers ?? []) dir.push(rdn(CSR_OID.UID, v));
    dir.push(rdn(CSR_OID.TITLE, '1100'), rdn(CSR_OID.REGISTERED_ADDRESS, 'RRRD2929'), rdn(CSR_OID.BUSINESS_CATEGORY, 'Supply activities'));
    exts.push(encSequence([encOid('2.5.29.17'), encOctetString(encSequence([encContext(4, encName(dir))]))]));
  }
  const tbs = encSequence([
    encContext(0, encInteger(2)),
    encInteger(serial),
    sigAlg,
    encName(spec.issuer ?? TEST_ISSUER),
    encSequence([encUtcTime(spec.notBefore), encUtcTime(spec.notAfter)]),
    encName([['2.5.4.6', 'SA', 'printable'], [CN, spec.commonName ?? 'EGS-UNIT-TEST', 'utf8']]),
    spki,
    encContext(3, encSequence(exts)),
  ]);
  const signature = crypto.sign('sha256', tbs, caKey);
  const der = Buffer.from(encSequence([tbs, sigAlg, encBitString(signature)]));
  const certB64 = der.toString('base64');
  return { certB64, token: Buffer.from(certB64, 'latin1').toString('base64'), serial, notBefore: spec.notBefore, notAfter: spec.notAfter };
}
