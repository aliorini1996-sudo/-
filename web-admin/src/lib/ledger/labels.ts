import type { LedgerKey } from '../ledgerPerms';
import type { AccountType, CashFlowTag, JournalType, TaxUse, VatCategory } from '../../api/ledgerConfig';
import type { SetupMethodValue } from './bookMode';
import type {
  CancelRefundFrom, ClearingKind, CustodyExplainKind, CustomerAdjustmentKind, CustomerAdjustmentStatus, WriteoffCounter,
} from '../../api/ledgerOps';

/**
 * تسميات الدفاتر التقنية (§8.7) — **بنداءات `tr()` حرفية** لا `tr(متغير)`: حارس
 * `langs.test.ts` لا يلتقط إلا الحرفية، والنداء بمتغير يسقط صامتاً إلى العربية.
 * M0: تسميات الصلاحيات الست وحدها؛ تتسع من M2.
 */
export const ledgerPermissionItems = (tr: (ar: string) => string): { key: LedgerKey; label: string }[] => [
  { key: 'canViewLedger', label: tr('عرض الدفاتر والتقارير') },
  { key: 'canPostJournals', label: tr('إنشاء القيود وترحيلها') },
  { key: 'canManagePayables', label: tr('الموردون والمدفوعات') },
  { key: 'canManageBank', label: tr('البنك والمطابقة') },
  { key: 'canCloseLedgerPeriods', label: tr('إقفال الفترات والإقرار الضريبي') },
  { key: 'canConfigureLedger', label: tr('إعداد الدفاتر') },
];

// ═══ M2: تسميات التهيئة (§4.1، §4.3، §4.4، §4.5) ═══

type Tr = (ar: string) => string;

/** أنواع الحسابات العشرون (§4.1، COA‑03) بترتيب موضعها في التقارير. */
export const accountTypeLabels = (tr: Tr): Record<AccountType, string> => ({
  asset_cash: tr('البنك والنقد'),
  asset_receivable: tr('المدينون'),
  asset_current: tr('أصول متداولة'),
  asset_prepayments: tr('مدفوعات مقدماً'),
  asset_fixed: tr('أصول ثابتة'),
  asset_non_current: tr('أصول غير متداولة'),
  liability_payable: tr('الدائنون'),
  liability_credit_card: tr('بطاقة ائتمانية'),
  liability_current: tr('التزامات متداولة'),
  liability_non_current: tr('التزامات غير متداولة'),
  equity: tr('حقوق الملكية'),
  equity_unaffected: tr('أرباح السنة الجارية'),
  income: tr('الإيرادات'),
  income_other: tr('إيرادات أخرى'),
  expense_direct_cost: tr('تكلفة الإيرادات'),
  expense: tr('مصروفات تشغيلية'),
  expense_depreciation: tr('إهلاك'),
  expense_other: tr('مصروفات أخرى'),
  expense_zakat: tr('الزكاة وضريبة الدخل'),
  off_balance: tr('خارج الميزانية'),
});

export const journalTypeLabels = (tr: Tr): Record<JournalType, string> => ({
  SALE: tr('المبيعات'),
  PURCHASE: tr('المشتريات'),
  CASH: tr('النقد'),
  BANK: tr('البنك'),
  GENERAL: tr('عمليات متنوعة'),
});

export const taxUseLabels = (tr: Tr): Record<TaxUse, string> => ({
  SALE: tr('المبيعات'),
  PURCHASE: tr('المشتريات'),
  NONE: tr('بلا استخدام'),
});

export const vatCategoryLabels = (tr: Tr): Record<VatCategory, string> => ({
  S: tr('خاضعة للنسبة الأساسية'),
  Z: tr('نسبة صفرية'),
  E: tr('معفاة'),
  O: tr('خارج نطاق الضريبة'),
});

export const cashFlowTagLabels = (tr: Tr): Record<CashFlowTag, string> => ({
  OPERATING: tr('أنشطة تشغيلية'),
  INVESTING: tr('أنشطة استثمارية'),
  FINANCING: tr('أنشطة تمويلية'),
  EXCLUDE: tr('مستبعد من التدفقات النقدية'),
  CASH_EQUIVALENT: tr('معادل نقدي'),
});

/** مفاتيح الربط (§4.5) — التسمية من اسم حساب القالب المقابل. */
export const mappingKeyLabels = (tr: Tr): Record<string, string> => ({
  AR_CONTROL: tr('ذمم العملاء'),
  AP_CONTROL: tr('ذمم الموردين'),
  SALES_REVENUE: tr('إيرادات المبيعات'),
  SALES_RETURNS: tr('مردودات المبيعات'),
  SALES_DISCOUNT: tr('خصم مسموح به على المبيعات'),
  OUTPUT_VAT: tr('ضريبة القيمة المضافة: المخرجات'),
  INPUT_VAT: tr('ضريبة القيمة المضافة: المدخلات'),
  VAT_PAYABLE: tr('ضريبة القيمة المضافة المستحقة (صافي الإقرار)'),
  VAT_RECEIVABLE: tr('ضريبة القيمة المضافة المستردة (صافي الإقرار)'),
  VAT_RC_OUTPUT: tr('ضريبة المخرجات: احتساب عكسي'),
  REP_CUSTODY: tr('عهدة تحصيلات المناديب'),
  MAIN_CASH: tr('الصندوق الرئيسي'),
  PETTY_CASH: tr('صندوق المصروفات النثرية'),
  MAIN_BANK: tr('البنك الرئيسي'),
  OUTSTANDING_RECEIPTS: tr('مقبوضات قيد الإيداع'),
  OUTSTANDING_PAYMENTS: tr('مدفوعات قيد الصرف'),
  CHEQUES_UNDER_COLLECTION: tr('شيكات تحت التحصيل'),
  POS_CLEARING: tr('مدى ونقاط البيع تحت التسوية'),
  PAYLINK_CLEARING: tr('أمانات الدفع الإلكتروني لدى فيلد سيلز'),
  PAYLINK_FEE_EXPENSE: tr('عمولات بوابات الدفع الإلكتروني'),
  PAYLINK_PAYOUT_ACCOUNT: tr('حساب استلام توريد الدفع الإلكتروني'),
  BANK_SUSPENSE: tr('الحساب البنكي المعلّق'),
  BANK_FEES: tr('رسوم بنكية ونقاط البيع'),
  INTERNAL_TRANSFER: tr('أموال قيد التحويل'),
  OPENING_EQUITY: tr('أرصدة افتتاحية (تُصفّى)'),
  CURRENT_YEAR_EARNINGS: tr('أرباح السنة الجارية غير الموزعة'),
  RETAINED_EARNINGS: tr('الأرباح المبقاة'),
  DRAWINGS: tr('مسحوبات وتوزيعات الملاك'),
  ROUNDING: tr('فروقات التقريب'),
  POSTING_SUSPENSE: tr('معلّق: فروقات الترحيل الآلي'),
  INVENTORY_WAREHOUSE: tr('مخزون المستودع'),
  INVENTORY_VAN: tr('بضاعة لدى المناديب (السيارات)'),
  GRNI: tr('مشتريات مستلمة لم تُفوتر'),
  COGS: tr('تكلفة البضاعة المباعة'),
  PURCHASES: tr('المشتريات (جرد دوري)'),
  PURCHASE_RETURNS: tr('مردودات وخصم المشتريات'),
  INVENTORY_CHANGE: tr('التغيّر في المخزون (إقفال دوري)'),
  INVENTORY_WRITEOFF: tr('تالف وعجز المخزون'),
  INVENTORY_ADJUSTMENT: tr('فروقات جرد المخزون'),
  VENDOR_ADVANCES: tr('دفعات مقدمة للموردين'),
  EARLY_DISCOUNT_GAIN: tr('خصم مكتسب للدفع المبكر'),
  EARLY_DISCOUNT_LOSS: tr('خصم مسموح به للدفع المبكر'),
  DEFERRED_REVENUE: tr('إيرادات مؤجلة'),
  DEFERRED_EXPENSE: tr('مصروفات مدفوعة مقدماً'),
  ASSET_GAIN: tr('أرباح بيع أصول ثابتة'),
  ASSET_LOSS: tr('خسائر بيع أصول ثابتة'),
  LOAN_INTEREST: tr('مصاريف تمويلية وفوائد'),
  LEASE_LIABILITY: tr('التزامات عقود الإيجار (غير متداولة)'),
  ROU_ASSET: tr('أصول حق الاستخدام (IFRS 16)'),
  ROU_ACCUMULATED: tr('مجمع استهلاك أصول حق الاستخدام'),
  FX_GAIN: tr('أرباح فروقات العملة'),
  FX_LOSS: tr('خسائر فروقات العملة'),
  WHT_PAYABLE: tr('ضريبة الاستقطاع المستحقة'),
  ZAKAT_EXPENSE: tr('الزكاة الشرعية'),
  ZAKAT_PROVISION: tr('مخصص الزكاة'),
  BAD_DEBT: tr('ديون معدومة'),
  DOUBTFUL_ALLOWANCE: tr('مخصص الديون المشكوك في تحصيلها'),
  ACCRUED_EXPENSES: tr('مصروفات مستحقة'),
  EOSB_PROVISION: tr('مخصص مكافأة نهاية الخدمة'),
  FUEL: tr('وقود وزيوت السيارات'),
  VAT_CORRECTIONS: tr('تصحيحات ضريبية لفترات سابقة'),
});

/**
 * أسباب رفض التهيئة بلا رمز في ملحق ب (`reason` في LedgerHttpError من routes/ledger/config.ts)،
 * وأسباب تخطي صفوف استيراد الحسابات.
 */
export const ledgerConfigReasonLabels = (tr: Tr): Record<string, string> => ({
  CODE_EXISTS: tr('رمز الحساب مستخدم'),
  CODE_LOCKED: tr('لا يتغير رمز حساب من القالب أو له حركة'),
  EQUITY_UNAFFECTED_EXISTS: tr('حساب أرباح السنة الجارية موجود ويحسبه النظام'),
  TYPE_LOCKED_CONTROL: tr('لا يتغير نوع حساب رئيسي'),
  TYPE_LOCKED_SYSTEM: tr('لا يتغير نوع حساب النظام بعد أول حركة'),
  TYPE_LOCKED_OFF_BALANCE: tr('لا يتغير نوع حساب له قيود مرحّلة إلى خارج الميزانية أو منه'),
  TOO_MANY_IDS: tr('عدد المعرّفات المحددة يتجاوز الحد'),
  RECONCILE_CASH: tr('لا تُفعَّل التسوية لحسابات البنك والنقد'),
  RECONCILE_LOCKED: tr('التسوية مقفلة لحساب ذمم العملاء الرئيسي'),
  CONTROL_ACCOUNT: tr('لا يُؤرشف حساب رئيسي'),
  MAPPED: tr('الحساب مربوط بمفتاح ربط ويُغيَّر الربط أولاً'),
  JOURNAL_ACCOUNT: tr('الحساب افتراضي لدفتر نشط'),
  TAX_ACCOUNT: tr('الحساب مستعمل في ضريبة نشطة'),
  MAPPING_TYPE_MISMATCH: tr('نوع الحساب لا يوافق مفتاح الربط'),
  MAPPING_CONTROL_KIND: tr('مفتاح الربط يتطلب حساباً رئيسياً من نوعه'),
  SYSTEM_JOURNAL_TYPE: tr('لا يتغير نوع دفتر النظام'),
  SYSTEM_JOURNAL_ARCHIVE: tr('لا يُؤرشف دفتر النظام'),
  RATE_CATEGORY_MISMATCH: tr('النسبة لا توافق فئة الضريبة: الأساسية بنسبة موجبة وغيرها صفرية'),
  NON_DEDUCTIBLE_NOT_PURCHASE: tr('عدم قابلية الخصم للمشتريات وحدها'),
  REVERSE_CHARGE_NOT_PURCHASE: tr('الاحتساب العكسي للمشتريات وحدها'),
  SYSTEM_TAX: tr('لا تتغير نسبة ضريبة القالب أو طبيعتها'),
  TAX_IN_USE: tr('لا تتغير نسبة ضريبة مستعملة في قيود — أنشئ ضريبة جديدة'),
  TAX_IN_SETTINGS: tr('الضريبة مستعملة في إعدادات الدفاتر'),
  FROZEN_AFTER_ACTIVATION: tr('هذه الإعدادات لا تتغير بعد تفعيل الدفاتر'),
  // «ربط الدفاتر» L0: الجرد المستمر لا يُختار حتى تصل قيود المخزون مع الربط (L6) — routes/ledger/config.ts
  INVENTORY_MODE_UNAVAILABLE: tr('الجرد المستمر يتاح مع ربط الدفاتر بالنظام'),
  INVALID_FISCAL_YEAR_END: tr('يوم نهاية السنة المالية غير صالح للشهر'),
  TAX_DEADLINE_DAYS_REQUIRED: tr('عدد أيام موعد الإقرار مطلوب'),
  DEFAULT_PURCHASE_TAX_INVALID: tr('ضريبة الشراء الافتراضية يجب أن تكون ضريبة مشتريات نشطة'),
  ZERO_RATED_TAX_INVALID: tr('ربط النسبة الصفرية يتطلب ضريبة مبيعات صفرية نشطة'),
  TEMPLATE_UNAVAILABLE: tr('لا قالب محاسبي لدولة الشركة'),
  SETTINGS_MISSING: tr('حمّل القالب المحاسبي أولاً'),
  INVALID_RANGE: tr('تاريخ البداية بعد تاريخ النهاية'),
  RANGE_TOO_LONG: tr('السنة المالية لا تتجاوز 24 شهراً'),
  OVERLAP: tr('السنة المالية تتداخل مع سنة قائمة'),
  CLOSED: tr('السنة المالية مقفلة'),
  HARD_LOCKED: tr('السنة المالية ضمن الإقفال النهائي'),
  NAME_EXISTS: tr('الاسم مستخدم'),
  EXISTS: tr('الرمز موجود مسبقاً'),
  DUPLICATE_IN_FILE: tr('رمز مكرر في الملف'),
  EQUITY_UNAFFECTED: tr('أرباح السنة الجارية يحسبها النظام'),
  ALREADY_ACTIVATED: tr('النظام المحاسبي المتكامل مفعّل مسبقا لهذه الشركة'),
  CUTOVER_REQUIRED: tr('تاريخ البدء مطلوب'),
  STATUTORY_ACK_REQUIRED: tr('يجب الإقرار بتنبيه السجلات المحاسبية النظامية قبل التفعيل'),
  OPENING_BALANCE_ROWS_INVALID: tr('أرصدة افتتاحية يدوية غير صالحة'),
  BACKFILL_STATE_CONFLICT: tr('لا يمكن تغيير حالة الترحيل التاريخي من حالتها الحالية'),
  CATEGORY_ACCOUNT_TYPE: tr('نوع الحساب لا يوافق حقل الفئة'),
  POST_CUTOVER_IMPORTS_ACK_REQUIRED: tr('توجد حركات مستوردة بتاريخ بعد تاريخ البدء: راجعها وأقرّ بها قبل التفعيل'),
  // البند 41: الإقرار مربوط باللقطة المعروضة، فاختلافها لحظة الاعتماد يُبطله
  POST_CUTOVER_IMPORTS_CHANGED: tr('تغيّرت الحركات المستوردة بعد تاريخ البدء عمّا أقررت به: حدّث المعاينة وراجع الأرقام الجديدة ثم أقرّ بها من جديد'),
  IMPORT_IN_PROGRESS: tr('استيراد بيانات جارٍ الآن لهذه الشركة: انتظر انتهاءه وراجع سجل الدفعات ثم أعد التفعيل'),
  OPENING_STOCK_FULL_HISTORY: tr('يوجد مخزون افتتاحي مستورد لا يدخل الدفاتر في طريقة ترحيل التاريخ الكامل: اختر طريقة الأرصدة الافتتاحية أو تراجع عن دفعة المخزون من سجل الاستيرادات'),
  OPENING_STOCK_AFTER_CUTOVER: tr('مخزون افتتاحي مستورد في تاريخ البدء أو بعده لا يدخل القيد الافتتاحي: اعتمد في يوم لاحق بتاريخ بدء بعد يوم الاستيراد، أو تراجع عن الدفعة، أو أقرّ بالمتابعة دون قيمته'),
  OPENING_STOCK_TOO_RECENT: tr('استُورد مخزون افتتاحي قبل أقل من 10 دقائق فلا تشمله لقطة الافتتاح: أعد الاعتماد بعد دقائق'),
  // البداية النظيفة: الخطوة الأولى حُفظت في يوم غير يوم الاعتماد
  SETUP_DAY_CHANGED: tr('تغيّر يوم التفعيل منذ حفظ الخطوة الأولى: احفظ الخطوة الأولى من جديد اليوم وراجع الأرصدة الافتتاحية لتكون حتى لحظة التفعيل'),
  ...ledgerLinkedReasonLabels(tr),
});

/**
 * تسمية «طريقة البدء» (setupMethod) في الإعدادات ومراجعة المعالج. LINKED «دفاتر مربوطة بالنظام» («ربط الدفاتر» L0)؛
 * والثلاث الأخرى بنصوصها السابقة حرفاً بحرف.
 */
export const setupMethodLabels = (tr: Tr): Record<SetupMethodValue, string> => ({
  OPENING: tr('أرصدة افتتاحية'),
  FULL_HISTORY: tr('ترحيل التاريخ الكامل'),
  CLEAN: tr('بداية نظيفة من يوم التفعيل'),
  LINKED: tr('دفاتر مربوطة بالنظام'),
});

/** رموز ملحق ب التي تردها نقاط التهيئة. */
export const ledgerConfigCodeLabels = (tr: Tr): Record<string, string> => ({
  LEDGER_NAME_ARABIC_REQUIRED: tr('الاسم يجب أن يحوي حرفاً عربياً والاسم بلغة أخرى مكانه الاسم الإنجليزي'),
  LEDGER_JOURNAL_CODE_CONFLICT: tr('رمز الدفتر يتعارض مع دفتر آخر'),
  LEDGER_JOURNAL_HAS_POSTED_MOVES: tr('لا يتغير رمز الدفتر ولا نمط ترقيمه بعد أول ترحيل'),
  LEDGER_ACCOUNT_ARCHIVED: tr('الحساب مؤرشف'),
  LEDGER_NOT_SETUP: tr('الإعداد المبدئي للدفاتر لم يكتمل بعد'),
  LEDGER_PERMISSION_DENIED: tr('لا تملك صلاحية الوصول لهذا القسم'),
  LEDGER_EXPORT_TOO_LARGE: tr('التصدير يتجاوز الحد المسموح'),
  LEDGER_CUTOVER_IN_FUTURE: tr('لا يجوز تاريخ بدء بعد اليوم بتوقيت الشركة'),
  LEDGER_CUTOVER_MID_VAT_PERIOD: tr('تاريخ البدء داخل فترة إقرار: أكّد الاختيار وأدخل مبالغ المربعات قبل البدء، أو اختر بداية فترة'),
  LEDGER_HISTORY_TOO_LARGE: tr('الترحيل التاريخي الكامل يتجاوز السقف المسموح، فاختر الأرصدة الافتتاحية'),
  LEDGER_POST_CUTOVER_IMPORTS_ACK: tr('توجد حركات مستوردة بتاريخ بعد تاريخ البدء: راجعها وأقرّ بها قبل التفعيل'),
  LEDGER_POST_CUTOVER_IMPORTS_CHANGED: tr('تغيّرت الحركات المستوردة بعد تاريخ البدء عمّا أقررت به: حدّث المعاينة وراجع الأرقام الجديدة ثم أقرّ بها من جديد'),
  LEDGER_IMPORT_IN_PROGRESS: tr('استيراد بيانات جارٍ الآن لهذه الشركة: انتظر انتهاءه وراجع سجل الدفعات ثم أعد التفعيل'),
  LEDGER_TIMEZONE_IMPORTS_CONFLICT: tr('للشركة أرصدة أو كشوف مستوردة بالمنطقة الزمنية السابقة، وتغييرها يزيح تواريخها يوماً. تراجع عن الدفعات أو أكّد إعادة ضبط تواريخها على المنطقة الجديدة'),
  LEDGER_OPENING_STOCK_FULL_HISTORY: tr('يوجد مخزون افتتاحي مستورد لا يدخل الدفاتر في طريقة ترحيل التاريخ الكامل: اختر طريقة الأرصدة الافتتاحية أو تراجع عن دفعة المخزون من سجل الاستيرادات'),
  LEDGER_OPENING_STOCK_AFTER_CUTOVER: tr('مخزون افتتاحي مستورد في تاريخ البدء أو بعده لا يدخل القيد الافتتاحي: اعتمد في يوم لاحق بتاريخ بدء بعد يوم الاستيراد، أو تراجع عن الدفعة، أو أقرّ بالمتابعة دون قيمته'),
  LEDGER_OPENING_STOCK_TOO_RECENT: tr('استُورد مخزون افتتاحي قبل أقل من 10 دقائق فلا تشمله لقطة الافتتاح: أعد الاعتماد بعد دقائق'),
  LEDGER_SETUP_DAY_CHANGED: tr('تغيّر يوم التفعيل منذ حفظ الخطوة الأولى: احفظ الخطوة الأولى من جديد اليوم وراجع الأرصدة الافتتاحية لتكون حتى لحظة التفعيل'),
  // «ربط الدفاتر» L4/L5: نصّ الرمز حين يغيب سببه (الأسباب نفسها في ledgerLinkedReasonLabels وتسميات الشاشات)
  LEDGER_BOOKS_NOT_LINKED: tr('هذه العملية متاحة حين تكون الدفاتر مربوطة بالنظام'),
  LEDGER_ROUTING_CUSTODY_NONCASH: tr('لا تُوجَّه التحويلات البنكية ونقاط البيع إلى عهدة المندوب'),
  LEDGER_METHOD_ACCOUNT_INVALID: tr('حساب الطريقة يجب أن يكون حساب نقد أو بنك أو أصلاً متداولاً'),
});

// ═══ مساعدات عرض القوائم والتصدير ═══

/** يضمّ عناصر مترجمة بفاصل لغة الواجهة: «، » للعربية و«, » لغيرها (§8.7). */
export const joinList = (lang: string, items: readonly string[]): string => items.join(lang === 'ar' ? '، ' : ', ');

/** سقف المعرّفات في طلب تصدير واحد (الخادم يرفض ما فوقه). */
export const EXPORT_IDS_MAX = 1000;

/** يقسّم المعرّفات دفعات لا تتجاوز السقف؛ القائمة الفارغة ⇒ لا دفعات. */
export const chunkIds = (ids: readonly string[], size = EXPORT_IDS_MAX): string[][] => {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
};

// ═══ «ربط الدفاتر» L4/L5/L8 (A11): أسباب الخادم الجديدة وتسميات شاشات العمليات ═══

/**
 * أسباب يردّها الخادم تحت routes/ledger وservices/gl منذ «ربط الدفاتر» (خريطة الطرق، تسويات الذمم، التسوية الموجّهة، تقارير
 * الشركاء، المرفقات، ثابت بُعد العهدة) — تُنشر في ledgerConfigReasonLabels فتصل ledgerReasonLabels وحارس errors.test.
 * عامة الصياغة: السبب الواحد قد يردّه أكثر من مسار (INVALID_KIND للتسوية والمرفقات)، والشاشة تقدّم تسميتها الأدق.
 */
export const ledgerLinkedReasonLabels = (tr: Tr): Record<string, string> => ({
  BOOKS_NOT_LINKED: tr('هذه العملية متاحة حين تكون الدفاتر مربوطة بالنظام'),
  MANUAL_BOOKS: tr('هذا الإعداد للدفاتر المربوطة بالنظام وحدها، ودفاتر الشركة يدوية مستقلة'),
  BEFORE_CUTOVER: tr('تاريخ المستند قبل بداية الدفاتر المربوطة'),
  ALREADY_CANCELLED: tr('التسوية ملغاة مسبقاً'),
  ADJUSTMENT_WITHOUT_MOVE: tr('التسوية بلا قيد مرحّل فلا تُلغى من هنا: راجع أحداث الترحيل'),
  INVALID_STATUS: tr('حالة غير معروفة'),
  INVALID_KIND: tr('النوع المطلوب غير معروف'),
  CREDIT_LINE_MISSING: tr('تعذّر إيجاد سطر تصفية الحساب الوسيط في القيد، أعد المحاولة'),
  CUSTODY_NONCASH: tr('لا تُوجَّه التحويلات البنكية ونقاط البيع إلى عهدة المندوب'),
  INVALID_METHOD_KEY: tr('مفتاح طريقة الدفع غير معروف'),
  METHOD_NOT_FOUND: tr('طريقة الدفع غير موجودة'),
  JOURNAL_TYPE: tr('دفتر الطريقة يجب أن يكون دفتر نقد أو بنك أو عمليات عامة'),
  PARTNER_NOT_FOUND: tr('الشريك غير موجود في هذه الشركة'),
  INVALID_BUCKETS: tr('أعمدة الأعمار أربعة أعداد صحيحة موجبة متزايدة مثل 30,60,90,120'),
  SOURCE_ID_REQUIRED: tr('المستند المصدر مطلوب'),
  SOURCE_NOT_FOUND: tr('المستند المصدر غير موجود'),
  ATTACHMENT_NOT_FOUND: tr('المرفق غير موجود'),
  CUSTODY_PARTNER_AMBIGUOUS: tr('سطر العهدة يحمل مندوباً ومستخدماً معاً: اختر أحدهما'),
  // «ربط الدفاتر» L7/L9: اعتماد الربط (POST /linking/commit)
  FINAL_ACK_REQUIRED: tr('ربط الدفاتر نهائي لا رجعة فيه — أقرّ بذلك قبل الاعتماد'),
  NAME_REQUIRED: tr('اكتب اسم الشركة كما هو تماماً لتأكيد ربط الدفاتر'),
  CONVERSION_UNAVAILABLE: tr('تحويل الدفاتر اليدوية القائمة إلى مربوطة يُتاح قريباً مع إدخال أرصدة بداية السنة — لا تغيير على دفاترك'),
  INVENTORY_TOO_LARGE: tr('حركات مخزون الشركة أكثر من أن تُقيَّم بأمان عند الاعتماد — لم يُربط شيء ولم يتغيّر شيء؛ تواصل مع الدعم'),
});

/** خريطة طرق الدفع: أسباب رفض الحساب (MethodAccountProblem في routes/ledger/paymentMethodMap.ts) */
export const paymentMethodMapReasonLabels = (tr: Tr): Record<string, string> => ({
  ARCHIVED: tr('الحساب مؤرشف'),
  TYPE: tr('حساب الطريقة يجب أن يكون حساب نقد أو بنك أو أصلاً متداولاً'),
  CONTROL: tr('لا يُربط بطريقة دفع حسابٌ رئيسي كذمم العملاء أو عهدة المندوب أو المستخدم'),
  FORBIDDEN: tr('لا تُربط طريقة دفع بالحساب المعلّق ولا بأمانات الدفع الإلكتروني'),
  MANUAL_BOOKS: tr('خريطة طرق الدفع تسري على الدفاتر المربوطة بالنظام وحدها'),
});

/** تسويات ذمم العملاء: أسباب المستند والتخصيص والرصيد (routes/ledger/customerAdjustments.ts) */
export const customerAdjustmentReasonLabels = (tr: Tr): Record<string, string> => ({
  AMOUNT_NOT_POSITIVE: tr('المبلغ يجب أن يكون أكبر من صفر'),
  PRECISION: tr('المبلغ فيه منازل عشرية أكثر مما تسمح به العملة'),
  DOC_DATE_IN_FUTURE: tr('تاريخ المستند بعد اليوم'),
  COUNTER_ACCOUNT_MISSING: tr('الحساب المقابل للتسوية غير موجود في دليل الحسابات'),
  REFUND_WITH_ALLOCATIONS: tr('ردّ الرصيد الدائن لا يُخصَّص على فواتير'),
  ALLOCATIONS_REQUIRED: tr('حدّد الفواتير المشطوبة ومبالغها أو اختر التخصيص التلقائي'),
  INVOICE_NOT_FOUND: tr('فاتورة في التخصيص غير موجودة'),
  OTHER_CUSTOMER: tr('فاتورة في التخصيص لعميل آخر'),
  NOT_CONFIRMED: tr('فاتورة في التخصيص ليست معتمدة'),
  NOT_CREDIT: tr('الشطب على الفواتير الآجلة وحدها'),
  ZATCA_PENDING: tr('فاتورة في التخصيص لم تعتمدها هيئة الزكاة والضريبة بعد'),
  EXCEEDS_REMAINING: tr('مبلغ التخصيص أكبر من المتبقّي على الفاتورة'),
  SUM_MISMATCH: tr('مجموع التخصيصات لا يساوي مبلغ الشطب'),
  AUTO_INSUFFICIENT: tr('متبقّي فواتير العميل المفتوحة أقل من مبلغ الشطب'),
  WRITEOFF_EXCEEDS_DEBIT_BALANCE: tr('مبلغ الشطب أكبر من الرصيد المدين للعميل'),
  REFUND_EXCEEDS_CREDIT_BALANCE: tr('مبلغ الردّ أكبر من الرصيد الدائن للعميل'),
  BOOKS_NOT_LINKED: tr('تسويات ذمم العملاء متاحة حين تكون الدفاتر مربوطة بالنظام'),
  BEFORE_CUTOVER: tr('تاريخ المستند قبل بداية الدفاتر المربوطة'),
  // تحقّق الواجهة قبل الإرسال (لا يردّها الخادم بهذه الأسماء)
  CUSTOMER_REQUIRED: tr('اختر العميل'),
  AMOUNT_REQUIRED: tr('أدخل المبلغ'),
  INVALID_AMOUNT: tr('مبلغ غير صالح'),
  INVALID_DATE: tr('تاريخ غير صالح'),
});

/** التسوية الموجّهة: أسباب الرفض (ClearingRouteReason في routes/ledger/clearing.ts) وتحقّق الواجهة */
export const clearingReasonLabels = (tr: Tr): Record<string, string> => ({
  INVALID_KIND: tr('نوع التسوية غير معروف'),
  INVALID_DATE: tr('تاريخ غير صالح'),
  GROSS_NOT_POSITIVE: tr('الإجمالي يجب أن يكون أكبر من صفر'),
  FEE_NEGATIVE: tr('العمولة لا تكون سالبة'),
  FEE_VAT_NEGATIVE: tr('ضريبة العمولة لا تكون سالبة'),
  FEES_EXCEED_GROSS: tr('العمولة وضريبتها أكبر من الإجمالي'),
  FEE_VAT_WITHOUT_FEE: tr('ضريبة العمولة بلا عمولة'),
  PRECISION: tr('المبلغ فيه منازل عشرية أكثر مما تسمح به العملة'),
  BANK_ACCOUNT_NOT_FOUND: tr('حساب البنك غير موجود'),
  BANK_ACCOUNT_INACTIVE: tr('حساب البنك مؤرشف'),
  BANK_ACCOUNT_NOT_CASH: tr('الحساب المستلِم يجب أن يكون حساب نقد أو بنك'),
  BANK_ACCOUNT_CONTROL: tr('لا يجوز الإيداع في حساب رئيسي كعهدة المندوب أو المستخدم'),
  CLEARING_ACCOUNT_MISSING: tr('الحساب الوسيط لهذا النوع غير موجود في دليل الحسابات'),
  CLEARING_ACCOUNT_INACTIVE: tr('الحساب الوسيط لهذا النوع مؤرشف'),
  BANK_IS_CLEARING: tr('حساب البنك هو الحساب الوسيط نفسه'),
  FEE_ACCOUNT_MISSING: tr('حساب الرسوم البنكية غير مربوط أو مؤرشف'),
  VAT_TAX_UNAVAILABLE: tr('لا توجد ضريبة مشتريات صالحة لضريبة العمولة: أدخل العمولة شاملة الضريبة أو فعّل ضريبة المشتريات'),
  LINE_OTHER_ACCOUNT: tr('سطر مختار من حساب غير الحساب الوسيط لهذا النوع'),
  LINE_NOT_OPEN: tr('سطر مختار غير مفتوح: مطابَق بالكامل أو ليس سطراً مديناً مرحّلاً'),
  EXCEEDS_OPEN: tr('الإجمالي أكبر من المتبقّي المفتوح في السطور المختارة'),
  EXCEEDS_BALANCE: tr('الإجمالي أكبر من رصيد الحساب الوسيط'),
  CREDIT_LINE_MISSING: tr('تعذّر إيجاد سطر تصفية الحساب الوسيط في القيد، أعد المحاولة'),
  // تحقّق الواجهة قبل الإرسال
  GROSS_REQUIRED: tr('أدخل الإجمالي'),
  INVALID_AMOUNT: tr('مبلغ غير صالح'),
  BANK_REQUIRED: tr('اختر الحساب المستلِم'),
  NO_OPEN_LINES: tr('لا سطور مفتوحة على الحساب الوسيط لهذا النوع'),
});

/** رموز رفض إلغاء السند حين يُحدَّد مصدر الردّ (services/receiptCancelSource.ts) */
export const receiptCancelCodeLabels = (tr: Tr): Record<string, string> => ({
  RECEIPT_CANCEL_REFUND_USER: tr('مستخدم الشركة المختار غير صالح أو عهدته لا تكفي لردّ مبلغ السند: اختر مصدراً آخر للردّ'),
  RECEIPT_CANCEL_REFUND_INVALID: tr('مصدر الردّ غير معروف'),
  // مراجعة ١٤ نوفمبر: الإسناد إلى عهدة مستخدمٍ آخر لصاحب صلاحية عهدة التحصيل وحده (403)
  RECEIPT_CANCEL_REFUND_USER_FORBIDDEN: tr('الردّ من عهدة مستخدمٍ آخر يتطلّب صلاحية عهدة التحصيل: اختر المصدر المقترح أو عهدتك أو مصدراً آخر'),
});

/** مصدر ردّ مال السند الملغى (Receipt.cancelRefundFrom، C11) — الخادم يرسل الاسم عربياً والواجهة تترجم بالمفتاح */
export const cancelRefundSourceLabels = (tr: Tr): Record<CancelRefundFrom, string> => ({
  REP_CUSTODY: tr('من عهدة المندوب'),
  USER_CUSTODY: tr('من عهدة مستخدم الشركة'),
  MAIN_CASH: tr('من الصندوق الرئيسي'),
  BANK: tr('من الحساب البنكي'),
  METHOD: tr('من حساب طريقة الدفع نفسها'),
});

export const customerAdjustmentKindLabels = (tr: Tr): Record<CustomerAdjustmentKind, string> => ({
  BAD_DEBT_WRITEOFF: tr('شطب دين معدوم'),
  CREDIT_REFUND: tr('ردّ رصيد دائن للعميل'),
});

export const customerAdjustmentStatusLabels = (tr: Tr): Record<CustomerAdjustmentStatus, string> => ({
  ACTIVE: tr('نشط'),
  CANCELLED: tr('ملغى'),
});

/** الحساب المقابل للشطب — اسما حسابي القالب (مفتاحا BAD_DEBT وDOUBTFUL_ALLOWANCE في mappingKeyLabels) */
export const writeoffCounterLabels = (tr: Tr): Record<WriteoffCounter, string> => ({
  BAD_DEBT: tr('ديون معدومة'),
  ALLOWANCE: tr('مخصص الديون المشكوك في تحصيلها'),
});

export const clearingKindLabels = (tr: Tr): Record<ClearingKind, string> => ({
  POS_SETTLEMENT: tr('تسوية مقبوضات نقاط البيع'),
  CARD_SETTLEMENT: tr('تسوية تحصيلات البطاقة'),
  CHEQUE_CLEARANCE: tr('تحصيل شيكات العملاء'),
  DEPOSIT_CLEARANCE: tr('إيداع مقبوضات قيد الإيداع'),
});

/** بنود تفسير فرق العهدة (custodyExplain، OD3) — أثر كل بند الموقَّع على (الشاشة التشغيلية − الأستاذ) */
export const custodyExplainKindLabels = (tr: Tr): Record<CustodyExplainKind, string> => ({
  OPENING: tr('فرق الرصيد الافتتاحي'),
  ONLINE: tr('سند إلكتروني تعدّه الشاشة خارج العهدة'),
  OUTSIDE: tr('سند تعدّه الشاشة ولا يدخل العهدة'),
  STAMPED_OUTSIDE: tr('فاتورة نقدية مختومة قُيّد نقدها خارج العهدة'),
  EXPENSE: tr('مصروف من العهدة'),
  SHORTAGE: tr('عجز العهدة'),
  SHORTAGE_EXPENSED: tr('عجز محمّل على المصروف'),
  SETTLEMENT_R: tr('ما صفّاه الاستلام من خارج العهدة'),
  CANCEL_REFUND_OUTSIDE: tr('إلغاء سند رُدّ ماله من خارج العهدة'),
  CASH_INVOICE_CUSTODY: tr('فاتورة نقدية في العهدة لا تعدّها الشاشة'),
});
