import { ledgerName } from '../../../lib/ledger/format';
import { toMilli, unitSuffixKey, type LocalDate } from './reportOptions';
import type { ReportNode, ReportRenderContext, ReportTable, ReportTableColumn } from './ReportView';

/**
 * أسطر القائمتين الماليتين (M4، DESIGN.md §7.3 و§7.4، RPT‑11 إلى RPT‑14).
 *
 * **صرف تماماً**: لا React ولا شبكة — يحوّل ردّ `GET /api/ledger/reports/{income-statement|balance-sheet}`
 * إلى صفوف عرض مسطّحة بعمقها وإبرازها ومعادلتها ورابط تعمّقها، ويُختبر وحدةً بـ`tsx --test`.
 *
 * **العقد من المصدر لا من الذاكرة**: الأنواع أدناه منسوخة حرفياً من
 * `backend/src/services/gl/reports/{incomeStatement,balanceSheet}.ts` ومن `responseBody` في
 * `backend/src/routes/ledger/reports.ts`. كل حقل ينتهي بـ`Milli` **نصّ عدد صحيح بالملّي**
 * (الخادم لا يقرّب ولا يطبّق وحدة العرض)، فكل حساب هنا بـ`BigInt` لا بـ`Number`.
 *
 * **التسميات والمعادلات من جدول محلّي مترجم** لا من نصّ الخادم (§8.7: «عناوين أسطر التقارير
 * المدمجة بنداءات tr() حرفية في الواجهة»)، والجدول يطابق §7.3/§7.4 حرفاً بحرف بكل صيغه
 * (خيارا `depreciationInOperatingExpenses` و`drawingsAfterNetProfit`). ونصّ الخادم
 * (`label`/`formula`) هو الاحتياط لمفتاح لا يعرفه الجدول، فلا يسقط سطر جديد من الخادم صامتاً.
 */

// ═══ عقد الردّ (منسوخ من الخادم) ═══

/** مبلغ ملّي كما يصل من الخادم: نصّ عدد صحيح. */
export type MilliText = string;
export type { LocalDate };

export interface ReportPeriod {
  from: LocalDate;
  to: LocalDate;
  /** بداية السنة المالية التي يقع فيها `from` */
  fyStart: LocalDate;
}

export interface ReportWarning {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ReportSettingsInfo {
  currency: string;
  currencyDecimals: number;
  timezone: string;
  fiscalYearEnd: { month: number; day: number };
  drawingsAfterNetProfit: boolean;
  depreciationInOperatingExpenses: boolean;
  configured: boolean;
}

/** صفّ حساب داخل سطر (التعمّق PL‑03/BS‑04/RPT‑11). */
export interface StatementAccountRow {
  accountId: string;
  code: string;
  name: string;
  nameEn?: string | null;
  nameI18n?: Partial<Record<string, string>> | null;
  type: string;
  /** المبلغ بإشارة العرض */
  amountMilli: MilliText;
  /** قائمة الدخل: إجمالا الفترة (بلا بنود الإقفال) — مصدر قاعدة RPT‑14 */
  debitMilli?: MilliText;
  creditMilli?: MilliText;
  /** الميزانية: مساهمة الحساب بقاعدة مدين − دائن قبل قلب الإشارة */
  balanceMilli?: MilliText;
}

// ── قائمة الدخل (§7.3) ──

export const INCOME_STATEMENT_LINE_KEYS = [
  'revenue',
  'costOfRevenue',
  'grossProfit',
  'operatingExpenses',
  'operatingIncome',
  'otherIncome',
  'otherExpenses',
  'profitBeforeZakat',
  'zakat',
  'netProfit',
  'drawings',
  'netProfitAfterDrawings',
] as const;
export type IncomeStatementLineKey = (typeof INCOME_STATEMENT_LINE_KEYS)[number];

/** الأسطر المجمّعة (تُعرض عريضة، RPT‑13). */
export const INCOME_STATEMENT_TOTAL_KEYS: readonly IncomeStatementLineKey[] = [
  'grossProfit', 'operatingIncome', 'profitBeforeZakat', 'netProfit', 'netProfitAfterDrawings',
];

export interface IncomeStatementGroupRow {
  key: 'depreciation';
  label: string;
  amountMilli: MilliText;
  accounts: StatementAccountRow[];
}

export interface IncomeStatementRow {
  key: IncomeStatementLineKey | string;
  label: string;
  amountMilli: MilliText;
  total: boolean;
  /** معادلة السطر من الخادم — RPT‑12 (احتياط للجدول المحلّي) */
  formula?: string;
  accounts: StatementAccountRow[];
  groups: IncomeStatementGroupRow[];
}

export interface IncomeStatementServerOptions {
  drawingsAfterNetProfit: boolean;
  depreciationInOperatingExpenses: boolean;
  showAccountsWithoutMovement: boolean;
  hideZero: boolean;
  unit: number;
  hierarchy: boolean;
  search: string;
  searchFiltered: boolean;
}

export interface IncomeStatementResponse {
  reportKey: 'income-statement';
  period: ReportPeriod;
  dateFilter: { mode: string; from: LocalDate; to: LocalDate };
  settings: ReportSettingsInfo;
  mode: 'AGGREGATE' | 'LINE_SCAN';
  rows: IncomeStatementRow[];
  totals: {
    netProfitMilli: MilliText;
    drawingsMilli: MilliText;
    netProfitAfterDrawingsMilli: MilliText;
  };
  comparison: { kind: string; count: number; periods: ReportPeriod[] } | null;
  lineCount: number;
  warnings: ReportWarning[];
  statementOptions?: IncomeStatementServerOptions;
  draftMoveCount?: number;
}

// ── الميزانية العمومية (§7.4) ──

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

export const BALANCE_SHEET_TOTAL_KEYS: readonly BalanceSheetLineKey[] = [
  'assets', 'currentAssets', 'liabilities', 'currentLiabilities', 'equity', 'earnings', 'liabilitiesAndEquity',
];

export interface BalanceSheetNodeRow {
  key: BalanceSheetLineKey | string;
  label: string;
  amountMilli: MilliText;
  total: boolean;
  formula?: string;
  accounts: StatementAccountRow[];
  children: BalanceSheetNodeRow[];
}

export interface BalanceSheetServerOptions {
  drawingsAfterNetProfit: boolean;
  hideZero: boolean;
  unit: number;
  hierarchy: boolean;
  search: string;
  searchFiltered: boolean;
}

export interface BalanceSheetTotals {
  totalAssetsMilli: MilliText;
  totalLiabilitiesMilli: MilliText;
  totalEquityMilli: MilliText;
  currentYearEarningsMilli: MilliText;
  previousYearsEarningsMilli: MilliText;
  imbalanceMilli: MilliText;
  equityInvariantMilli: MilliText;
  balanced: boolean;
  totalLine: BalanceSheetNodeRow;
}

export interface BalanceSheetResponse {
  reportKey: 'balance-sheet';
  asOf: LocalDate;
  period: ReportPeriod;
  dateFilter: { mode: string; from: LocalDate; to: LocalDate };
  settings: ReportSettingsInfo;
  mode: 'AGGREGATE' | 'LINE_SCAN';
  rows: BalanceSheetNodeRow[];
  totals: BalanceSheetTotals;
  comparison: { kind: string; count: number; periods: ReportPeriod[] } | null;
  lineCount: number;
  warnings: ReportWarning[];
  statementOptions?: BalanceSheetServerOptions;
  draftMoveCount?: number;
}

// ═══ حساب الملّي ═══
// القراءة بـ`toMilli` من `reportOptions.ts` (العقد المشترك): نصّ ⇒ `bigint` بلا فقد دقة،
// وغير الصالح صفر — فلا يتسرّب `NaN` إلى جدول محاسبي ولا يُحسب فرقٌ بـ`Number`.

export function isZeroMilli(v: MilliText | null | undefined): boolean {
  return toMilli(v) === 0n;
}

/**
 * RPT‑14: للحساب حركة في الفترة؟ مدين الفترة أو دائنها غير صفر.
 * الخادم يسقط عديم الحركة أصلاً حين `showZero=false`، وهذا الحارس يمنع ظهوره لو أعاده.
 * الصفوف بلا عمودي المدين والدائن (صفوف الميزانية) لها حركة دائماً — لا تُخفى بهذه القاعدة.
 */
export function hasPeriodMovement(row: StatementAccountRow): boolean {
  if (row.debitMilli === undefined && row.creditMilli === undefined) return true;
  return !isZeroMilli(row.debitMilli) || !isZeroMilli(row.creditMilli);
}

// ═══ التسميات (§7.3، §7.4، §8.7) ═══

export type Tr = (ar: string) => string;

/** تسميات أسطر قائمة الدخل حرفياً من جدول §7.3. */
export const incomeLineLabels = (tr: Tr): Record<IncomeStatementLineKey, string> => ({
  revenue: tr('الإيرادات'),
  costOfRevenue: tr('تكلفة الإيرادات'),
  grossProfit: tr('إجمالي الربح'),
  operatingExpenses: tr('نفقات التشغيل'),
  operatingIncome: tr('الدخل التشغيلي'),
  otherIncome: tr('دخل آخر'),
  otherExpenses: tr('النفقات الأخرى'),
  profitBeforeZakat: tr('صافي الربح قبل الزكاة'),
  zakat: tr('الزكاة وضريبة الدخل'),
  netProfit: tr('صافي الربح'),
  drawings: tr('التخصيصات والمسحوبات'),
  netProfitAfterDrawings: tr('صافي الربح المتبقي بعد المخصصات والمسحوبات'),
});

/** §7.3: «الدخل التشغيلي (أو الخسائر التشغيلية)» — المفتاح ثابت والتسمية تتبع الإشارة. */
export const operatingLossLabel = (tr: Tr): string => tr('الخسائر التشغيلية');

/** السطر الفرعي المسمّى تحت نفقات التشغيل مع خيار `depreciationInOperatingExpenses`. */
export const depreciationGroupLabel = (tr: Tr): string => tr('الإهلاك');

/** تسميات أسطر الميزانية حرفياً من هيكل §7.4. */
export const balanceLineLabels = (tr: Tr): Record<BalanceSheetLineKey, string> => ({
  assets: tr('الأصول'),
  currentAssets: tr('الأصول المتداولة'),
  assetCash: tr('الحسابات البنكية والنقدية'),
  assetReceivable: tr('المدينون'),
  assetCurrent: tr('أصول متداولة أخرى'),
  assetPrepayments: tr('المدفوعات المقدمة'),
  fixedAssets: tr('الأصول الثابتة'),
  nonCurrentAssets: tr('الأصول غير المتداولة'),
  liabilities: tr('الالتزامات'),
  currentLiabilities: tr('الالتزامات المتداولة'),
  liabilityCurrent: tr('الالتزامات المتداولة'),
  liabilityCreditCard: tr('البطاقة الائتمانية'),
  liabilityPayable: tr('الدائنون'),
  nonCurrentLiabilities: tr('الالتزامات غير المتداولة'),
  equity: tr('حقوق الملكية'),
  capitalAndReserves: tr('رأس المال والاحتياطيات'),
  earnings: tr('الأرباح'),
  currentYearEarnings: tr('أرباح السنة الجارية غير الموزعة'),
  previousYearsEarnings: tr('أرباح سنوات سابقة'),
  liabilitiesAndEquity: tr('الالتزامات + حقوق الملكية'),
});

// ═══ المعادلات — أيقونة (i)، RPT‑12 ═══

export interface StatementFormulaOptions {
  /** §7.3: الإهلاك سطراً فرعياً في نفقات التشغيل بدل «النفقات الأخرى» */
  depreciationInOperatingExpenses?: boolean;
  /** §7.3 PL‑02 / §7.4: المسحوبات بعد صافي الربح */
  drawingsAfterNetProfit?: boolean;
}

/** معادلات أسطر قائمة الدخل بصيغتَي خيار الإهلاك (§7.3). */
export const incomeLineFormulas = (tr: Tr, o: StatementFormulaOptions = {}): Record<IncomeStatementLineKey, string> => {
  const dep = o.depreciationInOperatingExpenses === true;
  return {
    revenue: tr('−Σ حسابات الإيرادات'),
    costOfRevenue: tr('Σ حسابات تكلفة الإيرادات'),
    grossProfit: tr('الإيرادات − تكلفة الإيرادات'),
    operatingExpenses: dep
      ? tr('Σ حسابات نفقات التشغيل + Σ حسابات الإهلاك')
      : tr('Σ حسابات نفقات التشغيل'),
    operatingIncome: tr('إجمالي الربح − نفقات التشغيل'),
    otherIncome: tr('−Σ حسابات الإيرادات الأخرى'),
    otherExpenses: dep
      ? tr('Σ حسابات المصروفات الأخرى')
      : tr('Σ حسابات الإهلاك + Σ حسابات المصروفات الأخرى'),
    profitBeforeZakat: tr('الدخل التشغيلي + دخل آخر − النفقات الأخرى'),
    zakat: tr('Σ حسابات الزكاة وضريبة الدخل'),
    netProfit: tr('صافي الربح قبل الزكاة − الزكاة وضريبة الدخل'),
    drawings: tr('Σ حركة حسابات وسم المسحوبات في الفترة (مدين)'),
    netProfitAfterDrawings: tr('صافي الربح − التخصيصات والمسحوبات'),
  };
};

/** معادلات أسطر الميزانية بصيغتَي خيار المسحوبات (§7.4). */
export const balanceLineFormulas = (tr: Tr, o: StatementFormulaOptions = {}): Record<BalanceSheetLineKey, string> => {
  const dr = o.drawingsAfterNetProfit === true;
  return {
    assets: tr('الأصول المتداولة + الأصول الثابتة + الأصول غير المتداولة'),
    currentAssets: tr('الحسابات البنكية والنقدية + المدينون + أصول متداولة أخرى + المدفوعات المقدمة'),
    assetCash: tr('Σ حسابات البنك والنقد حتى التاريخ'),
    assetReceivable: tr('Σ حسابات المدينين حتى التاريخ'),
    assetCurrent: tr('Σ الأصول المتداولة الأخرى حتى التاريخ'),
    assetPrepayments: tr('Σ المدفوعات المقدمة حتى التاريخ'),
    fixedAssets: tr('Σ الأصول الثابتة حتى التاريخ (صافية بمجمّعات الإهلاك)'),
    nonCurrentAssets: tr('Σ الأصول غير المتداولة حتى التاريخ'),
    liabilities: tr('الالتزامات المتداولة + الالتزامات غير المتداولة'),
    currentLiabilities: tr('الالتزامات المتداولة + البطاقة الائتمانية + الدائنون'),
    liabilityCurrent: tr('−Σ الالتزامات المتداولة حتى التاريخ'),
    liabilityCreditCard: tr('−Σ البطاقات الائتمانية حتى التاريخ'),
    liabilityPayable: tr('−Σ حسابات الدائنين حتى التاريخ'),
    nonCurrentLiabilities: tr('−Σ الالتزامات غير المتداولة حتى التاريخ'),
    equity: tr('رأس المال والاحتياطيات + الأرباح'),
    capitalAndReserves: dr
      ? tr('−Σ حقوق الملكية حتى التاريخ، دون الأرباح المبقاة ودون حسابات المسحوبات')
      : tr('−Σ حقوق الملكية حتى التاريخ، دون الأرباح المبقاة'),
    earnings: tr('أرباح السنة الجارية غير الموزعة + أرباح سنوات سابقة'),
    currentYearEarnings: dr
      ? tr('−Σ حركة حسابات قائمة الدخل في السنة الجارية (بلا بنود الإقفال) − Σ حركة المسحوبات فيها')
      : tr('−Σ حركة حسابات قائمة الدخل في السنة الجارية (بلا بنود الإقفال)'),
    previousYearsEarnings: dr
      ? tr('−Σ قائمة الدخل قبل بداية السنة − Σ بنود الإقفال عليها − Σ أرباح السنة الجارية غير الموزعة − Σ الأرباح المبقاة − Σ المسحوبات قبل بداية السنة وبنود إقفالها')
      : tr('−Σ قائمة الدخل قبل بداية السنة − Σ بنود الإقفال عليها − Σ أرباح السنة الجارية غير الموزعة − Σ الأرباح المبقاة'),
    liabilitiesAndEquity: tr('الالتزامات + حقوق الملكية'),
  };
};

// ═══ صفوف العرض ═══

export type StatementRowKind = 'line' | 'group' | 'account';

/** صفّ واحد في جدول القائمة، مسطّحاً بعمقه (الجدول الهرمي يزيح بالعمق). */
export interface StatementDisplayRow {
  /** مفتاح React فريد داخل الجدول */
  id: string;
  kind: StatementRowKind;
  /** 0 للسطر الجذر، ويزيد بالتداخل */
  depth: number;
  /** مفتاح السطر من الخادم (أو معرّف الحساب لصفّ حساب) */
  key: string;
  label: string;
  /** رمز الحساب — صفوف الحسابات وحدها */
  code: string | null;
  amountMilli: MilliText;
  /** سطر مجموع يُبرز عريضاً (RPT‑13) */
  total: boolean;
  /** نصّ أيقونة (i) — RPT‑12 (`null` لصفوف الحسابات) */
  formula: string | null;
  /** معرّف الحساب للتعمّق إلى دفتر الأستاذ (RPT‑11) */
  accountId: string | null;
}

export interface StatementFlattenOptions {
  tr: Tr;
  /** لغة العرض — اسم الحساب عبر `ledgerName` (§8.7) */
  lang: string;
  depreciationInOperatingExpenses?: boolean;
  drawingsAfterNetProfit?: boolean;
  /** RPT‑14: إظهار حسابات قائمة الدخل بلا حركة في الفترة (الافتراض إخفاؤها) */
  showAccountsWithoutMovement?: boolean;
}

function accountRow(
  a: StatementAccountRow,
  depth: number,
  lang: string,
  parentKey: string,
): StatementDisplayRow {
  return {
    id: `${parentKey}:${a.accountId}`,
    kind: 'account',
    depth,
    key: a.accountId,
    label: ledgerName(a, lang),
    code: a.code,
    amountMilli: a.amountMilli,
    total: false,
    formula: null,
    accountId: a.accountId,
  };
}

/**
 * صفوف قائمة الدخل مسطّحة: السطر ثم حساباته ثم سطوره الفرعية بحساباتها.
 * الترتيب والمعادلات كما يعيدها الخادم — لا إعادة ترتيب ولا إعادة حساب هنا.
 */
export function incomeStatementDisplayRows(
  rows: readonly IncomeStatementRow[],
  o: StatementFlattenOptions,
): StatementDisplayRow[] {
  const labels = incomeLineLabels(o.tr);
  const formulas = incomeLineFormulas(o.tr, { depreciationInOperatingExpenses: o.depreciationInOperatingExpenses });
  const lossLabel = operatingLossLabel(o.tr);
  const depLabel = depreciationGroupLabel(o.tr);
  const showNoMovement = o.showAccountsWithoutMovement === true;
  const known = (k: string): k is IncomeStatementLineKey =>
    (INCOME_STATEMENT_LINE_KEYS as readonly string[]).includes(k);

  const out: StatementDisplayRow[] = [];
  for (const line of rows) {
    const k = String(line.key);
    const label = known(k)
      ? (k === 'operatingIncome' && toMilli(line.amountMilli) < 0n ? lossLabel : labels[k])
      : line.label;
    out.push({
      id: `line:${k}`,
      kind: 'line',
      depth: 0,
      key: k,
      label,
      code: null,
      amountMilli: line.amountMilli,
      // RPT‑13: وسم الخادم، ومفاتيح المجاميع حارسٌ ثانٍ لو غاب الوسم
      total: line.total === true || (known(k) && INCOME_STATEMENT_TOTAL_KEYS.includes(k)),
      formula: known(k) ? formulas[k] : (line.formula ?? null),
      accountId: null,
    });
    for (const a of line.accounts ?? []) {
      if (!showNoMovement && !hasPeriodMovement(a)) continue;
      out.push(accountRow(a, 1, o.lang, `line:${k}`));
    }
    for (const g of line.groups ?? []) {
      const gk = `${k}/${g.key}`;
      out.push({
        id: `group:${gk}`,
        kind: 'group',
        depth: 1,
        key: gk,
        label: g.key === 'depreciation' ? depLabel : g.label,
        code: null,
        amountMilli: g.amountMilli,
        total: false,
        formula: null,
        accountId: null,
      });
      for (const a of g.accounts ?? []) {
        if (!showNoMovement && !hasPeriodMovement(a)) continue;
        out.push(accountRow(a, 2, o.lang, `group:${gk}`));
      }
    }
  }
  return out;
}

/**
 * صفوف الميزانية مسطّحة: كل عقدة ثم حساباتها ثم أبناؤها، وسطر «الالتزامات + حقوق الملكية» آخراً.
 * حسابات الميزانية لا تُخفى بقاعدة RPT‑14 (لا حركة فترة لها) — يخفي الصفريَّ منها `hideZero` على الخادم.
 */
export function balanceSheetDisplayRows(
  sections: readonly BalanceSheetNodeRow[],
  totalLine: BalanceSheetNodeRow | null | undefined,
  o: StatementFlattenOptions,
): StatementDisplayRow[] {
  const labels = balanceLineLabels(o.tr);
  const formulas = balanceLineFormulas(o.tr, { drawingsAfterNetProfit: o.drawingsAfterNetProfit });
  const known = (k: string): k is BalanceSheetLineKey =>
    (BALANCE_SHEET_LINE_KEYS as readonly string[]).includes(k);

  const out: StatementDisplayRow[] = [];
  const walk = (node: BalanceSheetNodeRow, depth: number, path: string): void => {
    const k = String(node.key);
    const id = `${path}/${k}`;
    out.push({
      id: `node:${id}`,
      kind: 'line',
      depth,
      key: k,
      label: known(k) ? labels[k] : node.label,
      code: null,
      amountMilli: node.amountMilli,
      total: node.total === true || (known(k) && BALANCE_SHEET_TOTAL_KEYS.includes(k)),
      formula: known(k) ? formulas[k] : (node.formula ?? null),
      accountId: null,
    });
    for (const a of node.accounts ?? []) out.push(accountRow(a, depth + 1, o.lang, `node:${id}`));
    for (const c of node.children ?? []) walk(c, depth + 1, id);
  };
  for (const s of sections) walk(s, 0, '');
  if (totalLine) walk(totalLine, 0, 'total');
  return out;
}

// ═══ توازن الميزانية (§7.4) ═══

export interface BalanceSheetCheck {
  /** الأصول − (الالتزامات + حقوق الملكية) */
  imbalanceMilli: MilliText;
  balanced: boolean;
  /** خرق ثابت §7.4 (رأس المال + الأرباح مقابل كون حقوق الملكية) */
  equityInvariantMilli: MilliText;
  invariantHolds: boolean;
}

/**
 * يحسب الفرق من المجاميع نفسها بدل الاكتفاء بوسم `balanced` من الخادم:
 * الوسم الصامت لا يُطمأنّ إليه في شريط أحمر يقرؤه المحاسب (§7.4 «أي فرق يُعرض بشريط أحمر»).
 */
export function balanceSheetCheck(totals: Partial<BalanceSheetTotals> | null | undefined): BalanceSheetCheck {
  const assets = toMilli(totals?.totalAssetsMilli);
  const liabilities = toMilli(totals?.totalLiabilitiesMilli);
  const equity = toMilli(totals?.totalEquityMilli);
  const imbalance = assets - (liabilities + equity);
  const invariant = toMilli(totals?.equityInvariantMilli);
  return {
    imbalanceMilli: imbalance.toString(),
    balanced: imbalance === 0n,
    equityInvariantMilli: invariant.toString(),
    invariantHolds: invariant === 0n,
  };
}

// ═══ جدول القشرة المشتركة (`ReportView`) ═══
// الصفحتان قشرتان رقيقتان: تعطيان `toTable` وحدها، والجلبُ والشريطُ والطيّ والتصديرُ وحالةُ
// الرابط كلها في `ReportView` (كميزان المراجعة ودفتر الأستاذ). وما دون ذلك صرفٌ هنا ومُختبَر.

/** ما تحتاجه هذه التحويلات من سياق العرض — `ReportView` يمرّر السياق الكامل. */
export type StatementRowsContext = Pick<ReportRenderContext, 'tr' | 'lang' | 'unit'>;

/** عمود المبلغ الوحيد في القائمتين، ووسم وحدة العرض تحته (RPT‑06). صرفة. */
export function statementColumns(ctx: StatementRowsContext): ReportTableColumn[] {
  const suffix = unitSuffixKey(ctx.unit);
  return [{
    key: 'amount',
    label: ctx.tr('المبلغ'),
    ...(suffix ? { sub: suffix === 'thousands' ? ctx.tr('بالآلاف') : ctx.tr('بالملايين') } : {}),
  }];
}

export interface StatementNodeOptions {
  /** §7.4: تسمية سطرٍ رابطاً («أرباح السنة الجارية» ⇒ قائمة الدخل للفترة نفسها) */
  labelHref?: (row: StatementDisplayRow) => string | null;
}

/**
 * الصفوف المسطّحة بعمقها ⇒ شجرة عُقد `ReportView` (السطر أباً لحساباته وسطوره الفرعية)، فيعمل
 * الطيّ وزرّا «طيّ الكل/فتح الكل» على القائمتين كما على الميزان.
 *
 * - `hint` معادلة السطر (RPT‑12) كما بناها الجدول المحلّي — لا نصّاً جديداً هنا.
 * - `accountId` على صفّ الحساب وحده، فيصير مبلغه رابط تعمّق إلى دفتر الأستاذ (RPT‑11).
 * - `emphasis: 'total'` لأسطر المجاميع وحدها (RPT‑13) — وما عداها عاديّ كما كانت الصفحتان.
 * - صفٌّ عمقه أكبر ممّا فُتح من آباء يلتحق بأقرب أبٍ موجود بدل أن يسقط صامتاً.
 */
export function statementNodes(
  rows: readonly StatementDisplayRow[],
  o: StatementNodeOptions = {},
): ReportNode[] {
  const roots: ReportNode[] = [];
  const stack: (ReportNode & { children: ReportNode[] })[] = [];
  for (const r of rows) {
    const node: ReportNode & { children: ReportNode[] } = {
      id: r.id,
      label: r.label,
      code: r.code,
      accountId: r.accountId,
      emphasis: r.total ? 'total' : 'normal',
      hint: r.formula,
      labelHref: o.labelHref ? o.labelHref(r) : null,
      cells: [{ kind: 'amount', milli: r.amountMilli, ...(r.total ? { strong: true } : {}) }],
      children: [],
    };
    while (stack.length > r.depth) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

export interface IncomeStatementTableOptions {
  /** RPT‑14: مبدّل «إظهار الحسابات بلا حركة» من الصفحة، حين لا يعيد الخادم وسمه */
  showAccountsWithoutMovement?: boolean;
}

/** قائمة الدخل كاملةً (§7.3) جدولاً لـ`ReportView`. صرفة. */
export function incomeStatementTable(
  data: IncomeStatementResponse,
  ctx: StatementRowsContext,
  o: IncomeStatementTableOptions = {},
): ReportTable {
  const rows = incomeStatementDisplayRows(data.rows ?? [], {
    tr: ctx.tr,
    lang: ctx.lang,
    depreciationInOperatingExpenses:
      data.statementOptions?.depreciationInOperatingExpenses ?? data.settings.depreciationInOperatingExpenses,
    showAccountsWithoutMovement:
      data.statementOptions?.showAccountsWithoutMovement ?? o.showAccountsWithoutMovement === true,
  });
  return {
    columns: statementColumns(ctx),
    nodes: statementNodes(rows),
    emptyText: ctx.tr('لا حركة في هذه الفترة'),
  };
}

export interface BalanceSheetTableOptions {
  /** §7.4: رابط «أرباح السنة الجارية غير الموزعة» إلى قائمة الدخل للفترة نفسها */
  incomeHref?: string | null;
}

/**
 * الميزانية كاملةً (§7.4) جدولاً لـ`ReportView`: الأقسام شجرةً، و«الالتزامات + حقوق الملكية»
 * تذييلاً لا يُطوى، **وسمه أحمر حين لا تتوازن** (‏`balanceSheetCheck` من المجاميع لا من وسم
 * `balanced` وحده). صرفة.
 */
export function balanceSheetTable(
  data: BalanceSheetResponse,
  ctx: StatementRowsContext,
  o: BalanceSheetTableOptions = {},
): ReportTable {
  const flatten: StatementFlattenOptions = {
    tr: ctx.tr,
    lang: ctx.lang,
    drawingsAfterNetProfit: data.statementOptions?.drawingsAfterNetProfit ?? data.settings.drawingsAfterNetProfit,
  };
  const sections = balanceSheetDisplayRows(data.rows ?? [], null, flatten);
  const totalLine = data.totals?.totalLine ?? null;
  const totalRows = totalLine ? balanceSheetDisplayRows([], totalLine, flatten) : [];
  const href = o.incomeHref ?? null;
  const broken = !balanceSheetCheck(data.totals).balanced;
  return {
    columns: statementColumns(ctx),
    nodes: statementNodes(sections, {
      labelHref: r => (r.kind === 'line' && r.key === 'currentYearEarnings' ? href : null),
    }),
    footer: statementNodes(totalRows).map(n => ({ ...n, emphasis: 'total' as const, ...(broken ? { danger: true } : {}) })),
    emptyText: ctx.tr('لا أرصدة حتى هذا التاريخ'),
  };
}

// ═══ التعمّق (RPT‑11) ═══
// الرابط نفسه للتقارير كلها: `generalLedgerHref(accountId, range)` في `reportOptions.ts`
// (يحمل `mode=custom` اللازم وإلا قرأ دفتر الأستاذ `from` مرساةً لشهر). لا نسخة ثانية هنا.
// المدى هو مدى التقرير: في الميزانية `[fyStart, asOf]`، فصفّ الأستاذ الافتتاحي يحمل كل ما
// قبله ويكتمل رصيد الحساب حتى التاريخ (§7.5).
