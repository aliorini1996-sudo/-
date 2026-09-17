import { useState } from 'react';
import { ArrowRight, Check, FileWarning } from 'lucide-react';
import repApi from './repApi';
import { isNetworkError } from './offlineSync';
import { currentRepId } from './offlineDb';
import { useTr } from '../i18n/strings';
import BuyerDataFields from '../components/BuyerDataFields';
import {
  BUYER_BILLING_FIELDS, BUYER_REP_COMPLETE_FIELDS, BuyerField, BuyerRowLike, buyerDowngrade, customerBuyerStatus, missingBuyerFormFields,
  repCompleteOnlyDenied,
} from '../lib/zatca/buyerData';
import {
  BUYER_FIELD_UI_LABELS_AR as BUYER_FIELD_LABELS_AR, BuyerFormValues, buyerFormCheck, buyerFormValues, buyerUpdatePayload, repCompleteLocked,
} from '../lib/zatca/buyerForm';

/**
 * فوترة ZATCA المرحلة الثانية (Z5.1a، D2) — بيانات الفوترة في تطبيق المندوب.
 *
 * كل ما هنا يُرسم فقط حين zatcaCollectOn(company) (يقرّره RepApp) — غير المعلَّمين لا يرون شيئاً.
 *
 *  • RepBuyerBanner: لافتة في ملف العميل حين تنقص بيانات فاتورته الضريبية أو لم يُصنَّف، مع «أكمل البيانات».
 *  • RepBuyerDataForm: نقطة الفوترة الضيّقة (قرار المالك Q3) — PATCH /customers/:id/buyer-data لمن يصدر الفواتير ولو بلا
 *    «تعديل بيانات العميل»: حقول الفوترة وحدها، بلا مال ولا موقع. المندوب يُكمل ولا يمسح ولا يحوّل منشأة إلى فرد (نقد الخطة 21)
 *    — يفحصه هنا قبل الإرسال والخادم مرجع. يلزمه اتصال (تعديل سجلّ قائم لا يُطابَق من طابور). وبلا «تعديل بيانات العميل» يُكمل
 *    الفارغ من نوع العميل والمعرّف والعنوان الوطني والدولة وحده: المحفوظ واسم المنشأة والرقم الضريبي والسجل للعرض فقط.
 */

/**
 * شريحة «بيانات فوترة ناقصة (n)» في قائمة العملاء: من الخادم (لا من كاش الألف) — والنقطة تمسح عملاء النطاق للملخّص، فتُحفظ
 * النتيجة 5 دقائق لكل مندوب (فتح التبويب مراراً لا يكرّر المسح؛ ومندوب آخر على الجهاز لا يرى قائمة زميله).
 */
const INCOMPLETE_TTL_MS = 5 * 60 * 1000;
let incompleteMemo: { repId: string | undefined; at: number; value: { rows: any[]; count: number } } | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function fetchIncompleteBuyers(now = Date.now()): Promise<{ rows: any[]; count: number }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const repId = currentRepId();
  if (incompleteMemo && incompleteMemo.repId === repId && now - incompleteMemo.at < INCOMPLETE_TTL_MS) return incompleteMemo.value;
  const { data } = await repApi.get('/customers/zatca-buyer-data', { params: { bucket: 'incomplete', limit: 200 } });
  const value = { rows: data?.data ?? [], count: data?.summary?.incomplete ?? (data?.data ?? []).length };
  incompleteMemo = { repId, at: now, value };
  return value;
}

/** بعد حفظ بيانات فوترة عميل: الشريحة تُعاد من الخادم عند الفتح التالي. */
export function invalidateIncompleteBuyers(): void {
  incompleteMemo = null;
}

export function RepBuyerBanner({ customer, canComplete, onComplete }: {
  customer: BuyerRowLike; canComplete: boolean; onComplete: () => void;
}) {
  const tr = useTr();
  const st = customerBuyerStatus(customer);
  if (st.bucket !== 'incomplete' && st.bucket !== 'unclassified') return null;
  const missing = missingBuyerFormFields(st);
  return (
    <div className="mb-3 bg-amber-50 border border-amber-200 text-amber-900 rounded-2xl p-3.5 text-sm leading-relaxed">
      <p className="font-bold mb-1 flex items-center gap-1.5">
        <FileWarning size={15} />
        {st.bucket === 'incomplete' ? tr('بيانات الفوترة الإلكترونية ناقصة') : tr('العميل غير مصنف')}
      </p>
      <p className="text-xs">
        {st.bucket === 'incomplete'
          ? `${tr('ناقص للفاتورة الضريبية')}: ${missing.map(f => tr(BUYER_FIELD_LABELS_AR[f])).join('، ')}`
          : tr('حدد نوع العميل هل هو منشأة أم فرد')}
      </p>
      <p className="text-[11px] opacity-80 mt-0.5">{tr('تجمع الآن استعدادا للربط مع هيئة الزكاة ولا تمنع الحفظ أو البيع')}</p>
      {canComplete && (
        <button onClick={onComplete}
          className="mt-2 bg-amber-600 hover:bg-amber-700 text-white rounded-xl px-3 py-2 text-xs font-bold active:scale-95 transition">
          {tr('أكمل البيانات')}
        </button>
      )}
    </div>
  );
}

export function RepBuyerDataForm({ customer, canEditCustomer = false, onClose, onSaved }: {
  customer: BuyerRowLike & { id: string; name?: string | null; channel?: string | null };
  /** «تعديل بيانات العميل» (perms.canEditCustomer === true) — بدونها إكمال الفارغ من حقول Q3 وحدها. */
  canEditCustomer?: boolean;
  onClose: () => void;
  /** حقول الفوترة كما حفظها الخادم (تُدمج في العميل المحدَّد والكاش). */
  onSaved: (patch: Partial<Record<BuyerField, string | null>>) => void;
}) {
  const tr = useTr();
  const [values, setValues] = useState<BuyerFormValues>(() => buyerFormValues(customer));
  const [errors, setErrors] = useState<Partial<Record<BuyerField, string>>>({});
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const fields = canEditCustomer ? BUYER_BILLING_FIELDS : BUYER_REP_COMPLETE_FIELDS;
  const locked = canEditCustomer ? undefined : (f: BuyerField) => repCompleteLocked(customer, f);

  const submit = async () => {
    setMsg('');
    const check = buyerFormCheck(values, customer, BUYER_BILLING_FIELDS);
    setErrors(check.errors);
    if (!check.ok) { setMsg(tr('صحح بيانات الفوترة الإلكترونية')); return; }
    const restricted = canEditCustomer ? check.cleared : repCompleteOnlyDenied(customer, check.patch);
    if (restricted.length > 0 || buyerDowngrade(customer, check.patch)) {
      setMsg(tr('يمكنك إكمال بيانات الفوترة فقط مسحها أو تحويل العميل من منشأة إلى فرد للإدارة'));
      return;
    }
    const payload = buyerUpdatePayload(values, customer, fields);
    if (Object.keys(payload).length === 0) { onClose(); return; }
    setLoading(true);
    try {
      const res = await repApi.patch(`/customers/${customer.id}/buyer-data`, payload);
      const row = (res.data?.data ?? {}) as Record<string, string | null>;
      const saved: Partial<Record<BuyerField, string | null>> = {};
      for (const f of BUYER_BILLING_FIELDS) if (f in row) saved[f] = row[f];
      invalidateIncompleteBuyers();
      onSaved(saved);
    } catch (err: unknown) {
      const data = (err as { response?: { data?: { message?: string; fieldErrors?: { field: BuyerField; messageAr: string }[] } } })?.response?.data;
      if (data?.fieldErrors?.length) {
        const map: Partial<Record<BuyerField, string>> = {};
        for (const e of data.fieldErrors) if (!map[e.field]) map[e.field] = e.messageAr;
        setErrors(map);
      }
      setMsg(isNetworkError(err) ? tr('يلزم اتصال بالإنترنت لحفظ بيانات الفوترة') : (data?.message || tr('تعذر حفظ التعديل')));
      setLoading(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-gray-50">
      <div className="bg-[#1F1A13] text-white p-4 flex items-center gap-3">
        <button onClick={onClose} aria-label={tr('رجوع')}><ArrowRight size={20} /></button>
        <span className="font-bold flex-1 truncate">{tr('بيانات الفوترة الإلكترونية المشتري')}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <p className="text-sm font-bold text-gray-700 mb-3 truncate">{customer.name}</p>
        {!canEditCustomer && <p className="text-[11px] text-gray-500 mb-3 leading-relaxed">{tr('تكمل الحقول الفارغة فقط والمحفوظ واسم المنشأة والرقم الضريبي والسجل التجاري تعدلها الإدارة')}</p>}
        <BuyerDataFields include="all" title={false} values={{ ...values, name: customer.name ?? '', channel: customer.channel ?? '' }}
          stored={customer} errors={errors} locked={locked} onChange={(f, v) => setValues(s => ({ ...s, [f]: v }))} />
        {msg && <p className="text-red-500 text-xs text-center mt-3">{msg}</p>}
      </div>
      <div className="p-4 border-t bg-white">
        <button onClick={submit} disabled={loading} className="w-full bg-[#E15A30] text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
          {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Check size={16} />}
          {tr('حفظ بيانات الفوترة')}
        </button>
      </div>
    </div>
  );
}
