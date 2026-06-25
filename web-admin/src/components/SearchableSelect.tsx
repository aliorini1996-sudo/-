import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Search, Check } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;        // نص ثانوي (هاتف، رصيد، سعر…)
  hintColor?: string;   // لون النص الثانوي
}

interface Props {
  options: SelectOption[];
  value: string;
  onChange: (value: string, option?: SelectOption) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  loading?: boolean;
  onSearchChange?: (q: string) => void; // عند الحاجة لتصفية من الخادم (وإلا تصفية محلية)
  resetOnSelect?: boolean;              // يُفرّغ القيمة بعد الاختيار (مفيد لإضافة أصناف متعددة)
  className?: string;
  dark?: boolean;                       // نمط داكن لتطبيق المندوب
}

// قائمة منسدلة قابلة للتصفية بالكتابة — بديل احترافي عن حقل البحث الحر، بهوية FieldSales
export default function SearchableSelect({
  options, value, onChange, placeholder = 'اختر…', searchPlaceholder = 'اكتب للتصفية…',
  disabled, loading, onSearchChange, resetOnSelect, className, dark,
}: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const selected = options.find(o => o.value === value);
  const filtered = onSearchChange
    ? options
    : options.filter(o =>
        o.label.toLowerCase().includes(q.toLowerCase()) ||
        (o.hint || '').toLowerCase().includes(q.toLowerCase()));

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setQ(''); } };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const pick = (o: SelectOption) => {
    onChange(o.value, o);
    setOpen(false);
    setQ('');
    if (resetOnSelect) onSearchChange?.('');
  };

  return (
    <div ref={ref} className={`relative ${className || ''}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        className={`input flex items-center justify-between w-full text-right ${disabled ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : ''} ${dark ? '!bg-[#15110b] !border-white/10 !text-white' : ''}`}
      >
        <span className={selected ? (dark ? 'text-white' : 'text-gray-800') : (dark ? 'text-[#6E6557]' : 'text-gray-400')}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={16} className={`shrink-0 ${dark ? 'text-[#9A8F7E]' : 'text-gray-400'} transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className={`absolute top-full right-0 left-0 z-30 rounded-xl shadow-lg mt-1 overflow-hidden border ${dark ? 'bg-[#241d15] border-white/10' : 'bg-white border-[#E9E1D3]'}`}>
          <div className={`relative p-2 border-b ${dark ? 'border-white/10' : 'border-[#F1EBDF]'}`}>
            <Search size={14} className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              autoFocus
              className={`input pr-9 !py-1.5 text-sm ${dark ? '!bg-[#15110b] !border-white/10 !text-white' : ''}`}
              placeholder={searchPlaceholder}
              value={q}
              onChange={e => { setQ(e.target.value); onSearchChange?.(e.target.value); }}
              onKeyDown={e => { if (e.key === 'Enter' && filtered.length === 1) { e.preventDefault(); pick(filtered[0]); } }}
            />
          </div>
          <div className="max-h-56 overflow-y-auto">
            {loading ? (
              <p className="text-center text-gray-400 text-sm py-4">جارٍ التحميل…</p>
            ) : filtered.length === 0 ? (
              <p className="text-center text-gray-400 text-sm py-4">لا توجد نتائج</p>
            ) : filtered.map(o => (
              <button
                key={o.value}
                type="button"
                onClick={() => pick(o)}
                className={`w-full text-right px-3 py-2 text-sm flex items-center justify-between ${dark ? 'hover:bg-white/5 text-white' : 'hover:bg-[#FBEBE2] text-gray-800'} ${o.value === value ? (dark ? 'bg-white/5' : 'bg-[#FBEBE2]') : ''}`}
              >
                <span>
                  <span className="font-medium">{o.label}</span>
                  {o.hint && <span className={`mr-2 text-xs ${o.hintColor || (dark ? 'text-[#9A8F7E]' : 'text-gray-400')}`}>{o.hint}</span>}
                </span>
                {o.value === value && <Check size={14} className="text-[#E15A30] shrink-0" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
