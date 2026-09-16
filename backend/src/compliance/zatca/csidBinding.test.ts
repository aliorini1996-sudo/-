// اختبارات Z4 لربط شهادة CSID بالوحدة: قراءة UID وSN من subjectAltName في عيّنتي Swagger الرسميتين، ومطابقة المفتاح العام
// والرقم الضريبي على شهادات مبنيّة داخل الاختبار (z2-testcert بلا SAN، وz4-csidcert بـSAN)، والخلل البنيوي خطأ مصنَّف.
import './__fixtures__/z3-netguard';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { CsidCertError, parseCsidCertificate, parseCsidToken } from './cert';
import { csidBindingIssue, readCsidBinding } from './csidBinding';
import { buildTestCert, newSecp256k1 } from './__fixtures__/z2-testcert';
import { buildCsidCert } from './__fixtures__/z4-csidcert';
import { z3Body } from './__fixtures__/z3-fixtures';

const VAT = '399999999900003';
const validity = { notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2031-01-01T00:00:00Z') };
const spkiOf = (k: crypto.KeyObject) => (k.type === 'public' ? k : crypto.createPublicKey(k)).export({ type: 'spki', format: 'der' });

test('عيّنتا Swagger الرسميتان (CCSID وPCSID): UID والرقم التسلسلي في SAN وCN في subject', () => {
  for (const name of ['compliance-200', 'production-csid-200']) {
    const cert = parseCsidToken(z3Body<{ binarySecurityToken: string }>(name).binarySecurityToken);
    const b = readCsidBinding(cert);
    assert.deepEqual(b.sanVatNumbers, [VAT], name);
    assert.deepEqual(b.sanSerialNumbers, ['1-TST|2-TST|3-ed22f1d8-e6a2-1118-9b58-d9a8f11e445f'], name);
    assert.equal(b.subjectCommonName, 'TST-886431145-399999999900003', name);
    assert.ok(Buffer.from(b.spkiDer).equals(Buffer.from(cert.spkiDer)));
    // المفتاح نفسه والرقم نفسه ⇒ لا مخالفة؛ مفتاح وحدة أخرى ⇒ PUBLIC_KEY قبل أي فحص للرقم
    assert.equal(csidBindingIssue(cert, { spkiDer: cert.spkiDer, vatNumber: VAT }), null);
    assert.equal(csidBindingIssue(cert, { spkiDer: spkiOf(newSecp256k1().publicKey), vatNumber: VAT }), 'PUBLIC_KEY');
    assert.equal(csidBindingIssue(cert, { spkiDer: cert.spkiDer, vatNumber: '399999999800003' }), 'VAT');
  }
});

test('شهادات مبنيّة: مطابقة، رقم آخر، UID مزدوج (ولو أحدهما صحيح)، SAN بلا UID، بلا SAN (z2-testcert)', () => {
  const key = newSecp256k1();
  const spki = spkiOf(key.publicKey);
  const make = (vatNumbers: string[] | null) => parseCsidCertificate(buildCsidCert({ subjectKey: key.publicKey, vatNumbers, ...validity }).certB64);
  assert.equal(csidBindingIssue(make([VAT]), { spkiDer: spki, vatNumber: VAT }), null);
  assert.equal(csidBindingIssue(make(['399999999800003']), { spkiDer: spki, vatNumber: VAT }), 'VAT');
  assert.equal(csidBindingIssue(make([VAT, '399999999800003']), { spkiDer: spki, vatNumber: VAT }), 'VAT');
  assert.equal(csidBindingIssue(make([]), { spkiDer: spki, vatNumber: VAT }), 'VAT_MISSING');
  assert.equal(csidBindingIssue(make(null), { spkiDer: spki, vatNumber: VAT }), 'VAT_MISSING');
  const plain = parseCsidCertificate(buildTestCert({ subjectKey: key.privateKey }).certB64);
  assert.deepEqual(readCsidBinding(plain).sanVatNumbers, []);
  assert.equal(csidBindingIssue(plain, { spkiDer: spki, vatNumber: VAT }), 'VAT_MISSING');
  assert.equal(readCsidBinding(plain).subjectCommonName, 'EGS-UNIT-TEST-1');
  // المفتاح المتوقَّع ليس بايتات ⇒ PUBLIC_KEY (لا رمي)
  assert.equal(csidBindingIssue(make([VAT]), { spkiDer: 'x' as unknown as Uint8Array, vatNumber: VAT }), 'PUBLIC_KEY');
});

test('خلل بنيوي ⇒ CsidCertError (CERT_INVALID) فقط', () => {
  const key = newSecp256k1();
  const good = parseCsidCertificate(buildCsidCert({ subjectKey: key.publicKey, vatNumbers: [VAT], ...validity }).certB64);
  assert.throws(() => readCsidBinding({ ...good, certB64: Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01]).toString('base64') }), (e: unknown) => e instanceof CsidCertError && e.code === 'CERT_INVALID');
  assert.throws(() => readCsidBinding(null as never), CsidCertError);
});
