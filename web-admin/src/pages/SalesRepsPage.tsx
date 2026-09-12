import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { salesRepApi, invoiceApi, receiptApi, customerApi, companyApi, dailyReportApi } from '../api/client';
import { SalesRep, Invoice, Receipt, Customer } from '../types';
import { Plus, Search, Edit, Check, X as XIcon, Copy, KeyRound, UserCheck, FileBarChart2, Download, Printer, X, Trash2, Banknote, Users, ShieldCheck, Image as ImageIcon, ClipboardList } from 'lucide-react';
import toast from 'react-hot-toast';
import SalesRepModal from '../components/forms/SalesRepModal';
import ResetPasswordModal from '../components/ResetPasswordModal';
import ConfirmDialog from '../components/ConfirmDialog';
import { formatCurrency, formatDate, formatTime, formatNumber, statusLabels, paymentMethodLabels, getActiveCurrency } from '../utils/format';
import { currencyDecimals } from '../i18n/countries';
import { useTr } from '../i18n/strings';
import { shareOrDownloadExcel, num } from '../utils/excel';
import { useAuthStore } from '../store/authStore';
import DocumentModal from '../components/DocumentModal';
import { settlementLogDocFromData, Company } from '../rep/RepDocuments';
// الوحدة المشتركة وحدها — حدّاها (١٢٨٠px وجودة ٠٫٧) مُعايَران ليقعا تحت سقف الخادم
import { compressImage } from '../rep/imageCompress';
import { useAccountingOn } from '../components/AccountingGate';

interface Creds { name: string; username: string; password: string; }

export default function SalesRepsPage() {
  const qc = useQueryClient();
  const tr = useTr();
  const { user } = useAuthStore();
  const isMainAdmin = user?.role === 'ADMIN'; // حذف المندوب للأدمن الرئيسي فقط
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [selected, setSelected] = useState<SalesRep | null>(null);
  const [createdCreds, setCreatedCreds] = useState<Creds | null>(null);
  const [statementRep, setStatementRep] = useState<SalesRep | null>(null);
  const [resetRep, setResetRep] = useState<SalesRep | null>(null);
  const [deleting, setDeleting] = useState<SalesRep | null>(null);
  const [collectRep, setCollectRep] = useState<SalesRep | null>(null);
  const [assignRep, setAssignRep] = useState<SalesRep | null>(null); // نافذة إسناد العملاء
  const [historyRep, setHistoryRep] = useState<SalesRep | null>(null); // سجلّ التقارير اليومية

  const { data, isLoading } = useQuery({
    queryKey: ['sales-reps', search],
    queryFn: async () => {
      const res = await salesRepApi.list({ search, limit: 50 });
      return res.data.data as SalesRep[];
    },
  });

  const saveMutation = useMutation({
    mutationFn: (values: Partial<SalesRep> & { password?: string }) =>
      selected ? salesRepApi.update(selected.id, values) : salesRepApi.create(values),
    onSuccess: (_data, variables) => {
      const wasCreate = !selected;
      qc.invalidateQueries({ queryKey: ['sales-reps'] });
      setShowModal(false);
      setSelected(null);
      if (wasCreate) {
        // عرض بيانات الدخول لتسليمها للمندوب
        setCreatedCreds({ name: variables.name || '', username: variables.username || '', password: variables.password || '' });
      } else {
        toast.success(tr('تم تحديث بيانات المندوب'));
      }
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('حدث خطأ');
      toast.error(msg);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => salesRepApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales-reps'] });
      toast.success(tr('تم حذف المندوب'));
      setDeleting(null);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر حذف المندوب');
      toast.error(msg);
      setDeleting(null);
    },
  });

  const perm = (val?: boolean) => val !== false
    ? <Check size={14} className="text-green-500" />
    : <XIcon size={14} className="text-gray-300" />;

  // عزل العملاء: مفتاح على مستوى الشركة — مُطفأ افتراضياً (كل مندوب يرى كل العملاء كالسابق)
  const { data: isolation, isPending: isolationLoading } = useQuery({
    queryKey: ['customer-isolation'],
    queryFn: async () => (await salesRepApi.isolation()).data.data as { enabled: boolean },
  });
  const toggleIsolation = useMutation({
    mutationFn: (enabled: boolean) => salesRepApi.setIsolation(enabled),
    onSuccess: (_d, enabled) => {
      qc.invalidateQueries({ queryKey: ['customer-isolation'] });
      toast.success(enabled ? tr('تم تفعيل عزل العملاء') : tr('تم إيقاف عزل العملاء'));
    },
    onError: () => toast.error(tr('تعذر تغيير الإعداد')),
  });
  const isolationOn = isolation?.enabled === true;

  /* التقرير اليوميّ ميزةُ اشتراكٍ **مطفأة افتراضياً**، وقراءتُه صلاحيةٌ قائمة
   * بذاتها. والشرطان معاً قبل إظهار الزرّ: زرٌّ يفتح نافذةً تردّ ٤٠٣ عيبٌ
   * حقيقيّ لا تجميل — والخادم يحرس على كل حال. */
  const { data: companyCfg } = useQuery({
    queryKey: ['company'],
    queryFn: async () => (await companyApi.get()).data.data as { dailyReportEnabled?: boolean } | null,
    staleTime: 300_000,
  });
  const dailyReportOn = companyCfg?.dailyReportEnabled === true && user?.canViewReports !== false;

  // المحاسبة مطفأة ⇒ تختفي صلاحيات الفوترة والتسعير والتحصيل ومخزون السيارة
  // من الجدول ومن نافذة المندوب، ويختفي زرّا «استلام تحصيل» و«كشف الأداء
  // والمبيعات» — فلا تُفتح نافذةٌ تقرأ رصيداً ولا يُطلَب رقمٌ مالي أصلاً.
  /* «مفعّل» قبل وصول الإعداد يعني ومضةَ أرقامٍ ثم إخفاءها — وهي تسريبٌ حقيقي
   * يلتقطه المستخدم (والصورة). والعكس — ومضة إخفاءٍ ثم عرض — لا يُسرّب شيئاً،
   * ولا يتجمّد: `ready` تصدق أيضاً حين توقف الشبكةُ المحاولة، فتعود الدلالة
   * الافتراضية «مفعّل» ولا تُحجب الأرقام عمّن تعذّرت قراءة إعداداته. */
  const { on: accountingFlag, ready: accountingReady } = useAccountingOn();
  const accountingOn = accountingReady && accountingFlag;
  const repCols = accountingOn ? 13 : 6;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{tr('إدارة المناديب')}</h1>
        <button className="btn-primary" onClick={() => { setSelected(null); setShowModal(true); }}><Plus size={16} />{tr('إضافة مندوب')}</button>
      </div>

      {/* عزل العملاء — عند التفعيل لا يرى المندوب إلا العملاء المُسنَدين له */}
      <div className="card mb-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <div className={`p-2 rounded-lg ${isolationOn ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-400'}`}>
              <ShieldCheck size={18} />
            </div>
            <div>
              <p className="font-medium text-gray-800">{tr('عزل عملاء المناديب')}</p>
              <p className="text-xs text-gray-500 mt-0.5 max-w-2xl leading-relaxed">
                {isolationLoading
                  ? tr('جاري قراءة الإعداد')
                  : isolationOn
                    ? tr('مفعل كل مندوب يرى فقط العملاء المسندين له والعملاء الذين فتحهم بنفسه')
                    : tr('مطفأ كل المناديب يرون كل عملاء الشركة فعله بعد إسناد العملاء لكل مندوب من زر إسناد العملاء')}
              </p>
            </div>
          </div>
          <button
            onClick={() => toggleIsolation.mutate(!isolationOn)}
            disabled={toggleIsolation.isPending || isolationLoading}
            className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${isolationOn ? 'bg-green-500' : 'bg-gray-300'}`}
            title={isolationOn ? tr('إيقاف العزل') : tr('تفعيل العزل')}
          >
            <span className={`inline-block h-5 w-5 mt-0.5 rounded-full bg-white shadow transition-transform ${isolationOn ? '-translate-x-[1.4rem]' : '-translate-x-0.5'}`} />
          </button>
        </div>
      </div>

      <div className="card mb-4">
        <div className="relative max-w-sm">
          <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input className="input pr-9" placeholder={tr('بحث بالاسم أو الجوال')}
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      </div>

      <div className="card p-0">
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>{tr('المندوب')}</th><th>{tr('الجوال')}</th><th>{tr('اسم المستخدم')}</th>
                {accountingOn && <th className="text-center">{tr('فاتورة')}</th>}
                {accountingOn && <th className="text-center">{tr('آجل')}</th>}
                {accountingOn && <th className="text-center">{tr('نقدي')}</th>}
                {accountingOn && <th className="text-center">{tr('تحصيل')}</th>}
                {accountingOn && <th className="text-center">{tr('تغيير سعر')}</th>}
                {accountingOn && <th className="text-center">{tr('خصم أقصى')}</th>}
                {accountingOn && <th className="text-center">{tr('مخزون السيارة')}</th>}
                <th className="text-center">{tr('إضافة عميل')}</th>
                <th>{tr('الحالة')}</th>
                <th>{tr('إجراءات')}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={repCols} className="text-center py-12 text-gray-400">{tr('جاري التحميل')}</td></tr>
              ) : data?.map(r => (
                <tr key={r.id}>
                  <td>
                    <p className="font-medium text-gray-800">{r.name}</p>
                    <p className="text-xs text-gray-400">{r.email || ''}</p>
                  </td>
                  <td className="font-mono text-sm text-gray-600">{r.phone}</td>
                  <td className="font-mono text-sm text-gray-500">{r.username}</td>
                  {accountingOn && <td className="text-center">{perm(r.canCreateInvoice)}</td>}
                  {accountingOn && <td className="text-center">{perm(r.canSellOnCredit)}</td>}
                  {accountingOn && <td className="text-center">{perm(r.canSellInCash)}</td>}
                  {accountingOn && <td className="text-center">{perm(r.canCreateReceipt)}</td>}
                  {accountingOn && <td className="text-center">{perm(r.canChangePrice)}</td>}
                  {accountingOn && <td className="text-center text-sm text-gray-600">{r.maxDiscountPct}%</td>}
                  {accountingOn && <td className="text-center">{perm(r.canManageVanStock)}</td>}
                  <td className="text-center">{perm(r.canAddCustomer)}</td>
                  <td><span className={r.isActive ? 'badge-active' : 'badge-inactive'}>{r.isActive ? tr('نشط') : tr('غير نشط')}</span></td>
                  <td>
                    <div className="flex items-center gap-1">
                      {accountingOn && r.showCollectionBalance !== false && (
                        <button onClick={() => setCollectRep(r)} className="p-1.5 hover:bg-green-50 rounded text-green-600" title={tr('استلام تحصيل')}><Banknote size={14} /></button>
                      )}
                      <button onClick={() => setAssignRep(r)} className="p-1.5 hover:bg-blue-50 rounded text-blue-600" title={tr('إسناد العملاء')}><Users size={14} /></button>
                      {dailyReportOn && (
                        <button onClick={() => setHistoryRep(r)} className="p-1.5 hover:bg-[#FBEBE2] rounded text-[#C94E28]" title={tr('سجل التقارير اليومية')}><ClipboardList size={14} /></button>
                      )}
                      {accountingOn && (
                        <button onClick={() => setStatementRep(r)} className="p-1.5 hover:bg-[#F1EBDF] rounded text-[#1F1A13]" title={tr('كشف الأداء والمبيعات')}><FileBarChart2 size={14} /></button>
                      )}
                      <button onClick={() => { setSelected({ ...r, canSellOnCredit: r.canSellOnCredit ?? true, canSellInCash: r.canSellInCash ?? true, canManageVanStock: r.canManageVanStock ?? true }); setShowModal(true); }} className="p-1.5 hover:bg-[#FBEBE2] rounded text-[#E15A30]" title={tr('تعديل')}><Edit size={14} /></button>
                      <button onClick={() => setResetRep(r)} className="p-1.5 hover:bg-amber-50 rounded text-amber-600" title={tr('إعادة تعيين كلمة المرور')}><KeyRound size={14} /></button>
                      {isMainAdmin && (
                        <button onClick={() => setDeleting(r)} className="p-1.5 hover:bg-red-50 rounded text-red-600" title={tr('حذف المندوب')}><Trash2 size={14} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <SalesRepModal
          accountingOn={accountingOn}
          rep={selected}
          onClose={() => { setShowModal(false); setSelected(null); }}
          onSave={saveMutation.mutate}
          loading={saveMutation.isPending}
        />
      )}

      {createdCreds && (
        <CredentialsModal creds={createdCreds} onClose={() => setCreatedCreds(null)} />
      )}

      {statementRep && (
        <RepStatementModal rep={statementRep} onClose={() => setStatementRep(null)} />
      )}

      {resetRep && (
        <ResetPasswordModal
          title={tr('إعادة تعيين كلمة مرور المندوب')}
          subject={`${resetRep.name} · ${resetRep.username}`}
          onConfirm={async (newPassword) => { await salesRepApi.update(resetRep.id, { password: newPassword }); }}
          onClose={() => setResetRep(null)}
        />
      )}

      {deleting && (
        <ConfirmDialog
          danger
          title={tr('حذف المندوب')}
          message={`${tr('سيتم حذف المندوب')} «${deleting.name}» ${tr('نهائيا ولا يمكن التراجع تحفظ فواتيره وسنداته كسجل مالي لكن دون نسبتها إليه وتحذف بياناته التشغيلية مخزون السيارة المواقع الزيارات')}`}
          confirmLabel={tr('حذف نهائي')}
          loading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}

      {collectRep && (
        <ReceiveCollectionModal rep={collectRep} onClose={() => setCollectRep(null)}
          onDone={() => qc.invalidateQueries({ queryKey: ['sales-reps'] })} />
      )}

      {assignRep && (
        <AssignCustomersModal rep={assignRep} isolationOn={isolationOn} onClose={() => setAssignRep(null)} />
      )}

      {historyRep && (
        <RepDailyReportsModal rep={historyRep} onClose={() => setHistoryRep(null)} />
      )}
    </div>
  );
}

// ===== إسناد العملاء لمندوب =====
// تعمل بالفروقات (إضافة/إزالة) لا باستبدال كامل، والبحث على الخادم لا محلياً — فلا يمكن
// أن يحذف الحفظُ إسنادَ عميل لم يظهر في النافذة، ولا أن يتعذّر الوصول لعميل بعيد في القائمة.
const PICKER_LIMIT = 100;

function AssignCustomersModal({ rep, isolationOn, onClose }: { rep: SalesRep; isolationOn: boolean; onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [onlyAssigned, setOnlyAssigned] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [removed, setRemoved] = useState<Set<string>>(new Set());

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // الأساس: العملاء المُسنَدون حالياً بأسمائهم. لا يُحفظ شيء قبل نجاح هذا الطلب،
  // وإلا لظُنّ أن المندوب بلا إسناد فتُرسَل إزالات خاطئة.
  const assignedQ = useQuery({
    queryKey: ['rep-customers', rep.id],
    queryFn: async () => (await salesRepApi.assignedCustomers(rep.id)).data.data as {
      customerIds: string[]; autoIds: string[]; customers: Customer[];
    },
    staleTime: 0,
    refetchOnMount: 'always',
  });

  // البحث على الخادم — يصل لأي عميل مهما كبر عدد عملاء الشركة
  const searchQ = useQuery({
    queryKey: ['customers', 'assign-picker', debouncedQ],
    queryFn: async () => (await customerApi.list({ search: debouncedQ, limit: PICKER_LIMIT })).data.data as Customer[],
    enabled: !onlyAssigned,
  });

  const baseline = new Set(assignedQ.data?.customerIds ?? []);
  const autoIds = new Set(assignedQ.data?.autoIds ?? []);
  const isAssigned = (id: string) => (baseline.has(id) && !removed.has(id)) || added.has(id);
  const count = baseline.size
    - [...removed].filter(id => baseline.has(id)).length
    + [...added].filter(id => !baseline.has(id)).length;

  const toggle = (id: string) => {
    if (isAssigned(id)) {
      if (baseline.has(id)) setRemoved(s => new Set(s).add(id));
      else setAdded(s => { const n = new Set(s); n.delete(id); return n; });
    } else {
      if (removed.has(id)) setRemoved(s => { const n = new Set(s); n.delete(id); return n; });
      else setAdded(s => new Set(s).add(id));
    }
  };

  const save = useMutation({
    mutationFn: () => salesRepApi.changeAssignedCustomers(rep.id, { add: [...added], remove: [...removed] }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rep-customers', rep.id] });
      toast.success(tr('تم حفظ إسناد العملاء'));
      onClose();
    },
    onError: () => toast.error(tr('تعذر حفظ الإسناد')),
  });

  const list: Customer[] = onlyAssigned
    ? (assignedQ.data?.customers ?? []).filter(c => isAssigned(c.id))
    : (searchQ.data ?? []);

  const dirty = added.size > 0 || removed.size > 0;
  const baseReady = assignedQ.isSuccess;      // نعرف الأساس ⇒ الحفظ آمن
  const listLoading = onlyAssigned ? assignedQ.isPending : searchQ.isPending;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[88vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h3 className="font-semibold text-gray-800">{tr('إسناد العملاء')} · {rep.name}</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {tr('اختر العملاء الذين يظهرون لهذا المندوب')} — {tr('مسند')}:{' '}
              <span className="font-medium text-gray-700">{baseReady ? count : '…'}</span>
              {dirty && <span className="text-[#E15A30]"> · +{added.size} / −{removed.size}</span>}
            </p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        {assignedQ.isError && (
          <div className="mx-4 mt-3 text-xs bg-red-50 text-red-700 border border-red-200 rounded-lg p-2.5 flex items-center justify-between gap-3">
            <span>{tr('تعذر تحميل العملاء المسندين حاليا الحفظ معطل حتى لا تفقد إسنادات')}</span>
            <button onClick={() => assignedQ.refetch()} className="underline shrink-0">{tr('إعادة المحاولة')}</button>
          </div>
        )}

        {!isolationOn && (
          <div className="mx-4 mt-3 text-xs bg-amber-50 text-amber-800 border border-amber-200 rounded-lg p-2.5 leading-relaxed">
            {tr('عزل العملاء مطفأ حاليا فكل المناديب يرون كل العملاء يحفظ الإسناد الآن ويسري فور تفعيل المفتاح أعلى الصفحة')}
          </div>
        )}

        <div className="p-4 pb-2 space-y-2">
          <div className="relative">
            <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input className="input pr-9" placeholder={tr('ابحث بالاسم أو الجوال أو الكود')}
              value={q} onChange={e => setQ(e.target.value)} disabled={onlyAssigned} />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer w-fit">
            <input type="checkbox" checked={onlyAssigned} onChange={e => setOnlyAssigned(e.target.checked)} />
            {tr('عرض المسندين فقط')}
          </label>
          {!onlyAssigned && (
            <p className="text-[11px] text-gray-400">
              {tr('يعرض أقرب')} {PICKER_LIMIT} {tr('نتيجة اكتب في البحث للوصول لأي عميل')}
            </p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-2 min-h-[240px]">
          {listLoading ? (
            <p className="text-center text-gray-400 py-10">{tr('جاري التحميل')}</p>
          ) : list.length === 0 ? (
            <p className="text-center text-gray-400 py-10">
              {onlyAssigned ? tr('لا يوجد عملاء مسندون لهذا المندوب') : tr('لا يوجد عملاء مطابقون')}
            </p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {list.map(c => (
                <li key={c.id}>
                  <label className="flex items-center gap-3 py-2.5 cursor-pointer hover:bg-gray-50 px-1 rounded">
                    <input type="checkbox" checked={isAssigned(c.id)} onChange={() => toggle(c.id)} disabled={!baseReady} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-gray-800 truncate">{c.name}</span>
                      <span className="block text-xs text-gray-400 truncate">{c.businessName || c.phone || c.code}</span>
                    </span>
                    {autoIds.has(c.id) && (
                      <span className="text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded shrink-0">{tr('فتحه بنفسه')}</span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="p-4 border-t flex items-center justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
          <button onClick={() => save.mutate()} disabled={!baseReady || !dirty || save.isPending} className="btn-primary">
            {save.isPending ? tr('جاري الحفظ') : tr('حفظ التغييرات')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* نوع الاستلام — نفس قاموس سند القبض حرفاً بحرف. أيّ قيمة خارجه يردّها الخادم إلى CASH */
const SETTLE_METHODS = ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE'] as const;
type SettleMethod = typeof SETTLE_METHODS[number];
const isSettleMethod = (v: string): v is SettleMethod => (SETTLE_METHODS as readonly string[]).includes(v);

interface SettlementPhoto { id: string; data: string }
/* method وphotos اختياريان في النوع لا لأنّ الخادم قد يُغفلهما — بل ليمرّ صفٌّ قديم
 * أو ردٌّ مخبوء من نسخةٍ أقدم بلا سقوط. القراءة تُسقط الغياب إلى CASH و[] لا إلى إخفاء الصفّ. */
interface Settlement {
  id: string; amount: number; note?: string | null; createdBy?: string | null; settledAt: string;
  method?: string | null; photos?: SettlementPhoto[] | null;
}

/** سقف المرفقات لكلّ استلام — يطابق سقف الخادم (جدول RepSettlementPhoto) */
const MAX_SETTLE_PHOTOS = 4;

function ReceiveCollectionModal({ rep, onClose, onDone }: { rep: SalesRep; onClose: () => void; onDone: () => void }) {
  const tr = useTr();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<SettleMethod>('CASH');
  const [photos, setPhotos] = useState<string[]>([]); // data URLs مضغوطة
  const [note, setNote] = useState('');
  const [filled, setFilled] = useState(false);
  const [pdfOne, setPdfOne] = useState<Settlement | null>(null);
  // عارض مرفقات صفٍّ من السجلّ — صور الصفّ كاملةً، تُفتح بالنقر على المصغّرة
  const [viewPhotos, setViewPhotos] = useState<SettlementPhoto[] | null>(null);
  // حذف استلام: للأدمن الرئيسي وحده — والخادم يفرضه ثانيةً بقراءة الدور من القاعدة
  const { user } = useAuthStore();
  const isMainAdmin = user?.role === 'ADMIN';
  const [deletingS, setDeletingS] = useState<Settlement | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['rep-collection', rep.id],
    queryFn: async () => {
      const r = await salesRepApi.collection(rep.id);
      return r.data.data as { collected: number; settled: number; outstanding: number };
    },
  });

  /* مدى تصفية السجلّ — يدخل مفتاح الاستعلام فيُعاد الجلب عند تغيّره، والتصفية
   * تقع على الخادم: السقف ١٠٠ صفّ، وتصفيةٌ محليّة كانت ستبحث داخل آخر مئة وحدها
   * فيرى مندوبٌ كثير الاستلامات «لا نتائج» لشهرٍ قديم بينما صفوفه محفوظة. */
  const [logFrom, setLogFrom] = useState('');
  const [logTo, setLogTo] = useState('');

  // سجلّ استلامات التحصيل لهذا المندوب (مرتّب بالوقت من الخادم)
  const settlementsQ = useQuery({
    queryKey: ['rep-settlements', rep.id, logFrom, logTo],
    queryFn: async () => {
      const r = await salesRepApi.settlements(rep.id, {
        ...(logFrom && { from: logFrom }),
        ...(logTo && { to: logTo }),
      });
      return r.data.data as Settlement[];
    },
  });
  const settlements = settlementsQ.data ?? [];
  const rangeOn = !!(logFrom || logTo);
  // مجموع المعروض — تصفيةُ مالٍ بلا مجموعها تترك المحاسب يجمع بعينه
  const rangeTotal = settlements.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);

  // بيانات الشركة لرأس ملفّ الـPDF
  const companyQ = useQuery({
    queryKey: ['company'],
    queryFn: async () => { const r = await companyApi.get(); return r.data.data as Company; },
  });

  // تعبئة الحقل تلقائياً بالرصيد المتبقّي (تسليم كامل) أول مرّة
  // خانات العملة الفعلية: toFixed(2) الثابتة كانت تقص الفلس الثالث فتبقى 0.005 معلقة للابد
  if (data && !filled) { setAmount(String(Math.max(0, Number(Number(data.outstanding).toFixed(currencyDecimals(getActiveCurrency())))))); setFilled(true); }

  /** وسم نوع الاستلام — قاموس سند القبض نفسه، والمجهول يُقرأ نقدياً كما يفعل الخادم */
  const methodLabel = (m?: string | null) => tr(paymentMethodLabels[m || 'CASH'] || paymentMethodLabels.CASH);

  /* اختيار المرفقات: يُضغط كلّ ملفٍ بالوحدة المشتركة ثم يُضاف. الفائض عن السقف
   * يُقصّ ويُنبَّه عليه صراحةً — وصمتُه كان سيجعل المستخدم يظنّ صورةً أُرفِقت ولم تُرفَق. */
  const pickPhotos = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // يسمح بإعادة اختيار نفس الملف
    if (files.length === 0) return;
    const room = MAX_SETTLE_PHOTOS - photos.length;
    if (room <= 0) { toast.error(tr('الحد الأقصى 4 صور')); return; }
    const urls: string[] = [];
    for (const f of files.slice(0, room)) {
      try { urls.push(await compressImage(f)); }
      catch { /* ملفٌ تالف أو غير صورة — يُتجاهل ولا يُسقط البقيّة */ }
    }
    if (files.length > room) toast.error(tr('الحد الأقصى 4 صور'));
    if (urls.length) setPhotos(prev => [...prev, ...urls].slice(0, MAX_SETTLE_PHOTOS));
  };

  const settle = useMutation({
    mutationFn: () => salesRepApi.settle(rep.id, {
      amount: Number(amount),
      method,
      note: note || undefined,
      ...(photos.length ? { photos } : {}),
    }),
    onSuccess: async () => {
      toast.success(tr('تم تسجيل الاستلام'));
      setNote('');
      // النوع والمرفقات يُفرَّغان كما يُفرَّغ المبلغ — وإلا لحق مرفقُ استلامٍ سابق باستلامٍ تالٍ
      setMethod('CASH');
      setPhotos([]);
      await Promise.all([refetch(), settlementsQ.refetch()]);
      setFilled(false); // بعد وصول الرصيد الجديد لا قبله — وإلا أعيد ملء الحقل بالقديم
      onDone();
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر التسجيل');
      toast.error(msg);
    },
  });

  const removeSettlement = useMutation({
    mutationFn: (s: Settlement) => salesRepApi.deleteSettlement(rep.id, s.id),
    onSuccess: async () => {
      toast.success(tr('تم حذف الاستلام'));
      setDeletingS(null);
      // الحذف يرفع الرصيد المتبقّي. الترتيب مقصود: يُنتظر وصول الرصيد الجديد
      // **ثم** يُفتح قفل التعبئة — فالعكس يملأ الحقل بالرقم الذي سبق الحذف
      // ويقفله عليه، إذ يُبقي react-query البيانات السابقة أثناء إعادة الجلب.
      await Promise.all([refetch(), settlementsQ.refetch()]);
      setFilled(false);
      onDone();
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر حذف الاستلام');
      toast.error(msg);
    },
  });

  const outstanding = data?.outstanding ?? 0;

  // تصدير تسجيلٍ واحد: نعرض مستنده (نافذة كاملة) بدل نافذة الاستلام
  if (pdfOne) {
    return (
      <DocumentModal
        doc={settlementLogDocFromData(rep.name, [pdfOne], companyQ.data ?? null)}
        onClose={() => setPdfOne(null)}
      />
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-green-50 rounded-xl flex items-center justify-center"><Banknote size={20} className="text-green-600" /></div>
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13]">{tr('استلام تحصيل')}</h2>
              <p className="text-xs text-[#6E6557]">{rep.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          {isLoading ? (
            <p className="text-center text-gray-400 py-6">{tr('جار التحميل')}</p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-gray-50 rounded-xl p-3">
                  <p className="text-[11px] text-gray-500">{tr('إجمالي التحصيل')}</p>
                  <p className="font-bold text-sm text-gray-700 mt-1">{formatCurrency(data?.collected ?? 0)}</p>
                </div>
                <div className="bg-gray-50 rounded-xl p-3">
                  <p className="text-[11px] text-gray-500">{tr('المستلم سابقا')}</p>
                  <p className="font-bold text-sm text-gray-700 mt-1">{formatCurrency(data?.settled ?? 0)}</p>
                </div>
                <div className="bg-green-50 rounded-xl p-3 border border-green-100">
                  <p className="text-[11px] text-green-700">{tr('الرصيد المتبقي')}</p>
                  <p className="font-extrabold text-sm text-green-700 mt-1">{formatCurrency(outstanding)}</p>
                </div>
              </div>

              <div>
                <label className="label">{tr('المبلغ المستلم من المندوب')}</label>
                <input className="input" type="number" min={0} step="0.01" value={amount}
                  onChange={e => setAmount(e.target.value)} placeholder="0.00" />
                <p className="text-[11px] text-gray-400 mt-1">{tr('المبلغ معبأ بالرصيد المتبقي تسليم كامل عدله للتسليم الجزئي')}</p>
              </div>

              <div>
                <label className="label">{tr('نوع الاستلام')}</label>
                <select className="input" value={method}
                  onChange={e => { const v = e.target.value; if (isSettleMethod(v)) setMethod(v); }}>
                  <option value="CASH">{tr('نقدي')}</option>
                  <option value="BANK_TRANSFER">{tr('تحويل بنكي')}</option>
                  <option value="POS">{tr('شبكة')}</option>
                  <option value="CHEQUE">{tr('شيك')}</option>
                </select>
              </div>

              {/* مرفقات — إيصال الإيداع غالباً لقطةُ شاشةٍ محفوظة، فلا سمة `capture`:
                  النظام يعرض الاختيار بين الكاميرا والمعرض معاً */}
              <div>
                <label className="label">{tr('مرفقات')} ({photos.length}/{MAX_SETTLE_PHOTOS})</label>
                <div className="flex flex-wrap gap-2">
                  {photos.map((p, i) => (
                    <span key={i} className="relative w-[72px] h-[72px] rounded-xl overflow-hidden border border-[#E9E1D3]">
                      <img src={p} alt="" className="w-full h-full object-cover" />
                      <button type="button" onClick={() => setPhotos(prev => prev.filter((_, j) => j !== i))}
                        aria-label={tr('حذف الصورة')} title={tr('حذف الصورة')}
                        className="absolute top-0.5 left-0.5 bg-black/60 text-white rounded-full w-6 h-6 flex items-center justify-center">
                        <X size={13} />
                      </button>
                    </span>
                  ))}
                  {photos.length < MAX_SETTLE_PHOTOS && (
                    <label className="w-[72px] h-[72px] rounded-xl border-2 border-dashed border-gray-300 text-gray-400 flex flex-col items-center justify-center gap-1 cursor-pointer hover:bg-gray-50">
                      <input type="file" accept="image/*" multiple className="hidden" onChange={pickPhotos} />
                      <ImageIcon size={18} />
                      <span className="text-[10px]">{tr('إضافة صورة')}</span>
                    </label>
                  )}
                </div>
                <p className="text-[11px] text-gray-400 mt-1.5">{tr('أرفق إيصال التحويل أو صورة الشيك حتى 4 صور')}</p>
              </div>

              <div>
                <label className="label">{tr('ملاحظة اختياري')}</label>
                <input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder={tr('مثال نقدا تحويل بنكي')} />
              </div>

              {/* سجلّ الاستلامات — مرتّب بالوقت والمبلغ ومن استلم، قابل للتصدير PDF */}
              <div>
                <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
                  <label className="label mb-0">{tr('سجل الاستلامات')}</label>
                  {rangeOn && (
                    <button type="button" onClick={() => { setLogFrom(''); setLogTo(''); }}
                      className="text-[11px] font-semibold text-[#C94E28] hover:underline">
                      {tr('إلغاء التصفية')}
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <div>
                    <label className="text-[11px] text-[#9A8F7E] block mb-1">{tr('من تاريخ')}</label>
                    <input type="date" className="input py-1.5 text-xs" value={logFrom}
                      max={logTo || undefined} onChange={e => setLogFrom(e.target.value)} />
                  </div>
                  <div>
                    <label className="text-[11px] text-[#9A8F7E] block mb-1">{tr('إلى تاريخ')}</label>
                    <input type="date" className="input py-1.5 text-xs" value={logTo}
                      min={logFrom || undefined} onChange={e => setLogTo(e.target.value)} />
                  </div>
                </div>
                <div className="border border-[#E9E1D3] rounded-xl divide-y divide-[#F1EBDF] max-h-52 overflow-y-auto">
                  {settlementsQ.isLoading ? (
                    <p className="text-center text-gray-400 text-xs py-4">{tr('جار التحميل')}</p>
                  ) : settlements.length === 0 ? (
                    <p className="text-center text-gray-400 text-xs py-5">
                      {rangeOn ? tr('لا استلامات في هذا المدى') : tr('لا توجد استلامات بعد')}
                    </p>
                  ) : settlements.map(s => {
                    // الصفوف القديمة تأتي بـmethod نقديّ وphotos فارغة — تُقرأ ولا تُسقَط
                    const rowPhotos = s.photos ?? [];
                    return (
                    <div key={s.id} className="flex items-center justify-between gap-2 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <p className="font-bold text-sm text-[#1F1A13]">{formatCurrency(s.amount)}</p>
                          <span className="text-[10px] bg-[#F1EBDF] text-[#6E6557] px-1.5 py-0.5 rounded-full whitespace-nowrap">
                            {methodLabel(s.method)}
                          </span>
                          {rowPhotos.length > 0 && (
                            <button type="button" onClick={() => setViewPhotos(rowPhotos)}
                              title={tr('مرفقات')} aria-label={tr('مرفقات')}
                              className="flex items-center gap-1 rounded-lg border border-[#E9E1D3] pl-1.5 hover:bg-[#FAF7F0]">
                              <img src={rowPhotos[0].data} alt="" className="w-5 h-5 rounded-md object-cover" />
                              <span className="text-[10px] text-[#6E6557]">{rowPhotos.length}</span>
                            </button>
                          )}
                        </div>
                        <p className="text-[11px] text-[#9A8F7E] truncate">
                          {tr('استلمه')}: {s.createdBy || '—'}{s.note ? ` · ${s.note}` : ''}
                        </p>
                      </div>
                      <div className="text-[11px] text-[#9A8F7E] text-left leading-tight whitespace-nowrap flex-shrink-0">
                        <span>{formatDate(s.settledAt)}</span><br />
                        <span>{formatTime(s.settledAt)}</span>
                      </div>
                      <button type="button" onClick={() => setPdfOne(s)} title={tr('تصدير PDF')}
                        className="flex-shrink-0 p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700">
                        <Download size={15} />
                      </button>
                      {isMainAdmin && (
                        <button type="button" onClick={() => setDeletingS(s)} title={tr('حذف الاستلام')}
                          className="flex-shrink-0 p-1.5 rounded-lg text-[#C0392B] hover:bg-red-50">
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                    );
                  })}
                </div>
                {settlements.length > 0 && (
                  <p className="text-[11px] text-[#6E6557] mt-1.5 px-0.5">
                    {rangeOn ? tr('مجموع المدى') : tr('مجموع المعروض')}:{' '}
                    <b className="text-[#1F1A13]">{formatCurrency(rangeTotal)}</b>
                    {' · '}
                    <span className="text-[#9A8F7E]">{settlements.length} {tr('استلام')}</span>
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        {/* عارض مرفقات صفّ السجلّ — فوق نافذة الاستلام (z-[60]) كي لا تحجبه */}
        {viewPhotos && (
          <div className="fixed inset-0 bg-black/80 z-[70] flex items-center justify-center p-4"
            onClick={() => setViewPhotos(null)}>
            <div className="w-full max-w-md max-h-[85vh] overflow-y-auto space-y-2" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between text-white">
                <span className="text-sm font-semibold">{tr('مرفقات')} ({viewPhotos.length})</span>
                <button type="button" onClick={() => setViewPhotos(null)} aria-label={tr('إغلاق')} title={tr('إغلاق')}
                  className="p-2 rounded-lg hover:bg-white/10"><X size={18} /></button>
              </div>
              {viewPhotos.map(p => (
                <img key={p.id} src={p.data} alt="" className="w-full rounded-xl bg-white" />
              ))}
            </div>
          </div>
        )}

        {deletingS && (
          <ConfirmDialog
            danger
            title={tr('حذف استلام تحصيل')}
            message={`${tr('سيحذف استلام بمبلغ')} ${formatCurrency(deletingS.amount)} ${tr('ويعود هذا المبلغ رصيدا مطلوبا من المندوب')} «${rep.name}» ${tr('ولا يمكن التراجع')}`}
            confirmLabel={tr('حذف نهائي')}
            loading={removeSettlement.isPending}
            onConfirm={() => removeSettlement.mutate(deletingS)}
            onClose={() => setDeletingS(null)}
          />
        )}

        <div className="flex gap-3 p-5 border-t border-[#E9E1D3]">
          <button onClick={() => settle.mutate()}
            disabled={settle.isPending || isLoading || !(Number(amount) > 0)}
            className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
            {settle.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Banknote size={16} />}
            {tr('تسجيل الاستلام')}
          </button>
          <button onClick={onClose} className="btn-secondary">{tr('إغلاق')}</button>
        </div>
      </div>
    </div>
  );
}

// ============ كشف أداء وعمل المندوب ============
function RepStatementModal({ rep, onClose }: { rep: SalesRep; onClose: () => void }) {
  const tr = useTr();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['rep-statement', rep.id, from, to],
    queryFn: async () => {
      const base: Record<string, string | number> = { salesRepId: rep.id, limit: 5000, withItems: 1 };
      // كلٌّ على حدة (راجع صفحة الفواتير)
      if (from) base.from = from;
      if (to) base.to = to;
      const [inv, rcp] = await Promise.all([
        invoiceApi.list({ ...base, status: 'CONFIRMED' }),
        receiptApi.list(base),
      ]);
      return { invoices: inv.data.data as Invoice[], receipts: rcp.data.data as Receipt[] };
    },
  });

  const invoices = data?.invoices ?? [];
  const receipts = data?.receipts ?? [];
  const sales = invoices.filter(i => (i.type as string) !== 'RETURN');
  const returns = invoices.filter(i => (i.type as string) === 'RETURN');
  const salesTotal = sales.reduce((s, i) => s + Number(i.total), 0);
  const returnsTotal = returns.reduce((s, i) => s + Number(i.total), 0);
  const collectTotal = receipts.reduce((s, r) => s + Number(r.amount), 0);
  const periodLabel = from && to ? `${formatDate(from)} — ${formatDate(to)}` : tr('كل الفترات');
  // ملخّص أصناف الفاتورة: «اسم ×كمية، …» (لعمود الأصناف في الكشف)
  const itemsText = (i: Invoice) => (i.items || []).map(it => `${it.product.name} ×${Number(it.qty)}`).join(' ');
  // إجماليات أسفل الكشف: مجموع مبالغ الفواتير + مجموع الوحدات المباعة مفصّلة حسب الوحدة (كرتون/قطعة/…)
  const invoicesAmountTotal = invoices.reduce((s, i) => s + Number(i.total), 0);
  const soldUnits = (() => {
    const m = new Map<string, number>();
    for (const i of sales) for (const it of (i.items || [])) { // البيع فقط (بلا المرتجعات)
      const u = (it.product.unit || '').trim() || tr('وحدة');
      m.set(u, (m.get(u) || 0) + Number(it.qty));
    }
    return [...m.entries()].map(([u, q]) => `${formatNumber(q)} ${u}`).join(' · ');
  })();

  // تصدير الكشف إلى Excel (3 أوراق: ملخص، فواتير، سندات)
  const exportRep = async () => {
    const summary = [
      { [tr('البند')]: tr('عدد فواتير البيع'), [tr('القيمة')]: sales.length },
      { [tr('البند')]: tr('إجمالي المبيعات'), [tr('القيمة')]: num(salesTotal) },
      { [tr('البند')]: tr('عدد المرتجعات'), [tr('القيمة')]: returns.length },
      { [tr('البند')]: tr('إجمالي المرتجعات'), [tr('القيمة')]: num(returnsTotal) },
      { [tr('البند')]: tr('صافي المبيعات'), [tr('القيمة')]: num(salesTotal - returnsTotal) },
      { [tr('البند')]: tr('عدد سندات القبض'), [tr('القيمة')]: receipts.length },
      { [tr('البند')]: tr('إجمالي التحصيل'), [tr('القيمة')]: num(collectTotal) },
    ];
    const invRows = invoices.map(i => ({
      [tr('رقم الفاتورة')]: i.number, [tr('العميل')]: i.customer.name,
      [tr('الأصناف')]: itemsText(i),
      [tr('النوع')]: tr(statusLabels[i.type] || i.type),
      [tr('التاريخ')]: formatDate(i.invoiceDate), [tr('الإجمالي')]: num(i.total), [tr('المدفوع')]: num(i.paidAmt), [tr('المتبقي')]: num(i.remainingAmt),
    })) as Record<string, string | number>[];
    // صف الإجمالي أسفل جدول الفواتير
    if (invoices.length) invRows.push({
      [tr('رقم الفاتورة')]: tr('الإجمالي'), [tr('العميل')]: '',
      [tr('الأصناف')]: `${tr('الوحدات المباعة')}: ${soldUnits}`,
      [tr('النوع')]: '', [tr('التاريخ')]: '', [tr('الإجمالي')]: num(invoicesAmountTotal), [tr('المدفوع')]: '', [tr('المتبقي')]: '',
    });
    const rcpRows = receipts.map(r => ({
      [tr('رقم السند')]: r.number, [tr('العميل')]: r.customer.name,
      [tr('طريقة الدفع')]: tr(paymentMethodLabels[r.paymentMethod] || r.paymentMethod),
      [tr('التاريخ')]: formatDate(r.receiptDate), [tr('المبلغ')]: num(r.amount),
    }));
    const out = await shareOrDownloadExcel([
      { name: tr('الملخص'), rows: summary, colWidths: [22, 16] },
      { name: tr('الفواتير'), rows: invRows, colWidths: [18, 24, 40, 10, 16, 12, 12, 12] },
      { name: tr('سندات القبض'), rows: rcpRows, colWidths: [18, 24, 14, 16, 12] },
    ], `${tr('كشف')}-${rep.name}-${new Date().toISOString().slice(0, 10)}`);
    toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم تصدير كشف المندوب'));
  };

  // طباعة الكشف العادي (A4)
  const printStatement = () => {
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
    const invRows = invoices.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.number)}</td><td>${esc(i.customer.name)}</td><td style="font-size:10px">${esc((i.items?.length ? `${i.items.length} ${tr('صنف')}: ` : '') + itemsText(i))}</td><td>${esc(tr(statusLabels[i.type] || i.type))}</td><td>${formatDate(i.invoiceDate)}</td><td style="text-align:left">${num(i.total).toFixed(2)}</td></tr>`).join('');
    const rcpRows = receipts.map((r, n) => `<tr><td>${n + 1}</td><td>${esc(r.number)}</td><td>${esc(r.customer.name)}</td><td>${esc(tr(paymentMethodLabels[r.paymentMethod] || r.paymentMethod))}</td><td>${formatDate(r.receiptDate)}</td><td style="text-align:left">${num(r.amount).toFixed(2)}</td></tr>`).join('');
    const html = `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"/><title>${tr('كشف')} ${esc(rep.name)}</title>
    <style>
      @page { size: A4; margin: 14mm; }
      body { font-family: 'Tahoma','Arial',sans-serif; color:#1F1A13; font-size:12px; }
      h1 { color:#E15A30; font-size:20px; margin:0; }
      .sub { color:#6E6557; font-size:12px; margin:4px 0 14px; }
      .cards { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:16px; }
      .card { border:1px solid #E9E1D3; border-radius:8px; padding:10px 14px; min-width:120px; }
      .card .v { font-size:18px; font-weight:700; }
      .card .k { font-size:11px; color:#6E6557; }
      h2 { font-size:14px; margin:18px 0 6px; color:#1F1A13; border-bottom:2px solid #E15A30; padding-bottom:4px; }
      table { width:100%; border-collapse:collapse; }
      th { background:#FAF7F0; text-align:right; padding:6px 8px; font-size:11px; border-bottom:1px solid #E9E1D3; }
      td { padding:6px 8px; font-size:11px; border-bottom:1px solid #F1EBDF; }
    </style></head><body>
      <h1>FieldSales — ${tr('كشف المندوب')}</h1>
      <div class="sub">${tr('المندوب')}: <b>${esc(rep.name)}</b> · ${tr('الجوال')}: ${esc(rep.phone)} · ${tr('الفترة')}: ${periodLabel} · ${tr('تاريخ الإصدار')}: ${formatDate(new Date().toISOString())}</div>
      <div class="cards">
        <div class="card"><div class="v">${sales.length}</div><div class="k">${tr('عدد الفواتير')}</div></div>
        <div class="card"><div class="v">${num(salesTotal).toFixed(2)}</div><div class="k">${tr('إجمالي المبيعات')}</div></div>
        <div class="card"><div class="v">${receipts.length}</div><div class="k">${tr('عدد السندات')}</div></div>
        <div class="card"><div class="v">${num(collectTotal).toFixed(2)}</div><div class="k">${tr('إجمالي التحصيل')}</div></div>
        <div class="card"><div class="v">${num(salesTotal - returnsTotal).toFixed(2)}</div><div class="k">${tr('صافي المبيعات')}</div></div>
      </div>
      <h2>${tr('الفواتير')} (${invoices.length})</h2>
      <table><thead><tr><th>#</th><th>${tr('رقم الفاتورة')}</th><th>${tr('العميل')}</th><th>${tr('الأصناف')}</th><th>${tr('النوع')}</th><th>${tr('التاريخ')}</th><th>${tr('الإجمالي')}</th></tr></thead><tbody>${invRows || `<tr><td colspan=7>${tr('لا توجد فواتير')}</td></tr>`}</tbody>${invoices.length ? `<tfoot><tr style="background:#FAF7F0;font-weight:700;border-top:2px solid #E15A30"><td colspan=3>${tr('الإجمالي')}</td><td>${esc(soldUnits)}</td><td colspan=2>${invoices.length} ${tr('فاتورة')}</td><td style="text-align:left">${num(invoicesAmountTotal).toFixed(2)}</td></tr></tfoot>` : ''}</table>
      <h2>${tr('سندات القبض')} (${receipts.length})</h2>
      <table><thead><tr><th>#</th><th>${tr('رقم السند')}</th><th>${tr('العميل')}</th><th>${tr('الطريقة')}</th><th>${tr('التاريخ')}</th><th>${tr('المبلغ')}</th></tr></thead><tbody>${rcpRows || `<tr><td colspan=6>${tr('لا توجد سندات')}</td></tr>`}</tbody></table>
    </body></html>`;
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:-9999px;bottom:0;width:210mm;height:0;border:0;';
    document.body.appendChild(iframe);
    const idoc = iframe.contentWindow?.document;
    if (!idoc) { iframe.remove(); return; }
    idoc.open(); idoc.write(html); idoc.close();
    setTimeout(() => { try { iframe.contentWindow?.focus(); iframe.contentWindow?.print(); } catch { /* */ } setTimeout(() => iframe.remove(), 2000); }, 400);
  };

  const stat = (v: string, k: string, color: string) => (
    <div className="bg-white rounded-xl border border-[#E9E1D3] p-3">
      <p className={`text-lg font-bold ${color}`}>{v}</p>
      <p className="text-xs text-[#6E6557]">{k}</p>
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-[#FAF7F0] rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3] bg-white rounded-t-2xl sticky top-0">
          <div className="flex items-center gap-2">
            <FileBarChart2 size={20} className="text-[#E15A30]" />
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13]">{tr('كشف المندوب')} — {rep.name}</h2>
              <p className="text-xs text-[#6E6557]">{periodLabel}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* فلتر الفترة */}
          <div className="flex items-end gap-3 flex-wrap bg-white rounded-xl border border-[#E9E1D3] p-3">
            <div><label className="label">{tr('من تاريخ')}</label><input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)} /></div>
            <div><label className="label">{tr('إلى تاريخ')}</label><input type="date" className="input" value={to} onChange={e => setTo(e.target.value)} /></div>
            {(from || to) && <button onClick={() => { setFrom(''); setTo(''); }} className="btn-secondary">{tr('كل الفترات')}</button>}
          </div>

          {isLoading ? (
            <div className="text-center text-gray-400 py-10">{tr('جاري التحميل')}</div>
          ) : (
            <>
              {/* ملخص */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {stat(String(sales.length), tr('عدد الفواتير'), 'text-[#E15A30]')}
                {stat(formatCurrency(salesTotal), tr('إجمالي المبيعات'), 'text-[#E15A30]')}
                {stat(String(receipts.length), tr('عدد السندات'), 'text-[#1E7A52]')}
                {stat(formatCurrency(collectTotal), tr('إجمالي التحصيل'), 'text-[#1E7A52]')}
              </div>

              {/* الفواتير */}
              <div>
                <h3 className="font-semibold text-[#1F1A13] mb-2 text-sm">{tr('الفواتير')} ({invoices.length})</h3>
                <div className="table-wrapper bg-white">
                  <table className="table">
                    <thead><tr><th>{tr('رقم الفاتورة')}</th><th>{tr('العميل')}</th><th>{tr('الأصناف')}</th><th>{tr('النوع')}</th><th>{tr('التاريخ')}</th><th>{tr('الإجمالي')}</th></tr></thead>
                    <tbody>
                      {invoices.length === 0 ? <tr><td colSpan={6} className="text-center py-6 text-gray-400">{tr('لا توجد فواتير')}</td></tr>
                        : invoices.map(i => (
                          <tr key={i.id}>
                            <td className="font-mono text-xs text-[#E15A30] align-top">{i.number}</td>
                            <td className="align-top">{i.customer.name}</td>
                            <td className="text-xs text-gray-600 align-top" style={{ maxWidth: 240 }}>
                              {i.items && i.items.length > 0
                                ? <><span className="font-semibold text-gray-700">{i.items.length} {tr('صنف')}</span>: {itemsText(i)}</>
                                : '-'}
                            </td>
                            <td className="align-top">{tr(statusLabels[i.type] || i.type)}</td>
                            <td className="text-xs text-gray-500 align-top">{formatDate(i.invoiceDate)}</td>
                            <td className="font-semibold align-top">{formatCurrency(i.total)}</td>
                          </tr>
                        ))}
                    </tbody>
                    {invoices.length > 0 && (
                      <tfoot>
                        <tr className="bg-[#FAF7F0] font-bold border-t-2 border-[#E15A30]">
                          <td colSpan={2} className="text-[#1F1A13]">{tr('الإجمالي')}</td>
                          <td className="text-[#1F1A13]">{soldUnits || '-'}</td>
                          <td colSpan={2} className="text-xs text-gray-500">{invoices.length} {tr('فاتورة')}</td>
                          <td className="text-[#E15A30]">{formatCurrency(invoicesAmountTotal)}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>

              {/* السندات */}
              <div>
                <h3 className="font-semibold text-[#1F1A13] mb-2 text-sm">{tr('سندات القبض')} ({receipts.length})</h3>
                <div className="table-wrapper bg-white">
                  <table className="table">
                    <thead><tr><th>{tr('رقم السند')}</th><th>{tr('العميل')}</th><th>{tr('الطريقة')}</th><th>{tr('التاريخ')}</th><th>{tr('المبلغ')}</th></tr></thead>
                    <tbody>
                      {receipts.length === 0 ? <tr><td colSpan={5} className="text-center py-6 text-gray-400">{tr('لا توجد سندات')}</td></tr>
                        : receipts.map(r => (
                          <tr key={r.id}>
                            <td className="font-mono text-xs text-[#1E7A52]">{r.number}</td>
                            <td>{r.customer.name}</td>
                            <td>{tr(paymentMethodLabels[r.paymentMethod] || r.paymentMethod)}</td>
                            <td className="text-xs text-gray-500">{formatDate(r.receiptDate)}</td>
                            <td className="font-semibold text-[#1E7A52]">{formatCurrency(r.amount)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex gap-3 p-5 border-t border-[#E9E1D3] bg-white rounded-b-2xl sticky bottom-0">
          <button onClick={exportRep} disabled={isLoading} className="btn-primary flex-1 justify-center py-2.5"><Download size={16} /> {tr('تصدير Excel')}</button>
          <button onClick={printStatement} disabled={isLoading} className="btn-secondary flex-1 justify-center py-2.5"><Printer size={16} /> {tr('طباعة الكشف')}</button>
          <button onClick={onClose} className="btn-secondary">{tr('إغلاق')}</button>
        </div>
      </div>
    </div>
  );
}

// ============ شاشة بيانات الدخول بعد إنشاء المندوب ============
function CredentialsModal({ creds, onClose }: { creds: Creds; onClose: () => void }) {
  const tr = useTr();
  const [copied, setCopied] = useState('');
  const copy = (label: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(''), 1500);
    });
  };
  const copyAll = () =>
    copy('all', `${tr('بيانات الدخول لتطبيق المندوب')}\n${tr('الاسم')}: ${creds.name}\n${tr('اسم المستخدم')}: ${creds.username}\n${tr('كلمة المرور')}: ${creds.password}`);

  const row = (label: string, value: string, key: string) => (
    <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2.5">
      <div>
        <p className="text-[11px] text-gray-400">{label}</p>
        <p className="font-mono font-semibold text-gray-800" dir="ltr">{value}</p>
      </div>
      <button onClick={() => copy(key, value)} className="p-1.5 hover:bg-white rounded text-[#E15A30]" title={tr('نسخ')}>
        {copied === key ? <Check size={15} className="text-green-600" /> : <Copy size={15} />}
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="p-6 text-center border-b border-gray-100">
          <div className="w-14 h-14 bg-green-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
            <UserCheck size={28} className="text-green-600" />
          </div>
          <h2 className="text-lg font-bold text-gray-800">{tr('تم إنشاء حساب المندوب')}</h2>
          <p className="text-sm text-gray-500 mt-1">{creds.name}</p>
        </div>

        <div className="p-6 space-y-3">
          <div className="flex items-center gap-2 text-[#C94E28] bg-[#FBEBE2] rounded-lg px-3 py-2 text-xs">
            <KeyRound size={14} />
            {tr('سلم هذه البيانات للمندوب ليدخل بها على التطبيق كلمة المرور لن تظهر مرة أخرى')}
          </div>
          {row(tr('الاسم'), creds.name, 'name')}
          {row(tr('اسم المستخدم'), creds.username, 'username')}
          {row(tr('كلمة المرور'), creds.password, 'password')}
        </div>

        <div className="flex gap-3 p-6 pt-0">
          <button onClick={copyAll} className="btn-secondary flex-1 justify-center">
            {copied === 'all' ? <Check size={15} className="text-green-600" /> : <Copy size={15} />}
            {tr('نسخ الكل')}
          </button>
          <button onClick={onClose} className="btn-primary flex-1 justify-center">{tr('تم')}</button>
        </div>
      </div>
    </div>
  );
}

/* ═══ سجلّ التقارير اليومية لمندوب ═══
 *
 * صفحة المندوب تحمل سجلّ تحصيله وسجلّ تحميله، ولم تحمل سجلّ إقراراته — وهي
 * المكان الذي يُسأل فيه «ماذا أقرّ هذا الرجل هذا الشهر». والشاشتان القائمتان
 * لا تجيبان: «الحصيلة» تقطع الفريق كلّه في يوم، و«تقرير الفريق» يطوي المدّة
 * كلّها في صفٍّ واحد لكل مندوب. */
const DR_STATUS: Record<string, { label: string; cls: string }> = {
  APPROVED: { label: 'معتمد', cls: 'bg-green-50 text-green-700 border-green-200' },
  PENDING: { label: 'قيد المراجعة', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  RETURNED: { label: 'معاد للتصحيح', cls: 'bg-red-50 text-red-700 border-red-200' },
};

interface DrField { id: string; label: string; kind: string }
interface DrRow {
  id: string; reportDate: string; status: string; round: number; note: string | null;
  submittedAt: string | null; approvedAt: string | null; soloApproved: boolean;
  currentLevelName: string | null; values: Record<string, number | string | null>;
}

function RepDailyReportsModal({ rep, onClose }: { rep: SalesRep; onClose: () => void }) {
  const tr = useTr();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const rangeOn = !!(from || to);

  const q = useQuery({
    queryKey: ['rep-daily-reports', rep.id, from, to],
    queryFn: async () => (await dailyReportApi.repHistory(rep.id, { from: from || undefined, to: to || undefined })).data.data as {
      rep: { id: string; name: string };
      fields: DrField[];
      rows: DrRow[];
      meta: { from: string; to: string; capped: boolean; cappedNote: string | null; approved: number; pending: number; returned: number };
    },
  });

  const fields = q.data?.fields ?? [];
  const rows = q.data?.rows ?? [];
  const meta = q.data?.meta;

  /* عرض القيمة بنوع خانتها: المبلغ بعملة الشركة، والعدد بفواصله، والنصّ كما
   * كُتب. و«لا قيمة» شرطةٌ لا صفر — الصفر إقرارٌ بأن اليوم كان صفراً. */
  const show = (f: DrField, v: number | string | null) => {
    if (v === null || v === undefined || v === '') return '—';
    if (f.kind === 'TEXT') return String(v);
    if (typeof v !== 'number') return String(v);
    return f.kind === 'MONEY' ? formatCurrency(v) : formatNumber(v);
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl flex flex-col max-h-[88vh]">
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#FBEBE2] rounded-xl flex items-center justify-center"><ClipboardList size={20} className="text-[#C94E28]" /></div>
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13]">{tr('سجل التقارير اليومية')}</h2>
              <p className="text-xs text-[#6E6557]">{rep.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500" aria-label={tr('إغلاق')} title={tr('إغلاق')}><X size={18} /></button>
        </div>

        <div className="p-5 space-y-3 overflow-y-auto">
          <div className="flex items-end gap-2 flex-wrap">
            <div>
              <label className="text-[11px] text-[#9A8F7E] block mb-1">{tr('من تاريخ')}</label>
              <input type="date" className="input py-1.5 text-xs" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} />
            </div>
            <div>
              <label className="text-[11px] text-[#9A8F7E] block mb-1">{tr('إلى تاريخ')}</label>
              <input type="date" className="input py-1.5 text-xs" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} />
            </div>
            {rangeOn && (
              <button type="button" onClick={() => { setFrom(''); setTo(''); }}
                className="text-[11px] font-semibold text-[#C94E28] hover:underline pb-2">{tr('إلغاء التصفية')}</button>
            )}
            {meta && (
              <div className="flex items-center gap-1.5 flex-wrap text-[11px] pb-1 mr-auto">
                <span className="px-2 py-1 rounded-full border bg-green-50 text-green-700 border-green-200">{tr('معتمد')}: {meta.approved}</span>
                <span className="px-2 py-1 rounded-full border bg-amber-50 text-amber-700 border-amber-200">{tr('قيد المراجعة')}: {meta.pending}</span>
                <span className="px-2 py-1 rounded-full border bg-red-50 text-red-700 border-red-200">{tr('معاد للتصحيح')}: {meta.returned}</span>
              </div>
            )}
          </div>

          {meta?.cappedNote && <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">{meta.cappedNote}</p>}

          {q.isLoading ? (
            <p className="text-center text-gray-400 text-sm py-8">{tr('جار التحميل')}</p>
          ) : q.isError ? (
            <p className="text-center text-red-500 text-sm py-8">{tr('تعذر تحميل السجل')}</p>
          ) : rows.length === 0 ? (
            <p className="text-center text-gray-400 text-sm py-8">
              {rangeOn ? tr('لا تقارير في هذا المدى') : tr('لا تقارير بعد')}
            </p>
          ) : (
            <div className="overflow-x-auto border border-[#E9E1D3] rounded-xl">
              <table className="w-full text-xs whitespace-nowrap">
                <thead className="bg-[#FAF7F0] text-[#6E6557]">
                  <tr>
                    <th className="text-right font-semibold px-3 py-2">{tr('اليوم')}</th>
                    <th className="text-right font-semibold px-3 py-2">{tr('الحالة')}</th>
                    <th className="text-right font-semibold px-3 py-2">{tr('رفع في')}</th>
                    <th className="text-right font-semibold px-3 py-2">{tr('اعتمد في')}</th>
                    {fields.map(f => <th key={f.id} className="text-right font-semibold px-3 py-2">{f.label}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F1EBDF]">
                  {rows.map(r => {
                    const st = DR_STATUS[r.status] ?? { label: r.status, cls: 'bg-gray-50 text-gray-600 border-gray-200' };
                    return (
                      <tr key={r.id} className="hover:bg-[#FAF7F0]">
                        <td className="px-3 py-2 font-semibold text-[#1F1A13]">
                          {formatDate(r.reportDate)}
                          {r.round > 1 && <span className="text-[10px] text-[#9A8F7E] mr-1">({tr('محاولة')} {r.round})</span>}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`px-2 py-0.5 rounded-full border ${st.cls}`}>{tr(st.label)}</span>
                          {/* عند أيّ مستوىً يقف الآن — وهو سبب تأخّره */}
                          {r.currentLevelName && <span className="text-[10px] text-[#9A8F7E] block mt-0.5">{tr('عند')} {r.currentLevelName}</span>}
                          {/* «اعتمده شخص واحد» يُعلَن هنا كما في الحصيلة */}
                          {r.soloApproved && <span className="text-[10px] text-amber-700 block mt-0.5">{tr('اعتمده شخص واحد')}</span>}
                        </td>
                        <td className="px-3 py-2 text-[#6E6557]">{r.submittedAt ? `${formatDate(r.submittedAt)} ${formatTime(r.submittedAt)}` : '—'}</td>
                        <td className="px-3 py-2 text-[#6E6557]">{r.approvedAt ? `${formatDate(r.approvedAt)} ${formatTime(r.approvedAt)}` : '—'}</td>
                        {fields.map(f => (
                          <td key={f.id} className={`px-3 py-2 ${f.kind === 'TEXT' ? 'text-[#6E6557] max-w-[220px] truncate' : 'text-[#1F1A13] font-semibold'}`}
                            title={f.kind === 'TEXT' ? String(r.values[f.id] ?? '') : undefined}>
                            {show(f, r.values[f.id] ?? null)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ملاحظات الأيّام أسفل الجدول لا عموداً فيه: نصٌّ حرّ يكسر عرض الصفّ */}
          {rows.some(r => r.note) && (
            <div className="border border-[#E9E1D3] rounded-xl divide-y divide-[#F1EBDF]">
              {rows.filter(r => r.note).map(r => (
                <p key={r.id} className="px-3 py-2 text-[11px] text-[#6E6557]">
                  <b className="text-[#1F1A13]">{formatDate(r.reportDate)}</b> · {r.note}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
