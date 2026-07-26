/**
 * مصدر واحد لبيانات التسعير والتواصل في كل ما يُصيَّر للزواحف.
 *
 * لماذا: الأسعار تُحرَّر من لوحة المالك وتُخزَّن في محتوى الموقع (CMS)، لا في المستودع —
 * فأي رقم يُكتب يدوياً في سكربتات البناء ينزاح صامتاً عن الحقيقة. حدث ذلك فعلاً: بقي
 * «125 ر.س لكل حساب» منشوراً في JSON-LD وllms.txt والنصّ المُصيَّر بينما الأسعار الحيّة
 * 299/599. الحلّ أن يقرأ البناءُ من نفس المصدر الذي يقرأه الزائر.
 *
 * السقوط الآمن: عند تعذّر الشبكة تُستخدم القيم الاحتياطية أدناه (تُطابق الـCMS وقت الكتابة)
 * كي لا ينكسر البناء — ويبقى فحص `verify-pricing.mjs` حارساً على المخرَج.
 */

const CMS_API = 'https://api.fieldsa.net/api/site-content';

// احتياطي مطابق للـCMS (يُحدَّث عند أي تغيير تسعير معتمد)
const FALLBACK = {
  plans: [
    { name: 'المبتدئة', price: '299', limit: 'حتى ٥ مناديب' },
    { name: 'الاحترافية', price: '599', limit: 'حتى ٢٠ مندوبًا' },
    { name: 'المؤسسات', price: 'حسب الطلب', limit: 'مناديب غير محدودين' },
  ],
  whatsapp: '+966 58 183 5269',
};

/** أرقام فقط — لبناء رابط wa.me */
export const waDigits = (v) => String(v || '').replace(/[^0-9]/g, '');

/** هل قيمة السعر رقمية (بخلاف «حسب الطلب»)؟ */
const isNumeric = (p) => /^\d+$/.test(String(p || '').trim());

export async function loadPricing() {
  let data = null;
  try {
    const r = await fetch(CMS_API, { signal: AbortSignal.timeout(8000) });
    data = (await r.json())?.data ?? null;
  } catch { /* شبكة متعذّرة — نكمل بالاحتياطي */ }

  const plans = data?.pricing?.plans?.length ? data.pricing.plans : FALLBACK.plans;
  const whatsapp = data?.contact?.whatsapp || data?.social?.whatsapp || FALLBACK.whatsapp;
  const live = !!data?.pricing?.plans?.length;

  const numeric = plans.filter((p) => isNumeric(p.price));
  const prices = numeric.map((p) => Number(p.price)).sort((a, b) => a - b);
  const custom = plans.filter((p) => !isNumeric(p.price)); // «حسب الطلب»

  return {
    live,
    plans,
    whatsapp,
    waLink: `https://wa.me/${waDigits(whatsapp)}`,
    low: prices[0] ?? 299,
    high: prices[prices.length - 1] ?? 599,
    /** «٢٩٩ ر.س حتى ٥ مناديب و٥٩٩ ر.س حتى ٢٠ مندوبًا» */
    arSummary: numeric.map((p) => `${p.price} ر.س ${p.limit || ''}`.trim()).join('، '),
    /** «299 SAR (up to 5 reps), 599 SAR (up to 20 reps)» */
    enSummary: numeric.map((p) => `${p.price} SAR`).join(' / '),
    /** هل توجد باقة «حسب الطلب» لما فوق الحدّ الأعلى؟ */
    hasCustomTier: custom.length > 0,
    customTierName: custom[0]?.name || null,
  };
}
