/**
 * فوترة ZATCA المرحلة الثانية (Z5.6c) — شاشة متابعة المستندات الضريبية لمدير الشركة: منطقٌ نقيّ بلا React ولا شبكة.
 *
 * ما تحرسه هذه الشاشة: المستند الضريبيّ **يُرسَل بعد الإصدار**، وقد يتوقّف إرساله (شهادة منتهية، إعداد معطوب، عطل
 * الهيئة) بلا أن يشعر أحد — فتمرّ مهلة الإبلاغ (٢٤ ساعة للمبسّطة) على مستندٍ لم تستلمه الهيئة، وذلك مخالفةٌ نظامية.
 * فالشاشة تقلب الطابور من «صامت» إلى «معروض»: كم مستنداً معلّقاً، وكم متوقّفاً، وما آخر رسالة قالتها الهيئة لكلّ
 * مستند، وما الإجراء المتاح عليه الآن.
 *
 * **مصدر البيانات وحدوده (فجوة خادم موثَّقة):** لا مسار في الخادم يعيد طابور المستندات مجمَّعاً (لا مرشِّح
 * `einvoiceStatus` على `GET /invoices`، ولا عدّاداً في `GET /api/zatca/overview`، ولا عمود «آخر خطأ»). فالشاشة تقرأ
 * نافذةً زمنية من `GET /invoices` وتصنّفها هنا من أعمدة المرآة التي يحملها كلّ صفّ، وآخر رسالةٍ من `einvoiceWarnings`
 * (نصّ JSON يكتبه محرّك الإرسال). ومن ثمّ: **العدادات عن النافذة المحمَّلة لا عن الشركة كلّها** — والواجهة تقول ذلك
 * حرفياً بدل أن توهم بعددٍ شامل. ولو أضاف الخادم لاحقاً مسار طابور، يُستبدل المصدر وحده ويبقى هذا المنطق كما هو.
 *
 * و«الإرسال موقوف» (`zatcaSubmitPausedAt`) عمودٌ موجود في القاعدة ولا يعيده أيّ مسار، فلا يُدّعى هنا عِلمٌ به: يُستنتج
 * **تأخّرٌ** من المستندات نفسها (معلّقة منذ أكثر من نصف ساعة) ويُقال بلفظه — «تأخّر»، لا «موقوف».
 */

import {
  zatcaChipOf, zatcaDocView, zatcaRowActions,
  type ZatcaDocView, type ZatcaInvoiceRowLike, type ZatcaRowActions, type ZatcaStatusChip,
} from './docStatus';

// ─── الدلاء (تصنيف الصفّ في الطابور) ───

export type ZatcaQueueBucket = 'pending' | 'overdue' | 'blocked' | 'rejected' | 'done';

export const ZATCA_QUEUE_BUCKETS: readonly ZatcaQueueBucket[] = Object.freeze(
  ['pending', 'overdue', 'blocked', 'rejected', 'done'] as ZatcaQueueBucket[],
);

/** مرشِّح الشاشة = دلوٌ واحد أو الكلّ. */
export type ZatcaQueueFilter = 'all' | ZatcaQueueBucket;
export const ZATCA_QUEUE_FILTERS: readonly ZatcaQueueFilter[] = Object.freeze(
  ['all', 'overdue', 'blocked', 'pending', 'rejected', 'done'] as ZatcaQueueFilter[],
);

/** مستندٌ معلّق منذ أكثر من هذا يُعدّ متأخّراً عن الإرسال (لا «موقوفاً» — العمود الذي يقول ذلك لا يصل العميل). */
export const STALL_MS = 30 * 60 * 1000;

/** ترتيب العرض: الأعجل أوّلاً. متأخّرة الإبلاغ قبل المتوقّفة قبل المعلّقة، والمحسومة آخراً. */
const BUCKET_RANK: Readonly<Record<ZatcaQueueBucket, number>> = Object.freeze({
  overdue: 0, blocked: 1, pending: 2, rejected: 3, done: 4,
});

/**
 * دلو الصفّ من عرضه المُوحَّد.
 *
 * `cleared_no_xml` تُصنَّف «تحتاج تدخّلاً» لا «محسومة»: الهيئة حسمتها فعلاً، لكنّ نسختها المعتمدة لم تصل فلا تُسلَّم
 * فاتورةً ضريبية — وهو بالضبط ما يحتاج عين المدير.
 */
export function zatcaQueueBucket(v: ZatcaDocView): ZatcaQueueBucket {
  if (v.mirror === 'rejected' || v.mirror === 'withdrawn') return 'rejected';
  if (v.overdue) return 'overdue';
  if (v.mirror === 'report_blocked' || v.mirror === 'clearance_blocked' || v.mirror === 'cleared_no_xml') return 'blocked';
  if (v.mirror === 'reported' || v.mirror === 'reported_warn' || v.mirror === 'cleared' || v.mirror === 'cleared_warn') return 'done';
  return 'pending';
}

// ─── رسائل الهيئة المخزَّنة على الصفّ ───

export interface ZatcaDocMessage {
  kind: 'error' | 'warning';
  code: string;
  text: string;
}

/** أقصى ما يُعرض من نصّ رسالةٍ أعادتها الهيئة (نصّ خارجيّ يُعرض كما هو فيُقصّ ويُنقّى من محارف التحكّم). */
export const MAX_MESSAGE_CHARS = 240;

const clean = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS) : '';

/**
 * رسائل المستند: من نصّ `einvoiceWarnings` (صفّ القائمة) أو من مصفوفة `einvoice.warnings` (التفصيل).
 * يكتبها محرّك الإرسال بالشكل `{ type, code, message, category }` — والخطأ يُكتب مع التحذير عند الرفض.
 */
export function zatcaDocMessages(raw: unknown): ZatcaDocMessage[] {
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    if (raw === '') return [];
    try { arr = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const out: ZatcaDocMessage[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const m = item as { type?: unknown; code?: unknown; message?: unknown };
    const text = clean(m.message);
    const code = clean(m.code);
    if (!text && !code) continue;
    const t = typeof m.type === 'string' ? m.type.toUpperCase() : '';
    out.push({ kind: t === 'ERROR' ? 'error' : 'warning', code, text });
  }
  return out;
}

/** الرسالة التي تُعرض في السطر: أوّل خطأ إن وُجد، وإلا أوّل تحذير. */
export function zatcaLastMessage(raw: unknown): ZatcaDocMessage | null {
  const all = zatcaDocMessages(raw);
  return all.find(m => m.kind === 'error') ?? all[0] ?? null;
}

// ─── صفوف الطابور ───

/** صفّ فاتورة كما تعيده `GET /invoices` — ما تحتاجه الشاشة منه فقط. */
export interface ZatcaQueueSource extends ZatcaInvoiceRowLike {
  id?: unknown;
  number?: unknown;
  total?: unknown;
  invoiceDate?: unknown;
  einvoiceWarnings?: unknown;
  customer?: { name?: unknown } | null;
  salesRep?: { name?: unknown } | null;
}

export interface ZatcaQueueRow {
  id: string;
  number: string;
  customerName: string;
  repName: string;
  total: number | null;
  /** لحظة إصدار المستند الضريبي (الخادم) وإلا تاريخ الفاتورة. */
  at: string | null;
  view: ZatcaDocView;
  chip: ZatcaStatusChip;
  bucket: ZatcaQueueBucket;
  actions: ZatcaRowActions;
  message: ZatcaDocMessage | null;
  /** معلّق منذ أكثر من نصف ساعة — مؤشّر تأخّر الإرسال (لا حكم بالتوقّف). */
  stalled: boolean;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const numOrNull = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * صفوف الطابور من صفوف القائمة: **صفوف المرحلة الثانية وحدها** (ما عداها يسقط، فلا تظهر فاتورة مرحلة أولى في شاشة
 * الفوترة الإلكترونية). مرتّبةٌ بالأعجل ثمّ بالأقدم إصداراً داخل الدلو الواحد — أقدم مستندٍ متوقّف هو أقربها للمخالفة.
 */
export function zatcaQueueRows(
  rows: readonly unknown[] | null | undefined,
  opts: { allowed: boolean; now?: Date } = { allowed: false },
): ZatcaQueueRow[] {
  const now = opts.now ?? new Date();
  const out: ZatcaQueueRow[] = [];
  for (const raw of rows ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as ZatcaQueueSource;
    const view = zatcaDocView(row, now);
    if (!view) continue;
    const at = view.issuedAt ?? (typeof row.invoiceDate === 'string' ? row.invoiceDate : null);
    const bucket = zatcaQueueBucket(view);
    const issuedMs = view.issuedAt ? Date.parse(view.issuedAt) : NaN;
    out.push({
      id: text(row.id),
      number: text(row.number),
      customerName: text(row.customer?.name),
      repName: text(row.salesRep?.name),
      total: numOrNull(row.total),
      at,
      view,
      chip: zatcaChipOf(view),
      bucket,
      actions: zatcaRowActions(row, { allowed: opts.allowed }),
      message: zatcaLastMessage(row.einvoiceWarnings),
      stalled: bucket === 'pending' && Number.isFinite(issuedMs) && now.getTime() - issuedMs > STALL_MS,
    });
  }
  return out.sort((a, b) => {
    const r = BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket];
    if (r !== 0) return r;
    const at = a.at ? Date.parse(a.at) : 0;
    const bt = b.at ? Date.parse(b.at) : 0;
    return at - bt;
  });
}

export type ZatcaQueueCounts = Record<ZatcaQueueBucket, number> & { all: number; stalled: number; noXml: number };

export function zatcaQueueCounts(rows: readonly ZatcaQueueRow[]): ZatcaQueueCounts {
  const c: ZatcaQueueCounts = { all: rows.length, stalled: 0, noXml: 0, pending: 0, overdue: 0, blocked: 0, rejected: 0, done: 0 };
  for (const r of rows) {
    c[r.bucket] += 1;
    if (r.stalled) c.stalled += 1;
    // «اعتمدت بلا نسخة معتمدة» تقع في دلو «تحتاج تدخّلاً» وليست توقّف إرسال — تُعدّ على حدة ليُفرَد لها تنبيهها
    if (r.view.mirror === 'cleared_no_xml') c.noXml += 1;
  }
  return c;
}

export function zatcaQueueFilterRows(rows: readonly ZatcaQueueRow[], filter: ZatcaQueueFilter): ZatcaQueueRow[] {
  return filter === 'all' ? [...rows] : rows.filter(r => r.bucket === filter);
}

// ─── التنبيهات فوق الطابور ───

export type ZatcaQueueAlertTone = 'danger' | 'warning';

export interface ZatcaQueueAlert {
  key: 'overdue' | 'blocked' | 'noXml' | 'stalled' | 'rejected';
  tone: ZatcaQueueAlertTone;
  /** عنوان عربيّ يُمرَّر على `tr`. */
  title: string;
  /** شرحٌ عربيّ لما يفعله المدير الآن. */
  body: string;
  count: number;
}

export const ZATCA_QUEUE_ALERT_TITLES: readonly string[] = Object.freeze([
  'مستندات تجاوزت مهلة الإبلاغ',
  'مستندات متوقفة تحتاج تدخلا',
  'تأخر وصول مستندات إلى الهيئة',
  'مستندات مبطلة لدى الهيئة',
  'مستندات اعتمدت بلا نسخة معتمدة',
]);

export const ZATCA_QUEUE_ALERT_BODIES: readonly string[] = Object.freeze([
  'تجاوزت هذه المستندات أربعا وعشرين ساعة ولم تستلمها الهيئة بعد أصلح سبب التوقف ثم أعد الإرسال فورا',
  'توقف إرسال هذه المستندات إلى الهيئة راجع حالة وحدة الربط والشهادة ثم أعد الإرسال',
  'مستندات مضى على إصدارها أكثر من نصف ساعة ولم تحسمها الهيئة بعد إن استمر ذلك فراجع حالة الربط',
  'مستندات رفضتها الهيئة أو سحبت قبل وصولها وأبطلت فواتيرها راجعها وأصدر بديلها',
  'اعتمدت الهيئة هذه الفواتير ولم تصل نسختها المعتمدة فلا تسلم عنها فاتورة ضريبية ولا يفيد فيها إرسال جديد تواصل مع الدعم',
]);

/**
 * التنبيهات المستحقّة الآن — بترتيب الخطورة، وبلا تنبيهٍ بعدد صفر.
 *
 * و«اعتمدت بلا نسخة معتمدة» تُفرَد عن المتوقّفة: الخادم لا يقبل عليها إعادة إرسال (حالةٌ نهائية خارج
 * `MANUAL_RETRY_FROM`)، فتنبيهُ «أعد الإرسال» عليها أمرٌ بما لا زرّ له ولا مسار.
 */
export function zatcaQueueAlerts(rows: readonly ZatcaQueueRow[]): ZatcaQueueAlert[] {
  const c = zatcaQueueCounts(rows);
  const alerts: ZatcaQueueAlert[] = [];
  if (c.overdue > 0) {
    alerts.push({ key: 'overdue', tone: 'danger', title: ZATCA_QUEUE_ALERT_TITLES[0], body: ZATCA_QUEUE_ALERT_BODIES[0], count: c.overdue });
  }
  const blockedOnly = c.blocked - c.noXml;
  if (blockedOnly > 0) {
    alerts.push({ key: 'blocked', tone: 'danger', title: ZATCA_QUEUE_ALERT_TITLES[1], body: ZATCA_QUEUE_ALERT_BODIES[1], count: blockedOnly });
  }
  if (c.noXml > 0) {
    alerts.push({ key: 'noXml', tone: 'warning', title: ZATCA_QUEUE_ALERT_TITLES[4], body: ZATCA_QUEUE_ALERT_BODIES[4], count: c.noXml });
  }
  if (c.stalled > 0) {
    alerts.push({ key: 'stalled', tone: 'warning', title: ZATCA_QUEUE_ALERT_TITLES[2], body: ZATCA_QUEUE_ALERT_BODIES[2], count: c.stalled });
  }
  if (c.rejected > 0) {
    alerts.push({ key: 'rejected', tone: 'warning', title: ZATCA_QUEUE_ALERT_TITLES[3], body: ZATCA_QUEUE_ALERT_BODIES[3], count: c.rejected });
  }
  return alerts;
}

// ─── تأكيد الإجراءات ───

export type ZatcaActionKind = 'retry' | 'withdraw' | 'reissue';

export interface ZatcaActionConfirm {
  /** كلمةٌ تُكتب يدوياً قبل التنفيذ — `null` فتأكيدٌ بنقرة. لا تُطلب إلا لما لا رجعة فيه. */
  typed: string | null;
  title: string;
  body: string;
  danger: boolean;
}

/**
 * السحب وحده يستحقّ الكتابة اليدوية: يُبطل الفاتورة نهائياً (يُعكس قيدها ويُلغى صفّها) ولا تراجع عنه. والإعادة
 * (إرسال البايتات نفسها) وإعادة الإصدار (مستندٌ جديد بالرقم نفسه لمبسّطة مرفوضة) قابلتان للتكرار بلا ضرر.
 */
export function zatcaActionConfirm(kind: ZatcaActionKind): ZatcaActionConfirm {
  if (kind === 'withdraw') {
    return {
      typed: 'سحب',
      danger: true,
      title: 'سحب الفاتورة وإبطالها',
      body: 'لا يمر السحب إلا إن لم تستلم الهيئة المستند وتبطل الفاتورة نهائيا ولا يمكن التراجع اكتب كلمة سحب للتأكيد',
    };
  }
  if (kind === 'reissue') {
    return {
      typed: null,
      danger: false,
      title: 'إعادة إصدار المستند',
      body: 'تصدر نسخة جديدة من المستند المبسط المرفوض بالرقم والتاريخ نفسيهما وترسل إلى الهيئة من جديد',
    };
  }
  return {
    typed: null,
    danger: false,
    title: 'إعادة الإرسال إلى الهيئة',
    body: 'تعاد البايتات الموقعة نفسها إلى طابور الإرسال الآن أصلح سبب التوقف أولا وإلا توقف المستند من جديد',
  };
}

// ─── نصوص الشاشة (يحرسها اختبار القاموس) ───

export const ZATCA_QUEUE_FILTER_LABELS: Readonly<Record<ZatcaQueueFilter, string>> = Object.freeze({
  all: 'الكل',
  overdue: 'تجاوزت المهلة',
  blocked: 'تحتاج تدخلا',
  pending: 'قيد الإرسال',
  rejected: 'مبطلة',
  done: 'وصلت الهيئة',
});

export const ZATCA_QUEUE_PHRASES: readonly string[] = Object.freeze([
  'متابعة المستندات الضريبية',
  'حالة مستندات الفوترة الإلكترونية لدى الهيئة وما يلزم من إجراء لكل مستند',
  'فتح شاشة المتابعة',
  'إغلاق',
  'آخر سبعة أيام',
  'آخر ثلاثين يوما',
  'العدد عن النافذة المعروضة وحدها لا عن كل مستندات الشركة',
  'عرضت أحدث المستندات وحدها وبقي أقدمها خارج النافذة قلص المدة أو راجع الطابور على دفعات',
  'اكتب هذه الكلمة للتأكيد',
  'لا مستندات ضريبية في هذه النافذة',
  'تعذر تحميل مستندات الفوترة الإلكترونية',
  'الرقم',
  'العميل',
  'المندوب',
  'وقت الإصدار',
  'الحالة',
  'آخر رسالة من الهيئة',
  'إجراءات',
  'تحديث',
  'تأكيد',
  'إلغاء',
  'جاري التحميل',
  'تعذر تنفيذ الإجراء',
  'لا رسالة',
  'تأخر الإرسال',
  'مستند ضريبي',
  ...ZATCA_QUEUE_ALERT_TITLES,
  ...ZATCA_QUEUE_ALERT_BODIES,
  ...Object.values(ZATCA_QUEUE_FILTER_LABELS),
  'سحب الفاتورة وإبطالها',
  'لا يمر السحب إلا إن لم تستلم الهيئة المستند وتبطل الفاتورة نهائيا ولا يمكن التراجع اكتب كلمة سحب للتأكيد',
  'إعادة إصدار المستند',
  'تصدر نسخة جديدة من المستند المبسط المرفوض بالرقم والتاريخ نفسيهما وترسل إلى الهيئة من جديد',
  'إعادة الإرسال إلى الهيئة',
  'تعاد البايتات الموقعة نفسها إلى طابور الإرسال الآن أصلح سبب التوقف أولا وإلا توقف المستند من جديد',
  'سحب',
]);
