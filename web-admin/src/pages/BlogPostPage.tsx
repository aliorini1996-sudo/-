import { useState } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft, Clock, Calendar, Share2, Linkedin, Facebook, Twitter, MessageCircle, Link2, Check } from 'lucide-react';
import { normalizeContent, postView } from '../blog/posts';
import { useBlog } from '../blog/useBlog';
import { getArticle } from '../blog/seo/catalog.mjs';
import { useLang } from '../i18n/lang';
import { seoUrls } from '../i18n/locale';
import { useSeo } from '../lib/seo';
import LanguageToggle from '../components/LanguageToggle';

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
  const { getPost, isLoading } = useBlog();
  const hand = getPost(slug || '');
  const rtl = lang === 'ar';
  const prefix = lang === 'ar' ? '' : `/${lang}`;
  const tr = (ar: string, en: string, fr: string) => (lang === 'ar' ? ar : lang === 'en' ? en : fr);

  // مقال يدوي إنجليزي غير متوفّر لهذه اللغة الإنجليزية → عد للنسخة العربية
  const handUnavailableEn = hand && lang === 'en' && !hand.en;

  // اختر المصدر: مقال يدوي (ع/إ) أو مقال SEO مولّد (ع/إ/فر)
  const useHand = !!hand && lang !== 'fr' && !handUnavailableEn;
  const seo = useHand ? null : getArticle(slug || '', lang);

  type View = { title: string; description: string; keywords: string; contentHtml: string; date: string; readMinutes: number };
  let view: View | null = null;
  if (useHand && hand) {
    const v = postView(hand, lang === 'en' ? 'en' : 'ar');
    view = { title: v.title, description: v.description, keywords: v.keywords, contentHtml: v.contentHtml, date: hand.date, readMinutes: hand.readMinutes };
  } else if (seo) {
    view = { title: seo.title, description: seo.description, keywords: seo.keywords, contentHtml: seo.contentHtml, date: seo.date, readMinutes: seo.readMinutes };
  }

  // روابط hreflang + canonical: المقالات المولَّدة ثلاثية اللغة؛ اليدوية ثنائية عند توفّر en
  const isSeo = !!seo;
  const { canonical, alternates } = isSeo || (hand && hand.en)
    ? seoUrls(`/blog/${slug}`, lang)
    : { canonical: `https://fieldsa.net${prefix}/blog/${slug}`, alternates: undefined as undefined | { hreflang: string; href: string }[] };

  useSeo(view ? {
    title: `${view.title} | ${tr('مدوّنة FieldSales', 'FieldSales Blog', 'Blog FieldSales')}`,
    description: view.description,
    keywords: view.keywords,
    canonical,
    image: 'https://fieldsa.net/og-image.png',
    type: 'article',
    locale: lang,
    alternates,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: view.title,
      description: view.description,
      inLanguage: lang,
      datePublished: view.date,
      dateModified: view.date,
      image: 'https://fieldsa.net/og-image.png',
      author: { '@type': 'Organization', name: 'FieldSales' },
      publisher: { '@type': 'Organization', name: 'FieldSales', logo: { '@type': 'ImageObject', url: 'https://fieldsa.net/icons/icon-512.png' } },
      mainEntityOfPage: canonical,
    },
  } : { title: tr('المقال غير موجود | FieldSales', 'Article not found | FieldSales', 'Article introuvable | FieldSales') });

  // إنجليزي يدوي غير متوفّر → وجّه للعربية
  if (handUnavailableEn) return <Navigate to={`/blog/${slug}`} replace />;
  // أثناء جلب محتوى الـCMS قد لا يكون المقال اليدوي جاهزاً بعد — لا نُعيد التوجيه قبل اكتمال التحميل
  if (!view && isLoading) {
    return <div className="min-h-screen flex items-center justify-center bg-[#FAF7F0] text-[#9A8F7E]">{tr('جارٍ التحميل…', 'Loading…', 'Chargement…')}</div>;
  }
  if (!view) return <Navigate to={`${prefix}/blog`} replace />;

  const base = canonical;
  const home = prefix || '/';
  const blogHome = `${prefix}/blog`;
  const t = {
    all: tr('كل المقالات', 'All articles', 'Tous les articles'),
    read: tr('دقائق قراءة', 'min read', 'min de lecture'),
    ctaTitle: tr('جاهز لإدارة فريقك الميداني باحتراف؟', 'Ready to run your field team professionally?', 'Prêt à gérer votre équipe terrain ?'),
    ctaText: tr('فواتير، تحصيل، مخزون السيارة، وتقارير لحظية — في منصّة واحدة.', 'Invoices, collection, van stock and real-time reports — in one platform.', 'Factures, encaissement, stock du véhicule et rapports en temps réel — sur une seule plateforme.'),
    ctaBtn: tr('ابدأ تجربتك المجانية 10 أيام', 'Start your free 10-day trial', 'Commencez votre essai gratuit de 10 jours'),
    share: tr('شارك المقال', 'Share this article', 'Partager'),
    copy: tr('نسخ الرابط', 'Copy link', 'Copier le lien'),
  };

  return (
    <div dir={rtl ? 'rtl' : 'ltr'} className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]"
      style={{ fontFamily: rtl ? "'IBM Plex Sans Arabic', sans-serif" : "'IBM Plex Sans', sans-serif" }}>
      <style>{`
        .article-prose { font-size:16.5px; line-height:1.95; color:#3a342b; }
        .article-prose h2 { font-size:25px; font-weight:800; color:#1F1A13; margin:34px 0 12px; letter-spacing:-0.3px; }
        .article-prose p { margin:14px 0; }
        .article-prose ul { margin:14px 0; padding-inline-start:24px; list-style:disc; }
        .article-prose li { margin:7px 0; }
        .article-prose strong { color:#1F1A13; font-weight:700; }
        .article-prose a { color:#E15A30; font-weight:600; text-decoration:none; }
        .article-prose a:hover { text-decoration:underline; }
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
      </main>

      <footer className="border-t border-[#E9E1D3] py-6 text-center text-xs text-[#9A8F7E]">
        © {new Date().getFullYear()} Field Sales — fieldsa.net
      </footer>
    </div>
  );
}
