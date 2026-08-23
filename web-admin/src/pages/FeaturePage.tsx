import { Link, useParams, Navigate } from 'react-router-dom';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft, Check, MessageCircle, AlertTriangle } from 'lucide-react';
import LanguageToggle from '../components/LanguageToggle';
import { useLang, useDir } from '../i18n/lang';
import { useSeo } from '../lib/seo';
import { seoUrls, pathForLocale } from '../i18n/locale';
import { waHref } from '../components/WhatsAppFab';
import { FEATURES, featureBySlug } from '../content/features.mjs';

/**
 * صفحة ميزة مفردة — تجيب «كيف تفعلونها أنتم؟» لا «ما هذه الميزة؟».
 *
 * الفارق عن مقال المدوّنة المقترن: المقال تعليميّ يشرح المفهوم لمن لا يعرفه،
 * وهذه الصفحة تشغيليّة تصف آليتنا نحن بتفصيل لا يملكه إلا من بنى الميزة.
 * ولهذا قسم «ما لا يفعله» ظاهر لا مخفيّ: التفصيل الصادق عن الحدود هو ما
 * يفرّق صفحة منتج حقيقية عن صفحة تسويق، وهو ما يجعلها تستحقّ الترتيب.
 */
export default function FeaturePage() {
  const { slug } = useParams();
  const lang = useLang((s) => s.lang);
  const dir = useDir();
  const feature = slug ? featureBySlug(decodeURIComponent(slug)) : undefined;

  const arPath = feature ? `/مزايا/${feature.slug}` : '/مزايا';
  const seo = seoUrls(arPath, lang);

  useSeo({
    title: feature ? `${feature.h1} | Field Sales` : 'مزايا المنصّة | Field Sales',
    description: feature
      ? `${feature.pain} ${feature.name} في Field Sales — كيف تعمل فعلاً وما حدودها بصراحة.`
      : 'مزايا Field Sales للتوزيع الميداني: الفوترة بدون إنترنت، عهدة سيارة المندوب، الطباعة الحرارية، توثيق الزيارات.',
    canonical: seo.canonical,
    alternates: seo.alternates,
    locale: lang,
    jsonLd: feature
      ? {
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'FAQPage',
              mainEntity: feature.faq.map((f) => ({
                '@type': 'Question', name: f.q,
                acceptedAnswer: { '@type': 'Answer', text: f.a },
              })),
            },
          ],
        }
      : undefined,
  });

  if (slug && !feature) return <Navigate to="/مزايا" replace />;

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
        {!feature ? (
          <>
            <h1 className="text-2xl font-bold">مزايا المنصّة</h1>
            <p className="text-[#6b6357] mt-2">كل ميزة وكيف تعمل فعلاً — وما لا تفعله بصراحة</p>
            <ul className="grid gap-3 sm:grid-cols-2 mt-6">
              {FEATURES.map((f) => (
                <li key={f.id}>
                  <Link to={`/مزايا/${f.slug}`} className="block bg-white border border-[#E8E0D2] rounded-xl p-4 hover:border-[#E15A30]">
                    <span className="font-semibold block">{f.name}</span>
                    <span className="text-xs text-[#6b6357] block mt-1 leading-relaxed">{f.pain}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <h1 className="text-2xl sm:text-3xl font-bold">{feature.h1}</h1>
            <p className="text-[#6b6357] mt-3 leading-relaxed">{feature.pain}</p>

            <section className="mt-6 bg-white border border-[#E8E0D2] rounded-xl p-5">
              <h2 className="font-semibold text-sm">المشهد الذي تعالجه</h2>
              <p className="text-sm text-[#4a443a] mt-2 leading-relaxed">{feature.scene}</p>
            </section>

            <section className="mt-8">
              <h2 className="font-semibold text-lg">كيف تعمل عندنا</h2>
              <div className="mt-4 space-y-4">
                {feature.how.map((h) => (
                  <div key={h.title} className="bg-white border border-[#E8E0D2] rounded-xl p-4">
                    <h3 className="font-semibold text-sm flex items-start gap-1.5">
                      <Check size={14} className="text-green-600 mt-0.5 shrink-0" />
                      <span>{h.title}</span>
                    </h3>
                    <p className="text-xs text-[#6b6357] mt-2 leading-relaxed">{h.body}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* الحدود — ظاهرة لا مخفيّة: هي ما يجعل الصفحة صادقة وتستحق الثقة */}
            <section className="mt-8 bg-white border border-[#E8E0D2] rounded-xl p-5">
              <h2 className="font-semibold text-sm flex items-center gap-1.5">
                <AlertTriangle size={14} className="text-amber-600" />
                ما لا تفعله هذه الميزة
              </h2>
              <ul className="mt-3 space-y-2">
                {feature.limits.map((l) => (
                  <li key={l} className="text-xs text-[#6b6357] leading-relaxed">— {l}</li>
                ))}
              </ul>
            </section>

            <section className="mt-8">
              <h2 className="font-semibold">أسئلة شائعة عن {feature.name}</h2>
              <dl className="mt-3 space-y-3">
                {feature.faq.map((f) => (
                  <div key={f.q} className="bg-white border border-[#E8E0D2] rounded-xl p-4">
                    <dt className="font-medium text-sm">{f.q}</dt>
                    <dd className="text-xs text-[#6b6357] mt-1.5 leading-relaxed">{f.a}</dd>
                  </div>
                ))}
              </dl>
            </section>

            {(feature.pairSlug || feature.templateSlug) && (
              <section className="mt-8">
                <h2 className="font-semibold text-sm">اقرأ أيضاً</h2>
                <ul className="mt-3 space-y-2 text-sm">
                  {feature.pairSlug && (
                    <li>
                      <Link to={`/blog/${feature.pairSlug}`} className="text-[#E15A30] hover:underline">
                        دليل شامل: {feature.name}
                      </Link>
                    </li>
                  )}
                  {feature.templateSlug && (
                    <li>
                      <Link to={`/نماذج/${feature.templateSlug}`} className="text-[#E15A30] hover:underline">
                        نموذج Excel جاهز — {feature.name}
                      </Link>
                    </li>
                  )}
                </ul>
              </section>
            )}

            <section className="mt-8">
              <h2 className="font-semibold text-sm">مزايا أخرى</h2>
              <ul className="mt-3 grid gap-2 sm:grid-cols-3">
                {FEATURES.filter((f) => f.id !== feature.id).map((f) => (
                  <li key={f.id}>
                    <Link to={`/مزايا/${f.slug}`} className="block bg-white border border-[#E8E0D2] rounded-lg px-3 py-2 text-xs hover:border-[#E15A30]">
                      {f.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>

            <div className="mt-8 flex flex-wrap gap-3">
              <a href={waHref(arPath, { lang })} target="_blank" rel="noopener noreferrer"
                 className="inline-flex items-center gap-2 bg-[#25D366] text-white rounded-lg px-4 py-2.5 text-sm">
                <MessageCircle size={16} />تحدث معنا على واتساب
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
