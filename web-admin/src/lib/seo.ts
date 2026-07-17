import { useEffect } from 'react';

// خطّاف SEO خفيف (بلا مكتبات) — يضبط وسوم <head> لكل صفحة لتحسين الظهور في جوجل.
// كل صفحة عامة تستدعيه فتُحدَّث العناوين/الوصف/canonical/OG عند التنقّل داخل SPA.
interface SeoInput {
  title: string;
  description?: string;
  keywords?: string;        // كلمات مفتاحية متعلّقة بخدمات الصفحة (مفصولة بفواصل)
  canonical?: string;       // الرابط الكامل https://fieldsa.net/...
  image?: string;           // صورة OG كاملة الرابط
  type?: 'website' | 'article';
  locale?: 'ar' | 'en' | 'fr'; // لغة الصفحة (og:locale + html lang)
  alternates?: { hreflang: string; href: string }[]; // روابط hreflang للنسخ اللغوية (دولي)
  jsonLd?: object;          // بيانات Schema.org منظّمة (Article/BreadcrumbList...)
}

function setMeta(attr: 'name' | 'property', key: string, content: string) {
  let el = document.head.querySelector(`meta[${attr}="${key}"]`) as HTMLMetaElement | null;
  if (!el) { el = document.createElement('meta'); el.setAttribute(attr, key); document.head.appendChild(el); }
  el.setAttribute('content', content);
}
function setLink(rel: string, href: string) {
  let el = document.head.querySelector(`link[rel="${rel}"]`) as HTMLLinkElement | null;
  if (!el) { el = document.createElement('link'); el.setAttribute('rel', rel); document.head.appendChild(el); }
  el.setAttribute('href', href);
}

/**
 * الشرطة المائلة في آخر الرابط **إلزامية** — ليست تجميلاً.
 *
 * الصفحات مُصيَّرة في مجلّدات (dist/blog/x/index.html)، وRender يخدمها فقط عند /blog/x/ ؛
 * أما /blog/x فتبتلعه قاعدة `/* → /index.html` فيُعيد قوقعة SPA فارغة بلا محتوى.
 * فإن أشار الـcanonical إلى النسخة بلا شرطة، نُرشد جوجل بأيدينا إلى الصفحة الفارغة.
 *
 * يُطبَّع هنا مركزياً: كل صفحة عامّة تمرّ عبر useSeo، فلا يُفلت رابط. (جُرّبت قواعد
 * rewrite في Render فأنتجت حلقة إعادة توجيه لا نهائية — لذا الحلّ في المصدر.)
 */
const canon = (url: string): string => {
  const m = url.match(/^(https?:\/\/[^/]+)(\/[^#?]*)?([#?].*)?$/);
  if (!m) return url;
  const origin = m[1];
  const p = m[2] || '/';
  const rest = m[3] || '';
  if (/\.[a-z0-9]{2,5}$/i.test(p)) return url;   // ملف بامتداد — لا شرطة
  return p.endsWith('/') ? `${origin}${p}${rest}` : `${origin}${p}/${rest}`;
};

export function useSeo({ title, description, keywords, canonical: rawCanonical, image, type = 'website', locale, alternates: rawAlternates, jsonLd }: SeoInput) {
  const canonical = rawCanonical ? canon(rawCanonical) : rawCanonical;
  const alternates = rawAlternates?.map((a) => ({ ...a, href: canon(a.href) }));
  useEffect(() => {
    document.title = title;
    setMeta('property', 'og:title', title);
    setMeta('name', 'twitter:title', title);
    setMeta('property', 'og:type', type);
    if (description) {
      setMeta('name', 'description', description);
      setMeta('property', 'og:description', description);
      setMeta('name', 'twitter:description', description);
    }
    if (keywords) setMeta('name', 'keywords', keywords);
    if (canonical) { setMeta('property', 'og:url', canonical); setLink('canonical', canonical); }
    if (image) { setMeta('property', 'og:image', image); setMeta('name', 'twitter:image', image); }
    if (locale) {
      setMeta('property', 'og:locale', locale === 'en' ? 'en_US' : locale === 'fr' ? 'fr_FR' : 'ar_SA');
      document.documentElement.lang = locale;
    }

    // روابط hreflang للنسخ اللغوية — تُزال القديمة وتُعاد كتابتها لكل صفحة
    document.head.querySelectorAll('link[rel="alternate"][data-seo-alt]').forEach((el) => el.remove());
    if (alternates) {
      for (const alt of alternates) {
        const el = document.createElement('link');
        el.setAttribute('rel', 'alternate');
        el.setAttribute('hreflang', alt.hreflang);
        el.setAttribute('href', alt.href);
        el.setAttribute('data-seo-alt', '1');
        document.head.appendChild(el);
      }
    }

    let script: HTMLScriptElement | null = null;
    if (jsonLd) {
      script = document.createElement('script');
      script.type = 'application/ld+json';
      script.setAttribute('data-seo-page', '1');
      script.textContent = JSON.stringify(jsonLd);
      document.head.appendChild(script);
    }
    return () => { if (script) script.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, description, keywords, canonical, image, type, locale, JSON.stringify(alternates), JSON.stringify(jsonLd)]);
}
