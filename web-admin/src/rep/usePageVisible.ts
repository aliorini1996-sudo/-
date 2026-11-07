// هل الصفحة ظاهرةٌ الآن (document.visibilityState) — يتجدّد بكل إخفاءٍ وإظهار (visibilitychange).
//
// لتسخين الـGPS (startPunchWarmup في punchFix.ts — تدقيق نطاق ٥٠ متراً، ٧ نوفمبر ٢٠٢٦): التسخين يقف وحده بعد سقفه، وكان
// يبدأ مرّةً عند فتح الشاشة فيستهلك سقفه والتطبيق في الخلفية (الجوال مقفل أو المندوب يقود)، فيعود المندوب إلى باب المحلّ
// ويبصم من GPS بارد. بهذه القيمة في شرط التسخين واعتماديّاته: يقف بالإخفاء ويُفتح من جديد بسقفٍ كامل عند كل عودة.
import { useEffect, useState } from 'react';

const visibleNow = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';

export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(visibleNow);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = () => setVisible(visibleNow());
    document.addEventListener('visibilitychange', onChange);
    onChange();
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}
