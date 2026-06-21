import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invoiceApi, companyApi } from '../api/client';
import { Invoice } from '../types';
import { formatCurrency, formatDate, statusLabels } from '../utils/format';
import { Plus, Search, FileText, XCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import InvoiceModal from '../components/forms/InvoiceModal';
import DocumentModal from '../components/DocumentModal';
import { InvoiceDoc, invoiceDocFromDetail, Company } from '../rep/RepDocuments';

export default function InvoicesPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('CONFIRMED');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [docResult, setDocResult] = useState<InvoiceDoc | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: async () => { const res = await companyApi.get(); return res.data.data as Company; },
  });

  const { data, isLoading } = useQuery({
    queryKey: ['invoices', search, status, type, page],
    queryFn: async () => {
      const res = await invoiceApi.list({ search, status, type, page, limit: 15 });
      return res.data as { data: Invoice[]; pagination: { total: number; pages: number } };
    },
  });

  // فتح مستند PDF لفاتورة موجودة (جديدة أو قديمة) بنفس شكل المندوب
  const openInvoicePdf = async (id: string) => {
    setOpeningId(id);
    try {
      const res = await invoiceApi.get(id);
      setDocResult(invoiceDocFromDetail(res.data.data, '', company));
    } catch { toast.error('تعذّر فتح المستند'); }
    setOpeningId(null);
  };

  const cancelMutation = useMutation({
    mutationFn: (id: string) => invoiceApi.cancel(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['invoices'] }); toast.success('تم إلغاء الفاتورة'); },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'خطأ';
      toast.error(msg);
    },
  });

  const typeBadge = (t: string) => <span className={`badge-${t.toLowerCase()}`}>{statusLabels[t]}</span>;
  const statusBadge = (s: string) => {
    const map: Record<string, string> = { CONFIRMED: 'badge-confirmed', CANCELLED: 'badge-cancelled', DRAFT: 'badge-inactive' };
    return <span className={map[s] || ''}>{statusLabels[s]}</span>;
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">إدارة الفواتير</h1>
        <button className="btn-primary" onClick={() => setShowCreate(true)}><Plus size={16} />فاتورة جديدة</button>
      </div>

      {/* Filters */}
      <div className="card mb-4">
        <div className="flex gap-3 flex-wrap">
          <div className="relative flex-1 min-w-48">
            <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input className="input pr-9" placeholder="رقم الفاتورة أو اسم العميل..." value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }} />
          </div>
          <select className="input w-36" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}>
            <option value="">جميع الحالات</option>
            <option value="CONFIRMED">معتمد</option>
            <option value="CANCELLED">ملغي</option>
            <option value="DRAFT">مسودة</option>
          </select>
          <select className="input w-32" value={type} onChange={e => { setType(e.target.value); setPage(1); }}>
            <option value="">جميع الأنواع</option>
            <option value="CASH">نقدي</option>
            <option value="CREDIT">آجل</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="card p-0">
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>رقم الفاتورة</th><th>العميل</th><th>المندوب</th><th>النوع</th>
                <th>الإجمالي</th><th>المدفوع</th><th>المتبقي</th><th>التاريخ</th>
                <th>الحالة</th><th>إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={10} className="text-center py-12 text-gray-400">جاري التحميل...</td></tr>
              ) : data?.data.length === 0 ? (
                <tr><td colSpan={10} className="text-center py-12 text-gray-400">لا توجد فواتير</td></tr>
              ) : data?.data.map(inv => (
                <tr key={inv.id}>
                  <td className="font-mono text-sm text-blue-600">{inv.number}</td>
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
                      <button onClick={() => openInvoicePdf(inv.id)} className="p-1.5 hover:bg-blue-50 rounded text-blue-600" title="عرض / PDF">
                        {openingId === inv.id ? <span className="w-3.5 h-3.5 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin inline-block" /> : <FileText size={14} />}
                      </button>
                      {inv.status === 'CONFIRMED' && (
                        <button
                          onClick={() => { if (confirm('هل تريد إلغاء هذه الفاتورة؟')) cancelMutation.mutate(inv.id); }}
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
            <p className="text-sm text-gray-500">إجمالي: {data.pagination.total} فاتورة</p>
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
    </div>
  );
}
