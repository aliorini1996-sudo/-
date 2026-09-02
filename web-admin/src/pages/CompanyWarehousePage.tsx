import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { warehouseApi, productApi } from '../api/client';
import { formatDate, formatCurrency } from '../utils/format';
import { useTr } from '../i18n/strings';
import SearchableSelect from '../components/SearchableSelect';
import { Warehouse, PackagePlus, X, Trash2, TrendingUp, TrendingDown, AlertTriangle, Calendar, ArrowRightLeft, Wallet, Info } from 'lucide-react';
import toast from 'react-hot-toast';

interface WhRow {
  productId: string; name: string; code: string; unit: string;
  received: number; adjusted: number; loadedToVans: number; returnedFromVans: number; onHand: number;
  avgCost: number;     // متوسّط تكلفة الوحدة (متحرّك، على الرصيد الباقي)
  costedQty: number;   // كمية من الرصيد تكلفتها معروفة — هي وحدها المقيَّمة
  stockValue: number;  // قيمة الرصيد بتكلفة الشراء
  uncostedQty: number; // كمية واردة بلا سعر — حدّ صدق التقييم
}
interface WhEntry {
  id: string; type: string; note: string | null; supplier: string | null; createdBy: string | null; createdAt: string;
  items: { id: string; qty: number; unitCost: number | null; product: { name: string; unit: string } }[];
  totalCost: number; // يحسبه الخادم بالدالّة المختبَرة — لا يُعاد حسابه هنا
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
  // قيمة المخزون بتكلفة الشراء — ومعها حدّ صدقها: كم صنفا وارده بلا سعر
  const totalValue = rows.reduce((s, r) => s + r.stockValue, 0);
  const uncostedRows = rows.filter(r => r.uncostedQty > 0).length;

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-[#1F1A13] flex items-center gap-2"><Warehouse size={22} className="text-[#E15A30]" /> {tr('مخزون الشركة')}</h1>
          <p className="text-xs text-[#9A8F7E] mt-1">{tr('المستودع المركزي التحميل يخرج منه والتنزيل يعود إليه والوارد يزيده')}</p>
        </div>
        <button onClick={() => setShowEntry(true)} className="btn-primary"><PackagePlus size={17} /> {tr('استلام / تسوية')}</button>
      </div>

      {/* قيمة المخزون بتكلفة الشراء — الغرض من تسجيل سعر الوحدة عند الاستلام */}
      {rows.length > 0 && (
        <div className="card px-5 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-xl bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center"><Wallet size={20} /></span>
            <div>
              <p className="text-xs text-[#9A8F7E]">{tr('قيمة المخزون بتكلفة الشراء')}</p>
              <p className="text-xl font-extrabold text-[#1F1A13]">{formatCurrency(totalValue)}</p>
            </div>
          </div>
          {uncostedRows > 0 && (
            <p className="text-[11px] text-[#9A8F7E] flex items-center gap-1.5 max-w-sm">
              <Info size={13} className="shrink-0 text-amber-600" />
              {uncostedRows} {tr('صنفا فيه كمية بلا تكلفة معروفة وهي خارج هذه القيمة سجل سعر الوحدة عند الاستلام ليكتمل التقييم')}
            </p>
          )}
        </div>
      )}

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
                  <th className="text-center font-semibold px-3 py-2.5">{tr('متوسط تكلفة الوحدة')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('قيمة الرصيد')}</th>
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
                    <td className="px-3 py-2.5 text-center text-[#6E6557]">
                      {r.avgCost > 0
                        ? <span title={String(r.avgCost)}>{formatCurrency(r.avgCost, undefined, 4)}</span>
                        : <span className="text-[#C9BFAE]">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {r.costedQty !== 0
                        ? <span className={`font-bold ${r.stockValue < 0 ? 'text-red-600' : 'text-[#1F1A13]'}`}>{formatCurrency(r.stockValue)}</span>
                        : <span className="text-[#C9BFAE]">—</span>}
                      {r.uncostedQty > 0 && (
                        <span className="block text-[10px] text-amber-600 mt-0.5">
                          {fmtQty(r.uncostedQty)} {tr('خارج التقييم')}
                        </span>
                      )}
                    </td>
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
                      {it.unitCost != null && it.unitCost > 0 && (
                        <span className="text-[#6E6557]"> · {formatCurrency(it.unitCost)}/{it.product.unit}</span>
                      )}
                    </span>
                  ))}
                </div>
                {e.totalCost > 0 && (
                  <p className="text-[11px] text-[#6E6557] mt-1.5">
                    {tr('قيمة البضاعة قبل الضريبة')}: <b className="text-[#1F1A13]">{formatCurrency(e.totalCost)}</b>
                  </p>
                )}
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
  const [rows, setRows] = useState<{ productId: string; name: string; unit: string; qty: string; unitCost: string }[]>([]);
  // فاتورة المورّد تعلن السعر شاملاً الضريبة غالباً؛ المؤشّر يخبر الخادم فيردّه
  // إلى صافيه قبل الحفظ — فيبقى العمود بمعنى واحد مهما اختلفت عادة المورّدين
  const [costsIncludeTax, setCostsIncludeTax] = useState(false);

  // taxPct لازمة لاستخراج الضريبة من السعر الشامل في معاينة الإجمالي — والخادم
  // يعيد الاستخراج بنفسه عند الحفظ، فلا تُصدَّق نسبةٌ آتية من المتصفّح
  const prodQ = useQuery({ queryKey: ['products-min'], queryFn: async () => (await productApi.list({ limit: 1000 })).data.data as { id: string; name: string; unit: string; code: string; taxPct: number }[] });

  const addProduct = (id: string) => {
    if (!id || rows.some(r => r.productId === id)) return;
    const p = (prodQ.data || []).find(x => x.id === id);
    if (!p) return;
    setRows(rs => [...rs, { productId: id, name: p.name, unit: p.unit, qty: '1', unitCost: '' }]);
  };
  const setQty = (id: string, v: string) => setRows(rs => rs.map(r => r.productId === id ? { ...r, qty: v } : r));
  const setCost = (id: string, v: string) => setRows(rs => rs.map(r => r.productId === id ? { ...r, unitCost: v } : r));
  const removeRow = (id: string) => setRows(rs => rs.filter(r => r.productId !== id));

  const save = useMutation({
    mutationFn: () => {
      const items = rows.map(r => {
        const cost = Number(r.unitCost);
        return {
          productId: r.productId,
          qty: Number(r.qty),
          // السعر للوارد وحده؛ والفارغ أو الصفر يُرسَل غائباً لا صفراً —
          // «بلا سعر» يُستبعَد من التقييم، بينما صفرٌ يُحسَب بضاعةً مجّانية
          unitCost: type === 'RECEIVE' && r.unitCost.trim() !== '' && !Number.isNaN(cost) && cost > 0 ? cost : undefined,
        };
      }).filter(i => !Number.isNaN(i.qty) && i.qty !== 0);
      return warehouseApi.createEntry({
        type, supplier: supplier.trim() || undefined, note: note.trim() || undefined,
        costsIncludeTax: type === 'RECEIVE' ? costsIncludeTax : undefined,
        items,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['warehouse-stock'] });
      qc.invalidateQueries({ queryKey: ['warehouse-entries'] });
      toast.success(tr('تم حفظ الحركة'));
      onClose();
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر الحفظ')),
  });

  /**
   * قيمة البضاعة المستلمة — **صافيةً قبل الضريبة دائماً**، ليطابق الرقم المعروض
   * ما سيُخزَّن فعلاً. فلو عُرض شاملاً حين يؤشّر المستخدم «شاملة الضريبة» لرأى
   * رقماً في الشاشة وقرأ غيره في التقرير، وهو أسوأ من ألّا يُعرض شيء.
   * والضريبة تُستخرَج بنسبة كلّ صنف لا بنسبة موحّدة.
   */
  const entryTotal = type !== 'RECEIVE' ? 0 : rows.reduce((sum, r) => {
    const q = Number(r.qty), c = Number(r.unitCost);
    if (Number.isNaN(q) || Number.isNaN(c) || c <= 0) return sum;
    const pct = (prodQ.data || []).find(p => p.id === r.productId)?.taxPct ?? 0;
    const net = costsIncludeTax && pct > 0 ? c / (1 + pct / 100) : c;
    return sum + q * net;
  }, 0);

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
            <div className="border border-[#E9E1D3] rounded-xl overflow-hidden">
              {/* رؤوس الأعمدة: بلا تسمية يصير الحقلان رقمين متجاورين لا يُعرَف أيّهما */}
              <div className="flex items-center gap-2 px-3 py-1.5 bg-[#FAF7F0] text-[10px] font-semibold text-[#9A8F7E]">
                <span className="min-w-0 flex-1">{tr('الصنف')}</span>
                <span className="w-20 text-center">{tr('الكمية')}</span>
                {type === 'RECEIVE' && <span className="w-24 text-center">{tr('سعر الوحدة')}</span>}
                <span className="w-7" />
              </div>
              <div className="divide-y divide-[#F1EBDF]">
                {rows.map(r => {
                  const q = Number(r.qty), c = Number(r.unitCost);
                  // صافيةً دائماً كالإجمالي تحتها وكالمخزَّن — عرضُ السطر شاملاً
                  // مع إجماليٍّ صافٍ يجعل الأسطر لا تجمع إجمالها أمام العين
                  const pct = (prodQ.data || []).find(p => p.id === r.productId)?.taxPct ?? 0;
                  const net = costsIncludeTax && pct > 0 ? c / (1 + pct / 100) : c;
                  const line = type === 'RECEIVE' && !Number.isNaN(q) && !Number.isNaN(c) && c > 0 ? q * net : null;
                  return (
                    <div key={r.productId} className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-[#1F1A13] truncate">{r.name}</p>
                          <p className="text-[11px] text-[#9A8F7E]">{r.unit}</p>
                        </div>
                        <input type="number" step="any" inputMode="decimal" value={r.qty} onChange={e => setQty(r.productId, e.target.value)}
                          className="input w-20 py-1.5 text-center" placeholder={type === 'ADJUST' ? '±' : '0'} />
                        {type === 'RECEIVE' && (
                          <input type="number" step="any" min="0" inputMode="decimal" value={r.unitCost} onChange={e => setCost(r.productId, e.target.value)}
                            className="input w-24 py-1.5 text-center" placeholder={tr('اختياري')} />
                        )}
                        <button onClick={() => removeRow(r.productId)} className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg"><Trash2 size={15} /></button>
                      </div>
                      {line !== null && (
                        <p className="text-[11px] text-[#6E6557] mt-1">{tr('قيمة السطر قبل الضريبة')}: <b className="text-[#1F1A13]">{formatCurrency(line)}</b></p>
                      )}
                    </div>
                  );
                })}
              </div>

              {type === 'RECEIVE' && (
                <div className="px-3 py-2 bg-[#FAF7F0] border-t border-[#F1EBDF] space-y-2">
                  <label className="flex items-center gap-2 text-[11px] text-[#6E6557] cursor-pointer">
                    <input type="checkbox" checked={costsIncludeTax} onChange={e => setCostsIncludeTax(e.target.checked)} className="accent-[#E15A30]" />
                    {tr('الأسعار المدخلة شاملة الضريبة')}
                  </label>
                  {entryTotal > 0 && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-[#6E6557]">{tr('قيمة البضاعة المستلمة قبل الضريبة')}</span>
                      <b className="text-[#1F1A13]">{formatCurrency(entryTotal)}</b>
                    </div>
                  )}
                </div>
              )}
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
