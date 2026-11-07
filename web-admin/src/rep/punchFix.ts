// موقع البصمة للمندوب المقيَّد بـ«بصمة الحضور بموقع عميل» — قراءةٌ طازجة بأفضل دقّة (بلاغ المالك ٢١ أكتوبر ٢٠٢٦).
//
// كانت البصمة تقرأ بـ`maximumAge: 30000`: قراءةٌ مخبّأة عمرها حتى نصف دقيقة. المندوب الواصل بسيارته يضغط البصمة
// فوراً فتُرسل نقطةٌ من الشارع قبل مئات الأمتار، أو أوّل قراءةٍ خشنة من الشبكة — فلا يقبله القيد إلا بمسافةٍ واسعة
// («لا يعمل إلا بـ٣٠٠ متر»). هنا: مراقبةٌ بلا مخبّأ، وأدقّ ما وصل ومعه هامش خطئه (`accuracy`) ليحكم به الخادم
// (punchAwayFromCustomer في routes/tracking.ts) — ومعه سبب الغياب إن لم تصل قراءة، لتقول الشاشة ما حدث فعلاً.
//
// تدقيق «لا يعمل إلا بـ٣٠٠» (٧ نوفمبر ٢٠٢٦ — قرار المالك «أصلح الخلل فقط»: لا تغيير فيما يقبله الخادم أو يرفضه لقراءةٍ بعينها):
//  • R3: قراءةٌ أقدم من بدء المراقبة بأكثر من ٥ ث (آخر موقعٍ معروف من السيارة يسلّمه المتصفّح أولاً) لا تُنهي المراقبة
//    مهما كانت دقّتها، وتُحفظ احتياطاً فقط — الطازجة مقدَّمة عليها دائماً. وقراءةٌ أحدث من سابقتها في المراقبة نفسها طازجةٌ
//    أيّاً كان فرق ساعة الجوال عن ساعة GPS (جوالٌ ساعته متقدّمة لا ينتظر نافذة التحسين كلّها).
//  • R1: داخل المحلّ قد لا تبلغ الدقّة العشرين: بعد مهلة التحسين نواصل حتى ~٢٠ ث من أوّل قراءة ما دامت أدقّ الطازجة أضعف
//    من ٢٥ م (سماحية الخادم)، ونتوقّف فور بلوغها — والسقف العام يحدّ ذلك كلّه.
//  • R5: دقّةٌ بالكيلومتر (إذن «الموقع التقريبي») تُصنَّف «خشنة» لتقول الشاشة «فعّل الموقع الدقيق» لا «انتظر».
//  • دبوس العميل (R2/PIN-6): precisePinFix — المراقبة نفسها لالتقاط موقع العميل عند بابه، وpinAccuracyLevel للعرض والتنبيه.
//  • R1: startPunchWarmup — مراقبةٌ دقيقة تُفتح لحظة ظهور شاشة البصمة أو نافذة التواجد ليكون الـGPS دافئاً عند الضغط.

import { toGeoFix, isGeoFix, type GeoFix } from './visitLocation';

/** دقّةٌ تكفي فتتوقّف المراقبة فوراً — في الخارج تصل خلال ثوانٍ */
export const PUNCH_FIX_GOOD_M = 20;
/** أقصى انتظار لأوّل قراءة **بعد منح الإذن** (مهلة المراقبة نفسها — لا تحسب وقت نافذة الإذن) */
export const PUNCH_FIX_WAIT_MS = 12_000;
/** بعد أوّل قراءة: مهلة تحسينها ما لم تبلغ الدقّة الكافية — داخل المحلّ قد لا تبلغ العشرين أبداً */
export const PUNCH_FIX_REFINE_MS = 8_000;
/** سقفٌ لنافذة إذنٍ لم يُجب عنها — فلا يبقى الزرّ «جارٍ تحديد موقعك» بلا نهاية */
export const PUNCH_FIX_PROMPT_CAP_MS = 60_000;
/** R1: بعد مهلة التحسين تكفي هذه الدقّة للتوقّف — هي سماحية الخادم (PUNCH_ACCURACY_ALLOWANCE_M) ولا تغيّرها */
export const PUNCH_FIX_SETTLE_M = 25;
/** R1: أقصى مدّة تحسين من أوّل قراءة ما دامت أدقّ الطازجة أضعف من PUNCH_FIX_SETTLE_M */
export const PUNCH_FIX_EXTEND_MS = 20_000;
/** R3: قراءةٌ أقدم من بدء المراقبة بأكثر من هذا قراءةٌ مخبّأة — احتياطٌ لا يُنهي المراقبة */
export const PUNCH_FIX_STALE_MS = 5_000;
/** R5: من هذه الدقّة فصاعداً القراءة «خشنة» — إذن «الموقع التقريبي» لا قراءة GPS ولا شبكة */
export const PUNCH_FIX_COARSE_M = 1_000;
/** دبوس العميل: فوق هذه الدقّة (أو بلا دقّة معلومة) يُنبَّه قبل الحفظ */
export const PIN_WARN_M = 30;
/** سقف التسخين إن نسيه صاحبه مفتوحاً — لا يبقى الـGPS يعمل بلا نهاية */
export const PUNCH_WARMUP_MAX_MS = 120_000;

/** ok = وصلت قراءة · denied = رُفض الإذن · unavailable = الموقع متعذّر في الجهاز · timeout = لا قراءة في المهلة · no-geo = لا تحديد موقع */
export type PunchFixReason = 'ok' | 'denied' | 'unavailable' | 'timeout' | 'no-geo';
export interface PunchFixResult { fix: GeoFix | null; reason: PunchFixReason }

/** دبوس العميل الملتقط — accuracy = نصف قطر الدقّة بالأمتار، وnull إن لم تُعرف */
export type PinFix = { lat: number; lng: number; accuracy: number | null };
export interface PinFixResult { fix: PinFix | null; reason: PunchFixReason }

/** أدقّ قراءة: أصغر هامش خطأ — وقراءةٌ بلا دقّة معلومة لا تُفضَّل على قراءةٍ دقّتها معلومة */
export function bestFix(fixes: readonly GeoFix[]): GeoFix | null {
  let best: GeoFix | null = null;
  for (const f of fixes) {
    if (!best || (f.accuracy ?? Infinity) < (best.accuracy ?? Infinity)) best = f;
  }
  return best;
}

/** قراءةٌ دقيقة بما يكفي لإنهاء المراقبة */
export const fixGoodEnough = (f: GeoFix | null): boolean =>
  !!f && typeof f.accuracy === 'number' && f.accuracy <= PUNCH_FIX_GOOD_M;

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * مستوى دقّة القراءة للعرض والتنبيه — good ≤ ٢٠ م · fair ≤ ٣٠ م · poor أضعف من ٣٠ م · coarse من ١٠٠٠ م فصاعداً
 * (إذن «الموقع التقريبي»: الشاشة تقول «فعّل الموقع الدقيق»). دقّةٌ غير معلومة أو فاسدة = poor: لا تُعرض دقيقةً.
 */
export function pinAccuracyLevel(accuracy: number | null): 'good' | 'fair' | 'poor' | 'coarse' {
  if (!finite(accuracy) || accuracy < 0) return 'poor';
  if (accuracy >= PUNCH_FIX_COARSE_M) return 'coarse';
  if (accuracy <= PUNCH_FIX_GOOD_M) return 'good';
  if (accuracy <= PIN_WARN_M) return 'fair';
  return 'poor';
}

/** R5: قراءةٌ خشنة (بالكيلومتر) — للشاشة: «فعّل الموقع الدقيق» بدل «انتظر» */
export const fixIsCoarse = (f: { accuracy?: number | null } | null | undefined): boolean =>
  !!f && pinAccuracyLevel(f.accuracy ?? null) === 'coarse';

type Geo = Pick<Geolocation, 'watchPosition' | 'clearWatch'>;
const defaultGeo = (): Geo | undefined => (typeof navigator !== 'undefined' ? navigator.geolocation : undefined);

export interface PunchWatchOpts {
  waitMs?: number; refineMs?: number; capMs?: number;
  /** دقّةٌ تُنهي المراقبة فوراً (افتراضاً PUNCH_FIX_GOOD_M) */
  goodM?: number;
  /** أقصى مدّة تحسين من أوّل قراءة ما دامت الدقّة أضعف من PUNCH_FIX_SETTLE_M (افتراضاً PUNCH_FIX_EXTEND_MS) */
  extendMs?: number;
  /** الساعة — للاختبار */
  now?: () => number;
}

/** المراقبة المشتركة بين البصمة ودبوس العميل */
function watchBestFix(geo: Geo | undefined, t: PunchWatchOpts): Promise<PunchFixResult> {
  const waitMs = t.waitMs ?? PUNCH_FIX_WAIT_MS;
  const refineMs = t.refineMs ?? PUNCH_FIX_REFINE_MS;
  const capMs = t.capMs ?? PUNCH_FIX_PROMPT_CAP_MS;
  const goodM = t.goodM ?? PUNCH_FIX_GOOD_M;
  const extendMs = Math.max(refineMs, t.extendMs ?? PUNCH_FIX_EXTEND_MS);
  const now = t.now ?? Date.now;
  return new Promise((resolve) => {
    if (!geo) { resolve({ fix: null, reason: 'no-geo' }); return; }
    const staleBefore = now() - PUNCH_FIX_STALE_MS;
    // أحدث لحظة قراءةٍ وصلت في هذه المراقبة: لحظة القراءة من ساعة مصدرها (GPS) لا من ساعة الجوال، فجوالٌ ساعته متقدّمة
    // كان سيرى كل قراءةٍ طازجة «قديمة» فلا يتوقّف مبكراً أبداً. قراءةٌ أحدث من سابقتها في المراقبة نفسها وُلدت أثناءها —
    // طازجةٌ أيّاً كان فرق الساعتين؛ والمقارنة بساعة الجوال لأوّل قراءة وحدها (أو لقراءةٍ لا تتقدّم)
    let newestTs = -Infinity;
    const fresh: GeoFix[] = [];
    const stale: GeoFix[] = [];
    let done = false;
    let extended = false;
    let id: number | null = null;
    let refine: ReturnType<typeof setTimeout> | null = null;
    // R3: الطازجة أوّلاً — والمخبّأة احتياطٌ لا يُرسل إلا إن لم تصل طازجة أبداً
    const preferred = () => bestFix(fresh) ?? bestFix(stale);
    // R1: بعد مهلة التحسين تكفي دقّة السماحية — من الطازجة وحدها
    const settled = () => { const b = bestFix(fresh); return !!b && finite(b.accuracy) && b.accuracy <= PUNCH_FIX_SETTLE_M; };
    const finish = (reason: PunchFixReason) => {
      if (done) return;
      done = true;
      clearTimeout(cap);
      if (refine != null) clearTimeout(refine);
      if (id != null) geo.clearWatch(id);
      const fix = preferred();
      resolve({ fix, reason: fix ? 'ok' : reason });
    };
    const cap = setTimeout(() => finish('timeout'), capMs);
    const refineEnded = () => {
      if (settled() || extendMs <= refineMs) { finish('ok'); return; }
      extended = true;
      refine = setTimeout(() => finish('ok'), extendMs - refineMs);
    };
    id = geo.watchPosition(
      (p) => {
        if (done) return;
        const f = toGeoFix(p);
        if (!isGeoFix(f)) return;
        // بلا لحظة قراءة = طازجة (toGeoFix يعطيها الآن)
        const ts = finite(p.timestamp) ? p.timestamp : null;
        const advanced = ts != null && newestTs > -Infinity && ts > newestTs;
        const isStale = ts != null && ts < staleBefore && !advanced;
        if (ts != null && ts > newestTs) newestTs = ts;
        (isStale ? stale : fresh).push(f);
        if (!isStale && finite(f.accuracy) && f.accuracy <= goodM) { finish('ok'); return; }
        if (extended && settled()) { finish('ok'); return; }
        if (refine == null) refine = setTimeout(refineEnded, refineMs);
      },
      (e) => {
        if (e?.code === 1) finish('denied');                          // PERMISSION_DENIED
        else if (fresh.length + stale.length === 0) finish(e?.code === 2 ? 'unavailable' : 'timeout'); // POSITION_UNAVAILABLE / TIMEOUT
        // بعد قراءةٍ: خطأٌ عابر لا يُسقطها — مهلة التحسين تُنهي بأدقّ ما وصل
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: waitMs },
    );
    // قراءةٌ وصلت متزامنةً قبل أن يُعرف المعرّف: نُغلق المراقبة الآن
    if (done && id != null) geo.clearWatch(id);
  });
}

/**
 * يراقب الموقع بلا مخبّأ (`maximumAge: 0`) ويعيد أدقّ قراءة:
 * - فور وصول قراءةٍ طازجة دقيقة بما يكفي، أو بعد مهلة تحسينٍ تبدأ من أوّل قراءة — وتمتدّ حتى ~٢٠ ث ما دامت أدقّ
 *   الطازجة أضعف من ٢٥ م، وتنتهي فور بلوغها (R1).
 * - قراءةٌ أقدم من بدء المراقبة بأكثر من ٥ ث لا تُنهيها، وتُرسل فقط إن لم تصل طازجة (R3).
 * - المهلة إلى أوّل قراءة هي `timeout` المراقبة نفسها، وتبدأ بعد منح الإذن — فنافذة الإذن الأولى لا تُضيّع البصمة.
 * - رفض الإذن والموقع المتعذّر بلا أيّ قراءة يُنهيان فوراً بسببهما.
 */
export function precisePunchFix(
  geo: Geo | undefined = defaultGeo(),
  t: PunchWatchOpts = {},
): Promise<PunchFixResult> {
  return watchBestFix(geo, t);
}

/**
 * دبوس العميل (R2/PIN-6): المراقبة الدقيقة نفسها — بلا مخبّأ وأدقّ ما وصل — بدل getCurrentPosition بقراءةٍ مخبّأة أو أوّل
 * قراءةٍ خشنة. الدقّة تعود معه (null إن لم تُعرف) لتعرضها الشاشة وتنبّه بـpinAccuracyLevel؛ لا شيء هنا يمنع الحفظ.
 */
export async function precisePinFix(opts: PunchWatchOpts & { geolocation?: Geolocation } = {}): Promise<PinFixResult> {
  const geo = 'geolocation' in opts ? opts.geolocation : defaultGeo();
  const r = await watchBestFix(geo, opts);
  if (!r.fix) return { fix: null, reason: r.reason };
  return { fix: { lat: r.fix.lat, lng: r.fix.lng, accuracy: finite(r.fix.accuracy) ? r.fix.accuracy : null }, reason: 'ok' };
}

/**
 * تسخين الـGPS (R1): مراقبةٌ دقيقة بلا مخبّأ تُفتح لحظة ظهور شاشة البصمة أو نافذة «أثبت تواجدي» للمقيَّد، فيكون
 * الـGPS قد التقط حين يضغط المندوب — قراءاتها تُهمَل، والبصمة تقرأ بمراقبتها الطازجة. تعيد دالّة الإيقاف (تُستدعى
 * عند مغادرة الشاشة، ومرّتين لا يضرّ)، وتتوقّف وحدها برفض الإذن أو بعد السقف.
 * ولا تسأل الإذن أبداً: تبدأ فقط إن كان الإذن ممنوحاً سلفاً (Permissions API = granted). فالشاشة أو نافذة التواجد التي
 * تُفتح وحدها لا تُظهر نافذة إذنٍ قبل أن يضغط المندوب (وإغلاقها مراراً قد يحظر الموقع في Chrome فتتعذّر البصمة) —
 * والإذن غير المحسوم أو متصفّحٌ بلا Permissions API ⇒ بلا تسخين، كما كان قبله، والبصمة تسأل عند ضغطتها.
 */
type PermQuery = { query: (d: { name: 'geolocation' }) => Promise<{ state: string }> };
const defaultPermissions = (): PermQuery | undefined => {
  try {
    const p = typeof navigator !== 'undefined' ? (navigator as { permissions?: PermQuery }).permissions : undefined;
    return p && typeof p.query === 'function' ? p : undefined;
  } catch { return undefined; }
};

export function startPunchWarmup(
  geo: Geo | undefined = defaultGeo(),
  opts: { maxMs?: number; permissions?: PermQuery } = {},
): () => void {
  if (!geo) return () => {};
  let stopped = false;
  let id: number | null = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    if (id != null) geo.clearWatch(id);
  };
  const timer = setTimeout(stop, opts.maxMs ?? PUNCH_WARMUP_MAX_MS);
  const open = () => {
    if (stopped) return;                                              // أُوقف قبل أن يُعرف الإذن
    try {
      id = geo.watchPosition(
        () => {},
        (e) => { if (e?.code === 1) stop(); },                       // رفض الإذن: لا فائدة من الإبقاء
        { enableHighAccuracy: true, maximumAge: 0 },
      );
    } catch {
      stop();
      return;
    }
    // رفضٌ وصل متزامناً قبل أن يُعرف المعرّف
    if (stopped && id != null) geo.clearWatch(id);
  };
  const perms = 'permissions' in opts ? opts.permissions : defaultPermissions();
  if (!perms) { stop(); return stop; }
  let asked: Promise<{ state: string }>;
  try { asked = perms.query({ name: 'geolocation' }); } catch { stop(); return stop; }
  Promise.resolve(asked).then((s) => { if (s?.state === 'granted') open(); else stop(); }, () => stop());
  return stop;
}
