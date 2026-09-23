import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  balanceSheetCheck, balanceSheetDisplayRows, balanceSheetTable, hasPeriodMovement, incomeLineFormulas,
  incomeStatementDisplayRows, incomeStatementTable, isZeroMilli, statementColumns, statementNodes,
  type BalanceSheetNodeRow, type BalanceSheetResponse, type IncomeStatementResponse, type IncomeStatementRow,
  type ReportSettingsInfo, type StatementAccountRow, type StatementRowsContext,
} from './statementLines';
import type { ReportNode } from './ReportView';

/**
 * أسطر القائمتين (§7.3، §7.4): الترتيب والعمق وإبراز المجاميع وقاعدة RPT‑14 والمعادلة والتوازن.
 * `tr` هنا هوية (العربية)، فما تفحصه الاختبارات هو الجدول المحلّي لا ترجمته.
 */
const tr = (ar: string): string => ar;
const base = { tr, lang: 'ar' };

const acc = (o: Partial<StatementAccountRow> & { accountId: string }): StatementAccountRow => ({
  code: o.accountId, name: `حساب ${o.accountId}`, type: 'expense', amountMilli: '0',
  debitMilli: '0', creditMilli: '0', ...o,
});

const line = (o: Partial<IncomeStatementRow> & { key: string }): IncomeStatementRow => ({
  label: `خادم:${o.key}`, amountMilli: '0', total: false, accounts: [], groups: [], ...o,
});

// ═══ قائمة الدخل ═══

test('قائمة الدخل: السطر ثم حساباته ثم سطره الفرعي بحساباته، بأعماق 0 و1 و2', () => {
  const rows = incomeStatementDisplayRows([
    line({
      key: 'operatingExpenses',
      amountMilli: '5000',
      accounts: [acc({ accountId: 'a1', amountMilli: '3000', debitMilli: '3000' })],
      groups: [{
        key: 'depreciation',
        label: 'خادم:الإهلاك',
        amountMilli: '2000',
        accounts: [acc({ accountId: 'a2', amountMilli: '2000', debitMilli: '2000' })],
      }],
    }),
  ], { ...base, depreciationInOperatingExpenses: true });

  assert.deepEqual(rows.map(r => [r.kind, r.depth, r.key]), [
    ['line', 0, 'operatingExpenses'],
    ['account', 1, 'a1'],
    ['group', 1, 'operatingExpenses/depreciation'],
    ['account', 2, 'a2'],
  ]);
  // التسمية من الجدول المحلّي لا من نصّ الخادم (§8.7)
  assert.equal(rows[0].label, 'نفقات التشغيل');
  assert.equal(rows[2].label, 'الإهلاك');
  assert.equal(rows[1].label, 'حساب a1');
  assert.equal(rows[1].code, 'a1');
  // معرّفات الصفوف فريدة (مفاتيح React)
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
});

test('RPT‑14: حساب بلا حركة في الفترة يختفي، ويظهر مع «إظهار الصفري»', () => {
  const rows: IncomeStatementRow[] = [line({
    key: 'revenue',
    accounts: [
      acc({ accountId: 'moved', amountMilli: '100', debitMilli: '0', creditMilli: '100' }),
      acc({ accountId: 'still', amountMilli: '0', debitMilli: '0', creditMilli: '0' }),
    ],
  })];
  assert.deepEqual(
    incomeStatementDisplayRows(rows, base).filter(r => r.kind === 'account').map(r => r.key),
    ['moved'],
  );
  assert.deepEqual(
    incomeStatementDisplayRows(rows, { ...base, showAccountsWithoutMovement: true })
      .filter(r => r.kind === 'account').map(r => r.key),
    ['moved', 'still'],
  );
  // حركة مدينة وحدها تكفي، والمبلغ المعروض صفراً لا يخفي الحساب
  assert.equal(hasPeriodMovement(acc({ accountId: 'x', debitMilli: '50', creditMilli: '50' })), true);
  // صفّ بلا عمودَي الفترة (صفّ ميزانية) لا تخفيه القاعدة
  assert.equal(hasPeriodMovement({ accountId: 'b', code: '1', name: 'n', type: 'asset_cash', amountMilli: '0' }), true);
});

test('أسطر المجاميع الخمسة تُوسم total ولو أغفل الخادم الوسم، وغيرها لا يُوسم', () => {
  const keys = ['revenue', 'grossProfit', 'operatingIncome', 'profitBeforeZakat', 'netProfit', 'netProfitAfterDrawings', 'zakat'];
  const rows = incomeStatementDisplayRows(keys.map(k => line({ key: k, total: false })), base);
  assert.deepEqual(rows.filter(r => r.total).map(r => r.key), [
    'grossProfit', 'operatingIncome', 'profitBeforeZakat', 'netProfit', 'netProfitAfterDrawings',
  ]);
});

test('«الدخل التشغيلي» يصير «الخسائر التشغيلية» حين يكون سالباً (§7.3)', () => {
  const neg = incomeStatementDisplayRows([line({ key: 'operatingIncome', amountMilli: '-1' })], base);
  assert.equal(neg[0].label, 'الخسائر التشغيلية');
  const pos = incomeStatementDisplayRows([line({ key: 'operatingIncome', amountMilli: '0' })], base);
  assert.equal(pos[0].label, 'الدخل التشغيلي');
});

test('المعادلة (RPT‑12): الجدول المحلّي يتبع خيار الإهلاك، والمفتاح المجهول يأخذ نصّ الخادم', () => {
  const off = incomeLineFormulas(tr);
  const on = incomeLineFormulas(tr, { depreciationInOperatingExpenses: true });
  assert.equal(off.operatingExpenses, 'Σ حسابات نفقات التشغيل');
  assert.equal(on.operatingExpenses, 'Σ حسابات نفقات التشغيل + Σ حسابات الإهلاك');
  assert.equal(off.otherExpenses, 'Σ حسابات الإهلاك + Σ حسابات المصروفات الأخرى');
  assert.equal(on.otherExpenses, 'Σ حسابات المصروفات الأخرى');

  const rows = incomeStatementDisplayRows(
    [line({ key: 'futureLine', label: 'سطر جديد', formula: 'معادلة الخادم' }), line({ key: 'netProfit' })],
    base,
  );
  assert.equal(rows[0].label, 'سطر جديد');
  assert.equal(rows[0].formula, 'معادلة الخادم');
  assert.equal(rows[1].formula, 'صافي الربح قبل الزكاة − الزكاة وضريبة الدخل');
  // صفّ الحساب بلا معادلة
  assert.equal(
    incomeStatementDisplayRows([line({ key: 'revenue', accounts: [acc({ accountId: 'a', debitMilli: '1' })] })], base)[1].formula,
    null,
  );
});

// ═══ الميزانية ═══

const node = (o: Partial<BalanceSheetNodeRow> & { key: string }): BalanceSheetNodeRow => ({
  label: `خادم:${o.key}`, amountMilli: '0', total: false, accounts: [], children: [], ...o,
});

test('الميزانية: العقدة ثم حساباتها ثم أبناؤها، وسطر الالتزامات + حقوق الملكية آخراً', () => {
  const rows = balanceSheetDisplayRows(
    [
      node({
        key: 'assets',
        amountMilli: '105000',
        children: [node({
          key: 'currentAssets',
          children: [node({ key: 'assetCash', accounts: [acc({ accountId: 'c1', amountMilli: '105000' })] })],
        })],
      }),
      node({ key: 'equity', amountMilli: '105000' }),
    ],
    node({ key: 'liabilitiesAndEquity', amountMilli: '105000', total: true }),
    base,
  );
  assert.deepEqual(rows.map(r => [r.depth, r.key]), [
    [0, 'assets'], [1, 'currentAssets'], [2, 'assetCash'], [3, 'c1'], [0, 'equity'], [0, 'liabilitiesAndEquity'],
  ]);
  // مفاتيح المجاميع في §7.4 تشمل «الأصول المتداولة» — ووسم الخادم الغائب لا يُسقط الإبراز
  assert.deepEqual(rows.filter(r => r.total).map(r => r.key), ['assets', 'currentAssets', 'equity', 'liabilitiesAndEquity']);
  assert.equal(rows.find(r => r.key === 'assetCash')?.total, false);
  assert.equal(rows[2].label, 'الحسابات البنكية والنقدية');
  assert.equal(rows[5].label, 'الالتزامات + حقوق الملكية');
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
});

test('معادلة الميزانية تتبع خيار المسحوبات، والمفتاح المجهول يأخذ تسمية الخادم ومعادلته', () => {
  const [off] = balanceSheetDisplayRows([node({ key: 'capitalAndReserves' })], null, base);
  assert.equal(off.formula, '−Σ حقوق الملكية حتى التاريخ، دون الأرباح المبقاة');
  const [on] = balanceSheetDisplayRows([node({ key: 'capitalAndReserves' })], null, { ...base, drawingsAfterNetProfit: true });
  assert.equal(on.formula, '−Σ حقوق الملكية حتى التاريخ، دون الأرباح المبقاة ودون حسابات المسحوبات');
  const [odd] = balanceSheetDisplayRows([node({ key: 'newRow', label: 'سطر', formula: 'من الخادم' })], null, base);
  assert.deepEqual([odd.label, odd.formula], ['سطر', 'من الخادم']);
});

test('التوازن يُحسب من المجاميع لا من وسم الخادم — والوسم الكاذب لا يخفي الفرق', () => {
  const ok = balanceSheetCheck({
    totalAssetsMilli: '542850610', totalLiabilitiesMilli: '7315000', totalEquityMilli: '535535610',
    equityInvariantMilli: '0', balanced: true,
  });
  assert.deepEqual([ok.balanced, ok.imbalanceMilli, ok.invariantHolds], [true, '0', true]);

  const bad = balanceSheetCheck({
    totalAssetsMilli: '100000', totalLiabilitiesMilli: '40000', totalEquityMilli: '50000',
    equityInvariantMilli: '-5', balanced: true,
  });
  assert.deepEqual([bad.balanced, bad.imbalanceMilli, bad.invariantHolds], [false, '10000', false]);

  // مبالغ فوق حدود Number الآمنة: الحساب بـBigInt فلا يضيع ملّي واحد
  const huge = balanceSheetCheck({
    totalAssetsMilli: '9007199254740993', totalLiabilitiesMilli: '9007199254740992', totalEquityMilli: '0',
  });
  assert.equal(huge.imbalanceMilli, '1');
  assert.equal(huge.balanced, false);

  // ردّ مشوّه أو ناقص لا يرمي
  assert.equal(balanceSheetCheck(null).balanced, true);
  assert.equal(balanceSheetCheck({ totalAssetsMilli: 'abc' }).imbalanceMilli, '0');
  assert.equal(isZeroMilli('abc'), true);
  assert.equal(isZeroMilli('-0'), true);
  assert.equal(isZeroMilli(' -12 '), false);
});

// ═══ جدول القشرة المشتركة (ReportView) ═══

const viewCtx: StatementRowsContext = { tr, lang: 'ar', unit: 1 };

const settings: ReportSettingsInfo = {
  currency: 'SAR', currencyDecimals: 2, timezone: 'Asia/Riyadh', fiscalYearEnd: { month: 12, day: 31 },
  drawingsAfterNetProfit: false, depreciationInOperatingExpenses: false, configured: true,
};

const period = { from: '2026-01-01', to: '2026-03-31', fyStart: '2026-01-01' };

const isBody = (rows: IncomeStatementRow[], over: Partial<IncomeStatementResponse> = {}): IncomeStatementResponse => ({
  reportKey: 'income-statement',
  period,
  dateFilter: { mode: 'fiscalYear', from: period.from, to: period.to },
  settings,
  mode: 'AGGREGATE',
  rows,
  totals: { netProfitMilli: '0', drawingsMilli: '0', netProfitAfterDrawingsMilli: '0' },
  comparison: null,
  lineCount: rows.length,
  warnings: [],
  ...over,
});

const bsBody = (
  rows: BalanceSheetNodeRow[],
  totals: Partial<BalanceSheetResponse['totals']> = {},
): BalanceSheetResponse => ({
  reportKey: 'balance-sheet',
  asOf: period.to,
  period,
  dateFilter: { mode: 'asOf', from: period.to, to: period.to },
  settings,
  mode: 'AGGREGATE',
  rows,
  totals: {
    totalAssetsMilli: '0', totalLiabilitiesMilli: '0', totalEquityMilli: '0',
    currentYearEarningsMilli: '0', previousYearsEarningsMilli: '0',
    imbalanceMilli: '0', equityInvariantMilli: '0', balanced: true,
    totalLine: node({ key: 'liabilitiesAndEquity', amountMilli: '0', total: true }),
    ...totals,
  },
  comparison: null,
  lineCount: rows.length,
  warnings: [],
});

/** الشجرة مسطّحةً بعمقها — لفحص ما يبنيه statementNodes. */
const flat = (nodes: readonly ReportNode[], depth = 0): [number, string][] =>
  nodes.flatMap(n => [[depth, n.id] as [number, string], ...flat(n.children ?? [], depth + 1)]);

const find = (nodes: readonly ReportNode[], id: string): ReportNode | undefined => {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = find(n.children ?? [], id);
    if (hit) return hit;
  }
  return undefined;
};

test('statementNodes: العمق يصير تداخلاً، والمعادلة hint، والتعمّق على صفّ الحساب وحده', () => {
  const rows = incomeStatementDisplayRows([
    line({
      key: 'operatingExpenses',
      amountMilli: '5000',
      accounts: [acc({ accountId: 'a1', amountMilli: '3000', debitMilli: '3000' })],
      groups: [{
        key: 'depreciation',
        label: 'خادم:الإهلاك',
        amountMilli: '2000',
        accounts: [acc({ accountId: 'a2', amountMilli: '2000', debitMilli: '2000' })],
      }],
    }),
    line({ key: 'netProfit', amountMilli: '-5000' }),
  ], { ...base, depreciationInOperatingExpenses: true });

  const nodes = statementNodes(rows);
  assert.deepEqual(flat(nodes), [
    [0, 'line:operatingExpenses'],
    [1, 'line:operatingExpenses:a1'],
    [1, 'group:operatingExpenses/depreciation'],
    [2, 'group:operatingExpenses/depreciation:a2'],
    [0, 'line:netProfit'],
  ]);

  const [expenses, netProfit] = nodes;
  // RPT‑12: معادلة الجدول المحلّي تصير تلميح السطر
  assert.equal(expenses.hint, 'Σ حسابات نفقات التشغيل + Σ حسابات الإهلاك');
  // RPT‑11: مبلغ الحساب وحده يتعمّق — والسطر المجمَّع لا يدّعي حساباً
  assert.equal(expenses.accountId, null);
  assert.equal(expenses.children?.[0].accountId, 'a1');
  assert.equal(expenses.children?.[0].hint, null);
  // RPT‑13: المجاميع وحدها تُبرز وخانتها عريضة
  assert.equal(netProfit.emphasis, 'total');
  assert.equal(expenses.emphasis, 'normal');
  assert.deepEqual(netProfit.cells, [{ kind: 'amount', milli: '-5000', strong: true }]);
  assert.deepEqual(expenses.children?.[0].cells, [{ kind: 'amount', milli: '3000' }]);
  assert.equal(netProfit.labelHref, null);
});

test('statementNodes: صفٌّ بعمق بلا أبٍ مفتوح يلتحق بأقرب أبٍ موجود بدل أن يسقط', () => {
  const nodes = statementNodes([
    { id: 'a', kind: 'line', depth: 0, key: 'a', label: 'أ', code: null, amountMilli: '1', total: false, formula: null, accountId: null },
    { id: 'b', kind: 'account', depth: 3, key: 'b', label: 'ب', code: null, amountMilli: '2', total: false, formula: null, accountId: 'b' },
  ]);
  assert.deepEqual(flat(nodes), [[0, 'a'], [1, 'b']]);
});

test('عمود المبلغ الوحيد يحمل وسم وحدة العرض (RPT‑06)', () => {
  assert.deepEqual(statementColumns(viewCtx), [{ key: 'amount', label: 'المبلغ' }]);
  assert.equal(statementColumns({ ...viewCtx, unit: 1000 })[0].sub, 'بالآلاف');
  assert.equal(statementColumns({ ...viewCtx, unit: 1_000_000 })[0].sub, 'بالملايين');
});

test('incomeStatementTable: RPT‑14 من وسم الخادم يتقدّم على مبدّل الصفحة', () => {
  const rows = [line({
    key: 'revenue',
    accounts: [
      acc({ accountId: 'moved', amountMilli: '100', creditMilli: '100' }),
      acc({ accountId: 'still', amountMilli: '0' }),
    ],
  })];
  const accountsOf = (t: { nodes: readonly ReportNode[] }) => (t.nodes[0].children ?? []).map(n => n.accountId);

  assert.deepEqual(accountsOf(incomeStatementTable(isBody(rows), viewCtx)), ['moved']);
  assert.deepEqual(
    accountsOf(incomeStatementTable(isBody(rows), viewCtx, { showAccountsWithoutMovement: true })),
    ['moved', 'still'],
  );
  // ما يعيده الخادم في statementOptions هو الحَكَم: مبدّلٌ محليّ لا يزوّر ما جاء في الردّ
  const withFlag = isBody(rows, {
    statementOptions: {
      drawingsAfterNetProfit: false, depreciationInOperatingExpenses: false, showAccountsWithoutMovement: false,
      hideZero: false, unit: 1, hierarchy: false, search: '', searchFiltered: false,
    },
  });
  assert.deepEqual(accountsOf(incomeStatementTable(withFlag, viewCtx, { showAccountsWithoutMovement: true })), ['moved']);
  assert.equal(incomeStatementTable(isBody([]), viewCtx).emptyText, 'لا حركة في هذه الفترة');
});

test('balanceSheetTable: الإجمالي تذييلٌ لا يُطوى، ووسم الخرق أحمر حين لا تتوازن', () => {
  const rows = [
    node({ key: 'assets', amountMilli: '100000' }),
    node({ key: 'equity', amountMilli: '90000' }),
  ];
  const balanced = balanceSheetTable(bsBody(rows, {
    totalAssetsMilli: '100000', totalLiabilitiesMilli: '10000', totalEquityMilli: '90000',
    totalLine: node({ key: 'liabilitiesAndEquity', amountMilli: '100000', total: true }),
  }), viewCtx);
  assert.deepEqual(flat(balanced.nodes), [[0, 'node:/assets'], [0, 'node:/equity']]);
  assert.deepEqual(
    (balanced.footer ?? []).map(n => [n.id, n.emphasis, n.danger]),
    [['node:total/liabilitiesAndEquity', 'total', undefined]],
  );

  // وسمُ الخادم balanced كاذباً لا يخفي الفرق: الحساب من المجاميع نفسها (§7.4)
  const broken = balanceSheetTable(bsBody(rows, {
    totalAssetsMilli: '100000', totalLiabilitiesMilli: '10000', totalEquityMilli: '80000', balanced: true,
    totalLine: node({ key: 'liabilitiesAndEquity', amountMilli: '90000', total: true }),
  }), viewCtx);
  assert.equal((broken.footer ?? [])[0].danger, true);
  assert.equal(broken.emptyText, 'لا أرصدة حتى هذا التاريخ');
});

test('balanceSheetTable: «أرباح السنة الجارية» وحدها تسميةٌ رابطة إلى قائمة الدخل (§7.4)', () => {
  const href = '/app/ledger/reports/income-statement?mode=custom&from=2026-01-01&to=2026-03-31';
  const t = balanceSheetTable(
    bsBody([node({
      key: 'equity',
      children: [node({
        key: 'earnings',
        children: [
          node({ key: 'currentYearEarnings', amountMilli: '5000', accounts: [acc({ accountId: 'x', amountMilli: '5000' })] }),
          node({ key: 'previousYearsEarnings', amountMilli: '1000' }),
        ],
      })],
    })]),
    viewCtx,
    { incomeHref: href },
  );
  assert.equal(find(t.nodes, 'node:/equity/earnings/currentYearEarnings')?.labelHref, href);
  // الأسطر الأخرى وصفوف الحسابات بلا رابط تسمية
  assert.equal(find(t.nodes, 'node:/equity/earnings/previousYearsEarnings')?.labelHref, null);
  assert.equal(find(t.nodes, 'node:/equity/earnings/currentYearEarnings:x')?.labelHref, null);
  // بلا رابط ممرَّر لا يظهر رابط
  assert.equal(balanceSheetTable(bsBody([node({ key: 'currentYearEarnings' })]), viewCtx).nodes[0].labelHref, null);
});
