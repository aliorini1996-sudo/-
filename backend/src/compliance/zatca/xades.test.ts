// اختبارات Z2 لـ XAdES: CertDigest (C-S4) وسلسلة SignedProperties وبصمتها (C-S7) وخانات القالب.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  certDigest, embeddedSignedPropertiesString, locateSignatureSlots, pushDownNamespaces, signedPropertiesDigest,
  signedPropertiesDigestOf, signedPropertiesString,
} from './xades';
import { assertNoForeignSignature } from './c14n';
import { mapInvoiceToUbl } from './mapInvoice';
import { serializeUnsigned } from './ubl';
import { XmlError, childElements, fillEmptyElements, parseXml } from './xml';
import { STANDARD_INVOICE, chainFor } from './__fixtures__/z1-sources';
import { RAW, SDK_SKIP, rawText, sdkCertB64, sdkSamples } from './__fixtures__/z2-sdk';
import { parseCsidCertificate } from './cert';
import { INITIAL_PIH, sha256HexB64 } from './crypto';

const hexB64 = (s: string) => Buffer.from(crypto.createHash('sha256').update(s, 'utf8').digest('hex'), 'utf8').toString('base64');
const sp = (n: number) => ' '.repeat(n);
const DSNS = 'xmlns:ds="http://www.w3.org/2000/09/xmldsig#"';

function expectedSignedProperties(t: string, cd: string, issuer: string, serial: string): string {
  return [
    '<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">',
    `${sp(36)}<xades:SignedSignatureProperties>`,
    `${sp(40)}<xades:SigningTime>${t}</xades:SigningTime>`,
    `${sp(40)}<xades:SigningCertificate>`,
    `${sp(44)}<xades:Cert>`,
    `${sp(48)}<xades:CertDigest>`,
    `${sp(52)}<ds:DigestMethod ${DSNS} Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>`,
    `${sp(52)}<ds:DigestValue ${DSNS}>${cd}</ds:DigestValue>`,
    `${sp(48)}</xades:CertDigest>`,
    `${sp(48)}<xades:IssuerSerial>`,
    `${sp(52)}<ds:X509IssuerName ${DSNS}>${issuer}</ds:X509IssuerName>`,
    `${sp(52)}<ds:X509SerialNumber ${DSNS}>${serial}</ds:X509SerialNumber>`,
    `${sp(48)}</xades:IssuerSerial>`,
    `${sp(44)}</xades:Cert>`,
    `${sp(40)}</xades:SigningCertificate>`,
    `${sp(36)}</xades:SignedSignatureProperties>`,
    `${sp(32)}</xades:SignedProperties>`,
  ].join('\n');
}

const CD = hexB64('MIIBtest');
const ISSUER = 'CN=TSTZATCA-TEST-CA, DC=extgazt, DC=gov, DC=local';
const SERIAL = '379112742831380471835263969587287663520528388';

test('C-S4: certDigest = base64(hex(sha256(نصّ base64))) — لا بايتات DER ولا base64 خام؛ والترميز المزدوج نفسه يشتقّ INITIAL_PIH', () => {
  assert.equal(sha256HexB64('0'), INITIAL_PIH);
  const certText = Buffer.from('not really a certificate').toString('base64');
  assert.equal(certDigest(certText), hexB64(certText));
  assert.notEqual(certDigest(certText), crypto.createHash('sha256').update(Buffer.from(certText, 'base64')).digest('base64'));
  assert.notEqual(certDigest(certText), crypto.createHash('sha256').update(certText).digest('base64'));
  assert.equal(Buffer.from(certDigest(certText), 'base64').toString('utf8').length, 64);
  assert.throws(() => certDigest(`${certText}\n`), XmlError);
});

test('C-S7: السلسلة من قالب ubl.ts حرفياً — xmlns:xades على الجذر، xmlns:ds على كل ds:*، DigestMethod ذاتي الإغلاق، ومسافات 32–52', () => {
  const t = '2026-09-14T10:15:31';
  const s = signedPropertiesString(t, CD, ISSUER, SERIAL);
  assert.equal(s, expectedSignedProperties(t, CD, ISSUER, SERIAL));
  assert.equal(signedPropertiesDigest(t, CD, ISSUER, SERIAL), hexB64(s));
  assert.equal(signedPropertiesDigestOf(s), hexB64(s));
  // حسّاسة لكل بايت: ثانية واحدة أو فراغ واحد يغيّران البصمة
  assert.notEqual(signedPropertiesDigest('2026-09-14T10:15:32', CD, ISSUER, SERIAL), signedPropertiesDigest(t, CD, ISSUER, SERIAL));
  assert.notEqual(hexB64(s.replace('<xades:Cert>', '<xades:Cert> ')), hexB64(s));
  // الاسم بمحرف & يُهرَّب في السلسلة كما في المستند
  assert.ok(signedPropertiesString(t, CD, 'CN=A&B, DC=x', SERIAL).includes('>CN=A&amp;B, DC=x</ds:X509IssuerName>'));
});

test('مصدر حقيقة واحد: الكتلة المضمَّنة في مستند Z1 بعد الملء ودفع النطاقات = signedPropertiesString', () => {
  const xml = serializeUnsigned(mapInvoiceToUbl(STANDARD_INVOICE, chainFor(2)));
  const doc = parseXml(xml);
  const slots = locateSignatureSlots(assertNoForeignSignature(doc).dsSignature);
  const filled = parseXml(fillEmptyElements(doc, [
    { element: slots.signingTime, text: '2026-09-14T10:15:31' },
    { element: slots.certDigest, text: CD },
    { element: slots.issuerName, text: ISSUER },
    { element: slots.serialNumber, text: SERIAL },
  ]));
  const filledSlots = locateSignatureSlots(assertNoForeignSignature(filled).dsSignature);
  assert.equal(embeddedSignedPropertiesString(filled, filledSlots), signedPropertiesString('2026-09-14T10:15:31', CD, ISSUER, SERIAL));
});

test('مُدخلات SignedProperties: لا لاحقة Z ولا كسور (UNVERIFIED(U2))، ورقم تسلسلي عشري موجب، وCertDigest بطول hex-SHA-256', () => {
  const bad: Array<[string, string, string, string]> = [
    ['2026-09-14T10:15:31Z', CD, ISSUER, SERIAL],
    ['2026-09-14T10:15:31.250', CD, ISSUER, SERIAL],
    ['2026-09-14 10:15:31', CD, ISSUER, SERIAL],
    ['2026-13-14T10:15:31', CD, ISSUER, SERIAL],
    ['2026-09-14T10:15:31', crypto.createHash('sha256').update('x').digest('base64'), ISSUER, SERIAL],
    ['2026-09-14T10:15:31', CD, '', SERIAL],
    ['2026-09-14T10:15:31', CD, 'CN=A\nB', SERIAL],
    ['2026-09-14T10:15:31', CD, ISSUER, '0x1f'],
    ['2026-09-14T10:15:31', CD, ISSUER, '0123'],
  ];
  for (const args of bad) assert.throws(() => signedPropertiesString(...args), XmlError, args.join(' | '));
});

test('pushDownNamespaces: بادئة العنصر وبادئات سماته والنطاق الافتراضي تُعلَن حيث تُستعمل فقط، والنص يبقى بايتاً ببايت', () => {
  const doc = parseXml('<r xmlns="urn:d" xmlns:a="urn:a" xmlns:b="urn:b" xmlns:unused="urn:u"><a:x  b:y="1"><a:z/>\n <c>t&amp;</c><a:w xmlns:a="urn:a2"/></a:x></r>');
  const x = childElements(doc.root)[0];
  assert.equal(pushDownNamespaces(doc, x), '<a:x xmlns:a="urn:a" xmlns:b="urn:b"  b:y="1"><a:z/>\n <c xmlns="urn:d">t&amp;</c><a:w xmlns:a="urn:a2"/></a:x>');
});

test('locateSignatureSlots: يرفض قالباً بخوارزميات أو مراجع أو معرّفات مختلفة عن قالب الهيئة', () => {
  const xml = serializeUnsigned(mapInvoiceToUbl(STANDARD_INVOICE, chainFor(2)));
  const variants: Array<[string, string]> = [
    ['SignatureMethod', xml.replace('xmldsig-more#ecdsa-sha256', 'xmldsig-more#rsa-sha256')],
    ['C14N', xml.replace('<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>', '<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>')],
    ['DigestMethod', xml.replace('xmlenc#sha256', 'xmlenc#sha512')],
    ['Id', xml.replace('Id="invoiceSignedData"', 'Id="other"')],
    ['SignedProperties Id', xml.replace('Id="xadesSignedProperties"', 'Id="x"')],
    ['Target', xml.replace('Target="signature"', 'Target="sig"')],
    ['تحويل ناقص', xml.replace(/<ds:Transform Algorithm="http:\/\/www\.w3\.org\/2006\/12\/xml-c14n11"\/>\n/, '')],
    ['مرجع ثالث', xml.replace('</ds:SignedInfo>', '<ds:Reference URI="#x"/></ds:SignedInfo>')],
  ];
  for (const [why, v] of variants) {
    assert.notEqual(v, xml, why);
    assert.throws(() => locateSignatureSlots(assertNoForeignSignature(v).dsSignature), XmlError, why);
  }
});

test('ذهبي (SDK 3.4.8): بصمة SignedProperties تطابق DigestValue الثاني في العيّنات الـ19، والكتلة المضمَّنة بعد الدفع = السلسلة المُنتَجة', { skip: SDK_SKIP }, () => {
  const cert = parseCsidCertificate(sdkCertB64());
  const cd = certDigest(cert.certB64);
  const table: Record<string, string> = {
    'Simplified/Invoice/Simplified_Invoice.xml': 'ZmMwY2ZhNDljNzNjZDA5NmY4NDM4MmY1ZmY1YTA0NjY3MzY4NzMxOGJhYmZmNWU1OGYzZWJlODI3ZDgyZGVkZA==',
    'Standard/Invoice/Standard_Invoice.xml': 'ODhlZTRmYmY3YWUzZWFjMDFmMThiZGI4OWMwMDVhMWQzMTNkZmE3MjNlMmFhYzc2Y2ZjZGM3NGMxZjc2ZWE5Yw==',
  };
  const samples = sdkSamples();
  assert.equal(samples.length, 19);
  for (const s of samples) {
    const t = rawText(s.xml, RAW.signingTime);
    const expected = rawText(s.xml, RAW.signedPropertiesDigest);
    assert.equal(signedPropertiesDigest(t, cd, cert.issuerName, cert.serialDecimal), expected, s.rel);
    if (table[s.rel]) assert.equal(expected, table[s.rel], s.rel);
    const doc = parseXml(s.xml);
    const slots = locateSignatureSlots(assertNoForeignSignature(doc).dsSignature);
    assert.equal(embeddedSignedPropertiesString(doc, slots), signedPropertiesString(t, cd, cert.issuerName, cert.serialDecimal), s.rel);
  }
});
