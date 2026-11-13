// «ربط الدفاتر» L1 (وكيل B5): حركة المستودع RETURN — مرتجعٌ للمورّد بكميات سالبة — في كل حسابات المخزون.
//
// العقد: RETURN يُعامَل في رصيد المستودع وتقييمه (المتوسّط المتحرّك وطبقات السيارات) تماماً كتسوية ADJUST سالبة، والفرق
// الوحيد عمود العرض: نقصٌ من «الوارد» (صافي ما ورد من الموردين) لا «تسوية». و«المشتريات الشهرية» في لوحة التحكم صافيةٌ من
// المرتجع وبلا المخزون الافتتاحي، وتسوية «تصفير المخزون» تُكتب بمصدرها STOCK_ZERO، وتتبّع اللوط يسمّي المرتجع للمورّد باسمه.
// والبيانات القائمة (لا RETURN فيها) لا يتغيّر فيها رقم: خاصيةٌ عشوائية تقارن composeWarehouse بنسخةٍ مجمَّدة من حلقته السابقة.
// حسابٌ نقيّ وقواعد مزيّفة — لا قاعدة ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  composeWarehouse, loadWarehouseInputs, monthPurchasesOf, warehouseOnHandOf, OPENING_IMPORT_SOURCE,
  type PurchaseAggRow, type WarehouseInputsDb, type WarehouseOnHandDb, type WarehouseRow,
} from '../services/warehouseStock';
import { costKindOfWarehouseEntry, valueStock, warehouseEntryColumn, type CostMove } from '../services/warehouseCost';
import { warehouseOnHandAgg, type WhTotalAgg } from '../services/lotsDb';
import { LOT_ORIGIN_SUPPLIER_RETURN, warehouseOriginKind } from '../services/lotsTrace';
import { STOCK_ZERO_NOTE, STOCK_ZERO_SOURCE, writeStockZero, type StockZeroPlan, type StockZeroWriteTx } from '../services/stockZero';
import { WAREHOUSE_ENTRY_SOURCES } from '../services/suppliers/core';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

type WhIn = { productId: string; qty: number; type: string; unitCost?: number | null; at?: number };
type VanIn = { productId: string; qty: number; type: string; salesRepId?: string | null; at?: number };

const P = [{ id: 'a', name: 'صنف أ', code: 'A', unit: 'حبة' }, { id: 'b', name: 'صنف ب', code: 'B', unit: 'حبة' }];
const rowOf = (rows: WarehouseRow[], id: string) => rows.find((r) => r.productId === id)!;
/** أرقام الرصيد والتقييم وحدها — ما يجب أن يتطابق بين RETURN والتسوية السالبة المماثلة */
const money = (r: WarehouseRow) => ({ onHand: r.onHand, avgCost: r.avgCost, stockValue: r.stockValue, costedQty: r.costedQty, uncostedQty: r.uncostedQty });
/** يستبدل كل RETURN بتسوية ADJUST بالكمية نفسها — بلا سعرٍ كما تُكتب التسوية */
const asAdjust = (wh: WhIn[]): WhIn[] => wh.map((w) => (w.type === 'RETURN' ? { productId: w.productId, qty: w.qty, type: 'ADJUST', at: w.at } : w));

// ═══ القواعد الصرفة ═══

test('نوع الحركة ⇐ عمودها ونوع تقييمها: RETURN وارداً صافياً ويُقيَّم كتسوية (OTHER)، وكل نوعٍ غير RECEIVE لا يحمل سعراً', () => {
  assert.deepEqual(['RECEIVE', 'RETURN', 'ADJUST', 'شيء'].map((t) => [warehouseEntryColumn(t), costKindOfWarehouseEntry(t)]), [
    ['received', 'RECEIVE'], ['received', 'OTHER'], ['adjusted', 'OTHER'], ['adjusted', 'OTHER'],
  ]);
});

// ═══ الرصيد والتقييم ═══

test('وارد ثم RETURN ⇒ الرصيد والقيمة والمتوسّط كتسويةٍ سالبة مماثلة، والمرتجع ينقص «الوارد» لا «التسويات»', () => {
  const wh: WhIn[] = [
    { productId: 'a', qty: 100, type: 'RECEIVE', unitCost: 10, at: 1 },
    { productId: 'a', qty: -30, type: 'RETURN', unitCost: 10, at: 2 },
  ];
  const ret = rowOf(composeWarehouse(P, wh, []), 'a');
  const adj = rowOf(composeWarehouse(P, asAdjust(wh), []), 'a');
  assert.deepEqual(money(ret), money(adj));
  assert.deepEqual(money(ret), { onHand: 70, avgCost: 10, stockValue: 700, costedQty: 70, uncostedQty: 0 });
  // العرض: صافي الوارد ٧٠ والتسويات صفر — والتسوية المماثلة تُبقي الوارد ١٠٠ وتسويةً −٣٠
  assert.deepEqual([ret.received, ret.adjusted], [70, 0]);
  assert.deepEqual([adj.received, adj.adjusted], [100, -30]);
  assert.equal(ret.received + ret.adjusted, adj.received + adj.adjusted);
});

test('المرتجع يخرج بمتوسّط لحظته لا بسعر سطره الأصلي: متوسّط الباقي لا يتغيّر بمرتجعٍ لم يُبَع منه شيء', () => {
  // ١٠٠ بعشرة ثم ١٠٠ بعشرين ⇒ متوسّط ١٥؛ يُرتجع ٥٠ من الدفعة الثانية وسطره يحمل سعرها (٢٠)
  const wh: WhIn[] = [
    { productId: 'a', qty: 100, type: 'RECEIVE', unitCost: 10, at: 1 },
    { productId: 'a', qty: 100, type: 'RECEIVE', unitCost: 20, at: 2 },
    { productId: 'a', qty: -50, type: 'RETURN', unitCost: 20, at: 3 },
  ];
  const r = rowOf(composeWarehouse(P, wh, []), 'a');
  assert.deepEqual(money(r), { onHand: 150, avgCost: 15, stockValue: 2250, costedQty: 150, uncostedQty: 0 });
  assert.deepEqual(money(r), money(rowOf(composeWarehouse(P, asAdjust(wh), []), 'a')));
  // والتقييم المباشر: نوع حركته OTHER — سعر السطر لا يدخل
  const moves: CostMove[] = wh.map((w) => (costKindOfWarehouseEntry(w.type) === 'RECEIVE'
    ? { qty: w.qty, kind: 'RECEIVE', unitCost: w.unitCost } : { qty: w.qty, kind: 'OTHER' }));
  assert.equal(valueStock(moves).stockValue, 2250);
});

test('RETURN بين تحميلات السيارات وعودتها: الطبقات وقيمة العائد كما في التسوية السالبة تماماً', () => {
  const wh: WhIn[] = [
    { productId: 'a', qty: 100, type: 'RECEIVE', unitCost: 10, at: 1 },
    { productId: 'a', qty: 100, type: 'RECEIVE', unitCost: 20, at: 3 },
    { productId: 'a', qty: -30, type: 'RETURN', unitCost: 20, at: 4 },
    { productId: 'b', qty: 10, type: 'RECEIVE', at: 1 },          // بلا سعر: دلو غير المقيَّم
    { productId: 'b', qty: -4, type: 'RETURN', at: 4 },
  ];
  const vans: VanIn[] = [
    { productId: 'a', qty: 40, type: 'LOAD', salesRepId: 'r1', at: 2 },
    { productId: 'a', qty: 10, type: 'UNLOAD', salesRepId: 'r1', at: 5 },
    { productId: 'b', qty: 2, type: 'LOAD', salesRepId: 'r1', at: 2 },
  ];
  for (const id of ['a', 'b']) {
    const ret = rowOf(composeWarehouse(P, wh, vans), id);
    const adj = rowOf(composeWarehouse(P, asAdjust(wh), vans), id);
    assert.deepEqual(money(ret), money(adj), id);
  }
  const a = rowOf(composeWarehouse(P, wh, vans), 'a');
  // ٦٠ بعشرة + ١٠٠ بعشرين ⇒ ١٦٠ بمتوسّط ١٦٫٢٥؛ يُرتجع ٣٠ بالمتوسّط ⇒ ١٣٠ بقيمة ٢١١٢٫٥؛ يعود ١٠ بكلفة خروجها (١٠) ⇒ ٢٢١٢٫٥
  assert.deepEqual(money(a), { onHand: 140, avgCost: 15.8036, stockValue: 2212.5, costedQty: 140, uncostedQty: 0 });
  const b = rowOf(composeWarehouse(P, wh, vans), 'b');
  assert.deepEqual([b.onHand, b.uncostedQty, b.stockValue, b.received], [4, 4, 0, 6]);
});

test('مرتجعٌ يتجاوز الرصيد يجعله سالباً بقيمته كالتسوية — مؤشّر نقصٍ صريح لا صفرٌ صامت', () => {
  const wh: WhIn[] = [
    { productId: 'a', qty: 10, type: 'RECEIVE', unitCost: 5, at: 1 },
    { productId: 'a', qty: -15, type: 'RETURN', unitCost: 5, at: 2 },
  ];
  const r = rowOf(composeWarehouse(P, wh, []), 'a');
  assert.deepEqual(money(r), money(rowOf(composeWarehouse(P, asAdjust(wh), []), 'a')));
  assert.deepEqual([r.onHand, r.stockValue, r.received], [-5, -25, -5]);
});

test('RETURN موجبٌ (خلل كتابة) لا يحرّك المتوسّط ولو حمل سعراً — كتسويةٍ موجبة بمتوسّط اللحظة', () => {
  const wh: WhIn[] = [
    { productId: 'a', qty: 10, type: 'RECEIVE', unitCost: 10, at: 1 },
    { productId: 'a', qty: 10, type: 'RETURN', unitCost: 999, at: 2 },
  ];
  const r = rowOf(composeWarehouse(P, wh, []), 'a');
  assert.deepEqual(money(r), money(rowOf(composeWarehouse(P, asAdjust(wh), []), 'a')));
  assert.equal(r.avgCost, 10);
});

test('حدّ القراءة (الوحدات المتعددة): مرتجع كرتونين من وارد عشرة كراتين ⇒ ٩٦ حبة بقيمة ٩٦٠ ورصيدُ الحارس ينقص بالأساس', async () => {
  const at = (m: number) => new Date(Date.UTC(2026, 10, 1, 8, m));
  const items = [
    { productId: 'a', qty: 10, unitFactor: 12, baseQty: 120, unitCost: 120, entry: { type: 'RECEIVE', createdAt: at(1) } },
    { productId: 'a', qty: -2, unitFactor: 12, baseQty: -24, unitCost: 120, entry: { type: 'RETURN', createdAt: at(2) } },
  ];
  const db = {
    product: { findMany: async () => [{ id: 'a', name: 'صنف أ', code: 'A', unit: 'حبة', status: 'ACTIVE', deletedAt: null, units: [], primaryUnitId: null }] },
    warehouseEntryItem: { findMany: async () => items },
    vanLoadItem: { findMany: async () => [] },
  } as unknown as WarehouseInputsDb & WarehouseOnHandDb;
  const inputs = await loadWarehouseInputs('t1', { includeInactive: true }, db);
  assert.deepEqual(inputs.whItems.map((i) => [i.type, i.qty, i.unitCost]), [['RECEIVE', 120, 10], ['RETURN', -24, 10]]);
  const r = rowOf(composeWarehouse(inputs.products, inputs.whItems, inputs.vanItems, 2), 'a');
  assert.deepEqual(money(r), { onHand: 96, avgCost: 10, stockValue: 960, costedQty: 96, uncostedQty: 0 });
  // حارس التحميل فوق الرصيد (D2): أسطر المستودع كلها بإشارتها
  assert.equal((await warehouseOnHandOf('t1', ['a'], db)).get('a'), 96);
});

test('مجاميع اللوط (warehouseOnHandAgg) = composeWarehouse.onHand مع المرتجع للمورّد', () => {
  const rows: WhTotalAgg[] = [
    { productId: 'a', source: 'WH', type: 'RECEIVE', qty: 100 },
    { productId: 'a', source: 'WH', type: 'RETURN', qty: -30 },
    { productId: 'a', source: 'WH', type: 'ADJUST', qty: -5 },
    { productId: 'a', source: 'VAN', type: 'LOAD', qty: 20 },
    { productId: 'a', source: 'VAN', type: 'UNLOAD', qty: 4 },
  ];
  const onHand = composeWarehouse(P,
    rows.filter((r) => r.source === 'WH').map((r) => ({ productId: r.productId, qty: r.qty, type: r.type })),
    rows.filter((r) => r.source === 'VAN').map((r) => ({ productId: r.productId, qty: r.qty, type: r.type })));
  assert.equal(warehouseOnHandAgg(rows).get('a'), 49);
  assert.equal(rowOf(onHand, 'a').onHand, 49);
});

// ═══ البيانات القائمة لا يتغيّر فيها رقم ═══

/** نسخةٌ مجمَّدة من حلقة composeWarehouse قبل RETURN (warehouseStock.ts، ١٣ نوفمبر ٢٠٢٦) — مرجعٌ مستقلّ للتطابق */
function legacyColumns(wh: WhIn[]): Map<string, { received: number; adjusted: number }> {
  const out = new Map<string, { received: number; adjusted: number }>();
  for (const it of wh) {
    const m = out.get(it.productId) ?? { received: 0, adjusted: 0 };
    if (it.type === 'RECEIVE') m.received += it.qty; else m.adjusted += it.qty;
    out.set(it.productId, m);
  }
  return out;
}
function legacyMoves(wh: WhIn[], vans: VanIn[], pid: string): CostMove[] {
  const mv: (CostMove & { t: number; i: number })[] = [];
  let i = 0;
  for (const it of wh) {
    if (it.productId !== pid) continue;
    mv.push(it.type === 'RECEIVE'
      ? { qty: it.qty, kind: 'RECEIVE', unitCost: it.unitCost, t: it.at ?? 0, i: i++ }
      : { qty: it.qty, kind: 'OTHER', t: it.at ?? 0, i: i++ });
  }
  for (const it of vans) {
    if (it.productId !== pid) continue;
    if (it.type === 'LOAD') mv.push({ qty: -it.qty, kind: 'VAN_OUT', vanId: it.salesRepId, t: it.at ?? 0, i: i++ });
    else if (it.type === 'UNLOAD') mv.push({ qty: it.qty, kind: 'VAN_IN', vanId: it.salesRepId, t: it.at ?? 0, i: i++ });
  }
  return mv.sort((x, y) => x.t - y.t || x.i - y.i);
}

/** مولّد عشوائي ثابت البذرة — تكرارٌ محتوم */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
function randomHistory(r: () => number, withReturn: boolean): { wh: WhIn[]; vans: VanIn[] } {
  const wh: WhIn[] = [];
  const vans: VanIn[] = [];
  const n = 5 + Math.floor(r() * 25);
  for (let k = 0; k < n; k++) {
    const productId = r() < 0.6 ? 'a' : 'b';
    const qty = 1 + Math.floor(r() * 50);
    const at = Math.floor(r() * 40); // لحظاتٌ متساوية أحياناً: الفرز المستقرّ جزءٌ من المقارنة
    const x = r();
    if (x < 0.3) wh.push({ productId, qty, type: 'RECEIVE', unitCost: r() < 0.8 ? Math.round(r() * 2000) / 100 : null, at });
    else if (x < 0.45) wh.push({ productId, qty: r() < 0.7 ? -qty : qty, type: 'ADJUST', at });
    else if (x < 0.55 && withReturn) wh.push({ productId, qty: -qty, type: 'RETURN', unitCost: Math.round(r() * 2000) / 100, at });
    else if (x < 0.8) vans.push({ productId, qty, type: 'LOAD', salesRepId: r() < 0.5 ? 'r1' : 'r2', at });
    else vans.push({ productId, qty: Math.max(1, Math.floor(qty / 2)), type: r() < 0.85 ? 'UNLOAD' : 'ADJUST', salesRepId: r() < 0.5 ? 'r1' : 'r2', at });
  }
  return { wh, vans };
}

test('خاصية: تاريخٌ بلا RETURN ⇒ كل صفّ (الأعمدة والرصيد والقيمة والمتوسّط) كالحلقة السابقة حرفياً — ٤٠٠ تاريخ عشوائي', () => {
  const r = rng(20261113);
  for (let k = 0; k < 400; k++) {
    const { wh, vans } = randomHistory(r, false);
    const rows = composeWarehouse(P, wh, vans, 2);
    const cols = legacyColumns(wh);
    for (const p of P) {
      const row = rowOf(rows, p.id);
      const c = cols.get(p.id) ?? { received: 0, adjusted: 0 };
      assert.deepEqual([row.received, row.adjusted], [c.received, c.adjusted], `#${k} ${p.id}`);
      const v = valueStock(legacyMoves(wh, vans, p.id), 2);
      assert.deepEqual([row.avgCost, row.stockValue, row.costedQty, row.uncostedQty], [v.avgCost, v.stockValue, v.costedQty, v.uncostedQty], `#${k} ${p.id}`);
    }
  }
});

test('خاصية: كل RETURN ⇒ تسوية سالبة مماثلة لا تغيّر رصيداً ولا قيمةً ولا متوسّطاً — ٤٠٠ تاريخ عشوائي', () => {
  const r = rng(7);
  let returns = 0;
  for (let k = 0; k < 400; k++) {
    const { wh, vans } = randomHistory(r, true);
    returns += wh.filter((w) => w.type === 'RETURN').length;
    const a = composeWarehouse(P, wh, vans, 2);
    const b = composeWarehouse(P, asAdjust(wh), vans, 2);
    for (const p of P) {
      assert.deepEqual(money(rowOf(a, p.id)), money(rowOf(b, p.id)), `#${k} ${p.id}`);
      // صافي الوارد = وارد التسوية المماثلة + مرتجعها (العرض وحده يتغيّر)
      const ret = wh.filter((w) => w.productId === p.id && w.type === 'RETURN').reduce((s, w) => s + w.qty, 0);
      assert.ok(Math.abs(rowOf(a, p.id).received - (rowOf(b, p.id).received + ret)) < 1e-9, `#${k} ${p.id}`);
    }
  }
  assert.ok(returns > 100, 'المولّد يُنتج مرتجعات فعلاً');
});

// ═══ «المشتريات الشهرية» في لوحة التحكم ═══

const agg = (o: Partial<PurchaseAggRow> & { type: string; value: number; entries?: number }): PurchaseAggRow => ({
  status: 'POSTED', source: 'MANUAL', returnOfSource: null, entries: 1, ...o,
});

test('المشتريات صافية: الوارد − المرتجع للمورّد، والعدد للوارد وحده', () => {
  assert.deepEqual(monthPurchasesOf([agg({ type: 'RECEIVE', value: 1000, entries: 3 }), agg({ type: 'RETURN', value: -250, entries: 2, returnOfSource: 'MANUAL' })]),
    { purchasesTotal: 750, entriesCount: 3 });
  // مرتجعٌ بلا أصل (وارد سالبٌ بمورّد وسعر صار RETURN) يُطرح كذلك
  assert.deepEqual(monthPurchasesOf([agg({ type: 'RECEIVE', value: 100 }), agg({ type: 'RETURN', value: -40 })]), { purchasesTotal: 60, entriesCount: 1 });
  // مرتجعُ شهرٍ بلا وارد فيه: سالبٌ صادق كيومٍ مرتجعه أكبر من بيعه
  assert.deepEqual(monthPurchasesOf([agg({ type: 'RETURN', value: -80, source: 'API' })]), { purchasesTotal: -80, entriesCount: 0 });
});

test('المخزون الافتتاحي ليس شراءً: لا يُجمع ولا يُعدّ، ولا مرتجع وارده يُطرح', () => {
  assert.deepEqual(monthPurchasesOf([
    agg({ type: 'RECEIVE', value: 5000, entries: 1, source: OPENING_IMPORT_SOURCE }),
    agg({ type: 'RETURN', value: -5000, returnOfSource: OPENING_IMPORT_SOURCE }), // إلغاء استيرادٍ خاطئ
    agg({ type: 'RECEIVE', value: 300, entries: 2, source: 'API' }),
  ]), { purchasesTotal: 300, entriesCount: 2 });
  assert.ok((WAREHOUSE_ENTRY_SOURCES as readonly string[]).includes(OPENING_IMPORT_SOURCE));
});

test('الوارد الملغى: قيمته تصفّرها حركة إلغائه (RETURN كاملة) ولا يُعدّ حركة شراء، والتسوية لا تدخل', () => {
  assert.deepEqual(monthPurchasesOf([
    agg({ type: 'RECEIVE', value: 400, entries: 1, status: 'CANCELLED' }),
    agg({ type: 'RETURN', value: -400, returnOfSource: 'MANUAL' }),
    agg({ type: 'RECEIVE', value: 120, entries: 1 }),
    agg({ type: 'ADJUST', value: -999, entries: 4 }),
  ]), { purchasesTotal: 120, entriesCount: 1 });
});

test('المشتريات: لا صفوف ⇒ صفر، وnull وbigint من القاعدة، وضجيج الفاصلة يُنقّى', () => {
  assert.deepEqual(monthPurchasesOf([]), { purchasesTotal: 0, entriesCount: 0 });
  assert.deepEqual(monthPurchasesOf([agg({ type: 'RECEIVE', value: null as unknown as number, entries: 2n as unknown as number })]), { purchasesTotal: 0, entriesCount: 2 });
  assert.deepEqual(monthPurchasesOf([agg({ type: 'RECEIVE', value: 0.3 }), agg({ type: 'RETURN', value: -0.1 })]), { purchasesTotal: 0.2, entriesCount: 1 });
  assert.equal(Object.is(monthPurchasesOf([agg({ type: 'RECEIVE', value: 0.1 }), agg({ type: 'RETURN', value: -0.1 })]).purchasesTotal, 0), true, '‎-0 صفرٌ موجب');
});

// ═══ تتبّع اللوط وتصفير المخزون ═══

test('تتبّع اللوط: سطر المستودع RETURN مصدرُه SUPPLIER_RETURN لا RETURN (مرتجع العميل)، والافتتاحي وغيره كما كانا', () => {
  assert.equal(LOT_ORIGIN_SUPPLIER_RETURN, 'SUPPLIER_RETURN');
  assert.deepEqual([
    warehouseOriginKind('RECEIVE', false), warehouseOriginKind('ADJUST', false), warehouseOriginKind('RETURN', false), warehouseOriginKind('RECEIVE', true),
  ], ['RECEIVE', 'ADJUST', 'SUPPLIER_RETURN', 'OPENING_IMPORT']);
  const src = read('services/lotsTrace.ts');
  assert.ok(src.includes('origin.push({ kind: warehouseOriginKind(w.entry.type, opening),'), 'lotTrace يمرّ بالدالّة نفسها');
});

test('تصفير المخزون: تسوية المستودع تُكتب بمصدرها STOCK_ZERO ونوعها ADJUST وأسطرها −الرصيد بلا تكلفة', async () => {
  const created: Record<string, unknown>[] = [];
  const items: Record<string, unknown>[] = [];
  const tx = {
    warehouseEntry: { create: async (a: { data: Record<string, unknown> }) => { created.push(a.data); return { id: 'we-1' }; } },
    warehouseEntryItem: { createMany: async (a: { data: Record<string, unknown>[] }) => { items.push(...a.data); return { count: a.data.length }; } },
    vanLoad: { create: async () => { throw new Error('لا سيارات في الخطة'); } },
    vanLoadItem: { createMany: async () => ({ count: 0 }) },
  } as unknown as StockZeroWriteTx;
  const plan: StockZeroPlan = {
    warehouse: { enabled: true, lines: [{ productId: 'a', balance: 70 }, { productId: 'b', balance: -3 }] },
    vans: [], lotBlocked: [], skipped: { deletedVans: 0, negativeUnsellable: 0 }, alreadyZero: false,
  };
  const out = await writeStockZero(tx, { tenantId: 't1', runId: 'run-1', plan, createdBy: 'مدير' });
  assert.deepEqual(out, { entryId: 'we-1', vanLoads: 0 });
  assert.deepEqual(created, [{ tenantId: 't1', type: 'ADJUST', source: 'STOCK_ZERO', note: STOCK_ZERO_NOTE, createdBy: 'مدير', zeroRunId: 'run-1' }]);
  assert.equal(STOCK_ZERO_SOURCE, 'STOCK_ZERO');
  assert.ok((WAREHOUSE_ENTRY_SOURCES as readonly string[]).includes(STOCK_ZERO_SOURCE));
  assert.deepEqual(items.map((i) => [i.productId, i.qty, i.baseQty, 'unitCost' in i]), [['a', -70, -70, false], ['b', 3, 3, false]]);
});

test('حارس نصّي: لوحة التحكم تجمّع الوارد والمرتجع بمصدرهما ومصدر أصل المرتجع وتقرّر بـmonthPurchasesOf', () => {
  const d = read('routes/dashboard.ts');
  const q = d.slice(d.indexOf('prisma.$queryRaw<PurchaseAggRow[]>'), d.indexOf('monthPurchases = monthPurchasesOf(rows);'));
  assert.ok(q.length > 0, 'الاستعلام والقرار متجاوران');
  for (const s of [
    'SELECT e.type, e.status, e.source, o.source AS "returnOfSource"',
    'COALESCE(SUM(i.qty * i."unitCost"), 0)::float8 AS value',
    'COUNT(DISTINCT e.id)::int AS entries',
    'LEFT JOIN "warehouse_entries" o ON o.id = e."returnOfEntryId"',
    "e.type IN ('RECEIVE', 'RETURN')",
    'i."unitCost" IS NOT NULL',
    'GROUP BY 1, 2, 3, 4',
  ]) assert.ok(q.includes(s), s);
  // القيمة بوحدة الصفّ (qty × unitCost) لا baseQty
  assert.doesNotMatch(q, /baseQty/);
  assert.ok(d.includes('if (warehouseOn && accountingOn) {'), 'لا استعلام والميزة مطفأة');
});
