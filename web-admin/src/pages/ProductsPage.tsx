import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { productApi } from '../api/client';
import { Product } from '../types';
import { formatCurrency, statusLabels } from '../utils/format';
import { useTr } from '../i18n/strings';
import { Plus, Search, Edit, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import ProductModal from '../components/forms/ProductModal';
import ConfirmDialog from '../components/ConfirmDialog';

export default function ProductsPage() {
  const qc = useQueryClient();
  const tr = useTr();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showModal, setShowModal] = useState(false);
  const [selected, setSelected] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['products', search, page],
    queryFn: async () => {
      const res = await productApi.list({ search, page, limit: 15 });
      return res.data as { data: Product[]; pagination: { total: number; pages: number } };
    },
  });

  const saveMutation = useMutation({
    mutationFn: (values: Partial<Product>) =>
      selected ? productApi.update(selected.id, values) : productApi.create(values),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['products'] }); toast.success(selected ? tr('تم التحديث') : tr('تم الإضافة')); setShowModal(false); setSelected(null); },
    // رسالة الخادم لا «حدث خطأ» العمياء — سبب الرفض (تحقق/تكرار كود) يصل للمستخدم
    onError: (err: unknown) => toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('حدث خطأ')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => productApi.remove(id),
    onSuccess: (res: { data?: { archived?: boolean } }) => {
      qc.invalidateQueries({ queryKey: ['products'] });
      // الأرشفة تطمئن المستخدم صراحة أن فواتير الصنف وكشوفه القديمة لم تمس
      toast.success(res?.data?.archived ? tr('حذف الصنف من القوائم فواتيره وكشوفه القديمة باقية كما هي') : tr('تم حذف الصنف'));
      setDeleting(null);
    },
    onError: (err: unknown) => {
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر حذف الصنف'));
      setDeleting(null);
    },
  });

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{tr('إدارة المنتجات')}</h1>
        <button className="btn-primary" onClick={() => { setSelected(null); setShowModal(true); }}><Plus size={16} />{tr('إضافة صنف')}</button>
      </div>

      <div className="card mb-4">
        <div className="relative">
          <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input className="input pr-9 max-w-sm" placeholder={tr('بحث بالاسم أو الكود أو الباركود')}
            value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
        </div>
      </div>

      <div className="card p-0">
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr><th>{tr('الكود')}</th><th>{tr('اسم الصنف')}</th><th>{tr('الفئة')}</th><th>{tr('الوحدة')}</th><th>{tr('السعر الأساسي')}</th><th>{tr('الضريبة %')}</th><th>{tr('الحالة')}</th><th>{tr('إجراءات')}</th></tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={8} className="text-center py-12 text-gray-400">{tr('جاري التحميل')}</td></tr>
              ) : data?.data.map(p => (
                <tr key={p.id}>
                  <td className="font-mono text-xs text-gray-500">{p.code}</td>
                  <td>
                    <p className="font-medium text-gray-800">{p.name}</p>
                    {p.barcode && <p className="text-xs text-gray-400 font-mono">{p.barcode}</p>}
                  </td>
                  <td className="text-gray-500 text-sm">{p.category?.name || '-'}</td>
                  <td className="text-gray-600">{p.unit}</td>
                  <td className="font-semibold text-[#E15A30]">{formatCurrency(p.basePrice)}</td>
                  <td className="text-gray-600">{p.taxPct}%</td>
                  <td><span className={p.status === 'ACTIVE' ? 'badge-active' : 'badge-inactive'}>{tr(statusLabels[p.status])}</span></td>
                  <td>
                    <div className="flex items-center gap-2">
                      <button onClick={() => { setSelected(p); setShowModal(true); }} className="p-1.5 hover:bg-[#FBEBE2] rounded text-[#E15A30]" title={tr('تعديل')}><Edit size={14} /></button>
                      <button onClick={() => setDeleting(p)} className="p-1.5 hover:bg-red-50 rounded text-red-600" title={tr('حذف الصنف')}><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && data.pagination.pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <p className="text-sm text-gray-500">{data.pagination.total} {tr('صنف')}</p>
            <div className="flex items-center gap-1">
              <button className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><ChevronRight size={16} /></button>
              <span className="text-sm text-gray-600 px-2">{page} / {data.pagination.pages}</span>
              <button className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40" disabled={page >= data.pagination.pages} onClick={() => setPage(p => p + 1)}><ChevronLeft size={16} /></button>
            </div>
          </div>
        )}
      </div>

      {showModal && (
        <ProductModal
          product={selected}
          onClose={() => { setShowModal(false); setSelected(null); }}
          onSave={saveMutation.mutate}
          loading={saveMutation.isPending}
        />
      )}

      {deleting && (
        <ConfirmDialog
          danger
          title={tr('حذف الصنف')}
          message={`${tr('سيتم حذف الصنف')} «${deleting.name}» ${tr('من كل القوائم ولن يمكن بيعه في فواتير جديدة فواتيره وسنداته وكشوفه القديمة تبقى كما هي بالاسم نفسه ولا يمكن التراجع عن الحذف')}`}
          confirmLabel={tr('حذف نهائي')}
          loading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
