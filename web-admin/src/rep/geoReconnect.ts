/**
 * إنعاش اتصال الموقع داخل تطبيق أندرويد (TWA، النسخ 1.2.x): التطبيق يعلن إذن الموقع (وحدة التحصيل)، فChrome يسلّم كل موقع الصفحة
 * إلى التطبيق، ويرسل له «ابدأ» (startLocation) مع كل اتصال Geolocation جديد في الصفحة وحده — لا مع كل طلب على اتصالٍ قائم.
 * إن قتل النظام عملية التطبيق والصفحة مفتوحة (مدير البطارية في بعض الواجهات)، أو توقّف مزوّده لأي سبب، بقي الاتصال القائم صامتاً
 * إلى الأبد: المراقبات بلا قراءة ولا خطأ، ولا يعود الموقع حتى يخرج المندوب من التطبيق ويرجع (مثبتٌ على المحاكي ٣ نوفمبر ٢٠٢٦).
 *
 * العلاج: كل طلبات الموقع في الصفحة تمرّ من مالكٍ واحد. إن سكتت كلها SILENT_MS والصفحة ظاهرة، تُمسح كل المراقبات فيغلق Blink
 * الاتصال (لا مستمع فيه)، ثم تُعاد في تكةٍ لاحقة — اتصالٌ جديد، فـ«ابدأ» جديد يعيد تشغيل GPS في التطبيق. يُنتظر لذلك لحظةٌ لا
 * طلب مفرداً فيها (الطلب المفرد المعلّق يمسك الاتصال)، فلا يتأخر طلبٌ لأحد إلا جزءاً من الثانية. ومن يستدعي لا يرى شيئاً:
 * معرّفات مراقباته وردوده ومهلاته كما هي.
 */

export const SILENT_MS = 30_000;
/** لا إنعاشين متتاليين أقرب من هذا (داخل مبنى بلا إشارة: إنعاشٌ كل دقيقة لا كل ثانية) */
export const COOLDOWN_MS = 60_000;
/** طلباتٌ مفردة متداخلة بلا فجوة هذه المدة: يُعلَّق المالك وتُنتظر (مهلاتها ≤ ٢٠ث في الويب) */
export const BLOCKED_MAX_MS = 90_000;
/** طلبٌ مفرد بلا مهلة لا يُنتظر أكثر من هذا */
export const DRAIN_MAX_MS = 25_000;
export const TICK_MS = 5_000;
/** Blink يقرّر إغلاق الاتصال بعد ردّ آخر مستمع لا قبله: الإعادة في تكةٍ لاحقة */
export const RESUME_DELAY_MS = 50;
const IN_APP_KEY = 'fs_in_app';

type Geo = Pick<Geolocation, 'watchPosition' | 'clearWatch' | 'getCurrentPosition'>;

export interface ReconnectEnv {
  now(): number;
  visible(): boolean;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

interface Watch {
  success: PositionCallback;
  error?: PositionErrorCallback | null;
  options?: PositionOptions;
  nativeId: number | null;
  /** رفضٌ للإذن: Blink نفسه أسقط المراقبة، فلا تُعاد ولا تُحسب في السكوت */
  dead: boolean;
}

interface Queued {
  success: PositionCallback;
  error?: PositionErrorCallback | null;
  options?: PositionOptions;
  at: number;
  timer: unknown;
}

export interface GeoReconnect extends Geo {
  /** عدد مرات الإنعاش منذ الإنشاء (للاختبار والتشخيص) */
  reconnects(): number;
  /** فحصٌ واحد الآن (المؤقّت يستدعيه كل TICK_MS) */
  tick(): void;
  dispose(): void;
}

/** خطأ «انتهت المهلة» بشكل خطأ المتصفح نفسه (من يستدعي يقارن err.code بـerr.TIMEOUT) */
function timeoutError(): GeolocationPositionError {
  return { code: 3, message: 'Timeout expired', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError;
}

export function createGeoReconnect(native: Geo, env: ReconnectEnv): GeoReconnect {
  const watches = new Map<number, Watch>();
  let queued: Queued[] = [];
  let seq = 0;
  let pending = 0; // طلبات مفردة أُرسلت لـBlink ولم تُجب بعد
  let suspended = false;
  let suspendedAt = 0;
  let resumeScheduled = false;
  let lastActivity = env.now();
  let lastReconnect = Number.NEGATIVE_INFINITY;
  let blockedSince = 0;
  let lastPos: GeolocationPosition | null = null;
  let wasHidden = false;
  let count = 0;

  const seen = (pos: GeolocationPosition) => { lastActivity = env.now(); lastPos = pos; };
  const liveWatches = () => { let n = 0; for (const w of watches.values()) if (!w.dead) n += 1; return n; };

  const issueWatch = (w: Watch) => {
    w.nativeId = native.watchPosition(
      (pos) => { seen(pos); w.success(pos); },
      (err) => {
        if (err.code === 1) { w.dead = true; w.nativeId = null; }
        w.error?.(err);
      },
      w.options,
    );
  };

  const issueOneShot = (success: PositionCallback, error: PositionErrorCallback | null | undefined, options?: PositionOptions) => {
    pending += 1;
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      pending -= 1;
      if (suspended) maybeResume();
    };
    native.getCurrentPosition(
      (pos) => { settle(); seen(pos); success(pos); },
      (err) => { settle(); error?.(err); },
      options,
    );
  };

  const resume = () => {
    resumeScheduled = false;
    if (!suspended) return;
    suspended = false;
    lastActivity = env.now(); // الاتصال الجديد يأخذ مهلته كاملة
    count += 1;
    for (const w of watches.values()) if (!w.dead) issueWatch(w);
    const toIssue = queued;
    queued = [];
    for (const q of toIssue) {
      env.clearTimeout(q.timer);
      // مهلة من يستدعي تجري منذ طلبه لا منذ الإرسال
      const t = q.options?.timeout;
      const options = t !== undefined && Number.isFinite(t) ? { ...q.options, timeout: Math.max(0, t - (env.now() - q.at)) } : q.options;
      issueOneShot(q.success, q.error, options);
    }
  };

  const maybeResume = () => {
    if (!suspended || resumeScheduled || pending > 0) return;
    resumeScheduled = true;
    env.setTimeout(resume, RESUME_DELAY_MS);
  };

  const suspend = () => {
    suspended = true;
    suspendedAt = env.now();
    lastReconnect = suspendedAt;
    blockedSince = 0;
    for (const w of watches.values()) {
      if (w.nativeId !== null) native.clearWatch(w.nativeId);
      w.nativeId = null;
    }
    maybeResume();
  };

  const tick = () => {
    const now = env.now();
    if (suspended) {
      // طلبٌ مفرد بلا مهلة يمسك الاتصال: لا يُنتظر إلى الأبد (الإنعاش التالي بعد المهلة الفاصلة)
      if (!resumeScheduled && now - suspendedAt >= DRAIN_MAX_MS) { resumeScheduled = true; env.setTimeout(resume, 0); }
      return;
    }
    if (!env.visible()) { wasHidden = true; blockedSince = 0; return; }
    // العودة من الخلفية: Blink نفسه أعاد فتح الاتصال، فالمهلة تبدأ الآن
    if (wasHidden) { wasHidden = false; lastActivity = now; return; }
    if (liveWatches() === 0 || now - lastActivity < SILENT_MS || now - lastReconnect < COOLDOWN_MS) { blockedSince = 0; return; }
    // لحظةٌ بلا طلب مفرد: الإنعاش فوري ولا ينتظر أحد. وإلا تُنتظر فجوة، وبعد BLOCKED_MAX_MS يُعلَّق وتُنتظر الطلبات
    if (pending === 0) { suspend(); return; }
    if (blockedSince === 0) blockedSince = now;
    else if (now - blockedSince >= BLOCKED_MAX_MS) suspend();
  };

  const timer = env.setInterval(tick, TICK_MS);

  return {
    watchPosition(success, error, options) {
      seq += 1;
      if (liveWatches() === 0) lastActivity = env.now(); // أول مراقبة: المهلة تبدأ الآن لا منذ إنشاء المالك
      const w: Watch = { success, error, options, nativeId: null, dead: false };
      watches.set(seq, w);
      if (!suspended) issueWatch(w);
      return seq;
    },
    clearWatch(id) {
      const w = watches.get(id);
      if (!w) return;
      watches.delete(id);
      if (w.nativeId !== null) native.clearWatch(w.nativeId);
    },
    getCurrentPosition(success, error, options) {
      if (!suspended) { issueOneShot(success, error, options); return; }
      // أثناء الإنعاش (جزء من الثانية عادةً): قراءةٌ ضمن maximumAge تُعاد كما يعيدها Blink من مخبئه
      const maxAge = options?.maximumAge ?? 0;
      const cached = lastPos;
      if (cached && maxAge > 0 && env.now() - cached.timestamp <= maxAge) { env.setTimeout(() => success(cached), 0); return; }
      const q: Queued = { success, error, options, at: env.now(), timer: null };
      const t = options?.timeout;
      if (t !== undefined && Number.isFinite(t)) {
        q.timer = env.setTimeout(() => {
          const i = queued.indexOf(q);
          if (i < 0) return;
          queued.splice(i, 1);
          error?.(timeoutError());
        }, Math.max(0, t));
      }
      queued.push(q);
    },
    reconnects: () => count,
    tick,
    dispose() { env.clearInterval(timer); },
  };
}

/**
 * يُستدعى في main.tsx قبل captureBridgeLaunch (التي تحذف fsbridge من العنوان): يعلّم هذا التبويب أنه فُتح من تطبيق أندرويد.
 * sessionStorage لا localStorage: Chrome يشارك localStorage بين التطبيق وتبويباته العادية، وعلامة الجسر الدائمة تبقى بعد حذف
 * التطبيق — والتفويض (ومعه الحاجة إلى الإنعاش) داخل التطبيق وحده
 */
export function markAppLaunch(): void {
  try {
    if (typeof window === 'undefined') return;
    const fromApp = /(?:^|[?&])fsbridge=/.test(window.location.search) || (document.referrer ?? '').startsWith('android-app://');
    if (fromApp) window.sessionStorage.setItem(IN_APP_KEY, '1');
  } catch { /* تخزينٌ محجوب: بلا مالك، والموقع كما كان */ }
}

const INSTALLED = '__fsGeoReconnect';

/** يركّب المالك على navigator.geolocation في تبويب التطبيق وحده (markAppLaunch). مرةً واحدة لكل صفحة */
export function installGeoReconnect(): boolean {
  try {
    if (typeof navigator === 'undefined' || !navigator.geolocation || typeof window === 'undefined') return false;
    if (window.sessionStorage.getItem(IN_APP_KEY) !== '1') return false;
    const geo = navigator.geolocation as Geolocation & Record<string, unknown>;
    if (geo[INSTALLED]) return true;
    const native: Geo = {
      watchPosition: geo.watchPosition.bind(geo),
      clearWatch: geo.clearWatch.bind(geo),
      getCurrentPosition: geo.getCurrentPosition.bind(geo),
    };
    const hub = createGeoReconnect(native, {
      now: () => Date.now(),
      visible: () => document.visibilityState === 'visible',
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (h) => window.clearTimeout(h as number),
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (h) => window.clearInterval(h as number),
    });
    geo.watchPosition = hub.watchPosition;
    geo.clearWatch = hub.clearWatch;
    geo.getCurrentPosition = hub.getCurrentPosition;
    geo[INSTALLED] = hub;
    return true;
  } catch {
    return false; // أي تعذّر: الموقع كما كان بلا مالك
  }
}
