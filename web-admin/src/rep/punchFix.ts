// موقع البصمة للمندوب المقيَّد بـ«بصمة الحضور بموقع عميل» — قراءةٌ طازجة بأفضل دقّة (بلاغ المالك ٢١ أكتوبر ٢٠٢٦).
//
// كانت البصمة تقرأ بـ`maximumAge: 30000`: قراءةٌ مخبّأة عمرها حتى نصف دقيقة. المندوب الواصل بسيارته يضغط البصمة
// فوراً فتُرسل نقطةٌ من الشارع قبل مئات الأمتار، أو أوّل قراءةٍ خشنة من الشبكة — فلا يقبله القيد إلا بمسافةٍ واسعة
// («لا يعمل إلا بـ٣٠٠ متر»). هنا: مراقبةٌ بلا مخبّأ، وأدقّ ما وصل ومعه هامش خطئه (`accuracy`) ليحكم به الخادم
// (punchAwayFromCustomer في routes/tracking.ts) — ومعه سبب الغياب إن لم تصل قراءة، لتقول الشاشة ما حدث فعلاً.

import { toGeoFix, isGeoFix, type GeoFix } from './visitLocation';

/** دقّةٌ تكفي فتتوقّف المراقبة فوراً — في الخارج تصل خلال ثوانٍ */
export const PUNCH_FIX_GOOD_M = 20;
/** أقصى انتظار لأوّل قراءة **بعد منح الإذن** (مهلة المراقبة نفسها — لا تحسب وقت نافذة الإذن) */
export const PUNCH_FIX_WAIT_MS = 12_000;
/** بعد أوّل قراءة: مهلة تحسينها ما لم تبلغ الدقّة الكافية — داخل المحلّ قد لا تبلغ العشرين أبداً */
export const PUNCH_FIX_REFINE_MS = 8_000;
/** سقفٌ لنافذة إذنٍ لم يُجب عنها — فلا يبقى الزرّ «جارٍ تحديد موقعك» بلا نهاية */
export const PUNCH_FIX_PROMPT_CAP_MS = 60_000;

/** ok = وصلت قراءة · denied = رُفض الإذن · unavailable = الموقع متعذّر في الجهاز · timeout = لا قراءة في المهلة · no-geo = لا تحديد موقع */
export type PunchFixReason = 'ok' | 'denied' | 'unavailable' | 'timeout' | 'no-geo';
export interface PunchFixResult { fix: GeoFix | null; reason: PunchFixReason }

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

type Geo = Pick<Geolocation, 'watchPosition' | 'clearWatch'>;

/**
 * يراقب الموقع بلا مخبّأ (`maximumAge: 0`) ويعيد أدقّ قراءة:
 * - فور وصول قراءةٍ دقيقة بما يكفي، أو بعد مهلة تحسينٍ تبدأ من أوّل قراءة.
 * - المهلة إلى أوّل قراءة هي `timeout` المراقبة نفسها، وتبدأ بعد منح الإذن — فنافذة الإذن الأولى لا تُضيّع البصمة.
 * - رفض الإذن والموقع المتعذّر بلا أيّ قراءة يُنهيان فوراً بسببهما.
 */
export function precisePunchFix(
  geo: Geo | undefined = typeof navigator !== 'undefined' ? navigator.geolocation : undefined,
  t: { waitMs?: number; refineMs?: number; capMs?: number } = {},
): Promise<PunchFixResult> {
  const waitMs = t.waitMs ?? PUNCH_FIX_WAIT_MS;
  const refineMs = t.refineMs ?? PUNCH_FIX_REFINE_MS;
  const capMs = t.capMs ?? PUNCH_FIX_PROMPT_CAP_MS;
  return new Promise((resolve) => {
    if (!geo) { resolve({ fix: null, reason: 'no-geo' }); return; }
    const got: GeoFix[] = [];
    let done = false;
    let id: number | null = null;
    let refine: ReturnType<typeof setTimeout> | null = null;
    const finish = (reason: PunchFixReason) => {
      if (done) return;
      done = true;
      clearTimeout(cap);
      if (refine != null) clearTimeout(refine);
      if (id != null) geo.clearWatch(id);
      const fix = bestFix(got);
      resolve({ fix, reason: fix ? 'ok' : reason });
    };
    const cap = setTimeout(() => finish('timeout'), capMs);
    id = geo.watchPosition(
      (p) => {
        const f = toGeoFix(p);
        if (!isGeoFix(f)) return;
        got.push(f);
        if (fixGoodEnough(f)) { finish('ok'); return; }
        if (refine == null) refine = setTimeout(() => finish('ok'), refineMs);
      },
      (e) => {
        if (e?.code === 1) finish('denied');                          // PERMISSION_DENIED
        else if (got.length === 0) finish(e?.code === 2 ? 'unavailable' : 'timeout'); // POSITION_UNAVAILABLE / TIMEOUT
        // بعد قراءةٍ: خطأٌ عابر لا يُسقطها — مهلة التحسين تُنهي بأدقّ ما وصل
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: waitMs },
    );
    // قراءةٌ وصلت متزامنةً قبل أن يُعرف المعرّف: نُغلق المراقبة الآن
    if (done && id != null) geo.clearWatch(id);
  });
}
