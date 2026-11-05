// مراجعة مخزون الشركة (S4/D4 وS6) ومراجعة المخزون (البند ٢/D7) — مسارات الأصناف عبر الموجّه الحقيقي بعميل Prisma مزيّف (بلا قاعدة):
//   • الاسم المكرَّر تحذيرٌ لا رفض: services/productNames.ts، وGET /name-check، وwarnings في ردّ الإنشاء وإعادة التسمية.
//   • GET /:id/stock-summary: رصيد الصنف قبل حذفه — المستودع (null والميزة مطفأة) والسيارات بالأساس.
//   • 409 BASE_NAME_RESERVED: اسم أساسٍ سابق (ومنه صفّ إعادة التسمية بمعامل ١) لا يُضاف وحدةً أكبر لصنفٍ له تاريخ.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { duplicateNameWarnings, importDuplicateNameWarnings, productNameKey } from '../services/productNames';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Call = { op: string; args: any };
let calls: Call[] = [];
let scripted: Record<string, (args: any) => unknown> = {};

function defaultFor(method: string): unknown {
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (method === 'updateMany' || method === 'deleteMany' || method === 'createMany') return { count: 0 };
  return null;
}
const prismaFake: any = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (arg: unknown) => {
        calls.push({ op: '$transaction', args: null });
        if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
        return (arg as (tx: unknown) => Promise<unknown>)(prismaFake);
      };
    }
    if (key === '$queryRaw' || key === '$executeRaw') {
      return async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ op: key, args: { sql: strings.join('?').replace(/\s+/g, ' ').trim(), values } });
        return key === '$queryRaw' ? [] : 0;
      };
    }
    if (key === 'then') return undefined;
    return new Proxy({}, {
      get: (_m, method: string) => async (args: unknown) => {
        calls.push({ op: `${key}.${method}`, args });
        const fn = scripted[`${key}.${method}`];
        return fn ? fn(args) : defaultFor(method);
      },
    });
  },
});

const TENANT = 'T1';
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();
stub('config/database', { default: prismaFake });
stub('services/customerScope', { canAccessCustomer: async () => true });
stub('middleware/auth', {
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT }; next(); },
  requireAdmin: pass, requireAccounting: pass, requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
  isOwnerSession: () => false,
  actorOf: (req: { user?: { id?: string } }) => req.user?.id ?? '',
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
function reset(): void { calls = []; scripted = {}; }

const ARCHIVED_AT = new Date('2026-09-01T00:00:00.000Z');
/** أصناف الشركة كما يقرؤها البحث عن الاسم (المرشّح contains يُحاكى هنا بلا حالة أحرف) */
const CATALOG = [
  { id: 'p-old', code: 'EGG-M', name: 'كرتون بيض M', status: 'ACTIVE', deletedAt: null },
  { id: 'p-arch', code: 'EGG-M2', name: '  كرتون   بيض m ', status: 'INACTIVE', deletedAt: ARCHIVED_AT },
  { id: 'p-near', code: 'EGG-L', name: 'كرتون بيض L', status: 'ACTIVE', deletedAt: null },
];
const nameRows = (a: { where: { name?: { contains?: string }; id?: { not?: string } } }) => CATALOG
  .filter((p) => p.name.toLowerCase().includes(String(a.where.name?.contains ?? '').toLowerCase()))
  .filter((p) => !a.where.id?.not || p.id !== a.where.id.not);

// ═══ التطبيع والتحذيرات (نقيّة) ═══

test('D4: مفتاح الاسم — قصٌّ ودمج مسافات وحالة الأحرف اللاتينية، بلا تطبيعٍ للعربية', () => {
  assert.equal(productNameKey('  كرتون   بيض M '), 'كرتون بيض m');
  assert.equal(productNameKey('كرتون بيض m'), productNameKey('كرتون بيض M'));
  assert.notEqual(productNameKey('مياة'), productNameKey('مياه'), 'التاء المربوطة كما هي');
  assert.equal(productNameKey(null), '');
  assert.deepEqual(duplicateNameWarnings([]), []);
});

test('D4: تحذيرات الاستيراد — صنفٌ قائم أو مؤرشف بالاسم، وصفٌّ قبله في الملف بكودٍ آخر، والكود نفسه ليس تكراراً', () => {
  const w = importDuplicateNameWarnings([
    { row: 2, r: { code: 'NEW1', name: 'كرتون بيض m' } },
    { row: 3, r: { code: 'NEW2', name: 'ماء' } },
    { row: 4, r: { code: 'NEW3', name: ' ماء ' } },
    { row: 5, r: { code: 'EGG-M', name: 'كرتون بيض M' } },
  ], CATALOG);
  assert.deepEqual(w.map((x) => [x.row, x.matches.map((m) => m.code)]), [
    [2, ['EGG-M', 'EGG-M2']],
    [4, ['NEW2']],
    [5, ['EGG-M2', 'NEW1']],
  ]);
  assert.deepEqual(w[0].matches[1], { id: 'p-arch', code: 'EGG-M2', name: '  كرتون   بيض m ', status: 'INACTIVE', archived: true });
  assert.deepEqual(w[1].matches[0], { id: null, code: 'NEW2', name: 'ماء', status: 'ACTIVE', archived: false, row: 3 });
  assert.equal(w[0].code, 'DUPLICATE_NAME');
});

// ═══ GET /name-check والإنشاء وإعادة التسمية ═══

test('D4: GET /name-check — المطابق بعد التطبيع ومنه المؤرشف والموقوف، بلا الصنف المستثنى، ونطاق الشركة', async () => {
  reset();
  scripted['product.findMany'] = nameRows;
  const r = await call('GET', `/api/products/name-check?name=${encodeURIComponent('كرتون بيض m')}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.matches.map((m: { code: string; archived: boolean; status: string }) => [m.code, m.archived, m.status]),
    [['EGG-M', false, 'ACTIVE'], ['EGG-M2', true, 'INACTIVE']]);
  const where = calls.find((c) => c.op === 'product.findMany')!.args.where;
  assert.equal(where.tenantId, TENANT);
  assert.deepEqual(where.name, { contains: 'كرتون', mode: 'insensitive' });
  reset();
  scripted['product.findMany'] = nameRows;
  const ex = await call('GET', `/api/products/name-check?name=${encodeURIComponent('كرتون بيض M')}&excludeId=p-old`);
  assert.deepEqual(ex.body.data.matches.map((m: { id: string }) => m.id), ['p-arch']);
  reset();
  const empty = await call('GET', '/api/products/name-check?name=%20%20');
  assert.deepEqual([empty.status, empty.body.data.matches], [200, []]);
  assert.deepEqual(ops(), [], 'اسمٌ فارغ بلا استعلام');
});

test('D4: الإنشاء باسمٍ مكرَّر يُنشئ ويحذّر (201 + warnings)، وبلا تكرارٍ الردّ بلا مفتاح warnings', async () => {
  reset();
  scripted['product.findMany'] = nameRows;
  scripted['product.create'] = (a) => ({ id: 'p-new', ...a.data });
  const body = { code: 'EGG-M3', name: 'كرتون بيض M', unit: 'حبة', basePrice: 5, taxPct: 15 };
  const r = await call('POST', '/api/products', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.id, 'p-new');
  assert.deepEqual(r.body.warnings.map((w: { code: string; matches: { code: string }[] }) => [w.code, w.matches.map((m) => m.code)]),
    [['DUPLICATE_NAME', ['EGG-M', 'EGG-M2']]]);
  reset();
  scripted['product.create'] = (a) => ({ id: 'p-new', ...a.data });
  const clean = await call('POST', '/api/products', { ...body, name: 'صنف جديد تماماً' });
  assert.equal(clean.status, 201);
  assert.ok(!('warnings' in clean.body), 'الردّ كما كان');
});

test('D4: إعادة التسمية باسم صنفٍ آخر تحذّر بلا رفض (ولا تطابق الصنف نفسه)، وبلا تغيير الاسم لا بحث', async () => {
  reset();
  const exists = { id: 'p-near', name: 'كرتون بيض L', unit: 'حبة', units: [], lotTracked: false, shelfLifeEnabled: false, returnRuleEnabled: false };
  scripted['product.findFirst'] = () => exists;
  scripted['product.findMany'] = nameRows;
  scripted['product.update'] = (a) => ({ ...exists, ...a.data });
  const r = await call('PUT', '/api/products/p-near', { name: 'كرتون بيض M' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.warnings[0].matches.map((m: { id: string }) => m.id), ['p-old', 'p-arch']);
  assert.equal(calls.find((c) => c.op === 'product.findMany')!.args.where.id.not, 'p-near');
  reset();
  scripted['product.findFirst'] = () => exists;
  scripted['product.update'] = (a) => ({ ...exists, ...a.data });
  const same = await call('PUT', '/api/products/p-near', { name: ' كرتون  بيض l ', basePrice: 7 });
  assert.equal(same.status, 200);
  assert.ok(!ops().includes('product.findMany'), 'الاسم نفسه بعد التطبيع: لا بحث');
  assert.ok(!('warnings' in same.body));
});

// ═══ S6: GET /:id/stock-summary ═══

const D = new Date('2026-11-01T08:00:00.000Z');
test('S6: رصيد الصنف — المستودع بعد التحميل والإعادة، والسيارات متاحاً ومنتهياً وتالفاً بالأساس', async () => {
  reset();
  scripted['product.findFirst'] = () => ({ id: 'p1', name: 'ماء', code: 'W1', unit: 'حبة', primaryUnitId: 'u-ct', units: [{ id: 'u-ct', name: 'كرتون', factor: 24, isActive: true }] });
  scripted['tenant.findUnique'] = () => ({ warehouseEnabled: true });
  scripted['warehouseEntryItem.findMany'] = () => [
    { qty: 10, unitFactor: 24, baseQty: 240, entry: { type: 'RECEIVE' } },
    { qty: -5, unitFactor: null, baseQty: null, entry: { type: 'ADJUST' } },
  ];
  scripted['vanLoadItem.findMany'] = () => [
    { productId: 'p1', qty: 2, unitFactor: 24, baseQty: 48, vanLoad: { type: 'LOAD', createdAt: D } },
    { productId: 'p1', qty: 8, unitFactor: null, baseQty: null, vanLoad: { type: 'UNLOAD', createdAt: D } },
    { productId: 'p1', qty: 1, unitFactor: null, baseQty: null, vanLoad: { type: 'EXPIRED_OUT', createdAt: D } },
  ];
  scripted['invoiceItem.findMany'] = () => [
    { productId: 'p1', qty: 10, unitFactor: null, baseQty: null, returnExpired: null, invoice: { type: 'CASH', returnToStock: null, invoiceDate: D, returnReason: null, createdAt: D } },
    { productId: 'p1', qty: 3, unitFactor: null, baseQty: null, returnExpired: true, invoice: { type: 'RETURN', returnToStock: true, invoiceDate: D, returnReason: null, createdAt: D } },
  ];
  const r = await call('GET', '/api/products/p1/stock-summary');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // المستودع: ٢٤٠ − ٥ − ٤٨ (تحميل) + ٨ (تنزيل) = ١٩٥؛ والسيارة: ٤٨ − ٨ − ١٠ = ٣٠ متاحاً، ومنتهٍ ٣ − ١ = ٢
  assert.deepEqual(
    { w: r.body.data.warehouseBase, v: r.body.data.vansBase, s: r.body.data.vansSellableBase, unit: r.body.data.unit, primary: r.body.data.primaryUnitId },
    { w: 195, v: 32, s: 30, unit: 'حبة', primary: 'u-ct' });
  assert.equal(r.body.data.units.length, 1);
  for (const c of calls.filter((x) => x.op.endsWith('.findMany'))) {
    const w = c.args.where;
    assert.equal(w.productId, 'p1');
    assert.ok(JSON.stringify(w).includes(TENANT), `${c.op} بلا نطاق الشركة`);
  }
});

test('S6: مخزون الشركة مطفأ ⇒ warehouseBase = null بلا قراءة حركاته، والصنف الغريب 404', async () => {
  reset();
  scripted['product.findFirst'] = () => ({ id: 'p1', name: 'ماء', code: 'W1', unit: 'حبة', primaryUnitId: null, units: [] });
  scripted['tenant.findUnique'] = () => ({ warehouseEnabled: false });
  const r = await call('GET', '/api/products/p1/stock-summary');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.data.warehouseBase, r.body.data.vansBase], [null, 0]);
  assert.ok(!ops().includes('warehouseEntryItem.findMany'));
  reset();
  const missing = await call('GET', '/api/products/zz/stock-summary');
  assert.equal(missing.status, 404);
  assert.equal(calls[0].args.where.tenantId, TENANT);
});

test('S6 (المراجعة F4): بلا صلاحية «مخزون السيارات» لا أرقام (null وstockHidden) ولا قراءة حركات — والمقيَّد يرى سيارات نطاقه وحدها', async () => {
  reset();
  scripted['product.findFirst'] = () => ({ id: 'p1', name: 'ماء', code: 'W1', unit: 'حبة', primaryUnitId: null, units: [] });
  scripted['admin.findUnique'] = (a) => (a?.select?.canManageVanStock ? { canManageVanStock: false } : null);
  const hidden = await call('GET', '/api/products/p1/stock-summary');
  assert.equal(hidden.status, 200);
  assert.deepEqual([hidden.body.data.warehouseBase, hidden.body.data.vansBase, hidden.body.data.vansSellableBase, hidden.body.data.stockHidden], [null, null, null, true]);
  assert.equal(hidden.body.data.unit, 'حبة');
  assert.ok(!ops().some((o) => o === 'vanLoadItem.findMany' || o === 'invoiceItem.findMany' || o === 'warehouseEntryItem.findMany'), 'لا قراءة مخزون');

  // مقيَّد بقائمة مناديب (LISTS): حركات سيارة R1 وحدها في السيارات، والمستودع بكل الحركات
  reset();
  scripted['product.findFirst'] = () => ({ id: 'p1', name: 'ماء', code: 'W1', unit: 'حبة', primaryUnitId: null, units: [] });
  scripted['admin.findUnique'] = (a) => (a?.select?.scopeEnabled ? { scopeEnabled: true, scopeMode: 'LISTS' } : { canManageVanStock: true });
  scripted['salesRep.findMany'] = () => [{ id: 'R1' }];
  scripted['tenant.findUnique'] = () => ({ warehouseEnabled: true });
  scripted['warehouseEntryItem.findMany'] = () => [{ qty: 100, unitFactor: null, baseQty: null, entry: { type: 'RECEIVE' } }];
  scripted['vanLoadItem.findMany'] = () => [
    { productId: 'p1', qty: 10, unitFactor: null, baseQty: null, vanLoad: { type: 'LOAD', createdAt: D, salesRepId: 'R1' } },
    { productId: 'p1', qty: 20, unitFactor: null, baseQty: null, vanLoad: { type: 'LOAD', createdAt: D, salesRepId: 'R2' } },
    { productId: 'p1', qty: 5, unitFactor: null, baseQty: null, vanLoad: { type: 'LOAD', createdAt: D, salesRepId: null } },
  ];
  const scoped = await call('GET', '/api/products/p1/stock-summary');
  assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
  assert.deepEqual([scoped.body.data.warehouseBase, scoped.body.data.vansBase], [65, 10]);
  const inv = calls.find((c) => c.op === 'invoiceItem.findMany');
  assert.deepEqual(inv?.args.where.invoice.salesRepId, { in: ['R1'] }, 'فواتير مناديب النطاق وحدها');
});

// ═══ D7: 409 BASE_NAME_RESERVED ═══

/** صنفٌ أساسه «حبة» بعد إعادة تسمية «كرتون» (صفّ سجلّ بمعامل ١) أو بعد تحويلٍ حقيقي ×٢٤ */
function unitsWorld(o: { conversions: Array<{ fromUnit: string; toUnit: string; factor: number }>; history: boolean }): void {
  reset();
  scripted['product.findFirst'] = () => ({
    id: 'p1', unit: 'حبة', basePrice: 1, unitCode: null, lotTracked: false, lotTrackedSince: null, primaryUnitId: null,
    baseConvertedAt: null, units: [], repSaleUnit: null, repReturnUnit: null,
  });
  scripted['productBaseConversion.findMany'] = () => o.conversions.map((c, i) => ({ ...c, fromUnitId: null, convertedAt: new Date(Date.UTC(2026, 9, 1 + i)) }));
  scripted['invoiceItem.findFirst'] = () => (o.history ? { id: 'ii1' } : null);
  scripted['productUnit.create'] = (a) => ({ id: 'u-new', ...a.data });
}

test('D7: «كرتون» أُعيدت تسميته «حبة» ثم يُضاف «كرتون = ٢٤» لصنفٍ له تاريخ ⇒ 409 BASE_NAME_RESERVED بلا كتابة', async () => {
  unitsWorld({ conversions: [{ fromUnit: 'كرتون', toUnit: 'حبة', factor: 1 }], history: true });
  const r = await call('POST', '/api/products/p1/units', { name: ' كرتون ', factor: 24 });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'BASE_NAME_RESERVED');
  assert.match(r.body.message, /«كرتون» كان وحدة أساس هذا الصنف/);
  assert.match(r.body.message, /إضافة وحدة فرعية أصغر/);
  assert.ok(!ops().includes('productUnit.create'));
});

test('D7: المسموح — صنفٌ بلا أثر، أو وحدةٌ بمعامل سلسلة التحويل الحقيقي نفسه، أو اسمٌ لم يكن أساساً، أو معامل ١', async () => {
  unitsWorld({ conversions: [{ fromUnit: 'كرتون', toUnit: 'حبة', factor: 1 }], history: false });
  assert.equal((await call('POST', '/api/products/p1/units', { name: 'كرتون', factor: 24 })).status, 201, 'لا رصيد يُقلب');
  unitsWorld({ conversions: [{ fromUnit: 'كرتون', toUnit: 'حبة', factor: 24 }], history: true });
  assert.equal((await call('POST', '/api/products/p1/units', { name: 'كرتون', factor: 24 })).status, 201, 'كرتونٌ حُوّل حقاً ثم أُعيد بمعامله');
  unitsWorld({ conversions: [{ fromUnit: 'كرتون', toUnit: 'حبة', factor: 24 }], history: true });
  assert.equal((await call('POST', '/api/products/p1/units', { name: 'كرتون', factor: 12 })).status, 409, 'بمعاملٍ غير معامل السلسلة');
  unitsWorld({ conversions: [{ fromUnit: 'كرتون', toUnit: 'حبة', factor: 1 }], history: true });
  assert.equal((await call('POST', '/api/products/p1/units', { name: 'شدة', factor: 6 })).status, 201);
});
