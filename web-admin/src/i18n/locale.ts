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

// روابط canonical + hreflang البديلة لصفحة ما (بناءً على مسارها العربي) — عربي/إنجليزي/فرنسي/تركي/صيني
export function seoUrls(arPath: string, locale: Lang): {
  canonical: string;
  alternates: { hreflang: string; href: string }[];
} {
  const suffix = arPath === '/' ? '' : arPath;
  const arUrl = SITE_ORIGIN + (arPath === '/' ? '/' : arPath);
  const enUrl = SITE_ORIGIN + '/en' + suffix;
  const frUrl = SITE_ORIGIN + '/fr' + suffix;
  const trUrl = SITE_ORIGIN + '/tr' + suffix;
  const zhUrl = SITE_ORIGIN + '/zh' + suffix;
  const canonical = locale === 'en' ? enUrl : locale === 'fr' ? frUrl : locale === 'tr' ? trUrl : locale === 'zh' ? zhUrl : arUrl;
  return {
    canonical,
    alternates: [
      { hreflang: 'ar', href: arUrl },
      { hreflang: 'en', href: enUrl },
      { hreflang: 'fr', href: frUrl },
      { hreflang: 'tr', href: trUrl },
      // zh-Hans لا zh المجرَّدة: المحتوى بالمبسّطة تحديداً، وجوجل يدعم وسم النصّ
      { hreflang: 'zh-Hans', href: zhUrl },
      { hreflang: 'x-default', href: arUrl },
    ],
  };
}
