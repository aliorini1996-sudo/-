/**
 * الملخّص التنفيذي (ORPT‑09) — M4، DESIGN.md §7.3 (السطر الأخير) مع §7.1 و§7.4.
 *
 * **صرفة تماماً**: تستقبل ما تستقبله بقيّة تقارير §7 (حسابات + مخرَج `composeBalances` + الفترة
 * + الخيارات) وتُعيد بطاقات المؤشّرات، وتُختبر بلا قاعدة بيانات. القراءة كلّها في `reports/load.ts`.
 *
 * نصّ §7.3 حرفياً:
 * > الملخّص التنفيذي (ORPT‑09) لنفس الفترة مع المقارنة: الإيراد، إجمالي الربح وهامشه، صافي الربح
 * > وهامشه، النقد (Σ `asset_cash`)، الذمم، الموردون، DSO = الذمم ÷ الإيراد × أيام الفترة،
 * > DPO = الموردون ÷ تكلفة الإيرادات (Σ `expense_direct_cost`، وفيها المشتريات 512001 أصلاً فلا
 * > تُضاف مرة ثانية) × أيام الفترة، النسبة الجارية = الأصول المتداولة ÷ الالتزامات المتداولة،
 * > صافي حركة النقد.
 *
 * قواعد ملزِمة في هذا الملف:
 * - **لا هيكل محاسبي جديد**: الإيراد وتكلفة الإيرادات وإجمالي الربح وصافي الربح تُقرأ من
 *   `buildIncomeStatement` نفسها (§7.3)، فيستحيل أن تختلف بطاقة عن سطر القائمة على المدخلات نفسها.
 *   والأصول المتداولة والالتزامات المتداولة بتعريف §7.4 حرفياً عبر `fullBalanceMilli`.
 * - **كل مبلغ `bigint` بالملّي** تحت مفتاح ينتهي بـ`Milli` (§2.3، قرار عقد المبالغ الموحَّد). لا
 *   تنسيق ولا تقريب ولا وحدة عرض هنا: `unit` يُعاد في `options` وتقرؤه الواجهة (RPT‑06).
 * - **النِّسب أعداد عشرية بمنزلتين** (`decimals = 2`) محسوبة بقسمة صحيحة على BigInt ثم تقريب
 *   نصف-لأعلى بعيداً عن الصفر — القاعدة نفسها التي يستعملها `money.ts` للمال، فلا float في الطريق
 *   ولا انحراف. لماذا منزلتان؟ لأنها دقّة `percentChangeMilli` القائمة في المحرّك (RPT‑04)،
 *   وتكفي لبطاقة تُقرأ بلمحة: هامش 23.47٪، وDSO 41.25 يوماً، ونسبة جارية 1.85. والواجهة لا
 *   تُقرّب أكثر من ذلك لأنها لا تملك مقاماً تعيد به الحساب.
 * - **لا قسمة على صفر**: كل نسبة تحمل `defined`. حين يكون المقام صفراً تكون `value = 0`
 *   و`defined = false`، فالهوامش صفرٌ حين الإيراد صفر كما يفرض العقد، وتعرف الواجهة أنّ الصفر
 *   هنا «غير معرَّف» فترسم «—» بدل ادّعاء هامش.
 */
import { diffDays } from '../dates';
import type { AccountType, Milli } from '../types';
import { balanceIndex, periodNetMilli, zeroBalance } from './balances';
import { fullBalanceMilli } from './balanceSheet';
import {
  EMPTY_ACCOUNT_ROLES, buildIncomeStatement, incomeStatementAmount, percentChangeMilli, toJsonMilli,
  type IncomeStatement, type IncomeStatementSettings, type JsonMilli, type ReportAccountRoles,
} from './incomeStatement';
import type { AccountBalance, ReportAccount, ReportPeriod, ReportUnit } from './types';

export { toJsonMilli } from './incomeStatement';
export type { JsonMilli, ReportAccountRoles } from './incomeStatement';

// ═══ المفاتيح والترتيب (§7.3) ═══

/** بطاقات المال — كلّها `bigint` بالملّي. */
export const EXECUTIVE_MONEY_KEYS = [
  'revenue',
  'grossProfit',
  'netProfit',
  'cash',
  'receivable',
  'payable',
  'netCashFlow',
] as const;
export type ExecutiveMoneyKey = (typeof EXECUTIVE_MONEY_KEYS)[number];

/** بطاقات النِّسب — أعداد عشرية بمنزلتين مع `defined`. */
export const EXECUTIVE_RATIO_KEYS = ['grossMargin', 'netMargin', 'dso', 'dpo', 'currentRatio'] as const;
export type ExecutiveRatioKey = (typeof EXECUTIVE_RATIO_KEYS)[number];

export type ExecutiveCardKey = ExecutiveMoneyKey | ExecutiveRatioKey;

/** ترتيب البطاقات كما وردت في §7.3، وكل هامش يلي مبلغه. */
export const EXECUTIVE_CARD_ORDER: readonly ExecutiveCardKey[] = [
  'revenue',
  'grossProfit',
  'grossMargin',
  'netProfit',
  'netMargin',
  'cash',
  'receivable',
  'payable',
  'dso',
  'dpo',
  'currentRatio',
  'netCashFlow',
];

/** نوع عرض النسبة: نسبة مئوية، أيام، أو نسبة مجرّدة (لا لاحقة). */
export type ExecutiveRatioKind = 'percent' | 'days' | 'ratio';

const RATIO_KINDS: Readonly<Record<ExecutiveRatioKey, ExecutiveRatioKind>> = {
  grossMargin: 'percent',
  netMargin: 'percent',
  dso: 'days',
  dpo: 'days',
  currentRatio: 'ratio',
};

/** منازل كل النِّسب — واحدة لكل البطاقات (انظر ترويسة الملف). */
export const EXECUTIVE_RATIO_DECIMALS = 2;

// ═══ التسميات والمعادلات (RPT‑12) ═══

const LABELS: Readonly<Record<ExecutiveCardKey, string>> = {
  revenue: 'الإيراد',
  grossProfit: 'إجمالي الربح',
  grossMargin: 'هامش إجمالي الربح',
  netProfit: 'صافي الربح',
  netMargin: 'هامش صافي الربح',
  cash: 'النقد',
  receivable: 'الذمم المدينة',
  payable: 'الموردون',
  dso: 'متوسط فترة التحصيل (DSO)',
  dpo: 'متوسط فترة السداد (DPO)',
  currentRatio: 'النسبة الجارية',
  netCashFlow: 'صافي حركة النقد',
};

const FORMULAS: Readonly<Record<ExecutiveCardKey, string>> = {
  revenue: 'سطر «الإيرادات» في قائمة الدخل للفترة',
  grossProfit: 'الإيراد − تكلفة الإيرادات',
  grossMargin: 'إجمالي الربح ÷ الإيراد × 100',
  netProfit: 'سطر «صافي الربح» في قائمة الدخل للفترة',
  netMargin: 'صافي الربح ÷ الإيراد × 100',
  cash: 'Σ الحسابات البنكية والنقدية حتى نهاية الفترة',
  receivable: 'Σ حسابات المدينين حتى نهاية الفترة',
  payable: '−Σ حسابات الدائنين حتى نهاية الفترة',
  dso: 'الذمم المدينة ÷ الإيراد × أيام الفترة',
  dpo: 'الموردون ÷ تكلفة الإيرادات × أيام الفترة',
  currentRatio: 'الأصول المتداولة ÷ الالتزامات المتداولة',
  netCashFlow: 'Σ حركة الحسابات البنكية والنقدية في الفترة (مدين − دائن)',
};

// ═══ حساب النِّسب بلا float (§2.3) ═══

/** قيمة نسبة: صفر **وغير معرَّفة** حين يكون المقام صفراً، فلا قسمة على صفر ولا ادّعاء. */
export interface ExecutiveRatioValue {
  value: number;
  defined: boolean;
}

export const UNDEFINED_RATIO: ExecutiveRatioValue = { value: 0, defined: false };

const RATIO_SCALE = 100n; // منزلتان

/**
 * `numerator ÷ denominator` بمنزلتين، بقسمة صحيحة على BigInt وتقريب نصف-لأعلى بعيداً عن الصفر
 * (قاعدة `roundMilli` نفسها). المقام صفر ⇒ `{value: 0, defined: false}`.
 */
export function executiveRatio(numerator: Milli, denominator: Milli): ExecutiveRatioValue {
  if (denominator === 0n) return { ...UNDEFINED_RATIO };
  const negative = (numerator < 0n) !== (denominator < 0n);
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  // floor((2·a·scale + b) / (2·b)) = تقريب نصف-لأعلى لـ a·scale/b
  const scaled = (a * RATIO_SCALE * 2n + b) / (b * 2n);
  const value = Number(negative ? -scaled : scaled) / Number(RATIO_SCALE);
  return { value, defined: true };
}

/** نسبة مئوية: `numerator ÷ denominator × 100` بمنزلتين (الضرب قبل القسمة فلا يضيع كسر). */
export function executivePercent(numerator: Milli, denominator: Milli): ExecutiveRatioValue {
  return executiveRatio(numerator * 100n, denominator);
}

/** فرق نسبتين بمنزلتين (`null` حين إحداهما غير معرَّفة). */
function ratioDelta(current: ExecutiveRatioValue, previous: ExecutiveRatioValue | null): number | null {
  if (previous === null || !current.defined || !previous.defined) return null;
  return Math.round((current.value - previous.value) * Number(RATIO_SCALE)) / Number(RATIO_SCALE);
}

// ═══ الأرقام الخام لفترة واحدة ═══

/** مبالغ الفترة كما تدخل البطاقات — كلّها ملّي، ولا تنسيق فيها. */
export interface ExecutiveFigures {
  period: ReportPeriod;
  /** أيام الفترة ضمناً (`to − from + 1`) — مقام DSO/DPO الزمني */
  days: number;
  revenueMilli: Milli;
  costOfRevenueMilli: Milli;
  grossProfitMilli: Milli;
  netProfitMilli: Milli;
  cashMilli: Milli;
  receivableMilli: Milli;
  payableMilli: Milli;
  /** §7.4: النقد + المدينون + أصول متداولة أخرى + المدفوعات المقدمة */
  currentAssetsMilli: Milli;
  /** §7.4: −Σ(`liability_current` ∪ `liability_credit_card` ∪ `liability_payable`) */
  currentLiabilitiesMilli: Milli;
  netCashFlowMilli: Milli;
}

export type ExecutiveRatios = Readonly<Record<ExecutiveRatioKey, ExecutiveRatioValue>>;

/** عمود فترة كامل: أرقامه ونسبه. العمود الأساسي والمقارنة بالشكل نفسه. */
export interface ExecutiveColumn {
  figures: ExecutiveFigures;
  ratios: ExecutiveRatios;
}

/** عدد أيام الفترة ضمناً (§7.3: «أيام الفترة»). يوم واحد لفترة من يوم واحد. */
export function executivePeriodDays(period: ReportPeriod): number {
  return diffDays(period.from, period.to) + 1;
}

// ═══ البطاقات ═══

export interface ExecutiveMoneyCard {
  key: ExecutiveMoneyKey;
  kind: 'money';
  label: string;
  formula: string;
  amountMilli: Milli;
  /** الفترة المقارَنة الأقرب (`null` بلا مقارنة) */
  previousMilli: Milli | null;
  changeMilli: Milli | null;
  /** ٪ التغيّر بمنزلتين (`null` حين تكون الفترة المقارَنة صفراً) — RPT‑04 */
  changePct: number | null;
}

export interface ExecutiveRatioCard {
  key: ExecutiveRatioKey;
  kind: ExecutiveRatioKind;
  label: string;
  formula: string;
  decimals: number;
  value: number;
  defined: boolean;
  previousValue: number | null;
  previousDefined: boolean;
  /** الفرق بالنقاط (لا بالنسبة المئوية) — `null` حين تكون إحدى القيمتين غير معرَّفة */
  changeValue: number | null;
}

export type ExecutiveCard = ExecutiveMoneyCard | ExecutiveRatioCard;

export function isExecutiveMoneyCard(card: ExecutiveCard): card is ExecutiveMoneyCard {
  return card.kind === 'money';
}

// ═══ المدخل والمخرَج ═══

export interface ExecutiveSummaryOptions {
  /** RPT‑06: يُعاد كما هو ولا يُطبَّق على المبالغ */
  unit: ReportUnit;
  /** منازل كل النِّسب في هذا الردّ */
  ratioDecimals: number;
  /** عدد أعمدة المقارنة المحسوبة */
  comparisonCount: number;
}

export interface ExecutiveSummary {
  reportKey: 'executive-summary';
  period: ReportPeriod;
  days: number;
  /** البطاقات بترتيب §7.3 */
  cards: ExecutiveCard[];
  /** أرقام الفترة الأساسية ونسبها (مصدر البطاقات، للتصدير والتعمّق) */
  current: ExecutiveColumn;
  /** أعمدة المقارنة، **الأقرب أولاً**؛ الأول هو مصدر `previous*` في البطاقات */
  comparison: ExecutiveColumn[];
  options: ExecutiveSummaryOptions;
}

/** عمود مقارنة كما يمرّره المسار (نفس شكل `StatementPeriodBalances`). */
export interface ExecutivePeriodBalances {
  period: ReportPeriod;
  balances: readonly AccountBalance[];
}

export interface ExecutiveSummaryInput {
  period: ReportPeriod;
  /** حسابات الشركة كاملةً (المصدر نفسه الذي مرّ على `composeBalances`) */
  accounts: readonly ReportAccount[];
  /** مخرَج `composeBalances` للفترة نفسها */
  balances: readonly AccountBalance[];
  roles?: ReportAccountRoles;
  settings?: IncomeStatementSettings;
  /**
   * قائمة دخل مبنيّة سلفاً للفترة نفسها (يمرّرها المسار فلا تُبنى مرتين).
   * فترتها لا بد أن تطابق `period` وإلا فهو خطأ برمجي.
   */
  statement?: IncomeStatement;
  /** أعمدة المقارنة، الأقرب أولاً (فارغة بلا مقارنة) — RPT‑04 */
  comparisons?: readonly ExecutivePeriodBalances[];
  /** RPT‑06: يُعاد كما هو */
  unit?: ReportUnit;
}

// ═══ البناء ═══

const CURRENT_ASSET_TYPES: readonly AccountType[] = [
  'asset_cash', 'asset_receivable', 'asset_current', 'asset_prepayments',
];
const CURRENT_LIABILITY_TYPES: readonly AccountType[] = [
  'liability_current', 'liability_credit_card', 'liability_payable',
];

function sumFull(
  accounts: readonly ReportAccount[],
  balanceOf: (id: string) => AccountBalance,
  types: readonly AccountType[],
): Milli {
  const want = new Set<string>(types);
  let sum = 0n;
  for (const a of accounts) if (want.has(a.type)) sum += fullBalanceMilli(a.type, balanceOf(a.id));
  return sum;
}

function sumMovement(
  accounts: readonly ReportAccount[],
  balanceOf: (id: string) => AccountBalance,
  types: readonly AccountType[],
): Milli {
  const want = new Set<string>(types);
  let sum = 0n;
  for (const a of accounts) if (want.has(a.type)) sum += periodNetMilli(balanceOf(a.id));
  return sum;
}

function figuresOf(
  period: ReportPeriod,
  accounts: readonly ReportAccount[],
  balances: readonly AccountBalance[],
  statement: IncomeStatement,
): ExecutiveFigures {
  const index = balanceIndex(balances);
  const balanceOf = (id: string): AccountBalance => index.get(id) ?? zeroBalance(id);

  // من قائمة الدخل نفسها (§7.3) — لا إعادة حساب ولا معادلة موازية
  const revenueMilli = incomeStatementAmount(statement, 'revenue');
  const costOfRevenueMilli = incomeStatementAmount(statement, 'costOfRevenue');
  const grossProfitMilli = incomeStatementAmount(statement, 'grossProfit');
  const netProfitMilli = statement.netProfitMilli;

  // أرصدة الميزانية حتى `period.to` بقاعدة §7.4 (والالتزامات بإشارة العرض المعكوسة)
  const cashMilli = sumFull(accounts, balanceOf, ['asset_cash']);
  const receivableMilli = sumFull(accounts, balanceOf, ['asset_receivable']);
  const payableMilli = -sumFull(accounts, balanceOf, ['liability_payable']);
  const currentAssetsMilli = sumFull(accounts, balanceOf, CURRENT_ASSET_TYPES);
  const currentLiabilitiesMilli = -sumFull(accounts, balanceOf, CURRENT_LIABILITY_TYPES);
  const netCashFlowMilli = sumMovement(accounts, balanceOf, ['asset_cash']);

  return {
    period,
    days: executivePeriodDays(period),
    revenueMilli,
    costOfRevenueMilli,
    grossProfitMilli,
    netProfitMilli,
    cashMilli,
    receivableMilli,
    payableMilli,
    currentAssetsMilli,
    currentLiabilitiesMilli,
    netCashFlowMilli,
  };
}

/** النِّسب الخمس من أرقام العمود (§7.3). صرفة. */
export function executiveRatiosOf(f: ExecutiveFigures): ExecutiveRatios {
  const days = BigInt(f.days);
  return {
    grossMargin: executivePercent(f.grossProfitMilli, f.revenueMilli),
    netMargin: executivePercent(f.netProfitMilli, f.revenueMilli),
    dso: executiveRatio(f.receivableMilli * days, f.revenueMilli),
    dpo: executiveRatio(f.payableMilli * days, f.costOfRevenueMilli),
    currentRatio: executiveRatio(f.currentAssetsMilli, f.currentLiabilitiesMilli),
  };
}

const MONEY_OF: Readonly<Record<ExecutiveMoneyKey, (f: ExecutiveFigures) => Milli>> = {
  revenue: (f) => f.revenueMilli,
  grossProfit: (f) => f.grossProfitMilli,
  netProfit: (f) => f.netProfitMilli,
  cash: (f) => f.cashMilli,
  receivable: (f) => f.receivableMilli,
  payable: (f) => f.payableMilli,
  netCashFlow: (f) => f.netCashFlowMilli,
};

function isMoneyKey(key: ExecutiveCardKey): key is ExecutiveMoneyKey {
  return (EXECUTIVE_MONEY_KEYS as readonly string[]).includes(key);
}

/**
 * يبني الملخّص التنفيذي (ORPT‑09). صرفة وحتمية.
 *
 * حارس برمجي (لا `LedgerError`): رصيدٌ لحساب غير موجود في `accounts`، أو قائمة دخل ممرَّرة بفترة
 * غير فترة التقرير ⇒ خطأ، فالنتيجة كانت ستخلط فترتين بصمت.
 */
export function buildExecutiveSummary(input: ExecutiveSummaryInput): ExecutiveSummary {
  const { period, accounts, balances } = input;
  const roles = input.roles ?? EMPTY_ACCOUNT_ROLES;
  const settings = input.settings ?? {};
  const unit = input.unit ?? 1;
  const comparisons = input.comparisons ?? [];

  const known = new Set(accounts.map((a) => a.id));
  for (const b of balances) {
    if (!known.has(b.accountId)) {
      throw new Error(`buildExecutiveSummary: رصيد لحساب غير معروف في قائمة الحسابات: ${b.accountId}`);
    }
  }

  /**
   * قائمة الدخل للفترة. خيارات العرض (`hideZero`, `search`, «إظهار الصفري») لا تمسّ إلا صفوف
   * الحسابات، والملخّص لا يقرأ إلا المجاميع، فتُترك على افتراضها.
   */
  const statementFor = (p: ReportPeriod, bal: readonly AccountBalance[]): IncomeStatement => buildIncomeStatement({
    period: p,
    accounts,
    balances: bal,
    roles,
    settings,
  });

  let statement = input.statement;
  if (statement !== undefined) {
    if (statement.period.from !== period.from || statement.period.to !== period.to) {
      throw new Error(
        'buildExecutiveSummary: قائمة الدخل الممرَّرة لفترة أخرى '
        + `(${statement.period.from}…${statement.period.to} بدل ${period.from}…${period.to})`,
      );
    }
  } else {
    statement = statementFor(period, balances);
  }

  const columnOf = (p: ReportPeriod, bal: readonly AccountBalance[], st: IncomeStatement): ExecutiveColumn => {
    const figures = figuresOf(p, accounts, bal, st);
    return { figures, ratios: executiveRatiosOf(figures) };
  };

  const current = columnOf(period, balances, statement);
  const comparison = comparisons.map((c) => columnOf(c.period, c.balances, statementFor(c.period, c.balances)));
  const previous: ExecutiveColumn | null = comparison[0] ?? null;

  const cards: ExecutiveCard[] = EXECUTIVE_CARD_ORDER.map((key): ExecutiveCard => {
    if (isMoneyKey(key)) {
      const amountMilli = MONEY_OF[key](current.figures);
      const previousMilli = previous === null ? null : MONEY_OF[key](previous.figures);
      return {
        key,
        kind: 'money',
        label: LABELS[key],
        formula: FORMULAS[key],
        amountMilli,
        previousMilli,
        changeMilli: previousMilli === null ? null : amountMilli - previousMilli,
        changePct: previousMilli === null ? null : percentChangeMilli(amountMilli, previousMilli),
      };
    }
    const value = current.ratios[key];
    const prev = previous === null ? null : previous.ratios[key];
    return {
      key,
      kind: RATIO_KINDS[key],
      label: LABELS[key],
      formula: FORMULAS[key],
      decimals: EXECUTIVE_RATIO_DECIMALS,
      value: value.value,
      defined: value.defined,
      previousValue: prev === null ? null : prev.value,
      previousDefined: prev !== null && prev.defined,
      changeValue: ratioDelta(value, prev),
    };
  });

  return {
    reportKey: 'executive-summary',
    period,
    days: current.figures.days,
    cards,
    current,
    comparison,
    options: { unit, ratioDecimals: EXECUTIVE_RATIO_DECIMALS, comparisonCount: comparison.length },
  };
}

// ═══ مشتقّات ومساعدات ═══

/** بطاقة بمفتاحها. */
export function executiveCard(summary: ExecutiveSummary, key: ExecutiveCardKey): ExecutiveCard | undefined {
  return summary.cards.find((c) => c.key === key);
}

/** مبلغ بطاقة مال بمفتاحها (صفر حين لا توجد — لا يقع مع مفاتيح `EXECUTIVE_MONEY_KEYS`). */
export function executiveAmount(summary: ExecutiveSummary, key: ExecutiveMoneyKey): Milli {
  const card = executiveCard(summary, key);
  return card !== undefined && isExecutiveMoneyCard(card) ? card.amountMilli : 0n;
}

/** قيمة بطاقة نسبة بمفتاحها. */
export function executiveRatioOf(summary: ExecutiveSummary, key: ExecutiveRatioKey): ExecutiveRatioValue {
  return summary.current.ratios[key];
}

/** عدد أسطر الملف للتصدير (RPT‑01): بطاقة لكل سطر. صرفة. */
export function executiveSummaryLineCount(summary: ExecutiveSummary): number {
  return summary.cards.length;
}
