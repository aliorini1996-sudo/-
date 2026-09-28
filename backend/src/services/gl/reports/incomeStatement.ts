/**
 * قائمة الدخل (M4، DESIGN.md §7.3، الصفوف PL‑01 إلى PL‑05).
 *
 * **صرفة تماماً**: تستقبل حسابات وأرصدة (مخرَج `composeBalances`) وتُعيد أسطر التقرير، وتُختبر بلا
 * قاعدة بيانات (§7.1). القراءة كلّها في `reports/load.ts` وحده.
 *
 * الأسطر والمعادلات حرفياً من جدول §7.3:
 *
 * | السطر | المعادلة |
 * |---|---|
 * | إجمالي المبيعات والإيرادات | −Σ `income` عدا حسابات المردودات والخصومات |
 * | يُطرح: مردودات وخصومات المبيعات | Σ حسابات `SALES_RETURNS` و`SALES_DISCOUNT` (412001/413001) — مدين موجب |
 * | **صافي الإيرادات** | إجمالي المبيعات − المردودات والخصومات (= −Σ `income` كاملةً) |
 * | تكلفة البضاعة المباعة | Σ `expense_direct_cost` |
 * | **مجمل الربح** | صافي الإيرادات − تكلفة البضاعة المباعة |
 * | المصروفات التشغيلية | Σ `expense` مجمّعة: البيع والتوزيع (61…) والعمومية والإدارية (62…) وغيرها (ومعها `expense_depreciation` مجموعةً «الإهلاك» **فقط** مع `depreciationInOperatingExpenses`) |
 * | **الربح التشغيلي** | مجمل الربح − المصروفات التشغيلية |
 * | إيرادات أخرى | −Σ `income_other` |
 * | مصروفات أخرى | Σ `expense_depreciation` (افتراضياً) + Σ `expense_other` |
 * | **صافي الربح قبل الزكاة** | الربح التشغيلي + إيرادات أخرى − مصروفات أخرى |
 *
 * التسميات بالعربية المحاسبية المعتادة (طلب المالك، ٢٨ سبتمبر ٢٠٢٦): كانت القائمة تجمع المبيعات ومردوداتها
 * وخصوماتها في سطر «الإيرادات» وحده، فبدت بلا صافي إيرادات ولا تكلفة بضاعة ولا مصروفات بأسمائها.
 * | الزكاة وضريبة الدخل | Σ `expense_zakat` |
 * | **صافي الربح** | ما قبل الزكاة − الزكاة |
 * | التخصيصات والمسحوبات (خيار `drawingsAfterNetProfit`) | Σ حركة حسابات وسم `DRAWINGS` في الفترة (مدين) |
 * | **صافي الربح المتبقي بعد المخصصات والمسحوبات** | صافي الربح − التخصيصات |
 *
 * ملاحظات ملزِمة:
 * - **بنود `YYYY-CL` مستبعدة** من كل الأسطر (§7.3، §2.5): كلّ المبالغ من حركة الفترة
 *   (`periodNetMilli` = مدين − دائن) التي لا تحمل بنود الإقفال أصلاً.
 * - المطابقة بالنوع **تماماً** لا بالبادئة: `expense` وحدها لنفقات التشغيل، فلا تبتلع
 *   `expense_direct_cost` ولا `expense_depreciation` ولا `expense_other` ولا `expense_zakat`.
 * - المبالغ **دقيقة بالملّي** ولا تُقرَّب إلى وحدة العرض (RPT‑06): `unit` يُعاد في `options`
 *   ويُطبَّق عند التصيير بـ`toUnitMilli`، حتى لا يكسر التقريبُ تساوي صافي الربح مع الميزانية.
 * - الفترة الافتراضية السنة المالية الجارية (PL‑05) — يحدّدها المتصل بـ`resolveReportPeriod`.
 */
import { formatMilli } from '../money';
import type { AccountType, Milli } from '../types';
import {
  balanceIndex, displayMilli, isProfitLossType, matchesAccountSearch, periodNetMilli, zeroBalance,
} from './balances';
import type { AccountBalance, ReportAccount, ReportPeriod, ReportUnit } from './types';

// ═══ أدوار الحسابات (§4.2، §4.5) ═══

/** رمز حساب المسحوبات في قالب `SA_6D` — احتياط حين لا يصل الربط ولا الوسم. */
export const DRAWINGS_TEMPLATE_CODE = '315001';
/** رمز حساب الأرباح المبقاة في قالب `SA_6D` (مفتاح `RETAINED_EARNINGS`). */
export const RETAINED_EARNINGS_TEMPLATE_CODE = '313001';

/** اسم وسم المسحوبات ومفتاح ربطه معاً (§4.2: 315001 بوسم `DRAWINGS` ومفتاح `DRAWINGS`). */
export const DRAWINGS_KEY = 'DRAWINGS';
export const RETAINED_EARNINGS_KEY = 'RETAINED_EARNINGS';
/** مفاتيح ربط حسابات مردودات وخصومات المبيعات (حسابات `income` مدينة الطبيعة تُطرح من الإيراد) */
export const SALES_DEDUCTION_KEYS = ['SALES_RETURNS', 'SALES_DISCOUNT'] as const;
/** رموزها في قالب `SA_6D` — احتياط حين لا يصل الربط */
export const SALES_DEDUCTION_TEMPLATE_CODES = ['412001', '413001'] as const;

/**
 * أدوار الحسابات التي لا يعرفها `ReportAccount` (لا يحمل مفاتيح الربط ولا الوسوم):
 * - `drawings`: حسابات وسم/مفتاح `DRAWINGS` (§7.3 سطر التخصيصات، §7.4 موضع 315001).
 * - `retainedEarnings`: حساب `RETAINED_EARNINGS` (313001) — يخرج من «رأس المال والاحتياطيات» دائماً (§7.4).
 */
export interface ReportAccountRoles {
  drawings: readonly string[];
  retainedEarnings: string | null;
  /** حسابات مردودات وخصومات المبيعات (تُطرح من إجمالي المبيعات إلى صافي الإيرادات) */
  salesDeductions?: readonly string[];
}

export const EMPTY_ACCOUNT_ROLES: ReportAccountRoles = { drawings: [], retainedEarnings: null, salesDeductions: [] };

export interface ReportAccountRolesInput {
  /** حسابات التقرير — تُستعمل للاحتياط بالرمز ولإسقاط المعرّفات الغريبة */
  accounts?: readonly ReportAccount[];
  /** صفوف `GlAccountMapping` ‏(`{key, accountId}`) */
  mappings?: readonly { key: string; accountId: string }[];
  /** روابط `GlAccountTagLink` مع اسم الوسم (`{tag, accountId}`) */
  tagLinks?: readonly { tag: string; accountId: string }[];
}

/**
 * يبني الأدوار من مفاتيح الربط والوسوم. **صرفة** — القارئ من القاعدة مسؤولية طبقة `load.ts`/المسار.
 * حين لا يصل ربطٌ ولا وسم يُستعمل رمز القالب احتياطاً (315001 و313001)، وحساب الأرباح المبقاة
 * لا يكون مسحوبات أبداً.
 */
export function reportAccountRoles(input: ReportAccountRolesInput): ReportAccountRoles {
  const accounts = input.accounts ?? [];
  const known = accounts.length > 0 ? new Set(accounts.map((a) => a.id)) : null;
  const ok = (id: string): boolean => known === null || known.has(id);

  let retained: string | null = null;
  for (const m of input.mappings ?? []) {
    if (m.key === RETAINED_EARNINGS_KEY && ok(m.accountId)) { retained = m.accountId; break; }
  }
  if (retained === null) {
    const byCode = accounts.find((a) => a.code === RETAINED_EARNINGS_TEMPLATE_CODE);
    if (byCode) retained = byCode.id;
  }

  const drawings = new Set<string>();
  for (const m of input.mappings ?? []) if (m.key === DRAWINGS_KEY && ok(m.accountId)) drawings.add(m.accountId);
  for (const t of input.tagLinks ?? []) if (t.tag === DRAWINGS_KEY && ok(t.accountId)) drawings.add(t.accountId);
  if (drawings.size === 0) {
    const byCode = accounts.find((a) => a.code === DRAWINGS_TEMPLATE_CODE);
    if (byCode) drawings.add(byCode.id);
  }
  if (retained !== null) drawings.delete(retained);

  const deductions = new Set<string>();
  for (const m of input.mappings ?? []) {
    if ((SALES_DEDUCTION_KEYS as readonly string[]).includes(m.key) && ok(m.accountId)) deductions.add(m.accountId);
  }
  if (deductions.size === 0) {
    for (const a of accounts) if ((SALES_DEDUCTION_TEMPLATE_CODES as readonly string[]).includes(a.code)) deductions.add(a.id);
  }

  return { drawings: [...drawings].sort(), retainedEarnings: retained, salesDeductions: [...deductions].sort() };
}

// ═══ أسطر قائمة الدخل (§7.3) ═══

export const INCOME_STATEMENT_LINE_KEYS = [
  'grossRevenue',
  'salesDeductions',
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

/** الأسطر المجمّعة (تُعرض عريضة، RPT‑13) — لا حسابات تحتها. */
export const INCOME_STATEMENT_TOTAL_KEYS: readonly IncomeStatementLineKey[] = [
  'revenue', 'grossProfit', 'operatingIncome', 'profitBeforeZakat', 'netProfit', 'netProfitAfterDrawings',
];

/** سطر حساب داخل سطر التقرير (التعمّق PL‑03/RPT‑11). */
export interface IncomeStatementAccountRow {
  accountId: string;
  code: string;
  name: string;
  nameI18n: Readonly<Record<string, string>> | null;
  type: AccountType;
  /** المبلغ بإشارة العرض (§7.1): الإيرادات موجبة حين تُدان دائناً، والمصروفات موجبة حين تُدان مديناً */
  amountMilli: Milli;
  /** إجمالي مدين الفترة (بلا بنود الإقفال) */
  debitMilli: Milli;
  /** إجمالي دائن الفترة (بلا بنود الإقفال) */
  creditMilli: Milli;
}

/** مجموعات المصروفات التشغيلية بالبادئة في قالب الرموز السداسي */
export type IncomeStatementGroupKey = 'selling' | 'admin' | 'otherOperating' | 'depreciation';

/**
 * سطر فرعي مسمّى داخل سطر رئيسي: مجموعات المصروفات التشغيلية (البيع والتوزيع 61…، العمومية والإدارية 62…، وغيرها)،
 * و«الإهلاك» تحتها مع الخيار (§7.3).
 */
export interface IncomeStatementGroup {
  key: IncomeStatementGroupKey;
  label: string;
  amountMilli: Milli;
  accounts: IncomeStatementAccountRow[];
}

export interface IncomeStatementLine {
  key: IncomeStatementLineKey;
  /** التسمية العربية كما في §7.3 */
  label: string;
  amountMilli: Milli;
  /** سطر مجموع (عريض) */
  total: boolean;
  /** معادلة السطر لأيقونة (i) — RPT‑12 */
  formula: string;
  accounts: IncomeStatementAccountRow[];
  groups: IncomeStatementGroup[];
}

export interface IncomeStatementOptions {
  drawingsAfterNetProfit: boolean;
  depreciationInOperatingExpenses: boolean;
  showAccountsWithoutMovement: boolean;
  hideZero: boolean;
  unit: ReportUnit;
  hierarchy: boolean;
  search: string;
  /** أُسقطت صفوف حسابات بسبب البحث (المجاميع تبقى كاملة) */
  searchFiltered: boolean;
}

export interface IncomeStatement {
  reportKey: 'profit-and-loss';
  period: ReportPeriod;
  lines: IncomeStatementLine[];
  /** «صافي الربح» (§7.3) */
  netProfitMilli: Milli;
  /** Σ حركة حسابات المسحوبات في الفترة (مدين) — محسوبة دائماً، وتظهر سطراً مع الخيار وحده */
  drawingsMilli: Milli;
  /** «صافي الربح المتبقي بعد المخصصات والمسحوبات»؛ = صافي الربح حين يكون الخيار مطفأً */
  netProfitAfterDrawingsMilli: Milli;
  options: IncomeStatementOptions;
}

export interface IncomeStatementSettings {
  /** §7.3 PL‑02 / §7.4 — نقل المسحوبات إلى ما بعد صافي الربح */
  drawingsAfterNetProfit?: boolean;
  /** §7.3 — الإهلاك سطراً فرعياً في نفقات التشغيل بدل «النفقات الأخرى» */
  depreciationInOperatingExpenses?: boolean;
}

export interface IncomeStatementInput {
  period: ReportPeriod;
  /** حسابات الشركة كاملةً (المصدر نفسه الذي مرّ على `composeBalances`) */
  accounts: readonly ReportAccount[];
  /** مخرَج `composeBalances` / `composeBalancesFromSources` للفترة نفسها */
  balances: readonly AccountBalance[];
  roles?: ReportAccountRoles;
  settings?: IncomeStatementSettings;
  /**
   * RPT‑14: الحسابات بلا حركة في الفترة لا تظهر. `true` = خيار «إظهار الصفري».
   * الافتراض `false` كما ينصّ §7.3، فلا يُشتق من `hideZero` الموحّد (افتراضه معكوس).
   */
  showAccountsWithoutMovement?: boolean;
  /** RPT‑07: إخفاء صفوف الحسابات التي مبلغها المعروض صفر (فوق قاعدة RPT‑14) */
  hideZero?: boolean;
  /** RPT‑15: بحث داخل التقرير — يصفّي صفوف الحسابات ولا يمسّ المجاميع */
  search?: string;
  /** RPT‑06: يُعاد كما هو ولا يُطبَّق على المبالغ (تُعاد دقيقة بالملّي) */
  unit?: ReportUnit;
  /** RPT‑07: يُعاد كما هو (تجميع ببادئة الرمز عند التصيير) */
  hierarchy?: boolean;
}

// ═══ التسميات والمعادلات (§7.3، RPT‑12) ═══

const LABELS: Readonly<Record<IncomeStatementLineKey, string>> = {
  grossRevenue: 'إجمالي المبيعات والإيرادات',
  salesDeductions: 'يُطرح: مردودات وخصومات المبيعات',
  revenue: 'صافي الإيرادات',
  costOfRevenue: 'تكلفة البضاعة المباعة',
  grossProfit: 'مجمل الربح',
  operatingExpenses: 'المصروفات التشغيلية',
  operatingIncome: 'الربح التشغيلي',
  otherIncome: 'إيرادات أخرى',
  otherExpenses: 'مصروفات أخرى',
  profitBeforeZakat: 'صافي الربح قبل الزكاة',
  zakat: 'الزكاة وضريبة الدخل',
  netProfit: 'صافي الربح',
  drawings: 'التخصيصات والمسحوبات',
  netProfitAfterDrawings: 'صافي الربح المتبقي بعد المخصصات والمسحوبات',
};

/** §7.3: «الربح التشغيلي (أو الخسارة التشغيلية)» — المفتاح ثابت والتسمية تتبع الإشارة. */
export const OPERATING_LOSS_LABEL = 'الخسارة التشغيلية';

function labelOf(key: IncomeStatementLineKey, amount: Milli): string {
  if (key === 'operatingIncome' && amount < 0n) return OPERATING_LOSS_LABEL;
  return LABELS[key];
}

function formulaOf(key: IncomeStatementLineKey, depInOpex: boolean): string {
  switch (key) {
    case 'grossRevenue': return '−Σ حسابات الإيرادات عدا المردودات والخصومات';
    case 'salesDeductions': return 'Σ حسابات مردودات المبيعات والخصم المسموح به';
    case 'revenue': return 'إجمالي المبيعات والإيرادات − مردودات وخصومات المبيعات';
    case 'costOfRevenue': return 'Σ حسابات تكلفة البضاعة المباعة';
    case 'grossProfit': return 'صافي الإيرادات − تكلفة البضاعة المباعة';
    case 'operatingExpenses':
      return depInOpex ? 'Σ حسابات المصروفات التشغيلية + Σ حسابات الإهلاك' : 'Σ حسابات المصروفات التشغيلية';
    case 'operatingIncome': return 'مجمل الربح − المصروفات التشغيلية';
    case 'otherIncome': return '−Σ حسابات الإيرادات الأخرى';
    case 'otherExpenses':
      return depInOpex ? 'Σ حسابات المصروفات الأخرى' : 'Σ حسابات الإهلاك + Σ حسابات المصروفات الأخرى';
    case 'profitBeforeZakat': return 'الربح التشغيلي + إيرادات أخرى − مصروفات أخرى';
    case 'zakat': return 'Σ حسابات الزكاة وضريبة الدخل';
    case 'netProfit': return 'صافي الربح قبل الزكاة − الزكاة وضريبة الدخل';
    case 'drawings': return 'Σ حركة حسابات وسم المسحوبات في الفترة (مدين)';
    case 'netProfitAfterDrawings': return 'صافي الربح − التخصيصات والمسحوبات';
  }
}

const DEPRECIATION_GROUP_LABEL = 'الإهلاك';
const GROUP_LABELS: Readonly<Record<IncomeStatementGroupKey, string>> = {
  selling: 'مصروفات البيع والتوزيع',
  admin: 'المصروفات العمومية والإدارية',
  otherOperating: 'مصروفات تشغيلية أخرى',
  depreciation: DEPRECIATION_GROUP_LABEL,
};

/** مجموعة حساب مصروف تشغيلي من بادئة رمزه (قالب الرموز السداسي: 61 البيع والتوزيع، 62 العمومية والإدارية) */
export function operatingExpenseGroupOf(code: string): Exclude<IncomeStatementGroupKey, 'depreciation'> {
  if (code.startsWith('61')) return 'selling';
  if (code.startsWith('62')) return 'admin';
  return 'otherOperating';
}

// ═══ البناء ═══

function byCode(a: ReportAccount, b: ReportAccount): number {
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * يبني قائمة الدخل من أرصدة الفترة. صرفة وحتمية.
 *
 * حارس برمجي (لا `LedgerError`): رصيدٌ لحساب غير موجود في `accounts` ⇒ خطأ، فقاعدة الإشارة
 * والتصنيف تعتمدان على نوع الحساب.
 */
export function buildIncomeStatement(input: IncomeStatementInput): IncomeStatement {
  const { period, accounts, balances } = input;
  const roles = input.roles ?? EMPTY_ACCOUNT_ROLES;
  const depInOpex = input.settings?.depreciationInOperatingExpenses === true;
  const drawingsAfter = input.settings?.drawingsAfterNetProfit === true;
  const showNoMovement = input.showAccountsWithoutMovement === true;
  const hideZero = input.hideZero === true;
  const search = typeof input.search === 'string' ? input.search.trim() : '';
  const unit = input.unit ?? 1;
  const hierarchy = input.hierarchy === true;

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  for (const b of balances) {
    if (!accountById.has(b.accountId)) {
      throw new Error(`buildIncomeStatement: رصيد لحساب غير معروف في قائمة الحسابات: ${b.accountId}`);
    }
  }
  const index = balanceIndex(balances);
  const balanceOf = (id: string): AccountBalance => index.get(id) ?? zeroBalance(id);

  const ofType = new Map<AccountType, ReportAccount[]>();
  for (const a of [...accounts].sort(byCode)) {
    const list = ofType.get(a.type);
    if (list) list.push(a); else ofType.set(a.type, [a]);
  }
  const pick = (...types: AccountType[]): ReportAccount[] => {
    const out: ReportAccount[] = [];
    for (const t of types) out.push(...(ofType.get(t) ?? []));
    return out.sort(byCode);
  };

  const netOf = (list: readonly ReportAccount[]): Milli => {
    let sum = 0n;
    for (const a of list) sum += periodNetMilli(balanceOf(a.id));
    return sum;
  };

  let searchFiltered = false;
  const rowsFor = (list: readonly ReportAccount[], signed: boolean): IncomeStatementAccountRow[] => {
    const out: IncomeStatementAccountRow[] = [];
    for (const a of list) {
      const b = balanceOf(a.id);
      if (!showNoMovement && b.debitMilli === 0n && b.creditMilli === 0n) continue;
      const net = periodNetMilli(b);
      const amountMilli = signed ? displayMilli(a.type, net) : net;
      if (hideZero && amountMilli === 0n) continue;
      if (search !== '' && !matchesAccountSearch(a, search)) { searchFiltered = true; continue; }
      out.push({
        accountId: a.id, code: a.code, name: a.name, nameI18n: a.nameI18n, type: a.type,
        amountMilli, debitMilli: b.debitMilli, creditMilli: b.creditMilli,
      });
    }
    return out;
  };

  // ── مجموعات الحسابات بالنوع تماماً (§4.1) ──
  const deductionIds = new Set(roles.salesDeductions ?? []);
  const incomeAccounts = pick('income');
  const grossRevenueAccounts = incomeAccounts.filter((a) => !deductionIds.has(a.id));
  const deductionAccounts = incomeAccounts.filter((a) => deductionIds.has(a.id));
  const directCostAccounts = pick('expense_direct_cost');
  const operatingAccounts = pick('expense');
  const depreciationAccounts = pick('expense_depreciation');
  const otherIncomeAccounts = pick('income_other');
  const otherExpenseAccounts = pick('expense_other');
  const zakatAccounts = pick('expense_zakat');
  // حسابات المسحوبات حسابات ملكية (§4.2: 315001 `equity`). حساب مِن قائمة الدخل وسمُه `DRAWINGS`
  // خطأ إعداد، ولو قُبل لحُسب مرتين (في نفقاته وفي سطر التخصيصات) — فيُتجاهل وسمه هنا وفي الميزانية.
  const drawingsAccounts = roles.drawings
    .map((id) => accountById.get(id))
    .filter((a): a is ReportAccount => a !== undefined && !isProfitLossType(a.type))
    .sort(byCode);

  // ── المعادلات حرفياً من جدول §7.3 ──
  const grossRevenueMilli = -netOf(grossRevenueAccounts);
  // المردودات والخصومات حسابات income مدينة الطبيعة: تُعرض موجبة وتُطرح
  const salesDeductionsMilli = netOf(deductionAccounts);
  const revenueMilli = grossRevenueMilli - salesDeductionsMilli;
  const costOfRevenueMilli = netOf(directCostAccounts);
  const grossProfitMilli = revenueMilli - costOfRevenueMilli;
  const depreciationMilli = netOf(depreciationAccounts);
  const operatingExpensesMilli = netOf(operatingAccounts) + (depInOpex ? depreciationMilli : 0n);
  const operatingIncomeMilli = grossProfitMilli - operatingExpensesMilli;
  const otherIncomeMilli = -netOf(otherIncomeAccounts);
  const otherExpensesMilli = (depInOpex ? 0n : depreciationMilli) + netOf(otherExpenseAccounts);
  const profitBeforeZakatMilli = operatingIncomeMilli + otherIncomeMilli - otherExpensesMilli;
  const zakatMilli = netOf(zakatAccounts);
  const netProfitMilli = profitBeforeZakatMilli - zakatMilli;
  // «مدين» صراحةً في §7.3: حركة الفترة بلا قلب إشارة الملكية
  const drawingsMilli = netOf(drawingsAccounts);
  const netProfitAfterDrawingsMilli = drawingsAfter ? netProfitMilli - drawingsMilli : netProfitMilli;

  const line = (
    key: IncomeStatementLineKey,
    amountMilli: Milli,
    accountsList: IncomeStatementAccountRow[] = [],
    groups: IncomeStatementGroup[] = [],
  ): IncomeStatementLine => ({
    key,
    label: labelOf(key, amountMilli),
    amountMilli,
    total: INCOME_STATEMENT_TOTAL_KEYS.includes(key),
    formula: formulaOf(key, depInOpex),
    accounts: accountsList,
    groups,
  });

  const depreciationGroups: IncomeStatementGroup[] = depInOpex
    ? [{
      key: 'depreciation',
      label: DEPRECIATION_GROUP_LABEL,
      amountMilli: depreciationMilli,
      accounts: rowsFor(depreciationAccounts, true),
    }]
    : [];

  // المصروفات التشغيلية مجمّعةً بالبادئة — إن لم يطابق أيّ حساب 61/62 تبقى الحسابات تحت السطر مباشرةً بلا مجموعة وحيدة
  const byGroup = new Map<Exclude<IncomeStatementGroupKey, 'depreciation'>, ReportAccount[]>();
  for (const a of operatingAccounts) {
    const g = operatingExpenseGroupOf(a.code);
    const list = byGroup.get(g);
    if (list) list.push(a); else byGroup.set(g, [a]);
  }
  const grouped = byGroup.has('selling') || byGroup.has('admin');
  const operatingGroups: IncomeStatementGroup[] = [];
  if (grouped) {
    for (const key of ['selling', 'admin', 'otherOperating'] as const) {
      const list = byGroup.get(key);
      if (!list) continue;
      const accountsRows = rowsFor(list, true);
      const amountMilli = netOf(list);
      if (accountsRows.length === 0 && amountMilli === 0n) continue;
      operatingGroups.push({ key, label: GROUP_LABELS[key], amountMilli, accounts: accountsRows });
    }
  }

  const lines: IncomeStatementLine[] = [
    line('grossRevenue', grossRevenueMilli, rowsFor(grossRevenueAccounts, true)),
    line('salesDeductions', salesDeductionsMilli, rowsFor(deductionAccounts, false)),
    line('revenue', revenueMilli),
    line('costOfRevenue', costOfRevenueMilli, rowsFor(directCostAccounts, true)),
    line('grossProfit', grossProfitMilli),
    line(
      'operatingExpenses', operatingExpensesMilli,
      grouped ? [] : rowsFor(operatingAccounts, true),
      [...operatingGroups, ...depreciationGroups],
    ),
    line('operatingIncome', operatingIncomeMilli),
    line('otherIncome', otherIncomeMilli, rowsFor(otherIncomeAccounts, true)),
    line(
      'otherExpenses',
      otherExpensesMilli,
      rowsFor(depInOpex ? otherExpenseAccounts : [...depreciationAccounts, ...otherExpenseAccounts].sort(byCode), true),
    ),
    line('profitBeforeZakat', profitBeforeZakatMilli),
    line('zakat', zakatMilli, rowsFor(zakatAccounts, true)),
    line('netProfit', netProfitMilli),
  ];

  // PL‑02: القسم يظهر مع الخيار وحده (بدونه تبقى المسحوبات في «رأس المال والاحتياطيات»، §7.4)
  if (drawingsAfter) {
    lines.push(line('drawings', drawingsMilli, rowsFor(drawingsAccounts, false)));
    lines.push(line('netProfitAfterDrawings', netProfitAfterDrawingsMilli));
  }

  return {
    reportKey: 'profit-and-loss',
    period,
    lines,
    netProfitMilli,
    drawingsMilli,
    netProfitAfterDrawingsMilli,
    options: {
      drawingsAfterNetProfit: drawingsAfter,
      depreciationInOperatingExpenses: depInOpex,
      showAccountsWithoutMovement: showNoMovement,
      hideZero,
      unit,
      hierarchy,
      search,
      searchFiltered,
    },
  };
}

// ═══ مشتقّات ومساعدات مشتركة ═══

/** سطر بمفتاحه (أو `undefined` حين لا يظهر السطر — أسطر المسحوبات بلا الخيار). */
export function incomeStatementLine(
  statement: IncomeStatement,
  key: IncomeStatementLineKey,
): IncomeStatementLine | undefined {
  return statement.lines.find((l) => l.key === key);
}

/** مبلغ سطر بمفتاحه (صفر حين لا يظهر). */
export function incomeStatementAmount(statement: IncomeStatement, key: IncomeStatementLineKey): Milli {
  return incomeStatementLine(statement, key)?.amountMilli ?? 0n;
}

/**
 * «نتيجة السنة الجارية» التي تعرضها الميزانية (§7.4): صافي الربح، ومع خيار المسحوبات
 * صافي الربح المتبقي بعدها. تُستعمل لإثبات تطابق القائمتين على المدخلات نفسها.
 */
export function currentYearResultMilli(statement: IncomeStatement): Milli {
  return statement.netProfitAfterDrawingsMilli;
}

/**
 * نسبة التغيّر لعمود المقارنة (RPT‑04) بمنزلتين عشريتين، بحساب صحيح بلا float:
 * `null` حين تكون الفترة المقارَنة صفراً (لا نسبة لها).
 */
export function percentChangeMilli(currentMilli: Milli, previousMilli: Milli): number | null {
  if (previousMilli === 0n) return null;
  const abs = previousMilli < 0n ? -previousMilli : previousMilli;
  return Number(((currentMilli - previousMilli) * 10_000n) / abs) / 100;
}

// ═══ التسلسل إلى JSON (BigInt لا يُسلسَل) ═══

/** كل حقل `bigint` يصير نصّ عدد صحيح بالملّي (بلا فقد دقة)؛ أسماء الحقول كما هي. */
export type JsonMilli<T> =
  T extends bigint ? string
    : T extends readonly (infer U)[] ? JsonMilli<U>[]
      : T extends object ? { [K in keyof T]: JsonMilli<T[K]> }
        : T;

function convertMilli(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(convertMilli);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = convertMilli(x);
    return out;
  }
  return v;
}

/**
 * يحوّل كل مبالغ الملّي إلى نصوص أعداد صحيحة للرد JSON.
 * القاعدة الوحيدة للواجهة: **كل حقل ينتهي بـ`Milli` هو نص عدد صحيح بالملّي**، والتنسيق عند العرض
 * بـ`formatMilli`/`toUnitMilli` (RPT‑06)، فلا يُقرَّب شيء على الخادم ولا تُكسر التسويات.
 */
export function toJsonMilli<T>(value: T): JsonMilli<T> {
  return convertMilli(value) as JsonMilli<T>;
}

/** نصّ عشري بمنازل العملة لمبلغ ملّي (للتصدير والعرض) — تفويض لـ`money.ts` بلا تكرار. */
export function formatReportMilli(milli: Milli, currencyDecimals: number): string {
  return formatMilli(milli, currencyDecimals);
}

/** هل النوع من أنواع قائمة الدخل؟ (إعادة تصدير من `balances.ts` لراحة المستهلكين) */
export { isProfitLossType };
