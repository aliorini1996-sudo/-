import { Globe, Check } from 'lucide-react';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLang, type Lang } from '../i18n/lang';
import { pathForLocale } from '../i18n/locale';

const LANGS: { code: Lang; label: string }[] = [
  { code: 'ar', label: 'العربية' },
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
];

// مبدّل اللغة:
// - على صفحات التسويق: زر ثنائي (عربي/English) ينتقل بين الرابط و/en (روابط منفصلة للفهرسة).
// - داخل التطبيق (/app · /rep · /platform): قائمة ثلاثية (عربي/English/Français) تضبط اللغة مباشرةً بلا تنقّل.
export default function LanguageToggle({ variant = 'light' }: { variant?: 'light' | 'dark' | 'floating' }) {
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  const loc = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const inApp = /^\/(app|rep|platform)/.test(loc.pathname);

  const base = 'inline-flex items-center gap-1.5 font-semibold transition-colors rounded-xl';
  const styles: Record<string, string> = {
    light: 'text-[13px] px-3 py-2 text-[#6E6557] hover:text-[#1F1A13] hover:bg-black/5',
    dark: 'text-[13px] px-3 py-2 text-white/80 hover:text-white hover:bg-white/10',
    floating: 'text-[13px] px-3.5 py-2.5 bg-white text-[#1F1A13] shadow-lg border border-[#E9E1D3] hover:border-[#E15A30]',
  };

  // صفحات التسويق: ثنائي عربي/إنجليزي بالتنقّل بين المسارات
  if (!inApp) {
    const label = lang === 'ar' ? 'English' : 'العربية';
    const toggle = () => navigate(pathForLocale(loc.pathname, lang === 'ar' ? 'en' : 'ar'));
    return (
      <button type="button" onClick={toggle} className={`${base} ${styles[variant]}`} aria-label="Toggle language" title={label}>
        <Globe size={15} />
        <span>{label}</span>
      </button>
    );
  }

  // داخل التطبيق: قائمة ثلاثية تضبط اللغة مباشرةً
  const current = LANGS.find((l) => l.code === lang) ?? LANGS[0];
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className={`${base} ${styles[variant]}`} aria-label="Language" title={current.label}>
        <Globe size={15} />
        <span>{current.label}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[90]" onClick={() => setOpen(false)} />
          <div className="absolute z-[91] mt-1 min-w-[140px] bg-white rounded-xl shadow-xl border border-[#E9E1D3] overflow-hidden"
            style={{ insetInlineEnd: 0 }} dir="rtl">
            {LANGS.map((l) => (
              <button key={l.code} type="button"
                onClick={() => { setLang(l.code); setOpen(false); }}
                className={`w-full flex items-center justify-between gap-3 px-3.5 py-2.5 text-[13px] hover:bg-[#FAF7F0] transition-colors ${l.code === lang ? 'text-[#E15A30] font-semibold' : 'text-[#1F1A13]'}`}>
                <span dir={l.code === 'ar' ? 'rtl' : 'ltr'}>{l.label}</span>
                {l.code === lang && <Check size={14} />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
