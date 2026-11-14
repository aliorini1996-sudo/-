import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { receiptApi, companyApi, salesRepApi } from '../api/client';
import { Receipt, SalesRep } from '../types';
import { formatCurrency, formatDate, formatTime, formatDateTime } from '../utils/format';
import { methodIdentity, methodLabelFor } from '../lib/paymentMethodsConfig';
import PaymentMethodIcon from '../components/PaymentMethodIcon';
import { useTr } from '../i18n/strings';
import { invalidateAfterReceipt } from '../lib/receiptEffects';
import { Plus, XCircle, ChevronLeft, ChevronRight, FileText, Download } from 'lucide-react';
import toast from 'react-hot-toast';
import ReceiptModal from '../components/forms/ReceiptModal';
import DocumentModal from '../components/DocumentModal';
import ConfirmDialog from '../components/ConfirmDialog';
import { ReceiptDoc, receiptDocFromDetail, Company } from '../rep/RepDocuments';
import { shareOrDownloadExcel, num } from '../utils/excel';
import { useAccountingOn, AccountingOffNotice } from '../components/AccountingGate';
import { withLiveCompany } from '../rep/companyRefresh';
import { useOwnerBulkPurge } from '../components/OwnerBulkPurge';
// «ربط الدفاتر» C11: من أين رُدّ مال سند العهدة المُسلَّم؟ — للدفاتر المربوطة وحدها، وغيرها يُلغى بلا جسم كما كان
import { ledgerOpsKeys, type ReceiptCancelOptions } from '../api/ledgerOps';
import { cancelRefundSourceLabels, receiptCancelCodeLabels } from '../lib/ledger/labels';
import {
  cancelRequestBody, initialRefundChoice, receiptMayNeedRefundSource, refundChoiceComplete, refundPickerVisible, type RefundChoice,
} from '../lib/ledger/sync';

/** جلب إعدادات الشركة — نفسه للاستعلام ولـensureQueryData عند فتح مستند قبل اكتمال تحميلها (D-G6) */
const fetchCompany = async () => { const res = await companyApi.get(); return res.data.data as Company; };

export default function ReceiptsPage() {
  const qc = useQueryClient();
  const tr = useTr();
  const [page, setPage] = useState(1);
  const [salesRepId, setSalesRepId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [exporting, setExporting] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [docResult, setDocResult] = useState<ReceiptDoc | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [refundChoice, setRefundChoice] = useState<RefundChoice | null>(null);

  const { data: company } = useQuery({ queryKey: ['company'], queryFn: fetchCompany });
  // «نصوص المطبوعات» تصل المستند المفتوح: تجدّد إعدادات الشركة يُستبدل في نسخته (لا نصوص لحظة الفتح)
  useEffect(() => { setDocResult(d => (d ? withLiveCompany(d, company) : d)); }, [company]);

  // سندات القبض تحصيلٌ خالص: الصفحة كلّها تختفي مع المحاسبة ولا تُصدر طلباً
  const { on: accountingOn, ready: accountingReady } = useAccountingOn();

  const { data: reps } = useQuery({
    queryKey: ['sales-reps-all'],
    queryFn: async () => { const res = await salesRepApi.list({ limit: 200 }); return res.data.data as SalesRep[]; },
    enabled: accountingReady && accountingOn,
  });

  const filters = () => {
    const f: Record<string, string | number> = {};
    if (salesRepId) f.salesRepId = salesRepId;
    // كلٌّ على حدة (راجع صفحة الفواتير): الطرف الغائب = بلا حدّ لا إلغاءَ للتصفية
    if (from) f.from = from;
    if (to) f.to = to;
    return f;
  };

  const { data, isLoading } = useQuery({
    queryKey: ['receipts', salesRepId, from, to, page],
    queryFn: async () => {
      const res = await receiptApi.list({ ...filters(), page, limit: 15 });
      return res.data as { data: Receipt[]; pagination: { total: number; pages: number } };
    },
    enabled: accountingReady && accountingOn,
  });

  // تصدير/مشاركة السندات
  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await receiptApi.list({ ...filters(), limit: 5000 });
      const receipts = res.data.data as Receipt[];
      if (!receipts.length) { toast.error(tr('لا توجد سندات للتصدير')); setExporting(false); return; }
      const rows = receipts.map(r => ({
        [tr('رقم السند')]: r.number,
        [tr('العميل')]: r.customer.name,
        [tr('المندوب')]: r.salesRep?.name ?? '—',
        [tr('المبلغ')]: num(r.amount),
        // «إدارة طرق الدفع»: اسم الشركة للطريقة (مضافة أو مدمجة سمّتها)، وإلا الافتراضي مترجماً كما اليوم
        [tr('طريقة الدفع')]: methodLabelFor(company, r.paymentMethod, r.paymentMethodKey, tr),
        [tr('التاريخ')]: formatDate(r.receiptDate),
        [tr('الوقت')]: formatTime(issuedAt(r)),
        [tr('الحالة')]: r.status === 'ACTIVE' ? tr('نشط') : tr('ملغي'),
      }));
      const out = await shareOrDownloadExcel(
        [{ name: tr('سندات القبض'), rows, colWidths: [18, 24, 16, 12, 14, 16, 10, 10] }],
        `${tr('سندات القبض')}-${new Date().toISOString().slice(0, 10)}`
      );
      toast.success(out === 'shared' ? tr('تمت المشاركة') : `${tr('تم تصدير')} ${rows.length} ${tr('سند')}`);
    } catch { toast.error(tr('تعذر التصدير')); }
    setExporting(false);
  };

  // فتح مستند PDF لسند موجود (جديد أو قديم) بنفس شكل المندوب
  const openReceiptPdf = async (id: string) => {
    setOpeningId(id);
    try {
      const res = await receiptApi.get(id);
      // فُتح قبل اكتمال تحميل الشركة (أو تعثّرها): تُطلب الآن، وإلا خرج بالنصوص الافتراضية وترويسة فارغة (D-G6)
      let co = company;
      try { co = company ?? await qc.ensureQueryData({ queryKey: ['company'], queryFn: fetchCompany }); } catch { /* يبقى الحالي */ }
      setDocResult(receiptDocFromDetail(res.data.data, '', co));
    } catch { toast.error(tr('تعذر فتح المستند')); }
    setOpeningId(null);
  };

  /* «ربط الدفاتر» C11: خيارات ردّ المال قبل التأكيد (قراءة بلا كتابة). تعذّرها أو الشركة غير المربوطة ⇒ لا منتقي ولا جسم،
   * فالإلغاء حرفياً كما كان (cancelRequestBody ⇒ undefined ⇒ PATCH بلا جسم) */
  const optionsEnabled = !!cancelId && receiptMayNeedRefundSource(data?.data.find(r => r.id === cancelId));
  const cancelOptionsQ = useQuery({
    queryKey: ledgerOpsKeys.receiptCancelOptions(cancelId ?? ''),
    queryFn: async () => (await receiptApi.cancelOptions(cancelId!)).data.data as ReceiptCancelOptions,
    enabled: optionsEnabled,
    retry: false,
    staleTime: 0,
  });
  const cancelOptions = optionsEnabled && !cancelOptionsQ.isError ? cancelOptionsQ.data ?? null : null;
  useEffect(() => { setRefundChoice(initialRefundChoice(cancelOptions)); }, [cancelOptions]);

  const cancelMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body?: { refundFrom: string; refundFromUserId?: string } }) => receiptApi.cancel(id, body),
    onSuccess: () => { invalidateAfterReceipt(qc); toast.success(tr('تم إلغاء السند')); },
    onError: (e: unknown) => {
      const code = (e as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
      toast.error((typeof code === 'string' && receiptCancelCodeLabels(tr)[code]) || tr('خطأ في الإلغاء'));
    },
  });

  const purge = useOwnerBulkPurge('Receipt');

  // لون الشارة بالأساس (المضافة تأخذ لون ما تُعامل مثله) والاسم من الشركة — والمضافة بأيقونتها كي لا تُقرأ مدمجةً بلونها
  const methodBadge = (m: string, key?: string | null) => {
    const who = methodIdentity(company, m, key);
    const colors: Record<string, string> = {
      CASH: 'bg-green-100 text-green-700', BANK_TRANSFER: 'bg-[#FBEBE2] text-[#C94E28]',
      POS: 'bg-purple-100 text-purple-700', CHEQUE: 'bg-orange-100 text-orange-700',
      ONLINE: 'bg-sky-100 text-sky-700',
    };
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${colors[who.base] || 'bg-gray-100 text-gray-600'}`}>
        {who.custom && <PaymentMethodIcon icon={who.icon} base={who.base} size={11} />}
        {methodLabelFor(company, m, key, tr)}
      </span>
    );
  };

  // لحظة إصدار السند الفعلية: على جهاز المندوب إن وُجدت (السند الأوف‑لاين يُحرَّر في
  // الميدان ويُرفع بعد ساعات)، وإلا لحظة الإنشاء على الخادم. لا نستخدم receiptDate
  // لأنه قد يُضبط من منتقي تاريخ (بلا وقت = منتصف الليل) أو يُؤرَّخ بأثر رجعي.
  const issuedAt = (r: Receipt) => r.clientCreatedAt || r.createdAt;

  if (!accountingReady) return null;
  if (!accountingOn) return <AccountingOffNotice />;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{tr('سندات القبض')}</h1>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={handleExport} disabled={exporting}>
            {exporting ? <span className="w-4 h-4 border-2 border-gray-300 border-t-[#E15A30] rounded-full animate-spin" /> : <Download size={16} />}
            {tr('تصدير Excel')}
          </button>
          <button className="btn-primary" onClick={() => setShowCreate(true)}><Plus size={16} />{tr('سند جديد')}</button>
        </div>
      </div>

      {/* Filters */}
      <div className="card mb-4">
        <div className="flex gap-3 flex-wrap items-end">
          <select className="input w-40" value={salesRepId} onChange={e => { setSalesRepId(e.target.value); setPage(1); }}>
            <option value="">{tr('كل المناديب')}</option>
            {reps?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <div>
            <label className="label text-xs">{tr('من تاريخ')}</label>
            <input type="date" className="input w-40" value={from} onChange={e => { setFrom(e.target.value); setPage(1); }} />
          </div>
          <div>
            <label className="label text-xs">{tr('إلى تاريخ')}</label>
            <input type="date" className="input w-40" value={to} onChange={e => { setTo(e.target.value); setPage(1); }} />
          </div>
          {(from || to || salesRepId) && (
            <button className="btn-secondary" onClick={() => { setFrom(''); setTo(''); setSalesRepId(''); setPage(1); }}>{tr('مسح الفلاتر')}</button>
          )}
        </div>
      </div>

      {purge.bar}
      <div className="card p-0">
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                {purge.enabled && <th className="w-8 px-2">{purge.headerBox((data?.data ?? []).map(r => r.id))}</th>}
                <th>{tr('رقم السند')}</th><th>{tr('العميل')}</th><th>{tr('المندوب')}</th>
                <th>{tr('المبلغ')}</th><th>{tr('طريقة الدفع')}</th><th>{tr('التاريخ')}</th><th>{tr('الوقت')}</th><th>{tr('الحالة')}</th><th>{tr('إجراءات')}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={9 + (purge.enabled ? 1 : 0)} className="text-center py-12 text-gray-400">{tr('جاري التحميل')}</td></tr>
              ) : data?.data.length === 0 ? (
                <tr><td colSpan={9 + (purge.enabled ? 1 : 0)} className="text-center py-12 text-gray-400">{tr('لا توجد سندات')}</td></tr>
              ) : data?.data.map(r => (
                <tr key={r.id}>
                  {purge.enabled && <td className="w-8 px-2">{purge.rowBox(r.id)}</td>}
                  <td className="font-mono text-sm text-green-600">{r.number}</td>
                  <td className="font-medium text-gray-800">{r.customer.name}</td>
                  <td className="text-gray-600 text-sm">{r.salesRep?.name ?? '—'}</td>
                  <td className="font-bold text-green-700">{formatCurrency(r.amount)}</td>
                  <td>{methodBadge(r.paymentMethod, r.paymentMethodKey)}</td>
                  <td className="text-xs text-gray-400">{formatDate(r.receiptDate)}</td>
                  <td className="text-xs text-gray-500 font-mono whitespace-nowrap" title={formatDateTime(issuedAt(r))}>
                    {formatTime(issuedAt(r))}
                  </td>
                  <td>
                    <span className={r.status === 'ACTIVE' ? 'badge-active' : 'badge-cancelled'}>
                      {r.status === 'ACTIVE' ? tr('نشط') : tr('ملغي')}
                    </span>
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <button onClick={() => openReceiptPdf(r.id)} className="p-1.5 hover:bg-[#FBEBE2] rounded text-[#E15A30]" title={tr('عرض / PDF')}>
                        {openingId === r.id ? <span className="w-3.5 h-3.5 border-2 border-[#F5C9BA] border-t-[#E15A30] rounded-full animate-spin inline-block" /> : <FileText size={14} />}
                      </button>
                      {r.status === 'ACTIVE' && (
                        <button
                          onClick={() => setCancelId(r.id)}
                          className="p-1.5 hover:bg-red-50 rounded text-red-500"
                          title={tr('إلغاء')}
                        >
                          <XCircle size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && data.pagination.pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
            <p className="text-sm text-gray-500">{tr('إجمالي')}: {data.pagination.total} {tr('سند')}</p>
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

      {showCreate && (
        <ReceiptModal
          onClose={() => setShowCreate(false)}
          onSaved={(doc) => { setShowCreate(false); invalidateAfterReceipt(qc); setDocResult(doc); }}
        />
      )}
      {docResult && <DocumentModal doc={docResult} onClose={() => setDocResult(null)} />}
      {cancelId && (
        <ConfirmDialog
          title={tr('إلغاء سند القبض')}
          message={tr('هل تريد إلغاء هذا السند سيعكس أثره على رصيد العميل')}
          confirmLabel={tr('نعم إلغاء')}
          danger
          loading={cancelMutation.isPending || cancelOptionsQ.isFetching}
          extra={refundPickerVisible(cancelOptions) ? (
            <RefundSourcePicker options={cancelOptions} choice={refundChoice} onChange={setRefundChoice} />
          ) : undefined}
          onConfirm={() => {
            if (!refundChoiceComplete(cancelOptions, refundChoice)) { toast.error(tr('اختر مصدر ردّ المال')); return; }
            cancelMutation.mutate({ id: cancelId, body: cancelRequestBody(cancelOptions, refundChoice) }, { onSettled: () => setCancelId(null) });
          }}
          onClose={() => setCancelId(null)}
        />
      )}
    </div>
  );
}

/**
 * «من أين رُدّ المال؟» (C11): سند عهدةٍ سلّم المندوبُ ماله ثم أُلغي — عكسه من عهدة المندوب يجعلها سالبة، فيُسجَّل المصدر الفعلي
 * للردّ (عهدة المندوب، أو عهدة آخر مستخدم استلم، أو الصندوق، أو البنك). المقترح من الخادم محدّد مسبقاً.
 */
function RefundSourcePicker({ options, choice, onChange }: {
  options: ReceiptCancelOptions; choice: RefundChoice | null; onChange: (c: RefundChoice) => void;
}) {
  const tr = useTr();
  const labels = cancelRefundSourceLabels(tr);
  return (
    <div className="mt-3 text-start space-y-1.5" role="radiogroup" aria-label={tr('من أين رُدّ المال؟')}>
      <p className="text-sm font-semibold text-[#1F1A13]">{tr('من أين رُدّ المال؟')}</p>
      <p className="text-[11px] text-[#9A8F7E] leading-relaxed">{tr('سلّم المندوب مال هذا السند بعد تحصيله، فحدّد من أين رُدّ للعميل كي لا تصير عهدته سالبة في الدفاتر')}</p>
      {options.options.map(o => {
        const checked = choice?.refundFrom === o.value;
        return (
          <label key={o.value} className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-sm cursor-pointer ${checked ? 'border-[#E15A30] bg-[#FBEBE2]' : 'border-[#E8E0D2]'}`}>
            <input type="radio" name="refund-from" className="mt-1" checked={checked}
              onChange={() => onChange({ refundFrom: o.value, userId: o.value === 'USER_CUSTODY' ? o.userId ?? options.suggestedUserId ?? null : null })} />
            <span className="min-w-0">
              <span className="block">
                {labels[o.value] ?? o.value}
                {o.value === options.suggested && <span className="ms-1 text-[11px] text-[#E15A30]">({tr('المقترح')})</span>}
              </span>
              {o.value === 'USER_CUSTODY' && (
                <span className="block text-[11px] text-[#6E6557]">
                  {o.userName ?? ''}{o.userOutstanding != null && <> · {tr('عهدته')}: <bdi>{formatCurrency(o.userOutstanding)}</bdi></>}
                </span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}
