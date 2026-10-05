// توطين معتمد على المسار: /en إنجليزية، /fr فرنسية، /tr تركية، /zh صينية، وغيرها عربية — لفهرسة دولية صحيحة + hreflang
import type { Lang } from './lang';

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

// يحوّل المسار الحالي إلى نظيره باللغة المطلوبة (للتبديل بين اللغات عبر الرابط)
export function pathForLocale(pathname: string, locale: Lang): string {
  const ar = basePath(pathname);
  if (locale === 'ar') return ar;
  const prefix = PREFIX[locale];
  return ar === '/' ? prefix : prefix + ar;
}

/**
 * الصفحات التسويقية المُصيَّرة بثلاث لغات (ع/إ/فر) — مطابقة لـI18N_ROUTES في scripts/gen-sitemap.mjs
 * وصفحات INFO في scripts/prerender.mjs. الرئيسية وحدها بخمس لغات (التركية والصينية لها رئيسية فقط).
 */
const TRILINGUAL_PATHS = new Set(['/about', '/contact', '/calculator', '/invoice-generator', '/pricing', '/terms', '/privacy', '/service-agreement', '/blog']);

/**
 * اللغات التي توجد بها الصفحة فعلاً (مُصيَّرة ومعلنة في الخريطة) — القيمة الافتراضية لـseoUrls.
 *
 * لماذا: كانت seoUrls تعلن بدائل ع/إ/فر/تر/صيني لكل صفحة، فصفحة ميزة عربية وحدها كانت تعلن
 * /en/مزايا/… و/tr/… وهي غير موجودة (تخدم قوقعة الرئيسية). وبعد أن صار التصيير المسبق يسِم
 * عنقوده بـdata-seo-alt يستبدله useSeo بما تعيده هذه الدالة — فيجب أن تطابق الخريطة حرفياً.
 * المدوّنة تمرّر لغاتها صراحةً (حسب وجود النسخة)؛ وكل ما سوى ذلك عربي فقط.
 */
export function availableLangs(arPath: string): Lang[] {
  const p = arPath.length > 1 && arPath.endsWith('/') ? arPath.slice(0, -1) : arPath;
  if (p === '/' || p === '') return ['ar', 'en', 'fr', 'tr', 'zh'];
  if (TRILINGUAL_PATHS.has(p)) return ['ar', 'en', 'fr'];
  return ['ar'];
}

/**
 * روابط canonical + hreflang البديلة لصفحة ما (بناءً على مسارها العربي).
 *
 * - langs: اللغات الموجودة فعلاً (الافتراضي availableLangs). البدائل تُعلن لها وحدها، ومعها x-default
 *   إلى العربية. صفحة بلغة واحدة لا بدائل لها (قائمة فارغة) — كما في الخريطة وHTML المُصيَّر.
 * - canonical: رابط لغة الصفحة نفسها دائماً (سلوك ثابت لا يتغيّر بتغيّر langs).
 */
export function seoUrls(arPath: string, locale: Lang, langs: readonly Lang[] = availableLangs(arPath)): {
  canonical: string;
  alternates: { hreflang: string; href: string }[];
} {
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
  const present = urls.filter((u) => langs.includes(u.lang));
  if (present.length < 2) return { canonical, alternates: [] };
  return {
    canonical,
    alternates: [
      ...present.map(({ hreflang, href }) => ({ hreflang, href })),
      { hreflang: 'x-default', href: langs.includes('ar') ? arUrl : present[0].href },
    ],
  };
}
