// «الوحدة الرئيسية» (مواصفة الوحدة الرئيسية §2.2، الحزمة B2) — مسارات الأصناف عبر الموجّه الحقيقي بعميل Prisma مزيّف (بلا قاعدة):
//   • POST /: الجسم بلا primaryUnitName حرفياً كما كان (ومنه units منسوخة من GET)، والإنشاء العكسي الذرّي والسعر المشتقّ.
//   • PUT /:id/primary-unit: علمٌ تحت القفل، وexpectedPrimaryUnitId، والوحدة الصالحة وحدها.
//   • الوحدات: makePrimary، وPRIMARY_UNIT_IN_USE إلا بـclearPrimary، وexpectedBaseName، وD19 لمفتاح API.
//   • PUT /:id المحروس: FOR NO KEY UPDATE بمهلةٍ محلية، والأساس المتوقَّع، ورقعة الرئيسية ذرّية، وإعادة التسمية صفّ سجلّ بمعامل ١،
//     والاسم المتقاعد (D20)، وD19، والانشغال 503، ومسار «تتبّع اللوط» مع الرقعة في طلبٍ واحد.
//   • price-tiers بـexpectedPrimary، وGET /customer-prices يردّ unit.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Call = { op: string; args: any; inTx: boolean };
let calls: Call[] = [];
let inTx = false;
let scripted: Record<string, (args: any) => unknown> = {};
let rawScript: (sql: string, values: unknown[]) => unknown = () => undefined;

function defaultFor(method: string): unknown {
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (method === 'updateMany' || method === 'deleteMany' || method === 'createMany') return { count: 0 };
  return null;
}
const prismaFake: any = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (arg: unknown, opts?: unknown) => {
        calls.push({ op: '$transaction', args: opts, inTx });
        if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
        inTx = true;
        try { return await (arg as (tx: unknown) => Promise<unknown>)(prismaFake); } finally { inTx = false; }
      };
    }
    if (key === '$queryRaw' || key === '$executeRaw') {
      return async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?').replace(/\s+/g, ' ').trim();
        calls.push({ op: key, args: { sql, values }, inTx });
        const out = rawScript(sql, values);
        return out !== undefined ? out : (key === '$queryRaw' ? [] : 0);
      };
    }
    if (key === 'then') return undefined;
    return new Proxy({}, {
      get: (_m, method: string) => async (args: unknown) => {
        calls.push({ op: `${key}.${method}`, args, inTx });
        const fn = scripted[`${key}.${method}`];
        return fn ? fn(args) : defaultFor(method);
      },
    });
  },
});

const TENANT = 'T1';
type User = { id: string; role: string; tenantId: string; impersonated?: boolean; apiKeyId?: string; name?: string };
let currentUser: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT };
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();
stub('config/database', { default: prismaFake });
stub('services/customerScope', { canAccessCustomer: async () => true });
stub('middleware/auth', {
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
  requireAdmin: pass, requireAccounting: pass, requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
  isOwnerSession: (req: { user?: { impersonated?: boolean } }) => req.user?.impersonated === true,
  actorOf: (req: { user?: { id?: string; impersonated?: boolean } }) => (req.user?.impersonated ? `OWNER:${req.user?.id}` : req.user?.id ?? ''),
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const productsModule = require('../routes/products') as typeof import('../routes/products');

let server: { port: number; close: () => Promise<void> } | null = null;
after(async () => { await server?.close(); server = null; });

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: Record<string, any> }> {
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use('/api/products', productsModule.default);
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ success: false, message: err.message }); });
    const s = http.createServer(app);
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
  }
  const r = await fetch(`http://127.0.0.1:${server.port}${url}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : {} };
}

const ops = (): string[] => calls.map((c) => c.op);
const opIdx = (op: string): number => calls.findIndex((c) => c.op === op);
const rawIdx = (frag: string): number => calls.findIndex((c) => (c.op === '$queryRaw' || c.op === '$executeRaw') && String(c.args.sql).includes(frag));
const first = (op: string): Call => { const c = calls.find((x) => x.op === op); assert.ok(c, `${op} لم يُستدعَ: ${ops().join(' → ')}`); return c!; };

function reset(user: Partial<User> = {}): void {
  calls = []; inTx = false; scripted = {}; rawScript = () => undefined;
  currentUser = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, ...user };
}

type UnitRow = { id: string; tenantId: string; productId: string; name: string; factor: number; price: number | null; unitCode: string | null; isActive: boolean; sortOrder: number };
const unit = (o: Partial<UnitRow> & { id: string; name: string; factor: number }): UnitRow =>
  ({ tenantId: TENANT, productId: 'p1', price: null, unitCode: null, isActive: true, sortOrder: 0, ...o });

/** صنفٌ أساسه قارورة وله كرتون ٢٤ — والرئيسية والتحويل وسجلّه حسب الحالة */
function world(o: { unit?: string; primaryUnitId?: string | null; baseConvertedAt?: Date | null; units?: UnitRow[];
  conversions?: Array<{ fromUnit: string; toUnit: string; factor: number }>; lots?: boolean } = {}) {
  const product: Record<string, any> = {
    id: 'p1', tenantId: TENANT, name: 'ماء', code: 'W1', unit: o.unit ?? 'قارورة', basePrice: 2, unitCode: 'PCE',
    primaryUnitId: o.primaryUnitId ?? null, baseConvertedAt: o.baseConvertedAt ?? null, lotTracked: false, lotTrackedSince: null,
    shelfLifeEnabled: false, shelfLifeValue: null, shelfLifeUnit: null, shelfLifeBasis: 'SALE', shelfLifeFromDate: null,
    returnRuleEnabled: false, returnRuleMode: null, returnRuleMetric: null, returnRuleValue: null,
    repSaleAllowed: true, repReturnAllowed: true, repSaleUnit: 'ANY', repReturnUnit: 'ANY',
  };
  const units: UnitRow[] = o.units ?? [unit({ id: 'u-ct', name: 'كرتون', factor: 24, price: 48, unitCode: 'CT' })];
  const conversions = [...(o.conversions ?? [])];
  const logs: any[] = [];
  const tiers: any[] = [];
  const view = () => ({ ...product, units: units.map((u) => ({ ...u })) });
  scripted = {
    'product.findFirst': (a) => (a?.where?.id === 'p1' && a?.where?.tenantId === TENANT ? view() : null),
    'product.update': (a) => { Object.assign(product, a.data); return view(); },
    'product.updateMany': (a) => {
      if (a?.where?.id !== 'p1' || a?.where?.tenantId !== TENANT) return { count: 0 };
      Object.assign(product, a.data);
      return { count: 1 };
    },
    'productUnit.findMany': (a) => units.filter((u) => u.productId === a?.where?.productId && u.tenantId === a?.where?.tenantId).map((u) => ({ ...u })),
    'productUnit.findFirst': (a) => units.find((u) => u.id === a?.where?.id) ?? null,
    'productUnit.create': (a) => { const u = { ...unit({ id: `u-new-${units.length}`, name: '', factor: 1 }), ...a.data }; units.push(u); return u; },
    'productUnit.updateMany': (a) => {
      const mine = units.filter((u) => u.id === a.where.id && u.productId === a.where.productId && u.tenantId === a.where.tenantId);
      for (const u of mine) Object.assign(u, a.data);
      return { count: mine.length };
    },
    'productUnit.deleteMany': (a) => {
      const i = units.findIndex((u) => u.id === a.where.id && u.productId === a.where.productId && u.tenantId === a.where.tenantId);
      if (i < 0) return { count: 0 };
      units.splice(i, 1);
      return { count: 1 };
    },
    'productBaseConversion.findMany': (a) => conversions.filter((c) => a?.where?.tenantId === TENANT && a?.where?.productId === 'p1' && c.factor > (a?.where?.factor?.gt ?? 0)),
    'productBaseConversion.create': (a) => { const row = { id: `conv-${logs.length + 1}`, ...a.data }; logs.push(row); return row; },
    'priceTier.create': (a) => { tiers.push(a.data); return a.data; },
    'tenant.findUnique': () => ({ lotTrackingEnabled: o.lots === true }),
  };
  rawScript = (sql) => {
    if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '3s' }];
    if (sql.includes('FROM products WHERE id = ? AND "tenantId" = ? FOR UPDATE') && sql.includes('"primaryUnitId"')) {
      return [{ id: 'p1', name: product.name, unit: product.unit, lotTracked: product.lotTracked, lotTrackedSince: null, primaryUnitId: product.primaryUnitId, baseConvertedAt: product.baseConvertedAt }];
    }
    if (sql.includes('FROM products WHERE id = ?')) return [{ id: 'p1' }];
    return undefined;
  };
  return { product, units, logs, tiers };
}

// ═══ POST / ═══

const OLD_BODY = { code: 'W1', name: 'ماء', unit: 'قارورة', basePrice: 2, taxPct: 15 };

test('POST بلا primaryUnitName: المسار القائم حرفياً — ولو حمل الجسم units منسوخة من GET (تُتجاهل كما اليوم)', async () => {
  const seen: any[] = [];
  for (const body of [OLD_BODY, { ...OLD_BODY, units: [{ id: 'x', name: 'كرتون', factor: 24, price: 48 }], primaryUnitId: 'x' }]) {
    reset();
    scripted['product.create'] = (a) => ({ id: 'p-new', ...a.data });
    const r = await call('POST', '/api/products', body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(ops(), ['product.findFirst', 'product.create'], 'لا معاملة ولا وحدات');
    seen.push(calls[1].args);
  }
  assert.deepEqual(seen[1], seen[0], 'createArgs نفسه بالجسمين');
  assert.ok(!('units' in seen[0].data) && !('primaryUnitId' in seen[0].data) && !('primaryUnitName' in seen[0].data));
  assert.deepEqual(seen[0].include, { category: true, units: { orderBy: [{ sortOrder: 'asc' }, { factor: 'asc' }] } });
});

test('POST العكسي: الصنف ووحداته ورئيسيّه في معاملةٍ واحدة، وسعر الكرتون صريحٌ على وحدته وسعر القارورة مشتقّ', async () => {
  reset();
  scripted['product.create'] = (a) => ({ id: 'p-new', ...a.data, units: a.data.units.create.map((u: any, i: number) => ({ id: `u${i}`, ...u })) });
  scripted['product.update'] = (a) => ({ id: a.where.id, ...a.data });
  const body = { code: 'W24', name: 'مياه 330', unit: 'قارورة', unitCode: 'PCE', taxPct: 15,
    units: [{ name: 'طبلية', factor: 1200, price: '' }, { name: ' كرتون ', factor: 24, price: 50, unitCode: 'CT' }], primaryUnitName: 'كرتون' };
  const r = await call('POST', '/api/products', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const create = first('product.create');
  const upd = first('product.update');
  assert.ok(create.inTx && upd.inTx && opIdx('$transaction') < opIdx('product.create') && opIdx('product.create') < opIdx('product.update'));
  assert.equal(create.args.data.basePrice, 2.0833, '50 ÷ 24 نصف‑لأعلى لأربع منازل');
  assert.equal(create.args.data.unitCode, 'PCE', 'رمز الفرعية على الصنف');
  assert.deepEqual(create.args.data.units.create, [
    { tenantId: TENANT, name: 'طبلية', factor: 1200, price: null, unitCode: null, sortOrder: 1 },
    { tenantId: TENANT, name: 'كرتون', factor: 24, price: 50, unitCode: 'CT', sortOrder: 0 },
  ]);
  assert.ok(!('primaryUnitName' in create.args.data) && !('primaryUnitId' in create.args.data));
  assert.deepEqual(upd.args.where, { id: 'p-new' });
  assert.deepEqual(upd.args.data, { primaryUnitId: 'u1' }, 'معرّف الكرتون بالاسم');
  assert.equal(r.body.data.primaryUnitId, 'u1');
});

test('POST العكسي: 16.33 ÷ 8 = 2.0413، والسعر الصريح يُحترم، والأخطاء قبل أي كتابة', async () => {
  const mk = (o: Record<string, unknown> = {}) => ({ code: 'X', name: 'س', unit: 'حبة', taxPct: 15, units: [{ name: 'شدة', factor: 8, price: 16.33 }], primaryUnitName: 'شدة', ...o });
  const created = async (body: unknown) => {
    reset();
    scripted['product.create'] = (a) => ({ id: 'p-new', ...a.data, units: a.data.units.create.map((u: any, i: number) => ({ id: `u${i}`, ...u })) });
    scripted['product.update'] = (a) => ({ id: a.where.id, ...a.data });
    return call('POST', '/api/products', body);
  };
  assert.equal((await created(mk())).status, 201);
  assert.equal(first('product.create').args.data.basePrice, 2.0413);
  assert.equal((await created(mk({ basePrice: 2.1 }))).status, 201);
  assert.equal(first('product.create').args.data.basePrice, 2.1, 'سعر الفرعية الصريح');

  for (const [body, status, code, re] of [
    [mk({ primaryUnitName: 'كرتون' }), 400, 'PRIMARY_UNIT_INVALID', /إحدى وحدات الصنف/],
    [mk({ units: [] }), 400, 'PRIMARY_UNIT_INVALID', /إحدى وحدات الصنف/],
    [mk({ units: [{ name: 'شدة', factor: 8 }] }), 400, undefined, /اكتب سعر الوحدة الرئيسية أو سعر الوحدة الفرعية/],
    [mk({ units: [{ name: 'شدة', factor: 1, price: 5 }] }), 400, 'PRODUCT_UNITS_INVALID', /./],
    [mk({ units: [{ name: 'حبة', factor: 8, price: 5 }], primaryUnitName: 'حبة' }), 400, 'PRODUCT_UNITS_INVALID', /مكرر/],
  ] as const) {
    reset();
    const r = await call('POST', '/api/products', body);
    assert.equal(r.status, status, `${JSON.stringify(body)} ⇒ ${JSON.stringify(r.body)}`);
    if (code) assert.equal(r.body.code, code);
    assert.match(String(r.body.message), re);
    assert.deepEqual(ops(), [], 'لا استعلام ولا كتابة قبل التحقق');
  }
});

test('POST العكسي ذرّي: فشل إدراج الوحدات (داخل إنشاء الصنف نفسه في المعاملة) ⇒ لا رئيسية ولا ردّ 201', async () => {
  reset();
  scripted['product.create'] = () => { throw new Error('insert product_units failed'); };
  const r = await call('POST', '/api/products', { code: 'X', name: 'س', unit: 'حبة', basePrice: 1, taxPct: 15, units: [{ name: 'كرتون', factor: 24, price: 24 }], primaryUnitName: 'كرتون' });
  assert.equal(r.status, 500);
  const c = first('product.create');
  assert.ok(c.inTx, 'الصنف ووحداته في معاملة');
  assert.ok(Array.isArray(c.args.data.units.create), 'الوحدات إدراجٌ متداخل في جملة الصنف نفسها — لا صنف بلا وحداته');
  assert.equal(opIdx('product.update'), -1);
});

// ═══ PUT /:id/primary-unit ═══

test('PUT primary-unit: علمٌ تحت قفل الصفّ، وexpectedPrimaryUnitId القديم ⇒ 409، والوحدة الموقوفة أو لصنفٍ آخر ⇒ 400', async () => {
  reset();
  const w = world();
  const ok = await call('PUT', '/api/products/p1/primary-unit', { unitId: 'u-ct', expectedPrimaryUnitId: null });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(w.product.primaryUnitId, 'u-ct');
  const lock = rawIdx('FOR UPDATE');
  assert.ok(lock >= 0 && calls[lock].inTx && lock < opIdx('product.update'), 'القفل قبل الكتابة');
  assert.deepEqual(first('product.update').args.data, { primaryUnitId: 'u-ct' });
  assert.equal(ok.body.data.primaryUnitId, 'u-ct');

  // نموذجٌ قديم: رأى «بلا رئيسية» والرئيسية الآن كرتون
  reset();
  world({ primaryUnitId: 'u-ct' });
  const stale = await call('PUT', '/api/products/p1/primary-unit', { unitId: null, expectedPrimaryUnitId: null });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'PRIMARY_UNIT_CHANGED');
  assert.equal(opIdx('product.update'), -1);

  // بلا المفتاح ⇒ لا مقارنة؛ وnull يلغي الرئيسية
  reset();
  const w2 = world({ primaryUnitId: 'u-ct' });
  assert.equal((await call('PUT', '/api/products/p1/primary-unit', { unitId: null })).status, 200);
  assert.equal(w2.product.primaryUnitId, null);

  for (const [units, id] of [
    [[unit({ id: 'u-ct', name: 'كرتون', factor: 24, isActive: false })], 'u-ct'],
    [[unit({ id: 'u-ct', name: 'كرتون', factor: 24 })], 'u-other-product'],
  ] as const) {
    reset();
    world({ units: [...units] });
    const r = await call('PUT', '/api/products/p1/primary-unit', { unitId: id });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, 'PRIMARY_UNIT_INVALID');
    assert.equal(opIdx('product.update'), -1);
  }
  reset();
  world();
  assert.equal((await call('PUT', '/api/products/p-x/primary-unit', { unitId: 'u-ct' })).status, 404);
});

// ═══ الوحدات ═══

test('الوحدات: makePrimary يضبط الرئيسية في المعاملة نفسها، وإيقاف الرئيسية أو حذفها ⇒ 409 PRIMARY_UNIT_IN_USE إلا بـclearPrimary', async () => {
  reset();
  const w = world({ units: [] });
  const add = await call('POST', '/api/products/p1/units', { name: 'كرتون', factor: 24, price: 48, makePrimary: true });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.equal(w.product.primaryUnitId, add.body.data.id);
  const set = calls.find((c) => c.op === 'product.updateMany' && 'primaryUnitId' in c.args.data)!;
  assert.ok(set.inTx && opIdx('productUnit.create') < calls.indexOf(set));

  reset();
  const w2 = world({ primaryUnitId: 'u-ct' });
  const off = await call('PUT', '/api/products/p1/units/u-ct', { isActive: false });
  assert.equal(off.status, 409, JSON.stringify(off.body));
  assert.equal(off.body.code, 'PRIMARY_UNIT_IN_USE');
  assert.equal(opIdx('productUnit.updateMany'), -1);
  assert.equal(w2.units[0].isActive, true);
  // تعديل اسم الرئيسية أو سعرها أو معاملها مسموح (التاريخ يحمل لقطاته)
  assert.equal((await call('PUT', '/api/products/p1/units/u-ct', { price: 50, factor: 12 })).status, 200);
  const offOk = await call('PUT', '/api/products/p1/units/u-ct', { isActive: false, clearPrimary: true });
  assert.equal(offOk.status, 200, JSON.stringify(offOk.body));
  assert.equal(w2.units[0].isActive, false);
  assert.equal(w2.product.primaryUnitId, null);

  reset();
  const w3 = world({ primaryUnitId: 'u-ct' });
  const del = await call('DELETE', '/api/products/p1/units/u-ct');
  assert.equal(del.status, 409);
  assert.equal(del.body.code, 'PRIMARY_UNIT_IN_USE');
  assert.equal(opIdx('productUnit.deleteMany'), -1);
  const delOk = await call('DELETE', '/api/products/p1/units/u-ct?clearPrimary=1');
  assert.equal(delOk.status, 200, JSON.stringify(delOk.body));
  assert.equal(w3.units.length, 0);
  assert.equal(w3.product.primaryUnitId, null);

  // وحدةٌ غير رئيسية: كما كان (طابع التعديل وحده)
  reset();
  const w4 = world({ primaryUnitId: 'u-ct', units: [unit({ id: 'u-ct', name: 'كرتون', factor: 24 }), unit({ id: 'u-sh', name: 'شدة', factor: 6 })] });
  assert.equal((await call('DELETE', '/api/products/p1/units/u-sh')).status, 200);
  assert.equal(w4.product.primaryUnitId, 'u-ct');
});

test('كتّاب الوحدات والشرائح: expectedBaseName القديم ⇒ 409 BASE_UNIT_CHANGED بلا كتابة، وD19 لمفتاح API على صنفٍ حُوِّل', async () => {
  const attempts = [
    ['POST', '/api/products/p1/units', { name: 'طبلية', factor: 1200 }],
    ['PUT', '/api/products/p1/units/u-ct', { price: 50 }],
    ['DELETE', '/api/products/p1/units/u-ct', undefined],
    ['PUT', '/api/products/p1/price-tiers', { tiers: [{ minQty: 48, price: 1.9 }] }],
  ] as const;
  const withBase = (url: string, body: any, base: string) => (body === undefined ? [`${url}?expectedBaseName=${encodeURIComponent(base)}`, body] : [url, { ...body, expectedBaseName: base }]);
  for (const [method, url, body] of attempts) {
    reset();
    world();
    const [u, b] = withBase(url, body, 'كرتون');
    const r = await call(method, u, b);
    assert.equal(r.status, 409, `${method} ${url}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'BASE_UNIT_CHANGED');
    assert.ok(!ops().some((o) => /^(productUnit|priceTier)\.(create|updateMany|deleteMany)$/.test(o)), `${method} ${url}: كتابةٌ رغم الرفض`);

    // مفتاح API وصنفٌ حُوِّل بلا الأساس ⇒ 400؛ ومعه ⇒ يمرّ؛ وصنفٌ لم يُحوَّل ⇒ مسار اليوم
    reset({ apiKeyId: 'k1' });
    world({ baseConvertedAt: new Date('2026-10-01T00:00:00Z') });
    const k = await call(method, url, body);
    assert.equal(k.status, 400, `${method} ${url}: ${JSON.stringify(k.body)}`);
    assert.equal(k.body.code, 'BASE_UNIT_REQUIRED');
    reset({ apiKeyId: 'k1' });
    world({ baseConvertedAt: new Date('2026-10-01T00:00:00Z') });
    const [u2, b2] = withBase(url, body, 'قارورة');
    assert.ok([200, 201].includes((await call(method, u2, b2)).status), `${method} ${url} بالأساس الصريح`);
    reset({ apiKeyId: 'k1' });
    world();
    assert.ok([200, 201].includes((await call(method, url, body)).status), `${method} ${url} لصنفٍ لم يُحوَّل`);
    // ولوحة الإدارة على الصنف المحوَّل بلا الحقل ⇒ تمرّ (D19 للمفتاح وحده)
    reset();
    world({ baseConvertedAt: new Date('2026-10-01T00:00:00Z') });
    assert.ok([200, 201].includes((await call(method, url, body)).status), `${method} ${url} من لوحة الإدارة`);
  }
});

test('price-tiers بالرئيسية: expectedPrimary بمعاملٍ قديم أو رئيسيةٍ أخرى ⇒ 409 PRIMARY_UNIT_CHANGED بلا كتابة', async () => {
  for (const expectedPrimary of [{ id: 'u-ct', factor: 12 }, { id: 'u-old', factor: 24 }]) {
    reset();
    world({ primaryUnitId: 'u-ct' });
    const r = await call('PUT', '/api/products/p1/price-tiers', { tiers: [{ minQty: 48, price: 1.9 }], expectedBaseName: 'قارورة', expectedPrimary });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'PRIMARY_UNIT_CHANGED');
    assert.ok(!ops().some((o) => o.startsWith('priceTier.')), 'لا حذف ولا إدراج');
  }
  // الرئيسية أُلغيت بعد فتح النموذج
  reset();
  world({ primaryUnitId: null });
  assert.equal((await call('PUT', '/api/products/p1/price-tiers', { tiers: [], expectedPrimary: { id: 'u-ct', factor: 24 } })).status, 409);
  reset();
  const w = world({ primaryUnitId: 'u-ct' });
  const ok = await call('PUT', '/api/products/p1/price-tiers', { tiers: [{ minQty: 48, price: 1.9 }], expectedBaseName: 'قارورة', expectedPrimary: { id: 'u-ct', factor: 24 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(w.tiers, [{ productId: 'p1', minQty: 48, maxQty: null, price: 1.9, baseMinQty: 48, baseMaxQty: null }]);
});

// ═══ PUT /:id المحروس ═══

test('PUT /:id بلا مسّ الأساس (اسم أو صورة) ⇒ المسار القائم بلا معاملة، وprimaryUnitId في الجسم يُتجاهل', async () => {
  reset();
  world();
  const r = await call('PUT', '/api/products/p1', { name: 'مياه', image: '', primaryUnitId: 'u-zz', expectedBaseName: 'كرتون' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(ops(), ['product.findFirst', 'product.update']);
  const data = calls[1].args.data;
  for (const k of ['primaryUnitId', 'expectedBaseName', 'primaryUnit']) assert.ok(!(k in data), `${k} في بيانات التعديل`);
});

test('PUT /:id بالسعر: FOR NO KEY UPDATE بمهلةٍ محلية تُستعاد، ثم المقارنة ثم الكتابة — في معاملةٍ واحدة', async () => {
  reset();
  const w = world();
  const r = await call('PUT', '/api/products/p1', { basePrice: 2.5, unit: 'قارورة', primaryUnitId: 'u-zz' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const tx = first('$transaction');
  assert.deepEqual(tx.args, { maxWait: 10_000, timeout: 20_000 });
  const save = rawIdx("current_setting('lock_timeout')");
  const set = rawIdx("set_config('lock_timeout'");
  const lock = rawIdx('FOR NO KEY UPDATE');
  const restore = calls.findIndex((c, i) => i > lock && String(c.args?.sql ?? '').includes("set_config('lock_timeout'"));
  const upd = opIdx('product.update');
  assert.ok(save < set && set < lock && lock < restore && restore < upd, ops().join(' → '));
  assert.equal(calls[set].args.values[0], '5s');
  assert.equal(calls[restore].args.values[0], '3s', 'المهلة السابقة تُستعاد');
  assert.ok([lock, upd].every((i) => calls[i].inTx));
  assert.ok(!calls.some((c) => /FOR UPDATE|FOR KEY SHARE/.test(String(c.args?.sql ?? '')) && !/NO KEY UPDATE/.test(String(c.args?.sql))), 'قفل التعديل وحده');
  assert.equal(w.product.basePrice, 2.5);
  assert.ok(!('primaryUnitId' in calls[upd].args.data));
  assert.equal(opIdx('productBaseConversion.create'), -1, 'الاسم نفسه ⇒ لا صفّ سجلّ');
});

test('PUT /:id: الأساس تغيّر بين القراءة والقفل (تحويلٌ متزامن) أو expectedBaseName قديم ⇒ 409 BASE_UNIT_CHANGED بلا كتابة', async () => {
  reset();
  const w = world({ unit: 'كرتون', units: [] });
  const base = rawScript;
  rawScript = (sql, v) => {
    if (sql.includes('FOR NO KEY UPDATE')) w.product.unit = 'قارورة'; // التحويل التزم قبل قفلنا
    return base(sql, v);
  };
  const r = await call('PUT', '/api/products/p1', { basePrice: 48 });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'BASE_UNIT_CHANGED');
  assert.equal(opIdx('product.update'), -1, 'سعر الكرتون لا يُكتب فوق سعر القارورة');

  reset();
  world();
  const stale = await call('PUT', '/api/products/p1', { basePrice: 48, expectedBaseName: 'كرتون' });
  assert.equal(stale.status, 409);
  assert.equal(opIdx('product.update'), -1);
  // اسمٌ أطول من ٦٤ حرفاً يُقارن بمفتاحه (D20-أ): ما يقصّه العميل لا يُرى قديماً
  reset();
  world({ unit: 'ق'.repeat(70), units: [] });
  assert.equal((await call('PUT', '/api/products/p1', { basePrice: 3, expectedBaseName: `${'ق'.repeat(64)}  ` })).status, 200);
});

test('PUT /:id: انشغال القفل خلف تحويلٍ طويل (55P03) أو انقضاء المعاملة (P2028) ⇒ 503 PRODUCT_UNITS_BUSY بلا كتابة', async () => {
  for (const err of [Object.assign(new Error('canceling statement due to lock timeout'), { code: 'P2010', meta: { code: '55P03' } }),
    Object.assign(new Error('Transaction already closed'), { code: 'P2028' })]) {
    reset();
    const w = world();
    const base = rawScript;
    rawScript = (sql, v) => {
      if (sql.includes('FOR NO KEY UPDATE')) throw err;
      return base(sql, v);
    };
    const r = await call('PUT', '/api/products/p1', { basePrice: 3 });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.code, 'PRODUCT_UNITS_BUSY');
    assert.equal(opIdx('product.update'), -1);
    assert.equal(w.product.basePrice, 2);
  }
});

test('PUT /:id (parity-4): انشغالٌ خارج قفل الصنف (P2028 أو تعطّل متبادل عند الكتابة) ليس «وحدات الصنف قيد التحويل» — يمرّ إلى المعالج العام', async () => {
  for (const err of [Object.assign(new Error('Transaction already closed: expired transaction'), { code: 'P2028' }),
    Object.assign(new Error('deadlock detected'), { code: 'P2010', meta: { code: '40P01' } })]) {
    reset();
    world();
    scripted['product.update'] = () => { throw err; };
    const r = await call('PUT', '/api/products/p1', { basePrice: 3 });
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.notEqual(r.body.code, 'PRODUCT_UNITS_BUSY');
  }
});

// convert-base-3: كتّاب الوحدات والشرائح والرئيسية — FOR UPDATE بمهلةٍ محلية تُستعاد وBASE_GUARD_TX، وانتظار القفل ⇒ 503 PRODUCT_UNITS_BUSY
const UNIT_WRITERS = [
  ['PUT', '/api/products/p1/price-tiers', { tiers: [{ minQty: 48, price: 1.9 }] }],
  ['POST', '/api/products/p1/units', { name: 'طبلية', factor: 1200 }],
  ['PUT', '/api/products/p1/units/u-ct', { price: 50 }],
  ['DELETE', '/api/products/p1/units/u-ct', undefined],
  ['PUT', '/api/products/p1/primary-unit', { unitId: 'u-ct' }],
] as const;

test('كتّاب الوحدات والشرائح والرئيسية: مهلة قفلٍ محلية قبل FOR UPDATE تُستعاد بعده، والمعاملة بمهلة BASE_GUARD_TX (I10)', async () => {
  for (const [method, url, body] of UNIT_WRITERS) {
    reset();
    world();
    const r = await call(method, url, body);
    assert.ok([200, 201].includes(r.status), `${method} ${url}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(first('$transaction').args, { maxWait: 10_000, timeout: 20_000 }, `${method} ${url}`);
    const save = rawIdx("current_setting('lock_timeout')");
    const set = rawIdx("set_config('lock_timeout'");
    const lock = rawIdx('FOR UPDATE');
    const restore = calls.findIndex((c, i) => i > lock && String(c.args?.sql ?? '').includes("set_config('lock_timeout'"));
    assert.ok(save >= 0 && save < set && set < lock && lock < restore, `${method} ${url}: ${ops().join(' → ')}`);
    assert.equal(calls[set].args.values[0], '5s');
    assert.equal(calls[restore].args.values[0], '3s', 'المهلة السابقة تُستعاد');
  }
});

test('كتّاب الوحدات والشرائح والرئيسية: انتظار القفل خلف تحويلٍ طويل (55P03، أو P2028 عنده) ⇒ 503 PRODUCT_UNITS_BUSY بلا كتابة — لا 500', async () => {
  for (const [method, url, body] of UNIT_WRITERS) {
    for (const err of [Object.assign(new Error('canceling statement due to lock timeout'), { code: 'P2010', meta: { code: '55P03' } }),
      Object.assign(new Error('Transaction already closed'), { code: 'P2028' })]) {
      reset();
      world();
      const base = rawScript;
      rawScript = (sql, v) => {
        if (sql.includes('FOR UPDATE')) throw err;
        return base(sql, v);
      };
      const r = await call(method, url, body);
      assert.equal(r.status, 503, `${method} ${url}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'PRODUCT_UNITS_BUSY');
      assert.ok(!ops().some((o) => /^(productUnit|priceTier|product)\.(create|update|updateMany|deleteMany)$/.test(o)), `${method} ${url}: كتابةٌ رغم الانشغال`);
    }
  }
});

test('PUT /:id: رقعة الرئيسية ذرّية مع الصنف، والرئيسية التي تغيّرت ⇒ 409 PRIMARY_UNIT_CHANGED بلا كتابة', async () => {
  reset();
  const w = world({ primaryUnitId: 'u-ct' });
  const r = await call('PUT', '/api/products/p1', { basePrice: 2.5, expectedBaseName: 'قارورة', primaryUnit: { id: 'u-ct', name: 'كرتونة', factor: 12, price: 30, unitCode: 'CT' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const patch = first('productUnit.updateMany');
  const upd = first('product.update');
  assert.ok(patch.inTx && upd.inTx && calls.indexOf(patch) < calls.indexOf(upd), 'الرقعة والصنف في معاملة القفل نفسها');
  assert.deepEqual(patch.args, { where: { id: 'u-ct', productId: 'p1', tenantId: TENANT }, data: { name: 'كرتونة', factor: 12, price: 30, unitCode: 'CT' } });
  assert.deepEqual({ name: w.units[0].name, factor: w.units[0].factor, price: w.units[0].price }, { name: 'كرتونة', factor: 12, price: 30 });
  assert.equal(w.product.basePrice, 2.5);

  for (const [primaryUnitId, patchBody, status, code] of [
    [null, { id: 'u-ct', price: 30 }, 409, 'PRIMARY_UNIT_CHANGED'],
    ['u-ct', { id: 'u-gone', price: 30 }, 409, 'PRIMARY_UNIT_CHANGED'],
    ['u-ct', { id: 'u-ct', factor: 1 }, 400, 'PRODUCT_UNITS_INVALID'],
  ] as const) {
    reset();
    world({ primaryUnitId });
    const bad = await call('PUT', '/api/products/p1', { basePrice: 2.5, primaryUnit: patchBody });
    assert.equal(bad.status, status, JSON.stringify(bad.body));
    assert.equal(bad.body.code, code);
    assert.equal(opIdx('productUnit.updateMany'), -1);
    assert.equal(opIdx('product.update'), -1);
  }

  // الرقعة وحدها (بلا سعر ولا اسم أساس) تمسّ الأساس أيضاً: تمرّ بالقفل والحارس، لا بالمسار القائم الذي يُسقطها صامتةً
  reset();
  const solo = world({ primaryUnitId: 'u-ct' });
  const r2 = await call('PUT', '/api/products/p1', { name: 'ماء ٣٣٠', primaryUnit: { id: 'u-ct', price: 36 } });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.ok(rawIdx('FOR NO KEY UPDATE') >= 0 && calls[rawIdx('FOR NO KEY UPDATE')].inTx, 'قفل التعديل');
  assert.deepEqual(first('productUnit.updateMany').args.data, { price: 36 });
  assert.equal(solo.units[0].price, 36);
  reset();
  world({ primaryUnitId: null });
  const stale = await call('PUT', '/api/products/p1', { primaryUnit: { id: 'u-ct', price: 36 } });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'PRIMARY_UNIT_CHANGED');
  assert.equal(opIdx('product.update'), -1);
});

test('PUT /:id: إعادة تسمية الأساس تكتب صفّ سجلٍّ بمعامل ١ في المعاملة نفسها — وbaseConvertedAt كما هو', async () => {
  reset({ id: 'admin-9', impersonated: true });
  const w = world({ units: [] });
  const r = await call('PUT', '/api/products/p1', { unit: 'عبوة', expectedBaseName: 'قارورة' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const log = first('productBaseConversion.create');
  assert.ok(log.inTx && calls.indexOf(log) < opIdx('product.update'));
  assert.deepEqual(log.args.data, { tenantId: TENANT, productId: 'p1', fromUnit: 'قارورة', toUnit: 'عبوة', factor: 1, fromUnitId: null, convertedBy: 'OWNER:admin-9' });
  assert.equal(w.product.unit, 'عبوة');
  assert.equal(w.product.baseConvertedAt, null);
  assert.equal(opIdx('productBaseConversion.findMany'), -1, 'صنفٌ لم يُحوَّل ⇒ لا سؤال للسجلّ (I8)');
  // اسم وحدةٍ للصنف ⇒ 400 قبل أي كتابة
  reset();
  world();
  const clash = await call('PUT', '/api/products/p1', { unit: 'كرتون' });
  assert.equal(clash.status, 400);
  assert.equal(opIdx('product.update'), -1);
});

test('D20-ب: تسمية الأساس باسمٍ كان أساس الصنف قبل تحويله ⇒ 409 BASE_NAME_RETIRED بلا كتابة', async () => {
  // تحويلٌ (كرتون ⇒ قارورة)، ثم حُذفت وحدة الكرتون، ثم محاولة تسمية الأساس «كرتون»
  reset();
  const w = world({ units: [], baseConvertedAt: new Date('2026-10-01T00:00:00Z'), conversions: [{ fromUnit: ' كرتون', toUnit: 'قارورة', factor: 24 }] });
  const r = await call('PUT', '/api/products/p1', { unit: 'كرتون ', expectedBaseName: 'قارورة' });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'BASE_NAME_RETIRED');
  assert.match(r.body.message, /كان وحدة هذا الصنف قبل تحويله/);
  assert.equal(opIdx('product.update'), -1);
  assert.equal(opIdx('productBaseConversion.create'), -1);
  assert.equal(w.product.unit, 'قارورة');
  // إعادة تسمية بمعامل ١ لا تُقاعد اسماً
  reset();
  world({ units: [], baseConvertedAt: new Date('2026-10-01T00:00:00Z'), conversions: [{ fromUnit: 'عبوة', toUnit: 'قارورة', factor: 1 }] });
  assert.equal((await call('PUT', '/api/products/p1', { unit: 'عبوة' })).status, 200);
});

test('D19: مفتاح API يكتب السعر وحده على صنفٍ حُوِّل ⇒ 400 BASE_UNIT_REQUIRED بلا كتابة؛ لوحة الإدارة وصنفٌ لم يُحوَّل ⇒ يمرّ', async () => {
  reset({ apiKeyId: 'k1' });
  world({ baseConvertedAt: new Date('2026-10-01T00:00:00Z') });
  const r = await call('PUT', '/api/products/p1', { basePrice: 48 });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, 'BASE_UNIT_REQUIRED');
  assert.equal(opIdx('product.update'), -1);
  reset({ apiKeyId: 'k1' });
  world({ baseConvertedAt: new Date('2026-10-01T00:00:00Z') });
  assert.equal((await call('PUT', '/api/products/p1', { basePrice: 2.1, expectedBaseName: 'قارورة' })).status, 200);
  reset();
  world({ baseConvertedAt: new Date('2026-10-01T00:00:00Z') });
  assert.equal((await call('PUT', '/api/products/p1', { basePrice: 2.1 })).status, 200);
  reset({ apiKeyId: 'k1' });
  world();
  assert.equal((await call('PUT', '/api/products/p1', { basePrice: 2.1 })).status, 200);
});

test('مسار «تتبّع اللوط» مع الرقعة في طلبٍ واحد: الحارس على صفّ FOR UPDATE نفسه قبل الكتابة، في معاملةٍ واحدة', async () => {
  reset();
  const w = world({ primaryUnitId: 'u-ct', lots: true });
  const r = await call('PUT', '/api/products/p1', { lotTracked: true, basePrice: 2.5, expectedBaseName: 'قارورة', primaryUnit: { id: 'u-ct', price: 60 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(calls.filter((c) => c.op === '$transaction').length, 1);
  const lockRow = rawIdx('"primaryUnitId", "baseConvertedAt" FROM products WHERE id = ? AND "tenantId" = ? FOR UPDATE');
  const patch = opIdx('productUnit.updateMany');
  const upd = opIdx('product.update');
  const ev = opIdx('lotEvent.create');
  assert.ok(lockRow >= 0 && lockRow < patch && patch < upd && upd < ev, ops().join(' → '));
  assert.equal(rawIdx('FOR NO KEY UPDATE'), -1, 'قفل اللوط يغني عن قفل التعديل');
  assert.equal(w.units[0].price, 60);
  assert.equal(w.product.lotTracked, true);

  reset();
  world({ primaryUnitId: 'u-ct', lots: true });
  const stale = await call('PUT', '/api/products/p1', { lotTracked: true, basePrice: 48, expectedBaseName: 'كرتون' });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'BASE_UNIT_CHANGED');
  assert.equal(opIdx('product.update'), -1);
  assert.equal(opIdx('lotEvent.create'), -1);
});

// ═══ أسعار العميل ═══

test('GET /customer-prices/:id يردّ unit وbaseConvertedAt (أساس الصنف ولحظة تحويله) لكل صفّ — من جملةٍ واحدة مع السعر (rep-offline-3)', async () => {
  reset();
  const T_CONV = new Date('2026-10-30T10:00:00.000Z');
  let seen: { sql: string; values: unknown[] } | null = null;
  rawScript = (sql, values) => {
    if (!sql.includes('FROM customer_prices')) return undefined;
    seen = { sql, values };
    return [{ productId: 'p1', price: 1.75, unit: 'قارورة', baseConvertedAt: T_CONV }, { productId: 'p2', price: 9, unit: 'حبة', baseConvertedAt: null }];
  };
  const r = await call('GET', '/api/products/customer-prices/c1');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, [
    { productId: 'p1', price: 1.75, unit: 'قارورة', baseConvertedAt: T_CONV.toISOString() },
    { productId: 'p2', price: 9, unit: 'حبة', baseConvertedAt: null },
  ]);
  // السعر والأساس ولحظة التحويل من جملةٍ واحدة (لقطةٌ واحدة): لا findMany بعلاقةٍ متداخلة تقرأ الصنف في استعلامٍ ثانٍ
  assert.ok(seen, 'لا جملة أسعار');
  assert.match(seen!.sql, /SELECT cp\."productId", cp\.price, p\.unit, p\."baseConvertedAt" FROM customer_prices cp JOIN products p ON p\.id = cp\."productId"/);
  // الشروط كما كانت: العميل، وشركة الصنف، والصنف غير المؤرشف
  assert.match(seen!.sql, /WHERE cp\."customerId" = \? AND p\."tenantId" = \? AND p\."deletedAt" IS NULL$/);
  assert.deepEqual(seen!.values, ['c1', TENANT]);
  assert.equal(opIdx('customerPrice.findMany'), -1);
});
