// M4 — ميزان المراجعة (DESIGN.md §7.2، TB‑01…TB‑03، وخيارات §7.1 RPT‑04/06/07/15).
// صرف تماماً بلا قاعدة بيانات: composeBalances تستقبل مصفوفات، وbuildTrialBalance تستقبل أرصدتها.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_FISCAL_YEAR, makePeriod } from '../services/gl/reports/period';
import { composeBalances } from '../services/gl/reports/balances';
import type { BalanceLineRow, PeriodBalanceRow, ReportAccount, ReportPeriod } from '../services/gl/reports/types';
import {
  DEFAULT_TRIAL_BALANCE_GROUPS, GROUP_ROW_ID_PREFIX, TRIAL_BALANCE_COLUMN_LABELS, TRIAL_BALANCE_KEY,
  UNALLOCATED_EARNINGS_NAME, UNALLOCATED_EARNINGS_ROW_ID,
  accountPrefixes, buildTrialBalance, percentChange, serializeTrialBalance,
  trialBalanceLineCount, trialBalanceRow,
  type TrialBalanceGroup, type TrialBalanceInput, type TrialBalanceReport, type TrialBalanceRow,
} from '../services/gl/reports/trialBalance';

// ═══ أدوات المتجهات ═══

const FY = DEFAULT_FISCAL_YEAR;

/** مبلغ بالريال ⇐ ملّي (§2.3) */
const m = (riyal: number): bigint => BigInt(Math.round(riyal * 1000));

const ACC: ReportAccount[] = [
  { id: 'a-cash', code: '111001', name: 'الصندوق الرئيسي', nameI18n: { ar: 'الصندوق الرئيسي', en: 'Main Cash' }, type: 'asset_cash' },
  { id: 'a-ar', code: '113001', name: 'ذمم العملاء', nameI18n: null, type: 'asset_receivable' },
  { id: 'a-cap', code: '311001', name: 'رأس المال', nameI18n: null, type: 'equity' },
  { id: 'a-re', code: '313001', name: 'الأرباح المبقاة', nameI18n: null, type: 'equity' },
  { id: 'a-un', code: '319001', name: 'أرباح السنة الجارية غير الموزعة', nameI18n: null, type: 'equity_unaffected' },
  { id: 'a-rev', code: '411001', name: 'إيرادات المبيعات', nameI18n: null, type: 'income' },
  { id: 'a-cogs', code: '511001', name: 'تكلفة المبيعات', nameI18n: null, type: 'expense_direct_cost' },
  { id: 'a-exp', code: '611001', name: 'مصروفات عمومية', nameI18n: null, type: 'expense' },
];

/** مجموعات مختصرة بثلاثة مستويات (بلا مستوى «1110 الصناديق» الذي في القالب) */
const GROUPS: TrialBalanceGroup[] = [
  { code: '1', name: 'الأصول' }, { code: '11', name: 'الأصول المتداولة' },
  { code: '111', name: 'النقد بالصندوق والبنك' }, { code: '113', name: 'الذمم المدينة' },
  { code: '3', name: 'حقوق الملكية' }, { code: '31', name: 'رأس المال والأرباح' },
  { code: '311', name: 'رأس المال' }, { code: '313', name: 'الأرباح المبقاة' },
  { code: '4', name: 'الإيرادات' }, { code: '41', name: 'إيرادات النشاط' }, { code: '411', name: 'المبيعات' },
  { code: '5', name: 'تكلفة الإيرادات' }, { code: '51', name: 'تكلفة المبيعات' }, { code: '511', name: 'تكلفة البضاعة المباعة' },
  { code: '6', name: 'المصروفات' }, { code: '61', name: 'مصروفات عمومية وإدارية' }, { code: '611', name: 'مصروفات إدارية' },
];

const ln = (
  accountId: string, date: string, debit: number, credit: number,
  flags: { closing?: boolean; draft?: boolean } = {},
): BalanceLineRow => ({
  accountId, date, debitMilli: m(debit), creditMilli: m(credit),
  closing: flags.closing === true, draft: flags.draft === true,
});

const pb = (accountId: string, periodKey: string, debit: number, credit: number): PeriodBalanceRow =>
  ({ accountId, periodKey, debitMilli: m(debit), creditMilli: m(credit) });

/**
 * مجموعة قيود مصطنعة على سنتين ماليتين تقويميتين، فيها إقفال سنة وحسابات دخل ومصروف:
 * - 2025-01-10 رأس مال 100,000 نقداً.
 * - 2025-06-15 مبيعات آجلة 60,000، و2025-06-20 تكلفة 25,000 نقداً، و2025-09-01 مصروف 5,000 نقداً.
 * - 2025-12-31 قيد إقفال السنة (FY_CLOSING) ينقل ربح 30,000 إلى 313001.
 * - 2026-02-10 مبيعات آجلة 20,000، و2026-03-05 مصروف 7,000 نقداً.
 */
const YEAR1_LINES: BalanceLineRow[] = [
  ln('a-cash', '2025-01-10', 100_000, 0), ln('a-cap', '2025-01-10', 0, 100_000),
  ln('a-ar', '2025-06-15', 60_000, 0), ln('a-rev', '2025-06-15', 0, 60_000),
  ln('a-cogs', '2025-06-20', 25_000, 0), ln('a-cash', '2025-06-20', 0, 25_000),
  ln('a-exp', '2025-09-01', 5_000, 0), ln('a-cash', '2025-09-01', 0, 5_000),
];

const CLOSING_LINES: BalanceLineRow[] = [
  ln('a-rev', '2025-12-31', 60_000, 0, { closing: true }),
  ln('a-cogs', '2025-12-31', 0, 25_000, { closing: true }),
  ln('a-exp', '2025-12-31', 0, 5_000, { closing: true }),
  ln('a-re', '2025-12-31', 0, 30_000, { closing: true }),
];

const YEAR2_LINES: BalanceLineRow[] = [
  ln('a-ar', '2026-02-10', 20_000, 0), ln('a-rev', '2026-02-10', 0, 20_000),
  ln('a-exp', '2026-03-05', 7_000, 0), ln('a-cash', '2026-03-05', 0, 7_000),
];

const ALL_LINES = [...YEAR1_LINES, ...CLOSING_LINES, ...YEAR2_LINES];

function balancesFor(period: ReportPeriod, lines: readonly BalanceLineRow[]) {
  return composeBalances({ period, accounts: ACC, lines });
}

function tb(from: string, to: string, lines: readonly BalanceLineRow[], over: Partial<TrialBalanceInput> = {}) {
  const period = makePeriod(from, to, FY);
  return buildTrialBalance({ period, accounts: ACC, balances: balancesFor(period, lines), ...over });
}

const rowById = (result: TrialBalanceReport, id: string): TrialBalanceRow => {
  const r = result.rows.find((x) => x.id === id);
  assert.ok(r, `الصف ${id} مفقود`);
  return r as TrialBalanceRow;
};

const cell0 = (r: TrialBalanceRow) => ({
  opening: r.cells[0].openingMilli, debit: r.cells[0].debitMilli,
  credit: r.cells[0].creditMilli, ending: r.cells[0].endingMilli,
});

const assertBalanced = (result: TrialBalanceReport) => {
  assert.equal(result.totals[0].openingMilli, 0n, 'Σ الافتتاحي ≠ 0');
  assert.equal(result.totals[0].debitMilli, result.totals[0].creditMilli, 'Σ المدين ≠ Σ الدائن');
  assert.equal(result.totals[0].endingMilli, 0n, 'Σ النهائي ≠ 0');
  assert.equal(result.balanced, true);
};

// ═══ 1) التوازن على مجموعة قيود فيها إقفال سنة (§7.2 صف الإجمالي) ═══

test('ميزان المراجعة: الأعمدة الأربعة وشروط الإجمالي الثلاثة بعد إقفال السنة', () => {
  const r = tb('2026-03-01', '2026-03-31', ALL_LINES);
  assert.deepEqual(r.columns[0].period, { from: '2026-03-01', to: '2026-03-31', fyStart: '2026-01-01' });
  assert.equal(r.columns[0].kind, 'base');

  // حسابات الميزانية: الافتتاحي كل ما قبل الفترة
  assert.deepEqual(cell0(rowById(r, 'a-cash')), { opening: m(70_000), debit: 0n, credit: m(7_000), ending: m(63_000) });
  assert.deepEqual(cell0(rowById(r, 'a-ar')), { opening: m(80_000), debit: 0n, credit: 0n, ending: m(80_000) });
  assert.deepEqual(cell0(rowById(r, 'a-cap')), { opening: m(-100_000), debit: 0n, credit: 0n, ending: m(-100_000) });
  // 313001 يبقى في صف حسابه ومعه بند الإقفال السابق للفترة (§7.2)
  assert.deepEqual(cell0(rowById(r, 'a-re')), { opening: m(-30_000), debit: 0n, credit: 0n, ending: m(-30_000) });
  // حساب قائمة الدخل: الافتتاحي من بداية السنة المالية وحدها (−20,000 لا −80,000)
  assert.deepEqual(cell0(rowById(r, 'a-rev')), { opening: m(-20_000), debit: 0n, credit: 0n, ending: m(-20_000) });
  assert.deepEqual(cell0(rowById(r, 'a-cogs')), { opening: 0n, debit: 0n, credit: 0n, ending: 0n });
  assert.deepEqual(cell0(rowById(r, 'a-exp')), { opening: 0n, debit: m(7_000), credit: 0n, ending: m(7_000) });
  // بعد الإقفال: صف «أرباح سنوات سابقة» صفر (نتيجة السنة انتقلت إلى 313001)
  assert.deepEqual(cell0(rowById(r, UNALLOCATED_EARNINGS_ROW_ID)), { opening: 0n, debit: 0n, credit: 0n, ending: 0n });

  assertBalanced(r);
  assert.deepEqual(r.imbalance[0], { openingMilli: 0n, movementMilli: 0n, endingMilli: 0n, balanced: true });
  assert.deepEqual(r.visibleTotals, r.totals);
  assert.equal(r.accountRowCount, 8); // سبعة حسابات (319001 مدموج) + الصف الافتراضي
  assert.equal(trialBalanceLineCount(r), r.accountRowCount);
});

test('ميزان المراجعة: الإجمالي متوازن **قبل** الإقفال، وصف أرباح السنوات السابقة يحمل ربح السنة الماضية', () => {
  const r = tb('2026-03-01', '2026-03-31', [...YEAR1_LINES, ...YEAR2_LINES]);
  // افتتاحيه = Σ رصيد حسابات قائمة الدخل قبل FYStart = −(60,000 − 25,000 − 5,000)
  assert.deepEqual(cell0(rowById(r, UNALLOCATED_EARNINGS_ROW_ID)), {
    opening: m(-30_000), debit: 0n, credit: 0n, ending: m(-30_000),
  });
  assert.deepEqual(cell0(rowById(r, 'a-re')), { opening: 0n, debit: 0n, credit: 0n, ending: 0n });
  // ولا يتغيّر صف الحسابات الأخرى عن حالة «بعد الإقفال»
  assert.deepEqual(cell0(rowById(r, 'a-rev')), { opening: m(-20_000), debit: 0n, credit: 0n, ending: m(-20_000) });
  assertBalanced(r);
});

// §7.2 يقول عن الصف الافتراضي «وحركته صفر»، ثم يقول في بند الإقفال التالي له «حركةً إن وقع تاريخ
// الإقفال داخل الفترة». الأخصّ يحكم: «حركته صفر» وصفٌ للحالة المعتادة لا شرطٌ مطلق، وإلا ضاع نصف
// قيد الإقفال (طرفه على حسابات قائمة الدخل) ولم يعد Σ المدين = Σ الدائن في شهر الإقفال.
test('ميزان المراجعة: بند الإقفال داخل الفترة حركةً في صف أرباح السنوات السابقة وفي صف 313001', () => {
  const r = tb('2025-12-01', '2025-12-31', ALL_LINES);
  // حسابات قائمة الدخل لا تحمل بند الإقفال: أرصدتها تبقى كما هي داخل الفترة
  assert.deepEqual(cell0(rowById(r, 'a-rev')), { opening: m(-60_000), debit: 0n, credit: 0n, ending: m(-60_000) });
  assert.deepEqual(cell0(rowById(r, 'a-cogs')), { opening: m(25_000), debit: 0n, credit: 0n, ending: m(25_000) });
  assert.deepEqual(cell0(rowById(r, 'a-exp')), { opening: m(5_000), debit: 0n, credit: 0n, ending: m(5_000) });
  // صافي بنود الإقفال على حسابات قائمة الدخل (+30,000 مديناً) حركةً في الصف الافتراضي
  assert.deepEqual(cell0(rowById(r, UNALLOCATED_EARNINGS_ROW_ID)), {
    opening: 0n, debit: m(30_000), credit: 0n, ending: m(30_000),
  });
  // وسطر 313001 في صف حسابه حركةً (دائن 30,000)
  assert.deepEqual(cell0(rowById(r, 'a-re')), { opening: 0n, debit: 0n, credit: m(30_000), ending: m(-30_000) });
  assertBalanced(r);
});

test('ميزان المراجعة: الوضع المجمّع (gl_period_balances) يطابق وضع مسح البنود حرفاً', () => {
  const period = makePeriod('2026-03-01', '2026-03-31', FY);
  // كل الشهور كاملة هنا (fyStart وfrom أول شهر، وto آخر شهر) ⇒ splitMonths فارغة
  const periods: PeriodBalanceRow[] = [
    pb('a-cash', '2025-01', 100_000, 0), pb('a-cap', '2025-01', 0, 100_000),
    pb('a-ar', '2025-06', 60_000, 0), pb('a-rev', '2025-06', 0, 60_000),
    pb('a-cogs', '2025-06', 25_000, 0), pb('a-cash', '2025-06', 0, 25_000),
    pb('a-exp', '2025-09', 5_000, 0), pb('a-cash', '2025-09', 0, 5_000),
    pb('a-ar', '2026-02', 20_000, 0), pb('a-rev', '2026-02', 0, 20_000),
    pb('a-exp', '2026-03', 7_000, 0), pb('a-cash', '2026-03', 0, 7_000),
  ];
  const aggregate = buildTrialBalance({
    period,
    accounts: ACC,
    balances: composeBalances({ period, accounts: ACC, periods, lines: CLOSING_LINES, splitMonths: [] }),
  });
  const scanned = tb('2026-03-01', '2026-03-31', ALL_LINES);
  assert.deepEqual(aggregate.rows, scanned.rows);
  assert.deepEqual(aggregate.totals, scanned.totals);
});

test('المسودات (RPT‑05) تدخل الميزان مع «مع المسودات» ولا تكسر توازنه', () => {
  const drafts: BalanceLineRow[] = [
    ln('a-exp', '2026-03-20', 1_000, 0, { draft: true }),
    ln('a-cash', '2026-03-20', 0, 1_000, { draft: true }),
  ];
  const period = makePeriod('2026-03-01', '2026-03-31', FY);
  const lines = [...ALL_LINES, ...drafts];
  const posted = buildTrialBalance({ period, accounts: ACC, balances: composeBalances({ period, accounts: ACC, lines }) });
  const withDrafts = buildTrialBalance({
    period, accounts: ACC,
    balances: composeBalances({ period, accounts: ACC, lines, includeDrafts: true }),
  });
  assert.equal(cell0(rowById(posted, 'a-exp')).debit, m(7_000));
  assert.equal(cell0(rowById(withDrafts, 'a-exp')).debit, m(8_000));
  assert.equal(cell0(rowById(withDrafts, 'a-cash')).credit, m(8_000));
  assertBalanced(posted);
  assertBalanced(withDrafts);
});

// ═══ 2) دمج 319001 في الصف الافتراضي (§7.2) ═══

test('صف أرباح السنوات السابقة يبتلع حساب 319001 فلا يظهر صفاً مستقلاً ولا يُحتسب مرتين', () => {
  const lines: BalanceLineRow[] = [
    ln('a-cash', '2024-05-01', 50_000, 0), ln('a-cap', '2024-05-01', 0, 50_000),
    ln('a-cash', '2025-04-01', 3_000, 0), ln('a-un', '2025-04-01', 0, 3_000),
  ];
  // (أ) رصيد 319001 السابق يدخل افتتاحي الصف الافتراضي
  const after = tb('2026-01-01', '2026-12-31', lines);
  assert.equal(after.rows.some((x) => x.accountId === 'a-un'), false);
  assert.equal(after.rows.some((x) => x.code === '319001'), false);
  assert.deepEqual(cell0(rowById(after, UNALLOCATED_EARNINGS_ROW_ID)), {
    opening: m(-3_000), debit: 0n, credit: 0n, ending: m(-3_000),
  });
  assert.deepEqual(rowById(after, UNALLOCATED_EARNINGS_ROW_ID).mergedAccountIds, ['a-un']);
  assert.equal(rowById(after, UNALLOCATED_EARNINGS_ROW_ID).name, UNALLOCATED_EARNINGS_NAME);
  assertBalanced(after);

  // برهان قرار الدمج: Σ افتتاحي الصفوف المعروضة = 0 (الوضع المسطّح بلا عُقد)، ولو أُبقي 319001
  // صفاً مستقلاً لأُضيف افتتاحيه (−3,000) مرة ثانية فصار Σ = −3,000 وانكسر شرط §7.2 الأول.
  const sumOpening = after.rows.reduce((s, x) => s + x.cells[0].openingMilli, 0n);
  assert.equal(sumOpening, 0n);
  assert.equal(sumOpening + cell0(rowById(after, UNALLOCATED_EARNINGS_ROW_ID)).opening, m(-3_000));

  // (ب) حركة 319001 داخل الفترة تنتقل هي أيضاً إلى الصف الافتراضي
  const during = tb('2025-01-01', '2025-12-31', lines);
  assert.deepEqual(cell0(rowById(during, UNALLOCATED_EARNINGS_ROW_ID)), {
    opening: 0n, debit: 0n, credit: m(3_000), ending: m(-3_000),
  });
  assertBalanced(during);
});

// ═══ 3) الهرمية ببادئة الرمز (RPT‑07) ═══

test('الهرمية: عُقد ببادئة الرمز ومجاميعها = Σ أبنائها، والصف الافتراضي في الجذر آخراً', () => {
  const r = tb('2026-03-01', '2026-03-31', ALL_LINES, { hierarchy: true, groups: GROUPS });

  const g1 = rowById(r, `${GROUP_ROW_ID_PREFIX}1`);
  assert.equal(g1.kind, 'group');
  assert.equal(g1.name, 'الأصول');
  assert.equal(g1.level, 0);
  assert.equal(g1.accountId, null);
  assert.equal(g1.hasChildren, true);
  // الأصول = النقد 63,000 + الذمم 80,000
  assert.equal(g1.cells[0].endingMilli, m(143_000));
  assert.equal(g1.cells[0].openingMilli, m(150_000));
  assert.equal(g1.cells[0].creditMilli, m(7_000));
  assert.deepEqual(g1.childIds, [`${GROUP_ROW_ID_PREFIX}11`]);

  const g111 = rowById(r, `${GROUP_ROW_ID_PREFIX}111`);
  assert.equal(g111.level, 2);
  assert.equal(g111.parentId, `${GROUP_ROW_ID_PREFIX}11`);
  assert.deepEqual(g111.childIds, ['a-cash']);
  assert.equal(g111.cells[0].endingMilli, m(63_000));

  const cash = rowById(r, 'a-cash');
  assert.equal(cash.level, 3);
  assert.equal(cash.parentId, `${GROUP_ROW_ID_PREFIX}111`);
  assert.equal(cash.hasChildren, false);

  // ترتيب العرض: عمق أولاً بالرمز، والصف الافتراضي آخراً في المستوى صفر
  const order = r.rows.map((x) => x.id);
  assert.equal(order[0], `${GROUP_ROW_ID_PREFIX}1`);
  assert.equal(order[order.length - 1], UNALLOCATED_EARNINGS_ROW_ID);
  assert.equal(rowById(r, UNALLOCATED_EARNINGS_ROW_ID).level, 0);
  assert.equal(rowById(r, UNALLOCATED_EARNINGS_ROW_ID).parentId, null);

  // المجاميع لا تتأثر بالهرمية، والعُقد ليست أسطر تصدير
  const flat = tb('2026-03-01', '2026-03-31', ALL_LINES);
  assert.deepEqual(r.totals, flat.totals);
  assert.equal(r.accountRowCount, flat.accountRowCount);
  assert.ok(r.rows.filter((x) => x.kind === 'group').length >= 8);
  assertBalanced(r);
});

test('الهرمية بلا مجموعات: بادئات 1 و2 و3 أرقام واسم العقدة = رمزها', () => {
  const r = tb('2026-03-01', '2026-03-31', ALL_LINES, { hierarchy: true, groups: [] });
  const g = rowById(r, `${GROUP_ROW_ID_PREFIX}11`);
  assert.equal(g.name, '11');
  assert.equal(g.nameI18n, null);
  assert.equal(rowById(r, 'a-cash').level, 3);
  assert.ok(trialBalanceRow(r, `${GROUP_ROW_ID_PREFIX}111`));
});

test('الهرمية بمجموعات القالب الافتراضية: أسماء عربية ومستوى «1110 الصناديق»', () => {
  const r = tb('2026-03-01', '2026-03-31', ALL_LINES, { hierarchy: true });
  assert.equal(rowById(r, `${GROUP_ROW_ID_PREFIX}1`).name, 'الأصول');
  assert.equal(rowById(r, `${GROUP_ROW_ID_PREFIX}1110`).name, 'الصناديق');
  assert.equal(rowById(r, `${GROUP_ROW_ID_PREFIX}1110`).nameI18n?.en, 'Cash Boxes');
  assert.equal(rowById(r, 'a-cash').level, 4);
  assert.ok(DEFAULT_TRIAL_BALANCE_GROUPS.some((g) => g.code === '1110'));
  assertBalanced(r);
});

test('accountPrefixes: يجمع بادئات المجموعات والأطوال الافتراضية مرتّبةً بالطول بلا تكرار', () => {
  assert.deepEqual(accountPrefixes('111001', new Set(['1', '11', '111', '1110']), [1, 2, 3]), ['1', '11', '111', '1110']);
  assert.deepEqual(accountPrefixes('111001', new Set(), [1, 2, 3]), ['1', '11', '111']);
  // بادئة أطول من الرمز أو مساوية له لا تصير أباً لنفسه
  assert.deepEqual(accountPrefixes('11', new Set(['1', '11', '111']), [1, 2, 3]), ['1']);
});

// ═══ 4) إخفاء الأصفار والبحث (RPT‑07، RPT‑15) ═══

test('إخفاء الأصفار يحذف الصفوف الصفرية ولا يمسّ صف الإجمالي', () => {
  const full = tb('2026-03-01', '2026-03-31', ALL_LINES);
  const hidden = tb('2026-03-01', '2026-03-31', ALL_LINES, { hideZero: true });
  // تكلفة المبيعات صفر بعد الإقفال، وكذلك الصف الافتراضي
  assert.equal(full.rows.some((x) => x.id === 'a-cogs'), true);
  assert.equal(hidden.rows.some((x) => x.id === 'a-cogs'), false);
  assert.equal(hidden.rows.some((x) => x.id === UNALLOCATED_EARNINGS_ROW_ID), false);
  assert.deepEqual(hidden.totals, full.totals);
  assert.deepEqual(hidden.visibleTotals, hidden.totals);
  assert.equal(hidden.accountRowCount, full.accountRowCount - 2);
  assertBalanced(hidden);
});

test('البحث يضيّق الصفوف ويُبقي صف الإجمالي على كل الحسابات (RPT‑15)', () => {
  const r = tb('2026-03-01', '2026-03-31', ALL_LINES, { search: '113' });
  assert.equal(r.searchApplied, true);
  assert.deepEqual(r.rows.map((x) => x.id), ['a-ar']);
  assertBalanced(r); // الإجمالي على كل الحسابات فتظل شروط §7.2 قائمة
  assert.equal(r.visibleTotals[0].endingMilli, m(80_000));
  assert.equal(r.accountRowCount, 1);

  // البحث بالاسم يصل إلى الصف الافتراضي أيضاً
  const byName = tb('2026-03-01', '2026-03-31', [...YEAR1_LINES, ...YEAR2_LINES], { search: 'أرباح سنوات' });
  assert.deepEqual(byName.rows.map((x) => x.id), [UNALLOCATED_EARNINGS_ROW_ID]);
  assert.equal(byName.visibleTotals[0].endingMilli, m(-30_000));
});

test('البحث في الوضع الهرمي يُبقي آباء المطابق وحدهم', () => {
  const r = tb('2026-03-01', '2026-03-31', ALL_LINES, { hierarchy: true, groups: GROUPS, search: '111' });
  assert.deepEqual(r.rows.map((x) => x.id), [
    `${GROUP_ROW_ID_PREFIX}1`, `${GROUP_ROW_ID_PREFIX}11`, `${GROUP_ROW_ID_PREFIX}111`, 'a-cash',
  ]);
  assert.equal(rowById(r, `${GROUP_ROW_ID_PREFIX}1`).cells[0].endingMilli, m(63_000));
  assert.equal(r.accountRowCount, 1);
});

// ═══ 5) أعمدة المقارنة (RPT‑04) ═══

test('المقارنة: عمود لكل فترة مع الفرق والنسبة على الرصيد النهائي', () => {
  const base = makePeriod('2026-03-01', '2026-03-31', FY);
  const prev = makePeriod('2026-02-01', '2026-02-28', FY);
  const r = buildTrialBalance({
    period: base,
    accounts: ACC,
    balances: balancesFor(base, ALL_LINES),
    comparisons: [{ period: prev, balances: balancesFor(prev, ALL_LINES) }],
  });

  assert.deepEqual(r.columns.map((c) => c.kind), ['base', 'comparison']);
  assert.deepEqual(r.columns[1].period, { from: '2026-02-01', to: '2026-02-28', fyStart: '2026-01-01' });

  const cash = rowById(r, 'a-cash');
  assert.equal(cash.cells[0].endingMilli, m(63_000));
  assert.equal(cash.cells[1].endingMilli, m(70_000));
  assert.equal(cash.cells[0].deltaMilli, null);
  assert.equal(cash.cells[0].percent, null);
  assert.equal(cash.cells[1].deltaMilli, m(-7_000));
  assert.equal(cash.cells[1].percent, -10);

  // كل عمود متوازن بذاته
  assert.equal(r.imbalance.length, 2);
  assert.equal(r.imbalance.every((x) => x.balanced), true);
  assert.equal(r.balanced, true);
  assert.equal(r.totals[1].openingMilli, 0n);
  assert.equal(r.totals[1].endingMilli, 0n);

  // النسبة تُلغى حين يكون المقارَن صفراً
  assert.equal(rowById(r, 'a-cogs').cells[1].endingMilli, 0n);
  assert.equal(rowById(r, 'a-cogs').cells[1].percent, null);
});

test('percentChange: نصف-لأعلى بلا float، وnull عند القاعدة الصفرية', () => {
  assert.equal(percentChange(m(-7_000), m(70_000)), -10);
  assert.equal(percentChange(m(1), m(3)), 33.33);
  assert.equal(percentChange(m(2), m(3)), 66.67);
  assert.equal(percentChange(m(5), 0n), null);
  assert.equal(percentChange(m(-1), m(-2)), -50);
});

// ═══ 6) الجسر مع المسار والحُرّاس ═══

test('الصيغتان متكافئتان: columns، أو period/balances/comparisons كما يمرّرها المسار', () => {
  const base = makePeriod('2026-03-01', '2026-03-31', FY);
  const prev = makePeriod('2026-02-01', '2026-02-28', FY);
  const cols = buildTrialBalance({
    accounts: ACC,
    columns: [{ period: base, balances: balancesFor(base, ALL_LINES) }, { period: prev, balances: balancesFor(prev, ALL_LINES) }],
    options: { hierarchy: false, hideZero: false, search: '', unit: 1 },
  });
  const statement = buildTrialBalance({
    reportKey: TRIAL_BALANCE_KEY,
    accounts: ACC,
    period: base,
    balances: balancesFor(base, ALL_LINES),
    comparisons: [{ period: prev, balances: balancesFor(prev, ALL_LINES) }],
    settings: { currency: 'SAR', currencyDecimals: 2 },
    options: { hierarchy: false, hideZero: false, search: '', unit: 1 },
  });
  assert.deepEqual(statement.rows, cols.rows);
  assert.deepEqual(statement.totals, cols.totals);
  assert.deepEqual(statement.columns, cols.columns);
  assert.throws(() => buildTrialBalance({ accounts: ACC }), /لا أعمدة/);
});

// ═══ 6) التسلسل إلى ردّ JSON (عقد المبالغ الموحّد: ملّي نصّاً) ═══

/**
 * حارس العقد: لا BigInt في الردّ، وكل مفتاح ينتهي بـ`Milli` نصّ عدد صحيح بالملّي
 * (بلا فاصلة عشرية ولا فواصل آلاف ولا وحدة عرض)، أو `null` لفرق العمود الأساسي.
 */
function assertMilliContract(node: unknown, at = 'payload'): void {
  assert.notEqual(typeof node, 'bigint', `${at}: BigInt تسرّب إلى الردّ`);
  if (Array.isArray(node)) {
    node.forEach((x, i) => assertMilliContract(x, `${at}[${i}]`));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const at2 = `${at}.${key}`;
    if (!key.endsWith('Milli')) { assertMilliContract(value, at2); continue; }
    if (value === null) continue;
    assert.equal(typeof value, 'string', `${at2}: مبلغ الردّ نصّ لا ${typeof value}`);
    assert.match(value as string, /^-?\d+$/, `${at2}: نصّ عدد صحيح بالملّي بلا تنسيق`);
  }
}

test('serializeTrialBalance: كل مبلغ نصّ عدد صحيح بالملّي، والعملة ومنازلها بيانٌ وصفي', () => {
  const r = tb('2026-03-01', '2026-03-31', ALL_LINES, { draftMoveCount: 2 });
  const payload = serializeTrialBalance(r, { currencyDecimals: 2, currency: 'SAR' });
  assert.equal(payload.key, TRIAL_BALANCE_KEY);
  assert.equal(payload.currency, 'SAR');
  assert.equal(payload.currencyDecimals, 2);
  assert.equal(payload.unit, 1);
  assert.equal(payload.draftMoveCount, 2);
  assert.equal(payload.unallocatedRowId, UNALLOCATED_EARNINGS_ROW_ID);
  assert.deepEqual(payload.columnLabels, TRIAL_BALANCE_COLUMN_LABELS);
  assert.deepEqual(payload.columns[0], { from: '2026-03-01', to: '2026-03-31', fyStart: '2026-01-01', kind: 'base', index: 0 });

  const cash = payload.rows.find((x) => x.accountId === 'a-cash');
  assert.ok(cash);
  // 70,000 ريال = 70,000,000 ملّي — الرقم كما حسبه المحرّك بلا قسمة ولا تقريب
  assert.deepEqual(cash?.cells[0], {
    openingMilli: '70000000', debitMilli: '0', creditMilli: '7000000', endingMilli: '63000000',
    deltaMilli: null, percent: null,
  });
  // لا مفتاح مبلغ ثانٍ بجانب مفاتيح الملّي (مسار أرقام واحد لا اثنان)
  assert.deepEqual(Object.keys(cash?.cells[0] as object).sort(), [
    'creditMilli', 'debitMilli', 'deltaMilli', 'endingMilli', 'openingMilli', 'percent',
  ]);
  assert.deepEqual(payload.totals[0], {
    openingMilli: '0', debitMilli: '7000000', creditMilli: '7000000', endingMilli: '0',
    deltaMilli: null, percent: null,
  });
  assert.deepEqual(payload.visibleTotals[0], payload.totals[0]);
  assert.deepEqual(payload.imbalance[0], { openingMilli: '0', movementMilli: '0', endingMilli: '0', balanced: true });
  assert.equal(payload.balanced, true);
  assert.equal(payload.lineCount, r.accountRowCount);

  // العقد على كل الردّ، وصلاحيته لـres.json بلا BigInt
  assertMilliContract(payload);
  assert.equal(JSON.parse(JSON.stringify(payload)).rows.length, payload.rows.length);

  // الصف الافتراضي والقيم السالبة نصوصاً صحيحة أيضاً
  const capital = payload.rows.find((x) => x.accountId === 'a-cap');
  assert.equal(capital?.cells[0].endingMilli, '-100000000');
  assert.equal(payload.rows.find((x) => x.id === UNALLOCATED_EARNINGS_ROW_ID)?.cells[0].endingMilli, '0');
});

test('وحدة العرض (RPT‑06) بيانٌ يُعاد كما هو ولا يغيّر رقماً واحداً في الردّ', () => {
  const opts = { currencyDecimals: 2, currency: 'SAR' };
  const base = serializeTrialBalance(tb('2026-03-01', '2026-03-31', ALL_LINES), opts);
  const thousands = serializeTrialBalance(tb('2026-03-01', '2026-03-31', ALL_LINES, { unit: 1000 }), opts);
  const millions = serializeTrialBalance(tb('2026-03-01', '2026-03-31', ALL_LINES, { unit: 1_000_000 }), opts);
  assert.equal(base.unit, 1);
  assert.equal(thousands.unit, 1000);
  assert.equal(millions.unit, 1_000_000);
  // لا فرق إلا في مفتاح الوحدة نفسه: القسمة والتقريب شأن الواجهة لا الخادم
  assert.deepEqual({ ...thousands, unit: 1 }, base);
  assert.deepEqual({ ...millions, unit: 1 }, base);
  // ومنازل العملة لا تُقرّب شيئاً: قرش واحد يبقى ظاهراً مهما كانت المنازل
  const odd = tb('2026-03-01', '2026-03-31', [
    ...ALL_LINES, ln('a-exp', '2026-03-09', 1.234, 0), ln('a-cash', '2026-03-09', 0, 1.234),
  ]);
  const zeroDecimals = serializeTrialBalance(odd, { currencyDecimals: 0 });
  assert.equal(zeroDecimals.rows.find((x) => x.accountId === 'a-exp')?.cells[0].debitMilli, '7001234');
  assert.equal(zeroDecimals.currencyDecimals, 0);
  assertMilliContract(zeroDecimals);
});

test('serializeTrialBalance: فرق عمود المقارنة نصّ ملّي، والنسبة عدد', () => {
  const basePeriod = makePeriod('2026-03-01', '2026-03-31', FY);
  const prev = makePeriod('2026-02-01', '2026-02-28', FY);
  const payload = serializeTrialBalance(buildTrialBalance({
    period: basePeriod,
    accounts: ACC,
    balances: balancesFor(basePeriod, ALL_LINES),
    comparisons: [{ period: prev, balances: balancesFor(prev, ALL_LINES) }],
  }), { currencyDecimals: 2 });
  const cash = payload.rows.find((x) => x.accountId === 'a-cash');
  assert.equal(cash?.cells[1].endingMilli, '70000000');
  assert.equal(cash?.cells[1].deltaMilli, '-7000000');
  assert.equal(cash?.cells[1].percent, -10);
  assert.equal(payload.columns[1].kind, 'comparison');
  assertMilliContract(payload);
});

test('حارس برمجي: رصيد على حساب مجهول يُرفض', () => {
  const period = makePeriod('2026-03-01', '2026-03-31', FY);
  assert.throws(
    () => buildTrialBalance({
      period,
      accounts: ACC,
      balances: [{ accountId: 'ghost', openingMilli: 0n, debitMilli: 0n, creditMilli: 0n, closingMilli: 0n, closingOpeningMilli: 0n, preFyMilli: 0n }],
    }),
    /حساب غير معروف/,
  );
});

test('حارس ثابت: trialBalance.ts صرف — لا prisma ولا استيراد لطبقة القراءة', () => {
  const file = path.join(__dirname, '..', 'services', 'gl', 'reports', 'trialBalance.ts');
  const src = fs.readFileSync(file, 'utf8');
  assert.equal(/prisma/i.test(src), false, 'ميزان المراجعة صرف: القراءة في load.ts وحده (§7.1)');
  assert.equal(/from '\.\/load'/.test(src), false, 'لا استيراد لطبقة القاعدة من الدالة الصرفة');
  assert.equal(/parseFloat|toFixed\(/.test(src), false, 'لا حساب بالعائم على المبالغ (§2.3)');
  assert.equal(
    /formatMilli|toUnitMilli|roundToCurrency/.test(src), false,
    'عقد المبالغ: لا تنسيق ولا تقريب ولا وحدة عرض على الخادم — الردّ ملّي نصّاً والتصيير في الواجهة',
  );
});
