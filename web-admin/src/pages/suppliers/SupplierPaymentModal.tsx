import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { suppliersApi, supplierPaymentsApi, type OpenBill, type Supplier, type SupplierPaymentView } from '../../api/suppliers';
import { useTr } from '../../i18n/strings';
import { backdropClose } from '../../lib/backdropClose';
import { localDay } from '../../lib/paymentMethods';
import { entryAttempt, type EntryAttempt } from '../../lib/warehouseEntry';
import { formatCurrency, formatDayOnly } from '../../utils/format';
import { useRepsLite } from '../../components/purchases/purchaseTypes';
import {
  amountInputText, draftPlan, emptyPaymentDraft, fromMilli, isPaymentView, manualAllocationMilli, paymentIdOf, PAYMENT_METHOD_LABELS, PAYMENT_NOTE_MAX, PAYMENT_PROBLEM_TEXT,
  PAYMENT_REFERENCE_MAX, paymentBody, paymentProblem, referenceLabel, serverCodeOf, SUPPLIER_PAYMENT_METHODS, supplierErrorText,
  type AllocationMode, type PaymentDraft,
} from './supplierLogic';
import { SUPPLIER_KEYS } from './SupplierFormModal';

const MODES: { mode: AllocationMode; label: string; hint: string }[] = [
  { mode: 'AUTO', label: 'تلقائي على الأقدم استحقاقا', hint: 'يسدد الفواتير المفتوحة من الأقدم استحقاقا والزائد يبقى دفعة مقدمة' },
  { mode: 'MANUAL', label: 'يدوي', hint: 'اكتب ما يسدد من كل فاتورة والباقي يبقى دفعة مقدمة' },
  { mode: 'NONE', label: 'دفعة مقدمة بلا تخصيص', hint: 'لا يسدد فاتورة بعينها ويبقى رصيدا مدينا للمورد' },
];

/**
 * «سند صرف جديد» للمورّد: المبلغ والطريقة (نقدي/تحويل/شيك/عهدة مندوب) والتاريخ والمرجع، وتخصيصٌ تلقائي (الأقدم استحقاقاً،
 * يحسبه الخادم تحت القفل) أو يدويّ لكل فاتورة (≤ متبقّيها، وΣ ≤ المبلغ) أو بلا تخصيص (دفعة مقدّمة). المعاينة بالملّي تطابق
 * خوارزمية الخادم. مرجع المحاولة (clientRef) ثابتٌ ما ثبت الجسم: إعادة الإرسال بعد انقطاعٍ تعيد السند نفسه لا سنداً ثانياً.
 * `bill`: فُتحت من «سداد» على فاتورةٍ بعينها ⇒ يدويٌّ بمتبقّيها كاملاً.
 */
export default function SupplierPaymentModal({ supplier, bill, decimals, onClose, onSaved }: {
  supplier: Pick<Supplier, 'id' | 'name' | 'balance'>; bill?: OpenBill | null; decimals: number;
  onClose: () => void; onSaved: (saved: { payment: SupplierPaymentView | null; id: string | null }) => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const [d, setD] = useState<PaymentDraft>(() => {
    const base = emptyPaymentDraft(localDay(), bill ? 'MANUAL' : 'AUTO');
    if (!bill) return base;
    const amt = amountInputText(bill.outstanding, decimals);
    return { ...base, amount: amt, manual: { [bill.warehouseEntryId]: amt } };
  });
  const [touched, setTouched] = useState(false);
  const [attempt, setAttempt] = useState<EntryAttempt>(null);
  const patch = (p: Partial<PaymentDraft>) => setD(x => ({ ...x, ...p }));

  const billsQ = useQuery({
    queryKey: ['supplier-open-bills', supplier.id],
    queryFn: async () => (await suppliersApi.openBills(supplier.id)).data.data as OpenBill[],
  });
  const bills = useMemo(() => billsQ.data ?? [], [billsQ.data]);
  const repsQ = useRepsLite(d.method === 'REP_CUSTODY');

  const plan = draftPlan(d, bills, decimals);
  const problem = paymentProblem(d, bills, decimals);
  const manualCheck = d.mode === 'MANUAL' ? manualAllocationMilli(d, bills, decimals) : null;
  const badBill = manualCheck && !manualCheck.ok ? manualCheck.warehouseEntryId : null;
  const autoLines = new Map(plan.lines.map(l => [l.warehouseEntryId, l.milli]));
  const totalOutstanding = bills.reduce((s, b) => s + Math.round(b.outstanding * 1000), 0);

  const save = useMutation({
    mutationFn: async () => {
      const body = paymentBody(d, supplier.id, bills, decimals);
      // المرجع يتبع الجسم: نفسه ⇒ المرجع نفسه (إعادة آمنة)، تغيّر ⇒ مرجعٌ جديد
      const next = entryAttempt(attempt, body);
      setAttempt(next);
      const res = await supplierPaymentsApi.create({ ...body, clientRef: next.ref });
      return (res.data as { data?: unknown } | undefined)?.data ?? null;
    },
    onSuccess: (p) => {
      SUPPLIER_KEYS.forEach(k => qc.invalidateQueries({ queryKey: [k] }));
      // المدفوع والمتبقّي على صفوف سجلّ المستودع
      qc.invalidateQueries({ queryKey: ['warehouse-entries'] });
      toast.success(tr('تم حفظ سند الصرف'));
      // السند الكامل يُطبع فوراً، والردّ الأنحف يُجلب بمعرّفه
      onSaved({ payment: isPaymentView(p) ? p : null, id: paymentIdOf(p) });
    },
    onError: (e: unknown) => {
      toast.error(tr(supplierErrorText(e, 'تعذر حفظ سند الصرف')));
      // الفواتير تغيّرت منذ فُتحت النافذة (سدادٌ آخر أو مرتجع) ⇒ تُقرأ من جديد
      if (serverCodeOf(e) === 'ALLOCATION_EXCEEDS_OUTSTANDING' || serverCodeOf(e) === 'SUPPLIER_PAYMENT_INVALID') billsQ.refetch();
    },
  });

  // اليدوي لا يُرسل قبل أن تُقرأ الفواتير: تخصيصٌ مكتوب لفاتورةٍ لم تصل القائمة بعد يُهمل فيصير السند كله دفعة مقدّمة بصمت
  const billsReady = d.mode !== 'MANUAL' || billsQ.isSuccess;
  const submit = () => {
    setTouched(true);
    if (problem || save.isPending || !billsReady) return;
    save.mutate();
  };

  const fillAll = () => {
    // يدويٌّ يملأ كل فاتورةٍ بمتبقّيها والمبلغ بمجموعها
    const manual: Record<string, string> = {};
    for (const b of bills) manual[b.warehouseEntryId] = amountInputText(b.outstanding, decimals);
    patch({ mode: 'MANUAL', manual, amount: amountInputText(fromMilli(totalOutstanding), decimals) });
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[94vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-[#F1EBDF]">
          <div>
            <h2 className="text-lg font-bold text-[#1F1A13]">{tr('سند صرف جديد')}</h2>
            <p className="text-xs text-[#6E6557] mt-0.5">
              {supplier.name} · {tr('الرصيد المستحق')}: <b className="tabular-nums">{formatCurrency(supplier.balance)}</b>
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#F6F1E7] text-[#6E6557]" aria-label={tr('إغلاق')}><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">{tr('المبلغ')} <span className="text-red-500">*</span></label>
              <input className="input w-full text-lg font-bold tabular-nums" inputMode="decimal" dir="ltr" value={d.amount}
                onChange={e => patch({ amount: e.target.value })} placeholder={amountInputText(0, decimals)} autoFocus={!bill} />
            </div>
            <div>
              <label className="label">{tr('تاريخ الدفع')} <span className="text-red-500">*</span></label>
              <input type="date" className="input w-full" value={d.paidAt} onChange={e => patch({ paidAt: e.target.value })} />
            </div>
            <div>
              <label className="label">{tr('طريقة الدفع')}</label>
              <select className="input w-full" value={d.method} onChange={e => patch({ method: e.target.value as PaymentDraft['method'] })}>
                {SUPPLIER_PAYMENT_METHODS.map(m => <option key={m} value={m}>{tr(PAYMENT_METHOD_LABELS[m])}</option>)}
              </select>
            </div>
            {d.method === 'REP_CUSTODY' ? (
              <div>
                <label className="label">{tr('المندوب')} <span className="text-red-500">*</span></label>
                <select className="input w-full" value={d.salesRepId} onChange={e => patch({ salesRepId: e.target.value })}>
                  <option value="">{repsQ.isLoading ? tr('جاري التحميل') : tr('اختر المندوب')}</option>
                  {(repsQ.data ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
            ) : (
              <div>
                <label className="label">{tr(referenceLabel(d.method))}</label>
                <input className="input w-full" value={d.reference} maxLength={PAYMENT_REFERENCE_MAX} onChange={e => patch({ reference: e.target.value })} dir="auto" />
              </div>
            )}
            {d.method === 'REP_CUSTODY' && (
              <div>
                <label className="label">{tr('المرجع')}</label>
                <input className="input w-full" value={d.reference} maxLength={PAYMENT_REFERENCE_MAX} onChange={e => patch({ reference: e.target.value })} dir="auto" />
              </div>
            )}
            <div className={d.method === 'REP_CUSTODY' ? '' : 'sm:col-span-2'}>
              <label className="label">{tr('البيان')}</label>
              <input className="input w-full" value={d.note} maxLength={PAYMENT_NOTE_MAX} onChange={e => patch({ note: e.target.value })} placeholder={tr('مثال سداد فواتير شهر أكتوبر')} />
            </div>
          </div>

          {/* التخصيص */}
          <section>
            <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
              <h3 className="text-sm font-bold text-[#1F1A13]">{tr('تخصيص السند على الفواتير')}</h3>
              {bills.length > 0 && (
                <button type="button" className="text-xs font-semibold text-[#C94E28] hover:underline" onClick={fillAll}>
                  {tr('سداد كل الفواتير المفتوحة')} ({formatCurrency(fromMilli(totalOutstanding))})
                </button>
              )}
            </div>
            <div className="flex gap-2 flex-wrap" role="radiogroup">
              {MODES.map(m => (
                <button key={m.mode} type="button" role="radio" aria-checked={d.mode === m.mode} onClick={() => patch({ mode: m.mode })}
                  className={`rounded-xl border-2 px-3 py-1.5 text-xs font-semibold transition-colors ${d.mode === m.mode ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white text-[#44403a] hover:border-[#D8CDB9]'}`}>
                  {tr(m.label)}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-[#9A8F7E] mt-1.5">{tr(MODES.find(m => m.mode === d.mode)?.hint ?? '')}</p>

            {d.mode !== 'NONE' && (
              billsQ.isLoading ? (
                <div className="h-20 flex items-center justify-center text-gray-400 text-sm">{tr('جاري التحميل')}</div>
              ) : billsQ.isError ? (
                <div className="flex items-center gap-3 py-4 text-sm text-gray-500">
                  {tr('تعذر تحميل الفواتير المفتوحة')}
                  <button type="button" className="btn-secondary" onClick={() => billsQ.refetch()}>{tr('إعادة المحاولة')}</button>
                </div>
              ) : bills.length === 0 ? (
                <p className="mt-3 rounded-lg bg-[#FAF7F0] border border-[#F1EBDF] px-3 py-2 text-[12px] text-[#6E6557]">
                  {tr('لا فواتير آجلة مفتوحة لهذا المورد والسند كله دفعة مقدمة')}
                </p>
              ) : (
                <div className="table-wrapper mt-3">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{tr('فاتورة المورد')}</th>
                        <th>{tr('تاريخ الاستحقاق')}</th>
                        <th>{tr('المتبقي')}</th>
                        <th>{d.mode === 'MANUAL' ? tr('المبلغ المسدد') : tr('يسدد منها')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bills.map(b => (
                        <tr key={b.warehouseEntryId} className={badBill === b.warehouseEntryId ? 'bg-red-50/60' : undefined}>
                          <td>
                            <div className="font-medium text-[#1F1A13]">{b.supplierRef ? <bdi>{b.supplierRef}</bdi> : <span className="text-[#9A8F7E]">{tr('بلا رقم فاتورة')}</span>}</div>
                            <div className="text-[11px] text-[#9A8F7E]">{formatDayOnly(b.billDate)}</div>
                          </td>
                          <td>
                            {formatDayOnly(b.dueDate)}
                            {b.daysOverdue > 0 && <span className="block text-[11px] font-semibold text-red-600">{tr('متأخرة')} {b.daysOverdue} {tr('يوم')}</span>}
                          </td>
                          <td className="tabular-nums font-semibold">{formatCurrency(b.outstanding)}</td>
                          <td>
                            {d.mode === 'MANUAL' ? (
                              <div className="flex items-center gap-1.5">
                                <input className="input w-32 tabular-nums" inputMode="decimal" dir="ltr" value={d.manual[b.warehouseEntryId] ?? ''}
                                  onChange={e => patch({ manual: { ...d.manual, [b.warehouseEntryId]: e.target.value } })} placeholder="0" />
                                <button type="button" className="text-[11px] font-semibold text-[#C94E28] hover:underline whitespace-nowrap"
                                  onClick={() => patch({ manual: { ...d.manual, [b.warehouseEntryId]: amountInputText(b.outstanding, decimals) } })}>
                                  {tr('كامل')}
                                </button>
                              </div>
                            ) : (
                              <span className={`tabular-nums ${autoLines.get(b.warehouseEntryId) ? 'font-semibold text-green-700' : 'text-gray-300'}`}>
                                {formatCurrency(fromMilli(autoLines.get(b.warehouseEntryId) ?? 0))}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </section>

          {/* الملخّص */}
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl bg-[#FAF7F0] border border-[#F1EBDF] p-3 text-center">
              <p className="text-[11px] text-[#6E6557]">{tr('مبلغ السند')}</p>
              <p className="font-bold tabular-nums text-[#1F1A13]">{formatCurrency(fromMilli(plan.allocatedMilli + plan.unappliedMilli))}</p>
            </div>
            <div className="rounded-xl bg-green-50 border border-green-100 p-3 text-center">
              <p className="text-[11px] text-[#6E6557]">{tr('مخصص للفواتير')}</p>
              <p className="font-bold tabular-nums text-green-700">{formatCurrency(fromMilli(plan.allocatedMilli))}</p>
            </div>
            <div className="rounded-xl bg-amber-50 border border-amber-100 p-3 text-center">
              <p className="text-[11px] text-[#6E6557]">{tr('دفعة مقدمة')}</p>
              <p className="font-bold tabular-nums text-amber-700">{formatCurrency(fromMilli(plan.unappliedMilli))}</p>
            </div>
          </div>
          {d.mode === 'AUTO' && bills.length > 0 && (
            <p className="text-[11px] text-[#9A8F7E]">{tr('المعاينة من الفواتير كما هي الآن ويعيد الخادم الحساب عند الحفظ')}</p>
          )}

          {touched && problem && (
            <p className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-700">{tr(PAYMENT_PROBLEM_TEXT[problem])}</p>
          )}
        </div>

        <div className="flex gap-3 px-6 py-4 border-t border-[#F1EBDF]">
          <button className="btn-primary" onClick={submit} disabled={save.isPending || !billsReady}>
            {save.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Banknote size={16} />}
            {tr('حفظ سند الصرف')}
          </button>
          <button onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}
