import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { vanStockApi, productApi, salesRepApi } from '../api/client';
import { formatDate } from '../utils/format';
import SearchableSelect from '../components/SearchableSelect';
import { Truck, Package, TrendingDown, Plus, X, Trash2, ArrowDownToLine, Boxes, Calendar } from 'lucide-react';
import toast from 'react-hot-toast';

interface RepSummary {
  salesRepId: string; repName: string; isActive: boolean;
  productCount: number; totalRemaining: number; totalLoaded: number; totalSold: number; lastLoadAt: string | null;
}
interface StockRow {
  productId: string; name: string; code: string; unit: string;
  loaded: number; unloaded: number; adjusted: number; sold: number; returned: number; remaining: number;
}
interface Movement {
  kind: string; date: string; ref: string; by: string | null;
  items: { name: string; unit: string; qty: number }[];
}

const fmtQty = (n: number) => Number(n.toFixed(2)).toLocaleString('en-US');

// لوحة مخزون سيارات المناديب — ملخّص لكل مندوب + تفاصيل المخزون وحركته
export default function VanStockPage() {
  const [selected, setSelected] = useState<string>('');
  const [showLoad, setShowLoad] = useState(false);

  const summaryQ = useQuery({
    queryKey: ['van-summary'],
    queryFn: async () => (await vanStockApi.summary()).data.data as RepSummary[],
  });

  const currentQ = useQuery({
    queryKey: ['van-current', selected],
    queryFn: async () => (await vanStockApi.current(selected)).data.data as StockRow[],
    enabled: !!selected,
  });
  const movementsQ = useQuery({
    queryKey: ['van-movements', selected],
    queryFn: async () => (await vanStockApi.movements(selected)).data.data as Movement[],
    enabled: !!selected,
  });

  const reps = summaryQ.data || [];
  const selectedRep = reps.find(r => r.salesRepId === selected);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#1F1A13] flex items-center gap-2">
            <Truck size={26} className="text-[#E15A30]" /> مخزون سيارات المناديب
          </h1>
          <p className="text-[#6E6557] text-sm mt-1">متابعة ما حمَّله كل مندوب في سيارته، وما تبقّى بعد المبيعات لحظياً.</p>
        </div>
        <button onClick={() => setShowLoad(true)} className="btn-primary"><Plus size={17} /> تسجيل تحميل</button>
      </div>

      {/* ملخّص المناديب */}
      <div className="card overflow-hidden p-0">
        <div className="px-5 py-3.5 border-b border-[#F1EBDF] font-bold text-[#1F1A13] text-sm flex items-center gap-2">
          <Boxes size={17} className="text-[#E15A30]" /> ملخّص المخزون حسب المندوب
        </div>
        {summaryQ.isLoading ? (
          <div className="p-8 text-center text-gray-400 text-sm">جارٍ التحميل…</div>
        ) : reps.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">لا يوجد مناديب بعد.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[#6E6557] text-xs bg-[#FAF7F0]">
                  <th className="text-right font-semibold px-5 py-2.5">المندوب</th>
                  <th className="text-center font-semibold px-3 py-2.5">أصناف بالسيارة</th>
                  <th className="text-center font-semibold px-3 py-2.5">إجمالي محمَّل</th>
                  <th className="text-center font-semibold px-3 py-2.5">إجمالي مُباع</th>
                  <th className="text-center font-semibold px-3 py-2.5">المتبقّي</th>
                  <th className="text-center font-semibold px-3 py-2.5">آخر تحميل</th>
                </tr>
              </thead>
              <tbody>
                {reps.map(r => (
                  <tr key={r.salesRepId}
                    onClick={() => setSelected(r.salesRepId)}
                    className={`border-t border-[#F1EBDF] cursor-pointer transition-colors ${selected === r.salesRepId ? 'bg-[#FBEBE2]' : 'hover:bg-[#FAF7F0]'}`}>
                    <td className="px-5 py-3 font-semibold text-[#1F1A13]">{r.repName}{!r.isActive && <span className="text-[10px] text-red-500 mr-2">موقوف</span>}</td>
                    <td className="text-center px-3 py-3">{r.productCount}</td>
                    <td className="text-center px-3 py-3 text-[#6E6557]">{fmtQty(r.totalLoaded)}</td>
                    <td className="text-center px-3 py-3 text-[#6E6557]">{fmtQty(r.totalSold)}</td>
                    <td className={`text-center px-3 py-3 font-bold ${r.totalRemaining < 0 ? 'text-red-600' : 'text-[#1E7A52]'}`}>{fmtQty(r.totalRemaining)}</td>
                    <td className="text-center px-3 py-3 text-[#9A8F7E] text-xs">{r.lastLoadAt ? formatDate(r.lastLoadAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* تفاصيل المندوب المختار */}
      {selected && selectedRep && (
        <div className="grid lg:grid-cols-2 gap-6">
          {/* المخزون الحالي */}
          <div className="card p-0 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#F1EBDF] font-bold text-[#1F1A13] text-sm flex items-center gap-2">
              <Package size={17} className="text-[#E15A30]" /> مخزون «{selectedRep.repName}» الحالي
            </div>
            {currentQ.isLoading ? (
              <div className="p-8 text-center text-gray-400 text-sm">جارٍ التحميل…</div>
            ) : (currentQ.data || []).length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">لا توجد بضاعة محمّلة لهذا المندوب.</div>
            ) : (
              <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0">
                    <tr className="text-[#6E6557] text-xs bg-[#FAF7F0]">
                      <th className="text-right font-semibold px-5 py-2.5">الصنف</th>
                      <th className="text-center font-semibold px-2 py-2.5">محمَّل</th>
                      <th className="text-center font-semibold px-2 py-2.5">مُباع</th>
                      <th className="text-center font-semibold px-2 py-2.5">مرتجع</th>
                      <th className="text-center font-semibold px-3 py-2.5">المتبقّي</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(currentQ.data || []).map(row => (
                      <tr key={row.productId} className="border-t border-[#F1EBDF]">
                        <td className="px-5 py-2.5">
                          <p className="font-semibold text-[#1F1A13]">{row.name}</p>
                          <p className="text-[10px] text-[#9A8F7E]">{row.code} · {row.unit}</p>
                        </td>
                        <td className="text-center px-2 py-2.5 text-[#6E6557]">{fmtQty(row.loaded)}</td>
                        <td className="text-center px-2 py-2.5 text-[#C94E28]">{fmtQty(row.sold)}</td>
                        <td className="text-center px-2 py-2.5 text-[#6E6557]">{fmtQty(row.returned)}</td>
                        <td className={`text-center px-3 py-2.5 font-bold ${row.remaining < 0 ? 'text-red-600' : row.remaining === 0 ? 'text-[#9A8F7E]' : 'text-[#1E7A52]'}`}>{fmtQty(row.remaining)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* حركة المخزون (كم نزل ومتى) */}
          <div className="card p-0 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#F1EBDF] font-bold text-[#1F1A13] text-sm flex items-center gap-2">
              <TrendingDown size={17} className="text-[#E15A30]" /> حركة البضاعة — ماذا نزل ومتى
            </div>
            {movementsQ.isLoading ? (
              <div className="p-8 text-center text-gray-400 text-sm">جارٍ التحميل…</div>
            ) : (movementsQ.data || []).length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">لا توجد حركة بعد.</div>
            ) : (
              <div className="max-h-[420px] overflow-y-auto divide-y divide-[#F1EBDF]">
                {(movementsQ.data || []).map((m, i) => <MovementRow key={i} m={m} />)}
              </div>
            )}
          </div>
        </div>
      )}

      {showLoad && <LoadModal preselectRep={selected} onClose={() => setShowLoad(false)} />}
    </div>
  );
}

const KIND_META: Record<string, { label: string; color: string; sign: string }> = {
  LOAD: { label: 'تحميل', color: 'text-[#1E7A52] bg-green-50', sign: '+' },
  SALE: { label: 'بيع', color: 'text-[#C94E28] bg-[#FBEBE2]', sign: '−' },
  RETURN: { label: 'مرتجع', color: 'text-blue-600 bg-blue-50', sign: '+' },
  UNLOAD: { label: 'تنزيل للمستودع', color: 'text-amber-600 bg-amber-50', sign: '−' },
  ADJUST: { label: 'تسوية', color: 'text-purple-600 bg-purple-50', sign: '±' },
};

function MovementRow({ m }: { m: Movement }) {
  const meta = KIND_META[m.kind] || KIND_META.ADJUST;
  return (
    <div className="px-5 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-md ${meta.color}`}>{meta.label}</span>
        <span className="text-[11px] text-[#9A8F7E] flex items-center gap-1"><Calendar size={11} /> {formatDate(m.date)}</span>
      </div>
      {m.ref && <p className="text-xs text-[#6E6557] mt-1.5">{m.ref}</p>}
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        {m.items.map((it, j) => (
          <span key={j} className="text-[11px] bg-[#FAF7F0] border border-[#F1EBDF] rounded-md px-2 py-0.5 text-[#1F1A13]">
            {it.name} <b>{meta.sign}{fmtQty(Math.abs(it.qty))}</b> {it.unit}
          </span>
        ))}
      </div>
    </div>
  );
}

// نموذج تسجيل تحميل بضاعة لمندوب (للأدمن)
function LoadModal({ preselectRep, onClose }: { preselectRep: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [repId, setRepId] = useState(preselectRep);
  const [note, setNote] = useState('');
  const [rows, setRows] = useState<{ productId: string; name: string; unit: string; qty: string }[]>([]);

  const repsQ = useQuery({ queryKey: ['reps-min'], queryFn: async () => (await salesRepApi.list({ limit: 1000 })).data.data as { id: string; name: string }[] });
  const prodQ = useQuery({ queryKey: ['products-min'], queryFn: async () => (await productApi.list({ limit: 1000 })).data.data as { id: string; name: string; unit: string; code: string }[] });

  const addProduct = (id: string, opt?: { label: string }) => {
    if (!id || rows.some(r => r.productId === id)) return;
    const p = (prodQ.data || []).find(x => x.id === id);
    if (!p) return;
    setRows(rs => [...rs, { productId: id, name: opt?.label || p.name, unit: p.unit, qty: '1' }]);
  };

  const save = useMutation({
    mutationFn: () => vanStockApi.createLoad({
      salesRepId: repId, type: 'LOAD', note: note.trim() || undefined,
      items: rows.map(r => ({ productId: r.productId, qty: Number(r.qty) })).filter(i => i.qty > 0),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['van-summary'] });
      qc.invalidateQueries({ queryKey: ['van-current'] });
      qc.invalidateQueries({ queryKey: ['van-movements'] });
      toast.success('تم تسجيل التحميل');
      onClose();
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'تعذّر الحفظ'),
  });

  const valid = repId && rows.length > 0 && rows.every(r => Number(r.qty) > 0);

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <h2 className="text-lg font-bold text-[#1F1A13] flex items-center gap-2"><ArrowDownToLine size={20} className="text-[#E15A30]" /> تسجيل تحميل بضاعة</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <label className="label">المندوب</label>
            <SearchableSelect
              options={(repsQ.data || []).map(r => ({ value: r.id, label: r.name }))}
              value={repId} onChange={(v) => setRepId(v)} placeholder="اختر المندوب…" />
          </div>
          <div>
            <label className="label">إضافة صنف</label>
            <SearchableSelect
              options={(prodQ.data || []).filter(p => !rows.some(r => r.productId === p.id)).map(p => ({ value: p.id, label: p.name, hint: `${p.code} · ${p.unit}` }))}
              value="" onChange={addProduct} resetOnSelect placeholder="ابحث وأضف صنفاً…" searchPlaceholder="اكتب اسم/كود الصنف…" />
          </div>

          {rows.length > 0 && (
            <div className="border border-[#F1EBDF] rounded-xl divide-y divide-[#F1EBDF]">
              {rows.map((r, i) => (
                <div key={r.productId} className="flex items-center gap-2 p-2.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-[#1F1A13] truncate">{r.name}</p>
                    <p className="text-[10px] text-[#9A8F7E]">{r.unit}</p>
                  </div>
                  <input type="number" min="0" step="any" value={r.qty}
                    onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))}
                    className="input w-24 text-center py-1.5" />
                  <button onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600 p-1"><Trash2 size={16} /></button>
                </div>
              ))}
            </div>
          )}

          <div>
            <label className="label">ملاحظة (اختياري)</label>
            <input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="مثال: تحميل صباح اليوم من المستودع" />
          </div>
        </div>

        <div className="flex gap-3 p-5 border-t border-[#E9E1D3]">
          <button onClick={() => save.mutate()} disabled={!valid || save.isPending} className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
            {save.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <ArrowDownToLine size={16} />}
            حفظ التحميل
          </button>
          <button onClick={onClose} className="btn-secondary">إلغاء</button>
        </div>
      </div>
    </div>
  );
}
