/**
 * تتبّع تحويلات Google Ads — طبقة رقيقة فوق gtag.
 *
 * لماذا وُجدت (١٩ أغسطس ٢٠٢٦): الموقع بلا GA4 ولا gtag إطلاقاً، فإطلاق أي حملة
 * مدفوعة كان سيكون **إنفاقاً أعمى**: لا نعرف أي كلمة جلبت تجربة، ولا يستطيع جوجل
 * التحسين لأنه لا يستقبل إشارة تحويل.
 *
 * قرارات تصميمية مقصودة:
 *
 * 1) **لا يُحمَّل شيء قبل ضبط المعرّف.** حساب الإعلانات لم يُنشأ بعد، فالوحدة تبقى
 *    خاملة تماماً (صفر طلب شبكة، صفر كوكي) حتى تُضبط `VITE_ADS_ID`. هكذا نبني
 *    السبّاكة اليوم ونُوصّلها بسطر إعداد واحد يوم الإطلاق — بلا لمس الكود.
 *
 * 2) **تحترم رفض التتبّع** عبر `isOptedOut()` نفسها التي يحترمها الإسناد الداخلي
 *    (DNT · Sec-GPC · اختيار صريح). لا يجوز أن يكون طرفنا الأول أكثر تهذيباً من
 *    وسم جوجل على الصفحة نفسها.
 *
 * 3) **`event_callback` إلزاميّ لا تجميل** في تحويل التسجيل: صفحة التسجيل تنتقل
 *    فوراً بـ`window.location.replace`، والانتقال يقتل طلب البيكسل المعلّق —
 *    فيضيع التحويل الأهمّ صامتاً. النمط: انتظر تأكيد الإرسال أو مهلة قصيرة، ثم انتقل.
 *
 * 4) **فشل الوسم لا يوقف المستخدم أبداً.** كل شيء داخل try/catch وبمهلة، فحاجب
 *    إعلانات أو شبكة بطيئة لا تمنع صاحب الشركة من دخول لوحته.
 */
import { isOptedOut } from './attribution';

type GtagFn = (...args: unknown[]) => void;
interface AdsWindow extends Window { dataLayer?: unknown[]; gtag?: GtagFn }

/** معرّف حساب Google Ads (AW-XXXXXXXXX). فارغ ⇒ الوحدة خاملة بالكامل. */
const ADS_ID = (import.meta.env?.VITE_ADS_ID as string | undefined)?.trim() || '';
/** معرّف GA4 اختياري (G-XXXXXXX) — يُحمَّل مع الوسم نفسه إن ضُبط. */
const GA_ID = (import.meta.env?.VITE_GA_ID as string | undefined)?.trim() || '';

/**
 * تسميات التحويل من واجهة Google Ads (صيغة `AW-123/AbC-D_efGh`).
 * تُضبط بعد إنشاء التحويلين في الحساب. غير المضبوط لا يُرسَل.
 */
const LABEL_SIGNUP = (import.meta.env?.VITE_ADS_LABEL_SIGNUP as string | undefined)?.trim() || '';
const LABEL_WHATSAPP = (import.meta.env?.VITE_ADS_LABEL_WA as string | undefined)?.trim() || '';

let loaded = false;

/** هل التتبّع مسموح وفعّال؟ (معرّف مضبوط + الزائر لم يرفض) */
export function adsEnabled(): boolean {
  return Boolean(ADS_ID || GA_ID) && !isOptedOut();
}

/** يحمّل وسم gtag مرّة واحدة وعند الحاجة فقط. */
function ensureLoaded(): GtagFn | null {
  if (typeof window === 'undefined' || !adsEnabled()) return null;
  const w = window as AdsWindow;
  if (loaded && w.gtag) return w.gtag;
  try {
    w.dataLayer = w.dataLayer || [];
    const gtag: GtagFn = (...args: unknown[]) => { w.dataLayer!.push(args); };
    w.gtag = w.gtag || gtag;

    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ADS_ID || GA_ID)}`;
    document.head.appendChild(s);

    w.gtag('js', new Date());
    // تعطيل التخصيص الإعلاني: نقيس التحويل ولا نبني جمهوراً — أقلّ ما يلزم للحملة.
    if (ADS_ID) w.gtag('config', ADS_ID, { allow_ad_personalization_signals: false });
    if (GA_ID) w.gtag('config', GA_ID, { anonymize_ip: true });
    loaded = true;
    return w.gtag;
  } catch { return null; }
}

/**
 * يُرسل تحويلاً وينتظر تأكيد الإرسال (أو مهلة) ثم ينفّذ `after`.
 * `after` تُنفَّذ **دائماً وبالضبط مرّة واحدة** — حتى لو حُجب الوسم أو تعطّل.
 */
function fire(label: string, params: Record<string, unknown>, after?: () => void, timeoutMs = 900): void {
  let done = false;
  const go = () => { if (done) return; done = true; try { after?.(); } catch { /* تجاهل */ } };
  const gtag = ensureLoaded();
  if (!gtag || !label) { go(); return; }
  try {
    const timer = window.setTimeout(go, timeoutMs); // شبكة بطيئة ⇒ لا نحبس المستخدم
    gtag('event', 'conversion', {
      send_to: label,
      ...params,
      event_callback: () => { window.clearTimeout(timer); go(); },
    });
  } catch { go(); }
}

/**
 * تحويل «بدء تجربة» — الإشارة الأساسية للحملة.
 * @param after يُستدعى بعد تأكيد الإرسال (أو المهلة) — مرّر إليه الانتقال للوحة.
 */
export function trackSignup(after?: () => void): void {
  fire(LABEL_SIGNUP, { value: 1, currency: 'SAR' }, after);
}

/** تحويل «بدء محادثة واتساب» — القناة الثانية للتحويل مع غياب بوابة الدفع. */
export function trackWhatsApp(ref?: string): void {
  fire(LABEL_WHATSAPP, { value: 1, currency: 'SAR', ...(ref ? { ref } : {}) });
}
