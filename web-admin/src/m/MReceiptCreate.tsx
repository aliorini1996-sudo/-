import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Banknote, Landmark, CreditCard, FileText, Loader2, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import { customerApi, salesRepApi, receiptApi } from '../api/client';
import { Invoice } from '../types';
import { formatCurrency, formatDate } from '../utils/format';
import { useTr } from '../i18n/strings';
import { MHeader, MSpinner } from './mobileUi';
import { expectArray } from './shape';

interface Pick { id: string; name: string; code?: string; phone?: string }

const METHODS = [
  { v: 'CASH', label: 'نقدي', icon: Banknote },
  { v: 'BANK_TRANSFER', label: 'تحويل', icon: Landmark },
  { v: 'POS', label: 'شبكة', icon: CreditCard },
  { v: 'CHEQUE', label: 'شيك', icon: FileText },
] as const;

/**
 * إصدار سند قبض من الجوال.
 *
 * ما ينفرد به الأدمن عن شاشة المندوب: اختيار العميل **والمندوب**، وحقول
 * الشيك/البنك، ومنتقي التاريخ، **وتوزيع المبلغ على الفواتير المفتوحة**.
 *
 * والتوزيع **بطاقاتٌ لا جدول**: جدول بأربعة أعمدة على عرض ٣٦٠px يصير غير
 * قابل للقراءة ولا للّمس.
 */
export default function MReceiptCreate({ presetCustomerId, onClose, onCreated }: {
  presetCustomerId?: string;
  onClose: () => void;
  onCreated: (receiptId: string) => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const [customerId, setCustomerId] = useState(presetCustomerId || '');
  const [salesRepId, setSalesRepId] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<string>('CASH');
  const [chequeNumber, setChequeNumber] = useState('');
  const [bankName, setBankName] = useState('');
  const [receiptDate, setReceiptDate] = useState('');
  const [notes, setNotes] = useState('');
  const [alloc, setAlloc] = useState<Record<string, number>>({});
  const [cq, setCq] = useState('');

  const customersQ = useQuery({
    queryKey: ['m-rcp-customers', cq],
    queryFn: async () => expectArray<Pick>((await customerApi.list({ search: cq, limit: 40 })).data?.data, tr('العملاء')),
  });
  const repsQ = useQuery({
    queryKey: ['m-inv-reps'],
    queryFn: async () => expectArray<Pick>((await salesRepApi.list({ limit: 200 })).data?.data, tr('المناديب')),
  });
  // فواتير العميل المفتوحة — للتوزيع
  const invQ = useQuery({
    queryKey: ['m-rcp-invoices', customerId],
    queryFn: async () => expectArray<Invoice>((await customerApi.invoices(customerId)).data?.data, tr('الفواتير')),
    enabled: !!customerId,
  });

  const openInvoices = useMemo(
    () => (invQ.data ?? []).filter(i => i.status === 'CONFIRMED' && i.type === 'CREDIT' && Number(i.remainingAmt) > 0.001),
    [invQ.data],
  );
  const allocTotal = useMemo(() => Object.values(alloc).reduce((s, v) => s + (v || 0), 0), [alloc]);
  const amt = Number(amount) || 0;
  const overAllocated = allocTotal > amt + 0.001;

  const save = useMutation({
    mutationFn: async () => {
      const invoiceAllocations = Object.entries(alloc)
        .filter(([, v]) => v > 0)
        .map(([invoiceId, a]) => ({ invoiceId, amount: a }));
      const res = await receiptApi.create({
        customerId, salesRepId, amount: amt, paymentMethod: method,
        ...(method === 'CHEQUE' && chequeNumber.trim() && { chequeNumber: chequeNumber.trim() }),
        ...((method === 'CHEQUE' || method === 'BANK_TRANSFER') && bankName.trim() && { bankName: bankName.trim() }),
        ...(receiptDate && { receiptDate }),
        ...(notes.trim() && { notes: notes.trim() }),
        ...(invoiceAllocations.length && { invoiceAllocations }),
      });
      return res.data.data as { id: string };
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['m-docs', 'receipt'] });
      qc.invalidateQueries({ queryKey: ['m-dashboard'] });
      toast.success(tr('تم إصدار السند'));
      onCreated(r.id);
    },
    onError: (e: unknown) =>
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذّر الإصدار')),
  });

  const ready = !!customerId && !!salesRepId && amt > 0 && !overAllocated;

  /** يوزّع المبلغ تلقائياً على الأقدم فالأحدث — أكثر ما يُفعل يدوياً */
  const autoAllocate = () => {
    let left = amt;
    const next: Record<string, number> = {};
    for (const inv of openInvoices) {
      if (left <= 0.001) break;
      const take = Math.min(left, Number(inv.remainingAmt));
      next[inv.id] = Math.round(take * 100) / 100;
      left -= take;
    }
    setAlloc(next);
  };

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={tr('سند قبض جديد')} onBack={onClose} />

      <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-3">
        <div>
          <label className="label">{tr('المبلغ')} *</label>
          <input type="number" dir="ltr" inputMode="decimal" className="input text-lg font-bold text-center"
            value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
        </div>

        <div>
          <label className="label">{tr('طريقة الدفع')}</label>
          <div className="grid grid-cols-4 gap-2">
            {METHODS.map(m => {
              const Icon = m.icon;
              const on = method === m.v;
              return (
                <button key={m.v} onClick={() => setMethod(m.v)}
                  className={`flex flex-col items-center gap-1 py-2.5 rounded-xl border min-h-[60px] justify-center ${on ? 'bg-[#E9F6EF] border-[#2F855A] text-[#2F855A]' : 'bg-white border-[#E9E1D3] text-[#6E6557]'}`}>
                  <Icon size={17} />
                  <span className="text-[10px] font-semibold">{tr(m.label)}</span>
                </button>
              );
            })}
          </div>
        </div>

        {method === 'CHEQUE' && (
          <div>
            <label className="label">{tr('رقم الشيك')}</label>
            <input className="input" dir="ltr" value={chequeNumber} onChange={e => setChequeNumber(e.target.value)} />
          </div>
        )}
        {(method === 'CHEQUE' || method === 'BANK_TRANSFER') && (
          <div>
            <label className="label">{tr('اسم البنك')}</label>
            <input className="input" value={bankName} onChange={e => setBankName(e.target.value)} />
          </div>
        )}

        <div>
          <label className="label">{tr('المندوب')} *</label>
          {repsQ.isLoading ? <MSpinner /> : (
            <select className="input" value={salesRepId} onChange={e => setSalesRepId(e.target.value)}>
              <option value="">{tr('اختر المندوب')}</option>
              {(repsQ.data ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
        </div>

        <div>
          <label className="label">{tr('العميل')} *</label>
          <div className="relative mb-2">
            <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#9A8F7E]" />
            <input value={cq} onChange={e => setCq(e.target.value)} className="input ps-9" placeholder={tr('ابحث عن عميل…')} />
          </div>
          <div className="rounded-xl border border-[#F1EBDF] bg-white max-h-52 overflow-y-auto divide-y divide-[#F1EBDF]">
            {customersQ.isLoading ? <p className="text-center text-xs text-[#9A8F7E] py-5">{tr('جاري التحميل...')}</p>
              : !customersQ.data?.length ? <p className="text-center text-xs text-[#9A8F7E] py-5">{tr('لا نتائج')}</p>
              : customersQ.data.map(c => (
                <button key={c.id} onClick={() => { setCustomerId(c.id); setAlloc({}); }}
                  className={`w-full text-start px-3 py-3 min-h-[52px] flex items-center gap-2 ${customerId === c.id ? 'bg-[#E9F6EF]' : 'active:bg-[#FAF7F0]'}`}>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-[#1F1A13] truncate">{c.name}</span>
                    <span className="block text-[11px] text-[#9A8F7E] truncate">{[c.code, c.phone].filter(Boolean).join(' · ')}</span>
                  </span>
                  {customerId === c.id && <Check size={16} className="text-[#2F855A] flex-shrink-0" />}
                </button>
              ))}
          </div>
        </div>

        <div>
          <label className="label">{tr('تاريخ السند')}</label>
          <input type="date" className="input" dir="ltr" value={receiptDate} onChange={e => setReceiptDate(e.target.value)} />
        </div>

        {/* توزيع المبلغ على الفواتير المفتوحة — بطاقات لا جدول */}
        {customerId && openInvoices.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="label mb-0">{tr('توزيع على الفواتير')}</label>
              <button onClick={autoAllocate} disabled={amt <= 0}
                className="text-[11px] font-semibold text-[#E15A30] disabled:text-[#C9BFB0]">
                {tr('وزّع تلقائياً')}
              </button>
            </div>
            <div className="rounded-2xl border border-[#F1EBDF] bg-white divide-y divide-[#F1EBDF]">
              {openInvoices.map(inv => (
                <div key={inv.id} className="p-3 flex items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-[#1F1A13] truncate" dir="ltr">{inv.number}</span>
                    <span className="block text-[11px] text-[#9A8F7E]">
                      {formatDate(inv.invoiceDate)} · {tr('متبقٍّ')} {formatCurrency(Number(inv.remainingAmt))}
                    </span>
                  </span>
                  <input type="number" dir="ltr" inputMode="decimal" className="input w-24 text-center py-1.5"
                    value={alloc[inv.id] ?? ''} placeholder="0"
                    onChange={e => setAlloc(a => ({ ...a, [inv.id]: Math.max(0, Number(e.target.value) || 0) }))} />
                </div>
              ))}
            </div>
            <p className={`text-[11px] mt-1.5 px-1 ${overAllocated ? 'text-[#C0392B] font-semibold' : 'text-[#9A8F7E]'}`}>
              {tr('الموزَّع')}: {formatCurrency(allocTotal)} {tr('من')} {formatCurrency(amt)}
              {overAllocated && ` — ${tr('التوزيع أكبر من مبلغ السند')}`}
            </p>
          </div>
        )}

        <div>
          <label className="label">{tr('ملاحظات')}</label>
          <input className="input" value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
        <div className="h-2" />
      </div>

      <div className="flex-shrink-0 border-t border-[#E9E1D3] bg-white p-3"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
        <button onClick={() => save.mutate()} disabled={!ready || save.isPending}
          className="w-full bg-[#2F855A] text-white font-bold py-3.5 rounded-xl min-h-[50px] flex items-center justify-center gap-2 disabled:opacity-60">
          {save.isPending && <Loader2 size={16} className="animate-spin" />}
          {tr('إصدار السند')} {amt > 0 && `· ${formatCurrency(amt)}`}
        </button>
      </div>
    </div>
  );
}
