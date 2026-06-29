import { Link, useParams, Navigate } from 'react-router-dom';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft, Clock, Calendar } from 'lucide-react';
import { getPost } from '../blog/posts';
import { useSeo } from '../lib/seo';

// صفحة مقال /blog/:slug — مُحسّنة للـSEO (وسوم + بيانات Article منظّمة + محتوى في الـDOM)
export default function BlogPostPage() {
  const { slug } = useParams();
  const post = getPost(slug || '');

  useSeo(post ? {
    title: `${post.title} | مدوّنة FieldSales`,
    description: post.description,
    canonical: `https://fieldsa.net/blog/${post.slug}`,
    image: 'https://fieldsa.net/og-image.png',
    type: 'article',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: post.title,
      description: post.description,
      datePublished: post.date,
      dateModified: post.date,
      image: 'https://fieldsa.net/og-image.png',
      author: { '@type': 'Organization', name: 'FieldSales' },
      publisher: { '@type': 'Organization', name: 'FieldSales', logo: { '@type': 'ImageObject', url: 'https://fieldsa.net/icons/icon-512.png' } },
      mainEntityOfPage: `https://fieldsa.net/blog/${post.slug}`,
    },
  } : { title: 'المقال غير موجود | FieldSales' });

  if (!post) return <Navigate to="/blog" replace />;

  return (
    <div dir="rtl" className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]" style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}>
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
          <Link to="/" className="flex items-center gap-2.5">
            <BrandIcon size={34} />
            <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 700 }} className="text-lg">
              <span className="text-[#1F1A13]">Field</span><span className="text-[#E15A30]">Sales</span>
            </span>
          </Link>
          <Link to="/blog" className="text-sm font-semibold text-[#6E6557] hover:text-[#E15A30] flex items-center gap-1 transition-colors">
            كل المقالات <ArrowLeft size={15} />
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-5 py-12">
        <article>
          <h1 className="text-3xl lg:text-[40px] font-extrabold tracking-tight leading-tight">{post.title}</h1>
          <div className="flex items-center gap-4 mt-4 text-xs text-[#9A8F7E] border-b border-[#E9E1D3] pb-6">
            <span className="flex items-center gap-1"><Calendar size={13} /> {post.date}</span>
            <span className="flex items-center gap-1"><Clock size={13} /> {post.readMinutes} دقائق قراءة</span>
          </div>

          <div className="article-prose mt-6" dangerouslySetInnerHTML={{ __html: post.contentHtml }} />

          {/* CTA */}
          <div className="mt-10 bg-[#1F1A13] rounded-2xl p-7 text-center">
            <h3 className="text-xl font-bold text-[#FAF7F0]">جاهز لإدارة فريقك الميداني باحتراف؟</h3>
            <p className="text-[#C9BEAC] mt-2 text-sm">فواتير ZATCA، تحصيل، مخزون السيارة، وتقارير لحظية — في منصّة واحدة.</p>
            <Link to="/signup" className="inline-flex items-center gap-2 mt-5 bg-[#E15A30] hover:bg-[#C94E28] text-white font-bold px-7 py-3 rounded-xl transition-colors">
              ابدأ تجربتك المجانية 10 أيام
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
