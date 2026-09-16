// اختبارات Z2 لقراءة شهادة CSID: شهادة مبنيّة داخل الاختبار (ملتزَم) + قيم الشهادة الرسمية (ذهبي، يتخطّى عند الغياب).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { CsidCertError, isCanonicalBase64, parseCsidCertificate, parseCsidToken } from './cert';
import { DerError, encIa5String, encOid, encSequence, encSet, encUtf8String } from './der';
import { certDigest } from './xades';
import { decodeQr } from './qr';
import { CN, DC, TEST_ISSUER_NAME, buildTestCert } from './__fixtures__/z2-testcert';
import { RAW, SDK_SKIP, rawText, sdkCertB64, sdkPrivateKeyB64, sdkSamples } from './__fixtures__/z2-sdk';

const certErr = (fn: () => unknown, re?: RegExp) => assert.throws(fn, (e: unknown) => {
  assert.ok(e instanceof CsidCertError || e instanceof DerError, String(e));
  if (re) assert.match((e as Error).message, re);
  return true;
});

test('شهادة مبنيّة بـ der.ts: OpenSSL يقبلها ويتحقق من توقيعها، وparseCsidCertificate يعيد كل الحقول', () => {
  const t = buildTestCert({ serial: BigInt('0x80112233445566778899aabbccddeeff0011'), notBefore: new Date('2026-09-01T10:00:00Z'), notAfter: new Date('2027-09-01T10:00:00Z') });
  const x509 = new crypto.X509Certificate(t.der);
  assert.equal(x509.verify(t.caPublicKey), true, 'توقيع «CA» صحيح ⇒ كاتب DER سليم');
  assert.equal(x509.verify(t.egsPublicKey), false);

  const c = parseCsidCertificate(t.certB64);
  assert.equal(c.certB64, t.certB64);
  assert.equal(c.issuerName, TEST_ISSUER_NAME);
  assert.equal(c.serialDecimal, BigInt('0x80112233445566778899aabbccddeeff0011').toString(10), 'البت الأعلى ⇒ 00 بادئ ويبقى موجباً');
  assert.deepEqual(Buffer.from(c.spkiDer), t.egsPublicKey.export({ type: 'spki', format: 'der' }));
  assert.equal(c.spkiDer.length, 88);
  assert.deepEqual(Buffer.from(c.certSignatureDer), t.signatureDer);
  assert.ok(c.certSignatureDer.length >= 68 && c.certSignatureDer.length <= 72);
  assert.equal(crypto.verify('sha256', t.tbs, t.caPublicKey, c.certSignatureDer), true, 'الوسم 9 = توقيع TBS بمفتاح المُصدِر');
  assert.equal(c.notBefore.toISOString(), '2026-09-01T10:00:00.000Z');
  assert.equal(c.notAfter.toISOString(), '2027-09-01T10:00:00.000Z');
  assert.equal(c.publicKeyPem, t.egsPublicKey.export({ type: 'spki', format: 'pem' }));

  // C-S9: الرمز = base64 لنصّ base64
  const token = Buffer.from(t.certB64, 'latin1').toString('base64');
  assert.deepEqual(parseCsidToken(token), c);
  certErr(() => parseCsidToken(t.certB64), /CSID/); // نصّ الشهادة نفسه ليس رمزاً صالحاً
});

test('اسم المُصدِر: UTF8String وعكس الترتيب، ورفض RDN متعدّد القيم والقيم ذات المحارف الخاصّة والأنواع غير المعروفة', () => {
  const two = buildTestCert({ issuer: [[DC, 'local', 'ia5'], [CN, 'CA One', 'utf8']] });
  assert.equal(parseCsidCertificate(two.certB64).issuerName, 'CN=CA One, DC=local');
  const multiValued = buildTestCert({ issuerDer: encSequence([encSet([encSequence([encOid(CN), encUtf8String('A')]), encSequence([encOid(DC), encIa5String('b')])])]) });
  assert.equal(new crypto.X509Certificate(multiValued.der).verify(multiValued.caPublicKey), true);
  certErr(() => parseCsidCertificate(multiValued.certB64), /عدد قيم 2/);
  certErr(() => parseCsidCertificate(buildTestCert({ issuer: [[CN, 'Evil, CN=Other', 'utf8']] }).certB64), /محارف خاصّة/);
  certErr(() => parseCsidCertificate(buildTestCert({ issuer: [['1.2.3.4', 'x', 'utf8']] }).certB64), /غير مدعوم/);
  certErr(() => parseCsidCertificate(buildTestCert({ issuer: [[CN, ' lead', 'utf8']] }).certB64), /محارف خاصّة/);
});

test('الرفض: base64 غير قانوني (PEM، فراغات، أسطر)، شهادة v1، مفتاح P-256، خوارزمية غير ECDSA-SHA256، وبايتات زائدة', () => {
  const t = buildTestCert();
  const pem = `-----BEGIN CERTIFICATE-----\n${t.certB64.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  certErr(() => parseCsidCertificate(pem), /base64/);
  certErr(() => parseCsidCertificate(` ${t.certB64}`), /base64/);
  certErr(() => parseCsidCertificate(`${t.certB64}\n`), /base64/);
  certErr(() => parseCsidCertificate(t.certB64.match(/.{1,76}/g)!.join('\n')), /base64/);
  assert.equal(isCanonicalBase64(t.certB64), true);
  assert.equal(isCanonicalBase64('QQ'), false);
  assert.equal(isCanonicalBase64('QR=='), false, 'بتات حشو غير صفرية');

  certErr(() => parseCsidCertificate(buildTestCert({ version: 0 }).certB64), /v3/);
  const p256 = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  certErr(() => parseCsidCertificate(buildTestCert({ subjectKey: p256.privateKey }).certB64), /secp256k1/);
  certErr(() => parseCsidCertificate(buildTestCert({ signatureOid: '1.2.840.10045.4.3.3' }).certB64), /ecdsa-with-SHA256/);
  certErr(() => parseCsidCertificate(Buffer.concat([t.der, Buffer.from([0])]).toString('base64')));
  certErr(() => parseCsidCertificate(t.der.subarray(0, t.der.length - 1).toString('base64')));
  // عبث ببايت داخل الاسم: DER يبقى سليماً بنيوياً لكن OpenSSL/المطابقة تكشفه أو يرفضه القارئ
  const tampered = Buffer.from(t.der);
  const i = tampered.indexOf(Buffer.from('extgazt'));
  tampered[i] = 0x80; // ليس ASCII في IA5String
  certErr(() => parseCsidCertificate(tampered.toString('base64')));
});

test('ذهبي (SDK 3.4.8): شهادة الاختبار الرسمية — المُصدِر والرقم التسلسلي وCertDigest والوسمان 8 و9', { skip: SDK_SKIP }, () => {
  const b64 = sdkCertB64();
  const c = parseCsidCertificate(b64);
  assert.equal(c.issuerName, 'CN=PRZEINVOICESCA4-CA, DC=extgazt, DC=gov, DC=local');
  assert.equal(c.serialDecimal, '379112742831380471835263969587287663520528387');
  assert.equal(certDigest(b64), 'ZDMwMmI0MTE1NzVjOTU2NTk4YzVlODhhYmI0ODU2NDUyNTU2YTVhYjhhMDFmN2FjYjk1YTA2OWQ0NjY2MjQ4NQ==');
  assert.equal(c.spkiDer.length, 88);
  assert.equal(c.certSignatureDer.length, 71);
  assert.equal(parseCsidToken(Buffer.from(b64, 'latin1').toString('base64')).serialDecimal, c.serialDecimal);
  // المفتاح الخاص المرفق يطابق الشهادة
  const key = crypto.createPrivateKey({ key: Buffer.from(sdkPrivateKeyB64(), 'base64'), format: 'der', type: 'sec1' });
  assert.deepEqual(crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }), Buffer.from(c.spkiDer));

  const samples = sdkSamples();
  assert.equal(samples.length, 19);
  let simplified = 0;
  for (const s of samples) {
    assert.equal(rawText(s.xml, RAW.certificate), b64, `${s.rel}: الشهادة المضمَّنة = cert.pem`);
    assert.equal(rawText(s.xml, RAW.issuerName), c.issuerName, s.rel);
    assert.equal(rawText(s.xml, RAW.serialNumber), c.serialDecimal, s.rel);
    assert.equal(rawText(s.xml, RAW.certDigest), certDigest(b64), s.rel);
    const qr = decodeQr(rawText(s.xml, RAW.qr));
    assert.deepEqual(Buffer.from(qr.spkiDer!), Buffer.from(c.spkiDer), `${s.rel}: الوسم 8 = SPKI`);
    if (s.kind === 'simplified') {
      simplified++;
      assert.deepEqual(Buffer.from(qr.certSignatureDer!), Buffer.from(c.certSignatureDer), `${s.rel}: الوسم 9 = توقيع الشهادة`);
    } else {
      assert.equal(qr.certSignatureDer, undefined, `${s.rel}: لا وسم 9 في القياسية`);
    }
  }
  assert.equal(simplified, 5);
});
