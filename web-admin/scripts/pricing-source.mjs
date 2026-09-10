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
  // مطابق حرفياً لـ data.pricing.plans في الـCMS الحيّ (قِيس 10 سبتمبر 2026).
  // ثلاث باقات رقمية ولا باقة «حسب الطلب» — فلا تُضِف واحدة هنا ما لم تُضَف هناك،
  // وإلّا نشر أوّلُ انقطاعِ شبكةٍ أثناء البناء بنيةَ باقاتٍ لا وجود لها.
  plans: [
    { name: 'المبتدئة', price: '299', limit: 'حتى ٥ مناديب وإداري واحد' },
    { name: 'المتوسطة', price: '399', limit: 'حتى 10 مناديب و حسابين إداريين' },
    { name: 'الاحترافية', price: '599', limit: 'حتى ٢٠ مندوب و 5 إداريين' },
  ],
  whatsapp: '+966 58 183 5269',
};

/**
 * حدّ المناديب المستخرَج من نصّ حدّ الباقة، بعد توحيد الأرقام الهندية.
 *
 * لماذا لا شرطٌ يبحث عن ٥ أو ٢٠: كان gen-llms يصنّف الحدود بثلاثيّةٍ مبنيّة على
 * عالم الباقتين، فحدّ «حتى 10 مناديب» لا يحوي ٥ ولا ٢٠ فيسقط في الحالة الافتراضية
 * ويُعلَن «up to 20 reps» مقابل 399 ريالاً — في ملفٍّ تقرؤه محرّكات الذكاء وتقتبسه.
 * أي باقة رابعة تُضاف مستقبلاً تعمل هنا بلا تعديل.
 */
export const repsCap = (limit) => {
  const m = String(limit || '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .match(/\d+/);
  return m ? Number(m[0]) : null;
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
    /**
     * «٢٩٩ ر.س حتى ٥ مناديب، ٥٩٩ ر.س حتى ٢٠ مندوبًا (شامل ضريبة القيمة المضافة)»
     *
     * الأساس الضريبي **جزء من الملخّص نفسه** لا نصّ يُضاف في كل موضع: الملخّص
     * يظهر في ثلاثة عشر موضعاً (الوصف، JSON-LD، الأسئلة الشائعة، llms.txt،
     * الصفحة المُصيَّرة)، وإلحاقه هنا يجعل الأساس واحداً في كلّها بلا تضارب.
     */
    arSummary: numeric.map((p) => `${p.price} ر.س ${p.limit || ''}`.trim()).join('، ')
      + (numeric.length ? ' (شامل ضريبة القيمة المضافة)' : ''),
    /** «299 SAR / 599 SAR (VAT included)» */
    enSummary: numeric.map((p) => `${p.price} SAR`).join(' / ')
      + (numeric.length ? ' (VAT included)' : ''),
    /** الأرقام وحدها بلا ملاحظة ضريبية — لمواضع لا تحتمل جملة اعتراضية */
    arSummaryRaw: numeric.map((p) => `${p.price} ر.س ${p.limit || ''}`.trim()).join('، '),
    /** هل توجد باقة «حسب الطلب» لما فوق الحدّ الأعلى؟ */
    hasCustomTier: custom.length > 0,
    customTierName: custom[0]?.name || null,
    /**
     * الأساس الضريبي — أقرّه المالك في ٢٩ يوليو ٢٠٢٦: **الأسعار شاملة الضريبة**.
     *
     * لماذا هو حقل هنا لا نصّ يُكرَّر: الرقم يظهر في الصفحة وJSON-LD وllms.txt
     * والوصف الاجتماعي؛ صياغته في موضع واحد تمنع تضارباً بين موضعين. وغيابه
     * أصلاً كان عيباً حقيقياً — مشترٍ سعودي يرى «٢٩٩ ر.س» يفترض أنها ما سيدفعه،
     * ومعظم مورّدي السوق يسعّرون قبل الضريبة فيقع الالتباس في غير مصلحتنا.
     */
    vatIncluded: true,
    arVat: 'شامل ضريبة القيمة المضافة',
    enVat: 'VAT included',
    frVat: 'TVA incluse',
  };
}
