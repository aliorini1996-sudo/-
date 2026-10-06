/**
 * «اشتراط تفعيل الموقع» — القفل الكامل (أمر المالك، ٦ أكتوبر ٢٠٢٦): المندوب المقيَّد لا يفعل شيئاً أبداً إلا وموقعه مفعّل
 * ومحدَّد بدقّة وهو متصل وظاهرٌ على الخريطة في مكانٍ بعينه. الحكم صرفٌ هنا (بلا قاعدة ولا Express)، والحارس في
 * middleware/repLiveLocation.ts.
 *
 * «ظاهر على الخريطة الآن» = أحدث نقطةٍ استقبلها الخادم منه (RepLocation) — وهي ما يرسم دبّوسه:
 *  • استُقبلت خلال W بساعة الخادم (createdAt) — متصلٌ الآن، لا قبل ساعة؛
 *  • والتُقطت خلال W من ساعة الخادم (capturedAt بعد تصحيح انحراف ساعة الجهاز) — لا قراءةٌ مخبّأة قديمة يعيدها المتصفّح
 *    والموقع مطفأ؛
 *  • ودقّتها معلومة ≤ A متراً — لا «موقع تقريبي» (١–١٠ كم) ولا برج اتصالات (٣٠٠–٣٠٠٠ م)؛
 *  • وليست (0،0) — قراءةٌ فاسدة لا مكان.
 *
 * W = 90ث: دورة رفع التتبّع ٤٥ث + فاصل النقاط ٨ث + الشبكة، وتحتمل دورةً فائتة. والتطبيق يرسل نقطةً طازجة قبل كل إجراء
 * (repApi) فالفجوة الفعلية ثوانٍ؛ والنافذة نفسها أقصى ما يُفلت لعميلٍ يكذب بعد إطفاء الموقع.
 * A = 100م: GPS في الخارج ٣–٢٠م وWi‑Fi في الداخل ٢٠–٦٥م؛ وهو حدّ «إضافة محلٍّ يدوياً» في المندوب الذكي نفسه.
 */
export const LIVE_WINDOW_MS = 90_000;
export const LIVE_MAX_ACCURACY_M = 100;
/** سماحٌ لساعة جهازٍ متقدّمة قليلاً في نقاطٍ قديمة (الجديدة تُقصّ إلى ساعة الخادم) */
export const LIVE_FUTURE_TOLERANCE_MS = 5_000;

/** قدرة الحزمة التي تفهم القفل (ترسل نقطةً قبل كل إجراء ولا تصفّ مستندات المقيَّد دون اتصال) — rep/repApi.ts */
export const LIVE_CAP = 'liveloc';
export const CAPS_HEADER = 'x-fs-caps';
export const REPLAY_HEADER = 'x-fs-replay';
/** ساعة الجهاز لحظة الإرسال (ms) — لتصحيح لحظة القراءة إلى ساعة الخادم */
export const DEVICE_NOW_HEADER = 'x-fs-device-now';

export const LIVE_REQUIRED_CODE = 'LOCATION_REQUIRED';
export const LIVE_REQUIRED_MESSAGE = 'فعّل الموقع المباشر وانتظر تحديد موقعك ثم أعد المحاولة';

export type LiveReason = 'NO_FIX' | 'STALE' | 'INACCURATE';
export type LiveVerdict = { ok: true } | { ok: false; reason: LiveReason };

export interface LivePoint {
  lat: number;
  lng: number;
  accuracy: number | null;
  capturedAt: Date;
  createdAt: Date;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** حكم النقطة الأحدث — صرف. لا نقطة ⇒ NO_FIX، قديمة الاستقبال أو الالتقاط ⇒ STALE، بلا دقّة أو أوسع من A ⇒ INACCURATE */
export function liveVerdict(p: LivePoint | null | undefined, now: number): LiveVerdict {
  if (!p || !finite(p.lat) || !finite(p.lng) || (p.lat === 0 && p.lng === 0)) return { ok: false, reason: 'NO_FIX' };
  const created = p.createdAt instanceof Date ? p.createdAt.getTime() : NaN;
  const captured = p.capturedAt instanceof Date ? p.capturedAt.getTime() : NaN;
  // المقارنة بالموجب (<=) كي يسقط NaN في الرفض لا في القبول
  const fresh = now - created <= LIVE_WINDOW_MS && now - captured <= LIVE_WINDOW_MS
    && captured - now <= LIVE_FUTURE_TOLERANCE_MS && created - now <= LIVE_FUTURE_TOLERANCE_MS;
  if (!fresh) return { ok: false, reason: 'STALE' };
  if (!finite(p.accuracy) || p.accuracy < 0 || p.accuracy > LIVE_MAX_ACCURACY_M) return { ok: false, reason: 'INACCURATE' };
  return { ok: true };
}

/** نافذة الاستعلام عن النقطة الأحدث — على فهرس (tenantId, salesRepId, capturedAt) */
export function liveWindow(now: number): { since: Date; until: Date } {
  return { since: new Date(now - LIVE_WINDOW_MS), until: new Date(now + LIVE_FUTURE_TOLERANCE_MS) };
}

const headerText = (v: unknown): string => (Array.isArray(v) ? v.join(',') : typeof v === 'string' ? v : '');

/** ترويسة القدرات قائمة رموز مفصولة بفواصل أو مسافات — كقارئ zatca2 */
export function hasCap(header: unknown, cap: string): boolean {
  return headerText(header).split(/[,\s;]+/).some((t) => t.trim().toLowerCase() === cap.toLowerCase());
}

export function isReplay(header: unknown): boolean {
  const v = headerText(header).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * ما لا يحرسه القفل: القراءة (GET/HEAD/OPTIONS)، والدخول وتجديد الجلسة ورمز الإشعارات (لولاها لخرج المندوب أو انقطعت
 * إشعاراته)، ونقطة الموقع نفسها ونبضة الحضور (بهما يظهر على الخريطة). المسار نسبةً إلى /api — مطابقةٌ تامّة بعد توحيد
 * حالة الأحرف والشرطة الأخيرة، فأيّ صيغةٍ أخرى تُحرس (الاتجاه الآمن).
 */
export const LIVE_EXEMPT_POST: readonly string[] = Object.freeze([
  '/auth/login', '/auth/renew', '/auth/refresh-fcm', '/tracking/ping', '/tracking/heartbeat',
]);

export function isLiveExempt(method: string, path: string): boolean {
  const m = String(method || '').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  if (m !== 'POST') return false;
  const p = String(path || '').toLowerCase().replace(/\/+$/, '');
  return LIVE_EXEMPT_POST.includes(p);
}

/**
 * لحظة القراءة بساعة الخادم: ساعة الجهاز تنحرف (متأخّرةً تجعل القراءة الطازجة «قديمة»، ومتقدّمةً تجعل القديمة «طازجة»).
 * الإزاحة = ساعة الخادم − ساعة الجهاز لحظة الإرسال (الترويسة)، ولا مستقبل أبداً. بلا ترويسةٍ سليمة ⇒ القصّ وحده.
 * لحظةٌ غائبة أو فاسدة ⇒ لحظة الاستقبال.
 */
export function correctCapturedAt(raw: string | undefined, deviceNowHeader: unknown, serverNow: number): Date {
  const t = raw ? new Date(raw).getTime() : NaN;
  if (!Number.isFinite(t)) return new Date(serverNow);
  const dn = Number(headerText(deviceNowHeader));
  const offset = Number.isFinite(dn) && dn > 0 ? serverNow - dn : 0;
  return new Date(Math.min(t + offset, serverNow));
}
