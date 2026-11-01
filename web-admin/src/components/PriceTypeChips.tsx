import { useState } from 'react';
import { Plus, Check, X } from 'lucide-react';
import toast from 'react-hot-toast';
import type { PriceList } from '../types';
import { useTr } from '../i18n/strings';
import { PRICE_LIST_NAME_MAX, priceListNameProblem } from '../lib/priceLists';

/**
 * رقاقات «أنواع الأسعار» (رسم المالك): الأولى السعر الافتراضي (basePrice) باسمه الذي تختاره الشركة، ثم رقاقةٌ لكل نوع. النقر
 * يبدّل ما تحرّره خانة السعر (نافذة الصنف) أو النوع الذي تُسعَّر به الفاتورة. `value` null = الافتراضي، والأسماء بيانات لا tr.
 * `marked` نقطةٌ على النوع الذي له سعر، و`onAdd` (اختياري) رقاقة «+» تضيف نوعاً في مكانه وتعيد معرّفه (null عند الفشل).
 */
export default function PriceTypeChips({ baseLabel, lists, value, onChange, disabled, marked, onAdd }: {
  baseLabel: string;
  lists: PriceList[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  marked?: (id: string) => boolean;
  onAdd?: (name: string) => Promise<string | null>;
}) {
  const tr = useTr();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const chip = (on: boolean) => `inline-flex items-center gap-1.5 rounded-full border-2 px-3 py-1 text-xs font-semibold transition-colors disabled:opacity-60 ${on
    ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white text-[#6E6557] hover:border-[#D8CDB9]'}`;
  const add = async () => {
    if (!onAdd || busy) return;
    const problem = priceListNameProblem(name);
    if (problem) { toast.error(tr(problem)); return; }
    setBusy(true);
    const id = await onAdd(name.trim());
    setBusy(false);
    if (id) { setAdding(false); setName(''); onChange(id); }
  };
  return (
    <div className="flex items-center gap-1.5 flex-wrap" role="radiogroup" aria-label={tr('نوع السعر')} data-price-type-chips="">
      <button type="button" role="radio" aria-checked={value === null} disabled={disabled} onClick={() => onChange(null)} className={chip(value === null)}>
        {baseLabel}
      </button>
      {lists.map(l => (
        <button key={l.id} type="button" role="radio" aria-checked={value === l.id} disabled={disabled} onClick={() => onChange(l.id)} className={chip(value === l.id)}>
          {l.name}
          {marked?.(l.id) && <span className="w-1.5 h-1.5 rounded-full bg-[#E15A30]" aria-hidden="true" />}
        </button>
      ))}
      {onAdd && !adding && (
        <button type="button" disabled={disabled} onClick={() => setAdding(true)} title={tr('إضافة نوع سعر')}
          className="inline-flex items-center gap-1 rounded-full border-2 border-dashed border-[#E9E1D3] px-2.5 py-1 text-xs font-semibold text-[#6E6557] hover:border-[#D8CDB9] disabled:opacity-60">
          <Plus size={12} /> {lists.length === 0 ? tr('إضافة نوع سعر') : null}
        </button>
      )}
      {onAdd && adding && (
        <span className="inline-flex items-center gap-1">
          {/* داخل نموذج الصنف: Enter يضيف النوع لا يحفظ الصنف */}
          <input autoFocus className="input !py-1 !px-2 text-xs w-36" maxLength={PRICE_LIST_NAME_MAX} value={name} disabled={busy}
            placeholder={tr('مثل سعر الجملة')} aria-label={tr('اسم نوع السعر')} onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); void add(); }
              if (e.key === 'Escape') { e.preventDefault(); setAdding(false); setName(''); }
            }} />
          <button type="button" onClick={() => void add()} disabled={busy} className="p-1 rounded-lg text-[#1E7A52] hover:bg-green-50 disabled:opacity-50" title={tr('إضافة')}><Check size={14} /></button>
          <button type="button" onClick={() => { setAdding(false); setName(''); }} disabled={busy} className="p-1 rounded-lg text-gray-400 hover:bg-gray-100" title={tr('إلغاء')}><X size={14} /></button>
        </span>
      )}
    </div>
  );
}
