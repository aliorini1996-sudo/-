import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { invoiceApi, customerApi, productApi, salesRepApi, companyApi } from '../../api/client';
import { Customer, Product, SalesRep } from '../../types';
import { formatCurrency } from '../../utils/format';
import { InvoiceDoc, Company } from '../../rep/RepDocuments';
import { X, Plus, Trash2, Search } from 'lucide-react';
import toast from 'react-hot-toast';

interface LineItem {
  productId: string;
  productName: string;
  productCode: string;
  unit: string;
  qty: number;
  unitPrice: number;
  discountPct: number;
  taxPct: number;
  lineTotal: number;
}

interface Props { onClose: () => void; onSaved: (doc: InvoiceDoc) => void; }

function calcLine(qty: number, price: number, discPct: number, taxPct: number) {
  const base = qty * price;
  const disc = base * discPct / 100;
  const afterDisc = base - disc;
  const tax = afterDisc * taxPct / 100;
  return Math.round((afterDisc + tax) * 100) / 100;
}

export default function InvoiceModal({ onClose, onSaved }: Props) {
  const [customerId, setCustomerId] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');
  const [type, setType] = useState<'CASH' | 'CREDIT'>('CREDIT');
  const [discountPct, setDiscountPct] = useState(0);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineItem[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [showCustomerList, setShowCustomerList] = useState(false);
  const [showProductList, setShowProductList] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [salesRepId, setSalesRepId] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(''); // فارغ = اليوم؛ يسمح بإصدار قديم

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
      const res = await customerApi.list({ search: customerSearch, limit: 10 });
      return res.data.data as Customer[];
    },
    enabled: customerSearch.length > 0,
  });

  const { data: products } = useQuery({
    queryKey: ['products-search', productSearch],
    queryFn: async () => {
      const res = await productApi.list({ search: productSearch, status: 'ACTIVE', limit: 10 });
      return res.data.data as Product[];
    },
    enabled: productSearch.length > 0,
  });

  const mutation = useMutation({
    mutationFn: (data: unknown) => invoiceApi.create(data),
    onSuccess: (res) => {
      const inv = res.data.data;
      const repName = salesReps?.find(r => r.id === salesRepId)?.name || '';
      const doc: InvoiceDoc = {
        kind: 'invoice', number: inv.number, date: inv.invoiceDate, type, isReturn: false,
        company: company ?? null, customer: selectedCustomer as Customer, repName,
        items: lines.map(l => ({ name: l.productName, unit: l.unit, qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, taxPct: l.taxPct, lineTotal: l.lineTotal })),
        subtotal, discount: totalDiscount, tax: taxTotal, total,
        paidAmt: Number(inv.paidAmt), remainingAmt: Number(inv.remainingAmt),
      };
      toast.success('تم إنشاء الفاتورة');
      onSaved(doc);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'خطأ';
      toast.error(msg);
    },
  });

  const addProduct = (p: Product) => {
    const existing = lines.find(l => l.productId === p.id);
    if (existing) {
      setLines(ls => ls.map(l => l.productId === p.id
        ? { ...l, qty: l.qty + 1, lineTotal: calcLine(l.qty + 1, l.unitPrice, l.discountPct, l.taxPct) }
        : l
      ));
    } else {
      setLines(ls => [...ls, {
        productId: p.id, productName: p.name, productCode: p.code,
        unit: p.unit, qty: 1, unitPrice: Number(p.basePrice),
        discountPct: 0, taxPct: Number(p.taxPct),
        lineTotal: calcLine(1, Number(p.basePrice), 0, Number(p.taxPct)),
      }]);
    }
    setProductSearch('');
    setShowProductList(false);
  };

  const updateLine = (idx: number, field: keyof LineItem, value: number) => {
    setLines(ls => ls.map((l, i) => {
      if (i !== idx) return l;
      const updated = { ...l, [field]: value };
      return { ...updated, lineTotal: calcLine(updated.qty, updated.unitPrice, updated.discountPct, updated.taxPct) };
    }));
  };

  const subtotal = lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
  const totalDiscount = lines.reduce((s, l) => s + l.qty * l.unitPrice * l.discountPct / 100, 0) + subtotal * discountPct / 100;
  const taxTotal = lines.reduce((s, l) => s + (l.qty * l.unitPrice * (1 - l.discountPct / 100) * l.taxPct / 100), 0);
  const total = Math.round((subtotal - totalDiscount + taxTotal) * 100) / 100;

  const handleSubmit = () => {
    if (!customerId) { toast.error('اختر العميل'); return; }
    if (!salesRepId) { toast.error('اختر المندوب'); return; }
    if (lines.length === 0) { toast.error('أضف صنفاً على الأقل'); return; }
    mutation.mutate({
      customerId, salesRepId, type, discountPct, notes,
      ...(invoiceDate && { invoiceDate }),
      items: lines.map(l => ({
        productId: l.productId, qty: l.qty, unitPrice: l.unitPrice,
        discountPct: l.discountPct, taxPct: l.taxPct,
      })),
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center p-4 overflow-y-auto" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl my-4">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="text-lg font-bold text-gray-800">إنشاء فاتورة جديدة</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-5">
          {/* Customer + Rep + Type + Date */}
          <div className="grid grid-cols-4 gap-4">
            <div className="relative">
              <label className="label">العميل *</label>
              <div className="relative">
                <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  className="input pr-9"
                  placeholder="ابحث عن عميل..."
                  value={selectedCustomer ? selectedCustomer.name : customerSearch}
                  onChange={e => { setCustomerSearch(e.target.value); setSelectedCustomer(null); setCustomerId(''); setShowCustomerList(true); }}
                  onFocus={() => setShowCustomerList(true)}
                />
              </div>
              {showCustomerList && customers && customers.length > 0 && (
                <div className="absolute top-full right-0 left-0 z-20 bg-white border border-gray-200 rounded-lg shadow-lg mt-1 max-h-48 overflow-y-auto">
                  {customers.map(c => (
                    <button key={c.id} className="w-full text-right px-3 py-2 hover:bg-[#FBEBE2] text-sm"
                      onClick={() => { setSelectedCustomer(c); setCustomerId(c.id); setShowCustomerList(false); }}>
                      <span className="font-medium">{c.name}</span>
                      <span className="text-gray-400 mr-2 text-xs">{c.phone}</span>
                      {Number(c.balance) > 0 && <span className="text-red-500 text-xs"> • رصيد: {formatCurrency(c.balance)}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <label className="label">المندوب *</label>
              <select className="input" value={salesRepId} onChange={e => setSalesRepId(e.target.value)}>
                <option value="">اختر المندوب</option>
                {salesReps?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">نوع الفاتورة</label>
              <select className="input" value={type} onChange={e => setType(e.target.value as 'CASH' | 'CREDIT')}>
                <option value="CREDIT">آجل</option>
                <option value="CASH">نقدي</option>
              </select>
            </div>
            <div>
              <label className="label">التاريخ</label>
              <input type="date" className="input" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} title="اتركه فارغاً لتاريخ اليوم" />
            </div>
          </div>

          {/* Products */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="label mb-0">الأصناف</label>
              <div className="relative w-64">
                <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  className="input pr-9 text-sm"
                  placeholder="ابحث عن صنف..."
                  value={productSearch}
                  onChange={e => { setProductSearch(e.target.value); setShowProductList(true); }}
                  onFocus={() => setShowProductList(true)}
                />
                {showProductList && products && products.length > 0 && (
                  <div className="absolute top-full right-0 z-20 bg-white border border-gray-200 rounded-lg shadow-lg mt-1 w-80 max-h-48 overflow-y-auto">
                    {products.map(p => (
                      <button key={p.id} className="w-full text-right px-3 py-2 hover:bg-[#FBEBE2] text-sm"
                        onClick={() => addProduct(p)}>
                        <span className="font-medium">{p.name}</span>
                        <span className="text-gray-400 mr-2 text-xs">{p.code} • {formatCurrency(p.basePrice)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="border border-gray-200 rounded-xl overflow-hidden">
              <table className="table">
                <thead>
                  <tr>
                    <th className="w-6"></th>
                    <th>الصنف</th><th>الكمية</th><th>السعر</th>
                    <th>خصم%</th><th>ضريبة%</th><th>الإجمالي</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr><td colSpan={7} className="text-center py-8 text-gray-400 text-sm">ابحث عن صنف وأضفه</td></tr>
                  )}
                  {lines.map((l, i) => (
                    <tr key={l.productId}>
                      <td>
                        <button onClick={() => setLines(ls => ls.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600">
                          <Trash2 size={14} />
                        </button>
                      </td>
                      <td>
                        <p className="font-medium text-sm">{l.productName}</p>
                        <p className="text-xs text-gray-400">{l.unit}</p>
                      </td>
                      <td><input type="number" className="input w-20 text-center" min="0.001" step="0.001" value={l.qty} onChange={e => updateLine(i, 'qty', Number(e.target.value))} /></td>
                      <td><input type="number" className="input w-24" min="0" step="0.01" value={l.unitPrice} onChange={e => updateLine(i, 'unitPrice', Number(e.target.value))} /></td>
                      <td><input type="number" className="input w-16 text-center" min="0" max="100" value={l.discountPct} onChange={e => updateLine(i, 'discountPct', Number(e.target.value))} /></td>
                      <td><input type="number" className="input w-16 text-center" min="0" max="100" value={l.taxPct} onChange={e => updateLine(i, 'taxPct', Number(e.target.value))} /></td>
                      <td className="font-semibold text-gray-800">{formatCurrency(l.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Totals */}
          <div className="flex justify-end">
            <div className="w-64 space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-gray-500">المجموع قبل الخصم</span><span>{formatCurrency(subtotal)}</span></div>
              <div className="flex justify-between items-center">
                <span className="text-gray-500">خصم عام %</span>
                <input type="number" className="input w-20 text-center" min="0" max="100" value={discountPct} onChange={e => setDiscountPct(Number(e.target.value))} />
              </div>
              <div className="flex justify-between text-red-500"><span>إجمالي الخصم</span><span>- {formatCurrency(totalDiscount)}</span></div>
              <div className="flex justify-between text-[#E15A30]"><span>ضريبة القيمة المضافة</span><span>{formatCurrency(taxTotal)}</span></div>
              <div className="flex justify-between font-bold text-lg border-t pt-2"><span>الإجمالي النهائي</span><span>{formatCurrency(total)}</span></div>
            </div>
          </div>

          <div>
            <label className="label">ملاحظات</label>
            <textarea className="input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-5 border-t">
          <button onClick={handleSubmit} disabled={mutation.isPending} className="btn-primary flex-1 justify-center py-2.5">
            {mutation.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Plus size={16} />}
            إصدار الفاتورة
          </button>
          <button onClick={onClose} className="btn-secondary">إلغاء</button>
        </div>
      </div>
    </div>
  );
}
