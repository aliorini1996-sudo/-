// ============================================================================
// مراقبة نقطة كسر العرض — نقيّةٌ إلا من `matchMedia` المُمرَّر، فتُختبر في node بنافذةٍ مزيّفة.
// ============================================================================

/** نقطة `lg` في Tailwind (لا `screens` مخصّصة في tailwind.config.js): الشريط الجانبيّ بدل السفليّ و«المزيد» */
export const LG_MEDIA = '(min-width: 1024px)';

type MqEvent = { matches: boolean };
interface MqList {
  matches: boolean;
  addEventListener?: (type: 'change', cb: (e: MqEvent) => void) => void;
  removeEventListener?: (type: 'change', cb: (e: MqEvent) => void) => void;
  /** Safari قبل 14 */
  addListener?: (cb: (e: MqEvent) => void) => void;
  removeListener?: (cb: (e: MqEvent) => void) => void;
}
export interface MediaWindow { matchMedia?: (q: string) => MqList }

/**
 * يستدعي `cb` إن طابق الاستعلامُ الآن، وكلّما صار مطابقاً بعدُ (تدوير الجهاز، تكبير النافذة).
 * يُعيد دالّة الإلغاء. بلا `matchMedia` (بيئةٌ قديمة) لا يفعل شيئاً.
 */
export function onMediaMatch(query: string, cb: () => void, win: MediaWindow | undefined = typeof window !== 'undefined' ? window : undefined): () => void {
  const mq = win?.matchMedia?.(query);
  if (!mq) return () => {};
  const h = (e: MqEvent) => { if (e.matches) cb(); };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', h);
  else mq.addListener?.(h);
  if (mq.matches) cb();
  return () => {
    if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', h);
    else mq.removeListener?.(h);
  };
}
