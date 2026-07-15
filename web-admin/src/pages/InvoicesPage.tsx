import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invoiceApi, companyApi, salesRepApi } from '../api/client';
import { Invoice, SalesRep } from '../types';
import { formatCurrency, formatDate, statusLabels } from '../utils/format';
import { useTr } from '../i18n/strings';
import { Plus, Search, FileText, XCircle, ChevronLeft, ChevronRight, Download } from 'lucide-react';
import toast from 'react-hot-toast';
import InvoiceModal from '../components/forms/InvoiceModal';
import DocumentModal from '../components/DocumentModal';
import ConfirmDialog from '../components/ConfirmDialog';
import { InvoiceDoc, invoiceDocFromDetail, Company } from '../rep/RepDocuments';
import { shareOrDownloadExcel, num } from '../utils/excel';

export default function InvoicesPage() {
  const qc = useQueryClient();
  const tr = useTr();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('CONFIRMED');
  const [type, setType] = useState('');
  const [salesRepId, setSalesRepId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [docResult, setDocResult] = useState<InvoiceDoc | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);

  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: async () => { const res = await companyApi.get(); return res.data.data as Company; },
  });

  const { data: reps } = useQuery({
    queryKey: ['sales-reps-all'],
    queryFn: async () => { const res = await salesRepApi.list({ limit: 200 }); return res.data.data as SalesRep[]; },
  });

  // معاملات التصفية المشتركة (تُستخدم في الجدول والتصدير)
  const filters = () => {
    const f: Record<string, string | number> = {};
    if (search) f.search = search;
    if (status) f.status = status;
    if (type) f.type = type;
    if (salesRepId) f.salesRepId = salesRepId;
    if (from && to) { f.from = from; f.to = to; }
    return f;
  };

  const { data, isLoading } = useQuery({
    queryKey: ['invoices', search, status, type, salesRepId, from, to, page],
    queryFn: async () => {
      const res = await invoiceApi.list({ ...filters(), page, limit: 15 });
      return res.data as { data: Invoice[]; pagination: { total: number; pages: number } };
    },
  });

  // فتح مستند PDF لفاتورة موجودة (جديدة أو قديمة) بنفس شكل المندوب
  const openInvoicePdf = async (id: string) => {
    setOpeningId(id);
    try {
      const res = await invoiceApi.get(id);
      setDocResult(invoiceDocFromDetail(res.data.data, '', company));
    } catch { toast.error(tr('تعذّر فتح المستند')); }
    setOpeningId(null);
  };

  const cancelMutation = useMutation({
    mutationFn: (id: string) => invoiceApi.cancel(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['invoices'] }); toast.success(tr('تم إلغاء الفاتورة')); },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('خطأ');
      toast.error(msg);
    },
  });

  // تحكّم الأدمن: هل يعود المرتجع لمخزون السيارة؟
  const restockMutation = useMutation({
    mutationFn: ({ id, returnToStock }: { id: string; returnToStock: boolean }) => invoiceApi.setRestock(id, returnToStock),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['invoices'] }); toast.success(tr('تم تحديث عودة المرتجع للمخزون')); },
    onError: (err: unknown) => toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('خطأ')),
  });

  // تصدير/مشاركة الفواتير (وفق الفلاتر الحالية)
  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await invoiceApi.list({ ...filters(), limit: 5000 });
      const invoices = res.data.data as Invoice[];
      if (!invoices.length) { toast.error(tr('لا توجد فواتير للتصدير')); setExporting(false); return; }
      const rows = invoices.map(inv => ({
        [tr('رقم الفاتورة')]: inv.number,
        [tr('العميل')]: inv.customer.name,
        [tr('المندوب')]: inv.salesRep.name,
        [tr('النوع')]: tr(statusLabels[inv.type] || inv.type),
        [tr('التاريخ')]: formatDate(inv.invoiceDate),
        [tr('الإجمالي')]: num(inv.total),
        [tr('المدفوع')]: num(inv.paidAmt),
        [tr('المتبقي')]: num(inv.remainingAmt),
        [tr('الحالة')]: tr(statusLabels[inv.status] || inv.status),
      }));
      const res2 = await shareOrDownloadExcel(
        [{ name: tr('الفواتير'), rows, colWidths: [18, 24, 16, 10, 16, 12, 12, 12, 10] }],
        `${tr('الفواتير')}-${new Date().toISOString().slice(0, 10)}`
      );
      toast.success(res2 === 'shared' ? tr('تمت المشاركة') : `${tr('تم تصدير')} ${rows.length} ${tr('فاتورة')}`);
    } catch { toast.error(tr('تعذّر التصدير')); }
    setExporting(false);
  };

  const typeBadge = (t: string) => <span className={`badge-${t.toLowerCase()}`}>{tr(statusLabels[t])}</span>;
  const statusBadge = (s: string) => {
    const map: Record<string, string> = { CONFIRMED: 'badge-confirmed', CANCELLED: 'badge-cancelled', DRAFT: 'badge-inactive' };
    return <span className={map[s] || ''}>{tr(statusLabels[s])}</span>;
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{tr('إدارة الفواتير')}</h1>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={handleExport} disabled={exporting}>
            {exporting ? <span className="w-4 h-4 border-2 border-gray-300 border-t-[#E15A30] rounded-full animate-spin" /> : <Download size={16} />}
            {tr('تصدير Excel')}
          </button>
          <button className="btn-primary" onClick={() => setShowCreate(true)}><Plus size={16} />{tr('فاتورة جديدة')}</button>
        </div>
      </div>

      {/* Filters */}
      <div className="card mb-4">
        <div className="flex gap-3 flex-wrap">
          <div className="relative flex-1 min-w-48">
            <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input className="input pr-9" placeholder={tr('رقم الفاتورة أو اسم العميل...')} value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }} />
          </div>
          <select className="input w-36" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}>
            <option value="">{tr('جميع الحالات')}</option>
            <option value="CONFIRMED">{tr('معتمد')}</option>
            <option value="CANCELLED">{tr('ملغي')}</option>
            <option value="DRAFT">{tr('مسودة')}</option>
          </select>
          <select className="input w-32" value={type} onChange={e => { setType(e.target.value); setPage(1); }}>
            <option value="">{tr('جميع الأنواع')}</option>
            <option value="CASH">{tr('نقدي')}</option>
            <option value="CREDIT">{tr('آجل')}</option>
          </select>
          <select className="input w-40" value={salesRepId} onChange={e => { setSalesRepId(e.target.value); setPage(1); }}>
            <option value="">{tr('كل المناديب')}</option>
            {reps?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div className="flex gap-3 flex-wrap items-end mt-3 pt-3 border-t border-[#F1EBDF]">
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

      {/* Table */}
      <div className="card p-0">
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>{tr('رقم الفاتورة')}</th><th>{tr('العميل')}</th><th>{tr('المندوب')}</th><th>{tr('النوع')}</th>
                <th>{tr('الإجمالي')}</th><th>{tr('المدفوع')}</th><th>{tr('المتبقي')}</th><th>{tr('التاريخ')}</th>
                <th>{tr('الحالة')}</th><th>{tr('إجراءات')}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={10} className="text-center py-12 text-gray-400">{tr('جاري التحميل...')}</td></tr>
              ) : data?.data.length === 0 ? (
                <tr><td colSpan={10} className="text-center py-12 text-gray-400">{tr('لا توجد فواتير')}</td></tr>
              ) : data?.data.map(inv => (
                <tr key={inv.id}>
                  <td className="font-mono text-sm text-[#E15A30]">{inv.number}</td>
                  <td className="font-medium text-gray-800">{inv.customer.name}</td>
                  <td className="text-gray-600 text-sm">{inv.salesRep.name}</td>
                  <td>{typeBadge(inv.type)}</td>
                  <td className="font-semibold text-gray-800">{formatCurrency(inv.total)}</td>
                  <td className="text-green-600">{formatCurrency(inv.paidAmt)}</td>
                  <td className={Number(inv.remainingAmt) > 0 ? 'text-red-600 font-medium' : 'text-gray-400'}>
                    {formatCurrency(inv.remainingAmt)}
                  </td>
                  <td className="text-xs text-gray-400">{formatDate(inv.invoiceDate)}</td>
                  <td>{statusBadge(inv.status)}</td>
                  <td>
                    <div className="flex items-center gap-2">
                      <button onClick={() => openInvoicePdf(inv.id)} className="p-1.5 hover:bg-[#FBEBE2] rounded text-[#E15A30]" title={tr('عرض / PDF')}>
                        {openingId === inv.id ? <span className="w-3.5 h-3.5 border-2 border-[#F5C9BA] border-t-[#E15A30] rounded-full animate-spin inline-block" /> : <FileText size={14} />}
                      </button>
                      {/* تحكّم الأدمن بعودة المرتجع للمخزون — للمرتجعات المعتمدة فقط */}
                      {inv.type === 'RETURN' && inv.status === 'CONFIRMED' && (
                        <button
                          onClick={() => restockMutation.mutate({ id: inv.id, returnToStock: !inv.returnToStock })}
                          disabled={restockMutation.isPending}
                          className={`px-2 py-1 rounded text-[11px] font-semibold whitespace-nowrap ${inv.returnToStock ? 'bg-green-50 text-green-700 hover:bg-green-100' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                          title={tr('اضغط لتبديل: هل يعود المرتجع لمخزون السيارة؟')}
                        >
                          {inv.returnToStock ? `↩ ${tr('يعود للمخزون')}` : `✕ ${tr('لا يعود')}`}
                        </button>
                      )}
                      {inv.status === 'CONFIRMED' && (
                        <button
                          onClick={() => setCancelId(inv.id)}
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
            <p className="text-sm text-gray-500">{tr('إجمالي')}: {data.pagination.total} {tr('فاتورة')}</p>
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
        <InvoiceModal
          onClose={() => setShowCreate(false)}
          onSaved={(doc) => { setShowCreate(false); qc.invalidateQueries({ queryKey: ['invoices'] }); setDocResult(doc); }}
        />
      )}
      {docResult && <DocumentModal doc={docResult} onClose={() => setDocResult(null)} />}
      {cancelId && (
        <ConfirmDialog
          title={tr('إلغاء الفاتورة')}
          message={tr('هل تريد إلغاء هذه الفاتورة؟ سيُعكس أثرها على رصيد العميل.')}
          confirmLabel={tr('نعم، إلغاء')}
          danger
          loading={cancelMutation.isPending}
          onConfirm={() => { cancelMutation.mutate(cancelId, { onSettled: () => setCancelId(null) }); }}
          onClose={() => setCancelId(null)}
        />
      )}
    </div>
  );
}
