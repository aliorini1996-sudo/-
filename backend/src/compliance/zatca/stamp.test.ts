// اختبارات Z2 للختم الكامل: لقطات Z1 الأربع بشهادة مبنيّة داخل الاختبار (ملتزَم)، ثم إعادة ختم عيّنات
// الـSDK الرسمية بمفتاحها وشهادتها (ذهبي، يتخطّى عند الغياب)، والمتغيّرات المرفوضة في التصميم.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { CsidCert, parseCsidCertificate } from './cert';
import {
  assertNoForeignSignature, c14nEscapeAttr, c14nEscapeText, canonicalize, compareCodepoints, computeInvoiceHash, hashExcludedElements,
  invoiceHashInput,
} from './c14n';
import { generateEgsKeyPair } from './crypto';
import { mapInvoiceToUbl } from './mapInvoice';
import { UblDocument } from './model';
import { QrError, buildPhase2Qr, decodeQr } from './qr';
import {
  HashSigner, StampError, StampErrorCode, createServerSigner, stampDocument, stampXml, unstampedForm, verifyStampedXml,
} from './stamp';
import { certDigest, embeddedSignedPropertiesString, locateSignatureSlots, signedPropertiesString } from './xades';
import { XmlDocument, XmlElement, XmlError, parseXml } from './xml';
import { serializeUnsigned } from './ubl';
import { SIMPLIFIED_INVOICE, STANDARD_INVOICE, STANDARD_CREDIT_NOTE, SIMPLIFIED_DEBIT_NOTE, chainFor } from './__fixtures__/z1-sources';
import { buildTestCert, newSecp256k1 } from './__fixtures__/z2-testcert';
import { RAW, SDK_SKIP, rawText, sdkCertB64, sdkPrivateKeyB64, sdkSamples } from './__fixtures__/z2-sdk';

// ─────────────────────────────────────────────────────────────────────────────
// تجهيز مشترك
// ─────────────────────────────────────────────────────────────────────────────

const TC = buildTestCert();
const CERT = parseCsidCertificate(TC.certB64);
const SIGNER = createServerSigner(TC.egsPrivateKey);
const NOW = new Date('2026-09-14T07:15:31.900Z'); // 10:15:31 بتوقيت الرياض

interface Snap { key: string; xml: string; doc: UblDocument; kind: 'standard' | 'simplified' }

const SNAPS: Snap[] = ([
  ['simplified-invoice', SIMPLIFIED_INVOICE, 1],
  ['standard-invoice', STANDARD_INVOICE, 2],
  ['standard-credit-note', STANDARD_CREDIT_NOTE, 3],
  ['simplified-debit-note', SIMPLIFIED_DEBIT_NOTE, 4],
] as const).map(([key, src, icv]) => {
  const doc = mapInvoiceToUbl(src, chainFor(icv));
  const xml = fs.readFileSync(path.join(__dirname, '__fixtures__', 'z1', `${key}.xml`), 'utf8').replace(/\r\n/g, '\n');
  return { key, xml, doc, kind: doc.typeName.startsWith('01') ? 'standard' as const : 'simplified' as const };
});

async function rejectsWith(p: Promise<unknown> | (() => unknown), code: StampErrorCode | 'XML' | 'QR', why?: string) {
  const run = typeof p === 'function' ? Promise.resolve().then(p) : p;
  await assert.rejects(run, (e: unknown) => {
    if (code === 'XML') assert.ok(e instanceof XmlError, `${why}: ${String(e)}`);
    else if (code === 'QR') assert.ok(e instanceof QrError, `${why}: ${String(e)}`);
    else {
      assert.ok(e instanceof StampError, `${why}: ${String(e)}`);
      assert.equal(e.code, code, `${why}: ${e.message}`);
    }
    return true;
  });
}

const SLOT_LINE = /<(ds:DigestValue|ds:SignatureValue|ds:X509Certificate|xades:SigningTime|ds:X509IssuerName|ds:X509SerialNumber|cbc:EmbeddedDocumentBinaryObject mimeCode="text\/plain")>/;

// ─────────────────────────────────────────────────────────────────────────────
// الختم الملتزَم (بلا SDK)
// ─────────────────────────────────────────────────────────────────────────────

test('ختم لقطات Z1 الأربع: التحقق الذاتي يمرّ، ولا يتغيّر إلا نصّ الخانات التسع داخل الكتل المحذوفة، والتجزئة ثابتة', async () => {
  assert.equal(SNAPS.length, 4);
  for (const s of SNAPS) {
    assert.equal(serializeUnsigned(s.doc), s.xml, `${s.key}: اللقطة = مُسلسِل Z1`);
    const r = await stampDocument(s.xml, s.doc, SIGNER, CERT, NOW, s.kind);
    assert.equal(r.signingTime, '2026-09-14T10:15:31', s.key);
    assert.equal(r.invoiceHash, computeInvoiceHash(s.xml), `${s.key}: تجزئة قبل الختم`);
    assert.equal(computeInvoiceHash(r.xml), r.invoiceHash, `${s.key}: تجزئة بعد الختم`);
    const { xml: _stamped, ...values } = r;
    assert.deepEqual(verifyStampedXml(r.xml, CERT, s.kind), values, `${s.key}: التحقق المستقل يعيد القيم نفسها`);
    assert.equal(unstampedForm(r.xml), s.xml, `${s.key}: إفراغ الخانات يعيد البايتات الأصلية`);

    // الفرق سطراً بسطر: تسعة أسطر خانات فقط، كلها داخل ext:UBLExtensions أو سطر QR
    const a = s.xml.split('\n'), b = r.xml.split('\n');
    assert.equal(a.length, b.length);
    const diff = a.map((_, i) => i).filter(i => a[i] !== b[i]);
    assert.equal(diff.length, 9, `${s.key}: ${diff.length} أسطر مختلفة`);
    const extEnd = a.indexOf('</ext:UBLExtensions>');
    for (const i of diff) {
      assert.match(a[i], SLOT_LINE, `${s.key} سطر ${i}`);
      assert.ok(i < extEnd || a[i].includes('EmbeddedDocumentBinaryObject'), `${s.key} سطر ${i} خارج الكتل`);
    }

    // التوقيع: ECDSA-SHA256 فوق 32 بايت التجزئة بمفتاح الشهادة
    assert.equal(crypto.verify('sha256', Buffer.from(r.invoiceHash, 'base64'), TC.egsPublicKey, Buffer.from(r.signatureB64, 'base64')), true);
    assert.equal(r.certDigest, certDigest(TC.certB64));

    // QR: الوسم 9 للمبسّطة فقط
    const q = decodeQr(r.qr);
    assert.equal(q.invoiceHash, r.invoiceHash);
    assert.equal(q.signatureB64, r.signatureB64);
    assert.deepEqual(Buffer.from(q.spkiDer!), TC.egsPublicKey.export({ type: 'spki', format: 'der' }));
    assert.equal(q.totalWithVat, s.doc.totals.payable);
    assert.equal(q.vatTotal, s.doc.totals.taxTotal);
    assert.equal(q.timestamp, `${s.doc.issueDate}T${s.doc.issueTime}`);
    if (s.kind === 'simplified') assert.deepEqual(Buffer.from(q.certSignatureDer!), TC.signatureDer, `${s.key}: الوسم 9`);
    else assert.equal(q.certSignatureDer, undefined, `${s.key}: لا وسم 9`);

    // ختم ثانٍ: التجزئة نفسها، والتوقيع عشوائي مختلف لكنه صحيح
    const r2 = await stampDocument(s.xml, s.doc, SIGNER, CERT, NOW, s.kind);
    assert.equal(r2.invoiceHash, r.invoiceHash);
    assert.equal(r2.signedPropertiesDigest, r.signedPropertiesDigest);
    assert.notEqual(r2.signatureB64, r.signatureB64);
  }
  const kinds = SNAPS.map(s => s.kind).sort();
  assert.deepEqual(kinds, ['simplified', 'simplified', 'standard', 'standard']);
});

test('العبث بعد الختم يُكشف: بايت في الجسم أو فراغ، تزوير التجزئة، وقت التوقيع، QR، الرقم التسلسلي، أو شهادة أخرى', async () => {
  const s = SNAPS[0];
  const { xml } = await stampDocument(s.xml, s.doc, SIGNER, CERT, NOW, s.kind);
  const expectVerify = (tampered: string, code: StampErrorCode, why: string) => {
    assert.notEqual(tampered, xml, why);
    assert.throws(() => verifyStampedXml(tampered, CERT, s.kind), (e: unknown) => e instanceof StampError && e.code === code, why);
  };
  const digest = rawText(xml, RAW.invoiceDigest);
  const body = xml.replace('عصير برتقال 1 لتر', 'عصير برتقال 2 لتر');
  expectVerify(body, 'SELF_CHECK_HASH', 'بايت في اسم صنف');
  expectVerify(xml.replace('\n    <cac:AccountingSupplierParty>', '\n     <cac:AccountingSupplierParty>'), 'SELF_CHECK_HASH', 'فراغ خارج الكتل');
  expectVerify(xml.replace(/(<cbc:PayableAmount currencyID="SAR">)[^<]*/, (_m, open: string) => `${open}9.99`), 'SELF_CHECK_HASH', 'مبلغ');
  // فراغ داخل وسم البداية لا يغيّر شيئاً: C14N يطبّعه — فهو ليس عبثاً بالمحتوى ويبقى التحقق ناجحاً
  const intraTag = xml.replace('<cbc:PayableAmount currencyID="SAR">', '<cbc:PayableAmount  currencyID="SAR" >');
  assert.notEqual(intraTag, xml);
  assert.equal(verifyStampedXml(intraTag, CERT, s.kind).invoiceHash, digest);
  // تزوير: جسم معدَّل + DigestValue محدَّث ⇒ التوقيع لا يتحقق
  expectVerify(body.replace(digest, computeInvoiceHash(body)), 'SELF_CHECK_SIGNATURE', 'تجزئة مزوّرة');
  // تزوير كامل بمفتاح آخر: التجزئة والتوقيع متّسقان لكن ليسا بمفتاح الشهادة
  const forged = computeInvoiceHash(body);
  const otherSig = crypto.sign('sha256', Buffer.from(forged, 'base64'), newSecp256k1().privateKey).toString('base64');
  expectVerify(body.replace(digest, forged).replace(rawText(xml, RAW.signatureValue), otherSig), 'SELF_CHECK_SIGNATURE', 'توقيع بمفتاح آخر');
  expectVerify(xml.replace('<xades:SigningTime>2026-09-14T10:15:31<', '<xades:SigningTime>2026-09-14T10:15:32<'), 'SELF_CHECK_SIGNED_PROPERTIES', 'SigningTime');
  const qr = decodeQr(rawText(xml, RAW.qr));
  const badQr = buildPhase2Qr({ ...qr, invoiceHash: qr.invoiceHash!, signatureB64: qr.signatureB64!, spkiDer: qr.spkiDer!, totalWithVat: '0.01' });
  expectVerify(xml.replace(rawText(xml, RAW.qr), badQr), 'SELF_CHECK_QR', 'QR بإجمالي مختلف');
  const noTag9 = buildPhase2Qr({ ...qr, invoiceHash: qr.invoiceHash!, signatureB64: qr.signatureB64!, spkiDer: qr.spkiDer!, certSignatureDer: undefined });
  expectVerify(xml.replace(rawText(xml, RAW.qr), noTag9), 'SELF_CHECK_QR', 'مبسّطة بلا وسم 9');
  expectVerify(xml.replace(CERT.serialDecimal, `${CERT.serialDecimal.slice(0, -1)}9`), 'SELF_CHECK_CERT', 'X509SerialNumber');
  // شهادة أخرى في التحقق
  const other = parseCsidCertificate(buildTestCert().certB64);
  assert.throws(() => verifyStampedXml(xml, other, s.kind), (e: unknown) => e instanceof StampError && e.code === 'SELF_CHECK_CERT');
  // نوع خاطئ في التحقق
  assert.throws(() => verifyStampedXml(xml, CERT, 'standard'), (e: unknown) => e instanceof StampError && e.code === 'KIND_MISMATCH');
});

test('زوج مفتاح/شهادة خاطئ يُرفض: مفتاح موقِّع مختلف، موقِّع بلا مفتاح عام معلن، publicKeyPem مبدَّل، وتوقيع ليس DER', async () => {
  const s = SNAPS[1];
  const wrongKey = createServerSigner(newSecp256k1().privateKey);
  await rejectsWith(stampDocument(s.xml, s.doc, wrongKey, CERT, NOW, s.kind), 'CERT_KEY_MISMATCH', 'مفتاح آخر');
  // موقِّع خارجي (KMS مثلاً) لا يعلن مفتاحه: التحقق الذاتي يلتقط الخطأ
  const opaque: HashSigner = { signHash: h => wrongKey.signHash(h) };
  await rejectsWith(stampDocument(s.xml, s.doc, opaque, CERT, NOW, s.kind), 'SELF_CHECK_SIGNATURE', 'موقِّع مجهول المفتاح');
  // ما يوقّعه الموقِّع هو 32 بايت التجزئة بالضبط
  let seen: Uint8Array | null = null;
  const spy: HashSigner = { publicKeySpkiDer: SIGNER.publicKeySpkiDer, signHash: async h => { seen = h; return SIGNER.signHash(h); } };
  const r = await stampDocument(s.xml, s.doc, spy, CERT, NOW, s.kind);
  assert.deepEqual(Buffer.from(seen!), Buffer.from(r.invoiceHash, 'base64'));
  const pemSwap: CsidCert = { ...CERT, publicKeyPem: newSecp256k1().publicKey.export({ type: 'spki', format: 'pem' }) as string };
  await rejectsWith(stampDocument(s.xml, s.doc, SIGNER, pemSwap, NOW, s.kind), 'CERT_KEY_MISMATCH', 'PEM مبدَّل');
  const spkiSwap: CsidCert = { ...CERT, spkiDer: Uint8Array.from(newSecp256k1().publicKey.export({ type: 'spki', format: 'der' })) };
  await rejectsWith(stampDocument(s.xml, s.doc, opaque, spkiSwap, NOW, s.kind), 'CERT_KEY_MISMATCH', 'SPKI مبدَّل');
  const garbage: HashSigner = { signHash: async () => Buffer.from('not a signature').toString('base64') };
  await rejectsWith(stampDocument(s.xml, s.doc, garbage, CERT, NOW, s.kind), 'SIGNER', 'توقيع غير DER');
  const throwing: HashSigner = { signHash: async () => { throw new Error('KMS down'); } };
  await rejectsWith(stampDocument(s.xml, s.doc, throwing, CERT, NOW, s.kind), 'SIGNER', 'فشل الموقِّع');
  // الشهادة خارج صلاحيتها وقت الختم
  const expired = parseCsidCertificate(buildTestCert({ subjectKey: TC.egsPrivateKey, notBefore: new Date('2024-01-01T00:00:00Z'), notAfter: new Date('2026-09-14T07:15:30Z') }).certB64);
  await rejectsWith(stampDocument(s.xml, s.doc, SIGNER, expired, NOW, s.kind), 'CERT_NOT_VALID', 'منتهية');
  const future = parseCsidCertificate(buildTestCert({ subjectKey: TC.egsPrivateKey, notBefore: new Date('2026-09-15T00:00:00Z') }).certB64);
  await rejectsWith(stampDocument(s.xml, s.doc, SIGNER, future, NOW, s.kind), 'CERT_NOT_VALID', 'لم تبدأ');
});

test('رفض ما لا يُختم: مستند مختوم مسبقاً، نوع مخالف، نموذج لا يطابق الـXML، توقيع غريب في الجسم، واسم بائع يتجاوز سقف QR', async () => {
  const s = SNAPS[0];
  const r = await stampDocument(s.xml, s.doc, SIGNER, CERT, NOW, s.kind);
  await rejectsWith(stampXml(r.xml, SIGNER, CERT, NOW, s.kind), 'SLOT_NOT_EMPTY', 'إعادة ختم');
  await rejectsWith(stampXml(s.xml.replace('<ds:SignatureValue></ds:SignatureValue>', '<ds:SignatureValue/>'), SIGNER, CERT, NOW, s.kind), 'SLOT_NOT_EMPTY', 'خانة ذاتية الإغلاق');
  await rejectsWith(stampDocument(s.xml, s.doc, SIGNER, CERT, NOW, 'standard'), 'KIND_MISMATCH', 'نوع');
  const mutate = (f: (d: UblDocument) => void) => { const d: UblDocument = JSON.parse(JSON.stringify(s.doc)); f(d); return d; };
  await rejectsWith(stampDocument(s.xml, mutate(d => { d.totals.payable = '1.00'; }), SIGNER, CERT, NOW, s.kind), 'DOC_MISMATCH', 'الإجمالي');
  await rejectsWith(stampDocument(s.xml, mutate(d => { d.id = 'INV-X'; }), SIGNER, CERT, NOW, s.kind), 'DOC_MISMATCH', 'الرقم');
  await rejectsWith(stampDocument(s.xml, mutate(d => { d.icv = 99; }), SIGNER, CERT, NOW, s.kind), 'DOC_MISMATCH', 'ICV');
  await rejectsWith(stampDocument(s.xml, mutate(d => { d.pih = 'x'; }), SIGNER, CERT, NOW, s.kind), 'DOC_MISMATCH', 'PIH');
  await rejectsWith(stampDocument(s.xml, mutate(d => { d.supplier.registrationName = 'غير'; }), SIGNER, CERT, NOW, s.kind), 'DOC_MISMATCH', 'اسم البائع');
  const foreign = s.xml.replace('<cbc:Name>', '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"/><cbc:Name>');
  await rejectsWith(stampXml(foreign, SIGNER, CERT, NOW, s.kind), 'XML_INVALID', 'توقيع غريب (بلا نموذج)');
  await rejectsWith(stampDocument(foreign, s.doc, SIGNER, CERT, NOW, s.kind), 'DOC_MISMATCH', 'توقيع غريب (مع نموذج: الـXML ليس تسلسله)');
  const longName = 'شركة '.repeat(22).trim(); // 197 بايت: ضمن حدّ الـTLV (255) ويتجاوز سقف 700 في المبسّطة
  assert.equal(Buffer.byteLength(longName), 197);
  const src = { ...SIMPLIFIED_INVOICE, seller: { ...SIMPLIFIED_INVOICE.seller, legalName: longName } };
  const longDoc = mapInvoiceToUbl(src, chainFor(1));
  await assert.rejects(stampDocument(serializeUnsigned(longDoc), longDoc, SIGNER, CERT, NOW, 'simplified'),
    (e: unknown) => e instanceof StampError && e.code === 'QR_TOO_LONG' && e.field === 'supplier.registrationName' && e.cause instanceof QrError && /> 700/.test(e.message));
  // والسقف قابل للتمرير صراحةً بعد حسم U1
  const ok = await stampDocument(serializeUnsigned(longDoc), longDoc, SIGNER, CERT, NOW, 'simplified', { qrMaxLength: 1000 });
  assert.ok(ok.qr.length > 700);
});

test('createServerSigner: PEM (SEC1/PKCS#8) وDER base64 وKeyObject على secp256k1 فقط، وتجزئة 32 بايت فقط', async () => {
  const { privateKeyPem, publicKeyPem } = generateEgsKeyPair();
  const key = crypto.createPrivateKey(privateKeyPem);
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  const forms: Array<string | Uint8Array | crypto.KeyObject> = [
    privateKeyPem,
    key.export({ type: 'pkcs8', format: 'pem' }) as string,
    (key.export({ type: 'sec1', format: 'der' }) as Buffer).toString('base64'),
    key.export({ type: 'pkcs8', format: 'der' }) as Buffer,
    key,
  ];
  const hash = crypto.randomBytes(32);
  for (const f of forms) {
    const signer = createServerSigner(f);
    assert.deepEqual(Buffer.from(signer.publicKeySpkiDer!), spki);
    const sig = await signer.signHash(hash);
    assert.equal(crypto.verify('sha256', hash, publicKeyPem, Buffer.from(sig, 'base64')), true);
  }
  assert.throws(() => createServerSigner(crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey), StampError);
  assert.throws(() => createServerSigner(crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey), StampError);
  assert.throws(() => createServerSigner(crypto.createPublicKey(publicKeyPem)), StampError);
  assert.throws(() => createServerSigner('not a key'), StampError);
  await rejectsWith(createServerSigner(key).signHash(new Uint8Array(31)), 'SIGNER', '31 بايت');
});

// ─────────────────────────────────────────────────────────────────────────────
// ذهبي: عيّنات الـSDK الرسمية
// ─────────────────────────────────────────────────────────────────────────────

/** يُفرغ خانات الختم التسع بتعابير نمطية على النص الخام (مستقل عن محلّلنا). */
function blankRaw(xml: string): string {
  let s = xml;
  for (const re of [RAW.invoiceDigest, RAW.signedPropertiesDigest, RAW.signatureValue, RAW.certificate, RAW.signingTime, RAW.certDigest, RAW.issuerName, RAW.serialNumber, RAW.qr]) {
    const m = re.exec(s)!;
    const at = m.index + m[0].lastIndexOf(`${m[1]}</`);
    assert.ok(m[1].length > 0 && at >= m.index);
    s = s.slice(0, at) + s.slice(at + m[1].length);
  }
  return s;
}

test('ذهبي (SDK 3.4.8): التحقق الكامل يمرّ على العيّنات الـ19 كما هي (توقيعات الهيئة تتحقق بمفتاح cert.pem)', { skip: SDK_SKIP }, () => {
  const cert = parseCsidCertificate(sdkCertB64());
  const samples = sdkSamples();
  assert.equal(samples.length, 19);
  for (const s of samples) {
    const v = verifyStampedXml(s.xml, cert, s.kind);
    assert.equal(v.invoiceHash, rawText(s.xml, RAW.invoiceDigest), s.rel);
    assert.equal(v.signedPropertiesDigest, rawText(s.xml, RAW.signedPropertiesDigest), s.rel);
    assert.equal(unstampedForm(s.xml), blankRaw(s.xml), `${s.rel}: الإفراغ بالمحلّل = الإفراغ النصّي`);
  }
});

test('ذهبي (SDK 3.4.8): إعادة ختم العيّنات الـ19 بمفتاح الـSDK وشهادته ووقتها ⇒ بايتات مطابقة عدا SignatureValue والوسم 7', { skip: SDK_SKIP }, async () => {
  const cert = parseCsidCertificate(sdkCertB64());
  const signer = createServerSigner(sdkPrivateKeyB64());
  assert.deepEqual(Buffer.from(signer.publicKeySpkiDer!), Buffer.from(cert.spkiDer));
  const samples = sdkSamples();
  assert.equal(samples.length, 19);
  for (const s of samples) {
    const t = rawText(s.xml, RAW.signingTime);
    const now = new Date(`${t}+03:00`);
    const r = await stampXml(blankRaw(s.xml), signer, cert, now, s.kind);
    const maskSig = (x: string, sig: string, qr: string) => x.replace(`<ds:SignatureValue>${sig}<`, '<ds:SignatureValue><').replace(`>${qr}</cbc:EmbeddedDocumentBinaryObject>`, '></cbc:EmbeddedDocumentBinaryObject>');
    assert.equal(
      maskSig(r.xml, r.signatureB64, r.qr),
      maskSig(s.xml, rawText(s.xml, RAW.signatureValue), rawText(s.xml, RAW.qr)),
      `${s.rel}: كل البايتات عدا التوقيع وQR`,
    );
    assert.equal(r.invoiceHash, rawText(s.xml, RAW.invoiceDigest), s.rel);
    assert.equal(r.signedPropertiesDigest, rawText(s.xml, RAW.signedPropertiesDigest), s.rel);
    assert.equal(r.certDigest, rawText(s.xml, RAW.certDigest), s.rel);
    assert.equal(r.signingTime, t, s.rel);
    const ours = decodeQr(r.qr), theirs = decodeQr(rawText(s.xml, RAW.qr));
    assert.deepEqual(ours.tags.map(x => x[0]), theirs.tags.map(x => x[0]), s.rel);
    for (let i = 0; i < ours.tags.length; i++) {
      if (ours.tags[i][0] === 7) continue;
      assert.deepEqual(Buffer.from(ours.tags[i][1]), Buffer.from(theirs.tags[i][1]), `${s.rel}: الوسم ${ours.tags[i][0]}`);
    }
    assert.equal(ours.signatureB64, r.signatureB64);
  }
});

/** C14N «حصري الطابع»: يُعلن النطاق فقط حيث يُستعمل ظاهرياً — المتغيّر المرفوض في C-S1. */
function exclusiveLike(doc: XmlDocument, excluded: ReadonlySet<XmlElement>): string {
  const out: string[] = [];
  const walk = (el: XmlElement, rendered: ReadonlyMap<string, string>) => {
    const used = new Map<string, string>([[el.prefix, el.ns]]);
    for (const a of el.attributes) if (a.prefix && a.prefix !== 'xml') used.set(a.prefix, a.ns);
    const decls = [...used].filter(([p, u]) => (rendered.get(p) ?? '') !== u).sort((x, y) => compareCodepoints(x[0], y[0]));
    const next = new Map(rendered);
    for (const [p, u] of decls) next.set(p, u);
    out.push('<', el.qname, ...decls.map(([p, u]) => (p ? ` xmlns:${p}="${c14nEscapeAttr(u)}"` : ` xmlns="${c14nEscapeAttr(u)}"`)));
    for (const a of [...el.attributes].sort((x, y) => compareCodepoints(x.ns, y.ns) || compareCodepoints(x.local, y.local))) out.push(' ', a.qname, '="', c14nEscapeAttr(a.value), '"');
    out.push('>');
    for (const c of el.children) {
      if (c.kind === 'text') out.push(c14nEscapeText(c.value));
      else if (c.kind === 'element' && !excluded.has(c)) walk(c, next);
    }
    out.push('</', el.qname, '>');
  };
  walk(doc.root, new Map());
  return out.join('');
}

test('ذهبي (SDK 3.4.8): المتغيّرات المرفوضة في التصميم لا تعيد إنتاج أي قيمة في أي عيّنة', { skip: SDK_SKIP }, () => {
  const cert = parseCsidCertificate(sdkCertB64());
  const sha = (b: string | Buffer) => crypto.createHash('sha256').update(b);
  let checked = 0;
  for (const s of sdkSamples()) {
    const expectedHash = rawText(s.xml, RAW.invoiceDigest);
    const doc = parseXml(s.xml);
    const excluded = new Set(hashExcludedElements(doc));
    const canonical = invoiceHashInput(doc);
    assert.equal(sha(canonical).digest('base64'), expectedHash, s.rel);
    // تجزئة الفاتورة
    const hashVariants: Record<string, string> = {
      'C14N حصري الطابع (يسقط xmlns:ext غير المستعمل)': sha(exclusiveLike(doc, excluded)).digest('base64'),
      'فراغات مجرَّدة': sha(canonical.toString('utf8').replace(/>\s+</g, '><')).digest('base64'),
      'hex ثم base64': Buffer.from(sha(canonical).digest('hex')).toString('base64'),
      'مع إعلان XML': sha(`<?xml version="1.0" encoding="UTF-8"?>\n${canonical.toString('utf8')}`).digest('base64'),
      'بلا حذف QR': sha(canonicalize(s.xml.replace(/<cac:AdditionalDocumentReference>\s*<cbc:ID>QR<\/cbc:ID>/, '<cac:AdditionalDocumentReference><cbc:ID>QR-kept</cbc:ID>')).replace(/<ext:UBLExtensions>[\s\S]*<\/ext:UBLExtensions>/, '').replace(/<cac:Signature>[\s\S]*?<\/cac:Signature>/, '')).digest('base64'),
      'C14N للمستند كاملاً بلا حذف': sha(canonicalize(s.xml)).digest('base64'),
    };
    const exclusiveRoot = exclusiveLike(doc, excluded).slice(0, exclusiveLike(doc, excluded).indexOf('>') + 1);
    assert.ok(!exclusiveRoot.includes('xmlns:ext=') && canonical.toString('utf8').startsWith('<Invoice') && canonical.toString('utf8').slice(0, 400).includes('xmlns:ext='), 'الفرق الجوهري: xmlns:ext على الجذر');
    for (const [why, h] of Object.entries(hashVariants)) assert.notEqual(h, expectedHash, `${s.rel}: ${why}`);

    // التوقيع: فوق 32 بايت التجزئة فقط
    const sig = Buffer.from(rawText(s.xml, RAW.signatureValue), 'base64');
    const pub = cert.publicKeyPem;
    assert.equal(crypto.verify('sha256', Buffer.from(expectedHash, 'base64'), pub, sig), true, `${s.rel}: الصحيح`);
    // prehash: e = التجزئة نفسها بلا SHA-256 ثانٍ ≡ توقيع SHA256withECDSA فوق بايتات C14N
    assert.equal(crypto.verify('sha256', canonical, pub, sig), false, `${s.rel}: prehash`);
    assert.equal(crypto.verify('sha256', Buffer.from(expectedHash, 'utf8'), pub, sig), false, `${s.rel}: نصّ base64`);
    assert.equal(crypto.verify('sha256', Buffer.from(Buffer.from(expectedHash, 'base64').toString('hex'), 'utf8'), pub, sig), false, `${s.rel}: نصّ hex`);

    // SignedProperties: الحرفية بمسافاتها ودفع النطاقات، لا C14N ولا linearize ولا base64 خام
    const expectedSp = rawText(s.xml, RAW.signedPropertiesDigest);
    const t = rawText(s.xml, RAW.signingTime);
    const spString = signedPropertiesString(t, certDigest(cert.certB64), cert.issuerName, cert.serialDecimal);
    const slots = locateSignatureSlots(assertNoForeignSignature(doc).dsSignature);
    assert.equal(embeddedSignedPropertiesString(doc, slots), spString);
    const hexB64 = (x: string) => Buffer.from(sha(x).digest('hex')).toString('base64');
    assert.equal(hexB64(spString), expectedSp, s.rel);
    const spVariants: Record<string, string> = {
      'base64 خام': sha(spString).digest('base64'),
      'linearize (بلا مسافات بين الوسوم)': hexB64(spString.replace(/>\s+</g, '><')),
      'بلا دفع النطاقات': hexB64(doc.source.slice(slots.signedProperties.start, slots.signedProperties.end)),
      'C14N للكتلة (وسوم إغلاق صريحة)': hexB64(canonicalize(spString)),
    };
    for (const [why, h] of Object.entries(spVariants)) assert.notEqual(h, expectedSp, `${s.rel}: SignedProperties ${why}`);

    // CertDigest: فوق نصّ base64 لا بايتات DER
    const expectedCd = rawText(s.xml, RAW.certDigest);
    assert.notEqual(Buffer.from(sha(Buffer.from(cert.certB64, 'base64')).digest('hex')).toString('base64'), expectedCd, 'CertDigest فوق DER');
    assert.notEqual(sha(cert.certB64).digest('base64'), expectedCd, 'CertDigest base64 خام');
    checked++;
  }
  assert.equal(checked, 19);
});
