// «ربط الدفاتر» PV — المطابقة R8–R11 محسوبةً (FULL) بفرق صفر مستهدف حين يحمل الأستاذ قيود تدفّقها، وNOT_AVAILABLE بسببٍ
// واضح حين لا قيود لها في الظلّ بعد. المثال المحلول من الخطة (L6 «Acceptance»): وارد ١٠٠ كرتونة 2,000 + ضريبة 300 = فاتورة
// 2,300، ومرتجع للمورّد 230 = 200 + 30، ووارد غير مصنَّف 500، وتحميل سيارة 300، وتكلفة بيع 120 — بالملّي.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CostingSummary } from '../services/costing/types';
import { PARITY_NOT_AVAILABLE, R9_PERIODIC_REASON, runParity } from '../services/gl/linking/parity';
import type { GlBalanceQuery, GlBalanceView, OperationalFacts, ParityCheck, ParityCode, ParityContext } from '../services/gl/linking/types';

interface L { move: string; moveType?: string; account: string; d?: bigint; c?: bigint; salesRepId?: string; vendorId?: string }

const ACC: Record<string, string> = {
  AR_CONTROL: 'a113001', REP_CUSTODY: 'a111003', PAYLINK_CLEARING: 'a112005', OPENING_EQUITY: 'a319002', POSTING_SUSPENSE: 'a911001',
  INVENTORY_WAREHOUSE: 'a114001', INVENTORY_VAN: 'a114002', COGS: 'a511001', AP_CONTROL: 'a211001', GRNI: 'a211002', INPUT_VAT: 'a116001',
};

/** أستاذ مزيّف؛ withCount=false يحذف countLines فيُختبر الاحتياط بـlinesOn */
function gl(lines: readonly L[], withCount = true): GlBalanceView {
  const pass = (l: L, q?: GlBalanceQuery) => {
    const mt = l.moveType ?? 'ENTRY';
    if (q?.moveTypes && !q.moveTypes.includes(mt)) return false;
    if (q?.excludeMoveTypes && q.excludeMoveTypes.includes(mt)) return false;
    return true;
  };
  const net = (l: L) => (l.d ?? 0n) - (l.c ?? 0n);
  const view: GlBalanceView = {
    accountIdByKey: (k) => ACC[k] ?? null,
    balanceByPartner(ids, partner, q) {
      const out = new Map<string, bigint>();
      for (const l of lines) if (ids.includes(l.account) && pass(l, q)) {
        const k = (l as unknown as Record<string, string | undefined>)[partner] ?? '';
        out.set(k, (out.get(k) ?? 0n) + net(l));
      }
      return out;
    },
    total(ids, q) { let t = 0n; for (const l of lines) if (ids.includes(l.account) && pass(l, q)) t += net(l); return t; },
    unbalancedMoves() { return []; },
    grandTotals() { return { debitMilli: 0n, creditMilli: 0n }; },
    linesOn(id, limit) {
      return lines.filter((l) => l.account === id).slice(0, limit).map((l) => ({
        moveRef: l.move, date: '2027-02-01', moveType: l.moveType ?? 'ENTRY', sourceKey: null, needsAttention: false, attentionReason: null,
        debitMilli: l.d ?? 0n, creditMilli: l.c ?? 0n,
      }));
    },
  };
  if (withCount) view.countLines = (ids, q) => lines.filter((l) => ids.includes(l.account) && pass(l, q)).length;
  return view;
}

const OPN = { move: 'OPN/1', moveType: 'OPENING' };

/** الافتتاح وحده: مستودع 1,000 */
const openingLines = (): L[] => [{ ...OPN, account: 'a114001', d: 1_000_000n }, { ...OPN, account: 'a319002', c: 1_000_000n }];

/** المثال المحلول كاملاً فوق الافتتاح */
function workedLines(): L[] {
  return [
    ...openingLines(),
    // وارد 100 كرتونة: STOCK ثم BILL
    { move: 'WH/1', account: 'a114001', d: 2_000_000n }, { move: 'WH/1', account: 'a211002', c: 2_000_000n },
    { move: 'BILL/1', account: 'a211002', d: 2_000_000n }, { move: 'BILL/1', account: 'a116001', d: 300_000n }, { move: 'BILL/1', account: 'a211001', c: 2_300_000n, vendorId: 'v1' },
    // مرتجع للمورّد
    { move: 'RET/1', account: 'a211001', d: 230_000n, vendorId: 'v1' }, { move: 'RET/1', account: 'a114001', c: 200_000n }, { move: 'RET/1', account: 'a116001', c: 30_000n },
    // وارد مسعَّر غير مصنَّف 500 ⇒ 211002
    { move: 'WH/2', account: 'a114001', d: 500_000n }, { move: 'WH/2', account: 'a211002', c: 500_000n },
    // تحميل سيارة 300 ثم تكلفة بيع منها 120
    { move: 'VL/1', account: 'a114002', d: 300_000n, salesRepId: 'r1' }, { move: 'VL/1', account: 'a114001', c: 300_000n },
    { move: 'COGS/1', account: 'a511001', d: 120_000n }, { move: 'COGS/1', account: 'a114002', c: 120_000n, salesRepId: 'r1' },
  ];
}

function costing(over: Partial<CostingSummary> = {}): CostingSummary {
  return {
    moveCount: 6, productCount: 1,
    openingByLocation: [{ location: 'WH', qtyBase: 50, uncostedQty: 0, valueMilli: 1_000_000n }],
    nowByLocation: [{ location: 'WH', qtyBase: 150, uncostedQty: 0, valueMilli: 3_000_000n }, { location: 'VAN:r1', qtyBase: 9, uncostedQty: 0, valueMilli: 180_000n }],
    fyCogsMilli: 120_000n, fyVarianceMilli: 0n, fyWriteOffMilli: 0n,
    uncostedAtCutover: [], uncostedAtCutoverTotalQty: 0, negativeAtCutover: [], holesFy: { count: 0, varianceMilli: 0n, sample: [] }, warnings: [],
    ...over,
  };
}

function ops(over: Partial<OperationalFacts> = {}): OperationalFacts {
  return {
    arByCustomer: new Map(), arOpeningByCustomer: new Map(), custodyByRep: new Map(), settlementBalanceMilli: 0n,
    // كشف المورّد: فاتورة 2,300 − مرتجع 230
    supplierByVendor: new Map([['v1', 2_070_000n]]),
    unclassifiedPricedReceiptsFyMilli: 500_000n,
    names: { customers: new Map(), reps: new Map([['r1', 'مندوب أول']]), vendors: new Map([['v1', 'مورّد أول']]) },
    ...over,
  };
}

function ctx(over: Partial<ParityContext> = {}): ParityContext {
  return {
    linkedFrom: '2027-01-01', openingDate: '2026-12-31', currencyDecimals: 2, openingEquityDiffMilli: 1_000_000n,
    costing: costing(), heldByPartner: new Map(), inventoryMode: 'PERPETUAL', ...over,
  };
}

const run = (lines: readonly L[], o = ops(), c = ctx(), withCount = true): Map<ParityCode, ParityCheck> =>
  new Map(runParity(gl(lines, withCount), o, c).map((p) => [p.code, p]));

const R = ['R8', 'R9', 'R10', 'R11'] as const;

test('المثال المحلول: R8–R11 = OK بفرق صفر (FULL)، بالأرقام لكل موقع ومورّد — وبالاحتياط بلا countLines', () => {
  for (const withCount of [true, false]) {
    const by = run(workedLines(), ops(), ctx(), withCount);
    for (const code of R) {
      const p = by.get(code)!;
      assert.equal(p.status, 'OK', `${code} ${withCount}`);
      assert.equal(p.scope, 'FULL');
      assert.equal(p.availableIn, null);
      assert.equal(p.diffMilli, 0n);
    }
    const r8 = by.get('R8')!;
    assert.equal(r8.expectedMilli, 3_180_000n);
    assert.deepEqual(r8.drill.map((d) => [d.partnerId, d.expectedMilli, d.actualMilli, d.diffMilli]), [['VAN:r1', 180_000n, 180_000n, 0n], ['WH', 3_000_000n, 3_000_000n, 0n]]);
    assert.equal(r8.info!.openingTie, 'OK');
    assert.equal(r8.info!.mismatches, 0);
    assert.equal(r8.info!.postedLines, 6);
    assert.equal(by.get('R9')!.actualMilli, 120_000n);
    const r10 = by.get('R10')!;
    assert.equal(r10.expectedMilli, -2_070_000n);
    assert.deepEqual(r10.drill.map((d) => [d.partnerId, d.name, d.diffMilli]), [['v1', 'مورّد أول', 0n]]);
    // الوارد المصنَّف صُفّي من 211002 بالفاتورة؛ غير المصنَّف وحده دائن
    assert.equal(by.get('R11')!.expectedMilli, -500_000n);
    assert.equal(by.get('R11')!.actualMilli, -500_000n);
  }
});

test('فرق ملّي واحد ⇒ MISMATCH بفرقه وصفّه (R8 موقعاً، R9، R10 مورّداً، R11)', () => {
  const lines = workedLines();
  const by = run(lines, ops({ supplierByVendor: new Map([['v1', 2_070_001n]]), unclassifiedPricedReceiptsFyMilli: 500_001n }),
    ctx({ costing: costing({ fyCogsMilli: 120_001n, nowByLocation: [{ location: 'WH', qtyBase: 150, uncostedQty: 0, valueMilli: 3_000_001n }, { location: 'VAN:r1', qtyBase: 9, uncostedQty: 0, valueMilli: 180_000n }] }) }));
  for (const code of R) assert.equal(by.get(code)!.status, 'MISMATCH', code);
  const r8 = by.get('R8')!;
  assert.equal(r8.diffMilli, -1n);
  assert.equal(r8.drill[0].partnerId, 'WH');
  assert.equal(r8.drill[0].note, 'فرق لا يفسّره حدث محجوز');
  assert.equal(by.get('R9')!.diffMilli, -1n);
  const r10 = by.get('R10')!;
  assert.equal(r10.diffMilli, 1n);
  assert.equal(r10.drill[0].partnerId, 'v1');
  assert.equal(r10.info!.mismatches, 1);
  assert.equal(by.get('R11')!.diffMilli, 1n);
});

test('لا قيود في الظلّ بعد ونشاطٌ تشغيلي ⇒ NOT_AVAILABLE (L6) بسببه، والمتوقَّع محسوب معروض', () => {
  const by = run(openingLines());
  const r8 = by.get('R8')!;
  assert.equal(r8.status, 'NOT_AVAILABLE');
  assert.equal(r8.scope, 'OPENING_ONLY');
  assert.equal(r8.availableIn, 'L6');
  assert.equal(r8.reason, PARITY_NOT_AVAILABLE.R8!.reason);
  assert.equal(r8.expectedMilli, 3_180_000n);
  assert.equal(r8.diffMilli, null);
  assert.equal(r8.info!.openingTie, 'OK');
  assert.equal(r8.info!.postedLines, 0);
  for (const code of ['R9', 'R10', 'R11'] as const) {
    const p = by.get(code)!;
    assert.equal(p.status, 'NOT_AVAILABLE', code);
    assert.equal(p.availableIn, 'L6', code);
    assert.equal(p.reason, PARITY_NOT_AVAILABLE[code]!.reason, code);
    assert.equal(p.diffMilli, null);
    assert.ok(!('reasonCode' in p), code);
  }
  assert.equal(PARITY_NOT_AVAILABLE.R9!.reason, 'قيد تكلفة المبيعات يُضاف مع قيود المخزون في L6');
  assert.equal(by.get('R9')!.expectedMilli, 120_000n);
  assert.equal(by.get('R10')!.expectedMilli, -2_070_000n);
  assert.equal(by.get('R11')!.expectedMilli, -500_000n);
});

test('لا نشاط تشغيلياً (لا موردين ولا وارد غير مصنَّف ولا حركة مخزون في السنة) ⇒ FULL OK بلا قيود: صفر = صفر', () => {
  const still = costing({ nowByLocation: [{ location: 'WH', qtyBase: 50, uncostedQty: 0, valueMilli: 1_000_000n }], fyCogsMilli: 0n });
  const by = run(openingLines(), ops({ supplierByVendor: new Map(), unclassifiedPricedReceiptsFyMilli: 0n }), ctx({ costing: still }));
  for (const code of R) {
    const p = by.get(code)!;
    assert.equal(p.status, 'OK', code);
    assert.equal(p.scope, 'FULL', code);
    assert.equal(p.diffMilli, 0n, code);
  }
  assert.equal(by.get('R8')!.expectedMilli, 1_000_000n);
  // مورّد رصيده صفر (فاتورة ثم سداد) ليس نشاطاً منتظراً: FULL ويطابق 211001 الفارغ
  assert.equal(run(openingLines(), ops({ supplierByVendor: new Map([['v1', 0n]]) })).get('R10')!.status, 'OK');
});

test('الجرد الدوري: R9 لا ينطبق (availableIn = null بسببه، بلا رمز سبب)، وR8 كما كان INVENTORY_PERIODIC', () => {
  const by = run(workedLines(), ops(), ctx({ inventoryMode: 'PERIODIC' }));
  const r9 = by.get('R9')!;
  assert.equal(r9.status, 'NOT_AVAILABLE');
  assert.equal(r9.availableIn, null);
  assert.equal(r9.reason, R9_PERIODIC_REASON);
  assert.ok(!('reasonCode' in r9));
  assert.equal(r9.expectedMilli, 120_000n);
  assert.equal(by.get('R8')!.reasonCode, 'INVENTORY_PERIODIC');
  // المشتريات لا تتعلّق بنوع الجرد
  assert.equal(by.get('R10')!.status, 'OK');
  assert.equal(by.get('R11')!.status, 'OK');
});

test('قيود المشتريات وحدها (بلا مخزون): R10/R11 FULL، وR8/R9 باقيان NOT_AVAILABLE حتى تُرحَّل حركات المخزون', () => {
  const lines: L[] = [
    ...openingLines(),
    { move: 'BILL/9', account: 'a211002', d: 0n, c: 0n },
    { move: 'BILL/9', account: 'a211001', c: 2_070_000n, vendorId: 'v1' }, { move: 'BILL/9', account: 'a116001', d: 2_070_000n },
    { move: 'G/1', account: 'a211002', c: 500_000n }, { move: 'G/1', account: 'a116001', d: 500_000n },
  ];
  const by = run(lines);
  assert.equal(by.get('R10')!.status, 'OK');
  assert.equal(by.get('R11')!.status, 'OK');
  assert.equal(by.get('R8')!.status, 'NOT_AVAILABLE');
  assert.equal(by.get('R9')!.status, 'NOT_AVAILABLE');
});
