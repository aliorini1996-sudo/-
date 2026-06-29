import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { siteContentApi } from '../api/client';
import { defaultContent } from '../landing/defaultContent';
import { defaultContentEn } from '../landing/defaultContentEn';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft } from 'lucide-react';
import LanguageToggle from '../components/LanguageToggle';
import { useLang, useDir } from '../i18n/lang';
import { useT } from '../i18n/strings';
import { useSeo } from '../lib/seo';

type PageKey = 'about' | 'terms' | 'serviceAgreement' | 'privacy';

// SEO لكل صفحة فرعية — عناوين وأوصاف فريدة بكلمات مفتاحية متعلّقة بالخدمات
const PAGE_SEO: Record<PageKey, { path: string; title: string; description: string; keywords: string }> = {
  about: {
    path: 'about',
    title: 'من نحن | FieldSales — نظام إدارة المبيعات الميدانية والتوزيع في السعودية',
    description: 'تعرّف على FieldSales، المنصّة السعودية لإدارة مبيعات مناديب التوزيع: الطلبات، فواتير ZATCA، التحصيل، مخزون سيارة المندوب، وتتبّع المناديب — لإدارة فرقك الميدانية بكفاءة وشفافية.',
    keywords: 'من نحن, FieldSales فيلد سيلز, نظام مبيعات ميدانية, شركة برمجيات توزيع, إدارة مناديب التوزيع, السعودية',
  },
  terms: {
    path: 'terms',
    title: 'الشروط والأحكام | FieldSales فيلد سيلز',
    description: 'الشروط والأحكام لاستخدام منصّة FieldSales لإدارة المبيعات الميدانية والتوزيع، الفوترة الضريبية ZATCA، والتحصيل.',
    keywords: 'الشروط والأحكام, شروط الاستخدام, اتفاقية المستخدم, FieldSales',
  },
  serviceAgreement: {
    path: 'service-agreement',
    title: 'اتفاقية الخدمة | FieldSales فيلد سيلز',
    description: 'اتفاقية خدمة FieldSales: نطاق الخدمة ومستوى التوفّر والدعم لنظام إدارة مبيعات المناديب الميدانيين والتوزيع.',
    keywords: 'اتفاقية الخدمة, مستوى الخدمة SLA, الدعم الفني, FieldSales',
  },
  privacy: {
    path: 'privacy',
    title: 'سياسة الخصوصية | FieldSales فيلد سيلز',
    description: 'سياسة خصوصية FieldSales وحماية بيانات شركتك في نظام إدارة المبيعات الميدانية — عزل كامل لكل شركة واتصال مشفّر.',
    keywords: 'سياسة الخصوصية, حماية البيانات, خصوصية البيانات, أمان المعلومات, FieldSales',
  },
};

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
  const content = (data || defaultContent) as typeof defaultContent;
  const page = lang === 'en'
    ? defaultContentEn.pages[pageKey]
    : (content.pages?.[pageKey] || defaultContent.pages[pageKey]);

  const seo = PAGE_SEO[pageKey];
  useSeo({
    title: seo.title,
    description: seo.description,
    keywords: seo.keywords,
    canonical: `https://fieldsa.net/${seo.path}`,
    image: 'https://fieldsa.net/og-image.png',
  });

  return (
    <div dir={dir} className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]" style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}>
      <header className="sticky top-0 z-20 border-b border-[#E9E1D3] bg-[#FAF7F0]/85 backdrop-blur">
        <div className="max-w-3xl mx-auto px-5 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5">
            <BrandIcon size={34} />
            <span style={{ fontFamily: "'IBM Plex Serif', serif", fontWeight: 600, letterSpacing: '-0.3px' }} className="text-xl">
              <span className="text-[#1F1A13]">Field</span> <span className="text-[#E15A30]">Sales</span>
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <Link to="/" className="text-sm font-semibold text-[#6E6557] hover:text-[#E15A30] flex items-center gap-1 transition-colors">
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
      </main>

      <footer className="border-t border-[#E9E1D3] py-6 text-center text-xs text-[#9A8F7E]">
        © {new Date().getFullYear()} Field Sales — fieldsa.net
      </footer>
    </div>
  );
}
