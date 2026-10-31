// الوحدات المتعددة في المخزون والتكلفة — المعالجات الحقيقية فوق Prisma مزيّف في الذاكرة.
//
// ما يُحرس هنا تشغيلاً لا نصّاً: الخادم يحلّ وحدة كل بندٍ من معرّفها ويكتب لقطتها وكميته بالأساس (تحميل السيارة
// ووارد المستودع وطلب البضاعة)، وكل رصيدٍ ومقارنة بالأساس (مخزون السيارة، وإزالة التالف، والمستودع وتكلفته، ودفعة
// التحميل التي تُحسب منها الصلاحية). وصنفٌ بلا وحدات يبقى مساره كما كان حرفياً: بلا استعلامٍ عن الوحدات أصلاً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ───────────── Prisma مزيّف ─────────────
type Row = Record<string, any>;
const T = 'T1';
const day = (d: number, h = 10) => new Date(Date.UTC(2026, 9, d, h));
const AFTER_DAMAGED = new Date('2026-10-20T10:00:00.000Z'); // بعد DAMAGED_VAN_SINCE

const PRODUCTS: Row[] = [
  { id: 'P1', tenantId: T, name: 'ماء', code: 'W', unit: 'حبة', taxPct: 15, status: 'ACTIVE', deletedAt: null },
  { id: 'P2', tenantId: T, name: 'عصير', code: 'J', unit: 'علبة', taxPct: 15, status: 'ACTIVE', deletedAt: null },
];
const UNITS: Row[] = [
  { id: 'U-CT', tenantId: T, productId: 'P1', name: 'كرتون', factor: 24, isActive: true, sortOrder: 0 },
  { id: 'U-OFF', tenantId: T, productId: 'P1', name: 'شدّة', factor: 6, isActive: false, sortOrder: 1 },
  { id: 'U-P2', tenantId: T, productId: 'P2', name: 'كرتون', factor: 12, isActive: true, sortOrder: 0 },
  { id: 'U-X', tenantId: 'OTHER', productId: 'P1', name: 'كرتون', factor: 48, isActive: true, sortOrder: 0 },
];

let st: {
  loadItems: Row[]; invItems: Row[]; whItems: Row[]; unitQueries: Row[];
  createdLoads: Row[]; createdEntries: Row[]; requests: Row[];
};
const reset = () => { st = { loadItems: [], invItems: [], whItems: [], unitQueries: [], createdLoads: [], createdEntries: [], requests: [] }; };
reset();

const inIds = (v: any, x: unknown) => {
  if (v === undefined) return true;
  if (v && typeof v === 'object' && 'in' in v) return (v.in as unknown[]).includes(x);
  if (v && typeof v === 'object' && 'not' in v) return x !== v.not;
  return v === x;
};
const dateOk = (w: any, d: Date) => !w || ((!w.lte || d <= w.lte) && (!w.lt || d < w.lt) && (!w.gte || d >= w.gte));
const sumOf = (rows: Row[], fields: Row) => Object.fromEntries(Object.keys(fields).map((k) => {
  const vals = rows.map((r) => r[k]).filter((v) => v != null);
  return [k, vals.length ? vals.reduce((s: number, v: number) => s + v, 0) : null];
}));
// صفٌّ يُكتب: كما يفعل مُطلِق القاعدة (scripts/backfillBaseQty) — baseQty = qty × unitFactor
const withTrigger = (r: Row): Row => ({ unitFactor: 1, unitName: null, ...r, baseQty: r.qty * (r.unitFactor || 1) });

const loadMatch = (r: Row, w: Row = {}) => inIds(w.productId, r.productId)
  && (!w.vanLoad?.type || w.vanLoad.type === r.vanLoad.type)
  && (!w.vanLoad?.salesRepId || w.vanLoad.salesRepId === r.vanLoad.salesRepId)
  && dateOk(w.vanLoad?.createdAt, r.vanLoad.createdAt);
const invMatch = (r: Row, w: Row = {}) => inIds(w.productId, r.productId)
  && (!w.invoice?.salesRepId || w.invoice.salesRepId === r.invoice.salesRepId)
  && (!w.invoice?.type?.not || w.invoice.type.not !== r.invoice.type)
  && (!w.invoice?.id?.not || w.invoice.id.not !== r.invoiceId)
  && dateOk(w.invoice?.invoiceDate, r.invoice.invoiceDate);

const db: Row = {
  admin: { async findUnique() { return { scopeEnabled: false }; } },
  glSettings: { async findUnique() { return null; } },
  companySettings: { async findUnique() { return { currency: 'SAR', countryCode: 'SA' }; } },
  salesRep: {
    async findFirst(a: Row) {
      return a.where.id === 'R1' ? { id: 'R1', name: 'أحمد', tenantId: T, canManageVanStock: true, locationId: null, tenant: { locationsEnabled: false } } : null;
    },
  },
  product: {
    async count(a: Row) { return PRODUCTS.filter((p) => inIds(a.where.id, p.id) && p.tenantId === a.where.tenantId).length; },
    async findMany(a: Row) {
      return PRODUCTS.filter((p) => inIds(a.where?.id, p.id)).map((p) => ({
        ...p, ...(a.select?.units && { units: UNITS.filter((u) => u.productId === p.id && u.tenantId === T).map(({ id, name, factor, isActive }) => ({ id, name, factor, isActive })) }),
      }));
    },
  },
  productUnit: {
    async findMany(a: Row) {
      st.unitQueries.push(a.where);
      return UNITS.filter((u) => u.tenantId === a.where.tenantId && inIds(a.where.id, u.id) && inIds(a.where.productId, u.productId))
        .map((u) => ({ id: u.id, productId: u.productId, name: u.name, factor: u.factor, isActive: u.isActive }));
    },
  },
  vanLoad: {
    async create(a: Row) {
      const items = (a.data.items.create as Row[]).map(withTrigger);
      st.createdLoads.push({ ...a.data, items });
      for (const it of items) st.loadItems.push({ ...it, vanLoad: { type: a.data.type, createdAt: new Date(), salesRepId: a.data.salesRepId } });
      return { id: 'VNEW', ...a.data, items };
    },
  },
  vanLoadItem: {
    async findMany(a: Row) { return st.loadItems.filter((r) => loadMatch(r, a.where)); },
    async aggregate(a: Row) { return { _sum: sumOf(st.loadItems.filter((r) => loadMatch(r, a.where)), a._sum) }; },
  },
  invoiceItem: {
    async findMany(a: Row) { return st.invItems.filter((r) => invMatch(r, a.where)); },
    async aggregate(a: Row) { return { _sum: sumOf(st.invItems.filter((r) => invMatch(r, a.where)), a._sum) }; },
  },
  warehouseEntry: {
    async create(a: Row) {
      const items = (a.data.items.create as Row[]).map(withTrigger);
      st.createdEntries.push({ ...a.data, items });
      for (const it of items) st.whItems.push({ ...it, entry: { type: a.data.type, createdAt: new Date() } });
      return { id: 'ENEW', ...a.data, items };
    },
  },
  warehouseEntryItem: { async findMany() { return st.whItems; } },
  repStockRequest: {
    async findFirst() { return null; },
    async create(a: Row) {
      const items = (a.data.items.create as Row[]).map(withTrigger)
        .map((i) => ({ ...i, product: { ...PRODUCTS.find((p) => p.id === i.productId)!, units: [] } }));
      const r = { id: 'Q1', status: 'PENDING', note: a.data.note, createdAt: new Date(), updatedAt: new Date(), decidedAt: null, sentRef: null, items };
      st.requests.push(r);
      return r;
    },
  },
};
db.$transaction = async (fn: (tx: Row) => Promise<unknown>) => fn(db);
db.$executeRaw = async () => 0;
stub('config/database', { default: db });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vanRouter = (require('../routes/vanStock') as typeof import('../routes/vanStock')).default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const warehouseRouter = (require('../routes/warehouse') as typeof import('../routes/warehouse')).default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const requestsRouter = (require('../routes/repStockRequests') as typeof import('../routes/repStockRequests')).default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { computeWarehouseStock } = require('../services/warehouseStock') as typeof import('../services/warehouseStock');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { saleExpiryFor } = require('../services/invoiceExpiry') as typeof import('../services/invoiceExpiry');

const ADMIN = { id: 'ADM', role: 'ADMIN', tenantId: T, name: 'المدير' };
const REP = { id: 'R1', role: 'SALES_REP', tenantId: T, name: 'أحمد' };

/** يشغّل مكدّس المسار وحده (حرّاسه ثم معالجه) — بلا وسائط الموجّه العامة (المصادقة والتفعيل) */
async function call(router: unknown, method: string, p: string, req: Row): Promise<{ status: number; body: Row }> {
  const layer = (router as { stack: Row[] }).stack.find((l) => l.route?.path === p && l.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${p} مفقود`);
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  const full = { query: {}, params: {}, body: {}, headers: {}, user: ADMIN, ...req };
  for (const h of layer.route.stack as Row[]) {
    let passed = false;
    let err: any;
    await h.handle(full, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err) {
      // كمعالج الأخطاء العام (middleware/errorHandler.ts): الرمز يمرّ مع الرسالة (UNIT_INVALID)
      if (typeof err.status === 'number') return { status: err.status, body: { success: false, message: err.message, ...(err.code && { code: err.code }) } };
      throw err;
    }
    if (!passed) break;
  }
  return { status: res.statusCode, body: res.body };
}

const sale = (productId: string, qty: number, unitFactor: number, at: Date, extra: Row = {}): Row => ({
  invoiceId: `I-${st.invItems.length}`, productId, qty, unitFactor, baseQty: qty * unitFactor, returnExpired: null, ...extra,
  invoice: { type: 'CASH', returnToStock: null, invoiceDate: at, returnReason: null, createdAt: at, salesRepId: 'R1', status: 'CONFIRMED', ...(extra.invoice ?? {}) },
});

// ═══ تحميل السيارة ═══

test('تحميل بالكرتون: لقطة الوحدة والكمية بالأساس على البند، والمقترَح يبقى بالأساس', async () => {
  reset();
  const r = await call(vanRouter, 'post', '/loads', {
    body: { salesRepId: 'R1', type: 'LOAD', items: [
      { productId: 'P1', qty: 2, unitId: 'U-CT', suggestedQty: 48, expectedQty: 40 },
      { productId: 'P2', qty: 5 },
    ] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const [a, b] = st.createdLoads[0].items;
  assert.deepEqual([a.qty, a.unitName, a.unitFactor, a.baseQty, a.suggestedQty, a.expectedQty], [2, 'كرتون', 24, 48, 48, 40]);
  assert.deepEqual([b.qty, b.unitName, b.unitFactor, b.baseQty], [5, null, 1, 5], 'بلا وحدة ⇒ الأساس بمعامل ١');
});

test('تحميلٌ بلا أيّ وحدة: لا استعلام عن الوحدات أصلاً — مسار العميل القديم حرفياً', async () => {
  reset();
  const r = await call(vanRouter, 'post', '/loads', { body: { salesRepId: 'R1', type: 'LOAD', items: [{ productId: 'P1', qty: 7 }] } });
  assert.equal(r.status, 201);
  assert.equal(st.unitQueries.length, 0);
  assert.deepEqual(st.createdLoads[0].items[0], { productId: 'P1', qty: 7, unitName: null, unitFactor: 1, baseQty: 7, suggestedQty: null, expectedQty: null });
});

/**
 * وحدةٌ لا تخصّ الصنف أو موقوفة أو لشركةٍ أخرى ⇒ رفضٌ ظاهر لا قيدٌ صامت بالأساس.
 * «١٠ كراتين» من شاشةٍ بقائمة أصنافٍ قديمة كانت تُقيَّد عشر حبّات فيختلّ رصيد السيارة ولا يعلم أحد.
 */
test('وحدةٌ لا تخصّ الصنف أو موقوفة أو لشركةٍ أخرى ⇒ ٤٠٠ UNIT_INVALID ولا كتابة', async () => {
  for (const unitId of ['U-P2', 'U-OFF', 'U-X']) {
    reset();
    const r = await call(vanRouter, 'post', '/loads', {
      body: { salesRepId: 'R1', type: 'LOAD', items: [{ productId: 'P1', qty: 1, unitId }] },
    });
    assert.equal(r.status, 400, `${unitId}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'UNIT_INVALID', unitId);
    assert.equal(st.createdLoads.length, 0, `${unitId}: لا كتابة بعد رفض`);
    assert.equal(st.unitQueries[0].tenantId, T, 'الحلّ داخل الشركة');
  }
  // والموقوفة تُقبل في إعادة الرفع أوف‑لاين وحدها (أُوقفت بعد تسجيل الحركة على الجهاز)
  reset();
  const replay = await call(vanRouter, 'post', '/loads', {
    body: { salesRepId: 'R1', type: 'LOAD', items: [{ productId: 'P1', qty: 1, unitId: 'U-OFF' }] },
    headers: { 'x-fs-replay': '1' },
  });
  assert.notEqual(replay.status, 400, `إعادة الرفع: ${JSON.stringify(replay.body)}`);
});

test('إزالة التالف بالأساس: كرتونان (٤٨) لا يُزالان من ٣٠ حبة تالفة، وكرتونٌ واحد يُزال', async () => {
  reset();
  st.invItems.push(sale('P1', 30, 1, AFTER_DAMAGED, { invoice: { type: 'RETURN', returnReason: 'DAMAGED', createdAt: AFTER_DAMAGED } }));
  const out = (items: Row[]) => call(vanRouter, 'post', '/loads', { body: { salesRepId: 'R1', type: 'DAMAGED_OUT', items } });
  const over = await out([{ productId: 'P1', qty: 2, unitId: 'U-CT' }]);
  assert.equal(over.status, 400, 'الجمع الخام: ٢ ≤ ٣٠ فيمرّ');
  assert.match(over.body.message, /أكبر من التالف/);
  // كرتونٌ (٢٤) وسبع حبّات من الصنف نفسه: كلٌّ وحده دون ٣٠، ومعاً ٣١ بالأساس
  assert.equal((await out([{ productId: 'P1', qty: 1, unitId: 'U-CT' }, { productId: 'P1', qty: 7 }])).status, 400);
  assert.equal(st.createdLoads.length, 0, 'لا كتابة بعد رفض');
  const ok = await out([{ productId: 'P1', qty: 1, unitId: 'U-CT' }]);
  assert.equal(ok.status, 201);
  assert.equal(st.createdLoads[0].items[0].baseQty, 24);
  assert.equal((await out([{ productId: 'P1', qty: 7 }])).status, 400, 'المتبقّي التالف ٦ حبّات بعد إزالة الكرتون');
});

test('مخزون السيارة الآن بالأساس ومعه وحدات الصنف: كرتونان محمّلان وبيع ٥ حبّات ⇒ ٤٣', async () => {
  reset();
  st.loadItems.push({ productId: 'P1', qty: 2, unitName: 'كرتون', unitFactor: 24, baseQty: 48, vanLoad: { type: 'LOAD', createdAt: day(20), salesRepId: 'R1' } });
  st.invItems.push(sale('P1', 5, 1, day(21)));
  const r = await call(vanRouter, 'get', '/current', { query: { salesRepId: 'R1' } });
  assert.equal(r.status, 200);
  const p1 = (r.body.data as Row[]).find((x) => x.productId === 'P1')!;
  assert.equal(p1.loaded, 48);
  assert.equal(p1.sold, 5);
  assert.equal(p1.remaining, 43);
  assert.equal(p1.unit, 'حبة', 'الرصيد بوحدة الأساس');
  assert.deepEqual(p1.units.map((u: Row) => [u.name, u.factor]), [['كرتون', 24], ['شدّة', 6]], 'كل وحدات الصنف للعرض (formatQty يُسقط الموقوفة)');
});

test('اقتراح التحميل ودقّته بالأساس: كرتونٌ مُباع = ٢٤، وتحميل كرتونين لاقتراح ٤٨ تبنٍّ', async () => {
  reset();
  // ٢٨ يوماً قبل اليوم المستهدف، كرتونٌ يومياً
  const target = new Date();
  for (let i = 1; i <= 28; i++) st.invItems.push(sale('P1', 1, 24, new Date(target.getTime() - i * 86400000)));
  const r = await call(vanRouter, 'get', '/suggest', { query: { salesRepId: 'R1', bufferPct: '0' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = (r.body.data.rows as Row[]).find((x) => x.id === 'P1')!;
  assert.equal(row.expected, 24, 'المتوقّع بالحبّات لا ١ كرتون');
  assert.equal(row.suggested, 24);
  assert.match(row.why, /والمقترح 1 كرتون\.$/);

  reset();
  const loadAt = new Date(Date.now() - 3 * 86400000);
  st.loadItems.push({ productId: 'P1', qty: 2, unitFactor: 24, baseQty: 48, suggestedQty: 48, expectedQty: 40, vanLoad: { type: 'LOAD', createdAt: loadAt, salesRepId: 'R1' } });
  st.invItems.push(sale('P1', 1, 24, loadAt), sale('P1', 20, 1, loadAt));
  db.vanLoad.findMany = async () => [{ id: 'L1', createdAt: loadAt, items: st.loadItems }];
  const acc = await call(vanRouter, 'get', '/accuracy', { query: { salesRepId: 'R1' } });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  const d = (acc.body.data.days as Row[])[0];
  assert.deepEqual([d.loaded, d.actual, d.expected, d.adopted], [48, 44, 40, true]);
  delete db.vanLoad.findMany;
});

test('حركات السيارة بلقطة وحدة البند — «٢ كرتون» لا «٢ حبة»', async () => {
  reset();
  db.vanLoad.findMany = async () => [{ type: 'LOAD', createdAt: day(20), note: '', createdBy: 'ADMIN',
    items: [{ qty: 2, unitName: 'كرتون', unitFactor: 24, baseQty: 48, product: { name: 'ماء', unit: 'حبة' } }, { qty: 3, unitName: null, unitFactor: 1, baseQty: 3, product: { name: 'ماء', unit: 'حبة' } }] }];
  db.invoice = { async findMany() { return []; } };
  const r = await call(vanRouter, 'get', '/movements', { query: { salesRepId: 'R1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // ومفتاح «الوحدة الرئيسية» حاضرٌ null لصنفٍ بلاها (D18)
  assert.deepEqual(r.body.data[0].items, [
    { name: 'ماء', unit: 'كرتون', qty: 2, baseQty: 48, primaryUnitId: null },
    { name: 'ماء', unit: 'حبة', qty: 3, baseQty: 3, primaryUnitId: null },
  ]);
  delete db.vanLoad.findMany;
  delete db.invoice;
});

// ═══ المستودع ═══

test('وارد بالكرتون: الكمية والتكلفة بوحدة السطر على البند، والرصيد والتقييم بالأساس بلا تقريبٍ مسبق', async () => {
  reset();
  const r = await call(warehouseRouter, 'post', '/entries', {
    body: { type: 'RECEIVE', items: [{ productId: 'P1', qty: 1000, unitId: 'U-CT', unitCost: 10 }, { productId: 'P2', qty: 6, unitCost: 3 }] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const [a, b] = st.createdEntries[0].items;
  assert.deepEqual([a.qty, a.unitName, a.unitFactor, a.baseQty, a.unitCost], [1000, 'كرتون', 24, 24000, 10], 'تكلفة الكرتون كما في فاتورة المورّد');
  assert.deepEqual([b.qty, b.unitFactor, b.baseQty, b.unitCost], [6, 1, 6, 3]);

  // تحميل كرتونٍ لسيارة ثمّ تنزيل ٢٤ حبة: يعود بكلفة خروجه
  st.loadItems.push(
    { productId: 'P1', qty: 1, unitFactor: 24, baseQty: 24, vanLoad: { type: 'LOAD', createdAt: new Date(), salesRepId: 'R1', deletedSalesRepId: null } },
    { productId: 'P1', qty: 24, unitFactor: 1, baseQty: 24, vanLoad: { type: 'UNLOAD', createdAt: new Date(), salesRepId: 'R1', deletedSalesRepId: null } },
  );
  const rows = await computeWarehouseStock(T, 2);
  const p1 = rows.find((x) => x.productId === 'P1')!;
  assert.equal(p1.onHand, 24000, 'بالحبّات');
  assert.equal(p1.loadedToVans, 24);
  assert.equal(p1.returnedFromVans, 24);
  assert.equal(p1.stockValue, 10000, '١٠٠٠ كرتون × ١٠ — لا ١٠٠٠٠٫٨ من تكلفة حبّةٍ مقرَّبة');
  assert.equal(p1.avgCost, 0.4167, 'المتوسّط لوحدة الأساس');
  assert.deepEqual(p1.units?.map((u) => u.name), ['كرتون', 'شدّة'], 'وحدات الصنف للعرض');
});

test('وارد بتكلفةٍ شاملة الضريبة بالكرتون: تُردّ إلى صافيها لوحدة السطر ثمّ تُقسم عند التقييم', async () => {
  reset();
  const r = await call(warehouseRouter, 'post', '/entries', {
    body: { type: 'RECEIVE', costsIncludeTax: true, items: [{ productId: 'P1', qty: 2, unitId: 'U-CT', unitCost: 115 }] },
  });
  assert.equal(r.status, 201);
  assert.equal(st.createdEntries[0].items[0].unitCost, 100, 'صافي الكرتون');
  const p1 = (await computeWarehouseStock(T, 2)).find((x) => x.productId === 'P1')!;
  assert.deepEqual([p1.onHand, p1.stockValue], [48, 200]);
});

// ═══ طلب البضاعة ═══

test('طلب بضاعة: سطرٌ واحد لكل صنف بوحدته، والوحدتان معاً بالأساس، والسقف بالأساس', async () => {
  reset();
  const r = await call(requestsRouter, 'put', '/mine', {
    user: REP,
    body: { items: [{ productId: 'P1', qty: 5, unitId: 'U-CT' }, { productId: 'P1', qty: 3 }, { productId: 'P2', qty: 2, unitId: 'U-P2' }] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const items = st.requests[0].items as Row[];
  const p1 = items.find((i) => i.productId === 'P1')!;
  const p2 = items.find((i) => i.productId === 'P2')!;
  assert.deepEqual([p1.qty, p1.requestedQty, p1.unitName, p1.unitFactor, p1.baseQty], [123, 123, null, 1, 123], '٥ كرتون + ٣ حبة = ١٢٣ حبة');
  assert.deepEqual([p2.qty, p2.requestedQty, p2.unitName, p2.unitFactor, p2.baseQty], [2, 2, 'كرتون', 12, 24]);
  const shaped = (r.body.data.items as Row[]).find((i) => i.productId === 'P2')!;
  assert.deepEqual([shaped.unit, shaped.baseQty, shaped.requestedBaseQty, shaped.baseUnit], ['كرتون', 24, 24, 'علبة'], 'الردّ بوحدة السطر ومعه الأساس');

  const cap = await call(requestsRouter, 'put', '/mine', { user: REP, body: { items: [{ productId: 'P1', qty: 50000, unitId: 'U-CT' }] } });
  assert.equal(cap.status, 400, '٥٠ ألف كرتون = ١٫٢ مليون حبة فوق السقف');
});

// ═══ الصلاحية بأساس تحميل السيارة ═══

test('دفعة التحميل بالأساس: ٢٠ حبة مُباعة قبل البيع لم تستنفد كرتون الدفعة الأولى', async () => {
  reset();
  const life = { shelfLifeEnabled: true, shelfLifeValue: 10, shelfLifeUnit: 'DAY', shelfLifeBasis: 'VAN_LOAD' };
  st.loadItems.push(
    { productId: 'P1', qty: 1, unitFactor: 24, baseQty: 24, vanLoad: { type: 'LOAD', createdAt: day(1), salesRepId: 'R1' } },
    { productId: 'P1', qty: 1, unitFactor: 24, baseQty: 24, vanLoad: { type: 'LOAD', createdAt: day(5), salesRepId: 'R1' } },
  );
  st.invItems.push(sale('P1', 20, 1, day(4)));
  const exp = await saleExpiryFor(T, 'UTC', life, { invoiceId: 'NEW', invoiceDate: day(6), salesRepId: 'R1', productId: 'P1' });
  assert.equal(exp?.toISOString().slice(0, 10), '2026-10-11', 'من دفعة ١ أكتوبر لا ٥ (الجمع الخام: ٢٠ ≥ ١+١)');
  // وبعد ٢٤ حبة صُرفت (كرتونٌ مُباعٌ كاملاً) ينتقل إلى الدفعة الثانية
  st.invItems.push(sale('P1', 4, 1, day(4)));
  const next = await saleExpiryFor(T, 'UTC', life, { invoiceId: 'NEW', invoiceDate: day(6), salesRepId: 'R1', productId: 'P1' });
  assert.equal(next?.toISOString().slice(0, 10), '2026-10-15');
});
