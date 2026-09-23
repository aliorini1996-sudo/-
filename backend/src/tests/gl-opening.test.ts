// M3 — القيد الافتتاحي ومعالج الإعداد والترحيل التاريخي (DESIGN.md §5.6، §10.1 صف M3: gl-opening.test.ts).
// صرف بلا قاعدة: الذمم والعهدة والأمانات والمخزون كما في تاريخ البدء؛ العهدة من custodyComponents بلا فواتير نقدية
// حين MAIN_CASH؛ سباق اللقطة (لا صف يسقط من الافتتاح والترحيل ولا يُعدّ فيهما)؛ المؤشر لا يتجاوز T0؛
// ورفض cutoverDate مستقبلي بـ422 LEDGER_CUTOVER_IN_FUTURE (صرف + حارس ثابت على المسار).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertCutoverNotInFuture, buildOpeningMove, checkCutoverVatPeriod, computeDerivedOpening, computeImportedAfterCutover, importBatchRecordIds,
  importedAfterCutoverJson, includedInOpening, isVatPeriodStart, openingCutoff, openingSnapshotFromDbNow, postCutoverImportsAckMissing,
  postCutoverImportsAckStale, postCutoverImportsAcknowledged, IMPORT_FUTURE_DATE_GRACE_DAYS, isImportDateTooFarAhead, maxImportEntryDate,
  LEDGER_POST_CUTOVER_IMPORTS_CHANGED_MESSAGE,
  suggestedCutoverDate, templatePreviewContext, validateManualBalanceRows,
  IMPORT_ENTRIES_LOCK_PREFIX, findRunningImportBatch, importInProgressDetails, type ImportBatchStateRow,
  type OpeningAccountEntryRow, type OpeningSources, type ManualBalanceRowInput,
} from '../services/gl/opening';
import {
  HISTORY_MAX_ROWS, assertHistoryNotTooLarge, backfillProgress, backfillTransition, conservativeEventsPerMinute, estimateHistory, fullHistoryCutoverDate,
  initialCursorRows, shouldReconcile,
} from '../services/gl/backfill';
import { classifyCutover, initialWatermarkAt } from '../services/gl/sync/classify';
import { LATE_COMMIT_WINDOW_MS } from '../services/gl/sync/types';
import { validateMove } from '../services/gl/validate';
import { saContext, accountIdOf } from '../services/gl/testing/fixtures';
import { LedgerError, isLedgerError } from '../services/gl/types';
import { LEDGER_IMPORT_IN_PROGRESS_MESSAGE, LEDGER_POST_CUTOVER_IMPORTS_ACK_MESSAGE, LedgerHttpError, ledgerErrorResponse } from '../routes/ledger/errors';
import { IMPORT_RUNNING_STALE_MS } from '../services/importLedger';
import { zonedStartOfDay } from '../services/gl/dates';

const TZ = 'Asia/Riyadh';
const CUTOVER = '2027-01-01';
const COMMIT_NOW = new Date('2027-01-15T09:00:00.000Z');
const T0 = openingSnapshotFromDbNow(COMMIT_NOW);
const CUT = openingCutoff(CUTOVER, TZ, T0);
const DEC = 2;
const ROUTING = { receiptRouting: { CASH: 'CUSTODY' as const }, cashInvoiceRouting: 'MAIN_CASH' as const };

const at = (iso: string) => new Date(iso);
let seq = 0;
function entry(p: Partial<OpeningAccountEntryRow> & Pick<OpeningAccountEntryRow, 'customerId' | 'type' | 'entryDate' | 'createdAt'>): OpeningAccountEntryRow {
  return { id: `ae${++seq}`, invoiceId: null, receiptId: null, debit: 0, credit: 0, ...p };
}
function sources(p: Partial<OpeningSources>): OpeningSources {
  return { accountEntries: [], receipts: [], cashInvoices: [], settlements: [], settlementEntries: [], ...p };
}

// ═══ T0 والحدود ═══

test('T0 = dbNow − LATE_COMMIT_WINDOW من ساعة القاعدة، وقيد OPEN بتاريخ cutover − 1', () => {
  assert.equal(COMMIT_NOW.getTime() - T0.getTime(), LATE_COMMIT_WINDOW_MS);
  assert.equal(CUT.openingDate, '2026-12-31');
  assert.equal(CUT.cutoverStart.toISOString(), zonedStartOfDay(CUTOVER, TZ).toISOString());
  assert.equal(CUT.cutoverStart.toISOString(), '2026-12-31T21:00:00.000Z');
});

// ═══ الذمم كما في تاريخ البدء ═══

test('الذمم لكل عميل = Σ AccountEntry قبل البدء وcreatedAt ≤ T0؛ ما بعد البدء خارج الافتتاح', () => {
  const rows = [
    entry({ customerId: 'c1', type: 'INVOICE_DEBIT', invoiceId: 'i1', debit: 1150, entryDate: at('2026-11-10T08:00:00Z'), createdAt: at('2026-11-10T08:00:00Z') }),
    entry({ customerId: 'c1', type: 'RECEIPT_CREDIT', receiptId: 'r1', credit: 400.5, entryDate: at('2026-12-20T08:00:00Z'), createdAt: at('2026-12-20T08:00:00Z') }),
    // آخر لحظة من 31 ديسمبر بتوقيت الرياض ⇒ قبل البدء
    entry({ customerId: 'c2', type: 'ADJUSTMENT_DEBIT', debit: 99.99, entryDate: at('2026-12-31T20:59:59.999Z'), createdAt: at('2026-12-31T20:59:59.999Z') }),
    // أول لحظة من 1 يناير بتوقيت الرياض ⇒ بعد البدء
    entry({ customerId: 'c2', type: 'ADJUSTMENT_DEBIT', debit: 50, entryDate: at('2026-12-31T21:00:00.000Z'), createdAt: at('2026-12-31T21:00:00.000Z') }),
    // رصيد صفري لا يُسطَّر
    entry({ customerId: 'c3', type: 'ADJUSTMENT_DEBIT', debit: 10, entryDate: at('2026-06-01T08:00:00Z'), createdAt: at('2026-06-01T08:00:00Z') }),
    entry({ customerId: 'c3', type: 'ADJUSTMENT_CREDIT', credit: 10, entryDate: at('2026-06-02T08:00:00Z'), createdAt: at('2026-06-02T08:00:00Z') }),
  ];
  const d = computeDerivedOpening(sources({ accountEntries: rows, customerNames: { c1: 'مؤسسة النور', c2: 'بقالة الريم' } }), CUT, { decimals: DEC, routing: ROUTING });
  const byId = Object.fromEntries(d.receivables.map((r) => [r.customerId, r.balanceMilli]));
  assert.equal(byId.c1, 749_500n);
  assert.equal(byId.c2, 99_990n);
  assert.equal(byId.c3, undefined);
  assert.equal(d.receivablesTotalMilli, 849_490n);
  assert.equal(d.counts.accountEntriesExcluded, 1);
});

// ═══ العهدة ═══

function custodyFixture(_label: 'MAIN_CASH' | 'CUSTODY') {
  const rows: OpeningAccountEntryRow[] = [
    // سند نقدي للعهدة 1000
    entry({ customerId: 'c1', type: 'RECEIPT_CREDIT', receiptId: 'rc1', credit: 1000, entryDate: at('2026-12-01T08:00:00Z'), createdAt: at('2026-12-01T08:00:00Z') }),
    // سند نقدي 200 أُلغي قبل البدء ⇒ لا أثر
    entry({ customerId: 'c1', type: 'RECEIPT_CREDIT', receiptId: 'rc2', credit: 200, entryDate: at('2026-12-02T08:00:00Z'), createdAt: at('2026-12-02T08:00:00Z') }),
    entry({ customerId: 'c1', type: 'RECEIPT_DEBIT', receiptId: 'rc2', debit: 200, entryDate: at('2026-12-03T08:00:00Z'), createdAt: at('2026-12-03T08:00:00Z') }),
    // سند نقدي 150 أُلغي بعد البدء ⇒ في الافتتاح، وإلغاؤه عبر الأحداث (صف الإلغاء ليس في المصادر المرشّحة)
    entry({ customerId: 'c1', type: 'RECEIPT_CREDIT', receiptId: 'rc3', credit: 150, entryDate: at('2026-12-04T08:00:00Z'), createdAt: at('2026-12-04T08:00:00Z') }),
    entry({ customerId: 'c1', type: 'RECEIPT_DEBIT', receiptId: 'rc3', debit: 150, entryDate: at('2027-01-05T08:00:00Z'), createdAt: at('2027-01-05T08:00:00Z') }),
    // فاتورة نقدية 500 (صفّان)
    entry({ customerId: 'c1', type: 'INVOICE_DEBIT', invoiceId: 'ci1', debit: 500, entryDate: at('2026-12-05T08:00:00Z'), createdAt: at('2026-12-05T08:00:00Z') }),
    entry({ customerId: 'c1', type: 'RECEIPT_CREDIT', invoiceId: 'ci1', credit: 500, entryDate: at('2026-12-05T08:00:00Z'), createdAt: at('2026-12-05T08:00:00.002Z') }),
    // سند ONLINE 300
    entry({ customerId: 'c1', type: 'RECEIPT_CREDIT', receiptId: 'ro1', credit: 300, entryDate: at('2026-12-06T08:00:00Z'), createdAt: at('2026-12-06T08:00:00Z') }),
    // سند نقدي 700 بعد البدء ⇒ خارج الافتتاح
    entry({ customerId: 'c1', type: 'RECEIPT_CREDIT', receiptId: 'rc4', credit: 700, entryDate: at('2027-01-03T08:00:00Z'), createdAt: at('2027-01-03T08:00:00Z') }),
  ];
  return sources({
    accountEntries: rows,
    receipts: [
      { id: 'rc1', salesRepId: 'rep1', paymentMethod: 'CASH', amount: 1000 },
      { id: 'rc2', salesRepId: 'rep1', paymentMethod: 'CASH', amount: 200 },
      { id: 'rc3', salesRepId: 'rep1', paymentMethod: 'CASH', amount: 150 },
      { id: 'ro1', salesRepId: 'rep1', paymentMethod: 'ONLINE', amount: 300 },
      { id: 'rc4', salesRepId: 'rep1', paymentMethod: 'CASH', amount: 700 },
    ],
    cashInvoices: [{ id: 'ci1', salesRepId: 'rep1', total: 500 }],
    settlements: [
      { id: 's1', salesRepId: 'rep1', amount: 400, settledAt: at('2026-12-10T08:00:00Z'), createdAt: at('2026-12-10T08:00:00Z') },
      // استلام بعد البدء ⇒ خارج الافتتاح
      { id: 's2', salesRepId: 'rep1', amount: 100, settledAt: at('2027-01-02T08:00:00Z'), createdAt: at('2027-01-02T08:00:00Z') },
    ],
    salesRepNames: { rep1: 'خالد' },
  });
}

test('العهدة الافتتاحية من custodyComponents: MAIN_CASH بلا فواتير نقدية، وCUSTODY بها', () => {
  const main = computeDerivedOpening(custodyFixture('MAIN_CASH'), CUT, { decimals: DEC, routing: ROUTING });
  const rep = main.custody.find((c) => c.salesRepId === 'rep1')!;
  // 1000 + 150 (أُلغي بعد البدء) − covered(400)
  assert.equal(rep.ledgerCustodyMilli, 750_000n);
  assert.equal(rep.cashSalesOutsideCustodyMilli, 500_000n, 'الفاتورة النقدية خارج العهدة حين MAIN_CASH');
  assert.equal(rep.onlineUnclearedMilli, 300_000n);
  assert.equal(main.custodyTotalMilli, 750_000n);
  assert.equal(main.counts.settlementsIncluded, 1);

  const cust = computeDerivedOpening(custodyFixture('CUSTODY'), CUT, { decimals: DEC, routing: { ...ROUTING, cashInvoiceRouting: 'CUSTODY' } });
  assert.equal(cust.custody[0].ledgerCustodyMilli, 1_250_000n, 'CUSTODY ⇒ الفاتورة النقدية في العهدة');
});

test('استلام يتجاوز العهدة قبل البدء: covered حتى الرصيد والباقي r لا يُنقص 111003 (قاعدة P7 نفسها)', () => {
  const src = custodyFixture('MAIN_CASH');
  const big = { ...src, settlements: [{ id: 's9', salesRepId: 'rep1', amount: 1500, settledAt: at('2026-12-20T08:00:00Z'), createdAt: at('2026-12-20T08:00:00Z') }] };
  const d = computeDerivedOpening(big, CUT, { decimals: DEC, routing: ROUTING });
  const rep = d.custody[0];
  assert.equal(rep.ledgerCustodyMilli, 0n);
  assert.equal(rep.nonCustodyClearedMilli, 350_000n);
});

// ═══ الأمانات والمخزون ═══

test('الأمانات 112005 = Σ SettlementEntry قبل البدء وcreatedAt ≤ T0 (موقَّع)', () => {
  const d = computeDerivedOpening(sources({
    settlementEntries: [
      { id: 'e1', amount: 1000, createdAt: at('2026-12-01T08:00:00Z') },
      { id: 'e2', amount: -26.45, createdAt: at('2026-12-01T08:00:01Z') },
      { id: 'e3', amount: -500, createdAt: at('2026-12-15T08:00:00Z') },
      { id: 'e4', amount: 300, createdAt: at('2027-01-02T08:00:00Z') },
    ],
  }), CUT, { decimals: DEC, routing: ROUTING });
  assert.equal(d.paylinkHeldMilli, 473_550n);
  assert.equal(d.counts.settlementEntriesIncluded, 3);
});

test('مخزون المستودع = valueStock على الحركات قبل البدء، والكمية بلا تكلفة مُعلنة', () => {
  const d = computeDerivedOpening(sources({
    warehouseItems: [
      { productId: 'p1', qty: 10, type: 'RECEIVE', unitCost: 5, createdAt: at('2026-11-01T08:00:00Z') },
      { productId: 'p1', qty: 10, type: 'RECEIVE', unitCost: 7, createdAt: at('2026-11-02T08:00:00Z') },
      { productId: 'p2', qty: 4, type: 'RECEIVE', unitCost: null, createdAt: at('2026-11-03T08:00:00Z') },
      { productId: 'p1', qty: 100, type: 'RECEIVE', unitCost: 9, createdAt: at('2027-01-03T08:00:00Z') },
    ],
    vanItems: [{ productId: 'p1', qty: 5, type: 'LOAD', salesRepId: 'rep1', createdAt: at('2026-11-05T08:00:00Z') }],
  }), CUT, { decimals: DEC, routing: ROUTING });
  // متوسط 6 × 15
  assert.equal(d.warehouse.valueMilli, 90_000n);
  assert.equal(d.warehouse.uncostedQty, 4);
  assert.equal(d.warehouse.uncostedProducts, 1);
});

test('البند 40: قيمة المخزون تُقرَّب بخانات الدفاتر لا بخانتين ثابتتين قبل toMilli', () => {
  // شركةٌ بالدينار (ثلاث خانات): ٢٥٠ كرتوناً بـ٤٫١٢٣٥ ⇒ ١٠٣٠٫٨٧٥.
  // قبل توصيل الخانات كان composeWarehouse يقرّبها إلى ١٠٣٠٫٨٨ ثمّ يستقبلها
  // toMilli بثلاث خانات ⇒ 1_030_880n، فتُولَد خمسة فلوسٍ من التقريب وحده.
  const stock = (decimals: number) => computeDerivedOpening(sources({
    warehouseItems: [{ productId: 'p1', qty: 250, type: 'RECEIVE', unitCost: 4.1235, createdAt: at('2026-11-01T08:00:00Z') }],
  }), CUT, { decimals, routing: ROUTING }).warehouse.valueMilli;
  assert.equal(stock(3), 1_030_875n);
  assert.equal(stock(2), 1_030_880n, 'شركة الريال لا تنحدر: خانتان كما كانت');
  // ألف صنفٍ بقيمة ٠٫١٢٣٥: ١٢٤ ديناراً بثلاث خانات و١٢٠ بخانتين
  const many = (decimals: number) => computeDerivedOpening(sources({
    warehouseItems: Array.from({ length: 1000 }, (_, i) => ({
      productId: `p${i}`, qty: 1, type: 'RECEIVE', unitCost: 0.1235, createdAt: at('2026-11-01T08:00:00Z'),
    })),
  }), CUT, { decimals, routing: ROUTING }).warehouse.valueMilli;
  assert.equal(many(3), 124_000n);
  assert.equal(many(2), 120_000n, 'أربعة دنانير كانت تضيع من القيد الافتتاحيّ');
});

// ═══ سباق اللقطة ═══

test('سباق اللقطة: صف createdAt ≤ T0 التزم بعد معاينة الخطوة 4 يدخل الافتتاح في الاعتماد', () => {
  const previewNow = new Date(T0.getTime() - 60 * 60_000);
  const early = entry({ customerId: 'c1', type: 'ADJUSTMENT_DEBIT', debit: 100, entryDate: at('2026-12-01T08:00:00Z'), createdAt: at('2026-12-01T08:00:00Z') });
  // معاملة بدأت قبل المعاينة (createdAt ≤ T0) والتزمت بعدها ⇒ غائبة عن قراءة المعاينة
  const late = entry({ customerId: 'c1', type: 'ADJUSTMENT_DEBIT', debit: 40, entryDate: at('2026-12-02T08:00:00Z'), createdAt: new Date(T0.getTime() - 1) });
  const preview = computeDerivedOpening(sources({ accountEntries: [early] }), openingCutoff(CUTOVER, TZ, previewNow), { decimals: DEC, routing: ROUTING });
  const commit = computeDerivedOpening(sources({ accountEntries: [early, late] }), CUT, { decimals: DEC, routing: ROUTING });
  assert.equal(preview.receivablesTotalMilli, 100_000n);
  assert.equal(commit.receivablesTotalMilli, 140_000n, 'الاعتماد يعيد الحساب بـT0 ولا يستعمل أرقام المعاينة');
  assert.equal(classifyCutover({ effectAt: late.entryDate, createdAt: late.createdAt }, { cutoverDate: CUTOVER, openingSnapshotAt: T0, timezone: TZ }).kind, 'OPENING');
});

test('سباق اللقطة: صف createdAt في (T0, commit] بتاريخ قبل البدء ليس في الافتتاح ويُرحَّل بتاريخ البدء مع lateArrival', () => {
  const inWindow = entry({ customerId: 'c1', type: 'ADJUSTMENT_DEBIT', debit: 75, entryDate: at('2026-12-15T08:00:00Z'), createdAt: new Date(T0.getTime() + 1) });
  const atCommit = entry({ customerId: 'c1', type: 'ADJUSTMENT_DEBIT', debit: 25, entryDate: at('2026-12-16T08:00:00Z'), createdAt: COMMIT_NOW });
  const d = computeDerivedOpening(sources({ accountEntries: [inWindow, atCommit] }), CUT, { decimals: DEC, routing: ROUTING });
  assert.equal(d.receivablesTotalMilli, 0n);
  for (const r of [inWindow, atCommit]) {
    const c = classifyCutover({ effectAt: r.entryDate, createdAt: r.createdAt }, { cutoverDate: CUTOVER, openingSnapshotAt: T0, timezone: TZ });
    assert.equal(c.kind, 'POST_AT');
    if (c.kind === 'POST_AT') {
      assert.equal(c.date, CUTOVER);
      assert.equal(c.lateArrival, true);
      assert.equal(c.originalDate, c.effectDate);
    }
  }
});

test('سباق اللقطة: كل صف إما في الافتتاح أو مُرحَّل — لا يسقط من الاثنين ولا يُعدّ فيهما، والمجموع = Σ AccountEntry', () => {
  let rnd = 20270101;
  const rand = () => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd / 2147483648; };
  const rows: OpeningAccountEntryRow[] = [];
  for (let i = 0; i < 400; i++) {
    const effect = new Date(CUT.cutoverStart.getTime() + Math.round((rand() - 0.5) * 20 * 86_400_000));
    const created = new Date(T0.getTime() + Math.round((rand() - 0.5) * 40 * 60_000));
    const debit = Math.round(rand() * 100_000) / 100;
    rows.push(entry({ customerId: `c${i % 7}`, type: rand() < 0.5 ? 'ADJUSTMENT_DEBIT' : 'ADJUSTMENT_CREDIT', debit: rand() < 0.5 ? debit : 0, credit: rand() < 0.5 ? 0 : debit, entryDate: effect, createdAt: created }));
  }
  const d = computeDerivedOpening(sources({ accountEntries: rows }), CUT, { decimals: DEC, routing: ROUTING });
  let posted = 0n;
  let all = 0n;
  for (const r of rows) {
    const net = BigInt(Math.round(r.debit * 1000)) - BigInt(Math.round(r.credit * 1000));
    all += net;
    const inOpening = includedInOpening({ effectAt: r.entryDate, createdAt: r.createdAt }, CUT);
    const c = classifyCutover({ effectAt: r.entryDate, createdAt: r.createdAt }, { cutoverDate: CUTOVER, openingSnapshotAt: T0, timezone: TZ });
    assert.equal(inOpening, c.kind === 'OPENING', `الصف ${r.id}: الافتتاح والتصنيف متطابقان`);
    if (!inOpening) posted += net;
  }
  assert.equal(d.receivablesTotalMilli + posted, all);
  assert.equal(d.counts.accountEntriesIncluded + d.counts.accountEntriesExcluded, rows.length);
});

// ═══ المؤشر لا يتجاوز T0 ═══

test('مؤشر المصادر لا يتجاوز T0 أبداً: min(cutover − 1 يوم، T0) للطريقة (أ) وepoch للطريقة (ب)', () => {
  const cases: [string, Date][] = [
    ['2027-01-01', COMMIT_NOW],
    ['2027-01-15', COMMIT_NOW],
    ['2027-01-16', new Date('2027-01-15T21:05:00.000Z')], // «اليوم» بتوقيت الرياض وT0 قبل بداية اليوم السابق؟ لا — بعدها
    ['2027-01-16', new Date('2027-01-15T21:00:30.000Z')], // T0 = 20:50:30 UTC ⇒ قبل منتصف ليل 16 محلياً وبعد بداية 15
    ['2026-01-01', COMMIT_NOW],
  ];
  for (const [cutoverDate, dbNow] of cases) {
    const t0 = openingSnapshotFromDbNow(dbNow);
    const w = initialWatermarkAt({ method: 'OPENING', cutoverDate, openingSnapshotAt: t0, timezone: TZ });
    assert.ok(w.getTime() <= t0.getTime(), `${cutoverDate}: المؤشر ${w.toISOString()} ≤ T0 ${t0.toISOString()}`);
    for (const row of initialCursorRows('t1', 'PERIODIC', w)) {
      assert.ok(row.watermarkAt instanceof Date && (row.watermarkAt as Date).getTime() <= t0.getTime());
      assert.equal(row.watermarkId, '');
    }
    assert.equal(initialWatermarkAt({ method: 'FULL_HISTORY', cutoverDate, openingSnapshotAt: t0, timezone: TZ }).getTime(), 0);
  }
  assert.deepEqual(initialCursorRows('t1', 'PERIODIC', T0).map((r) => r.source), ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY']);
  assert.equal(initialCursorRows('t1', 'PERPETUAL', T0).length, 6);
});

test('صف قبل المؤشر بتاريخ قبل البدء مشمول دائماً (createdAt ≤ مؤشر ≤ T0)؛ والمؤرخ مستقبلاً للفحص لمرة واحدة', () => {
  const w = initialWatermarkAt({ method: 'OPENING', cutoverDate: CUTOVER, openingSnapshotAt: T0, timezone: TZ });
  const old = { effectAt: at('2026-12-01T08:00:00Z'), createdAt: w };
  assert.equal(includedInOpening(old, CUT), true);
  const future = { effectAt: at('2027-02-01T08:00:00Z'), createdAt: new Date(w.getTime() - 86_400_000) };
  const c = classifyCutover(future, { cutoverDate: CUTOVER, openingSnapshotAt: T0, timezone: TZ });
  assert.equal(c.kind, 'POST_AT');
  if (c.kind === 'POST_AT') assert.equal(c.futureDated, true);
});

// ═══ LEDGER_CUTOVER_IN_FUTURE ═══

test('cutoverDate مستقبلي بتوقيت الشركة ⇒ 422 LEDGER_CUTOVER_IN_FUTURE؛ اليوم والماضي مقبولان', () => {
  const now = new Date('2027-03-10T20:30:00.000Z'); // 23:30 بتوقيت الرياض = 10 مارس
  assert.doesNotThrow(() => assertCutoverNotInFuture('2027-03-10', TZ, now));
  assert.doesNotThrow(() => assertCutoverNotInFuture('2027-01-01', TZ, now));
  assert.throws(() => assertCutoverNotInFuture('2027-03-11', TZ, now), (e: unknown) => {
    assert.ok(isLedgerError(e, 'LEDGER_CUTOVER_IN_FUTURE'));
    assert.equal((e as LedgerError).httpStatus, 422);
    const r = ledgerErrorResponse(e)!;
    assert.equal(r.status, 422);
    assert.equal(r.body.code, 'LEDGER_CUTOVER_IN_FUTURE');
    return true;
  });
  // 21:30 UTC = 00:30 يوم 11 بتوقيت الرياض ⇒ 11 مارس «اليوم» هناك
  assert.doesNotThrow(() => assertCutoverNotInFuture('2027-03-11', TZ, new Date('2027-03-10T21:30:00.000Z')));
  assert.throws(() => assertCutoverNotInFuture('2027-03-11', 'UTC', new Date('2027-03-10T21:30:00.000Z')), /LEDGER_CUTOVER_IN_FUTURE/);
});

const SETUP_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ledger', 'setup.ts'), 'utf8');

function handlerBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `المسار ${signature} موجود`);
  const end = src.indexOf('\n}));', start + signature.length);
  assert.ok(end > start, `نهاية المسار ${signature}`);
  return src.slice(start, end);
}

function assertOrder(body: string, needles: string[], label: string) {
  let pos = -1;
  for (const n of needles) {
    const i = body.indexOf(n, pos + 1);
    assert.ok(i > pos, `${label}: «${n}» بعد ما قبله`);
    pos = i;
  }
}

test('حارس ثابت: /setup/commit يرفض cutoverDate مستقبلياً قبل أي كتابة، وT0 من ساعة القاعدة أولاً، والمعاملة 60 ثانية', () => {
  const commit = handlerBody(SETUP_SRC, "router.post('/setup/commit'");
  // البند 42: القفلان ثم ساعة القاعدة (clock_timestamp) ثم T0 — لا now() المجمَّد على بدء المعاملة
  assertOrder(commit, [
    'prisma.$transaction(async (tx)', 'acquirePostLock(tx, tenantId)', 'acquireImportEntriesLock(tx, tenantId)',
    'dbClockOf(tx)', 'openingSnapshotFromDbNow(dbNow)',
    'assertCutoverNotInFuture(cutoverDate', 'ensureSettingsRow(', 'seedTemplate(tx', 'loadOpeningSources(tx', 'computeDerivedOpening(',
    'postMove(tx', 'openingSnapshotAt: T0', "backfillState: 'RUNNING'", 'initialWatermarkAt(', 'glSyncCursor.createMany', "'SETUP_COMMIT'",
  ], '/setup/commit');
  assert.doesNotMatch(commit, /dbNowOf\(tx\)/, 'الاعتماد لا يستعمل now() المجمَّد');
  assert.match(commit, /\}, COMMIT_TX\);/);
  assert.match(SETUP_SRC, /const COMMIT_TX = \{ timeout: 60_000, maxWait: 10_000 \};/);
  assert.doesNotMatch(commit, /openingSnapshotAt:\s*(new Date\(|dbNow)/, 'openingSnapshotAt = T0 لا now()');
  assert.match(SETUP_SRC, /router\.get\('\/setup', CONFIGURE/);
  assert.match(SETUP_SRC, /router\.post\('\/setup\/preview-opening', CONFIGURE/);
  assert.match(SETUP_SRC, /router\.post\('\/setup\/commit', CONFIGURE/);
  assert.match(SETUP_SRC, /const CONFIGURE = requireLedgerPermission\('canConfigureLedger'\);/);
});

test('حارس ثابت: حفظ مسودة الخطوة 1 يرفض cutoverDate مستقبلياً قبل كتابة المسودة', () => {
  const draft = handlerBody(SETUP_SRC, "router.post('/setup/draft'");
  assertOrder(draft, ['dbNowOf(tx)', 'checkStep1(eff, now)', 'ensureSettingsRow(', 'setupDraft: merged'], '/setup/draft');
  const fn = SETUP_SRC.slice(SETUP_SRC.indexOf('function checkStep1('), SETUP_SRC.indexOf('function settingsStatus('));
  assertOrder(fn, ['assertCutoverNotInFuture(e.cutoverDate, e.timezone, now)', 'checkCutoverVatPeriod('], 'checkStep1');
  const preview = handlerBody(SETUP_SRC, "router.post('/setup/preview-opening'");
  assert.doesNotMatch(preview, /\.(create|update|upsert|delete)(Many)?\(/, 'المعاينة لا تكتب شيئاً');
  assert.doesNotMatch(preview, /postMove\(|appendAudit\(/);
});

// ═══ فترة الإقرار (الخطوة 1) ═══

test('SA_6D: تاريخ بدء داخل فترة إقرار ⇒ LEDGER_CUTOVER_MID_VAT_PERIOD ما لم يؤكَّد مع مبالغ المربعات', () => {
  assert.equal(isVatPeriodStart('2027-04-01', 'QUARTERLY'), true);
  assert.equal(isVatPeriodStart('2027-05-01', 'QUARTERLY'), false);
  assert.equal(isVatPeriodStart('2027-05-01', 'MONTHLY'), true);
  assert.equal(isVatPeriodStart('2027-07-01', 'FISCAL_YEAR', 6, 30), true);
  const base = { templateKey: 'SA_6D' as const, cutoverDate: '2027-05-01', taxPeriodicity: 'QUARTERLY' as const, fiscalYearEndMonth: 12, fiscalYearEndDay: 31 };
  assert.throws(() => checkCutoverVatPeriod(base), (e: unknown) => isLedgerError(e, 'LEDGER_CUTOVER_MID_VAT_PERIOD') && e.httpStatus === 422);
  assert.throws(() => checkCutoverVatPeriod({ ...base, confirmMidVatPeriod: true }), /LEDGER_CUTOVER_MID_VAT_PERIOD/);
  assert.deepEqual(checkCutoverVatPeriod({ ...base, confirmMidVatPeriod: true, preCutoverBoxes: { SA_1: 1000 } }), { midPeriod: true });
  assert.deepEqual(checkCutoverVatPeriod({ ...base, cutoverDate: '2027-04-01' }), { midPeriod: false });
  assert.deepEqual(checkCutoverVatPeriod({ ...base, templateKey: 'GENERIC_6D' }), { midPeriod: false });
  assert.equal(suggestedCutoverDate('SA_6D', COMMIT_NOW, TZ), '2027-01-01');
  assert.equal(suggestedCutoverDate('GENERIC_6D', new Date('2027-05-17T10:00:00Z'), TZ), '2027-05-01');
});

// ═══ الأرصدة اليدوية والقيد ═══

test('الأرصدة اليدوية: الحسابات المشتقة ممنوعة، 211001 بمورّد، و212001/116001 فقط داخل فترة مؤكَّدة', () => {
  const ctx = saContext();
  const rows: ManualBalanceRowInput[] = [
    { accountCode: '113001', debit: 100 },
    { accountCode: '111003', debit: 100 },
    { accountCode: '112005', debit: 100 },
    { accountCode: '114001', debit: 100 },
    { accountCode: '319002', credit: 100 },
    { accountCode: '211001', credit: 100 },
    { accountCode: '212001', credit: 100 },
    { accountCode: '111101', debit: 100, credit: 5 },
    { accountCode: '999999', debit: 1 },
    { accountCode: '111101', debit: 0 },
  ];
  const r = validateManualBalanceRows(rows, ctx, { midVatPeriod: false });
  assert.deepEqual(r.issues.map((i) => i.reason), [
    'DERIVED_ACCOUNT', 'DERIVED_ACCOUNT', 'DERIVED_ACCOUNT', 'DERIVED_ACCOUNT', 'OPENING_EQUITY', 'VENDOR_REQUIRED',
    'VAT_REQUIRES_MID_PERIOD', 'DEBIT_AND_CREDIT', 'ACCOUNT_NOT_FOUND', 'ZERO_AMOUNT',
  ]);
  const ok = validateManualBalanceRows([{ accountCode: '212001', credit: '1,500.00' }, { accountCode: '114002', debit: 80, salesRepId: 'rep1' }], ctx, { midVatPeriod: true });
  assert.equal(ok.issues.length, 0);
  assert.equal(ok.lines[0].creditMilli, 1_500_000n);
});

test('قيد OPEN متوازن بتاريخ cutover − 1 والفرق إلى 319002، ويجتاز validateMove بوضع SYSTEM (I5 للمورّد والعميل)', () => {
  const ctx = saContext();
  const derived = computeDerivedOpening(custodyFixture('MAIN_CASH'), CUT, { decimals: DEC, routing: ROUTING });
  const withPaylink = { ...derived, paylinkHeldMilli: 250_000n, warehouse: { valueMilli: 90_000n, uncostedQty: 0, uncostedProducts: 0 } };
  const manual = validateManualBalanceRows([
    { accountCode: '111101', debit: 20_000 },
    { accountCode: '311001', credit: 50_000 },
    { accountCode: '211001', credit: 3_000, vendorName: 'مصنع الخليج', dueDate: '2027-02-15' },
    { accountCode: '212002', credit: 1_200 },
  ], ctx, { midVatPeriod: false });
  assert.equal(manual.issues.length, 0);
  manual.lines[2].vendorId = 'v1'; // resolveVendors في الاعتماد
  const res = buildOpeningMove({ derived: withPaylink, manual: manual.lines, ctx });
  const draft = res.draft!;
  assert.equal(draft.date, '2026-12-31');
  assert.equal(draft.moveType, 'OPENING');
  assert.equal(draft.journalSystemKey, 'OPENING');
  assert.equal(draft.origin, 'AUTO');
  const dr = draft.lines.reduce((s, l) => s + l.debitMilli, 0n);
  const cr = draft.lines.reduce((s, l) => s + l.creditMilli, 0n);
  assert.equal(dr, cr);
  const eq = draft.lines.find((l) => l.accountKey === 'OPENING_EQUITY')!;
  // ذمم c1 دائنة 1450 (سندات قبل البدء) + عهدة 750 + أمانات 250 + مخزون 90 + بنك 20000؛ دائن 50000 + 3000 + 1200
  const net = draft.lines.filter((l) => l !== eq).reduce((s, l) => s + l.debitMilli - l.creditMilli, 0n);
  assert.equal(eq.creditMilli - eq.debitMilli, net);
  assert.equal(res.equityDiffMilli, net);
  const ap = draft.lines.find((l) => l.accountId === accountIdOf('211001'))!;
  assert.equal(ap.vendorId, 'v1');
  assert.equal(ap.dueDate, '2027-02-15');
  assert.equal(ap.partnerName, 'مصنع الخليج');
  const custody = draft.lines.find((l) => l.accountKey === 'REP_CUSTODY')!;
  assert.equal(custody.salesRepId, 'rep1');
  assert.equal(custody.debitMilli, 750_000n);
  assert.doesNotThrow(() => validateMove(draft, ctx, { mode: 'SYSTEM' }));
  // بلا مورّد ⇒ I5
  const noVendor = buildOpeningMove({ derived: withPaylink, manual: manual.lines.map((l) => ({ ...l, vendorId: null })), ctx });
  assert.throws(() => validateMove(noVendor.draft!, ctx, { mode: 'SYSTEM' }), /LEDGER_PARTNER_REQUIRED/);
});

test('لا أرصدة إطلاقاً ⇒ لا قيد OPEN؛ وسياق القالب قبل الزرع يحلّ الرموز للمعاينة', () => {
  const ctx = templatePreviewContext('SA_6D', 'SA');
  const d = computeDerivedOpening(sources({}), CUT, { decimals: DEC, routing: ROUTING });
  assert.equal(buildOpeningMove({ derived: d, manual: [], ctx }).draft, null);
  const v = validateManualBalanceRows([{ accountCode: '311001', credit: 10 }, { accountCode: '113001', debit: 1 }], ctx, { midVatPeriod: false });
  assert.deepEqual(v.issues.map((i) => i.reason), ['DERIVED_ACCOUNT']);
  assert.equal(ctx.accounts.byKey('OPENING_EQUITY')?.code, '319002');
});

// ═══ الترحيل التاريخي ═══

test('الطريقة (ب): السقف 60 ألف صف ⇒ 422 LEDGER_HISTORY_TOO_LARGE، وتاريخ البدء بداية السنة المالية لأقدم أثر', () => {
  const ok = estimateHistory({ accountEntries: 50_000, repSettlements: 5_000, settlementEntries: 5_000 });
  assert.equal(ok.rows, HISTORY_MAX_ROWS);
  assert.equal(ok.tooLarge, false);
  assert.doesNotThrow(() => assertHistoryNotTooLarge(ok));
  // البند 4(ج): بلا قياس ⇒ الحد المتحفظ (75 حدثاً/دقيقة) لا السقف الاسمي 300
  assert.equal(ok.throughputBasis, 'CONSERVATIVE');
  assert.equal(ok.estimatedMinutes, Math.ceil(HISTORY_MAX_ROWS / conservativeEventsPerMinute()));
  assert.equal(ok.estimatedMinutes, 800);
  const big = estimateHistory({ accountEntries: 60_000, repSettlements: 1, settlementEntries: 0 });
  assert.throws(() => assertHistoryNotTooLarge(big), (e: unknown) => isLedgerError(e, 'LEDGER_HISTORY_TOO_LARGE') && e.httpStatus === 422);
  assert.equal(fullHistoryCutoverDate(at('2024-03-05T22:00:00Z'), TZ), '2024-01-01');
  assert.equal(fullHistoryCutoverDate(at('2024-03-05T22:00:00Z'), TZ, 6, 30), '2023-07-01');
  assert.equal(fullHistoryCutoverDate(at('2024-12-31T21:30:00Z'), TZ), '2025-01-01', 'التاريخ المحلي بتوقيت الشركة');
  assert.equal(fullHistoryCutoverDate(null, TZ), null);
});

test('حالة الترحيل التاريخي: RUNNING ⇄ PAUSED، وDONE عند اكتمال المؤشرات بلا PENDING', () => {
  assert.equal(backfillTransition('RUNNING', 'PAUSE'), 'PAUSED');
  assert.equal(backfillTransition('PAUSED', 'RESUME'), 'RUNNING');
  assert.equal(backfillTransition('DONE', 'PAUSE'), null);
  assert.equal(backfillTransition('RUNNING', 'RESUME'), null);
  assert.equal(shouldReconcile('PAUSED'), false);
  assert.equal(shouldReconcile('RUNNING'), true);
  const dbNow = COMMIT_NOW;
  const src = (unread: boolean) => (['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY'] as const)
    .map((source, i) => ({ source, watermarkAt: new Date(dbNow.getTime() - 3_600_000), lastRunAt: dbNow, lastCount: 0, stallTicks: 0, unread: unread && i === 0 }));
  const lagging = backfillProgress({ state: 'RUNNING', sources: src(true), pendingEvents: 0, openEvents: 0, doneEvents: 10, dbNow });
  assert.equal(lagging.caughtUp, false);
  assert.equal(lagging.nextState, 'RUNNING');
  assert.equal(lagging.sources[0].lagMs, 3_600_000);
  const pending = backfillProgress({ state: 'RUNNING', sources: src(false), pendingEvents: 3, openEvents: 3, doneEvents: 10, dbNow });
  assert.equal(pending.nextState, 'RUNNING');
  const done = backfillProgress({ state: 'RUNNING', sources: src(false), pendingEvents: 0, openEvents: 2, doneEvents: 10, dbNow });
  assert.equal(done.nextState, 'DONE');
  assert.equal(backfillProgress({ state: 'PAUSED', sources: src(false), pendingEvents: 0, openEvents: 0, doneEvents: 0, dbNow }).nextState, 'PAUSED');
});

// ═══ حركات مستوردة بعد تاريخ البدء (خطة الاستيراد، البند 2ج) ═══

test('importedAfterCutover: صف مستورد بتاريخ ≥ البدء وcreatedAt ≤ اللقطة يُعدّ ولا يدخل الذمم؛ قبل البدء والتسوية اليدوية لا', () => {
  const imported = [
    // يوم البدء بتوقيت الرياض ⇒ بعد البدء
    entry({ id: 'imp-after', customerId: 'c1', type: 'ADJUSTMENT_DEBIT', debit: 500, entryDate: at('2026-12-31T21:00:00.000Z'), createdAt: at('2027-01-10T08:00:00Z') }),
    entry({ id: 'imp-after2', customerId: 'c2', type: 'ADJUSTMENT_CREDIT', credit: 120.25, entryDate: at('2027-01-05T08:00:00Z'), createdAt: at('2027-01-10T08:00:00Z') }),
    // قبل البدء ⇒ في الافتتاح، لا يُعدّ
    entry({ id: 'imp-before', customerId: 'c1', type: 'ADJUSTMENT_DEBIT', debit: 1000, entryDate: at('2026-12-31T20:59:59.999Z'), createdAt: at('2027-01-10T08:00:00Z') }),
    // بعد اللقطة ⇒ لا يُعدّ
    entry({ id: 'imp-late', customerId: 'c3', type: 'ADJUSTMENT_DEBIT', debit: 70, entryDate: at('2027-01-05T08:00:00Z'), createdAt: new Date(T0.getTime() + 1) }),
  ];
  const manual = entry({ id: 'manual-adj', customerId: 'c4', type: 'ADJUSTMENT_DEBIT', debit: 999, entryDate: at('2027-01-05T08:00:00Z'), createdAt: at('2027-01-06T08:00:00Z') });
  const invoiceRow = entry({ id: 'imp-inv', customerId: 'c1', type: 'INVOICE_DEBIT', invoiceId: 'i9', debit: 10, entryDate: at('2027-01-05T08:00:00Z'), createdAt: at('2027-01-06T08:00:00Z') });
  const rows = [...imported, manual, invoiceRow];
  const ids = new Set([...imported.map((r) => r.id), 'imp-inv']);
  const s = computeImportedAfterCutover(rows, ids, CUT, DEC);
  assert.equal(s.count, 2);
  assert.equal(s.customers, 2);
  assert.equal(s.debitMilli, 500_000n);
  assert.equal(s.creditMilli, 120_250n);
  assert.deepEqual(importedAfterCutoverJson(s, DEC), {
    count: 2, customers: 2, debit: '500.00', credit: '120.25', futureDated: 0, maxEntryDate: '2027-01-05',
  });
  // لا يدخل سطور AR: الافتتاح يأخذ صف ما قبل البدء وحده
  const d = computeDerivedOpening(sources({ accountEntries: rows }), CUT, { decimals: DEC, routing: ROUTING });
  assert.deepEqual(d.receivables.map((r) => [r.customerId, r.balanceMilli]), [['c1', 1_000_000n]]);
  // بلا دفعات ⇒ صفر
  assert.equal(computeImportedAfterCutover(rows, new Set(), CUT, DEC).count, 0);
  // recordIds: مصفوفة نصوص فقط
  assert.deepEqual(importBatchRecordIds('["a","b",3]'), ['a', 'b']);
  assert.deepEqual(importBatchRecordIds('{"products":["x"]}'), []);
  assert.deepEqual(importBatchRecordIds('not json'), []);
});

test('/setup/commit: حركات مستوردة بعد البدء بلا إقرار ⇒ 409 LEDGER_POST_CUTOVER_IMPORTS_ACK، ومع الإقرار يمضي', () => {
  assert.equal(postCutoverImportsAckMissing({ count: 3 }, undefined), true);
  assert.equal(postCutoverImportsAckMissing({ count: 3 }, false), true);
  assert.equal(postCutoverImportsAckMissing({ count: 3 }, true), false);
  assert.equal(postCutoverImportsAckMissing({ count: 0 }, undefined), false);
  const r = ledgerErrorResponse(new LedgerHttpError(409, LEDGER_POST_CUTOVER_IMPORTS_ACK_MESSAGE, { reason: 'POST_CUTOVER_IMPORTS_ACK_REQUIRED' }, 'LEDGER_POST_CUTOVER_IMPORTS_ACK'))!;
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'LEDGER_POST_CUTOVER_IMPORTS_ACK');
  assert.equal(r.body.reason, 'POST_CUTOVER_IMPORTS_ACK_REQUIRED');
  // حارس ثابت: الفحص داخل المعاملة وقبل أي كتابة، والمعاينة تعيد الحقل، والمخطط يقبل الإقرار
  const commit = handlerBody(SETUP_SRC, "router.post('/setup/commit'");
  assertOrder(commit, [
    'acquirePostLock(tx, tenantId)', 'assertCutoverNotInFuture(cutoverDate', 'loadImportedAfterCutover(tx',
    'postCutoverImportsAckMissing(importedAfterCutover, parsed.data.acknowledgePostCutoverImports)', "'LEDGER_POST_CUTOVER_IMPORTS_ACK'",
    'ensureSettingsRow(', 'seedTemplate(tx', 'postMove(tx',
  ], '/setup/commit ack');
  assert.match(SETUP_SRC, /acknowledgePostCutoverImports: z\.union\(\[z\.boolean\(\), postCutoverImportsAckSchema\]\)\.optional\(\)/);
  const preview = handlerBody(SETUP_SRC, "router.post('/setup/preview-opening'");
  assert.match(preview, /loadImportedAfterCutover\(prisma, tenantId, cut, decimals\)/);
  assert.match(preview, /importedAfterCutover: importedAfterCutoverJson\(/);
  // المُحمِّل محصور في دفعات balances/ledger غير المتراجَع عنها
  const opening = fs.readFileSync(path.join(__dirname, '..', 'services', 'gl', 'opening.ts'), 'utf8');
  const loader = opening.slice(opening.indexOf('export async function loadImportedAfterCutover('), opening.indexOf('// ═══ JSON للاستجابة ═══'));
  assert.match(loader, /reverted: false, kind: \{ in: \[\.\.\.IMPORT_ENTRY_BATCH_KINDS\] \}/);
  assert.match(loader, /invoiceId: null, receiptId: null/);
  assert.match(loader, /entryDate: \{ gte: cut\.cutoverStart \}, createdAt: \{ lte: cut\.snapshotAt \}/);
});

// ═══ LEDGER_IMPORT_IN_PROGRESS ═══

test('/setup/commit: دفعة استيراد جارية ⇒ 409 LEDGER_IMPORT_IN_PROGRESS، والمنقطعة والمنتهية لا تمنع', () => {
  const NOW = new Date('2027-01-15T09:00:00.000Z');
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const row = (id: string, p: Partial<ImportBatchStateRow>): ImportBatchStateRow =>
    ({ id, kind: 'balances', createdAt: ago(60 * 60_000), status: null, heartbeatAt: null, ...p });
  // قلب ينبض خلال المهلة ⇒ جارية
  const live = row('b-live', { kind: 'ledger', status: 'running', heartbeatAt: ago(IMPORT_RUNNING_STALE_MS - 1_000) });
  assert.equal(findRunningImportBatch([live], NOW)?.id, 'b-live');
  // نبض متوقف أكثر من المهلة ⇒ منقطعة لا تمنع؛ وبلا نبض يُحتسب من createdAt
  assert.equal(findRunningImportBatch([row('b-stale', { status: 'running', heartbeatAt: ago(IMPORT_RUNNING_STALE_MS + 1_000) })], NOW), null);
  assert.equal(findRunningImportBatch([row('b-old', { status: 'running', heartbeatAt: null })], NOW), null);
  assert.equal(findRunningImportBatch([row('b-new', { status: 'running', heartbeatAt: null, createdAt: ago(5_000) })], NOW)?.id, 'b-new');
  // done / interrupted / null (دفعات ما قبل الحجز) لا تمنع
  assert.equal(findRunningImportBatch([row('d', { status: 'done', heartbeatAt: ago(0) }), row('i', { status: 'interrupted', heartbeatAt: ago(0) }), row('n', {})], NOW), null);
  // الجارية بين غيرها تُلتقط
  assert.equal(findRunningImportBatch([row('d', { status: 'done' }), row('s', { status: 'running', heartbeatAt: ago(IMPORT_RUNNING_STALE_MS * 2) }), live], NOW)?.id, 'b-live');

  const details = importInProgressDetails(live);
  assert.equal(details.reason, 'IMPORT_IN_PROGRESS');
  assert.equal(details.batchId, 'b-live');
  assert.equal(details.kind, 'ledger');
  const r = ledgerErrorResponse(new LedgerHttpError(409, LEDGER_IMPORT_IN_PROGRESS_MESSAGE, details, 'LEDGER_IMPORT_IN_PROGRESS'))!;
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'LEDGER_IMPORT_IN_PROGRESS');
  assert.equal(r.body.reason, 'IMPORT_IN_PROGRESS');
  assert.equal(r.body.batchId, 'b-live');

  // حارس ثابت: داخل معاملة الاعتماد، بعد قفل الترحيل، وقفل حجز الدفعات قبل الفحص، وكل ذلك قبل أي كتابة
  const commit = handlerBody(SETUP_SRC, "router.post('/setup/commit'");
  assertOrder(commit, [
    'prisma.$transaction(async (tx)', 'acquirePostLock(tx, tenantId)', 'assertNotActivated(before)', 'acquireImportEntriesLock(tx, tenantId)',
    'loadRunningImportBatch(tx, tenantId, dbNow)', "'LEDGER_IMPORT_IN_PROGRESS'", 'ensureSettingsRow(', 'seedTemplate(tx', 'postMove(tx',
  ], '/setup/commit import in progress');
  // القفل نفسه الذي يأخذه حجز دفعات الاستيراد، والتحميل على كل الأنواع غير المتراجَع عنها بحالة running
  const importSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'import.ts'), 'utf8');
  assert.ok(importSrc.includes(`'${IMPORT_ENTRIES_LOCK_PREFIX}'`), 'بادئة القفل تطابق routes/import.ts');
  assert.match(importSrc, /pg_advisory_xact_lock\(hashtext\(\$\{IMPORT_ENTRIES_LOCK_PREFIX \+ tid\}::text\)\)/);
  const opening = fs.readFileSync(path.join(__dirname, '..', 'services', 'gl', 'opening.ts'), 'utf8');
  const loader = opening.slice(opening.indexOf('export async function loadRunningImportBatch('), opening.indexOf('export function importInProgressDetails('));
  assert.match(loader, /where: \{ tenantId, reverted: false, status: IMPORT_BATCH_RUNNING \}/);
  assert.match(loader, /findRunningImportBatch\(rows, now\)/);
  assert.match(opening, /pg_advisory_xact_lock\(hashtext\(\$\{IMPORT_ENTRIES_LOCK_PREFIX \+ tenantId\}::text\)\)/);
});

// ═══ البند 9: المخزون الافتتاحي المستورد (opening_stock) ═══
import { openingStockProductFinder, resolveOpeningStockRows } from '../services/importLedger';

test('opening_stock: حركة وارد مستوردة بتكلفة صافية وcreatedAt قبل البدء تظهر في قيمة المستودع بالقيد الافتتاحي، وبعد البدء لا', () => {
  const find = openingStockProductFinder([
    { id: 'p1', code: 'A-1', barcode: null, name: 'أرز', taxPct: 15 },
    { id: 'p2', code: 'B-2', barcode: '628000', name: 'سكر', taxPct: 15 },
  ]);
  // التكلفة شاملة الضريبة: 11.5 ⇒ 10 صافٍ، و23 ⇒ 20
  const { lines, errors } = resolveOpeningStockRows([
    { productCode: 'A-1', qty: 12, unitCost: 11.5 },
    { barcode: '628000', qty: 5, unitCost: 23 },
  ], find, true);
  assert.equal(errors.length, 0);
  assert.deepEqual(lines.map((l) => l.unitCost), [10, 20]);
  const importedAt = at('2026-12-20T10:00:00Z'); // createdAt الحركة المستوردة قبل البدء
  const asItems = (createdAt: Date) => lines.map((l) => ({ productId: l.productId, qty: l.qty, type: 'RECEIVE', unitCost: l.unitCost, createdAt }));
  const d = computeDerivedOpening(sources({ warehouseItems: asItems(importedAt) }), CUT, { decimals: DEC, routing: ROUTING });
  // 12 × 10 + 5 × 20 = 220
  assert.equal(d.warehouse.valueMilli, 220_000n);
  assert.equal(d.warehouse.uncostedQty, 0);
  assert.equal(d.counts.warehouseMovesIncluded, 2);
  const move = buildOpeningMove({ derived: d, manual: [], ctx: saContext() });
  const inv = move.draft!.lines.find((l) => l.accountKey === 'INVENTORY_WAREHOUSE')!;
  assert.equal(inv.debitMilli, 220_000n);
  const eq = move.draft!.lines.find((l) => l.accountKey === 'OPENING_EQUITY')!;
  assert.equal(eq.creditMilli, 220_000n);
  assert.doesNotThrow(() => validateMove(move.draft!, saContext(), { mode: 'SYSTEM' }));
  // مستوردة في يوم البدء نفسه (createdAt ≥ cutoverStart) ⇒ خارج الافتتاح — لذلك يرفض الاستيراد تاريخ بدء ≤ اليوم
  const after = computeDerivedOpening(sources({ warehouseItems: asItems(CUT.cutoverStart) }), CUT, { decimals: DEC, routing: ROUTING });
  assert.equal(after.warehouse.valueMilli, 0n);
  assert.equal(after.counts.warehouseMovesIncluded, 0);
});

// ═══ البنود 39 و41 و42 (مراجعة الاستيراد 2026-09-17، الدفعة 3) ═══

test('البند 39: حركة مستوردة بتاريخ أبعد من اليوم + يوم تُعدّ تنبيهاً معدوداً (خطأ سنة) ولا تمنع', () => {
  // الحدّ: «اليوم» بتوقيت الشركة + يوم واحد (سعة لفروق المناطق)
  assert.equal(IMPORT_FUTURE_DATE_GRACE_DAYS, 1);
  assert.equal(maxImportEntryDate(COMMIT_NOW, TZ), '2027-01-16');
  assert.equal(isImportDateTooFarAhead(at('2027-01-16T20:00:00Z'), COMMIT_NOW, TZ), false, 'الحدّ نفسه مقبول');
  assert.equal(isImportDateTooFarAhead(at('2027-01-16T21:00:00Z'), COMMIT_NOW, TZ), true, '17 يناير بتوقيت الرياض');
  assert.equal(isImportDateTooFarAhead(at('2052-03-15T09:00:00Z'), COMMIT_NOW, TZ), true);
  assert.equal(isImportDateTooFarAhead(at('2020-03-15T09:00:00Z'), COMMIT_NOW, TZ), false);
  // 21:30 UTC = يوم تالٍ بالرياض ⇒ الحدّ يتقدّم يوماً عن UTC
  assert.equal(maxImportEntryDate(new Date('2027-01-15T21:30:00.000Z'), TZ), '2027-01-17');
  assert.equal(maxImportEntryDate(new Date('2027-01-15T21:30:00.000Z'), 'UTC'), '2027-01-16');

  const rows = [
    entry({ id: 'ok', customerId: 'c1', type: 'ADJUSTMENT_DEBIT', debit: 100, entryDate: at('2027-01-05T08:00:00Z'), createdAt: at('2027-01-10T08:00:00Z') }),
    // 2052 بدل 2025: تدخل العدّ والمجموع كغيرها، وتُوسم futureDated
    entry({ id: 'yr', customerId: 'c2', type: 'ADJUSTMENT_DEBIT', debit: 40, entryDate: at('2052-03-15T09:00:00Z'), createdAt: at('2027-01-10T08:00:00Z') }),
  ];
  const s = computeImportedAfterCutover(rows, new Set(rows.map((r) => r.id)), CUT, DEC);
  assert.equal(s.count, 2);
  assert.equal(s.futureDated, 1);
  assert.equal(s.maxEntryDate, '2052-03-15');
  assert.equal(importedAfterCutoverJson(s, DEC).futureDated, 1);
  assert.equal(importedAfterCutoverJson(s, DEC).maxEntryDate, '2052-03-15');
  // بلا حركات ⇒ لا تاريخ ولا تنبيه
  const none = computeImportedAfterCutover([], new Set(), CUT, DEC);
  assert.deepEqual([none.count, none.futureDated, none.maxEntryDate], [0, 0, null]);
});

test('البند 41: الإقرار مربوط باللقطة المعروضة — اختلاف العدد أو المبلغ ⇒ إقرار قديم على واقع جديد', () => {
  const snap = (count: number, debit: bigint, credit: bigint) =>
    ({ count, customers: count, debitMilli: debit, creditMilli: credit, futureDated: 0, maxEntryDate: '2027-01-05' as const });
  const current = snap(3, 500_000n, 0n);
  // الإقرار المنطقي القديم: يمرّ كما كان (توافق) لكنه غير مربوط
  assert.equal(postCutoverImportsAcknowledged(true), true);
  assert.equal(postCutoverImportsAcknowledged(false), false);
  assert.equal(postCutoverImportsAcknowledged(undefined), false);
  assert.equal(postCutoverImportsAckMissing({ count: 3 }, true), false);
  assert.equal(postCutoverImportsAckMissing({ count: 3 }, { count: 3, debit: '500.00', credit: '0.00' }), false);
  assert.equal(postCutoverImportsAckMissing({ count: 3 }, undefined), true);
  assert.equal(postCutoverImportsAckStale(current, DEC, true), null, 'المنطقي لا يُقارن');
  // اللقطة المطابقة تمرّ
  assert.equal(postCutoverImportsAckStale(current, DEC, { count: 3, debit: '500.00', credit: '0.00', snapshotAt: '2027-01-15T08:55:00.000Z' }), null);
  // 8000 حركة استُوردت بعد الإقرار ⇒ اختلاف العدد
  const grown = postCutoverImportsAckStale(snap(8003, 900_000n, 0n), DEC, { count: 3, debit: '500.00', credit: '0.00' });
  assert.ok(grown);
  assert.deepEqual(grown!.acked, { count: 3, debit: '500.00', credit: '0.00' });
  assert.deepEqual(grown!.current, { count: 8003, debit: '900.00', credit: '0.00' });
  // العدد نفسه والمبلغ مختلف (صفوف بُدّلت) ⇒ اختلاف كذلك
  assert.ok(postCutoverImportsAckStale(snap(3, 700_000n, 0n), DEC, { count: 3, debit: '500.00', credit: '0.00' }));
  assert.ok(postCutoverImportsAckStale(current, DEC, { count: 3, debit: '500.00', credit: '120.25' }));
  // المقارنة بالملّي: اختلاف منازل العرض بين المعاينة والاعتماد لا يُفشل إقراراً صحيحاً
  assert.equal(postCutoverImportsAckStale(current, DEC, { count: 3, debit: '500', credit: '0' }), null);
  assert.equal(postCutoverImportsAckStale(current, 3, { count: 3, debit: '500.000', credit: '0.000' }), null);
  // مبلغ غير صالح لا يرمي بل يُعدّ اختلافاً
  assert.ok(postCutoverImportsAckStale(current, DEC, { count: 3, debit: 'خمسمائة', credit: '0.00' }));

  const r = ledgerErrorResponse(new LedgerHttpError(409, LEDGER_POST_CUTOVER_IMPORTS_CHANGED_MESSAGE, {
    reason: 'POST_CUTOVER_IMPORTS_CHANGED', acknowledged: grown!.acked,
  }, 'LEDGER_POST_CUTOVER_IMPORTS_CHANGED'))!;
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'LEDGER_POST_CUTOVER_IMPORTS_CHANGED');
  assert.equal(r.body.reason, 'POST_CUTOVER_IMPORTS_CHANGED');

  // حارس ثابت: الفحص بعد فحص «الإقرار مفقود» وقبل أي كتابة، والتدقيق يثبت ما أُقرّ به
  const commit = handlerBody(SETUP_SRC, "router.post('/setup/commit'");
  assertOrder(commit, [
    'loadImportedAfterCutover(tx', 'postCutoverImportsAckMissing(importedAfterCutover',
    'postCutoverImportsAckStale(importedAfterCutover, currencyDecimalsForCheck, parsed.data.acknowledgePostCutoverImports)',
    "'LEDGER_POST_CUTOVER_IMPORTS_CHANGED'", 'ensureSettingsRow(', 'seedTemplate(tx',
  ], '/setup/commit ack snapshot');
  assert.match(commit, /postCutoverImportsAck: typeof parsed\.data\.acknowledgePostCutoverImports === 'object'/);
  assert.match(SETUP_SRC, /const postCutoverImportsAckSchema = z\.object\(\{/);
});

test('البند 42: لقطة الاعتماد تُقرأ بساعة القاعدة بعد حيازة القفلين (clock_timestamp لا now)', () => {
  assert.match(SETUP_SRC, /export async function dbClockOf\(/);
  assert.match(SETUP_SRC, /SELECT clock_timestamp\(\) AS "now"/);
  // now() يبقى لغير الاعتماد (المسودة والحالة وPUT /ledger/settings) كما كان
  assert.match(SETUP_SRC, /SELECT now\(\) AS "now"/);
  const commit = handlerBody(SETUP_SRC, "router.post('/setup/commit'");
  assertOrder(commit, [
    'acquirePostLock(tx, tenantId)', 'acquireImportEntriesLock(tx, tenantId)', 'const dbNow = await dbClockOf(tx)',
    'const T0 = openingSnapshotFromDbNow(dbNow)', 'loadRunningImportBatch(tx, tenantId, dbNow)', 'loadImportedAfterCutover(tx',
    'activatedAt: dbNow',
  ], '/setup/commit clock');
  // لا قراءة ساعة قبل القفلين داخل المعاملة (وإلا فاتتها كتابات الانتظار)
  const beforeLocks = commit.slice(0, commit.indexOf('acquirePostLock(tx, tenantId)'));
  assert.doesNotMatch(beforeLocks, /dbNowOf\(|dbClockOf\(/);
});
