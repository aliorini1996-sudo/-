// اختبارات Z4 لمستندات فحص الامتثال: الستة لخريطة 1100 والثلاثة لكل من 1000/0100، كل مستند يمرّ بالفحص المسبق
// وverifyStampedXml بشهادة مبنيّة داخل الاختبار، ICV 1..n وسلسلة PIH خاصة، الإشعارات تشير إلى فواتيرها، الجسم =
// base64 لبايتات الـXML المختوم حرفياً ويقبله FatooraClient كما هو، والأخطاء المصنَّفة (INPUT/PREFLIGHT/STAMP)،
// وأن لا أثر خارجياً (لا شبكة ولا كتابة ملفات ولا تعديل مدخلات ولا حالة بين الاستدعاءات).
// حارس الشبكة يُستورد أولاً: أي fetch حقيقي يُفشل الملف.
import { guardFetch } from './__fixtures__/z3-netguard';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { FATOORA_BASE_URLS, FatooraClient, FatooraFetch, FatooraFetchInit, InvoiceBody } from './api';
import { UBL_NS, computeInvoiceHash } from './c14n';
import { CsidCert, parseCsidCertificate } from './cert';
import {
  COMPLIANCE_STANDARD_BUYER, COMPLIANCE_WALK_IN_BUYER, ComplianceSample, ComplianceSampleError, ComplianceSampleErrorCode, ComplianceSampleSpec,
  ComplianceStep, buildComplianceSamples, complianceInvoiceSource, complianceSpecsFor,
} from './complianceSamples';
import type { FunctionMap } from './csr';
import { INITIAL_PIH } from './crypto';
import { SellerSource, mapInvoiceToUbl } from './mapInvoice';
import { hasBlockingIssues, preflightIssues } from './preflight';
import { decodeQr, extractQrFromXml } from './qr';
import { HashSigner, StampError, createServerSigner, unstampedForm, verifyStampedXml } from './stamp';
import { serializeUnsigned } from './ubl';
import { XmlElement, childElements, directText, parseXml } from './xml';
import { SELLER } from './__fixtures__/z1-sources';
import { buildTestCert } from './__fixtures__/z2-testcert';
import { z3Body, z3Fixture } from './__fixtures__/z3-fixtures';

// ─────────────────────────────────────────────────────────────────────────────
// تجهيز
// ─────────────────────────────────────────────────────────────────────────────

const TC = buildTestCert();
const CERT: CsidCert = parseCsidCertificate(TC.certB64);
const SIGNER = createServerSigner(TC.egsPrivateKey);
const NOW = new Date('2026-09-14T07:15:31.900Z'); // 10:15:31 بتوقيت الرياض، داخل صلاحية شهادة الاختبار

const STEPS_1100: ComplianceStep[] = [
  'standard-compliant', 'standard-credit-note-compliant', 'standard-debit-note-compliant',
  'simplified-compliant', 'simplified-credit-note-compliant', 'simplified-debit-note-compliant',
];

/** موقِّع يعدّ الاستدعاءات (لإثبات أن الفحص المسبق يسبق أي توقيع). */
function countingSigner(inner: HashSigner = SIGNER): HashSigner & { calls: number } {
  const s = {
    calls: 0,
    publicKeySpkiDer: inner.publicKeySpkiDer,
    async signHash(h: Uint8Array) { s.calls++; return inner.signHash(h); },
  };
  return s;
}

/** مولّد UUID حتمي (للمقارنة بين تشغيلين). */
function fixedUuids(seed: string): () => string {
  let n = 0;
  return () => {
    n++;
    const h = crypto.createHash('sha256').update(`${seed}:${n}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
}

const SAMPLES_1100 = buildComplianceSamples({ seller: SELLER, cert: CERT, signer: SIGNER, now: NOW, functionMap: '1100' });

async function expectSampleError(p: Promise<unknown>, code: ComplianceSampleErrorCode, check: (e: ComplianceSampleError) => void = () => {}, why = '') {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof ComplianceSampleError, `${why}: ${String(e)}`);
    assert.equal(e.code, code, `${why}: ${e.message}`);
    check(e);
    return true;
  });
}

// أدوات قراءة الـXML (عبر المحلّل لا التعابير النمطية)
const cbc = (el: XmlElement, local: string) => childElements(el, UBL_NS.CBC, local);
const cac = (el: XmlElement, local: string) => childElements(el, UBL_NS.CAC, local);
const text1 = (el: XmlElement, ns: string, local: string): string | undefined => {
  const all = childElements(el, ns, local);
  assert.ok(all.length <= 1, `${local} مكرّر`);
  return all[0] ? directText(all[0]) : undefined;
};
const path1 = (el: XmlElement, ...steps: Array<[string, string]>): XmlElement | undefined => {
  let cur: XmlElement | undefined = el;
  for (const [ns, local] of steps) {
    if (!cur) return undefined;
    const all: XmlElement[] = childElements(cur, ns, local);
    assert.ok(all.length <= 1, `${local} مكرّر`);
    cur = all[0];
  }
  return cur;
};

interface XmlFacts {
  profile?: string;
  id?: string;
  uuid?: string;
  issueDate?: string;
  issueTime?: string;
  typeCode?: string;
  typeName?: string;
  icv?: string;
  pih?: string;
  billingRefs: string[];
  instructionNote?: string;
  sellerVat?: string;
  buyer: { name?: string; vat?: string; street?: string; building?: string; district?: string; city?: string; postal?: string; country?: string };
}

function factsOf(xml: string): XmlFacts {
  const root = parseXml(xml).root;
  assert.equal(root.ns, UBL_NS.INVOICE);
  assert.equal(root.local, 'Invoice');
  const adr = (id: string) => cac(root, 'AdditionalDocumentReference').filter(r => text1(r, UBL_NS.CBC, 'ID') === id);
  const icvRefs = adr('ICV');
  const pihRefs = adr('PIH');
  assert.equal(icvRefs.length, 1);
  assert.equal(pihRefs.length, 1);
  const typeEl = cbc(root, 'InvoiceTypeCode')[0];
  const party = (which: string) => path1(root, [UBL_NS.CAC, which], [UBL_NS.CAC, 'Party'])!;
  const buyer = party('AccountingCustomerParty');
  const addr = path1(buyer, [UBL_NS.CAC, 'PostalAddress']);
  return {
    profile: text1(root, UBL_NS.CBC, 'ProfileID'),
    id: text1(root, UBL_NS.CBC, 'ID'),
    uuid: text1(root, UBL_NS.CBC, 'UUID'),
    issueDate: text1(root, UBL_NS.CBC, 'IssueDate'),
    issueTime: text1(root, UBL_NS.CBC, 'IssueTime'),
    typeCode: directText(typeEl),
    typeName: typeEl.attributes.find(a => a.local === 'name')?.value,
    icv: text1(icvRefs[0], UBL_NS.CBC, 'UUID'),
    pih: directText(path1(pihRefs[0], [UBL_NS.CAC, 'Attachment'], [UBL_NS.CBC, 'EmbeddedDocumentBinaryObject'])!),
    billingRefs: cac(root, 'BillingReference').map(b => directText(path1(b, [UBL_NS.CAC, 'InvoiceDocumentReference'], [UBL_NS.CBC, 'ID'])!)),
    instructionNote: (() => { const pm = path1(root, [UBL_NS.CAC, 'PaymentMeans']); return pm ? text1(pm, UBL_NS.CBC, 'InstructionNote') : undefined; })(),
    sellerVat: directText(path1(party('AccountingSupplierParty'), [UBL_NS.CAC, 'PartyTaxScheme'], [UBL_NS.CBC, 'CompanyID'])!),
    buyer: {
      name: (() => { const e = path1(buyer, [UBL_NS.CAC, 'PartyLegalEntity'], [UBL_NS.CBC, 'RegistrationName']); return e ? directText(e) : undefined; })(),
      vat: (() => { const e = path1(buyer, [UBL_NS.CAC, 'PartyTaxScheme'], [UBL_NS.CBC, 'CompanyID']); return e ? directText(e) : undefined; })(),
      street: addr ? text1(addr, UBL_NS.CBC, 'StreetName') : undefined,
      building: addr ? text1(addr, UBL_NS.CBC, 'BuildingNumber') : undefined,
      district: addr ? text1(addr, UBL_NS.CBC, 'CitySubdivisionName') : undefined,
      city: addr ? text1(addr, UBL_NS.CBC, 'CityName') : undefined,
      postal: addr ? text1(addr, UBL_NS.CBC, 'PostalZone') : undefined,
      country: addr ? (() => { const c = path1(addr, [UBL_NS.CAC, 'Country'], [UBL_NS.CBC, 'IdentificationCode']); return c ? directText(c) : undefined; })() : undefined,
    },
  };
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ─────────────────────────────────────────────────────────────────────────────
// الخريطة 1100
// ─────────────────────────────────────────────────────────────────────────────

test('1100 ⇒ ستة مستندات بترتيب خطوات الهيئة: الأنواع والأنواع الفرعية ورموز النوع وICV 1..6 وسلسلة PIH خاصة من INITIAL_PIH', async () => {
  const s = await SAMPLES_1100;
  assert.equal(s.length, 6);
  assert.deepEqual(s.map(x => x.step), STEPS_1100);
  assert.deepEqual(s.map(x => [x.kind, x.subtype, x.stampKind, x.typeCode]), [
    ['INVOICE', '01', 'standard', '388'], ['CREDIT_NOTE', '01', 'standard', '381'], ['DEBIT_NOTE', '01', 'standard', '383'],
    ['INVOICE', '02', 'simplified', '388'], ['CREDIT_NOTE', '02', 'simplified', '381'], ['DEBIT_NOTE', '02', 'simplified', '383'],
  ]);
  assert.deepEqual(s.map(x => x.icv), [1, 2, 3, 4, 5, 6]);
  assert.equal(s[0].pih, INITIAL_PIH);
  for (let i = 1; i < s.length; i++) assert.equal(s[i].pih, s[i - 1].invoiceHash, `PIH للمستند ${i + 1} = تجزئة ${i}`);
  assert.equal(new Set(s.map(x => x.invoiceHash)).size, 6);
  assert.equal(new Set(s.map(x => x.uuid)).size, 6, 'UUID فريد لكل مستند');
  assert.equal(new Set(s.map(x => x.number)).size, 6, 'رقم فريد لكل مستند');

  for (const x of s) {
    const f = factsOf(x.xml);
    assert.equal(f.profile, 'reporting:1.0');
    assert.equal(f.id, x.number);
    assert.equal(f.uuid, x.uuid);
    assert.match(x.uuid, UUID_V4);
    assert.equal(f.icv, String(x.icv), `${x.step}: ICV في الـXML`);
    assert.equal(f.pih, x.pih, `${x.step}: PIH في الـXML`);
    assert.equal(f.typeCode, x.typeCode);
    assert.equal(f.typeName, x.subtype === '01' ? '0100000' : '0200000');
    assert.equal(f.issueDate, '2026-09-14');
    assert.equal(f.issueTime, '10:15:31');
    assert.equal(f.sellerVat, SELLER.taxNumber);
    assert.equal(x.doc.icv, x.icv);
    assert.equal(x.doc.pih, x.pih);
    assert.equal(x.doc.uuid, x.uuid);
  }
});

test('كل مستند: بلا مخالفات مانعة، وverifyStampedXml يمرّ بالشهادة، والتجزئة تُعاد حسابها مستقلةً، ولا يمرّ بشهادة أخرى', async () => {
  const s = await SAMPLES_1100;
  const otherCert = parseCsidCertificate(buildTestCert().certB64);
  for (const x of s) {
    const issues = preflightIssues(x.doc, x.stampKind);
    assert.equal(hasBlockingIssues(issues), false, `${x.step}: ${JSON.stringify(issues)}`);
    assert.deepEqual(x.warnings, issues.filter(i => i.severity !== 'error'));
    // النموذج يُعاد بناؤه حرفياً من المصدر الحتمي وقيم السلسلة
    assert.deepEqual(mapInvoiceToUbl(complianceInvoiceSource(complianceSpecsFor('1100').find(sp => sp.step === x.step)!, SELLER), {
      icv: x.icv, pih: x.pih, uuid: x.uuid, issuedAt: NOW,
    }), x.doc);

    const v = verifyStampedXml(x.xml, CERT, x.stampKind, { invoiceHash: x.invoiceHash });
    assert.equal(v.invoiceHash, x.invoiceHash);
    assert.equal(computeInvoiceHash(x.xml), x.invoiceHash, `${x.step}: تجزئة مستقلة`);
    assert.equal(Buffer.from(x.invoiceHash, 'base64').length, 32);
    // لا بايت تغيّر غير خانات الختم: الصورة المفرَّغة = الـXML غير الموقَّع من النموذج
    assert.equal(unstampedForm(x.xml), serializeUnsigned(x.doc));
    // QR: الوسوم من الـXML نفسه، والوسم 9 (توقيع الشهادة) للمبسّطة وإشعاراتها فقط
    const qr = decodeQr(extractQrFromXml(x.xml)!);
    assert.equal(qr.vat, SELLER.taxNumber);
    assert.equal(qr.invoiceHash, x.invoiceHash);
    assert.equal(qr.timestamp, '2026-09-14T10:15:31');
    assert.equal(qr.certSignatureDer !== undefined, x.stampKind === 'simplified', `${x.step}: الوسم 9`);
    // التحقق حقيقي: شهادة بمفتاح آخر ترفض
    assert.throws(() => verifyStampedXml(x.xml, otherCert, x.stampKind), (e: unknown) => e instanceof StampError);
    assert.throws(() => verifyStampedXml(x.xml, CERT, x.stampKind === 'standard' ? 'simplified' : 'standard'), (e: unknown) => e instanceof StampError);
  }
});

test('body جاهز لـcheckComplianceInvoice: invoice = base64 لبايتات الـXML المختوم حرفياً، والتجزئة وUUID مطابقان، ويُرسَل كما هو', async () => {
  const s = await SAMPLES_1100;
  for (const x of s) {
    assert.deepEqual(Object.keys(x.body), ['invoiceHash', 'uuid', 'invoice']);
    assert.deepEqual(Buffer.from(x.body.invoice, 'base64'), Buffer.from(x.xml, 'utf8'));
    assert.equal(Buffer.from(x.body.invoice, 'base64').toString('base64'), x.body.invoice, 'base64 قانوني');
    assert.equal(x.body.invoiceHash, x.invoiceHash);
    assert.equal(x.body.uuid, x.uuid);
    // الجسم المفكوك نفسه يتحقق (هو ما تستلمه الهيئة)
    verifyStampedXml(Buffer.from(x.body.invoice, 'base64'), CERT, x.stampKind, { invoiceHash: x.body.invoiceHash });
  }

  // العميل يقبل الأجسام الستة ويرسلها بلا تعديل (fetch مُسجِّل مزيَّف — لا شبكة)
  const CCSID = z3Body<{ binarySecurityToken: string; secret: string }>('compliance-200');
  const calls: Array<{ url: string; init: FatooraFetchInit }> = [];
  const fetch: FatooraFetch = async (url, init) => {
    calls.push({ url, init });
    const f = z3Fixture('compliance-invoices-200');
    return new Response(f.raw, { status: f.httpStatus, headers: { 'content-type': 'application/json' } });
  };
  const client = new FatooraClient({ env: 'sandbox', fetch, log: async () => {} });
  for (const x of s) {
    const outcome = await client.checkComplianceInvoice({ token: CCSID.binarySecurityToken, secret: CCSID.secret }, x.body);
    assert.equal(outcome.kind, 'ACCEPTED', `${x.step}: ${JSON.stringify(outcome)}`);
  }
  assert.equal(calls.length, 6);
  calls.forEach((c, i) => {
    assert.equal(c.url, `${FATOORA_BASE_URLS.sandbox}/compliance/invoices`);
    assert.deepEqual(JSON.parse(c.init.body) as InvoiceBody, s[i].body);
  });
  assert.equal(globalThis.fetch, guardFetch, 'fetch العام لم يُستعمل');
});

test('الإشعارات تشير إلى فاتورة النوع نفسه بين العيّنات، مع سبب الإصدار؛ الفواتير بلا مرجع', async () => {
  const s = await SAMPLES_1100;
  const bySubtype = (sub: '01' | '02') => s.filter(x => x.subtype === sub);
  for (const sub of ['01', '02'] as const) {
    const [inv, ...notes] = bySubtype(sub);
    assert.equal(inv.kind, 'INVOICE');
    assert.deepEqual(factsOf(inv.xml).billingRefs, []);
    assert.equal(inv.references, undefined);
    assert.equal(factsOf(inv.xml).instructionNote, undefined);
    assert.deepEqual(notes.map(n => n.kind), ['CREDIT_NOTE', 'DEBIT_NOTE']);
    for (const n of notes) {
      const f = factsOf(n.xml);
      assert.deepEqual(f.billingRefs, [inv.number], `${n.step} → ${inv.number}`);
      assert.equal(n.references, inv.number);
      assert.deepEqual(n.doc.billingReferences, [inv.number]);
      assert.ok(f.instructionNote && f.instructionNote.length > 0, `${n.step}: سبب الإشعار (KSA-10)`);
      assert.ok(n.icv > inv.icv, 'الإشعار بعد فاتورته في السلسلة');
    }
  }
  // لا إشعار مبسّط يشير إلى فاتورة ضريبية أو العكس
  const standardNumbers = new Set(bySubtype('01').map(x => x.number));
  for (const n of bySubtype('02')) for (const r of n.doc.billingReferences ?? []) assert.ok(!standardNumbers.has(r));
});

test('المشتريان الاصطناعيان: منشأة سعودية برقم ضريبي وعنوان وطني كامل للقياسية، وعميل نقدي بالاسم للمبسّطة', async () => {
  const s = await SAMPLES_1100;
  for (const x of s.filter(y => y.subtype === '01')) {
    const b = factsOf(x.xml).buyer;
    assert.match(b.vat ?? '', /^3[0-9]{13}3$/);
    assert.equal(b.vat, COMPLIANCE_STANDARD_BUYER.taxNumber);
    assert.notEqual(b.vat?.[10], '1', 'ليس مجموعة ضريبية');
    assert.ok(b.street && b.district && b.city, `${x.step}: الشارع والحي والمدينة`);
    assert.match(b.building ?? '', /^[0-9]{4}$/);
    assert.match(b.postal ?? '', /^[0-9]{5}$/);
    assert.equal(b.country, 'SA');
    assert.ok(b.name && b.name.length > 0);
  }
  for (const x of s.filter(y => y.subtype === '02')) {
    const b = factsOf(x.xml).buyer;
    assert.equal(b.vat, undefined, 'المبسّطة بلا رقم ضريبي للمشتري');
    assert.equal(b.name, COMPLIANCE_WALK_IN_BUYER.name);
  }
  assert.ok(Object.isFrozen(COMPLIANCE_STANDARD_BUYER) && Object.isFrozen(COMPLIANCE_WALK_IN_BUYER));
});

// ─────────────────────────────────────────────────────────────────────────────
// الخرائط 1000 و0100
// ─────────────────────────────────────────────────────────────────────────────

test('1000 ⇒ الثلاثة الضريبية فقط و0100 ⇒ الثلاثة المبسّطة فقط، كلٌّ بسلسلة خاصة من ICV 1 وINITIAL_PIH وتتحقق', async () => {
  const cases: Array<[FunctionMap, ComplianceStep[], '01' | '02']> = [
    ['1000', STEPS_1100.slice(0, 3), '01'],
    ['0100', STEPS_1100.slice(3), '02'],
  ];
  for (const [functionMap, steps, subtype] of cases) {
    assert.deepEqual(complianceSpecsFor(functionMap).map(sp => sp.step), steps);
    const s = await buildComplianceSamples({ seller: SELLER, cert: CERT, signer: SIGNER, now: NOW, functionMap });
    assert.deepEqual(s.map(x => x.step), steps, functionMap);
    assert.deepEqual(s.map(x => x.kind), ['INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE']);
    assert.ok(s.every(x => x.subtype === subtype));
    assert.deepEqual(s.map(x => x.icv), [1, 2, 3]);
    assert.equal(s[0].pih, INITIAL_PIH);
    assert.equal(s[1].pih, s[0].invoiceHash);
    assert.equal(s[2].pih, s[1].invoiceHash);
    for (const x of s) {
      assert.equal(hasBlockingIssues(preflightIssues(x.doc, x.stampKind)), false);
      verifyStampedXml(x.xml, CERT, x.stampKind, { invoiceHash: x.invoiceHash });
      assert.equal(factsOf(x.xml).icv, String(x.icv));
      assert.deepEqual(Buffer.from(x.body.invoice, 'base64'), Buffer.from(x.xml, 'utf8'));
    }
    assert.deepEqual(s[1].doc.billingReferences, [s[0].number]);
    assert.deepEqual(s[2].doc.billingReferences, [s[0].number]);
  }
  assert.deepEqual([...complianceSpecsFor('1100')].map(sp => sp.step), STEPS_1100);
});

// ─────────────────────────────────────────────────────────────────────────────
// الحتمية وعدم الأثر
// ─────────────────────────────────────────────────────────────────────────────

test('حتمي عدا UUID والتوقيعات: بـUUID ووقت ثابتين تتطابق التجزئات والمحتوى غير الموقَّع، وتختلف قيم التوقيع فقط', async () => {
  const run = () => buildComplianceSamples({ seller: SELLER, cert: CERT, signer: SIGNER, now: NOW, functionMap: '1100', newUuid: fixedUuids('same') });
  const [a, b] = [await run(), await run()];
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].uuid, b[i].uuid);
    assert.equal(a[i].invoiceHash, b[i].invoiceHash, `${a[i].step}: التجزئة لا تشمل التوقيع`);
    assert.equal(a[i].pih, b[i].pih);
    assert.equal(unstampedForm(a[i].xml), unstampedForm(b[i].xml));
    assert.deepEqual(a[i].doc, b[i].doc);
    assert.notEqual(a[i].xml, b[i].xml, 'ECDSA عشوائي ⇒ SignatureValue مختلف');
  }
  // UUID افتراضياً عشوائي: تشغيلان مستقلان لا يتشاركان UUID، والباقي (الأرقام والمبالغ) واحد
  const [c, d] = [await SAMPLES_1100, await buildComplianceSamples({ seller: SELLER, cert: CERT, signer: SIGNER, now: NOW, functionMap: '1100' })];
  for (let i = 0; i < c.length; i++) {
    assert.notEqual(c[i].uuid, d[i].uuid);
    assert.equal(c[i].number, d[i].number);
    assert.deepEqual(c[i].doc.totals, d[i].doc.totals);
    assert.deepEqual({ ...c[i].doc, uuid: '', pih: '' }, { ...d[i].doc, uuid: '', pih: '' });
  }
  assert.equal(d[0].icv, 1, 'لا حالة سلسلة بين الاستدعاءات');
  assert.equal(d[0].pih, INITIAL_PIH);
});

test('لا أثر خارجياً: لا كتابة ملفات ولا شبكة، والمدخلات والثوابت لا تُعدَّل (مجمَّدة عميقاً)', async () => {
  const deepFreeze = <T>(o: T): T => {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    }
    return o;
  };
  const seller = deepFreeze({ ...SELLER }) as SellerSource;
  const sellerBefore = JSON.stringify(seller);
  const buyersBefore = JSON.stringify([COMPLIANCE_STANDARD_BUYER, COMPLIANCE_WALK_IN_BUYER]);
  const specsBefore = JSON.stringify(complianceSpecsFor('1100'));

  type Writable = Record<string, unknown>;
  const fsTargets: Array<[Writable, string]> = [
    'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'mkdirSync', 'mkdir', 'createWriteStream', 'openSync', 'open', 'renameSync', 'copyFileSync',
  ].map(k => [fs as unknown as Writable, k] as [Writable, string]);
  fsTargets.push(...['writeFile', 'appendFile', 'mkdir', 'open'].map(k => [fs.promises as unknown as Writable, k] as [Writable, string]));
  const saved = fsTargets.map(([o, k]) => o[k]);
  let writes = 0;
  fsTargets.forEach(([o, k]) => { o[k] = (..._args: unknown[]) => { writes++; throw new Error(`unexpected fs.${k}`); }; });
  const signer = countingSigner();
  let s: ComplianceSample[];
  try {
    s = await buildComplianceSamples({ seller, cert: CERT, signer, now: NOW, functionMap: '1100' });
  } finally {
    fsTargets.forEach(([o, k], i) => { o[k] = saved[i]; });
  }
  assert.equal(writes, 0, 'لا كتابة على القرص');
  assert.equal(s.length, 6);
  assert.equal(signer.calls, 6, 'توقيع واحد لكل مستند');
  assert.equal(JSON.stringify(seller), sellerBefore);
  assert.equal(JSON.stringify([COMPLIANCE_STANDARD_BUYER, COMPLIANCE_WALK_IN_BUYER]), buyersBefore);
  assert.equal(JSON.stringify(complianceSpecsFor('1100')), specsBefore);
  assert.equal(globalThis.fetch, guardFetch);
  // المصدر المُعاد نسخة: تعديله لا يمسّ الثوابت
  const src = complianceInvoiceSource(complianceSpecsFor('1100')[0], SELLER);
  (src.buyer as Record<string, unknown>).name = 'changed';
  assert.notEqual(COMPLIANCE_STANDARD_BUYER.name, 'changed');
});

test('المواصفات مجمَّدة: تعديل ما يعيده complianceSpecsFor (رقم، مرجع، نوع، ترتيب) لا يمسّ الاستدعاءات اللاحقة ولا ربط شركة أخرى', async () => {
  // «شركة أ» تعبث بما أُعيد لها (معاينة تعيد الترقيم مثلاً)
  const specs = complianceSpecsFor('1100');
  const attempts: Array<[string, () => void]> = [
    ['رقم مستند', () => { (specs[0] as { number: string }).number = 'TENANT-A-PREVIEW'; }],
    ['مرجع إشعار', () => { (specs[1] as { references?: string }).references = 'SOMEONE-ELSES-INVOICE'; }],
    ['نوع فرعي', () => { (specs[3] as { subtype: string }).subtype = '01'; }],
    ['حذف مرجع', () => { delete (specs[4] as { references?: string }).references; }],
    ['ترتيب', () => { (specs as ComplianceSampleSpec[]).reverse(); }],
    ['إضافة', () => { (specs as ComplianceSampleSpec[]).push({ ...specs[0], number: 'EXTRA' }); }],
    ['استبدال عنصر', () => { (specs as ComplianceSampleSpec[])[2] = { ...specs[2], number: 'SWAPPED' }; }],
    ['مواصفة 1000', () => { (complianceSpecsFor('1000')[2] as { references?: string }).references = 'X'; }],
  ];
  for (const [why, mutate] of attempts) {
    try { mutate(); } catch (e) { assert.ok(e instanceof TypeError, `${why}: ${String(e)}`); }
  }

  const ORIGINAL: Array<[ComplianceStep, string, string | null]> = [
    ['standard-compliant', 'FS-COMPLIANCE-STD-INV', null],
    ['standard-credit-note-compliant', 'FS-COMPLIANCE-STD-CRN', 'FS-COMPLIANCE-STD-INV'],
    ['standard-debit-note-compliant', 'FS-COMPLIANCE-STD-DBN', 'FS-COMPLIANCE-STD-INV'],
    ['simplified-compliant', 'FS-COMPLIANCE-SMP-INV', null],
    ['simplified-credit-note-compliant', 'FS-COMPLIANCE-SMP-CRN', 'FS-COMPLIANCE-SMP-INV'],
    ['simplified-debit-note-compliant', 'FS-COMPLIANCE-SMP-DBN', 'FS-COMPLIANCE-SMP-INV'],
  ];
  assert.deepEqual(complianceSpecsFor('1100').map(x => [x.step, x.number, x.references ?? null]), ORIGINAL);
  assert.deepEqual(complianceSpecsFor('1100').map(x => x.subtype), ['01', '01', '01', '02', '02', '02']);

  // «شركة ب» تربط بعدها في العملية نفسها: المستندات بأرقامها ومراجعها وأنواعها الأصلية
  const s = await buildComplianceSamples({ seller: SELLER, cert: CERT, signer: SIGNER, now: NOW, functionMap: '1100' });
  assert.deepEqual(s.map(x => [x.step, x.number, x.references ?? null]), ORIGINAL);
  assert.deepEqual(s.map(x => [x.doc.id, x.doc.billingReferences ?? null]), ORIGINAL.map(([, n, r]) => [n, r === null ? null : [r]]));
  assert.deepEqual(s.map(x => x.subtype), ['01', '01', '01', '02', '02', '02']);
  for (const x of s) assert.deepEqual(factsOf(x.xml).billingRefs, x.references ? [x.references] : [], x.step);
  const s1000 = await buildComplianceSamples({ seller: SELLER, cert: CERT, signer: SIGNER, now: NOW, functionMap: '1000' });
  assert.deepEqual(s1000.map(x => [x.step, x.number, x.references ?? null]), ORIGINAL.slice(0, 3));

  // الضمان بنيوي لا اتفاقي: المصفوفات والمواصفات مجمَّدة لكل خريطة
  for (const fm of ['1100', '1000', '0100'] as FunctionMap[]) {
    const list = complianceSpecsFor(fm);
    assert.ok(Object.isFrozen(list), `${fm}: المصفوفة`);
    for (const x of list) assert.ok(Object.isFrozen(x), `${fm} ${x.step}`);
  }
});

test('complianceSamples.ts نقيّ: لا قاعدة بيانات ولا شبكة ولا ملفات ولا process.env، والعميل الشبكي مستورد نوعاً فقط', () => {
  const src = fs.readFileSync(path.join(__dirname, 'complianceSamples.ts'), 'utf8');
  const imports = [...src.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+'([^']+)';/gm)].map(m => ({ typeOnly: !!m[1], from: m[2] }));
  for (const i of imports) assert.ok(i.from.startsWith('./'), `استيراد خارجي ${i.from}`);
  for (const typeOnly of ['./api', './cert', './csr']) assert.equal(imports.find(i => i.from === typeOnly)?.typeOnly, true, typeOnly);
  assert.ok(!/require\(|process\.env|@prisma|fetch\(|\bfs\b|onboarding/.test(src.replace(/^\s*\/\/.*$/gm, '')));
});

// ─────────────────────────────────────────────────────────────────────────────
// الأخطاء المصنَّفة
// ─────────────────────────────────────────────────────────────────────────────

test('PREFLIGHT: بيانات البائع الناقصة ⇒ خطأ مصنَّف بكل المخالفات لكل الخطوات دفعة واحدة، وقبل أي توقيع', async () => {
  const signer = countingSigner();
  await expectSampleError(
    buildComplianceSamples({ seller: { ...SELLER, taxNumber: '123', addrBuildingNo: null }, cert: CERT, signer, now: NOW, functionMap: '1100' }),
    'PREFLIGHT',
    e => {
      assert.deepEqual(e.steps, STEPS_1100);
      assert.deepEqual(e.issues.map(i => [i.rule, i.field]).sort(), [['BR-KSA-09', 'supplier.address.buildingNumber'], ['BR-KSA-40', 'supplier.vatNumber']].sort());
      for (const i of e.issues) {
        assert.equal(i.severity, 'error');
        assert.ok(i.messageAr.length > 0);
        assert.ok(e.message.includes(`${i.rule}@${i.field}`), 'الرسالة تسرد القاعدة والحقل');
      }
      assert.equal(new Set(e.issues.map(i => `${i.rule}|${i.field}|${i.messageAr}`)).size, e.issues.length, 'بلا تكرار عبر الخطوات');
    },
  );
  assert.equal(signer.calls, 0, 'لا توقيع قبل نجاح الفحص المسبق لكل الخطوات');

  // مخالفة تخصّ المبسّطة وحدها (ميزانية طول QR مع الوسم 9: اسم 200 بايت) تُسمّي خطواتها فقط
  await expectSampleError(
    buildComplianceSamples({ seller: { ...SELLER, legalName: 'ش'.repeat(100) }, cert: CERT, signer, now: NOW, functionMap: '1100' }),
    'PREFLIGHT',
    e => {
      assert.deepEqual(e.steps, STEPS_1100.slice(3));
      // رسالة لكل ميزانية مختلفة (المبالغ تختلف بين الفاتورة والإشعارين)، والقاعدة والحقل واحدان
      assert.ok(e.issues.length >= 1);
      assert.ok(e.issues.every(i => i.rule === 'QR-LENGTH' && i.field === 'supplier.registrationName'), JSON.stringify(e.issues));
      assert.equal(new Set(e.issues.map(i => i.messageAr)).size, e.issues.length);
    },
  );
  // اسم فوق 255 بايت يمنع الستة
  await expectSampleError(
    buildComplianceSamples({ seller: { ...SELLER, legalName: 'ش'.repeat(130) }, cert: CERT, signer, now: NOW, functionMap: '1100' }),
    'PREFLIGHT',
    e => assert.deepEqual(e.steps, STEPS_1100),
  );
  await expectSampleError(buildComplianceSamples({ seller: {}, cert: CERT, signer, now: NOW, functionMap: '0100' }), 'PREFLIGHT', e => {
    assert.deepEqual(e.steps, STEPS_1100.slice(3));
    assert.ok(e.issues.length >= 5);
  });
  assert.equal(signer.calls, 0);
});

test('STAMP: شهادة لا تطابق مفتاح الموقِّع أو خارج صلاحيتها ⇒ خطأ مصنَّف برمز الختم والخطوة', async () => {
  const other = parseCsidCertificate(buildTestCert().certB64);
  await expectSampleError(buildComplianceSamples({ seller: SELLER, cert: other, signer: SIGNER, now: NOW, functionMap: '1100' }), 'STAMP', e => {
    assert.equal(e.stampCode, 'CERT_KEY_MISMATCH');
    assert.deepEqual(e.steps, ['standard-compliant']);
    assert.ok(e.cause instanceof StampError);
  });
  await expectSampleError(buildComplianceSamples({ seller: SELLER, cert: CERT, signer: SIGNER, now: new Date('2032-01-01T00:00:00Z'), functionMap: '0100' }), 'STAMP', e => {
    assert.equal(e.stampCode, 'CERT_NOT_VALID');
    assert.deepEqual(e.steps, ['simplified-compliant']);
  });
  // موقِّع يرمي خطأً غير مصنَّف ⇒ STAMP لا خطأ خام
  const broken: HashSigner = { publicKeySpkiDer: SIGNER.publicKeySpkiDer, async signHash() { throw new Error('kms down'); } };
  await expectSampleError(buildComplianceSamples({ seller: SELLER, cert: CERT, signer: broken, now: NOW, functionMap: '1000' }), 'STAMP', e => {
    assert.equal(e.steps.length, 1);
    assert.ok(e.stampCode);
  });
});

test('INPUT: خريطة وظائف أو وقت أو بائع أو شهادة أو موقِّع أو UUID غير صالح ⇒ خطأ مصنَّف باسم الحقل', async () => {
  const base = { seller: SELLER, cert: CERT, signer: SIGNER, now: NOW, functionMap: '1100' as FunctionMap };
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['خريطة 0000', { functionMap: '0000' }, 'functionMap'],
    ['خريطة 1111', { functionMap: '1111' }, 'functionMap'],
    ['خريطة مفقودة', { functionMap: undefined }, 'functionMap'],
    ['وقت غير صالح', { now: new Date('nope') }, 'now'],
    ['وقت نصّ', { now: '2026-09-14' }, 'now'],
    ['بائع مفقود', { seller: null }, 'seller'],
    ['شهادة مفقودة', { cert: undefined }, 'cert'],
    ['شهادة بلا certB64', { cert: {} }, 'cert'],
    ['موقِّع مفقود', { signer: {} }, 'signer'],
    ['UUID مكرّر', { newUuid: () => '8e6000cf-1a98-4174-b3e7-b5d5954bc101' }, 'newUuid'],
    ['UUID بحالة أحرف مختلفة مكرّر', { newUuid: (() => { let n = 0; return () => (n++ % 2 ? 'ABCDEF00-1a98-4174-b3e7-b5d5954bc101' : 'abcdef00-1a98-4174-b3e7-b5d5954bc101'); })() }, 'newUuid'],
    ['UUID ليس بالصيغة', { newUuid: () => 'not-a-uuid' }, 'newUuid'],
    ['newUuid ليس دالّة', { newUuid: 'x' }, 'newUuid'],
  ];
  for (const [why, patch, field] of cases) {
    const signer = countingSigner();
    await expectSampleError(buildComplianceSamples({ ...base, signer: 'signer' in patch ? patch.signer : signer, ...patch } as never), 'INPUT', e => assert.equal(e.field, field, why), why);
    assert.equal(signer.calls, 0, why);
  }
  await expectSampleError(buildComplianceSamples(null as never), 'INPUT');
  assert.throws(() => complianceSpecsFor('0010' as FunctionMap), (e: unknown) => e instanceof ComplianceSampleError && e.code === 'INPUT' && e.field === 'functionMap');
});
