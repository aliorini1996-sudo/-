import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { receiptApi, customerApi, invoiceApi, salesRepApi, companyApi } from '../../api/client';
import { Customer, Invoice, SalesRep } from '../../types';
import { formatCurrency } from '../../utils/format';
import { useTr } from '../../i18n/strings';
import { ReceiptDoc, Company } from '../../rep/RepDocuments';
import { X, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import SearchableSelect from '../SearchableSelect';

interface Props { onClose: () => void; onSaved: (doc: ReceiptDoc) => void; }

/** تقريب نقدي محلي — يمنع غبار العائمة في مقارنات التوزيع */
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export default function ReceiptModal({ onClose, onSaved }: Props) {
  const tr = useTr();
  const [customerId, setCustomerId] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('CASH');
  const [chequeNumber, setChequeNumber] = useState('');
  const [bankName, setBankName] = useState('');
  const [notes, setNotes] = useState('');
  const [salesRepId, setSalesRepId] = useState('');
  const [receiptDate, setReceiptDate] = useState(''); // فارغ = اليوم؛ يسمح بإصدار قديم
  const [allocations, setAllocations] = useState<Record<string, number>>({});

  const { data: salesReps } = useQuery({
    queryKey: ['sales-reps-all'],
    queryFn: async () => {
      const res = await salesRepApi.list({ limit: 100 });
      return (res.data.data as SalesRep[]).filter(r => r.isActive);
    },
  });

  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: async () => { const res = await companyApi.get(); return res.data.data as Company; },
  });

  const { data: customers } = useQuery({
    queryKey: ['customers-all'],
    queryFn: async () => {
      const res = await customerApi.list({ limit: 1000 });
      return res.data.data as Customer[];
    },
  });

  const { data: openInvoices } = useQuery({
    queryKey: ['open-invoices', customerId],
    queryFn: async () => {
      const res = await invoiceApi.list({ customerId, status: 'CONFIRMED', type: 'CREDIT', limit: 50 });
      // 1e-6 يحجب غبار العائمة التاريخي (2.84e-14) دون اخفاء اي متبق حقيقي
      return (res.data.data as Invoice[]).filter(i => Number(i.remainingAmt) > 1e-6);
    },
    enabled: !!customerId,
  });

  const mutation = useMutation({
    mutationFn: (data: unknown) => receiptApi.create(data),
    onSuccess: (res) => {
      const rcp = res.data.data;
      const repName = salesReps?.find(r => r.id === salesRepId)?.name || '';
      const doc: ReceiptDoc = {
        kind: 'receipt', number: rcp.number, date: rcp.receiptDate,
        company: company ?? null, customer: selectedCustomer as Customer, repName,
        amount: Number(amount), paymentMethod, notes: notes || undefined,
      };
      toast.success(tr('تم إصدار السند'));
      onSaved(doc);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('خطأ');
      toast.error(msg);
    },
  });

  const totalAllocated = round2(Object.values(allocations).reduce((s, v) => s + v, 0));
  // مديونية العميل المفتوحة — سقف ما يمكن توزيعه
  const outstanding = round2((openInvoices ?? []).reduce((s, i) => s + Math.max(0, Number(i.remainingAmt) || 0), 0));
  /**
   * التوزيع إلزاميّ (قرار المالك) — لكن بحدّ المعقول: يُطالَب المستخدم بتوزيع
   * الأصغر بين مبلغ السند ومديونية العميل. من دفع أكثر من دَينه يبقى الفائض
   * رصيداً دائناً له، ولا يُطالَب أحد بتوزيع مبلغ لا فواتير له.
   */
  const required = round2(Math.min(Number(amount) || 0, outstanding));
  const shortfall = round2(required - totalAllocated);

  /** توزيع آليّ بالأقدم أولاً — يجعل الإلزام خطوة واحدة لا عبئاً */
  const autoAllocate = () => {
    let left = round2(Number(amount) || 0);
    const next: Record<string, number> = {};
    for (const inv of openInvoices ?? []) {
      if (left <= 0.004) break;
      const take = round2(Math.min(Number(inv.remainingAmt) || 0, left));
      if (take > 0.004) { next[inv.id] = take; left = round2(left - take); }
    }
    setAllocations(next);
  };

  const handleSubmit = () => {
    if (!customerId) { toast.error(tr('اختر العميل')); return; }
    if (!salesRepId) { toast.error(tr('اختر المندوب')); return; }
    if (!amount || Number(amount) <= 0) { toast.error(tr('أدخل المبلغ')); return; }
    // التوزيع إلزاميّ: لا يُصدر سند يطفو بلا فواتير ما دام للعميل مديونية مفتوحة
    if (shortfall > 0.004) {
      toast.error(`${tr('وزع كامل مبلغ السند على الفواتير — المتبقي')}: ${formatCurrency(shortfall)}`);
      return;
    }
    const invoiceAllocations = Object.entries(allocations)
      .filter(([, v]) => v > 0)
      .map(([invoiceId, amt]) => ({ invoiceId, amount: amt }));
    mutation.mutate({
      customerId, salesRepId, amount: Number(amount), paymentMethod,
      ...(receiptDate && { receiptDate }),
      chequeNumber: chequeNumber || undefined,
      bankName: bankName || undefined,
      notes: notes || undefined,
      invoiceAllocations,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="text-lg font-bold text-gray-800">{tr('إصدار سند قبض')}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* Customer */}
          <div>
            <label className="label">{tr('العميل')} *</label>
            <SearchableSelect
              placeholder={tr('اختر العميل')}
              searchPlaceholder={tr('اكتب اسم أو جوال العميل')}
              value={customerId}
              options={(customers || []).map(c => ({
                value: c.id,
                label: c.name,
                hint: Number(c.balance) > 0 ? `${tr('رصيد')} ${formatCurrency(c.balance)}` : c.phone,
                hintColor: Number(c.balance) > 0 ? 'text-red-500' : undefined,
              }))}
              onChange={(v) => { setCustomerId(v); setSelectedCustomer((customers || []).find(c => c.id === v) || null); setAllocations({}); }}
            />
          </div>

          {/* Sales Rep */}
          <div>
            <label className="label">{tr('المندوب')} *</label>
            <select className="input" value={salesRepId} onChange={e => setSalesRepId(e.target.value)}>
              <option value="">{tr('اختر المندوب')}</option>
              {salesReps?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>

          {/* Amount + Method */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">{tr('المبلغ')} *</label>
              <input type="number" className="input" min="0" step="0.01" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} />
            </div>
            <div>
              <label className="label">{tr('طريقة الدفع')}</label>
              <select className="input" value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)}>
                <option value="CASH">{tr('نقدي')}</option>
                <option value="BANK_TRANSFER">{tr('تحويل بنكي')}</option>
                <option value="POS">{tr('شبكة')}</option>
                <option value="CHEQUE">{tr('شيك')}</option>
              </select>
            </div>
          </div>

          <div className="max-w-[12rem]">
            <label className="label">{tr('التاريخ')}</label>
            <input type="date" className="input" value={receiptDate} onChange={e => setReceiptDate(e.target.value)} title={tr('اتركه فارغا لتاريخ اليوم')} />
          </div>

          {paymentMethod === 'CHEQUE' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">{tr('رقم الشيك')}</label>
                <input className="input" value={chequeNumber} onChange={e => setChequeNumber(e.target.value)} />
              </div>
              <div>
                <label className="label">{tr('اسم البنك')}</label>
                <input className="input" value={bankName} onChange={e => setBankName(e.target.value)} />
              </div>
            </div>
          )}

          {/* Open Invoices — التوزيع إلزاميّ */}
          {openInvoices && openInvoices.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
                <label className="label !mb-0">{tr('توزيع على الفواتير')} *</label>
                <button type="button" onClick={autoAllocate} disabled={!amount || Number(amount) <= 0}
                  className="text-xs font-bold text-[#2E6FB0] hover:underline disabled:text-gray-300 disabled:no-underline">
                  {tr('توزيع تلقائي على الأقدم')}
                </button>
              </div>
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <table className="table">
                  <thead>
                    <tr><th>{tr('رقم الفاتورة')}</th><th>{tr('المتبقي')}</th><th>{tr('التخصيص')}</th></tr>
                  </thead>
                  <tbody>
                    {openInvoices.map(inv => (
                      <tr key={inv.id}>
                        <td className="font-mono text-sm">{inv.number}</td>
                        <td className="text-red-600">{formatCurrency(inv.remainingAmt)}</td>
                        <td>
                          <input
                            type="number" className="input w-28" min="0" step="0.01"
                            max={Number(inv.remainingAmt)}
                            value={allocations[inv.id] || ''}
                            onChange={e => setAllocations(a => ({ ...a, [inv.id]: Number(e.target.value) }))}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between mt-1.5 text-xs gap-2 flex-wrap">
                <span className="text-gray-500">{tr('موزع')}: <b className="text-gray-700">{formatCurrency(totalAllocated)}</b> {tr('من')} {formatCurrency(required)}</span>
                {shortfall > 0.004
                  ? <span className="font-bold text-[#B4530A]">{tr('يلزم توزيع')} {formatCurrency(shortfall)}</span>
                  : <span className="font-bold text-green-600">✓ {tr('التوزيع مكتمل')}</span>}
              </div>
              {Number(amount) > outstanding + 0.004 && (
                <p className="text-[11px] text-gray-500 mt-1">
                  {tr('الفائض عن مديونية العميل')} ({formatCurrency(round2(Number(amount) - outstanding))}) {tr('يبقى رصيدا دائنا له')}
                </p>
              )}
            </div>
          )}

          {selectedCustomer && openInvoices && openInvoices.length === 0 && (
            <p className="text-xs text-gray-500 bg-[#FAF7F0] border border-[#E9E1D3] rounded-xl px-3 py-2">
              {tr('لا فواتير مفتوحة لهذا العميل — يسجل السند دفعة مقدمة ورصيدا دائنا له')}
            </p>
          )}

          <div>
            <label className="label">{tr('ملاحظات')}</label>
            <textarea className="input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
        </div>

        <div className="flex gap-3 p-5 border-t">
          <button onClick={handleSubmit} disabled={mutation.isPending} className="btn-primary flex-1 justify-center py-2.5">
            {mutation.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Plus size={16} />}
            {tr('إصدار السند')}
          </button>
          <button onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}
