import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { suppliersApi, type Supplier } from '../../api/suppliers';
import { useTr } from '../../i18n/strings';
import { backdropClose } from '../../lib/backdropClose';
import {
  draftOfSupplier, isValidIban, normalizeIban, SUPPLIER_FIELD_MAX, SUPPLIER_PROBLEM_TEXT, supplierCreateBody, supplierErrorText, supplierProblem,
  supplierUpdateBody, type SupplierDraft,
} from './supplierLogic';

/** مفاتيح ما يتغيّر بعد كتابة مورّد: القائمة والبطاقة ومنتقي المورّد في المستودع (['suppliers', …]) والأعمار */
export const SUPPLIER_KEYS = ['suppliers', 'supplier', 'supplier-statement', 'supplier-open-bills', 'supplier-aging', 'supplier-payments'] as const;

/**
 * نافذة إنشاء/تعديل المورّد بكل حقوله (مدة السداد منها: تحسب تاريخ استحقاق الشراء الآجل). التعديل يرسل ما تغيّر وحده،
 * والممسوح null. `taxOff`: شركة «بلا ضريبة» لا ترى خانة الرقم الضريبي (وقيمته المحفوظة تبقى كما هي — لا تُرسل).
 */
export default function SupplierFormModal({ supplier, taxOff, onClose, onSaved }: {
  supplier: Supplier | null; taxOff: boolean; onClose: () => void; onSaved?: (s: Supplier | null) => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const editing = !!supplier;
  const [d, setD] = useState<SupplierDraft>(() => draftOfSupplier(supplier));
  const [touched, setTouched] = useState(false);
  const set = (k: keyof SupplierDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setD(x => ({ ...x, [k]: e.target.value }));
  const problem = supplierProblem(d);
  const updateBody = editing ? supplierUpdateBody(d, supplier) : null;
  const unchanged = !!updateBody && Object.keys(updateBody).length === 0;

  const save = useMutation({
    mutationFn: async () => {
      const res = editing ? await suppliersApi.update(supplier.id, updateBody ?? {}) : await suppliersApi.create(supplierCreateBody(d));
      return ((res.data as { data?: Supplier } | undefined)?.data ?? null) as Supplier | null;
    },
    onSuccess: (s) => {
      SUPPLIER_KEYS.forEach(k => qc.invalidateQueries({ queryKey: [k] }));
      toast.success(editing ? tr('تم حفظ المورد') : tr('أضيف المورد'));
      onSaved?.(s);
      onClose();
    },
    onError: (e: unknown) => toast.error(tr(supplierErrorText(e, editing ? 'تعذر حفظ المورد' : 'تعذر إضافة المورد'))),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (problem || save.isPending || unchanged) return;
    save.mutate();
  };

  const ibanBad = d.iban.trim() !== '' && !isValidIban(d.iban);
  const field = (k: keyof typeof SUPPLIER_FIELD_MAX, label: string, opts: { dir?: 'ltr'; type?: string; placeholder?: string; required?: boolean } = {}) => (
    <div>
      <label className="label">{label}{opts.required && <span className="text-red-500"> *</span>}</label>
      <input className="input w-full" value={d[k]} onChange={set(k)} maxLength={SUPPLIER_FIELD_MAX[k]} dir={opts.dir}
        type={opts.type ?? 'text'} placeholder={opts.placeholder} autoComplete="off" />
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <form className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()} onSubmit={submit} noValidate>
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-[#F1EBDF]">
          <h2 className="text-lg font-bold text-[#1F1A13]">{editing ? tr('تعديل المورد') : tr('مورد جديد')}</h2>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#F6F1E7] text-[#6E6557]" aria-label={tr('إغلاق')}><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <section>
            <h3 className="text-sm font-bold text-[#1F1A13] mb-3">{tr('البيانات الأساسية')}</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {field('name', tr('اسم المورد'), { required: true })}
              {field('nameEn', tr('الاسم بالإنجليزية'), { dir: 'ltr' })}
              {field('code', tr('رمز المورد'), { dir: 'ltr' })}
              <div>
                <label className="label">{tr('مدة السداد بالأيام')}</label>
                <input className="input w-full" inputMode="numeric" value={d.paymentDays} onChange={set('paymentDays')} maxLength={3} dir="ltr" placeholder="30" />
                <p className="text-[11px] text-[#9A8F7E] mt-1">{tr('يحسب منها تاريخ استحقاق فاتورة الشراء الآجل وصفر يعني فوري')}</p>
              </div>
            </div>
          </section>

          <section>
            <h3 className="text-sm font-bold text-[#1F1A13] mb-3">{tr('البيانات النظامية')}</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {!taxOff && field('vatNumber', tr('الرقم الضريبي'), { dir: 'ltr' })}
              {field('crNumber', tr('السجل التجاري'), { dir: 'ltr' })}
            </div>
          </section>

          <section>
            <h3 className="text-sm font-bold text-[#1F1A13] mb-3">{tr('التواصل والعنوان')}</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {field('phone', tr('الجوال'), { dir: 'ltr', type: 'tel' })}
              {field('email', tr('البريد الإلكتروني'), { dir: 'ltr', type: 'email' })}
              {field('city', tr('المدينة'))}
              {field('address', tr('العنوان'))}
            </div>
          </section>

          <section>
            <h3 className="text-sm font-bold text-[#1F1A13] mb-3">{tr('البيانات البنكية')}</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">{tr('الآيبان')}</label>
                <input className={`input w-full ${ibanBad ? 'border-red-400' : ''}`} value={d.iban} onChange={set('iban')} maxLength={SUPPLIER_FIELD_MAX.iban}
                  dir="ltr" placeholder="SA00 0000 0000 0000 0000 0000" autoComplete="off"
                  onBlur={() => { if (d.iban.trim() && isValidIban(d.iban)) setD(x => ({ ...x, iban: normalizeIban(x.iban) })); }} />
                {ibanBad && <p className="text-[11px] text-red-600 mt-1">{tr(SUPPLIER_PROBLEM_TEXT.IBAN_INVALID)}</p>}
              </div>
              {field('bankName', tr('اسم البنك'))}
            </div>
          </section>

          <section>
            <label className="label">{tr('ملاحظات')}</label>
            <textarea className="input w-full min-h-[70px]" value={d.notes} onChange={set('notes')} maxLength={SUPPLIER_FIELD_MAX.notes} />
          </section>

          {touched && problem && (
            <p className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-700">{tr(SUPPLIER_PROBLEM_TEXT[problem])}</p>
          )}
        </div>

        <div className="flex gap-3 px-6 py-4 border-t border-[#F1EBDF]">
          <button type="submit" className="btn-primary" disabled={save.isPending || unchanged}>
            {save.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save size={16} />}
            {editing ? tr('حفظ التعديلات') : tr('إضافة المورد')}
          </button>
          <button type="button" onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
          {unchanged && <span className="self-center text-[12px] text-[#9A8F7E]">{tr('لا تغييرات للحفظ')}</span>}
        </div>
      </form>
    </div>
  );
}
