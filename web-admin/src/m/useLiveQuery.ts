import { useEffect, useState } from 'react';

/**
 * هل هذه الشاشة «حيّة» الآن؟ — أساس كل استطلاع دوريّ في تطبيق الجوال.
 *
 * لوحة سطح المكتب تستطلع كل دقيقة بلا شرط، وذلك مقبول على حاسوب موصول
 * بالكهرباء. أمّا على الجوال فالتطبيق يبقى مفتوحاً في الخلفية ساعاتٍ،
 * فاستطلاعٌ غير مشروط = استنزاف بطارية وباقة بيانات بلا أن ينظر أحد للشاشة.
 *
 * يُرجع `false` حين يُخفى التبويب أو يفقد النافذةُ التركيزَ، فيُمرَّر لـ
 * `refetchInterval` في react-query: `enabled ? 30000 : false`.
 */
export function useIsLive(): boolean {
  const [live, setLive] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState === 'visible');

  useEffect(() => {
    const update = () => setLive(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, []);

  return live;
}

/** فاصل استطلاع مشروط بحياة الشاشة — يُمرَّر مباشرةً لـ`refetchInterval` */
export function livePoll(ms: number, live: boolean): number | false {
  return live ? ms : false;
}
