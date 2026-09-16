// اختبارات Z3 لقراءة ردود «فاتورة» وتصنيفها: كل صفّ في جدول design §3 Z3، كل شكل خطأ موثَّق في report §3.4،
// الإملاءات الخاطئة، والأجسام الضخمة أو المعطوبة أو العدائية. الملف نقيّ بلا I/O شبكي، والحارس مُركَّب مع ذلك.
import { guardHits } from './__fixtures__/z3-netguard';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'util';
import { performance } from 'perf_hooks';
import {
  BodyTooLarge, CsidEndpoint, CsidOutcome, EMPTY400_EXHAUSTED_CODE, EMPTY400_MAX_RETRIES, EscalationCounts, FatooraEndpoint, InvoiceEndpoint, LOG_LIMITS,
  MAX_CSID_TOKEN_CHARS, MAX_ESCALATION_COUNT, Msg, NO_PRIOR_ESCALATIONS, Outcome, PAYLOAD413_MAX_RETRIES, RESPONSE_LIMITS, SECRET_WINDOW_CHARS,
  classifyCsidResponse, classifyInvoiceResponse, cleanText, compileSecrets, containsSecret, extractMessages, isMeaningfulMsg, jsonShapeWithinLimits,
  looksLikeBase64Xml, parseCsidResponse, parseInvoiceResponse, parseResponseBody, redactResponseForLog, responseBodyCap, responseCredentialStrings,
  responseNeedsBody, scrubSecrets,
} from './responses';
import { z3Body, z3Fixture, z3FixtureNames } from './__fixtures__/z3-fixtures';

const INVOICE_EPS: InvoiceEndpoint[] = ['compliance-invoices', 'reporting', 'clearance'];
const CSID_EPS: CsidEndpoint[] = ['compliance', 'production-csid', 'renewal'];
const STUB_B64 = z3Body<{ clearedInvoice: string }>('clearance-200').clearedInvoice;
const NONE = NO_PRIOR_ESCALATIONS;
const counts = (priorEmpty400: number, priorPayload413 = 0): EscalationCounts => ({ priorEmpty400, priorPayload413 });
const codes = (list: Msg[]) => list.map(m => m.code);
/** كل قيم detail الممكنة — قائمة مغلقة، فلا يتسرّب إليها شيء من الجسم. */
const SAFE_DETAIL = /^(version-not-accepted|payload-too-large|unexpected-status:[1-5][0-9]{2}|invalid-status|invalid-counts|unknown-endpoint|classifier-internal-error|body-too-large|cleared-invoice-(invalid|missing)|empty-body|unparseable-body|contradictory-2xx:(validation-error|error-messages|legacy-status|reporting-status|clearance-status)|csid-incomplete:(binarySecurityToken|secret|requestID))$/;

/** كل نوافذ السرّ (16 محرفاً) بلا حساسية لحالة الأحرف — ما يُعدّ تسريباً في السجلّ. */
function leaksSecretWindow(text: string, secret: string): boolean {
  const t = text.toLowerCase();
  const s = secret.toLowerCase();
  for (let i = 0; i + SECRET_WINDOW_CHARS <= s.length; i++) if (t.includes(s.slice(i, i + SECRET_WINDOW_CHARS))) return true;
  return false;
}

type Expect = { kind: string; counts?: EscalationCounts };

/** التوقّع لكل مثبّت رد — الاختبار الأول يضمن ألا يبقى مثبّت بلا توقّع ولا توقّع بلا مثبّت. */
const EXPECT: Record<string, Expect> = {
  'compliance-200': { kind: 'ISSUED' },
  'compliance-200-errors-null': { kind: 'ISSUED' },
  'compliance-400-invalid-otp': { kind: 'REJECTED' },
  'compliance-400-not-compliant': { kind: 'REJECTED' },
  'compliance-400-csr-flat': { kind: 'REJECTED' },
  'compliance-400-errorcode': { kind: 'REJECTED' },
  'production-csid-200': { kind: 'ISSUED' },
  'production-csid-400-missing-steps': { kind: 'REJECTED' },
  'production-csid-400-missing-steps-production': { kind: 'REJECTED' },
  'renewal-200': { kind: 'ISSUED' },
  'renewal-428': { kind: 'NOT_COMPLIANT' },
  'compliance-invoices-200': { kind: 'ACCEPTED' },
  'compliance-invoices-200-malformed': { kind: 'ACCEPTED' },
  'compliance-invoices-400': { kind: 'REJECTED' },
  'reporting-200': { kind: 'ACCEPTED' },
  'reporting-202': { kind: 'ACCEPTED' },
  'reporting-400': { kind: 'REJECTED' },
  'reporting-400-null-messages': { kind: 'RETRY' },
  'reporting-400-erro-messages': { kind: 'REJECTED' },
  'reporting-400-legacy-v1': { kind: 'REJECTED' },
  'reporting-409-sandbox': { kind: 'DUPLICATE' },
  'reporting-409-production': { kind: 'DUPLICATE' },
  'clearance-200': { kind: 'ACCEPTED' },
  'clearance-202': { kind: 'ACCEPTED' },
  'clearance-208': { kind: 'DUPLICATE' },
  'clearance-303': { kind: 'CLEARANCE_OFF' },
  'clearance-400': { kind: 'REJECTED' },
  'error-401': { kind: 'AUTH' },
  'error-406': { kind: 'CONFIG' },
  'error-500-invalid-request': { kind: 'RETRY' },
  'error-500-http-errors': { kind: 'RETRY' },
};

function classifyFixture(name: string, c: EscalationCounts = NONE): Outcome | CsidOutcome {
  const f = z3Fixture(name);
  const ep = f.endpoint as FatooraEndpoint;
  return (CSID_EPS as string[]).includes(ep)
    ? classifyCsidResponse(ep as CsidEndpoint, f.httpStatus!, f.raw, c)
    : classifyInvoiceResponse(ep as InvoiceEndpoint, f.httpStatus!, f.raw, c);
}

test('كل مثبّت: مصدر ودرجة دليل، ويُصنَّف كما هو متوقَّع — ولا مثبّت بلا توقّع', () => {
  const names = z3FixtureNames();
  const responses = names.filter(n => z3Fixture(n).kind === 'response');
  assert.deepEqual([...responses].sort(), Object.keys(EXPECT).sort());
  for (const n of names) {
    const f = z3Fixture(n);
    assert.ok(f.source.length > 10, `${n}: source`);
    assert.ok(['OFFICIAL', 'STAFF', 'COMMUNITY', '3P'].includes(f.evidence), `${n}: evidence`);
    assert.equal(f.name, n);
  }
  for (const [n, e] of Object.entries(EXPECT)) {
    assert.equal(classifyFixture(n, e.counts).kind, e.kind, n);
  }
  // مثبّتات الأخطاء المشتركة تُصنَّف بالحالة على كل مسار
  for (const ep of INVOICE_EPS) {
    assert.deepEqual(classifyInvoiceResponse(ep, 401, z3Fixture('error-401').raw, NONE), { kind: 'AUTH' });
    assert.deepEqual(classifyInvoiceResponse(ep, 406, z3Fixture('error-406').raw, NONE), { kind: 'CONFIG', detail: 'version-not-accepted' });
    assert.deepEqual(classifyInvoiceResponse(ep, 500, z3Fixture('error-500-http-errors').raw, NONE), { kind: 'RETRY', reason: 'server' });
  }
  for (const ep of CSID_EPS) {
    assert.deepEqual(classifyCsidResponse(ep, 401, z3Fixture('error-401').raw, NONE), { kind: 'AUTH' });
    assert.deepEqual(classifyCsidResponse(ep, 406, z3Fixture('error-406').raw, NONE), { kind: 'CONFIG', detail: 'version-not-accepted' });
    assert.deepEqual(classifyCsidResponse(ep, 500, z3Fixture('error-500-invalid-request').raw, NONE), { kind: 'RETRY', reason: 'server' });
  }
  assert.equal(guardHits(), 0);
});

// ─── جدول design §3 Z3 صفاً صفاً ───

test('صفّ 200/202 ⇒ ACCEPTED: التحذيرات محفوظة، وclearedInvoice يُحفظ في الاعتماد', () => {
  assert.deepEqual(classifyInvoiceResponse('reporting', 200, z3Fixture('reporting-200').raw, NONE), { kind: 'ACCEPTED', warnings: [] });
  const r202 = classifyInvoiceResponse('reporting', 202, z3Fixture('reporting-202').raw, NONE);
  assert.equal(r202.kind, 'ACCEPTED');
  if (r202.kind !== 'ACCEPTED') return;
  assert.deepEqual(codes(r202.warnings), ['BR-CO-17', 'BR-KSA-98']);
  assert.equal(r202.warnings[1].message, 'The simplified invoice should be submitted within 24 hours of issuing the invoice.');
  assert.equal(r202.warnings[1].type, 'WARNING');
  assert.equal(r202.warnings[1].status, 'WARNING');
  assert.equal(r202.clearedXmlB64, undefined);

  const c200 = classifyInvoiceResponse('clearance', 200, z3Fixture('clearance-200').raw, NONE);
  assert.deepEqual(c200, { kind: 'ACCEPTED', warnings: [], clearedXmlB64: STUB_B64 });
  const c202 = classifyInvoiceResponse('clearance', 202, z3Fixture('clearance-202').raw, NONE);
  assert.equal(c202.kind === 'ACCEPTED' && c202.clearedXmlB64, STUB_B64);
  assert.deepEqual(c202.kind === 'ACCEPTED' && codes(c202.warnings), ['BR-KSA-51']);
  // clearedInvoice حين يرد في مسار آخر يُحفظ كذلك
  const ci = z3Body('compliance-invoices-200');
  ci.clearanceStatus = 'CLEARED';
  ci.clearedInvoice = STUB_B64;
  assert.deepEqual(classifyInvoiceResponse('compliance-invoices', 200, JSON.stringify(ci), NONE), { kind: 'ACCEPTED', warnings: [], clearedXmlB64: STUB_B64 });
});

test('2xx لا يُقبل حين يناقضه الجسم أو يغيب المستند المعتمد أو يتعذّر قراءته', () => {
  const rep = z3Body<Record<string, unknown>>('reporting-200');
  rep.reportingStatus = 'NOT_REPORTED';
  assert.deepEqual(classifyInvoiceResponse('reporting', 200, JSON.stringify(rep), NONE), { kind: 'CONFIG', detail: 'contradictory-2xx:reporting-status' });
  const withErr = z3Body<{ validationResults: { errorMessages: unknown[]; status: string } }>('reporting-200');
  withErr.validationResults.errorMessages = [{ code: 'BR-KSA-37', message: 'x' }];
  assert.deepEqual(classifyInvoiceResponse('reporting', 200, JSON.stringify(withErr), NONE), { kind: 'CONFIG', detail: 'contradictory-2xx:error-messages' });
  withErr.validationResults.errorMessages = [];
  withErr.validationResults.status = 'ERROR';
  assert.deepEqual(classifyInvoiceResponse('reporting', 202, JSON.stringify(withErr), NONE), { kind: 'CONFIG', detail: 'contradictory-2xx:validation-error' });
  const cl = z3Body<Record<string, unknown>>('clearance-200');
  cl.clearanceStatus = 'NOT_CLEARED';
  assert.deepEqual(classifyInvoiceResponse('clearance', 200, JSON.stringify(cl), NONE), { kind: 'CONFIG', detail: 'contradictory-2xx:clearance-status' });
  // نفس الجسم الصالح للإبلاغ بلا clearedInvoice على مسار الاعتماد
  assert.deepEqual(classifyInvoiceResponse('clearance', 200, z3Fixture('reporting-200').raw, NONE), { kind: 'CONFIG', detail: 'cleared-invoice-missing' });
  const bad = z3Body<Record<string, unknown>>('clearance-200');
  for (const v of ['not base64!', Buffer.from('hello, not xml').toString('base64'), `${STUB_B64.slice(0, 40)}\n${STUB_B64.slice(40)}`, 12345, { x: 1 }]) {
    bad.clearedInvoice = v;
    assert.deepEqual(classifyInvoiceResponse('clearance', 200, JSON.stringify(bad), NONE), { kind: 'CONFIG', detail: 'cleared-invoice-invalid' }, String(v));
    assert.deepEqual(classifyInvoiceResponse('reporting', 200, JSON.stringify({ ...bad, clearanceStatus: null }), NONE), { kind: 'CONFIG', detail: 'cleared-invoice-invalid' });
  }
  // "" = غياب المستند لا مستند معيب: على الاعتماد «مفقود»، وعلى الإبلاغ مقبول بلا مستند
  bad.clearedInvoice = '';
  assert.deepEqual(classifyInvoiceResponse('clearance', 200, JSON.stringify(bad), NONE), { kind: 'CONFIG', detail: 'cleared-invoice-missing' });
  const repEmpty = z3Body<Record<string, unknown>>('reporting-200');
  repEmpty.clearedInvoice = '';
  assert.deepEqual(classifyInvoiceResponse('reporting', 200, JSON.stringify(repEmpty), NONE), { kind: 'ACCEPTED', warnings: [] });
  for (const body of ['<html>502</html>', '', '   ', null, '[1,2]', '"text"', '42']) {
    const r = classifyInvoiceResponse('reporting', 200, body, NONE);
    assert.equal(r.kind, 'CONFIG', String(body));
    assert.ok(r.kind === 'CONFIG' && ['unparseable-body', 'empty-body'].includes(r.detail), String(body));
  }
  // compliance/invoices لمستند قياسي: CLEARED مع reportingStatus null مقبول، والسلبيّان معاً مناقضة
  const std = z3Body<Record<string, unknown>>('compliance-invoices-200');
  std.reportingStatus = null;
  std.clearanceStatus = 'CLEARED';
  assert.equal(classifyInvoiceResponse('compliance-invoices', 200, JSON.stringify(std), NONE).kind, 'ACCEPTED');
  std.reportingStatus = 'NOT_REPORTED';
  std.clearanceStatus = 'NOT_CLEARED';
  assert.equal(classifyInvoiceResponse('compliance-invoices', 200, JSON.stringify(std), NONE).kind, 'CONFIG');
  // V1 القديمة "Not Reported" مع 200
  assert.deepEqual(classifyInvoiceResponse('reporting', 200, JSON.stringify({ status: 'Not Reported', errors: [] }), NONE), { kind: 'CONFIG', detail: 'contradictory-2xx:legacy-status' });
});

test('صفّ 409 على الإبلاغ ⇒ DUPLICATE [D3932]، وصفّ 208 على الاعتماد ⇒ DUPLICATE مع المستند المعتمد', () => {
  assert.deepEqual(classifyInvoiceResponse('reporting', 409, z3Fixture('reporting-409-production').raw, NONE), { kind: 'DUPLICATE' });
  assert.deepEqual(classifyInvoiceResponse('reporting', 409, z3Fixture('reporting-409-sandbox').raw, NONE), { kind: 'DUPLICATE' });
  assert.deepEqual(classifyInvoiceResponse('reporting', 409, 'Conflict', NONE), { kind: 'DUPLICATE' }, 'الحالة وحدها تكفي');
  assert.deepEqual(classifyInvoiceResponse('reporting', 409, '', NONE), { kind: 'DUPLICATE' });
  assert.deepEqual(classifyInvoiceResponse('clearance', 208, z3Fixture('clearance-208').raw, NONE), { kind: 'DUPLICATE', clearedXmlB64: STUB_B64 });
  // UNVERIFIED(U8): 409 على الاعتماد، وتكرار بلا clearedInvoice [ZKIT]
  assert.deepEqual(classifyInvoiceResponse('clearance', 409, z3Fixture('clearance-208').raw, NONE), { kind: 'DUPLICATE', clearedXmlB64: STUB_B64 });
  const noXml = z3Body<Record<string, unknown>>('clearance-208');
  delete noXml.clearedInvoice;
  assert.deepEqual(classifyInvoiceResponse('clearance', 208, JSON.stringify(noXml), NONE), { kind: 'DUPLICATE' });
  noXml.clearedInvoice = 'garbage';
  assert.deepEqual(classifyInvoiceResponse('clearance', 208, JSON.stringify(noXml), NONE), { kind: 'CONFIG', detail: 'cleared-invoice-invalid' }, 'المستند متوقَّع على الاعتماد');
  noXml.clearedInvoice = '';
  assert.deepEqual(classifyInvoiceResponse('clearance', 208, JSON.stringify(noXml), NONE), { kind: 'DUPLICATE' }, '"" = بلا مستند');
  assert.deepEqual(classifyInvoiceResponse('clearance', 208, new BodyTooLarge(9e6), NONE), { kind: 'CONFIG', detail: 'body-too-large' }, 'جسم مقصوص قد يخفي المستند');

  // clearedInvoice يُتحقّق منه حيث يُستهلك فقط: على 409 الإبلاغ الحالة وحدها تكفي، فحقل معيب أو "" لا يوقف الوحدة
  for (const v of ['', 'garbage', 12345, { x: 1 }]) {
    const dup = z3Body<Record<string, unknown>>('reporting-409-production');
    dup.clearedInvoice = v;
    assert.deepEqual(classifyInvoiceResponse('reporting', 409, JSON.stringify(dup), NONE), { kind: 'DUPLICATE' }, JSON.stringify(v));
    assert.deepEqual(classifyInvoiceResponse('compliance-invoices', 409, JSON.stringify(dup), NONE), { kind: 'DUPLICATE' }, JSON.stringify(v));
  }
});

test('400 برسائل حقيقية ⇒ REJECTED مهما كان clearedInvoice ("" أو معيباً) — الحقل لا يُقرأ على 400', () => {
  for (const v of ['', 'garbage', Buffer.from('not xml').toString('base64'), 42, { x: 1 }, STUB_B64]) {
    const b = z3Body<Record<string, unknown>>('clearance-400');
    b.clearedInvoice = v;
    const r = classifyInvoiceResponse('clearance', 400, JSON.stringify(b), NONE);
    assert.equal(r.kind, 'REJECTED', JSON.stringify(v));
    assert.deepEqual(r.kind === 'REJECTED' && codes(r.errors), ['BR-KSA-14'], JSON.stringify(v));
    // ومع رسائل null: RETRY empty400 لا CONFIG
    const empty = { validationResults: { errorMessages: [{ code: null, message: null, category: null }] }, clearedInvoice: v };
    assert.deepEqual(classifyInvoiceResponse('clearance', 400, JSON.stringify(empty), NONE), { kind: 'RETRY', reason: 'empty400' }, JSON.stringify(v));
  }
});

test('صفّ 303 ⇒ CLEARANCE_OFF على الاعتماد فقط؛ على الإبلاغ والامتثال CONFIG', () => {
  assert.deepEqual(classifyInvoiceResponse('clearance', 303, z3Fixture('clearance-303').raw, NONE), { kind: 'CLEARANCE_OFF' });
  assert.deepEqual(classifyInvoiceResponse('clearance', 303, null, NONE), { kind: 'CLEARANCE_OFF' });
  assert.deepEqual(classifyInvoiceResponse('clearance', 303, new BodyTooLarge(1e9), NONE), { kind: 'CLEARANCE_OFF' });
  assert.deepEqual(classifyInvoiceResponse('reporting', 303, z3Fixture('clearance-303').raw, NONE), { kind: 'CONFIG', detail: 'unexpected-status:303' });
  assert.deepEqual(classifyInvoiceResponse('compliance-invoices', 303, '', NONE), { kind: 'CONFIG', detail: 'unexpected-status:303' });
  assert.deepEqual(classifyCsidResponse('compliance', 303, '', NONE), { kind: 'CONFIG', detail: 'unexpected-status:303' });
  // رسالة 303 نفسها تُقرأ بالشكل المسطّح {message}
  assert.deepEqual(extractMessages(z3Body('clearance-303')).errors.map(m => m.message), ['Clearance is deactiviated. Please use the /invoices/reporting/single endpoint instead.']);
});

test('صفّ 400 برسالة غير فارغة ⇒ REJECTED بالأخطاء والتحذيرات', () => {
  const r = classifyInvoiceResponse('reporting', 400, z3Fixture('reporting-400').raw, NONE);
  assert.equal(r.kind, 'REJECTED');
  if (r.kind !== 'REJECTED') return;
  assert.deepEqual(codes(r.errors), ['invalid-invoice-hash', 'XSD_ZATCA_INVALID']);
  assert.equal(r.errors[0].category, 'INVOICE_HASHING_ERRORS');
  assert.equal(r.errors[0].type, 'ERROR');
  assert.deepEqual(r.warnings, []);
  const c = classifyInvoiceResponse('clearance', 400, z3Fixture('clearance-400').raw, NONE);
  assert.deepEqual(c.kind === 'REJECTED' && codes(c.errors), ['BR-KSA-14']);
  const ci = classifyInvoiceResponse('compliance-invoices', 400, z3Fixture('compliance-invoices-400').raw, counts(99, 99));
  assert.deepEqual(ci.kind === 'REJECTED' && codes(ci.errors), ['BR-KSA-37', 'BR-KSA-09'], 'الرفض برسائل لا يتأثّر بعدّادات التصعيد');
  // رسالة بلا code/message لكن بفئة تكفي؛ والتحذيرات تُحمل مع الرفض
  const mixed = { validationResults: { warningMessages: [{ code: 'BR-KSA-98', message: 'late' }], errorMessages: [{ code: null, category: 'KSA', message: null }], status: 'ERROR' } };
  const m = classifyInvoiceResponse('reporting', 400, JSON.stringify(mixed), NONE);
  assert.equal(m.kind, 'REJECTED');
  assert.deepEqual(m.kind === 'REJECTED' && codes(m.warnings), ['BR-KSA-98']);
});

test('صفّ 400 بكل الرسائل null ⇒ RETRY empty400 لأول ثلاثة ردود فارغة ثم REJECTED في الرابع [D1399] — بعدّاد الردود الفارغة لا برقم المحاولة', () => {
  const raw = z3Fixture('reporting-400-null-messages').raw;
  for (let prior = 0; prior < EMPTY400_MAX_RETRIES; prior++) {
    assert.deepEqual(classifyInvoiceResponse('reporting', 400, raw, counts(prior)), { kind: 'RETRY', reason: 'empty400' }, `priorEmpty400 ${prior}`);
    // ردود 413 سابقة لا تمسّ عدّاد empty400
    assert.deepEqual(classifyInvoiceResponse('reporting', 400, raw, counts(prior, 1)), { kind: 'RETRY', reason: 'empty400' });
  }
  assert.equal(EMPTY400_MAX_RETRIES, 3);
  for (const prior of [EMPTY400_MAX_RETRIES, 49]) {
    const r = classifyInvoiceResponse('reporting', 400, raw, counts(prior));
    assert.equal(r.kind, 'REJECTED');
    assert.equal(r.kind === 'REJECTED' && r.errors.length, 1);
    assert.equal(r.kind === 'REJECTED' && r.errors[0].code, EMPTY400_EXHAUSTED_CODE);
    // الرسالة تذكر عدد الردود الفارغة الفعلي (السابقة + هذا)، لا عدد المحاولات الكلّي
    assert.ok(r.kind === 'REJECTED' && r.errors[0].message!.includes(` ${prior + 1} `), r.kind === 'REJECTED' ? r.errors[0].message! : '');
  }
  // أشكال «بلا رسائل» الأخرى: دلاء فارغة، null، مفقودة، نصوص فارغة؛ والتحذيرات وحدها لا تفسّر رفضاً
  const variants = [
    { validationResults: { infoMessages: [], warningMessages: [], errorMessages: [], status: 'ERROR' }, reportingStatus: 'NOT_REPORTED' },
    { validationResults: { errorMessages: null }, clearanceStatus: 'NOT_CLEARED', clearedInvoice: null },
    { reportingStatus: 'NOT_REPORTED' },
    { validationResults: { errorMessages: [{ code: '', message: '   ', category: '\u0000' }, null] } },
    { validationResults: { warningMessages: [{ code: 'BR-KSA-98', message: 'late' }], errorMessages: [] } },
    {},
  ];
  for (const v of variants) {
    assert.deepEqual(classifyInvoiceResponse('clearance', 400, JSON.stringify(v), counts(2)), { kind: 'RETRY', reason: 'empty400' }, JSON.stringify(v));
    assert.equal(classifyInvoiceResponse('clearance', 400, JSON.stringify(v), counts(3)).kind, 'REJECTED');
  }
  // 400 غير مقروء ليس «رسائل null»: لا يُرفض مستند بناءً على جسم لا نفهمه
  assert.deepEqual(classifyInvoiceResponse('reporting', 400, '<html>Request Rejected</html>', NONE), { kind: 'CONFIG', detail: 'unparseable-body' });
  assert.deepEqual(classifyInvoiceResponse('reporting', 400, '', NONE), { kind: 'CONFIG', detail: 'empty-body' });
  assert.deepEqual(classifyInvoiceResponse('reporting', 400, new BodyTooLarge(1), NONE), { kind: 'CONFIG', detail: 'body-too-large' });
});

test('صفّ 413 ⇒ RETRY payload مرة ثم CONFIG؛ 429 ⇒ rate؛ 500/502/503/504 ⇒ server؛ 401 ⇒ AUTH؛ 406 ⇒ CONFIG — مهما كان الجسم', () => {
  const bodies: unknown[] = ['', '<html>gateway</html>', '{"message":"x"}', new BodyTooLarge(1e9), null, Buffer.from([0xff, 0xfe, 0x00])];
  for (const ep of INVOICE_EPS) {
    for (const body of bodies) {
      assert.deepEqual(classifyInvoiceResponse(ep, 413, body, NONE), { kind: 'RETRY', reason: 'payload' });
      assert.deepEqual(classifyInvoiceResponse(ep, 413, body, counts(0, 1)), { kind: 'CONFIG', detail: 'payload-too-large' });
      // ردود empty400 سابقة (أو أي عدد محاولات أخرى) لا تُسقط إعادة 413 الوحيدة
      assert.deepEqual(classifyInvoiceResponse(ep, 413, body, counts(3, 0)), { kind: 'RETRY', reason: 'payload' });
      assert.deepEqual(classifyInvoiceResponse(ep, 429, body, NONE), { kind: 'RETRY', reason: 'rate' });
      for (const s of [500, 502, 503, 504]) assert.deepEqual(classifyInvoiceResponse(ep, s, body, NONE), { kind: 'RETRY', reason: 'server' });
      assert.deepEqual(classifyInvoiceResponse(ep, 401, body, NONE), { kind: 'AUTH' });
      assert.deepEqual(classifyInvoiceResponse(ep, 406, body, NONE), { kind: 'CONFIG', detail: 'version-not-accepted' });
    }
  }
  for (const ep of CSID_EPS) {
    assert.deepEqual(classifyCsidResponse(ep, 413, '', NONE), { kind: 'RETRY', reason: 'payload' });
    assert.deepEqual(classifyCsidResponse(ep, 413, '', counts(0, PAYLOAD413_MAX_RETRIES)), { kind: 'CONFIG', detail: 'payload-too-large' });
    assert.deepEqual(classifyCsidResponse(ep, 429, '', NONE), { kind: 'RETRY', reason: 'rate' });
    assert.deepEqual(classifyCsidResponse(ep, 504, new BodyTooLarge(5), NONE), { kind: 'RETRY', reason: 'server' });
  }
  assert.equal(classifyInvoiceResponse('reporting', 406, z3Fixture('error-406').raw, NONE).kind, 'CONFIG');
  assert.equal(z3Fixture('error-406').raw, 'This Version is not supported or not provided in the header.');
});

test('حالات غير متوقَّعة ومُدخلات تصنيف معيبة ⇒ CONFIG برمز آمن لا يحمل شيئاً من الجسم', () => {
  const marker = 'SECRET-MARKER-9f2c';
  for (const s of [100, 201, 204, 206, 301, 302, 307, 403, 404, 405, 415, 418, 422, 428, 451, 501, 505, 599]) {
    const r = classifyInvoiceResponse('reporting', s, `{"message":"${marker}"}`, NONE);
    assert.deepEqual(r, { kind: 'CONFIG', detail: `unexpected-status:${s}` });
  }
  for (const s of [0, 99, 600, -1, 200.5, NaN, Infinity]) {
    assert.deepEqual(classifyInvoiceResponse('reporting', s, marker, NONE), { kind: 'CONFIG', detail: 'invalid-status' });
    assert.deepEqual(classifyCsidResponse('compliance', s, marker, NONE), { kind: 'CONFIG', detail: 'invalid-status' });
  }
  // عدّادات التصعيد مطلوبة وصريحة: رقم محاولة قديم الشكل، أو قيم سالبة/كسرية/ضخمة، أو حقل مفقود ⇒ CONFIG
  const badCounts: unknown[] = [
    1, 4, undefined, null, '0', {}, { priorEmpty400: 0 }, { priorPayload413: 0 }, counts(-1), counts(1.5), counts(NaN), counts(0, -1),
    counts(MAX_ESCALATION_COUNT + 1), counts(Number.MAX_VALUE), { priorEmpty400: '1', priorPayload413: 0 },
  ];
  for (const c of badCounts) {
    assert.deepEqual(classifyInvoiceResponse('reporting', 400, z3Fixture('reporting-400-null-messages').raw, c as EscalationCounts), { kind: 'CONFIG', detail: 'invalid-counts' }, JSON.stringify(c));
    assert.deepEqual(classifyCsidResponse('compliance', 200, z3Fixture('compliance-200').raw, c as EscalationCounts), { kind: 'CONFIG', detail: 'invalid-counts' }, JSON.stringify(c));
  }
  assert.equal(classifyInvoiceResponse('reporting', 400, z3Fixture('reporting-400-null-messages').raw, counts(MAX_ESCALATION_COUNT)).kind, 'REJECTED');
  assert.deepEqual(classifyInvoiceResponse('compliance' as InvoiceEndpoint, 200, '{}', NONE), { kind: 'CONFIG', detail: 'unknown-endpoint' });
  assert.deepEqual(classifyCsidResponse('reporting' as CsidEndpoint, 200, '{}', NONE), { kind: 'CONFIG', detail: 'unknown-endpoint' });
  // كائن محلَّل مسبقاً بـgetter يرمي: لا رمي أبداً
  const hostile = { get validationResults() { throw new Error(marker); } };
  assert.deepEqual(classifyInvoiceResponse('reporting', 200, hostile, NONE), { kind: 'CONFIG', detail: 'classifier-internal-error' });
  const hostileCsid = { get binarySecurityToken() { throw new Error(marker); } };
  assert.deepEqual(classifyCsidResponse('compliance', 200, hostileCsid, NONE), { kind: 'CONFIG', detail: 'classifier-internal-error' });
});

test('responseNeedsBody: الحالات التي يعتمد تصنيفها على الجسم فقط', () => {
  for (const ep of INVOICE_EPS) {
    for (const s of [200, 202, 208, 400, 409]) assert.equal(responseNeedsBody(ep, s), true, `${ep} ${s}`);
    for (const s of [303, 401, 406, 413, 428, 429, 500, 502, 503, 504, 418]) assert.equal(responseNeedsBody(ep, s), false, `${ep} ${s}`);
  }
  for (const ep of CSID_EPS) {
    for (const s of [200, 400]) assert.equal(responseNeedsBody(ep, s), true);
    assert.equal(responseNeedsBody(ep, 428), ep === 'renewal');
    for (const s of [202, 208, 409, 401, 500]) assert.equal(responseNeedsBody(ep, s), false);
  }
});

// ─── الشهادات ───

test('CSID 200 ⇒ ISSUED بالرمز والسرّ حرفياً، وrequestID نصاً [SWG]', () => {
  const f = z3Body<Record<string, string>>('compliance-200');
  const r = classifyCsidResponse('compliance', 200, z3Fixture('compliance-200').raw, NONE);
  assert.equal(r.kind, 'ISSUED');
  if (r.kind !== 'ISSUED') return;
  assert.equal(r.csid.requestID, '1234567890123');
  assert.equal(r.csid.dispositionMessage, 'ISSUED');
  assert.equal(r.csid.binarySecurityToken, f.binarySecurityToken);
  assert.ok(r.csid.binarySecurityToken.startsWith('TUlJQ1BUQ0NBZU9n'));
  assert.equal(r.csid.secret, 'Dehvg1fc8GF6Jwt5bOxXwC6enR93VxeNEo2mlUatfgw=');
  assert.equal(r.csid.tokenType, null);
  assert.deepEqual(r.csid.errors, []);
  assert.deepEqual(Object.keys(r.csid).sort(), ['binarySecurityToken', 'dispositionMessage', 'errors', 'requestID', 'secret', 'tokenType']);

  assert.equal(classifyCsidResponse('compliance', 200, z3Fixture('compliance-200-errors-null').raw, NONE).kind, 'ISSUED');
  const p = classifyCsidResponse('production-csid', 200, z3Fixture('production-csid-200').raw, NONE);
  assert.equal(p.kind === 'ISSUED' && p.csid.requestID, '1642424139872');
  const rn = classifyCsidResponse('renewal', 200, z3Fixture('renewal-200').raw, NONE);
  assert.equal(rn.kind === 'ISSUED' && rn.csid.tokenType, 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3');
});

test('CSID: السرّ والرمز لا يظهران في JSON.stringify ولا util.inspect، والحقول تبقى مقروءة', () => {
  const raw = z3Fixture('compliance-200').raw;
  const f = z3Body<Record<string, string>>('compliance-200');
  const r = classifyCsidResponse('compliance', 200, raw, NONE);
  const n = classifyCsidResponse('renewal', 428, z3Fixture('renewal-428').raw, NONE);
  for (const o of [r, n]) {
    for (const text of [JSON.stringify(o), inspect(o, { depth: 10 }), JSON.stringify({ wrapped: [o] })]) {
      assert.ok(!text.includes(f.secret) && !text.includes('goDgeIdM5mkfTThl1unu8rP9XhknKWAc24hafXZS1f4='), 'secret leaked');
      assert.ok(!text.includes(f.binarySecurityToken.slice(0, 40)), 'token leaked');
      assert.match(text, /\[REDACTED\]/);
    }
  }
  assert.equal(r.kind === 'ISSUED' && r.csid.secret, f.secret, 'القراءة المباشرة متاحة لـZ4');
  assert.match(JSON.stringify(r), /1234567890123/);
});

test('PATCH 428 ⇒ NOT_COMPLIANT مع شهادة الامتثال الجديدة؛ و428 على غير التجديد أو ناقصاً ⇒ CONFIG', () => {
  const n = classifyCsidResponse('renewal', 428, z3Fixture('renewal-428').raw, NONE);
  assert.equal(n.kind, 'NOT_COMPLIANT');
  if (n.kind !== 'NOT_COMPLIANT') return;
  assert.equal(n.ccsid.requestID, '1234567890123');
  assert.equal(n.ccsid.dispositionMessage, 'NOT_COMPLIANT');
  assert.equal(n.ccsid.secret, 'goDgeIdM5mkfTThl1unu8rP9XhknKWAc24hafXZS1f4=');
  assert.deepEqual(classifyCsidResponse('compliance', 428, z3Fixture('renewal-428').raw, NONE), { kind: 'CONFIG', detail: 'unexpected-status:428' });
  assert.deepEqual(classifyCsidResponse('production-csid', 428, z3Fixture('renewal-428').raw, NONE), { kind: 'CONFIG', detail: 'unexpected-status:428' });
  const noToken = z3Body<Record<string, unknown>>('renewal-428');
  noToken.binarySecurityToken = null;
  assert.deepEqual(classifyCsidResponse('renewal', 428, JSON.stringify(noToken), NONE), { kind: 'CONFIG', detail: 'csid-incomplete:binarySecurityToken' });
  const noId = z3Body<Record<string, unknown>>('renewal-428');
  delete noId.requestID;
  assert.deepEqual(classifyCsidResponse('renewal', 428, JSON.stringify(noId), NONE), { kind: 'CONFIG', detail: 'csid-incomplete:requestID' }, 'بلا requestID لا يمكن طلب شهادة الإنتاج بعد الفحوص');
  assert.deepEqual(classifyCsidResponse('renewal', 428, '<html/>', NONE), { kind: 'CONFIG', detail: 'unparseable-body' });
  // UNVERIFIED(zatca-kit): NOT_COMPLIANT مع 200 على التجديد
  assert.equal(classifyCsidResponse('renewal', 200, z3Fixture('renewal-428').raw, NONE).kind, 'NOT_COMPLIANT');
  assert.equal(classifyCsidResponse('renewal', 200, JSON.stringify(noToken), NONE).kind, 'REJECTED');
  const spaced = z3Body<Record<string, unknown>>('renewal-428');
  spaced.dispositionMessage = 'Not Compliant';
  assert.equal(classifyCsidResponse('renewal', 428, JSON.stringify(spaced), NONE).kind, 'NOT_COMPLIANT');
});

test('CSID 400 بكل شكل موثَّق ⇒ REJECTED برسائله (Invalid-OTP، NOT_COMPLIANT، CSR مسطّح، errorCode، Missing-ComplianceSteps)', () => {
  const inv = classifyCsidResponse('compliance', 400, z3Fixture('compliance-400-invalid-otp').raw, NONE);
  assert.deepEqual(inv, { kind: 'REJECTED', dispositionMessage: null, errors: [{ type: 'ERROR', code: 'Invalid-OTP', category: null, message: 'The provided OTP is invalid', status: null }] });

  const nc = classifyCsidResponse('compliance', 400, z3Fixture('compliance-400-not-compliant').raw, NONE);
  assert.equal(nc.kind, 'REJECTED');
  assert.equal(nc.kind === 'REJECTED' && nc.dispositionMessage, 'NOT_COMPLIANT');
  assert.deepEqual(nc.kind === 'REJECTED' && nc.errors.map(e => e.message), ['unable to submit and sign the csr...']);

  const flat = classifyCsidResponse('renewal', 400, z3Fixture('compliance-400-csr-flat').raw, NONE);
  assert.deepEqual(flat.kind === 'REJECTED' && flat.errors, [{
    type: 'ERROR', code: 'EXCEED_CHARACTER_LIMIT', category: 'CSR_VALIDATION', status: 'ERROR',
    message: 'The provided Certificate Signing Request (CSR) is invalid. Maximum number of characters for Serial Number should be less than or equal to 64.',
  }]);

  const ec = classifyCsidResponse('compliance', 400, z3Fixture('compliance-400-errorcode').raw, NONE);
  assert.deepEqual(ec.kind === 'REJECTED' && ec.errors, [{ type: 'ERROR', code: '400', category: 'Invalid-CSR', message: 'The provided Certificate Signing Request (CSR) is invalid.', status: null }]);

  for (const n of ['production-csid-400-missing-steps', 'production-csid-400-missing-steps-production']) {
    const r = classifyCsidResponse('production-csid', 400, z3Fixture(n).raw, NONE);
    assert.deepEqual(r.kind === 'REJECTED' && codes(r.errors), ['Missing-ComplianceSteps'], n);
  }
  // 400 على الشهادات لا يُعاد: حتى بلا رسائل هو رفض (الرمز استُهلك)، وغير المقروء CONFIG
  assert.deepEqual(classifyCsidResponse('compliance', 400, '{}', NONE), { kind: 'REJECTED', errors: [], dispositionMessage: null });
  assert.deepEqual(classifyCsidResponse('compliance', 400, 'Bad Request', NONE), { kind: 'CONFIG', detail: 'unparseable-body' });
  assert.deepEqual(classifyCsidResponse('compliance', 400, '', NONE), { kind: 'CONFIG', detail: 'empty-body' });
});

test('CSID 200 ناقص أو معيب ⇒ CONFIG باسم الحقل (بلا قيمة)، وdispositionMessage غير ISSUED ⇒ REJECTED', () => {
  const base = () => z3Body<Record<string, unknown>>('compliance-200');
  const cases: Array<[string, (o: Record<string, unknown>) => void, CsidEndpoint, unknown]> = [
    ['token مفقود', o => delete o.binarySecurityToken, 'compliance', { kind: 'CONFIG', detail: 'csid-incomplete:binarySecurityToken' }],
    ['token بسطر جديد', o => { o.binarySecurityToken = `${String(o.binarySecurityToken).slice(0, 76)}\n${String(o.binarySecurityToken).slice(76)}`; }, 'compliance', { kind: 'CONFIG', detail: 'csid-incomplete:binarySecurityToken' }],
    ['token طويل جداً', o => { o.binarySecurityToken = 'QUFB'.repeat(MAX_CSID_TOKEN_CHARS / 4 + 1); }, 'production-csid', { kind: 'CONFIG', detail: 'csid-incomplete:binarySecurityToken' }],
    ['token عدد', o => { o.binarySecurityToken = 5; }, 'renewal', { kind: 'CONFIG', detail: 'csid-incomplete:binarySecurityToken' }],
    ['secret فارغ', o => { o.secret = ''; }, 'compliance', { kind: 'CONFIG', detail: 'csid-incomplete:secret' }],
    ['secret بفراغ', o => { o.secret = 'abc def'; }, 'compliance', { kind: 'CONFIG', detail: 'csid-incomplete:secret' }],
    ['requestID مفقود على /compliance', o => delete o.requestID, 'compliance', { kind: 'CONFIG', detail: 'csid-incomplete:requestID' }],
    ['requestID سالب', o => { o.requestID = -2; }, 'compliance', { kind: 'CONFIG', detail: 'csid-incomplete:requestID' }],
    ['requestID نصّ غير رقمي', o => { o.requestID = '12a'; }, 'compliance', { kind: 'CONFIG', detail: 'csid-incomplete:requestID' }],
    ['REJECTED disposition', o => { o.dispositionMessage = 'REJECTED'; }, 'compliance', 'REJECTED'],
    ['NOT_COMPLIANT على /compliance', o => { o.dispositionMessage = 'NOT_COMPLIANT'; }, 'compliance', 'REJECTED'],
  ];
  for (const [label, mutate, ep, want] of cases) {
    const o = base();
    mutate(o);
    const r = classifyCsidResponse(ep, 200, JSON.stringify(o), NONE);
    if (typeof want === 'string') assert.equal(r.kind, want, label);
    else assert.deepEqual(r, want, label);
    if (r.kind === 'CONFIG') assert.match(r.detail, SAFE_DETAIL);
  }
  // requestID اختياري لشهادة الإنتاج؛ dispositionMessage غائب مع بيانات كاملة مقبول تسامحاً
  const o = base();
  delete o.requestID;
  const p = classifyCsidResponse('production-csid', 200, JSON.stringify(o), NONE);
  assert.equal(p.kind === 'ISSUED' && p.csid.requestID, null);
  const d = base();
  delete d.dispositionMessage;
  assert.equal(classifyCsidResponse('compliance', 200, JSON.stringify(d), NONE).kind, 'ISSUED');
  assert.deepEqual(classifyCsidResponse('compliance', 202, z3Fixture('compliance-200').raw, NONE), { kind: 'CONFIG', detail: 'unexpected-status:202' });
});

test('requestID: نصّ رقمي كما هو، وعدد يتجاوز 2^53 يُسترجع من النص حرفياً', () => {
  const token = z3Body<Record<string, string>>('compliance-200').binarySecurityToken;
  const raw = `{"requestID": 123456789012345678901 , "dispositionMessage":"ISSUED","binarySecurityToken":"${token}","secret":"s3cr3t=="}`;
  const r = classifyCsidResponse('compliance', 200, raw, NONE);
  assert.equal(r.kind === 'ISSUED' && r.csid.requestID, '123456789012345678901');
  assert.equal(parseCsidResponse({ requestID: '000' })?.requestID, null);
  assert.equal(parseCsidResponse({ requestId: '42' })?.requestID, '42');
  assert.equal(parseCsidResponse({ requestID: 1.5 })?.requestID, null);
  assert.equal(parseCsidResponse({ requestID: 2 ** 60 })?.requestID, null, 'بلا نصّ خام لا تخمين');
  assert.equal(parseCsidResponse([]), null);
});

// ─── أشكال الرسائل ───

test('extractMessages يوحّد كل الأشكال الموثَّقة إلى {type, code, category, message, status}', () => {
  // erroMessages بالإملاء الخاطئ [3P]
  const erro = classifyInvoiceResponse('reporting', 400, z3Fixture('reporting-400-erro-messages').raw, NONE);
  assert.deepEqual(erro.kind === 'REJECTED' && codes(erro.errors), ['BR-KSA-37']);
  const both = extractMessages({ validationResults: { errorMessages: [{ code: 'A' }], erroMessages: [{ code: 'B' }] } });
  assert.deepEqual(codes(both.errors), ['A', 'B']);

  // مثال Swagger المعطوب: infoMessages كائن مفرد وwarningMessages خارج validationResults
  const mal = extractMessages(z3Body('compliance-invoices-200-malformed'));
  assert.deepEqual(codes(mal.info), ['XSD_ZATCA_VALID']);
  assert.equal(mal.info[0].status, 'PASS');
  assert.deepEqual(extractMessages({ warningMessages: { code: 'W1', message: 'outside' } }).warnings.map(m => m.code), ['W1']);

  // errors نصوص [S16] وكائنات [S1]، وerror مفرداً [D9405] بأشكاله
  assert.deepEqual(extractMessages(z3Body('compliance-400-not-compliant')).errors, [{ type: 'ERROR', code: null, category: null, message: 'unable to submit and sign the csr...', status: null }]);
  assert.deepEqual(codes(extractMessages({ error: { code: 'Invalid-CSR', message: 'bad' } }).errors), ['Invalid-CSR']);
  assert.deepEqual(extractMessages({ error: ['one', 'two'] }).errors.map(m => m.message), ['one', 'two']);
  assert.deepEqual(extractMessages({ errors: 'single string' }).errors.map(m => m.message), ['single string']);
  assert.deepEqual(extractMessages({ errors: [42] }).errors.map(m => m.message), ['42']);

  // الشكل المسطّح بنوعه، و{errorCode…}
  assert.deepEqual(codes(extractMessages(z3Body('compliance-400-csr-flat')).errors), ['EXCEED_CHARACTER_LIMIT']);
  assert.deepEqual(codes(extractMessages({ type: 'WARNING', code: 'W', message: 'm' }).warnings), ['W']);
  assert.deepEqual(codes(extractMessages({ type: 'INFO', code: 'I', message: 'm' }).info), ['I']);
  assert.deepEqual(extractMessages(z3Body('compliance-400-errorcode')).errors.map(m => m.category), ['Invalid-CSR']);

  // 401 JSON: status رقمي لا يصير status رسالة، وmessage الفارغ null، وerror يُقرأ
  const e401 = extractMessages(z3Body('error-401'));
  assert.deepEqual(e401.errors.map(m => [m.message, m.status]), [['Unauthorized', null], [null, null]]);
  assert.equal(e401.errors.filter(isMeaningfulMsg).length, 1);

  // 500 بشكليه، والرمز الرقمي نصاً
  assert.deepEqual(extractMessages(z3Body('error-500-invalid-request')).errors.map(m => [m.code, m.message]), [['Invalid-Request', 'System failed to process your request']]);
  assert.deepEqual(extractMessages(z3Body('error-500-http-errors')).errors.map(m => [m.code, m.category]), [['500', 'HTTP-Errors']]);
  assert.equal(extractMessages({ code: 500, message: 'x' }).errors[0].code, '500');

  // V1 القديمة: warnings/errors في المستوى الأعلى
  const v1 = classifyInvoiceResponse('reporting', 400, z3Fixture('reporting-400-legacy-v1').raw, NONE);
  assert.deepEqual(v1.kind === 'REJECTED' && codes(v1.errors), ['Missing-QR-Code', 'Signature-Errors']);
  assert.equal(parseInvoiceResponse(z3Body('reporting-400-legacy-v1'))?.legacyStatus, 'NOT_REPORTED');

  // الدلو مصدر الحقيقة للنوع: type داخل errorMessages لا يغيّر الدلو
  assert.equal(extractMessages({ validationResults: { errorMessages: [{ type: 'INFO', code: 'X' }] } }).errors[0].type, 'ERROR');
  // مدخلات ليست كائنات
  for (const v of [null, undefined, 'x', 42, [1, 2], true]) assert.deepEqual(extractMessages(v), { info: [], warnings: [], errors: [], truncated: false });
});

test('qrSellertStatus / qrBuyertStatus بالإملاء الخاطئ محفوظان، والإملاء الصحيح احتياطٌ فقط', () => {
  const b = z3Body<Record<string, unknown>>('compliance-invoices-200');
  assert.ok(Object.prototype.hasOwnProperty.call(b, 'qrSellertStatus') && Object.prototype.hasOwnProperty.call(b, 'qrBuyertStatus'));
  b.qrSellertStatus = 'PASS';
  b.qrBuyertStatus = 'WARNING';
  const r = parseInvoiceResponse(b)!;
  assert.equal(r.qrSellertStatus, 'PASS');
  assert.equal(r.qrBuyertStatus, 'WARNING');
  assert.equal(r.reportingStatus, 'REPORTED');
  assert.equal(r.clearanceStatus, null);
  assert.equal(r.validationStatus, 'PASS');
  const fixed = parseInvoiceResponse({ qrSellerStatus: 'OK1', qrBuyerStatus: 'OK2' })!;
  assert.deepEqual([fixed.qrSellertStatus, fixed.qrBuyertStatus], ['OK1', 'OK2']);
  const both = parseInvoiceResponse({ qrSellertStatus: 'TYPO', qrSellerStatus: 'FIXED' })!;
  assert.equal(both.qrSellertStatus, 'TYPO');
  assert.equal(parseInvoiceResponse('x'), null);
});

// ─── الحدود والأجسام العدائية ───

test('الحدود: عدد الرسائل وطولها محدودان، ومحارف التحكّم تُزال، ولا بدائل منفردة', () => {
  const many = { validationResults: { errorMessages: Array.from({ length: 10000 }, (_, i) => ({ code: `E${i}`, message: 'm' })), status: 'ERROR' } };
  // محلَّل مسبقاً: سقف الدلو وحده
  const r = classifyInvoiceResponse('reporting', 400, many, NONE);
  assert.equal(r.kind === 'REJECTED' && r.errors.length, RESPONSE_LIMITS.maxMessagesPerBucket);
  // نصّاً: 2000 رسالة (≈ 10000 رمز بنيوي) تُحلَّل وتُقصّ إلى السقف؛ 10000 رسالة (50000+ رمز) لا تُحلَّل أصلاً
  const some = { validationResults: { errorMessages: many.validationResults.errorMessages.slice(0, 2000), status: 'ERROR' } };
  const r2 = classifyInvoiceResponse('reporting', 400, JSON.stringify(some), NONE);
  assert.equal(r2.kind === 'REJECTED' && r2.errors.length, RESPONSE_LIMITS.maxMessagesPerBucket);
  assert.deepEqual(classifyInvoiceResponse('reporting', 400, JSON.stringify(many), NONE), { kind: 'CONFIG', detail: 'unparseable-body' });
  assert.equal(extractMessages(many).truncated, true);
  assert.equal(extractMessages({ errors: Array(RESPONSE_LIMITS.maxMessagesPerBucket).fill('x') }).truncated, false);
  assert.equal(extractMessages({ errors: Array(RESPONSE_LIMITS.maxMessagesPerBucket + 1).fill('x') }).truncated, true);

  const long = extractMessages({ errors: [{ code: 'C'.repeat(10000), category: 'K'.repeat(10000), message: 'م'.repeat(1_000_000), status: 'S'.repeat(500) }] }).errors[0];
  assert.ok(long.message!.length <= RESPONSE_LIMITS.maxMessageChars);
  assert.ok(long.code!.length <= RESPONSE_LIMITS.maxCodeChars);
  assert.ok(long.category!.length <= RESPONSE_LIMITS.maxCategoryChars);
  assert.ok(long.status!.length <= RESPONSE_LIMITS.maxStatusChars);
  assert.ok(long.message!.endsWith('…'));

  assert.equal(cleanText('a\u0000b\r\nc\u0085d\u001b[31m', 100), 'a b c d [31m');
  assert.equal(cleanText('\ud83d', 10), '\ufffd');
  assert.equal(cleanText('😀'.repeat(10), 6)!.includes('\ud83d…'), false, 'القصّ لا يشطر زوج بدائل');
  assert.equal(cleanText({ toString: () => 'x' }, 10), null);
  assert.equal(cleanText(NaN, 10), null);
});

test('أجسام ضخمة أو معطوبة أو عدائية: لا رمي، وتصنيف محافظ', () => {
  const max = RESPONSE_LIMITS.maxBodyBytes;
  assert.deepEqual(parseResponseBody('x'.repeat(max + 1)), { kind: 'too-large', bytes: max + 1 });
  assert.equal(parseResponseBody(new Uint8Array(max + 1)).kind, 'too-large');
  assert.equal(parseResponseBody('م'.repeat(Math.floor(max / 2) + 1)).kind, 'too-large', 'الحدّ بالبايتات لا بالمحارف');
  assert.deepEqual(classifyInvoiceResponse('reporting', 200, 'x'.repeat(max + 1), NONE), { kind: 'CONFIG', detail: 'body-too-large' });
  assert.deepEqual(classifyInvoiceResponse('reporting', 503, 'x'.repeat(max + 1), NONE), { kind: 'RETRY', reason: 'server' });
  assert.deepEqual(classifyCsidResponse('compliance', 200, new BodyTooLarge(max + 1), NONE), { kind: 'CONFIG', detail: 'body-too-large' });

  // تعشيش عميق جداً، وبايتات عشوائية، وUTF-8 غير صالح، وBOM
  const deep = `${'['.repeat(200000)}${']'.repeat(200000)}`;
  assert.equal(classifyInvoiceResponse('reporting', 200, deep, NONE).kind, 'CONFIG');
  assert.equal(classifyInvoiceResponse('reporting', 400, `{"a":${'{"a":'.repeat(100000)}1${'}'.repeat(100001)}`, NONE).kind !== undefined, true);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 0x100000000);
  const garbage = Buffer.from(Array.from({ length: 1 << 20 }, () => Math.floor(rnd() * 256)));
  for (const s of [200, 202, 208, 400, 409]) assert.equal(typeof classifyInvoiceResponse('clearance', s, garbage, NONE).kind, 'string');
  assert.equal(parseResponseBody(Buffer.from([0xff, 0xfe, 0xfd])).kind, 'text');
  assert.equal(classifyInvoiceResponse('reporting', 200, `\ufeff${z3Fixture('reporting-200').raw}`, NONE).kind, 'ACCEPTED');
  assert.equal(classifyInvoiceResponse('reporting', 200, Buffer.from(`\ufeff${z3Fixture('reporting-200').raw}`, 'utf8'), NONE).kind, 'ACCEPTED');
  const sub = Buffer.from(`xx${z3Fixture('reporting-200').raw}yy`).subarray(2, -2);
  assert.equal(classifyInvoiceResponse('reporting', 200, sub, NONE).kind, 'ACCEPTED', 'Uint8Array جزئي يُقرأ بإزاحته');

  // __proto__ في JSON لا يلوّث ولا يُقرأ كحقل موروث
  const proto = '{"__proto__":{"validationResults":{"errorMessages":[{"code":"X"}]},"clearedInvoice":"bad"},"reportingStatus":"REPORTED"}';
  assert.deepEqual(classifyInvoiceResponse('reporting', 200, proto, NONE), { kind: 'ACCEPTED', warnings: [] });
  assert.equal(({} as Record<string, unknown>).validationResults, undefined);
});

test('سقف الجسم لكل مسار وحالة: 8 MiB حيث قد يرد clearedInvoice فقط، 1 MiB لرفض المستندات، 64 KiB لما عداهما', () => {
  const { maxBodyBytes: big, maxRejectionBodyBytes: mid, maxSmallBodyBytes: small } = RESPONSE_LIMITS;
  assert.deepEqual([big, mid, small], [8 * 1024 * 1024, 1024 * 1024, 64 * 1024]);
  for (const ep of INVOICE_EPS) {
    for (const s of [200, 202, 208, 409]) assert.equal(responseBodyCap(ep, s), big, `${ep} ${s}`);
    assert.equal(responseBodyCap(ep, 400), mid);
    for (const s of [303, 401, 406, 413, 429, 500, 502, 503, 504, 418]) assert.equal(responseBodyCap(ep, s), small, `${ep} ${s}`);
  }
  for (const ep of CSID_EPS) for (const s of [200, 400, 428, 401, 500, 503]) assert.equal(responseBodyCap(ep, s), small, `${ep} ${s}`);
  // شهادة CSID بأقصى طول تتّسع في السقف الصغير
  assert.ok(MAX_CSID_TOKEN_CHARS + 1024 < small);

  // المصنِّف الخالص يطبّق السقف نفسه
  const pad = (n: number) => `{"message":"${'x'.repeat(n)}"}`;
  assert.deepEqual(classifyCsidResponse('compliance', 200, pad(small), NONE), { kind: 'CONFIG', detail: 'body-too-large' });
  assert.deepEqual(classifyInvoiceResponse('reporting', 400, pad(mid), NONE), { kind: 'CONFIG', detail: 'body-too-large' });
  assert.equal(classifyInvoiceResponse('reporting', 400, JSON.stringify({ errors: [{ code: 'E', message: 'x'.repeat(mid - 100) }] }), NONE).kind, 'REJECTED');
  const bigClear = z3Body<Record<string, unknown>>('clearance-200');
  bigClear.clearedInvoice = Buffer.from(`<Invoice>${'a'.repeat(4 * 1024 * 1024)}</Invoice>`).toString('base64');
  assert.equal(classifyInvoiceResponse('clearance', 200, JSON.stringify(bigClear), NONE).kind, 'ACCEPTED', 'مستند بحدّ الختم يمرّ');
});

test('فحص شكل JSON قبل JSON.parse: التعشيش العميق والرموز البنيوية الكثيرة ⇒ text (unparseable-body) بسرعة، والمستند الكبير يمرّ', () => {
  const D = RESPONSE_LIMITS.maxJsonDepth;
  assert.equal(jsonShapeWithinLimits(`${'['.repeat(D)}${']'.repeat(D)}`), true);
  assert.equal(jsonShapeWithinLimits(`${'['.repeat(D + 1)}${']'.repeat(D + 1)}`), false);
  assert.equal(jsonShapeWithinLimits(`{"a":"${'['.repeat(10000)}"}`), true, 'الأقواس داخل النصوص لا تُعدّ');
  assert.equal(jsonShapeWithinLimits(`{"a":"x\\"${'['.repeat(100)}\\\\"}`), true, 'علامة اقتباس مهرّبة لا تُنهي النص، و\\\\ قبل « " » تُنهيه');
  assert.equal(jsonShapeWithinLimits(`["\\\\"${',['.repeat(40)}`), false, 'بعد نهاية النص تُعدّ الرموز والعمق');
  assert.equal(jsonShapeWithinLimits(`[${'1,'.repeat(RESPONSE_LIMITS.maxJsonStructuralTokens)}1]`), false);
  assert.equal(jsonShapeWithinLimits(`[${'1,'.repeat(1000)}1]`), true);
  assert.equal(jsonShapeWithinLimits('{"a":"unterminated'), true, 'غير المغلق يُترك لـJSON.parse');
  for (const n of z3FixtureNames()) assert.equal(jsonShapeWithinLimits(z3Fixture(n).raw), true, `${n}: المثبّتات الحقيقية ضمن الحدود`);

  // أجسام الاستكشاف: 8 MiB تعشيشاً، و[{},{},…]، و["a","a",…] — لا تُحلَّل ولا توقف حلقة الأحداث
  const max = RESPONSE_LIMITS.maxBodyBytes;
  const half = Math.floor((max - 16) / 2);
  const hostile = [
    `${'['.repeat(half)}${']'.repeat(half)}`,
    `[${'{},'.repeat(Math.floor((max - 16) / 3))}{}]`,
    `[${'"a",'.repeat(Math.floor((max - 16) / 4))}"a"]`,
    `{"validationResults":{"errorMessages":[${'{"code":"E","message":"m"},'.repeat(Math.floor((max - 64) / 27))}{}]}}`,
  ];
  for (const body of hostile) {
    assert.ok(Buffer.byteLength(body) <= max);
    const t0 = performance.now();
    assert.equal(parseResponseBody(body).kind, 'text');
    for (const s of [200, 202]) assert.deepEqual(classifyInvoiceResponse('clearance', s, body, NONE), { kind: 'CONFIG', detail: 'unparseable-body' });
    const ms = performance.now() - t0;
    assert.ok(ms < 1500, `استغرق ${Math.round(ms)} ms`);
  }
  // مستند معتمد بحجم 5.6 MiB: نصّ واحد يُتخطّى بقفزة
  const doc = Buffer.from(`<Invoice>${'a'.repeat(4 * 1024 * 1024)}</Invoice>`).toString('base64');
  const t1 = performance.now();
  assert.equal(jsonShapeWithinLimits(JSON.stringify({ clearedInvoice: doc })), true);
  assert.ok(performance.now() - t1 < 500);
});

test('fuzz: 3000 رد عشوائي على كل مسار وحالة وعدّادات تصعيد — لا رمي، ونوع صالح، وdetail آمن دائماً', () => {
  let seed = 20260916;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
  const pickOne = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const atoms: unknown[] = [null, true, 0, -2, 1e308, '', 'ISSUED', 'NOT_COMPLIANT', 'CLEARED', 'NOT_REPORTED', STUB_B64, 'TUlJ', '\u0000', 'م', [], {}];
  const keys = ['validationResults', 'errorMessages', 'erroMessages', 'warningMessages', 'infoMessages', 'errors', 'error', 'warnings', 'message', 'code',
    'category', 'type', 'status', 'errorCode', 'errorCategory', 'errorMessage', 'reportingStatus', 'clearanceStatus', 'clearedInvoice', 'requestID',
    'dispositionMessage', 'binarySecurityToken', 'secret', 'tokenType', 'qrSellertStatus', '__proto__'];
  const gen = (depth: number): unknown => {
    const t = rnd();
    if (depth > 3 || t < 0.35) return pickOne(atoms);
    if (t < 0.55) return Array.from({ length: Math.floor(rnd() * 4) }, () => gen(depth + 1));
    const o: Record<string, unknown> = {};
    for (let i = Math.floor(rnd() * 5); i > 0; i--) o[pickOne(keys)] = gen(depth + 1);
    return o;
  };
  const statuses = [200, 202, 208, 303, 400, 401, 406, 409, 413, 428, 429, 500, 502, 503, 504, 418, 0];
  const invoiceKinds = new Set(['ACCEPTED', 'DUPLICATE', 'CLEARANCE_OFF', 'REJECTED', 'RETRY', 'AUTH', 'CONFIG']);
  const csidKinds = new Set(['ISSUED', 'NOT_COMPLIANT', 'REJECTED', 'RETRY', 'AUTH', 'CONFIG']);
  for (let i = 0; i < 3000; i++) {
    const v = gen(0);
    const body = rnd() < 0.5 ? JSON.stringify(v) ?? 'undefined' : rnd() < 0.5 ? v : `${JSON.stringify(v)}`.slice(0, Math.floor(rnd() * 20));
    const status = pickOne(statuses);
    const c = counts(pickOne([0, 1, 2, 3, 4]), pickOne([0, 1, 2]));
    const a = classifyInvoiceResponse(pickOne(INVOICE_EPS), status, body, c);
    const b = classifyCsidResponse(pickOne(CSID_EPS), status, body, c);
    assert.ok(invoiceKinds.has(a.kind), a.kind);
    assert.ok(csidKinds.has(b.kind), b.kind);
    for (const o of [a, b]) if (o.kind === 'CONFIG') assert.match(o.detail, SAFE_DETAIL);
    if (a.kind === 'ACCEPTED' || a.kind === 'DUPLICATE') assert.ok(a.clearedXmlB64 === undefined || looksLikeBase64Xml(a.clearedXmlB64));
  }
});

test('looksLikeBase64Xml: base64 قانوني لمستند يبدأ بـ«<» (مع BOM وفراغات) فقط', () => {
  assert.equal(looksLikeBase64Xml(STUB_B64), true);
  assert.equal(looksLikeBase64Xml(Buffer.from('\ufeff \n<Invoice/>').toString('base64')), true);
  assert.equal(looksLikeBase64Xml(Buffer.from('{"not":"xml"}').toString('base64')), false);
  assert.equal(looksLikeBase64Xml(''), false);
  assert.equal(looksLikeBase64Xml(STUB_B64.replace(/=+$/, '')), false, 'بلا حشو ليس قانونياً');
  assert.equal(looksLikeBase64Xml(`${STUB_B64} `), false);
  assert.equal(looksLikeBase64Xml(STUB_B64, 10), false);
  assert.equal(looksLikeBase64Xml(123), false);
});

// ─── ملخّص السجلّ ───

test('redactResponseForLog: لا رمز ولا سرّ ولا مستند؛ رسائل منقّحة ومحدودة؛ والأسرار المعطاة تُمحى من النصوص', () => {
  const f = z3Body<Record<string, string>>('compliance-200');
  const csid = redactResponseForLog('compliance', parseResponseBody(z3Fixture('compliance-200').raw), []);
  const text = JSON.stringify(csid);
  assert.ok(!text.includes(f.secret) && !text.includes(f.binarySecurityToken.slice(0, 30)));
  assert.equal(csid.requestID, '1234567890123');
  assert.equal(csid.hasBinarySecurityToken, true);
  assert.equal(csid.hasSecret, true);
  assert.equal(csid.dispositionMessage, 'ISSUED');

  const cl = redactResponseForLog('clearance', parseResponseBody(z3Fixture('clearance-202').raw), []);
  assert.equal(cl.clearedInvoiceChars, STUB_B64.length);
  assert.ok(!JSON.stringify(cl).includes(STUB_B64.slice(0, 40)));
  assert.deepEqual(cl.warnings.map(m => m.code), ['BR-KSA-51']);
  assert.equal(cl.clearanceStatus, 'CLEARED');

  // رسالة تردّد OTP والسرّ ورمزاً مقصوصاً وBasic
  const otp = '482913';
  const secret = 'Dehvg1fc8GF6Jwt5bOxXwC6enR93VxeNEo2mlUatfgw=';
  const echo = { errors: [{ code: 'Invalid-OTP', message: `OTP ${otp} rejected for ${secret} token ${f.binarySecurityToken.slice(0, 120)} auth Basic QWxhZGRpbjpvcGVu` }] };
  const red = redactResponseForLog('compliance', parseResponseBody(JSON.stringify(echo)), [otp, secret]);
  const redText = JSON.stringify(red);
  for (const leak of [otp, secret, f.binarySecurityToken.slice(0, 64), 'QWxhZGRpbjpvcGVu']) assert.ok(!redText.includes(leak), leak);
  assert.equal(red.errors[0].code, 'Invalid-OTP');

  // السرّ الجديد في رد 400 نفسه يُمحى حتى دون تمريره
  const self = { binarySecurityToken: null, secret: 'zzSelfSecret99', errors: ['echo zzSelfSecret99'] };
  assert.ok(!JSON.stringify(redactResponseForLog('renewal', parseResponseBody(JSON.stringify(self)), [])).includes('zzSelfSecret99'));

  // الحدود ونصّ غير JSON
  const many = { validationResults: { infoMessages: Array(500).fill({ code: 'I' }), warningMessages: Array(500).fill({ code: 'W', message: 'w'.repeat(5000) }) } };
  const lim = redactResponseForLog('reporting', parseResponseBody(JSON.stringify(many)), []);
  assert.equal(lim.info.length, LOG_LIMITS.maxInfoMessages);
  assert.equal(lim.warnings.length, LOG_LIMITS.maxMessagesPerBucket);
  assert.ok(lim.warnings[0].message!.length <= LOG_LIMITS.maxMessageChars);
  assert.equal(lim.truncated, true);
  const html = redactResponseForLog('reporting', parseResponseBody(`<html>${'x'.repeat(5000)}</html>`), []);
  assert.equal(html.body, 'text');
  assert.ok(html.text!.length <= LOG_LIMITS.maxTextChars);
  assert.equal(redactResponseForLog('reporting', parseResponseBody(z3Fixture('error-406').raw), []).text, 'This Version is not supported or not provided in the header.');
  assert.equal(redactResponseForLog('reporting', { kind: 'too-large', bytes: 5 }, []).body, 'too-large');
  assert.equal(scrubSecrets('a Basic abc123== b', []), 'a Basic [REDACTED] b');
  assert.equal(scrubSecrets('short 12345 stays', ['12345']), 'short 12345 stays', 'أقلّ من 6 محارف لا يُعدّ سرّاً');
  // صدى السرّ بلا حشو «=»، وOTP بحدود أرقام فقط
  assert.equal(scrubSecrets(`x ${secret.replace(/=+$/, '')} y`, [secret]), 'x [REDACTED] y');
  assert.equal(scrubSecrets('id 1234567890123 otp 123456.', ['123456']), 'id 1234567890123 otp [REDACTED].');
  assert.equal(containsSecret('durationMs 1234567', '123456'), false);
  assert.equal(containsSecret('code=123456;', '123456'), true);
});

test('محو الأسرار بعد القصّ والتطبيع: نوافذ 16 محرفاً بلا حساسية لحالة الأحرف، وبادئة ≥ 8 في آخر نصّ مقصوص', () => {
  const secret = 'Dehvg1fc8GF6Jwt5bOxXwC6enR93VxeNEo2mlUatfgw=';
  const token = z3Body<Record<string, string>>('compliance-200').binarySecurityToken;
  const basic = Buffer.from(`${token}:${secret}`, 'utf8').toString('base64');
  const secrets = [secret, token, basic, '482913'];
  // كل موضع يقصّه toMsg/normToken/cleanText داخل السرّ، والفواصل خارج أبجدية base64 كي لا يمحوها LONG_B64 عرضاً
  const body = {
    validationResults: {
      errorMessages: [
        { code: `${'-'.repeat(90)} ${secret}`, category: `${'-'.repeat(116)} ${secret}`, message: `${'م'.repeat(960)} ${secret}` },
        { code: 'tail-12', message: `${'م'.repeat(986)} ${secret}` }, // يبقى 12 محرفاً من السرّ بعد قصّ 1000
        { code: `${'-'.repeat(116)} ${secret}`, message: `upper ${secret.toUpperCase()} lower ${secret.toLowerCase()}` }, // يبقى 10 من الرمز
      ],
    },
    reportingStatus: secret, // normToken يكبّره
    clearanceStatus: `${'x'.repeat(40)} ${secret}`, // يُقصّ عند 64 ويُكبَّر
    qrSellertStatus: `${'م'.repeat(52)}${secret}`, // يُقصّ فيبقى 11
  };
  const red = redactResponseForLog('reporting', parseResponseBody(JSON.stringify(body)), secrets);
  const text = JSON.stringify(red);
  for (const s of [secret, token, basic]) assert.ok(!leaksSecretWindow(text, s), `نافذة من ${s.slice(0, 6)}…`);
  assert.ok(!text.toLowerCase().includes(secret.slice(0, SECRET_WINDOW_CHARS / 2).toLowerCase()), 'بادئة 8 محارف بعد القصّ');
  assert.equal(red.errors.length, 3);
  assert.match(red.errors[0].code!, /\[REDACTED\]/);
  assert.ok(red.errors[1].message!.endsWith('…'));
  assert.match(red.reportingStatus!, /^\[REDACTED\]$/);
  assert.match(red.qrSellertStatus!, /\[REDACTED\]/);

  // compileSecrets/containsSecret مباشرة
  assert.equal(containsSecret(secret.toUpperCase(), secret), true);
  assert.equal(containsSecret(`x ${secret.slice(5, 21)} y`, secret), true, 'نافذة 16 وسط النص');
  assert.equal(containsSecret(`x ${secret.slice(5, 20)} y`, secret), false, '15 وسط النص ليست تسريباً');
  assert.equal(containsSecret(`x ${secret.slice(0, 9)}…`, secret), true, 'بادئة 9 في آخر نصّ مقصوص');
  assert.equal(containsSecret(`x ${secret.slice(0, 9)}`, secret), true);
  assert.equal(containsSecret(`x ${secret.slice(0, 7)}…`, secret), false);
  assert.equal(containsSecret(token.slice(700, 716), token), true);
  assert.equal(containsSecret('ABC_DEF_GHI_JKL_MNO', 'abc-def-ghi-jkl-mno'), true, 'normToken يبدّل «-» بـ«_»');
  assert.equal(containsSecret('zzSELFSECRET99', 'zzSelfSecret99'), true, 'السرّ القصير بلا حساسية لحالة الأحرف');
  assert.equal(containsSecret('durationMs 1234567', '123456'), false);
  // المسح بخطوة 8: كل إزاحة ممكنة للنافذة تُكتشف
  const m = compileSecrets([secret]);
  for (let i = 0; i < 40; i++) {
    for (let from = 0; from + SECRET_WINDOW_CHARS <= secret.length; from += 5) {
      const probe = `${'م'.repeat(i)}${secret.slice(from, from + SECRET_WINDOW_CHARS)}zz`;
      assert.equal(m.contains(probe), true, `i=${i} from=${from}`);
      assert.equal(m.scrub(probe), `${'م'.repeat(i)}[REDACTED]zz`);
    }
  }
  assert.equal(m.scrub(`a ${secret} b ${secret} c`), 'a [REDACTED] b [REDACTED] c');
  assert.equal(m.contains('no secrets here at all, just a long ordinary sentence of words'), false);
});

test('CSID: بيانات الاعتماد الجديدة تُستخرج من النص الخام حتى حين لا يُحلَّل، ولا مقتطف نصّي من مسارات الشهادات أبداً', () => {
  const token = z3Body<Record<string, string>>('compliance-200').binarySecurityToken;
  const newSecret = 'SX3P87hpTma5qUsOEQWv46fHL9uGcKFow90i9ercnSY=';
  const raw = `${JSON.stringify({ requestID: 1, dispositionMessage: 'ISSUED', secret: newSecret, binarySecurityToken: token })}\n<!-- cache -->`;
  for (const ep of CSID_EPS) {
    const parsed = parseResponseBody(raw);
    assert.equal(parsed.kind, 'text');
    assert.deepEqual(classifyCsidResponse(ep, 200, raw, NONE), { kind: 'CONFIG', detail: 'unparseable-body' });
    const creds = responseCredentialStrings(ep, parsed);
    assert.ok(creds.includes(newSecret) && creds.includes(token), ep);
    const red = redactResponseForLog(ep, parsed, []);
    assert.equal(red.body, 'text');
    assert.equal(red.text, null);
    const text = JSON.stringify(red);
    assert.ok(!leaksSecretWindow(text, newSecret) && !leaksSecretWindow(text, token), ep);
  }
  // مسار المستندات يبقى بمقتطف (لا بيانات اعتماد تصدر هناك)، ولا استخراج
  assert.equal(redactResponseForLog('reporting', parseResponseBody(z3Fixture('error-406').raw), []).text, 'This Version is not supported or not provided in the header.');
  assert.equal(redactResponseForLog('compliance', parseResponseBody(z3Fixture('error-406').raw), []).text, null);
  assert.deepEqual(responseCredentialStrings('reporting', parseResponseBody(raw)), []);

  // مفتاح مكرّر (JSON.parse يُبقي الأخير) ونصّ مهرَّب: كلاهما يُمحى من صدى الرسائل
  const dup = '{"secret":"firstSecretValue1234","secret":"s2ndSecretValue5678","errors":["echo firstSecretValue1234 and ab/cdefghijklmnopqrs"],"binarySecurityToken":"ab\/cdefghijklmnopqrs"}';
  const dupParsed = parseResponseBody(dup);
  assert.equal(dupParsed.kind, 'json');
  const got = responseCredentialStrings('renewal', dupParsed);
  for (const s of ['firstSecretValue1234', 's2ndSecretValue5678', 'ab\/cdefghijklmnopqrs', 'ab/cdefghijklmnopqrs']) assert.ok(got.includes(s), s);
  const dupText = JSON.stringify(redactResponseForLog('renewal', dupParsed, []));
  assert.ok(!dupText.includes('firstSecretValue1234') && !dupText.includes('cdefghijklmnopqrs'), dupText);
});
