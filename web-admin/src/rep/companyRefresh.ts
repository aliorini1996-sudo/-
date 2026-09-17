/**
 * إعادة جلب إعدادات الشركة في تطبيق المندوب (Z5.0 / Z5.6a): عند العودة إلى التطبيق أو عودة الاتصال — كي لا يبقى هاتف مفتوح طوال
 * اليوم على كاش قديم (مثل نظام الفوترة بعد التفعيل). مرة كل 5 دقائق على الأكثر لكل جلسة (نقد الخطة 28: القاعدة هي العنق
 * الضيّق)، والنتيجة نفسها لكل الشركات — حداثة فقط.
 */
export const COMPANY_REFRESH_MIN_GAP_MS = 5 * 60 * 1000;

export function companyRefreshDue(lastFetchMs: number | null, nowMs: number, minGapMs: number = COMPANY_REFRESH_MIN_GAP_MS): boolean {
  return lastFetchMs === null || !Number.isFinite(lastFetchMs) || nowMs - lastFetchMs >= minGapMs;
}
