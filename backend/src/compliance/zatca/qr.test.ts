// اختبارات Z2 لرمز QR المرحلة الثانية: TLV، الحدود، الفكّ، القراءة من الـXML، وإعادة بناء QR العيّنات الرسمية.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  QR_MAX_BASE64_LENGTH, QrError, buildPhase2Qr, decodeQr, decodeTlv, extractQrFromXml, readQrSourceFromXml, tlv,
} from './qr';
import { mapInvoiceToUbl } from './mapInvoice';
import { serializeUnsigned } from './ubl';
import { XmlError } from './xml';
import { SIMPLIFIED_INVOICE, STANDARD_INVOICE, chainFor } from './__fixtures__/z1-sources';
import { RAW, SDK_SKIP, rawText, sdkCertB64, sdkSample, sdkSamples } from './__fixtures__/z2-sdk';
import { parseCsidCertificate } from './cert';

const utf8 = (s: string) => Buffer.from(s, 'utf8');
const qrErr = (fn: () => unknown, re?: RegExp) => assert.throws(fn, (e: unknown) => {
  assert.ok(e instanceof QrError, String(e));
  if (re) assert.match((e as Error).message, re);
  return true;
});

const HASH = crypto.createHash('sha256').update('invoice').digest('base64');
const SIG = crypto.randomBytes(71).toString('base64');
const SPKI = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).publicKey.export({ type: 'spki', format: 'der' });
const CERT_SIG = crypto.randomBytes(71);
const FIELDS = {
  sellerName: 'شركة التوزيع الميداني التجريبية المحدودة', vat: '399999999900003', timestamp: '2026-09-14T10:15:30',
  totalWithVat: '231.15', vatTotal: '30.15', invoiceHash: HASH, signatureB64: SIG, spkiDer: SPKI,
};

test('C-Q1: TLV = [وسم][طول][قيمة] متتالية؛ حدّ 255 بايت للقيمة؛ والفكّ صارم', () => {
  assert.equal(Buffer.from(tlv([[1, utf8('ab')], [2, new Uint8Array(0)], [9, Uint8Array.from([0xff])]])).toString('hex'), '010261620200' + '0901ff');
  const max = crypto.randomBytes(255);
  const enc = tlv([[1, max], [255, utf8('x')]]);
  assert.equal(enc[1], 255, 'طول 255 ببايت واحد (UNVERIFIED(U1))');
  assert.deepEqual(decodeTlv(enc).map(([t, v]) => [t, Buffer.from(v).toString('hex')]), [[1, max.toString('hex')], [255, '78']]);
  qrErr(() => tlv([[1, new Uint8Array(256)]]), /256/);
  qrErr(() => tlv([[0, utf8('x')]]));
  qrErr(() => tlv([[256, utf8('x')]]));
  qrErr(() => decodeTlv(Uint8Array.from([1, 3, 0x61, 0x62])), /مبتورة/);
  qrErr(() => decodeTlv(Uint8Array.from([1])), /مبتور/);
  qrErr(() => decodeTlv(Uint8Array.from([0, 0])));
});

test('buildPhase2Qr ⇄ decodeQr: الوسوم 1–8 و9 اختيارياً، الوسم 6 نصّ base64 (44 بايت) و7 نصّ التوقيع و8 SPKI خام', () => {
  const standard = buildPhase2Qr(FIELDS);
  const d = decodeQr(standard);
  assert.deepEqual(d.tags.map(t => t[0]), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(d.tags.map(t => t[1].length), [utf8(FIELDS.sellerName).length, 15, 19, 6, 5, 44, SIG.length, 88]);
  assert.equal(d.sellerName, FIELDS.sellerName);
  assert.equal(d.invoiceHash, HASH);
  assert.equal(d.signatureB64, SIG);
  assert.deepEqual(Buffer.from(d.spkiDer!), SPKI);
  assert.equal(d.certSignatureDer, undefined);

  const simplified = buildPhase2Qr({ ...FIELDS, certSignatureDer: CERT_SIG });
  const s = decodeQr(simplified);
  assert.deepEqual(s.tags.map(t => t[0]), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(Buffer.from(s.certSignatureDer!), CERT_SIG);
  assert.ok(simplified.startsWith(standard.slice(0, 40)));

  // المرحلة الأولى (1–5) تُفكّ أيضاً
  const p1 = Buffer.from(tlv([[1, utf8('a')], [2, utf8('b')], [3, utf8('c')], [4, utf8('d')], [5, utf8('e')]])).toString('base64');
  assert.equal(decodeQr(p1).invoiceHash, undefined);
});

test('buildPhase2Qr يرفض: تجزئة ليست 32 بايت، base64 غير قانوني، صيغة ختم بلا T أو بـZ (UNVERIFIED(U2))، مبالغ سالبة، حقول فارغة', () => {
  qrErr(() => buildPhase2Qr({ ...FIELDS, invoiceHash: Buffer.from(crypto.createHash('sha256').update('x').digest('hex')).toString('base64') }), /32/);
  qrErr(() => buildPhase2Qr({ ...FIELDS, signatureB64: `${SIG}\n` }));
  qrErr(() => buildPhase2Qr({ ...FIELDS, timestamp: '2026-09-14T10:15:30Z' }), /U2/);
  qrErr(() => buildPhase2Qr({ ...FIELDS, timestamp: '2026-09-14 10:15:30' }));
  qrErr(() => buildPhase2Qr({ ...FIELDS, totalWithVat: '-1.00' }));
  qrErr(() => buildPhase2Qr({ ...FIELDS, vatTotal: '1,00' }));
  qrErr(() => buildPhase2Qr({ ...FIELDS, sellerName: '  ' }));
  qrErr(() => buildPhase2Qr({ ...FIELDS, vat: '' }));
  qrErr(() => buildPhase2Qr({ ...FIELDS, spkiDer: new Uint8Array(0) }));
  qrErr(() => buildPhase2Qr({ ...FIELDS, certSignatureDer: new Uint8Array(0) }));
});

test('C-Q4: سقف 700 محرف base64 افتراضياً (UNVERIFIED(U1): 700 مقابل 1000) وحدّ 255 بايت لكل قيمة', () => {
  assert.equal(QR_MAX_BASE64_LENGTH, 700);
  // المبسّطة بقيم هذا الاختبار: 18 بايت رؤوس + 344 بايت للوسوم 2–9 + الاسم ⇒ base64 ≤ 700 يعني الاسم ≤ 163 بايت:
  // 81 حرفاً عربياً (162 بايت) ⇒ 700 محرفاً بالضبط؛ 82 حرفاً (164 بايت) ⇒ 704 فيُرفض
  const name = (n: number) => 'ب'.repeat(n);
  assert.equal(buildPhase2Qr({ ...FIELDS, sellerName: name(81), certSignatureDer: CERT_SIG }).length, 700);
  qrErr(() => buildPhase2Qr({ ...FIELDS, sellerName: name(82), certSignatureDer: CERT_SIG }), /704 محرفاً > 700/);
  // مع سقف 1000 صراحةً: 127 حرفاً (254 بايت) تمرّ، و128 (256 بايت) تُرفض بحدّ الـTLV
  assert.ok(buildPhase2Qr({ ...FIELDS, sellerName: name(127), certSignatureDer: CERT_SIG }, 1000).length > 700);
  qrErr(() => buildPhase2Qr({ ...FIELDS, sellerName: name(128), certSignatureDer: CERT_SIG }, 1000), /256/);
});

test('decodeQr يرفض: وسوم خارج الترتيب أو مكرّرة أو مجهولة، UTF-8 غير صالح، base64 غير قانوني', () => {
  const enc = (tags: Array<[number, Uint8Array]>) => Buffer.from(tlv(tags)).toString('base64');
  const five: Array<[number, Uint8Array]> = [1, 2, 3, 4, 5].map(t => [t, utf8(`v${t}`)]);
  qrErr(() => decodeQr(enc([five[0], five[1], five[2], five[4], five[3]])), /تسلسل/);
  qrErr(() => decodeQr(enc([...five, [5, utf8('x')]])), /تسلسل/);
  qrErr(() => decodeQr(enc([...five, [10, utf8('x')]])), /تسلسل/);
  qrErr(() => decodeQr(enc([...five, [6, utf8('x')], [7, utf8('y')]])), /تسلسل/);
  qrErr(() => decodeQr(enc([[1, Uint8Array.from([0xc3, 0x28])], ...five.slice(1)])), /UTF-8/);
  qrErr(() => decodeQr(`${enc(five)} `));
});

test('من الـXML: extractQrFromXml يعيد null للخانة الفارغة، وreadQrSourceFromXml يقرأ الوسوم 1–5 كما كُتبت', () => {
  const doc = mapInvoiceToUbl(SIMPLIFIED_INVOICE, chainFor(1));
  const xml = serializeUnsigned(doc);
  assert.equal(extractQrFromXml(xml), null);
  const src = readQrSourceFromXml(xml);
  assert.deepEqual(src, {
    sellerName: doc.supplier.registrationName, vat: doc.supplier.vatNumber, timestamp: `${doc.issueDate}T${doc.issueTime}`,
    totalWithVat: doc.totals.payable, vatTotal: doc.totals.taxTotal, subtype: '02',
  });
  assert.notEqual(doc.totals.payable, doc.totals.taxInclusive, 'المبسّطة المرجعية فيها PayableRoundingAmount');
  assert.equal(readQrSourceFromXml(serializeUnsigned(mapInvoiceToUbl(STANDARD_INVOICE, chainFor(2)))).subtype, '01');

  const filled = xml.replace('<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain"></cbc:EmbeddedDocumentBinaryObject>', '<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">\n  QUJD\n</cbc:EmbeddedDocumentBinaryObject>');
  assert.equal(extractQrFromXml(filled), 'QUJD');
  const twice = xml.replace('<cac:Signature>', '<cac:AdditionalDocumentReference><cbc:ID> QR </cbc:ID></cac:AdditionalDocumentReference>\n    <cac:Signature>');
  assert.throws(() => extractQrFromXml(twice), XmlError);
  assert.throws(() => readQrSourceFromXml(xml.replace(/<cac:TaxTotal>[\s\S]*<\/cac:TaxTotal>/, '')), XmlError);
});

test('ذهبي (SDK 3.4.8): إعادة بناء QR كل عيّنة من قيم الـXML + التجزئة + SignatureValue + الشهادة تطابق base64 حرفياً', { skip: SDK_SKIP }, () => {
  const cert = parseCsidCertificate(sdkCertB64());
  const samples = sdkSamples();
  assert.equal(samples.length, 19);
  const payableDiffers: string[] = [];
  for (const s of samples) {
    const src = readQrSourceFromXml(s.xml);
    assert.equal(src.subtype, s.kind === 'simplified' ? '02' : '01', s.rel);
    const qr = rawText(s.xml, RAW.qr);
    assert.equal(extractQrFromXml(s.xml), qr, s.rel);
    const rebuilt = buildPhase2Qr({
      sellerName: src.sellerName, vat: src.vat, timestamp: src.timestamp, totalWithVat: src.totalWithVat, vatTotal: src.vatTotal,
      invoiceHash: rawText(s.xml, RAW.invoiceDigest), signatureB64: rawText(s.xml, RAW.signatureValue), spkiDer: cert.spkiDer,
      certSignatureDer: s.kind === 'simplified' ? cert.certSignatureDer : undefined,
    });
    assert.equal(rebuilt, qr, s.rel);
    const tia = rawText(s.xml, /<cbc:TaxInclusiveAmount[^>]*>([^<]*)</);
    if (tia !== src.totalWithVat) payableDiffers.push(s.rel);
  }
  // الوسم 4 = PayableAmount: العيّنات التي يختلف فيها عن TaxInclusiveAmount تثبت ذلك (خلافاً لـC-Q2 في التصميم)
  assert.deepEqual(payableDiffers.sort(), [
    'Standard/Invoice/Advance Payment adjustments with foreign currency invoice.xml',
    'Standard/Invoice/Advance Payment adjustments with rate change scenarios.xml',
    'Standard/Invoice/Advance Payment adjustments.xml',
    'Standard/Invoice/Standard Invoice with Payable Rounding Adjustment.xml',
  ]);

  const si = decodeQr(rawText(sdkSample('Simplified/Invoice/Simplified_Invoice.xml').xml, RAW.qr));
  assert.deepEqual(si.tags.map(t => t[1].length), [111, 15, 19, 6, 5, 44, 96, 88, 71]);
  assert.equal(si.timestamp, '2022-08-17T17:41:08');
  const std = decodeQr(rawText(sdkSample('Standard/Invoice/Standard_Invoice.xml').xml, RAW.qr));
  assert.deepEqual(std.tags.map(t => t[0]), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(std.vatTotal, '0.6', 'الوسم 5 نصّ الـXML كما كُتب لا 0.60');
  const fx = decodeQr(rawText(sdkSample('Standard/Invoice/Advance Payment adjustments with foreign currency invoice.xml').xml, RAW.qr));
  assert.equal(fx.vatTotal, '1068.75', 'الوسم 5 بعملة الضريبة SAR لا عملة المستند');
});
