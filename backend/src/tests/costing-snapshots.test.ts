// «ربط الدفاتر» L3 — لقطات التكلفة ونقاط الحفظ (services/costing/snapshots.ts، العقد §7 ومعيار القبول C2-4):
// تشغيلان متتاليان ⇒ صفر لقطات مكرّرة؛ الاستئناف من نقطة حفظ = الإعادة الكاملة حرفياً (كل الحقول)؛ صفّ الرأس آخر ما يُكتب
// في معاملته؛ يُبقى 3 مجموعات؛ القفل أول عبارة؛ تجسّس: لا كتابة إلا gl_cost_snapshots وgl_cost_checkpoints؛ وصول متأخر
// يُعلَّم lateArrival — وΣ اللقطات = الحالة المحفوظة دائماً (انعدام الانجراف).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECKPOINT_HEAD, CHECKPOINT_KEEP_SETS, COST_LATE_COMMIT_WINDOW_MS, COST_LOCK_PREFIX, CostRefoldMismatchError, LATE_SCAN_LOOKBACK_MS,
  checkpointRows, computeSnapshots, findLateMoves, loadLatestCheckpoint, snapshotRefFromRow, snapshotRow, stateFromCheckpointRows,
  type CheckpointRowLike, type ComputeSnapshotsOptions, type SnapshotDb,
} from '../services/costing/snapshots';
import { loadMoves, type CostingDb } from '../services/costing/streams';
import { createCostState, locStateKey, replay, snapshotRefOf } from '../services/costing/stepper';
import { toQtyU } from '../services/costing/math';
import { saleOutKey, returnKey, returnCancelKey, restockToggleKey, vanItemKey, whItemKey, saleCancelKey } from '../services/costing/keys';
import type { CostState, LocationKey, Move, StepOutput } from '../services/costing/types';
import { LATE_COMMIT_WINDOW_MS } from '../services/gl/sync/types';
import { CostingFakeDb, GL_COST_MODELS, asPrisma } from './costing-fake-db';

const FAR = new Date('2030-01-01T00:00:00.000Z');
type Row = Record<string, unknown>;

function run(db: CostingFakeDb, opts: Partial<ComputeSnapshotsOptions> = {}) {
  return computeSnapshots(asPrisma<Parameters<typeof computeSnapshots>[0]>(db), 't1', { currencyDecimals: 2, horizon: FAR, ...opts });
}

async function runUntilDone(db: CostingFakeDb, opts: Partial<ComputeSnapshotsOptions> = {}) {
  let rounds = 0;
  for (;;) {
    const r = await run(db, opts);
    assert.notEqual(r.stoppedBy, 'CONCURRENT');
    if (r.stoppedBy === 'DONE') return r;
    assert.ok(++rounds < 200, 'التشغيل لا ينتهي');
  }
}

/** صفوف اللقطات بلا الحقول المولَّدة (id, createdAt) مرتّبة بالمفتاح */
function snapshotsOf(db: CostingFakeDb): Row[] {
  return db.tables.glCostSnapshot
    .map((r) => { const { id: _i, createdAt: _c, ...rest } = r; void _i; void _c; return rest; })
    .sort((a, b) => (String(a.sourceKey) < String(b.sourceKey) ? -1 : 1));
}

/** Σ مساهمات اللقطات لكل (صنف، موقع): location ⇐ value وbaseQty، وtoLocation ⇐ −value − variance و−baseQty (§4.7-1) */
function contributions(rows: Row[]): Map<string, { qU: number; v: bigint }> {
  const m = new Map<string, { qU: number; v: bigint }>();
  const add = (pid: string, loc: string, qU: number, v: bigint) => {
    const k = locStateKey(pid, loc as LocationKey);
    const a = m.get(k) ?? { qU: 0, v: 0n };
    a.qU += qU;
    a.v += v;
    m.set(k, a);
  };
  for (const r of rows) {
    const qU = toQtyU(r.baseQty as number);
    add(r.productId as string, r.location as string, qU, r.valueMilli as bigint);
    if (r.toLocation) add(r.productId as string, r.toLocation as string, -qU, -(r.valueMilli as bigint) - (r.varianceMilli as bigint));
  }
  for (const [k, a] of m) if (a.qU === 0 && a.v === 0n) m.delete(k);
  return m;
}

function stateView(s: CostState): Map<string, { qU: number; v: bigint }> {
  const m = new Map<string, { qU: number; v: bigint }>();
  for (const [k, l] of s.locs) {
    const qU = l.costedQtyU + l.uncostedQtyU;
    if (qU !== 0 || l.valueMilli !== 0n) m.set(k, { qU, v: l.valueMilli });
  }
  return m;
}

/** المثال أ (العقد §5) في القاعدة المزيّفة */
function exampleA(db: CostingFakeDb) {
  const r1 = db.addReceipt('A', 100, 20);
  const r2 = db.addReceipt('A', 50, 23);
  const load = db.addVanLoad({ salesRepId: 'R1', items: [{ productId: 'A', qty: 30 }] });
  const s1 = db.addInvoice({ type: 'CREDIT', salesRepId: 'R1', items: [{ productId: 'A', qty: 10 }] });
  db.cancelInvoice(s1.id);
  const s2 = db.addInvoice({ type: 'CREDIT', salesRepId: 'R1', items: [{ productId: 'A', qty: 12 }] });
  const ret = db.addInvoice({ type: 'RETURN', salesRepId: 'R1', returnToStock: true, items: [{ productId: 'A', qty: 2, returnOfItemId: s2.itemIds[0] }] });
  const off = db.toggleRestock(ret.id, false);
  const on = db.toggleRestock(ret.id, true);
  const unload = db.addVanLoad({ salesRepId: 'R1', type: 'UNLOAD', items: [{ productId: 'A', qty: 20 }] });
  return { r1, r2, load, s1, s2, ret, off, on, unload };
}

function snap(db: CostingFakeDb, key: string): Row {
  const r = db.tables.glCostSnapshot.filter((x) => x.sourceKey === key);
  assert.equal(r.length, 1, `لقطة واحدة ${key}`);
  return r[0];
}

// ═══ المسار الأساسي ═══

test('المثال أ: اللقطات بقيمها الحرفية (§5) وكل أعمدتها، ونتيجة التشغيل', async () => {
  const db = new CostingFakeDb();
  const x = exampleA(db);
  const res = await run(db);
  assert.deepEqual(res, {
    movesFolded: 10, snapshotsWritten: 10, checkpointWritten: false, lateArrivals: 0, stoppedBy: 'DONE',
    cursor: { createdAt: x.unload.createdAt, id: x.unload.id },
  });
  const rec = snap(db, whItemKey(x.r1.itemIds[0]));
  assert.deepEqual(
    { ...rec, id: undefined, createdAt: undefined },
    {
      id: undefined, createdAt: undefined, tenantId: 't1', sourceKey: whItemKey(x.r1.itemIds[0]), kind: 'RECEIVE', refType: 'WH_ENTRY',
      refId: x.r1.id, itemId: x.r1.itemIds[0], productId: 'A', location: 'WH', toLocation: null, baseQty: 100, uncostedQty: 0,
      valueMilli: 2_000_000n, varianceMilli: 0n, memoMilli: 0n, unitCostE4: 200_000n, method: 'AVCO',
      effectAt: x.r1.createdAt, srcCreatedAt: x.r1.createdAt, srcId: x.r1.id, lateArrival: false,
    },
  );
  assert.equal(snap(db, whItemKey(x.r2.itemIds[0])).unitCostE4, 230_000n);
  const ld = snap(db, vanItemKey(x.load.itemIds[0]));
  assert.deepEqual([ld.kind, ld.location, ld.toLocation, ld.baseQty, ld.valueMilli, ld.varianceMilli, ld.unitCostE4], ['VAN_LOAD', 'WH', 'VAN:R1', -30, -630_000n, 0n, 210_000n]);
  assert.equal(snap(db, saleOutKey(x.s1.itemIds[0])).valueMilli, -210_000n);
  assert.equal(snap(db, saleCancelKey(x.s1.itemIds[0])).valueMilli, 210_000n);
  assert.equal(snap(db, saleOutKey(x.s2.itemIds[0])).valueMilli, -252_000n);
  const rt = snap(db, returnKey(x.ret.itemIds[0]));
  assert.deepEqual([rt.kind, rt.valueMilli, rt.memoMilli], ['VAN_RETURN_RESTOCK', 42_000n, 0n]);
  const off = snap(db, restockToggleKey(x.off, x.ret.itemIds[0]));
  assert.deepEqual([off.kind, off.baseQty, off.valueMilli, off.memoMilli, off.refType, off.refId], ['RESTOCK_TOGGLE', -2, -42_000n, 42_000n, 'RESTOCK_LOG', x.off]);
  const on = snap(db, restockToggleKey(x.on, x.ret.itemIds[0]));
  assert.deepEqual([on.valueMilli, on.memoMilli], [42_000n, -42_000n]);
  const un = snap(db, vanItemKey(x.unload.itemIds[0]));
  assert.deepEqual([un.kind, un.location, un.toLocation, un.valueMilli, un.varianceMilli], ['VAN_UNLOAD', 'VAN:R1', 'WH', -420_000n, 0n]);
  // WH 140 @ 2,940,000 والسيارة صفر — من مساهمات اللقطات وحدها
  const c = contributions(db.tables.glCostSnapshot);
  assert.deepEqual([...c.entries()], [['A|WH', { qU: toQtyU(140), v: 2_940_000n }]]);
});

test('تشغيلان متتاليان ⇒ صفر لقطات مكرّرة وصفر كتابة (إعادة الطيّ تحقّقٌ لا كتابة)', async () => {
  const db = new CostingFakeDb();
  exampleA(db);
  await run(db);
  const before = snapshotsOf(db);
  const writesBefore = db.writes().length;
  const second = await run(db);
  assert.equal(second.snapshotsWritten, 0);
  assert.equal(second.movesFolded, 0);
  assert.equal(second.stoppedBy, 'DONE');
  assert.equal(db.writes().length, writesBefore, 'لا معاملة كتابة بلا جديد');
  assert.deepEqual(snapshotsOf(db), before);
  // جديدٌ بعدها يُطوى فوق الحالة المعاد طيّها
  db.addInvoice({ type: 'CASH', salesRepId: null, items: [{ productId: 'A', qty: 14 }] });
  const third = await run(db);
  assert.equal(third.snapshotsWritten, 1);
  const sale = db.tables.glCostSnapshot.find((r) => r.kind === 'WAREHOUSE_SALE')!;
  assert.equal(sale.valueMilli, -294_000n, '14 × 21');
});

test('القفل أول عبارة في كل معاملة، والكتابة في gl_cost_* وحدها (تجسّس)', async () => {
  const db = new CostingFakeDb();
  exampleA(db);
  await run(db, { tuning: { batchSize: 3, checkpointMinMoves: 4 } });
  assert.ok(db.transactions >= 3);
  for (let n = 1; n <= db.transactions; n++) {
    const ops = db.txOps(n);
    assert.equal(ops[0].model, '$executeRaw', `معاملة ${n}: القفل أولاً`);
    assert.equal(ops[0].op, 'lock');
    assert.match(ops[0].sql!, /pg_advisory_xact_lock\(hashtext\(/);
    assert.ok(ops[0].sql!.includes(`${COST_LOCK_PREFIX}t1`));
  }
  const writes = db.writes();
  assert.ok(writes.length > 0);
  for (const w of writes) assert.ok((GL_COST_MODELS as readonly string[]).includes(w.model), `كتابة في ${w.model}`);
  assert.ok(writes.every((w) => w.tx !== null), 'كل كتابة داخل معاملة');
});

test('مجموعة الحفظ: الصفوف ثم الرأس آخر ما يُكتب في معاملته، ويُبقى ثلاث مجموعات كاملة', async () => {
  const db = new CostingFakeDb();
  exampleA(db);
  for (let i = 0; i < 6; i++) db.addReceipt(i % 2 ? 'A' : 'B', 5, 2 + i);
  await run(db, { tuning: { batchSize: 2, checkpointMinMoves: 2 } });
  let withCheckpoint = 0;
  for (let n = 1; n <= db.transactions; n++) {
    const w = db.txOps(n).filter((o) => o.write);
    if (!w.some((o) => o.model === 'glCostCheckpoint' && o.op === 'createMany')) continue;
    withCheckpoint++;
    const last = w[w.length - 1];
    assert.equal(last.model, 'glCostCheckpoint');
    assert.deepEqual(last.rows!.map((r) => [r.productId, r.location]), [[CHECKPOINT_HEAD, CHECKPOINT_HEAD]], `معاملة ${n}: الرأس آخراً`);
    const firstCp = w.findIndex((o) => o.model === 'glCostCheckpoint' && o.op === 'createMany');
    assert.ok(w.slice(0, firstCp).every((o) => o.model === 'glCostSnapshot' || o.op === 'deleteMany'), 'اللقطات والحذف قبل المجموعة');
  }
  assert.ok(withCheckpoint >= 4, `مجموعات: ${withCheckpoint}`);
  const sets = new Map<string, Row[]>();
  for (const r of db.tables.glCostCheckpoint) {
    const k = `${(r.cursorAt as Date).toISOString()}|${r.cursorId}`;
    sets.set(k, [...(sets.get(k) ?? []), r]);
  }
  assert.equal(sets.size, CHECKPOINT_KEEP_SETS);
  for (const rows of sets.values()) assert.equal(rows.filter((r) => r.productId === CHECKPOINT_HEAD).length, 1, 'كل مجموعة برأسها');
  // أحدث مجموعة = الحالة الكاملة = Σ اللقطات
  const cp = await loadLatestCheckpoint(asPrisma<SnapshotDb>(db), 't1');
  assert.ok(cp);
  assert.deepEqual(stateView(cp.state), contributions(db.tables.glCostSnapshot));
});

// ═══ الاستئناف = الإعادة الكاملة ═══

/** مولّد حتمي (mulberry32) */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** يضيف n حركة عشوائية بكل الأنواع (أسعار كسرية، كميات بستّ منازل، مكشوف، حُفر، مرتجعات وتبديلات وإلغاءات) */
function randomOps(db: CostingFakeDb, seed: number, n: number, state: { sales: string[]; returns: { id: string; item: string }[] }) {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const P = ['A', 'B', 'C'];
  const REPS = ['R1', 'R2', null];
  for (let i = 0; i < n; i++) {
    const x = r();
    const pid = pick(P);
    const q = Math.round((1 + r() * 9) * 1000) / 1000;
    if (x < 0.18) db.addReceipt(pid, q, r() < 0.15 ? null : Math.round(r() * 3000) / 100);
    else if (x < 0.22) db.addWarehouseEntry({ type: 'ADJUST', reason: 'COUNT', zeroRunId: r() < 0.3 ? 'z' : null, items: [{ productId: pid, qty: r() < 0.5 ? -q : q }] });
    else if (x < 0.24) db.addWarehouseEntry({ type: 'RETURN', items: [{ productId: pid, qty: q / 2, unitCost: 3 }] });
    else if (x < 0.36) db.addVanLoad({ salesRepId: pick(['R1', 'R2']), type: r() < 0.75 ? 'LOAD' : 'UNLOAD', items: [{ productId: pid, qty: r() < 0.1 ? -q : q }] });
    else if (x < 0.39) db.addVanLoad({ salesRepId: pick(['R1', 'R2']), type: r() < 0.6 ? 'ADJUST' : 'DAMAGED_OUT', items: [{ productId: pid, qty: r() < 0.5 ? -q / 3 : q / 3 }] });
    else if (x < 0.62) {
      const s = db.addInvoice({ type: r() < 0.5 ? 'CASH' : 'CREDIT', salesRepId: pick(REPS), items: [{ productId: pid, qty: q }, { productId: pick(P), qty: q / 2 }] });
      state.sales.push(...s.itemIds);
      if (r() < 0.12) db.cancelInvoice(s.id);
    } else if (x < 0.78 && state.sales.length) {
      const sale = pick(state.sales);
      const saleRow = db.tables.invoiceItem.find((it) => it.id === sale)!;
      const saleInv = db.tables.invoice.find((iv) => iv.id === saleRow.invoiceId)!;
      const ret = db.addInvoice({
        type: 'RETURN', salesRepId: saleInv.salesRepId as string | null, returnToStock: r() < 0.7, returnReason: r() < 0.1 ? 'DAMAGED' : 'NORMAL',
        items: [{ productId: saleRow.productId as string, qty: Math.max(0.5, (saleRow.qty as number) / 3), returnOfItemId: r() < 0.85 ? sale : null, returnExpired: r() < 0.1 }],
      });
      state.returns.push({ id: ret.id, item: ret.itemIds[0] });
    } else if (x < 0.92 && state.returns.length) {
      const ret = pick(state.returns);
      const inv = db.tables.invoice.find((iv) => iv.id === ret.id)!;
      db.toggleRestock(ret.id, !(inv.returnToStock as boolean));
    } else if (state.returns.length) {
      const ret = pick(state.returns);
      if (!db.tables.accountEntry.some((e) => e.invoiceId === ret.id && e.type === 'INVOICE_DEBIT')) db.cancelInvoice(ret.id);
    }
  }
}

function freshState() {
  return { sales: [] as string[], returns: [] as { id: string; item: string }[] };
}

test('الاستئناف من نقطة حفظ (دفعات صغيرة وتشغيلات مقطوعة بالسقف ومراحل بيانات) = الإعادة الكاملة حرفياً — كل الحقول', async () => {
  for (const seed of [1, 7, 42]) {
    const a = new CostingFakeDb();
    const b = new CostingFakeDb();
    const sa = freshState();
    const sb = freshState();
    for (let phase = 0; phase < 3; phase++) {
      randomOps(a, seed * 100 + phase, 40, sa);
      randomOps(b, seed * 100 + phase, 40, sb);
      await runUntilDone(a, { maxMoves: 7, tuning: { batchSize: 3, checkpointMinMoves: 11, pageSize: 2 } });
    }
    await run(b);
    assert.deepEqual(snapshotsOf(a), snapshotsOf(b), `seed ${seed}: اللقطات`);
    assert.equal(a.tables.glCostSnapshot.filter((r) => r.lateArrival).length, 0);
    // = replay لكل الحركات (المحرّك نفسه بلا تجميد)
    const all = await loadMoves(asPrisma<CostingDb>(b), 't1', { until: FAR, currencyDecimals: 2 });
    const full = replay(all.moves, { currencyDecimals: 2 });
    const asRows = full.outputs.map((o) => { const { createdAt: _c, ...rest } = snapshotRow('t1', o) as Row; void _c; return rest; })
      .sort((x, y) => (String(x.sourceKey) < String(y.sourceKey) ? -1 : 1));
    assert.deepEqual(snapshotsOf(b), asRows, `seed ${seed}: = replay`);
    // نقطة الحفظ الأخيرة بعد تشغيلٍ يجبرها = الحالة الكاملة حرفياً (الكميتان والقيمة وآخر متوسّط)
    await run(a, { tuning: { checkpointMinMoves: 1 } });
    const cp = await loadLatestCheckpoint(asPrisma<SnapshotDb>(a), 't1');
    assert.ok(cp);
    assert.deepEqual(new Map([...cp.state.locs].sort()), new Map([...full.state.locs].sort()), `seed ${seed}: الحالة`);
    assert.equal(cp.state.movesFolded, full.state.movesFolded);
    assert.deepEqual(stateView(cp.state), contributions(a.tables.glCostSnapshot), `seed ${seed}: Σ اللقطات = الحالة`);
  }
});

test('خاصية: إعادة الطيّ الاصطناعية من اللقطات تطابق كل لقطة (قيمة وفرقاً وخارجاً عن التقييم) وتنتهي إلى حالة الإعادة الكاملة — 25 تسلسلاً عشوائياً', async () => {
  for (let seed = 1; seed <= 25; seed++) {
    const db = new CostingFakeDb();
    randomOps(db, 9000 + seed, 120, freshState());
    await run(db);
    // تشغيلٌ ثانٍ بلا نقطة حفظ: يعيد طيّ كل اللقطات اصطناعياً ويطابقها واحدة واحدة (أي فرق ⇒ يرمي)، ثم يطوي الجديد فوقها
    db.addInvoice({ type: 'CREDIT', salesRepId: 'R1', items: [{ productId: 'A', qty: 1.5 }, { productId: 'B', qty: 2 }, { productId: 'C', qty: 0.25 }] });
    db.addReceipt('C', 3, 4.1);
    const r = await run(db, { tuning: { checkpointMinMoves: 1 } });
    assert.equal(r.snapshotsWritten, 4, `seed ${seed}`);
    const all = await loadMoves(asPrisma<CostingDb>(db), 't1', { until: FAR, currencyDecimals: 2 });
    const full = replay(all.moves, { currencyDecimals: 2 });
    const cp = await loadLatestCheckpoint(asPrisma<SnapshotDb>(db), 't1');
    assert.deepEqual(new Map([...cp!.state.locs].sort()), new Map([...full.state.locs].sort()), `seed ${seed}: الحالة`);
    const tail = full.outputs.slice(-4).map((o) => snapshotRow('t1', o));
    for (const t of tail) {
      const got = snap(db, t.sourceKey as string);
      assert.equal(got.valueMilli, t.valueMilli, `seed ${seed}: ${t.sourceKey}`);
      assert.equal(got.varianceMilli, t.varianceMilli);
    }
  }
});

test('وصول متأخر قبل نقطة الحفظ نفسها (المؤشّر المحفوظ أبعد من آخر لقطة) يُكشف ويُطوى', async () => {
  const db = new CostingFakeDb();
  const x = exampleA(db);
  db.addInvoice({ type: 'CREDIT', salesRepId: 'R1', documentKind: 'DEBIT_NOTE', items: [{ productId: null, qty: 1 }] }); // صفّ بلا حركة بعد آخر لقطة
  const r1 = await run(db, { tuning: { checkpointMinMoves: 1 } });
  assert.equal(r1.checkpointWritten, true);
  const cp1 = await loadLatestCheckpoint(asPrisma<SnapshotDb>(db), 't1');
  assert.ok(cp1!.cursor.createdAt.getTime() > x.unload.createdAt.getTime() || cp1!.cursor.id !== x.unload.id);
  const late = db.addReceipt('B', 4, 2.5, { at: new Date(x.load.createdAt.getTime() + 1) });
  const r2 = await run(db);
  assert.equal(r2.lateArrivals, 1);
  assert.equal(snap(db, whItemKey(late.itemIds[0])).lateArrival, true);
});

// ═══ الوصول المتأخر ═══

test('وصول متأخر (صفّ مؤشّره قبل آخر لقطة): يُطوى في موضع ظهوره بـlateArrival=true مع نقطة حفظ في معاملته، ولا انجراف بعده', async () => {
  const db = new CostingFakeDb();
  const x = exampleA(db);
  await run(db);
  // معاملةٌ طويلة التزمت الآن بصفٍّ لحظته قبل التحميل الأخير
  const lateAt = new Date(x.unload.createdAt.getTime() - 500);
  const late = db.addWarehouseEntry({ at: lateAt, items: [{ productId: 'A', qty: 10, unitCost: 30 }] });
  db.clock = x.unload.createdAt.getTime() + 10_000;
  const r2 = await run(db);
  assert.equal(r2.lateArrivals, 1);
  assert.equal(r2.movesFolded, 1);
  assert.equal(r2.checkpointWritten, true, 'نقطة حفظ إلزامية مع المتأخر');
  const ls = snap(db, whItemKey(late.itemIds[0]));
  assert.equal(ls.lateArrival, true);
  assert.equal(ls.srcCreatedAt instanceof Date && (ls.srcCreatedAt as Date).getTime(), lateAt.getTime(), 'المؤشّر الطبيعي محفوظ');
  assert.equal(ls.valueMilli, 300_000n);
  // تشغيل بلا جديد ثم جديد: لا انجراف ولا تكرار، والمتأخر لا يُعاد ترتيبه
  const r3 = await run(db);
  assert.equal(r3.snapshotsWritten, 0);
  db.addInvoice({ type: 'CREDIT', salesRepId: null, items: [{ productId: 'A', qty: 5 }] });
  const r4 = await run(db, { tuning: { checkpointMinMoves: 1 } });
  assert.equal(r4.snapshotsWritten, 1);
  const cp = await loadLatestCheckpoint(asPrisma<SnapshotDb>(db), 't1');
  assert.deepEqual(stateView(cp!.state), contributions(db.tables.glCostSnapshot));
  // WH: 140 @ 2,940,000 + 10 @ 300,000 = 150 @ 3,240,000 (21.6) ثم بيع 5 = 108,000
  assert.equal(db.tables.glCostSnapshot.find((r) => r.kind === 'WAREHOUSE_SALE')!.valueMilli, -108_000n);
});

test('وصول متأخر داخل مدى إعادة الطيّ: lateScan=false يؤجّله (لا يُطوى في غير موضعه)، والمسح التالي يطويه في موضع ظهوره', async () => {
  const db = new CostingFakeDb();
  const x = exampleA(db);
  await run(db);
  const late = db.addInvoice({ at: new Date(x.s2.createdAt.getTime() + 1), type: 'CREDIT', salesRepId: null, items: [{ productId: 'A', qty: 1 }] });
  db.clock = x.unload.createdAt.getTime() + 10_000;
  const skipped = await run(db, { lateScan: false });
  assert.deepEqual([skipped.lateArrivals, skipped.snapshotsWritten, skipped.stoppedBy], [0, 0, 'DONE']);
  const r = await run(db);
  assert.equal(r.lateArrivals, 1);
  assert.equal(snap(db, saleOutKey(late.itemIds[0])).lateArrival, true);
  // يُقيَّم بمتوسّط لحظة ظهوره (بعد كل ما طُوي): المستودع 140 @ 2,940,000 ⇒ 21
  assert.equal(snap(db, saleOutKey(late.itemIds[0])).valueMilli, -21_000n);
  const again = await run(db);
  assert.equal(again.snapshotsWritten, 0);
});

test('findLateMoves: ≤ المؤشّر وبلا لقطة وداخل نافذة LATE_SCAN_LOOKBACK_MS وحدها', async () => {
  const db = new CostingFakeDb();
  const base = new Date('2026-06-01T12:00:00.000Z').getTime();
  const old = db.addReceipt('A', 1, 1, { at: new Date(base - LATE_SCAN_LOOKBACK_MS - 1000) });
  const inWin = db.addReceipt('A', 2, 1, { at: new Date(base - 1000) });
  const done = db.addReceipt('A', 3, 1, { at: new Date(base - 500) });
  const after = db.addReceipt('A', 4, 1, { at: new Date(base + 1000) });
  const out = replay((await loadMoves(asPrisma<CostingDb>(db), 't1', { until: FAR, currencyDecimals: 2 })).moves.filter((m) => m.refId === done.id), { currencyDecimals: 2 });
  db.tables.glCostSnapshot.push({ id: 'x', createdAt: new Date(), ...(snapshotRow('t1', out.outputs[0]) as Row) });
  const late = await findLateMoves(asPrisma<SnapshotDb>(db), 't1', { createdAt: new Date(base), id: 'zzz' }, { currencyDecimals: 2 });
  assert.deepEqual(late.map((m) => m.refId), [inWin.id]);
  assert.equal(late[0].lateArrival, true);
  void old; void after;
});

// ═══ التزامن والميزانية والأفق ═══

test('تشغيلٌ آخر كتب بين القراءة والكتابة ⇒ CONCURRENT بلا أي كتابة من هذا التشغيل', async () => {
  const db = new CostingFakeDb();
  exampleA(db);
  db.beforeTransaction = () => {
    db.tables.glCostSnapshot.push({
      id: 'other', tenantId: 't1', sourceKey: 'COST:WH_ENTRY:other', kind: 'RECEIVE', refType: 'WH_ENTRY', refId: 'o', itemId: 'other',
      productId: 'Z', location: 'WH', toLocation: null, baseQty: 1, uncostedQty: 0, valueMilli: 10n, varianceMilli: 0n, memoMilli: 0n,
      unitCostE4: 0n, method: 'AVCO', effectAt: new Date('2026-01-01'), srcCreatedAt: new Date('2026-01-01'), srcId: 'zz', lateArrival: false, createdAt: new Date(),
    });
    db.beforeTransaction = null;
  };
  const r = await run(db);
  assert.equal(r.stoppedBy, 'CONCURRENT');
  assert.equal(r.snapshotsWritten, 0);
  assert.deepEqual(db.tables.glCostSnapshot.map((x) => x.id), ['other']);
  assert.equal(db.tables.glCostCheckpoint.length, 0);
});

test('maxMoves ⇒ BUDGET عند حدّ صفّ مصدر، والتشغيل التالي يكمل من حيث توقّف؛ وdeadline ⇒ BUDGET بلا كتابة', async () => {
  const db = new CostingFakeDb();
  exampleA(db);
  const r1 = await run(db, { maxMoves: 3 });
  assert.equal(r1.stoppedBy, 'BUDGET');
  assert.equal(r1.movesFolded, 3);
  assert.equal(db.tables.glCostSnapshot.length, 3);
  const r2 = await run(db);
  assert.equal(r2.stoppedBy, 'DONE');
  assert.equal(r2.movesFolded, 7);
  const db2 = new CostingFakeDb();
  exampleA(db2);
  const r3 = await run(db2, { clock: () => 1000, deadline: 1000 });
  assert.equal(r3.stoppedBy, 'BUDGET');
  assert.equal(db2.tables.glCostSnapshot.length, 0);
});

test('الأفق الافتراضي = ساعة القاعدة − نافذة الالتزام المتأخر (= LATE_COMMIT_WINDOW_MS في sync)', async () => {
  assert.equal(COST_LATE_COMMIT_WINDOW_MS, LATE_COMMIT_WINDOW_MS);
  const db = new CostingFakeDb();
  db.dbNow = new Date('2026-06-01T12:00:00.000Z');
  db.addReceipt('A', 1, 1, { at: new Date(db.dbNow.getTime() - COST_LATE_COMMIT_WINDOW_MS - 1) });
  db.addReceipt('A', 1, 1, { at: new Date(db.dbNow.getTime() - COST_LATE_COMMIT_WINDOW_MS + 1) });
  const r = await computeSnapshots(asPrisma<Parameters<typeof computeSnapshots>[0]>(db), 't1', { currencyDecimals: 2 });
  assert.equal(r.snapshotsWritten, 1);
  assert.ok(db.ops.some((o) => o.model === '$queryRaw' && /now\(\)/.test(o.sql ?? '')));
});

// ═══ إعادة الطيّ: المجمَّد يغلب، والانجراف يُرفض ═══

test('صفّ أساسي مكرّر في تشغيل لاحق ⇒ لا يُطوى ثانيةً (المفتاح مجمَّد)، ولا يكسر إعادة الطيّ', async () => {
  const db = new CostingFakeDb();
  const x = exampleA(db);
  await run(db);
  db.addAccountEntry({ invoiceId: x.s2.id, type: 'INVOICE_DEBIT' }); // تكرار البيع
  db.addInvoice({ type: 'CREDIT', salesRepId: null, items: [{ productId: 'A', qty: 1 }] });
  const r = await run(db, { tuning: { checkpointMinMoves: 1 } });
  assert.equal(r.snapshotsWritten, 1);
  assert.equal(db.tables.glCostSnapshot.filter((s) => s.sourceKey === saleOutKey(x.s2.itemIds[0])).length, 1);
  const cp = await loadLatestCheckpoint(asPrisma<SnapshotDb>(db), 't1');
  assert.deepEqual(stateView(cp!.state), contributions(db.tables.glCostSnapshot));
  // وتشغيلٌ بعد نقطة الحفظ يرى المكرّر جديداً بمفتاحٍ مكتوب ⇒ لا يُطوى
  db.addAccountEntry({ invoiceId: x.s2.id, type: 'INVOICE_DEBIT' });
  const r2 = await run(db);
  assert.equal(r2.snapshotsWritten, 0);
  assert.equal(r2.movesFolded, 0);
});

test('حذف المندوب بعد الطيّ (فاتورته صارت بلا مندوب) ⇒ إعادة الطيّ تأخذ الموقع المجمَّد فلا فرق', async () => {
  const db = new CostingFakeDb();
  const x = exampleA(db);
  await run(db);
  for (const inv of db.tables.invoice) inv.salesRepId = null;
  for (const v of db.tables.vanLoad) { v.deletedSalesRepId = v.salesRepId; v.salesRepId = null; }
  db.addReceipt('A', 10, 24);
  const r = await run(db);
  assert.equal(r.snapshotsWritten, 1);
  assert.equal(snap(db, saleOutKey(x.s2.itemIds[0])).location, 'VAN:R1');
  // WH 140 @ 2,940,000 + 240,000 = 150 @ 3,180,000
  const c = contributions(db.tables.glCostSnapshot);
  assert.deepEqual(c.get('A|WH'), { qU: toQtyU(150), v: 3_180_000n });
});

test('ختم «منتهي الصلاحية» بعد الطيّ ⇒ إعادة الطيّ بنوع اللقطة المجمَّد (عائد) فلا فرق', async () => {
  const db = new CostingFakeDb();
  const x = exampleA(db);
  await run(db);
  db.tables.invoiceItem.find((it) => it.id === x.ret.itemIds[0])!.returnExpired = true;
  db.addReceipt('A', 1, 1);
  const r = await run(db);
  assert.equal(r.snapshotsWritten, 1);
});

/** probe1: مستودع 10 @ 100، تحميل 10، بيع 4، مرتجع 2 عائد مرتبط — يُطوى قبل أن يُختم «منتهياً» (stampExpiryIfMissing عند إعادة الرفع) */
function lateExpiryReturn(db: CostingFakeDb) {
  db.addReceipt('A', 10, 100);
  db.addVanLoad({ salesRepId: 'R1', items: [{ productId: 'A', qty: 10 }] });
  const sale = db.addInvoice({ type: 'CASH', salesRepId: 'R1', items: [{ productId: 'A', qty: 4 }] });
  const ret = db.addInvoice({ type: 'RETURN', salesRepId: 'R1', returnToStock: true, items: [{ productId: 'A', qty: 2, returnOfItemId: sale.itemIds[0] }] });
  const retItem = ret.itemIds[0];
  const stamp = () => { db.tables.invoiceItem.find((it) => it.id === retItem)!.returnExpired = true; };
  return { ret, retItem, stamp };
}

async function fullVan(db: CostingFakeDb) {
  const full = replay((await loadMoves(asPrisma<CostingDb>(db), 't1', { until: FAR, currencyDecimals: 2 })).moves, { currencyDecimals: 2 });
  return stateView(full.state).get('A|VAN:R1');
}

test('ختم «منتهي» بعد طيّ المرتجع عائداً ثم إلغاؤه ⇒ RETURN_CANCEL يُخرج 2 بلقطة RET المجمَّدة (لا بضاعة وهمية في 114002)', async () => {
  const db = new CostingFakeDb();
  const x = lateExpiryReturn(db);
  await run(db);
  assert.equal(snap(db, returnKey(x.retItem)).kind, 'VAN_RETURN_RESTOCK', 'طُوي عائداً قبل الختم');
  x.stamp();
  db.cancelInvoice(x.ret.id);
  const r = await run(db);
  assert.equal(r.snapshotsWritten, 1);
  const c = snap(db, returnCancelKey(x.retItem));
  assert.deepEqual([c.kind, c.location, c.baseQty, c.valueMilli, c.memoMilli], ['RETURN_CANCEL', 'VAN:R1', -2, -200_000n, 0n]);
  // السيارة 6 @ 600 = الشاشة التشغيلية (المرتجع الملغى لا يُحتسب) = الإعادة الكاملة من المصادر الحالية (المعاينة)
  assert.deepEqual(contributions(db.tables.glCostSnapshot).get('A|VAN:R1'), { qU: toQtyU(6), v: 600_000n });
  assert.deepEqual(await fullVan(db), { qU: toQtyU(6), v: 600_000n });
  assert.equal(db.tables.glCostSnapshot.reduce((s, row) => s + (row.memoMilli as bigint), 0n), 0n, 'لا شطب');
});

test('ختم «منتهي» بعد طيّ المرتجع عائداً ثم تبديل إلى «لا يعود» ⇒ يُخرج 2 (لا يُتخطّى المكتوب عليه)، وما بعده لا يعيده ولا يكرّر خروجه', async () => {
  const db = new CostingFakeDb();
  const x = lateExpiryReturn(db);
  await run(db);
  x.stamp();
  const off = db.toggleRestock(x.ret.id, false);
  await run(db);
  const t = snap(db, restockToggleKey(off, x.retItem));
  assert.deepEqual([t.location, t.baseQty, t.valueMilli, t.memoMilli], ['VAN:R1', -2, -200_000n, 200_000n]);
  assert.deepEqual(contributions(db.tables.glCostSnapshot).get('A|VAN:R1'), { qU: toQtyU(6), v: 600_000n });
  // المكتوب عليه لا يعود: التبديلات اللاحقة لا تُشتقّ، والإلغاء يعكس مذكِّرة خروجه
  const on = db.toggleRestock(x.ret.id, true);
  const off2 = db.toggleRestock(x.ret.id, false);
  db.cancelInvoice(x.ret.id);
  await run(db);
  for (const k of [on, off2]) assert.equal(db.tables.glCostSnapshot.filter((s) => s.sourceKey === restockToggleKey(k, x.retItem)).length, 0);
  const c = snap(db, returnCancelKey(x.retItem));
  assert.deepEqual([c.baseQty, c.valueMilli, c.memoMilli], [0, 0n, -200_000n]);
  assert.deepEqual(contributions(db.tables.glCostSnapshot).get('A|VAN:R1'), { qU: toQtyU(6), v: 600_000n });
  assert.deepEqual(await fullVan(db), { qU: toQtyU(6), v: 600_000n });
  assert.equal(db.tables.glCostSnapshot.reduce((s, row) => s + (row.memoMilli as bigint), 0n), 0n, 'صافي الشطب صفر: مرتجعٌ ملغى');
});

test('ختم «منتهي» بعد طيّ المرتجع عائداً ثم «تصفير المخزون» بإزالة المنتهي وحدها (المتاح صفر) ⇒ تُستنزف السيارة فلا تبقى بضاعته في 114002', async () => {
  const db = new CostingFakeDb();
  const x = lateExpiryReturn(db);
  await run(db);
  x.stamp();
  // المندوب باع الستّ الباقية: المتاح التشغيلي صفر و«المنتهي» 2، والمحرّك يرى 2 (RET عائد مجمَّد)
  db.addInvoice({ type: 'CASH', salesRepId: 'R1', items: [{ productId: 'A', qty: 6 }] });
  // خطة التصفير لهذه السيارة: EXPIRED_OUT بالمنتهي وحده (لا سطر ADJUST لمتاحٍ صفري)
  const z = db.addVanLoad({ salesRepId: 'R1', type: 'EXPIRED_OUT', zeroRunId: 'zr1', items: [{ productId: 'A', qty: 2 }] });
  await run(db);
  const zs = snap(db, vanItemKey(z.itemIds[0]));
  assert.deepEqual([zs.kind, zs.location, zs.baseQty, zs.valueMilli], ['ZERO_RUN', 'VAN:R1', -2, -200_000n]);
  assert.equal(contributions(db.tables.glCostSnapshot).get('A|VAN:R1'), undefined, 'السيارة صفرٌ بعد التصفير');
  assert.equal(await fullVan(db), undefined, 'والإعادة الكاملة كذلك');
});

test('مصدرٌ حُذف بعد طيّه (في مدى إعادة الطيّ) ⇒ لا أثر: إعادة الطيّ من اللقطة المجمَّدة لا من المصدر', async () => {
  const db = new CostingFakeDb();
  const x = exampleA(db);
  await run(db);
  db.tables.warehouseEntryItem = db.tables.warehouseEntryItem.filter((it) => it.id !== x.r2.itemIds[0]);
  db.addInvoice({ type: 'CREDIT', salesRepId: null, items: [{ productId: 'A', qty: 7 }] });
  const r = await run(db);
  assert.equal(r.snapshotsWritten, 1);
  assert.equal(db.tables.glCostSnapshot.find((s) => s.kind === 'WAREHOUSE_SALE')!.valueMilli, -147_000n, '7 × 21 من الحالة المجمَّدة');
});

test('لقطة عُبث بها في مدى إعادة الطيّ ⇒ COST_REFOLD_MISMATCH قبل أي كتابة (فشلٌ مغلق)', async () => {
  const db = new CostingFakeDb();
  const x = exampleA(db);
  await run(db);
  const row = db.tables.glCostSnapshot.find((s) => s.sourceKey === saleOutKey(x.s2.itemIds[0]))!;
  row.valueMilli = -250_000n;
  db.addReceipt('A', 1, 1);
  const writes = db.writes().length;
  await assert.rejects(run(db), (e: unknown) => e instanceof CostRefoldMismatchError && e.code === 'COST_REFOLD_MISMATCH'
    && e.details.some((d) => d.includes(saleOutKey(x.s2.itemIds[0]))));
  assert.equal(db.writes().length, writes);
});

test('بعد نقطة حفظ لا يُعاد طيّ ما قبلها: حذف صفٍّ قديم لا يمسّ التشغيلات اللاحقة', async () => {
  const db = new CostingFakeDb();
  const x = exampleA(db);
  await run(db, { tuning: { checkpointMinMoves: 1 } });
  db.tables.warehouseEntryItem = db.tables.warehouseEntryItem.filter((it) => it.id !== x.r2.itemIds[0]);
  db.addInvoice({ type: 'CREDIT', salesRepId: null, items: [{ productId: 'A', qty: 1 }] });
  const r = await run(db);
  assert.equal(r.snapshotsWritten, 1);
  assert.equal(db.tables.glCostSnapshot.find((s) => s.kind === 'WAREHOUSE_SALE')!.valueMilli, -21_000n);
});

test('الصلات تُقرأ من خصائصها الذاتية: صلةٌ بلا mirrorOf صريح لا تُرسل إلى القاعدة إلا مفاتيح نصّية', async () => {
  // حركة يبنيها مستهلكٌ آخر بلا mirrorOf: findLateMoves/الدفعات تجمع مفاتيح صلاتها — القاعدة المزيّفة ترمي FAKE_INVALID_IN
  const db = new CostingFakeDb();
  const x = exampleA(db);
  await run(db);
  db.cancelInvoice(x.ret.id); // RETURN_CANCEL عائد بصلة locationOf وحدها في الاشتقاق
  const r = await run(db);
  assert.equal(r.snapshotsWritten, 1);
  const c = db.tables.glCostSnapshot.find((s) => s.kind === 'RETURN_CANCEL')!;
  assert.deepEqual([c.location, c.baseQty, c.valueMilli], ['VAN:R1', -2, -42_000n]);
  const links = { locationOf: returnKey(x.ret.itemIds[0]) } as Move['links'];
  assert.equal((links as Record<string, unknown>).mirrorOf, undefined, 'اسم صلة القيمة لا يرثه كائن (كان valueOf في العقد)');
});

// ═══ التحويلات الصرفة ═══

test('checkpointRows ⇄ stateFromCheckpointRows: ذهاب-إياب بلا فقد، والرأس آخراً، والصفري لا يُكتب', () => {
  const st = createCostState();
  st.locs.set(locStateKey('B', 'VAN:R1'), { costedQtyU: -4_000_000, uncostedQtyU: 0, valueMilli: -32_000n, lastAvg: null });
  st.locs.set(locStateKey('A', 'WH'), { costedQtyU: 10_123_457, uncostedQtyU: 2_000_001, valueMilli: 50_010n, lastAvg: { valueMilli: 99_990n, qtyU: 3_333_333 } });
  st.locs.set(locStateKey('C', 'WH'), { costedQtyU: 0, uncostedQtyU: 0, valueMilli: 0n, lastAvg: { valueMilli: 5_000n, qtyU: 1_000_000 } });
  st.locs.set(locStateKey('D', 'VAN:_'), { costedQtyU: 0, uncostedQtyU: 0, valueMilli: 0n, lastAvg: null });
  st.movesFolded = 1234;
  const cursor = { createdAt: new Date('2026-03-01T00:00:00Z'), id: 'ae-9' };
  const rows = checkpointRows('t1', st, cursor);
  assert.deepEqual(rows.map((r) => `${r.productId}|${r.location}`), ['A|WH', 'B|VAN:R1', 'C|WH', '*|*']);
  assert.equal(rows[3].movesFolded, 1234);
  assert.equal(rows[0].qtyBase, 12.123458);
  assert.equal(rows[0].uncostedQty, 2.000001);
  const back = stateFromCheckpointRows(rows as unknown as CheckpointRowLike[]);
  const expected = createCostState();
  for (const [k, v] of st.locs) if (k !== locStateKey('D', 'VAN:_')) expected.locs.set(k, v);
  assert.deepEqual(new Map([...back.locs].sort()), new Map([...expected.locs].sort()));
  assert.equal(back.movesFolded, 1234);
  assert.deepEqual(back.cursor, cursor);
});

test('snapshotRow ⇄ snapshotRefFromRow = snapshotRefOf (الصلات تُحلّ من الصفّ المخزَّن كما من الذاكرة)', () => {
  const moves: Move[] = [
    { key: 'COST:WH_ENTRY:w1', kind: 'RECEIVE', effectAt: new Date('2026-01-02'), cursor: { createdAt: new Date('2026-01-02'), id: 'e1' }, productId: 'A', location: 'WH', baseQty: 3, inValueMilli: 1_000n, refType: 'WH_ENTRY', refId: 'e1', itemId: 'w1' },
    { key: 'COST:VAN_LOAD:v1', kind: 'VAN_LOAD', effectAt: new Date('2026-01-03'), cursor: { createdAt: new Date('2026-01-03'), id: 'l1' }, productId: 'A', location: 'WH', toLocation: 'VAN:R1', baseQty: -1.5, refType: 'VAN_LOAD', refId: 'l1', itemId: 'v1' },
  ];
  const { outputs } = replay(moves, { currencyDecimals: 2 });
  for (const o of outputs as StepOutput[]) {
    const row = snapshotRow('t1', o) as Row;
    assert.deepEqual(snapshotRefFromRow(row as never), snapshotRefOf(o));
    assert.equal(row.method, 'AVCO');
    assert.equal(row.lateArrival, false);
  }
});
