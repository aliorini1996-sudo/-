// «تتبّع اللوط» — البوابة A (التقريب): الصالح الذي يحرس كل إنقاص لا يتجاوز الخام الفعلي أبداً (I1)، أيّاً كان مصدر الكسر.
// الخلل (gate 0): الإعادة (R6) لا تُرفض بكسرٍ أدقّ من أربع خانات فتكتب صفّاً مسمّى 0.00005، والطيّ مقرَّب نصف لأعلى فيُعرض
// الخام 0.99995 صالحاً 1، فيصرف بيعٌ حيّ 1 كاملاً والخام −0.00005 (⇒ −0.0001). الإصلاح طبقتان:
//   • الحارس: الصالح أرضيةُ الفرق الفعلي (floorLot) والعرض نصف لأعلى كما هو — يحرس البيع والتحميل والصريح والتنزيل والإزالة
//     معاً، ولو جاء الكسر من مصدرٍ آخر (صفّ قديم، تحويل أساس…).
//   • الكاتب: صفّ الإعادة والمرتجع الموروث المسمّى على شبكة الأربع خانات، والباقي (دون 0.0001) صفٌّ غير معروف (I3 كما هو).
// وعلى الشبكة (كل كمية بأربع خانات) النتائج كما كانت حرفياً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOT_EPS, allocateOutLines, allocateReturnFromSale, buildPlaceView, foldVanLots, foldWarehouseLots, pickOutSources, removalKeepsLots, roundLot,
  splitAvailability, zeroBuckets,
  type AggInvLot, type AggVanLot, type AllocRow, type LotMeta, type LotRaw, type PlaceLotView, type SaleLotRow,
} from '../services/lots';

const DAY = '2026-10-30';
const AT = new Date('2026-10-29T10:00:00Z');
const LOADED = new Date('2026-10-01T08:00:00Z');
const meta = (id: string, expiry: string): LotMeta => ({
  id, productId: 'P', lotNumber: `N-${id}`, productionDate: null, expiryDate: expiry, status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: new Date(0),
});
const METAS = new Map<string, LotMeta>([['L1', meta('L1', '2030-01-01')], ['L2', meta('L2', '2030-06-01')], ['L3', meta('L3', '2031-01-01')]]);
const LOTS = ['L1', 'L2', 'L3'];

/** مولّد عشوائي بذرة ثابتة (mulberry32) — الفشل يتكرّر بالبذرة نفسها */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    bool: (p = 0.5) => next() < p,
  };
}

const CASH = { type: 'CASH', returnToStock: null, returnExpired: null, damaged: false };
const RESTOCK = { type: 'RETURN', returnToStock: true, returnExpired: null, damaged: false };

/**
 * سيارةٌ واحدة لصنفٍ واحد: سجلّ صفوفٍ كما تكتبها الحزم، والعرض من الطيّ الحقيقي (foldVanLots ثم buildPlaceView) برصيد صنفٍ
 * مقرَّب كـvanStock، والخام **الفعلي** لكل لوط جمعاً حرفياً لصفوفه — وهو ما يحرسه I1.
 */
class Van {
  van: AggVanLot[] = [];
  inv: (AggInvLot & { doc: number; id: string; source?: string | null })[] = [];
  exactTotal = 0;
  private seq = 0;
  view(): PlaceLotView {
    const f = foldVanLots(this.van, this.inv, [], 'V');
    return buildPlaceView({
      productId: 'P', place: 'VAN', vanKey: 'V', total: { SELLABLE: roundLot(this.exactTotal), EXPIRED: 0, DAMAGED: 0 },
      named: f.named.get('P') ?? new Map(), heldUnknown: zeroBuckets(), metas: METAS, firstInAt: f.firstInAt.get('P'),
    });
  }
  trueRaw(lotId: string): number {
    let s = 0;
    for (const r of this.van) if (r.lotId === lotId) s += r.moveType === 'UNLOAD' ? -r.qty : r.qty;
    for (const r of this.inv) if (r.lotId === lotId) s += r.route.type === 'RETURN' ? r.qty : -r.qty;
    return s;
  }
  move(lotId: string | null, moveType: 'LOAD' | 'UNLOAD' | 'ADJUST', qty: number): void {
    this.van.push({ productId: 'P', lotId, vanKey: 'V', moveType, viaWarehouse: false, qty, firstInAt: LOADED });
    this.exactTotal += moveType === 'UNLOAD' ? -qty : qty;
  }
  write(rows: AllocRow[], route: AggInvLot['route']): { doc: number; saleRows: SaleLotRow[] } {
    const doc = ++this.seq;
    const out: SaleLotRow[] = [];
    for (const r of rows) {
      const id = `r${doc}-${out.length}`;
      this.inv.push({ productId: 'P', lotId: r.lotId, vanKey: 'V', route, held: false, qty: r.qty, doc, id, source: r.sourceItemLotId ?? null });
      this.exactTotal += route.type === 'RETURN' ? r.qty : -r.qty;
      out.push({ id, lotId: r.lotId, quantity: r.qty, certainty: r.certainty, expiryDate: r.expiryDate });
    }
    return { doc, saleRows: out };
  }
  sale(qty: number, opts: { replay?: boolean; explicit?: { lotId: string | null; qty: number }[]; unitFactor?: number } = {}) {
    const r = allocateOutLines({
      productId: 'P', productName: 'p', lines: [{ idx: 0, qty, unitFactor: opts.unitFactor ?? 1, explicit: opts.explicit ?? null }],
      view: this.view(), day: DAY, mode: 'SALE', allowUnknown: true, replay: opts.replay ? { at: AT, clamped: false } : null,
    });
    if (!r.ok) return { ok: false as const, code: r.error.code };
    return { ok: true as const, rows: r.rows, ...this.write(r.rows, CASH) };
  }
  unload(qty: number, explicit: { lotId: string | null; qty: number }[] | null) {
    const r = pickOutSources(this.view(), 'SELLABLE', qty, explicit);
    if (!r.ok) return { ok: false as const, code: r.error.code };
    for (const row of r.rows) this.move(row.lotId, 'UNLOAD', row.qty);
    return { ok: true as const, rows: r.rows };
  }
  /** مرتجعٌ مرتبط عائد للمخزون يرث صفوف بيعٍ سابق (ما أُرجع منها في مرتجعاتٍ قائمة مطروح) */
  linkedReturn(qty: number, sale: SaleLotRow[]) {
    const returned = new Map<string, number>();
    for (const r of this.inv) if (r.source) returned.set(r.source, (returned.get(r.source) ?? 0) + r.qty);
    const rows = allocateReturnFromSale({ qty, returnDay: DAY, saleRows: sale, returnedBySource: returned });
    return { rows, ...this.write(rows, RESTOCK) };
  }
  /** إلغاء مرتجع: removalKeepsLots على العرض قبل الإزالة، ثم تُحذف صفوفه */
  cancelReturn(doc: number): boolean {
    const mine = this.inv.filter((r) => r.doc === doc);
    const err = removalKeepsLots(this.view(), mine.map((r) => ({ productId: 'P', lotId: r.lotId, bucket: 'SELLABLE' as const, qty: r.qty })));
    if (err) return false;
    this.inv = this.inv.filter((r) => r.doc !== doc);
    for (const r of mine) this.exactTotal -= r.qty;
    return true;
  }
  /** I1: الخام الفعلي لكل لوطٍ مسمّى ≥ −EPS، والصالح المعروض لا يتجاوز الفعلي */
  assertI1(ctx: string): void {
    const v = this.view();
    for (const id of LOTS) {
      const t = this.trueRaw(id);
      assert.ok(t >= -LOT_EPS, `${ctx}: الخام الفعلي للوط ${id} = ${t} (I1)`);
      const l = v.lots.find((x) => x.lotId === id);
      if (l) assert.ok(l.usable.SELLABLE <= t + LOT_EPS, `${ctx}: صالح ${id} المعروض ${l.usable.SELLABLE} > الفعلي ${t}`);
    }
    assert.deepEqual(v.deficits.filter((d) => d.lotId != null), [], `${ctx}: لا عجز في لوطٍ مسمّى`);
  }
}

test('gate 0: إعادة 0.00005 ثم بيعٌ حيّ لكامل المعروض لا يجعل اللوط سالباً (load=1 وload=2/0.12345)', () => {
  for (const [load, replayQty] of [[1, 0.00005], [2, 0.12345], [5, 0.00005], [10, 3.00005], [7, 1.00015]] as const) {
    const v = new Van();
    v.move('L1', 'LOAD', load);
    const rep = v.sale(replayQty, { replay: true });
    assert.ok(rep.ok, 'الإعادة لا تُرفض (R6)');
    v.assertI1(`load=${load} بعد الإعادة ${replayQty}`);
    const shown = v.view().lots.find((l) => l.lotId === 'L1')!.usable.SELLABLE;
    v.sale(shown);                      // تُقبل أو تُرفض — المهم ألّا يُصرف ما لا يوجد
    v.assertI1(`load=${load} بعد بيع المعروض ${shown}`);
    v.sale(roundLot(load - replayQty)); // نصف لأعلى من الفعلي: كان يُقبل فيصرف فوق الخام
    v.assertI1(`load=${load} بعد بيع ${roundLot(load - replayQty)}`);
  }
});

test('gate 0 الكاتب: صفوف الإعادة المسمّاة بأربع خانات والباقي غير معروف، وΣ الصفوف = الكمية (I3)', () => {
  const v = new Van();
  v.move('L1', 'LOAD', 1);
  v.move('L2', 'LOAD', 2);
  const r = v.sale(2.00005, { replay: true });
  assert.ok(r.ok);
  for (const row of r.rows) if (row.lotId != null) assert.equal(roundLot(row.qty), row.qty, `صفّ ${row.lotId} = ${row.qty} بأربع خانات`);
  assert.ok(Math.abs(r.rows.reduce((s, x) => s + x.qty, 0) - 2.00005) <= 1e-12, 'Σ = الكمية');
  const dust = r.rows.filter((x) => x.lotId == null);
  assert.equal(dust.length, 1);
  assert.equal(dust[0].certainty, 'UNKNOWN');
  assert.ok(dust[0].qty > 0 && dust[0].qty < 1e-4);
  // كاملةً من غير المسمّى حين لا يتجاوز الكسر الشبكة: 0.00005 كلها غبار
  const w = new Van();
  w.move('L1', 'LOAD', 1);
  const d = w.sale(0.00005, { replay: true });
  assert.ok(d.ok);
  assert.deepEqual(d.rows.map((x) => [x.lotId, x.qty]), [[null, 0.00005]]);
});

test('gate 0 الحارس: كسرٌ من مصدرٍ آخر (صفّ قديم) لا يُصرف — البيع الحيّ والصريح والتنزيل والإزالة', () => {
  // خامٌ فعلي 0.99995 كتبه مصدرٌ غير الإعادة (صفّ بيعٍ قديم مسمّى بكسرٍ أدقّ)
  const mk = () => {
    const v = new Van();
    v.move('L1', 'LOAD', 1);
    v.write([{ lotId: 'L1', qty: 0.00005, certainty: 'CONFIRMED', flags: [], expiryDate: null }], CASH);
    return v;
  };
  const v0 = mk().view();
  const l = v0.lots[0];
  assert.equal(l.raw.SELLABLE, 1, 'العرض نصف لأعلى كما كان');
  assert.equal(l.usable.SELLABLE, 0.9999, 'الصالح الحارس أرضية الفعلي');
  assert.equal(splitAvailability(v0, DAY, { allowUnknown: true }).availableNamed, 0.9999, 'لقطة الجهاز بالصالح نفسه');

  const a = mk();
  assert.equal(a.sale(1).ok, false, 'البيع الآلي 1 من 0.99995 يُرفض');
  a.assertI1('آلي');
  assert.ok(a.sale(0.9999).ok);
  a.assertI1('آلي 0.9999');

  const b = mk();
  const be = b.sale(1, { explicit: [{ lotId: 'L1', qty: 1 }] });
  assert.equal(be.ok, false);
  assert.equal(be.ok ? null : be.code, 'LOT_STOCK_INSUFFICIENT');
  b.assertI1('صريح');

  const c = mk();
  assert.equal(c.unload(1, null).ok, false, 'التنزيل بلا صريح من المصدر الوحيد');
  assert.equal(c.unload(1, [{ lotId: 'L1', qty: 1 }]).ok, false, 'التنزيل الصريح');
  c.assertI1('تنزيل');

  // الإزالة: مرتجعٌ أعاد 0.00005 إلى خامٍ فعلي 1 ثم بيع المعروض — إلغاؤه لا يترك اللوط سالباً
  const d = new Van();
  d.move('L1', 'LOAD', 1);
  const ret = d.write([{ lotId: 'L1', qty: 0.00005, certainty: 'CONFIRMED', flags: [], expiryDate: null }], RESTOCK);
  const shown = d.view().lots[0].usable.SELLABLE;
  assert.equal(shown, 1, 'الخام الفعلي 1.00005 ⇒ الصالح 1 لا 1.0001');
  assert.ok(d.sale(shown).ok);
  d.assertI1('بعد البيع');
  d.cancelReturn(ret.doc);
  d.assertI1('بعد محاولة إلغاء المرتجع');
});

test('gate 0 المستودع: خامٌ فعلي 0.99995 من طيّ المستودع لا يُصرف منه 1', () => {
  const wf = foldWarehouseLots([{ productId: 'P', lotId: 'L1', qty: 1 }, { productId: 'P', lotId: 'L1', qty: -0.00005 }], [], []);
  const named = new Map<string, LotRaw>([...wf.get('P')!].map(([id, q]) => [id, { raw: { SELLABLE: q, EXPIRED: 0, DAMAGED: 0 }, held: zeroBuckets() }]));
  const view = buildPlaceView({ productId: 'P', place: 'WAREHOUSE', vanKey: null, total: { SELLABLE: roundLot(0.99995), EXPIRED: 0, DAMAGED: 0 }, named, heldUnknown: zeroBuckets(), metas: METAS });
  assert.equal(view.lots[0].raw.SELLABLE, 1);
  assert.equal(view.lots[0].usable.SELLABLE, 0.9999);
  const r = allocateOutLines({ productId: 'P', productName: 'p', lines: [{ idx: 0, qty: 1, unitFactor: 1 }], view, day: DAY, mode: 'LOAD', allowUnknown: false });
  assert.equal(r.ok, false, 'تحميل 1 من خامٍ فعلي 0.99995 يُرفض');
});

test('gate 0 المرتجع الموروث: صفٌّ مسمّى بكسرٍ أدقّ ⇒ أرضيته للوط والباقي غير معروف بمصدره، وΣ = الكمية', () => {
  const sale: SaleLotRow[] = [{ id: 's1', lotId: 'L1', quantity: 1, certainty: 'CONFIRMED', expiryDate: '2030-01-01' }];
  const rows = allocateReturnFromSale({ qty: 0.50005, returnDay: DAY, saleRows: sale, returnedBySource: new Map() });
  assert.deepEqual(rows.map((r) => [r.lotId, r.qty, r.certainty, r.sourceItemLotId]), [['L1', 0.5, 'CONFIRMED', 's1'], [null, rows[1]?.qty, 'UNKNOWN', 's1']]);
  assert.ok(Math.abs(rows[1].qty - 0.00005) <= 1e-12);
  // صفّ بيعٍ قديم بكسرٍ أدقّ (المتاح منه 0.00005 بعد مرتجعٍ سابق): يُرجَع كله غير معروف
  const old = allocateReturnFromSale({ qty: 1, returnDay: DAY, saleRows: [{ ...sale[0], quantity: 1.00005 }], returnedBySource: new Map([['s1', 1]]) });
  assert.deepEqual(old.map((r) => [r.lotId, r.sourceItemLotId]), [[null, 's1'], [null, null]]);
  assert.ok(Math.abs(old.reduce((s, r) => s + r.qty, 0) - 1) <= 1e-12);
  // على الشبكة كما كان حرفياً
  assert.deepEqual(allocateReturnFromSale({ qty: 0.5, returnDay: DAY, saleRows: sale, returnedBySource: new Map() }).map((r) => [r.lotId, r.qty]), [['L1', 0.5]]);
});

test('gate 0 خاصية: لا تسلسل من الإعادة بكسورٍ عشوائية والعمليات الحيّة والمرتجعات والإلغاء يجعل لوطاً مسمّى سالباً', () => {
  const r = rng(20261030);
  const q4 = (max: number) => Math.round(r.next() * max * 1e4) / 1e4;
  const qOff = (max: number) => Math.round(r.next() * max * 1e6) / 1e6 || 0.000005; // ست خانات كـroundQty
  for (let run = 0; run < 300; run++) {
    const v = new Van();
    const sales: SaleLotRow[][] = [];
    const returns: number[] = [];
    for (const id of LOTS) v.move(id, 'LOAD', q4(5) || 1);
    if (r.bool(0.5)) v.move(null, 'LOAD', q4(2));
    for (let step = 0; step < 25; step++) {
      const op = r.int(0, 8);
      const ctx = `run ${run} step ${step} op ${op}`;
      const view = v.view();
      const lot = r.pick(view.lots);
      if (op === 0) { const s = v.sale(qOff(3), { replay: true }); if (s.ok) sales.push(s.saleRows); }
      else if (op === 1) { const s = v.sale(q4(3) || 0.0001); if (s.ok) sales.push(s.saleRows); }
      else if (op === 2 && lot && lot.usable.SELLABLE > LOT_EPS) {
        // بيعٌ حيّ لكامل المعروض من لوطٍ واحد — صريحاً أو آلياً
        const s = r.bool() ? v.sale(lot.usable.SELLABLE, { explicit: [{ lotId: lot.lotId, qty: lot.usable.SELLABLE }] }) : v.sale(lot.usable.SELLABLE);
        if (s.ok) sales.push(s.saleRows);
      } else if (op === 3 && lot && lot.usable.SELLABLE > LOT_EPS) v.unload(lot.usable.SELLABLE, [{ lotId: lot.lotId, qty: lot.usable.SELLABLE }]);
      else if (op === 4 && sales.length) {
        const s = r.pick(sales);
        const sold = s.reduce((t, x) => t + x.quantity, 0);
        returns.push(v.linkedReturn(r.bool() ? qOff(sold) : Math.min(sold, q4(sold)) || 0.0001, s).doc);
      } else if (op === 5 && returns.length) { const i = r.int(0, returns.length - 1); if (v.cancelReturn(returns[i])) returns.splice(i, 1); }
      else if (op === 6) v.move(r.pick(LOTS), 'ADJUST', qOff(1));   // صفٌّ قديم بكسرٍ أدقّ من مصدرٍ آخر
      else if (op === 7) { const s = v.sale(qOff(view.lots.reduce((t, l) => t + l.usable.SELLABLE, 0) + 0.001), { replay: true }); if (s.ok) sales.push(s.saleRows); }
      else if (op === 8) { const s = v.sale(roundLot(view.lots.reduce((t, l) => t + Math.max(0, l.raw.SELLABLE), 0))); if (s.ok) sales.push(s.saleRows); }
      v.assertI1(ctx);
    }
  }
});

test('gate 0: على شبكة الأربع خانات العرض كما كان حرفياً — الخام والمحجوز نصف لأعلى، والصالح = تقريب(الخام − المحجوز)', () => {
  const r = rng(4);
  for (let run = 0; run < 400; run++) {
    const van: AggVanLot[] = [];
    const inv: AggInvLot[] = [];
    const exact = new Map<string, { raw: number; held: number }>(LOTS.map((id) => [id, { raw: 0, held: 0 }]));
    for (let i = 0; i < 30; i++) {
      const id = r.pick(LOTS);
      const q = Math.round(r.next() * 50 * 1e4) / 1e4;
      const e = exact.get(id)!;
      if (r.bool(0.5)) { van.push({ productId: 'P', lotId: id, vanKey: 'V', moveType: r.pick(['LOAD', 'UNLOAD'] as const), viaWarehouse: false, qty: q, firstInAt: null }); e.raw += van[van.length - 1].moveType === 'LOAD' ? q : -q; }
      else {
        const held = r.bool(0.3);
        const ret = held || r.bool(0.4);
        inv.push({ productId: 'P', lotId: id, vanKey: 'V', route: ret ? RESTOCK : CASH, held, qty: q });
        e.raw += ret ? q : -q;
        if (held) e.held += q;
      }
    }
    const f = foldVanLots(van, inv, [], 'V');
    const named = f.named.get('P') ?? new Map<string, LotRaw>();
    for (const [id, x] of named) {
      const e = exact.get(id)!;
      assert.equal(x.raw.SELLABLE, roundLot(e.raw), 'خام الطيّ مقرَّب كما كان');
      assert.equal(x.held.SELLABLE, roundLot(e.held), 'محجوز الطيّ مقرَّب كما كان');
    }
    const v = buildPlaceView({ productId: 'P', place: 'VAN', vanKey: 'V', total: null, named, heldUnknown: zeroBuckets(), metas: METAS });
    for (const l of v.lots) {
      const e = exact.get(l.lotId)!;
      assert.equal(l.raw.SELLABLE, roundLot(e.raw));
      assert.equal(l.held.SELLABLE, roundLot(e.held));
      assert.equal(l.usable.SELLABLE, roundLot(roundLot(e.raw) - roundLot(e.held)), `run ${run} ${l.lotId}: الصالح كما كان`);
    }
  }
});

test('gate 0 الكراتين: كاتبٌ آخر بكسرٍ أدقّ — الإعادة بكرتون، والمسار الحيّ بمعامل وحدةٍ أدقّ من أربع خانات — لا يجعل لوطاً مسمّى سالباً', () => {
  // الإعادة بكرتون F=12: الكرتون كاملاً من L1، والغبار 0.00005 لا يُكتب على L2 (namedOnGrid) — ثم بيع معروض L2 صريحاً
  const a = new Van();
  a.move('L1', 'LOAD', 12);
  a.move('L2', 'LOAD', 12);
  const rep = a.sale(12.00005, { replay: true, unitFactor: 12 });
  assert.ok(rep.ok, 'الإعادة لا تُرفض (R6)');
  for (const row of rep.rows) if (row.lotId != null) assert.equal(roundLot(row.qty), row.qty, `صفّ ${row.lotId} = ${row.qty} بأربع خانات`);
  assert.ok(Math.abs(rep.rows.reduce((s, x) => s + x.qty, 0) - 12.00005) <= 1e-12, 'Σ = الكمية (I3)');
  a.assertI1('بعد إعادة الكرتون');
  const shownL2 = a.view().lots.find((l) => l.lotId === 'L2')!.usable.SELLABLE;
  a.sale(shownL2, { explicit: [{ lotId: 'L2', qty: shownL2 }] });
  a.assertI1(`بعد بيع معروض L2 ${shownL2}`);

  // المسار الحيّ بمعامل 1.33333: ٣٠ كرتوناً = 39.9999 بأربع خانات، لكن قاعدة الكرتون تأخذ ١٥ كرتوناً = 19.99995 من كل لوط —
  // كسرٌ أدقّ على لوطٍ مسمّى من غير الإعادة. الحارس (أرضية الصالح) وحده يمنع صرف ما لا يوجد بعده
  const b = new Van();
  b.move('L1', 'LOAD', 20);
  b.move('L2', 'LOAD', 30);
  const live = b.sale(39.9999, { unitFactor: 1.33333 });
  assert.ok(live.ok);
  assert.ok(live.rows.some((x) => x.lotId != null && roundLot(x.qty) !== x.qty), 'المسار الحيّ كتب صفّاً مسمّى بكسرٍ أدقّ (قاعدة الكرتون)');
  b.assertI1('بعد البيع الحيّ بالكرتون');
  const l2 = b.view().lots.find((l) => l.lotId === 'L2')!;
  assert.equal(l2.raw.SELLABLE, 10.0001, 'الخام الفعلي 10.00005 يُعرض نصف لأعلى');
  assert.equal(l2.usable.SELLABLE, 10, 'والصالح الحارس أرضيته');
  assert.equal(b.sale(10.0001).ok, false, 'بيع الخام المعروض 10.0001 من فعلي 10.00005 يُرفض');
  assert.equal(b.unload(10.0001, [{ lotId: 'L2', qty: 10.0001 }]).ok, false, 'وتنزيله صريحاً كذلك');
  b.assertI1('بعد محاولة بيع الخام المعروض');
  assert.ok(b.sale(10).ok);
  b.assertI1('بعد بيع الصالح');
});
