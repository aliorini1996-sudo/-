// ============================================================================
// مكوّنات واجهة مشتركة لبوابة السفير — بألوان هوية Field Sales الرسمية
// (مرجاني #E15A30 · حبر #1F1A13 · كريمي #FAF7F0 · أخضر #1E7A52).
// الاتجاه يتبع اللغة: RTL للعربية وحدها، وLTR لغيرها — بخصائص منطقية (start/end).
// ============================================================================
import { useState, type ReactNode } from 'react';
import { Check, Copy, Eye, EyeOff, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { BrandIcon } from '../components/BrandLogo';
import LanguageToggle from '../components/LanguageToggle';
import { sarNumber, sarSymbol } from './format';
import type { Label, Tone } from './labels';
import { errorText } from './errors';
import { useAxT, type AxKey } from './i18n';

const TONE: Record<Tone, string> = {
  green: 'bg-[#E4F1EA] text-[#1E7A52]',
  amber: 'bg-[#FAEFD8] text-[#8A5A0B]',
  red: 'bg-[#FBE3DF] text-[#C0392B]',
  gray: 'bg-[#F1EBDF] text-[#6E6557]',
  coral: 'bg-[#FBEBE2] text-[#C94E28]',
};

/**
 * محاذاة حقلٍ اتجاهه LTR دائماً (بريد، جوال، آيبان) مع اتجاه الصفحة: يمين العربية
 * ويسار غيرها. الخصائص المنطقية لا تكفي هنا لأن `dir="ltr"` على الحقل نفسه يقلبها.
 */
export function ltrFieldAlign(dir: 'rtl' | 'ltr'): string {
  return dir === 'rtl' ? 'text-right' : 'text-left';
}

export function Badge({ value }: { value: Label }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap ${TONE[value.tone]}`}>
      {value.label}
    </span>
  );
}

/** مبلغ بالريال — الرقم معزول باتجاهه حتى لا تنقلب إشارة السالب، والرمز بلغة العرض */
export function Money({ h, className = '' }: { h: number | null | undefined; className?: string }) {
  const { lang } = useAxT();
  const negative = typeof h === 'number' && h < 0;
  return (
    <span className={`whitespace-nowrap ${negative ? 'text-[#C0392B]' : ''} ${className}`}>
      <bdi dir="ltr" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>{sarNumber(h)}</bdi> {sarSymbol(lang)}
    </span>
  );
}

export function Spinner({ size = 18, className = '' }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={`animate-spin ${className}`} />;
}

export function Loading({ text }: { text?: string }) {
  const { t } = useAxT();
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-[#6E6557]">
      <Spinner /> {text ?? t('common.loading')}
    </div>
  );
}

export function ErrorBox({ err, onRetry, fallback = 'err.loadData' }: { err: unknown; onRetry?: () => void; fallback?: AxKey }) {
  const { t, lang } = useAxT();
  return (
    <div className="card flex flex-col items-center text-center gap-3 py-8">
      <AlertTriangle className="text-[#C0392B]" size={26} />
      <p className="text-sm text-[#1F1A13]">{errorText(err, lang, fallback)}</p>
      {onRetry && (
        <button type="button" className="btn-secondary" onClick={onRetry}>
          <RefreshCw size={15} /> {t('common.retry')}
        </button>
      )}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-[#DED5C4] bg-white/60 px-5 py-8 text-center">
      <p className="text-sm font-semibold text-[#1F1A13]">{title}</p>
      {hint && <p className="text-xs text-[#6E6557] mt-1.5 leading-relaxed">{hint}</p>}
    </div>
  );
}

export function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label className="label">{label}{required && <span className="text-[#E15A30]"> *</span>}</label>
      {children}
      {hint && <p className="text-[11.5px] text-[#8A8072] mt-1 leading-relaxed">{hint}</p>}
    </div>
  );
}

export function PasswordInput({ value, onChange, autoComplete }: { value: string; onChange: (v: string) => void; autoComplete: string }) {
  const { t, dir } = useAxT();
  const [show, setShow] = useState(false);
  // الحقل LTR دائماً، وزرّ الإظهار عند طرف نهاية السطر بلغة العرض (يسار العربية، يمين غيرها)
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'} dir="ltr" className={`input ${dir === 'rtl' ? 'pl-10' : 'pr-10'} ${ltrFieldAlign(dir)}`}
        value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} maxLength={128}
      />
      <button
        type="button" className="absolute end-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]"
        onClick={() => setShow((s) => !s)} aria-label={show ? t('pw.hide') : t('pw.show')}
      >
        {show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

/** مربّع اختيار بنصٍّ قابلٍ للّمس بالكامل (أهدافٌ كبيرة على الجوال) */
export function CheckRow({ checked, onChange, children, required }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; required?: boolean }) {
  return (
    <label className="flex items-start gap-2.5 text-[13px] text-[#44403a] cursor-pointer leading-relaxed py-1">
      <input type="checkbox" className="w-[18px] h-[18px] mt-0.5 accent-[#E15A30] shrink-0" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}{required && <span className="text-[#E15A30]"> *</span>}</span>
    </label>
  );
}

/** نسخٌ إلى الحافظة مع بديلٍ للمتصفّحات التي تحجب Clipboard API (http، WebView) */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* نجرّب البديل */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label, primary = false, className = '' }: { text: string; label?: string; primary?: boolean; className?: string }) {
  const { t } = useAxT();
  const [done, setDone] = useState(false);
  const onClick = async () => {
    const ok = await copyText(text);
    if (ok) {
      setDone(true);
      toast.success(t('copy.done'));
      setTimeout(() => setDone(false), 1800);
    } else {
      toast.error(t('copy.failed'));
    }
  };
  return (
    <button type="button" onClick={onClick} className={`${primary ? 'btn-primary' : 'btn-secondary'} justify-center ${className}`}>
      {done ? <Check size={15} /> : <Copy size={15} />} {label ?? t('copy.default')}
    </button>
  );
}

/** الاسم اللفظي الرسمي: Field (حبر) + Sales (مرجاني) بخط IBM Plex Serif */
export function Wordmark({ size = 15 }: { size?: number }) {
  return (
    <span dir="ltr" style={{ fontFamily: "'IBM Plex Serif', serif", fontWeight: 600, fontSize: size, letterSpacing: '-0.01em' }}>
      <span className="text-[#1F1A13]">Field</span><span className="text-[#E15A30]"> Sales</span>
    </span>
  );
}

/** العلامة — تنكمش وتُقصّ عند الضيق (320px) كي لا تدفع أزرار الرأس خارج الشاشة بأي لغة */
export function BrandLockup({ compact = false }: { compact?: boolean }) {
  const { t } = useAxT();
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <span className="shrink-0"><BrandIcon size={compact ? 34 : 44} radius={0.24} /></span>
      <div className="leading-tight min-w-0">
        <div className={`${compact ? 'text-[15px]' : 'text-lg'} font-bold text-[#1F1A13] truncate`}>{t('app.title')}</div>
        <div className="truncate"><Wordmark size={compact ? 12 : 13} /></div>
      </div>
    </div>
  );
}

/** مبدّل اللغة الخماسي للتطبيق — /ax مسار تطبيق فيضبط اللغة مباشرةً بلا تنقّل */
export function AxLanguageToggle() {
  return <LanguageToggle variant="light" />;
}

/** غلاف شاشات ما قبل الدخول — مبدّل اللغة أعلى الشاشة، ثم بطاقة واحدة في الوسط */
export function AuthShell({ title, subtitle, children, wide = false }: { title: string; subtitle?: ReactNode; children: ReactNode; wide?: boolean }) {
  const { dir, lang } = useAxT();
  return (
    <div className="min-h-screen bg-[#FAF7F0] px-4 pt-3 pb-8 flex justify-center" dir={dir} lang={lang}>
      <div className={`w-full ${wide ? 'max-w-xl' : 'max-w-md'}`}>
        <div className="flex justify-end mb-2"><AxLanguageToggle /></div>
        <div className="flex justify-center mb-6"><BrandLockup /></div>
        <div className="card">
          <h1 className="text-xl font-bold text-[#1F1A13]">{title}</h1>
          {subtitle && <div className="text-sm text-[#6E6557] mt-1.5 leading-relaxed">{subtitle}</div>}
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="text-[#E15A30] font-semibold hover:underline">
      {children}
    </button>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 mb-3">
      <h2 className="text-base font-bold text-[#1F1A13]">{children}</h2>
      {action}
    </div>
  );
}

/** شروط البرنامج: نصّ قانوني عربي من الخادم يُعرض عربياً RTL دائماً، وبغير العربية تنبيهٌ أنه المعتمد */
export function ArabicTermsBody({ body, className = '' }: { body: string; className?: string }) {
  const { t, lang } = useAxT();
  return (
    <>
      {lang !== 'ar' && <p className="text-[11.5px] text-[#8A5A0B] bg-[#FAEFD8] rounded-lg px-2.5 py-1.5 mb-2">{t('terms.arabicBinding')}</p>}
      <div dir="rtl" lang="ar" className={`text-right ${className}`} style={{ whiteSpace: 'pre-wrap' }} tabIndex={0}>
        {body}
      </div>
    </>
  );
}
