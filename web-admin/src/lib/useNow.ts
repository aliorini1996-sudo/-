import { useEffect, useState } from 'react';

/**
 * «الآن» يتقدّم كل `ms` ما دامت الصفحة ظاهرة (ويُحدَّث فور عودتها) — حالةٌ زمنية مثل «موقع مباشر · الآن» و«قبل ٣ د» تُعاد
 * حسابها ولو لم تصل بيانات جديدة: مندوبٌ نفدت بطاريته لا ترسل له نقاطٌ ولا نبضات، فلا يتغيّر شيءٌ في الاستعلام نفسه.
 */
export function useNow(ms: number, clock: () => number = Date.now): number {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const tick = () => { if (!document.hidden) setNow(clock()); };
    const id = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [ms, clock]);
  return now;
}
