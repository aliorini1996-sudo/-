import { Link, useParams, Navigate } from 'react-router-dom';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft, MessageCircle, ShieldQuestion } from 'lucide-react';
import LanguageToggle from '../components/LanguageToggle';
import { useLang, useDir } from '../i18n/lang';
import { useSeo } from '../lib/seo';
import { seoUrls, pathForLocale } from '../i18n/locale';
import { waHref } from '../components/WhatsAppFab';
import { COMPARE_PAGES, COMPARE_ENABLED, compareBySlug, type Cell } from '../content/compare';

/**
 * صفحة مقارنة — **موقوفة خلف مفتاح حتى مراجعة المالك للأرقام**.
 *
 * لماذا الوقف: ذكر سعر منافس خطأً تعرّض قانوني مباشر، والأرقام هنا منقولة من
 * مسح داخلي لا من صفحات المورّدين لحظياً. فحتى يراجعها المالك تبقى الصفحة
 * غير منشورة (404) ولا تدخل خريطة الموقع ولا التصيير المسبق.
 *
 * القواعد المفروضة بنيوياً: كل خلية بمصدر وتاريخ · الرقم غير المعلن يبقى
 * «غير معلن» ولا يُقدَّر · صندوق «متى نرشّح المنافس» إلزامي.
 */

function CellView({ c, label }: { c: Cell; label: string }) {
  return (
    <tr>
      <th scope="row" className="text-start align-top py-2 pe-3 text-xs font-medium text-[#6b6357] whitespace-nowrap">{label}</th>
      <td className="py-2 text-sm align-top">
        {c.v === null || c.v === undefined ? (
          <span className="text-[#9A8F7E] italic">غير معلن — لا نقدّر رقماً لمن لا ينشره</span>
        ) : (
          <>
            <span>{c.v}</span>
            {c.src && (
              <span className="block text-[10px] text-[#9A8F7E] mt-0.5">
                المصدر: {c.src}{c.at ? ` · رُصد في ${c.at}` : ''}
              </span>
            )}
          </>
        )}
      </td>
    </tr>
  );
}

export default function ComparePage() {
  const { slug } = useParams();
  const lang = useLang((s) => s.lang);
  const dir = useDir();
  const page = slug ? compareBySlug(slug) : undefined;

  const arPath = page ? `/مقارنة/${page.slug}` : '/مقارنة';
  const seo = seoUrls(arPath, lang);

  useSeo({
    title: page ? `Field Sales مقابل ${page.competitorAr} — مقارنة صريحة` : 'مقارنات | Field Sales',
    description: page ? page.angle : 'مقارنات صريحة بين Field Sales وبدائله.',
    canonical: seo.canonical,
    locale: lang,
  });

  // 🔴 المفتاح مُطفأ ⇒ الصفحة غير موجودة أصلاً للزائر
  if (!COMPARE_ENABLED) return <Navigate to="/" replace />;
  if (slug && !page) return <Navigate to="/مقارنة" replace />;

  return (
    <div dir={dir} className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]">
      <header className="border-b border-[#E8E0D2] bg-white/70 backdrop-blur">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link to={pathForLocale('/', lang)} className="flex items-center gap-2 text-sm text-[#6b6357]">
            <ArrowLeft size={16} className={dir === 'rtl' ? 'rotate-180' : ''} />
            <BrandIcon size={22} /><span>الرئيسية</span>
          </Link>
          <LanguageToggle variant="light" />
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        {!page ? (
          <>
            <h1 className="text-2xl font-bold">مقارنات صريحة</h1>
            <ul className="grid gap-3 sm:grid-cols-2 mt-6">
              {COMPARE_PAGES.map((p) => (
                <li key={p.slug}>
                  <Link to={`/مقارنة/${p.slug}`} className="block bg-white border border-[#E8E0D2] rounded-xl p-4 hover:border-[#E15A30]">
                    <span className="font-semibold block">Field Sales مقابل {p.competitorAr}</span>
                    <span className="text-xs text-[#6b6357] block mt-1 leading-relaxed">{p.angle}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <h1 className="text-2xl sm:text-3xl font-bold">Field Sales مقابل {page.competitorAr}</h1>
            <p className="text-[#6b6357] mt-3 leading-relaxed">{page.angle}</p>

            <section className="mt-6 bg-white border border-[#E8E0D2] rounded-xl p-5 overflow-x-auto">
              <h2 className="font-semibold text-sm mb-3">جدول الحقائق — {page.competitorAr}</h2>
              <table className="w-full">
                <caption className="sr-only">مقارنة الحقائق المعلنة</caption>
                <tbody className="divide-y divide-[#F0EBE0]">
                  <CellView c={page.model} label="نموذج التسعير" />
                  <CellView c={page.price} label="السعر المعلن" />
                  <CellView c={page.setupFee} label="رسوم التأسيس" />
                  <CellView c={page.at20} label="عند ٢٠ مندوباً" />
                  <CellView c={page.hidden} label="تكاليف إضافية" />
                  <CellView c={page.trial} label="التجربة" />
                </tbody>
              </table>
            </section>

            <div className="grid gap-4 sm:grid-cols-2 mt-6">
              <section className="bg-white border border-[#E8E0D2] rounded-xl p-5">
                <h2 className="font-semibold text-sm">ما يتفوّق فيه {page.competitorAr}</h2>
                <ul className="mt-2 space-y-1.5 text-xs text-[#4a443a] list-disc ps-4">
                  {page.theirStrengths.map((x) => <li key={x}>{x}</li>)}
                </ul>
              </section>
              <section className="bg-white border border-[#E8E0D2] rounded-xl p-5">
                <h2 className="font-semibold text-sm">ما نتفوّق فيه</h2>
                <ul className="mt-2 space-y-1.5 text-xs text-[#4a443a] list-disc ps-4">
                  {page.ourStrengths.map((x) => <li key={x}>{x}</li>)}
                </ul>
              </section>
            </div>

            {/* إلزامي — لا تُبنى الصفحة بدونه */}
            <section className="mt-6 bg-[#FBEBE2] border border-[#F0C9B6] rounded-xl p-5">
              <h2 className="font-semibold text-sm flex items-center gap-2">
                <ShieldQuestion size={16} className="text-[#C94E28]" />
                متى نرشّح {page.competitorAr} بصراحة
              </h2>
              <p className="text-xs text-[#5c4a40] mt-2 leading-relaxed">{page.recommendThemWhen}</p>
            </section>

            <p className="text-[11px] text-[#9A8F7E] mt-5 leading-relaxed">
              الأرقام أعلاه من صفحات المورّدين المعلنة بتاريخ الرصد المدوّن بجانب كل خلية، وقد تتغيّر.
              ومن لا يعلن سعره لا نقدّر له رقماً. ولا نستخدم شعار أي مورّد ولا هويته البصرية.
            </p>

            <div className="mt-6">
              <a href={waHref(arPath, { lang })} target="_blank" rel="noopener noreferrer"
                 className="inline-flex items-center gap-2 bg-[#25D366] text-white rounded-lg px-4 py-2.5 text-sm">
                <MessageCircle size={16} />تحدّث معنا على واتساب
              </a>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
