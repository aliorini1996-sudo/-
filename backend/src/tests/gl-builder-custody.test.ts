// M1 — العهدة: P5 بالطرق، P7 الاستلام وP8 حذفه، وcustody.ts → custodyComponents مع C4 وC4b
// (DESIGN.md §5.5 P5/P7/P8/P27 والدالة المشتركة، §5.8، §5.9 C4/C4b، §10.1 gl-builder-custody.test.ts، §10.3 D3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReceiptMove, type ReceiptPostPayload } from '../services/gl/builders/receipt';
import {
  buildSettlementMove, buildSettlementReversalMove, settlementKey, type SettlementPayload,
} from '../services/gl/builders/custody';
import {
  custodyC4bGap, custodyC4Gap, custodyComponents, custodyComponentsForRep, receiptCustodyClass, settlementInputsFrom,
  settlementSplit, type CustodyComponentsInput, type CustodyItem, type CustodySettlementItem, type CustodyShortageItem,
} from '../services/gl/custody';
import { saContext } from '../services/gl/testing/fixtures';
import { resolveLineAccount, validateMove } from '../services/gl/validate';
import { isNoMove, type BuildContext, type BuildResult, type MoveDraft, type ReceiptRouting } from '../services/gl/types';

const ARABIC = /[؀-ۿ]/;
const ROUTING: ReceiptRouting = { CASH: 'CUSTODY', BANK_TRANSFER: 'CUSTODY', POS: 'CUSTODY', CHEQUE: 'CUSTODY' };
const REP = 'rep1';

/** أستاذ صغير في الذاكرة: رصيد مدين−دائن لكل رمز، و111003 لكل مندوب */
class Ledger {
  bal = new Map<string, bigint>();
  constructor(private ctx: BuildContext) {}
  add(code: string, delta: bigint) { this.bal.set(code, (this.bal.get(code) ?? 0n) + delta); }
  get(code: string) { return this.bal.get(code) ?? 0n; }
  post(r: BuildResult): MoveDraft | null {
    if (isNoMove(r)) return null;
    const v = validateMove(r, this.ctx);
    assert.equal(v.totalDebitMilli, v.totalCreditMilli);
    assert.match(r.narration, ARABIC, 'narration عربي غير فارغ');
    for (const l of r.lines) {
      assert.match(l.label, ARABIC, 'label عربي غير فارغ');
      if (l.customerId || l.vendorId || l.salesRepId) assert.ok(l.partnerName?.trim());
      const acc = resolveLineAccount(l, this.ctx.accounts)!;
      if (acc.code === '111003') assert.equal(l.salesRepId, REP, 'سطر العهدة يحمل المندوب');
      this.add(acc.code, l.debitMilli - l.creditMilli);
    }
    return r;
  }
}

const ctxOf = () => saContext({ settings: { receiptRouting: ROUTING } });

const rcpt = (id: string, p: Partial<ReceiptPostPayload>) => ({
  receiptId: id, date: '2026-09-01', customerName: 'بقالة النور', salesRepName: 'أحمد',
  payload: { salesRepId: REP, paymentMethod: 'CASH', amount: '0', customerId: 'cus1', ...p } as ReceiptPostPayload,
});

const settlePayload = (amount: string, method = 'CASH'): SettlementPayload => ({
  amount, method, salesRepId: REP, settledAt: '2026-09-05T09:00:00Z',
});

const item = (id: string, amount: bigint, at: string, reversedAt?: string): CustodyItem => ({
  id, salesRepId: REP, amountMilli: amount, effectAt: at, reversedAt: reversedAt ?? null,
});

function emptyInput(): CustodyComponentsInput {
  return {
    receipts: [], onlineReceipts: [], outsideReceipts: [], cashInvoices: [], settlements: [],
    shortages: [], custodyExpenses: [], routing: { cashInvoice: 'MAIN_CASH', receipt: ROUTING },
  };
}

test('P5 بالطرق: كل طريقة غير إلكترونية موجّهة للعهدة تذهب إلى 111003، وDIRECT إلى حسابها', () => {
  const ctx = ctxOf();
  for (const m of ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE']) {
    const L = new Ledger(ctx);
    L.post(buildReceiptMove(rcpt('r', { paymentMethod: m, amount: '10' }), ctx));
    assert.equal(L.get('111003'), 10_000n, m);
  }
  assert.equal(receiptCustodyClass({ paymentMethod: 'CASH', salesRepId: REP, routing: ROUTING }), 'CUSTODY');
  assert.equal(receiptCustodyClass({ paymentMethod: 'CASH', salesRepId: null, routing: ROUTING }), 'OUTSIDE');
  assert.equal(receiptCustodyClass({ paymentMethod: 'POS', salesRepId: REP, routing: { POS: 'DIRECT' } }), 'OUTSIDE');
  assert.equal(receiptCustodyClass({ paymentMethod: 'ONLINE', salesRepId: REP, routing: ROUTING }), 'ONLINE');
  assert.equal(receiptCustodyClass({ paymentMethod: 'CASH', salesRepId: REP, routing: null }), 'OUTSIDE');
});

test('P7 بالطرق: حساب الطريقة مدين وع دائن، ومفتاح SETTLEMENT ودفتر CUST', () => {
  const ctx = ctxOf();
  const cases: [string, string][] = [['CASH', '111001'], ['BANK_TRANSFER', '112001'], ['POS', '112004'], ['CHEQUE', '112003'], ['WEIRD', '111001']];
  for (const [method, code] of cases) {
    const L = new Ledger(ctx);
    const b = buildSettlementMove({
      settlementId: 's1', payload: settlePayload('100', method), salesRepName: 'أحمد',
      custodyBalanceMilli: 100_000n, cumulativeNonCustodyClearedMilli: 0n, nonCustodyAllowanceMilli: 0n,
    }, ctx);
    const m = L.post(b.result)!;
    assert.equal(L.get(code), 100_000n, method);
    assert.equal(L.get('111003'), -100_000n);
    assert.equal(m.journalCode, 'CUST');
    assert.equal(m.moveType, 'CUSTODY_SETTLEMENT');
    assert.equal(m.sourceKey, settlementKey('s1', 'POST'));
    assert.equal(m.date, '2026-09-05');
    assert.equal(b.split.nonCustodyClearedMilli, 0n);
  }
});

test('المتجه الذهبي: فاتورة نقدية 1000 + سند نقدي 300 + ONLINE 200، واستلام 500 ⇒ 111003=0، 111001=1300، r=200 بلا 911001', () => {
  const ctx = ctxOf();
  const L = new Ledger(ctx);
  // P2 الفاتورة النقدية بـcashInvoiceRouting=MAIN_CASH: مدين 111001 = 1000 (أثرها على الذمة يتقاصّ)
  L.add('111001', 1_000_000n);
  L.post(buildReceiptMove(rcpt('rc', { paymentMethod: 'CASH', amount: '300' }), ctx));
  L.post(buildReceiptMove(rcpt('ro', { paymentMethod: 'ONLINE', amount: '200', paylinkId: 'pl1' }), ctx));
  assert.equal(L.get('112005'), 200_000n);

  const input = emptyInput();
  input.receipts = [item('rc', 300_000n, '2026-09-01T08:00:00Z')];
  input.onlineReceipts = [item('ro', 200_000n, '2026-09-01T08:10:00Z')];
  input.cashInvoices = [item('inv', 1_000_000n, '2026-09-01T07:00:00Z')];
  const before = custodyComponentsForRep(input, REP);
  assert.equal(before.ledgerCustody, 300_000n);
  assert.equal(before.opsOutstanding, 500_000n, 'الشاشة التشغيلية تعدّ ONLINE ولا تعدّ الفاتورة النقدية');
  assert.equal(before.nonCustodyAllowance, 1_200_000n);

  const b = buildSettlementMove({
    settlementId: 's1', payload: settlePayload('500'), salesRepName: 'أحمد', ...settlementInputsFrom(before),
  }, ctx);
  const m = L.post(b.result)!;
  assert.equal(b.split.coveredMilli, 300_000n);
  assert.equal(b.split.recoveredMilli, 0n);
  assert.equal(b.split.nonCustodyClearedMilli, 200_000n);
  assert.equal(b.split.suspenseMilli, 0n);
  assert.equal(m.needsAttention, false);
  assert.equal(L.get('111003'), 0n);
  assert.equal(L.get('111001'), 1_300_000n);
  assert.equal(L.get('112005'), 200_000n, '112005 لا يُصفّى إلا بـP9 وP10');
  assert.equal(L.get('911001'), 0n);
  assert.ok(!m.lines.some((l) => resolveLineAccount(l, ctx.accounts)!.code === '911001'));

  // C4 وC4b بالقيم المخزّنة على الحدث (لا إعادة اشتقاق)
  const settlement: CustodySettlementItem = {
    ...item('s1', 500_000n, '2026-09-05T09:00:00Z'),
    nonCustodyClearedMilli: b.split.nonCustodyClearedMilli, shortageRecoveredMilli: b.split.recoveredMilli,
  };
  const after = custodyComponentsForRep({ ...input, settlements: [settlement] }, REP);
  assert.equal(after.ledgerCustody, 0n);
  assert.equal(after.onlineUncleared, 0n);
  assert.equal(after.nonCustodyCleared, 200_000n);
  assert.equal(after.cashSalesOutsideCustody, 1_000_000n);
  assert.equal(after.opsOutstanding, 0n);
  assert.equal(custodyC4Gap(L.get('111003'), after), 0n);
  assert.equal(custodyC4bGap(after), 0n);
  assert.equal(after.settlements[0].stored, true);
  assert.equal(after.settlements[0].coveredMilli, 300_000n);

  // الإعادة بلا قيم مخزّنة تعطي القاعدة نفسها
  const replay = custodyComponentsForRep({ ...input, settlements: [item('s1', 500_000n, '2026-09-05T09:00:00Z')] }, REP);
  assert.deepEqual(
    [replay.ledgerCustody, replay.nonCustodyCleared, replay.opsOutstanding, replay.settlements[0].stored],
    [0n, 200_000n, 0n, false],
  );
});

test('مصروف وقود 100 من العهدة قبل استلام 400 ⇒ covered=200 وr=200، وC4 وC4b متطابقان؛ وP8 يستعيد r', () => {
  const ctx = ctxOf();
  const L = new Ledger(ctx);
  L.add('111001', 1_000_000n); // الفاتورة النقدية
  L.post(buildReceiptMove(rcpt('rc', { paymentMethod: 'CASH', amount: '300' }), ctx));
  L.post(buildReceiptMove(rcpt('ro', { paymentMethod: 'ONLINE', amount: '200', paylinkId: 'pl1' }), ctx));
  // P21 paidFrom=REP_CUSTODY: مدين الوقود / دائن 111003
  L.add('111003', -100_000n);

  const input = emptyInput();
  input.receipts = [item('rc', 300_000n, '2026-09-01T08:00:00Z')];
  input.onlineReceipts = [item('ro', 200_000n, '2026-09-01T08:10:00Z')];
  input.cashInvoices = [item('inv', 1_000_000n, '2026-09-01T07:00:00Z')];
  input.custodyExpenses = [item('fuel', 100_000n, '2026-09-03T10:00:00Z')];
  const before = custodyComponentsForRep(input, REP);
  assert.equal(before.ledgerCustody, 200_000n);
  assert.equal(custodyC4Gap(L.get('111003'), before), 0n);

  const b = buildSettlementMove({
    settlementId: 's1', payload: settlePayload('400'), salesRepName: 'أحمد', ...settlementInputsFrom(before),
  }, ctx);
  const original = L.post(b.result)!;
  assert.equal(b.split.coveredMilli, 200_000n);
  assert.equal(b.split.nonCustodyClearedMilli, 200_000n);
  assert.equal(b.split.suspenseMilli, 0n);
  assert.equal(L.get('111003'), 0n);
  assert.equal(L.get('911001'), 0n);

  const settled: CustodySettlementItem = {
    ...item('s1', 400_000n, '2026-09-05T09:00:00Z'),
    nonCustodyClearedMilli: b.split.nonCustodyClearedMilli, shortageRecoveredMilli: b.split.recoveredMilli,
  };
  const after = custodyComponentsForRep({ ...input, settlements: [settled] }, REP);
  assert.equal(after.opsOutstanding, 100_000n);
  assert.equal(after.custodyExpenses, 100_000n);
  assert.equal(custodyC4Gap(L.get('111003'), after), 0n);
  assert.equal(custodyC4bGap(after), 0n);

  // P8: حذف الاستلام
  const rev = buildSettlementReversalMove({
    settlementId: 's1', payload: settlePayload('400'), salesRepName: 'أحمد', date: '2026-09-06',
    originalLines: original.lines,
    nonCustodyClearedMilli: b.split.nonCustodyClearedMilli, shortageRecoveredMilli: b.split.recoveredMilli,
  }, ctx);
  const rm = L.post(rev.result)!;
  assert.equal(rm.sourceKey, settlementKey('s1', 'REVERSE'));
  assert.equal(rm.moveType, 'CUSTODY_SETTLEMENT');
  assert.equal(rev.restoredNonCustodyClearedMilli, 200_000n);
  assert.equal(L.get('111003'), 200_000n);
  assert.equal(L.get('111001'), 1_000_000n, 'P8 يعيد الصندوق إلى ما قبل الاستلام');

  const deleted = custodyComponentsForRep({
    ...input, settlements: [{ ...settled, reversedAt: '2026-09-06T09:00:00Z' }],
  }, REP);
  assert.equal(deleted.nonCustodyCleared, 0n, 'P8 يستعيد r');
  assert.equal(deleted.ledgerCustody, 200_000n);
  assert.equal(deleted.opsOutstanding, 500_000n);
  assert.equal(custodyC4Gap(L.get('111003'), deleted), 0n);
  assert.equal(custodyC4bGap(deleted), 0n);
  assert.equal(deleted.settlements[0].reversed, true);
});

test('تجاوز العتبة وحده يولّد 911001 مع needsAttention', () => {
  const ctx = ctxOf();
  const L = new Ledger(ctx);
  L.post(buildReceiptMove(rcpt('rc', { paymentMethod: 'CASH', amount: '300' }), ctx));
  const input = emptyInput();
  input.receipts = [item('rc', 300_000n, '2026-09-01T08:00:00Z')];
  const before = custodyComponentsForRep(input, REP);
  assert.equal(before.nonCustodyAllowance, 0n);

  const b = buildSettlementMove({
    settlementId: 's1', payload: settlePayload('500'), salesRepName: 'أحمد', ...settlementInputsFrom(before),
  }, ctx);
  const m = L.post(b.result)!;
  assert.equal(b.split.nonCustodyClearedMilli, 200_000n);
  assert.equal(b.split.suspenseMilli, 200_000n);
  assert.equal(m.needsAttention, true);
  assert.equal(L.get('911001'), -200_000n, 'دائن 911001 = الزائد');
  assert.equal(L.get('111001'), 500_000n);
  assert.equal(L.get('111003'), 0n);

  // ضمن العتبة جزئياً: الزائد وحده معلّق، والتراكمي السابق يستهلك العتبة
  const s = settlementSplit({
    amountMilli: 300_000n, custodyBalanceMilli: 0n, cumulativeNonCustodyClearedMilli: 150_000n, nonCustodyAllowanceMilli: 200_000n,
  });
  assert.deepEqual([s.nonCustodyClearedMilli, s.suspenseMilli], [300_000n, 250_000n]);
});

test('استلام يصفّي ONLINE وحده ⇒ NO_MOVE(NETTED) وr محفوظ، وP8 بلا قيد أصلي ⇒ NO_MOVE', () => {
  const ctx = ctxOf();
  const input = emptyInput();
  input.onlineReceipts = [item('ro', 200_000n, '2026-09-01T08:00:00Z')];
  const before = custodyComponentsForRep(input, REP);
  const b = buildSettlementMove({
    settlementId: 's1', payload: settlePayload('200'), ...settlementInputsFrom(before),
  }, ctx);
  assert.ok(isNoMove(b.result));
  assert.equal(b.result.kind === 'NO_MOVE' && b.result.reason, 'NETTED');
  assert.equal(b.split.nonCustodyClearedMilli, 200_000n);
  const rev = buildSettlementReversalMove({
    settlementId: 's1', payload: settlePayload('200'), date: '2026-09-06', originalLines: null, nonCustodyClearedMilli: 200_000n,
  }, ctx);
  assert.ok(isNoMove(rev.result));
  assert.equal(rev.restoredNonCustodyClearedMilli, 200_000n);
  assert.ok(isNoMove(buildSettlementMove({
    settlementId: 's0', payload: settlePayload('0'), custodyBalanceMilli: 0n,
    cumulativeNonCustodyClearedMilli: 0n, nonCustodyAllowanceMilli: 0n,
  }, ctx).result));
});

test('P27 ثم استرداد العجز عبر P7: دائن 113003 بالمسترد قبل r، وC4 وC4b متطابقان', () => {
  const ctx = ctxOf();
  const L = new Ledger(ctx);
  L.post(buildReceiptMove(rcpt('rc', { paymentMethod: 'CASH', amount: '300' }), ctx));
  // P27: مدين 113003 / دائن 111003 = 100
  L.add('113003', 100_000n);
  L.add('111003', -100_000n);
  const input = emptyInput();
  input.receipts = [item('rc', 300_000n, '2026-09-01T08:00:00Z')];
  input.shortages = [item('sh', 100_000n, '2026-09-02T08:00:00Z')];
  const before = custodyComponentsForRep(input, REP);
  assert.equal(before.openShortage, 100_000n);
  assert.equal(custodyC4bGap(before), 0n);

  const b = buildSettlementMove({
    settlementId: 's1', payload: settlePayload('300'), salesRepName: 'أحمد', ...settlementInputsFrom(before),
  }, ctx);
  const m = L.post(b.result)!;
  assert.deepEqual([b.split.coveredMilli, b.split.recoveredMilli, b.split.nonCustodyClearedMilli], [200_000n, 100_000n, 0n]);
  const advLine = m.lines.find((l) => l.accountCode === '113003')!;
  assert.equal(advLine.salesRepId, REP);
  assert.equal(L.get('113003'), 0n);
  assert.equal(L.get('111003'), 0n);
  assert.equal(L.get('911001'), 0n);
  const after = custodyComponentsForRep({
    ...input,
    settlements: [{ ...item('s1', 300_000n, '2026-09-05T09:00:00Z'), nonCustodyClearedMilli: 0n, shortageRecoveredMilli: 100_000n }],
  }, REP);
  assert.equal(after.openShortage, 0n);
  assert.equal(after.shortageRecovered, 100_000n);
  assert.equal(custodyC4Gap(L.get('111003'), after), 0n);
  assert.equal(custodyC4bGap(after), 0n);
});

test('custodyComponents: إلغاء السند يلغي أثره، والترتيب الزمني يحكم covered، والتجميع لكل مندوب', () => {
  const input = emptyInput();
  // سند 300 أُلغي قبل الاستلام ⇒ لا عهدة تُغطّى
  input.receipts = [
    { ...item('rc', 300_000n, '2026-09-01T08:00:00Z', '2026-09-02T08:00:00Z') },
    { id: 'x', salesRepId: 'rep2', amountMilli: 50_000n, effectAt: '2026-09-01T08:00:00Z' },
  ];
  input.outsideReceipts = [item('ob', 100_000n, '2026-09-01T09:00:00Z')];
  input.settlements = [item('s1', 100_000n, '2026-09-03T08:00:00Z')];
  const all = custodyComponents(input);
  const c = all[REP];
  assert.equal(c.settlements[0].coveredMilli, 0n);
  assert.equal(c.settlements[0].nonCustodyClearedMilli, 100_000n);
  assert.equal(c.ledgerCustody, 0n);
  assert.equal(c.onlineUncleared, 0n);
  assert.equal(c.opsOutstanding, 0n);
  assert.equal(custodyC4bGap(c), 0n);
  assert.equal(all.rep2.ledgerCustody, 50_000n);
  assert.equal(custodyComponentsForRep(input, 'nobody').ledgerCustody, 0n);

  // استلام قبل السند بالزمن: لا يغطيه السند اللاحق
  const early = emptyInput();
  early.receipts = [item('rc', 300_000n, '2026-09-05T08:00:00Z')];
  early.settlements = [item('s1', 100_000n, '2026-09-04T08:00:00Z')];
  const e = custodyComponentsForRep(early, REP);
  assert.equal(e.settlements[0].coveredMilli, 0n);
  assert.equal(e.settlements[0].suspenseMilli, 100_000n);
  assert.equal(e.ledgerCustody, 300_000n);
});

test('cashInvoiceRouting=CUSTODY (الخيار أ في D3): الفاتورة النقدية تدخل ledgerCustody لا cashSalesOutsideCustody', () => {
  const input = emptyInput();
  input.routing = { cashInvoice: 'CUSTODY' };
  input.cashInvoices = [item('inv', 1_000_000n, '2026-09-01T07:00:00Z')];
  input.settlements = [item('s1', 1_000_000n, '2026-09-02T07:00:00Z')];
  const c = custodyComponentsForRep(input, REP);
  assert.equal(c.cashSalesOutsideCustody, 0n);
  assert.equal(c.settlements[0].coveredMilli, 1_000_000n);
  assert.equal(c.ledgerCustody, 0n);
  // الافتتاح يُضاف كحالة أولى
  const o = custodyComponentsForRep({ ...emptyInput(), opening: { [REP]: { ledgerCustodyMilli: 70_000n, activeReceiptsMilli: 70_000n } } }, REP);
  assert.equal(o.ledgerCustody, 70_000n);
  assert.equal(custodyC4bGap(o), 0n);
});

test('عتبة 911001 تراكمية: الزائد لا يُقيد مرتين ولا يتغير بترتيب الأحداث (عهدة 300، s1=500 وONLINE 200 بأي ترتيب، ثم s2=200)', () => {
  const ctx = ctxOf();
  const T = { rc: '2026-09-01T08:00:00Z', a: '2026-09-02T08:00:00Z', b: '2026-09-03T08:00:00Z', s2: '2026-09-04T08:00:00Z' };
  for (const onlineFirst of [false, true]) {
    const tag = onlineFirst ? 'ONLINE قبل s1' : 's1 قبل ONLINE';
    const s1At = onlineFirst ? T.b : T.a;
    const onAt = onlineFirst ? T.a : T.b;
    const input = emptyInput();
    input.receipts = [item('rc', 300_000n, T.rc)];
    input.onlineReceipts = [item('ro', 200_000n, onAt)];

    // (أ) الإعادة بلا قيم مخزّنة
    const replay = custodyComponentsForRep({
      ...input, settlements: [item('s1', 500_000n, s1At), item('s2', 200_000n, T.s2)],
    }, REP);
    const sumSusp = replay.settlements.reduce((a, o) => a + o.suspenseMilli, 0n);
    const sumDebit = replay.settlements.reduce((a, o) => a + o.coveredMilli + o.recoveredMilli + o.suspenseMilli, 0n);
    assert.equal(sumSusp, 200_000n, `Σ suspense (${tag})`);
    assert.equal(sumDebit, 500_000n, `Σ مدين النقد (${tag})`);
    assert.equal(replay.suspenseCleared, 200_000n, tag);
    assert.equal(custodyC4bGap(replay), 0n, tag);

    // (ب) المسار الحي: builder بمدخلات custodyComponents لحظة الاستلام، والقيم المخزّنة على الحدث
    const L = new Ledger(ctx);
    L.post(buildReceiptMove(rcpt('rc', { paymentMethod: 'CASH', amount: '300' }), ctx));
    L.post(buildReceiptMove(rcpt('ro', { paymentMethod: 'ONLINE', amount: '200', paylinkId: 'pl1' }), ctx));
    const stored: CustodySettlementItem[] = [];
    const seq: [string, bigint, string][] = [['s1', 500_000n, s1At], ['s2', 200_000n, T.s2]];
    for (const [id, amountMilli, at] of seq) {
      const visible = {
        ...input, onlineReceipts: input.onlineReceipts.filter((o) => String(o.effectAt) < at), settlements: [...stored],
      };
      const before = custodyComponentsForRep(visible, REP);
      const b = buildSettlementMove({
        settlementId: id, payload: { ...settlePayload(String(amountMilli / 1000n)), settledAt: at },
        salesRepName: 'أحمد', ...settlementInputsFrom(before),
      }, ctx);
      L.post(b.result);
      stored.push({
        ...item(id, amountMilli, at),
        nonCustodyClearedMilli: b.split.nonCustodyClearedMilli, shortageRecoveredMilli: b.split.recoveredMilli,
      });
    }
    assert.equal(L.get('111001'), 500_000n, `مدين النقد (${tag})`);
    assert.equal(L.get('911001'), -200_000n, `دائن 911001 (${tag})`);
    const after = custodyComponentsForRep({ ...input, settlements: stored }, REP);
    assert.equal(after.suspenseCleared, 200_000n, tag);
    assert.equal(after.opsOutstanding, -200_000n, tag);
    assert.equal(custodyC4bGap(after), 0n, tag);

    // P8: حذف s2 يستعيد suspense الخاص به وحده
    const del = custodyComponentsForRep({
      ...input, settlements: [stored[0], { ...stored[1], reversedAt: '2026-09-05T08:00:00Z' }],
    }, REP);
    assert.equal(del.suspenseCleared, onlineFirst ? 0n : 200_000n, tag);
  }
  // زائد سابق ثم عتبة ترتفع: الزائد القديم لا يُقيد ثانية
  const s = settlementSplit({
    amountMilli: 200_000n, custodyBalanceMilli: 0n, cumulativeNonCustodyClearedMilli: 200_000n,
    priorSuspenseMilli: 200_000n, nonCustodyAllowanceMilli: 200_000n,
  });
  assert.equal(s.suspenseMilli, 0n);
  const s3 = settlementSplit({
    amountMilli: 300_000n, custodyBalanceMilli: 0n, cumulativeNonCustodyClearedMilli: 200_000n,
    priorSuspenseMilli: 200_000n, nonCustodyAllowanceMilli: 200_000n,
  });
  assert.equal(s3.suspenseMilli, 100_000n);
});

test('P27 بوجهتين: عجز على المندوب يُسترد عبر P7، وعجز محمَّل على المصروف لا يُسترد من 113003 ويدخل العتبة', () => {
  const mk = (chargedTo: CustodyShortageItem['chargedTo'], reversedAt?: string): CustodyComponentsInput => {
    const input = emptyInput();
    input.receipts = [item('rc', 300_000n, '2026-09-01T08:00:00Z')];
    input.shortages = [{ ...item('sh', 100_000n, '2026-09-02T08:00:00Z', reversedAt), ...(chargedTo ? { chargedTo } : {}) }];
    return input;
  };
  const settle = (input: CustodyComponentsInput) => {
    const before = custodyComponentsForRep(input, REP);
    assert.equal(custodyC4bGap(before), 0n);
    const split = settlementSplit({ amountMilli: 300_000n, ...settlementInputsFrom(before) });
    const replay = custodyComponentsForRep({ ...input, settlements: [item('s1', 300_000n, '2026-09-05T09:00:00Z')] }, REP);
    assert.equal(custodyC4bGap(replay), 0n);
    return { before, split, replay };
  };

  for (const chargedTo of [undefined, 'EMPLOYEE'] as const) {
    const { before, split, replay } = settle(mk(chargedTo));
    assert.equal(before.ledgerCustody, 200_000n);
    assert.equal(before.openShortage, 100_000n);
    assert.equal(before.shortagesExpensed, 0n);
    assert.deepEqual([split.coveredMilli, split.recoveredMilli, split.nonCustodyClearedMilli], [200_000n, 100_000n, 0n]);
    assert.equal(replay.openShortage, 0n);
  }

  const { before, split, replay } = settle(mk('EXPENSE'));
  assert.equal(before.ledgerCustody, 200_000n);
  assert.equal(before.openShortage, 0n);
  assert.equal(before.shortagesExpensed, 100_000n);
  assert.equal(before.nonCustodyAllowance, 100_000n, 'العجز المحمَّل على المصروف يدخل العتبة');
  assert.deepEqual([split.coveredMilli, split.recoveredMilli, split.nonCustodyClearedMilli, split.suspenseMilli],
    [200_000n, 0n, 100_000n, 0n]);
  assert.equal(replay.openShortage, 0n);
  assert.equal(replay.shortagesExpensed, 100_000n);
  assert.equal(replay.shortageRecovered, 0n);

  // إلغاء العجز المحمَّل على المصروف يعكس أثره
  const cancelled = settle(mk('EXPENSE', '2026-09-03T08:00:00Z'));
  assert.equal(cancelled.before.ledgerCustody, 300_000n);
  assert.equal(cancelled.before.shortagesExpensed, 0n);
  assert.equal(cancelled.before.nonCustodyAllowance, 0n);
  assert.deepEqual(
    [cancelled.split.coveredMilli, cancelled.split.recoveredMilli, cancelled.split.nonCustodyClearedMilli],
    [300_000n, 0n, 0n],
  );
});
