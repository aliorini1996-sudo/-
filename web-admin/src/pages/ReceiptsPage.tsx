import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { receiptApi, companyApi, salesRepApi } from '../api/client';
import { Receipt, SalesRep } from '../types';
import { formatCurrency, formatDate, paymentMethodLabels } from '../utils/format';
import { Plus, XCircle, ChevronLeft, ChevronRight, FileText, Download } from 'lucide-react';
import toast from 'react-hot-toast';
import ReceiptModal from '../components/forms/ReceiptModal';
import DocumentModal from '../components/DocumentModal';
import ConfirmDialog from '../components/ConfirmDialog';
import { ReceiptDoc, receiptDocFromDetail, Company } from '../rep/RepDocuments';
import { shareOrDownloadExcel, num } from '../utils/excel';

export default function ReceiptsPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [salesRepId, setSalesRepId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [exporting, setExporting] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [docResult, setDocResult] = useState<ReceiptDoc | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);

  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: async () => { const res = await companyApi.get(); return res.data.data as Company; },
  });

  const { data: reps } = useQuery({
    queryKey: ['sales-reps-all'],
    queryFn: async () => { const res = await salesRepApi.list({ limit: 200 }); return res.data.data as SalesRep[]; },
  });

  const filters = () => {
    const f: Record<string, string | number> = {};
    if (salesRepId) f.salesRepId = salesRepId;
    if (from && to) { f.from = from; f.to = to; }
    return f;
  };

  const { data, isLoading } = useQuery({
    queryKey: ['receipts', salesRepId, from, to, page],
    queryFn: async () => {
      const res = await receiptApi.list({ ...filters(), page, limit: 15 });
      return res.data as { data: Receipt[]; pagination: { total: number; pages: number } };
    },
  });

  // تصدير/مشاركة السندات
  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await receiptApi.list({ ...filters(), limit: 5000 });
      const receipts = res.data.data as Receipt[];
      if (!receipts.length) { toast.error('لا توجد سندات للتصدير'); setExporting(false); return; }
      const rows = receipts.map(r => ({
        'رقم السند': r.number,
        'العميل': r.customer.name,
        'المندوب': r.salesRep.name,
        'المبلغ': num(r.amount),
        'طريقة الدفع': paymentMethodLabels[r.paymentMethod] || r.paymentMethod,
        'التاريخ': formatDate(r.receiptDate),
        'الحالة': r.status === 'ACTIVE' ? 'نشط' : 'ملغي',
      }));
      const out = await shareOrDownloadExcel(
        [{ name: 'سندات القبض', rows, colWidths: [18, 24, 16, 12, 14, 16, 10] }],
        `سندات-القبض-${new Date().toISOString().slice(0, 10)}`
      );
      toast.success(out === 'shared' ? 'تمت المشاركة' : `تم تصدير ${rows.length} سند`);
    } catch { toast.error('تعذّر التصدير'); }
    setExporting(false);
  };

  // فتح مستند PDF لسند موجود (جديد أو قديم) بنفس شكل المندوب
  const openReceiptPdf = async (id: string) => {
    setOpeningId(id);
    try {
      const res = await receiptApi.get(id);
      setDocResult(receiptDocFromDetail(res.data.data, '', company));
    } catch { toast.error('تعذّر فتح المستند'); }
    setOpeningId(null);
  };

  const cancelMutation = useMutation({
    mutationFn: (id: string) => receiptApi.cancel(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['receipts'] }); toast.success('تم إلغاء السند'); },
    onError: () => toast.error('خطأ في الإلغاء'),
  });

  const methodBadge = (m: string) => {
    const colors: Record<string, string> = {
      CASH: 'bg-green-100 text-green-700', BANK_TRANSFER: 'bg-[#FBEBE2] text-[#C94E28]',
      POS: 'bg-purple-100 text-purple-700', CHEQUE: 'bg-orange-100 text-orange-700',
    };
    return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[m] || ''}`}>{paymentMethodLabels[m]}</span>;
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">سندات القبض</h1>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={handleExport} disabled={exporting}>
            {exporting ? <span className="w-4 h-4 border-2 border-gray-300 border-t-[#E15A30] rounded-full animate-spin" /> : <Download size={16} />}
            تصدير Excel
          </button>
          <button className="btn-primary" onClick={() => setShowCreate(true)}><Plus size={16} />سند جديد</button>
        </div>
      </div>

      {/* Filters */}
      <div className="card mb-4">
        <div className="flex gap-3 flex-wrap items-end">
          <select className="input w-40" value={salesRepId} onChange={e => { setSalesRepId(e.target.value); setPage(1); }}>
            <option value="">كل المناديب</option>
            {reps?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <div>
            <label className="label text-xs">من تاريخ</label>
            <input type="date" className="input w-40" value={from} onChange={e => { setFrom(e.target.value); setPage(1); }} />
          </div>
          <div>
            <label className="label text-xs">إلى تاريخ</label>
            <input type="date" className="input w-40" value={to} onChange={e => { setTo(e.target.value); setPage(1); }} />
          </div>
          {(from || to || salesRepId) && (
            <button className="btn-secondary" onClick={() => { setFrom(''); setTo(''); setSalesRepId(''); setPage(1); }}>مسح الفلاتر</button>
          )}
        </div>
      </div>

      <div className="card p-0">
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>رقم السند</th><th>العميل</th><th>المندوب</th>
                <th>المبلغ</th><th>طريقة الدفع</th><th>التاريخ</th><th>الحالة</th><th>إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={8} className="text-center py-12 text-gray-400">جاري التحميل...</td></tr>
              ) : data?.data.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-12 text-gray-400">لا توجد سندات</td></tr>
              ) : data?.data.map(r => (
                <tr key={r.id}>
                  <td className="font-mono text-sm text-green-600">{r.number}</td>
                  <td className="font-medium text-gray-800">{r.customer.name}</td>
                  <td className="text-gray-600 text-sm">{r.salesRep.name}</td>
                  <td className="font-bold text-green-700">{formatCurrency(r.amount)}</td>
                  <td>{methodBadge(r.paymentMethod)}</td>
                  <td className="text-xs text-gray-400">{formatDate(r.receiptDate)}</td>
                  <td>
                    <span className={r.status === 'ACTIVE' ? 'badge-active' : 'badge-cancelled'}>
                      {r.status === 'ACTIVE' ? 'نشط' : 'ملغي'}
                    </span>
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <button onClick={() => openReceiptPdf(r.id)} className="p-1.5 hover:bg-[#FBEBE2] rounded text-[#E15A30]" title="عرض / PDF">
                        {openingId === r.id ? <span className="w-3.5 h-3.5 border-2 border-[#F5C9BA] border-t-[#E15A30] rounded-full animate-spin inline-block" /> : <FileText size={14} />}
                      </button>
                      {r.status === 'ACTIVE' && (
                        <button
                          onClick={() => setCancelId(r.id)}
                          className="p-1.5 hover:bg-red-50 rounded text-red-500"
                          title="إلغاء"
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
            <p className="text-sm text-gray-500">إجمالي: {data.pagination.total} سند</p>
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
          onSaved={(doc) => { setShowCreate(false); qc.invalidateQueries({ queryKey: ['receipts'] }); setDocResult(doc); }}
        />
      )}
      {docResult && <DocumentModal doc={docResult} onClose={() => setDocResult(null)} />}
      {cancelId && (
        <ConfirmDialog
          title="إلغاء سند القبض"
          message="هل تريد إلغاء هذا السند؟ سيُعكس أثره على رصيد العميل."
          confirmLabel="نعم، إلغاء"
          danger
          loading={cancelMutation.isPending}
          onConfirm={() => { cancelMutation.mutate(cancelId, { onSettled: () => setCancelId(null) }); }}
          onClose={() => setCancelId(null)}
        />
      )}
    </div>
  );
}
