// «ربط الدفاتر» L2 — طور COSTING في المعاينة طيّاً تزايدياً على دفعات (linking/costingFold.ts): الدفعات بأي حجم = الدفعة الواحدة
// حرفياً (الملخّص وعدّ المصادر واللقطات) بالوحدات الحقيقية (loadMoves/replay/summarizeCosting) على قاعدة مزيّفة، والصفّ الأساسي
// المكرَّر عبر دفعتين يُتخطّى ويُحذَّر كما في الاستدعاء الواحد، والالتقاط عند بداية السنة في الدفعة التي تعبرها، والسقف ⇒ TOO_LARGE
// (لا نفاد ذاكرة)، ولا تُحمَّل الحركات إلا دفعةً دفعة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMoves } from '../services/costing/streams';
import { replay } from '../services/costing/stepper';
import { summarizeCosting } from '../services/costing/summary';
import { zonedStartOfDay } from '../services/gl/dates';
import { CostingTooLargeError, foldCostingForPreview, mergeCostingSummaries } from '../services/gl/linking/costingFold';
import type { PreviewDeps } from '../services/gl/linking/types';
import { FIX_DB_NOW, FIX_LINKED_FROM, FIX_T0, FIX_TZ, FakeDb, TenantFixture, buildLinkingScenario, previewOptionsFor } from './linking-fake-db';

const TID = 't1';
const at = (iso: string) => new Date(iso);
const REAL: Pick<PreviewDeps, 'loadMoves' | 'replay' | 'summarizeCosting'> = { loadMoves, replay, summarizeCosting };
const INPUT = {
  until: FIX_DB_NOW, currencyDecimals: 2, cutoverDate: FIX_LINKED_FROM, cutoverStart: zonedStartOfDay(FIX_LINKED_FROM, FIX_TZ),
  openingSnapshotAt: FIX_T0, timezone: FIX_TZ,
};

/** تاريخ مخزونٍ أغنى: وارد بسعرين، تحميل وتنزيل، بيع سيارة وإدارة، إلغاء، مرتجع عائد مرتبط، ومرتجع بلا مندوب — عبر بداية السنة */
function richTenant(): FakeDb {
  const s = buildLinkingScenario();
  const f = s.f as TenantFixture;
  const p2 = f.product('صنف ثانٍ');
  const r2 = f.rep('مندوب ثانٍ');
  const days = ['2026-09-01', '2026-10-15', '2026-12-30', '2027-01-03', '2027-02-10', '2027-04-01', '2027-05-20'];
  days.forEach((d, i) => {
    const t = (h: number) => at(`${d}T${String(8 + h).padStart(2, '0')}:00:00Z`);
    f.warehouse({ items: [{ productId: p2, qty: 40 + i, unitCost: 3 + i * 0.25 }, { productId: s.p1, qty: 5, unitCost: 5.5 }], at: t(0) });
    f.vanLoad({ repId: r2, items: [{ productId: p2, qty: 12 }], at: t(1) });
    const sale = f.invoice({ type: 'CREDIT', customerId: s.c1, repId: r2, lines: [{ productId: p2, qty: 5, unitPrice: 9 }, { productId: s.p1, qty: 1, unitPrice: 12 }], at: t(2) });
    f.invoice({ type: 'CASH', customerId: s.c2, lines: [{ productId: p2, qty: 2, unitPrice: 9 }], at: t(3) });
    f.invoice({ type: 'RETURN', customerId: s.c1, repId: r2, lines: [{ productId: p2, qty: 1, unitPrice: 9, returnOfItemId: sale.itemIds[0] }], at: t(4) });
    if (i % 2 === 0) f.cancelInvoice(sale, 'CREDIT', s.c1, t(5));
    if (i % 3 === 0) f.vanLoad({ repId: r2, type: 'UNLOAD', items: [{ productId: p2, qty: 3 }], at: t(6) });
    f.invoice({ type: 'RETURN', customerId: s.c2, lines: [{ productId: p2, qty: 1, unitPrice: 9 }], at: t(7) });
  });
  return s.db;
}

test('الدفعات بأي حجم = الدفعة الواحدة حرفياً: الملخّص (الافتتاح والسنة والحُفر والتحذيرات والرصيد عند البدء) وعدّ المصادر واللقطات', async () => {
  const db = richTenant();
  const one = await foldCostingForPreview(REAL, db.client as never, TID, { ...INPUT, batchMoves: 1e9 });
  assert.equal(one.batches, 1);
  assert.ok(one.summary.moveCount > 40, String(one.summary.moveCount));
  assert.ok(one.summary.openingByLocation.length > 0 && one.summary.nowByLocation.length > 0);
  // = المسار القديم حرفياً: loadMoves كلها ⇒ replay بالتقاط ⇒ summarizeCosting
  const all = await loadMoves(db.client as never, TID, { until: FIX_DB_NOW, currencyDecimals: 2 });
  const rr = replay(all.moves, { currencyDecimals: 2 }, { captureAt: [INPUT.cutoverStart] });
  const legacy = summarizeCosting(rr.outputs, rr.state, {
    cutoverDate: FIX_LINKED_FROM, cutoverStart: INPUT.cutoverStart, openingSnapshotAt: FIX_T0, timezone: FIX_TZ, atCutover: rr.captured[0] ?? null,
    streamWarnings: all.warnings,
  });
  assert.deepEqual(one.summary, legacy);
  assert.deepEqual(one.sourceRows, all.sourceRows);
  assert.equal(one.snapshots, rr.outputs.length);
  for (const batchMoves of [1, 2, 3, 7, 25]) {
    const b = await foldCostingForPreview(REAL, db.client as never, TID, { ...INPUT, batchMoves });
    assert.ok(b.batches > 1, `batch ${batchMoves}`);
    assert.deepEqual(b.summary, legacy, `batch ${batchMoves}`);
    assert.deepEqual(b.sourceRows, all.sourceRows, `batch ${batchMoves}`);
    assert.equal(b.snapshots, rr.outputs.length, `batch ${batchMoves}`);
  }
  assert.equal(db.writeCount(), 0);
});

test('صفّ أساسي مكرَّر يقع في دفعة لاحقة: يُتخطّى ويُحذَّر DUPLICATE_PRIMARY_ROW كالاستدعاء الواحد (لا يُطوى البند مرتين)', async () => {
  const db = richTenant();
  const inv = db.rows('accountEntry').find((r) => r.type === 'INVOICE_DEBIT' && (r.createdAt as Date).toISOString().startsWith('2027-02-10'))!;
  db.seed('accountEntry', [{ ...inv, id: 'ae-dup-late', createdAt: at('2027-06-01T08:00:00Z'), entryDate: at('2027-06-01T08:00:00Z') }]);
  const one = await foldCostingForPreview(REAL, db.client as never, TID, { ...INPUT, batchMoves: 1e9 });
  const dup = one.summary.warnings.find((w) => w.code === 'DUPLICATE_PRIMARY_ROW');
  assert.deepEqual(dup && { count: dup.count, sample: dup.sample }, { count: 1, sample: ['ae-dup-late'] });
  for (const batchMoves of [1, 4]) {
    const b = await foldCostingForPreview(REAL, db.client as never, TID, { ...INPUT, batchMoves });
    assert.deepEqual(b.summary, one.summary, `batch ${batchMoves}`);
  }
});

test('الالتقاط عند بداية السنة: الدفعات كلها قبل البدء ⇒ الحالة الأخيرة؛ والدفعة العابرة ⇒ قبل أول حركة بعده', async () => {
  const db = new FakeDb({ now: () => FIX_DB_NOW });
  const f = new TenantFixture(db);
  f.tenant({ accountingSuiteEnabled: true, warehouseEnabled: true });
  f.company();
  const p = f.product('صنف');
  f.warehouse({ items: [{ productId: p, qty: 10, unitCost: 2 }], at: at('2026-06-01T08:00:00Z') });
  f.warehouse({ items: [{ productId: p, qty: -4, unitCost: null }], type: 'ADJUST', at: at('2026-07-01T08:00:00Z') });
  const before = await foldCostingForPreview(REAL, db.client as never, TID, { ...INPUT, batchMoves: 1 });
  assert.deepEqual(before.summary.uncostedAtCutover, []);
  assert.deepEqual(before.summary.openingByLocation.map((l) => [l.location, l.qtyBase]), [['WH', 6]]);
  // وارد بلا سعر بعد البدء: لا يدخل رصيد البداية
  f.warehouse({ items: [{ productId: p, qty: 3, unitCost: null }], at: at('2027-02-01T08:00:00Z') });
  const a = await foldCostingForPreview(REAL, db.client as never, TID, { ...INPUT, batchMoves: 1 });
  const b = await foldCostingForPreview(REAL, db.client as never, TID, { ...INPUT, batchMoves: 1e9 });
  assert.deepEqual(a.summary, b.summary);
  assert.deepEqual(a.summary.uncostedAtCutover, []);
});

test('السقف: حركات التكلفة فوق maxMoves ⇒ CostingTooLargeError قبل طيّ ما بعدها، والمعاينة ⇒ TOO_LARGE', async () => {
  const db = richTenant();
  await assert.rejects(
    foldCostingForPreview(REAL, db.client as never, TID, { ...INPUT, batchMoves: 5, maxMoves: 12 }),
    (e: unknown) => e instanceof CostingTooLargeError && e.maxMoves === 12 && e.moves > 12,
  );
  const { runPreview, previewErrorCodeOf, defaultPreviewDeps } = await import('../services/gl/linking/preview');
  const s = buildLinkingScenario();
  await assert.rejects(
    runPreview(s.db.client as never, TID, previewOptionsFor({ limits: { maxCostMoves: 2, costBatchMoves: 1 } }), {}, defaultPreviewDeps),
    (e: unknown) => previewErrorCodeOf(e) === 'TOO_LARGE',
  );
});

test('لا يُحمَّل التاريخ دفعةً واحدة: كل استدعاء loadMoves بسقف الدفعة ومؤشّر الدفعة السابقة، وreplay بحالتها', async () => {
  const db = richTenant();
  const calls: { maxMoves?: number; after: string | null; got: number }[] = [];
  let states = 0;
  const spy: Pick<PreviewDeps, 'loadMoves' | 'replay' | 'summarizeCosting'> = {
    loadMoves: async (d, t, o) => {
      const r = await loadMoves(d, t, o);
      calls.push({ maxMoves: o.maxMoves, after: o.afterCursor ? `${o.afterCursor.createdAt.toISOString()}|${o.afterCursor.id}` : null, got: r.moves.length });
      return r;
    },
    replay: (m, c, o) => { if (o?.state) states++; return replay(m, c, o); },
    summarizeCosting,
  };
  const r = await foldCostingForPreview(spy, db.client as never, TID, { ...INPUT, batchMoves: 4 });
  assert.equal(calls.length, r.batches);
  assert.ok(calls.every((c) => c.maxMoves === 4));
  assert.equal(calls[0].after, null);
  assert.ok(calls.slice(1).every((c) => c.after !== null));
  assert.equal(states, r.batches - 1, 'كل دفعة بعد الأولى تبدأ من حالة سابقتها');
  // صفّ مصدرٍ واحد لا يُشطر: الدفعة قد تزيد على السقف بأسطر صفّها الأخير وحده
  assert.ok(calls.every((c) => c.got <= 4 + 2), JSON.stringify(calls.map((c) => c.got)));
});

test('mergeCostingSummaries: ملخّصٌ واحد كما هو، وصفرٌ ⇒ رمية', () => {
  const s = summarizeCosting([], { locs: new Map(), movesFolded: 0, cursor: null }, {
    cutoverDate: FIX_LINKED_FROM, cutoverStart: INPUT.cutoverStart, openingSnapshotAt: FIX_T0, timezone: FIX_TZ, atCutover: null,
  });
  assert.equal(mergeCostingSummaries([s], { productCount: 99, streamWarningCount: 0 }), s);
  assert.throws(() => mergeCostingSummaries([], { productCount: 0, streamWarningCount: 0 }), RangeError);
});
