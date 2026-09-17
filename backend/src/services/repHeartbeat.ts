// ============================================================================
// نبضة المندوب — حالة جهازه الاختيارية (فوترة ZATCA المرحلة الثانية Z5.0، z5_plan §3 Z5.0 + نقد الخطة 23)
// ----------------------------------------------------------------------------
// POST /api/tracking/heartbeat يقبل جسماً اختيارياً {bundle?, outboxPending?, outboxTaxPending?} من الحزمة الحديثة. القيم تُكتب في
// تحديث lastSeenAt القائم نفسه (لا استعلام إضافي). جسم غائب أو قيم غير صالحة ⇒ تُهمل بصمت، والنبضة كما اليوم حرفياً.
//   • bundle: معرّف حزمة الواجهة (BUILD_ID) بمحارف آمنة وحتى 40.
//   • العدّان زوج واحد: عددان صحيحان غير سالبين (≤ 100000) والضريبي ≤ الكلي — وإلا يُهملان معاً؛ ومعهما outboxReportedAt بوقت
//     الخادم (لقطة متّسقة تقرؤها جاهزية التفعيل في Z5.8، لا ساعة الجهاز).
// ============================================================================

export const CLIENT_BUNDLE_RE = /^[A-Za-z0-9._:+-]{1,40}$/;
export const MAX_OUTBOX_COUNT = 100_000;

export interface HeartbeatClientState {
  clientBundle?: string;
  outboxPending?: number;
  outboxTaxPending?: number;
  outboxReportedAt?: Date;
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_OUTBOX_COUNT ? v : null);

export function heartbeatClientState(body: unknown, now: Date): HeartbeatClientState {
  const out: HeartbeatClientState = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return out;
  const b = body as Record<string, unknown>;
  if (typeof b.bundle === 'string' && CLIENT_BUNDLE_RE.test(b.bundle)) out.clientBundle = b.bundle;
  const pending = count(b.outboxPending);
  const tax = count(b.outboxTaxPending);
  if (pending !== null && tax !== null && tax <= pending) {
    out.outboxPending = pending;
    out.outboxTaxPending = tax;
    out.outboxReportedAt = new Date(now.getTime());
  }
  return out;
}
