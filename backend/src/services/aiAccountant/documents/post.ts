/**
 * «المحاسب الذكي AI» — ترحيل المستند من بطاقته (طلب المالك ١٨ نوفمبر ٢٠٢٦، القرار D1): ضغطة «سجّل القيد» ترسل دورة محادثة
 * فيها docConfirm، فيرحّل الخادم **بلا أي نموذج** — المبالغ من الحقائق المخزّنة (لا من العميل ولا من نموذج) ويجب أن ترد
 * حرفياً في نصّ آخر رسالة للمستخدم (حارس المبلغ القائم)، والحساب ومصدر الدفع برمزيهما كذلك.
 *
 * ترتيب الحرّاس (ثابت ومختبَر):
 *   1. المستندات مفعّلة: مفتاح البيئة AI_ACCOUNTANT_DOCS، والترحيل (AI_ACCOUNTANT_WRITE، الدفاتر المفعّلة، «ترحيل القيود»)
 *      ثم إعادة فحص البوابات من القاعدة (writeGateRefusal) ⇒ DOCS_DISABLED / WRITE_DISABLED / NOT_ACTIVATED / NOT_ALLOWED.
 *   2. المستند ضمن مستندات آخر رسالة ومحمَّل بالشركة والرافع نفسه (actorRef) ⇒ DOC_NOT_ATTACHED / DOC_NOT_FOUND، ونصّ آخر
 *      رسالة طلب ترحيل («سجّل…» — writeIntentIn كحارس المحادثة) ⇒ وإلا DOC_TOTAL_NOT_CONFIRMED {field:'intent'}.
 *   3. حالته وفحوصه: ملفٌ مفقود DOC_FILE_GONE، بلا حقائق DOC_NOT_READY، أشهرٌ مخزّنة فوق 24 DOC_TREATMENT_REFERRED، فحصٌ
 *      مانع DOC_NEEDS_REVIEW (والعقد بلا دفع NOT_A_PAYMENT)، وعملةٌ أخرى DOC_CURRENCY_MISMATCH. فحوص التاريخ النسبية لليوم
 *      (DATE_FUTURE/DATE_TOO_OLD) المخزّنة لا تُقرأ هنا — تشيخ؛ والتاريخ يحكمه postingDateProblem في الخطة تحت القفل.
 *   4. الإجمالي (والضريبة حين تُفصل) حرفياً في نصّ آخر رسالة ⇒ DOC_TOTAL_NOT_CONFIRMED.
 *   5. رمز الحساب حرفياً ⇒ ACCOUNT_NOT_IN_MESSAGE.
 *   6. رمز حساب الدفع المحلول (الصندوق/البنك أو 213002) حرفياً ⇒ PAYMENT_SOURCE_NOT_IN_MESSAGE.
 *   7. المعالجة مسموحة: بضاعة DOC_IS_INVENTORY، أرض/مبنى DOC_TREATMENT_REFERRED، معالجة لا تطابق الحساب
 *      TREATMENT_NOT_ALLOWED، عقدٌ آجل NOT_A_PAYMENT، أشهر 1..24 مكتوبة بجوار «شهر» في الرسالة (PREPAID_MONTHS_INVALID،
 *      والأطول DOC_TREATMENT_REFERRED)، حدّ الرسملة ASSET_BELOW_THRESHOLD، وتاريخ القيد (المختار يُكتب في الرسالة).
 *      المدفوع مقدماً: حساب المدفوع مقدماً ومصروف الإطفاء الشهري كلاهما مكتوبان في الرسالة (ACCOUNT_NOT_IN_MESSAGE) — ما
 *      يُرحَّل ويُطفأ عليه هو ما راجعه المستخدم في البطاقة، لا تخمينٌ من اسم المورد.
 *   8. executeAiPost: القفل ⇒ السياق ⇒ الخطة ⇒ إعادة الإرسال (البصمة بمعرّف المستند) ⇒ طبقات التكرار ⇒ postMove ⇒ نقل
 *      المرفق (relinkDocAttachment) ⇒ صفّ AiAccountantPost{docId, meta} ⇒ المستند يشير لقيده (markDocPosted) — معاملة واحدة.
 * الحرّاس 4–7 صرفة (planDocumentPost) تُنفَّذ داخل البناء تحت القفل بدليل الشركة المقروء هناك — فما يُفحص هو ما يُرحَّل.
 *
 * طبقات التكرار (تحت القفل، بعد إعادة الإرسال):
 *   - الملف نفسه (sha256) مرحّلٌ في قيد حيّ لأي مستند في الشركة ⇒ DOC_ALREADY_POSTED (لا تجاوز؛ بعد العكس يُعاد الترحيل).
 *   - أقساط إطفاءٍ حيّة من قيد دفعٍ مقدّم سابق للمستند نفسه (أو لملفه) عُكس أبوه — الأقساط تبقى بعد العكس (D2) — ⇒
 *     PREPAID_AMORT_LIVE (لا تجاوز): تُعكس أولاً، وإلا حُمّل المصروف مرتين بجدولٍ جديد يبدأ من الشهر الأول.
 *   - رقم الفاتورة نفسه من المورد نفسه في قيد مستندٍ حيّ ⇒ DOC_POSSIBLE_DUPLICATE (INVOICE_NO).
 *   - المفتاح الرخو: المورد والتاريخ والإجمالي نفسها في قيد مستندٍ حيّ، أو قيدٌ حيّ للمحاسب الذكي خلال ٣٠ يوماً بالمبلغ
 *     والتاريخ وحساب المدين نفسها (فاتورة كُتبت بيدٍ بـpost_expense) ⇒ DOC_POSSIBLE_DUPLICATE (SOFT).
 *   «ليست مكررة — سجّلها» تعيد الإرسال بـconfirmedNotDuplicate ونصٍّ فيه «ليست مكررة» فتُتخطّى الطبقتان الأخيرتان وحدهما.
 * لا sourceType ولا GlMoveSource: القيد يدويّ يعكسه المستخدم من الدفاتر، والمرفق يبقى على القيد المعكوس (العكس لا يحذف
 * المرفقات) ويُنقل إلى القيد الجديد عند إعادة الترحيل.
 */
import prisma from '../../../config/database';
import { ledgerActor } from '../../gl/audit';
import { POST_TX_OPTIONS } from '../../gl/autoPost';
import { clearingFeeTax } from '../../gl/builders/clearing';
import { isLocalDate } from '../../gl/dates';
import type { GlDb, LedgerContext } from '../../gl/resolve';
import type { LocalDate, Milli } from '../../gl/types';
import { actorRefOf, aiWriteEnabled, writeIntentIn, type AcctCtx, type PostedMove } from '../context';
import {
  DEFAULT_AI_POST_DEPS, amountInUserText, buildAssetPlan, buildDocExpensePlan, buildPrepaidPlan, cleanText, executeAiPost,
  normalizeAmountText, postingDateProblem, refusalFromError, resolveDocPayment, stripDateTokens,
  type AiDocHooks, type AiPostDeps, type AiPostPlan, type AiRefusal, type AiRefusalCode, type CashSource, type DocPlanInput,
  type PlanEnv, type PlanOutcome,
} from '../posting';
import { writeGateRefusal, type WriteGateDb } from '../writeTools';
import { assetThresholdMilli, docsEnabledFor, docsEnvEnabled } from './caps';
import { factAmount, normKey } from './normalize';
import {
  docViewsFor, findOwnDoc, loadDocEnv, markDocPosted, relinkDocAttachment, type DocsDb,
} from './store';
import { amortizationAccountFor, paidMonths, treatmentOfCode, vatModeFor } from './suggest';
import { isDateRelativeCheck } from './checks';
import {
  ACCT_PREPAID_MAX_MONTHS, VENDOR_VAT_RE,
  type AcctDocCheck, type AcctDocConfirm, type AcctDocFacts, type AcctDocView,
} from './types';
import { parseChecks, parseFacts, type DocRow } from './view';

// ═══ الثوابت ═══

/** نافذة المفتاح الرخو على قيود المحاسب الذكي (فاتورة كُتبت بيدٍ ثم رُفعت) */
export const SOFT_DUP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** «سجّل» في نصّ التأكيد (البطاقة تبدأ به دائماً: «سجّل المستند: …») — مع نيّة التسجيل writeIntentIn */
export const CONFIRM_VERB_RE = /سج[ّ]?ل/;

/** «ليست مكررة» في نصّ المستخدم — شرط تجاوز DOC_POSSIBLE_DUPLICATE مع confirmedNotDuplicate */
export const NOT_DUPLICATE_RE = /ليست\s*مكرر|ليس\s*مكرر|not\s*(?:a\s*)?duplicate/i;

/** وصف نوع المستند في السطور والملخّص */
const DOC_TYPE_AR: Readonly<Record<string, string>> = {
  TAX_INVOICE: 'فاتورة ضريبية',
  SIMPLIFIED_INVOICE: 'فاتورة مبسطة',
  LEASE_CONTRACT: 'عقد إيجار',
  MAINTENANCE_INVOICE: 'فاتورة صيانة',
  UTILITY_BILL: 'فاتورة خدمات',
  RECEIPT: 'إيصال',
  OTHER: 'مستند',
};

// ═══ البوابة ═══

/**
 * رفع المستندات وترحيلها متاحان لهذه الدورة: حكم /status docs.enabled نفسه (docsEnabledFor في caps.ts: AI_ACCOUNTANT_DOCS
 * المفعّل افتراضياً + AI_ACCOUNTANT_WRITE ≠ 0 + المحادثة تعمل + «ترحيل القيود» ctx.canPost) مع الدفاتر المفعّلة صراحةً —
 * عَلَم الشركة يحرسه الموجّه (requireAiAccountant). chatReady: المحادثة اجتازت حرّاسها (chat.ts) فلا يُعاد فحص البيئة.
 */
export function docsAllowed(
  ctx: Pick<AcctCtx, 'canPost' | 'booksActivated' | 'accountingOn'>, env: NodeJS.ProcessEnv = process.env, chatReady?: boolean,
): boolean {
  const enabled = chatReady === undefined ? docsEnabledFor(ctx, env) : docsEnabledFor(ctx, env, chatReady);
  return enabled && ctx.booksActivated === true && ctx.accountingOn !== false;
}

const refuse = (code: AiRefusalCode, message: string, details?: Record<string, unknown>): AiRefusal =>
  (details ? { code, message, details } : { code, message });

const isRefusal = (v: unknown): v is AiRefusal =>
  !!v && typeof v === 'object' && typeof (v as AiRefusal).code === 'string' && typeof (v as AiRefusal).message === 'string';

/** البوابة الثابتة من البيئة والسياق — بالترتيب: المستندات ثم الترحيل ثم الدفاتر ثم الصلاحية ثم مفتاح الطلب */
export function docGateRefusal(ctx: AcctCtx, env: NodeJS.ProcessEnv): AiRefusal | null {
  if (!docsEnvEnabled(env)) return refuse('DOCS_DISABLED', 'ترحيل المستندات متوقف مؤقتاً لدى المنصة — المحادثة والتقارير تعمل كالمعتاد.');
  if (!aiWriteEnabled(env)) return refuse('WRITE_DISABLED', 'الترحيل متوقف مؤقتاً لدى المنصة — القراءة والتقارير تعمل كالمعتاد.');
  if (ctx.accountingOn === false || ctx.booksActivated !== true) return refuse('NOT_ACTIVATED', 'ترحيل المستندات يحتاج دفاتر مفعّلة لهذه الشركة.');
  if (ctx.canPost !== true) return refuse('NOT_ALLOWED', 'ترحيل المستندات يحتاج صلاحية «ترحيل القيود» في الدفاتر.');
  if (!ctx.clientRef) return refuse('CLIENT_REF_MISSING', 'تعذّر تمييز الطلب؛ أعد الإرسال من الصفحة.');
  return null;
}

// ═══ الحرّاس الحرفية ═══

/** رمز حسابٍ وارد حرفياً في النص (بعد توحيد الأرقام الهندية) — لا جزءاً من رقمٍ أطول */
export function codeInText(code: string | null | undefined, text: string): boolean {
  const c = (code ?? '').trim();
  if (!c || !/^[0-9A-Za-z.\-]{1,32}$/.test(c)) return false;
  const esc = c.replace(/[.\-]/g, (m) => `\\${m}`);
  return new RegExp(`(?<![0-9A-Za-z])${esc}(?![0-9A-Za-z])`).test(normalizeAmountText(text));
}

/**
 * عدد الأشهر وارد في النص رقماً قائماً بذاته **بجوار كلمة الشهر** («12 شهراً»، «١٢ شهر»، «3 أشهر») — بعد محو التواريخ
 * (stripDateTokens كحارس المبلغ): «بتاريخ 2026-11-10» لا يشهد لـ11 ولا لـ10، ورقمٌ عابر في النص لا يشهد لعدد الإطفاء.
 */
export function monthsInText(months: number, text: string): boolean {
  if (!Number.isInteger(months) || months < 1) return false;
  return new RegExp(`(?<![0-9.])${months}\\s*(?:شهر|أشهر|اشهر|آشهر|months?\\b)`, 'i').test(stripDateTokens(normalizeAmountText(text)));
}

/** تاريخٌ مختار وارد في النص حرفياً (YYYY-MM-DD بعد توحيد الأرقام) */
export function dateInText(date: string, text: string): boolean {
  return isLocalDate(date) && normalizeAmountText(text).includes(date);
}

// ═══ الخطة الصرفة (الحرّاس 4–7) ═══

/** ما يحتاجه حساب الخطة من المستند — من الصفّ المخزّن لا من العميل */
export interface DocPostFacts {
  docId: string;
  facts: AcctDocFacts;
  factsSource: string | null;
}

export interface DocPlanArgs {
  doc: DocPostFacts;
  confirm: AcctDocConfirm;
  /** نصّ آخر رسالة للمستخدم وحدها */
  lastText: string;
  todayLocal: LocalDate;
  /** حدّ الرسملة بالملّي (D3) */
  assetThresholdMilli: Milli;
}

/** وصف المستند للسطور: النوع — المورد رقم الفاتورة (منظّفاً، بلا أرقام ضريبية) */
export function docWhat(facts: AcctDocFacts): string {
  const type = DOC_TYPE_AR[facts.docType ?? 'OTHER'] ?? 'مستند';
  const vendor = cleanText(facts.vendorName, 80);
  const no = cleanText(facts.invoiceNo, 40);
  return cleanText(`${type}${vendor ? ` — ${vendor}` : ''}${no ? ` رقم ${no}` : ''}`, 160);
}

/** أشهر الدفع المقدّم: المختارة في البطاقة، ثم المخزّنة، ثم من الفترة (paidMonths) */
export function prepaidMonthsOf(confirm: Pick<AcctDocConfirm, 'months'>, facts: AcctDocFacts): number | null {
  if (confirm.months !== null && confirm.months !== undefined) return confirm.months;
  return paidMonths(facts);
}

/** أول شهر خدمة YYYY-MM: بداية فترة المستند إن صلحت، وإلا شهر تاريخ القيد */
export function startYmOf(facts: AcctDocFacts, postingDate: LocalDate): string {
  return (facts.periodFrom && isLocalDate(facts.periodFrom) ? facts.periodFrom : postingDate).slice(0, 7);
}

/**
 * الحرّاس 4–7 ثم بناء القيد — صرفة فوق دليل الشركة (lc تحت القفل). المبالغ من الحقائق المخزّنة بمنازل عملة الدفاتر،
 * والضريبة بحكم D7 (vatModeFor في suggest.ts — حكم البطاقة نفسه) بمربّع الدفاتر الفعلي (clearingFeeTax).
 */
export function planDocumentPost(env: PlanEnv, a: DocPlanArgs): PlanOutcome {
  const { lc } = env;
  const { facts } = a.doc;
  const c = a.confirm;
  const text = a.lastText ?? '';
  const dec = lc.ctx.settings.currencyDecimals;
  const fail = (r: AiRefusal): PlanOutcome => ({ ok: false, refusal: r });
  const total = factAmount(facts.total, dec);
  if (total === null || total <= 0n) return fail(refuse('DOC_NOT_READY', 'إجمالي المستند غير مُدخل: أكمله في البطاقة ثم اضغط «سجّل القيد».'));
  const vat = factAmount(facts.vatAmount, dec) ?? 0n;

  // حساب الإطفاء للمدفوع مقدماً (حكم ضريبة سكن الموظفين بحسابه، والقيد بعده)
  const accountCode = (c.accountCode ?? '').trim();
  const prepaidByCode = c.treatment === 'PREPAID' && treatmentOfCode(accountCode) === 'PREPAID';
  const amortCode = c.treatment !== 'PREPAID' ? null
    : prepaidByCode ? (amortizationAccountFor(facts, accountCode, null, { ledger: lc })?.code ?? null) : accountCode;
  const vatMode = vatModeFor(facts, { accountCode, expenseCode: amortCode },
    { taxDisabled: env.taxDisabled, vatBox: clearingFeeTax(lc.ctx) !== null, currency: env.currency, currencyDecimals: dec }).vatMode;

  // 4) المبالغ من الحقائق حرفياً في نصّ المستخدم
  if (!amountInUserText(total, text)) {
    return fail(refuse('DOC_TOTAL_NOT_CONFIRMED',
      'إجمالي المستند غير مكتوب في رسالة التأكيد كما في البطاقة، فلم يُرحَّل شيء. اضغط «سجّل القيد» من البطاقة ولا تحذف المبلغ من النص.',
      { field: 'total' }));
  }
  if (vatMode === 'DEDUCTIBLE' && vat > 0n && !amountInUserText(vat, text)) {
    return fail(refuse('DOC_TOTAL_NOT_CONFIRMED',
      'ضريبة المستند غير مكتوبة في رسالة التأكيد كما في البطاقة، فلم يُرحَّل شيء. اضغط «سجّل القيد» من البطاقة ولا تحذف الضريبة من النص.',
      { field: 'vatAmount' }));
  }
  // 5) رمز الحساب
  if (!codeInText(accountCode, text)) {
    return fail(refuse('ACCOUNT_NOT_IN_MESSAGE', 'رمز الحساب المختار غير مكتوب في رسالة التأكيد، فلم يُرحَّل شيء. اختر الحساب في البطاقة ثم اضغط «سجّل القيد».',
      { accountCode }));
  }
  // 6) رمز حساب الدفع المحلول من دليل الشركة (ما سيُقيَّد دائناً فعلاً)
  const pay = resolveDocPayment(lc, c.paidFrom as CashSource | 'payable', c.paidFromAccountCode ?? null);
  if (isRefusal(pay)) return fail(pay);
  if (!codeInText(pay.account.code, text)) {
    return fail(refuse('PAYMENT_SOURCE_NOT_IN_MESSAGE',
      `حساب الدفع (${pay.account.code} ${pay.account.name}) غير مكتوب في رسالة التأكيد، فلم يُرحَّل شيء. اختر «مدفوع من» في البطاقة ثم اضغط «سجّل القيد».`,
      { paidFrom: c.paidFrom, accountCode: pay.account.code }));
  }

  // 7) المعالجة
  if (facts.categoryHint === 'inventory_goods') {
    return fail(refuse('DOC_IS_INVENTORY', 'هذه بضاعة للبيع: تُسجَّل من «مشتريات المستودع» ليدخل المخزون وتكلفته، لا من المحاسب الذكي. لم يُرحَّل شيء.'));
  }
  if (facts.assetClassHint === 'land_buildings') {
    return fail(refuse('DOC_TREATMENT_REFERRED', 'شراء الأراضي والمباني يقرّر قيده محاسبك البشري، فلم يُرحَّل شيء. احفظ المستند وأحِله إليه.'));
  }
  const codeKind = treatmentOfCode(accountCode);
  if ((c.treatment === 'EXPENSE' && codeKind !== 'EXPENSE') || (c.treatment === 'ASSET' && codeKind !== 'ASSET' && !['121001', '121002'].includes(accountCode))
    || (c.treatment === 'PREPAID' && codeKind === 'ASSET')) {
    return fail(refuse('TREATMENT_NOT_ALLOWED', 'المعالجة المختارة لا تطابق الحساب (مصروف أو مدفوع مقدماً أو أصل). اختر الحساب من قائمة البطاقة.',
      { treatment: c.treatment, accountCode }));
  }
  if (facts.docType === 'LEASE_CONTRACT' && c.paidFrom === 'payable') {
    return fail(refuse('NOT_A_PAYMENT', 'عقد الإيجار وحده ليس دفعاً ولا فاتورة مستحقة: اذكر كم دُفع ومن أي حساب (صندوق أو بنك). لم يُرحَّل شيء.'));
  }
  let months: number | null = null;
  if (c.treatment === 'PREPAID') {
    months = prepaidMonthsOf(c, facts);
    if (months === null || !Number.isInteger(months) || months < 1) {
      return fail(refuse('PREPAID_MONTHS_INVALID', `اذكر عدد أشهر الدفع المقدّم (من 1 إلى ${ACCT_PREPAID_MAX_MONTHS}) في البطاقة.`, { months }));
    }
    if (months > ACCT_PREPAID_MAX_MONTHS) {
      return fail(refuse('DOC_TREATMENT_REFERRED',
        `دفعٌ مقدّم لأكثر من ${ACCT_PREPAID_MAX_MONTHS} شهراً يقرّر قيده محاسبك البشري (عقد طويل الأجل)، فلم يُرحَّل شيء.`, { months }));
    }
    if (!monthsInText(months, text)) {
      return fail(refuse('PREPAID_MONTHS_INVALID', 'عدد أشهر الإطفاء غير مكتوب في رسالة التأكيد كما في البطاقة، فلم يُرحَّل شيء.',
        { months, reason: 'NOT_IN_MESSAGE' }));
    }
  }
  // تاريخ القيد: تاريخ الفاتورة (ضريبة المدخلات في فترتها)، أو تاريخٌ اختاره المستخدم مكتوباً في رسالته
  const chosen = (c.date ?? '').trim();
  if (chosen && !dateInText(normalizeAmountText(chosen), text)) {
    return fail(refuse('DATE_INVALID', 'تاريخ القيد المختار غير مكتوب في رسالة التأكيد، فلم يُرحَّل شيء.', { date: chosen }));
  }
  const date = chosen ? normalizeAmountText(chosen) : (facts.issueDate ?? '');
  const dp = postingDateProblem(date, a.todayLocal);
  if (dp) return fail(dp);

  const input: DocPlanInput = {
    docId: a.doc.docId, accountCode, paidFrom: c.paidFrom as CashSource | 'payable', paidFromAccountCode: c.paidFromAccountCode ?? null,
    totalMilli: total, vatMilli: vat, vatMode, date, what: docWhat(facts),
  };
  if (c.treatment === 'ASSET') return buildAssetPlan(env, { ...input, thresholdMilli: a.assetThresholdMilli });
  if (c.treatment === 'PREPAID') {
    // المختار حساب المدفوع مقدماً (115002/115001) ⇒ مصروف إطفائه بحكم البطاقة نفسه (amortizationAccountFor)؛ وإلا المختار
    // هو مصروف الإطفاء ويُشتق حساب المدفوع مقدماً منه (الإيجار وسكن الموظفين ⇐ 115002)
    if (prepaidByCode && !amortCode) {
      return fail(refuse('ACCOUNT_MISSING', 'لم يُعرف حساب المصروف الذي يُطفأ عليه المبلغ شهرياً. اختر نوع المصروف في البطاقة.', { accountCode }));
    }
    const out = buildPrepaidPlan(env, {
      ...input, accountCode: amortCode ?? accountCode, prepaidCode: prepaidByCode ? accountCode : null,
      months: months as number, startYm: startYmOf(facts, date),
    });
    // D1: حساب المدفوع مقدماً ومصروف الإطفاء الشهري كما سيُرحَّلان فعلاً (بعد الحلّ من دليل الشركة) مكتوبان في رسالة التأكيد
    // — فلا يُطفأ المبلغ على مصروفٍ لم يره المستخدم (اختيار 115001/115002 وحده لا يكفي: المصروف يُختار في البطاقة)
    if (out.ok && out.plan.meta) {
      const { expenseCode, prepaidCode } = out.plan.meta;
      if (!codeInText(expenseCode, text)) {
        return fail(refuse('ACCOUNT_NOT_IN_MESSAGE',
          'حساب المصروف الذي يُطفأ عليه المبلغ شهرياً غير مكتوب في رسالة التأكيد، فلم يُرحَّل شيء. اختر في البطاقة حساب المصروف (الإيجار، الاشتراكات، التأمين…) ثم اضغط «سجّل القيد».',
          { accountCode, amortizationCode: expenseCode }));
      }
      if (!codeInText(prepaidCode, text)) {
        return fail(refuse('ACCOUNT_NOT_IN_MESSAGE',
          `حساب المدفوع مقدماً (${prepaidCode}) غير مكتوب في رسالة التأكيد، فلم يُرحَّل شيء. اضغط «سجّل القيد» من البطاقة.`,
          { accountCode, prepaidCode }));
      }
    }
    return out;
  }
  return buildDocExpensePlan(env, input);
}

// ═══ طبقات التكرار (تحت القفل) ═══

/** مفتاح المورد للمطابقة: الرقم الضريبي الصالح، وإلا الاسم الموحَّد */
export function vendorKeyOf(facts: Pick<AcctDocFacts, 'vendorVat' | 'vendorName'> | null): string {
  if (!facts) return '';
  const vat = normKey(facts.vendorVat);
  if (vat && VENDOR_VAT_RE.test(vat)) return `vat:${vat}`;
  const name = normKey(facts.vendorName);
  return name ? `name:${name}` : '';
}

/** القيود الحيّة (مرحّلة بلا قيد عاكس) من معرّفاتها برقمها */
async function liveNumbers(tx: GlDb, tenantId: string, ids: readonly (string | null | undefined)[]): Promise<Map<string, string | null>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, string | null>();
  if (!want.length) return out;
  const moves = await tx.glMove.findMany({ where: { tenantId, id: { in: want }, state: 'POSTED' }, select: { id: true, number: true } });
  const reversals = await tx.glMove.findMany({ where: { tenantId, reversedMoveId: { in: want } }, select: { reversedMoveId: true } });
  const reversed = new Set(reversals.map((r) => r.reversedMoveId).filter((x): x is string => !!x));
  for (const m of moves) if (!reversed.has(m.id)) out.set(m.id, m.number ?? null);
  return out;
}

/**
 * أرقام أقساط الإطفاء الحيّة (PREPAID_AMORT مرحّلة بلا عاكس) لكل قيد دفعٍ مقدّم سابق (PREPAID) لهذه المستندات — الأب
 * المعكوس يوقف الجدول ويُبقي ما رُحّل (D2)، فإعادة ترحيل المستند بجدولٍ يبدأ من الشهر الأول تكرّرها.
 */
export async function liveAmortizationOf(tx: GlDb, tenantId: string, docIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(docIds.filter(Boolean))];
  if (!ids.length) return [];
  const parents = await tx.aiAccountantPost.findMany({
    where: { tenantId, kind: 'PREPAID', docId: { in: ids } }, select: { id: true }, take: 50,
  });
  if (!parents.length) return [];
  const kids = await tx.aiAccountantPost.findMany({
    where: { tenantId, kind: 'PREPAID_AMORT', parentPostId: { in: parents.map((p) => p.id) } },
    select: { moveId: true, moveNumber: true }, orderBy: { createdAt: 'asc' }, take: 500,
  });
  const live = await liveNumbers(tx, tenantId, kids.map((k) => k.moveId));
  return kids.filter((k) => live.has(k.moveId)).map((k) => k.moveNumber ?? live.get(k.moveId) ?? k.moveId);
}

export interface DupInput {
  tenantId: string;
  doc: Pick<DocRow, 'id' | 'sha256'>;
  facts: AcctDocFacts;
  decimals: number;
  /** تجاوز DOC_POSSIBLE_DUPLICATE: confirmedNotDuplicate و«ليست مكررة» في النص */
  overridden: boolean;
  now: Date;
}

const dupRefusal = (reason: 'INVOICE_NO' | 'SOFT', moveNumber: string | null): AiRefusal => refuse('DOC_POSSIBLE_DUPLICATE',
  `${reason === 'INVOICE_NO' ? 'فاتورة بالرقم نفسه من المورد نفسه' : 'مستندٌ بالمورد والتاريخ والإجمالي نفسها (أو قيدٌ بالمبلغ والتاريخ والحساب نفسها)'} مرحّلة من قبل${moveNumber ? ` بالقيد ${moveNumber}` : ''}، فلم يُرحَّل شيء. `
  + 'إن لم تكن مكررة فاضغط «ليست مكررة — سجّلها» في البطاقة.',
  { reason, ...(moveNumber ? { move_number: moveNumber } : {}) });

/**
 * طبقات التكرار الثلاث تحت قفل الترحيل (بعد إعادة الإرسال): الملف ⇒ رقم الفاتورة ⇒ المفتاح الرخو. null ⇒ لا تكرار.
 * المستند نفسه بقيده المعكوس لا يُعدّ (يُعاد ترحيله)، ومستنداتٌ أخرى تُطابَق بقيودها الحيّة وحدها.
 */
export async function docDuplicateRefusal(tx: GlDb, plan: AiPostPlan, d: DupInput): Promise<AiRefusal | null> {
  const { tenantId } = d;
  // (1) الملف نفسه مرحّلٌ في قيد حيّ — لأي رافعٍ في الشركة (ومنه المستند نفسه قبل عكس قيده)
  const sameFile = await tx.aiAccountantDocument.findMany({
    where: { tenantId, sha256: d.doc.sha256, moveId: { not: null } }, select: { id: true, moveId: true }, take: 50,
  });
  const fileLive = await liveNumbers(tx, tenantId, sameFile.map((x) => x.moveId));
  const hitFile = sameFile.find((x) => x.moveId && fileLive.has(x.moveId));
  if (hitFile) {
    const number = fileLive.get(hitFile.moveId!) ?? null;
    return refuse('DOC_ALREADY_POSTED',
      `هذا المستند مرحّل من قبل${number ? ` بالقيد ${number}` : ''} ولم يُعكس، فلم يُرحَّل ثانيةً. لإعادة ترحيله اعكس قيده من الدفاتر أولاً.`,
      number ? { move_number: number } : undefined);
  }
  // (1ب) أقساط إطفاءٍ حيّة من ترحيلٍ سابق مدفوعٍ مقدماً (المستند نفسه أو ملفه) عُكس أبوه — لا تجاوز
  const amortLive = await liveAmortizationOf(tx, tenantId, [d.doc.id, ...sameFile.map((x) => x.id)]);
  if (amortLive.length) {
    const list = amortLive.slice(0, 6).join('، ');
    return refuse('PREPAID_AMORT_LIVE',
      `قيود إطفاء من ترحيلٍ سابق لهذا المستند ما زالت قائمة (${list}${amortLive.length > 6 ? '…' : ''})، فلم يُرحَّل ثانيةً حتى لا يُحمَّل المصروف مرتين. `
      + `اعكس قيود الإطفاء المرحّلة (${amortLive.length}) أولاً ثم أعد الترحيل.`,
      { move_numbers: amortLive, count: amortLive.length });
  }
  if (d.overridden) return null;

  const f = d.facts;
  const vendor = vendorKeyOf(f);
  // (2) رقم الفاتورة نفسه من المورد نفسه
  if (f.invoiceNo && vendor) {
    const sameNo = await tx.aiAccountantDocument.findMany({
      where: { tenantId, moveId: { not: null }, id: { not: d.doc.id }, facts: { path: ['invoiceNo'], equals: f.invoiceNo } },
      select: { id: true, moveId: true, facts: true }, take: 50,
    });
    const hits = sameNo.filter((x) => {
      const of = parseFacts(x.facts);
      return !!of && normKey(of.invoiceNo) === normKey(f.invoiceNo) && vendorKeyOf(of) === vendor;
    });
    const live = await liveNumbers(tx, tenantId, hits.map((x) => x.moveId));
    const hit = hits.find((x) => x.moveId && live.has(x.moveId));
    if (hit) return dupRefusal('INVOICE_NO', live.get(hit.moveId!) ?? null);
  }
  // (3أ) المفتاح الرخو بين المستندات: المورد + تاريخ الفاتورة + الإجمالي
  const total = factAmount(f.total, d.decimals);
  if (vendor && f.issueDate && total !== null) {
    const sameDay = await tx.aiAccountantDocument.findMany({
      where: { tenantId, moveId: { not: null }, id: { not: d.doc.id }, facts: { path: ['issueDate'], equals: f.issueDate } },
      select: { id: true, moveId: true, facts: true }, take: 100,
    });
    const hits = sameDay.filter((x) => {
      const of = parseFacts(x.facts);
      return !!of && vendorKeyOf(of) === vendor && factAmount(of.total, d.decimals) === total;
    });
    const live = await liveNumbers(tx, tenantId, hits.map((x) => x.moveId));
    const hit = hits.find((x) => x.moveId && live.has(x.moveId));
    if (hit) return dupRefusal('SOFT', live.get(hit.moveId!) ?? null);
  }
  // (3ب) قيدٌ حيّ للمحاسب الذكي خلال ٣٠ يوماً بالمبلغ والتاريخ وحساب المدين نفسها (مصروفٌ كُتب بيدٍ بـpost_expense)
  const debitAccountId = plan.lines.find((l) => l.debitMilli > 0n)?.accountId ?? null;
  if (debitAccountId) {
    const recent = await tx.aiAccountantPost.findMany({
      where: {
        tenantId, amountMilli: plan.totalMilli, dateLocal: plan.draft.date, createdAt: { gte: new Date(d.now.getTime() - SOFT_DUP_WINDOW_MS) },
        kind: { not: 'PREPAID_AMORT' },
      },
      select: { moveId: true, moveNumber: true, docId: true }, orderBy: { createdAt: 'desc' }, take: 50,
    });
    const others = recent.filter((r) => r.docId !== d.doc.id);
    if (others.length) {
      const ids = others.map((r) => r.moveId);
      const moves = await tx.glMove.findMany({
        where: { tenantId, id: { in: ids }, state: 'POSTED' },
        select: { id: true, lines: { select: { accountId: true, debitMilli: true } } },
      });
      const live = await liveNumbers(tx, tenantId, ids);
      const hit = moves.find((m) => live.has(m.id) && m.lines.some((l) => l.accountId === debitAccountId && BigInt(l.debitMilli) > 0n));
      if (hit) return dupRefusal('SOFT', others.find((r) => r.moveId === hit.id)?.moveNumber ?? live.get(hit.id) ?? null);
    }
  }
  return null;
}

// ═══ التنفيذ ═══

export interface DocPostDeps {
  env: NodeJS.ProcessEnv;
  gateDb: WriteGateDb;
  /** قراءة المستند وعروضه (PrismaClient أو المزيّف) */
  db: DocsDb;
  /** المعاملة: prisma.$transaction(fn, POST_TX_OPTIONS) */
  runTx<T>(fn: (tx: GlDb) => Promise<T>): Promise<T>;
  post: AiPostDeps;
  /** نقل المرفق وربط المستند داخل المعاملة (store.ts — الحزمة P1) */
  relink: typeof relinkDocAttachment;
  markPosted: typeof markDocPosted;
  /** عرض المستند بعد الترحيل أو الرفض (البطاقة) — الفشل لا يُسقط الرد */
  views(ctx: AcctCtx, docs: DocRow[]): Promise<AcctDocView[]>;
  now(): Date;
  log(line: string): void;
}

const defaultRunTx = <T>(fn: (tx: GlDb) => Promise<T>): Promise<T> =>
  prisma.$transaction((tx) => fn(tx as GlDb), POST_TX_OPTIONS);

/** عروض المستندات بدليل الشركة (loadDocEnv + docViewsFor) — المرجع D1… يعيّنه المستدعي */
export async function defaultDocViews(db: DocsDb, ctx: AcctCtx, docs: DocRow[], refs: ReadonlyMap<string, string> = new Map()): Promise<AcctDocView[]> {
  if (!docs.length) return [];
  const env = await loadDocEnv(db, { tenantId: ctx.tenantId, currency: ctx.currency, tz: ctx.tz, todayLocal: ctx.todayLocal, taxDisabled: ctx.taxDisabled });
  return docViewsFor(db, ctx.tenantId, docs, env, refs);
}

function depsOf(over: Partial<DocPostDeps>): DocPostDeps {
  const db = over.db ?? (prisma as unknown as DocsDb);
  return {
    env: over.env ?? process.env,
    gateDb: over.gateDb ?? (prisma as unknown as WriteGateDb),
    db,
    runTx: over.runTx ?? defaultRunTx,
    post: over.post ?? DEFAULT_AI_POST_DEPS,
    relink: over.relink ?? relinkDocAttachment,
    markPosted: over.markPosted ?? markDocPosted,
    views: over.views ?? ((ctx, docs) => defaultDocViews(db, ctx, docs)),
    now: over.now ?? (() => new Date()),
    log: over.log ?? ((line: string) => console.warn(line)),
  };
}

export interface DocPostInput {
  confirm: AcctDocConfirm;
  /** نصّ آخر رسالة للمستخدم (المؤلَّف من البطاقة، ظاهرٌ وقابل للتعديل قبل الإرسال) */
  lastText: string;
  /** مستندات آخر رسالة — docConfirm.docId يجب أن يكون منها */
  lastDocIds: readonly string[];
}

export type DocPostOutcome =
  | { ok: true; move: PostedMove; replayed: boolean; warnings: string[]; view: AcctDocView | null }
  | { ok: false; refusal: AiRefusal; view: AcctDocView | null };

/**
 * الحرّاس 1–3 (قبل المعاملة): حالة المستند وفحوصه المخزّنة وعملته. فحوص التاريخ النسبية لليوم (DATE_FUTURE/DATE_TOO_OLD)
 * تُهمل هنا: المخزّن منها حُسب بيوم الرفع فيشيخ، وتاريخ القيد يحكمه postingDateProblem في الخطة بيوم الشركة تحت القفل.
 */
export function docStateRefusal(doc: DocRow, facts: AcctDocFacts | null, checks: readonly AcctDocCheck[], ctx: Pick<AcctCtx, 'currency'>): AiRefusal | null {
  if (doc.status === 'FAILED' || checks.some((x) => x.code === 'FILE_GONE')) {
    return refuse('DOC_FILE_GONE', 'ملف المستند لم يعد موجوداً؛ ارفعه من جديد.', { docId: doc.id });
  }
  if (!facts) return refuse('DOC_NOT_READY', 'بيانات المستند لم تُدخل بعد: أكمل الإجمالي والتاريخ في البطاقة ثم اضغط «سجّل القيد».');
  const blocks = checks.filter((x) => x.severity === 'block' && !isDateRelativeCheck(x));
  if (blocks.some((x) => x.code === 'NOT_A_PAYMENT')) {
    return refuse('NOT_A_PAYMENT', 'عقد الإيجار وحده ليس دفعاً: اذكر في البطاقة كم دُفع ومن أي حساب، ثم اضغط «سجّل القيد». لم يُرحَّل شيء.');
  }
  // دفعٌ مقدّم لأكثر من 24 شهراً (D2): للمحاسب البشري — لا «صحّح» (MONTHS_INVALID بسبب REFERRED من checks.ts)
  const referred = blocks.find((x) => x.code === 'MONTHS_INVALID' && x.details?.reason === 'REFERRED');
  if (referred) {
    const m = Number(referred.details?.months);
    return refuse('DOC_TREATMENT_REFERRED',
      `دفعٌ مقدّم لأكثر من ${ACCT_PREPAID_MAX_MONTHS} شهراً يقرّر قيده محاسبك البشري (عقد طويل الأجل)، فلم يُرحَّل شيء.`,
      { months: Number.isFinite(m) ? m : null });
  }
  if (blocks.length) {
    return refuse('DOC_NEEDS_REVIEW', 'في بيانات المستند ما يحتاج تصحيحاً قبل الترحيل (المُعلَّم بالأحمر في البطاقة). صحّحه ثم اضغط «سجّل القيد».',
      { checks: blocks.map((x) => x.code) });
  }
  if (!facts.total) return refuse('DOC_NOT_READY', 'إجمالي المستند غير مُدخل: أكمله في البطاقة ثم اضغط «سجّل القيد».');
  if (!facts.issueDate) return refuse('DOC_NOT_READY', 'تاريخ المستند غير مُدخل: أكمله في البطاقة ثم اضغط «سجّل القيد».');
  if (facts.currency && ctx.currency && facts.currency.toUpperCase() !== ctx.currency.toUpperCase()) {
    return refuse('DOC_CURRENCY_MISMATCH', `عملة المستند (${facts.currency}) غير عملة الدفاتر (${ctx.currency})، فلا يُرحَّل من المحادثة. سجّله يدوياً من الدفاتر.`,
      { currency: facts.currency, companyCurrency: ctx.currency });
  }
  return null;
}

/**
 * ترحيل المستند من بطاقته — بلا نموذج. tenantId والرافع من السياق (الجلسة) وحده؛ المبالغ من صفّ المستند. الرفض نتيجةٌ
 * مشروحة (لا رمي) بعرض المستند المحدَّث للبطاقة.
 */
export async function executeDocumentPost(ctx: AcctCtx, input: DocPostInput, over: Partial<DocPostDeps> = {}): Promise<DocPostOutcome> {
  const d = depsOf(over);
  const confirm = input.confirm;
  const viewOf = async (doc: DocRow | null): Promise<AcctDocView | null> => {
    if (!doc) return null;
    try {
      const fresh = (await findOwnDoc(d.db, { tenantId: ctx.tenantId, actorRef: actorRefOf(ctx.adminId, ctx.impersonated), id: doc.id })) ?? doc;
      return (await d.views(ctx, [fresh]))[0] ?? null;
    } catch {
      return null;
    }
  };
  const refused = async (refusal: AiRefusal, doc: DocRow | null): Promise<DocPostOutcome> => ({ ok: false, refusal, view: await viewOf(doc) });

  // 1) المستندات والترحيل مفعّلان (البيئة والسياق ثم القاعدة)
  const gate = docGateRefusal(ctx, d.env);
  if (gate) return refused(gate, null);
  const dbGate = await writeGateRefusal(d.gateDb, ctx);
  if (dbGate) return refused(dbGate, null);

  // 2) المستند من مستندات آخر رسالة، للشركة والرافع نفسه
  if (!input.lastDocIds.includes(confirm.docId)) {
    return refused(refuse('DOC_NOT_ATTACHED', 'المستند غير مرفق برسالة التأكيد؛ اضغط «سجّل القيد» من بطاقته.'), null);
  }
  const actorRef = actorRefOf(ctx.adminId, ctx.impersonated);
  const doc = await findOwnDoc(d.db, { tenantId: ctx.tenantId, actorRef, id: confirm.docId });
  if (!doc) return refused(refuse('DOC_NOT_FOUND', 'المستند غير موجود أو ليس من رفعك.'), null);
  // نصّ التأكيد طلبُ ترحيلٍ صريح («سجّل المستند…» كما تؤلّفه البطاقة دائماً: نيّة التسجيل وكلمة «سجّل» معاً، التصميم §5.1) —
  // نصٌّ يعيد المبالغ والرموز بلا طلب لا يرحّل شيئاً
  const confirmText = normalizeAmountText(input.lastText ?? '');
  if (!writeIntentIn(confirmText) || !CONFIRM_VERB_RE.test(confirmText)) {
    return refused(refuse('DOC_TOTAL_NOT_CONFIRMED', 'رسالة التأكيد لا تطلب الترحيل؛ اضغط «سجّل القيد» من البطاقة لترحيل المستند.', { field: 'intent' }), doc);
  }

  // 3) الحالة والفحوص المخزّنة والعملة
  const facts = parseFacts(doc.facts);
  const state = docStateRefusal(doc, facts, parseChecks(doc.checks), ctx);
  if (state || !facts) return refused(state ?? refuse('DOC_NOT_READY', 'بيانات المستند لم تُدخل بعد.'), doc);

  // 4–8) الحرّاس الصرفة والترحيل في معاملة واحدة تحت قفل الترحيل
  const lastText = input.lastText ?? '';
  const overridden = confirm.confirmedNotDuplicate === true && NOT_DUPLICATE_RE.test(normalizeAmountText(lastText));
  const actor = ledgerActor(
    { actorId: ctx.adminId, impersonated: ctx.impersonated },
    { actorName: `المحاسب الذكي بطلب ${ctx.adminName || ''}`.trim(), requestIp: ctx.requestIp ?? null },
  );
  const now = d.now();
  const hooks: AiDocHooks = {
    refusal: (tx, plan, lc) => docDuplicateRefusal(tx, plan, {
      tenantId: ctx.tenantId, doc, facts, decimals: lc.ctx.settings.currencyDecimals, overridden, now,
    }),
    relink: async (tx, posted) => {
      await d.relink(tx, { tenantId: ctx.tenantId, doc, moveId: posted.moveId, moveNumber: posted.moveNumber, actor });
    },
    linkDoc: (tx, link) => d.markPosted(tx, { tenantId: ctx.tenantId, doc, moveId: link.moveId, postId: link.postId }),
  };
  try {
    const res = await d.runTx((tx) => executeAiPost(tx, {
      tenantId: ctx.tenantId,
      actor,
      adminId: actorRef,
      adminName: ctx.adminName,
      clientRef: ctx.clientRef,
      usedRefs: ctx.posted.map((p) => p.ref),
      build: (lc: LedgerContext) => planDocumentPost(
        { lc, booksMode: ctx.booksMode, currency: ctx.currency, taxDisabled: ctx.taxDisabled },
        { doc: { docId: doc.id, facts, factsSource: doc.factsSource }, confirm, lastText, todayLocal: ctx.todayLocal, assetThresholdMilli: assetThresholdMilli(d.env) },
      ),
      now,
      doc: hooks,
    }, d.post));
    if (!ctx.posted.some((p) => p.id === res.move.id)) ctx.posted.push(res.move);
    for (const w of res.warnings) if (!ctx.warnings.includes(w)) ctx.warnings.push(w);
    return { ok: true, move: res.move, replayed: res.replayed, warnings: res.warnings, view: await viewOf(doc) };
  } catch (e) {
    const r = refusalFromError(e);
    if (r.code === 'POST_FAILED' || r.code === 'LEDGER_ERROR') {
      const code = (e as { code?: unknown })?.code;
      d.log(`[ai-accountant] تعذّر ترحيل مستند ${JSON.stringify({ tenant: ctx.tenantId, code: typeof code === 'string' ? code : (e as Error)?.name ?? 'ERROR' })}`);
    }
    return refused(r, doc);
  }
}

/** نصّ الرد الحتمي (بلا نموذج): ملخّص القيد ومرفقه، أو سبب الرفض — التنبيهات في warnings الرد لا تُكرَّر هنا */
export function docPostText(out: DocPostOutcome): string {
  if (!out.ok) return `لم يُرحَّل شيء: ${out.refusal.message}`;
  const m = out.move;
  const head = out.replayed ? `سبق ترحيل هذا المستند بالقيد ${m.moveNumber ?? ''}` : `رُحّل القيد ${m.moveNumber ?? ''}`;
  const lines = [
    `${head.replace(/\s+/g, ' ').trim()}: ${m.summaryAr}`,
    m.hasAttachment ? 'أُرفق المستند بالقيد في الدفاتر، ويُعكس القيد من بطاقته عند الحاجة.' : '',
  ];
  return lines.filter(Boolean).join('\n');
}
