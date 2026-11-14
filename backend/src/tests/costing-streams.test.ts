// «ربط الدفاتر» L3 — مصادر محرّك التكلفة (services/costing/streams.ts، العقد §6): كل صفّ في جدول §6.1 وكل حالة في §6.2،
// والدمج k-طريقي (أحجام الصفحات 1 و3 و2000 = القراءة الواحدة حرفياً، والمؤشّر لا يتخطّى صفاً)، وثبات تحويل الأساس.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMoves, type CostingDb } from '../services/costing/streams';
import { replay, stateTotals } from '../services/costing/stepper';
import { glImpactOf } from '../services/costing/accounts';
import { planStockZero, warehouseBalancesOf } from '../services/stockZero';
import type { WhTotalAgg } from '../services/lotsDb';
import {
  restockToggleKey, returnCancelKey, returnKey, saleCancelKey, saleOutKey, vanItemKey, whItemKey,
} from '../services/costing/keys';
import type { LoadMovesOptions, LoadMovesResult, Move } from '../services/costing/types';
import { DAMAGED_VAN_SINCE } from '../services/vanDamaged';
import { CASH_VOID_KEEP_COLLECTION_NOTE } from '../lib/ledgerNotes';
import { CostingFakeDb, asPrisma } from './costing-fake-db';

const FAR = new Date('2030-01-01T00:00:00.000Z');

function load(db: CostingFakeDb, opts: Partial<LoadMovesOptions> = {}, tenantId = 't1'): Promise<LoadMovesResult> {
  return loadMoves(asPrisma<CostingDb>(db), tenantId, { until: FAR, currencyDecimals: 2, ...opts });
}

function only(moves: Move[], key: string): Move {
  const m = moves.filter((x) => x.key === key);
  assert.equal(m.length, 1, `حركة واحدة بالمفتاح ${key} (وُجد ${m.length})`);
  return m[0];
}

function warn(r: LoadMovesResult, code: string): { count: number; sample: string[] } | undefined {
  const w = r.warnings.find((x) => x.code === code);
  return w ? { count: w.count, sample: w.sample } : undefined;
}

// ═══ §6.1 — warehouse_entry_items ═══

test('RECEIVE موجب مسعَّر: قيمة السطر بوحدته toMilli(qty×unitCost)، المستودع، المؤشّر والأثر لحظة الحركة الأب', async () => {
  const db = new CostingFakeDb();
  const e = db.addWarehouseEntry({ type: 'RECEIVE', items: [{ productId: 'A', qty: 100, unitCost: 20 }, { productId: 'B', qty: 3, unitCost: 0.3333 }] });
  const r = await load(db);
  const a = only(r.moves, whItemKey(e.itemIds[0]));
  assert.equal(a.kind, 'RECEIVE');
  assert.equal(a.location, 'WH');
  assert.equal(a.baseQty, 100);
  assert.equal(a.inValueMilli, 2_000_000n);
  assert.deepEqual(a.cursor, { createdAt: e.createdAt, id: e.id });
  assert.equal(a.effectAt.getTime(), e.createdAt.getTime());
  assert.equal(a.refType, 'WH_ENTRY');
  assert.equal(a.refId, e.id);
  assert.equal(a.itemId, e.itemIds[0]);
  // المثال ج: 3 × 0.3333 = 0.9999 ⇒ 1.00 بمنزلتين = 1,000 ملّي
  assert.equal(only(r.moves, whItemKey(e.itemIds[1])).inValueMilli, 1_000n);
  assert.deepEqual(r.sourceRows, { WH_ENTRY: 2, VAN_LOAD: 0, INVOICE: 0, RESTOCK_LOG: 0 });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.cursor, { createdAt: e.createdAt, id: e.id });
  assert.equal(r.truncated, false);
});

test('RECEIVE بلا سعر (أو بسعر صفري) ⇒ inValueMilli = null (يدخل «خارج التقييم»)', async () => {
  const db = new CostingFakeDb();
  const e = db.addWarehouseEntry({ items: [{ productId: 'A', qty: 5, unitCost: null }, { productId: 'B', qty: 5, unitCost: 0 }] });
  const r = await load(db);
  assert.equal(only(r.moves, whItemKey(e.itemIds[0])).inValueMilli, null);
  assert.equal(only(r.moves, whItemKey(e.itemIds[1])).inValueMilli, null);
});

test('RECEIVE سالب (قديم) ⇒ WH_ADJUST بالكمية نفسها + تحذير NEGATIVE_RECEIVE', async () => {
  const db = new CostingFakeDb();
  const e = db.addWarehouseEntry({ items: [{ productId: 'A', qty: -4, unitCost: 7 }] });
  const r = await load(db);
  const m = only(r.moves, whItemKey(e.itemIds[0]));
  assert.equal(m.kind, 'WH_ADJUST');
  assert.equal(m.baseQty, -4);
  assert.equal(m.inValueMilli, undefined);
  assert.deepEqual(warn(r, 'NEGATIVE_RECEIVE'), { count: 1, sample: [e.itemIds[0]] });
});

test('RETURN للمورّد (L1) ⇒ VENDOR_RETURN بـ−|q| أياً كانت إشارة السطر المخزَّنة', async () => {
  const db = new CostingFakeDb();
  const e = db.addWarehouseEntry({ type: 'RETURN', items: [{ productId: 'A', qty: 6, unitCost: 5 }, { productId: 'B', qty: -2, unitCost: 5 }] });
  const r = await load(db);
  const a = only(r.moves, whItemKey(e.itemIds[0]));
  assert.equal(a.kind, 'VENDOR_RETURN');
  assert.equal(a.baseQty, -6);
  assert.equal(a.location, 'WH');
  assert.equal(only(r.moves, whItemKey(e.itemIds[1])).baseQty, -2);
});

test('ADJUST بـzeroRunId ⇒ ZERO_RUN، وبلاه ⇒ WH_ADJUST بسبب الحركة (±)', async () => {
  const db = new CostingFakeDb();
  const z = db.addWarehouseEntry({ type: 'ADJUST', zeroRunId: 'zr1', items: [{ productId: 'A', qty: -10 }] });
  const a = db.addWarehouseEntry({ type: 'ADJUST', reason: 'DAMAGE', items: [{ productId: 'A', qty: -2 }, { productId: 'B', qty: 3 }] });
  const r = await load(db);
  const zm = only(r.moves, whItemKey(z.itemIds[0]));
  assert.equal(zm.kind, 'ZERO_RUN');
  assert.equal(zm.baseQty, -10);
  assert.equal(zm.location, 'WH');
  const am = only(r.moves, whItemKey(a.itemIds[0]));
  assert.equal(am.kind, 'WH_ADJUST');
  assert.equal(am.reason, 'DAMAGE');
  assert.equal(am.baseQty, -2);
  assert.equal(only(r.moves, whItemKey(a.itemIds[1])).baseQty, 3);
});

// ═══ §6.1 — van_load_items ═══

test('LOAD موجب ⇒ VAN_LOAD (WH ⇒ VAN:rep)، وسطر LOAD سالب ⇒ VAN_UNLOAD (VAN ⇒ WH) بـ−|q|', async () => {
  const db = new CostingFakeDb();
  const v = db.addVanLoad({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'A', qty: 30 }, { productId: 'B', qty: -4 }] });
  const r = await load(db);
  const a = only(r.moves, vanItemKey(v.itemIds[0]));
  assert.equal(a.kind, 'VAN_LOAD');
  assert.equal(a.location, 'WH');
  assert.equal(a.toLocation, 'VAN:r1');
  assert.equal(a.baseQty, -30);
  assert.equal(a.refType, 'VAN_LOAD');
  assert.deepEqual(a.cursor, { createdAt: v.createdAt, id: v.id });
  const b = only(r.moves, vanItemKey(v.itemIds[1]));
  assert.equal(b.kind, 'VAN_UNLOAD');
  assert.equal(b.location, 'VAN:r1');
  assert.equal(b.toLocation, 'WH');
  assert.equal(b.baseQty, -4);
});

test('UNLOAD موجب ⇒ VAN_UNLOAD، وسطر UNLOAD سالب ⇒ VAN_LOAD', async () => {
  const db = new CostingFakeDb();
  const v = db.addVanLoad({ salesRepId: 'r1', type: 'UNLOAD', items: [{ productId: 'A', qty: 20 }, { productId: 'B', qty: -5 }] });
  const r = await load(db);
  const a = only(r.moves, vanItemKey(v.itemIds[0]));
  assert.deepEqual([a.kind, a.location, a.toLocation, a.baseQty], ['VAN_UNLOAD', 'VAN:r1', 'WH', -20]);
  const b = only(r.moves, vanItemKey(v.itemIds[1]));
  assert.deepEqual([b.kind, b.location, b.toLocation, b.baseQty], ['VAN_LOAD', 'WH', 'VAN:r1', -5]);
});

test('تسوية السيارة: بـzeroRunId ⇒ ZERO_RUN على السيارة، وبلاه ⇒ VAN_ADJUST بسببها', async () => {
  const db = new CostingFakeDb();
  const z = db.addVanLoad({ salesRepId: 'r1', type: 'ADJUST', zeroRunId: 'zr', items: [{ productId: 'A', qty: -7 }] });
  const a = db.addVanLoad({ salesRepId: 'r1', type: 'ADJUST', reason: 'SHORTAGE_REP', items: [{ productId: 'A', qty: -1 }] });
  const r = await load(db);
  const zm = only(r.moves, vanItemKey(z.itemIds[0]));
  assert.deepEqual([zm.kind, zm.location, zm.toLocation ?? null, zm.baseQty], ['ZERO_RUN', 'VAN:r1', null, -7]);
  const am = only(r.moves, vanItemKey(a.itemIds[0]));
  assert.deepEqual([am.kind, am.location, am.baseQty, am.reason], ['VAN_ADJUST', 'VAN:r1', -1, 'SHORTAGE_REP']);
});

test('DAMAGED_OUT/EXPIRED_OUT ⇒ DAMAGE_OUT بكمية صفرية وسببه نوع الحركة', async () => {
  const db = new CostingFakeDb();
  const d = db.addVanLoad({ salesRepId: 'r1', type: 'DAMAGED_OUT', items: [{ productId: 'A', qty: 3 }] });
  const e = db.addVanLoad({ salesRepId: 'r1', type: 'EXPIRED_OUT', items: [{ productId: 'A', qty: 2 }] });
  const r = await load(db);
  const dm = only(r.moves, vanItemKey(d.itemIds[0]));
  assert.deepEqual([dm.kind, dm.location, dm.baseQty, dm.reason], ['DAMAGE_OUT', 'VAN:r1', 0, 'DAMAGED_OUT']);
  assert.equal(only(r.moves, vanItemKey(e.itemIds[0])).reason, 'EXPIRED_OUT');
});

test('DAMAGED_OUT/EXPIRED_OUT كتبها «تصفير المخزون» (zeroRunId) ⇒ ZERO_RUN على السيارة (هدف مطلق) وسببه نوع الحركة', async () => {
  const db = new CostingFakeDb();
  const d = db.addVanLoad({ salesRepId: 'r1', type: 'DAMAGED_OUT', zeroRunId: 'zr', items: [{ productId: 'A', qty: 3 }] });
  const e = db.addVanLoad({ salesRepId: 'r1', type: 'EXPIRED_OUT', zeroRunId: 'zr', items: [{ productId: 'B', qty: 2 }] });
  const r = await load(db);
  const dm = only(r.moves, vanItemKey(d.itemIds[0]));
  assert.deepEqual([dm.kind, dm.location, dm.baseQty, dm.reason], ['ZERO_RUN', 'VAN:r1', -3, 'DAMAGED_OUT']);
  const em = only(r.moves, vanItemKey(e.itemIds[0]));
  assert.deepEqual([em.kind, em.location, em.baseQty, em.reason], ['ZERO_RUN', 'VAN:r1', -2, 'EXPIRED_OUT']);
  // سيارة بلا رصيد تكلفة (التالف والمنتهي مشطوبان يوم المرتجع) ⇒ لا أثر
  for (const o of replay(r.moves, { currencyDecimals: 2 }).outputs) assert.deepEqual([o.baseQty, o.valueMilli], [0, 0n]);
});

test('حركة سيارة بلا بنود (ولو بنوع مجهول) ⇒ لا حركة ولا تحذير — كما كانت القراءة بالبنود لا تراها', async () => {
  const db = new CostingFakeDb();
  db.addVanLoad({ salesRepId: 'r1', type: 'TRANSFER', items: [] });
  db.addVanLoad({ salesRepId: 'r1', type: 'LOAD', items: [] });
  db.addWarehouseEntry({ type: 'RECEIVE', items: [] });
  const r = await load(db);
  assert.deepEqual([r.moves, r.warnings, r.sourceRows], [[], [], { WH_ENTRY: 0, VAN_LOAD: 0, INVOICE: 0, RESTOCK_LOG: 0 }]);
});

test('نوع سيارة غير معروف ⇒ تخطٍّ + UNKNOWN_VAN_TYPE (معرّف الحركة)', async () => {
  const db = new CostingFakeDb();
  const v = db.addVanLoad({ salesRepId: 'r1', type: 'TRANSFER', items: [{ productId: 'A', qty: 3 }, { productId: 'B', qty: 1 }] });
  const r = await load(db);
  assert.equal(r.moves.length, 0);
  assert.deepEqual(warn(r, 'UNKNOWN_VAN_TYPE'), { count: 1, sample: [v.id] });
  assert.equal(r.sourceRows.VAN_LOAD, 2);
});

test('مندوب محذوف ⇒ VAN:<deletedSalesRepId>، وبلا أيّهما ⇒ VAN:_', async () => {
  const db = new CostingFakeDb();
  const v1 = db.addVanLoad({ salesRepId: null, deletedSalesRepId: 'gone7', type: 'LOAD', items: [{ productId: 'A', qty: 2 }] });
  const v2 = db.addVanLoad({ salesRepId: null, type: 'LOAD', items: [{ productId: 'A', qty: 1 }] });
  const r = await load(db);
  assert.equal(only(r.moves, vanItemKey(v1.itemIds[0])).toLocation, 'VAN:gone7');
  assert.equal(only(r.moves, vanItemKey(v2.itemIds[0])).toLocation, 'VAN:_');
});

// ═══ §6.1 — account_entries (الصف الأساسي) ═══

test('فاتورة نقدية لمندوب ⇒ VAN_SALE من سيارته بأثر entryDate؛ صفّ RECEIPT_CREDIT لا يُقرأ', async () => {
  const db = new CostingFakeDb();
  const inv = db.addInvoice({ type: 'CASH', salesRepId: 'r1', entryDate: '2026-03-04T00:00:00.000Z', items: [{ productId: 'A', qty: 10 }, { productId: 'B', qty: 2, unitFactor: 12 }] });
  const r = await load(db);
  const a = only(r.moves, saleOutKey(inv.itemIds[0]));
  assert.deepEqual([a.kind, a.location, a.baseQty, a.refType, a.refId], ['VAN_SALE', 'VAN:r1', -10, 'INVOICE', inv.id]);
  assert.equal(a.effectAt.toISOString(), '2026-03-04T00:00:00.000Z');
  assert.deepEqual(a.cursor, { createdAt: inv.createdAt, id: inv.entryId });
  assert.equal(only(r.moves, saleOutKey(inv.itemIds[1])).baseQty, -24, 'الكمية بالأساس (كرتونان × 12)');
  assert.equal(r.moves.length, 2);
  assert.equal(r.sourceRows.INVOICE, 1, 'صفّ RECEIPT_CREDIT خارج المصدر');
});

test('فاتورة إدارة بلا مندوب (OD8) ⇒ WAREHOUSE_SALE من المستودع', async () => {
  const db = new CostingFakeDb();
  const inv = db.addInvoice({ type: 'CREDIT', salesRepId: null, items: [{ productId: 'A', qty: 4 }] });
  const r = await load(db);
  const m = only(r.moves, saleOutKey(inv.itemIds[0]));
  assert.deepEqual([m.kind, m.location, m.baseQty], ['WAREHOUSE_SALE', 'WH', -4]);
});

test('إلغاء الفاتورة (INVOICE_CREDIT) ⇒ SALE_CANCEL +q بصلة البيع موقعاً وقيمة، وأثره لحظة صفّ الإلغاء', async () => {
  const db = new CostingFakeDb();
  const inv = db.addInvoice({ type: 'CREDIT', salesRepId: 'r1', items: [{ productId: 'A', qty: 10 }] });
  const cancelId = db.cancelInvoice(inv.id);
  const r = await load(db);
  const c = only(r.moves, saleCancelKey(inv.itemIds[0]));
  assert.equal(c.kind, 'SALE_CANCEL');
  assert.equal(c.baseQty, 10);
  assert.equal(c.location, 'VAN:r1');
  assert.deepEqual(c.links, { mirrorOf: saleOutKey(inv.itemIds[0]), locationOf: saleOutKey(inv.itemIds[0]) });
  const row = db.tables.accountEntry.find((x) => x.id === cancelId)!;
  assert.deepEqual(c.cursor, { createdAt: row.createdAt, id: cancelId });
  assert.equal(c.effectAt.getTime(), (row.entryDate as Date).getTime());
  // النقدية تعكس بصفّين (INVOICE_CREDIT + RECEIPT_DEBIT) — الثاني ليس من المصدر
  const cash = db.addInvoice({ type: 'CASH', salesRepId: 'r1', items: [{ productId: 'A', qty: 1 }] });
  db.cancelInvoice(cash.id);
  const r2 = await load(db);
  assert.equal(r2.moves.filter((m) => m.key === saleCancelKey(cash.itemIds[0])).length, 1);
});

test('إبطال ZATCA بإبقاء التحصيل (صفّ INVOICE_CREDIT وحده بوسم Q1) ⇒ SALE_CANCEL كالإلغاء', async () => {
  const db = new CostingFakeDb();
  const inv = db.addInvoice({ type: 'CASH', salesRepId: 'r2', items: [{ productId: 'A', qty: 3 }] });
  db.addAccountEntry({ invoiceId: inv.id, type: 'INVOICE_CREDIT', description: CASH_VOID_KEEP_COLLECTION_NOTE });
  const r = await load(db);
  const c = only(r.moves, saleCancelKey(inv.itemIds[0]));
  assert.deepEqual([c.kind, c.baseQty, c.location], ['SALE_CANCEL', 3, 'VAN:r2']);
});

test('الإشعار المدين (DEBIT_NOTE) ⇒ لا حركة ولا تحذير', async () => {
  const db = new CostingFakeDb();
  db.addInvoice({ type: 'CREDIT', documentKind: 'DEBIT_NOTE', salesRepId: 'r1', items: [{ productId: null, qty: 1 }] });
  const r = await load(db);
  assert.deepEqual(r.moves, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.sourceRows.INVOICE, 1);
});

test('بند بلا صنف ⇒ ITEM_WITHOUT_PRODUCT، وبند بكمية ≤ 0 ⇒ NON_POSITIVE_SALE_QTY، ونوع فاتورة مجهول ⇒ UNKNOWN_INVOICE_TYPE', async () => {
  const db = new CostingFakeDb();
  const inv = db.addInvoice({ type: 'CREDIT', salesRepId: 'r1', items: [{ productId: null, qty: 1 }, { productId: 'A', qty: 0 }, { productId: 'B', qty: 2 }] });
  const odd = db.addInvoice({ type: 'QUOTE', salesRepId: 'r1', items: [{ productId: 'A', qty: 1 }] });
  const r = await load(db);
  assert.equal(r.moves.length, 1);
  assert.equal(r.moves[0].key, saleOutKey(inv.itemIds[2]));
  assert.deepEqual(warn(r, 'ITEM_WITHOUT_PRODUCT'), { count: 1, sample: [inv.itemIds[0]] });
  assert.deepEqual(warn(r, 'NON_POSITIVE_SALE_QTY'), { count: 1, sample: [inv.itemIds[1]] });
  assert.deepEqual(warn(r, 'UNKNOWN_INVOICE_TYPE'), { count: 1, sample: [odd.entryId] });
  // ترتيب التحذيرات ثابت (ترتيب STREAM_WARNINGS)
  assert.deepEqual(r.warnings.map((w) => w.code), ['UNKNOWN_INVOICE_TYPE', 'ITEM_WITHOUT_PRODUCT', 'NON_POSITIVE_SALE_QTY']);
});

test('صفّ أساسي مكرّر للفاتورة والدور نفسيهما ⇒ الأقدم وحده، والأحدث DUPLICATE_PRIMARY_ROW', async () => {
  const db = new CostingFakeDb();
  const inv = db.addInvoice({ type: 'CREDIT', salesRepId: 'r1', items: [{ productId: 'A', qty: 5 }] });
  const dup = db.addAccountEntry({ invoiceId: inv.id, type: 'INVOICE_DEBIT' });
  const r = await load(db);
  const m = only(r.moves, saleOutKey(inv.itemIds[0]));
  assert.equal(m.cursor.id, inv.entryId);
  assert.deepEqual(warn(r, 'DUPLICATE_PRIMARY_ROW'), { count: 1, sample: [dup] });
  // الإلغاء دورٌ آخر — ليس مكرّراً
  db.cancelInvoice(inv.id);
  const r2 = await load(db);
  assert.equal(r2.moves.length, 2);
  assert.equal(warn(r2, 'DUPLICATE_PRIMARY_ROW')?.count, 1);
});

test('صفوف بسند (receiptId) أو بلا فاتورة أو بأنواع أخرى لا تُقرأ؛ وشركة أخرى لا تُرى', async () => {
  const db = new CostingFakeDb();
  const inv = db.addInvoice({ type: 'CREDIT', salesRepId: 'r1', items: [{ productId: 'A', qty: 5 }] });
  db.addAccountEntry({ invoiceId: inv.id, receiptId: 'rc1', type: 'INVOICE_DEBIT' });
  db.addAccountEntry({ invoiceId: null, type: 'ADJUSTMENT_DEBIT' });
  db.addAccountEntry({ invoiceId: inv.id, type: 'RECEIPT_CREDIT' });
  db.addInvoice({ tenantId: 't2', type: 'CREDIT', salesRepId: 'r1', items: [{ productId: 'A', qty: 9 }] });
  db.addReceipt('A', 5, 1, { tenantId: 't2' });
  const r = await load(db);
  assert.equal(r.moves.length, 1);
  assert.equal(r.sourceRows.INVOICE, 1);
  assert.deepEqual(r.warnings, []);
});

// ═══ §6.2 — المرتجع ═══

function saleAndReturn(db: CostingFakeDb, opts: {
  rep?: string | null; returnToStock?: boolean; returnReason?: string | null; at?: string; returnExpired?: boolean | null;
  documentKind?: string | null; link?: 'returnOf' | 'credited' | 'none';
} = {}) {
  const rep = opts.rep === undefined ? 'r1' : opts.rep;
  const sale = db.addInvoice({ type: 'CREDIT', salesRepId: rep, items: [{ productId: 'A', qty: 12 }] });
  const link = opts.link ?? 'returnOf';
  const ret = db.addInvoice({
    type: 'RETURN', salesRepId: rep, at: opts.at, returnToStock: opts.returnToStock ?? true, returnReason: opts.returnReason ?? 'NORMAL',
    documentKind: opts.documentKind ?? null,
    items: [{
      productId: 'A', qty: 2, returnExpired: opts.returnExpired ?? null,
      returnOfItemId: link === 'returnOf' ? sale.itemIds[0] : null, creditedItemId: link === 'credited' ? sale.itemIds[0] : null,
    }],
  });
  return { sale, ret, saleItem: sale.itemIds[0], retItem: ret.itemIds[0] };
}

test('مرتجع عائد لمندوب ⇒ VAN_RETURN_RESTOCK +q بصلة بيع البند الأصلي؛ وبلا مندوب ⇒ WAREHOUSE_RETURN_RESTOCK في المستودع', async () => {
  const db = new CostingFakeDb();
  const x = saleAndReturn(db);
  const y = saleAndReturn(db, { rep: null });
  const r = await load(db);
  const a = only(r.moves, returnKey(x.retItem));
  assert.deepEqual([a.kind, a.location, a.baseQty], ['VAN_RETURN_RESTOCK', 'VAN:r1', 2]);
  assert.deepEqual(a.links, { mirrorOf: saleOutKey(x.saleItem) });
  const b = only(r.moves, returnKey(y.retItem));
  assert.deepEqual([b.kind, b.location, b.baseQty], ['WAREHOUSE_RETURN_RESTOCK', 'WH', 2]);
});

test('الإشعار الدائن (المرحلة الثانية) نوعه RETURN ⇒ مرتجع صلته creditedItemId', async () => {
  const db = new CostingFakeDb();
  const x = saleAndReturn(db, { documentKind: 'CREDIT_NOTE', link: 'credited' });
  const r = await load(db);
  const m = only(r.moves, returnKey(x.retItem));
  assert.equal(m.kind, 'VAN_RETURN_RESTOCK');
  assert.deepEqual(m.links, { mirrorOf: saleOutKey(x.saleItem) });
});

test('مرتجع حرّ بلا بند بيع ⇒ mirrorOf = null (المحرّك يقيّمه بمتوسّط موقعه RETURN_UNLINKED)', async () => {
  const db = new CostingFakeDb();
  const x = saleAndReturn(db, { link: 'none' });
  const r = await load(db);
  assert.deepEqual(only(r.moves, returnKey(x.retItem)).links, { mirrorOf: null });
});

test('مرتجع لا يعود (returnToStock=false) ⇒ RETURN_WRITE_OFF بكمية صفرية وmemoQty وسبب NOT_RESTOCKED', async () => {
  const db = new CostingFakeDb();
  const x = saleAndReturn(db, { returnToStock: false });
  const r = await load(db);
  const m = only(r.moves, returnKey(x.retItem));
  assert.deepEqual([m.kind, m.baseQty, m.memoQty, m.reason, m.location], ['RETURN_WRITE_OFF', 0, 2, 'NOT_RESTOCKED', 'VAN:r1']);
  assert.deepEqual(m.links, { mirrorOf: saleOutKey(x.saleItem) });
});

test('تالف بعد DAMAGED_VAN_SINCE ⇒ مكتوب عليه (DAMAGED) ولو returnToStock=true؛ وقبله يعود كالعادي', async () => {
  const db = new CostingFakeDb();
  const after = saleAndReturn(db, { returnReason: 'DAMAGED', returnToStock: true, at: new Date(DAMAGED_VAN_SINCE.getTime() + 60_000).toISOString() });
  const db2 = new CostingFakeDb();
  db2.clock = new Date('2026-09-01T00:00:00.000Z').getTime();
  const before = saleAndReturn(db2, { returnReason: 'DAMAGED', returnToStock: true, at: new Date(DAMAGED_VAN_SINCE.getTime() - 60_000).toISOString() });
  const m = only((await load(db)).moves, returnKey(after.retItem));
  assert.deepEqual([m.kind, m.reason, m.memoQty], ['RETURN_WRITE_OFF', 'DAMAGED', 2]);
  const m2 = only((await load(db2)).moves, returnKey(before.retItem));
  assert.equal(m2.kind, 'VAN_RETURN_RESTOCK');
});

test('منتهي الصلاحية (returnExpired) ⇒ مكتوب عليه EXPIRED — يسبق التالف', async () => {
  const db = new CostingFakeDb();
  const x = saleAndReturn(db, { returnExpired: true, returnReason: 'DAMAGED', at: new Date(DAMAGED_VAN_SINCE.getTime() + 1000).toISOString() });
  const m = only((await load(db)).moves, returnKey(x.retItem));
  assert.deepEqual([m.kind, m.reason], ['RETURN_WRITE_OFF', 'EXPIRED']);
});

test('D15: الحالة الابتدائية = previous لأول سجلّ تبديل لا returnToStock الحالي، ثم التبديل حركة RESTOCK_TOGGLE', async () => {
  const db = new CostingFakeDb();
  const x = saleAndReturn(db, { returnToStock: true });
  const logId = db.toggleRestock(x.ret.id, false); // الحالي الآن false
  const r = await load(db);
  const ret = only(r.moves, returnKey(x.retItem));
  assert.equal(ret.kind, 'VAN_RETURN_RESTOCK', 'المرتجع عاد يوم إصداره');
  const t = only(r.moves, restockToggleKey(logId, x.retItem));
  assert.deepEqual([t.kind, t.baseQty, t.refType, t.refId, t.itemId], ['RESTOCK_TOGGLE', -2, 'RESTOCK_LOG', logId, x.retItem]);
  // memoOf = الأثر المشتقّ السابق للبند (هنا RET) — المحرّك يحكم به لا بحالة البند الحالية
  assert.deepEqual(t.links, { mirrorOf: null, locationOf: returnKey(x.retItem), memoOf: returnKey(x.retItem) });
  assert.equal(t.reason, undefined, 'البند العادي بلا سبب');
  const log = db.tables.invoiceRestockLog.find((l) => l.id === logId)!;
  assert.deepEqual(t.cursor, { createdAt: log.createdAt, id: logId });
  assert.equal(t.effectAt.getTime(), (log.createdAt as Date).getTime());
  assert.equal(r.sourceRows.RESTOCK_LOG, 1);
});

test('التبديل إلى «يعود» ⇒ +q بمرآة البيع وموقع المرتجع؛ وسجلّ لا يغيّر الحالة لا يُنتج حركة', async () => {
  const db = new CostingFakeDb();
  const x = saleAndReturn(db, { returnToStock: false });
  const on = db.toggleRestock(x.ret.id, true);
  const noop = db.toggleRestock(x.ret.id, true); // previous = true = returnToStock
  const r = await load(db);
  assert.equal(only(r.moves, returnKey(x.retItem)).kind, 'RETURN_WRITE_OFF');
  const t = only(r.moves, restockToggleKey(on, x.retItem));
  assert.equal(t.baseQty, 2);
  assert.deepEqual(t.links, { mirrorOf: saleOutKey(x.saleItem), locationOf: returnKey(x.retItem), memoOf: returnKey(x.retItem) });
  assert.equal(r.moves.filter((m) => m.key === restockToggleKey(noop, x.retItem)).length, 0);
  assert.deepEqual(r.warnings, []);
});

test('إلغاء مرتجع عائد ⇒ RETURN_CANCEL −q بموقع لقطة RET (والصلتان معاً: memoOf = آخر أثر = RET)', async () => {
  const db = new CostingFakeDb();
  const x = saleAndReturn(db);
  db.cancelInvoice(x.ret.id);
  const r = await load(db);
  const c = only(r.moves, returnCancelKey(x.retItem));
  assert.deepEqual([c.kind, c.baseQty, c.location], ['RETURN_CANCEL', -2, 'VAN:r1']);
  assert.deepEqual(c.links, { mirrorOf: null, locationOf: returnKey(x.retItem), memoOf: returnKey(x.retItem) });
});

test('إلغاء مرتجع مشطوب لم يتبدّل ⇒ RETURN_CANCEL بكمية صفرية (تخمين المصدر) وmemoOf = RET', async () => {
  const db = new CostingFakeDb();
  const x = saleAndReturn(db, { returnToStock: false });
  db.cancelInvoice(x.ret.id);
  const c = only((await load(db)).moves, returnCancelKey(x.retItem));
  assert.deepEqual([c.kind, c.baseQty], ['RETURN_CANCEL', 0]);
  assert.deepEqual(c.links, { mirrorOf: null, locationOf: returnKey(x.retItem), memoOf: returnKey(x.retItem) });
});

test('تبديلان ثم إلغاء: لا يعود ⇒ يعود ⇒ لا يعود ⇒ إلغاء — memoOf آخر تبديل، وكل تبديل يسمّي سابقه', async () => {
  const db = new CostingFakeDb();
  const x = saleAndReturn(db, { returnToStock: false });
  const l1 = db.toggleRestock(x.ret.id, true);
  const l2 = db.toggleRestock(x.ret.id, false);
  db.cancelInvoice(x.ret.id);
  const r = await load(db);
  const t1 = only(r.moves, restockToggleKey(l1, x.retItem));
  const t2 = only(r.moves, restockToggleKey(l2, x.retItem));
  assert.deepEqual([t1.baseQty, t1.links?.memoOf], [2, returnKey(x.retItem)]);
  assert.deepEqual([t2.baseQty, t2.links?.memoOf], [-2, restockToggleKey(l1, x.retItem)]);
  const c = only(r.moves, returnCancelKey(x.retItem));
  assert.equal(c.baseQty, 0);
  assert.deepEqual(c.links, { mirrorOf: null, locationOf: returnKey(x.retItem), memoOf: restockToggleKey(l2, x.retItem) });
});

test('تبديلان ثم إلغاء: يعود ⇒ لا يعود ⇒ يعود ⇒ إلغاء — عائدٌ لحظة الإلغاء ⇒ −q وmemoOf آخر تبديل', async () => {
  const db = new CostingFakeDb();
  const x = saleAndReturn(db, { returnToStock: true });
  db.toggleRestock(x.ret.id, false);
  const on = db.toggleRestock(x.ret.id, true);
  db.cancelInvoice(x.ret.id);
  const c = only((await load(db)).moves, returnCancelKey(x.retItem));
  assert.equal(c.baseQty, -2);
  assert.deepEqual(c.links, { mirrorOf: null, locationOf: returnKey(x.retItem), memoOf: restockToggleKey(on, x.retItem) });
});

test('تبديل بعد إلغاء المرتجع ⇒ TOGGLE_AFTER_CANCEL ويُتخطّى (والحالة لحظة الإلغاء لا تتأثّر به)', async () => {
  const db = new CostingFakeDb();
  const x = saleAndReturn(db, { returnToStock: true });
  db.cancelInvoice(x.ret.id);
  const late = db.toggleRestock(x.ret.id, false);
  const r = await load(db);
  assert.equal(r.moves.filter((m) => m.refType === 'RESTOCK_LOG').length, 0);
  assert.deepEqual(warn(r, 'TOGGLE_AFTER_CANCEL'), { count: 1, sample: [late] });
  assert.equal(only(r.moves, returnCancelKey(x.retItem)).baseQty, -2, 'كان عائداً لحظة الإلغاء');
});

test('المكتوب عليه (تالف/منتهٍ) لا يعود أبداً: أول تبديل إلى «لا يعود» وحده حركةٌ بلا أثر هنا، وإلغاؤه يعكس مذكِّرة RET', async () => {
  const db = new CostingFakeDb();
  const x = saleAndReturn(db, { returnExpired: true, returnToStock: true });
  const l = db.toggleRestock(x.ret.id, false);
  const on = db.toggleRestock(x.ret.id, true);
  const l3 = db.toggleRestock(x.ret.id, false);
  db.cancelInvoice(x.ret.id);
  const r = await load(db);
  // الأول وحده يُشتقّ (المحرّك يقرّر بلقطة RET: هنا مكتوبٌ عليه يوم إصداره ⇒ لا أثر)، وما بعده لا يُشتقّ للمكتوب عليه
  const t = only(r.moves, restockToggleKey(l, x.retItem));
  assert.deepEqual([t.baseQty, t.reason, t.links], [-2, 'EXPIRED', { mirrorOf: null, locationOf: returnKey(x.retItem), memoOf: returnKey(x.retItem) }]);
  for (const k of [on, l3]) assert.equal(r.moves.filter((m) => m.key === restockToggleKey(k, x.retItem)).length, 0);
  const c = only(r.moves, returnCancelKey(x.retItem));
  assert.deepEqual([c.baseQty, c.links], [0, { mirrorOf: null, locationOf: returnKey(x.retItem), memoOf: restockToggleKey(l, x.retItem) }]);
  const out = replay(r.moves, { currencyDecimals: 2 }).outputs;
  const by = new Map(out.map((o) => [o.key, o] as const));
  const ret = by.get(returnKey(x.retItem))!;
  assert.equal(ret.kind, 'RETURN_WRITE_OFF');
  assert.deepEqual([by.get(t.key)!.baseQty, by.get(t.key)!.valueMilli, by.get(t.key)!.memoMilli], [0, 0n, 0n], 'لا أثر: مشطوبٌ أصلاً');
  assert.equal(by.get(c.key)!.memoMilli, -ret.memoMilli, 'الإلغاء يعكس مذكِّرة RET (التبديل بلا أثر لا يحمل حالة)');
  assert.equal(by.get(c.key)!.baseQty, 0);
});

test('مرتجع لمندوب حُذف لاحقاً (salesRepId صار null) ⇒ يُعامل كمرتجع إدارة: المستودع (D14)', async () => {
  const db = new CostingFakeDb();
  const x = saleAndReturn(db, { rep: 'r1' });
  for (const inv of db.tables.invoice) inv.salesRepId = null;
  const r = await load(db);
  assert.equal(only(r.moves, saleOutKey(x.saleItem)).location, 'WH');
  assert.equal(only(r.moves, returnKey(x.retItem)).kind, 'WAREHOUSE_RETURN_RESTOCK');
});

// ═══ الدمج k-طريقي ═══

/** بيانات مختلطة: مصادر متشابكة زمنياً، وحركات متعددة البنود، وفواتير متعددة البنود، ومرتجعات وتبديلات وإلغاءات */
function mixedDb(): CostingFakeDb {
  const db = new CostingFakeDb();
  db.addWarehouseEntry({ items: [{ productId: 'A', qty: 100, unitCost: 20 }, { productId: 'B', qty: 50, unitCost: 3 }, { productId: 'C', qty: 7, unitCost: null }] });
  db.addVanLoad({ salesRepId: 'r1', items: [{ productId: 'A', qty: 30 }, { productId: 'B', qty: 10 }] });
  const s1 = db.addInvoice({ type: 'CASH', salesRepId: 'r1', items: [{ productId: 'A', qty: 3 }, { productId: 'B', qty: 1 }, { productId: null, qty: 1 }] });
  db.addWarehouseEntry({ items: [{ productId: 'A', qty: 50, unitCost: 23 }] });
  const ret = db.addInvoice({ type: 'RETURN', salesRepId: 'r1', items: [{ productId: 'A', qty: 1, returnOfItemId: s1.itemIds[0] }, { productId: 'B', qty: 1, returnOfItemId: s1.itemIds[1] }] });
  db.toggleRestock(ret.id, false);
  db.addVanLoad({ salesRepId: 'r2', items: [{ productId: 'A', qty: 5 }, { productId: 'B', qty: 5 }, { productId: 'C', qty: 2 }] });
  const s2 = db.addInvoice({ type: 'CREDIT', salesRepId: null, items: [{ productId: 'C', qty: 1 }] });
  db.toggleRestock(ret.id, true);
  db.cancelInvoice(s1.id);
  db.addWarehouseEntry({ type: 'ADJUST', reason: 'COUNT', items: [{ productId: 'B', qty: -1 }] });
  db.addAccountEntry({ invoiceId: s2.id, type: 'INVOICE_DEBIT' }); // مكرّر
  db.addVanLoad({ salesRepId: 'r1', type: 'UNLOAD', items: [{ productId: 'A', qty: 4 }, { productId: 'B', qty: 2 }] });
  db.cancelInvoice(ret.id);
  db.toggleRestock(ret.id, false); // بعد الإلغاء
  // صفوف بلحظة واحدة (معاملة واحدة) — الترتيب بالمعرّف
  const t = new Date(db.clock + 1000);
  db.addReceipt('D', 1, 1, { at: t });
  db.addVanLoad({ salesRepId: 'r3', at: t, items: [{ productId: 'D', qty: 1 }] });
  db.addInvoice({ type: 'CREDIT', salesRepId: 'r3', at: t, items: [{ productId: 'D', qty: 1 }] });
  return db;
}

test('الدمج: الصفحات بأحجام 1 و3 و2000 = القراءة الواحدة حرفياً (الحركات والمؤشّر والعدّ والتحذيرات)', async () => {
  const db = mixedDb();
  const full = await load(db, { pageSize: 2000 });
  assert.ok(full.moves.length > 20);
  for (const pageSize of [1, 2, 3, 7]) {
    const r = await load(db, { pageSize });
    assert.deepEqual(r, full, `pageSize=${pageSize}`);
  }
  // مرتّبة بـ(createdAt, id, key) — لا يسبق صفٌّ صفّاً
  for (let i = 1; i < full.moves.length; i++) {
    const a = full.moves[i - 1];
    const b = full.moves[i];
    const c = a.cursor.createdAt.getTime() - b.cursor.createdAt.getTime() || (a.cursor.id < b.cursor.id ? -1 : a.cursor.id > b.cursor.id ? 1 : 0) || (a.key < b.key ? -1 : 1);
    assert.ok(c < 0, `ترتيب ${a.key} ثم ${b.key}`);
  }
});

test('الدمج: دفعات maxMoves متتالية بـafterCursor = cursor ⇒ اتحادها = القراءة الكاملة (المؤشّر لا يتخطّى صفاً ولا يكرّره)', async () => {
  const db = mixedDb();
  const full = await load(db);
  for (const [maxMoves, pageSize] of [[1, 1], [2, 3], [5, 2], [3, 2000]] as const) {
    const got: Move[] = [];
    let after: LoadMovesResult['cursor'] = null;
    let rounds = 0;
    for (;;) {
      const r = await load(db, { afterCursor: after, maxMoves, pageSize });
      got.push(...r.moves);
      if (r.cursor) after = r.cursor;
      rounds++;
      assert.ok(rounds < 500);
      if (!r.truncated) break;
      assert.ok(r.moves.length >= maxMoves, 'لا توقّف قبل السقف');
    }
    // التحذير المكرّر «DUPLICATE_PRIMARY_ROW» قد يظهر في دفعة لاحقة بلا الصف الأقدم — الحركات نفسها لا تختلف هنا لأن
    // الصفّ المكرّر يقع في دفعة الأصل أو بعده (يحميه التفرّد في snapshots.ts)؛ نقارن المفاتيح المتفرّدة
    const keys = got.map((m) => m.key);
    const uniq = [...new Set(keys)];
    assert.deepEqual(uniq, full.moves.map((m) => m.key), `maxMoves=${maxMoves} pageSize=${pageSize}`);
  }
});

test('الدمج: حدّ until شامل لـcreatedAt، وafterCursor حصري بالمعرّف عند تساوي اللحظة', async () => {
  const db = new CostingFakeDb();
  const t = new Date('2026-05-01T10:00:00.000Z');
  const a = db.addWarehouseEntry({ at: t, id: 'we-a', items: [{ productId: 'A', qty: 1, unitCost: 1 }] });
  const b = db.addWarehouseEntry({ at: t, id: 'we-b', items: [{ productId: 'A', qty: 2, unitCost: 1 }] });
  db.addWarehouseEntry({ at: new Date(t.getTime() + 1), items: [{ productId: 'A', qty: 3, unitCost: 1 }] });
  const r = await load(db, { until: t });
  assert.deepEqual(r.moves.map((m) => m.refId), [a.id, b.id]);
  assert.deepEqual(r.cursor, { createdAt: t, id: 'we-b' });
  const r2 = await load(db, { until: t, afterCursor: { createdAt: t, id: 'we-a' } });
  assert.deepEqual(r2.moves.map((m) => m.refId), [b.id]);
  const r3 = await load(db, { until: t, afterCursor: r.cursor });
  assert.deepEqual(r3.moves, []);
  assert.equal(r3.cursor, null, 'لا شيء مقروء ⇒ null');
});

test('حركة مستودع ببنود أكثر من الصفحة لا تُشطر: صفّها يخرج كاملاً ولو بصفحة بند واحد', async () => {
  const db = new CostingFakeDb();
  const big = db.addWarehouseEntry({ items: Array.from({ length: 9 }, (_, i) => ({ productId: `P${i}`, qty: i + 1, unitCost: 2 })) });
  const inv = db.addInvoice({ type: 'CREDIT', salesRepId: 'r1', items: [{ productId: 'P1', qty: 1 }] });
  const r = await load(db, { pageSize: 1, maxMoves: 1 });
  assert.equal(r.moves.length, 9, 'الصفّ الأول كاملاً رغم السقف 1');
  assert.deepEqual(r.cursor, { createdAt: big.createdAt, id: big.id });
  assert.equal(r.truncated, true);
  const r2 = await load(db, { pageSize: 1, afterCursor: r.cursor });
  assert.deepEqual(r2.moves.map((m) => m.key), [saleOutKey(inv.itemIds[0])]);
  assert.equal(r2.truncated, false);
});

test('منازل عملة غير مدعومة ⇒ يرمي قبل أي قراءة؛ وpageSize غير صالح ⇒ يرمي', async () => {
  const db = new CostingFakeDb();
  await assert.rejects(load(db, { currencyDecimals: 4 }), RangeError);
  await assert.rejects(load(db, { pageSize: 0 }), RangeError);
  assert.equal(db.ops.length, 0);
});

test('الاستعلامات مجمّعة: لا N+1 — عدد الاستعلامات لا يتبع عدد الفواتير في الصفحة', async () => {
  const db = new CostingFakeDb();
  for (let i = 0; i < 60; i++) {
    const s = db.addInvoice({ type: 'CREDIT', salesRepId: 'r1', items: [{ productId: 'A', qty: 1 }, { productId: 'B', qty: 2 }] });
    const ret = db.addInvoice({ type: 'RETURN', salesRepId: 'r1', items: [{ productId: 'A', qty: 1, returnOfItemId: s.itemIds[0] }] });
    db.toggleRestock(ret.id, false);
  }
  db.ops.length = 0;
  const r = await load(db);
  assert.equal(r.moves.length, 60 * 2 + 60 + 60);
  // 4 مصادر × صفحة واحدة + فواتير وبنودها (×2 من مصدرين) + سجلّات (×2) + إلغاءات (×1)
  assert.ok(db.ops.length <= 12, `استعلامات: ${db.ops.length}`);
  assert.ok(db.ops.every((o) => !o.write), 'قراءة فقط');
});

// ═══ ثبات تحويل الأساس ═══

test('ثبات تحويل الأساس: وارد 10 كراتين×24 @ 240 = 240 حبّة @ 10 ⇒ inValueMilli واحد واللقطات نفسها', async () => {
  const build = (carton: boolean) => {
    const db = new CostingFakeDb();
    db.addWarehouseEntry({ id: 'we-1', items: [carton ? { id: 'wi-1', productId: 'A', qty: 10, unitFactor: 24, unitCost: 240 } : { id: 'wi-1', productId: 'A', qty: 240, unitCost: 10 }] });
    db.addVanLoad({ id: 'vl-1', salesRepId: 'r1', items: [carton ? { id: 'vi-1', productId: 'A', qty: 5, unitFactor: 24 } : { id: 'vi-1', productId: 'A', qty: 120 }] });
    db.addInvoice({ id: 'in-1', type: 'CASH', salesRepId: 'r1', items: [carton ? { id: 'ii-1', productId: 'A', qty: 1, unitFactor: 24 } : { id: 'ii-1', productId: 'A', qty: 24 }] });
    db.addInvoice({ id: 'in-2', type: 'RETURN', salesRepId: 'r1', items: [{ id: 'ii-2', productId: 'A', qty: 7, returnOfItemId: 'ii-1' }] });
    return db;
  };
  const a = await load(build(true));
  const b = await load(build(false));
  assert.equal(a.moves[0].inValueMilli, 2_400_000n);
  assert.deepEqual(a.moves, b.moves);
  const ra = replay(a.moves, { currencyDecimals: 2 });
  const rb = replay(b.moves, { currencyDecimals: 2 });
  assert.deepEqual(ra.outputs, rb.outputs);
  assert.equal(ra.outputs[1].valueMilli, -1_200_000n, 'تحميل 120 حبّة @ 10');
  assert.equal(ra.outputs[2].valueMilli, -240_000n, 'بيع 24 حبّة @ 10');
});

// ═══ شكل الاستعلامات: مؤشّر مفتاحي على أعمدة الجدول نفسه (لا علاقة) ═══

interface Call { model: string; args: Record<string, unknown> }
const COSTING_MODELS = ['warehouseEntry', 'warehouseEntryItem', 'vanLoad', 'vanLoadItem', 'accountEntry', 'invoice', 'invoiceItem', 'invoiceRestockLog'] as const;

/** عميلٌ يسجّل وسائط كل findMany ثم يمرّرها إلى القاعدة المزيّفة */
function recording(db: CostingFakeDb): { client: CostingDb; calls: Call[] } {
  const calls: Call[] = [];
  const client = Object.fromEntries(COSTING_MODELS.map((m) => [m, {
    findMany: (args: Record<string, unknown>) => {
      calls.push({ model: m, args });
      return (db[m] as unknown as { findMany(a: unknown): Promise<unknown[]> }).findMany(args);
    },
  }]));
  return { client: client as unknown as CostingDb, calls };
}

/** كل مفاتيح كائنٍ متداخل (لكشف فلترٍ أو ترتيبٍ على حقل علاقة) */
function deepKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) deepKeys(x, out);
  else if (v && typeof v === 'object' && !(v instanceof Date)) {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      deepKeys(x, out);
    }
  }
  return out;
}

test('مصدرا البنود بالأب: مؤشّر مفتاحي على (tenantId, createdAt, id) ثم البنود بـIN — لا ترتيب ولا فلتر على حقل علاقة (لا صفحات تربيعية)', async () => {
  const db = mixedDb();
  for (let i = 0; i < 9; i++) db.addVanLoad({ salesRepId: 'r9', items: [{ productId: 'A', qty: 1 }, { productId: 'B', qty: 1 }] });
  for (let i = 0; i < 4; i++) db.addReceipt('E', 1, 1);
  const full = await load(db);
  const { client, calls } = recording(db);
  const r = await loadMoves(client, 't1', { until: FAR, currencyDecimals: 2, pageSize: 3 });
  assert.deepEqual(r, full, 'الناتج لا يتعلّق بالصفحة');
  // ترتيبٌ أو فلترٌ على علاقة (entry.createdAt…) يولّد ربطاً يسارياً وترتيباً لا يخدمه فهرس ويمسح جداول كل الشركات
  for (const c of calls) {
    const keys = deepKeys([c.args.where, c.args.orderBy]);
    for (const rel of ['entry', 'vanLoad', 'invoice', 'items']) assert.ok(!keys.has(rel), `${c.model}: علاقة ${rel} في الاستعلام`);
  }
  const parents = calls.filter((c) => c.model === 'warehouseEntry' || c.model === 'vanLoad');
  assert.ok(parents.filter((c) => c.model === 'vanLoad').length >= 4, 'صفحات آباء عدّة');
  for (const c of parents) {
    assert.deepEqual(c.args.orderBy, [{ createdAt: 'asc' }, { id: 'asc' }]);
    assert.equal(c.args.take, 3);
    const w = c.args.where as { tenantId: string; createdAt: Record<string, Date>; OR?: unknown[] };
    assert.equal(w.tenantId, 't1');
    assert.deepEqual(Object.keys(w.createdAt).sort(), w.OR ? ['gte', 'lte'] : ['lte'], 'بداية المسح من موضع المؤشّر في الفهرس');
  }
  // البنود بـIN بالمفتاح الأجنبي وحده، وكل أبٍ تُقرأ بنوده مرةً واحدة
  for (const [model, fk, parentModel] of [['warehouseEntryItem', 'entryId', 'warehouseEntry'], ['vanLoadItem', 'vanLoadId', 'vanLoad']] as const) {
    const loaded: string[] = [];
    for (const c of calls.filter((x) => x.model === model)) {
      const w = c.args.where as Record<string, { in: string[] }>;
      assert.deepEqual(Object.keys(w), [fk]);
      assert.ok(w[fk].in.length >= 1);
      loaded.push(...w[fk].in);
    }
    const all = db.tables[parentModel].filter((p) => p.tenantId === 't1').map((p) => p.id as string);
    assert.deepEqual([...loaded].sort(), [...all].sort(), `${model}: كل أبٍ مرةً واحدة`);
  }
});

test('دفعة بسقف maxMoves لا تقرأ بنود آباءٍ لن تخرج فيها (computeSnapshots: صفحة آباء لكل دفعة)', async () => {
  const db = new CostingFakeDb();
  for (let i = 0; i < 40; i++) db.addVanLoad({ salesRepId: 'r1', items: [{ productId: 'A', qty: 1 }, { productId: 'B', qty: 1 }] });
  const { client, calls } = recording(db);
  const r = await loadMoves(client, 't1', { until: FAR, currencyDecimals: 2, maxMoves: 3, pageSize: 2000 });
  assert.equal(r.moves.length, 4, 'أبوان كاملان');
  assert.equal(r.truncated, true);
  const ids = calls.filter((c) => c.model === 'vanLoadItem').flatMap((c) => (c.args.where as { vanLoadId: { in: string[] } }).vanLoadId.in);
  assert.ok(ids.length <= 3, `بنود ${ids.length} أباً لا 40`);
});

test('maxMoves بلا pageSize ⇒ صفحة كل مصدر لا تتجاوز السقف (دفعة 1000 حركة لا تقرأ 2000 صفّ من كل مصدر)', async () => {
  const db = mixedDb();
  const { client, calls } = recording(db);
  const takes = () => calls.filter((c) => c.args.take !== undefined).map((c) => c.args.take);
  await loadMoves(client, 't1', { until: FAR, currencyDecimals: 2, maxMoves: 4 });
  assert.ok(takes().length >= 4 && takes().every((t) => t === 4), `take: ${takes().join(',')}`);
  calls.length = 0;
  await loadMoves(client, 't1', { until: FAR, currencyDecimals: 2, maxMoves: 2.5 });
  assert.ok(takes().every((t) => t === 3));
  for (const maxMoves of [undefined, 1_000_000]) {
    calls.length = 0;
    await loadMoves(client, 't1', { until: FAR, currencyDecimals: 2, maxMoves });
    assert.ok(takes().every((t) => t === 2000), 'الافتراضي 2000');
  }
});

// ═══ «تصفير المخزون» عبر المسار الحقيقي (probe2) ═══

test('probe2: خطة التصفير من رصيد الشاشة القديمة (بلا فاتورة الإدارة) ⇒ المستودع صفرٌ بعد التصفير، ومصروف 1,000 لا 1,120', async () => {
  const db = new CostingFakeDb();
  db.addReceipt('A', 100, 10);
  db.addInvoice({ type: 'CREDIT', salesRepId: null, items: [{ productId: 'A', qty: 10 }] });
  // الرصيد كما يجمعه aggWarehouseTotals (حركات المستودع وتحميلات السيارات — لا الفواتير) ثم warehouseBalancesOf
  const agg: WhTotalAgg[] = db.tables.warehouseEntryItem.map((it) => ({
    productId: it.productId as string, source: 'WH', qty: it.baseQty as number,
    type: db.tables.warehouseEntry.find((e) => e.id === it.entryId)!.type as string,
  }));
  const plan = planStockZero({
    products: [{ id: 'A', name: 'A' }], warehouseEnabled: true, lotTrackingEnabled: false,
    balances: { warehouse: warehouseBalancesOf(agg), vans: new Map(), deletedVans: 0 },
  });
  assert.deepEqual(plan.warehouse.lines, [{ productId: 'A', balance: 100 }], 'الشاشة القديمة لا ترى فاتورة الإدارة');
  // كما يكتبها writeStockZero: تسويةٌ واحدة بـzeroRunId وسطر −الرصيد
  const z = db.addWarehouseEntry({ type: 'ADJUST', zeroRunId: 'zr1', items: plan.warehouse.lines.map((l) => ({ productId: l.productId, qty: -l.balance })) });
  db.addReceipt('A', 50, 12);
  const out = replay((await load(db)).moves, { currencyDecimals: 2 });
  const zo = out.outputs.find((o) => o.key === whItemKey(z.itemIds[0]))!;
  assert.deepEqual([zo.kind, zo.baseQty, zo.valueMilli, zo.qtyAfter, zo.valueAfter, zo.warnings], ['ZERO_RUN', -90, -900_000n, 0, 0n, []]);
  assert.deepEqual(stateTotals(out.state), [{ location: 'WH', qtyBase: 50, uncostedQty: 0, valueMilli: 600_000n }], '= الشاشة القديمة 50');
  assert.ok(out.outputs.every((o) => o.varianceMilli === 0n), 'لا حفرة تُسدّ بفرق');
  let expense = 0n;
  for (const o of out.outputs) {
    const g = glImpactOf(o);
    if (o.kind !== 'RECEIVE') expense += g.cogsMilli + g.counterMilli;
  }
  assert.equal(expense, 1_000_000n, 'تكلفة المبيعات 100 + خسارة التسوية 900');
});
