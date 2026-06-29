import { Globe } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLang } from '../i18n/lang';
import { pathForLocale } from '../i18n/locale';

// زر تبديل اللغة (عربي/English) — ينتقل بين الرابط العربي و/en (روابط منفصلة للفهرسة الدولية)
export default function LanguageToggle({ variant = 'light' }: { variant?: 'light' | 'dark' | 'floating' }) {
  const lang = useLang((s) => s.lang);
  const loc = useLocation();
  const navigate = useNavigate();
  const label = lang === 'ar' ? 'English' : 'العربية';
  const toggle = () => navigate(pathForLocale(loc.pathname, lang === 'ar' ? 'en' : 'ar'));

  const base = 'inline-flex items-center gap-1.5 font-semibold transition-colors rounded-xl';
  const styles: Record<string, string> = {
    light: 'text-[13px] px-3 py-2 text-[#6E6557] hover:text-[#1F1A13] hover:bg-black/5',
    dark: 'text-[13px] px-3 py-2 text-white/80 hover:text-white hover:bg-white/10',
    floating: 'text-[13px] px-3.5 py-2.5 bg-white text-[#1F1A13] shadow-lg border border-[#E9E1D3] hover:border-[#E15A30]',
  };

  return (
    <button type="button" onClick={toggle} className={`${base} ${styles[variant]}`} aria-label="Toggle language" title={label}>
      <Globe size={15} />
      <span>{label}</span>
    </button>
  );
}
