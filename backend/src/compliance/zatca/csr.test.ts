// اختبارات Z4 لطلب توقيع الشهادة (CSR): البناء بقيم مثال الـSDK ثم الفكّ بـder.ts مستقلاً ومطابقة كل حقل ووسم نوعه
// وترتيبه مع عيّنة CSR الرسمية (Swagger، __fixtures__/z3/compliance-request.json) عدا المفتاح العام والتوقيع؛
// التوقيع فوق CertificationRequestInfo؛ كل قاعدة تحقّق ترفض باسم حقلها؛ القالب لكل بيئة؛ csrBodyForApi؛
// واختبار ذهبي بملف إعدادات الـSDK المحلي ومفتاحه (يُتخطّى عند غيابهما). كل المفاتيح تُولَّد وقت التشغيل.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { FatooraEnv } from './api';
import {
  CERTIFICATE_TEMPLATE_NAMES, CSR_COUNTRY, CSR_FORBIDDEN_CHARACTERS, CSR_MAX_CHARS, CSR_OID, CsrError, CsrErrorCode, CsrParamReason, CsrParams,
  assembleCsrPem, assertZatcaCsr, buildCertificationRequestInfo, buildCsr, csrBodyForApi, egsCommonName, egsSerialNumber, parseCsr,
  validateCsrParams,
} from './csr';
import {
  DerNode, TAG, childrenOf, decodeBitString, decodeInteger, decodeOid, decodeString, encBitString, encBoolean, encContext, encInteger,
  encOctetString, encOid, encPrintableString, encSequence, encSet, encUtf8String, expectTag, parseDer,
} from './der';
import { SDK_DIR } from './__fixtures__/z2-sdk';

// ─────────────────────────────────────────────────────────────────────────────
// تجهيز
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', 'z3', 'compliance-request.json'), 'utf8')) as {
  csrPem: string;
  body: { csr: string };
};
const OFFICIAL_PEM = FIXTURE.csrPem;

/** قيم مثال الـSDK وعيّنة Swagger نفسها (عامة، منشورة في وثائق الهيئة). */
const SDK_LIKE: CsrParams = Object.freeze({
  env: 'production',
  commonName: 'TST-886431145-399999999900003',
  serialNumber: '1-TST|2-TST|3-ed22f1d8-e6a2-1118-9b58-d9a8f11e445f',
  orgName: 'Maximum Speed Tech Supply LTD',
  orgUnit: 'Riyadh Branch',
  vatNumber: '399999999900003',
  functionMap: '1100',
  locationAddress: 'RRRD2929',
  industry: 'Supply activities',
}) as CsrParams;

const newK1 = () => crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
const KEYS = newK1();

const UTF8 = TAG.UTF8_STRING;
const PRINTABLE = TAG.PRINTABLE_STRING;

function expectCsrError(fn: () => unknown, code: CsrErrorCode, field?: string, reason?: CsrParamReason, why = ''): CsrError {
  let caught: CsrError | undefined;
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof CsrError, `${why}: ${String(e)}`);
    assert.equal(e.code, code, `${why}: ${e.message}`);
    if (field !== undefined) assert.equal(e.field, field, `${why}: ${e.message}`);
    if (reason !== undefined) assert.equal(e.reason, reason, `${why}: ${e.message}`);
    caught = e;
    return true;
  }, why ? `لم يُرمَ خطأ ${code}: ${why}` : undefined);
  return caught!;
}

const pemToDer = (pem: string) => Buffer.from(pem.replace(/-----(BEGIN|END) CERTIFICATE REQUEST-----/g, '').replace(/\s+/g, ''), 'base64');

// ─────────────────────────────────────────────────────────────────────────────
// فكّ مستقل بـder.ts (لا يمرّ بـparseCsr) — كل عقدة بوسمها وترتيبها
// ─────────────────────────────────────────────────────────────────────────────

interface Atv { oid: string; tag: number; value: string }

interface Decoded {
  criRaw: Buffer;
  version: bigint;
  subject: Atv[];
  spkiRaw: Buffer;
  spkiAlg: string[];
  pointLength: number;
  attrsTag: number;
  attributes: Array<{ oid: string; valueCount: number }>;
  extensions: Array<{ oid: string; parts: number; valueDer: Buffer }>;
  templateName: Atv;
  sanGeneralNames: number[];
  san: Atv[];
  sigAlgRaw: Buffer;
  sigAlg: string[];
  signature: Buffer;
  topLevel: number[];
}

function decodeName(node: DerNode): Atv[] {
  return childrenOf(expectTag(node, TAG.SEQUENCE, 'Name')).map(set => {
    const atvs = childrenOf(expectTag(set, TAG.SET, 'RDN'));
    assert.equal(atvs.length, 1, 'كل RDN بقيمة واحدة');
    const [oid, value] = childrenOf(expectTag(atvs[0], TAG.SEQUENCE, 'ATV'));
    return { oid: decodeOid(oid), tag: value.tag, value: decodeString(value) };
  });
}

function decodeIndependently(pem: string): Decoded {
  const der = pemToDer(pem);
  const root = parseDer(der);
  const top = childrenOf(expectTag(root, TAG.SEQUENCE, 'CertificationRequest'));
  const [cri, sigAlg, sig] = top;
  const criParts = childrenOf(expectTag(cri, TAG.SEQUENCE, 'CRI'));
  assert.equal(criParts.length, 4);
  const spkiParts = childrenOf(expectTag(criParts[2], TAG.SEQUENCE, 'SPKI'));
  const attrs = criParts[3];
  const attributes = childrenOf(attrs).map(a => {
    const [oid, set] = childrenOf(expectTag(a, TAG.SEQUENCE, 'Attribute'));
    return { oid: decodeOid(oid), valueCount: childrenOf(expectTag(set, TAG.SET, 'values')).length, set };
  });
  const extReq = attributes.find(a => a.oid === CSR_OID.EXTENSION_REQUEST);
  assert.ok(extReq, 'extensionRequest موجود');
  const exts = childrenOf(expectTag(childrenOf(extReq.set)[0], TAG.SEQUENCE, 'Extensions')).map(e => {
    const parts = childrenOf(expectTag(e, TAG.SEQUENCE, 'Extension'));
    return { oid: decodeOid(parts[0]), parts: parts.length, valueDer: Buffer.from(expectTag(parts[parts.length - 1], TAG.OCTET_STRING, 'extnValue').value) };
  });
  const tmplNode = parseDer(exts.find(e => e.oid === CSR_OID.CERTIFICATE_TEMPLATE_NAME)!.valueDer);
  const sanNode = childrenOf(expectTag(parseDer(exts.find(e => e.oid === CSR_OID.SUBJECT_ALT_NAME)!.valueDer), TAG.SEQUENCE, 'GeneralNames'));
  const dirName = childrenOf(sanNode[0]);
  assert.equal(dirName.length, 1, 'directoryName [4] EXPLICIT يلفّ Name واحداً');
  return {
    criRaw: Buffer.from(cri.raw),
    version: decodeInteger(criParts[0]),
    subject: decodeName(criParts[1]),
    spkiRaw: Buffer.from(criParts[2].raw),
    spkiAlg: childrenOf(spkiParts[0]).map(decodeOid),
    pointLength: decodeBitString(spkiParts[1]).bytes.length,
    attrsTag: attrs.tag,
    attributes: attributes.map(({ oid, valueCount }) => ({ oid, valueCount })),
    extensions: exts,
    templateName: { oid: CSR_OID.CERTIFICATE_TEMPLATE_NAME, tag: tmplNode.tag, value: decodeString(tmplNode) },
    sanGeneralNames: sanNode.map(n => n.tag),
    san: decodeName(dirName[0]),
    sigAlgRaw: Buffer.from(sigAlg.raw),
    sigAlg: childrenOf(sigAlg).map(decodeOid),
    signature: Buffer.from(decodeBitString(sig).bytes),
    topLevel: top.map(n => n.tag),
  };
}

/** CertificationRequestInfo بعد استبدال SubjectPublicKeyInfo بعلامة ثابتة (للمقارنة البايتية عدا المفتاح). */
function criWithoutSpki(d: Decoded): string {
  const i = d.criRaw.indexOf(d.spkiRaw);
  assert.ok(i > 0, 'SPKI داخل CRI');
  return `${d.criRaw.subarray(0, i).toString('hex')}<SPKI>${d.criRaw.subarray(i + d.spkiRaw.length).toString('hex')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// الترميز مقابل العيّنة الرسمية
// ─────────────────────────────────────────────────────────────────────────────

test('العيّنة الرسمية نفسها: تُفكّ بالفاكّ المستقل وبـparseCsr، وتوقيعها يتحقق (سلامة أدوات الاختبار)', () => {
  const off = decodeIndependently(OFFICIAL_PEM);
  assert.deepEqual(off.subject, [
    { oid: CSR_OID.COUNTRY, tag: PRINTABLE, value: 'SA' },
    { oid: CSR_OID.ORG_UNIT, tag: UTF8, value: 'Riyadh Branch' },
    { oid: CSR_OID.ORG, tag: UTF8, value: 'Maximum Speed Tech Supply LTD' },
    { oid: CSR_OID.COMMON_NAME, tag: UTF8, value: 'TST-886431145-399999999900003' },
  ]);
  assert.deepEqual(off.templateName, { oid: CSR_OID.CERTIFICATE_TEMPLATE_NAME, tag: UTF8, value: 'ZATCA-Code-Signing' });
  const parsed = parseCsr(OFFICIAL_PEM);
  assert.equal(parsed.signatureValid, true);
  assert.deepEqual(parsed.subject, off.subject);
  assert.deepEqual(parsed.subjectAltName, off.san);
  assert.equal(parsed.fields.vatNumber, '399999999900003');
});

test('buildCsr بقيم مثال الـSDK ⇒ كل حقل ووسم نوعه وترتيبه يطابق العيّنة الرسمية، وCRI بايتاً بايتاً عدا المفتاح العام', () => {
  const pem = buildCsr(SDK_LIKE, KEYS.privateKey);
  const ours = decodeIndependently(pem);
  const off = decodeIndependently(OFFICIAL_PEM);

  // CertificationRequest: SEQUENCE { CRI SEQUENCE, AlgorithmIdentifier SEQUENCE, BIT STRING }
  assert.deepEqual(ours.topLevel, [TAG.SEQUENCE, TAG.SEQUENCE, TAG.BIT_STRING]);
  assert.deepEqual(ours.topLevel, off.topLevel);
  assert.equal(ours.version, BigInt(0));
  assert.equal(ours.version, off.version);

  // subject: C (PrintableString) ← OU ← O ← CN (UTF8String) بهذا الترتيب
  assert.deepEqual(ours.subject, [
    { oid: '2.5.4.6', tag: PRINTABLE, value: 'SA' },
    { oid: '2.5.4.11', tag: UTF8, value: SDK_LIKE.orgUnit },
    { oid: '2.5.4.10', tag: UTF8, value: SDK_LIKE.orgName },
    { oid: '2.5.4.3', tag: UTF8, value: SDK_LIKE.commonName },
  ]);
  assert.deepEqual(ours.subject, off.subject);

  // المفتاح: id-ecPublicKey + secp256k1، نقطة غير مضغوطة 65 بايت
  assert.deepEqual(ours.spkiAlg, ['1.2.840.10045.2.1', '1.3.132.0.10']);
  assert.deepEqual(ours.spkiAlg, off.spkiAlg);
  assert.equal(ours.pointLength, 65);
  assert.deepEqual(ours.spkiRaw, Buffer.from(KEYS.publicKey.export({ type: 'spki', format: 'der' })));

  // السمات [0] IMPLICIT: extensionRequest وحده بقيمة واحدة
  assert.equal(ours.attrsTag, 0xa0);
  assert.equal(ours.attrsTag, off.attrsTag);
  assert.deepEqual(ours.attributes, [{ oid: '1.2.840.113549.1.9.14', valueCount: 1 }]);
  assert.deepEqual(ours.attributes, off.attributes);

  // الامتدادات: القالب ثم subjectAltName، كلاهما غير حرج (عنصران بلا BOOLEAN)
  assert.deepEqual(ours.extensions.map(e => [e.oid, e.parts]), [['1.3.6.1.4.1.311.20.2', 2], ['2.5.29.17', 2]]);
  assert.deepEqual(ours.extensions.map(e => [e.oid, e.parts]), off.extensions.map(e => [e.oid, e.parts]));
  assert.deepEqual(ours.extensions.map(e => e.valueDer), off.extensions.map(e => e.valueDer), 'قيم الامتدادين بايتاً بايتاً');
  assert.deepEqual(ours.templateName, { oid: '1.3.6.1.4.1.311.20.2', tag: UTF8, value: 'ZATCA-Code-Signing' });
  assert.deepEqual(ours.templateName, off.templateName);

  // SAN: GeneralName واحد [4] directoryName، وSN/UID/title/registeredAddress/businessCategory كلها UTF8String بالترتيب
  assert.deepEqual(ours.sanGeneralNames, [0xa4]);
  assert.deepEqual(ours.sanGeneralNames, off.sanGeneralNames);
  assert.deepEqual(ours.san, [
    { oid: '2.5.4.4', tag: UTF8, value: SDK_LIKE.serialNumber },
    { oid: '0.9.2342.19200300.100.1.1', tag: UTF8, value: SDK_LIKE.vatNumber },
    { oid: '2.5.4.12', tag: UTF8, value: '1100' },
    { oid: '2.5.4.26', tag: UTF8, value: SDK_LIKE.locationAddress },
    { oid: '2.5.4.15', tag: UTF8, value: SDK_LIKE.industry },
  ]);
  assert.deepEqual(ours.san, off.san);

  // خوارزمية التوقيع: ecdsa-with-SHA256 بلا معاملات — بايتاً بايتاً
  assert.deepEqual(ours.sigAlg, ['1.2.840.10045.4.3.2']);
  assert.equal(ours.sigAlgRaw.toString('hex'), '300a06082a8648ce3d040302');
  assert.deepEqual(ours.sigAlgRaw, off.sigAlgRaw);

  // CRI كاملة بايتاً بايتاً عدا SPKI (طول SPKI ثابت 88 بايت فالأطوال المحيطة متطابقة أيضاً)
  assert.equal(ours.spkiRaw.length, 88);
  assert.equal(off.spkiRaw.length, 88);
  assert.equal(criWithoutSpki(ours), criWithoutSpki(off));
  assert.equal(ours.criRaw.length, off.criRaw.length);

  // parseCsr يتّفق مع الفاكّ المستقل
  const parsed = parseCsr(pem);
  assert.deepEqual(parsed.subject, ours.subject);
  assert.deepEqual(parsed.subjectAltName, ours.san);
  assert.deepEqual(parsed.templateName, { tag: UTF8, value: 'ZATCA-Code-Signing' });
  assert.deepEqual(parsed.fields, {
    country: 'SA', orgUnit: SDK_LIKE.orgUnit, orgName: SDK_LIKE.orgName, commonName: SDK_LIKE.commonName,
    serialNumber: SDK_LIKE.serialNumber, vatNumber: SDK_LIKE.vatNumber, functionMap: '1100', locationAddress: SDK_LIKE.locationAddress,
    industry: SDK_LIKE.industry, templateName: 'ZATCA-Code-Signing',
  });
  assert.equal(parsed.version, 0);
  assert.equal(parsed.publicKeyAlgorithmOid, CSR_OID.EC_PUBLIC_KEY);
  assert.equal(parsed.publicKeyCurveOid, CSR_OID.SECP256K1);
  assert.deepEqual(parsed.extensions.map(e => e.critical), [false, false]);
});

test('التوقيع: ECDSA-SHA256 فوق بايتات CertificationRequestInfo يتحقق بالمفتاح العام، ويفشل بمفتاح آخر أو بعد العبث', () => {
  const pem = buildCsr(SDK_LIKE, KEYS.privateKey);
  const d = decodeIndependently(pem);
  assert.equal(crypto.verify('sha256', d.criRaw, KEYS.publicKey, d.signature), true);
  const embedded = crypto.createPublicKey({ key: d.spkiRaw, format: 'der', type: 'spki' });
  assert.equal(crypto.verify('sha256', d.criRaw, embedded, d.signature), true);
  assert.equal(crypto.verify('sha256', d.criRaw, newK1().publicKey, d.signature), false, 'مفتاح آخر');
  // التوقيع ECDSA-Sig-Value بصيغة DER: SEQUENCE { INTEGER r, INTEGER s }
  const sig = childrenOf(expectTag(parseDer(d.signature), TAG.SEQUENCE, 'ECDSA-Sig-Value'));
  assert.deepEqual(sig.map(n => n.tag), [TAG.INTEGER, TAG.INTEGER]);
  // التوقيع لا يغطي غلاف PEM أو الخوارزمية بل CRI وحدها
  assert.equal(crypto.verify('sha256', pemToDer(pem), KEYS.publicKey, d.signature), false);

  // عبث ببايت داخل قيمة CN في CRI (الطول نفسه) ⇒ بنية صالحة وتوقيع باطل
  const der = pemToDer(pem);
  const at = der.indexOf(Buffer.from(SDK_LIKE.commonName, 'utf8'));
  assert.ok(at > 0);
  der[at] ^= 0x01;
  const tampered = assembleRawPem(der);
  const p = parseCsr(tampered);
  assert.equal(p.signatureValid, false);
  assert.notEqual(p.fields.commonName, SDK_LIKE.commonName);

  // كل استدعاء بتوقيع جديد (k عشوائي) والحقول نفسها
  const again = decodeIndependently(buildCsr(SDK_LIKE, KEYS.privateKey));
  assert.deepEqual(again.criRaw, d.criRaw, 'CRI حتمية للمدخلات والمفتاح نفسيهما');
  assert.notDeepEqual(again.signature, d.signature);
});

function assembleRawPem(der: Buffer): string {
  return `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;
}

test('صيغة PEM كالعيّنة: أسطر 64 محرفاً وLF وسطر أخير؛ csrBodyForApi = base64 لنصّ PEM كاملاً (يطابق جسم Swagger الرسمي)', () => {
  const pem = buildCsr(SDK_LIKE, KEYS.privateKey);
  assert.ok(pem.startsWith('-----BEGIN CERTIFICATE REQUEST-----\n'));
  assert.ok(pem.endsWith('\n-----END CERTIFICATE REQUEST-----\n'));
  assert.ok(!pem.includes('\r'));
  const lines = pem.trimEnd().split('\n').slice(1, -1);
  lines.slice(0, -1).forEach(l => assert.equal(l.length, 64));
  assert.ok(lines[lines.length - 1].length <= 64);
  // عيّنة Swagger بطول 64 أيضاً ⇒ الغلاف نفسه
  const offLines = OFFICIAL_PEM.trimEnd().split('\n').slice(1, -1);
  offLines.slice(0, -1).forEach(l => assert.equal(l.length, 64));

  // الجسم الرسمي في Swagger هو base64 لنصّ PEM الرسمي حرفياً
  assert.equal(csrBodyForApi(OFFICIAL_PEM), FIXTURE.body.csr);
  const body = csrBodyForApi(pem);
  assert.match(body, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), pem);
  assert.ok(Buffer.from(body, 'base64').toString('utf8').startsWith('-----BEGIN CERTIFICATE REQUEST-----'), 'يشمل سطر BEGIN');

  // csrBodyForApi يرفض ما ليس CSR بدل ترميزه أعمى
  for (const bad of ['', 'hello', pem.replace(/CERTIFICATE REQUEST/g, 'CERTIFICATE'), pem.slice(0, 120), `${pem}extra`, 42 as unknown as string]) {
    expectCsrError(() => csrBodyForApi(bad), 'INVALID_CSR', 'csrPem');
  }
});

test('اسم القالب لكل بيئة (UTF8String): sandbox=TSTZATCA (UNVERIFIED) · simulation=PREZATCA · production=ZATCA — وبقية الحقول لا تتغيّر', () => {
  assert.deepEqual({ ...CERTIFICATE_TEMPLATE_NAMES }, {
    sandbox: 'TSTZATCA-Code-Signing', simulation: 'PREZATCA-Code-Signing', production: 'ZATCA-Code-Signing',
  });
  assert.ok(Object.isFrozen(CERTIFICATE_TEMPLATE_NAMES));
  const base = decodeIndependently(buildCsr(SDK_LIKE, KEYS.privateKey));
  for (const env of ['sandbox', 'simulation', 'production'] as FatooraEnv[]) {
    const d = decodeIndependently(buildCsr({ ...SDK_LIKE, env }, KEYS.privateKey));
    assert.deepEqual(d.templateName, { oid: CSR_OID.CERTIFICATE_TEMPLATE_NAME, tag: UTF8, value: CERTIFICATE_TEMPLATE_NAMES[env] }, env);
    assert.equal(parseCsr(buildCsr({ ...SDK_LIKE, env }, KEYS.privateKey)).fields.templateName, CERTIFICATE_TEMPLATE_NAMES[env]);
    assert.deepEqual(d.subject, base.subject, env);
    assert.deepEqual(d.san, base.san, env);
  }
});

test('خريطة الوظائف في title كما هي (1000/0100/1100)، ونصوص عربية تُرمَّز UTF8String وتُفكّ حرفياً', () => {
  for (const functionMap of ['1000', '0100', '1100'] as const) {
    const d = decodeIndependently(buildCsr({ ...SDK_LIKE, functionMap }, KEYS.privateKey));
    assert.deepEqual(d.san.find(x => x.oid === CSR_OID.TITLE), { oid: CSR_OID.TITLE, tag: UTF8, value: functionMap });
  }
  const arabic: CsrParams = {
    ...SDK_LIKE,
    orgName: 'شركة التوزيع الميداني التجريبية المحدودة',
    orgUnit: 'فرع الرياض',
    locationAddress: 'RRRD2929 طريق الأمير سلطان، المحمدية',
    industry: 'تجارة الجملة والتوزيع',
  };
  const d = decodeIndependently(buildCsr(arabic, KEYS.privateKey));
  assert.deepEqual(d.subject.map(x => [x.tag, x.value]), [[PRINTABLE, 'SA'], [UTF8, arabic.orgUnit], [UTF8, arabic.orgName], [UTF8, arabic.commonName]]);
  assert.equal(d.san.find(x => x.oid === CSR_OID.REGISTERED_ADDRESS)!.value, arabic.locationAddress);
  assert.equal(d.san.find(x => x.oid === CSR_OID.BUSINESS_CATEGORY)!.value, arabic.industry);
  // الحدّ بنقاط يونيكود لا بالبايتات: 64 محرفاً عربياً (128 بايت UTF-8) مقبولة
  const long = 'ع'.repeat(CSR_MAX_CHARS.orgName);
  assert.equal(Buffer.byteLength(long), 128);
  assert.equal(parseCsr(buildCsr({ ...SDK_LIKE, orgName: long }, KEYS.privateKey)).fields.orgName, long);
});

// ─────────────────────────────────────────────────────────────────────────────
// قواعد التحقق — كل قاعدة ترفض باسم حقلها وسببها، قبل أي استعمال للمفتاح
// ─────────────────────────────────────────────────────────────────────────────

type Case = [why: string, patch: Record<string, unknown>, field: string, reason: CsrParamReason];

const VALIDATION_CASES: Case[] = [
  // env
  ['env مفقودة', { env: undefined }, 'env', 'REQUIRED'],
  ['env مجهولة', { env: 'dev' }, 'env', 'FORMAT'],
  ['env بحالة أحرف مختلفة', { env: 'Production' }, 'env', 'FORMAT'],
  ['env خاصية موروثة', { env: 'toString' }, 'env', 'FORMAT'],
  ['env __proto__', { env: '__proto__' }, 'env', 'FORMAT'],
  // الرقم الضريبي: 15 رقماً يبدأ وينتهي بـ3
  ['VAT مفقود', { vatNumber: undefined }, 'vatNumber', 'REQUIRED'],
  ['VAT فارغ', { vatNumber: '' }, 'vatNumber', 'REQUIRED'],
  ['VAT 14 رقماً', { vatNumber: '39999999990003' }, 'vatNumber', 'FORMAT'],
  ['VAT 16 رقماً', { vatNumber: '3999999999000003' }, 'vatNumber', 'FORMAT'],
  ['VAT يبدأ بغير 3', { vatNumber: '299999999900003' }, 'vatNumber', 'FORMAT'],
  ['VAT ينتهي بغير 3', { vatNumber: '399999999900002' }, 'vatNumber', 'FORMAT'],
  ['VAT بحرف', { vatNumber: '39999999990000A' }, 'vatNumber', 'FORMAT'],
  ['VAT بأرقام عربية', { vatNumber: '٣٩٩٩٩٩٩٩٩٩٠٠٠٠٣' }, 'vatNumber', 'FORMAT'],
  ['VAT بفراغ', { vatNumber: ' 399999999900003' }, 'vatNumber', 'FORMAT'],
  ['VAT رقم لا نص', { vatNumber: 399999999900003 }, 'vatNumber', 'REQUIRED'],
  // خريطة الوظائف
  ['functionMap مفقودة', { functionMap: undefined }, 'functionMap', 'REQUIRED'],
  ['functionMap أصفار', { functionMap: '0000' }, 'functionMap', 'FORMAT'],
  ['functionMap خانات محجوزة', { functionMap: '1110' }, 'functionMap', 'FORMAT'],
  ['functionMap 1111', { functionMap: '1111' }, 'functionMap', 'FORMAT'],
  ['functionMap قصيرة', { functionMap: '11' }, 'functionMap', 'FORMAT'],
  ['functionMap رقم', { functionMap: 1100 }, 'functionMap', 'REQUIRED'],
  // الرقم التسلسلي
  ['SN مفقود', { serialNumber: undefined }, 'serialNumber', 'REQUIRED'],
  ['SN بلا صيغة', { serialNumber: 'EGS-1' }, 'serialNumber', 'FORMAT'],
  ['SN بلا الجزء 3', { serialNumber: '1-TST|2-TST' }, 'serialNumber', 'FORMAT'],
  ['SN جزء فارغ', { serialNumber: '1-|2-TST|3-x' }, 'serialNumber', 'FORMAT'],
  ['SN بترتيب خاطئ', { serialNumber: '2-TST|1-TST|3-x' }, 'serialNumber', 'FORMAT'],
  ['SN 65 محرفاً', { serialNumber: `1-TST|2-TST|3-${'a'.repeat(51)}` }, 'serialNumber', 'TOO_LONG'],
  ['SN بـ=', { serialNumber: '1-TST|2-TST|3-a=b' }, 'serialNumber', 'FORBIDDEN_CHARACTER'],
  ['SN بفراغ لاحق', { serialNumber: `${SDK_LIKE.serialNumber} ` }, 'serialNumber', 'WHITESPACE'],
  ['SN بسطر جديد', { serialNumber: '1-TST|2-TST|3-a\nb' }, 'serialNumber', 'CONTROL_CHARACTER'],
  ['SN بعلامة RLM', { serialNumber: '1-TST|2-TST|3-a\u{200f}b' }, 'serialNumber', 'CONTROL_CHARACTER'],
  ['SN بـZWSP', { serialNumber: '1-TST|2-TST\u{200b}|3-ab' }, 'serialNumber', 'CONTROL_CHARACTER'],
  // OU لمجموعة ضريبية (الخانة 11 = 1)
  ['مجموعة ضريبية واسم فرع', { vatNumber: '399999999910003', orgUnit: 'Riyadh Branch' }, 'orgUnit', 'VAT_GROUP_TIN'],
  ['مجموعة ضريبية و11 رقماً', { vatNumber: '399999999910003', orgUnit: '12345678901' }, 'orgUnit', 'VAT_GROUP_TIN'],
  ['مجموعة ضريبية و9 أرقام', { vatNumber: '399999999910003', orgUnit: '123456789' }, 'orgUnit', 'VAT_GROUP_TIN'],
  ['مجموعة ضريبية وأرقام عربية', { vatNumber: '399999999910003', orgUnit: '١٢٣٤٥٦٧٨٩٠' }, 'orgUnit', 'VAT_GROUP_TIN'],
  // الموقع ≤ 64
  ['الموقع 65 محرفاً', { locationAddress: 'R'.repeat(65) }, 'locationAddress', 'TOO_LONG'],
  // أطوال البقية
  ['CN 65', { commonName: 'C'.repeat(65) }, 'commonName', 'TOO_LONG'],
  ['O 65', { orgName: 'O'.repeat(65) }, 'orgName', 'TOO_LONG'],
  ['OU 65', { orgUnit: 'U'.repeat(65) }, 'orgUnit', 'TOO_LONG'],
  ['القطاع 129', { industry: 'I'.repeat(129) }, 'industry', 'TOO_LONG'],
  // غير فارغة
  ...(['commonName', 'orgName', 'orgUnit', 'locationAddress', 'industry'] as const).flatMap((f): Case[] => [
    [`${f} مفقود`, { [f]: undefined }, f, 'REQUIRED'],
    [`${f} فارغ`, { [f]: '' }, f, 'REQUIRED'],
    [`${f} فراغات فقط`, { [f]: '   ' }, f, 'REQUIRED'],
    [`${f} ليس نصاً`, { [f]: 7 }, f, 'REQUIRED'],
    [`${f} فراغ بادئ`, { [f]: ' Riyadh' }, f, 'WHITESPACE'],
    [`${f} سطر جديد`, { [f]: 'Riyadh\nBranch' }, f, 'CONTROL_CHARACTER'],
    [`${f} تاب`, { [f]: 'Riyadh\tBranch' }, f, 'CONTROL_CHARACTER'],
    [`${f} محرف C1`, { [f]: 'Riyadh\u0085Branch' }, f, 'CONTROL_CHARACTER'],
    [`${f} تجاوز اتجاه`, { [f]: 'Riyadh\u202eBranch' }, f, 'CONTROL_CHARACTER'],
    [`${f} BOM داخلي`, { [f]: 'Riy\ufeffadh' }, f, 'CONTROL_CHARACTER'],
    [`${f} BOM بادئ`, { [f]: '\ufeffRiyadh' }, f, 'WHITESPACE'],
    // محارف تنسيق خفية تكثر في نصّ عربي منسوخ من Word/PDF (\p{Cf}) — كلها CONTROL_CHARACTER
    [`${f} RLM عربي`, { [f]: 'شركة\u{200f}النور' }, f, 'CONTROL_CHARACTER'],
    [`${f} RLM لاحق (لا يزيله trim)`, { [f]: 'Riyadh\u{200f}' }, f, 'CONTROL_CHARACTER'],
    [`${f} LRM`, { [f]: 'Al\u{200e}Noor' }, f, 'CONTROL_CHARACTER'],
    [`${f} ALM`, { [f]: 'Al\u{061c}Noor' }, f, 'CONTROL_CHARACTER'],
    [`${f} ALM بادئ`, { [f]: '\u{061c}فرع 12' }, f, 'CONTROL_CHARACTER'],
    [`${f} ZWSP`, { [f]: 'Al\u{200b}Noor' }, f, 'CONTROL_CHARACTER'],
    [`${f} ZWNJ`, { [f]: 'Al\u{200c}Noor' }, f, 'CONTROL_CHARACTER'],
    [`${f} ZWJ`, { [f]: 'Al\u{200d}Noor' }, f, 'CONTROL_CHARACTER'],
    [`${f} عزل اتجاه`, { [f]: 'Al\u{2067}Noor\u{2069}' }, f, 'CONTROL_CHARACTER'],
    [`${f} وصل كلمات`, { [f]: 'Al\u{2060}Noor' }, f, 'CONTROL_CHARACTER'],
    [`${f} فاصل خفيّ`, { [f]: 'Al\u{2063}Noor' }, f, 'CONTROL_CHARACTER'],
    [`${f} أشكال أرقام وطنية مهملة`, { [f]: 'Al\u{206e}Noor' }, f, 'CONTROL_CHARACTER'],
    [`${f} شرطة لينة`, { [f]: 'Al\u{00ad}Noor' }, f, 'CONTROL_CHARACTER'],
    [`${f} تعليق خطّي`, { [f]: 'Al\u{fff9}Noor' }, f, 'CONTROL_CHARACTER'],
    [`${f} وسم يونيكود خارج BMP`, { [f]: 'Al\u{e0041}Noor' }, f, 'CONTROL_CHARACTER'],
    [`${f} فاصل فقرة`, { [f]: 'Al\u{2029}Noor' }, f, 'CONTROL_CHARACTER'],
    [`${f} علامة عدد عربية مسبقة`, { [f]: '\u{0600}123 Riyadh' }, f, 'CONTROL_CHARACTER'],
    [`${f} بديل منفرد`, { [f]: 'Riyadh\ud800' }, f, 'FORMAT'],
    [`${f} يبدأ بـ\\`, { [f]: '\\Riyadh' }, f, 'FORBIDDEN_CHARACTER'],
  ]),
];

test('كل قاعدة تحقّق ترفض بـCsrError(INVALID_PARAM) باسم الحقل وسببه — في validateCsrParams وbuildCsr', () => {
  for (const [why, patch, field, reason] of VALIDATION_CASES) {
    const params = { ...SDK_LIKE, ...patch } as CsrParams;
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete (params as unknown as Record<string, unknown>)[k];
    expectCsrError(() => validateCsrParams(params), 'INVALID_PARAM', field, reason, `validate: ${why}`);
    // المدخلات تُفحص قبل المفتاح: مفتاح تالف لا يغيّر الخطأ
    expectCsrError(() => buildCsr(params, 'not-a-key'), 'INVALID_PARAM', field, reason, `buildCsr: ${why}`);
    const e = expectCsrError(() => buildCertificationRequestInfo(params, new Uint8Array(0)), 'INVALID_PARAM', field, reason, `CRI: ${why}`);
    assert.ok(e.message.includes(field), `${why}: الرسالة تسمّي الحقل`);
  }
  assert.ok(VALIDATION_CASES.length > 90);
  expectCsrError(() => validateCsrParams(null as unknown as CsrParams), 'INVALID_PARAM', 'params', 'REQUIRED');
  expectCsrError(() => buildCsr(undefined as unknown as CsrParams, KEYS.privateKey), 'INVALID_PARAM', 'params', 'REQUIRED');
});

test('المحارف الممنوعة ! @ # $ % & * _ < تُرفض (لا تُحذف) في CN وO وOU والموقع والقطاع؛ SN يمنع «=» وحده كالـSDK', () => {
  const chars = ['!', '@', '#', '$', '%', '&', '*', '_', '<'];
  for (const ch of chars) assert.ok(CSR_FORBIDDEN_CHARACTERS.test(`a${ch}b`), ch);
  for (const ok of ['-', '.', ',', '(', ')', '/', "'", '+', ':', '>', '=', '|', '،']) assert.ok(!CSR_FORBIDDEN_CHARACTERS.test(`a${ok}b`), ok);
  for (const field of ['commonName', 'orgName', 'orgUnit', 'locationAddress', 'industry'] as const) {
    for (const ch of chars) {
      const e = expectCsrError(() => validateCsrParams({ ...SDK_LIKE, [field]: `Al Noor ${ch} Sons` }), 'INVALID_PARAM', field, 'FORBIDDEN_CHARACTER', `${field} ${ch}`);
      assert.ok(e.message.includes(ch));
    }
  }
  // لا حذف صامت: القيمة المقبولة تُرمَّز كما هي
  const accepted = { ...SDK_LIKE, orgName: 'Al-Noor Trading Co. (Riyadh)', serialNumber: '1-Field_Sales|2-EGS#1|3-x' };
  const f = parseCsr(buildCsr(accepted, KEYS.privateKey)).fields;
  assert.equal(f.orgName, accepted.orgName);
  assert.equal(f.serialNumber, accepted.serialNumber);
});

test('حدود مقبولة: الموقع والتسلسلي 64 بالضبط، مجموعة ضريبية بـOU عشرة أرقام، وVAT عادي مع OU رقمي', () => {
  const sn64 = `1-TST|2-TST|3-${'a'.repeat(50)}`;
  assert.equal(sn64.length, 64);
  const ok: CsrParams[] = [
    { ...SDK_LIKE, locationAddress: 'R'.repeat(64), serialNumber: sn64 },
    { ...SDK_LIKE, vatNumber: '399999999910003', orgUnit: '1234567890' },
    { ...SDK_LIKE, orgUnit: '1234567890' },
    { ...SDK_LIKE, commonName: 'C'.repeat(64), orgName: 'O'.repeat(64), orgUnit: 'U'.repeat(64), industry: 'I'.repeat(128) },
  ];
  for (const p of ok) {
    assert.deepEqual(validateCsrParams(p), p);
    const f = parseCsr(buildCsr(p, KEYS.privateKey)).fields;
    assert.equal(f.locationAddress, p.locationAddress);
    assert.equal(f.serialNumber, p.serialNumber);
    assert.equal(f.orgUnit, p.orgUnit);
    assert.equal(f.vatNumber, p.vatNumber);
  }
  // المرئي مسموح: التشكيل (Mn) والتطويل والأرقام العربية الهندية والفاصلة العربية والشرطة والمسافة غير الفاصلة
  const visibleArabic: CsrParams = {
    ...SDK_LIKE, orgName: 'شَرِكَة النـــور للتجارة', orgUnit: 'فرع جدة - ٢', locationAddress: 'حي العليا، مبنى ٣٣١٢', industry: 'تجارة\u{00a0}الجملة',
  };
  assert.deepEqual(validateCsrParams(visibleArabic), visibleArabic);
  const va = assertZatcaCsr(buildCsr(visibleArabic, KEYS.privateKey), { params: visibleArabic }).params;
  assert.equal(va.orgName, visibleArabic.orgName);
  assert.equal(va.industry, visibleArabic.industry);
  // validateCsrParams لا يحمل خصائص زائدة إلى البناء
  const extra = { ...SDK_LIKE, country: 'AE', evil: '<x>' } as unknown as CsrParams;
  assert.deepEqual(Object.keys(validateCsrParams(extra)).sort(), Object.keys(SDK_LIKE).sort());
  assert.equal(parseCsr(buildCsr(extra, KEYS.privateKey)).fields.country, CSR_COUNTRY);
});

test('المفتاح: secp256k1 وحده (KeyObject أو PEM بصيغتي SEC1/PKCS#8)؛ P-256 وRSA وEd25519 والمفتاح العام والنصّ التالف ⇒ INVALID_KEY بلا تسريب', () => {
  const sec1 = KEYS.privateKey.export({ type: 'sec1', format: 'pem' }) as string;
  const pkcs8 = KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  for (const k of [KEYS.privateKey, sec1, pkcs8]) {
    const p = parseCsr(buildCsr(SDK_LIKE, k));
    assert.equal(p.signatureValid, true);
    assert.deepEqual(Buffer.from(p.subjectPublicKeyInfoDer), Buffer.from(KEYS.publicKey.export({ type: 'spki', format: 'der' })));
  }
  const p256 = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const ed = crypto.generateKeyPairSync('ed25519');
  const bad: Array<[string, unknown]> = [
    ['P-256', p256.privateKey],
    ['P-256 PEM', p256.privateKey.export({ type: 'pkcs8', format: 'pem' })],
    ['RSA', rsa.privateKey],
    ['Ed25519', ed.privateKey],
    ['مفتاح عام KeyObject', KEYS.publicKey],
    ['مفتاح عام PEM', KEYS.publicKey.export({ type: 'spki', format: 'pem' })],
    ['نصّ تالف', 'not-a-key'],
    ['PEM مقصوص', sec1.slice(0, 60)],
    ['مفقود', undefined],
    ['رقم', 42],
  ];
  for (const [why, k] of bad) {
    const e = expectCsrError(() => buildCsr(SDK_LIKE, k as string), 'INVALID_KEY', 'privateKey', undefined, why);
    const body = sec1.split('\n')[1];
    assert.ok(!e.message.includes(body), `${why}: الرسالة لا تحمل مادة المفتاح`);
    assert.ok(!/BEGIN|asn1|error:/i.test(e.message), `${why}: لا رسالة OpenSSL — ${e.message}`);
  }
  // SPKI لغير secp256k1 مرفوض في مسار الموقِّع الخارجي أيضاً
  expectCsrError(() => buildCertificationRequestInfo(SDK_LIKE, p256.publicKey.export({ type: 'spki', format: 'der' })), 'INVALID_KEY', 'privateKey');
  expectCsrError(() => buildCertificationRequestInfo(SDK_LIKE, Uint8Array.from([0x30, 0x00])), 'INVALID_KEY', 'privateKey');
});

test('مسار الموقِّع الخارجي: buildCertificationRequestInfo + توقيع خارجي + assembleCsrPem = بنية buildCsr نفسها', () => {
  const spki = KEYS.publicKey.export({ type: 'spki', format: 'der' });
  const cri = buildCertificationRequestInfo(SDK_LIKE, spki);
  const pem = assembleCsrPem(cri, crypto.sign('sha256', cri, KEYS.privateKey));
  const viaBuild = decodeIndependently(buildCsr(SDK_LIKE, KEYS.privateKey));
  const viaExternal = decodeIndependently(pem);
  assert.deepEqual(viaExternal.criRaw, viaBuild.criRaw);
  assert.equal(parseCsr(pem).signatureValid, true);
  // توقيع بمفتاح لا يطابق SPKI: parseCsr يبلّغ ولا يرمي (signatureValid=false)، لكن assembleCsrPem لا يعيد PEM كهذا
  const wrongSig = crypto.sign('sha256', cri, newK1().privateKey);
  const wrongPem = assembleRawPem(Buffer.from(encSequence([cri, encSequence([encOid(CSR_OID.ECDSA_WITH_SHA256)]), encBitString(wrongSig)])));
  assert.equal(parseCsr(wrongPem).signatureValid, false);
  expectCsrError(() => csrBodyForApi(wrongPem), 'INVALID_CSR', 'csrPem');
  expectCsrError(() => assembleCsrPem(cri, wrongSig), 'SELF_CHECK');
});

test('assembleCsrPem: توقيع خام r||s (WebCrypto/KMS) يُحوَّل إلى DER ويتحقق؛ مفتاح آخر أو بايتات عشوائية أو DER غير قانوني ⇒ SELF_CHECK بلا PEM', () => {
  const spki = KEYS.publicKey.export({ type: 'spki', format: 'der' });
  const cri = buildCertificationRequestInfo(SDK_LIKE, spki);
  const raw = crypto.sign('sha256', cri, { key: KEYS.privateKey, dsaEncoding: 'ieee-p1363' });
  assert.equal(raw.length, 64);

  const other = newK1();
  const der = crypto.sign('sha256', cri, KEYS.privateKey);
  const bad: Array<[string, Uint8Array]> = [
    ['DER بمفتاح آخر (CRI للمفتاح B موقَّعة بالمفتاح A)', crypto.sign('sha256', cri, other.privateKey)],
    ['خام r||s بمفتاح آخر', crypto.sign('sha256', cri, { key: other.privateKey, dsaEncoding: 'ieee-p1363' })],
    ['خام s||r مقلوب', Buffer.concat([raw.subarray(32), raw.subarray(0, 32)])],
    ['64 بايتاً عشوائية', crypto.randomBytes(64)],
    ['64 صفراً', new Uint8Array(64)],
    ['70 بايتاً عشوائية', crypto.randomBytes(70)],
    ['hello', Buffer.from('hello')],
    ['فارغ', new Uint8Array(0)],
    ['DER بايت زائد', Buffer.concat([der, Buffer.from([0x00])])],
    ['DER بـINTEGER غير أقصر', nonMinimalDerSignature(der)],
    ['ECDSA-SHA384 تحت وسم SHA256', crypto.sign('sha384', cri, KEYS.privateKey)],
  ];
  for (const [why, sig] of bad) {
    const e = expectCsrError(() => assembleCsrPem(cri, sig), 'SELF_CHECK', undefined, undefined, why);
    assert.ok(!e.message.includes(raw.toString('base64')), why);
  }
  // CRI ليست CertificationRequestInfo، أو لا تطابق قالب الهيئة (P-256)، أو نوع خاطئ
  const junk = Uint8Array.from([0x30, 0x00]);
  expectCsrError(() => assembleCsrPem(junk, crypto.sign('sha256', junk, KEYS.privateKey)), 'SELF_CHECK');
  const p256 = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const cri256 = decodeIndependently(craftCsr({ key: p256.privateKey })).criRaw;
  expectCsrError(() => assembleCsrPem(cri256, crypto.sign('sha256', cri256, p256.privateKey)), 'SELF_CHECK');
  expectCsrError(() => assembleCsrPem('cri' as unknown as Uint8Array, raw), 'SELF_CHECK');
  expectCsrError(() => assembleCsrPem(cri, 'sig' as unknown as Uint8Array), 'SELF_CHECK');

  // IEEE P1363 (64 بايتاً) من المفتاح الصحيح ⇒ ECDSA-Sig-Value بـDER بالقيمتين نفسيهما، يتحقق، ويقبله csrBodyForApi
  for (const sig of [raw, Uint8Array.from(raw)]) {
    const pem = assembleCsrPem(cri, sig);
    const d = decodeIndependently(pem);
    const [r, s] = childrenOf(expectTag(parseDer(d.signature), TAG.SEQUENCE, 'ECDSA-Sig-Value')).map(n => decodeInteger(n));
    assert.equal(r, BigInt(`0x${raw.subarray(0, 32).toString('hex')}`));
    assert.equal(s, BigInt(`0x${raw.subarray(32).toString('hex')}`));
    assert.equal(crypto.verify('sha256', d.criRaw, KEYS.publicKey, d.signature), true);
    assert.deepEqual(d.criRaw, Buffer.from(cri));
    assert.equal(parseCsr(pem).signatureValid, true);
    assert.equal(Buffer.from(csrBodyForApi(pem), 'base64').toString('utf8'), pem);
  }
});

/** توقيع DER صالح بعد إضافة 00 بادئ غير لازم إلى r (ترميز غير أقصر ترفضه OpenSSL وder.ts). */
function nonMinimalDerSignature(der: Buffer): Buffer {
  const [r, s] = childrenOf(parseDer(der)).map(n => Buffer.from(n.value));
  const r2 = Buffer.concat([Buffer.from([0x00]), r]);
  const body = Buffer.concat([Buffer.from([0x02, r2.length]), r2, Buffer.from([0x02, s.length]), s]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

// ─────────────────────────────────────────────────────────────────────────────
// طلبات سليمة البنية والتوقيع لكنها لن تُقبل — بنّاء مستقل بـder.ts بمقابض (لا يمرّ بـbuildCertificationRequestInfo)
// ─────────────────────────────────────────────────────────────────────────────

type AtvSpec = [oid: string, value: Uint8Array];

interface CraftKnobs {
  /** مفتاح التوقيع (افتراضياً مفتاح الاختبار secp256k1). */
  key?: crypto.KeyObject;
  /** SPKI المضمَّن (افتراضياً المفتاح العام لـkey). */
  spki?: Uint8Array;
  subject?: AtvSpec[];
  /** قيمة امتداد القالب (سلسلة مرمّزة)، أو null لحذفه. */
  template?: Uint8Array | null;
  san?: AtvSpec[] | null;
  sanCritical?: boolean;
  extraExtensions?: Uint8Array[];
  extraAttributes?: Uint8Array[];
  sigAlgOid?: string;
  hash?: string;
  dsaEncoding?: 'der' | 'ieee-p1363';
}

const u8 = (s: string) => encUtf8String(s);
const DEFAULT_SUBJECT: AtvSpec[] = [
  [CSR_OID.COUNTRY, encPrintableString('SA')], [CSR_OID.ORG_UNIT, u8(SDK_LIKE.orgUnit)], [CSR_OID.ORG, u8(SDK_LIKE.orgName)],
  [CSR_OID.COMMON_NAME, u8(SDK_LIKE.commonName)],
];
const DEFAULT_SAN: AtvSpec[] = [
  [CSR_OID.SERIAL_NUMBER_SN, u8(SDK_LIKE.serialNumber)], [CSR_OID.UID, u8(SDK_LIKE.vatNumber)], [CSR_OID.TITLE, u8(SDK_LIKE.functionMap)],
  [CSR_OID.REGISTERED_ADDRESS, u8(SDK_LIKE.locationAddress)], [CSR_OID.BUSINESS_CATEGORY, u8(SDK_LIKE.industry)],
];

function craftCsr(k: CraftKnobs = {}): string {
  const key = k.key ?? KEYS.privateKey;
  const spki = k.spki ?? crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  const name = (atvs: AtvSpec[]) => encSequence(atvs.map(([oid, v]) => encSet([encSequence([encOid(oid), v])])));
  const ext = (oid: string, valueDer: Uint8Array, critical = false) =>
    encSequence([encOid(oid), ...(critical ? [encBoolean(true)] : []), encOctetString(valueDer)]);
  const template = k.template === undefined ? u8('ZATCA-Code-Signing') : k.template;
  const san = k.san === undefined ? DEFAULT_SAN : k.san;
  const extensions = [
    ...(template === null ? [] : [ext(CSR_OID.CERTIFICATE_TEMPLATE_NAME, template)]),
    ...(san === null ? [] : [ext(CSR_OID.SUBJECT_ALT_NAME, encSequence([encContext(4, name(san))]), k.sanCritical)]),
    ...(k.extraExtensions ?? []),
  ];
  const attributes = [
    ...(extensions.length ? [encSequence([encOid(CSR_OID.EXTENSION_REQUEST), encSet([encSequence(extensions)])])] : []),
    ...(k.extraAttributes ?? []),
  ];
  const cri = encSequence([encInteger(0), name(k.subject ?? DEFAULT_SUBJECT), spki, encContext(0, attributes)]);
  const sig = crypto.sign(k.hash ?? 'sha256', cri, { key, dsaEncoding: k.dsaEncoding ?? 'der' });
  const der = encSequence([cri, encSequence([encOid(k.sigAlgOid ?? CSR_OID.ECDSA_WITH_SHA256)]), encBitString(sig)]);
  return assembleRawPem(Buffer.from(der));
}

test('البنّاء المستقل بقيمه الافتراضية = buildCertificationRequestInfo بايتاً بايتاً، ويمرّ بـcsrBodyForApi وassertZatcaCsr (سلامة أداة الاختبار)', () => {
  const pem = craftCsr();
  const spki = KEYS.publicKey.export({ type: 'spki', format: 'der' });
  assert.deepEqual(decodeIndependently(pem).criRaw, Buffer.from(buildCertificationRequestInfo(SDK_LIKE, spki)));
  assert.equal(Buffer.from(csrBodyForApi(pem), 'base64').toString('utf8'), pem);
  assert.deepEqual(assertZatcaCsr(pem).params, { ...SDK_LIKE });
});

test('csrBodyForApi وassertZatcaCsr: CSR سليم البنية لن تقبله الهيئة (منحنى، توقيع، حقول، قالب، ترتيب، أنواع، امتدادات) ⇒ INVALID_CSR لا جسم API', () => {
  const p256 = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const other = newK1();
  const point = Buffer.from(decodeBitString(childrenOf(parseDer(KEYS.publicKey.export({ type: 'spki', format: 'der' })))[1]).bytes);
  const compressedSpki = encSequence([
    encSequence([encOid(CSR_OID.EC_PUBLIC_KEY), encOid(CSR_OID.SECP256K1)]),
    encBitString(crypto.ECDH.convertKey(point, 'secp256k1', undefined, undefined, 'compressed') as Buffer),
  ]);
  const withSubject = (oid: string, value: Uint8Array) => DEFAULT_SUBJECT.map(([o, v]): AtvSpec => [o, o === oid ? value : v]);
  const withSan = (oid: string, value: Uint8Array) => DEFAULT_SAN.map(([o, v]): AtvSpec => [o, o === oid ? value : v]);
  const signedByOther = (() => {
    // SPKI للمفتاح الأصلي والتوقيع بمفتاح آخر
    return craftCsr({ key: other.privateKey, spki: KEYS.publicKey.export({ type: 'spki', format: 'der' }) });
  })();

  const cases: Array<[why: string, pem: string, reason?: CsrParamReason]> = [
    ['openssl-like: P-256 وCN=x بلا SAN ولا قالب', craftCsr({ key: p256.privateKey, subject: [[CSR_OID.COMMON_NAME, u8('x')]], template: null, san: null })],
    ['P-256 بكل حقول الهيئة', craftCsr({ key: p256.privateKey })],
    ['secp256k1 بنقطة مضغوطة', craftCsr({ spki: compressedSpki })],
    ['موقَّع بمفتاح آخر (DER صالح)', signedByOther],
    ['توقيع خام r||s داخل BIT STRING', craftCsr({ dsaEncoding: 'ieee-p1363' })],
    ['ecdsa-with-SHA384', craftCsr({ sigAlgOid: '1.2.840.10045.4.3.3', hash: 'sha384' })],
    ['secp256k1 وCN وحده بلا SAN ولا قالب', craftCsr({ subject: [[CSR_OID.COMMON_NAME, u8('x')]], template: null, san: null })],
    ['بلا امتداد القالب', craftCsr({ template: null })],
    ['بلا subjectAltName', craftCsr({ san: null })],
    ['SAN ناقص businessCategory', craftCsr({ san: DEFAULT_SAN.slice(0, 4) })],
    ['subject بلا OU', craftCsr({ subject: DEFAULT_SUBJECT.filter(([o]) => o !== CSR_OID.ORG_UNIT) })],
    ['CN مكرّر', craftCsr({ subject: [...DEFAULT_SUBJECT, [CSR_OID.COMMON_NAME, u8('Second CN')]] })],
    ['قالب غير معروف', craftCsr({ template: u8('Foo-Code-Signing') })],
    ['قالب بـPrintableString (صيغة دليل FATOORA)', craftCsr({ template: encPrintableString('ZATCA-Code-Signing') })],
    ['C بـUTF8String', craftCsr({ subject: withSubject(CSR_OID.COUNTRY, u8('SA')) })],
    ['C = AE', craftCsr({ subject: withSubject(CSR_OID.COUNTRY, encPrintableString('AE')) })],
    ['ترتيب subject مختلف (CN قبل O)', craftCsr({ subject: [DEFAULT_SUBJECT[0], DEFAULT_SUBJECT[1], DEFAULT_SUBJECT[3], DEFAULT_SUBJECT[2]] })],
    ['ترتيب SAN مختلف', craftCsr({ san: [...DEFAULT_SAN].reverse() })],
    ['UID بـPrintableString', craftCsr({ san: withSan(CSR_OID.UID, encPrintableString(SDK_LIKE.vatNumber)) })],
    ['SAN حرج', craftCsr({ sanCritical: true })],
    ['امتداد زائد keyUsage', craftCsr({ extraExtensions: [encSequence([encOid('2.5.29.15'), encBoolean(true), encOctetString(encBitString(Uint8Array.from([0x80]), 7))])] })],
    ['سمة زائدة challengePassword', craftCsr({ extraAttributes: [encSequence([encOid('1.2.840.113549.1.9.7'), encSet([u8('pass-phrase')])])] })],
    ['VAT بصيغة خاطئة', craftCsr({ san: withSan(CSR_OID.UID, u8('123456789')) }), 'FORMAT'],
    ['خريطة وظائف 1111', craftCsr({ san: withSan(CSR_OID.TITLE, u8('1111')) }), 'FORMAT'],
    ['SN بلا صيغة 1-|2-|3-', craftCsr({ san: withSan(CSR_OID.SERIAL_NUMBER_SN, u8('EGS-1')) }), 'FORMAT'],
    ['O بعلامة RLM خفية', craftCsr({ subject: withSubject(CSR_OID.ORG, u8('شركة\u{200f}النور')) }), 'CONTROL_CHARACTER'],
    ['الموقع بمحرف ممنوع', craftCsr({ san: withSan(CSR_OID.REGISTERED_ADDRESS, u8('RRRD#2929')) }), 'FORBIDDEN_CHARACTER'],
  ];
  for (const [why, pem, reason] of cases) {
    parseCsr(pem); // البنية DER نفسها سليمة: الرفض من شروط الهيئة لا من المحلّل
    const e = expectCsrError(() => csrBodyForApi(pem), 'INVALID_CSR', 'csrPem', reason, `csrBodyForApi: ${why}`);
    assert.ok(!e.message.includes('LS0tLS1CRUdJTi'), why);
    expectCsrError(() => assertZatcaCsr(pem), 'INVALID_CSR', 'csrPem', reason, `assertZatcaCsr: ${why}`);
  }
  assert.equal(parseCsr(cases[0][1]).publicKeyCurveOid, '1.2.840.10045.3.1.7');
  assert.equal(parseCsr(signedByOther).signatureValid, false);

  // CSR مخزَّن ثم عُبث به (بايت في CN) ⇒ لا يُعاد إرساله
  const der = pemToDer(buildCsr(SDK_LIKE, KEYS.privateKey));
  der[der.indexOf(Buffer.from(SDK_LIKE.commonName, 'utf8'))] ^= 0x01;
  expectCsrError(() => csrBodyForApi(assembleRawPem(der)), 'INVALID_CSR', 'csrPem');
});

test('assertZatcaCsr: العيّنة الرسمية وناتج buildCsr يُقبلان وتُعاد حقولهما (env من القالب)؛ عدم مطابقة المتوقَّع ⇒ INVALID_CSR', () => {
  const official = assertZatcaCsr(OFFICIAL_PEM);
  assert.deepEqual(official.params, { ...SDK_LIKE });
  assert.equal(official.parsed.signatureValid, true);

  const spki = KEYS.publicKey.export({ type: 'spki', format: 'der' });
  for (const env of ['sandbox', 'simulation', 'production'] as FatooraEnv[]) {
    const params = { ...SDK_LIKE, env };
    const r = assertZatcaCsr(buildCsr(params, KEYS.privateKey), { params, subjectPublicKeyInfoDer: spki });
    assert.deepEqual(r.params, params, env);
  }
  const pem = buildCsr(SDK_LIKE, KEYS.privateKey);
  assertZatcaCsr(pem.replace(/\n/g, '\r\n'), { params: SDK_LIKE });
  const mismatches: Array<[string, Parameters<typeof assertZatcaCsr>[1]]> = [
    ['اسم منشأة آخر', { params: { ...SDK_LIKE, orgName: 'Other Trading LTD' } }],
    ['بيئة أخرى (قالب آخر)', { params: { ...SDK_LIKE, env: 'sandbox' } }],
    ['خريطة أخرى', { params: { ...SDK_LIKE, functionMap: '1000' } }],
    ['مفتاح وحدة آخر', { subjectPublicKeyInfoDer: newK1().publicKey.export({ type: 'spki', format: 'der' }) }],
    ['مفتاح ليس بايتات', { subjectPublicKeyInfoDer: 'spki' as unknown as Uint8Array }],
  ];
  for (const [why, expected] of mismatches) expectCsrError(() => assertZatcaCsr(pem, expected), 'INVALID_CSR', 'csrPem', undefined, why);
  // توقّعات مشوّهة = خطأ المستدعي لا الطلب
  expectCsrError(() => assertZatcaCsr(pem, { params: { ...SDK_LIKE, vatNumber: '1' } }), 'INVALID_PARAM', 'vatNumber', 'FORMAT');
  expectCsrError(() => assertZatcaCsr(pem, null as never), 'INVALID_PARAM', 'params');
  expectCsrError(() => assertZatcaCsr('hello'), 'INVALID_CSR', 'csrPem');
});

test('buildCsr: موقِّع يعيد توقيعاً باطلاً (مفتاح آخر أو r||s خام) ⇒ SELF_CHECK لا PEM', () => {
  const other = newK1();
  const realSign = crypto.sign;
  for (const [why, fake] of [
    ['مفتاح آخر', (alg: string | null | undefined, data: NodeJS.ArrayBufferView) => realSign(alg, data, other.privateKey)],
    ['r||s خام', (alg: string | null | undefined, data: NodeJS.ArrayBufferView) => realSign(alg, data, { key: KEYS.privateKey, dsaEncoding: 'ieee-p1363' })],
  ] as const) {
    const m = mock.method(crypto, 'sign', fake as unknown as typeof crypto.sign);
    try {
      expectCsrError(() => buildCsr(SDK_LIKE, KEYS.privateKey), 'SELF_CHECK', undefined, undefined, why);
      assert.ok(m.mock.callCount() >= 1, `${why}: الاستبدال فُعِّل`);
    } finally {
      m.mock.restore();
    }
  }
  assert.equal(parseCsr(buildCsr(SDK_LIKE, KEYS.privateKey)).signatureValid, true);
});

test('parseCsr صارم: غلاف أو base64 أو DER غير صالح ⇒ INVALID_CSR', () => {
  const pem = buildCsr(SDK_LIKE, KEYS.privateKey);
  const der = pemToDer(pem);
  const cases: Array<[string, unknown]> = [
    ['ليس نصاً', null],
    ['فارغ', ''],
    ['شهادة لا طلب', pem.replace(/CERTIFICATE REQUEST/g, 'CERTIFICATE')],
    ['بلا END', pem.replace(/-----END CERTIFICATE REQUEST-----\n$/, '')],
    ['base64 بمحرف غريب', pem.replace(/\n(.)/, '\n*')],
    ['بايت زائد بعد DER', assembleRawPem(Buffer.concat([der, Buffer.from([0x00])]))],
    ['DER مقصوص', assembleRawPem(der.subarray(0, der.length - 5))],
    ['SEQUENCE فارغ', assembleRawPem(Buffer.from([0x30, 0x00]))],
    ['طويل جداً', `-----BEGIN CERTIFICATE REQUEST-----\n${'A'.repeat(20000)}\n-----END CERTIFICATE REQUEST-----\n`],
  ];
  for (const [why, input] of cases) expectCsrError(() => parseCsr(input as string), 'INVALID_CSR', 'csrPem', undefined, why);
  // CRLF مقبول في القراءة (نصّ ملصوق من ويندوز)
  assert.equal(parseCsr(pem.replace(/\n/g, '\r\n')).signatureValid, true);
});

test('قيم التصميم: egsSerialNumber (58 محرفاً) وegsCommonName تمرّان بالتحقق، والمدخل الخاطئ يُرفض', () => {
  const uuid = crypto.randomUUID();
  const sn = egsSerialNumber(uuid.toUpperCase());
  assert.equal(sn, `1-FieldSales|2-EGS1|3-${uuid}`);
  assert.equal(sn.length, 58);
  const cn = egsCommonName('399999999900003', 'u7K2');
  assert.equal(cn, 'FS-399999999900003-u7K2');
  const p = parseCsr(buildCsr({ ...SDK_LIKE, serialNumber: sn, commonName: cn }, KEYS.privateKey)).fields;
  assert.equal(p.serialNumber, sn);
  assert.equal(p.commonName, cn);
  expectCsrError(() => egsSerialNumber('not-a-uuid'), 'INVALID_PARAM', 'serialNumber', 'FORMAT');
  expectCsrError(() => egsCommonName('123', 'u1'), 'INVALID_PARAM', 'vatNumber', 'FORMAT');
  expectCsrError(() => egsCommonName('399999999900003', 'bad_id'), 'INVALID_PARAM', 'commonName', 'FORMAT');
  expectCsrError(() => egsCommonName('399999999900003', 'x'.repeat(41)), 'INVALID_PARAM', 'commonName', 'FORMAT');
});

test('csr.ts نقيّ: لا شبكة ولا قاعدة بيانات ولا ملفات ولا process.env، والاستيراد الوحيد لـapi.ts نوعيّ', () => {
  const src = fs.readFileSync(path.join(__dirname, 'csr.ts'), 'utf8');
  const imports = [...src.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+'([^']+)';/gm)].map(m => ({ typeOnly: !!m[1], from: m[2] }));
  assert.deepEqual(imports.map(i => i.from).sort(), ['./api', './cert', './der', 'crypto'].sort());
  assert.equal(imports.find(i => i.from === './api')!.typeOnly, true, 'api.ts (العميل الشبكي) لا يُحمَّل وقت التشغيل');
  assert.ok(!/require\(|process\.env|@prisma|fetch\(/.test(src));
  // لا نصّ ترويسة مفتاح خاص حرفياً (ماسحات الأسرار)
  assert.ok(!src.includes(['BEGIN', 'PRIVATE', 'KEY'].join(' ')) && !src.includes(['BEGIN EC', 'PRIVATE', 'KEY'].join(' ')));
  // لا محارف تنسيق خفية حرفية (علامات اتجاه، عرض صفري): القواعد مكتوبة بخصائص يونيكود
  assert.ok(!/\p{Cf}/u.test(src));
  // لا محارف تحكّم حرفية في المصدر (git يعامل الملف ثنائياً)
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(src));
});

// ─────────────────────────────────────────────────────────────────────────────
// ذهبي: ملف إعدادات الـSDK الرسمي ومفتاح عيّناته (محليان لدى المالك، مستبعدان من git)
// ─────────────────────────────────────────────────────────────────────────────

const SDK_PROPERTIES = path.join(SDK_DIR, 'csr-config-example-EN.properties');
const SDK_KEY = path.join(SDK_DIR, 'ec-secp256k1-priv-key.pem');
const GOLDEN_SKIP: false | string = fs.existsSync(SDK_PROPERTIES)
  ? false
  : 'csr-config-example-EN.properties من حزمة ZATCA SDK غير موجود في __fixtures__/sdk (مستبعد من git؛ محلي لدى المالك فقط)';

/** قراءة ملف .properties بسيط (key=value؛ الأسطر الفارغة والتعليقات تُتجاهل). */
function readProperties(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#!]/.test(line)) continue;
    const i = line.indexOf('=');
    assert.ok(i > 0, `سطر غير مفهوم في ملف الإعدادات: ${line.slice(0, 40)}`);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

test('ذهبي (SDK 3.4.8): csr-config-example-EN.properties ⇒ الحقول كما في الملف، والبنية مطابقة للعيّنة الرسمية؛ وبمفتاح الـSDK تطابق CRI العيّنة كاملةً', { skip: GOLDEN_SKIP }, () => {
  const props = readProperties(SDK_PROPERTIES);
  assert.equal(props['csr.country.name'], CSR_COUNTRY, 'الدولة في مثال الـSDK = SA');
  const params: CsrParams = {
    env: 'production',
    commonName: props['csr.common.name'],
    serialNumber: props['csr.serial.number'],
    orgName: props['csr.organization.name'],
    orgUnit: props['csr.organization.unit.name'],
    vatNumber: props['csr.organization.identifier'],
    functionMap: props['csr.invoice.type'] as CsrParams['functionMap'],
    locationAddress: props['csr.location.address'],
    industry: props['csr.industry.business.category'],
  };
  const d = decodeIndependently(buildCsr(params, KEYS.privateKey));
  assert.deepEqual(d.subject.map(x => x.value), ['SA', params.orgUnit, params.orgName, params.commonName]);
  assert.deepEqual(d.san.map(x => x.value), [params.serialNumber, params.vatNumber, params.functionMap, params.locationAddress, params.industry]);
  const off = decodeIndependently(OFFICIAL_PEM);
  assert.deepEqual(d.subject.map(x => [x.oid, x.tag]), off.subject.map(x => [x.oid, x.tag]));
  assert.deepEqual(d.san.map(x => [x.oid, x.tag]), off.san.map(x => [x.oid, x.tag]));
  assert.deepEqual(d.templateName, off.templateName);

  // مثال الـSDK يحمل قيم عيّنة Swagger نفسها، ومفتاح عيّنات الـSDK هو مفتاح عيّنة Swagger ⇒ CRI متطابقة بالكامل
  if (!fs.existsSync(SDK_KEY)) return;
  const raw = fs.readFileSync(SDK_KEY, 'utf8').trim();
  const der = Buffer.from(raw, 'base64');
  let sdkKey: crypto.KeyObject;
  try { sdkKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'sec1' }); } catch { sdkKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }); }
  const golden = decodeIndependently(buildCsr(params, sdkKey));
  assert.deepEqual(golden.criRaw, off.criRaw, 'CertificationRequestInfo بايتاً بايتاً = العيّنة الرسمية (بما فيها المفتاح العام)');
  // توقيع الهيئة الرسمي يتحقق فوق CRI التي بنيناها، وتوقيعنا يتحقق بمفتاح العيّنة العام
  const offKey = crypto.createPublicKey({ key: off.spkiRaw, format: 'der', type: 'spki' });
  assert.equal(crypto.verify('sha256', golden.criRaw, offKey, off.signature), true);
  assert.equal(crypto.verify('sha256', off.criRaw, offKey, golden.signature), true);
});
