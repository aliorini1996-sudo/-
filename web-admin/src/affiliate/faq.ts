// ============================================================================
// «الأسئلة الشائعة» (V2_SPEC §7) — ثابتةٌ بالخمس لغات في القاموس؛ هنا ترتيبها وحده (وحدةٌ نقيّة
// تُختبر في node بلا العميل ولا React).
// ============================================================================
import type { AxKey } from './i18n';

/** الأسئلة بترتيب المواصفة: العمولة · الحجز والتسوية · الإحالة · الحساب التجريبي · المطالبة الفائتة · الملف والصرف */
export const FAQ_KEYS: ReadonlyArray<{ q: AxKey; a: AxKey }> = [
  { q: 'faq.q.commission', a: 'faq.a.commission' },
  { q: 'faq.q.hold', a: 'faq.a.hold' },
  { q: 'faq.q.referral', a: 'faq.a.referral' },
  { q: 'faq.q.trial', a: 'faq.a.trial' },
  { q: 'faq.q.missed', a: 'faq.a.missed' },
  { q: 'faq.q.profile', a: 'faq.a.profile' },
];

