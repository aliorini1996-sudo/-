// «ربط الدفاتر» L8 (A10) — مخزن المطابقة بـPrisma (store.prisma.ts) فوق Prisma مزيّف في الذاكرة: سطور الذمة بمتبقّيها
// (علاقة الحساب الرقابي، المرحّل وحده، العزل بالشركة)، والقيد الحيّ بقاعدة REPOST، والتخصيصات المنتظرة RI/CA من لقطة
// حمولة السند، والإدراج متساوي الأثر، وFIFO — ثم E8.1/E8.3 كاملين بـreconcileAfterPost على هذا المخزن.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrismaReconcileStore, liveMoveIdsOf } from '../services/gl/reconcile/store.prisma';
import { reconcileAfterPost } from '../services/gl/reconcile/apply';
import type { GlDb } from '../services/gl/resolve';
import { FakeDb } from './l458-a10-fake-db';
import { M } from './l458-a10-mem-reconcile-store';

const T1 = 'tenant-1';
const T2 = 'tenant-2';
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

function seed(): FakeDb {
  const db = new FakeDb();
  db.insert('glSettings', [{ tenantId: T1, currencyDecimals: 2 }]);
  db.insert('glAccount', [
    { id: 'ar', tenantId: T1, code: '113001', controlKind: 'AR' },
    { id: 'cash', tenantId: T1, code: '111003', controlKind: 'CUSTODY' },
    { id: 'rev', tenantId: T1, code: '411001', controlKind: null },
    { id: 'ar2', tenantId: T2, code: '113001', controlKind: 'AR' },
  ]);
  const t0 = new Date('2026-11-14T08:00:00Z').getTime();
  db.insert('glMove', [
    { id: 'M-INV', tenantId: T1, state: 'POSTED', createdAt: new Date(t0), reversedMoveId: null },
    { id: 'M-R', tenantId: T1, state: 'POSTED', createdAt: new Date(t0 + 1000), reversedMoveId: null },
  ]);
  db.insert('glMoveSource', [
    { tenantId: T1, sourceKey: 'INVOICE:INV-1001:POST', moveId: 'M-INV' },
    { tenantId: T1, sourceKey: 'RECEIPT:R-x:POST', moveId: 'M-R' },
  ]);
  db.insert('glMoveLine', [
    { id: 'L1', tenantId: T1, moveId: 'M-INV', seq: 0, accountId: 'ar', customerId: 'C', vendorId: null, debitMilli: M(575), creditMilli: 0n, date: D('2026-11-14'), dueDate: D('2026-12-14'), posted: true },
    { id: 'L2', tenantId: T1, moveId: 'M-INV', seq: 1, accountId: 'ar', customerId: 'C', vendorId: null, debitMilli: M(575), creditMilli: 0n, date: D('2026-11-14'), dueDate: D('2027-01-13'), posted: true },
    { id: 'L3', tenantId: T1, moveId: 'M-INV', seq: 2, accountId: 'rev', customerId: null, vendorId: null, debitMilli: 0n, creditMilli: M(1150), date: D('2026-11-14'), dueDate: null, posted: true },
    { id: 'R1', tenantId: T1, moveId: 'M-R', seq: 0, accountId: 'cash', customerId: null, vendorId: null, debitMilli: M(600), creditMilli: 0n, date: D('2026-11-20'), dueDate: null, posted: true },
    { id: 'R2', tenantId: T1, moveId: 'M-R', seq: 1, accountId: 'ar', customerId: 'C', vendorId: null, debitMilli: 0n, creditMilli: M(600), date: D('2026-11-20'), dueDate: null, posted: true },
  ]);
  db.insert('invoice', [{ id: 'INV-1001', tenantId: T1, total: 1150, remainingAmt: 550 }]);
  db.insert('receipt', [{ id: 'R-x', tenantId: T1 }]);
  db.insert('receiptInvoice', [{ id: 'x', receiptId: 'R-x', invoiceId: 'INV-1001', amount: 600 }]);
  db.insert('glSourceEvent', [{
    tenantId: T1, sourceKey: 'RECEIPT:R-x:POST', status: 'DONE',
    payload: { allocations: [{ id: 'x', invoiceId: 'INV-1001', amount: '600.00' }] },
  }]);
  return db;
}

test('controlLinesOfMove: سطور الذمة المرحّلة ذات الشريك بمتبقّيها، بلا سطور غير رقابية ولا شركة أخرى', async () => {
  const db = seed();
  const store = createPrismaReconcileStore(db.client() as unknown as GlDb, T1);
  const ls = await store.controlLinesOfMove('M-INV', 'AR');
  assert.deepEqual(ls.map((l) => [l.lineId, l.side, l.amountMilli, l.residualMilli, l.dueDate, l.partnerId]), [
    ['L1', 'DEBIT', M(575), M(575), '2026-12-14', 'C'], ['L2', 'DEBIT', M(575), M(575), '2027-01-13', 'C'],
  ]);
  assert.deepEqual(await store.controlLinesOfMove('M-INV', 'AP'), []);
  for (const c of db.calls) assert.ok(JSON.stringify(c.args, (_k, v) => (typeof v === 'bigint' ? String(v) : v)).includes(T1), `${c.model}.${c.method} بلا tenantId`);
});

test('E8.1 ثم E8.3 على مخزن Prisma: المطابقة ثم الفكّ، وإعادة الاستدعاء متساوية الأثر', async () => {
  const db = seed();
  const store = createPrismaReconcileStore(db.client() as unknown as GlDb, T1);
  const input = { sourceType: 'RECEIPT' as const, sourceId: 'R-x', event: 'POST' as const, moveId: 'M-R',
    payload: { allocations: [{ id: 'x', invoiceId: 'INV-1001', amount: '600.00' }] } as never };
  assert.deepEqual(await reconcileAfterPost(store, input), { created: 2, removed: 0 });
  const rows = db.table('glPartialReconcile');
  assert.deepEqual(rows.map((r) => [r.tenantId, r.debitLineId, r.creditLineId, r.debitMoveId, r.creditMoveId, r.amountMilli, r.sourceRef, r.createdBy]), [
    [T1, 'L1', 'R2', 'M-INV', 'M-R', M(575), 'RI:x', 'SYSTEM'], [T1, 'L2', 'R2', 'M-INV', 'M-R', M(25), 'RI:x', 'SYSTEM'],
  ]);
  assert.deepEqual(await reconcileAfterPost(store, input), { created: 0, removed: 0 });
  assert.equal(rows.length, 2);

  // E8.3: عكس السند
  db.insert('glMove', [{ id: 'M-RV', tenantId: T1, state: 'POSTED', createdAt: new Date(), reversedMoveId: 'M-R' }]);
  db.insert('glMoveLine', [
    { id: 'V1', tenantId: T1, moveId: 'M-RV', seq: 0, accountId: 'cash', customerId: null, vendorId: null, debitMilli: 0n, creditMilli: M(600), date: D('2026-11-25'), dueDate: null, posted: true },
    { id: 'V2', tenantId: T1, moveId: 'M-RV', seq: 1, accountId: 'ar', customerId: 'C', vendorId: null, debitMilli: M(600), creditMilli: 0n, date: D('2026-11-25'), dueDate: null, posted: true },
  ]);
  const rev = await reconcileAfterPost(store, { sourceType: 'RECEIPT', sourceId: 'R-x', event: 'REVERSE', moveId: 'M-RV', reversedMoveId: 'M-R', payload: null });
  assert.deepEqual(rev, { created: 1, removed: 2 });
  assert.deepEqual(db.table('glPartialReconcile').map((r) => [r.debitLineId, r.creditLineId, r.amountMilli, r.sourceRef]), [['V2', 'R2', M(600), 'REV:M-RV']]);
  const inv = await store.controlLinesOfMove('M-INV', 'AR');
  assert.equal(inv.reduce((a, l) => a + l.residualMilli, 0n), M(1150));
});

test('liveMoveIdsOf: آخر REPOST غير معكوس هو الحيّ، والمعكوس كلياً لا حيّ له', async () => {
  const db = new FakeDb();
  const t = (ms: number) => new Date(1_700_000_000_000 + ms);
  db.insert('glMove', [
    { id: 'A', tenantId: T1, state: 'POSTED', createdAt: t(1), reversedMoveId: null },
    { id: 'A-rev', tenantId: T1, state: 'POSTED', createdAt: t(2), reversedMoveId: 'A' },
    { id: 'B', tenantId: T1, state: 'POSTED', createdAt: t(3), reversedMoveId: null },
    { id: 'C', tenantId: T1, state: 'POSTED', createdAt: t(4), reversedMoveId: null },
    { id: 'C-rev', tenantId: T1, state: 'POSTED', createdAt: t(5), reversedMoveId: 'C' },
  ]);
  db.insert('glMoveSource', [
    { tenantId: T1, sourceKey: 'INVOICE:i:POST', moveId: 'A' },
    { tenantId: T1, sourceKey: 'INVOICE:i:POST:REPOST_REV:1', moveId: 'A-rev' },
    { tenantId: T1, sourceKey: 'INVOICE:i:POST:REPOST:1', moveId: 'B' },
    { tenantId: T1, sourceKey: 'INVOICE:j:POST', moveId: 'C' },
    { tenantId: T1, sourceKey: 'INVOICE:j:REVERSE', moveId: 'C-rev' },
    { tenantId: T2, sourceKey: 'INVOICE:k:POST', moveId: 'A' },
  ]);
  const live = await liveMoveIdsOf(db.client() as unknown as GlDb, T1, ['INVOICE:i:POST', 'INVOICE:j:POST', 'INVOICE:k:POST']);
  assert.deepEqual([...live.entries()], [['INVOICE:i:POST', 'B']]);
});

test('pendingAllocationsForInvoice: RI من حمولة السند المرحَّل بباقيه، وCA من شطب نشط، وفاتورة لم يُسقط منها شيء بلا مسح للتخصيصات', async () => {
  const db = seed();
  db.insert('customerAdjustment', [{ id: 'ADJ', tenantId: T1, status: 'ACTIVE', moveId: 'M-WO' }, { id: 'ADJ2', tenantId: T1, status: 'CANCELLED', moveId: 'M-X' }]);
  db.insert('customerAdjustmentAllocation', [
    { id: 'al1', tenantId: T1, adjustmentId: 'ADJ', invoiceId: 'INV-1001', amount: 100.004 },
    { id: 'al2', tenantId: T1, adjustmentId: 'ADJ2', invoiceId: 'INV-1001', amount: 5 },
  ]);
  db.insert('glPartialReconcile', [{ id: 'p0', tenantId: T1, sourceRef: 'RI:x', amountMilli: M(100), debitLineId: 'L1', creditLineId: 'R2', debitMoveId: 'M-INV', creditMoveId: 'M-R' }]);
  const store = createPrismaReconcileStore(db.client() as unknown as GlDb, T1);
  const pending = await store.pendingAllocationsForInvoice('INV-1001');
  assert.deepEqual(pending.map((p) => [p.sourceRef, p.creditMoveId, p.amountMilli]), [['RI:x', 'M-R', M(500)], ['CA:al1', 'M-WO', M(100)]]);

  // فاتورة لم يُسقط منها شيء: لا قراءة لـreceiptInvoice
  db.insert('invoice', [{ id: 'INV-0', tenantId: T1, total: 50, remainingAmt: 50 }]);
  db.calls = [];
  assert.deepEqual(await store.pendingAllocationsForInvoice('INV-0'), []);
  assert.deepEqual(db.calls.map((c) => `${c.model}.${c.method}`), ['invoice.findFirst']);
  // فاتورة شركة أخرى
  db.insert('invoice', [{ id: 'INV-T2', tenantId: T2, total: 50, remainingAmt: 0 }]);
  assert.deepEqual(await store.pendingAllocationsForInvoice('INV-T2'), []);
});

test('insertPartials متساوي الأثر وdeletePartials بالشركة، وopenLinesOfPartner يعيد المفتوح وحده', async () => {
  const db = seed();
  const store = createPrismaReconcileStore(db.client() as unknown as GlDb, T1);
  const row = { debitLineId: 'L1', creditLineId: 'R2', debitMoveId: 'M-INV', creditMoveId: 'M-R', amountMilli: M(10), sourceRef: 'FIFO:L1' };
  assert.equal(await store.insertPartials([row]), 1);
  assert.equal(await store.insertPartials([row, { ...row, amountMilli: 0n }]), 0);
  const open = await store.openLinesOfPartner!('AR', 'C', 'CREDIT');
  assert.deepEqual(open.map((l) => [l.lineId, l.residualMilli]), [['R2', M(590)]]);
  const ids = (await store.partialsOfMoves(['M-R'])).map((p) => p.id);
  db.insert('glPartialReconcile', [{ id: 'other', tenantId: T2, sourceRef: 'X', amountMilli: 1n, debitLineId: 'a', creditLineId: 'b' }]);
  assert.equal(await store.deletePartials([...ids, 'other']), 1);
  assert.equal(db.table('glPartialReconcile').length, 1, 'صفّ الشركة الأخرى باقٍ');
});

test('بلا N+1: سند مخصّص لثلاث فواتير ⇒ استعلام واحد للقيود الحيّة وواحد لسطورها مهما كثرت التخصيصات', async () => {
  const db = seed();
  const t0 = new Date('2026-11-14T08:00:00Z').getTime();
  for (const k of [2, 3]) {
    db.insert('glMove', [{ id: `M-INV${k}`, tenantId: T1, state: 'POSTED', createdAt: new Date(t0 + k), reversedMoveId: null }]);
    db.insert('glMoveSource', [{ tenantId: T1, sourceKey: `INVOICE:INV-${k}:POST`, moveId: `M-INV${k}` }]);
    db.insert('glMoveLine', [{ id: `I${k}`, tenantId: T1, moveId: `M-INV${k}`, seq: 0, accountId: 'ar', customerId: 'C', vendorId: null, debitMilli: M(10), creditMilli: 0n, date: D('2026-11-14'), dueDate: null, posted: true }]);
  }
  const store = createPrismaReconcileStore(db.client() as unknown as GlDb, T1);
  db.calls = [];
  const out = await reconcileAfterPost(store, { sourceType: 'RECEIPT', sourceId: 'R-x', event: 'POST', moveId: 'M-R',
    payload: { allocations: [
      { id: 'a1', invoiceId: 'INV-1001', amount: '100.00' }, { id: 'a2', invoiceId: 'INV-2', amount: '10.00' }, { id: 'a3', invoiceId: 'INV-3', amount: '10.00' },
    ] } as never });
  assert.deepEqual(out, { created: 3, removed: 0 });
  const n = (m: string, method: string) => db.calls.filter((c) => c.model === m && c.method === method).length;
  assert.equal(n('glMoveSource', 'findMany'), 1, 'القيود الحيّة دفعةً');
  // سطور قيد السند + سطور الفواتير الثلاث دفعةً واحدة
  assert.equal(n('glMoveLine', 'findMany'), 2);
  assert.equal(n('glPartialReconcile', 'createMany'), 3);
});
