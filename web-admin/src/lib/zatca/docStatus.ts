/**
 * فوترة ZATCA المرحلة الثانية (Z5.6b) — قراءة حالة المستند الضريبي في العميل: نقيّة، بلا React ولا شبكة ولا قاموس.
 *
 * **الخادم هو المرجع** (backend/src/compliance/zatca/status.ts): مرآة الفاتورة `einvoiceStatus` وحدها تقرّر ما يُطبع
 * وما يُعرض؛ ولا يُعاد استنتاج شيء من المبالغ ولا من إعدادات الشركة. وهذا الملف نسخة العميل من ثلاث قواعد فقط:
 *   • `isPrintableMirror` — المبسّطة (02) بأي حالة عدا المُبطلة، والقياسية (01) بعد الاعتماد أو بعد الإبلاغ.
 *   • «متأخرة» — مبسّطة غير نهائية تجاوزت ٢٤ ساعة من الإصدار (محسوبة لا مخزَّنة).
 *   • الإجراءات الإدارية الثلاثة التي يفتحها الخادم (إعادة إرسال، سحب، إعادة إصدار) بشروطها.
 *
 * ولماذا نسخة عميل أصلاً: صفوف **القائمة** لا تحمل `einvoice` (الخادم يبنيه في التفصيل وحده من إسقاط المستند)، فلو
 * انتظرنا `printable` من الخادم لبقيت القائمة بلا شارة. فالصفّ يحمل أعمدة المرآة (`zatcaPhase`، `einvoiceStatus`،
 * `invoiceSubtype`، `documentKind`، `issuedAt`) وهي تكفي الشارة؛ وحين يصل `einvoice` في التفصيل فهو **المقدَّم**.
 *
 * صفوف المرحلة الأولى (zatcaPhase null أو 1) تعود من كل دالّة هنا بـnull: لا شارة ولا تغيير — واجهة اليوم حرفياً.
 */

export const ZATCA_MIRROR_STATUSES = Object.freeze([
  'signed', 'clearance_pending', 'report_blocked', 'clearance_blocked', 'reported', 'reported_warn', 'cleared',
  'cleared_warn', 'cleared_no_xml', 'rejected', 'withdrawn',
] as const);
export type ZatcaMirrorStatus = (typeof ZATCA_MIRROR_STATUSES)[number];

export type ZatcaSubtype = '01' | '02';
export type ZatcaDocumentKind = 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE';
export type ZatcaMode = 'live' | 'rehearsal';

/** مرايا لا تُطبع أبداً: الفاتورة تحتها مُبطلة (رفض الهيئة أو سحب قبل الوصول). */
const VOIDED_MIRRORS: readonly string[] = Object.freeze(['rejected', 'withdrawn']);

/** حالات المستند النهائية عند الهيئة (لا مطالبة بعدها) — تُستعمل لحساب «متأخرة». */
const FINAL_DOCUMENT_STATUSES: readonly string[] = Object.freeze([
  'REPORTED', 'REPORTED_WARN', 'CLEARED', 'CLEARED_WARN', 'CLEARED_NO_XML', 'REJECTED', 'WITHDRAWN',
]);

export const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** حقل `einvoice` في ردّ التفصيل (routes/invoicesZatca.ts: EinvoiceView) — كلّه اختياريّ في القراءة. */
export interface ZatcaEinvoiceResponse {
  phase?: unknown;
  mode?: unknown;
  status?: unknown;
  documentStatus?: unknown;
  subtype?: unknown;
  documentKind?: unknown;
  qr?: unknown;
  printable?: unknown;
  overdue?: unknown;
  reportDeadline?: unknown;
  issuedAt?: unknown;
  uuid?: unknown;
  icv?: unknown;
  warnings?: unknown;
}

/** صفّ فاتورة كما يصل العميل — من القائمة (أعمدة المرآة) أو من التفصيل (ومعه `einvoice`). */
export interface ZatcaInvoiceRowLike {
  zatcaPhase?: unknown;
  einvoiceStatus?: unknown;
  einvoiceQr?: unknown;
  invoiceSubtype?: unknown;
  documentKind?: unknown;
  issuedAt?: unknown;
  einvoiceUuid?: unknown;
  /**
   * مهلة الإبلاغ على الصفّ — **لا يعيدها الخادم اليوم** (فجوة مُبلَّغة: لا عمود مرآة لها في `Invoice`)، وتُقرأ متى
   * وصلت. وبها وحدها تُعرف الفاتورة القياسية المحوَّلة إلى الإبلاغ (ردّ ٣٠٣) وقد سرت عليها مهلة ٢٤ ساعة.
   */
  einvoiceReportDeadline?: unknown;
  einvoice?: ZatcaEinvoiceResponse | null;
}

/** العرض المُوحَّد الذي تبني عليه كل الواجهات (القائمة والتفصيل والطباعة). */
export interface ZatcaDocView {
  phase: 2;
  mode: ZatcaMode;
  mirror: ZatcaMirrorStatus | null;
  /** حالة المستند عند الهيئة — في التفصيل وحده (SIGNED / SUBMITTING / RETRY_WAIT / …). */
  documentStatus: string | null;
  subtype: ZatcaSubtype | null;
  documentKind: ZatcaDocumentKind | null;
  /** رمز QR المختوم كما أعاده الخادم — لا يُبنى في العميل أبداً. */
  qr: string | null;
  printable: boolean;
  overdue: boolean;
  /** مهلة الإبلاغ كما صرّح بها الخادم (التفصيل) — null حين لا مهلة على المستند أصلاً أو لم تصل. */
  reportDeadline: string | null;
  issuedAt: string | null;
  uuid: string | null;
  icv: number | null;
  warnings: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

const isMirror = (v: unknown): v is ZatcaMirrorStatus =>
  typeof v === 'string' && (ZATCA_MIRROR_STATUSES as readonly string[]).includes(v);

const asSubtype = (v: unknown): ZatcaSubtype | null => (v === '01' || v === '02' ? v : null);

const asKind = (v: unknown): ZatcaDocumentKind | null =>
  v === 'INVOICE' || v === 'CREDIT_NOTE' || v === 'DEBIT_NOTE' ? v : null;

function isoOf(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return str(v);
}

/** صفّ من المرحلة الثانية؟ العمود أوّلاً، ثمّ إعلان الخادم في `einvoice` (صفّ التفصيل يحملهما معاً). */
export function isZatcaPhase2Row(row: ZatcaInvoiceRowLike | null | undefined): boolean {
  if (!row) return false;
  if (row.zatcaPhase === 2) return true;
  return row.einvoice?.phase === 2;
}

/**
 * نسخة العميل من `isPrintableMirror` (status.ts): المبسّطة بأيّ حالة عدا المُبطلة وغير المعتمدة (تركيبة مستحيلة)،
 * والقياسية بعد الاعتماد أو بعد الإبلاغ (إيقاف الاعتماد — نقد الخطة 10).
 */
export function isPrintableMirror(mirror: string | null | undefined, subtype: ZatcaSubtype): boolean {
  if (!isMirror(mirror)) return false;
  if (subtype === '02') return !VOIDED_MIRRORS.includes(mirror) && !mirror.startsWith('clear');
  return mirror === 'cleared' || mirror === 'cleared_warn' || mirror === 'reported' || mirror === 'reported_warn';
}

/** مرايا حسمتها الهيئة أو أُبطلت — لا مهلةَ تجري عليها بعدُ (نظير FINAL_DOCUMENT_STATUSES على الخادم). */
const SETTLED_MIRRORS: readonly string[] = Object.freeze([
  'reported', 'reported_warn', 'cleared', 'cleared_warn', 'cleared_no_xml', 'rejected', 'withdrawn',
]);

/**
 * مستندٌ غير محسوم تجاوز مهلة الإبلاغ.
 *
 * المهلة التي يصرّح بها الخادم هي الحكم أياً كان النوع: القياسية التي ردّت عليها الهيئة ٣٠٣ («الاعتماد موقوف») تتحوّل
 * إلى مسار الإبلاغ ويُضبط لها `reportDeadline` بينما تبقى مرآتها `clearance_pending` — فلو اشترطنا النوع '02' لمرّت
 * مهلتها بلا تنبيه، وهي المخالفة عينها. وحين لا تصل مهلة (صفوف القائمة اليوم) تُحسب للمبسّطة وحدها من إصدارها:
 * القياسية في مسار الاعتماد لا مهلة إبلاغ عليها.
 */
export function isReportOverdue(v: {
  subtype: ZatcaSubtype | null; mirror: ZatcaMirrorStatus | null; issuedAt: string | null;
  reportDeadline?: string | null;
}, now: Date): boolean {
  if (!v.mirror || SETTLED_MIRRORS.includes(v.mirror)) return false;
  const deadline = v.reportDeadline ? Date.parse(v.reportDeadline) : NaN;
  if (Number.isFinite(deadline)) return now.getTime() > deadline;
  if (v.subtype !== '02') return false;
  if (v.mirror !== 'signed' && v.mirror !== 'report_blocked') return false;
  const at = v.issuedAt ? Date.parse(v.issuedAt) : NaN;
  if (!Number.isFinite(at)) return false;
  return now.getTime() > at + REPORT_WINDOW_MS;
}

/**
 * العرض المُوحَّد لصفّ مرحلة ثانية، أو null لصفّ المرحلة الأولى (فلا يتغيّر شيء لغير المفعَّلين).
 * ما يصل من الخادم في `einvoice` مُقدَّم على أعمدة الصفّ حيث وُجد: هو محسوبٌ من إسقاط المستند لحظة القراءة.
 */
export function zatcaDocView(row: ZatcaInvoiceRowLike | null | undefined, now: Date = new Date()): ZatcaDocView | null {
  if (!isZatcaPhase2Row(row) || !row) return null;
  const e = row.einvoice ?? null;
  const mirrorRaw = e && e.status !== undefined && e.status !== null ? e.status : row.einvoiceStatus;
  const mirror = isMirror(mirrorRaw) ? mirrorRaw : null;
  const subtype = asSubtype(e?.subtype) ?? asSubtype(row.invoiceSubtype);
  const issuedAt = isoOf(e?.issuedAt) ?? isoOf(row.issuedAt);
  const qr = str(e?.qr) ?? str(row.einvoiceQr);
  const printable = typeof e?.printable === 'boolean'
    ? e.printable
    : (subtype ? isPrintableMirror(mirror, subtype) : false);
  const reportDeadline = isoOf(e?.reportDeadline) ?? isoOf(row.einvoiceReportDeadline);
  const overdue = typeof e?.overdue === 'boolean'
    ? e.overdue
    : isReportOverdue({ subtype, mirror, issuedAt, reportDeadline }, now);
  return {
    phase: 2,
    mode: e?.mode === 'rehearsal' ? 'rehearsal' : 'live',
    mirror,
    documentStatus: str(e?.documentStatus),
    subtype,
    documentKind: asKind(e?.documentKind) ?? asKind(row.documentKind),
    // رمز مختوم لمستند غير قابل للطباعة لا يُعرض أصلاً — والخادم لا يرسله، وهذا حزامٌ ثانٍ
    qr: printable ? qr : null,
    printable,
    overdue,
    reportDeadline,
    issuedAt,
    uuid: str(e?.uuid) ?? str(row.einvoiceUuid),
    icv: typeof e?.icv === 'number' && Number.isFinite(e.icv) ? e.icv : null,
    warnings: Array.isArray(e?.warnings) ? e.warnings.length : 0,
  };
}

// ─── شارة الحالة ───

export type ZatcaChipTone = 'pending' | 'ok' | 'warn' | 'danger' | 'muted';

export interface ZatcaStatusChip {
  /** مفتاح ثابت للاختبار والتنسيق (لا يُعرض). */
  key: string;
  /** النصّ العربي — تمرّره الواجهة على `tr` (مُترجَم في i18n/strings.ts، يحرسه docLabels.test.ts). */
  label: string;
  /** شرحٌ عربيّ لما يجب فعله — عنوانٌ للشارة وسطرٌ في التفصيل. */
  hint: string;
  tone: ZatcaChipTone;
}

const chip = (key: string, label: string, hint: string, tone: ZatcaChipTone): ZatcaStatusChip => ({ key, label, hint, tone });

/** نصوص الشارات كاملةً — يحرس اختبارُ القاموس أنّ لكلّ نصّ هنا ترجماته الأربع. */
export const ZATCA_CHIP_LABELS: readonly string[] = Object.freeze([
  'بانتظار الإبلاغ', 'تأخر الإبلاغ', 'قيد الإرسال للهيئة', 'إعادة المحاولة مجدولة', 'مبلغة للهيئة',
  'مبلغة بملاحظات', 'توقف الإبلاغ', 'بانتظار اعتماد الهيئة', 'توقف الاعتماد', 'معتمدة من الهيئة',
  'معتمدة بملاحظات', 'اعتمدت بلا نسخة معتمدة', 'رفضتها الهيئة', 'مسحوبة قبل الإرسال', 'مستند ضريبي',
]);

export const ZATCA_CHIP_HINTS: readonly string[] = Object.freeze([
  'صدرت الفاتورة ومختومة وتبلغ بها الهيئة خلال أربع وعشرين ساعة',
  'تجاوز المستند مهلة الإبلاغ أربعا وعشرين ساعة ولم تستلمه الهيئة بعد راجع إعدادات الفوترة الإلكترونية',
  'المستند في طريقه إلى الهيئة الآن',
  'تعذر الإرسال مؤقتا وأعيدت جدولة المحاولة تلقائيا',
  'استلمت الهيئة المستند',
  'استلمت الهيئة المستند مع ملاحظات راجعها في تبويب الفوترة الإلكترونية',
  'توقف إرسال المستند إلى الهيئة أصلح إعدادات الفوترة الإلكترونية ثم أعد المحاولة',
  'لا تسلم فاتورة ضريبية قبل اعتماد الهيئة سلم سند التسليم وتصل الفاتورة المعتمدة بعد الاعتماد',
  'توقف طلب الاعتماد أصلح إعدادات الفوترة الإلكترونية ثم أعد المحاولة أو اسحب الفاتورة',
  'اعتمدت الهيئة الفاتورة ويجوز تسليمها',
  'اعتمدت الهيئة الفاتورة مع ملاحظات ويجوز تسليمها',
  'اعتمدت الهيئة الفاتورة ولم تصل نسختها المعتمدة راجع الإدارة قبل التسليم',
  'رفضت الهيئة المستند وأبطلت الفاتورة صحح البيانات وأصدر مستندا جديدا',
  'سحب المستند قبل وصوله إلى الهيئة وأبطلت الفاتورة',
  'مستند ضريبي من المرحلة الثانية',
]);

/**
 * شارة حالة الفوترة الإلكترونية لصفّ فاتورة — null لصفوف المرحلة الأولى (لا شيء يتغيّر لغير المفعَّلين).
 *
 * الترتيب مقصود: المُبطلة أوّلاً (رفض/سحب) فهي أخطر ما يُقرأ، ثم حالة المستند الجارية حين تصل (التفصيل)، ثم المرآة.
 */
export function zatcaStatusChip(row: ZatcaInvoiceRowLike | null | undefined, now: Date = new Date()): ZatcaStatusChip | null {
  const v = zatcaDocView(row, now);
  if (!v) return null;
  return zatcaChipOf(v);
}

/** الشارة من العرض المُوحَّد مباشرة (حين يكون محسوباً سلفاً). */
export function zatcaChipOf(v: ZatcaDocView): ZatcaStatusChip {
  // المُبطلة أوّلاً: لا مهلة على مستندٍ أُبطل، ورفضُ الهيئة أخطر ما يُقرأ على الصفّ
  if (v.mirror === 'rejected') {
    return chip('rejected', 'رفضتها الهيئة', 'رفضت الهيئة المستند وأبطلت الفاتورة صحح البيانات وأصدر مستندا جديدا', 'danger');
  }
  if (v.mirror === 'withdrawn') {
    return chip('withdrawn', 'مسحوبة قبل الإرسال', 'سحب المستند قبل وصوله إلى الهيئة وأبطلت الفاتورة', 'muted');
  }
  /* تجاوُز المهلة قبل المرآة: الخادم يعطي overdue على القياسية المحوَّلة إلى الإبلاغ (٣٠٣) وهي لا تزال
   * `clearance_pending` — فلو قُرئت الشارة من المرآة وحدها لقالت «بانتظار اعتماد الهيئة» عن مستندٍ مخالف. */
  if (v.overdue) {
    return chip('overdue', 'تأخر الإبلاغ', 'تجاوز المستند مهلة الإبلاغ أربعا وعشرين ساعة ولم تستلمه الهيئة بعد راجع إعدادات الفوترة الإلكترونية', 'danger');
  }
  switch (v.mirror) {
    case 'reported':
      return chip('reported', 'مبلغة للهيئة', 'استلمت الهيئة المستند', 'ok');
    case 'reported_warn':
      return chip('reported_warn', 'مبلغة بملاحظات', 'استلمت الهيئة المستند مع ملاحظات راجعها في تبويب الفوترة الإلكترونية', 'warn');
    case 'cleared':
      return chip('cleared', 'معتمدة من الهيئة', 'اعتمدت الهيئة الفاتورة ويجوز تسليمها', 'ok');
    case 'cleared_warn':
      return chip('cleared_warn', 'معتمدة بملاحظات', 'اعتمدت الهيئة الفاتورة مع ملاحظات ويجوز تسليمها', 'warn');
    case 'cleared_no_xml':
      return chip('cleared_no_xml', 'اعتمدت بلا نسخة معتمدة', 'اعتمدت الهيئة الفاتورة ولم تصل نسختها المعتمدة راجع الإدارة قبل التسليم', 'warn');
    case 'report_blocked':
      return chip('report_blocked', 'توقف الإبلاغ', 'توقف إرسال المستند إلى الهيئة أصلح إعدادات الفوترة الإلكترونية ثم أعد المحاولة', 'danger');
    case 'clearance_blocked':
      return chip('clearance_blocked', 'توقف الاعتماد', 'توقف طلب الاعتماد أصلح إعدادات الفوترة الإلكترونية ثم أعد المحاولة أو اسحب الفاتورة', 'danger');
    case 'clearance_pending':
      return chip('clearance_pending', 'بانتظار اعتماد الهيئة', 'لا تسلم فاتورة ضريبية قبل اعتماد الهيئة سلم سند التسليم وتصل الفاتورة المعتمدة بعد الاعتماد', 'pending');
    case 'signed': {
      if (v.documentStatus === 'SUBMITTING') return chip('submitting', 'قيد الإرسال للهيئة', 'المستند في طريقه إلى الهيئة الآن', 'pending');
      if (v.documentStatus === 'RETRY_WAIT') return chip('retry_wait', 'إعادة المحاولة مجدولة', 'تعذر الإرسال مؤقتا وأعيدت جدولة المحاولة تلقائيا', 'warn');
      return chip('signed', 'بانتظار الإبلاغ', 'صدرت الفاتورة ومختومة وتبلغ بها الهيئة خلال أربع وعشرين ساعة', 'pending');
    }
    // مرآةٌ لم تصل بعد (صفّ مرحلة ثانية قديم أو إسقاط ناقص): شارة محايدة لا صمت — الصفّ ضريبيّ بكل حال
    default:
      return chip('phase2', 'مستند ضريبي', 'مستند ضريبي من المرحلة الثانية', 'muted');
  }
}

// ─── الإجراءات الإدارية (POST /invoices/:id/einvoice/{retry,withdraw,reissue}) ───

export interface ZatcaRowActions {
  /** إعادة إرسال يدوية — مخرج المستند المحجوب بعد إصلاح سببه. */
  retry: boolean;
  /** سحب قياسية عالقة «بانتظار الاعتماد» (نقد الخطة 11) — لا تمرّ إلا بإثبات أن الهيئة لم تستلم. */
  withdraw: boolean;
  /** إعادة إصدار مبسّطة رفضتها الهيئة (الورقة عند المشتري فلا إبطال). */
  reissue: boolean;
}

const NO_ACTIONS: ZatcaRowActions = Object.freeze({ retry: false, withdraw: false, reissue: false });

/** حالات المستند التي يقبل الخادم منها الإعادة اليدوية (MANUAL_RETRY_FROM). */
const RETRYABLE_DOCUMENT_STATUSES: readonly string[] = Object.freeze(['RETRY_WAIT', 'AUTH_BLOCKED', 'CONFIG_ERROR']);

/**
 * ما يُعرض من الإجراءات الثلاثة. `allowed` = المستخدم من مستخدمي الشركة (requireAdmin على الخادم) — المندوب لا يراها.
 *
 * الشرط هنا **أضيق** من شرط الخادم عمداً: الخادم يرفض بعد الفحص الكامل (سجلّ المحاولات، عقد الإرسال، الإيقاف المؤقّت)،
 * وما لا نستطيع التحقّق منه في العميل لا نَعِد به زرّاً. ومن الصفّ (بلا `documentStatus`) تُعرض الإعادة للمحجوب وحده:
 * المرآة `signed`/`clearance_pending` تحتمل «قيد الإرسال الآن» فيُردّ الزرّ 409 بلا فائدة.
 *
 * ويُستثنى المتأخّر عن المهلة: شاشة المتابعة تأمر بإعادة الإرسال فوراً، فصمتُ الصفّ من الأزرار أمرٌ بما لا سبيل إليه.
 * ردُّ 409 برسالته أهون من ذلك — والشاشتان تعرضان رسالة الخادم عند الرفض.
 */
export function zatcaRowActions(
  row: ZatcaInvoiceRowLike | null | undefined,
  opts: { allowed: boolean; now?: Date } = { allowed: false },
): ZatcaRowActions {
  if (!opts.allowed) return NO_ACTIONS;
  // `now` للاختبار (التأخّر يُحسب من الساعة) — الواجهة تمرّر لحظتها الحالية ضمناً
  const v = zatcaDocView(row, opts.now ?? new Date());
  if (!v) return NO_ACTIONS;
  const blocked = v.mirror === 'report_blocked' || v.mirror === 'clearance_blocked';
  const retryByDocument = v.documentStatus !== null && RETRYABLE_DOCUMENT_STATUSES.includes(v.documentStatus);
  return {
    retry: blocked || retryByDocument || v.overdue,
    withdraw: v.subtype === '01' && (v.mirror === 'clearance_pending' || v.mirror === 'clearance_blocked'),
    reissue: v.subtype === '02' && v.mirror === 'rejected',
  };
}

/** نصوص أزرار الإجراءات — تُترجَم كغيرها. */
export const ZATCA_ACTION_LABELS = Object.freeze({
  retry: 'إعادة الإرسال للهيئة',
  withdraw: 'سحب الفاتورة',
  reissue: 'إعادة إصدار المستند',
});
