// اختبارات Z3 لعميل «فاتورة»: الطريقة والعنوان والترويسات والجسم لكل مسار عبر fetch مُسجِّل مزيَّف، OTP حضوراً وغياباً،
// عدم تسجيل التفويض والأسرار أبداً، المهلة والشبكة والجسم الضخم، سجلّ واحد لكل محاولة، والتحقق قبل أي اتصال.
// لا اتصال حقيقي: حارس الشبكة يُستورد أولاً ويُفشل الملف إن لُمس globalThis.fetch دون تصريح.
import { NET_GUARD_MESSAGE, expectGuardHit, guardFetch, guardHits } from './__fixtures__/z3-netguard';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiLogEntry, CallOptions, Creds, DEFAULT_ONBOARDING_TIMEOUT_MS, DEFAULT_SUBMISSION_TIMEOUT_MS, FATOORA_BASE_URLS, FATOORA_ENDPOINT_SPECS,
  FatooraClient, FatooraClientOptions, FatooraFetch, FatooraFetchInit, FatooraFetchResponse, FatooraInputError, InvoiceBody, credsFromCsid, decodeCsid,
} from './api';
import { CsidCertError } from './cert';
import { performance } from 'perf_hooks';
import { EMPTY400_EXHAUSTED_CODE, MAX_ESCALATION_COUNT, Outcome, RESPONSE_LIMITS, SECRET_WINDOW_CHARS } from './responses';
import { z3Body, z3Fixture } from './__fixtures__/z3-fixtures';

// على مستوى الأنواع: fetch العام في Node يطابق FatooraFetch (design: fetch?: typeof fetch)
const _globalFetchIsCompatible: FatooraFetch = guardFetch;
void _globalFetchIsCompatible;

const CCSID = z3Body<{ binarySecurityToken: string; secret: string }>('compliance-200');
const CREDS: Creds = { token: CCSID.binarySecurityToken, secret: CCSID.secret };
const BASIC = `Basic ${Buffer.from(`${CREDS.token}:${CREDS.secret}`, 'utf8').toString('base64')}`;
const INVOICE = z3Body<InvoiceBody>('invoice-request');
const CSR = z3Fixture('compliance-request');
const CSR_PEM = CSR.csrPem!;
const OTP = '123345'; // OTP الوهمي لـ/compliance في Swagger
const RENEW_OTP = '123456'; // OTP الوهمي للتجديد في Swagger — وهو جزء من requestID «1234567890123» عمداً

interface Recorded {
  url: string;
  init: FatooraFetchInit;
}

function recorder(respond: (call: Recorded, n: number) => FatooraFetchResponse | Promise<FatooraFetchResponse>) {
  const calls: Recorded[] = [];
  const fetch: FatooraFetch = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return respond(call, calls.length);
  };
  return { fetch, calls };
}

function fixtureResponse(name: string, headers: Record<string, string> = {}): Response {
  const f = z3Fixture(name);
  return new Response(f.raw, { status: f.httpStatus, headers: { 'content-type': f.contentType ?? 'application/json', ...headers } });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function makeClient(fetch: FatooraFetch | undefined, extra: Partial<FatooraClientOptions> = {}) {
  const logs: ApiLogEntry[] = [];
  const client = new FatooraClient({ env: 'sandbox', ...(fetch ? { fetch } : {}), log: async e => { logs.push(e); }, ...extra });
  return { client, logs };
}

/** أسرار بيانات الاعتماد (الرمز كاملاً وجزءاً، السرّ، قيمة Basic). */
const CRED_STRINGS = [CREDS.secret, CREDS.secret.replace(/=+$/, ''), CREDS.secret.slice(0, 24), CREDS.token, CREDS.token.slice(0, 48), BASIC, BASIC.slice('Basic '.length), BASIC.slice(6, 60)];

/** أي نافذة من 16 محرفاً من السرّ في النص، بلا حساسية لحالة الأحرف (القصّ والتكبير لا يجعلان الجزء آمناً). */
function leaksSecretWindow(text: string, secret: string): boolean {
  const t = text.toLowerCase();
  const s = secret.toLowerCase();
  for (let i = 0; i + SECRET_WINDOW_CHARS <= s.length; i++) if (t.includes(s.slice(i, i + SECRET_WINDOW_CHARS))) return true;
  return false;
}

/**
 * لكل سطر: الأسرار التي أُرسلت في ذلك الطلب لا تظهر فيه — OTP على /compliance وPATCH، وبيانات الاعتماد على كل ما عدا
 * /compliance. (نصّ يطابق سرّاً لم يُرسَل في ذلك الطلب لا يعرفه العميل ولا يُعدّ سرّاً له.) extra تُفحص في كل السطور.
 */
function assertLogsClean(logs: ApiLogEntry[], extra: string[] = []) {
  for (const l of logs) {
    const text = JSON.stringify(l);
    if (l.endpoint === 'compliance' || l.endpoint === 'renewal') {
      assert.doesNotMatch(text, new RegExp(`(?<![0-9])(${OTP}|${RENEW_OTP})(?![0-9])`), `OTP في سجلّ ${l.endpoint}`);
    }
    if (l.endpoint !== 'compliance') {
      for (const s of CRED_STRINGS) assert.ok(!text.includes(s), `سرّ في سجلّ ${l.endpoint}: ${s.slice(0, 12)}…`);
      assert.ok(!leaksSecretWindow(text, CREDS.secret), `جزء من السرّ في سجلّ ${l.endpoint}`);
    }
    for (const s of extra) assert.ok(!text.includes(s), `سرّ في سجلّ ${l.endpoint}: ${s.slice(0, 12)}…`);
    assert.doesNotMatch(text, /Basic\s+(?!\[REDACTED\])[A-Za-z0-9+/=]{4,}/);
    assert.doesNotMatch(text, /Authorization|authorization/);
  }
}

/** جسم لا ينتهي أبداً (مع تتبّع الإلغاء). */
function hangingStream(first?: Uint8Array) {
  const state = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first) controller.enqueue(first);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

async function rejectsInput(p: Promise<unknown>, field: string, forbidden: string[] = []) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof FatooraInputError, String(e));
    assert.equal(e.field, field);
    assert.equal(e.code, 'INPUT');
    for (const s of forbidden) if (s.length >= 4) assert.ok(!e.message.includes(s), `القيمة في رسالة الخطأ: ${s}`);
    return true;
  });
}

// ─── حارس الشبكة ───

test('حارس الشبكة: globalThis.fetch يرمي ويُعدّ، والعميل بلا fetch محقون يلمسه (فيُكشف أي اتصال حقيقي عرضي)', async () => {
  assert.equal(globalThis.fetch, guardFetch);
  expectGuardHit();
  assert.throws(() => (globalThis.fetch as unknown as () => unknown)(), new RegExp(NET_GUARD_MESSAGE));

  // الافتراضي globalThis.fetch يُقرأ وقت الاستدعاء: نبدّله مؤقتاً بمُسجِّل ثم نعيد الحارس
  const { fetch, calls } = recorder(() => fixtureResponse('reporting-200'));
  const { client, logs } = makeClient(undefined);
  (globalThis as { fetch: unknown }).fetch = fetch;
  try {
    assert.deepEqual(await client.report(CREDS, INVOICE), { kind: 'ACCEPTED', warnings: [] });
  } finally {
    (globalThis as { fetch: unknown }).fetch = guardFetch;
  }
  assert.equal(calls.length, 1);
  assert.equal(logs.length, 1);

  // مع الحارس في مكانه: المحاولة تُعدّ، والنتيجة RETRY network، ونصّ الحارس لا يصل السجلّ
  const before = guardHits();
  expectGuardHit();
  assert.deepEqual(await client.report(CREDS, INVOICE), { kind: 'RETRY', reason: 'network' });
  assert.equal(guardHits(), before + 1);
  assert.equal(logs[1].errorText, 'Error');
});

// ─── الطلبات بدقّة ───

test('العناوين: البيئات الثلاث على البوابة نفسها، والمسارات والطرق الستة [SWG]', () => {
  assert.deepEqual({ ...FATOORA_BASE_URLS }, {
    sandbox: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
    simulation: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
    production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core',
  });
  assert.deepEqual(Object.fromEntries(Object.entries(FATOORA_ENDPOINT_SPECS).map(([k, v]) => [k, `${v.method} ${v.path}`])), {
    compliance: 'POST /compliance',
    'compliance-invoices': 'POST /compliance/invoices',
    'production-csid': 'POST /production/csids',
    renewal: 'PATCH /production/csids',
    reporting: 'POST /invoices/reporting/single',
    clearance: 'POST /invoices/clearance/single',
  });
  assert.equal(Object.isFrozen(FATOORA_BASE_URLS), true);
  assert.equal(new FatooraClient({ env: 'production', log: async () => undefined }).baseUrl, FATOORA_BASE_URLS.production);
});

test('POST /compliance: ترويسات OTP وAccept-Version وContent-Type فقط، والجسم {csr} = base64 لنصّ PEM حرفياً كمثال Swagger', async () => {
  const { fetch, calls } = recorder(() => fixtureResponse('compliance-200'));
  const { client, logs } = makeClient(fetch);
  const out = await client.requestComplianceCsid(CSR_PEM, OTP);
  assert.equal(calls.length, 1);
  const [c] = calls;
  assert.equal(c.url, 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/compliance');
  assert.equal(c.init.method, 'POST');
  assert.deepEqual(c.init.headers, { 'Accept-Version': 'V2', 'Content-Type': 'application/json', OTP: '123345' });
  assert.equal(c.init.body, JSON.stringify(CSR.body), 'بايتات الجسم = مثال CSRRequest الرسمي');
  assert.equal(Buffer.from((JSON.parse(c.init.body) as { csr: string }).csr, 'base64').toString('latin1'), CSR_PEM);
  assert.equal(c.init.redirect, 'manual');
  assert.ok(c.init.signal instanceof AbortSignal);
  assert.equal(c.init.signal.aborted, false);

  assert.equal(out.kind, 'ISSUED');
  if (out.kind !== 'ISSUED') return;
  assert.equal(out.csid.requestID, '1234567890123');
  assert.equal(out.csid.binarySecurityToken, CREDS.token);
  assert.equal(out.csid.secret, CREDS.secret);

  assert.equal(logs.length, 1);
  const l = logs[0];
  assert.deepEqual(
    { env: l.env, endpoint: l.endpoint, method: l.method, path: l.path, attempt: l.attempt, httpStatus: l.httpStatus, outcome: l.outcome, reason: l.reason, uuid: l.uuid, errorText: l.errorText },
    { env: 'sandbox', endpoint: 'compliance', method: 'POST', path: '/compliance', attempt: 1, httpStatus: 200, outcome: 'ISSUED', reason: null, uuid: null, errorText: null },
  );
  assert.equal(l.response?.requestID, '1234567890123');
  assert.equal(l.response?.hasBinarySecurityToken, true);
  assert.equal(l.response?.hasSecret, true);
  assert.equal(l.responseBytes, Buffer.byteLength(z3Fixture('compliance-200').raw));
  assert.ok(Number.isInteger(l.durationMs) && l.durationMs >= 0);
  assertLogsClean(logs);
});

test('POST /compliance/invoices: Basic بالرمز حرفياً (TUlJ… لا الشهادة المفكوكة) وAccept-Language: ar، بلا OTP ولا Clearance-Status', async () => {
  const { fetch, calls } = recorder(() => fixtureResponse('compliance-invoices-200'));
  const { client, logs } = makeClient(fetch);
  assert.deepEqual(await client.checkComplianceInvoice(CREDS, INVOICE), { kind: 'ACCEPTED', warnings: [] });
  const [c] = calls;
  assert.equal(c.url, `${FATOORA_BASE_URLS.sandbox}/compliance/invoices`);
  assert.equal(c.init.method, 'POST');
  assert.deepEqual(c.init.headers, { 'Accept-Version': 'V2', 'Content-Type': 'application/json', 'Accept-Language': 'ar', Authorization: BASIC });
  const [user, ...rest] = Buffer.from(c.init.headers.Authorization.slice(6), 'base64').toString('utf8').split(':');
  assert.equal(user, CREDS.token);
  assert.ok(user.startsWith('TUlJ') && !user.startsWith('MIIC'));
  assert.equal(rest.join(':'), CREDS.secret);
  assert.equal(c.init.body, JSON.stringify({ invoiceHash: INVOICE.invoiceHash, uuid: INVOICE.uuid, invoice: INVOICE.invoice }));
  assert.equal(c.init.body, z3Fixture('invoice-request').raw, 'ترتيب المفاتيح والقيم = مثال InvoiceRequest');
  assert.equal(logs[0].endpoint, 'compliance-invoices');
  assert.equal(logs[0].uuid, INVOICE.uuid);
  assert.equal(logs[0].invoiceHash, INVOICE.invoiceHash);
  assert.ok(!JSON.stringify(logs).includes(INVOICE.invoice), 'المستند لا يُسجَّل');
  assertLogsClean(logs);
});

test('POST /production/csids: {compliance_request_id} نصاً وBasic، بلا OTP ولا Accept-Language', async () => {
  const { fetch, calls } = recorder((_, n) => (n === 1 ? fixtureResponse('production-csid-200') : fixtureResponse('production-csid-400-missing-steps-production')));
  const { client, logs } = makeClient(fetch);
  const ok = await client.requestProductionCsid(CREDS, '1234567890123');
  assert.equal(ok.kind === 'ISSUED' && ok.csid.requestID, '1642424139872');
  const [c] = calls;
  assert.equal(c.url, `${FATOORA_BASE_URLS.sandbox}/production/csids`);
  assert.equal(c.init.method, 'POST');
  assert.deepEqual(c.init.headers, { 'Accept-Version': 'V2', 'Content-Type': 'application/json', Authorization: BASIC });
  assert.equal(c.init.body, '{"compliance_request_id":"1234567890123"}');
  const missing = await client.requestProductionCsid(CREDS, '1234567890123', { attempt: 2 });
  assert.equal(missing.kind, 'REJECTED');
  assert.equal(missing.kind === 'REJECTED' && missing.errors[0].code, 'Missing-ComplianceSteps');
  assert.deepEqual(logs.map(l => [l.endpoint, l.outcome, l.attempt]), [['production-csid', 'ISSUED', 1], ['production-csid', 'REJECTED', 2]]);
  const newSecret = z3Body<{ secret: string; binarySecurityToken: string }>('production-csid-200');
  assertLogsClean(logs, [newSecret.secret, newSecret.binarySecurityToken.slice(0, 48)]);
});

test('PATCH /production/csids: OTP وBasic الحالي وAccept-Language؛ 428 ⇒ NOT_COMPLIANT و200 ⇒ ISSUED؛ OTP رقمي لا يُتلف requestID في السجلّ', async () => {
  const { fetch, calls } = recorder((_, n) => (n === 1 ? fixtureResponse('renewal-428') : fixtureResponse('renewal-200')));
  const { client, logs } = makeClient(fetch, { env: 'production' });
  const nc = await client.renewProductionCsid(CREDS, CSR_PEM, RENEW_OTP);
  assert.equal(nc.kind, 'NOT_COMPLIANT');
  assert.equal(nc.kind === 'NOT_COMPLIANT' && nc.ccsid.requestID, '1234567890123');
  const [c] = calls;
  assert.equal(c.url, 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core/production/csids');
  assert.equal(c.init.method, 'PATCH');
  assert.deepEqual(c.init.headers, { 'Accept-Version': 'V2', 'Content-Type': 'application/json', 'Accept-Language': 'ar', OTP: RENEW_OTP, Authorization: BASIC });
  assert.equal(c.init.body, JSON.stringify({ csr: Buffer.from(CSR_PEM, 'utf8').toString('base64') }));
  const ok = await client.renewProductionCsid(CREDS, CSR_PEM, RENEW_OTP);
  assert.equal(ok.kind, 'ISSUED');
  assert.deepEqual(logs.map(l => [l.endpoint, l.method, l.httpStatus, l.outcome]), [['renewal', 'PATCH', 428, 'NOT_COMPLIANT'], ['renewal', 'PATCH', 200, 'ISSUED']]);
  assert.equal(logs[0].response?.requestID, '1234567890123', 'OTP 123456 داخل رقم أطول ليس تسريباً');
  assert.equal(logs[0].errorText, null);
  const text = JSON.stringify(logs);
  assert.doesNotMatch(text, /(?<![0-9])123456(?![0-9])/);
  assertLogsClean(logs, ['goDgeIdM5mkfTThl1unu8rP9XhknKWAc24hafXZS1f4=', z3Body<{ secret: string }>('renewal-200').secret]);
});

test('الإبلاغ Clearance-Status: 0 والاعتماد Clearance-Status: 1، على عناوين المحاكاة والإنتاج', async () => {
  for (const env of ['simulation', 'production'] as const) {
    const { fetch, calls } = recorder((_, n) => (n === 1 ? fixtureResponse('reporting-202') : fixtureResponse('clearance-200')));
    const { client, logs } = makeClient(fetch, { env });
    const rep = await client.report(CREDS, INVOICE);
    const clr = await client.clear(CREDS, INVOICE);
    assert.equal(calls[0].url, `${FATOORA_BASE_URLS[env]}/invoices/reporting/single`);
    assert.equal(calls[1].url, `${FATOORA_BASE_URLS[env]}/invoices/clearance/single`);
    const base = { 'Accept-Version': 'V2', 'Content-Type': 'application/json', 'Accept-Language': 'ar', Authorization: BASIC };
    assert.deepEqual(calls[0].init.headers, { ...base, 'Clearance-Status': '0' });
    assert.deepEqual(calls[1].init.headers, { ...base, 'Clearance-Status': '1' });
    for (const c of calls) {
      assert.equal(c.init.method, 'POST');
      assert.equal(c.init.body, z3Fixture('invoice-request').raw);
    }
    assert.deepEqual(rep.kind === 'ACCEPTED' && rep.warnings.map(w => w.code), ['BR-CO-17', 'BR-KSA-98']);
    assert.equal(clr.kind === 'ACCEPTED' && clr.clearedXmlB64, INVOICE.invoice);
    assert.deepEqual(logs.map(l => [l.env, l.endpoint, l.outcome]), [[env, 'reporting', 'ACCEPTED'], [env, 'clearance', 'ACCEPTED']]);
    assert.deepEqual(logs[0].response?.warnings.map(w => w.code), ['BR-CO-17', 'BR-KSA-98']);
    assert.equal(logs[1].response?.clearedInvoiceChars, INVOICE.invoice.length);
    assertLogsClean(logs);
  }
});

test('مصفوفة الترويسات لكل الطرق: OTP فقط على /compliance وPATCH، وAuthorization على الكل عدا /compliance، ولا ترويسة أخرى؛ acceptLanguage=en', async () => {
  const { fetch, calls } = recorder(() => jsonResponse(500, 'x'));
  const { client } = makeClient(fetch, { acceptLanguage: 'en' });
  await client.requestComplianceCsid(CSR_PEM, OTP);
  await client.checkComplianceInvoice(CREDS, INVOICE);
  await client.requestProductionCsid(CREDS, '42');
  await client.renewProductionCsid(CREDS, CSR_PEM, OTP);
  await client.report(CREDS, INVOICE);
  await client.clear(CREDS, INVOICE);
  const names = calls.map(c => Object.keys(c.init.headers).sort().join(','));
  assert.deepEqual(names, [
    'Accept-Version,Content-Type,OTP',
    'Accept-Language,Accept-Version,Authorization,Content-Type',
    'Accept-Version,Authorization,Content-Type',
    'Accept-Language,Accept-Version,Authorization,Content-Type,OTP',
    'Accept-Language,Accept-Version,Authorization,Clearance-Status,Content-Type',
    'Accept-Language,Accept-Version,Authorization,Clearance-Status,Content-Type',
  ]);
  for (const c of calls) {
    assert.equal(c.init.headers['Accept-Version'], 'V2');
    assert.equal(c.init.headers['Content-Type'], 'application/json');
    if (c.init.headers['Accept-Language']) assert.equal(c.init.headers['Accept-Language'], 'en');
    if (c.init.headers.OTP) assert.equal(c.init.headers.OTP, OTP);
    assert.equal(c.init.redirect, 'manual');
  }
});

// ─── الأسرار ───

test('التفويض والسرّ والرمز وOTP لا تصل السجلّ أبداً — حتى حين تردّدها الهيئة أو خطأ الشبكة أو صفحة البوابة', async () => {
  const echoMsg = `bad OTP ${OTP} secret ${CREDS.secret} auth ${BASIC} token ${CREDS.token.slice(0, 100)}`;
  const responders: Array<() => FatooraFetchResponse | Promise<FatooraFetchResponse>> = [
    () => jsonResponse(400, { errors: [{ code: 'Invalid-OTP', message: echoMsg }] }),
    () => jsonResponse(401, { timestamp: 1, status: 401, error: echoMsg, message: '' }),
    () => new Response(`<html><pre>${echoMsg}</pre></html>`, { status: 500 }),
    () => new Response(`<html>${echoMsg}</html>`, { status: 200 }),
    () => { throw Object.assign(new Error(echoMsg), { code: CREDS.secret }); },
    () => Promise.reject(Object.assign(new TypeError(echoMsg), { cause: { code: `ECONN ${OTP}` } })),
    () => jsonResponse(400, { validationResults: { errorMessages: [{ code: CREDS.secret, category: OTP, message: echoMsg }] } }),
    () => jsonResponse(200, { requestID: 7, dispositionMessage: 'ISSUED', binarySecurityToken: CREDS.token, secret: CREDS.secret }),
  ];
  let k = 0;
  const { fetch } = recorder(() => responders[k]());
  const { client, logs } = makeClient(fetch);
  const outcomes: string[] = [];
  for (k = 0; k < responders.length; k++) {
    outcomes.push((await client.requestComplianceCsid(CSR_PEM, OTP)).kind);
    outcomes.push((await client.report(CREDS, INVOICE)).kind);
  }
  assert.equal(logs.length, responders.length * 2);
  assert.ok(outcomes.includes('REJECTED') && outcomes.includes('AUTH') && outcomes.includes('RETRY') && outcomes.includes('CONFIG') && outcomes.includes('ISSUED'));
  assertLogsClean(logs);
  // أخطاء الشبكة: الاسم والرمز المنقّح فقط
  assert.ok(logs.some(l => l.errorText === 'Error' || l.errorText?.startsWith('Error(')));
  assert.ok(logs.every(l => !l.errorText || /^[A-Za-z]+(\([A-Za-z0-9_.-]*\))?$|^\[REDACTED\]$|^Timeout$/.test(l.errorText)), JSON.stringify(logs.map(l => l.errorText)));
});

test('رد CSID 200 ليس JSON صارماً (ذيل زائد) ⇒ CONFIG unparseable-body، والسرّ الجديد الحيّ لا يصل السجلّ بأي جزء منه', async () => {
  const newSecret = 'SX3P87hpTma5qUsOEQWv46fHL9uGcKFow90i9ercnSY=';
  const newToken = z3Body<{ binarySecurityToken: string }>('production-csid-200').binarySecurityToken;
  const issued = JSON.stringify({ requestID: 1, dispositionMessage: 'ISSUED', secret: newSecret, binarySecurityToken: newToken });
  const tails = ['\n<!-- cache -->', ' trailing', `\n{"secret":"${newSecret}"}`];
  for (const tail of tails) {
    const { fetch } = recorder(() => new Response(`${issued}${tail}`, { status: 200 }));
    const { client, logs } = makeClient(fetch);
    const outs = [
      await client.requestComplianceCsid(CSR_PEM, OTP),
      await client.requestProductionCsid(CREDS, '1234567890123'),
      await client.renewProductionCsid(CREDS, CSR_PEM, RENEW_OTP),
    ];
    for (const o of outs) assert.deepEqual(o, { kind: 'CONFIG', detail: 'unparseable-body' }, tail);
    assert.equal(logs.length, 3);
    for (const l of logs) {
      const text = JSON.stringify(l);
      assert.equal(l.response?.body, 'text');
      assert.equal(l.response?.text, null, 'لا مقتطف نصّي من مسارات الشهادات');
      assert.ok(!leaksSecretWindow(text, newSecret), `السرّ الجديد في سجلّ ${l.endpoint}`);
      assert.ok(!leaksSecretWindow(text, newToken), `الرمز الجديد في سجلّ ${l.endpoint}`);
      assert.equal(l.responseBytes, Buffer.byteLength(`${issued}${tail}`));
    }
    assertLogsClean(logs, [newSecret, newSecret.slice(0, 16), newToken.slice(0, 48)]);
  }
});

test('صدى السرّ مقصوصاً عند حدّ الطول أو مكبَّر الأحرف في رسائل وحالات 400 ⇒ يُمحى (لا 36 من 44 محرفاً) والسطر يبقى مفيداً', async () => {
  const s = CREDS.secret;
  const body = {
    validationResults: {
      errorMessages: [
        { code: `${'-'.repeat(90)} ${s}`, category: 'CAT', message: `${'A'.repeat(960)} ${s}` },
        { code: 'BR-KSA-37', category: `${'.'.repeat(120)} ${s}`, message: `${'م'.repeat(986)} ${s}` },
      ],
      status: 'ERROR',
    },
    reportingStatus: s,
    clearanceStatus: `${'x'.repeat(40)} ${s}`,
    qrSellertStatus: s.toLowerCase(),
  };
  const { client, logs } = makeClient(async () => jsonResponse(400, body));
  const out = await client.report(CREDS, INVOICE);
  assert.equal(out.kind, 'REJECTED');
  const l = logs[0];
  const text = JSON.stringify(l);
  for (let i = 0; i + 16 <= s.length; i++) assert.ok(!text.toLowerCase().includes(s.slice(i, i + 16).toLowerCase()), `نافذة ${i}`);
  assert.ok(!text.toUpperCase().includes(s.slice(0, 8).toUpperCase()), 'بادئة 8');
  assert.ok(l.response !== null, 'المحو نجح قبل الحاجز الأخير فلم يُسقط الملخّص');
  assert.equal(l.response?.errors[1].code, 'BR-KSA-37');
  assert.match(l.response!.errors[0].code!, /\[REDACTED\]/);
  assert.equal(l.response?.reportingStatus, '[REDACTED]');
  assertLogsClean(logs, [s.slice(0, 24), s.slice(0, 30), s.slice(0, 36), s.slice(0, 38), s.toUpperCase()]);
});

test('أجسام معادية ضمن 8 MiB لا توقف حلقة الأحداث: 503 بتعشيش كثيف يُقطع عند 64 KiB، و200 بـ[{},{},…] لا يُحلَّل؛ وCSID فوق 64 KiB ⇒ body-too-large', async () => {
  const max = RESPONSE_LIMITS.maxBodyBytes;
  const half = Math.floor((max - 16) / 2);
  const nested = `${'['.repeat(half)}${']'.repeat(half)}`;
  const dense = `[${'{},'.repeat(Math.floor((max - 16) / 3))}{}]`;
  /** قلب مؤقّت يقيس أطول توقّف لحلقة الأحداث أثناء الاستدعاء. */
  const measure = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number; maxGap: number }> => {
    let last = performance.now();
    let maxGap = 0;
    const beat = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 5);
    const t0 = performance.now();
    try {
      const value = await fn();
      return { value, ms: performance.now() - t0, maxGap: Math.max(maxGap, performance.now() - last) };
    } finally {
      clearInterval(beat);
    }
  };
  // 1) 503 على شهادة الإنتاج (استكشاف المراجعة): تصنيف بالحالة، والجسم يتوقّف عند سقف 64 KiB
  let pulled = 0;
  const bytes = new TextEncoder().encode(nested);
  const chunked = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(pulled, pulled + 16384));
      pulled += 16384;
    },
  }, { highWaterMark: 0 });
  const a = makeClient(async () => new Response(chunked, { status: 503 }));
  const r1 = await measure(() => a.client.requestProductionCsid(CREDS, '1234567890123'));
  assert.deepEqual(r1.value, { kind: 'RETRY', reason: 'server' });
  assert.ok(pulled <= RESPONSE_LIMITS.maxSmallBodyBytes + 3 * 16384, `قُرئ ${pulled} بايت`);
  assert.equal(a.logs[0].response?.body, 'too-large');
  assert.ok(r1.ms < 1000 && r1.maxGap < 500, `${Math.round(r1.ms)} ms، توقّف ${Math.round(r1.maxGap)} ms`);

  // 2) 200 على الاعتماد بالسقف الكامل: يُقرأ لكن لا يُحلَّل
  for (const body of [nested, dense]) {
    const b = makeClient(async () => new Response(body, { status: 200 }));
    const r2 = await measure(() => b.client.clear(CREDS, INVOICE));
    assert.deepEqual(r2.value, { kind: 'CONFIG', detail: 'unparseable-body' });
    assert.equal(b.logs[0].responseBytes, Buffer.byteLength(body));
    assert.ok(r2.maxGap < 1000, `توقّف ${Math.round(r2.maxGap)} ms`);
  }

  // 3) جسم CSID أكبر من 64 KiB ⇒ body-too-large ولو كان JSON سليماً؛ و400 المستندات فوق 1 MiB كذلك
  const padded = JSON.stringify({ ...z3Body('compliance-200'), pad: 'x'.repeat(RESPONSE_LIMITS.maxSmallBodyBytes) });
  const c = makeClient(async () => new Response(padded, { status: 200 }));
  assert.deepEqual(await c.client.requestComplianceCsid(CSR_PEM, OTP), { kind: 'CONFIG', detail: 'body-too-large' });
  const d = makeClient(async () => jsonResponse(400, { errors: [{ code: 'E', message: 'x'.repeat(RESPONSE_LIMITS.maxRejectionBodyBytes) }] }));
  assert.deepEqual(await d.client.report(CREDS, INVOICE), { kind: 'CONFIG', detail: 'body-too-large' });
  // والردود الحقيقية تمرّ بسقوفها
  const e = makeClient(async () => fixtureResponse('compliance-200'));
  assert.equal((await e.client.requestComplianceCsid(CSR_PEM, OTP)).kind, 'ISSUED');
});

// ─── المهلة والشبكة والحجم ───

test('المهلة قبل الرد ⇒ RETRY timeout (fetch يتجاهل الإشارة أو يحترمها)، والإشارة تُلغى، وسجلّ واحد بلا حالة HTTP', async () => {
  let seenSignal: AbortSignal | undefined;
  const ignoring: FatooraFetch = (_url, init) => {
    seenSignal = init.signal;
    return new Promise<FatooraFetchResponse>(() => undefined);
  };
  const { client, logs } = makeClient(ignoring, { submissionTimeoutMs: 25 });
  const t0 = Date.now();
  assert.deepEqual(await client.report(CREDS, INVOICE), { kind: 'RETRY', reason: 'timeout' });
  assert.ok(Date.now() - t0 >= 20);
  assert.equal(seenSignal?.aborted, true);
  assert.equal(logs.length, 1);
  assert.deepEqual([logs[0].httpStatus, logs[0].outcome, logs[0].reason, logs[0].errorText, logs[0].response], [null, 'RETRY', 'timeout', 'Timeout', null]);

  const honouring: FatooraFetch = (_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  });
  const h = makeClient(honouring);
  assert.deepEqual(await h.client.requestProductionCsid(CREDS, '1', { timeoutMs: 20 }), { kind: 'RETRY', reason: 'timeout' }, 'مهلة الاستدعاء تطغى على الافتراضي');
  assert.equal(h.logs.length, 1);
});

test('المهلة أثناء قراءة الجسم: 200/400 ⇒ RETRY timeout بحالة مسجَّلة؛ 500 ⇒ server و401 ⇒ AUTH (لا يحتاجان الجسم)', async () => {
  const cases: Array<[number, unknown]> = [[200, { kind: 'RETRY', reason: 'timeout' }], [400, { kind: 'RETRY', reason: 'timeout' }], [500, { kind: 'RETRY', reason: 'server' }], [401, { kind: 'AUTH' }]];
  for (const [status, want] of cases) {
    const hs = hangingStream(new TextEncoder().encode('{"validationResults":'));
    const { client, logs } = makeClient(async () => new Response(hs.stream, { status }), { timeoutMs: 30 });
    assert.deepEqual(await client.clear(CREDS, INVOICE), want, String(status));
    assert.equal(hs.state.cancelled, true, 'الجسم المعلّق يُلغى');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].httpStatus, status);
    assert.equal(logs[0].errorText, 'Timeout');
  }
});

test('أخطاء الشبكة ⇒ RETRY network: رفض fetch، رمي متزامن، وانقطاع الجسم في منتصفه', async () => {
  const rejecting = makeClient(() => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })));
  assert.deepEqual(await rejecting.client.report(CREDS, INVOICE), { kind: 'RETRY', reason: 'network' });
  assert.equal(rejecting.logs[0].errorText, 'TypeError(ECONNRESET)');
  assert.equal(rejecting.logs[0].httpStatus, null);

  const throwing = makeClient(((): never => { throw new RangeError('sync'); }) as unknown as FatooraFetch);
  assert.deepEqual(await throwing.client.requestComplianceCsid(CSR_PEM, OTP), { kind: 'RETRY', reason: 'network' });
  assert.equal(throwing.logs[0].errorText, 'RangeError');

  for (const [status, want] of [[200, { kind: 'RETRY', reason: 'network' }], [503, { kind: 'RETRY', reason: 'server' }]] as const) {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":'));
        setTimeout(() => controller.error(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), 5);
      },
    });
    const b = makeClient(async () => new Response(broken, { status }));
    assert.deepEqual(await b.client.report(CREDS, INVOICE), want);
    assert.equal(b.logs.length, 1);
    assert.equal(b.logs[0].httpStatus, status);
  }
});

test('سقف حجم الجسم: Content-Length معلن، أو تدفّق يتجاوز السقف، أو طول كاذب ⇒ CONFIG body-too-large مع إلغاء الجسم؛ و503 الضخم يبقى RETRY', async () => {
  const cap = 4096;
  // 1) معلن أكبر من السقف: لا يُقرأ الجسم
  const hs = hangingStream();
  const declared = makeClient(async () => new Response(hs.stream, { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } }), { maxResponseBytes: cap });
  assert.deepEqual(await declared.client.report(CREDS, INVOICE), { kind: 'CONFIG', detail: 'body-too-large' });
  assert.equal(hs.state.cancelled, true);
  assert.equal(declared.logs[0].responseBytes, 10 * 1024 * 1024);
  assert.equal(declared.logs[0].response?.body, 'too-large');

  // 2) تدفّق بلا طول معلن يتجاوز السقف: يتوقّف عند تجاوزه ويُلغى
  let pulls = 0;
  const state = { cancelled: false };
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(1024).fill(0x41));
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 });
  const streamed = makeClient(async () => new Response(endless, { status: 208 }), { maxResponseBytes: cap });
  assert.deepEqual(await streamed.client.clear(CREDS, INVOICE), { kind: 'CONFIG', detail: 'body-too-large' });
  assert.equal(state.cancelled, true);
  assert.ok(pulls <= 8, `قرأ ${pulls} قطعة فقط`);

  // 3) طول معلن كاذب (صغير) وجسم أكبر
  const lying = makeClient(async () => new Response('x'.repeat(cap * 3), { status: 400, headers: { 'content-length': '10' } }), { maxResponseBytes: cap });
  assert.deepEqual(await lying.client.report(CREDS, INVOICE), { kind: 'CONFIG', detail: 'body-too-large' });

  // 4) الحالات المستقلّة عن الجسم لا تتأثّر
  const big503 = makeClient(async () => new Response('<html>'.repeat(cap), { status: 503 }), { maxResponseBytes: cap });
  assert.deepEqual(await big503.client.report(CREDS, INVOICE), { kind: 'RETRY', reason: 'server' });

  // 5) الافتراضي 8 MiB: رد عادي يمرّ
  const normal = makeClient(async () => fixtureResponse('clearance-200'));
  assert.equal((await normal.client.clear(CREDS, INVOICE)).kind, 'ACCEPTED');
});

test('ردود fetch غير صالحة ⇒ CONFIG invalid-fetch-response؛ ومسار arrayBuffer الاحتياطي يعمل', async () => {
  for (const bad of [null, undefined, 42, {}, { status: 0 }, { status: '200' }, { status: 99 }, { status: 600 }, { status: 200.5 }]) {
    const { client, logs } = makeClient(async () => bad as unknown as FatooraFetchResponse);
    assert.deepEqual(await client.report(CREDS, INVOICE), { kind: 'CONFIG', detail: 'invalid-fetch-response' }, JSON.stringify(bad));
    assert.equal(logs.length, 1);
    assert.equal(logs[0].httpStatus, null);
  }
  const raw = z3Fixture('reporting-202').raw;
  const ab = makeClient(async () => ({ status: 202, arrayBuffer: async () => new TextEncoder().encode(raw).buffer as ArrayBuffer }));
  assert.equal((await ab.client.report(CREDS, INVOICE)).kind, 'ACCEPTED');
  const bodiless = makeClient(async () => ({ status: 200 }));
  assert.deepEqual(await bodiless.client.report(CREDS, INVOICE), { kind: 'CONFIG', detail: 'empty-body' });
  const bigAb = makeClient(async () => ({ status: 200, arrayBuffer: async () => new ArrayBuffer(8192) }), { maxResponseBytes: 4096 });
  assert.deepEqual(await bigAb.client.report(CREDS, INVOICE), { kind: 'CONFIG', detail: 'body-too-large' });
});

// ─── السجلّ ───

test('log يُستدعى مرة واحدة بالضبط لكل محاولة؛ فشله أو رميه أو تعليقه لا يغيّر النتيجة', async () => {
  const responses = ['reporting-400-null-messages', 'reporting-409-production', 'error-401'];
  let n = 0;
  const fetch: FatooraFetch = async () => fixtureResponse(responses[n++ % responses.length]);
  const count = { calls: 0 };
  const variants: Array<[string, FatooraClientOptions['log']]> = [
    ['ok', async () => { count.calls++; }],
    ['reject', async () => { count.calls++; throw new Error('db down'); }],
    ['sync-throw', ((): never => { count.calls++; throw new Error('sync'); }) as unknown as FatooraClientOptions['log']],
    ['hang', () => { count.calls++; return new Promise<void>(() => undefined); }],
    ['not-a-promise', (() => { count.calls++; return 'x'; }) as unknown as FatooraClientOptions['log']],
  ];
  for (const [label, log] of variants) {
    n = 0;
    count.calls = 0;
    const client = new FatooraClient({ env: 'sandbox', fetch, log, logTimeoutMs: 30 });
    const got = [await client.report(CREDS, INVOICE), await client.report(CREDS, INVOICE, { attempt: 2 }), await client.report(CREDS, INVOICE)];
    assert.deepEqual(got, [{ kind: 'RETRY', reason: 'empty400' }, { kind: 'DUPLICATE' }, { kind: 'AUTH' }], label);
    assert.equal(count.calls, 3, label);
  }
});

/**
 * سائق يحاكي Z5: attempt يزيد مع كل محاولة، وكل عدّاد تصعيد يزيد فقط حين تعود RETRY بسببه.
 * يعيد النتائج بالترتيب ويتوقّف عند أول نتيجة نهائية.
 */
async function driveLikeZ5(send: (call: CallOptions) => Promise<Outcome>, maxAttempts: number): Promise<Outcome[]> {
  const out: Outcome[] = [];
  let priorEmpty400 = 0;
  let priorPayload413 = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const o = await send({ attempt, priorEmpty400, priorPayload413 });
    out.push(o);
    if (o.kind !== 'RETRY') break;
    if (o.reason === 'empty400') priorEmpty400++;
    if (o.reason === 'payload') priorPayload413++;
  }
  return out;
}

test('التصعيد بعدّاد الردود من النوع نفسه لا برقم المحاولة: انقطاع طويل ثم 400 فارغ ⇒ ثلاث إعادات ثم REJECTED؛ ومهلة ثم 413 ⇒ إعادة ثم CONFIG', async () => {
  // 503 ×4 ثم 400 فارغ دائماً: أول 400 فارغ في المحاولة 5 يبقى RETRY empty400 (كان REJECTED)
  let n = 0;
  const { client, logs } = makeClient(async () => (++n <= 4 ? new Response('<html>unavailable</html>', { status: 503 }) : fixtureResponse('reporting-400-null-messages')));
  const seq = await driveLikeZ5(call => client.report(CREDS, INVOICE, call), 20);
  assert.deepEqual(seq.slice(0, 7), [
    { kind: 'RETRY', reason: 'server' }, { kind: 'RETRY', reason: 'server' }, { kind: 'RETRY', reason: 'server' }, { kind: 'RETRY', reason: 'server' },
    { kind: 'RETRY', reason: 'empty400' }, { kind: 'RETRY', reason: 'empty400' }, { kind: 'RETRY', reason: 'empty400' },
  ]);
  assert.equal(seq.length, 8);
  const last = seq[7];
  assert.equal(last.kind, 'REJECTED');
  assert.equal(last.kind === 'REJECTED' && last.errors[0].code, EMPTY400_EXHAUSTED_CODE);
  assert.ok(last.kind === 'REJECTED' && last.errors[0].message!.includes(' 4 '), 'الرسالة تذكر أربعة ردود فارغة لا ثماني محاولات');
  assert.deepEqual(logs.map(l => [l.attempt, l.httpStatus, l.outcome, l.reason]), [
    [1, 503, 'RETRY', 'server'], [2, 503, 'RETRY', 'server'], [3, 503, 'RETRY', 'server'], [4, 503, 'RETRY', 'server'],
    [5, 400, 'RETRY', 'empty400'], [6, 400, 'RETRY', 'empty400'], [7, 400, 'RETRY', 'empty400'], [8, 400, 'REJECTED', null],
  ], 'attempt يُسجَّل كما هو ولا يؤثّر في التصنيف');

  // مباشرة: رقم محاولة كبير بلا ردود فارغة سابقة ⇒ RETRY؛ ثلاثة سابقة ولو في المحاولة الرابعة ⇒ REJECTED
  assert.deepEqual(await client.report(CREDS, INVOICE, { attempt: 50 }), { kind: 'RETRY', reason: 'empty400' });
  const r = await client.report(CREDS, INVOICE, { attempt: 4, priorEmpty400: 3 });
  assert.equal(r.kind === 'REJECTED' && r.errors[0].code, EMPTY400_EXHAUSTED_CODE);

  // مهلة ثم 413 ×2 على الاعتماد: الإعادة الوحيدة محفوظة
  let k = 0;
  const big = makeClient(async (_url, init) => {
    k++;
    if (k === 1) return new Promise<FatooraFetchResponse>((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    return new Response('', { status: 413 });
  }, { submissionTimeoutMs: 20 });
  const bigSeq = await driveLikeZ5(call => big.client.clear(CREDS, INVOICE, call), 10);
  assert.deepEqual(bigSeq, [{ kind: 'RETRY', reason: 'timeout' }, { kind: 'RETRY', reason: 'payload' }, { kind: 'CONFIG', detail: 'payload-too-large' }]);
  assert.deepEqual(big.logs.map(l => [l.attempt, l.outcome, l.reason]), [[1, 'RETRY', 'timeout'], [2, 'RETRY', 'payload'], [3, 'CONFIG', 'payload-too-large']]);
  assert.deepEqual(await big.client.clear(CREDS, INVOICE, { attempt: 9, priorEmpty400: 3 }), { kind: 'RETRY', reason: 'payload' }, 'عدّاد empty400 لا يمسّ 413');
  assert.deepEqual(await big.client.clear(CREDS, INVOICE, { priorPayload413: 1 }), { kind: 'CONFIG', detail: 'payload-too-large' });
  // على مسارات الشهادات كذلك
  assert.deepEqual(await big.client.requestProductionCsid(CREDS, '1', { attempt: 7 }), { kind: 'RETRY', reason: 'payload' });
});

test('Retry-After يُحمل مع 429/503 فقط', async () => {
  const rate = makeClient(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }));
  assert.deepEqual(await rate.client.report(CREDS, INVOICE), { kind: 'RETRY', reason: 'rate', retryAfterSeconds: 120 });
  const unavailable = makeClient(async () => new Response('', { status: 503, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } }));
  assert.deepEqual(await unavailable.client.report(CREDS, INVOICE), { kind: 'RETRY', reason: 'server' }, 'صيغة التاريخ تُتجاهل');
  const huge = makeClient(async () => new Response('', { status: 503, headers: { 'retry-after': '999999' } }));
  assert.deepEqual(await huge.client.report(CREDS, INVOICE), { kind: 'RETRY', reason: 'server' });
  const timeoutNoHeader = makeClient(async () => new Response('', { status: 400, headers: { 'retry-after': '5' } }));
  assert.equal((await timeoutNoHeader.client.report(CREDS, INVOICE)).kind, 'CONFIG', 'Retry-After لا يغيّر غير RETRY');
});

test('303 مع Location لا يُتبَع (redirect manual) ⇒ CLEARANCE_OFF؛ والمدّة من الساعة المحقونة', async () => {
  const ticks = [1000, 1250.4];
  const { client, logs } = makeClient(async (_url, init) => {
    assert.equal(init.redirect, 'manual');
    return new Response(z3Fixture('clearance-303').raw, { status: 303, headers: { location: 'https://evil.example/steal' } });
  }, { clock: () => ticks.shift() ?? 0 });
  assert.deepEqual(await client.clear(CREDS, INVOICE), { kind: 'CLEARANCE_OFF' });
  assert.equal(logs[0].durationMs, 250);
  assert.equal(logs[0].response?.errors[0].message, 'Clearance is deactiviated. Please use the /invoices/reporting/single endpoint instead.');
});

test('المهلة الافتراضية: 60 ث للربط و30 ث للإرسال، وcompliance/invoices من فئة الربط', async () => {
  assert.equal(DEFAULT_ONBOARDING_TIMEOUT_MS, 60000);
  assert.equal(DEFAULT_SUBMISSION_TIMEOUT_MS, 30000);
  const delayed = (ms: number, name: string): FatooraFetch => () => new Promise(resolve => setTimeout(() => resolve(fixtureResponse(name)), ms));
  // الربط قصير والإرسال طويل
  const a = makeClient(delayed(80, 'compliance-invoices-200'), { onboardingTimeoutMs: 20, submissionTimeoutMs: 5000 });
  assert.deepEqual(await a.client.checkComplianceInvoice(CREDS, INVOICE), { kind: 'RETRY', reason: 'timeout' });
  const b = makeClient(delayed(80, 'reporting-200'), { onboardingTimeoutMs: 20, submissionTimeoutMs: 5000 });
  assert.equal((await b.client.report(CREDS, INVOICE)).kind, 'ACCEPTED');
  // والعكس
  const c = makeClient(delayed(80, 'clearance-200'), { onboardingTimeoutMs: 5000, submissionTimeoutMs: 20 });
  assert.deepEqual(await c.client.clear(CREDS, INVOICE), { kind: 'RETRY', reason: 'timeout' });
  const d = makeClient(delayed(80, 'compliance-200'), { onboardingTimeoutMs: 5000, submissionTimeoutMs: 20 });
  assert.equal((await d.client.requestComplianceCsid(CSR_PEM, OTP)).kind, 'ISSUED');
});

// ─── التحقق قبل أي اتصال ───

test('المُدخلات المعيبة تُرفض قبل fetch وقبل log، والرسالة تسمّي الحقل دون قيمته', async () => {
  const { fetch, calls } = recorder(() => fixtureResponse('reporting-200'));
  const { client, logs } = makeClient(fetch);

  for (const otp of ['12345', '1234567', '12a456', ' 123456', '123456\n', '١٢٣٤٥٦', '', 123456 as unknown as string, null as unknown as string]) {
    await rejectsInput(client.requestComplianceCsid(CSR_PEM, otp), 'otp', [String(otp)]);
    await rejectsInput(client.renewProductionCsid(CREDS, CSR_PEM, otp), 'otp', [String(otp)]);
  }
  // مفتاح مبتور مزيّف يُبنى وقت التشغيل: لا نصّ «BEGIN … KEY» حرفياً في المستودع العام فتُنبّه ماسحات الأسرار
  const keyLabel = ['PRIVATE', 'KEY'].join(' ');
  const keyPem = `-----BEGIN ${keyLabel}-----\nMIGEAgEAMBAGByqGSM49AgEGBSuBBAAKBG0wawIBAQQg\n-----END ${keyLabel}-----\n`;
  for (const pem of ['', 'not a pem', keyPem, CSR_PEM.replace('MIICFTCC', 'MIICFTC!'), CSR_PEM.slice(0, 200), `${CSR_PEM}${'A'.repeat(20000)}`, Buffer.from(CSR_PEM).toString('base64'),
    '-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----\n', 42 as unknown as string]) {
    await rejectsInput(client.requestComplianceCsid(pem, OTP), 'csrPem', [OTP]);
  }
  for (const [creds, field] of [
    [null, 'creds'], [{ token: '', secret: 's' }, 'creds.token'], [{ token: 'not base64!', secret: 's' }, 'creds.token'],
    [{ token: `${CREDS.token}\n`, secret: CREDS.secret }, 'creds.token'], [{ token: CREDS.token, secret: '' }, 'creds.secret'],
    [{ token: CREDS.token, secret: 'has space' }, 'creds.secret'], [{ token: CREDS.token, secret: 'line\nbreak' }, 'creds.secret'],
    [{ token: CREDS.token, secret: 'x'.repeat(513) }, 'creds.secret'], [{ token: CREDS.token }, 'creds.secret'],
  ] as Array<[Creds, string]>) {
    await rejectsInput(client.report(creds, INVOICE), field, [CREDS.secret, 'has space']);
    await rejectsInput(client.requestProductionCsid(creds, '1'), field, [CREDS.secret]);
  }
  const bodies: Array<[Partial<InvoiceBody> | null, string]> = [
    [null, 'body'],
    [{ ...INVOICE, invoiceHash: 'not base64' }, 'body.invoiceHash'],
    [{ ...INVOICE, invoiceHash: Buffer.alloc(31).toString('base64') }, 'body.invoiceHash'],
    [{ ...INVOICE, invoiceHash: Buffer.alloc(33).toString('base64') }, 'body.invoiceHash'],
    [{ ...INVOICE, invoiceHash: 'a'.repeat(64) }, 'body.invoiceHash'],
    [{ ...INVOICE, invoiceHash: ` ${INVOICE.invoiceHash}` }, 'body.invoiceHash'],
    [{ ...INVOICE, uuid: '' }, 'body.uuid'],
    [{ ...INVOICE, uuid: '8d487816-70b8-4ade-a618-9d620b73814' }, 'body.uuid'],
    [{ ...INVOICE, uuid: '8d487816_70b8_4ade_a618_9d620b73814a' }, 'body.uuid'],
    [{ ...INVOICE, uuid: '{8d487816-70b8-4ade-a618-9d620b73814a}' }, 'body.uuid'],
    [{ ...INVOICE, invoice: '' }, 'body.invoice'],
    [{ ...INVOICE, invoice: 'not base64' }, 'body.invoice'],
    [{ ...INVOICE, invoice: Buffer.from('hello, not xml').toString('base64') }, 'body.invoice'],
    [{ ...INVOICE, invoice: `${INVOICE.invoice.slice(0, 20)}\n${INVOICE.invoice.slice(20)}` }, 'body.invoice'],
    [{ ...INVOICE, invoice: Buffer.from(`<${'a'.repeat(4 * 1024 * 1024 + 10)}`).toString('base64') }, 'body.invoice'],
    [{ invoiceHash: INVOICE.invoiceHash, uuid: INVOICE.uuid }, 'body.invoice'],
  ];
  for (const [body, field] of bodies) {
    await rejectsInput(client.report(CREDS, body as InvoiceBody), field);
    await rejectsInput(client.clear(CREDS, body as InvoiceBody), field);
    await rejectsInput(client.checkComplianceInvoice(CREDS, body as InvoiceBody), field);
  }
  for (const id of ['', 'abc', '-2', '0', '01', '1'.repeat(31), 1234 as unknown as string]) {
    await rejectsInput(client.requestProductionCsid(CREDS, id), 'complianceRequestId');
  }
  for (const call of [{ attempt: 0 }, { attempt: 1.5 }, { attempt: -1 }, { attempt: 10001 }, null] as unknown as CallOptions[]) {
    await rejectsInput(client.report(CREDS, INVOICE, call), 'attempt');
  }
  for (const field of ['priorEmpty400', 'priorPayload413'] as const) {
    for (const v of [-1, 1.5, NaN, MAX_ESCALATION_COUNT + 1, '0', {}]) {
      await rejectsInput(client.report(CREDS, INVOICE, { [field]: v } as unknown as CallOptions), field);
      await rejectsInput(client.renewProductionCsid(CREDS, CSR_PEM, OTP, { [field]: v } as unknown as CallOptions), field, [OTP]);
    }
  }
  for (const call of [{ timeoutMs: 0 }, { timeoutMs: 1.5 }, { timeoutMs: 600001 }, { timeoutMs: NaN }] as CallOptions[]) {
    await rejectsInput(client.report(CREDS, INVOICE, call), 'timeoutMs');
  }
  assert.equal(calls.length, 0, 'لا fetch');
  assert.equal(logs.length, 0, 'لا سجلّ بلا محاولة HTTP');
  // والمُدخل الصالح نفسه يمرّ (الاختبار يرفض لسبب المُدخل لا لعطل عام)
  assert.equal((await client.report(CREDS, { ...INVOICE, uuid: INVOICE.uuid.toUpperCase() })).kind, 'ACCEPTED');
  assert.equal(calls.length, 1);
});

test('خيارات العميل: env وlog وfetch والمهل والحدود واللغة تُتحقَّق عند الإنشاء', () => {
  const log = async () => undefined;
  const bad: Array<[unknown, string]> = [
    [undefined, 'options'], [{ env: 'staging', log }, 'options'], [{ env: 'sandbox' }, 'options'], [{ env: 'sandbox', log, fetch: 'x' }, 'options'],
    [{ env: 'sandbox', log, timeoutMs: 0 }, 'timeoutMs'], [{ env: 'sandbox', log, onboardingTimeoutMs: 1e9 }, 'timeoutMs'], [{ env: 'sandbox', log, logTimeoutMs: -5 }, 'timeoutMs'],
    [{ env: 'sandbox', log, maxResponseBytes: 10 }, 'options'], [{ env: 'sandbox', log, maxResponseBytes: RESPONSE_LIMITS.maxBodyBytes + 1 }, 'options'],
    [{ env: 'sandbox', log, acceptLanguage: 'fr' }, 'options'], [{ env: 'sandbox', log, clock: 5 }, 'options'],
    [{ env: '__proto__', log }, 'options'],
  ];
  for (const [opts, field] of bad) {
    assert.throws(() => new FatooraClient(opts as FatooraClientOptions), (e: unknown) => e instanceof FatooraInputError && e.field === field, JSON.stringify(opts));
  }
  const c = new FatooraClient({ env: 'simulation', log });
  assert.equal(c.env, 'simulation');
  assert.equal(c.baseUrl, FATOORA_BASE_URLS.simulation);
});

// ─── أدوات CSID ───

test('decodeCsid يفكّ شهادتَي مثال Swagger (امتثال وإنتاج) عبر parseCsidToken، وcredsFromCsid يعيد الرمز حرفياً', async () => {
  const { fetch } = recorder((_, n) => (n === 1 ? fixtureResponse('compliance-200') : fixtureResponse('production-csid-200')));
  const { client } = makeClient(fetch);
  const cc = await client.requestComplianceCsid(CSR_PEM, OTP);
  const pc = await client.requestProductionCsid(CREDS, '1234567890123');
  assert.ok(cc.kind === 'ISSUED' && pc.kind === 'ISSUED');
  if (cc.kind !== 'ISSUED' || pc.kind !== 'ISSUED') return;

  const ccert = decodeCsid(cc.csid);
  assert.equal(ccert.issuerName, 'CN=eInvoicing');
  assert.equal(ccert.serialDecimal, '1704892319821');
  assert.equal(ccert.notBefore.toISOString(), '2024-01-10T13:11:54.000Z');
  assert.equal(ccert.notAfter.toISOString(), '2029-01-09T21:00:00.000Z');
  assert.equal(ccert.certB64, Buffer.from(cc.csid.binarySecurityToken, 'base64').toString('latin1'));
  assert.equal(ccert.spkiDer.length, 88);

  const pcert = decodeCsid(pc.csid);
  assert.equal(pcert.issuerName, 'CN=PRZEINVOICESCA4-CA, DC=extgazt, DC=gov, DC=local');
  assert.equal(pcert.notAfter.toISOString(), '2029-01-09T09:19:30.000Z');

  assert.deepEqual(credsFromCsid(cc.csid), CREDS);
  assert.ok(credsFromCsid(pc.csid).token.startsWith('TUlJRDNqQ0NBNFNn'));
  assert.throws(() => decodeCsid({ binarySecurityToken: Buffer.from('not a certificate').toString('base64') }), CsidCertError);
  assert.throws(() => decodeCsid({ binarySecurityToken: ccert.certB64 }), CsidCertError, 'نصّ الشهادة نفسه ليس رمزاً');
});
