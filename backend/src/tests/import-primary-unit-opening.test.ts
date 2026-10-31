// «الوحدة الرئيسية» §2.11 (الحزمة B3b) — الجرد الافتتاحي: D17 (خانة وحدة فارغة لصنفٍ له رئيسية صالحة أو حُوِّل ⇒ QTY_UNIT_REQUIRED
// بلا كتابة لصفّه)، وحارس الأساس تحت القفل بعد gl-post في الفرعين (lockBases والتتبّع مطفأ، وصفوف lockLotProducts والتتبّع مفعّل) ⇒
// 409 للملف كله. المسار الحقيقي (routes/import.ts) فوق القاعدة المزيّفة lots-b3-fake.ts. لا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { World, type Row } from './lots-b3-fake';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

const world = new World();
const db = world.db;
stub('config/database', { default: db });

/* eslint-disable @typescript-eslint/no-var-requires */
const importRoutes = require('../routes/import') as typeof import('../routes/import');
const { authenticate } = require('../middleware/auth') as typeof import('../middleware/auth');
/* eslint-enable @typescript-eslint/no-var-requires */

const ADMIN = { id: 'ADM', role: 'ADMIN', tenantId: 't1', name: 'المدير' };
const CONVERTED = new Date('2026-10-30T10:00:00.000Z');

// قراءة الأصناف الأصلية: وحداتها بلا معرّفات — «الوحدة الرئيسية» تحتاج المعرّف والرئيسية وتاريخ التحويل كما يختارها المسار
const origFindMany = db.product.findMany;
let afterRead: (() => void) | null = null;
db.product.findMany = async (a: Row) => {
  const rows = (await origFindMany(a)) as Row[];
  const out = rows.map((p) => ({
    ...p, primaryUnitId: p.primaryUnitId ?? null, baseConvertedAt: p.baseConvertedAt ?? null,
    units: world.units.filter((u) => u.productId === p.id).map(({ id, name, factor, isActive }) => ({ id, name, factor, isActive })),
  }));
  const hook = afterRead;
  afterRead = null;
  hook?.();
  return out;
};

function fresh(): void {
  Object.assign(world, new World());
  world.lotsEnabled = false;
  world.product({ id: 'p1', code: 'A-1', name: 'ماء', unit: 'قارورة' });
  world.product({ id: 'p2', code: 'B-2', name: 'عصير', unit: 'قارورة' });
  world.product({ id: 'p3', code: 'C-3', name: 'سكر', unit: 'كيس' });
  world.unit({ id: 'U-CT', productId: 'p1', name: 'كرتون', factor: 24 });
  world.unit({ id: 'U-B', productId: 'p2', name: 'كرتون', factor: 12 });
  // p1 رئيسيّه الكرتون (عرضٌ فقط)، وp2 حُوِّل أساسه بلا رئيسية، وp3 صنفٌ قديم
  Object.assign(world.products.find((p) => p.id === 'p1')!, { primaryUnitId: 'U-CT' });
  Object.assign(world.products.find((p) => p.id === 'p2')!, { baseConvertedAt: CONVERTED });
  afterRead = null;
}

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] }; handle: Function }
async function importFile(rows: Row[]): Promise<{ status: number; body: Row }> {
  const stack = (importRoutes.default as unknown as { stack: Layer[] }).stack;
  const layer = stack.find((l) => l.route?.path === '/opening-stock' && l.route.methods.post)!;
  const pre = stack.filter((l) => !l.route && l.handle.length < 4 && l.handle !== authenticate).map((l) => l.handle);
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  const full = { method: 'POST', query: {}, params: {}, body: { rows }, headers: {}, user: ADMIN };
  let err: unknown = null;
  for (const h of [...pre, ...layer.route!.stack.map((l) => l.handle)]) {
    let passed = false;
    await h(full, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err || !passed) break;
  }
  if (err) throw err;
  return { status: res.statusCode, body: res.body };
}

test('D17: خانة وحدة فارغة لصنفٍ له رئيسية أو حُوِّل ⇒ QTY_UNIT_REQUIRED بلا بنده، والمكتوبة تُقبل بوحدتها، والصنف القديم كما كان', async () => {
  fresh();
  const r = await importFile([
    { productCode: 'A-1', qty: 2, unitCost: 48 },                  // 2: رئيسية ⇒ يلزم الوحدة
    { productCode: 'A-1', qty: 2, unitCost: 48, unit: 'كرتون' },   // 3: بالكرتون ⇒ ٤٨ قارورة
    { productCode: 'B-2', qty: 5, unitCost: 2 },                   // 4: محوَّل ⇒ يلزم الوحدة
    { productCode: 'B-2', qty: 5, unitCost: 2, unit: 'قارورة' },   // 5: بالقارورة صراحةً
    { productCode: 'C-3', qty: 7, unitCost: 1 },                   // 6: القائم حرفياً
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.errors.map((e: Row) => [e.row, e.code, e.field, e.value]), [
    [2, 'QTY_UNIT_REQUIRED', 'unit', 'ماء: كرتون أو قارورة'],
    [4, 'QTY_UNIT_REQUIRED', 'unit', 'عصير: كرتون أو قارورة'],
  ]);
  assert.equal(r.body.data.created, 3);
  assert.deepEqual(world.items.map((i) => [i.productId, i.baseQty]), [['p1', 48], ['p2', 5], ['p3', 7]]);
});

test('D17: ملفٌّ كل صفوفه بلا وحدة لأصنافٍ رئيسية ⇒ أخطاء صفوف بلا معاملة ولا حركة', async () => {
  fresh();
  const r = await importFile([{ productCode: 'A-1', qty: 2, unitCost: 48 }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.errors.map((e: Row) => e.code), ['QTY_UNIT_REQUIRED']);
  assert.equal(world.entries.length, 0);
  assert.ok(!world.calls.some((c) => c.op === 'tx.begin'));
});

test('التتبّع مطفأ: lockBases بعد gl-post — تحويلٌ التزم بين القراءة والمعاملة ⇒ 409 PRODUCT_UNITS_CHANGED للملف كله بلا حركة', async () => {
  fresh();
  afterRead = () => { world.products.find((p) => p.id === 'p3')!.unit = 'شوال'; };
  world.calls.length = 0;
  const r = await importFile([{ productCode: 'A-1', qty: 1, unitCost: 48, unit: 'كرتون' }, { productCode: 'C-3', qty: 7, unitCost: 1 }]);
  assert.deepEqual([r.status, r.body.code], [409, 'PRODUCT_UNITS_CHANGED'], JSON.stringify(r.body));
  assert.match(r.body.message, /سكر/);
  assert.equal(world.entries.length, 0);
  const ops = world.calls.map((c) => c.sql ?? c.op);
  const post = ops.findIndex((s) => s.includes('pg_advisory_xact_lock(hashtext('));
  const share = ops.findIndex((s) => s.includes('FOR KEY SHARE'));
  assert.ok(post >= 0 && share > post, 'القفل بعد gl-post');
  // وبلا تحويل يمرّ والقفل نفسه قائم
  fresh();
  world.calls.length = 0;
  const ok = await importFile([{ productCode: 'C-3', qty: 7, unitCost: 1 }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(world.calls.filter((c) => c.sql?.includes('FOR KEY SHARE')).length, 1);
});

test('التتبّع مفعّل: الأساس من صفوف lockLotProducts نفسها (بلا قفلٍ ثانٍ) — تحويلٌ التزم ⇒ 409 بلا حركة ولا تشغيلة', async () => {
  fresh();
  world.lotsEnabled = true;
  afterRead = () => { world.products.find((p) => p.id === 'p3')!.unit = 'شوال'; };
  world.calls.length = 0;
  const r = await importFile([{ productCode: 'C-3', qty: 7, unitCost: 1 }]);
  assert.deepEqual([r.status, r.body.code], [409, 'PRODUCT_UNITS_CHANGED'], JSON.stringify(r.body));
  assert.equal(world.entries.length, 0);
  assert.equal(world.calls.filter((c) => c.sql?.includes('FOR KEY SHARE')).length, 1, 'قفلٌ واحد: صفوف lockLotProducts');
});
