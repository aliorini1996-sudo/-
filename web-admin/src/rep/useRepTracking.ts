import { useEffect, useRef, useState } from 'react';
import repApi from './repApi';

export type TrackStatus = 'off' | 'requesting' | 'active' | 'denied' | 'unavailable';

// يتتبّع موقع المندوب عبر GPS (عند تفعيل الشركة للتتبّع) ويرسله دفعات للخادم.
// قيود الويب: يعمل أثناء فتح التطبيق فقط (لا تتبّع خلفي موثوق في المتصفح).
// forced: المندوب المقيَّد بـ«اشتراط تفعيل الموقع» — يُتتبَّع ولو أطفأت الشركة التتبّع (ظهوره على الخريطة شرطُ عمله، والخادم
// يخزّن نقاطه رغم الإيقاف)، ولا يملك إيقافه ما دام مقيَّداً
export function useRepTracking(active: boolean, forced = false): TrackStatus {
  const [status, setStatus] = useState<TrackStatus>('off');
  const buffer = useRef<{ lat: number; lng: number; accuracy?: number; speed?: number | null; capturedAt: string }[]>([]);
  const lastKept = useRef(0);

  useEffect(() => {
    if (!active) { setStatus('off'); return; }
    let watchId: number | null = null;
    let flushTimer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const flush = () => {
      if (!buffer.current.length) return;
      const points = buffer.current.splice(0, buffer.current.length);
      // background: نبضة تتبّع خلفية — فشل 401 عابر لا يُخرج المندوب (repApi.ts)
      repApi.post('/tracking/ping', { points }, { background: true }).catch(() => { /* غير متصل — تُهمَل الدفعة */ });
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
        pos => {
          if (cancelled) return;
          setStatus('active');
          const now = Date.now();
          // نقطة كل 8 ثوانٍ كحدّ أدنى — كثافة أعلى تُحسّن مطابقة المسار مع الطرق
          // (يوم كامل ≈ 3600 نقطة، دون حدّ الخادم 5000)
          if (now - lastKept.current < 8000) return;
          lastKept.current = now;
          buffer.current.push({
            lat: pos.coords.latitude, lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy, speed: pos.coords.speed,
            capturedAt: new Date(pos.timestamp).toISOString(),
          });
          if (buffer.current.length >= 8) flush();
        },
        err => { setStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'); },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 },
      );
      flushTimer = setInterval(flush, 45000);
    };

    start();
    const onHide = () => flush();
    window.addEventListener('beforeunload', onHide);
    document.addEventListener('visibilitychange', onHide);

    return () => {
      cancelled = true;
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (flushTimer) clearInterval(flushTimer);
      window.removeEventListener('beforeunload', onHide);
      document.removeEventListener('visibilitychange', onHide);
      flush();
    };
  }, [active, forced]);

  return status;
}
