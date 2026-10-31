// «الوحدة الرئيسية» §2.11 (الحزمة B3b) — الاستيراد: عمود «الوحدة الرئيسية» في ملف المنتجات والسعر المشتقّ بعد الصافي، وتكافؤ
// البصمة، وD17 في الأسعار (خانة وحدة فارغة لصنفٍ له رئيسية أو حُوِّل ⇒ خطأ صفّ بلا كتابة)، وقفل أصناف كل شريحة أسعار.
// المساران الحقيقيان (routes/import.ts) فوق Prisma مزيّف في الذاكرة، والمساعدات الصرفة مباشرةً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { importContentHash } from '../services/importLedger';
import { derivedBasePrice } from '../services/units';
import { netFromInclusive, roundHalfUp } from '../lib/money';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

type Row = Record<string, any>;
const T = 'T1';
let PRODUCTS: Row[] = [];
let st: { batches: Row[]; created: Row[]; units: Row[]; productUpdates: Row[]; upserts: Row[]; sql: string[] };
let lockedUnit: Record<string, string> = {};
const reset = () => {
  PRODUCTS = [
    // P1 قارورة بكرتونٍ رئيسي، وP2 حُوِّل أساسه (بلا رئيسية)، وP3 صنفٌ قديم بكرتونٍ غير رئيسي
    { id: 'P1', tenantId: T, code: 'A', name: 'ماء', unit: 'قارورة', taxPct: 15, deletedAt: null, primaryUnitId: 'U-CT', baseConvertedAt: null,
      units: [{ id: 'U-CT', name: 'كرتون', factor: 24, isActive: true }] },
    { id: 'P2', tenantId: T, code: 'B', name: 'عصير', unit: 'قارورة', taxPct: 15, deletedAt: null, primaryUnitId: null, baseConvertedAt: new Date('2026-10-30T10:00:00Z'),
      units: [{ id: 'U-B', name: 'كرتون', factor: 12, isActive: true }] },
    { id: 'P3', tenantId: T, code: 'C', name: 'سكر', unit: 'كيس', taxPct: 0, deletedAt: null, primaryUnitId: null, baseConvertedAt: null,
      units: [{ id: 'U-C', name: 'شوال', factor: 10, isActive: true }] },
  ];
  st = { batches: [], created: [], units: [], productUpdates: [], upserts: [], sql: [] };
  lockedUnit = {};
};
reset();

const sqlOf = (strings: TemplateStringsArray) => strings.join('$').replace(/\s+/g, ' ').trim();
const db: Row = {
  admin: { async findUnique() { return { isActive: true, scopeEnabled: false, scopeMode: 'LISTS' }; } },
  companySettings: { async findUnique() { return { defaultVatPct: 15, currency: 'SAR', countryCode: 'SA' }; } },
  glSettings: { async findUnique() { return null; } },
  customer: { async findMany() { return [{ id: 'C1', code: 'K-1', phone: '0500000001', name: 'بقالة النور' }]; } },
  customerPrice: {
    async findUnique() { return null; },
    async upsert(a: Row) { st.upserts.push(a); return { id: `CP-${a.where.customerId_productId.productId}` }; },
  },
  productCategory: { async findMany() { return []; } },
  product: {
    async findMany(a: Row) { return PRODUCTS.filter((p) => p.tenantId === a.where?.tenantId); },
    async create(a: Row) { const p = { id: `NEW${st.created.length + 1}`, ...a.data }; st.created.push(p); return { id: p.id }; },
    async update(a: Row) { st.productUpdates.push(a); return { id: a.where.id }; },
  },
  productUnit: { async createMany(a: Row) { st.units.push(...(a.data as Row[])); return { count: a.data.length }; } },
  importBatch: {
    async findFirst() { return null; },
    async findMany() { return []; },
    async create(a: Row) { st.batches.push(a.data); return { id: 'B1' }; },
    async update() { return {}; },
    async deleteMany() { return { count: 1 }; },
  },
};
const tx: Row = Object.assign(Object.create(db), {
  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = sqlOf(strings);
    st.sql.push(sql);
    if (sql.includes('FOR KEY SHARE')) {
      const ids = values.find((v): v is string[] => Array.isArray(v)) ?? [];
      return PRODUCTS.filter((p) => ids.includes(p.id)).map((p) => ({ id: p.id, unit: lockedUnit[p.id] ?? p.unit, lotTracked: false, lotTrackedSince: null }));
    }
    if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '0' }];
    return [];
  },
  async $executeRaw(strings: TemplateStringsArray) { st.sql.push(sqlOf(strings)); return 1; },
});
db.$transaction = async (fn: (t: Row) => Promise<unknown>) => fn(tx);
db.$executeRaw = tx.$executeRaw;
stub('config/database', { default: db });

/* eslint-disable @typescript-eslint/no-var-requires */
const importRoutes = require('../routes/import') as typeof import('../routes/import');
/* eslint-enable @typescript-eslint/no-var-requires */
const { hashRowsOf, importPrimaryOf, importUnitRequired, planPriceRowsWithUnits, PRICE_UNIT_REQUIRED_MESSAGE } = importRoutes;

const ADMIN = { id: 'ADM', role: 'ADMIN', tenantId: T, name: 'المدير' };
/** معالج المسار وحده (بعد حرّاس الصلاحية) */
async function call(p: string, body: Row): Promise<{ status: number; body: Row }> {
  const layer = (importRoutes.default as unknown as { stack: Row[] }).stack.find((l) => l.route?.path === p && l.route.methods.post);
  assert.ok(layer, `POST ${p} مفقود`);
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  let err: unknown = null;
  const h = (layer.route.stack as Row[]).at(-1)!.handle;
  await h({ query: {}, params: {}, headers: {}, user: ADMIN, body }, res, (e?: unknown) => { err = e ?? null; });
  if (err) throw err;
  return { status: res.statusCode, body: res.body };
}

// ═══ المساعدات الصرفة ═══

test('importPrimaryOf: الفارغة واسم «الوحدة» نفسها ⇒ بلا رئيسية، وغير وحدات الصفّ ⇒ PRIMARY_UNIT_INVALID، وبلا سعرين ⇒ PRIMARY_PRICE_REQUIRED', () => {
  const units = [{ name: 'كرتون', factor: 24, price: 48 }, { name: 'طبلية', factor: 960 }];
  assert.equal(importPrimaryOf({ unit: 'قارورة', units }), null);
  assert.equal(importPrimaryOf({ unit: 'قارورة', units, primaryUnit: ' قارورة ' }), null);
  assert.deepEqual(importPrimaryOf({ unit: 'قارورة', units, primaryUnit: 'كرتون' }), { index: 0 });
  const bad = importPrimaryOf({ unit: 'قارورة', units, primaryUnit: 'شدة' });
  assert.ok(bad && 'error' in bad && bad.error.code === 'PRIMARY_UNIT_INVALID' && bad.error.field === 'primaryUnit');
  const noPrice = importPrimaryOf({ unit: 'قارورة', units, primaryUnit: 'طبلية' });
  assert.ok(noPrice && 'error' in noPrice && noPrice.error.code === 'PRIMARY_PRICE_REQUIRED');
  assert.deepEqual(importPrimaryOf({ unit: 'قارورة', units, primaryUnit: 'طبلية', basePrice: 2 }), { index: 1 }, 'سعر الصغرى يكفي');
});

test('تكافؤ البصمة: ملفٌّ قديم بلا عمود السعر يعطي بصمة 079fb38 حرفاً (basePrice بافتراض 0)، والرئيسية تدخلها حين تُكتب وحدها', () => {
  const rows = [{ code: 'A', name: 'ماء', unit: 'حبة' }, { code: 'B', name: 'شاي', unit: 'علبة', basePrice: 5 }];
  // ما كان productRow في 079fb38 يُخرجه: basePrice: 0 للصفّ بلا سعر
  const legacy = [{ code: 'A', name: 'ماء', unit: 'حبة', basePrice: 0 }, { code: 'B', name: 'شاي', unit: 'علبة', basePrice: 5 }];
  assert.equal(importContentHash('products', hashRowsOf(rows)), importContentHash('products', legacy));
  assert.deepEqual(hashRowsOf(rows)[0], { code: 'A', name: 'ماء', unit: 'حبة', basePrice: 0 });
  const withPrimary = [{ ...rows[0], units: [{ name: 'كرتون', factor: 24, price: 48 }], primaryUnit: 'كرتون' }];
  assert.ok(!('basePrice' in hashRowsOf(withPrimary)[0]), 'صفّ الرئيسية لا يُطبَّع سعره');
  assert.notEqual(importContentHash('products', hashRowsOf(withPrimary)), importContentHash('products', hashRowsOf([{ ...withPrimary[0], primaryUnit: undefined }])));
});

test('importUnitRequired (D17): الفارغة لصنفٍ له رئيسية صالحة أو تاريخ تحويل ⇒ «الصنف: الوحدات»، وغيرهما أو المكتوبة ⇒ null', () => {
  assert.equal(importUnitRequired(PRODUCTS[0] as never, ''), 'ماء: كرتون أو قارورة');
  assert.equal(importUnitRequired(PRODUCTS[0] as never, undefined), 'ماء: كرتون أو قارورة');
  assert.equal(importUnitRequired(PRODUCTS[0] as never, 'قارورة'), null);
  assert.equal(importUnitRequired(PRODUCTS[1] as never, '  '), 'عصير: كرتون أو قارورة', 'محوَّلٌ بلا رئيسية');
  assert.equal(importUnitRequired(PRODUCTS[2] as never, ''), null, 'صنفٌ بلا الحقلين: السلوك القائم');
  // رئيسيةٌ تالفة (موقوفة) وبلا تحويل ⇒ null (I5: سلوك اليوم)
  assert.equal(importUnitRequired({ ...PRODUCTS[0], units: [{ id: 'U-CT', name: 'كرتون', factor: 24, isActive: false }] } as never, ''), null);
});

test('planPriceRowsWithUnits: D17 في موضع حلّ الوحدة — بعد أخطاء العميل والصنف والصفر، وخارج أزواج التكرار، وبلا D17 الخطة نفسها', () => {
  const matcher = (r: { customerCode?: string | null }) => (r.customerCode === 'K-1' ? { id: 'C1' } : { error: 'NOT_FOUND' as const });
  const rows = [
    { customerCode: 'K-1', productCode: 'A', price: 48, unit: 'كرتون' }, // 2: يُكتب
    { customerCode: 'K-1', productCode: 'A', price: 3 },                  // 3: D17 — لا يغلب الصفّ 2 في زوجه
    { customerCode: 'X', productCode: 'A', price: 3 },                    // 4: العميل أولاً
    { customerCode: 'K-1', productCode: 'A', price: 0 },                  // 5: الصفر قبل الوحدة
    { customerCode: 'K-1', productCode: 'B', price: 2 },                  // 6: محوَّل ⇒ D17
    { customerCode: 'K-1', productCode: 'C', price: 7 },                  // 7: القائم حرفياً
  ];
  const plan = planPriceRowsWithUnits(rows, matcher, PRODUCTS as never, false);
  assert.deepEqual(plan.errors.map((e) => [e.row, e.code]), [[3, 'PRICE_UNIT_REQUIRED'], [4, 'CUSTOMER_NOT_FOUND'], [5, 'ZERO_PRICE'], [6, 'PRICE_UNIT_REQUIRED']]);
  assert.deepEqual(plan.errors[0], { row: 3, code: 'PRICE_UNIT_REQUIRED', message: PRICE_UNIT_REQUIRED_MESSAGE, value: 'ماء: كرتون أو قارورة', field: 'unit' });
  assert.deepEqual(plan.writes.map((w) => [w.row, w.productId, w.price, w.unitFactor]), [[2, 'P1', 48, 24], [7, 'P3', 7, undefined]]);
  assert.deepEqual(plan.duplicates, [], 'الصفّ المرفوض لا يدخل أزواج التكرار');
});

// ═══ مسار استيراد المنتجات ═══

test('/products: رئيسيةٌ مسعَّرة وسعر الصغرى غائب مع «شاملة الضريبة» ⇒ السعر المشتقّ من صافي الرئيسية لا 0، والرئيسية تُكتب على الصنف', async () => {
  reset();
  const r = await call('/products', {
    pricesIncludeTax: true,
    rows: [
      { code: 'N1', name: 'مياه صحية', unit: 'قارورة', taxPct: 15, units: [{ name: 'كرتون', factor: 24, price: 48 }], primaryUnit: 'كرتون' },
      { code: 'N2', name: 'شاي', unit: 'علبة', taxPct: 15 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.errors, []);
  const [n1, n2] = st.created;
  const net = roundHalfUp(netFromInclusive(48, 15), 2);
  assert.equal(n1.basePrice, derivedBasePrice(net, 24));
  assert.equal(n1.basePrice, 1.7392, '41.74 ÷ 24 بأربع منازل');
  assert.equal(n2.basePrice, 0, 'بلا سعر ولا رئيسية ⇒ 0 كما كان');
  const ct = st.units.find((u) => u.productId === n1.id && u.name === 'كرتون')!;
  assert.equal(ct.price, net, 'سعر الكرتون صافياً صريحاً على وحدته');
  assert.ok(ct.id, 'معرّف وحدة الرئيسية مولَّد');
  assert.deepEqual(st.productUpdates.map((u) => [u.where.id, u.data.primaryUnitId]), [[n1.id, ct.id]]);
  // البصمة كملفٍ قديم للصفّ بلا رئيسية
  assert.equal(r.body.data.netFromInclusive, 0, 'لا سعر صغرى مكتوب حُوِّل');
});

test('/products: رئيسيةٌ ليست من وحدات الصفّ أو بلا سعرين ⇒ خطأ صفّ بلا إنشاء، والبقية تُكتب', async () => {
  reset();
  const r = await call('/products', {
    rows: [
      { code: 'X1', name: 'أ', unit: 'قارورة', units: [{ name: 'كرتون', factor: 24 }], primaryUnit: 'شدة', basePrice: 1 },
      { code: 'X2', name: 'ب', unit: 'قارورة', units: [{ name: 'كرتون', factor: 24 }], primaryUnit: 'كرتون' },
      { code: 'X3', name: 'ج', unit: 'قارورة', units: [{ name: 'كرتون', factor: 24 }], primaryUnit: 'كرتون', basePrice: 2 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.errors.map((e: Row) => [e.row, e.code, e.field]), [[2, 'PRIMARY_UNIT_INVALID', 'primaryUnit'], [3, 'PRIMARY_PRICE_REQUIRED', 'primaryUnit']]);
  assert.deepEqual(st.created.map((p) => [p.code, p.basePrice]), [['X3', 2]], 'سعر الصغرى المكتوب كما كُتب');
  assert.equal(st.productUpdates.length, 1);
});

test('/products: ملفٌّ قديم بلا عمود السعر ولا رئيسية ⇒ بصمة الدفعة كما في 079fb38 والسعر 0 وبلا تحديث رئيسية', async () => {
  reset();
  const rows = [{ code: 'O1', name: 'قديم', unit: 'حبة' }];
  await call('/products', { rows });
  assert.equal(st.batches[0].contentHash, importContentHash('products', [{ code: 'O1', name: 'قديم', unit: 'حبة', basePrice: 0 }]));
  assert.deepEqual([st.created[0].basePrice, st.productUpdates.length], [0, 0]);
});

// ═══ مسار استيراد الأسعار ═══

test('/prices: D17 ⇒ خطأ صفّ بلا كتابة لذلك الصفّ، والمكتوبة بوحدتها تُقسم، والصنف بلا رئيسية كما كان — والأصناف تُقفل قبل أول upsert', async () => {
  reset();
  const r = await call('/prices', {
    rows: [
      { customerCode: 'K-1', productCode: 'A', price: 48, unit: 'كرتون' },
      { customerCode: 'K-1', productCode: 'B', price: 2 },
      { customerCode: 'K-1', productCode: 'C', price: 7 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.errors.map((e: Row) => [e.row, e.code]), [[3, 'PRICE_UNIT_REQUIRED']]);
  assert.deepEqual(st.upserts.map((u) => [u.where.customerId_productId.productId, u.update.price]), [['P1', 2], ['P3', 7]]);
  const lock = st.sql.findIndex((s) => s.includes('FOR KEY SHARE'));
  assert.ok(lock >= 0, 'قفل أصناف الشريحة');
});

test('/prices: تحويلٌ التزم بين القراءة والكتابة ⇒ 409 PRODUCT_UNITS_CHANGED (خطأ قاتل) بلا أي upsert', async () => {
  reset();
  lockedUnit = { P1: 'كرتون' };
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  const layer = (importRoutes.default as unknown as { stack: Row[] }).stack.find((l) => l.route?.path === '/prices' && l.route.methods.post);
  let nextErr: unknown = null;
  await (layer.route.stack as Row[]).at(-1)!.handle(
    { query: {}, params: {}, headers: {}, user: ADMIN, body: { rows: [{ customerCode: 'K-1', productCode: 'A', price: 48, unit: 'كرتون' }] } },
    res, (e?: unknown) => { nextErr = e ?? null; },
  );
  assert.equal(nextErr, null);
  assert.deepEqual([res.statusCode, res.body.code], [409, 'PRODUCT_UNITS_CHANGED'], JSON.stringify(res.body));
  assert.equal(st.upserts.length, 0);
});
