// «ربط الدفاتر» L2 (P2) — السلسلة الكاملة لسطور المخزون الافتتاحية على أمثلة العقد المحلولة §5 بالمحرّك الحقيقي:
// حركات ⇐ replay (costing/stepper.ts) ⇐ stateTotals ⇐ linkedOpeningLines/buildOpeningMove ⇐ validateMove(SYSTEM).
// يثبت توافق الواجهتين (LocationTotals من المحرّك تُقيَّد كما هي بالملّي) لا منطق المحرّك نفسه (اختبارات C1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay, stateTotals } from '../services/costing/stepper';
import { restockToggleKey, returnKey, saleCancelKey, saleOutKey, vanItemKey, whItemKey } from '../services/costing/keys';
import type { LocationTotals, Move } from '../services/costing/types';
import { buildOpeningMove, linkedOpeningLines, type DerivedOpening } from '../services/gl/opening';
import { saContext } from '../services/gl/testing/fixtures';
import { validateMove } from '../services/gl/validate';

const OPENING_DATE = '2026-12-31';
const CFG = { currencyDecimals: 2 };

let seq = 0;
/** حركة بلحظة تسجيل متزايدة (ترتيب D2 = ترتيب الإدراج هنا) */
function mv(p: Omit<Move, 'effectAt' | 'cursor' | 'refId' | 'itemId' | 'productId'> & { productId?: string; itemId?: string }): Move {
  seq++;
  const t = new Date(Date.UTC(2026, 5, 1, 0, seq));
  const id = `src${String(seq).padStart(4, '0')}`;
  return { productId: 'A', itemId: `item${seq}`, refId: id, effectAt: t, cursor: { createdAt: t, id }, ...p };
}

const emptyOpening = { receivables: [], custody: [], paylinkHeldMilli: 0n } as unknown as DerivedOpening;

function inventoryLines(totals: readonly LocationTotals[]) {
  return linkedOpeningLines({ opening: emptyOpening, inventory: totals, salesRepNames: { R1: 'حسام', R2: 'علي', a: 'سالم' } }, OPENING_DATE)
    .lines.map((l) => [l.accountKey, l.salesRepId ?? null, String(l.debitMilli - l.creditMilli)]);
}

function assertPostable(totals: readonly LocationTotals[], equityMilli: bigint) {
  const ctx = saContext();
  const m = buildOpeningMove({ openingDate: OPENING_DATE, manual: [], ctx, derived: { opening: emptyOpening, inventory: totals } });
  assert.equal(m.equityDiffMilli, equityMilli);
  const v = validateMove(m.draft!, ctx, { mode: 'SYSTEM' });
  assert.equal(v.totalDebitMilli, v.totalCreditMilli);
}

test('المثال أ (§5): الحالة بعد #9 — المستودع 120 @ 2,520 والسيارة R1 20 @ 420؛ وبعد التنزيل #10 المستودع وحده 140 @ 2,940', () => {
  const s4 = saleOutKey('ii4');
  const s6 = saleOutKey('ii6');
  const ret = returnKey('ii7');
  const moves: Move[] = [
    mv({ key: whItemKey('w1'), kind: 'RECEIVE', location: 'WH', baseQty: 100, inValueMilli: 2_000_000n, refType: 'WH_ENTRY' }),
    mv({ key: whItemKey('w2'), kind: 'RECEIVE', location: 'WH', baseQty: 50, inValueMilli: 1_150_000n, refType: 'WH_ENTRY' }),
    mv({ key: vanItemKey('v3'), kind: 'VAN_LOAD', location: 'WH', toLocation: 'VAN:R1', baseQty: -30, refType: 'VAN_LOAD' }),
    mv({ key: s4, kind: 'VAN_SALE', location: 'VAN:R1', baseQty: -10, refType: 'INVOICE' }),
    mv({ key: saleCancelKey('ii4'), kind: 'SALE_CANCEL', location: 'VAN:R1', baseQty: 10, links: { mirrorOf: s4, locationOf: s4 }, refType: 'INVOICE' }),
    mv({ key: s6, kind: 'VAN_SALE', location: 'VAN:R1', baseQty: -12, refType: 'INVOICE' }),
    mv({ key: ret, kind: 'VAN_RETURN_RESTOCK', location: 'VAN:R1', baseQty: 2, links: { mirrorOf: s6 }, refType: 'INVOICE' }),
    mv({ key: restockToggleKey('log8', 'ii7'), kind: 'RESTOCK_TOGGLE', location: 'VAN:R1', baseQty: -2, links: { mirrorOf: null, locationOf: ret }, refType: 'RESTOCK_LOG' }),
    mv({ key: restockToggleKey('log9', 'ii7'), kind: 'RESTOCK_TOGGLE', location: 'VAN:R1', baseQty: 2, links: { mirrorOf: s6, locationOf: ret }, refType: 'RESTOCK_LOG' }),
    mv({ key: vanItemKey('v10'), kind: 'VAN_UNLOAD', location: 'VAN:R1', toLocation: 'WH', baseQty: -20, refType: 'VAN_LOAD' }),
  ];
  const before = stateTotals(replay(moves.slice(0, 9), CFG).state);
  assert.deepEqual(inventoryLines(before), [['INVENTORY_WAREHOUSE', null, '2520000'], ['INVENTORY_VAN', 'R1', '420000']]);
  assertPostable(before, 2_940_000n);
  const after = stateTotals(replay(moves, CFG).state);
  // السيارة المستنزفة (0 @ 0) لا سطر لها
  assert.deepEqual(inventoryLines(after), [['INVENTORY_WAREHOUSE', null, '2940000']]);
  assertPostable(after, 2_940_000n);
});

test('المثال ب (§5): مكشوف سيارة لم تُحمَّل ثم سدّ الحفرة — المستودع 10 @ 95 والسيارة R2 6 @ 57، وقبل السدّ حفرة دائنة', () => {
  const moves: Move[] = [
    mv({ productId: 'B', key: whItemKey('b1'), kind: 'RECEIVE', location: 'WH', baseQty: 10, inValueMilli: 80_000n, refType: 'WH_ENTRY' }),
    mv({ productId: 'B', key: saleOutKey('bi2'), kind: 'VAN_SALE', location: 'VAN:R2', baseQty: -4, refType: 'INVOICE' }),
    mv({ productId: 'B', key: whItemKey('b3'), kind: 'RECEIVE', location: 'WH', baseQty: 10, inValueMilli: 110_000n, refType: 'WH_ENTRY' }),
    mv({ productId: 'B', key: vanItemKey('b4'), kind: 'VAN_LOAD', location: 'WH', toLocation: 'VAN:R2', baseQty: -10, refType: 'VAN_LOAD' }),
  ];
  // بعد #2: السيارة −4 @ −32,000 (بديل متوسّط المستودع 8) ⇒ سطر 114002 دائن بمندوبه
  const hole = stateTotals(replay(moves.slice(0, 2), CFG).state);
  assert.deepEqual(inventoryLines(hole), [['INVENTORY_WAREHOUSE', null, '80000'], ['INVENTORY_VAN', 'R2', '-32000']]);
  assertPostable(hole, 48_000n);
  const r = replay(moves, CFG);
  assert.equal(r.outputs[3].varianceMilli, 6_000n, 'فرق سدّ الحفرة = 4 × (9.5 − 8)');
  const final = stateTotals(r.state);
  assert.deepEqual(inventoryLines(final), [['INVENTORY_WAREHOUSE', null, '95000'], ['INVENTORY_VAN', 'R2', '57000']]);
  assertPostable(final, 152_000n);
});

test('المثال و (§5): مكشوف المستودع على مستودع فارغ — حفرة المستودع دائنة ثم المستودع 20 @ 115 والسيارة 10 @ 50', () => {
  const moves: Move[] = [
    mv({ productId: 'F', key: whItemKey('f1'), kind: 'RECEIVE', location: 'WH', baseQty: 10, inValueMilli: 50_000n, refType: 'WH_ENTRY' }),
    mv({ productId: 'F', key: vanItemKey('f2'), kind: 'VAN_LOAD', location: 'WH', toLocation: 'VAN:a', baseQty: -10, refType: 'VAN_LOAD' }),
    mv({ productId: 'F', key: vanItemKey('f3'), kind: 'VAN_LOAD', location: 'WH', toLocation: 'VAN:a', baseQty: -5, refType: 'VAN_LOAD' }),
    mv({ productId: 'F', key: whItemKey('f4'), kind: 'RECEIVE', location: 'WH', baseQty: 20, inValueMilli: 120_000n, refType: 'WH_ENTRY' }),
    mv({ productId: 'F', key: vanItemKey('f5'), kind: 'VAN_UNLOAD', location: 'VAN:a', toLocation: 'WH', baseQty: -5, refType: 'VAN_LOAD' }),
  ];
  const hole = stateTotals(replay(moves.slice(0, 3), CFG).state);
  assert.deepEqual(inventoryLines(hole), [['INVENTORY_WAREHOUSE', null, '-25000'], ['INVENTORY_VAN', 'a', '75000']]);
  assertPostable(hole, 50_000n);
  const final = stateTotals(replay(moves, CFG).state);
  assert.deepEqual(inventoryLines(final), [['INVENTORY_WAREHOUSE', null, '115000'], ['INVENTORY_VAN', 'a', '50000']]);
  assertPostable(final, 165_000n);
});

test('ترتيب stateTotals (compareLocations) = ترتيب سطور الافتتاح، والأصناف تُجمع في موقعها', () => {
  const moves: Move[] = [
    mv({ productId: 'P1', key: whItemKey('p1'), kind: 'RECEIVE', location: 'WH', baseQty: 10, inValueMilli: 100_000n, refType: 'WH_ENTRY' }),
    mv({ productId: 'P2', key: whItemKey('p2'), kind: 'RECEIVE', location: 'WH', baseQty: 4, inValueMilli: 33_330n, refType: 'WH_ENTRY' }),
    mv({ productId: 'P1', key: vanItemKey('p3'), kind: 'VAN_LOAD', location: 'WH', toLocation: 'VAN:r2', baseQty: -3, refType: 'VAN_LOAD' }),
    mv({ productId: 'P2', key: vanItemKey('p4'), kind: 'VAN_LOAD', location: 'WH', toLocation: 'VAN:_', baseQty: -1, refType: 'VAN_LOAD' }),
    mv({ productId: 'P1', key: vanItemKey('p5'), kind: 'VAN_LOAD', location: 'WH', toLocation: 'VAN:R1', baseQty: -2, refType: 'VAN_LOAD' }),
    mv({ productId: 'P2', key: vanItemKey('p6'), kind: 'VAN_LOAD', location: 'WH', toLocation: 'VAN:r10', baseQty: -1, refType: 'VAN_LOAD' }),
  ];
  const totals = stateTotals(replay(moves, CFG).state);
  const lines = inventoryLines(totals);
  assert.deepEqual(lines.map((l) => l[1] ?? l[0]), totals.map((t) => (t.location === 'WH' ? 'INVENTORY_WAREHOUSE' : t.location === 'VAN:_' ? 'INVENTORY_VAN' : t.location.slice(4))));
  const sum = lines.reduce((s, l) => s + BigInt(l[2] as string), 0n);
  assert.equal(sum, 133_330n, 'Σ السطور = Σ قيمة المواقع بالملّي بلا انجراف');
  assertPostable(totals, 133_330n);
});
