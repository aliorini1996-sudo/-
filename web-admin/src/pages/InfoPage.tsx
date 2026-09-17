import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { siteContentApi } from '../api/client';
import { defaultContent } from '../landing/defaultContent';
import { defaultContentEn } from '../landing/defaultContentEn';
import { defaultContentFr } from '../landing/defaultContentFr';
import { defaultContentTr } from '../landing/defaultContentTr';
import { defaultContentZh } from '../landing/defaultContentZh';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft } from 'lucide-react';
import LanguageToggle from '../components/LanguageToggle';
import { useLang, useDir } from '../i18n/lang';
import { useT } from '../i18n/strings';
import { useSeo } from '../lib/seo';
import { seoUrls, pathForLocale } from '../i18n/locale';
import { optOut, optIn, isOptedOut, isExplicitOptOut } from '../lib/attribution';

type PageKey = 'about' | 'terms' | 'serviceAgreement' | 'privacy';
type SeoText = { title: string; description: string; keywords: string };

// SEO لكل صفحة فرعية — عناوين/أوصاف/كلمات فريدة بالعربية والإنجليزية والفرنسية
const PAGE_SEO: Record<PageKey, { path: string; ar: SeoText; en: SeoText; fr: SeoText }> = {
  about: {
    path: 'about',
    ar: {
      title: 'من نحن | FieldSales نظام إدارة المبيعات الميدانية والتوزيع في السعودية',
      description: 'تعرف على FieldSales المنصة السعودية لإدارة مبيعات مناديب التوزيع الطلبات فواتير ZATCA التحصيل مخزون سيارة المندوب وتتبع المناديب لإدارة فرقك الميدانية بكفاءة وشفافية',
      keywords: 'من نحن FieldSales فيلد سيلز نظام مبيعات ميدانية شركة برمجيات توزيع إدارة مناديب التوزيع السعودية',
    },
    en: {
      title: 'About Us | FieldSales Field Sales & Distribution Management System',
      description: 'Learn about FieldSales the platform to manage field distribution reps orders ZATCA invoices payment collection van stock and GPS tracking run your field teams efficiently and transparently',
      keywords: 'about FieldSales field sales system distribution software company sales rep management route accounting',
    },
    fr: {
      title: 'À propos | FieldSales Système de gestion des ventes terrain et de la distribution',
      description: 'Découvrez FieldSales la plateforme de gestion des commerciaux de distribution commandes factures encaissement stock du véhicule et suivi GPS gérez vos équipes terrain efficacement et en toute transparence',
      keywords: 'à propos FieldSales système de vente terrain logiciel de distribution gestion des commerciaux Maroc Algérie Tunisie',
    },
  },
  terms: {
    path: 'terms',
    ar: {
      title: 'الشروط والأحكام | FieldSales فيلد سيلز',
      description: 'الشروط والأحكام لاستخدام منصة FieldSales لإدارة المبيعات الميدانية والتوزيع الفوترة الضريبية ZATCA والتحصيل',
      keywords: 'الشروط والأحكام شروط الاستخدام اتفاقية المستخدم FieldSales',
    },
    en: {
      title: 'Terms & Conditions | FieldSales',
      description: 'Terms and conditions for using the FieldSales field sales and distribution platform e-invoicing and collection',
      keywords: 'terms and conditions terms of use user agreement FieldSales',
    },
    fr: {
      title: 'Conditions générales | FieldSales',
      description: 'Conditions générales d utilisation de la plateforme FieldSales de gestion des ventes terrain et de la distribution facturation électronique et encaissement',
      keywords: 'conditions générales conditions d utilisation contrat utilisateur FieldSales',
    },
  },
  serviceAgreement: {
    path: 'service-agreement',
    ar: {
      title: 'اتفاقية الخدمة | FieldSales فيلد سيلز',
      description: 'اتفاقية خدمة FieldSales نطاق الخدمة ومستوى التوفر والدعم لنظام إدارة مبيعات المناديب الميدانيين والتوزيع',
      keywords: 'اتفاقية الخدمة مستوى الخدمة SLA الدعم الفني FieldSales',
    },
    en: {
      title: 'Service Agreement | FieldSales',
      description: 'FieldSales service agreement service scope availability and support for the field sales and distribution management system',
      keywords: 'service agreement SLA technical support FieldSales',
    },
    fr: {
      title: 'Contrat de service | FieldSales',
      description: 'Contrat de service FieldSales étendue du service disponibilité et support du système de gestion des ventes terrain et de la distribution',
      keywords: 'contrat de service SLA support technique FieldSales',
    },
  },
  privacy: {
    path: 'privacy',
    ar: {
      title: 'سياسة الخصوصية | FieldSales فيلد سيلز',
      description: 'سياسة خصوصية FieldSales وحماية بيانات شركتك في نظام إدارة المبيعات الميدانية عزل كامل لكل شركة واتصال مشفر',
      keywords: 'سياسة الخصوصية حماية البيانات خصوصية البيانات أمان المعلومات FieldSales',
    },
    en: {
      title: 'Privacy Policy | FieldSales',
      description: 'FieldSales privacy policy and how we protect your company data in the field sales management system full per-company isolation and encrypted connections',
      keywords: 'privacy policy data protection data privacy information security FieldSales',
    },
    fr: {
      title: 'Politique de confidentialité | FieldSales',
      description: 'Politique de confidentialité de FieldSales et protection des données de votre entreprise isolation logique par entreprise et connexions chiffrées',
      keywords: 'politique de confidentialité protection des données sécurité de l information FieldSales',
    },
  },
};

/** نصوص زرّ «إيقاف القياس» — سياسة الخصوصية (القسم ٧) تحيل إليه */
const OPTOUT_TEXT = {
  ar: {
    title: 'إيقاف القياس على هذا المتصفح',
    body: 'يوقف هذا الزر على هذا المتصفح معرف الزائر ومعرف الجلسة ومصدر الزيارة الأولى ووسم Google Ads ويحذف ما خزناه منها ولا يشمل إحصاءات الزيارة الأساسية المبينة في القسم ٧',
    stop: 'أوقف القياس',
    stoppedByYou: 'القياس متوقف على هذا المتصفح بناء على طلبك',
    resume: 'استئناف القياس',
    stoppedByBrowser: 'القياس متوقف على هذا المتصفح بسبب إشارة الخصوصية في متصفحك أو حظر التخزين المحلي',
  },
  en: {
    title: 'Stop measurement on this browser',
    body: 'This button turns off the visitor ID, session ID, first-visit source and Google Ads tag on this browser and deletes what we stored. It does not cover the basic visit statistics described in Section 7.',
    stop: 'Stop measurement',
    stoppedByYou: 'Measurement is stopped on this browser at your request.',
    resume: 'Resume measurement',
    stoppedByBrowser: 'Measurement is stopped on this browser because of your browser privacy signal or blocked local storage.',
  },
  fr: {
    title: 'Arrêter la mesure sur ce navigateur',
    body: 'Ce bouton désactive sur ce navigateur l’identifiant visiteur, l’identifiant de session, la source de la première visite et la balise Google Ads, et supprime ce que nous avons enregistré. Il ne couvre pas les statistiques de visite de base décrites à la section 7.',
    stop: 'Arrêter la mesure',
    stoppedByYou: 'La mesure est arrêtée sur ce navigateur à votre demande.',
    resume: 'Reprendre la mesure',
    stoppedByBrowser: 'La mesure est arrêtée sur ce navigateur en raison du signal de confidentialité de votre navigateur ou du blocage du stockage local.',
  },
  tr: {
    title: 'Bu tarayıcıda ölçümü durdur',
    body: 'Bu düğme bu tarayıcıda ziyaretçi kimliğini, oturum kimliğini, ilk ziyaret kaynağını ve Google Ads etiketini kapatır ve kaydettiğimiz verileri siler. Bölüm 7’de açıklanan temel ziyaret istatistiklerini kapsamaz.',
    stop: 'Ölçümü durdur',
    stoppedByYou: 'İsteğiniz üzerine bu tarayıcıda ölçüm durduruldu.',
    resume: 'Ölçümü sürdür',
    stoppedByBrowser: 'Tarayıcınızın gizlilik sinyali veya engellenen yerel depolama nedeniyle bu tarayıcıda ölçüm durduruldu.',
  },
  zh: {
    title: '在此浏览器上停止衡量',
    body: '此按钮会在你所用的浏览器上停止衡量：停用访问者标识符、会话标识符、首次访问来源和 Google Ads 代码，并删除已存储的相关数据。它不包括第 7 节所述的最基本的访问统计。',
    stop: '停止统计',
    stoppedByYou: '已按你的要求在此浏览器上停止衡量。',
    resume: '恢复衡量',
    stoppedByBrowser: '由于你的浏览器发出隐私信号或阻止了本地存储，此浏览器上的衡量已停止。',
  },
} as const;

/**
 * زرّ «إيقاف القياس» — الوسيلة الظاهرة لممارسة حق الاعتراض الذي تَعِد به السياسة
 * (القسمان ٦ و٧). قبله كانت `optOut()` بلا أي مستدعٍ، فلا يملك زائر Safari (بلا DNT)
 * طريقة لإيقاف وسم الإعلانات سوى حظر التخزين كلّه. إعادة التحميل تضمن ألّا يبقى
 * وسم محمَّل في ذاكرة الصفحة.
 */
function MeasurementControl({ lang }: { lang: string }) {
  const tx = OPTOUT_TEXT[(lang in OPTOUT_TEXT ? lang : 'ar') as keyof typeof OPTOUT_TEXT];
  const [state] = useState(() => ({ off: isOptedOut(), explicit: isExplicitOptOut() }));
  const reload = () => { try { window.location.reload(); } catch { /* تجاهل */ } };
  return (
    <section id="optout" className="mt-6 bg-white rounded-2xl border border-[#E9E1D3] p-6 lg:p-7">
      <h2 className="text-lg font-bold text-[#1F1A13]">{tx.title}</h2>
      {!state.off && (
        <>
          <p className="text-sm text-[#6E6557] mt-2 leading-relaxed">{tx.body}</p>
          <button type="button" onClick={() => { void optOut().then(reload); }}
            className="mt-4 rounded-xl bg-[#1F1A13] text-[#FAF7F0] px-5 py-2.5 text-sm font-semibold hover:bg-[#E15A30] transition-colors">
            {tx.stop}
          </button>
        </>
      )}
      {state.off && state.explicit && (
        <>
          <p className="text-sm text-[#6E6557] mt-2 leading-relaxed" role="status">{tx.stoppedByYou}</p>
          <button type="button" onClick={() => { optIn(); reload(); }}
            className="mt-4 rounded-xl border border-[#E9E1D3] px-5 py-2.5 text-sm font-semibold text-[#1F1A13] hover:border-[#E15A30] transition-colors">
            {tx.resume}
          </button>
        </>
      )}
      {state.off && !state.explicit && (
        <p className="text-sm text-[#6E6557] mt-2 leading-relaxed" role="status">{tx.stoppedByBrowser}</p>
      )}
    </section>
  );
}

// صفحة نصّية عامة (من نحن / الشروط / اتفاقية الخدمة / الخصوصية) — محتواها من CMS
export default function InfoPage({ pageKey }: { pageKey: PageKey }) {
  const lang = useLang((s) => s.lang);
  const dir = useDir();
  const t = useT();
  const { data } = useQuery({
    queryKey: ['site-content'],
    queryFn: async () => { const r = await siteContentApi.get(); return r.data.data as unknown; },
    staleTime: 60_000,
  });
  // نُفضّل المحتوى الأغنى للعربية: إن كان نصّ الـCMS أطول من الافتراضي فهو تخصيص فعلي للمالك،
  // وإلا نعرض الوثيقة الاحترافية من الكود (الوثائق القانونية المحدّثة) بدل نصّ CMS قديم قصير.
  // سياسة الخصوصية **من الكود دائماً**: تصف سلوك الكود نفسه (الوسم والمعرّفات والمسارات)،
  // ونصّ CMS القديم فيها يَعِد بـ«لا أغراض إعلانية»؛ لو طال يوماً لعاد وعده الكاذب إلى الصفحة.
  // القاعدة نفسها في scripts/prerender.mjs (loadPrivacyHtml).
  const cmsPage = (data as typeof defaultContent | null | undefined)?.pages?.[pageKey];
  const defPage = defaultContent.pages[pageKey];
  const arPage = pageKey !== 'privacy' && cmsPage && (cmsPage.body?.length || 0) > (defPage.body?.length || 0) ? cmsPage : defPage;
  const page = lang === 'en' ? defaultContentEn.pages[pageKey]
    : lang === 'fr' ? defaultContentFr.pages[pageKey]
    : lang === 'tr' ? defaultContentTr.pages[pageKey]
    : lang === 'zh' ? defaultContentZh.pages[pageKey]
    : arPage;

  const seo = PAGE_SEO[pageKey];
  const m = lang === 'en' || lang === 'tr' || lang === 'zh' ? seo.en : lang === 'fr' ? seo.fr : seo.ar; // tr/zh: ميتا إنجليزية مؤقتاً
  const home = pathForLocale('/', lang); // العودة للرئيسية بنفس اللغة الحالية
  const { canonical, alternates } = seoUrls(`/${seo.path}`, lang);
  useSeo({
    title: m.title,
    description: m.description,
    keywords: m.keywords,
    locale: lang,
    canonical,
    alternates,
    image: 'https://fieldsa.net/og-image.png',
  });

  return (
    <div dir={dir} className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]" style={{ fontFamily: "'Noto Kufi Arabic', 'IBM Plex Sans', system-ui, sans-serif" }}>
      <header className="sticky top-0 z-20 border-b border-[#E9E1D3] bg-[#FAF7F0]/85 backdrop-blur">
        <div className="max-w-3xl mx-auto px-5 h-16 flex items-center justify-between">
          <Link to={home} className="flex items-center gap-2.5">
            <BrandIcon size={34} />
            <span style={{ fontFamily: "'IBM Plex Serif', serif", fontWeight: 600, letterSpacing: '-0.3px' }} className="text-xl">
              <span className="text-[#1F1A13]">Field</span> <span className="text-[#E15A30]">Sales</span>
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <Link to={home} className="text-sm font-semibold text-[#6E6557] hover:text-[#E15A30] flex items-center gap-1 transition-colors">
              {t('common.backHome')} <ArrowLeft size={15} className={dir === 'rtl' ? '' : 'rotate-180'} />
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-5 py-14">
        <h1 className="text-3xl lg:text-4xl font-extrabold tracking-tight mb-7">{page.title}</h1>
        <div className="bg-white rounded-2xl border border-[#E9E1D3] p-7 lg:p-9 text-[#3a342b] leading-loose text-[16px] whitespace-pre-line">
          {page.body}
        </div>
        {pageKey === 'privacy' && <MeasurementControl lang={lang} />}
      </main>

      <footer className="border-t border-[#E9E1D3] py-6 text-center text-xs text-[#9A8F7E]">
        © {new Date().getFullYear()} Field Sales — fieldsa.net
      </footer>
    </div>
  );
}
