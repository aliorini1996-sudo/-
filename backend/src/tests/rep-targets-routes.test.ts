// «هدف الشهر» (طلب المالك ٩ نوفمبر ٢٠٢٦) — الموجّه الحقيقي /api/rep-targets فوق Prisma مزيّف (بلا قاعدة بيانات)، وحرّاس
// middleware/auth الحقيقيون عدا authenticate (والمحاسبة حقيقية تقرأ علم الشركة). يثبت:
//   • المندوب يقرأ أهدافه وحدها (GET /mine)، ومسارات الإدارة له 403؛ والمدير على /mine 403؛ وبلا المحاسبة 403.
//   • المقيَّد النطاق: مندوبٌ خارج نطاقه 404 REP_NOT_FOUND في القراءة والإنشاء والتعديل والحذف، وبلا صلاحية المناديب 403.
//   • التحقّق: الشهر، والأرقام الصريحة وحدودها بحسب النوع، والصنف ووحدته (TARGET_PRODUCT_INVALID / TARGET_UNIT_INVALID).
//   • الإنشاء بلقطة الصنف والوحدة والمنشئ تحت قفلٍ استشاري للمندوب، وسقف ٢٠ هدفاً في الشهر (409 TARGET_LIMIT).
//   • التعديل والحذف داخل الشركة وحدها (404 TARGET_NOT_FOUND لهدف شركةٍ أخرى بلا كتابة)، والمنشئ يبقى.
//   • الردّ محسوبٌ بحدود الشهر بتوقيت الشركة: صافي المبيعات، والكمية باستعلامٍ واحد، والتحصيل من الديون السابقة.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
// لا استيراد ساكن لما يحمّل config/database (services/repTargets ← invoiceExpiry): الاستيراد يُرفع قبل البدائل فيحمّل العميل الحقيقي

// ═══ حقن البدائل قبل تحميل الموجّه (نمط price-lists-reps.test.ts) ═══

process.env.JWT_SECRET = process.env.JWT_SECRET || 'rep-targets-test-secret';
const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = { sql: string; values: unknown[]; inTx: boolean };
let calls: string[] = [];
let raws: Raw[] = [];
let inTx = false;
/** صفوف الأصناف المقفلة FOR KEY SHARE (lockBases) — أساسٌ غير المقروء قبل المعاملة = تحويلٌ التزم بينهما */
let lockedRows: Array<{ id: string; unit: string }> = [];
/** خطأٌ يرميه قفل الأصناف (55P03: انتهت مهلة الانتظار — تحويلٌ طويل يمسك الصفّ) */
let lockThrows: unknown = null;
let scripted: Record<string, (args: any) => unknown> = {};
const seen: Record<string, any[]> = {};

function defaultFor(method: string): unknown {
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
  return null;
}
const prismaFake: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (arg: unknown) => {
        calls.push(typeof arg === 'function' ? '$transaction(fn)' : '$transaction([])');
        if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
        inTx = true;
        try { return await (arg as (tx: unknown) => Promise<unknown>)(prismaFake); } finally { inTx = false; }
      };
    }
    if (key === '$queryRaw' || key === '$executeRaw') {
      return async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push(key);
        const sql = strings.join('?');
        raws.push({ sql, values, inTx });
        if (key === '$queryRaw' && sql.includes('FOR KEY SHARE') && lockThrows) throw lockThrows;
        if (key === '$queryRaw') return sql.includes('FOR KEY SHARE') ? lockedRows : [];
        return 0;
      };
    }
    if (key === 'then') return undefined;
    return new Proxy({}, {
      get: (_m, method: string) => async (args: unknown) => {
        const op = `${key}.${method}`;
        calls.push(`${op}${inTx ? '@tx' : ''}`);
        (seen[op] ??= []).push(args);
        const fn = scripted[op];
        return fn ? fn(args) : defaultFor(method);
      },
    });
  },
});

const TENANT = 'T1';
type User = { id: string; role: string; tenantId: string; name?: string; impersonated?: boolean };
const ADMIN: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, name: 'مدير' };
const SCOPED: User = { id: 'admin-scoped', role: 'MANAGER', tenantId: TENANT, name: 'مشرف' };
const NO_PERM: User = { id: 'admin-noperm', role: 'MANAGER', tenantId: TENANT, name: 'بلا صلاحية' };
const REP_USER: User = { id: 'r1', role: 'SALES_REP', tenantId: TENANT, name: 'خالد' };
let currentUser: User = ADMIN;

stub('config/database', { default: prismaFake });
/* eslint-disable @typescript-eslint/no-var-requires */
const realAuth = require('../middleware/auth') as Record<string, unknown>;
// الحرّاس الحقيقيون (requireAdmin يردّ المندوب، وrequireAdminPermission يقرأ صفّ المستخدم، وrequireAccounting علم الشركة) — عدا authenticate
stub('middleware/auth', {
  ...realAuth,
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
});
const repTargetsRouter = (require('../routes/repTargets') as typeof import('../routes/repTargets')).default;
const { currentMonthOf } = require('../services/repTargets') as typeof import('../services/repTargets');
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */

let server: { port: number; close: () => Promise<void> } | null = null;
async function startServer() {
  if (server) return server;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/rep-targets', repTargetsRouter);
  app.use(errorHandler);
  const s = http.createServer(app);
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()); }) };
  return server;
}
after(async () => { await server?.close(); server = null; });

type Reply = { status: number; body: Record<string, any> };
async function call(method: 'POST' | 'GET' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<Reply> {
  const s = await startServer();
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: s.port, method, path: url, agent: false,
      headers: { connection: 'close', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : {} }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ═══ عالم الشركة في الذاكرة ═══

const REPS = [{ id: 'r1', tenantId: TENANT }, { id: 'r2', tenantId: TENANT }, { id: 'rX', tenantId: 'T2' }];
/** نطاق المستخدمين المقيَّدين: قوائم المناديب (LISTS) */
const SCOPES: Record<string, string[]> = { 'admin-scoped': ['r2'] };
const PRODUCTS = [
  {
    id: 'p1', tenantId: TENANT, name: 'ماء', unit: 'حبة', deletedAt: null as Date | null,
    units: [{ id: 'u-ct', tenantId: TENANT, name: 'كرتون', factor: 24, isActive: true }, { id: 'u-old', tenantId: TENANT, name: 'شدّة', factor: 6, isActive: false }],
  },
  { id: 'p2', tenantId: TENANT, name: 'عصير', unit: 'علبة', deletedAt: null as Date | null, units: [{ id: 'u-p2', tenantId: TENANT, name: 'صندوق', factor: 12, isActive: true }] },
  // حُوِّلت وحدته الصغرى: كان الكرتون أساساً فصار الحبّة، والكرتون وحدةً بمعامل ٢٤
  {
    id: 'p-conv', tenantId: TENANT, name: 'حليب', unit: 'حبة', deletedAt: null as Date | null, baseConvertedAt: new Date('2026-11-05T09:00:00Z'),
    units: [{ id: 'u-conv-ct', tenantId: TENANT, name: 'كرتون', factor: 24, isActive: true }],
  },
  { id: 'p-arch', tenantId: TENANT, name: 'مؤرشف', unit: 'حبة', deletedAt: new Date('2026-01-01T00:00:00Z'), units: [] },
  { id: 'p-other', tenantId: 'T2', name: 'صنف شركة أخرى', unit: 'حبة', deletedAt: null as Date | null, units: [] },
];
type Row = Record<string, any>;
let targets: Row[] = [];
let accountingEnabled = true;
let money = { sales: 0, returns: 0 };
let items: Row[] = [];
let creditRows: Row[] = [];
let seq = 0;

const T0 = Date.parse('2026-11-02T08:00:00Z');
function targetRow(o: Row): Row {
  seq += 1;
  return {
    id: `t-${seq}`, tenantId: TENANT, salesRepId: 'r1', month: '2026-11', kind: 'SALES_AMOUNT', targetValue: 10000,
    productId: null, productName: null, unitId: null, unitName: null, unitFactor: 1,
    rewardKind: 'FIXED_AMOUNT', rewardValue: 500, note: null, createdById: 'admin-1', createdByName: 'مدير',
    createdAt: new Date(T0 + seq * 1000), updatedAt: new Date(T0 + seq * 1000), ...o,
  };
}
const match = (r: Row, where: Row): boolean => Object.entries(where).every(([k, v]) => r[k] === v);

function reset(user: User = ADMIN): void {
  calls = []; raws = []; inTx = false; currentUser = user; seq = 0; lockedRows = []; lockThrows = null;
  for (const k of Object.keys(seen)) delete seen[k];
  targets = []; accountingEnabled = true; money = { sales: 0, returns: 0 }; items = []; creditRows = [];
  scripted = {
    'tenant.findUnique': () => ({ accountingEnabled }),
    // صفّ مستخدم الشركة لحارس الصلاحية ولوضع النطاق
    'admin.findUnique': (args) => {
      const id = args?.where?.id;
      if (id === SCOPED.id) return { id, isActive: true, scopeEnabled: true, scopeMode: 'LISTS', canManageSalesReps: true };
      if (id === NO_PERM.id) return { id, isActive: true, scopeEnabled: false, scopeMode: null, canManageSalesReps: false };
      return { id, isActive: true, scopeEnabled: false, scopeMode: null, canManageSalesReps: true };
    },
    'salesRep.findFirst': (args) => {
      const w = args?.where ?? {};
      const rep = REPS.find((r) => r.id === w.id && r.tenantId === w.tenantId);
      if (!rep) return null;
      const scopeAdmin = w.adminScopes?.some?.adminId;
      if (scopeAdmin && !(SCOPES[scopeAdmin] ?? []).includes(rep.id)) return null;
      return { id: rep.id };
    },
    'product.findFirst': (args) => {
      const w = args?.where ?? {};
      const p = PRODUCTS.find((x) => x.id === w.id && x.tenantId === w.tenantId && (w.deletedAt === null ? x.deletedAt === null : true));
      if (!p) return null;
      const uw = args?.select?.units?.where ?? {};
      return {
        id: p.id, name: p.name, unit: p.unit, baseConvertedAt: (p as { baseConvertedAt?: Date }).baseConvertedAt ?? null,
        units: p.units.filter((u) => match(u, uw)).map(({ id, name, factor }) => ({ id, name, factor })),
      };
    },
    'repTarget.findMany': (args) => targets.filter((t) => match(t, args.where))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || String(a.id).localeCompare(String(b.id))),
    'repTarget.count': (args) => targets.filter((t) => match(t, args.where)).length,
    'repTarget.findFirst': (args) => targets.find((t) => match(t, args.where)) ?? null,
    'repTarget.create': (args) => { const row = targetRow({ ...args.data }); targets.push(row); return row; },
    'repTarget.updateMany': (args) => {
      const hit = targets.filter((t) => match(t, args.where));
      for (const t of hit) Object.assign(t, args.data, { updatedAt: new Date(T0 + 99_000) });
      return { count: hit.length };
    },
    'repTarget.deleteMany': (args) => {
      const before = targets.length;
      targets = targets.filter((t) => !match(t, args.where));
      return { count: before - targets.length };
    },
    'invoice.aggregate': (args) => ({ _sum: { total: args.where.type === 'RETURN' ? money.returns : money.sales } }),
    'invoiceItem.findMany': (args) => items.filter((i) => (args.where.productId.in as string[]).includes(i.productId)),
    'invoice.findMany': () => creditRows,
  };
}
const writes = () => calls.filter((c) => /^repTarget\.(create|update|updateMany|delete|deleteMany)/.test(c));
const BODY = { month: '2026-11', kind: 'SALES_AMOUNT', targetValue: 10000, rewardKind: 'COMMISSION_SALES_PCT', rewardValue: 2 };

// ═══ (١) الأدوار ═══

test('المندوب يقرأ أهدافه وحدها بشهر الشركة الجاري افتراضاً، والمدير على /mine 403، والمندوب على مسارات الإدارة 403، وبلا المحاسبة 403', async () => {
  reset(REP_USER);
  targets.push(targetRow({ salesRepId: 'r1' }), targetRow({ salesRepId: 'r2' }), targetRow({ salesRepId: 'r1', month: '2026-10' }));
  money = { sales: 9000, returns: 1000 };
  const r = await call('GET', '/api/rep-targets/mine?month=2026-11');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.targets.map((t: Row) => t.id), ['t-1'], 'أهدافه في الشهر وحدها');
  assert.deepEqual(seen['repTarget.findMany'][0].where, { tenantId: TENANT, salesRepId: 'r1', month: '2026-11' });
  assert.equal(r.body.data.month, '2026-11');
  assert.equal(r.body.data.from, '2026-10-31T21:00:00.000Z', 'بتوقيت الشركة (الرياض افتراضاً)');
  assert.equal(r.body.data.to, '2026-11-30T21:00:00.000Z');
  assert.equal(r.body.data.monthNetSales, 8000);
  // بلا شهر: الجاري بتوقيت الشركة
  const cur = await call('GET', '/api/rep-targets/mine');
  assert.equal(cur.status, 200);
  assert.equal(cur.body.data.month, currentMonthOf(new Date(), 'Asia/Riyadh'));
  assert.equal(cur.body.data.isCurrent, true);
  assert.ok(cur.body.data.daysLeft >= 1 && cur.body.data.daysLeft <= 31);
  assert.equal((await call('GET', '/api/rep-targets/mine?month=2026-13')).status, 400);
  // مسارات الإدارة: requireAdmin يردّ المندوب ولو كان الهدف هدفه
  for (const [m, url] of [['GET', '/api/rep-targets/rep/r1'], ['POST', '/api/rep-targets/rep/r1'], ['PUT', '/api/rep-targets/t-1'], ['DELETE', '/api/rep-targets/t-1']] as const) {
    const x = await call(m, url, m === 'POST' || m === 'PUT' ? BODY : undefined);
    assert.equal(x.status, 403, `${m} ${url}`);
  }
  assert.deepEqual(writes(), []);
  assert.equal(targets.length, 3);
  // المدير على مسار المندوب
  reset(ADMIN);
  const a = await call('GET', '/api/rep-targets/mine');
  assert.equal(a.status, 403);
  assert.equal(a.body.message, 'هذا المسار للمندوب');
  // النظام المحاسبي مطفأ: لا أرقام للمندوب ولا للإدارة
  reset(REP_USER);
  accountingEnabled = false;
  const off = await call('GET', '/api/rep-targets/mine');
  assert.equal(off.status, 403);
  assert.equal(off.body.code, 'ACCOUNTING_NOT_ALLOWED');
  reset(ADMIN);
  accountingEnabled = false;
  assert.equal((await call('GET', '/api/rep-targets/rep/r1')).status, 403);
});

test('المقيَّد النطاق: مندوبٌ خارج نطاقه 404 REP_NOT_FOUND في القراءة والإنشاء والتعديل والحذف بلا كتابة، وبلا صلاحية المناديب 403', async () => {
  reset(SCOPED);
  targets.push(targetRow({ salesRepId: 'r1' }), targetRow({ salesRepId: 'r2' }));
  const g = await call('GET', '/api/rep-targets/rep/r1?month=2026-11');
  assert.equal(g.status, 404);
  assert.deepEqual(g.body, { success: false, code: 'REP_NOT_FOUND', message: 'المندوب غير موجود' });
  assert.equal((await call('POST', '/api/rep-targets/rep/r1', BODY)).body.code, 'REP_NOT_FOUND');
  const put = await call('PUT', '/api/rep-targets/t-1', BODY);
  assert.equal(put.status, 404);
  assert.equal(put.body.code, 'REP_NOT_FOUND');
  assert.equal((await call('DELETE', '/api/rep-targets/t-1')).status, 404);
  assert.deepEqual(writes(), [], 'لا كتابة خارج النطاق');
  assert.equal(targets.length, 2);
  assert.equal(targets[0].targetValue, 10000);
  // مندوب نطاقه يمرّ
  const ok = await call('GET', '/api/rep-targets/rep/r2?month=2026-11');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.data.targets.map((t: Row) => t.id), ['t-2']);
  // مندوب شركةٍ أخرى 404 ولو بلا نطاق
  reset(ADMIN);
  assert.equal((await call('GET', '/api/rep-targets/rep/rX')).body.code, 'REP_NOT_FOUND');
  // بلا صلاحية إدارة المناديب
  reset(NO_PERM);
  assert.equal((await call('GET', '/api/rep-targets/rep/r1')).status, 403);
  assert.equal((await call('POST', '/api/rep-targets/rep/r1', BODY)).status, 403);
  assert.deepEqual(writes(), []);
});

// ═══ (٢) التحقّق ═══

test('التحقّق: الشهر والأرقام الصريحة وحدودها بحسب النوع، والملاحظة — كلها 400 بلا إنشاء', async () => {
  reset(ADMIN);
  const bad: Array<[string, Row]> = [
    ['شهر ١٣', { ...BODY, month: '2026-13' }],
    ['شهر بلا صفر', { ...BODY, month: '2026-1' }],
    ['سنة خارج المدى', { ...BODY, month: '1999-11' }],
    ['نوعٌ مجهول', { ...BODY, kind: 'VISITS' }],
    ['مكافأةٌ مجهولة', { ...BODY, rewardKind: 'BONUS' }],
    ['قيمة نصّية', { ...BODY, targetValue: '10000' }],
    ['قيمة صفر', { ...BODY, targetValue: 0 }],
    ['قيمة سالبة', { ...BODY, targetValue: -5 }],
    ['مبلغ فوق ١٠^١٢', { ...BODY, targetValue: 1e12 + 1 }],
    ['كمية فوق ١٠^٩', { ...BODY, kind: 'PRODUCT_QTY', productId: 'p1', targetValue: 1e9 + 1 }],
    ['تحصيل فوق ١٠٠٪', { ...BODY, kind: 'COLLECTION_PCT', targetValue: 101 }],
    ['عمولة فوق ١٠٠٪', { ...BODY, rewardValue: 100.5 }],
    ['راتب فوق ١٠٠٠٪', { ...BODY, rewardKind: 'SALARY_PCT', rewardValue: 1001 }],
    ['مبلغ مكافأة فوق ١٠^٩', { ...BODY, rewardKind: 'FIXED_AMOUNT', rewardValue: 1e9 + 1 }],
    ['مكافأة صفر', { ...BODY, rewardValue: 0 }],
    ['ملاحظة فوق ٣٠٠', { ...BODY, note: 'م'.repeat(301) }],
    ['بلا شهر', { kind: 'SALES_AMOUNT', targetValue: 1, rewardKind: 'FIXED_AMOUNT', rewardValue: 1 }],
  ];
  for (const [why, body] of bad) {
    const r = await call('POST', '/api/rep-targets/rep/r1', body);
    assert.equal(r.status, 400, `${why}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.success, false, why);
  }
  assert.deepEqual(writes(), []);
  // الحدود نفسها مقبولة، والملاحظة تُقصّ والفارغة null
  for (const body of [
    { ...BODY, kind: 'COLLECTION_PCT', targetValue: 100, rewardKind: 'SALARY_PCT', rewardValue: 1000, note: '   ' },
    { ...BODY, targetValue: 1e12, rewardValue: 100, note: '  ركّز على الجملة  ' },
  ]) {
    const r = await call('POST', '/api/rep-targets/rep/r1', body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  assert.deepEqual(targets.map((t) => t.note), [null, 'ركّز على الجملة']);
});

test('صنف هدف الكمية: الغائب والمؤرشف وصنف شركةٍ أخرى 400 TARGET_PRODUCT_INVALID، ووحدة صنفٍ آخر أو موقوفة 400 TARGET_UNIT_INVALID', async () => {
  reset(ADMIN);
  const qty = { ...BODY, kind: 'PRODUCT_QTY', targetValue: 50 };
  for (const [why, body] of [
    ['بلا صنف', qty],
    ['صنف فارغ', { ...qty, productId: '' }],
    ['صنف شركة أخرى', { ...qty, productId: 'p-other' }],
    ['صنف مؤرشف', { ...qty, productId: 'p-arch' }],
    ['صنف مجهول', { ...qty, productId: 'nope' }],
  ] as const) {
    const r = await call('POST', '/api/rep-targets/rep/r1', body);
    assert.equal(r.status, 400, `${why}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body, { success: false, code: 'TARGET_PRODUCT_INVALID', message: 'اختر صنفاً صحيحاً' }, why);
  }
  assert.deepEqual(seen['product.findFirst'].map((a: Row) => a.where), [
    { id: 'p-other', tenantId: TENANT, deletedAt: null }, { id: 'p-arch', tenantId: TENANT, deletedAt: null }, { id: 'nope', tenantId: TENANT, deletedAt: null },
  ], 'بشرط الشركة وبلا المؤرشف — والغائب بلا استعلام');
  for (const [why, unitId] of [['وحدة صنفٍ آخر', 'u-p2'], ['وحدة موقوفة', 'u-old'], ['وحدة مجهولة', 'u-x']] as const) {
    const r = await call('POST', '/api/rep-targets/rep/r1', { ...qty, productId: 'p1', unitId });
    assert.equal(r.status, 400, `${why}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body, { success: false, code: 'TARGET_UNIT_INVALID', message: 'وحدة الصنف غير صحيحة' }, why);
  }
  assert.deepEqual(writes(), []);
  assert.equal(targets.length, 0);
});

// ═══ (٣) الإنشاء والسقف ═══

test('الإنشاء: لقطة الصنف ووحدته والمنشئ تحت قفل المندوب، والردّ محسوبٌ لشهره — وغير الكمية بلا صنف ولا وحدة', async () => {
  reset(ADMIN);
  items = [
    { productId: 'p1', qty: 2, unitName: 'كرتون', unitFactor: 24, baseQty: 48, invoice: { type: 'CREDIT' } },
    { productId: 'p1', qty: 12, unitName: 'حبة', unitFactor: 1, baseQty: 12, invoice: { type: 'CASH' } },
  ];
  const r = await call('POST', '/api/rep-targets/rep/r1', { ...BODY, kind: 'PRODUCT_QTY', productId: 'p1', unitId: 'u-ct', targetValue: 2, rewardKind: 'FIXED_AMOUNT', rewardValue: 300 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = targets[0];
  assert.deepEqual(
    { productId: row.productId, productName: row.productName, unitId: row.unitId, unitName: row.unitName, unitFactor: row.unitFactor, salesRepId: row.salesRepId, tenantId: row.tenantId },
    { productId: 'p1', productName: 'ماء', unitId: 'u-ct', unitName: 'كرتون', unitFactor: 24, salesRepId: 'r1', tenantId: TENANT },
  );
  assert.deepEqual([row.createdById, row.createdByName], ['admin-1', 'مدير']);
  // القفل الاستشاري للمندوب داخل المعاملة قبل العدّ والإنشاء
  const lock = raws.find((x) => x.sql.includes('pg_advisory_xact_lock'));
  assert.ok(lock && lock.inTx, 'القفل داخل المعاملة');
  assert.deepEqual(lock!.values, ['rep-targets:r1']);
  assert.ok(calls.indexOf('$executeRaw') < calls.indexOf('repTarget.count@tx') && calls.indexOf('repTarget.count@tx') < calls.indexOf('repTarget.create@tx'));
  // الردّ: ٦٠ حبّة = ٢٫٥ كرتون من هدف ٢، والمكافأة مستحقّة
  const d = r.body.data;
  assert.deepEqual(d.progress, { state: 'OK', achieved: 2.5, goal: 2, pct: 125, done: true });
  assert.deepEqual(d.reward, { kind: 'FIXED_AMOUNT', value: 300, amount: 300, earned: true });
  assert.equal('tenantId' in d || 'salesRepId' in d || 'createdById' in d, false, 'حقول العقد وحدها');
  assert.deepEqual(seen['invoiceItem.findMany'][0].where.productId, { in: ['p1'] });
  assert.equal(seen['invoiceItem.findMany'][0].where.invoice.salesRepId, 'r1');
  assert.equal(seen['invoiceItem.findMany'][0].where.invoice.status, 'CONFIRMED');
  // بوحدة الأساس: اسم وحدة الصنف ومعامل ١
  const base = await call('POST', '/api/rep-targets/rep/r1', { ...BODY, kind: 'PRODUCT_QTY', productId: 'p1', unitId: null, targetValue: 100 });
  assert.equal(base.status, 201, JSON.stringify(base.body));
  assert.deepEqual([targets[1].unitId, targets[1].unitName, targets[1].unitFactor], [null, 'حبة', 1]);
  assert.equal(base.body.data.progress.achieved, 60);
  // غير الكمية: الصنف والوحدة المرسلان يُهملان
  const sales = await call('POST', '/api/rep-targets/rep/r1', { ...BODY, productId: 'p1', unitId: 'u-ct' });
  assert.equal(sales.status, 201);
  assert.deepEqual([targets[2].productId, targets[2].productName, targets[2].unitId, targets[2].unitName, targets[2].unitFactor], [null, null, null, null, 1]);
  // جلسة المالك تُوسم «الدعم الفني»
  reset({ ...ADMIN, impersonated: true });
  assert.equal((await call('POST', '/api/rep-targets/rep/r1', BODY)).status, 201);
  assert.deepEqual([targets[0].createdById, targets[0].createdByName], ['OWNER:admin-1', 'الدعم الفني']);
});

test('أساس صنف هدف الكمية (baseGuard): كاشٌ قديم بأساسٍ حُوِّل 400 UNIT_INVALID، وتحويلٌ التزم بين اللقطة والقفل 409، والانتظار 503 — بلا كتابة', async () => {
  reset(ADMIN);
  const qty = { ...BODY, kind: 'PRODUCT_QTY', targetValue: 100 };
  // (أ) الويب رأى «كرتون» أساساً (unitId فارغ) والصنف حُوِّل إلى الحبّة: رفضٌ ظاهر لا هدف «١٠٠ حبّة» صامت
  const stale = await call('POST', '/api/rep-targets/rep/r1', { ...qty, productId: 'p-conv', unitId: null, baseUnitName: 'كرتون' });
  assert.equal(stale.status, 400, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'UNIT_INVALID');
  assert.match(stale.body.message, /حليب/);
  assert.equal(raws.some((x) => x.sql.includes('FOR KEY SHARE')), false, 'الرفض الحيّ قبل المعاملة');
  const mine = targetRow({ kind: 'PRODUCT_QTY', productId: 'p-conv', productName: 'حليب', unitId: 'u-conv-ct', unitName: 'كرتون', unitFactor: 24, targetValue: 3 });
  targets.push(mine);
  const stalePut = await call('PUT', `/api/rep-targets/${mine.id}`, { ...qty, productId: 'p-conv', unitId: null, baseUnitName: 'كرتون' });
  assert.equal(stalePut.status, 400);
  assert.equal(stalePut.body.code, 'UNIT_INVALID');
  assert.deepEqual(writes(), []);
  assert.deepEqual([mine.unitId, mine.unitFactor, mine.targetValue], ['u-conv-ct', 24, 3]);
  // الأساس الحالي يمرّ، والغائب مسار اليوم، وصنفٌ لم يُحوَّل قط لا يُرفض باسمٍ مختلف (تسميةٌ لا كمية — كطلب البضاعة)
  for (const body of [
    { ...qty, productId: 'p-conv', unitId: 'u-conv-ct', baseUnitName: 'حبة' },
    { ...qty, productId: 'p-conv', unitId: null },
    { ...qty, productId: 'p1', unitId: null, baseUnitName: 'قطعة' },
  ]) {
    const r = await call('POST', '/api/rep-targets/rep/r1', body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }

  // (ب) القفل: صفّ الصنف FOR KEY SHARE داخل المعاملة بعد قفل المندوب، بالشركة والصنف
  reset(ADMIN);
  assert.equal((await call('POST', '/api/rep-targets/rep/r1', { ...qty, productId: 'p1', unitId: 'u-ct', baseUnitName: 'حبة' })).status, 201);
  const lockAt = raws.findIndex((x) => x.sql.includes('FOR KEY SHARE'));
  assert.ok(lockAt > 0 && raws[lockAt].inTx, 'القفل داخل المعاملة');
  assert.deepEqual(raws[lockAt].values, [TENANT, ['p1']]);
  assert.ok(raws.findIndex((x) => x.sql.includes('pg_advisory_xact_lock')) < lockAt, 'بعد قفل المندوب');
  // غير الكمية لا يقفل صنفاً
  reset(ADMIN);
  assert.equal((await call('POST', '/api/rep-targets/rep/r1', BODY)).status, 201);
  assert.equal(raws.some((x) => x.sql.includes('FOR KEY SHARE')), false);

  // (ج) تحويلٌ التزم بين اللقطة والقفل: الأساس المقفل ≠ المقروء ⇒ 409 PRODUCT_UNITS_CHANGED بلا إنشاء ولا تعديل
  reset(ADMIN);
  lockedRows = [{ id: 'p1', unit: 'كرتون' }];
  const raced = await call('POST', '/api/rep-targets/rep/r1', { ...qty, productId: 'p1', unitId: null });
  assert.equal(raced.status, 409, JSON.stringify(raced.body));
  assert.equal(raced.body.code, 'PRODUCT_UNITS_CHANGED');
  assert.equal(calls.includes('repTarget.create@tx'), false);
  const old = targetRow({ kind: 'PRODUCT_QTY', productId: 'p1', productName: 'ماء', unitName: 'حبة', unitFactor: 1, targetValue: 5 });
  targets.push(old);
  const racedPut = await call('PUT', `/api/rep-targets/${old.id}`, { ...qty, productId: 'p1', unitId: null });
  assert.equal(racedPut.status, 409);
  assert.deepEqual(writes(), []);
  assert.deepEqual([old.targetValue, old.unitFactor, old.unitId], [5, 1, null]);
  // (د) انتظار قفل الصنف تجاوز المهلة (تحويلٌ طويل يمسكه) ⇒ 503 PRODUCT_UNITS_BUSY
  reset(ADMIN);
  lockThrows = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
  const busy = await call('POST', '/api/rep-targets/rep/r1', { ...qty, productId: 'p1', unitId: null });
  assert.equal(busy.status, 503, JSON.stringify(busy.body));
  assert.equal(busy.body.code, 'PRODUCT_UNITS_BUSY');
  assert.deepEqual(writes(), []);
});

test('السقف: ٢٠ هدفاً للمندوب في الشهر ⇒ 409 TARGET_LIMIT بلا إنشاء، وشهرٌ آخر ومندوبٌ آخر يمرّان، والنقل بالتعديل إلى شهرٍ ممتلئ 409', async () => {
  reset(ADMIN);
  for (let i = 0; i < 20; i++) targets.push(targetRow({ salesRepId: 'r1', month: '2026-11' }));
  const full = await call('POST', '/api/rep-targets/rep/r1', BODY);
  assert.equal(full.status, 409);
  assert.deepEqual(full.body, { success: false, code: 'TARGET_LIMIT', message: 'وصلت للحد الأعلى من الأهداف لهذا الشهر (20)' });
  assert.equal(targets.length, 20);
  assert.equal(calls.includes('repTarget.create@tx'), false);
  assert.deepEqual(seen['repTarget.count'][0].where, { tenantId: TENANT, salesRepId: 'r1', month: '2026-11' });
  assert.equal((await call('POST', '/api/rep-targets/rep/r1', { ...BODY, month: '2026-12' })).status, 201);
  assert.equal((await call('POST', '/api/rep-targets/rep/r2', BODY)).status, 201);
  // تعديل هدفٍ في ديسمبر لينتقل إلى نوفمبر الممتلئ
  const dec = targets.find((t) => t.month === '2026-12')!;
  const move = await call('PUT', `/api/rep-targets/${dec.id}`, BODY);
  assert.equal(move.status, 409);
  assert.equal(move.body.code, 'TARGET_LIMIT');
  assert.equal(dec.month, '2026-12', 'لم يُنقل');
  // وتعديل هدفٍ داخل الشهر الممتلئ نفسه لا يُعدّ عليه
  const nov = targets[0];
  const same = await call('PUT', `/api/rep-targets/${nov.id}`, { ...BODY, targetValue: 5000 });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(nov.targetValue, 5000);
});

// ═══ (٤) التعديل والحذف ═══

test('التعديل والحذف داخل الشركة وحدها: هدف شركةٍ أخرى 404 TARGET_NOT_FOUND بلا كتابة، والمنشئ يبقى، وتغيير النوع يفرّغ الصنف', async () => {
  reset(ADMIN);
  const foreign = targetRow({ tenantId: 'T2', salesRepId: 'rX' });
  const mine = targetRow({ kind: 'PRODUCT_QTY', productId: 'p1', productName: 'ماء', unitId: 'u-ct', unitName: 'كرتون', unitFactor: 24, targetValue: 3, createdById: 'admin-9', createdByName: 'الأول' });
  targets.push(foreign, mine);
  for (const [m, body] of [['PUT', BODY], ['DELETE', undefined]] as const) {
    const r = await call(m, `/api/rep-targets/${foreign.id}`, body);
    assert.equal(r.status, 404, m);
    assert.deepEqual(r.body, { success: false, code: 'TARGET_NOT_FOUND', message: 'الهدف غير موجود' }, m);
  }
  assert.deepEqual(seen['repTarget.findFirst'].map((a: Row) => a.where), [{ id: foreign.id, tenantId: TENANT }, { id: foreign.id, tenantId: TENANT }]);
  assert.deepEqual(writes(), []);
  assert.equal(foreign.targetValue, 10000);
  assert.equal((await call('PUT', '/api/rep-targets/t-none', BODY)).body.code, 'TARGET_NOT_FOUND');
  // التعديل: النوع يتغيّر إلى مبيعات ⇒ لا صنف ولا وحدة، والمنشئ كما كان، وبشرط الشركة
  money = { sales: 12000, returns: 2000 };
  const put = await call('PUT', `/api/rep-targets/${mine.id}`, { ...BODY, targetValue: 8000, note: 'الهدف الجديد' });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(seen['repTarget.updateMany'][0].where, { id: mine.id, tenantId: TENANT });
  assert.deepEqual(
    [mine.kind, mine.targetValue, mine.productId, mine.productName, mine.unitId, mine.unitName, mine.unitFactor, mine.note, mine.createdById, mine.createdByName],
    ['SALES_AMOUNT', 8000, null, null, null, null, 1, 'الهدف الجديد', 'admin-9', 'الأول'],
  );
  assert.ok(raws.some((x) => x.sql.includes('pg_advisory_xact_lock') && x.inTx && x.values[0] === 'rep-targets:r1'));
  assert.deepEqual(put.body.data.progress, { state: 'OK', achieved: 10000, goal: 8000, pct: 125, done: true });
  assert.deepEqual(put.body.data.reward, { kind: 'COMMISSION_SALES_PCT', value: 2, amount: 200, earned: true });
  // التعديل يتحقّق كالإنشاء
  assert.equal((await call('PUT', `/api/rep-targets/${mine.id}`, { ...BODY, kind: 'PRODUCT_QTY', productId: 'p1', unitId: 'u-p2' })).body.code, 'TARGET_UNIT_INVALID');
  assert.equal((await call('PUT', `/api/rep-targets/${mine.id}`, { ...BODY, month: 'x' })).status, 400);
  // الحذف
  const del = await call('DELETE', `/api/rep-targets/${mine.id}`);
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, { success: true });
  assert.deepEqual(seen['repTarget.deleteMany'].at(-1).where, { id: mine.id, tenantId: TENANT });
  assert.deepEqual(targets.map((t) => t.id), [foreign.id]);
  assert.equal((await call('DELETE', `/api/rep-targets/${mine.id}`)).body.code, 'TARGET_NOT_FOUND', 'حذفٌ ثانٍ');
});

// ═══ (٥) الحساب في الردّ ═══

test('الردّ: حدود الشهر بتوقيت الشركة في كل استعلام، والكمية باستعلامٍ واحد لكل الأصناف، والتحصيل مرةً واحدة من الديون السابقة، وNO_BASE وPRODUCT_DELETED', async () => {
  reset(ADMIN);
  targets.push(
    targetRow({ kind: 'SALES_AMOUNT', targetValue: 20000, rewardKind: 'COMMISSION_SALES_PCT', rewardValue: 1.5 }),
    targetRow({ kind: 'PRODUCT_QTY', productId: 'p1', productName: 'ماء', unitId: 'u-ct', unitName: 'كرتون', unitFactor: 24, targetValue: 10 }),
    targetRow({ kind: 'PRODUCT_QTY', productId: 'p2', productName: 'عصير', unitName: 'علبة', unitFactor: 1, targetValue: 30 }),
    targetRow({ kind: 'PRODUCT_QTY', productId: null, productName: 'صنف حُذف', unitName: 'حبة', unitFactor: 1, targetValue: 5 }),
    targetRow({ kind: 'COLLECTION_PCT', targetValue: 50, rewardKind: 'SALARY_PCT', rewardValue: 10 }),
    targetRow({ kind: 'COLLECTION_PCT', targetValue: 100 }),
  );
  money = { sales: 15000, returns: 3000 };
  items = [
    { productId: 'p1', qty: 5, unitName: 'كرتون', unitFactor: 24, baseQty: 120, invoice: { type: 'CREDIT' } },
    { productId: 'p1', qty: 1, unitName: 'كرتون', unitFactor: 24, baseQty: 24, invoice: { type: 'RETURN' } },
    { productId: 'p2', qty: 30, unitName: 'علبة', unitFactor: 1, baseQty: 30, invoice: { type: 'CASH' } },
  ];
  creditRows = [
    { total: 1000, receiptItems: [{ amount: 200, receipt: { receiptDate: new Date('2026-10-10T10:00:00Z'), status: 'ACTIVE' } }, { amount: 500, receipt: { receiptDate: new Date('2026-11-05T10:00:00Z'), status: 'ACTIVE' } }], adjustments: [] },
  ];
  const r = await call('GET', '/api/rep-targets/rep/r1?month=2026-11');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  assert.equal(d.monthNetSales, 12000);
  assert.deepEqual(d.targets.map((t: Row) => t.id), ['t-1', 't-2', 't-3', 't-4', 't-5', 't-6'], 'بترتيب الإنشاء');
  assert.deepEqual(seen['repTarget.findMany'][0].orderBy, [{ createdAt: 'asc' }, { id: 'asc' }]);
  const [sales, ct, juice, gone, half, full] = d.targets;
  assert.deepEqual(sales.progress, { state: 'OK', achieved: 12000, goal: 20000, pct: 60, done: false });
  assert.deepEqual(sales.reward, { kind: 'COMMISSION_SALES_PCT', value: 1.5, amount: 180, earned: false });
  assert.deepEqual(ct.progress, { state: 'OK', achieved: 4, goal: 10, pct: 40, done: false }, '(١٢٠ − ٢٤) ÷ ٢٤');
  assert.deepEqual(juice.progress, { state: 'OK', achieved: 30, goal: 30, pct: 100, done: true });
  assert.deepEqual(gone.progress, { state: 'PRODUCT_DELETED', achieved: 0, goal: 5, pct: null, done: false });
  // ٨٠٠ مفتوح أول الشهر، حُصّل ٥٠٠
  assert.deepEqual(half.progress, { state: 'OK', achieved: 500, goal: 400, pct: 125, done: true, base: 800, collectedPct: 62.5 });
  assert.deepEqual(half.reward, { kind: 'SALARY_PCT', value: 10, amount: null, earned: true });
  assert.deepEqual(full.progress, { state: 'OK', achieved: 500, goal: 800, pct: 62.5, done: false, base: 800, collectedPct: 62.5 });
  // الاستعلامات: كلها بحدود نوفمبر بالرياض، والمستندات المؤكَّدة للمندوب
  const from = '2026-10-31T21:00:00.000Z';
  const to = '2026-11-30T21:00:00.000Z';
  const aggs = seen['invoice.aggregate'].map((a: Row) => a.where);
  assert.equal(aggs.length, 2);
  for (const w of aggs) {
    assert.deepEqual([w.tenantId, w.salesRepId, w.status, w.invoiceDate.gte.toISOString(), w.invoiceDate.lt.toISOString()], [TENANT, 'r1', 'CONFIRMED', from, to]);
  }
  assert.deepEqual(aggs.map((w: Row) => w.type), [{ not: 'RETURN' }, 'RETURN']);
  assert.equal(seen['invoiceItem.findMany'].length, 1, 'استعلامٌ واحد لكل أهداف الكمية');
  assert.deepEqual(seen['invoiceItem.findMany'][0].where.productId, { in: ['p1', 'p2'] });
  assert.equal(seen['invoice.findMany'].length, 1, 'الديون السابقة مرةً واحدة');
  const cw = seen['invoice.findMany'][0];
  assert.deepEqual([cw.where.tenantId, cw.where.salesRepId, cw.where.status, cw.where.type, cw.where.invoiceDate.lt.toISOString()], [TENANT, 'r1', 'CONFIRMED', 'CREDIT', from]);
  assert.equal(cw.where.OR.length, 3);
  assert.equal(cw.select.receiptItems.where.receipt.status, 'ACTIVE', 'سطر السند الملغى يبقى في القاعدة فيُرشَّح');
  assert.equal(cw.select.receiptItems.where.receipt.receiptDate.lt.toISOString(), to);
  assert.deepEqual(
    [cw.select.adjustments.where.status, cw.select.adjustments.where.type, cw.select.adjustments.where.invoiceDate.lt.toISOString()],
    ['CONFIRMED', 'RETURN', from],
  );
  // بلا ديون مفتوحة: NO_BASE — وبلا أهداف كمية أو تحصيل لا استعلام لهما
  reset(ADMIN);
  targets.push(targetRow({ kind: 'COLLECTION_PCT', targetValue: 30 }));
  const nb = await call('GET', '/api/rep-targets/rep/r1?month=2026-11');
  assert.deepEqual(nb.body.data.targets[0].progress, { state: 'NO_BASE', achieved: 0, goal: 0, pct: null, done: false, base: 0, collectedPct: null });
  assert.equal(seen['invoiceItem.findMany'], undefined);
  reset(ADMIN);
  targets.push(targetRow({}));
  await call('GET', '/api/rep-targets/rep/r1?month=2026-11');
  assert.equal(seen['invoiceItem.findMany'], undefined);
  assert.equal(seen['invoice.findMany'], undefined);
  // شهرٌ بلا أهداف: قائمةٌ فارغة بملخّصه
  reset(ADMIN);
  const empty = await call('GET', '/api/rep-targets/rep/r1?month=2027-02');
  assert.equal(empty.status, 200);
  assert.deepEqual([empty.body.data.targets, empty.body.data.isCurrent, empty.body.data.daysLeft], [[], false, 28]);
});
