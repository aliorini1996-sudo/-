// «ربط الدفاتر» L2 (P4) — المطابقة runParity وcompareByPartner (صرفة): كل R بحالاته (OK، فرق ملّي واحد ⇒ MISMATCH،
// NOT_AVAILABLE بمرحلته وسببه والمتوقَّع محسوباً لـR8–R11)، والتعمّق (فرز |الفرق| ثم المعرّف، القصّ عند 200، الأسماء،
// والمراجع من الأحداث المحجوزة)، والحتمية. حقائق التشغيل من القاعدة في p4-parity-facts.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CostingSummary, LocationKey } from '../services/costing/types';
import {
  PARITY_NOT_AVAILABLE, PARITY_REFS_PER_ROW, PARITY_TITLES, R8_NO_COSTING_REASON, R8_PERIODIC_REASON,
  capDrill, compareByPartner, runParity,
} from '../services/gl/linking/parity';
import {
  PARITY_CODES, PREVIEW_LIST_CAPS,
  type GlBalanceQuery, type GlBalanceView, type OperationalFacts, type ParityCheck, type ParityCode, type ParityContext,
} from '../services/gl/linking/types';
import { IMPORT_AFTER_CUTOVER_ATTENTION_REASON } from '../services/gl/sync/types';

// ═══ أستاذ مزيّف (GlBalanceView) ═══

interface FLine {
  move: string;
  moveType?: string;
  date?: string;
  sourceKey?: string | null;
  attention?: string | null;
  account: string;
  d?: bigint;
  c?: bigint;
  customerId?: string | null;
  salesRepId?: string | null;
  vendorId?: string | null;
}

const ACCOUNTS: Record<string, string> = {
  AR_CONTROL: 'a113001', REP_CUSTODY: 'a111003', PAYLINK_CLEARING: 'a112005', OPENING_EQUITY: 'a319002',
  INVENTORY_WAREHOUSE: 'a114001', INVENTORY_VAN: 'a114002', COGS: 'a511001', AP_CONTROL: 'a211001', GRNI: 'a211002',
  POSTING_SUSPENSE: 'a911001', MAIN_CASH: 'a111001', SALES_REVENUE: 'a411001',
};

function fakeGl(lines: readonly FLine[], accounts: Record<string, string> = ACCOUNTS): GlBalanceView {
  const pass = (l: FLine, q?: GlBalanceQuery) => {
    if (!q) return true;
    const mt = l.moveType ?? 'ENTRY';
    if (q.upTo && (l.date ?? '2027-01-01') > q.upTo) return false;
    if (q.moveTypes && !q.moveTypes.includes(mt)) return false;
    if (q.excludeMoveTypes && q.excludeMoveTypes.includes(mt)) return false;
    return true;
  };
  const net = (l: FLine) => (l.d ?? 0n) - (l.c ?? 0n);
  return {
    accountIdByKey: (k) => accounts[k] ?? null,
    balanceByPartner(ids, partner, q) {
      const out = new Map<string, bigint>();
      for (const l of lines) {
        if (!ids.includes(l.account) || !pass(l, q)) continue;
        const k = l[partner] ?? '';
        out.set(k, (out.get(k) ?? 0n) + net(l));
      }
      return out;
    },
    total(ids, q) {
      let t = 0n;
      for (const l of lines) if (ids.includes(l.account) && pass(l, q)) t += net(l);
      return t;
    },
    unbalancedMoves() {
      const by = new Map<string, { d: bigint; c: bigint; sk: string | null }>();
      for (const l of lines) {
        const m = by.get(l.move) ?? { d: 0n, c: 0n, sk: l.sourceKey ?? null };
        m.d += l.d ?? 0n;
        m.c += l.c ?? 0n;
        by.set(l.move, m);
      }
      return [...by].filter(([, m]) => m.d !== m.c).map(([moveRef, m]) => ({ moveRef, sourceKey: m.sk, debitMilli: m.d, creditMilli: m.c }));
    },
    grandTotals() {
      let d = 0n;
      let c = 0n;
      for (const l of lines) { d += l.d ?? 0n; c += l.c ?? 0n; }
      return { debitMilli: d, creditMilli: c };
    },
    linesOn(accountId, limit) {
      return lines.filter((l) => l.account === accountId).slice(0, limit).map((l) => ({
        moveRef: l.move, date: l.date ?? '2027-01-01', moveType: l.moveType ?? 'ENTRY', sourceKey: l.sourceKey ?? null,
        needsAttention: !!l.attention, attentionReason: l.attention ?? null, debitMilli: l.d ?? 0n, creditMilli: l.c ?? 0n,
      }));
    },
  };
}

// ═══ سيناريو متوازن (ريال، منزلتان) ═══

const OPN = { move: 'OPN/1', moveType: 'OPENING', date: '2026-12-31' };
const MARK = IMPORT_AFTER_CUTOVER_ATTENTION_REASON;

/** الافتتاح: ذمم ع1 100، عهدة م1 25، مستودع 50، سيارة م1 20، نقد يدوي 1000 ⇒ 319002 دائن 1195 */
function baseLines(): FLine[] {
  return [
    { ...OPN, account: 'a113001', d: 100_000n, customerId: 'c1' },
    { ...OPN, account: 'a111003', d: 25_000n, salesRepId: 'r1' },
    { ...OPN, account: 'a114001', d: 50_000n },
    { ...OPN, account: 'a114002', d: 20_000n, salesRepId: 'r1' },
    { ...OPN, account: 'a111001', d: 1_000_000n },
    { ...OPN, account: 'a319002', c: 1_195_000n },
    // بيع آجل لـع1 57.50
    { move: 'INV/1', moveType: 'ENTRY', sourceKey: 'INVOICE:i1:POST', account: 'a113001', d: 57_500n, customerId: 'c1' },
    { move: 'INV/1', moveType: 'ENTRY', sourceKey: 'INVOICE:i1:POST', account: 'a411001', c: 57_500n },
    // سند نقدي بمندوب 40 ⇒ عهدة
    { move: 'RCP/1', sourceKey: 'RECEIPT:r1:POST', account: 'a111003', d: 40_000n, salesRepId: 'r1' },
    { move: 'RCP/1', sourceKey: 'RECEIPT:r1:POST', account: 'a113001', c: 40_000n, customerId: 'c1' },
    // استيراد بعد البدء ⇒ 319002 معلَّم
    { move: 'IMP/1', moveType: 'IMPORT', sourceKey: 'AR_ENTRY:ae9:POST', attention: MARK, account: 'a113001', d: 120_000n, customerId: 'c2' },
    { move: 'IMP/1', moveType: 'IMPORT', sourceKey: 'AR_ENTRY:ae9:POST', attention: MARK, account: 'a319002', c: 120_000n },
    // سند إلكتروني 24.36 ⇒ أمانات
    { move: 'RCP/2', sourceKey: 'RECEIPT:r2:POST', account: 'a112005', d: 24_360n },
    { move: 'RCP/2', sourceKey: 'RECEIPT:r2:POST', account: 'a113001', c: 24_360n, customerId: 'c2' },
  ];
}

function baseOps(): OperationalFacts {
  return {
    arByCustomer: new Map([['c1', 117_500n], ['c2', 95_640n]]),
    arOpeningByCustomer: new Map([['c1', 100_000n]]),
    custodyByRep: new Map([['r1', { ledgerCustodyMilli: 65_000n, opsOutstandingMilli: 70_000n }]]),
    settlementBalanceMilli: 24_360n,
    supplierByVendor: new Map([['v1', 300_000n], ['v2', -5_000n]]),
    unclassifiedPricedReceiptsFyMilli: 50_000n,
    names: {
      customers: new Map([['c1', 'عميل أول'], ['c2', 'عميل ثانٍ']]),
      reps: new Map([['r1', 'مندوب أول']]),
      vendors: new Map([['v1', 'مورّد أول']]),
    },
  };
}

function summary(over: Partial<CostingSummary> = {}): CostingSummary {
  return {
    moveCount: 9, productCount: 2,
    openingByLocation: [{ location: 'WH', qtyBase: 10, uncostedQty: 0, valueMilli: 50_000n }, { location: 'VAN:r1', qtyBase: 4, uncostedQty: 0, valueMilli: 20_000n }],
    nowByLocation: [
      { location: 'WH', qtyBase: 6, uncostedQty: 0, valueMilli: 30_000n }, { location: 'VAN:r1', qtyBase: 7, uncostedQty: 0, valueMilli: 35_000n },
      { location: 'VAN:_', qtyBase: 1, uncostedQty: 0, valueMilli: 5_000n },
    ],
    fyCogsMilli: 12_345n, fyVarianceMilli: 6_000n, fyWriteOffMilli: 3_000n,
    uncostedAtCutover: [], uncostedAtCutoverTotalQty: 0, negativeAtCutover: [],
    holesFy: { count: 0, varianceMilli: 0n, sample: [] }, warnings: [],
    ...over,
  };
}

function baseCtx(over: Partial<ParityContext> = {}): ParityContext {
  return {
    linkedFrom: '2027-01-01', openingDate: '2026-12-31', currencyDecimals: 2, openingEquityDiffMilli: 1_195_000n,
    costing: summary(), heldByPartner: new Map(), inventoryMode: 'PERPETUAL', ...over,
  };
}

function run(lines = baseLines(), ops = baseOps(), ctx = baseCtx()): Map<ParityCode, ParityCheck> {
  const out = runParity(fakeGl(lines), ops, ctx);
  return new Map(out.map((p) => [p.code, p]));
}

// ═══ الشكل العام ═══

test('runParity: R1..R13 بالترتيب بعناوينها، والمتاح الآن (R1 R2 R3 R5) = OK على أستاذ مطابق', () => {
  const out = runParity(fakeGl(baseLines()), baseOps(), baseCtx());
  assert.deepEqual(out.map((p) => p.code), [...PARITY_CODES]);
  for (const p of out) assert.equal(p.titleAr, PARITY_TITLES[p.code]);
  const by = new Map(out.map((p) => [p.code, p]));
  for (const code of ['R1', 'R2', 'R3', 'R5'] as const) {
    const p = by.get(code)!;
    assert.equal(p.status, 'OK', code);
    assert.equal(p.scope, 'FULL');
    assert.equal(p.diffMilli, 0n);
    assert.equal(p.availableIn, null);
  }
  assert.equal(by.get('R2')!.expectedMilli, 213_140n);
  assert.equal(by.get('R3')!.expectedMilli, 65_000n);
  assert.equal(by.get('R5')!.actualMilli, 24_360n);
});

test('NOT_AVAILABLE: R4 وR6 وR7 وR12 وR13 بمرحلتها وسببها وبلا أرقام', () => {
  const by = run();
  const want: Record<string, [string, string]> = {
    R4: ['L5', 'عهدة المستخدمين 111004 تُضاف في L5'],
    R6: ['L4', 'مطابقة صافي المبيعات الشهري تُضاف في L4'],
    R7: ['L4', 'ضريبة المخرجات بالفترة والمربع من المستندات تُضاف في L4'],
    R12: ['L6', 'سجلّ ضريبة المشتريات يُضاف في L6'],
    R13: ['L7', 'اكتمال الترحيل وخلوّ 911001 يُحسم عند الاعتماد'],
  };
  for (const [code, [stage, reason]] of Object.entries(want)) {
    const p = by.get(code as ParityCode)!;
    assert.equal(p.status, 'NOT_AVAILABLE', code);
    assert.equal(p.availableIn, stage);
    assert.equal(p.reason, reason);
    assert.equal(p.scope, 'NONE');
    assert.equal(p.expectedMilli, null);
    assert.equal(p.diffMilli, null);
    assert.deepEqual(p.drill, []);
  }
  assert.equal(by.get('R13')!.info!.suspenseMilli, '0');
  for (const code of ['R8', 'R9', 'R10', 'R11'] as const) assert.equal(by.get(code)!.availableIn, PARITY_NOT_AVAILABLE[code]!.availableIn);
});

// ═══ R1 ═══

test('R1: 319002 = −فرق الافتتاح + الاستيراد المعلَّم، ومعه عكسه بشقيقه (REVERSE لا يحمل العلامة)', () => {
  const p = run().get('R1')!;
  assert.equal(p.expectedMilli, -1_315_000n);
  assert.equal(p.actualMilli, -1_315_000n);
  assert.equal(p.info!.importAfterCutoverMilli, '-120000');
  assert.equal(p.info!.importAfterCutoverMoves, 1);
  assert.equal(p.info!.openingLedgerMilli, '-1195000');
  assert.equal(p.info!.grandDebitMilli, p.info!.grandCreditMilli);

  const reversed = [
    ...baseLines(),
    { move: 'IMP/1R', moveType: 'IMPORT', sourceKey: 'AR_ENTRY:ae9:REVERSE', account: 'a113001', c: 120_000n, customerId: 'c2' },
    { move: 'IMP/1R', moveType: 'IMPORT', sourceKey: 'AR_ENTRY:ae9:REVERSE', account: 'a319002', d: 120_000n },
  ];
  const ops = baseOps();
  ops.arByCustomer.set('c2', 95_640n - 120_000n);
  const q = run(reversed, ops).get('R1')!;
  assert.equal(q.status, 'OK');
  assert.equal(q.info!.importAfterCutoverMilli, '0');
  assert.equal(q.info!.importAfterCutoverMoves, 2);
  assert.deepEqual(q.drill, []);
});

test('R1: فرق ملّي واحد في فرق الافتتاح ⇒ MISMATCH بصفّ «القيد الافتتاحي»', () => {
  const p = run(baseLines(), baseOps(), baseCtx({ openingEquityDiffMilli: 1_195_001n })).get('R1')!;
  assert.equal(p.status, 'MISMATCH');
  assert.equal(p.diffMilli, 1n);
  assert.equal(p.drill.length, 1);
  assert.deepEqual(
    { t: p.drill[0].partnerType, id: p.drill[0].partnerId, e: p.drill[0].expectedMilli, a: p.drill[0].actualMilli, d: p.drill[0].diffMilli },
    { t: 'ACCOUNT', id: 'OPENING', e: -1_195_001n, a: -1_195_000n, d: 1n },
  );
});

test('R1: قيد غير متوازن (ولو بملّي) ⇒ MISMATCH بصفّه ومرجعه، وصفّ الميزان', () => {
  const lines = [
    ...baseLines(),
    { move: 'BAD/1', sourceKey: 'INVOICE:i9:POST', account: 'a113001', d: 10_001n, customerId: 'c1' },
    { move: 'BAD/1', sourceKey: 'INVOICE:i9:POST', account: 'a411001', c: 10_000n },
  ];
  const ops = baseOps();
  ops.arByCustomer.set('c1', 117_500n + 10_001n);
  const p = run(lines, ops).get('R1')!;
  assert.equal(p.status, 'MISMATCH');
  assert.equal(p.info!.unbalancedMoves, 1);
  const move = p.drill.find((r) => r.partnerType === 'MOVE')!;
  assert.equal(move.partnerId, 'BAD/1');
  assert.equal(move.diffMilli, -1n);
  assert.deepEqual(move.refs, ['INVOICE:i9:POST']);
  const grand = p.drill.find((r) => r.partnerType === 'ACCOUNT')!;
  assert.equal(grand.name, 'ميزان المراجعة');
  assert.equal(grand.diffMilli, -1n);
  // الرصيد 319002 نفسه مطابق: الخلل في التوازن وحده
  assert.equal(p.expectedMilli, p.actualMilli);
});

test('R1: قيد آخر على 319002 (استيراد وصل متأخراً بلا علامة) ⇒ MISMATCH بصفّ القيد وملاحظته', () => {
  const lines = [
    ...baseLines(),
    { move: 'IMP/2', moveType: 'IMPORT', sourceKey: 'AR_ENTRY:ae7:POST', account: 'a113001', d: 30_000n, customerId: 'c1' },
    { move: 'IMP/2', moveType: 'IMPORT', sourceKey: 'AR_ENTRY:ae7:POST', account: 'a319002', c: 30_000n },
  ];
  const p = run(lines).get('R1')!;
  assert.equal(p.status, 'MISMATCH');
  assert.equal(p.diffMilli, -30_000n);
  assert.equal(p.info!.otherMilli, '-30000');
  assert.equal(p.drill[0].partnerId, 'IMP/2');
  assert.match(p.drill[0].note!, /وصل متأخراً/);
  assert.deepEqual(p.drill[0].refs, ['AR_ENTRY:ae7:POST']);
  // قيدان آخران يتصافيان ⇒ الرصيد مطابق ولا صفوف
  const pair = [
    ...baseLines(),
    { move: 'X/1', sourceKey: null, account: 'a319002', d: 5_000n }, { move: 'X/1', sourceKey: null, account: 'a111001', c: 5_000n },
    { move: 'X/2', sourceKey: null, account: 'a319002', c: 5_000n }, { move: 'X/2', sourceKey: null, account: 'a111001', d: 5_000n },
  ];
  const q = run(pair).get('R1')!;
  assert.equal(q.status, 'OK');
  assert.deepEqual(q.drill, []);
});

// ═══ R2 ═══

test('R2: فرق ملّي واحد لعميل ⇒ MISMATCH، والتعمّق باسمه، ومراجع الحدث المحجوز أو «لا يفسّره»', () => {
  const ops = baseOps();
  ops.arByCustomer.set('c1', 117_501n);
  const p = run(baseLines(), ops).get('R2')!;
  assert.equal(p.status, 'MISMATCH');
  assert.equal(p.diffMilli, -1n);
  assert.equal(p.info!.mismatches, 1);
  assert.equal(p.drill[0].partnerId, 'c1');
  assert.equal(p.drill[0].name, 'عميل أول');
  assert.equal(p.drill[0].partnerType, 'CUSTOMER');
  assert.equal(p.drill[0].diffMilli, -1n);
  assert.equal(p.drill[0].note, 'فرق لا يفسّره حدث محجوز');
  assert.equal(p.drill[0].refs, undefined);
  // العميل المطابق في التعمّق بفرق صفر بعده
  assert.equal(p.drill[1].partnerId, 'c2');
  assert.equal(p.drill[1].diffMilli, 0n);
  assert.equal(p.drill[1].note, null);

  const held = run(baseLines(), ops, baseCtx({ heldByPartner: new Map([['c1', ['INVOICE:i5:POST']], ['c2', ['RECEIPT:x:POST']]]) })).get('R2')!;
  assert.deepEqual(held.drill[0].refs, ['INVOICE:i5:POST']);
  assert.equal(held.drill[0].note, 'يفسّره 1 حدث محجوز');
  // لا مراجع لصفّ بلا فرق
  assert.equal(held.drill[1].refs, undefined);
});

test('R2: الفحص الفرعي — سطور الافتتاح لكل عميل ≠ صفوفه المشمولة ⇒ MISMATCH ولو تطابق الإجمالي', () => {
  const ops = baseOps();
  ops.arOpeningByCustomer.set('c1', 100_010n);
  const p = run(baseLines(), ops).get('R2')!;
  assert.equal(p.status, 'MISMATCH');
  assert.equal(p.diffMilli, 0n);
  assert.equal(p.info!.mismatches, 0);
  assert.equal(p.info!.openingMismatches, 1);
  assert.equal(p.info!.openingDiffMilli, '-10');
  const row = p.drill[0];
  assert.equal(row.partnerId, 'c1');
  assert.equal(row.diffMilli, -10n);
  assert.match(row.note!, /^القيد الافتتاحي/);
});

test('R2: سطر ذمم بلا عميل ⇒ صفّ بلا معرّف باسمه، وحساب غير مربوط ⇒ accountMissing ورصيد صفر', () => {
  const lines = [
    ...baseLines(),
    { move: 'J/1', account: 'a113001', d: 7_000n }, { move: 'J/1', account: 'a111001', c: 7_000n },
  ];
  const p = run(lines).get('R2')!;
  assert.equal(p.status, 'MISMATCH');
  assert.equal(p.drill[0].partnerId, null);
  assert.equal(p.drill[0].name, 'سطور ذمم بلا عميل');
  assert.match(p.drill[0].note!, /بلا شريك/);

  const { AR_CONTROL: _drop, ...noAr } = ACCOUNTS;
  const out = runParity(fakeGl(baseLines(), noAr), baseOps(), baseCtx());
  const q = out.find((x) => x.code === 'R2')!;
  assert.equal(q.status, 'MISMATCH');
  assert.equal(q.actualMilli, 0n);
  assert.equal(q.info!.accountMissing, 'AR_CONTROL');
});

// ═══ R3 وR5 ═══

test('R3: فرق ملّي واحد لمندوب ⇒ MISMATCH، وinfo الشاشة − الدفاتر (C4b)', () => {
  const ok = run().get('R3')!;
  assert.equal(ok.info!.opsOutstandingMilli, '70000');
  assert.equal(ok.info!.screenMinusLedgerMilli, '5000');
  const ops = baseOps();
  ops.custodyByRep.set('r1', { ledgerCustodyMilli: 64_999n, opsOutstandingMilli: 70_000n });
  const p = run(baseLines(), ops).get('R3')!;
  assert.equal(p.status, 'MISMATCH');
  assert.equal(p.diffMilli, 1n);
  assert.equal(p.drill[0].partnerType, 'REP');
  assert.equal(p.drill[0].name, 'مندوب أول');
});

test('R5: فرق ملّي واحد في الأمانات ⇒ MISMATCH', () => {
  const ops = baseOps();
  ops.settlementBalanceMilli = 24_359n;
  const p = run(baseLines(), ops).get('R5')!;
  assert.equal(p.status, 'MISMATCH');
  assert.equal(p.expectedMilli, 24_359n);
  assert.equal(p.diffMilli, 1n);
});

// ═══ R8–R11 ═══

test('R8: NOT_AVAILABLE (L6، OPENING_ONLY) بالمتوقَّع الآن لكل موقع وأسمائه، وربط الافتتاح OK', () => {
  const p = run().get('R8')!;
  assert.equal(p.status, 'NOT_AVAILABLE');
  assert.equal(p.availableIn, 'L6');
  assert.equal(p.reason, 'قيود حركات المخزون تُضاف في L6');
  assert.equal(p.scope, 'OPENING_ONLY');
  assert.equal(p.expectedMilli, 70_000n);
  assert.equal(p.actualMilli, 70_000n);
  assert.equal(p.diffMilli, null);
  assert.equal(p.info!.openingTie, 'OK');
  assert.equal(p.info!.openingMismatches, 0);
  const names = new Map(p.drill.map((r) => [r.partnerId, r.name]));
  assert.equal(names.get('WH'), 'المستودع');
  assert.equal(names.get('VAN:r1'), 'سيارة — مندوب أول');
  assert.equal(names.get('VAN:_'), 'سيارات غير معروفة');
  // المتوقَّع الآن والأستاذ (الافتتاح وحده بعد) لكل موقع؛ الأكبر فرقاً أولاً
  assert.deepEqual(p.drill.map((r) => [r.partnerId, r.expectedMilli, r.actualMilli]), [
    ['WH', 30_000n, 50_000n], ['VAN:r1', 35_000n, 20_000n], ['VAN:_', 5_000n, 0n],
  ]);
});

test('R8: سطر افتتاح موقع ≠ محرّك التكلفة بملّي ⇒ openingTie MISMATCH وصفّه بالمبلغين، والحالة باقية NOT_AVAILABLE', () => {
  const ctx = baseCtx({ costing: summary({ openingByLocation: [{ location: 'WH', qtyBase: 10, uncostedQty: 0, valueMilli: 50_001n }, { location: 'VAN:r1', qtyBase: 4, uncostedQty: 0, valueMilli: 20_000n }] }) });
  const p = run(baseLines(), baseOps(), ctx).get('R8')!;
  assert.equal(p.status, 'NOT_AVAILABLE');
  assert.equal(p.info!.openingTie, 'MISMATCH');
  assert.equal(p.info!.openingDiffMilli, '-1');
  const row = p.drill.find((r) => r.note?.startsWith('القيد الافتتاحي'))!;
  assert.equal(row.partnerId, 'WH');
  assert.equal(row.note, 'القيد الافتتاحي — المتوقَّع 50.001 والأستاذ 50.00');
  assert.equal(row.diffMilli, -1n);
});

test('R8: المخزون الدوري ⇒ NONE بلا مرحلة ولا ربط افتتاح؛ وبلا ملخّص تكلفة ⇒ لا متوقَّع', () => {
  const p = run(baseLines(), baseOps(), baseCtx({ inventoryMode: 'PERIODIC' })).get('R8')!;
  assert.equal(p.status, 'NOT_AVAILABLE');
  assert.equal(p.scope, 'NONE');
  assert.equal(p.availableIn, null);
  assert.equal(p.reason, R8_PERIODIC_REASON);
  assert.equal(p.reasonCode, 'INVENTORY_PERIODIC', 'رمز آلي تترجمه الواجهة «لا ينطبق: جرد دوري» بدل «يُضاف في L6»');
  assert.equal(p.info!.openingTie, null);
  assert.equal(p.expectedMilli, 70_000n);
  // المستمرّ يبقى «يُضاف في L6» بلا رمز سبب، وبقية الفحوص لا تحمل المفتاح أصلاً
  const perpetual = run(baseLines(), baseOps(), baseCtx()).get('R8')!;
  assert.equal(perpetual.availableIn, 'L6');
  assert.ok(!('reasonCode' in perpetual));
  for (const c of run(baseLines(), baseOps(), baseCtx({ inventoryMode: 'PERIODIC' })).values()) {
    if (c.code !== 'R8') assert.ok(!('reasonCode' in c), c.code);
  }

  const q = run(baseLines(), baseOps(), baseCtx({ costing: null })).get('R8')!;
  assert.equal(q.scope, 'NONE');
  assert.equal(q.reason, R8_NO_COSTING_REASON);
  assert.ok(!('reasonCode' in q), 'بلا ملخّص تكلفة: مؤجَّل لا «لا ينطبق»');
  assert.equal(q.expectedMilli, null);
  assert.equal(q.actualMilli, 70_000n);
});

test('R9: المتوقَّع = fyCogsMilli، والفعلي من 511001؛ وبلا ملخّص ⇒ null', () => {
  const lines = [...baseLines(), { move: 'C/1', account: 'a511001', d: 2_000n }, { move: 'C/1', account: 'a114001', c: 2_000n }];
  const p = run(lines).get('R9')!;
  assert.equal(p.status, 'NOT_AVAILABLE');
  assert.equal(p.availableIn, 'L4');
  assert.equal(p.expectedMilli, 12_345n);
  assert.equal(p.actualMilli, 2_000n);
  assert.equal(p.diffMilli, null);
  assert.equal(p.info!.fyVarianceMilli, '6000');
  assert.equal(run(baseLines(), baseOps(), baseCtx({ costing: null })).get('R9')!.expectedMilli, null);
});

test('R10 وR11: المتوقَّع بإشارة الأستاذ (الدائن سالب) لكل مورّد وبأسمائهم، والوارد غير المصنَّف', () => {
  const lines = [...baseLines(), { move: 'B/1', account: 'a211001', c: 300_000n, vendorId: 'v1' }, { move: 'B/1', account: 'a114001', d: 300_000n }];
  const by = run(lines);
  const r10 = by.get('R10')!;
  assert.equal(r10.status, 'NOT_AVAILABLE');
  assert.equal(r10.availableIn, 'L6');
  assert.equal(r10.expectedMilli, -295_000n);
  assert.equal(r10.actualMilli, -300_000n);
  assert.equal(r10.info!.vendors, 2);
  const v1 = r10.drill.find((r) => r.partnerId === 'v1')!;
  assert.equal(v1.name, 'مورّد أول');
  assert.equal(v1.expectedMilli, -300_000n);
  assert.equal(v1.diffMilli, 0n);
  const v2 = r10.drill.find((r) => r.partnerId === 'v2')!;
  assert.equal(v2.name, null);
  assert.equal(v2.expectedMilli, 5_000n);
  assert.equal(v2.note, null, 'غير المتاح لا يُعلَّم «لا يفسّره حدث محجوز»');

  const r11 = by.get('R11')!;
  assert.equal(r11.expectedMilli, -50_000n);
  assert.equal(r11.actualMilli, 0n);
  assert.equal(r11.info!.unclassifiedPricedReceiptsFyMilli, '50000');
});

// ═══ التعمّق ═══

test('compareByPartner: فرز |الفرق| تنازلياً ثم المعرّف، والقصّ عند 200 مع العدّ، والصفوف الصفرية لا تظهر', () => {
  const expected = new Map<string, bigint>();
  const actual = new Map<string, bigint>();
  for (let i = 0; i < 250; i++) {
    const id = `c${String(i).padStart(3, '0')}`;
    expected.set(id, 1_000n);
    // فروق متكرّرة القيمة (موجبة وسالبة) لاختبار كسر التعادل بالمعرّف
    actual.set(id, 1_000n + BigInt((i % 7) - 3) * 10n);
  }
  expected.set('zero', 0n);
  actual.set('zero', 0n);
  const r = compareByPartner(expected, actual, { partnerType: 'CUSTOMER' });
  assert.equal(r.drill.length, PREVIEW_LIST_CAPS.drillRows);
  assert.equal(r.truncated, 50);
  assert.equal(r.mismatches, 250 - Math.ceil(250 / 7));
  assert.ok(!r.drill.some((x) => x.partnerId === 'zero'));
  for (let i = 1; i < r.drill.length; i++) {
    const a = r.drill[i - 1];
    const b = r.drill[i];
    const da = a.diffMilli < 0n ? -a.diffMilli : a.diffMilli;
    const db = b.diffMilli < 0n ? -b.diffMilli : b.diffMilli;
    assert.ok(da > db || (da === db && a.partnerId! < b.partnerId!), `${a.partnerId} قبل ${b.partnerId}`);
  }
  assert.equal(r.drill[0].partnerId, 'c000');
  assert.equal(r.expectedMilli, 250_000n);
  assert.equal(r.diffMilli, r.actualMilli - r.expectedMilli);
});

test('compareByPartner: مراجع المحجوز حتى 20 لكل صفّ مع العدد الكامل في الملاحظة، والأسماء البديلة', () => {
  const held = new Map([['r1', Array.from({ length: 30 }, (_, i) => `SETTLEMENT:s${String(i).padStart(2, '0')}:POST`)]]);
  const r = compareByPartner(new Map([['r1', 5n]]), new Map([['r1', 0n]]), {
    partnerType: 'REP', heldByPartner: held, nameOf: (k) => `مندوب ${k}`, cap: 5,
  });
  assert.equal(r.drill[0].refs!.length, PARITY_REFS_PER_ROW);
  assert.equal(r.drill[0].refs![0], 'SETTLEMENT:s00:POST');
  assert.match(r.drill[0].note!, /30 حدث محجوز/);
  assert.equal(r.drill[0].name, 'مندوب r1');
  assert.deepEqual(capDrill(r.drill, 0), { drill: [], truncated: 1 });
});

test('الحتمية: ترتيب إدراج الخرائط لا يغيّر الناتج حرفياً', () => {
  const a = runParity(fakeGl(baseLines()), baseOps(), baseCtx({ heldByPartner: new Map([['c1', ['A']], ['r1', ['B']]]) }));
  const ops = baseOps();
  const rev = <K, V>(m: Map<K, V>) => new Map([...m].reverse());
  const reversed: OperationalFacts = {
    ...ops,
    arByCustomer: rev(ops.arByCustomer), arOpeningByCustomer: rev(ops.arOpeningByCustomer), supplierByVendor: rev(ops.supplierByVendor),
    custodyByRep: rev(ops.custodyByRep),
  };
  const s = summary();
  const ctx = baseCtx({
    heldByPartner: new Map([['r1', ['B']], ['c1', ['A']]]),
    costing: { ...s, nowByLocation: [...s.nowByLocation].reverse(), openingByLocation: [...s.openingByLocation].reverse() },
  });
  const b = runParity(fakeGl([...baseLines()].reverse()), reversed, ctx);
  assert.deepEqual(b, a);
});

test('R8: موقع مكرّر في الملخّص يُجمع، ومفتاح موقع سيارة بمندوب محذوف يطابق 114002 بمعرّفه', () => {
  const loc = (l: string) => l as LocationKey;
  const ctx = baseCtx({
    costing: summary({
      openingByLocation: [{ location: 'WH', qtyBase: 1, uncostedQty: 0, valueMilli: 30_000n }, { location: 'WH', qtyBase: 1, uncostedQty: 0, valueMilli: 20_000n }, { location: loc('VAN:r1'), qtyBase: 4, uncostedQty: 0, valueMilli: 20_000n }],
      nowByLocation: [{ location: loc('VAN:gone'), qtyBase: 1, uncostedQty: 0, valueMilli: 9_000n }],
    }),
  });
  const lines = [...baseLines(), { move: 'V/9', account: 'a114002', d: 9_000n, salesRepId: 'gone' }, { move: 'V/9', account: 'a114001', c: 9_000n }];
  const p = run(lines, baseOps(), ctx).get('R8')!;
  assert.equal(p.info!.openingTie, 'OK');
  const gone = p.drill.find((r) => r.partnerId === 'VAN:gone')!;
  assert.equal(gone.actualMilli, 9_000n);
  assert.equal(gone.name, 'سيارة — مندوب gone');
});
