import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Search, Check } from 'lucide-react';
import { useTr } from '../../../../i18n/strings';
import { useLang } from '../../../../i18n/lang';
import { useAuthStore } from '../../../../store/authStore';
import { canLedger, type LedgerKey } from '../../../../lib/ledgerPerms';
import { backdropClose } from '../../../../lib/backdropClose';
import { ledgerName } from '../../../../lib/ledger/format';
import { accountTypeLabels, ledgerConfigCodeLabels, ledgerConfigReasonLabels } from '../../../../lib/ledger/labels';
import { fetchAllLedgerAccounts, ledgerErrorOf, ledgerKeys, type AccountType, type GlAccount } from '../../../../api/ledgerConfig';

/**
 * أجزاء مشتركة لصفحات التهيئة (M2، §8.2–§8.4) — خارج نمط glob في App.tsx (عمق ثالث) فلا تُعدّ صفحة.
 * أزرار الكتابة معطّلة بتلميح دون صلاحية الكتابة (§8.2 قاعدة الظهور).
 */

export function useLedgerCan(key: LedgerKey): boolean {
  const { user } = useAuthStore();
  return canLedger(user, key);
}

/** نص خطأ مترجم: رمز ملحق ب ← سبب التحرير (reason) ← رسالة الخادم ← الاحتياط. */
export function useConfigErrorText() {
  const tr = useTr();
  return (err: unknown, fallback?: string): string => {
    const b = ledgerErrorOf(err);
    if (!b) return fallback ?? tr('تعذر الحفظ');
    if (b.status === 404) return tr('السجل غير موجود');
    const reason = typeof b.reason === 'string' ? b.reason : undefined;
    if (reason && ledgerConfigReasonLabels(tr)[reason]) return ledgerConfigReasonLabels(tr)[reason];
    if (b.code && ledgerConfigCodeLabels(tr)[b.code]) return ledgerConfigCodeLabels(tr)[b.code];
    if (b.status === 400) return tr('بيانات غير صالحة');
    return (typeof b.message === 'string' && b.message) || fallback || tr('تعذر الحفظ');
  };
}

/** زر كتابة: دون الصلاحية يبقى ظاهراً معطّلاً بتلميح. */
export function WriteButton({ allowed, onClick, children, className = 'btn-primary', busy, disabled, reason, type = 'button' }: {
  allowed: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  busy?: boolean;
  disabled?: boolean;
  /** سبب تعطيل غير الصلاحية */
  reason?: string | null;
  type?: 'button' | 'submit';
}) {
  const tr = useTr();
  const title = !allowed ? tr('لا تملك صلاحية التعديل') : reason ?? undefined;
  return (
    <button type={type} className={`${className} disabled:opacity-50 disabled:cursor-not-allowed`} onClick={onClick}
      disabled={!allowed || !!busy || !!disabled || !!reason} title={title}>
      {children}
    </button>
  );
}

export function ConfigModal({ title, onClose, children, footer, wide }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  const tr = useTr();
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 bg-black/40 z-[55] flex items-start sm:items-center justify-center p-4 overflow-y-auto" {...backdropClose(onClose)}>
      <div role="dialog" aria-modal="true" aria-label={title}
        className={`bg-white rounded-2xl shadow-2xl w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} my-8`} onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-3 border-b border-[#F1EBDF]">
          <h2 className="text-base font-bold text-[#1F1A13] flex-1 truncate">{title}</h2>
          <button type="button" className="p-1.5 rounded-lg hover:bg-[#F1EBDF]" onClick={onClose} aria-label={tr('إغلاق')}><X size={16} /></button>
        </div>
        <div className="p-5 space-y-3">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 px-5 py-3 border-t border-[#F1EBDF] bg-[#FBF7F0] rounded-b-2xl">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children, className = '' }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-[#9A8F7E] mt-1 leading-relaxed">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, disabled, label, hint, title }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; hint?: ReactNode; title?: string;
}) {
  return (
    <div className={`flex items-start gap-3 py-1.5 ${disabled ? 'opacity-60' : ''}`} title={title}>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? 'bg-[#E15A30]' : 'bg-[#D9CFBF]'} ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? 'start-[1.125rem]' : 'start-0.5'}`} />
      </button>
      <div className="min-w-0">
        <p className="text-sm text-[#1F1A13]">{label}</p>
        {hint && <p className="text-[11px] text-[#9A8F7E] leading-relaxed mt-0.5">{hint}</p>}
      </div>
    </div>
  );
}

/** كل حسابات الشركة (بالمؤرشف) لمنتقيات التهيئة — بالجالب نفسه ومفتاحه مع نموذج القيد (بصفحات حتى 20,000). */
export function useAllAccounts(enabled = true) {
  return useQuery({
    queryKey: ledgerKeys.allAccounts,
    queryFn: fetchAllLedgerAccounts,
    enabled,
    staleTime: 30_000,
  });
}

/** منتقي حساب بالإكمال (COA‑08): الرمز والاسم والنوع، مع تقييد اختياري بالأنواع والنوع الرئيسي. */
export function AccountSelect({ accounts, value, onChange, types, controlKind, allowEmpty, disabled, placeholder, invalid }: {
  accounts: GlAccount[];
  value: string | null;
  onChange: (id: string | null) => void;
  types?: readonly AccountType[];
  controlKind?: string | null;
  allowEmpty?: boolean;
  disabled?: boolean;
  placeholder?: string;
  invalid?: boolean;
}) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const typeLabels = accountTypeLabels(tr);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const current = accounts.find(a => a.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setQ(''); } };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const options = useMemo(() => {
    const s = q.trim().toLowerCase();
    return accounts
      .filter(a => a.isActive)
      .filter(a => !types || types.includes(a.type))
      .filter(a => !controlKind || a.controlKind === controlKind)
      .filter(a => !s || a.code.startsWith(s) || ledgerName(a, lang).toLowerCase().includes(s) || a.name.includes(q.trim()) || (a.nameEn ?? '').toLowerCase().includes(s) || (a.description ?? '').toLowerCase().includes(s))
      .slice(0, 80);
  }, [accounts, types, controlKind, q, lang]);

  const pick = (id: string | null) => { onChange(id); setOpen(false); setQ(''); };

  return (
    <div ref={ref} className="relative">
      <button type="button" disabled={disabled} onClick={() => setOpen(o => !o)}
        className={`input w-full text-start flex items-center gap-2 ${disabled ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''} ${invalid ? '!border-[#C0392B]' : ''}`}>
        {current
          ? <span className={`truncate ${current.isActive ? '' : 'line-through text-[#9A8F7E]'}`}><bdi className="tabular-nums text-[#6E6557]">{current.code}</bdi> {ledgerName(current, lang)}</span>
          : <span className="text-gray-400 truncate">{placeholder ?? tr('اختر حساباً')}</span>}
      </button>
      {open && (
        <div className="absolute z-40 mt-1 inset-x-0 min-w-[16rem] bg-white rounded-xl shadow-xl border border-[#E8E0D2] overflow-hidden">
          <div className="relative p-2 border-b border-[#F1EBDF]">
            <Search size={14} className="absolute start-4 top-1/2 -translate-y-1/2 text-gray-400" />
            <input autoFocus className="input !py-1.5 ps-8 text-sm" placeholder={tr('ابحث بالرمز أو الاسم')} value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && options.length === 1) { e.preventDefault(); pick(options[0].id); } if (e.key === 'Escape') setOpen(false); }} />
          </div>
          <div className="max-h-64 overflow-y-auto">
            {allowEmpty && (
              <button type="button" className="w-full text-start px-3 py-2 text-sm text-[#9A8F7E] hover:bg-[#FBF7F0]" onClick={() => pick(null)}>{tr('بلا حساب')}</button>
            )}
            {options.length === 0 && <p className="text-center text-[#9A8F7E] text-sm py-4">{tr('لا توجد نتائج')}</p>}
            {options.map(a => (
              <button key={a.id} type="button" onClick={() => pick(a.id)}
                className={`w-full text-start px-3 py-1.5 text-sm hover:bg-[#FBEBE2] flex items-center gap-2 ${a.id === value ? 'bg-[#FBEBE2]' : ''}`}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate"><bdi className="tabular-nums text-[#6E6557]">{a.code}</bdi> {ledgerName(a, lang)}</span>
                  <span className="block text-[11px] text-[#9A8F7E] truncate">{typeLabels[a.type]}{a.description ? ` · ${a.description}` : ''}</span>
                </span>
                {a.id === value && <Check size={14} className="text-[#E15A30] shrink-0" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** رأس صفحة تهيئة بسيطة (غير LedgerListView). */
export function ConfigHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-lg font-bold text-[#1F1A13]">{title}</h1>
        {subtitle && <p className="text-xs text-[#9A8F7E] mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatusBadge({ active }: { active: boolean }) {
  const tr = useTr();
  return active
    ? <span className="badge badge-active">{tr('نشط')}</span>
    : <span className="badge badge-inactive">{tr('مؤرشف')}</span>;
}

/** دلالة صرفة: حرف عربي في الاسم (G7) — مرآة services/gl/names.ts للتحقق المبكر في الواجهة. */
export function hasArabicLetter(v: unknown): boolean {
  return typeof v === 'string' && /[؀-ۿݐ-ݿ]/.test(v);
}
