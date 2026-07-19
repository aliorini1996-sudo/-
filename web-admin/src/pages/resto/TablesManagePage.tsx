import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, X, Check, LayoutGrid, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import { restaurantApi } from '../../api/client';
import ConfirmDialog from '../../components/ConfirmDialog';
import type { RestaurantArea, RestaurantTable } from '../../types';

export default function TablesManagePage() {
  const qc = useQueryClient();
  const [selArea, setSelArea] = useState<string>('all');
  const [areaModal, setAreaModal] = useState<RestaurantArea | 'new' | null>(null);
  const [tableModal, setTableModal] = useState<RestaurantTable | 'new' | null>(null);
  const [del, setDel] = useState<{ kind: 'area' | 'table'; id: string; name: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['resto-tables'],
    queryFn: async () => (await restaurantApi.tables()).data.data as { areas: RestaurantArea[]; tables: RestaurantTable[] },
  });
  const areas = data?.areas ?? [];
  const tables = data?.tables ?? [];
  const shown = selArea === 'all' ? tables : selArea === 'none' ? tables.filter(t => !t.areaId) : tables.filter(t => t.areaId === selArea);
  const areaName = (id?: string | null) => areas.find(a => a.id === id)?.name ?? '—';

  const invalidate = () => qc.invalidateQueries({ queryKey: ['resto-tables'] });
  const delMut = useMutation({
    mutationFn: async () => { if (!del) return; del.kind === 'area' ? await restaurantApi.deleteArea(del.id) : await restaurantApi.deleteTable(del.id); },
    onSuccess: () => { invalidate(); toast.success('تم الحذف'); setDel(null); },
    onError: () => toast.error('تعذّر الحذف'),
  });

  return (
    <div className="max-w-6xl">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-2xl font-bold text-[#1F1A13]">الصالات والطاولات</h1>
        <div className="flex items-center gap-2">
          <button onClick={() => setAreaModal('new')} className="btn-secondary"><Plus size={16} /> صالة</button>
          <button onClick={() => setTableModal('new')} className="btn-primary"><Plus size={16} /> طاولة</button>
        </div>
      </div>

      {/* شرائح الصالات */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        <Chip active={selArea === 'all'} onClick={() => setSelArea('all')}>كل الطاولات ({tables.length})</Chip>
        {areas.map(a => (
          <div key={a.id} className="group relative">
            <Chip active={selArea === a.id} onClick={() => setSelArea(a.id)}>
              {a.name} ({tables.filter(t => t.areaId === a.id).length})
            </Chip>
            <div className="absolute -top-2 -left-2 hidden group-hover:flex bg-white border border-[#E9E1D3] rounded-lg shadow">
              <button onClick={() => setAreaModal(a)} className="p-1 text-gray-500 hover:text-[#E15A30]"><Pencil size={12} /></button>
              <button onClick={() => setDel({ kind: 'area', id: a.id, name: a.name })} className="p-1 text-gray-500 hover:text-red-500"><Trash2 size={12} /></button>
            </div>
          </div>
        ))}
        {tables.some(t => !t.areaId) && <Chip active={selArea === 'none'} onClick={() => setSelArea('none')}>بلا صالة</Chip>}
      </div>

      {isLoading ? <div className="card text-center py-16 text-gray-400">جاري التحميل…</div>
        : shown.length === 0 ? (
          <div className="card text-center py-16">
            <LayoutGrid size={30} className="text-[#9A8F7E] mx-auto mb-2" />
            <p className="text-gray-500">لا طاولات — أضف أول طاولة</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {shown.map(t => (
              <div key={t.id} className="card p-4 text-center relative group">
                <div className="absolute top-2 left-2 hidden group-hover:flex gap-0.5">
                  <button onClick={() => setTableModal(t)} className="p-1 text-gray-400 hover:text-[#E15A30] bg-white rounded"><Pencil size={13} /></button>
                  <button onClick={() => setDel({ kind: 'table', id: t.id, name: `طاولة ${t.number}` })} className="p-1 text-gray-400 hover:text-red-500 bg-white rounded"><Trash2 size={13} /></button>
                </div>
                <div className="w-12 h-12 rounded-2xl bg-[#FBEBE2] flex items-center justify-center mx-auto mb-2">
                  <span className="font-bold text-[#C94E28]">{t.number}</span>
                </div>
                <p className="text-xs text-[#6E6557] flex items-center justify-center gap-1"><Users size={12} /> {t.seats ?? 4} مقاعد</p>
                <p className="text-[11px] text-[#9A8F7E] mt-0.5">{areaName(t.areaId)}</p>
              </div>
            ))}
          </div>
        )}

      {areaModal && <AreaModal area={areaModal === 'new' ? null : areaModal} onClose={() => setAreaModal(null)} onSaved={() => { setAreaModal(null); invalidate(); }} />}
      {tableModal && <TableModal table={tableModal === 'new' ? null : tableModal} areas={areas} defaultArea={selArea !== 'all' && selArea !== 'none' ? selArea : ''} onClose={() => setTableModal(null)} onSaved={() => { setTableModal(null); invalidate(); }} />}
      {del && <ConfirmDialog danger title="تأكيد الحذف" message={`حذف «${del.name}» نهائياً؟`} loading={delMut.isPending} onConfirm={() => delMut.mutate()} onClose={() => setDel(null)} />}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`text-sm rounded-xl px-3.5 py-1.5 border font-semibold ${active ? 'bg-[#E15A30] text-white border-[#E15A30]' : 'bg-white text-[#6E6557] border-[#E9E1D3]'}`}>
      {children}
    </button>
  );
}

function AreaModal({ area, onClose, onSaved }: { area: RestaurantArea | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(area?.name ?? '');
  const mut = useMutation({
    mutationFn: () => area ? restaurantApi.updateArea(area.id, { name }) : restaurantApi.createArea({ name }),
    onSuccess: () => { toast.success(area ? 'تم التحديث' : 'تمت الإضافة'); onSaved(); },
    onError: () => toast.error('حدث خطأ'),
  });
  return (
    <ModalShell title={area ? 'تعديل الصالة' : 'صالة جديدة'} onClose={onClose}>
      <div className="p-5"><label className="label">اسم الصالة *</label>
        <input className="input" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="مثال: الصالة الرئيسية / الجناح العائلي" /></div>
      <Footer loading={mut.isPending} disabled={!name.trim()} onSave={() => mut.mutate()} onClose={onClose} />
    </ModalShell>
  );
}

function TableModal({ table, areas, defaultArea, onClose, onSaved }: {
  table: RestaurantTable | null; areas: RestaurantArea[]; defaultArea: string; onClose: () => void; onSaved: () => void;
}) {
  const [number, setNumber] = useState(table?.number ?? '');
  const [seats, setSeats] = useState(table?.seats != null ? String(table.seats) : '4');
  const [areaId, setAreaId] = useState(table?.areaId ?? defaultArea ?? '');
  const mut = useMutation({
    mutationFn: () => {
      const payload = { number: number.trim(), seats: Number(seats) || 4, areaId: areaId || null };
      return table ? restaurantApi.updateTable(table.id, payload) : restaurantApi.createTable(payload);
    },
    onSuccess: () => { toast.success(table ? 'تم التحديث' : 'تمت الإضافة'); onSaved(); },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'حدث خطأ'),
  });
  const submit = () => { if (!number.trim()) { toast.error('رقم الطاولة مطلوب'); return; } mut.mutate(); };
  return (
    <ModalShell title={table ? 'تعديل الطاولة' : 'طاولة جديدة'} onClose={onClose}>
      <div className="p-5 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">رقم/اسم الطاولة *</label>
            <input className="input" autoFocus value={number} onChange={e => setNumber(e.target.value)} placeholder="7 أو A1" /></div>
          <div><label className="label">عدد المقاعد</label>
            <input type="number" min={1} className="input" value={seats} onChange={e => setSeats(e.target.value)} /></div>
        </div>
        <div><label className="label">الصالة</label>
          <select className="input" value={areaId} onChange={e => setAreaId(e.target.value)}>
            <option value="">بلا صالة</option>
            {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select></div>
      </div>
      <Footer loading={mut.isPending} onSave={submit} onClose={onClose} />
    </ModalShell>
  );
}

function ModalShell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-[#E9E1D3]">
          <h2 className="font-bold text-[#1F1A13] flex items-center gap-2"><LayoutGrid size={18} className="text-[#E15A30]" /> {title}</h2>
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
