import { useEffect } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { BrandIcon } from '../components/BrandLogo';
import LanguageToggle from '../components/LanguageToggle';
import { useLang, useDir, type Lang } from '../i18n/lang';
import { pathForLocale } from '../i18n/locale';
import { useSeo } from '../lib/seo';

/** الشرطة الأخيرة إلزامية في الروابط العامة: الصفحات مُصيَّرة مجلّدات (انظر canon في lib/seo.ts) */
const slash = (p: string) => (p.endsWith('/') ? p : `${p}/`);

/**
 * وسم robots للصفحة ما دامت معروضة، ويُستعاد ما كان عند المغادرة (نمط QuotePage وبوابة السفير).
 *
 * dropCanonical: تُرفع canonical وog:url ما دامت الصفحة معروضة ثم تُعاد. السبب: القوقعة
 * (index.html) تحمل canonical الرئيسية، فصفحة 404 تُبقيه تقول لجوجل إن الرابط المكسور نسخة
 * من الرئيسية — وهي الإشارة نفسها التي كان التحويل إلى «/» يصنعها.
 */
export function useNoindex(content = 'noindex, follow', dropCanonical = false) {
  useEffect(() => {
    const head = document.head;
    let meta = head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const created = !meta;
    const prevRobots = meta?.getAttribute('content') ?? null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'robots');
      head.appendChild(meta);
    }
    meta.setAttribute('content', content);

    const lifted: Element[] = [];
    if (dropCanonical) {
      head.querySelectorAll('link[rel="canonical"], meta[property="og:url"]').forEach((el) => {
        lifted.push(el);
        el.remove();
      });
    }
    return () => {
      if (created) meta?.remove();
      else if (prevRobots !== null) meta?.setAttribute('content', prevRobots);
      // تُعاد قبل تأثيرات الصفحة التالية (التنظيف يسبقها)، فيحدّثها useSeo هناك بدل أن يُنشئ نسخة ثانية
      for (const el of lifted) if (!el.isConnected) head.appendChild(el);
    };
  }, [content, dropCanonical]);
}

type Copy = { title: string; h1: string; lead: string; home: string; pricing: string; blog: string; features: string; sectors: string; contact: string; pathLabel: string };

const COPY: Record<'ar' | 'en' | 'fr', Copy> = {
  ar: {
    title: 'الصفحة غير موجودة | FieldSales',
    h1: 'الصفحة غير موجودة',
    lead: 'الرابط الذي فتحته غير موجود أو تغيّر مكانه. هذه أهم صفحات الموقع:',
    home: 'الرئيسية', pricing: 'الأسعار', blog: 'المدونة', features: 'المزايا', sectors: 'القطاعات', contact: 'تواصل معنا',
    pathLabel: 'الرابط المطلوب',
  },
  en: {
    title: 'Page not found | FieldSales',
    h1: 'This page does not exist',
    lead: 'The link you opened does not exist or has moved. Here are the main pages:',
    home: 'Home', pricing: 'Pricing', blog: 'Blog', features: 'Features', sectors: 'Sectors', contact: 'Contact us',
    pathLabel: 'Requested link',
  },
  fr: {
    title: 'Page introuvable | FieldSales',
    h1: 'Cette page n’existe pas',
    lead: 'Le lien ouvert n’existe pas ou a été déplacé. Voici les pages principales :',
    home: 'Accueil', pricing: 'Tarifs', blog: 'Blog', features: 'Fonctionnalités', sectors: 'Secteurs', contact: 'Contact',
    pathLabel: 'Lien demandé',
  },
};

/**
 * الأسعار والمدوّنة والتواصل مُصيَّرة بثلاث لغات (ع/إ/فر — availableLangs في i18n/locale.ts): روابطها
 * من /tr و/zh تقود للإنجليزية، أمّا الرئيسية نفسها فبلغات الموقع الخمس.
 */
const subPath = (arPath: string, lang: Lang) => slash(pathForLocale(arPath, lang === 'tr' || lang === 'zh' ? 'en' : lang));

/**
 * بادئات وحدة المطاعم المُزالة (317260f): كانت تسقط إلى المسار * فتتحوّل إلى «/»، ولها تطبيقات مثبّتة
 * (/pos · /kds) وروابط قديمة — فتبقى تحويلاً صريحاً إلى الرئيسية لا صفحة 404. هنا لا في جدول App.tsx:
 * كل <Route> هناك يلزمه قرار وسم إعلاني (adsTracking.test.ts)، وهذه ليست صفحات أصلاً.
 */
const LEGACY_TO_HOME = /^\/(restaurant|app-r|pos|pos-login|kds)(\/|$)/;

/**
 * صفحة 404 حقيقية بدل تحويل كل رابط مجهول إلى «/».
 * التحويل كان يُفهرس عنوان الرئيسية على كل مسار مكسور؛ هنا noindex وبلا canonical، وروابط لأهم الصفحات.
 * ما يراه الزاحف بلا JavaScript لا يتغيّر (القوقعة نفسها) — الإصلاح الخادمي في قواعد Render.
 */
export default function NotFoundPage() {
  const { pathname } = useLocation();
  if (LEGACY_TO_HOME.test(pathname)) return <Navigate to="/" replace />;
  return <NotFoundView pathname={pathname} />;
}

function NotFoundView({ pathname }: { pathname: string }) {
  const lang = useLang((s) => s.lang);
  const dir = useDir();
  const t = COPY[lang === 'ar' || lang === 'fr' ? lang : 'en'];

  useSeo({ title: t.title, description: t.lead, locale: lang });
  useNoindex('noindex, follow', true);

  let shown = pathname;
  try { shown = decodeURI(pathname); } catch { /* مسار بترميز معطوب: يُعرض كما هو */ }

  const links: [string, string][] = [
    [slash(pathForLocale('/', lang)), t.home],
    [subPath('/pricing', lang), t.pricing],
    [subPath('/blog', lang), t.blog],
    // صفحات المزايا والقطاعات عربية وحدها — رابطٌ لها من سياق أجنبي إشارةٌ مضلِّلة
    ...(lang === 'ar' ? ([['/مزايا/', t.features], ['/قطاعات/', t.sectors]] as [string, string][]) : []),
    [subPath('/contact', lang), t.contact],
  ];

  return (
    <div dir={dir} className="min-h-screen bg-[#FAF7F0] text-[#1F1A13] flex flex-col" style={{ fontFamily: "'Noto Kufi Arabic', 'IBM Plex Sans', system-ui, sans-serif" }}>
      <header className="border-b border-[#E9E1D3] bg-[#FAF7F0]/85">
        <div className="max-w-5xl mx-auto px-5 h-16 flex items-center justify-between">
          <Link to={links[0][0]} className="flex items-center gap-2.5">
            <BrandIcon size={34} />
            <span style={{ fontFamily: "'IBM Plex Serif', serif", fontWeight: 600, letterSpacing: '-0.3px' }} className="text-xl">
              <span className="text-[#1F1A13]">Field</span> <span className="text-[#E15A30]">Sales</span>
            </span>
          </Link>
          <LanguageToggle />
        </div>
      </header>

      <main className="flex-1 max-w-2xl w-full mx-auto px-5 py-16 text-center">
        <div className="text-6xl font-extrabold text-[#E15A30] tracking-tight" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>404</div>
        <h1 className="text-3xl font-extrabold mt-4">{t.h1}</h1>
        <p className="text-[#6E6557] mt-3 leading-relaxed">{t.lead}</p>
        <p className="text-xs text-[#9A8F7E] mt-2">
          {t.pathLabel}: <span dir="ltr" className="font-mono break-all">{shown}</span>
        </p>

        <nav aria-label={t.h1} className="mt-8 grid grid-cols-2 sm:grid-cols-3 gap-3">
          {links.map(([to, label]) => (
            <Link key={to} to={to}
              className="flex items-center justify-between gap-2 bg-white border border-[#E9E1D3] rounded-xl px-4 py-3 text-sm font-semibold hover:border-[#E15A30] hover:text-[#E15A30] transition-colors">
              {label}
              <ArrowLeft size={15} className={dir === 'rtl' ? '' : 'rotate-180'} />
            </Link>
          ))}
        </nav>
      </main>

      <footer className="border-t border-[#E9E1D3] py-6 text-center text-xs text-[#9A8F7E]">
        © {new Date().getFullYear()} Field Sales — fieldsa.net
      </footer>
    </div>
  );
}
