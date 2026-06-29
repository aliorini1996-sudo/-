import { Link } from 'react-router-dom';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft, Clock, Calendar } from 'lucide-react';
import { POSTS } from '../blog/posts';
import { useSeo } from '../lib/seo';

// فهرس المدوّنة /blog — يعرض المقالات ويربطها (للفهرسة والـSEO)
export default function BlogIndexPage() {
  useSeo({
    title: 'المدوّنة | FieldSales — مقالات إدارة المبيعات الميدانية والتوزيع',
    description: 'مقالات ودلائل عملية في إدارة مبيعات المناديب الميدانيين، الفوترة الإلكترونية ZATCA، التحصيل، ومخزون التوزيع — من فريق FieldSales.',
    canonical: 'https://fieldsa.net/blog',
    image: 'https://fieldsa.net/og-image.png',
  });

  return (
    <div dir="rtl" className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]" style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}>
      <header className="sticky top-0 z-20 border-b border-[#E9E1D3] bg-[#FAF7F0]/85 backdrop-blur">
        <div className="max-w-4xl mx-auto px-5 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5">
            <BrandIcon size={34} />
            <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 700 }} className="text-lg">
              <span className="text-[#1F1A13]">Field</span><span className="text-[#E15A30]">Sales</span>
            </span>
          </Link>
          <Link to="/" className="text-sm font-semibold text-[#6E6557] hover:text-[#E15A30] flex items-center gap-1 transition-colors">
            العودة للرئيسية <ArrowLeft size={15} />
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-5 py-14">
        <div className="text-center mb-12">
          <div className="font-mono text-xs tracking-[2.5px] uppercase text-[#E15A30] font-bold" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>BLOG</div>
          <h1 className="text-3xl lg:text-4xl font-extrabold tracking-tight mt-3">مدوّنة FieldSales</h1>
          <p className="text-[#6E6557] mt-3 max-w-xl mx-auto leading-relaxed">دلائل ومقالات عملية في إدارة المبيعات الميدانية، الفوترة الإلكترونية، والتوزيع.</p>
        </div>

        <div className="grid gap-5">
          {POSTS.map(post => (
            <Link key={post.slug} to={`/blog/${post.slug}`}
              className="block bg-white rounded-2xl border border-[#E9E1D3] p-6 lg:p-7 hover:border-[#E8C9BC] hover:shadow-sm transition-all">
              <h2 className="text-xl lg:text-2xl font-bold text-[#1F1A13] leading-snug">{post.title}</h2>
              <p className="text-[#6E6557] mt-3 leading-relaxed">{post.excerpt}</p>
              <div className="flex items-center gap-4 mt-4 text-xs text-[#9A8F7E]">
                <span className="flex items-center gap-1"><Calendar size={13} /> {post.date}</span>
                <span className="flex items-center gap-1"><Clock size={13} /> {post.readMinutes} دقائق قراءة</span>
                <span className="text-[#E15A30] font-semibold flex items-center gap-1 mr-auto">اقرأ المقال <ArrowLeft size={14} /></span>
              </div>
            </Link>
          ))}
        </div>
      </main>

      <footer className="border-t border-[#E9E1D3] py-6 text-center text-xs text-[#9A8F7E]">
        © {new Date().getFullYear()} Field Sales — fieldsa.net
      </footer>
    </div>
  );
}
