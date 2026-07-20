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
import { StatementDoc, statementDocFromData, Company } from '../rep/RepDocuments';

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

  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: async () => { const res = await companyApi.get(); return res.data.data as Company; },
  });

  const { data, isLoading } = useQuery({
    queryKey: ['customers', search, status, channel, page],
    queryFn: async () => {
      const res = await customerApi.list({ search, status, channel, page, limit: 15 });
      return res.data as { data: Customer[]; pagination: { total: number; pages: number } };
    },
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
    onError: () => toast.error(tr('حدث خطأ')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => customerApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      toast.success(tr('تم حذف العميل'));
      setDeleting(null);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذّر حذف العميل');
      toast.error(msg);
      setDeleting(null);
    },
  });

  const openEdit = (c: Customer) => { setSelected(c); setShowModal(true); };
  const openStatement = (c: Customer) => { setSelected(c); setShowStatement(true); };
  const openAdd = () => { setSelected(null); setShowModal(true); };

  // فتح مباشر لملفّ عميل عبر ?open=<id> (من زر «ملف العميل» في خريطة التتبّع)
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const openId = searchParams.get('open');
    if (!openId) return;
    (async () => {
      try {
        const res = await customerApi.get(openId);
        const c = res.data.data as Customer;
        if (c) { setSelected(c); setShowModal(true); }
      } catch { toast.error(tr('تعذّر فتح ملف العميل')); }
      // نظّف الرابط كي لا يُعاد الفتح عند التحديث
      searchParams.delete('open');
      setSearchParams(searchParams, { replace: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // كشف حساب PDF بنفس شكل المندوب
  const openStatementPdf = async (c: Customer) => {
    setOpeningId(c.id);
    try {
      const res = await customerApi.statement(c.id);
      const { customer, entries } = res.data.data;
      setDocResult(statementDocFromData(customer, entries, user?.name || tr('الإدارة'), company));
    } catch { toast.error(tr('تعذّر فتح الكشف')); }
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
            <input className="input pr-9" placeholder={tr('بحث بالاسم أو الجوال أو الكود...')} value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }} />
          </div>
          <select className="input w-40" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}>
            <option value="">{tr('جميع الحالات')}</option>
            <option value="ACTIVE">{tr('نشط')}</option>
            <option value="INACTIVE">{tr('غير نشط')}</option>
            <option value="BLOCKED">{tr('محظور')}</option>
          </select>
          <select className="input w-44" value={channel} onChange={e => { setChannel(e.target.value); setPage(1); }}>
            <option value="">{tr('جميع القنوات')}</option>
            {SALES_CHANNELS.map((c) => (
              <option key={c.code} value={c.code}>{tr(c.ar)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="card p-0">
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>{tr('الكود')}</th><th>{tr('العميل')}</th><th>{tr('الجوال')}</th><th>{tr('المدينة')}</th><th>{tr('القناة')}</th>
                <th>{tr('الرصيد')}</th><th>{tr('الحد الائتماني')}</th><th>{tr('الحالة')}</th><th>{tr('إجراءات')}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={9} className="text-center py-12 text-gray-400">{tr('جاري التحميل...')}</td></tr>
              ) : data?.data.length === 0 ? (
                <tr><td colSpan={9} className="text-center py-12 text-gray-400">{tr('لا توجد نتائج')}</td></tr>
              ) : data?.data.map(c => (
                <tr key={c.id}>
                  <td className="font-mono text-xs text-gray-500">{c.code}</td>
                  <td>
                    <p className="font-medium text-gray-800">{c.name}</p>
                    {c.businessName && <p className="text-xs text-gray-400">{c.businessName}</p>}
                  </td>
                  <td className="text-gray-600 font-mono">{c.phone}</td>
                  <td className="text-gray-600">{c.city || '-'}</td>
                  <td>
                    {c.channel
                      ? <span className="inline-block text-xs px-2 py-0.5 rounded-full bg-[#FBEBE2] text-[#C94E28] whitespace-nowrap">{tr(channelLabel(c.channel))}</span>
                      : <span className="text-gray-300">-</span>}
                  </td>
                  <td className={`font-semibold ${Number(c.balance) > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                    {formatCurrency(c.balance)}
                  </td>
                  <td className="text-gray-600">{formatCurrency(c.creditLimit)}</td>
                  <td>{statusBadge(c.status)}</td>
                  <td>
                    <div className="flex items-center gap-2">
                      <button onClick={() => openEdit(c)} className="p-1.5 hover:bg-[#FBEBE2] rounded text-[#E15A30]" title={tr('تعديل')}>
                        <Edit size={14} />
                      </button>
                      <button onClick={() => openStatement(c)} className="p-1.5 hover:bg-green-50 rounded text-green-600" title={tr('كشف حساب (عرض)')}>
                        <FileText size={14} />
                      </button>
                      <button onClick={() => openStatementPdf(c)} className="p-1.5 hover:bg-slate-100 rounded text-slate-600" title={tr('كشف حساب PDF')}>
                        {openingId === c.id ? <span className="w-3.5 h-3.5 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin inline-block" /> : <FileBarChart2 size={14} />}
                      </button>
                      <button onClick={() => setDeleting(c)} className="p-1.5 hover:bg-red-50 rounded text-red-600" title={tr('حذف العميل')}>
                        <Trash2 size={14} />
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
          message={`${tr('سيتم حذف العميل')} «${deleting.name}» ${tr('نهائياً ولا يمكن التراجع. إن كان لديه فواتير أو سندات أو حركات في كشف حسابه فلن يُحذف — ويمكنك تعطيله بدلاً من ذلك.')}`}
          confirmLabel={tr('حذف نهائي')}
          loading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
