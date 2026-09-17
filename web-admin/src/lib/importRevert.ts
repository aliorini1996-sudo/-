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

export interface ImportResultRowError { row: number; message: string; code?: string; value?: string }
export interface ImportResultView {
  tone: 'success' | 'warning' | 'failure';
  titleKey: string;
  /** attached: العملاء — أكواد رُبطت بعملاء قائمين بلا كود (تعديل لا إنشاء) */
  counts: { created: number; attached: number; skipped: number; zero: number; notFound: number; ambiguous: number; otherErrors: number };
}

/** نص الخادم حرفياً (backend/src/services/importLedger.ts IMPORT_ROW_MESSAGES.CUSTOMER_CODE_NOT_FOUND)، والكود في value */
export const CUSTOMER_CODE_NOT_FOUND_MESSAGE = 'كود العميل غير مسجّل، ويوجد عميل بالاسم أو الجوال نفسه بلا كود: أضف الكود في بطاقة العميل أو احذف عمود الكود من الملف ليُطابَق بالجوال والاسم';

/** رموز صفوف «عميل غير مطابق» (خانة notFound) */
const NOT_FOUND_ROW_CODES: ReadonlySet<string> = new Set(['CUSTOMER_NOT_FOUND', 'CUSTOMER_CODE_NOT_FOUND', 'CUSTOMER_CODE_UNREGISTERED']);

/** نص الخادم حرفياً (IMPORT_ROW_MESSAGES.CUSTOMER_CODE_UNREGISTERED): صف بالكود وحده والشركة فيها عملاء بلا كود */
export const CUSTOMER_CODE_UNREGISTERED_MESSAGE = 'كود العميل غير مسجّل، ولدى الشركة عملاء بلا كود: استورد ملف العملاء بعمود الكود مع الاسم أو الجوال ليُربط الكود بعملائه، أو أضف عمود الاسم أو الجوال إلى هذا الملف';

/** مفتاح tr لخطأ صف: الرمز المعروف بنصه الثابت (لا يتأثر بتغيّر صياغة الخادم)، وإلا رسالة الخادم */
export function importRowErrorKey(e: { code?: string; message: string }): string {
  if (e.code === 'CUSTOMER_CODE_NOT_FOUND') return CUSTOMER_CODE_NOT_FOUND_MESSAGE;
  if (e.code === 'CUSTOMER_CODE_UNREGISTERED') return CUSTOMER_CODE_UNREGISTERED_MESSAGE;
  return e.message;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export function importResultView(res: { created?: number; attached?: number; skipped?: number; zero?: number; errors?: readonly ImportResultRowError[] | null }): ImportResultView {
  const errors = Array.isArray(res.errors) ? res.errors : [];
  let notFound = 0; let ambiguous = 0;
  for (const e of errors) {
    if (NOT_FOUND_ROW_CODES.has(String(e?.code))) notFound++;
    else if (e?.code === 'CUSTOMER_AMBIGUOUS') ambiguous++;
  }
  const counts = {
    created: count(res.created), attached: count(res.attached), skipped: count(res.skipped), zero: count(res.zero),
    notFound, ambiguous, otherErrors: errors.length - notFound - ambiguous,
  };
  // ربط الأكواد بعملاء قائمين كتابة فعلية: ليس «لم يُستورد شيء»
  if (counts.created === 0 && counts.attached === 0) return { tone: 'failure', titleKey: RESULT_FAILURE_TITLE, counts };
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
    case 'opening_stock': return 'استيراده مرة أخرى يضاعف الكميات';
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
  basePrice: 'السعر', taxPct: 'نسبة الضريبة %', unit: 'الوحدة', barcode: 'باركود', category: 'الفئة',
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
