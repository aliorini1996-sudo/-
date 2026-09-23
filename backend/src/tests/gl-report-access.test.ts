// M4 — حارس صلاحية نقطتي التقارير **سلوكياً** (DESIGN.md §9.1، §9.2، §7.1).
//
// الحرّاس النصيّة في `gl-report-routes.test.ts` تثبت أنّ `VIEW` مكتوبٌ على النقطتين، ولا تثبت أنّه
// **يرفض**. هنا يُستدعى معالج المسار نفسه (سلسلة `router.stack` الحقيقية: `requireLedgerPermission`
// الإنتاجي ثم `ledgerHandler`) بـ`req`/`res` مقلَّدين فوق Prisma مزيّف في الذاكرة — بلا قاعدة بيانات
// وبلا شبكة وبلا خادم HTTP:
//   ١) مستخدم بلا أيٍّ من صلاحيات الدفاتر ⇒ 403 `LEDGER_PERMISSION_DENIED` على القراءة **وعلى التصدير**،
//      ولا يبلغ الطلب المعالج أصلاً (لا قراءة إعدادات ولا حسابات).
//   ٢) مدير مقيّد النطاق ⇒ 403 `LEDGER_SCOPED_ADMIN` (الدفاتر على مستوى الشركة كلها، §9.1).
//   ٣) حسابٌ معطَّل أو من شركة أخرى ⇒ 403 ولو كانت الصلاحية ممنوحة.
//   ٤) مع الصلاحية ⇒ 200 وردٌّ بعقد §7.1 الموحّد.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Router } from 'express';

// ═══ Prisma مزيّف يُحقن قبل تحميل الموجّه ═══

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = {
    id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [],
  } as unknown as NodeJS.Module;
};

type Row = Record<string, unknown>;

/** كل نداء على العميل المزيّف يُسجَّل بـ«النموذج.العملية» — به نثبت أنّ المرفوض لا يلمس القاعدة. */
let calls: string[] = [];
let scripted: Record<string, (args: unknown) => unknown> = {};

function defaultFor(method: string): unknown {
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (method === 'aggregate') return { _count: { _all: 0 }, _sum: { debitMilli: null, creditMilli: null } };
  return null;
}

function modelProxy(model: string): unknown {
  return new Proxy({}, {
    get: (_t, method: string) => async (args: unknown) => {
      calls.push(`${model}.${method}`);
      const fn = scripted[`${model}.${method}`];
      return fn ? fn(args) : defaultFor(method);
    },
  });
}

const prismaFake: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (arg: unknown) => {
        calls.push('$transaction');
        return typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prismaFake) : arg;
      };
    }
    if (key === '$queryRaw' || key === '$queryRawUnsafe') {
      return async () => { calls.push('$queryRaw'); return []; };
    }
    if (key === '$executeRaw' || key === '$executeRawUnsafe') {
      return async () => { calls.push('$executeRaw'); return 0; };
    }
    if (key === 'then') return undefined; // لا يُعامَل كـPromise
    return modelProxy(key);
  },
});

stub('config/database', { default: prismaFake });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const reportsRouter = require('../routes/ledger/reports').default as Router;

// ═══ سلسلة المسار الحقيقية + req/res مقلَّدان ═══

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown }[];
  };
}

/** معالجات نقطةٍ كما سجّلها الموجّه فعلاً (لا نسخة من الاختبار). */
function handlersFor(method: 'get' | 'post', routePath: string) {
  for (const layer of (reportsRouter as unknown as { stack: RouteLayer[] }).stack) {
    const r = layer.route;
    if (r && r.path === routePath && r.methods[method] === true) return r.stack.map((s) => s.handle);
  }
  throw new Error(`نقطة غير مسجَّلة في الموجّه: ${method.toUpperCase()} ${routePath}`);
}

interface MockRes {
  statusCode: number;
  body: Record<string, unknown> | null;
  locals: Record<string, unknown>;
  headers: Record<string, unknown>;
  sent: boolean;
  onSend: (() => void) | null;
  status: (code: number) => MockRes;
  json: (payload: unknown) => MockRes;
  setHeader: (k: string, v: unknown) => void;
  getHeader: (k: string) => unknown;
  removeHeader: (k: string) => void;
  on: () => MockRes;
  once: () => MockRes;
}

function mockRes(tenantId: string, actorId: string): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    sent: false,
    onSend: null,
    locals: { ledger: { tenantId, actorId, impersonated: false } },
    status(code) { this.statusCode = code; return this; },
    json(payload) {
      this.body = payload as Record<string, unknown>;
      this.sent = true;
      this.onSend?.();
      return this;
    },
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    removeHeader(k) { delete this.headers[k]; },
    on() { return this; },
    once() { return this; },
  };
  return res;
}

type MockReq = Record<string, unknown>;

function mockReq(over: MockReq = {}): MockReq {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    ip: '127.0.0.1',
    app: { get: () => undefined },
    ...over,
  };
}

/** يمرّر الطلب على السلسلة حتى يردّ معالجٌ أو تنتهي — كما يفعل express. */
async function runChain(
  handlers: ReturnType<typeof handlersFor>,
  req: MockReq,
  res: MockRes,
): Promise<{ status: number; body: Record<string, unknown> | null; reached: number }> {
  let reached = 0;
  for (const handle of handlers) {
    reached += 1;
    const outcome = await new Promise<'next' | 'sent'>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('المعالج لم يردّ ولم يمرّر')), 5_000);
      res.onSend = () => { clearTimeout(timer); resolve('sent'); };
      const next = (err?: unknown) => {
        clearTimeout(timer);
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve('next');
      };
      Promise.resolve()
        .then(() => handle(req, res, next))
        .catch((err) => { clearTimeout(timer); reject(err); });
    });
    if (outcome === 'sent') break;
  }
  return { status: res.statusCode, body: res.body, reached };
}

const T1 = 'tenant-reports-1';
const ACTOR = 'admin-reports-1';

function adminRow(over: Row = {}): Row {
  return {
    isActive: true,
    tenantId: T1,
    role: 'MANAGER',
    canManageCompanyUsers: false,
    scopeEnabled: false,
    canViewLedger: false,
    canPostJournals: false,
    canManagePayables: false,
    canManageBank: false,
    canCloseLedgerPeriods: false,
    canConfigureLedger: false,
    ...over,
  };
}

function setAdmin(row: Row | null): void {
  calls = [];
  scripted = {
    'admin.findUnique': () => row,
    // سلسلة التدقيق (‏`appendAudit`) تُدرج صفّاً وتعيد معرّفه
    'glAuditLog.create': () => ({ id: 'audit-1' }),
  };
}

const USER = { id: ACTOR, role: 'MANAGER', tenantId: T1, name: 'مستخدم', impersonated: false };

const readReq = (over: MockReq = {}) => mockReq({
  params: { key: 'trial-balance' }, query: {}, user: { ...USER }, ...over,
});
const exportReq = (over: MockReq = {}) => mockReq({
  params: { key: 'trial-balance' }, body: { format: 'xlsx' }, user: { ...USER }, ...over,
});

// ═══ ١) الرفض الفعلي ═══

test('قراءة التقرير بلا canViewLedger: 403 فعليّ ولا يلمس الطلب بيانات الدفاتر', async () => {
  setAdmin(adminRow());
  const out = await runChain(handlersFor('get', '/reports/:key'), readReq(), mockRes(T1, ACTOR));
  assert.equal(out.status, 403);
  assert.equal(out.body?.code, 'LEDGER_PERMISSION_DENIED');
  assert.equal(out.body?.success, false);
  assert.equal(out.reached, 1, 'الحارس يجب أن يوقف الطلب قبل المعالج');
  // لا شيء من الدفاتر يُقرأ: صفّ الحساب وحده
  assert.deepEqual(calls, ['admin.findUnique']);
});

test('تصدير التقرير بلا canViewLedger: 403 فعليّ قبل محدد المعدل وقبل صفّ التدقيق', async () => {
  setAdmin(adminRow());
  const out = await runChain(handlersFor('post', '/reports/:key/export'), exportReq(), mockRes(T1, ACTOR));
  assert.equal(out.status, 403);
  assert.equal(out.body?.code, 'LEDGER_PERMISSION_DENIED');
  assert.equal(out.reached, 1, 'الرفض قبل محدد التصدير وقبل المعالج');
  assert.deepEqual(calls, ['admin.findUnique']);
  assert.equal(calls.includes('$transaction'), false, 'تصديرٌ مرفوض لا يكتب صفّ تدقيق');
});

test('لا مستخدم أو دور غير دور شركة: 403 بلا قراءة صفّ الحساب', async () => {
  for (const req of [readReq({ user: undefined }), readReq({ user: { ...USER, role: 'SUPER_ADMIN' } }),
    readReq({ user: { ...USER, tenantId: undefined } })]) {
    setAdmin(adminRow({ canViewLedger: true }));
    const out = await runChain(handlersFor('get', '/reports/:key'), req, mockRes(T1, ACTOR));
    assert.equal(out.status, 403);
    assert.equal(out.body?.code, 'LEDGER_PERMISSION_DENIED');
    assert.deepEqual(calls, [], 'لا يُقرأ صفّ حساب بلا جلسة شركة');
  }
});

test('مدير مقيّد النطاق: 403 LEDGER_SCOPED_ADMIN لا 200 (§9.1)', async () => {
  setAdmin(adminRow({ role: 'ADMIN', canManageCompanyUsers: true, scopeEnabled: true }));
  const out = await runChain(handlersFor('get', '/reports/:key'), readReq(), mockRes(T1, ACTOR));
  assert.equal(out.status, 403);
  assert.equal(out.body?.code, 'LEDGER_SCOPED_ADMIN');
});

test('حساب معطَّل أو من شركة أخرى: 403 ولو كانت الصلاحية ممنوحة', async () => {
  for (const row of [adminRow({ canViewLedger: true, isActive: false }), adminRow({ canViewLedger: true, tenantId: 'tenant-other' }), null]) {
    setAdmin(row);
    const out = await runChain(handlersFor('get', '/reports/:key'), readReq(), mockRes(T1, ACTOR));
    assert.equal(out.status, 403);
    assert.equal(out.body?.code, 'LEDGER_PERMISSION_DENIED');
  }
});

// ═══ ٢) القبول ═══

test('مع canViewLedger: 200 وردٌّ بعقد §7.1 الموحّد', async () => {
  setAdmin(adminRow({ canViewLedger: true }));
  const out = await runChain(handlersFor('get', '/reports/:key'), readReq(), mockRes(T1, ACTOR));
  assert.equal(out.status, 200);
  assert.equal(out.body?.success, true);
  const data = out.body?.data as Record<string, unknown>;
  assert.equal(data.reportKey, 'trial-balance');
  for (const field of ['period', 'options', 'settings', 'rows', 'totals', 'warnings', 'lineCount']) {
    assert.ok(field in data, `مفتاح العقد ${field} مفقود من الردّ`);
  }
  assert.ok(Array.isArray(data.rows));
  assert.ok(calls.length > 1, 'المعالج يجب أن يكون قد عمل فعلاً');
});

test('مفتاح أعلى من العرض يكفي، والقراءة تصل المعالج (§9.2)', async () => {
  setAdmin(adminRow({ canConfigureLedger: true }));
  const out = await runChain(handlersFor('get', '/reports/:key'), readReq(), mockRes(T1, ACTOR));
  assert.equal(out.status, 200);
  assert.equal(out.reached, 2, 'الحارس مرّر الطلب إلى المعالج');
});

test('التصدير مع الصلاحية: يتجاوز الحارس ويصل المعالج فيكتب صفّ تدقيق واحداً', async () => {
  setAdmin(adminRow({ canViewLedger: true }));
  const out = await runChain(handlersFor('post', '/reports/:key/export'), exportReq(), mockRes(T1, ACTOR));
  assert.equal(out.status, 200);
  assert.equal(out.body?.success, true);
  const data = out.body?.data as Record<string, unknown>;
  assert.equal(data.format, 'xlsx');
  assert.equal(data.paginated, false);
  assert.equal(calls.filter((c) => c === '$transaction').length, 1, 'صفّ تدقيق واحد للتصدير المقبول');
});

// ═══ ٣) مفتاح التقرير في الردّ واحد ═══

test('مرادف المدخل profit-and-loss يُقبل ويُعاد تحت income-statement وحده', async () => {
  setAdmin(adminRow({ canViewLedger: true }));
  const out = await runChain(
    handlersFor('get', '/reports/:key'),
    readReq({ params: { key: 'profit-and-loss' } }),
    mockRes(T1, ACTOR),
  );
  assert.equal(out.status, 200);
  const data = out.body?.data as Record<string, unknown>;
  assert.equal(data.reportKey, 'income-statement');
  assert.equal('statementKey' in data, false, 'لا مفتاح تقرير ثانٍ في الردّ');
  assert.equal(JSON.stringify(data).includes('profit-and-loss'), false, 'الاسم الداخلي لا يظهر في الردّ');
});

test('مفتاح مجهول 404، وتقرير مرحلة تالية 404 مفهوم', async () => {
  setAdmin(adminRow({ canViewLedger: true }));
  const unknown = await runChain(
    handlersFor('get', '/reports/:key'), readReq({ params: { key: 'nope' } }), mockRes(T1, ACTOR),
  );
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body?.reason, 'UNKNOWN_REPORT');
  setAdmin(adminRow({ canViewLedger: true }));
  const later = await runChain(
    handlersFor('get', '/reports/:key'), readReq({ params: { key: 'vat-return' } }), mockRes(T1, ACTOR),
  );
  assert.equal(later.status, 404);
  assert.equal(later.body?.reason, 'REPORT_NOT_AVAILABLE');
});

// ═══ ٤) دفتر الأستاذ: الصفحة التالية بمؤشّر لا برقم صفحة ═══

test('دفتر الأستاذ: صفحة ثانية بلا مؤشّر ⇒ 400 برسالة عربية تشرح البديل', async () => {
  setAdmin(adminRow({ canViewLedger: true }));
  const out = await runChain(
    handlersFor('get', '/reports/:key'),
    readReq({ params: { key: 'general-ledger' }, query: { page: '2' } }),
    mockRes(T1, ACTOR),
  );
  assert.equal(out.status, 400);
  assert.equal(out.body?.reason, 'CURSOR_REQUIRED');
  assert.match(String(out.body?.message), /مؤشّر/);
});

test('دفتر الأستاذ: مؤشّر مشوَّه ⇒ 400 عربي لا 500', async () => {
  setAdmin(adminRow({ canViewLedger: true }));
  const out = await runChain(
    handlersFor('get', '/reports/:key'),
    readReq({ params: { key: 'general-ledger' }, query: { cursor: 'ZZZZ-not-a-cursor' } }),
    mockRes(T1, ACTOR),
  );
  assert.equal(out.status, 400);
  assert.equal(out.body?.reason, 'INVALID_CURSOR');
  assert.match(String(out.body?.message), /أعد فتح دفتر الأستاذ/);
});
