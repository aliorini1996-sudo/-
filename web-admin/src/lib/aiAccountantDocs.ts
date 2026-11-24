/**
 * «المحاسب الذكي AI» — رفع المستندات في المحادثة (طلب المالك ١٨ نوفمبر ٢٠٢٦): مرآة عقد الخادم
 * (backend/src/services/aiAccountant/documents/types.ts) والمنطق الصرف للرفع والتأكيد — لا React هنا ولا شبكة.
 *
 * قرارات المالك الملزمة:
 *  - لا قارئ ذكاء اصطناعي (D4): الوثيقة لا تغادر المنصة إلى أي مزوّد. الحقائق من رمز QR الزكوي — يُقرأ هنا في الجهاز
 *    (decodeZatcaQrFromImage) ويُرسَل نصّه base64 في ترويسة X-Zatca-Qr فيفكّه الخادم ويتحقّق منه — ومن إدخال المستخدم
 *    (PATCH /documents/:id). ملف PDF إدخالٌ يدوي في هذه النسخة. مصدر الحقائق QR | USER | QR+USER وحدها.
 *  - بطاقة تأكيد إلزامية (D1): «سجّل القيد» يرسل نصّاً مرئياً (composeConfirmText) يذكر الإجمالي والضريبة ورقم الحساب واسمه
 *    ورقم حساب الدفع واسمه حرفياً، ومعه docConfirm منظّماً. الخادم يرحّل بلا نموذج: المبالغ من الحقائق المخزّنة عنده، ويشترط
 *    ورودها في نصّ المستخدم نفسه (حارس المبلغ القائم في posting.ts). ولا نصّ من المستند نفسه فيه (اسم المورد من QR يكتبه
 *    المورد) — فلا يصير كلامَ المستخدم في الدورات اللاحقة.
 *  - السقوف (D8): الصورة ≤ 400KB بعد الضغط في الجهاز، وPDF ≤ 3MB (أو ما تقوله /status)، و٣ مستندات للرسالة، والنوع بالبايتات.
 *
 * هذا الملف ورقة الشجرة: لا يستورد شيئاً تشغيلياً من lib/aiAccountant.ts (الذي يستورد منه) — فلا حلقة استيراد.
 */

type Tr = (ar: string) => string;
const idTr: Tr = (s) => s;

// ═══ عقد الخادم ═══

export type AcctDocStatus = 'UPLOADED' | 'EXTRACTED' | 'NEEDS_REVIEW' | 'FAILED';
export const ACCT_DOC_STATUSES: readonly AcctDocStatus[] = ['UPLOADED', 'EXTRACTED', 'NEEDS_REVIEW', 'FAILED'];

export type AcctDocType = 'TAX_INVOICE' | 'SIMPLIFIED_INVOICE' | 'LEASE_CONTRACT' | 'MAINTENANCE_INVOICE'
  | 'UTILITY_BILL' | 'RECEIPT' | 'OTHER';
/** أنواع المستند (ترتيب الخادم وشرائح البطاقة) — المستخدم يختار النوع بنفسه (لا قارئ آلي) */
export const ACCT_DOC_TYPES: readonly AcctDocType[] = [
  'TAX_INVOICE', 'SIMPLIFIED_INVOICE', 'LEASE_CONTRACT', 'MAINTENANCE_INVOICE', 'UTILITY_BILL', 'RECEIPT', 'OTHER',
];

export type AcctDocTreatment = 'EXPENSE' | 'PREPAID' | 'ASSET';
export const ACCT_DOC_TREATMENTS: readonly AcctDocTreatment[] = ['EXPENSE', 'PREPAID', 'ASSET'];

export type AcctVatMode = 'DEDUCTIBLE' | 'NON_DEDUCTIBLE' | 'NONE';
/** = تعداد post_expense (writeTools.ts) — payable ⇐ 213002 مصروفات مستحقة (D6) */
export type AcctPaidFrom = 'cash' | 'petty_cash' | 'bank' | 'payable';
export const ACCT_PAID_FROM: readonly AcctPaidFrom[] = ['cash', 'petty_cash', 'bank', 'payable'];
/** D4: لا مصدر «AI» — رمز QR الزكوي أو إدخال المستخدم أو كلاهما */
export type AcctFactsSource = 'QR' | 'USER' | 'QR+USER';
export type AcctPaymentHint = 'PAID' | 'UNPAID' | 'UNKNOWN';

/** فئة الأصل (D3) ⇐ حسابه — الأراضي والمباني تُحال للمحاسب البشري */
export type AcctAssetClass = 'leasehold_improvements' | 'machinery' | 'furniture' | 'computers' | 'vehicles' | 'tools'
  | 'software_license' | 'land_buildings';
export const ACCT_ASSET_CODES: Readonly<Record<Exclude<AcctAssetClass, 'land_buildings'>, string>> = {
  leasehold_improvements: '121003',
  machinery: '121004',
  furniture: '121005',
  computers: '121006',
  vehicles: '121007',
  tools: '121008',
  software_license: '124001',
};
export const ACCT_ASSET_CLASSES: readonly AcctAssetClass[] = [...Object.keys(ACCT_ASSET_CODES) as AcctAssetClass[], 'land_buildings'];

export interface AcctDocLease {
  totalRent: string | null;
  months: number | null;
  frequency: string | null;
  start: string | null;
  end: string | null;
  deposit: string | null;
  residential: boolean | null;
}

/** الحقائق — المبالغ نصوصٌ عشرية بمنازل عملة الشركة («1150.00»)، والتواريخ ميلادية YYYY-MM-DD */
export interface AcctDocFacts {
  docType: AcctDocType | null;
  vendorName: string | null;
  vendorVat: string | null;
  buyerName: string | null;
  buyerVat: string | null;
  invoiceNo: string | null;
  issueDate: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  currency: string | null;
  subtotal: string | null;
  vatAmount: string | null;
  total: string | null;
  vatRatePct: number | null;
  lines: { description: string; amount: string | null }[];
  lease: AcctDocLease | null;
  /** أشهر الخدمة المدفوعة مقدماً (1..24) يدخلها المستخدم أو تُشتق من الفترة (أو lease.months احتياطاً) */
  months: number | null;
  paymentHint: AcctPaymentHint;
  /** مفتاح تصنيف المصروف (EXPENSE_CATEGORY_KEYS) أو prepaid | fixed_asset | inventory_goods | unknown */
  categoryHint: string | null;
  assetClassHint: AcctAssetClass | null;
}

/** الفحوص (§5.1 بعد D4 بلا LOW_CONFIDENCE) + إضافات الخادم: VAT_NO_BOX وFILE_GONE وMONTHS_INVALID وNEEDS_DEPRECIATION */
export type AcctDocCheckCode = 'TOTAL_MISSING' | 'DATE_MISSING' | 'SUM_MISMATCH' | 'VAT_RATE_ODD' | 'VAT_NO_TAX_NUMBER'
  | 'VAT_BLOCKED_CATEGORY' | 'VAT_NO_BOX' | 'BUYER_OTHER' | 'CURRENCY_MISMATCH' | 'DATE_FUTURE' | 'DATE_TOO_OLD' | 'HIJRI_DATE'
  | 'QR_MISMATCH' | 'QR_INVALID' | 'NOT_A_PAYMENT' | 'DUPLICATE_SUSPECT' | 'FILE_GONE' | 'MONTHS_INVALID'
  | 'NEEDS_DEPRECIATION';

export interface AcctDocCheck {
  /** رمزٌ لا نعرفه من خادمٍ أحدث يبقى نصّاً ويُعرض بعبارةٍ عامة */
  code: AcctDocCheckCode | (string & {});
  field?: string;
  severity: 'block' | 'warn';
  details?: Record<string, string>;
}

export interface AcctDocSuggestion {
  treatment: AcctDocTreatment;
  accountCode: string;
  accountName: string;
  vatMode: AcctVatMode;
  months: number | null;
  /** من paymentHint — المستخدم يختار «مدفوع من» بنفسه دائماً */
  paidFrom: AcctPaidFrom | null;
  /** PREPAID: مصروف الإطفاء الشهري (Dr هذا / Cr 115002|115001) — اختياري: خادمٌ لا يرسله ⇒ غائب */
  amortizationCode?: string;
  amortizationName?: string;
}

/**
 * خيار حسابٍ في البطاقة. الحقول الاختيارية من خادمٍ يرسلها (غيابها ⇒ غائبة): vatMode حكم الضريبة لهذا الحساب بعينه (D7 —
 * الضيافة وسكن الموظفين لا تُخصم)، وللمدفوع مقدماً مصروف إطفائه الشهري.
 */
export interface AcctAccountOption {
  code: string;
  name: string;
  treatment: AcctDocTreatment;
  vatMode?: AcctVatMode;
  amortizationCode?: string;
  amortizationName?: string;
}
export interface AcctPayOption { paidFrom: AcctPaidFrom; code: string; name: string }

export interface AcctDocPosted { moveId: string; moveNumber: string | null; live: boolean; kind: string }
export interface AcctDocDuplicate { moveNumber: string | null; reason: 'SHA' | 'INVOICE_NO' | 'SOFT' }

export interface AcctDocView {
  id: string;
  /** 'D1'… بترتيب الظهور في نافذة المحادثة ('' خارجها) */
  ref: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  status: AcctDocStatus;
  /** بلا QR ⇒ البطاقة تُفتح في وضع التحرير */
  manualEntry: boolean;
  factsSource: AcctFactsSource | null;
  facts: AcctDocFacts | null;
  checks: AcctDocCheck[];
  qrVerified: boolean;
  suggestion: AcctDocSuggestion | null;
  /** من دليل حسابات الشركة نفسها (الخادم يحلّها) */
  accountOptions: AcctAccountOption[];
  payOptions: AcctPayOption[];
  posted: AcctDocPosted | null;
  duplicateOf: AcctDocDuplicate | null;
}

/** جسم docConfirm في POST /chat — docId من docIds آخر رسالة للمستخدم */
export interface AcctDocConfirm {
  docId: string;
  treatment: AcctDocTreatment;
  accountCode: string;
  paidFrom: AcctPaidFrom;
  paidFromAccountCode?: string | null;
  months?: number | null;
  date?: string | null;
  confirmedNotDuplicate?: boolean;
}

/**
 * جسم PATCH /documents/:id (docPatchSchema في الخادم) — كل حقلٍ اختياري (الغائب لا يُمسّ، وnull يمحوه)، والمبالغ نصوصٌ عشرية
 * قانونية (buildDocPatch). categoryHint من مفاتيح تصنيف المصروف أو الفئات الأربع الإضافية، وpaymentHint لا يُمحى (بلا null).
 */
export interface AcctDocPatch {
  docType?: AcctDocType | null;
  categoryHint?: string | null;
  assetClassHint?: AcctAssetClass | null;
  vendorName?: string | null;
  vendorVat?: string | null;
  buyerName?: string | null;
  buyerVat?: string | null;
  invoiceNo?: string | null;
  issueDate?: string | null;
  periodFrom?: string | null;
  periodTo?: string | null;
  currency?: string | null;
  subtotal?: string | null;
  vatAmount?: string | null;
  total?: string | null;
  vatRatePct?: number | null;
  months?: number | null;
  paymentHint?: AcctPaymentHint;
}

/** رموز رفض الترحيل الخاصة بالمستندات (تُلحَق بـAiRefusalCode في الخادم) — D5: لا موافقة */
export const AI_DOC_REFUSALS = [
  'DOC_NOT_FOUND', 'DOC_NOT_ATTACHED', 'DOC_NOT_READY', 'DOC_NEEDS_REVIEW', 'DOC_TOTAL_NOT_CONFIRMED',
  'ACCOUNT_NOT_IN_MESSAGE', 'PAYMENT_SOURCE_NOT_IN_MESSAGE', 'DOC_CURRENCY_MISMATCH', 'DOC_ALREADY_POSTED', 'DOC_POSSIBLE_DUPLICATE',
  'DOC_FILE_GONE', 'TREATMENT_NOT_ALLOWED', 'ASSET_BELOW_THRESHOLD', 'PREPAID_MONTHS_INVALID', 'DOC_TREATMENT_REFERRED',
  'DOC_IS_INVENTORY', 'DOCS_DISABLED', 'NOT_A_PAYMENT',
] as const;
export type AiDocRefusalCode = typeof AI_DOC_REFUSALS[number];

/** نتيجة دورة التأكيد في ChatData */
export type DocChatAction = 'DOC_POSTED' | 'DOC_REFUSED';
export interface DocRefusal { code: string; message: string; details?: Record<string, unknown> }

export interface DocCaps {
  /** سقف الصورة بعد الضغط في الجهاز (بايت) */
  imageBytes: number;
  /** سقف PDF (بايت) — AI_ACCOUNTANT_DOC_PDF_MB */
  pdfBytes: number;
  /** مستندات الرسالة الواحدة */
  perMessage: number;
}

/** كتلة docs في GET /status (AcctDocsStatus في الخادم) */
export interface AiDocsStatus {
  /** مفتاح AI_ACCOUNTANT_DOCS + علم الشركة + canPost + AI_ACCOUNTANT_WRITE — 📎 لا يظهر بغيره */
  enabled: boolean;
  /** = enabled في الخادم اليوم (غيابه ⇒ enabled) */
  canUpload: boolean;
  caps: DocCaps;
  /** حدّ الرسملة بوحدة العملة الكبرى (AI_ACCOUNTANT_ASSET_THRESHOLD) */
  assetThreshold: number;
  /** أيام بقاء المستند غير المرحّل (AI_ACCOUNTANT_DOC_RETENTION_DAYS) */
  retentionDays: number;
}

/** شريحة مرفقٍ في فقاعة المستخدم — للعرض وحده، لا تُرسَل للخادم */
export interface ChatAttachment { id: string; fileName: string; mimeType: string; sizeBytes: number }

/**
 * تقدّم إطفاء «مدفوع مقدماً» على قيد الدفع. الخادم يرسل {posted, months} (PostedMove.prepaid)، والتطبيع يضيف اسم الواجهة
 * postedMonths (= posted) وما قد يرسله خادمٌ أحدث (stopped/nextDate/lockedMonths) بقيمٍ آمنة حين يغيب.
 */
export interface AiPrepaidProgress {
  /** الأقساط المرحّلة (اسم الخادم) */
  posted: number;
  months: number;
  /** = posted — اسم بطاقة القيد */
  postedMonths: number;
  /** توقّف الإطفاء (عُكس قيد الدفع) — غيابه false، والبطاقة تحكم أيضاً بعكس القيد نفسه */
  stopped: boolean;
  /** آخر يوم الشهر المستحق التالي بتوقيت الشركة — null حين لا يرسله الخادم */
  nextDate: string | null;
  /** أشهر YYYY-MM تخطّاها الإطفاء لفترةٍ مقفلة */
  lockedMonths: string[];
}

/** قيد إطفاءٍ شهري: أبوه وترتيبه — يُقبل حين يرسله الخادم كاملاً (اليوم يرسل parentPostId وحده) */
export interface AiAmortRef { parentPostId: string; index: number; months: number }

// ═══ الثوابت ═══

export const DOC_IMAGE_MAX_BYTES = 400 * 1024;
export const DOC_PDF_MAX_BYTES = 3 * 1024 * 1024;
export const MAX_DOCS_PER_MESSAGE = 3;
export const DEFAULT_DOC_CAPS: Readonly<DocCaps> = { imageBytes: DOC_IMAGE_MAX_BYTES, pdfBytes: DOC_PDF_MAX_BYTES, perMessage: MAX_DOCS_PER_MESSAGE };
export const DEFAULT_ASSET_THRESHOLD = 2000;
export const DEFAULT_DOC_RETENTION_DAYS = 30;
/** D2: الإطفاء من شهر إلى ٢٤ — الأطول يُحال للمحاسب البشري */
export const PREPAID_MAX_MONTHS = 24;
/** أطول نصّ QR يقبله الخادم (MAX_QR_DECODE_LENGTH في compliance/zatca/qr.ts) */
export const ZATCA_QR_MAX_LENGTH = 2048;
/** D7: رقم ضريبي سعودي صحيح للمورد ⇒ ضريبة المدخلات تُخصم */
export const VENDOR_VAT_RE = /^3\d{13}3$/;

export const DOC_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type DocMime = typeof DOC_MIME_TYPES[number];
export const isDocMime = (s: unknown): s is DocMime => typeof s === 'string' && (DOC_MIME_TYPES as readonly string[]).includes(s);

/** ضغط الصور: مرّة أولى بحدّي وثائق الاستديو (DOC_COMPRESS) ثم مرّة ثانية أصغر (كمرفقات المشتريات على الجوال) */
export const DOC_IMAGE_PASSES: readonly { maxDim: number; quality: number }[] = [
  { maxDim: 1600, quality: 0.72 },
  { maxDim: 1280, quality: 0.6 },
];

/** حسابات الأصول المسموحة بالرمز (D3) — 122xxx مجمّع الإهلاك يشاركها النوع فلا يُقبل بالنوع */
export const ASSET_ACCOUNT_CODES: readonly string[] = ['121003', '121004', '121005', '121006', '121007', '121008', '124001'];
export const PREPAID_ACCOUNT_CODES: readonly string[] = ['115001', '115002'];
export const RENT_EXPENSE_CODE = '621004';
/** مصروفات «الإيجار» للمدفوع مقدماً: الإيجار وسكن الموظفين (RENT_EXPENSE_CODES في posting.ts) */
export const RENT_EXPENSE_CODES: readonly string[] = [RENT_EXPENSE_CODE, '621005'];
export const ACCRUED_EXPENSES_CODE = '213002';
/** حساب المدفوع مقدماً لمصروف الإطفاء (resolvePrepaidAccount في الخادم): الإيجار وسكن الموظفين ⇐ 115002، وما سواهما ⇐ 115001 */
export const prepaidAccountFor = (expenseCode: string): string => (RENT_EXPENSE_CODES.includes(expenseCode) ? '115002' : '115001');
const STAFF_HOUSING_CODE = '621005';
/** «مصروفات متنوعة» — بديل الخادم حين لا يُستعمل حساب التصنيف في دليل الشركة (pickAccount ثم misc) */
const MISC_EXPENSE_CODE = '621016';

/**
 * فئات categoryHint غير تصنيفات المصروف (ACCT_DOC_EXTRA_CATEGORIES في documents/types.ts) — يختارها المستخدم من شرائح البطاقة:
 * أصلٌ ثابت (ومعه فئة الأصل assetClassHint) أو بضاعة للبيع (DOC_IS_INVENTORY). وما سواها من النصوص مفتاح تصنيف مصروف.
 */
export const DOC_CATEGORY_FIXED_ASSET = 'fixed_asset';
export const DOC_CATEGORY_INVENTORY = 'inventory_goods';
const NON_EXPENSE_HINTS: ReadonlySet<string> = new Set(['prepaid', DOC_CATEGORY_FIXED_ASSET, DOC_CATEGORY_INVENTORY, 'unknown']);
const isExpenseHint = (h: unknown): h is string => typeof h === 'string' && !!h && !NON_EXPENSE_HINTS.has(h);

/** أسماء الدليل SA_6D احتياطاً حين لا يرسل الخادم الخيار (النصّ يحمل الرمز دائماً — الاسم للقراءة) */
const CHART_NAMES_AR: Readonly<Record<string, string>> = {
  '111001': 'الصندوق الرئيسي',
  '111002': 'صندوق المصروفات النثرية',
  '111101': 'البنك الرئيسي',
  '115001': 'مصروفات مدفوعة مقدماً',
  '115002': 'إيجار مدفوع مقدماً',
  '213002': 'مصروفات مستحقة',
};
const DEFAULT_PAY_CODES: Readonly<Record<AcctPaidFrom, string>> = { cash: '111001', petty_cash: '111002', bank: '111101', payable: ACCRUED_EXPENSES_CODE };

/** نصّ الإرسال الافتراضي لمستندٍ بلا كتابة — لا يطابق نيّة التسجيل (WRITE_INTENT_RE): لا «سجّل» ولا «قيد» */
export const docDefaultText = (tr: Tr = idTr): string => tr('اقرأ المستند المرفق ولخّص بياناته');

// ═══ أدوات صغيرة ═══

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuidStr = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ACCOUNT_CODE_RE = /^\d{3,12}$/;

/** يوم ميلادي صالح YYYY-MM-DD (نسخة isValidDay في lib/aiAccountant.ts — هنا كي لا تنشأ حلقة استيراد) */
export function isDocDay(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = DAY_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const strOr = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const finiteNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const posInt = (v: unknown, max: number): number | null => {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= max ? n : null;
};

/* محارف التحكّم وعلامات الاتجاه (حقنٌ بصري في نصٍّ يقرؤه المستخدم ويُرسَل للخادم) — تُحذف ثم تُطوى المسافات */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩﻿]/g;

/** نصٌّ نظيف للعرض والإرسال: بلا محارف تحكّم ولا علامات اتجاه، مسافاته مطويّة، مقصوصٌ إلى `max` */
export function cleanDocText(v: unknown, max = 120): string {
  if (typeof v !== 'string') return '';
  return v.slice(0, max * 4).replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}
const textOrNull = (v: unknown, max = 120): string | null => cleanDocText(v, max) || null;

// ═══ المال: نصوص عشرية ⇐ ملّي BigInt (كـposting.ts) ═══

const DIGIT_MAP: Readonly<Record<string, string>> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};
/** الأرقام الهندية والفارسية لاتينية */
export const latinDigits = (s: string): string => s.replace(/[٠-٩۰-۹]/g, (d) => DIGIT_MAP[d] ?? d);

const DEC_RE = /^\d+(?:\.\d+)?$/;
/** نصٌّ عشري قانوني غير سالب («1150.00») */
export const isDecimalString = (s: unknown): s is string => typeof s === 'string' && s.length <= 24 && DEC_RE.test(s);

/** نصٌّ عشري ⇐ ملّي (منازل ثلاث، تقريب نصف لأعلى لما بعدها) — null لغير القانوني */
export function decToMilli(s: unknown): bigint | null {
  if (!isDecimalString(s)) return null;
  const [i, f = ''] = s.split('.');
  let m = BigInt(i) * 1000n + BigInt((f + '000').slice(0, 3));
  if (f.length > 3 && Number(f[3]) >= 5) m += 1n;
  return m;
}

/** ملّي ⇐ نصٌّ عشري بمنازل العملة (٠–٣) — تقريب نصف لأعلى كـposting.ts */
export function milliToDec(m: bigint, decimals = 2): string {
  const d = Math.min(3, Math.max(0, Math.trunc(decimals)));
  const neg = m < 0n;
  let a = neg ? -m : m;
  const unit = 10n ** BigInt(3 - d);
  a = (a + unit / 2n) / unit; // نصف لأعلى (unit=1 ⇒ بلا تقريب)
  const base = 10n ** BigInt(d);
  const ip = (a / base).toString();
  const fp = d ? '.' + (a % base).toString().padStart(d, '0') : '';
  return `${neg && a !== 0n ? '-' : ''}${ip}${fp}`;
}

/**
 * مبلغٌ كتبه المستخدم في البطاقة ⇐ نصٌّ عشري قانوني بمنازل العملة، أو null. يقبل الأرقام العربية والفاصلة العشرية «٫» وفواصل
 * الآلاف («1,150.50» و«١٬١٥٠٫٥») بشرط أن تفصل مجموعات ثلاثية — و«150,50» (فاصلة عشرية أوروبية) غامضةٌ فتُرفض لا تُخمَّن.
 */
export function parseAmountInput(raw: unknown, decimals = 2): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  let s = latinDigits(String(raw)).replace(/\s+/g, '').replace(/٫/g, '.');
  if (!s || s.length > 32) return null;
  const [ip, fp, extra] = s.split('.');
  if (extra !== undefined) return null;
  if (/[,،٬]/.test(ip)) {
    if (!/^\d{1,3}(?:[,،٬]\d{3})+$/.test(ip)) return null;
  }
  s = ip.replace(/[,،٬]/g, '') + (fp ? '.' + fp : ''); // «5.» = 5
  if (!DEC_RE.test(s)) return null;
  const m = decToMilli(s);
  return m === null ? null : milliToDec(m, decimals);
}

/** عرض المبلغ بفواصل الآلاف ومنازل العملة («1150» ⇒ «1,150.00») — الأرقام نفسها، فيطابقها حارس الخادم رقمياً */
export function formatDocAmount(dec: string, decimals = 2): string {
  if (!isDecimalString(dec)) return dec;
  const [ip, fp = ''] = dec.split('.');
  const want = Math.min(3, Math.max(0, Math.trunc(decimals)));
  const frac = fp.length >= want ? fp : fp.padEnd(want, '0');
  const grouped = ip.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

/** صافي المستند (قبل الضريبة) بالملّي: المبلغ قبل الضريبة، وإلا الإجمالي ناقص الضريبة، وإلا الإجمالي */
export function netMilliOf(f: Pick<AcctDocFacts, 'subtotal' | 'vatAmount' | 'total'> | null | undefined): bigint | null {
  if (!f) return null;
  const sub = decToMilli(f.subtotal);
  if (sub !== null) return sub;
  const total = decToMilli(f.total);
  if (total === null) return null;
  const vat = decToMilli(f.vatAmount);
  return vat !== null && vat <= total ? total - vat : total;
}

/** D3: صافي الشراء دون حدّ الرسملة ⇒ مصروف لا أصل (الحدّ بوحدة العملة الكبرى) */
export function assetBelowThreshold(f: Pick<AcctDocFacts, 'subtotal' | 'vatAmount' | 'total'> | null | undefined, thresholdMajor = DEFAULT_ASSET_THRESHOLD): boolean {
  const net = netMilliOf(f);
  if (net === null) return true;
  const t = Number.isFinite(thresholdMajor) && thresholdMajor > 0 ? BigInt(Math.round(thresholdMajor * 1000)) : 0n;
  return net < t;
}

// ═══ التطبيع الدفاعي لردود الخادم ═══

const DOC_TYPE_SET = new Set<string>(ACCT_DOC_TYPES);
const TREATMENT_SET = new Set<string>(ACCT_DOC_TREATMENTS);
const PAID_FROM_SET = new Set<string>(ACCT_PAID_FROM);
const asDocType = (v: unknown): AcctDocType | null => (typeof v === 'string' && DOC_TYPE_SET.has(v) ? v as AcctDocType : null);
const asTreatment = (v: unknown): AcctDocTreatment | null => (typeof v === 'string' && TREATMENT_SET.has(v) ? v as AcctDocTreatment : null);
const asPaidFrom = (v: unknown): AcctPaidFrom | null => (typeof v === 'string' && PAID_FROM_SET.has(v) ? v as AcctPaidFrom : null);
const asVatMode = (v: unknown): AcctVatMode => (v === 'DEDUCTIBLE' || v === 'NON_DEDUCTIBLE' ? v : 'NONE');
const asDay = (v: unknown): string | null => (isDocDay(v) ? v : null);
/** مبلغ الحقائق: نصٌّ عشري، أو رقمٌ غير سالب من خادمٍ يرسله رقماً */
const asDec = (v: unknown): string | null => {
  if (isDecimalString(v)) return v;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e15) {
    const s = String(v);
    return DEC_RE.test(s) ? s : null;
  }
  return null;
};

function normalizeLease(v: unknown): AcctDocLease | null {
  if (!v || typeof v !== 'object') return null;
  const l = obj(v);
  return {
    totalRent: asDec(l.totalRent),
    months: posInt(l.months, 600),
    frequency: textOrNull(l.frequency, 20),
    start: asDay(l.start),
    end: asDay(l.end),
    deposit: asDec(l.deposit),
    residential: typeof l.residential === 'boolean' ? l.residential : null,
  };
}

export function normalizeDocFacts(v: unknown): AcctDocFacts | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const f = obj(v);
  const lease = normalizeLease(f.lease);
  const ph = f.paymentHint;
  return {
    docType: asDocType(f.docType),
    vendorName: textOrNull(f.vendorName),
    vendorVat: textOrNull(f.vendorVat, 20),
    buyerName: textOrNull(f.buyerName),
    buyerVat: textOrNull(f.buyerVat, 20),
    invoiceNo: textOrNull(f.invoiceNo, 60),
    issueDate: asDay(f.issueDate),
    periodFrom: asDay(f.periodFrom),
    periodTo: asDay(f.periodTo),
    currency: typeof f.currency === 'string' && /^[A-Z]{3}$/.test(f.currency) ? f.currency : null,
    subtotal: asDec(f.subtotal),
    vatAmount: asDec(f.vatAmount),
    total: asDec(f.total),
    vatRatePct: finiteNum(f.vatRatePct),
    lines: (Array.isArray(f.lines) ? f.lines : []).slice(0, 10).flatMap((l) => {
      const x = obj(l);
      const description = cleanDocText(x.description, 80);
      return description ? [{ description, amount: asDec(x.amount) }] : [];
    }),
    lease,
    months: posInt(f.months, 600) ?? lease?.months ?? null,
    paymentHint: ph === 'PAID' || ph === 'UNPAID' ? ph : 'UNKNOWN',
    categoryHint: textOrNull(f.categoryHint, 40),
    assetClassHint: ACCT_ASSET_CLASSES.includes(f.assetClassHint as AcctAssetClass) ? f.assetClassHint as AcctAssetClass : null,
  };
}

function normalizeCheck(v: unknown): AcctDocCheck | null {
  const c = obj(v);
  const code = typeof c.code === 'string' ? c.code.trim().slice(0, 40) : '';
  if (!code) return null;
  const out: AcctDocCheck = { code, severity: c.severity === 'block' ? 'block' : 'warn' };
  if (typeof c.field === 'string' && c.field) out.field = c.field.slice(0, 40);
  if (c.details && typeof c.details === 'object' && !Array.isArray(c.details)) {
    const details: Record<string, string> = {};
    for (const [k, val] of Object.entries(c.details as Record<string, unknown>).slice(0, 12)) {
      if (typeof val === 'string' || typeof val === 'number') details[k] = cleanDocText(String(val), 120);
    }
    if (Object.keys(details).length) out.details = details;
  }
  return out;
}

/** مصروف الإطفاء الاختياري (amortizationCode/Name) بوجوده الصالح وحده — فخادمٌ لا يرسله يُبقي الشكل القديم حرفاً بحرف */
function amortizationFields(o: Record<string, unknown>): { amortizationCode?: string; amortizationName?: string } {
  if (typeof o.amortizationCode !== 'string' || !ACCOUNT_CODE_RE.test(o.amortizationCode)) return {};
  const name = cleanDocText(o.amortizationName, 120);
  return { amortizationCode: o.amortizationCode, ...(name ? { amortizationName: name } : {}) };
}

function normalizeSuggestion(v: unknown): AcctDocSuggestion | null {
  const s = obj(v);
  const treatment = asTreatment(s.treatment);
  const accountCode = typeof s.accountCode === 'string' && ACCOUNT_CODE_RE.test(s.accountCode) ? s.accountCode : '';
  if (!treatment || !accountCode) return null;
  return {
    treatment,
    accountCode,
    accountName: cleanDocText(s.accountName, 120),
    vatMode: asVatMode(s.vatMode),
    months: posInt(s.months, 600),
    paidFrom: asPaidFrom(s.paidFrom),
    ...(treatment === 'PREPAID' ? amortizationFields(s) : {}),
  };
}

function normalizeAccountOption(v: unknown): AcctAccountOption | null {
  const o = obj(v);
  const treatment = asTreatment(o.treatment);
  if (!treatment || typeof o.code !== 'string' || !ACCOUNT_CODE_RE.test(o.code)) return null;
  const vm = o.vatMode;
  return {
    code: o.code,
    name: cleanDocText(o.name, 120),
    treatment,
    ...(vm === 'DEDUCTIBLE' || vm === 'NON_DEDUCTIBLE' || vm === 'NONE' ? { vatMode: vm } : {}),
    ...(treatment === 'PREPAID' ? amortizationFields(o) : {}),
  };
}

function normalizePayOption(v: unknown): AcctPayOption | null {
  const o = obj(v);
  const paidFrom = asPaidFrom(o.paidFrom);
  if (!paidFrom || typeof o.code !== 'string' || !ACCOUNT_CODE_RE.test(o.code)) return null;
  return { paidFrom, code: o.code, name: cleanDocText(o.name, 120) };
}

/** الخيارات بلا تكرار (الأسبق يغلب) */
function uniqueBy<T>(xs: (T | null)[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of xs) {
    if (!x) continue;
    const k = key(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/** بطاقة المستند بعد تطبيعٍ دفاعي — بلا معرّف UUID ⇒ null (لا يُرسَل docIds يرفضه الخادم) */
export function normalizeDocView(v: unknown): AcctDocView | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const d = obj(v);
  if (!isUuidStr(d.id)) return null;
  const status = ACCT_DOC_STATUSES.includes(d.status as AcctDocStatus) ? d.status as AcctDocStatus : 'NEEDS_REVIEW';
  const fs = d.factsSource;
  const posted = obj(d.posted);
  const dup = obj(d.duplicateOf);
  const dupReason = dup.reason === 'SHA' || dup.reason === 'INVOICE_NO' || dup.reason === 'SOFT' ? dup.reason : null;
  const moveNo = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, 60) : null);
  return {
    id: d.id,
    ref: typeof d.ref === 'string' && /^D\d{1,3}$/.test(d.ref) ? d.ref : '',
    fileName: cleanDocText(d.fileName, 120) || 'document',
    mimeType: strOr(d.mimeType).slice(0, 60),
    sizeBytes: Math.max(0, finiteNum(d.sizeBytes) ?? 0),
    createdAt: strOr(d.createdAt).slice(0, 40),
    status,
    manualEntry: d.manualEntry === true,
    factsSource: fs === 'QR' || fs === 'USER' || fs === 'QR+USER' ? fs : null,
    facts: normalizeDocFacts(d.facts),
    checks: (Array.isArray(d.checks) ? d.checks : []).slice(0, 30).map(normalizeCheck).filter((c): c is AcctDocCheck => !!c),
    qrVerified: d.qrVerified === true,
    suggestion: normalizeSuggestion(d.suggestion),
    accountOptions: uniqueBy((Array.isArray(d.accountOptions) ? d.accountOptions : []).slice(0, 80).map(normalizeAccountOption), (o) => `${o.treatment}:${o.code}`),
    payOptions: uniqueBy((Array.isArray(d.payOptions) ? d.payOptions : []).slice(0, 30).map(normalizePayOption), (o) => `${o.paidFrom}:${o.code}`),
    posted: typeof posted.moveId === 'string' && posted.moveId
      ? { moveId: posted.moveId, moveNumber: moveNo(posted.moveNumber), live: posted.live === true, kind: strOr(posted.kind).slice(0, 30) }
      : null,
    duplicateOf: dupReason ? { moveNumber: moveNo(dup.moveNumber), reason: dupReason } : null,
  };
}

/** قائمة مستندات (ChatData.documents) بلا تكرار المعرّف — الأحدث (الأخير) يغلب */
export function normalizeDocViews(v: unknown): AcctDocView[] {
  if (!Array.isArray(v)) return [];
  const byId = new Map<string, AcctDocView>();
  for (const x of v.slice(0, 30)) {
    const d = normalizeDocView(x);
    if (d) byId.set(d.id, d);
  }
  return [...byId.values()];
}

/** ردّ الرفع/القراءة/التصحيح ({document, deduped}) — يقبل البطاقة نفسها بلا غلاف */
export function normalizeDocResponse(raw: unknown): { document: AcctDocView | null; deduped: boolean } {
  const d = obj(raw);
  return { document: normalizeDocView('document' in d ? d.document : raw), deduped: d.deduped === true };
}

/** رفض دورة التأكيد — الرمز إلزامي */
export function normalizeDocRefusal(v: unknown): DocRefusal | null {
  const r = obj(v);
  const code = typeof r.code === 'string' ? r.code.trim().slice(0, 60) : '';
  if (!code) return null;
  const out: DocRefusal = { code, message: cleanDocText(r.message, 600) };
  if (r.details && typeof r.details === 'object' && !Array.isArray(r.details)) out.details = r.details as Record<string, unknown>;
  return out;
}

export const normalizeDocAction = (v: unknown): DocChatAction | null => (v === 'DOC_POSTED' || v === 'DOC_REFUSED' ? v : null);

const capInt = (v: unknown, d: number, min: number, max: number): number => {
  const n = finiteNum(v);
  return n === null ? d : Math.min(max, Math.max(min, Math.floor(n)));
};

/**
 * كتلة docs في /status. خادمٌ أقدم لا يرسلها ⇒ مطفأة (📎 لا يظهر: الخادم القديم يُسقط docIds بصمت). والتفعيل يشترط
 * canPost أيضاً — الخادم يحسبه كذلك، والواجهة لا تعرض رفعاً لا يُرحَّل منه شيء. السقوف محصورة: لا تزيد الصورة على ٤٠٠KB
 * (D8) ولا المستندات على ٣ في الرسالة مهما قال الخادم.
 */
export function normalizeDocsStatus(raw: unknown, canPost: boolean): AiDocsStatus {
  const d = obj(raw);
  const caps = obj(d.caps);
  const enabled = d.enabled === true && canPost === true;
  return {
    enabled,
    canUpload: enabled && d.canUpload !== false,
    caps: {
      imageBytes: capInt(caps.imageBytes, DOC_IMAGE_MAX_BYTES, 16 * 1024, DOC_IMAGE_MAX_BYTES),
      pdfBytes: capInt(caps.pdfBytes, DOC_PDF_MAX_BYTES, 64 * 1024, 20 * 1024 * 1024),
      perMessage: capInt(caps.perMessage, MAX_DOCS_PER_MESSAGE, 1, MAX_DOCS_PER_MESSAGE),
    },
    assetThreshold: Math.max(0, finiteNum(d.assetThreshold) ?? DEFAULT_ASSET_THRESHOLD),
    retentionDays: capInt(d.retentionDays, DEFAULT_DOC_RETENTION_DAYS, 1, 3650),
  };
}

/** معرّفات مستندات رسالة: UUID وحده، بلا تكرار، ٣ على الأكثر */
export function normalizeDocIds(v: unknown, max = MAX_DOCS_PER_MESSAGE): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (!isUuidStr(x)) continue;
    const id = x.toLowerCase();
    if (!out.includes(id)) out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

/** docConfirm صالح بشكله (الخادم يحكم بالباقي) — مفاتيح اختيارية تُضاف بوجودها وحده؛ شكلٌ ناقص ⇒ null */
export function normalizeDocConfirm(v: unknown): AcctDocConfirm | null {
  const c = obj(v);
  const treatment = asTreatment(c.treatment);
  const paidFrom = asPaidFrom(c.paidFrom);
  if (!isUuidStr(c.docId) || !treatment || !paidFrom) return null;
  if (typeof c.accountCode !== 'string' || !ACCOUNT_CODE_RE.test(c.accountCode)) return null;
  const months = c.months == null ? null : posInt(c.months, PREPAID_MAX_MONTHS);
  if (c.months != null && months === null) return null;
  if (treatment === 'PREPAID' && months === null) return null;
  if (c.date != null && !isDocDay(c.date)) return null;
  const payCode = typeof c.paidFromAccountCode === 'string' && ACCOUNT_CODE_RE.test(c.paidFromAccountCode) ? c.paidFromAccountCode : null;
  return {
    docId: c.docId.toLowerCase(),
    treatment,
    accountCode: c.accountCode,
    paidFrom,
    ...(payCode && paidFrom !== 'payable' ? { paidFromAccountCode: payCode } : {}),
    ...(months !== null ? { months } : {}),
    ...(isDocDay(c.date) ? { date: c.date } : {}),
    ...(c.confirmedNotDuplicate === true ? { confirmedNotDuplicate: true } : {}),
  };
}

function normalizePrepaid(v: unknown): AiPrepaidProgress | null {
  const p = obj(v);
  const months = posInt(p.months, 1200);
  const raw = finiteNum(p.posted) ?? finiteNum(p.postedMonths);
  if (months === null || raw === null || raw < 0) return null;
  const posted = Math.min(months, Math.floor(raw));
  return {
    posted,
    months,
    postedMonths: posted,
    stopped: p.stopped === true,
    nextDate: asDay(p.nextDate),
    lockedMonths: (Array.isArray(p.lockedMonths) ? p.lockedMonths : [])
      .filter((m): m is string => typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m)).slice(0, 24),
  };
}

/** حقول المستند على القيد (PostedMove في الخادم) بعد التطبيع: بوجودها الصالح وحده */
export interface PostedDocFields {
  docId?: string;
  hasAttachment?: boolean;
  /** قسط إطفاء ⇐ صفّ قيد الدفع المقدّم */
  parentPostId?: string;
  prepaid?: AiPrepaidProgress;
  amort?: AiAmortRef;
  /**
   * تنبيهات الخادم على القيد (عُكس قيد الدفع بعد أقساط حيّة، فترة مقفلة تُخطّيت، أصلٌ يحتاج إهلاكاً) — الخادم يرسل warning
   * نصّاً واحداً (وwarnings قائمةً إن أرسلها)، فتُجمع هنا قائمةً بلا تكرار.
   */
  warnings?: string[];
}

/**
 * حقول المستند على القيد المرحّل (PostedMove في المحادثة وقائمة القيود) — الحاضر الصالح وحده، فقيدٌ بلا مستند يبقى بمفاتيحه
 * القديمة حرفاً بحرف (normalizePostedMove في posts/aiPosts.ts يبسطها: `...postedDocFields(x)`).
 */
export function postedDocFields(raw: unknown): PostedDocFields {
  const m = obj(raw);
  const out: PostedDocFields = {};
  if (isUuidStr(m.docId)) out.docId = m.docId;
  if (typeof m.hasAttachment === 'boolean') out.hasAttachment = m.hasAttachment;
  if (typeof m.parentPostId === 'string' && /^[0-9A-Za-z-]{1,64}$/.test(m.parentPostId)) out.parentPostId = m.parentPostId;
  const prepaid = m.prepaid ? normalizePrepaid(m.prepaid) : null;
  if (prepaid) out.prepaid = prepaid;
  const a = obj(m.amort);
  const idx = posInt(a.index, 1200);
  const of = posInt(a.months, 1200);
  if (typeof a.parentPostId === 'string' && /^[0-9A-Za-z-]{1,64}$/.test(a.parentPostId) && idx !== null && of !== null && idx <= of) {
    out.amort = { parentPostId: a.parentPostId, index: idx, months: of };
  }
  const warnings: string[] = [];
  for (const w of [m.warning, ...(Array.isArray(m.warnings) ? m.warnings.slice(0, 10) : [])]) {
    const s = cleanDocText(w, 400);
    if (s && !warnings.includes(s)) warnings.push(s);
  }
  if (warnings.length) out.warnings = warnings;
  return out;
}

// ═══ التسميات ═══

/** اسم نوع المستند — كل عبارةٍ حرفيةٌ داخل استدعاء tr فيراها فاحص الترجمات */
export function docTypeLabel(t: unknown, tr: Tr = idTr): string {
  switch (t) {
    case 'TAX_INVOICE': return tr('فاتورة ضريبية');
    case 'SIMPLIFIED_INVOICE': return tr('فاتورة ضريبية مبسطة');
    case 'LEASE_CONTRACT': return tr('عقد إيجار');
    case 'MAINTENANCE_INVOICE': return tr('فاتورة صيانة');
    case 'UTILITY_BILL': return tr('فاتورة كهرباء أو ماء أو اتصالات');
    case 'RECEIPT': return tr('إيصال دفع');
    case 'OTHER': return tr('مستند آخر');
    default: return tr('مستند');
  }
}

/**
 * D3: الأصل يُسجَّل بلا إهلاك — تقولها البطاقة والنصّ صراحةً. العبارة نفسها حرفاً بحرف في الخادم (ASSET_DEPRECIATION_NOTE في
 * posting.ts) يرسلها تنبيهاً على قيد الأصل في قائمة القيود — فتعرفها بطاقة القيد (moveNotes) ولا تكرّرها.
 */
export const ASSET_DEPRECIATION_NOTE = 'يحتاج إهلاكاً يسجّله المحاسب';

/**
 * نصّ ملاحظة الفحص — رمزٌ لا نعرفه ⇒ عبارة عامة. `details` تفاصيل الفحص من الخادم: MONTHS_INVALID بسبب REFERRED (أكثر من
 * ٢٤ شهراً) يقول إن المستند للمحاسب البشري — لا «اكتب عدداً أصغر» — وبسبب MISSING يطلب الأشهر أو فترة الخدمة.
 */
export function docCheckText(code: unknown, tr: Tr = idTr, details?: Readonly<Record<string, string>> | null): string {
  if (code === 'MONTHS_INVALID' && details?.reason === 'REFERRED') return docRefusalText({ code: 'DOC_TREATMENT_REFERRED', message: '' }, tr);
  if (code === 'MONTHS_INVALID' && details?.reason === 'MISSING') {
    return tr('أدخل عدد أشهر الإطفاء (من 1 إلى {n}) أو فترة الخدمة').replace('{n}', String(PREPAID_MAX_MONTHS));
  }
  switch (code) {
    case 'TOTAL_MISSING': return tr('أدخل إجمالي المستند');
    case 'DATE_MISSING': return tr('أدخل تاريخ المستند');
    case 'SUM_MISMATCH': return tr('المبلغ قبل الضريبة مع الضريبة لا يساوي الإجمالي');
    case 'VAT_RATE_ODD': return tr('نسبة الضريبة غير معتادة — راجع المبلغين');
    case 'VAT_NO_TAX_NUMBER': return tr('لا رقم ضريبياً صحيحاً للمورد — الضريبة تُحمَّل على التكلفة ولا تُخصم');
    case 'VAT_BLOCKED_CATEGORY': return tr('ضريبة الضيافة والترفيه لا تُخصم — تُحمَّل على المصروف');
    case 'BUYER_OTHER': return tr('الرقم الضريبي للمشتري ليس رقم شركتك');
    case 'CURRENCY_MISMATCH': return tr('عملة المستند تختلف عن عملة الشركة');
    case 'DATE_FUTURE': return tr('تاريخ المستند في المستقبل');
    case 'DATE_TOO_OLD': return tr('تاريخ المستند أقدم من سنة — سجّله يدوياً من الدفاتر');
    case 'HIJRI_DATE': return tr('التاريخ هجري — أدخل التاريخ الميلادي');
    case 'QR_MISMATCH': return tr('الأرقام لا تطابق رمز QR الزكوي في الفاتورة');
    case 'QR_INVALID': return tr('تعذرت قراءة رمز QR الزكوي — أدخل البيانات يدوياً');
    case 'NOT_A_PAYMENT': return tr('العقد وحده ليس دفعة — أدخل المبلغ المدفوع واختر من أي حساب دُفع');
    case 'DUPLICATE_SUSPECT': return tr('قد يكون هذا المستند مسجلاً من قبل');
    case 'VAT_NO_BOX': return tr('دليل حساباتك بلا ضريبة مدخلات — تُحمَّل الضريبة على التكلفة');
    case 'FILE_GONE': return tr('ملف المستند لم يعد موجوداً — ارفعه من جديد');
    case 'MONTHS_INVALID': return tr('عدد أشهر الإطفاء من 1 إلى {n}').replace('{n}', String(PREPAID_MAX_MONTHS));
    case 'NEEDS_DEPRECIATION': return tr('يحتاج إهلاكاً يسجّله المحاسب');
    default: return tr('راجع بيانات المستند');
  }
}

/**
 * رقم القيد من تفاصيل رفضٍ أو خطأ — رفض الترحيل يرسله move_number (posting.ts وdocuments/post.ts) وخطأ ٤٠٩ في مسارات
 * المستندات moveNumber (documents/store.ts): يُقرأ الاثنان.
 */
export function refusalMoveNumber(details: Record<string, unknown> | null | undefined): string {
  const d = details ?? {};
  const v = typeof d.moveNumber === 'string' && d.moveNumber.trim() ? d.moveNumber : d.move_number;
  return typeof v === 'string' ? v.trim().slice(0, 60) : '';
}

/** رفض دورة التأكيد ⇒ عبارة مترجمة؛ رمزٌ لا نعرفه ⇒ رسالة الخادم (عربية) أو عبارة عامة */
export function docRefusalText(r: DocRefusal | null | undefined, tr: Tr = idTr): string {
  const moveNumber = refusalMoveNumber(r?.details);
  switch (r?.code) {
    case 'DOC_NOT_FOUND': return tr('المستند غير موجود أو حُذف');
    case 'DOC_NOT_ATTACHED': return tr('المستند ليس مرفقاً بهذه الرسالة');
    case 'DOC_NOT_READY': return tr('بيانات المستند غير مكتملة — أكملها في البطاقة');
    case 'DOC_NEEDS_REVIEW': return tr('صحّح ملاحظات البطاقة قبل التسجيل');
    case 'DOC_TOTAL_NOT_CONFIRMED':
    case 'ACCOUNT_NOT_IN_MESSAGE':
    case 'PAYMENT_SOURCE_NOT_IN_MESSAGE':
      return tr('رسالة التأكيد لا تطابق بيانات البطاقة — اضغط «سجّل القيد» من البطاقة');
    case 'DOC_CURRENCY_MISMATCH': return tr('عملة المستند تختلف عن عملة الشركة');
    case 'DOC_ALREADY_POSTED':
      return moveNumber
        ? tr('المستند مسجّل في القيد {n} — اعكسه أولاً لإعادة تسجيله').replace('{n}', moveNumber)
        : tr('المستند مسجّل في قيد قائم — اعكسه أولاً لإعادة تسجيله');
    case 'DOC_POSSIBLE_DUPLICATE': return tr('يبدو المستند مكرراً — إن لم يكن فاضغط «ليست مكررة — سجّلها»');
    case 'DOC_FILE_GONE': return tr('ملف المستند لم يعد موجوداً — ارفعه من جديد');
    case 'TREATMENT_NOT_ALLOWED': return tr('هذه المعالجة غير متاحة لهذا المستند');
    case 'ASSET_BELOW_THRESHOLD': return tr('المبلغ دون حد الرسملة — يُسجَّل مصروفاً');
    case 'PREPAID_MONTHS_INVALID': return tr('عدد أشهر الإطفاء من 1 إلى {n}').replace('{n}', String(PREPAID_MAX_MONTHS));
    case 'DOC_TREATMENT_REFERRED': return tr('هذا المستند يحتاج المحاسب البشري (أرض أو مبنى أو مدة أطول من 24 شهراً)');
    case 'DOC_IS_INVENTORY': return tr('هذه بضاعة للمخزون — سجّلها من مشتريات المستودع');
    case 'DOCS_DISABLED': return tr('رفع المستندات غير متاح لحسابك الآن');
    case 'NOT_A_PAYMENT': return tr('العقد وحده ليس دفعة — أدخل المبلغ المدفوع واختر من أي حساب دُفع');
    case 'LEDGER_PERIOD_LOCKED': return tr('تاريخ المستند ضمن فترة مقفلة — سجّله بتاريخ اليوم');
    case 'DATE_FUTURE': return tr('تاريخ المستند في المستقبل');
    case 'DATE_TOO_OLD': return tr('تاريخ المستند أقدم من سنة — سجّله يدوياً من الدفاتر');
    default: return r?.message || tr('تعذر تسجيل المستند');
  }
}

// ═══ تأكيد الترحيل: النصّ المرئي وdocConfirm ═══

/** اختيار المستخدم في البطاقة */
export interface DocConfirmChoice {
  treatment: AcctDocTreatment;
  /**
   * EXPENSE/ASSET: حساب المصروف أو الأصل. PREPAID: حساب المصروف الذي يُطفأ عليه (621004 للإيجار…) — وحساب المدفوع مقدماً
   * يُشتقّ منه (prepaidAccountFor)؛ ورمزٌ من 115001/115002 يُقبل هو حساب المدفوع مقدماً نفسه. النصّ يذكر ما يُعرف منهما معاً.
   */
  accountCode: string;
  paidFrom: AcctPaidFrom;
  /** حساب نقدية/بنك بعينه من payOptions (غائب ⇒ أول خيارٍ لطريقة الدفع) */
  paidFromAccountCode?: string | null;
  /** PREPAID: ١..٢٤ (غائب ⇒ اقتراح الخادم ثم الحقائق) */
  months?: number | null;
  /** تاريخ قيدٍ غير تاريخ المستند («سجّل بتاريخ اليوم» بعد فترةٍ مقفلة) — يُذكر في النصّ */
  date?: string | null;
  /** «ليست مكررة — سجّلها» */
  confirmedNotDuplicate?: boolean;
}

export interface DocConfirmOptions {
  /** «إزالة الضريبة» (isTaxOff): لا ذكر للضريبة في النصّ */
  taxOff?: boolean;
  /** منازل عملة الشركة (٢ افتراضاً، ٣ للدينار) */
  decimals?: number;
}

export type DocConfirmProblem =
  | 'POSTED' | 'NO_FACTS' | 'TOTAL_MISSING' | 'BLOCKED' | 'DATE_MISSING' | 'TREATMENT' | 'ACCOUNT' | 'PAY' | 'NOT_A_PAYMENT'
  | 'MONTHS' | 'DUPLICATE' | 'ALREADY_POSTED';

const blockingChecks = (v: Pick<AcctDocView, 'checks'>) => v.checks.filter((c) => c.severity === 'block');

/** خيار الدفع المختار: من payOptions الخادم، وبلا خيارات أصلاً ⇒ رموز الدليل الافتراضية */
export function resolvePayOption(v: Pick<AcctDocView, 'payOptions'>, paidFrom: AcctPaidFrom, code?: string | null): AcctPayOption | null {
  const same = v.payOptions.filter((o) => o.paidFrom === paidFrom);
  if (same.length) return (code ? same.find((o) => o.code === code) : same[0]) ?? null;
  if (v.payOptions.length && paidFrom !== 'payable') return null;
  const c = DEFAULT_PAY_CODES[paidFrom];
  if (code && code !== c) return null;
  return { paidFrom, code: c, name: CHART_NAMES_AR[c] ?? '' };
}

const accountNameOf = (v: Pick<AcctDocView, 'accountOptions' | 'suggestion'>, code: string): string =>
  v.accountOptions.find((o) => o.code === code)?.name
  || (v.suggestion?.accountCode === code ? v.suggestion.accountName : '')
  || CHART_NAMES_AR[code] || '';

const monthsOf = (v: Pick<AcctDocView, 'suggestion' | 'facts'>, c: DocConfirmChoice): number | null =>
  posInt(c.months, PREPAID_MAX_MONTHS) ?? (c.months == null ? posInt(v.suggestion?.months, PREPAID_MAX_MONTHS) ?? posInt(v.facts?.months, PREPAID_MAX_MONTHS) : null);

/**
 * مصروف الإطفاء الشهري لاختيار «مدفوع مقدماً» (Dr هذا / Cr 115002|115001) — أو null حين لا يُعرف هنا:
 *  - المختار حساب مصروف (لا 115001/115002) ⇒ هو نفسه مصروف الإطفاء (والمدفوع مقدماً يُشتق منه — prepaidAccountFor).
 *  - المختار 115001/115002 ⇒ ما يرسله الخادم مع الخيار أو مع الاقتراح المطابق (amortizationCode — amortizationAccountFor).
 *  - وإلا 115002 بمرآة amortizationAccountFor الحتمية: سكن الموظفين (تصنيفه صراحةً، أو عقدٌ سكني بلا تصنيف مصروف) 621005،
 *    وغيره الإيجار 621004 — بشرط أن يكون في حسابات المصروف التي أرسلها الخادم من دليل الشركة، وإلا «متنوعة» 621016 كالخادم.
 *    و115001 يتبع تصنيفاً قد يُستنتج من نصّ المستند في الخادم وحده ⇒ null (البطاقة لا تخمّن).
 */
export function amortizationOf(
  v: Pick<AcctDocView, 'accountOptions' | 'suggestion' | 'facts'>,
  c: Pick<DocConfirmChoice, 'treatment' | 'accountCode'>,
): { code: string; name: string } | null {
  if (c.treatment !== 'PREPAID' || !c.accountCode) return null;
  const code = c.accountCode;
  if (!PREPAID_ACCOUNT_CODES.includes(code)) return { code, name: accountNameOf(v, code) };
  const opt = v.accountOptions.find((o) => o.treatment === 'PREPAID' && o.code === code && o.amortizationCode);
  const sug = v.suggestion?.treatment === 'PREPAID' && v.suggestion.accountCode === code && v.suggestion.amortizationCode ? v.suggestion : null;
  const from = opt ?? sug;
  if (from?.amortizationCode) return { code: from.amortizationCode, name: from.amortizationName || accountNameOf(v, from.amortizationCode) };
  if (code !== '115002') return null;
  const f = v.facts;
  const staff = f?.categoryHint === 'staff_housing'
    || (!isExpenseHint(f?.categoryHint) && f?.docType === 'LEASE_CONTRACT' && f.lease?.residential === true);
  const expense = new Map(v.accountOptions.filter((o) => o.treatment === 'EXPENSE').map((o) => [o.code, o.name] as const));
  for (const k of [staff ? STAFF_HOUSING_CODE : RENT_EXPENSE_CODE, MISC_EXPENSE_CODE]) {
    if (expense.has(k)) return { code: k, name: expense.get(k) || accountNameOf(v, k) };
  }
  return null;
}

/** ما يمنع التأكيد الآن (البطاقة تعطّل الزر وتقول السبب) — null = جاهز */
export function docConfirmProblem(v: AcctDocView, c: DocConfirmChoice): DocConfirmProblem | null {
  if (v.posted?.live) return 'POSTED';
  if (!v.facts) return 'NO_FACTS';
  const total = decToMilli(v.facts.total);
  if (total === null || total <= 0n) return 'TOTAL_MISSING';
  if (blockingChecks(v).length) return 'BLOCKED';
  const date = c.date ?? v.facts.issueDate;
  if (!isDocDay(date)) return 'DATE_MISSING';
  if (!TREATMENT_SET.has(c.treatment)) return 'TREATMENT';
  if (typeof c.accountCode !== 'string' || !ACCOUNT_CODE_RE.test(c.accountCode)) return 'ACCOUNT';
  if (c.treatment === 'ASSET' && !ASSET_ACCOUNT_CODES.includes(c.accountCode)) return 'ACCOUNT';
  if (!PAID_FROM_SET.has(c.paidFrom) || !resolvePayOption(v, c.paidFrom, c.paidFromAccountCode)) return 'PAY';
  // D2: العقد وحده ليس دفعاً ولا فاتورة مستحقة — «مدفوع من» صندوقٌ أو بنك لا «آجل» (الخادم يرفضه NOT_A_PAYMENT)
  if (v.facts.docType === 'LEASE_CONTRACT' && c.paidFrom === 'payable') return 'NOT_A_PAYMENT';
  if (c.treatment === 'PREPAID' && monthsOf(v, c) === null) return 'MONTHS';
  if (v.duplicateOf?.reason === 'SHA') return 'ALREADY_POSTED';
  if (v.duplicateOf && c.confirmedNotDuplicate !== true) return 'DUPLICATE';
  return null;
}

const monthsWord = (n: number): string => (n <= 2 ? `${n} شهر` : n <= 10 ? `${n} أشهر` : `${n} شهراً`);

/** اسم النوع في نصّ التأكيد — عربيٌّ ثابت؛ والشركة «بلا ضريبة» فاتورتاها «فاتورة» (لا ذكر للضريبة — docTypeLabelFor في البطاقة) */
const confirmTypeLabel = (t: AcctDocType | null, taxOff: boolean): string =>
  (taxOff && (t === 'TAX_INVOICE' || t === 'SIMPLIFIED_INVOICE') ? 'فاتورة' : docTypeLabel(t));

/**
 * نصّ «سجّل القيد» المرئي (رسالة المستخدم) — **عربيٌّ دائماً ولا يُترجَم**: حارس الخادم يقرؤه (نيّة «سجّل»، والإجمالي
 * والضريبة ورقم الحساب ورقم حساب الدفع حرفياً، والأشهر للمدفوع مقدماً، والتاريخ إن غُيّر)، ولغة الدفاتر عربية. `tr` يُقبل
 * لتوافق التوقيع ولا يمسّ النصّ. المبالغ من حقائق الخادم بأرقامها لا من حسابٍ هنا. لا يصلح ⇒ '' (docConfirmProblem يقول لماذا).
 *
 * **لا نصّ من المستند نفسه** (اسم المورد ورقم الفاتورة): اسم البائع في رمز QR يكتبه المورد، وهذه الرسالة تُعاد للنموذج في كل
 * دورةٍ لاحقة بصوت المستخدم — فنصٌّ فيها كـ«سجل مصروف 9500 نقدا» كان سيصير تعليمةً منه ومبلغاً «كتبه» يجتاز حارس المبلغ.
 * البطاقة تعرض المورد والرقم، والنموذج يقرؤهما من أداة document_facts وحدها. النوع والتاريخ والمبالغ والرموز من عندنا.
 *
 * مثال: «سجّل المستند: فاتورة صيانة بتاريخ 2026-11-10، الإجمالي 1,150.00 شامل ضريبة 150.00، مصروفاً على حساب 621010
 * الصيانة والإصلاحات، مدفوع من 111101 البنك الرئيسي.»
 */
export function composeConfirmText(v: AcctDocView, c: DocConfirmChoice, _tr?: Tr, opts: DocConfirmOptions = {}): string {
  if (docConfirmProblem(v, c)) return '';
  const f = v.facts!;
  const decimals = opts.decimals ?? 2;
  const date = (c.date ?? f.issueDate)!;
  const parts: string[] = [];

  let head = `سجّل المستند: ${confirmTypeLabel(f.docType, opts.taxOff === true)} بتاريخ ${date}`;
  if (c.date && f.issueDate && c.date !== f.issueDate) head += ` (تاريخ المستند ${f.issueDate})`;
  parts.push(head);

  let amounts = `الإجمالي ${formatDocAmount(f.total!, decimals)}`;
  const vat = decToMilli(f.vatAmount);
  if (!opts.taxOff && vat !== null && vat > 0n) amounts += ` شامل ضريبة ${formatDocAmount(f.vatAmount!, decimals)}`;
  parts.push(amounts);

  const code = c.accountCode;
  const name = accountNameOf(v, code);
  const acct = (k: string, n: string) => (n ? `${k} ${n}` : k);
  if (c.treatment === 'EXPENSE') {
    parts.push(`مصروفاً على حساب ${acct(code, name)}`);
  } else if (c.treatment === 'ASSET') {
    parts.push(`أصلاً ثابتاً على حساب ${acct(code, name)} (${ASSET_DEPRECIATION_NOTE})`);
  } else {
    const months = monthsOf(v, c)!;
    const amort = amortizationOf(v, c);
    const pre = PREPAID_ACCOUNT_CODES.includes(code) ? code : prepaidAccountFor(code);
    const preName = pre === code ? name : accountNameOf(v, pre);
    parts.push(amort
      ? `مدفوعاً مقدماً على حساب ${acct(pre, preName)} يُطفأ على حساب ${acct(amort.code, amort.name)} خلال ${monthsWord(months)}`
      : `مدفوعاً مقدماً على حساب ${acct(pre, preName)} يُطفأ خلال ${monthsWord(months)}`);
  }

  const pay = resolvePayOption(v, c.paidFrom, c.paidFromAccountCode)!;
  parts.push(c.paidFrom === 'payable'
    ? `غير مدفوع: على حساب ${acct(pay.code, pay.name)}`
    : `مدفوع من ${acct(pay.code, pay.name)}`);
  if (c.confirmedNotDuplicate === true && v.duplicateOf) parts.push('ليست مكررة');
  return `${parts.join('، ')}.`;
}

/** docConfirm من اختيار البطاقة — null إن لم يصلح التأكيد */
export function buildDocConfirm(v: AcctDocView, c: DocConfirmChoice): AcctDocConfirm | null {
  if (docConfirmProblem(v, c)) return null;
  const pay = resolvePayOption(v, c.paidFrom, c.paidFromAccountCode)!;
  return normalizeDocConfirm({
    docId: v.id,
    treatment: c.treatment,
    accountCode: c.accountCode,
    paidFrom: c.paidFrom,
    paidFromAccountCode: c.paidFrom === 'payable' ? null : pay.code,
    months: c.treatment === 'PREPAID' ? monthsOf(v, c) : null,
    date: c.date && c.date !== v.facts?.issueDate ? c.date : null,
    confirmedNotDuplicate: c.confirmedNotDuplicate === true && !!v.duplicateOf,
  });
}

/**
 * أجزاء رسالة التأكيد كاملةً لمدخلٍ جديد في المحادثة: النصّ المرئي + docIds:[id] + docConfirm — مصدرٌ واحد فلا يفترق النصّ
 * عن البنية (buildChatBody يرفض docConfirm لمستندٍ ليس في docIds الرسالة).
 */
export function docConfirmMessage(v: AcctDocView, c: DocConfirmChoice, tr?: Tr, opts: DocConfirmOptions = {}):
  { text: string; docIds: string[]; docConfirm: AcctDocConfirm } | null {
  const docConfirm = buildDocConfirm(v, c);
  const text = composeConfirmText(v, c, tr, opts);
  if (!docConfirm || !text) return null;
  return { text, docIds: [docConfirm.docId], docConfirm };
}

// ═══ تصحيح الحقائق يدوياً (PATCH) ═══

export interface DocFactsForm {
  docType?: AcctDocType | null;
  vendorName?: string;
  vendorVat?: string;
  invoiceNo?: string;
  issueDate?: string;
  periodFrom?: string;
  periodTo?: string;
  subtotal?: string;
  vatAmount?: string;
  total?: string;
  months?: string | number | null;
}
export type DocFormField = keyof DocFactsForm;
export type DocFormProblem = 'AMOUNT' | 'DATE' | 'VAT_NO' | 'MONTHS' | 'PERIOD' | 'TYPE';

/**
 * نموذج البطاقة ⇒ جسم PATCH: الحقل الغائب لا يُرسَل، والفارغ null (يمحوه)، والمبالغ قانونية بمنازل العملة (parseAmountInput)،
 * والتواريخ ميلادية YYYY-MM-DD، والرقم الضريبي أرقامٌ لاتينية بلا مسافات. أول مشكلة ⇒ {field, problem} ولا جسم.
 */
export function buildDocPatch(form: DocFactsForm, decimals = 2):
  { ok: true; patch: AcctDocPatch } | { ok: false; field: DocFormField; problem: DocFormProblem } {
  const patch: AcctDocPatch = {};
  const blank = (s: unknown) => s == null || (typeof s === 'string' && !s.trim());
  if (form.docType !== undefined) {
    if (form.docType !== null && !DOC_TYPE_SET.has(form.docType)) return { ok: false, field: 'docType', problem: 'TYPE' };
    patch.docType = form.docType;
  }
  for (const k of ['vendorName', 'invoiceNo'] as const) {
    if (form[k] === undefined) continue;
    patch[k] = blank(form[k]) ? null : cleanDocText(form[k], k === 'invoiceNo' ? 60 : 120) || null;
  }
  if (form.vendorVat !== undefined) {
    const s = latinDigits(String(form.vendorVat ?? '')).replace(/[\s-]/g, '');
    if (s && !/^[0-9A-Za-z]{1,20}$/.test(s)) return { ok: false, field: 'vendorVat', problem: 'VAT_NO' };
    patch.vendorVat = s || null;
  }
  for (const k of ['issueDate', 'periodFrom', 'periodTo'] as const) {
    if (form[k] === undefined) continue;
    const s = latinDigits(String(form[k] ?? '')).trim();
    if (s && !isDocDay(s)) return { ok: false, field: k, problem: 'DATE' };
    patch[k] = s || null;
  }
  if (patch.periodFrom && patch.periodTo && patch.periodFrom > patch.periodTo) return { ok: false, field: 'periodTo', problem: 'PERIOD' };
  for (const k of ['subtotal', 'vatAmount', 'total'] as const) {
    if (form[k] === undefined) continue;
    if (blank(form[k])) { patch[k] = null; continue; }
    const a = parseAmountInput(form[k], decimals);
    if (a === null || (k === 'total' && decToMilli(a) === 0n)) return { ok: false, field: k, problem: 'AMOUNT' };
    patch[k] = a;
  }
  if (form.months !== undefined) {
    if (blank(form.months)) patch.months = null;
    else {
      const n = posInt(typeof form.months === 'string' ? latinDigits(form.months) : form.months, 600);
      if (n === null) return { ok: false, field: 'months', problem: 'MONTHS' };
      patch.months = n;
    }
  }
  return { ok: true, patch };
}

export function docFormProblemText(p: DocFormProblem, tr: Tr = idTr): string {
  switch (p) {
    case 'AMOUNT': return tr('اكتب المبلغ بالأرقام والنقطة للكسور');
    case 'DATE': return tr('التاريخ بصيغة سنة-شهر-يوم');
    case 'VAT_NO': return tr('الرقم الضريبي أرقام وحروف لاتينية فقط');
    case 'MONTHS': return tr('عدد الأشهر رقم صحيح من 1 فأكثر');
    case 'PERIOD': return tr('بداية الفترة بعد نهايتها');
    default: return tr('راجع بيانات المستند');
  }
}

// ═══ تجهيز الملف في الجهاز ═══

/** النوع من البايتات لا من الاسم ولا من النوع المعلَن (كـsniffAttachmentMime في الخادم) */
export function sniffDocMime(head: Uint8Array): DocMime | null {
  if (head.length >= 5 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d) return 'application/pdf';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (head.length >= 8 && png.every((b, i) => head[i] === b)) return 'image/png';
  return null;
}

/** صورةٌ يُعاد ترميزها (WebP وHEIC الآيفون وGIF…) — بالنوع المعلَن أو الامتداد، والفكّ نفسه يحكم بعدها */
export function isImageLike(f: { type?: string; name?: string }): boolean {
  if (typeof f.type === 'string' && f.type.startsWith('image/')) return true;
  return typeof f.name === 'string' && /\.(?:jpe?g|png|webp|heic|heif|gif|bmp|avif)$/i.test(f.name);
}

/** اسم الملف للرفع: بلا مسار ولا محارف تحكّم، مقصوص، وامتداده يطابق النوع المفحوص */
export function sanitizeDocFileName(name: unknown, mime?: DocMime): string {
  const raw = typeof name === 'string' ? name.split(/[\\/]/).pop() ?? '' : '';
  let s = cleanDocText(raw, 120);
  const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : '';
  if (ext) {
    const m = /\.([A-Za-z0-9]{1,5})$/.exec(s);
    const cur = m?.[1].toLowerCase();
    const ok = cur === ext || (ext === 'jpg' && cur === 'jpeg');
    if (!ok) s = `${(m ? s.slice(0, m.index) : s).trim().slice(0, 115) || 'document'}.${ext}`;
  }
  return s || 'document';
}

export type DocFileProblemCode = 'TYPE' | 'EMPTY' | 'PDF_TOO_BIG' | 'IMAGE_TOO_BIG' | 'READ' | 'TOO_MANY';
export interface DocFileProblem { code: DocFileProblemCode; n?: number }

export interface PreparedDocFile {
  blob: Blob;
  mime: DocMime;
  name: string;
  size: number;
  kind: 'pdf' | 'image';
  /** أُعيد ترميزها في الجهاز (ضغطاً أو تحويلاً إلى JPEG) */
  reencoded: boolean;
}
export type PrepareResult = { ok: true; file: PreparedDocFile } | { ok: false; problem: DocFileProblem };

/** ضاغط صورة ⇒ JPEG (الافتراضي canvasCompress في المتصفّح؛ الاختبارات تحقن بديلاً) */
export type ImageCompressor = (image: Blob, pass: { maxDim: number; quality: number }) => Promise<Blob>;

/** أوّل بايتات الملف — arrayBuffer وإلا FileReader (سفاري الأقدم) */
async function headBytes(b: Blob, n = 16): Promise<Uint8Array> {
  const part = b.slice(0, n);
  if (typeof part.arrayBuffer === 'function') return new Uint8Array(await part.arrayBuffer());
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(new Error('read'));
    r.readAsArrayBuffer(part);
  });
}

/**
 * ضغط الصورة في المتصفّح: تصغيرٌ إلى maxDim ثم JPEG بالجودة المعطاة على خلفية بيضاء (PNG شفافة كانت تصير سوداء فيضيع نصّ
 * الفاتورة). اتجاه EXIF تطبّقه المتصفّحات الحديثة عند الرسم.
 */
export const canvasCompress: ImageCompressor = (image, pass) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(image);
  const img = new Image();
  const done = (fn: () => void) => { URL.revokeObjectURL(url); fn(); };
  img.onload = () => {
    try {
      const w0 = img.naturalWidth || img.width;
      const h0 = img.naturalHeight || img.height;
      if (!w0 || !h0) throw new Error('img');
      const s = Math.min(1, pass.maxDim / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * s));
      const h = Math.max(1, Math.round(h0 * s));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((b) => done(() => (b ? resolve(b) : reject(new Error('blob')))), 'image/jpeg', pass.quality);
    } catch (e) {
      done(() => reject(e));
    }
  };
  img.onerror = () => done(() => reject(new Error('img')));
  img.src = url;
});

/**
 * ملفٌّ من الجهاز ⇒ ملفٌّ جاهز للرفع أو مشكلته. النوع بالبايتات: PDF يمرّ كما هو حتى سقفه، وJPEG/PNG تحت سقف الصورة يمرّان
 * بلا لمس (رمز QR أوضح)، وما سواهما من الصور (أكبر من السقف، أو WebP/HEIC) يُضغط JPEG بمرّتين — الأولى ثم الأصغر — قبل أن
 * يُقال «أكبر من المسموح». ملفٌّ لا يُفكّ (HEIC في كروم مثلاً) ⇒ READ.
 */
export async function prepareFile(
  file: Blob & { name?: string },
  opts: { caps?: Partial<DocCaps>; compress?: ImageCompressor } = {},
): Promise<PrepareResult> {
  const caps = { ...DEFAULT_DOC_CAPS, ...opts.caps };
  if (!file || file.size === 0) return { ok: false, problem: { code: 'EMPTY' } };
  let head: Uint8Array;
  try { head = await headBytes(file); } catch { return { ok: false, problem: { code: 'READ' } }; }
  const mime = sniffDocMime(head);
  const name = typeof file.name === 'string' ? file.name : '';

  if (mime === 'application/pdf') {
    if (file.size > caps.pdfBytes) return { ok: false, problem: { code: 'PDF_TOO_BIG', n: Math.max(1, Math.round(caps.pdfBytes / (1024 * 1024))) } };
    const blob = file.type === mime ? file : new Blob([file], { type: mime });
    return { ok: true, file: { blob, mime, name: sanitizeDocFileName(name, mime), size: file.size, kind: 'pdf', reencoded: false } };
  }
  if ((mime === 'image/jpeg' || mime === 'image/png') && file.size <= caps.imageBytes) {
    const blob = file.type === mime ? file : new Blob([file], { type: mime });
    return { ok: true, file: { blob, mime, name: sanitizeDocFileName(name, mime), size: file.size, kind: 'image', reencoded: false } };
  }
  if (!mime && !isImageLike(file)) return { ok: false, problem: { code: 'TYPE' } };

  const compress = opts.compress ?? canvasCompress;
  let decoded = false;
  for (const pass of DOC_IMAGE_PASSES) {
    let out: Blob;
    try { out = await compress(file, pass); } catch { continue; }
    decoded = true;
    let outMime: DocMime | null;
    try { outMime = sniffDocMime(await headBytes(out)); } catch { continue; }
    if (outMime !== 'image/jpeg' && outMime !== 'image/png') continue;
    if (out.size > 0 && out.size <= caps.imageBytes) {
      const blob = out.type === outMime ? out : new Blob([out], { type: outMime });
      return { ok: true, file: { blob, mime: outMime, name: sanitizeDocFileName(name, outMime), size: out.size, kind: 'image', reencoded: true } };
    }
  }
  return { ok: false, problem: { code: decoded ? 'IMAGE_TOO_BIG' : 'READ' } };
}

export function docFileProblemText(p: DocFileProblem, tr: Tr = idTr): string {
  switch (p.code) {
    case 'TYPE': return tr('نوع الملف غير مدعوم — PDF أو صورة فقط');
    case 'EMPTY': return tr('الملف فارغ');
    case 'PDF_TOO_BIG': return tr('ملف PDF أكبر من {n} ميغابايت').replace('{n}', String(p.n ?? Math.round(DOC_PDF_MAX_BYTES / (1024 * 1024))));
    case 'IMAGE_TOO_BIG': return tr('تعذر ضغط الصورة إلى الحجم المسموح');
    case 'TOO_MANY': return tr('حتى {n} مستندات في الرسالة الواحدة').replace('{n}', String(p.n ?? MAX_DOCS_PER_MESSAGE));
    default: return tr('تعذرت قراءة الملف');
  }
}

// ═══ رمز QR الزكوي في الجهاز ═══

/* تسلسلات الوسوم المقبولة كـdecodeQr في الخادم: المرحلة الأولى ١–٥، والثانية ١–٨ أو ١–٩ */
const QR_TAG_SEQS = [[1, 2, 3, 4, 5], [1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4, 5, 6, 7, 8, 9]];

function tlvValues(bin: string): { tag: number; value: string }[] | null {
  const out: { tag: number; value: string }[] = [];
  let i = 0;
  while (i < bin.length) {
    if (out.length >= 9 || i + 2 > bin.length) return null;
    const tag = bin.charCodeAt(i);
    const len = bin.charCodeAt(i + 1);
    if (tag === 0 || i + 2 + len > bin.length) return null;
    out.push({ tag, value: bin.slice(i + 2, i + 2 + len) });
    i += 2 + len;
  }
  return out;
}

const b64Decode = (s: string): string | null => {
  try { return atob(s); } catch { return null; }
};

/**
 * نصّ مقروء من صورة ⇒ نصّ QR زكوي يُرسَل للخادم، أو null: base64 قانوني (يعود كما هو بعد فكّه وترميزه) لا يتجاوز ٢٠٤٨ محرفاً،
 * وTLV صارم بوسوم ١–٥ (أو ١–٨/١–٩) — فرمز QR آخر في الصورة (رابط موقع مثلاً) لا يُرسَل. الخادم يفكّه ويتحقّق منه ثانيةً.
 */
export function zatcaQrCandidate(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > ZATCA_QR_MAX_LENGTH + 64) return null;
  let a = 0;
  let b = raw.length;
  const ws = (c: number) => c === 0x20 || c === 0x9 || c === 0xa || c === 0xd;
  while (a < b && ws(raw.charCodeAt(a))) a++;
  while (b > a && ws(raw.charCodeAt(b - 1))) b--;
  const s = raw.slice(a, b);
  if (!s || s.length > ZATCA_QR_MAX_LENGTH || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const bin = b64Decode(s);
  if (bin === null || btoa(bin) !== s) return null;
  const tags = tlvValues(bin);
  if (!tags) return null;
  const nums = tags.map((t) => t.tag);
  return QR_TAG_SEQS.some((seq) => seq.length === nums.length && seq.every((n, i) => nums[i] === n)) ? s : null;
}

/** فاكّ صورة ⇒ نصّ الرمز أو null (الافتراضي ZXing في المتصفّح؛ الاختبارات تحقن بديلاً) */
export type QrImageDecoder = (image: Blob) => Promise<string | null>;

export const QR_DECODE_TIMEOUT_MS = 8000;
/**
 * أطول ضلعٍ تُرسم عليه الصورة لفكّ الرمز (≈ ٤ ميغابكسل على الأكثر): صورة كاميرا الجوال ١٢–٤٨ ميغابكسل كانت تُرسم بحجمها
 * الطبيعي وتُحلَّل بـTRY_HARDER متزامناً فتجمّد الصفحة (المهلة لا تقطع عملاً متزامناً)، وفوق سقف لوحة الرسم في سفاري
 * (١٦٫٧ ميغابكسل — صور آيفون ٢٤ ميغابكسل) لا تُرسم أصلاً فيضيع الرمز بصمت. رمزٌ على فاتورة A4 يبقى بعدها ١٥٠ بكسلاً تقريباً.
 */
export const QR_DECODE_MAX_DIM = 2048;

/** أبعاد لوحة الفكّ: الصورة الصغيرة كما هي، والأكبر مصغّرةٌ بنسبتها إلى `maxDim` — أبعادٌ غير صالحة ⇒ null */
export function qrDecodeSize(w: number, h: number, maxDim = QR_DECODE_MAX_DIM): { w: number; h: number } | null {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const s = Math.min(1, maxDim / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => { t = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]).finally(() => { if (t) clearTimeout(t); });
}

/** تحميل الصورة من رابط Blob إلى عنصر (لا رسم) */
const loadImageEl = (url: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('img'));
  img.src = url;
});

/**
 * ZXing (المكتبة القائمة @zxing/browser) بتحميلٍ ديناميكي كماسح الباركود — لا يُثقل الحزمة لمن لا يرفع. الصورة تُرسم على
 * لوحةٍ محدودة (qrDecodeSize — خلفية بيضاء كالضغط) ثم تُفكّ منها، لا بحجمها الطبيعي (decodeFromImageUrl).
 */
export const zxingDecodeImage: QrImageDecoder = async (image) => {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  const [{ BrowserQRCodeReader }, { DecodeHintType }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
  const url = URL.createObjectURL(image);
  try {
    const img = await withTimeout(loadImageEl(url), QR_DECODE_TIMEOUT_MS);
    const size = qrDecodeSize(img.naturalWidth || img.width, img.naturalHeight || img.height);
    if (!size) return null;
    const canvas = document.createElement('canvas');
    canvas.width = size.w;
    canvas.height = size.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size.w, size.h);
    ctx.drawImage(img, 0, 0, size.w, size.h);
    const reader = new BrowserQRCodeReader(new Map([[DecodeHintType.TRY_HARDER, true]]));
    return reader.decodeFromCanvas(canvas).getText() || null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
};

/**
 * رمز QR الزكوي من صورة المستند — في الجهاز وحده (D4)، ونصّه base64 كما هو (zatcaQrCandidate) أو null. ملف PDF ⇒ null
 * (إدخالٌ يدوي في هذه النسخة). أي فشلٍ (لا رمز، صورةٌ لا تُفكّ، مهلة) ⇒ null بصمت: البطاقة تُفتح للإدخال اليدوي.
 */
export async function decodeZatcaQrFromImage(file: Blob, decode: QrImageDecoder = zxingDecodeImage): Promise<string | null> {
  try {
    const mime = sniffDocMime(await headBytes(file));
    if (mime === 'application/pdf') return null;
    if (!mime && !isImageLike(file as Blob & { name?: string })) return null;
    return zatcaQrCandidate(await decode(file));
  } catch {
    return null;
  }
}

/**
 * التجهيز كاملاً قبل الرفع: الملف (prepareFile) ثم رمز QR — من الملف المجهَّز أوّلاً (≤ ١٦٠٠ بكسل بعد الضغط، أو الأصل الصغير
 * الذي لم يُلمس)، فإن لم يُقرأ وكانت الصورة قد ضُغطت فمن الأصل (أوضح) إن كان JPEG/PNG — والفاكّ الافتراضي يرسمه على لوحةٍ
 * محدودة (QR_DECODE_MAX_DIM) لا بحجم الكاميرا. HEIC/WebP لا يفكّها المتصفّح مباشرةً فتكفيها نسختها JPEG. decodeQr=false يتخطّى.
 */
export async function prepareDocUpload(
  file: Blob & { name?: string },
  opts: { caps?: Partial<DocCaps>; compress?: ImageCompressor; decodeQr?: QrImageDecoder | false } = {},
): Promise<{ ok: true; file: PreparedDocFile; qr: string | null } | { ok: false; problem: DocFileProblem }> {
  const r = await prepareFile(file, opts);
  if (!r.ok) return r;
  if (r.file.kind !== 'image' || opts.decodeQr === false) return { ok: true, file: r.file, qr: null };
  const decode = opts.decodeQr || undefined;
  const first = await decodeZatcaQrFromImage(r.file.blob, decode);
  if (first || !r.file.reencoded) return { ok: true, file: r.file, qr: first };
  let origIsPlain = false;
  try {
    const m = sniffDocMime(await headBytes(file));
    origIsPlain = m === 'image/jpeg' || m === 'image/png';
  } catch { /* الأصل لا يُقرأ — يكفي الناتج */ }
  return { ok: true, file: r.file, qr: origIsPlain ? await decodeZatcaQrFromImage(file, decode) : null };
}

// ═══ روابط Blob للمعاينة ═══

export interface BlobUrlApi { createObjectURL(b: Blob): string; revokeObjectURL(u: string): void }

/** مهلة إبطال رابط PDF فُتح في لسانٍ جديد — قد يكون ما زال يقرؤه (نمط MPurchaseAttachments) */
export const BLOB_REVOKE_DELAY_MS = 60_000;

/**
 * سجلّ روابط Blob للمكوّن (معاينة الملفات المرفوعة من هذا الجهاز): كل رابطٍ أُنشئ يُبطَل مرّة واحدة — فوراً حين تُحذف شريحته
 * أو مستنده، أو كلّها عند «محادثة جديدة» والخروج من الصفحة. لا رابط معلّقاً يحبس بايتات المستند في الذاكرة.
 */
export function createBlobUrlRegistry(api: BlobUrlApi = URL) {
  const live = new Set<string>();
  return {
    create(blob: Blob): string {
      const u = api.createObjectURL(blob);
      live.add(u);
      return u;
    },
    revoke(url: string | null | undefined): void {
      if (url && live.delete(url)) api.revokeObjectURL(url);
    },
    revokeAll(): void {
      for (const u of live) api.revokeObjectURL(u);
      live.clear();
    },
  };
}
export type BlobUrlRegistry = ReturnType<typeof createBlobUrlRegistry>;

// ═══ أخطاء واجهة المستندات ═══

export type DocApiOp = 'upload' | 'patch' | 'remove' | 'get';
export interface DocApiErrorInfo { message: string; retryable: boolean; code: string; status: number }

/**
 * خطأ axios من مسارات المستندات ⇒ رسالة مترجمة. الحالة أولاً ثم الرمز: ٤١٣ حجمٌ أو حصّة، و٤٢٩ حصّةٌ أو ازدحام، و٤١٥ نوع،
 * و٤٠٣ الميزة مطفأة أو الصلاحية، و٤٠٤ مستندٌ محذوف، و٤٠٩ مرحّلٌ في قيدٍ قائم.
 */
export function docApiErrorInfo(err: unknown, op: DocApiOp, tr: Tr = idTr): DocApiErrorInfo {
  const resp = (err as { response?: { status?: number; data?: { code?: unknown; details?: unknown } } } | null)?.response;
  if (!resp) return { message: tr('تعذر الاتصال بالخادم — تحقق من الإنترنت ثم أعد المحاولة'), retryable: true, code: '', status: 0 };
  const status = resp.status ?? 0;
  const code = typeof resp.data?.code === 'string' ? resp.data.code : '';
  const info = (message: string, retryable = false) => ({ message, retryable, code, status });
  const quota = (): DocApiErrorInfo | null => {
    if (/MONTHLY/.test(code)) return info(tr('تجاوزت شركتك سقف المرفقات الشهري'));
    if (/QUOTA/.test(code)) return info(tr('تجاوزت شركتك سقف المرفقات'));
    return null;
  };
  if (status === 413) return quota() ?? info(tr('الملف أكبر من الحجم المسموح للمرفق الواحد'));
  if (status === 429) return quota() ?? info(tr('المحاسب مشغول، حاول بعد دقيقة'), true);
  if (status === 415) return info(tr('نوع الملف غير مدعوم — PDF أو صورة فقط'));
  if (status === 403) {
    return code === 'DOCS_DISABLED' ? info(tr('رفع المستندات غير متاح لحسابك الآن')) : info(tr('لا تملك صلاحية رفع المستندات'));
  }
  if (status === 404) return info(tr('المستند غير موجود أو حُذف'));
  if (status === 409) {
    if (code === 'DOC_CHANGED') return info(tr('تغيّر المستند أثناء الحفظ — حاول مرة أخرى'), true);
    const d = obj(resp.data?.details);
    return info(docRefusalText({ code: 'DOC_ALREADY_POSTED', message: '', details: d }, tr));
  }
  if (status === 400 || status === 422) {
    if (code === 'EMPTY_FILE') return info(tr('الملف فارغ'));
    return info(op === 'upload' ? tr('تعذرت قراءة الملف') : tr('راجع بيانات المستند'));
  }
  switch (op) {
    case 'upload': return info(tr('تعذر رفع المستند — حاول مرة أخرى'), true);
    case 'patch': return info(tr('تعذر حفظ بيانات المستند — حاول مرة أخرى'), true);
    case 'remove': return info(tr('تعذر حذف المستند — حاول مرة أخرى'), true);
    default: return info(tr('تعذر فتح المرفق'), true);
  }
}
