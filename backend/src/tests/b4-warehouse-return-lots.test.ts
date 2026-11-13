// «ربط الدفاتر» L1 (B4) — مرتجع المورّد وإلغاء الوارد مع «تتبّع اللوط»: المرتجع يخرج من **لوط سطره الأصلي** بخطة النقص نفسها
// (planWarehouseEntryInTx بنوع RETURN، كتسوية إنقاصٍ سالبة)، فلا يتجاوز صالح التشغيلة (LOT_STOCK_INSUFFICIENT) ولا المتبقّي من سطره
// (RETURN_EXCEEDS_RECEIVED). فوق القاعدة المزيّفة للوط lots-b3-fake.ts (طيّ وعروض وأقفال حقيقية من الصفوف)، وجداول الموردين تُكمَل هنا.
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

// ═══ ما لا تعرفه قاعدة اللوط المزيّفة: أعمدة «ربط الدفاتر» على الحركة والبند، وقراءاتها، وكشف المورّد ═══
let ledger: Row[] = [];
const ENTRY_COLS = ['vendorId', 'source', 'paymentMode', 'paidAccountRef', 'supplierRef', 'billDate', 'dueDate', 'costsIncludeTax', 'vatTreatment',
  'reason', 'status', 'returnOfEntryId', 'netMilli', 'taxMilli', 'totalMilli', 'supplier', 'note', 'createdBy', 'clientRef'] as const;
const ENTRY_DEFAULTS: Row = { source: 'MANUAL', status: 'POSTED', costsIncludeTax: false };
const ITEM_EXTRA = ['taxPct', 'enteredUnitCost', 'lineRef'] as const;
const entryRow = (e: Row): Row => ({ tenantId: world.tid, ...Object.fromEntries(ENTRY_COLS.map((k) => [k, e[k] ?? ENTRY_DEFAULTS[k] ?? null])), ...e });
const itemRow = (i: Row): Row => ({ ...Object.fromEntries(ITEM_EXTRA.map((k) => [k, i[k] ?? null])), ...i });
const project = (row: Row, sel: Row | undefined): Row => (sel ? Object.fromEntries(Object.keys(sel).filter((k) => sel[k]).map((k) => [k, row[k] ?? null])) : row);
const withItems = (e: Row, a: Row): Row => {
  const items = world.items.filter((i) => i.entryId === e.id).map((i) => itemRow(i as unknown as Row));
  if (a.select) return { ...project(entryRow(e), { ...a.select, items: false }), items: items.map((i) => project(i, a.select.items?.select)) };
  return { ...entryRow(e), items: items.map((i) => ({ ...i, product: { id: i.productId, name: i.productId, unit: 'حبة', primaryUnitId: null } })), vendor: null };
};
const matchEntry = (e: Row, w: Row): boolean => Object.entries(w).every(([k, v]) => {
  const x = entryRow(e)[k];
  if (v && typeof v === 'object' && 'not' in v) return x !== (v as Row).not;
  if (v && typeof v === 'object' && 'in' in v) return ((v as Row).in as unknown[]).includes(x);
  return x === v;
});
const origCreate = db.warehouseEntry.create as (a: Row) => Promise<Row>;
db.warehouseEntry.create = async (a: Row) => {
  const before = world.items.length;
  const out = await origCreate(a);
  const e = world.entries[world.entries.length - 1] as unknown as Row;
  for (const k of ENTRY_COLS) if (a.data[k] !== undefined) e[k] = a.data[k];
  (a.data.items.create as Row[]).forEach((c, k) => {
    const it = world.items[before + k] as unknown as Row;
    for (const x of ITEM_EXTRA) if (c[x] !== undefined) it[x] = c[x];
  });
  return out;
};
db.warehouseEntry.findFirst = async (a: Row) => {
  const e = world.entries.find((x) => matchEntry(x as unknown as Row, a.where));
  return e ? withItems(e as unknown as Row, a) : null;
};
db.warehouseEntry.findMany = async (a: Row) => world.entries.filter((x) => matchEntry(x as unknown as Row, a.where)).map((e) => withItems(e as unknown as Row, a));
db.warehouseEntry.update = async (a: Row) => {
  const e = world.entries.find((x) => x.id === a.where.id) as unknown as Row;
  Object.assign(e, a.data);
  return e;
};
db.supplierLedgerEntry = {
  create: async (a: Row) => { ledger.push(a.data); return a.data; },
  findMany: async () => [],
};
db.supplierPayment = { findFirst: async () => null };
db.supplierPaymentAllocation = { findMany: async () => [] };
const origTx = db.$transaction as (fn: (tx: Row) => Promise<unknown>, o?: unknown) => Promise<unknown>;
db.$transaction = async (fn: (tx: Row) => Promise<unknown>, o?: unknown) => {
  const snap = [...ledger];
  try { return await origTx(fn, o); } catch (e) { ledger = snap; throw e; }
};

/* eslint-disable @typescript-eslint/no-var-requires */
const router = (require('../routes/warehouse') as typeof import('../routes/warehouse')).default;
const { authenticate } = require('../middleware/auth') as typeof import('../middleware/auth');
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */

const ADMIN = { id: 'ADM', role: 'ADMIN', tenantId: 't1', name: 'المدير' };
interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] }; handle: Function }
async function call(p: string, req: Row): Promise<{ status: number; body: Row }> {
  const stack = (router as unknown as { stack: Layer[] }).stack;
  const layer = stack.find((l) => l.route?.path === p && l.route.methods.post)!;
  const pre = stack.filter((l) => !l.route && l.handle.length < 4 && l.handle !== authenticate).map((l) => l.handle);
  const errHandlers = [...stack.filter((l) => !l.route && l.handle.length === 4).map((l) => l.handle), errorHandler];
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = JSON.parse(JSON.stringify(b)); return res; };
  const full = { method: 'POST', query: {}, params: {}, body: {}, headers: {}, user: ADMIN, ...req };
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

/** عالمٌ بصنفٍ متتبَّع ولوطين، ووارد آجل مصنَّف من مورّد: ٦ من LA و٤ من LB بعشرين صافياً و١٥٪ */
function fresh(): { billId: string; itemA: string; itemB: string } {
  Object.assign(world, new World());
  ledger = [];
  world.lotsEnabled = true;
  world.product({ id: 'T1', name: 'حليب', taxPct: 15 });
  world.track('T1');
  world.lot({ id: 'LA', productId: 'T1', lotNumber: 'A-1' });
  world.lot({ id: 'LB', productId: 'T1', lotNumber: 'B-1' });
  const bill = world.entry('RECEIVE', [{ productId: 'T1', qty: 6, lotId: 'LA' }, { productId: 'T1', qty: 4, lotId: 'LB' }]) as unknown as Row;
  Object.assign(bill, {
    vendorId: 'V1', paymentMode: 'CREDIT', billDate: new Date('2026-11-01T00:00:00Z'), supplierRef: 'INV-1', vatTreatment: 'RECOVERABLE',
    netMilli: 200_000n, taxMilli: 30_000n, totalMilli: 230_000n,
  });
  const items = world.items.filter((i) => i.entryId === bill.id) as unknown as Row[];
  for (const i of items) Object.assign(i, { unitCost: 20, taxPct: 15, enteredUnitCost: 20 });
  return { billId: bill.id as string, itemA: items[0].id as string, itemB: items[1].id as string };
}

test('المرتجع للصنف المتتبَّع يخرج من لوط سطره الأصلي (لا بالأقرب انتهاءً) بخطة النقص، وقيده RETURN بسعر السطر', async () => {
  const { billId, itemB } = fresh();
  assert.deepEqual([world.warehouseRaw('LA'), world.warehouseRaw('LB')], [6, 4]);
  const r = await call('/entries/:id/return', { params: { id: billId }, body: { items: [{ itemId: itemB, qty: 3 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ret = world.entries.find((e) => e.type === 'RETURN')! as unknown as Row;
  assert.equal(ret.returnOfEntryId, billId);
  assert.deepEqual(world.items.filter((i) => i.entryId === ret.id).map((i) => [i.lotId, i.qty, i.baseQty, i.unitCost]), [['LB', -3, -3, 20]]);
  assert.deepEqual([world.warehouseRaw('LA'), world.warehouseRaw('LB')], [6, 1], 'LB وحده نقص');
  assert.deepEqual(ledger.map((l) => [l.kind, l.amountMilli, l.warehouseEntryId]), [['RETURN', -69_000n, ret.id]], '3 × 20 + 15٪ = 69');
  // خطة اللوط بنوع RETURN وتحت قفل الأصناف وطابورها (مسار اللوط لا المسار القائم)
  const ops = world.calls.map((c) => c.op);
  assert.ok(ops.includes('tx.begin') && world.txOpts.some((o) => (o as Row)?.timeout === 20_000), 'مهلة معاملة اللوط');
});

test('حارس التشغيلة: لوط السطر خرج منه للسيارة فلا يُردّ للمورّد فوق صالحه (LOT_STOCK_INSUFFICIENT) — والمتبقّي من السطر يحكم أيضاً', async () => {
  const { billId, itemA } = fresh();
  world.vanMove('LOAD', 'R1', 'T1', 5, 'LA');
  assert.equal(world.warehouseRaw('LA'), 1);
  const short = await call('/entries/:id/return', { params: { id: billId }, body: { items: [{ itemId: itemA, qty: 2 }] } });
  assert.equal(short.status, 409, JSON.stringify(short.body));
  assert.equal(short.body.code, 'LOT_STOCK_INSUFFICIENT');
  assert.equal(world.entries.filter((e) => e.type === 'RETURN').length, 0, 'لا حركة');
  assert.equal(ledger.length, 0, 'ولا قيد');
  const ok = await call('/entries/:id/return', { params: { id: billId }, body: { items: [{ itemId: itemA, qty: 1 }] } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  // المتبقّي من سطر LA صار ٥ ولو عاد اللوط من السيارة
  world.vanMove('UNLOAD', 'R1', 'T1', 5, 'LA');
  const over = await call('/entries/:id/return', { params: { id: billId }, body: { items: [{ itemId: itemA, qty: 6 }] } });
  assert.equal(over.body.code, 'RETURN_EXCEEDS_RECEIVED');
});

test('الإلغاء مع اللوط: مرتجعٌ كامل لكل سطرٍ من لوطه، والوارد CANCELLED، والإجمالي المتبقّي من الفاتورة', async () => {
  const { billId, itemA } = fresh();
  await call('/entries/:id/return', { params: { id: billId }, body: { items: [{ itemId: itemA, qty: 2 }] } });
  const r = await call('/entries/:id/cancel', { params: { id: billId }, body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const bill = world.entries.find((e) => e.id === billId)! as unknown as Row;
  assert.equal(bill.status, 'CANCELLED');
  assert.deepEqual([world.warehouseRaw('LA'), world.warehouseRaw('LB')], [0, 0]);
  const rets = world.entries.filter((e) => e.type === 'RETURN') as unknown as Row[];
  assert.deepEqual(world.items.filter((i) => i.entryId === rets[1].id).map((i) => [i.lotId, i.qty]), [['LA', -4], ['LB', -4]]);
  // 230 − 46 (مرتجع ٢) = 184
  assert.deepEqual(ledger.map((l) => l.amountMilli), [-46_000n, -184_000n]);
});
