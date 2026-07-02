import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { productApi } from '../../api/client';
import { Product } from '../../types';
import { useTr } from '../../i18n/strings';
import { X, Upload, Trash2, Image as ImageIcon } from 'lucide-react';
import toast from 'react-hot-toast';

interface Props { product: Product | null; onClose: () => void; onSave: (data: Partial<Product>) => void; loading: boolean; }

// يضغط الصورة في المتصفح (يصغّر الأبعاد ويحوّلها JPEG) لتقليل حجمها قبل التخزين
function compressImage(file: File, maxSize = 400, quality = 0.7): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxSize) { height = (height * maxSize) / width; width = maxSize; }
        else if (height > maxSize) { width = (width * maxSize) / height; height = maxSize; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('no ctx')); return; }
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = reader.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function ProductModal({ product, onClose, onSave, loading }: Props) {
  const tr = useTr();
  const { register, handleSubmit, formState: { errors } } = useForm<Partial<Product>>({
    defaultValues: product || { status: 'ACTIVE', taxPct: 15, basePrice: 0 },
  });
  // صورة الصنف تُدار بـ state ليتم ضغطها ودمجها يدوياً
  const [image, setImage] = useState<string>(product?.image || '');

  const { data: categories } = useQuery({
    queryKey: ['product-categories'],
    queryFn: async () => { const res = await productApi.categories(); return res.data.data as { id: string; name: string }[]; },
  });

  const onImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error(tr('الملف يجب أن يكون صورة')); return; }
    try {
      const compressed = await compressImage(file);
      setImage(compressed);
    } catch { toast.error(tr('تعذّر معالجة الصورة')); }
  };

  const submit = (data: Partial<Product>) => onSave({ ...data, image: image || null });

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="text-lg font-bold text-gray-800">{product ? tr('تعديل صنف') : tr('إضافة صنف جديد')}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit(submit)} className="p-5 space-y-4">
          {/* صورة الصنف */}
          <div>
            <label className="label">{tr('صورة الصنف')}</label>
            <div className="flex items-center gap-3">
              <div className="w-20 h-20 rounded-xl border-2 border-dashed border-gray-200 flex items-center justify-center overflow-hidden bg-gray-50 flex-shrink-0">
                {image
                  ? <img src={image} alt={tr('صورة الصنف')} className="w-full h-full object-cover" />
                  : <ImageIcon size={26} className="text-gray-300" />}
              </div>
              <div className="flex flex-col gap-2">
                <label className="btn-secondary cursor-pointer text-xs">
                  <Upload size={14} /> {tr('اختيار صورة')}
                  <input type="file" accept="image/*" className="hidden" onChange={onImageChange} />
                </label>
                {image && (
                  <button type="button" onClick={() => setImage('')} className="text-red-500 text-xs flex items-center gap-1">
                    <Trash2 size={12} /> {tr('إزالة الصورة')}
                  </button>
                )}
                <span className="text-[10px] text-gray-400">{tr('تُضغط تلقائياً — تظهر للمندوب عند البيع')}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">{tr('كود الصنف')} *</label>
              <input className="input" {...register('code', { required: true })} />
              {errors.code && <p className="text-red-500 text-xs mt-1">{tr('مطلوب')}</p>}
            </div>
            <div>
              <label className="label">{tr('اسم الصنف')} *</label>
              <input className="input" {...register('name', { required: true })} />
              {errors.name && <p className="text-red-500 text-xs mt-1">{tr('مطلوب')}</p>}
            </div>
            <div>
              <label className="label">{tr('باركود')}</label>
              <input className="input" dir="ltr" {...register('barcode')} />
            </div>
            <div>
              <label className="label">{tr('وحدة القياس')} *</label>
              <input className="input" {...register('unit', { required: true })} placeholder={tr('كرتون / قطعة / كيلو')} />
            </div>
            <div>
              <label className="label">{tr('السعر الأساسي')} *</label>
              <input type="number" className="input" min="0" step="0.01" {...register('basePrice', { required: true, valueAsNumber: true })} />
            </div>
            <div>
              <label className="label">{tr('نسبة الضريبة %')}</label>
              <input type="number" className="input" min="0" max="100" step="0.01" {...register('taxPct', { valueAsNumber: true })} />
            </div>
            <div>
              <label className="label">{tr('الفئة')}</label>
              <select className="input" {...register('categoryId')}>
                <option value="">{tr('بدون فئة')}</option>
                {categories?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">{tr('الحالة')}</label>
              <select className="input" {...register('status')}>
                <option value="ACTIVE">{tr('نشط')}</option>
                <option value="INACTIVE">{tr('غير نشط')}</option>
              </select>
            </div>
          </div>

          {/* أكواد الفوترة الإلكترونية — تلزم لبعض الدول (مصر ETA وغيرها) */}
          <details className="rounded-xl border border-gray-200 bg-gray-50/60">
            <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold text-gray-700 flex items-center gap-2">
              {tr('أكواد الفوترة الإلكترونية')}
              <span className="text-[10px] font-normal text-gray-400">{tr('اختياري — يلزم لبعض الدول')}</span>
            </summary>
            <div className="px-4 pb-4 pt-1 grid grid-cols-2 gap-4">
              <div>
                <label className="label">{tr('نوع كود الصنف')}</label>
                <select className="input" {...register('itemCodeType')}>
                  <option value="EGS">EGS</option>
                  <option value="GS1">GS1 (GTIN)</option>
                </select>
              </div>
              <div>
                <label className="label">{tr('كود الصنف')} (EGS/GS1)</label>
                <input className="input" dir="ltr" {...register('itemCode')} placeholder="EG-xxxx / 6221xxxxxxxxx" />
              </div>
              <div className="col-span-2">
                <label className="label">{tr('كود الوحدة')}</label>
                <input className="input" dir="ltr" {...register('unitCode')} placeholder={tr('حسب جدول وحدات المزوّد (مثال: EA)')} />
              </div>
            </div>
          </details>

          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={loading} className="btn-primary flex-1 justify-center py-2.5">
              {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : null}
              {product ? tr('حفظ التعديلات') : tr('إضافة الصنف')}
            </button>
            <button type="button" onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
