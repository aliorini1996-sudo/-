// ============================================================================
// مكوّنات واجهة مشتركة لبوابة السفير — بألوان هوية Field Sales الرسمية
// (مرجاني #E15A30 · حبر #1F1A13 · كريمي #FAF7F0 · أخضر #1E7A52).
// ============================================================================
import { useState, type ReactNode } from 'react';
import { Check, Copy, Eye, EyeOff, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { BrandIcon } from '../components/BrandLogo';
import { sarNumber } from './format';
import type { Label, Tone } from './labels';
import { errMessage } from './api';

const TONE: Record<Tone, string> = {
  green: 'bg-[#E4F1EA] text-[#1E7A52]',
  amber: 'bg-[#FAEFD8] text-[#8A5A0B]',
  red: 'bg-[#FBE3DF] text-[#C0392B]',
  gray: 'bg-[#F1EBDF] text-[#6E6557]',
  coral: 'bg-[#FBEBE2] text-[#C94E28]',
};

export function Badge({ value }: { value: Label }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap ${TONE[value.tone]}`}>
      {value.label}
    </span>
  );
}

/** مبلغ بالريال — الرقم معزول باتجاهه حتى لا تنقلب إشارة السالب في RTL */
export function Money({ h, className = '' }: { h: number | null | undefined; className?: string }) {
  const negative = typeof h === 'number' && h < 0;
  return (
    <span className={`whitespace-nowrap ${negative ? 'text-[#C0392B]' : ''} ${className}`}>
      <bdi dir="ltr" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>{sarNumber(h)}</bdi> ر.س
    </span>
  );
}

export function Spinner({ size = 18, className = '' }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={`animate-spin ${className}`} />;
}

export function Loading({ text = 'جارٍ التحميل…' }: { text?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-[#6E6557]">
      <Spinner /> {text}
    </div>
  );
}

export function ErrorBox({ err, onRetry }: { err: unknown; onRetry?: () => void }) {
  return (
    <div className="card flex flex-col items-center text-center gap-3 py-8">
      <AlertTriangle className="text-[#C0392B]" size={26} />
      <p className="text-sm text-[#1F1A13]">{errMessage(err, 'تعذّر تحميل البيانات')}</p>
      {onRetry && (
        <button type="button" className="btn-secondary" onClick={onRetry}>
          <RefreshCw size={15} /> إعادة المحاولة
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
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'} dir="ltr" className="input pl-10 text-right"
        value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} maxLength={128}
      />
      <button
        type="button" className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]"
        onClick={() => setShow((s) => !s)} aria-label={show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
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

export function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className={`w-full flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-right transition-colors ${checked ? 'border-[#E15A30] bg-[#FBEBE2]/60' : 'border-[#E0D7C6] bg-white'}`}
    >
      <span>
        <span className="block text-sm font-semibold text-[#1F1A13]">{label}</span>
        {hint && <span className="block text-[11.5px] text-[#6E6557] mt-0.5">{hint}</span>}
      </span>
      <span className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-[#E15A30]' : 'bg-[#D9CFBE]'}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'right-[22px]' : 'right-0.5'}`} />
      </span>
    </button>
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

export function CopyButton({ text, label = 'نسخ', primary = false, className = '' }: { text: string; label?: string; primary?: boolean; className?: string }) {
  const [done, setDone] = useState(false);
  const onClick = async () => {
    const ok = await copyText(text);
    if (ok) {
      setDone(true);
      toast.success('تم النسخ');
      setTimeout(() => setDone(false), 1800);
    } else {
      toast.error('تعذّر النسخ — انسخه يدوياً');
    }
  };
  return (
    <button type="button" onClick={onClick} className={`${primary ? 'btn-primary' : 'btn-secondary'} justify-center ${className}`}>
      {done ? <Check size={15} /> : <Copy size={15} />} {label}
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

export function BrandLockup({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <BrandIcon size={compact ? 34 : 44} radius={0.24} />
      <div className="leading-tight">
        <div className={`${compact ? 'text-[15px]' : 'text-lg'} font-bold text-[#1F1A13]`}>سفير فيلد سيلز</div>
        <Wordmark size={compact ? 12 : 13} />
      </div>
    </div>
  );
}

/** غلاف شاشات ما قبل الدخول — بطاقة واحدة في الوسط */
export function AuthShell({ title, subtitle, children, wide = false }: { title: string; subtitle?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-screen bg-[#FAF7F0] px-4 py-8 flex justify-center">
      <div className={`w-full ${wide ? 'max-w-xl' : 'max-w-md'}`}>
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
