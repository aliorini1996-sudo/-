// تجميع «المتبقي» بعد التراجع الجزئي عن دفعة استيراد حسب السبب (blocked[].reason من الخادم):
// المحمي بمعاملات حقيقية لا يُعاد، أما انشغال قفل الدفاتر أو خطأ الحذف العابر فيُعاد لاحقاً.
import { errorDetail, errorResponseOf, headerSaysPriceIncludesTax } from './importData';
import { IMPORT_SCOPED_NOTE } from './importAccess';

/** نص الخادم حرفياً (backend/src/services/importLedger.ts LEDGER_BUSY_MESSAGE) */
export const REVERT_LEDGER_BUSY = 'جارٍ تفعيل الدفاتر، أعد المحاولة';
/** بادئة خطأ الحذف العابر («تعذّر الحذف: <رسالة>») — مفتاح ثابت لا يمرّر نص الخطأ الخام عبر tr */
export const REVERT_DELETE_FAILED = 'تعذّر الحذف';
/** سبب غائب من خادم قديم */
export const REVERT_PROTECTED_FALLBACK = 'سجل محمي';

export interface RevertBlockedItem { id?: string; name?: string | null; reason?: string }
export interface RevertGroup {
  /** مفتاح عربي يُمرَّر عبر tr() */
  key: string;
  /** يُعاد لاحقاً (قفل الدفاتر أو خطأ عابر) لا محمي */
  retry: boolean;
  count: number;
  names: string[];
}

export function revertReasonKey(reason: string | undefined): { key: string; retry: boolean } {
  const r = String(reason ?? '').trim();
  if (!r) return { key: REVERT_PROTECTED_FALLBACK, retry: false };
  if (r === REVERT_LEDGER_BUSY) return { key: REVERT_LEDGER_BUSY, retry: true };
  if (r.startsWith(REVERT_DELETE_FAILED)) return { key: REVERT_DELETE_FAILED, retry: true };
  return { key: r, retry: false };
}

/** تجميع بترتيب الظهور: المحمي أولاً ثم ما يُعاد */
export function groupRevertBlocked(list: readonly RevertBlockedItem[]): RevertGroup[] {
  const map = new Map<string, RevertGroup>();
  for (const b of list) {
    const { key, retry } = revertReasonKey(b?.reason);
    let g = map.get(key);
    if (!g) { g = { key, retry, count: 0, names: [] }; map.set(key, g); }
    g.count++;
    if (b?.name) g.names.push(b.name);
  }
  const groups = [...map.values()];
  return [...groups.filter((g) => !g.retry), ...groups.filter((g) => g.retry)];
}

// ═══ نص تأكيد التراجع بحسب نوع الدفعة (البندان 7 و17) ═══

/** المخزون الافتتاحي: النص القائم كما هو */
export const REVERT_CONFIRM_OPENING_STOCK = 'ستحذف حركة المخزون الافتتاحي ببنودها ما لم تستهلك أصنافها بعد الاستيراد بتحميل سيارات أو فواتير أو تسوية بالنقص';
/** الأرصدة والكشوف بعد تفعيل الدفاتر: النص القائم كما هو */
export const REVERT_CONFIRM_LEDGER_ACTIVE = 'يُزال من كشوف العملاء وتُكتب في الدفاتر قيود عكسية؛ لا يُحذف قيد مرحّل';
/** الأرصدة والكشوف قبل التفعيل: حذف القيود وإعادة حساب الأرصدة (لا «إعادة الأرصدة إلى ما قبلها») */
export const REVERT_CONFIRM_ENTRIES = 'ستُحذف القيود المستوردة في هذه الدفعة ويُعاد حساب أرصدة العملاء';
/** البند 7: الأسعار تُعاد إلى سابقها، وما تغيّر بعد الدفعة لا يُمَس */
export const REVERT_CONFIRM_PRICES = 'ستُعاد الأسعار الخاصة إلى ما كانت عليه قبل هذه الدفعة ويُحذف ما أُنشئ فيها، والسعر الذي تغيّر بعدها يدوياً أو بدفعة أحدث يبقى كما هو';
/** البند 17: العميل ذو القيود أو الأسعار أو المحطات يبقى ولا يُحذف بصمت */
export const REVERT_CONFIRM_CUSTOMERS = 'سيُحذف العملاء المستوردون في هذه الدفعة، ويبقى من له فواتير أو سندات أو زيارات أو قيود في كشف الحساب أو أسعار خاصة أو محطات في خطوط السير';
export const REVERT_CONFIRM_PRODUCTS = 'ستُحذف الأصناف المستوردة في هذه الدفعة ما لم تُستعمل في فواتير أو تحميلات أو حركات مستودع، وتبقى الفئات المربوطة بحسابات أو بمسودة الدفاتر';
/** نوع غير معروف (خادم أحدث): النص العام القائم */
export const REVERT_CONFIRM_GENERIC = 'سيزال ما أضيف في هذه الدفعة نهائيا وتعاد الأرصدة إلى ما قبلها متابعة';

/** مفتاح tr لرسالة تأكيد التراجع: صادق بحسب نوع الدفعة وحالة الدفاتر */
export function revertConfirmKey(kind: string | undefined, ledgerActivated: boolean): string {
  switch (kind) {
    case 'opening_stock': return REVERT_CONFIRM_OPENING_STOCK;
    case 'prices': return REVERT_CONFIRM_PRICES;
    case 'customers': return REVERT_CONFIRM_CUSTOMERS;
    case 'products': return REVERT_CONFIRM_PRODUCTS;
    case 'balances':
    case 'ledger': return ledgerActivated ? REVERT_CONFIRM_LEDGER_ACTIVE : REVERT_CONFIRM_ENTRIES;
    default: return REVERT_CONFIRM_GENERIC;
  }
}

// ═══ حالة الدفعة في سجل الاستيرادات (GET /import/batches status) ═══

export type ImportBatchStatus = 'running' | 'interrupted' | 'done';
export const BATCH_RUNNING_LABEL = 'قيد الاستيراد';
export const BATCH_INTERRUPTED_LABEL = 'انقطع';

export interface BatchStatusView {
  status: ImportBatchStatus;
  /** وسم عربي يُمرَّر عبر tr (null للمنتهية) */
  label: string | null;
  /** التراجع متاح: الجارية 409 IMPORT_BATCH_RUNNING، والمنقطعة يُتراجع عمّا سُجّل منها */
  revertable: boolean;
  /** العدد نهائي — الجارية تُحفظ دفعات، والمنقطعة ما سُجّل منها قبل الانقطاع */
  countFinal: boolean;
}

/** status غائب (خادم أقدم أو دفعة ما قبل الحجز) أو غير معروف ⇒ منتهية */
export function batchStatusView(b: { status?: string | null }): BatchStatusView {
  if (b.status === 'running') return { status: 'running', label: BATCH_RUNNING_LABEL, revertable: false, countFinal: false };
  if (b.status === 'interrupted') return { status: 'interrupted', label: BATCH_INTERRUPTED_LABEL, revertable: true, countFinal: false };
  return { status: 'done', label: null, revertable: true, countFinal: true };
}

/** إعادة جلب السجل ما دامت فيه دفعة جارية */
export const hasRunningBatch = (list: readonly { status?: string | null }[] | undefined): boolean =>
  !!list?.some((b) => batchStatusView(b).status === 'running');

// ═══ تصنيف فشل التراجع (صرف) ═══

/** نص الخادم حرفياً (importLedger.ts OPENING_STOCK_REVERT_LEDGER_ACTIVE_MESSAGE) */
export const OPENING_STOCK_REVERT_ACTIVE = 'الدفاتر مفعّلة: المخزون الافتتاحي دخل القيد الافتتاحي فلا يُتراجع عنه — صحّحه بتسوية مستودع';
export const REVERT_BATCH_RUNNING = 'الدفعة ما زالت قيد الاستيراد — انتظر انتهاءها ثم تراجع عنها';
export const REVERT_BATCH_GONE = 'الدفعة غير موجودة أو متراجع عنها';
export const NETWORK_LOST_MESSAGE = 'انقطع الاتصال قبل وصول رد الخادم وقد تكون العملية تمت. تحقق من سجل الاستيرادات قبل إعادة المحاولة';

export type RevertFailure =
  | { type: 'network' }
  | { type: 'running'; batchId?: string }
  /** البند 19: دفعة أرصدة/كشوف أخرى جارية تمنع التراجع (409 IMPORT_IN_PROGRESS) */
  | { type: 'inProgress'; kind?: string }
  | { type: 'ledgerBusy' }
  | { type: 'openingStockActive' }
  | { type: 'gone' }
  /** 403 IMPORT_SCOPED_ADMIN / IMPORT_PERMISSION_DENIED / ACCOUNTING_NOT_ALLOWED (البندان 5 و21) */
  | { type: 'scopedAdmin' }
  | { type: 'permissionDenied'; kind?: string; permission?: string }
  | { type: 'accountingDisabled' }
  /** status محفوظ ليُميَّز انقطاع النشر المؤقّت (502/503/504) عن خطأ تطبيق — البند 52 */
  | { type: 'other'; message?: string; status?: number };

export function classifyRevertFailure(e: unknown): RevertFailure {
  const { status, body: b, network } = errorResponseOf(e);
  if (network) return { type: 'network' };
  const access = classifyAccessFailure(e);
  if (access) return access;
  switch (b.code) {
    case 'IMPORT_BATCH_RUNNING': return { type: 'running', batchId: typeof errorDetail(b, 'batchId') === 'string' ? errorDetail(b, 'batchId') as string : undefined };
    // البند 19: التراجع عن الأرصدة/الكشوف يرفض دفعة قيود أخرى جارية
    case 'IMPORT_IN_PROGRESS': return { type: 'inProgress', kind: typeof errorDetail(b, 'kind') === 'string' ? errorDetail(b, 'kind') as string : undefined };
    case 'IMPORT_REVERT_LEDGER_BUSY': return { type: 'ledgerBusy' };
    case 'OPENING_STOCK_REVERT_LEDGER_ACTIVE': return { type: 'openingStockActive' };
  }
  if (status === 404) return { type: 'gone' };
  return { type: 'other', message: typeof b.message === 'string' ? b.message : undefined, status };
}

/** المفتاح العربي (يُمرَّر عبر tr) لرسالة فشل التراجع؛ other بلا رسالة ⇒ null (الافتراضي «تعذر التراجع») */
export function revertFailureKey(f: RevertFailure): string | null {
  switch (f.type) {
    case 'network': return NETWORK_LOST_MESSAGE;
    case 'running': return REVERT_BATCH_RUNNING;
    case 'inProgress': return IMPORT_IN_PROGRESS_TEXT;
    case 'ledgerBusy': return REVERT_LEDGER_BUSY;
    case 'openingStockActive': return OPENING_STOCK_REVERT_ACTIVE;
    case 'gone': return REVERT_BATCH_GONE;
    case 'scopedAdmin':
    case 'permissionDenied':
    case 'accountingDisabled':
      return accessFailureKey(f, 'revert');
    // البند 52: 502/503/504 أثناء النشر ليست خطأ تطبيق — نصّها يقول إن الخدمة تُحدَّث
    case 'other': return isServiceUnavailable(f) ? SERVICE_UNAVAILABLE_MESSAGE : null;
    default: return null;
  }
}

// ═══ الصلاحيات والنطاق والدفاتر (البندان 5 و21) ═══

/** نص الخادم حرفياً (backend/src/services/importAccess.ts IMPORT_PERMISSION_DENIED_MESSAGE) */
export const IMPORT_PERMISSION_DENIED = 'لا تملك صلاحية استيراد هذا النوع من البيانات';
export const REVERT_PERMISSION_DENIED = 'لا تملك صلاحية التراجع عن هذا النوع من البيانات';
/** نص requireAccounting حرفياً (ACCOUNTING_NOT_ALLOWED) */
export const ACCOUNTING_DISABLED = 'النظام المحاسبي غير مفعّل لهذه الشركة تواصل مع مزود الخدمة';

/** رموز الوصول المشتركة بين الاستيراد والتراجع */
export type ImportAccessFailure =
  | { type: 'scopedAdmin' }
  | { type: 'permissionDenied'; kind?: string; permission?: string }
  | { type: 'accountingDisabled' };

export function classifyAccessFailure(e: unknown): ImportAccessFailure | null {
  const { body: b, network } = errorResponseOf(e);
  if (network) return null;
  const s = (k: string) => { const v = errorDetail(b, k); return typeof v === 'string' && v ? v : undefined; };
  switch (b.code) {
    case 'IMPORT_SCOPED_ADMIN': return { type: 'scopedAdmin' };
    case 'IMPORT_PERMISSION_DENIED': return { type: 'permissionDenied', kind: s('kind'), permission: s('permission') };
    case 'ACCOUNTING_NOT_ALLOWED': return { type: 'accountingDisabled' };
    default: return null;
  }
}

/** مفتاح tr لرفض الوصول؛ revert يغيّر نص الصلاحية */
export function accessFailureKey(f: { type: string }, mode: 'import' | 'revert'): string | null {
  switch (f.type) {
    case 'scopedAdmin': return IMPORT_SCOPED_NOTE;
    case 'permissionDenied': return mode === 'revert' ? REVERT_PERMISSION_DENIED : IMPORT_PERMISSION_DENIED;
    case 'accountingDisabled': return ACCOUNTING_DISABLED;
    default: return null;
  }
}

// ═══ نافذة نتيجة الاستيراد (البند 8) ═══

export const RESULT_SUCCESS_TITLE = 'تم الاستيراد';
export const RESULT_FAILURE_TITLE = 'لم يُستورد شيء';
export const RESULT_WARNING_TITLE = 'اكتمل الاستيراد مع ملاحظات';

/** field = عمود الملف الذي جاءت منه value (عقد الخادم importLedger.ts ImportRowError) */
export interface ImportResultRowError { row: number; message: string; code?: string; value?: string; field?: string }
export interface ImportResultView {
  tone: 'success' | 'warning' | 'failure';
  titleKey: string;
  /**
   * attached: العملاء — أكواد رُبطت بعملاء قائمين بلا كود (تعديل لا إنشاء).
   * updated: الأسعار — أزواج كان لها سعر سابق فاستُبدل (البند 7): كتابة فعلية لا «لم يُستورد شيء».
   */
  counts: { created: number; updated: number; attached: number; skipped: number; zero: number; notFound: number; ambiguous: number; otherErrors: number };
}

/** نص الخادم حرفياً (backend/src/services/importLedger.ts IMPORT_ROW_MESSAGES.CUSTOMER_CODE_NOT_FOUND)، والكود في value */
export const CUSTOMER_CODE_NOT_FOUND_MESSAGE = 'كود العميل غير مسجّل، ويوجد عميل بالاسم أو الجوال نفسه بلا كود: أضف الكود في بطاقة العميل أو احذف عمود الكود من الملف ليُطابَق بالجوال والاسم';

/** رموز صفوف «عميل غير مطابق» (خانة notFound) */
const NOT_FOUND_ROW_CODES: ReadonlySet<string> = new Set(['CUSTOMER_NOT_FOUND', 'CUSTOMER_CODE_NOT_FOUND', 'CUSTOMER_CODE_UNREGISTERED']);

/** نص الخادم حرفياً (IMPORT_ROW_MESSAGES.CUSTOMER_CODE_UNREGISTERED): صف بالكود وحده والشركة فيها عملاء بلا كود */
export const CUSTOMER_CODE_UNREGISTERED_MESSAGE = 'كود العميل غير مسجّل، ولدى الشركة عملاء بلا كود: استورد ملف العملاء بعمود الكود مع الاسم أو الجوال ليُربط الكود بعملائه، أو أضف عمود الاسم أو الجوال إلى هذا الملف';

/** نصوص الخادم حرفياً (IMPORT_ROW_MESSAGES) لرموز المخزون الافتتاحي والمنتجات — البنود 15 و16 و30 */
export const PRODUCT_INACTIVE_MESSAGE = 'الصنف موقوف أو مؤرشف، فعّله أو استخدم صنفاً آخر';
export const PRODUCT_AMBIGUOUS_MESSAGE = 'الباركود أو الاسم مشترك بين أكثر من صنف، استخدم الكود';
export const OPENING_STOCK_ALREADY_IMPORTED_MESSAGE = 'للصنف مخزون افتتاحي في دفعة استيراد سابقة، تراجع عنها أولاً لتصحيحه';
export const PRODUCT_HAS_STOCK_MOVEMENTS_MESSAGE = 'للصنف حركات مستودع أو تحميل سيارات سابقة، فلا يُضاف جرده الافتتاحي فوق رصيد محسوب منها. صحّح رصيده بتسوية من شاشة المستودع';
export const PRODUCT_CODE_ARCHIVED_MESSAGE = 'الكود مستخدم بصنف مؤرشف، استخدم كوداً مختلفاً';
export const PRODUCT_DUPLICATE_IN_FILE_MESSAGE = 'كود الصنف مكرر في الملف ببيانات مختلفة، أضف عمود الكود أو صحّح التكرار';

/** الرمز ⇒ نصه الثابت (يُمرَّر عبر tr) — الرموز غير المذكورة تأخذ رسالة الخادم كما جاءت */
const ROW_CODE_MESSAGES: Readonly<Record<string, string>> = {
  CUSTOMER_CODE_NOT_FOUND: CUSTOMER_CODE_NOT_FOUND_MESSAGE,
  CUSTOMER_CODE_UNREGISTERED: CUSTOMER_CODE_UNREGISTERED_MESSAGE,
  PRODUCT_INACTIVE: PRODUCT_INACTIVE_MESSAGE,
  PRODUCT_AMBIGUOUS: PRODUCT_AMBIGUOUS_MESSAGE,
  OPENING_STOCK_ALREADY_IMPORTED: OPENING_STOCK_ALREADY_IMPORTED_MESSAGE,
  PRODUCT_HAS_STOCK_MOVEMENTS: PRODUCT_HAS_STOCK_MOVEMENTS_MESSAGE,
  PRODUCT_CODE_ARCHIVED: PRODUCT_CODE_ARCHIVED_MESSAGE,
  PRODUCT_DUPLICATE_IN_FILE: PRODUCT_DUPLICATE_IN_FILE_MESSAGE,
};

/** مفتاح tr لخطأ صف: الرمز المعروف بنصه الثابت (لا يتأثر بتغيّر صياغة الخادم)، وإلا رسالة الخادم */
export function importRowErrorKey(e: { code?: string; message: string; row?: number; value?: string }): string {
  return (e.code && ROW_CODE_MESSAGES[e.code]) || e.message;
}

/** البند 15: تلميح نافذة نتيجة المخزون الافتتاحي حين أصناف مستوردة في دفعة سابقة منعت جردها */
export const OPENING_STOCK_REVERT_HINT = 'تراجع عن الدفعة السابقة من سجل الاستيرادات لتصحيحها';

/**
 * البند 15: صنف أو أكثر رُفض لأنه مستورد في دفعة سابقة ⇒ اعرض تلميح التراجع عنها.
 * يظهر في الاستيراد الجزئي أيضاً: كُتب بعض الأصناف ورُفض بعضها يبقى المالك بحاجة إلى المسار نفسه.
 */
export function openingStockRevertHint(
  kind: string, res: { created?: number; errors?: readonly { row?: number; code?: string; message?: string }[] | null },
): boolean {
  if (kind !== 'opening_stock') return false;
  return (res.errors ?? []).some((e) => e?.code === 'OPENING_STOCK_ALREADY_IMPORTED');
}

/** معرّف داخلي (UUID) لا يعني المالك شيئاً ولا تنقله الواجهة إلى أي شاشة */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * البند K: رموز قيمتها **تاريخ الدفعة السابقة** بصيغة YYYY-MM-DD (عقد الخادم)، لا معرّفها.
 * خادم أقدم كان يضع المعرّف نفسه، فحارس الشكل أدناه يُخفي ما ليس تاريخاً بدل عرض UUID للمالك.
 */
const PREVIOUS_BATCH_DATE_CODES: ReadonlySet<string> = new Set(['OPENING_STOCK_ALREADY_IMPORTED']);
const LOCAL_DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/** قالب عبارة الدفعة السابقة — يُمرَّر عبر tr ثم يُستبدل {date} بتاريخ الواجهة (formatDayOnly) */
export const OPENING_STOCK_PREVIOUS_BATCH_DATE = 'استُوردت سابقاً في دفعة بتاريخ {date}';

export type ImportRowErrorValue =
  /** قيمة حرفية من ملف المالك (كود صنف أو مبلغ أو جوال) تُعرض كما هي */
  | { kind: 'text'; value: string }
  /** تاريخ دفعة الاستيراد السابقة (YYYY-MM-DD) ⇒ عبارة تدلّ على الدفعة التي يتراجع عنها */
  | { kind: 'previousBatchDate'; date: string };

/**
 * قيمة خطأ الصف كما تُعرض بعد رسالته: تاريخ الدفعة السابقة يصير عبارة تدلّ المالك على الدفعة
 * التي يتراجع عنها، والمعرّفات الداخلية تُحجب (العقد يبقيها في الرد للتشخيص والسجلات)،
 * وما عداها — كود الصنف أو المبلغ أو الجوال — يُعرض كما هو لأنه هو ما يبحث عنه المالك في ملفه.
 */
export function importRowErrorValue(e: { code?: string; value?: string } | null | undefined): ImportRowErrorValue | null {
  const raw = e?.value;
  if (!raw) return null;
  const v = raw.trim();
  if (!v) return null;
  if (e?.code && PREVIOUS_BATCH_DATE_CODES.has(e.code)) {
    // حارس شكل: خادم أقدم يضع معرّف الدفعة لا تاريخها ⇒ يُخفى كما كان
    return LOCAL_DATE_RE.test(v) ? { kind: 'previousBatchDate', date: v } : null;
  }
  return UUID_RE.test(v) ? null : { kind: 'text', value: raw };
}

/**
 * البند L: وسم الخانة التي جاءت منها قيمة الخطأ (field) ⇒ مفتاح tr عربي، فيعرف المالك في أيّ عمود
 * يبحث في ملفه («كود الصنف: C1») بدل أن يقف أمام قيمة مجرّدة في ملف آلاف الصفوف.
 * null حين لا يفيد الوسم:
 *  • لا قيمة تُعرض أصلاً، أو القيمة تاريخ دفعة سابقة — حارس الشكل يبقيه تاريخاً وحده بلا خانة؛
 *  • خانة بلا وسم عربي (اسم داخلي إنجليزي: ضجيج لا يعني المالك)؛
 *  • الرسالة تذكر الخانة سلفاً («السعر لا يكون سالباً» + «السعر») فلا تُكرَّر.
 */
export function importRowErrorFieldKey(
  e: { code?: string; message?: string; value?: string; field?: string } | null | undefined,
): string | null {
  const v = importRowErrorValue(e);
  if (!v || v.kind !== 'text') return null;
  const field = e?.field?.trim();
  const label = field ? FIELD_LABELS[field] : undefined;
  if (!label) return null;
  const message = (e?.code && ROW_CODE_MESSAGES[e.code]) || e?.message || '';
  return message.includes(label) ? null : label;
}

/**
 * البند 36: خطأ صفٍّ أرسله الخادم بلا قيمة — الخانة الفارغة لا قيمة لها تُعرض، ورسالتها عامة
 * («خانة مطلوبة في هذا الصف فارغة»)، فوسم الخانة وحده ما يدلّ المالك على العمود الذي يصحّحه.
 * null حين يرسل الخادم قيمةً (وسمها يظهر معها في importRowErrorFieldKey)، أو الخانة بلا وسم عربي،
 * أو الرسالة تذكرها سلفاً.
 */
export function importRowFieldOnlyKey(
  e: { code?: string; message?: string; value?: string; field?: string } | null | undefined,
): string | null {
  if (e?.value?.trim()) return null;
  const field = e?.field?.trim();
  const label = field ? FIELD_LABELS[field] : undefined;
  if (!label) return null;
  const message = (e?.code && ROW_CODE_MESSAGES[e.code]) || e?.message || '';
  return message.includes(label) ? null : label;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * البند 36: الخادم يقصّ `errors` على 500 ويرسل العدد الكامل في `errorsTotal`. العدّادات المعروضة للمالك
 * تُقاس على العدد الكامل (وإلا قال «500 خطأ» لملف فيه 20 ألفاً فظنّ الباقي نجح)، بينما القائمة نفسها تبقى
 * المقصوصة. خادم أقدم بلا `errorsTotal` ⇒ طول القائمة كما كان.
 */
export const errorsTotalOf = (res: { errors?: readonly unknown[] | null; errorsTotal?: unknown }): number => {
  const shown = Array.isArray(res.errors) ? res.errors.length : 0;
  const total = count(res.errorsTotal);
  return total > shown ? total : shown;
};

export function importResultView(res: { created?: number; updated?: number; attached?: number; skipped?: number; zero?: number; errors?: readonly ImportResultRowError[] | null; errorsTotal?: number }): ImportResultView {
  const errors = Array.isArray(res.errors) ? res.errors : [];
  let notFound = 0; let ambiguous = 0;
  for (const e of errors) {
    if (NOT_FOUND_ROW_CODES.has(String(e?.code))) notFound++;
    else if (e?.code === 'CUSTOMER_AMBIGUOUS') ambiguous++;
  }
  // الباقي وراء السقف يُضاف إلى «أخطاء أخرى» فلا يضيع من عدّاد المالك
  const hidden = Math.max(0, errorsTotalOf(res) - errors.length);
  const counts = {
    created: count(res.created), updated: count(res.updated), attached: count(res.attached), skipped: count(res.skipped), zero: count(res.zero),
    notFound, ambiguous, otherErrors: errors.length - notFound - ambiguous + hidden,
  };
  // ربط الأكواد بعملاء قائمين، واستبدال سعر خاص قائم (البند 7): كتابة فعلية ليست «لم يُستورد شيء»
  if (counts.created === 0 && counts.attached === 0 && counts.updated === 0) return { tone: 'failure', titleKey: RESULT_FAILURE_TITLE, counts };
  if (errors.length === 0) return { tone: 'success', titleKey: RESULT_SUCCESS_TITLE, counts };
  return { tone: 'warning', titleKey: RESULT_WARNING_TITLE, counts };
}

/** سبب تخطي صف العملاء (skippedRows[].reason) ⇒ مفتاح tr */
export function customerSkipReasonKey(reason: string | undefined): string {
  switch (reason) {
    case 'CODE_EXISTS': return 'الكود موجود';
    case 'PHONE_EXISTS': return 'الجوال موجود';
    case 'NAME_EXISTS': return 'الاسم موجود';
    case 'CODE_ATTACHABLE': return 'عميل موجود بلا كود بالجوال أو الاسم نفسه';
    case 'CODE_AMBIGUOUS_NAME': return 'أكثر من عميل بلا كود بالاسم نفسه، أضف الجوال لتمييزه';
    default: return 'مكرر تخطي';
  }
}

/** البند 30: سبب تخطي صف المنتجات (skippedRows[].reason) ⇒ مفتاح tr */
export function productSkipReasonKey(reason: string | undefined): string {
  switch (reason) {
    case 'CODE_EXISTS': return 'الكود موجود';
    case 'DUPLICATE_IN_FILE': return 'مكرر داخل الملف بالبيانات نفسها';
    default: return 'مكرر تخطي';
  }
}

// ═══ البندان 43 و44: تخطّي صفوف الأسعار بسببه المعلن (planPriceImportRows) ═══
//
// كان صفّ الصنف المؤرشف يُعاد سعره الخاص ويُعدّ «أضيف»، وصفّان لنفس العميل والصنف يكتب آخرهما فوق أولهما
// بصمت. صار كلاهما تخطياً معدوداً برقم صفه، فيرى المالك **لماذا** نقص عدد ما كُتب عن عدد صفوف ملفه.

/** الرمز من الخادم حرفياً (services/importLedger.ts PriceSkipReason) */
export const PRICE_SKIP_PRODUCT_ARCHIVED = 'الصنف مؤرشف، فلا يُعاد سعره الخاص';
export const PRICE_SKIP_DUPLICATE_PAIR = 'صف مكرر لنفس العميل والصنف، آخر سعر في الملف هو المحفوظ';
/** عنوان كتلة أزواج التكرار المختلفة السعر — المتطابقة سعراً تكرار بلا أثر يكفيه عدّاد التخطي */
export const PRICE_DUPLICATE_PAIRS_TITLE = 'أزواج عميل وصنف تكررت في الملف بسعرين مختلفين، المحفوظ آخرها';
export const PRICE_DUPLICATE_KEPT_ROW = 'المحفوظ صف';

/** سبب تخطي صف الأسعار (skippedRows[].reason) ⇒ مفتاح tr */
export function priceSkipReasonKey(reason: string | undefined): string {
  switch (reason) {
    case 'PRODUCT_ARCHIVED': return PRICE_SKIP_PRODUCT_ARCHIVED;
    case 'DUPLICATE_PAIR': return PRICE_SKIP_DUPLICATE_PAIR;
    default: return 'مكرر تخطي';
  }
}

/** سبب التخطي بحسب نوع الدفعة: لكل نوع أسبابه، ولا تُخلط (سبب نوع آخر ⇒ النص العام) */
export function skipReasonKey(kind: string | undefined, reason: string | undefined): string {
  switch (kind) {
    case 'products': return productSkipReasonKey(reason);
    case 'prices': return priceSkipReasonKey(reason);
    default: return customerSkipReasonKey(reason);
  }
}

/**
 * عدّاد لكل سبب تخطٍّ بترتيب أول ظهوره: قائمة الصفوف تُقتطع عند خمسة عشر سطراً في النافذة،
 * فالعدّاد وحده يقول للمالك كم صفاً سقط بكل سبب.
 */
export function skipReasonCounts(
  kind: string | undefined, rows: readonly { reason?: string }[] | null | undefined,
): { key: string; count: number }[] {
  const map = new Map<string, number>();
  for (const r of rows ?? []) {
    const key = skipReasonKey(kind, r?.reason);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].map(([key, count]) => ({ key, count }));
}

/**
 * وسم خانة «المتخطى» في نافذة النتيجة: تخطّي الأسعار ليس تكراراً وحده (الصنف المؤرشف منه)،
 * فالوسم العام أصدق، وعدّاد الأسباب تحته يفصّل.
 */
export const SKIPPED_ROWS_LABEL = 'صف متخطى';
export const skippedStatLabel = (kind: string | undefined): string => (kind === 'prices' ? SKIPPED_ROWS_LABEL : 'مكرر تخطي');

/** زوج (عميل/صنف) تكرر في الملف — عقد الخادم warnings.duplicates */
export interface PriceDuplicatePair { rows?: number[]; kept?: number; prices?: number[]; conflict?: boolean; code?: string; customerName?: string | null }

/** أزواج اختلف فيها السعر وحدها: هي ما يفاجئ المالك، والمتطابقة سعراً تكرار بلا أثر */
export const conflictingPricePairs = (list: readonly PriceDuplicatePair[] | null | undefined): PriceDuplicatePair[] =>
  (list ?? []).filter((d) => d?.conflict === true);

// ═══ البند 49: عملاء استُوردوا بجوال لا تقبله بطاقة العميل ═══

/** نص الخادم حرفياً (services/importLedger.ts CUSTOMER_PHONE_NOT_EDITABLE) */
export const CUSTOMER_PHONE_NOT_EDITABLE = 'عملاء بلا جوال صالح: لا يُحفظ أي تعديل لبطاقاتهم حتى يُكتب لهم جوال لا يقل عن تسع خانات';
export const CUSTOMER_PHONE_NOT_EDITABLE_FIX = 'اكتب لهم جوالاً صالحاً في بطاقة العميل، أو صحّح عمود الجوال في الملف وأعد استيراده بعد التراجع عن هذه الدفعة';

/** تحذير warnings.phoneNotEditable ({count, rows}) — الغائب أو الصفري أو المشوّه بلا كتلة */
export function phoneNotEditableWarning(
  w: { count?: unknown; rows?: unknown } | null | undefined,
): { count: number; rows: number[] } | null {
  const n = count(w?.count);
  if (n <= 0) return null;
  const rows = (Array.isArray(w?.rows) ? w!.rows : []).filter((r): r is number => typeof r === 'number' && Number.isFinite(r));
  return { count: n, rows };
}

// ═══ البند 39: صفوف تاريخها بعد اليوم (خطأ سنة: 2052 بدل 2025) ═══

/** نص الخادم حرفياً (backend/src/routes/import.ts IMPORT_FUTURE_DATE_WARNING) — يُترجَم عندنا لا يُعرض خاماً */
export const IMPORT_FUTURE_DATED = 'تواريخ بعد اليوم بتوقيت الشركة — تحقّق من سنة التاريخ قبل الاعتماد';
export const IMPORT_FUTURE_DATED_MAX = 'أقصى تاريخ مقبول';
export const IMPORT_FUTURE_DATED_FIX = 'صحّح سنة التاريخ في هذه الصفوف ثم أعد الاستيراد بعد التراجع عن هذه الدفعة';

/**
 * تحذير warnings.futureDated ({count, rows, maxDate}) في ردّ الأرصدة والكشوف: الصفوف كُتبت فعلاً،
 * فالتنبيه معدود بأمثلة صفوفه. الحقل غائب من خادم أقدم ⇒ null بلا كتلة (ولا عدد مختلَق حين لا عدّ).
 */
export function futureDatedWarning(
  w: { count?: unknown; rows?: unknown; maxDate?: unknown; message?: unknown } | null | undefined,
): { count: number; rows: number[]; maxDate: string } | null {
  // الخادم يرسل `rows: [{ row, date }]` (services/importLedger.ts resolveImportDates)، والشكل الرقمي مقبول
  // كذلك لخادم أقدم — فأيّهما جاء تُقرأ منه أرقام الصفوف، ولا تبقى الكتلة بلا صفوف كما كانت.
  const rows = (Array.isArray(w?.rows) ? w!.rows : [])
    .map((r) => (typeof r === 'number' ? r : (r && typeof r === 'object' && typeof (r as { row?: unknown }).row === 'number' ? (r as { row: number }).row : null)))
    .filter((r): r is number => r !== null && Number.isFinite(r));
  const n = count(w?.count) || rows.length;
  if (n <= 0) return null;
  return { count: n, rows, maxDate: typeof w?.maxDate === 'string' ? w.maxDate : '' };
}

/** صف عملاء رُبط كوده بعميل قائم بلا كود (attachedRows[].matchedBy) ⇒ مفتاح tr */
export const attachedCodeKey = (matchedBy: string | undefined): string =>
  (matchedBy === 'phone'
    ? 'رُبط الكود بعميل قائم بلا كود بالجوال نفسه'
    : 'رُبط الكود بعميل قائم بلا كود بالاسم نفسه');

/** تنبيه warnings.similar[].matchedBy ⇒ مفتاح tr */
export const similarWarningKey = (matchedBy: string | undefined): string =>
  (matchedBy === 'phone'
    ? 'أُنشئ بكود جديد مع أن جواله يطابق عميلاً قائماً'
    : 'أُنشئ بكود جديد مع أن اسمه يطابق عميلاً قائماً');

// ═══ لوحات التعارض (البند 20) ═══

// عام: الأرصدة والكشوف تتحاجبان، واللوحة تعرض نوع الاستيراد الجاري بجانبه (kindLabel)
export const IMPORT_IN_PROGRESS_TEXT = 'استيراد آخر جارٍ الآن لهذه الشركة. انتظر انتهاءه ثم راجع سجل الاستيرادات قبل الإعادة';

/** نتيجة «استيراد رغم التكرار» بحسب النوع (مفتاح tr) */
export function duplicateConsequenceKey(kind: string | undefined): string {
  switch (kind) {
    // البندان 15 و16: الصنف المستورد سابقاً يُرفض بصفه (OPENING_STOCK_ALREADY_IMPORTED) فلا تتضاعف كميته
    case 'opening_stock': return 'الأصناف المستوردة سابقاً تُرفض صفاً صفاً ولا يُضاف إلا الجديد';
    case 'customers':
    case 'products': return 'الصفوف القائمة تُتخطّى ولن يُضاف إلا الجديد';
    case 'prices': return 'يُعاد كتابة الأسعار نفسها في دفعة جديدة';
    default: return 'استيراده مرة أخرى يضاعف الأرصدة';
  }
}

// ═══ الأسعار الصفرية وجسم الطلب وإتاحة الزر (البنود 1 و9–13) ═══

export const ZERO_PRICE_ACK_KEY = 'أقرّ بأن السعر الخاص صفر مقصود في N صف';

export function zeroPriceGate(kind: string, zeroPriceRows: number | undefined, acknowledged: boolean): { required: boolean; blocksImport: boolean; allowZeroPrice: boolean } {
  const required = kind === 'prices' && count(zeroPriceRows) > 0;
  return { required, blocksImport: required && !acknowledged, allowZeroPrice: required && acknowledged };
}

export interface ImportBodyInput {
  kind: string;
  rows: Record<string, unknown>[];
  ledgerKind: boolean;
  undatedDate?: string | null;
  /** المخزون الافتتاحي */
  stockInclTax?: boolean;
  stockAckBody?: Record<string, unknown>;
  flags?: { force?: boolean; confirmOverlap?: boolean };
  zeroPriceRows?: number;
  zeroPriceAck?: boolean;
  /** البند 31: المنتجات والأسعار — عمود السعر في الملف شامل الضريبة، يحوّله الخادم إلى صافٍ بضريبة الصنف */
  pricesIncludeTax?: boolean;
}

export function buildImportBody(i: ImportBodyInput): Record<string, unknown> {
  const body: Record<string, unknown> = { rows: i.rows };
  if (i.ledgerKind && i.undatedDate) body.undatedDate = i.undatedDate;
  // البند 51: عقد التاريخ يميّز هذه النسخة من الواجهة عن تبويب مفتوح من قبل النشر (يرسل تواريخ متأخرة يوماً)
  if (i.ledgerKind) body.dateContract = IMPORT_DATE_CONTRACT;
  if (inclusiveTaxKind(i.kind) && i.pricesIncludeTax === true) body.pricesIncludeTax = true;
  if (i.kind === 'opening_stock') Object.assign(body, { pricesIncludeTax: i.stockInclTax === true }, i.stockAckBody ?? {});
  if (i.flags?.force) body.force = true;
  if (i.flags?.confirmOverlap) body.confirmOverlap = true;
  if (zeroPriceGate(i.kind, i.zeroPriceRows, i.zeroPriceAck === true).allowZeroPrice) body.allowZeroPrice = true;
  return body;
}

/** زر الاستيراد معطّل: لا صفوف، أو عوائق التحويل، أو تاريخ بلا اختيار، أو تعارض، أو إقرار ناقص، أو صفوف فوق الحد */
export function importButtonBlocked(i: {
  rows: number; blockers?: readonly string[] | null; needUndatedChoice?: boolean; conflict?: boolean;
  stockBlocked?: boolean; zeroPrice?: { blocksImport: boolean }; overMax?: boolean;
}): boolean {
  return i.rows === 0 || (i.blockers?.length ?? 0) > 0 || !!i.needUndatedChoice || !!i.conflict || !!i.stockBlocked
    || !!i.zeroPrice?.blocksImport || !!i.overMax;
}

// ═══ خريطة «عمود الملف ← الحقل» في المعاينة (البند 13) ═══

/** اسم الحقل الداخلي (columns[].field) ⇒ مفتاح tr عربي؛ غير المعروف يبقى كما هو */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: 'الاسم', phone: 'الجوال', code: 'الكود', email: 'البريد الإلكتروني', businessName: 'اسم المنشأة',
  commercialReg: 'السجل التجاري', taxNumber: 'الرقم الضريبي', city: 'المدينة', district: 'الحي', address: 'العنوان',
  channel: 'قناة البيع', creditLimit: 'الحد الائتماني', paymentDays: 'مدة السداد', balance: 'الرصيد',
  basePrice: 'السعر', taxPct: 'نسبة الضريبة %', unit: 'الوحدة', barcode: 'باركود', category: 'الفئة', productName: 'اسم الصنف',
  debit: 'مدين', credit: 'دائن', date: 'التاريخ', description: 'البيان', amount: 'المبلغ', paid: 'المدفوع',
  residual: 'المتبقي', status: 'الحالة', price: 'السعر الخاص', productCode: 'كود الصنف', qty: 'الكمية', unitCost: 'تكلفة الوحدة',
};
export const importFieldLabel = (field: string): string => FIELD_LABELS[field] ?? field;

/** الحقل في خريطة الأعمدة قد يُرسل باسم آخر في الصف المحوّل (name ⇐ customerName في الأرصدة والكشوف والأسعار) */
const ROW_KEY_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  name: ['customerName', 'productName'],
  code: ['customerCode', 'productCode'],
};

/** القيمة المحوّلة لحقل في صف مرسل: undefined ⇒ '—' في العرض */
export function previewCellValue(row: Record<string, unknown>, field: string): unknown {
  if (row[field] !== undefined) return row[field];
  for (const k of ROW_KEY_FALLBACKS[field] ?? []) if (row[k] !== undefined) return row[k];
  return undefined;
}

// ═══ ملخّص نتيجة التراجع: حقائق الرد التي كانت تسقط من الشاشة ═══

/** حقول رد التراجع الإضافية — أيّها قد يغيب (خادم أقدم) فلا سطر له، وقيمته تُقرأ بحذر (unknown) */
export interface RevertExtras {
  /** الأسعار: صفوف كان سعرها مُعاداً سلفاً (إعادة محاولة بعد انقطاع) — ليست ضائعة */
  alreadyReverted?: unknown;
  /** العملاء: الصفوف التابعة التي حُذفت مع العميل — عقد «لا حذف صامت» */
  removedEntries?: unknown;
  removedPrices?: unknown;
  removedNotifications?: unknown;
  removedAssignments?: unknown;
  removedScopes?: unknown;
}

export const REVERT_ALREADY_REVERTED = 'سبق التراجع عنها في محاولة سابقة';
export const REVERT_REMOVED_ENTRIES = 'قيود حُذفت مع العملاء';
export const REVERT_REMOVED_PRICES = 'أسعار خاصة حُذفت مع العملاء';
export const REVERT_REMOVED_NOTIFICATIONS = 'إشعارات حُذفت مع العملاء';
export const REVERT_REMOVED_ASSIGNMENTS = 'إسناد لمندوب أُلغي مع العملاء';
export const REVERT_REMOVED_SCOPES = 'نطاق رؤية لمستخدم أُلغي مع العملاء';

/** ترتيب العرض: ما سبق التراجع عنه أولاً، ثم التوابع المحذوفة بترتيب أثرها على المالك */
const REVERT_EXTRA_LABELS: readonly (readonly [keyof RevertExtras, string])[] = [
  ['alreadyReverted', REVERT_ALREADY_REVERTED],
  ['removedEntries', REVERT_REMOVED_ENTRIES],
  ['removedPrices', REVERT_REMOVED_PRICES],
  ['removedNotifications', REVERT_REMOVED_NOTIFICATIONS],
  ['removedAssignments', REVERT_REMOVED_ASSIGNMENTS],
  ['removedScopes', REVERT_REMOVED_SCOPES],
];

/**
 * أسطر ملخّص التراجع من حقول الرد: مفتاح عربي (يُمرَّر عبر tr) وعدد.
 * الحقل الغائب أو الصفري أو غير الرقمي لا سطر له، فلا يرى المالك «قيود حُذفت: 0».
 */
export function revertSummaryLines(d: RevertExtras | null | undefined): { key: string; count: number }[] {
  const out: { key: string; count: number }[] = [];
  for (const [field, key] of REVERT_EXTRA_LABELS) {
    const n = count(d?.[field]);
    if (n > 0) out.push({ key, count: n });
  }
  return out;
}

// ═══ البند 31: «الأسعار شاملة الضريبة» في المنتجات وقوائم الأسعار ═══
//
// قائمة أسعار مصدَّرة شاملة الضريبة كانت تُحفظ كما هي، فيضيف تطبيق المندوب الضريبة فوقها مرة ثانية.
// الخانة تُرسل pricesIncludeTax، والخادم يخصم ضريبة كل صنف (netFromInclusive) قبل الحفظ — كما يفعل
// المخزون الافتتاحي اليوم. غير مؤشّرة افتراضاً، إلا أن يقول عنوان عمود السعر نفسه إنه شامل الضريبة.

export const PRICES_INCLUDE_TAX_LABEL = 'الأسعار في الملف شاملة الضريبة';
export const PRICES_INCLUDE_TAX_NOTE = 'تُخصم ضريبة كل صنف من السعر قبل الحفظ فيُخزَّن صافياً، ويضيفها التطبيق عند البيع. اتركها فارغة إن كان عمود السعر صافياً';
export const PRICES_INCLUDE_TAX_DETECTED = 'عنوان عمود السعر في ملفك يقول «شامل الضريبة» فحُدِّدت الخانة تلقائياً — ألغِ التحديد إن كان السعر صافياً';
/** نتيجة الاستيراد: ما فعله الخادم بالأسعار فعلاً، فلا يبقى الخصم وعداً في المعاينة وحدها */
export const PRICES_SAVED_NET = 'خُصمت ضريبة كل صنف من أسعار الملف فحُفظت صافيةً، ويضيفها التطبيق عند البيع';
export const PRICES_SAVED_NET_ROWS = 'سعر حُوّل';

/**
 * عدد الأسعار التي حوّلها الخادم من شاملة إلى صافية — حقل اختياري في الرد (خادم لا يرسله ⇒ 0
 * فتُعرض العبارة بلا عدد، ولا يُدّعى عدد لم يصل).
 */
export function netFromInclusiveCount(res: { netFromInclusive?: unknown; warnings?: { netFromInclusive?: unknown } | null } | null | undefined): number {
  return count(res?.netFromInclusive) || count(res?.warnings?.netFromInclusive);
}

/** حقل السعر في خريطة الأعمدة لكل نوع يقبل الخانة (المخزون الافتتاحي له خانة «التكلفة شاملة الضريبة») */
const INCLUSIVE_TAX_PRICE_FIELD: Readonly<Record<string, string>> = { products: 'basePrice', prices: 'price' };

export const inclusiveTaxKind = (kind: string): boolean => Object.prototype.hasOwnProperty.call(INCLUSIVE_TAX_PRICE_FIELD, kind);

/**
 * البند 31: تأكيد تلقائي للخانة حين يقول عنوان عمود السعر إنه شامل الضريبة.
 * الحكم واحد مع المعاينة (headerSaysPriceIncludesTax): تُشترط كلمة ضريبة/VAT/tax وتُنفى «غير شامل»
 * و«قبل الضريبة». «شامل» وحدها لا تكفي: «السعر شامل الخصم» أو «شامل التوصيل» أو «Price incl. delivery»
 * كانت تُحدِّد الخانة فيقسم الخادم أسعار المالك الصافية على ١٫١٥ ويحفظها ناقصة.
 */
export function inclusiveTaxDetected(kind: string, columns: readonly { field: string; header: string | null }[] | undefined): boolean {
  const field = INCLUSIVE_TAX_PRICE_FIELD[kind];
  if (!field) return false;
  return (columns ?? []).some((c) => c.field === field && headerSaysPriceIncludesTax(c.header));
}

// ═══ البند 36: رفض الملف كله — الحد الأقصى للصفوف، وحجم الطلب، وتفصيل الخادم ═══

/** مطابق لـ z.array(...).max(N) في backend/src/routes/import.ts — الخادم يرفض الملف كله قبل أي كتابة */
export const IMPORT_MAX_ROWS: Readonly<Record<string, number>> = {
  customers: 5000, products: 5000, balances: 10000, ledger: 20000, prices: 20000, opening_stock: 5000,
};
export const IMPORT_ROWS_OVER_MAX = 'هذا الملف يرسل {rows} صفاً والحد الأقصى {max} صف في المرة الواحدة، فيرفضه الخادم كله. قسّم الملف ثم ارفع كل جزء على حدة';

/** null ما دام العدد ضمن الحد (أو النوع غير معروف: الخادم يحسم) */
export function rowsOverMax(kind: string, rows: number): { rows: number; max: number } | null {
  const max = IMPORT_MAX_ROWS[kind];
  return typeof max === 'number' && rows > max ? { rows, max } : null;
}

export const IMPORT_FILE_REJECTED_TITLE = 'رفض الخادم الملف كله ولم يُكتب منه صف واحد';
export const IMPORT_FILE_REJECTED_HINT = 'صحّح ما يلي في الملف ثم أعد رفعه';
export const IMPORT_PAYLOAD_TOO_LARGE = 'حجم بيانات هذا الملف أكبر مما يقبله الخادم في طلب واحد. قسّمه إلى ملفات أصغر ثم ارفع كل ملف';
export const IMPORT_PAYLOAD_SIZE_LABEL = 'حجم بيانات ملفك';
export const MEGABYTE_UNIT = 'ميغابايت';

/** سطر واحد من تفصيل الرفض: رقم الصف كما يرقّمه الخادم (موضع الصف المرسل + 2) إن أرسله */
export interface ImportRejectionDetail { row?: number; field?: string; message: string }

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/**
 * البند 36: رفض zod للملف كله (400) — يُقرأ منه ما يدلّ المالك على السطر والسبب:
 *  • `issues` بمسارها (rows, ‹موضع الصف›, ‹الحقل›) إن أرسلها الخادم ⇒ رقم صف وحقل؛
 *  • وإلا `errors` (fieldErrors): مفتاح رقمي = موضع صف، و«rows» رسائل بلا سطر.
 * null حين لا تفصيل يُعرض — تبقى الرسالة العامة كما كانت.
 */
export function importValidationRejection(e: unknown): { details: ImportRejectionDetail[] } | null {
  const { status, body } = errorResponseOf(e);
  if (status !== 400) return null;
  const details: ImportRejectionDetail[] = [];
  const issues = body.issues ?? errorDetail(body, 'issues');
  if (Array.isArray(issues)) {
    for (const raw of issues) {
      const it = asObj(raw);
      const message = typeof it.message === 'string' ? it.message : '';
      if (!message) continue;
      const path: unknown[] = Array.isArray(it.path) ? it.path : [];
      const idx = path.find((p) => typeof p === 'number');
      const field = [...path].reverse().find((p) => typeof p === 'string' && p !== 'rows');
      details.push({
        row: typeof idx === 'number' ? idx + 2 : undefined,
        field: typeof field === 'string' ? field : undefined,
        message,
      });
    }
  }
  if (!details.length) {
    for (const [k, v] of Object.entries(asObj(body.errors))) {
      const numeric = /^\d+$/.test(k);
      for (const m of Array.isArray(v) ? v : []) {
        if (typeof m !== 'string' || !m) continue;
        details.push({ row: numeric ? Number(k) + 2 : undefined, field: !numeric && k !== 'rows' ? k : undefined, message: m });
      }
    }
  }
  return details.length ? { details } : null;
}

const TOO_LARGE_RE = /entity too large|payload too large|request too large/i;
/** حدّ جسم الطلب في الخادم (express.json limit) — يصل 413، أو 500 برسالة الحدّ */
export function isPayloadTooLarge(f: { type: string; status?: number; message?: string }): boolean {
  return f.type === 'other' && (f.status === 413 || TOO_LARGE_RE.test(f.message ?? ''));
}

/** حجم الجسم المرسل بالبايت (UTF-8) — يُحسب عند الفشل وحده ليُعرض للمالك بالميغابايت */
export function payloadBytes(body: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(body) ?? '').length; } catch { return 0; }
}
export const megabytes = (bytes: number): number => Math.round((bytes / 1048576) * 10) / 10;

// ═══ البند 51: حارس نسخة الواجهة (تبويب أو نافذة Electron مفتوحة من قبل النشر) ═══
//
// نسخة قديمة من الواجهة كانت تحوّل خلية التاريخ بـtoISOString فتتأخر يوماً بتوقيت الرياض، وتمرّر
// التواريخ النصية خاماً. الخادم لا يميّزها، فتُستورد حركات بتاريخ خاطئ بصمت أو يُرفض الملف برسالة عامة.
// هذه النسخة تختم طلبها بعقد التاريخ، والخادم يردّ IMPORT_CLIENT_OUTDATED على الطلب الذي لا يحمله.

export const IMPORT_DATE_CONTRACT = 'local-ymd-v2';
export const IMPORT_CLIENT_OUTDATED_CODE = 'IMPORT_CLIENT_OUTDATED';
export const IMPORT_CLIENT_OUTDATED_MESSAGE = 'هذه الصفحة مفتوحة من قبل تحديث النظام ولم يُكتب شيء. حدّث الصفحة ثم أعد رفع الملف';
export const RELOAD_PAGE_LABEL = 'حدّث الصفحة';

/** رمز عدم التوافق يُقرأ من جسم الرد مباشرةً، فلا ينتظر إضافته إلى تصنيف الفشل العام */
export function isClientOutdated(e: unknown): boolean {
  return errorResponseOf(e).body.code === IMPORT_CLIENT_OUTDATED_CODE;
}

// ═══ البند 52: انقطاع الخدمة أثناء النشر، وتصفّح سجلّ الدفعات ═══

export const SERVICE_UNAVAILABLE_MESSAGE = 'الخدمة تُحدَّث الآن، أعد المحاولة بعد لحظات';
export const SERVICE_UNAVAILABLE_HINT = 'إن كان الاستيراد قد بدأ فستجده في سجل الاستيرادات، وإعادة الإرسال تتوقف عند التكرار';
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** 502/503/504 (وسيط النشر برد HTML بلا success): انقطاع مؤقّت لا خطأ تطبيق */
export function isServiceUnavailable(f: { type: string; status?: number }): boolean {
  return f.type === 'other' && typeof f.status === 'number' && UNAVAILABLE_STATUSES.has(f.status);
}

/** حجم صفحة GET /import/batches في الخادم (take) */
export const BATCHES_PAGE_SIZE = 50;
export const BATCHES_LOAD_MORE = 'عرض المزيد';
export const BATCHES_NO_OLDER = 'لم تصل دفعات أقدم من الخادم';
export const BATCHES_LOAD_MORE_FAILED = 'تعذّر جلب الدفعات الأقدم';
export const DUPLICATE_BATCH_OUT_OF_VIEW = 'الدفعة المكرّرة قد تكون أقدم مما يعرضه السجل: اضغط «عرض المزيد» فيه';

/**
 * دمج صفحة أقدم في المعروض بترتيبه وبلا تكرار معرّف.
 * added=0 ⇒ لا جديد: نهاية السجل، أو خادم لا يفهم cursor فأعاد الصفحة الأولى نفسها.
 */
export function mergeBatchPages<T extends { id: string }>(shown: readonly T[], page: readonly T[]): { list: T[]; fresh: T[]; added: number } {
  const seen = new Set(shown.map((b) => b.id));
  const fresh: T[] = [];
  for (const b of page) {
    if (!b || typeof b.id !== 'string' || seen.has(b.id)) continue;
    seen.add(b.id);
    fresh.push(b);
  }
  return { list: fresh.length ? [...shown, ...fresh] : [...shown], fresh, added: fresh.length };
}

/**
 * زرّ «عرض المزيد»: يظهر حين يقول الخادم إن خلفها المزيد (hasMore)، أو — مع خادم لا يرسلها —
 * حين تكون الصفحة ممتلئة فقد يكون خلفها أقدم. المقيّد النطاق لا يرى السجل أصلاً.
 */
export function canLoadOlderBatches(i: { shown: number; hasMore?: boolean; exhausted: boolean; scoped: boolean }): boolean {
  if (i.scoped || i.exhausted) return false;
  if (typeof i.hasMore === 'boolean') return i.hasMore;
  return i.shown >= BATCHES_PAGE_SIZE;
}

/**
 * صفحة من سجلّ الدفعات كما يردّها العقد: `{ data, hasMore, nextCursor }`.
 * hasMore غير المنطقية ⇒ undefined (خادم أقدم لا يرسلها: يحسم امتلاء الصفحة)، وnextCursor غير النصية ⇒ null
 * (يُستأنف من معرّف آخر دفعة معروضة)، والصفوف بلا معرّف نصّي تُسقط فلا تُعرض بطاقة بلا هوية.
 */
export function batchesPage<T extends { id: string }>(body: unknown): { rows: T[]; hasMore?: boolean; nextCursor: string | null } {
  const b = asObj(body);
  const rows = (Array.isArray(b.data) ? b.data : [])
    .filter((r): r is T => !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string');
  return {
    rows,
    hasMore: typeof b.hasMore === 'boolean' ? b.hasMore : undefined,
    nextCursor: typeof b.nextCursor === 'string' && b.nextCursor ? b.nextCursor : null,
  };
}

/** موضع الاستئناف: ما أعطاه الخادم، وإلا معرّف آخر دفعة معروضة (خادم أقدم بلا nextCursor) */
export const nextBatchesCursor = (serverCursor: string | null | undefined, lastShownId: string | undefined): string | undefined =>
  (serverCursor || lastShownId || undefined);
