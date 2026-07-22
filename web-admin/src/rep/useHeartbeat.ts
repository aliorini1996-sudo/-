import { useEffect } from 'react';
import repApi from './repApi';

/**
 * نبضة حضور: تُعلم الخادم أن تطبيق المندوب مفتوح ومتصل — لحساب ساعات العمل.
 * مستقلّة تماماً عن تتبّع GPS؛ تعمل ما دام المندوب مسجّلاً دخوله والتطبيق مفتوحاً،
 * وترسل فقط عند توفّر اتصال (فالوقت المحسوب = «متصل وفاتح التطبيق»).
 */
export function useHeartbeat(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const beat = () => { if (navigator.onLine) repApi.post('/tracking/heartbeat').catch(() => { /* تجاهل */ }); };
    beat(); // فور فتح التطبيق
    const timer = setInterval(beat, 60000); // نبضة كل دقيقة
    const onVisible = () => { if (!document.hidden) beat(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', beat);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', beat);
    };
  }, [active]);
}
