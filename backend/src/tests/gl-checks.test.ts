// M3 — فحوصات سلامة الدفاتر (DESIGN.md §5.9، §10.1 صف M3: gl-checks.test.ts).
// بلا قاعدة: القواعد صرفة (checks/rules.ts)، والتشغيل فوق CheckStore مزيّف (checks/run.ts)، وقيود العهدة من المُرحِّل
// الحقيقي فوق FakePostingStore. المتجهات: C4 وC4b بالمكوّنات؛ 111003 لا يتغير حين يُرفض حذف مندوب؛ مندوب معطَّل سلّم كل
// نقده ⇒ Σ111003 = 0 وC4 أخضر؛ مندوب بلا أثر يُحذف بعد التفعيل دون حدث؛ C5 أخضر بعد إلغاء يدوي لسند ONLINE (وC9 يلتقط
// 911001)؛ C8 يصفرّ بعد ساعة ويحمرّ بعد 24 ساعة وتعمّقه يعرض الشقيق؛ إعادة فحص BLOCKED خارج ميزانية الأحداث وبتراجع
// 1m→5m→30m→2h؛ C15 يحمرّ لمؤشر متأخر بعد DONE ولا يحمرّ أثناء الترحيل التاريخي.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { accountIdOf, saContext } from '../services/gl/testing/fixtures';
import { validateMove } from '../services/gl/validate';
import { custodyComponentsForRep, type CustodyComponentsInput, type CustodyItem, type CustodySettlementItem } from '../services/gl/custody';
import { buildReceiptMove, buildReceiptReversalMove } from '../services/gl/builders/receipt';
import { buildPaylinkFeeMove } from '../services/gl/builders/paylink';
import { invoicePayloadFromRows } from '../services/gl/builders/invoice';
import { assertRepDeletable, type RepDeletableDb } from '../services/gl/sync/tombstone';
import { invoiceKey, receiptKey, settlementKey } from '../services/gl/sync/keys';
import { createSyncBudget, runPoster } from '../services/gl/sync/poster';
import { BLOCKED_BACKOFF_MS, type DesiredEvent, type SourceEventPayload } from '../services/gl/sync/types';
import { isLedgerError, isNoMove, type BuildResult, type Milli } from '../services/gl/types';
import {
  C15_LAG_RED_MS, c8Severity, evaluateC1, evaluateC10, evaluateC11, evaluateC12, evaluateC15, evaluateC2, evaluateC4, evaluateC4b,
  evaluateC5, evaluateC8, evaluateC9, type ProblemEvent, type RepCustodyFacts,
  IMPORT_AFTER_CUTOVER_ROW, OPENING_DELETED_WITHOUT_EVENT, evaluateC3, openingEntryGroupsFromRows, openingEntryRole, openingEntryTotalsFromGroups,
  type C3Input, type ImportAfterCutoverFacts,
} from '../services/gl/checks/rules';
import { openingRowRole } from '../services/gl/opening';
import { toMilli } from '../services/gl/money';
import { runChecks, type CheckSettingsFacts, type CheckStore, type PendingPartners } from '../services/gl/checks/run';
import { planEventAction } from '../services/gl/checks/eventActions';
import { FakePostingStore } from './gl-fake-posting-store';

const at = (iso: string) => new Date(iso);
const CUSTODY = accountIdOf('111003');
const AR = accountIdOf('113001');
const PLNK = accountIdOf('112005');
const SUSP = accountIdOf('911001');
const quiet = { log: () => undefined };

function clockAt(iso: string) {
  let t = at(iso).getTime();
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

// ═══ C4 وC4b: مندوب معطَّل بتاريخ استلامات كامل ═══

interface RepHistory {
  receipts: { id: string; amount: number; at: string }[];
  settlements: { id: string; amount: number; at: string }[];
}

function custodyInputsFor(store: FakePostingStore, h: RepHistory, repId: string): CustodyComponentsInput {
  const receipts: CustodyItem[] = h.receipts.map((r) => ({ id: r.id, salesRepId: repId, amountMilli: BigInt(Math.round(r.amount * 1000)), effectAt: r.at, createdAt: r.at }));
  const settlements: CustodySettlementItem[] = h.settlements.map((st) => {
    const ev = store.event(settlementKey(st.id, 'POST'));
    return {
      id: st.id, salesRepId: repId, amountMilli: BigInt(Math.round(st.amount * 1000)), effectAt: st.at, createdAt: st.at,
      nonCustodyClearedMilli: ev?.status === 'DONE' || ev?.status === 'SKIPPED' ? ev.nonCustodyClearedMilli : null,
      shortageRecoveredMilli: ev?.shortageRecoveredMilli ?? null,
    };
  });
  return { receipts, onlineReceipts: [], outsideReceipts: [], cashInvoices: [], settlements, shortages: [], custodyExpenses: [], routing: { cashInvoice: 'MAIN_CASH', receipt: { CASH: 'CUSTODY' } } };
}

function repLedger(store: FakePostingStore, repId: string): Milli {
  let t = 0n;
  for (const m of store.moves()) for (const l of m.lines) if (l.accountId === CUSTODY && l.salesRepId === repId) t += l.debitMilli - l.creditMilli;
  return t;
}

async function postRepHistory(h: RepHistory) {
  const clock = clockAt('2027-03-10T10:00:00.000Z');
  const s = new FakePostingStore({
    now: clock.now,
    context: { settings: { receiptRouting: { CASH: 'CUSTODY' } } },
    custody: (repId) => custodyInputsFor(s, h, repId),
  });
  s.setCursor('ACCOUNT_ENTRY', at('2027-03-09T00:00:00.000Z'), 'zz');
  const events: DesiredEvent[] = [
    ...h.receipts.map((r): DesiredEvent => ({
      sourceKey: receiptKey(r.id, 'POST'), sourceType: 'RECEIPT', sourceId: r.id, event: 'POST', effectAt: at(r.at),
      payload: { receiptId: r.id, number: `R-${r.id}`, entryDate: r.at.slice(0, 10), salesRepId: 'rep1', paymentMethod: 'CASH', amount: r.amount.toFixed(2), customerId: 'c1', customerName: 'عميل', salesRepName: 'مندوب معطّل', sourceCreatedAt: r.at } as SourceEventPayload,
    })),
    ...h.settlements.map((st): DesiredEvent => ({
      sourceKey: settlementKey(st.id, 'POST'), sourceType: 'SETTLEMENT', sourceId: st.id, event: 'POST', effectAt: at(st.at),
      payload: { settlementId: st.id, amount: st.amount.toFixed(2), method: 'CASH', salesRepId: 'rep1', settledAt: st.at, createdAt: st.at, salesRepName: 'مندوب معطّل' } as SourceEventPayload,
    })),
  ];
  s.seedEvents(events);
  const r = await runPoster(s, s.settings, createSyncBudget({ timeMs: 60_000, events: 300 }), quiet);
  return { s, r };
}

function repFacts(s: FakePostingStore, h: RepHistory, opsOutstandingMilli: Milli, pending = false): RepCustodyFacts {
  return {
    salesRepId: 'rep1', name: 'مندوب معطّل', isActive: false, ledgerMilli: repLedger(s, 'rep1'),
    components: custodyComponentsForRep(custodyInputsFor(s, h, 'rep1'), 'rep1'), opsOutstandingMilli, pending,
  };
}

const FULL_HISTORY: RepHistory = {
  receipts: [
    { id: 'r1', amount: 120, at: '2027-02-01T08:00:00.000Z' },
    { id: 'r2', amount: 80.5, at: '2027-02-03T08:00:00.000Z' },
    { id: 'r3', amount: 49.5, at: '2027-02-05T08:00:00.000Z' },
  ],
  settlements: [
    { id: 'st1', amount: 200.5, at: '2027-02-04T08:00:00.000Z' },
    { id: 'st2', amount: 49.5, at: '2027-02-06T08:00:00.000Z' },
  ],
};

test('مندوب معطَّل بتاريخ استلامات كامل سلّم فيه كل نقده ⇒ Σ111003 = 0 وC4 وC4b أخضران', async () => {
  const { s, r } = await postRepHistory(FULL_HISTORY);
  assert.equal(r.done, 5, JSON.stringify(r));
  assert.equal(repLedger(s, 'rep1'), 0n);
  const facts = repFacts(s, FULL_HISTORY, 250_000n - 250_000n);
  assert.equal(facts.components.ledgerCustody, 0n);
  assert.equal(evaluateC4([facts]).status, 'GREEN');
  const c4b = evaluateC4b([facts]);
  assert.equal(c4b.status, 'GREEN');
  assert.equal(c4b.rows[0].matched, true, 'جدول المكوّنات معروض لكل مندوب');
});

test('C4 بالمكوّنات: انحراف الأستاذ أحمر (وأصفر بانتظار الترحيل)، وC4b أصفر لا أحمر مع جدول المكوّنات', async () => {
  const { s } = await postRepHistory(FULL_HISTORY);
  const drift = { ...repFacts(s, FULL_HISTORY, 0n), ledgerMilli: 15_000n };
  const red = evaluateC4([drift]);
  assert.equal(red.status, 'RED');
  assert.equal(red.fix, 'CONTROL_ADJUSTMENT');
  assert.equal(red.rows[0].gapMilli, '15000');
  assert.equal(red.rows[0].adjustable, true);
  const pending = evaluateC4([{ ...drift, pending: true }]);
  assert.equal(pending.status, 'YELLOW');
  assert.equal(pending.rows[0].adjustable, false);

  const ops = evaluateC4b([{ ...repFacts(s, FULL_HISTORY, 0n), opsOutstandingMilli: 30_000n }]);
  assert.equal(ops.status, 'YELLOW');
  assert.equal(ops.rows[0].matched, false);
  assert.equal(ops.rows[0].gapMilli, '30000');
  for (const k of ['ledgerCustodyMilli', 'onlineUnclearedMilli', 'custodyExpensesMilli', 'openShortageMilli']) assert.ok(k in ops.rows[0]);
});

test('111003 لا يتغير حين يُرفض حذف مندوب له أثر، ومندوب بلا أثر يُحذف بعد التفعيل دون أي حدث', async () => {
  const { s } = await postRepHistory({ receipts: [{ id: 'r9', amount: 60, at: '2027-02-01T08:00:00.000Z' }], settlements: [] });
  const before = repLedger(s, 'rep1');
  const eventsBefore = s.state.events.size;
  assert.equal(before, 60_000n);
  const counts: Record<string, number> = { repSettlement: 0, invoice: 0, receipt: 1, vanLoad: 0, glMoveLine: 1 };
  let writes = 0;
  const db = (c: Record<string, number>): RepDeletableDb & { glSourceEvent: { createMany(): Promise<void> } } => ({
    glSettings: { findUnique: async () => ({ activatedAt: at('2027-01-15T09:00:00.000Z') }) },
    repSettlement: { count: async () => c.repSettlement },
    invoice: { count: async () => c.invoice },
    receipt: { count: async () => c.receipt },
    vanLoad: { count: async () => c.vanLoad },
    glMoveLine: { count: async () => c.glMoveLine },
    glSourceEvent: { createMany: async () => { writes++; } },
  });
  await assert.rejects(assertRepDeletable(db(counts), 't1', 'rep1'), (e: unknown) => isLedgerError(e, 'LEDGER_HISTORY_LOCKED'));
  assert.equal(repLedger(s, 'rep1'), before);
  assert.equal(s.state.events.size, eventsBefore);
  const facts: RepCustodyFacts = {
    salesRepId: 'rep1', name: 'مندوب', isActive: true, ledgerMilli: repLedger(s, 'rep1'),
    components: custodyComponentsForRep({ receipts: [{ id: 'r9', salesRepId: 'rep1', amountMilli: 60_000n, effectAt: '2027-02-01T08:00:00.000Z' }], onlineReceipts: [], outsideReceipts: [], cashInvoices: [], settlements: [], shortages: [], custodyExpenses: [], routing: { cashInvoice: 'MAIN_CASH' } }, 'rep1'),
    opsOutstandingMilli: 60_000n, pending: false,
  };
  assert.equal(evaluateC4([facts]).status, 'GREEN');

  // مندوب بلا أثر مالي بعد التفعيل: الحارس يمرّ ولا يكتب شيئاً
  await assertRepDeletable(db({ repSettlement: 0, invoice: 0, receipt: 0, vanLoad: 0, glMoveLine: 0 }), 't1', 'rep2');
  assert.equal(writes, 0);
});

// ═══ C5 وC9 ═══

function ledgerOf(results: readonly BuildResult[]): Map<string, Milli> {
  const c = saContext();
  const m = new Map<string, Milli>();
  for (const r of results) {
    assert.ok(!isNoMove(r));
    for (const l of validateMove(r, c).lines) m.set(l.account.id, (m.get(l.account.id) ?? 0n) + l.line.debitMilli - l.line.creditMilli);
  }
  return m;
}

test('C5 يبقى أخضر بعد إلغاء يدوي لسند ONLINE، والمبلغ على 911001 يلتقطه C9 مع تعمّق القيد', () => {
  const c = saContext();
  const original = { salesRepId: 'rep1', paymentMethod: 'ONLINE', amount: '75.00', customerId: 'c1', paylinkId: 'L1' };
  const posted = buildReceiptMove({ receiptId: 'r1', date: '2027-03-01', payload: original, customerName: 'عميل' }, c);
  const fee = buildPaylinkFeeMove({ entryId: 'f1', amount: '-1.73', feeNet: '1.50', feeVat: '0.23', createdAt: '2027-03-01T09:00:00.000Z' }, c);
  const cancel = buildReceiptReversalMove({ receiptId: 'r1', date: '2027-03-02', original, reverse: { paylinkId: 'L1' }, customerName: 'عميل' }, c);
  const ledger = ledgerOf([posted, fee, cancel]);
  const settlementBalanceMilli = 75_000n - 1_730n; // COLLECTED − FEE، بلا REFUND
  const c5 = evaluateC5({
    ledgerMilli: ledger.get(PLNK)!, settlementBalanceMilli, pending: false, refundedLinksWithoutRefund: [],
    cancelledOnlineWithoutRefund: [{ receiptId: 'r1', number: null, amountMilli: 75_000n }],
  });
  assert.equal(c5.status, 'GREEN');
  assert.equal(c5.rows[0].kind, 'CANCELLED_ONLINE_WITHOUT_REFUND', 'صف التفسير في التعمّق');
  assert.equal(ledger.get(AR), 0n);

  assert.ok(!isNoMove(cancel) && cancel.needsAttention);
  const c9 = evaluateC9([
    { key: 'POSTING_SUSPENSE', accountId: SUSP, accountCode: '911001', balanceMilli: ledger.get(SUSP)!, attentionMoves: [{ moveId: 'm3', number: 'RCPT/2027/00002', date: '2027-03-02', attentionReason: isNoMove(cancel) ? null : cancel.attentionReason ?? null, amountMilli: -75_000n }] },
    { key: 'BANK_SUSPENSE', accountId: accountIdOf('112009'), accountCode: '112009', balanceMilli: 0n, attentionMoves: [] },
  ]);
  assert.equal(c9.status, 'YELLOW');
  assert.equal(c9.metrics.POSTING_SUSPENSEMilli, '-75000');
  assert.deepEqual(c9.rows.map((r) => r.kind), ['ACCOUNT', 'MOVE']);
});

// ═══ C8 ═══

function problem(status: string, detectedAt: string, extra: Partial<ProblemEvent> = {}): ProblemEvent {
  return {
    id: `e-${status}-${detectedAt}`, sourceKey: invoiceKey('i1', 'REVERSE'), sourceType: 'INVOICE', event: 'REVERSE', status,
    effectAt: at(detectedAt), detectedAt: at(detectedAt), nextAttemptAt: null, attempts: 0, lastError: null, sibling: null, ...extra,
  };
}

test('C8: BLOCKED يصفرّ بعد ساعة ويحمرّ بعد 24 ساعة، وERROR/HELD أحمر بعد 24 ساعة، والتعمّق يعرض الشقيق', () => {
  const now = at('2027-03-10T12:00:00.000Z');
  assert.equal(c8Severity(problem('BLOCKED', '2027-03-10T11:30:00.000Z'), now), 'GREEN');
  assert.equal(c8Severity(problem('BLOCKED', '2027-03-10T10:59:00.000Z'), now), 'YELLOW');
  assert.equal(c8Severity(problem('BLOCKED', '2027-03-09T11:59:00.000Z'), now), 'RED');
  assert.equal(c8Severity(problem('ERROR', '2027-03-10T11:00:00.000Z'), now), 'YELLOW');
  assert.equal(c8Severity(problem('HELD', '2027-03-09T11:00:00.000Z'), now), 'RED');

  const yellow = evaluateC8([problem('BLOCKED', '2027-03-10T10:00:00.000Z', {
    lastError: 'BLOCKED:SIBLING_NOT_FINAL#1', nextAttemptAt: at('2027-03-10T12:05:00.000Z'),
    sibling: { sourceKey: invoiceKey('i1', 'POST'), status: 'HELD', skipReason: null, nextAttemptAt: null },
  })], now);
  assert.equal(yellow.status, 'YELLOW');
  assert.equal(yellow.fix, 'REVIEW_EVENTS');
  assert.deepEqual(
    [yellow.rows[0].siblingKey, yellow.rows[0].siblingStatus, yellow.rows[0].siblingSkipReason, yellow.rows[0].nextAttemptAt],
    [invoiceKey('i1', 'POST'), 'HELD', null, '2027-03-10T12:05:00.000Z'],
  );
  const red = evaluateC8([problem('BLOCKED', '2027-03-10T10:00:00.000Z'), problem('BLOCKED', '2027-03-08T10:00:00.000Z')], now);
  assert.equal(red.status, 'RED');
  assert.equal(red.rows[0].severity, 'RED', 'الأحمر أولاً');
  assert.equal(evaluateC8([], now).status, 'GREEN');
});

test('إعادة فحص BLOCKED لا تُحتسب في ميزانية الأحداث وتتبع nextAttemptAt بالتراجع 1m ثم 5m ثم 30m ثم 2h', async () => {
  const clock = clockAt('2027-03-01T10:00:00.000Z');
  const s = new FakePostingStore({ now: clock.now, origin: () => ({ originEffectAt: '2027-02-10T08:00:00.000Z', originCreatedAt: '2027-02-10T08:00:00.000Z', sourceExists: true }) });
  const payload = invoicePayloadFromRows({
    invoice: { id: 'i1', number: 'INV-1', type: 'CREDIT', customerId: 'c1', salesRepId: null, pricesIncludeTax: false, subtotal: 100, discountAmt: 0, taxAmt: 15, total: 115 },
    items: [{ qty: 1, unitPrice: 100, taxPct: 15, taxAmt: 15, lineTotal: 115 }],
    customerName: 'عميل', entryDate: '2027-02-10', currency: 'SAR', currencyDecimals: 2,
  });
  s.seedEvents([
    { sourceKey: invoiceKey('i1', 'POST'), sourceType: 'INVOICE', sourceId: 'i1', event: 'POST', effectAt: at('2027-02-10T08:00:00.000Z'), payload: payload as SourceEventPayload, status: 'HELD', lastError: 'HELD:MISSING_MAPPING' },
    { sourceKey: invoiceKey('i1', 'REVERSE'), sourceType: 'INVOICE', sourceId: 'i1', event: 'REVERSE', effectAt: at('2027-02-12T08:00:00.000Z'), payload: { invoiceId: 'i1', type: 'CREDIT', entryDate: '2027-02-12' } },
  ]);
  const key = invoiceKey('i1', 'REVERSE');

  const first = createSyncBudget({ clock: clock.now, timeMs: 60_000, events: 5 });
  const r1 = await runPoster(s, s.settings, first, quiet);
  assert.equal(r1.blocked, 1);
  assert.equal(r1.blockedRechecks, 0);
  assert.equal(first.eventsRemaining, 4, 'أول حجب يُحتسب');
  const steps: number[] = [];
  let prev = clock.now();
  steps.push(s.event(key)!.nextAttemptAt!.getTime() - prev);

  for (let i = 0; i < 4; i++) {
    clock.advance(steps[steps.length - 1]);
    prev = clock.now();
    const budget = createSyncBudget({ clock: clock.now, timeMs: 60_000, events: 1 });
    const r = await runPoster(s, s.settings, budget, quiet);
    assert.equal(r.blockedRechecks, 1, `إعادة الفحص ${i + 1}`);
    assert.equal(budget.eventsRemaining, 1, 'إعادة فحص BLOCKED خارج ميزانية الأحداث');
    assert.equal(s.event(key)!.status, 'BLOCKED');
    steps.push(s.event(key)!.nextAttemptAt!.getTime() - prev);
  }
  assert.deepEqual(steps, [...BLOCKED_BACKOFF_MS, BLOCKED_BACKOFF_MS[BLOCKED_BACKOFF_MS.length - 1]]);
  assert.deepEqual(BLOCKED_BACKOFF_MS, [60_000, 300_000, 1_800_000, 7_200_000]);

  // الإفراج عن الشقيق HELD ثم إعادة محاولة العكس (إجراءا الأدمن)
  const release = planEventAction('release', 'HELD', { now: new Date(clock.now()) });
  assert.ok(release.ok && release.patch.status === 'PENDING');
  assert.equal(planEventAction('retry', 'HELD', { now: new Date() }).ok, false);
  const skip = planEventAction('skip', 'BLOCKED', { now: new Date(), reason: '' });
  assert.ok(!skip.ok && skip.reason === 'REASON_REQUIRED');
  const skipped = planEventAction('skip', 'HELD', { now: new Date(), reason: 'عملة مختلفة لن تُرحَّل' });
  assert.ok(skipped.ok && skipped.patch.status === 'SKIPPED' && skipped.patch.skipReason === 'MANUAL');
  assert.equal(planEventAction('skip', 'DONE', { now: new Date(), reason: 'x' }).ok, false);
});

// ═══ C15 ═══

test('C15 يحمرّ لمؤشر متأخر أو متوقف بعد DONE، ولا يحمرّ أثناء الترحيل التاريخي', () => {
  const required = ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY'];
  const fresh = (source: string, lagMs = 0, stallTicks = 0) => ({ source, watermarkAt: at('2027-03-10T11:40:00.000Z'), lastRunAt: at('2027-03-10T11:59:00.000Z'), lastCount: 0, stallTicks, lagMs });
  assert.equal(evaluateC15({ backfillState: 'DONE', cursors: required.map((x) => fresh(x)), requiredSources: required }).status, 'GREEN');
  // تأخر أكثر من 15 دقيقة مع صفوف غير مقروءة (lagMs من cursorLagMs)
  const lag = evaluateC15({ backfillState: 'DONE', cursors: [fresh('ACCOUNT_ENTRY', C15_LAG_RED_MS + 1), fresh('REP_SETTLEMENT'), fresh('SETTLEMENT_ENTRY')], requiredSources: required });
  assert.equal(lag.status, 'RED');
  assert.equal(lag.rows[0].lagging, true);
  // مؤشر هادئ قديم بلا صفوف غير مقروءة (lagMs = 0) ليس متأخراً
  assert.equal(evaluateC15({ backfillState: 'DONE', cursors: required.map((x) => ({ ...fresh(x), watermarkAt: at('2027-01-01T00:00:00.000Z') })), requiredSources: required }).status, 'GREEN');
  assert.equal(evaluateC15({ backfillState: 'DONE', cursors: [fresh('ACCOUNT_ENTRY', 0, 2), fresh('REP_SETTLEMENT'), fresh('SETTLEMENT_ENTRY')], requiredSources: required }).status, 'RED');
  assert.equal(evaluateC15({ backfillState: 'DONE', cursors: [fresh('ACCOUNT_ENTRY')], requiredSources: required }).status, 'RED', 'مؤشر غائب');
  for (const state of ['RUNNING', 'PAUSED']) {
    const during = evaluateC15({ backfillState: state, cursors: [fresh('ACCOUNT_ENTRY', 3 * 3_600_000, 4), fresh('REP_SETTLEMENT'), fresh('SETTLEMENT_ENTRY')], requiredSources: required });
    assert.notEqual(during.status, 'RED', state);
    assert.equal(during.rows[0].stallTicks, 4, '«لا تقدم منذ N نبضة» في التعمّق');
  }
});

// ═══ C1، C2، C10–C12 ═══

test('C1 وC2 وC10 وC11 وC12 الصرفة', () => {
  assert.equal(evaluateC1([]).status, 'GREEN');
  assert.equal(evaluateC1([{ moveId: 'm1', number: 'INV/2027/00001', debitMilli: 10n, creditMilli: 9n }]).status, 'RED');

  const ledger = [{ accountId: 'a', accountCode: '113001', periodKey: '2027-03', debitMilli: 100n, creditMilli: 40n }];
  assert.equal(evaluateC2(ledger, [{ accountId: 'a', periodKey: '2027-03', debitMilli: 100n, creditMilli: 40n }]).status, 'GREEN');
  const c2 = evaluateC2(ledger, [{ accountId: 'a', periodKey: '2027-03', debitMilli: 100n, creditMilli: 0n }, { accountId: 'b', periodKey: '2026-CL', debitMilli: 5n, creditMilli: 0n }]);
  assert.equal(c2.status, 'RED');
  assert.equal(c2.fix, 'REBUILD_BALANCES');
  assert.equal(c2.rowCount, 2);

  assert.equal(evaluateC10({ lockDate: null, count: 3, drafts: [] }).status, 'GREEN');
  const c10 = evaluateC10({ lockDate: '2027-02-28', count: 3, drafts: [{ id: 'd1', date: '2027-02-01', ref: null }] });
  assert.equal(c10.status, 'YELLOW');
  assert.equal(c10.rowCount, 3);
  assert.equal(c10.metrics.listUrl, '/app/ledger/entries?state=DRAFT&dateTo=2027-02-28');

  assert.equal(evaluateC11([{ id: 't1', key: 'AUTO_SALE_5', name: 'x', rate: 5, vatBox: 'SA_1' }, { id: 't2', key: 'S15_SALE', name: 'y', rate: 15, vatBox: null }]).status, 'GREEN');
  assert.equal(evaluateC11([{ id: 't1', key: 'AUTO_SALE_7_5', name: 'x', rate: 7.5, vatBox: null }]).status, 'YELLOW');

  const seq = [{ journalId: 'j1', journalCode: 'INV', prefix: 'INV', periodKey: '2027', nextNumber: 4 }];
  assert.equal(evaluateC12(seq, ['INV/2027/00001', 'INV/2027/00002', 'INV/2027/00003'].map((number) => ({ journalId: 'j1', number }))).status, 'GREEN');
  const gap = evaluateC12(seq, ['INV/2027/00001', 'INV/2027/00003'].map((number) => ({ journalId: 'j1', number })));
  assert.equal(gap.status, 'RED');
  assert.deepEqual(gap.rows[0].missing, [2]);
});

// ═══ التشغيل فوق CheckStore مزيّف ═══

class FakeCheckStore implements CheckStore {
  settings: CheckSettingsFacts | null = {
    activatedAt: at('2027-01-15T09:00:00.000Z'), backfillState: 'DONE', setupMethod: 'OPENING', cutoverDate: '2027-01-01',
    openingSnapshotAt: at('2027-01-15T09:00:00.000Z'), timezone: 'Asia/Riyadh', currencyDecimals: 2, lastSyncAt: at('2027-03-10T11:59:00.000Z'),
    inventoryMode: 'PERIODIC', lockDates: { salesLockDate: null, purchaseLockDate: null, taxLockDate: null, hardLockDate: null },
  };
  arLedger = new Map<string, Milli>();
  arOpening = new Map<string, Milli>();
  entries = new Map<string, Milli>();
  pending: PendingPartners = { customerIds: new Set(), salesRepIds: new Set(), settlement: false, unknown: false };
  sinceSeen: (Date | null)[] = [];
  async dbNow() { return at('2027-03-10T12:00:00.000Z'); }
  async loadSettings() { return this.settings; }
  async unbalancedMoves() { return []; }
  async periodLineTotals() { return []; }
  async storedPeriodBalances() { return []; }
  async controlAccounts() { return [{ id: AR, code: '113001', controlKind: 'AR' }, { id: CUSTODY, code: '111003', controlKind: 'CUSTODY' }, { id: PLNK, code: '112005', controlKind: 'PAYLINK' }]; }
  async mappedAccounts() { return []; }
  async ledgerByPartner(_t: string, _a: readonly string[], partner: 'customerId' | 'salesRepId', opts: { moveType?: string } = {}) {
    if (partner !== 'customerId') return new Map<string, Milli>();
    return opts.moveType === 'OPENING' ? this.arOpening : this.arLedger;
  }
  async ledgerTotal() { return 0n; }
  async accountEntryTotals() { return this.entries; }
  async deletedOpeningImports() { return new Map<string, Milli>(); }
  async customerNames(_t: string, ids: readonly string[]) { return new Map(ids.map((i) => [i, `عميل ${i}`])); }
  async salesReps() { return []; }
  async custodyInputs(): Promise<CustodyComponentsInput> { return { receipts: [], onlineReceipts: [], outsideReceipts: [], cashInvoices: [], settlements: [], shortages: [], custodyExpenses: [], routing: { cashInvoice: 'MAIN_CASH' } }; }
  async repCollections() { return new Map<string, Milli>(); }
  async settlementBalance() { return 0n; }
  async paylinkExplanations() { return { refundedLinksWithoutRefund: [], cancelledOnlineWithoutRefund: [] }; }
  async pendingPartners(_t: string, since: Date | null) { this.sinceSeen.push(since); return { ...this.pending, customerIds: new Set(this.pending.customerIds), salesRepIds: new Set(this.pending.salesRepIds) }; }
  async problemEvents() { return []; }
  async cursorStates() { return ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY'].map((source) => ({ source, watermarkAt: at('2027-03-10T11:40:00.000Z'), lastRunAt: at('2027-03-10T11:59:00.000Z'), lastCount: 0, stallTicks: 0, lagMs: 0 })); }
  async attentionMovesOn() { return []; }
  async draftsUpTo() { return { count: 0, drafts: [] }; }
  async taxes() { return []; }
  async sequences() { return []; }
  async postedMoveNumbers() { return []; }
  async erpOdooActive() { return false; }
}

test('runChecks: C3 = الافتتاح + Σ AccountEntry بعد البدء؛ انحراف عميل أحمر، وبانتظار الترحيل أصفر؛ شركة غير مفعّلة بلا فحوص', async () => {
  const store = new FakeCheckStore();
  store.arOpening.set('c1', 50_000n);
  store.entries.set('c1', 70_000n);
  store.arLedger.set('c1', 120_000n);
  store.arLedger.set('c2', 10_000n);
  store.entries.set('c2', 10_000n);
  let report = await runChecks(store, 't1');
  const keys = report.results.map((r) => r.key);
  assert.deepEqual(keys, ['C1', 'C2', 'C3', 'C4', 'C4b', 'C5', 'C8', 'C9', 'C10', 'C11', 'C12', 'C14', 'C15']);
  assert.equal(report.overall, 'GREEN');
  assert.equal(store.sinceSeen[0]?.toISOString(), '2027-03-10T11:58:00.000Z', 'صفوف ما بعد آخر نبضة − هامش');

  store.arLedger.set('c1', 125_000n);
  report = await runChecks(store, 't1', { only: ['C3'] });
  const c3 = report.results[0];
  assert.equal(c3.status, 'RED');
  assert.deepEqual([c3.rows[0].customerId, c3.rows[0].gapMilli, c3.rows[0].expectedMilli, c3.rows[0].name], ['c1', '5000', '120000', 'عميل c1']);
  assert.equal(report.overall, 'RED');

  store.pending.customerIds.add('c1');
  assert.equal((await runChecks(store, 't1', { only: ['C3'] })).results[0].status, 'YELLOW');
  store.pending.customerIds.clear();
  store.settings = { ...store.settings!, lastSyncAt: null };
  assert.equal((await runChecks(store, 't1', { only: ['C3'] })).results[0].status, 'YELLOW', 'لا نبضة بعد ⇒ أصفر');

  store.settings = { ...store.settings!, activatedAt: null };
  const off = await runChecks(store, 't1');
  assert.deepEqual([off.results.length, off.overall], [0, 'GREEN']);
});

// ═══ خطة الاستيراد: البند 6 (ج) صف افتتاحي حُذف بلا حدث، والبند 7 (ب) حركات مستوردة بعد البدء على 319002 ═══

function c3Input(p: Partial<C3Input>): C3Input {
  return {
    ledger: new Map(), opening: new Map(), entriesAfterCutover: new Map(), deletedOpeningImports: new Map(),
    names: new Map([['c1', 'عميل أول']]), pendingCustomers: new Set(), pendingAll: false, ...p,
  };
}

test('C3 (6 ج): صف افتتاحي محذوف بلا tombstone ⇒ تعمّق أحمر «حُذف بلا حدث» رغم تطابق c3Gaps؛ والحذف مع tombstone أخضر', () => {
  // الافتتاح شمل 300 (صفّا استيراد 100 و200)، ثم حُذف صف الـ100 في سباق مع الاعتماد بلا حدث: الأستاذ = الافتتاح
  const opening = new Map([['c1', 300_000n]]);
  const ledger = new Map([['c1', 300_000n]]);
  const noTomb = evaluateC3(c3Input({ ledger, opening, openingEntries: new Map([['c1', 200_000n]]) }));
  assert.equal(noTomb.status, 'RED');
  assert.equal(noTomb.rows.length, 1);
  assert.deepEqual(
    [noTomb.rows[0].kind, noTomb.rows[0].customerId, noTomb.rows[0].openingGapMilli, noTomb.rows[0].adjustable, noTomb.rows[0].name],
    [OPENING_DELETED_WITHOUT_EVENT, 'c1', '100000', false, 'عميل أول'],
  );
  assert.equal(noTomb.fix, null, 'لا قيد تصحيح من صف لا انحراف له في c3Gaps');
  assert.match(noTomb.summary, /حُذف بلا حدث/);
  assert.equal(noTomb.metrics.openingDeletedWithoutEvent, 1);

  // الحذف نفسه مع tombstone: حدث AR_ENTRY:REVERSE (شقيقه SKIPPED(OPENING)) ثم عكس مرحَّل على الأستاذ
  const withTomb = evaluateC3(c3Input({
    ledger: new Map([['c1', 200_000n]]), opening, openingEntries: new Map([['c1', 200_000n]]), deletedOpeningImports: new Map([['c1', 100_000n]]),
  }));
  assert.deepEqual([withTomb.status, withTomb.rows.length], ['GREEN', 0]);

  // بانتظار الترحيل ⇒ أصفر؛ ومخزن لا يقرأ الصفوف الافتتاحية (openingEntries غائب) ⇒ السلوك القديم أخضر
  assert.equal(evaluateC3(c3Input({ ledger, opening, openingEntries: new Map([['c1', 200_000n]]), pendingCustomers: new Set(['c1']) })).status, 'YELLOW');
  assert.equal(evaluateC3(c3Input({ ledger, opening })).status, 'GREEN');
  // انحراف c3Gaps أحمر مع الصف ⇒ قيد التصحيح لصف الانحراف وحده
  const both = evaluateC3(c3Input({ ledger: new Map([['c1', 305_000n]]), opening, openingEntries: new Map([['c1', 200_000n]]) }));
  assert.equal(both.fix, 'CONTROL_ADJUSTMENT');
  assert.deepEqual(both.rows.map((r) => [r.kind ?? 'GAP', r.adjustable]), [['GAP', true], [OPENING_DELETED_WITHOUT_EVENT, false]]);
});

test('C3 (6 ج): مجاميع الصفوف الافتتاحية بقاعدة computeDerivedOpening — إلغاء بلا أثر في النافذة يُسقط، والدور مرآة openingRowRole', () => {
  const groups = [
    { customerId: 'c1', invoiceId: null, receiptId: null, type: 'ADJUSTMENT_DEBIT', invoiceType: null, debit: 100.1, credit: 0 },
    { customerId: 'c1', invoiceId: 'i1', receiptId: null, type: 'INVOICE_DEBIT', invoiceType: 'CREDIT', debit: 50, credit: 0 },
    { customerId: 'c1', invoiceId: 'i1', receiptId: null, type: 'INVOICE_CREDIT', invoiceType: 'CREDIT', debit: 0, credit: 50 },
    // فاتورة مؤرخة مستقبلاً أُلغيت قبل البدء: صف الإلغاء وحده في النافذة ⇒ يُسقط
    { customerId: 'c2', invoiceId: 'i2', receiptId: null, type: 'INVOICE_CREDIT', invoiceType: 'CREDIT', debit: 0, credit: 70 },
    { customerId: 'c2', invoiceId: null, receiptId: 'r1', type: 'RECEIPT_CREDIT', invoiceType: null, debit: 0, credit: 20 },
  ];
  const totals = openingEntryTotalsFromGroups(groups, 2);
  assert.deepEqual([...totals.entries()], [['c1', 100_100n], ['c2', -20_000n]]);
  const combos = ['INVOICE_DEBIT', 'INVOICE_CREDIT', 'RECEIPT_DEBIT', 'RECEIPT_CREDIT', 'ADJUSTMENT_DEBIT'];
  for (const type of combos) {
    for (const invoiceType of [null, 'CREDIT', 'CASH', 'RETURN']) {
      for (const [invoiceId, receiptId] of [['i', null], [null, 'r'], ['i', 'r'], [null, null]] as const) {
        const e = { invoiceId, receiptId, type, invoiceType };
        assert.equal(openingEntryRole(e), openingRowRole(e), JSON.stringify(e));
      }
    }
  }
});

test('C3 (مراجعة 1): تعمّق الصفوف الافتتاحية يقرّب كل صف وحده — 1.005 + 2.005 + 3.125 بمنزلتين = 6150 كالقيد الافتتاحي ⇒ أخضر', () => {
  const rows = [1.005, 2.005, 3.125].map((debit) => ({ customerId: 'c1', invoiceId: null, receiptId: null, type: 'ADJUSTMENT_DEBIT', invoiceType: null, debit, credit: 0 }));
  // القيد الافتتاحي (computeDerivedOpening): toMilli لكل صف ثم الجمع
  const openMilli = rows.reduce((s, r) => s + toMilli(r.debit, 2) - toMilli(r.credit, 2), 0n);
  assert.equal(openMilli, 6_150n);
  // الخلل: مجموع Float واحد (groupBy) ثم التقريب ⇒ 6140 ⇒ «صف افتتاحي حُذف بلا حدث» أحمر دائم
  const summed = openingEntryTotalsFromGroups([{ ...rows[0], debit: rows.reduce((s, r) => s + r.debit, 0) }], 2);
  assert.equal(summed.get('c1'), 6_140n);
  // المسار الجديد: صفاً صفاً إلى مجموعات بالملّي ثم قاعدة الإسقاط
  const groups = [...openingEntryGroupsFromRows(rows, 2).values()];
  assert.equal(groups.length, 1);
  const totals = openingEntryTotalsFromGroups(groups, 2);
  assert.equal(totals.get('c1'), openMilli);
  const opening = new Map([['c1', openMilli]]);
  const c3 = evaluateC3(c3Input({ ledger: new Map(opening), opening, openingEntries: totals }));
  assert.deepEqual([c3.status, c3.rows.length], ['GREEN', 0]);
  // تجميع تدريجي عبر الصفحات يعطي المجموع نفسه، وقاعدة إسقاط الإلغاء بلا أثر تبقى تعمل على المجموعات
  const paged = new Map();
  openingEntryGroupsFromRows(rows.slice(0, 1), 2, paged);
  openingEntryGroupsFromRows([...rows.slice(1), { customerId: 'c2', invoiceId: 'i9', receiptId: null, type: 'INVOICE_CREDIT', invoiceType: 'CREDIT', debit: 0, credit: 1.005 }], 2, paged);
  const pagedTotals = openingEntryTotalsFromGroups([...paged.values()], 2);
  assert.deepEqual([...pagedTotals.entries()], [['c1', 6_150n]]);
  // المخزن الحقيقي يقرأ صفاً صفاً (لا groupBy على Float)
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'gl', 'checks', 'store.prisma.ts'), 'utf8');
  const body = src.slice(src.indexOf('async accountEntryOpeningTotals('), src.indexOf('async customerNames('));
  assert.doesNotMatch(body, /accountEntry\.groupBy/);
  assert.match(body, /openingEntryGroupsFromRows\(/);
});

function importFacts(netMilli: bigint): ImportAfterCutoverFacts {
  return {
    accountId: accountIdOf('319002'), accountCode: '319002', cutoverDate: '2027-01-01', netMilli, moveCount: 2,
    moves: [
      { moveId: 'm2', number: 'OPEN/2027/00003', date: '2027-02-10', attentionReason: 'حركة مستوردة بعد تاريخ البدء', amountMilli: -250_000n, reversal: false },
      { moveId: 'm1', number: 'OPEN/2027/00002', date: '2027-01-05', attentionReason: null, amountMilli: 40_000n, reversal: false },
    ],
  };
}

test('C9 (7 ب): صافي 319002 من قيود IMPORT بعد البدء ⇒ أصفر مع التعمّق إلى القيود؛ ومن دونه أخضر', async () => {
  const zero = [
    { key: 'POSTING_SUSPENSE' as const, accountId: SUSP, accountCode: '911001', balanceMilli: 0n, attentionMoves: [] },
    { key: 'BANK_SUSPENSE' as const, accountId: accountIdOf('112009'), accountCode: '112009', balanceMilli: 0n, attentionMoves: [] },
  ];
  const yellow = evaluateC9(zero, importFacts(-210_000n));
  assert.equal(yellow.status, 'YELLOW');
  assert.equal(yellow.fix, 'REVIEW_SUSPENSE');
  assert.deepEqual(yellow.rows.map((r) => r.kind), [IMPORT_AFTER_CUTOVER_ROW, 'IMPORT_MOVE', 'IMPORT_MOVE']);
  assert.deepEqual([yellow.rows[0].balanceMilli, yellow.rows[0].accountCode, yellow.rows[0].moveCount], ['-210000', '319002', 2]);
  assert.deepEqual([yellow.rows[1].moveId, yellow.rows[1].amountMilli], ['m2', '-250000']);
  assert.equal(yellow.metrics.importAfterCutoverMilli, '-210000');
  assert.match(yellow.summary, /319002/);
  // صافٍ صفري (حركة وعكسها) أو بلا حقائق ⇒ أخضر
  assert.equal(evaluateC9(zero, importFacts(0n)).status, 'GREEN');
  assert.equal(evaluateC9(zero).status, 'GREEN');

  // عبر runChecks: المخزن يُسأل بحساب OPENING_EQUITY وتاريخ البدء؛ والطريقة (ب) لا تُسأل
  const store = new FakeCheckStore();
  const asked: { accountId: string; cutoverDate: string }[] = [];
  store.mappedAccounts = async () => [{ key: 'OPENING_EQUITY', id: accountIdOf('319002'), code: '319002' }];
  Object.assign(store, {
    async importMovesAfterCutover(_t: string, input: { accountId: string; cutoverDate: string; limit: number }) {
      asked.push({ accountId: input.accountId, cutoverDate: input.cutoverDate });
      const f = importFacts(-210_000n);
      return { netMilli: f.netMilli, moveCount: f.moveCount, moves: f.moves };
    },
  });
  const r = (await runChecks(store, 't1', { only: ['C9'] })).results[0];
  assert.deepEqual([r.key, r.status], ['C9', 'YELLOW']);
  assert.deepEqual(asked, [{ accountId: accountIdOf('319002'), cutoverDate: '2027-01-01' }]);
  store.settings = { ...store.settings!, setupMethod: 'FULL_HISTORY' };
  assert.equal((await runChecks(store, 't1', { only: ['C9'] })).results[0].status, 'GREEN');
  assert.equal(asked.length, 1);
});

test('runChecks C3 (6 ج): المخزن يُسأل عن الصفوف الافتتاحية الحالية بنافذة البدء واللقطة، والطريقة (ب) لا تُسأل', async () => {
  const store = new FakeCheckStore();
  store.arOpening.set('c1', 300_000n);
  store.arLedger.set('c1', 300_000n);
  const windows: { cutoverStart: Date; openingSnapshotAt: Date }[] = [];
  Object.assign(store, {
    async accountEntryOpeningTotals(_t: string, w: { cutoverStart: Date; openingSnapshotAt: Date }) {
      windows.push(w);
      return new Map([['c1', 200_000n]]);
    },
  });
  const c3 = (await runChecks(store, 't1', { only: ['C3'] })).results[0];
  assert.equal(c3.status, 'RED');
  assert.equal(c3.rows[0].kind, OPENING_DELETED_WITHOUT_EVENT);
  assert.deepEqual(windows.map((w) => [w.cutoverStart.toISOString(), w.openingSnapshotAt.toISOString()]), [['2026-12-31T21:00:00.000Z', '2027-01-15T09:00:00.000Z']]);
  store.settings = { ...store.settings!, setupMethod: 'FULL_HISTORY' };
  assert.equal((await runChecks(store, 't1', { only: ['C3'] })).results[0].status, 'GREEN');
  assert.equal(windows.length, 1);
});

test('حارس ثابت: مخزن الفحوص يقرأ قيود IMPORT بعد البدء بلا وصول متأخر ومصدرها POST مع عكوسها، والقواعد لا تستورد opening.ts', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'gl', 'checks', 'store.prisma.ts'), 'utf8');
  const body = src.slice(src.indexOf('async importMovesAfterCutover('), src.indexOf('async draftsUpTo('));
  assert.match(body, /moveType: 'IMPORT', date: \{ gte: toDbDate\(input\.cutoverDate\) \}, lateArrival: false/);
  assert.match(body, /reversedMoveId: null, sources: \{ some: \{ event: 'POST' \} \}/);
  assert.match(body, /reversedMove: \{ is: base \}/);
  const rules = fs.readFileSync(path.join(__dirname, '..', 'services', 'gl', 'checks', 'rules.ts'), 'utf8');
  assert.doesNotMatch(rules, /from '\.\.\/opening'/);
  assert.doesNotMatch(src, /from '\.\.\/opening'/, 'opening.ts يجرّ config/database إلى المجدول');
});
