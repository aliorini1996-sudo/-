import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Building2, Check, Info } from 'lucide-react';
import toast from 'react-hot-toast';
import { companyApi } from '../../api/client';

// إعدادات المطعم — تُعيد استخدام /api/company (CompanySettings مشتركة، معزولة بـtenantId).
// إدخال الرقم الضريبي هنا شرط لصحّة رمز الفوترة الإلكترونية (ZATCA QR) على الإيصال.
interface CompanyCfg { name?: string; taxNumber?: string | null; phone?: string | null; address?: string | null; commercialReg?: string | null; currency?: string; countryCode?: string; einvoiceProvider?: string; }

export default function RestaurantSettingsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['company'],
    queryFn: async () => (await companyApi.get()).data.data as CompanyCfg | null,
  });
  const [f, setF] = useState({ name: '', taxNumber: '', phone: '', address: '', commercialReg: '' });
  const set = (k: string, v: string) => setF(s => ({ ...s, [k]: v }));
  useEffect(() => {
    if (data) setF({ name: data.name ?? '', taxNumber: data.taxNumber ?? '', phone: data.phone ?? '', address: data.address ?? '', commercialReg: data.commercialReg ?? '' });
  }, [data]);

  const mut = useMutation({
    mutationFn: () => companyApi.update({ name: f.name.trim(), taxNumber: f.taxNumber.trim() || null, phone: f.phone.trim() || null, address: f.address.trim() || null, commercialReg: f.commercialReg.trim() || null }),
    onSuccess: () => toast.success('تم حفظ الإعدادات'),
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'تعذّر الحفظ'),
  });
  const submit = () => { if (!f.name.trim()) { toast.error('اسم المطعم مطلوب'); return; } mut.mutate(); };

  const isZatca = data?.einvoiceProvider === 'zatca';

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-[#1F1A13] mb-1">إعدادات المطعم</h1>
      <p className="text-[#6E6557] text-sm mb-6">تظهر هذه البيانات على الفاتورة والإيصال المطبوع.</p>

      {isLoading ? <div className="card text-center py-16 text-gray-400">جاري التحميل…</div> : (
        <div className="card p-6 space-y-4">
          <div className="flex items-center gap-2 text-[#1F1A13] font-bold"><Building2 size={18} className="text-[#E15A30]" /> بيانات المطعم</div>

          <div>
            <label className="label">اسم المطعم *</label>
            <input className="input" value={f.name} onChange={e => set('name', e.target.value)} placeholder="مثال: مطعم الأصالة" />
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="label">الرقم الضريبي (VAT)</label>
              <input className="input" dir="ltr" value={f.taxNumber} onChange={e => set('taxNumber', e.target.value)} placeholder="3XXXXXXXXXXXXX3" />
            </div>
            <div>
              <label className="label">السجل التجاري</label>
              <input className="input" dir="ltr" value={f.commercialReg} onChange={e => set('commercialReg', e.target.value)} />
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="label">الهاتف</label>
              <input className="input" dir="ltr" value={f.phone} onChange={e => set('phone', e.target.value)} />
            </div>
            <div>
              <label className="label">العنوان</label>
              <input className="input" value={f.address} onChange={e => set('address', e.target.value)} />
            </div>
          </div>

          {isZatca && !f.taxNumber.trim() && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 text-xs text-amber-800">
              <Info size={15} className="shrink-0 mt-0.5" />
              أدخل الرقم الضريبي ليصدر رمز الفوترة الإلكترونية (ZATCA) صحيحاً على الإيصال.
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            <p className="text-xs text-[#9A8F7E]">
              الدولة: {data?.countryCode || '—'} · العملة: {data?.currency || '—'}
              {isZatca ? ' · الفوترة: ZATCA (السعودية)' : ''}
            </p>
            <button onClick={submit} disabled={mut.isPending} className="btn-primary py-2.5">
              {mut.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Check size={16} />} حفظ
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
