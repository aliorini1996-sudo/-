import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, Check, Copy, Edit, Eye, EyeOff, KeyRound, Plus, ShieldCheck, UserCog, X, Filter, Trash2, Image as ImageIcon } from 'lucide-react';
import toast from 'react-hot-toast';
import { companyUserApi, companyApi } from '../api/client';
import ConfirmDialog from '../components/ConfirmDialog';
import ResetPasswordModal from '../components/ResetPasswordModal';
import UserScopeModal from '../components/UserScopeModal';
import { useAuthStore } from '../store/authStore';
import { useAccountingOn } from '../components/AccountingGate';
import { useLedgerOn } from '../components/LedgerGate';
import { ledgerPermissionItems } from '../lib/ledger/labels';
import { CompanyUser } from '../types';
import { formatDate, formatCurrency } from '../utils/format';
import { compressImage } from '../rep/imageCompress';
import { useTr } from '../i18n/strings';
import { backdropClose } from '../lib/backdropClose';

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
  canManageDailyReport: boolean;
  canReceiveUserCollections: boolean;
  // صلاحيات الدفاتر — افتراضها false، فلا `?? true` إطلاقاً (§9.2)
  canViewLedger?: boolean;
  canPostJournals?: boolean;
  canManagePayables?: boolean;
  canManageBank?: boolean;
  canCloseLedgerPeriods?: boolean;
  canConfigureLedger?: boolean;
};

const roleLabels: Record<CompanyUser['role'], string> = {
  ADMIN: 'مدير',
  MANAGER: 'مشرف',
  ACCOUNTANT: 'محاسب',
};

/**
 * صلاحية «إعدادات التقرير اليومي» **لا تُعرض إلا لشركةٍ فعّلت الميزة**: خانةٌ
 * لصلاحيةٍ على ميزةٍ غير مشتراة تُربك المالك ولا تعني شيئاً.
 * وهي أخطر من نظائرها: من يملكها يجعل نفسه مستقبِل كل التقارير عند كل عقدة
 * ثم يعتمدها بنفسه، فتصير سلسلة الاعتماد توقيعاً ذاتياً.
 */
const dailyReportPermission = { key: 'canManageDailyReport' as keyof FormValues, label: 'إعدادات التقرير اليومي' };

/** صلاحيات أقسامٍ محاسبية — تُخفى مع إطفاء المحاسبة لأن أقسامها نفسها مخفيّة */
const ACCOUNTING_PERMS = new Set(['canManageProducts', 'canManageInvoices', 'canManageReceipts', 'canManageVanStock']);

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
  // استلام عهدة التحصيل من مستخدمٍ آخر — مطفأة افتراضياً، ومن يملكها يرى أيقونة الاستلام
  { key: 'canReceiveUserCollections', label: 'استلام التحصيل من المستخدمين' },
];

export default function CompanyUsersPage() {
  const qc = useQueryClient();
  const tr = useTr();
  const { user, patchUser } = useAuthStore();
  // العَلَم مطفأ افتراضياً: `=== true` لا `!== false`
  const companyQ = useQuery({
    queryKey: ['company-flags'],
    queryFn: async () => (await companyApi.get()).data.data as { dailyReportEnabled?: boolean } | null,
  });
  const dailyReportOn = companyQ.data?.dailyReportEnabled === true;
  // المحاسبة على النقيض: مفعّلة افتراضياً ⇒ `!== false` (تقرأها البوّابة المشتركة)
  const { on: accountingFlag, ready: accountingReady } = useAccountingOn();
  const accountingOn = accountingReady && accountingFlag;
  // الدفاتر مطفأة افتراضياً — `ledgerOn` لا `accountingOn` (اسمٌ تحرسه اختبارات العدّ)
  const { on: ledgerFlag, ready: ledgerReady } = useLedgerOn();
  const ledgerOn = ledgerReady && ledgerFlag;
  const [showModal, setShowModal] = useState(false);
  const [selected, setSelected] = useState<CompanyUser | null>(null);
  const [createdCreds, setCreatedCreds] = useState<{ name: string; email: string; password: string } | null>(null);
  const [resetUser, setResetUser] = useState<CompanyUser | null>(null);
  const [scopeUser, setScopeUser] = useState<CompanyUser | null>(null); // نافذة نطاق المستخدم
  const [custodyUser, setCustodyUser] = useState<CompanyUser | null>(null); // نافذة استلام عهدة مستخدم
  const [deleting, setDeleting] = useState<CompanyUser | null>(null);

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
    onSuccess: (data, variables) => {
      const wasCreate = !selected;
      qc.invalidateQueries({ queryKey: ['company-users'] });
      /* عدّل المستخدمُ حسابَه هو ⇒ حدِّث كائن الجلسة. الصلاحيات تُقرأ منه في كلّ
       * شاشة (ومنها أيقونة استلام العهدة أدناه)، فبلا هذا لا يرى أثر حفظه
       * حتى يخرج ويدخل. والمصدر ردُّ الخادم لا ما أُرسل: هو من يحسم ما قُبل. */
      if (selected && selected.id === user?.id) {
        const saved = (data as { data?: { data?: Partial<CompanyUser> } })?.data?.data;
        if (saved) patchUser(saved);
      }
      setShowModal(false);
      setSelected(null);
      if (wasCreate) {
        setCreatedCreds({ name: variables.name, email: variables.email, password: variables.password || '' });
      } else {
        toast.success(tr('تم تحديث المستخدم'));
      }
    },
    onError: (err: unknown) => {
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر الحفظ'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => companyUserApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['company-users'] });
      toast.success(tr('تم حذف المستخدم'));
      setDeleting(null);
    },
    onError: (err: unknown) => {
      // رسالة الخادم هي المفيدة هنا (آخر مدير / حذف الذات) فلا نبتلعها
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر حذف المستخدم'));
      setDeleting(null);
    },
  });

  if (user?.role !== 'ADMIN') {
    return (
      <div className="card max-w-xl">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center"><ShieldCheck size={20} /></div>
          <div>
            <h1 className="text-lg font-bold text-[#1F1A13]">{tr('إدارة مستخدمي الشركة')}</h1>
            <p className="text-sm text-gray-500 mt-1">{tr('هذه الصفحة متاحة لحساب المدير فقط')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{tr('مستخدمي الشركة')}</h1>
          <p className="text-sm text-gray-500 mt-1">{tr('أضف أكثر من مستخدم للوحة إدارة الشركة وحدد دور كل حساب')}</p>
        </div>
        <button className="btn-primary" onClick={() => { setSelected(null); setShowModal(true); }}><Plus size={16} />{tr('إضافة مستخدم')}</button>
      </div>

      <div className="card p-0">
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>{tr('المستخدم')}</th>
                <th>{tr('الدور')}</th>
                <th>{tr('عهدة التحصيل')}</th>
                <th>{tr('تاريخ الإنشاء')}</th>
                <th>{tr('الحالة')}</th>
                <th>{tr('إجراءات')}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} className="text-center py-12 text-gray-400">{tr('جاري التحميل')}</td></tr>
              ) : data?.length ? data.map(u => (
                <tr key={u.id}>
                  <td>
                    <p className="font-medium text-gray-800">{u.name}</p>
                    <p className="text-xs text-gray-400" dir="ltr">{u.email}</p>
                  </td>
                  <td><span className="badge bg-[#F1EBDF] text-[#6E6557]">{tr(roleLabels[u.role])}</span></td>
                  {/* عهدة التحصيل: ما استلمه من المناديب ولم يورّده بعد */}
                  <td className="tabular-nums">
                    {/* السالب يُعرض بالأحمر لا يُخفى: رصيدٌ سالب خللٌ محاسبيّ
                        (وُرّد أكثر ممّا استُلم) ويمنع كلّ توريدٍ لاحق — إخفاؤه
                        يترك المالك يبحث عن سببٍ لا يراه. */}
                    {Math.abs(Number(u.custody) || 0) > 0.004
                      ? <b className={Number(u.custody) > 0 ? 'text-[#2F855A]' : 'text-[#C0392B]'}>{formatCurrency(Number(u.custody))}</b>
                      : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="text-sm text-gray-500">{formatDate(u.createdAt)}</td>
                  <td><span className={u.isActive ? 'badge-active' : 'badge-inactive'}>{u.isActive ? tr('نشط') : tr('غير نشط')}</span></td>
                  <td>
                    <div className="flex items-center gap-1">
                      <button onClick={() => { setSelected(u); setShowModal(true); }} className="p-1.5 hover:bg-[#FBEBE2] rounded text-[#E15A30]" title={tr('تعديل')}><Edit size={14} /></button>
                      <button onClick={() => setResetUser(u)} className="p-1.5 hover:bg-amber-50 rounded text-amber-600" title={tr('إعادة تعيين كلمة المرور')}><KeyRound size={14} /></button>
                      <button onClick={() => setScopeUser(u)} className="p-1.5 hover:bg-blue-50 rounded text-blue-600" title={tr('نطاق المستخدم العملاء والمناديب')}><Filter size={14} /></button>
                      {/* استلام عهدة هذا المستخدم — لصاحب الصلاحية وحده، ولا يستلم أحدٌ من نفسه.
                          تظهر ولو كانت العهدة صفراً كي يُقرأ سجلّ توريداته السابقة. */}
                      {user.canReceiveUserCollections === true && u.id !== user.id && (
                        <button onClick={() => setCustodyUser(u)} className="p-1.5 hover:bg-green-50 rounded text-green-600" title={tr('استلام تحصيل')}><Banknote size={14} /></button>
                      )}
                      {/* حسابك لا يُحذف من هنا — الخادم يرفضه أيضاً، والإخفاء يمنع محاولة عبثية */}
                      {u.id !== user.id && (
                        <button onClick={() => setDeleting(u)} className="p-1.5 hover:bg-red-50 rounded text-red-600" title={tr('حذف المستخدم')}><Trash2 size={14} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={5} className="text-center py-12 text-gray-400">{tr('لا يوجد مستخدمون بعد')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <CompanyUserModal
          dailyReportOn={dailyReportOn}
          accountingOn={accountingOn}
          ledgerOn={ledgerOn}
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
          title={tr('إعادة تعيين كلمة مرور المستخدم')}
          subject={`${resetUser.name} · ${resetUser.email}`}
          onConfirm={async (newPassword) => { await companyUserApi.update(resetUser.id, { password: newPassword }); }}
          onClose={() => setResetUser(null)}
        />
      )}

      {custodyUser && (
        <UserCustodyModal user={custodyUser} isCompanyAdmin={user?.role === 'ADMIN'}
          onClose={() => setCustodyUser(null)}
          onDone={() => qc.invalidateQueries({ queryKey: ['company-users'] })} />
      )}

      {scopeUser && (
        <UserScopeModal userId={scopeUser.id} userName={scopeUser.name} onClose={() => setScopeUser(null)} />
      )}

      {deleting && (
        <ConfirmDialog
          danger
          title={tr('حذف المستخدم')}
          message={`${tr('سيتم حذف المستخدم')} «${deleting.name}» (${deleting.email}) ${tr('نهائيا ولا يمكن التراجع يفقد الوصول للوحة فورا ويحذف نطاقه المحدد لا تتأثر الفواتير ولا السندات فهي منسوبة للمناديب ولا يحذف من في عهدته تحصيل حتى تستلمه')}`}
          confirmLabel={tr('حذف نهائي')}
          loading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function CompanyUserModal({ user, currentUserId, loading, dailyReportOn, accountingOn, ledgerOn, onClose, onSave }: {
  user: CompanyUser | null;
  currentUserId?: string;
  loading: boolean;
  dailyReportOn: boolean;
  accountingOn: boolean;
  ledgerOn: boolean;
  onClose: () => void;
  onSave: (values: FormValues) => void;
}) {
  const tr = useTr();
  const withDaily = dailyReportOn ? [...permissionItems, dailyReportPermission] : permissionItems;
  // ثم تُسقَط صلاحيات الأقسام المحاسبية حين تُطفأ المحاسبة. والإخفاء لا يُصفّر:
  // النموذج يرسل `form` كاملاً بقيم المستخدم المحفوظة، فصلاحية «الفواتير» تبقى
  // كما هي وتعود بعودة المحاسبة.
  const shownPermissions = accountingOn ? withDaily : withDaily.filter(p => !ACCOUNTING_PERMS.has(p.key));
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
    canManageDailyReport: user?.canManageDailyReport ?? true,
    // ميزة جديدة: `=== true` لا `?? true` — لا تُمنح ضمناً لمن أُنشئ قبلها
    canReceiveUserCollections: user?.canReceiveUserCollections === true,
    canViewLedger: user?.canViewLedger === true,
    canPostJournals: user?.canPostJournals === true,
    canManagePayables: user?.canManagePayables === true,
    canManageBank: user?.canManageBank === true,
    canCloseLedgerPeriods: user?.canCloseLedgerPeriods === true,
    canConfigureLedger: user?.canConfigureLedger === true,
  });
  const ledgerItems = ledgerPermissionItems(tr);
  // المدير الذي يملك إدارة المستخدمين يملك الست ضمناً (§9.2 ج): تُعرض مؤشَّرةً ومعطّلة ولا تُرسل
  const ledgerImplicit = form.role === 'ADMIN' && form.canManageCompanyUsers;
  const [showPass, setShowPass] = useState(false);
  const [err, setErr] = useState('');

  const isSelf = !!user && user.id === currentUserId;
  const set = (key: keyof FormValues, value: string | boolean) => setForm(f => ({ ...f, [key]: value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setErr(tr('اسم المستخدم مطلوب')); return; }
    if (!form.email.includes('@')) { setErr(tr('البريد الإلكتروني غير صحيح')); return; }
    if (!user && (form.password || '').trim().length < 8) { setErr(tr('كلمة المرور 8 أحرف على الأقل')); return; }
    // الدفاتر المخفية لا ترسل قيمة (PUT جزئي فتبقى المخزّنة)، وكذا الضمنية للمالك
    if (!ledgerOn || ledgerImplicit) {
      const { canViewLedger, canPostJournals, canManagePayables, canManageBank, canCloseLedgerPeriods, canConfigureLedger, ...rest } = form;
      onSave({ ...rest, name: form.name.trim(), email: form.email.trim(), password: form.password?.trim() || undefined });
      return;
    }
    onSave({ ...form, name: form.name.trim(), email: form.email.trim(), password: form.password?.trim() || undefined });
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      {/* النافذة لا تتجاوز ارتفاع الشاشة: رأسها وزرّ الحفظ ثابتان والمحتوى يُمرَّر بينهما.
          بلا ذلك كانت تُوسَّط وهي أطول من الشاشة (بعد إضافة «صلاحيات الدفاتر») فيُقصّ
          عنوانها وزرّ «حفظ التعديلات» خارج الشاشة بلا تمرير يبلغهما */}
      <form onSubmit={submit} className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[calc(100dvh-2rem)] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex-shrink-0 flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center"><UserCog size={18} /></div>
            <div>
              <h2 className="text-base font-bold text-[#1F1A13]">{user ? tr('تعديل مستخدم') : tr('إضافة مستخدم')}</h2>
              <p className="text-xs text-[#6E6557]">{tr('يستخدم هذا الحساب صفحة دخول الأدمن نفسها')}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">{tr('الاسم')}</label>
              <input className="input" value={form.name} onChange={e => set('name', e.target.value)} autoFocus />
            </div>
            <div>
              <label className="label">{tr('الدور')}</label>
              <select className="input" value={form.role} disabled={isSelf} onChange={e => set('role', e.target.value)}>
                <option value="ADMIN">{tr('مدير')}</option>
                <option value="MANAGER">{tr('مشرف')}</option>
                <option value="ACCOUNTANT">{tr('محاسب')}</option>
              </select>
            </div>
          </div>

          <div>
            <label className="label">{tr('البريد الإلكتروني')}</label>
            <input className="input" dir="ltr" type="email" value={form.email} onChange={e => set('email', e.target.value)} />
          </div>

          {!user && (
            <div>
              <label className="label">{tr('كلمة المرور')}</label>
              <div className="relative">
                <input className="input pl-9" dir="ltr" type={showPass ? 'text' : 'password'} placeholder={tr('6 أحرف على الأقل')} value={form.password || ''} onChange={e => set('password', e.target.value)} />
                <button type="button" onClick={() => setShowPass(s => !s)} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                  {showPass ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>
          )}

          <label className={`flex items-center gap-2 text-sm ${isSelf ? 'text-gray-400' : 'text-gray-700'}`}>
            <input type="checkbox" checked={form.isActive} disabled={isSelf} onChange={e => set('isActive', e.target.checked)} />
            {tr('الحساب نشط')}
          </label>

          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-500 uppercase">{tr('صلاحيات المستخدم')}</h3>
              <div className="flex items-center gap-3 text-xs">
                <button type="button" onClick={() => setForm(f => ({ ...f, ...Object.fromEntries(shownPermissions.map(p => [p.key, true])) } as FormValues))} className="text-[#E15A30] hover:text-[#C94E28]">{tr('تحديد الكل')}</button>
                <button type="button" onClick={() => setForm(f => ({ ...f, ...Object.fromEntries(shownPermissions.map(p => [p.key, false])), canManageCompanyUsers: isSelf ? f.canManageCompanyUsers : false } as FormValues))} className="text-gray-500 hover:text-gray-700">{tr('إلغاء الكل')}</button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {shownPermissions.map(p => {
                const disabled = isSelf && p.key === 'canManageCompanyUsers';
                return (
                  <label key={p.key} className={`flex items-center gap-2 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2 text-sm ${disabled ? 'text-gray-400' : 'text-gray-700'}`}>
                    <input
                      type="checkbox"
                      checked={!!form[p.key]}
                      disabled={disabled}
                      onChange={e => set(p.key, e.target.checked)}
                    />
                    {tr(p.label)}
                  </label>
                );
              })}
            </div>
          </div>
          {ledgerOn && (
            <div>
              <h3 className="text-sm font-semibold text-gray-500 uppercase mb-3">{tr('صلاحيات الدفاتر')}</h3>
              <div className="grid grid-cols-2 gap-3">
                {ledgerItems.map(p => (
                  <label key={p.key} className={`flex items-center gap-2 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2 text-sm ${ledgerImplicit ? 'text-gray-400' : 'text-gray-700'}`}>
                    <input
                      type="checkbox"
                      checked={ledgerImplicit || form[p.key] === true}
                      disabled={ledgerImplicit}
                      onChange={e => set(p.key, e.target.checked)}
                    />
                    {p.label}
                  </label>
                ))}
              </div>
              {ledgerImplicit && <p className="text-xs text-gray-400 mt-2">{tr('المدير الذي يملك إدارة المستخدمين يملك صلاحيات الدفاتر كاملة')}</p>}
            </div>
          )}
          {isSelf && <p className="text-xs text-amber-600">{tr('لا يمكنك تعطيل حسابك أو تغيير دورك من هذه النافذة')}</p>}
          {err && <p className="text-[#C0392B] text-xs">{err}</p>}
        </div>

        <div className="flex-shrink-0 p-5 border-t border-[#E9E1D3] flex gap-3">
          <button type="submit" disabled={loading} className="btn-primary flex-1 justify-center py-2.5">
            {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Check size={16} />}
            {user ? tr('حفظ التعديلات') : tr('إضافة المستخدم')}
          </button>
          <button type="button" onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
        </div>
      </form>
    </div>
  );
}

/** صفّ توريد كما يردّه الخادم — `photos` معرّفاتٌ بلا محتوى (المحتوى بمساره). */
type Settlement = {
  id: string; amount: number; method?: string | null; note?: string | null;
  receivedBy?: string | null; settledAt: string; photos?: { id: string }[];
};

/**
 * استلام (توريد) عهدة مستخدم — **توريدٌ نهائيّ** (قرار المالك): المبلغ يخرج من
 * النظام إلى الخزنة/البنك ولا يدخل عهدة المستلِم. على نسق نافذة استلام المندوب:
 * بطاقات الأرصدة، مبلغٌ معبّأ بالمتبقّي، نوع الاستلام، مرفقات، ثم سجلّ التوريدات.
 */
function UserCustodyModal({ user, isCompanyAdmin, onClose, onDone }: {
  user: CompanyUser; isCompanyAdmin: boolean; onClose: () => void; onDone: () => void;
}) {
  const tr = useTr();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('CASH');
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [touched, setTouched] = useState(false); // لمس المستخدمُ حقلَ المبلغ؟
  const [err, setErr] = useState('');
  const [viewing, setViewing] = useState<string | null>(null); // سجلّ التوريد المعروضة صوره
  const [deletingS, setDeletingS] = useState<Settlement | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['user-custody', user.id],
    queryFn: async () => {
      const r = await companyUserApi.custody(user.id);
      return r.data.data as { received: number; delivered: number; outstanding: number };
    },
  });
  const logQ = useQuery({
    queryKey: ['user-settlements', user.id],
    queryFn: async () => {
      const r = await companyUserApi.settlements(user.id);
      return r.data.data as Settlement[];
    },
  });

  /* تعبئة المبلغ بالمتبقّي ما لم يلمس المستخدمُ الحقل.
   *
   * وكان الشرط علماً يُرفع مرّةً (`filled`): فبعد توريدٍ ناجح يُخفَض ويُعاد
   * الملء **بالرصيد القديم** — لأنّ react-query يُبقي البيانات السابقة أثناء
   * إعادة الجلب — فيقرأ المستلِم رقماً سُدّد للتوّ والزرّ مقفلٌ عليه. */
  const outstanding = data?.outstanding ?? 0;
  useEffect(() => {
    if (!touched) setAmount(outstanding > 0 ? String(outstanding) : '');
  }, [outstanding, touched]);

  const settle = useMutation({
    mutationFn: async () => {
      const r = await companyUserApi.settle(user.id, {
        amount: Number(amount), method,
        ...(note.trim() && { note: note.trim() }),
        ...(photos.length && { photos }),
      });
      return r.data.data;
    },
    onSuccess: async () => {
      toast.success(tr('تم تسجيل الاستلام'));
      setNote(''); setPhotos([]); setMethod('CASH'); setErr('');
      // الترتيب مقصود: يُنتظر الرصيد الجديد **ثمّ** يُفتح قفل التعبئة
      await Promise.all([refetch(), logQ.refetch()]);
      setTouched(false);
      onDone();
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر تسجيل الاستلام');
      setErr(msg); toast.error(msg);
    },
  });

  // حذف توريدٍ سُجِّل خطأً — يعيد مبلغه إلى العهدة. لمدير الشركة وحده (والخادم يفرضه)
  const removeSettlement = useMutation({
    mutationFn: (s: Settlement) => companyUserApi.deleteSettlement(user.id, s.id),
    onSuccess: async () => {
      toast.success(tr('تم حذف التوريد'));
      setDeletingS(null);
      await Promise.all([refetch(), logQ.refetch()]);
      setTouched(false);
      onDone();
    },
    onError: (e: unknown) => {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر حذف التوريد'));
    },
  });

  const pickPhotos = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const f of files) {
      if (photos.length >= 4) break;
      try { const url = await compressImage(f); setPhotos(p => (p.length < 4 ? [...p, url] : p)); }
      catch { /* ملفٌ تالف يُتجاهل ولا يُسقط البقيّة */ }
    }
  };

  const amt = Number(amount) || 0;
  // الهامش نصف هللة — يطابق `CUSTODY_EPS` في الخادم. نصف ريال كان يُمرّر من
  // الواجهة مبلغاً يردّه الخادم، فيرى المستلِم زرّاً مفعّلاً ورفضاً بعد الضغط.
  const ready = amt > 0 && amt <= outstanding + 0.005 && !settle.isPending;
  const methods: [string, string][] = [['CASH', 'نقدي'], ['BANK_TRANSFER', 'تحويل'], ['POS', 'شبكة'], ['CHEQUE', 'شيك']];
  const methodLabel = (m?: string | null) => (methods.find(([v]) => v === m) || methods[0])[1];

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[calc(100dvh-2rem)] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex-shrink-0 flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#E9F6EF] text-[#2F855A] flex items-center justify-center"><Banknote size={18} /></div>
            <div>
              <h2 className="text-base font-bold text-[#1F1A13]">{tr('استلام تحصيل')}</h2>
              <p className="text-xs text-[#6E6557]">{user.name}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          {isLoading ? (
            <p className="text-center text-gray-400 py-6">{tr('جاري التحميل')}</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl border border-[#E9E1D3] p-3">
                <p className="text-[11px] text-[#6E6557]">{tr('استلمه من المناديب')}</p>
                <p className="font-bold text-sm">{formatCurrency(data?.received ?? 0)}</p>
              </div>
              <div className="rounded-xl border border-[#E9E1D3] p-3">
                <p className="text-[11px] text-[#6E6557]">{tr('ورّده سابقا')}</p>
                <p className="font-bold text-sm">{formatCurrency(data?.delivered ?? 0)}</p>
              </div>
              {/* الرصيد السالب (وُرّد أكثر ممّا استُلم) خللٌ يُعرض لا يُخفى */}
              <div className={`rounded-xl border-2 p-3 ${outstanding < -0.004 ? 'border-[#C0392B] bg-[#FDECEA]' : 'border-[#2F855A] bg-[#E9F6EF]'}`}>
                <p className={`text-[11px] ${outstanding < -0.004 ? 'text-[#C0392B]' : 'text-[#2F855A]'}`}>{tr('العهدة المتبقية')}</p>
                <p className={`font-bold text-sm ${outstanding < -0.004 ? 'text-[#C0392B]' : 'text-[#2F855A]'}`}>{formatCurrency(outstanding)}</p>
              </div>
            </div>
          )}

          <div>
            <label className="label">{tr('المبلغ المستلم من المستخدم')}</label>
            <input type="number" step="0.01" dir="ltr" className="input text-lg font-bold text-center"
              value={amount} onChange={e => { setAmount(e.target.value); setTouched(true); setErr(''); }} placeholder="0.00" />
            <p className="text-[11px] text-[#9A8F7E] mt-1">
              {outstanding > 0.004
                ? tr('المبلغ معبأ بالعهدة المتبقية تسليم كامل عدله للتسليم الجزئي')
                : tr('لا عهدة متبقية لدى هذا المستخدم السجل أدناه يوضح توريداته')}
            </p>
          </div>

          <div>
            <label className="label">{tr('نوع الاستلام')}</label>
            <select className="input" value={method} onChange={e => setMethod(e.target.value)}>
              {methods.map(([v, l]) => <option key={v} value={v}>{tr(l)}</option>)}
            </select>
          </div>

          <div>
            <label className="label">{tr('مرفقات')} ({photos.length}/4)</label>
            <div className="flex flex-wrap gap-2">
              {photos.map((p, i) => (
                <span key={i} className="relative w-[72px] h-[72px] rounded-xl overflow-hidden border border-gray-200">
                  <img src={p} alt="" className="w-full h-full object-cover" />
                  <button type="button" onClick={() => setPhotos(prev => prev.filter((_, j) => j !== i))}
                    aria-label={tr('حذف الصورة')} className="absolute top-0.5 left-0.5 bg-black/60 text-white rounded-full w-6 h-6 flex items-center justify-center"><X size={13} /></button>
                </span>
              ))}
              {photos.length < 4 && (
                <label className="w-[72px] h-[72px] rounded-xl border-2 border-dashed border-gray-300 text-gray-400 flex flex-col items-center justify-center gap-1 cursor-pointer hover:bg-gray-50">
                  <input type="file" accept="image/*" multiple className="hidden" onChange={pickPhotos} />
                  <ImageIcon size={18} />
                  <span className="text-[10px]">{tr('إضافة صورة')}</span>
                </label>
              )}
            </div>
            <p className="text-[11px] text-[#9A8F7E] mt-1.5">{tr('أرفق إيصال التحويل أو صورة الشيك حتى 4 صور')}</p>
          </div>

          <div>
            <label className="label">{tr('ملاحظة اختياري')}</label>
            <input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder={tr('مثال نقدا تحويل بنكي')} />
          </div>

          {err && <p className="text-[#C0392B] text-xs">{err}</p>}

          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-2">{tr('سجل الاستلامات')}</h3>
            {logQ.isLoading ? (
              <p className="text-xs text-gray-400">{tr('جاري التحميل')}</p>
            ) : logQ.data?.length ? (
              <div className="rounded-xl border border-[#F1EBDF] divide-y divide-[#F1EBDF]">
                {logQ.data.map(row => (
                  <div key={row.id} className="p-2.5 text-xs flex items-center justify-between gap-2">
                    <span className="min-w-0">
                      <b className="text-[#1F1A13]">{formatCurrency(row.amount)}</b>
                      <span className="text-[#9A8F7E]"> · {tr(methodLabel(row.method))}</span>
                      <span className="text-[#9A8F7E]"> · {formatDate(row.settledAt)}</span>
                      {row.receivedBy && <span className="text-[#9A8F7E]"> · {tr('استلمه')} {row.receivedBy}</span>}
                      {row.note && <span className="block text-[#6E6557] truncate">{row.note}</span>}
                    </span>
                    <span className="flex items-center gap-1 flex-shrink-0">
                      {/* الصور تُجلب عند فتح العارض وحده — السجلّ يحمل معرّفاتها فقط */}
                      {!!row.photos?.length && (
                        <button type="button" onClick={() => setViewing(row.id)} title={tr('عرض المرفقات')}
                          className="px-1.5 py-1 rounded hover:bg-gray-100 text-[#6E6557] flex items-center gap-0.5">
                          <ImageIcon size={13} />{row.photos.length}
                        </button>
                      )}
                      {isCompanyAdmin && (
                        <button type="button" onClick={() => setDeletingS(row)} title={tr('حذف التوريد')}
                          className="p-1 rounded hover:bg-red-50 text-red-600"><Trash2 size={13} /></button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-400">{tr('لا استلامات')}</p>
            )}
          </div>
        </div>

        <div className="flex-shrink-0 p-5 border-t border-[#E9E1D3] flex gap-3">
          <button onClick={() => settle.mutate()} disabled={!ready}
            className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
            {settle.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Banknote size={16} />}
            {tr('تسجيل الاستلام')}
          </button>
          <button type="button" onClick={onClose} className="btn-secondary">{tr('إغلاق')}</button>
        </div>
      </div>

      {viewing && <SettlementPhotos userId={user.id} settlementId={viewing} onClose={() => setViewing(null)} />}

      {deletingS && (
        <ConfirmDialog
          danger
          title={tr('حذف التوريد')}
          message={`${tr('سيحذف سجل توريد بمبلغ')} ${formatCurrency(deletingS.amount)} ${tr('ويعود المبلغ إلى عهدة المستخدم ويسجل إشعار بذلك')}`}
          confirmLabel={tr('حذف نهائي')}
          loading={removeSettlement.isPending}
          onConfirm={() => removeSettlement.mutate(deletingS)}
          onClose={() => setDeletingS(null)}
        />
      )}
    </div>
  );
}

/** عارض صور إثبات توريدٍ واحد — تُجلب عند الفتح فقط (انظر سجلّ التوريدات). */
function SettlementPhotos({ userId, settlementId, onClose }: { userId: string; settlementId: string; onClose: () => void }) {
  const tr = useTr();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['user-settlement-photos', userId, settlementId],
    queryFn: async () => {
      const r = await companyUserApi.settlementPhotos(userId, settlementId);
      return r.data.data as { id: string; data: string }[];
    },
  });
  return (
    <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[calc(100dvh-2rem)] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-[#E9E1D3]">
          <h3 className="font-bold text-sm text-[#1F1A13]">{tr('مرفقات التوريد')}</h3>
          <button type="button" onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          {isLoading && <p className="text-center text-gray-400 text-sm py-6">{tr('جاري التحميل')}</p>}
          {isError && <p className="text-center text-[#C0392B] text-sm py-6">{tr('تعذر تحميل المرفقات')}</p>}
          {data?.map(p => <img key={p.id} src={p.data} alt="" className="w-full rounded-xl border border-[#E9E1D3]" />)}
        </div>
      </div>
    </div>
  );
}

function CredentialsModal({ creds, onClose }: { creds: { name: string; email: string; password: string }; onClose: () => void }) {
  const tr = useTr();
  const [copied, setCopied] = useState(false);
  const text = `${tr('دخول لوحة الإدارة')}\n${tr('البريد')}: ${creds.email}\n${tr('كلمة المرور')}: ${creds.password}`;
  const copy = () => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-[#E9E1D3] flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-green-100 text-green-600 flex items-center justify-center"><Check size={18} /></div>
          <div>
            <h2 className="font-bold text-[#1F1A13]">{tr('تم إنشاء المستخدم')}</h2>
            <p className="text-xs text-gray-500">{creds.name}</p>
          </div>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-xs text-[#9C4423] bg-[#FBEBE2] rounded-lg px-3 py-2">{tr('سلم بيانات الدخول لصاحب الحساب لن تظهر كلمة المرور مرة أخرى')}</p>
          <div className="bg-gray-50 rounded-xl p-3 space-y-2 text-sm">
            <div className="flex justify-between gap-3"><span className="text-gray-500">{tr('البريد')}</span><span className="font-mono" dir="ltr">{creds.email}</span></div>
            <div className="flex justify-between gap-3"><span className="text-gray-500">{tr('كلمة المرور')}</span><span className="font-mono font-bold" dir="ltr">{creds.password}</span></div>
          </div>
          <div className="flex gap-3">
            <button onClick={copy} className="btn-primary flex-1 justify-center py-2.5"><Copy size={15} />{copied ? tr('تم النسخ') : tr('نسخ البيانات')}</button>
            <button onClick={onClose} className="btn-secondary">{tr('تم')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
