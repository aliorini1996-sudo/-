import { useState, forwardRef } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { SalesRep } from '../../types';
import { useTr } from '../../i18n/strings';
import { X, Eye, EyeOff, RefreshCw, Smartphone } from 'lucide-react';
import toast from 'react-hot-toast';
import { salesRepApi } from '../../api/client';
import { formatDate } from '../../utils/format';

interface FormData extends Partial<SalesRep> { password?: string; }
interface Props {
  rep: SalesRep | null; onClose: () => void; onSave: (data: FormData) => void; loading: boolean;
  /** المحاسبة مفعّلة؟ افتراضه `true` — الغياب يعني «مفعّل» كما في العَلَم نفسه */
  accountingOn?: boolean;
}

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

/** مسافة قيود الموقع — ١٠ إلى ٥٠٠٠ متر، و٥٠ افتراضاً كما كانت ثابتةً قبل (يطابق التحقّق في salesReps.ts) */
const RADIUS_MIN_M = 10;
const RADIUS_MAX_M = 5000;
const RADIUS_DEFAULT_M = 50;
/** أيام العمل افتراضاً: الأحد–الخميس (بتات الأحد=1 … السبت=64) */
const SHIFT_DAYS_DEFAULT = 31;
/** أيام الأسبوع بترتيب العرض (السبت أولاً) وبتّ كلٍّ منها */
const WEEK_DAYS: { label: string; bit: number }[] = [
  { label: 'السبت', bit: 64 }, { label: 'الأحد', bit: 1 }, { label: 'الاثنين', bit: 2 }, { label: 'الثلاثاء', bit: 4 },
  { label: 'الأربعاء', bit: 8 }, { label: 'الخميس', bit: 16 }, { label: 'الجمعة', bit: 32 },
];

const RadiusInput = forwardRef<HTMLInputElement, { label: string; error?: string } & React.InputHTMLAttributes<HTMLInputElement>>(
  ({ label, error, ...props }, ref) => (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <label className="text-sm text-gray-600">{label}</label>
      <input ref={ref} type="number" inputMode="numeric" min={RADIUS_MIN_M} max={RADIUS_MAX_M} step={1} dir="ltr"
        className="input w-28 text-center" {...props} />
      {error && <span className="text-xs text-red-600 w-full">{error}</span>}
    </div>
  )
);
RadiusInput.displayName = 'RadiusInput';

export default function SalesRepModal({ rep, onClose, onSave, loading, accountingOn = true }: Props) {
  const tr = useTr();
  const [showPass, setShowPass] = useState(false);
  // الجهاز المربوط بالبصمة — يُفكّ من هنا مباشرةً (لا مع حفظ النموذج)
  const [bound, setBound] = useState<{ name: string | null; at: string | null }>({ name: rep?.boundDeviceName ?? null, at: rep?.boundDeviceAt ?? null });
  const [unbinding, setUnbinding] = useState(false);
  const qc = useQueryClient();
  const unbind = async () => {
    if (!rep) return;
    setUnbinding(true);
    try {
      const { data } = await salesRepApi.unbindDevice(rep.id);
      setBound({ name: null, at: null });
      // النافذة تُبنى من قائمة المناديب المخزّنة: بلا إبطالٍ يعود الجهاز ظاهراً مربوطاً عند إعادة فتحها
      void qc.invalidateQueries({ queryKey: ['sales-reps'] });
      if (data?.data?.unbound === false) toast(tr('لا جهاز مربوط بهذا المندوب'));
      else toast.success(tr('فك ربط الجهاز واول بصمة قادمة تربط جهازه الجديد'));
    } catch { toast.error(tr('تعذر الحفظ')); }
    setUnbinding(false);
  };
  const defaults: FormData = rep
    ? { ...rep, email: rep.email || '', canSellOnCredit: rep.canSellOnCredit ?? true, canSellInCash: rep.canSellInCash ?? true, canSellOnInstallment: rep.canSellOnInstallment ?? false, canManageVanStock: rep.canManageVanStock ?? true, showRouteOnMap: rep.showRouteOnMap ?? true }
    : {
      isActive: true,
      canCreateInvoice: true,
      canSellOnCredit: true,
      canSellOnInstallment: false, // التقسيط ائتمان أطول — لا يُفتح إلا بقرار
      canSellInCash: true,
      canCreateReceipt: true,
      canManageVanStock: true,
      canViewStatement: true,
      canAddCustomer: false,
      showCollectionBalance: true,
      requireCustomerProximity: false,
      requireLocationOn: false,
      requirePunchAtCustomer: false,
      punchOutsideAction: 'REJECT',
      requireBoundDevice: false,
      requirePresenceCheck: false,
      showRouteOnMap: true,
      shiftStart: null,
      shiftEnd: null,
      shiftDays: SHIFT_DAYS_DEFAULT,
      proximityRadiusM: RADIUS_DEFAULT_M,
      punchRadiusM: RADIUS_DEFAULT_M,
      maxDiscountPct: 0,
    };
  const { register, handleSubmit, setValue, watch, formState: { errors } } = useForm<FormData>({
    defaultValues: {
      ...defaults, proximityRadiusM: defaults.proximityRadiusM ?? RADIUS_DEFAULT_M, punchRadiusM: defaults.punchRadiusM ?? RADIUS_DEFAULT_M,
      punchOutsideAction: defaults.punchOutsideAction ?? 'REJECT', shiftDays: defaults.shiftDays ?? SHIFT_DAYS_DEFAULT,
    },
  });
  // المسافة تُطلب حين يُفعَّل قيدها وحده — والمخفيّة تبقى بقيمتها فلا تضيع إن أُطفئ القيد ثم أُعيد
  const radiusRules = {
    valueAsNumber: true,
    validate: (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= RADIUS_MIN_M && v <= RADIUS_MAX_M) || tr('المسافة بين 10 و5000 متر'),
  } as const;

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
                      validate: v => !v ? (rep ? true : tr('كلمة المرور مطلوبة')) : (v.length >= 8 || tr('كلمة المرور 8 أحرف على الأقل')),
                    })} />
                  <button type="button" onClick={() => setShowPass(s => !s)} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                    {showPass ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
                {errors.password
                  ? <p className="text-red-500 text-xs mt-1">{errors.password.message}</p>
                  : !rep && <p className="text-gray-400 text-xs mt-1">{tr('8 أحرف على الأقل يسلمها الأدمن للمندوب')}</p>}
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

          {/* صلاحيات محاسبية بحتة (فوترة · تسعير وخصم · تحصيل · مخزون سيارة):
              تُحذف كلّها حين تُطفأ المحاسبة. وما لا يُسجَّل في النموذج تُرسَل
              قيمته المحفوظة من defaultValues، فلا تُصفَّر صلاحية بالإخفاء. */}
          {accountingOn && (<>
          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase">{tr('صلاحيات المبيعات')}</h3>
            <div className="grid grid-cols-2 gap-3">
              <PermToggle label={tr('إنشاء فاتورة')} {...register('canCreateInvoice')} />
              <PermToggle label={tr('البيع الآجل')} {...register('canSellOnCredit')} />
              <PermToggle label={tr('البيع بالتقسيط')} {...register('canSellOnInstallment')} />
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
              <input type="number" className="input" min="0" max="100" step="any" {...register('maxDiscountPct', { valueAsNumber: true })} />
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
          </>)}

          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase">{tr('صلاحيات العملاء')}</h3>
            <div className="grid grid-cols-2 gap-3">
              <PermToggle label={tr('إضافة عميل')} {...register('canAddCustomer')} />
              <PermToggle label={tr('تعديل بيانات العميل')} {...register('canEditCustomer')} />
              {accountingOn && <PermToggle label={tr('عرض كشف الحساب')} {...register('canViewStatement')} />}
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase">{tr('قيود الموقع الميداني')}</h3>
            <div className="grid grid-cols-1 gap-3">
              <PermToggle label={tr('البيع داخل نطاق العميل')} {...register('requireCustomerProximity')} />
            </div>
            {watch('requireCustomerProximity') && (
              <RadiusInput label={tr('المسافة المسموحة بالمتر')} error={errors.proximityRadiusM?.message} {...register('proximityRadiusM', radiusRules)} />
            )}
            <p className="text-xs text-gray-400 mt-2 leading-relaxed">
              {tr('عند التفعيل لا يفتح المندوب ملف العميل الا وهو داخل المسافة المحددة من موقعه المسجل، والعميل بلا موقع يمنع منعا باتا، ويقفل عليه تعديل موقع العميل')}
            </p>
            <div className="grid grid-cols-1 gap-3 mt-3">
              <PermToggle label={tr('اشتراط تفعيل الموقع')} {...register('requireLocationOn')} />
            </div>
            <p className="text-xs text-gray-400 mt-2 leading-relaxed">
              {tr('عند التفعيل لا يدخل المندوب صفحة اي عميل — ولا يصدر له فاتورة ولا سندا ولا يسجل زيارة ولا يضيف عميلا — الا والموقع مفعل في جواله ومحدد بدقة وهو متصل بالإنترنت وظاهر على الخريطة، وبقية التطبيق متاحة له، ويرسل موقعه للخريطة ولو كان التتبع متوقفا للشركة')}
            </p>
            <div className="grid grid-cols-1 gap-3 mt-3">
              <PermToggle label={tr('بصمة الحضور بموقع عميل')} {...register('requirePunchAtCustomer')} />
            </div>
            {watch('requirePunchAtCustomer') && (<>
              <RadiusInput label={tr('المسافة المسموحة بالمتر')} error={errors.punchRadiusM?.message} {...register('punchRadiusM', radiusRules)} />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="text-sm text-gray-600">{tr('البصمة خارج النطاق')}</label>
                <select className="input w-auto py-1.5" {...register('punchOutsideAction')}>
                  <option value="REJECT">{tr('ارفضها')}</option>
                  <option value="FLAG">{tr('اقبلها مع وسم خارج النطاق')}</option>
                </select>
              </div>
            </>)}
            <p className="text-xs text-gray-400 mt-2 leading-relaxed">
              {watch('punchOutsideAction') === 'FLAG' && watch('requirePunchAtCustomer')
                ? tr('عند التفعيل تقبل بصمة المندوب خارج المسافة المحددة وتظهر لك في تقرير ساعات العمل موسومة خارج النطاق مع مسافة اقرب عملائه')
                : tr('عند التفعيل لا يبصم المندوب حضورا ولا انصرافا الا وهو داخل المسافة المحددة من موقع احد عملائه المسجل، والموقع مطفأ في جواله يمنع البصمة')}
            </p>
            <div className="grid grid-cols-1 gap-3 mt-3">
              <PermToggle label={tr('ربط البصمة بجهاز واحد')} {...register('requireBoundDevice')} />
            </div>
            <p className="text-xs text-gray-400 mt-2 leading-relaxed">
              {tr('عند التفعيل يربط اول جهاز يبصم منه المندوب ولا تقبل بصمته بعدها الا منه، ولا يبصم جهاز مربوط بمندوب لغيره ضد البصمة بالنيابة، وان غير جواله او مسح بيانات التطبيق فك الربط من هنا')}
            </p>
            {rep && bound.name && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
                <Smartphone size={14} className="text-gray-400" />
                <span>{tr('الجهاز المربوط')}: <b dir="ltr">{bound.name}</b>{bound.at && <> · {formatDate(bound.at)}</>}</span>
                <button type="button" onClick={unbind} disabled={unbinding} className="ms-auto text-[#C94E28] font-semibold hover:underline disabled:opacity-50">
                  {tr('فك الربط')}
                </button>
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 mt-3">
              <PermToggle label={tr('التحقق العشوائي من التواجد')} {...register('requirePresenceCheck')} />
            </div>
            <p className="text-xs text-gray-400 mt-2 leading-relaxed">{tr('عند التفعيل يصل المندوب اشعار اثبت تواجدك مرتين الى ثلاث مرات في اليوم باوقات عشوائية اثناء نوبته، ويفتح التطبيق ويضغط اثبت تواجدي خلال دقيقتين فيسجل موقعه، وتظهر النتائج في تقرير ساعات العمل')}</p>
            <div className="grid grid-cols-1 gap-3 mt-3">
              <PermToggle label={tr('عرض خط السير على الخريطة')} {...register('showRouteOnMap')} />
            </div>
            <p className="text-xs text-gray-400 mt-2 leading-relaxed">{tr('عند الايقاف لا يرسم خط سير المندوب على خريطة التتبع، ويبقى موقعه الحالي وزياراته وبصمته وخط سيره المخطط ظاهرة، ويستمر تسجيل مواقعه فيعود خط سيره كاملا عند التفعيل')}</p>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase">{tr('موعد الدوام للتنبيهات')}</h3>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-gray-600">{tr('بداية الدوام')}
                <input type="time" dir="ltr" className="input w-32 py-1.5" {...register('shiftStart', { setValueAs: (v: unknown) => (v ? String(v) : null) })} />
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-600">{tr('نهاية الدوام')}
                <input type="time" dir="ltr" className="input w-32 py-1.5" {...register('shiftEnd', { setValueAs: (v: unknown) => (v ? String(v) : null) })} />
              </label>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {WEEK_DAYS.map((d) => {
                const days = watch('shiftDays') ?? SHIFT_DAYS_DEFAULT;
                const on = (days & d.bit) !== 0;
                return (
                  <button key={d.bit} type="button" onClick={() => setValue('shiftDays', on ? days & ~d.bit : days | d.bit, { shouldDirty: true })}
                    className={`rounded-lg border px-2.5 py-1 text-xs ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28] font-semibold' : 'border-gray-200 text-gray-500'}`}>
                    {tr(d.label)}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-gray-400 mt-2 leading-relaxed">
              {tr('اختياري ويستعمل للتنبيهات وحدها تذكير على جوال المندوب قبل بداية دوامه بربع ساعة ان لم يبصم، وتنبيه ان بقيت فترته مفتوحة بعد نهاية الدوام بنصف ساعة، وبلا موعد ينبه ان بقيت مفتوحة عشر ساعات، ويفعل المندوب التنبيهات من شاشة البصمة')}
            </p>
          </div>

          {accountingOn && (
          <div>
            <h3 className="text-sm font-semibold text-gray-500 mb-3 uppercase">{tr('صلاحيات التحصيل')}</h3>
            <div className="grid grid-cols-2 gap-3">
              <PermToggle label={tr('إظهار رصيد التحصيل المتراكم')} {...register('showCollectionBalance')} />
            </div>
          </div>
          )}

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
