/**
 * دبوس العميل في تطبيق الإدارة على الجوال (/m) — زرّ «التقط موقعي الحالي» في MCustomerForm.tsx
 * (تدقيق «لا يعمل إلا بـ٣٠٠» البند PIN-6، ٧ نوفمبر ٢٠٢٦ — قرار المالك «أصلح الخلل فقط»).
 *
 * كان الزرّ يأخذ أوّل قراءة getCurrentPosition أيّاً كانت دقّتها — داخل المحلّ قراءة شبكة ±٨٠–١٥٠ م — ولا يعرضها،
 * ويرسلها رابطاً ‎?q=lat,lng‎ فيُحفظ دبوسٌ مُزاح، فتُرفض بعده بصمة المندوب الصادقة عند الباب بنطاق ٥٠ وتُقبل بـ٣٠٠.
 * الآن:
 *  • القراءة من المراقبة الدقيقة المشتركة مع تطبيق المندوب (precisePinFix في rep/punchFix.ts): بلا مخبّأ وأدقّ ما وصل.
 *  • الدقّة تُعرض «±N م» ودرجتها من pinAccuracyLevel المشتركة، وما كان أضعف من PIN_WARN_M (٣٠ م) أو بلا دقّة معلومة
 *    يُنبَّه عليه — تنبيهٌ لا منع، والمدير يعيد الالتقاط أو يلغيه.
 *  • الإحداثيات تُرسَل صريحةً lat/lng لا رابطاً يحلّه الخادم، وبلا التقاطٍ لا يُرسل شيء فيبقى المحفوظ كما هو
 *    (تعديل اسم العميل أو عنوانه لا يحرّك دبوسه أبداً).
 *  • الشاشة بلا خانة رابط أصلاً، فلا يطغى رابطٌ ملصوق على الالتقاط (PIN-3 في تطبيق المندوب) — الالتقاط هو المصدر الوحيد.
 *
 * لا يغيّر شيئاً مما يقبله الخادم أو يرفضه: صرفٌ بلا DOM ولا شبكة، والتنفيذ في MCustomerForm.tsx.
 */

import { PIN_WARN_M, pinAccuracyLevel, type PinFix } from '../rep/punchFix';
import { REP_PIN_TEXTS } from '../rep/repCustomerPin';

/** الدبوس الملتقط — شكل PinFix المشترك: accuracy = نصف قطر الدقّة بالأمتار كما يعطيه الجهاز، وnull إن لم تُعرف */
export type MPin = PinFix;

/** شكل قراءة المراقبة كما تصل — الدقّة قد تغيب أو تأتي null */
export type MPinFixLike = { lat: number; lng: number; accuracy?: number | null } | null | undefined;

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** قراءة المراقبة إلى دبوس — أو null لقراءةٍ فاسدة (خارج المدى أو (0،0)) فلا تُحفظ إحداثياتٌ عبثية */
export function mPinFromFix(fix: MPinFixLike): MPin | null {
  if (!fix || !finite(fix.lat) || !finite(fix.lng)) return null;
  if (Math.abs(fix.lat) > 90 || Math.abs(fix.lng) > 180) return null;
  if (fix.lat === 0 && fix.lng === 0) return null;
  // دقّةٌ سالبة أو غير عددية = غير معلومة (لا تُعرض «±-5 م» ولا تُعامل دقيقة)
  const accuracy = finite(fix.accuracy) && fix.accuracy >= 0 ? fix.accuracy : null;
  return { lat: fix.lat, lng: fix.lng, accuracy };
}

/** الدقّة بالأمتار للعرض والحكم معاً (فلا يُعرض «±30» ويُنبَّه عليه) — مقرّبة ولا تقلّ عن ١، وnull = غير معلومة */
export function mPinAccuracyM(pin: MPin | null | undefined): number | null {
  if (!pin || pin.accuracy == null || !finite(pin.accuracy) || pin.accuracy < 0) return null;
  return Math.max(1, Math.round(pin.accuracy));
}

/**
 * درجة الدقّة: درجات pinAccuracyLevel المشتركة (good ≤ ٢٠ · fair ≤ ٣٠ · poor أضعف · coarse بالكيلومترات = «موقع تقريبي»)
 * محكومةً على الرقم المعروض نفسه — و«unknown» لدبوسٍ بلا دقّة معلومة
 */
export type MPinLevel = ReturnType<typeof pinAccuracyLevel> | 'unknown';
export function mPinLevel(pin: MPin): MPinLevel {
  const m = mPinAccuracyM(pin);
  return m == null ? 'unknown' : pinAccuracyLevel(m);
}

/** يُنبَّه المدير قبل الحفظ: أضعف من PIN_WARN_M أو بلا دقّة معلومة — وما ضمن ٣٠ م بلا تنبيه */
export const mPinWarns = (level: MPinLevel): boolean => level === 'poor' || level === 'coarse' || level === 'unknown';

/**
 * نصّ التنبيه (مفتاح tr) بدرجته — {m} يُملأ بـPIN_WARN_M بعد الترجمة؛ null = لا تنبيه. نصوص تطبيق المندوب نفسها
 * (REP_PIN_TEXTS): المدير الذي يرى الشاشتين يقرأ التنبيه بصياغةٍ واحدة
 */
export function mPinWarnText(level: MPinLevel): string | null {
  if (level === 'coarse') return REP_PIN_TEXTS.coarse;
  if (level === 'poor') return REP_PIN_TEXTS.weak;
  if (level === 'unknown') return REP_PIN_TEXTS.unknown;
  return null;
}

/** حقول الحمولة: الإحداثيات صريحة لا رابط — ولا شيء بلا التقاط (فيبقى موقع العميل المحفوظ كما هو) */
export function mPinPayload(pin: MPin | null | undefined): { lat?: number; lng?: number } {
  return pin ? { lat: pin.lat, lng: pin.lng } : {};
}

/** نصّ فشل الالتقاط (مفتاح tr) بسبب المراقبة — no-geo / denied / وما سواهما (متعذّر أو انتهت المهلة) */
export function mPinFailText(reason: string): string {
  if (reason === 'no-geo') return 'جهازك لا يدعم تحديد الموقع';
  if (reason === 'denied') return 'تعذر تحديد الموقع فعل الإذن';
  return 'تعذر تحديد موقعك اقترب من نافذة او مكان مفتوح ثم اعد المحاولة';
}

export { PIN_WARN_M };
