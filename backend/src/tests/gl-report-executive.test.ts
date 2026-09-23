// M4 — الملخّص التنفيذي ORPT‑09 (DESIGN.md §7.3 السطر الأخير، مع §7.1 و§7.4).
// بلا قاعدة بيانات: الدالّة صرفة تستقبل حسابات وأرصدة (§7.1)، وload.ts وحده يلمس prisma.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeBalances } from '../services/gl/reports/balances';
import { DEFAULT_FISCAL_YEAR, resolveReportPeriod } from '../services/gl/reports/period';
import type { BalanceLineRow, ReportAccount, ReportPeriod } from '../services/gl/reports/types';
import { buildIncomeStatement, incomeStatementAmount, toJsonMilli } from '../services/gl/reports/incomeStatement';
import {
  EXECUTIVE_CARD_ORDER, EXECUTIVE_MONEY_KEYS, EXECUTIVE_RATIO_DECIMALS, EXECUTIVE_RATIO_KEYS,
  buildExecutiveSummary, executiveAmount, executiveCard, executivePercent, executivePeriodDays,
  executiveRatio, executiveRatioOf, executiveSummaryLineCount, isExecutiveMoneyCard,
  type ExecutiveCardKey, type ExecutiveMoneyCard, type ExecutiveMoneyKey, type ExecutiveRatioCard,
  type ExecutiveRatioKey,
} from '../services/gl/reports/executive';
import { toMilli } from '../services/gl/money';

// ═══ أدوات ═══

const FY = DEFAULT_FISCAL_YEAR;

/** مبلغ بمنازل الريال ⇐ ملّي (بلا float). */
const M = (s: string): bigint => toMilli(s, 2);

const acc = (id: string, code: string, name: string, type: ReportAccount['type']): ReportAccount =>
  ({ id, code, name, nameI18n: null, type });

interface Leg { id: string; d?: string; c?: string }

/** قيد متوازن: يفشل الاختبار فوراً إن لم يتساوَ المدين والدائن (I1). */
function entry(date: string, legs: Leg[]): BalanceLineRow[] {
  let dr = 0n;
  let cr = 0n;
  const rows = legs.map((l) => {
    const debitMilli = l.d ? M(l.d) : 0n;
    const creditMilli = l.c ? M(l.c) : 0n;
    dr += debitMilli;
    cr += creditMilli;
    return { accountId: l.id, date, debitMilli, creditMilli, closing: false, draft: false };
  });
  assert.equal(dr, cr, `قيد غير متوازن في المتجه بتاريخ ${date}`);
  return rows;
}

const ACCOUNTS: ReportAccount[] = [
  acc('cash', '111001', 'الصندوق الرئيسي', 'asset_cash'),
  acc('ar', '113001', 'ذمم العملاء', 'asset_receivable'),
  acc('prep', '114001', 'مصروفات مدفوعة مقدماً', 'asset_prepayments'),
  acc('ap', '211001', 'ذمم الموردين', 'liability_payable'),
  acc('accr', '211501', 'مصروفات مستحقة', 'liability_current'),
  acc('cap', '311001', 'رأس المال', 'equity'),
  acc('sales', '411001', 'المبيعات', 'income'),
  acc('cogs', '512001', 'المشتريات', 'expense_direct_cost'),
  acc('opex', '521001', 'مصروفات عمومية وإدارية', 'expense'),
];

/**
 * متجه محسوب يدوياً — الربع الأول 2026 (90 يوماً: 31 + 28 + 31):
 *   الإيراد 200,000.00 | تكلفة الإيرادات 80,000.00 | إجمالي الربح 120,000.00
 *   نفقات التشغيل 23,000.00 | صافي الربح 97,000.00
 *   النقد 165,000.00 = 100,000 + 120,000 − 30,000 − 20,000 − 5,000
 *   صافي حركة النقد 65,000.00 | الذمم 80,000.00 | الموردون 50,000.00 | المقدمة 5,000.00
 *   الأصول المتداولة 250,000.00 | الالتزامات المتداولة 53,000.00
 */
const LINES: BalanceLineRow[] = [
  // رأس المال نقداً قبل الفترة (السنة المالية السابقة)
  ...entry('2025-12-15', [{ id: 'cash', d: '100000.00' }, { id: 'cap', c: '100000.00' }]),
  // مبيعات آجلة
  ...entry('2026-02-10', [{ id: 'ar', d: '200000.00' }, { id: 'sales', c: '200000.00' }]),
  // مشتريات آجلة (تكلفة الإيرادات — 512001 لا تُضاف مرة ثانية، §7.3 ACC‑26)
  ...entry('2026-02-15', [{ id: 'cogs', d: '80000.00' }, { id: 'ap', c: '80000.00' }]),
  // تحصيل من العملاء
  ...entry('2026-03-05', [{ id: 'cash', d: '120000.00' }, { id: 'ar', c: '120000.00' }]),
  // سداد للموردين
  ...entry('2026-03-10', [{ id: 'ap', d: '30000.00' }, { id: 'cash', c: '30000.00' }]),
  // مصروف تشغيلي نقداً
  ...entry('2026-03-20', [{ id: 'opex', d: '20000.00' }, { id: 'cash', c: '20000.00' }]),
  // دفعة مقدمة نقداً
  ...entry('2026-03-25', [{ id: 'prep', d: '5000.00' }, { id: 'cash', c: '5000.00' }]),
  // مصروف مستحق (التزام متداول)
  ...entry('2026-03-31', [{ id: 'opex', d: '3000.00' }, { id: 'accr', c: '3000.00' }]),
];

function periodOf(from: string, to: string): ReportPeriod {
  return resolveReportPeriod({ mode: 'custom', from, to }, FY);
}

function balancesFor(period: ReportPeriod, lines: readonly BalanceLineRow[] = LINES) {
  return composeBalances({ period, accounts: ACCOUNTS, lines });
}

const Q1 = periodOf('2026-01-01', '2026-03-31');
const Q4_2025 = periodOf('2025-10-01', '2025-12-31');

function summaryQ1(withComparison = false) {
  return buildExecutiveSummary({
    period: Q1,
    accounts: ACCOUNTS,
    balances: balancesFor(Q1),
    comparisons: withComparison ? [{ period: Q4_2025, balances: balancesFor(Q4_2025) }] : [],
  });
}

function moneyCard(summary: ReturnType<typeof summaryQ1>, key: ExecutiveMoneyKey): ExecutiveMoneyCard {
  const card = executiveCard(summary, key);
  assert.ok(card !== undefined && isExecutiveMoneyCard(card), `بطاقة مال مفقودة: ${key}`);
  return card;
}

function ratioCard(summary: ReturnType<typeof summaryQ1>, key: ExecutiveRatioKey): ExecutiveRatioCard {
  const card = executiveCard(summary, key);
  assert.ok(card !== undefined && !isExecutiveMoneyCard(card), `بطاقة نسبة مفقودة: ${key}`);
  return card;
}

// ═══ 1) الهيكل وعقد المبالغ ═══

test('ORPT‑09: البطاقات الاثنتا عشرة بترتيب §7.3 وكل مبلغ bigint بالملّي', () => {
  const s = summaryQ1();
  assert.equal(s.reportKey, 'executive-summary');
  assert.deepEqual(s.cards.map((c) => c.key), [...EXECUTIVE_CARD_ORDER]);
  assert.equal(executiveSummaryLineCount(s), EXECUTIVE_CARD_ORDER.length);
  assert.equal(
    EXECUTIVE_CARD_ORDER.length,
    EXECUTIVE_MONEY_KEYS.length + EXECUTIVE_RATIO_KEYS.length,
    'كل مفتاح معرَّف له بطاقة واحدة لا أكثر',
  );

  for (const card of s.cards) {
    assert.ok(card.label.length > 0, `بطاقة بلا تسمية عربية: ${card.key}`);
    assert.ok(card.formula.length > 0, `بطاقة بلا معادلة (RPT‑12): ${card.key}`);
    if (isExecutiveMoneyCard(card)) {
      assert.equal(typeof card.amountMilli, 'bigint', `مبلغ ليس ملّي: ${card.key}`);
    } else {
      assert.equal(card.decimals, EXECUTIVE_RATIO_DECIMALS);
      assert.equal(typeof card.value, 'number');
    }
  }

  // عقد المبالغ الموحَّد: كل مفتاح ينتهي بـMilli يخرج نصّ عدد صحيح (بلا تنسيق ولا وحدة عرض)
  const json = toJsonMilli(s) as unknown as { cards: Record<string, unknown>[] };
  const revenue = json.cards.find((c) => c.key === 'revenue');
  assert.ok(revenue);
  assert.equal(revenue.amountMilli, '200000000');
  assert.ok(!String(revenue.amountMilli).includes('.'), 'لا فواصل عشرية في مبلغ الملّي');
  // `unit` يبقى خياراً تقرؤه الواجهة ولا يُطبَّق على المبالغ (RPT‑06)
  assert.equal(s.options.unit, 1);
  assert.equal(s.options.ratioDecimals, EXECUTIVE_RATIO_DECIMALS);
});

test('أيام الفترة ضمناً: الربع الأول 2026 تسعون يوماً، ويوم واحد لفترة يوم', () => {
  assert.equal(executivePeriodDays(Q1), 90);
  assert.equal(summaryQ1().days, 90);
  assert.equal(executivePeriodDays(periodOf('2026-02-10', '2026-02-10')), 1);
  assert.equal(executivePeriodDays(Q4_2025), 92);
});

// ═══ 2) المبالغ على المتجه المحسوب يدوياً ═══

test('مبالغ البطاقات على المتجه اليدوي (§7.3، §7.4)', () => {
  const s = summaryQ1();
  assert.equal(executiveAmount(s, 'revenue'), M('200000.00'));
  assert.equal(executiveAmount(s, 'grossProfit'), M('120000.00'));
  assert.equal(executiveAmount(s, 'netProfit'), M('97000.00'));
  assert.equal(executiveAmount(s, 'cash'), M('165000.00'));
  assert.equal(executiveAmount(s, 'receivable'), M('80000.00'));
  assert.equal(executiveAmount(s, 'payable'), M('50000.00'), 'الموردون بإشارة العرض (دائن موجب)');
  assert.equal(executiveAmount(s, 'netCashFlow'), M('65000.00'));

  assert.equal(s.current.figures.costOfRevenueMilli, M('80000.00'));
  assert.equal(s.current.figures.currentAssetsMilli, M('250000.00'));
  assert.equal(s.current.figures.currentLiabilitiesMilli, M('53000.00'));
});

// ═══ 3) النِّسب: DSO وDPO والنسبة الجارية والهوامش ═══

test('DSO وDPO بالصيغة المختارة على مثال محسوب يدوياً (§7.3)', () => {
  const s = summaryQ1();

  // DSO = الذمم ÷ الإيراد × أيام الفترة = 80,000 ÷ 200,000 × 90 = 36.00 يوماً
  const dso = ratioCard(s, 'dso');
  assert.equal(dso.kind, 'days');
  assert.equal(dso.defined, true);
  assert.equal(dso.value, 36);

  // DPO = الموردون ÷ تكلفة الإيرادات × أيام الفترة = 50,000 ÷ 80,000 × 90 = 56.25 يوماً
  const dpo = ratioCard(s, 'dpo');
  assert.equal(dpo.kind, 'days');
  assert.equal(dpo.defined, true);
  assert.equal(dpo.value, 56.25);

  // المقام تكلفة الإيرادات وحدها (512001 داخلها أصلاً، ACC‑26) — لا الإيراد ولا نفقات التشغيل
  assert.notEqual(dpo.value, 22.5, 'لو قُسم على الإيراد لكان 22.5');
});

test('النسبة الجارية = الأصول المتداولة ÷ الالتزامات المتداولة (§7.4)', () => {
  const s = summaryQ1();
  const cr = ratioCard(s, 'currentRatio');
  assert.equal(cr.kind, 'ratio');
  assert.equal(cr.defined, true);
  // 250,000.00 ÷ 53,000.00 = 4.716981… ⇐ 4.72 بمنزلتين (تقريب نصف-لأعلى)
  assert.equal(cr.value, 4.72);
  assert.equal(executiveRatioOf(s, 'currentRatio').value, 4.72);
});

test('الهوامش: 60.00٪ إجمالي و48.50٪ صافي على المتجه اليدوي', () => {
  const s = summaryQ1();
  const gross = ratioCard(s, 'grossMargin');
  const net = ratioCard(s, 'netMargin');
  assert.equal(gross.kind, 'percent');
  assert.equal(gross.value, 60);
  assert.equal(gross.defined, true);
  assert.equal(net.value, 48.5);
  assert.equal(net.defined, true);
});

// ═══ 4) لا قسمة على صفر ═══

test('الإيراد صفر ⇒ الهوامش صفر وغير معرَّفة، ولا قسمة على صفر', () => {
  const period = periodOf('2026-01-01', '2026-03-31');
  const lines: BalanceLineRow[] = [
    ...entry('2025-12-15', [{ id: 'cash', d: '100000.00' }, { id: 'cap', c: '100000.00' }]),
    // مصروف تشغيلي بلا أي مبيعات: خسارة على إيراد صفر
    ...entry('2026-02-01', [{ id: 'opex', d: '9000.00' }, { id: 'cash', c: '9000.00' }]),
    // ذمم مدينة من رصيد مستورد (بلا إيراد في الفترة)
    ...entry('2026-02-02', [{ id: 'ar', d: '4000.00' }, { id: 'cap', c: '4000.00' }]),
  ];
  const s = buildExecutiveSummary({ period, accounts: ACCOUNTS, balances: balancesFor(period, lines) });

  assert.equal(executiveAmount(s, 'revenue'), 0n);
  assert.equal(executiveAmount(s, 'netProfit'), M('-9000.00'));

  for (const key of ['grossMargin', 'netMargin', 'dso'] as const) {
    const card = ratioCard(s, key);
    assert.equal(card.value, 0, `${key}: القيمة صفر حين المقام صفر`);
    assert.equal(card.defined, false, `${key}: صفرٌ «غير معرَّف» لا هامش حقيقي`);
    assert.ok(Number.isFinite(card.value), `${key}: لا Infinity ولا NaN`);
  }
  // تكلفة الإيرادات صفر ⇒ DPO غير معرَّفة كذلك
  assert.deepEqual(
    { value: ratioCard(s, 'dpo').value, defined: ratioCard(s, 'dpo').defined },
    { value: 0, defined: false },
  );
  // التزامات متداولة صفر ⇒ النسبة الجارية غير معرَّفة (لا Infinity)
  assert.equal(s.current.figures.currentLiabilitiesMilli, 0n);
  assert.equal(ratioCard(s, 'currentRatio').defined, false);
  assert.equal(ratioCard(s, 'currentRatio').value, 0);
});

test('executiveRatio/executivePercent: قسمة صحيحة بتقريب نصف-لأعلى بعيداً عن الصفر', () => {
  assert.deepEqual(executiveRatio(1n, 3n), { value: 0.33, defined: true });
  assert.deepEqual(executiveRatio(2n, 3n), { value: 0.67, defined: true });
  assert.deepEqual(executiveRatio(-2n, 3n), { value: -0.67, defined: true });
  assert.deepEqual(executiveRatio(5n, 0n), { value: 0, defined: false });
  // 201 ÷ 20,000 × 100 = 1.005 بالضبط ⇐ 1.01 (نصف-لأعلى، لا 1.00)
  assert.deepEqual(executivePercent(201n, 20_000n), { value: 1.01, defined: true });
  assert.deepEqual(executivePercent(-201n, 20_000n), { value: -1.01, defined: true });
  // هامش سالب على إيراد موجب: خسارة 25٪
  assert.deepEqual(executivePercent(M('-2500.00'), M('10000.00')), { value: -25, defined: true });
});

// ═══ 5) الاتّساق مع قائمة الدخل على المدخلات نفسها ═══

test('«الإيراد» و«صافي الربح» مطابقان لقائمة الدخل على المدخلات نفسها (§7.3)', () => {
  const balances = balancesFor(Q1);
  const statement = buildIncomeStatement({ period: Q1, accounts: ACCOUNTS, balances });
  const s = buildExecutiveSummary({ period: Q1, accounts: ACCOUNTS, balances });

  assert.equal(executiveAmount(s, 'revenue'), incomeStatementAmount(statement, 'revenue'));
  assert.equal(executiveAmount(s, 'grossProfit'), incomeStatementAmount(statement, 'grossProfit'));
  assert.equal(executiveAmount(s, 'netProfit'), statement.netProfitMilli);
  assert.equal(s.current.figures.costOfRevenueMilli, incomeStatementAmount(statement, 'costOfRevenue'));

  // قائمة دخل مبنيّة سلفاً (كما يمرّرها المسار) تعطي النتيجة نفسها بلا إعادة بناء
  const reused = buildExecutiveSummary({ period: Q1, accounts: ACCOUNTS, balances, statement });
  assert.deepEqual(toJsonMilli(reused), toJsonMilli(s));
});

test('الاتّساق محفوظ مع الخيارات: الإهلاك والمسحوبات لا يزيحان الإيراد ولا صافي الربح', () => {
  const balances = balancesFor(Q1);
  const settings = { drawingsAfterNetProfit: true, depreciationInOperatingExpenses: true };
  const statement = buildIncomeStatement({ period: Q1, accounts: ACCOUNTS, balances, settings });
  const s = buildExecutiveSummary({ period: Q1, accounts: ACCOUNTS, balances, settings });
  assert.equal(executiveAmount(s, 'revenue'), incomeStatementAmount(statement, 'revenue'));
  assert.equal(executiveAmount(s, 'netProfit'), statement.netProfitMilli);
  // §7.3: البطاقة «صافي الربح» لا «المتبقي بعد المسحوبات»
  assert.equal(executiveAmount(s, 'netProfit'), M('97000.00'));
});

// ═══ 6) المقارنة (RPT‑04) ═══

test('المقارنة بالفترة السابقة: previousMilli وchangeMilli وchangePct', () => {
  const s = summaryQ1(true);
  assert.equal(s.comparison.length, 1);
  assert.equal(s.options.comparisonCount, 1);
  assert.equal(s.comparison[0].figures.period.to, '2025-12-31');
  assert.equal(s.comparison[0].figures.days, 92);

  const cash = moneyCard(s, 'cash');
  assert.equal(cash.previousMilli, M('100000.00'));
  assert.equal(cash.changeMilli, M('65000.00'));
  assert.equal(cash.changePct, 65);

  const flow = moneyCard(s, 'netCashFlow');
  assert.equal(flow.previousMilli, M('100000.00'));
  assert.equal(flow.changeMilli, M('-35000.00'));
  assert.equal(flow.changePct, -35);

  // الفترة المقارَنة صفر ⇒ لا نسبة تغيّر (RPT‑04)، والفرق يبقى مبلغاً صريحاً
  const revenue = moneyCard(s, 'revenue');
  assert.equal(revenue.previousMilli, 0n);
  assert.equal(revenue.changeMilli, M('200000.00'));
  assert.equal(revenue.changePct, null);

  // نسب الفترة المقارَنة: إيرادها صفر ⇒ غير معرَّفة، فلا فرق بالنقاط
  const dso = ratioCard(s, 'dso');
  assert.equal(dso.previousDefined, false);
  assert.equal(dso.changeValue, null);
});

test('بلا مقارنة: كل حقول المقارنة null والأعمدة فارغة', () => {
  const s = summaryQ1();
  assert.deepEqual(s.comparison, []);
  for (const card of s.cards) {
    if (isExecutiveMoneyCard(card)) {
      assert.equal(card.previousMilli, null, `${card.key}: لا فترة سابقة`);
      assert.equal(card.changeMilli, null);
      assert.equal(card.changePct, null);
    } else {
      assert.equal(card.previousValue, null, `${card.key}: لا فترة سابقة`);
      assert.equal(card.previousDefined, false);
      assert.equal(card.changeValue, null);
    }
  }
});

test('فرق النِّسب بالنقاط حين تكون الفترتان معرَّفتين', () => {
  const prev = periodOf('2025-10-01', '2025-12-31');
  const lines: BalanceLineRow[] = [
    ...entry('2025-11-01', [{ id: 'ar', d: '50000.00' }, { id: 'sales', c: '50000.00' }]),
    ...entry('2025-11-02', [{ id: 'cogs', d: '30000.00' }, { id: 'ap', c: '30000.00' }]),
    ...LINES,
  ];
  const s = buildExecutiveSummary({
    period: Q1,
    accounts: ACCOUNTS,
    balances: balancesFor(Q1, lines),
    comparisons: [{ period: prev, balances: balancesFor(prev, lines) }],
  });
  const gross = ratioCard(s, 'grossMargin');
  // السابقة: (50,000 − 30,000) ÷ 50,000 = 40.00٪
  assert.equal(gross.previousValue, 40);
  assert.equal(gross.previousDefined, true);
  // الحالية: الإيراد 200,000 والتكلفة 80,000 ⇒ 60.00٪ (بيع نوفمبر خارج الربع الأول)
  assert.equal(gross.value, 60);
  assert.equal(gross.changeValue, 20);
});

// ═══ 7) الحراس البرمجية ═══

test('حارس: رصيد لحساب غير معروف، وقائمة دخل لفترة أخرى', () => {
  const balances = balancesFor(Q1);
  assert.throws(
    () => buildExecutiveSummary({
      period: Q1,
      accounts: ACCOUNTS,
      balances: [...balances, {
        accountId: 'ghost',
        openingMilli: 0n,
        debitMilli: M('10.00'),
        creditMilli: 0n,
        closingMilli: 0n,
        closingOpeningMilli: 0n,
        preFyMilli: 0n,
      }],
    }),
    /حساب غير معروف/,
  );

  const other = periodOf('2026-01-01', '2026-02-28');
  const statement = buildIncomeStatement({ period: other, accounts: ACCOUNTS, balances: balancesFor(other) });
  assert.throws(
    () => buildExecutiveSummary({ period: Q1, accounts: ACCOUNTS, balances, statement }),
    /لفترة أخرى/,
  );
});

test('حتمية: البناء مرتين على المدخلات نفسها يعطي الردّ نفسه حرفياً', () => {
  const a = toJsonMilli(summaryQ1(true));
  const b = toJsonMilli(summaryQ1(true));
  assert.deepEqual(a, b);
  // مفاتيح البطاقات فريدة (لا تكرار في الترتيب)
  const keys = summaryQ1().cards.map((c) => c.key as ExecutiveCardKey);
  assert.equal(new Set(keys).size, keys.length);
});
