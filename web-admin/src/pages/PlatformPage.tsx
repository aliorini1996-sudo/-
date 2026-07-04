import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { tenantApi } from '../api/client';
import { Tenant } from '../types';
import { formatDate, formatCurrency } from '../utils/format';
import { useAuthStore } from '../store/authStore';
import {
  Building2, Plus, LogOut, Power, Users, FileText,
  CheckCircle2, Copy, Check, X, Calendar, LogIn, Trash2, KeyRound, AlertTriangle,
  BarChart3, TrendingUp, Wallet, RotateCcw, Package, Trophy, Pencil, Globe, Globe2, Target, Sparkles, Video, ReceiptText,
} from 'lucide-react';
import toast from 'react-hot-toast';
import ChangePasswordModal from '../components/ChangePasswordModal';
import ResetPasswordModal from '../components/ResetPasswordModal';
import SiteContentEditor from '../components/SiteContentEditor';
import SeoDashboard from '../components/SeoDashboard';
import GeoDashboard from '../components/GeoDashboard';
import VisitsPanel from '../components/VisitsPanel';
import LeadsPanel from '../components/LeadsPanel';
import InvoiceToolPanel from '../components/InvoiceToolPanel';
import PromoVideosPanel from '../components/PromoVideosPanel';
import { BrandIcon } from '../components/BrandLogo';
import LanguageToggle from '../components/LanguageToggle';
import { useTr } from '../i18n/strings';

export default function PlatformPage() {
  const tr = useTr();
  const qc = useQueryClient();
  const { user, logout, impersonate } = useAuthStore();
  const [showCreate, setShowCreate] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showContent, setShowContent] = useState(false);
  const [showSeo, setShowSeo] = useState(false);
  const [showGeo, setShowGeo] = useState(false);
  const [showVisits, setShowVisits] = useState(false);
  const [showLeads, setShowLeads] = useState(false);
  const [showInvoiceTool, setShowInvoiceTool] = useState(false);
  const [showPromoVideos, setShowPromoVideos] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Tenant | null>(null);
  const [perfTarget, setPerfTarget] = useState<Tenant | null>(null);
  const [editTarget, setEditTarget] = useState<Tenant | null>(null);
  const [resetTarget, setResetTarget] = useState<Tenant | null>(null);
  const [createdInfo, setCreatedInfo] = useState<{ company: string; email: string; password: string } | null>(null);

  const { data: tenants, isLoading } = useQuery({
    queryKey: ['tenants'],
    queryFn: async () => { const res = await tenantApi.list(); return res.data.data as Tenant[]; },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => tenantApi.update(id, { isActive }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tenants'] }); toast.success(tr('تم تحديث حالة الاشتراك')); },
    onError: () => toast.error(tr('حدث خطأ')),
  });

  // دخول المالك إلى لوحة الشركة (للاطلاع على بياناتها)
  const enterMutation = useMutation({
    mutationFn: (id: string) => tenantApi.impersonate(id),
    onSuccess: (res) => {
      const { token, user: companyUser } = res.data.data;
      impersonate(token, companyUser, companyUser.companyName);
      // إعادة تحميل كاملة على لوحة الأدمن لتجنّب إعادة تقييم حارس المالك أثناء تبديل الهوية
      window.location.href = '/app';
    },
    onError: (err: unknown) => toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذّر الدخول للشركة')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => tenantApi.remove(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tenants'] }); toast.success(tr('تم حذف الشركة')); setDeleteTarget(null); },
    onError: () => toast.error(tr('تعذّر حذف الشركة')),
  });

  const handleLogout = () => { logout(); window.location.replace('/owner'); };

  const activeCount = tenants?.filter(t => t.isActive).length ?? 0;
  const totalReps = tenants?.reduce((s, t) => s + (t._count?.salesReps ?? 0), 0) ?? 0;
  const totalInvoices = tenants?.reduce((s, t) => s + (t._count?.invoices ?? 0), 0) ?? 0;

  const subStatus = (t: Tenant) => {
    if (!t.isActive) return { label: tr('موقوف'), cls: 'bg-red-100 text-red-700' };
    if (t.subscriptionEndsAt && new Date(t.subscriptionEndsAt).getTime() < Date.now()) return { label: tr('منتهٍ'), cls: 'bg-amber-100 text-amber-700' };
    return { label: tr('نشط'), cls: 'bg-green-100 text-green-700' };
  };

  return (
    <div className="h-screen flex overflow-hidden bg-[#FAF7F0]" dir="rtl">
      {/* Sidebar — بنفس نمط لوحة الأدمن */}
      <aside className="w-60 flex-shrink-0 bg-[#1F1A13] text-white flex flex-col">
        {/* الشعار */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-white/10">
          <BrandIcon size={36} radius={0.28} />
          <div>
            <p className="text-sm leading-tight" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 700 }}>
              <span className="text-[#FAF7F0]">Field</span><span className="text-[#E15A30]"> Sales</span>
            </p>
            <p className="text-[#9A8F7E] text-xs">{tr('لوحة المالك')}</p>
          </div>
        </div>

        {/* روابط التنقّل */}
        <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
          <button onClick={() => setShowLeads(true)} className="sidebar-link w-full text-[#E15A30] hover:bg-[#E15A30]/15 hover:text-[#f0703f]">
            <Target size={18} className="flex-shrink-0" /> <span>{tr('العملاء المحتملون')}</span>
          </button>
          <button onClick={() => setShowInvoiceTool(true)} className="sidebar-link w-full text-[#7ED9A9] hover:bg-[#1E7A52]/20 hover:text-[#9fe7c0]">
            <ReceiptText size={18} className="flex-shrink-0" /> <span>{tr('عملاء مولّد الفواتير')}</span>
          </button>
          <button onClick={() => setShowPromoVideos(true)} className="sidebar-link w-full">
            <Video size={18} className="flex-shrink-0" /> <span>{tr('الفيديوهات الترويجية')}</span>
          </button>
          <button onClick={() => setShowContent(true)} className="sidebar-link w-full">
            <Globe size={18} className="flex-shrink-0" /> <span>{tr('محتوى الصفحة')}</span>
          </button>
          <button onClick={() => setShowSeo(true)} className="sidebar-link w-full">
            <TrendingUp size={18} className="flex-shrink-0" /> <span>{tr('متابعة SEO')}</span>
          </button>
          <button onClick={() => setShowGeo(true)} className="sidebar-link w-full">
            <Sparkles size={18} className="flex-shrink-0" /> <span>{tr('متابعة GEO')}</span>
          </button>
          <button onClick={() => setShowVisits(true)} className="sidebar-link w-full">
            <Globe2 size={18} className="flex-shrink-0" /> <span>{tr('زيارات الموقع')}</span>
          </button>
          <a
            href="/portfolio"
            target="_blank"
            rel="noopener noreferrer"
            className="sidebar-link w-full"
          >
            <Wallet size={18} className="flex-shrink-0" /> <span>{tr('محفظتي')}</span>
          </a>
        </nav>

        {/* المستخدم + اللغة + كلمة المرور + الخروج */}
        <div className="p-2 border-t border-white/10 space-y-1">
          <div className="px-2"><LanguageToggle variant="dark" /></div>
          <div className="px-4 py-1.5">
            <p className="text-xs text-[#9A8F7E] leading-tight">{tr('مالك المنصّة')}</p>
            <p className="text-sm font-semibold truncate leading-tight">{user?.name}</p>
          </div>
          <button onClick={() => setShowPassword(true)} className="sidebar-link w-full">
            <KeyRound size={18} className="flex-shrink-0" /> <span>{tr('كلمة المرور')}</span>
          </button>
          <button onClick={handleLogout} className="sidebar-link w-full text-red-300 hover:bg-red-500/20 hover:text-red-200">
            <LogOut size={18} className="flex-shrink-0" /> <span>{tr('خروج')}</span>
          </button>
        </div>
      </aside>

      {/* المحتوى الرئيسي */}
      <main className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatBox icon={Building2} label={tr('إجمالي الشركات')} value={String(tenants?.length ?? 0)} color="bg-[#E15A30]" />
          <StatBox icon={CheckCircle2} label={tr('اشتراكات نشطة')} value={String(activeCount)} color="bg-green-500" />
          <StatBox icon={Users} label={tr('إجمالي المناديب')} value={String(totalReps)} color="bg-purple-500" />
          <StatBox icon={FileText} label={tr('إجمالي الفواتير')} value={String(totalInvoices)} color="bg-orange-500" />
        </div>

        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-800">{tr('الشركات المشتركة')}</h2>
          <button onClick={() => setShowCreate(true)} className="btn-primary"><Plus size={16} /> {tr('إضافة شركة')}</button>
        </div>

        {/* Tenants list */}
        <div className="card p-0 overflow-hidden">
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>{tr('الشركة')}</th><th>{tr('المدير')}</th>
                  <th className="text-center">{tr('مستخدمي الشركة')}</th>
                  <th className="text-center">{tr('المناديب المسموح')}</th>
                  <th className="text-center">{tr('مناديب')}</th>
                  <th className="text-center">{tr('عملاء')}</th>
                  <th>{tr('انتهاء الاشتراك')}</th><th>{tr('الحالة')}</th><th>{tr('إجراءات')}</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={9} className="text-center py-12 text-gray-400">{tr('جاري التحميل...')}</td></tr>
                ) : tenants?.length === 0 ? (
                  <tr><td colSpan={9} className="text-center py-12 text-gray-400">{tr('لا توجد شركات — أضف أول شركة')}</td></tr>
                ) : tenants?.map(t => {
                  const st = subStatus(t);
                  return (
                    <tr key={t.id}>
                      <td>
                        <p className="font-semibold text-gray-800">{t.name}</p>
                        <p className="text-xs text-gray-400">{formatDate(t.createdAt)}</p>
                      </td>
                      <td className="text-sm text-gray-600">{t.admins?.[0]?.email || '-'}</td>
                      <td className="text-center">
                        {t.maxAdminUsers == null
                          ? <span className="badge-active">{tr('غير محدود')}</span>
                          : <span className="font-semibold text-gray-700">{t._count?.admins ?? 0} / {t.maxAdminUsers}</span>}
                      </td>
                      <td className="text-center">
                        {t.maxSalesReps == null
                          ? <span className="badge-active">{tr('غير محدود')}</span>
                          : <span className="font-semibold text-gray-700">{t.maxSalesReps}</span>}
                      </td>
                      <td className="text-center text-gray-600">{t._count?.salesReps ?? 0}</td>
                      <td className="text-center text-gray-600">{t._count?.customers ?? 0}</td>
                      <td className="text-sm text-gray-500">{t.subscriptionEndsAt ? formatDate(t.subscriptionEndsAt) : tr('غير محدود')}</td>
                      <td><span className={`px-2 py-1 rounded-full text-xs font-medium ${st.cls}`}>{st.label}</span></td>
                      <td>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => enterMutation.mutate(t.id)}
                            disabled={enterMutation.isPending}
                            className="flex items-center gap-1 text-xs bg-[#E15A30] hover:bg-[#C94E28] text-white rounded-lg px-2.5 py-1.5 font-semibold"
                            title={tr('الدخول إلى لوحة الشركة والاطلاع على بياناتها')}>
                            <LogIn size={13} /> {tr('دخول')}
                          </button>
                          <button
                            onClick={() => setPerfTarget(t)}
                            className="p-1.5 rounded text-[#1E7A52] hover:bg-green-50"
                            title={tr('أداء الشركة')}>
                            <BarChart3 size={15} />
                          </button>
                          <button
                            onClick={() => setEditTarget(t)}
                            className="p-1.5 rounded text-[#C94E28] hover:bg-[#FBEBE2]"
                            title={tr('تعديل الشركة (عدد المناديب والاشتراك)')}>
                            <Pencil size={15} />
                          </button>
                          <button
                            onClick={() => setResetTarget(t)}
                            className="p-1.5 rounded text-amber-600 hover:bg-amber-50"
                            title={tr('إعادة تعيين كلمة مرور مدير الشركة')}>
                            <KeyRound size={15} />
                          </button>
                          <button
                            onClick={() => toggleMutation.mutate({ id: t.id, isActive: !t.isActive })}
                            className={`p-1.5 rounded ${t.isActive ? 'text-red-500 hover:bg-red-50' : 'text-green-600 hover:bg-green-50'}`}
                            title={t.isActive ? tr('إيقاف الاشتراك') : tr('تفعيل الاشتراك')}>
                            <Power size={15} />
                          </button>
                          <button
                            onClick={() => setDeleteTarget(t)}
                            className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"
                            title={tr('حذف الشركة نهائياً')}>
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
      </main>

      {showCreate && (
        <CreateTenantModal
          onClose={() => setShowCreate(false)}
          onCreated={(info) => { setShowCreate(false); setCreatedInfo(info); qc.invalidateQueries({ queryKey: ['tenants'] }); }}
        />
      )}
      {createdInfo && <CredentialsModal info={createdInfo} onClose={() => setCreatedInfo(null)} />}
      {perfTarget && <PerformanceModal tenant={perfTarget} onClose={() => setPerfTarget(null)} />}
      {editTarget && (
        <EditTenantModal
          tenant={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => { setEditTarget(null); qc.invalidateQueries({ queryKey: ['tenants'] }); }}
        />
      )}
      {resetTarget && (
        <ResetPasswordModal
          title={tr('إعادة تعيين كلمة مرور مدير الشركة')}
          subject={`${resetTarget.name} · ${resetTarget.admins?.[0]?.email || tr('المدير الرئيسي')}`}
          onConfirm={async (newPassword) => { await tenantApi.resetAdmin(resetTarget.id, { newPassword }); }}
          onClose={() => setResetTarget(null)}
        />
      )}
      {showLeads && <LeadsPanel onClose={() => setShowLeads(false)} />}
      {showInvoiceTool && <InvoiceToolPanel onClose={() => setShowInvoiceTool(false)} />}
      {showPromoVideos && <PromoVideosPanel onClose={() => setShowPromoVideos(false)} />}
      {showContent && <SiteContentEditor onClose={() => setShowContent(false)} />}
      {showSeo && <SeoDashboard onClose={() => setShowSeo(false)} />}
      {showGeo && <GeoDashboard onClose={() => setShowGeo(false)} />}
      {showVisits && <VisitsPanel onClose={() => setShowVisits(false)} />}
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
  const tr = useTr();
  const [confirmText, setConfirmText] = useState('');
  const matches = confirmText.trim() === tenant.name.trim();
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="p-6 text-center border-b border-gray-100">
          <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
            <AlertTriangle size={28} className="text-red-600" />
          </div>
          <h2 className="text-lg font-bold text-gray-800">{tr('حذف الشركة نهائياً')}</h2>
          <p className="text-sm text-gray-500 mt-1">{tenant.name}</p>
        </div>
        <div className="p-6 space-y-4">
          <div className="bg-red-50 text-red-700 rounded-lg px-3 py-2.5 text-xs leading-relaxed">
            {tr('تحذير: سيُحذف كل شيء يخص هذه الشركة نهائياً — المدير، المناديب، العملاء، المنتجات، الفواتير، السندات. لا يمكن التراجع.')}
          </div>
          <div>
            <label className="label">{tr('اكتب اسم الشركة للتأكيد:')}</label>
            <input className="input" value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder={tenant.name} />
          </div>
        </div>
        <div className="flex gap-3 p-6 pt-0">
          <button onClick={onConfirm} disabled={!matches || loading}
            className="flex-1 justify-center py-2.5 rounded-xl bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white font-semibold flex items-center gap-2">
            {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Trash2 size={15} />}
            {tr('حذف نهائي')}
          </button>
          <button onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}

// بيانات أداء الشركة من الخادم
interface PerfData {
  company: { name: string; plan: string; isActive: boolean; subscriptionEndsAt: string | null; createdAt: string };
  counts: { customers: number; products: number; salesReps: number };
  invoicesCount: number;
  salesTotal: number;
  returnsCount: number;
  returnsTotal: number;
  receiptsCount: number;
  collectionsTotal: number;
  topReps: { id: string; name: string; invoicesCount: number; salesTotal: number }[];
}

// نافذة أداء عمل الشركة — للسوبر أدمن
function PerformanceModal({ tenant, onClose }: { tenant: Tenant; onClose: () => void }) {
  const tr = useTr();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['tenant-performance', tenant.id],
    queryFn: async () => { const res = await tenantApi.performance(tenant.id); return res.data.data as PerfData; },
  });

  const netSales = (data?.salesTotal ?? 0) - (data?.returnsTotal ?? 0);
  const outstanding = netSales - (data?.collectionsTotal ?? 0);
  const collectionRate = netSales > 0 ? Math.round(((data?.collectionsTotal ?? 0) / netSales) * 100) : 0;
  const maxRepSales = Math.max(1, ...(data?.topReps ?? []).map(r => r.salesTotal));

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3] sticky top-0 bg-white rounded-t-2xl">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 bg-[#FBEBE2] rounded-xl flex items-center justify-center">
              <BarChart3 size={22} className="text-[#E15A30]" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13]">{tr('أداء الشركة')}</h2>
              <p className="text-sm text-[#6E6557]">{tenant.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        {isLoading ? (
          <div className="py-16 text-center text-gray-400">{tr('جاري تحميل بيانات الأداء...')}</div>
        ) : isError || !data ? (
          <div className="py-16 text-center text-red-500">{tr('تعذّر تحميل بيانات الأداء')}</div>
        ) : (
          <div className="p-5 space-y-5">
            {/* المؤشرات المالية */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <PerfCard icon={TrendingUp} label={tr('صافي المبيعات')} value={formatCurrency(netSales)} color="text-[#E15A30]" bg="bg-[#FBEBE2]" />
              <PerfCard icon={Wallet} label={tr('إجمالي التحصيل')} value={formatCurrency(data.collectionsTotal)} color="text-[#1E7A52]" bg="bg-green-50" />
              <PerfCard icon={FileText} label={tr('المتبقي على العملاء')} value={formatCurrency(outstanding)} color="text-amber-600" bg="bg-amber-50" />
              <PerfCard icon={RotateCcw} label={tr('المرتجعات')} value={formatCurrency(data.returnsTotal)} color="text-red-500" bg="bg-red-50" />
            </div>

            {/* نسبة التحصيل */}
            <div className="bg-[#FAF7F0] rounded-xl p-4 border border-[#E9E1D3]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-[#1F1A13]">{tr('نسبة التحصيل من صافي المبيعات')}</span>
                <span className="text-sm font-bold text-[#1E7A52]">{collectionRate}%</span>
              </div>
              <div className="w-full h-2.5 bg-[#E9E1D3] rounded-full overflow-hidden">
                <div className="h-full bg-[#1E7A52] rounded-full transition-all" style={{ width: `${Math.min(100, collectionRate)}%` }} />
              </div>
            </div>

            {/* عدّادات النشاط */}
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
              <CountChip icon={Users} label={tr('مناديب')} value={data.counts.salesReps} />
              <CountChip icon={Building2} label={tr('عملاء')} value={data.counts.customers} />
              <CountChip icon={Package} label={tr('منتجات')} value={data.counts.products} />
              <CountChip icon={FileText} label={tr('فواتير')} value={data.invoicesCount} />
              <CountChip icon={Wallet} label={tr('سندات')} value={data.receiptsCount} />
            </div>

            {/* أفضل المناديب */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Trophy size={16} className="text-[#E15A30]" />
                <h3 className="text-sm font-bold text-[#1F1A13]">{tr('أفضل المناديب أداءً')}</h3>
              </div>
              {data.topReps.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">{tr('لا يوجد مناديب بعد')}</p>
              ) : (
                <div className="space-y-2.5">
                  {data.topReps.map((r, i) => (
                    <div key={r.id} className="flex items-center gap-3">
                      <span className={`w-6 h-6 shrink-0 rounded-full text-xs font-bold flex items-center justify-center ${i === 0 ? 'bg-[#E15A30] text-white' : 'bg-[#FBEBE2] text-[#C94E28]'}`}>{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium text-[#1F1A13] truncate">{r.name}</span>
                          <span className="text-sm font-bold text-[#1F1A13]">{formatCurrency(r.salesTotal)}</span>
                        </div>
                        <div className="w-full h-1.5 bg-[#F1EBDF] rounded-full overflow-hidden">
                          <div className="h-full bg-[#E15A30] rounded-full" style={{ width: `${(r.salesTotal / maxRepSales) * 100}%` }} />
                        </div>
                      </div>
                      <span className="text-xs text-gray-400 shrink-0">{r.invoicesCount} {tr('فاتورة')}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <p className="text-[11px] text-gray-400 text-center pt-1">
              {tr('الشركة منشأة في')} {formatDate(data.company.createdAt)}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function PerfCard({ icon: Icon, label, value, color, bg }: { icon: React.ElementType; label: string; value: string; color: string; bg: string }) {
  return (
    <div className="bg-white rounded-xl p-3.5 border border-[#E9E1D3]">
      <div className={`w-9 h-9 ${bg} rounded-lg flex items-center justify-center mb-2`}><Icon size={18} className={color} /></div>
      <p className={`text-base font-bold ${color}`}>{value}</p>
      <p className="text-[11px] text-[#6E6557] mt-0.5">{label}</p>
    </div>
  );
}

function CountChip({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: number }) {
  return (
    <div className="bg-[#FAF7F0] rounded-xl p-3 text-center border border-[#E9E1D3]">
      <Icon size={16} className="text-[#9A8F7E] mx-auto mb-1" />
      <p className="text-lg font-bold text-[#1F1A13]">{value}</p>
      <p className="text-[11px] text-[#6E6557]">{label}</p>
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

// تعديل شركة قائمة — عدد المناديب المسموح وتاريخ انتهاء الاشتراك (للسوبر أدمن)
function EditTenantModal({ tenant, onClose, onSaved }: { tenant: Tenant; onClose: () => void; onSaved: () => void }) {
  const tr = useTr();
  const [unlimitedReps, setUnlimitedReps] = useState(tenant.maxSalesReps == null);
  const [maxSalesReps, setMaxSalesReps] = useState(tenant.maxSalesReps != null ? String(tenant.maxSalesReps) : '');
  const [unlimitedUsers, setUnlimitedUsers] = useState(tenant.maxAdminUsers == null);
  const [maxAdminUsers, setMaxAdminUsers] = useState(tenant.maxAdminUsers != null ? String(tenant.maxAdminUsers) : '');
  const [subscriptionEndsAt, setSubscriptionEndsAt] = useState(
    tenant.subscriptionEndsAt ? new Date(tenant.subscriptionEndsAt).toISOString().slice(0, 10) : ''
  );
  const currentReps = tenant._count?.salesReps ?? 0;
  const currentUsers = tenant._count?.admins ?? 0;

  const mutation = useMutation({
    mutationFn: () => tenantApi.update(tenant.id, {
      maxSalesReps: unlimitedReps ? null : Number(maxSalesReps),
      maxAdminUsers: unlimitedUsers ? null : Number(maxAdminUsers),
      subscriptionEndsAt: subscriptionEndsAt || null,
    }),
    onSuccess: () => { toast.success(tr('تم تحديث بيانات الشركة')); onSaved(); },
    onError: (err: unknown) => toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذّر التحديث')),
  });

  const submit = () => {
    if (!unlimitedReps && (!Number.isInteger(Number(maxSalesReps)) || Number(maxSalesReps) < 1)) {
      toast.error(tr('حدّد عدد مناديب صحيحاً (1 أو أكثر) أو اختر «غير محدود»')); return;
    }
    if (!unlimitedReps && Number(maxSalesReps) < currentReps) {
      toast.error(`${tr('الشركة لديها')} ${currentReps} ${tr('مندوباً حالياً — لا يمكن جعل الحد أقل من ذلك')}`); return;
    }
    if (!unlimitedUsers && (!Number.isInteger(Number(maxAdminUsers)) || Number(maxAdminUsers) < 1)) {
      toast.error(tr('حدّد عدد مستخدمين صحيحاً (1 أو أكثر) أو اختر «غير محدود»')); return;
    }
    if (!unlimitedUsers && Number(maxAdminUsers) < currentUsers) {
      toast.error(`${tr('الشركة لديها')} ${currentUsers} ${tr('مستخدم حالياً — لا يمكن جعل الحد أقل من ذلك')}`); return;
    }
    mutation.mutate();
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#FBEBE2] rounded-xl flex items-center justify-center">
              <Pencil size={18} className="text-[#E15A30]" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13]">{tr('تعديل الشركة')}</h2>
              <p className="text-sm text-[#6E6557]">{tenant.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="label flex items-center gap-1"><Users size={12} /> {tr('عدد المناديب المسموح')}</label>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer shrink-0 select-none">
                <input type="checkbox" className="w-4 h-4 accent-[#E15A30]"
                  checked={unlimitedReps} onChange={e => setUnlimitedReps(e.target.checked)} />
                {tr('غير محدود')}
              </label>
              {!unlimitedReps && (
                <input type="number" min={1} className="input flex-1" placeholder={tr('مثال: 5')} autoFocus
                  value={maxSalesReps} onChange={e => setMaxSalesReps(e.target.value)} />
              )}
            </div>
            <p className="text-xs text-gray-400 mt-1">{tr('المناديب الحاليون:')} {currentReps}</p>
          </div>
          <div>
            <label className="label flex items-center gap-1"><Users size={12} /> {tr('عدد مستخدمي الشركة المسموح')}</label>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer shrink-0 select-none">
                <input type="checkbox" className="w-4 h-4 accent-[#E15A30]"
                  checked={unlimitedUsers} onChange={e => setUnlimitedUsers(e.target.checked)} />
                {tr('غير محدود')}
              </label>
              {!unlimitedUsers && (
                <input type="number" min={1} className="input flex-1" placeholder={tr('مثال: 3')}
                  value={maxAdminUsers} onChange={e => setMaxAdminUsers(e.target.value)} />
              )}
            </div>
            <p className="text-xs text-gray-400 mt-1">{tr('المستخدمون الحاليون:')} {currentUsers}</p>
          </div>
          <div>
            <label className="label flex items-center gap-1"><Calendar size={12} /> {tr('انتهاء الاشتراك')}</label>
            <input type="date" className="input" value={subscriptionEndsAt} onChange={e => setSubscriptionEndsAt(e.target.value)} />
            <p className="text-xs text-gray-400 mt-1">{tr('اتركه فارغاً لاشتراك غير محدود المدة')}</p>
          </div>
        </div>
        <div className="flex gap-3 p-5 border-t border-[#E9E1D3]">
          <button onClick={submit} disabled={mutation.isPending} className="btn-primary flex-1 justify-center py-2.5">
            {mutation.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Check size={16} />}
            {tr('حفظ التعديلات')}
          </button>
          <button onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}

function CreateTenantModal({ onClose, onCreated }: { onClose: () => void; onCreated: (info: { company: string; email: string; password: string }) => void }) {
  const tr = useTr();
  const [form, setForm] = useState({ companyName: '', adminName: '', adminEmail: '', adminPassword: '', maxSalesReps: '', unlimitedReps: true, maxAdminUsers: '', unlimitedUsers: true, subscriptionEndsAt: '' });
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const mutation = useMutation({
    mutationFn: () => tenantApi.create({
      companyName: form.companyName, adminName: form.adminName, adminEmail: form.adminEmail,
      adminPassword: form.adminPassword,
      maxSalesReps: form.unlimitedReps ? null : Number(form.maxSalesReps),
      maxAdminUsers: form.unlimitedUsers ? null : Number(form.maxAdminUsers),
      ...(form.subscriptionEndsAt && { subscriptionEndsAt: form.subscriptionEndsAt }),
    }),
    onSuccess: () => onCreated({ company: form.companyName, email: form.adminEmail, password: form.adminPassword }),
    onError: (err: unknown) => toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('حدث خطأ')),
  });

  const submit = () => {
    if (!form.companyName.trim()) { toast.error(tr('اسم الشركة مطلوب')); return; }
    if (!form.unlimitedReps && (!Number.isInteger(Number(form.maxSalesReps)) || Number(form.maxSalesReps) < 1)) {
      toast.error(tr('حدّد عدد مناديب صحيحاً (1 أو أكثر) أو اختر «غير محدود»')); return;
    }
    if (!form.unlimitedUsers && (!Number.isInteger(Number(form.maxAdminUsers)) || Number(form.maxAdminUsers) < 1)) {
      toast.error(tr('حدّد عدد مستخدمين صحيحاً (1 أو أكثر) أو اختر «غير محدود»')); return;
    }
    if (!form.adminName.trim()) { toast.error(tr('اسم المدير مطلوب')); return; }
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(form.adminEmail)) { toast.error(tr('بريد المدير غير صحيح')); return; }
    if (form.adminPassword.length < 6) { toast.error(tr('كلمة المرور 6 أحرف على الأقل')); return; }
    mutation.mutate();
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="text-lg font-bold text-gray-800">{tr('إضافة شركة مشتركة')}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <p className="text-xs font-semibold text-gray-400 mb-2">{tr('بيانات الشركة')}</p>
            <div className="space-y-3">
              <div>
                <label className="label">{tr('اسم الشركة *')}</label>
                <input className="input" value={form.companyName} onChange={e => set('companyName', e.target.value)} />
              </div>
              <div>
                <label className="label flex items-center gap-1"><Users size={12} /> {tr('عدد المناديب المسموح')}</label>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer shrink-0 select-none">
                    <input type="checkbox" className="w-4 h-4 accent-[#E15A30]"
                      checked={form.unlimitedReps}
                      onChange={e => setForm(f => ({ ...f, unlimitedReps: e.target.checked }))} />
                    {tr('غير محدود')}
                  </label>
                  {!form.unlimitedReps && (
                    <input type="number" min={1} className="input flex-1" placeholder={tr('مثال: 5')} autoFocus
                      value={form.maxSalesReps} onChange={e => set('maxSalesReps', e.target.value)} />
                  )}
                </div>
              </div>
              <div>
                <label className="label flex items-center gap-1"><Users size={12} /> {tr('عدد مستخدمي الشركة المسموح')}</label>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer shrink-0 select-none">
                    <input type="checkbox" className="w-4 h-4 accent-[#E15A30]"
                      checked={form.unlimitedUsers}
                      onChange={e => setForm(f => ({ ...f, unlimitedUsers: e.target.checked }))} />
                    {tr('غير محدود')}
                  </label>
                  {!form.unlimitedUsers && (
                    <input type="number" min={1} className="input flex-1" placeholder={tr('مثال: 3')}
                      value={form.maxAdminUsers} onChange={e => set('maxAdminUsers', e.target.value)} />
                  )}
                </div>
              </div>
              <div>
                <label className="label flex items-center gap-1"><Calendar size={12} /> {tr('انتهاء الاشتراك')}</label>
                <input type="date" className="input" value={form.subscriptionEndsAt} onChange={e => set('subscriptionEndsAt', e.target.value)} title={tr('اتركه فارغاً لاشتراك غير محدود')} />
              </div>
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-gray-400 mb-2">{tr('حساب مدير الشركة')}</p>
            <div className="space-y-3">
              <div>
                <label className="label">{tr('اسم المدير *')}</label>
                <input className="input" value={form.adminName} onChange={e => set('adminName', e.target.value)} />
              </div>
              <div>
                <label className="label">{tr('البريد الإلكتروني (للدخول) *')}</label>
                <input className="input" dir="ltr" value={form.adminEmail} onChange={e => set('adminEmail', e.target.value)} />
              </div>
              <div>
                <label className="label">{tr('كلمة المرور *')}</label>
                <input className="input" dir="ltr" value={form.adminPassword} onChange={e => set('adminPassword', e.target.value)} placeholder={tr('6 أحرف على الأقل')} />
              </div>
            </div>
          </div>
        </div>
        <div className="flex gap-3 p-5 border-t">
          <button onClick={submit} disabled={mutation.isPending} className="btn-primary flex-1 justify-center py-2.5">
            {mutation.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Plus size={16} />}
            {tr('إنشاء الشركة')}
          </button>
          <button onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}

function CredentialsModal({ info, onClose }: { info: { company: string; email: string; password: string }; onClose: () => void }) {
  const tr = useTr();
  const [copied, setCopied] = useState(false);
  const copyAll = () => {
    navigator.clipboard?.writeText(`${tr('شركة')}: ${info.company}
${tr('البريد الإلكتروني')}: ${info.email}
${tr('كلمة المرور')}: ${info.password}`)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="p-6 text-center border-b border-gray-100">
          <div className="w-14 h-14 bg-green-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
            <CheckCircle2 size={28} className="text-green-600" />
          </div>
          <h2 className="text-lg font-bold text-gray-800">{tr('تم إنشاء الشركة')}</h2>
          <p className="text-sm text-gray-500 mt-1">{info.company}</p>
        </div>
        <div className="p-6 space-y-3">
          <p className="text-xs text-[#C94E28] bg-[#FBEBE2] rounded-lg px-3 py-2">{tr('سلّم هذه البيانات لمدير الشركة ليدخل من تبويب «دخول الشركة»')}</p>
          <Row label={tr('البريد الإلكتروني')} value={info.email} />
          <Row label={tr('كلمة المرور')} value={info.password} />
        </div>
        <div className="flex gap-3 p-6 pt-0">
          <button onClick={copyAll} className="btn-secondary flex-1 justify-center">
            {copied ? <Check size={15} className="text-green-600" /> : <Copy size={15} />} {tr('نسخ البيانات')}
          </button>
          <button onClick={onClose} className="btn-primary flex-1 justify-center">{tr('تم')}</button>
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
