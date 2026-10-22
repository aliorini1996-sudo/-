// رفع نقاط التتبّع (علاج «تأخّر الموقع»، طلب المالك ٢٢ أكتوبر ٢٠٢٦) — قراراتٌ صرفة بلا متصفّح تُختبر وحدها.
//
// كانت النقاط تُجمع وتُرفع دفعةً كل ٤٥ث وتقبل قراءةً مخبّأة عمرها ١٠ث، فيصل موقع المندوب الخادمَ بعد قرابة دقيقة،
// والدفعة التي يفشل إرسالها تُرمى. الآن: أول نقطةٍ (وبعد عودة التطبيق أو الاتصال) فوراً، والمتحرّك كل ١٥ث، والساكن كل
// ٣٠ث — تأخّرٌ أقصر حين يهمّ (الوصول والمغادرة) دون أن تتضاعف الطلبات طوال اليوم. والفاشل يُعاد بتراجعٍ لا يُرمى.

export interface TrackPoint { lat: number; lng: number; accuracy?: number; speed?: number | null; capturedAt: string }

/** أقلّ فاصل بين نقطتين محفوظتين — كما كان: كثافةٌ تكفي مطابقة الطرق، ويومٌ كامل دون حدّ الخادم */
export const KEEP_EVERY_MS = 8_000;
/** متحرّكٌ = ابتعد هذا القدر عن آخر نقطةٍ رُفعت */
export const MOVE_M = 25;
/** المتحرّك يُرفع موقعه كل هذا على الأقل */
export const MOVING_GAP_MS = 15_000;
/** والساكن كل هذا — كان ٤٥ث للجميع */
export const IDLE_GAP_MS = 30_000;
/** ساكنٌ لم تصل له قراءة (آيفون يكفّ عن الإبلاغ حين لا يتحرّك الجوال): قراءةٌ طازجة يُطلب بها بعد هذا */
export const REFRESH_IF_SILENT_MS = IDLE_GAP_MS;
/** أقصى ما يُحفظ على الجهاز من نقاطٍ لم تُرفع (انقطاع) — ساعةٌ بنقطة كل ٨ث، والأقدم يسقط */
export const MAX_PENDING = 450;
/** أقصى نقاط الطلب الواحد — حدّ الخادم (pingSchema في backend/src/routes/tracking.ts) */
export const MAX_BATCH = 200;
/** تراجع الإعادة بعد فشل: من ١٥ث يتضاعف إلى دقيقتين */
export const RETRY_START_MS = 15_000;
export const RETRY_MAX_MS = 120_000;

export interface UploadState {
  /** لحظة آخر رفعٍ ناجح (0 = لم يُرفع شيء بعد) */
  lastSentAt: number;
  /** آخر نقطةٍ رُفعت — منها يُقاس التحرّك */
  lastSent: { lat: number; lng: number } | null;
  /** رفعٌ فوري عند أول نقطة: فُتح التطبيق، أو عاد للواجهة، أو عاد الاتصال */
  urgent: boolean;
  /** لا رفع قبل هذه اللحظة (تراجعٌ بعد فشل) */
  retryAt: number;
  /** التراجع الجاري (0 = لا فشل) */
  backoff: number;
}

export const initialUpload = (): UploadState => ({ lastSentAt: 0, lastSent: null, urgent: true, retryAt: 0, backoff: 0 });

/** المسافة بالأمتار (هافرسين) */
export function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** هل يُرفع الآن، وأحدث نقطةٍ لم تُرفع هي `newest`؟ */
export function uploadDue(st: UploadState, newest: { lat: number; lng: number }, now: number): boolean {
  if (now < st.retryAt) return false;
  if (st.urgent || !st.lastSent) return true;
  const gap = now - st.lastSentAt;
  if (gap >= IDLE_GAP_MS) return true;
  return gap >= MOVING_GAP_MS && metersBetween(st.lastSent, newest) >= MOVE_M;
}

/** رفعٌ نجح: آخر نقطةٍ فيه مرجع التحرّك، ويُصفَّر التراجع */
export function afterSuccess(last: { lat: number; lng: number }, now: number): UploadState {
  return { lastSentAt: now, lastSent: { lat: last.lat, lng: last.lng }, urgent: false, retryAt: 0, backoff: 0 };
}

/** رفعٌ فشل ويستحقّ الإعادة: لا رفع قبل التراجع، والتراجع يتضاعف */
export function afterFailure(st: UploadState, now: number): UploadState {
  const backoff = st.backoff ? Math.min(st.backoff * 2, RETRY_MAX_MS) : RETRY_START_MS;
  return { ...st, retryAt: now + backoff, backoff };
}

/** فشلٌ يستحقّ الإعادة: لا ردّ (شبكة)، أو 401 (التجديد يعالجه)، أو 408/429/5xx. ما سواه رفضٌ نهائي تُرمى دفعته */
export function retryable(status: number | undefined): boolean {
  return status == null || status === 401 || status === 408 || status === 429 || status >= 500;
}

/**
 * دفعةٌ فشلت تعود إلى الطابور بترتيبٍ زمني (تُرفع الأحدث أولاً، فقد تكون أحدث مما بقي) — والأقدم يسقط فوق السقف
 */
export function requeue(failed: readonly TrackPoint[], pending: readonly TrackPoint[], cap = MAX_PENDING): TrackPoint[] {
  const all = [...failed, ...pending].sort((a, b) => (a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0));
  return all.length > cap ? all.slice(all.length - cap) : all;
}
