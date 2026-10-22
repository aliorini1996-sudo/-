import { useEffect, useRef, useState } from 'react';
import repApi, { postKeepalive } from './repApi';
import { currentRepId } from './offlineDb';
import {
  KEEP_EVERY_MS, MAX_BATCH, MAX_PENDING, REFRESH_IF_SILENT_MS, initialUpload, uploadDue, afterSuccess, afterFailure, retryable, requeue,
  type TrackPoint, type UploadState,
} from './trackUpload';

export type TrackStatus = 'off' | 'requesting' | 'active' | 'denied' | 'unavailable';

/** كل كم يُفحص «هل حان الرفع» ولو لم تصل قراءة جديدة */
const TICK_MS = 5_000;
/** مهلة طلب النقاط: شبكةٌ ميدانية معلّقة لا تُبقي قفل الرفع مغلقاً فيتوقف الموقع كله — الفاشل يُعاد بالتراجع */
const PING_TIMEOUT_MS = 20_000;

// يتتبّع موقع المندوب عبر GPS (عند تفعيل الشركة للتتبّع) ويرسله للخادم بسياسة trackUpload.ts: فوراً عند الفتح والعودة،
// كل ١٥ث متحرّكاً، وكل ٣٠ث ساكناً — وما يفشل إرساله يُعاد بتراجعٍ لا يُرمى.
// قيود الويب: يعمل أثناء فتح التطبيق فقط (لا تتبّع خلفي موثوق في المتصفح).
// forced: المندوب المقيَّد بـ«اشتراط تفعيل الموقع» — يُتتبَّع ولو أطفأت الشركة التتبّع (ظهوره على الخريطة شرطُ عمله، والخادم
// يخزّن نقاطه رغم الإيقاف)، ولا يملك إيقافه ما دام مقيَّداً
export function useRepTracking(active: boolean, forced = false): TrackStatus {
  const [status, setStatus] = useState<TrackStatus>('off');
  const buffer = useRef<TrackPoint[]>([]);
  const lastKept = useRef(0);
  const upload = useRef<UploadState>(initialUpload());
  const inFlight = useRef(false);
  /** صاحب النقاط المنتظرة — جهازٌ مشترك: نقاط من خرج لا تُرفع بتوكن من دخل بعده */
  const owner = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!active) { setStatus('off'); return; }
    let watchId: number | null = null;
    let tick: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    let refreshing = false;
    upload.current = initialUpload();
    if (owner.current !== currentRepId()) { buffer.current = []; owner.current = currentRepId(); }

    // keepalive: عند الإخفاء والإغلاق — يكمل الطلب بعدهما (axios قد يُقطع فتضيع آخر النقاط)
    const send = (batch: TrackPoint[], keepalive: boolean): Promise<unknown> => (keepalive
      ? postKeepalive('/tracking/ping', { points: batch }, PING_TIMEOUT_MS).then((status) => {
        if (status < 200 || status >= 300) throw Object.assign(new Error(`ping ${status}`), { response: { status } });
      })
      // background: نبضة تتبّع خلفية — فشل 401 عابر لا يُخرج المندوب (repApi.ts)
      : repApi.post('/tracking/ping', { points: batch }, { background: true, timeout: PING_TIMEOUT_MS }));

    // drain: دفعةٌ أقدم من متراكمٍ بعد انقطاع — لا تغيّر مرجع التحرّك (آخر نقطةٍ رُفعت هي الأحدث)
    const flush = (keepalive = false, drain = false) => {
      if (inFlight.current || !buffer.current.length) return;
      const who = currentRepId();
      // خرج المندوب (لا جلسة) أو تبدّل صاحب النقاط: لا تُرفع بتوكن غيره
      if (!who || who !== owner.current) { buffer.current = []; return; }
      // الأحدث أولاً: بعد انقطاعٍ طويل يظهر الموقع الحيّ فوراً (الخادم لا يُرجع الدبّوس بالأقدم)، ثم يكتمل المسار تباعاً
      const batch = buffer.current.splice(Math.max(0, buffer.current.length - MAX_BATCH));
      inFlight.current = true;
      let more = false;
      send(batch, keepalive)
        .then(() => {
          // ردٌّ متأخر بعد خروج صاحبه أو إعادة الأثر: حالة الرفع الجديدة (العاجلة) لا تُكتب فوقها
          if (cancelled || currentRepId() !== who) return;
          upload.current = drain ? { ...upload.current, retryAt: 0, backoff: 0 } : afterSuccess(batch[batch.length - 1], Date.now());
          more = !cancelled && batch.length === MAX_BATCH && buffer.current.length > 0;
        })
        .catch((err: unknown) => {
          const st = (err as { response?: { status?: number } })?.response?.status;
          if (!retryable(st)) return; // رفضٌ نهائي (400/403): الدفعة لا تصلح للإعادة
          if (currentRepId() !== who) return; // خرج صاحبها أثناء الطلب
          buffer.current = requeue(batch, buffer.current);
          upload.current = afterFailure(upload.current, Date.now());
        })
        // بعد تحرير القفل لا قبله: المتراكم فوق دفعة يُرفع تباعاً
        .finally(() => { inFlight.current = false; if (more) flush(false, true); });
    };

    const maybeFlush = () => {
      const newest = buffer.current[buffer.current.length - 1];
      if (newest && uploadDue(upload.current, newest, Date.now())) flush();
    };

    const onPosition = (pos: GeolocationPosition) => {
      if (cancelled) return;
      setStatus('active');
      const now = Date.now();
      // نقطة كل 8 ثوانٍ كحدّ أدنى — كثافة أعلى تُحسّن مطابقة المسار مع الطرق
      // (يوم كامل ≈ 3600 نقطة، دون حدّ الخادم 5000)
      if (now - lastKept.current < KEEP_EVERY_MS) return;
      lastKept.current = now;
      if (owner.current !== currentRepId()) { buffer.current = []; owner.current = currentRepId(); }
      buffer.current.push({
        lat: pos.coords.latitude, lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy, speed: pos.coords.speed,
        capturedAt: new Date(pos.timestamp).toISOString(),
      });
      if (buffer.current.length > MAX_PENDING) buffer.current.splice(0, buffer.current.length - MAX_PENDING);
      maybeFlush();
    };

    // ساكنٌ لم تصل له قراءة منذ ٣٠ث (آيفون يكفّ عن الإبلاغ حين لا يتحرّك الجوال): قراءةٌ طازجة، فلا يبدو موقعه قديماً
    // للإدارة وهو في مكانه. بعد أول قراءةٍ وحدها: قبلها قد تكون نافذة الإذن معروضة، وطلبٌ متكرّر يعيد عرضها
    const refreshIfSilent = () => {
      if (refreshing || lastKept.current === 0 || Date.now() - lastKept.current < REFRESH_IF_SILENT_MS || document.hidden) return;
      refreshing = true;
      navigator.geolocation.getCurrentPosition(
        (pos) => { refreshing = false; onPosition(pos); },
        () => { refreshing = false; },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
      );
    };

    const start = async () => {
      // تتبّع فقط إن فعّلت الشركة الميزة — أو كان المندوب مقيَّداً
      let enabled = forced;
      if (!enabled) {
        try { enabled = !!(await repApi.get('/tracking/settings', { background: true })).data.data.enabled; } catch { /* */ }
      }
      if (cancelled || !enabled) { setStatus('off'); return; }
      if (!('geolocation' in navigator)) { setStatus('unavailable'); return; }

      setStatus('requesting');
      watchId = navigator.geolocation.watchPosition(
        onPosition,
        err => { setStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'); },
        // maximumAge 0: قراءةٌ طازجة دائماً — المخبّأة (كانت حتى ١٠ث) تؤخّر الموقع قبل أن يُرفع
        { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
      );
      tick = setInterval(() => { maybeFlush(); refreshIfSilent(); }, TICK_MS);
    };

    start();
    // الاختفاء: ما جُمع يُرفع الآن (قد لا يعود التطبيق). العودة أو عودة الاتصال: أول نقطةٍ تُرفع فوراً، ومعها ما تراكم
    const onVisibility = () => {
      if (document.hidden) { flush(true); return; }
      upload.current = { ...upload.current, urgent: true, retryAt: 0 };
      maybeFlush();
    };
    const onOnline = () => { upload.current = { ...upload.current, urgent: true, retryAt: 0 }; maybeFlush(); };
    const onUnload = () => flush(true);
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (tick) clearInterval(tick);
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
  }, [active, forced]);

  return status;
}
