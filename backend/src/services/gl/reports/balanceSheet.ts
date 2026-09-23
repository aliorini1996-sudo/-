/**
 * الميزانية العمومية (M4، DESIGN.md §7.4، الصفوف BS‑01 إلى BS‑04).
 *
 * **صرفة تماماً**: تستقبل حسابات وأرصدة (مخرَج `composeBalances`) وتُعيد شجرة أسطر، وتُختبر بلا
 * قاعدة بيانات (§7.1). القراءة كلّها في `reports/load.ts` وحده.
 *
 * الفلتر «اعتباراً من» تاريخ D (BS‑02)، والفترة الممرَّرة هي `[FYStart(D), D]` كما يبنيها
 * `resolveReportPeriod({mode:'asOf'})` — فتكون حركة الفترة هي حركة السنة الجارية مباشرةً.
 * تمرير فترة `from !== fyStart` خطأ برمجي يُرفض، لأنّ سطر «أرباح السنة الجارية» يفقد معناه.
 *
 * الهيكل حرفياً من §7.4:
 *
 * ```
 * الأصول
 *   الأصول المتداولة = الحسابات البنكية والنقدية + المدينون + أصول متداولة أخرى + المدفوعات المقدمة
 *   الأصول الثابتة               Σ asset_fixed (صافية بمجمعاتها)
 *   الأصول غير المتداولة          Σ asset_non_current
 * الالتزامات
 *   الالتزامات المتداولة = (−Σ liability_current) + البطاقة الائتمانية + الدائنون (−Σ liability_payable)
 *   الالتزامات غير المتداولة      −Σ liability_non_current
 * حقوق الملكية
 *   رأس المال والاحتياطيات        −Σ equity حتى D، دون 313001 دائماً، ودون وسم DRAWINGS مع الخيار
 *   الأرباح
 *     أرباح السنة الجارية غير الموزعة = −Σ(P&L بلا CL) في [FYStart(D), D]
 *                                     − (Σ حركة DRAWINGS بلا CL في الفترة، مع الخيار)
 *     أرباح سنوات سابقة           = −Σ(P&L بلا CL) قبل FYStart(D) − Σ(بنود CL على P&L حتى D)
 *                                   − Σ equity_unaffected حتى D − Σ رصيد 313001 حتى D
 *                                   − (Σ رصيد DRAWINGS بلا CL قبل FYStart(D) + Σ بنود CL على DRAWINGS حتى D، مع الخيار)
 * الالتزامات + حقوق الملكية
 * ```
 *
 * الثابت (§7.4): رأس المال + أرباح السنة الجارية + أرباح سنوات سابقة =
 * −Σ(`equity` ∪ `equity_unaffected` ∪ P&L) لكل السطور حتى D **ومنها بنود CL**. فالخيار **ينقل**
 * رصيد DRAWINGS بين الأسطر ولا يُخرجه من المجموع، وتتبع «الأصول = الالتزامات + الملكية» من I1 مباشرة.
 * `off_balance` لا يظهر في القوائم (§4.1) وهو متوازن بذاته (I: لا يُخلط بغيره).
 */
import type { AccountType, LocalDate, Milli } from '../types';
import { balanceIndex, endingWithClosingMilli, isProfitLossType, matchesAccountSearch, periodNetMilli, zeroBalance } from './balances';
import {
  EMPTY_ACCOUNT_ROLES, currentYearResultMilli, toJsonMilli,
  type IncomeStatement, type JsonMilli, type ReportAccountRoles,
} from './incomeStatement';
import type { AccountBalance, ReportAccount, ReportPeriod, ReportUnit } from './types';

export {
  DRAWINGS_KEY, DRAWINGS_TEMPLATE_CODE, EMPTY_ACCOUNT_ROLES, RETAINED_EARNINGS_KEY,
  RETAINED_EARNINGS_TEMPLATE_CODE, reportAccountRoles, toJsonMilli,
} from './incomeStatement';
export type { JsonMilli, ReportAccountRoles, ReportAccountRolesInput } from './incomeStatement';

// ═══ أسطر الميزانية (§7.4) ═══

export const BALANCE_SHEET_LINE_KEYS = [
  'assets',
  'currentAssets',
  'assetCash',
  'assetReceivable',
  'assetCurrent',
  'assetPrepayments',
  'fixedAssets',
  'nonCurrentAssets',
  'liabilities',
  'currentLiabilities',
  'liabilityCurrent',
  'liabilityCreditCard',
  'liabilityPayable',
  'nonCurrentLiabilities',
  'equity',
  'capitalAndReserves',
  'earnings',
  'currentYearEarnings',
  'previousYearsEarnings',
  'liabilitiesAndEquity',
] as const;
export type BalanceSheetLineKey = (typeof BALANCE_SHEET_LINE_KEYS)[number];

/** الأسطر المجمّعة (تُعرض عريضة، RPT‑13). */
export const BALANCE_SHEET_TOTAL_KEYS: readonly BalanceSheetLineKey[] = [
  'assets', 'currentAssets', 'liabilities', 'currentLiabilities', 'equity', 'earnings', 'liabilitiesAndEquity',
];

/** سطر حساب داخل سطر الميزانية (التعمّق BS‑04/RPT‑11). */
export interface BalanceSheetAccountRow {
  accountId: string;
  code: string;
  name: string;
  nameI18n: Readonly<Record<string, string>> | null;
  type: AccountType;
  /** المبلغ بإشارة العرض: الأصول موجبة مدينةً، والالتزامات والملكية والأرباح موجبة دائنةً */
  amountMilli: Milli;
  /** مساهمة الحساب بقاعدة `مدين − دائن` قبل قلب الإشارة (للتعمّق ولفحص التسويات) */
  balanceMilli: Milli;
}

export interface BalanceSheetNode {
  key: BalanceSheetLineKey;
  /** التسمية العربية كما في §7.4 */
  label: string;
  amountMilli: Milli;
  /** سطر مجموع (عريض) */
  total: boolean;
  /** معادلة السطر لأيقونة (i) — RPT‑12 */
  formula: string;
  accounts: BalanceSheetAccountRow[];
  children: BalanceSheetNode[];
}

export interface BalanceSheetOptions {
  drawingsAfterNetProfit: boolean;
  hideZero: boolean;
  unit: ReportUnit;
  hierarchy: boolean;
  search: string;
  /** أُسقطت صفوف حسابات بسبب البحث (المجاميع تبقى كاملة) */
  searchFiltered: boolean;
}

export interface BalanceSheet {
  reportKey: 'balance-sheet';
  /** تاريخ «اعتباراً من» = `period.to` */
  asOf: LocalDate;
  period: ReportPeriod;
  /** الجذور الثلاثة: الأصول، الالتزامات، حقوق الملكية */
  sections: BalanceSheetNode[];
  /** سطر «الالتزامات + حقوق الملكية» */
  totalLine: BalanceSheetNode;
  totalAssetsMilli: Milli;
  totalLiabilitiesMilli: Milli;
  totalEquityMilli: Milli;
  currentYearEarningsMilli: Milli;
  previousYearsEarningsMilli: Milli;
  /** الأصول − (الالتزامات + حقوق الملكية): صفر دائماً من I1، وأي فرق يُعرض بشريط أحمر (§7.4) */
  imbalanceMilli: Milli;
  balanced: boolean;
  /**
   * خرق ثابت §7.4: (رأس المال + السنة الجارية + السنوات السابقة)
   * − (−Σ(`equity` ∪ `equity_unaffected` ∪ P&L) حتى D ومنها بنود CL). صفر دائماً مع الخيار وبدونه.
   */
  equityInvariantMilli: Milli;
  options: BalanceSheetOptions;
}

export interface BalanceSheetSettings {
  /** §7.4: ينقل رصيد حسابات وسم DRAWINGS من «رأس المال» إلى سطري الأرباح */
  drawingsAfterNetProfit?: boolean;
}

export interface BalanceSheetInput {
  /** لا بد أن تكون `[FYStart(D), D]` — مخرَج `resolveReportPeriod({mode:'asOf'})` */
  period: ReportPeriod;
  accounts: readonly ReportAccount[];
  /** مخرَج `composeBalances` للفترة نفسها */
  balances: readonly AccountBalance[];
  roles?: ReportAccountRoles;
  settings?: BalanceSheetSettings;
  /** RPT‑07: إخفاء صفوف الحسابات التي مبلغها المعروض صفر */
  hideZero?: boolean;
  /** RPT‑15: بحث داخل التقرير — يصفّي صفوف الحسابات ولا يمسّ المجاميع */
  search?: string;
  /** RPT‑06: يُعاد كما هو ولا يُطبَّق على المبالغ (تُعاد دقيقة بالملّي) */
  unit?: ReportUnit;
  /** RPT‑07: يُعاد كما هو */
  hierarchy?: boolean;
}

// ═══ التسميات والمعادلات ═══

const LABELS: Readonly<Record<BalanceSheetLineKey, string>> = {
  assets: 'الأصول',
  currentAssets: 'الأصول المتداولة',
  assetCash: 'الحسابات البنكية والنقدية',
  assetReceivable: 'المدينون',
  assetCurrent: 'أصول متداولة أخرى',
  assetPrepayments: 'المدفوعات المقدمة',
  fixedAssets: 'الأصول الثابتة',
  nonCurrentAssets: 'الأصول غير المتداولة',
  liabilities: 'الالتزامات',
  currentLiabilities: 'الالتزامات المتداولة',
  liabilityCurrent: 'الالتزامات المتداولة',
  liabilityCreditCard: 'البطاقة الائتمانية',
  liabilityPayable: 'الدائنون',
  nonCurrentLiabilities: 'الالتزامات غير المتداولة',
  equity: 'حقوق الملكية',
  capitalAndReserves: 'رأس المال والاحتياطيات',
  earnings: 'الأرباح',
  currentYearEarnings: 'أرباح السنة الجارية غير الموزعة',
  previousYearsEarnings: 'أرباح سنوات سابقة',
  liabilitiesAndEquity: 'الالتزامات + حقوق الملكية',
};

function formulaOf(key: BalanceSheetLineKey, withDrawings: boolean): string {
  switch (key) {
    case 'assets': return 'الأصول المتداولة + الأصول الثابتة + الأصول غير المتداولة';
    case 'currentAssets': return 'الحسابات البنكية والنقدية + المدينون + أصول متداولة أخرى + المدفوعات المقدمة';
    case 'assetCash': return 'Σ حسابات البنك والنقد حتى التاريخ';
    case 'assetReceivable': return 'Σ حسابات المدينين حتى التاريخ';
    case 'assetCurrent': return 'Σ الأصول المتداولة الأخرى حتى التاريخ';
    case 'assetPrepayments': return 'Σ المدفوعات المقدمة حتى التاريخ';
    case 'fixedAssets': return 'Σ الأصول الثابتة حتى التاريخ (صافية بمجمّعات الإهلاك)';
    case 'nonCurrentAssets': return 'Σ الأصول غير المتداولة حتى التاريخ';
    case 'liabilities': return 'الالتزامات المتداولة + الالتزامات غير المتداولة';
    case 'currentLiabilities': return 'الالتزامات المتداولة + البطاقة الائتمانية + الدائنون';
    case 'liabilityCurrent': return '−Σ الالتزامات المتداولة حتى التاريخ';
    case 'liabilityCreditCard': return '−Σ البطاقات الائتمانية حتى التاريخ';
    case 'liabilityPayable': return '−Σ حسابات الدائنين حتى التاريخ';
    case 'nonCurrentLiabilities': return '−Σ الالتزامات غير المتداولة حتى التاريخ';
    case 'equity': return 'رأس المال والاحتياطيات + الأرباح';
    case 'capitalAndReserves':
      return withDrawings
        ? '−Σ حقوق الملكية حتى التاريخ، دون الأرباح المبقاة ودون حسابات المسحوبات'
        : '−Σ حقوق الملكية حتى التاريخ، دون الأرباح المبقاة';
    case 'earnings': return 'أرباح السنة الجارية غير الموزعة + أرباح سنوات سابقة';
    case 'currentYearEarnings':
      return withDrawings
        ? '−Σ حركة حسابات قائمة الدخل في السنة الجارية (بلا بنود الإقفال) − Σ حركة المسحوبات فيها'
        : '−Σ حركة حسابات قائمة الدخل في السنة الجارية (بلا بنود الإقفال)';
    case 'previousYearsEarnings':
      return withDrawings
        ? '−Σ قائمة الدخل قبل بداية السنة − Σ بنود الإقفال عليها − Σ أرباح السنة الجارية غير الموزعة (319001) − Σ الأرباح المبقاة (313001) − Σ المسحوبات قبل بداية السنة وبنود إقفالها'
        : '−Σ قائمة الدخل قبل بداية السنة − Σ بنود الإقفال عليها − Σ أرباح السنة الجارية غير الموزعة (319001) − Σ الأرباح المبقاة (313001)';
    case 'liabilitiesAndEquity': return 'الالتزامات + حقوق الملكية';
  }
}

// ═══ أدوات ═══

function byCode(a: ReportAccount, b: ReportAccount): number {
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * رصيد الحساب الكامل حتى `to` بقاعدة `مدين − دائن`، **ومنه بنود الإقفال**.
 * حسابات الميزانية: `openingMilli` يضم ما قبل `from` كلَّه. حسابات قائمة الدخل: `openingMilli`
 * يبدأ من `fyStart` فقط (§7.2) فيُضاف إليها `preFyMilli` صراحةً.
 */
export function fullBalanceMilli(type: AccountType, b: AccountBalance): Milli {
  return (isProfitLossType(type) ? b.preFyMilli : 0n) + endingWithClosingMilli(b);
}

/** صافي بنود قيد إقفال السنة (`YYYY-CL`) على الحساب حتى `to` — قبل الفترة وداخلها. */
export function closingTotalMilli(b: AccountBalance): Milli {
  return b.closingOpeningMilli + b.closingMilli;
}

// ═══ البناء ═══

/**
 * يبني الميزانية العمومية «اعتباراً من» `period.to`. صرفة وحتمية.
 *
 * حراس برمجيون (لا `LedgerError`):
 * - `period.from !== period.fyStart` ⇒ خطأ (الميزانية «اعتباراً من» فقط، §7.4).
 * - رصيدٌ لحساب غير موجود في `accounts` ⇒ خطأ.
 */
export function buildBalanceSheet(input: BalanceSheetInput): BalanceSheet {
  const { period, accounts, balances } = input;
  if (period.from !== period.fyStart) {
    throw new Error(
      `buildBalanceSheet: الميزانية تُبنى على فترة «اعتباراً من» ‏[FYStart(D), D]، والممرَّر from=${period.from} وfyStart=${period.fyStart}`,
    );
  }
  const roles = input.roles ?? EMPTY_ACCOUNT_ROLES;
  const withDrawings = input.settings?.drawingsAfterNetProfit === true;
  const hideZero = input.hideZero === true;
  const search = typeof input.search === 'string' ? input.search.trim() : '';
  const unit = input.unit ?? 1;
  const hierarchy = input.hierarchy === true;

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  for (const b of balances) {
    if (!accountById.has(b.accountId)) {
      throw new Error(`buildBalanceSheet: رصيد لحساب غير معروف في قائمة الحسابات: ${b.accountId}`);
    }
  }
  const index = balanceIndex(balances);
  const balanceOf = (id: string): AccountBalance => index.get(id) ?? zeroBalance(id);

  const sorted = [...accounts].sort(byCode);
  const ofType = (...types: AccountType[]): ReportAccount[] => {
    const want = new Set<string>(types);
    return sorted.filter((a) => want.has(a.type));
  };

  const retainedId = roles.retainedEarnings !== null && accountById.has(roles.retainedEarnings)
    ? roles.retainedEarnings
    : null;
  // حسابات المسحوبات حسابات ملكية (§4.2). حسابٌ من قائمة الدخل وسمُه `DRAWINGS` خطأ إعداد يُتجاهل
  // هنا وفي قائمة الدخل معاً، وإلا حُسب مرتين (في نتيجة السنة وفي سطر المسحوبات).
  const drawingsIds = new Set(roles.drawings.filter((id) => {
    const a = accountById.get(id);
    return a !== undefined && id !== retainedId && !isProfitLossType(a.type);
  }));
  /** الحسابات التي ينقلها الخيار من رأس المال إلى سطري الأرباح */
  const movedByOption = withDrawings ? drawingsIds : new Set<string>();

  let searchFiltered = false;
  /**
   * صف حساب. `contribution` مساهمة الحساب بقاعدة `مدين − دائن`، و`credit` يعني أن السطر
   * يُعرض بإشارة معكوسة (الالتزامات وحقوق الملكية والأرباح).
   */
  const rowsFor = (
    list: readonly ReportAccount[],
    contribution: (a: ReportAccount, b: AccountBalance) => Milli,
    credit: boolean,
    dropZero: boolean,
  ): BalanceSheetAccountRow[] => {
    const out: BalanceSheetAccountRow[] = [];
    for (const a of list) {
      const raw = contribution(a, balanceOf(a.id));
      const amountMilli = credit ? -raw : raw;
      if ((dropZero || hideZero) && amountMilli === 0n) continue;
      if (search !== '' && !matchesAccountSearch(a, search)) { searchFiltered = true; continue; }
      out.push({
        accountId: a.id, code: a.code, name: a.name, nameI18n: a.nameI18n, type: a.type,
        amountMilli, balanceMilli: raw,
      });
    }
    return out;
  };

  const sumOf = (list: readonly ReportAccount[], contribution: (a: ReportAccount, b: AccountBalance) => Milli): Milli => {
    let s = 0n;
    for (const a of list) s += contribution(a, balanceOf(a.id));
    return s;
  };

  const full = (a: ReportAccount, b: AccountBalance): Milli => fullBalanceMilli(a.type, b);
  const movement = (_a: ReportAccount, b: AccountBalance): Milli => periodNetMilli(b);
  const beforeFyWithClosing = (_a: ReportAccount, b: AccountBalance): Milli => b.preFyMilli + closingTotalMilli(b);

  const leaf = (
    key: BalanceSheetLineKey,
    list: readonly ReportAccount[],
    credit: boolean,
  ): BalanceSheetNode => {
    const raw = sumOf(list, full);
    return {
      key,
      label: LABELS[key],
      amountMilli: credit ? -raw : raw,
      total: BALANCE_SHEET_TOTAL_KEYS.includes(key),
      formula: formulaOf(key, withDrawings),
      accounts: rowsFor(list, full, credit, false),
      children: [],
    };
  };

  const branch = (key: BalanceSheetLineKey, children: BalanceSheetNode[]): BalanceSheetNode => {
    let s = 0n;
    for (const c of children) s += c.amountMilli;
    return {
      key,
      label: LABELS[key],
      amountMilli: s,
      total: BALANCE_SHEET_TOTAL_KEYS.includes(key),
      formula: formulaOf(key, withDrawings),
      accounts: [],
      children,
    };
  };

  // ── الأصول ──
  const currentAssets = branch('currentAssets', [
    leaf('assetCash', ofType('asset_cash'), false),
    leaf('assetReceivable', ofType('asset_receivable'), false),
    leaf('assetCurrent', ofType('asset_current'), false),
    leaf('assetPrepayments', ofType('asset_prepayments'), false),
  ]);
  const assets = branch('assets', [
    currentAssets,
    leaf('fixedAssets', ofType('asset_fixed'), false),
    leaf('nonCurrentAssets', ofType('asset_non_current'), false),
  ]);

  // ── الالتزامات ──
  const currentLiabilities = branch('currentLiabilities', [
    leaf('liabilityCurrent', ofType('liability_current'), true),
    leaf('liabilityCreditCard', ofType('liability_credit_card'), true),
    leaf('liabilityPayable', ofType('liability_payable'), true),
  ]);
  const liabilities = branch('liabilities', [
    currentLiabilities,
    leaf('nonCurrentLiabilities', ofType('liability_non_current'), true),
  ]);

  // ── حقوق الملكية ──
  const plAccounts = sorted.filter((a) => isProfitLossType(a.type));
  const capitalAccounts = ofType('equity').filter((a) => a.id !== retainedId && !movedByOption.has(a.id));
  const unaffectedAccounts = ofType('equity_unaffected').filter((a) => a.id !== retainedId && !movedByOption.has(a.id));
  const retainedAccount = retainedId !== null ? accountById.get(retainedId) : undefined;
  const drawingsAccounts = withDrawings ? sorted.filter((a) => drawingsIds.has(a.id)) : [];

  const capitalAndReserves = leaf('capitalAndReserves', capitalAccounts, true);

  // أرباح السنة الجارية = −Σ(P&L بلا CL) في [FYStart(D), D] − (Σ حركة DRAWINGS، مع الخيار)
  const currentYearEarningsMilli = -(sumOf(plAccounts, movement) + sumOf(drawingsAccounts, movement));
  const currentYearEarnings: BalanceSheetNode = {
    key: 'currentYearEarnings',
    label: LABELS.currentYearEarnings,
    amountMilli: currentYearEarningsMilli,
    total: false,
    formula: formulaOf('currentYearEarnings', withDrawings),
    accounts: [
      ...rowsFor(plAccounts, movement, true, true),
      ...rowsFor(drawingsAccounts, movement, true, true),
    ],
    children: [],
  };

  // أرباح سنوات سابقة = −[Σ(P&L قبل FYStart + بنود CL عليها) + Σ 319001 + Σ 313001 + (المسحوبات مع الخيار)]
  const previousRaw = sumOf(plAccounts, beforeFyWithClosing)
    + sumOf(unaffectedAccounts, full)
    + (retainedAccount ? fullBalanceMilli(retainedAccount.type, balanceOf(retainedAccount.id)) : 0n)
    + sumOf(drawingsAccounts, beforeFyWithClosing);
  const previousYearsEarningsMilli = -previousRaw;
  const previousYearsEarnings: BalanceSheetNode = {
    key: 'previousYearsEarnings',
    label: LABELS.previousYearsEarnings,
    amountMilli: previousYearsEarningsMilli,
    total: false,
    formula: formulaOf('previousYearsEarnings', withDrawings),
    accounts: [
      ...rowsFor(plAccounts, beforeFyWithClosing, true, true),
      ...rowsFor(unaffectedAccounts, full, true, true),
      ...(retainedAccount ? rowsFor([retainedAccount], full, true, true) : []),
      ...rowsFor(drawingsAccounts, beforeFyWithClosing, true, true),
    ],
    children: [],
  };

  const earnings = branch('earnings', [currentYearEarnings, previousYearsEarnings]);
  const equity = branch('equity', [capitalAndReserves, earnings]);

  const totalAssetsMilli = assets.amountMilli;
  const totalLiabilitiesMilli = liabilities.amountMilli;
  const totalEquityMilli = equity.amountMilli;
  const totalLine: BalanceSheetNode = {
    key: 'liabilitiesAndEquity',
    label: LABELS.liabilitiesAndEquity,
    amountMilli: totalLiabilitiesMilli + totalEquityMilli,
    total: true,
    formula: formulaOf('liabilitiesAndEquity', withDrawings),
    accounts: [],
    children: [],
  };

  // الثابت §7.4 — لا يتغير بالخيار ولا بقيد الإقفال
  let equityUniverse = 0n;
  for (const a of sorted) {
    if (a.type === 'equity' || a.type === 'equity_unaffected' || isProfitLossType(a.type)) {
      equityUniverse += fullBalanceMilli(a.type, balanceOf(a.id));
    }
  }
  const imbalanceMilli = totalAssetsMilli - totalLine.amountMilli;

  return {
    reportKey: 'balance-sheet',
    asOf: period.to,
    period,
    sections: [assets, liabilities, equity],
    totalLine,
    totalAssetsMilli,
    totalLiabilitiesMilli,
    totalEquityMilli,
    currentYearEarningsMilli,
    previousYearsEarningsMilli,
    imbalanceMilli,
    balanced: imbalanceMilli === 0n,
    equityInvariantMilli: totalEquityMilli + equityUniverse,
    options: { drawingsAfterNetProfit: withDrawings, hideZero, unit, hierarchy, search, searchFiltered },
  };
}

// ═══ مشتقّات ═══

/** كل الأسطر مسطّحة مع عمقها (للتصدير RPT‑01 وعمود «المستوى» في XLSX). */
export function flattenBalanceSheet(sheet: BalanceSheet): { node: BalanceSheetNode; depth: number }[] {
  const out: { node: BalanceSheetNode; depth: number }[] = [];
  const walk = (node: BalanceSheetNode, depth: number): void => {
    out.push({ node, depth });
    for (const c of node.children) walk(c, depth + 1);
  };
  for (const s of sheet.sections) walk(s, 0);
  out.push({ node: sheet.totalLine, depth: 0 });
  return out;
}

/** سطر بمفتاحه في أي عمق. */
export function balanceSheetNode(sheet: BalanceSheet, key: BalanceSheetLineKey): BalanceSheetNode | undefined {
  return flattenBalanceSheet(sheet).find((n) => n.node.key === key)?.node;
}

/** مبلغ سطر بمفتاحه (صفر حين لا يوجد). */
export function balanceSheetAmount(sheet: BalanceSheet, key: BalanceSheetLineKey): Milli {
  return balanceSheetNode(sheet, key)?.amountMilli ?? 0n;
}

/**
 * الفرق بين «نتيجة السنة الجارية» في الميزانية وصافي الربح (أو المتبقي بعد المسحوبات) في
 * قائمة الدخل للفترة نفسها (§7.4). صفر دائماً، وأي فرق خطأ في المحرّك لا في البيانات.
 */
export function currentYearEarningsGapMilli(sheet: BalanceSheet, statement: IncomeStatement): Milli {
  return sheet.currentYearEarningsMilli - currentYearResultMilli(statement);
}

/** الرد JSON للميزانية (كل حقل `Milli` نصّ عدد صحيح بالملّي). */
export function balanceSheetJson(sheet: BalanceSheet): JsonMilli<BalanceSheet> {
  return toJsonMilli(sheet);
}
