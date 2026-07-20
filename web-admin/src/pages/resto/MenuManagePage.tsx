import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, X, Check, ScrollText, Boxes, UtensilsCrossed } from 'lucide-react';
import toast from 'react-hot-toast';
import { restaurantApi } from '../../api/client';
import ConfirmDialog from '../../components/ConfirmDialog';
import type { MenuCategory, MenuItem, ModifierGroup, Modifier } from '../../types';

const STATIONS: { v: string; label: string }[] = [
  { v: 'KITCHEN', label: 'المطبخ' }, { v: 'GRILL', label: 'الشواء' },
  { v: 'BAR', label: 'البار' }, { v: 'COLD', label: 'البارد/المقبّلات' },
];
const stationLabel = (v?: string) => STATIONS.find(s => s.v === v)?.label ?? 'المطبخ';

export default function MenuManagePage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'items' | 'groups'>('items');
  const [selCat, setSelCat] = useState<string>('all');
  const [catModal, setCatModal] = useState<MenuCategory | 'new' | null>(null);
  const [itemModal, setItemModal] = useState<MenuItem | 'new' | null>(null);
  const [groupModal, setGroupModal] = useState<ModifierGroup | 'new' | null>(null);
  const [del, setDel] = useState<{ kind: 'category' | 'item' | 'group'; id: string; name: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['resto-menu'],
    queryFn: async () => (await restaurantApi.menu()).data.data as { categories: MenuCategory[]; items: MenuItem[]; groups: ModifierGroup[] },
  });
  const categories = data?.categories ?? [];
  const groups = data?.groups ?? [];
  const allItems = data?.items ?? [];
  const items = selCat === 'all' ? allItems
    : selCat === 'none' ? allItems.filter(it => !it.categoryId)
    : allItems.filter(it => it.categoryId === selCat);
  const uncategorized = allItems.filter(it => !it.categoryId).length;

  const invalidate = () => qc.invalidateQueries({ queryKey: ['resto-menu'] });
  const delMut = useMutation({
    mutationFn: async () => {
      if (!del) return;
      if (del.kind === 'category') await restaurantApi.deleteCategory(del.id);
      else if (del.kind === 'item') await restaurantApi.deleteItem(del.id);
      else await restaurantApi.deleteGroup(del.id);
    },
    onSuccess: () => { invalidate(); toast.success('تم الحذف'); setDel(null); },
    onError: () => toast.error('تعذّر الحذف'),
  });

  return (
    <div className="max-w-6xl">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-2xl font-bold text-[#1F1A13]">القائمة</h1>
        <div className="flex bg-white border border-[#E9E1D3] rounded-xl p-1">
          <button onClick={() => setTab('items')} className={`px-4 py-1.5 rounded-lg text-sm font-semibold ${tab === 'items' ? 'bg-[#E15A30] text-white' : 'text-[#6E6557]'}`}>الأصناف</button>
          <button onClick={() => setTab('groups')} className={`px-4 py-1.5 rounded-lg text-sm font-semibold ${tab === 'groups' ? 'bg-[#E15A30] text-white' : 'text-[#6E6557]'}`}>مجموعات الإضافات</button>
        </div>
      </div>

      {tab === 'items' ? (
        <div className="grid lg:grid-cols-[240px_1fr] gap-5">
          {/* الأقسام */}
          <aside className="card p-3 h-fit">
            <div className="flex items-center justify-between mb-2 px-1">
              <span className="text-sm font-bold text-[#1F1A13]">الأقسام</span>
              <button onClick={() => setCatModal('new')} className="text-[#E15A30] hover:bg-[#FBEBE2] rounded-lg p-1" title="قسم جديد"><Plus size={17} /></button>
            </div>
            <button onClick={() => setSelCat('all')} className={`w-full text-right px-3 py-2 rounded-lg text-sm mb-1 ${selCat === 'all' ? 'bg-[#FBEBE2] text-[#C94E28] font-semibold' : 'hover:bg-gray-50 text-[#3a342b]'}`}>
              كل الأصناف <span className="text-xs text-[#9A8F7E]">({allItems.length})</span>
            </button>
            {categories.map(c => (
              <div key={c.id} className={`group flex items-center gap-1 rounded-lg mb-0.5 ${selCat === c.id ? 'bg-[#FBEBE2]' : 'hover:bg-gray-50'}`}>
                <button onClick={() => setSelCat(c.id)} className={`flex-1 text-right px-3 py-2 text-sm ${selCat === c.id ? 'text-[#C94E28] font-semibold' : 'text-[#3a342b]'}`}>
                  {c.name} <span className="text-xs text-[#9A8F7E]">({allItems.filter(it => it.categoryId === c.id).length})</span>
                </button>
                <button onClick={() => setCatModal(c)} className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-[#E15A30]"><Pencil size={13} /></button>
                <button onClick={() => setDel({ kind: 'category', id: c.id, name: c.name })} className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 ml-1"><Trash2 size={13} /></button>
              </div>
            ))}
            {uncategorized > 0 && (
              <button onClick={() => setSelCat('none')} className={`w-full text-right px-3 py-2 rounded-lg text-sm mt-0.5 ${selCat === 'none' ? 'bg-[#FBEBE2] text-[#C94E28] font-semibold' : 'hover:bg-gray-50 text-[#3a342b]'}`}>
                بلا قسم <span className="text-xs text-[#9A8F7E]">({uncategorized})</span>
              </button>
            )}
            {categories.length === 0 && uncategorized === 0 && <p className="text-xs text-gray-400 px-3 py-2">لا أقسام بعد</p>}
          </aside>

          {/* الأصناف */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-[#6E6557]">{items.length} صنف</span>
              <button onClick={() => setItemModal('new')} className="btn-primary"><Plus size={16} /> صنف جديد</button>
            </div>
            {isLoading ? <div className="card text-center py-16 text-gray-400">جاري التحميل…</div>
              : items.length === 0 ? (
                <div className="card text-center py-16">
                  <UtensilsCrossed size={30} className="text-[#9A8F7E] mx-auto mb-2" />
                  <p className="text-gray-500">لا أصناف — أضف أول صنف</p>
                </div>
              ) : (
                <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
                  {items.map(it => (
                    <div key={it.id} className="card p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-bold text-[#1F1A13] truncate">{it.name}</p>
                          <p className="text-xs text-[#9A8F7E] mt-0.5">{stationLabel(it.prepStation)}{it.modifierGroups?.length ? ` · ${it.modifierGroups.length} مجموعة إضافات` : ''}</p>
                        </div>
                        {!it.isAvailable && <span className="text-[10px] bg-gray-100 text-gray-500 rounded-full px-2 py-0.5 shrink-0">غير متاح</span>}
                      </div>
                      <div className="flex items-center justify-between mt-3">
                        <span className="font-bold text-[#E15A30]">{it.basePrice} <span className="text-xs font-normal">ر.س</span></span>
                        <div className="flex items-center gap-1">
                          <button onClick={() => setItemModal(it)} className="p-1.5 rounded text-[#C94E28] hover:bg-[#FBEBE2]"><Pencil size={15} /></button>
                          <button onClick={() => setDel({ kind: 'item', id: it.id, name: it.name })} className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50"><Trash2 size={15} /></button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
          </div>
        </div>
      ) : (
        /* مجموعات الإضافات */
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-[#6E6557]">{groups.length} مجموعة</span>
            <button onClick={() => setGroupModal('new')} className="btn-primary"><Plus size={16} /> مجموعة جديدة</button>
          </div>
          {groups.length === 0 ? (
            <div className="card text-center py-16">
              <Boxes size={30} className="text-[#9A8F7E] mx-auto mb-2" />
              <p className="text-gray-500">لا مجموعات إضافات — أنشئ مجموعة (مثل: الحجم، الإضافات)</p>
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-3">
              {groups.map(g => (
                <div key={g.id} className="card p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="font-bold text-[#1F1A13]">{g.name}</p>
                      <p className="text-xs text-[#9A8F7E] mt-0.5">
                        {g.minSelect ? 'إلزامي' : 'اختياري'} · {(g.maxSelect ?? 1) > 1 ? `اختيار حتى ${g.maxSelect}` : 'اختيار واحد'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button onClick={() => setGroupModal(g)} className="p-1.5 rounded text-[#C94E28] hover:bg-[#FBEBE2]"><Pencil size={15} /></button>
                      <button onClick={() => setDel({ kind: 'group', id: g.id, name: g.name })} className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50"><Trash2 size={15} /></button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {(g.modifiers ?? []).map(m => (
                      <span key={m.id} className="text-xs bg-[#FAF7F0] border border-[#E9E1D3] rounded-full px-2.5 py-1 text-[#3a342b]">
                        {m.name}{m.priceDelta ? <span className="text-[#E15A30]"> +{m.priceDelta}</span> : ''}
                      </span>
                    ))}
                    {(g.modifiers ?? []).length === 0 && <span className="text-xs text-gray-400">لا خيارات</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {catModal && <CategoryModal cat={catModal === 'new' ? null : catModal} onClose={() => setCatModal(null)} onSaved={() => { setCatModal(null); invalidate(); }} />}
      {itemModal && <ItemModal item={itemModal === 'new' ? null : itemModal} categories={categories} groups={groups} defaultCat={selCat === 'all' ? '' : selCat} onClose={() => setItemModal(null)} onSaved={() => { setItemModal(null); invalidate(); }} />}
      {groupModal && <GroupModal group={groupModal === 'new' ? null : groupModal} onClose={() => setGroupModal(null)} onSaved={() => { setGroupModal(null); invalidate(); }} />}
      {del && (
        <ConfirmDialog danger title="تأكيد الحذف" message={`حذف «${del.name}» نهائياً؟`} loading={delMut.isPending}
          onConfirm={() => delMut.mutate()} onClose={() => setDel(null)} />
      )}
    </div>
  );
}

// ---------------- نافذة القسم ----------------
function CategoryModal({ cat, onClose, onSaved }: { cat: MenuCategory | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(cat?.name ?? '');
  const mut = useMutation({
    mutationFn: () => cat ? restaurantApi.updateCategory(cat.id, { name }) : restaurantApi.createCategory({ name }),
    onSuccess: () => { toast.success(cat ? 'تم التحديث' : 'تمت الإضافة'); onSaved(); },
    onError: () => toast.error('حدث خطأ'),
  });
  return (
    <Modal title={cat ? 'تعديل القسم' : 'قسم جديد'} onClose={onClose}>
      <div className="p-5 space-y-3">
        <div><label className="label">اسم القسم *</label>
          <input className="input" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="مثال: مشاوي" /></div>
      </div>
      <ModalFooter loading={mut.isPending} disabled={!name.trim()} onSave={() => mut.mutate()} onClose={onClose} />
    </Modal>
  );
}

// ---------------- نافذة الصنف ----------------
function ItemModal({ item, categories, groups, defaultCat, onClose, onSaved }: {
  item: MenuItem | null; categories: MenuCategory[]; groups: ModifierGroup[]; defaultCat: string;
  onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState({
    name: item?.name ?? '', basePrice: item ? String(item.basePrice) : '', taxPct: item?.taxPct != null ? String(item.taxPct) : '15',
    costPrice: item?.costPrice != null ? String(item.costPrice) : '', prepStation: item?.prepStation ?? 'KITCHEN',
    categoryId: item?.categoryId ?? defaultCat ?? '', isAvailable: item?.isAvailable ?? true,
  });
  const [groupIds, setGroupIds] = useState<string[]>(item?.modifierGroups?.map(g => g.groupId) ?? []);
  const set = (k: string, v: unknown) => setF(s => ({ ...s, [k]: v }));

  const mut = useMutation({
    mutationFn: () => {
      const payload = {
        name: f.name.trim(), basePrice: Number(f.basePrice), taxPct: Number(f.taxPct) || 0,
        costPrice: f.costPrice ? Number(f.costPrice) : 0, prepStation: f.prepStation,
        categoryId: f.categoryId || null, isAvailable: f.isAvailable, groupIds,
      };
      return item ? restaurantApi.updateItem(item.id, payload) : restaurantApi.createItem(payload);
    },
    onSuccess: () => { toast.success(item ? 'تم التحديث' : 'تمت الإضافة'); onSaved(); },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'حدث خطأ'),
  });
  const submit = () => {
    if (!f.name.trim()) { toast.error('اسم الصنف مطلوب'); return; }
    if (!f.basePrice || Number(f.basePrice) < 0) { toast.error('حدّد سعراً صحيحاً'); return; }
    mut.mutate();
  };

  return (
    <Modal title={item ? 'تعديل الصنف' : 'صنف جديد'} onClose={onClose} wide>
      <div className="p-5 space-y-3.5 max-h-[70vh] overflow-y-auto">
        <div><label className="label">اسم الصنف *</label>
          <input className="input" autoFocus value={f.name} onChange={e => set('name', e.target.value)} placeholder="مثال: برجر لحم" /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">السعر (ر.س) *</label>
            <input type="number" min={0} step="0.01" className="input" value={f.basePrice} onChange={e => set('basePrice', e.target.value)} /></div>
          <div><label className="label">الضريبة %</label>
            <input type="number" min={0} max={100} className="input" value={f.taxPct} onChange={e => set('taxPct', e.target.value)} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">التكلفة (اختياري)</label>
            <input type="number" min={0} step="0.01" className="input" value={f.costPrice} onChange={e => set('costPrice', e.target.value)} placeholder="لحساب الأرباح لاحقاً" /></div>
          <div><label className="label">محطة التحضير</label>
            <select className="input" value={f.prepStation} onChange={e => set('prepStation', e.target.value)}>
              {STATIONS.map(s => <option key={s.v} value={s.v}>{s.label}</option>)}
            </select></div>
        </div>
        <div><label className="label">القسم</label>
          <select className="input" value={f.categoryId} onChange={e => set('categoryId', e.target.value)}>
            <option value="">بلا قسم</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></div>
        {groups.length > 0 && (
          <div>
            <label className="label">مجموعات الإضافات</label>
            <div className="flex flex-wrap gap-2">
              {groups.map(g => {
                const on = groupIds.includes(g.id);
                return (
                  <button type="button" key={g.id}
                    onClick={() => setGroupIds(ids => on ? ids.filter(x => x !== g.id) : [...ids, g.id])}
                    className={`text-sm rounded-lg px-3 py-1.5 border ${on ? 'bg-[#FBEBE2] border-[#E15A30] text-[#C94E28] font-semibold' : 'border-[#E9E1D3] text-[#6E6557]'}`}>
                    {on && <Check size={13} className="inline ml-1" />}{g.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <label className="flex items-center gap-2.5 text-sm text-gray-700 cursor-pointer select-none bg-[#FAF7F0] border border-[#E9E1D3] rounded-lg px-3 py-2.5">
          <input type="checkbox" className="w-4 h-4 accent-[#E15A30]" checked={f.isAvailable} onChange={e => set('isAvailable', e.target.checked)} />
          متاح للبيع الآن
        </label>
      </div>
      <ModalFooter loading={mut.isPending} onSave={submit} onClose={onClose} />
    </Modal>
  );
}

// ---------------- نافذة مجموعة الإضافات ----------------
function GroupModal({ group, onClose, onSaved }: { group: ModifierGroup | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(group?.name ?? '');
  const [required, setRequired] = useState((group?.minSelect ?? 0) > 0);
  const [multi, setMulti] = useState((group?.maxSelect ?? 1) > 1);
  const [mods, setMods] = useState<{ name: string; priceDelta: string }[]>(
    group?.modifiers?.length ? group.modifiers.map((m: Modifier) => ({ name: m.name, priceDelta: m.priceDelta ? String(m.priceDelta) : '' })) : [{ name: '', priceDelta: '' }]
  );

  const mut = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(), minSelect: required ? 1 : 0, maxSelect: multi ? 99 : 1,
        modifiers: mods.filter(m => m.name.trim()).map(m => ({ name: m.name.trim(), priceDelta: m.priceDelta ? Number(m.priceDelta) : 0 })),
      };
      return group ? restaurantApi.updateGroup(group.id, payload) : restaurantApi.createGroup(payload);
    },
    onSuccess: () => { toast.success(group ? 'تم التحديث' : 'تمت الإضافة'); onSaved(); },
    onError: () => toast.error('حدث خطأ'),
  });
  const submit = () => {
    if (!name.trim()) { toast.error('اسم المجموعة مطلوب'); return; }
    if (!mods.some(m => m.name.trim())) { toast.error('أضف خياراً واحداً على الأقل'); return; }
    mut.mutate();
  };

  return (
    <Modal title={group ? 'تعديل مجموعة الإضافات' : 'مجموعة إضافات جديدة'} onClose={onClose} wide>
      <div className="p-5 space-y-3.5 max-h-[70vh] overflow-y-auto">
        <div><label className="label">اسم المجموعة *</label>
          <input className="input" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="مثال: الحجم / الإضافات" /></div>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
            <input type="checkbox" className="w-4 h-4 accent-[#E15A30]" checked={required} onChange={e => setRequired(e.target.checked)} /> إلزامي
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
            <input type="checkbox" className="w-4 h-4 accent-[#E15A30]" checked={multi} onChange={e => setMulti(e.target.checked)} /> يسمح باختيارات متعددة
          </label>
        </div>
        <div>
          <label className="label">الخيارات</label>
          <div className="space-y-2">
            {mods.map((m, i) => (
              <div key={i} className="flex items-center gap-2">
                <input className="input flex-1" placeholder="اسم الخيار (مثل: كبير)" value={m.name}
                  onChange={e => setMods(a => a.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                <input type="number" step="0.01" className="input" style={{ width: 110 }} placeholder="فرق السعر" value={m.priceDelta}
                  onChange={e => setMods(a => a.map((x, j) => j === i ? { ...x, priceDelta: e.target.value } : x))} />
                <button type="button" onClick={() => setMods(a => a.filter((_, j) => j !== i))} className="p-2 text-gray-400 hover:text-red-500"><X size={16} /></button>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setMods(a => [...a, { name: '', priceDelta: '' }])} className="text-sm text-[#E15A30] font-semibold mt-2 flex items-center gap-1">
            <Plus size={15} /> إضافة خيار
          </button>
        </div>
      </div>
      <ModalFooter loading={mut.isPending} onSave={submit} onClose={onClose} />
    </Modal>
  );
}

// ---------------- عناصر مشتركة ----------------
function Modal({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className={`bg-white rounded-2xl shadow-2xl w-full ${wide ? 'max-w-lg' : 'max-w-sm'}`} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-[#E9E1D3]">
          <h2 className="font-bold text-[#1F1A13] flex items-center gap-2"><ScrollText size={18} className="text-[#E15A30]" /> {title}</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ModalFooter({ loading, disabled, onSave, onClose }: { loading?: boolean; disabled?: boolean; onSave: () => void; onClose: () => void }) {
  return (
    <div className="flex gap-3 p-4 border-t border-[#E9E1D3]">
      <button onClick={onSave} disabled={loading || disabled} className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
        {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Check size={16} />} حفظ
      </button>
      <button onClick={onClose} className="btn-secondary">إلغاء</button>
    </div>
  );
}
