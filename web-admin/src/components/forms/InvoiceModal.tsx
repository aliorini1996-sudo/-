import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { invoiceApi, customerApi, productApi, salesRepApi, companyApi } from '../../api/client';
import { Customer, Product, SalesRep } from '../../types';
import { formatCurrency } from '../../utils/format';
import { useTr } from '../../i18n/strings';
import { InvoiceDoc, Company } from '../../rep/RepDocuments';
import { X, Trash2, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import SearchableSelect from '../SearchableSelect';

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
  const tr = useTr();
  const [customerId, setCustomerId] = useState('');
  const [type, setType] = useState<'CASH' | 'CREDIT'>('CREDIT');
  const [discountPct, setDiscountPct] = useState(0);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineItem[]>([]);
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

  // نجلب القائمة كاملة لتعمل القائمة المنسدلة بالتصفية المحلية بالكتابة
  const { data: customers } = useQuery({
    queryKey: ['customers-all'],
    queryFn: async () => {
      const res = await customerApi.list({ limit: 1000 });
      return res.data.data as Customer[];
    },
  });

  const { data: products } = useQuery({
    queryKey: ['products-all'],
    queryFn: async () => {
      const res = await productApi.list({ status: 'ACTIVE', limit: 1000 });
      return res.data.data as Product[];
    },
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
      toast.success(tr('تم إنشاء الفاتورة'));
      onSaved(doc);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('خطأ');
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
    if (!customerId) { toast.error(tr('اختر العميل')); return; }
    if (!salesRepId) { toast.error(tr('اختر المندوب')); return; }
    if (lines.length === 0) { toast.error(tr('أضف صنفاً على الأقل')); return; }
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
          <h2 className="text-lg font-bold text-gray-800">{tr('إنشاء فاتورة جديدة')}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-5">
          {/* Customer + Rep + Type + Date */}
          <div className="grid grid-cols-4 gap-4">
            <div>
              <label className="label">{tr('العميل')} *</label>
              <SearchableSelect
                placeholder={tr('اختر العميل')}
                searchPlaceholder={tr('اكتب اسم أو جوال العميل…')}
                value={customerId}
                options={(customers || []).map(c => ({
                  value: c.id,
                  label: c.name,
                  hint: c.phone + (Number(c.balance) > 0 ? ` • ${tr('رصيد')} ${formatCurrency(c.balance)}` : ''),
                  hintColor: Number(c.balance) > 0 ? 'text-red-500' : undefined,
                }))}
                onChange={(v) => { setCustomerId(v); setSelectedCustomer((customers || []).find(c => c.id === v) || null); }}
              />
            </div>
            <div>
              <label className="label">{tr('المندوب')} *</label>
              <select className="input" value={salesRepId} onChange={e => setSalesRepId(e.target.value)}>
                <option value="">{tr('اختر المندوب')}</option>
                {salesReps?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">{tr('نوع الفاتورة')}</label>
              <select className="input" value={type} onChange={e => setType(e.target.value as 'CASH' | 'CREDIT')}>
                <option value="CREDIT">{tr('آجل')}</option>
                <option value="CASH">{tr('نقدي')}</option>
              </select>
            </div>
            <div>
              <label className="label">{tr('التاريخ')}</label>
              <input type="date" className="input" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} title={tr('اتركه فارغاً لتاريخ اليوم')} />
            </div>
          </div>

          {/* Products */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="label mb-0">{tr('الأصناف')}</label>
              <div className="w-72">
                <SearchableSelect
                  placeholder={tr('أضف صنفاً')}
                  searchPlaceholder={tr('اكتب اسم أو كود الصنف…')}
                  value=""
                  resetOnSelect
                  options={(products || []).map(p => ({ value: p.id, label: p.name, hint: `${p.code} • ${formatCurrency(p.basePrice)}` }))}
                  onChange={(v) => { const p = (products || []).find(x => x.id === v); if (p) addProduct(p); }}
                />
              </div>
            </div>

            <div className="border border-gray-200 rounded-xl overflow-hidden">
              <table className="table">
                <thead>
                  <tr>
                    <th className="w-6"></th>
                    <th>{tr('الصنف')}</th><th>{tr('الكمية')}</th><th>{tr('السعر')}</th>
                    <th>{tr('خصم%')}</th><th>{tr('ضريبة%')}</th><th>{tr('الإجمالي')}</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr><td colSpan={7} className="text-center py-8 text-gray-400 text-sm">{tr('اختر صنفاً من القائمة لإضافته')}</td></tr>
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
              <div className="flex justify-between"><span className="text-gray-500">{tr('المجموع قبل الخصم')}</span><span>{formatCurrency(subtotal)}</span></div>
              <div className="flex justify-between items-center">
                <span className="text-gray-500">{tr('خصم عام %')}</span>
                <input type="number" className="input w-20 text-center" min="0" max="100" value={discountPct} onChange={e => setDiscountPct(Number(e.target.value))} />
              </div>
              <div className="flex justify-between text-red-500"><span>{tr('إجمالي الخصم')}</span><span>- {formatCurrency(totalDiscount)}</span></div>
              <div className="flex justify-between text-[#E15A30]"><span>{tr('ضريبة القيمة المضافة')}</span><span>{formatCurrency(taxTotal)}</span></div>
              <div className="flex justify-between font-bold text-lg border-t pt-2"><span>{tr('الإجمالي النهائي')}</span><span>{formatCurrency(total)}</span></div>
            </div>
          </div>

          <div>
            <label className="label">{tr('ملاحظات')}</label>
            <textarea className="input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-5 border-t">
          <button onClick={handleSubmit} disabled={mutation.isPending} className="btn-primary flex-1 justify-center py-2.5">
            {mutation.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Plus size={16} />}
            {tr('إصدار الفاتورة')}
          </button>
          <button onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}
