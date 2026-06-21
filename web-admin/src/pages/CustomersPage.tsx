import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { customerApi, companyApi } from '../api/client';
import { Customer } from '../types';
import { formatCurrency, formatDate, statusLabels } from '../utils/format';
import { Plus, Search, Edit, FileText, FileBarChart2, ChevronLeft, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '../store/authStore';
import CustomerModal from '../components/forms/CustomerModal';
import CustomerStatementModal from '../components/forms/CustomerStatementModal';
import DocumentModal from '../components/DocumentModal';
import { StatementDoc, statementDocFromData, Company } from '../rep/RepDocuments';

export default function CustomersPage() {
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [showModal, setShowModal] = useState(false);
  const [showStatement, setShowStatement] = useState(false);
  const [selected, setSelected] = useState<Customer | null>(null);
  const [docResult, setDocResult] = useState<StatementDoc | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: async () => { const res = await companyApi.get(); return res.data.data as Company; },
  });

  const { data, isLoading } = useQuery({
    queryKey: ['customers', search, status, page],
    queryFn: async () => {
      const res = await customerApi.list({ search, status, page, limit: 15 });
      return res.data as { data: Customer[]; pagination: { total: number; pages: number } };
    },
  });

  const saveMutation = useMutation({
    mutationFn: (values: Partial<Customer>) =>
      selected ? customerApi.update(selected.id, values) : customerApi.create(values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      toast.success(selected ? 'تم تحديث العميل' : 'تم إضافة العميل');
      setShowModal(false);
      setSelected(null);
    },
    onError: () => toast.error('حدث خطأ'),
  });

  const openEdit = (c: Customer) => { setSelected(c); setShowModal(true); };
  const openStatement = (c: Customer) => { setSelected(c); setShowStatement(true); };
  const openAdd = () => { setSelected(null); setShowModal(true); };

  // كشف حساب PDF بنفس شكل المندوب
  const openStatementPdf = async (c: Customer) => {
    setOpeningId(c.id);
    try {
      const res = await customerApi.statement(c.id);
      const { customer, entries } = res.data.data;
      setDocResult(statementDocFromData(customer, entries, user?.name || 'الإدارة', company));
    } catch { toast.error('تعذّر فتح الكشف'); }
    setOpeningId(null);
  };

  const statusBadge = (s: string) => {
    const map: Record<string, string> = { ACTIVE: 'badge-active', INACTIVE: 'badge-inactive', BLOCKED: 'badge-blocked' };
    return <span className={map[s] || ''}>{statusLabels[s]}</span>;
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">إدارة العملاء</h1>
        <button className="btn-primary" onClick={openAdd}><Plus size={16} />إضافة عميل</button>
      </div>

      {/* Filters */}
      <div className="card mb-4">
        <div className="flex gap-3 flex-wrap">
          <div className="relative flex-1 min-w-48">
            <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input className="input pr-9" placeholder="بحث بالاسم أو الجوال أو الكود..." value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }} />
          </div>
          <select className="input w-40" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}>
            <option value="">جميع الحالات</option>
            <option value="ACTIVE">نشط</option>
            <option value="INACTIVE">غير نشط</option>
            <option value="BLOCKED">محظور</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="card p-0">
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>الكود</th><th>العميل</th><th>الجوال</th><th>المدينة</th>
                <th>الرصيد</th><th>الحد الائتماني</th><th>الحالة</th><th>إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={8} className="text-center py-12 text-gray-400">جاري التحميل...</td></tr>
              ) : data?.data.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-12 text-gray-400">لا توجد نتائج</td></tr>
              ) : data?.data.map(c => (
                <tr key={c.id}>
                  <td className="font-mono text-xs text-gray-500">{c.code}</td>
                  <td>
                    <p className="font-medium text-gray-800">{c.name}</p>
                    {c.businessName && <p className="text-xs text-gray-400">{c.businessName}</p>}
                  </td>
                  <td className="text-gray-600 font-mono">{c.phone}</td>
                  <td className="text-gray-600">{c.city || '-'}</td>
                  <td className={`font-semibold ${Number(c.balance) > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                    {formatCurrency(c.balance)}
                  </td>
                  <td className="text-gray-600">{formatCurrency(c.creditLimit)}</td>
                  <td>{statusBadge(c.status)}</td>
                  <td>
                    <div className="flex items-center gap-2">
                      <button onClick={() => openEdit(c)} className="p-1.5 hover:bg-blue-50 rounded text-blue-600" title="تعديل">
                        <Edit size={14} />
                      </button>
                      <button onClick={() => openStatement(c)} className="p-1.5 hover:bg-green-50 rounded text-green-600" title="كشف حساب (عرض)">
                        <FileText size={14} />
                      </button>
                      <button onClick={() => openStatementPdf(c)} className="p-1.5 hover:bg-slate-100 rounded text-slate-600" title="كشف حساب PDF">
                        {openingId === c.id ? <span className="w-3.5 h-3.5 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin inline-block" /> : <FileBarChart2 size={14} />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data && data.pagination.pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
            <p className="text-sm text-gray-500">إجمالي: {data.pagination.total} عميل</p>
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
    </div>
  );
}
