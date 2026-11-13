import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Loader2, Plus, Search, Truck, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { suppliersApi, type Supplier } from '../api/suppliers';
import { useTr } from '../i18n/strings';
import { useBackClose } from '../lib/useBackClose';
import { formatCurrency } from '../utils/format';
import { purchaseErrorText } from '../components/purchases/purchaseCalc';
import { MCard, MEmpty, MError, MHeader, MRow, MSpinner } from './mobileUi';
import { useMTaxOff } from './mTaxMode';

/**
 * منتقي المورّد في تطبيق الإدارة على الجوال («ربط الدفاتر» L1، طلب المالك ١٣ نوفمبر ٢٠٢٦) — نظير SupplierPicker في اللوحة
 * بتصميم /m: خانةٌ بعرض البطاقة تفتح **طبقةً ملء القسم** (بحث في الخادم بالاسم والرمز والرقم الضريبي والجوال، وصفوف ≥ 56px
 * للإبهام) بدل قائمة منسدلة لا تتّسع لها شاشة 360px، و«إضافة مورد جديد» داخلها: الاسم وحده يكفي، والمورّد الجديد يُختار فور
 * حفظه. زرّ الرجوع في أندرويد يُغلق الطبقة لا التطبيق (useBackClose).
 */

/** صفوف قائمة الموردين — { items, total } في العقد، ومصفوفةٌ مباشرة تُقبل احتياطاً */
function itemsOf(body: unknown): Supplier[] {
  const d = (body as { data?: unknown } | null | undefined)?.data as { items?: unknown } | unknown[] | undefined;
  if (Array.isArray(d)) return d as Supplier[];
  const items = (d as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) throw new Error('bad suppliers payload');
  return items as Supplier[];
}

interface QuickDraft { name: string; vatNumber: string; phone: string; paymentDays: string }

/** مدة السداد: فارغة أو عدد صحيح 0..365 (عقد الخادم) */
const daysOk = (s: string) => s.trim() === '' || (/^\d+$/.test(s.trim()) && Number(s.trim()) <= 365);

export function MSupplierField({
  value, onChange, disabled = false, quickAdd = true, status = 'active', placeholder, initialSearch = '',
}: {
  value: Supplier | null;
  onChange: (s: Supplier | null) => void;
  disabled?: boolean;
  /** «إضافة مورد جديد» — مطفأةٌ في فلتر السجلّ */
  quickAdd?: boolean;
  /** active للحركات الجديدة، all لفلتر السجلّ (المؤرشف له حركات) */
  status?: 'active' | 'all';
  placeholder?: string;
  /** نصّ البحث الأول — اسم المورّد الحرّ في واردٍ قديم يُقترح منه */
  initialSearch?: string;
}) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="flex items-center gap-1.5">
        <button type="button" disabled={disabled} onClick={() => setOpen(true)} aria-haspopup="dialog"
          className="input min-h-[44px] flex items-center justify-between gap-2 text-start disabled:opacity-60">
          <span className={`min-w-0 truncate ${value ? 'text-[#1F1A13] font-semibold' : 'text-[#9A8F7E]'}`}>
            {value ? value.name : placeholder ?? tr('اختر المورد')}
          </span>
          <ChevronDown size={16} className="text-[#9A8F7E] flex-shrink-0" />
        </button>
        {value && !disabled && (
          <button type="button" onClick={() => onChange(null)} aria-label={tr('إزالة المورد')}
            className="w-11 h-11 rounded-xl flex items-center justify-center text-[#9A8F7E] active:bg-[#FDF2F0] active:text-[#C0392B] flex-shrink-0">
            <X size={16} />
          </button>
        )}
      </div>
      {open && (
        <MSupplierLayer value={value} quickAdd={quickAdd} status={status} initialSearch={initialSearch}
          onPick={s => { onChange(s); setOpen(false); }} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/** طبقة الاختيار ملء القسم (absolute فوق النموذج: القسم في MobileApp هو الحاوية الموضوعة) */
function MSupplierLayer({ value, quickAdd, status, initialSearch, onPick, onClose }: {
  value: Supplier | null; quickAdd: boolean; status: 'active' | 'all'; initialSearch: string;
  onPick: (s: Supplier) => void; onClose: () => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  // «إزالة الضريبة»: لا خانة رقمٍ ضريبي في الإضافة السريعة ولا ذكر له في الصفوف
  const taxOff = useMTaxOff();
  useBackClose(true, onClose);
  const [q, setQ] = useState(initialSearch);
  const [dq, setDq] = useState(initialSearch.trim());
  const [adding, setAdding] = useState<QuickDraft | null>(null);

  // البحث في الخادم بعد توقّف الكتابة — لا طلب لكل حرف
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const listQ = useQuery({
    queryKey: ['suppliers', 'm-picker', status, dq],
    queryFn: async () => itemsOf((await suppliersApi.list({ search: dq || undefined, status, limit: 30 })).data),
    staleTime: 30_000,
  });
  const list = listQ.data ?? [];

  const create = useMutation({
    mutationFn: async (d: QuickDraft) => {
      const days = d.paymentDays.trim() === '' ? undefined : Number(d.paymentDays.trim());
      const res = await suppliersApi.create({
        name: d.name.trim(),
        ...(!taxOff && d.vatNumber.trim() && { vatNumber: d.vatNumber.trim() }),
        ...(d.phone.trim() && { phone: d.phone.trim() }),
        ...(days != null && Number.isInteger(days) && { paymentDays: days }),
      });
      return (res.data as { data?: Supplier } | undefined)?.data ?? null;
    },
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ['suppliers'] });
      setAdding(null);
      if (s) { toast.success(tr('أضيف المورد')); onPick(s); }
    },
    onError: (e: unknown) => toast.error(tr(purchaseErrorText(e) ?? 'تعذر إضافة المورد')),
  });

  const canSave = !!adding && adding.name.trim().length > 0 && adding.name.trim().length <= 120 && daysOk(adding.paymentDays) && !create.isPending;

  return (
    <div className="absolute inset-0 z-[60] h-full flex flex-col bg-[#FAF7F0]" role="dialog" aria-modal="true">
      <MHeader title={adding ? tr('إضافة مورد سريع') : tr('اختر المورد')} onBack={adding ? () => setAdding(null) : onClose} />

      {adding ? (
        <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-3">
          <div className="bg-white rounded-2xl border border-[#F1EBDF] p-3 space-y-2.5">
            <label className="block">
              <span className="block text-[11px] text-[#9A8F7E] mb-1">{tr('اسم المورد')}</span>
              <input className="input min-h-[44px]" autoFocus maxLength={120} value={adding.name}
                onChange={e => setAdding({ ...adding, name: e.target.value })} />
            </label>
            {!taxOff && (
              <label className="block">
                <span className="block text-[11px] text-[#9A8F7E] mb-1">{tr('الرقم الضريبي')}</span>
                <input className="input min-h-[44px]" dir="ltr" maxLength={20} inputMode="numeric" value={adding.vatNumber}
                  placeholder={tr('اختياري')} onChange={e => setAdding({ ...adding, vatNumber: e.target.value })} />
              </label>
            )}
            <label className="block">
              <span className="block text-[11px] text-[#9A8F7E] mb-1">{tr('الجوال')}</span>
              <input className="input min-h-[44px]" dir="ltr" maxLength={30} inputMode="tel" value={adding.phone}
                placeholder={tr('اختياري')} onChange={e => setAdding({ ...adding, phone: e.target.value })} />
            </label>
            <label className="block">
              <span className="block text-[11px] text-[#9A8F7E] mb-1">{tr('مدة السداد بالأيام')}</span>
              <input className={`input min-h-[44px] ${daysOk(adding.paymentDays) ? '' : 'border-[#C0392B]'}`} dir="ltr" inputMode="numeric"
                value={adding.paymentDays} placeholder={tr('اختياري')} onChange={e => setAdding({ ...adding, paymentDays: e.target.value })} />
            </label>
            {!daysOk(adding.paymentDays) && <p className="text-[11px] text-[#C0392B]">{tr('مدة السداد من 0 إلى 365 يوما')}</p>}
            <p className="text-[11px] text-[#9A8F7E] leading-relaxed">{tr('الاسم وحده يكفي وتكمل بقية بيانات المورد من صفحة الموردين')}</p>
          </div>
          <div className="flex gap-2.5">
            <button type="button" onClick={() => setAdding(null)} disabled={create.isPending}
              className="flex-1 min-h-[48px] rounded-xl border border-[#E9E1D3] bg-white font-bold text-sm text-[#1F1A13]">
              {tr('إلغاء')}
            </button>
            <button type="button" disabled={!canSave} onClick={() => adding && create.mutate(adding)}
              className="flex-1 min-h-[48px] rounded-xl bg-[#E15A30] text-white font-bold text-sm flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
              {create.isPending ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
              {tr('حفظ المورد')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex-shrink-0 p-3 pb-2">
            <div className="relative">
              <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#9A8F7E]" />
              <input className="input ps-9 min-h-[44px]" autoFocus value={q} onChange={e => setQ(e.target.value)}
                placeholder={taxOff ? tr('ابحث بالاسم أو الرمز أو الجوال') : tr('ابحث بالاسم أو الرمز أو الرقم الضريبي')} />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain px-3 pb-3 space-y-2.5">
            {quickAdd && (
              <button type="button" onClick={() => setAdding({ name: q.trim().slice(0, 120), vatNumber: '', phone: '', paymentDays: '' })}
                className="w-full min-h-[48px] rounded-2xl border border-dashed border-[#E15A30]/50 bg-white text-[13px] font-bold text-[#E15A30] flex items-center justify-center gap-1.5 active:bg-[#FBEBE2]">
                <Plus size={16} /> {q.trim() ? `${tr('إضافة مورد جديد')} «${q.trim().slice(0, 40)}»` : tr('إضافة مورد جديد')}
              </button>
            )}
            <MCard>
              {listQ.isLoading ? (
                <div className="py-10"><MSpinner /></div>
              ) : listQ.isError ? (
                <div className="py-10"><MError onRetry={() => listQ.refetch()} text={tr('تعذر تحميل الموردين')} /></div>
              ) : !list.length ? (
                <div className="py-10"><MEmpty icon={Truck} text={tr('لا توجد نتائج')} /></div>
              ) : list.map(s => (
                <MRow key={s.id} onClick={() => onPick(s)}
                  title={<>{s.name}{!s.isActive && <span className="ms-1 text-[10px] font-normal text-[#9A8F7E]">({tr('مؤرشف')})</span>}</>}
                  subtitle={[s.code, taxOff ? null : s.vatNumber, s.phone].filter(Boolean).join(' · ') || undefined}
                  note={typeof s.balance === 'number' && Math.abs(s.balance) > 1e-9
                    ? `${s.balance > 0 ? tr('مستحق له') : tr('رصيد مدين له')} ${formatCurrency(Math.abs(s.balance))}` : undefined}
                  trailing={s.id === value?.id ? <Check size={16} className="text-[#E15A30] flex-shrink-0" /> : undefined} />
              ))}
            </MCard>
          </div>
        </>
      )}
    </div>
  );
}
