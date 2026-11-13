import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Plus, Search, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { suppliersApi, type Supplier } from '../../api/suppliers';
import { useTr } from '../../i18n/strings';
import { purchaseErrorText } from './purchaseCalc';

/**
 * منتقي المورّد بالبحث من سجلّ الموردين (/api/suppliers) مع «إضافة مورّد سريع» — «ربط الدفاتر» L1 (طلب المالك ١٣ نوفمبر ٢٠٢٦).
 * البحث في الخادم (الاسم والرمز والرقم الضريبي والجوال) بعد توقّفٍ قصير عن الكتابة، والإضافة السريعة بطاقةٌ تحت المنتقي
 * (الاسم إلزامي، والرقم الضريبي والجوال ومدة السداد اختيارية) تختار المورّد الجديد فور حفظه.
 */

/** صفوف قائمة الموردين من الردّ — { items, total } في العقد، ومصفوفةٌ مباشرة تُقبل احتياطاً */
function itemsOf(body: unknown): Supplier[] {
  const d = (body as { data?: unknown } | null | undefined)?.data as { items?: unknown } | unknown[] | undefined;
  if (Array.isArray(d)) return d as Supplier[];
  const items = (d as { items?: unknown } | undefined)?.items;
  return Array.isArray(items) ? (items as Supplier[]) : [];
}

interface QuickDraft { name: string; vatNumber: string; phone: string; paymentDays: string }

export default function SupplierPicker({
  value, onChange, disabled = false, initialSearch = '', quickAdd = true, status = 'active', placeholder, compact = false,
}: {
  value: Supplier | null;
  onChange: (s: Supplier | null) => void;
  disabled?: boolean;
  /** نصّ البحث الأول — اسم المورّد الحرّ في واردٍ قديم يُقترح منه */
  initialSearch?: string;
  /** «إضافة مورّد سريع» — مطفأةٌ في فلتر السجلّ */
  quickAdd?: boolean;
  /** active للحركات الجديدة، all لفلتر السجلّ (المؤرشف له حركات) */
  status?: 'active' | 'all';
  placeholder?: string;
  compact?: boolean;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(initialSearch);
  const [dq, setDq] = useState(initialSearch.trim());
  const [adding, setAdding] = useState<QuickDraft | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // البحث في الخادم بعد توقّف الكتابة — لا طلب لكل حرف
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const listQ = useQuery({
    queryKey: ['suppliers', 'picker', status, dq],
    queryFn: async () => itemsOf((await suppliersApi.list({ search: dq || undefined, status, limit: 30 })).data),
    enabled: open,
    staleTime: 30_000,
  });
  const list = listQ.data ?? [];

  const create = useMutation({
    mutationFn: async (d: QuickDraft) => {
      const days = d.paymentDays.trim() === '' ? undefined : Number(d.paymentDays);
      const res = await suppliersApi.create({
        name: d.name.trim(),
        ...(d.vatNumber.trim() && { vatNumber: d.vatNumber.trim() }),
        ...(d.phone.trim() && { phone: d.phone.trim() }),
        ...(days != null && Number.isInteger(days) && { paymentDays: days }),
      });
      return (res.data as { data?: Supplier } | undefined)?.data ?? null;
    },
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ['suppliers'] });
      setAdding(null);
      if (s) { onChange(s); toast.success(tr('أضيف المورد')); }
    },
    onError: (e: unknown) => toast.error(tr(purchaseErrorText(e) ?? 'تعذر إضافة المورد')),
  });

  const days = adding ? adding.paymentDays.trim() : '';
  const daysOk = days === '' || (/^\d+$/.test(days) && Number(days) <= 365);
  const canSave = !!adding && adding.name.trim().length > 0 && adding.name.trim().length <= 120 && daysOk && !create.isPending;

  const startAdd = () => {
    setOpen(false);
    setAdding({ name: q.trim().slice(0, 120), vatNumber: '', phone: '', paymentDays: '' });
  };

  return (
    <div ref={ref} className="relative">
      <div className="flex items-center gap-1.5">
        <button type="button" disabled={disabled} onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}
          className={`input flex items-center justify-between w-full text-right ${compact ? 'py-1.5 text-xs' : ''} ${disabled ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : ''}`}>
          <span className={`truncate ${value ? 'text-gray-800 font-medium' : 'text-gray-400'}`}>{value ? value.name : placeholder ?? tr('اختر المورد')}</span>
          <ChevronDown size={compact ? 14 : 16} className={`shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {value && !disabled && (
          <button type="button" onClick={() => onChange(null)} title={tr('إزالة المورد')} aria-label={tr('إزالة المورد')}
            className="p-1.5 rounded-lg text-[#9A8F7E] hover:bg-gray-100 hover:text-[#C0392B] shrink-0">
            <X size={14} />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute top-full right-0 left-0 z-30 rounded-xl shadow-lg mt-1 overflow-hidden border bg-white border-[#E9E1D3] min-w-[220px]">
          <div className="relative p-2 border-b border-[#F1EBDF]">
            <Search size={14} className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400" />
            <input autoFocus className="input pr-9 !py-1.5 text-sm" placeholder={tr('ابحث بالاسم أو الرمز أو الرقم الضريبي')}
              value={q} onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && list.length === 1) { e.preventDefault(); onChange(list[0]); setOpen(false); } }} />
          </div>
          <div className="max-h-56 overflow-y-auto" role="listbox">
            {listQ.isLoading ? (
              <p className="text-center text-gray-400 text-sm py-4">{tr('جار التحميل')}</p>
            ) : listQ.isError ? (
              <p className="text-center text-red-600 text-xs py-4">{tr('تعذر تحميل الموردين')}</p>
            ) : list.length === 0 ? (
              <p className="text-center text-gray-400 text-sm py-4">{tr('لا توجد نتائج')}</p>
            ) : list.map(s => (
              <button key={s.id} type="button" role="option" aria-selected={s.id === value?.id}
                onClick={() => { onChange(s); setOpen(false); }}
                className={`w-full text-right px-3 py-2 text-sm flex items-center justify-between gap-2 hover:bg-[#FBEBE2] ${s.id === value?.id ? 'bg-[#FBEBE2]' : ''}`}>
                <span className="min-w-0">
                  <span className="font-medium text-gray-800">{s.name}</span>
                  {!s.isActive && <span className="ms-1 text-[10px] text-slate-500">({tr('مؤرشف')})</span>}
                  {(s.code || s.vatNumber) && (
                    <span className="block text-[11px] text-gray-400 truncate" dir="ltr">{[s.code, s.vatNumber].filter(Boolean).join(' · ')}</span>
                  )}
                </span>
                {s.id === value?.id && <Check size={14} className="text-[#E15A30] shrink-0" />}
              </button>
            ))}
          </div>
          {quickAdd && (
            <button type="button" onClick={startAdd}
              className="w-full text-right px-3 py-2 text-sm font-semibold text-[#E15A30] border-t border-[#F1EBDF] hover:bg-[#FBEBE2] flex items-center gap-1.5">
              <Plus size={14} /> {q.trim() ? `${tr('إضافة مورد جديد')} «${q.trim().slice(0, 40)}»` : tr('إضافة مورد جديد')}
            </button>
          )}
        </div>
      )}

      {/* «إضافة مورّد سريع»: الاسم وحده يكفي، والباقي يُكمل من صفحة الموردين */}
      {adding && (
        <div className="mt-2 rounded-xl border border-[#E9E1D3] bg-[#FAF7F0] p-3 space-y-2">
          <p className="text-xs font-bold text-[#1F1A13] flex items-center gap-1.5"><Plus size={13} className="text-[#E15A30]" /> {tr('إضافة مورد سريع')}</p>
          <input className="input py-1.5 text-sm" autoFocus maxLength={120} placeholder={tr('اسم المورد')} value={adding.name}
            onChange={e => setAdding({ ...adding, name: e.target.value })} />
          <div className="grid grid-cols-3 gap-2">
            <input className="input py-1.5 text-xs" dir="ltr" maxLength={20} placeholder={tr('الرقم الضريبي')} value={adding.vatNumber}
              onChange={e => setAdding({ ...adding, vatNumber: e.target.value })} />
            <input className="input py-1.5 text-xs" dir="ltr" maxLength={30} inputMode="tel" placeholder={tr('الجوال')} value={adding.phone}
              onChange={e => setAdding({ ...adding, phone: e.target.value })} />
            <input className={`input py-1.5 text-xs ${daysOk ? '' : 'border-red-400'}`} inputMode="numeric" placeholder={tr('مدة السداد بالأيام')} value={adding.paymentDays}
              onChange={e => setAdding({ ...adding, paymentDays: e.target.value })} title={tr('مدة السداد بالأيام')} />
          </div>
          {!daysOk && <p className="text-[11px] text-red-600">{tr('مدة السداد من 0 إلى 365 يوما')}</p>}
          <div className="flex gap-2">
            <button type="button" disabled={!canSave} onClick={() => adding && create.mutate(adding)}
              className="btn-primary py-1.5 text-xs disabled:opacity-60">
              {create.isPending ? <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Check size={14} />}
              {tr('حفظ المورد')}
            </button>
            <button type="button" onClick={() => setAdding(null)} className="btn-secondary py-1.5 text-xs">{tr('إلغاء')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
