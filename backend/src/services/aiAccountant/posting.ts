/**
 * «المحاسب الذكي AI» — الترحيل المباشر (الحزمة B، المواصفة §3.4؛ قرار المالك: «الترحيل مباشر بلا نعم»).
 *
 * ثلاثة قيود فقط — لا «قيد يومية حرّ» في الإصدار الأول:
 *   - مصروف: مدين حساب المصروف (من دليل الشركة بالتصنيف، أو برمزٍ يذكره المستخدم) [+ مدين ضريبة المدخلات]
 *     / دائن النقد أو النثريات أو البنك أو «مصروفات مستحقة» 213002.
 *   - رواتب شهر: مدين 611001 (المناديب) أو 621001 (الإداريون) / دائن النقد أو البنك أو 213001 (رواتب مستحقة)؛
 *     والتأمينات الاجتماعية (اختيارية): مدين 621002 / دائن 213003. صرفُ رواتب شهرٍ مسجّلةٍ مستحقة يُرفض (سدادٌ لا مصروف).
 *   - سداد مستحق: مدين 213001 (رواتب) أو 213003 (تأمينات) أو 213002 (مصروفات آجلة) / دائن النقد أو البنك — بحدّ رصيد
 *     الالتزام (لا يصير له رصيد مدين). كل التزامٍ تُرحّل إليه الأدوات له سداده فلا يُحمَّل المصروف مرتين.
 *
 * ضوابط الدقة (وعدٌ للمالك):
 *   - **حارس المبلغ:** كل مبلغ يمرّره النموذج يجب أن يرد حرفياً في رسالة المستخدم بعد توحيد الأرقام الهندية والفواصل
 *     العربية وفواصل الآلاف — وإلا يُرفض الترحيل ويُسأل المستخدم (حماية من مبلغٍ متوهَّم مع الترحيل المباشر). التواريخ
 *     وأرقام الأشهر لا تُعدّ مبالغ، والضريبة فوق المبلغ تُقبل بإجماليٍّ كتبه المستخدم أو بنصّه «قبل الضريبة» وحده.
 *   - **عدم التكرار:** إعادة إرسال الطلب نفسه تعيد قيده (قبل أي فحص رصيد)، ومبلغٌ ورثته رسالةٌ من سابقتها لا يكرّر قيداً
 *     مطابقاً رحّله الفاعل نفسه بطلبٍ آخر.
 *   - الحسابات يختارها النظام من دليل الشركة (مفتاح الربط ثم رمز القالب ثم حساب الدفتر الافتراضي)، لا النموذج نصاً حراً؛
 *     ولا حساب رقابياً أبداً (ذمم العملاء والموردين والعهد والأمانات والمخزون وGRNI، ولا 111003/111004)، وغياب الحساب
 *     ⇒ رفضٌ بقائمة مرشّحين يختار منها المستخدم رمزاً.
 *   - الضريبة فقط إن ذكرها المستخدم ولم تُزَل الضريبة للشركة: الوعاء + سطر ضريبة المدخلات بضريبة المشتريات الافتراضية
 *     ومربّعها (وإلا LEDGER_VAT_LINE_UNTAGGED).
 *
 * الترحيل على قالب executeClearing (routes/ledger/clearing.ts): القفل ⇒ السياق ⇒ البناء ⇒ عدم التكرار تحت القفل ⇒
 * postMove (MANUAL، REJECT) ⇒ صفّ AiAccountantPost — في معاملة واحدة. لا GlMoveSource ولا sourceType: القيد يدويّ
 * يعكسه المستخدم من الواجهة (POST /api/ledger/moves/:id/reverse).
 *
 * قيود المستندات (رفع المستندات في المحادثة، قرارات المالك ١٨ نوفمبر ٢٠٢٦ — documents/post.ts يستدعيها بلا نموذج):
 *   - مصروف (EXPENSE): مدين المصروف [+ مدين 116001 بضريبة قابلة للخصم] / دائن النقد أو البنك أو 213002 (غير مدفوعة، D6).
 *   - مدفوع مقدماً (PREPAID، D2): مدين 115002 للإيجار (115001 لغيره) [+ 116001] / دائن مصدر الدفع، وجدول الإطفاء في meta
 *     (أقساط شهرية متساوية بتقريب نصف-لأعلى والباقي على الأخير) يرحّله amortization.ts قيداً بقيد (PREPAID_AMORT).
 *   - أصل (ASSET، D3): مدين حساب الأصل من القائمة البيضاء بالرمز [+ 116001] / دائن مصدر الدفع — بلا إهلاك.
 *   - الضريبة (D7): DEDUCTIBLE سطر 116001، وNON_DEDUCTIBLE تُحمَّل على التكلفة (الإجمالي على المدين)، وNONE بلا سطر.
 *   معرّف المستند في بصمة القيد (linesFingerprint) فلا يتبادل مستندان متساويا المبلغ قيديهما في إعادة الإرسال، وخطّافاته
 *   (فحوص التكرار ونقل المرفق وربط المستند) تُنفَّذ داخل المعاملة نفسها حول postMove.
 * هذا الملف بلا prisma العام: المعاملة والتبعيات تُحقن، فيُختبر بمخزن مزيّف.
 */
import type { PostedMove } from './context';
import {
  ACCT_ASSET_CODES, ACCT_DOC_CODES, ACCT_PREPAID_MAX_MONTHS, ACCT_REFERRED_ASSET_CODES, type AiDocRefusalCode,
} from './documents/types';
import type { Prisma } from '@prisma/client';
import type { GlActor } from '../gl/audit';
import { clearingFeeTax } from '../gl/builders/clearing';
import { addDays, addMonths, compareLocalDate, endOfMonth, isLocalDate, maxLocalDate } from '../gl/dates';
import { baseFromGross, taxOnBase } from '../gl/draft';
import { fromMilli, toMilli, unitMilli } from '../gl/money';
import { acquirePostLock, postMove } from '../gl/post';
import { loadBuildContext, type GlDb, type LedgerContext } from '../gl/resolve';
import {
  isLedgerError,
  type AccountRef, type JournalSystemKey, type LineDraft, type LocalDate, type MappingKey, type Milli,
  type MoveDraft, type MoveType, type TaxRef,
} from '../gl/types';

// ═══ الثوابت ═══

/**
 * نوع صفّ AiAccountantPost: مصروف ورواتب وسداد مستحق، ومن المستندات: مدفوع مقدماً (PREPAID) وقسط إطفائه الشهري
 * (PREPAID_AMORT، صفّه يشير لأبيه parentPostId) وأصل (ASSET) — ومصروف المستند EXPENSE كمصروف المحادثة.
 */
export type AiPostKind = 'EXPENSE' | 'SALARIES' | 'SALARIES_SETTLE' | 'PREPAID' | 'PREPAID_AMORT' | 'ASSET';
export const AI_POST_KINDS: readonly AiPostKind[] = ['EXPENSE', 'SALARIES', 'SALARIES_SETTLE', 'PREPAID', 'PREPAID_AMORT', 'ASSET'];

/** إجراء التدقيق — البادئة EXPENSE_ مفتوحة في §9.3 (audit.ts OPEN_ACTION_PREFIXES) */
export const AI_POST_AUDIT_ACTION = 'EXPENSE_AI_POST';

/** أقصى عدد قيود يرحّلها طلبٌ واحد (مراجع AI-<clientRef>-1..N) — الدورة نفسها محدودة بقفزات الأدوات */
export const MAX_POSTS_PER_REQUEST = 20;

/** سقف المبلغ الواحد (حارس عقل لا قاعدة محاسبية): فوقه أرقام عشرية تفقد دقتها */
export const MAX_AMOUNT = 100_000_000_000;

/** أقدم تاريخ يُرحَّل إليه بالمحادثة (بالأيام قبل اليوم المحلي) — الأقدم يُسجَّل يدوياً من الدفاتر */
export const MAX_BACKDATE_DAYS = 366;

/** عهدة المناديب (111003) وعهدة مستخدمي الشركة (111004): لا يُصرف منها مصروف الشركة (رصيدها لأصحابها حتى التوريد) */
export const CUSTODY_ACCOUNT_CODES: readonly string[] = ['111003', '111004'];

/** مرجع القيد: 'AI-'+clientRef+'-'+n (عدم التكرار عند إعادة الإرسال) */
export const aiRefPrefix = (clientRef: string): string => `AI-${clientRef}-`;
export const aiRefOf = (clientRef: string, n: number): string => `${aiRefPrefix(clientRef)}${n}`;

interface TemplateTarget { key?: MappingKey; code: string }

/** تصنيفات المصروف ⇐ حسابات القالبين SA_6D/GENERIC_6D (coa/sa.ts) — الرواتب والتأمينات لها أداة post_salaries */
export const EXPENSE_CATEGORIES = {
  rent: { code: '621004', label: 'الإيجار' },
  utilities: { code: '621006', label: 'الكهرباء والمياه' },
  telecom: { code: '621007', label: 'الهاتف والإنترنت' },
  fuel: { key: 'FUEL', code: '611003', label: 'وقود السيارات' },
  vehicle_maintenance: { code: '611004', label: 'صيانة السيارات' },
  vehicle_insurance: { code: '611005', label: 'تأمين السيارات ورسومها' },
  advertising: { code: '611006', label: 'الدعاية والإعلان' },
  bank_fees: { key: 'BANK_FEES', code: '611008', label: 'الرسوم البنكية' },
  samples_gifts: { code: '611009', label: 'العينات والهدايا' },
  delivery: { code: '611010', label: 'نقل وشحن المبيعات' },
  commissions: { code: '611002', label: 'عمولات المبيعات' },
  staff_housing: { code: '621005', label: 'سكن الموظفين' },
  software: { code: '621008', label: 'اشتراكات البرامج' },
  office_supplies: { code: '621009', label: 'الأدوات المكتبية' },
  maintenance: { code: '621010', label: 'الصيانة والإصلاحات' },
  cleaning: { code: '621011', label: 'النظافة' },
  hospitality: { code: '621012', label: 'الضيافة' },
  government_fees: { code: '621013', label: 'الرسوم الحكومية' },
  professional_fees: { code: '621014', label: 'الأتعاب المهنية' },
  medical_insurance: { code: '621015', label: 'التأمين الطبي' },
  bonuses: { code: '621017', label: 'المكافآت' },
  outsourced: { code: '621018', label: 'الخدمات الخارجية' },
  misc: { code: '621016', label: 'مصروفات متنوعة' },
} as const satisfies Record<string, TemplateTarget & { label: string }>;
export type ExpenseCategory = keyof typeof EXPENSE_CATEGORIES;
export const EXPENSE_CATEGORY_KEYS = Object.keys(EXPENSE_CATEGORIES) as [ExpenseCategory, ...ExpenseCategory[]];

/** طرق الدفع النقدية ⇐ مفتاح الربط ثم الرمز ثم الحساب الافتراضي لدفتر النظام */
const CASH_TARGETS = {
  cash: { key: 'MAIN_CASH', code: '111001', journalKey: 'CASH_MAIN', label: 'نقداً من الصندوق' },
  petty_cash: { key: 'PETTY_CASH', code: '111002', journalKey: null, label: 'من صندوق النثريات' },
  bank: { key: 'MAIN_BANK', code: '111101', journalKey: 'BANK_MAIN', label: 'من البنك' },
} as const satisfies Record<string, TemplateTarget & { journalKey: JournalSystemKey | null; label: string }>;
export type CashSource = keyof typeof CASH_TARGETS;

/** حسابات الرواتب والالتزامات (coa/sa.ts) */
export const SALARY_ACCOUNTS = {
  reps: { code: '611001', label: 'المناديب' },
  admin: { code: '621001', label: 'الموظفين الإداريين' },
  gosi: { code: '621002', label: 'التأمينات الاجتماعية' },
} as const;
export const SALARIES_PAYABLE: TemplateTarget = { code: '213001' };
export const GOSI_PAYABLE: TemplateTarget = { code: '213003' };
export const ACCRUED_EXPENSES: TemplateTarget = { key: 'ACCRUED_EXPENSES', code: '213002' };

const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

// ═══ الرفض ═══

export type AiRefusalCode =
  | 'WRITE_DISABLED' | 'NOT_ALLOWED' | 'NOT_ACTIVATED' | 'CLIENT_REF_MISSING'
  | 'AMOUNT_INVALID' | 'AMOUNT_NOT_IN_MESSAGE' | 'AMOUNT_PRECISION'
  | 'ACCOUNT_MISSING' | 'ACCOUNT_NOT_ALLOWED' | 'JOURNAL_MISSING'
  | 'LEDGER_VAT_LINE_UNTAGGED' | 'VAT_RATE_MISMATCH' | 'VAT_INVALID'
  | 'DATE_INVALID' | 'DATE_FUTURE' | 'DATE_TOO_OLD' | 'MONTH_INVALID' | 'MONTH_FUTURE'
  | 'EXCEEDS_PAYABLE' | 'LEDGER_PERIOD_LOCKED' | 'LEDGER_ERROR' | 'TOO_MANY_POSTS' | 'POST_FAILED'
  | 'VAT_BASIS_UNCLEAR' | 'PAYABLE_OUTSTANDING' | 'SALARIES_ALREADY_ACCRUED' | 'DUPLICATE_RECENT'
  // ترحيل المستندات (documents/types.ts AI_DOC_REFUSALS)
  | AiDocRefusalCode;

/** رفضٌ يُشرح للمستخدم: رسالة عربية وتفاصيل (لا مبلغ متوهَّم فيها) */
export interface AiRefusal {
  code: AiRefusalCode;
  message: string;
  details?: Record<string, unknown>;
}

/** يُرمى داخل المعاملة فيُسقطها، ويحوَّل خارجها إلى نتيجة أداة «لم يُرحَّل» */
export class AiPostRefusal extends Error {
  readonly refusal: AiRefusal;
  constructor(refusal: AiRefusal) {
    super(refusal.code);
    this.name = 'AiPostRefusal';
    this.refusal = refusal;
    Object.setPrototypeOf(this, AiPostRefusal.prototype);
  }
}

const refuse = (code: AiRefusalCode, message: string, details?: Record<string, unknown>): AiRefusal =>
  (details ? { code, message, details } : { code, message });

// ═══ حارس المبلغ ═══

const DIGIT_MAP: Readonly<Record<string, string>> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

/**
 * توحيد النص للمطابقة: الأرقام الهندية والفارسية لاتينية، والفاصلة العشرية العربية «٫» نقطة، وفاصل الآلاف العربي «٬»
 * محذوف، والفاصلة (اللاتينية أو العربية «،») بين رقمٍ وثلاث خانات محذوفة («1,500» و«١٬٥٠٠» ⇒ 1500).
 * محافظ عمداً: المسافة فاصلاً («1 500») والفاصلة العشرية الأوروبية لا تُوحَّدان — فيُسأل المستخدم لا يُخمَّن.
 */
export function normalizeAmountText(s: string): string {
  return (s || '')
    .replace(/[٠-٩۰-۹]/g, (d) => DIGIT_MAP[d] ?? d)
    .replace(/(\d)٫(?=\d)/g, '$1.')
    .replace(/(\d)٬(?=\d)/g, '$1')
    .replace(/(\d)[,،](?=\d{3}(?!\d))/g, '$1');
}

/**
 * التواريخ وأرقام الأشهر والسنوات ليست مبالغ: «2026-10-01» و«31/10/2026» و«10/2026» و«18/11» و«شهر 11» و«سنة 2026» تُمحى
 * (بمسافة) من النص الموحَّد قبل استخراج المبالغ — فلا يصير رقم شهرٍ أو تاريخٍ «مبلغاً كتبه المستخدم» (رواتب شهر 11 بلا مبلغ
 * ⇒ لا يُقبل 11، وتقرير «من 2026-10-01» ⇒ لا يُقبل 2026 ولا 10).
 */
export function stripDateTokens(normalized: string): string {
  return normalized
    .replace(/\b\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?\b/g, ' ')
    .replace(/\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b/g, ' ')
    .replace(/\b\d{1,2}[-/]\d{4}\b/g, ' ')
    .replace(/\b\d{1,2}[-/]\d{1,2}\b/g, ' ')
    .replace(/شهر\s*\d{1,2}(?!\d)/g, ' ')
    .replace(/(?:سنة|عام)\s*\d{4}(?!\d)/g, ' ');
}

/** كل المبالغ المكتوبة بالأرقام في نص المستخدم (ملّي بدقة الألف) — بلا التواريخ وأرقام الأشهر (stripDateTokens) */
export function amountsInText(text: string): Milli[] {
  const out: Milli[] = [];
  for (const m of stripDateTokens(normalizeAmountText(text)).matchAll(/\d+(?:\.\d+)?/g)) {
    try {
      out.push(toMilli(m[0], 3));
    } catch { /* رقم لا يُحلَّل لا يصلح مطابقةً */ }
  }
  return out;
}

/** المبلغ ورد حرفياً في رسالة المستخدم؟ (مقارنة رقمية بعد التوحيد: «1500» = «1,500.00» = «١٥٠٠») */
export function amountInUserText(amountMilli: Milli, userText: string): boolean {
  return amountsInText(userText).some((a) => a === amountMilli);
}

/** مبلغ وسيط الأداة (رقم أو نص بأرقام عربية/فواصل) ⇐ ملّي موجب، أو null إن لم يصلح */
export function parseAmountArg(v: unknown): Milli | null {
  let s: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    s = String(v);
  } else if (typeof v === 'string') {
    s = normalizeAmountText(v.trim()).replace(/[\s,]/g, '');
  } else return null;
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  let m: Milli;
  try {
    m = toMilli(s, 3);
  } catch {
    return null;
  }
  if (m <= 0n || m > BigInt(MAX_AMOUNT) * 1000n) return null;
  return m;
}

/** ملّي ⇐ نص عرض بفواصل الآلاف ومنازل العملة (1,500.00) */
export function formatAmount(milli: Milli, decimals: number): string {
  return fromMilli(milli).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// ═══ التواريخ والأشهر ═══

/** تاريخ القيد: صيغة صحيحة، لا مستقبل، ولا أقدم من MAX_BACKDATE_DAYS — null إن صلح */
export function postingDateProblem(date: unknown, todayLocal: LocalDate): AiRefusal | null {
  if (!isLocalDate(date)) return refuse('DATE_INVALID', 'تاريخ القيد غير صالح: اذكره بصيغة سنة-شهر-يوم.');
  if (compareLocalDate(date, todayLocal) > 0) {
    return refuse('DATE_FUTURE', `لا يُرحَّل قيد بتاريخ مستقبلي (${date})؛ اليوم ${todayLocal}.`, { date, today: todayLocal });
  }
  const oldest = addDays(todayLocal, -MAX_BACKDATE_DAYS);
  if (compareLocalDate(date, oldest) < 0) {
    return refuse('DATE_TOO_OLD', `التاريخ ${date} أقدم من سنة؛ سجّل القيود القديمة يدوياً من الدفاتر أو راجع محاسبك.`, { date, oldest });
  }
  return null;
}

export interface ResolvedMonth { ym: string; firstDay: LocalDate; label: string }

/**
 * شهر الرواتب: 'YYYY-MM' أو 'MM/YYYY' أو 'MM' وحده (أحدث شهرٍ بهذا الرقم لم يأتِ بعد: «شهر 12» في يناير = ديسمبر الماضي).
 * الشهر الذي لم يبدأ بعد يُرفض (MONTH_FUTURE)، والصيغة غير المفهومة MONTH_INVALID.
 */
export function resolveSalaryMonth(raw: unknown, todayLocal: LocalDate): ResolvedMonth | AiRefusal {
  const s = normalizeAmountText(String(raw ?? '').trim());
  const ty = Number(todayLocal.slice(0, 4));
  const tm = Number(todayLocal.slice(5, 7));
  let y: number;
  let m: number;
  let mm: RegExpExecArray | null;
  if ((mm = /^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?$/.exec(s))) { y = Number(mm[1]); m = Number(mm[2]); }
  else if ((mm = /^(\d{1,2})[-/](\d{4})$/.exec(s))) { y = Number(mm[2]); m = Number(mm[1]); }
  else if ((mm = /^(\d{1,2})$/.exec(s))) { m = Number(mm[1]); y = m > tm ? ty - 1 : ty; }
  else return refuse('MONTH_INVALID', 'لم أفهم شهر الرواتب: اذكره رقماً مثل 11 أو 2026-11.');
  if (!(m >= 1 && m <= 12) || !(y >= 2000 && y <= 2100)) return refuse('MONTH_INVALID', 'شهر الرواتب غير صالح: اذكره رقماً من 1 إلى 12.');
  const ym = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
  if (ym > todayLocal.slice(0, 7)) {
    return refuse('MONTH_FUTURE', `شهر ${MONTHS_AR[m - 1]} ${y} لم يبدأ بعد؛ لا تُسجَّل رواتبه مقدّماً من المحادثة.`, { month: ym });
  }
  return { ym, firstDay: `${ym}-01`, label: `${MONTHS_AR[m - 1]} ${y}` };
}

const isRefusal = (v: unknown): v is AiRefusal =>
  !!v && typeof v === 'object' && typeof (v as AiRefusal).code === 'string' && typeof (v as AiRefusal).message === 'string';

// ═══ حلّ الحسابات من دليل الشركة ═══

export type PlanLedger = Pick<LedgerContext, 'ctx' | 'accounts' | 'journals'>;
export type BooksModeLike = 'NONE' | 'MANUAL' | 'LINKED' | 'LEGACY' | string;

export type AccountProblem = 'MISSING' | 'ARCHIVED' | 'CONTROL' | 'CUSTODY' | 'WRONG_TYPE' | 'REFERRED' | 'LINKED_COST';

/**
 * حسابات مصروف لقيود يقرّرها المحاسب البشري (المواصفة §٢: لا إهلاك ولا مخصصات ولا تسويات جرد): التكلفة والمخزون
 * وتسوياته، والديون المعدومة ومخصصها، وخسائر الأصول والعملة والخصم المبكر والتقريب، وعبء نهاية الخدمة — بمفتاح الربط
 * أولاً (الشركة قد تغيّر الرمز) ثم رمز القالب لما لا مفتاح له.
 */
export const REFERRED_EXPENSE_KEYS: readonly MappingKey[] = [
  'COGS', 'PURCHASE_RETURNS', 'INVENTORY_CHANGE', 'INVENTORY_WRITEOFF', 'INVENTORY_ADJUSTMENT',
  'BAD_DEBT', 'ASSET_LOSS', 'EARLY_DISCOUNT_LOSS', 'FX_LOSS', 'ROUNDING',
];
export const REFERRED_EXPENSE_CODES: readonly string[] = ['711006', '621003'];

/** معرّفات حسابات «للمحاسب البشري» في شجرة الشركة */
export function referredExpenseIds(lc: Pick<LedgerContext, 'ctx'>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const k of REFERRED_EXPENSE_KEYS) {
    const a = lc.ctx.accounts.byKey(k);
    if (a) out.add(a.id);
  }
  for (const c of REFERRED_EXPENSE_CODES) {
    const a = lc.ctx.accounts.byCode(c);
    if (a) out.add(a.id);
  }
  return out;
}

/**
 * حساب مصروف يقبله المحاسب الذكي: نشط، بلا controlKind، من نوع expense*؛ عدا الإهلاك والزكاة وحسابات «للمحاسب البشري»
 * (referred)، وعدا «التكلفة المباشرة» في الدفاتر المربوطة (المشتريات والتكلفة تُرحَّل آلياً من المستودع هناك فيتكرّر الحمل).
 */
export function expenseAccountProblem(
  a: AccountRef | null | undefined, booksMode: BooksModeLike, referred: ReadonlySet<string> = new Set(),
): AccountProblem | null {
  if (!a) return 'MISSING';
  if (!a.isActive) return 'ARCHIVED';
  if (a.controlKind !== null) return 'CONTROL';
  if (!a.type.startsWith('expense')) return 'WRONG_TYPE';
  if (a.type === 'expense_depreciation' || a.type === 'expense_zakat' || referred.has(a.id)) return 'REFERRED';
  if (a.type === 'expense_direct_cost' && booksMode === 'LINKED') return 'LINKED_COST';
  return null;
}

/** حساب نقد أو بنك يُدفع منه: asset_cash نشط بلا controlKind، وليس عهدة 111003/111004 */
export function cashAccountProblem(a: AccountRef | null | undefined): AccountProblem | null {
  if (!a) return 'MISSING';
  if (!a.isActive) return 'ARCHIVED';
  if (CUSTODY_ACCOUNT_CODES.includes(a.code)) return 'CUSTODY';
  if (a.controlKind !== null) return 'CONTROL';
  if (a.type !== 'asset_cash') return 'WRONG_TYPE';
  return null;
}

/** التزام عام (رواتب/تأمينات/مصروفات مستحقة): liability_current|non_current نشط بلا controlKind */
export function liabilityAccountProblem(a: AccountRef | null | undefined): AccountProblem | null {
  if (!a) return 'MISSING';
  if (!a.isActive) return 'ARCHIVED';
  if (a.controlKind !== null) return 'CONTROL';
  if (a.type !== 'liability_current' && a.type !== 'liability_non_current') return 'WRONG_TYPE';
  return null;
}

const PROBLEM_AR: Readonly<Record<AccountProblem, string>> = {
  MISSING: 'غير موجود في دليل حساباتك',
  ARCHIVED: 'مؤرشف',
  CONTROL: 'حساب رئيسي يغذّيه مصدره وحده (لا يُرحَّل إليه يدوياً)',
  CUSTODY: 'حساب عهدة لا يُصرف منه مصروف الشركة',
  WRONG_TYPE: 'من نوع لا يصلح لهذا القيد',
  REFERRED: 'لقيود يقرّرها محاسبك البشري (إهلاك أو مخصص أو تسوية جرد أو زكاة)',
  LINKED_COST: 'حساب تكلفة يُرحَّل آلياً من المستودع في الدفاتر المربوطة',
};

const byCode = (a: { code: string }, b: { code: string }) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

/** المرشّحون حين يغيب الحساب: ما يقبله الحارس نفسه، بالرمز، بحدّ limit */
export function expenseCandidates(lc: PlanLedger, booksMode: BooksModeLike, limit = 40): { code: string; name: string }[] {
  const referred = referredExpenseIds(lc);
  return lc.accounts.filter((a) => expenseAccountProblem(a, booksMode, referred) === null).sort(byCode).slice(0, limit)
    .map((a) => ({ code: a.code, name: a.name }));
}

export function cashCandidates(lc: PlanLedger, limit = 20): { code: string; name: string }[] {
  return lc.accounts.filter((a) => cashAccountProblem(a) === null).sort(byCode).slice(0, limit)
    .map((a) => ({ code: a.code, name: a.name }));
}

/** أول مرشّح صالح من (مفتاح الربط، رمز القالب، إضافات) — وإلا مشكلة أول موجود (أو MISSING) */
function pickAccount(
  candidates: readonly (AccountRef | null | undefined)[], problemOf: (a: AccountRef | null | undefined) => AccountProblem | null,
): { account: AccountRef } | { problem: AccountProblem; account: AccountRef | null } {
  const seen = new Set<string>();
  let first: AccountRef | null = null;
  for (const a of candidates) {
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    if (!first) first = a;
    if (problemOf(a) === null) return { account: a };
  }
  return { problem: first ? (problemOf(first) ?? 'MISSING') : 'MISSING', account: first };
}

const targetAccounts = (lc: PlanLedger, t: TemplateTarget): (AccountRef | null)[] =>
  [t.key ? lc.ctx.accounts.byKey(t.key) : null, lc.ctx.accounts.byCode(t.code)];

/** حساب المصروف: رمزٌ ذكره المستخدم (حارس النوع والرقابة)، أو التصنيف ⇐ مفتاح الربط ثم رمز القالب */
export function resolveExpenseAccount(
  lc: PlanLedger, sel: { category?: ExpenseCategory | null; accountCode?: string | null }, booksMode: BooksModeLike,
): AccountRef | AiRefusal {
  const referred = referredExpenseIds(lc);
  const code = sel.accountCode?.trim();
  if (code) {
    const a = lc.ctx.accounts.byCode(code);
    const p = expenseAccountProblem(a, booksMode, referred);
    if (p === null && a) return a;
    return refuse(p === 'MISSING' ? 'ACCOUNT_MISSING' : 'ACCOUNT_NOT_ALLOWED',
      `الحساب ${code}${a ? ` (${a.name})` : ''} ${PROBLEM_AR[p ?? 'MISSING']}. اختر حساب مصروف من القائمة واذكر رمزه.`,
      { accountCode: code, problem: p, candidates: expenseCandidates(lc, booksMode) });
  }
  const cat = sel.category ? EXPENSE_CATEGORIES[sel.category] : null;
  if (!cat) {
    return refuse('ACCOUNT_MISSING', 'لم يُحدَّد نوع المصروف: اسأل المستخدم عن نوعه أو رمز حسابه.',
      { candidates: expenseCandidates(lc, booksMode) });
  }
  const picked = pickAccount(targetAccounts(lc, cat), (a) => expenseAccountProblem(a, booksMode, referred));
  if ('problem' in picked) {
    return refuse(picked.problem === 'MISSING' ? 'ACCOUNT_MISSING' : 'ACCOUNT_NOT_ALLOWED',
      `حساب «${cat.label}» (${cat.code}) ${PROBLEM_AR[picked.problem]}. اختر حساب المصروف المناسب من القائمة واذكر رمزه.`,
      { category: sel.category, templateCode: cat.code, problem: picked.problem, candidates: expenseCandidates(lc, booksMode) });
  }
  return picked.account;
}

export interface PaymentTarget {
  account: AccountRef;
  /** وصف عربي قصير للسطر والملخّص («نقداً من الصندوق»، «من البنك»، «مستحق الدفع») */
  label: string;
  /** حساب نقد/بنك ⇒ دفتره؛ الالتزام ⇒ null (الدفتر المتنوّع) */
  cash: boolean;
}

/** حساب الدفع النقدي: رمز اختاره المستخدم (نقد/بنك غير رقابي) أو الطريقة ⇐ المفتاح ثم الرمز ثم حساب دفتر النظام */
export function resolveCashAccount(lc: PlanLedger, source: CashSource, accountCode?: string | null): PaymentTarget | AiRefusal {
  const code = accountCode?.trim();
  if (code) {
    const a = lc.ctx.accounts.byCode(code);
    const p = cashAccountProblem(a);
    if (p === null && a) return { account: a, label: `من ${a.name}`, cash: true };
    return refuse(p === 'MISSING' ? 'ACCOUNT_MISSING' : 'ACCOUNT_NOT_ALLOWED',
      `حساب الدفع ${code}${a ? ` (${a.name})` : ''} ${PROBLEM_AR[p ?? 'MISSING']}. اختر صندوقاً أو بنكاً من القائمة.`,
      { accountCode: code, problem: p, candidates: cashCandidates(lc) });
  }
  const t = CASH_TARGETS[source];
  const journal = t.journalKey ? lc.ctx.journals.bySystemKey(t.journalKey) : null;
  const viaJournal = journal?.defaultAccountId ? lc.ctx.accounts.byId(journal.defaultAccountId) : null;
  const picked = pickAccount([...targetAccounts(lc, t), viaJournal], cashAccountProblem);
  if ('problem' in picked) {
    return refuse(picked.problem === 'MISSING' ? 'ACCOUNT_MISSING' : 'ACCOUNT_NOT_ALLOWED',
      `حساب الدفع (${t.code}) ${PROBLEM_AR[picked.problem]}. اختر صندوقاً أو بنكاً من القائمة واذكر رمزه.`,
      { source, templateCode: t.code, problem: picked.problem, candidates: cashCandidates(lc) });
  }
  return { account: picked.account, label: t.label, cash: true };
}

/** التزام بالمفتاح ثم الرمز — وغيابه رفضٌ يطلب إنشاء الحساب (لا بديل صامت لحساب التزام آخر) */
export function resolveLiability(lc: PlanLedger, t: TemplateTarget, what: string): AccountRef | AiRefusal {
  const picked = pickAccount(targetAccounts(lc, t), liabilityAccountProblem);
  if ('problem' in picked) {
    return refuse(picked.problem === 'MISSING' ? 'ACCOUNT_MISSING' : 'ACCOUNT_NOT_ALLOWED',
      `حساب «${what}» (${t.code}) ${PROBLEM_AR[picked.problem]}. أضفه أو فعّله في دليل الحسابات ثم أعد الطلب.`,
      { templateCode: t.code, problem: picked.problem });
  }
  return picked.account;
}

/** حساب مصروف ثابت (الرواتب والتأمينات) بالرمز */
function resolveFixedExpense(lc: PlanLedger, code: string, what: string, booksMode: BooksModeLike): AccountRef | AiRefusal {
  const a = lc.ctx.accounts.byCode(code);
  const p = expenseAccountProblem(a, booksMode, referredExpenseIds(lc));
  if (p === null && a) return a;
  return refuse(p === 'MISSING' ? 'ACCOUNT_MISSING' : 'ACCOUNT_NOT_ALLOWED',
    `حساب «${what}» (${code}) ${PROBLEM_AR[p ?? 'MISSING']}. أضفه أو فعّله في دليل الحسابات ثم أعد الطلب.`,
    { templateCode: code, problem: p });
}

export interface JournalChoice { journalCode: string; journalSystemKey?: JournalSystemKey }

/**
 * دفتر القيد: دفتر BANK/CASH نشط حسابه الافتراضي هو حساب الدفع (البنك أولاً، كـbankJournalCodeFor)، وإلا «عمليات متنوعة»
 * MISC ثم «المصروفات» EXPENSES — null إن غابت كلها.
 */
export function journalFor(lc: PlanLedger, cashAccountId: string | null): JournalChoice | null {
  if (cashAccountId) {
    const own = lc.journals.filter((j) => j.isActive && j.defaultAccountId === cashAccountId && (j.type === 'BANK' || j.type === 'CASH'));
    const j = own.find((x) => x.type === 'BANK') ?? own[0];
    if (j) return { journalCode: j.code };
  }
  for (const key of ['MISC', 'EXPENSES'] as const) {
    const j = lc.ctx.journals.bySystemKey(key);
    if (j && j.isActive) return { journalCode: j.code, journalSystemKey: key };
  }
  return null;
}

// ═══ بناء القيود (صرفة) ═══

export interface PlanLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  debitMilli: Milli;
  creditMilli: Milli;
}

export interface AiPostPlan {
  kind: AiPostKind;
  /** المسودة بلا ref — المرجع يُختار تحت القفل */
  draft: MoveDraft;
  /** قيمة القيد = Σ المدين */
  totalMilli: Milli;
  summaryAr: string;
  lines: PlanLine[];
  /** سداد المستحق: لا يتجاوز رصيد الالتزام (hint: إرشاد الرفض لغير الرواتب) */
  payableCheck?: { accountId: string; accountName: string; amountMilli: Milli; hint?: string };
  /**
   * مصروفٌ لعلّه سُجّل مستحقاً من قبل (التأمينات، والرواتب المدفوعة نقداً أو بنكاً): يُرفض تحت القفل — لقيدٍ جديد وحده — إن
   * وُجد استحقاقٌ مطابق من المحاسب الذكي لم يُعكس (accrualSummaryPrefix: بداية ملخّص قيد الاستحقاق، بسطرٍ دائن على الالتزام)،
   * أو كان للالتزام رصيدٌ دائن ≥ minMilli (null ⇒ لا فحص رصيد: أكّد المستخدم أنها لم تُسجَّل مستحقة).
   */
  accruedCheck?: {
    accountId: string;
    accountName: string;
    minMilli: Milli | null;
    code: AiRefusalCode;
    message: string;
    accrualSummaryPrefix?: string;
  };
  warnings: string[];
  /** قيدٌ من مستند: معرّفه في البصمة وفي صفّ AiAccountantPost (docId) */
  docId?: string;
  /** قسط إطفاء: صفّ قيد الدفع المقدّم الذي يُطفأ */
  parentPostId?: string;
  /** جدول الإطفاء لقيد PREPAID (PrepaidSchedule) — يُخزَّن في صفّه كما هو */
  meta?: PrepaidSchedule;
}

/**
 * جدول إطفاء المدفوع مقدماً (D2) — في AiAccountantPost.meta لقيد PREPAID. المبالغ ملّي نصوصاً (JSON لا يحمل BigInt):
 * القسط الشهري = الأساس ÷ الأشهر مقرَّباً نصف-لأعلى إلى منازل العملة، والأخير يأخذ الباقي (Σ الأقساط = الأساس بالضبط).
 * startYm أول شهر خدمة (YYYY-MM)؛ قسط الشهر k يُرحَّل بتاريخ آخر يومٍ فيه (ولا يسبق تاريخ قيد الدفع).
 */
export interface PrepaidSchedule {
  months: number;
  baseMilli: string;
  monthlyMilli: string;
  lastMilli: string;
  startYm: string;
  prepaidCode: string;
  expenseCode: string;
  /** وصف المستند للسطور («فاتورة إيجار — مؤسسة …») */
  what: string;
  /** آخر تخطٍّ لفترة مقفلة (amortization.ts) — يظهر تنبيهاً في قائمة القيود حتى يُرحَّل ذلك الشهر */
  lockedSkip?: { k: number; date: string; at: string } | null;
}

export type PlanOutcome = { ok: true; plan: AiPostPlan } | { ok: false; refusal: AiRefusal };

export interface PlanEnv {
  lc: PlanLedger;
  booksMode: BooksModeLike;
  currency: string;
  taxDisabled: boolean;
}

const fail = (refusal: AiRefusal): PlanOutcome => ({ ok: false, refusal });

/** نص حرّ من المستخدم في وصف/اسم: سطر واحد بلا محارف تحكّم وبحدّ طول */
export function cleanText(s: string | null | undefined, max = 160): string {
  // eslint-disable-next-line no-control-regex
  return (s ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function precisionProblem(amountMilli: Milli, decimals: number, field: string): AiRefusal | null {
  if (amountMilli % unitMilli(decimals) === 0n) return null;
  return refuse('AMOUNT_PRECISION', `المبلغ بمنازل عشرية أكثر مما تسمح به عملة الدفاتر (${decimals}).`, { field, decimals });
}

function planLine(a: AccountRef, debitMilli: Milli, creditMilli: Milli): PlanLine {
  return { accountId: a.id, accountCode: a.code, accountName: a.name, debitMilli, creditMilli };
}

function moveDraft(
  env: PlanEnv, j: JournalChoice, moveType: MoveType, date: LocalDate, narration: string, lines: LineDraft[],
): MoveDraft {
  const s = env.lc.ctx.settings;
  return {
    kind: 'MOVE',
    journalCode: j.journalCode,
    ...(j.journalSystemKey ? { journalSystemKey: j.journalSystemKey } : {}),
    moveType,
    origin: 'MANUAL',
    date,
    originalDate: null,
    lateArrival: false,
    ref: null,
    narration,
    needsAttention: false,
    attentionReason: null,
    // لا مصدر: القيد يدويّ يعكسه المستخدم من الواجهة (manualOwnership = null)
    sourceType: null,
    sourceId: null,
    sourceKey: null,
    sourceEvent: null,
    currencyCode: s.currency,
    currencyDecimals: s.currencyDecimals,
    lines,
  };
}

/** خطة سطور العرض من سطور المسودة (الحساب محلول بمعرّفه) */
function planLinesOf(env: PlanEnv, lines: LineDraft[]): PlanLine[] {
  return lines.map((l) => {
    const a = l.accountId ? env.lc.ctx.accounts.byId(l.accountId) : null;
    return { accountId: l.accountId ?? '', accountCode: a?.code ?? '', accountName: a?.name ?? '', debitMilli: l.debitMilli, creditMilli: l.creditMilli };
  });
}

export interface ExpenseInput {
  amountMilli: Milli;
  category?: ExpenseCategory | null;
  accountCode?: string | null;
  paidFrom: CashSource | 'payable';
  paidFromAccountCode?: string | null;
  /** حاضرٌ ⇒ ذكر المستخدم الضريبة: included = المبلغ شامل الضريبة؛ rate للتحقق؛ amountMilli ضريبة صريحة ذكرها */
  vat?: { included: boolean; rate?: number | null; amountMilli?: Milli | null } | null;
  date: LocalDate;
  description: string;
  vendorName?: string | null;
}

/**
 * قيد المصروف (صرف): مدين المصروف بالوعاء (BASE بضريبته إن وُجدت) [+ مدين ضريبة المدخلات بمربّعها] / دائن مصدر الدفع
 * بالإجمالي. الدفتر: دفتر الصندوق/البنك المدفوع منه، وإلا «عمليات متنوعة».
 */
export function buildExpensePlan(env: PlanEnv, input: ExpenseInput): PlanOutcome {
  const { lc } = env;
  const dec = lc.ctx.settings.currencyDecimals;
  const amount = input.amountMilli;
  if (amount <= 0n) return fail(refuse('AMOUNT_INVALID', 'المبلغ يجب أن يكون أكبر من صفر.'));
  const pp = precisionProblem(amount, dec, 'amount');
  if (pp) return fail(pp);

  const expense = resolveExpenseAccount(lc, input, env.booksMode);
  if (isRefusal(expense)) return fail(expense);

  let pay: PaymentTarget;
  if (input.paidFrom === 'payable') {
    const acc = resolveLiability(lc, ACCRUED_EXPENSES, 'مصروفات مستحقة');
    if (isRefusal(acc)) return fail(acc);
    pay = { account: acc, label: 'مستحق الدفع', cash: false };
  } else {
    const r = resolveCashAccount(lc, input.paidFrom, input.paidFromAccountCode);
    if (isRefusal(r)) return fail(r);
    pay = r;
  }
  const journal = journalFor(lc, pay.cash ? pay.account.id : null);
  if (!journal) return fail(refuse('JOURNAL_MISSING', 'لا يوجد دفتر نشط للصندوق أو البنك ولا دفتر «عمليات متنوعة» لترحيل القيد.'));

  // الضريبة: فقط إن ذكرها المستخدم ولم تُزَل الضريبة للشركة
  const warnings: string[] = [];
  let base = amount;
  let vat = 0n;
  let tax: TaxRef | null = null;
  if (input.vat && env.taxDisabled) {
    warnings.push('الضريبة مُزالة في إعدادات الشركة، فسُجّل المبلغ كما ذُكر بلا فصل ضريبة.');
  } else if (input.vat) {
    tax = clearingFeeTax(lc.ctx);
    if (!tax) {
      return fail(refuse('LEDGER_VAT_LINE_UNTAGGED',
        'لا توجد ضريبة مشتريات نشطة بمربّع إقرار في دفاترك لفصل ضريبة المدخلات. سجّل المبلغ بلا ضريبة أو فعّل ضريبة المشتريات الافتراضية.'));
    }
    if (input.vat.rate !== null && input.vat.rate !== undefined && Math.abs(input.vat.rate - tax.rate) > 1e-9) {
      return fail(refuse('VAT_RATE_MISMATCH',
        `نسبة الضريبة المذكورة ${input.vat.rate}٪ لا تطابق ضريبة المشتريات في دفاترك (${tax.rate}٪). تأكّد من المستخدم.`,
        { rate: input.vat.rate, taxRate: tax.rate }));
    }
    const explicit = input.vat.amountMilli ?? null;
    if (explicit !== null) {
      const vp = precisionProblem(explicit, dec, 'vat.amount');
      if (vp) return fail(vp);
      if (explicit <= 0n || (input.vat.included && explicit >= amount)) {
        return fail(refuse('VAT_INVALID', 'مبلغ الضريبة المذكور لا يتّسق مع المبلغ الإجمالي. تأكّد منه مع المستخدم.'));
      }
      vat = explicit;
      base = input.vat.included ? amount - explicit : amount;
      // ضريبةٌ تفوق نسبتها على الوعاء (بهامش وحدة تقريب) خطأٌ في المدخل لا في الحساب
      if (vat > taxOnBase(base, tax.rate, dec) + unitMilli(dec)) {
        return fail(refuse('VAT_INVALID', `مبلغ الضريبة المذكور أكبر من ${tax.rate}٪ من الوعاء. تأكّد منه مع المستخدم.`, { taxRate: tax.rate }));
      }
    } else if (input.vat.included) {
      base = baseFromGross(amount, tax.rate, dec);
      vat = amount - base;
    } else {
      vat = taxOnBase(amount, tax.rate, dec);
    }
    // مبلغ صغير تُقرَّب ضريبته إلى صفر: لا سطر ضريبة والمبلغ كله وعاء
    if (vat <= 0n) { tax = null; vat = 0n; base = amount; }
  }
  const total = base + vat;

  const description = cleanText(input.description) || EXPENSE_CATEGORIES[input.category ?? 'misc']?.label || expense.name;
  const vendor = cleanText(input.vendorName, 120);
  const vendorPart = vendor ? ` — ${vendor}` : '';
  const lines: LineDraft[] = [{
    accountId: expense.id,
    label: `${expense.name}: ${description}${vendorPart}`,
    debitMilli: base,
    creditMilli: 0n,
    ...(tax ? { taxId: tax.id, taxRole: 'BASE' as const } : {}),
  }];
  if (tax && vat > 0n) {
    const vatAccount = tax.accountId ? lc.ctx.accounts.byId(tax.accountId) : lc.ctx.accounts.byKey('INPUT_VAT');
    if (!vatAccount) {
      return fail(refuse('LEDGER_VAT_LINE_UNTAGGED', 'حساب ضريبة المدخلات غير موجود في دليل حساباتك. سجّل المبلغ بلا ضريبة أو راجع إعداد الضرائب.'));
    }
    lines.push({
      accountId: vatAccount.id,
      label: `ضريبة القيمة المضافة على ${expense.name}`,
      debitMilli: vat,
      creditMilli: 0n,
      taxId: tax.id, taxCode: tax.key ?? null, taxRole: 'TAX', taxBaseMilli: base, vatBox: tax.vatBox,
    });
  }
  lines.push({
    accountId: pay.account.id,
    label: pay.cash ? `سداد ${expense.name} ${pay.label}` : `${expense.name} مستحق الدفع${vendorPart}`,
    debitMilli: 0n,
    creditMilli: total,
  });

  const cur = env.currency;
  const vatPart = vat > 0n ? ` (منها ضريبة ${formatAmount(vat, dec)})` : '';
  const summaryAr = `مصروف ${expense.name}: ${formatAmount(total, dec)} ${cur}${vatPart} ${pay.label} — ${description}`;
  const draft = moveDraft(env, journal, 'EXPENSE', input.date, `مصروف ${expense.name}: ${description}${vendorPart} (المحاسب الذكي)`, lines);
  const plan: AiPostPlan = { kind: 'EXPENSE', draft, totalMilli: total, summaryAr, lines: planLinesOf(env, lines), warnings };
  // التأمينات الاجتماعية مصروفاً والتزامها 213003 قائم: دفعٌ لمستحقٍّ سُجّل مع الرواتب لا مصروف جديد (لا يتكرّر الحمل)
  const gosiExpense = lc.ctx.accounts.byCode(SALARY_ACCOUNTS.gosi.code);
  if (gosiExpense && gosiExpense.id === expense.id) {
    const gp = resolveLiability(lc, GOSI_PAYABLE, 'التأمينات الاجتماعية المستحقة');
    if (!isRefusal(gp)) {
      plan.accruedCheck = {
        accountId: gp.id, accountName: gp.name, minMilli: 1n, code: 'PAYABLE_OUTSTANDING',
        message: `للتأمينات الاجتماعية رصيدٌ مستحق في «${gp.name}» سُجّل مع الرواتب؛ دفعها سدادٌ لهذا المستحق لا مصروفٌ جديد يكرّر حملها. اطلب «سداد التأمينات المستحقة» بالمبلغ وطريقة الدفع.`,
      };
    }
  }
  return { ok: true, plan };
}

/** «الضريبة فوق المبلغ» صراحةً في نص المستخدم: قبل الضريبة، غير شامل، + الضريبة، زائد الضريبة، الضريبة فوقه/زيادة */
export const VAT_ON_TOP_RE = /قبل\s*(?:ال)?ضريبة|غير\s*شامل|\+\s*(?:ال)?ضريبة|زائد\s*(?:ال)?ضريبة|(?:ال)?ضريبة\s*(?:فوق|زيادة)|excl(?:uding|\.)?\s*vat|\+\s*vat/i;

/**
 * الضريبة فوق المبلغ بلا مبلغ ضريبة صريح يجعل دائن النقد/البنك = المبلغ + ضريبته — رقمٌ لم يكتبه المستخدم. يُقبل فقط إن
 * ذكر المستخدم صراحةً أن مبلغه قبل الضريبة (VAT_ON_TOP_RE)، أو كتب الإجمالي نفسه بالأرقام؛ وإلا يُسأل «هل المبلغ شامل؟».
 * null ⇒ مقبول (ومنه إجماليٌّ يساوي المبلغ: ضريبة مُزالة أو مقرّبة إلى صفر).
 */
export function vatOnTopProblem(userText: string, amountMilli: Milli, totalMilli: Milli): AiRefusal | null {
  if (totalMilli === amountMilli) return null;
  if (VAT_ON_TOP_RE.test(normalizeAmountText(userText))) return null;
  if (amountInUserText(totalMilli, userText)) return null;
  return refuse('VAT_BASIS_UNCLEAR',
    'لم يتّضح هل المبلغ المذكور شامل الضريبة أم قبلها، ولم يُرحَّل شيء. اسأل المستخدم: إن كان شاملاً تُفصل الضريبة منه، وإن كان قبل الضريبة فليقل ذلك صراحةً («قبل الضريبة») أو يكتب الإجمالي بالأرقام.');
}

export interface SalariesInput {
  month: ResolvedMonth;
  amountMilli: Milli;
  group: 'reps' | 'admin';
  paidFrom: 'cash' | 'bank' | 'accrue';
  paidFromAccountCode?: string | null;
  gosiMilli?: Milli | null;
  date: LocalDate;
  /** أكّد المستخدم (بعد رفض SALARIES_ALREADY_ACCRUED) أن هذه الرواتب لم تُسجَّل مستحقة: يُسقط فحص الرصيد لا فحص الاستحقاق المطابق */
  confirmedNotAccrued?: boolean;
}

/** وصف رواتب مجموعةٍ لشهر — بداية ملخّص القيد ونصّ سطره، ومنه يُعرف استحقاقٌ سابق للشهر والمجموعة نفسيهما */
export function salariesWhat(group: 'reps' | 'admin', month: Pick<ResolvedMonth, 'label'>): string {
  return `رواتب ${SALARY_ACCOUNTS[group].label} لشهر ${month.label}`;
}

/**
 * قيد رواتب شهر (صرف): مدين رواتب المناديب 611001 أو الإداريين 621001 / دائن النقد أو البنك أو الرواتب المستحقة 213001؛
 * والتأمينات (إن ذُكرت): مدين 621002 / دائن 213003 — في قيد واحد متّزن.
 * الصرف نقداً أو بنكاً يحمل accruedCheck: استحقاقٌ مطابق (الشهر والمجموعة) لم يُعكس، أو رصيد 213001 يغطي المبلغ ⇒ رفضٌ يوجّه
 * إلى «سداد الرواتب المستحقة» بدل مصروفٍ ثانٍ للشهر نفسه.
 */
export function buildSalariesPlan(env: PlanEnv, input: SalariesInput): PlanOutcome {
  const { lc } = env;
  const dec = lc.ctx.settings.currencyDecimals;
  if (input.amountMilli <= 0n) return fail(refuse('AMOUNT_INVALID', 'مبلغ الرواتب يجب أن يكون أكبر من صفر.'));
  const p1 = precisionProblem(input.amountMilli, dec, 'amount');
  if (p1) return fail(p1);
  const gosi = input.gosiMilli ?? 0n;
  if (gosi < 0n) return fail(refuse('AMOUNT_INVALID', 'مبلغ التأمينات لا يكون سالباً.'));
  const p2 = gosi > 0n ? precisionProblem(gosi, dec, 'gosi') : null;
  if (p2) return fail(p2);

  const g = SALARY_ACCOUNTS[input.group];
  const salary = resolveFixedExpense(lc, g.code, `رواتب ${g.label}`, env.booksMode);
  if (isRefusal(salary)) return fail(salary);

  let pay: PaymentTarget;
  if (input.paidFrom === 'accrue') {
    const acc = resolveLiability(lc, SALARIES_PAYABLE, 'رواتب وأجور مستحقة');
    if (isRefusal(acc)) return fail(acc);
    pay = { account: acc, label: 'مستحقة لم تُصرف', cash: false };
  } else {
    const r = resolveCashAccount(lc, input.paidFrom, input.paidFromAccountCode);
    if (isRefusal(r)) return fail(r);
    pay = r;
  }

  let gosiExpense: AccountRef | null = null;
  let gosiPayable: AccountRef | null = null;
  if (gosi > 0n) {
    const ge = resolveFixedExpense(lc, SALARY_ACCOUNTS.gosi.code, 'التأمينات الاجتماعية', env.booksMode);
    if (isRefusal(ge)) return fail(ge);
    const gp = resolveLiability(lc, GOSI_PAYABLE, 'التأمينات الاجتماعية المستحقة');
    if (isRefusal(gp)) return fail(gp);
    gosiExpense = ge;
    gosiPayable = gp;
  }
  const journal = journalFor(lc, pay.cash ? pay.account.id : null);
  if (!journal) return fail(refuse('JOURNAL_MISSING', 'لا يوجد دفتر نشط للصندوق أو البنك ولا دفتر «عمليات متنوعة» لترحيل القيد.'));

  const what = salariesWhat(input.group, input.month);
  const lines: LineDraft[] = [
    { accountId: salary.id, label: what, debitMilli: input.amountMilli, creditMilli: 0n },
    { accountId: pay.account.id, label: pay.cash ? `صرف ${what} ${pay.label}` : `${what}: مستحقة لم تُصرف`, debitMilli: 0n, creditMilli: input.amountMilli },
  ];
  if (gosiExpense && gosiPayable) {
    lines.push(
      { accountId: gosiExpense.id, label: `حصة المنشأة في التأمينات الاجتماعية لشهر ${input.month.label}`, debitMilli: gosi, creditMilli: 0n },
      { accountId: gosiPayable.id, label: `التأمينات الاجتماعية المستحقة لشهر ${input.month.label}`, debitMilli: 0n, creditMilli: gosi },
    );
  }
  const total = input.amountMilli + gosi;
  const cur = env.currency;
  const gosiPart = gosi > 0n ? ` وتأمينات اجتماعية ${formatAmount(gosi, dec)} ${cur} مستحقة` : '';
  const summaryAr = `${what}: ${formatAmount(input.amountMilli, dec)} ${cur} ${pay.label}${gosiPart}`;
  const draft = moveDraft(env, journal, 'ENTRY', input.date, `${what} (المحاسب الذكي)`, lines);
  const plan: AiPostPlan = { kind: 'SALARIES', draft, totalMilli: total, summaryAr, lines: planLinesOf(env, lines), warnings: [] };
  if (pay.cash) {
    // الالتزام الغائب من الدليل ⇒ لا استحقاق ممكن أصلاً فلا فحص
    const payable = resolveLiability(lc, SALARIES_PAYABLE, 'رواتب وأجور مستحقة');
    if (!isRefusal(payable)) {
      plan.accruedCheck = {
        accountId: payable.id,
        accountName: payable.name,
        minMilli: input.confirmedNotAccrued === true ? null : input.amountMilli,
        code: 'SALARIES_ALREADY_ACCRUED',
        message: `${what} أو ما يغطيها مسجّلةٌ مستحقة في «${payable.name}»، فصرفها الآن سدادٌ لهذا المستحق لا مصروفٌ ثانٍ. `
          + 'اطلب «سداد الرواتب المستحقة» بالمبلغ وطريقة الدفع؛ وإن أكّد المستخدم أن هذه الرواتب لم تُسجَّل مستحقة من قبل فأعد الطلب مع تأكيده.',
        accrualSummaryPrefix: `${what}:`,
      };
    }
  }
  return { ok: true, plan };
}

/**
 * الالتزامات التي يُسدَّد منها بالمحادثة — كل التزامٍ تُرحّل إليه أدوات الكتابة له سداده (لا يبقى دائناً أبداً ولا يُحمَّل
 * المصروف مرتين): الرواتب المستحقة 213001 (post_salaries accrue)، والتأمينات المستحقة 213003 (gosi)، والمصروفات المستحقة
 * 213002 (post_expense payable). النوع في الصفّ SALARIES_SETTLE لكلها (عقد PostedMove)، والملخّص يسمّي الالتزام.
 */
export const SETTLE_PAYABLES = {
  salaries: { target: SALARIES_PAYABLE, what: 'رواتب وأجور مستحقة', verb: 'سداد رواتب مستحقة', monthly: true, hint: 'سجّل الرواتب مستحقةً أولاً أو صحّح المبلغ.' },
  gosi: { target: GOSI_PAYABLE, what: 'التأمينات الاجتماعية المستحقة', verb: 'سداد التأمينات الاجتماعية المستحقة', monthly: true, hint: 'صحّح المبلغ، وإن لم تُسجَّل التأمينات مع الرواتب من قبل فسجّلها مصروفاً بحساب التأمينات الاجتماعية.' },
  accrued_expenses: { target: ACCRUED_EXPENSES, what: 'مصروفات مستحقة', verb: 'سداد مصروفات مستحقة', monthly: false, hint: 'صحّح المبلغ، وإن لم يُسجَّل المصروف آجلاً من قبل فسجّله مصروفاً عادياً.' },
} as const satisfies Record<string, { target: TemplateTarget; what: string; verb: string; monthly: boolean; hint: string }>;
export type SettlePayable = keyof typeof SETTLE_PAYABLES;
export const SETTLE_PAYABLE_KEYS = Object.keys(SETTLE_PAYABLES) as [SettlePayable, ...SettlePayable[]];

export interface SettleInput {
  amountMilli: Milli;
  /** الالتزام المسدَّد — الغياب الرواتب المستحقة (السلوك الأول) */
  payable?: SettlePayable;
  paidFrom: 'cash' | 'bank';
  paidFromAccountCode?: string | null;
  month?: ResolvedMonth | null;
  /** وصف قصير لما سُدِّد (فاتورة الكهرباء…) — للمصروفات المستحقة خاصةً */
  note?: string | null;
  date: LocalDate;
}

/**
 * سداد مستحق (صرف): مدين الالتزام (213001 أو 213003 أو 213002) / دائن النقد أو البنك — رصيد الالتزام يُفحص تحت القفل
 * (payableCheck) فلا يصير للالتزام رصيد مدين.
 */
export function buildSettlePlan(env: PlanEnv, input: SettleInput): PlanOutcome {
  const { lc } = env;
  const dec = lc.ctx.settings.currencyDecimals;
  const kind = input.payable ?? 'salaries';
  const def = SETTLE_PAYABLES[kind];
  if (!def) return fail(refuse('ACCOUNT_MISSING', 'الالتزام المطلوب سداده غير معروف: رواتب مستحقة أو تأمينات مستحقة أو مصروفات مستحقة.'));
  if (input.amountMilli <= 0n) return fail(refuse('AMOUNT_INVALID', 'مبلغ السداد يجب أن يكون أكبر من صفر.'));
  const pp = precisionProblem(input.amountMilli, dec, 'amount');
  if (pp) return fail(pp);
  const payable = resolveLiability(lc, def.target, def.what);
  if (isRefusal(payable)) return fail(payable);
  const pay = resolveCashAccount(lc, input.paidFrom, input.paidFromAccountCode);
  if (isRefusal(pay)) return fail(pay);
  const journal = journalFor(lc, pay.account.id);
  if (!journal) return fail(refuse('JOURNAL_MISSING', 'لا يوجد دفتر نشط للصندوق أو البنك ولا دفتر «عمليات متنوعة» لترحيل القيد.'));

  const note = cleanText(input.note, 120);
  const what = `${def.verb}${def.monthly && input.month ? ` لشهر ${input.month.label}` : ''}${note ? ` — ${note}` : ''}`;
  const lines: LineDraft[] = [
    { accountId: payable.id, label: what, debitMilli: input.amountMilli, creditMilli: 0n },
    { accountId: pay.account.id, label: `${what} ${pay.label}`, debitMilli: 0n, creditMilli: input.amountMilli },
  ];
  const summaryAr = `${what}: ${formatAmount(input.amountMilli, dec)} ${env.currency} ${pay.label}`;
  const draft = moveDraft(env, journal, 'ENTRY', input.date, `${what} (المحاسب الذكي)`, lines);
  return {
    ok: true,
    plan: {
      kind: 'SALARIES_SETTLE', draft, totalMilli: input.amountMilli, summaryAr, lines: planLinesOf(env, lines), warnings: [],
      payableCheck: {
        accountId: payable.id, accountName: payable.name, amountMilli: input.amountMilli,
        ...(kind === 'salaries' ? {} : { hint: def.hint }),
      },
    },
  };
}

// ═══ قيود المستندات (رفع المستندات في المحادثة — قرارات المالك D2/D3/D6/D7) ═══

/** الضريبة في قيد المستند (D7): DEDUCTIBLE سطر 116001، NON_DEDUCTIBLE على التكلفة، NONE بلا سطر */
export type DocVatMode = 'DEDUCTIBLE' | 'NON_DEDUCTIBLE' | 'NONE';

/** حسابات الأصول المقبولة بالرمز (D3) — مجمّعات الإهلاك 122xxx من النوع نفسه فلا يُحكم بالنوع وحده */
export const DOC_ASSET_CODES: readonly string[] = Object.values(ACCT_ASSET_CODES);

/** المدفوع مقدماً لا يكون دفعةً لمورد ولا تأميناً مسترداً (115003/115004 — لهما قيودهما) */
const NOT_PREPAID_CODES: readonly string[] = ['115003', '115004'];

/** حساب أصل يقبله المحاسب الذكي: من القائمة البيضاء بالرمز، نشط، بلا controlKind، أصل ثابت أو غير متداول */
export function assetAccountProblem(a: AccountRef | null | undefined): AccountProblem | null {
  if (!a) return 'MISSING';
  if (!a.isActive) return 'ARCHIVED';
  if (a.controlKind !== null) return 'CONTROL';
  if (ACCT_REFERRED_ASSET_CODES.includes(a.code)) return 'REFERRED';
  if (!DOC_ASSET_CODES.includes(a.code) || (a.type !== 'asset_fixed' && a.type !== 'asset_non_current')) return 'WRONG_TYPE';
  return null;
}

/** حساب مدفوع مقدماً: asset_prepayments نشط بلا controlKind، وليس دفعات الموردين (VENDOR_ADVANCES) ولا التأمينات المستردة */
export function prepaidAccountProblem(a: AccountRef | null | undefined, lc?: Pick<LedgerContext, 'ctx'>): AccountProblem | null {
  if (!a) return 'MISSING';
  if (!a.isActive) return 'ARCHIVED';
  if (a.controlKind !== null) return 'CONTROL';
  if (a.type !== 'asset_prepayments' || NOT_PREPAID_CODES.includes(a.code)) return 'WRONG_TYPE';
  if (lc && lc.ctx.accounts.byKey('VENDOR_ADVANCES')?.id === a.id) return 'WRONG_TYPE';
  return null;
}

/** حساب أصل المستند بالرمز: الأراضي والمباني للمحاسب البشري (DOC_TREATMENT_REFERRED)، وغير القائمة TREATMENT_NOT_ALLOWED */
export function resolveAssetAccount(lc: PlanLedger, code: string): AccountRef | AiRefusal {
  const c = (code ?? '').trim();
  const a = c ? lc.ctx.accounts.byCode(c) : null;
  const p = assetAccountProblem(a);
  if (p === null && a) return a;
  if (ACCT_REFERRED_ASSET_CODES.includes(c) || p === 'REFERRED') {
    return refuse('DOC_TREATMENT_REFERRED',
      `شراء ${a?.name ?? 'الأراضي والمباني'} يقرّر قيده محاسبك البشري (تكلفة الاقتناء والإهلاك ونقل الملكية)، فلم يُرحَّل شيء. احفظ المستند وأحِله إليه.`,
      { accountCode: c });
  }
  const candidates = lc.accounts.filter((x) => assetAccountProblem(x) === null).sort(byCode).map((x) => ({ code: x.code, name: x.name }));
  if (!a) {
    return refuse('ACCOUNT_MISSING', `حساب الأصل ${c} غير موجود في دليل حساباتك. اختر حساب الأصل من القائمة.`, { accountCode: c, candidates });
  }
  return refuse(p === 'WRONG_TYPE' ? 'TREATMENT_NOT_ALLOWED' : 'ACCOUNT_NOT_ALLOWED',
    `الحساب ${c} (${a.name}) لا يُرسمل عليه أصل من المحادثة. اختر أحد حسابات الأصول من القائمة.`,
    { accountCode: c, problem: p, candidates });
}

/** مصروفات الإيجار (المحل والمستودع، وسكن الموظفين) — مدفوعها مقدماً على 115002 كاقتراح البطاقة (suggest.ts prepaidCodeForExpense) */
export const RENT_EXPENSE_CODES: readonly string[] = [ACCT_DOC_CODES.rentExpense, EXPENSE_CATEGORIES.staff_housing.code];

/**
 * حساب المدفوع مقدماً (D2): رمزٌ اختاره المستخدم في البطاقة (115002/115001 — بالحارس نفسه)، وإلا من مصروف الإطفاء:
 * الإيجار وسكن الموظفين ⇐ 115002 إيجار مدفوع مقدماً، وغيرهما ⇐ 115001 مصروفات مدفوعة مقدماً (مفتاح DEFERRED_EXPENSE ثم الرمز).
 */
export function resolvePrepaidAccount(lc: PlanLedger, expense: AccountRef, chosenCode?: string | null): AccountRef | AiRefusal {
  const code = chosenCode?.trim();
  if (code) {
    const a = lc.ctx.accounts.byCode(code);
    const p = prepaidAccountProblem(a, lc);
    if (p === null && a) return a;
    return refuse(p === 'MISSING' ? 'ACCOUNT_MISSING' : 'ACCOUNT_NOT_ALLOWED',
      `حساب المدفوع مقدماً ${code}${a ? ` (${a.name})` : ''} ${PROBLEM_AR[p ?? 'MISSING']}. اختر «إيجار مدفوع مقدماً» أو «مصروفات مدفوعة مقدماً».`,
      { accountCode: code, problem: p });
  }
  const rent = RENT_EXPENSE_CODES.includes(expense.code);
  const target: TemplateTarget = rent ? { code: ACCT_DOC_CODES.prepaidRent } : { key: 'DEFERRED_EXPENSE', code: ACCT_DOC_CODES.prepaidOther };
  const picked = pickAccount(targetAccounts(lc, target), (a) => prepaidAccountProblem(a, lc));
  if ('problem' in picked) {
    return refuse(picked.problem === 'MISSING' ? 'ACCOUNT_MISSING' : 'ACCOUNT_NOT_ALLOWED',
      `حساب «${rent ? 'إيجار مدفوع مقدماً' : 'مصروفات مدفوعة مقدماً'}» (${target.code}) ${PROBLEM_AR[picked.problem]}. أضفه أو فعّله في دليل الحسابات ثم أعد الطلب.`,
      { templateCode: target.code, problem: picked.problem });
  }
  return picked.account;
}

export interface DocPlanInput {
  docId: string;
  /** EXPENSE: حساب المصروف، ASSET: حساب الأصل، PREPAID: المصروف الذي يُطفأ عليه شهرياً */
  accountCode: string;
  paidFrom: CashSource | 'payable';
  paidFromAccountCode?: string | null;
  /** إجمالي المستند (شامل الضريبة) — المبلغ الدائن على مصدر الدفع */
  totalMilli: Milli;
  /** ضريبة المستند (0 بلا ضريبة) */
  vatMilli: Milli;
  vatMode: DocVatMode;
  date: LocalDate;
  /** وصف المستند منظّفاً للسطور والملخّص («فاتورة صيانة — مؤسسة الإتقان رقم 2231») */
  what: string;
}

export interface PrepaidPlanInput extends DocPlanInput {
  /** حساب المدفوع مقدماً المختار في البطاقة (115002/115001) — الغياب يُشتق من مصروف الإطفاء (accountCode) */
  prepaidCode?: string | null;
  months: number;
  /** أول شهر خدمة YYYY-MM (بداية فترة المستند، وإلا شهر قيد الدفع) */
  startYm: string;
}

export interface AssetPlanInput extends DocPlanInput {
  /** حدّ الرسملة بالملّي (D3) — الصافي قبل الضريبة دونه ⇒ ASSET_BELOW_THRESHOLD */
  thresholdMilli: Milli;
}

/** مصدر الدفع لقيد المستند: النقد أو النثريات أو البنك (أو رمز صندوق/بنك اختاره)، أو 213002 للفاتورة غير المدفوعة (D6) */
export function resolveDocPayment(lc: PlanLedger, paidFrom: CashSource | 'payable', accountCode?: string | null): PaymentTarget | AiRefusal {
  if (paidFrom === 'payable') {
    const acc = resolveLiability(lc, ACCRUED_EXPENSES, 'مصروفات مستحقة');
    return isRefusal(acc) ? acc : { account: acc, label: 'مستحق الدفع', cash: false };
  }
  return resolveCashAccount(lc, paidFrom, accountCode);
}

interface DocLines {
  lines: LineDraft[];
  pay: PaymentTarget;
  journal: JournalChoice;
  /** ما على المدين الرئيسي (الوعاء بضريبة قابلة للخصم، وإلا الإجمالي) */
  debitMilli: Milli;
  vatLineMilli: Milli;
  vatPart: string;
  warnings: string[];
}

/** المبلغ ⇐ مجموع الأقساط: القسم مقرَّباً نصف-لأعلى إلى أصغر وحدة عملة */
function divRoundUnits(amount: Milli, parts: number, decimals: number): Milli {
  const u = unitMilli(decimals);
  const units = amount / u;
  const n = BigInt(parts);
  return ((units * 2n + n) / (2n * n)) * u;
}

/**
 * سطور قيد المستند المشتركة: المدين الرئيسي [+ ضريبة المدخلات بمربّعها] / دائن مصدر الدفع بالإجمالي.
 * DEDUCTIBLE: الوعاء = الإجمالي − الضريبة (موسوماً BASE) وسطر 116001 (TAX)؛ وغيره: الإجمالي كله على المدين (الضريبة من
 * التكلفة). الضريبة المُزالة للشركة ⇒ لا سطر ضريبة أبداً.
 */
function docLinesOf(env: PlanEnv, debit: AccountRef, input: DocPlanInput): DocLines | AiRefusal {
  const { lc } = env;
  const dec = lc.ctx.settings.currencyDecimals;
  const total = input.totalMilli;
  if (total <= 0n) return refuse('AMOUNT_INVALID', 'إجمالي المستند يجب أن يكون أكبر من صفر.');
  const pp = precisionProblem(total, dec, 'total');
  if (pp) return pp;
  const vat = input.vatMilli > 0n ? input.vatMilli : 0n;
  if (vat > 0n) {
    const vp = precisionProblem(vat, dec, 'vatAmount');
    if (vp) return vp;
    if (vat >= total) return refuse('VAT_INVALID', 'ضريبة المستند لا تتّسق مع إجماليه. صحّحها في البطاقة.');
  }
  const pay = resolveDocPayment(lc, input.paidFrom, input.paidFromAccountCode);
  if (isRefusal(pay)) return pay;
  const journal = journalFor(lc, pay.cash ? pay.account.id : null);
  if (!journal) return refuse('JOURNAL_MISSING', 'لا يوجد دفتر نشط للصندوق أو البنك ولا دفتر «عمليات متنوعة» لترحيل القيد.');

  const warnings: string[] = [];
  let mode: DocVatMode = vat > 0n ? input.vatMode : 'NONE';
  if (env.taxDisabled && mode !== 'NONE') mode = 'NONE';
  const what = cleanText(input.what, 160) || debit.name;
  const lines: LineDraft[] = [];
  let debitMilli = total;
  let vatLineMilli = 0n;
  let vatPart = '';
  if (mode === 'DEDUCTIBLE') {
    const tax = clearingFeeTax(lc.ctx);
    if (!tax) {
      return refuse('LEDGER_VAT_LINE_UNTAGGED',
        'لا توجد ضريبة مشتريات نشطة بمربّع إقرار في دفاترك لفصل ضريبة المدخلات. فعّل ضريبة المشتريات الافتراضية ثم أعد الطلب.');
    }
    const base = total - vat;
    if (vat > taxOnBase(base, tax.rate, dec) + unitMilli(dec)) {
      return refuse('VAT_INVALID', `ضريبة المستند أكبر من ${tax.rate}٪ من وعائها. صحّحها في البطاقة.`, { taxRate: tax.rate });
    }
    const vatAccount = tax.accountId ? lc.ctx.accounts.byId(tax.accountId) : lc.ctx.accounts.byKey('INPUT_VAT');
    if (!vatAccount) return refuse('LEDGER_VAT_LINE_UNTAGGED', 'حساب ضريبة المدخلات غير موجود في دليل حساباتك. راجع إعداد الضرائب.');
    debitMilli = base;
    vatLineMilli = vat;
    lines.push({ accountId: debit.id, label: `${debit.name}: ${what}`, debitMilli: base, creditMilli: 0n, taxId: tax.id, taxRole: 'BASE' });
    lines.push({
      accountId: vatAccount.id, label: `ضريبة القيمة المضافة: ${what}`, debitMilli: vat, creditMilli: 0n,
      taxId: tax.id, taxCode: tax.key ?? null, taxRole: 'TAX', taxBaseMilli: base, vatBox: tax.vatBox,
    });
    vatPart = ` (منها ضريبة مدخلات ${formatAmount(vat, dec)})`;
  } else {
    const nonDed = mode === 'NON_DEDUCTIBLE' && vat > 0n;
    lines.push({
      accountId: debit.id,
      label: `${debit.name}: ${what}${nonDed ? ' (شامل ضريبة غير قابلة للخصم)' : ''}`,
      debitMilli: total, creditMilli: 0n,
    });
    if (nonDed) vatPart = ` (شامل ضريبة غير قابلة للخصم ${formatAmount(vat, dec)})`;
    else if (vat > 0n && env.taxDisabled) warnings.push('الضريبة مُزالة في إعدادات الشركة، فسُجّل إجمالي المستند بلا فصل ضريبة.');
    else if (vat > 0n) warnings.push('لا مربّع لضريبة المدخلات في دليل حساباتك، فسُجّل إجمالي المستند بلا فصل الضريبة.');
  }
  lines.push({
    accountId: pay.account.id,
    label: pay.cash ? `سداد ${what} ${pay.label}` : `${what}: مستحق الدفع`,
    debitMilli: 0n,
    creditMilli: total,
  });
  return { lines, pay, journal, debitMilli, vatLineMilli, vatPart, warnings };
}

/** قيد مصروف من مستند: مدين المصروف [+ 116001] / دائن مصدر الدفع (213002 إن لم يُدفع) */
export function buildDocExpensePlan(env: PlanEnv, input: DocPlanInput): PlanOutcome {
  const { lc } = env;
  const expense = resolveExpenseAccount(lc, { accountCode: input.accountCode }, env.booksMode);
  if (isRefusal(expense)) return fail(expense);
  const d = docLinesOf(env, expense, input);
  if (isRefusal(d)) return fail(d);
  const dec = lc.ctx.settings.currencyDecimals;
  const what = cleanText(input.what, 160) || expense.name;
  const summaryAr = `مصروف ${expense.name}: ${formatAmount(input.totalMilli, dec)} ${env.currency}${d.vatPart} ${d.pay.label} — ${what}`;
  const draft = moveDraft(env, d.journal, 'EXPENSE', input.date, `${what} (مستند — المحاسب الذكي)`, d.lines);
  return {
    ok: true,
    plan: { kind: 'EXPENSE', draft, totalMilli: input.totalMilli, summaryAr, lines: planLinesOf(env, d.lines), warnings: d.warnings, docId: input.docId },
  };
}

/** أصلٌ يحتاج إهلاكاً يسجّله المحاسب البشري (D3) — في الرد والبطاقة */
export const ASSET_DEPRECIATION_NOTE = 'يحتاج إهلاكاً يسجّله المحاسب';

/**
 * قيد أصل من مستند (D3): مدين حساب الأصل (القائمة البيضاء) [+ 116001] / دائن مصدر الدفع — والصافي قبل الضريبة دون حدّ
 * الرسملة ⇒ ASSET_BELOW_THRESHOLD (يُسجَّل مصروفاً). لا إهلاك: الملخّص والتنبيه يقولان «يحتاج إهلاكاً يسجّله المحاسب».
 */
export function buildAssetPlan(env: PlanEnv, input: AssetPlanInput): PlanOutcome {
  const { lc } = env;
  const dec = lc.ctx.settings.currencyDecimals;
  const asset = resolveAssetAccount(lc, input.accountCode);
  if (isRefusal(asset)) return fail(asset);
  const net = input.totalMilli - (input.vatMilli > 0n ? input.vatMilli : 0n);
  if (net < input.thresholdMilli) {
    return fail(refuse('ASSET_BELOW_THRESHOLD',
      `صافي المشتريات قبل الضريبة (${formatAmount(net > 0n ? net : 0n, dec)}) أقل من حدّ الرسملة (${formatAmount(input.thresholdMilli, dec)})، فلا يُسجَّل أصلاً — سجّله مصروفاً (أدوات مكتبية أو صيانة أو متنوعة).`,
      { net: fromMilli(net > 0n ? net : 0n), threshold: fromMilli(input.thresholdMilli) }));
  }
  const d = docLinesOf(env, asset, input);
  if (isRefusal(d)) return fail(d);
  const what = cleanText(input.what, 160) || asset.name;
  const summaryAr = `أصل ${asset.name}: ${formatAmount(input.totalMilli, dec)} ${env.currency}${d.vatPart} ${d.pay.label} — ${what}. ${ASSET_DEPRECIATION_NOTE}.`;
  const draft = moveDraft(env, d.journal, 'ENTRY', input.date, `${what} — أصل (مستند — المحاسب الذكي)`, d.lines);
  return {
    ok: true,
    plan: { kind: 'ASSET', draft, totalMilli: input.totalMilli, summaryAr, lines: planLinesOf(env, d.lines), warnings: d.warnings, docId: input.docId },
  };
}

/** قسط الشهر k (1..months) من جدول الإطفاء: الأخير يأخذ الباقي */
export function amortizationAmount(schedule: Pick<PrepaidSchedule, 'months' | 'monthlyMilli' | 'lastMilli'>, k: number): Milli {
  return BigInt(k === schedule.months ? schedule.lastMilli : schedule.monthlyMilli);
}

/** آخر يومٍ في شهر الخدمة k (startYm + k−1) — تاريخ قسطه */
export function amortizationMonthEnd(startYm: string, k: number): LocalDate {
  return endOfMonth(addMonths(`${startYm}-01`, k - 1));
}

/** تاريخ قيد القسط k: آخر يومٍ في شهره، ولا يسبق تاريخ قيد الدفع (أشهرٌ مضت قبل الدفع تُحمَّل بتاريخه) */
export function amortizationDate(schedule: Pick<PrepaidSchedule, 'startYm'>, k: number, parentDate: LocalDate): LocalDate {
  return maxLocalDate(amortizationMonthEnd(schedule.startYm, k), parentDate);
}

/** «نوفمبر 2026» من YYYY-MM */
export function monthLabelOf(ym: string): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return m >= 1 && m <= 12 ? `${MONTHS_AR[m - 1]} ${y}` : ym;
}

/**
 * قيد مدفوع مقدماً من مستند (D2): مدين 115002 للإيجار أو 115001 لغيره [+ 116001 كاملة بتاريخ الفاتورة] / دائن مصدر الدفع.
 * الأشهر 1..24 (الأطول للمحاسب البشري ⇒ DOC_TREATMENT_REFERRED)، والجدول في meta: الأساس (ما على حساب المدفوع مقدماً) ÷
 * الأشهر مقرَّباً نصف-لأعلى والباقي على الأخير — قسطٌ يُقرَّب إلى صفر يُرفض (PREPAID_MONTHS_INVALID).
 */
export function buildPrepaidPlan(env: PlanEnv, input: PrepaidPlanInput): PlanOutcome {
  const { lc } = env;
  const dec = lc.ctx.settings.currencyDecimals;
  const months = input.months;
  if (!Number.isInteger(months) || months < 1) {
    return fail(refuse('PREPAID_MONTHS_INVALID', `عدد أشهر الدفع المقدّم يجب أن يكون عدداً صحيحاً من 1 إلى ${ACCT_PREPAID_MAX_MONTHS}.`, { months }));
  }
  if (months > ACCT_PREPAID_MAX_MONTHS) {
    return fail(refuse('DOC_TREATMENT_REFERRED',
      `دفعٌ مقدّم لأكثر من ${ACCT_PREPAID_MAX_MONTHS} شهراً يقرّر قيده محاسبك البشري (عقد طويل الأجل)، فلم يُرحَّل شيء.`, { months }));
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.startYm)) {
    return fail(refuse('PREPAID_MONTHS_INVALID', 'بداية فترة الدفع المقدّم غير صالحة: صحّح تاريخ بداية الفترة في البطاقة.'));
  }
  const expense = resolveExpenseAccount(lc, { accountCode: input.accountCode }, env.booksMode);
  if (isRefusal(expense)) return fail(expense);
  const prepaid = resolvePrepaidAccount(lc, expense, input.prepaidCode);
  if (isRefusal(prepaid)) return fail(prepaid);
  const d = docLinesOf(env, prepaid, input);
  if (isRefusal(d)) return fail(d);
  const base = d.debitMilli;
  const monthly = divRoundUnits(base, months, dec);
  const last = base - monthly * BigInt(months - 1);
  if (monthly <= 0n || last <= 0n) {
    return fail(refuse('PREPAID_MONTHS_INVALID', `المبلغ أصغر من أن يُوزَّع على ${months} شهراً. قلّل الأشهر أو سجّله مصروفاً.`, { months }));
  }
  const what = cleanText(input.what, 160) || prepaid.name;
  const meta: PrepaidSchedule = {
    months, baseMilli: base.toString(), monthlyMilli: monthly.toString(), lastMilli: last.toString(), startYm: input.startYm,
    prepaidCode: prepaid.code, expenseCode: expense.code, what, lockedSkip: null,
  };
  const cur = env.currency;
  const per = monthly === last
    ? `${formatAmount(monthly, dec)} ${cur} شهرياً`
    : `${formatAmount(monthly, dec)} ${cur} شهرياً والأخير ${formatAmount(last, dec)}`;
  const summaryAr = `${prepaid.name}: ${formatAmount(input.totalMilli, dec)} ${cur}${d.vatPart} ${d.pay.label} — ${what}؛ `
    + `يُطفأ على ${expense.name} ${months} شهراً من ${monthLabelOf(input.startYm)} (${per})`;
  const draft = moveDraft(env, d.journal, 'ENTRY', input.date, `${what} — مدفوع مقدماً (مستند — المحاسب الذكي)`, d.lines);
  return {
    ok: true,
    plan: {
      kind: 'PREPAID', draft, totalMilli: input.totalMilli, summaryAr, lines: planLinesOf(env, d.lines), warnings: d.warnings,
      docId: input.docId, meta,
    },
  };
}

export interface AmortizationInput {
  parentPostId: string;
  schedule: PrepaidSchedule;
  k: number;
  date: LocalDate;
}

/** قسط إطفاء الشهر k: مدين المصروف / دائن المدفوع مقدماً بقسطه — دفتر «عمليات متنوعة» */
export function buildAmortizationPlan(env: PlanEnv, input: AmortizationInput): PlanOutcome {
  const { lc } = env;
  const dec = lc.ctx.settings.currencyDecimals;
  const s = input.schedule;
  if (!Number.isInteger(input.k) || input.k < 1 || input.k > s.months) {
    return fail(refuse('PREPAID_MONTHS_INVALID', 'قسط إطفاء خارج جدول المدفوع مقدماً.', { k: input.k, months: s.months }));
  }
  const amount = amortizationAmount(s, input.k);
  if (amount <= 0n) return fail(refuse('AMOUNT_INVALID', 'قسط الإطفاء يجب أن يكون أكبر من صفر.'));
  const expense = resolveExpenseAccount(lc, { accountCode: s.expenseCode }, env.booksMode);
  if (isRefusal(expense)) return fail(expense);
  const prepaid = lc.ctx.accounts.byCode(s.prepaidCode);
  const pp = prepaidAccountProblem(prepaid, lc);
  if (pp !== null || !prepaid) {
    return fail(refuse(pp === 'MISSING' ? 'ACCOUNT_MISSING' : 'ACCOUNT_NOT_ALLOWED',
      `حساب المدفوع مقدماً (${s.prepaidCode}) ${PROBLEM_AR[pp ?? 'MISSING']}.`, { accountCode: s.prepaidCode, problem: pp }));
  }
  const journal = journalFor(lc, null);
  if (!journal) return fail(refuse('JOURNAL_MISSING', 'لا يوجد دفتر «عمليات متنوعة» نشط لترحيل قسط الإطفاء.'));
  const month = monthLabelOf(amortizationMonthEnd(s.startYm, input.k).slice(0, 7));
  const what = `إطفاء ${s.what} — ${month} (${input.k} من ${s.months})`;
  const lines: LineDraft[] = [
    { accountId: expense.id, label: `${expense.name}: ${what}`, debitMilli: amount, creditMilli: 0n },
    { accountId: prepaid.id, label: `${prepaid.name}: ${what}`, debitMilli: 0n, creditMilli: amount },
  ];
  const summaryAr = `${what}: ${formatAmount(amount, dec)} ${env.currency} على ${expense.name}`;
  const draft = moveDraft(env, journal, 'DEFERRAL', input.date, `${what} (إطفاء مجدول — المحاسب الذكي)`, lines);
  return {
    ok: true,
    plan: {
      kind: 'PREPAID_AMORT', draft, totalMilli: amount, summaryAr, lines: planLinesOf(env, lines), warnings: [],
      parentPostId: input.parentPostId,
    },
  };
}

// ═══ عدم التكرار ═══

export interface FingerprintLine { accountId: string; debitMilli: Milli | bigint; creditMilli: Milli | bigint }

/**
 * بصمة القيد للمقارنة عند إعادة الإرسال: النوع [+ معرّف المستند] + (الحساب، المدين، الدائن) مرتّبة — بلا التاريخ (إعادة
 * الغد = الطلب نفسه). المستند في البصمة: مستندان بالمبلغ والحسابات نفسها في طلبٍ أُعيد لا يتبادلان قيديهما.
 */
export function linesFingerprint(kind: string, lines: readonly FingerprintLine[], docId?: string | null): string {
  return `${kind}${docId ? `#${docId}` : ''}|${lines
    .filter((l) => BigInt(l.debitMilli) !== 0n || BigInt(l.creditMilli) !== 0n)
    .map((l) => `${l.accountId}:${BigInt(l.debitMilli)}:${BigInt(l.creditMilli)}`)
    .sort()
    .join(',')}`;
}

export interface ExistingAiMove { id: string; ref: string | null; lines: readonly FingerprintLine[] }
export interface ExistingAiRow { ref: string; kind: string; moveId: string; docId?: string | null }

export type RefChoice =
  | { kind: 'new'; ref: string }
  | { kind: 'replay'; ref: string; moveId: string }
  | { kind: 'none' };

/**
 * يختار المرجع تحت القفل: أول AI-<clientRef>-n لم تستعمله الدورة نفسها؛ مأخوذٌ بقيدٍ مطابق البصمة (والنوع) ⇒ إعادة إرسال
 * فيُعاد القيد نفسه بلا ترحيل ثانٍ؛ مأخوذٌ بقيدٍ آخر (ترتيب مختلف في الإعادة) ⇒ المرجع التالي؛ حرٌّ ⇒ قيد جديد.
 */
export function chooseAiRef(
  clientRef: string, usedRefs: readonly string[], moves: readonly ExistingAiMove[], rows: readonly ExistingAiRow[],
  plan: Pick<AiPostPlan, 'kind' | 'lines' | 'docId'>, max = MAX_POSTS_PER_REQUEST,
): RefChoice {
  const used = new Set(usedRefs);
  const taken = new Set<string>();
  for (const m of moves) if (m.ref) taken.add(m.ref);
  for (const r of rows) taken.add(r.ref);
  const moveById = new Map(moves.map((m) => [m.id, m]));
  const rowByRef = new Map(rows.map((r) => [r.ref, r]));
  const want = linesFingerprint(plan.kind, plan.lines, plan.docId);
  for (let n = 1; n <= max; n++) {
    const ref = aiRefOf(clientRef, n);
    if (used.has(ref)) continue;
    if (!taken.has(ref)) return { kind: 'new', ref };
    const row = rowByRef.get(ref);
    const mv = row ? moveById.get(row.moveId) : undefined;
    if (row && mv && mv.ref === ref && row.kind === plan.kind && linesFingerprint(row.kind, mv.lines, row.docId) === want) {
      return { kind: 'replay', ref, moveId: mv.id };
    }
  }
  return { kind: 'none' };
}

// ═══ الترحيل في المعاملة ═══

export const AI_POST_ROW_SELECT = {
  id: true, adminId: true, adminName: true, moveId: true, moveNumber: true, ref: true, kind: true, amountMilli: true,
  dateLocal: true, summaryAr: true, createdAt: true, docId: true, parentPostId: true, meta: true,
} as const;

export interface AiPostRow {
  id: string;
  adminId: string;
  adminName: string | null;
  moveId: string;
  moveNumber: string | null;
  ref: string;
  kind: string;
  amountMilli: bigint;
  dateLocal: string;
  summaryAr: string;
  createdAt: Date;
  /** مستندات المحادثة: الأعمدة الاختيارية (الصفوف القديمة null) */
  docId?: string | null;
  parentPostId?: string | null;
  meta?: unknown;
}

/** إضافات العرض لصفٍّ من مستند (listAiPostsWith وexecuteAiPost): المرفق وتقدّم الإطفاء وتنبيهه وترتيب القسط */
export interface PostedExtras {
  hasAttachment?: boolean;
  prepaid?: PrepaidProgress;
  warning?: string | null;
  amort?: AmortOrdinal;
}

/** قسط الإطفاء k من n (PREPAID_AMORT): من مرجعه AI-AMORT-<parentPostId>-<k> وجدول قيد الدفع المقدّم أبيه */
export interface AmortOrdinal {
  parentPostId: string;
  index: number;
  months: number;
}

/** تقدّم إطفاء قيد PREPAID في القائمة: المرحّل من الأشهر، وتوقّفه (عُكس قيد الدفع)، وموعد القسط التالي، والأشهر المقفلة */
export interface PrepaidProgress {
  posted: number;
  months: number;
  stopped?: boolean;
  /** آخر يوم في شهر القسط التالي غير المرحّل (بعده يُرحَّل) — null إن اكتمل أو توقّف */
  nextDate?: string | null;
  /** أشهر YYYY-MM تخطّاها الإطفاء لفترةٍ مقفلة */
  lockedMonths?: string[];
}

/** صفّ AiAccountantPost + سطور القيد ⇐ PostedMove العقد (المبالغ أرقام لا BigInt) — النوع المجهول ⇒ EXPENSE */
export function postedMoveOf(
  row: AiPostRow, lines: readonly (FingerprintLine & { accountCode?: string; accountName?: string })[],
  accountOf: (id: string) => { code: string; name: string } | null | undefined, reversed: boolean,
  extras: PostedExtras = {},
): PostedMove {
  const kind = (AI_POST_KINDS as readonly string[]).includes(row.kind) ? row.kind as AiPostKind : 'EXPENSE';
  return {
    id: row.id,
    moveId: row.moveId,
    moveNumber: row.moveNumber,
    ref: row.ref,
    kind,
    amount: fromMilli(BigInt(row.amountMilli)),
    date: row.dateLocal,
    summaryAr: row.summaryAr,
    lines: lines.map((l) => {
      const a = accountOf(l.accountId);
      return {
        accountCode: l.accountCode ?? a?.code ?? '',
        accountName: l.accountName ?? a?.name ?? '',
        debit: fromMilli(BigInt(l.debitMilli)),
        credit: fromMilli(BigInt(l.creditMilli)),
      };
    }),
    reversed,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    adminName: row.adminName,
    // حقول المستندات تُضاف لصفوفها وحدها (قيود المحادثة النصّية بشكلها القائم حرفياً)
    ...(row.docId ? { docId: row.docId, hasAttachment: extras.hasAttachment ?? false } : {}),
    ...(row.parentPostId ? { parentPostId: row.parentPostId } : {}),
    ...(extras.prepaid ? { prepaid: extras.prepaid } : {}),
    ...(extras.amort ? { amort: extras.amort } : {}),
    ...(extras.warning ? { warning: extras.warning } : {}),
  };
}

/** نقاط الحقن للاختبار بمخزن مزيّف — الافتراضي الدوال الحقيقية (كـClearingDeps) */
export interface AiPostDeps {
  acquirePostLock(tx: GlDb, tenantId: string): Promise<void>;
  loadBuildContext(tx: GlDb, tenantId: string): Promise<LedgerContext>;
  postMove: typeof postMove;
}

export const DEFAULT_AI_POST_DEPS: AiPostDeps = { acquirePostLock, loadBuildContext, postMove };

export interface AiPostRequest {
  tenantId: string;
  actor: GlActor;
  adminId: string;
  adminName: string | null;
  clientRef: string;
  /** مراجع ما رحّلته الدورة نفسها (ctx.posted) — لا تُطابَق ثانيةً لطلبٍ آخر في الدورة */
  usedRefs: readonly string[];
  /** يبني الخطة من سياق الشركة المقروء تحت القفل */
  build(lc: LedgerContext): PlanOutcome;
  now?: Date;
  /**
   * مبلغٌ جاء من رسالة المستخدم السابقة لا الأخيرة: يُرفض قيدٌ جديد يطابق بصمةً قيداً لم يُعكس رحّله الفاعل نفسه (adminId
   * كما في الصفّ) منذ since بطلبٍ آخر — فلا يُرحَّل طلبٌ قديمٌ مرةً ثانية بدورةٍ جديدة (clientRef آخر).
   */
  duplicateGuard?: { adminId: string; since: Date };
  /** ترحيلٌ من مستند (documents/post.ts): خطّافات داخل المعاملة نفسها حول postMove */
  doc?: AiDocHooks;
}

/**
 * خطّافات ترحيل المستند — كلها في معاملة executeAiPost وتحت قفل الترحيل، وأيّ رميٍ منها يُسقط القيد وصفّه معاً:
 *   refusal  بعد عدم التكرار (إعادة الإرسال تُعاد قبله) وقبل postMove: طبقات التكرار (الملف نفسه، رقم الفاتورة، المفتاح الرخو).
 *   relink   بعد postMove مباشرة: مرفق المستند يُنقل إلى القيد المرحَّل (لا يُربط بمسودة أبداً — حذف المسودة يحذف مرفقاتها).
 *   linkDoc  بعد صفّ AiAccountantPost: المستند يشير إلى قيده وصفّه (مقارنة-وتبديل على moveId السابق).
 */
export interface AiDocHooks {
  refusal(tx: GlDb, plan: AiPostPlan, lc: LedgerContext): Promise<AiRefusal | null>;
  relink(tx: GlDb, posted: { moveId: string; moveNumber: string }): Promise<void>;
  linkDoc(tx: GlDb, link: { moveId: string; postId: string }): Promise<void>;
}

/** نافذة فحص تكرار القيد بطلبٍ آخر (duplicateGuard) — محادثة الصفحة في الذاكرة فلا تطول عادةً عن هذا */
export const DUPLICATE_WINDOW_MS = 12 * 60 * 60 * 1000;

export interface AiPostResult {
  move: PostedMove;
  replayed: boolean;
  warnings: string[];
}

const big = (v: unknown): bigint => (typeof v === 'bigint' ? v : BigInt(String(v ?? 0)));

/** الرصيد الدائن لالتزامٍ من سطوره المرحّلة (دائن − مدين) — يُقرأ تحت قفل الترحيل */
async function liabilityBalance(tx: GlDb, tenantId: string, accountId: string): Promise<bigint> {
  const agg = await tx.glMoveLine.aggregate({
    where: { tenantId, accountId, posted: true },
    _sum: { debitMilli: true, creditMilli: true },
  });
  return big(agg._sum.creditMilli ?? 0n) - big(agg._sum.debitMilli ?? 0n);
}

/** القيود المرحّلة الحيّة (لا مسودة ولا معكوسة) من معرّفاتها مع سطورها — للمقارنة بالبصمة أو بسطر الالتزام */
async function liveMovesOf(tx: GlDb, tenantId: string, ids: readonly string[]): Promise<{ id: string; lines: FingerprintLine[] }[]> {
  if (!ids.length) return [];
  const moves = await tx.glMove.findMany({
    where: { tenantId, id: { in: [...ids] }, state: 'POSTED' },
    select: { id: true, lines: { select: { accountId: true, debitMilli: true, creditMilli: true }, orderBy: { seq: 'asc' } } },
  });
  const reversals = await tx.glMove.findMany({ where: { tenantId, reversedMoveId: { in: [...ids] } }, select: { reversedMoveId: true } });
  const reversed = new Set(reversals.map((r) => r.reversedMoveId).filter((x): x is string => !!x));
  return moves.filter((m) => !reversed.has(m.id));
}

/**
 * فحوص القيد الجديد وحده (بعد عدم التكرار: إعادة إرسال قيدٍ رُحّل تُعاد كما هي ولو تغيّر الرصيد بعده) — كلها تحت القفل:
 *   1) السداد لا يتجاوز رصيد الالتزام (EXCEEDS_PAYABLE).
 *   2) مصروفٌ مسجّل مستحقاً من قبل: استحقاقٌ مطابق حيّ أو رصيد التزامٍ يغطيه (PAYABLE_OUTSTANDING / SALARIES_ALREADY_ACCRUED).
 *   3) مبلغٌ من الرسالة السابقة وقيدٌ مطابق البصمة رحّله الفاعل نفسه بطلبٍ آخر حديثاً (DUPLICATE_RECENT).
 */
async function newPostRefusal(tx: GlDb, tenantId: string, plan: AiPostPlan, req: AiPostRequest, dec: number): Promise<AiRefusal | null> {
  if (plan.payableCheck) {
    const c = plan.payableCheck;
    const balance = await liabilityBalance(tx, tenantId, c.accountId);
    if (c.amountMilli > balance) {
      const avail = balance > 0n ? balance : 0n;
      return refuse('EXCEEDS_PAYABLE',
        `مبلغ السداد أكبر من رصيد «${c.accountName}» (${formatAmount(avail, dec)}). ${c.hint ?? 'سجّل الرواتب مستحقةً أولاً أو صحّح المبلغ.'}`,
        { balance: fromMilli(avail) });
    }
  }

  if (plan.accruedCheck) {
    const c = plan.accruedCheck;
    let accrued = false;
    if (c.accrualSummaryPrefix) {
      // استحقاقٌ رحّله المحاسب الذكي للشهر والمجموعة نفسيهما: ملخّصه يبدأ بالوصف نفسه وفيه سطرٌ دائن على الالتزام
      const prior = await tx.aiAccountantPost.findMany({
        where: { tenantId, kind: 'SALARIES', summaryAr: { startsWith: c.accrualSummaryPrefix } },
        select: { moveId: true }, orderBy: { createdAt: 'desc' }, take: 20,
      });
      const live = await liveMovesOf(tx, tenantId, prior.map((p) => p.moveId));
      accrued = live.some((m) => m.lines.some((l) => l.accountId === c.accountId && big(l.creditMilli) > 0n));
    }
    const balance = !accrued && c.minMilli !== null ? await liabilityBalance(tx, tenantId, c.accountId) : 0n;
    if (accrued || (c.minMilli !== null && balance >= c.minMilli)) {
      return refuse(c.code, c.message, accrued ? { accrued: true } : { balance: fromMilli(balance) });
    }
  }

  if (req.duplicateGuard) {
    const recent = await tx.aiAccountantPost.findMany({
      where: {
        tenantId, adminId: req.duplicateGuard.adminId, kind: plan.kind, createdAt: { gte: req.duplicateGuard.since },
        NOT: { ref: { startsWith: aiRefPrefix(req.clientRef) } },
      },
      select: { moveId: true, moveNumber: true }, orderBy: { createdAt: 'desc' }, take: 50,
    });
    const live = await liveMovesOf(tx, tenantId, recent.map((r) => r.moveId));
    const want = linesFingerprint(plan.kind, plan.lines);
    const dup = live.find((m) => linesFingerprint(plan.kind, m.lines) === want);
    if (dup) {
      const number = recent.find((r) => r.moveId === dup.id)?.moveNumber ?? null;
      return refuse('DUPLICATE_RECENT',
        `سبق ترحيل قيدٍ مطابق${number ? ` (${number})` : ''} من رسالة سابقة، فلم يُرحَّل ثانيةً. إن كان هذا قيداً جديداً فعلاً فليكتب المستخدم مبلغه بالأرقام في رسالته الجديدة.`,
        number ? { move_number: number } : undefined);
    }
  }
  return null;
}

/**
 * الترحيل كاملاً داخل معاملة tx: القفل ⇒ السياق ⇒ البناء ⇒ عدم التكرار (إعادة الإرسال تُعاد قبل أي فحص رصيد) ⇒ فحوص
 * القيد الجديد ⇒ postMove ⇒ صفّ AiAccountantPost. أي خطأ يُسقط المعاملة كلها (لا قيد بلا صفّه ولا صفّ بلا قيده). الرفض
 * يُرمى AiPostRefusal، وأخطاء الدفاتر LedgerError.
 */
export async function executeAiPost(tx: GlDb, req: AiPostRequest, deps: AiPostDeps = DEFAULT_AI_POST_DEPS): Promise<AiPostResult> {
  const { tenantId, actor } = req;
  if (!req.clientRef) throw new AiPostRefusal(refuse('CLIENT_REF_MISSING', 'تعذّر تمييز الطلب؛ أعد الإرسال من الصفحة.'));
  // القفل أولاً: البحث عن المرجع ورصيد الالتزام يُقرآن تحته فلا يرحّل طلبان متزامنان القيد مرتين (postMove يعيد أخذه)
  await deps.acquirePostLock(tx, tenantId);
  const lc = await deps.loadBuildContext(tx, tenantId);
  if (!lc.settings) throw new AiPostRefusal(refuse('NOT_ACTIVATED', 'الدفاتر غير مفعّلة لهذه الشركة بعد.'));
  const out = req.build(lc);
  if (!out.ok) throw new AiPostRefusal(out.refusal);
  const plan = out.plan;
  const dec = lc.ctx.settings.currencyDecimals;

  // عدم التكرار أولاً: القيود بالمراجع المرشّحة (لا القيود العكسية — تحمل المرجع نفسه) وصفوفها. إعادة إرسال قيدٍ رُحّل
  // (انقطع الرد ثم «إعادة المحاولة») تُعاد هنا قبل فحص الرصيد — فسدادٌ صفّر رصيد الالتزام لا يُرفض عند إعادته.
  const refs = Array.from({ length: MAX_POSTS_PER_REQUEST }, (_, i) => aiRefOf(req.clientRef, i + 1));
  const moves = await tx.glMove.findMany({
    where: { tenantId, ref: { in: refs }, reversedMoveId: null },
    select: { id: true, ref: true, lines: { select: { accountId: true, debitMilli: true, creditMilli: true }, orderBy: { seq: 'asc' } } },
  });
  const rows = await tx.aiAccountantPost.findMany({ where: { tenantId, ref: { in: refs } }, select: AI_POST_ROW_SELECT });
  const choice = chooseAiRef(req.clientRef, req.usedRefs, moves, rows, plan);
  const accountOf = (id: string) => lc.accountById.get(id) ?? null;

  if (choice.kind === 'replay') {
    const row = rows.find((r) => r.ref === choice.ref) as AiPostRow;
    const mv = moves.find((m) => m.id === choice.moveId);
    const reversal = await tx.glMove.findFirst({ where: { tenantId, reversedMoveId: choice.moveId }, select: { id: true } });
    // إعادة إرسال قيد مستند: مرفقه نُقل إليه في الترحيل الأول (المعاملة نفسها)
    return { move: postedMoveOf(row, mv?.lines ?? [], accountOf, !!reversal, { hasAttachment: !!row.docId }), replayed: true, warnings: [] };
  }
  if (choice.kind === 'none') {
    throw new AiPostRefusal(refuse('TOO_MANY_POSTS', `بلغ الطلب الواحد حدّ ${MAX_POSTS_PER_REQUEST} قيداً؛ أرسل الباقي في رسالة جديدة.`));
  }

  // قيدٌ جديد: رصيد الالتزام والاستحقاق السابق والتكرار بطلبٍ آخر — تحت القفل نفسه
  const problem = await newPostRefusal(tx, tenantId, plan, req, dec);
  if (problem) throw new AiPostRefusal(problem);
  // المستند: طبقات التكرار (الملف نفسه، رقم الفاتورة، المفتاح الرخو) بعد إعادة الإرسال وتحت القفل نفسه
  if (req.doc) {
    const dup = await req.doc.refusal(tx, plan, lc);
    if (dup) throw new AiPostRefusal(dup);
  }

  const draft: MoveDraft = { ...plan.draft, ref: choice.ref };
  const posted = await deps.postMove(tx, draft, {
    tenantId,
    actor,
    context: lc,
    validationMode: 'MANUAL',
    lockPolicy: 'REJECT',
    auditAction: AI_POST_AUDIT_ACTION,
    auditSummary: `المحاسب الذكي: ${plan.summaryAr}`.slice(0, 500),
    auditExtra: { aiAccountant: true, clientRef: req.clientRef, ref: choice.ref, kind: plan.kind, ...(plan.docId ? { docId: plan.docId } : {}) },
    ...(req.now ? { now: req.now } : {}),
  });
  // مرفق المستند يُنقل إلى القيد المرحَّل في المعاملة نفسها — بعد postMove (لا مسودة) وقبل الصفّ
  if (req.doc) await req.doc.relink(tx, { moveId: posted.id, moveNumber: posted.number });
  const row = await tx.aiAccountantPost.create({
    data: {
      tenantId,
      adminId: req.adminId,
      adminName: req.adminName,
      moveId: posted.id,
      moveNumber: posted.number,
      ref: choice.ref,
      kind: plan.kind,
      amountMilli: plan.totalMilli,
      dateLocal: posted.date,
      summaryAr: plan.summaryAr,
      // أعمدة المستندات تُكتب لقيودها وحدها (صفّ المحادثة النصّية بشكله القائم)
      ...(plan.docId ? { docId: plan.docId } : {}),
      ...(plan.parentPostId ? { parentPostId: plan.parentPostId } : {}),
      ...(plan.meta ? { meta: plan.meta as unknown as Prisma.InputJsonValue } : {}),
    },
    select: AI_POST_ROW_SELECT,
  });
  if (req.doc) await req.doc.linkDoc(tx, { moveId: posted.id, postId: row.id });
  const extras: PostedExtras = {
    ...(plan.docId ? { hasAttachment: true } : {}),
    ...(plan.meta ? { prepaid: { posted: 0, months: plan.meta.months, stopped: false, nextDate: amortizationMonthEnd(plan.meta.startYm, 1) } } : {}),
  };
  return { move: postedMoveOf(row, plan.lines, accountOf, false, extras), replayed: false, warnings: plan.warnings };
}

// ═══ الأخطاء ⇐ رفض مشروح ═══

/** LedgerError/AiPostRefusal/غيرهما ⇐ رفض عربي للمستخدم — الفترة المقفلة تشرح أول تاريخ مفتوح */
export function refusalFromError(e: unknown): AiRefusal {
  if (e instanceof AiPostRefusal) return e.refusal;
  if (isLedgerError(e)) {
    const d = e.details as Record<string, unknown>;
    switch (e.code) {
      case 'LEDGER_PERIOD_LOCKED': {
        const first = typeof d.firstOpenDate === 'string' ? d.firstOpenDate : null;
        const lock = typeof d.lockDate === 'string' ? d.lockDate : null;
        return refuse('LEDGER_PERIOD_LOCKED',
          `الفترة${lock ? ` حتى ${lock}` : ''} مقفلة في الدفاتر فلا يُرحَّل قيد بتاريخ ${String(d.date ?? '')}.${first ? ` أول تاريخ مفتوح ${first}: اطلب التسجيل بهذا التاريخ أو راجع محاسبك لفتح الفترة.` : ''}`,
          { date: d.date ?? null, lockDate: lock, firstOpenDate: first });
      }
      case 'LEDGER_NOT_SETUP':
        return refuse('NOT_ACTIVATED', 'الدفاتر غير مفعّلة لهذه الشركة بعد.');
      case 'LEDGER_VAT_LINE_UNTAGGED':
        return refuse('LEDGER_VAT_LINE_UNTAGGED', 'سطر الضريبة يحتاج ضريبة مشتريات بمربّع إقرار. سجّل المبلغ بلا ضريبة أو راجع إعداد الضرائب.');
      case 'LEDGER_CONTROL_ACCOUNT_MANUAL':
        return refuse('ACCOUNT_NOT_ALLOWED', 'القيد يمسّ حساباً رئيسياً لا يُرحَّل إليه يدوياً. اختر حساباً آخر.');
      case 'LEDGER_ACCOUNT_ARCHIVED':
        return refuse('ACCOUNT_NOT_ALLOWED', 'أحد حسابات القيد أو دفتره مؤرشف. فعّله في الدفاتر أو اختر حساباً آخر.');
      default:
        return refuse('LEDGER_ERROR', `رفضت الدفاتر القيد (${e.code}). لم يُسجَّل شيء.`, { ledgerCode: e.code });
    }
  }
  return refuse('POST_FAILED', 'تعذّر الترحيل الآن ولم يُسجَّل شيء. حاول بعد قليل.');
}

// ═══ قائمة «قيود المحاسب الذكي» ═══

export interface AiPostsListDb {
  aiAccountantPost: { findMany(args: unknown): Promise<AiPostRow[]> };
  glMove: { findMany(args: unknown): Promise<unknown[]> };
  glAccount: { findMany(args: unknown): Promise<{ id: string; code: string; name: string }[]> };
  /** مرفقات القيود — يُسأل لصفوف المستندات وحدها */
  glAttachment?: { findMany(args: unknown): Promise<{ entityId: string }[]> };
}

/** جدول الإطفاء من AiAccountantPost.meta (Json) — شكلٌ غير متوقّع ⇒ null (لا يُرمى في قائمة) */
export function scheduleOf(meta: unknown): PrepaidSchedule | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  const int = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v);
  if (!Number.isInteger(m.months) || (m.months as number) < 1 || !int(m.monthlyMilli) || !int(m.lastMilli) || !int(m.baseMilli)) return null;
  if (typeof m.startYm !== 'string' || !/^\d{4}-\d{2}$/.test(m.startYm) || typeof m.prepaidCode !== 'string' || typeof m.expenseCode !== 'string') return null;
  const skip = m.lockedSkip && typeof m.lockedSkip === 'object' ? m.lockedSkip as Record<string, unknown> : null;
  return {
    months: m.months as number, baseMilli: m.baseMilli as string, monthlyMilli: m.monthlyMilli as string, lastMilli: m.lastMilli as string,
    startYm: m.startYm, prepaidCode: m.prepaidCode, expenseCode: m.expenseCode, what: typeof m.what === 'string' ? m.what : '',
    lockedSkip: skip && Number.isInteger(skip.k) && typeof skip.date === 'string'
      ? { k: skip.k as number, date: skip.date, at: typeof skip.at === 'string' ? skip.at : '' } : null,
  };
}

/** تنبيه قيد دفعٍ مقدّم عُكس بعد ترحيل أقساطٍ منه — الأقساط باقية لا تُعكس آلياً (D2) */
export const prepaidReversedWarning = (liveAmortizations: number): string =>
  `عُكس قيد الدفع — راجع قيود الإطفاء المرحّلة (${liveAmortizations})`;

/** تنبيه فترة مقفلة تخطّاها الإطفاء — يُعاد تلقائياً بعد فتحها */
export const prepaidLockedWarning = (date: string): string =>
  `الفترة مقفلة فلم يُرحَّل قسط الإطفاء بتاريخ ${date}؛ يُرحَّل تلقائياً بعد فتحها`;

/**
 * أحدث قيود المحاسب الذكي للشركة (tenantId من الجلسة وحدها): الصفّ + سطور القيد الحيّة + «معكوس؟» من GlMove.reversedMoveId.
 * قيدٌ حُذف أو أُعيد مسودةً يظهر reversed=true (لم يعد في الدفاتر فلا زرّ عكس له).
 * صفوف المستندات تحمل docId وhasAttachment (مرفقٌ على القيد)، وقيد المدفوع مقدماً تقدّم إطفائه {posted, months} وتنبيهه
 * (عُكس قيد الدفع بعد أقساطٍ حيّة، أو فترة مقفلة تُخطّيت)، والأصل «يحتاج إهلاكاً».
 */
export async function listAiPostsWith(db: AiPostsListDb, tenantId: string, limit: number): Promise<PostedMove[]> {
  if (!tenantId) return [];
  const take = Math.min(200, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 50) || 50));
  const rows = await db.aiAccountantPost.findMany({
    where: { tenantId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take, select: AI_POST_ROW_SELECT,
  });
  if (rows.length === 0) return [];
  // أقساط قيود الدفع المقدّم في الصفحة (للتقدّم وتنبيه العكس) — تُسأل لها وحدها
  const prepaidIds = rows.filter((r) => r.kind === 'PREPAID').map((r) => r.id);
  const amortRows = prepaidIds.length
    ? await db.aiAccountantPost.findMany({
      where: { tenantId, parentPostId: { in: prepaidIds } }, select: { id: true, parentPostId: true, moveId: true, ref: true },
    }) as unknown as { id: string; parentPostId: string | null; moveId: string; ref?: string }[]
    : [];
  const moveIds = [...new Set([...rows.map((r) => r.moveId), ...amortRows.map((r) => r.moveId)])];
  const moves = await db.glMove.findMany({
    where: { tenantId, id: { in: moveIds } },
    select: { id: true, state: true, lines: { select: { accountId: true, debitMilli: true, creditMilli: true }, orderBy: { seq: 'asc' } } },
  }) as { id: string; state: string; lines: FingerprintLine[] }[];
  const reversals = await db.glMove.findMany({
    where: { tenantId, reversedMoveId: { in: moveIds } }, select: { reversedMoveId: true },
  }) as { reversedMoveId: string | null }[];
  const accountIds = [...new Set(moves.flatMap((m) => m.lines.map((l) => l.accountId)))];
  const accounts = accountIds.length
    ? await db.glAccount.findMany({ where: { tenantId, id: { in: accountIds } }, select: { id: true, code: true, name: true } })
    : [];
  const moveById = new Map(moves.map((m) => [m.id, m]));
  const reversed = new Set(reversals.map((r) => r.reversedMoveId).filter((x): x is string => !!x));
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const deadMove = (moveId: string) => {
    const mv = moveById.get(moveId);
    return !mv || mv.state !== 'POSTED' || reversed.has(moveId);
  };
  // أقساط الإطفاء في الصفحة: عدد أشهرها من جدول قيد الدفع المقدّم أبيها — في الصفحة نفسها، وإلا يُسأل عنه وحده
  const parentMeta = new Map<string, unknown>(rows.filter((r) => r.kind === 'PREPAID').map((r) => [r.id, r.meta]));
  const missingParents = [...new Set(rows
    .filter((r) => r.kind === 'PREPAID_AMORT' && r.parentPostId && !parentMeta.has(r.parentPostId))
    .map((r) => r.parentPostId as string))];
  if (missingParents.length) {
    const parents = await db.aiAccountantPost.findMany({
      where: { tenantId, id: { in: missingParents } }, select: { id: true, meta: true },
    }) as unknown as { id: string; meta?: unknown }[];
    for (const p of parents) if (missingParents.includes(p.id)) parentMeta.set(p.id, p.meta);
  }
  // المرفق على القيد نفسه (نُقل إليه في معاملة الترحيل) — قد يُحذف من الدفاتر بعدها
  const docMoveIds = rows.filter((r) => r.docId).map((r) => r.moveId);
  const attached = new Set<string>();
  if (docMoveIds.length && db.glAttachment) {
    const atts = await db.glAttachment.findMany({
      where: { tenantId, entityType: 'MOVE', entityId: { in: [...new Set(docMoveIds)] } }, select: { entityId: true },
    });
    for (const a of atts) attached.add(a.entityId);
  }
  return rows.map((row) => {
    const mv = moveById.get(row.moveId);
    const isDead = deadMove(row.moveId);
    const extras: PostedExtras = {};
    if (row.docId) extras.hasAttachment = attached.has(row.moveId);
    if (row.kind === 'PREPAID') {
      const s = scheduleOf(row.meta);
      const mine = amortRows.filter((a) => a.parentPostId === row.id);
      if (s) {
        const postedKs = new Set(mine.map((a) => Number(/-(\d+)$/.exec(a.ref ?? '')?.[1] ?? NaN)).filter((k) => Number.isInteger(k)));
        let next = 1;
        while (postedKs.has(next)) next++;
        extras.prepaid = {
          posted: Math.min(mine.length, s.months), months: s.months, stopped: isDead,
          nextDate: !isDead && next <= s.months ? amortizationMonthEnd(s.startYm, next) : null,
          ...(s.lockedSkip ? { lockedMonths: [s.lockedSkip.date.slice(0, 7)] } : {}),
        };
      }
      const liveAmort = mine.filter((a) => !deadMove(a.moveId)).length;
      if (isDead && liveAmort > 0) extras.warning = prepaidReversedWarning(liveAmort);
      else if (!isDead && s?.lockedSkip && mine.length < s.months) extras.warning = prepaidLockedWarning(s.lockedSkip.date);
    } else if (row.kind === 'ASSET' && !isDead) {
      extras.warning = ASSET_DEPRECIATION_NOTE;
    } else if (row.kind === 'PREPAID_AMORT' && row.parentPostId) {
      // «الشهر k من n» في البطاقة (amortText في الويب)
      const k = Number(/-(\d+)$/.exec(row.ref ?? '')?.[1] ?? NaN);
      const s = scheduleOf(parentMeta.get(row.parentPostId));
      if (s && Number.isInteger(k) && k >= 1 && k <= s.months) extras.amort = { parentPostId: row.parentPostId, index: k, months: s.months };
    }
    return postedMoveOf(row, mv?.lines ?? [], (id) => accountById.get(id), isDead, extras);
  });
}
