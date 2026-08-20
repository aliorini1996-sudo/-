import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { warehouseApi, productApi } from '../api/client';
import { formatDate } from '../utils/format';
import { useTr } from '../i18n/strings';
import SearchableSelect from '../components/SearchableSelect';
import { Warehouse, PackagePlus, X, Trash2, TrendingUp, TrendingDown, AlertTriangle, Calendar, ArrowRightLeft } from 'lucide-react';
import toast from 'react-hot-toast';

interface WhRow {
  productId: string; name: string; code: string; unit: string;
  received: number; adjusted: number; loadedToVans: number; returnedFromVans: number; onHand: number;
}
interface WhEntry {
  id: string; type: string; note: string | null; supplier: string | null; createdBy: string | null; createdAt: string;
  items: { id: string; qty: number; product: { name: string; unit: string } }[];
}

const fmtQty = (n: number) => Number(n.toFixed(2)).toLocaleString('en-US');

// مخزون الشركة (المستودع المركزيّ) — مرتبطٌ بمخزون السيارات:
// التحميل يخرج من المستودع، والتنزيل يعود إليه، والوارد يزيده.
export default function CompanyWarehousePage() {
  const tr = useTr();
  const [showEntry, setShowEntry] = useState(false);

  const stockQ = useQuery({
    queryKey: ['warehouse-stock'],
    queryFn: async () => (await warehouseApi.stock()).data.data as WhRow[],
  });
  const entriesQ = useQuery({
    queryKey: ['warehouse-entries'],
    queryFn: async () => (await warehouseApi.entries()).data.data as WhEntry[],
  });

  const rows = stockQ.data || [];
  const lowCount = rows.filter(r => r.onHand <= 0).length;

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-[#1F1A13] flex items-center gap-2"><Warehouse size={22} className="text-[#E15A30]" /> {tr('مخزون الشركة')}</h1>
          <p className="text-xs text-[#9A8F7E] mt-1">{tr('المستودع المركزي التحميل يخرج منه والتنزيل يعود إليه والوارد يزيده')}</p>
        </div>
        <button onClick={() => setShowEntry(true)} className="btn-primary"><PackagePlus size={17} /> {tr('استلام / تسوية')}</button>
      </div>

      {lowCount > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-sm text-amber-800 flex items-center gap-2">
          <AlertTriangle size={16} /> {lowCount} {tr('صنفا برصيد صفر أو سالب يحتاج استلام بضاعة')}
        </div>
      )}

      {/* جدول الرصيد */}
      <div className="card p-0 overflow-hidden">
        {stockQ.isLoading ? (
          <div className="p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">{tr('لا توجد أصناف أضف منتجات ثم سجل استلام بضاعة')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[#FAF7F0] text-[#6E6557] text-xs">
                  <th className="text-start font-semibold px-4 py-2.5">{tr('الصنف')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('الرصيد بالمستودع')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('الوارد')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('خرج للسيارات')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('عاد منها')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F1EBDF]">
                {rows.map(r => (
                  <tr key={r.productId} className={r.onHand < 0 ? 'bg-red-50/40' : undefined}>
                    <td className="px-4 py-2.5">
                      <div className="font-semibold text-[#1F1A13]">{r.name}</div>
                      <div className="text-[11px] text-[#9A8F7E]">{r.code} · {r.unit}</div>
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <span className={`font-extrabold ${r.onHand < 0 ? 'text-red-600' : r.onHand === 0 ? 'text-amber-600' : 'text-[#1E7A52]'}`}>{fmtQty(r.onHand)}</span>
                    </td>
                    <td className="px-3 py-2.5 text-center text-[#6E6557]">{fmtQty(r.received + r.adjusted)}</td>
                    <td className="px-3 py-2.5 text-center text-[#C94E28]">−{fmtQty(r.loadedToVans)}</td>
                    <td className="px-3 py-2.5 text-center text-[#1E7A52]">+{fmtQty(r.returnedFromVans)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* سجلّ الوارد والتسويات */}
      <div className="card p-0 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#F1EBDF] font-bold text-[#1F1A13] text-sm flex items-center gap-2">
          <ArrowRightLeft size={16} className="text-[#E15A30]" /> {tr('سجل الوارد والتسويات')}
        </div>
        {entriesQ.isLoading ? (
          <div className="p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>
        ) : (entriesQ.data || []).length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">{tr('لا توجد حركات وارد بعد')}</div>
        ) : (
          <div className="max-h-[360px] overflow-y-auto divide-y divide-[#F1EBDF]">
            {(entriesQ.data || []).map(e => (
              <div key={e.id} className="px-5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-md flex items-center gap-1 ${e.type === 'RECEIVE' ? 'text-[#1E7A52] bg-green-50' : 'text-purple-600 bg-purple-50'}`}>
                    {e.type === 'RECEIVE' ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                    {e.type === 'RECEIVE' ? tr('وارد') : tr('تسوية')}
                  </span>
                  <span className="text-[11px] text-[#9A8F7E] flex items-center gap-1"><Calendar size={11} /> {formatDate(e.createdAt)}</span>
                </div>
                {(e.supplier || e.note) && <p className="text-xs text-[#6E6557] mt-1.5">{[e.supplier, e.note].filter(Boolean).join(' · ')}</p>}
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {e.items.map(it => (
                    <span key={it.id} className="text-[11px] bg-[#FAF7F0] border border-[#F1EBDF] rounded-md px-2 py-0.5 text-[#1F1A13]">
                      {it.product.name} <b className={it.qty < 0 ? 'text-red-600' : undefined}>{it.qty < 0 ? '−' : '+'}{fmtQty(Math.abs(it.qty))}</b> {it.product.unit}
                    </span>
                  ))}
                </div>
                {e.createdBy && <p className="text-[11px] text-[#9A8F7E] mt-1">{tr('سجلها')}: {e.createdBy}</p>}
              </div>
            ))}
          </div>
        )}
      </div>

      {showEntry && <WarehouseEntryModal onClose={() => setShowEntry(false)} />}
    </div>
  );
}

// نموذج تسجيل وارد (استلام/شراء) أو تسوية للمستودع
function WarehouseEntryModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const tr = useTr();
  const [type, setType] = useState<'RECEIVE' | 'ADJUST'>('RECEIVE');
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  const [rows, setRows] = useState<{ productId: string; name: string; unit: string; qty: string }[]>([]);

  const prodQ = useQuery({ queryKey: ['products-min'], queryFn: async () => (await productApi.list({ limit: 1000 })).data.data as { id: string; name: string; unit: string; code: string }[] });

  const addProduct = (id: string) => {
    if (!id || rows.some(r => r.productId === id)) return;
    const p = (prodQ.data || []).find(x => x.id === id);
    if (!p) return;
    setRows(rs => [...rs, { productId: id, name: p.name, unit: p.unit, qty: '1' }]);
  };
  const setQty = (id: string, v: string) => setRows(rs => rs.map(r => r.productId === id ? { ...r, qty: v } : r));
  const removeRow = (id: string) => setRows(rs => rs.filter(r => r.productId !== id));

  const save = useMutation({
    mutationFn: () => {
      const items = rows.map(r => ({ productId: r.productId, qty: Number(r.qty) })).filter(i => !Number.isNaN(i.qty) && i.qty !== 0);
      return warehouseApi.createEntry({ type, supplier: supplier.trim() || undefined, note: note.trim() || undefined, items });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['warehouse-stock'] });
      qc.invalidateQueries({ queryKey: ['warehouse-entries'] });
      toast.success(tr('تم حفظ الحركة'));
      onClose();
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر الحفظ')),
  });

  // الوارد يتطلّب كميات موجبة؛ التسوية تقبل ± (لكن لا صفر)
  const valid = rows.length > 0 && rows.every(r => {
    const q = Number(r.qty);
    return !Number.isNaN(q) && q !== 0 && (type === 'ADJUST' || q > 0);
  });

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <h2 className="text-lg font-bold text-[#1F1A13] flex items-center gap-2"><PackagePlus size={20} className="text-[#E15A30]" /> {tr('استلام بضاعة / تسوية المستودع')}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {/* نوع الحركة */}
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setType('RECEIVE')}
              className={`py-2.5 rounded-xl border text-sm font-semibold flex items-center justify-center gap-2 ${type === 'RECEIVE' ? 'border-[#1E7A52] bg-green-50 text-[#1E7A52]' : 'border-[#E9E1D3] text-[#6E6557]'}`}>
              <TrendingUp size={16} /> {tr('وارد استلام/شراء')}
            </button>
            <button type="button" onClick={() => setType('ADJUST')}
              className={`py-2.5 rounded-xl border text-sm font-semibold flex items-center justify-center gap-2 ${type === 'ADJUST' ? 'border-purple-500 bg-purple-50 text-purple-600' : 'border-[#E9E1D3] text-[#6E6557]'}`}>
              <TrendingDown size={16} /> {tr('تسوية +/−')}
            </button>
          </div>

          {type === 'RECEIVE' && (
            <div>
              <label className="label">{tr('المورد اختياري')}</label>
              <input className="input" value={supplier} onChange={e => setSupplier(e.target.value)} placeholder={tr('اسم المورد')} />
            </div>
          )}

          <div>
            <label className="label">{tr('إضافة صنف')}</label>
            <SearchableSelect
              options={(prodQ.data || []).filter(p => !rows.some(r => r.productId === p.id)).map(p => ({ value: p.id, label: p.name, hint: `${p.code} · ${p.unit}` }))}
              value="" onChange={addProduct} resetOnSelect placeholder={tr('ابحث وأضف صنفا')} searchPlaceholder={tr('اكتب اسم/كود الصنف')} />
          </div>

          {rows.length > 0 && (
            <div className="border border-[#E9E1D3] rounded-xl divide-y divide-[#F1EBDF]">
              {rows.map(r => (
                <div key={r.productId} className="flex items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-[#1F1A13] truncate">{r.name}</p>
                    <p className="text-[11px] text-[#9A8F7E]">{r.unit}</p>
                  </div>
                  <input type="number" step="any" inputMode="decimal" value={r.qty} onChange={e => setQty(r.productId, e.target.value)}
                    className="input w-24 py-1.5 text-center" placeholder={type === 'ADJUST' ? '±' : '0'} />
                  <button onClick={() => removeRow(r.productId)} className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg"><Trash2 size={15} /></button>
                </div>
              ))}
            </div>
          )}

          <div>
            <label className="label">{tr('ملاحظة اختياري')}</label>
            <input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder={tr('مثال فاتورة شراء رقم جرد')} />
          </div>
          {type === 'ADJUST' && <p className="text-[11px] text-[#9A8F7E]">{tr('التسوية تقبل موجبا زيادة أو سالبا نقص للجرد والتالف')}</p>}
        </div>

        <div className="flex gap-3 p-5 border-t border-[#E9E1D3]">
          <button onClick={() => save.mutate()} disabled={save.isPending || !valid}
            className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
            {save.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <PackagePlus size={16} />}
            {tr('حفظ الحركة')}
          </button>
          <button onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}
