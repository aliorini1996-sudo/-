// M4 — قائمة الدخل والميزانية العمومية (DESIGN.md §7.3 PL‑01…PL‑05، §7.4 BS‑01…BS‑04).
// كلّه بلا قاعدة بيانات: الدوالّ صرفة تستقبل حسابات وأرصدة (§7.1)، وload.ts وحده يلمس prisma.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeBalances } from '../services/gl/reports/balances';
import { DEFAULT_FISCAL_YEAR, resolveReportPeriod } from '../services/gl/reports/period';
import type { BalanceLineRow, PeriodBalanceRow, ReportAccount } from '../services/gl/reports/types';
import {
  buildIncomeStatement, currentYearResultMilli, incomeStatementAmount, incomeStatementLine,
  percentChangeMilli, reportAccountRoles, toJsonMilli,
  type IncomeStatementLineKey, type ReportAccountRoles,
} from '../services/gl/reports/incomeStatement';
import {
  balanceSheetAmount, balanceSheetNode, buildBalanceSheet, currentYearEarningsGapMilli, flattenBalanceSheet,
  type BalanceSheetLineKey,
} from '../services/gl/reports/balanceSheet';
import { toMilli } from '../services/gl/money';

// ═══ أدوات ═══

const FY_DEC = DEFAULT_FISCAL_YEAR;
const FY_JUN = { endMonth: 6, endDay: 30 };

/** مبلغ بمنازل الريال ⇐ ملّي (بلا float). */
const M = (s: string): bigint => toMilli(s, 2);

const acc = (id: string, code: string, name: string, type: ReportAccount['type']): ReportAccount =>
  ({ id, code, name, nameI18n: null, type });

interface Leg { id: string; d?: string; c?: string }

/** قيد متوازن: يفشل الاختبار فوراً إن لم يتساوَ المدين والدائن (I1). */
function entry(date: string, legs: Leg[], closing = false): BalanceLineRow[] {
  let dr = 0n;
  let cr = 0n;
  const rows = legs.map((l) => {
    const debitMilli = l.d ? M(l.d) : 0n;
    const creditMilli = l.c ? M(l.c) : 0n;
    dr += debitMilli;
    cr += creditMilli;
    return { accountId: l.id, date, debitMilli, creditMilli, closing, draft: false };
  });
  assert.equal(dr, cr, `قيد غير متوازن في المتجه بتاريخ ${date}`);
  return rows;
}

/** أرصدة شهرية مكافئة للبنود (مسار `gl_period_balances` المجمّع، §7.1 المصدر 1). */
function monthlyAggregates(lines: readonly BalanceLineRow[]): PeriodBalanceRow[] {
  const map = new Map<string, PeriodBalanceRow>();
  for (const l of lines) {
    if (l.closing || l.draft) continue;
    const periodKey = l.date.slice(0, 7);
    const k = `${l.accountId}|${periodKey}`;
    const cur = map.get(k) ?? { accountId: l.accountId, periodKey, debitMilli: 0n, creditMilli: 0n };
    cur.debitMilli += l.debitMilli;
    cur.creditMilli += l.creditMilli;
    map.set(k, cur);
  }
  return [...map.values()];
}

// ═══ المتجه الذهبي من الفيديو (§7.3 PL‑01/PL‑04، §7.4) ═══
//
// شركة سنة أولى 2026: الأصول 542,850.61 = الالتزامات 7,315.00 + حقوق الملكية 535,535.61،
// وصافي الربح 104,186.33، والمسحوبات 107,396.67، والمتبقي −3,210.34.

const GOLD_ACC: ReportAccount[] = [
  acc('cash', '111001', 'الصندوق الرئيسي', 'asset_cash'),
  acc('ar', '113001', 'ذمم العملاء', 'asset_receivable'),
  acc('prep', '114001', 'مصروفات مدفوعة مقدماً', 'asset_prepayments'),
  acc('fixed', '121001', 'أثاث ومعدات', 'asset_fixed'),
  acc('accdep', '121901', 'مجمع إهلاك الأثاث والمعدات', 'asset_fixed'),
  acc('liab', '211501', 'مصروفات مستحقة', 'liability_current'),
  acc('cap', '311001', 'رأس المال', 'equity'),
  acc('re', '313001', 'الأرباح المبقاة', 'equity'),
  acc('draw', '315001', 'مسحوبات وتوزيعات الملاك', 'equity'),
  acc('cye', '319001', 'أرباح السنة الجارية غير الموزعة', 'equity_unaffected'),
  acc('sales', '411001', 'المبيعات', 'income'),
  acc('ret', '411002', 'مردودات المبيعات', 'income'),
  acc('disc', '411003', 'الخصم المسموح به', 'income'),
  acc('oinc', '431001', 'إيرادات أخرى', 'income_other'),
  acc('cogs', '512001', 'المشتريات', 'expense_direct_cost'),
  acc('opex', '521001', 'مصروفات عمومية وإدارية', 'expense'),
  acc('dep', '531001', 'مصروف الإهلاك', 'expense_depreciation'),
  acc('oexp', '541001', 'مصروفات أخرى', 'expense_other'),
  acc('zakat', '551001', 'الزكاة وضريبة الدخل', 'expense_zakat'),
];

const GOLD_ROLES: ReportAccountRoles = reportAccountRoles({
  accounts: GOLD_ACC,
  mappings: [{ key: 'RETAINED_EARNINGS', accountId: 're' }],
  tagLinks: [{ tag: 'DRAWINGS', accountId: 'draw' }],
});

const GOLD_LINES: BalanceLineRow[] = [
  ...entry('2026-01-02', [{ id: 'cash', d: '538745.95' }, { id: 'cap', c: '538745.95' }]),
  ...entry('2026-01-05', [{ id: 'fixed', d: '100000.00' }, { id: 'cash', c: '100000.00' }]),
  // مبيعات مارس: 395,000.00 − مردودات 3,500.00 − خصم 1,670.09 = 389,829.91
  ...entry('2026-03-15', [
    { id: 'ar', d: '389829.91' }, { id: 'ret', d: '3500.00' }, { id: 'disc', d: '1670.09' },
    { id: 'sales', c: '395000.00' },
  ]),
  ...entry('2026-03-20', [{ id: 'cogs', d: '173666.69' }, { id: 'cash', c: '173666.69' }]),
  ...entry('2026-03-25', [{ id: 'opex', d: '132918.00' }, { id: 'cash', c: '125603.00' }, { id: 'liab', c: '7315.00' }]),
  ...entry('2026-03-31', [{ id: 'dep', d: '31332.45' }, { id: 'accdep', c: '31332.45' }]),
  // يوليو–أغسطس (PL‑04): 225,000.00 − 3,000.00 − 1,828.82 = 220,171.18
  ...entry('2026-07-15', [
    { id: 'ar', d: '220171.18' }, { id: 'ret', d: '3000.00' }, { id: 'disc', d: '1828.82' },
    { id: 'sales', c: '225000.00' },
  ]),
  ...entry('2026-07-20', [{ id: 'cogs', d: '86332.44' }, { id: 'cash', c: '86332.44' }]),
  ...entry('2026-08-10', [{ id: 'opex', d: '65817.24' }, { id: 'cash', c: '65817.24' }]),
  ...entry('2026-08-31', [{ id: 'dep', d: '15747.94' }, { id: 'accdep', c: '15747.94' }]),
  ...entry('2026-09-30', [{ id: 'cash', d: '410001.09' }, { id: 'ar', c: '410001.09' }]),
  ...entry('2026-10-15', [{ id: 'prep', d: '42850.61' }, { id: 'cash', c: '42850.61' }]),
  ...entry('2026-11-30', [{ id: 'draw', d: '107396.67' }, { id: 'cash', c: '107396.67' }]),
];

function goldStatement(opts: {
  from: string; to: string; drawings?: boolean; depInOpex?: boolean; showZero?: boolean;
  lines?: readonly BalanceLineRow[]; periods?: readonly PeriodBalanceRow[];
}) {
  const period = resolveReportPeriod({ mode: 'custom', from: opts.from, to: opts.to }, FY_DEC);
  const balances = composeBalances({
    period,
    accounts: GOLD_ACC,
    lines: opts.periods ? [] : (opts.lines ?? GOLD_LINES),
    periods: opts.periods,
  });
  return buildIncomeStatement({
    period,
    accounts: GOLD_ACC,
    balances,
    roles: GOLD_ROLES,
    settings: {
      drawingsAfterNetProfit: opts.drawings === true,
      depreciationInOperatingExpenses: opts.depInOpex === true,
    },
    showAccountsWithoutMovement: opts.showZero === true,
  });
}

function goldSheet(asOf: string, drawings: boolean, lines: readonly BalanceLineRow[] = GOLD_LINES) {
  const period = resolveReportPeriod({ mode: 'asOf', from: asOf, to: asOf }, FY_DEC);
  const balances = composeBalances({ period, accounts: GOLD_ACC, lines });
  return buildBalanceSheet({
    period, accounts: GOLD_ACC, balances, roles: GOLD_ROLES,
    settings: { drawingsAfterNetProfit: drawings },
  });
}

const amt = (st: ReturnType<typeof goldStatement>, key: IncomeStatementLineKey): bigint =>
  incomeStatementAmount(st, key);

// ═══ 1) أدوار الحسابات ═══

test('reportAccountRoles: الربط ثم الوسم ثم رمز القالب، والأرباح المبقاة ليست مسحوبات', () => {
  assert.deepEqual(GOLD_ROLES, { drawings: ['draw'], retainedEarnings: 're' });

  // احتياط بالرمز حين لا يصل ربط ولا وسم (315001 / 313001 من القالب)
  assert.deepEqual(reportAccountRoles({ accounts: GOLD_ACC }), { drawings: ['draw'], retainedEarnings: 're' });

  // مفتاح DRAWINGS على حساب الأرباح المبقاة يُسقَط (لا يكون الحساب نفسه في السطرين)
  assert.deepEqual(
    reportAccountRoles({
      accounts: GOLD_ACC,
      mappings: [{ key: 'RETAINED_EARNINGS', accountId: 're' }, { key: 'DRAWINGS', accountId: 're' }],
    }),
    { drawings: [], retainedEarnings: 're' },
  );

  // معرّف غريب عن قائمة الحسابات لا يمرّ
  assert.deepEqual(
    reportAccountRoles({ accounts: GOLD_ACC, tagLinks: [{ tag: 'DRAWINGS', accountId: 'ghost' }] }).drawings,
    ['draw'],
  );
});

// ═══ 2) قائمة الدخل — المتجهات الذهبية (§7.3) ═══

test('PL‑01: سنة 2026 كاملة — المعادلات والمتجه الذهبي من الفيديو', () => {
  const st = goldStatement({ from: '2026-01-01', to: '2026-12-31', drawings: true });

  assert.equal(amt(st, 'revenue'), M('610001.09'));
  assert.equal(amt(st, 'costOfRevenue'), M('259999.13'));
  assert.equal(amt(st, 'grossProfit'), M('350001.96'));
  assert.equal(amt(st, 'operatingExpenses'), M('198735.24'));
  assert.equal(amt(st, 'operatingIncome'), M('151266.72'));
  assert.equal(amt(st, 'otherIncome'), 0n);
  assert.equal(amt(st, 'otherExpenses'), M('47080.39'));
  assert.equal(amt(st, 'profitBeforeZakat'), M('104186.33'));
  assert.equal(amt(st, 'zakat'), 0n);
  assert.equal(amt(st, 'netProfit'), M('104186.33'));
  assert.equal(amt(st, 'drawings'), M('107396.67'));
  assert.equal(amt(st, 'netProfitAfterDrawings'), -M('3210.34'));

  // المعادلات نفسها لا الأرقام وحدها
  assert.equal(amt(st, 'grossProfit'), amt(st, 'revenue') - amt(st, 'costOfRevenue'));
  assert.equal(amt(st, 'operatingIncome'), amt(st, 'grossProfit') - amt(st, 'operatingExpenses'));
  assert.equal(
    amt(st, 'profitBeforeZakat'),
    amt(st, 'operatingIncome') + amt(st, 'otherIncome') - amt(st, 'otherExpenses'),
  );
  assert.equal(amt(st, 'netProfit'), amt(st, 'profitBeforeZakat') - amt(st, 'zakat'));
  assert.equal(amt(st, 'netProfitAfterDrawings'), amt(st, 'netProfit') - amt(st, 'drawings'));

  // أسطر الإيرادات الفرعية: المردودات والخصم بالسالب (§7.3)
  const revenue = incomeStatementLine(st, 'revenue');
  assert.ok(revenue);
  assert.deepEqual(revenue.accounts.map((r) => r.code), ['411001', '411002', '411003']);
  assert.equal(revenue.accounts[0].amountMilli, M('620000.00'));
  assert.equal(revenue.accounts[1].amountMilli, -M('6500.00'));
  assert.equal(revenue.accounts[2].amountMilli, -M('3498.91'));
});

test('PL‑04: يوليو–أغسطس 2026 — إعادة الحساب لفترة مخصصة', () => {
  const st = goldStatement({ from: '2026-07-01', to: '2026-08-31' });

  assert.equal(amt(st, 'revenue'), M('220171.18'));
  assert.equal(amt(st, 'costOfRevenue'), M('86332.44'));
  assert.equal(amt(st, 'grossProfit'), M('133838.74'));
  assert.equal(amt(st, 'operatingExpenses'), M('65817.24'));
  assert.equal(amt(st, 'operatingIncome'), M('68021.50'));
  assert.equal(amt(st, 'otherExpenses'), M('15747.94'));
  assert.equal(amt(st, 'netProfit'), M('52273.56'));
});

test('depreciationInOperatingExpenses: ينقل الإهلاك إلى نفقات التشغيل ولا يغيّر صافي الربح', () => {
  const off = goldStatement({ from: '2026-01-01', to: '2026-12-31' });
  const on = goldStatement({ from: '2026-01-01', to: '2026-12-31', depInOpex: true });
  const dep = M('47080.39');

  // المتجه الذهبي مع الخيار: الدخل التشغيلي 104,186.33 وصافي الربح نفسه
  assert.equal(amt(on, 'operatingExpenses'), M('245815.63'));
  assert.equal(amt(on, 'operatingIncome'), M('104186.33'));
  assert.equal(amt(on, 'otherExpenses'), 0n);
  assert.equal(amt(on, 'netProfit'), amt(off, 'netProfit'));

  // ينقل سطرين فقط، لا أكثر
  assert.equal(amt(on, 'operatingExpenses') - amt(off, 'operatingExpenses'), dep);
  assert.equal(amt(off, 'otherExpenses') - amt(on, 'otherExpenses'), dep);
  assert.equal(amt(on, 'operatingIncome'), amt(off, 'operatingIncome') - dep);
  for (const key of ['revenue', 'costOfRevenue', 'grossProfit', 'otherIncome', 'profitBeforeZakat', 'zakat', 'netProfit'] as const) {
    assert.equal(amt(on, key), amt(off, key), `تغيّر سطر ${key} بخيار الإهلاك`);
  }

  // «الإهلاك» سطر فرعي في نفقات التشغيل مع الخيار وحده، وحسابه في «النفقات الأخرى» بدونه
  const groupsOn = incomeStatementLine(on, 'operatingExpenses')?.groups ?? [];
  assert.equal(groupsOn.length, 1);
  assert.equal(groupsOn[0].key, 'depreciation');
  assert.equal(groupsOn[0].label, 'الإهلاك');
  assert.equal(groupsOn[0].amountMilli, dep);
  assert.deepEqual(groupsOn[0].accounts.map((r) => r.code), ['531001']);
  assert.deepEqual(incomeStatementLine(off, 'operatingExpenses')?.groups, []);
  assert.deepEqual(incomeStatementLine(off, 'otherExpenses')?.accounts.map((r) => r.code), ['531001']);
  assert.deepEqual(incomeStatementLine(on, 'otherExpenses')?.accounts.map((r) => r.code), []);
});

test('drawingsAfterNetProfit: يضيف سطري التخصيصات والمتبقي ولا يمسّ ما قبلهما', () => {
  const off = goldStatement({ from: '2026-01-01', to: '2026-12-31' });
  const on = goldStatement({ from: '2026-01-01', to: '2026-12-31', drawings: true });

  assert.deepEqual(off.lines.map((l) => l.key), [
    'revenue', 'costOfRevenue', 'grossProfit', 'operatingExpenses', 'operatingIncome',
    'otherIncome', 'otherExpenses', 'profitBeforeZakat', 'zakat', 'netProfit',
  ]);
  assert.deepEqual(on.lines.map((l) => l.key), [...off.lines.map((l) => l.key), 'drawings', 'netProfitAfterDrawings']);
  for (const l of off.lines) assert.equal(amt(on, l.key), l.amountMilli, `تغيّر سطر ${l.key} بخيار المسحوبات`);

  // بلا الخيار: المتبقي = صافي الربح، والمسحوبات محسوبة إعلامياً فقط
  assert.equal(off.netProfitAfterDrawingsMilli, off.netProfitMilli);
  assert.equal(off.drawingsMilli, M('107396.67'));
  assert.equal(currentYearResultMilli(off), M('104186.33'));
  assert.equal(currentYearResultMilli(on), -M('3210.34'));

  // سطر المسحوبات «مدين»: موجب رغم أنّ الحساب حساب ملكية
  const line = incomeStatementLine(on, 'drawings');
  assert.equal(line?.accounts[0].code, '315001');
  assert.equal(line?.accounts[0].amountMilli, M('107396.67'));
});

test('RPT‑14: الحسابات بلا حركة في الفترة لا تظهر إلا مع «إظهار الصفري»', () => {
  const hidden = goldStatement({ from: '2026-07-01', to: '2026-08-31' });
  const shown = goldStatement({ from: '2026-07-01', to: '2026-08-31', showZero: true });

  // الزكاة والمصروفات الأخرى والإيرادات الأخرى بلا حركة في الفترة
  assert.deepEqual(incomeStatementLine(hidden, 'zakat')?.accounts, []);
  assert.deepEqual(incomeStatementLine(hidden, 'otherIncome')?.accounts, []);
  assert.deepEqual(incomeStatementLine(shown, 'zakat')?.accounts.map((r) => r.code), ['551001']);
  assert.deepEqual(incomeStatementLine(shown, 'otherIncome')?.accounts.map((r) => r.code), ['431001']);
  // إظهار الصفري لا يغيّر مبلغاً واحداً
  for (const l of hidden.lines) assert.equal(amt(shown, l.key), l.amountMilli);
});

test('RPT‑15: البحث يصفّي صفوف الحسابات ولا يمسّ المجاميع', () => {
  const period = resolveReportPeriod({ mode: 'fiscalYear', from: '2026-05-05' }, FY_DEC);
  const balances = composeBalances({ period, accounts: GOLD_ACC, lines: GOLD_LINES });
  const base = { period, accounts: GOLD_ACC, balances, roles: GOLD_ROLES };
  const all = buildIncomeStatement(base);
  const found = buildIncomeStatement({ ...base, search: 'مردودات' });

  assert.equal(found.options.searchFiltered, true);
  assert.equal(amt(found, 'revenue'), amt(all, 'revenue'));
  assert.deepEqual(incomeStatementLine(found, 'revenue')?.accounts.map((r) => r.code), ['411002']);
  assert.equal(buildIncomeStatement({ ...base, search: '' }).options.searchFiltered, false);
});

test('الوضع المجمّع (gl_period_balances) يعطي قائمة الدخل نفسها', () => {
  const fromLines = goldStatement({ from: '2026-01-01', to: '2026-12-31', drawings: true });
  const fromPeriods = goldStatement({
    from: '2026-01-01', to: '2026-12-31', drawings: true, periods: monthlyAggregates(GOLD_LINES),
  });
  for (const l of fromLines.lines) assert.equal(amt(fromPeriods, l.key), l.amountMilli, `اختلف ${l.key}`);
});

// ═══ 3) الميزانية العمومية — المتجه الذهبي (§7.4) ═══

test('BS: المتجه الذهبي من الفيديو — 542,850.61 = 7,315.00 + 535,535.61', () => {
  const bs = goldSheet('2026-12-31', true);

  assert.equal(bs.asOf, '2026-12-31');
  assert.equal(bs.totalAssetsMilli, M('542850.61'));
  assert.equal(bs.totalLiabilitiesMilli, M('7315.00'));
  assert.equal(bs.totalEquityMilli, M('535535.61'));
  assert.equal(bs.currentYearEarningsMilli, -M('3210.34'));
  assert.equal(bs.previousYearsEarningsMilli, 0n);
  assert.equal(balanceSheetAmount(bs, 'capitalAndReserves'), M('538745.95'));
  assert.ok(bs.balanced);
  assert.equal(bs.imbalanceMilli, 0n);
  assert.equal(bs.equityInvariantMilli, 0n);

  // تفصيل الأصول (§7.4)
  assert.equal(balanceSheetAmount(bs, 'assetCash'), M('247080.39'));
  assert.equal(balanceSheetAmount(bs, 'assetReceivable'), M('200000.00'));
  assert.equal(balanceSheetAmount(bs, 'assetCurrent'), 0n);
  assert.equal(balanceSheetAmount(bs, 'assetPrepayments'), M('42850.61'));
  assert.equal(balanceSheetAmount(bs, 'currentAssets'), M('489931.00'));
  // الأصول الثابتة صافية بمجمعاتها: 100,000.00 − 47,080.39
  assert.equal(balanceSheetAmount(bs, 'fixedAssets'), M('52919.61'));
  assert.equal(balanceSheetAmount(bs, 'nonCurrentAssets'), 0n);
  assert.equal(balanceSheetAmount(bs, 'liabilityCurrent'), M('7315.00'));
  assert.equal(balanceSheetAmount(bs, 'liabilityPayable'), 0n);

  // الهيكل: ثلاثة أقسام وسطر «الالتزامات + حقوق الملكية»
  assert.deepEqual(bs.sections.map((s) => s.key), ['assets', 'liabilities', 'equity']);
  assert.equal(bs.totalLine.key, 'liabilitiesAndEquity');
  assert.equal(bs.totalLine.amountMilli, bs.totalAssetsMilli);
  const flat = flattenBalanceSheet(bs).map((n) => n.node.key);
  assert.deepEqual(flat, [
    'assets', 'currentAssets', 'assetCash', 'assetReceivable', 'assetCurrent', 'assetPrepayments',
    'fixedAssets', 'nonCurrentAssets',
    'liabilities', 'currentLiabilities', 'liabilityCurrent', 'liabilityCreditCard', 'liabilityPayable',
    'nonCurrentLiabilities',
    'equity', 'capitalAndReserves', 'earnings', 'currentYearEarnings', 'previousYearsEarnings',
    'liabilitiesAndEquity',
  ]);
});

test('BS: خيار المسحوبات ينقل رصيد 315001 بين الأسطر ولا يُخرجه من المجموع', () => {
  const on = goldSheet('2026-12-31', true);
  const off = goldSheet('2026-12-31', false);
  const draw = M('107396.67');

  assert.equal(balanceSheetAmount(off, 'capitalAndReserves'), M('431349.28'));
  assert.equal(off.currentYearEarningsMilli, M('104186.33'));
  assert.equal(off.previousYearsEarningsMilli, 0n);

  // المنقول بالضبط ولا شيء غيره
  assert.equal(balanceSheetAmount(on, 'capitalAndReserves') - balanceSheetAmount(off, 'capitalAndReserves'), draw);
  assert.equal(off.currentYearEarningsMilli - on.currentYearEarningsMilli, draw);
  assert.equal(on.totalEquityMilli, off.totalEquityMilli);
  assert.equal(on.totalAssetsMilli, off.totalAssetsMilli);
  assert.equal(on.totalLiabilitiesMilli, off.totalLiabilitiesMilli);
  assert.ok(off.balanced && off.equityInvariantMilli === 0n);

  // 313001 خارج «رأس المال والاحتياطيات» دائماً
  const capital = balanceSheetNode(off, 'capitalAndReserves');
  assert.ok(capital);
  assert.equal(capital.accounts.some((r) => r.code === '313001'), false);
  assert.equal(capital.accounts.some((r) => r.code === '315001'), true);
  assert.equal(balanceSheetNode(on, 'capitalAndReserves')?.accounts.some((r) => r.code === '315001'), false);
});

test('RPT‑07: hideZero يخفي صفوف الحسابات الصفرية في الميزانية ولا يمسّ المجاميع ولا الأسطر', () => {
  const period = resolveReportPeriod({ mode: 'asOf', from: '2026-12-31', to: '2026-12-31' }, FY_DEC);
  const balances = composeBalances({ period, accounts: GOLD_ACC, lines: GOLD_LINES });
  const base = { period, accounts: GOLD_ACC, balances, roles: GOLD_ROLES, settings: { drawingsAfterNetProfit: true } };
  const all = buildBalanceSheet(base);
  const lean = buildBalanceSheet({ ...base, hideZero: true });

  // الهيكل ثابت (BS‑04): الأسطر نفسها وبالمبالغ نفسها
  assert.deepEqual(flattenBalanceSheet(lean).map((n) => n.node.key), flattenBalanceSheet(all).map((n) => n.node.key));
  assert.equal(lean.totalAssetsMilli, all.totalAssetsMilli);
  assert.equal(lean.totalEquityMilli, all.totalEquityMilli);
  assert.ok(lean.balanced && lean.equityInvariantMilli === 0n);

  // 319001 بلا رصيد: يظهر في الوضع الكامل ويختفي مع الخيار
  const rows = (s: typeof all, key: BalanceSheetLineKey): string[] =>
    (balanceSheetNode(s, key)?.accounts ?? []).map((r) => r.code);
  assert.deepEqual(rows(all, 'assetCurrent'), []);
  assert.ok(rows(all, 'liabilityPayable').length === 0);
  assert.ok(rows(all, 'assetCash').includes('111001'));
  assert.equal(rows(lean, 'assetCash').length, 1);
  // سطرا الأرباح يُسقطان المساهمات الصفرية دائماً (لا معنى لصفّ مساهمته صفر)
  assert.equal(rows(all, 'previousYearsEarnings').length, 0);
  assert.deepEqual(rows(all, 'currentYearEarnings').sort(), ['315001', '411001', '411002', '411003', '512001', '521001', '531001']);
});

test('صافي الربح في قائمة الدخل = نتيجة السنة الجارية في الميزانية على المدخلات نفسها', () => {
  for (const drawings of [false, true]) {
    for (const depInOpex of [false, true]) {
      for (const asOf of ['2026-03-31', '2026-08-31', '2026-12-31']) {
        const period = resolveReportPeriod({ mode: 'asOf', from: asOf, to: asOf }, FY_DEC);
        const balances = composeBalances({ period, accounts: GOLD_ACC, lines: GOLD_LINES });
        const st = buildIncomeStatement({
          period, accounts: GOLD_ACC, balances, roles: GOLD_ROLES,
          settings: { drawingsAfterNetProfit: drawings, depreciationInOperatingExpenses: depInOpex },
        });
        const bs = buildBalanceSheet({
          period, accounts: GOLD_ACC, balances, roles: GOLD_ROLES,
          settings: { drawingsAfterNetProfit: drawings },
        });
        const label = `drawings=${drawings} dep=${depInOpex} asOf=${asOf}`;
        assert.equal(currentYearEarningsGapMilli(bs, st), 0n, `فجوة نتيجة السنة (${label})`);
        assert.equal(bs.currentYearEarningsMilli, currentYearResultMilli(st), label);
        assert.ok(bs.balanced, `الميزانية غير متوازنة (${label})`);
        assert.equal(bs.equityInvariantMilli, 0n, `خرق ثابت حقوق الملكية (${label})`);
      }
    }
  }
});

// ═══ 4) متجها السنتين (§7.4 (أ) و(ب)) ═══

const TWO_ACC: ReportAccount[] = [
  acc('cash', '111001', 'الصندوق', 'asset_cash'),
  acc('cap', '311001', 'رأس المال', 'equity'),
  acc('re', '313001', 'الأرباح المبقاة', 'equity'),
  acc('draw', '315001', 'المسحوبات', 'equity'),
  acc('inc', '411001', 'المبيعات', 'income'),
];
const TWO_ROLES = reportAccountRoles({ accounts: TWO_ACC });

/** السنة 1: رأس مال 100,000 نقداً، ربح 30,000، مسحوبات 20,000. */
const YEAR1: BalanceLineRow[] = [
  ...entry('2026-01-10', [{ id: 'cash', d: '100000.00' }, { id: 'cap', c: '100000.00' }]),
  ...entry('2026-06-30', [{ id: 'cash', d: '30000.00' }, { id: 'inc', c: '30000.00' }]),
  ...entry('2026-12-01', [{ id: 'draw', d: '20000.00' }, { id: 'cash', c: '20000.00' }]),
];

/** قيد إقفال السنة الاختياري (M12، §2.5) — بنود `YYYY-CL` بتاريخ نهاية السنة. */
function closingEntry(withDrawings: boolean): BalanceLineRow[] {
  return withDrawings
    ? entry('2026-12-31', [
      { id: 'inc', d: '30000.00' }, { id: 're', c: '30000.00' },
      { id: 'draw', c: '20000.00' }, { id: 're', d: '20000.00' },
    ], true)
    : entry('2026-12-31', [{ id: 'inc', d: '30000.00' }, { id: 're', c: '30000.00' }], true);
}

function twoYearSheet(lines: readonly BalanceLineRow[], asOf: string, drawings: boolean) {
  const period = resolveReportPeriod({ mode: 'asOf', from: asOf, to: asOf }, FY_DEC);
  const balances = composeBalances({ period, accounts: TWO_ACC, lines });
  return buildBalanceSheet({
    period, accounts: TWO_ACC, balances, roles: TWO_ROLES, settings: { drawingsAfterNetProfit: drawings },
  });
}

test('§7.4 (أ): السنة 2 بربح 10,000 ومسحوبات 15,000 — الأصول 105,000', () => {
  const lines = [
    ...YEAR1,
    ...entry('2027-06-30', [{ id: 'cash', d: '10000.00' }, { id: 'inc', c: '10000.00' }]),
    ...entry('2027-08-01', [{ id: 'draw', d: '15000.00' }, { id: 'cash', c: '15000.00' }]),
  ];

  const on = twoYearSheet(lines, '2027-12-31', true);
  assert.equal(on.totalAssetsMilli, M('105000.00'));
  assert.equal(balanceSheetAmount(on, 'capitalAndReserves'), M('100000.00'));
  assert.equal(on.currentYearEarningsMilli, -M('5000.00'));
  assert.equal(on.previousYearsEarningsMilli, M('10000.00'));
  assert.ok(on.balanced && on.equityInvariantMilli === 0n);

  const off = twoYearSheet(lines, '2027-12-31', false);
  assert.equal(off.totalAssetsMilli, M('105000.00'));
  assert.equal(balanceSheetAmount(off, 'capitalAndReserves'), M('65000.00'));
  assert.equal(off.currentYearEarningsMilli, M('10000.00'));
  assert.equal(off.previousYearsEarningsMilli, M('30000.00'));
  assert.ok(off.balanced && off.equityInvariantMilli === 0n);

  assert.equal(on.totalEquityMilli, off.totalEquityMilli);

  // D = أول يوم في السنة 2
  for (const drawings of [true, false]) {
    const bs = twoYearSheet(lines, '2027-01-01', drawings);
    assert.equal(bs.totalAssetsMilli, M('110000.00'));
    assert.ok(bs.balanced, `غير متوازنة في أول يوم السنة 2 (المسحوبات=${drawings})`);
    assert.equal(bs.equityInvariantMilli, 0n);
    assert.equal(bs.currentYearEarningsMilli, 0n);
  }
});

test('§7.4 (ب): السنة 2 بربح 5,000 ومسحوبات 2,000 وD منتصفها — الأصول 113,000', () => {
  const lines = [
    ...YEAR1,
    ...entry('2027-03-20', [{ id: 'cash', d: '5000.00' }, { id: 'inc', c: '5000.00' }]),
    ...entry('2027-04-10', [{ id: 'draw', d: '2000.00' }, { id: 'cash', c: '2000.00' }]),
  ];
  const expected = [
    { drawings: true, capital: '100000.00', current: '3000.00', previous: '10000.00' },
    { drawings: false, capital: '78000.00', current: '5000.00', previous: '30000.00' },
  ];
  for (const e of expected) {
    const bs = twoYearSheet(lines, '2027-06-30', e.drawings);
    assert.equal(bs.totalAssetsMilli, M('113000.00'));
    assert.equal(balanceSheetAmount(bs, 'capitalAndReserves'), M(e.capital));
    assert.equal(bs.currentYearEarningsMilli, M(e.current));
    assert.equal(bs.previousYearsEarningsMilli, M(e.previous));
    assert.equal(bs.totalEquityMilli, M('113000.00'));
    assert.ok(bs.balanced && bs.equityInvariantMilli === 0n);
  }
});

test('قيد إقفال السنة (YYYY-CL) لا يغيّر سطراً واحداً من الميزانية (§2.5، §7.4)', () => {
  const year2 = [
    ...entry('2027-06-30', [{ id: 'cash', d: '10000.00' }, { id: 'inc', c: '10000.00' }]),
    ...entry('2027-08-01', [{ id: 'draw', d: '15000.00' }, { id: 'cash', c: '15000.00' }]),
  ];
  for (const drawings of [true, false]) {
    const before = twoYearSheet([...YEAR1, ...year2], '2027-12-31', drawings);
    const after = twoYearSheet([...YEAR1, ...closingEntry(drawings), ...year2], '2027-12-31', drawings);
    const keys: BalanceSheetLineKey[] = [
      'assets', 'currentAssets', 'liabilities', 'equity', 'capitalAndReserves', 'earnings',
      'currentYearEarnings', 'previousYearsEarnings', 'liabilitiesAndEquity',
    ];
    for (const k of keys) {
      assert.equal(balanceSheetAmount(after, k), balanceSheetAmount(before, k), `تغيّر ${k} بالإقفال (المسحوبات=${drawings})`);
    }
    assert.ok(after.balanced && after.equityInvariantMilli === 0n);
  }
});

test('قيود الإقفال مستبعدة من كل أسطر قائمة الدخل (§7.3)', () => {
  const lines = [...YEAR1, ...closingEntry(true)];
  const period = resolveReportPeriod({ mode: 'fiscalYear', from: '2026-07-01' }, FY_DEC);
  const balances = composeBalances({ period, accounts: TWO_ACC, lines });
  const st = buildIncomeStatement({
    period, accounts: TWO_ACC, balances, roles: TWO_ROLES, settings: { drawingsAfterNetProfit: true },
  });
  // السنة المقفلة لا تصير قائمة دخلها صفراً
  assert.equal(st.netProfitMilli, M('30000.00'));
  assert.equal(amt(st, 'revenue'), M('30000.00'));
  assert.equal(st.netProfitAfterDrawingsMilli, M('10000.00'));
});

// ═══ 5) اختبار خاصي: موازين عشوائية متعددة السنوات (§7.4) ═══

function lcg(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const RAND_ACC: ReportAccount[] = [
  acc('cash', '111001', 'الصندوق', 'asset_cash'),
  acc('ar', '113001', 'المدينون', 'asset_receivable'),
  acc('cur', '115001', 'أصول متداولة أخرى', 'asset_current'),
  acc('prep', '116001', 'مدفوعات مقدماً', 'asset_prepayments'),
  acc('fix', '121001', 'أصول ثابتة', 'asset_fixed'),
  acc('nca', '131001', 'أصول غير متداولة', 'asset_non_current'),
  acc('ap', '211001', 'الدائنون', 'liability_payable'),
  acc('cc', '212001', 'بطاقة ائتمانية', 'liability_credit_card'),
  acc('lcur', '213001', 'التزامات متداولة', 'liability_current'),
  acc('lnc', '221001', 'التزامات غير متداولة', 'liability_non_current'),
  acc('cap', '311001', 'رأس المال', 'equity'),
  acc('re', '313001', 'الأرباح المبقاة', 'equity'),
  acc('draw', '315001', 'المسحوبات', 'equity'),
  acc('cye', '319001', 'أرباح السنة الجارية', 'equity_unaffected'),
  acc('inc', '411001', 'المبيعات', 'income'),
  acc('oinc', '431001', 'إيرادات أخرى', 'income_other'),
  acc('dc', '512001', 'تكلفة الإيرادات', 'expense_direct_cost'),
  acc('exp', '521001', 'نفقات تشغيل', 'expense'),
  acc('dep', '531001', 'إهلاك', 'expense_depreciation'),
  acc('oexp', '541001', 'مصروفات أخرى', 'expense_other'),
  acc('zk', '551001', 'زكاة', 'expense_zakat'),
  acc('ob1', '911001', 'التزامات محتملة', 'off_balance'),
  acc('ob2', '911002', 'مقابل الالتزامات المحتملة', 'off_balance'),
];
const RAND_ROLES = reportAccountRoles({ accounts: RAND_ACC });
const RAND_POSTABLE = RAND_ACC.filter((a) => a.type !== 'off_balance');
const RAND_OFF = RAND_ACC.filter((a) => a.type === 'off_balance');
/** حسابات يقع عليها قيد الإقفال (§2.5): قائمة الدخل و313001 و315001 */
const RAND_CLOSING = RAND_ACC.filter((a) => a.type.startsWith('income') || a.type.startsWith('expense') || a.id === 're' || a.id === 'draw');

function randomLedger(seed: number): BalanceLineRow[] {
  const rnd = lcg(seed);
  const pick = <T>(arr: readonly T[]): T => arr[Math.min(arr.length - 1, Math.floor(rnd() * arr.length))];
  const lines: BalanceLineRow[] = [];
  const years = [2025, 2026, 2027, 2028];
  for (let i = 0; i < 40; i++) {
    const y = pick(years);
    const mo = String(1 + Math.floor(rnd() * 12)).padStart(2, '0');
    const da = String(1 + Math.floor(rnd() * 28)).padStart(2, '0');
    const date = `${y}-${mo}-${da}`;
    const offBook = rnd() < 0.08;
    const pool = offBook ? RAND_OFF : RAND_POSTABLE;
    const a = pick(pool);
    const b = pick(pool);
    if (a.id === b.id) continue;
    const amount = BigInt(10 * (1 + Math.floor(rnd() * 200_000)));
    lines.push({ accountId: a.id, date, debitMilli: amount, creditMilli: 0n, closing: false, draft: false });
    lines.push({ accountId: b.id, date, debitMilli: 0n, creditMilli: amount, closing: false, draft: false });
  }
  // قيود إقفال سنة اختيارية بتاريخ نهاية السنة المالية (30 يونيو)
  for (const y of [2026, 2027]) {
    if (rnd() < 0.5) continue;
    const a = pick(RAND_CLOSING);
    const b = pick(RAND_CLOSING);
    if (a.id === b.id) continue;
    const amount = BigInt(10 * (1 + Math.floor(rnd() * 100_000)));
    const date = `${y}-06-30`;
    lines.push({ accountId: a.id, date, debitMilli: amount, creditMilli: 0n, closing: true, draft: false });
    lines.push({ accountId: b.id, date, debitMilli: 0n, creditMilli: amount, closing: true, draft: false });
  }
  return lines;
}

test('خاصي: موازين عشوائية متعددة السنوات بسنة مالية غير تقويمية — الأصول = الالتزامات + الملكية', () => {
  const asOfDates = ['2026-07-01', '2026-12-31', '2027-07-01', '2027-03-15', '2028-06-30'];
  for (let seed = 1; seed <= 120; seed++) {
    const lines = randomLedger(seed);
    const asOf = asOfDates[seed % asOfDates.length];
    const period = resolveReportPeriod({ mode: 'asOf', from: asOf, to: asOf }, FY_JUN);
    const balances = composeBalances({ period, accounts: RAND_ACC, lines });
    for (const drawings of [false, true]) {
      const bs = buildBalanceSheet({
        period, accounts: RAND_ACC, balances, roles: RAND_ROLES, settings: { drawingsAfterNetProfit: drawings },
      });
      const st = buildIncomeStatement({
        period, accounts: RAND_ACC, balances, roles: RAND_ROLES, settings: { drawingsAfterNetProfit: drawings },
      });
      const label = `seed=${seed} asOf=${asOf} drawings=${drawings}`;
      assert.equal(bs.imbalanceMilli, 0n, `الأصول ≠ الالتزامات + الملكية (${label})`);
      assert.equal(bs.equityInvariantMilli, 0n, `خرق ثابت حقوق الملكية (${label})`);
      assert.equal(currentYearEarningsGapMilli(bs, st), 0n, `نتيجة السنة ≠ صافي قائمة الدخل (${label})`);
      // D = FYStart تماماً: الفترة يوم واحد، والثوابت أعلاه تبقى متحققة (§7.4 الاختبار الخاصي)
      if (asOf === period.fyStart) assert.equal(period.from, period.to, label);
      // «خارج الميزانية لا يظهر في القوائم» (§4.1) — ولا يكسر التوازن رغم أرصدته
      for (const n of flattenBalanceSheet(bs)) {
        for (const r of n.node.accounts) assert.notEqual(r.type, 'off_balance', `${label} ${r.code}`);
      }
      for (const l of st.lines) {
        for (const r of l.accounts) assert.notEqual(r.type, 'off_balance', `${label} ${r.code}`);
      }
    }
  }
});

test('خاصي: خيار المسحوبات ينقل بين الأسطر ولا يغيّر إجمالي حقوق الملكية', () => {
  for (let seed = 200; seed <= 260; seed++) {
    const lines = randomLedger(seed);
    const period = resolveReportPeriod({ mode: 'asOf', from: '2027-11-20', to: '2027-11-20' }, FY_JUN);
    const balances = composeBalances({ period, accounts: RAND_ACC, lines });
    const on = buildBalanceSheet({
      period, accounts: RAND_ACC, balances, roles: RAND_ROLES, settings: { drawingsAfterNetProfit: true },
    });
    const off = buildBalanceSheet({
      period, accounts: RAND_ACC, balances, roles: RAND_ROLES, settings: { drawingsAfterNetProfit: false },
    });
    assert.equal(on.totalEquityMilli, off.totalEquityMilli, `إجمالي الملكية تغيّر (seed=${seed})`);
    assert.equal(on.totalAssetsMilli, off.totalAssetsMilli);
    assert.equal(on.totalLiabilitiesMilli, off.totalLiabilitiesMilli);
    const moved = balanceSheetAmount(on, 'capitalAndReserves') - balanceSheetAmount(off, 'capitalAndReserves');
    const intoEarnings = (on.currentYearEarningsMilli + on.previousYearsEarningsMilli)
      - (off.currentYearEarningsMilli + off.previousYearsEarningsMilli);
    assert.equal(moved + intoEarnings, 0n, `المنقول من رأس المال لا يساوي الداخل إلى الأرباح (seed=${seed})`);
  }
});

// ═══ 6) الحراس والمساعدات ═══

test('الميزانية ترفض فترة ليست «اعتباراً من» (from ≠ fyStart)', () => {
  const period = resolveReportPeriod({ mode: 'custom', from: '2026-03-01', to: '2026-12-31' }, FY_DEC);
  const balances = composeBalances({ period, accounts: GOLD_ACC, lines: GOLD_LINES });
  assert.throws(
    () => buildBalanceSheet({ period, accounts: GOLD_ACC, balances, roles: GOLD_ROLES }),
    /اعتباراً من/,
  );
});

test('رصيد لحساب خارج قائمة الحسابات خطأ برمجي في القائمتين', () => {
  const period = resolveReportPeriod({ mode: 'asOf', from: '2026-12-31', to: '2026-12-31' }, FY_DEC);
  const balances = composeBalances({ period, accounts: GOLD_ACC, lines: GOLD_LINES });
  const stray = [...balances, { accountId: 'ghost', openingMilli: 0n, debitMilli: 0n, creditMilli: 0n, closingMilli: 0n, closingOpeningMilli: 0n, preFyMilli: 0n }];
  assert.throws(() => buildIncomeStatement({ period, accounts: GOLD_ACC, balances: stray }), /غير معروف/);
  assert.throws(() => buildBalanceSheet({ period, accounts: GOLD_ACC, balances: stray }), /غير معروف/);
});

test('percentChangeMilli: نسبة المقارنة بمنزلتين وبلا قسمة على صفر (RPT‑04)', () => {
  assert.equal(percentChangeMilli(M('150.00'), M('100.00')), 50);
  assert.equal(percentChangeMilli(M('50.00'), M('100.00')), -50);
  assert.equal(percentChangeMilli(M('100.00'), -M('100.00')), 200);
  assert.equal(percentChangeMilli(M('100.00'), 0n), null);
});

test('toJsonMilli: كل حقل Milli نصّ عدد صحيح بالملّي والبنية كما هي', () => {
  const st = goldStatement({ from: '2026-01-01', to: '2026-12-31', drawings: true });
  const json = toJsonMilli(st);
  assert.equal(json.netProfitMilli, '104186330');
  assert.equal(json.netProfitAfterDrawingsMilli, '-3210340');
  assert.equal(json.lines[0].key, 'revenue');
  assert.equal(json.lines[0].amountMilli, '610001090');
  assert.equal(json.period.to, '2026-12-31');
  assert.equal(JSON.parse(JSON.stringify(json)).options.unit, 1);

  const bs = toJsonMilli(goldSheet('2026-12-31', true));
  assert.equal(bs.totalAssetsMilli, '542850610');
  assert.equal(bs.balanced, true);
  // الأصول ← الأصول المتداولة ← الحسابات البنكية والنقدية ← الصندوق
  assert.equal(bs.sections[0].children[0].children[0].key, 'assetCash');
  assert.equal(bs.sections[0].children[0].children[0].accounts[0].amountMilli, '247080390');
});

test('التسميات العربية: الخسائر التشغيلية حين يكون الدخل التشغيلي سالباً', () => {
  const profit = goldStatement({ from: '2026-01-01', to: '2026-12-31' });
  assert.equal(incomeStatementLine(profit, 'operatingIncome')?.label, 'الدخل التشغيلي');
  // فترة فيها مصروفات بلا إيراد
  const loss = goldStatement({ from: '2026-10-01', to: '2026-12-31' });
  assert.ok(amt(loss, 'operatingIncome') <= 0n);
  assert.equal(incomeStatementLine(loss, 'operatingIncome')?.label, 'الدخل التشغيلي');
  const forced = goldStatement({ from: '2026-03-20', to: '2026-03-31' });
  assert.equal(amt(forced, 'operatingIncome'), -M('306584.69'));
  assert.equal(incomeStatementLine(forced, 'operatingIncome')?.label, 'الخسائر التشغيلية');
});
