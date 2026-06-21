import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { companyApi } from '../api/client';
import { Building2, Save, Upload, Trash2, Image as ImageIcon } from 'lucide-react';
import toast from 'react-hot-toast';
import { Header } from '../rep/RepDocuments';

interface CompanyForm {
  name: string;
  address?: string;
  taxNumber?: string;
  commercialReg?: string;
  phone?: string;
  email?: string;
}

const PRESET_COLORS = ['#1e3a8a', '#0f766e', '#b91c1c', '#7c3aed', '#b45309', '#0e7490', '#15803d', '#374151'];
const STYLES = [
  { id: 'classic', label: 'كلاسيكي', desc: 'الشعار والاسم يميناً، حدّ ملوّن' },
  { id: 'banner', label: 'بانر', desc: 'شريط ملوّن كامل بالأبيض' },
  { id: 'minimal', label: 'بسيط', desc: 'هادئ بخط رفيع' },
];

export default function CompanySettingsPage() {
  const qc = useQueryClient();
  const { register, handleSubmit, reset, formState: { errors } } = useForm<CompanyForm>();
  // الهوية البصرية تُدار بـ state عادي لضمان إرسالها بدقّة
  const [logo, setLogo] = useState('');
  const [primaryColor, setPrimaryColor] = useState('#1e3a8a');
  const [headerStyle, setHeaderStyle] = useState('classic');

  const { data, isLoading } = useQuery({
    queryKey: ['company'],
    queryFn: async () => {
      const res = await companyApi.get();
      return res.data.data as (CompanyForm & { logo?: string; primaryColor?: string; headerStyle?: string }) | null;
    },
  });

  useEffect(() => {
    if (!data) return;
    reset({
      name: data.name || '', address: data.address || '', taxNumber: data.taxNumber || '',
      commercialReg: data.commercialReg || '', phone: data.phone || '', email: data.email || '',
    });
    setLogo(data.logo || '');
    setPrimaryColor(data.primaryColor || '#1e3a8a');
    setHeaderStyle(data.headerStyle || 'classic');
  }, [data, reset]);

  const mutation = useMutation({
    mutationFn: (values: CompanyForm) => companyApi.update({ ...values, logo, primaryColor, headerStyle }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['company'] });
      toast.success('تم حفظ بيانات الشركة');
    },
    onError: () => toast.error('حدث خطأ في الحفظ'),
  });

  const onLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('الملف يجب أن يكون صورة'); return; }
    if (file.size > 600 * 1024) { toast.error('حجم الشعار كبير — الحد 600 كيلوبايت'); return; }
    const reader = new FileReader();
    reader.onload = () => setLogo(reader.result as string);
    reader.readAsDataURL(file);
  };

  if (isLoading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  const previewCompany = {
    name: data?.name || 'اسم الشركة', address: data?.address, taxNumber: data?.taxNumber,
    commercialReg: data?.commercialReg, phone: data?.phone, email: data?.email,
    logo, primaryColor, headerStyle,
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">إعدادات الشركة</h1>
      </div>

      <form onSubmit={handleSubmit(values => mutation.mutate(values))} className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* العمود الأيمن: البيانات + الهوية */}
        <div className="space-y-5">
          <div className="card">
            <div className="flex items-center gap-3 mb-5 pb-4 border-b border-gray-100">
              <div className="w-11 h-11 bg-blue-100 rounded-xl flex items-center justify-center">
                <Building2 size={22} className="text-blue-600" />
              </div>
              <div>
                <p className="font-semibold text-gray-800">بيانات الشركة</p>
                <p className="text-xs text-gray-400">تظهر في ترويسة كل المطبوعات</p>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="label">اسم الشركة *</label>
                <input className="input" {...register('name', { required: true })} />
                {errors.name && <p className="text-red-500 text-xs mt-1">مطلوب</p>}
              </div>
              <div>
                <label className="label">العنوان</label>
                <input className="input" {...register('address')} placeholder="المدينة - الحي - الشارع" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">الرقم الضريبي</label>
                  <input className="input" dir="ltr" {...register('taxNumber')} />
                </div>
                <div>
                  <label className="label">السجل التجاري</label>
                  <input className="input" dir="ltr" {...register('commercialReg')} />
                </div>
                <div>
                  <label className="label">رقم الهاتف</label>
                  <input className="input" dir="ltr" {...register('phone')} />
                </div>
                <div>
                  <label className="label">البريد الإلكتروني</label>
                  <input className="input" type="email" dir="ltr" {...register('email')} />
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="flex items-center gap-3 mb-5 pb-4 border-b border-gray-100">
              <div className="w-11 h-11 bg-purple-100 rounded-xl flex items-center justify-center">
                <ImageIcon size={22} className="text-purple-600" />
              </div>
              <div>
                <p className="font-semibold text-gray-800">هوية الشركة في المطبوعات</p>
                <p className="text-xs text-gray-400">الشعار واللون والشكل</p>
              </div>
            </div>

            {/* الشعار */}
            <div className="mb-5">
              <label className="label">شعار الشركة</label>
              <div className="flex items-center gap-3">
                <div className="w-16 h-16 rounded-xl border-2 border-dashed border-gray-200 flex items-center justify-center overflow-hidden bg-gray-50 flex-shrink-0">
                  {logo
                    ? <img src={logo} alt="شعار" className="w-full h-full object-contain" />
                    : <ImageIcon size={22} className="text-gray-300" />}
                </div>
                <div className="flex flex-col gap-2">
                  <label className="btn-secondary cursor-pointer text-xs">
                    <Upload size={14} /> اختيار صورة
                    <input type="file" accept="image/*" className="hidden" onChange={onLogoChange} />
                  </label>
                  {logo && (
                    <button type="button" onClick={() => setLogo('')} className="text-red-500 text-xs flex items-center gap-1">
                      <Trash2 size={12} /> إزالة الشعار
                    </button>
                  )}
                  <span className="text-[10px] text-gray-400">PNG/JPG — الحد 600KB</span>
                </div>
              </div>
            </div>

            {/* اللون */}
            <div className="mb-5">
              <label className="label">لون الترويسة</label>
              <div className="flex items-center gap-2 flex-wrap">
                <input type="color" className="w-10 h-9 rounded border border-gray-200 cursor-pointer p-0.5"
                  value={primaryColor} onChange={e => setPrimaryColor(e.target.value)} />
                <span className="font-mono text-xs text-gray-500" dir="ltr">{primaryColor}</span>
                <div className="flex gap-1.5 mr-2">
                  {PRESET_COLORS.map(c => (
                    <button key={c} type="button" onClick={() => setPrimaryColor(c)}
                      className={`w-6 h-6 rounded-full border-2 ${primaryColor === c ? 'border-gray-800' : 'border-white shadow'}`}
                      style={{ background: c }} title={c} />
                  ))}
                </div>
              </div>
            </div>

            {/* الشكل */}
            <div>
              <label className="label">شكل الترويسة</label>
              <div className="grid grid-cols-3 gap-2">
                {STYLES.map(s => (
                  <button key={s.id} type="button" onClick={() => setHeaderStyle(s.id)}
                    className={`text-right p-3 rounded-xl border-2 transition-all ${headerStyle === s.id ? 'border-blue-500 bg-blue-50' : 'border-gray-100 hover:border-gray-200'}`}>
                    <p className="font-semibold text-sm text-gray-800">{s.label}</p>
                    <p className="text-[10px] text-gray-400 mt-0.5">{s.desc}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button type="submit" disabled={mutation.isPending} className="btn-primary px-6 py-2.5">
            {mutation.isPending
              ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              : <Save size={16} />}
            حفظ الإعدادات
          </button>
        </div>

        {/* العمود الأيسر: المعاينة الحيّة */}
        <div className="space-y-3">
          <p className="text-sm font-semibold text-gray-500">معاينة الترويسة (كما ستظهر في المطبوعات)</p>
          <div className="card bg-white p-0 overflow-hidden">
            <div style={{ width: 754, transformOrigin: 'top right', transform: 'scale(0.62)' }} className="p-5">
              <Header title="فاتورة ضريبية" company={previewCompany} />
            </div>
            <div style={{ height: 130 }} />
          </div>
          <p className="text-xs text-gray-400">التغييرات تظهر فوراً هنا، وتنعكس على الفواتير وسندات القبض وكشوف الحساب بعد الحفظ.</p>
        </div>
      </form>
    </div>
  );
}
