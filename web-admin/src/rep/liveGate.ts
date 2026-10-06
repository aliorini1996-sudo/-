/**
 * «اشتراط تفعيل الموقع» — القفل الكامل في التطبيق (أمر المالك، ٦ أكتوبر ٢٠٢٦): المندوب المقيَّد لا يفعل شيئاً أبداً إلا وموقعه
 * مفعّل ومحدَّد بدقّة وهو متصل وظاهرٌ على الخريطة في مكانٍ بعينه.
 *
 * كان الحاجز يحجب على رفض الإذن وحده (وعلى «تعذّر» ثلاثاً متتالية)، ولا يحجب على انتهاء المهلة أبداً، ويقبل قراءةً مخبّأة
 * عمرها دقيقتان — فبقي المندوب يسجّل زيارةً والموقع مطفأ. الآن الشروط كلها معاً، وأيّها سقط حُجب التطبيق كله:
 *  1. الإذن ممنوح والموقع مفعّل                          ⇐ وإلا «الموقع مطفأ»
 *  2. متصل: navigator.onLine وآخر ذهابٍ وإياب مع الخادم نجح ⇐ وإلا «لا يوجد اتصال بالإنترنت»
 *  3. قراءةٌ حيّة من watchPosition عمرها ≤ W ودقّتها ≤ A  ⇐ وإلا «جارٍ تحديد موقعك بدقة…» (والمهلة تحجب الآن)
 *  4. آخر نقطةٍ أرسلها الحاجز قبلها الخادم «حيّةً» خلال W   ⇐ وإلا «لم يظهر موقعك على الخريطة بعد»
 *
 * W وA هما قيمتا الخادم حرفياً (backend/src/services/liveLocation.ts)، والخادم يحرس كل إجراء بهما ولو كذب التطبيق.
 * وقبل أي طلبٍ يغيّر بياناً يُرسل التطبيق نقطةً طازجة (preflightLive) فيمرّ حكم الخادم يقيناً حين يكون المندوب حيّاً فعلاً،
 * وإن لم يكن لا يُرسل الطلب أصلاً.
 *
 * هنا المنطق الصرف والمخزن (بلا React ولا axios): الحكم، والمخزن المشترك بين الحاجز (locationGate.ts) وعميل الشبكة
 * (repApi.ts)، وخطوات الفحص المسبق بتبعياتٍ تُحقن فتُختبر.
 */

/** نافذة «حيّ الآن» — = الخادم */
export const LIVE_WINDOW_MS = 90_000;
/** أقصى نصف قطر دقّة بالأمتار — = الخادم */
export const LIVE_MAX_ACCURACY_M = 100;
/** نقطة الحاجز الدورية وتجديد القراءة إن سكنت watchPosition (جهازٌ ثابت لا يُطلقها) */
export const LIVE_KEEPALIVE_MS = 30_000;
/** إعادة حساب الحكم (القراءة تشيخ دون حدث) */
export const LIVE_TICK_MS = 5_000;
/** الفحص المسبق لا يقبل قراءةً أقدم من هذا — يطلب قراءةً طازجة (فمن أطفأ الموقع للتوّ لا يعمل بقراءةٍ قبله) */
export const PREFLIGHT_FIX_MAX_AGE_MS = 10_000;
/** نقطةٌ قبلها الخادم قبل أقلّ من هذا تكفي الطلب التالي (قراءةٌ ≤ ١٠ث + ١٥ث + الشبكة ≪ ٩٠ث) — لا نقطة لكل نقرة */
export const PING_REUSE_MS = 15_000;
/** مهلة القراءة الطازجة */
export const LIVE_FIX_TIMEOUT_MS = 20_000;

export type LiveBlock = 'off' | 'offline' | 'locating' | 'notOnMap';
/** سبب ردّ الطلب قبل إرساله (يُحمل في الخطأ المصطنع كما يحمل الخادم reason) */
export type LiveRefusalReason = 'OFF' | 'OFFLINE' | 'LOCATING' | 'NOT_ON_MAP';

export interface LiveFix {
  lat: number;
  lng: number;
  /** نصف قطر الدقّة بالأمتار — غائبٌ = غير دقيق */
  accuracy: number | null;
  /** لحظة القراءة بساعة الجهاز (ms) */
  at: number;
}

export interface LivePing {
  /** لحظة وصول ردّ الخادم بساعة الجهاز (ms) */
  at: number;
  ok: boolean;
  reason?: string;
  /** لحظة القراءة التي أُرسلت */
  fixAt?: number;
}

export interface LiveSnapshot {
  geoSupported: boolean;
  permission: 'granted' | 'denied' | 'prompt' | 'unknown';
  /** آخر نتيجة موقع خطأ؟ 0 = آخر نتيجة قراءةٌ ناجحة (أو لا شيء بعد)؛ 1 رفض/مطفأ، 2 تعذّر، 3 مهلة */
  geoError: 0 | 1 | 2 | 3;
  fix: LiveFix | null;
  online: boolean;
  /** آخر ذهابٍ وإياب مع الخادم: ردٌّ بأي حالة = نجح، ولا ردّ = فشل */
  serverOk: boolean;
  ping: LivePing | null;
}

export type LiveDecision = { ok: true } | { ok: false; block: LiveBlock };

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** قراءةٌ تصلح: إحداثيات سليمة لا (0،0)، ودقّة معلومة ≤ A، وعمرها ≤ maxAge (ولا مستقبل بعيد) */
export function fixUsable(fix: LiveFix | null | undefined, now: number, maxAge: number = LIVE_WINDOW_MS): fix is LiveFix {
  if (!fix || !finite(fix.lat) || !finite(fix.lng) || (fix.lat === 0 && fix.lng === 0)) return false;
  if (!finite(fix.accuracy) || fix.accuracy < 0 || fix.accuracy > LIVE_MAX_ACCURACY_M) return false;
  const age = now - fix.at;
  return finite(age) && age <= maxAge && age >= -5_000;
}

/** الحكم — صرف. الترتيب: ما يصلحه المندوب أولاً (الموقع، ثم الاتصال)، ثم انتظار القراءة، ثم ظهوره على الخريطة */
export function liveDecision(s: LiveSnapshot, now: number): LiveDecision {
  if (!s.geoSupported || s.permission === 'denied' || s.geoError === 1) return { ok: false, block: 'off' };
  if (!s.online || !s.serverOk) return { ok: false, block: 'offline' };
  if (s.geoError !== 0 || !fixUsable(s.fix, now)) return { ok: false, block: 'locating' };
  if (!s.ping || !s.ping.ok || !(now - s.ping.at <= LIVE_WINDOW_MS)) return { ok: false, block: 'notOnMap' };
  return { ok: true };
}

export const BLOCK_OF_REASON: Record<LiveRefusalReason, LiveBlock> = {
  OFF: 'off', OFFLINE: 'offline', LOCATING: 'locating', NOT_ON_MAP: 'notOnMap',
};

// ───────── المخزن المشترك ─────────

const initial = (): LiveSnapshot => ({
  geoSupported: typeof navigator !== 'undefined' && !!navigator.geolocation,
  permission: 'unknown',
  geoError: 0,
  fix: null,
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  serverOk: true,
  ping: null,
});
let snap: LiveSnapshot = initial();
const listeners = new Set<() => void>();

export function liveSnapshot(): LiveSnapshot { return snap; }
export function updateLive(patch: Partial<LiveSnapshot>): void {
  snap = { ...snap, ...patch };
  listeners.forEach((fn) => { try { fn(); } catch { /* */ } });
}
export function subscribeLive(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
/** للاختبار وتسجيل الخروج: يعود المخزن كأن لا شيء */
export function resetLive(patch: Partial<LiveSnapshot> = {}): void { snap = { ...initial(), ...patch }; }

/** قراءة المتصفّح إلى LiveFix — والقراءة الناجحة تمحو آخر خطأ */
export function noteFix(fix: LiveFix): void { updateLive({ fix, geoError: 0 }); }
export function noteGeoError(code: number): void {
  updateLive({ geoError: code === 1 ? 1 : code === 2 ? 2 : 3 });
}
export function noteServer(ok: boolean): void { if (snap.serverOk !== ok) updateLive({ serverOk: ok }); }
export function notePing(p: LivePing): void { updateLive({ ping: p }); }

/** ردّ الخادم 409 LOCATION_REQUIRED بسببه — يسمعه التطبيق فيجدّد قيود المندوب (قيدٌ فُعّل للتوّ) */
const refusedListeners = new Set<() => void>();
export function onLiveRefused(fn: () => void): () => void {
  refusedListeners.add(fn);
  return () => { refusedListeners.delete(fn); };
}
export function emitLiveRefused(): void { refusedListeners.forEach((fn) => { try { fn(); } catch { /* */ } }); }

// ───────── من يُحرس ─────────

/** المندوب الحالي مقيَّد؟ — من rep_user المخزَّن (يجدّده refreshUser)، ويُقرأ بـ=== true */
export function strictRepNow(): boolean {
  try { return JSON.parse(localStorage.getItem('rep_user') || 'null')?.requireLocationOn === true; } catch { return false; }
}

/** ما لا يحرسه القفل — = الخادم (LIVE_EXEMPT_POST): القراءة، والدخول والتجديد ورمز الإشعارات، ونقطة الموقع ونبضة الحضور */
export const LIVE_EXEMPT_POST: readonly string[] = Object.freeze([
  '/auth/login', '/auth/renew', '/auth/refresh-fcm', '/tracking/ping', '/tracking/heartbeat',
]);
export function isLiveExemptRequest(method: string | undefined, url: string | undefined): boolean {
  const m = String(method || 'get').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  if (m !== 'POST') return false;
  const p = String(url || '').split(/[?#]/)[0].replace(/^https?:\/\/[^/]+/i, '').replace(/^\/api(?=\/)/, '').toLowerCase().replace(/\/+$/, '');
  return LIVE_EXEMPT_POST.includes(p);
}

// ───────── الخطأ المصطنع: طلبٌ لا يُرسل ─────────

export const LIVE_REFUSAL_CODE = 'LOCATION_REQUIRED';
const SERVER_REASONS = ['NO_FIX', 'STALE', 'INACCURATE'];
const LOCAL_REASONS: LiveRefusalReason[] = ['OFF', 'OFFLINE', 'LOCATING', 'NOT_ON_MAP'];

export const LIVE_REFUSAL_MESSAGE: Record<LiveRefusalReason, string> = {
  OFF: 'الموقع مطفأ — فعّله في جوالك ثم أعد المحاولة',
  OFFLINE: 'لا يوجد اتصال بالإنترنت — اتصل ثم أعد المحاولة',
  LOCATING: 'جارٍ تحديد موقعك بدقة… انتظر قليلاً ثم أعد المحاولة',
  NOT_ON_MAP: 'لم يظهر موقعك على الخريطة بعد — انتظر قليلاً ثم أعد المحاولة',
};

export interface LiveRefusalError extends Error {
  /** يحمل response عمداً: بلا response يعدّه isNetworkError انقطاعاً فتصفّه الشاشات دون اتصال — والمقيَّد لا يُصفّ له شيء */
  response: { status: 409; data: { success: false; code: string; reason: LiveRefusalReason; message: string; local: true } };
  config?: unknown;
  isLiveRefusal: true;
}

export function liveRefusalError(reason: LiveRefusalReason, config?: unknown): LiveRefusalError {
  const message = LIVE_REFUSAL_MESSAGE[reason];
  const e = new Error(message) as LiveRefusalError;
  e.response = { status: 409, data: { success: false, code: LIVE_REFUSAL_CODE, reason, message, local: true } };
  e.config = config;
  e.isLiveRefusal = true;
  return e;
}

/** ردّ القفل (من الخادم أو قبل الإرسال)؟ — يُميَّز عن LOCATION_REQUIRED الزيارة بلا إحداثيات (ذاك بلا reason ونهائيّ) */
export function isLiveRefusal(err: unknown): boolean {
  const r = (err as { response?: { status?: number; data?: { code?: string; reason?: string } } })?.response;
  return r?.status === 409 && r.data?.code === LIVE_REFUSAL_CODE
    && (SERVER_REASONS.includes(r.data?.reason ?? '') || (LOCAL_REASONS as string[]).includes(r.data?.reason ?? ''));
}
/** رُدّ قبل أن يُرسل (لا ردّ خادم حقيقي) */
export function isLocalLiveRefusal(err: unknown): boolean {
  return isLiveRefusal(err) && (err as { response?: { data?: { local?: boolean } } }).response?.data?.local === true;
}

// ───────── الفحص المسبق ─────────

export type FreshFixResult = { fix: LiveFix } | { error: 1 | 2 | 3 };
export type PingResult = { ok: boolean; reason?: string } | 'network';

export interface PreflightDeps {
  now: () => number;
  online: () => boolean;
  /** قراءةٌ طازجة الآن (getCurrentPosition بـmaximumAge: 0) */
  freshFix: () => Promise<FreshFixResult>;
  /** POST /tracking/ping بالقراءة وحكم الخادم في الردّ */
  sendPing: (fix: LiveFix) => Promise<PingResult>;
}

export type PreflightResult = { ok: true; fix: LiveFix } | { ok: false; reason: LiveRefusalReason };

/**
 * قبل أي طلبٍ يغيّر بياناً من المقيَّد: متصل، وقراءةٌ عمرها ≤ ١٠ث بدقّة ≤ A (وإلا قراءةٌ طازجة الآن)، ونقطةٌ بها يقبلها الخادم
 * حيّةً (أو نقطةٌ قبلها قبل أقلّ من ١٥ث). يحدّث المخزن في كل خطوة فيظهر الحاجز بسببه إن سقط شرط.
 */
export async function preflightLive(deps: PreflightDeps): Promise<PreflightResult> {
  if (!deps.online()) { updateLive({ online: false }); return { ok: false, reason: 'OFFLINE' }; }
  const s = liveSnapshot();
  if (!s.geoSupported || s.permission === 'denied') return { ok: false, reason: 'OFF' };
  let fix = s.fix;
  if (!fixUsable(fix, deps.now(), PREFLIGHT_FIX_MAX_AGE_MS)) {
    const r = await deps.freshFix();
    if ('error' in r) {
      noteGeoError(r.error);
      return { ok: false, reason: r.error === 1 ? 'OFF' : 'LOCATING' };
    }
    noteFix(r.fix);
    fix = r.fix;
    if (!fixUsable(fix, deps.now(), PREFLIGHT_FIX_MAX_AGE_MS)) return { ok: false, reason: 'LOCATING' };
  }
  const last = liveSnapshot().ping;
  const now = deps.now();
  // نقطةٌ قبلها الخادم للتوّ بقراءةٍ حديثة تكفي (قراءتها ≤ ٦٠ث + الشبكة ≪ ٩٠ث نافذة الخادم)
  if (last?.ok && now - last.at <= PING_REUSE_MS && now - last.at >= 0
    && last.fixAt != null && now - last.fixAt <= LIVE_WINDOW_MS - 30_000) return { ok: true, fix };
  const r = await deps.sendPing(fix);
  if (r === 'network') { noteServer(false); return { ok: false, reason: 'OFFLINE' }; }
  noteServer(true);
  notePing({ at: deps.now(), ok: r.ok, reason: r.reason, fixAt: fix.at });
  return r.ok ? { ok: true, fix } : { ok: false, reason: 'NOT_ON_MAP' };
}

/**
 * حكم الخادم من ردّ النقطة: `live.ok` — وخادمٌ أقدم بلا حكم يُقبل ما خزّن نقطته (نافذة نشرٍ تسبق فيها الواجهةُ الخادم)
 */
export function pingVerdictOf(data: unknown): { ok: boolean; reason?: string } {
  const d = (data as { data?: { stored?: number; live?: { ok?: boolean; reason?: string } } } | null)?.data;
  if (d?.live && typeof d.live.ok === 'boolean') return { ok: d.live.ok, reason: d.live.reason };
  return { ok: (d?.stored ?? 0) > 0, reason: (d?.stored ?? 0) > 0 ? undefined : 'NOT_STORED' };
}

/** نقطة الحاجز كما يقرؤها POST /tracking/ping */
export function pingBody(fix: LiveFix): { points: { lat: number; lng: number; accuracy?: number; capturedAt: string }[] } {
  return {
    points: [{
      lat: fix.lat, lng: fix.lng,
      ...(finite(fix.accuracy) ? { accuracy: fix.accuracy } : {}),
      capturedAt: new Date(fix.at).toISOString(),
    }],
  };
}

/**
 * مفتاح المحاولة (clientRef) لنموذج مستند: المقيَّد لا يُصفّ له شيء، فإن ضاع ردّ الخادم بعد أن بلغه الطلب أعاد المندوب الضغط —
 * المحتوى نفسه ⇒ المفتاح نفسه فيعيد الخادم المستند المسجَّل (idempotency) لا مستنداً ثانياً؛ وتغيّرُ المحتوى ⇒ مفتاحٌ جديد (لا
 * يُعاد مستندٌ قديم بمحتوى غير ما على الشاشة).
 */
export function attemptClientRef(prev: { key: string; ref: string } | null, body: unknown, fresh: () => string): { key: string; ref: string } {
  const key = JSON.stringify(body);
  return prev && prev.key === key ? prev : { key, ref: fresh() };
}

/** من قراءة المتصفّح */
export function liveFixOf(p: { coords: { latitude: number; longitude: number; accuracy?: number | null }; timestamp?: number }, now = Date.now()): LiveFix {
  return {
    lat: p.coords.latitude, lng: p.coords.longitude,
    accuracy: finite(p.coords.accuracy) ? p.coords.accuracy : null,
    at: finite(p.timestamp) ? p.timestamp : now,
  };
}
