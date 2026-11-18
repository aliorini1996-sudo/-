/**
 * «المحاسب الذكي AI» — رفع المستندات في المحادثة (فواتير، عقود، إيصالات): العقد المشترك بين الحزم الست
 * (الخادم: التخزين والحقائق والترحيل والإطفاء؛ الويب يعكسه في web-admin/src/lib/aiAccountantDocs.ts).
 * المرجع: D:/tax_tools/ai_accountant_docs_DESIGN.md §7.1 بعد قرارات المالك (١٨ نوفمبر ٢٠٢٦) الملزمة:
 *   D1 بطاقة مراجعة إلزامية: لا يُرحَّل مستند إلا بضغطة «سجّل القيد» — ترحيل آلي بالخادم بلا نموذج، والمبالغ من الحقائق
 *      المخزّنة هنا وترد حرفياً في نص المستخدم (حارس المبلغ القائم).
 *   D4 لا قارئ ذكاء اصطناعي: المستند لا يغادر المنصة أبداً. الحقائق من رمز QR الزكوي (يُفكّ في الجهاز ويُتحقَّق منه في الخادم)
 *      أو من إدخال المستخدم في البطاقة (PATCH) — فلا مصدر 'AI' ولا «ثقة» ولا LOW_CONFIDENCE.
 *   D5 لا موافقة (لا شيء يغادر المنصة): لا أعمدة ولا مسارات موافقة ولا DOCS_CONSENT_REQUIRED.
 * المبالغ في الحقائق نصوص عشرية بمنازل عملة الشركة (لا Float)، وفي الحساب ملّي BigInt كـposting.ts.
 */

// ═══ الأنواع الأساسية ═══

/**
 * حالة المستند المخزّنة (المرحَّل مشتقّ لا مخزّن: moveId مضبوط وقيده حيّ — فالعكس من الدفاتر لا يحتاج خطّافاً):
 *   UPLOADED      رُفع ولم تُحسب حقائقه بعد (لحظة الإنشاء داخل المعاملة).
 *   EXTRACTED     حقائقه جاهزة (QR أو إدخال) وكل الفحوص خضراء.
 *   NEEDS_REVIEW  فحصٌ واحد على الأقل منبّه أو مانع، أو بلا حقائق بعد (بلا QR ⇒ إدخال يدوي manualEntry).
 *   FAILED        محجوز: ملفه مفقود (تصفير الدفاتر يحذف gl_attachments) — لا يُرحَّل.
 */
export type AcctDocStatus = 'UPLOADED' | 'EXTRACTED' | 'NEEDS_REVIEW' | 'FAILED';
export const ACCT_DOC_STATUSES: readonly AcctDocStatus[] = ['UPLOADED', 'EXTRACTED', 'NEEDS_REVIEW', 'FAILED'];

/** نوع المستند — يختاره المستخدم في البطاقة (شرائح) */
export type AcctDocType = 'TAX_INVOICE' | 'SIMPLIFIED_INVOICE' | 'LEASE_CONTRACT' | 'MAINTENANCE_INVOICE'
  | 'UTILITY_BILL' | 'RECEIPT' | 'OTHER';
export const ACCT_DOC_TYPES: readonly AcctDocType[] = [
  'TAX_INVOICE', 'SIMPLIFIED_INVOICE', 'LEASE_CONTRACT', 'MAINTENANCE_INVOICE', 'UTILITY_BILL', 'RECEIPT', 'OTHER',
];

/** المعالجة: مصروف، أو مدفوع مقدماً بإطفاء شهري (D2)، أو أصل بلا إهلاك (D3) */
export type AcctDocTreatment = 'EXPENSE' | 'PREPAID' | 'ASSET';
export const ACCT_DOC_TREATMENTS: readonly AcctDocTreatment[] = ['EXPENSE', 'PREPAID', 'ASSET'];

/** الضريبة (D7): تُخصم بسطر 116001 / تُحمَّل على التكلفة / لا سطر ضريبة */
export type AcctVatMode = 'DEDUCTIBLE' | 'NON_DEDUCTIBLE' | 'NONE';

/** «مدفوع من» — قائمة post_expense نفسها (writeTools.ts)؛ payable ⇒ دائن 213002 مصروفات مستحقة (D6) */
export type AcctPaidFrom = 'cash' | 'petty_cash' | 'bank' | 'payable';
export const ACCT_PAID_FROM: readonly AcctPaidFrom[] = ['cash', 'petty_cash', 'bank', 'payable'];

/** مصدر الحقائق (D4): رمز QR الزكوي، أو المستخدم، أو QR صحّحه المستخدم — لا مصدر 'AI' إطلاقاً */
export type AcctFactsSource = 'QR' | 'USER' | 'QR+USER';
export const ACCT_FACTS_SOURCES: readonly AcctFactsSource[] = ['QR', 'USER', 'QR+USER'];

export type AcctPaymentHint = 'PAID' | 'UNPAID' | 'UNKNOWN';

/**
 * فئة الأصل (D3) ⇐ حسابه في القالب السعودي SA_6D (والعام GENERIC_6D بالرموز نفسها) — قائمة بيضاء بالرمز: حسابات مجمّع
 * الإهلاك 122xxx من النوع asset_fixed نفسه فلا يُحكم بالنوع. الأراضي والمباني (land_buildings) تُحال للمحاسب البشري.
 */
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
/** الأراضي والمباني: DOC_TREATMENT_REFERRED دائماً */
export const ACCT_REFERRED_ASSET_CODES: readonly string[] = ['121001', '121002'];

/**
 * فئات تُضاف لمفاتيح تصنيف المصروف (EXPENSE_CATEGORY_KEYS في posting.ts) في categoryHint:
 * prepaid (مدفوع مقدماً)، fixed_asset (أصل)، inventory_goods (بضاعة ⇒ DOC_IS_INVENTORY: مشتريات المستودع)، unknown.
 */
export const ACCT_DOC_EXTRA_CATEGORIES = ['prepaid', 'fixed_asset', 'inventory_goods', 'unknown'] as const;

/** حسابات ثابتة في القالب (D2، D6، D7) */
export const ACCT_DOC_CODES = {
  inputVat: '116001',
  prepaidOther: '115001',
  prepaidRent: '115002',
  accrued: '213002',
  rentExpense: '621004',
} as const;

/** أقصى أشهر الإطفاء (D2): الأطول ⇒ DOC_TREATMENT_REFERRED */
export const ACCT_PREPAID_MAX_MONTHS = 24;

/** رقم ضريبي سعودي صالح للمورد (D7): ١٥ رقماً يبدأ وينتهي بـ3 — وإلا لا تُخصم الضريبة وتُحمَّل على التكلفة */
export const VENDOR_VAT_RE = /^3\d{13}3$/;

// ═══ الحقائق ═══

export interface AcctDocLine {
  description: string;
  amount: string | null;
}

export interface AcctDocLease {
  totalRent: string | null;
  months: number | null;
  frequency: string | null;
  start: string | null;
  end: string | null;
  deposit: string | null;
  residential: boolean | null;
}

/**
 * حقائق المستند كما اعتمدها الخادم: المبالغ نصوص عشرية بمنازل عملة الشركة («1150.00»)، والتواريخ ميلادية YYYY-MM-DD،
 * والنصوص منظّفة ومقصوصة (≤ 120 محرفاً، والسطور ≤ 80 وعددها ≤ 10). لا هوية ولا آيبان ولا جوال أبداً.
 */
export interface AcctDocFacts {
  docType: AcctDocType | null;
  vendorName: string | null;
  vendorVat: string | null;
  buyerName: string | null;
  buyerVat: string | null;
  invoiceNo: string | null;
  /** تاريخ الفاتورة الميلادي — تاريخ القيد (ضريبة المدخلات في فترتها) */
  issueDate: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  currency: string | null;
  subtotal: string | null;
  vatAmount: string | null;
  total: string | null;
  vatRatePct: number | null;
  /** أشهر الخدمة المدفوعة مقدماً (1..24) يدخلها المستخدم أو تُشتق من الفترة — للإطفاء (D2) */
  months: number | null;
  lines: AcctDocLine[];
  lease: AcctDocLease | null;
  paymentHint: AcctPaymentHint;
  /** مفتاح تصنيف المصروف (EXPENSE_CATEGORY_KEYS) أو أحد ACCT_DOC_EXTRA_CATEGORIES */
  categoryHint: string | null;
  assetClassHint: AcctAssetClass | null;
}

/** حقائق فارغة (بداية الإدخال اليدوي) */
export function emptyFacts(): AcctDocFacts {
  return {
    docType: null, vendorName: null, vendorVat: null, buyerName: null, buyerVat: null, invoiceNo: null, issueDate: null,
    periodFrom: null, periodTo: null, currency: null, subtotal: null, vatAmount: null, total: null, vatRatePct: null,
    months: null, lines: [], lease: null, paymentHint: 'UNKNOWN', categoryHint: null, assetClassHint: null,
  };
}

// ═══ الفحوص والاقتراح ═══

/**
 * الفحوص الآلية (§5.1 بعد D4: بلا LOW_CONFIDENCE). block يمنع «سجّل القيد»، وwarn يظهر كهرماناً ويُسمح بالترحيل معه.
 * الإضافات على التصميم: VAT_NO_BOX (دليل بلا مربّع ضريبة ⇒ بلا فصل)، FILE_GONE (ملفه حُذف بتصفير الدفاتر)،
 * MONTHS_INVALID (أشهر الإطفاء خارج 1..24)، NEEDS_DEPRECIATION (أصلٌ يحتاج إهلاكاً يسجّله المحاسب — D3).
 */
export type AcctDocCheckCode = 'TOTAL_MISSING' | 'DATE_MISSING' | 'SUM_MISMATCH' | 'VAT_RATE_ODD' | 'VAT_NO_TAX_NUMBER'
  | 'VAT_BLOCKED_CATEGORY' | 'VAT_NO_BOX' | 'BUYER_OTHER' | 'CURRENCY_MISMATCH' | 'DATE_FUTURE' | 'DATE_TOO_OLD' | 'HIJRI_DATE'
  | 'QR_MISMATCH' | 'QR_INVALID' | 'NOT_A_PAYMENT' | 'DUPLICATE_SUSPECT' | 'FILE_GONE' | 'MONTHS_INVALID'
  | 'NEEDS_DEPRECIATION';

export interface AcctDocCheck {
  code: AcctDocCheckCode;
  field?: keyof AcctDocFacts;
  severity: 'block' | 'warn';
  details?: Record<string, string>;
}

/**
 * اقتراح آلي (suggest.ts) من نوع المستند وتصنيفه — المستخدم يختار في البطاقة وتبقى «مدفوع من» إلزامية.
 * accountCode هو ما ترسله البطاقة في docConfirm.accountCode: حساب المصروف أو الأصل، وللمدفوع مقدماً (PREPAID) **حساب
 * المصروف الذي يُطفأ عليه شهرياً** (621004 للإيجار…) — يراه المستخدم ويغيّره (D1)، وحساب المدفوع مقدماً يُشتق منه
 * (الإيجار وسكن الموظفين ⇐ 115002، وغيرهما ⇐ 115001) ويُذكر في نصّ التأكيد معه.
 */
export interface AcctDocSuggestion {
  treatment: AcctDocTreatment;
  accountCode: string;
  accountName: string;
  vatMode: AcctVatMode;
  months: number | null;
  /** من paymentHint؛ المستخدم يختار دائماً */
  paidFrom: AcctPaidFrom | null;
  /** PREPAID وحده: حساب المدفوع مقدماً المشتق (115002/115001) واسمه — للعرض ونصّ التأكيد */
  prepaidCode?: string;
  prepaidName?: string;
  /** PREPAID وحده: مصروف الإطفاء الشهري (= accountCode) واسمه — صريحاً للبطاقة */
  amortizationCode?: string;
  amortizationName?: string;
}

/**
 * خيار حساب في البطاقة (محلول من دليل الشركة في الخادم). خيارات PREPAID هي حسابات المصروف التي يُطفأ عليها (الرمز نفسه قد
 * يرد مرتين: EXPENSE وPREPAID) — لا 115001/115002: حساب المدفوع مقدماً يُشتق من المصروف المختار.
 */
export interface AcctAccountOption {
  code: string;
  name: string;
  treatment: AcctDocTreatment;
}

/** خيار «مدفوع من» (محلول من دليل الشركة: 111001/111002/111101 أو 213002) */
export interface AcctPayOption {
  paidFrom: AcctPaidFrom;
  code: string;
  name: string;
}

// ═══ ما يصل الواجهة والنموذج ═══

export interface AcctDocPosted {
  moveId: string;
  moveNumber: string | null;
  /** القيد مرحَّل ولم يُعكس — المعكوس يُسمح بإعادة ترحيل مستنده */
  live: boolean;
  /** نوع صفّ AiAccountantPost (EXPENSE | PREPAID | ASSET…) أو '' إن لم يُعرف */
  kind: string;
}

export interface AcctDocDuplicate {
  moveNumber: string | null;
  reason: 'SHA' | 'INVOICE_NO' | 'SOFT';
}

export interface AcctDocView {
  id: string;
  /** 'D1'… حسب أول ظهور في نافذة المحادثة (يعيّنه السياق)؛ '' خارج المحادثة */
  ref: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  status: AcctDocStatus;
  /** بلا QR صالح ⇒ تفتح البطاقة في وضع التحرير */
  manualEntry: boolean;
  factsSource: AcctFactsSource | null;
  facts: AcctDocFacts | null;
  checks: AcctDocCheck[];
  qrVerified: boolean;
  suggestion: AcctDocSuggestion | null;
  accountOptions: AcctAccountOption[];
  payOptions: AcctPayOption[];
  posted: AcctDocPosted | null;
  duplicateOf: AcctDocDuplicate | null;
}

/** ما ترسله البطاقة مع «سجّل القيد» (POST /chat docConfirm) — docId ضمن docIds لآخر رسالة */
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
 * تصحيح المستخدم (PATCH /documents/:id) — جزئي: الغائب لا يتغيّر وnull يمحو. المبالغ نصوص عشرية («1150.00»؛ الأرقام
 * الهندية والفواصل تُوحَّد في الخادم)، والتواريخ ميلادية YYYY-MM-DD.
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

/** ما يحتاجه حساب الحقائق والفحوص والاقتراح (facts.ts) من الشركة — يبنيه الخادم من الجلسة (store.ts loadDocEnv) */
export interface AcctDocChartAccount {
  code: string;
  name: string;
  type: string;
  isActive: boolean;
  controlKind: string | null;
}

export interface AcctDocEnv {
  tenantId: string;
  /** عملة الشركة (الدفاتر ثم الإعدادات ثم SAR) ومنازلها */
  currency: string;
  currencyDecimals: number;
  /** الشركة أزالت الضريبة (isTaxOff) ⇒ إجمالي بلا سطر ضريبة (D7) */
  taxDisabled: boolean;
  /** الرقم الضريبي للشركة (BUYER_OTHER) */
  companyVat: string | null;
  /** اليوم المحلي بتوقيت الشركة ومنطقتها */
  todayLocal: string;
  tz: string;
  /** دليل سعودي SA_6D فيه مربّع ضريبة المدخلات؛ العام بلا مربّع ⇒ لا فصل + تنبيه VAT_NO_BOX (D7) */
  vatBox: boolean;
  /** حدّ الرسملة (D3) بالملّي من AI_ACCOUNTANT_ASSET_THRESHOLD بوحدة العملة الكبرى */
  assetThresholdMilli: bigint;
  /** حسابات الدليل ذات الصلة (النقد والبنك والمدفوع مقدماً والأصول والمصروفات و213002) — للاقتراح والخيارات */
  accounts: AcctDocChartAccount[];
}

/** نتيجة إعادة الفحص (recheck في facts.ts) */
export interface AcctDocRecheck {
  checks: AcctDocCheck[];
  status: AcctDocStatus;
  suggestion: AcctDocSuggestion | null;
}

/** كتلة docs في GET /status */
export interface AcctDocsStatus {
  /** مفتاح البيئة + العَلَم (بالسلسلة) + الترحيل متاح (الدفاتر مفعّلة وcanPostJournals) + AI_ACCOUNTANT_WRITE */
  enabled: boolean;
  canUpload: boolean;
  caps: { imageBytes: number; pdfBytes: number; perMessage: number };
  /** حدّ الرسملة بوحدة العملة الكبرى */
  assetThreshold: number;
  retentionDays: number;
}

// ═══ الرفض ═══

/** رموز رفض ترحيل المستند — تُلحق بـAiRefusalCode (posting.ts) */
export const AI_DOC_REFUSALS = [
  'DOC_NOT_FOUND', 'DOC_NOT_ATTACHED', 'DOC_NOT_READY', 'DOC_NEEDS_REVIEW', 'DOC_TOTAL_NOT_CONFIRMED',
  'ACCOUNT_NOT_IN_MESSAGE', 'PAYMENT_SOURCE_NOT_IN_MESSAGE', 'DOC_CURRENCY_MISMATCH', 'DOC_ALREADY_POSTED', 'DOC_POSSIBLE_DUPLICATE',
  'DOC_FILE_GONE', 'TREATMENT_NOT_ALLOWED', 'ASSET_BELOW_THRESHOLD', 'PREPAID_MONTHS_INVALID', 'DOC_TREATMENT_REFERRED',
  'DOC_IS_INVENTORY', 'NOT_A_PAYMENT', 'DOCS_DISABLED',
  // تغيّر المستند (تصحيحٌ من نافذة أخرى) بين قراءته وترحيله ⇒ لا يُرحَّل بحقائق قديمة
  'DOC_CHANGED',
  // إعادة ترحيل مستندٍ مدفوعٍ مقدماً عُكس قيده وأقساط إطفائه السابقة ما زالت حيّة ⇒ تُعكس أولاً (لا مصروف مرتين)
  'PREPAID_AMORT_LIVE',
] as const;
export type AiDocRefusalCode = (typeof AI_DOC_REFUSALS)[number];
