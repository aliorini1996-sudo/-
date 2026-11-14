// «ربط الدفاتر» L3 — أثر لقطات التكلفة على الدفاتر (services/costing/accounts.ts): جدول العقد §8 حرفياً لكل نوع،
// والتوازن، وحساب مخزون كل موقع، ومطابقة Σ سطور المخزون لتقييم المحرّك على سيناريو يجمع الأنواع الستة عشر.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cogsImpactMilli, glImpactOf, inventoryAccountOf, type GlImpactInput } from '../services/costing/accounts';
import { replay, stateTotals } from '../services/costing/stepper';
import {
  restockToggleKey, returnCancelKey, returnKey, saleCancelKey, saleOutKey, vanItemKey, whItemKey, parseCostKey,
} from '../services/costing/keys';
import { MOVE_KINDS, type GlImpact, type LocationKey, type Move, type MoveKind, type MoveLinks } from '../services/costing/types';

const R1: LocationKey = 'VAN:R1';
const R2: LocationKey = 'VAN:R2';

function inp(kind: MoveKind, location: LocationKey, d: bigint, opts: { v?: bigint; m?: bigint; to?: LocationKey } = {}): GlImpactInput {
  return { kind, location, toLocation: opts.to ?? null, valueMilli: d, varianceMilli: opts.v ?? 0n, memoMilli: opts.m ?? 0n, reason: null };
}

function sum(g: GlImpact): bigint {
  return g.inventory.reduce((s, l) => s + l.milli, 0n) + g.cogsMilli + g.writeOffMilli + g.counterMilli;
}

// [وصف، مدخل، الأثر المتوقَّع] — الأرقام من أمثلة §5
const TABLE: [string, GlImpactInput, GlImpact][] = [
  ['RECEIVE يسدّ حفرة (المثال و)', inp('RECEIVE', 'WH', 115_000n, { v: 5_000n }),
    { inventory: [{ location: 'WH', milli: 115_000n }], cogsMilli: 5_000n, writeOffMilli: 0n, counterMilli: -120_000n, counterRole: 'GRNI' }],
  ['RECEIVE عادي', inp('RECEIVE', 'WH', 2_000_000n),
    { inventory: [{ location: 'WH', milli: 2_000_000n }], cogsMilli: 0n, writeOffMilli: 0n, counterMilli: -2_000_000n, counterRole: 'GRNI' }],
  ['RECEIVE بلا سعر', inp('RECEIVE', 'WH', 0n),
    { inventory: [], cogsMilli: 0n, writeOffMilli: 0n, counterMilli: 0n, counterRole: 'GRNI' }],
  ['VENDOR_RETURN', inp('VENDOR_RETURN', 'WH', -30_000n),
    { inventory: [{ location: 'WH', milli: -30_000n }], cogsMilli: 0n, writeOffMilli: 0n, counterMilli: 30_000n, counterRole: 'VENDOR' }],
  ['WH_ADJUST سالب', inp('WH_ADJUST', 'WH', -28_000n),
    { inventory: [{ location: 'WH', milli: -28_000n }], cogsMilli: 0n, writeOffMilli: 0n, counterMilli: 28_000n, counterRole: 'ADJUSTMENT' }],
  ['WH_ADJUST موجب يسدّ حفرة بلا ثمن', inp('WH_ADJUST', 'WH', 32_000n, { v: -32_000n }),
    { inventory: [{ location: 'WH', milli: 32_000n }], cogsMilli: -32_000n, writeOffMilli: 0n, counterMilli: 0n, counterRole: 'ADJUSTMENT' }],
  ['VAN_ADJUST', inp('VAN_ADJUST', R1, 10_000n),
    { inventory: [{ location: R1, milli: 10_000n }], cogsMilli: 0n, writeOffMilli: 0n, counterMilli: -10_000n, counterRole: 'ADJUSTMENT' }],
  ['ZERO_RUN', inp('ZERO_RUN', R2, -50_000n),
    { inventory: [{ location: R2, milli: -50_000n }], cogsMilli: 0n, writeOffMilli: 0n, counterMilli: 50_000n, counterRole: 'ADJUSTMENT' }],
  ['VAN_LOAD يسدّ حفرة السيارة (المثال ب)', inp('VAN_LOAD', 'WH', -95_000n, { v: 6_000n, to: R2 }),
    { inventory: [{ location: 'WH', milli: -95_000n }, { location: R2, milli: 89_000n }], cogsMilli: 6_000n, writeOffMilli: 0n, counterMilli: 0n, counterRole: 'NONE' }],
  ['VAN_UNLOAD', inp('VAN_UNLOAD', R1, -420_000n, { to: 'WH' }),
    { inventory: [{ location: R1, milli: -420_000n }, { location: 'WH', milli: 420_000n }], cogsMilli: 0n, writeOffMilli: 0n, counterMilli: 0n, counterRole: 'NONE' }],
  ['DAMAGE_OUT', inp('DAMAGE_OUT', R1, 0n),
    { inventory: [], cogsMilli: 0n, writeOffMilli: 0n, counterMilli: 0n, counterRole: 'NONE' }],
  ['VAN_SALE', inp('VAN_SALE', R1, -210_000n),
    { inventory: [{ location: R1, milli: -210_000n }], cogsMilli: 210_000n, writeOffMilli: 0n, counterMilli: 0n, counterRole: 'NONE' }],
  ['WAREHOUSE_SALE', inp('WAREHOUSE_SALE', 'WH', -330n),
    { inventory: [{ location: 'WH', milli: -330n }], cogsMilli: 330n, writeOffMilli: 0n, counterMilli: 0n, counterRole: 'NONE' }],
  ['SALE_CANCEL', inp('SALE_CANCEL', R1, 210_000n),
    { inventory: [{ location: R1, milli: 210_000n }], cogsMilli: -210_000n, writeOffMilli: 0n, counterMilli: 0n, counterRole: 'NONE' }],
  ['SALE_CANCEL يسدّ حفرة (−Δ = −G + var)', inp('SALE_CANCEL', R1, 8_000n, { v: 12_000n }),
    { inventory: [{ location: R1, milli: 8_000n }], cogsMilli: -8_000n, writeOffMilli: 0n, counterMilli: 0n, counterRole: 'NONE' }],
  ['VAN_RETURN_RESTOCK', inp('VAN_RETURN_RESTOCK', R1, 42_000n),
    { inventory: [{ location: R1, milli: 42_000n }], cogsMilli: -42_000n, writeOffMilli: 0n, counterMilli: 0n, counterRole: 'NONE' }],
  ['WAREHOUSE_RETURN_RESTOCK', inp('WAREHOUSE_RETURN_RESTOCK', 'WH', 126_000n),
    { inventory: [{ location: 'WH', milli: 126_000n }], cogsMilli: -126_000n, writeOffMilli: 0n, counterMilli: 0n, counterRole: 'NONE' }],
  ['RETURN_WRITE_OFF (المثال هـ)', inp('RETURN_WRITE_OFF', R1, 0n, { m: 63_000n }),
    { inventory: [], cogsMilli: -63_000n, writeOffMilli: 63_000n, counterMilli: 0n, counterRole: 'NONE' }],
  ['RETURN_CANCEL عائداً', inp('RETURN_CANCEL', R1, -23_600n),
    { inventory: [{ location: R1, milli: -23_600n }], cogsMilli: 23_600n, writeOffMilli: 0n, counterMilli: 0n, counterRole: 'NONE' }],
  ['RETURN_CANCEL مشطوباً', inp('RETURN_CANCEL', R1, 0n, { m: -63_000n }),
    { inventory: [], cogsMilli: 63_000n, writeOffMilli: -63_000n, counterMilli: 0n, counterRole: 'NONE' }],
  ['RESTOCK_TOGGLE إلى true (المثال أ #9)', inp('RESTOCK_TOGGLE', R1, 42_000n, { m: -42_000n }),
    { inventory: [{ location: R1, milli: 42_000n }], cogsMilli: 0n, writeOffMilli: -42_000n, counterMilli: 0n, counterRole: 'NONE' }],
  ['RESTOCK_TOGGLE إلى true يسدّ حفرة', inp('RESTOCK_TOGGLE', R1, 30_000n, { v: 12_000n, m: -42_000n }),
    { inventory: [{ location: R1, milli: 30_000n }], cogsMilli: 12_000n, writeOffMilli: -42_000n, counterMilli: 0n, counterRole: 'NONE' }],
  ['RESTOCK_TOGGLE إلى false (المثال أ #8)', inp('RESTOCK_TOGGLE', R1, -42_000n, { m: 42_000n }),
    { inventory: [{ location: R1, milli: -42_000n }], cogsMilli: 0n, writeOffMilli: 42_000n, counterMilli: 0n, counterRole: 'NONE' }],
];

test('glImpactOf: جدول §8 حرفياً لكل نوع، متوازن، وcogsImpactMilli = cogsMilli', () => {
  const covered = new Set<MoveKind>();
  for (const [label, input, expected] of TABLE) {
    const g = glImpactOf(input);
    assert.deepEqual(g, expected, label);
    assert.equal(sum(g), 0n, `${label}: غير متوازن`);
    assert.equal(cogsImpactMilli(input), expected.cogsMilli, label);
    covered.add(input.kind);
  }
  assert.deepEqual([...covered].sort(), [...MOVE_KINDS].sort(), 'كل الأنواع مغطّاة');
});

test('glImpactOf: سطر المخزون الصفري لا يُدرج، والتحويل بلا هدف والنوع المجهول يرميان', () => {
  assert.deepEqual(glImpactOf(inp('VAN_SALE', R1, 0n)).inventory, []);
  assert.deepEqual(glImpactOf(inp('VAN_LOAD', 'WH', 0n, { to: R1 })).inventory, []);
  assert.deepEqual(glImpactOf(inp('VAN_LOAD', 'WH', 0n, { v: -10n, to: R1 })).inventory, [{ location: R1, milli: 10n }]);
  assert.throws(() => glImpactOf(inp('VAN_UNLOAD', R1, -5n)), /COSTING_TRANSFER_WITHOUT_TARGET/);
  assert.throws(() => glImpactOf(inp('NOPE' as MoveKind, 'WH', 1n)), /COSTING_UNKNOWN_KIND/);
});

test('inventoryAccountOf: المستودع 114001، والسيارة 114002 بمندوبها، والمجهولة بلا مندوب', () => {
  assert.deepEqual(inventoryAccountOf('WH'), { accountKey: 'INVENTORY_WAREHOUSE', salesRepId: null });
  assert.deepEqual(inventoryAccountOf('VAN:rep-1'), { accountKey: 'INVENTORY_VAN', salesRepId: 'rep-1' });
  assert.deepEqual(inventoryAccountOf('VAN:_'), { accountKey: 'INVENTORY_VAN', salesRepId: null });
  assert.throws(() => inventoryAccountOf('SHELF' as LocationKey), RangeError);
});

// ═══ سيناريو بالأنواع الستة عشر: Σ سطور المخزون لكل موقع = تقييم المحرّك، وكل لقطة متوازنة ═══

const T0 = Date.UTC(2026, 0, 5, 9);
let n = 0;
function mv(kind: MoveKind, key: string, location: LocationKey, baseQty: number, o: { to?: LocationKey; inValue?: bigint | null; memoQty?: number; links?: MoveLinks; productId?: string } = {}): Move {
  n += 1;
  const createdAt = new Date(T0 + n * 60_000);
  const p = parseCostKey(key);
  assert.ok(p);
  return {
    key, kind, effectAt: createdAt, cursor: { createdAt, id: `row${String(n).padStart(4, '0')}` }, productId: o.productId ?? 'P',
    location, toLocation: o.to ?? null, baseQty, memoQty: o.memoQty ?? null, inValueMilli: o.inValue ?? null, links: o.links ?? null,
    reason: null, refType: p.refType, refId: `doc${n}`, itemId: p.itemId,
  };
}

test('سيناريو الأنواع كلها: الأدوار المقابلة، وΣ أثر المخزون لكل موقع = stateTotals، وΣ الأثر كله صفر', () => {
  const moves: Move[] = [
    mv('RECEIVE', whItemKey('1'), 'WH', 40, { inValue: 400_000n }),
    mv('RECEIVE', whItemKey('2'), 'WH', 5, { inValue: null }),
    mv('VENDOR_RETURN', whItemKey('3'), 'WH', -3),
    mv('WH_ADJUST', whItemKey('4'), 'WH', 2),
    mv('VAN_LOAD', vanItemKey('5'), 'WH', -20, { to: R1 }),
    mv('VAN_SALE', saleOutKey('6'), R1, -8),
    mv('SALE_CANCEL', saleCancelKey('6'), R1, 8, { links: { mirrorOf: saleOutKey('6'), locationOf: saleOutKey('6') } }),
    mv('VAN_SALE', saleOutKey('7'), R1, -10),
    mv('VAN_RETURN_RESTOCK', returnKey('8'), R1, 3, { links: { mirrorOf: saleOutKey('7') } }),
    mv('RETURN_WRITE_OFF', returnKey('9'), R1, 0, { memoQty: 2, links: { mirrorOf: saleOutKey('7') } }),
    mv('RESTOCK_TOGGLE', restockToggleKey('L10', '8'), R1, -3, { links: { mirrorOf: null, locationOf: returnKey('8') } }),
    mv('RESTOCK_TOGGLE', restockToggleKey('L11', '8'), R1, 3, { links: { mirrorOf: saleOutKey('7'), locationOf: returnKey('8') } }),
    mv('RETURN_CANCEL', returnCancelKey('8'), R1, -3, { links: { mirrorOf: null, locationOf: returnKey('8') } }),
    mv('RETURN_CANCEL', returnCancelKey('9'), R1, 0, { links: { mirrorOf: null, memoOf: returnKey('9'), locationOf: returnKey('9') } }),
    mv('WAREHOUSE_SALE', saleOutKey('15'), 'WH', -4),
    mv('WAREHOUSE_RETURN_RESTOCK', returnKey('16'), 'WH', 1, { links: { mirrorOf: saleOutKey('15') } }),
    mv('VAN_ADJUST', vanItemKey('17'), R1, -1),
    mv('DAMAGE_OUT', vanItemKey('18'), R1, 0),
    mv('VAN_SALE', saleOutKey('19'), R2, -2),
    mv('VAN_LOAD', vanItemKey('20'), 'WH', -6, { to: R2 }),
    mv('VAN_UNLOAD', vanItemKey('21'), R1, -5, { to: 'WH' }),
    mv('ZERO_RUN', vanItemKey('22'), R2, -4),
    mv('ZERO_RUN', whItemKey('23'), 'WH', -30),
    // التصفير هدفٌ مطلق (المستودع صفرٌ بعده أياً كان سطره) — وارد بعده يُبقي المستودع موقعاً ثانياً بقيمة
    mv('RECEIVE', whItemKey('24'), 'WH', 5, { inValue: 60_000n }),
  ];
  const r = replay(moves, { currencyDecimals: 2 });
  assert.deepEqual(new Set(r.outputs.map((o) => o.kind)), new Set(MOVE_KINDS), 'كل الأنواع حاضرة');
  const byLoc = new Map<LocationKey, bigint>();
  let other = 0n;
  let writeOff = 0n;
  for (const o of r.outputs) {
    const g = glImpactOf(o);
    assert.equal(sum(g), 0n, `غير متوازن: ${o.key}`);
    const role = ({ RECEIVE: 'GRNI', VENDOR_RETURN: 'VENDOR', WH_ADJUST: 'ADJUSTMENT', VAN_ADJUST: 'ADJUSTMENT', ZERO_RUN: 'ADJUSTMENT' } as Record<string, string>)[o.kind] ?? 'NONE';
    assert.equal(g.counterRole, role, o.key);
    for (const l of g.inventory) byLoc.set(l.location, (byLoc.get(l.location) ?? 0n) + l.milli);
    other += g.cogsMilli + g.writeOffMilli + g.counterMilli;
    writeOff += g.writeOffMilli;
  }
  const totals = stateTotals(r.state);
  assert.ok(totals.length >= 2, 'المستودع والسيارة');
  for (const t of totals) assert.equal(byLoc.get(t.location) ?? 0n, t.valueMilli, `Σ أثر ${t.location} = تقييمه`);
  for (const [loc, v] of byLoc) if (v !== 0n) assert.ok(totals.some((t) => t.location === loc), `موقع بأثر بلا تقييم: ${loc}`);
  // الدفاتر كلها: ما ليس مخزوناً = −المخزون الختامي
  assert.equal(other, -totals.reduce((s, t) => s + t.valueMilli, 0n));
  // الشطب وإلغاؤه يتعادلان على 514001؛ والتبديلان: إلى «لا يعود» +قيمة الخروج، وإلى «يعود» −قيمة الدخول
  const by = new Map(r.outputs.map((o) => [o.key, o] as const));
  const memo = (k: string) => by.get(k)!.memoMilli;
  assert.ok(memo(returnKey('9')) > 0n);
  assert.equal(memo(returnKey('9')) + memo(returnCancelKey('9')), 0n);
  assert.equal(memo(restockToggleKey('L10', '8')), -by.get(restockToggleKey('L10', '8'))!.valueMilli);
  assert.equal(memo(restockToggleKey('L11', '8')), -(by.get(restockToggleKey('L11', '8'))!.valueMilli + by.get(restockToggleKey('L11', '8'))!.varianceMilli));
  assert.equal(writeOff, memo(restockToggleKey('L10', '8')) + memo(restockToggleKey('L11', '8')));
});
