// روابط PDF فوق الجداول الملتقطة: html2canvas يرسم الجدول صورةً فتسقط روابطه، فنضع فوق موضع كل <a>
// منطقةَ رابطٍ في الصفحة نفسها (رابط «فتح الخريطة» في ورقة «تفاصيل البصمات» يبقى قابلاً للنقر).
// دالةٌ صرفة: موضع الرابط بالبكسل داخل العنصر ← صفحته وموضعه بالنقاط بعد تحجيم الصورة على عرض الصفحة.

export interface LinkBox { url: string; x: number; y: number; w: number; h: number }
export interface PageLink extends LinkBox { /** إزاحة الصفحة من أول صفحةٍ للعنصر (٠ = صفحته الأولى) */ page: number }

export function linkAreas(boxes: readonly LinkBox[], elWidthPx: number, pageW: number, pageH: number): PageLink[] {
  if (!(elWidthPx > 0) || !(pageW > 0) || !(pageH > 0)) return [];
  const k = pageW / elWidthPx;   // الصورة تُمدّ على عرض الصفحة كاملاً
  return boxes
    .filter(b => /^https?:\/\//.test(b.url) && b.w > 0 && b.h > 0)
    .map(b => {
      const top = b.y * k;
      const page = Math.floor(top / pageH);
      return { url: b.url, page, x: b.x * k, y: top - page * pageH, w: b.w * k, h: b.h * k };
    });
}
