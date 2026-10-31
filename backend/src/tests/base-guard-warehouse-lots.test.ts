// «الوحدة الرئيسية» (B3a) — المستودع: (١) §2.8 مسار اللوط يقارن الأساس من صفوف lockLotProducts نفسها (assertBasesUnchanged)،
// فتحويلٌ التزم بين القراءة المسبقة والقفل ⇒ 409 PRODUCT_UNITS_CHANGED بلا حركة ولا تشغيلة ولا حدث، والمعاملة تتراجع.
// (٢) #13 (§2.6): بطاقة «في مخزون السيارات» تُقيِّم ما زاد على الطبقات بالمتوسّط غير المقرَّب، فلا يغيّر تحويل الأساس قيمتها.
// الموجّه الحقيقي routes/warehouse.ts فوق القاعدة المزيّفة lots-b3-fake.ts (نمط lots-d25-warehouse.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
const { composeWarehouse, summarizeVansStock } = require('../services/warehouseStock') as typeof import('../services/warehouseStock');
const { unitCostPerBase } = require('../services/warehouseCost') as typeof import('../services/warehouseCost');
/* eslint-enable @typescript-eslint/no-var-requires */

const ADMIN = { id: 'ADM', role: 'ADMIN', tenantId: 't1', name: 'المدير' };

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] }; handle: Function }

/** وسائط الموجّه (عدا المصادقة) ثم المسار ثم معالج أخطائه — كما يمشيها Express */
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

function fresh(): void {
  Object.assign(world, new World());
  world.product({ id: 'P1', name: 'ماء', unit: 'قارورة' });
  world.unit({ id: 'U-CT', productId: 'P1', name: 'كرتون', factor: 24 });
  world.track('P1');
  world.calls.length = 0;
}

/** convert-base يلتزم مباشرةً بعد القراءة المسبقة لأصناف الحركة — مرّةً واحدة */
function convertAfterPreRead(pid: string, newUnit: string): void {
  const pm = db.product as { findMany: (a: Row) => Promise<unknown> };
  const orig = pm.findMany;
  pm.findMany = async (a: Row) => {
    const out = await orig(a);
    pm.findMany = orig;
    world.products.find((p) => p.id === pid)!.unit = newUnit;
    return out;
  };
}

test('مسار اللوط (§2.8): أساسٌ تغيّر بين القراءة والقفل ⇒ 409 PRODUCT_UNITS_CHANGED بلا حركة ولا تشغيلة ولا حدث، والمعاملة تتراجع', async () => {
  for (const body of [
    { type: 'RECEIVE', items: [{ productId: 'P1', qty: 2, unitId: 'U-CT', unitCost: 30, lotNumber: 'A1', expiryDate: '2099-01-01' }] },
    { type: 'RECEIVE', items: [{ productId: 'P1', qty: 2, baseUnitName: 'قارورة', lotNumber: 'A1', expiryDate: '2099-01-01' }] },
  ]) {
    fresh();
    const before = [world.entries.length, world.lots.length, world.events.length];
    convertAfterPreRead('P1', 'شدّة');
    const r = await post(body);
    assert.deepEqual([r.status, r.body?.code], [409, 'PRODUCT_UNITS_CHANGED'], JSON.stringify(r.body));
    assert.match(String(r.body?.message), /«ماء»/);
    assert.deepEqual([world.entries.length, world.lots.length, world.events.length], before);
    const ops = world.calls.map((c) => c.op);
    assert.ok(ops.includes('tx.rollback') && !ops.includes('warehouseEntry.create'), ops.join(' '));
    // القفل واحد: صفوف lockLotProducts تحمل الأساس، فلا FOR KEY SHARE ثانٍ في مسار اللوط
    assert.equal(world.calls.filter((c) => c.op === 'query' && String(c.sql ?? '').includes('FOR KEY SHARE')).length, 1);
    assert.match(String(world.calls.find((c) => String(c.sql ?? '').includes('FOR KEY SHARE'))!.sql), /^SELECT id, unit, "lotTracked"/);
  }
  // والأساس نفسه ⇒ مسار اللوط كما كان
  fresh();
  const ok = await post({ type: 'RECEIVE', items: [{ productId: 'P1', qty: 2, baseUnitName: 'قارورة', lotNumber: 'A1', expiryDate: '2099-01-01' }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(world.lots.length, 1);
});

test('#13: ما زاد على طبقات السيارة يُقيَّم بالمتوسّط غير المقرَّب — تحويل الكرتون (16.33) إلى ٨ قوارير لا يغيّر قيمة البطاقة', () => {
  const P = [{ id: 'a', name: 'ماء', code: 'a', unit: 'u' }];
  // قبل التحويل: الأساس كرتون — ثلاثة بـ16.33، و١٠٠ كرتون في السيارة بلا طبقات (مرتجع عملاء / ما سبق النظام)
  const rawBefore = new Map<string, number>();
  composeWarehouse(P, [{ productId: 'a', qty: 3, type: 'RECEIVE', unitCost: 16.33 }], [], 2, new Map(), rawBefore);
  const before = summarizeVansStock([{ repId: 'r', products: [{ productId: 'a', remaining: 100, unsellable: 0 }] }], new Map(), rawBefore, 2);
  // بعد التحويل: الأساس قارورة — الصفّ نفسه بلقطة كرتون ×٨ وتكلفته للكرتون (حدّ القراءة يقسمها بلا تقريب)، والسيارة ٨٠٠ قارورة
  const rawAfter = new Map<string, number>();
  const rows = composeWarehouse(P, [{ productId: 'a', qty: 24, type: 'RECEIVE', unitCost: unitCostPerBase(16.33, { unitFactor: 8 }) }], [], 2, new Map(), rawAfter);
  const after = summarizeVansStock([{ repId: 'r', products: [{ productId: 'a', remaining: 800, unsellable: 0 }] }], new Map(), rawAfter, 2);
  assert.equal(before.value, 1633);
  assert.equal(after.value, 1633, 'المقرَّب (2.0413 × ٨٠٠ = 1633.04) كان يغيّر البطاقة بمجرّد التحويل');
  assert.equal(rawAfter.get('a'), 16.33 / 8);
  assert.equal(rows[0].avgCost, 2.0413, 'المقرَّب يبقى للعرض في الصفّ كما كان');
  // ومستدعٍ لا يطلبه (opening.ts، المستودع) صفّه كما كان حرفياً
  const plain = composeWarehouse(P, [{ productId: 'a', qty: 3, type: 'RECEIVE', unitCost: 16.33 }], [], 2);
  assert.deepEqual(Object.keys(plain[0]).includes('primaryUnitId'), false);
});

test('#13 نصّاً: GET /warehouse/vans يمرّر خريطة المتوسّط غير المقرَّب إلى summarizeVansStock لا avgCost الصفوف', () => {
  const w = fs.readFileSync(path.join(SRC, 'routes/warehouse.ts'), 'utf8').replace(/\r\n/g, '\n');
  const vans = w.slice(w.indexOf("router.get('/vans'"), w.indexOf('const entrySchema'));
  assert.ok(vans.includes('const avgCost = new Map<string, number>();'));
  assert.ok(vans.includes('composeWarehouse(inputs.products, inputs.whItems, inputs.vanItems, dec, layers, avgCost);'));
  assert.ok(!vans.includes('r.avgCost'), 'لا متوسّطٌ مقرَّب في التقييم');
});
