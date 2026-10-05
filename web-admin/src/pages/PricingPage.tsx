import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BrandIcon } from '../components/BrandLogo';
import { Check, MessageCircle, ArrowLeft, Info } from 'lucide-react';
import LanguageToggle from '../components/LanguageToggle';
import { useLang, useDir } from '../i18n/lang';
import { useSeo } from '../lib/seo';
import { seoUrls, pathForLocale } from '../i18n/locale';
import { waHref, refFromPath } from '../components/WhatsAppFab';
import { trackWhatsApp } from '../lib/ads';
import { useQuery } from '@tanstack/react-query';
import { siteContentApi } from '../api/client';
import { PRICING_TEXT as T } from '../content/pricingText';
// @ts-ignore -- لا ملف تعريف للوحدة بعد (extractFaq.d.mts)؛ الأنواع مثبّتة بالتحويل أدناه
import * as faqMod from '../blog/extractFaq.mjs';
// @ts-ignore -- لا ملف تعريف للوحدة بعد (clusters.d.mts)؛ الأنواع مثبّتة بالتحويل أدناه
import * as clustersMod from '../blog/clusters.mjs';

// أسئلة التسعير وسكيما Product+FAQPage من المصدر نفسه الذي يصيّره prerender.mjs للزاحف:
// كانت الأسئلة في HTML المُصيَّر وFAQPage وحدهما، فتختفي من الصفحة بعد إقلاع React وتبقى في السكيما.
const { pricingFaq, pricingJsonLd } = faqMod as {
  pricingFaq: (lang: string, plans: Plan[]) => { q: string; a: string }[];
  pricingJsonLd: (lang: string, plans: Plan[], canonical: string) => object;
};
// الوصف وأقسام «كم تدفع شركتك» و«لكل شركة» و«ما المشمول» ورابط الربط من المصدر نفسه الذي يصيّره prerender.mjs (P7)
const { pricingTitle, pricingDescription, pricingSections, phase2LinkFor } = clustersMod as {
  pricingTitle: (lang: string) => string;
  pricingDescription: (lang: string, plans: Plan[]) => string;
  pricingSections: (lang: string, plans: Plan[]) => { h2: string; paras?: string[]; items?: string[] }[];
  phase2LinkFor: (lang: string) => { href: string; label: string };
};

/**
 * صفحة التسعير الشفّافة.
 *
 * لماذا تستحق صفحة مستقلّة: أغلب مورّدي هذا السوق يخفون أسعارهم، فاستعلامات
 * «كم سعر…» شاغرة تقريباً. وإعلان السعر ليس تجميلاً بل شرط عملي: من يعتمد
 * البحث العضوي لا يملك ترف إخفاء الرقم.
 *
 * قرارات مقصودة:
 * - **الأسعار من الـCMS** (نفس مصدر الصفحة الرئيسية) لا مكتوبة هنا — وإلا انزاحت
 *   صامتاً كما حدث سابقاً حين نُشر سعر لا وجود له للزواحف.
 * - الحاسبة تقارن **نموذجَي تسعير** (لكل شركة مقابل لكل مستخدم) **بلا ذكر اسم أي
 *   منافس** — المقارنة الاسمية تعرّض قانوني وتبقى في صفحات المقارنة المُراجَعة.
 * - نداء الفعل محادثة أو تجربة، لا «اشترك الآن»: لا اشتراك ذاتي في المنتج.
 */

type Lang = 'ar' | 'en' | 'fr';

interface Plan { name: string; price: string; limit?: string; period?: string; features?: string[]; badge?: string }

// مطابق لـ data.pricing.plans في الـCMS (قِيس 10 سبتمبر 2026): ثلاث باقات رقمية.
// لا تُضِف باقة هنا ما لم تُضَف هناك — الاحتياطي يظهر عند تعذّر الشبكة وحده.
const FALLBACK_PLANS: Plan[] = [
  { name: 'المبتدئة', price: '299', limit: 'حتى ٥ مناديب وإداري واحد', period: 'ر.س / شهريا' },
  { name: 'المتوسطة', price: '399', limit: 'حتى 10 مناديب و حسابين إداريين', period: 'ر.س / شهريا', badge: 'الأكثر طلبا' },
  { name: 'الاحترافية', price: '599', limit: 'حتى ٢٠ مندوب و 5 إداريين', period: 'ر.س / شهريا' },
];

/**
 * حدّ المندوبين من نصّ الحدّ (يوحّد الأرقام الهندية). نظيره في scripts/pricing-source.mjs
 * لأن هذا ملفّ تطبيق وذاك ملفّ بناء. لا تُقسِّم الباقات بأرقام مكتوبة يدوياً:
 * كانت الحاسبة تحسب لشركةٍ بثمانية مناديب سعرَ الباقة العليا لأنها تعرف حدَّين فقط.
 */
const repsCap = (limit?: string): number | null => {
  const m = String(limit || '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .match(/\d+/);
  return m ? Number(m[0]) : null;
};

/**
 * أسماء الباقات بالإنجليزية والفرنسية مفتاحُها السعر، لأن الـCMS يخزّن الاسم والحدّ
 * بالعربية وحدها فكانت صفحة /en/pricing تعرضهما عربيَّين للقارئ الإنجليزي والزاحف معاً.
 * الحلّ الجذري حقول en/fr في الـCMS؛ وحتى ذلك الحين يسقط غيرُ المعروف إلى اسم الـCMS.
 */
const PLAN_I18N: Record<string, { en: string; fr: string }> = {
  '299': { en: 'Starter', fr: 'Débutant' },
  '399': { en: 'Growth', fr: 'Croissance' },
  '599': { en: 'Professional', fr: 'Professionnel' },
};

const nf = (n: number) => new Intl.NumberFormat('ar-SA', { maximumFractionDigits: 0 }).format(Math.round(n));

export default function PricingPage() {
  const lang = useLang((s) => s.lang) as Lang;
  const dir = useDir();
  const t = T[lang] || T.ar;
  const path = pathForLocale('/pricing', lang);
  // صفحة التسجيل بلا بادئة لغة في كل اللغات — `/signup` مسار تطبيق يدير لغته بنفسه
  // (isAppRoute): يقرأ اللغة المحفوظة التي ضبطها LocaleSync على `/en/pricing` نفسها.
  // كان الرابط يُبنى بـpathForLocale ⇒ `/en/signup` غير المسجَّل، فيحوّله
  // المسار `*` إلى الرئيسية العربية: لا تسجيل ولا تحويل لزائر الحملة غير العربي.
  // (localizeLinks في LandingPage وprerender.mjs يتركان `/signup` بلا بادئة للسبب نفسه.)
  const signupPath = '/signup';

  // الأسعار من الـCMS — نفس مصدر الصفحة الرئيسية، فلا تنزاح صفحتان عن بعضهما
  const { data: cms } = useQuery({
    queryKey: ['site-content'],
    queryFn: async () => (await siteContentApi.get()).data.data as { pricing?: { plans?: Plan[] } },
    staleTime: 5 * 60 * 1000,
  });
  const plans: Plan[] = cms?.pricing?.plans?.length ? cms.pricing.plans : FALLBACK_PLANS;
  const numeric = plans.filter((p) => /^\d+$/.test(String(p.price)));

  const seo = seoUrls('/pricing', lang); // ع/إ/فر — مطابق للخريطة وللصفحات المُصيَّرة
  const faq = pricingFaq(lang, plans);

  useSeo({
    title: pricingTitle(lang), // مطابق للمُصيَّر (كان يختلف عنه بعلامة استفهام وشَرطة)
    // الوصف يُبنى من الباقات الحيّة لا من حدَّين مكتوبين: بقي «299 حتى ٥ و599 حتى ٢٠»
    // منشوراً بعد إضافة الباقة الوسطى، فوصل جوجل بنيةُ باقتين لا وجود لها. و١٥٠ حرفاً أو أقل (كان ٢٣٤).
    description: pricingDescription(lang, plans),
    keywords: lang === 'ar' ? 'كم سعر برنامج مندوبين المبيعات، سعر برنامج إدارة المناديب، تسعير نظام التوزيع' : undefined,
    canonical: seo.canonical,
    alternates: seo.alternates,
    locale: lang,
    jsonLd: pricingJsonLd(lang, plans, seo.canonical.endsWith('/') ? seo.canonical : `${seo.canonical}/`),
  });

  // حاسبة النموذجين — مدخلات المستخدم لا أرقام مورّدين
  const [reps, setReps] = useState(20);
  const [perUser, setPerUser] = useState(140);
  const [setup, setSetup] = useState(4000);
  const [vat, setVat] = useState(15);

  const calc = useMemo(() => {
    // أوّل باقة يتّسع حدُّها لعدد المناديب — لا شرطٌ ثنائيّ يقفز فوق الباقة الوسطى.
    const tiers = numeric
      .map((p) => ({ price: Number(p.price), cap: repsCap(p.limit) }))
      .filter((t) => t.cap && Number.isFinite(t.price))
      .sort((a, b) => (a.cap as number) - (b.cap as number));
    const hit = tiers.find((t) => reps <= (t.cap as number));
    const ourMonthly = hit ? hit.price : NaN;
    const theirMonthly = reps * perUser;
    const v = 1 + vat / 100;
    const ourYear = Number.isFinite(ourMonthly) ? ourMonthly * 12 * v : NaN;
    const theirYear = (theirMonthly * 12 + setup) * v;
    return { ourMonthly, theirMonthly, ourYear, theirYear, diff: theirYear - ourYear };
  }, [reps, perUser, setup, vat, numeric]);

  const overLimit = reps > 20;

  return (
    <div dir={dir} className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]">
      <header className="border-b border-[#E8E0D2] bg-white/70 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <Link to={pathForLocale('/', lang)} className="flex items-center gap-2 text-sm text-[#6b6357] hover:text-[#1F1A13]">
            <ArrowLeft size={16} className={dir === 'rtl' ? 'rotate-180' : ''} />
            <BrandIcon size={22} />
            <span>{t.back}</span>
          </Link>
          <LanguageToggle variant="light" />
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8">
        <h1 className="text-2xl sm:text-3xl font-bold">{t.title}</h1>
        <p className="text-[#6b6357] mt-2 max-w-2xl leading-relaxed">{t.sub}</p>

        <ul className="flex flex-wrap gap-2 mt-4 text-xs">
          {[t.perCompany, t.vatIncl, t.noSetup, t.noCommit, t.trial].map((x) => (
            <li key={x} className="inline-flex items-center gap-1.5 bg-white border border-[#E8E0D2] rounded-full px-3 py-1.5">
              <Check size={13} className="text-green-600" />{x}
            </li>
          ))}
        </ul>

        {/* الباقات — جدول دلالي حقيقي لا صور ولا حقن بجافاسكربت */}
        <section className="mt-8 grid gap-4 sm:grid-cols-3">
          {plans.map((p) => {
            const isCustom = !/^\d+$/.test(String(p.price));
            const cta = `mt-4 text-center text-sm rounded-lg py-2 ${p.badge ? 'bg-[#E15A30] text-white' : 'border border-[#E8E0D2]'}`;
            return (
              <div key={p.name} className={`bg-white rounded-xl border p-5 flex flex-col ${p.badge ? 'border-[#E15A30] shadow-sm' : 'border-[#E8E0D2]'}`}>
                {p.badge && <span className="self-start text-[10px] bg-[#FBEBE2] text-[#C94E28] px-2 py-0.5 rounded-full mb-2">{p.badge}</span>}
                <h2 className="font-semibold">{lang === 'ar' ? p.name : (PLAN_I18N[String(p.price)]?.[lang] ?? p.name)}</h2>
                <p className="mt-2">
                  <span className="text-3xl font-bold">{p.price}</span>
                  {p.period && <span className="text-xs text-[#9A8F7E]"> {p.period}</span>}
                </p>
                <p className="text-xs text-[#6b6357] mt-1">
                  {lang === 'ar'
                    ? p.limit
                    : repsCap(p.limit)
                      ? (lang === 'fr' ? `Jusqu'à ${repsCap(p.limit)} commerciaux` : `Up to ${repsCap(p.limit)} reps`)
                      : p.limit}
                </p>
                {Array.isArray(p.features) && p.features.length > 0 && (
                  <ul className="mt-3 space-y-1.5 text-xs text-[#4a443a]">
                    {p.features.slice(0, 6).map((f) => (
                      <li key={f} className="flex gap-1.5"><Check size={13} className="text-green-600 shrink-0 mt-0.5" />{f}</li>
                    ))}
                  </ul>
                )}
                {isCustom ? (
                  <a
                    href={waHref(path, { lang })}
                    target="_blank"
                    rel="noopener noreferrer"
                    // تحويل «محادثة واتساب» للباقة المخصّصة — الحملة تهبط على هذه الصفحة. لا نمنع
                    // الانتقال: الرابط يفتح تبويباً جديداً فتبقى الصفحة حيّة ويكتمل البيكسل.
                    onClick={() => trackWhatsApp(refFromPath(path))}
                    className={cta}
                  >
                    {t.talk}
                  </a>
                ) : (
                  // <Link> لا <a>: إعادة تحميل الصفحة تُضيع وسوم الهبوط المحفوظة في الذاكرة
                  // (landingTags في lib/attribution.ts) فتُسجَّل زيارة /signup «مباشرة» بدل
                  // الحملة، وقد يضيع gclid إن سبقت النقرةُ كتابةَ الوسم لكوكي _gcl_aw.
                  <Link to={signupPath} className={cta}>
                    {t.startTrial}
                  </Link>
                )}
              </div>
            );
          })}
        </section>

        {/* كم تدفع شركتك شهرياً، ولماذا السعر لكل شركة، وما المشمول — أرقامها من باقات CMS، شهرية فقط */}
        {pricingSections(lang, plans).map((sec) => (
          <section key={sec.h2} className="mt-8">
            <h2 className="font-semibold">{sec.h2}</h2>
            {(sec.paras || []).map((p) => <p key={p} className="text-sm text-[#6b6357] mt-2 leading-relaxed">{p}</p>)}
            {sec.items && sec.items.length > 0 && (
              <ul className="mt-2 space-y-1.5 text-sm text-[#4a443a] list-disc ps-5">
                {sec.items.map((it) => <li key={it}>{it}</li>)}
              </ul>
            )}
          </section>
        ))}

        {/* حاسبة النموذجين */}
        <section className="mt-10 bg-white rounded-xl border border-[#E8E0D2] p-5">
          <h2 className="font-semibold">{t.calcTitle}</h2>
          <p className="text-xs text-[#6b6357] mt-1">{t.calcSub}</p>

          <div className="grid gap-3 sm:grid-cols-4 mt-4">
            {[
              { l: t.reps, v: reps, set: setReps, min: 1, max: 500 },
              { l: t.perUserPrice, v: perUser, set: setPerUser, min: 0, max: 2000 },
              { l: t.setupFee, v: setup, set: setSetup, min: 0, max: 50000 },
              { l: t.vat, v: vat, set: setVat, min: 0, max: 30 },
            ].map((f) => (
              <label key={f.l} className="block">
                <span className="block text-[11px] text-[#6b6357] mb-1">{f.l}</span>
                <input
                  type="number" inputMode="numeric" min={f.min} max={f.max} value={f.v}
                  onChange={(e) => f.set(Math.max(f.min, Math.min(f.max, Number(e.target.value) || 0)))}
                  className="w-full border border-[#E8E0D2] rounded-lg px-3 py-2 text-sm tabular-nums"
                />
              </label>
            ))}
          </div>

          {overLimit ? (
            <div className="mt-5 text-sm bg-[#FBEBE2] border border-[#F0C9B6] rounded-lg p-3 flex gap-2">
              <Info size={16} className="shrink-0 mt-0.5 text-[#C94E28]" />
              <span>{t.overLimit}</span>
            </div>
          ) : (
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-[#E15A30] p-4">
                <p className="text-xs text-[#6b6357]">{t.ourModel}</p>
                <p className="text-2xl font-bold mt-1 tabular-nums" dir="ltr">{nf(calc.ourMonthly)} <span className="text-xs font-normal">ر.س / {t.monthly}</span></p>
                <p className="text-xs text-[#6b6357] mt-1">{t.year1}: <b className="tabular-nums" dir="ltr">{nf(calc.ourYear)}</b> ر.س</p>
              </div>
              <div className="rounded-lg border border-[#E8E0D2] p-4">
                <p className="text-xs text-[#6b6357]">{t.theirModel}</p>
                <p className="text-2xl font-bold mt-1 tabular-nums" dir="ltr">{nf(calc.theirMonthly)} <span className="text-xs font-normal">ر.س / {t.monthly}</span></p>
                <p className="text-xs text-[#6b6357] mt-1">{t.year1}: <b className="tabular-nums" dir="ltr">{nf(calc.theirYear)}</b> ر.س</p>
              </div>
              {Number.isFinite(calc.diff) && calc.diff > 0 && (
                <p className="sm:col-span-2 text-sm text-green-700">
                  {t.save}: <b className="tabular-nums" dir="ltr">{nf(calc.diff)}</b> ر.س
                </p>
              )}
            </div>
          )}
          <p className="text-[11px] text-[#9A8F7E] mt-3">{t.calcNote}</p>
        </section>

        {/* صندوق الإنصاف — إلزامي في كل صفحة تلمّح للامتثال */}
        <section className="mt-8 bg-white rounded-xl border border-[#E8E0D2] p-5">
          <h2 className="font-semibold text-sm">{t.fairTitle}</h2>
          <p className="text-xs text-[#6b6357] mt-2 leading-relaxed">
            {t.fairBody.replace(/\*\*/g, '')}
          </p>
          <Link to={phase2LinkFor(lang).href} className="inline-block mt-2 text-xs font-semibold text-[#C94E28] hover:underline">
            {phase2LinkFor(lang).label}
          </Link>
        </section>

        {/* أسئلة التسعير — ظاهرة لأن FAQPage في سكيما الصفحة لا تصحّ إلا لأسئلة يراها الزائر */}
        {faq.length > 0 && (
          <section className="mt-8">
            <h2 className="font-semibold">{t.faqTitle}</h2>
            <dl className="mt-3 space-y-3">
              {faq.map((f) => (
                <div key={f.q} className="bg-white border border-[#E8E0D2] rounded-xl p-4">
                  <dt className="font-medium text-sm">{f.q}</dt>
                  <dd className="text-xs text-[#6b6357] mt-1.5 leading-relaxed">{f.a}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        <div className="mt-8 flex flex-wrap gap-3">
          <a href={waHref(path, { lang })} target="_blank" rel="noopener noreferrer"
             onClick={() => trackWhatsApp(refFromPath(path))}
             className="inline-flex items-center gap-2 bg-[#25D366] text-white rounded-lg px-4 py-2.5 text-sm">
            <MessageCircle size={16} />{t.talk}
          </a>
          <Link to={signupPath} className="inline-flex items-center gap-2 border border-[#E8E0D2] bg-white rounded-lg px-4 py-2.5 text-sm">
            {t.startTrial}
          </Link>
        </div>
      </main>
    </div>
  );
}
