import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { tenantApi } from '../api/client';
import { Tenant } from '../types';
import { formatDate } from '../utils/format';
import { useAuthStore } from '../store/authStore';
import {
  Building2, Plus, LogOut, Power, Users, FileText,
  CheckCircle2, Copy, Check, X, Calendar, LogIn, Trash2, KeyRound, AlertTriangle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import ChangePasswordModal from '../components/ChangePasswordModal';
import { BrandIcon } from '../components/BrandLogo';

const PLAN_LABELS: Record<string, string> = { basic: 'أساسي', pro: 'احترافي', enterprise: 'مؤسسي' };

export default function PlatformPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user, logout, impersonate } = useAuthStore();
  const [showCreate, setShowCreate] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Tenant | null>(null);
  const [createdInfo, setCreatedInfo] = useState<{ company: string; email: string; password: string } | null>(null);

  const { data: tenants, isLoading } = useQuery({
    queryKey: ['tenants'],
    queryFn: async () => { const res = await tenantApi.list(); return res.data.data as Tenant[]; },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => tenantApi.update(id, { isActive }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tenants'] }); toast.success('تم تحديث حالة الاشتراك'); },
    onError: () => toast.error('حدث خطأ'),
  });

  // دخول المالك إلى لوحة الشركة (للاطلاع على بياناتها)
  const enterMutation = useMutation({
    mutationFn: (id: string) => tenantApi.impersonate(id),
    onSuccess: (res) => {
      const { token, user: companyUser } = res.data.data;
      impersonate(token, companyUser, companyUser.companyName);
      // إعادة تحميل كاملة على '/' لتجنّب إعادة تقييم حارس المالك أثناء تبديل الهوية
      window.location.href = '/';
    },
    onError: (err: unknown) => toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'تعذّر الدخول للشركة'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => tenantApi.remove(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tenants'] }); toast.success('تم حذف الشركة'); setDeleteTarget(null); },
    onError: () => toast.error('تعذّر حذف الشركة'),
  });

  const handleLogout = () => { logout(); navigate('/owner'); };

  const activeCount = tenants?.filter(t => t.isActive).length ?? 0;
  const totalReps = tenants?.reduce((s, t) => s + (t._count?.salesReps ?? 0), 0) ?? 0;
  const totalInvoices = tenants?.reduce((s, t) => s + (t._count?.invoices ?? 0), 0) ?? 0;

  const subStatus = (t: Tenant) => {
    if (!t.isActive) return { label: 'موقوف', cls: 'bg-red-100 text-red-700' };
    if (t.subscriptionEndsAt && new Date(t.subscriptionEndsAt).getTime() < Date.now()) return { label: 'منتهٍ', cls: 'bg-amber-100 text-amber-700' };
    return { label: 'نشط', cls: 'bg-green-100 text-green-700' };
  };

  return (
    <div className="min-h-screen bg-[#FAF7F0]" dir="rtl">
      {/* Top bar */}
      <header className="bg-[#1F1A13] text-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BrandIcon size={40} radius={0.28} />
            <div>
              <p style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 700 }}>
                <span className="text-[#FAF7F0]">Field</span><span className="text-[#E15A30]"> Sales</span>
                <span className="text-[#9A8F7E] font-normal text-sm"> · لوحة المالك</span>
              </p>
              <p className="text-slate-300 text-xs">{user?.name}</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button onClick={() => setShowPassword(true)} className="flex items-center gap-2 text-slate-300 hover:text-white text-sm">
              <KeyRound size={16} /> كلمة المرور
            </button>
            <button onClick={handleLogout} className="flex items-center gap-2 text-slate-300 hover:text-white text-sm">
              <LogOut size={18} /> خروج
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatBox icon={Building2} label="إجمالي الشركات" value={String(tenants?.length ?? 0)} color="bg-[#E15A30]" />
          <StatBox icon={CheckCircle2} label="اشتراكات نشطة" value={String(activeCount)} color="bg-green-500" />
          <StatBox icon={Users} label="إجمالي المناديب" value={String(totalReps)} color="bg-purple-500" />
          <StatBox icon={FileText} label="إجمالي الفواتير" value={String(totalInvoices)} color="bg-orange-500" />
        </div>

        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-800">الشركات المشتركة</h2>
          <button onClick={() => setShowCreate(true)} className="btn-primary"><Plus size={16} /> إضافة شركة</button>
        </div>

        {/* Tenants list */}
        <div className="card p-0 overflow-hidden">
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>الشركة</th><th>المدير</th><th>الخطة</th>
                  <th className="text-center">مناديب</th>
                  <th className="text-center">عملاء</th>
                  <th>انتهاء الاشتراك</th><th>الحالة</th><th>إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={8} className="text-center py-12 text-gray-400">جاري التحميل...</td></tr>
                ) : tenants?.length === 0 ? (
                  <tr><td colSpan={8} className="text-center py-12 text-gray-400">لا توجد شركات — أضف أول شركة</td></tr>
                ) : tenants?.map(t => {
                  const st = subStatus(t);
                  return (
                    <tr key={t.id}>
                      <td>
                        <p className="font-semibold text-gray-800">{t.name}</p>
                        <p className="text-xs text-gray-400">{formatDate(t.createdAt)}</p>
                      </td>
                      <td className="text-sm text-gray-600">{t.admins?.[0]?.email || '-'}</td>
                      <td><span className="badge-active">{PLAN_LABELS[t.plan] || t.plan}</span></td>
                      <td className="text-center text-gray-600">{t._count?.salesReps ?? 0}</td>
                      <td className="text-center text-gray-600">{t._count?.customers ?? 0}</td>
                      <td className="text-sm text-gray-500">{t.subscriptionEndsAt ? formatDate(t.subscriptionEndsAt) : 'غير محدود'}</td>
                      <td><span className={`px-2 py-1 rounded-full text-xs font-medium ${st.cls}`}>{st.label}</span></td>
                      <td>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => enterMutation.mutate(t.id)}
                            disabled={enterMutation.isPending}
                            className="flex items-center gap-1 text-xs bg-[#E15A30] hover:bg-[#C94E28] text-white rounded-lg px-2.5 py-1.5 font-semibold"
                            title="الدخول إلى لوحة الشركة والاطلاع على بياناتها">
                            <LogIn size={13} /> دخول
                          </button>
                          <button
                            onClick={() => toggleMutation.mutate({ id: t.id, isActive: !t.isActive })}
                            className={`p-1.5 rounded ${t.isActive ? 'text-red-500 hover:bg-red-50' : 'text-green-600 hover:bg-green-50'}`}
                            title={t.isActive ? 'إيقاف الاشتراك' : 'تفعيل الاشتراك'}>
                            <Power size={15} />
                          </button>
                          <button
                            onClick={() => setDeleteTarget(t)}
                            className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"
                            title="حذف الشركة نهائياً">
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {showCreate && (
        <CreateTenantModal
          onClose={() => setShowCreate(false)}
          onCreated={(info) => { setShowCreate(false); setCreatedInfo(info); qc.invalidateQueries({ queryKey: ['tenants'] }); }}
        />
      )}
      {createdInfo && <CredentialsModal info={createdInfo} onClose={() => setCreatedInfo(null)} />}
      {showPassword && <ChangePasswordModal onClose={() => setShowPassword(false)} />}
      {deleteTarget && (
        <DeleteConfirmModal
          tenant={deleteTarget}
          loading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleteTarget.id)}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

// تأكيد حذف الشركة — يتطلب كتابة اسم الشركة لمنع الحذف الخاطئ
function DeleteConfirmModal({ tenant, loading, onConfirm, onClose }: { tenant: Tenant; loading: boolean; onConfirm: () => void; onClose: () => void }) {
  const [confirmText, setConfirmText] = useState('');
  const matches = confirmText.trim() === tenant.name.trim();
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="p-6 text-center border-b border-gray-100">
          <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
            <AlertTriangle size={28} className="text-red-600" />
          </div>
          <h2 className="text-lg font-bold text-gray-800">حذف الشركة نهائياً</h2>
          <p className="text-sm text-gray-500 mt-1">{tenant.name}</p>
        </div>
        <div className="p-6 space-y-4">
          <div className="bg-red-50 text-red-700 rounded-lg px-3 py-2.5 text-xs leading-relaxed">
            تحذير: سيُحذف كل شيء يخص هذه الشركة نهائياً — المدير، المناديب، العملاء، المنتجات، الفواتير، السندات. لا يمكن التراجع.
          </div>
          <div>
            <label className="label">اكتب اسم الشركة للتأكيد:</label>
            <input className="input" value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder={tenant.name} />
          </div>
        </div>
        <div className="flex gap-3 p-6 pt-0">
          <button onClick={onConfirm} disabled={!matches || loading}
            className="flex-1 justify-center py-2.5 rounded-xl bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white font-semibold flex items-center gap-2">
            {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Trash2 size={15} />}
            حذف نهائي
          </button>
          <button onClick={onClose} className="btn-secondary">إلغاء</button>
        </div>
      </div>
    </div>
  );
}

function StatBox({ icon: Icon, label, value, color }: { icon: React.ElementType; label: string; value: string; color: string }) {
  return (
    <div className="bg-white rounded-2xl p-4 flex items-center gap-3 border border-gray-100">
      <div className={`w-11 h-11 ${color} rounded-xl flex items-center justify-center`}><Icon size={22} className="text-white" /></div>
      <div>
        <p className="text-lg font-bold text-gray-800">{value}</p>
        <p className="text-xs text-gray-500">{label}</p>
      </div>
    </div>
  );
}

function CreateTenantModal({ onClose, onCreated }: { onClose: () => void; onCreated: (info: { company: string; email: string; password: string }) => void }) {
  const [form, setForm] = useState({ companyName: '', adminName: '', adminEmail: '', adminPassword: '', plan: 'basic', subscriptionEndsAt: '' });
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const mutation = useMutation({
    mutationFn: () => tenantApi.create({
      companyName: form.companyName, adminName: form.adminName, adminEmail: form.adminEmail,
      adminPassword: form.adminPassword, plan: form.plan,
      ...(form.subscriptionEndsAt && { subscriptionEndsAt: form.subscriptionEndsAt }),
    }),
    onSuccess: () => onCreated({ company: form.companyName, email: form.adminEmail, password: form.adminPassword }),
    onError: (err: unknown) => toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'حدث خطأ'),
  });

  const submit = () => {
    if (!form.companyName.trim()) { toast.error('اسم الشركة مطلوب'); return; }
    if (!form.adminName.trim()) { toast.error('اسم المدير مطلوب'); return; }
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(form.adminEmail)) { toast.error('بريد المدير غير صحيح'); return; }
    if (form.adminPassword.length < 6) { toast.error('كلمة المرور 6 أحرف على الأقل'); return; }
    mutation.mutate();
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="text-lg font-bold text-gray-800">إضافة شركة مشتركة</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <p className="text-xs font-semibold text-gray-400 mb-2">بيانات الشركة</p>
            <div className="space-y-3">
              <div>
                <label className="label">اسم الشركة *</label>
                <input className="input" value={form.companyName} onChange={e => set('companyName', e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">الخطة</label>
                  <select className="input" value={form.plan} onChange={e => set('plan', e.target.value)}>
                    <option value="basic">أساسي</option>
                    <option value="pro">احترافي</option>
                    <option value="enterprise">مؤسسي</option>
                  </select>
                </div>
                <div>
                  <label className="label flex items-center gap-1"><Calendar size={12} /> انتهاء الاشتراك</label>
                  <input type="date" className="input" value={form.subscriptionEndsAt} onChange={e => set('subscriptionEndsAt', e.target.value)} title="اتركه فارغاً لاشتراك غير محدود" />
                </div>
              </div>
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-gray-400 mb-2">حساب مدير الشركة</p>
            <div className="space-y-3">
              <div>
                <label className="label">اسم المدير *</label>
                <input className="input" value={form.adminName} onChange={e => set('adminName', e.target.value)} />
              </div>
              <div>
                <label className="label">البريد الإلكتروني (للدخول) *</label>
                <input className="input" dir="ltr" value={form.adminEmail} onChange={e => set('adminEmail', e.target.value)} />
              </div>
              <div>
                <label className="label">كلمة المرور *</label>
                <input className="input" dir="ltr" value={form.adminPassword} onChange={e => set('adminPassword', e.target.value)} placeholder="6 أحرف على الأقل" />
              </div>
            </div>
          </div>
        </div>
        <div className="flex gap-3 p-5 border-t">
          <button onClick={submit} disabled={mutation.isPending} className="btn-primary flex-1 justify-center py-2.5">
            {mutation.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Plus size={16} />}
            إنشاء الشركة
          </button>
          <button onClick={onClose} className="btn-secondary">إلغاء</button>
        </div>
      </div>
    </div>
  );
}

function CredentialsModal({ info, onClose }: { info: { company: string; email: string; password: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copyAll = () => {
    navigator.clipboard?.writeText(`شركة: ${info.company}\nرابط الدخول: تبويب "دخول الشركة"\nالبريد: ${info.email}\nكلمة المرور: ${info.password}`)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="p-6 text-center border-b border-gray-100">
          <div className="w-14 h-14 bg-green-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
            <CheckCircle2 size={28} className="text-green-600" />
          </div>
          <h2 className="text-lg font-bold text-gray-800">تم إنشاء الشركة</h2>
          <p className="text-sm text-gray-500 mt-1">{info.company}</p>
        </div>
        <div className="p-6 space-y-3">
          <p className="text-xs text-[#C94E28] bg-[#FBEBE2] rounded-lg px-3 py-2">سلّم هذه البيانات لمدير الشركة ليدخل من تبويب «دخول الشركة»</p>
          <Row label="البريد الإلكتروني" value={info.email} />
          <Row label="كلمة المرور" value={info.password} />
        </div>
        <div className="flex gap-3 p-6 pt-0">
          <button onClick={copyAll} className="btn-secondary flex-1 justify-center">
            {copied ? <Check size={15} className="text-green-600" /> : <Copy size={15} />} نسخ البيانات
          </button>
          <button onClick={onClose} className="btn-primary flex-1 justify-center">تم</button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 rounded-lg px-3 py-2.5">
      <p className="text-[11px] text-gray-400">{label}</p>
      <p className="font-mono font-semibold text-gray-800" dir="ltr">{value}</p>
    </div>
  );
}
