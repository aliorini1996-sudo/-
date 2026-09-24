// ZATCA المرحلة الثانية (Z5.7) — اختبارات مسارات شاشة المتابعة وتنزيل الـXML عبر الموجّه الحقيقي.
//
// لا قاعدة بيانات ولا شبكة: عميل Prisma **مزيّف** يُحقن في require.cache قبل تحميل الموجّه، ومعه بديلٌ لـ
// `services/zatcaSubmit` (مفتاح الإيقاف). وحارسا الصلاحية والنطاق (`requireAdmin`، `scopedRecordWhere`) **حقيقيّان**:
// المصادقة وحدها تُزوَّر بوضع `req.user` قبل الموجّه، كما يفعل `routes/invoices.ts` قبل أن يسقط الطلب إلينا.
//
// المطلوب إثباته:
//   ١) **شركةٌ غير مفعّلة للمرحلة الثانية لا تُستعلَم**: قراءة الإعدادات وحدها، ثم ردّ `live:false` — ولا مسار
//      مستندٍ يُفتح لها (404). هذه هي قاعدة «لا أثر على من ليس حيّاً» مقيسةً بعدد الاستعلامات لا بالنيّة.
//   ٢) **العزل**: كل استعلامٍ يحمل `tenantId` الجلسة، وكل مرشِّح فواتير يحمل `zatcaPhase: 2`، وقيد نطاق المستخدم
//      المقيَّد يُنثر في الاستعلام نفسه.
//   ٣) **الصلاحيات**: المندوب ممنوع، ومستخدم الشركة يقرأ، ومفتاح إيقاف الإرسال لمدير الشركة (ADMIN) وحده.
//   ٤) **البايتات**: نسخةٌ غير مخزَّنة ⇒ 404 لا ملفٌّ فارغ؛ وترويسات التنزيل معقَّمة.
//   ٥) **التنقية**: لا سرّ ولا جسم ردٍّ خام ولا بايتات XML في أيّ ردّ JSON.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import express from 'express';

// ═══ حقن البدائل قبل تحميل الموجّه ═══

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

interface Call { key: string; args: Record<string, unknown> }
let calls: Call[] = [];
let scripted: Record<string, (args: Record<string, unknown>) => unknown> = {};

const defaultFor = (method: string): unknown => {
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (method === 'aggregate') return { _count: { _all: 0 }, _min: { reportDeadline: null } };
  if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
  return null;
};

const modelProxy = (model: string): unknown => new Proxy({}, {
  get: (_t, method: string) => async (args: Record<string, unknown>) => {
    const key = `${model}.${method}`;
    calls.push({ key, args: args ?? {} });
    const fn = scripted[key];
    return fn ? fn(args ?? {}) : defaultFor(method);
  },
});

const prismaFake: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === 'then') return undefined;
    if (key === '$transaction') return async (a: unknown) => (typeof a === 'function' ? (a as (tx: unknown) => unknown)(prismaFake) : a);
    if (key === '$queryRaw' || key === '$executeRaw') return async () => (key === '$queryRaw' ? [] : 0);
    return modelProxy(key);
  },
});

let pauseCalls: Array<{ tenantId: string; paused: boolean }> = [];
/** سلوك بديل لمفتاح الإيقاف في اختبارٍ واحد (الاستيراد الديناميكي يُحلّ مرّة، فالتبديل هنا لا في require.cache). */
let pauseImpl: ((tenantId: string, paused: boolean) => Promise<{ tenantId: string; pausedAt: Date | null }>) | null = null;
stub('config/database', { default: prismaFake });
stub('services/zatcaSubmit', {
  setTenantSubmitPaused: async (tenantId: string, paused: boolean) => {
    pauseCalls.push({ tenantId, paused });
    if (pauseImpl) return pauseImpl(tenantId, paused);
    return { tenantId, pausedAt: paused ? new Date('2026-09-23T08:00:00.000Z') : null };
  },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = (require(path.join(SRC, 'routes/invoicesEinvoiceDocs')) as { default: express.Router }).default;

// ═══ الخادم ═══

const TENANT = 'tenant-live-1';
let currentUser: { id: string; role: string; tenantId: string } = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT };

const app = express();
app.use(express.json());
// `routes/invoices.ts` يفتح بـauthenticate، فالطلب يصل موجّهنا مصدَّقاً
app.use((req, _res, next) => { (req as express.Request & { user?: unknown }).user = currentUser; next(); });
app.use('/api/invoices', router);
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ success: false, message: err?.message ?? 'خطأ' });
});

const server = http.createServer(app).listen(0);
const base = (): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.close(); });

interface Reply { status: number; body: Record<string, unknown>; text: string; headers: Headers }

async function call(method: string, url: string, body?: unknown): Promise<Reply> {
  const r = await fetch(`${base()}${url}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* نصّ XML */ }
  return { status: r.status, body: parsed, text, headers: r.headers };
}

const reset = (): void => { calls = []; scripted = {}; pauseCalls = []; pauseImpl = null; currentUser = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT }; };
const keys = (): string[] => calls.map(c => c.key);
const argsOf = (key: string): Record<string, unknown> | undefined => calls.find(c => c.key === key)?.args;
const whereOf = (key: string): Record<string, unknown> => (argsOf(key)?.where ?? {}) as Record<string, unknown>;
const data = (r: Reply): Record<string, unknown> => r.body.data as Record<string, unknown>;

const live = (paused: Date | null = null) => {
  scripted['companySettings.findUnique'] = () => ({ zatcaPhase2StartedAt: new Date('2026-01-01T00:00:00.000Z'), zatcaSubmitPausedAt: paused });
};
const notLive = (): void => { scripted['companySettings.findUnique'] = () => ({ zatcaPhase2StartedAt: null, zatcaSubmitPausedAt: null }); };

const invoiceRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'inv-1', number: 'INV-001', invoiceDate: new Date('2026-09-20T00:00:00.000Z'),
  issuedAt: new Date('2026-09-20T09:00:00.000Z'), total: 115, currency: 'SAR', status: 'CONFIRMED',
  einvoiceStatus: 'clearance_pending', einvoiceWarnings: null, invoiceSubtype: '01', documentKind: 'INVOICE',
  customer: { id: 'cust-1', name: 'عميل' }, ...over,
});

const docRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'doc-1', invoiceId: 'inv-1', attemptNo: 1, icv: 7, uuid: 'uuid-1', typeName: '0100000', typeCode: '388',
  flow: 'CLEARANCE', status: 'RETRY_WAIT', httpStatus: 500, validation: null, attempts: 2, sentAttempts: 1,
  nextAttemptAt: null, firstSubmitAt: null, finalizedAt: null, reportDeadline: null,
  issueDate: '2026-09-20', issueTime: '12:00:00', updatedAt: new Date('2026-09-20T12:00:00.000Z'), ...over,
});

// ═══ ١) الشركة غير المفعّلة لا تُستعلَم ═══

test('الملخّص لشركة غير مفعّلة: قراءة الإعدادات وحدها ثم live:false بلا أي استعلام آخر', async () => {
  reset(); notLive();
  const r = await call('GET', '/api/invoices/einvoice/summary');
  assert.equal(r.status, 200);
  assert.equal(data(r).live, false);
  assert.deepEqual(data(r).counts, { overdue: 0, blocked: 0, pending: 0, rejected: 0, done: 0 });
  assert.deepEqual(keys(), ['companySettings.findUnique'], `استعلامات زائدة: ${keys().join(', ')}`);
});

test('القائمة لشركة غير مفعّلة: صفر صفوف واستعلامٌ واحد — ولا لمسٌ لجدول الفواتير', async () => {
  reset(); notLive();
  const r = await call('GET', '/api/invoices/einvoice/documents?state=overdue');
  assert.equal(r.status, 200);
  assert.equal(data(r).live, false);
  assert.deepEqual(data(r).rows, []);
  assert.deepEqual(keys(), ['companySettings.findUnique']);
});

test('مفتاح الإيقاف لشركة غير مفعّلة: 404 ولا كتابة', async () => {
  reset(); notLive();
  const r = await call('POST', '/api/invoices/einvoice/submit-pause', { paused: true });
  assert.equal(r.status, 404);
  assert.equal(pauseCalls.length, 0);
  assert.equal(keys().includes('zatcaApiLog.create'), false);
});

test('تنزيل XML لشركة بلا مستندات (مرحلة أولى): 404 وبلا قراءة بايتات', async () => {
  reset();
  scripted['zatcaDocument.findFirst'] = () => null;
  const r = await call('GET', '/api/invoices/inv-1/einvoice/xml');
  assert.equal(r.status, 404);
  assert.equal(keys().includes('zatcaDocument.findUnique'), false, 'قُرئت البايتات بلا مستند');
});

// ═══ ٢) الملخّص ═══

test('الملخّص: عدّاداتٌ عن الشركة كلّها بثلاثة استعلامات، ومرشِّحان يحملان العزل', async () => {
  reset(); live(new Date('2026-09-22T00:00:00.000Z'));
  scripted['invoice.groupBy'] = () => ([
    { einvoiceStatus: 'clearance_pending', _count: { _all: 5 } },
    { einvoiceStatus: 'reported', _count: { _all: 10 } },
    { einvoiceStatus: 'rejected', _count: { _all: 2 } },
    { einvoiceStatus: 'report_blocked', _count: { _all: 3 } },
  ]);
  scripted['zatcaDocument.aggregate'] = () => ({ _count: { _all: 4 }, _min: { reportDeadline: new Date('2026-09-21T00:00:00.000Z') } });

  const r = await call('GET', '/api/invoices/einvoice/summary');
  assert.equal(r.status, 200);
  assert.equal(data(r).live, true);
  assert.deepEqual(data(r).counts, { overdue: 4, blocked: 0, pending: 4, rejected: 2, done: 10 });
  assert.equal(data(r).total, 20);
  assert.equal(data(r).submitPausedAt, '2026-09-22T00:00:00.000Z', 'حال مفتاح الإيقاف يصل الشاشة');
  assert.ok(data(r).earliestDeadlineAt);

  const g = whereOf('invoice.groupBy');
  assert.equal(g.tenantId, TENANT);
  assert.equal(g.zatcaPhase, 2, 'صفوف المرحلة الأولى لا تُعدّ');
  const a = whereOf('zatcaDocument.aggregate');
  assert.equal(a.tenantId, TENANT);
  assert.ok((a.reportDeadline as { lt?: Date })?.lt instanceof Date);
  assert.equal(((a.status as { in?: string[] })?.in ?? []).includes('REJECTED'), false, 'المحسوم لا يُعدّ متأخّراً');
});

// ═══ ٣) القائمة ═══

test('القائمة (all): استعلامان، وآخر محاولة هي المعروضة، ولا بايتات في الردّ', async () => {
  reset(); live();
  scripted['invoice.findMany'] = () => ([invoiceRow(), invoiceRow({ id: 'inv-2', number: 'INV-002', einvoiceStatus: 'cleared' })]);
  scripted['zatcaDocument.findMany'] = () => ([
    docRow({ id: 'doc-1b', attemptNo: 2, status: 'REJECTED', validation: { errors: [{ type: 'ERROR', code: 'BR-KSA-01', message: 'الرقم الضريبي غير صحيح' }] } }),
    docRow({ id: 'doc-1a', attemptNo: 1 }),
    docRow({ id: 'doc-2', invoiceId: 'inv-2', status: 'CLEARED' }),
  ]);

  const r = await call('GET', '/api/invoices/einvoice/documents');
  assert.equal(r.status, 200);
  const rows = data(r).rows as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  const first = rows[0];
  assert.equal((first.document as Record<string, unknown>).id, 'doc-1b', 'آخر محاولة');
  assert.equal((first.lastMessage as Record<string, unknown>).code, 'BR-KSA-01');
  assert.deepEqual((rows[1].document as Record<string, unknown>).xml, { signed: true, cleared: true });
  assert.deepEqual((first.document as Record<string, unknown>).xml, { signed: true, cleared: false });

  const w = whereOf('invoice.findMany');
  assert.equal(w.tenantId, TENANT);
  assert.equal(w.zatcaPhase, 2);
  assert.ok(Array.isArray((w.einvoiceStatus as { in?: string[] })?.in));
  const dw = whereOf('zatcaDocument.findMany');
  assert.equal(dw.tenantId, TENANT);
  assert.deepEqual((dw.invoiceId as { in?: string[] })?.in, ['inv-1', 'inv-2']);
  const sel = (argsOf('zatcaDocument.findMany')?.select ?? {}) as Record<string, unknown>;
  assert.equal('xmlGz' in sel, false, 'بايتات الـXML في مرشِّح القائمة');
  assert.equal('clearedXmlGz' in sel, false);
  assert.equal(r.text.includes('xmlGz'), false);
  assert.equal(((argsOf('invoice.findMany')?.select ?? {}) as Record<string, unknown>).einvoiceSnapshot, undefined);
});

test('القائمة (overdue): تُقرأ من فهرس المهلة لا من جدول الفواتير، والدلو «متأخّر»', async () => {
  reset(); live();
  scripted['zatcaDocument.findMany'] = () => ([{
    ...docRow({ status: 'SIGNED', typeName: '0200000', reportDeadline: new Date('2026-09-19T00:00:00.000Z') }),
    invoice: invoiceRow({ einvoiceStatus: 'signed', invoiceSubtype: '02' }),
  }]);

  const r = await call('GET', '/api/invoices/einvoice/documents?state=overdue&limit=10');
  assert.equal(r.status, 200);
  assert.equal(keys().includes('invoice.findMany'), false, 'مسحٌ لجدول الفواتير في مسار التأخّر');
  const rows = data(r).rows as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bucket, 'overdue');
  assert.equal(rows[0].overdue, true);
  const w = whereOf('zatcaDocument.findMany');
  assert.equal(w.tenantId, TENANT);
  assert.ok((w.reportDeadline as { lt?: Date })?.lt instanceof Date);
  assert.equal(((w.status as { in?: string[] })?.in ?? []).includes('SIGNED'), true);
});

test('القائمة: الحدّ يُقصّ وhasMore يُعلن، والحدّ الأقصى لا يُتجاوز', async () => {
  reset(); live();
  scripted['invoice.findMany'] = () => Array.from({ length: 3 }, (_, i) => invoiceRow({ id: `inv-${i}` }));
  const r = await call('GET', '/api/invoices/einvoice/documents?limit=2');
  assert.equal((data(r).rows as unknown[]).length, 2);
  assert.equal(data(r).hasMore, true);
  assert.equal(argsOf('invoice.findMany')?.take, 3);

  reset(); live();
  await call('GET', '/api/invoices/einvoice/documents?limit=99999');
  assert.equal(argsOf('invoice.findMany')?.take, 201, 'حدّ أقصى 200');
  reset(); live();
  await call('GET', '/api/invoices/einvoice/documents?limit=abc&offset=-5');
  assert.equal(argsOf('invoice.findMany')?.take, 51);
  assert.equal(argsOf('invoice.findMany')?.skip, 0);
});

test('القائمة: مرشِّح دلوٍ واحد يحمل مرايا ذلك الدلو وحدها', async () => {
  reset(); live();
  await call('GET', '/api/invoices/einvoice/documents?state=rejected');
  assert.deepEqual((whereOf('invoice.findMany').einvoiceStatus as { in: string[] }).in, ['rejected', 'withdrawn']);
  reset(); live();
  await call('GET', '/api/invoices/einvoice/documents?state=خبيث');
  assert.equal((data(await call('GET', '/api/invoices/einvoice/documents?state=خبيث')) as Record<string, unknown>).state, 'all');
});

test('نطاق مستخدم الشركة المقيَّد يُنثر في استعلام القائمة نفسه', async () => {
  reset(); live();
  currentUser = { id: 'mgr-1', role: 'MANAGER', tenantId: TENANT };
  scripted['admin.findUnique'] = () => ({ scopeEnabled: true });
  await call('GET', '/api/invoices/einvoice/documents');
  const w = whereOf('invoice.findMany');
  assert.ok(Array.isArray(w.AND), 'قيد النطاق غائب عن استعلام الفواتير');
  assert.equal(JSON.stringify(w.AND).includes('adminScopes'), true);
  assert.equal(w.tenantId, TENANT, 'العزل باقٍ مع القيد');
});

test('نطاق مستخدم الشركة المقيَّد يُلفّ في علاقة الفاتورة لمسار التأخّر', async () => {
  reset(); live();
  currentUser = { id: 'mgr-1', role: 'MANAGER', tenantId: TENANT };
  scripted['admin.findUnique'] = () => ({ scopeEnabled: true });
  await call('GET', '/api/invoices/einvoice/documents?state=overdue');
  const w = whereOf('zatcaDocument.findMany');
  assert.ok(w.invoice, 'قيد النطاق غائب عن استعلام المستندات');
  assert.equal(JSON.stringify(w.invoice).includes('adminScopes'), true);
});

// ═══ ٤) تشخيص مستند ═══

test('تشخيص المستند: منقّى بلا سرّ وبلا جسم ردّ خام، والأثر بلا response', async () => {
  reset(); live();
  scripted['zatcaDocument.findFirst'] = () => ({
    ...docRow({
      status: 'REJECTED',
      validation: {
        at: '2026-09-20T12:00:00.000Z', outcome: 'REJECTED', validationStatus: 'ERROR',
        errors: [{ type: 'ERROR', code: 'BR-KSA-01', category: 'قواعد', message: 'فشل Basic YWxhZGRpbjpvcGVu', secret: 'do-not-leak' }],
        warnings: [],
      },
    }),
    invoice: { number: 'INV-001', einvoiceStatus: 'rejected', einvoiceWarnings: null },
  });
  scripted['zatcaApiLog.findMany'] = () => ([{
    createdAt: new Date('2026-09-20T12:00:00.000Z'), endpoint: 'clearance', httpStatus: 400, outcome: 'REJECTED',
    durationMs: 180, errorText: 'bad request',
  }]);

  const r = await call('GET', '/api/invoices/inv-1/einvoice/messages');
  assert.equal(r.status, 200);
  const d = data(r);
  const diag = d.diagnostics as Record<string, unknown>;
  const errs = diag.errors as Array<Record<string, unknown>>;
  assert.equal(errs[0].code, 'BR-KSA-01');
  assert.match(errs[0].text as string, /Basic \[REDACTED\]/);
  assert.equal(r.text.includes('do-not-leak'), false, 'حقلٌ خارج القائمة البيضاء خرج');
  assert.equal(r.text.includes('YWxhZGRpbjpvcGVu'), false);
  const logs = d.logs as Array<Record<string, unknown>>;
  assert.equal(logs.length, 1);
  assert.equal('response' in logs[0], false, 'جسم الردّ المخزَّن خرج');
  assert.equal(whereOf('zatcaApiLog.findMany').tenantId, TENANT);
  assert.equal(whereOf('zatcaDocument.findFirst').tenantId, TENANT);
  const sel = (argsOf('zatcaDocument.findFirst')?.select ?? {}) as Record<string, unknown>;
  assert.equal('xmlGz' in sel, false);
});

test('تشخيص مستندٍ غير موجود (أو لشركة أخرى): 404 بلا قراءة أثر', async () => {
  reset(); live();
  scripted['zatcaDocument.findFirst'] = () => null;
  const r = await call('GET', '/api/invoices/inv-9/einvoice/messages');
  assert.equal(r.status, 404);
  assert.equal(keys().includes('zatcaApiLog.findMany'), false);
});

// ═══ ٥) تنزيل الـXML ═══

const SIGNED_XML = '<Invoice><ID>INV-001</ID></Invoice>';

test('تنزيل الموقَّعة: النصّ كما خُزّن، وترويسات معقَّمة، وبلا قراءة النسخة الأخرى', async () => {
  reset(); live();
  scripted['zatcaDocument.findFirst'] = () => ({ id: 'doc-1', attemptNo: 2, status: 'RETRY_WAIT', invoice: { number: 'INV/001' } });
  scripted['zatcaDocument.findUnique'] = () => ({ xmlGz: zlib.gzipSync(Buffer.from(SIGNED_XML, 'utf8')) });

  const r = await call('GET', '/api/invoices/inv-1/einvoice/xml');
  assert.equal(r.status, 200);
  assert.equal(r.text, SIGNED_XML);
  assert.match(r.headers.get('content-type') ?? '', /application\/xml; charset=utf-8/);
  const cd = r.headers.get('content-disposition') ?? '';
  assert.match(cd, /attachment; filename="INV-001-a2-signed\.xml"/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const sel = (argsOf('zatcaDocument.findUnique')?.select ?? {}) as Record<string, unknown>;
  assert.deepEqual(Object.keys(sel), ['xmlGz'], 'قُرئت النسخة المعتمدة بلا داعٍ');
  assert.equal(whereOf('zatcaDocument.findFirst').tenantId, TENANT, 'العزل');
});

test('المعتمدة هي الافتراضية حين وُجدت، والصريح يُحترم', async () => {
  reset(); live();
  scripted['zatcaDocument.findFirst'] = () => ({ id: 'doc-1', attemptNo: 1, status: 'CLEARED', invoice: { number: 'INV-001' } });
  scripted['zatcaDocument.findUnique'] = () => ({ clearedXmlGz: zlib.gzipSync(Buffer.from('<Cleared/>', 'utf8')) });
  const r = await call('GET', '/api/invoices/inv-1/einvoice/xml');
  assert.equal(r.text, '<Cleared/>');
  assert.deepEqual(Object.keys((argsOf('zatcaDocument.findUnique')?.select ?? {}) as Record<string, unknown>), ['clearedXmlGz']);

  reset(); live();
  scripted['zatcaDocument.findFirst'] = () => ({ id: 'doc-1', attemptNo: 1, status: 'CLEARED', invoice: { number: 'INV-001' } });
  scripted['zatcaDocument.findUnique'] = () => ({ xmlGz: zlib.gzipSync(Buffer.from(SIGNED_XML, 'utf8')) });
  const r2 = await call('GET', '/api/invoices/inv-1/einvoice/xml?variant=signed');
  assert.equal(r2.text, SIGNED_XML);
});

test('نسخةٌ غير مخزَّنة ⇒ 404 لا ملفٌّ فارغ (CLEARED_NO_XML)', async () => {
  reset(); live();
  scripted['zatcaDocument.findFirst'] = () => ({ id: 'doc-1', attemptNo: 1, status: 'CLEARED_NO_XML', invoice: { number: 'INV-001' } });
  scripted['zatcaDocument.findUnique'] = () => ({ clearedXmlGz: null });
  const r = await call('GET', '/api/invoices/inv-1/einvoice/xml?variant=cleared');
  assert.equal(r.status, 404);
  assert.equal(r.body.success, false);
  assert.equal(r.headers.get('content-disposition'), null, 'ترويسة تنزيل لملفٍّ غير موجود');
});

test('بايتاتٌ تالفة ⇒ 500 مفهوم لا انهيار', async () => {
  reset(); live();
  scripted['zatcaDocument.findFirst'] = () => ({ id: 'doc-1', attemptNo: 1, status: 'SIGNED', invoice: { number: 'INV-001' } });
  scripted['zatcaDocument.findUnique'] = () => ({ xmlGz: Buffer.from('ليست gzip') });
  const r = await call('GET', '/api/invoices/inv-1/einvoice/xml');
  assert.equal(r.status, 500);
  assert.equal(r.body.success, false);
});

// ═══ ٦) الصلاحيات ═══

test('المندوب ممنوع من كل مسارات الشاشة (403) قبل أيّ استعلام', async () => {
  for (const url of ['/api/invoices/einvoice/summary', '/api/invoices/einvoice/documents', '/api/invoices/inv-1/einvoice/messages', '/api/invoices/inv-1/einvoice/xml']) {
    reset(); live();
    currentUser = { id: 'rep-1', role: 'SALES_REP', tenantId: TENANT };
    const r = await call('GET', url);
    assert.equal(r.status, 403, url);
    assert.deepEqual(keys(), [], `${url}: استُعلمت القاعدة لمن لا يُسمح له`);
  }
  reset();
  currentUser = { id: 'rep-1', role: 'SALES_REP', tenantId: TENANT };
  const p = await call('POST', '/api/invoices/einvoice/submit-pause', { paused: true });
  assert.equal(p.status, 403);
});

test('مفتاح الإيقاف لمدير الشركة وحده: MANAGER يقرأ ولا يبدّل', async () => {
  reset(); live();
  currentUser = { id: 'mgr-1', role: 'MANAGER', tenantId: TENANT };
  const read = await call('GET', '/api/invoices/einvoice/summary');
  assert.equal(read.status, 200, 'مستخدم الشركة يقرأ الشاشة');

  reset(); live();
  currentUser = { id: 'mgr-1', role: 'MANAGER', tenantId: TENANT };
  const r = await call('POST', '/api/invoices/einvoice/submit-pause', { paused: true });
  assert.equal(r.status, 403);
  assert.equal(pauseCalls.length, 0);
  assert.deepEqual(keys(), [], 'لم يُقرأ شيء قبل الرفض');
});

test('مفتاح الإيقاف: يبدّل ويكتب أثراً باسم الفاعل', async () => {
  reset(); live();
  const r = await call('POST', '/api/invoices/einvoice/submit-pause', { paused: true });
  assert.equal(r.status, 200);
  assert.equal(data(r).pausedAt, '2026-09-23T08:00:00.000Z');
  assert.deepEqual(pauseCalls, [{ tenantId: TENANT, paused: true }]);
  const log = (argsOf('zatcaApiLog.create')?.data ?? {}) as Record<string, unknown>;
  assert.equal(log.tenantId, TENANT);
  assert.equal(log.endpoint, 'ui:submit-pause');
  assert.equal(log.outcome, 'PAUSED');
  assert.equal(log.actorId, 'admin-1');

  reset(); live(new Date());
  const r2 = await call('POST', '/api/invoices/einvoice/submit-pause', { paused: false });
  assert.equal(r2.status, 200);
  assert.equal(data(r2).pausedAt, null);
  assert.deepEqual(pauseCalls, [{ tenantId: TENANT, paused: false }]);
  assert.equal(((argsOf('zatcaApiLog.create')?.data ?? {}) as Record<string, unknown>).outcome, 'RESUMED');
});

test('مفتاح الإيقاف: جسمٌ بلا paused منطقيّة ⇒ 400 بلا قراءة الإعدادات', async () => {
  for (const body of [{}, { paused: 'true' }, { paused: 1 }]) {
    reset(); live();
    const r = await call('POST', '/api/invoices/einvoice/submit-pause', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(pauseCalls.length, 0);
    assert.deepEqual(keys(), []);
  }
});

test('مفتاح الإيقاف: غياب صفّ الإعدادات ⇒ 404 لا 500', async () => {
  reset(); live();
  pauseImpl = async () => { throw new Error('COMPANY_SETTINGS_NOT_FOUND'); };
  const r = await call('POST', '/api/invoices/einvoice/submit-pause', { paused: true });
  assert.equal(r.status, 404);
  assert.equal(r.body.success, false);
  assert.equal(keys().includes('zatcaApiLog.create'), false, 'أثرٌ كُتب لتبديلٍ لم يقع');

  reset(); live();
  pauseImpl = async () => { throw new Error('boom'); };
  const other = await call('POST', '/api/invoices/einvoice/submit-pause', { paused: true });
  assert.equal(other.status, 500, 'عطلٌ غير متوقَّع لا يُقنَّع 404');
});
