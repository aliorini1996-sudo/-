/**
 * «المحاسب الذكي AI» — رفع المستندات في المحادثة: منطق بطاقة المستند (DocCard) وشرائح المرفقات (DocChips) الصرف.
 * (الاسم docCardLogic لا docCard: ويندوز لا يفرّق حالة الحرف، و‎./DocCard‎ بلا امتداد كان يُحلّ إلى هذا الملف قبل DocCard.tsx.)
 *
 * لا React هنا ولا شبكة. عقد الخادم والمال ونصّ التأكيد وdocConfirm وجسم PATCH وتجهيز الملف في lib/aiAccountantDocs.ts
 * (مصدرٌ واحد يُستورد ولا يُنسخ)؛ وهنا ما يخصّ البطاقة نفسها: الشرائح في الشركة «بلا ضريبة»، إتاحة المعالجات (خيارات الحساب
 * وحدّ الرسملة)، الاختيار الافتراضي ومواءمته، ما يمنع «سجّل القيد» وسببه، الحالة والفحوص الظاهرة، والفرق بين خانات الإدخال
 * والحقائق — كلّها تُختبر بلا متصفّح (docCard.test.ts). كل عبارةٍ عربية حرفيةٌ داخل استدعاء tr فيراها فاحص الترجمات.
 *
 * قرارات المالك (١٨ نوفمبر ٢٠٢٦) الملزمة هنا:
 *  - D1 البطاقة إلزامية: لا يُرحَّل مستند إلا بضغطة «سجّل القيد»، والترحيل آليٌّ بالخادم من الحقائق المخزّنة — البطاقة
 *    لا تحسب مبلغاً؛ تختار المعالجة والحساب و«مدفوع من» (إلزامي) فقط.
 *  - D2 المقدّم: أشهر الإطفاء 1..24، والأطول يُحال للمحاسب البشري. D3 الأصل: ما بلغ حدّ الرسملة (قبل الضريبة) وحده،
 *    ودونه مصروف، ولا إهلاك («يحتاج إهلاكاً يسجّله المحاسب»).
 *  - D4 لا قارئ ذكاء اصطناعي: الحقائق من رمز QR أو من المستخدم — فبلا QR تفتح البطاقة في وضع الإدخال.
 *  - D7 الشركة «بلا ضريبة» (isTaxOff): لا ذكر للضريبة ولا الرقم الضريبي ولا رمز QR في البطاقة.
 * الخادم هو الحَكَم في كل ذلك (يعيد الفحص ويرفض)؛ الواجهة تشرح وتمنع الضغطة التي سيرفضها.
 */
import {
  ACCT_ASSET_CLASSES, DEFAULT_ASSET_THRESHOLD, DOC_CATEGORY_FIXED_ASSET, DOC_CATEGORY_INVENTORY, MAX_DOCS_PER_MESSAGE,
  PREPAID_MAX_MONTHS, VENDOR_VAT_RE, assetBelowThreshold, buildDocPatch, decToMilli, docCheckText, docConfirmProblem,
  docRefusalText, docTypeLabel, latinDigits, parseAmountInput, refusalMoveNumber,
  type AcctAccountOption, type AcctAssetClass, type AcctDocCheck, type AcctDocFacts, type AcctDocPatch, type AcctDocTreatment,
  type AcctDocType, type AcctDocView, type AcctPayOption, type AcctVatMode, type DocConfirmChoice, type DocFactsForm,
  type DocFormField, type DocFormProblem, type DocRefusal,
} from '../../../lib/aiAccountantDocs';

type Tr = (ar: string) => string;
const id: Tr = (s) => s;

export const TREATMENT_ORDER: readonly AcctDocTreatment[] = ['EXPENSE', 'PREPAID', 'ASSET'];

/** أنواع المستند بترتيب شرائح البطاقة (ACCT_DOC_TYPES) */
const DOC_TYPE_ORDER: readonly AcctDocType[] = [
  'TAX_INVOICE', 'SIMPLIFIED_INVOICE', 'MAINTENANCE_INVOICE', 'UTILITY_BILL', 'LEASE_CONTRACT', 'RECEIPT', 'OTHER',
];

// ─── النوع والمعالجة: التسميات ───

/**
 * اسم النوع في البطاقة: كـdocTypeLabel، وفي الشركة «بلا ضريبة» «فاتورة ضريبية» و«المبسطة» كلتاهما «فاتورة» (لا ذكر
 * للضريبة — taxMode.ts) والشريحتان شريحةٌ واحدة (docTypeChips).
 */
export function docTypeLabelFor(t: unknown, taxOff: boolean, tr: Tr = id): string {
  if (taxOff && (t === 'TAX_INVOICE' || t === 'SIMPLIFIED_INVOICE')) return tr('فاتورة');
  return docTypeLabel(t, tr);
}

/** شرائح النوع: كلّها، وفي الشركة «بلا ضريبة» تُدمج الفاتورتان في «فاتورة» (قيمتها المبسطة — لا رقم ضريبي فيها) */
export function docTypeChips(taxOff: boolean): AcctDocType[] {
  return taxOff ? DOC_TYPE_ORDER.filter(t => t !== 'TAX_INVOICE') : [...DOC_TYPE_ORDER];
}

/** الشريحة المضيئة لنوعٍ محفوظ (في الشركة «بلا ضريبة» تضيء «فاتورة» للضريبية والمبسطة معاً) */
export function chipSelected(chip: AcctDocType, current: AcctDocType | null | undefined, taxOff: boolean): boolean {
  if (!current) return false;
  if (taxOff && chip === 'SIMPLIFIED_INVOICE') return current === 'SIMPLIFIED_INVOICE' || current === 'TAX_INVOICE';
  return chip === current;
}

/** اسم المعالجة على أزرار البطاقة (المقدّم «يُوزَّع» — الإطفاء الشهري يتبعه) */
export function treatmentLabel(t: unknown, tr: Tr = id): string {
  switch (t) {
    case 'PREPAID': return tr('مقدّم يُوزَّع على أشهر');
    case 'ASSET': return tr('أصل');
    default: return tr('مصروف');
  }
}

// ─── الفحوص (نصوصها docCheckText في lib/aiAccountantDocs) ───

/** فحوص الضريبة ورمز QR والرقم الضريبي — لا تُعرض منبّهاتها في الشركة «بلا ضريبة» (taxMode: لا ذكر للضريبة) */
const TAX_CHECKS: ReadonlySet<string> = new Set([
  'SUM_MISMATCH', 'VAT_RATE_ODD', 'VAT_NO_TAX_NUMBER', 'VAT_BLOCKED_CATEGORY', 'VAT_NO_BOX', 'BUYER_OTHER', 'QR_MISMATCH', 'QR_INVALID',
]);

/**
 * منبّهاتٌ يحسبها الخادم على **اقتراحه** لا على اختيار المستخدم، فتُعرض ما دام الاختيار هو الاقتراح وحده: «ضريبة الضيافة لا
 * تُخصم» (VAT_BLOCKED_CATEGORY — ترحيل الخادم يحكم بالحساب المختار نفسه). و«يحتاج إهلاكاً» (NEEDS_DEPRECIATION) لا تُعرض فحصاً
 * أبداً: البطاقة تقولها تحت المعالجة حين يختار المستخدم «أصل» — ومع «مصروف» لا إهلاك.
 */
const SUGGESTION_CHECKS: ReadonlySet<string> = new Set(['VAT_BLOCKED_CATEGORY']);

/**
 * الفحوص الظاهرة: المانعة أولاً ثم المنبّهة، بلا تكرار الرمز. في الشركة «بلا ضريبة» تُخفى منبّهات الضريبة وحدها — المانع
 * يبقى ظاهراً دائماً (زرٌّ معطّل بلا سببٍ ظاهر أسوأ). `suggestionChosen: false` (اختار المستخدم معالجةً أو حساباً غير المقترح)
 * يُخفي منبّهات الاقتراح (SUGGESTION_CHECKS).
 */
export function visibleChecks(
  checks: readonly AcctDocCheck[] | null | undefined, taxOff: boolean, o: { suggestionChosen?: boolean } = {},
): AcctDocCheck[] {
  const seen = new Set<string>();
  const out: AcctDocCheck[] = [];
  for (const c of checks ?? []) {
    if (!c || typeof c.code !== 'string' || seen.has(c.code)) continue;
    if (c.code === 'NEEDS_DEPRECIATION') continue;
    if (taxOff && c.severity !== 'block' && TAX_CHECKS.has(c.code)) continue;
    if (o.suggestionChosen === false && c.severity !== 'block' && SUGGESTION_CHECKS.has(c.code)) continue;
    seen.add(c.code);
    out.push(c);
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'block' ? -1 : 1));
}

/** مصدر الحقائق — «من رمز QR» يُخفى في الشركة «بلا ضريبة» (رمز الهيئة لا يُذكر)، فيُعاد null */
export function factsSourceLabel(src: unknown, taxOff: boolean, tr: Tr = id): string | null {
  if (src === 'USER') return tr('إدخال يدوي');
  if (taxOff) return null;
  if (src === 'QR') return tr('من رمز QR');
  if (src === 'QR+USER') return tr('من رمز QR مع تعديلك');
  return null;
}

// ─── حالة المستند ───

export type DocState = 'posted' | 'reversed' | 'gone' | 'waiting' | 'review' | 'ready';

/**
 * الحالة للعرض: المرحَّل مشتقّ (قيده حيّ) لا مخزّن، والمعكوس يُسجَّل من جديد. «الملف مفقود» (تصفير الدفاتر) قبل الباقي،
 * ثم «بانتظار البيانات» (بلا إجمالي)، ثم «يحتاج مراجعة» (فحصٌ مانع أو حالة NEEDS_REVIEW)، وإلا «جاهز للتسجيل».
 */
export function docState(v: Pick<AcctDocView, 'posted' | 'status' | 'checks' | 'facts'>): DocState {
  if (v.posted?.live === true) return 'posted';
  if (v.status === 'FAILED' || (v.checks ?? []).some(c => c?.code === 'FILE_GONE')) return 'gone';
  if (v.posted && v.posted.live === false) return 'reversed';
  const total = decToMilli(v.facts?.total);
  if (v.status === 'UPLOADED' || total === null || total <= 0n) return 'waiting';
  if ((v.checks ?? []).some(c => c?.severity === 'block') || v.status === 'NEEDS_REVIEW') return 'review';
  return 'ready';
}

export function docStateLabel(s: DocState, tr: Tr = id): string {
  switch (s) {
    case 'posted': return tr('مُرحّل');
    case 'reversed': return tr('معكوس — يمكن تسجيله من جديد');
    case 'gone': return tr('الملف مفقود');
    case 'waiting': return tr('بانتظار البيانات');
    case 'review': return tr('يحتاج مراجعة');
    default: return tr('جاهز للتسجيل');
  }
}

export function docStateTone(s: DocState): string {
  switch (s) {
    case 'posted':
    case 'ready': return 'bg-[#E4F1EA] text-[#1E7A52] border-[#C6E3D2]';
    case 'review': return 'bg-[#FAEFD8] text-[#8A6A12] border-[#F0DDB0]';
    case 'gone': return 'bg-[#FDF1EE] text-[#8E2B1F] border-[#F3C9BF]';
    default: return 'bg-[#F1EBDF] text-[#6E6557] border-[#E0D7C6]';
  }
}

/** نصّ «يشبه قيداً مسجلاً» من duplicateOf */
export function duplicateText(d: AcctDocView['duplicateOf'] | null | undefined, tr: Tr = id): string | null {
  if (!d) return null;
  const n = d.moveNumber ?? '—';
  switch (d.reason) {
    case 'SHA': return tr('الملف نفسه مسجل في القيد {n}').replace('{n}', n);
    case 'INVOICE_NO': return tr('رقم الفاتورة نفسه مسجل في القيد {n}').replace('{n}', n);
    default: return tr('مورد وتاريخ ومبلغ مطابقة للقيد {n}').replace('{n}', n);
  }
}

/**
 * العرض كما تُحسب عليه البطاقة بعد رفض «يشبه مستنداً مسجلاً» (DOC_POSSIBLE_DUPLICATE): الخادم وجد التكرار تحت قفل الترحيل
 * وقد لا يحمله duplicateOf في العرض بعد — فيُوسَم به (رقم القيد من تفاصيل الرفض) ليُعرض «ليست مكررة — سجّلها» ويحمل النصّ
 * «ليست مكررة» وdocConfirm.confirmedNotDuplicate (docConfirmMessage يشترط duplicateOf). غير ذلك ⇒ العرض نفسه.
 */
export function withRefusalDuplicate(v: AcctDocView, r: DocRefusal | null | undefined): AcctDocView {
  if (r?.code !== 'DOC_POSSIBLE_DUPLICATE' || v.duplicateOf || v.posted?.live) return v;
  const d = r.details ?? {};
  const n = refusalMoveNumber(d) || null;
  const reason = d.reason === 'INVOICE_NO' ? 'INVOICE_NO' : 'SOFT';
  return { ...v, duplicateOf: { moveNumber: n, reason } };
}

// ─── المعالجة والحساب و«مدفوع من» ───

export interface DocCardOpts {
  /** حدّ الرسملة بوحدة العملة الكبرى (status.docs.assetThreshold) */
  assetThreshold: number;
  /** منازل عملة الشركة */
  decimals: number;
  /** الشركة «بلا ضريبة» (isTaxOff) */
  taxOff?: boolean;
}

export const accountsFor = (v: Pick<AcctDocView, 'accountOptions'>, t: AcctDocTreatment): AcctAccountOption[] =>
  (v.accountOptions ?? []).filter(o => o && o.treatment === t && typeof o.code === 'string' && !!o.code);

/** حدّ رسملةٍ صالح (الغائب أو الفاسد ⇒ ٢٠٠٠) */
export const thresholdOf = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : DEFAULT_ASSET_THRESHOLD);

export interface TreatmentState {
  treatment: AcctDocTreatment;
  allowed: boolean;
  /** سبب التعطيل (نصّه treatmentReasonText) */
  reason: 'NO_ACCOUNT' | 'BELOW_THRESHOLD' | null;
}

/**
 * المعالجات الثلاث وإتاحتها: كلٌّ بحساباتٍ أرسلها الخادم من دليل الشركة (بلا حساب ⇒ معطّلة)، والأصل بحدّ الرسملة فوق ذلك
 * (D3 — صافي ما قبل الضريبة دونه ⇒ مصروف). الشركة «بلا ضريبة» صافيها إجماليها. حدّ الرسملة يُفحص للأصل **قبل** الحسابات:
 * الخادم لا يرسل حسابات الأصول أصلاً لما دون الحدّ (accountOptionsFor)، فالسبب الصحيح «دون الحدّ» لا «لا حساب في دليلك».
 */
export function treatmentStates(v: Pick<AcctDocView, 'accountOptions' | 'facts'>, o: Pick<DocCardOpts, 'assetThreshold' | 'taxOff'>): TreatmentState[] {
  const facts = o.taxOff && v.facts ? { subtotal: null, vatAmount: null, total: v.facts.total } : v.facts;
  return TREATMENT_ORDER.map((t) => {
    if (t === 'ASSET' && assetBelowThreshold(facts, thresholdOf(o.assetThreshold))) return { treatment: t, allowed: false, reason: 'BELOW_THRESHOLD' };
    if (!accountsFor(v, t).length) return { treatment: t, allowed: false, reason: 'NO_ACCOUNT' };
    return { treatment: t, allowed: true, reason: null };
  });
}

/** سبب تعطيل المعالجة مترجماً — `threshold` حدّ الرسملة منسّقاً بعملة الشركة */
export function treatmentReasonText(reason: TreatmentState['reason'], threshold: string, tr: Tr = id): string | null {
  if (reason === 'NO_ACCOUNT') return tr('لا حساب متاح لهذه المعالجة في دليل حساباتك');
  if (reason === 'BELOW_THRESHOLD') return tr('يسجل أصلاً ما بلغ {n} فأكثر — وما دونه مصروف').replace('{n}', threshold);
  return null;
}

/** الاختيار هو اقتراح الخادم نفسه (المعالجة والحساب) — فما حسبه الخادم على اقتراحه يصدق عليه */
export const choiceIsSuggestion = (v: Pick<AcctDocView, 'suggestion'>, c: Pick<DocChoice, 'treatment' | 'accountCode'>): boolean =>
  !!v.suggestion && v.suggestion.treatment === c.treatment && v.suggestion.accountCode === c.accountCode;

/**
 * حكم الضريبة للحساب **المختار** (D7): ما يرسله الخادم مع خيار الحساب نفسه (vatMode)، وإلا حكم الاقتراح ما دام الاختيار هو
 * الاقتراح — والخادم يرحّل بحكم الحساب المختار (الضيافة وسكن الموظفين لا تُخصم)، فحساب آخر بلا حكمٍ معروف ⇒ null (لا ملاحظة
 * تقول «تخصم» لما لن يُخصم).
 */
export function chosenVatMode(v: Pick<AcctDocView, 'suggestion' | 'accountOptions'>, c: Pick<DocChoice, 'treatment' | 'accountCode'>): AcctVatMode | null {
  const opt = (v.accountOptions ?? []).find(o => o && o.treatment === c.treatment && o.code === c.accountCode);
  if (opt?.vatMode) return opt.vatMode;
  return choiceIsSuggestion(v, c) ? v.suggestion!.vatMode : null;
}

/** ملاحظة الضريبة (D7) — null في الشركة «بلا ضريبة» أو بلا حكمٍ معروف */
export function vatModeText(mode: unknown, taxOff: boolean, tr: Tr = id): string | null {
  if (taxOff) return null;
  switch (mode) {
    case 'DEDUCTIBLE': return tr('تخصم الضريبة في حساب ضريبة المدخلات 116001');
    case 'NON_DEDUCTIBLE': return tr('الضريبة لا تخصم — تضاف إلى التكلفة');
    case 'NONE': return tr('بلا سطر ضريبة');
    default: return null;
  }
}

/** قيمة خيار «مدفوع من» في القائمة: «paidFrom:code» — أكثر من حساب بنكٍ يُفرَّق برمزه */
export const payValue = (o: Pick<AcctPayOption, 'paidFrom' | 'code'>): string => `${o.paidFrom}:${o.code}`;

/** ما يحتاجه حلّ «مدفوع من»: الخيارات ونوع المستند (لعقد الإيجار) */
type PayView = Pick<AcctDocView, 'payOptions'> & { facts?: Pick<AcctDocFacts, 'docType'> | null };

/**
 * خيارات «مدفوع من» الظاهرة: خيارات الخادم، ولعقد الإيجار بلا «آجل — على الحساب» — العقد وحده ليس فاتورةً مستحقة (D2:
 * NOT_A_PAYMENT)، فلا يُعرض خيارٌ يرفضه الخادم ثم يُقال للمستخدم «اختر مدفوع من» وقد اختار.
 */
export function visiblePayOptions(v: PayView): AcctPayOption[] {
  const lease = v.facts?.docType === 'LEASE_CONTRACT';
  return (v.payOptions ?? []).filter(o => !!o && !(lease && o.paidFrom === 'payable'));
}

export function payOptionOf(v: PayView, value: string): AcctPayOption | null {
  if (!value) return null;
  return visiblePayOptions(v).find(o => payValue(o) === value) ?? null;
}

/** اسم خيار «مدفوع من»: الآجل «آجل — على الحساب» (مصروفات مستحقة D6)، والباقي برمزه واسمه في دليل الشركة */
export function payOptionLabel(o: Pick<AcctPayOption, 'paidFrom' | 'code' | 'name'>, tr: Tr = id): string {
  if (o.paidFrom === 'payable') return `${tr('آجل — على الحساب')} (${o.code})`;
  return `${o.code} ${o.name || ''}`.trim();
}

/** عدد الأشهر من فترة الخدمة (من/إلى ميلاديتين، شاملةً) — أو null */
export function periodMonths(from: string | null | undefined, to: string | null | undefined): number | null {
  const re = /^(\d{4})-(\d{2})-(\d{2})$/;
  const a = re.exec(from ?? '');
  const b = re.exec(to ?? '');
  if (!a || !b) return null;
  // ١ يناير–٣١ ديسمبر = ١٢، و١٥ يناير–١٤ فبراير = ١، و١٥ يناير–١٥ فبراير = ٢ (جزء شهرٍ ثانٍ يُعدّ شهراً)
  const n = (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2])) + (Number(b[3]) >= Number(a[3]) ? 1 : 0);
  return n >= 1 ? n : null;
}

/** اختيار المستخدم في البطاقة (ما سوى الحقائق) */
export interface DocChoice {
  treatment: AcctDocTreatment;
  accountCode: string;
  /** payValue للخيار — '' = لم يُختر بعد («مدفوع من» إلزامي) */
  pay: string;
  months: number | null;
  /** تاريخ القيد بدل تاريخ المستند (بعد رفض الفترة المقفلة: «سجّل بتاريخ اليوم») */
  date: string | null;
}

function pickAccount(v: Pick<AcctDocView, 'accountOptions'>, t: AcctDocTreatment, preferred?: string | null): string {
  const list = accountsFor(v, t);
  if (preferred && list.some(a => a.code === preferred)) return preferred;
  return list[0]?.code ?? '';
}

const suggestedFor = (v: Pick<AcctDocView, 'suggestion'>, t: AcctDocTreatment): string | null =>
  (v.suggestion?.treatment === t ? v.suggestion.accountCode : null);

/**
 * الاختيار الافتراضي من اقتراح الخادم (suggest.ts — من نوع المستند وتصنيفه): المعالجة المقترحة إن أُتيحت وإلا المصروف،
 * والحساب المقترح إن كان ضمن خيارات المعالجة وإلا أوّلها، والأشهر من الحقائق ثم الاقتراح ثم الفترة. «مدفوع من» فارغ
 * دائماً — يختاره المستخدم بنفسه (D1).
 */
export function defaultChoice(v: AcctDocView, o: Pick<DocCardOpts, 'assetThreshold' | 'taxOff'>): DocChoice {
  const states = treatmentStates(v, o);
  const ok = (t: AcctDocTreatment) => states.some(s => s.treatment === t && s.allowed);
  const sug = v.suggestion;
  const treatment: AcctDocTreatment = sug && ok(sug.treatment) ? sug.treatment
    : ok('EXPENSE') ? 'EXPENSE' : (states.find(s => s.allowed)?.treatment ?? 'EXPENSE');
  const months = v.facts?.months ?? sug?.months ?? periodMonths(v.facts?.periodFrom, v.facts?.periodTo);
  return {
    treatment,
    accountCode: pickAccount(v, treatment, suggestedFor(v, treatment)),
    pay: '',
    months: typeof months === 'number' && Number.isFinite(months) ? months : null,
    date: null,
  };
}

/** تبديل المعالجة: الحساب يتبعها (المقترح إن كان من خياراتها وإلا أوّلها)، والأشهر و«مدفوع من» تبقى */
export function withTreatment(v: AcctDocView, c: DocChoice, t: AcctDocTreatment): DocChoice {
  return { ...c, treatment: t, accountCode: pickAccount(v, t, suggestedFor(v, t)) };
}

/**
 * مواءمة اختيارٍ قائم مع عرضٍ جديد (بعد PATCH أو ردّ المحادثة): معالجةٌ لم تعد متاحة ⇒ الافتراض، وحسابٌ خرج من خياراتها
 * ⇒ المقترح، و«مدفوع من» خرج من الخيارات ⇒ فارغ. ما بقي صالحاً يبقى كما اختاره المستخدم.
 */
export function reconcileChoice(v: AcctDocView, c: DocChoice, o: Pick<DocCardOpts, 'assetThreshold' | 'taxOff'>): DocChoice {
  const pay = payOptionOf(v, c.pay) ? c.pay : '';
  if (!treatmentStates(v, o).some(s => s.treatment === c.treatment && s.allowed)) {
    const d = defaultChoice(v, o);
    return { ...d, pay, months: c.months ?? d.months, date: c.date };
  }
  const accountCode = accountsFor(v, c.treatment).some(a => a.code === c.accountCode)
    ? c.accountCode : pickAccount(v, c.treatment, suggestedFor(v, c.treatment));
  return { ...c, accountCode, pay };
}

/**
 * الاختيار بلغة العقد (DocConfirmChoice في lib/aiAccountantDocs) — منه النصّ المرئي وdocConfirm (docConfirmMessage).
 * بلا «مدفوع من» ⇒ null. الأشهر للمقدّم وحده.
 */
export function confirmChoiceOf(v: PayView, c: DocChoice, confirmedNotDuplicate = false): DocConfirmChoice | null {
  const pay = payOptionOf(v, c.pay);
  if (!pay) return null;
  return {
    treatment: c.treatment,
    accountCode: c.accountCode,
    paidFrom: pay.paidFrom,
    paidFromAccountCode: pay.paidFrom === 'payable' ? null : pay.code,
    months: c.treatment === 'PREPAID' ? c.months : null,
    date: c.date,
    confirmedNotDuplicate,
  };
}

export type BlockerCode =
  | 'POSTED' | 'GONE' | 'EDITING' | 'INVENTORY' | 'CHECKS' | 'TOTAL' | 'DATE' | 'TREATMENT' | 'ACCOUNT' | 'PAID_FROM' | 'NOT_A_PAYMENT'
  | 'MONTHS' | 'REFERRED' | 'DUPLICATE' | 'ALREADY_POSTED';

/**
 * نصّ المانع (يُعرض تحت «سجّل القيد») — بعبارات مرآة العقد حيث تقول الشيء نفسه (فحوص الخادم ورفوضه)، فلا يُترجَم المعنى
 * الواحد مرّتين؛ وما يخصّ البطاقة وحدها هنا.
 */
export function blockerText(code: BlockerCode, tr: Tr = id): string {
  switch (code) {
    case 'POSTED':
    case 'ALREADY_POSTED': return docRefusalText({ code: 'DOC_ALREADY_POSTED', message: '' }, tr);
    case 'GONE': return docCheckText('FILE_GONE', tr);
    case 'CHECKS': return docRefusalText({ code: 'DOC_NEEDS_REVIEW', message: '' }, tr);
    case 'TOTAL': return docCheckText('TOTAL_MISSING', tr);
    case 'DATE': return docCheckText('DATE_MISSING', tr);
    case 'MONTHS': return docCheckText('MONTHS_INVALID', tr);
    case 'REFERRED': return docRefusalText({ code: 'DOC_TREATMENT_REFERRED', message: '' }, tr);
    case 'INVENTORY': return docRefusalText({ code: 'DOC_IS_INVENTORY', message: '' }, tr);
    case 'NOT_A_PAYMENT': return docRefusalText({ code: 'NOT_A_PAYMENT', message: '' }, tr);
    case 'DUPLICATE': return docRefusalText({ code: 'DOC_POSSIBLE_DUPLICATE', message: '' }, tr);
    case 'EDITING': return tr('احفظ التعديل أولاً');
    case 'TREATMENT': return tr('اختر معالجة متاحة');
    case 'ACCOUNT': return tr('اختر الحساب');
    default: return tr('اختر «مدفوع من»');
  }
}

/** الأشهر صالحة لمعالجة «مقدّم»: عددٌ صحيح 1..24 */
export const monthsValid = (m: number | null | undefined): m is number =>
  typeof m === 'number' && Number.isInteger(m) && m >= 1 && m <= PREPAID_MAX_MONTHS;

const PROBLEM_TO_BLOCKER: Record<NonNullable<ReturnType<typeof docConfirmProblem>>, BlockerCode> = {
  POSTED: 'POSTED', NO_FACTS: 'TOTAL', TOTAL_MISSING: 'TOTAL', BLOCKED: 'CHECKS', DATE_MISSING: 'DATE', TREATMENT: 'TREATMENT',
  ACCOUNT: 'ACCOUNT', PAY: 'PAID_FROM', NOT_A_PAYMENT: 'NOT_A_PAYMENT', MONTHS: 'MONTHS', DUPLICATE: 'DUPLICATE',
  ALREADY_POSTED: 'ALREADY_POSTED',
};

/**
 * ما يمنع «سجّل القيد» الآن — null ⇒ الزرّ متاح. فوق شروط العقد (docConfirmProblem: المرحَّل، الإجمالي، الفحص الأحمر،
 * التاريخ، الحساب، «مدفوع من»، الأشهر، التكرار) ما تعرفه البطاقة وحدها: الملف المفقود، تعديلٌ لم يُحفظ، تصنيفٌ لا يُرحَّل
 * من هنا (D3: بضاعة للبيع ⇒ مشتريات المستودع، وأرضٌ أو مبنى ⇒ المحاسب البشري)، معالجةٌ غير متاحة (بلا حساب أو أصلٌ دون حدّ
 * الرسملة)، حسابٌ ليس من خياراتها، وأكثر من ٢٤ شهراً يُحال للمحاسب البشري (D2).
 * فحصٌ منبّه (كهرماني) لا يمنع (D1: يُسمح بالترحيل معه).
 */
export function confirmBlocker(v: AcctDocView, c: DocChoice, o: DocCardOpts & { editing?: boolean; notDuplicate?: boolean }): BlockerCode | null {
  const state = docState(v);
  if (state === 'posted') return 'POSTED';
  if (state === 'gone') return 'GONE';
  if (o.editing) return 'EDITING';
  const ref = docReferral(v.facts);
  if (ref) return ref;
  if (!treatmentStates(v, o).some(s => s.treatment === c.treatment && s.allowed)) return 'TREATMENT';
  if (!c.accountCode || !accountsFor(v, c.treatment).some(a => a.code === c.accountCode)) return 'ACCOUNT';
  if (c.treatment === 'PREPAID') {
    if (typeof c.months === 'number' && Number.isInteger(c.months) && c.months > PREPAID_MAX_MONTHS) return 'REFERRED';
    if (!monthsValid(c.months)) return 'MONTHS';
  }
  const choice = confirmChoiceOf(v, c, o.notDuplicate === true);
  if (!choice) {
    // بلا «مدفوع من»: ما يسبقه في شروط العقد أولى بالذكر (الإجمالي، الفحص الأحمر، التاريخ…)، وإلا «اختر مدفوع من»
    const p = docConfirmProblem(v, {
      treatment: c.treatment, accountCode: c.accountCode, paidFrom: 'payable', paidFromAccountCode: null, months: c.months, date: c.date,
    });
    return p && BEFORE_PAY.has(p) ? PROBLEM_TO_BLOCKER[p] : 'PAID_FROM';
  }
  const p = docConfirmProblem(v, choice);
  return p ? PROBLEM_TO_BLOCKER[p] : null;
}

/** شروط العقد التي تسبق «مدفوع من» في docConfirmProblem */
const BEFORE_PAY: ReadonlySet<string> = new Set(['POSTED', 'NO_FACTS', 'TOTAL_MISSING', 'BLOCKED', 'DATE_MISSING', 'TREATMENT', 'ACCOUNT']);

// ─── تصنيف المستند: مصروف أو أصلٌ ثابت (وفئته) أو بضاعة للبيع (D3) ───

type HintFacts = Pick<AcctDocFacts, 'categoryHint' | 'assetClassHint'> | null | undefined;

/**
 * المستند لا يُرحَّل من المحاسب الذكي بتصنيفه (الخادم يرفضه في planDocumentPost ولا يقترح له حساباً): بضاعة للبيع ⇒ «مشتريات
 * المستودع» (DOC_IS_INVENTORY)، وأرضٌ أو مبنى ⇒ المحاسب البشري (DOC_TREATMENT_REFERRED). null ⇒ يُرحَّل.
 */
export function docReferral(f: HintFacts): 'INVENTORY' | 'REFERRED' | null {
  if (f?.categoryHint === DOC_CATEGORY_INVENTORY) return 'INVENTORY';
  if (f?.assetClassHint === 'land_buildings') return 'REFERRED';
  return null;
}

/** شرائح «تصنيف المستند» — يختارها المستخدم (لا قارئ آلي D4) فيعيد الخادم الاقتراح والفحص */
export type DocCategoryChip = 'EXPENSE' | 'FIXED_ASSET' | 'INVENTORY';
export const DOC_CATEGORY_CHIPS: readonly DocCategoryChip[] = ['EXPENSE', 'FIXED_ASSET', 'INVENTORY'];

/** الشريحة المضيئة: فئة أصلٍ أو «fixed_asset» ⇒ أصل، و«inventory_goods» ⇒ بضاعة، وما سواهما (بلا تصنيف أو تصنيف مصروف) ⇒ مصروف */
export function categoryChipOf(f: HintFacts): DocCategoryChip {
  if (f?.categoryHint === DOC_CATEGORY_INVENTORY) return 'INVENTORY';
  if (f?.assetClassHint || f?.categoryHint === DOC_CATEGORY_FIXED_ASSET) return 'FIXED_ASSET';
  return 'EXPENSE';
}

export function categoryChipLabel(c: DocCategoryChip, tr: Tr = id): string {
  switch (c) {
    case 'FIXED_ASSET': return tr('أصل ثابت');
    case 'INVENTORY': return tr('بضاعة للبيع');
    default: return tr('مصروف أو خدمة');
  }
}

/**
 * جسم PATCH لشريحة التصنيف — null للمضيئة (لا طلب). «مصروف» يمحو التصنيف وفئة الأصل (يعود الاقتراح لنوع المستند ونصّه)،
 * و«أصل ثابت» يُبقي فئة الأصل إن وُجدت، و«بضاعة» تمحو فئة الأصل. الخادم يعيد الاقتراح والفحص (suggest.ts) من التصنيف.
 */
export function categoryChipPatch(c: DocCategoryChip, f: HintFacts): AcctDocPatch | null {
  if (categoryChipOf(f) === c) return null;
  if (c === 'INVENTORY') return { categoryHint: DOC_CATEGORY_INVENTORY, assetClassHint: null };
  if (c === 'FIXED_ASSET') return { categoryHint: DOC_CATEGORY_FIXED_ASSET };
  return { categoryHint: null, assetClassHint: null };
}

/** فئات الأصل بترتيب الشرائح (ACCT_ASSET_CLASSES) — الأراضي والمباني آخرها (تُحال للمحاسب البشري) */
export const ASSET_CLASS_ORDER: readonly AcctAssetClass[] = ACCT_ASSET_CLASSES;

export function assetClassLabel(c: AcctAssetClass, tr: Tr = id): string {
  switch (c) {
    case 'leasehold_improvements': return tr('تحسينات المحل');
    case 'machinery': return tr('آلات ومعدات');
    case 'furniture': return tr('أثاث وتجهيزات');
    case 'computers': return tr('أجهزة حاسب');
    case 'vehicles': return tr('سيارات');
    case 'tools': return tr('عدد وأدوات');
    case 'software_license': return tr('برامج وتراخيص');
    default: return tr('أراضٍ ومبانٍ');
  }
}

/** جسم PATCH لشريحة فئة الأصل (تحمل التصنيف «أصل ثابت» معها) — null للمضيئة */
export function assetClassPatch(c: AcctAssetClass, f: HintFacts): AcctDocPatch | null {
  if (f?.assetClassHint === c) return null;
  return { categoryHint: DOC_CATEGORY_FIXED_ASSET, assetClassHint: c };
}

// ─── أشهر الإطفاء ───

/**
 * جسم PATCH لأشهر «مدفوع مقدماً» التي كتبها المستخدم تحت المعالجة — فيعيد الخادم الاقتراح والفحص (paidMonths يمحو
 * MONTHS_INVALID «لا أشهر») بدل أن تبقى ملاحظةٌ حمراء تعطّل «سجّل القيد» بعد عددٍ صحيح. عددٌ صحيح 1..24 يخالف المخزّن وحده
 * (والأطول للمحاسب البشري — البطاقة تقولها ولا ترسله)؛ وإلا null.
 */
export function monthsPatch(v: Pick<AcctDocView, 'facts' | 'posted'>, months: number | null | undefined): AcctDocPatch | null {
  if (v.posted?.live || !monthsValid(months) || v.facts?.months === months) return null;
  const r = buildDocPatch({ months }, 2);
  return r.ok && r.patch.months === months ? { months } : null;
}

/** خانة الأشهر ظاهرة: للمعالجة «مقدّم»، أو لفحص أشهرٍ مانع يُحلّ بإدخالها (لا ما يُحال للمحاسب البشري) */
export function monthsInputShown(v: Pick<AcctDocView, 'checks'>, c: Pick<DocChoice, 'treatment'>): boolean {
  if (c.treatment === 'PREPAID') return true;
  return (v.checks ?? []).some(k => k?.code === 'MONTHS_INVALID' && k.details?.reason !== 'REFERRED');
}

// ─── الإدخال اليدوي (PATCH) ───

/** خانات الإدخال نصوصاً كما يكتبها المستخدم */
export interface FactsForm {
  vendorName: string;
  vendorVat: string;
  invoiceNo: string;
  issueDate: string;
  periodFrom: string;
  periodTo: string;
  subtotal: string;
  vatAmount: string;
  total: string;
}

export type FactsField = keyof FactsForm;

export function formOf(v: Pick<AcctDocView, 'facts'>): FactsForm {
  const f = v.facts;
  return {
    vendorName: f?.vendorName ?? '',
    vendorVat: f?.vendorVat ?? '',
    invoiceNo: f?.invoiceNo ?? '',
    issueDate: f?.issueDate ?? '',
    periodFrom: f?.periodFrom ?? '',
    periodTo: f?.periodTo ?? '',
    subtotal: f?.subtotal ?? '',
    vatAmount: f?.vatAmount ?? '',
    total: f?.total ?? '',
  };
}

const TEXT_FIELDS = ['vendorName', 'vendorVat', 'invoiceNo', 'issueDate', 'periodFrom', 'periodTo'] as const;
const AMOUNT_FIELDS = ['subtotal', 'vatAmount', 'total'] as const;
const TAX_FIELDS: ReadonlySet<FactsField> = new Set<FactsField>(['vendorVat', 'subtotal', 'vatAmount']);

export type PatchResult =
  | { ok: true; patch: AcctDocPatch }
  | { ok: false; field: FactsField; problem: DocFormProblem };

/**
 * الخانات ⇒ جسم PATCH بالحقول المتغيّرة عن الحقائق وحدها (ما لم يتغيّر لا يُرسَل فلا يقلب المصدر «QR» إلى «QR+USER» بلا
 * سبب)، والتحقّق والتوحيد بـbuildDocPatch (lib/aiAccountantDocs). في الشركة «بلا ضريبة» لا تُرسل خانات الضريبة ولا الرقم
 * الضريبي (مخفيّة). لا حساب هنا: لا «الإجمالي = قبل الضريبة + الضريبة» آلياً — الخادم يفحص (SUM_MISMATCH).
 */
export function patchOf(form: FactsForm, v: Pick<AcctDocView, 'facts'>, o: { decimals: number; taxOff?: boolean }): PatchResult {
  const f = v.facts;
  const changed: DocFactsForm = {};
  const skip = (k: FactsField) => o.taxOff === true && TAX_FIELDS.has(k);
  const norm = (s: string) => latinDigits(s).replace(/\s+/g, ' ').trim();
  for (const k of TEXT_FIELDS) {
    if (skip(k)) continue;
    const now = k === 'vendorVat' ? latinDigits(form[k]).replace(/[\s-]/g, '') : norm(form[k]);
    if (now !== (f?.[k] ?? '')) changed[k] = form[k];
  }
  for (const k of AMOUNT_FIELDS) {
    if (skip(k)) continue;
    const raw = form[k].trim();
    const before = f?.[k] ?? null;
    if (!raw) { if (before !== null) changed[k] = ''; continue; }
    const now = parseAmountInput(raw, o.decimals);
    if (now === null || before === null || parseAmountInput(before, o.decimals) !== now) changed[k] = raw;
  }
  const r = buildDocPatch(changed, o.decimals);
  if (r.ok) return r;
  // الحقول المرسلة من خانات البطاقة وحدها (نوع المستند والأشهر لا يمرّان من هنا)
  return { ok: false, field: isFormField(r.field) ? r.field : 'total', problem: r.problem };
}

/** خانةٌ من خانات البطاقة (مشكلة buildDocPatch تُعرض تحتها) */
export const isFormField = (f: DocFormField): f is FactsField =>
  (TEXT_FIELDS as readonly string[]).includes(f) || (AMOUNT_FIELDS as readonly string[]).includes(f);

/** تنبيه فوري في النموذج (قبل الحفظ): قبل الضريبة + الضريبة ≠ الإجمالي بأكثر من وحدةٍ صغرى. الخادم يحسمه بـSUM_MISMATCH */
export function sumMismatch(form: Pick<FactsForm, 'subtotal' | 'vatAmount' | 'total'>, decimals: number): boolean {
  const m = (s: string) => decToMilli(parseAmountInput(s, decimals));
  const s = m(form.subtotal);
  const v = m(form.vatAmount);
  const t = m(form.total);
  if (s === null || v === null || t === null) return false;
  const unit = 10n ** BigInt(3 - Math.min(3, Math.max(0, Math.trunc(decimals))));
  const diff = s + v - t;
  return (diff < 0n ? -diff : diff) > unit;
}

/** رقمٌ ضريبي مكتوبٌ لا يطابق صيغة الهيئة — تنبيهٌ في النموذج (لن تُخصم الضريبة) لا منع */
export function vendorVatOdd(raw: string): boolean {
  const vat = latinDigits(raw).replace(/[\s -]/g, '');
  return !!vat && !VENDOR_VAT_RE.test(vat);
}

// ─── شرائح المرفقات في خانة الكتابة ───

/** مرفقٌ في خانة الكتابة قبل الإرسال: يُجهَّز (ضغط + QR في الجهاز) ثم يُرفع، ثم يُرسَل معرّفه مع الرسالة */
export interface PendingDoc {
  key: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  phase: 'preparing' | 'uploading' | 'ready' | 'error';
  /** نسبة الرفع 0..100 */
  progress: number;
  /** رسالة الخطأ مترجمةً */
  error: string | null;
  docId: string | null;
  /** المستند موجودٌ من قبل (الملف نفسه رُفع سابقاً) — حذف الشريحة لا يحذفه من الخادم */
  deduped: boolean;
  /** رابط Blob محلي للمعاينة — يُبطَل عند «محادثة جديدة» */
  localUrl: string | null;
}

/** التجهيز أو الرفع جارٍ — الإرسال ينتظره */
export const pendingBusy = (list: readonly PendingDoc[]): boolean =>
  list.some(p => p.phase === 'preparing' || p.phase === 'uploading');

/** معرّفات الجاهز للإرسال (بلا تكرار، وبالسقف) */
export function readyDocIds(list: readonly PendingDoc[], perMessage = MAX_DOCS_PER_MESSAGE): string[] {
  const ids: string[] = [];
  for (const p of list) if (p.phase === 'ready' && p.docId && !ids.includes(p.docId)) ids.push(p.docId);
  return ids.slice(0, Math.max(0, perMessage));
}

/** ما بقي من مقاعد الرسالة (الشرائح الخاطئة لا تحجز مقعداً) */
export const slotsLeft = (list: readonly PendingDoc[], perMessage = MAX_DOCS_PER_MESSAGE): number =>
  Math.max(0, perMessage - list.filter(p => p.phase !== 'error').length);

/**
 * المستند ما زال مستعملاً فلا يُحذف من الخادم حين تُحذف شريحة: شريحةٌ أخرى تحمله (الملف نفسه أُرفق مرّتين فطابقه الخادم
 * بالبصمة)، أو رسالةٌ أُرسلت به. `exceptKey` الشريحة المحذوفة نفسها.
 */
export function docIdInUse(
  docId: string, chips: readonly Pick<PendingDoc, 'key' | 'docId'>[], entries: readonly { docIds?: readonly string[] | null }[], exceptKey: string,
): boolean {
  return chips.some(p => p.key !== exceptKey && p.docId === docId) || entries.some(e => !!e.docIds?.includes(docId));
}

// ─── العارض ───

export type ViewKind = 'image' | 'pdf';

/** النوع المعلن ⇒ طريقة العرض، للقائمة البيضاء التي يقبلها الخادم وحدها (PDF وJPEG وPNG) */
export function viewKindOf(mime: unknown): ViewKind | null {
  const m = typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : '';
  if (m === 'application/pdf') return 'pdf';
  if (m === 'image/jpeg' || m === 'image/png') return 'image';
  return null;
}

// ─── المحادثة: أين تُرسم البطاقة، ورفض ترحيلها، وما يُرحَّل الآن ───

/** ما تحتاجه الدوال التالية من مدخل المحادثة (ChatEntry يحقّقه بنيوياً) */
interface EntryLike {
  id: string;
  role: string;
  error?: string;
  docConfirm?: { docId?: unknown } | null;
  documents?: readonly { id: string }[] | null;
  action?: string | null;
  refusal?: DocRefusal | null;
}

/**
 * المستند الواحد قد يظهر في أكثر من ردّ (رُفع، ثم رُفض ترحيله فأُعيد): البطاقة الكاملة في أحدث ردٍّ يذكره وحده، وما قبله
 * سطرٌ مختصر — فلا بطاقتان حيّتان تُضغطان للمستند نفسه. ردّ «رُحّل» (DOC_POSTED) لا يملك البطاقة: بطاقة القيد فيه، والبطاقة
 * السابقة تُحدَّث «مُرحّل» بمكانها. يعيد لكل مستند معرّف الفقاعة التي ترسم بطاقته الكاملة.
 */
export function cardOwners(entries: readonly EntryLike[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries) {
    if (e.role !== 'assistant' || e.action === 'DOC_POSTED') continue;
    for (const d of e.documents ?? []) if (d && typeof d.id === 'string') out[d.id] = e.id;
  }
  return out;
}

/**
 * آخر رفضٍ لترحيل كل مستند: ردّ «سجّل القيد» (رسالةٌ بـdocConfirm ثم ردّها) — DOC_REFUSED يضعه، وDOC_POSTED يمحوه، ومحاولةٌ
 * أحدث للمستند نفسه تطويه (رفضها أو قبولها يقول الجديد). مشتقٌّ من المحادثة نفسها فلا حالة ثانية تتباعد عنها (والإعادة بعد
 * إشعار خطأ لا تُحتسب ردّاً).
 */
export function refusalsByDoc(entries: readonly EntryLike[]): Record<string, DocRefusal> {
  const out: Record<string, DocRefusal> = {};
  let asked: string | null = null;
  for (const e of entries) {
    if (e.role === 'user') {
      asked = confirmDocId(e);
      if (asked) delete out[asked];
      continue;
    }
    if (e.error || !asked) continue;
    if (e.action === 'DOC_REFUSED' && e.refusal) out[asked] = e.refusal;
    asked = null;
  }
  return out;
}

/**
 * الرفض الذي ما زال يصدق: مستندٌ صُحّحت حقائقه (PATCH) بعد رفضه (`patchedSince`) تغيّر ما رُفض عليه — رقم الفاتورة أو تاريخها
 * أو مبلغها — فلا يبقى صندوق الرفض الأحمر ولا وسم «يشبه مستنداً مسجلاً» (withRefusalDuplicate) الذي كان سيجعل الزرّ الوحيد
 * «ليست مكررة — سجّلها» فيتخطّى فحص التكرار للحقائق الجديدة. يحكم الخادم من جديد عند الضغطة التالية.
 */
export function activeRefusals(
  byDoc: Readonly<Record<string, DocRefusal>>, patchedSince: Readonly<Record<string, true>>,
): Record<string, DocRefusal> {
  const out: Record<string, DocRefusal> = {};
  for (const [docId, r] of Object.entries(byDoc)) if (!patchedSince[docId]) out[docId] = r;
  return out;
}

/** أحدث بطاقةٍ لمستند في المحادثة (من آخرها) — أو null */
export function latestDocView<V extends { id: string }>(entries: readonly { documents?: readonly V[] | null }[], docId: string): V | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const v = entries[i].documents?.find(d => d && d.id === docId);
    if (v) return v;
  }
  return null;
}

/**
 * آخر docConfirm أُرسل لكل مستند — البطاقة تنتقل إلى أحدث ردٍّ بعد الرفض (cardOwners) فتُركَّب من جديد، فيُستعاد منه ما
 * اختاره المستخدم (choiceFromConfirm) بدل أن يعيد «مدفوع من» والمعالجة والأشهر من أوّلها.
 */
export function lastConfirms(entries: readonly EntryLike[]): Record<string, AcctDocConfirmLike> {
  const out: Record<string, AcctDocConfirmLike> = {};
  for (const e of entries) {
    const c = e.role === 'user' ? e.docConfirm as AcctDocConfirmLike | null | undefined : null;
    if (c && typeof c.docId === 'string') out[c.docId] = c;
  }
  return out;
}

type AcctDocConfirmLike = Pick<DocConfirmChoice, 'treatment' | 'accountCode' | 'paidFrom' | 'paidFromAccountCode' | 'months'> & { docId: string };

/** الاختيار من تأكيدٍ سابق — مُواءماً مع العرض الحالي (ما خرج من خياراته يرتدّ كما في reconcileChoice) */
export function choiceFromConfirm(v: AcctDocView, c: AcctDocConfirmLike, o: Pick<DocCardOpts, 'assetThreshold' | 'taxOff'>): DocChoice {
  const pay = visiblePayOptions(v).find(p => p.paidFrom === c.paidFrom && (!c.paidFromAccountCode || p.code === c.paidFromAccountCode));
  const d = defaultChoice(v, o);
  return reconcileChoice(v, {
    treatment: c.treatment, accountCode: c.accountCode, pay: pay ? payValue(pay) : '', months: c.months ?? d.months, date: null,
  }, o);
}

/** المستند الذي يُرحَّل الآن: آخر رسالةٍ للمستخدم تحمل docConfirm وردّها منتظر */
export function confirmingDocId(entries: readonly EntryLike[], pending: boolean): string | null {
  if (!pending) return null;
  const last = entries[entries.length - 1];
  return last?.role === 'user' ? confirmDocId(last) : null;
}

const confirmDocId = (e: EntryLike): string | null => {
  const id = e.docConfirm?.docId;
  return typeof id === 'string' ? id : null;
};
