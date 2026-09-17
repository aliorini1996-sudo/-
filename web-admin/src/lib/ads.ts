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
 *
 * 5) **الوسم يُحمَّل عند فتح الصفحة التسويقية لا عند التحويل** (١٧ سبتمبر ٢٠٢٦).
 *    النسخة الأولى كانت تحمّله لحظة التحويل فقط، وجوجل يُسند التحويل عبر معرّف
 *    النقر (`gclid`/`gbraid`/`wbraid`) الذي لا يوجد إلا في **رابط الهبوط** ويحفظه
 *    الوسم في كوكي `_gcl_aw` لحظة قراءته. الزائر يهبط على `/pricing/?gclid=…`
 *    ثم يصل `/signup` بتنقّل داخلي فيختفي المعرّف ⇒ كل تحويل كان سيصل بلا نقرة.
 *    الآن `initAdsTag` يُستدعى من App.tsx، ويُحمّل الوسم مرّة واحدة على الصفحات
 *    التسويقية وحدها (قائمة السماح في `adsRoutes.ts`) — لا داخل لوحات الدخول.
 *
 * 6) **لا جمهور ولا تخصيص.** لا نستخدم قوائم إعادة الاستهداف، والتحويلات المحسّنة
 *    مطفأة في الحساب: `allow_ad_personalization_signals: false` في كل إعداد.
 *
 * 7) **لا Google Analytics هنا** (١٧ سبتمبر ٢٠٢٦). كان فرع GA4 يُحمَّل بمجرّد ضبط
 *    `VITE_GA_ID` فيضع كوكيز `_ga` لا تذكرها سياسة الخصوصية (القسمان ٦ و١٥) —
 *    فسطر إعداد واحد كان يجعل السياسة المنشورة كاذبة. إعادته تبدأ بتحديث السياسة
 *    بلغاتها الخمس، واختبار `adsTracking.test.ts` يُفشل فحص web-ci على GitHub إن عاد
 *    بدونها. ⚠️ لا يمنع النشر: بناء Render لا يشغّل الاختبارات ولا ينتظر نتيجة web-ci.
 */
import { isOptedOut } from './attribution';
import { isAdsTagRoute } from './adsRoutes';

type GtagFn = (...args: unknown[]) => void;
interface AdsWindow extends Window { dataLayer?: unknown[]; gtag?: GtagFn }

/** معرّف حساب Google Ads (AW-XXXXXXXXX). فارغ ⇒ الوحدة خاملة بالكامل. */
let ADS_ID = (import.meta.env?.VITE_ADS_ID as string | undefined)?.trim() || '';

/**
 * تسميات التحويل من واجهة Google Ads (صيغة `AW-123/AbC-D_efGh`).
 * تُضبط بعد إنشاء التحويلين في الحساب. غير المضبوط لا يُرسَل.
 */
let LABEL_SIGNUP = (import.meta.env?.VITE_ADS_LABEL_SIGNUP as string | undefined)?.trim() || '';
let LABEL_WHATSAPP = (import.meta.env?.VITE_ADS_LABEL_WA as string | undefined)?.trim() || '';

let loaded = false;

/**
 * للاختبارات فقط: المعرّفات تُقرأ من `import.meta.env` لحظة الاستيراد، وهي فارغة
 * دائماً تحت tsx — فبلا هذا المدخل لا يُختبر أيّ مسار والوسم مُفعَّل، وحذف حارس
 * المسار أو إعداد التخصيص يمرّ بصمت. يعيد حالة التحميل أيضاً.
 */
export function __setAdsConfigForTests(cfg: { adsId?: string; labelSignup?: string; labelWhatsApp?: string }): void {
  ADS_ID = cfg.adsId || '';
  LABEL_SIGNUP = cfg.labelSignup || '';
  LABEL_WHATSAPP = cfg.labelWhatsApp || '';
  loaded = false;
}

/** هل التتبّع مسموح وفعّال؟ (معرّف مضبوط + الزائر لم يرفض) */
export function adsEnabled(): boolean {
  return Boolean(ADS_ID) && !isOptedOut();
}

/**
 * دالّة `gtag` القياسية: تدفع كائن `arguments` نفسه إلى dataLayer.
 *
 * ⚠️ ليست مسألة أسلوب: gtag.js لا يعالج من dataLayer إلا كائنات Arguments، أمّا
 * المصفوفة (`(...args) => dataLayer.push(args)`) فيتجاهلها بصمت — فلا `config`
 * ولا كوكي نقر ولا تحويل، والصفحة تبدو سليمة تماماً. النسخة الأولى كانت كذلك.
 */
export function makeGtag(dataLayer: unknown[]): GtagFn {
  return function gtag() {
    // eslint-disable-next-line prefer-rest-params
    dataLayer.push(arguments);
  };
}

/** يحمّل وسم gtag مرّة واحدة ويضبطه. */
function ensureLoaded(): GtagFn | null {
  if (typeof window === 'undefined' || !adsEnabled()) return null;
  const w = window as AdsWindow;
  if (loaded && w.gtag) return w.gtag;
  try {
    w.dataLayer = w.dataLayer || [];
    w.gtag = w.gtag || makeGtag(w.dataLayer);

    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ADS_ID)}`;
    document.head.appendChild(s);

    w.gtag('js', new Date());
    // رابط الهبوط يُثبَّت لحظة الإعداد: الوسم يُحمَّل غير متزامن، وتنقّل داخلي أو
    // إعادة توجيه قبل وصوله قد يُسقط معرّف النقر من شريط العنوان.
    const page_location = window.location.href;
    // تعطيل التخصيص الإعلاني: نقيس التحويل ولا نبني جمهوراً — أقلّ ما يلزم للحملة.
    w.gtag('config', ADS_ID, { allow_ad_personalization_signals: false, page_location });
    loaded = true;
    return w.gtag;
  } catch { return null; }
}

/**
 * يُستدعى من App.tsx عند كل تغيّر مسار — آمن التكرار، والتحميل الفعلي مرّة واحدة.
 *
 * - صفحة تسويقية ⇒ يُحمّل الوسم (إن ضُبط المعرّف ولم يرفض الزائر) فيقرأ معرّف
 *   النقر من رابط الهبوط قبل أن يضيع بالتنقّل.
 * - مسار تطبيق أو بوابة خاصة ⇒ لا تحميل. وإن كان الوسم محمَّلاً من صفحة سابقة
 *   (تنقّل داخلي من الموقع إلى `/login` ثم `/app`) فوسم Ads وحده لا يرسل شيئاً
 *   عند التنقّل، ولا نطلق منه تحويلاً هناك (`fire` يفحص المسار).
 *
 * @returns هل الوسم محمَّل الآن لهذا المسار.
 */
export function initAdsTag(pathname: string): boolean {
  if (typeof window === 'undefined') return false;
  const allowed = isAdsTagRoute(pathname);
  if (!allowed) return false;
  return ensureLoaded() !== null;
}

/**
 * يُرسل تحويلاً وينتظر تأكيد الإرسال (أو مهلة) ثم ينفّذ `after`.
 * `after` تُنفَّذ **دائماً وبالضبط مرّة واحدة** — حتى لو حُجب الوسم أو تعطّل.
 */
function fire(label: string, params: Record<string, unknown>, after?: () => void, timeoutMs = 900): void {
  let done = false;
  const go = () => { if (done) return; done = true; try { after?.(); } catch { /* تجاهل */ } };
  // تحويل غير مضبوط أو مسار خارج الموقع التسويقي ⇒ لا تحميل ولا طلب شبكة إطلاقاً
  let onMarketing = false;
  try { onMarketing = typeof window !== 'undefined' && isAdsTagRoute(window.location.pathname); } catch { /* تجاهل */ }
  if (!label || !onMarketing) { go(); return; }
  const gtag = ensureLoaded();
  if (!gtag) { go(); return; }
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
