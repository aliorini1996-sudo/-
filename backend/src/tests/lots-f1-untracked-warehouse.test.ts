// «تتبّع اللوط» — المسار غير المتتبَّع لحركات المستودع والميزة مفعّلة (متابعات البوابة F1): الموجّه الحقيقي routes/warehouse.ts فوق
// القاعدة المزيّفة lots-b3-fake.ts.
// (أ) D9 كالسيارة: سطرٌ يحمل تشغيلةً (lotId أو lotNumber أو تاريخ) لصنفٍ غير متتبَّع ⇒ 422 LOT_PRODUCT_MISMATCH بسبب NOT_TRACKED وموضع
//     السطر، لا إهمالٌ صامت — قبل أي معاملة، وتحت القفل لصنفٍ أُطفئ تتبّعه بين القراءتين. والمطفأة تُهملها كما كانت حرفياً (§١٠.١).
// (ب) معاملة إعادة قراءة التتبّع (D25) بمهلتها الافتراضية: P2028 أو انتظار قفلٍ تحت الضغط ⇒ 503 LOT_BUSY فيعيد العميل، لا 500.
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
const router = (require('../routes/warehouse') as typeof import('../routes/warehouse')).default;
const { authenticate } = require('../middleware/auth') as typeof import('../middleware/auth');
/* eslint-enable @typescript-eslint/no-var-requires */

const ADMIN = { id: 'ADM', role: 'ADMIN', tenantId: 't1', name: 'المدير' };

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] }; handle: Function }

/** يشغّل وسائط الموجّه (عدا المصادقة) ثم المسار ثم معالج أخطائه — كما يمشيها Express (نمط lots-d25-warehouse.test.ts) */
async function post(body: Row): Promise<{ status: number; body: Row }> {
  const stack = (router as unknown as { stack: Layer[] }).stack;
  const layer = stack.find((l) => l.route?.path === '/entries' && l.route.methods.post)!;
  const pre = stack.filter((l) => !l.route && l.handle.length < 4 && l.handle !== authenticate).map((l) => l.handle);
  const errHandlers = stack.filter((l) => !l.route && l.handle.length === 4).map((l) => l.handle);
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  const full = { method: 'POST', query: {}, params: {}, body, headers: {}, user: ADMIN };
  let err: unknown = null;
  for (const h of [...pre, ...layer.route!.stack.map((l) => l.handle)]) {
    let passed = false;
    await h(full, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err || !passed) break;
  }
  if (err) {
    for (const eh of errHandlers) {
      let next: unknown = null;
      let passed = false;
      await eh(err, full, res, (e?: unknown) => { next = e; passed = true; });
      if (!passed) return { status: res.statusCode, body: res.body };
      err = next;
    }
    return { status: 500, body: { message: (err as Error)?.message } };
  }
  return { status: res.statusCode, body: res.body };
}

/** عالمٌ جديد: P1 متتبَّع بتشغيلة L1 (١٠ في المستودع)، وP3 «سكر» غير متتبَّع برصيد ١٠ غير مسمّى */
function fresh(): void {
  Object.assign(world, new World());
  world.product({ id: 'P1', name: 'حليب' });
  world.product({ id: 'P3', name: 'سكر' });
  world.track('P1');
  world.lot({ id: 'L1', productId: 'P1', lotNumber: 'A1' });
  world.entry('RECEIVE', [{ productId: 'P1', qty: 10, lotId: 'L1' }, { productId: 'P3', qty: 10, lotId: null }]);
  world.calls.length = 0;
}

const ops = () => world.calls.map((c) => c.op);
const advisory = () => world.calls.some((c) => c.op === 'exec' && String(c.sql ?? '').includes('pg_advisory_xact_lock'));

test('F1 (أ) D9: الميزة مفعّلة — سطرٌ يحمل تشغيلةً لصنفٍ غير متتبَّع ⇒ 422 LOT_PRODUCT_MISMATCH NOT_TRACKED بموضعه، بلا حركة ولا معاملة', async () => {
  for (const [type, extra] of [
    ['RECEIVE', { lotId: 'L1' }], ['RECEIVE', { lotNumber: 'X1' }], ['RECEIVE', { expiryDate: '2999-01-01' }], ['RECEIVE', { productionDate: '2026-01-01' }],
    ['ADJUST', { lotNumber: 'X1' }], ['ADJUST', { lotId: 'L1' }],
  ] as [string, Row][]) {
    fresh();
    const n = world.entries.length;
    const qty = type === 'ADJUST' ? -2 : 2;
    const r = await post({ type, items: [{ productId: 'P3', qty: 1 }, { productId: 'P3', qty, ...extra }] });
    assert.equal(r.status, 422, JSON.stringify([type, extra, r.body]));
    assert.equal(r.body?.code, 'LOT_PRODUCT_MISMATCH');
    assert.deepEqual(r.body?.detail, { productId: 'P3', idx: 1, reason: 'NOT_TRACKED' });
    assert.match(String(r.body?.message), /«سكر»/);
    assert.equal(world.entries.length, n, 'كُتبت حركة');
    assert.deepEqual(ops(), ['product.findMany'], 'الرفض قبل أي معاملة أو استعلام وحدات');
  }
});

test('F1 (أ) D9: حركةٌ مختلطة (متتبَّع وغير متتبَّع يحمل تشغيلة) ⇒ 422 قبل الطابور والقفل، والسطر المتتبَّع لا يُكتب', async () => {
  fresh();
  const n = world.entries.length;
  const r = await post({ type: 'RECEIVE', items: [{ productId: 'P1', qty: 3, lotId: 'L1' }, { productId: 'P3', qty: 2, lotNumber: 'X1' }] });
  assert.deepEqual([r.status, r.body?.code, r.body?.detail], [422, 'LOT_PRODUCT_MISMATCH', { productId: 'P3', idx: 1, reason: 'NOT_TRACKED' }], JSON.stringify(r.body));
  assert.equal(world.entries.length, n);
  assert.ok(!advisory(), 'لا طابور ولا قفل لوط');
});

test('F1 (أ) D9: غيابٌ صريح — lotId null وlotNumber فارغ أو مسافات وتواريخ null ⇒ مسار غير المتتبَّع كما كان (201 بلا تشغيلة)', async () => {
  fresh();
  const r = await post({ type: 'ADJUST', items: [{ productId: 'P3', qty: -2, lotId: null, lotNumber: '  ', productionDate: null, expiryDate: null }, { productId: 'P3', qty: 1, lotNumber: '', expiryDate: '' }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // قفل الأساس («الوحدة الرئيسية» §2.8) ثم إعادة قراءة التتبّع (D25) — أيّاً كانت أوامر المهلة حولهما — ثم الإنشاء الوحيد
  const seq = world.calls.map((c) => c.op);
  assert.deepEqual([seq.slice(0, 2), seq.slice(-2)], [['product.findMany', 'tx.begin'], ['warehouseEntry.create', 'tx.commit']], seq.join(' '));
  assert.ok(seq.slice(2, -2).every((x) => x === 'query' || x === 'exec'), seq.join(' '));
  assert.deepEqual(world.calls.filter((c) => c.op === 'query' && String(c.sql ?? '').includes('FOR KEY SHARE'))
    .map((c) => (/^SELECT id, unit, "lotTracked", "lotTrackedSince" FROM products /.test(String(c.sql)) ? 'BASE'
      : /^SELECT id, "lotTracked" FROM products /.test(String(c.sql)) ? 'TRACK' : String(c.sql))), ['BASE', 'TRACK']);
  const last = world.items.filter((i) => i.entryId === world.entries[world.entries.length - 1].id);
  assert.deepEqual(last.map((i) => i.lotId), [null, null]);
});

test('F1 (أ) D9 تحت القفل: صنفٌ متتبَّع في القراءة المسبقة أُطفئ تتبّعه قبل القفل وسطره يحمل تشغيلة ⇒ 422 لا سطرٌ بلا تشغيلة', async () => {
  fresh();
  const n = world.entries.length;
  const pm = db.product as { findMany: (a: Row) => Promise<unknown> };
  const orig = pm.findMany;
  pm.findMany = async (a: Row) => {
    const out = await orig(a);
    pm.findMany = orig;
    world.products.find((p) => p.id === 'P1')!.lotTracked = false; // الإطفاء يلتزم بين القراءة المسبقة وقفل الأصناف
    return out;
  };
  try {
    const r = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -2, lotId: 'L1' }] });
    assert.deepEqual([r.status, r.body?.code, r.body?.detail], [422, 'LOT_PRODUCT_MISMATCH', { productId: 'P1', idx: 0, reason: 'NOT_TRACKED' }], JSON.stringify(r.body));
    assert.equal(world.entries.length, n, 'كُتبت تسويةٌ بلا تشغيلة تُبقي رصيد L1');
    assert.ok(ops().includes('tx.rollback'));
  } finally {
    pm.findMany = orig;
  }
});

test('F1 (أ) §١٠.١: الميزة مطفأة — حقول التشغيلة لصنفٍ غير متتبَّع تُهمل كما كانت حرفياً (لا 422، والمعاملة لقفل الأساس وحده)', async () => {
  fresh();
  world.lotsEnabled = false;
  const r = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 2, lotId: 'L1', lotNumber: 'X1', productionDate: '2026-01-01', expiryDate: '2999-01-01' }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // «الوحدة الرئيسية» §2.8: المسار المطفأ صار معاملةً لقفل الأساس وحده — بلا إعادة قراءة التتبّع
  assert.deepEqual(ops(), ['product.findMany', 'tx.begin', 'query', 'exec', 'query', 'exec', 'warehouseEntry.create', 'tx.commit']);
  const last = world.items.filter((i) => i.entryId === world.entries[world.entries.length - 1].id);
  assert.deepEqual(last.map((i) => i.lotId), [null]);
});

test('F1 (ب): معاملة إعادة قراءة التتبّع والميزة مفعّلة — P2028 أو انتظار قفل (55P03) ⇒ 503 LOT_BUSY بلا حركة، لا 500', async () => {
  for (const fail of [
    Object.assign(new Error('Transaction API error: Transaction already closed'), { code: 'P2028' }),
    Object.assign(new Error('canceling statement due to lock timeout'), { code: 'P2010', meta: { code: '55P03' } }),
  ]) {
    // إعادة قراءة التتبّع ⇒ LOT_BUSY كما كان؛ وقفل الأساس قبلها («الوحدة الرئيسية» §2.8، تحويلٌ يمسك الصنف) ⇒ PRODUCT_UNITS_BUSY
    for (const [hit, code] of [[/SELECT id, "lotTracked" FROM/, 'LOT_BUSY'], [/SELECT id, unit, /, 'PRODUCT_UNITS_BUSY']] as const) {
      fresh();
      const n = world.entries.length;
      world.failOn = (sql) => (sql.includes('FOR KEY SHARE') && hit.test(sql) ? fail : null);
      const r = await post({ type: 'ADJUST', items: [{ productId: 'P3', qty: -2 }] });
      assert.deepEqual([r.status, r.body?.code], [503, code], JSON.stringify(r.body));
      assert.equal(world.entries.length, n);
      world.failOn = null;
    }
  }
  // وخطأٌ غير الانشغال يبقى كما هو (إلى المعالج العام)
  fresh();
  world.failOn = (sql) => (sql.includes('FOR KEY SHARE') ? new Error('boom') : null);
  const other = await post({ type: 'ADJUST', items: [{ productId: 'P3', qty: -2 }] });
  assert.deepEqual([other.status, other.body?.message], [500, 'boom']);
  world.failOn = null;
});
