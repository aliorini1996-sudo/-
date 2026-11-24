/**
 * «المحاسب الذكي AI» — مستندات المحادثة: الاقتراح الآلي للمعالجة والحساب والضريبة (صِرف حتمي، لا ذكاء اصطناعي — D4).
 *
 * المصدر: نوع المستند الذي يختاره المستخدم (شرائح البطاقة) وتصنيفه وفئة الأصل وفترة الخدمة والمبلغ — وحسابات المصروف من
 * خريطة post_expense الحيّة نفسها (EXPENSE_CATEGORIES في posting.ts) لا رموز مخترعة:
 *   - مصروف (EXPENSE): الصيانة 621010، الكهرباء والمياه 621006، الإيجار 621004، سكن الموظفين 621005… وما لا يُعرف 621016.
 *   - مدفوع مقدماً (PREPAID، D2): خدمة لأكثر من شهر دُفعت مقدماً (أشهر صريحة أو فترة تمتدّ بعد شهر الفاتورة) أو عقد إيجار
 *     ⇒ الاقتراح **مصروف الإطفاء الشهري** (621004 للإيجار، 621008 للاشتراك…) يراه المستخدم ويغيّره في البطاقة (D1)، وحساب
 *     المدفوع مقدماً مشتقٌّ منه كحلّ الترحيل (الإيجار وسكن الموظفين ⇐ 115002، وغيرهما ⇐ 115001) بأشهر 1..24؛ الأطول ⇒
 *     للمحاسب البشري (DOC_TREATMENT_REFERRED).
 *   - أصل (ASSET، D3): فئة أصل صريحة وصافي المبلغ (قبل الضريبة) ≥ حدّ الرسملة ⇒ 121003–121008 / 124001 بلا إهلاك؛ دون الحدّ
 *     ⇒ مصروف؛ الأراضي والمباني ⇒ للمحاسب البشري؛ البضاعة (inventory_goods) ⇒ DOC_IS_INVENTORY (مشتريات المستودع).
 *   - الضريبة (D7، vatModeFor): الشركة أزالت الضريبة ⇒ NONE (إجمالي بلا سطر ضريبة)؛ لا ضريبة ⇒ NONE؛ دليل بلا مربّع ضريبة
 *     (القالب العام) ⇒ NONE؛ عقد إيجار بلا فاتورة ضريبية أو رقم ضريبي للمورد غير ^3\d{13}3$ أو ضيافة/سكن موظفين ⇒
 *     NON_DEDUCTIBLE (الضريبة على التكلفة)؛ وإلا DEDUCTIBLE (سطر 116001).
 * الخيارات (accountOptions/payOptions) من دليل الشركة الممرَّر (لا قاعدة هنا): حسابات مصروف نشطة غير رقابية (بلا إهلاك ولا زكاة
 * ولا تكلفة مباشرة ولا «للمحاسب البشري» ولا رواتب — لها أداتها)، والمصروفات نفسها خياراتٍ للمدفوع مقدماً (ما يُطفأ عليه) حين
 * يوجد حساب مدفوعها مقدماً، والأصول المسموحة فوق الحدّ — ولا حساب رقابي أبداً. «مدفوع من»: 111001/111002/البنك (MAIN_BANK كالترحيل الحيّ إن مُرّر سياق الدفاتر) وبقية الصناديق والبنوك غير العهدة،
 * و213002 للآجل (D6).
 */
import {
  ACCRUED_EXPENSES, CUSTODY_ACCOUNT_CODES, EXPENSE_CATEGORIES, EXPENSE_CATEGORY_KEYS, RENT_EXPENSE_CODES, REFERRED_EXPENSE_CODES,
  REFERRED_EXPENSE_KEYS, SALARY_ACCOUNTS, cashCandidates, referredExpenseIds, resolveCashAccount, resolveLiability,
  type ExpenseCategory, type PlanLedger,
} from '../posting';
import { SA_6D_ACCOUNTS } from '../../gl/coa/sa';
import { addDays, addMonths, compareLocalDate, diffDays, endOfMonth, isLocalDate, parseLocalDate } from '../../gl/dates';
import type { Milli } from '../../gl/types';
import {
  ACCT_ASSET_CODES, ACCT_DOC_CODES, ACCT_DOC_EXTRA_CATEGORIES, ACCT_PREPAID_MAX_MONTHS, VENDOR_VAT_RE,
  type AcctAccountOption, type AcctAssetClass, type AcctDocFacts, type AcctDocSuggestion, type AcctDocTreatment,
  type AcctPaidFrom, type AcctPayOption, type AcctVatMode,
} from './types';
import { docDecimals, factAmount } from './normalize';

// ═══ الثوابت ═══

/** حدّ الرسملة الافتراضي (D3) بوحدة العملة الكبرى — AI_ACCOUNTANT_ASSET_THRESHOLD */
export const DEFAULT_ASSET_THRESHOLD = 2000;

/** حسابات مصروف ضريبتها لا تُخصم (D7): الضيافة (المادة 50)، وسكن الموظفين (إيجار سكني معفى) */
export const VAT_BLOCKED_ACCOUNTS: Readonly<Record<string, 'HOSPITALITY' | 'RESIDENTIAL'>> = {
  [EXPENSE_CATEGORIES.hospitality.code]: 'HOSPITALITY',
  [EXPENSE_CATEGORIES.staff_housing.code]: 'RESIDENTIAL',
};

/** حسابات «للمحاسب البشري» بالرمز في القالب: مفاتيح REFERRED_EXPENSE_KEYS ⇐ رموزها + REFERRED_EXPENSE_CODES (posting.ts) */
export const REFERRED_TEMPLATE_CODES: readonly string[] = [
  ...SA_6D_ACCOUNTS.filter((a) => a.mappingKeys.some((k) => REFERRED_EXPENSE_KEYS.includes(k))).map((a) => a.code),
  ...REFERRED_EXPENSE_CODES,
];

/** الرواتب والتأمينات لها أداة post_salaries (فحص الاستحقاق) — لا تُعرض حساباً لمستند */
const SALARY_CODES: readonly string[] = Object.values(SALARY_ACCOUNTS).map((a) => a.code);

/** أنواع مصروف لا يُرحَّل إليها من مستند: الإهلاك والزكاة (للمحاسب)، والتكلفة المباشرة (البضاعة من المستودع) */
const EXCLUDED_EXPENSE_TYPES: readonly string[] = ['expense_depreciation', 'expense_zakat', 'expense_direct_cost'];

const PREPAID_CODES: readonly string[] = [ACCT_DOC_CODES.prepaidRent, ACCT_DOC_CODES.prepaidOther];
const ASSET_CODES: readonly string[] = Object.values(ACCT_ASSET_CODES);

/** فئة أصل دون حدّ الرسملة ⇐ تصنيف المصروف البديل */
const ASSET_FALLBACK_CATEGORY: Readonly<Record<Exclude<AcctAssetClass, 'land_buildings'>, ExpenseCategory>> = {
  leasehold_improvements: 'maintenance',
  machinery: 'misc',
  furniture: 'misc',
  computers: 'office_supplies',
  vehicles: 'misc',
  tools: 'misc',
  software_license: 'software',
};

/** اسم الحساب في القالب السعودي (للاقتراح بلا دليل الشركة) */
const TEMPLATE_NAME: ReadonlyMap<string, string> = new Map(SA_6D_ACCOUNTS.map((a) => [a.code, a.names.ar]));
export function templateAccountName(code: string): string {
  return TEMPLATE_NAME.get(code) ?? code;
}

// ═══ الدليل ═══

/** حساب من دليل الشركة كما يمرّره المحمِّل (AcctDocChartAccount)؛ النوع والحالة اختياريان: الغائب يُحكم بقائمة الرموز وحدها */
export interface ChartAccountLike {
  code: string;
  name: string;
  type?: string | null;
  isActive?: boolean | null;
  controlKind?: string | null;
}

export interface SuggestOpts {
  /** الشركة أزالت الضريبة (isTaxOff) — taxDisabled مرادفها في AcctDocEnv */
  taxOff?: boolean;
  taxDisabled?: boolean;
  /** دليل فيه مربّع ضريبة المدخلات (SA_6D)؛ false ⇒ لا فصل (الافتراضي true) */
  vatBox?: boolean;
  /** حدّ الرسملة بوحدة العملة الكبرى (الافتراضي 2000) أو بالملّي (يغلب) */
  assetThreshold?: number;
  assetThresholdMilli?: bigint;
  currency?: string | null;
  currencyDecimals?: number | null;
  /** سياق الدفاتر إن توفّر: «مدفوع من» بحلّ الترحيل الحيّ نفسه (المفتاح ثم الرمز ثم دفتر النظام) واستبعاد «للمحاسب» المعاد ربطه */
  ledger?: PlanLedger | null;
}

const isUsable = (a: ChartAccountLike | null | undefined): a is ChartAccountLike =>
  !!a && a.isActive !== false && (a.controlKind ?? null) === null;
const typeOk = (a: ChartAccountLike, pred: (t: string) => boolean) => (a.type === null || a.type === undefined ? true : pred(a.type));

function chartOf(chart: readonly ChartAccountLike[] | null | undefined, opts: SuggestOpts): readonly ChartAccountLike[] | null {
  if (opts.ledger) return opts.ledger.accounts;
  return chart ?? null;
}

function indexOf(chart: readonly ChartAccountLike[]): Map<string, ChartAccountLike> {
  const m = new Map<string, ChartAccountLike>();
  for (const a of chart) if (!m.has(a.code)) m.set(a.code, a);
  return m;
}

/** يصلح حساب مصروف لمستند؟ (بالنوع إن عُرف، وإلا بقائمة تصنيفات post_expense وحدها) */
function expenseOk(a: ChartAccountLike, referredCodes: ReadonlySet<string>): boolean {
  if (!isUsable(a)) return false;
  if (SALARY_CODES.includes(a.code) || referredCodes.has(a.code)) return false;
  if (a.type === null || a.type === undefined) return CATEGORY_CODES.has(a.code);
  return a.type.startsWith('expense') && !EXCLUDED_EXPENSE_TYPES.includes(a.type);
}

const CATEGORY_CODES: ReadonlySet<string> = new Set(Object.values(EXPENSE_CATEGORIES).map((c) => c.code));

function referredCodesOf(opts: SuggestOpts): ReadonlySet<string> {
  const out = new Set<string>(REFERRED_TEMPLATE_CODES);
  if (opts.ledger) {
    const ids = referredExpenseIds(opts.ledger);
    for (const a of opts.ledger.accounts) if (ids.has(a.id)) out.add(a.code);
  }
  return out;
}

// ═══ المبالغ والأشهر ═══

/** حدّ الرسملة بالملّي */
export function assetThresholdMilliOf(opts: Pick<SuggestOpts, 'assetThreshold' | 'assetThresholdMilli'>): Milli {
  if (typeof opts.assetThresholdMilli === 'bigint' && opts.assetThresholdMilli >= 0n) return opts.assetThresholdMilli;
  const t = typeof opts.assetThreshold === 'number' && Number.isFinite(opts.assetThreshold) && opts.assetThreshold >= 0
    ? opts.assetThreshold : DEFAULT_ASSET_THRESHOLD;
  return BigInt(Math.round(t * 1000));
}

/** منازل مبالغ الحقائق: منازل الشركة إن كانت عملة المستند عملتها (أو غائبة)، وإلا من رمز عملة المستند */
export function factsDecimals(facts: Pick<AcctDocFacts, 'currency'> | null, opts: { currency?: string | null; currencyDecimals?: number | null }): number {
  const cur = facts?.currency ?? null;
  const company = opts.currency ? opts.currency.toUpperCase() : null;
  if (typeof opts.currencyDecimals === 'number' && (!cur || !company || cur.toUpperCase() === company)) {
    return docDecimals(company, opts.currencyDecimals);
  }
  return docDecimals(cur ?? company);
}

/** صافي المبلغ قبل الضريبة (لحدّ الرسملة): المبلغ قبل الضريبة، وإلا الإجمالي ناقص الضريبة، وإلا الإجمالي */
export function netMilli(facts: AcctDocFacts, decimals: number): Milli | null {
  const sub = factAmount(facts.subtotal, decimals);
  if (sub !== null) return sub;
  const total = factAmount(facts.total, decimals);
  if (total === null) return null;
  const vat = factAmount(facts.vatAmount, decimals);
  return vat !== null && vat < total ? total - vat : total;
}

/** عدد أشهر الفترة من..إلى شاملة (2026-01-01..2026-12-31 = 12؛ 2026-01-15..2027-01-14 = 12)، وأقلّه 1 */
export function periodMonths(from: string, to: string): number | null {
  if (!isLocalDate(from) || !isLocalDate(to) || compareLocalDate(to, from) < 0) return null;
  const endExcl = addDays(to, 1);
  const f = parseLocalDate(from);
  const e = parseLocalDate(endExcl);
  let k = (e.y - f.y) * 12 + (e.m - f.m);
  const rem = diffDays(addMonths(from, k), endExcl);
  if (rem > 15) k += 1;
  else if (rem < -15) k -= 1;
  return Math.max(1, k);
}

/**
 * أشهر الخدمة المدفوعة مقدماً: الصريحة (facts.months) كما هي، وإلا من الفترة إن امتدّت بعد شهر الفاتورة (الدفع مقدّم) —
 * فاتورة عن أشهر مضت (متأخرة) ليست دفعاً مقدّماً ⇒ null (مصروف).
 */
export function paidMonths(facts: AcctDocFacts): number | null {
  if (facts.months !== null && facts.months !== undefined) return facts.months;
  if (!facts.periodFrom || !facts.periodTo) return null;
  const n = periodMonths(facts.periodFrom, facts.periodTo);
  if (n === null || n <= 1) return n;
  const anchor = facts.issueDate && isLocalDate(facts.issueDate) ? facts.issueDate : facts.periodFrom;
  return compareLocalDate(facts.periodTo, endOfMonth(anchor)) > 0 ? n : null;
}

// ═══ التصنيف ═══

const isExpenseCategory = (v: unknown): v is ExpenseCategory =>
  typeof v === 'string' && (EXPENSE_CATEGORY_KEYS as readonly string[]).includes(v);

export const DOC_CATEGORY_KEYS: readonly string[] = [...EXPENSE_CATEGORY_KEYS, ...ACCT_DOC_EXTRA_CATEGORIES];

/**
 * تصنيف من نصّ المورد وسطور المستند (اقتراح فقط، يراه المستخدم ويغيّره): كلمات محافظة، الأخصّ أولاً. لا شيء ⇒ null.
 * نصّ المستند بيانات لا تعليمات — لا يغيّر إلا هذا الاقتراح المعروض.
 */
const TEXT_CATEGORY_RULES: ReadonlyArray<[ExpenseCategory, RegExp]> = [
  ['medical_insurance', /تأمين\s*(?:ال)?(?:طبي|صحي)|medical\s*insurance|health\s*insurance/i],
  ['vehicle_insurance', /تأمين\s*(?:ال)?(?:سيار|مركب)|vehicle\s*insurance|motor\s*insurance/i],
  ['fuel', /وقود|بنزين|ديزل|محروقات|\bfuel\b|petrol|diesel|gasoline/i],
  ['utilities', /كهرباء|الكهرباء|المياه|مياه|electricity|\bwater\b/i],
  // «زين» كلمةً مستقلة وحدها: «بنزين» و«تخزين» تحويانها
  ['telecom', /اتصالات|موبايلي|(?:^|\s)زين(?:\s|$)|إنترنت|انترنت|(?:^|[^a-z])stc(?:[^a-z]|$)|mobily|\bzain\b|internet|telecom/i],
  ['hospitality', /مطعم|مقهى|كافيه|كوفي|ضيافة|restaurant|\bcaf[eé]\b|coffee/i],
  ['vehicle_maintenance', /صيانة\s*(?:ال)?(?:سيار|مركب)|ورشة|car\s*service|auto\s*repair/i],
  ['maintenance', /صيانة|إصلاح|اصلاح|maintenance|repair/i],
  ['cleaning', /نظافة|تنظيف|cleaning/i],
  ['office_supplies', /قرطاسية|أدوات\s*مكتبية|ادوات\s*مكتبية|stationery|office\s*supplies/i],
  ['software', /اشتراك|subscription|software|\bsaas\b/i],
  ['advertising', /دعاية|إعلان|اعلان|advertis|marketing/i],
  ['delivery', /شحن|توصيل|shipping|courier|aramex|smsa|أرامكس|ارامكس/i],
  ['professional_fees', /محاماة|محامي|استشار|مراجعة\s*حسابات|consult|legal|\baudit/i],
  ['government_fees', /بلدية|رسوم\s*حكومية|government\s*fee/i],
  ['rent', /إيجار|ايجار|\brent\b|\blease\b/i],
];

export function inferCategory(facts: Pick<AcctDocFacts, 'vendorName' | 'lines'>): ExpenseCategory | null {
  const text = [facts.vendorName ?? '', ...(facts.lines ?? []).map((l) => l.description ?? '')].join(' \n ');
  if (!text.trim()) return null;
  for (const [cat, re] of TEXT_CATEGORY_RULES) if (re.test(text)) return cat;
  return null;
}

/** تصنيف المصروف: الصريح (categoryHint) ثم نوع المستند ثم النص ثم «متنوعة» */
export function expenseCategoryOf(facts: AcctDocFacts): ExpenseCategory {
  if (isExpenseCategory(facts.categoryHint)) return facts.categoryHint;
  if (facts.docType === 'LEASE_CONTRACT') return facts.lease?.residential ? 'staff_housing' : 'rent';
  const inferred = inferCategory(facts);
  if (facts.docType === 'UTILITY_BILL') return inferred === 'telecom' ? 'telecom' : 'utilities';
  if (facts.docType === 'MAINTENANCE_INVOICE') return inferred === 'vehicle_maintenance' ? 'vehicle_maintenance' : 'maintenance';
  return inferred ?? 'misc';
}

/**
 * تصنيف مصروف الإطفاء لمدفوعٍ مقدّماً: الصريح إن كان تصنيف مصروف، وإلا كما لو لم يُذكر تصنيف («prepaid» لا يحدّد المصروف):
 * العقد إيجار (أو سكن موظفين)، والفاتورة بنوعها أو نصّها، وإلا «متنوعة».
 */
export function prepaidCategoryOf(facts: AcctDocFacts): ExpenseCategory {
  return isExpenseCategory(facts.categoryHint) ? facts.categoryHint : expenseCategoryOf({ ...facts, categoryHint: null });
}

/** رمز حساب المدفوع مقدماً لمصروف الإطفاء — حلّ الترحيل نفسه (resolvePrepaidAccount): الإيجار وسكن الموظفين ⇐ 115002، وغيرهما ⇐ 115001 */
export function prepaidCodeForExpense(expenseCode: string): string {
  return RENT_EXPENSE_CODES.includes(expenseCode) ? ACCT_DOC_CODES.prepaidRent : ACCT_DOC_CODES.prepaidOther;
}

/** معالجة الحساب من رمزه (للبطاقة والترحيل): 115001/115002 مدفوع مقدماً، الأصول المسموحة أصل، وغيرها مصروف */
export function treatmentOfCode(code: string): AcctDocTreatment {
  if (PREPAID_CODES.includes(code)) return 'PREPAID';
  if (ASSET_CODES.includes(code)) return 'ASSET';
  return 'EXPENSE';
}

// ═══ الضريبة (D7) ═══

export type VatModeReason =
  | 'TAX_OFF' | 'NO_VAT' | 'NO_VAT_BOX' | 'NO_TAX_INVOICE' | 'NO_VENDOR_VAT' | 'BLOCKED_CATEGORY' | 'DEDUCTIBLE';

export interface VatModeResult {
  vatMode: AcctVatMode;
  reason: VatModeReason;
  /** لـBLOCKED_CATEGORY: HOSPITALITY | RESIDENTIAL */
  blocked?: 'HOSPITALITY' | 'RESIDENTIAL';
}

/**
 * وضع ضريبة المستند لحسابٍ معيّن (يستدعيه الترحيل بالحساب الذي اختاره المستخدم): للمدفوع مقدماً يُحكم بحساب الإطفاء
 * (expenseCode) — إيجار سكن الموظفين مقدّماً ضريبته لا تُخصم.
 */
export function vatModeFor(
  facts: AcctDocFacts,
  target: { accountCode: string | null; expenseCode?: string | null },
  opts: Pick<SuggestOpts, 'taxOff' | 'taxDisabled' | 'vatBox' | 'currency' | 'currencyDecimals'>,
): VatModeResult {
  if (opts.taxOff === true || opts.taxDisabled === true) return { vatMode: 'NONE', reason: 'TAX_OFF' };
  const vat = factAmount(facts.vatAmount, factsDecimals(facts, opts));
  if (vat === null || vat <= 0n) return { vatMode: 'NONE', reason: 'NO_VAT' };
  if (opts.vatBox === false) return { vatMode: 'NONE', reason: 'NO_VAT_BOX' };
  if (facts.docType === 'LEASE_CONTRACT') return { vatMode: 'NON_DEDUCTIBLE', reason: 'NO_TAX_INVOICE' };
  if (!VENDOR_VAT_RE.test(facts.vendorVat ?? '')) return { vatMode: 'NON_DEDUCTIBLE', reason: 'NO_VENDOR_VAT' };
  const blocked = (target.expenseCode ? VAT_BLOCKED_ACCOUNTS[target.expenseCode] : undefined)
    ?? (target.accountCode ? VAT_BLOCKED_ACCOUNTS[target.accountCode] : undefined);
  if (blocked) return { vatMode: 'NON_DEDUCTIBLE', reason: 'BLOCKED_CATEGORY', blocked };
  return { vatMode: 'DEDUCTIBLE', reason: 'DEDUCTIBLE' };
}

// ═══ الاقتراح ═══

export type DocBlockReason = 'DOC_IS_INVENTORY' | 'DOC_TREATMENT_REFERRED';

export interface SuggestCore {
  suggestion: AcctDocSuggestion | null;
  /** حساب الإطفاء الشهري للمدفوع مقدماً (Dr هذا / Cr 115002|115001) — null لغير PREPAID */
  amortizationAccount: { code: string; name: string } | null;
  /** لا معالجة آلية: بضاعة (مشتريات المستودع) أو أرض/مبنى/أكثر من 24 شهراً (المحاسب البشري) */
  blocked: DocBlockReason | null;
  /** فئة أصل صريحة دون حدّ الرسملة ⇒ اقتُرح مصروفاً (ASSET_BELOW_THRESHOLD عند تأكيد الأصل) */
  belowThreshold: boolean;
  vat: VatModeResult | null;
  /** أشهر الخدمة المدفوعة مقدماً كما حُسبت (صريحة أو من الفترة) */
  months: number | null;
}

/** الحساب في الدليل (نشط غير رقابي بالنوع المتوقّع) أو null؛ بلا دليل ⇒ اسم القالب */
function pickAccount(
  idx: Map<string, ChartAccountLike> | null, code: string, accept: (a: ChartAccountLike) => boolean,
): { code: string; name: string } | null {
  if (!idx) return { code, name: templateAccountName(code) };
  const a = idx.get(code);
  return a && accept(a) ? { code: a.code, name: a.name } : null;
}

/**
 * الاقتراح الحتمي. chart (أو opts.ledger) اختياري: معه يُتحقَّق من وجود الحساب ونشاطه ويُسقط إلى البديل؛ بدونه أسماء القالب.
 */
export function suggestCore(facts: AcctDocFacts, opts: SuggestOpts = {}, chart?: readonly ChartAccountLike[] | null): SuggestCore {
  const list = chartOf(chart, opts);
  const idx = list ? indexOf(list) : null;
  const referred = referredCodesOf(opts);
  const dec = factsDecimals(facts, opts);
  const none: SuggestCore = { suggestion: null, amortizationAccount: null, blocked: null, belowThreshold: false, vat: null, months: null };

  if (facts.categoryHint === 'inventory_goods') return { ...none, blocked: 'DOC_IS_INVENTORY' };
  if (facts.assetClassHint === 'land_buildings') return { ...none, blocked: 'DOC_TREATMENT_REFERRED' };

  const category = expenseCategoryOf(facts);
  const expenseAcc = (cat: ExpenseCategory) =>
    pickAccount(idx, EXPENSE_CATEGORIES[cat].code, (a) => expenseOk(a, referred))
    ?? pickAccount(idx, EXPENSE_CATEGORIES.misc.code, (a) => expenseOk(a, referred));
  const paidFrom: AcctPaidFrom | null = facts.paymentHint === 'UNPAID' ? 'payable' : null;
  const months = paidMonths(facts);
  const vatOpts = { ...opts };

  const finish = (
    treatment: AcctDocTreatment, acc: { code: string; name: string }, m: number | null,
    amort: { code: string; name: string } | null, belowThreshold = false, prepaid: { code: string; name: string } | null = null,
  ): SuggestCore => {
    const vat = vatModeFor(facts, { accountCode: prepaid?.code ?? acc.code, expenseCode: amort?.code ?? null }, vatOpts);
    return {
      suggestion: {
        treatment, accountCode: acc.code, accountName: acc.name, vatMode: vat.vatMode, months: m, paidFrom,
        // المدفوع مقدماً: الحساب المقترح هو مصروف الإطفاء (ما ترسله البطاقة)، وحساب المدفوع مقدماً المشتق للعرض والنصّ
        ...(prepaid && amort ? { prepaidCode: prepaid.code, prepaidName: prepaid.name, amortizationCode: amort.code, amortizationName: amort.name } : {}),
      },
      amortizationAccount: amort, blocked: null, belowThreshold, vat, months,
    };
  };
  const asExpense = (cat: ExpenseCategory, belowThreshold = false): SuggestCore => {
    const acc = expenseAcc(cat);
    return acc ? finish('EXPENSE', acc, null, null, belowThreshold) : { ...none, belowThreshold, months };
  };

  // أصل صريح (D3): فوق الحدّ ⇒ حسابه؛ دونه ⇒ مصروف بديل
  if (facts.assetClassHint) {
    const cls = facts.assetClassHint;
    const net = netMilli(facts, dec);
    const fallback = ASSET_FALLBACK_CATEGORY[cls];
    if (net !== null && net >= assetThresholdMilliOf(opts)) {
      const acc = pickAccount(idx, ACCT_ASSET_CODES[cls], (a) => isUsable(a) && typeOk(a, (t) => t === 'asset_fixed' || t === 'asset_non_current'));
      if (acc) return finish('ASSET', acc, null, null);
      return asExpense(fallback);
    }
    return asExpense(fallback, net !== null);
  }

  // مدفوع مقدماً (D2): أشهر ≥ 2، أو عقد إيجار/«مدفوع مقدماً» بلا أشهر بعد (تُطلب في البطاقة)
  const prepaidAsked = facts.docType === 'LEASE_CONTRACT' || facts.categoryHint === 'prepaid';
  if (months !== null && months > ACCT_PREPAID_MAX_MONTHS) return { ...none, blocked: 'DOC_TREATMENT_REFERRED', months };
  if ((months !== null && months >= 2) || (prepaidAsked && months === null)) {
    const amortCat = prepaidCategoryOf(facts);
    const amort = expenseAcc(amortCat);
    // حساب المدفوع مقدماً من مصروف الإطفاء كما يحلّه الترحيل — فما تذكره البطاقة هو ما يُرحَّل
    const prepaid = amort ? pickAccount(idx, prepaidCodeForExpense(amort.code), (a) => isUsable(a) && typeOk(a, (t) => t === 'asset_prepayments')) : null;
    if (prepaid && amort) return finish('PREPAID', amort, months, amort, false, prepaid);
    return asExpense(amortCat);
  }
  return asExpense(category);
}

// ═══ الخيارات ═══

/**
 * خيارات الحساب في البطاقة: المصروفات المسموحة (EXPENSE)، ثم المصروفات نفسها خياراتٍ للمدفوع مقدماً (PREPAID: المصروف الذي
 * يُطفأ عليه شهرياً، حين يوجد حساب مدفوعه مقدماً 115002/115001 نشطاً — لا 115001/115002 نفسيهما: يُشتقّان من المصروف)، ثم
 * الأصول (فقط إن بلغ الصافي حدّ الرسملة) — بلا رقابي. الرمز نفسه قد يرد بمعالجتين.
 */
export function accountOptionsFor(
  facts: AcctDocFacts | null, chart: readonly ChartAccountLike[] | null | undefined, opts: SuggestOpts = {},
): AcctAccountOption[] {
  const list = chartOf(chart, opts);
  if (!list) return [];
  const referred = referredCodesOf(opts);
  const byCode = (a: { code: string }, b: { code: string }) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  const seen = new Set<string>();
  const out: AcctAccountOption[] = [];
  const push = (a: ChartAccountLike, treatment: AcctDocTreatment) => {
    const key = `${treatment}:${a.code}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ code: a.code, name: a.name, treatment });
  };
  const expenses = [...list].filter((x) => expenseOk(x, referred) && !PREPAID_CODES.includes(x.code) && !ASSET_CODES.includes(x.code)).sort(byCode);
  for (const a of expenses) push(a, 'EXPENSE');
  const idx = indexOf(list);
  const prepaidOk = (code: string) => { const a = idx.get(code); return !!a && isUsable(a) && typeOk(a, (t) => t === 'asset_prepayments'); };
  const okByCode = new Map(PREPAID_CODES.map((c) => [c, prepaidOk(c)]));
  for (const a of expenses) if (okByCode.get(prepaidCodeForExpense(a.code))) push(a, 'PREPAID');
  const dec = factsDecimals(facts, opts);
  const net = facts ? netMilli(facts, dec) : null;
  if (net !== null && net >= assetThresholdMilliOf(opts)) {
    for (const code of [...ASSET_CODES].sort()) {
      const a = idx.get(code);
      if (a && isUsable(a) && typeOk(a, (t) => t === 'asset_fixed' || t === 'asset_non_current')) push(a, 'ASSET');
    }
  }
  return out;
}

/** صندوق أم بنك لحساب نقد إضافي: 1111xx بنوك القالب، وغيرها صناديق */
const paidFromOfCode = (code: string): AcctPaidFrom => (code.startsWith('1111') ? 'bank' : 'cash');

/**
 * خيارات «مدفوع من»: الصندوق 111001، النثريات 111002، البنك (MAIN_BANK ⇐ 111101 ⇐ دفتر BANK_MAIN بحلّ الترحيل الحيّ إن
 * مُرّر سياق الدفاتر، وإلا 111101 ثم أول بنك 1111xx)، ثم بقية الصناديق والبنوك غير العهدة، ثم 213002 للآجل (D6).
 */
export function payOptionsFor(chart: readonly ChartAccountLike[] | null | undefined, opts: SuggestOpts = {}): AcctPayOption[] {
  const out: AcctPayOption[] = [];
  const seen = new Set<string>();
  const push = (paidFrom: AcctPaidFrom, a: { code: string; name: string } | null | undefined) => {
    if (!a || seen.has(a.code)) return;
    seen.add(a.code);
    out.push({ paidFrom, code: a.code, name: a.name });
  };
  const lc = opts.ledger ?? null;
  if (lc) {
    for (const source of ['cash', 'petty_cash', 'bank'] as const) {
      const r = resolveCashAccount(lc, source);
      if ('account' in r) push(source, r.account);
    }
    for (const c of cashCandidates(lc, 50)) push(paidFromOfCode(c.code), c);
    const acc = resolveLiability(lc, ACCRUED_EXPENSES, 'مصروفات مستحقة');
    if ('id' in acc) push('payable', acc);
    return out;
  }
  const list = chart ?? null;
  if (!list) return out;
  const idx = indexOf(list);
  const cashOk = (a: ChartAccountLike | undefined): a is ChartAccountLike =>
    !!a && isUsable(a) && !CUSTODY_ACCOUNT_CODES.includes(a.code) && typeOk(a, (t) => t === 'asset_cash');
  const fixed = (code: string) => { const a = idx.get(code); return cashOk(a) ? a : null; };
  push('cash', fixed('111001'));
  push('petty_cash', fixed('111002'));
  const banks = [...list].filter((a) => cashOk(a) && a.code.startsWith('1111')).sort((a, b) => (a.code < b.code ? -1 : 1));
  push('bank', fixed('111101') ?? banks[0] ?? null);
  // البقية (بالنوع المعروف وحده: نوعٌ غائب لا يكفي لعرض حسابٍ نقداً)
  for (const a of [...list].filter((x) => cashOk(x) && x.type === 'asset_cash').sort((x, y) => (x.code < y.code ? -1 : 1))) {
    push(paidFromOfCode(a.code), a);
  }
  const accrued = idx.get(ACCT_DOC_CODES.accrued);
  if (accrued && isUsable(accrued) && typeOk(accrued, (t) => t === 'liability_current' || t === 'liability_non_current')) push('payable', accrued);
  return out;
}

export interface DocSuggestResult extends SuggestCore {
  accountOptions: AcctAccountOption[];
  payOptions: AcctPayOption[];
}

/**
 * الاقتراح والخيارات من دليل الشركة (يحمّله الخادم ويمرّره — store/view أو الترحيل). الاقتراح دائماً ضمن الخيارات حين
 * يُمرَّر الدليل؛ facts null ⇒ لا اقتراح والخيارات بلا أصول.
 */
export function suggestFor(
  facts: AcctDocFacts | null, chart: readonly ChartAccountLike[] | null | undefined, opts: SuggestOpts = {},
): DocSuggestResult {
  const accountOptions = accountOptionsFor(facts, chart, opts);
  const payOptions = payOptionsFor(chart, opts);
  if (!facts) {
    return { suggestion: null, amortizationAccount: null, blocked: null, belowThreshold: false, vat: null, months: null, accountOptions, payOptions };
  }
  const core = suggestCore(facts, opts, chart);
  return { ...core, accountOptions, payOptions };
}

/** حساب الإطفاء لمدفوع مقدّم اختاره المستخدم (للترحيل وجدول الإطفاء): 115002 ⇐ الإيجار (أو سكن الموظفين)، 115001 ⇐ التصنيف */
export function amortizationAccountFor(
  facts: AcctDocFacts, prepaidCode: string, chart?: readonly ChartAccountLike[] | null, opts: SuggestOpts = {},
): { code: string; name: string } | null {
  const list = chartOf(chart, opts);
  const idx = list ? indexOf(list) : null;
  const referred = referredCodesOf(opts);
  let cat = prepaidCategoryOf(facts);
  if (prepaidCode === ACCT_DOC_CODES.prepaidRent && cat !== 'staff_housing') cat = 'rent';
  return pickAccount(idx, EXPENSE_CATEGORIES[cat].code, (a) => expenseOk(a, referred))
    ?? pickAccount(idx, EXPENSE_CATEGORIES.misc.code, (a) => expenseOk(a, referred));
}
