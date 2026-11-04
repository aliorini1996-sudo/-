/**
 * إعادة جلب إعدادات الشركة في تطبيق المندوب (Z5.0 / Z5.6a): عند العودة إلى التطبيق أو عودة الاتصال — كي لا يبقى هاتف مفتوح طوال
 * اليوم على كاش قديم (مثل نظام الفوترة بعد التفعيل). مرة كل 5 دقائق على الأكثر لكل جلسة (نقد الخطة 28: القاعدة هي العنق
 * الضيّق)، والنتيجة نفسها لكل الشركات — حداثة فقط.
 */
export const COMPANY_REFRESH_MIN_GAP_MS = 5 * 60 * 1000;
/** نبضة الفحص الدوري أثناء فتح التطبيق — companyRefreshDue يحرس ألا يتجاوز الجلب مرة كل 5 دقائق */
export const COMPANY_REFRESH_TICK_MS = 60 * 1000;

export function companyRefreshDue(lastFetchMs: number | null, nowMs: number, minGapMs: number = COMPANY_REFRESH_MIN_GAP_MS): boolean {
  return lastFetchMs === null || !Number.isFinite(lastFetchMs) || nowMs - lastFetchMs >= minGapMs;
}

/**
 * «نصوص المطبوعات» تصل المستند المفتوح (D-G3): المستند يحمل نسخة الشركة لحظة فتحه، فإعادة طباعته أو مشاركته بعد تعديل المدير
 * كانت تخرج بالنصوص القديمة. حين تتجدّد الشركة تُستبدل نسختها في المستند المفتوح — الفاتورة وسند القبض، وكشف الحساب الذي صارت
 * ترويسته تتبع النصوص المحفوظة (C-G7)، فجلبُ الشركة الخلفي عند فتحه (D-G4) يصله هو أيضاً. الشركة الفارغة
 * (أوف‑لاين بلا كاش) لا تمحو نسخة المستند. والهوية نفسها تعود حين لا تغيير — فلا إعادة رسم بلا داعٍ.
 */
export function withLiveCompany<T extends { kind: string; company?: unknown }>(doc: T, company: T['company'] | null | undefined): T {
  if (company == null) return doc;
  if (doc.company === company) return doc;
  return { ...doc, company } as T;
}

/**
 * فتح مستند (DocumentResult) يُعلن نفسه بحدث على window — فتطبيق الإدارة على الجوال (/m) يجلب إعدادات الشركة في الخلفية بفجوة
 * الثلاثين ثانية (كفتح المستند في تطبيق المندوب)، فلا تبقى طباعته على نصوص ما قبل الحفظ حتى دورة الدقائق الخمس. بلا window
 * (اختبارات أو تصيير خادم) لا شيء.
 */
export const DOC_OPEN_EVENT = 'fieldsales:doc-open';

export function announceDocOpen(): void {
  try {
    const w = (globalThis as { window?: EventTarget }).window;
    if (w && typeof w.dispatchEvent === 'function') w.dispatchEvent(new Event(DOC_OPEN_EVENT));
  } catch { /* لا يمنع فتح المستند */ }
}

/** فتح مستند يطلب الشركة في الخلفية (D-G4) — مرة كل 30 ثانية على الأكثر، لا ينتظره أي مسار طباعة */
export const DOC_OPEN_REFRESH_GAP_MS = 30 * 1000;

export function docOpenRefreshDue(lastFetchMs: number | null, nowMs: number): boolean {
  return companyRefreshDue(lastFetchMs, nowMs, DOC_OPEN_REFRESH_GAP_MS);
}
