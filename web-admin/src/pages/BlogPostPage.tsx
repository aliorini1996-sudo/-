import { Link, useParams, Navigate } from 'react-router-dom';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft, Clock, Calendar } from 'lucide-react';
import { normalizeContent, postView } from '../blog/posts';
import { useBlog } from '../blog/useBlog';
import { useSeo } from '../lib/seo';

// صفحة مقال — عربي على /blog/:slug وإنجليزي على /en/blog/:slug (ثنائي اللغة + hreflang + Article JSON-LD)
export default function BlogPostPage() {
  const { slug } = useParams();
  const { getPost, isLoading, lang } = useBlog();
  const post = getPost(slug || '');
  const en = lang === 'en';
  const v = post ? postView(post, lang) : null;

  const base = `https://fieldsa.net${en ? '/en' : ''}/blog/${slug}`;
  const alternates = post?.en ? [
    { hreflang: 'ar', href: `https://fieldsa.net/blog/${slug}` },
    { hreflang: 'en', href: `https://fieldsa.net/en/blog/${slug}` },
    { hreflang: 'x-default', href: `https://fieldsa.net/blog/${slug}` },
  ] : undefined;

  useSeo(v ? {
    title: `${v.title} | ${en ? 'FieldSales Blog' : 'مدوّنة FieldSales'}`,
    description: v.description,
    keywords: v.keywords,
    canonical: base,
    image: 'https://fieldsa.net/og-image.png',
    type: 'article',
    locale: lang,
    alternates,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: v.title,
      description: v.description,
      inLanguage: lang,
      datePublished: post!.date,
      dateModified: post!.date,
      image: 'https://fieldsa.net/og-image.png',
      author: { '@type': 'Organization', name: 'FieldSales' },
      publisher: { '@type': 'Organization', name: 'FieldSales', logo: { '@type': 'ImageObject', url: 'https://fieldsa.net/icons/icon-512.png' } },
      mainEntityOfPage: base,
    },
  } : { title: en ? 'Article not found | FieldSales' : 'المقال غير موجود | FieldSales' });

  // أثناء جلب محتوى الـCMS قد لا يكون المقال جاهزاً بعد — لا نُعيد التوجيه قبل اكتمال التحميل
  if (!post && isLoading) {
    return <div className="min-h-screen flex items-center justify-center bg-[#FAF7F0] text-[#9A8F7E]">{en ? 'Loading…' : 'جارٍ التحميل…'}</div>;
  }
  if (!post) return <Navigate to={en ? '/en/blog' : '/blog'} replace />;
  // مقال عربي فقط على مسار /en → نوجّه للنسخة العربية
  if (en && !post.en) return <Navigate to={`/blog/${slug}`} replace />;

  const home = en ? '/en' : '/';
  const blogHome = en ? '/en/blog' : '/blog';
  const t = {
    all: en ? 'All articles' : 'كل المقالات',
    read: en ? 'min read' : 'دقائق قراءة',
    ctaTitle: en ? 'Ready to run your field team professionally?' : 'جاهز لإدارة فريقك الميداني باحتراف؟',
    ctaText: en ? 'Invoices, collection, van stock and real-time reports — in one platform.' : 'فواتير، تحصيل، مخزون السيارة، وتقارير لحظية — في منصّة واحدة.',
    ctaBtn: en ? 'Start your free 10-day trial' : 'ابدأ تجربتك المجانية 10 أيام',
  };

  return (
    <div dir={en ? 'ltr' : 'rtl'} className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]"
      style={{ fontFamily: en ? "'IBM Plex Sans', sans-serif" : "'IBM Plex Sans Arabic', sans-serif" }}>
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
          <Link to={blogHome} className="text-sm font-semibold text-[#6E6557] hover:text-[#E15A30] flex items-center gap-1 transition-colors">
            {t.all} <ArrowLeft size={15} className={en ? 'rotate-180' : ''} />
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-5 py-12">
        <article>
          <h1 className="text-3xl lg:text-[40px] font-extrabold tracking-tight leading-tight">{v!.title}</h1>
          <div className="flex items-center gap-4 mt-4 text-xs text-[#9A8F7E] border-b border-[#E9E1D3] pb-6">
            <span className="flex items-center gap-1"><Calendar size={13} /> {post.date}</span>
            <span className="flex items-center gap-1"><Clock size={13} /> {post.readMinutes} {t.read}</span>
          </div>

          <div className="article-prose mt-6" dangerouslySetInnerHTML={{ __html: normalizeContent(v!.contentHtml) }} />

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
