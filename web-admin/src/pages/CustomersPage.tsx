import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { customerApi, companyApi } from '../api/client';
import { Customer } from '../types';
import { formatCurrency, formatDate, statusLabels } from '../utils/format';
import { useTr } from '../i18n/strings';
import { SALES_CHANNELS, channelLabel } from '../lib/channels';
import { Plus, Search, Edit, FileText, FileBarChart2, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '../store/authStore';
import ConfirmDialog from '../components/ConfirmDialog';
import CustomerModal from '../components/forms/CustomerModal';
import CustomerStatementModal from '../components/forms/CustomerStatementModal';
import DocumentModal from '../components/DocumentModal';
import { useAccountingOn } from '../components/AccountingGate';
import { StatementDoc, statementDocFromData, Company } from '../rep/RepDocuments';
import { zatcaCollectOn } from '../lib/zatcaRegime';
import { BuyerField, BuyerRowLike } from '../lib/zatca/buyerData';
import { BUYER_FIELD_UI_LABELS_AR as BUYER_FIELD_LABELS_AR, buyerBadge } from '../lib/zatca/buyerForm';

/** فوترة ZATCA (Z5.1a، D2): سلّة قائمة بيانات الفوترة ('' = القائمة العادية) وصفّها كما يعيده الخادم (بلا حقول مالية). */
type BuyerBucket = '' | 'incomplete' | 'unclassified' | 'complete' | 'all';
type BuyerListRow = Customer & { bucket?: string | null; missingFields?: BuyerField[]; suggestedType?: string | null };
interface BuyerSummary { effectiveB2b: number; complete: number; incomplete: number; unclassifiedWithSignals: number; truncated: boolean }

export default function CustomersPage() {
  const qc = useQueryClient();
  const tr = useTr();
  const { user } = useAuthStore();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [channel, setChannel] = useState('');
  const [page, setPage] = useState(1);
  const [showModal, setShowModal] = useState(false);
  const [showStatement, setShowStatement] = useState(false);
  const [selected, setSelected] = useState<Customer | null>(null);
  const [docResult, setDocResult] = useState<StatementDoc | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Customer | null>(null);
  const [buyerBucket, setBuyerBucket] = useState<BuyerBucket>('');
  const [bucketCursors, setBucketCursors] = useState<(string | null)[]>([null]);
  const [picked, setPicked] = useState<string[]>([]);
  // بحث قائمة بيانات الفوترة مؤجَّل 300ms (كـ/m): كل طلب منها يمسح عملاء الشركة على دفعات — لا مسح لكل ضغطة
  const [bucketSearch, setBucketSearch] = useState('');

  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: async () => { const res = await companyApi.get(); return res.data.data as Company; },
  });

  // المحاسبة مطفأة ⇒ يختفي الرصيد والحد الائتماني وكشف الحساب من هذه الصفحة،
  // ويبقى العميل بهويته: الاسم والجوال والمدينة والقناة والحالة.
  /* «مفعّل» قبل وصول الإعداد يعني ومضةَ أرقامٍ ثم إخفاءها — وهي تسريبٌ حقيقي
   * يلتقطه المستخدم (والصورة). والعكس — ومضة إخفاءٍ ثم عرض — لا يُسرّب شيئاً،
   * ولا يتجمّد: `ready` تصدق أيضاً حين توقف الشبكةُ المحاولة، فتعود الدلالة
   * الافتراضية «مفعّل» ولا تُحجب الأرقام عمّن تعذّرت قراءة إعداداته. */
  const { on: accountingFlag, ready: accountingReady } = useAccountingOn();
  const accountingOn = accountingReady && accountingFlag;
  // فوترة ZATCA (Z5.1a، D2): الفلتر والشارات والملخّص للشركة التي تجمع بيانات الفوترة وحدها — غيرها كما اليوم
  const zatcaCollect = zatcaCollectOn(company);
  const bucketMode = zatcaCollect && buyerBucket !== '';
  const cols = bucketMode ? 9 : accountingOn ? 9 : 7;
  useEffect(() => {
    if (!zatcaCollect) return;
    const t = setTimeout(() => { setBucketSearch(search); setBucketCursors([null]); }, 300);
    return () => clearTimeout(t);
  }, [search, zatcaCollect]);
  // «جميع الحالات» ('') = كل الحالات في قائمة الفوترة وملخّصها أيضاً (كالقائمة العادية) — لا «النشطون» خفيةً
  const buyerStatus = status || 'ALL';

  const { data, isLoading } = useQuery({
    queryKey: ['customers', search, status, channel, page],
    queryFn: async () => {
      const res = await customerApi.list({ search, status, channel, page, limit: 15 });
      return res.data as { data: Customer[]; pagination: { total: number; pages: number } };
    },
    enabled: !bucketMode,
  });

  const bucketCursor = bucketCursors[bucketCursors.length - 1];
  const buyerList = useQuery({
    queryKey: ['customers', 'zatca-buyer-data', buyerBucket, bucketSearch, buyerStatus, bucketCursor],
    queryFn: async () => {
      // summary: '0' دائماً — العدّادات من استعلام الملخّص أدناه، فلا مسح كامل ثانٍ مع كل صفحة
      const res = await customerApi.buyerData({ bucket: buyerBucket, search: bucketSearch, status: buyerStatus, limit: 50, summary: '0', ...(bucketCursor ? { cursor: bucketCursor } : {}) });
      return res.data as { data: BuyerListRow[]; nextCursor: string | null };
    },
    enabled: bucketMode,
  });
  const buyerSummary = useQuery({
    queryKey: ['customers', 'zatca-buyer-summary', buyerStatus],
    queryFn: async () => (await customerApi.buyerData({ limit: 0, status: buyerStatus })).data.summary as BuyerSummary,
    enabled: zatcaCollect,
    staleTime: 60_000,
  });
  const rows: BuyerListRow[] | undefined = bucketMode ? buyerList.data?.data : data?.data;
  const rowsLoading = bucketMode ? buyerList.isLoading : isLoading;
  const selectable = (c: BuyerListRow) => bucketMode && !c.buyerType && c.suggestedType === 'BUSINESS';
  const chooseBucket = (b: BuyerBucket) => { setBuyerBucket(b); setBucketCursors([null]); setPicked([]); };

  const applySuggested = useMutation({
    mutationFn: (ids: string[]) => customerApi.applySuggestedType(ids),
    onSuccess: (res) => {
      toast.success(`${tr('تم تصنيف العملاء منشآت')}: ${res.data?.data?.updated ?? 0}`);
      setPicked([]);
      qc.invalidateQueries({ queryKey: ['customers'] });
    },
    onError: (err: unknown) => toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('حدث خطأ')),
  });

  const saveMutation = useMutation({
    mutationFn: (values: Partial<Customer>) =>
      selected ? customerApi.update(selected.id, values) : customerApi.create(values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      toast.success(selected ? tr('تم تحديث العميل') : tr('تم إضافة العميل'));
      setShowModal(false);
      setSelected(null);
    },
    onError: (err: unknown) => toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('حدث خطأ')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => customerApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      toast.success(tr('تم حذف العميل'));
      setDeleting(null);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر حذف العميل');
      toast.error(msg);
      setDeleting(null);
    },
  });

  const openEdit = (c: Customer) => { setSelected(c); setShowModal(true); };
  // صفّ قائمة الفوترة بلا الحقول المالية والبريد والعنوان — التعديل يحمّل العميل كاملاً أولاً (وإلا مسح الحفظُ ما غاب)
  const openEditRow = async (c: Customer) => {
    if (!bucketMode) { openEdit(c); return; }
    try {
      const res = await customerApi.get(c.id);
      openEdit(res.data.data as Customer);
    } catch { toast.error(tr('تعذر فتح العميل')); }
  };
  const openStatement = (c: Customer) => { setSelected(c); setShowStatement(true); };
  const openAdd = () => { setSelected(null); setShowModal(true); };

  // فتح مباشر لكشف حساب عميل عبر ?open=<id> (من زر «ملف العميل» في خريطة التتبّع)
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    // ننتظر قراءة إعداد الشركة أوّلاً: العَلَم يبدأ «مفعّلاً» قبل وصول الرد،
    // ولو فتحنا قبل وصوله لجلبنا كشف حساب شركةٍ محاسبتُها مطفأة.
    if (!accountingReady) return;
    const openId = searchParams.get('open');
    if (!openId) return;
    // كشف الحساب مالي: لا يُجلب ولا يُفتح حين تكون المحاسبة مطفأة — ويُنظَّف
    // الرابط كي لا يعاود المحاولة عند كل تحديث.
    if (!accountingOn) {
      searchParams.delete('open');
      setSearchParams(searchParams, { replace: true });
      return;
    }
    (async () => {
      try {
        const res = await customerApi.get(openId);
        const c = res.data.data as Customer;
        if (c) { setSelected(c); setShowStatement(true); }
      } catch { toast.error(tr('تعذر فتح كشف حساب العميل')); }
      // نظّف الرابط كي لا يُعاد الفتح عند التحديث
      searchParams.delete('open');
      setSearchParams(searchParams, { replace: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountingReady]);

  // كشف حساب PDF بنفس شكل المندوب
  const openStatementPdf = async (c: Customer) => {
    setOpeningId(c.id);
    try {
      const res = await customerApi.statement(c.id);
      const { customer, entries } = res.data.data;
      setDocResult(statementDocFromData(customer, entries, user?.name || tr('الإدارة'), company));
    } catch { toast.error(tr('تعذر فتح الكشف')); }
    setOpeningId(null);
  };

  const statusBadge = (s: string) => {
    const map: Record<string, string> = { ACTIVE: 'badge-active', INACTIVE: 'badge-inactive', BLOCKED: 'badge-blocked' };
    return <span className={map[s] || ''}>{tr(statusLabels[s])}</span>;
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{tr('إدارة العملاء')}</h1>
        <button className="btn-primary" onClick={openAdd}><Plus size={16} />{tr('إضافة عميل')}</button>
      </div>

      {/* Filters */}
      <div className="card mb-4">
        <div className="flex gap-3 flex-wrap">
          <div className="relative flex-1 min-w-48">
            <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input className="input pr-9" placeholder={tr('بحث بالاسم أو الجوال أو الكود')} value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }} />
          </div>
          <select className="input w-40" value={status} onChange={e => { setStatus(e.target.value); setPage(1); setBucketCursors([null]); }}>
            <option value="">{tr('جميع الحالات')}</option>
            <option value="ACTIVE">{tr('نشط')}</option>
            <option value="INACTIVE">{tr('غير نشط')}</option>
            <option value="BLOCKED">{tr('محظور')}</option>
          </select>
          <select className="input w-44" value={bucketMode ? '' : channel} disabled={bucketMode} onChange={e => { setChannel(e.target.value); setPage(1); }}>
            <option value="">{tr('جميع القنوات')}</option>
            {SALES_CHANNELS.map((c) => (
              <option key={c.code} value={c.code}>{tr(c.ar)}</option>
            ))}
          </select>
          {zatcaCollect && (
            <select className="input w-52" value={buyerBucket} onChange={e => chooseBucket(e.target.value as BuyerBucket)}>
              <option value="">{tr('الفوترة الإلكترونية كل العملاء')}</option>
              <option value="incomplete">{tr('بيانات فوترة ناقصة')}</option>
              <option value="unclassified">{tr('غير مصنف')}</option>
              <option value="complete">{tr('بيانات فوترة مكتملة')}</option>
              <option value="all">{tr('المنشآت وغير المصنفين')}</option>
            </select>
          )}
        </div>
        {/* ملخّص بيانات الفوترة (D2) — إعلامي: لا يمنع حفظاً ولا بيعاً قبل التفعيل */}
        {zatcaCollect && buyerSummary.data && (
          <div className="flex items-center gap-2 flex-wrap mt-3 text-xs">
            <button type="button" onClick={() => chooseBucket('incomplete')} className="px-2.5 py-1 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
              {tr('بيانات فوترة ناقصة')} ({buyerSummary.data.incomplete})
            </button>
            <button type="button" onClick={() => chooseBucket('unclassified')} className="px-2.5 py-1 rounded-full bg-slate-50 text-slate-700 border border-slate-200">
              {tr('غير مصنف')} ({buyerSummary.data.unclassifiedWithSignals})
            </button>
            <button type="button" onClick={() => chooseBucket('complete')} className="px-2.5 py-1 rounded-full bg-green-50 text-green-800 border border-green-200">
              {tr('بيانات فوترة مكتملة')} ({buyerSummary.data.complete})
            </button>
            {bucketMode && picked.length > 0 && (
              <button type="button" disabled={applySuggested.isPending} onClick={() => applySuggested.mutate(picked)}
                className="btn-primary text-xs py-1 px-3 mr-auto">
                {tr('اعتماد التصنيف المقترح منشأة')} ({picked.length})
              </button>
            )}
          </div>
        )}
      </div>

      {/* Table */}
      <div className="card p-0">
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                {bucketMode && <th />}
                <th>{tr('الكود')}</th><th>{tr('العميل')}</th><th>{tr('الجوال')}</th><th>{tr('المدينة')}</th><th>{tr('القناة')}</th>
                {accountingOn && !bucketMode && <th>{tr('الرصيد')}</th>}
                {accountingOn && !bucketMode && <th>{tr('الحد الائتماني')}</th>}
                {bucketMode && <th>{tr('نواقص الفاتورة الضريبية')}</th>}
                <th>{tr('الحالة')}</th><th>{tr('إجراءات')}</th>
              </tr>
            </thead>
            <tbody>
              {rowsLoading ? (
                <tr><td colSpan={cols} className="text-center py-12 text-gray-400">{tr('جاري التحميل')}</td></tr>
              ) : rows?.length === 0 ? (
                <tr><td colSpan={cols} className="text-center py-12 text-gray-400">{tr('لا توجد نتائج')}</td></tr>
              ) : rows?.map(c => {
                const badge = !zatcaCollect ? null : bucketMode ? (c.bucket === 'incomplete' || c.bucket === 'unclassified' ? c.bucket : null) : buyerBadge(c as BuyerRowLike);
                return (
                <tr key={c.id}>
                  {bucketMode && (
                    <td>
                      {selectable(c) && (
                        <input type="checkbox" className="w-4 h-4 accent-[#E15A30]" checked={picked.includes(c.id)} aria-label={tr('اعتماد التصنيف المقترح منشأة')}
                          onChange={e => setPicked(p => (e.target.checked ? [...p, c.id] : p.filter(x => x !== c.id)))} />
                      )}
                    </td>
                  )}
                  <td className="font-mono text-xs text-gray-500">{c.code}</td>
                  <td>
                    <p className="font-medium text-gray-800">{c.name}</p>
                    {c.businessName && <p className="text-xs text-gray-400">{c.businessName}</p>}
                    {badge && (
                      <span className={`inline-block mt-0.5 text-[10px] px-1.5 py-0.5 rounded-full ${badge === 'incomplete' ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-600'}`}>
                        {badge === 'incomplete' ? tr('بيانات فوترة ناقصة') : tr('غير مصنف')}
                      </span>
                    )}
                  </td>
                  <td className="text-gray-600 font-mono">{c.phone}</td>
                  <td className="text-gray-600">{c.city || '-'}</td>
                  <td>
                    {c.channel
                      ? <span className="inline-block text-xs px-2 py-0.5 rounded-full bg-[#FBEBE2] text-[#C94E28] whitespace-nowrap">{tr(channelLabel(c.channel))}</span>
                      : <span className="text-gray-300">-</span>}
                  </td>
                  {accountingOn && !bucketMode && (
                    <td className={`font-semibold ${Number(c.balance) > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                      {formatCurrency(c.balance)}
                    </td>
                  )}
                  {accountingOn && !bucketMode && <td className="text-gray-600">{formatCurrency(c.creditLimit)}</td>}
                  {bucketMode && (
                    <td className="text-xs text-gray-600 max-w-[16rem]">
                      {c.missingFields?.length
                        ? c.missingFields.map(f => tr(BUYER_FIELD_LABELS_AR[f])).join('، ')
                        : c.bucket === 'unclassified' ? tr('حدد نوع العميل هل هو منشأة أم فرد') : '-'}
                    </td>
                  )}
                  <td>{statusBadge(c.status)}</td>
                  <td>
                    <div className="flex items-center gap-2">
                      <button onClick={() => openEditRow(c)} className="p-1.5 hover:bg-[#FBEBE2] rounded text-[#E15A30]" title={tr('تعديل')}>
                        <Edit size={14} />
                      </button>
                      {/* كشف الحساب فعلٌ محاسبي: زرّاه يختفيان مع المحاسبة */}
                      {accountingOn && !bucketMode && (
                        <button onClick={() => openStatement(c)} className="p-1.5 hover:bg-green-50 rounded text-green-600" title={tr('كشف حساب عرض')}>
                          <FileText size={14} />
                        </button>
                      )}
                      {accountingOn && !bucketMode && (
                        <button onClick={() => openStatementPdf(c)} className="p-1.5 hover:bg-slate-100 rounded text-slate-600" title={tr('كشف حساب PDF')}>
                          {openingId === c.id ? <span className="w-3.5 h-3.5 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin inline-block" /> : <FileBarChart2 size={14} />}
                        </button>
                      )}
                      <button onClick={() => setDeleting(c)} className="p-1.5 hover:bg-red-50 rounded text-red-600" title={tr('حذف العميل')}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* صفحات قائمة بيانات الفوترة (بالمؤشّر) */}
        {bucketMode && (bucketCursors.length > 1 || buyerList.data?.nextCursor) && (
          <div className="flex items-center justify-end gap-1 px-4 py-3 border-t border-gray-100">
            <button className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40" disabled={bucketCursors.length <= 1} onClick={() => setBucketCursors(cs => cs.slice(0, -1))}>
              <ChevronRight size={16} />
            </button>
            <span className="text-sm text-gray-600 px-2">{bucketCursors.length}</span>
            <button className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40" disabled={!buyerList.data?.nextCursor} onClick={() => setBucketCursors(cs => [...cs, buyerList.data!.nextCursor])}>
              <ChevronLeft size={16} />
            </button>
          </div>
        )}

        {/* Pagination */}
        {!bucketMode && data && data.pagination.pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
            <p className="text-sm text-gray-500">{tr('إجمالي')}: {data.pagination.total} {tr('عميل')}</p>
            <div className="flex items-center gap-1">
              <button className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                <ChevronRight size={16} />
              </button>
              <span className="text-sm text-gray-600 px-2">{page} / {data.pagination.pages}</span>
              <button className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40" disabled={page >= data.pagination.pages} onClick={() => setPage(p => p + 1)}>
                <ChevronLeft size={16} />
              </button>
            </div>
          </div>
        )}
      </div>

      {showModal && (
        <CustomerModal
          accountingOn={accountingOn}
          zatcaCollect={zatcaCollect}
          customer={selected}
          onClose={() => { setShowModal(false); setSelected(null); }}
          onSave={saveMutation.mutate}
          loading={saveMutation.isPending}
        />
      )}

      {showStatement && selected && (
        <CustomerStatementModal customer={selected} onClose={() => { setShowStatement(false); setSelected(null); }} />
      )}

      {docResult && <DocumentModal doc={docResult} onClose={() => setDocResult(null)} />}

      {deleting && (
        <ConfirmDialog
          danger
          title={tr('حذف العميل')}
          message={`${tr('سيتم حذف العميل')} «${deleting.name}» ${tr('نهائيا ولا يمكن التراجع إن كان لديه فواتير أو سندات أو حركات في كشف حسابه فلن يحذف ويمكنك تعطيله بدلا من ذلك')}`}
          confirmLabel={tr('حذف نهائي')}
          loading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
