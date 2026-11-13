// «ربط الدفاتر» L1 (وكيل B5): المرتجع للمورّد (حركة مستودع RETURN بكميات سالبة) في «تتبّع اللوط» — فوق القاعدة المزيّفة
// lots-b3-fake.ts التي تجيب تجميعات SQL في lotsDb.ts من صفوفها، فيمرّ الطيّ والعروض والأقفال بمسارها الحقيقي.
// ما يُحرس: أسطر RETURN تُنقص خام التشغيلة ورصيد الصنف في المستودع كالتسوية السالبة، وخطة اللوط (planWarehouseEntryInTx) للنوع
// RETURN هي خطة ADJUST سالبة حرفياً — التشغيلة الصريحة ≤ صالحها، والسطر بلا تشغيلة بالأقرب انتهاءً، والفوق 409 — وسطرٌ موجب
// في مرتجع LOT_QTY_INVALID لا تشغيلةٌ تُنشأ أو تُزاد، وغير المتتبَّع بلا لوط ولا فحص كما كان.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { World, dateOf, type Row } from './lots-b3-fake';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

const world = new World();
stub('config/database', { default: world.db });

/* eslint-disable @typescript-eslint/no-var-requires */
const lotsW = require('../services/lotsWarehouse') as typeof import('../services/lotsWarehouse');
const lotsDb = require('../services/lotsDb') as typeof import('../services/lotsDb');
const { LotError } = require('../services/lots') as typeof import('../services/lots');
/* eslint-enable @typescript-eslint/no-var-requires */

type PlanInput = Parameters<typeof lotsW.planWarehouseEntryInTx>[1];
type PlanLine = PlanInput['lines'][number];

/** عالمٌ جديد: P1 متتبَّع، وP3 غير متتبَّع */
function fresh(): void {
  Object.assign(world, new World());
  world.product({ id: 'P1', name: 'ماء' });
  world.product({ id: 'P3', name: 'سكر' });
  world.track('P1');
}
function stock(pid: string, lotNumber: string, qty: number, extra: Row = {}): string {
  const l = world.lots.find((x) => x.productId === pid && x.lotNumber === lotNumber) ?? world.lot({ id: `L-${lotNumber}`, productId: pid, lotNumber, ...extra });
  world.entry('RECEIVE', [{ productId: pid, qty, lotId: l.id }]);
  return l.id;
}
const line = (idx: number, productId: string, qty: number, extra: Partial<PlanLine> = {}): PlanLine =>
  ({ idx, productId, productName: productId === 'P1' ? 'ماء' : 'سكر', shelfLifeOn: false, qty, ...extra });

/** خطة اللوط داخل معاملة القاعدة المزيّفة (المعاملة تتراجع عند الرمي) */
async function plan(type: PlanInput['type'], lines: PlanLine[], allowUnknown = true) {
  return world.db.$transaction((tx: Row) => lotsW.planWarehouseEntryInTx(tx as never, {
    tenantId: world.tid, type, actor: 'ADMIN', createdBy: 'المدير', day: '2026-11-13', allowUnknown, lines,
  }));
}
async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) { assert.ok(e instanceof LotError, String(e)); return (e as InstanceType<typeof LotError>).code; }
}
/** خام التشغيلة ورصيد الصنف كما تعرضهما placeViews بالطيّ الحقيقي */
async function view(pid: string) {
  const v = await lotsDb.placeViews(world.db as never, world.tid, { warehouse: true, productIds: [pid], withTotals: true });
  return v.warehouse.get(pid)!;
}

test('وارد ثم RETURN على تشغيلته ⇒ خام التشغيلة ورصيد الصنف يَنقصان كالتسوية السالبة تماماً', async () => {
  fresh();
  const A = stock('P1', 'A', 100);
  world.entry('RETURN', [{ productId: 'P1', qty: -30, lotId: A }]);
  const ret = await view('P1');
  assert.equal(ret.lots.find((l) => l.lotId === A)!.raw.SELLABLE, 70);
  assert.equal(world.warehouseRaw(A), 70);
  // رصيد الصنف من المجاميع (warehouseOnHandAgg) = composeWarehouse.onHand
  assert.equal(lotsDb.warehouseOnHandAgg(await lotsDb.aggWarehouseTotals(world.db as never, world.tid, { productIds: ['P1'] })).get('P1'), 70);
  // والعالم نفسه بتسويةٍ سالبة مماثلة يعطي العرض نفسه
  fresh();
  const A2 = stock('P1', 'A', 100);
  world.entry('ADJUST', [{ productId: 'P1', qty: -30, lotId: A2 }]);
  const adj = await view('P1');
  assert.deepEqual(
    { lots: ret.lots.map((l) => [l.lotId, l.raw, l.usable]), unknown: ret.unknownUsable },
    { lots: adj.lots.map((l) => [l.lotId, l.raw, l.usable]), unknown: adj.unknownUsable },
  );
});

test('خطة RETURN = خطة ADJUST السالبة: التشغيلة الصريحة ≤ صالحها، والفوق 409 LOT_STOCK_INSUFFICIENT، ومعاً بالتجميع', async () => {
  fresh();
  const A = stock('P1', 'A', 10);
  for (const type of ['RETURN', 'ADJUST'] as const) {
    const ok = await plan(type, [line(0, 'P1', -6, { lotId: A }), line(1, 'P1', -4, { lotId: A })]);
    assert.deepEqual([...ok.lotIdByLine], [[0, A], [1, A]], type);
    assert.equal(await codeOf(plan(type, [line(0, 'P1', -6, { lotId: A }), line(1, 'P1', -6, { lotId: A })])), 'LOT_STOCK_INSUFFICIENT', type);
    assert.equal(await codeOf(plan(type, [line(0, 'P1', -11, { lotId: A })])), 'LOT_STOCK_INSUFFICIENT', type);
  }
  // الخطة لا تكتب: الخام كما هو
  assert.equal(world.warehouseRaw(A), 10);
});

test('خطة RETURN بلا تشغيلة: سحبٌ تلقائي بالأقرب انتهاءً أولاً وسطرٌ فوق تشغيلته يُقسم — كالتسوية', async () => {
  fresh();
  const A = stock('P1', 'A', 10);
  const B = stock('P1', 'B', 4, { expiryDate: dateOf('2027-01-01') });
  const r = await plan('RETURN', [line(0, 'P1', -6)]);
  const a = await plan('ADJUST', [line(0, 'P1', -6)]);
  assert.deepEqual(r.splitByLine && [...r.splitByLine], [[0, [{ lotId: B, qty: 4 }, { lotId: A, qty: 2 }]]]);
  assert.deepEqual([...r.lotIdByLine], [...a.lotIdByLine]);
  assert.deepEqual(r.splitByLine && [...r.splitByLine], a.splitByLine && [...a.splitByLine]);
  assert.equal(await codeOf(plan('RETURN', [line(0, 'P1', -15)])), 'LOT_STOCK_INSUFFICIENT');
});

test('سطرٌ موجب في RETURN لصنفٍ متتبَّع ⇒ LOT_QTY_INVALID ولا تشغيلة تُنشأ؛ وغير المتتبَّع بلا لوط ولا فحص كما كان', async () => {
  fresh();
  const A = stock('P1', 'A', 10);
  const lotsBefore = world.lots.length;
  assert.equal(await codeOf(plan('RETURN', [line(0, 'P1', 5, { lotNumber: 'NEW' })])), 'LOT_QTY_INVALID');
  assert.equal(await codeOf(plan('RETURN', [line(0, 'P1', -2, { lotId: A }), line(1, 'P1', 1, { lotId: A })])), 'LOT_QTY_INVALID');
  assert.equal(world.lots.length, lotsBefore, 'لا تشغيلة من مرتجع');
  // والتسوية الموجبة كما كانت مقبولة (الفرق في RETURN وحده)
  assert.equal(await codeOf(plan('ADJUST', [line(0, 'P1', 1, { lotId: A })])), 'OK');
  // غير المتتبَّع: lotId null بلا فحص رصيد (المستودع السالب جائزٌ له كما كان)
  const u = await plan('RETURN', [line(0, 'P3', -50)]);
  assert.deepEqual([...u.lotIdByLine], [[0, null]]);
  assert.equal(u.tracked.has('P3'), false);
});

test('خطة RETURN بلا غير المسمّى المسموح ⇒ LOT_REQUIRED لسطرٍ صريحٍ بغير المسمّى كالتسوية', async () => {
  fresh();
  stock('P1', 'A', 10);
  world.entry('ADJUST', [{ productId: 'P1', qty: 5, lotId: null }]);
  assert.equal(await codeOf(plan('RETURN', [line(0, 'P1', -2, { lotId: null })], false)), 'LOT_REQUIRED');
  assert.equal(await codeOf(plan('ADJUST', [line(0, 'P1', -2, { lotId: null })], false)), 'LOT_REQUIRED');
  assert.equal(await codeOf(plan('RETURN', [line(0, 'P1', -2, { lotId: null })], true)), 'OK');
});
