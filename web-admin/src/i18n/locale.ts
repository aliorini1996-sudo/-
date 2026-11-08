// توطين معتمد على المسار: /en إنجليزية، /fr فرنسية، /tr تركية، /zh صينية، وغيرها عربية — لفهرسة دولية صحيحة + hreflang
import type { Lang } from './lang';
import { PUBLISHED } from './i18nPublished';
import { legacyClusterKey, newClusterMembers } from './i18nRoutes.mjs';

export const SITE_ORIGIN = 'https://fieldsa.net';

// بادئة المسار لكل لغة (العربية بلا بادئة لأنها الأصل)
// كل بادئة ثلاثة أحرف بالضبط — basePath أدناه تعتمد slice(3)
const PREFIX: Record<Lang, string> = { ar: '', en: '/en', fr: '/fr', tr: '/tr', zh: '/zh' };

// يشتقّ اللغة من المسار
export function localeFromPath(pathname: string): Lang {
  if (pathname === '/en' || pathname.startsWith('/en/')) return 'en';
  if (pathname === '/fr' || pathname.startsWith('/fr/')) return 'fr';
  if (pathname === '/tr' || pathname.startsWith('/tr/')) return 'tr';
  if (pathname === '/zh' || pathname.startsWith('/zh/')) return 'zh';
  return 'ar';
}

// المسار العربي الأساسي (بدون بادئة /en أو /fr)
export function basePath(pathname: string): string {
  if (pathname === '/en' || pathname === '/fr' || pathname === '/tr' || pathname === '/zh') return '/';
  if (pathname.startsWith('/en/') || pathname.startsWith('/fr/') || pathname.startsWith('/tr/') || pathname.startsWith('/zh/')) return pathname.slice(3); // يزيل بادئة اللغة (3 أحرف)
  return pathname;
}

/**
 * الصفحات التسويقية المُصيَّرة بثلاث لغات (ع/إ/فر) — مطابقة لـI18N_ROUTES في scripts/gen-sitemap.mjs
 * وصفحات INFO في scripts/prerender.mjs. الرئيسية و«احجز اجتماعاً» بخمس لغات (نصوص MeetingPage خماسية
 * ومُصيَّرة بلغاتها كلها)، وما عداهما بلا نسخة تركية ولا صينية.
 */
const TRILINGUAL_PATHS = new Set(['/about', '/contact', '/calculator', '/invoice-generator', '/pricing', '/terms', '/privacy', '/service-agreement', '/blog']);
const FIVE_LANG_PATHS = new Set(['/', '/meeting']);

const trimSlash = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p) || '/';

/**
 * اللغات التي توجد بها الصفحة فعلاً (مُصيَّرة ومعلنة في الخريطة) — القيمة الافتراضية لـseoUrls.
 *
 * لماذا: كانت seoUrls تعلن بدائل ع/إ/فر/تر/صيني لكل صفحة، فصفحة ميزة عربية وحدها كانت تعلن
 * /en/مزايا/… و/tr/… وهي غير موجودة (تخدم قوقعة الرئيسية). وبعد أن صار التصيير المسبق يسِم
 * عنقوده بـdata-seo-alt يستبدله useSeo بما تعيده هذه الدالة — فيجب أن تطابق الخريطة حرفياً.
 * المدوّنة تمرّر لغاتها صراحةً (حسب وجود النسخة)؛ وكل ما سوى ذلك عربي فقط.
 */
export function availableLangs(arPath: string): Lang[] {
  const p = trimSlash(arPath);
  if (FIVE_LANG_PATHS.has(p)) return ['ar', 'en', 'fr', 'tr', 'zh'];
  if (TRILINGUAL_PATHS.has(p)) return ['ar', 'en', 'fr'];
  return ['ar'];
}

/**
 * نماذج بلا صفحة مُصيَّرة (noindex) لكن لها مسار بلغات بنصوص تلك اللغات: لا تدخل hreflang ولا الخريطة،
 * ويصلها الرابط بلغة الزائر. نموذج الاشتراك/عرض السعر ثلاثي النصوص (التركية والصينية كانتا تعرضان
 * الإنجليزية تحت /tr/ و/zh/) — فمساراه بهما أُزيلا ويقع رابطهما على النسخة الإنجليزية.
 */
const FORM_ROUTE_LANGS: Record<string, Lang[]> = { '/subscribe-request': ['ar', 'en', 'fr'] };

/**
 * اللغات التي يملك فيها المسار صفحةً حقيقية في الراوتر (App.tsx) — أوسع من availableLangs بالنماذج
 * وبمقالات المدوّنة (/blog/:slug مسجَّل عربياً وإنجليزياً وفرنسياً، ووجود المقال نفسه بلغته شأن صفحته).
 * كل مسار تحت /en و/fr و/tr و/zh في App.tsx يجب أن تعلنه هذه الدالة لتلك اللغة (langs.test.ts يفرضه):
 * مسار بلا صفحة بلغته كان يُخدَم قوقعة الرئيسية العربية بـcanonical «/» (/tr/about وأخواتها).
 */
export function routeLangs(arPath: string): Lang[] {
  const p = trimSlash(arPath);
  const seo = availableLangs(p);
  if (seo.length > 1) return seo;
  if (FORM_ROUTE_LANGS[p]) return FORM_ROUTE_LANGS[p];
  if (p.startsWith('/blog/')) return ['ar', 'en', 'fr'];
  return seo;
}

/**
 * رابط المسار باللغة المطلوبة إن كانت له صفحة بها، وإلا نظيره الإنجليزي، وإلا العربي —
 * فلا يقود رابط داخلي إلى مسار غير مسجَّل (كان `/en/signup` و`/tr/pricing` يسقطان إلى الرئيسية العربية).
 * للتبديل بين اللغات استعمل switchLocalePath (يذهب إلى رئيسية اللغة بدل النسخة الإنجليزية).
 */
export function pathForLocale(pathname: string, locale: Lang): string {
  const ar = basePath(pathname);
  const langs = routeLangs(ar);
  const target: Lang = langs.includes(locale) ? locale : langs.includes('en') ? 'en' : 'ar';
  if (target === 'ar') return ar;
  const prefix = PREFIX[target];
  return ar === '/' ? prefix : prefix + ar;
}

/**
 * وجهة مبدّل اللغة: الصفحة نفسها باللغة المختارة إن وُجدت بها، وإلا رئيسية تلك اللغة —
 * مَن اختار التركية على صفحة ميزة عربية يصل إلى /tr/ لا إلى صفحة غير موجودة.
 */
export function switchLocalePath(pathname: string, locale: Lang): string {
  return routeLangs(basePath(pathname)).includes(locale) ? pathForLocale(pathname, locale) : pathForLocale('/', locale);
}

/**
 * x-default للعنقود: الإنجليزية إن كانت فيه، وإلا العربية، وإلا أول لغة فيه.
 * القاعدة نفسها في scripts/prerender.mjs (hreflangFor) وscripts/gen-sitemap.mjs (alt)، ويفرضها verify-sitemap.
 * الباحث بلغة لا نسخة لها (إسبانية، إندونيسية…) يذهب إلى الإنجليزية لا إلى صفحة عربية؛ والعربي يطابق `ar` فلا يتأثر.
 */
export function xDefaultLang(langs: readonly Lang[]): Lang | undefined {
  return langs.includes('en') ? 'en' : langs.includes('ar') ? 'ar' : langs[0];
}

/**
 * روابط canonical + hreflang البديلة لصفحة ما (بناءً على مسارها العربي).
 *
 * - langs: اللغات الموجودة فعلاً (الافتراضي availableLangs). البدائل تُعلن لها وحدها، ومعها x-default
 *   (xDefaultLang: الإنجليزية إن وُجدت وإلا العربية). صفحة بلغة واحدة لا بدائل لها (قائمة فارغة) —
 *   كما في الخريطة وHTML المُصيَّر.
 * - canonical: رابط لغة الصفحة نفسها دائماً (سلوك ثابت لا يتغيّر بتغيّر langs).
 * - الطبقة متعددة اللغات: الرئيسية و/about و/contact **بلا langs صريحة** يتمدّد عنقودها بصفحات اللغات الجديدة
 *   المنشورة المكافئة (newClusterMembers من السجل المنشور) بين القدامى وx-default — بالترتيب نفسه الذي يكتبه
 *   prerender وgen-sitemap (clusterAlternates)، فلا يعيد React العنقود إلى خمس لغات بعد الإقلاع. هذا المصدر
 *   الواحد لـLandingPage وInfoPage وContactPage. من يمرّر langs صراحةً (المدوّنة) لا يتأثر، و/meeting لا يتمدّد.
 *   بلا لغة جديدة منشورة يبقى الناتج كما كان حرفياً.
 */
export function seoUrls(arPath: string, locale: Lang, langs?: readonly Lang[]): {
  canonical: string;
  alternates: { hreflang: string; href: string }[];
} {
  const explicit = langs !== undefined;
  const L = langs ?? availableLangs(arPath);
  const suffix = arPath === '/' ? '' : arPath;
  const arUrl = SITE_ORIGIN + (arPath === '/' ? '/' : arPath);
  const urls: { lang: Lang; hreflang: string; href: string }[] = [
    { lang: 'ar', hreflang: 'ar', href: arUrl },
    { lang: 'en', hreflang: 'en', href: SITE_ORIGIN + '/en' + suffix },
    { lang: 'fr', hreflang: 'fr', href: SITE_ORIGIN + '/fr' + suffix },
    { lang: 'tr', hreflang: 'tr', href: SITE_ORIGIN + '/tr' + suffix },
    // zh-Hans لا zh المجرَّدة: المحتوى بالمبسّطة تحديداً، وجوجل يدعم وسم النصّ
    { lang: 'zh', hreflang: 'zh-Hans', href: SITE_ORIGIN + '/zh' + suffix },
  ];
  const canonical = (urls.find((u) => u.lang === locale) || urls[0]).href;
  const present = urls.filter((u) => L.includes(u.lang));
  const key = explicit ? null : legacyClusterKey(arPath);
  const extra = key ? newClusterMembers(key, PUBLISHED) : [];
  if (present.length < 2) return { canonical, alternates: [] };
  const xd = xDefaultLang(present.map((u) => u.lang));
  return {
    canonical,
    alternates: [
      ...present.map(({ hreflang, href }) => ({ hreflang, href })),
      ...extra.map(({ hreflang, href }) => ({ hreflang, href })),
      { hreflang: 'x-default', href: (present.find((u) => u.lang === xd) || present[0]).href },
    ],
  };
}
