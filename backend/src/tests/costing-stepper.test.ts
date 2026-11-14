// «ربط الدفاتر» L3 — محرّك التكلفة الوحيد (services/costing): الحساب الصحيح، المفاتيح، أمثلة العقد المحلولة أ–و حرفياً
// (scratchpad/l23_contract.md §5)، وقواعد كل نوع (§4.6)، والإعادة (الترتيب D2، الالتقاط، الاستئناف، الحتمية).
// خصائص الثوابت الستّة على 2,000 تسلسل عشوائي في c1-costing-property.test.ts، وجدول §8 في c1-costing-accounts.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QTY_U, fromQtyU, mulDivRound, qtyMulDiv, toQtyU, unitCostE4Of } from '../services/costing/math';
import {
  COST_KEY_PREFIX, parseCostKey, restockToggleKey, returnCancelKey, returnKey, saleCancelKey, saleOutKey, vanItemKey,
  whItemKey,
} from '../services/costing/keys';
import {
  applyMove, cloneCostState, compareLocations, compareMoves, createCostState, locStateKey, replay, snapshotLookupOf,
  snapshotRefOf, splitLocStateKey, stateTotals,
} from '../services/costing/stepper';
import { glImpactOf } from '../services/costing/accounts';
import { valueStock, type CostMove } from '../services/warehouseCost';
import { toMilli } from '../services/gl/money';
import type {
  CostState, LocationKey, Move, MoveKind, MoveLinks, SnapshotLookup, StepOutput, StepWarningCode,
} from '../services/costing/types';

// ═══ أدوات ═══

const T0 = Date.UTC(2026, 2, 1, 8, 0, 0);
const at = (n: number): Date => new Date(T0 + n * 60_000);

interface MvIn {
  n: number;
  kind: MoveKind;
  key: string;
  location: LocationKey;
  baseQty: number;
  productId?: string;
  toLocation?: LocationKey | null;
  inValueMilli?: bigint | null;
  memoQty?: number | null;
  links?: MoveLinks | null;
  reason?: string | null;
  effectAt?: Date;
  id?: string;
  createdAt?: Date;
}

function mv(i: MvIn): Move {
  const parsed = parseCostKey(i.key);
  assert.ok(parsed, `مفتاح غير صالح في الاختبار: ${i.key}`);
  const createdAt = i.createdAt ?? at(i.n);
  return {
    key: i.key,
    kind: i.kind,
    effectAt: i.effectAt ?? createdAt,
    cursor: { createdAt, id: i.id ?? `src${String(i.n).padStart(5, '0')}` },
    productId: i.productId ?? 'A',
    location: i.location,
    toLocation: i.toLocation ?? null,
    baseQty: i.baseQty,
    memoQty: i.memoQty ?? null,
    inValueMilli: i.inValueMilli ?? null,
    links: i.links ?? null,
    reason: i.reason ?? null,
    refType: parsed.refType,
    refId: `ref-${i.n}`,
    itemId: parsed.itemId,
  };
}

const CFG2 = { currencyDecimals: 2 };

/** طيٌّ خطوةً خطوة بـapplyMove (لا replay) — لفحص الحالة بعد كل حركة */
function stepAll(moves: readonly Move[], dec = 2): { outs: StepOutput[]; state: CostState; after: CostState[] } {
  const state = createCostState();
  const refs = new Map<string, StepOutput>();
  const lookup: SnapshotLookup = { get: (k) => refs.get(k) };
  const outs: StepOutput[] = [];
  const after: CostState[] = [];
  for (const m of moves) {
    const o = applyMove(state, m, { currencyDecimals: dec }, lookup);
    refs.set(o.key, o);
    outs.push(o);
    after.push(cloneCostState(state));
  }
  return { outs, state, after };
}

/** (كمية، مقيَّم، خارج التقييم، قيمة) لموقع صنف — بالأساس */
function locView(state: CostState, productId: string, location: LocationKey) {
  const s = state.locs.get(locStateKey(productId, location));
  return {
    qty: s ? fromQtyU(s.costedQtyU + s.uncostedQtyU) : 0,
    costed: s ? fromQtyU(s.costedQtyU) : 0,
    uncosted: s ? fromQtyU(s.uncostedQtyU) : 0,
    value: s ? s.valueMilli : 0n,
  };
}

interface Expect {
  kind: MoveKind;
  location: LocationKey;
  toLocation?: LocationKey | null;
  baseQty: number;
  uncostedQty?: number;
  valueMilli: bigint;
  varianceMilli?: bigint;
  memoMilli?: bigint;
  unitCostE4: bigint;
  warnings?: StepWarningCode[];
}

function snap(o: StepOutput, e: Expect, label: string): void {
  assert.deepEqual(
    {
      kind: o.kind, location: o.location, toLocation: o.toLocation, baseQty: o.baseQty, uncostedQty: o.uncostedQty,
      valueMilli: o.valueMilli, varianceMilli: o.varianceMilli, memoMilli: o.memoMilli, unitCostE4: o.unitCostE4,
      warnings: o.warnings,
    },
    {
      kind: e.kind, location: e.location, toLocation: e.toLocation ?? null, baseQty: e.baseQty, uncostedQty: e.uncostedQty ?? 0,
      valueMilli: e.valueMilli, varianceMilli: e.varianceMilli ?? 0n, memoMilli: e.memoMilli ?? 0n, unitCostE4: e.unitCostE4,
      warnings: e.warnings ?? [],
    },
    label,
  );
}

function assertLoc(state: CostState, productId: string, location: LocationKey, qty: number, value: bigint, label: string, uncosted = 0): void {
  const v = locView(state, productId, location);
  assert.equal(v.qty, qty, `${label}: كمية ${location}`);
  assert.equal(v.value, value, `${label}: قيمة ${location}`);
  assert.equal(v.uncosted, uncosted, `${label}: خارج التقييم ${location}`);
}

/** مجموع أثر الدفاتر صفرٌ دائماً */
function assertBalanced(o: StepOutput): void {
  const g = glImpactOf(o);
  const inv = g.inventory.reduce((s, l) => s + l.milli, 0n);
  assert.equal(inv + g.cogsMilli + g.writeOffMilli + g.counterMilli, 0n, `أثر غير متوازن: ${o.key}`);
}

function shuffled<T>(xs: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const R1: LocationKey = 'VAN:R1';
const R2: LocationKey = 'VAN:R2';

// ═══ math.ts ═══

test('toQtyU/fromQtyU: ميكرو صحيح، تقريب متناظر حول الصفر، بلا صفر سالب، ويرفض غير المنتهي وخارج المدى', () => {
  assert.equal(QTY_U, 1_000_000);
  assert.equal(toQtyU(1.5), 1_500_000);
  assert.equal(toQtyU(0.1 + 0.2), 300_000);
  assert.equal(toQtyU(1.234567), 1_234_567);
  assert.equal(toQtyU(2.5e-6), 3);
  assert.equal(toQtyU(-2.5e-6), -3, 'نصف السالب بعيداً عن الصفر لا نحو +∞');
  assert.equal(toQtyU(-1.5), -1_500_000);
  assert.ok(Object.is(toQtyU(-0), 0) && Object.is(toQtyU(-1e-9), 0), 'لا صفر سالب');
  for (const x of [1.25, 0.333333, 7, 1e-6, 123456.654321]) assert.equal(toQtyU(-x), -toQtyU(x));
  assert.throws(() => toQtyU(Number.NaN), RangeError);
  assert.throws(() => toQtyU(Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => toQtyU(1e10), RangeError, '10¹⁶ ميكرو يتجاوز 2⁵³');
  assert.equal(fromQtyU(1_234_567), 1.234567);
  assert.equal(fromQtyU(-333_333), -0.333333);
  assert.ok(Object.is(fromQtyU(0), 0));
  for (const x of [0.000001, 0.1, 2.75, 999999.999999, 42]) assert.equal(fromQtyU(toQtyU(x)), x, `ذهاب وإياب ${x}`);
});

test('mulDivRound: قسمة BigInt واحدة، نصف-لأعلى بعيداً عن الصفر، مضاعف للوحدة، أيّ إشارة', () => {
  assert.equal(mulDivRound(1000n, 1, 3, 10n), 330n, '333.3 ⇒ 330');
  assert.equal(mulDivRound(670n, 1, 2, 10n), 340n, '335 ⇒ 340 (نصف لأعلى)');
  assert.equal(mulDivRound(-670n, 1, 2, 10n), -340n, 'السالب بعيداً عن الصفر');
  assert.equal(mulDivRound(670n, -1, 2, 10n), -340n);
  assert.equal(mulDivRound(670n, 1, -2, 10n), -340n);
  assert.equal(mulDivRound(-670n, -1, -2, 10n), -340n);
  assert.equal(mulDivRound(-670n, -1, 2, 10n), 340n);
  assert.equal(mulDivRound(1000n, 1, 3, 1n), 333n);
  assert.equal(mulDivRound(1000n, 2, 3, 1n), 667n);
  assert.equal(mulDivRound(1500n, 1, 3, 1000n), 1000n, '500 ⇒ 1000 لعملة بلا كسور');
  assert.equal(mulDivRound(1499n, 1, 3, 1000n), 0n);
  assert.equal(mulDivRound(0n, 5, 7, 10n), 0n);
  assert.equal(mulDivRound(3_150_000n, 30_000_000, 150_000_000, 10n), 630_000n);
  // أعداد ضخمة بلا فقد: 10¹⁸ ملّي × 9·10¹⁵ ÷ 3·10¹⁵
  assert.equal(mulDivRound(10n ** 18n, 9e15, 3e15, 10n), 3n * 10n ** 18n);
  assert.throws(() => mulDivRound(1n, 1, 0, 10n), RangeError);
  assert.throws(() => mulDivRound(1n, 1.5, 2, 10n), RangeError);
  assert.throws(() => mulDivRound(1n, 1, 2, 0n), RangeError);
  assert.throws(() => mulDivRound(1n, 2 ** 53, 2, 10n), RangeError);
});

test('qtyMulDiv: نصف-لأعلى لميكرو كميات، وضرب BigInt بلا فقد فوق 2⁵³', () => {
  assert.equal(qtyMulDiv(1, 1, 2), 1);
  assert.equal(qtyMulDiv(1, 1, 3), 0);
  assert.equal(qtyMulDiv(2, 1, 3), 1);
  assert.equal(qtyMulDiv(4_000_000, 10_000_000, 20_000_000), 2_000_000);
  assert.equal(qtyMulDiv(9e15, 9e15, 9e15), 9e15);
  assert.equal(qtyMulDiv(0, 5, 7), 0);
  assert.throws(() => qtyMulDiv(-1, 1, 2), RangeError);
  assert.throws(() => qtyMulDiv(1, 1, 0), RangeError);
  assert.throws(() => qtyMulDiv(9e15, 9e15, 1), RangeError, 'الناتج خارج المدى الآمن');
});

test('unitCostE4Of: |G| × 10⁷ ÷ الكمية المقيَّمة بالميكرو، نصف-لأعلى، وصفر بلا كمية', () => {
  assert.equal(unitCostE4Of(2_000_000n, 100_000_000), 200_000n);
  assert.equal(unitCostE4Of(330n, 1_000_000), 3_300n);
  assert.equal(unitCostE4Of(-10_000n, 2_000_000), 50_000n);
  assert.equal(unitCostE4Of(1n, 3), 3_333_333n);
  assert.equal(unitCostE4Of(1n, 2_000_000_000_000), 0n, '0.000005 ⇒ 0');
  assert.equal(unitCostE4Of(5n, 1_000_000), 50n);
  assert.equal(unitCostE4Of(123n, 0), 0n);
});

// ═══ keys.ts ═══

test('keys: الأشكال الحرفية، والتحليل ذهاباً وإياباً، والشكل الغريب ⇒ null', () => {
  assert.equal(COST_KEY_PREFIX, 'COST');
  assert.equal(whItemKey('w1'), 'COST:WH_ENTRY:w1');
  assert.equal(vanItemKey('v1'), 'COST:VAN_LOAD:v1');
  assert.equal(saleOutKey('i1'), 'COST:INVOICE:i1:OUT');
  assert.equal(saleCancelKey('i1'), 'COST:INVOICE:i1:CANCEL');
  assert.equal(returnKey('i1'), 'COST:INVOICE:i1:RET');
  assert.equal(returnCancelKey('i1'), 'COST:INVOICE:i1:RETCANCEL');
  assert.equal(restockToggleKey('l1', 'i1'), 'COST:RESTOCK_LOG:l1:i1');
  assert.deepEqual(parseCostKey(whItemKey('w1')), { refType: 'WH_ENTRY', itemId: 'w1', leg: null, logId: null });
  assert.deepEqual(parseCostKey(vanItemKey('v1')), { refType: 'VAN_LOAD', itemId: 'v1', leg: null, logId: null });
  for (const [k, leg] of [[saleOutKey('i9'), 'OUT'], [saleCancelKey('i9'), 'CANCEL'], [returnKey('i9'), 'RET'], [returnCancelKey('i9'), 'RETCANCEL']] as const) {
    assert.deepEqual(parseCostKey(k), { refType: 'INVOICE', itemId: 'i9', leg, logId: null });
  }
  assert.deepEqual(parseCostKey(restockToggleKey('log7', 'i9')), { refType: 'RESTOCK_LOG', itemId: 'i9', leg: null, logId: 'log7' });
  const uuid = '3f2b8c1e-0d4a-4e8b-9a7c-1b2c3d4e5f60';
  assert.deepEqual(parseCostKey(saleOutKey(uuid)), { refType: 'INVOICE', itemId: uuid, leg: 'OUT', logId: null });
  for (const bad of ['', 'COST', 'COST:WH_ENTRY', 'COST:WH_ENTRY:', 'COST:WH_ENTRY:a:b', 'COST:INVOICE:x', 'COST:INVOICE:x:BAD',
    'COST:FOO:x', 'X:WH_ENTRY:a', 'COST:RESTOCK_LOG:l1', 'COST:RESTOCK_LOG:l1:i1:x', 'COST::a', 'cost:WH_ENTRY:a']) {
    assert.equal(parseCostKey(bad), null, `«${bad}»`);
  }
  const legs = new Set([saleOutKey('i'), saleCancelKey('i'), returnKey('i'), returnCancelKey('i'), restockToggleKey('i', 'i')]);
  assert.equal(legs.size, 5, 'أرجل البند الواحد مفاتيح مختلفة');
});

// ═══ أمثلة العقد المحلولة (§5) ═══

test('المثال أ — المسار الأساسي: وارد بسعرين، تحميل، بيع وإلغاؤه، مرتجع وتبديلان، تنزيل', () => {
  const saleEffect = new Date(Date.UTC(2026, 2, 10, 12));
  const moves = [
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('a1'), location: 'WH', baseQty: 100, inValueMilli: 2_000_000n }),
    mv({ n: 2, kind: 'RECEIVE', key: whItemKey('a2'), location: 'WH', baseQty: 50, inValueMilli: 1_150_000n }),
    mv({ n: 3, kind: 'VAN_LOAD', key: vanItemKey('a3'), location: 'WH', toLocation: R1, baseQty: -30 }),
    mv({ n: 4, kind: 'VAN_SALE', key: saleOutKey('a4'), location: R1, baseQty: -10, effectAt: saleEffect }),
    // الإلغاء مسجَّل قبل تاريخ الفاتورة المؤرّخة مستقبلاً ⇒ effectAt = تاريخ البيع (لا عكسٌ قبل أصله)
    mv({ n: 5, kind: 'SALE_CANCEL', key: saleCancelKey('a4'), location: R1, baseQty: 10, links: { mirrorOf: saleOutKey('a4'), locationOf: saleOutKey('a4') } }),
    mv({ n: 6, kind: 'VAN_SALE', key: saleOutKey('a6'), location: R1, baseQty: -12 }),
    mv({ n: 7, kind: 'VAN_RETURN_RESTOCK', key: returnKey('a7'), location: R1, baseQty: 2, links: { mirrorOf: saleOutKey('a6') } }),
    // الموقع الممرَّر خاطئ عمداً: locationOf (لقطة المرتجع) يغلبه
    mv({ n: 8, kind: 'RESTOCK_TOGGLE', key: restockToggleKey('l8', 'a7'), location: 'WH', baseQty: -2, links: { mirrorOf: null, locationOf: returnKey('a7') } }),
    mv({ n: 9, kind: 'RESTOCK_TOGGLE', key: restockToggleKey('l9', 'a7'), location: 'WH', baseQty: 2, links: { mirrorOf: saleOutKey('a6'), locationOf: returnKey('a7') } }),
    mv({ n: 10, kind: 'VAN_UNLOAD', key: vanItemKey('a10'), location: R1, toLocation: 'WH', baseQty: -20 }),
  ];
  const { outs, after, state } = stepAll(moves);
  const E4_21 = 210_000n;
  snap(outs[0], { kind: 'RECEIVE', location: 'WH', baseQty: 100, valueMilli: 2_000_000n, unitCostE4: 200_000n }, '#1');
  assertLoc(after[0], 'A', 'WH', 100, 2_000_000n, '#1');
  snap(outs[1], { kind: 'RECEIVE', location: 'WH', baseQty: 50, valueMilli: 1_150_000n, unitCostE4: 230_000n }, '#2');
  assertLoc(after[1], 'A', 'WH', 150, 3_150_000n, '#2 (متوسّط 21)');
  snap(outs[2], { kind: 'VAN_LOAD', location: 'WH', toLocation: R1, baseQty: -30, valueMilli: -630_000n, unitCostE4: E4_21 }, '#3');
  assert.deepEqual([outs[2].qtyAfter, outs[2].valueAfter, outs[2].toQtyAfter, outs[2].toValueAfter], [120, 2_520_000n, 30, 630_000n]);
  assertLoc(after[2], 'A', 'WH', 120, 2_520_000n, '#3');
  assertLoc(after[2], 'A', R1, 30, 630_000n, '#3');
  snap(outs[3], { kind: 'VAN_SALE', location: R1, baseQty: -10, valueMilli: -210_000n, unitCostE4: E4_21 }, '#4');
  assert.equal(glImpactOf(outs[3]).cogsMilli, 210_000n, '#4 تكلفة المبيعات 210');
  assertLoc(after[3], 'A', R1, 20, 420_000n, '#4');
  snap(outs[4], { kind: 'SALE_CANCEL', location: R1, baseQty: 10, valueMilli: 210_000n, unitCostE4: E4_21 }, '#5');
  assert.deepEqual(outs[4].effectAt, saleEffect, '#5 effectAt = max(الإلغاء، البيع)');
  assertLoc(after[4], 'A', R1, 30, 630_000n, '#5');
  snap(outs[5], { kind: 'VAN_SALE', location: R1, baseQty: -12, valueMilli: -252_000n, unitCostE4: E4_21 }, '#6');
  assertLoc(after[5], 'A', R1, 18, 378_000n, '#6');
  snap(outs[6], { kind: 'VAN_RETURN_RESTOCK', location: R1, baseQty: 2, valueMilli: 42_000n, unitCostE4: E4_21 }, '#7');
  assertLoc(after[6], 'A', R1, 20, 420_000n, '#7');
  snap(outs[7], { kind: 'RESTOCK_TOGGLE', location: R1, baseQty: -2, valueMilli: -42_000n, memoMilli: 42_000n, unitCostE4: E4_21 }, '#8');
  assert.deepEqual(glImpactOf(outs[7]), {
    inventory: [{ location: R1, milli: -42_000n }], cogsMilli: 0n, writeOffMilli: 42_000n, counterMilli: 0n, counterRole: 'NONE',
  }, '#8 مدين 514001 / دائن 114002');
  assertLoc(after[7], 'A', R1, 18, 378_000n, '#8');
  snap(outs[8], { kind: 'RESTOCK_TOGGLE', location: R1, baseQty: 2, valueMilli: 42_000n, memoMilli: -42_000n, unitCostE4: E4_21 }, '#9');
  assertLoc(after[8], 'A', R1, 20, 420_000n, '#9');
  snap(outs[9], { kind: 'VAN_UNLOAD', location: R1, toLocation: 'WH', baseQty: -20, valueMilli: -420_000n, unitCostE4: E4_21 }, '#10');
  assertLoc(after[9], 'A', R1, 0, 0n, '#10');
  assertLoc(after[9], 'A', 'WH', 140, 2_940_000n, '#10 (متوسّط 21)');
  assert.deepEqual(stateTotals(state), [{ location: 'WH', qtyBase: 140, uncostedQty: 0, valueMilli: 2_940_000n }]);
  for (const o of outs) assertBalanced(o);
  // replay بأي ترتيب للمدخلات = الطيّ خطوةً خطوة حرفياً
  assert.deepEqual(replay(shuffled(moves, 7), CFG2).outputs, outs);
  assert.equal(state.movesFolded, 10);
  assert.deepEqual(state.cursor, { createdAt: at(10), id: 'src00010' });
});

test('المثال ب — سدّ رصيد سالب بفرق: مكشوف سيارة بمتوسّط المستودع ثم تحميل يسدّه (variance = 4 × (9.5 − 8))', () => {
  const moves = [
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('b1'), productId: 'B', location: 'WH', baseQty: 10, inValueMilli: 80_000n }),
    mv({ n: 2, kind: 'VAN_SALE', key: saleOutKey('b2'), productId: 'B', location: R2, baseQty: -4 }),
    mv({ n: 3, kind: 'RECEIVE', key: whItemKey('b3'), productId: 'B', location: 'WH', baseQty: 10, inValueMilli: 110_000n }),
    mv({ n: 4, kind: 'VAN_LOAD', key: vanItemKey('b4'), productId: 'B', location: 'WH', toLocation: R2, baseQty: -10 }),
  ];
  const { outs, after } = stepAll(moves);
  snap(outs[0], { kind: 'RECEIVE', location: 'WH', baseQty: 10, valueMilli: 80_000n, unitCostE4: 80_000n }, '#1');
  snap(outs[1], {
    kind: 'VAN_SALE', location: R2, baseQty: -4, valueMilli: -32_000n, unitCostE4: 80_000n, warnings: ['NEGATIVE_STOCK', 'WH_RATE_FALLBACK'],
  }, '#2');
  assert.equal(outs[1].qtyAfter, -4);
  assertLoc(after[1], 'B', R2, -4, -32_000n, '#2');
  assertLoc(after[1], 'B', 'WH', 10, 80_000n, '#2 المستودع لا يتغيّر');
  snap(outs[2], { kind: 'RECEIVE', location: 'WH', baseQty: 10, valueMilli: 110_000n, unitCostE4: 110_000n }, '#3');
  assertLoc(after[2], 'B', 'WH', 20, 190_000n, '#3 (9.5)');
  snap(outs[3], {
    kind: 'VAN_LOAD', location: 'WH', toLocation: R2, baseQty: -10, valueMilli: -95_000n, varianceMilli: 6_000n,
    unitCostE4: 95_000n, warnings: ['HOLE_FILLED'],
  }, '#4');
  assertLoc(after[3], 'B', 'WH', 10, 95_000n, '#4');
  assertLoc(after[3], 'B', R2, 6, 57_000n, '#4');
  // القيد المستقبلي (L6): مدين 114002(R2) 95 / دائن 114001 95، ومدين 511001 6 / دائن 114002(R2) 6 ⇒ صافي السيارة +89
  assert.deepEqual(glImpactOf(outs[3]), {
    inventory: [{ location: 'WH', milli: -95_000n }, { location: R2, milli: 89_000n }],
    cogsMilli: 6_000n, writeOffMilli: 0n, counterMilli: 0n, counterRole: 'NONE',
  });
  for (const o of outs) assertBalanced(o);
});

test('المثال ج — التقريب بلا انجراف: 1,000 ملّي على ثلاث حبّات ⇒ 330 + 340 + 330 (سيارة ومستودع)', () => {
  const inValue = toMilli(3 * 0.3333, 2);
  assert.equal(inValue, 1_000n, 'toMilli(0.9999, 2)');
  // من المستودع مباشرةً (فاتورة إدارة)
  const wh = stepAll([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('c1'), productId: 'C', location: 'WH', baseQty: 3, inValueMilli: inValue }),
    ...[2, 3, 4].map((n) => mv({ n, kind: 'WAREHOUSE_SALE', key: saleOutKey(`cw${n}`), productId: 'C', location: 'WH', baseQty: -1 })),
  ]);
  assert.deepEqual(wh.outs.slice(1).map((o) => o.valueMilli), [-330n, -340n, -330n]);
  assert.deepEqual(wh.outs.slice(1).map((o) => o.unitCostE4), [3_300n, 3_400n, 3_300n]);
  assertLoc(wh.state, 'C', 'WH', 0, 0n, 'المستودع مستنزف');
  assert.equal(wh.outs.reduce((s, o) => s + o.valueMilli, 0n), 0n, 'Σ = 0 بالضبط');
  // من السيارة بعد تحميلها كلها
  const van = stepAll([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('c1'), productId: 'C', location: 'WH', baseQty: 3, inValueMilli: inValue }),
    mv({ n: 2, kind: 'VAN_LOAD', key: vanItemKey('c2'), productId: 'C', location: 'WH', toLocation: R1, baseQty: -3 }),
    ...[3, 4, 5].map((n) => mv({ n, kind: 'VAN_SALE', key: saleOutKey(`cv${n}`), productId: 'C', location: R1, baseQty: -1 })),
  ]);
  assert.deepEqual(van.outs.slice(2).map((o) => o.valueMilli), [-330n, -340n, -330n]);
  assertLoc(van.state, 'C', R1, 0, 0n, 'السيارة مستنزفة');
  assert.deepEqual(stateTotals(van.state), []);
});

test('المثال د — دلوان: التحميل يصرف المقيَّم وخارج التقييم بنسبتهما (كطبقة VAN_OUT القديمة)', () => {
  const { outs, state } = stepAll([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('d1'), productId: 'D', location: 'WH', baseQty: 10, inValueMilli: null }),
    mv({ n: 2, kind: 'RECEIVE', key: whItemKey('d2'), productId: 'D', location: 'WH', baseQty: 10, inValueMilli: 50_000n }),
    mv({ n: 3, kind: 'VAN_LOAD', key: vanItemKey('d3'), productId: 'D', location: 'WH', toLocation: R1, baseQty: -4 }),
  ]);
  snap(outs[0], { kind: 'RECEIVE', location: 'WH', baseQty: 10, uncostedQty: 10, valueMilli: 0n, unitCostE4: 0n }, '#1');
  snap(outs[2], {
    kind: 'VAN_LOAD', location: 'WH', toLocation: R1, baseQty: -4, uncostedQty: 2, valueMilli: -10_000n, unitCostE4: 50_000n,
    warnings: ['UNCOSTED_OUT'],
  }, '#3');
  const van = locView(state, 'D', R1);
  assert.deepEqual(van, { qty: 4, costed: 2, uncosted: 2, value: 10_000n }, 'السيارة 2 مقيَّم @ 10,000 + 2 خارج التقييم');
  assert.deepEqual(locView(state, 'D', 'WH'), { qty: 16, costed: 8, uncosted: 8, value: 40_000n });
  assert.deepEqual(stateTotals(state), [
    { location: 'WH', qtyBase: 16, uncostedQty: 8, valueMilli: 40_000n },
    { location: R1, qtyBase: 4, uncostedQty: 2, valueMilli: 10_000n },
  ]);
});

test('المثال هـ — شطب مرتجع تالف بمرآة البيع (514001/511001) ثم إلغاؤه يعكس المذكِّرة كاملة', () => {
  const { outs, state } = stepAll([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('e1'), productId: 'E', location: 'WH', baseQty: 10, inValueMilli: 210_000n }),
    mv({ n: 2, kind: 'VAN_LOAD', key: vanItemKey('e2'), productId: 'E', location: 'WH', toLocation: R1, baseQty: -10 }),
    mv({ n: 3, kind: 'VAN_SALE', key: saleOutKey('e3'), productId: 'E', location: R1, baseQty: -10 }),
    mv({ n: 4, kind: 'RETURN_WRITE_OFF', key: returnKey('e4'), productId: 'E', location: R1, baseQty: 0, memoQty: 3, reason: 'DAMAGED', links: { mirrorOf: saleOutKey('e3') } }),
    mv({ n: 5, kind: 'RETURN_CANCEL', key: returnCancelKey('e4'), productId: 'E', location: R1, baseQty: 0, links: { mirrorOf: null, memoOf: returnKey('e4'), locationOf: returnKey('e4') } }),
  ]);
  snap(outs[2], { kind: 'VAN_SALE', location: R1, baseQty: -10, valueMilli: -210_000n, unitCostE4: 210_000n }, 'البيع');
  snap(outs[3], { kind: 'RETURN_WRITE_OFF', location: R1, baseQty: 0, valueMilli: 0n, memoMilli: 63_000n, unitCostE4: 210_000n }, 'الشطب');
  assert.equal(outs[3].reason, 'DAMAGED');
  assert.equal(outs[3].qtyAfter, 0, 'كمية السيارة لا تتغيّر');
  assert.deepEqual(glImpactOf(outs[3]), { inventory: [], cogsMilli: -63_000n, writeOffMilli: 63_000n, counterMilli: 0n, counterRole: 'NONE' });
  snap(outs[4], { kind: 'RETURN_CANCEL', location: R1, baseQty: 0, valueMilli: 0n, memoMilli: -63_000n, unitCostE4: 0n }, 'إلغاء المرتجع');
  assert.deepEqual(glImpactOf(outs[4]), { inventory: [], cogsMilli: 63_000n, writeOffMilli: -63_000n, counterMilli: 0n, counterRole: 'NONE' });
  assertLoc(state, 'E', R1, 0, 0n, 'السيارة');
});

test('المثال و — مكشوف المستودع على مستودع فارغ بآخر متوسّط، والوارد يسدّ الحفرة بفرق (مطابق valueStock: 115)', () => {
  const VA: LocationKey = 'VAN:a';
  const base = (loads: Move[]) => [
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('f1'), productId: 'F', location: 'WH', baseQty: 10, inValueMilli: 50_000n }),
    ...loads,
    mv({ n: 4, kind: 'RECEIVE', key: whItemKey('f4'), productId: 'F', location: 'WH', baseQty: 20, inValueMilli: 120_000n }),
    mv({ n: 5, kind: 'VAN_UNLOAD', key: vanItemKey('f5'), productId: 'F', location: VA, toLocation: 'WH', baseQty: -5 }),
  ];
  const two = stepAll(base([
    mv({ n: 2, kind: 'VAN_LOAD', key: vanItemKey('f2'), productId: 'F', location: 'WH', toLocation: VA, baseQty: -10 }),
    mv({ n: 3, kind: 'VAN_LOAD', key: vanItemKey('f3'), productId: 'F', location: 'WH', toLocation: VA, baseQty: -5 }),
  ]));
  const o = two.outs;
  snap(o[1], { kind: 'VAN_LOAD', location: 'WH', toLocation: VA, baseQty: -10, valueMilli: -50_000n, unitCostE4: 50_000n }, 'تحميل 10');
  const wh1 = two.after[1].locs.get(locStateKey('F', 'WH'));
  assert.deepEqual(wh1, { costedQtyU: 0, uncostedQtyU: 0, valueMilli: 0n, lastAvg: { valueMilli: 50_000n, qtyU: 10_000_000 } }, 'المستودع فارغ بآخر متوسّط');
  snap(o[2], { kind: 'VAN_LOAD', location: 'WH', toLocation: VA, baseQty: -5, valueMilli: -25_000n, unitCostE4: 50_000n, warnings: ['NEGATIVE_STOCK'] }, 'تحميل 5 مكشوف');
  assertLoc(two.after[2], 'F', 'WH', -5, -25_000n, 'حفرة المستودع');
  assertLoc(two.after[2], 'F', VA, 15, 75_000n, 'السيارة');
  snap(o[3], { kind: 'RECEIVE', location: 'WH', baseQty: 20, valueMilli: 115_000n, varianceMilli: 5_000n, unitCostE4: 60_000n, warnings: ['HOLE_FILLED'] }, 'الوارد يسدّ');
  assertLoc(two.after[3], 'F', 'WH', 15, 90_000n, 'بعد السدّ');
  snap(o[4], { kind: 'VAN_UNLOAD', location: VA, toLocation: 'WH', baseQty: -5, valueMilli: -25_000n, unitCostE4: 50_000n }, 'التنزيل');
  assertLoc(two.state, 'F', 'WH', 20, 115_000n, 'المستودع 20 @ 115 (5.75)');
  assertLoc(two.state, 'F', VA, 10, 50_000n, 'السيارة');

  // الحمولة سنداً واحداً بـ15 تعطي الحالة نفسها (المتوسّط يُلتقط قبل الاستنزاف)
  const one = stepAll(base([
    mv({ n: 2, kind: 'VAN_LOAD', key: vanItemKey('f2'), productId: 'F', location: 'WH', toLocation: VA, baseQty: -15 }),
  ]));
  snap(one.outs[1], { kind: 'VAN_LOAD', location: 'WH', toLocation: VA, baseQty: -15, valueMilli: -75_000n, unitCostE4: 50_000n, warnings: ['NEGATIVE_STOCK'] }, 'حمولة 15');
  assert.deepEqual(one.state.locs, two.state.locs);

  // مطابق المحرّك القائم حرفياً (warehouse.test.ts:554)
  const legacy: CostMove[] = [
    { qty: 10, kind: 'RECEIVE', unitCost: 5 },
    { qty: -10, kind: 'VAN_OUT', vanId: 'a' },
    { qty: -5, kind: 'VAN_OUT', vanId: 'a' },
    { qty: 20, kind: 'RECEIVE', unitCost: 6 },
    { qty: 5, kind: 'VAN_IN', vanId: 'a' },
  ];
  const v = valueStock(legacy, 2);
  assert.equal(toMilli(v.stockValue, 2), locView(two.state, 'F', 'WH').value);
  assert.equal(v.costedQty + v.uncostedQty, locView(two.state, 'F', 'WH').qty);
});

// ═══ قواعد كل نوع (§4.6) ═══

test('RECEIVE: بلا سعر/صفري/سالب ⇒ خارج التقييم؛ وقيمة السطر تُقرَّب لأصغر وحدة عملة', () => {
  for (const [i, inValueMilli] of [null, 0n, -50n].entries()) {
    const { outs } = stepAll([mv({ n: 1, kind: 'RECEIVE', key: whItemKey(`u${i}`), location: 'WH', baseQty: 4, inValueMilli })]);
    snap(outs[0], { kind: 'RECEIVE', location: 'WH', baseQty: 4, uncostedQty: 4, valueMilli: 0n, unitCostE4: 0n }, `بلا سعر ${String(inValueMilli)}`);
  }
  const r = stepAll([mv({ n: 1, kind: 'RECEIVE', key: whItemKey('r'), location: 'WH', baseQty: 2, inValueMilli: 1_235n })]);
  assert.equal(r.outs[0].valueMilli, 1_240n, 'ريال: 1.235 ⇒ 1.24');
  const k = stepAll([mv({ n: 1, kind: 'RECEIVE', key: whItemKey('k'), location: 'WH', baseQty: 2, inValueMilli: 1_235n })], 3);
  assert.equal(k.outs[0].valueMilli, 1_235n, 'دينار بثلاث منازل: بلا تقريب');
  const j = stepAll([mv({ n: 1, kind: 'RECEIVE', key: whItemKey('j'), location: 'WH', baseQty: 2, inValueMilli: 1_499n })], 0);
  assert.equal(j.outs[0].valueMilli, 1_000n, 'عملة بلا كسور');
  // بيعٌ من مستودع خارج التقييم: كمية بلا قيمة وتحذير UNCOSTED_OUT
  const s = stepAll([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('s1'), location: 'WH', baseQty: 4, inValueMilli: null }),
    mv({ n: 2, kind: 'WAREHOUSE_SALE', key: saleOutKey('s2'), location: 'WH', baseQty: -3 }),
  ]);
  snap(s.outs[1], { kind: 'WAREHOUSE_SALE', location: 'WH', baseQty: -3, uncostedQty: 3, valueMilli: 0n, unitCostE4: 0n, warnings: ['UNCOSTED_OUT'] }, 'بيع خارج التقييم');
});

test('التسويات: الموجب بمتوسّط اللحظة (وإلا خارج التقييم)، والسالب بالمتوسّط؛ والسبب يمرّ للّقطة', () => {
  const { outs, state } = stepAll([
    mv({ n: 1, kind: 'WH_ADJUST', key: whItemKey('j1'), location: 'WH', baseQty: 5, reason: 'COUNT' }),
    mv({ n: 2, kind: 'RECEIVE', key: whItemKey('j2'), location: 'WH', baseQty: 5, inValueMilli: 60_000n }),
    mv({ n: 3, kind: 'WH_ADJUST', key: whItemKey('j3'), location: 'WH', baseQty: 2, reason: 'COUNT' }),
    mv({ n: 4, kind: 'WH_ADJUST', key: whItemKey('j4'), location: 'WH', baseQty: -4, reason: 'DAMAGE' }),
    mv({ n: 5, kind: 'ZERO_RUN', key: whItemKey('j5'), location: 'WH', baseQty: -8 }),
  ]);
  snap(outs[0], { kind: 'WH_ADJUST', location: 'WH', baseQty: 5, uncostedQty: 5, valueMilli: 0n, unitCostE4: 0n }, 'موجب بلا متوسّط');
  assert.equal(outs[0].reason, 'COUNT');
  // المتوسّط الحالي 60,000 ÷ 5 = 12 (لا يُحسب خارج التقييم)
  snap(outs[2], { kind: 'WH_ADJUST', location: 'WH', baseQty: 2, valueMilli: 24_000n, unitCostE4: 120_000n }, 'موجب بالمتوسّط');
  // المستودع 7 مقيَّم @ 84,000 + 5 خارج التقييم: صرف 4 بنسبة 7/12 بالميكرو ⇒ fc = 2.333333، قيمته 27,999.99 ⇒ 28,000
  snap(outs[3], { kind: 'WH_ADJUST', location: 'WH', baseQty: -4, uncostedQty: 1.666667, valueMilli: -28_000n, unitCostE4: 120_000n, warnings: ['UNCOSTED_OUT'] }, 'سالب');
  assert.equal(outs[3].reason, 'DAMAGE');
  // التصفير يستنزف الدلوين بقيمتهما كلها (4.666667 مقيَّم @ 56,000 + 3.333333)
  snap(outs[4], { kind: 'ZERO_RUN', location: 'WH', baseQty: -8, uncostedQty: 3.333333, valueMilli: -56_000n, unitCostE4: 120_000n, warnings: ['UNCOSTED_OUT'] }, 'تصفير');
  assert.equal(state.locs.has(locStateKey('A', 'WH')), true, 'يبقى آخر متوسّط');
  assertLoc(state, 'A', 'WH', 0, 0n, 'مصفَّر');
  // تسوية السيارة وتصفيرها
  const v = stepAll([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('v1'), location: 'WH', baseQty: 10, inValueMilli: 100_000n }),
    mv({ n: 2, kind: 'VAN_LOAD', key: vanItemKey('v2'), location: 'WH', toLocation: R1, baseQty: -4 }),
    mv({ n: 3, kind: 'VAN_ADJUST', key: vanItemKey('v3'), location: R1, baseQty: 1, reason: 'FOUND' }),
    mv({ n: 4, kind: 'ZERO_RUN', key: vanItemKey('v4'), location: R1, baseQty: -5 }),
  ]);
  snap(v.outs[2], { kind: 'VAN_ADJUST', location: R1, baseQty: 1, valueMilli: 10_000n, unitCostE4: 100_000n }, 'تسوية سيارة +');
  snap(v.outs[3], { kind: 'ZERO_RUN', location: R1, baseQty: -5, valueMilli: -50_000n, unitCostE4: 100_000n }, 'تصفير سيارة');
});

test('DAMAGE_OUT مذكِّرة بلا كمية ولا قيمة ولا حالة (ولو مُرِّرت كمية)', () => {
  const { outs, state } = stepAll([
    mv({ n: 1, kind: 'DAMAGE_OUT', key: vanItemKey('x1'), location: R1, baseQty: -2, reason: 'DAMAGED_OUT' }),
  ]);
  snap(outs[0], { kind: 'DAMAGE_OUT', location: R1, baseQty: 0, valueMilli: 0n, unitCostE4: 0n }, 'تالف');
  assert.equal(outs[0].reason, 'DAMAGED_OUT');
  assert.equal(state.locs.size, 0, 'لا تُنشأ حالة');
  assert.deepEqual(glImpactOf(outs[0]), { inventory: [], cogsMilli: 0n, writeOffMilli: 0n, counterMilli: 0n, counterRole: 'NONE' });
});

test('SALE_CANCEL بلا لقطة بيع ⇒ دخل بمتوسّط اللحظة + LINK_NOT_FOUND في الموقع الممرَّر', () => {
  const { outs } = stepAll([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('n1'), location: 'WH', baseQty: 10, inValueMilli: 70_000n }),
    mv({ n: 2, kind: 'SALE_CANCEL', key: saleCancelKey('gone'), location: 'WH', baseQty: 2, links: { mirrorOf: saleOutKey('gone'), locationOf: saleOutKey('gone') } }),
    mv({ n: 3, kind: 'SALE_CANCEL', key: saleCancelKey('gone2'), location: R1, baseQty: 2, links: { mirrorOf: saleOutKey('gone2'), locationOf: saleOutKey('gone2') } }),
  ]);
  snap(outs[1], { kind: 'SALE_CANCEL', location: 'WH', baseQty: 2, valueMilli: 14_000n, unitCostE4: 70_000n, warnings: ['LINK_NOT_FOUND'] }, 'بمتوسّط المستودع');
  // سيارة بلا متوسّط: خارج التقييم (لا بديل المستودع للإلغاء — §4.6)
  snap(outs[2], { kind: 'SALE_CANCEL', location: R1, baseQty: 2, uncostedQty: 2, valueMilli: 0n, unitCostE4: 0n, warnings: ['LINK_NOT_FOUND'] }, 'سيارة بلا متوسّط');
});

test('المرتجع العائد: مرآة البيع على موقع المرتجع؛ أكثر من المبيع بالنسبة نفسها؛ وجزء خارج التقييم يُعكس بنسبته', () => {
  const { outs } = stepAll([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('m1'), location: 'WH', baseQty: 10, inValueMilli: 210_000n }),
    mv({ n: 2, kind: 'WAREHOUSE_SALE', key: saleOutKey('m2'), location: 'WH', baseQty: -4 }),
    mv({ n: 3, kind: 'RECEIVE', key: whItemKey('m3'), location: 'WH', baseQty: 6, inValueMilli: 186_000n }),
    // مرتجع 6 لبيعٍ 4 @ 21 ⇒ 84,000 × 6/4 = 126,000 (لا بالمتوسّط الحالي 26)
    mv({ n: 4, kind: 'WAREHOUSE_RETURN_RESTOCK', key: returnKey('m4'), location: 'WH', baseQty: 6, links: { mirrorOf: saleOutKey('m2') } }),
  ]);
  snap(outs[3], { kind: 'WAREHOUSE_RETURN_RESTOCK', location: 'WH', baseQty: 6, valueMilli: 126_000n, unitCostE4: 210_000n }, 'مرتجع أكثر من المبيع');

  const d = stepAll([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('d1'), location: 'WH', baseQty: 10, inValueMilli: null }),
    mv({ n: 2, kind: 'RECEIVE', key: whItemKey('d2'), location: 'WH', baseQty: 10, inValueMilli: 50_000n }),
    mv({ n: 3, kind: 'WAREHOUSE_SALE', key: saleOutKey('d3'), location: 'WH', baseQty: -4 }),
    mv({ n: 4, kind: 'WAREHOUSE_RETURN_RESTOCK', key: returnKey('d4'), location: 'WH', baseQty: 2, links: { mirrorOf: saleOutKey('d3') } }),
  ]);
  snap(d.outs[2], { kind: 'WAREHOUSE_SALE', location: 'WH', baseQty: -4, uncostedQty: 2, valueMilli: -10_000n, unitCostE4: 50_000n, warnings: ['UNCOSTED_OUT'] }, 'بيع بدلوين');
  // Q_o 4، U_o 2 ⇒ cq = 2×2/4 = 1، cv = 10,000×2/4 = 5,000، uq = 1
  snap(d.outs[3], { kind: 'WAREHOUSE_RETURN_RESTOCK', location: 'WH', baseQty: 2, uncostedQty: 1, valueMilli: 5_000n, unitCostE4: 50_000n }, 'مرآة بدلوين');
});

test('المرتجع غير المرتبط: متوسّط موقعه، ولسيارة بلا متوسّط متوسّط المستودع، وإلا خارج التقييم — مع RETURN_UNLINKED', () => {
  const { outs } = stepAll([
    mv({ n: 1, kind: 'VAN_RETURN_RESTOCK', key: returnKey('q1'), location: R1, baseQty: 1, links: { mirrorOf: null } }),
    mv({ n: 2, kind: 'RECEIVE', key: whItemKey('q2'), location: 'WH', baseQty: 10, inValueMilli: 80_000n }),
    mv({ n: 3, kind: 'VAN_RETURN_RESTOCK', key: returnKey('q3'), location: R2, baseQty: 2 }),
    mv({ n: 4, kind: 'VAN_LOAD', key: vanItemKey('q4'), location: 'WH', toLocation: R2, baseQty: -2 }),
    mv({ n: 5, kind: 'VAN_RETURN_RESTOCK', key: returnKey('q5'), location: R2, baseQty: 1, links: { mirrorOf: saleOutKey('missing') } }),
  ]);
  snap(outs[0], { kind: 'VAN_RETURN_RESTOCK', location: R1, baseQty: 1, uncostedQty: 1, valueMilli: 0n, unitCostE4: 0n, warnings: ['RETURN_UNLINKED'] }, 'لا متوسّط أصلاً');
  snap(outs[2], { kind: 'VAN_RETURN_RESTOCK', location: R2, baseQty: 2, valueMilli: 16_000n, unitCostE4: 80_000n, warnings: ['RETURN_UNLINKED', 'WH_RATE_FALLBACK'] }, 'بمتوسّط المستودع');
  // السيارة الآن 4 @ 32,000 (8): صلة مكسورة ⇒ LINK_NOT_FOUND ومتوسّط السيارة نفسها
  snap(outs[4], { kind: 'VAN_RETURN_RESTOCK', location: R2, baseQty: 1, valueMilli: 8_000n, unitCostE4: 80_000n, warnings: ['LINK_NOT_FOUND'] }, 'صلة مكسورة');
});

test('صلاتٌ بلا mirrorOf صريح أو بصلةٍ موروثة: لا تُقرأ إلا الخصائص الذاتية النصّية، وغير النصّ يُهمل', () => {
  // كما قد يبنيها مصدرٌ لا يكتب mirrorOf: «بلا صلة» لا «صلة مكسورة»
  const bare = { locationOf: returnKey('g1') } as unknown as MoveLinks;
  // واسم الحقل لا يرثه أي كائن (كان «valueOf» في العقد فيُقرأ دالّةً موروثة)، وما يأتي من النموذج الأولي لا يُعدّ صلة
  assert.equal((bare as Record<string, unknown>).mirrorOf, undefined);
  const inherited = Object.create({ mirrorOf: saleOutKey('proto') }) as MoveLinks;
  const { outs } = stepAll([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('g0'), location: 'WH', baseQty: 4, inValueMilli: 40_000n }),
    mv({ n: 2, kind: 'WAREHOUSE_RETURN_RESTOCK', key: returnKey('g1'), location: 'WH', baseQty: 1, links: {} as unknown as MoveLinks }),
    mv({ n: 3, kind: 'RESTOCK_TOGGLE', key: restockToggleKey('L3', 'g1'), location: R1, baseQty: -1, links: bare }),
    mv({ n: 4, kind: 'RESTOCK_TOGGLE', key: restockToggleKey('L4', 'g1'), location: R1, baseQty: 1, links: bare }),
    mv({ n: 5, kind: 'WAREHOUSE_RETURN_RESTOCK', key: returnKey('g5'), location: 'WH', baseQty: 1, links: { mirrorOf: 42 as unknown as string } }),
    mv({ n: 6, kind: 'SALE_CANCEL', key: saleCancelKey('g6'), location: 'WH', baseQty: 1, links: { mirrorOf: '', locationOf: '' } }),
    mv({ n: 7, kind: 'WAREHOUSE_RETURN_RESTOCK', key: returnKey('g7'), location: 'WH', baseQty: 1, links: inherited }),
  ]);
  snap(outs[1], { kind: 'WAREHOUSE_RETURN_RESTOCK', location: 'WH', baseQty: 1, valueMilli: 10_000n, unitCostE4: 100_000n, warnings: ['RETURN_UNLINKED'] }, 'بلا صلة');
  snap(outs[2], { kind: 'RESTOCK_TOGGLE', location: 'WH', baseQty: -1, valueMilli: -10_000n, memoMilli: 10_000n, unitCostE4: 100_000n }, 'الموقع من RET');
  snap(outs[3], { kind: 'RESTOCK_TOGGLE', location: 'WH', baseQty: 1, valueMilli: 10_000n, memoMilli: -10_000n, unitCostE4: 100_000n, warnings: ['RETURN_UNLINKED'] }, 'إلى يعود بلا صلة');
  snap(outs[4], { kind: 'WAREHOUSE_RETURN_RESTOCK', location: 'WH', baseQty: 1, valueMilli: 10_000n, unitCostE4: 100_000n, warnings: ['RETURN_UNLINKED'] }, 'صلة غير نصّية');
  // الإلغاء بلا لقطة بيع (نصّ فارغ = لا صلة): بمتوسّط اللحظة مع LINK_NOT_FOUND كما في §4.6
  snap(outs[5], { kind: 'SALE_CANCEL', location: 'WH', baseQty: 1, valueMilli: 10_000n, unitCostE4: 100_000n, warnings: ['LINK_NOT_FOUND'] }, 'إلغاء بلا صلة');
  snap(outs[6], { kind: 'WAREHOUSE_RETURN_RESTOCK', location: 'WH', baseQty: 1, valueMilli: 10_000n, unitCostE4: 100_000n, warnings: ['RETURN_UNLINKED'] }, 'صلة موروثة = بلا صلة');
});

test('إلغاء المرتجع: العائد يخرج بالمتوسّط الحالي من موقع RET، والمشطوب بعد تبديل يعكس مذكِّرة التبديل، والغائب ⇒ LINK_NOT_FOUND', () => {
  const retEffect = new Date(Date.UTC(2026, 5, 1));
  const { outs, after } = stepAll([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('c1'), location: 'WH', baseQty: 10, inValueMilli: 100_000n }),
    mv({ n: 2, kind: 'VAN_LOAD', key: vanItemKey('c2'), location: 'WH', toLocation: R1, baseQty: -10 }),
    mv({ n: 3, kind: 'VAN_SALE', key: saleOutKey('c3'), location: R1, baseQty: -5 }),
    mv({ n: 4, kind: 'VAN_RETURN_RESTOCK', key: returnKey('c4'), location: R1, baseQty: 2, links: { mirrorOf: saleOutKey('c3') }, effectAt: retEffect }),
    mv({ n: 5, kind: 'RECEIVE', key: whItemKey('c5'), location: 'WH', baseQty: 10, inValueMilli: 160_000n }),
    mv({ n: 6, kind: 'VAN_LOAD', key: vanItemKey('c6'), location: 'WH', toLocation: R1, baseQty: -3 }),
    // الموقع الممرَّر WH خطأ، وlocationOf يعيده للسيارة؛ والمتوسّط الحالي (لا المرآة 10): السيارة 10 @ 118,000 ⇒ 2 = 23,600
    mv({ n: 7, kind: 'RETURN_CANCEL', key: returnCancelKey('c4'), location: 'WH', baseQty: -2, links: { mirrorOf: null, locationOf: returnKey('c4') } }),
  ]);
  assertLoc(after[5], 'A', R1, 10, 118_000n, 'قبل الإلغاء');
  snap(outs[6], { kind: 'RETURN_CANCEL', location: R1, baseQty: -2, valueMilli: -23_600n, unitCostE4: 118_000n }, 'إلغاء عائد');
  assert.deepEqual(outs[6].effectAt, retEffect, 'لا يسبق المرتجع المؤرّخ مستقبلاً');
  assertBalanced(outs[6]);

  // عائد ثم تبديل إلى «لا يعود» ثم إلغاء ⇒ memoOf = مفتاح التبديل
  const t = stepAll([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('t1'), location: 'WH', baseQty: 10, inValueMilli: 100_000n }),
    mv({ n: 2, kind: 'WAREHOUSE_SALE', key: saleOutKey('t2'), location: 'WH', baseQty: -4 }),
    mv({ n: 3, kind: 'WAREHOUSE_RETURN_RESTOCK', key: returnKey('t3'), location: 'WH', baseQty: 3, links: { mirrorOf: saleOutKey('t2') } }),
    mv({ n: 4, kind: 'RECEIVE', key: whItemKey('t4'), location: 'WH', baseQty: 11, inValueMilli: 132_000n }),
    mv({ n: 5, kind: 'RESTOCK_TOGGLE', key: restockToggleKey('L5', 't3'), location: 'WH', baseQty: -3, links: { mirrorOf: null, locationOf: returnKey('t3') } }),
    mv({ n: 6, kind: 'RETURN_CANCEL', key: returnCancelKey('t3'), location: 'WH', baseQty: 0, links: { mirrorOf: null, memoOf: restockToggleKey('L5', 't3'), locationOf: returnKey('t3') } }),
    mv({ n: 7, kind: 'RETURN_CANCEL', key: returnCancelKey('zz'), location: 'WH', baseQty: 0, links: { mirrorOf: null, memoOf: returnKey('zz') } }),
    mv({ n: 8, kind: 'RETURN_CANCEL', key: returnCancelKey('yy'), location: 'WH', baseQty: 0 }),
  ]);
  // المستودع 20 @ 222,000 (11.1) ⇒ التبديل يخرج 3 بـ33,300 ومذكِّرته +33,300 (لا 30,000 مرآة البيع)
  snap(t.outs[4], { kind: 'RESTOCK_TOGGLE', location: 'WH', baseQty: -3, valueMilli: -33_300n, memoMilli: 33_300n, unitCostE4: 111_000n }, 'تبديل إلى لا يعود');
  snap(t.outs[5], { kind: 'RETURN_CANCEL', location: 'WH', baseQty: 0, valueMilli: 0n, memoMilli: -33_300n, unitCostE4: 0n }, 'إلغاء المشطوب');
  snap(t.outs[6], { kind: 'RETURN_CANCEL', location: 'WH', baseQty: 0, valueMilli: 0n, memoMilli: 0n, unitCostE4: 0n, warnings: ['LINK_NOT_FOUND'] }, 'مرجع غائب');
  snap(t.outs[7], { kind: 'RETURN_CANCEL', location: 'WH', baseQty: 0, valueMilli: 0n, memoMilli: 0n, unitCostE4: 0n, warnings: ['LINK_NOT_FOUND'] }, 'بلا مرجع');
  for (const o of t.outs) assertBalanced(o);
});

test('RETURN_WRITE_OFF غير المرتبط يُقيَّم بالبديل نفسه للعائد (المذكِّرة = ما كان سيدخل)', () => {
  const { outs } = stepAll([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('w1'), location: 'WH', baseQty: 4, inValueMilli: 50_000n }),
    mv({ n: 2, kind: 'RETURN_WRITE_OFF', key: returnKey('w2'), location: R1, baseQty: 0, memoQty: 2, reason: 'EXPIRED' }),
    mv({ n: 3, kind: 'RETURN_WRITE_OFF', key: returnKey('w3'), location: 'WH', baseQty: 0, memoQty: 0.5, reason: 'NOT_RESTOCKED', links: { mirrorOf: saleOutKey('none') } }),
    mv({ n: 4, kind: 'RETURN_WRITE_OFF', key: returnKey('w4'), productId: 'Z', location: R1, baseQty: 0, memoQty: 1, reason: 'DAMAGED' }),
    mv({ n: 5, kind: 'RETURN_WRITE_OFF', key: returnKey('w5'), location: 'WH', baseQty: 0, memoQty: null }),
  ]);
  snap(outs[1], { kind: 'RETURN_WRITE_OFF', location: R1, baseQty: 0, valueMilli: 0n, memoMilli: 25_000n, unitCostE4: 125_000n, warnings: ['RETURN_UNLINKED', 'WH_RATE_FALLBACK'] }, 'بمتوسّط المستودع');
  snap(outs[2], { kind: 'RETURN_WRITE_OFF', location: 'WH', baseQty: 0, valueMilli: 0n, memoMilli: 6_250n, unitCostE4: 125_000n, warnings: ['LINK_NOT_FOUND'] }, 'صلة مكسورة');
  snap(outs[3], { kind: 'RETURN_WRITE_OFF', location: R1, baseQty: 0, valueMilli: 0n, memoMilli: 0n, unitCostE4: 0n, warnings: ['RETURN_UNLINKED'] }, 'لا متوسّط أصلاً');
  snap(outs[4], { kind: 'RETURN_WRITE_OFF', location: 'WH', baseQty: 0, valueMilli: 0n, memoMilli: 0n, unitCostE4: 0n }, 'بلا كمية مذكِّرة');
  assert.equal(outs[2].memoMilli % 10n, 0n, 'مضاعف للهللة: 6,250 ملّي = 6.25');
});

test('المكشوف: سيارة فارغة تنزّل بمتوسّط المستودع، وبلا أي متوسّط صفرٌ خارج التقييم، ثم السدّ يعترف بالتكلفة الحقيقية', () => {
  const u = stepAll([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('o1'), location: 'WH', baseQty: 10, inValueMilli: 80_000n }),
    mv({ n: 2, kind: 'VAN_UNLOAD', key: vanItemKey('o2'), location: 'VAN:R9', toLocation: 'WH', baseQty: -2 }),
  ]);
  snap(u.outs[1], { kind: 'VAN_UNLOAD', location: 'VAN:R9', toLocation: 'WH', baseQty: -2, valueMilli: -16_000n, unitCostE4: 80_000n, warnings: ['NEGATIVE_STOCK', 'WH_RATE_FALLBACK'] }, 'تنزيل مكشوف');
  assertLoc(u.state, 'A', 'WH', 12, 96_000n, 'المستودع');
  assertLoc(u.state, 'A', 'VAN:R9', -2, -16_000n, 'السيارة');

  const z = stepAll([
    mv({ n: 1, kind: 'VAN_SALE', key: saleOutKey('z1'), location: R1, baseQty: -3 }),
    mv({ n: 2, kind: 'RECEIVE', key: whItemKey('z2'), location: 'WH', baseQty: 10, inValueMilli: 40_000n }),
    mv({ n: 3, kind: 'VAN_LOAD', key: vanItemKey('z3'), location: 'WH', toLocation: R1, baseQty: -5 }),
  ]);
  snap(z.outs[0], { kind: 'VAN_SALE', location: R1, baseQty: -3, uncostedQty: 3, valueMilli: 0n, unitCostE4: 0n, warnings: ['NEGATIVE_STOCK', 'UNCOSTED_OUT', 'ZERO_RATE_DEFICIT'] }, 'مكشوف بلا متوسّط');
  assertLoc(z.after[0], 'A', R1, -3, 0n, 'حفرة بلا قيمة');
  // حفرة بلا قيمة يسدّها غير المقيَّم أولاً — لا يوجد — ثم المقيَّم: 20,000 × 3/5 = 12,000 فرقاً (تكلفة الثلاث المبيعة)
  snap(z.outs[2], { kind: 'VAN_LOAD', location: 'WH', toLocation: R1, baseQty: -5, valueMilli: -20_000n, varianceMilli: 12_000n, unitCostE4: 40_000n, warnings: ['HOLE_FILLED'] }, 'السدّ');
  assertLoc(z.state, 'A', R1, 2, 8_000n, 'السيارة بعد السدّ');
  for (const o of z.outs) assertBalanced(o);
});

test('حفرة مقيَّمة يسدّها دخلٌ بلا ثمن ⇒ فرق سالب (تُردّ تكلفة المبيعات) ولا يبقى رصيد صفري بقيمة', () => {
  const { outs, state } = stepAll([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('h1'), location: 'WH', baseQty: 10, inValueMilli: 80_000n }),
    mv({ n: 2, kind: 'VAN_SALE', key: saleOutKey('h2'), location: R2, baseQty: -4 }),
    mv({ n: 3, kind: 'VAN_ADJUST', key: vanItemKey('h3'), location: R2, baseQty: 6 }),
  ]);
  snap(outs[2], { kind: 'VAN_ADJUST', location: R2, baseQty: 6, uncostedQty: 6, valueMilli: 32_000n, varianceMilli: -32_000n, unitCostE4: 0n, warnings: ['HOLE_FILLED'] }, 'سدّ بلا ثمن');
  assert.deepEqual(locView(state, 'A', R2), { qty: 2, costed: 0, uncosted: 2, value: 0n });
  assert.deepEqual(glImpactOf(outs[2]), {
    inventory: [{ location: R2, milli: 32_000n }], cogsMilli: -32_000n, writeOffMilli: 0n, counterMilli: 0n, counterRole: 'ADJUSTMENT',
  });
});

test('سدّ جزئي بنسبة: حفرة 5 @ −50,000 يسدّ 2 منها دخلٌ مقيَّم ⇒ تبقى 3 @ −30,000', () => {
  const { outs, state } = stepAll([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('p1'), location: 'WH', baseQty: 5, inValueMilli: 50_000n }),
    mv({ n: 2, kind: 'VAN_LOAD', key: vanItemKey('p2'), location: 'WH', toLocation: R1, baseQty: -5 }),
    mv({ n: 3, kind: 'VAN_LOAD', key: vanItemKey('p3'), location: 'WH', toLocation: R1, baseQty: -5 }),
    mv({ n: 4, kind: 'RECEIVE', key: whItemKey('p4'), location: 'WH', baseQty: 2, inValueMilli: 26_000n }),
  ]);
  assertLoc(state, 'A', 'WH', -3, -30_000n, 'الحفرة الباقية');
  snap(outs[3], { kind: 'RECEIVE', location: 'WH', baseQty: 2, valueMilli: 20_000n, varianceMilli: 6_000n, unitCostE4: 130_000n, warnings: ['HOLE_FILLED'] }, 'سدّ جزئي');
});

test('آخر متوسّط لرصيد بلا قيمة لا يُعدّ متوسّطاً: المكشوف بعده ينتقل خارج التقييم (كالمحرّك القائم)', () => {
  const state = createCostState();
  state.locs.set(locStateKey('A', 'WH'), { costedQtyU: 5_000_000, uncostedQtyU: 0, valueMilli: 0n, lastAvg: null });
  const o = applyMove(state, mv({ n: 1, kind: 'VAN_LOAD', key: vanItemKey('g1'), location: 'WH', toLocation: R1, baseQty: -7 }), CFG2, { get: () => undefined });
  snap(o, { kind: 'VAN_LOAD', location: 'WH', toLocation: R1, baseQty: -7, uncostedQty: 2, valueMilli: 0n, unitCostE4: 0n, warnings: ['NEGATIVE_STOCK', 'UNCOSTED_OUT', 'ZERO_RATE_DEFICIT'] }, 'تحميل');
  assert.deepEqual(state.locs.get(locStateKey('A', 'WH')), { costedQtyU: -2_000_000, uncostedQtyU: 0, valueMilli: 0n, lastAvg: null });
  assert.deepEqual(locView(state, 'A', R1), { qty: 7, costed: 5, uncosted: 2, value: 0n });
});

test('أخطاء البرمجة ترمي (فشل مغلق): تحويل بلا هدف، نوع مجهول، كمية غير منتهية، منازل غير مدعومة', () => {
  const s = createCostState();
  const none: SnapshotLookup = { get: () => undefined };
  assert.throws(() => applyMove(s, mv({ n: 1, kind: 'VAN_LOAD', key: vanItemKey('e1'), location: 'WH', baseQty: -1 }), CFG2, none), /COSTING_TRANSFER_WITHOUT_TARGET/);
  assert.throws(() => applyMove(s, { ...mv({ n: 1, kind: 'RECEIVE', key: whItemKey('e2'), location: 'WH', baseQty: 1 }), kind: 'BOGUS' as MoveKind }, CFG2, none), /COSTING_UNKNOWN_KIND/);
  assert.throws(() => applyMove(s, mv({ n: 1, kind: 'RECEIVE', key: whItemKey('e3'), location: 'WH', baseQty: Number.NaN }), CFG2, none), RangeError);
  assert.throws(() => applyMove(s, mv({ n: 1, kind: 'RECEIVE', key: whItemKey('e4'), location: 'WH', baseQty: 1 }), { currencyDecimals: 4 }, none), RangeError);
  assert.throws(() => replay([], { currencyDecimals: 7 }), RangeError);
});

// ═══ الإعادة (D2) ═══

test('D2: الترتيب بلحظة التسجيل لا بالتاريخ المحاسبي — وأي تبديل للمدخلات يعطي الناتج نفسه', () => {
  const day = (d: number) => new Date(Date.UTC(2026, 2, d));
  const moves = [
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('o1'), location: 'WH', baseQty: 10, inValueMilli: 100_000n, effectAt: day(20) }),
    mv({ n: 2, kind: 'RECEIVE', key: whItemKey('o2'), location: 'WH', baseQty: 10, inValueMilli: 200_000n, effectAt: day(1) }),
    mv({ n: 3, kind: 'WAREHOUSE_SALE', key: saleOutKey('o3'), location: 'WH', baseQty: -10, effectAt: day(5) }),
  ];
  const r = replay(shuffled(moves, 3), CFG2);
  assert.deepEqual(r.outputs.map((o) => o.key), moves.map((m) => m.key));
  assert.equal(r.outputs[2].valueMilli, -150_000n, 'متوسّط لحظة التسجيل 15 (لا 10 ولا 20)');
  assert.deepEqual(r.outputs[2].effectAt, day(5), 'effectAt يُحمل كما هو');
  for (let s = 0; s < 20; s++) assert.deepEqual(replay(shuffled(moves, s), CFG2), r);
});

test('compareMoves: لحظة التسجيل ثم معرّف الصف (بوحدات الترميز) ثم المفتاح — بنود الصف الواحد بمفتاحها', () => {
  const t = at(1);
  const a = mv({ n: 1, kind: 'RECEIVE', key: whItemKey('x'), location: 'WH', baseQty: 1, createdAt: t, id: 'r2' });
  const b = mv({ n: 1, kind: 'WAREHOUSE_SALE', key: saleOutKey('i2'), location: 'WH', baseQty: -1, createdAt: t, id: 'r1' });
  const c = mv({ n: 1, kind: 'WAREHOUSE_SALE', key: saleOutKey('i1'), location: 'WH', baseQty: -1, createdAt: t, id: 'r1' });
  const d = mv({ n: 0, kind: 'RECEIVE', key: whItemKey('z'), location: 'WH', baseQty: 1, id: 'r9' });
  const e = mv({ n: 1, kind: 'RECEIVE', key: whItemKey('y'), location: 'WH', baseQty: 1, createdAt: t, id: 'R3' });
  assert.deepEqual([a, b, c, d, e].sort(compareMoves).map((m) => m.key), [d.key, e.key, c.key, b.key, a.key]);
  assert.equal(compareMoves(a, a), 0);
  // بيعٌ في صفٍّ أسبق بالمعرّف يُطوى قبل الوارد ذي اللحظة نفسها ⇒ مكشوف
  const r = replay([a, b], CFG2);
  assert.deepEqual(r.outputs[0].warnings, ['NEGATIVE_STOCK', 'UNCOSTED_OUT', 'ZERO_RATE_DEFICIT']);
});

test('replay: الالتقاط (cursor.createdAt < T) بنسخ مستقلة وبفهرس captureAt، ولا يعدّل حالة البدء، وonOutput بالترتيب', () => {
  const moves = [
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('k1'), location: 'WH', baseQty: 10, inValueMilli: 100_000n }),
    mv({ n: 2, kind: 'RECEIVE', key: whItemKey('k2'), location: 'WH', baseQty: 10, inValueMilli: 300_000n }),
    mv({ n: 3, kind: 'VAN_LOAD', key: vanItemKey('k3'), location: 'WH', toLocation: R1, baseQty: -4 }),
  ];
  const seen: string[] = [];
  const r = replay(moves, CFG2, { captureAt: [at(3), at(0), at(99), at(2)], onOutput: (o) => seen.push(o.key) });
  assert.deepEqual(seen, moves.map((m) => m.key));
  assert.equal(r.captured.length, 4);
  assert.deepEqual(stateTotals(r.captured[0]), [{ location: 'WH', qtyBase: 20, uncostedQty: 0, valueMilli: 400_000n }], 'قبل الحركة 3 (اللحظة نفسها مستبعدة)');
  assert.equal(r.captured[0].movesFolded, 2);
  assert.deepEqual(stateTotals(r.captured[1]), [], 'قبل كل شيء');
  assert.deepEqual(r.captured[2], r.state, 'بعد كل شيء');
  assert.notEqual(r.captured[2], r.state);
  assert.deepEqual(stateTotals(r.captured[3]), [{ location: 'WH', qtyBase: 10, uncostedQty: 0, valueMilli: 100_000n }]);
  // النسخ مستقلة عن الحالة النهائية
  r.state.locs.get(locStateKey('A', 'WH'))!.valueMilli = 1n;
  assert.equal(r.captured[2].locs.get(locStateKey('A', 'WH'))!.valueMilli, 320_000n);

  // حالة البدء لا تُعدَّل
  const start = replay(moves.slice(0, 2), CFG2).state;
  const frozen = cloneCostState(start);
  replay(moves.slice(2), CFG2, { state: start });
  assert.deepEqual(start, frozen);
});

test('replay: الاستئناف من نقطة حفظ (حالة + لقطات سابقة) = الإعادة الكاملة حرفياً، والصلات المحلية تغلب lookup', () => {
  const moves = [
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('s1'), location: 'WH', baseQty: 10, inValueMilli: 120_000n }),
    mv({ n: 2, kind: 'VAN_LOAD', key: vanItemKey('s2'), location: 'WH', toLocation: R1, baseQty: -6 }),
    mv({ n: 3, kind: 'VAN_SALE', key: saleOutKey('s3'), location: R1, baseQty: -4 }),
    mv({ n: 4, kind: 'RECEIVE', key: whItemKey('s4'), location: 'WH', baseQty: 10, inValueMilli: 150_000n }),
    mv({ n: 5, kind: 'VAN_LOAD', key: vanItemKey('s5'), location: 'WH', toLocation: R1, baseQty: -5 }),
    mv({ n: 6, kind: 'SALE_CANCEL', key: saleCancelKey('s3'), location: R1, baseQty: 4, links: { mirrorOf: saleOutKey('s3'), locationOf: saleOutKey('s3') } }),
    mv({ n: 7, kind: 'VAN_RETURN_RESTOCK', key: returnKey('s7'), location: R1, baseQty: 1, links: { mirrorOf: saleOutKey('s3') } }),
  ];
  const full = replay(moves, CFG2);
  for (let k = 0; k <= moves.length; k++) {
    const head = replay(moves.slice(0, k), CFG2);
    const tail = replay(moves.slice(k), CFG2, { state: head.state, lookup: snapshotLookupOf(head.outputs.map(snapshotRefOf)) });
    assert.deepEqual([...head.outputs, ...tail.outputs], full.outputs, `الاستئناف عند ${k}`);
    assert.deepEqual(tail.state, full.state, `الحالة عند ${k}`);
  }
  // لقطةٌ قديمة بالمفتاح نفسه في lookup لا تغلب ناتج الدفعة
  const stale = { ...snapshotRefOf(full.outputs[2]), valueMilli: -1n, baseQty: -1 };
  assert.deepEqual(replay(moves, CFG2, { lookup: snapshotLookupOf([stale]) }).outputs, full.outputs);
});

test('replay: مفتاحٌ مكرَّر في الدفعة خطأ مصدر ⇒ يرمي ولا يُطوى مرتين', () => {
  const m = mv({ n: 1, kind: 'RECEIVE', key: whItemKey('d'), location: 'WH', baseQty: 1, inValueMilli: 10n });
  assert.throws(() => replay([m, { ...m, cursor: { createdAt: at(2), id: 'other' } }], CFG2), /COSTING_DUPLICATE_MOVE_KEY/);
});

test('الحالة القانونية: لا (صنف، موقع) صفريٌّ بلا آخر متوسّط، والمؤشّر لا يرجع لوصولٍ متأخّر', () => {
  const s = createCostState();
  const none: SnapshotLookup = { get: () => undefined };
  applyMove(s, mv({ n: 5, kind: 'RECEIVE', key: whItemKey('a'), location: 'WH', baseQty: 2, inValueMilli: null }), CFG2, none);
  applyMove(s, mv({ n: 6, kind: 'WAREHOUSE_SALE', key: saleOutKey('b'), location: 'WH', baseQty: -2 }), CFG2, none);
  assert.equal(s.locs.size, 0, 'خارج التقييم كله خرج بلا متوسّط ⇒ لا حالة');
  const late = { ...mv({ n: 1, kind: 'RECEIVE', key: whItemKey('c'), location: 'WH', baseQty: 1, inValueMilli: 10_000n }), lateArrival: true };
  const o = applyMove(s, late, CFG2, none);
  assert.equal(o.lateArrival, true);
  assert.deepEqual(s.cursor, { createdAt: at(6), id: 'src00006' }, 'لا يرجع المؤشّر');
  assert.equal(s.movesFolded, 3);
});

test('stateTotals وcompareLocations وsplitLocStateKey وcloneCostState وsnapshotRefOf', () => {
  const s = createCostState();
  s.locs.set(locStateKey('P1', 'VAN:b'), { costedQtyU: 1_000_000, uncostedQtyU: 500_000, valueMilli: 7_000n, lastAvg: null });
  s.locs.set(locStateKey('P2', 'VAN:b'), { costedQtyU: 2_000_000, uncostedQtyU: 0, valueMilli: 3_000n, lastAvg: null });
  s.locs.set(locStateKey('P1', 'WH'), { costedQtyU: -1_000_000, uncostedQtyU: 0, valueMilli: -4_000n, lastAvg: null });
  s.locs.set(locStateKey('P1', 'VAN:_'), { costedQtyU: 0, uncostedQtyU: 0, valueMilli: 0n, lastAvg: { valueMilli: 5n, qtyU: 1 } });
  s.locs.set(locStateKey('P1', 'VAN:A'), { costedQtyU: 0, uncostedQtyU: 250_000, valueMilli: 0n, lastAvg: null });
  assert.deepEqual(stateTotals(s), [
    { location: 'WH', qtyBase: -1, uncostedQty: 0, valueMilli: -4_000n },
    { location: 'VAN:A', qtyBase: 0.25, uncostedQty: 0.25, valueMilli: 0n },
    { location: 'VAN:b', qtyBase: 3.5, uncostedQty: 0.5, valueMilli: 10_000n },
  ], 'المستودع أولاً، والسيارة الصفرية تُسقط');
  assert.deepEqual((['VAN:b', 'WH', 'VAN:_', 'VAN:A'] as LocationKey[]).sort(compareLocations), ['WH', 'VAN:A', 'VAN:_', 'VAN:b']);
  assert.deepEqual(splitLocStateKey(locStateKey('p-1', 'VAN:r-9')), { productId: 'p-1', location: 'VAN:r-9' });
  assert.throws(() => splitLocStateKey('nobar'), RangeError);
  assert.throws(() => splitLocStateKey('|WH'), RangeError);
  const c = cloneCostState(s);
  assert.deepEqual(c, s);
  c.locs.get(locStateKey('P1', 'VAN:_'))!.lastAvg!.qtyU = 99;
  assert.equal(s.locs.get(locStateKey('P1', 'VAN:_'))!.lastAvg!.qtyU, 1, 'نسخة عميقة');
  const { outs } = stepAll([mv({ n: 1, kind: 'RECEIVE', key: whItemKey('r'), location: 'WH', baseQty: 1, inValueMilli: 10n })]);
  assert.deepEqual(Object.keys(snapshotRefOf(outs[0])).sort(), [
    'baseQty', 'effectAt', 'key', 'kind', 'location', 'memoMilli', 'productId', 'toLocation', 'uncostedQty', 'valueMilli', 'varianceMilli',
  ]);
});

// ═══ التصفير هدفٌ مطلق (لا فرق) ═══

test('ZERO_RUN هدفٌ مطلق: سطر التصفير من رصيد الشاشة القديمة (لا ترى فاتورة الإدارة) يستنزف حالة المحرّك لا كميته — مصروف 1,000 لا 1,120', () => {
  // probe2: وارد 100 @ 10، فاتورة إدارة 10 (OD8 ⇒ من المستودع)، ثم التصفير بسطر −100 (رصيد الشاشة القديمة)، ثم وارد 50 @ 12
  const { outs, state, after } = stepAll([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('z1'), location: 'WH', baseQty: 100, inValueMilli: 1_000_000n }),
    mv({ n: 2, kind: 'WAREHOUSE_SALE', key: saleOutKey('z2'), location: 'WH', baseQty: -10 }),
    mv({ n: 3, kind: 'ZERO_RUN', key: whItemKey('z3'), location: 'WH', baseQty: -100 }),
    mv({ n: 4, kind: 'RECEIVE', key: whItemKey('z4'), location: 'WH', baseQty: 50, inValueMilli: 600_000n }),
  ]);
  snap(outs[1], { kind: 'WAREHOUSE_SALE', location: 'WH', baseQty: -10, valueMilli: -100_000n, unitCostE4: 100_000n }, 'فاتورة الإدارة');
  // يُستنزف 90 @ 900 (لا 100 @ 1,000): بلا رصيد سالب ولا NEGATIVE_STOCK
  snap(outs[2], { kind: 'ZERO_RUN', location: 'WH', baseQty: -90, valueMilli: -900_000n, unitCostE4: 100_000n }, 'التصفير');
  assertLoc(after[2], 'A', 'WH', 0, 0n, 'المستودع صفرٌ بعد التصفير');
  // الوارد بعده لا يسدّ حفرةً ولا يُحمّل تكلفة المبيعات فرقاً
  snap(outs[3], { kind: 'RECEIVE', location: 'WH', baseQty: 50, valueMilli: 600_000n, unitCostE4: 120_000n }, 'وارد بعد التصفير');
  assertLoc(state, 'A', 'WH', 50, 600_000n, 'الختام = الشاشة القديمة 50');
  let expense = 0n;
  for (const o of outs) {
    assertBalanced(o);
    const g = glImpactOf(o);
    if (o.kind !== 'RECEIVE') expense += g.cogsMilli + g.counterMilli;
  }
  assert.equal(expense, 1_000_000n, 'تكلفة المبيعات 100 + خسارة التسوية 900 = كلفة المئة حبّة');
});

test('ZERO_RUN: السيارة تُستنزف بكميتها هي، والحفرة تُسدّ بلا ثمن (الفرق يردّ تكلفة المبيعات)، والموقع الفارغ لا شيء', () => {
  const { outs, state } = stepAll([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('y1'), location: 'WH', baseQty: 10, inValueMilli: 100_000n }),
    mv({ n: 2, kind: 'VAN_LOAD', key: vanItemKey('y2'), location: 'WH', toLocation: R1, baseQty: -6 }),
    mv({ n: 3, kind: 'VAN_SALE', key: saleOutKey('y3'), location: R1, baseQty: -2 }),
    // سطرٌ بكمية لا تطابق الحالة (−6): يُستنزف ما في السيارة (4) وحده
    mv({ n: 4, kind: 'ZERO_RUN', key: vanItemKey('y4'), location: R1, baseQty: -6 }),
    // سيارة لم تُحمَّل: بيعٌ مكشوف بمتوسّط المستودع ⇒ −3 @ −30,000
    mv({ n: 5, kind: 'VAN_SALE', key: saleOutKey('y5'), location: R2, baseQty: -3 }),
    // سطرٌ يقول −1 والحالة −3: تُسدّ الحفرة كلها بلا ثمن
    mv({ n: 6, kind: 'ZERO_RUN', key: vanItemKey('y6'), location: R2, baseQty: -1 }),
    mv({ n: 7, kind: 'ZERO_RUN', key: vanItemKey('y7'), location: 'VAN:R3', baseQty: -5 }),
  ]);
  snap(outs[3], { kind: 'ZERO_RUN', location: R1, baseQty: -4, valueMilli: -40_000n, unitCostE4: 100_000n }, 'سيارة');
  snap(outs[4], { kind: 'VAN_SALE', location: R2, baseQty: -3, valueMilli: -30_000n, unitCostE4: 100_000n, warnings: ['NEGATIVE_STOCK', 'WH_RATE_FALLBACK'] }, 'مكشوف');
  snap(outs[5], { kind: 'ZERO_RUN', location: R2, baseQty: 3, uncostedQty: 3, valueMilli: 30_000n, varianceMilli: -30_000n, unitCostE4: 0n, warnings: ['HOLE_FILLED'] }, 'سدّ الحفرة');
  assert.deepEqual(glImpactOf(outs[5]), { inventory: [{ location: R2, milli: 30_000n }], cogsMilli: -30_000n, writeOffMilli: 0n, counterMilli: 0n, counterRole: 'ADJUSTMENT' });
  snap(outs[6], { kind: 'ZERO_RUN', location: 'VAN:R3', baseQty: 0, valueMilli: 0n, unitCostE4: 0n }, 'موقع فارغ');
  assertLoc(state, 'A', R1, 0, 0n, 'السيارة');
  assertLoc(state, 'A', R2, 0, 0n, 'الحفرة');
  assert.equal(state.locs.has(locStateKey('A', 'VAN:R3')), false, 'لا حالة لموقع فارغ');
  for (const o of outs) assertBalanced(o);
});

// ═══ الإلغاء والتبديل يتبعان الأثر المجمَّد لا حالة البند الحالية ═══

test('RETURN_CANCEL يقرّر بلقطة آخر أثر (memoOf): RET عائد ثم خُتم «منتهياً» ⇒ خروج 2 (probe1)، والمشطوب يعكس مذكِّرته أياً كان تخمين المصدر', () => {
  const ret = (k: string) => ({ mirrorOf: null, locationOf: returnKey(k), memoOf: returnKey(k) });
  const { outs, after } = stepAll([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('f1'), location: 'WH', baseQty: 10, inValueMilli: 1_000_000n }),
    mv({ n: 2, kind: 'VAN_LOAD', key: vanItemKey('f2'), location: 'WH', toLocation: R1, baseQty: -10 }),
    mv({ n: 3, kind: 'VAN_SALE', key: saleOutKey('f3'), location: R1, baseQty: -4 }),
    mv({ n: 4, kind: 'VAN_RETURN_RESTOCK', key: returnKey('f4'), location: R1, baseQty: 2, links: { mirrorOf: saleOutKey('f3') } }),
    // المصدر يخمّنه مشطوباً (returnExpired خُتم بعد الطيّ) فكميته 0 — والمحرّك يرى RET المجمَّد عائداً
    mv({ n: 5, kind: 'RETURN_CANCEL', key: returnCancelKey('f4'), location: 'WH', baseQty: 0, links: ret('f4') }),
    // والعكس: RET مشطوب مجمَّد والمصدر يخمّنه عائداً ⇒ عكس المذكِّرة بلا خروج
    mv({ n: 6, kind: 'RETURN_WRITE_OFF', key: returnKey('f6'), location: R1, baseQty: 0, memoQty: 1, links: { mirrorOf: saleOutKey('f3') } }),
    mv({ n: 7, kind: 'RETURN_CANCEL', key: returnCancelKey('f6'), location: R1, baseQty: -1, links: ret('f6') }),
  ]);
  assertLoc(after[3], 'A', R1, 8, 800_000n, 'بعد المرتجع العائد');
  snap(outs[4], { kind: 'RETURN_CANCEL', location: R1, baseQty: -2, valueMilli: -200_000n, unitCostE4: 1_000_000n }, 'إلغاء RET عائد مجمَّد');
  assertLoc(after[4], 'A', R1, 6, 600_000n, 'السيارة 6 = الشاشة التشغيلية (المرتجع الملغى لا يُحتسب)');
  snap(outs[5], { kind: 'RETURN_WRITE_OFF', location: R1, baseQty: 0, valueMilli: 0n, memoMilli: 100_000n, unitCostE4: 1_000_000n }, 'شطب');
  snap(outs[6], { kind: 'RETURN_CANCEL', location: R1, baseQty: 0, valueMilli: 0n, memoMilli: -100_000n, unitCostE4: 0n }, 'إلغاء مشطوبٍ مجمَّد');
  assertLoc(after[6], 'A', R1, 6, 600_000n, 'لا خروج');
  for (const o of outs) assertBalanced(o);
});

test('RESTOCK_TOGGLE بـmemoOf يوافق السلسلة المجمَّدة: لا يُخرج مشطوباً ولا يُدخل عائداً، والتبديل بلا أثر يحيل إلى RET', () => {
  const { outs, after } = stepAll([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('h1'), location: 'WH', baseQty: 10, inValueMilli: 1_000_000n }),
    mv({ n: 2, kind: 'VAN_LOAD', key: vanItemKey('h2'), location: 'WH', toLocation: R1, baseQty: -10 }),
    mv({ n: 3, kind: 'VAN_SALE', key: saleOutKey('h3'), location: R1, baseQty: -4 }),
    // مكتوبٌ عليه يوم إصداره (RET مشطوب) ثم أول تبديل إلى «لا يعود» ⇒ لا أثر؛ والإلغاء بعده يعكس مذكِّرة RET
    mv({ n: 4, kind: 'RETURN_WRITE_OFF', key: returnKey('h4'), location: R1, baseQty: 0, memoQty: 2, links: { mirrorOf: saleOutKey('h3') } }),
    mv({ n: 5, kind: 'RESTOCK_TOGGLE', key: restockToggleKey('T5', 'h4'), location: R1, baseQty: -2, reason: 'EXPIRED', links: { mirrorOf: null, locationOf: returnKey('h4'), memoOf: returnKey('h4') } }),
    mv({ n: 6, kind: 'RETURN_CANCEL', key: returnCancelKey('h4'), location: R1, baseQty: 0, links: { mirrorOf: null, locationOf: returnKey('h4'), memoOf: restockToggleKey('T5', 'h4') } }),
    // عائدٌ مجمَّد ثم تبديل إلى «يعود» (المصدر ظنّه مشطوباً) ⇒ لا أثر؛ ثم إلى «لا يعود» (سابقه بلا أثر ⇒ RET عائد) ⇒ خروج
    mv({ n: 7, kind: 'VAN_RETURN_RESTOCK', key: returnKey('h7'), location: R1, baseQty: 1, links: { mirrorOf: saleOutKey('h3') } }),
    mv({ n: 8, kind: 'RESTOCK_TOGGLE', key: restockToggleKey('T8', 'h7'), location: R1, baseQty: 1, links: { mirrorOf: saleOutKey('h3'), locationOf: returnKey('h7'), memoOf: returnKey('h7') } }),
    mv({ n: 9, kind: 'RESTOCK_TOGGLE', key: restockToggleKey('T9', 'h7'), location: R1, baseQty: -1, links: { mirrorOf: null, locationOf: returnKey('h7'), memoOf: restockToggleKey('T8', 'h7') } }),
    mv({ n: 10, kind: 'RETURN_CANCEL', key: returnCancelKey('h7'), location: R1, baseQty: 0, links: { mirrorOf: null, locationOf: returnKey('h7'), memoOf: restockToggleKey('T9', 'h7') } }),
    // مرجعٌ غائب ⇒ LINK_NOT_FOUND والاتجاه كما هو (لا رقم من حالة البند)
    mv({ n: 11, kind: 'RESTOCK_TOGGLE', key: restockToggleKey('T11', 'h7'), location: R1, baseQty: -1, links: { mirrorOf: null, locationOf: returnKey('h7'), memoOf: restockToggleKey('ghost', 'h7') } }),
  ]);
  assert.equal(outs[3].memoMilli, 200_000n);
  snap(outs[4], { kind: 'RESTOCK_TOGGLE', location: R1, baseQty: 0, valueMilli: 0n, memoMilli: 0n, unitCostE4: 0n }, 'إلى لا يعود وهو مشطوب');
  assert.equal(outs[4].reason, 'EXPIRED');
  snap(outs[5], { kind: 'RETURN_CANCEL', location: R1, baseQty: 0, valueMilli: 0n, memoMilli: -200_000n, unitCostE4: 0n }, 'الإلغاء يعكس RET عبر التبديل الصفري');
  assertLoc(after[5], 'A', R1, 6, 600_000n, 'السيارة لم تتحرّك');
  snap(outs[7], { kind: 'RESTOCK_TOGGLE', location: R1, baseQty: 0, valueMilli: 0n, memoMilli: 0n, unitCostE4: 0n }, 'إلى يعود وهو عائد');
  assertLoc(after[7], 'A', R1, 7, 700_000n, 'لا دخول مرتين');
  snap(outs[8], { kind: 'RESTOCK_TOGGLE', location: R1, baseQty: -1, valueMilli: -100_000n, memoMilli: 100_000n, unitCostE4: 1_000_000n }, 'إلى لا يعود');
  snap(outs[9], { kind: 'RETURN_CANCEL', location: R1, baseQty: 0, valueMilli: 0n, memoMilli: -100_000n, unitCostE4: 0n }, 'إلغاء بعد الخروج');
  snap(outs[10], { kind: 'RESTOCK_TOGGLE', location: R1, baseQty: -1, valueMilli: -100_000n, memoMilli: 100_000n, unitCostE4: 1_000_000n, warnings: ['LINK_NOT_FOUND'] }, 'مرجع غائب');
  for (const o of outs) assertBalanced(o);
});
