import { useEffect, useRef } from 'react';
import repApi from './repApi';
import { outboxAllOrNull } from './offlineDb';
import { heartbeatPayload } from './outboxReview';
import { BUILD_ID } from '../lib/buildId';

/**
 * نبضة حضور: تُعلم الخادم أن تطبيق المندوب مفتوح ومتصل — لحساب ساعات العمل.
 * مستقلّة تماماً عن تتبّع GPS؛ تعمل ما دام المندوب مسجّلاً دخوله والتطبيق مفتوحاً،
 * وترسل فقط عند توفّر اتصال (فالوقت المحسوب = «متصل وفاتح التطبيق»).
 */
export function useHeartbeat(active: boolean, onPresence?: (p: unknown, beatAt: number) => void): void {
  // «التحقق العشوائي من التواجد»: ردّ النبضة يحمل الطلب المعلّق — يصل التطبيق المفتوح بلا تنبيهات مفعّلة
  const presenceCb = useRef(onPresence);
  presenceCb.current = onPresence;
  useEffect(() => {
    if (!active) return;
    // background: نبضة خلفية — فشلها العابر لا يُخرج المندوب (انظر repApi.ts)
    // + حالة الجهاز (Z5.0): معرّف الحزمة وعدّا الصفّ الصادر لكل المناديب على الجهاز — لجاهزية تفعيل الفوترة (Z5.8)
    const beat = () => {
      if (!navigator.onLine) return;
      // لحظة إطلاق النبضة: ردٌّ «لا طلب» من نبضةٍ سبقت ظهور طلبٍ (وصل بالإشعار أثناءها) لا يغلقه
      const beatAt = Date.now();
      outboxAllOrNull()
        .then((docs) => repApi.post('/tracking/heartbeat', heartbeatPayload(BUILD_ID, docs), { background: true }))
        // presence حاضرٌ في الردّ (null = لا طلب معلّق) — خادمٌ أقدم بلا الحقل لا يُغلق شيئاً
        .then((r) => { const d = r?.data?.data; if (d && 'presence' in d) presenceCb.current?.(d.presence ?? null, beatAt); })
        .catch(() => { /* تجاهل */ });
    };
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
