/**
 * القائمة البيضاء السعرية — الحاجز الصلب.
 *
 * لماذا هذا الملف موجود أصلاً: سابقة Air Canada القضائية — الشركة مسؤولة قانوناً
 * عن أي سعر أو سياسة ينطق بها بوتها. لذلك الأسعار تُحقن في البرومبت من هنا،
 * ويُفحص كل ردّ قبل إرساله (guard.ts) فيُمنع أي رقم أو وعد خارج هذه القائمة.
 *
 * لا يُعدَّل هذا الملف إلا بقرار المالك. أي تغيير هنا = تغيير التزام تعاقدي.
 */

export interface Plan {
  id: string;
  name: string;
  priceSar: number;
  note?: string;
}

/** التسعير المعتمد — لكل شركة لا لكل مستخدم (تمايزنا المسوَّق) */
export const PLANS: Plan[] = [
  { id: 'basic', name: 'الباقة الأساسية', priceSar: 299, note: 'شاملة الضريبة' },
  { id: 'pro', name: 'الباقة المتقدّمة', priceSar: 599, note: 'شاملة الضريبة' },
];

/** العرض الترويجي الحالي — يُطفأ بتغيير active إلى false، ولا شيء آخر */
export const OFFER = {
  active: true,
  id: 'september-2026',
  name: 'عرض سبتمبر',
  pricePerRepSar: 20,
  endsAt: '2026-09-30',
  endsAtLabel: '30 سبتمبر',
} as const;

/** التجربة المجانية — الوعد الوحيد المسموح بشأن التفعيل */
export const TRIAL = { days: 10, requiresCard: false } as const;

/** السطر الوحيد المسموح لوصف العرض */
export function offerLine(): string {
  if (!OFFER.active) return '';
  return `${OFFER.name}: ${OFFER.pricePerRepSar} ريال لكل مندوب شهرياً — ساري حتى ${OFFER.endsAtLabel}`;
}

/** حساب تكلفة فريق العميل بالعرض الحالي */
export function priceForReps(reps: number): number {
  if (!OFFER.active) return PLANS[0].priceSar;
  return Math.max(0, Math.round(reps)) * OFFER.pricePerRepSar;
}

/** كل الأرقام المالية المسموح ظهورها في ردّ البوت */
export function allowedMoneyValues(maxReps = 200): Set<number> {
  const set = new Set<number>();
  PLANS.forEach((p) => set.add(p.priceSar));
  set.add(OFFER.pricePerRepSar);
  set.add(TRIAL.days);
  // حواصل ضرب العرض لأحجام الفرق المعقولة (البوت يحسب تكلفة الفريق)
  for (let r = 1; r <= maxReps; r++) set.add(r * OFFER.pricePerRepSar);
  return set;
}

/** عبارات ممنوعة قطعياً في أي ردّ يخرج لعميل */
export const FORBIDDEN_PHRASES: { pattern: RegExp; reason: string }[] = [
  { pattern: /المرحلة\s*(الثانية|٢|2)/i, reason: 'ادّعاء ZATCA المرحلة الثانية غير مبني' },
  { pattern: /phase\s*2/i, reason: 'ادّعاء ZATCA المرحلة الثانية غير مبني' },
  { pattern: /مرتبط(ة)?\s*(مع|ب)\s*(هيئة|زاتكا|الزكاة)/i, reason: 'ادّعاء ربط/تكامل مع الهيئة' },
  { pattern: /معتمد(ة)?\s*من\s*(هيئة|الزكاة|زاتكا)/i, reason: 'ادّعاء اعتماد رسمي' },
  { pattern: /خصم|تخفيض|مجان(اً|ا)\s*(لك|لكم)\s*(الشهر|شهر)/i, reason: 'وعد خصم خارج القائمة البيضاء' },
  { pattern: /نضمن|ضمان\s*استرداد|أضمن\s*لك/i, reason: 'ضمان غير معتمد' },
  { pattern: /خلال\s*\d+\s*(ساعة|ساعات|يوم|أيام)\s*(نسلّم|نجهّز|يكون جاهز)/i, reason: 'التزام بموعد تسليم' },
];
