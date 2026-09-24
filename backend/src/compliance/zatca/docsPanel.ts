// ============================================================================
// ZATCA المرحلة الثانية (Z5.7) — إسقاط شاشة متابعة المستندات: منطقٌ نقيّ بلا قاعدة بيانات ولا شبكة ولا ساعة
// ----------------------------------------------------------------------------
// ما تحلّه هذه الوحدة (فجوة خادم وثّقتها Z5.6 في web-admin/src/lib/zatca/docQueue.ts):
//   • الشاشة كانت تقرأ نافذةً من `GET /invoices` وتصنّفها في العميل — فالعدّادات عن ٢٠٠ صفّ لا عن الشركة، وشركةٌ
//     تجاوزت فواتيرها السقف يسقط **أقدم** مستنداتها من القراءة وهي بعينها الأقرب لتجاوز مهلة الإبلاغ.
//   • «آخر ما قالته الهيئة» كان يُقرأ من `einvoiceWarnings` وحده (نصّ مرآة مقصوص)، ولا سبيل إلى رسائل المستند
//     المخزَّنة في `ZatcaDocument.validation` ولا إلى أثر `ZatcaApiLog`.
//   • `CompanySettings.zatcaSubmitPausedAt` عمودٌ لا يعيده أيّ مسار، فكانت الشاشة تقول «تأخّر» ولا تجرؤ على
//     «موقوف» — والفرق بينهما هو الفرق بين «انتظر» و«تصرّف الآن».
//
// قواعد هذه الوحدة:
//   • **الدلاء هي دلاء العميل حرفاً بحرف** (docQueue.zatcaQueueBucket): المرآة أوّلاً ثم التأخّر ثم الحجب ثم الحسم.
//     لو تباعدت النسختان لعرضت الشاشة عدّاداً يخالف قائمتها — فالنسخة الخادمية تُختبر بالنصّ نفسه.
//   • **كلّ نصّ خارجيّ يمرّ بالتنقية**: الهيئة طرفٌ خارجيّ، ورسائلها تُخزَّن ثم تُعرض. التنقية هنا طبقةٌ ثانية فوق
//     `redactResponseForLog` وقت الكتابة: قائمةُ حقولٍ بيضاء (النوع والرمز والتصنيف والنصّ لا غير)، ومحارف التحكّم
//     تُزال، وقيم Basic وتسلسلات base64 الطويلة وBearer وOTP تُمحى، ثمّ يُقصّ الطول.
//     والقصّ **بعد** المحو لا قبله: قصٌّ قبل المحو يقطع السرّ نصفين فيفلت من المطابق.
//   • لا تستورد قاعدة بيانات ولا services/gl (يحرسه tests/gl-hooks-static.test.ts بمسح المجلّد).
// ============================================================================

import { scrubSecrets } from './responses';
import { FINAL_DOCUMENT_STATUSES, type InvoiceMirrorStatus } from './status';

// ─── الدلاء ───

export type QueueBucket = 'pending' | 'overdue' | 'blocked' | 'rejected' | 'done';

/** ترتيب العرض: الأعجل أوّلاً — نسخة docQueue.BUCKET_RANK. */
export const QUEUE_BUCKETS: readonly QueueBucket[] = Object.freeze(
  ['overdue', 'blocked', 'pending', 'rejected', 'done'] as QueueBucket[],
);

/** مرشِّح المسار = دلوٌ واحد أو الكلّ. */
export type QueueFilter = 'all' | QueueBucket;
export const QUEUE_FILTERS: readonly QueueFilter[] = Object.freeze(['all', ...QUEUE_BUCKETS] as QueueFilter[]);

export function isQueueFilter(v: unknown): v is QueueFilter {
  return typeof v === 'string' && (QUEUE_FILTERS as readonly string[]).includes(v);
}

/**
 * دلو الصفّ من مرآته وتأخّره — **نسخةٌ حرفية** من web-admin/src/lib/zatca/docQueue.ts:zatcaQueueBucket.
 * `cleared_no_xml` «تحتاج تدخّلاً» لا «محسومة»: الهيئة حسمتها، ونسختها المعتمدة لم تصل، فلا تُسلَّم فاتورةً ضريبية.
 */
export function bucketOfMirror(mirror: string | null | undefined, overdue: boolean): QueueBucket {
  if (mirror === 'rejected' || mirror === 'withdrawn') return 'rejected';
  if (overdue) return 'overdue';
  if (mirror === 'report_blocked' || mirror === 'clearance_blocked' || mirror === 'cleared_no_xml') return 'blocked';
  if (mirror === 'reported' || mirror === 'reported_warn' || mirror === 'cleared' || mirror === 'cleared_warn') return 'done';
  return 'pending';
}

/**
 * مرايا كلّ دلو — مفتاح استعلام القائمة (`Invoice.einvoiceStatus IN (…)`) بلا مسحٍ لجدول الفواتير.
 * و`overdue` ليست مرآةً بل حالةٌ **محسوبة** على المستند (مهلة الإبلاغ)، فمرشِّحها يُبنى على `zatca_documents`
 * لا على المرآة؛ وما هنا هو مجموعة المرايا التي **يمكن** أن تتأخّر (غير النهائية وحدها).
 */
export const BUCKET_MIRRORS: Readonly<Record<QueueBucket, readonly InvoiceMirrorStatus[]>> = Object.freeze({
  pending: Object.freeze(['signed', 'clearance_pending'] as InvoiceMirrorStatus[]),
  overdue: Object.freeze(['signed', 'clearance_pending', 'report_blocked', 'clearance_blocked'] as InvoiceMirrorStatus[]),
  blocked: Object.freeze(['report_blocked', 'clearance_blocked', 'cleared_no_xml'] as InvoiceMirrorStatus[]),
  rejected: Object.freeze(['rejected', 'withdrawn'] as InvoiceMirrorStatus[]),
  done: Object.freeze(['reported', 'reported_warn', 'cleared', 'cleared_warn'] as InvoiceMirrorStatus[]),
});

/** حالات المستند غير النهائية — مرشِّح التأخّر (مستندٌ حُسم لا يتأخّر مهما فاتت مهلته). */
export const NON_FINAL_DOCUMENT_STATUSES: readonly string[] = Object.freeze(
  ['SIGNED', 'SUBMITTING', 'RETRY_WAIT', 'AUTH_BLOCKED', 'CONFIG_ERROR'].filter(
    s => !(FINAL_DOCUMENT_STATUSES as readonly string[]).includes(s),
  ),
);

export type BucketCounts = Record<QueueBucket, number>;

export function emptyCounts(): BucketCounts {
  return { overdue: 0, blocked: 0, pending: 0, rejected: 0, done: 0 };
}

/**
 * عدّادات الدلاء من تجميعة المرايا (`GROUP BY einvoiceStatus`) وعدد المتأخّرين المقروء مستقلاًّ.
 * المتأخّر يُنقل من دلوه المرآويّ إلى `overdue` كما يفعل العميل تماماً: مرآته غير نهائية، فهو في `pending`
 * أو `blocked`، ويُخصم منهما بالترتيب نفسه (الحجب أوّلاً — فالمتأخّر المحجوب أدقّ وصفاً).
 */
export function countsFromMirrors(
  groups: ReadonlyArray<{ mirror: string | null; count: number }>,
  overdueCount: number,
): BucketCounts {
  const out = emptyCounts();
  for (const g of groups) {
    const n = Number.isFinite(g.count) && g.count > 0 ? Math.trunc(g.count) : 0;
    if (n === 0) continue;
    out[bucketOfMirror(g.mirror, false)] += n;
  }
  let left = Number.isFinite(overdueCount) && overdueCount > 0 ? Math.trunc(overdueCount) : 0;
  for (const from of ['blocked', 'pending'] as const) {
    if (left === 0) break;
    const take = Math.min(left, out[from]);
    out[from] -= take;
    out.overdue += take;
    left -= take;
  }
  // فائضٌ لا يقابله صفّ في التجميعة (سباق قراءةٍ بين الاستعلامين) يُعرض ولا يُخفى
  out.overdue += left;
  return out;
}

// ─── التنقية ───

export const MAX_PANEL_MESSAGES = 20;
export const MAX_MESSAGE_CHARS = 240;
export const MAX_CODE_CHARS = 64;

const CONTROL_RE = /[\u0000-\u001F\u007F]+/g;
/** رمزٌ حامل يُكتب أحياناً في نصّ خطأ شبكة — يُمحى ولو لم يكن سرّاً نعرفه. */
const BEARER_RE = /\b(?:bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** OTP: رقمٌ يتبع لفظه مباشرةً. لا يُمحى كلّ رقم (أرقام الفواتير والمبالغ جزءٌ من الرسالة المفيدة). */
const OTP_RE = /\b(otp|one[\s-]?time[\s-]?(?:password|code)|كلمة\s*المرور\s*لمرة)\s*[:=#]?\s*[A-Za-z0-9-]{4,}/gi;

export const REDACTED = '[REDACTED]';

/**
 * نصٌّ خارجيّ صالح للعرض: تُزال محارف التحكّم، ثمّ تُمحى الأسرار العامّة (Basic، base64 طويلة، Bearer، OTP)،
 * ثمّ يُقصّ. الترتيب مقصود — القصّ قبل المحو يقطع السرّ فيفلت من المطابق.
 */
export function scrubPanelText(v: unknown, max: number = MAX_MESSAGE_CHARS): string | null {
  if (typeof v !== 'string') return null;
  const flat = v.replace(CONTROL_RE, ' ').replace(/\s{2,}/g, ' ').trim();
  if (flat === '') return null;
  let s: string;
  try {
    s = scrubSecrets(flat, []);
  } catch {
    return REDACTED;
  }
  s = s.replace(BEARER_RE, REDACTED).replace(OTP_RE, `$1 ${REDACTED}`).trim();
  if (s === '') return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export type PanelMessageKind = 'error' | 'warning' | 'info';

export interface PanelMessage {
  kind: PanelMessageKind;
  code: string | null;
  category: string | null;
  text: string | null;
}

const kindOf = (type: unknown, fallback: PanelMessageKind): PanelMessageKind => {
  const t = typeof type === 'string' ? type.toUpperCase() : '';
  return t === 'ERROR' ? 'error' : t === 'WARNING' ? 'warning' : t === 'INFO' ? 'info' : fallback;
};

/** رسالةٌ واحدة بقائمة حقولٍ بيضاء — ما ليس في القائمة لا يخرج مهما كان في الصفّ. */
function messageOf(raw: unknown, fallback: PanelMessageKind): PanelMessage | null {
  if (raw === null || typeof raw !== 'object') {
    const text = scrubPanelText(raw);
    return text === null ? null : { kind: fallback, code: null, category: null, text };
  }
  const r = raw as Record<string, unknown>;
  const m: PanelMessage = {
    kind: kindOf(r.type, fallback),
    code: scrubPanelText(r.code, MAX_CODE_CHARS),
    category: scrubPanelText(r.category, MAX_CODE_CHARS),
    text: scrubPanelText(r.message),
  };
  return m.code === null && m.category === null && m.text === null ? null : m;
}

function listOf(raw: unknown, fallback: PanelMessageKind, budget: number): PanelMessage[] {
  if (!Array.isArray(raw) || budget <= 0) return [];
  const out: PanelMessage[] = [];
  for (const item of raw) {
    if (out.length >= budget) break;
    const m = messageOf(item, fallback);
    if (m) out.push(m);
  }
  return out;
}

export interface DocumentDiagnostics {
  /** لحظة كتابة النتيجة كما خزّنها محرّك الإرسال (ISO) — لا ساعة هنا. */
  at: string | null;
  outcome: string | null;
  /** عطلٌ محليّ (LocalFailure) — رمزٌ مغلق لا نصّ حرّ. */
  local: string | null;
  reason: string | null;
  validationStatus: string | null;
  reportingStatus: string | null;
  clearanceStatus: string | null;
  truncated: boolean;
  errors: PanelMessage[];
  warnings: PanelMessage[];
}

export function emptyDiagnostics(): DocumentDiagnostics {
  return {
    at: null, outcome: null, local: null, reason: null, validationStatus: null, reportingStatus: null,
    clearanceStatus: null, truncated: false, errors: [], warnings: [],
  };
}

/**
 * تشخيص المستند من `ZatcaDocument.validation` (يكتبه submit.ts:validationOf من الردّ المنقّح وحده).
 * الأخطاء قبل التحذيرات في الميزانية: حين تمتلئ الحصّة يبقى ما يوقف الفاتورة لا ما يزيّنها.
 */
export function diagnosticsOf(raw: unknown, budget: number = MAX_PANEL_MESSAGES): DocumentDiagnostics {
  const out = emptyDiagnostics();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  out.at = scrubPanelText(r.at, MAX_CODE_CHARS);
  out.outcome = scrubPanelText(r.outcome, MAX_CODE_CHARS);
  out.local = scrubPanelText(r.local, MAX_CODE_CHARS);
  out.reason = scrubPanelText(r.reason, MAX_CODE_CHARS);
  out.validationStatus = scrubPanelText(r.validationStatus, MAX_CODE_CHARS);
  out.reportingStatus = scrubPanelText(r.reportingStatus, MAX_CODE_CHARS);
  out.clearanceStatus = scrubPanelText(r.clearanceStatus, MAX_CODE_CHARS);
  out.truncated = r.truncated === true;
  out.errors = listOf(r.errors, 'error', budget);
  out.warnings = listOf(r.warnings, 'warning', Math.max(0, budget - out.errors.length));
  return out;
}

/** رسائل المرآة (`Invoice.einvoiceWarnings` نصّ JSON) — للصفوف التي لا يُقرأ لها مستند. */
export function mirrorMessagesOf(raw: unknown, budget: number = MAX_PANEL_MESSAGES): PanelMessage[] {
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { return []; }
  }
  return listOf(arr, 'warning', budget);
}

/** أوّل خطأ (أو أوّل تحذير إن لم يكن ثمّ خطأ) — سطر «آخر ما قالته الهيئة» في صفّ القائمة. */
export function headlineMessage(d: DocumentDiagnostics): PanelMessage | null {
  return d.errors[0] ?? d.warnings[0] ?? null;
}

// ─── أثر الطلبات (ZatcaApiLog) ───

export const MAX_LOG_ROWS = 10;

export interface ApiLogLine {
  at: string;
  endpoint: string | null;
  httpStatus: number | null;
  outcome: string | null;
  durationMs: number | null;
  error: string | null;
}

/**
 * سطرٌ من أثر الطلبات. `response` (الجسم المنقّح) **لا يخرج**: فيه أعدادٌ وأعلامٌ تخصّ التشخيص الداخليّ،
 * ورسائلُه هي نفسها التي وصلت `validation`. يخرج منه المعنى وحده: الوجهة والحالة والنتيجة والمدّة ونصّ الخطأ منقّى.
 */
export function apiLogLineOf(row: {
  createdAt: Date | string; endpoint?: unknown; httpStatus?: unknown; outcome?: unknown; durationMs?: unknown; errorText?: unknown;
}): ApiLogLine {
  const at = row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt ?? '');
  return {
    at,
    endpoint: scrubPanelText(row.endpoint, MAX_CODE_CHARS),
    httpStatus: typeof row.httpStatus === 'number' && Number.isFinite(row.httpStatus) ? row.httpStatus : null,
    outcome: scrubPanelText(row.outcome, MAX_CODE_CHARS),
    durationMs: typeof row.durationMs === 'number' && Number.isFinite(row.durationMs) ? row.durationMs : null,
    error: scrubPanelText(row.errorText),
  };
}

// ─── تنزيل الـXML ───

export type XmlVariant = 'signed' | 'cleared';

export function isXmlVariant(v: unknown): v is XmlVariant {
  return v === 'signed' || v === 'cleared';
}

/**
 * اسم الملف: رقم الفاتورة ورقم المحاولة والنسخة. رقم الفاتورة نصٌّ يكتبه المستخدم، فلا يدخل الترويسة كما هو:
 * تُبقى المحارف الآمنة وحدها (ASCII) في `filename`، ويُحمل الاسم الكامل بـ`filename*` (RFC 5987).
 */
export function xmlFileNameOf(input: { number?: string | null; attemptNo?: number | null; variant: XmlVariant }): string {
  const raw = typeof input.number === 'string' ? input.number.trim() : '';
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const base = safe === '' ? 'invoice' : safe;
  const attempt = Number.isInteger(input.attemptNo) && (input.attemptNo as number) > 1 ? `-a${input.attemptNo}` : '';
  return `${base}${attempt}-${input.variant}.xml`;
}

/** ترويسة Content-Disposition كاملة لاسمٍ قد يحمل محارف غير ASCII. */
export function contentDispositionOf(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
