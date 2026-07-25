import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, X, Check, Users, KeyRound, Power, Monitor, UtensilsCrossed } from 'lucide-react';
import toast from 'react-hot-toast';
import { restaurantApi } from '../../api/client';
import ConfirmDialog from '../../components/ConfirmDialog';

interface Staff { id: string; name: string; username: string; isActive: boolean; canCreateReceipt: boolean; createdAt: string }

export default function RestaurantStaffPage() {
  const qc = useQueryClient();
  const [edit, setEdit] = useState<Staff | 'new' | null>(null);
  const [pinFor, setPinFor] = useState<Staff | null>(null);
  const [del, setDel] = useState<Staff | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['resto-staff'],
    queryFn: async () => (await restaurantApi.staff()).data.data as Staff[],
  });
  const list = data ?? [];
  const invalidate = () => qc.invalidateQueries({ queryKey: ['resto-staff'] });

  const toggleMut = useMutation({
    mutationFn: (s: Staff) => restaurantApi.updateStaff(s.id, { isActive: !s.isActive }),
    onSuccess: () => { invalidate(); toast.success('تم التحديث'); },
    onError: () => toast.error('حدث خطأ'),
  });
  const delMut = useMutation({
    mutationFn: () => restaurantApi.deleteStaff(del!.id),
    onSuccess: () => { invalidate(); toast.success('تم الحذف'); setDel(null); },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'تعذّر الحذف'),
  });

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-bold text-[#1F1A13]">الموظّفون</h1>
        <button onClick={() => setEdit('new')} className="btn-primary"><Plus size={16} /> موظّف جديد</button>
      </div>
      <p className="text-[#6E6557] text-sm mb-6">أنشئ حسابات الكاشير والنُدُل بـPIN — يدخلون على شاشة الكاشير فقط من <span className="font-mono" dir="ltr">/pos-login</span></p>

      {isLoading ? <div className="card text-center py-16 text-gray-400">جاري التحميل…</div>
        : list.length === 0 ? (
          <div className="card text-center py-16">
            <Users size={30} className="text-[#9A8F7E] mx-auto mb-2" />
            <p className="text-gray-500">لا موظّفين — أضف أول كاشير</p>
          </div>
        ) : (
          <div className="card p-0 overflow-hidden">
            <div className="table-wrapper">
              <table className="table">
                <thead><tr><th>الاسم</th><th>اسم الدخول</th><th className="text-center">الدور</th><th className="text-center">الحالة</th><th>إجراءات</th></tr></thead>
                <tbody>
                  {list.map(s => (
                    <tr key={s.id}>
                      <td className="font-semibold text-gray-800">{s.name}</td>
                      <td className="text-sm text-gray-500 font-mono" dir="ltr">{s.username}</td>
                      <td className="text-center">
                        <span className={`inline-flex items-center gap-1 text-xs rounded-full px-2.5 py-1 ${s.canCreateReceipt ? 'bg-[#FBEBE2] text-[#C94E28]' : 'bg-gray-100 text-gray-500'}`}>
                          {s.canCreateReceipt ? <><Monitor size={11} /> كاشير</> : <><UtensilsCrossed size={11} /> نادل</>}
                        </span>
                      </td>
                      <td className="text-center">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${s.isActive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{s.isActive ? 'نشط' : 'موقوف'}</span>
                      </td>
                      <td>
                        <div className="flex items-center gap-1">
                          <button onClick={() => setPinFor(s)} className="text-xs bg-amber-500 hover:bg-amber-600 text-white rounded-lg px-2.5 py-1.5 font-semibold flex items-center gap-1"><KeyRound size={12} /> الرمز</button>
                          <button onClick={() => setEdit(s)} className="p-1.5 rounded text-[#C94E28] hover:bg-[#FBEBE2]"><Pencil size={15} /></button>
                          <button onClick={() => toggleMut.mutate(s)} className={`p-1.5 rounded ${s.isActive ? 'text-red-500 hover:bg-red-50' : 'text-green-600 hover:bg-green-50'}`}><Power size={15} /></button>
                          <button onClick={() => setDel(s)} className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50"><Trash2 size={15} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

      {edit && <StaffModal staff={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); invalidate(); }} />}
      {pinFor && <PinModal staff={pinFor} onClose={() => setPinFor(null)} />}
      {del && <ConfirmDialog danger title="حذف الموظّف" message={`حذف «${del.name}»؟`} loading={delMut.isPending} onConfirm={() => delMut.mutate()} onClose={() => setDel(null)} />}
    </div>
  );
}

function StaffModal({ staff, onClose, onSaved }: { staff: Staff | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: staff?.name ?? '', username: staff?.username ?? '', pin: '', canPay: staff ? staff.canCreateReceipt : true });
  const set = (k: string, v: unknown) => setF(s => ({ ...s, [k]: v }));
  const mut = useMutation({
    mutationFn: () => staff
      ? restaurantApi.updateStaff(staff.id, { name: f.name.trim(), canPay: f.canPay })
      : restaurantApi.createStaff({ name: f.name.trim(), username: f.username.trim(), pin: f.pin, canPay: f.canPay }),
    onSuccess: () => { toast.success(staff ? 'تم التحديث' : 'أُضيف الموظّف'); onSaved(); },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'حدث خطأ'),
  });
  const submit = () => {
    if (!f.name.trim()) { toast.error('الاسم مطلوب'); return; }
    if (!staff) {
      if (!/^[a-zA-Z0-9._-]{3,}$/.test(f.username.trim())) { toast.error('اسم الدخول: 3 أحرف إنجليزية/أرقام على الأقل'); return; }
      if (!/^\d{4,6}$/.test(f.pin)) { toast.error('الرمز 4 إلى 6 أرقام'); return; }
    }
    mut.mutate();
  };
  return (
    <Shell title={staff ? 'تعديل الموظّف' : 'موظّف جديد'} onClose={onClose}>
      <div className="p-5 space-y-3">
        <div><label className="label">الاسم *</label>
          <input className="input" autoFocus value={f.name} onChange={e => set('name', e.target.value)} placeholder="مثال: أحمد" /></div>
        {!staff && (
          <>
            <div><label className="label">اسم الدخول * (إنجليزي)</label>
              <input className="input" dir="ltr" value={f.username} onChange={e => set('username', e.target.value)} placeholder="ahmad" /></div>
            <div><label className="label">الرمز (PIN) * — 4 إلى 6 أرقام</label>
              <input className="input" dir="ltr" inputMode="numeric" value={f.pin} maxLength={6} onChange={e => set('pin', e.target.value.replace(/\D/g, ''))} placeholder="••••" /></div>
          </>
        )}
        <div>
          <label className="label">الدور</label>
          <div className="flex gap-2">
            <button type="button" onClick={() => set('canPay', true)} className={`flex-1 py-2 rounded-lg text-sm font-semibold border ${f.canPay ? 'bg-[#FBEBE2] border-[#E15A30] text-[#C94E28]' : 'bg-white border-[#E9E1D3] text-[#6E6557]'}`}>كاشير (يقبض)</button>
            <button type="button" onClick={() => set('canPay', false)} className={`flex-1 py-2 rounded-lg text-sm font-semibold border ${!f.canPay ? 'bg-[#FBEBE2] border-[#E15A30] text-[#C94E28]' : 'bg-white border-[#E9E1D3] text-[#6E6557]'}`}>نادل (طلبات فقط)</button>
          </div>
          <p className="text-xs text-[#9A8F7E] mt-1">النادل يأخذ الطلبات ويرسلها للمطبخ، والكاشير يقبض الدفع أيضاً.</p>
        </div>
      </div>
      <Footer loading={mut.isPending} onSave={submit} onClose={onClose} />
    </Shell>
  );
}

function PinModal({ staff, onClose }: { staff: Staff; onClose: () => void }) {
  const [pin, setPin] = useState('');
  const mut = useMutation({
    mutationFn: () => restaurantApi.resetStaffPin(staff.id, pin),
    onSuccess: () => { toast.success('تم تغيير الرمز'); onClose(); },
    onError: () => toast.error('حدث خطأ'),
  });
  const submit = () => { if (!/^\d{4,6}$/.test(pin)) { toast.error('الرمز 4 إلى 6 أرقام'); return; } mut.mutate(); };
  return (
    <Shell title={`رمز ${staff.name}`} onClose={onClose}>
      <div className="p-5">
        <label className="label">الرمز الجديد (PIN)</label>
        <input className="input text-lg" dir="ltr" inputMode="numeric" autoFocus value={pin} maxLength={6} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} placeholder="••••" />
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
          <h2 className="font-bold text-[#1F1A13] flex items-center gap-2"><Users size={18} className="text-[#E15A30]" /> {title}</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Footer({ loading, onSave, onClose }: { loading?: boolean; onSave: () => void; onClose: () => void }) {
  return (
    <div className="flex gap-3 p-4 border-t border-[#E9E1D3]">
      <button onClick={onSave} disabled={loading} className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
        {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Check size={16} />} حفظ
      </button>
      <button onClick={onClose} className="btn-secondary">إلغاء</button>
    </div>
  );
}
