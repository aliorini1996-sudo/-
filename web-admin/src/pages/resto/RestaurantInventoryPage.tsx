import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, X, Check, Boxes, AlertTriangle, ArrowDownUp } from 'lucide-react';
import toast from 'react-hot-toast';
import { restaurantApi } from '../../api/client';
import ConfirmDialog from '../../components/ConfirmDialog';

const money = (n: number) => `${(Math.round(n * 100) / 100).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ر.س`;
const num = (n: number) => (Math.round(n * 1000) / 1000).toLocaleString('ar-EG');
const UNITS = [{ v: 'kg', l: 'كجم' }, { v: 'g', l: 'جم' }, { v: 'l', l: 'لتر' }, { v: 'ml', l: 'مل' }, { v: 'pcs', l: 'حبة' }];
const unitLabel = (u: string) => UNITS.find(x => x.v === u)?.l ?? u;

export interface Ingredient {
  id: string; name: string; unit: string; stockQty: number; minQty: number;
  avgCost: number; isActive: boolean; lowStock: boolean; stockValue: number;
}

export default function RestaurantInventoryPage() {
  const qc = useQueryClient();
  const [edit, setEdit] = useState<Ingredient | 'new' | null>(null);
  const [move, setMove] = useState<Ingredient | null>(null);
  const [del, setDel] = useState<Ingredient | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['resto-inventory'],
    queryFn: async () => (await restaurantApi.inventory()).data.data as Ingredient[],
  });
  const list = data ?? [];
  const totalValue = list.reduce((s, i) => s + i.stockValue, 0);
  const lowCount = list.filter(i => i.lowStock).length;
  const invalidate = () => qc.invalidateQueries({ queryKey: ['resto-inventory'] });

  const delMut = useMutation({
    mutationFn: () => restaurantApi.deleteIngredient(del!.id),
    onSuccess: () => { invalidate(); toast.success('تم الحذف'); setDel(null); },
    onError: () => toast.error('تعذّر الحذف'),
  });

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-2xl font-bold text-[#1F1A13]">المخزون</h1>
        <button onClick={() => setEdit('new')} className="btn-primary"><Plus size={16} /> مكوّن جديد</button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-5">
        <div className="bg-white rounded-2xl p-4 flex items-center gap-3 border border-gray-100">
          <div className="w-11 h-11 rounded-xl bg-[#E15A30] flex items-center justify-center"><Boxes size={22} className="text-white" /></div>
          <div><p className="text-lg font-bold text-[#1F1A13]">{list.length}</p><p className="text-xs text-[#6E6557]">عدد المكوّنات</p></div>
        </div>
        <div className="bg-white rounded-2xl p-4 flex items-center gap-3 border border-gray-100">
          <div className="w-11 h-11 rounded-xl bg-[#1E7A52] flex items-center justify-center"><ArrowDownUp size={22} className="text-white" /></div>
          <div><p className="text-lg font-bold text-[#1F1A13]">{money(totalValue)}</p><p className="text-xs text-[#6E6557]">قيمة المخزون</p></div>
        </div>
        <div className="bg-white rounded-2xl p-4 flex items-center gap-3 border border-gray-100">
          <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${lowCount ? 'bg-red-500' : 'bg-gray-300'}`}><AlertTriangle size={22} className="text-white" /></div>
          <div><p className="text-lg font-bold text-[#1F1A13]">{lowCount}</p><p className="text-xs text-[#6E6557]">تحت حدّ التنبيه</p></div>
        </div>
      </div>

      {isLoading ? <div className="card text-center py-16 text-gray-400">جاري التحميل…</div>
        : list.length === 0 ? (
          <div className="card text-center py-16">
            <Boxes size={30} className="text-[#9A8F7E] mx-auto mb-2" />
            <p className="text-gray-500">لا مكوّنات — أضف أول مكوّن لتتبّع المخزون والتكلفة</p>
          </div>
        ) : (
          <div className="card p-0 overflow-hidden">
            <div className="table-wrapper">
              <table className="table">
                <thead><tr>
                  <th>المكوّن</th><th className="text-center">الرصيد</th><th className="text-center">حدّ التنبيه</th>
                  <th className="text-center">متوسّط التكلفة</th><th className="text-center">القيمة</th><th>إجراءات</th>
                </tr></thead>
                <tbody>
                  {list.map(i => (
                    <tr key={i.id} className={i.lowStock ? 'bg-red-50/60' : ''}>
                      <td>
                        <p className="font-semibold text-gray-800">{i.name}</p>
                        <p className="text-xs text-gray-400">{unitLabel(i.unit)}</p>
                      </td>
                      <td className="text-center">
                        <span className={`font-bold ${i.lowStock ? 'text-red-600' : 'text-gray-700'}`}>{num(i.stockQty)}</span>
                        {i.lowStock && <AlertTriangle size={13} className="inline mr-1 text-red-500" />}
                      </td>
                      <td className="text-center text-gray-500">{num(i.minQty)}</td>
                      <td className="text-center text-gray-600">{money(i.avgCost)}</td>
                      <td className="text-center font-semibold text-gray-700">{money(i.stockValue)}</td>
                      <td>
                        <div className="flex items-center gap-1">
                          <button onClick={() => setMove(i)} className="text-xs bg-[#1E7A52] hover:bg-[#186845] text-white rounded-lg px-2.5 py-1.5 font-semibold">حركة</button>
                          <button onClick={() => setEdit(i)} className="p-1.5 rounded text-[#C94E28] hover:bg-[#FBEBE2]"><Pencil size={15} /></button>
                          <button onClick={() => setDel(i)} className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50"><Trash2 size={15} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

      {edit && <IngredientModal ing={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); invalidate(); }} />}
      {move && <MovementModal ing={move} onClose={() => setMove(null)} onSaved={() => { setMove(null); invalidate(); }} />}
      {del && <ConfirmDialog danger title="حذف المكوّن" message={`حذف «${del.name}» وكل حركاته وأسطر وصفاته؟`} loading={delMut.isPending} onConfirm={() => delMut.mutate()} onClose={() => setDel(null)} />}
    </div>
  );
}

function IngredientModal({ ing, onClose, onSaved }: { ing: Ingredient | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: ing?.name ?? '', unit: ing?.unit ?? 'kg', minQty: ing ? String(ing.minQty) : '0',
    openingQty: '', openingCost: '',
  });
  const set = (k: string, v: string) => setF(s => ({ ...s, [k]: v }));
  const mut = useMutation({
    mutationFn: () => {
      const base = { name: f.name.trim(), unit: f.unit, minQty: Number(f.minQty) || 0 };
      return ing ? restaurantApi.updateIngredient(ing.id, base)
        : restaurantApi.createIngredient({ ...base, openingQty: Number(f.openingQty) || 0, openingCost: Number(f.openingCost) || 0 });
    },
    onSuccess: () => { toast.success(ing ? 'تم التحديث' : 'تمت الإضافة'); onSaved(); },
    onError: () => toast.error('حدث خطأ'),
  });
  return (
    <Shell title={ing ? 'تعديل المكوّن' : 'مكوّن جديد'} onClose={onClose}>
      <div className="p-5 space-y-3">
        <div><label className="label">اسم المكوّن *</label>
          <input className="input" autoFocus value={f.name} onChange={e => set('name', e.target.value)} placeholder="مثال: لحم بقري" /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">الوحدة</label>
            <select className="input" value={f.unit} onChange={e => set('unit', e.target.value)}>
              {UNITS.map(u => <option key={u.v} value={u.v}>{u.l}</option>)}
            </select></div>
          <div><label className="label">حدّ التنبيه</label>
            <input type="number" min={0} step="0.001" className="input" value={f.minQty} onChange={e => set('minQty', e.target.value)} /></div>
        </div>
        {!ing && (
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">رصيد افتتاحي</label>
              <input type="number" min={0} step="0.001" className="input" value={f.openingQty} onChange={e => set('openingQty', e.target.value)} placeholder="0" /></div>
            <div><label className="label">تكلفة الوحدة</label>
              <input type="number" min={0} step="0.01" className="input" value={f.openingCost} onChange={e => set('openingCost', e.target.value)} placeholder="0.00" /></div>
          </div>
        )}
      </div>
      <Footer loading={mut.isPending} disabled={!f.name.trim()} onSave={() => mut.mutate()} onClose={onClose} />
    </Shell>
  );
}

function MovementModal({ ing, onClose, onSaved }: { ing: Ingredient; onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState<'PURCHASE' | 'ADJUST' | 'WASTE'>('PURCHASE');
  const [qty, setQty] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [reason, setReason] = useState('');
  const mut = useMutation({
    mutationFn: () => restaurantApi.stockMovement(ing.id, {
      type, qty: Number(qty) || 0,
      ...(type === 'PURCHASE' && unitCost ? { unitCost: Number(unitCost) } : {}),
      reason: reason.trim() || null,
    }),
    onSuccess: () => { toast.success('سُجّلت الحركة'); onSaved(); },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'تعذّر تسجيل الحركة'),
  });
  const submit = () => {
    const q = Number(qty);
    if (!qty || (type !== 'ADJUST' && q <= 0)) { toast.error('أدخل كمية صحيحة'); return; }
    if (type === 'PURCHASE' && !(Number(unitCost) > 0)) { toast.error('أدخل تكلفة الوحدة للشراء (تحدّث متوسّط التكلفة)'); return; }
    mut.mutate();
  };
  const tab = (v: typeof type, label: string) => (
    <button onClick={() => setType(v)} className={`flex-1 py-2 rounded-lg text-sm font-semibold border ${type === v ? 'bg-[#FBEBE2] border-[#E15A30] text-[#C94E28]' : 'bg-white border-[#E9E1D3] text-[#6E6557]'}`}>{label}</button>
  );
  return (
    <Shell title={`حركة مخزون — ${ing.name}`} onClose={onClose}>
      <div className="p-5 space-y-3">
        <div className="flex gap-2">{tab('PURCHASE', 'شراء')}{tab('ADJUST', 'تسوية')}{tab('WASTE', 'هدر')}</div>
        <div className="text-xs text-[#9A8F7E]">الرصيد الحالي: <span className="font-bold text-[#1F1A13]">{num(ing.stockQty)} {unitLabel(ing.unit)}</span></div>
        <div>
          <label className="label">{type === 'ADJUST' ? 'الكمية (موجب/سالب)' : 'الكمية'}</label>
          <input type="number" step="0.001" className="input" autoFocus value={qty} onChange={e => setQty(e.target.value)} placeholder={type === 'ADJUST' ? 'مثال: -2' : '0'} />
        </div>
        {type === 'PURCHASE' && (
          <div><label className="label">تكلفة الوحدة * (تحدّث المتوسّط)</label>
            <input type="number" min={0} step="0.01" className="input" value={unitCost} onChange={e => setUnitCost(e.target.value)} placeholder={String(ing.avgCost)} /></div>
        )}
        <div><label className="label">السبب (اختياري)</label>
          <input className="input" value={reason} onChange={e => setReason(e.target.value)} placeholder={type === 'WASTE' ? 'تلف/انتهاء صلاحية' : ''} /></div>
      </div>
      <Footer loading={mut.isPending} onSave={submit} onClose={onClose} />
    </Shell>
  );
}

function Shell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-[#E9E1D3]">
          <h2 className="font-bold text-[#1F1A13] flex items-center gap-2"><Boxes size={18} className="text-[#E15A30]" /> {title}</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Footer({ loading, disabled, onSave, onClose }: { loading?: boolean; disabled?: boolean; onSave: () => void; onClose: () => void }) {
  return (
    <div className="flex gap-3 p-4 border-t border-[#E9E1D3]">
      <button onClick={onSave} disabled={loading || disabled} className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
        {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Check size={16} />} حفظ
      </button>
      <button onClick={onClose} className="btn-secondary">إلغاء</button>
    </div>
  );
}
