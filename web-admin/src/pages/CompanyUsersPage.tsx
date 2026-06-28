import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Edit, Eye, EyeOff, KeyRound, Plus, ShieldCheck, UserCog, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { companyUserApi } from '../api/client';
import ResetPasswordModal from '../components/ResetPasswordModal';
import { useAuthStore } from '../store/authStore';
import { CompanyUser } from '../types';
import { formatDate } from '../utils/format';

type FormValues = {
  name: string;
  email: string;
  role: 'ADMIN' | 'MANAGER' | 'ACCOUNTANT';
  password?: string;
  isActive: boolean;
  canAccessDashboard: boolean;
  canManageCustomers: boolean;
  canManageProducts: boolean;
  canManageSalesReps: boolean;
  canManageInvoices: boolean;
  canManageReceipts: boolean;
  canViewReports: boolean;
  canManageVanStock: boolean;
  canManageTracking: boolean;
  canManageCompanySettings: boolean;
  canManageCompanyUsers: boolean;
};

const roleLabels: Record<CompanyUser['role'], string> = {
  ADMIN: 'مدير',
  MANAGER: 'مشرف',
  ACCOUNTANT: 'محاسب',
};

const permissionItems: { key: keyof FormValues; label: string }[] = [
  { key: 'canAccessDashboard', label: 'لوحة التحكم' },
  { key: 'canManageCustomers', label: 'العملاء' },
  { key: 'canManageProducts', label: 'المنتجات' },
  { key: 'canManageSalesReps', label: 'المناديب' },
  { key: 'canManageInvoices', label: 'الفواتير' },
  { key: 'canManageReceipts', label: 'سندات القبض' },
  { key: 'canViewReports', label: 'التقارير' },
  { key: 'canManageVanStock', label: 'مخزون السيارات' },
  { key: 'canManageTracking', label: 'تتبع المناديب' },
  { key: 'canManageCompanySettings', label: 'إعدادات الشركة' },
  { key: 'canManageCompanyUsers', label: 'مستخدمي الشركة' },
];

export default function CompanyUsersPage() {
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const [showModal, setShowModal] = useState(false);
  const [selected, setSelected] = useState<CompanyUser | null>(null);
  const [createdCreds, setCreatedCreds] = useState<{ name: string; email: string; password: string } | null>(null);
  const [resetUser, setResetUser] = useState<CompanyUser | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['company-users'],
    queryFn: async () => {
      const res = await companyUserApi.list();
      return res.data.data as CompanyUser[];
    },
    enabled: user?.role === 'ADMIN',
  });

  const saveMutation = useMutation({
    mutationFn: (values: FormValues) =>
      selected ? companyUserApi.update(selected.id, values) : companyUserApi.create(values),
    onSuccess: (_data, variables) => {
      const wasCreate = !selected;
      qc.invalidateQueries({ queryKey: ['company-users'] });
      setShowModal(false);
      setSelected(null);
      if (wasCreate) {
        setCreatedCreds({ name: variables.name, email: variables.email, password: variables.password || '' });
      } else {
        toast.success('تم تحديث المستخدم');
      }
    },
    onError: (err: unknown) => {
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'تعذّر الحفظ');
    },
  });

  if (user?.role !== 'ADMIN') {
    return (
      <div className="card max-w-xl">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center"><ShieldCheck size={20} /></div>
          <div>
            <h1 className="text-lg font-bold text-[#1F1A13]">إدارة مستخدمي الشركة</h1>
            <p className="text-sm text-gray-500 mt-1">هذه الصفحة متاحة لحساب المدير فقط.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">مستخدمي الشركة</h1>
          <p className="text-sm text-gray-500 mt-1">أضف أكثر من مستخدم للوحة إدارة الشركة وحدد دور كل حساب.</p>
        </div>
        <button className="btn-primary" onClick={() => { setSelected(null); setShowModal(true); }}><Plus size={16} />إضافة مستخدم</button>
      </div>

      <div className="card p-0">
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>المستخدم</th>
                <th>الدور</th>
                <th>تاريخ الإنشاء</th>
                <th>الحالة</th>
                <th>إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={5} className="text-center py-12 text-gray-400">جاري التحميل...</td></tr>
              ) : data?.length ? data.map(u => (
                <tr key={u.id}>
                  <td>
                    <p className="font-medium text-gray-800">{u.name}</p>
                    <p className="text-xs text-gray-400" dir="ltr">{u.email}</p>
                  </td>
                  <td><span className="badge bg-[#F1EBDF] text-[#6E6557]">{roleLabels[u.role]}</span></td>
                  <td className="text-sm text-gray-500">{formatDate(u.createdAt)}</td>
                  <td><span className={u.isActive ? 'badge-active' : 'badge-inactive'}>{u.isActive ? 'نشط' : 'غير نشط'}</span></td>
                  <td>
                    <div className="flex items-center gap-1">
                      <button onClick={() => { setSelected(u); setShowModal(true); }} className="p-1.5 hover:bg-[#FBEBE2] rounded text-[#E15A30]" title="تعديل"><Edit size={14} /></button>
                      <button onClick={() => setResetUser(u)} className="p-1.5 hover:bg-amber-50 rounded text-amber-600" title="إعادة تعيين كلمة المرور"><KeyRound size={14} /></button>
                    </div>
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={5} className="text-center py-12 text-gray-400">لا يوجد مستخدمون بعد</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <CompanyUserModal
          user={selected}
          currentUserId={user.id}
          loading={saveMutation.isPending}
          onClose={() => { setShowModal(false); setSelected(null); }}
          onSave={saveMutation.mutate}
        />
      )}

      {createdCreds && <CredentialsModal creds={createdCreds} onClose={() => setCreatedCreds(null)} />}

      {resetUser && (
        <ResetPasswordModal
          title="إعادة تعيين كلمة مرور المستخدم"
          subject={`${resetUser.name} · ${resetUser.email}`}
          onConfirm={async (newPassword) => { await companyUserApi.update(resetUser.id, { password: newPassword }); }}
          onClose={() => setResetUser(null)}
        />
      )}
    </div>
  );
}

function CompanyUserModal({ user, currentUserId, loading, onClose, onSave }: {
  user: CompanyUser | null;
  currentUserId?: string;
  loading: boolean;
  onClose: () => void;
  onSave: (values: FormValues) => void;
}) {
  const [form, setForm] = useState<FormValues>({
    name: user?.name || '',
    email: user?.email || '',
    role: user?.role || 'MANAGER',
    password: '',
    isActive: user?.isActive ?? true,
    canAccessDashboard: user?.canAccessDashboard ?? true,
    canManageCustomers: user?.canManageCustomers ?? true,
    canManageProducts: user?.canManageProducts ?? true,
    canManageSalesReps: user?.canManageSalesReps ?? true,
    canManageInvoices: user?.canManageInvoices ?? true,
    canManageReceipts: user?.canManageReceipts ?? true,
    canViewReports: user?.canViewReports ?? true,
    canManageVanStock: user?.canManageVanStock ?? true,
    canManageTracking: user?.canManageTracking ?? true,
    canManageCompanySettings: user?.canManageCompanySettings ?? true,
    canManageCompanyUsers: user?.canManageCompanyUsers ?? false,
  });
  const [showPass, setShowPass] = useState(false);
  const [err, setErr] = useState('');

  const isSelf = !!user && user.id === currentUserId;
  const set = (key: keyof FormValues, value: string | boolean) => setForm(f => ({ ...f, [key]: value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setErr('اسم المستخدم مطلوب'); return; }
    if (!form.email.includes('@')) { setErr('البريد الإلكتروني غير صحيح'); return; }
    if (!user && (form.password || '').trim().length < 6) { setErr('كلمة المرور 6 أحرف على الأقل'); return; }
    onSave({ ...form, name: form.name.trim(), email: form.email.trim(), password: form.password?.trim() || undefined });
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <form onSubmit={submit} className="bg-white rounded-2xl shadow-2xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center"><UserCog size={18} /></div>
            <div>
              <h2 className="text-base font-bold text-[#1F1A13]">{user ? 'تعديل مستخدم' : 'إضافة مستخدم'}</h2>
              <p className="text-xs text-[#6E6557]">يستخدم هذا الحساب صفحة دخول الأدمن نفسها.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">الاسم</label>
              <input className="input" value={form.name} onChange={e => set('name', e.target.value)} autoFocus />
            </div>
            <div>
              <label className="label">الدور</label>
              <select className="input" value={form.role} disabled={isSelf} onChange={e => set('role', e.target.value)}>
                <option value="ADMIN">مدير</option>
                <option value="MANAGER">مشرف</option>
                <option value="ACCOUNTANT">محاسب</option>
              </select>
            </div>
          </div>

          <div>
            <label className="label">البريد الإلكتروني</label>
            <input className="input" dir="ltr" type="email" value={form.email} onChange={e => set('email', e.target.value)} />
          </div>

          {!user && (
            <div>
              <label className="label">كلمة المرور</label>
              <div className="relative">
                <input className="input pl-9" dir="ltr" type={showPass ? 'text' : 'password'} placeholder="6 أحرف على الأقل" value={form.password || ''} onChange={e => set('password', e.target.value)} />
                <button type="button" onClick={() => setShowPass(s => !s)} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                  {showPass ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>
          )}

          <label className={`flex items-center gap-2 text-sm ${isSelf ? 'text-gray-400' : 'text-gray-700'}`}>
            <input type="checkbox" checked={form.isActive} disabled={isSelf} onChange={e => set('isActive', e.target.checked)} />
            الحساب نشط
          </label>

          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-500 uppercase">صلاحيات المستخدم</h3>
              <div className="flex items-center gap-3 text-xs">
                <button type="button" onClick={() => setForm(f => ({ ...f, ...Object.fromEntries(permissionItems.map(p => [p.key, true])) } as FormValues))} className="text-[#E15A30] hover:text-[#C94E28]">تحديد الكل</button>
                <button type="button" onClick={() => setForm(f => ({ ...f, ...Object.fromEntries(permissionItems.map(p => [p.key, false])), canManageCompanyUsers: isSelf ? f.canManageCompanyUsers : false } as FormValues))} className="text-gray-500 hover:text-gray-700">إلغاء الكل</button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {permissionItems.map(p => {
                const disabled = isSelf && p.key === 'canManageCompanyUsers';
                return (
                  <label key={p.key} className={`flex items-center gap-2 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2 text-sm ${disabled ? 'text-gray-400' : 'text-gray-700'}`}>
                    <input
                      type="checkbox"
                      checked={!!form[p.key]}
                      disabled={disabled}
                      onChange={e => set(p.key, e.target.checked)}
                    />
                    {p.label}
                  </label>
                );
              })}
            </div>
          </div>
          {isSelf && <p className="text-xs text-amber-600">لا يمكنك تعطيل حسابك أو تغيير دورك من هذه النافذة.</p>}
          {err && <p className="text-[#C0392B] text-xs">{err}</p>}
        </div>

        <div className="p-5 border-t border-[#E9E1D3] flex gap-3">
          <button type="submit" disabled={loading} className="btn-primary flex-1 justify-center py-2.5">
            {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Check size={16} />}
            {user ? 'حفظ التعديلات' : 'إضافة المستخدم'}
          </button>
          <button type="button" onClick={onClose} className="btn-secondary">إلغاء</button>
        </div>
      </form>
    </div>
  );
}

function CredentialsModal({ creds, onClose }: { creds: { name: string; email: string; password: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = `دخول لوحة الإدارة\nالبريد: ${creds.email}\nكلمة المرور: ${creds.password}`;
  const copy = () => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-[#E9E1D3] flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-green-100 text-green-600 flex items-center justify-center"><Check size={18} /></div>
          <div>
            <h2 className="font-bold text-[#1F1A13]">تم إنشاء المستخدم</h2>
            <p className="text-xs text-gray-500">{creds.name}</p>
          </div>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-xs text-[#9C4423] bg-[#FBEBE2] rounded-lg px-3 py-2">سلّم بيانات الدخول لصاحب الحساب، لن تظهر كلمة المرور مرة أخرى.</p>
          <div className="bg-gray-50 rounded-xl p-3 space-y-2 text-sm">
            <div className="flex justify-between gap-3"><span className="text-gray-500">البريد</span><span className="font-mono" dir="ltr">{creds.email}</span></div>
            <div className="flex justify-between gap-3"><span className="text-gray-500">كلمة المرور</span><span className="font-mono font-bold" dir="ltr">{creds.password}</span></div>
          </div>
          <div className="flex gap-3">
            <button onClick={copy} className="btn-primary flex-1 justify-center py-2.5"><Copy size={15} />{copied ? 'تم النسخ' : 'نسخ البيانات'}</button>
            <button onClick={onClose} className="btn-secondary">تم</button>
          </div>
        </div>
      </div>
    </div>
  );
}
