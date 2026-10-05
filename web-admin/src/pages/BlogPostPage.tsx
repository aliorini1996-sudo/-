import { useEffect, useState } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft, Clock, Calendar, Share2, Linkedin, Facebook, Twitter, MessageCircle, Link2, Check } from 'lucide-react';
import { normalizeContent, postView, readMinutesOf, lastModifiedOf } from '../blog/posts';
import { useBlog } from '../blog/useBlog';
import * as catalog from '../blog/seo/catalog.mjs';
// @ts-ignore -- لا ملف تعريف للوحدة بعد (consolidate.d.mts)؛ الأنواع مثبّتة بالتحويل أدناه
import * as consolidateMod from '../blog/consolidate.mjs';
// @ts-ignore -- لا ملف تعريف للوحدة بعد (extractFaq.d.mts)؛ الأنواع مثبّتة بالتحويل أدناه
import * as faqMod from '../blog/extractFaq.mjs';
// @ts-ignore -- لا ملف تعريف للوحدة بعد (clusters.d.mts)؛ الأنواع مثبّتة بالتحويل أدناه
import * as clustersMod from '../blog/clusters.mjs';
import { useLang, type Lang } from '../i18n/lang';
import { seoUrls } from '../i18n/locale';
import { useSeo } from '../lib/seo';
import LanguageToggle from '../components/LanguageToggle';

type FaqItem = { q: string; a: string };
type FaqProblem = (pair: FaqItem) => string | null;
type Exists = (slug: string, L: string) => boolean;
// catalog.d.mts لا يصرّح بعد بهذه الأعضاء (canonicalSlug/isIndexable وmodified) — موجودة في catalog.mjs
const { getArticle, canonicalSlug, isIndexable } = catalog as unknown as {
  getArticle: typeof catalog.getArticle;
  canonicalSlug: (slug: string) => string;
  isIndexable: (cc: string | null, L: string) => boolean;
};
// المصدر الواحد للدمج (P3) وللأسئلة الظاهرة (P2) — نفسه في prerender.mjs فلا يتغيّر canonical ولا FAQPage بعد الإقلاع
const { existsWith, consolidatedTarget, consolidatedUrl } = consolidateMod as {
  existsWith: (manual: { slug: string; en?: { title?: string } }[]) => Exists;
  consolidatedTarget: (slug: string, L: string, exists?: Exists) => string | null;
  consolidatedUrl: (target: string, L: string) => string;
};
const { extractFaq, faqProblemWith } = faqMod as {
  extractFaq: (html: string, opts?: { problem?: FaqProblem }) => FaqItem[];
  faqProblemWith: (rules: unknown) => FaqProblem;
};
type RelatedLink = { href: string; anchor: string };
// «اقرأ أيضاً» ولاحقة العنوان من المصدر نفسه الذي يصيّره prerender.mjs (P4/P7) — فلا تتغيّر الروابط ولا العنوان بعد الإقلاع
const { relatedFor, RELATED_TITLE, blogTitle } = clustersMod as {
  relatedFor: (slug: string, L: 'ar' | 'en', posts: { slug: string; date?: string; title?: string; en?: { title?: string } }[], exists: Exists) => RelatedLink[];
  RELATED_TITLE: { ar: string; en: string };
  blogTitle: (title: string) => string;
};

/**
 * المحتوى المُصيَّر لهذا المسار كما حفظه main.tsx قبل أن يمسحه createRoot (E2). يُعرض أثناء جلب مقالات
 * CMS بدل شاشة تحميل فارغة، فلا يختفي المقال الذي يقرؤه الزائر ثم يعود. للمسار الذي صُيِّر له وحده.
 */
function ssrHoldHtml(): string {
  const s = (window as unknown as { __fsSsr?: { path: string; html: string } }).__fsSsr;
  return s && s.path === window.location.pathname ? s.html : '';
}
/** كاتب المقال وناشره: المنظّمة المعرَّفة في كتلة القالب (index.html) بمعرّف ثابت */
const ORG_REF = { '@id': 'https://fieldsa.net/#organization' };

// شريط مشاركة المقال على منصّات التواصل — يزيد الانتشار الاجتماعي والزيارات
function ShareBar({ url, title, label }: { url: string; title: string; label: { share: string; copy: string } }) {
  const [copied, setCopied] = useState(false);
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(title);
  const links = [
    { label: 'WhatsApp', Icon: MessageCircle, href: `https://wa.me/?text=${t}%20${u}`, color: '#25D366' },
    { label: 'X', Icon: Twitter, href: `https://twitter.com/intent/tweet?text=${t}&url=${u}`, color: '#1F1A13' },
    { label: 'LinkedIn', Icon: Linkedin, href: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`, color: '#0A66C2' },
    { label: 'Facebook', Icon: Facebook, href: `https://www.facebook.com/sharer/sharer.php?u=${u}`, color: '#1877F2' },
  ];
  return (
    <div className="flex items-center gap-2 flex-wrap mt-8 pt-6 border-t border-[#E9E1D3]">
      <span className="text-xs font-semibold text-[#6E6557] flex items-center gap-1.5"><Share2 size={14} /> {label.share}</span>
      {links.map(l => (
        <a key={l.label} href={l.href} target="_blank" rel="noreferrer" title={l.label} aria-label={l.label}
          className="w-9 h-9 rounded-lg flex items-center justify-center text-white hover:opacity-90 transition-opacity" style={{ background: l.color }}>
          <l.Icon size={16} />
        </a>
      ))}
      <button onClick={() => { navigator.clipboard?.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="w-9 h-9 rounded-lg flex items-center justify-center bg-[#EDE7DB] text-[#6E6557] hover:bg-[#E2D9C8] transition-colors" title={label.copy} aria-label={label.copy}>
        {copied ? <Check size={16} className="text-[#1E7A52]" /> : <Link2 size={16} />}
      </button>
    </div>
  );
}

// صفحة مقال — عربي على /blog/:slug ، إنجليزي على /en/blog/:slug ، فرنسي على /fr/blog/:slug
// تدعم المقالات المكتوبة يدوياً (ع/إ) والمقالات المولَّدة برمجياً لكل الدول العربية (ع/إ/فر) + hreflang + Article JSON-LD
export default function BlogPostPage() {
  const { slug } = useParams();
  const lang = useLang((s) => s.lang); // ar | en | fr (مشتقّة من المسار)
  const { getPost, isLoading, posts } = useBlog();
  const hand = getPost(slug || '');
  // مصنِّف أسئلة المقال اليدوي (قواعد حارس الادّعاءات) يُحمَّل كسولاً: أنماطه بنظرة خلفية يرفضها Safari
  // قبل 16.4، فلو دخل الحزمة الرئيسية لسقط الموقع كله هناك. إن تعذّر تحميله غابت FAQPage وحدها.
  const [faqProblem, setFaqProblem] = useState<FaqProblem | null>(null);
  const needsFaqRules = !!hand;
  useEffect(() => {
    if (!needsFaqRules || faqProblem) return;
    let alive = true;
    import('../../scripts/claims-rules.mjs')
      .then((rules) => { if (alive) setFaqProblem(() => faqProblemWith(rules)); })
      .catch(() => { /* متصفح لا يدعم الأنماط: بلا FAQPage للمقال اليدوي */ });
    return () => { alive = false; };
  }, [needsFaqRules, faqProblem]);
  const rtl = lang === 'ar';
  const prefix = lang === 'ar' ? '' : `/${lang}`;
  const tr = (ar: string, en: string, fr: string) => (lang === 'ar' ? ar : lang === 'en' ? en : fr);

  // مقال يدوي إنجليزي غير متوفّر لهذه اللغة الإنجليزية → عد للنسخة العربية
  const handUnavailableEn = hand && lang === 'en' && !hand.en;

  // اختر المصدر: مقال يدوي (ع/إ) أو مقال SEO مولّد (ع/إ/فر) — التركية تسقط للإنجليزية (لا مدونة تركية)
  const blogLang = (lang === 'tr' || lang === 'zh' ? 'en' : lang);
  const useHand = !!hand && lang !== 'fr' && !handUnavailableEn;
  const seo = useHand ? null : getArticle(slug || '', blogLang);

  type View = { title: string; description: string; keywords: string; contentHtml: string; date: string; modified: string; readMinutes: number };
  let view: View | null = null;
  if (useHand && hand) {
    const v = postView(hand, lang === 'en' ? 'en' : 'ar');
    // مدة القراءة من النص لا من القيمة اليدوية، وتاريخ التعديل من المقال نفسه (كما في prerender والخريطة)
    view = { title: v.title, description: v.description, keywords: v.keywords, contentHtml: v.contentHtml, date: hand.date, modified: lastModifiedOf(hand) || hand.date, readMinutes: readMinutesOf(v.contentHtml) };
  } else if (seo) {
    const modified = (seo as typeof seo & { modified?: string }).modified || seo.date;
    view = { title: seo.title, description: seo.description, keywords: seo.keywords, contentHtml: seo.contentHtml, date: seo.date, modified, readMinutes: seo.readMinutes };
  }

  // canonical + hreflang مطابقان لما يُصيَّر (prerender.mjs) وللخريطة، فلا يغيّرهما الإقلاع:
  // - مقال مولَّد: canonical إلى صفحته الجامعة إن كان مدموجاً، وعنقود ع/إ/فر (بلا إنجليزية مقلَّمة)
  //   للصفحة الأساسية القابلة للفهرسة وحدها.
  // - مقال يدوي: ع/إ حسب وجود النسخة، والنسخة المدموجة (P3) canonical إلى مقالها الغني بلا عنقود.
  let canonical: string;
  let alternates: { hreflang: string; href: string }[] = [];
  const exists = existsWith(posts);
  if (seo) {
    const cSlug = canonicalSlug(slug || '');
    const cc = seo.countryCode;
    const langs: Lang[] = isIndexable(cc, 'en') ? ['ar', 'en', 'fr'] : ['ar', 'fr'];
    const u = seoUrls(`/blog/${cSlug}`, lang, langs);
    canonical = u.canonical;
    if (cSlug === slug && isIndexable(cc, lang)) alternates = u.alternates;
  } else {
    const L = lang === 'en' ? 'en' : 'ar';
    const target = hand ? consolidatedTarget(hand.slug, L, exists) : null;
    if (target) {
      canonical = consolidatedUrl(target, L);
    } else {
      const langs: Lang[] = (hand && hand.en ? (['ar', 'en'] as Lang[]) : (['ar'] as Lang[]))
        .filter((x) => !(hand && consolidatedTarget(hand.slug, x, exists)));
      const u = seoUrls(`/blog/${slug}`, lang, langs);
      canonical = u.canonical;
      alternates = u.alternates;
    }
  }

  // الأسئلة الظاهرة: المولَّد من بياناته، واليدوي مستخرَج من نصّه بالدالة نفسها التي يستعملها prerender
  const faq: FaqItem[] = seo ? seo.faq : view && faqProblem ? extractFaq(normalizeContent(view.contentHtml), { problem: faqProblem }) : [];

  const ogImage = seo ? seo.image : 'https://fieldsa.net/og-image.png';
  const homeUrl = `https://fieldsa.net${prefix || ''}`;
  const blogUrl = `https://fieldsa.net${prefix}/blog`;
  // بيانات منظّمة موحّدة (@graph): Article + مسار تنقّل + أسئلة شائعة → نتائج غنية بالثلاث لغات
  const jsonLd = view ? {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        headline: view.title,
        description: view.description,
        inLanguage: lang,
        datePublished: view.date,
        dateModified: view.modified,
        image: ogImage,
        author: ORG_REF,
        publisher: ORG_REF,
        mainEntityOfPage: canonical,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: tr('الرئيسية', 'Home', 'Accueil'), item: homeUrl },
          { '@type': 'ListItem', position: 2, name: tr('المدونة', 'Blog', 'Blog'), item: blogUrl },
          { '@type': 'ListItem', position: 3, name: view.title, item: canonical },
        ],
      },
      ...(faq.length ? [{
        '@type': 'FAQPage',
        mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      }] : []),
      // HowTo حُذف عمداً (أغسطس 2026) — نتائجه الغنية ميّتة منذ سبتمبر 2023؛ متطابق مع حذفه في prerender.mjs (المصدر المزدوج).
    ],
  } : undefined;

  // «اقرأ أيضاً» للمقال اليدوي وحده (المولَّد له روابطه في متنه): الخطة نفسها في prerender.mjs
  const relLang: 'ar' | 'en' = lang === 'en' ? 'en' : 'ar';
  const related: RelatedLink[] = useHand && hand ? relatedFor(hand.slug, relLang, posts, exists) : [];

  useSeo(view ? {
    // «| FieldSales» وتسقط إن جاوز العنوان بها 70 حرفاً — مطابق لما يصيّره prerender.mjs
    title: blogTitle(view.title),
    description: view.description,
    keywords: view.keywords,
    canonical,
    image: ogImage,
    type: 'article',
    locale: lang,
    alternates,
    jsonLd,
  } : { title: tr('المقال غير موجود | FieldSales', 'Article not found | FieldSales', 'Article introuvable | FieldSales') });

  // إنجليزي يدوي غير متوفّر → وجّه للعربية
  if (handUnavailableEn) return <Navigate to={`/blog/${slug}`} replace />;
  // أثناء جلب محتوى الـCMS قد لا يكون المقال اليدوي جاهزاً بعد — لا نُعيد التوجيه قبل اكتمال التحميل
  if (!view && isLoading) {
    const hold = ssrHoldHtml();
    if (hold) return <div data-ssr-hold="" dir={rtl ? 'rtl' : 'ltr'} className="min-h-screen" dangerouslySetInnerHTML={{ __html: hold }} />;
    return <div className="min-h-screen flex items-center justify-center bg-[#FAF7F0] text-[#9A8F7E]">{tr('جار التحميل', 'Loading…', 'Chargement…')}</div>;
  }
  if (!view) return <Navigate to={`${prefix}/blog`} replace />;

  const base = canonical;
  const home = prefix || '/';
  const blogHome = `${prefix}/blog`;
  const t = {
    all: tr('كل المقالات', 'All articles', 'Tous les articles'),
    read: tr('دقائق قراءة', 'min read', 'min de lecture'),
    ctaTitle: tr('جاهز لإدارة فريقك الميداني باحتراف', 'Ready to run your field team professionally?', 'Prêt à gérer votre équipe terrain ?'),
    ctaText: tr('فواتير تحصيل مخزون السيارة وتقارير لحظية في منصة واحدة', 'Invoices, collection, van stock and real-time reports — in one platform.', 'Factures, encaissement, stock du véhicule et rapports en temps réel — sur une seule plateforme.'),
    ctaBtn: tr('ابدأ تجربتك المجانية 10 أيام', 'Start your free 10-day trial', 'Commencez votre essai gratuit de 10 jours'),
    share: tr('شارك المقال', 'Share this article', 'Partager'),
    copy: tr('نسخ الرابط', 'Copy link', 'Copier le lien'),
  };

  return (
    <div dir={rtl ? 'rtl' : 'ltr'} className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]"
      style={{ fontFamily: rtl ? "'Noto Kufi Arabic', 'IBM Plex Sans', system-ui, sans-serif" : "'IBM Plex Sans', sans-serif" }}>
      <style>{`
        .article-prose { font-size:16.5px; line-height:1.95; color:#3a342b; }
        .article-prose h2 { font-size:25px; font-weight:800; color:#1F1A13; margin:34px 0 12px; letter-spacing:-0.3px; }
        .article-prose p { margin:14px 0; }
        .article-prose ul { margin:14px 0; padding-inline-start:24px; list-style:disc; }
        .article-prose ol { margin:14px 0; padding-inline-start:24px; list-style:decimal; }
        .article-prose li { margin:7px 0; }
        .article-prose strong { color:#1F1A13; font-weight:700; }
        .article-prose a { color:#E15A30; font-weight:600; text-decoration:none; }
        .article-prose a:hover { text-decoration:underline; }
        .article-prose table { width:100%; margin:16px 0; border-collapse:collapse; font-size:14.5px; background:#fff; border-radius:12px; overflow:hidden; }
        .article-prose th { background:#FBEBE2; color:#1F1A13; font-weight:700; padding:10px 12px; text-align:start; border:1px solid #E9E1D3; }
        .article-prose td { padding:10px 12px; border:1px solid #E9E1D3; vertical-align:top; }
        /* كتلة الإجابة المختصرة أول ما يقرؤه الزائر ومحرك التوليد تمنح
           تمييزا بصريا لأن دورها مختلف عن بقية المقال تقرأ وحدها */
        .article-prose .geo-answer { margin:0 0 26px; padding:18px 20px; background:#FBEBE2;
          border-inline-start:4px solid #E15A30; border-radius:12px; }
        .article-prose .geo-answer h2 { font-size:15px; font-weight:700; color:#E15A30;
          margin:0 0 8px; letter-spacing:0; text-transform:none; }
        .article-prose .geo-answer p { margin:0; font-size:17px; line-height:1.85; color:#1F1A13; }
      `}</style>

      <header className="sticky top-0 z-20 border-b border-[#E9E1D3] bg-[#FAF7F0]/85 backdrop-blur">
        <div className="max-w-3xl mx-auto px-5 h-16 flex items-center justify-between">
          <Link to={home} className="flex items-center gap-2.5">
            <BrandIcon size={34} />
            <span style={{ fontFamily: "'IBM Plex Serif', serif", fontWeight: 600, letterSpacing: '-0.3px' }} className="text-xl">
              <span className="text-[#1F1A13]">Field</span> <span className="text-[#E15A30]">Sales</span>
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <Link to={blogHome} className="text-sm font-semibold text-[#6E6557] hover:text-[#E15A30] flex items-center gap-1 transition-colors">
              {t.all} <ArrowLeft size={15} className={rtl ? '' : 'rotate-180'} />
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-5 py-12">
        <article>
          <h1 className="text-3xl lg:text-[40px] font-extrabold tracking-tight leading-tight">{view.title}</h1>
          <div className="flex items-center gap-4 mt-4 text-xs text-[#9A8F7E] border-b border-[#E9E1D3] pb-6">
            <span className="flex items-center gap-1"><Calendar size={13} /> {view.date}</span>
            <span className="flex items-center gap-1"><Clock size={13} /> {view.readMinutes} {t.read}</span>
          </div>

          {seo && (
            <img src={seo.imagePath} alt={view.title} width={1200} height={630}
              className="w-full h-auto rounded-2xl border border-[#E9E1D3] mt-6" loading="eager" />
          )}

          <div className="article-prose mt-6" dangerouslySetInnerHTML={{ __html: normalizeContent(view.contentHtml) }} />

          <ShareBar url={base} title={view.title} label={{ share: t.share, copy: t.copy }} />

          {/* CTA */}
          <div className="mt-10 bg-[#1F1A13] rounded-2xl p-7 text-center">
            <h3 className="text-xl font-bold text-[#FAF7F0]">{t.ctaTitle}</h3>
            <p className="text-[#C9BEAC] mt-2 text-sm">{t.ctaText}</p>
            <Link to="/signup" className="inline-flex items-center gap-2 mt-5 bg-[#E15A30] hover:bg-[#C94E28] text-white font-bold px-7 py-3 rounded-xl transition-colors">
              {t.ctaBtn}
            </Link>
          </div>
        </article>

        {related.length > 0 && (
          <nav aria-label={RELATED_TITLE[relLang]} className="mt-10 bg-white rounded-2xl border border-[#E9E1D3] p-6">
            <h2 className="text-lg font-bold">{RELATED_TITLE[relLang]}</h2>
            <ul className="mt-3 space-y-2.5">
              {related.map((l) => (
                <li key={l.href}>
                  <Link to={l.href} className="text-[15px] font-semibold text-[#C94E28] hover:text-[#E15A30] hover:underline">{l.anchor}</Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </main>

      <footer className="border-t border-[#E9E1D3] py-6 text-center text-xs text-[#9A8F7E]">
        © {new Date().getFullYear()} Field Sales — fieldsa.net
      </footer>
    </div>
  );
}
