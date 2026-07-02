import { Link } from 'react-router-dom';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft, Clock, Calendar } from 'lucide-react';
import { useBlog } from '../blog/useBlog';
import { postView } from '../blog/posts';
import { listArticles, COUNTRIES } from '../blog/seo/catalog.mjs';
import { useLang } from '../i18n/lang';
import { seoUrls } from '../i18n/locale';
import { useSeo } from '../lib/seo';
import LanguageToggle from '../components/LanguageToggle';

type Card = { slug: string; title: string; excerpt: string; date: string; readMinutes: number; img?: string };

// فهرس المدوّنة — عربي /blog · إنجليزي /en/blog · فرنسي /fr/blog (يشمل المقالات المولَّدة لكل الدول العربية + hreflang)
export default function BlogIndexPage() {
  const lang = useLang((s) => s.lang); // ar | en | fr
  const { posts } = useBlog();
  const rtl = lang === 'ar';
  const prefix = lang === 'ar' ? '' : `/${lang}`;
  const tr = (ar: string, en: string, fr: string) => (lang === 'ar' ? ar : lang === 'en' ? en : fr);
  const { canonical, alternates } = seoUrls('/blog', lang);

  useSeo({
    title: tr(
      'المدوّنة | FieldSales — مقالات إدارة المبيعات الميدانية والتوزيع في الدول العربية',
      'Blog | FieldSales — Field Sales & Distribution Articles across Arab Countries',
      'Blog | FieldSales — Articles sur la vente terrain et la distribution dans les pays arabes',
    ),
    description: tr(
      'مئات المقالات والدلائل العملية في إدارة المبيعات الميدانية، الفوترة الإلكترونية، التحصيل، ومخزون التوزيع — مخصّصة لكل الدول العربية من فريق FieldSales.',
      'Hundreds of practical guides on field sales management, e-invoicing, collection and distribution — tailored to every Arab country by the FieldSales team.',
      'Des centaines de guides pratiques sur la vente terrain, la facturation électronique, l\'encaissement et la distribution — pour chaque pays arabe, par FieldSales.',
    ),
    keywords: tr(
      'مدونة مبيعات ميدانية, مقالات إدارة مناديب, البيع المتنقل, التحصيل, التوزيع, الفوترة الإلكترونية, الدول العربية',
      'field sales blog, distribution management articles, van sales, sales rep management, e-invoicing, Arab countries',
      'blog vente terrain, articles distribution, van sales, gestion commerciaux, facturation électronique, pays arabes',
    ),
    locale: lang, canonical, alternates, image: 'https://fieldsa.net/og-image.png',
  });

  const home = prefix || '/';
  const t = {
    back: tr('العودة للرئيسية', 'Back to home', "Retour à l'accueil"),
    title: tr('مدوّنة FieldSales', 'FieldSales Blog', 'Blog FieldSales'),
    intro: tr(
      'دلائل ومقالات عملية في إدارة المبيعات الميدانية، الفوترة الإلكترونية، والتوزيع — لكل الدول العربية.',
      'Practical guides on field sales management, e-invoicing and distribution — for every Arab country.',
      'Guides pratiques sur la vente terrain, la facturation électronique et la distribution — pour chaque pays arabe.',
    ),
    read: tr('دقائق قراءة', 'min read', 'min de lecture'),
    cta: tr('اقرأ المقال', 'Read article', "Lire l'article"),
    byCountry: tr('تصفّح حسب الدولة', 'Browse by country', 'Parcourir par pays'),
    latest: tr('أحدث المقالات', 'Latest articles', 'Derniers articles'),
  };

  // المقالات المكتوبة يدوياً (عربي/إنجليزي فقط) + المقالات المولَّدة برمجياً (ثلاثية اللغة)
  const handCards: Card[] = lang === 'fr' ? [] : posts.map((p) => {
    const v = postView(p, lang === 'en' ? 'en' : 'ar');
    return { slug: p.slug, title: v.title, excerpt: v.excerpt, date: p.date, readMinutes: p.readMinutes };
  });
  const seoCards: Card[] = listArticles(lang).map((a) => ({ slug: a.slug, title: a.title, excerpt: a.excerpt, date: a.date, readMinutes: a.readMinutes, img: `/og/${a.slug}-${lang}.jpg` }));
  // نعرض اليدوية أولاً ثم أحدث المولَّدة (نحدّ العدد المعروض حفاظاً على سرعة الصفحة — البقية عبر sitemap والروابط الداخلية)
  const cards: Card[] = [...handCards, ...seoCards].slice(0, 66);

  const countryName = (c: { ar: string; en: string; fr: string }) => (lang === 'ar' ? c.ar : lang === 'en' ? c.en : c.fr);

  return (
    <div dir={rtl ? 'rtl' : 'ltr'} className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]"
      style={{ fontFamily: rtl ? "'IBM Plex Sans Arabic', sans-serif" : "'IBM Plex Sans', sans-serif" }}>
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
              {t.back} <ArrowLeft size={15} className={rtl ? '' : 'rotate-180'} />
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-5 py-14">
        <div className="text-center mb-10">
          <div className="font-mono text-xs tracking-[2.5px] uppercase text-[#E15A30] font-bold" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>BLOG</div>
          <h1 className="text-3xl lg:text-4xl font-extrabold tracking-tight mt-3">{t.title}</h1>
          <p className="text-[#6E6557] mt-3 max-w-xl mx-auto leading-relaxed">{t.intro}</p>
        </div>

        {/* تصفّح حسب الدولة — روابط داخلية لكل الدول العربية (يستهدف كل دولة على حدة) */}
        <section className="mb-12">
          <h2 className="text-sm font-bold text-[#1F1A13] mb-3">{t.byCountry}</h2>
          <div className="flex flex-wrap gap-2">
            {COUNTRIES.map((c) => (
              <Link key={c.code} to={`${prefix}/blog/field-sales-software-${c.code.toLowerCase()}`}
                className="text-sm border border-[#E9E1D3] bg-white rounded-lg px-3 py-1.5 text-[#3a342b] hover:border-[#E8C9BC] hover:text-[#E15A30] transition-colors">
                {countryName(c)}
              </Link>
            ))}
          </div>
        </section>

        <h2 className="text-sm font-bold text-[#1F1A13] mb-4">{t.latest}</h2>
        <div className="grid gap-5">
          {cards.map((post) => (
            <Link key={post.slug} to={`${prefix}/blog/${post.slug}`}
              className="block bg-white rounded-2xl border border-[#E9E1D3] overflow-hidden hover:border-[#E8C9BC] hover:shadow-sm transition-all">
              {post.img && (
                <img src={post.img} alt={post.title} width={1200} height={630} loading="lazy"
                  className="w-full h-auto border-b border-[#E9E1D3]" />
              )}
              <div className="p-6 lg:p-7">
                <h3 className="text-xl lg:text-2xl font-bold text-[#1F1A13] leading-snug">{post.title}</h3>
                <p className="text-[#6E6557] mt-3 leading-relaxed">{post.excerpt}</p>
                <div className="flex items-center gap-4 mt-4 text-xs text-[#9A8F7E]">
                  <span className="flex items-center gap-1"><Calendar size={13} /> {post.date}</span>
                  <span className="flex items-center gap-1"><Clock size={13} /> {post.readMinutes} {t.read}</span>
                  <span className="text-[#E15A30] font-semibold flex items-center gap-1 ms-auto">{t.cta} <ArrowLeft size={14} className={rtl ? '' : 'rotate-180'} /></span>
                </div>
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
