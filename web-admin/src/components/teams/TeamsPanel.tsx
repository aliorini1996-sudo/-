import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Users, Plus, Pencil, Archive, ArchiveRestore, Trash2, X, Search } from 'lucide-react';
import { teamsApi, salesRepApi, productApi } from '../../api/client';
import { useTr } from '../../i18n/strings';

/**
 * تبويب «الفرق» في إعدادات الشركة (طلب المالك ١٧ أكتوبر ٢٠٢٦) — مطفأة افتراضياً ويفعّلها مدير الشركة هنا.
 * الفريق: اسمٌ ومناديب (المندوب قد يكون في أكثر من فريق) وأصنافٌ خاصة (الصنف غير المسند لأي فريق عامٌّ للجميع).
 * المندوب يختار في تطبيقه الفريق الذي يعمل له، فتُحسب له فواتيره ومرتجعاته وسنداته وزياراته.
 */
interface TeamRow {
  id: string; name: string; isActive: boolean;
  members: { salesRepId: string; name: string; isActive: boolean }[];
  productIds: string[];
  docsCount: number;
}
type Err = { response?: { data?: { message?: string } } };
const errMsg = (e: unknown, fallback: string) => (e as Err)?.response?.data?.message || fallback;

export default function TeamsPanel() {
  const tr = useTr();
  const qc = useQueryClient();
  const settingsQ = useQuery({ queryKey: ['teams-settings'], queryFn: async () => (await teamsApi.settings()).data.data as { enabled: boolean } });
  const enabled = settingsQ.data?.enabled === true;
  const teamsQ = useQuery({ queryKey: ['teams'], queryFn: async () => (await teamsApi.list()).data.data as TeamRow[], enabled });
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<TeamRow | null>(null);

  const toggle = useMutation({
    mutationFn: (v: boolean) => teamsApi.setEnabled(v),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['teams-settings'] });
      toast.success(v ? tr('فعلت الفرق للشركة') : tr('أطفئت الفرق وبقيت بياناتها محفوظة'));
    },
    onError: (e) => toast.error(errMsg(e, tr('تعذر الحفظ'))),
  });
  const create = useMutation({
    mutationFn: (name: string) => teamsApi.create(name),
    onSuccess: () => { setNewName(''); qc.invalidateQueries({ queryKey: ['teams'] }); toast.success(tr('أضيف الفريق')); },
    onError: (e) => toast.error(errMsg(e, tr('تعذر الحفظ'))),
  });
  const update = useMutation({
    mutationFn: (v: { id: string; isActive: boolean }) => teamsApi.update(v.id, { isActive: v.isActive }),
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ['teams'] }); toast.success(v.isActive ? tr('استعيد الفريق') : tr('أرشف الفريق')); },
    onError: (e) => toast.error(errMsg(e, tr('تعذر الحفظ'))),
  });
  const remove = useMutation({
    mutationFn: (id: string) => teamsApi.remove(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['teams'] }); toast.success(tr('تم حذف الفريق')); },
    onError: (e) => toast.error(errMsg(e, tr('تعذر الحذف'))),
  });

  return (
    <div className="space-y-5">
      {/* التفعيل */}
      <div className="card">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <h2 className="font-bold text-[#1F1A13] flex items-center gap-2"><Users size={18} className="text-[#E15A30]" /> {tr('فرق العمل')}</h2>
            <p className="text-sm text-[#6E6557] mt-1 leading-relaxed">
              {tr('للشركة التي لها أكثر من نشاط أو فريق مناديب: يختار المندوب في تطبيقه الفريق الذي يعمل له فتحسب له فواتيره وسنداته وزياراته ولا يرى إلا أصناف فريقه والأصناف العامة')}
            </p>
          </div>
          <button type="button" onClick={() => toggle.mutate(!enabled)} disabled={settingsQ.isLoading || toggle.isPending}
            role="switch" aria-checked={enabled}
            className={`shrink-0 text-sm font-bold rounded-full px-4 py-1.5 border transition-colors disabled:opacity-50 ${enabled ? 'bg-green-50 text-[#1E7A52] border-green-200 hover:bg-green-100' : 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100'}`}>
            {enabled ? tr('مفعلة') : tr('مطفأة')}
          </button>
        </div>
        {!enabled && !settingsQ.isLoading && (
          <p className="text-xs text-[#9A8F7E] mt-3">{tr('الميزة مطفأة فلا يتغير شيء في شركتك وعند إطفائها لاحقا تبقى الفرق ووسوم المستندات محفوظة')}</p>
        )}
      </div>

      {enabled && (
        <div className="card space-y-4">
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (newName.trim()) create.mutate(newName.trim()); }}>
            <input className="input flex-1" placeholder={tr('اسم الفريق مثل فريق المكسرات')} value={newName} maxLength={60} onChange={(e) => setNewName(e.target.value)} />
            <button type="submit" className="btn-primary shrink-0" disabled={!newName.trim() || create.isPending}><Plus size={16} /> {tr('إضافة فريق')}</button>
          </form>

          {teamsQ.isLoading ? (
            <p className="text-center text-gray-400 text-sm py-6">{tr('جار التحميل')}</p>
          ) : (teamsQ.data ?? []).length === 0 ? (
            <p className="text-center text-gray-400 text-sm py-6">{tr('لا توجد فرق بعد')}</p>
          ) : (
            <div className="divide-y divide-[#F1EBDF] border border-[#F1EBDF] rounded-xl">
              {(teamsQ.data ?? []).map((t) => (
                <div key={t.id} className={`p-3.5 flex items-center gap-3 flex-wrap ${t.isActive ? '' : 'opacity-60'}`}>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-[#1F1A13]">
                      {t.name}
                      {!t.isActive && <span className="ms-2 text-[10px] text-amber-700 bg-amber-50 rounded-full px-2 py-0.5">{tr('مؤرشف')}</span>}
                    </p>
                    <p className="text-xs text-[#6E6557] mt-0.5">
                      {t.members.length} {tr('مندوب')} · {t.productIds.length ? `${t.productIds.length} ${tr('صنف خاص')}` : tr('الأصناف العامة فقط')}
                      {t.members.length > 0 && <span className="text-[#9A8F7E]"> — {t.members.map((m) => m.name).join('، ')}</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button type="button" onClick={() => setEditing(t)} className="btn-secondary !py-1.5 !px-3 text-xs"><Pencil size={13} /> {tr('تعديل')}</button>
                    <button type="button" onClick={() => update.mutate({ id: t.id, isActive: !t.isActive })} disabled={update.isPending}
                      className="p-2 rounded-lg text-[#6E6557] hover:bg-[#FAF7F0]" title={t.isActive ? tr('أرشفة') : tr('استعادة')}>
                      {t.isActive ? <Archive size={15} /> : <ArchiveRestore size={15} />}
                    </button>
                    {t.docsCount === 0 && (
                      <button type="button" disabled={remove.isPending} title={tr('حذف')}
                        onClick={() => { if (window.confirm(`${tr('حذف الفريق')} «${t.name}»؟`)) remove.mutate(t.id); }}
                        className="p-2 rounded-lg text-red-500 hover:bg-red-50"><Trash2 size={15} /></button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-[#9A8F7E]">{tr('الفريق الذي عليه مستندات لا يحذف بل يؤرشف ليبقى في التقارير والمستندات القديمة تبقى بلا فريق')}</p>
        </div>
      )}

      {editing && <TeamModal team={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** تعديل الفريق: الاسم، ومناديبه، وأصنافه الخاصة — قائمتان بالبحث والتحديد، والحفظ تفاضليّ في الخادم */
function TeamModal({ team, onClose }: { team: TeamRow; onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'reps' | 'products'>('reps');
  const [name, setName] = useState(team.name);
  const [reps, setReps] = useState<Set<string>>(() => new Set(team.members.map((m) => m.salesRepId)));
  const [prods, setProds] = useState<Set<string>>(() => new Set(team.productIds));
  const [q, setQ] = useState('');
  const repsQ = useQuery({ queryKey: ['reps-min'], queryFn: async () => (await salesRepApi.list({ limit: 1000 })).data.data as { id: string; name: string; isActive?: boolean }[] });
  const prodQ = useQuery({ queryKey: ['products-min'], queryFn: async () => (await productApi.list({ limit: 1000 })).data.data as { id: string; name: string; code: string; unit: string }[] });

  const needle = q.trim().toLowerCase();
  const shownReps = useMemo(() => (repsQ.data ?? []).filter((r) => !needle || r.name.toLowerCase().includes(needle)), [repsQ.data, needle]);
  const shownProds = useMemo(() => (prodQ.data ?? []).filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.code.toLowerCase().includes(needle)), [prodQ.data, needle]);

  const save = useMutation({
    mutationFn: async () => {
      if (name.trim() && name.trim() !== team.name) await teamsApi.update(team.id, { name: name.trim() });
      await teamsApi.setMembers(team.id, [...reps]);
      await teamsApi.setProducts(team.id, [...prods]);
    },
    onSuccess: () => { toast.success(tr('حفظ الفريق')); onClose(); },
    onError: (e) => toast.error(errMsg(e, tr('تعذر الحفظ'))),
    // ثلاثة طلبات متتالية: فشل أحدها بعد نجاح ما قبله لا يترك القائمة على القديم
    onSettled: () => qc.invalidateQueries({ queryKey: ['teams'] }),
  });

  const toggleIn = (set: Set<string>, id: string) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); return n; };
  const list = tab === 'reps' ? shownReps : shownProds;
  const picked = tab === 'reps' ? reps : prods;
  const setPicked = tab === 'reps' ? setReps : setProds;

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <h2 className="text-lg font-bold text-[#1F1A13] flex items-center gap-2"><Users size={20} className="text-[#E15A30]" /> {tr('تعديل الفريق')}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <label className="label">{tr('اسم الفريق')}</label>
            <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(['reps', 'products'] as const).map((k) => (
              <button key={k} type="button" onClick={() => { setTab(k); setQ(''); }}
                className={`py-2 rounded-lg text-sm font-semibold border ${tab === k ? 'bg-[#E15A30] text-white border-[#E15A30]' : 'bg-white text-[#6E6557] border-[#E9E1D3] hover:bg-[#FAF7F0]'}`}>
                {k === 'reps' ? `${tr('المناديب')} (${reps.size})` : `${tr('الأصناف الخاصة')} (${prods.size})`}
              </button>
            ))}
          </div>
          <p className="text-xs text-[#9A8F7E]">
            {tab === 'reps'
              ? tr('المندوب قد يكون في أكثر من فريق ويختار في تطبيقه الفريق الذي يعمل له')
              : tr('الصنف غير المسند لأي فريق عام لكل الفرق والصنف المسند لا يبيعه إلا من يعمل لأحد فرقه')}
          </p>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search size={14} className="absolute top-1/2 -translate-y-1/2 start-3 text-gray-400" />
              <input className="input !ps-8" placeholder={tr('بحث')} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <button type="button" className="text-xs font-semibold text-[#E15A30]"
              onClick={() => setPicked((s) => { const n = new Set(s); list.forEach((x) => n.add(x.id)); return n; })}>{tr('تحديد الظاهر')}</button>
            <button type="button" className="text-xs font-semibold text-gray-500"
              onClick={() => setPicked((s) => { const n = new Set(s); list.forEach((x) => n.delete(x.id)); return n; })}>{tr('إلغاء الظاهر')}</button>
          </div>
          <div className="border border-[#E9E1D3] rounded-xl divide-y divide-[#F1EBDF] max-h-72 overflow-y-auto">
            {(tab === 'reps' ? repsQ.isLoading : prodQ.isLoading) ? (
              <p className="text-center text-gray-400 text-sm py-6">{tr('جار التحميل')}</p>
            ) : list.length === 0 ? (
              <p className="text-center text-gray-400 text-sm py-6">{tr('لا توجد نتائج')}</p>
            ) : list.map((x) => (
              <label key={x.id} className="flex items-center gap-2.5 px-3.5 py-2 text-sm cursor-pointer hover:bg-[#FAF7F0]">
                <input type="checkbox" checked={picked.has(x.id)} onChange={() => setPicked((s) => toggleIn(s, x.id))} className="w-4 h-4 accent-[#E15A30]" />
                <span className="flex-1 truncate text-[#1F1A13]">{x.name}</span>
                {'code' in x && <span className="text-[10px] text-[#9A8F7E]">{(x as { code: string }).code}</span>}
              </label>
            ))}
          </div>
        </div>
        <div className="p-4 border-t border-[#E9E1D3] flex gap-2 justify-end">
          <button type="button" className="btn-secondary" onClick={onClose}>{tr('إلغاء')}</button>
          <button type="button" className="btn-primary" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? tr('جار الحفظ') : tr('حفظ')}
          </button>
        </div>
      </div>
    </div>
  );
}
