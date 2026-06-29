// توطين معتمد على المسار: المسارات تحت /en إنجليزية، وغيرها عربية — لفهرسة دولية صحيحة + hreflang
import type { Lang } from './lang';

export const SITE_ORIGIN = 'https://fieldsa.net';

// يشتقّ اللغة من المسار
export function localeFromPath(pathname: string): Lang {
  return pathname === '/en' || pathname.startsWith('/en/') ? 'en' : 'ar';
}

// المسار العربي الأساسي (بدون بادئة /en)
export function basePath(pathname: string): string {
  if (pathname === '/en') return '/';
  if (pathname.startsWith('/en/')) return pathname.slice(3); // يزيل "/en"
  return pathname;
}

// يحوّل المسار الحالي إلى نظيره باللغة المطلوبة (للتبديل بين العربية والإنجليزية عبر الرابط)
export function pathForLocale(pathname: string, locale: Lang): string {
  const ar = basePath(pathname);
  if (locale === 'ar') return ar;
  return ar === '/' ? '/en' : '/en' + ar;
}

// روابط canonical + hreflang البديلة لصفحة ما (بناءً على مسارها العربي)
export function seoUrls(arPath: string, locale: Lang): {
  canonical: string;
  alternates: { hreflang: string; href: string }[];
} {
  const suffix = arPath === '/' ? '' : arPath;
  const arUrl = SITE_ORIGIN + (arPath === '/' ? '/' : arPath);
  const enUrl = SITE_ORIGIN + '/en' + suffix;
  return {
    canonical: locale === 'en' ? enUrl : arUrl,
    alternates: [
      { hreflang: 'ar', href: arUrl },
      { hreflang: 'en', href: enUrl },
      { hreflang: 'x-default', href: arUrl },
    ],
  };
}
