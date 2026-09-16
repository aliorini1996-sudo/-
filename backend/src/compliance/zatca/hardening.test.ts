// اختبارات Z2 التحصينية: كل اختبار يحرس نتيجة مؤكَّدة من المراجعة العدائية (ثلاثة مفنّدين لكل نتيجة).
// المدخلات العدائية تُبنى داخل الاختبار؛ الاختبار الذهبي الوحيد (CRLF على عيّنة الهيئة) يتخطّى عند غياب العيّنات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { CsidCertError, MAX_CERT_B64_LENGTH, parseCsidCertificate, parseCsidToken } from './cert';
import { assertNoForeignSignature, canonicalize } from './c14n';
import {
  DerError, decodeInteger, decodeOid, encBitString, encContext, encInteger, encOid, encSequence, encTlv, encUtcTime, parseDer, TAG,
} from './der';
import { mapInvoiceToUbl } from './mapInvoice';
import { UblDocument } from './model';
import { preflightIssues } from './preflight';
import { QrError, buildPhase2Qr, decodeQr, extractQrFromXml } from './qr';
import { maxSellerNameBytes, qrWorstCaseBase64Length } from './qrBudget';
import { StampError, StampErrorCode, createServerSigner, stampDocument, stampXml, verifyStampedXml } from './stamp';
import { serializeUnsigned } from './ubl';
import { embeddedSignedPropertiesString, locateSignatureSlots, signedPropertiesDigestOf } from './xades';
import { XmlError, XmlErrorCode, parseXml } from './xml';
import { SIMPLIFIED_INVOICE, STANDARD_INVOICE, STANDARD_CREDIT_NOTE, chainFor } from './__fixtures__/z1-sources';
import { CN, DC, buildTestCert, encName } from './__fixtures__/z2-testcert';
import { SDK_SKIP, sdkCertB64, sdkSample } from './__fixtures__/z2-sdk';

const TC = buildTestCert();
const CERT = parseCsidCertificate(TC.certB64);
const SIGNER = createServerSigner(TC.egsPrivateKey);
const NOW = new Date('2026-09-14T07:15:31.900Z');

const snap = (key: string) => fs.readFileSync(path.join(__dirname, '__fixtures__', 'z1', `${key}.xml`), 'utf8').replace(/\r\n/g, '\n');
const SIMPLIFIED = { xml: snap('simplified-invoice'), doc: mapInvoiceToUbl(SIMPLIFIED_INVOICE, chainFor(1)) };
const STANDARD = { xml: snap('standard-invoice'), doc: mapInvoiceToUbl(STANDARD_INVOICE, chainFor(2)) };

function xmlRejects(fn: () => unknown, code: XmlErrorCode) {
  assert.throws(fn, (e: unknown) => e instanceof XmlError && e.code === code || assert.fail(`متوقَّع XmlError ${code}، وُجد ${String(e)}`));
}

async function stampRejects(p: Promise<unknown> | (() => unknown), code: StampErrorCode, why: string) {
  const run = typeof p === 'function' ? Promise.resolve().then(p) : p;
  await assert.rejects(run, (e: unknown) => {
    assert.ok(e instanceof StampError, `${why}: ليس StampError: ${String(e)}`);
    assert.equal(e.code, code, `${why}: ${e.message}`);
    return true;
  });
}

const within = (ms: number, fn: () => void, why: string) => {
  const t0 = process.hrtime.bigint();
  fn();
  const took = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(took < ms, `${why}: استغرق ${took.toFixed(0)}ms (> ${ms}ms)`);
};

// ─────────────────────────────────────────────────────────────────────────────
// المحلّل
// ─────────────────────────────────────────────────────────────────────────────

test('[high] تضخّم خريطة النطاقات: 60 عنصراً متداخلاً × 64 إعلاناً ثم آلاف الأبناء المُعلِنة ⇒ رفض سريع NS_LIMIT لا نفاد ذاكرة', () => {
  const open = Array.from({ length: 60 }, (_, i) => `<e${i} ${Array.from({ length: 64 }, (_, k) => `xmlns:p${i}_${k}="urn:u"`).join(' ')}>`).join('');
  const close = Array.from({ length: 60 }, (_, i) => `</e${59 - i}>`).join('');
  const bomb = open + '<a xmlns:b="urn:c"/>'.repeat(20_000) + close; // ~380KB كانت تُسقط Node
  within(1000, () => xmlRejects(() => parseXml(bomb), 'NS_LIMIT'), 'قنبلة النطاقات');
  // مستند عادي بعشرات الإعلانات يمرّ
  assert.equal(parseXml(`<r ${Array.from({ length: 100 }, (_, k) => `xmlns:q${k}="urn:q${k}"`).join(' ')}/>`, { maxAttributes: 128 }).root.nsDecls.length, 100);
});

test('نطاق نسبي ⇒ NS_RELATIVE (C14N وSantuario يرفضانه)، وxmlns="" والمطلق يُقبلان', () => {
  xmlRejects(() => canonicalize('<e xmlns:p="relative"><p:x/></e>'), 'NS_RELATIVE');
  xmlRejects(() => parseXml('<e xmlns="foo"/>'), 'NS_RELATIVE');
  xmlRejects(() => parseXml('<e xmlns=":x"/>'), 'NS_RELATIVE');
  assert.equal(canonicalize('<e xmlns:p="urn:x"><p:x xmlns=""/></e>'), '<e xmlns:p="urn:x"><p:x></p:x></e>');
  assert.equal(canonicalize('<e xmlns="http://a/b"/>'), '<e xmlns="http://a/b"></e>');
});

test('الحدود: undefined يعني الافتراضي، وNaN/سالب/نص يُرفض LIMITS بدل إلغاء الحدّ بصمت', () => {
  const deep = '<a>'.repeat(5000) + '</a>'.repeat(5000);
  xmlRejects(() => parseXml(deep, { maxDepth: undefined, maxBytes: undefined }), 'DEPTH');
  xmlRejects(() => parseXml('<a/>', { maxDepth: Number.NaN }), 'LIMITS');
  xmlRejects(() => parseXml('<a/>', { maxBytes: -1 }), 'LIMITS');
  xmlRejects(() => parseXml('<a/>', { maxNodes: '5' as unknown as number }), 'LIMITS');
  xmlRejects(() => parseXml('<a/>', { maxAttributes: 1.5 }), 'LIMITS');
  assert.equal(parseXml('<a/>', { maxDepth: 3 }).root.local, 'a');
});

// ─────────────────────────────────────────────────────────────────────────────
// DER والشهادة
// ─────────────────────────────────────────────────────────────────────────────

test('[medium] INTEGER وOID الضخمان يُرفضان بزمن ثابت، وقيم INTEGER المتوسطة تبقى صحيحة', () => {
  const big = encTlv(TAG.INTEGER, Uint8Array.from([0x7f, ...new Uint8Array(80_000).fill(0x7f)]));
  within(200, () => assert.throws(() => decodeInteger(parseDer(big)), DerError), 'INTEGER 80KB');
  const longArc = encTlv(TAG.OID, Uint8Array.from([0x2a, ...new Uint8Array(80_000).fill(0x81), 0x01]));
  within(200, () => assert.throws(() => decodeOid(parseDer(longArc)), DerError), 'OID 80KB');
  assert.throws(() => decodeOid(parseDer(encTlv(TAG.OID, Uint8Array.from([0x2a, ...new Array(11).fill(0x81), 0x01])))), DerError, 'قوس 12 بايت');
  // الصحّة: مقارنة بالحساب البايتي البطيء على قيم حتى الحدّ
  for (let len = 1; len <= 128; len += 7) {
    const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 97 + len * 31) & 0xff);
    if (len > 1 && ((bytes[0] === 0 && !(bytes[1] & 0x80)) || (bytes[0] === 0xff && (bytes[1] & 0x80)))) bytes[0] ^= 0x40;
    let slow = BigInt(0);
    for (const b of bytes) slow = (slow << BigInt(8)) | BigInt(b);
    if (bytes[0] & 0x80) slow -= BigInt(1) << BigInt(8 * len);
    assert.equal(decodeInteger(parseDer(encTlv(TAG.INTEGER, bytes))), slow, `len ${len}`);
  }
  assert.throws(() => decodeInteger(parseDer(encTlv(TAG.INTEGER, Uint8Array.from([1, ...new Array(128).fill(0)])))), DerError, '129 بايت > الافتراضي');
  assert.equal(decodeInteger(parseDer(encInteger(BigInt(2) ** BigInt(1500))), 400), BigInt(2) ** BigInt(1500), 'maxBytes صريح أكبر');
});

test('[medium] شهادة ضخمة من TLVات صغيرة ⇒ CsidCertError فوراً (لا تضخّم ذاكرة)، وحدّ عُقد DER عام', () => {
  const tiny = Buffer.alloc(2_000_000);
  for (let i = 0; i < tiny.length; i += 2) { tiny[i] = 0x05; tiny[i + 1] = 0x00; }
  const der = Buffer.from(encSequence([encSequence([tiny])]));
  const rss0 = process.memoryUsage().rss;
  within(300, () => assert.throws(() => parseCsidCertificate(der.toString('base64')), CsidCertError), 'شهادة 2MB');
  within(300, () => assert.throws(() => parseCsidToken(Buffer.from(der.toString('base64')).toString('base64')), CsidCertError), 'رمز 2MB');
  assert.ok(process.memoryUsage().rss - rss0 < 150 * 1024 * 1024, 'لا تضخّم ذاكرة');
  assert.throws(() => parseCsidCertificate('A'.repeat(MAX_CERT_B64_LENGTH + 4)), CsidCertError);
  within(300, () => assert.throws(() => parseDer(der), /عدد العُقد/), 'parseDer بلا شهادة');
});

test('[low] بنى شهادة مشوّهة ⇒ CsidCertError بكود CERT_INVALID (لا TypeError)', () => {
  const sigAlg = encSequence([encOid('1.2.840.10045.4.3.2')]);
  const cert = (tbs: Uint8Array[], alg = sigAlg) => Buffer.from(encSequence([encSequence(tbs), alg, encBitString(Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]))])).toString('base64');
  const name = encName([[CN, 'X', 'utf8']]);
  const validity = encSequence([encUtcTime(new Date('2026-01-01Z')), encUtcTime(new Date('2030-01-01Z'))]);
  const spki = Buffer.from(TC.egsPublicKey.export({ type: 'spki', format: 'der' }));
  const cases: Array<[string, string]> = [
    ['[0] فارغ', cert([encContext(0, []), encInteger(5), sigAlg, name, validity, name, spki])],
    ['Validity فارغ', cert([encContext(0, encInteger(2)), encInteger(5), sigAlg, name, encSequence([]), name, spki])],
    ['Validity ناقص', cert([encContext(0, encInteger(2)), encInteger(5), sigAlg, name, encSequence([encUtcTime(new Date('2026-01-01Z'))]), name, spki])],
    ['AlgorithmIdentifier فارغ', cert([encContext(0, encInteger(2)), encInteger(5), encSequence([]), name, validity, name, spki], encSequence([]))],
    ['SPKI فارغ', cert([encContext(0, encInteger(2)), encInteger(5), sigAlg, name, validity, name, encSequence([])])],
    ['SPKI بخوارزمية فارغة', cert([encContext(0, encInteger(2)), encInteger(5), sigAlg, name, validity, name, encSequence([encSequence([]), encBitString(new Uint8Array(1))])])],
  ];
  for (const [why, b64] of cases) {
    assert.throws(() => parseCsidCertificate(b64), (e: unknown) => {
      assert.ok(e instanceof CsidCertError, `${why}: ${String(e)}`);
      assert.equal(e.code, 'CERT_INVALID');
      return true;
    });
  }
});

test('[low] اسم مُصدِر بفراغين متتاليين (Java يضعه بين علامتي تنصيص) ⇒ رفض لا اسم مخالف', () => {
  const tc = buildTestCert({ issuer: [[DC, 'local', 'ia5'], [CN, 'A  B', 'utf8']] });
  assert.throws(() => parseCsidCertificate(tc.certB64), (e: unknown) => e instanceof CsidCertError && /A {2}B/.test(e.message));
  assert.equal(parseCsidCertificate(buildTestCert({ issuer: [[DC, 'local', 'ia5'], [CN, 'A B', 'utf8']] }).certB64).issuerName, 'CN=A B, DC=local');
});

// ─────────────────────────────────────────────────────────────────────────────
// QR
// ─────────────────────────────────────────────────────────────────────────────

test('[medium] الفحص المسبق يطابق سقف QR: ما يمرّ الفحص لا يفشل ختمه بالطول، وما يُمنع يسمّي الحقل', async () => {
  for (const [label, src, base] of [['مبسّطة', SIMPLIFIED_INVOICE, 1], ['قياسية', STANDARD_INVOICE, 2]] as const) {
    const kind = label === 'مبسّطة' ? 'simplified' : 'standard';
    let sawBlock = false, sawPass = false;
    for (const n of [120, 150, 163, 170, 200, 230, 240, 250, 255]) {
      const name = 'ب'.repeat(Math.floor(n / 2)) + (n % 2 ? 'x' : '');
      const doc = mapInvoiceToUbl({ ...src, seller: { ...src.seller, legalName: name } }, chainFor(base));
      const issues = preflightIssues(doc, kind).filter(i => i.rule === 'QR-LENGTH');
      if (issues.length) {
        sawBlock = true;
        assert.equal(issues[0].field, 'supplier.registrationName');
        assert.equal(issues[0].severity, 'error');
        continue;
      }
      sawPass = true;
      const r = await stampDocument(serializeUnsigned(doc), doc, SIGNER, CERT, NOW, kind);
      assert.ok(r.qr.length <= 700, `${label} ${n}: ${r.qr.length}`);
    }
    assert.ok(sawPass, `${label}: لا حالة مرّت`);
    if (kind === 'simplified') assert.ok(sawBlock, 'المبسّطة: لا حالة مُنعت');
  }
  // الحدّ المحسوب رتيب ومتّسق مع أسوأ طول
  const p = { totalWithVat: '12345.67', vatTotal: '1610.30', simplified: true };
  const m = maxSellerNameBytes(p);
  assert.ok(qrWorstCaseBase64Length({ ...p, sellerName: 'x'.repeat(m) }) <= 700);
  assert.ok(qrWorstCaseBase64Length({ ...p, sellerName: 'x'.repeat(m + 1) }) > 700);
  assert.ok(maxSellerNameBytes({ ...p, simplified: false }) > m, 'القياسية بلا وسم 9 تتّسع لأكثر');
});

test('[low] سقف QR غير صالح (NaN، نص، سالب) ⇒ رفض لا إلغاء الفحص', async () => {
  const f = { sellerName: 'ب'.repeat(127), vat: '399999999900003', timestamp: '2026-09-14T10:15:30', totalWithVat: '115.00', vatTotal: '15.00',
    invoiceHash: Buffer.alloc(32).toString('base64'), signatureB64: Buffer.alloc(71).toString('base64'), spkiDer: new Uint8Array(88), certSignatureDer: new Uint8Array(71) };
  for (const bad of [Number.NaN, Number(undefined), -5, 0, 1.5, '1000' as unknown as number]) {
    assert.throws(() => buildPhase2Qr(f, bad), QrError, String(bad));
  }
  await stampRejects(stampDocument(SIMPLIFIED.xml, SIMPLIFIED.doc, SIGNER, CERT, NOW, 'simplified', { qrMaxLength: Number.NaN }), 'INPUT', 'NaN');
  assert.ok(preflightIssues(SIMPLIFIED.doc, 'simplified', { qrMaxLength: Number.NaN }).some(i => i.rule === 'QR-LENGTH' && i.severity === 'error'));
});

test('[low] QR محاط بفراغ غير XML (NBSP/BOM/U+3000/U+2028) ⇒ SELF_CHECK_QR، والاستخراج لا يقصّ إلا فراغ XML', async () => {
  const r = await stampDocument(SIMPLIFIED.xml, SIMPLIFIED.doc, SIGNER, CERT, NOW, 'simplified');
  for (const pad of [' ', '﻿', '　', ' ', ' ']) {
    const junk = r.xml.replace(`>${r.qr}<`, `>${pad}${r.qr}\n<`);
    assert.notEqual(junk, r.xml);
    await stampRejects(() => verifyStampedXml(junk, CERT, 'simplified'), 'SELF_CHECK_QR', JSON.stringify(pad));
  }
  assert.equal(extractQrFromXml(r.xml.replace(`>${r.qr}<`, `>\n  ${r.qr}\t<`)), r.qr);
  assert.equal(extractQrFromXml(r.xml.replace(`>${r.qr}<`, `> ${r.qr}<`)), ` ${r.qr}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// الختم والتحقق
// ─────────────────────────────────────────────────────────────────────────────

test('[medium] كائن شهادة بتواريخ كاذبة: الختم يرفض (الشهادة المُعاد تحليلها هي المرجع)، والتحقق يكشف', async () => {
  const expired = parseCsidCertificate(buildTestCert({ subjectKey: TC.egsPrivateKey, notBefore: new Date('2024-01-01Z'), notAfter: new Date('2025-01-01Z') }).certB64);
  const lying = { ...expired, notAfter: new Date('2030-01-01Z') };
  await stampRejects(stampDocument(STANDARD.xml, STANDARD.doc, SIGNER, expired, NOW, 'standard'), 'CERT_NOT_VALID', 'منتهية');
  await stampRejects(stampDocument(STANDARD.xml, STANDARD.doc, SIGNER, lying, NOW, 'standard'), 'CERT_KEY_MISMATCH', 'كاذبة');
  const ok = await stampDocument(STANDARD.xml, STANDARD.doc, SIGNER, CERT, NOW, 'standard');
  await stampRejects(() => verifyStampedXml(ok.xml, { ...CERT, notAfter: new Date('2099-01-01Z') }, 'standard'), 'SELF_CHECK_CERT', 'تحقق بكائن كاذب');
  // مفتاح PEM تالف ⇒ StampError لا خطأ OpenSSL خام
  await stampRejects(stampDocument(STANDARD.xml, STANDARD.doc, SIGNER, { ...CERT, publicKeyPem: 'garbage' }, NOW, 'standard'), 'CERT_KEY_MISMATCH', 'PEM تالف');
  // وقت التوقيع خارج سريان الشهادة عند التحقق
  const future = parseCsidCertificate(buildTestCert({ subjectKey: TC.egsPrivateKey, notBefore: new Date('2027-01-01Z') }).certB64);
  const withFuture = await stampDocument(STANDARD.xml, STANDARD.doc, SIGNER, future, new Date('2027-06-01T00:00:00Z'), 'standard');
  const backdated = withFuture.xml.replace(/<xades:SigningTime>[^<]+</, '<xades:SigningTime>2026-09-14T10:15:31<');
  await stampRejects(() => verifyStampedXml(backdated, future, 'standard'), 'CERT_NOT_VALID', 'توقيع قبل سريان الشهادة');
});

test('[low] نموذج إشعار دائن على XML فاتورة (أو مراجع فوترة مختلفة) ⇒ DOC_MISMATCH', async () => {
  await stampRejects(stampDocument(STANDARD.xml, { ...STANDARD.doc, typeCode: '381' }, SIGNER, CERT, NOW, 'standard'), 'DOC_MISMATCH', '388 مقابل 381');
  const note = { xml: snap('standard-credit-note'), doc: mapInvoiceToUbl(STANDARD_CREDIT_NOTE, chainFor(3)) };
  assert.ok((note.doc.billingReferences ?? []).length > 0, 'الإشعار يحمل مرجع فوترة');
  await stampRejects(stampDocument(note.xml, { ...note.doc, billingReferences: ['INV-OTHER'] }, SIGNER, CERT, NOW, 'standard'), 'DOC_MISMATCH', 'مرجع مختلف');
  await stampRejects(stampDocument(note.xml, { ...note.doc, billingReferences: [] }, SIGNER, CERT, NOW, 'standard'), 'DOC_MISMATCH', 'مرجع محذوف');
  assert.ok((await stampDocument(note.xml, note.doc, SIGNER, CERT, NOW, 'standard')).xml.includes('<ds:SignatureValue>'));
});

test('[low] قالب توقيع معدَّل خارج التجزئة والتوقيع ⇒ SELF_CHECK_LAYOUT (الختم والتحقق)', async () => {
  const variants: Array<[string, string, string]> = [
    ['XPath', 'not(//ancestor-or-self::cac:Signature)', 'true()'],
    ['ExtensionURI', '<ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>', '<ext:ExtensionURI>urn:bogus</ext:ExtensionURI>'],
    ['ReferencedSignatureID', '<sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>', '<sbc:ReferencedSignatureID>urn:x</sbc:ReferencedSignatureID>'],
    ['cac:Signature/SignatureMethod', '<cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod>', '<cbc:SignatureMethod>urn:x</cbc:SignatureMethod>'],
    ['KeyName زائد', '<ds:X509Data>', '<ds:KeyName>k</ds:KeyName><ds:X509Data>'],
    ['سمة زائدة', '<ds:SignedInfo>', '<ds:SignedInfo Id="x">'],
  ];
  const signed = await stampDocument(STANDARD.xml, STANDARD.doc, SIGNER, CERT, NOW, 'standard');
  for (const [why, from, to] of variants) {
    assert.equal(STANDARD.xml.split(from).length, 2, `${why}: المرساة`);
    await stampRejects(stampXml(STANDARD.xml.replace(from, to), SIGNER, CERT, NOW, 'standard'), 'SELF_CHECK_LAYOUT', `ختم: ${why}`);
    await stampRejects(() => verifyStampedXml(signed.xml.replace(from, to), CERT, 'standard'), 'SELF_CHECK_LAYOUT', `تحقق: ${why}`);
  }
});

test('[medium] SignedProperties محشوّة بإعلانات نطاق وآلاف العناصر ⇒ رفض سريع قبل دفع النطاقات', async () => {
  const r = await stampDocument(SIMPLIFIED.xml, SIMPLIFIED.doc, SIGNER, CERT, NOW, 'simplified');
  const nest = Array.from({ length: 45 }, (_, i) => `<x${i} ${Array.from({ length: 2 }, (_, k) => `xmlns:q${i}_${k}="urn:u"`).join(' ')}>`).join('');
  const unnest = Array.from({ length: 45 }, (_, i) => `</x${44 - i}>`).join('');
  const padded = r.xml.replace('</xades:SignedSignatureProperties>', `</xades:SignedSignatureProperties>${nest}${'<a/>'.repeat(30_000)}${unnest}`);
  assert.notEqual(padded, r.xml);
  const t0 = Date.now();
  await stampRejects(() => verifyStampedXml(padded, CERT, 'simplified'), 'SELF_CHECK_LAYOUT', 'حشو');
  assert.ok(Date.now() - t0 < 2000, `استغرق ${Date.now() - t0}ms`);
});

test('[low] نهايات أسطر CRLF: ختم وتحقّق مستند صحيح لا يُرفض خطأً في SignedProperties', async () => {
  const crlf = STANDARD.xml.replace(/\n/g, '\r\n');
  const r = await stampXml(crlf, SIGNER, CERT, NOW, 'standard');
  assert.ok(r.xml.includes('\r\n'));
  verifyStampedXml(r.xml, CERT, 'standard');
  const lf = await stampXml(STANDARD.xml, SIGNER, CERT, NOW, 'standard');
  assert.equal(r.invoiceHash, lf.invoiceHash, 'التجزئة لا تتأثّر بنهايات الأسطر');
  assert.equal(r.signedPropertiesDigest, lf.signedPropertiesDigest);
  verifyStampedXml(lf.xml.replace(/\n/g, '\r\n'), CERT, 'standard');
});

test('[low] ذهبي: عيّنة الهيئة بعد تحويلها إلى CRLF ما زالت تتحقّق', { skip: SDK_SKIP }, () => {
  const s = sdkSample('Simplified/Invoice/Simplified_Invoice.xml');
  const cert = parseCsidCertificate(sdkCertB64().trim());
  verifyStampedXml(s.xml, cert, 'simplified');
  verifyStampedXml(s.xml.replace(/\n/g, '\r\n'), cert, 'simplified');
});

test('كل أخطاء الختم مصنَّفة: XML تالف وشهادة تالفة ⇒ StampError بكود ثابت مع cause', async () => {
  await assert.rejects(stampXml('<Invoice', SIGNER, CERT, NOW, 'standard'), (e: unknown) => e instanceof StampError && e.code === 'XML_INVALID' && e.cause instanceof XmlError);
  await assert.rejects(stampXml(STANDARD.xml, SIGNER, { ...CERT, certB64: 'AAAA' }, NOW, 'standard'), (e: unknown) => e instanceof StampError && e.code === 'CERT_INVALID' && e.cause instanceof CsidCertError);
  await assert.rejects(stampDocument(STANDARD.xml, null as unknown as UblDocument, SIGNER, CERT, NOW, 'standard'), (e: unknown) => e instanceof StampError && e.code === 'INPUT');
  await assert.rejects(Promise.resolve().then(() => verifyStampedXml('<x/>', CERT, 'standard')), (e: unknown) => e instanceof StampError);
});

// ─────────────────────────────────────────────────────────────────────────────
// الجولة الثانية: نتائج مراجعة الإصلاحات
// ─────────────────────────────────────────────────────────────────────────────

test('[high] URI نطاق طويل مع سمات بادئة متكرّرة: رفض فوري NS_LIMIT، وURI بطول الحدّ يُحلَّل ويُطبَّع خطّياً', () => {
  const bomb = `<r xmlns:p="urn:${'x'.repeat(300_000)}">` + '<e p:a="" p:b=""/>'.repeat(30_000) + '</r>';
  within(500, () => xmlRejects(() => parseXml(bomb), 'NS_LIMIT'), 'URI 300KB');
  const u1 = `urn:${'x'.repeat(1015)}`, u2 = `urn:${'x'.repeat(1014)}y`;
  const ok = `<r xmlns:p="${u1}" xmlns:q="${u2}">` + '<e p:a="" p:b="" q:a=""/>'.repeat(30_000) + '</r>';
  within(3000, () => { parseXml(ok); canonicalize(ok); }, 'URI 1019 × 30000 عنصر');
  xmlRejects(() => parseXml('<r xmlns:p="u:x" p:a="" q:a="" xmlns:q="u:x"/>'), 'DUP_ATTR');
});

test('[medium] QR من ملايين TLVات فارغة داخل مستند مختوم ⇒ SELF_CHECK_QR سريعاً بلا تضخّم ذاكرة', async () => {
  const r = await stampDocument(SIMPLIFIED.xml, SIMPLIFIED.doc, SIGNER, CERT, NOW, 'simplified');
  const bombQr = 'AQABAAEA'.repeat(500_000); // 4MB
  const doc = r.xml.replace(`>${r.qr}<`, `>${bombQr}<`);
  assert.notEqual(doc, r.xml);
  const rss0 = process.memoryUsage().rss;
  const t0 = Date.now();
  await stampRejects(() => verifyStampedXml(doc, CERT, 'simplified'), 'SELF_CHECK_QR', 'قنبلة TLV');
  assert.ok(Date.now() - t0 < 3000, `استغرق ${Date.now() - t0}ms`);
  within(50, () => assert.throws(() => decodeQr(bombQr), QrError), 'decodeQr مباشرة');
  assert.ok(process.memoryUsage().rss - rss0 < 200 * 1024 * 1024, 'لا تضخّم ذاكرة');
  // عشرة وسوم صغيرة صالحة الشكل ⇒ رفض عند الوسم العاشر
  assert.throws(() => decodeQr(Buffer.from(Array.from({ length: 10 }, () => [1, 0]).flat()).toString('base64')), /أكثر من 9/);
});

test('[low] مرجع QR بعناصر أو سمات زائدة (خارج التجزئة والتوقيع) ⇒ SELF_CHECK_LAYOUT', async () => {
  const signed = await stampDocument(STANDARD.xml, STANDARD.doc, SIGNER, CERT, NOW, 'standard');
  const variants: Array<[string, (x: string) => string]> = [
    ['cbc:ID مكرّر', x => x.replace('<cbc:ID>QR</cbc:ID>', '<cbc:ID>QR</cbc:ID><cbc:ID>ICV</cbc:ID>')],
    ['سمات على الكائن', x => x.replace(/(<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject mimeCode="text\/plain")/, '$1 filename="x.exe" encodingCode="Hex"')],
    ['عنصر زائد في Attachment', x => x.replace(/(<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>)/, '$1<cbc:Note>x</cbc:Note>')],
    ['سمة على المرجع', x => x.replace(/<cac:AdditionalDocumentReference>(\s*<cbc:ID>QR)/, '<cac:AdditionalDocumentReference id="x">$1')],
  ];
  for (const [why, mutate] of variants) {
    const unsigned = mutate(STANDARD.xml);
    assert.notEqual(unsigned, STANDARD.xml, `${why}: لم يتغيّر`);
    await stampRejects(stampXml(unsigned, SIGNER, CERT, NOW, 'standard'), 'SELF_CHECK_LAYOUT', `ختم: ${why}`);
    const tampered = mutate(signed.xml);
    assert.notEqual(tampered, signed.xml);
    await stampRejects(() => verifyStampedXml(tampered, CERT, 'standard'), 'SELF_CHECK_LAYOUT', `تحقق: ${why}`);
  }
});

test('[low] اسم بائع 256 بايت فأكثر ⇒ QR_TOO_LONG بالحقل (خطأ بيانات) لا SELF_CHECK_QR', async () => {
  for (const [n, cap] of [[255, 700], [256, 700], [256, 1000], [300, 1000]] as const) {
    const doc = mapInvoiceToUbl({ ...STANDARD_INVOICE, seller: { ...STANDARD_INVOICE.seller, legalName: 'x'.repeat(n) } }, chainFor(2));
    await assert.rejects(stampDocument(serializeUnsigned(doc), doc, SIGNER, CERT, NOW, 'standard', { qrMaxLength: cap }), (e: unknown) => {
      assert.ok(e instanceof StampError, String(e));
      assert.equal(e.code, 'QR_TOO_LONG', `${n}/${cap}: ${e.message}`);
      assert.equal(e.field, 'supplier.registrationName');
      return true;
    });
  }
});

test('[low] SigningTime بتاريخ مستحيل (30 فبراير، 31 سبتمبر) ⇒ رفض حتى مع DigestValue مُعاد حسابه', async () => {
  const signed = await stampDocument(STANDARD.xml, STANDARD.doc, SIGNER, CERT, NOW, 'standard');
  for (const bad of ['2026-02-30T10:15:31', '2026-09-31T10:15:31']) {
    let x = signed.xml.replace(/<xades:SigningTime>[^<]+</, `<xades:SigningTime>${bad}<`);
    const d = parseXml(x);
    const slots = locateSignatureSlots(assertNoForeignSignature(d).dsSignature);
    const spDigest = signedPropertiesDigestOf(embeddedSignedPropertiesString(d, slots));
    const before = x;
    x = x.replace(/(URI="#xadesSignedProperties">\s*<ds:DigestMethod[^>]*\/>\s*<ds:DigestValue>)[^<]+/, `$1${spDigest}`);
    assert.notEqual(x, before, 'أُعيد حساب DigestValue');
    await assert.rejects(Promise.resolve().then(() => verifyStampedXml(x, CERT, 'standard')), (e: unknown) => {
      assert.ok(e instanceof StampError && e.code === 'SELF_CHECK_SIGNED_PROPERTIES', String(e));
      assert.match(e.message, /تاريخاً صالحاً/, 'يُرفض لأن التاريخ مستحيل لا لاختلاف البصمة');
      return true;
    });
  }
});

test('[low] نموذج يختلف عن الـXML في حقل خارج QR (سبب الإشعار، العميل، البنود، تاريخ التوريد) ⇒ DOC_MISMATCH', async () => {
  const note = { xml: snap('standard-credit-note'), doc: mapInvoiceToUbl(STANDARD_CREDIT_NOTE, chainFor(3)) };
  const clone = (): UblDocument => JSON.parse(JSON.stringify(note.doc));
  const mutations: Array<[string, (d: UblDocument) => void]> = [
    ['سبب الإشعار', d => { d.instructionNote = 'سبب مختلف تماماً'; }],
    ['اسم العميل', d => { d.customer = { ...d.customer, registrationName: 'عميل آخر' }; }],
    ['البنود', d => { d.lines = []; }],
    ['تاريخ التوريد', d => { d.supplyDate = '2020-01-01'; }],
  ];
  for (const [why, m] of mutations) {
    const d = clone();
    m(d);
    await stampRejects(stampDocument(note.xml, d, SIGNER, CERT, NOW, 'standard'), 'DOC_MISMATCH', why);
  }
  // CRLF في المُدخل لا يُعدّ اختلافاً
  assert.ok((await stampDocument(note.xml.replace(/\n/g, '\r\n'), note.doc, SIGNER, CERT, NOW, 'standard')).xml.includes('<ds:SignatureValue>'));
});

test('[medium] استخراج QR بفراغ داخلي طويل خطّي الزمن', () => {
  const empty = '<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain"></cbc:EmbeddedDocumentBinaryObject>';
  assert.equal(SIMPLIFIED.xml.split(empty).length, 2, 'خانة QR فارغة واحدة');
  const padded = SIMPLIFIED.xml.replace(empty, `<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">\n A${' '.repeat(160_000)}B \t</cbc:EmbeddedDocumentBinaryObject>`);
  let got: string | null = null;
  within(500, () => { got = extractQrFromXml(padded); }, 'فراغ 160K');
  assert.equal(got, `A${' '.repeat(160_000)}B`);
});

test('[low] مرجع فوترة فارغ: الفحص المسبق يسمّيه، والختم يطبّق قاعدة المُسلسِل نفسها', async () => {
  const cn = mapInvoiceToUbl(STANDARD_CREDIT_NOTE, chainFor(3));
  const withBlank: UblDocument = { ...cn, billingReferences: [...(cn.billingReferences ?? []), '  '] };
  const issues = preflightIssues(withBlank, 'standard').filter(i => i.severity === 'error');
  assert.ok(issues.some(i => i.rule === 'BR-KSA-56' && i.field === `billingReferences[${(cn.billingReferences ?? []).length}]`), JSON.stringify(issues));
  const r = await stampDocument(serializeUnsigned(withBlank), withBlank, SIGNER, CERT, NOW, 'standard');
  assert.ok(r.xml.includes('<ds:SignatureValue>'));
});

// ─────────────────────────────────────────────────────────────────────────────
// الجولة الثالثة
// ─────────────────────────────────────────────────────────────────────────────

/** 64 نطاقاً بطول الحدّ (1024) تشترك في 1022 محرفاً، وعناصر بـ64 سمة بادئة مبعثرة الترتيب. */
function nsSortBomb(elements: number): { decls: string; body: string } {
  const u = (k: number) => `urn:${'x'.repeat(1018)}${k.toString(16).padStart(2, '0')}`;
  const p = (k: number) => `p${k.toString(36)}`;
  const decls = Array.from({ length: 64 }, (_, k) => `xmlns:${p(k)}="${u(k)}"`).join(' ');
  let seed = 12345;
  const order = () => {
    const a = Array.from({ length: 64 }, (_, k) => k);
    for (let i = a.length - 1; i > 0; i--) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; const j = seed % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const body = Array.from({ length: elements }, () => `<e${order().map(k => ` ${p(k)}:a=""`).join('')}/>`).join('');
  return { decls, body };
}

test('[high] ترتيب سمات C14N لا يقارن URIs كاملة: 64 نطاقاً × 1024 محرفاً × 64 سمة مبعثرة يُطبَّع خطّياً', async () => {
  const { decls, body } = nsSortBomb(2000); // ~1MB، ~128K سمة (ضمن ميزانية المستند)
  const xml = `<r ${decls}>${body}</r>`;
  within(2000, () => canonicalize(xml), 'canonicalize ~1MB');
  // والترتيب ما زال صحيحاً: بنقاط يونيكود للـURI ثم الاسم المحلي
  assert.equal(canonicalize('<r xmlns:a="urn:z" xmlns:b="urn:a" a:k="1" b:k="2" b:j="3"/>'), '<r xmlns:a="urn:z" xmlns:b="urn:a" b:j="3" b:k="2" a:k="1"></r>');
  // داخل فاتورة مختومة: التحقق يرفض (تغيّر الجسم) بسرعة
  const r = await stampDocument(STANDARD.xml, STANDARD.doc, SIGNER, CERT, NOW, 'standard');
  const tampered = r.xml.replace('</Invoice>', `<w ${decls}>${body}</w></Invoice>`);
  const t0 = Date.now();
  await stampRejects(() => verifyStampedXml(tampered, CERT, 'standard'), 'SELF_CHECK_HASH', 'جسم محشوّ');
  assert.ok(Date.now() - t0 < 3000, `استغرق ${Date.now() - t0}ms`);
});

test('[medium] ميزانية السمات على مستوى المستند: 1.2 مليون سمة ضمن 8MB ⇒ رفض ATTRS سريع بلا تضخّم ذاكرة', () => {
  const xml = STANDARD.xml.replace('</Invoice>', `${'<a b="" c="" d=""/>'.repeat(398_600)}</Invoice>`);
  const rss0 = process.memoryUsage().rss;
  within(1500, () => xmlRejects(() => parseXml(xml), 'ATTRS'), '7.6MB سمات');
  assert.ok(process.memoryUsage().rss - rss0 < 250 * 1024 * 1024, 'ذاكرة محدودة');
  // فاتورة واقعية كبيرة (آلاف البنود) تمرّ
  const line = /<cac:InvoiceLine>[\s\S]*?<\/cac:InvoiceLine>/.exec(STANDARD.xml)![0];
  const big = STANDARD.xml.replace('</Invoice>', `${line.repeat(3000)}</Invoice>`);
  assert.ok(Buffer.byteLength(big) > 2_000_000);
  assert.equal(parseXml(big).root.local, 'Invoice');
});

test('[medium] موضع مرجع QR وcac:Signature مثبَّت (ICV ← PIH ← QR ← Signature ← AccountingSupplierParty)', async () => {
  const QR_RE = /<cac:AdditionalDocumentReference>\s*<cbc:ID>QR<\/cbc:ID>[\s\S]*?<\/cac:AdditionalDocumentReference>/;
  const SIG_RE = /<cac:Signature>[\s\S]*?<\/cac:Signature>/;
  const moves: Array<[string, (x: string) => string]> = [
    ['QR إلى آخر الفاتورة', x => { const m = QR_RE.exec(x)![0]; return x.replace(m, '').replace('</Invoice>', `${m}</Invoice>`); }],
    ['Signature إلى آخر الفاتورة', x => { const m = SIG_RE.exec(x)![0]; return x.replace(m, '').replace('</Invoice>', `${m}</Invoice>`); }],
    ['QR بعد UBLExtensions', x => { const m = QR_RE.exec(x)![0]; return x.replace(m, '').replace('</ext:UBLExtensions>', `</ext:UBLExtensions>${m}`); }],
  ];
  const signed = await stampDocument(STANDARD.xml, STANDARD.doc, SIGNER, CERT, NOW, 'standard');
  for (const [why, move] of moves) {
    const unsigned = move(STANDARD.xml);
    assert.notEqual(unsigned, STANDARD.xml);
    await stampRejects(stampXml(unsigned, SIGNER, CERT, NOW, 'standard'), 'SELF_CHECK_LAYOUT', `ختم: ${why}`);
    await stampRejects(() => verifyStampedXml(move(signed.xml), CERT, 'standard'), 'SELF_CHECK_LAYOUT', `تحقق: ${why}`);
  }
});

test('[medium] ذهبي: عيّنة الهيئة بعد نقل cac:Signature أو مرجع QR ⇒ SELF_CHECK_LAYOUT، والأصل يتحقّق', { skip: SDK_SKIP }, async () => {
  const s = sdkSample('Standard/Invoice/Standard_Invoice.xml');
  const cert = parseCsidCertificate(sdkCertB64().trim());
  verifyStampedXml(s.xml, cert, 'standard');
  const sig = /<cac:Signature>[\s\S]*?<\/cac:Signature>/.exec(s.xml)![0];
  await stampRejects(() => verifyStampedXml(s.xml.replace(sig, '').replace('</Invoice>', `${sig}</Invoice>`), cert, 'standard'), 'SELF_CHECK_LAYOUT', 'نقل التوقيع');
});

test('[low] كل مخالفة لقالب التوقيع كود واحد SELF_CHECK_LAYOUT (خوارزمية، معرّف، XPath)', async () => {
  const variants: Array<[string, string, string]> = [
    ['CanonicalizationMethod', '<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>', '<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>'],
    ['SignedProperties/@Id', 'Id="xadesSignedProperties"', 'Id="other"'],
    ['ds:Signature/@Id', '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="signature">', '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="sig2">'],
    ['XPath', 'not(//ancestor-or-self::cac:Signature)', 'true()'],
  ];
  for (const [why, from, to] of variants) {
    assert.equal(STANDARD.xml.split(from).length, 2, `${why}: المرساة`);
    await stampRejects(stampXml(STANDARD.xml.replace(from, to), SIGNER, CERT, NOW, 'standard'), 'SELF_CHECK_LAYOUT', why);
  }
});

test('[low] قيم QR الخاطئة في المستند خطأ بيانات INPUT باسم الحقل (لا SELF_CHECK_QR)', async () => {
  const cases: Array<[string, (x: string) => string, string]> = [
    ['IssueTime بلاحقة Z', x => x.replace(/<cbc:IssueTime>([^<]+)</, '<cbc:IssueTime>$1Z<'), 'issueTime'],
    ['PayableAmount سالب', x => x.replace(/(<cbc:PayableAmount[^>]*>)([^<]+)</, '$1-$2<'), 'totals.payable'],
    ['TaxAmount فارغ', x => x.replace(/(<cac:TaxTotal>\s*<cbc:TaxAmount[^>]*>)[^<]+</, '$1<'), 'totals.taxTotal'],
    ['CompanyID البائع فارغ', x => x.replace(/(<cac:AccountingSupplierParty>[\s\S]*?<cbc:CompanyID>)[^<]+</, '$1<'), 'supplier.vatNumber'],
  ];
  for (const [why, mutate, field] of cases) {
    const x = mutate(STANDARD.xml);
    assert.notEqual(x, STANDARD.xml, `${why}: لم يتغيّر`);
    await assert.rejects(stampXml(x, SIGNER, CERT, NOW, 'standard'), (e: unknown) => {
      assert.ok(e instanceof StampError, `${why}: ${String(e)}`);
      assert.equal(e.code, 'INPUT', `${why}: ${e.message}`);
      assert.equal(e.field, field, why);
      return true;
    });
  }
});

test('[low] SignatureValue تالف في مستند يُتحقَّق منه ⇒ SELF_CHECK_SIGNATURE لا SIGNER', async () => {
  const r = await stampDocument(STANDARD.xml, STANDARD.doc, SIGNER, CERT, NOW, 'standard');
  for (const bad of ['AAAA', `${r.signatureB64}\n`, 'A'.repeat(200)]) {
    const x = r.xml.replace(`<ds:SignatureValue>${r.signatureB64}</ds:SignatureValue>`, `<ds:SignatureValue>${bad}</ds:SignatureValue>`);
    assert.notEqual(x, r.xml);
    await stampRejects(() => verifyStampedXml(x, CERT, 'standard'), 'SELF_CHECK_SIGNATURE', JSON.stringify(bad.slice(0, 10)));
  }
  // وموقِّع يعيد توقيعاً تالفاً وقت الختم ⇒ SIGNER
  const garbage = { async signHash() { return 'AAAA'; } };
  await stampRejects(stampDocument(STANDARD.xml, STANDARD.doc, garbage, CERT, NOW, 'standard'), 'SIGNER', 'موقِّع تالف');
});
