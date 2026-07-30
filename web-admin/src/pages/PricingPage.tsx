import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BrandIcon } from '../components/BrandLogo';
import { Check, MessageCircle, ArrowLeft, Info } from 'lucide-react';
import LanguageToggle from '../components/LanguageToggle';
import { useLang, useDir } from '../i18n/lang';
import { useSeo } from '../lib/seo';
import { seoUrls, pathForLocale } from '../i18n/locale';
import { waHref } from '../components/WhatsAppFab';
import { useQuery } from '@tanstack/react-query';
import { siteContentApi } from '../api/client';

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

const FALLBACK_PLANS: Plan[] = [
  { name: 'المبتدئة', price: '299', limit: 'حتى ٥ مناديب', period: 'ر.س / شهرياً' },
  { name: 'الاحترافية', price: '599', limit: 'حتى ٢٠ مندوبًا', period: 'ر.س / شهرياً', badge: 'الأكثر طلبًا' },
  { name: 'المؤسسات', price: 'حسب الطلب', limit: 'مناديب غير محدودين', period: '' },
];

const T: Record<Lang, Record<string, string>> = {
  ar: {
    back: 'الرئيسية',
    title: 'أسعار Field Sales — معلنة وبلا رسوم خفية',
    sub: 'السعر لكل شركة لا لكل مستخدم. إضافة مندوب ضمن حدّ باقتك لا تزيد فاتورتك.',
    perCompany: 'لكل شركة لا لكل مستخدم',
    noSetup: 'بلا رسوم تأسيس أو إعداد',
    vatIncl: 'شامل ضريبة القيمة المضافة',
    noCommit: 'بلا التزام سنوي',
    trial: 'تجربة ١٠ أيام بلا بطاقة ائتمان',
    talk: 'تحدّث معنا على واتساب',
    startTrial: 'ابدأ التجربة المجانية',
    calcTitle: 'احسب الفرق بين نموذجَي التسعير',
    calcSub: 'أغلب البدائل تسعّر لكل مندوب. أدخل عدد مناديبك وقارن الفاتورة السنوية.',
    reps: 'عدد المناديب',
    perUserPrice: 'سعر المندوب الواحد شهرياً لدى البديل (ر.س)',
    setupFee: 'رسوم تأسيس لمرة واحدة لدى البديل (ر.س)',
    vat: 'ضريبة القيمة المضافة %',
    ourModel: 'نموذجنا — لكل شركة',
    theirModel: 'النموذج الشائع — لكل مندوب',
    year1: 'إجمالي السنة الأولى',
    monthly: 'شهرياً',
    save: 'الفرق في السنة الأولى',
    calcNote: 'الأرقام التي تُدخلها افتراضاتك أنت. لا نذكر اسم أي مورّد هنا ولا نقدّر سعراً لمن لا يعلنه.',
    overLimit: 'فوق ٢٠ مندوبًا: نحدّد السعر بالمحادثة حسب حجمك — لا رقم معلن نخترعه.',
    faqTitle: 'أسئلة عن التسعير',
    fairTitle: 'ما لا نملكه — بصراحة',
    fairBody: 'ندعم الفاتورة الإلكترونية **المرحلة الأولى** (رمز QR بترميز TLV) فقط؛ المرحلة الثانية (الربط والتكامل) غير مبنية لدينا حتى الآن. وهيئة الزكاة والضريبة والجمارك لا تعتمد ولا تصادق مزوّدي البرمجيات، فلا ندّعي اعتماداً منها. وليست لدينا شهادات SOC2 أو ISO.',
  },
  en: {
    back: 'Home',
    title: 'Field Sales pricing — published, with no hidden fees',
    sub: 'Priced per company, not per user. Adding a rep within your plan limit does not raise your bill.',
    perCompany: 'Per company, not per user',
    vatIncl: 'VAT included',
    noSetup: 'No setup or onboarding fees',
    noCommit: 'No annual lock-in',
    trial: '10-day trial, no credit card',
    talk: 'Talk to us on WhatsApp',
    startTrial: 'Start the free trial',
    calcTitle: 'Compare the two pricing models',
    calcSub: 'Most alternatives charge per rep. Enter your team size and compare the first-year bill.',
    reps: 'Number of reps',
    perUserPrice: 'Alternative price per rep per month (SAR)',
    setupFee: 'One-off setup fee at the alternative (SAR)',
    vat: 'VAT %',
    ourModel: 'Our model — per company',
    theirModel: 'Common model — per rep',
    year1: 'First-year total',
    monthly: 'monthly',
    save: 'First-year difference',
    calcNote: 'The figures you enter are your own assumptions. We name no vendor here and never estimate a price for one who does not publish it.',
    overLimit: 'Above 20 reps: we set the price in conversation based on your size — we do not invent a published number.',
    faqTitle: 'Pricing questions',
    fairTitle: 'What we do not have — plainly',
    fairBody: 'We support **phase one** of e-invoicing (TLV QR code) only; phase two (integration) is not built yet. ZATCA does not certify or approve software vendors, so we claim no approval from it. We hold no SOC2 or ISO certification.',
  },
  fr: {
    back: 'Accueil',
    title: 'Tarifs Field Sales — publiés, sans frais cachés',
    sub: 'Par entreprise, pas par utilisateur. Ajouter un commercial dans la limite de votre offre n’augmente pas la facture.',
    perCompany: 'Par entreprise, pas par utilisateur',
    vatIncl: 'TVA incluse',
    noSetup: 'Aucuns frais de mise en service',
    noCommit: 'Sans engagement annuel',
    trial: 'Essai 10 jours, sans carte',
    talk: 'Discutez avec nous sur WhatsApp',
    startTrial: 'Démarrer l’essai gratuit',
    calcTitle: 'Comparez les deux modèles tarifaires',
    calcSub: 'La plupart des alternatives facturent par commercial. Entrez la taille de votre équipe.',
    reps: 'Nombre de commerciaux',
    perUserPrice: 'Prix par commercial et par mois chez l’alternative (SAR)',
    setupFee: 'Frais de mise en service uniques (SAR)',
    vat: 'TVA %',
    ourModel: 'Notre modèle — par entreprise',
    theirModel: 'Modèle courant — par commercial',
    year1: 'Total première année',
    monthly: 'par mois',
    save: 'Écart sur la première année',
    calcNote: 'Les chiffres saisis sont vos propres hypothèses. Nous ne nommons aucun fournisseur ici.',
    overLimit: 'Au-delà de 20 commerciaux : le prix se définit en conversation — nous n’inventons aucun chiffre publié.',
    faqTitle: 'Questions sur les tarifs',
    fairTitle: 'Ce que nous n’avons pas — clairement',
    fairBody: 'Nous prenons en charge la **phase un** de la facturation électronique (QR TLV) uniquement ; la phase deux n’est pas développée. La ZATCA ne certifie aucun éditeur, nous ne revendiquons donc aucune homologation.',
  },
};

const nf = (n: number) => new Intl.NumberFormat('ar-SA', { maximumFractionDigits: 0 }).format(Math.round(n));

export default function PricingPage() {
  const lang = useLang((s) => s.lang) as Lang;
  const dir = useDir();
  const t = T[lang] || T.ar;
  const path = pathForLocale('/pricing', lang);

  // الأسعار من الـCMS — نفس مصدر الصفحة الرئيسية، فلا تنزاح صفحتان عن بعضهما
  const { data: cms } = useQuery({
    queryKey: ['site-content'],
    queryFn: async () => (await siteContentApi.get()).data.data as { pricing?: { plans?: Plan[] } },
    staleTime: 5 * 60 * 1000,
  });
  const plans: Plan[] = cms?.pricing?.plans?.length ? cms.pricing.plans : FALLBACK_PLANS;
  const numeric = plans.filter((p) => /^\d+$/.test(String(p.price)));
  const entry = numeric[0]?.price || '299';
  const top = numeric[numeric.length - 1]?.price || '599';

  useSeo({
    title: lang === 'ar' ? 'كم سعر برنامج مندوبين المبيعات؟ | Field Sales' : t.title,
    description: lang === 'ar'
      ? `أسعار Field Sales معلنة: ${entry} ر.س حتى ٥ مناديب و${top} ر.س حتى ٢٠ مندوبًا شامل ضريبة القيمة المضافة — لكل شركة لا لكل مستخدم، بلا رسوم تأسيس، وتجربة ١٠ أيام بلا بطاقة.`
      : `${entry}–${top} SAR per month, VAT included, per company not per user. No setup fees. 10-day free trial, no credit card.`,
    keywords: lang === 'ar' ? 'كم سعر برنامج مندوبين المبيعات، سعر برنامج إدارة المناديب، تسعير نظام التوزيع' : undefined,
    canonical: seoUrls('/pricing', lang).canonical,
    alternates: seoUrls('/pricing', lang).alternates,
    locale: lang,
  });

  // حاسبة النموذجين — مدخلات المستخدم لا أرقام مورّدين
  const [reps, setReps] = useState(20);
  const [perUser, setPerUser] = useState(140);
  const [setup, setSetup] = useState(4000);
  const [vat, setVat] = useState(15);

  const calc = useMemo(() => {
    const ourMonthly = reps <= 5 ? Number(entry) : reps <= 20 ? Number(top) : NaN;
    const theirMonthly = reps * perUser;
    const v = 1 + vat / 100;
    const ourYear = Number.isFinite(ourMonthly) ? ourMonthly * 12 * v : NaN;
    const theirYear = (theirMonthly * 12 + setup) * v;
    return { ourMonthly, theirMonthly, ourYear, theirYear, diff: theirYear - ourYear };
  }, [reps, perUser, setup, vat, entry, top]);

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
            return (
              <div key={p.name} className={`bg-white rounded-xl border p-5 flex flex-col ${p.badge ? 'border-[#E15A30] shadow-sm' : 'border-[#E8E0D2]'}`}>
                {p.badge && <span className="self-start text-[10px] bg-[#FBEBE2] text-[#C94E28] px-2 py-0.5 rounded-full mb-2">{p.badge}</span>}
                <h2 className="font-semibold">{p.name}</h2>
                <p className="mt-2">
                  <span className="text-3xl font-bold">{p.price}</span>
                  {p.period && <span className="text-xs text-[#9A8F7E]"> {p.period}</span>}
                </p>
                <p className="text-xs text-[#6b6357] mt-1">{p.limit}</p>
                {Array.isArray(p.features) && p.features.length > 0 && (
                  <ul className="mt-3 space-y-1.5 text-xs text-[#4a443a]">
                    {p.features.slice(0, 6).map((f) => (
                      <li key={f} className="flex gap-1.5"><Check size={13} className="text-green-600 shrink-0 mt-0.5" />{f}</li>
                    ))}
                  </ul>
                )}
                <a
                  href={isCustom ? waHref(path, { lang }) : pathForLocale('/signup', lang)}
                  target={isCustom ? '_blank' : undefined}
                  rel={isCustom ? 'noopener noreferrer' : undefined}
                  className={`mt-4 text-center text-sm rounded-lg py-2 ${p.badge ? 'bg-[#E15A30] text-white' : 'border border-[#E8E0D2]'}`}
                >
                  {isCustom ? t.talk : t.startTrial}
                </a>
              </div>
            );
          })}
        </section>

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
        </section>

        <div className="mt-8 flex flex-wrap gap-3">
          <a href={waHref(path, { lang })} target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-2 bg-[#25D366] text-white rounded-lg px-4 py-2.5 text-sm">
            <MessageCircle size={16} />{t.talk}
          </a>
          <Link to={pathForLocale('/signup', lang)} className="inline-flex items-center gap-2 border border-[#E8E0D2] bg-white rounded-lg px-4 py-2.5 text-sm">
            {t.startTrial}
          </Link>
        </div>
      </main>
    </div>
  );
}
