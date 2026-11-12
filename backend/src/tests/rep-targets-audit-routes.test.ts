// «هدف الشهر» — إصلاحات التدقيق على الموجّه /api/rep-targets فوق Prisma مزيّف (بلا قاعدة بيانات)، بنمط rep-targets-routes.test.ts:
//   • نطاق المستند (F3/F6/F9/F15): أرقام مسارات الإدارة بنطاق المستخدم — مشرف الفرق بوسم فرقه، والمقيَّد بالقوائم بعملائه
//     ومناديبه — وغير المقيَّد وجلسة المالك و/mine للمندوب بأرقامٍ كاملة بلا قيد.
//   • لقطة معامل الوحدة (F4): التعديل يُبقي لقطة سطرٍ لم يتغيّر صنفه ولا وحدته، ويعتمد الحالية بـrefreshUnitFactor وحده، و
//     GET الإدارة يُظهر currentUnitFactor حين يخالف المعامل الحالي اللقطة.
//   • مفتاح API (F10): هدف كميةٍ على صنفٍ حُوِّل أساسه بلا baseUnitName ⇒ 400 BASE_UNIT_REQUIRED بلا كتابة، كبقية كتّاب الكميات.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
// لا استيراد ساكن لما يحمّل config/database: الاستيراد يُرفع قبل البدائل فيحمّل العميل الحقيقي

process.env.JWT_SECRET = process.env.JWT_SECRET || 'rep-targets-audit-test-secret';
const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
let calls: string[] = [];
let inTx = false;
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
        calls.push('$transaction');
        if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
        inTx = true;
        try { return await (arg as (tx: unknown) => Promise<unknown>)(prismaFake); } finally { inTx = false; }
      };
    }
    // القفل الاستشاري وقفل الأصناف: الأساس المقفل هو المقروء (لا تحويل متزامن هنا)
    if (key === '$queryRaw' || key === '$executeRaw') {
      return async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push(key);
        const sql = strings.join('?');
        if (key === '$queryRaw' && sql.includes('FOR KEY SHARE')) {
          const ids = (values.find((v) => Array.isArray(v)) ?? []) as string[];
          return PRODUCTS.filter((p) => ids.includes(p.id)).map((p) => ({ id: p.id, unit: p.unit }));
        }
        return key === '$queryRaw' ? [] : 0;
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
type User = { id: string; role: string; tenantId: string; name?: string; impersonated?: boolean; apiKeyId?: string };
const ADMIN: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, name: 'مدير' };
/** مفتاح API: مستخدم مالكه ومعرّف المفتاح (authenticateApiKey) */
const API: User = { ...ADMIN, apiKeyId: 'key-1' };
/** مشرف الفريق A (scopeMode=TEAMS) */
const TEAM_SUP: User = { id: 'admin-team', role: 'MANAGER', tenantId: TENANT, name: 'مشرف أ' };
/** مقيَّد بالقوائم (scopeMode=LISTS): عملاؤه ومناديبه */
const LISTS: User = { id: 'admin-lists', role: 'MANAGER', tenantId: TENANT, name: 'مقيَّد' };
/** جلسة المالك على حساب مستخدمٍ مقيَّد: لا نطاق يقيّدها */
const OWNER: User = { ...TEAM_SUP, impersonated: true };
const REP_USER: User = { id: 'r1', role: 'SALES_REP', tenantId: TENANT, name: 'خالد' };
let currentUser: User = ADMIN;

stub('config/database', { default: prismaFake });
/* eslint-disable @typescript-eslint/no-var-requires */
const realAuth = require('../middleware/auth') as Record<string, unknown>;
stub('middleware/auth', {
  ...realAuth,
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
});
const repTargetsRouter = (require('../routes/repTargets') as typeof import('../routes/repTargets')).default;
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

const REPS = [{ id: 'r1', tenantId: TENANT }, { id: 'r2', tenantId: TENANT }];
/** مناديب كل مقيَّد: قوائم LISTS، وأعضاء فرق مشرف TEAMS */
const REP_SCOPE: Record<string, string[]> = { 'admin-lists': ['r1'], 'admin-team': ['r1'] };
type Unit = { id: string; tenantId: string; name: string; factor: number; isActive: boolean };
type Product = { id: string; tenantId: string; name: string; unit: string; deletedAt: Date | null; baseConvertedAt?: Date | null; units: Unit[] };
let PRODUCTS: Product[] = [];
const freshProducts = (): Product[] => [
  {
    id: 'p1', tenantId: TENANT, name: 'ماء', unit: 'حبة', deletedAt: null,
    units: [{ id: 'u-ct', tenantId: TENANT, name: 'كرتون', factor: 24, isActive: true }, { id: 'u-sh', tenantId: TENANT, name: 'شدّة', factor: 6, isActive: true }],
  },
  { id: 'p2', tenantId: TENANT, name: 'عصير', unit: 'علبة', deletedAt: null, units: [{ id: 'u-p2', tenantId: TENANT, name: 'صندوق', factor: 12, isActive: true }] },
  // حُوِّلت وحدته الصغرى: كان الكرتون أساساً فصار الحبّة، والكرتون وحدةً بمعامل ٢٤
  {
    id: 'p-conv', tenantId: TENANT, name: 'حليب', unit: 'حبة', deletedAt: null, baseConvertedAt: new Date('2026-11-05T09:00:00Z'),
    units: [{ id: 'u-conv-ct', tenantId: TENANT, name: 'كرتون', factor: 24, isActive: true }],
  },
];
const unitOf = (id: string): Unit => PRODUCTS.flatMap((p) => p.units).find((u) => u.id === id)!;

let targets: Row[] = [];
let targetProducts: Row[] = [];
let seq = 0;
let tpSeq = 0;
const T0 = Date.parse('2026-11-02T08:00:00Z');
function targetRow(o: Row): Row {
  seq += 1;
  return {
    id: `t-${seq}`, tenantId: TENANT, salesRepId: 'r1', month: '2026-11', kind: 'SALES_AMOUNT', targetValue: 10000,
    productId: null, productName: null, unitId: null, unitName: null, unitFactor: 1, comboId: null,
    rewardKind: 'FIXED_AMOUNT', rewardValue: 500, note: null, createdById: 'admin-1', createdByName: 'مدير',
    createdAt: new Date(T0 + seq * 1000), updatedAt: new Date(T0 + seq * 1000), ...o,
  };
}
function extraRow(o: Row): Row {
  tpSeq += 1;
  return { id: `tp-${tpSeq}`, tenantId: TENANT, productId: null, productName: null, unitId: null, unitName: null, unitFactor: 1, sortOrder: 0, ...o };
}
const match = (r: Row, where: Row): boolean => Object.entries(where).every(([k, v]) =>
  (v !== null && typeof v === 'object' && !(v instanceof Date) ? Array.isArray(v.in) && v.in.includes(r[k]) : r[k] === v));
const withExtras = (t: Row, args: Row): Row => (args?.include?.extraProducts || args?.select?.extraProducts
  ? { ...t, extraProducts: targetProducts.filter((e) => e.targetId === t.id).sort((a, b) => a.sortOrder - b.sortOrder).map((e) => ({ ...e })) }
  : { ...t });

function reset(user: User = ADMIN): void {
  calls = []; inTx = false; currentUser = user; seq = 0; tpSeq = 0;
  for (const k of Object.keys(seen)) delete seen[k];
  targets = []; targetProducts = []; PRODUCTS = freshProducts();
  scripted = {
    'tenant.findUnique': () => ({ accountingEnabled: true }),
    // صفّ المستخدم لحارس الصلاحية ولوضع النطاق (يُقرأ من القاعدة لا من التوكن)
    'admin.findUnique': (args) => {
      const id = args?.where?.id;
      if (id === TEAM_SUP.id) return { id, isActive: true, scopeEnabled: true, scopeMode: 'TEAMS', canManageSalesReps: true };
      if (id === LISTS.id) return { id, isActive: true, scopeEnabled: true, scopeMode: 'LISTS', canManageSalesReps: true };
      return { id, isActive: true, scopeEnabled: false, scopeMode: null, canManageSalesReps: true };
    },
    'salesRep.findFirst': (args) => {
      const w = args?.where ?? {};
      const rep = REPS.find((r) => r.id === w.id && r.tenantId === w.tenantId);
      if (!rep) return null;
      const scoped = w.adminScopes?.some?.adminId ?? w.teamMemberships?.some?.team?.supervisors?.some?.adminId;
      if (scoped && !(REP_SCOPE[scoped] ?? []).includes(rep.id)) return null;
      return { id: rep.id };
    },
    'product.findMany': (args) => {
      const w = args?.where ?? {};
      const ids: unknown[] = Array.isArray(w.id?.in) ? w.id.in : [];
      const uw = args?.select?.units?.where ?? {};
      return PRODUCTS.filter((x) => ids.includes(x.id) && x.tenantId === w.tenantId && x.deletedAt === null)
        .map((p) => ({
          id: p.id, name: p.name, unit: p.unit, baseConvertedAt: p.baseConvertedAt ?? null,
          units: p.units.filter((u) => match(u, uw)).map(({ id, name, factor }) => ({ id, name, factor })),
        }));
    },
    // معامل الوحدات الحالي لردّ الإدارة (currentUnitFactor)
    'productUnit.findMany': (args) => {
      const w = args?.where ?? {};
      return PRODUCTS.flatMap((p) => p.units.map((u) => ({ ...u, productId: p.id })))
        .filter((u) => match(u, w))
        .map((u) => ({ id: u.id, productId: u.productId, factor: u.factor }));
    },
    'repTarget.findMany': (args) => targets.filter((t) => match(t, args.where))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || String(a.id).localeCompare(String(b.id)))
      .map((t) => withExtras(t, args)),
    'repTarget.count': (args) => targets.filter((t) => match(t, args.where)).length,
    'repTarget.findFirst': (args) => { const t = targets.find((x) => match(x, args.where)); return t ? withExtras(t, args) : null; },
    'repTarget.create': (args) => { const row = targetRow({ ...args.data }); targets.push(row); return row; },
    'repTarget.updateMany': (args) => {
      const hit = targets.filter((t) => match(t, args.where));
      for (const t of hit) Object.assign(t, args.data);
      return { count: hit.length };
    },
    'repTargetProduct.createMany': (args) => { for (const d of args.data) targetProducts.push(extraRow(d)); return { count: args.data.length }; },
    'repTargetProduct.deleteMany': (args) => {
      const before = targetProducts.length;
      targetProducts = targetProducts.filter((e) => !match(e, args.where));
      return { count: before - targetProducts.length };
    },
    'invoice.aggregate': () => ({ _sum: { total: 0 } }),
  };
}
const writes = () => calls.filter((c) => /^repTarget(Product)?\.(create|update|delete)/.test(c));
const BODY = { month: '2026-11', kind: 'SALES_AMOUNT', targetValue: 10000, rewardKind: 'FIXED_AMOUNT', rewardValue: 500 };
const QTY = { ...BODY, kind: 'PRODUCT_QTY', targetValue: 100 };

/**
 * كل استعلامات الحساب في ردٍّ واحد — لفحص وصول قيد النطاق إليها أو غيابه. وتخصيصات سندات آجلةٍ في النطاق تُقرأ بلا قيدٍ عمداً
 * (services/repTargets.ts RepTargetDocScope)، ومرتجعات بنودها مربوطةٌ بآجلةٍ في النطاق أصلاً — فلا تُفحص هنا
 */
const PROGRESS_OPS = ['invoice.aggregate', 'invoiceItem.findMany', 'invoice.findMany', 'repVisit.findMany', 'customer.count', 'customer.findMany'] as const;
/**
 * ما يُستعلم حتماً لأهداف seedAllKinds — وcustomer.findMany (تأريخ العميل الجديد بلحظة جهازه عند القراءة) أسقطه تأريخ العميل عند
 * الكتابة (R6، routes/customers.ts) فصار العدّ customer.count وحده؛ وإن عاد يبقى في PROGRESS_OPS فيُفحص قيد نطاقه
 */
const REQUIRED_OPS = PROGRESS_OPS.filter((op) => op !== 'customer.findMany');
const queriedAll = (all: Array<[string, Row]>): void => {
  const got = new Set(all.map(([op]) => op));
  for (const op of REQUIRED_OPS) assert.ok(got.has(op), `استُعلم ${op}`);
};
const progressWheres = (): Array<[string, Row]> => PROGRESS_OPS.flatMap((op) => (seen[op] ?? [])
  .filter((a: Row) => op !== 'invoiceItem.findMany' || a.where?.productId)
  .map((a: Row) => [op, { ...a, select: undefined }] as [string, Row]));
const has = (o: unknown, needle: string): boolean => JSON.stringify(o).includes(needle);

// ═══ (١) نطاق المستند (F3/F6/F9/F15) ═══

/** أهدافٌ تستدعي كل استعلامات الحساب: المبيعات والكمية والتحصيل والزيارات والعملاء الجدد */
function seedAllKinds(): void {
  targets.push(
    targetRow({ kind: 'SALES_AMOUNT', rewardKind: 'COMMISSION_SALES_PCT', rewardValue: 2 }),
    targetRow({ kind: 'PRODUCT_QTY', productId: 'p1', productName: 'ماء', unitId: 'u-ct', unitName: 'كرتون', unitFactor: 24, targetValue: 10 }),
    targetRow({ kind: 'COLLECTION_PCT', targetValue: 50 }),
    targetRow({ kind: 'VISITS_COUNT', targetValue: 20 }),
    targetRow({ kind: 'NEW_CUSTOMERS', targetValue: 3 }),
  );
}

test('نطاق المستند: مشرف الفرق يرى أرقام المندوب بوسم فرقه وحده في كل استعلامات الحساب (المبيعات والكمية والتحصيل والزيارات والعملاء الجدد)', async () => {
  reset(TEAM_SUP);
  seedAllKinds();
  const r = await call('GET', '/api/rep-targets/rep/r1?month=2026-11');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const all = progressWheres();
  queriedAll(all); // كل أنواع الحساب استُعلمت
  // قيد الفريق بوسم المستند (team.supervisors) لا بعضوية المندوب — في كل استعلام
  for (const [op, args] of all) assert.ok(has(args, '"supervisors":{"some":{"adminId":"admin-team"}}'), `${op}: ${JSON.stringify(args)}`);
  // مشرف الفرق: العملاء مشتركون بين الفرق — فالعميل الجديد بوسم فاتورته لا بقائمة عملاء
  assert.equal(has(seen['customer.count'][0].where, 'adminScopes'), false);
  // والأرقام نفسها في ردّ الإنشاء والتعديل
  for (const k of Object.keys(seen)) delete seen[k];
  const post = await call('POST', '/api/rep-targets/rep/r1', BODY);
  assert.equal(post.status, 201, JSON.stringify(post.body));
  assert.ok(seen['invoice.aggregate'].length > 0);
  for (const a of seen['invoice.aggregate']) assert.ok(has(a, '"adminId":"admin-team"'), 'ردّ الإنشاء بنطاقه');
  for (const k of Object.keys(seen)) delete seen[k];
  const put = await call('PUT', `/api/rep-targets/${targets[0].id}`, { ...BODY, targetValue: 9000 });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  for (const a of seen['invoice.aggregate']) assert.ok(has(a, '"adminId":"admin-team"'), 'ردّ التعديل بنطاقه');
});

test('نطاق المستند: المقيَّد بالقوائم يرى أرقام المندوب من عملاء نطاقه ومناديبه وحدها، والعملاء الجدد من عملاء نطاقه', async () => {
  reset(LISTS);
  seedAllKinds();
  const r = await call('GET', '/api/rep-targets/rep/r1?month=2026-11');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const all = progressWheres();
  queriedAll(all);
  for (const [op, args] of all) assert.ok(has(args, '"adminScopes":{"some":{"adminId":"admin-lists"}}'), `${op}: ${JSON.stringify(args)}`);
  // العميل الجديد من عملاء قائمته (لا بفاتورته وحدها)
  assert.deepEqual(seen['customer.count'][0].where.adminScopes, { some: { adminId: 'admin-lists' } });
  // ولا قيد فرقٍ لمن ليس مشرف فرق
  for (const [, args] of all) assert.equal(has(args, 'supervisors'), false);
});

test('نطاق المستند: غير المقيَّد وجلسة المالك (ولو على حساب مشرف) و/mine للمندوب بأرقامٍ كاملة بلا أي قيد نطاق', async () => {
  for (const [who, user, url] of [
    ['مدير بلا نطاق', ADMIN, '/api/rep-targets/rep/r1?month=2026-11'],
    ['جلسة المالك', OWNER, '/api/rep-targets/rep/r1?month=2026-11'],
    ['المندوب', REP_USER, '/api/rep-targets/mine?month=2026-11'],
  ] as const) {
    reset(user);
    seedAllKinds();
    const r = await call('GET', url);
    assert.equal(r.status, 200, `${who}: ${JSON.stringify(r.body)}`);
    const all = progressWheres();
    assert.equal(all.length > 0, true, who);
    for (const [op, args] of all) {
      assert.equal(has(args, 'adminScopes') || has(args, 'supervisors') || has(args, 'teamMemberships'), false, `${who} ${op}: ${JSON.stringify(args)}`);
    }
  }
  // المندوب على /mine: صفّ المستخدم الإداري لا يُقرأ أصلاً (لا نطاق للمندوب)
  reset(REP_USER);
  seedAllKinds();
  await call('GET', '/api/rep-targets/mine?month=2026-11');
  assert.equal(seen['admin.findUnique'], undefined);
});

test('نطاق المستند (R1): الردّ يقول scoped — صحيحٌ للمشرف والمقيَّد في GET والإنشاء والتعديل، وخاطئٌ لغير المقيَّد وجلسة المالك، وغائبٌ عن /mine', async () => {
  for (const [who, user, expected] of [
    ['مشرف الفرق', TEAM_SUP, true],
    ['المقيَّد بالقوائم', LISTS, true],
    ['مدير بلا نطاق', ADMIN, false],
    ['جلسة المالك', OWNER, false],
  ] as const) {
    reset(user);
    seedAllKinds();
    const g = await call('GET', '/api/rep-targets/rep/r1?month=2026-11');
    assert.equal(g.status, 200, `${who}: ${JSON.stringify(g.body)}`);
    assert.equal(g.body.data.scoped, expected, `${who} GET`);
    assert.equal(g.body.data.targets.length, 5, `${who}: الأهداف كما هي بجانب العلم`);
    assert.equal(typeof g.body.data.monthNetSales, 'number');
    const post = await call('POST', '/api/rep-targets/rep/r1', BODY);
    assert.equal(post.status, 201, `${who}: ${JSON.stringify(post.body)}`);
    assert.equal(post.body.data.scoped, expected, `${who} POST`);
    assert.equal(post.body.data.id, targets.at(-1)!.id, `${who}: ردّ الإنشاء هو الهدف نفسه بتقدّمه`);
    assert.ok(post.body.data.progress && post.body.data.reward, `${who}: التقدّم والمكافأة في ردّ الإنشاء`);
    const put = await call('PUT', `/api/rep-targets/${targets[0].id}`, { ...BODY, targetValue: 9000 });
    assert.equal(put.status, 200, `${who}: ${JSON.stringify(put.body)}`);
    assert.equal(put.body.data.scoped, expected, `${who} PUT`);
    assert.equal(put.body.data.targetValue, 9000);
  }
  // عضو هدفٍ مدمج يُقرأ من شهره (repTargetsMonth) — والعلم في ردّ تعديله كذلك
  reset(TEAM_SUP);
  targets.push(targetRow({ comboId: 'c1' }), targetRow({ kind: 'VISITS_COUNT', targetValue: 20, comboId: 'c1' }));
  const combo = await call('PUT', `/api/rep-targets/${targets[0].id}`, { ...BODY, targetValue: 8000 });
  assert.equal(combo.status, 200, JSON.stringify(combo.body));
  assert.equal(combo.body.data.comboId, 'c1');
  assert.equal(combo.body.data.scoped, true);
  // المندوب يرى عمله كله: لا علم في ردّه
  reset(REP_USER);
  seedAllKinds();
  const mine = await call('GET', '/api/rep-targets/mine?month=2026-11');
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal('scoped' in mine.body.data, false);
});

// ═══ (٢) لقطة معامل الوحدة (F4) ═══

/** هدف «١٠٠ كرتون» (٢٤) + «صندوق عصير» (١٢) + «شدّة» (٦) إضافياً، ثم صار الكرتون ١٢ */
function seedUnitDrift(): Row {
  const t = targetRow({ kind: 'PRODUCT_QTY', productId: 'p1', productName: 'ماء', unitId: 'u-ct', unitName: 'كرتون', unitFactor: 24, targetValue: 100 });
  targets.push(t);
  targetProducts.push(extraRow({ targetId: t.id, productId: 'p2', productName: 'عصير', unitId: 'u-p2', unitName: 'صندوق', unitFactor: 12, sortOrder: 1 }));
  unitOf('u-ct').factor = 12;
  return t;
}
const LINES = [{ productId: 'p1', unitId: 'u-ct', baseUnitName: 'حبة' }, { productId: 'p2', unitId: 'u-p2', baseUnitName: 'علبة' }];

test('لقطة الوحدة: GET الإدارة يُظهر currentUnitFactor للسطر الذي تغيّر معامل وحدته وحده (null لغيره)، و/mine بلا الحقل', async () => {
  reset(ADMIN);
  const t = seedUnitDrift();
  targets.push(targetRow({ kind: 'PRODUCT_QTY', productId: 'p2', productName: 'عصير', unitName: 'علبة', unitFactor: 1, targetValue: 5 }));
  targets.push(targetRow({}));
  const r = await call('GET', '/api/rep-targets/rep/r1?month=2026-11');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [qty, base, sales] = r.body.data.targets;
  assert.equal(qty.id, t.id);
  assert.deepEqual(qty.products.map((p: Row) => [p.productId, p.unitFactor, p.currentUnitFactor]), [['p1', 24, 12], ['p2', 12, null]]);
  assert.deepEqual(base.products.map((p: Row) => [p.unitId, p.currentUnitFactor]), [[null, null]], 'الأساس معامله ١ دائماً');
  assert.deepEqual(sales.products, []);
  // استعلامٌ واحد بوحدات الأسطر وحدها، بشرط الشركة والنشطة
  assert.deepEqual(seen['productUnit.findMany'].map((a: Row) => a.where), [{ tenantId: TENANT, id: { in: ['u-ct', 'u-p2'] }, isActive: true }]);
  // وحدةٌ موقوفة لا تُعتمد فلا تنبيه
  unitOf('u-ct').isActive = false;
  const off = await call('GET', '/api/rep-targets/rep/r1?month=2026-11');
  assert.equal(off.body.data.targets[0].products[0].currentUnitFactor, null);
  // المندوب لا يُعطى الحقل ولا يُستعلم له
  reset(REP_USER);
  seedUnitDrift();
  const mine = await call('GET', '/api/rep-targets/mine?month=2026-11');
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal('currentUnitFactor' in mine.body.data.targets[0].products[0], false);
  assert.equal(seen['productUnit.findMany'], undefined);
});

test('لقطة الوحدة: تعديل الملاحظة أو المكافأة يُبقي لقطة السطر الذي لم يتغيّر صنفه ولا وحدته — ولو انتقل موضعه في القائمة', async () => {
  reset(ADMIN);
  const t = seedUnitDrift();
  const put = await call('PUT', `/api/rep-targets/${t.id}`, { ...QTY, products: LINES, note: 'ملاحظة جديدة', rewardValue: 900 });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual([t.unitId, t.unitName, t.unitFactor, t.note, t.rewardValue], ['u-ct', 'كرتون', 24, 'ملاحظة جديدة', 900], 'لا يصير ١٢٠٠ حبّة');
  assert.deepEqual(targetProducts.map((e) => [e.productId, e.unitId, e.unitFactor, e.sortOrder]), [['p2', 'u-p2', 12, 1]]);
  // واللقطة المحفوظة تُقرأ تحت قفل المندوب
  const read = seen['repTarget.findFirst'].find((a: Row) => a.select?.extraProducts);
  assert.ok(read, 'لقطة الأسطر الإضافية مقروءة');
  assert.ok(calls.indexOf('$executeRaw') < calls.indexOf('repTarget.findFirst@tx'));
  // والردّ يقيس بالمحفوظة: الصنف الأول بمعامل ٢٤
  assert.deepEqual(put.body.data.products.map((p: Row) => p.unitFactor), [24, 12]);
  // الصنف نفسه بوحدته نفسها في موضعٍ آخر (إضافياً) يُبقي لقطته كذلك
  const moved = await call('PUT', `/api/rep-targets/${t.id}`, { ...QTY, products: [LINES[1], LINES[0]] });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual([t.productId, t.unitFactor], ['p2', 12]);
  assert.deepEqual(targetProducts.map((e) => [e.productId, e.unitId, e.unitName, e.unitFactor]), [['p1', 'u-ct', 'كرتون', 24]]);
  // وجسمٌ بصنفٍ واحد (بلا products) كذلك
  const single = await call('PUT', `/api/rep-targets/${t.id}`, { ...QTY, productId: 'p1', unitId: 'u-ct', baseUnitName: 'حبة' });
  assert.equal(single.status, 200, JSON.stringify(single.body));
  assert.deepEqual([t.productId, t.unitId, t.unitFactor], ['p1', 'u-ct', 24]);
});

test('لقطة الوحدة: refreshUnitFactor: true يعتمد المعامل الحالي، وتغيير الوحدة أو الصنف يأخذ الحالية، وإعادة تسمية الوحدة بالمعامل نفسه تسري', async () => {
  reset(ADMIN);
  const t = seedUnitDrift();
  const refresh = await call('PUT', `/api/rep-targets/${t.id}`, { ...QTY, products: LINES, refreshUnitFactor: true });
  assert.equal(refresh.status, 200, JSON.stringify(refresh.body));
  assert.deepEqual([t.unitId, t.unitName, t.unitFactor], ['u-ct', 'كرتون', 12]);
  // ثم لا فرق ⇒ لا تنبيه
  const g = await call('GET', '/api/rep-targets/rep/r1?month=2026-11');
  assert.equal(g.body.data.targets[0].products[0].currentUnitFactor, null);

  // تغيير الوحدة (كرتون ⇒ شدّة) يأخذ الحالية بلا refresh
  reset(ADMIN);
  const t2 = seedUnitDrift();
  const unit = await call('PUT', `/api/rep-targets/${t2.id}`, { ...QTY, productId: 'p1', unitId: 'u-sh', baseUnitName: 'حبة' });
  assert.equal(unit.status, 200, JSON.stringify(unit.body));
  assert.deepEqual([t2.unitId, t2.unitName, t2.unitFactor], ['u-sh', 'شدّة', 6]);
  // والعودة للكرتون بعدها وحدةٌ «متغيّرة» عن المحفوظ ⇒ الحالية (١٢)
  await call('PUT', `/api/rep-targets/${t2.id}`, { ...QTY, productId: 'p1', unitId: 'u-ct', baseUnitName: 'حبة' });
  assert.deepEqual([t2.unitId, t2.unitFactor], ['u-ct', 12]);

  // تغيير الصنف: لقطة الصنف الجديد
  reset(ADMIN);
  const t3 = seedUnitDrift();
  await call('PUT', `/api/rep-targets/${t3.id}`, { ...QTY, productId: 'p-conv', unitId: 'u-conv-ct', baseUnitName: 'حبة' });
  assert.deepEqual([t3.productId, t3.unitId, t3.unitFactor], ['p-conv', 'u-conv-ct', 24]);

  // إعادة تسمية الوحدة بالمعامل نفسه: الاسم الحالي يسري (لا معنى يتغيّر)
  reset(ADMIN);
  const t4 = targetRow({ kind: 'PRODUCT_QTY', productId: 'p2', productName: 'عصير', unitId: 'u-p2', unitName: 'كرتونة', unitFactor: 12, targetValue: 7 });
  targets.push(t4);
  await call('PUT', `/api/rep-targets/${t4.id}`, { ...QTY, productId: 'p2', unitId: 'u-p2', baseUnitName: 'علبة' });
  assert.deepEqual([t4.unitName, t4.unitFactor], ['صندوق', 12]);

  // refreshUnitFactor قيمةٌ منطقية صريحة وحدها
  reset(ADMIN);
  const t5 = seedUnitDrift();
  for (const bad of ['true', 1, 'yes']) {
    const r = await call('PUT', `/api/rep-targets/${t5.id}`, { ...QTY, products: LINES, refreshUnitFactor: bad });
    assert.equal(r.status, 400, `${JSON.stringify(bad)}: ${JSON.stringify(r.body)}`);
  }
  assert.deepEqual(writes(), []);
  assert.equal(t5.unitFactor, 24);
  // وفي الإنشاء لا أثر له: لقطة الوحدة الحالية دائماً
  const created = await call('POST', '/api/rep-targets/rep/r1', { ...QTY, productId: 'p1', unitId: 'u-ct', refreshUnitFactor: false });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(targets.at(-1)!.unitFactor, 12);
});

// ═══ (٣) مفتاح API وقاعدة D19-ب (F10) ═══

test('مفتاح API: هدف كميةٍ على صنفٍ حُوِّل أساسه بلا baseUnitName ⇒ 400 BASE_UNIT_REQUIRED بلا كتابة في الإنشاء والتعديل، أولاً كان الصنف أو إضافياً', async () => {
  reset(API);
  const mine = targetRow({ kind: 'PRODUCT_QTY', productId: 'p1', productName: 'ماء', unitName: 'حبة', unitFactor: 1, targetValue: 5 });
  targets.push(mine);
  const before = JSON.stringify({ targets, targetProducts });
  for (const [why, body] of [
    ['صنفٌ واحد بالأساس', { ...QTY, productId: 'p-conv', unitId: null }],
    ['صنفٌ واحد بوحدة', { ...QTY, productId: 'p-conv', unitId: 'u-conv-ct' }],
    ['إضافياً', { ...QTY, products: [{ productId: 'p1', unitId: 'u-ct' }, { productId: 'p-conv', unitId: null }] }],
    ['إضافياً بأساسٍ فارغ', { ...QTY, products: [{ productId: 'p1' }, { productId: 'p-conv', baseUnitName: '  ' }] }],
  ] as const) {
    for (const [m, url] of [['POST', '/api/rep-targets/rep/r1'], ['PUT', `/api/rep-targets/${mine.id}`]] as const) {
      const r = await call(m, url, body);
      assert.equal(r.status, 400, `${why} ${m}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'BASE_UNIT_REQUIRED', `${why} ${m}`);
      assert.equal(r.body.success, false);
      assert.match(r.body.message, /حليب/);
      assert.match(r.body.message, /baseUnitName/);
    }
  }
  assert.deepEqual(writes(), []);
  assert.equal(calls.includes('$transaction'), false, 'الرفض قبل المعاملة');
  assert.equal(JSON.stringify({ targets, targetProducts }), before);
});

test('مفتاح API: الأساس الصريح يمرّ، وصنفٌ لم يُحوَّل قط وغير هدف الكمية بلا الحقل يمرّان، والجلسة العادية بلا الحقل كما كانت', async () => {
  reset(API);
  for (const body of [
    { ...QTY, productId: 'p-conv', unitId: null, baseUnitName: 'حبة' },
    { ...QTY, products: [{ productId: 'p1' }, { productId: 'p-conv', unitId: 'u-conv-ct', baseUnitName: 'حبة' }] },
    { ...QTY, productId: 'p1', unitId: 'u-ct' },
    BODY,
  ]) {
    const r = await call('POST', '/api/rep-targets/rep/r1', body);
    assert.equal(r.status, 201, `${JSON.stringify(body)}: ${JSON.stringify(r.body)}`);
  }
  assert.deepEqual([targets[0].productId, targets[0].unitName, targets[0].unitFactor], ['p-conv', 'حبة', 1]);
  // الجلسة (بلا مفتاح) على الصنف المحوَّل بلا الحقل: مسار اليوم
  reset(ADMIN);
  const s = await call('POST', '/api/rep-targets/rep/r1', { ...QTY, productId: 'p-conv', unitId: null });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const put = await call('PUT', `/api/rep-targets/${targets[0].id}`, { ...QTY, productId: 'p-conv', unitId: 'u-conv-ct' });
  assert.equal(put.status, 200, JSON.stringify(put.body));
});
