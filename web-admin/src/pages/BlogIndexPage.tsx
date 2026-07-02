import { Link } from 'react-router-dom';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft, Clock, Calendar } from 'lucide-react';
import { useBlog } from '../blog/useBlog';
import { postView } from '../blog/posts';
import { seoUrls } from '../i18n/locale';
import { useSeo } from '../lib/seo';
import LanguageToggle from '../components/LanguageToggle';

// فهرس المدوّنة — عربي على /blog وإنجليزي على /en/blog (ثنائي اللغة + hreflang)
export default function BlogIndexPage() {
  const { posts, lang } = useBlog();
  const en = lang === 'en';
  const { canonical, alternates } = seoUrls('/blog', lang);

  useSeo(en ? {
    title: 'Blog | FieldSales — Field Sales & Distribution Management Articles',
    description: 'Practical guides on field sales rep management, payment collection, van stock and distribution — from the FieldSales team.',
    keywords: 'field sales blog, distribution management articles, van sales, sales rep management, accounts receivable',
    locale: 'en', canonical, alternates, image: 'https://fieldsa.net/og-image.png',
  } : {
    title: 'المدوّنة | FieldSales — مقالات إدارة المبيعات الميدانية والتوزيع',
    description: 'مقالات ودلائل عملية في إدارة مبيعات المناديب الميدانيين، الفوترة الإلكترونية، التحصيل، ومخزون التوزيع — من فريق FieldSales.',
    keywords: 'مدونة مبيعات ميدانية, مقالات إدارة مناديب, البيع المتنقل, التحصيل, التوزيع',
    locale: 'ar', canonical, alternates, image: 'https://fieldsa.net/og-image.png',
  });

  const home = en ? '/en' : '/';
  const t = {
    back: en ? 'Back to home' : 'العودة للرئيسية',
    title: en ? 'FieldSales Blog' : 'مدوّنة FieldSales',
    intro: en
      ? 'Practical guides on field sales management, e-invoicing and distribution.'
      : 'دلائل ومقالات عملية في إدارة المبيعات الميدانية، الفوترة الإلكترونية، والتوزيع.',
    read: en ? 'min read' : 'دقائق قراءة',
    cta: en ? 'Read article' : 'اقرأ المقال',
  };

  return (
    <div dir={en ? 'ltr' : 'rtl'} className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]"
      style={{ fontFamily: en ? "'IBM Plex Sans', sans-serif" : "'IBM Plex Sans Arabic', sans-serif" }}>
      <header className="sticky top-0 z-20 border-b border-[#E9E1D3] bg-[#FAF7F0]/85 backdrop-blur">
        <div className="max-w-4xl mx-auto px-5 h-16 flex items-center justify-between">
          <Link to={home} className="flex items-center gap-2.5">
            <BrandIcon size={34} />
            <span style={{ fontFamily: "'IBM Plex Serif', serif", fontWeight: 600, letterSpacing: '-0.3px' }} className="text-xl">
              <span className="text-[#1F1A13]">Field</span> <span className="text-[#E15A30]">Sales</span>
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <Link to={home} className="text-sm font-semibold text-[#6E6557] hover:text-[#E15A30] flex items-center gap-1 transition-colors">
              {t.back} <ArrowLeft size={15} className={en ? 'rotate-180' : ''} />
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-5 py-14">
        <div className="text-center mb-12">
          <div className="font-mono text-xs tracking-[2.5px] uppercase text-[#E15A30] font-bold" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>BLOG</div>
          <h1 className="text-3xl lg:text-4xl font-extrabold tracking-tight mt-3">{t.title}</h1>
          <p className="text-[#6E6557] mt-3 max-w-xl mx-auto leading-relaxed">{t.intro}</p>
        </div>

        <div className="grid gap-5">
          {posts.map(post => {
            const v = postView(post, lang);
            return (
              <Link key={post.slug} to={`${en ? '/en' : ''}/blog/${post.slug}`}
                className="block bg-white rounded-2xl border border-[#E9E1D3] p-6 lg:p-7 hover:border-[#E8C9BC] hover:shadow-sm transition-all">
                <h2 className="text-xl lg:text-2xl font-bold text-[#1F1A13] leading-snug">{v.title}</h2>
                <p className="text-[#6E6557] mt-3 leading-relaxed">{v.excerpt}</p>
                <div className="flex items-center gap-4 mt-4 text-xs text-[#9A8F7E]">
                  <span className="flex items-center gap-1"><Calendar size={13} /> {post.date}</span>
                  <span className="flex items-center gap-1"><Clock size={13} /> {post.readMinutes} {t.read}</span>
                  <span className="text-[#E15A30] font-semibold flex items-center gap-1 mr-auto">{t.cta} <ArrowLeft size={14} className={en ? 'rotate-180' : ''} /></span>
                </div>
              </Link>
            );
          })}
        </div>
      </main>

      <footer className="border-t border-[#E9E1D3] py-6 text-center text-xs text-[#9A8F7E]">
        © {new Date().getFullYear()} Field Sales — fieldsa.net
      </footer>
    </div>
  );
}
