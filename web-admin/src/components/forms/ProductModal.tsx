import { useForm } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { productApi } from '../../api/client';
import { Product } from '../../types';
import { X } from 'lucide-react';

interface Props { product: Product | null; onClose: () => void; onSave: (data: Partial<Product>) => void; loading: boolean; }

export default function ProductModal({ product, onClose, onSave, loading }: Props) {
  const { register, handleSubmit, formState: { errors } } = useForm<Partial<Product>>({
    defaultValues: product || { status: 'ACTIVE', taxPct: 15, basePrice: 0 },
  });

  const { data: categories } = useQuery({
    queryKey: ['product-categories'],
    queryFn: async () => { const res = await productApi.categories(); return res.data.data as { id: string; name: string }[]; },
  });

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="text-lg font-bold text-gray-800">{product ? 'تعديل صنف' : 'إضافة صنف جديد'}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit(onSave)} className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">كود الصنف *</label>
              <input className="input" {...register('code', { required: true })} />
              {errors.code && <p className="text-red-500 text-xs mt-1">مطلوب</p>}
            </div>
            <div>
              <label className="label">اسم الصنف *</label>
              <input className="input" {...register('name', { required: true })} />
              {errors.name && <p className="text-red-500 text-xs mt-1">مطلوب</p>}
            </div>
            <div>
              <label className="label">باركود</label>
              <input className="input" dir="ltr" {...register('barcode')} />
            </div>
            <div>
              <label className="label">وحدة القياس *</label>
              <input className="input" {...register('unit', { required: true })} placeholder="كرتون / قطعة / كيلو" />
            </div>
            <div>
              <label className="label">السعر الأساسي *</label>
              <input type="number" className="input" min="0" step="0.01" {...register('basePrice', { required: true, valueAsNumber: true })} />
            </div>
            <div>
              <label className="label">نسبة الضريبة %</label>
              <input type="number" className="input" min="0" max="100" step="0.01" {...register('taxPct', { valueAsNumber: true })} />
            </div>
            <div>
              <label className="label">الفئة</label>
              <select className="input" {...register('categoryId')}>
                <option value="">بدون فئة</option>
                {categories?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">الحالة</label>
              <select className="input" {...register('status')}>
                <option value="ACTIVE">نشط</option>
                <option value="INACTIVE">غير نشط</option>
              </select>
            </div>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={loading} className="btn-primary flex-1 justify-center py-2.5">
              {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : null}
              {product ? 'حفظ التعديلات' : 'إضافة الصنف'}
            </button>
            <button type="button" onClick={onClose} className="btn-secondary">إلغاء</button>
          </div>
        </form>
      </div>
    </div>
  );
}
