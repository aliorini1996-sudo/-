import { useEffect, useRef, useState } from 'react';
import repApi from './repApi';

export type TrackStatus = 'off' | 'requesting' | 'active' | 'denied' | 'unavailable';

// يتتبّع موقع المندوب عبر GPS (عند تفعيل الشركة للتتبّع) ويرسله دفعات للخادم.
// قيود الويب: يعمل أثناء فتح التطبيق فقط (لا تتبّع خلفي موثوق في المتصفح).
export function useRepTracking(active: boolean): TrackStatus {
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
      repApi.post('/tracking/ping', { points }).catch(() => { /* غير متصل — تُهمَل الدفعة */ });
    };

    const start = async () => {
      // تتبّع فقط إن فعّلت الشركة الميزة
      let enabled = false;
      try { enabled = !!(await repApi.get('/tracking/settings')).data.data.enabled; } catch { /* */ }
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
  }, [active]);

  return status;
}
