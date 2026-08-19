import { useLocation } from 'react-router-dom';
import { anonId, isOptedOut } from '../lib/attribution';
import { trackWhatsApp } from '../lib/ads';

/**
 * زرّ المحادثة العائم — قناة التحويل المقصودة.
 *
 * قرارات تصميمية مقصودة:
 * - `<a>` لا `<button>`: يعمل بلا جافاسكربت، ويحترم فتح تبويب جديد ونسخ الرابط.
 * - يمرّ عبر `/api/analytics/go/wa` لا `wa.me` مباشرة: واتساب لا ينقل المُحيل،
 *   فالمحوّل يسجّل مرجع الصفحة ويولّد رمزاً يصل داخل نصّ الرسالة ⇒ تُعرف الصفحة
 *   التي أنتجت المحادثة فعلاً.
 * - `ref` **مشتقّ من المسار آلياً** لا مكتوب يدوياً في كل صفحة — فلا يُنسى ولا يتضارب.
 * - خصائص منطقية (`inset-inline-end`) لا left/right ⇒ ينقلب مع RTL بلا شرط لغوي.
 *
 * 🔴 هذا زرّ يبدأ به **العميل** المحادثة. لا رسائل مبتدأة من طرفنا إطلاقاً —
 *    بلاغ سبام واحد يوقف الرقم ومعه كل مسار التحويل.
 */

/**
 * مسارات **التطبيق** وحدها بلا زرّ. قرار المالك (٢٩ يوليو ٢٠٢٦): الزرّ على كل
 * صفحات الموقع التسويقي، ولا شيء منه داخل التطبيق.
 *
 * لماذا التطبيق مستثنى: الرقم رقم مبيعات Field Sales لا رقم دعم الشركة
 * المشتركة. ظهوره داخل لوحة شركة عميلة يجعل موظفيها يراسلوننا بدل مراسلة
 * إدارتهم.
 *
 * `/signup` أُزيل من القائمة: لا حساب بعد ⇒ هو آخر خطوة في القمع التسويقي،
 * والزائر المتعثّر في النموذج هو أولى من يحتاج قناة محادثة. أمّا `/login`
 * و`/verify-email` فيبقيان مستثنيين لأن صاحبهما عميل قائم لا زائر.
 *
 * حدّ `(\/|$)` ليس تجميلاً: بدونه يبتلع `rep` مسارَ `/restaurant` التسويقي
 * فيختفي الزرّ من صفحة هبوط كاملة بصمت.
 */
// `m` (تطبيق الإدارة على الجوال) بحدّ نهاية — كي لا يلتقط مساراً تسويقياً يبدأ بالحرف نفسه
const HIDDEN_ON = /^\/(app|app-r|pos|pos-login|kds|platform|owner|login|verify-email|rep|m)(\/|$)/;

/**
 * ref من المسار: /pricing/ ⇒ pricing · /blog/x/ ⇒ blog-x · / ⇒ home
 *
 * الفكّ (`decodeURIComponent`) إلزامي لا تجميل: `location.pathname` يصل
 * **مُرمَّزاً** للمسارات العربية (`/%D9%82%D8%B7...`)، ثم يرمّزه
 * `URLSearchParams` مرّةً ثانية فيصير `%25D9%2582...`. عندها يقصّ حدّ الـ٤٨
 * حرفاً داخل الترميز نفسه، فتخرج **كل** صفحات `/قطاعات/*` بمرجع واحد
 * متطابق — وينهار إسناد سبع صفحات قطاعات وثماني صفحات نماذج إلى دلو واحد.
 * قِيس فعلياً: ٣ صفحات قطاعات ⇒ مرجع واحد.
 */
export function refFromPath(path: string): string {
  let p = (path || '/').split('?')[0];
  try { p = decodeURIComponent(p); } catch { /* ترميز تالف — نُبقيه كما هو */ }
  p = p.replace(/\/+$/, '') || '/';
  if (p === '/') return 'home';
  return p.replace(/^\/+/, '').replace(/\//g, '-').slice(0, 48) || 'home';
}

/**
 * أصل الـAPI — **نفس التعبير في src/api/client.ts** لا مسار نسبيّ ثابت.
 *
 * كان الرابط مكتوباً `/api/analytics/go/wa` نسبياً، فيقع على fieldsa.net لا
 * على api.fieldsa.net. وقاعدة SPA على الموقع الثابت (`/* → /index.html`)
 * تبتلع المسار وتُرجع صفحة التطبيق بالرمز 200 — فالزرّ **لا يحوّل إلى واتساب
 * إطلاقاً**، يفتح تبويباً فارغاً. قِيس على الإنتاج: fieldsa.net/api/… ⇒ 200
 * text/html، وapi.fieldsa.net/api/… ⇒ 302 إلى wa.me.
 *
 * يُقرأ داخل الدالّة لا في نطاق الوحدة: `import.meta.env` بناءُ Vite ولا وجود
 * له في node، وقراءته أعلى الملف تُسقط اختبار refFromPath.
 */
function apiBase(): string {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  const root = env?.VITE_API_URL;
  return root ? `${root.replace(/\/+$/, '')}/api` : '/api';
}

/** رابط المحادثة لأي مسار — يُستخدم في الأزرار السياقية داخل الصفحات أيضاً */
export function waHref(path: string, extra?: { lang?: string }): string {
  const params = new URLSearchParams({ ref: refFromPath(path), p: path });
  const a = isOptedOut() ? null : anonId();
  if (a) params.set('a', a);
  if (extra?.lang) params.set('l', extra.lang);
  return `${apiBase()}/analytics/go/wa?${params.toString()}`;
}

export default function WhatsAppFab() {
  const { pathname } = useLocation();
  if (HIDDEN_ON.test(pathname)) return null;

  // النصّ يتبع لغة الصفحة لا لغة ثابتة — الزائر الإنجليزي يقرأ الإنجليزية
  const docLang = typeof document !== 'undefined' ? document.documentElement.lang : 'ar';
  const label = docLang === 'en' ? 'Chat with us on WhatsApp'
    : docLang === 'fr' ? 'Discutez avec nous sur WhatsApp'
    : 'تحدّث معنا على واتساب';

  return (
    <a
      href={waHref(pathname, { lang: docLang || 'ar' })}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      // تحويل «محادثة واتساب» — القناة الثانية مع غياب بوابة الدفع. لا نمنع الانتقال
      // ولا ننتظره: الرابط يفتح تبويباً جديداً فالصفحة تبقى حيّة ويكتمل البيكسل.
      onClick={() => trackWhatsApp(refFromPath(pathname))}
      data-wa-fab
      className="wa-fab"
    >
      {/* SVG مضمَّن: لا طلب شبكة ولا مكتبة أيقونات ⇒ صفر أثر على الأداء */}
      <svg className="wa-fab__icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
        <path d="M17.47 14.38c-.3-.15-1.75-.86-2.02-.96-.27-.1-.47-.15-.67.15-.2.3-.77.96-.94 1.16-.17.2-.35.22-.65.07-.3-.15-1.25-.46-2.38-1.47-.88-.78-1.48-1.75-1.65-2.05-.17-.3-.02-.46.13-.61.14-.14.3-.35.45-.53.15-.18.2-.3.3-.5.1-.2.05-.38-.02-.53-.08-.15-.67-1.6-.92-2.2-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.38-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.22 3.08c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.69.63.71.23 1.36.2 1.87.12.57-.08 1.75-.71 2-1.4.25-.7.25-1.29.17-1.41-.07-.13-.27-.2-.57-.35z" />
        <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.46 1.32 4.96L2 22l5.25-1.38a9.86 9.86 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm0 18.13h-.01a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.11.82.83-3.04-.2-.31a8.17 8.17 0 0 1-1.26-4.36c0-4.54 3.7-8.24 8.24-8.24 2.2 0 4.27.86 5.82 2.42a8.19 8.19 0 0 1 2.41 5.83c0 4.54-3.7 8.21-8.24 8.21z" />
      </svg>
      {/* aria-hidden: العنوان في aria-label أصلاً، وتكراره يجعل قارئ الشاشة
          ينطق الجملة مرّتين. هذا للعين لا للأذن. */}
      <span className="wa-fab__label" aria-hidden="true">{label}</span>
    </a>
  );
}
