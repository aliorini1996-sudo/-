/**
 * واتساب الدعم الرسمي لعملائنا (شركات المنصة) — الرقم نفسه في affiliate/format.ts (SUPPORT_WHATSAPP، V2_SPEC §7).
 * نسخةٌ صغيرة هنا لا استيراد: affiliate/format.ts يجرّ قاموس البوابة كلّه إلى حزمة صفحة الدخول. واختبار
 * loginRecovery.test.ts يفرض تطابق الرقمين فلا يفترقان.
 *
 * رابط wa.me مباشر لا `/api/analytics/go/wa` (WhatsAppFab): صفحات الدخول والاستعادة لا تُسجَّل فيها زيارات.
 */
export const SUPPORT_WHATSAPP = '966506061608';

export function supportWhatsappUrl(text: string): string {
  return `https://wa.me/${SUPPORT_WHATSAPP}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}
