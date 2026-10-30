// «تتبّع اللوط» — D25 في المسار غير المتتبَّع لحركات المستودع (البوابة B-d25-guards): الموجّه الحقيقي routes/warehouse.ts فوق القاعدة
// المزيّفة lots-b3-fake.ts. القراءة المسبقة رأت أصناف الحركة غير متتبَّعة، ثم التزم تفعيل تتبّع أحدها قبل الكتابة: تسويةٌ بالنقص بلا
// lotId تُنزل غير المسمّى دون الصفر (I2) وتُبقي لتشغيلته صالحاً وهمياً. الحارس إعادة قراءة التتبّع FOR KEY SHARE في معاملة الكتابة
// ⇒ 503 LOT_BUSY TRACKING_CHANGED فيُعاد بمسار اللوط؛ والميزة المطفأة كما كانت حرفياً (§١٠.١).
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

/** يشغّل وسائط الموجّه (عدا المصادقة) ثم المسار ثم معالج أخطائه — كما يمشيها Express (نمط lots-warehouse.test.ts) */
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

/** عالمٌ جديد: P3 غير متتبَّع برصيد ١٠ غير مسمّى في المستودع قبل أي تتبّع */
function fresh(): void {
  Object.assign(world, new World());
  world.product({ id: 'P3', name: 'سكر' });
  world.entry('RECEIVE', [{ productId: 'P3', qty: 10, lotId: null }]);
  world.calls.length = 0;
}

/** يلتزم تفعيل تتبّع P3 مباشرةً بعد القراءة المسبقة لأصناف الحركة (product.findMany) — مرّةً واحدة، ويبقى بعد تراجع المعاملة */
function trackAfterPreRead(): void {
  const pm = db.product as { findMany: (a: Row) => Promise<unknown> };
  const orig = pm.findMany;
  pm.findMany = async (a: Row) => {
    const out = await orig(a);
    pm.findMany = orig;
    world.track('P3');
    return out;
  };
}

const ops = () => world.calls.map((c) => c.op);

test('D25 (المستودع): تسويةٌ بالنقص لصنفٍ صار متتبَّعاً بين القراءة المسبقة والكتابة ⇒ 503 LOT_BUSY TRACKING_CHANGED بلا حركة، والإعادة بمسار اللوط', async () => {
  fresh();
  const n = world.entries.length;
  trackAfterPreRead();
  const r = await post({ type: 'ADJUST', items: [{ productId: 'P3', qty: -4 }] });
  assert.deepEqual([r.status, r.body?.code, r.body?.detail?.reason, r.body?.detail?.productIds], [503, 'LOT_BUSY', 'TRACKING_CHANGED', ['P3']], JSON.stringify(r.body));
  assert.equal(world.entries.length, n, 'كُتبت تسويةٌ بلا تشغيلة لصنفٍ متتبَّع');
  assert.ok(!ops().includes('warehouseEntry.create'));
  assert.ok(!world.calls.some((c) => c.op === 'exec' && String(c.sql ?? '').includes('pg_advisory_xact_lock')), 'لا قفل لوط في المسار غير المتتبَّع');
  // الإعادة تقرأ الصنف متتبَّعاً فتأخذ الطابور والقفل والخطة (D10: غير المسمّى مصدرٌ وحيد ⇒ يُستعمل تلقائياً)
  world.calls.length = 0;
  const again = await post({ type: 'ADJUST', items: [{ productId: 'P3', qty: -4 }] });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.ok(world.calls.some((c) => c.op === 'exec' && String(c.sql ?? '').includes('pg_advisory_xact_lock')), `الإعادة لم تأخذ مسار اللوط: ${ops().join(' ')}`);
});

test('D25 (المستودع) §١٠.٢: بلا تبديل والميزة مفعّلة ⇒ إنشاءٌ واحد كما كان بعد إعادة قراءة التتبّع وحدها في معاملةٍ بلا مهلة جديدة، وlotId فارغ', async () => {
  fresh();
  world.txOpts.length = 0;
  const r = await post({ type: 'ADJUST', items: [{ productId: 'P3', qty: -50 }] });
  assert.equal(r.status, 201, 'المستودع السالب جائزٌ لغير المتتبَّع كما كان');
  assert.deepEqual(ops(), ['product.findMany', 'tx.begin', 'query', 'warehouseEntry.create', 'tx.commit']);
  assert.match(String(world.calls[2].sql), /SELECT id, "lotTracked" FROM products .*FOR KEY SHARE/);
  assert.deepEqual(world.txOpts, [undefined], 'بلا مهلة اللوط (D13)');
  const last = world.items.filter((i) => i.entryId === world.entries[world.entries.length - 1].id);
  assert.deepEqual(last.map((i) => i.lotId), [null]);
});

test('D25 (المستودع) §١٠.١: الميزة مطفأة ⇒ إنشاءٌ واحد كما كان حرفياً — بلا معاملة ولا إعادة قراءة', async () => {
  fresh();
  world.lotsEnabled = false;
  const r = await post({ type: 'ADJUST', items: [{ productId: 'P3', qty: -4 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(ops(), ['product.findMany', 'warehouseEntry.create']);
});
