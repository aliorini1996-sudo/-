import { useId, useRef, type KeyboardEvent } from 'react';
import { Ruler } from 'lucide-react';
import { useTr } from '../i18n/strings';
import { useQtyViewStore } from '../store/qtyViewStore';
import { radioKeyStep, type QtyView } from '../lib/qtyView';

/**
 * مبدّل «عرض الكميات» (طلب المالك ٤ نوفمبر ٢٠٢٦): الوحدة الكبرى («52 كرتون و2 قارورة»، عرض اليوم) أو الصغرى («1,250 قارورة»).
 * عرضٌ فقط ولا يمسّ حساباً، والتفضيل مشتركٌ بين الصفحتين (store/qtyViewStore). الصفحة تُظهره حين فيها صنفٌ له وحدةٌ أكبر وحده.
 * `card` بطاقة «مخزون الشركة» (عنوانٌ موسَّط كخانة «المخزون في تاريخ»)، و`field` بطاقة التصفية (عنوانٌ كوسم الخانات).
 */
const OPTIONS: { value: QtyView; label: string }[] = [
  { value: 'major', label: 'الوحدة الكبرى' },
  { value: 'minor', label: 'الوحدة الصغرى' },
];

export default function QtyViewToggle({ variant = 'card', className = '' }: { variant?: 'card' | 'field'; className?: string }) {
  const tr = useTr();
  const view = useQtyViewStore(s => s.view);
  const setView = useQtyViewStore(s => s.setView);
  const capId = `${useId()}-qty-view`;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const field = variant === 'field';

  // الأسهم تنقل الاختيار والتركيز معاً (سلوك مجموعة الراديو)، بحسب اتجاه الصفحة
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    const j = radioKeyStep(e.key, i, OPTIONS.length, rtl);
    if (j === null) return;
    e.preventDefault();
    setView(OPTIONS[j].value);
    refs.current[j]?.focus();
  };

  return (
    <div className={`flex flex-col gap-1 ${field ? 'items-start' : 'items-center'} ${className}`}>
      <span id={capId} className={field ? 'label text-xs mb-0' : 'text-xs text-[#9A8F7E] flex items-center gap-1'}>
        {!field && <Ruler size={13} />} {tr('عرض الكميات')}
      </span>
      <div role="radiogroup" aria-labelledby={capId}
        className="inline-flex items-center rounded-xl border border-[#E9E1D3] bg-[#FAF7F0] p-0.5">
        {OPTIONS.map((o, i) => {
          const on = view === o.value;
          return (
            <button key={o.value} ref={el => { refs.current[i] = el; }} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1}
              onClick={() => setView(o.value)} onKeyDown={e => onKey(e, i)}
              className={`px-3 ${field ? 'py-2' : 'py-1.5'} rounded-lg text-xs font-semibold whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#E15A30]/40 ${on ? 'bg-[#E15A30] text-white shadow-sm' : 'text-[#6E6557] hover:text-[#1F1A13] hover:bg-white'}`}>
              {tr(o.label)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
