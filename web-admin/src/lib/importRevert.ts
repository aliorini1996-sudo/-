// تجميع «المتبقي» بعد التراجع الجزئي عن دفعة استيراد حسب السبب (blocked[].reason من الخادم):
// المحمي بمعاملات حقيقية لا يُعاد، أما انشغال قفل الدفاتر أو خطأ الحذف العابر فيُعاد لاحقاً.
import { errorDetail, errorResponseOf } from './importData';
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
  | { type: 'other'; message?: string };

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
  return { type: 'other', message: typeof b.message === 'string' ? b.message : undefined };
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

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export function importResultView(res: { created?: number; updated?: number; attached?: number; skipped?: number; zero?: number; errors?: readonly ImportResultRowError[] | null }): ImportResultView {
  const errors = Array.isArray(res.errors) ? res.errors : [];
  let notFound = 0; let ambiguous = 0;
  for (const e of errors) {
    if (NOT_FOUND_ROW_CODES.has(String(e?.code))) notFound++;
    else if (e?.code === 'CUSTOMER_AMBIGUOUS') ambiguous++;
  }
  const counts = {
    created: count(res.created), updated: count(res.updated), attached: count(res.attached), skipped: count(res.skipped), zero: count(res.zero),
    notFound, ambiguous, otherErrors: errors.length - notFound - ambiguous,
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
}

export function buildImportBody(i: ImportBodyInput): Record<string, unknown> {
  const body: Record<string, unknown> = { rows: i.rows };
  if (i.ledgerKind && i.undatedDate) body.undatedDate = i.undatedDate;
  if (i.kind === 'opening_stock') Object.assign(body, { pricesIncludeTax: i.stockInclTax === true }, i.stockAckBody ?? {});
  if (i.flags?.force) body.force = true;
  if (i.flags?.confirmOverlap) body.confirmOverlap = true;
  if (zeroPriceGate(i.kind, i.zeroPriceRows, i.zeroPriceAck === true).allowZeroPrice) body.allowZeroPrice = true;
  return body;
}

/** زر الاستيراد معطّل: لا صفوف، أو عوائق التحويل، أو تاريخ بلا اختيار، أو تعارض، أو إقرار ناقص */
export function importButtonBlocked(i: {
  rows: number; blockers?: readonly string[] | null; needUndatedChoice?: boolean; conflict?: boolean;
  stockBlocked?: boolean; zeroPrice?: { blocksImport: boolean };
}): boolean {
  return i.rows === 0 || (i.blockers?.length ?? 0) > 0 || !!i.needUndatedChoice || !!i.conflict || !!i.stockBlocked || !!i.zeroPrice?.blocksImport;
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
