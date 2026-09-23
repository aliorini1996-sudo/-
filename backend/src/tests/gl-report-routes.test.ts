// M4 — دفتر الأستاذ العام ونقاط التقارير (DESIGN.md §7.1، §7.5 ORPT‑02، RPT‑01، RPT‑08، ملحق أ، §9.3، §9.4).
//
// بلا قاعدة بيانات: منطق دفتر الأستاذ صرف (`reports/generalLedger.ts` يستقبل مصفوفات)، وكل ما يُختبر من
// المسار دوالٌّ صرفة مُصدَّرة منه (الخيارات، السقوف، التنبيهات، شرط قراءة السطور، بصمة التدقيق،
// ومؤشّر keyset وتركيب الصفحة الكسولة). ومعها حراس ثابتة على النصّ: الصلاحية على النقطتين، ومحدد
// التصدير، وصفّ التدقيق بعد فحص السقف، وأن التصدير لا يمرّ بالترقيم، وأن فتح التقرير لا يستدعي
// المزامنة ولا يكتب في القاعدة.
//
// **الرفض الفعلي** بـ403 لمن لا يملك `canViewLedger` يُثبَت سلوكياً في `gl-report-access.test.ts`
// (استدعاء سلسلة المسار الحقيقية بـreq/res مقلَّدين)، لا بحارس نصّي.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  GENERAL_LEDGER_MAX_PAGE_SIZE, GENERAL_LEDGER_PAGE_SIZE, buildGeneralLedger, compareLedgerLines,
  generalLedgerDrilldownPath, generalLedgerExportLines, isShiftedLine, normalizePage, normalizePageSize,
  sortLedgerLines, type LedgerLineInput,
} from '../services/gl/reports/generalLedger';
import { toDbDate } from '../services/gl/dates';
import { makePeriod } from '../services/gl/reports/period';
import { zeroBalance } from '../services/gl/reports/balances';
import type { AccountBalance, ReportAccount } from '../services/gl/reports/types';
import {
  LEDGER_LINES_MAX, LEDGER_LINE_ORDER_BY, LATER_REPORT_KEYS, REPORT_EXPORT_CAPS, REPORT_KEYS, RPT08_MESSAGE,
  STATEMENT_BUILDERS, aggregateLedgerLines, aggregateLineCount, assertExportUnderCap, buildLedgerSkeleton,
  buildReportWarnings, canonicalReportKey, carriedForwardAfter, dateModeCoerced, decodeLedgerCursor,
  defaultDateFilter, emptyLedgerAggregate, encodeLedgerCursor, isReportKey, isStatementKey, ledgerCursorScope,
  ledgerLineAfterWhere, ledgerLineBeforeWhere, ledgerLineKeyOf, ledgerLineWhere, mergeLedgerPages,
  parseReportRequest, reportExportSchema, reportJson, reportOptionsHash, reportQuerySchema, resolveDateFilter,
  statementComparisonPeriods, statementExtras,
  type LedgerLineAggregate, type LedgerPagePosition, type LedgerPageResult,
} from '../routes/ledger/reports';
import {
  EXPORT_TOO_LARGE_MESSAGE, LEDGER_ERROR_MESSAGES, LedgerHttpError, RANGE_TOO_LARGE_MESSAGE, ledgerErrorResponse,
} from '../routes/ledger/errors';
import { LedgerError, isLedgerError } from '../services/gl/types';

const ROUTES = path.join(__dirname, '../routes/ledger');
const SERVICES = path.join(__dirname, '../services/gl/reports');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const routeCode = (f: string) => stripComments(fs.readFileSync(path.join(ROUTES, f), 'utf8'));
const serviceCode = (f: string) => stripComments(fs.readFileSync(path.join(SERVICES, f), 'utf8'));

// ═══ متجهات دفتر الأستاذ ═══

const ACCOUNTS: ReportAccount[] = [
  { id: 'a-cash', code: '111001', name: 'الصندوق', nameI18n: { ar: 'الصندوق', en: 'Cash' }, type: 'asset_cash' },
  { id: 'a-ar', code: '113001', name: 'ذمم العملاء', nameI18n: null, type: 'asset_receivable' },
  { id: 'a-rev', code: '411001', name: 'المبيعات', nameI18n: null, type: 'income' },
];

const MARCH = makePeriod('2026-03-01', '2026-03-31');

function balance(accountId: string, over: Partial<AccountBalance> = {}): AccountBalance {
  return { ...zeroBalance(accountId), ...over };
}

let seq = 0;
function line(over: Partial<LedgerLineInput> = {}): LedgerLineInput {
  seq += 1;
  const id = over.id ?? `l-${String(seq).padStart(5, '0')}`;
  return {
    id,
    moveId: over.moveId ?? `m-${id}`,
    accountId: 'a-cash',
    date: '2026-03-10',
    originalDate: null,
    lateArrival: false,
    seq: 0,
    moveNumber: 'INV/2026/0001',
    moveState: 'POSTED',
    moveType: 'OUT_INVOICE',
    journalId: 'j-sale',
    journalCode: 'INV',
    journalName: 'المبيعات',
    partnerId: null,
    partnerName: null,
    salesRepId: null,
    salesRepName: null,
    analyticAccountId: null,
    label: null,
    debitMilli: 0n,
    creditMilli: 0n,
    ...over,
  };
}

// ═══ دفتر الأستاذ: الرصيد الجاري والإجمالي (§7.5) ═══

test('دفتر الأستاذ: رصيد جارٍ مشتق وإجمالي = الافتتاحي + مدين − دائن', () => {
  const result = buildGeneralLedger({
    period: MARCH,
    accounts: [ACCOUNTS[0]],
    balances: [balance('a-cash', { openingMilli: 1_000_000n })],
    lines: [
      line({ id: 'l-a', date: '2026-03-02', moveNumber: 'REC/1', debitMilli: 500_000n }),
      line({ id: 'l-b', date: '2026-03-20', moveNumber: 'PAY/1', creditMilli: 200_000n }),
    ],
  });
  const s = result.sections[0];
  assert.equal(s.openingMilli, 1_000_000n);
  assert.equal(s.openingBalanceMilli, 1_000_000n);
  assert.deepEqual(s.lines.map((l) => l.runningMilli), [1_500_000n, 1_300_000n]);
  assert.equal(s.debitMilli, 500_000n);
  assert.equal(s.creditMilli, 200_000n);
  assert.equal(s.endingMilli, 1_300_000n);
  assert.equal(s.carriedForwardMilli, 1_000_000n);
  assert.equal(s.carriedOutMilli, 1_300_000n);
  assert.equal(s.lineCount, 2);
  assert.equal(result.totals.endingMilli, 1_300_000n);
  assert.equal(result.totals.lineCount, 2);
  assert.equal(result.totals.displayedLineCount, 2);
});

test('دفتر الأستاذ: الترتيب بالتاريخ ثم الرقم ثم التسلسل، والمسودة بلا رقم بعد المرقّمة', () => {
  const a = line({ id: 'l-1', date: '2026-03-10', moveNumber: 'A/2', seq: 0 });
  const b = line({ id: 'l-2', date: '2026-03-10', moveNumber: 'A/1', seq: 1 });
  const c = line({ id: 'l-3', date: '2026-03-09', moveNumber: 'Z/9' });
  const d = line({ id: 'l-4', date: '2026-03-10', moveNumber: null, moveState: 'DRAFT' });
  const sorted = sortLedgerLines([a, d, b, c]).map((l) => l.id);
  assert.deepEqual(sorted, ['l-3', 'l-2', 'l-1', 'l-4']);
  // الحتمية: المقارنة لا تعيد 0 لسطرين مختلفين
  assert.notEqual(compareLedgerLines(a, b), 0);
  assert.equal(compareLedgerLines(a, a), 0);
});

test('دفتر الأستاذ: ترقيم 500 سطر لكل حساب مع «رصيد مُرحَّل» لكل صفحة', () => {
  const lines = Array.from({ length: 1_200 }, (_, i) => line({
    id: `p-${String(i).padStart(4, '0')}`,
    date: '2026-03-15',
    moveNumber: `S/${String(i).padStart(4, '0')}`,
    debitMilli: 1_000n,
  }));
  const page1 = buildGeneralLedger({
    period: MARCH, accounts: [ACCOUNTS[0]], balances: [balance('a-cash', { openingMilli: 7_000n })], lines,
  });
  const s1 = page1.sections[0];
  assert.equal(s1.pageSize, GENERAL_LEDGER_PAGE_SIZE);
  assert.equal(s1.lines.length, 500);
  assert.equal(s1.pageCount, 3);
  assert.equal(s1.hasMore, true);
  assert.equal(s1.carriedForwardMilli, 7_000n);
  assert.equal(s1.lineCount, 1_200);
  // الإجماليات على كل السطور لا على الصفحة (لا تنقص بالترقيم)
  assert.equal(s1.debitMilli, 1_200_000n);
  assert.equal(s1.endingMilli, 7_000n + 1_200_000n);

  const page3 = buildGeneralLedger({
    period: MARCH, accounts: [ACCOUNTS[0]], balances: [balance('a-cash', { openingMilli: 7_000n })], lines,
    options: { page: 3 },
  });
  const s3 = page3.sections[0];
  assert.equal(s3.lines.length, 200);
  assert.equal(s3.offset, 1_000);
  assert.equal(s3.hasMore, false);
  // «رصيد مُرحَّل» = الرصيد الجاري قبل أول سطر في الصفحة
  assert.equal(s3.carriedForwardMilli, 7_000n + 1_000_000n);
  assert.equal(s3.lines[0].runningMilli, 7_000n + 1_001_000n);
  assert.equal(s3.carriedOutMilli, s3.endingMilli);

  // صفحة أبعد من النهاية تُقصّ إلى الأخيرة ولا تُرجع فراغاً صامتاً
  const far = buildGeneralLedger({
    period: MARCH, accounts: [ACCOUNTS[0]], balances: [], lines, options: { page: 99 },
  });
  assert.equal(far.sections[0].page, 3);
});

test('التصدير لا يمرّ بالترقيم: pageSize=null يعيد كل السطور (§7.1 RPT‑01)', () => {
  const lines = Array.from({ length: 1_200 }, (_, i) => line({
    id: `x-${String(i).padStart(4, '0')}`, date: '2026-03-15', moveNumber: `S/${i}`, debitMilli: 1_000n,
  }));
  const full = buildGeneralLedger({
    period: MARCH, accounts: [ACCOUNTS[0]], balances: [], lines, options: { pageSize: null, page: 4 },
  });
  const s = full.sections[0];
  assert.equal(full.paginated, false);
  assert.equal(full.pageSize, null);
  assert.equal(s.lines.length, 1_200);
  assert.equal(s.hasMore, false);
  assert.equal(s.page, 1);
  assert.equal(s.pageCount, 1);
  assert.equal(full.totals.displayedLineCount, full.totals.lineCount);
  // سطور الملف = السطور + صفّا الافتتاح والإجمالي لكل حساب
  assert.equal(generalLedgerExportLines(full), 1_202);
});

test('حجم الصفحة: صفر أو سالب أو ضخم لا يُسقط الترقيم (‏null وحده يُسقطه)', () => {
  assert.equal(normalizePageSize(undefined), GENERAL_LEDGER_PAGE_SIZE);
  assert.equal(normalizePageSize(0), GENERAL_LEDGER_PAGE_SIZE);
  assert.equal(normalizePageSize(-5), GENERAL_LEDGER_PAGE_SIZE);
  assert.equal(normalizePageSize(Number.NaN), GENERAL_LEDGER_PAGE_SIZE);
  assert.equal(normalizePageSize(10_000), GENERAL_LEDGER_MAX_PAGE_SIZE);
  assert.equal(normalizePageSize(120), 120);
  assert.equal(normalizePageSize(null), null);
  assert.equal(normalizePage(0), 1);
  assert.equal(normalizePage(-3), 1);
  assert.equal(normalizePage(2.9), 2);
});

test('دفتر الأستاذ: بنود الإقفال سطورٌ موسومة، والبذرة تضمّ إقفال ما قبل الفترة', () => {
  const result = buildGeneralLedger({
    period: MARCH,
    accounts: [ACCOUNTS[2]],
    balances: [balance('a-rev', { openingMilli: -400_000n, closingOpeningMilli: 100_000n })],
    lines: [
      line({ id: 'c-1', accountId: 'a-rev', date: '2026-03-31', moveType: 'FY_CLOSING', moveNumber: 'CL/1', debitMilli: 50_000n }),
      line({ id: 'c-2', accountId: 'a-rev', date: '2026-03-05', creditMilli: 20_000n }),
    ],
  });
  const s = result.sections[0];
  assert.equal(s.openingMilli, -400_000n);
  assert.equal(s.openingBalanceMilli, -300_000n);
  const closing = s.lines.find((l) => l.id === 'c-1');
  assert.ok(closing);
  assert.equal(closing.closing, true);
  // §7.2: بند الإقفال على حساب قائمة دخل معروضٌ وموسوم، ومفصولٌ عن حركة الحساب ورصيده الجاري
  assert.equal(closing.excluded, true);
  assert.equal(s.closingExcluded, true);
  assert.equal(s.closingMilli, 50_000n);
  assert.equal(s.lines.find((l) => l.id === 'c-2')?.closing, false);
  assert.equal(s.lines.find((l) => l.id === 'c-2')?.excluded, false);
  // الإجمالي بقاعدة الميزان (بلا الإقفال المفصول)، والرصيد الفعلي بضمّه
  assert.equal(s.endingMilli, -400_000n - 20_000n);
  assert.equal(s.endingBalanceMilli, -300_000n - 20_000n + 50_000n);
});

test('دفتر الأستاذ: المسودة والمُزاح موسومان (RPT‑05، ADR‑7)', () => {
  const shifted = line({ id: 's-1', date: '2026-03-20', originalDate: '2026-02-11', lateArrival: true });
  assert.equal(isShiftedLine(shifted), true);
  assert.equal(isShiftedLine(line({ id: 's-2', date: '2026-03-20', originalDate: '2026-03-20' })), false);
  const result = buildGeneralLedger({
    period: MARCH,
    accounts: [ACCOUNTS[0]],
    balances: [],
    lines: [shifted, line({ id: 's-3', moveState: 'DRAFT', moveNumber: null })],
  });
  const rows = result.sections[0].lines;
  assert.equal(rows.find((l) => l.id === 's-1')?.shifted, true);
  assert.equal(rows.find((l) => l.id === 's-3')?.draft, true);
  assert.equal(rows.find((l) => l.id === 's-1')?.draft, false);
});

test('دفتر الأستاذ: حراس برمجية للحساب المجهول والتاريخ خارج الفترة', () => {
  assert.throws(
    () => buildGeneralLedger({
      period: MARCH, accounts: [ACCOUNTS[0]], balances: [], lines: [line({ accountId: 'a-ghost' })],
    }),
    /حساب غير مطلوب/,
  );
  assert.throws(
    () => buildGeneralLedger({
      period: MARCH, accounts: [ACCOUNTS[0]], balances: [], lines: [line({ date: '2026-04-01' })],
    }),
    /خارج الفترة/,
  );
  assert.throws(
    () => buildGeneralLedger({
      period: MARCH, accounts: [ACCOUNTS[0]], balances: [], lines: [line({ date: '2026-02-28' })],
    }),
    /خارج الفترة/,
  );
});

test('دفتر الأستاذ: إخفاء الصفري والبحث (RPT‑07، RPT‑15)', () => {
  const input = {
    period: MARCH,
    accounts: ACCOUNTS,
    balances: [balance('a-cash', { openingMilli: 5_000n })],
    lines: [line({ id: 'h-1', debitMilli: 1_000n })],
  };
  assert.equal(buildGeneralLedger(input).sections.length, 3);
  const hidden = buildGeneralLedger({ ...input, options: { hideZero: true } });
  assert.deepEqual(hidden.sections.map((s) => s.account.id), ['a-cash']);
  const searched = buildGeneralLedger({ ...input, options: { search: '113' } });
  assert.deepEqual(searched.sections.map((s) => s.account.id), ['a-ar']);
  const byName = buildGeneralLedger({ ...input, options: { search: 'cash' } });
  assert.deepEqual(byName.sections.map((s) => s.account.id), ['a-cash']);
});

test('رابط التعمّق يحمل الحساب والمدى (§7.1)', () => {
  const url = generalLedgerDrilldownPath('a-cash', { from: '2026-03-01', to: '2026-03-31' });
  assert.match(url, /^\/app\/ledger\/reports\/general-ledger\?/);
  assert.match(url, /accounts=a-cash/);
  assert.match(url, /from=2026-03-01/);
  assert.match(url, /to=2026-03-31/);
});

// ═══ السقوف (RPT‑01) ═══

test('سقوف التصدير: 50,000 لـxlsx و5,000 لـpdf وإلا 422 LEDGER_EXPORT_TOO_LARGE {lines, cap}', () => {
  assert.deepEqual(REPORT_EXPORT_CAPS, { xlsx: 50_000, pdf: 5_000 });
  assert.doesNotThrow(() => assertExportUnderCap('xlsx', 50_000));
  assert.doesNotThrow(() => assertExportUnderCap('pdf', 5_000));
  for (const [format, lines, cap] of [['xlsx', 50_001, 50_000], ['pdf', 5_001, 5_000]] as const) {
    try {
      assertExportUnderCap(format, lines);
      assert.fail('كان يجب أن يرفض');
    } catch (err) {
      assert.ok(isLedgerError(err), 'الخطأ يجب أن يكون LedgerError');
      assert.equal(err.code, 'LEDGER_EXPORT_TOO_LARGE');
      assert.equal(err.details.lines, lines);
      assert.equal(err.details.cap, cap);
    }
  }
});

// ═══ تنبيه RPT‑08 ═══

test('تنبيه RPT‑08: نصّه العربي، وأحداث المخزون منفصلة، ولا تنبيه بلا سبب', () => {
  assert.deepEqual(
    buildReportWarnings({ draftMoveCount: 0, pendingEventCount: 0, pendingStockEventCount: 0, filtered: false }),
    [],
  );
  const w = buildReportWarnings({ draftMoveCount: 2, pendingEventCount: 3, pendingStockEventCount: 4, filtered: true });
  const codes = w.map((x) => x.code);
  assert.deepEqual(codes, ['UNPOSTED_ENTRIES', 'STOCK_EVENTS_PENDING', 'FILTERED_SCAN']);
  assert.equal(w[0].message, RPT08_MESSAGE);
  assert.equal(w[0].message, 'توجد قيود غير مرحّلة أو أحداث بانتظار الترحيل ضمن هذه الفترة أو قبلها');
  assert.deepEqual(w[0].details, { draftMoves: 2, pendingEvents: 3, syncPath: '/api/ledger/sync' });
  assert.deepEqual(w[1].details, { pendingStockEvents: 4 });
  // مسودة وحدها تكفي، وحدث مخزون وحده لا يرفع تنبيه «غير مرحّلة»
  assert.deepEqual(
    buildReportWarnings({ draftMoveCount: 1, pendingEventCount: 0, pendingStockEventCount: 0, filtered: false })
      .map((x) => x.code),
    ['UNPOSTED_ENTRIES'],
  );
  assert.deepEqual(
    buildReportWarnings({ draftMoveCount: 0, pendingEventCount: 0, pendingStockEventCount: 7, filtered: false })
      .map((x) => x.code),
    ['STOCK_EVENTS_PENDING'],
  );
});

test('لا فلتر يُتجاهَل بصمت: تنبيه لكل خيار أُهمل', () => {
  const codes = buildReportWarnings({
    draftMoveCount: 0, pendingEventCount: 0, pendingStockEventCount: 0, filtered: false,
    comparisonIgnored: true, accountFilterIgnored: true, dateModeCoerced: true,
  }).map((x) => x.code);
  assert.deepEqual(codes, ['COMPARISON_NOT_SUPPORTED', 'ACCOUNT_FILTER_IGNORED', 'DATE_MODE_AS_OF']);
});

// ═══ المفاتيح والفترات ═══

test('المفاتيح الخمسة (ومنها الملخّص التنفيذي ORPT‑09)، وتقارير المراحل التالية ليست «مجهولة»', () => {
  assert.deepEqual([...REPORT_KEYS], ['trial-balance', 'income-statement', 'balance-sheet', 'general-ledger', 'executive-summary']);
  for (const k of REPORT_KEYS) assert.equal(isReportKey(k), true);
  assert.equal(isReportKey('partner-ledger'), false);
  assert.ok((LATER_REPORT_KEYS as readonly string[]).includes('partner-ledger'));
  // الملخّص التنفيذي خرج من «المراحل التالية» إلى التقارير الحيّة (§7.3 ORPT‑09، مرحلته M4)
  assert.equal((LATER_REPORT_KEYS as readonly string[]).includes('executive-summary'), false);
  assert.equal(isStatementKey('general-ledger'), false);
  assert.equal(isStatementKey('executive-summary'), true);
  assert.deepEqual(Object.keys(STATEMENT_BUILDERS).sort(), ['balance-sheet', 'executive-summary', 'income-statement', 'trial-balance']);
});

test('جسر القوائم الثلاث: كل مفتاح يعيد rows وtotals وlineCount من وحدته', () => {
  const settings = {
    configured: true,
    fy: { endMonth: 12, endDay: 31 },
    currency: 'SAR',
    currencyDecimals: 2,
    timezone: 'Asia/Riyadh',
    drawingsAfterNetProfit: false,
    depreciationInOperatingExpenses: false,
  };
  const options = parseReportRequest('trial-balance', {}, '2026-03-17').options;
  const balances: AccountBalance[] = [
    balance('a-cash', { debitMilli: 300_000n }),
    balance('a-rev', { creditMilli: 300_000n }),
  ];
  // الميزانية تشترط [FYStart(D), D] — وهو ما يضمنه إجبار الوضع على asOf في المسار (§7.4)
  const AS_OF = makePeriod('2026-01-01', '2026-03-17');
  for (const key of ['trial-balance', 'income-statement', 'balance-sheet'] as const) {
    const out = STATEMENT_BUILDERS[key]({
      reportKey: key,
      period: key === 'balance-sheet' ? AS_OF : MARCH,
      accounts: ACCOUNTS,
      balances,
      settings,
      options,
      roles: { drawings: [], retainedEarnings: null },
      showZero: false,
      draftMoveCount: 0,
      comparisons: [],
    });
    assert.ok(Array.isArray(out.rows), `${key}: rows يجب أن تكون مصفوفة`);
    assert.ok(out.totals !== undefined, `${key}: totals مفقودة`);
    assert.equal(typeof out.lineCount, 'number', `${key}: lineCount مفقود (سقف التصدير يُقاس عليه)`);
    const extras = statementExtras(out);
    for (const reserved of ['rows', 'totals', 'lineCount']) {
      assert.equal(reserved in extras, false, `${key}: ${reserved} لا يجوز أن يتسرّب إلى الإضافيات`);
    }
  }
});

test('الفترات الافتراضية: الشهر للميزان، والسنة المالية لقائمة الدخل، و«اعتباراً من» للميزانية', () => {
  const today = '2026-03-17';
  assert.equal(defaultDateFilter('trial-balance', today).mode, 'month');
  assert.equal(defaultDateFilter('general-ledger', today).mode, 'month');
  assert.equal(defaultDateFilter('income-statement', today).mode, 'fiscalYear');
  assert.deepEqual(defaultDateFilter('balance-sheet', today), { mode: 'asOf', from: today, to: today });
});

test('فلتر التاريخ: المخصص يحتاج الطرفين، والنهاية لا تسبق البداية (RPT‑03)', () => {
  const today = '2026-03-17';
  assert.deepEqual(
    resolveDateFilter('trial-balance', { mode: 'custom', from: '2026-01-01', to: '2026-02-05' }, today),
    { mode: 'custom', from: '2026-01-01', to: '2026-02-05' },
  );
  assert.throws(() => resolveDateFilter('trial-balance', { mode: 'custom', from: '2026-03-10', to: '2026-03-01' }, today), (err: unknown) => {
    assert.ok(err instanceof LedgerHttpError);
    assert.equal(err.status, 400);
    assert.equal(err.details.reason, 'INVALID_RANGE');
    return true;
  });
  assert.throws(() => resolveDateFilter('trial-balance', { mode: 'custom' }, today), (err: unknown) => {
    assert.ok(err instanceof LedgerHttpError);
    assert.equal(err.details.reason, 'RANGE_REQUIRED');
    return true;
  });
});

test('الميزانية «اعتباراً من» دائماً، وأي وضع آخر يُحوَّل بتنبيه (§7.4)', () => {
  const today = '2026-03-17';
  assert.deepEqual(
    resolveDateFilter('balance-sheet', { mode: 'month', to: '2026-02-28' }, today),
    { mode: 'asOf', from: '2026-02-28', to: '2026-02-28' },
  );
  assert.equal(dateModeCoerced('balance-sheet', { mode: 'month' }), true);
  assert.equal(dateModeCoerced('balance-sheet', { mode: 'asOf' }), false);
  assert.equal(dateModeCoerced('balance-sheet', {}), false);
  assert.equal(dateModeCoerced('trial-balance', { mode: 'month' }), false);
  // asOf يقبل المرادفين asOf وto
  assert.equal(resolveDateFilter('balance-sheet', { asOf: '2026-05-01' }, today).to, '2026-05-01');
  assert.equal(resolveDateFilter('balance-sheet', {}, today).to, today);
});

test('أعمدة مقارنة الميزانية تُعاد إلى «اعتباراً من» ‏[FYStart(D), D] (§7.4)', () => {
  const asOf = makePeriod('2026-01-01', '2026-03-17');
  const options = parseReportRequest('balance-sheet', { comparison: 'sameLastYear', comparisonCount: '2' }, '2026-03-17').options;
  const cols = statementComparisonPeriods('balance-sheet', asOf, options, { endMonth: 12, endDay: 31 });
  assert.equal(cols.length, 2);
  for (const c of cols) assert.equal(c.from, c.fyStart);
  assert.equal(cols[0].to, '2025-03-17');
  assert.equal(cols[0].from, '2025-01-01');
  // الميزان وقائمة الدخل يبقيان على المدى كما هو
  const tb = statementComparisonPeriods('trial-balance', asOf, options, { endMonth: 12, endDay: 31 });
  assert.equal(tb[0].to, '2025-03-17');
  assert.equal(tb[0].from, '2025-01-01');
});

// ═══ قراءة الخيارات (zod) ═══

test('الخيارات: التصدير بلا ترقيم، والعرض بترقيم 500', () => {
  const q = { mode: 'month' as const, from: '2026-03-01' };
  assert.equal(parseReportRequest('general-ledger', q, '2026-03-17', false).pageSize, GENERAL_LEDGER_PAGE_SIZE);
  assert.equal(parseReportRequest('general-ledger', q, '2026-03-17', true).pageSize, null);
  assert.equal(parseReportRequest('general-ledger', { ...q, pageSize: '9999' }, '2026-03-17').pageSize, 500);
  assert.equal(parseReportRequest('general-ledger', { ...q, pageSize: '0' }, '2026-03-17').pageSize, 500);
  assert.equal(parseReportRequest('general-ledger', { ...q, page: '4' }, '2026-03-17').page, 4);
});

test('الخيارات: القوائم بالفواصل، والمقارنة 1..12، وتوحيد المرحّلة/المسودات', () => {
  const p = parseReportRequest('trial-balance', {
    journals: 'j1, j2 ,j1', analytic: ['x1', 'x1', 'x2'], salesReps: '', accounts: 'a1,a2', partners: 'c1',
    comparison: 'previousPeriod', comparisonCount: '99', includeDrafts: 'true', unit: '1000',
    hierarchy: '1', hideZero: 'true', showZero: 'true', search: '  نقد  ',
  }, '2026-03-17');
  assert.deepEqual([...p.options.journals], ['j1', 'j2']);
  assert.deepEqual([...p.options.analytic], ['x1', 'x2']);
  assert.deepEqual([...p.options.salesReps], []);
  assert.deepEqual(p.accounts, ['a1', 'a2']);
  assert.deepEqual(p.partners, ['c1']);
  assert.deepEqual(p.options.comparison, { kind: 'previousPeriod', count: 12 });
  assert.equal(p.options.includeDrafts, true);
  assert.equal(p.options.postedOnly, false);
  assert.equal(p.options.unit, 1000);
  assert.equal(p.options.hierarchy, true);
  assert.equal(p.options.hideZero, true);
  assert.equal(p.showZero, true);
  assert.equal(p.options.search, 'نقد');

  const posted = parseReportRequest('trial-balance', { postedOnly: 'true' }, '2026-03-17');
  assert.equal(posted.options.includeDrafts, false);
  assert.equal(posted.options.postedOnly, true);
  assert.equal(posted.options.comparison, null);
});

test('zod: التاريخ غير الصالح يُرفض، وصيغة التصدير محصورة', () => {
  assert.equal(reportQuerySchema.safeParse({ from: '2026-13-40' }).success, false);
  assert.equal(reportQuerySchema.safeParse({ mode: 'weekly' }).success, false);
  assert.equal(reportQuerySchema.safeParse({ from: '2026-03-01', unknownKey: 'x' }).success, true);
  assert.equal(reportExportSchema.safeParse({}).success, false);
  assert.equal(reportExportSchema.safeParse({ format: 'csv' }).success, false);
  assert.equal(reportExportSchema.safeParse({ format: 'pdf' }).success, true);
  assert.equal(reportExportSchema.safeParse({ format: 'xlsx' }).success, true);
});

test('بصمة الخيارات في التدقيق: ثابتة للمدخل نفسه، وتتغير بتغيّره', () => {
  const a = parseReportRequest('trial-balance', { from: '2026-03-01', journals: 'j1' }, '2026-03-17');
  const b = parseReportRequest('trial-balance', { from: '2026-03-01', journals: 'j1' }, '2026-03-17');
  const c = parseReportRequest('trial-balance', { from: '2026-03-01', journals: 'j2' }, '2026-03-17');
  assert.equal(reportOptionsHash('trial-balance', a), reportOptionsHash('trial-balance', b));
  assert.notEqual(reportOptionsHash('trial-balance', a), reportOptionsHash('trial-balance', c));
  assert.notEqual(reportOptionsHash('trial-balance', a), reportOptionsHash('balance-sheet', a));
  assert.match(reportOptionsHash('trial-balance', a), /^[0-9a-f]{16}$/);
});

// ═══ شرط قراءة السطور (§9.4، I1) ═══

test('شرط سطور الأستاذ: المدى والعزل واستبعاد سطور العلامة', () => {
  const where = ledgerLineWhere('t-1', MARCH);
  assert.equal(where.tenantId, 't-1');
  assert.equal(where.posted, true);
  assert.deepEqual(where.OR, [{ taxRole: null }, { taxRole: { not: 'MARKER' } }]);
  const range = where.date as { gte: Date; lte: Date };
  assert.equal(range.gte.toISOString().slice(0, 10), '2026-03-01');
  assert.equal(range.lte.toISOString().slice(0, 10), '2026-03-31');
});

test('شرط سطور الأستاذ: المسودات ترفع قيد posted، والفلاتر تُطبَّق كلها', () => {
  const drafts = ledgerLineWhere('t-1', MARCH, { includeDrafts: true });
  assert.equal(drafts.posted, undefined);
  const w = ledgerLineWhere('t-1', MARCH, {
    accountIds: ['a1'], journals: ['j1'], analytic: ['x1'], salesReps: ['r1'], partners: ['p1', 'p2'],
  });
  assert.deepEqual(w.accountId, { in: ['a1'] });
  assert.deepEqual(w.journalId, { in: ['j1'] });
  assert.deepEqual(w.analyticAccountId, { in: ['x1'] });
  assert.deepEqual(w.salesRepId, { in: ['r1'] });
  // الشريك عميلٌ أو مورّد، وفي AND حتى لا يزيح حارس MARKER في OR
  assert.deepEqual(w.AND, [{ OR: [{ customerId: { in: ['p1', 'p2'] } }, { vendorId: { in: ['p1', 'p2'] } }] }]);
  assert.ok(Array.isArray(w.OR), 'حارس MARKER يجب أن يبقى');
  // قائمة فارغة لا تُنتج فلتراً يُفرغ النتيجة
  const empty = ledgerLineWhere('t-1', MARCH, { accountIds: [], journals: [] });
  assert.equal(empty.accountId, undefined);
  assert.equal(empty.journalId, undefined);
});

// ═══ تسلسل الرد ═══

test('الردّ: BigInt يصير نصّاً، والإضافيات لا تزيح مفاتيح العقد', () => {
  const json = reportJson({ openingMilli: 1_500n, nested: [{ debitMilli: -7n }], plain: 'ok' }) as Record<string, unknown>;
  assert.equal(json.openingMilli, '1500');
  assert.deepEqual(json.nested, [{ debitMilli: '-7' }]);
  assert.equal(json.plain, 'ok');
  assert.deepEqual(
    statementExtras({ rows: [], totals: {}, lineCount: 3, balanced: true, columns: [1] }),
    { balanced: true, columns: [1] },
  );
});

// ═══ حراس ثابتة على المسار ═══

test('النقطتان مسجَّلتان في index.ts بعد سلسلة الحراسة', () => {
  const idx = routeCode('index.ts');
  assert.match(idx, /import reportsRouter from '\.\/reports'/);
  assert.match(idx, /router\.use\(reportsRouter\)/);
  const chain = idx.indexOf('router.use(authenticate, requireAdmin, requireAccountingSuite, ledgerContext)');
  assert.ok(chain >= 0, 'سلسلة الحراسة مفقودة من index.ts');
  assert.ok(idx.indexOf('router.use(reportsRouter)') > chain, 'الموجّه يجب أن يُركَّب بعد السلسلة');
});

test('الصلاحية canViewLedger على النقطتين، ومحدد التصدير على التصدير وحده', () => {
  const code = routeCode('reports.ts');
  assert.match(code, /const VIEW = requireLedgerPermission\('canViewLedger'\)/);
  assert.match(code, /router\.get\('\/reports\/:key', VIEW, ledgerHandler\(/);
  assert.match(code, /router\.post\('\/reports\/:key\/export', VIEW, ledgerExportLimiter, ledgerHandler\(/);
  // لا صلاحية أخرى تتسرّب إلى هذا الموجّه
  assert.doesNotMatch(code, /requireLedgerPermission\('(?!canViewLedger)/);
  // ولا محدد التصدير على القراءة
  assert.doesNotMatch(code, /router\.get\([^)]*ledgerExportLimiter/);
});

test('التصدير: السقف قبل صفّ التدقيق، والتدقيق EXPORT بحقول §7.1', () => {
  const code = routeCode('reports.ts');
  const start = code.indexOf("router.post('/reports/:key/export'");
  assert.ok(start >= 0);
  const body = code.slice(start);
  const cap = body.indexOf('assertExportUnderCap(format, built.lineCount)');
  const audit = body.indexOf('appendAudit');
  assert.ok(cap >= 0 && audit >= 0, 'فحص السقف أو صفّ التدقيق مفقود');
  assert.ok(cap < audit, 'لا يُكتب صفّ تدقيق لتصديرٍ مرفوض بالسقف');
  assert.match(body, /action: 'EXPORT'/);
  assert.match(body, /entityType: 'REPORT'/);
  const after = body.slice(body.indexOf('after: {'), body.indexOf('res.json'));
  for (const field of ['reportKey', 'format', 'from', 'to', 'optionsHash', 'lineCount', 'impersonated']) {
    assert.match(after, new RegExp(`\\b${field}\\s*[,:]`), `حقل التدقيق ${field} مفقود`);
  }
  // التصدير يمرّر forExport=true فلا ترقيم
  assert.match(body, /parseReportRequest\(key, body, todayLocal\(new Date\(\), settings\.timezone\), true\)/);
  // والقراءة لا تكتب تدقيقاً
  const get = code.slice(code.indexOf("router.get('/reports/:key'"), start);
  assert.ok(!get.includes('appendAudit'), 'قراءة التقرير لا تكتب في سجل التدقيق');
});

test('فتح التقرير لا يستدعي المزامنة ولا يكتب في القاعدة (§5.1، §7.1)', () => {
  const code = routeCode('reports.ts');
  assert.doesNotMatch(code, /runPoster|runSyncTick|runSync\(|classifyAndEnqueue|postMove\(/);
  assert.doesNotMatch(code, /prisma\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\b/);
  assert.doesNotMatch(code, /tx\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\b/);
  // الكتابة الوحيدة المسموحة هي صفّ التدقيق داخل معاملة
  assert.match(code, /prisma\.\$transaction\(\(tx\) => appendAudit\(tx, \{/);
});

test('منطق دفتر الأستاذ صرف: لا prisma ولا استيراد من routes (§7.1، ADR‑9)', () => {
  const code = serviceCode('generalLedger.ts');
  assert.doesNotMatch(code, /from '@prisma\/client'|config\/database|prisma\./);
  assert.doesNotMatch(code, /from '\.\.\/\.\.\/\.\.\/routes/);
  // السقف المكتوب في الشيفرة هو 500 سطر لكل حساب
  assert.match(code, /GENERAL_LEDGER_PAGE_SIZE = 500/);
});

test('دفتر الأستاذ محصور بسقف المدى وبسقف سطور دفاعي', () => {
  const code = routeCode('reports.ts');
  assert.match(code, /assertScanRange\(period\)/);
  assert.equal(LEDGER_LINES_MAX, 200_000);
  assert.match(code, /LEDGER_RANGE_TOO_LARGE/);
  // عدّ السطور قبل قراءتها في التصدير: لا نتيجة ضخمة ثم رفض
  const body = code.slice(code.indexOf("router.post('/reports/:key/export'"));
  const probe = body.indexOf('countLedgerLines(');
  const build = body.indexOf('await buildReport(');
  assert.ok(probe >= 0 && probe < build, 'سقف التصدير يُفحص بعدّ قبل القراءة الكاملة');
});

// ═══ التحميل الكسول: مؤشّر keyset يطابق ترتيب العرض (§7.1 «الأداء») ═══

/** مقيّم صغير لشرط prisma المولَّد — به نثبت أنّ شرط القاعدة يوافق `compareLedgerLines` حرفياً. */
function cmpValue(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (a === null || b === null) return a === b ? 0 : (a === null ? 1 : -1);
  return (a as never) < (b as never) ? -1 : (a as never) > (b as never) ? 1 : 0;
}

function valueMatches(actual: unknown, cond: unknown): boolean {
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
    const c = cond as Record<string, unknown>;
    if ('gt' in c) return cmpValue(actual, c.gt) > 0;
    if ('lt' in c) return cmpValue(actual, c.lt) < 0;
    if ('not' in c) return actual !== c.not;
    throw new Error(`شرط غير متوقَّع: ${JSON.stringify(c)}`);
  }
  return cmpValue(actual, cond) === 0;
}

function branchMatches(l: LedgerLineInput, branch: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(branch)) {
    if (key === 'date') { if (!valueMatches(toDbDate(l.date), cond)) return false; continue; }
    if (key === 'move') {
      if (!valueMatches(l.moveNumber, (cond as { number: unknown }).number)) return false;
      continue;
    }
    if (key === 'moveId') { if (!valueMatches(l.moveId, cond)) return false; continue; }
    if (key === 'seq') { if (!valueMatches(l.seq, cond)) return false; continue; }
    if (key === 'id') { if (!valueMatches(l.id, cond)) return false; continue; }
    throw new Error(`مفتاح شرط غير متوقَّع: ${key}`);
  }
  return true;
}

const whereMatches = (l: LedgerLineInput, where: { OR?: unknown[] }): boolean =>
  (where.OR ?? []).some((b) => branchMatches(l, b as Record<string, unknown>));

const KEYSET_SAMPLE: LedgerLineInput[] = [
  line({ id: 'k1', date: '2026-03-01', moveNumber: 'INV/0001', moveId: 'm1', seq: 0 }),
  line({ id: 'k2', date: '2026-03-01', moveNumber: 'INV/0001', moveId: 'm1', seq: 1 }),
  line({ id: 'k3', date: '2026-03-01', moveNumber: 'INV/0002', moveId: 'm2', seq: 0 }),
  line({ id: 'k4', date: '2026-03-01', moveNumber: null, moveId: 'm3', seq: 0, moveState: 'DRAFT' }),
  line({ id: 'k5', date: '2026-03-01', moveNumber: null, moveId: 'm4', seq: 0, moveState: 'DRAFT' }),
  line({ id: 'k6', date: '2026-03-02', moveNumber: 'INV/0000', moveId: 'm5', seq: 0 }),
  line({ id: 'k7', date: '2026-02-28', moveNumber: 'REC/9999', moveId: 'm6', seq: 0 }),
];

test('مؤشّر keyset: شرط «بعد» و«قبل» يطابقان compareLedgerLines لكل زوج (والمسودة بلا رقم آخراً)', () => {
  for (const a of KEYSET_SAMPLE) {
    const key = ledgerLineKeyOf(a);
    const after = ledgerLineAfterWhere(key) as { OR?: unknown[] };
    const before = ledgerLineBeforeWhere(key) as { OR?: unknown[] };
    for (const b of KEYSET_SAMPLE) {
      const order = compareLedgerLines(a, b);
      assert.equal(whereMatches(b, after), order < 0, `«بعد ${a.id}» يخالف الترتيب عند ${b.id}`);
      assert.equal(whereMatches(b, before), order > 0, `«قبل ${a.id}» يخالف الترتيب عند ${b.id}`);
    }
    // السطر نفسه ليس قبل نفسه ولا بعده (تقسيمٌ تامّ بلا تكرار ولا فجوة)
    assert.equal(whereMatches(a, after), false);
    assert.equal(whereMatches(a, before), false);
  }
});

test('ترتيب القراءة هو ترتيب العرض: التاريخ ثم الرقم (NULL آخراً) ثم القيد ثم التسلسل ثم المعرّف', () => {
  assert.deepEqual(LEDGER_LINE_ORDER_BY, [
    { date: 'asc' },
    { move: { number: { sort: 'asc', nulls: 'last' } } },
    { moveId: 'asc' },
    { seq: 'asc' },
    { id: 'asc' },
  ]);
});

test('المؤشّر: يُرمَّز ويُفكّ كما هو، ومؤشّر نطاقٍ آخر أو مشوَّه يُرفض 400 لا 500', () => {
  const c = {
    scope: 'aaaa1111bbbb2222', accountId: 'a-cash', date: '2026-03-10',
    moveNumber: 'INV/1', moveId: 'm-1', seq: 2, id: 'l-1',
  };
  const token = encodeLedgerCursor(c);
  assert.deepEqual(decodeLedgerCursor(token, c.scope), c);
  // مسودة بلا رقم تمرّ بلا لبس
  const draft = { ...c, moveNumber: null };
  assert.deepEqual(decodeLedgerCursor(encodeLedgerCursor(draft), c.scope), draft);
  for (const bad of [token, 'ليس-مؤشّراً', '', Buffer.from('[1,2]', 'utf8').toString('base64url')]) {
    assert.throws(() => decodeLedgerCursor(bad, 'scope-اخرى'), (err: unknown) => {
      assert.ok(err instanceof LedgerHttpError);
      assert.equal(err.status, 400);
      assert.equal(err.details.reason, 'INVALID_CURSOR');
      return true;
    });
  }
});

test('بصمة النطاق: تتغيّر بتغيّر الشركة أو المدى أو الفلاتر أو حجم الصفحة', () => {
  const f = { accountIds: ['a1'], journals: ['j1'], includeDrafts: false };
  const base = ledgerCursorScope('t-1', MARCH, f, 500);
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(ledgerCursorScope('t-1', MARCH, f, 500), base);
  assert.notEqual(ledgerCursorScope('t-2', MARCH, f, 500), base);
  assert.notEqual(ledgerCursorScope('t-1', makePeriod('2026-02-01', '2026-02-28'), f, 500), base);
  assert.notEqual(ledgerCursorScope('t-1', MARCH, { ...f, journals: ['j2'] }, 500), base);
  assert.notEqual(ledgerCursorScope('t-1', MARCH, f, 100), base);
});

// ═══ التحميل الكسول لا يغيّر رقماً (§7.1) ═══

function aggregateOf(lines: readonly LedgerLineInput[]): LedgerLineAggregate {
  const a = emptyLedgerAggregate();
  for (const l of lines) {
    if (l.moveType === 'FY_CLOSING') {
      a.closingCount += 1;
      a.closingDebitMilli += l.debitMilli;
      a.closingCreditMilli += l.creditMilli;
    } else {
      a.count += 1;
      a.debitMilli += l.debitMilli;
      a.creditMilli += l.creditMilli;
    }
  }
  return a;
}

/** ما تعيده `loadLedgerAccountAggregates` من القاعدة، محسوباً هنا من السطور نفسها. */
function aggregatesByAccount(lines: readonly LedgerLineInput[]): Map<string, LedgerLineAggregate> {
  const out = new Map<string, LedgerLineAggregate>();
  const byAccount = new Map<string, LedgerLineInput[]>();
  for (const l of lines) {
    const b = byAccount.get(l.accountId);
    if (b) b.push(l); else byAccount.set(l.accountId, [l]);
  }
  for (const [accountId, ls] of byAccount) out.set(accountId, aggregateOf(ls));
  return out;
}

const LAZY_BALANCES: AccountBalance[] = [
  balance('a-cash', { openingMilli: 7_000n }),
  balance('a-ar', { openingMilli: 250_000n }),
  balance('a-rev', { openingMilli: -400_000n, closingOpeningMilli: 100_000n }),
];

const LAZY_LINES: LedgerLineInput[] = [
  ...Array.from({ length: 1_200 }, (_, i) => line({
    id: `z-${String(i).padStart(4, '0')}`,
    accountId: 'a-cash',
    date: '2026-03-15',
    moveNumber: `S/${String(i).padStart(4, '0')}`,
    moveId: `mz-${String(i).padStart(4, '0')}`,
    debitMilli: 1_000n,
    creditMilli: i % 3 === 0 ? 250n : 0n,
  })),
  line({ id: 'y-1', accountId: 'a-ar', date: '2026-03-02', moveNumber: 'INV/1', debitMilli: 90_000n }),
  line({ id: 'y-2', accountId: 'a-ar', date: '2026-03-09', moveNumber: null, moveState: 'DRAFT', creditMilli: 30_000n }),
  line({ id: 'x-1', accountId: 'a-rev', date: '2026-03-05', moveNumber: 'INV/2', creditMilli: 20_000n }),
  line({ id: 'x-2', accountId: 'a-rev', date: '2026-03-31', moveNumber: 'CL/1', moveType: 'FY_CLOSING', debitMilli: 50_000n }),
];

const fullLedger = () => buildGeneralLedger({
  period: MARCH, accounts: ACCOUNTS, balances: LAZY_BALANCES, lines: LAZY_LINES,
  options: { pageSize: null, page: 1 },
});

test('الهيكل من الإجماليات يعطي أرقام القسم نفسها التي يعطيها تحميل كل السطور', () => {
  const full = fullLedger();
  const skeleton = buildLedgerSkeleton({
    period: MARCH, accounts: ACCOUNTS, balances: LAZY_BALANCES, aggregates: aggregatesByAccount(LAZY_LINES),
  });
  assert.equal(skeleton.sections.length, full.sections.length);
  const money = [
    'openingMilli', 'closingOpeningMilli', 'openingBalanceMilli', 'debitMilli', 'creditMilli',
    'closingDebitMilli', 'closingCreditMilli', 'closingMilli', 'endingMilli', 'endingBalanceMilli',
  ] as const;
  for (let i = 0; i < full.sections.length; i += 1) {
    const a = full.sections[i];
    const b = skeleton.sections[i];
    assert.equal(b.account.id, a.account.id);
    assert.equal(b.closingExcluded, a.closingExcluded);
    for (const k of money) assert.equal(b[k], a[k], `${a.account.id}.${k}`);
  }
  const totalKeys = [
    'openingMilli', 'debitMilli', 'creditMilli', 'closingMilli', 'endingMilli',
    'openingBalanceMilli', 'endingBalanceMilli',
  ] as const;
  for (const k of totalKeys) assert.equal(skeleton.totals[k], full.totals[k], `totals.${k}`);
  assert.equal(skeleton.totals.accountCount, full.totals.accountCount);
});

/** يحاكي ما يفعله المسار: صفحةٌ واحدة لكل حساب بمؤشّر، ثم الدمج. بلا قاعدة. */
function lazyPage(page: number, pageSize: number, only?: string): LedgerPageResult {
  const aggregates = aggregatesByAccount(LAZY_LINES);
  const skeleton = buildLedgerSkeleton({
    period: MARCH, accounts: ACCOUNTS, balances: LAZY_BALANCES, aggregates,
  });
  const targets = only ? skeleton.sections.filter((s) => s.account.id === only) : skeleton.sections;
  const positions = new Map<string, LedgerPagePosition>();
  const pageLines: LedgerLineInput[] = [];
  for (const s of targets) {
    const sorted = sortLedgerLines(LAZY_LINES.filter((l) => l.accountId === s.account.id));
    const offset = (page - 1) * pageSize;
    const rows = sorted.slice(offset, offset + pageSize);
    const before = aggregateOf(sorted.slice(0, offset));
    positions.set(s.account.id, {
      offset: aggregateLineCount(before),
      carriedForwardMilli: offset === 0
        ? s.openingMilli
        : carriedForwardAfter(MARCH, s.account, LAZY_BALANCES, before),
      lines: rows,
    });
    pageLines.push(...rows);
  }
  const paged = buildGeneralLedger({
    period: MARCH,
    accounts: targets.map((s) => s.account),
    balances: targets.map((s) => ({
      ...zeroBalance(s.account.id),
      openingMilli: positions.get(s.account.id)?.carriedForwardMilli ?? 0n,
    })),
    lines: pageLines,
    options: { pageSize: null, page: 1 },
  });
  return mergeLedgerPages({
    skeleton,
    sectionIds: targets.map((s) => s.account.id),
    paged,
    positions,
    aggregates,
    pageSize,
    scope: 'scope-test',
  });
}

test('الصفحة الأولى الكسولة = أول 500 سطر من البناء الكامل، بالأرقام نفسها', () => {
  const full = fullLedger();
  const lazy = lazyPage(1, 500);
  assert.equal(lazy.paginated, true);
  assert.equal(lazy.pageSize, 500);
  assert.equal(lazy.totals.lineCount, full.totals.lineCount);
  assert.equal(lazy.totals.endingMilli, full.totals.endingMilli);
  for (const section of lazy.sections) {
    const ref = full.sections.find((s) => s.account.id === section.account.id);
    assert.ok(ref);
    assert.equal(section.lineCount, ref.lineCount, `${section.account.id}.lineCount`);
    assert.equal(section.endingMilli, ref.endingMilli);
    assert.equal(section.offset, 0);
    assert.equal(section.page, 1);
    assert.equal(section.carriedForwardMilli, ref.openingMilli);
    const expected = ref.lines.slice(0, 500);
    assert.equal(section.lines.length, expected.length);
    assert.deepEqual(section.lines.map((l) => l.id), expected.map((l) => l.id));
    assert.deepEqual(section.lines.map((l) => l.runningMilli), expected.map((l) => l.runningMilli));
    assert.deepEqual(section.lines.map((l) => l.excluded), expected.map((l) => l.excluded));
    assert.equal(section.hasMore, ref.lineCount > 500);
    assert.equal(section.nextCursor === null, !section.hasMore);
  }
});

test('الصفحة الثالثة بالمؤشّر: «رصيد مُرحَّل» ورصيدٌ جارٍ مطابقان للبناء الكامل', () => {
  const full = fullLedger();
  const lazy = lazyPage(3, 500, 'a-cash');
  assert.equal(lazy.sections.length, 1, 'المؤشّر يعيد حساباً واحداً');
  const section = lazy.sections[0];
  const ref = full.sections.find((s) => s.account.id === 'a-cash');
  assert.ok(ref);
  assert.equal(section.offset, 1_000);
  assert.equal(section.page, 3);
  assert.equal(section.pageCount, 3);
  assert.equal(section.lineCount, 1_200);
  assert.equal(section.hasMore, false);
  assert.equal(section.nextCursor, null);
  assert.equal(section.carriedForwardMilli, ref.lines[999].runningMilli);
  const expected = ref.lines.slice(1_000);
  assert.deepEqual(section.lines.map((l) => l.id), expected.map((l) => l.id));
  assert.deepEqual(section.lines.map((l) => l.runningMilli), expected.map((l) => l.runningMilli));
  assert.equal(section.carriedOutMilli, ref.lines[ref.lines.length - 1].runningMilli);
  // أرقام التقرير لا تتغيّر بتحميل صفحة: الإجمالي على كل الحسابات كما هو
  assert.equal(lazy.totals.lineCount, full.totals.lineCount);
  assert.equal(lazy.totals.endingMilli, full.totals.endingMilli);
  assert.equal(lazy.totals.accountCount, full.totals.accountCount);
  assert.equal(lazy.totals.displayedLineCount, 200);
});

test('بند الإقفال على حساب قائمة دخل: مفصولٌ في الصفحة كما في البناء الكامل', () => {
  const full = fullLedger();
  const lazy = lazyPage(1, 500, 'a-rev');
  const section = lazy.sections[0];
  const ref = full.sections.find((s) => s.account.id === 'a-rev');
  assert.ok(ref);
  assert.equal(section.closingExcluded, true);
  assert.equal(section.closingMilli, ref.closingMilli);
  assert.equal(section.endingMilli, ref.endingMilli);
  assert.equal(section.endingBalanceMilli, ref.endingBalanceMilli);
  assert.deepEqual(
    section.lines.map((l) => [l.id, l.excluded, l.runningMilli]),
    ref.lines.map((l) => [l.id, l.excluded, l.runningMilli]),
  );
});

test('السطور الصناعية للتجميع لا تُعاد في الردّ ولا تحمل رقم قيد', () => {
  const agg = aggregateOf(LAZY_LINES.filter((l) => l.accountId === 'a-rev'));
  const synthetic = aggregateLedgerLines('a-rev', MARCH.from, agg);
  assert.equal(synthetic.length, 2);
  assert.deepEqual(synthetic.map((l) => l.moveType), ['ENTRY', 'FY_CLOSING']);
  for (const l of synthetic) {
    assert.equal(l.moveNumber, null);
    assert.equal(l.date, MARCH.from);
    assert.match(l.id, /^aggregate:a-rev:/);
  }
  assert.deepEqual(aggregateLedgerLines('a-x', MARCH.from, emptyLedgerAggregate()), []);
  // ولا يظهر منها شيء في الصفحة المُعادة
  const lazy = lazyPage(1, 500);
  for (const s of lazy.sections) for (const l of s.lines) assert.doesNotMatch(l.id, /^aggregate:/);
});

// ═══ مفتاح التقرير واحد في الردّ (قرار M4) ═══

const LAZY_SETTINGS = {
  configured: true,
  fy: { endMonth: 12, endDay: 31 },
  currency: 'SAR',
  currencyDecimals: 2,
  timezone: 'Asia/Riyadh',
  drawingsAfterNetProfit: false,
  depreciationInOperatingExpenses: false,
};

test('income-statement مفتاح واحد: profit-and-loss مرادف مدخل فقط ولا يظهر في الردّ', () => {
  assert.equal(canonicalReportKey('profit-and-loss'), 'income-statement');
  assert.equal(canonicalReportKey('income-statement'), 'income-statement');
  assert.equal(canonicalReportKey('general-ledger'), 'general-ledger');
  assert.equal(canonicalReportKey('nope'), null);
  assert.equal(isReportKey('profit-and-loss'), false, 'المرادف ليس مفتاحاً قانونياً');

  const parsed = parseReportRequest('income-statement', { comparison: 'previousPeriod' }, '2026-03-17');
  const out = STATEMENT_BUILDERS['income-statement']({
    reportKey: 'income-statement',
    period: MARCH,
    accounts: ACCOUNTS,
    balances: [balance('a-rev', { creditMilli: 300_000n })],
    settings: LAZY_SETTINGS,
    options: parsed.options,
    roles: { drawings: [], retainedEarnings: null },
    showZero: false,
    draftMoveCount: 0,
    comparisons: [{ period: makePeriod('2026-02-01', '2026-02-28'), balances: [] }],
  });
  assert.equal('statementKey' in out, false, 'لا مفتاح تقرير ثانٍ في مخرَج الجسر');
  const columns = out.comparisonColumns as Record<string, unknown>[];
  assert.ok(Array.isArray(columns) && columns.length === 1);
  for (const col of columns) {
    assert.equal('reportKey' in col, false, 'عمود المقارنة لا يحمل اسم التقرير الداخلي');
  }
  assert.equal(JSON.stringify(reportJson(out)).includes('profit-and-loss'), false);
});

test('كل مبلغ في الردّ نصّ عدد صحيح بالملّي تحت مفتاح ينتهي بـMilli (بلا تنسيق ولا تقريب)', () => {
  const options = parseReportRequest('trial-balance', { unit: '1000' }, '2026-03-17').options;
  const out = STATEMENT_BUILDERS['trial-balance']({
    reportKey: 'trial-balance',
    period: MARCH,
    accounts: ACCOUNTS,
    balances: [balance('a-cash', { debitMilli: 63_000_000n }), balance('a-rev', { creditMilli: 63_000_000n })],
    settings: LAZY_SETTINGS,
    options,
    roles: { drawings: [], retainedEarnings: null },
    showZero: false,
    draftMoveCount: 0,
    comparisons: [],
  });
  const json = reportJson(out);
  const amounts: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k.endsWith('Milli') && x !== null) {
          assert.equal(typeof x, 'string', `${k} يجب أن يكون نصاً`);
          amounts.push(x as string);
        }
        walk(x);
      }
    }
  };
  walk(json);
  assert.ok(amounts.length > 0, 'لم يُعثر على مبلغ واحد في الردّ');
  for (const a of amounts) assert.match(a, /^-?\d+$/, `مبلغ منسَّق أو عشري في الردّ: ${a}`);
  // وحدة العرض تُعاد بياناً وصفياً ولا تُطبَّق على المبلغ
  assert.equal((json as { unit?: number }).unit, 1000);
  assert.ok(amounts.includes('63000000'), 'المبلغ الخام بالملّي يجب أن يبقى كما هو');
});

// ═══ نصوص الأخطاء العربية (§7.1) ═══

test('كل رمز تقارير له نصّ عربي: لا يسقط الردّ على الرمز الإنجليزي', () => {
  for (const code of ['LEDGER_RANGE_TOO_LARGE', 'LEDGER_EXPORT_TOO_LARGE', 'LEDGER_EXPORT_IN_PROGRESS'] as const) {
    const msg = LEDGER_ERROR_MESSAGES[code];
    assert.ok(typeof msg === 'string' && msg.length > 0, `${code} بلا رسالة عربية`);
    assert.match(msg, /[؀-ۿ]/, `${code} رسالته ليست عربية`);
    assert.notEqual(msg, code);
  }
  // النصّ الموثّق لسقف التصدير (§7.1)
  assert.match(LEDGER_ERROR_MESSAGES.LEDGER_EXPORT_TOO_LARGE ?? '', /ضيّق الفترة أو الحسابات، أو صدّر XLSX/);
  // ونصّ المدى يقترح تضييق الفترة
  assert.match(LEDGER_ERROR_MESSAGES.LEDGER_RANGE_TOO_LARGE ?? '', /ضيّق الفترة/);
});

test('ردّ الخطأ يحمل النصّ العربي لا الرمز (سقف التصدير وسقف المدى)', () => {
  const cases: [LedgerError, string][] = [
    [new LedgerError('LEDGER_EXPORT_TOO_LARGE', { lines: 60_000, cap: 50_000 }), EXPORT_TOO_LARGE_MESSAGE],
    [new LedgerError('LEDGER_RANGE_TOO_LARGE', { months: 18, cap: 12 }), RANGE_TOO_LARGE_MESSAGE],
  ];
  for (const [err, expected] of cases) {
    const r = ledgerErrorResponse(err);
    assert.ok(r);
    assert.equal(r.status, 422);
    assert.equal(r.body.message, expected);
    assert.notEqual(r.body.message, r.body.code);
  }
});
