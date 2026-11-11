import { useEffect, useLayoutEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useSeo } from '../lib/seo';
import { useLang, type Lang } from '../i18n/lang';
import { COUNTRIES } from '../i18n/countries';
import { PUBLISHED, i18nPageAt } from '../i18n/i18nPublished';
import { renderI18nPage, vatMapFrom, type MarketingFile, type Rendered, type WorldCountries, type CountryPageFile } from '../i18n/marketingTemplate.mjs';
import { countryOfPageKey, type I18nPage } from '../i18n/i18nRoutes.mjs';

/**
 * صفحات الطبقة التسويقية متعددة اللغات (spec-b §٦.٢) — مكوّن واحد لكل مسارات I18N_PAGES.
 *
 * يرسم HTML القالب المشترك (marketingTemplate.mjs) **حرفياً** كما حقنه prerender في #root، فما يراه الزائر بعد
 * الإقلاع هو ما قرأه الزاحف قبله. الصفحة نفسها صغيرة وتُحمَّل فوراً؛ أما ملف لغتها وجدول الدول فكسولان
 * (حزمة لكل لغة)، وأثناء تحميلهما يُعرض المحتوى المُصيَّر المحفوظ (window.__fsSsr) فلا يومض شيء.
 *
 * الروابط داخل الصفحة `<a>` عادية عمداً: كل تنقّل تحميل كامل لصفحة مُصيَّرة بلغتها.
 */
const files = import.meta.glob<{ default: MarketingFile }>('../i18n/marketing/*.json'); // حزمة لكل لغة
// حزمة لكل صفحة دولة **منشورة**: الملفات المشتقة المجرّدة وحدها (scripts/import-country-i18n.mjs) — لا src/content أبداً:
// نسخه الحرفية تحمل notes وreview والدول المستثناة، وما يُجمَّع هنا يُخدم علناً (verify-i18n G-assets يحرسه)
const countryFiles = import.meta.glob<{ default: CountryPageFile }>('../i18n/registry/country-content/*.json');
const VAT_BY_CODE = vatMapFrom(COUNTRIES);
const OG_LOCALE: Record<Lang, string> = { ar: 'ar_SA', en: 'en_US', fr: 'fr_FR', tr: 'tr_TR', zh: 'zh_CN' };

function setOgLocale(value: string) {
  let el = document.head.querySelector('meta[property="og:locale"]') as HTMLMetaElement | null;
  if (!el) { el = document.createElement('meta'); el.setAttribute('property', 'og:locale'); document.head.appendChild(el); }
  el.setAttribute('content', value);
}

/**
 * المحتوى المُصيَّر لهذه الصفحة كما حفظه main.tsx قبل أن يمسحه createRoot — للصفحة نفسها وحدها،
 * وبلا رابط واتساب النصّي (data-wa-static) الذي يحقنه prerender: الزرّ العائم يحلّ محلّه بعد الإقلاع،
 * فبقاؤه هنا يجعله يختفي لحظة اكتمال التحميل.
 */
function ssrHoldHtml(page: I18nPage): string {
  if (typeof window === 'undefined') return '';
  const s = (window as unknown as { __fsSsr?: { path: string; html: string } }).__fsSsr;
  if (!s || i18nPageAt(s.path)?.path !== page.path) return '';
  return s.html.replace(/\s*<a\b[^>]*\bdata-wa-static\b[^>]*>[\s\S]*?<\/a>/g, '');
}

function Hold({ page }: { page: I18nPage }) {
  const hold = ssrHoldHtml(page);
  if (hold) return <div data-ssr-hold="" lang={page.hreflang} dir={page.dir} dangerouslySetInnerHTML={{ __html: hold }} />;
  return <div className="min-h-screen" lang={page.hreflang} dir={page.dir} />;
}

/**
 * useSeo هنا وحده لا أثناء التحميل: الخطّاف يحذف وسوم hreflang المُصيَّرة (data-seo-alt) في كل استدعاء،
 * فاستدعاؤه قبل جاهزية العنقود يُسقطها. بلا locale: useSeo يعرف لغات الموقع الخمس وحدها، ولغة المستند
 * يضبطها المكوّن الأب.
 */
function Done({ r }: { r: Rendered }) {
  useSeo({
    title: r.title, description: r.description, canonical: r.canonical, alternates: r.alternates, jsonLd: r.jsonld,
    image: 'https://fieldsa.net/og-image.png',
  });
  return <div data-ssr-hold="" lang={r.lang} dir={r.dir} dangerouslySetInnerHTML={{ __html: r.html }} />;
}

export default function I18nMarketingPage() {
  const { pathname } = useLocation();
  const page = i18nPageAt(pathname); // لا يكون null: المسار مسجَّل من I18N_PAGES نفسها
  const [state, setState] = useState<{ path: string; r: Rendered } | null>(null);

  useEffect(() => {
    if (!page) return;
    let live = true;
    (async () => {
      try {
        let file: MarketingFile | undefined;
        if (page.pageKey !== 'languages') {
          const load = files[`../i18n/marketing/${page.code}.json`];
          if (!load) throw new Error(`لا ملف محتوى للغة ${page.code}`);
          file = (await load()).default;
        }
        const world = page.pageKey === 'countries'
          ? ((await import('../i18n/world-countries.json')).default as unknown as WorldCountries)
          : undefined;
        const cc = countryOfPageKey(page.pageKey);
        let country: CountryPageFile | undefined;
        if (cc) {
          const loadCountry = countryFiles[`../i18n/registry/country-content/${cc}.${page.code}.json`];
          if (!loadCountry) throw new Error(`لا ملف لصفحة الدولة ${cc} (${page.code})`);
          country = (await loadCountry()).default;
        }
        const r = renderI18nPage({ page, reg: PUBLISHED, file, world, vatByCode: VAT_BY_CODE, country });
        if (live) setState({ path: page.path, r });
      } catch (err) {
        // تعذّر تحميل حزمة اللغة (شبكة أو نشر جديد): يبقى المحتوى المُصيَّر معروضاً بدل صفحة فارغة
        console.error('[i18n] تعذّر رسم الصفحة', page.path, err);
      }
    })();
    return () => { live = false; };
  }, [page]);

  const r = state && page && state.path === page.path ? state.r : null;

  // لغة المستند واتجاهه وog:locale للصفحة: lang.ts لا يمسّها على مسارات الطبقة (prerender كتبها صحيحة)،
  // وعند مغادرة الصفحة تعود إلى لغة الواجهة كما يكتبها applyDoc، ثم يضبطها useSeo للصفحة التالية.
  useLayoutEffect(() => {
    if (!page) return;
    const el = document.documentElement;
    el.lang = page.hreflang;
    el.dir = page.dir;
    setOgLocale(r?.ogLocale ?? PUBLISHED.locales.find((l) => l.code === page.code)?.ogLocale ?? 'en_US');
    return () => {
      const L = useLang.getState().lang;
      el.lang = L;
      el.dir = L === 'ar' ? 'rtl' : 'ltr';
      setOgLocale(OG_LOCALE[L] || 'ar_SA');
    };
  }, [page, r]);

  if (!page) return null;
  if (!r) return <Hold page={page} />;
  return <Done r={r} />;
}
