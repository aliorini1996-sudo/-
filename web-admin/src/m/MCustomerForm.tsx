import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MapPin, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { customerApi } from '../api/client';
import { Customer } from '../types';
import { SALES_CHANNELS } from '../lib/channels';
import { useTr } from '../i18n/strings';
import { MHeader } from './mobileUi';

type Form = {
  name: string; phone: string; businessName: string; altPhone: string; email: string;
  city: string; district: string; address: string; commercialReg: string; taxNumber: string;
  channel: string; status: 'ACTIVE' | 'INACTIVE' | 'BLOCKED';
  creditLimit: string; paymentDays: string; locationUrl: string;
};

const empty: Form = {
  name: '', phone: '', businessName: '', altPhone: '', email: '',
  city: '', district: '', address: '', commercialReg: '', taxNumber: '',
  channel: '', status: 'ACTIVE', creditLimit: '0', paymentDays: '30', locationUrl: '',
};

/**
 * نموذج العميل — عمود واحد ملء الشاشة، رأسٌ ثابت وزرّ حفظ ثابت أسفل.
 *
 * **بلا `react-hook-form` عمداً:** نماذجها في هذا المشروع ترسل `null` للحقول
 * الفارغة، ومخطّط الخادم يرفض `null` على حقل اختياريّ فيفشل التعديل صامتاً.
 * هنا نُرسل حالةً محكومة ونحذف الفارغ من الحمولة أصلاً — فلا `null` يُرسَل.
 */
export default function MCustomerForm({ customer, onClose, onSaved }: {
  customer: Customer | null;
  onClose: () => void;
  onSaved: (c: Customer) => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const [geoBusy, setGeoBusy] = useState(false);
  const [form, setForm] = useState<Form>(() => customer ? {
    name: customer.name || '', phone: customer.phone || '',
    businessName: customer.businessName || '', altPhone: customer.altPhone || '',
    email: customer.email || '', city: customer.city || '', district: customer.district || '',
    address: customer.address || '', commercialReg: customer.commercialReg || '',
    taxNumber: customer.taxNumber || '', channel: customer.channel || '',
    status: customer.status || 'ACTIVE',
    creditLimit: String(customer.creditLimit ?? 0), paymentDays: String(customer.paymentDays ?? 30),
    locationUrl: '',
  } : empty);

  const set = (k: keyof Form, v: string) => setForm(f => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: async () => {
      // الفارغ يُحذف لا يُرسَل فارغاً أو null (انظر تعليق الرأس)
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        phone: form.phone.trim(),
        status: form.status,
        creditLimit: Number(form.creditLimit) || 0,
        paymentDays: Number(form.paymentDays) || 0,
      };
      (['businessName', 'altPhone', 'email', 'city', 'district', 'address',
        'commercialReg', 'taxNumber', 'channel', 'locationUrl'] as const).forEach(k => {
        const v = form[k].trim();
        if (v) payload[k] = v;
      });
      const res = customer
        ? await customerApi.update(customer.id, payload)
        : await customerApi.create(payload);
      return res.data.data as Customer;
    },
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['m-customers'] });
      toast.success(customer ? tr('تم تحديث العميل') : tr('تم إضافة العميل'));
      onSaved(c);
    },
    onError: (e: unknown) =>
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذّر الحفظ')),
  });

  /** التقاط الموقع من الجهاز — يُرسَل كرابط خرائط يحلّه الخادم إلى إحداثيات */
  const grabLocation = () => {
    if (!navigator.geolocation) { toast.error(tr('جهازك لا يدعم تحديد الموقع')); return; }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        set('locationUrl', `https://maps.google.com/?q=${pos.coords.latitude},${pos.coords.longitude}`);
        setGeoBusy(false);
        toast.success(tr('تم التقاط الموقع'));
      },
      () => { setGeoBusy(false); toast.error(tr('تعذّر تحديد الموقع — فعّل الإذن')); },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const valid = form.name.trim().length > 0 && form.phone.trim().length > 0;

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={customer ? tr('تعديل عميل') : tr('عميل جديد')} onBack={onClose} />

      <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-4">
        <Group title={tr('البيانات الأساسية')}>
          <Field label={tr('اسم العميل')} required value={form.name} onChange={v => set('name', v)} />
          <Field label={tr('رقم الجوال')} required dir="ltr" value={form.phone} onChange={v => set('phone', v)} type="tel" />
          <Field label={tr('اسم المنشأة')} value={form.businessName} onChange={v => set('businessName', v)} />
          <Field label={tr('رقم بديل')} dir="ltr" value={form.altPhone} onChange={v => set('altPhone', v)} type="tel" />
          <Field label={tr('البريد الإلكتروني')} dir="ltr" type="email" value={form.email} onChange={v => set('email', v)} />
        </Group>

        <Group title={tr('العنوان')}>
          <Field label={tr('المدينة')} value={form.city} onChange={v => set('city', v)} />
          <Field label={tr('الحي')} value={form.district} onChange={v => set('district', v)} />
          <Field label={tr('العنوان')} value={form.address} onChange={v => set('address', v)} />
          <button type="button" onClick={grabLocation} disabled={geoBusy}
            className="w-full flex items-center justify-center gap-2 border border-[#E9E1D3] bg-white rounded-xl py-3 text-sm font-semibold text-[#1F1A13] min-h-[48px]">
            {geoBusy ? <Loader2 size={16} className="animate-spin" /> : <MapPin size={16} className="text-[#E15A30]" />}
            {form.locationUrl ? tr('تم التقاط الموقع — أعد الالتقاط') : tr('التقط موقعي الحالي')}
          </button>
          {(customer?.lat != null && customer?.lng != null) && !form.locationUrl && (
            <p className="text-[11px] text-[#2F855A] px-1">{tr('لهذا العميل موقع محفوظ')}</p>
          )}
        </Group>

        <Group title={tr('التصنيف والائتمان')}>
          <div>
            <label className="label">{tr('قناة البيع')}</label>
            <select className="input" value={form.channel} onChange={e => set('channel', e.target.value)}>
              <option value="">{tr('غير محدّد')}</option>
              {SALES_CHANNELS.map(c => <option key={c.code} value={c.code}>{tr(c.ar)}</option>)}
            </select>
          </div>
          <div>
            <label className="label">{tr('الحالة')}</label>
            <select className="input" value={form.status} onChange={e => set('status', e.target.value as Form['status'])}>
              <option value="ACTIVE">{tr('نشط')}</option>
              <option value="INACTIVE">{tr('غير نشط')}</option>
              <option value="BLOCKED">{tr('محظور')}</option>
            </select>
          </div>
          <Field label={tr('الحد الائتماني')} dir="ltr" type="number" value={form.creditLimit} onChange={v => set('creditLimit', v)} />
          <Field label={tr('مدة السداد (يوم)')} dir="ltr" type="number" value={form.paymentDays} onChange={v => set('paymentDays', v)} />
        </Group>

        <Group title={tr('بيانات ضريبية')}>
          <Field label={tr('السجل التجاري')} dir="ltr" value={form.commercialReg} onChange={v => set('commercialReg', v)} />
          <Field label={tr('الرقم الضريبي')} dir="ltr" value={form.taxNumber} onChange={v => set('taxNumber', v)} />
        </Group>

        <div className="h-2" />
      </div>

      {/* زرّ الحفظ ثابت أسفل — لا يُبحث عنه بالتمرير */}
      <div className="flex-shrink-0 border-t border-[#E9E1D3] bg-white p-3"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
        <button onClick={() => save.mutate()} disabled={!valid || save.isPending}
          className="w-full bg-[#E15A30] text-white font-bold py-3.5 rounded-xl min-h-[50px] flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
          {save.isPending && <Loader2 size={16} className="animate-spin" />}
          {customer ? tr('حفظ التعديلات') : tr('إضافة العميل')}
        </button>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1 uppercase tracking-wide">{title}</h3>
      <div className="bg-white rounded-2xl border border-[#F1EBDF] p-3 space-y-3">{children}</div>
    </section>
  );
}

function Field({ label, value, onChange, required, dir, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void;
  required?: boolean; dir?: 'ltr' | 'rtl'; type?: string;
}) {
  return (
    <div>
      <label className="label">{label}{required && ' *'}</label>
      <input className="input" type={type} dir={dir} value={value} step={type === 'number' ? 'any' : undefined} inputMode={type === 'number' ? 'decimal' : undefined} onChange={e => onChange(e.target.value)} />
    </div>
  );
}
