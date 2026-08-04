import { Link, useParams, Navigate } from 'react-router-dom';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft, Check, MessageCircle } from 'lucide-react';
import LanguageToggle from '../components/LanguageToggle';
import { useLang, useDir } from '../i18n/lang';
import { useSeo } from '../lib/seo';
import { seoUrls, pathForLocale } from '../i18n/locale';
import { waHref } from '../components/WhatsAppFab';
import { SECTORS, sectorBySlug } from '../content/sectors';

/**
 * صفحة قطاع — سبع صفحات بمحتوى مكتوب لكلٍّ منها لا مولّد.
 *
 * الفارق الذي يجعلها صفحة لا استنساخاً: ألم اليوم الميداني يختلف فعلاً بين
 * قطاع وآخر (صلاحية قصيرة عند الألبان · كثافة أصناف عند قطع الغيار)، والميزات
 * المُبرَزة تُختار لتخدم ذلك الألم تحديداً. لو كان النصّ واحداً بتبديل الاسم
 * لوقعت الصفحات تحت سياسة المحتوى المُوسَّع وخسرنا أكثر ممّا كسبنا.
 */
export default function SectorPage() {
  const { slug } = useParams();
  const lang = useLang((s) => s.lang);
  const dir = useDir();
  const sector = slug ? sectorBySlug(decodeURIComponent(slug)) : undefined;

  const arPath = sector ? `/قطاعات/${sector.slug}` : '/قطاعات';
  const seo = seoUrls(arPath, lang);

  useSeo({
    title: sector ? `${sector.name} — برنامج إدارة مناديب التوزيع | Field Sales` : 'القطاعات | Field Sales',
    description: sector
      ? `${sector.pain} Field Sales يعمل دون إنترنت ويدير مخزون سيارة المندوب والمرتجعات المصنّفة لشركات ${sector.name}.`
      : 'القطاعات التي يخدمها Field Sales في التوزيع الميداني.',
    canonical: seo.canonical,
    alternates: seo.alternates,
    locale: lang,
    jsonLd: sector
      ? {
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'FAQPage',
              mainEntity: sector.faq.map((f) => ({
                '@type': 'Question', name: f.q,
                acceptedAnswer: { '@type': 'Answer', text: f.a },
              })),
            },
          ],
        }
      : undefined,
  });

  if (slug && !sector) return <Navigate to="/قطاعات" replace />;

  return (
    <div dir={dir} className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]">
      <header className="border-b border-[#E8E0D2] bg-white/70 backdrop-blur">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link to={pathForLocale('/', lang)} className="flex items-center gap-2 text-sm text-[#6b6357] hover:text-[#1F1A13]">
            <ArrowLeft size={16} className={dir === 'rtl' ? 'rotate-180' : ''} />
            <BrandIcon size={22} /><span>الرئيسية</span>
          </Link>
          <LanguageToggle variant="light" />
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        {!sector ? (
          <>
            <h1 className="text-2xl font-bold">القطاعات التي نخدمها</h1>
            <p className="text-[#6b6357] mt-2">لكل قطاع توزيع ألمه اليومي المختلف — اختر قطاعك.</p>
            <ul className="grid gap-3 sm:grid-cols-2 mt-6">
              {SECTORS.map((s) => (
                <li key={s.id}>
                  <Link to={`/قطاعات/${s.slug}`} className="block bg-white border border-[#E8E0D2] rounded-xl p-4 hover:border-[#E15A30]">
                    <span className="font-semibold block">{s.name}</span>
                    <span className="text-xs text-[#6b6357] block mt-1 leading-relaxed">{s.pain}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <h1 className="text-2xl sm:text-3xl font-bold">
              برنامج إدارة مناديب التوزيع لشركات {sector.name}
            </h1>
            <p className="text-[#6b6357] mt-3 leading-relaxed">{sector.pain}</p>

            <section className="mt-6 bg-white border border-[#E8E0D2] rounded-xl p-5">
              <h2 className="font-semibold text-sm">يومك الميداني</h2>
              <p className="text-sm text-[#4a443a] mt-2 leading-relaxed">{sector.scene}</p>
            </section>

            <section className="mt-6 grid gap-4 sm:grid-cols-3">
              {sector.features.map((f) => (
                <div key={f.title} className="bg-white border border-[#E8E0D2] rounded-xl p-4">
                  <h3 className="font-semibold text-sm flex items-center gap-1.5">
                    <Check size={14} className="text-green-600" />{f.title}
                  </h3>
                  <p className="text-xs text-[#6b6357] mt-2 leading-relaxed">{f.body}</p>
                </div>
              ))}
            </section>

            {sector.deep && sector.deep.length > 0 && (
              <section className="mt-8 space-y-4">
                {sector.deep.map((d) => (
                  <div key={d.title}>
                    <h2 className="font-semibold">{d.title}</h2>
                    <p className="text-sm text-[#4a443a] mt-2 leading-relaxed">{d.body}</p>
                  </div>
                ))}
              </section>
            )}

            <section className="mt-8">
              <h2 className="font-semibold">أسئلة شائعة — {sector.name}</h2>
              <dl className="mt-3 space-y-3">
                {sector.faq.map((f) => (
                  <div key={f.q} className="bg-white border border-[#E8E0D2] rounded-xl p-4">
                    <dt className="font-medium text-sm">{f.q}</dt>
                    <dd className="text-xs text-[#6b6357] mt-1.5 leading-relaxed">{f.a}</dd>
                  </div>
                ))}
              </dl>
            </section>

            {/* صندوق الإنصاف — إلزامي حيثما لُمّح للامتثال */}
            <section className="mt-6 bg-white border border-[#E8E0D2] rounded-xl p-5">
              <h2 className="font-semibold text-sm">ما لا نملكه — بصراحة</h2>
              <p className="text-xs text-[#6b6357] mt-2 leading-relaxed">
                ندعم الفاتورة الإلكترونية المرحلة الأولى (رمز QR بترميز TLV) فقط؛ المرحلة الثانية غير مبنية لدينا حتى الآن.
                وهيئة الزكاة والضريبة والجمارك لا تعتمد ولا تصادق مزوّدي البرمجيات، فلا ندّعي اعتماداً منها.
              </p>
            </section>

            <div className="mt-8 flex flex-wrap gap-3">
              <a href={waHref(arPath, { lang })} target="_blank" rel="noopener noreferrer"
                 className="inline-flex items-center gap-2 bg-[#25D366] text-white rounded-lg px-4 py-2.5 text-sm">
                <MessageCircle size={16} />تحدّث معنا على واتساب
              </a>
              <Link to={pathForLocale('/pricing', lang)} className="inline-flex items-center gap-2 border border-[#E8E0D2] bg-white rounded-lg px-4 py-2.5 text-sm">
                شاهد الأسعار
              </Link>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
