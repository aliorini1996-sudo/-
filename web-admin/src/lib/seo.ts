import { useEffect } from 'react';

// خطّاف SEO خفيف (بلا مكتبات) — يضبط وسوم <head> لكل صفحة لتحسين الظهور في جوجل.
// كل صفحة عامة تستدعيه فتُحدَّث العناوين/الوصف/canonical/OG عند التنقّل داخل SPA.
interface SeoInput {
  title: string;
  description?: string;
  canonical?: string;       // الرابط الكامل https://fieldsa.net/...
  image?: string;           // صورة OG كاملة الرابط
  type?: 'website' | 'article';
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

export function useSeo({ title, description, canonical, image, type = 'website', jsonLd }: SeoInput) {
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
    if (canonical) { setMeta('property', 'og:url', canonical); setLink('canonical', canonical); }
    if (image) { setMeta('property', 'og:image', image); setMeta('name', 'twitter:image', image); }

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
  }, [title, description, canonical, image, type, JSON.stringify(jsonLd)]);
}
