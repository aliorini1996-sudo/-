import { Globe, Check } from 'lucide-react';
import { useState, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLang, isAppRoute, type Lang } from '../i18n/lang';
import { pathForLocale } from '../i18n/locale';
import { backdropClose } from '../lib/backdropClose';

const LANGS: { code: Lang; label: string }[] = [
  { code: 'ar', label: 'العربية' },
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'zh', label: '中文' },
];

// مبدّل اللغة الخماسي (عربي/English/Français/Türkçe/中文) على كل الصفحات:
// - داخل التطبيق (/app · /rep · /platform · /login · /signup): يضبط اللغة مباشرةً بلا تنقّل.
// - على صفحات التسويق: ينتقل بين المسارات (/ · /en · /fr · /tr · /zh) — روابط منفصلة للفهرسة الدولية (hreflang).
export default function LanguageToggle({ variant = 'light' }: { variant?: 'light' | 'dark' | 'floating' }) {
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  const loc = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const inApp = isAppRoute(loc.pathname);

  /**
   * حارس بصريّ: يزيح القائمة داخل الشاشة إن تجاوزت أي حافة.
   *
   * التموضع بالطرف المنطقي (insetInlineEnd) يعتمد الاتجاه **الموروث**، وأي حاوية
   * في السلسلة تفرض dir تقلبه فتخرج القائمة عن الشاشة — وهو ما وقع فعلاً.
   * فبدل الاتّكال على الوراثة، نقيس بعد الفتح ونصحّح بالبكسل. القياس يقع قبل
   * الرسم (useLayoutEffect) فلا يراها المستخدم تقفز.
   */
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    if (!open) { setShift(0); return; }
    const el = menuRef.current;
    if (!el) return;
    const M = 8; // هامش من الحافة
    const r = el.getBoundingClientRect();
    const over = r.right - (window.innerWidth - M);
    const under = M - r.left;
    if (over > 0) setShift(-over);
    else if (under > 0) setShift(under);
    else setShift(0);
  }, [open, lang]);

  const base = 'inline-flex items-center gap-1.5 font-semibold transition-colors rounded-xl';
  const styles: Record<string, string> = {
    light: 'text-[13px] px-3 py-2 text-[#6E6557] hover:text-[#1F1A13] hover:bg-black/5',
    dark: 'text-[13px] px-3 py-2 text-white/80 hover:text-white hover:bg-white/10',
    floating: 'text-[13px] px-3.5 py-2.5 bg-white text-[#1F1A13] shadow-lg border border-[#E9E1D3] hover:border-[#E15A30]',
  };

  // اختيار لغة: داخل التطبيق يضبطها مباشرةً، وعلى التسويق ينتقل للرابط المقابل
  const choose = (code: Lang) => {
    setOpen(false);
    if (inApp) setLang(code);
    else navigate(pathForLocale(loc.pathname, code));
  };

  const current = LANGS.find((l) => l.code === lang) ?? LANGS[0];
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className={`${base} ${styles[variant]}`} aria-label="Language" title={current.label}>
        <Globe size={15} />
        <span>{current.label}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[90]" {...backdropClose(() => setOpen(false))} />
          <div ref={menuRef}
            className="absolute z-[91] mt-1 min-w-[140px] max-w-[calc(100vw-1.5rem)] bg-white rounded-xl shadow-xl border border-[#E9E1D3] overflow-hidden"
            style={{ insetInlineEnd: 0, transform: shift ? `translateX(${shift}px)` : undefined }}>
            {LANGS.map((l) => (
              <button key={l.code} type="button"
                onClick={() => choose(l.code)}
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
