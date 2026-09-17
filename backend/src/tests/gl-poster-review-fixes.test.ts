// M3 — إصلاحات مراجعة المُرحِّل (DESIGN.md §5.4، §5.5 P7/P8/P9، §5.6، §6.1، §8.1 D2). بلا قاعدة: المخزن المزيّف والمُرحِّل الحقيقي.
//  1. تقسيم الاستلامات المشمولة بالافتتاح يُجمَّد: وصول سند متأخر بتاريخ سابق لا يقلب C4 أحمر، وعكس الاستلام لا يعيد covered لم يُقيد.
//  2. الإلغاء يتبع أصله: فاتورة مؤرخة مستقبلاً أُلغيت قبل البدء ⇒ POST وREVERSE معاً وصافي الإيراد والضريبة و113001 صفر.
//  3. ترتيب P7 بالمؤشر الفعّال max(المؤشر، الأفق) حين لا صفوف غير مقروءة — دون تحريك المؤشر.
//  4. إعادة الترحيل من المصدر للاستلام تأخذ المعلّق من القيد الحيّ: فاتورة نقدية لاحقة بتاريخ سابق لا تغيّر 111001/911001.
//  7. أخطاء الاتصال العابرة (P2024/P2028/…) لا تُحتسب محاولة.
// 11. D2: السياق يُعاد تحميله تحت القفل حين تتغير GlSettings أثناء النبضة؛ وإعادة ترحيل عمولة قبل التاريخ بلا 116001.
// 12. ADR‑11: عكس صف مستورد بتاريخ قيد أصله (البدء للمشمول بالافتتاح أو lateArrival، وإلا القيد الحي) ثم إزاحة الإقفال.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_ACTOR } from '../services/gl/audit';
import { accountIdOf } from '../services/gl/testing/fixtures';
import { invoicePayloadFromRows } from '../services/gl/builders/invoice';
import { custodyComponents, custodyC4Gap, type CustodyComponentsInput } from '../services/gl/custody';
import {
  computeDerivedOpening, openingCutoff, openingRowRole, type OpeningAccountEntryRow, type OpeningSources,
} from '../services/gl/opening';
import { alignReversalsToOrigin, openingSettlementEventRows } from '../services/gl/backfill';
import { invoiceKey, paylinkFeeKey, receiptKey, settlementKey } from '../services/gl/sync/keys';
import {
  TRANSIENT_DB_ERROR_CODES, createSyncBudget, effectiveAccountEntryWatermark, isTransientDbError, runPoster, settlementRebuildInputs,
} from '../services/gl/sync/poster';
import { repostFromSource, type RepostMoveFacts } from '../services/gl/sync/repost';
import { LATE_COMMIT_WINDOW_MS, type DesiredEvent, type SourceEventPayload } from '../services/gl/sync/types';
import { FakePostingStore, type FakeMove } from './gl-fake-posting-store';
import { arEntryKey } from '../services/gl/sync/keys';
import { arEntryTombstoneEvents } from '../services/gl/sync/tombstone';
import { importReversalPlan } from '../services/gl/sync/poster';
import { applyAutoLockShift, type LockDates } from '../services/gl/locks';
import { evaluateC3 } from '../services/gl/checks/rules';
import type { PostingTx, WithPostLockOptions } from '../services/gl/sync/postingStore';
import type { MoveDraft } from '../services/gl/types';

const at = (iso: string) => new Date(iso);
const AR = accountIdOf('113001');
const CUSTODY = accountIdOf('111003');
const CASH = accountIdOf('111001');
const SUSPENSE = accountIdOf('911001');
const VAT_OUT = accountIdOf('212001');
const INPUT_VAT = accountIdOf('116001');
const quiet = { log: () => undefined };
const run = (s: FakePostingStore) => runPoster(s, s.settings, createSyncBudget({ timeMs: 60_000, events: 300 }), quiet);

function clockAt(iso: string) {
  let t = at(iso).getTime();
  return { now: () => t, set: (x: string) => { t = at(x).getTime(); }, advance: (ms: number) => { t += ms; } };
}

function factsOf(s: FakePostingStore, m: FakeMove): RepostMoveFacts {
  const sources = [...s.state.sources.entries()].filter(([, id]) => id === m.id).map(([sourceKey]) => ({
    sourceKey, sourceType: m.sourceType ?? '', sourceId: m.sourceId ?? '', event: 'POST',
  }));
  return { id: m.id, number: m.number, state: 'POSTED', origin: 'AUTO', date: m.date, originalDate: m.originalDate, lateArrival: m.lateArrival, secureHash: null, sources };
}
const repost = (s: FakePostingStore, m: FakeMove) => s.withPostLock('t1', (tx) => repostFromSource(tx, { move: factsOf(s, m), actor: SYSTEM_ACTOR, timezone: 'Asia/Riyadh' }));

function settlementEvent(id: string, amount: string, settledAt: string, createdAt = settledAt): DesiredEvent {
  return {
    sourceKey: settlementKey(id, 'POST'), sourceType: 'SETTLEMENT', sourceId: id, event: 'POST', effectAt: at(settledAt),
    payload: { settlementId: id, amount, method: 'CASH', salesRepId: 'rep1', settledAt, createdAt, salesRepName: 'مندوب', sourceCreatedAt: createdAt } as SourceEventPayload,
  };
}

// ═══ (1) تجميد تقسيم الاستلام المشمول بالافتتاح ═══

const TZ = 'Asia/Riyadh';
const CUT = openingCutoff('2026-07-01', TZ, at('2026-07-05T09:00:00.000Z'));
const ROUTING = { receiptRouting: { CASH: 'CUSTODY' as const }, cashInvoiceRouting: 'MAIN_CASH' as const };

test('(1) الافتتاح يعيد تقسيم كل استلام مشمول، والسند الواصل متأخراً بتاريخ سابق لا يدخله', () => {
  const lateA: OpeningAccountEntryRow = {
    id: 'aeA', customerId: 'c1', invoiceId: null, receiptId: 'rA', type: 'RECEIPT_CREDIT', debit: 0, credit: 100,
    entryDate: at('2026-06-10T08:00:00.000Z'), createdAt: at('2026-07-10T08:00:00.000Z'),
  };
  const src: OpeningSources = {
    accountEntries: [lateA], receipts: [{ id: 'rA', salesRepId: 'rep1', paymentMethod: 'CASH', amount: 100 }], cashInvoices: [],
    settlements: [{ id: 'S', salesRepId: 'rep1', amount: 100, settledAt: at('2026-06-15T08:00:00.000Z'), createdAt: at('2026-06-15T08:00:00.000Z') }],
    settlementEntries: [],
  };
  const d = computeDerivedOpening(src, CUT, { decimals: 2, routing: ROUTING });
  assert.equal(d.custodyTotalMilli, 0n, 'OPEN 111003 = 0');
  assert.deepEqual(d.settlementSplits.S, { salesRepId: 'rep1', nonCustodyClearedMilli: 100_000n, shortageRecoveredMilli: 0n });

  // التجميد: حدث POST بحالة SKIPPED(OPENING) يحمل r وrecovered
  const rows = openingSettlementEventRows('t1', [settlementEvent('S', '100.00', '2026-06-15T08:00:00.000Z'), settlementEvent('X', '5.00', '2026-06-16T08:00:00.000Z')], {
    splits: d.settlementSplits, processedAt: at('2026-07-05T09:10:00.000Z'),
  });
  assert.equal(rows.length, 1, 'استلام غير مشمول لا يُجمَّد');
  assert.equal(rows[0].status, 'SKIPPED');
  assert.equal(rows[0].skipReason, 'OPENING');
  assert.equal(rows[0].nonCustodyClearedMilli, 100_000n);
  assert.equal(rows[0].shortageRecoveredMilli, 0n);

  // الإعادة (C4 وP7 اللاحق): السند A بتاريخ 06-10 ثم S بالتقسيم المخزَّن ⇒ ledgerCustody = 100 = OPEN(0) + A المرحّل(100)
  const replay = (stored: boolean): CustodyComponentsInput => ({
    receipts: [{ id: 'rA', salesRepId: 'rep1', amountMilli: 100_000n, effectAt: '2026-06-10T08:00:00.000Z', createdAt: '2026-07-10T08:00:00.000Z' }],
    onlineReceipts: [], outsideReceipts: [], cashInvoices: [], shortages: [], custodyExpenses: [],
    settlements: [{
      id: 'S', salesRepId: 'rep1', amountMilli: 100_000n, effectAt: '2026-06-15T08:00:00.000Z', createdAt: '2026-06-15T08:00:00.000Z',
      nonCustodyClearedMilli: stored ? rows[0].nonCustodyClearedMilli as bigint : null, shortageRecoveredMilli: stored ? 0n : null,
    }],
    routing: { cashInvoice: 'MAIN_CASH' },
  });
  const ledger111003 = d.custodyTotalMilli + 100_000n;
  const frozen = custodyComponents(replay(true)).rep1;
  assert.equal(frozen.ledgerCustody, 100_000n);
  assert.equal(custodyC4Gap(ledger111003, frozen), 0n, 'C4 أخضر');
  // بلا التجميد: الإعادة تشتق covered = 100 فيبقى C4 أحمر بـ+100 إلى الأبد
  assert.equal(custodyC4Gap(ledger111003, custodyComponents(replay(false)).rep1), 100_000n);
});

test('(1) عكس استلام مشمول بالافتتاح بتقسيمه المجمَّد لا يعيد covered لم يُقيد على 111003', async () => {
  const settledAt = '2027-01-10T08:00:00.000Z';
  const custody = (): CustodyComponentsInput => ({
    receipts: [{ id: 'rA', salesRepId: 'rep1', amountMilli: 100_000n, effectAt: '2027-01-05T08:00:00.000Z', createdAt: '2027-01-20T08:00:00.000Z' }],
    onlineReceipts: [], outsideReceipts: [], cashInvoices: [], shortages: [], custodyExpenses: [],
    settlements: [{
      id: 'S', salesRepId: 'rep1', amountMilli: 100_000n, effectAt: settledAt, createdAt: settledAt, reversedAt: '2027-02-01T08:00:00.000Z',
      nonCustodyClearedMilli: 100_000n, shortageRecoveredMilli: 0n,
    }],
    routing: { cashInvoice: 'MAIN_CASH' },
  });
  const s = new FakePostingStore({ now: () => at('2027-02-02T10:00:00.000Z').getTime(), custody });
  s.setCursor('ACCOUNT_ENTRY', at('2027-02-02T00:00:00.000Z'), 'z');
  const post = settlementEvent('S', '100.00', settledAt);
  s.seedEvents([{ ...post, status: 'SKIPPED', skipReason: 'OPENING' }]);
  Object.assign(s.event(post.sourceKey)!, { nonCustodyClearedMilli: 100_000n, shortageRecoveredMilli: 0n });
  s.seedEvents([{ ...post, sourceKey: settlementKey('S', 'REVERSE'), event: 'REVERSE', effectAt: at('2027-02-01T08:00:00.000Z') }]);
  await run(s);
  const rev = s.event(settlementKey('S', 'REVERSE'))!;
  assert.equal(rev.status, 'DONE');
  const m = s.state.moves.get(rev.moveId!)!;
  assert.equal(m.lines.filter((l) => l.accountId === CUSTODY).length, 0, 'covered المجمَّد = 0 ⇒ لا سطر 111003');
  assert.equal(s.balance(CUSTODY), 0n);
});

// ═══ (2) الإلغاء يتبع أصله ═══

function creditInvoicePost(id: string, entryDate: string, createdAt: string): DesiredEvent {
  const payload = invoicePayloadFromRows({
    invoice: { id, number: `INV-${id}`, type: 'CREDIT', customerId: 'c1', salesRepId: null, pricesIncludeTax: false, subtotal: 100, discountAmt: 0, taxAmt: 15, total: 115 },
    items: [{ qty: 1, unitPrice: 100, taxPct: 15, taxAmt: 15, lineTotal: 115 }],
    customerName: 'عميل', entryDate, currency: 'SAR', currencyDecimals: 2,
  });
  return {
    sourceKey: invoiceKey(id, 'POST'), sourceType: 'INVOICE', sourceId: id, event: 'POST', effectAt: at(`${entryDate}T05:00:00.000Z`),
    payload: { ...payload, sourceCreatedAt: createdAt } as SourceEventPayload,
  };
}

test('(2) الافتتاح يُسقط صف إلغاء مستند لا أثر له فيه (مؤرخ مستقبلاً وأُلغي قبل البدء)', () => {
  const cancel: OpeningAccountEntryRow = {
    id: 'aeX2', customerId: 'c1', invoiceId: 'X', receiptId: null, type: 'INVOICE_CREDIT', debit: 0, credit: 115,
    entryDate: at('2026-06-25T08:00:00.000Z'), createdAt: at('2026-06-25T08:00:00.000Z'), invoiceType: 'CREDIT',
  };
  const effect: OpeningAccountEntryRow = { ...cancel, id: 'aeX1', type: 'INVOICE_DEBIT', debit: 115, credit: 0, entryDate: at('2026-07-05T08:00:00.000Z'), createdAt: at('2026-06-20T08:00:00.000Z') };
  const receiptCancel: OpeningAccountEntryRow = {
    id: 'aeR2', customerId: 'c2', invoiceId: null, receiptId: 'R', type: 'RECEIPT_DEBIT', debit: 50, credit: 0,
    entryDate: at('2026-06-25T08:00:00.000Z'), createdAt: at('2026-06-25T08:00:00.000Z'),
  };
  const d = computeDerivedOpening({
    accountEntries: [effect, cancel, receiptCancel], receipts: [{ id: 'R', salesRepId: 'rep1', paymentMethod: 'CASH', amount: 50 }],
    cashInvoices: [], settlements: [], settlementEntries: [],
  }, CUT, { decimals: 2, routing: ROUTING });
  assert.equal(d.receivablesTotalMilli, 0n, 'ذمم افتتاحية 0 لا −115 ولا +50');
  assert.equal(d.counts.accountEntriesIncluded, 0);
  assert.equal(d.counts.accountEntriesExcluded, 3);
  // المرتجع: INVOICE_CREDIT أثر لا إلغاء
  assert.equal(openingRowRole({ ...cancel, invoiceType: 'RETURN' }), 'EFFECT');
  assert.equal(openingRowRole({ ...cancel, invoiceType: null }), null, 'نوع مجهول ⇒ لا إسقاط');
  const ret = computeDerivedOpening({ accountEntries: [{ ...cancel, invoiceType: 'RETURN' }], receipts: [], cashInvoices: [], settlements: [], settlementEntries: [] }, CUT, { decimals: 2, routing: ROUTING });
  assert.equal(ret.receivablesTotalMilli, -115_000n, 'مرتجع قبل البدء يبقى في الافتتاح');
});

test('(2) الفحص لمرة واحدة يحاذي REVERSE إلى أثر POST، والمُرحِّل يرحّلهما بصافي صفر على الإيراد والضريبة و113001', async () => {
  const post = creditInvoicePost('X', '2027-01-05', '2026-12-20T08:00:00.000Z');
  const reverse: DesiredEvent = {
    sourceKey: invoiceKey('X', 'REVERSE'), sourceType: 'INVOICE', sourceId: 'X', event: 'REVERSE', effectAt: at('2026-12-25T08:00:00.000Z'),
    payload: { invoiceId: 'X', type: 'CREDIT', entryDate: '2026-12-25', sourceCreatedAt: '2026-12-25T08:00:00.000Z' } as SourceEventPayload,
  };
  const aligned = alignReversalsToOrigin([post, reverse], TZ);
  assert.equal(aligned[1].effectAt.toISOString(), post.effectAt.toISOString());
  assert.equal((aligned[1].payload as { entryDate: string }).entryDate, '2027-01-05');

  // المُرحِّل وحده (حتى بلا محاذاة، كما يدرجه المُطابِق): العكس لا يُصنَّف «مشمولاً بالافتتاح»
  const clock = clockAt('2027-01-20T10:00:00.000Z');
  const s = new FakePostingStore({ now: clock.now });
  s.seedEvents([post, reverse]);
  await run(s);
  clock.advance(2 * 60_000);
  await run(s);
  assert.equal(s.event(post.sourceKey)!.status, 'DONE');
  const rev = s.event(reverse.sourceKey)!;
  assert.equal(rev.status, 'DONE', `REVERSE ${rev.status} ${rev.skipReason ?? ''} ${rev.lastError ?? ''}`);
  assert.equal(s.balance(AR, 'c1'), 0n);
  assert.equal(s.balance(VAT_OUT), 0n);
  assert.equal(s.balance(accountIdOf('411001')), 0n);

  // السند النقدي للمندوب: الإلغاء قبل الأثر ⇒ العهدة المعادة صفر، والأستاذ بعد POST وREVERSE صفر ⇒ C4 أخضر
  const receiptAligned = alignReversalsToOrigin([
    { sourceKey: receiptKey('R', 'POST'), sourceType: 'RECEIPT', sourceId: 'R', event: 'POST', effectAt: at('2027-01-05T05:00:00.000Z'), payload: null },
    { sourceKey: receiptKey('R', 'REVERSE'), sourceType: 'RECEIPT', sourceId: 'R', event: 'REVERSE', effectAt: at('2026-12-25T08:00:00.000Z'), payload: null },
  ], TZ);
  assert.equal(receiptAligned[1].effectAt.toISOString(), '2027-01-05T05:00:00.000Z');
  const c = custodyComponents({
    receipts: [{ id: 'R', salesRepId: 'rep1', amountMilli: 50_000n, effectAt: '2027-01-05T05:00:00.000Z', reversedAt: '2026-12-25T08:00:00.000Z' }],
    onlineReceipts: [], outsideReceipts: [], cashInvoices: [], settlements: [], shortages: [], custodyExpenses: [], routing: { cashInvoice: 'MAIN_CASH' },
  }).rep1;
  assert.equal(custodyC4Gap(50_000n - 50_000n, c), 0n);
});

// ═══ (3) المؤشر الفعّال لترتيب P7 ═══

test('(3) استلام آخر عمليات اليوم: BLOCKED قبل الأفق، ثم DONE بلا تحريك المؤشر حين لا صفوف غير مقروءة', async () => {
  let unread = false;
  const clock = clockAt('2027-02-11T14:05:00.000Z'); // 17:05 بالرياض
  const s = new FakePostingStore({ now: clock.now, unreadAccountEntries: () => unread });
  s.setCursor('ACCOUNT_ENTRY', at('2027-02-11T13:00:00.000Z'), 'last'); // آخر سند 16:00
  const st = settlementEvent('S', '100.00', '2027-02-11T14:00:00.000Z');
  s.seedEvents([st]);
  await run(s);
  assert.equal(s.event(st.sourceKey)!.status, 'BLOCKED', 'قبل مرور LATE_COMMIT_WINDOW على إنشاء الاستلام');

  clock.set('2027-02-11T14:21:00.000Z');
  assert.ok(clock.now() - at('2027-02-11T14:00:00.000Z').getTime() > LATE_COMMIT_WINDOW_MS);
  unread = true;
  await run(s);
  assert.equal(s.event(st.sourceKey)!.status, 'BLOCKED', 'صف AccountEntry غير مقروء قبل الأفق يُبقيه محجوباً');

  clock.advance(60 * 60_000);
  unread = false;
  await run(s);
  assert.equal(s.event(st.sourceKey)!.status, 'DONE');
  const c = s.state.cursors.get('ACCOUNT_ENTRY')!;
  assert.equal(c.watermarkAt.toISOString(), '2027-02-11T13:00:00.000Z', 'المؤشر نفسه لم يتحرك');
  assert.equal(c.watermarkId, 'last');

  const eff = await effectiveAccountEntryWatermark(s, 't1', at('2027-02-11T16:00:00.000Z'));
  assert.equal(eff!.at.toISOString(), new Date(at('2027-02-11T16:00:00.000Z').getTime() - LATE_COMMIT_WINDOW_MS).toISOString());
  unread = true;
  assert.equal((await effectiveAccountEntryWatermark(s, 't1', at('2027-02-11T16:00:00.000Z')))!.id, 'last');
});

// ═══ (4) إعادة ترحيل الاستلام: المعلّق من القيد الحيّ ═══

test('(4) إعادة الترحيل بعد فاتورة نقدية بتاريخ سابق: صافي 111001 و911001 صفر، ولا NO_MOVE حين الفاتورة ≥ الاستلام', async () => {
  for (const invoiceTotal of [40_000n, 150_000n]) {
    const settledAt = '2027-02-10T09:00:00.000Z';
    const cashInvoices: CustodyComponentsInput['cashInvoices'][number][] = [];
    const s: FakePostingStore = new FakePostingStore({
      now: () => at('2027-03-01T10:00:00.000Z').getTime(),
      custody: () => ({
        receipts: [], onlineReceipts: [], outsideReceipts: [], cashInvoices: [...cashInvoices], shortages: [], custodyExpenses: [],
        settlements: [{
          id: 'S', salesRepId: 'rep1', amountMilli: 100_000n, effectAt: settledAt, createdAt: settledAt,
          nonCustodyClearedMilli: s.event(settlementKey('S', 'POST'))?.nonCustodyClearedMilli ?? null,
          shortageRecoveredMilli: s.event(settlementKey('S', 'POST'))?.shortageRecoveredMilli ?? null,
        }],
        routing: { cashInvoice: 'MAIN_CASH' },
      }),
    });
    s.setCursor('ACCOUNT_ENTRY', at('2027-02-11T00:00:00.000Z'), 'z');
    s.seedEvents([settlementEvent('S', '100.00', settledAt)]);
    await run(s);
    const ev = s.event(settlementKey('S', 'POST'))!;
    assert.equal(ev.status, 'DONE');
    assert.equal(ev.nonCustodyClearedMilli, 100_000n);
    const move = s.state.moves.get(ev.moveId!)!;
    assert.equal(s.balance(SUSPENSE), -100_000n, 'suspense 100');
    const [cashBefore, suspBefore] = [s.balance(CASH), s.balance(SUSPENSE)];

    // فاتورة نقدية للمندوب أُدخلت لاحقاً بتاريخ قبل الاستلام ⇒ العتبة المعاد اشتقاقها تتغير
    cashInvoices.push({ id: 'ci', salesRepId: 'rep1', amountMilli: invoiceTotal, effectAt: '2027-02-09T08:00:00.000Z', createdAt: '2027-02-20T08:00:00.000Z' });
    const r = await repost(s, move);
    assert.ok(r.repost.id);
    assert.equal(s.balance(CASH), cashBefore, `111001 بلا تغيير (${invoiceTotal})`);
    assert.equal(s.balance(SUSPENSE), suspBefore, `911001 بلا تغيير (${invoiceTotal})`);
  }
  // الدالة الصرفة: المعلّق من Σ مدين القيد
  const inputs = settlementRebuildInputs({ amountMilli: 100_000n, coveredMilli: 0n, recoveredMilli: 0n, nonCustodyClearedMilli: 100_000n, suspenseMilli: 0n }, 100_000n);
  assert.equal(inputs.priorSuspenseMilli, 0n);
  assert.equal(inputs.custodyBalanceMilli, 0n);
});

// ═══ (7) أخطاء الاتصال العابرة ═══

test('(7) P2028/P2024 لا تزيد attempts ولا تُدخل سلّم التراجع؛ الخطأ العادي يزيدها', async () => {
  assert.deepEqual([...TRANSIENT_DB_ERROR_CODES], ['P2024', 'P2028', 'P1001', 'P1017']);
  assert.equal(isTransientDbError(Object.assign(new Error('x'), { code: 'P2002' })), false);
  let fail: Error | null = Object.assign(new Error('Transaction API error: Unable to start a transaction in the given time.'), { code: 'P2028' });
  const clock = clockAt('2027-02-20T10:00:00.000Z');
  const s = new FakePostingStore({ now: clock.now, beforePostMove: () => { if (fail) throw fail; } });
  const inv = creditInvoicePost('T', '2027-02-10', '2027-02-10T05:00:00.000Z');
  s.seedEvents([inv]);
  const r1 = await run(s);
  let ev = s.event(inv.sourceKey)!;
  assert.equal(ev.attempts, 0);
  assert.equal(ev.status, 'PENDING');
  assert.equal(r1.errors, 0);
  assert.equal(r1.keptPending, 1);

  fail = new Error('boom');
  await run(s);
  ev = s.event(inv.sourceKey)!;
  assert.equal(ev.attempts, 1);
  assert.equal(ev.status, 'ERROR');

  fail = null;
  clock.advance(2 * 60_000);
  await run(s);
  assert.equal(s.event(inv.sourceKey)!.status, 'DONE');
});

// ═══ (11) D2: السياق الساري لحظة الترحيل ═══

function feeEvent(id: string, createdAt: string): DesiredEvent {
  return {
    sourceKey: paylinkFeeKey(id), sourceType: 'PAYLINK_FEE', sourceId: id, event: 'POST', effectAt: at(createdAt),
    payload: { entryId: id, amount: '-41.00', feeNet: '35.65', feeVat: '5.35', createdAt, linkId: 'link-1', note: null, sourceCreatedAt: createdAt } as SourceEventPayload,
  };
}

test('(11) حفظ paylinkFeeTaxInvoiceFrom أثناء النبضة: العمولة التالية تُبنى بالتاريخ الجديد (نسخة الإعدادات تحت القفل)', async () => {
  for (const bumpVersion of [true, false]) {
    let version = 1;
    let posted = 0;
    const s: FakePostingStore = new FakePostingStore({
      now: () => at('2027-03-01T10:00:00.000Z').getTime(),
      settingsVersion: () => version,
      beforePostMove: () => {
        posted++;
        if (posted === 1) {
          // المالك يحفظ D2 بعد تحميل السياق في أول حدث (PUT يأخذ قفل gl-post بين معاملتين)
          s.opts.context = { settings: { paylinkFeeTaxInvoiceFrom: '2027-02-15' } };
          if (bumpVersion) version = 2;
        }
      },
    });
    s.seedEvents([creditInvoicePost('I', '2027-02-10', '2027-02-10T05:00:00.000Z'), feeEvent('F', '2027-02-20T08:00:00.000Z')]);
    await run(s);
    const fee = s.event(paylinkFeeKey('F'))!;
    assert.equal(fee.status, 'DONE');
    const m = s.state.moves.get(fee.moveId!)!;
    const vat = m.lines.filter((l) => l.accountId === INPUT_VAT).length;
    if (bumpVersion) assert.equal(vat, 1, 'مستردة: سطر 116001');
    else assert.equal(vat, 0, 'بلا تغيّر نسخة الإعدادات يبقى السياق المخزَّن (الشاهد على الخلل)');
  }
});

test('(11) إعادة ترحيل عمولة تاريخها قبل paylinkFeeTaxInvoiceFrom ⇒ قيد بلا سطر 116001', async () => {
  const s = new FakePostingStore({ now: () => at('2027-03-10T10:00:00.000Z').getTime(), context: { settings: { paylinkFeeTaxInvoiceFrom: '2027-03-01' } } });
  s.seedEvents([feeEvent('F', '2027-02-20T08:00:00.000Z')]);
  await run(s);
  const fee = s.event(paylinkFeeKey('F'))!;
  const move = s.state.moves.get(fee.moveId!)!;
  const r = await repost(s, move);
  const reposted = s.state.moves.get(r.repost.id)!;
  assert.equal(reposted.lines.filter((l) => l.accountId === INPUT_VAT).length, 0);
  assert.equal(move.lines.filter((l) => l.accountId === INPUT_VAT).length, 0);
});

// ═══ (12) ADR‑11: تاريخ عكس الاستيراد = تاريخ الأصل المحاسبي لا يوم التراجع ═══

// البدء 2026-09-01 بتوقيت الرياض، واللقطة T0 = 2026-09-03T09:00Z
const IMP_SETTINGS = {
  cutoverDate: '2026-09-01', openingSnapshotAt: at('2026-09-03T09:00:00.000Z'), activatedAt: at('2026-09-03T09:00:00.000Z'),
};
const OPEQ = accountIdOf('319002');
const AR_SCOPE = { journalType: null, touchesReceivable: true, touchesPayable: false, touchesTax: false };

/** FakePostingStore بإزاحة الإقفال (ADR‑7) كما يطبّقها postMove الحقيقي بـlockPolicy SHIFT (والعكس الآلي يمر بها أيضاً) */
class LockedStore extends FakePostingStore {
  locks: LockDates = { salesLockDate: null, purchaseLockDate: null, taxLockDate: null, hardLockDate: null };
  async withPostLock<T>(tenantId: string, fn: (tx: PostingTx) => Promise<T>, opts?: WithPostLockOptions): Promise<T> {
    const store = this;
    return super.withPostLock(tenantId, (tx) => {
      const base = tx.postMove.bind(tx);
      const ext = Object.create(tx) as PostingTx;
      ext.postMove = (draft: MoveDraft, o: Parameters<PostingTx['postMove']>[1]) => base(applyAutoLockShift(draft, store.locks, AR_SCOPE), o);
      return fn(ext);
    }, opts);
  }
}

function importRow(id: string, entryDate: string, createdAt: string, debit: number) {
  return { id, customerId: 'c1', customerName: 'عميل مستورد', debit, credit: 0, description: 'رصيد مستورد', entryDate: at(entryDate), createdAt: at(createdAt) };
}

/** حدث POST كما يكتبه المُطابِق (الحمولة نفسها التي يلتقطها الـtombstone) */
function importPost(row: ReturnType<typeof importRow>, extra: Partial<DesiredEvent> = {}): DesiredEvent {
  const [post] = arEntryTombstoneEvents([row], 2, { deletedAt: row.createdAt });
  return { ...post, status: 'PENDING', ...extra };
}

const importTombstone = (row: ReturnType<typeof importRow>, deletedAt: string) => arEntryTombstoneEvents([row], 2, { deletedAt: at(deletedAt) });

/** رصيد 113001 للعميل كما في تاريخ (قيود تاريخها ≤ asOf) */
function arAsOf(s: FakePostingStore, asOf: string, customerId = 'c1'): bigint {
  let t = 0n;
  for (const m of s.state.moves.values()) {
    if (m.date > asOf) continue;
    for (const l of m.lines) if (l.accountId === AR && l.customerId === customerId) t += l.debitMilli - l.creditMilli;
  }
  return t;
}

/** قيد الافتتاح (opening.ts) بتاريخ البدء − 1: 113001 للعميل مقابل 319002 */
function seedOpening(s: FakePostingStore, milli: bigint): void {
  s.state.seq++;
  s.state.idSeq++;
  const line = (accountId: string, debitMilli: bigint, creditMilli: bigint, customerId: string | null) => ({
    accountId, label: 'افتتاح', debitMilli, creditMilli, customerId, salesRepId: null, partnerName: null, analyticAccountId: null, taxId: null, taxRole: null, taxBaseMilli: null,
  });
  const id = `mv${s.state.idSeq}`;
  s.state.moves.set(id, {
    id, number: 'OPEN/2026/0001', date: '2026-08-31', originalDate: null, lateArrival: false, seq: s.state.seq, sourceType: null, sourceId: null,
    reversedMoveId: null, reversalId: null, needsAttention: false, lines: [line(AR, milli, 0n, 'c1'), line(OPEQ, 0n, milli, null)],
  });
}

test('(12) ADR‑11: افتتاح 5,000 ثم تراجع 10-05 وإعادة استيراد 5,500 بتاريخ 08-31 ⇒ 113001 كما في 09-15 = 5,500 وكما في اليوم = 5,500، وC3 أخضر', async () => {
  const clock = clockAt('2026-10-05T10:00:00.000Z');
  const s = new FakePostingStore({ now: clock.now, settings: IMP_SETTINGS });
  const original = importRow('ae1', '2026-08-20T09:00:00.000Z', '2026-08-25T09:00:00.000Z', 5000);
  seedOpening(s, 5_000_000n);
  // حسم التفعيل: الصف مشمول بالافتتاح
  s.seedEvents([importPost(original, { status: 'SKIPPED', skipReason: 'OPENING' })]);

  // التراجع بعد التفعيل في 10-05 (tombstone بالحمولة الكاملة؛ شقيق POST القائم لا يُمس)، ثم إعادة الاستيراد المصحَّح
  s.seedEvents(importTombstone(original, '2026-10-05T10:00:00.000Z'));
  const corrected = importRow('ae2', '2026-08-30T21:00:00.000Z', '2026-10-05T10:05:00.000Z', 5500); // 08-31 بالرياض
  s.seedEvents([importPost(corrected)]);
  clock.advance(10 * 60_000);
  await run(s);

  const rev = s.event(arEntryKey('ae1', 'REVERSE'))!;
  const post = s.event(arEntryKey('ae2', 'POST'))!;
  assert.equal(rev.status, 'DONE');
  assert.equal(post.status, 'DONE');
  const revMove = s.state.moves.get(rev.moveId!)!;
  assert.equal(revMove.date, '2026-09-01', 'العكس بتاريخ البدء لا بيوم التراجع');
  assert.equal(revMove.lateArrival, false);
  assert.equal(s.state.moves.get(post.moveId!)!.date, '2026-09-01', 'إعادة الاستيراد وصول متأخر بتاريخ البدء');

  assert.equal(arAsOf(s, '2026-08-31'), 5_000_000n, 'الافتتاح');
  assert.equal(arAsOf(s, '2026-09-15'), 5_500_000n, 'كما في 09-15: لا مضاعفة (قبل ADR‑11 كانت 10,500)');
  assert.equal(arAsOf(s, '2026-10-05'), 5_500_000n, 'كما في اليوم');
  assert.equal(s.balance(AR, 'c1'), 5_500_000n);

  const c3 = evaluateC3({
    ledger: new Map([['c1', s.balance(AR, 'c1')]]), opening: new Map([['c1', 5_000_000n]]),
    entriesAfterCutover: new Map([['c1', 5_500_000n]]), deletedOpeningImports: new Map([['c1', 5_000_000n]]),
    openingEntries: new Map(), names: new Map([['c1', 'عميل مستورد']]), pendingCustomers: new Set(), pendingAll: false,
  });
  assert.equal(c3.status, 'GREEN');
});

test('(12) ADR‑11: أصل مُرحَّل بعد البدء ⇒ العكس بتاريخ القيد الحي؛ وأصل lateArrival ⇒ بتاريخ البدء', async () => {
  const clock = clockAt('2026-09-10T10:00:00.000Z');
  const s = new FakePostingStore({ now: clock.now, settings: IMP_SETTINGS });
  const live = importRow('ae3', '2026-09-10T08:00:00.000Z', '2026-09-10T08:00:00.000Z', 700);
  const late = importRow('ae4', '2026-08-15T08:00:00.000Z', '2026-09-10T08:00:00.000Z', 300);
  s.seedEvents([importPost(live), importPost(late)]);
  await run(s);
  const liveMove = s.state.moves.get(s.event(arEntryKey('ae3'))!.moveId!)!;
  const lateMove = s.state.moves.get(s.event(arEntryKey('ae4'))!.moveId!)!;
  assert.equal(liveMove.date, '2026-09-10');
  assert.deepEqual([lateMove.date, lateMove.lateArrival], ['2026-09-01', true]);

  clock.set('2026-10-05T10:00:00.000Z');
  s.seedEvents([...importTombstone(live, '2026-10-05T10:00:00.000Z'), ...importTombstone(late, '2026-10-05T10:00:00.000Z')]);
  await run(s);
  const liveRev = s.event(arEntryKey('ae3', 'REVERSE'))!;
  const lateRev = s.event(arEntryKey('ae4', 'REVERSE'))!;
  assert.deepEqual([liveRev.status, lateRev.status], ['DONE', 'DONE']);
  assert.equal(s.state.moves.get(liveRev.moveId!)!.reversedMoveId, liveMove.id, 'عكس القيد الحيّ نفسه');
  assert.equal(s.state.moves.get(liveRev.moveId!)!.date, '2026-09-10', 'بتاريخ القيد الحي لا 10-05');
  assert.equal(s.state.moves.get(lateRev.moveId!)!.date, '2026-09-01', 'بتاريخ البدء');
  assert.equal(arAsOf(s, '2026-09-30'), 0n);
});

test('(12) ADR‑11: تاريخ البدء في فترة مقفلة ⇒ العكس يُزاح إلى أول يوم مفتوح (الافتتاحي والحي)', async () => {
  const clock = clockAt('2026-09-10T10:00:00.000Z');
  const s = new LockedStore({ now: clock.now, settings: IMP_SETTINGS });
  const opening = importRow('ae5', '2026-08-20T09:00:00.000Z', '2026-08-25T09:00:00.000Z', 400);
  const live = importRow('ae6', '2026-09-05T08:00:00.000Z', '2026-09-05T08:00:00.000Z', 900);
  seedOpening(s, 400_000n);
  s.seedEvents([importPost(opening, { status: 'SKIPPED', skipReason: 'OPENING' }), importPost(live)]);
  await run(s);
  assert.equal(s.state.moves.get(s.event(arEntryKey('ae6'))!.moveId!)!.date, '2026-09-05');

  s.locks = { ...s.locks, hardLockDate: '2026-09-30' };
  clock.set('2026-10-20T10:00:00.000Z');
  s.seedEvents([...importTombstone(opening, '2026-10-20T10:00:00.000Z'), ...importTombstone(live, '2026-10-20T10:00:00.000Z')]);
  await run(s);
  for (const id of ['ae5', 'ae6']) {
    const ev = s.event(arEntryKey(id, 'REVERSE'))!;
    assert.equal(ev.status, 'DONE');
    const m = s.state.moves.get(ev.moveId!)!;
    assert.deepEqual([m.date, m.lateArrival], ['2026-10-01', true], `${id}: أول يوم مفتوح لا يوم التراجع 10-20`);
  }
  assert.equal(s.state.moves.get(s.event(arEntryKey('ae5', 'REVERSE'))!.moveId!)!.originalDate, '2026-09-01');
  assert.equal(s.balance(AR, 'c1'), 0n);
});

test('(12) ADR‑11: أصل غير مُرحَّل (NETTED) بلا تغيير؛ والخطة لا تُمس لغير عكس الاستيراد', async () => {
  const clock = clockAt('2026-09-10T10:00:00.000Z');
  const s = new FakePostingStore({ now: clock.now, settings: IMP_SETTINGS });
  const row = importRow('ae7', '2026-09-10T08:00:00.000Z', '2026-09-10T08:00:00.000Z', 250);
  s.seedEvents(importTombstone(row, '2026-09-10T09:00:00.000Z'));
  await run(s);
  const post = s.event(arEntryKey('ae7', 'POST'))!;
  const rev = s.event(arEntryKey('ae7', 'REVERSE'))!;
  assert.deepEqual([post.status, post.skipReason, rev.status, rev.skipReason], ['SKIPPED', 'NETTED', 'SKIPPED', 'NETTED']);
  assert.equal(s.moves().length, 0);

  const env = { cutover: { cutoverDate: '2026-09-01', openingSnapshotAt: IMP_SETTINGS.openingSnapshotAt, timezone: TZ, initialWatermarkAt: at('2026-08-30T21:00:00.000Z') } };
  const plan = { action: 'POST' as const, mode: 'REVERSE_LIVE' as const, liveMoveId: 'm1', date: '2026-10-05', lateArrival: false, originalDate: null, futureDated: false, siblingWrite: null };
  assert.equal(importReversalPlan(env, { sourceType: 'AR_ENTRY', event: 'REVERSE', payload: null }, plan).date, '2026-09-01');
  assert.equal(importReversalPlan(env, { sourceType: 'INVOICE', event: 'REVERSE', payload: null }, plan), plan, 'الفاتورة: قاعدة §5.3');
  assert.equal(importReversalPlan(env, { sourceType: 'SETTLEMENT', event: 'REVERSE', payload: null }, plan), plan);
  assert.equal(importReversalPlan(env, { sourceType: 'AR_ENTRY', event: 'POST', payload: null }, { ...plan, mode: 'BUILD' as const }).date, '2026-10-05');
  assert.equal(importReversalPlan(env, { sourceType: 'AR_ENTRY', event: 'REVERSE', payload: { origin: 'CUSTOMER_ADJUSTMENT' } as SourceEventPayload }, plan), plan);
});
