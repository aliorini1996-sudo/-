import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { receiptApi, customerApi, invoiceApi, salesRepApi, companyApi } from '../../api/client';
import { Customer, Invoice, SalesRep } from '../../types';
import { formatCurrency } from '../../utils/format';
import { ReceiptDoc, Company } from '../../rep/RepDocuments';
import { X, Search, Plus } from 'lucide-react';
import toast from 'react-hot-toast';

interface Props { onClose: () => void; onSaved: (doc: ReceiptDoc) => void; }

export default function ReceiptModal({ onClose, onSaved }: Props) {
  const [customerId, setCustomerId] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerSearch, setCustomerSearch] = useState('');
  const [showCustomerList, setShowCustomerList] = useState(false);
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
    queryKey: ['customers-search', customerSearch],
    queryFn: async () => {
      const res = await customerApi.list({ search: customerSearch, limit: 8 });
      return res.data.data as Customer[];
    },
    enabled: customerSearch.length > 0,
  });

  const { data: openInvoices } = useQuery({
    queryKey: ['open-invoices', customerId],
    queryFn: async () => {
      const res = await invoiceApi.list({ customerId, status: 'CONFIRMED', type: 'CREDIT', limit: 50 });
      return (res.data.data as Invoice[]).filter(i => Number(i.remainingAmt) > 0);
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
      toast.success('تم إصدار السند');
      onSaved(doc);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'خطأ';
      toast.error(msg);
    },
  });

  const totalAllocated = Object.values(allocations).reduce((s, v) => s + v, 0);

  const handleSubmit = () => {
    if (!customerId) { toast.error('اختر العميل'); return; }
    if (!salesRepId) { toast.error('اختر المندوب'); return; }
    if (!amount || Number(amount) <= 0) { toast.error('أدخل المبلغ'); return; }
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
          <h2 className="text-lg font-bold text-gray-800">إصدار سند قبض</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* Customer */}
          <div className="relative">
            <label className="label">العميل *</label>
            <div className="relative">
              <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input className="input pr-9" placeholder="ابحث عن عميل..."
                value={selectedCustomer ? selectedCustomer.name : customerSearch}
                onChange={e => { setCustomerSearch(e.target.value); setSelectedCustomer(null); setCustomerId(''); setShowCustomerList(true); }}
                onFocus={() => setShowCustomerList(true)}
              />
            </div>
            {showCustomerList && customers && customers.length > 0 && (
              <div className="absolute top-full right-0 left-0 z-20 bg-white border border-gray-200 rounded-lg shadow-lg mt-1 max-h-48 overflow-y-auto">
                {customers.map(c => (
                  <button key={c.id} className="w-full text-right px-3 py-2 hover:bg-blue-50 text-sm"
                    onClick={() => { setSelectedCustomer(c); setCustomerId(c.id); setCustomerSearch(''); setShowCustomerList(false); setAllocations({}); }}>
                    <span className="font-medium">{c.name}</span>
                    {Number(c.balance) > 0 && <span className="text-red-500 text-xs mr-2">رصيد: {formatCurrency(c.balance)}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Sales Rep */}
          <div>
            <label className="label">المندوب *</label>
            <select className="input" value={salesRepId} onChange={e => setSalesRepId(e.target.value)}>
              <option value="">اختر المندوب</option>
              {salesReps?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>

          {/* Amount + Method */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">المبلغ *</label>
              <input type="number" className="input" min="0" step="0.01" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} />
            </div>
            <div>
              <label className="label">طريقة الدفع</label>
              <select className="input" value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)}>
                <option value="CASH">نقدي</option>
                <option value="BANK_TRANSFER">تحويل بنكي</option>
                <option value="POS">شبكة</option>
                <option value="CHEQUE">شيك</option>
              </select>
            </div>
          </div>

          <div className="max-w-[12rem]">
            <label className="label">التاريخ</label>
            <input type="date" className="input" value={receiptDate} onChange={e => setReceiptDate(e.target.value)} title="اتركه فارغاً لتاريخ اليوم" />
          </div>

          {paymentMethod === 'CHEQUE' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">رقم الشيك</label>
                <input className="input" value={chequeNumber} onChange={e => setChequeNumber(e.target.value)} />
              </div>
              <div>
                <label className="label">اسم البنك</label>
                <input className="input" value={bankName} onChange={e => setBankName(e.target.value)} />
              </div>
            </div>
          )}

          {/* Open Invoices */}
          {openInvoices && openInvoices.length > 0 && (
            <div>
              <label className="label">توزيع على الفواتير (اختياري)</label>
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <table className="table">
                  <thead>
                    <tr><th>رقم الفاتورة</th><th>المتبقي</th><th>التخصيص</th></tr>
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
              {totalAllocated > 0 && (
                <p className="text-xs text-gray-500 mt-1">موزع: {formatCurrency(totalAllocated)}</p>
              )}
            </div>
          )}

          <div>
            <label className="label">ملاحظات</label>
            <textarea className="input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
        </div>

        <div className="flex gap-3 p-5 border-t">
          <button onClick={handleSubmit} disabled={mutation.isPending} className="btn-primary flex-1 justify-center py-2.5">
            {mutation.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Plus size={16} />}
            إصدار السند
          </button>
          <button onClick={onClose} className="btn-secondary">إلغاء</button>
        </div>
      </div>
    </div>
  );
}
