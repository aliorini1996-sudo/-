import { useState, forwardRef } from 'react';
import { useForm } from 'react-hook-form';
import { SalesRep } from '../../types';
import { useTr } from '../../i18n/strings';
import { X, Eye, EyeOff, RefreshCw } from 'lucide-react';

interface FormData extends Partial<SalesRep> { password?: string; }
interface Props { rep: SalesRep | null; onClose: () => void; onSave: (data: FormData) => void; loading: boolean; }

// forwardRef ضروري ليصل ref الخاص بـ react-hook-form إلى مربع الاختيار فعلياً
const PermToggle = forwardRef<HTMLInputElement, { label: string } & React.InputHTMLAttributes<HTMLInputElement>>(
  ({ label, ...props }, ref) => (
    <label className="flex items-center gap-2 cursor-pointer">
      <input ref={ref} type="checkbox" className="w-4 h-4 rounded text-[#E15A30]" {...props} />
      <span className="text-sm text-gray-700">{label}</span>
    </label>
  )
);
PermToggle.displayName = 'PermToggle';

export default function SalesRepModal({ rep, onClose, onSave, loading }: Props) {
  const tr = useTr();
  const [showPass, setShowPass] = useState(false);
  const defaults: FormData = rep
    ? { ...rep, email: rep.email || '', canSellOnCredit: rep.canSellOnCredit ?? true, canSellInCash: rep.canSellInCash ?? true, canManageVanStock: rep.canManageVanStock ?? true }
    : {
      isActive: true,
      canCreateInvoice: true,
      canSellOnCredit: true,
      canSellInCash: true,
      canCreateReceipt: true,
      canManageVanStock: true,
      canViewStatement: true,
      canAddCustomer: false,
      showCollectionBalance: true,
      maxDiscountPct: 0,
    };
  const { register, handleSubmit, setValue, formState: { errors } } = useForm<FormData>({
    defaultValues: defaults,
  });

  // يولّد كلمة مرور قوية عشوائية لتسهيل إنشاء الحساب
  const generatePassword = () => {
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let p = '';
    for (let i = 0; i < 8; i++) p += chars[Math.floor(Math.random() * chars.length)];
    setValue('password', p, { shouldValidate: true });
    setShowPass(true);
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="text-lg font-bold text-gray-800">{rep ? tr('تعديل مندوب') : tr('إضافة مندوب')}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit(onSave)} className="p-5 space-y-5">
          {/* Basic */}
          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase">{tr('البيانات الأساسية')}</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">{tr('الاسم')} *</label>
                <input className="input" {...register('name', { required: true })} />
                {errors.name && <p className="text-red-500 text-xs mt-1">{tr('مطلوب')}</p>}
              </div>
              <div>
                <label className="label">{tr('الجوال')} *</label>
                <input className="input" dir="ltr" {...register('phone', { required: tr('مطلوب'), minLength: { value: 9, message: tr('رقم غير صحيح') } })} />
                {errors.phone && <p className="text-red-500 text-xs mt-1">{errors.phone.message}</p>}
              </div>
              <div>
                <label className="label">{tr('البريد الإلكتروني')}</label>
                <input className="input" type="email" dir="ltr" {...register('email')} />
              </div>
              <div>
                <label className="label">{tr('اسم المستخدم')} *</label>
                <input className="input" dir="ltr" autoComplete="off"
                  {...register('username', { required: tr('مطلوب'), minLength: { value: 4, message: tr('4 أحرف على الأقل') } })} />
                {errors.username && <p className="text-red-500 text-xs mt-1">{errors.username.message}</p>}
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <label className="label">{tr('كلمة المرور')} {!rep && '*'}</label>
                  <button type="button" onClick={generatePassword} className="text-xs text-[#E15A30] hover:text-[#C94E28] flex items-center gap-1 mb-1">
                    <RefreshCw size={11} /> {tr('توليد')}
                  </button>
                </div>
                <div className="relative">
                  <input type={showPass ? 'text' : 'password'} className="input pl-9" dir="ltr" autoComplete="new-password"
                    placeholder={rep ? tr('اتركها فارغة لعدم التغيير') : ''}
                    {...register('password', {
                      required: rep ? false : tr('كلمة المرور مطلوبة'),
                      validate: v => !v ? (rep ? true : tr('كلمة المرور مطلوبة')) : (v.length >= 6 || tr('كلمة المرور 6 أحرف على الأقل')),
                    })} />
                  <button type="button" onClick={() => setShowPass(s => !s)} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                    {showPass ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
                {errors.password
                  ? <p className="text-red-500 text-xs mt-1">{errors.password.message}</p>
                  : !rep && <p className="text-gray-400 text-xs mt-1">{tr('6 أحرف على الأقل — يسلّمها الأدمن للمندوب')}</p>}
              </div>
              <div>
                <label className="label">{tr('الحالة')}</label>
                <select className="input" {...register('isActive', { setValueAs: v => v === 'true' || v === true })}>
                  <option value="true">{tr('نشط')}</option>
                  <option value="false">{tr('غير نشط')}</option>
                </select>
              </div>
            </div>
          </div>

          {/* Permissions */}
          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase">{tr('صلاحيات المبيعات')}</h3>
            <div className="grid grid-cols-2 gap-3">
              <PermToggle label={tr('إنشاء فاتورة')} {...register('canCreateInvoice')} />
              <PermToggle label={tr('البيع الآجل')} {...register('canSellOnCredit')} />
              <PermToggle label={tr('البيع النقدي')} {...register('canSellInCash')} />
              <PermToggle label={tr('تعديل فاتورة')} {...register('canEditInvoice')} />
              <PermToggle label={tr('إلغاء فاتورة')} {...register('canCancelInvoice')} />
              <PermToggle label={tr('حذف فاتورة')} {...register('canDeleteInvoice')} />
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase">{tr('صلاحيات التسعير')}</h3>
            <div className="grid grid-cols-2 gap-3">
              <PermToggle label={tr('تغيير السعر')} {...register('canChangePrice')} />
              <PermToggle label={tr('البيع أقل من السعر')} {...register('canSellBelowPrice')} />
            </div>
            <div className="mt-3 max-w-xs">
              <label className="label">{tr('أقصى نسبة خصم %')}</label>
              <input type="number" className="input" min="0" max="100" {...register('maxDiscountPct', { valueAsNumber: true })} />
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase">{tr('صلاحيات التحصيل')}</h3>
            <div className="grid grid-cols-2 gap-3">
              <PermToggle label={tr('إصدار سند قبض')} {...register('canCreateReceipt')} />
              <PermToggle label={tr('تعديل سند قبض')} {...register('canEditReceipt')} />
              <PermToggle label={tr('إلغاء سند قبض')} {...register('canCancelReceipt')} />
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase">{tr('صلاحيات مخزون السيارة')}</h3>
            <div className="grid grid-cols-2 gap-3">
              <PermToggle label={tr('تحميل مخزون السيارة')} {...register('canManageVanStock')} />
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase">{tr('صلاحيات العملاء')}</h3>
            <div className="grid grid-cols-2 gap-3">
              <PermToggle label={tr('إضافة عميل')} {...register('canAddCustomer')} />
              <PermToggle label={tr('تعديل بيانات العميل')} {...register('canEditCustomer')} />
              <PermToggle label={tr('عرض كشف الحساب')} {...register('canViewStatement')} />
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase">{tr('صلاحيات التحصيل')}</h3>
            <div className="grid grid-cols-2 gap-3">
              <PermToggle label={tr('إظهار رصيد التحصيل المتراكم')} {...register('showCollectionBalance')} />
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={loading} className="btn-primary flex-1 justify-center py-2.5">
              {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : null}
              {rep ? tr('حفظ التعديلات') : tr('إضافة المندوب')}
            </button>
            <button type="button" onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
