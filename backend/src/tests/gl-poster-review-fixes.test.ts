// M3 — إصلاحات مراجعة المُرحِّل (DESIGN.md §5.4، §5.5 P7/P8/P9، §5.6، §6.1، §8.1 D2). بلا قاعدة: المخزن المزيّف والمُرحِّل الحقيقي.
//  1. تقسيم الاستلامات المشمولة بالافتتاح يُجمَّد: وصول سند متأخر بتاريخ سابق لا يقلب C4 أحمر، وعكس الاستلام لا يعيد covered لم يُقيد.
//  2. الإلغاء يتبع أصله: فاتورة مؤرخة مستقبلاً أُلغيت قبل البدء ⇒ POST وREVERSE معاً وصافي الإيراد والضريبة و113001 صفر.
//  3. ترتيب P7 بالمؤشر الفعّال max(المؤشر، الأفق) حين لا صفوف غير مقروءة — دون تحريك المؤشر.
//  4. إعادة الترحيل من المصدر للاستلام تأخذ المعلّق من القيد الحيّ: فاتورة نقدية لاحقة بتاريخ سابق لا تغيّر 111001/911001.
//  7. أخطاء الاتصال العابرة (P2024/P2028/…) لا تُحتسب محاولة.
// 11. D2: السياق يُعاد تحميله تحت القفل حين تتغير GlSettings أثناء النبضة؛ وإعادة ترحيل عمولة قبل التاريخ بلا 116001.
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
