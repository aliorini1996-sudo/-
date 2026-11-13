import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, Landmark, FileText, Truck, Loader2, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import { warehouseApi } from '../api/client';
import { suppliersApi, supplierPaymentsApi, type OpenBill, type Supplier } from '../api/suppliers';
import { formatCurrency, formatDayOnly, formatNumber, getActiveCurrency } from '../utils/format';
import { currencyDecimals } from '../i18n/countries';
import { useTr } from '../i18n/strings';
import { entryAttempt, type EntryAttempt } from '../lib/warehouseEntry';
import { MHeader } from './mobileUi';
import { expectArray } from './shape';
import {
  DRAFT_PROBLEMS, PAY_METHODS, PAY_METHOD_LABELS, autoAllocation, balanceState, checkManualAllocation, paymentBody,
  paymentProblems, parseAmount, referenceLabel, supplierErrorCode, supplierErrorMessage, localDay,
  type AllocMode, type PayMethod, type PaymentDraft,
} from './MSuppliersLogic';

/** تخصيصٌ مسبق من «سداد» على فاتورةٍ بعينها: المبلغ متبقّيها، والتخصيص يدويّ عليها وحدها */
export interface PayPreset { billId: string; amount: number }

const METHOD_ICONS: Record<PayMethod, typeof Banknote> = { CASH: Banknote, BANK_TRANSFER: Landmark, CHEQUE: FileText, REP_CUSTODY: Truck };

interface RepPick { id: string; name: string; isActive?: boolean }

/** مفاتيح ما يتغيّر بسندٍ يُسجَّل أو يُلغى: أرصدة الموردين وكشوفهم وسنداتهم، ومدفوع/متبقّي فواتير الوارد في سجلّ المستودع */
export const SUPPLIER_PAYMENT_INVALIDATE = [['m-suppliers'], ['m-wh-entries'], ['suppliers'], ['supplier-payments'], ['warehouse-entries']] as const;

/**
 * سند صرفٍ جديد لمورّد من الجوال.
 *
 * ثلاثة قرارات تحرس المال هنا:
 *  · **لا طريقة افتراضية**: الطريقة تقرّر من أين خرج المال (الصندوق أو البنك أو عهدة مندوب)، واختيارٌ صامت لـ«نقدي» يُخرج
 *    من الصندوق مالاً دُفع بتحويل. فالإرسال ممنوع حتى يختار المستخدم.
 *  · **التخصيص التلقائي يُعاين قبل الإرسال** بترتيب الخادم نفسه (الأقدم استحقاقاً أولاً)، واليدويّ يُتحقّق منه بقاعدة الخادم
 *    (لكل فاتورة ≤ متبقّيها وΣ ≤ المبلغ) بالملّي الصحيح — والزائد دفعةٌ مقدّمة يُقال اسمها لا يُخفى.
 *  · **مفتاح المحاولة (clientRef)**: المحتوى نفسه ⇒ المفتاح نفسه، فضغطةٌ ثانية بعد ضياع الردّ تعيد السند المسجَّل لا سنداً ثانياً.
 */
export default function MSuppliersPayForm({ supplier, preset, onClose, onCreated }: {
  supplier: Supplier;
  preset?: PayPreset | null;
  onClose: () => void;
  onCreated: (paymentId: string) => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const decimals = currencyDecimals(getActiveCurrency());
  const [draft, setDraft] = useState<PaymentDraft>(() => ({
    supplierId: supplier.id,
    amountText: preset ? String(preset.amount) : '',
    method: '',
    salesRepId: '',
    paidAt: localDay(),
    reference: '',
    note: '',
    mode: preset ? 'manual' : 'auto',
    alloc: preset ? { [preset.billId]: String(preset.amount) } : {},
  }));
  const set = <K extends keyof PaymentDraft>(k: K, v: PaymentDraft[K]) => setDraft(d => ({ ...d, [k]: v }));
  const attempt = useRef<EntryAttempt>(null);

  const billsQ = useQuery({
    queryKey: ['m-suppliers', 'open-bills', supplier.id],
    queryFn: async () => expectArray<OpenBill>((await suppliersApi.openBills(supplier.id)).data?.data, 'الفواتير المفتوحة'),
  });
  // اليدويّ لا يُرسل على قائمةٍ قيد التحديث: ما يراه المستخدم هو ما يُتحقَّق منه
  const settledBills = billsQ.isSuccess && !billsQ.isFetching ? billsQ.data : null;
  const shownBills = billsQ.data ?? [];

  const repsQ = useQuery({
    // بحرّاس المستودع (GET /warehouse/reps) — صرّاف المورّد قد لا يملك إدارة المناديب؛ ومفتاح useRepsLite نفسه
    queryKey: ['warehouse-reps'],
    queryFn: async () => expectArray<RepPick>((await warehouseApi.reps()).data?.data, 'المناديب'),
    enabled: draft.method === 'REP_CUSTODY',
    staleTime: 300_000,
  });

  const amount = parseAmount(draft.amountText, decimals);
  const problems = paymentProblems(draft, settledBills, decimals);
  const auto = useMemo(() => autoAllocation(shownBills, amount ?? 0, decimals), [shownBills, amount, decimals]);
  const manual = useMemo(() => checkManualAllocation(shownBills, draft.alloc, amount, decimals), [shownBills, draft.alloc, amount, decimals]);
  const owed = balanceState(supplier.balance, decimals);

  const save = useMutation({
    mutationFn: async () => {
      const body = paymentBody(draft, settledBills, decimals);
      if (!body) throw new Error('invalid');
      const a = entryAttempt(attempt.current, body);
      attempt.current = a;
      const res = await supplierPaymentsApi.create({ ...body, clientRef: a.ref });
      const id = (res.data?.data as { id?: unknown } | undefined)?.id;
      if (typeof id !== 'string' || !id) throw new Error('shape');
      return id;
    },
    onSuccess: (id) => {
      for (const key of SUPPLIER_PAYMENT_INVALIDATE) void qc.invalidateQueries({ queryKey: [...key] });
      toast.success(tr('تم تسجيل سند الصرف'));
      onCreated(id);
    },
    onError: (e: unknown) => {
      // المتبقّي تغيّر من جهازٍ آخر بين الجلب والإرسال ⇒ القائمة تُحدَّث فيرى المستخدم ما تغيّر
      if (supplierErrorCode(e) === 'ALLOCATION_EXCEEDS_OUTSTANDING') void billsQ.refetch();
      toast.error(tr(supplierErrorMessage(e, 'تعذر تسجيل سند الصرف')));
    },
  });

  /* التحوّل إلى اليدويّ بلا خانةٍ مكتوبة يبدأ من معاينة التلقائي: المستخدم يعدّل توزيعاً قائماً لا يكتبه من الصفر،
   * وخاناتٌ فارغة كانت ستجعل السند كلّه دفعةً مقدّمة بصمت */
  const setMode = (m: AllocMode) => setDraft(d => {
    const empty = Object.values(d.alloc).every(v => String(v ?? '').trim() === '');
    if (m !== 'manual' || !empty || !auto.allocations.length) return { ...d, mode: m };
    return { ...d, mode: m, alloc: Object.fromEntries(auto.allocations.map(a => [a.warehouseEntryId, String(a.amount)])) };
  });
  const fillBill = (b: OpenBill) => setDraft(d => ({ ...d, alloc: { ...d.alloc, [b.warehouseEntryId]: String(b.outstanding) } }));
  const repLabel = (r: RepPick) => (r.isActive === false ? `${r.name} (${tr('موقوف')})` : r.name);
  // المشكلة الأولى تُقال تحت الزرّ بعد أن يُكتب المبلغ — نموذجٌ يفتح بخطأٍ أحمر قبل أيّ إدخال يبدو معطوباً
  const shownProblem = draft.amountText.trim() === '' ? undefined : problems[0];

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={tr('سند صرف جديد')} subtitle={supplier.name} onBack={onClose} />

      <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-3">
        <div>
          <label className="label">{tr('المبلغ')} *</label>
          <input type="number" step="any" min="0" dir="ltr" inputMode="decimal" className="input text-lg font-bold text-center"
            value={draft.amountText} onChange={e => set('amountText', e.target.value)} placeholder="0.00" />
          {/* المستحقّ للمورّد كاملاً بلمسة — أكثر ما يُدفع */}
          {owed.state === 'owed' && (
            <button type="button" onClick={() => set('amountText', String(owed.amount))}
              className="mt-1.5 text-[11px] font-semibold text-[#C94E28] px-1 min-h-[32px]">
              {tr('كامل المستحق')}: <span dir="ltr" className="tabular-nums">{formatCurrency(owed.amount)}</span>
            </button>
          )}
        </div>

        <div>
          <label className="label">{tr('طريقة الدفع')} *</label>
          <div className="grid grid-cols-4 gap-2">
            {PAY_METHODS.map(m => {
              const Icon = METHOD_ICONS[m];
              const on = draft.method === m;
              return (
                <button key={m} type="button" onClick={() => set('method', m)}
                  className={`flex flex-col items-center gap-1 py-2.5 px-1 rounded-xl border min-h-[60px] justify-center ${on ? 'bg-[#E9F6EF] border-[#2F855A] text-[#2F855A]' : 'bg-white border-[#E9E1D3] text-[#6E6557]'}`}>
                  <Icon size={17} />
                  <span className="text-[10px] font-semibold leading-tight text-center break-words max-w-full">{tr(PAY_METHOD_LABELS[m])}</span>
                </button>
              );
            })}
          </div>
        </div>

        {draft.method === 'REP_CUSTODY' && (
          <div>
            <label className="label">{tr('المندوب')} *</label>
            <select className="input" value={draft.salesRepId} onChange={e => set('salesRepId', e.target.value)}>
              <option value="">{repsQ.isLoading ? tr('جار التحميل') : tr('اختر المندوب الذي دفع من عهدته')}</option>
              {(repsQ.data ?? []).map(r => <option key={r.id} value={r.id}>{repLabel(r)}</option>)}
            </select>
            {repsQ.isError && (
              <p className="text-[11px] text-[#B4530A] mt-1.5 px-1 flex items-center justify-between gap-2">
                <span>{tr('تعذر تحميل المناديب')}</span>
                <button type="button" onClick={() => repsQ.refetch()} className="font-bold underline min-h-[32px]">{tr('إعادة المحاولة')}</button>
              </p>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">{tr('تاريخ السند')} *</label>
            <input type="date" className="input" dir="ltr" value={draft.paidAt} onChange={e => set('paidAt', e.target.value)} />
          </div>
          <div>
            <label className="label">{tr(referenceLabel(draft.method))}</label>
            <input className="input" dir="ltr" maxLength={120} value={draft.reference} onChange={e => set('reference', e.target.value)} />
          </div>
        </div>

        {/* ─────────── التخصيص على الفواتير المفتوحة ─────────── */}
        {billsQ.isLoading && (
          <p className="text-[11px] text-[#9A8F7E] bg-white border border-[#F1EBDF] rounded-xl px-3 py-2">{tr('جار تحميل الفواتير المفتوحة')}</p>
        )}
        {billsQ.isError && !billsQ.isFetching && (
          <div className="text-[11px] text-[#B4530A] bg-[#FDF3E7] border border-[#F5D9B0] rounded-xl px-3 py-2 flex items-center justify-between gap-2">
            <span>{tr('تعذر تحميل الفواتير المفتوحة')}</span>
            <button type="button" onClick={() => billsQ.refetch()} className="font-bold underline flex-shrink-0 min-h-[36px]">{tr('إعادة المحاولة')}</button>
          </div>
        )}
        {billsQ.isSuccess && shownBills.length === 0 && (
          <p className="text-[11px] text-[#6E6557] bg-white border border-[#F1EBDF] rounded-xl px-3 py-2 leading-relaxed">
            {tr('لا فواتير آجلة مفتوحة لهذا المورد يسجل السند دفعة مقدمة ورصيدا مدينا له')}
          </p>
        )}
        {shownBills.length > 0 && (
          <div className="space-y-2">
            <label className="label mb-0">{tr('التخصيص على الفواتير')}</label>
            <div className="grid grid-cols-2 gap-1 bg-[#F1EBDF] rounded-xl p-1">
              {(['auto', 'manual'] as AllocMode[]).map(m => (
                <button key={m} type="button" onClick={() => setMode(m)}
                  className={`text-[11px] font-semibold py-2 rounded-lg min-h-[36px] ${draft.mode === m ? 'bg-white text-[#1F1A13] shadow-sm' : 'text-[#6E6557]'}`}>
                  {m === 'auto' ? tr('تلقائي على الأقدم استحقاقا') : tr('يدوي')}
                </button>
              ))}
            </div>

            <div className="rounded-2xl border border-[#F1EBDF] bg-white divide-y divide-[#F1EBDF]">
              {shownBills.map(b => {
                const autoAmt = auto.allocations.find(a => a.warehouseEntryId === b.warehouseEntryId)?.amount ?? 0;
                const bad = manual.overBill.includes(b.warehouseEntryId) || manual.invalid.includes(b.warehouseEntryId);
                return (
                  <div key={b.warehouseEntryId} className="p-3 flex items-center gap-2">
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-[#1F1A13] truncate" dir="auto">{b.supplierRef || tr('بلا رقم فاتورة')}</span>
                      <span className="block text-[11px] text-[#9A8F7E]">
                        {tr('يستحق')} {formatDayOnly(b.dueDate)} · {tr('متبق')} <span dir="ltr" className="tabular-nums">{formatCurrency(b.outstanding)}</span>
                      </span>
                      {b.daysOverdue > 0 && (
                        <span className="block text-[10px] text-[#C0392B] font-semibold">{tr('أيام التأخير')}: {formatNumber(b.daysOverdue)}</span>
                      )}
                    </span>
                    {draft.mode === 'auto' ? (
                      <span className={`text-sm font-bold tabular-nums whitespace-nowrap ${autoAmt > 0 ? 'text-[#2F855A]' : 'text-[#C9BFB0]'}`} dir="ltr">
                        {autoAmt > 0 ? formatCurrency(autoAmt) : '—'}
                      </span>
                    ) : (
                      <span className="flex flex-col items-end gap-1 flex-shrink-0">
                        <input type="number" step="any" min="0" dir="ltr" inputMode="decimal"
                          className={`input w-28 text-center py-1.5 ${bad ? 'border-[#C0392B] text-[#C0392B]' : ''}`}
                          value={draft.alloc[b.warehouseEntryId] ?? ''} placeholder="0"
                          onChange={e => setDraft(d => ({ ...d, alloc: { ...d.alloc, [b.warehouseEntryId]: e.target.value } }))} />
                        <button type="button" onClick={() => fillBill(b)} className="text-[10px] font-semibold text-[#C94E28] min-h-[24px]">
                          {tr('كامل المتبقي')}
                        </button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* الحصيلة: المخصَّص والدفعة المقدّمة — والمبلغ الزائد يُسمّى باسمه لا يختفي */}
            {amount != null && (
              <div className="rounded-xl bg-white border border-[#F1EBDF] px-3 py-2 space-y-1 text-[11px]">
                <p className="flex justify-between gap-2">
                  <span className="text-[#6E6557]">{tr('المخصص للفواتير')}</span>
                  <b className={`tabular-nums ${draft.mode === 'manual' && manual.overAmount ? 'text-[#C0392B]' : 'text-[#1F1A13]'}`} dir="ltr">
                    {formatCurrency(draft.mode === 'auto' ? auto.allocated : manual.allocated)}
                  </b>
                </p>
                {(draft.mode === 'auto' ? auto.unapplied : manual.unapplied) > 0 && (
                  <p className="flex justify-between gap-2">
                    <span className="text-[#6E6557]">{tr('دفعة مقدمة غير مخصصة')}</span>
                    <b className="tabular-nums text-[#2B6CB0]" dir="ltr">{formatCurrency(draft.mode === 'auto' ? auto.unapplied : manual.unapplied)}</b>
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <div>
          <label className="label">{tr('ملاحظات')}</label>
          <input className="input" maxLength={500} value={draft.note} onChange={e => set('note', e.target.value)} />
        </div>
        <div className="h-2" />
      </div>

      <div className="flex-shrink-0 border-t border-[#E9E1D3] bg-white p-3 space-y-1.5"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
        {shownProblem && <p className="text-[11px] text-[#C0392B] font-semibold text-center">{tr(DRAFT_PROBLEMS[shownProblem])}</p>}
        <button type="button" onClick={() => save.mutate()} disabled={problems.length > 0 || save.isPending}
          className="w-full bg-[#2F855A] text-white font-bold py-3.5 rounded-xl min-h-[50px] flex items-center justify-center gap-2 disabled:opacity-60">
          {save.isPending ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
          {tr('تسجيل سند الصرف')} {amount != null && <span dir="ltr" className="tabular-nums">· {formatCurrency(amount)}</span>}
        </button>
      </div>
    </div>
  );
}
