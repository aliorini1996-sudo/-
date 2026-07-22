import { useForm } from 'react-hook-form';
import { Customer } from '../../types';
import { useTr } from '../../i18n/strings';
import { SALES_CHANNELS } from '../../lib/channels';
import { X, MapPin } from 'lucide-react';

// locationUrl حقل إدخال فقط (يحلّه الخادم إلى lat/lng) — ليس حقلاً مخزّناً
type CustomerForm = Partial<Customer> & { locationUrl?: string };

interface Props {
  customer: Customer | null;
  onClose: () => void;
  onSave: (data: CustomerForm) => void;
  loading: boolean;
}

export default function CustomerModal({ customer, onClose, onSave, loading }: Props) {
  const tr = useTr();
  const { register, handleSubmit, formState: { errors } } = useForm<CustomerForm>({
    defaultValues: customer || { status: 'ACTIVE', creditLimit: 0, paymentDays: 30 },
  });
  const hasLoc = customer?.lat != null && customer?.lng != null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-800">{customer ? tr('تعديل عميل') : tr('إضافة عميل جديد')}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <form onSubmit={handleSubmit(onSave)} className="p-6 space-y-6">
          {/* Basic Info */}
          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase">{tr('البيانات الأساسية')}</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">{tr('اسم العميل')} *</label>
                <input className="input" {...register('name', { required: true })} />
                {errors.name && <p className="text-red-500 text-xs mt-1">{tr('مطلوب')}</p>}
              </div>
              <div>
                <label className="label">{tr('اسم المنشأة')}</label>
                <input className="input" {...register('businessName')} />
              </div>
              <div>
                <label className="label">{tr('رقم الجوال')} *</label>
                <input className="input" dir="ltr" {...register('phone', { required: true })} />
                {errors.phone && <p className="text-red-500 text-xs mt-1">{tr('مطلوب')}</p>}
              </div>
              <div>
                <label className="label">{tr('رقم بديل')}</label>
                <input className="input" dir="ltr" {...register('altPhone')} />
              </div>
              <div>
                <label className="label">{tr('البريد الإلكتروني')}</label>
                <input className="input" type="email" dir="ltr" {...register('email')} />
              </div>
              <div>
                <label className="label">{tr('السجل التجاري')}</label>
                <input className="input" {...register('commercialReg')} />
              </div>
              <div>
                <label className="label">{tr('الرقم الضريبي')}</label>
                <input className="input" {...register('taxNumber')} />
              </div>
              <div>
                <label className="label">{tr('الحالة')}</label>
                <select className="input" {...register('status')}>
                  <option value="ACTIVE">{tr('نشط')}</option>
                  <option value="INACTIVE">{tr('غير نشط')}</option>
                  <option value="BLOCKED">{tr('محظور')}</option>
                </select>
              </div>
              <div>
                <label className="label">{tr('قناة البيع')}</label>
                <select className="input" {...register('channel')}>
                  <option value="">{tr('غير محدّد')}</option>
                  {SALES_CHANNELS.map((c) => (
                    <option key={c.code} value={c.code}>{tr(c.ar)}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Address */}
          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase">{tr('العنوان')}</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">{tr('المدينة')}</label>
                <input className="input" {...register('city')} />
              </div>
              <div>
                <label className="label">{tr('الحي')}</label>
                <input className="input" {...register('district')} />
              </div>
              <div className="col-span-2">
                <label className="label">{tr('العنوان التفصيلي')}</label>
                <input className="input" {...register('address')} />
              </div>
            </div>
          </div>

          {/* Location — رابط موقع يظهر العميل على الخريطة */}
          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase flex items-center gap-1.5"><MapPin size={15} /> {tr('الموقع على الخريطة')}</h3>
            <div>
              <label className="label">{tr('رابط الموقع (خرائط Google)')}</label>
              <input className="input" dir="ltr" placeholder="https://maps.app.goo.gl/…  أو  24.7136, 46.6753"
                {...register('locationUrl')} />
              <p className="text-[11px] text-gray-400 mt-1">
                {hasLoc
                  ? `${tr('الموقع الحالي محدَّد')} · ${customer!.lat!.toFixed(5)}, ${customer!.lng!.toFixed(5)} — ${tr('الصق رابطاً جديداً لتحديثه.')}`
                  : tr('من خرائط Google: مشاركة ← نسخ الرابط، ثم الصقه هنا ليظهر العميل على خريطة التتبّع.')}
              </p>
              {hasLoc && (
                <a href={`https://www.google.com/maps?q=${customer!.lat},${customer!.lng}`} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-[#2563EB] font-semibold mt-1">
                  <MapPin size={12} /> {tr('عرض الموقع الحالي على الخريطة')}
                </a>
              )}
            </div>
          </div>

          {/* Financial */}
          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase">{tr('البيانات المالية')}</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">{tr('الحد الائتماني')}</label>
                <input className="input" type="number" min="0" step="0.01" {...register('creditLimit', { valueAsNumber: true })} />
              </div>
              <div>
                <label className="label">{tr('فترة السداد (يوم)')}</label>
                <input className="input" type="number" min="0" {...register('paymentDays', { valueAsNumber: true })} />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={loading} className="btn-primary flex-1 justify-center py-2.5">
              {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : null}
              {customer ? tr('حفظ التعديلات') : tr('إضافة العميل')}
            </button>
            <button type="button" onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
