// «تتبّع اللوط» (P0) — الطيّ والعروض بلا قاعدة (المواصفة §٨.١ lots-fold، J2).
// القاعدة الحاكمة: أثر كل صفّ لوط على دلاء السيارة هو توجيه foldStock حرفياً (vanStock.ts:129-145)، والتجميع في SQL يُغذّى إلى
// foldStock نفسها فلا مرآة تنحرف، وغير المسمّى = رصيد الصنف − Σ الخام بلا تطبيع (يجوز سالباً ولا يُقتطع من لوط).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldStock, bucketRemaining, type LoadRow, type InvRow } from '../routes/vanStock';
import { composeWarehouse } from '../services/warehouseStock';
import { roundDecimal } from '../utils/helpers';
import { DAMAGED_VAN_SINCE, isDamagedVanReturn } from '../services/vanDamaged';
import { baseQtyOf } from '../services/units';
import {
  LOT_BUCKETS, VAN_MOVE_TYPES, buildPlaceView, foldVanLots, foldWarehouseLots, heldUnknownOf, invEffect, lotBaseQty, roundLot, vanMoveEffect, zeroBuckets,
  type AggInvLot, type AggRelabel, type AggVanLot, type BucketQty, type LotMeta, type LotRaw,
} from '../services/lots';
import { vanHeldFromAgg, vanTotalsFromAgg, warehouseOnHandAgg, type AggVanTotalInv, type AggVanTotalLoad, type WhTotalAgg } from '../services/lotsDb';

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
    qty: () => Math.round(next() * 40 * 1000) / 1000, // ثلاث خانات كأرصدة حقيقية
    bool: (p = 0.5) => next() < p,
  };
}

const AFTER = new Date(DAMAGED_VAN_SINCE.getTime() + 86_400_000);
const BEFORE = new Date(DAMAGED_VAN_SINCE.getTime() - 86_400_000);
const PIDS = ['p1', 'p2', 'p3'];

/**
 * لقطة وحدةٍ عشوائية لصفّ بند (الوحدات المتعددة، D19): صفٌّ سبق الميزة بلا لقطة، أو كرتونٌ بمعامله والعمود المخزَّن حاضرٌ
 * أو فارغٌ لم يملأه الترحيل — فيُطوى بالأساس (baseQtyOf) لا بـqty الخام.
 */
function withUnit<T extends { qty: number }>(r: ReturnType<typeof rng>, row: T): T & { unitFactor?: number; baseQty?: number | null } {
  if (r.bool(0.4)) return row;
  const unitFactor = r.pick([1, 6, 24]);
  return { ...row, unitFactor, baseQty: r.bool(0.5) ? null : row.qty * unitFactor };
}
/** مرآة BASE_QTY_SQL للمجاميع: COALESCE("baseQty", qty * COALESCE(NULLIF("unitFactor", 0), 1)) — بلا تقريبٍ لكل صفّ كـSUM */
const sqlBase = (x: { qty: number; unitFactor?: number | null; baseQty?: number | null }): number =>
  x.baseQty ?? x.qty * (x.unitFactor == null || x.unitFactor === 0 ? 1 : x.unitFactor);

function randomLoad(r: ReturnType<typeof rng>): LoadRow {
  const type = r.pick([...VAN_MOVE_TYPES, 'WEIRD']); // نوعٌ مجهول يقع في adjusted كما في foldStock
  const q = r.qty();
  return withUnit(r, { productId: r.pick(PIDS), qty: type === 'ADJUST' || type === 'LOAD' ? (r.bool(0.3) ? -q : q) : q, vanLoad: { type, createdAt: AFTER } });
}

function randomInv(r: ReturnType<typeof rng>): InvRow {
  const type = r.pick(['CASH', 'CREDIT', 'RETURN', 'RETURN', 'RETURN']);
  return withUnit(r, {
    productId: r.bool(0.05) ? null : r.pick(PIDS), qty: r.qty(),
    returnExpired: r.pick([true, false, null, undefined]),
    invoice: {
      type, returnToStock: r.pick([true, false, null]), invoiceDate: AFTER,
      returnReason: r.pick(['DAMAGED', 'NORMAL', null]), createdAt: r.pick([AFTER, BEFORE, DAMAGED_VAN_SINCE, null]),
    },
  });
}

test('invEffect وvanMoveEffect = توجيه foldStock حرفياً على مدخلات عشوائية (والكمية بالأساس: lotBaseQty = baseQtyOf)', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const loads = Array.from({ length: r.int(0, 25) }, () => randomLoad(r));
    const invs = Array.from({ length: r.int(0, 25) }, () => randomInv(r));
    const { bal } = foldStock(loads, invs);
    const viaEffects = new Map<string, BucketQty>();
    const acc = (pid: string) => { let b = viaEffects.get(pid); if (!b) { b = zeroBuckets(); viaEffects.set(pid, b); } return b; };
    for (const l of loads) {
      const e = vanMoveEffect(l.vanLoad.type as never);
      acc(l.productId)[e.bucket] += e.sign * lotBaseQty(l);
    }
    for (const i of invs) {
      if (!i.productId) continue;
      const e = invEffect({ type: i.invoice.type, returnToStock: i.invoice.returnToStock, returnExpired: i.returnExpired ?? null, damaged: isDamagedVanReturn(i.invoice) });
      if (e) acc(i.productId)[e.bucket] += e.sign * lotBaseQty(i);
    }
    for (const pid of PIDS) {
      const b = bal.get(pid);
      const v = viaEffects.get(pid) ?? zeroBuckets();
      const want = b
        ? { SELLABLE: bucketRemaining(b), EXPIRED: roundDecimal(b.expiredIn - b.expiredOut, 4), DAMAGED: roundDecimal(b.damagedIn - b.damagedOut, 4) }
        : zeroBuckets();
      for (const k of LOT_BUCKETS) assert.equal(roundLot(v[k]) + 0, want[k] + 0, `seed ${seed} ${pid} ${k}`);
    }
  }
});

test('مساواة التجميع: foldStock على صفوف مفردة (بلقطات وحداتها) = foldStock على مجاميعها بـBASE_QTY_SQL ومفاتيح التوجيه (vanTotalsFromAgg)', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(1000 + seed);
    const vans = ['r1', 'r2'];
    const loads = Array.from({ length: r.int(0, 30) }, () => ({ ...randomLoad(r), van: r.pick(vans) }));
    const invs = Array.from({ length: r.int(0, 30) }, () => ({ ...randomInv(r), van: r.pick(vans) })).filter((i) => i.productId);
    // التجميع كما يفعله SQL: SUM(BASE_QTY_SQL) بـ(صنف، سيارة، نوع) للحركات، و(صنف، سيارة، نوع، returnToStock، returnExpired، damaged) للفواتير
    const lAgg = new Map<string, AggVanTotalLoad>();
    for (const l of loads) {
      const k = [l.productId, l.van, l.vanLoad.type].join('|');
      const g = lAgg.get(k) ?? { productId: l.productId, vanKey: l.van, type: l.vanLoad.type, qty: 0 };
      g.qty += sqlBase(l); lAgg.set(k, g);
    }
    const iAgg = new Map<string, AggVanTotalInv>();
    for (const i of invs) {
      const damaged = isDamagedVanReturn(i.invoice);
      const re = i.returnExpired ?? null;
      const k = [i.productId, i.van, i.invoice.type, String(i.invoice.returnToStock), String(re), String(damaged)].join('|');
      const g = iAgg.get(k) ?? { productId: i.productId!, vanKey: i.van, type: i.invoice.type, returnToStock: i.invoice.returnToStock, returnExpired: re, damaged, qty: 0 };
      g.qty += sqlBase(i); iAgg.set(k, g);
    }
    const fromAgg = vanTotalsFromAgg([...lAgg.values()], [...iAgg.values()], { foldStock, bucketRemaining });
    for (const van of vans) {
      const { bal } = foldStock(loads.filter((l) => l.van === van), invs.filter((i) => i.van === van));
      for (const pid of PIDS) {
        const b = bal.get(pid);
        const want = b ? { SELLABLE: bucketRemaining(b), EXPIRED: roundDecimal(b.expiredIn - b.expiredOut, 4), DAMAGED: roundDecimal(b.damagedIn - b.damagedOut, 4) } : null;
        const got = fromAgg.get(van)?.get(pid) ?? null;
        if (!want) { assert.equal(got, null, `seed ${seed} ${van} ${pid}`); continue; }
        assert.ok(got, `seed ${seed} ${van} ${pid}: مفقود من المجاميع`);
        for (const k of LOT_BUCKETS) assert.equal(got[k] + 0, want[k] + 0, `seed ${seed} ${van} ${pid} ${k}`);
      }
    }
  }
});

test('المحجوز الكلي (D24): vanHeldFromAgg = foldStock على بنود المستندات المحجوزة وحدها، والحجز مفتاحٌ لا يغيّر رصيد الصنف', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(3000 + seed);
    const invs = Array.from({ length: r.int(0, 30) }, () => ({ ...randomInv(r), held: r.bool(0.4) })).filter((i) => i.productId);
    const iAgg = new Map<string, AggVanTotalInv>();
    for (const i of invs) {
      const damaged = isDamagedVanReturn(i.invoice);
      const re = i.returnExpired ?? null;
      const k = [i.productId, i.invoice.type, String(i.invoice.returnToStock), String(re), String(damaged), String(i.held)].join('|');
      const g = iAgg.get(k) ?? { productId: i.productId!, vanKey: 'r', type: i.invoice.type, returnToStock: i.invoice.returnToStock, returnExpired: re, damaged, held: i.held, qty: 0 };
      g.qty += sqlBase(i); iAgg.set(k, g);
    }
    const held = vanHeldFromAgg([...iAgg.values()], { foldStock, bucketRemaining }).get('r');
    const all = vanTotalsFromAgg([], [...iAgg.values()], { foldStock, bucketRemaining }).get('r');
    const { bal } = foldStock([], invs.filter((i) => i.held));
    const { bal: balAll } = foldStock([], invs);
    for (const pid of PIDS) {
      const b = bal.get(pid), ba = balAll.get(pid);
      for (const k of LOT_BUCKETS) {
        const want = b ? { SELLABLE: bucketRemaining(b), EXPIRED: roundDecimal(b.expiredIn - b.expiredOut, 4), DAMAGED: roundDecimal(b.damagedIn - b.damagedOut, 4) }[k] : 0;
        assert.equal((held?.get(pid)?.[k] ?? 0) + 0, want + 0, `seed ${seed} held ${pid} ${k}`);
        const wantAll = ba ? { SELLABLE: bucketRemaining(ba), EXPIRED: roundDecimal(ba.expiredIn - ba.expiredOut, 4), DAMAGED: roundDecimal(ba.damagedIn - ba.damagedOut, 4) }[k] : 0;
        assert.equal((all?.get(pid)?.[k] ?? 0) + 0, wantAll + 0, `seed ${seed} all ${pid} ${k}`);
      }
    }
  }
});

test('heldUnknownOf (D24): المحجوز الكلي − Σ محجوز المسمّى، مقرَّباً — فالمحجوز قبل الحقبة أو بلا صفوف محجوزٌ في غير المسمّى', () => {
  const named = new Map<string, LotRaw>([
    ['A', { raw: { SELLABLE: 4, EXPIRED: 1, DAMAGED: 0 }, held: { SELLABLE: 2, EXPIRED: 1, DAMAGED: 0 } }],
    ['B', { raw: { SELLABLE: 1, EXPIRED: 0, DAMAGED: 0.3 }, held: { SELLABLE: 0.1, EXPIRED: 0, DAMAGED: 0.2 } }],
  ]);
  assert.deepEqual(heldUnknownOf({ SELLABLE: 7.1, EXPIRED: 1, DAMAGED: 0.3 }, named), { SELLABLE: 5, EXPIRED: 0, DAMAGED: 0.1 });
  assert.deepEqual(heldUnknownOf(zeroBuckets(), new Map()), zeroBuckets());
  // عرضٌ بمرتجعٍ محجوز قبل الحقبة (5) ولوطٍ مسمّى بلا حجز (10): غير المسمّى 5 كله محجوز
  const v = buildPlaceView({
    productId: 'p', place: 'VAN', vanKey: 'r', total: { SELLABLE: 15, EXPIRED: 0, DAMAGED: 0 },
    named: new Map([['A', { raw: { SELLABLE: 10, EXPIRED: 0, DAMAGED: 0 }, held: zeroBuckets() }]]),
    heldUnknown: heldUnknownOf({ SELLABLE: 5, EXPIRED: 0, DAMAGED: 0 }, new Map([['A', { raw: { SELLABLE: 10, EXPIRED: 0, DAMAGED: 0 }, held: zeroBuckets() }]])),
    metas: new Map(),
  });
  assert.deepEqual([v.unknown!.SELLABLE, v.unknownUsable!.SELLABLE], [5, 0]);
});

test('roundLot = roundDecimal(…, 4) — مدخلات عشوائية وحدود نصف الخانة والسالب', () => {
  const r = rng(7);
  const samples = [0, -0, 0.00005, -0.00005, 1.00005, 2.67835, -2.67835, 1e-7, -1e-7, 123456.78905, 0.1 + 0.2, 3 * 0.1 - 0.3, NaN, Infinity];
  for (let i = 0; i < 5000; i++) samples.push((r.next() - 0.5) * 10 ** r.int(-6, 7));
  for (let i = 0; i < 2000; i++) samples.push(Math.round((r.next() - 0.5) * 2e8) / 1e4 + 0.00005);
  for (const x of samples) assert.ok(Object.is(roundLot(x), roundDecimal(x, 4)), `roundLot(${x})`);
});

test('J2: غبار العائمة لا يصنع رصيداً — 0.1 ثلاث مرات ناقص 0.3 = صفر في الطيّ', () => {
  const van: AggVanLot[] = [0.1, 0.1, 0.1].map((q) => ({ productId: 'p', lotId: 'L', vanKey: 'r', moveType: 'LOAD', viaWarehouse: false, qty: q, firstInAt: null }));
  van.push({ productId: 'p', lotId: 'L', vanKey: 'r', moveType: 'UNLOAD', viaWarehouse: false, qty: 0.3, firstInAt: null });
  const { named } = foldVanLots(van, [], [], 'r');
  assert.equal(named.get('p')!.get('L')!.raw.SELLABLE, 0);
});

test('foldWarehouseLots: viaWarehouse وحده يمسّ المستودع، والفارغ يُتخطّى، والتسمية تنقل بين اللوطات', () => {
  const v = (o: Partial<AggVanLot>): AggVanLot => ({ productId: 'p', lotId: 'A', vanKey: 'r', moveType: 'LOAD', viaWarehouse: true, qty: 0, firstInAt: null, ...o });
  const rel = (o: Partial<AggRelabel>): AggRelabel => ({ productId: 'p', place: 'WAREHOUSE', vanKey: null, bucket: 'SELLABLE', fromLotId: null, toLotId: null, qty: 0, ...o });
  const out = foldWarehouseLots(
    [{ productId: 'p', lotId: 'A', qty: 100 }, { productId: 'p', lotId: null, qty: 50 }, { productId: 'p', lotId: 'B', qty: 10 }, { productId: 'q', lotId: 'C', qty: 7 }],
    [
      v({ moveType: 'LOAD', qty: 30 }),
      v({ moveType: 'UNLOAD', qty: 4 }),
      v({ moveType: 'LOAD', qty: 999, viaWarehouse: false }),      // شركة بلا مستودع (D4): لا يمسّه
      v({ moveType: 'ADJUST', qty: 999 }),                          // تسوية السيارة لا تمسّ المستودع
      v({ moveType: 'LOAD', lotId: null, qty: 5 }),                 // الفارغ يُتخطّى (D3)
    ],
    [
      rel({ fromLotId: null, toLotId: 'B', qty: 20 }),              // تسمية من غير المسمّى
      rel({ fromLotId: 'A', toLotId: 'B', qty: 6 }),                // إعادة تصنيف
      rel({ place: 'VAN', vanKey: 'r', fromLotId: 'A', toLotId: 'B', qty: 1000 }), // تسمية في سيارة لا تمسّ المستودع
    ],
  );
  assert.equal(out.get('p')!.get('A'), 100 - 30 + 4 - 6);
  assert.equal(out.get('p')!.get('B'), 10 + 20 + 6);
  assert.equal(out.get('q')!.get('C'), 7);
  assert.equal(out.get('p')!.has('∅'), false);
});

test('foldVanLots: الدلاء بالتوجيه، والمحجوز في دلوه، والفارغ المحجوز، وتصفية السيارة، وأول دخول', () => {
  const t1 = new Date('2026-11-01T08:00:00Z'), t2 = new Date('2026-11-02T08:00:00Z');
  const van: AggVanLot[] = [
    { productId: 'p', lotId: 'A', vanKey: 'r', moveType: 'LOAD', viaWarehouse: true, qty: 10, firstInAt: t2 },
    { productId: 'p', lotId: 'A', vanKey: 'r', moveType: 'ADJUST', viaWarehouse: false, qty: 2, firstInAt: t1 },
    { productId: 'p', lotId: 'A', vanKey: 'r', moveType: 'ADJUST', viaWarehouse: false, qty: -1, firstInAt: null },
    { productId: 'p', lotId: 'A', vanKey: 'r', moveType: 'UNLOAD', viaWarehouse: true, qty: 3, firstInAt: new Date('2020-01-01') }, // الخارج ليس دخولاً
    { productId: 'p', lotId: 'A', vanKey: 'r', moveType: 'EXPIRED_OUT', viaWarehouse: false, qty: 1, firstInAt: null },
    { productId: 'p', lotId: 'A', vanKey: 'other', moveType: 'LOAD', viaWarehouse: true, qty: 500, firstInAt: null },
    { productId: 'p', lotId: null, vanKey: 'r', moveType: 'LOAD', viaWarehouse: true, qty: 50, firstInAt: null },
  ];
  const route = (o: Partial<AggInvLot['route']>) => ({ type: 'RETURN', returnToStock: true, returnExpired: null, damaged: false, ...o });
  const inv: AggInvLot[] = [
    { productId: 'p', lotId: 'A', vanKey: 'r', route: route({ type: 'CASH' }), held: false, qty: 4 },
    { productId: 'p', lotId: 'A', vanKey: 'r', route: route({ returnExpired: true }), held: false, qty: 2 },
    { productId: 'p', lotId: 'A', vanKey: 'r', route: route({ damaged: true }), held: true, qty: 1.5 },
    { productId: 'p', lotId: 'A', vanKey: 'r', route: route({}), held: true, qty: 3 },
    { productId: 'p', lotId: 'A', vanKey: 'r', route: route({ returnToStock: false }), held: true, qty: 99 }, // لا أثر
    { productId: 'p', lotId: null, vanKey: 'r', route: route({}), held: true, qty: 7 },
    { productId: 'p', lotId: null, vanKey: null, route: route({}), held: true, qty: 70 },
  ];
  const rel: AggRelabel[] = [{ productId: 'p', place: 'VAN', vanKey: 'r', bucket: 'EXPIRED', fromLotId: 'A', toLotId: 'B', qty: 0.5 }];
  const { named, heldUnknown, firstInAt } = foldVanLots(van, inv, rel, 'r');
  const A = named.get('p')!.get('A')!;
  assert.deepEqual(A.raw, { SELLABLE: 10 + 2 - 1 - 3 - 4 + 3, EXPIRED: -1 + 2 - 0.5, DAMAGED: 1.5 });
  assert.deepEqual(A.held, { SELLABLE: 3, EXPIRED: 0, DAMAGED: 1.5 });
  assert.deepEqual(named.get('p')!.get('B')!.raw, { SELLABLE: 0, EXPIRED: 0.5, DAMAGED: 0 });
  assert.deepEqual(heldUnknown.get('p'), { SELLABLE: 7, EXPIRED: 0, DAMAGED: 0 });
  assert.equal(firstInAt.get('p')!.get('A')!.getTime(), t1.getTime(), 'أول دخول = أقدم تحميل أو تسوية بالزيادة');
  assert.equal(firstInAt.get('p')!.has('B'), false, 'التسمية في دلو المنتهي ليست دخولاً إلى المتاح');
});

test('foldVanLots: أول دخول من التسمية إلى لوطٍ في SELLABLE ومن المرتجع العائد للمخزون (طبقة الإعادة ١)', () => {
  const tRel = new Date('2026-11-01T06:00:00Z'), tRet = new Date('2026-11-01T07:00:00Z'), tLoad = new Date('2026-11-02T08:00:00Z');
  const route = (o: Partial<AggInvLot['route']>) => ({ type: 'RETURN', returnToStock: true, returnExpired: null, damaged: false, ...o });
  const { firstInAt } = foldVanLots(
    [{ productId: 'p', lotId: 'L', vanKey: 'r', moveType: 'LOAD', viaWarehouse: true, qty: 3, firstInAt: tLoad }],
    [
      { productId: 'p', lotId: 'R', vanKey: 'r', route: route({}), held: false, qty: 2, firstAt: tRet },
      { productId: 'p', lotId: 'S', vanKey: 'r', route: route({ type: 'CASH' }), held: false, qty: 2, firstAt: tRet },        // البيع خروج
      { productId: 'p', lotId: 'X', vanKey: 'r', route: route({ returnExpired: true }), held: false, qty: 2, firstAt: tRet }, // المنتهي ليس متاحاً
    ],
    [
      { productId: 'p', place: 'VAN', vanKey: 'r', bucket: 'SELLABLE', fromLotId: null, toLotId: 'L', qty: 50, firstAt: tRel },
      { productId: 'p', place: 'VAN', vanKey: 'other', bucket: 'SELLABLE', fromLotId: null, toLotId: 'Q', qty: 1, firstAt: tRel },
      { productId: 'p', place: 'WAREHOUSE', vanKey: null, bucket: 'SELLABLE', fromLotId: null, toLotId: 'W', qty: 1, firstAt: tRel },
    ],
    'r',
  );
  const m = firstInAt.get('p')!;
  assert.equal(m.get('L')!.getTime(), tRel.getTime(), 'المسمّى بالتسمية دخل قبل تحميله');
  assert.equal(m.get('R')!.getTime(), tRet.getTime());
  assert.deepEqual(['S', 'X', 'Q', 'W'].map((k) => m.has(k)), [false, false, false, false]);
});

const meta = (id: string, o: Partial<LotMeta> = {}): LotMeta => ({
  id, productId: 'p', lotNumber: id, productionDate: null, expiryDate: null, status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: new Date('2026-01-01'), ...o,
});
const raw = (s: number, e = 0, d = 0, hs = 0): LotRaw => ({ raw: { SELLABLE: s, EXPIRED: e, DAMAGED: d }, held: { SELLABLE: hs, EXPIRED: 0, DAMAGED: 0 } });

test('buildPlaceView: رصيدٌ سالب من التاريخ ⇒ غير المسمّى سالب ولا اقتطاع من المسمّى، وعجزٌ معروض', () => {
  const v = buildPlaceView({
    productId: 'p', place: 'VAN', vanKey: 'r', total: { SELLABLE: 3, EXPIRED: 0, DAMAGED: 0 },
    named: new Map([['A', raw(5, 0, 0, 2)], ['B', raw(1)]]), heldUnknown: zeroBuckets(),
    metas: new Map([['A', meta('A', { expiryDate: '2027-01-01' })], ['B', meta('B', { expiryDate: '2026-12-01' })]]),
  });
  assert.deepEqual(v.lots.map((l) => l.lotId), ['B', 'A'], 'بترتيب FEFO');
  assert.deepEqual(v.lots.find((l) => l.lotId === 'A')!.raw.SELLABLE, 5, 'المسمّى لا يُقتطع منه');
  assert.equal(v.lots.find((l) => l.lotId === 'A')!.usable.SELLABLE, 3, 'الصالح = الخام − المحجوز');
  assert.equal(v.unknown!.SELLABLE, 3 - 6);
  assert.equal(v.unknownUsable!.SELLABLE, -3);
  assert.deepEqual(v.deficits, [{ lotId: null, bucket: 'SELLABLE', qty: -3 }]);
  assert.equal(v.approximate, false);
});

test('buildPlaceView: المحجوز غير المسمّى خارج الصالح، والخام السالب عجز، والسيارة المحذوفة تقريبية', () => {
  const v = buildPlaceView({
    productId: 'p', place: 'VAN', vanKey: 'r', total: { SELLABLE: 10, EXPIRED: 2, DAMAGED: 0 },
    named: new Map([['A', raw(-1, 2)]]), heldUnknown: { SELLABLE: 4, EXPIRED: 0, DAMAGED: 0 }, metas: new Map(),
  });
  assert.equal(v.unknown!.SELLABLE, 11);
  assert.equal(v.unknownUsable!.SELLABLE, 7);
  assert.equal(v.unknown!.EXPIRED, 0);
  assert.deepEqual(v.deficits, [{ lotId: 'A', bucket: 'SELLABLE', qty: -1 }]);
  assert.equal(v.lots[0].meta.status, 'BLOCKED', 'لوطٌ بلا بطاقة يُعامل موقوفاً (فشلٌ مغلق)');
  const gone = buildPlaceView({ productId: 'p', place: 'VAN', vanKey: 'x', total: null, named: new Map([['A', raw(2)]]), heldUnknown: zeroBuckets(), metas: new Map() });
  assert.equal(gone.approximate, true);
  assert.equal(gone.unknown, null);
  assert.equal(gone.unknownUsable, null);
});

test('warehouseOnHandAgg = composeWarehouse.onHand على مدخلات عشوائية بلقطات وحداتها مجمَّعة بنوع الحركة وBASE_QTY_SQL', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(5000 + seed);
    const wh = Array.from({ length: r.int(0, 20) }, () => withUnit(r, { productId: r.pick(PIDS), qty: r.bool(0.3) ? -r.qty() : r.qty(), type: r.pick(['RECEIVE', 'ADJUST', 'OPENING']) }));
    const van = Array.from({ length: r.int(0, 20) }, () => withUnit(r, { productId: r.pick(PIDS), qty: r.qty(), type: r.pick(['LOAD', 'UNLOAD', 'ADJUST', 'EXPIRED_OUT']), salesRepId: r.pick(['a', 'b', null]) }));
    // composeWarehouse يأخذ الأساس من حدّ القراءة (loadWarehouseInputs: baseQtyOf) بلا المعامل بعده
    const rows = composeWarehouse(PIDS.map((id) => ({ id, name: id, code: id, unit: 'u' })),
      wh.map((w) => ({ productId: w.productId, qty: baseQtyOf(w), type: w.type })),
      van.map((v) => ({ productId: v.productId, qty: baseQtyOf(v), type: v.type, salesRepId: v.salesRepId })));
    const agg = new Map<string, WhTotalAgg>();
    for (const w of wh) { const k = `WH|${w.productId}|${w.type}`; const g = agg.get(k) ?? { productId: w.productId, source: 'WH', type: w.type, qty: 0 }; g.qty += sqlBase(w); agg.set(k, g); }
    for (const v of van) { const k = `VAN|${v.productId}|${v.type}`; const g = agg.get(k) ?? { productId: v.productId, source: 'VAN', type: v.type, qty: 0 }; g.qty += sqlBase(v); agg.set(k, g); }
    const got = warehouseOnHandAgg([...agg.values()]);
    for (const row of rows) assert.equal((got.get(row.productId) ?? 0) + 0, row.onHand + 0, `seed ${seed} ${row.productId}`);
  }
});
