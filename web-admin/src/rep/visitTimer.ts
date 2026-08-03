/**
 * مؤقّت زيارة العميل — حالة صغيرة في localStorage.
 *
 * لماذا localStorage لا حالة React: المؤقّت يجب أن ينجو من شيئين:
 *  ١) فتح نافذة فرعية (فاتورة/سند) يُفكِّك مكوّن CustomerDetail — فالحالة
 *     المحليّة داخله تضيع، لكن الزيارة ما زالت جارية.
 *  ٢) إعادة تحميل التبويب (متصفّحات الجوّال تُسقط التبويبات الخلفية) — بلا
 *     تخزين دائم يُفقَد المؤقّت وتضيع مدّة الزيارة.
 *
 * الحسابات صرفة وقابلة للاختبار بلا DOM؛ الوصول لـlocalStorage معزول في
 * دوالّ get/set/clear لتُستبدَل بمخزون وهميّ في الاختبار.
 */

const KEY = 'rep_visit_timer';

export interface VisitTimer {
  customerId: string;
  customerName: string;
  /** عميل أُنشئ أوف‑لاين ⇒ يُشار إليه بـ clientRef لا id */
  offline?: boolean;
  customerClientRef?: string;
  /** لحظة ضغط أيقونة البدء — ISO */
  startedAt: string;
}

export function getVisitTimer(): VisitTimer | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    return v && typeof v.customerId === 'string' && typeof v.startedAt === 'string' ? (v as VisitTimer) : null;
  } catch {
    return null;
  }
}

export function setVisitTimer(t: VisitTimer): void {
  localStorage.setItem(KEY, JSON.stringify(t));
}

export function clearVisitTimer(): void {
  localStorage.removeItem(KEY);
}

/** الثواني المنقضية منذ البدء (0 كحدّ أدنى؛ 0 أيضاً لطابع فاسد) */
export function elapsedSec(startedAt: string, now: number = Date.now()): number {
  const t = new Date(startedAt).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.round((now - t) / 1000));
}

/** «12:05» أو «1:03:20» — يطابق formatDuration في الخادم لعرض متّسق */
export function fmtElapsed(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}
