/**
 * أسماء قنوات الزيارة بالعربية للوحة المالك.
 *
 * المفتاح هو القيمة التي يخزّنها الخادم في `visits.channel`
 * (backend/src/services/attribution.ts · و`whatsapp_click` من محوّل واتساب).
 * قيمة غير معروفة تُعرض كما هي بدل أن تختفي — قناة جديدة على الخادم تظهر فوراً
 * ولو بلا اسم عربي بعد.
 */
export const VISIT_CHANNEL_LABELS: Record<string, string> = {
  paid_search: 'بحث مدفوع (إعلانات جوجل)',
  paid_social: 'إعلانات مواقع التواصل',
  organic: 'بحث عضوي',
  ai_generative: 'محركات الذكاء الاصطناعي',
  social: 'مواقع التواصل (غير ممولة)',
  referral: 'إحالة من موقع آخر',
  direct: 'زيارة مباشرة',
  email: 'البريد الإلكتروني',
  directory: 'أدلة البرمجيات',
  community: 'المجتمعات والمنتديات',
  app_store: 'متاجر التطبيقات',
  whatsapp_click: 'نقرة واتساب',
};

export function visitChannelLabel(channel: string): string {
  return VISIT_CHANNEL_LABELS[channel] ?? channel;
}
