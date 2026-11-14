import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { useDir } from '../../../i18n/lang';
import { MilliAmount } from '../SyncBadges';
import { activeLocale } from '../../../utils/format';
import { isZeroMilliText } from '../../../lib/ledger/linking';

/**
 * أجزاء عرض مشتركة لصفحة «ربط الدفاتر بالنظام (معاينة)»: قسم قابل للطيّ، وشبكة «مفتاح: قيمة»، وغلاف جدول
 * يتمرّر أفقياً داخل البطاقة وحدها (لا تمرير أفقي للصفحة على الجوال)، وخلايا الجدول، ومبلغ ملّي معزول الاتجاه.
 */

export function LinkingSection({ id, title, icon, badge, hint, defaultOpen = true, children }: {
  id: string;
  title: string;
  icon?: ReactNode;
  badge?: ReactNode;
  hint?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const dir = useDir();
  const [open, setOpen] = useState(defaultOpen);
  const Closed = dir === 'rtl' ? ChevronLeft : ChevronRight;
  return (
    <section className="card !p-0 overflow-hidden" aria-labelledby={`${id}-title`}>
      <button
        type="button"
        className="w-full flex flex-wrap items-center gap-2 px-4 py-3 text-start hover:bg-[#FBF7F0]"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={() => setOpen(o => !o)}
      >
        {open ? <ChevronDown size={16} className="shrink-0" /> : <Closed size={16} className="shrink-0" />}
        {icon}
        <h2 id={`${id}-title`} className="font-semibold text-[#1F1A13]">{title}</h2>
        {badge}
        {hint && <span className="text-xs text-[#6E6557] basis-full sm:basis-auto">{hint}</span>}
      </button>
      {open && <div id={`${id}-body`} className="border-t border-[#F1EBDF] px-4 py-3 space-y-3 min-w-0">{children}</div>}
    </section>
  );
}

/** شبكة «مفتاح: قيمة» — عمود واحد على الجوال */
export function KeyValueGrid({ items }: { items: { label: string; value: ReactNode; title?: string }[] }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2 text-sm">
      {items.map(it => (
        <div key={it.label} className="flex items-baseline justify-between gap-3 border-b border-[#F1EBDF] pb-1.5 min-w-0" title={it.title}>
          <dt className="text-[#6E6557] shrink-0">{it.label}</dt>
          <dd className="font-medium text-[#1F1A13] text-end min-w-0 break-words">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** غلاف الجدول: التمرير الأفقي داخل البطاقة وحدها */
export function TableShell({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="overflow-x-auto -mx-4 px-4" role="region" aria-label={label} tabIndex={0}>
      <table className="w-full text-sm border-collapse">{children}</table>
    </div>
  );
}

export function Th({ children, end, className = '' }: { children?: ReactNode; end?: boolean; className?: string }) {
  return <th scope="col" className={`px-2 py-1.5 text-xs font-semibold text-[#6E6557] whitespace-nowrap ${end ? 'text-end' : 'text-start'} ${className}`}>{children}</th>;
}

export function Td({ children, end, className = '', title, colSpan }: { children?: ReactNode; end?: boolean; className?: string; title?: string; colSpan?: number }) {
  return <td colSpan={colSpan} title={title} className={`px-2 py-1.5 border-t border-[#F1EBDF] align-top ${end ? 'text-end' : 'text-start'} ${className}`}>{children}</td>;
}

/** مبلغ ملّي (نصّ من الخادم) بمنازل العملة — السالب أحمر بعلامة لاحقة داخل العزل */
export function Amt({ value, decimals, colored = true, blankZero = false }: { value: string | null | undefined; decimals: number; colored?: boolean; blankZero?: boolean }) {
  if (blankZero && isZeroMilliText(value)) return null;
  return <MilliAmount value={value ?? '0'} decimals={decimals} colored={colored} />;
}

/** عدد صحيح بخانات مجمّعة (أرقام اللغة) */
export function Count({ n }: { n: number | null | undefined }) {
  return <bdi className="tabular-nums">{n === null || n === undefined || !Number.isFinite(n) ? '—' : new Intl.NumberFormat(activeLocale()).format(n)}</bdi>;
}

/** تنبيه داخل القسم */
export function LinkingNotice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  const cls = tone === 'error' ? 'border-[#F3C6BF] bg-[#FBE3DF] text-[#8E2A1F]'
    : tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-900'
      : tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
        : 'border-[#F3D3C4] bg-[#FBEBE2] text-[#1F1A13]';
  return <div className={`rounded-xl border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}

/** «عرض المزيد» لقوائم طويلة (القيد الافتتاحي والسطور المحجوزة) — بلا رسم آلاف الصفوف دفعة واحدة */
export function useShowMore(step: number): [number, () => void, () => void] {
  const [n, setN] = useState(step);
  return [n, () => setN(x => x + step), () => setN(step)];
}

export function ShowMoreButton({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  const tr = useTr();
  if (shown >= total) return null;
  return (
    <button type="button" className="btn-secondary !py-1 !px-3 text-xs" onClick={onMore}>
      {tr('عرض المزيد')} (<bdi className="tabular-nums">{total - shown}</bdi>)
    </button>
  );
}
