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

type PageKey = 'about' | 'terms' | 'serviceAgreement' | 'privacy';

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

  return (
    <div dir={dir} className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]" style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}>
      <header className="sticky top-0 z-20 border-b border-[#E9E1D3] bg-[#FAF7F0]/85 backdrop-blur">
        <div className="max-w-3xl mx-auto px-5 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5">
            <BrandIcon size={34} />
            <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 700 }} className="text-lg">
              <span className="text-[#1F1A13]">Field</span><span className="text-[#E15A30]">Sales</span>
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
