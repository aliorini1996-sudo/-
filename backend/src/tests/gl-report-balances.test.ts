// M4 — أساس التقارير (DESIGN.md §7.1، §7.2، §2.5): الفترات والسنة المالية، وتجميع الأرصدة الصرف.
// كل ما هنا بلا قاعدة بيانات: composeBalances تستقبل مصفوفات، وload.ts وحده يلمس prisma.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_FISCAL_YEAR, comparisonPeriods, exceedsScanRange, fiscalQuarterOf, fiscalYearConfigOf, isFiscalYearPeriod,
  isMonthEnd, isMonthStart, isWholeMonthPeriod, makePeriod, monthKeyEnd, monthKeyStart, monthKeysBetween, monthSpan,
  previousPeriods, resolveReportPeriod, sameLastYearPeriods, splitMonthKeys, splitMonthRanges,
} from '../services/gl/reports/period';
import {
  balanceIndex, closingImbalance, composeBalances, displayMilli, displaySign, endingMilli, endingWithClosingMilli,
  hasMovement, isBalanceSheetType, isProfitLossType, isZeroRow, matchesAccountSearch, movementImbalance,
  openingImbalance, periodNetMilli, roundToCurrency, sumBalances, toUnitMilli, windowOf, zeroBalance,
} from '../services/gl/reports/balances';
import {
  MAX_COMPARISON_COUNT, SCAN_RANGE_MAX_MONTHS, normalizeReportOptions, requiresLineScan,
  type BalanceLineRow, type PeriodBalanceRow, type ReportAccount,
} from '../services/gl/reports/types';
import { assertScanRange, balanceReadMode, reportLoadOptions } from '../services/gl/reports/load';
import { isLedgerError } from '../services/gl/types';

// ═══ أدوات المتجهات ═══

const FY_DEC = DEFAULT_FISCAL_YEAR;
const FY_JUN = { endMonth: 6, endDay: 30 };
/** سنة مالية تنتهي منتصف الشهر: بدايتها منتصف شهر أيضاً (حافة جزئية في الافتتاح) */
const FY_JUN15 = { endMonth: 6, endDay: 15 };

const ACC: ReportAccount[] = [
  { id: 'a-cash', code: '111001', name: 'الصندوق', nameI18n: { ar: 'الصندوق', en: 'Cash' }, type: 'asset_cash' },
  { id: 'a-ar', code: '113001', name: 'ذمم العملاء', nameI18n: null, type: 'asset_receivable' },
  { id: 'a-eq', code: '311001', name: 'رأس المال', nameI18n: null, type: 'equity' },
  { id: 'a-re', code: '313001', name: 'الأرباح المبقاة', nameI18n: null, type: 'equity' },
  { id: 'a-un', code: '319001', name: 'أرباح سنوات سابقة', nameI18n: null, type: 'equity_unaffected' },
  { id: 'a-rev', code: '411001', name: 'المبيعات', nameI18n: null, type: 'income' },
  { id: 'a-exp', code: '511001', name: 'مصروفات عمومية', nameI18n: null, type: 'expense' },
];

const pb = (accountId: string, periodKey: string, d: number, c: number): PeriodBalanceRow =>
  ({ accountId, periodKey, debitMilli: BigInt(d), creditMilli: BigInt(c) });

const ln = (
  accountId: string, date: string, d: number, c: number,
  flags: { closing?: boolean; draft?: boolean } = {},
): BalanceLineRow =>
  ({ accountId, date, debitMilli: BigInt(d), creditMilli: BigInt(c), closing: flags.closing === true, draft: flags.draft === true });

const byId = (rows: ReturnType<typeof composeBalances>) => balanceIndex(rows);

// ═══ 1) الفترات والسنة المالية (§2.5، RPT‑02) ═══

test('fiscalYearConfigOf: الافتراض 12/31 ويتجاهل القيم الفاسدة', () => {
  assert.deepEqual(fiscalYearConfigOf(null), { endMonth: 12, endDay: 31 });
  assert.deepEqual(fiscalYearConfigOf({ fiscalYearEndMonth: 6, fiscalYearEndDay: 30 }), { endMonth: 6, endDay: 30 });
  assert.deepEqual(fiscalYearConfigOf({ fiscalYearEndMonth: 0, fiscalYearEndDay: 99 }), { endMonth: 12, endDay: 31 });
  assert.deepEqual(fiscalYearConfigOf({ fiscalYearEndMonth: null, fiscalYearEndDay: null }), { endMonth: 12, endDay: 31 });
});

test('resolveReportPeriod: شهر وربع وسنة مالية ومخصص واعتباراً من — سنة تنتهي ديسمبر', () => {
  assert.deepEqual(
    resolveReportPeriod({ mode: 'month', from: '2026-03-17', to: '2026-03-17' }, FY_DEC),
    { from: '2026-03-01', to: '2026-03-31', fyStart: '2026-01-01' },
  );
  assert.deepEqual(
    resolveReportPeriod({ mode: 'quarter', from: '2026-08-02', to: '2026-08-02' }, FY_DEC),
    { from: '2026-07-01', to: '2026-09-30', fyStart: '2026-01-01' },
  );
  assert.deepEqual(
    resolveReportPeriod({ mode: 'fiscalYear', from: '2026-08-02', to: '2026-08-02' }, FY_DEC),
    { from: '2026-01-01', to: '2026-12-31', fyStart: '2026-01-01' },
  );
  assert.deepEqual(
    resolveReportPeriod({ mode: 'custom', from: '2026-03-10', to: '2026-04-20' }, FY_DEC),
    { from: '2026-03-10', to: '2026-04-20', fyStart: '2026-01-01' },
  );
  // «اعتباراً من» D ⇒ المدى [FYStart(D), D] فتكون حركة الفترة حركة السنة الجارية (§7.4)
  assert.deepEqual(
    resolveReportPeriod({ mode: 'asOf', from: '2026-05-20', to: '2026-05-20' }, FY_DEC),
    { from: '2026-01-01', to: '2026-05-20', fyStart: '2026-01-01' },
  );
  assert.throws(() => resolveReportPeriod({ mode: 'custom', from: '2026-04-20', to: '2026-03-10' }, FY_DEC), RangeError);
});

test('resolveReportPeriod: سنة مالية تنتهي 30 يونيو', () => {
  // يوليو 2026 يفتح سنة 2026‑07‑01 ← 2027‑06‑30
  assert.deepEqual(
    resolveReportPeriod({ mode: 'fiscalYear', from: '2026-11-15', to: '2026-11-15' }, FY_JUN),
    { from: '2026-07-01', to: '2027-06-30', fyStart: '2026-07-01' },
  );
  // الربع **المالي**: الربع الثاني من سنة تبدأ يوليو = أكتوبر ← ديسمبر
  assert.deepEqual(fiscalQuarterOf('2026-11-15', FY_JUN), { from: '2026-10-01', to: '2026-12-31' });
  assert.deepEqual(fiscalQuarterOf('2026-07-01', FY_JUN), { from: '2026-07-01', to: '2026-09-30' });
  assert.deepEqual(fiscalQuarterOf('2027-06-30', FY_JUN), { from: '2027-04-01', to: '2027-06-30' });
  // شهر أكتوبر داخل السنة المالية نفسها، وافتتاحه من 1 يوليو
  assert.deepEqual(
    resolveReportPeriod({ mode: 'month', from: '2026-10-09', to: '2026-10-09' }, FY_JUN),
    { from: '2026-10-01', to: '2026-10-31', fyStart: '2026-07-01' },
  );
  // يونيو 2026 ما زال في السنة المنتهية 2026‑06‑30
  assert.equal(resolveReportPeriod({ mode: 'month', from: '2026-06-09', to: '2026-06-09' }, FY_JUN).fyStart, '2025-07-01');
});

test('السنة الكبيسة: نهاية 29 فبراير تُقصّ في غير الكبيسة', () => {
  const fyFeb = { endMonth: 2, endDay: 29 };
  assert.deepEqual(
    resolveReportPeriod({ mode: 'fiscalYear', from: '2028-02-15', to: '2028-02-15' }, fyFeb),
    { from: '2027-03-01', to: '2028-02-29', fyStart: '2027-03-01' },
  );
  const prev = previousPeriods(resolveReportPeriod({ mode: 'fiscalYear', from: '2028-02-15', to: '2028-02-15' }, fyFeb), 2, fyFeb);
  // 2027 و2026 غير كبيستين ⇒ نهاية السنة المالية تُقصّ إلى 28 فبراير، و2028 وحدها 29
  assert.deepEqual(prev.map((p) => [p.from, p.to]), [['2026-03-01', '2027-02-28'], ['2025-03-01', '2026-02-28']]);
  // شهر فبراير الكبيس ← فبراير السنة الماضية 28 يوماً
  const feb28 = sameLastYearPeriods(resolveReportPeriod({ mode: 'month', from: '2028-02-10', to: '2028-02-10' }, FY_DEC), 1, FY_DEC);
  assert.deepEqual([feb28[0].from, feb28[0].to], ['2027-02-01', '2027-02-28']);
});

test('المقارنة: الفترة السابقة والمدة نفسها من السنة الماضية (RPT‑04)', () => {
  const month = resolveReportPeriod({ mode: 'month', from: '2026-03-05', to: '2026-03-05' }, FY_DEC);
  assert.deepEqual(previousPeriods(month, 3, FY_DEC).map((p) => [p.from, p.to]), [
    ['2026-02-01', '2026-02-28'], ['2026-01-01', '2026-01-31'], ['2025-12-01', '2025-12-31'],
  ]);
  assert.deepEqual(sameLastYearPeriods(month, 1, FY_DEC).map((p) => [p.from, p.to]), [['2025-03-01', '2025-03-31']]);
  // ربع كامل ⇒ إزاحة ثلاثة أشهر
  const q = resolveReportPeriod({ mode: 'quarter', from: '2026-08-02', to: '2026-08-02' }, FY_DEC);
  assert.deepEqual(previousPeriods(q, 1, FY_DEC).map((p) => [p.from, p.to]), [['2026-04-01', '2026-06-30']]);
  // مدى مخصص جزئي ⇒ إزاحة بطول المدى بالأيام
  const custom = makePeriod('2026-03-10', '2026-03-19', FY_DEC);
  assert.deepEqual(previousPeriods(custom, 2, FY_DEC).map((p) => [p.from, p.to]), [
    ['2026-02-28', '2026-03-09'], ['2026-02-18', '2026-02-27'],
  ]);
  // سنة مالية: «السابقة» و«السنة الماضية» تتطابقان
  const fy = resolveReportPeriod({ mode: 'fiscalYear', from: '2026-11-15', to: '2026-11-15' }, FY_JUN);
  assert.ok(isFiscalYearPeriod(fy, FY_JUN));
  assert.deepEqual(previousPeriods(fy, 1, FY_JUN), sameLastYearPeriods(fy, 1, FY_JUN));
  assert.deepEqual(previousPeriods(fy, 1, FY_JUN).map((p) => [p.from, p.to]), [['2025-07-01', '2026-06-30']]);
  // بلا مقارنة ⇒ لا أعمدة؛ والعدد يُقصّ إلى 1..12
  assert.deepEqual(comparisonPeriods(month, null, FY_DEC), []);
  assert.equal(comparisonPeriods(month, { kind: 'previousPeriod', count: 99 }, FY_DEC).length, MAX_COMPARISON_COUNT);
  assert.equal(comparisonPeriods(month, { kind: 'previousPeriod', count: 0 }, FY_DEC).length, 1);
});

test('أدوات الشهور: المدى والمفاتيح والحواف', () => {
  assert.equal(monthSpan('2026-03-10', '2026-03-31'), 1);
  assert.equal(monthSpan('2026-01-01', '2026-12-31'), 12);
  assert.equal(monthSpan('2026-01-01', '2027-01-31'), 13);
  assert.deepEqual(monthKeysBetween('2026-11-20', '2027-01-05'), ['2026-11', '2026-12', '2027-01']);
  assert.deepEqual(monthKeysBetween('2026-03-05', '2026-03-05'), ['2026-03']);
  assert.deepEqual(monthKeysBetween('2026-04-01', '2026-03-31'), []);
  assert.equal(monthKeyStart('2026-02'), '2026-02-01');
  assert.equal(monthKeyEnd('2028-02'), '2028-02-29');
  assert.equal(monthKeyEnd('2027-02'), '2027-02-28');
  assert.throws(() => monthKeyStart('2026-13'), RangeError);
  assert.throws(() => monthKeyStart('2026-CL'), RangeError);
  assert.ok(isMonthStart('2026-03-01') && !isMonthStart('2026-03-02'));
  assert.ok(isMonthEnd('2026-02-28') && isMonthEnd('2028-02-29') && !isMonthEnd('2026-03-30'));
});

test('splitMonthKeys: الحواف الجزئية على الطرفين وعلى بداية السنة المالية', () => {
  // شهر كامل بسنة تقويمية ⇒ لا شهر مقسوم
  assert.deepEqual(splitMonthKeys(makePeriod('2026-03-01', '2026-03-31', FY_DEC)), []);
  // جزئي على الطرفين
  assert.deepEqual(splitMonthKeys(makePeriod('2026-03-10', '2026-04-20', FY_DEC)), ['2026-03', '2026-04']);
  // جزئي على طرف واحد
  assert.deepEqual(splitMonthKeys(makePeriod('2026-03-10', '2026-03-31', FY_DEC)), ['2026-03']);
  assert.deepEqual(splitMonthKeys(makePeriod('2026-03-01', '2026-03-20', FY_DEC)), ['2026-03']);
  // بداية سنة مالية منتصف الشهر ⇒ شهرها مقسوم أيضاً
  const p = makePeriod('2026-08-01', '2026-08-31', FY_JUN15);
  assert.equal(p.fyStart, '2026-06-16');
  assert.deepEqual(splitMonthKeys(p), ['2026-06']);
  assert.deepEqual(splitMonthRanges(p), [{ from: '2026-06-01', to: '2026-06-30' }]);
  assert.ok(isWholeMonthPeriod(p));
});

// ═══ 2) تجميع الأرصدة (§7.1، §7.2) ═══

test('composeBalances: قاعدة الافتتاحي للنوعين والتوازن الصفري', () => {
  const period = makePeriod('2026-03-01', '2026-03-31', FY_DEC);
  const periods: PeriodBalanceRow[] = [
    pb('a-cash', '2025-06', 100_000, 0), pb('a-eq', '2025-06', 0, 100_000),      // رأس مال، سنة سابقة
    pb('a-cash', '2025-09', 30_000, 0), pb('a-rev', '2025-09', 0, 30_000),       // ربح سنة سابقة
    pb('a-exp', '2026-01', 5_000, 0), pb('a-cash', '2026-01', 0, 5_000),         // افتتاح السنة الجارية
    pb('a-ar', '2026-02', 8_000, 0), pb('a-rev', '2026-02', 0, 8_000),
    pb('a-ar', '2026-03', 12_000, 0), pb('a-rev', '2026-03', 0, 12_000),         // الفترة
    pb('a-exp', '2026-03', 2_000, 0), pb('a-cash', '2026-03', 0, 2_000),
  ];
  const rows = composeBalances({ period, accounts: ACC, periods });
  const m = byId(rows);

  // حسابات الميزانية: الافتتاحي كل ما قبل from
  assert.equal(m.get('a-cash')!.openingMilli, 125_000n);
  assert.equal(m.get('a-cash')!.preFyMilli, 130_000n);
  assert.equal(m.get('a-ar')!.openingMilli, 8_000n);
  assert.equal(m.get('a-eq')!.openingMilli, -100_000n);
  // حسابات قائمة الدخل: من بداية السنة المالية فقط، وما قبلها في preFyMilli
  assert.equal(m.get('a-rev')!.openingMilli, -8_000n);
  assert.equal(m.get('a-rev')!.preFyMilli, -30_000n);
  assert.equal(m.get('a-exp')!.openingMilli, 5_000n);
  assert.equal(m.get('a-exp')!.preFyMilli, 0n);
  // حركة الفترة إجمالاً لا صافياً
  assert.equal(m.get('a-rev')!.creditMilli, 12_000n);
  assert.equal(m.get('a-rev')!.debitMilli, 0n);
  assert.equal(m.get('a-exp')!.debitMilli, 2_000n);
  // النهائي = الافتتاحي + المدين − الدائن (§7.2)
  assert.equal(endingMilli(m.get('a-cash')!), 123_000n);
  assert.equal(endingMilli(m.get('a-rev')!), -20_000n);
  assert.equal(periodNetMilli(m.get('a-rev')!), -12_000n);

  // صف الإجمالي (§7.2): Σ الافتتاحي = 0، وΣ المدين = Σ الدائن، وΣ النهائي = 0 بضمّ ما قبل السنة
  assert.equal(openingImbalance(rows, ACC), 0n);
  assert.equal(movementImbalance(rows), 0n);
  assert.equal(closingImbalance(rows), 0n);
  const t = sumBalances(rows);
  assert.equal(t.debitMilli, 14_000n);
  assert.equal(t.creditMilli, 14_000n);
  assert.equal(t.endingMilli + t.preFyMilli - rows.reduce((s, r) => s + (isProfitLossType(ACC.find((a) => a.id === r.accountId)!.type) ? 0n : r.preFyMilli), 0n), 0n);

  // كل حساب له صف ولو بلا حركة، مرتّباً بالرمز
  assert.deepEqual(rows.map((r) => r.accountId), ACC.map((a) => a.id));
  assert.ok(isZeroRow(m.get('a-un')!));
  assert.ok(!hasMovement(m.get('a-un')!));
  assert.ok(hasMovement(m.get('a-rev')!));
});

test('composeBalances: الحواف الجزئية على الطرفين تُقرأ بنوداً والشهور الكاملة أرصدةً', () => {
  const period = makePeriod('2026-03-10', '2026-04-20', FY_DEC);
  const splitMonths = splitMonthKeys(period); // ['2026-03','2026-04']
  const periods: PeriodBalanceRow[] = [
    pb('a-cash', '2025-12', 50_000, 0), pb('a-eq', '2025-12', 0, 50_000),
    pb('a-exp', '2026-01', 1_000, 0), pb('a-cash', '2026-01', 0, 1_000),
    pb('a-exp', '2026-02', 2_000, 0), pb('a-cash', '2026-02', 0, 2_000),
  ];
  const lines: BalanceLineRow[] = [
    // مارس قبل from ⇒ افتتاح السنة الجارية
    ln('a-exp', '2026-03-05', 700, 0), ln('a-cash', '2026-03-05', 0, 700),
    // داخل الفترة
    ln('a-ar', '2026-03-10', 9_000, 0), ln('a-rev', '2026-03-10', 0, 9_000),
    ln('a-ar', '2026-04-20', 4_000, 0), ln('a-rev', '2026-04-20', 0, 4_000),
    // بعد to ⇒ مهملة
    ln('a-ar', '2026-04-21', 1_000_000, 0), ln('a-rev', '2026-04-21', 0, 1_000_000),
  ];
  const rows = composeBalances({ period, accounts: ACC, periods, lines, splitMonths });
  const m = byId(rows);
  assert.equal(m.get('a-exp')!.openingMilli, 3_700n);            // 1000 + 2000 + 700
  assert.equal(m.get('a-cash')!.openingMilli, 46_300n);          // 50000 − 1000 − 2000 − 700
  assert.equal(m.get('a-rev')!.creditMilli, 13_000n);            // 9000 + 4000 فقط
  assert.equal(m.get('a-ar')!.debitMilli, 13_000n);
  assert.equal(m.get('a-rev')!.openingMilli, 0n);
  assert.equal(openingImbalance(rows, ACC), 0n);
  assert.equal(movementImbalance(rows), 0n);
});

test('composeBalances: المسودات تُضاف فوق الأرصدة وتُستثنى مع «المرحّلة فقط» (RPT‑05)', () => {
  const period = makePeriod('2026-03-01', '2026-03-31', FY_DEC);
  const periods: PeriodBalanceRow[] = [pb('a-ar', '2026-03', 5_000, 0), pb('a-rev', '2026-03', 0, 5_000)];
  const lines: BalanceLineRow[] = [
    // مسودة داخل الفترة
    ln('a-ar', '2026-03-20', 1_500, 0, { draft: true }), ln('a-rev', '2026-03-20', 0, 1_500, { draft: true }),
    // مسودة قبل الفترة: تدخل الافتتاحي ولا تُطلق حارس الازدواج ولو كان شهرها غير مقسوم
    ln('a-ar', '2026-02-11', 800, 0, { draft: true }), ln('a-rev', '2026-02-11', 0, 800, { draft: true }),
  ];
  const posted = composeBalances({ period, accounts: ACC, periods, lines, includeDrafts: false });
  assert.equal(byId(posted).get('a-ar')!.debitMilli, 5_000n);
  assert.equal(byId(posted).get('a-ar')!.openingMilli, 0n);

  const withDrafts = composeBalances({ period, accounts: ACC, periods, lines, includeDrafts: true });
  const m = byId(withDrafts);
  assert.equal(m.get('a-ar')!.debitMilli, 6_500n);
  assert.equal(m.get('a-ar')!.openingMilli, 800n);
  assert.equal(m.get('a-rev')!.openingMilli, -800n);  // مسودة إيراد داخل السنة المالية نفسها
  assert.equal(openingImbalance(withDrafts, ACC), 0n);
  assert.equal(movementImbalance(withDrafts), 0n);
});

test('composeBalances: بنود قيد إقفال السنة منفصلة قبل الفترة وداخلها (§2.5)', () => {
  // الفترة تضمّ 2026‑12‑31 (تاريخ إقفال سنة 2026)، وإقفال 2025 واقع قبلها
  const period = makePeriod('2026-12-01', '2026-12-31', FY_DEC);
  const periods: PeriodBalanceRow[] = [
    pb('a-rev', '2026-11', 0, 40_000), pb('a-ar', '2026-11', 40_000, 0),
    pb('a-exp', '2026-12', 6_000, 0), pb('a-cash', '2026-12', 0, 6_000),
  ];
  const lines: BalanceLineRow[] = [
    // إقفال 2025: نقل ربح 2025 إلى 313001 — قبل from
    ln('a-rev', '2025-12-31', 12_000, 0, { closing: true }), ln('a-re', '2025-12-31', 0, 12_000, { closing: true }),
    // إقفال 2026: داخل الفترة
    ln('a-rev', '2026-12-31', 40_000, 0, { closing: true }), ln('a-exp', '2026-12-31', 0, 6_000, { closing: true }),
    ln('a-re', '2026-12-31', 0, 34_000, { closing: true }),
  ];
  const rows = composeBalances({ period, accounts: ACC, periods, lines });
  const m = byId(rows);
  // لا بنود الإقفال في الافتتاحي ولا في حركة الفترة
  assert.equal(m.get('a-rev')!.openingMilli, -40_000n);
  assert.equal(m.get('a-rev')!.preFyMilli, 0n);
  assert.equal(m.get('a-rev')!.debitMilli, 0n);
  assert.equal(m.get('a-rev')!.creditMilli, 0n);
  // بل منفصلة: ما قبل from في closingOpeningMilli وما داخلها في closingMilli
  assert.equal(m.get('a-rev')!.closingOpeningMilli, 12_000n);
  assert.equal(m.get('a-rev')!.closingMilli, 40_000n);
  assert.equal(m.get('a-re')!.closingOpeningMilli, -12_000n);
  assert.equal(m.get('a-re')!.closingMilli, -34_000n);
  assert.equal(m.get('a-exp')!.closingMilli, -6_000n);
  assert.equal(m.get('a-exp')!.debitMilli, 6_000n);
  // 313001 لا رصيد له إلا من الإقفال، ويُضمّ في صف حسابه لحسابات الميزانية (§7.2)
  assert.equal(endingMilli(m.get('a-re')!), 0n);
  assert.equal(endingWithClosingMilli(m.get('a-re')!), -46_000n);
  // التوازن قائم في الثلاثة
  assert.equal(openingImbalance(rows, ACC), 0n);
  assert.equal(movementImbalance(rows), 0n);
  assert.equal(closingImbalance(rows), 0n);
});

test('composeBalances: سنة مالية منتصف الشهر — الافتتاحي يفصل داخل الشهر نفسه', () => {
  // السنة المالية تنتهي 15 يونيو ⇒ بدايتها 16 يونيو، وشهر يونيو مقسوم
  const period = makePeriod('2026-08-01', '2026-08-31', FY_JUN15);
  assert.equal(period.fyStart, '2026-06-16');
  const splitMonths = splitMonthKeys(period);
  const periods: PeriodBalanceRow[] = [
    pb('a-rev', '2026-05', 0, 20_000), pb('a-ar', '2026-05', 20_000, 0),   // سنة سابقة
    pb('a-rev', '2026-07', 0, 9_000), pb('a-ar', '2026-07', 9_000, 0),     // السنة الجارية قبل الفترة
    pb('a-rev', '2026-08', 0, 3_000), pb('a-ar', '2026-08', 3_000, 0),     // الفترة
  ];
  const lines: BalanceLineRow[] = [
    ln('a-rev', '2026-06-10', 0, 1_000), ln('a-ar', '2026-06-10', 1_000, 0), // قبل fyStart
    ln('a-rev', '2026-06-20', 0, 2_000), ln('a-ar', '2026-06-20', 2_000, 0), // بعد fyStart وقبل from
  ];
  const rows = composeBalances({ period, accounts: ACC, periods, lines, splitMonths });
  const m = byId(rows);
  assert.equal(m.get('a-rev')!.preFyMilli, -21_000n);          // 20,000 (مايو) + 1,000 (10 يونيو)
  assert.equal(m.get('a-rev')!.openingMilli, -11_000n);        // 2,000 (20 يونيو) + 9,000 (يوليو)
  assert.equal(m.get('a-rev')!.creditMilli, 3_000n);
  assert.equal(m.get('a-ar')!.openingMilli, 32_000n);          // 20,000 + 1,000 + 2,000 + 9,000
  assert.equal(openingImbalance(rows, ACC), 0n);
  assert.equal(movementImbalance(rows), 0n);
});

test('windowOf: تصنيف التواريخ إلى نوافذ الافتتاح والفترة', () => {
  const period = makePeriod('2026-03-10', '2026-04-20', FY_DEC);
  assert.equal(windowOf('2025-12-31', period), 'PRE_FY');
  assert.equal(windowOf('2026-01-01', period), 'FY_OPENING');
  assert.equal(windowOf('2026-03-09', period), 'FY_OPENING');
  assert.equal(windowOf('2026-03-10', period), 'PERIOD');
  assert.equal(windowOf('2026-04-20', period), 'PERIOD');
  assert.equal(windowOf('2026-04-21', period), 'AFTER');
});

test('composeBalances: حراس الازدواج والمفاتيح والحسابات المجهولة', () => {
  const period = makePeriod('2026-03-10', '2026-04-20', FY_DEC);
  const split = splitMonthKeys(period);
  // مفتاح YYYY-CL لا يمرّ في الأرصدة المجمّعة (بنود الإقفال تُقرأ بنوداً)
  assert.throws(
    () => composeBalances({ period, accounts: ACC, periods: [pb('a-rev', '2026-CL', 1, 0)] }),
    /مفتاح فترة غير شهري/,
  );
  // شهر مقسوم لا يُجمع رصيده المخزَّن مع بنوده
  assert.throws(
    () => composeBalances({ period, accounts: ACC, periods: [pb('a-rev', '2026-03', 1, 0)], splitMonths: split }),
    /مقسوم/,
  );
  // شهر يقع على حدّ فترة ولم يُدرج في splitMonths
  assert.throws(
    () => composeBalances({ period, accounts: ACC, periods: [pb('a-rev', '2026-03', 1, 0)] }),
    /حدّ فترة/,
  );
  // بند مرحّل خارج الشهور المقسومة مع وجود أرصدة مجمّعة = ازدواج
  assert.throws(
    () => composeBalances({
      period, accounts: ACC, splitMonths: split,
      periods: [pb('a-rev', '2026-01', 0, 5)],
      lines: [ln('a-rev', '2026-02-10', 0, 5)],
    }),
    /ازدواج/,
  );
  // بند على حساب غير معروف
  assert.throws(
    () => composeBalances({ period, accounts: ACC, lines: [ln('a-ghost', '2026-03-15', 5, 0)] }),
    /حساب غير معروف/,
  );
  // وضع مسح البنود: لا أرصدة مجمّعة ⇒ لا حارس ازدواج، وكل البنود تُقبل
  const scan = composeBalances({
    period, accounts: ACC,
    lines: [ln('a-rev', '2026-02-10', 0, 5), ln('a-ar', '2026-02-10', 5, 0)],
  });
  assert.equal(byId(scan).get('a-rev')!.openingMilli, -5n);
});

test('مشتقّات العرض: الإشارة والوحدة والبحث والصفر', () => {
  assert.equal(displaySign('asset_cash'), 1);
  assert.equal(displaySign('expense_depreciation'), 1);
  assert.equal(displaySign('income'), -1);
  assert.equal(displaySign('income_other'), -1);
  assert.equal(displaySign('liability_payable'), -1);
  assert.equal(displaySign('equity_unaffected'), -1);
  assert.equal(displaySign('off_balance'), 1);
  assert.equal(displayMilli('income', -12_000n), 12_000n);
  assert.equal(displayMilli('asset_cash', 12_000n), 12_000n);
  assert.ok(isProfitLossType('income_other') && isProfitLossType('expense_zakat'));
  assert.ok(isBalanceSheetType('asset_fixed') && isBalanceSheetType('off_balance'));

  // RPT‑06: الوحدة بتقريب نصف-لأعلى بعيداً عن الصفر، بلا float
  assert.equal(toUnitMilli(1_234_567n, 1), 1_234_567n);
  assert.equal(toUnitMilli(1_234_567n, 1000), 1_235n);
  assert.equal(toUnitMilli(-1_234_567n, 1000), -1_235n);
  assert.equal(toUnitMilli(1_500n, 1000), 2n);
  assert.equal(toUnitMilli(-1_500n, 1000), -2n);
  assert.equal(toUnitMilli(1_499n, 1000), 1n);
  assert.equal(toUnitMilli(1_500_000n, 1_000_000), 2n);
  assert.equal(roundToCurrency(1_234n, 2), 1_230n);

  // RPT‑15
  assert.ok(matchesAccountSearch(ACC[1], '113'));
  assert.ok(matchesAccountSearch(ACC[1], 'ذمم'));
  assert.ok(matchesAccountSearch(ACC[0], 'cash'));
  assert.ok(matchesAccountSearch(ACC[0], ''));
  assert.ok(!matchesAccountSearch(ACC[1], '999'));
  assert.ok(!matchesAccountSearch(ACC[1], 'Cash'));

  const z = zeroBalance('a-x');
  assert.ok(isZeroRow(z) && !hasMovement(z));
  assert.equal(endingMilli(z), 0n);
});

// ═══ 3) الخيارات والوضعان والسقف (§7.1) ═══

test('normalizeReportOptions: توحيد المرحّلة/المسودات وقصّ القوائم', () => {
  const base = { dateFilter: { mode: 'month' as const, from: '2026-03-01', to: '2026-03-31' } };
  const d = normalizeReportOptions(base);
  assert.equal(d.postedOnly, true);
  assert.equal(d.includeDrafts, false);
  assert.equal(d.unit, 1);
  assert.equal(d.breakdown, 'none');
  assert.equal(d.comparison, null);
  assert.deepEqual(d.journals, []);
  assert.equal(normalizeReportOptions({ ...base, postedOnly: false }).includeDrafts, true);
  assert.equal(normalizeReportOptions({ ...base, includeDrafts: true }).postedOnly, false);
  // القيم الفاسدة تعود إلى الافتراض ولا ترفع خطأ
  assert.equal(normalizeReportOptions({ ...base, unit: 7 as never }).unit, 1);
  assert.equal(normalizeReportOptions({ ...base, breakdown: 'x' as never }).breakdown, 'none');
  assert.equal(normalizeReportOptions({ ...base, comparison: { kind: 'x' as never, count: 2 } }).comparison, null);
  assert.deepEqual(normalizeReportOptions({ ...base, comparison: { kind: 'sameLastYear', count: 30 } }).comparison, { kind: 'sameLastYear', count: 12 });
  // القوائم: تُنظَّف وتُزال المكرّرات
  assert.deepEqual(normalizeReportOptions({ ...base, journals: [' j1 ', 'j1', '', 'j2'] }).journals, ['j1', 'j2']);
  assert.equal(normalizeReportOptions({ ...base, search: ' x '.repeat(400) }).search.length <= 200, true);
});

test('الوضعان: الفلتر أو التقسيم يفرض مسح البنود، والمسودات لا تغيّر الوضع', () => {
  assert.equal(balanceReadMode({}), 'AGGREGATE');
  assert.equal(balanceReadMode({ includeDrafts: true }), 'AGGREGATE');
  assert.equal(balanceReadMode({ breakdown: 'month' }), 'AGGREGATE');
  assert.equal(balanceReadMode({ breakdown: 'quarter' }), 'AGGREGATE');
  assert.equal(balanceReadMode({ journals: ['j1'] }), 'LINE_SCAN');
  assert.equal(balanceReadMode({ analytic: ['an1'] }), 'LINE_SCAN');
  assert.equal(balanceReadMode({ salesReps: ['r1'] }), 'LINE_SCAN');
  assert.equal(balanceReadMode({ breakdown: 'salesRep' }), 'LINE_SCAN');
  assert.equal(balanceReadMode({ breakdown: 'analytic' }), 'LINE_SCAN');
  assert.equal(balanceReadMode({ breakdown: 'journal' }), 'LINE_SCAN');
  // قوائم فارغة لا تفرض المسح
  assert.equal(requiresLineScan({ journals: [], analytic: [], salesReps: [], breakdown: 'none' }), false);
  // خيارات التقرير ⇐ خيارات القراءة بلا الخيارات العرضية
  const opts = normalizeReportOptions({
    dateFilter: { mode: 'month', from: '2026-03-01', to: '2026-03-31' },
    journals: ['j1'], unit: 1000, hierarchy: true, hideZero: true, search: 'x',
  });
  const load = reportLoadOptions(opts);
  assert.deepEqual(load.journals, ['j1']);
  assert.equal('unit' in load, false);
  assert.equal('search' in load, false);
});

test('سقف وضع المسح: 12 شهراً وإلا 422 LEDGER_RANGE_TOO_LARGE', () => {
  assert.equal(SCAN_RANGE_MAX_MONTHS, 12);
  const ok = makePeriod('2026-01-01', '2026-12-31', FY_DEC);
  assert.equal(exceedsScanRange(ok), false);
  assert.doesNotThrow(() => assertScanRange(ok));
  const tooBig = makePeriod('2026-01-01', '2027-01-31', FY_DEC);
  assert.equal(exceedsScanRange(tooBig), true);
  try {
    assertScanRange(tooBig);
    assert.fail('كان يجب رفض المدى');
  } catch (err) {
    assert.ok(isLedgerError(err, 'LEDGER_RANGE_TOO_LARGE'));
    assert.equal((err as { httpStatus: number }).httpStatus, 422);
    assert.equal((err as { details: { months: number; cap: number } }).details.months, 13);
    assert.equal((err as { details: { cap: number } }).details.cap, 12);
  }
});

// ═══ 4) حارس ثابت: القاعدة لا تُلمس إلا في load.ts (§7.1) ═══

test('حارس ثابت: prisma في reports/ داخل load.ts وحده', () => {
  const dir = path.join(__dirname, '..', 'services', 'gl', 'reports');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.includes('types.ts') && files.includes('balances.ts') && files.includes('load.ts') && files.includes('period.ts'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (f === 'load.ts') {
      assert.match(code, /@prisma\/client/);
      continue;
    }
    assert.equal(/@prisma\/client|config\/database|prisma\./.test(code), false, `${f} يجب أن يبقى صرفاً بلا prisma`);
  }
});
