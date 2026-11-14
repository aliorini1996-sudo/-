import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Info, Plus, Search, X, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { useDir } from '../../../i18n/lang';
import { formatDayOnly } from '../../../utils/format';
import { LedgerAmount } from '../../../components/ledger/LedgerAmount';
import { LedgerLoadingToast } from '../../../components/ledger/LedgerListView';
import { Badge } from '../../../components/ledger/SyncBadges';
import { todayLocal } from '../../../components/ledger/DateRangePicker';
import { ledgerConfigApi, ledgerErrorOf, ledgerKeys } from '../../../api/ledgerConfig';
import {
  CUSTOMER_ADJUSTMENT_KINDS, REFUND_METHODS, WRITEOFF_COUNTERS, ledgerOpsApi, ledgerOpsKeys,
  type CustomerAdjustmentKind, type CustomerAdjustmentListParams, type CustomerAdjustmentView, type PartnerSearchItem,
  type RefundMethod, type WriteoffCounter,
} from '../../../api/ledgerOps';
import {
  customerAdjustmentKindLabels, customerAdjustmentReasonLabels, customerAdjustmentStatusLabels, writeoffCounterLabels,
} from '../../../lib/ledger/labels';
import {
  adjustmentDraftCheck, adjustmentRequestBody, autoAllocationPreview, milliWire, numberMilli, opsErrorMessage, parseOpsAmount,
  type AdjustmentDraftInput,
} from '../../../lib/ledger/sync';
import { defaultMethodLabel } from '../../../lib/paymentMethodsConfig';
import { ConfigModal, WriteButton, useLedgerCan } from '../config/parts/configUi';
import { ledgerHref } from '../routes';

/**
 * «العملاء ← تسويات ذمم العملاء» (M4، L4 من «ربط الدفاتر»، العقد §4.8، E4.13–E4.15).
 *
 * - شطب دين معدوم: Dr ديون معدومة 711005 (أو مخصص الديون المشكوك فيها 113009) / Cr ذمم العملاء — مخصَّصاً على فواتير آجلة
 *   مفتوحة يدوياً (Σ = المبلغ، وكلٌّ ≤ متبقّيه) أو تلقائياً بالأقدم فالأقدم، فينقص متبقّيها وتُطابَق سطور ذمتها (CA:<alloc>).
 * - ردّ رصيد دائن: Dr ذمم العملاء / Cr حساب الطريقة (نقد أو بنك) بحدّ الرصيد الدائن — يُطابَق FIFO مع الأرصدة الدائنة.
 * - الإلغاء بسببٍ إلزامي يعكس القيد ويعيد المتبقّي (مرآة بتاريخ الإلغاء).
 * المستند وقيده وحدثه في معاملة واحدة على الخادم؛ والدفاتر غير المربوطة 409 LEDGER_BOOKS_NOT_LINKED (إشعار لا خطأ).
 * التحقق في الواجهة مرآة الخادم (adjustmentDraftCheck) بالملّي — والخادم يحسم تحت القفل.
 */

const PAGE_SIZE = 50;

export default function CustomerAdjustmentsPage() {
  const tr = useTr();
  const dir = useDir();
  const qc = useQueryClient();
  const canPost = useLedgerCan('canPostJournals');
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [customer, setCustomer] = useState<PartnerSearchItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState<CustomerAdjustmentView | null>(null);

  const statusQ = useQuery({ queryKey: ledgerKeys.status, queryFn: async () => (await ledgerConfigApi.status()).data.data, staleTime: 60_000 });
  const decimals = statusQ.data?.currencyDecimals ?? 2;
  const params = useMemo<CustomerAdjustmentListParams>(
    () => ({ kind, status, from, to, customerId: customer?.id, page, limit: PAGE_SIZE }),
    [kind, status, from, to, customer, page],
  );
  const q = useQuery({
    queryKey: ledgerOpsKeys.adjustments(params),
    queryFn: async () => (await ledgerOpsApi.adjustments.list(params)).data.data,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const notLinked = ledgerErrorOf(q.error)?.code === 'LEDGER_BOOKS_NOT_LINKED';
  const reasonLabels = customerAdjustmentReasonLabels(tr);
  const kindLabels = customerAdjustmentKindLabels(tr);
  const statusLabels = customerAdjustmentStatusLabels(tr) as Record<string, string>;
  const pages = Math.max(1, Math.ceil((q.data?.total ?? 0) / PAGE_SIZE));
  const Prev = dir === 'rtl' ? ChevronRight : ChevronLeft;
  const Next = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const resetPage = () => setPage(1);

  const counterText = (a: CustomerAdjustmentView): string =>
    a.kind === 'CREDIT_REFUND' ? `${defaultMethodLabel(a.method ?? 'CASH', tr)} · ${a.counterAccountCode}` : a.counterAccountCode;

  return (
    <div className="space-y-3">
      <LedgerLoadingToast show={q.isFetching} />
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold text-[#1F1A13]">{tr('تسويات ذمم العملاء')}</h1>
        {!notLinked && (
          <WriteButton allowed={canPost} className="btn-primary ms-auto inline-flex items-center gap-1.5" onClick={() => setCreating(true)}>
            <Plus size={14} />{tr('تسوية جديدة')}
          </WriteButton>
        )}
      </div>
      <p className="text-xs text-[#6E6557] flex items-start gap-1">
        <Info size={13} className="shrink-0 mt-0.5" />
        {tr('شطب دين معدوم على فواتير آجلة مفتوحة، أو ردّ رصيد دائن للعميل نقداً أو تحويلاً. كل تسوية تكتب حركة كشف الحساب وقيدها معاً، وإلغاؤها يعكسهما بتاريخ الإلغاء')}
      </p>

      {notLinked ? (
        <p className="rounded-xl border border-[#E8E0D2] bg-[#FBF7F0] px-3 py-2 text-sm text-[#1F1A13]" role="status">
          {tr('تسويات ذمم العملاء متاحة حين تكون الدفاتر مربوطة بالنظام')}
        </p>
      ) : (
        <>
          <div className="card flex flex-wrap items-end gap-3">
            <div className="w-64">
              <span className="label text-xs">{tr('العميل')}</span>
              <CustomerPicker value={customer} onChange={c => { setCustomer(c); resetPage(); }} />
            </div>
            <label className="block">
              <span className="label text-xs">{tr('النوع')}</span>
              <select className="input w-44" value={kind} onChange={e => { setKind(e.target.value); resetPage(); }}>
                <option value="">{tr('الكل')}</option>
                {CUSTOMER_ADJUSTMENT_KINDS.map(k => <option key={k} value={k}>{kindLabels[k]}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="label text-xs">{tr('الحالة')}</span>
              <select className="input w-32" value={status} onChange={e => { setStatus(e.target.value); resetPage(); }}>
                <option value="">{tr('الكل')}</option>
                <option value="ACTIVE">{statusLabels.ACTIVE}</option>
                <option value="CANCELLED">{statusLabels.CANCELLED}</option>
              </select>
            </label>
            <label className="block">
              <span className="label text-xs">{tr('من تاريخ')}</span>
              <input type="date" dir="ltr" className="input w-40" value={from} onChange={e => { setFrom(e.target.value); resetPage(); }} />
            </label>
            <label className="block">
              <span className="label text-xs">{tr('إلى تاريخ')}</span>
              <input type="date" dir="ltr" className="input w-40" value={to} onChange={e => { setTo(e.target.value); resetPage(); }} />
            </label>
            {(kind || status || from || to || customer) && (
              <button type="button" className="btn-secondary" onClick={() => { setKind(''); setStatus(''); setFrom(''); setTo(''); setCustomer(null); resetPage(); }}>{tr('مسح الفلاتر')}</button>
            )}
          </div>

          {q.isError && <p className="text-sm text-[#C0392B]">{opsErrorMessage(tr, ledgerErrorOf(q.error), reasonLabels)}</p>}

          <div className="card !p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-[#9A8F7E]">
                <tr className="border-b border-[#F1EBDF]">
                  <th className="text-start px-2 py-2">{tr('التاريخ')}</th>
                  <th className="text-start px-2 py-2">{tr('النوع')}</th>
                  <th className="text-start px-2 py-2">{tr('العميل')}</th>
                  <th className="text-end px-2 py-2">{tr('المبلغ')}</th>
                  <th className="text-start px-2 py-2">{tr('الحساب المقابل')}</th>
                  <th className="text-start px-2 py-2">{tr('الفواتير')}</th>
                  <th className="text-start px-2 py-2">{tr('القيد')}</th>
                  <th className="text-start px-2 py-2">{tr('الحالة')}</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {q.isLoading && <tr><td colSpan={9} className="text-center py-8 text-[#9A8F7E]">{tr('جاري التحميل...')}</td></tr>}
                {q.data && q.data.items.length === 0 && <tr><td colSpan={9} className="text-center py-8 text-[#6E6557]">{tr('لا تسويات')}</td></tr>}
                {q.data?.items.map(a => (
                  <tr key={a.id} className={`border-b border-[#F1EBDF] align-top ${a.status === 'CANCELLED' ? 'text-[#9A8F7E]' : ''}`}>
                    <td className="px-2 py-2 whitespace-nowrap">{formatDayOnly(a.docDate)}</td>
                    <td className="px-2 py-2">{kindLabels[a.kind] ?? a.kind}</td>
                    <td className="px-2 py-2">{a.customerName ?? a.customerId.slice(0, 8)}</td>
                    <td className="text-end px-2 py-2 font-semibold"><LedgerAmount value={a.amount} decimals={decimals} colored={false} /></td>
                    <td className="px-2 py-2"><bdi className="tabular-nums text-xs">{counterText(a)}</bdi></td>
                    <td className="px-2 py-2 text-xs">
                      {a.allocations.length === 0 ? '—' : a.allocations.map(x => (
                        <span key={x.invoiceId} className="block whitespace-nowrap"><bdi>{x.invoiceNumber ?? x.invoiceId.slice(0, 8)}</bdi> · <LedgerAmount value={x.amount} decimals={decimals} colored={false} /></span>
                      ))}
                    </td>
                    <td className="px-2 py-2 text-xs whitespace-nowrap">
                      {a.moveId && <Link to={ledgerHref(`entries/${a.moveId}`)} className="text-[#E15A30] hover:underline"><bdi>{a.moveNumber ?? a.moveId.slice(0, 8)}</bdi></Link>}
                      {a.reverseMoveId && <> · <Link to={ledgerHref(`entries/${a.reverseMoveId}`)} className="text-[#E15A30] hover:underline">↩ <bdi>{a.reverseMoveNumber ?? ''}</bdi></Link></>}
                    </td>
                    <td className="px-2 py-2">
                      <Badge tone={a.status === 'CANCELLED' ? 'gray' : 'green'} title={a.cancelReason ?? undefined}>{statusLabels[a.status] ?? a.status}</Badge>
                      {a.cancelReason && <span className="block text-[11px] max-w-[12rem] truncate" title={a.cancelReason}>{a.cancelReason}</span>}
                    </td>
                    <td className="px-2 py-2">
                      {a.status === 'ACTIVE' && (
                        <WriteButton allowed={canPost} className="p-1.5 hover:bg-red-50 rounded text-red-500" onClick={() => setCancelling(a)}>
                          <XCircle size={14} aria-label={tr('إلغاء التسوية')} />
                        </WriteButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {q.data && pages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-[#F1EBDF] text-sm text-[#6E6557]">
                <span>{tr('إجمالي')}: <bdi className="tabular-nums">{q.data.total}</bdi></span>
                <div className="flex items-center gap-1">
                  <button type="button" className="p-1.5 rounded hover:bg-[#F1EBDF] disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(p => p - 1)} aria-label={tr('السابق')}><Prev size={16} /></button>
                  <span className="px-2 tabular-nums">{page} / {pages}</span>
                  <button type="button" className="p-1.5 rounded hover:bg-[#F1EBDF] disabled:opacity-40" disabled={page >= pages} onClick={() => setPage(p => p + 1)} aria-label={tr('التالي')}><Next size={16} /></button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {creating && (
        <CreateAdjustmentDialog
          decimals={decimals}
          today={todayLocal(statusQ.data?.timezone || 'Asia/Riyadh')}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); qc.invalidateQueries({ queryKey: ['ledger', 'customer-adjustments'] }); }}
        />
      )}
      {cancelling && (
        <CancelAdjustmentDialog
          adjustment={cancelling}
          decimals={decimals}
          onClose={() => setCancelling(null)}
          onDone={() => { setCancelling(null); qc.invalidateQueries({ queryKey: ['ledger', 'customer-adjustments'] }); }}
        />
      )}
    </div>
  );
}

/** منتقي العميل بالبحث (GET /ledger/partners/search?type=customer) — بصلاحية عرض الدفاتر وحدها */
function CustomerPicker({ value, onChange, disabled }: { value: PartnerSearchItem | null; onChange: (c: PartnerSearchItem | null) => void; disabled?: boolean }) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setTimeout(() => setTerm(text.trim()), 250); return () => clearTimeout(t); }, [text]);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const q = useQuery({
    queryKey: ledgerOpsKeys.customerSearch(term),
    queryFn: async () => (await ledgerOpsApi.partners.customers(term)).data.data.items,
    enabled: open,
    staleTime: 30_000,
  });
  if (value) {
    return (
      <div className="input flex items-center gap-2">
        <span className="truncate flex-1">{value.name}</span>
        {!disabled && <button type="button" className="p-0.5 rounded hover:bg-[#F1EBDF]" aria-label={tr('مسح')} onClick={() => onChange(null)}><X size={13} /></button>}
      </div>
    );
  }
  return (
    <div ref={ref} className="relative">
      <Search size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" />
      <input className="input ps-8" placeholder={tr('ابحث بالاسم أو الجوال')} value={text} disabled={disabled}
        onFocus={() => setOpen(true)} onChange={e => { setText(e.target.value); setOpen(true); }} />
      {open && (
        <div className="absolute z-40 mt-1 inset-x-0 bg-white rounded-xl shadow-xl border border-[#E8E0D2] max-h-64 overflow-y-auto">
          {q.isLoading && <p className="text-center text-[#9A8F7E] text-sm py-3">{tr('جاري التحميل...')}</p>}
          {q.data && q.data.length === 0 && <p className="text-center text-[#9A8F7E] text-sm py-3">{tr('لا توجد نتائج')}</p>}
          {q.data?.map(c => (
            <button key={c.id} type="button" className="w-full text-start px-3 py-1.5 text-sm hover:bg-[#FBEBE2]"
              onClick={() => { onChange(c); setOpen(false); setText(''); }}>
              <span className="block truncate">{c.name}</span>
              {c.hint && <bdi dir="ltr" className="block text-[11px] text-[#9A8F7E]">{c.hint}</bdi>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateAdjustmentDialog({ decimals, today, onClose, onCreated }: { decimals: number; today: string; onClose: () => void; onCreated: () => void }) {
  const tr = useTr();
  const [customer, setCustomer] = useState<PartnerSearchItem | null>(null);
  const [kind, setKind] = useState<CustomerAdjustmentKind>('BAD_DEBT_WRITEOFF');
  const [amount, setAmount] = useState('');
  const [docDate, setDocDate] = useState(today);
  const [counter, setCounter] = useState<WriteoffCounter>('BAD_DEBT');
  const [method, setMethod] = useState<RefundMethod>('CASH');
  const [autoAllocate, setAutoAllocate] = useState(true);
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const reasonLabels = customerAdjustmentReasonLabels(tr);
  const kindLabels = customerAdjustmentKindLabels(tr);
  const counterLabels = writeoffCounterLabels(tr);

  const itemsQ = useQuery({
    queryKey: ledgerOpsKeys.adjustmentOpenItems(customer?.id ?? ''),
    queryFn: async () => (await ledgerOpsApi.adjustments.openItems(customer!.id)).data.data,
    enabled: !!customer,
    staleTime: 0,
  });
  const items = itemsQ.data;
  const dec = items?.currencyDecimals ?? decimals;
  useEffect(() => setAllocations({}), [customer?.id, kind]);

  const draft: AdjustmentDraftInput = { customerId: customer?.id ?? null, kind, amount, docDate, autoAllocate, allocations };
  const check = adjustmentDraftCheck(draft, {
    decimals: dec, today, linkedFrom: items?.linkedFrom ?? null, invoices: items?.invoices ?? [],
    debitBalance: items?.debitBalance ?? 0, creditBalance: items?.creditBalance ?? 0,
  });
  const ready = !!items && check.problems.length === 0;
  const writeoff = kind === 'BAD_DEBT_WRITEOFF';
  const autoByInvoice = new Map(check.allocations.map(a => [a.invoiceId, a.amountMilli]));

  const create = useMutation({
    mutationFn: async () => {
      const body = adjustmentRequestBody(draft, check, { counter, method, reference, note });
      if (!body) throw new Error('INVALID_DRAFT');
      return (await ledgerOpsApi.adjustments.create(body)).data.data;
    },
    onSuccess: a => { toast.success(`${tr('رُحّلت التسوية')} ${a.moveNumber ?? ''}`.trim()); onCreated(); },
    onError: e => toast.error(opsErrorMessage(tr, ledgerErrorOf(e), reasonLabels)),
  });

  /** توزيع المبلغ على الفواتير بالأقدم فالأقدم (يملأ الخانات اليدوية للمراجعة) */
  const fillFifo = () => {
    const p = parseOpsAmount(amount, dec, { required: true });
    if (!p.ok || !items) return;
    const auto = autoAllocationPreview(items.invoices, p.milli);
    setAllocations(Object.fromEntries(auto.allocations.map(a => [a.invoiceId, milliWire(a.amountMilli)])));
  };

  const problemsText = check.problems.filter(p => !p.invoiceId).map(p => reasonLabels[p.reason] ?? p.reason);
  const invoiceProblem = (id: string) => check.problems.filter(p => p.invoiceId === id).map(p => reasonLabels[p.reason] ?? p.reason).join(' · ');
  const amountText = check.amountMilli !== null ? milliWire(check.amountMilli) : '0';
  const debitLabel = writeoff ? counterLabels[counter] : tr('ذمم العملاء');
  const creditLabel = writeoff ? tr('ذمم العملاء') : `${tr('حساب طريقة الدفع')}: ${defaultMethodLabel(method, tr)}`;

  return (
    <ConfigModal wide title={tr('تسوية ذمة عميل')} onClose={onClose} footer={(
      <>
        <button type="button" className="btn-secondary" onClick={onClose}>{tr('إلغاء')}</button>
        <button type="button" className="btn-primary disabled:opacity-50" disabled={!ready || create.isPending}
          onClick={() => { setSubmitted(true); if (ready) create.mutate(); }}>
          {create.isPending && <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
          {tr('ترحيل التسوية')}
        </button>
      </>
    )}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <span className="label">{tr('العميل')}</span>
          <CustomerPicker value={customer} onChange={setCustomer} />
        </div>
        <div>
          <span className="label">{tr('نوع التسوية')}</span>
          <div className="flex gap-1" role="radiogroup">
            {CUSTOMER_ADJUSTMENT_KINDS.map(k => (
              <button key={k} type="button" role="radio" aria-checked={kind === k}
                className={`flex-1 px-2 py-2 rounded-xl text-sm border ${kind === k ? 'border-[#E15A30] bg-[#FBEBE2] text-[#1F1A13] font-semibold' : 'border-[#E8E0D2] text-[#6E6557]'}`}
                onClick={() => setKind(k)}>{kindLabels[k]}</button>
            ))}
          </div>
        </div>
      </div>

      {customer && itemsQ.isLoading && <p className="text-xs text-[#9A8F7E]">{tr('جاري التحميل...')}</p>}
      {itemsQ.isError && <p className="text-xs text-[#C0392B]">{opsErrorMessage(tr, ledgerErrorOf(itemsQ.error), reasonLabels)}</p>}
      {items && (
        <div className="grid gap-2 sm:grid-cols-3 text-xs rounded-xl bg-[#FBF7F0] px-3 py-2">
          <div><p className="text-[#9A8F7E]">{tr('الرصيد المدين')}</p><p className="font-semibold"><LedgerAmount value={items.debitBalance} decimals={dec} /></p></div>
          <div><p className="text-[#9A8F7E]">{tr('الرصيد الدائن')}</p><p className="font-semibold"><LedgerAmount value={items.creditBalance} decimals={dec} /></p></div>
          <div><p className="text-[#9A8F7E]">{tr('بداية الدفاتر المربوطة')}</p><p className="font-semibold">{items.linkedFrom ? formatDayOnly(items.linkedFrom) : '—'}</p></div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="label">{tr('المبلغ')}</span>
          <input dir="ltr" inputMode="decimal" className="input" value={amount} onChange={e => setAmount(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">{tr('تاريخ المستند')}</span>
          <input type="date" dir="ltr" className="input" max={today} min={items?.linkedFrom ?? undefined} value={docDate} onChange={e => setDocDate(e.target.value)} />
        </label>
        {writeoff ? (
          <label className="block">
            <span className="label">{tr('الحساب المقابل')}</span>
            <select className="input w-full" value={counter} onChange={e => setCounter(e.target.value as WriteoffCounter)}>
              {WRITEOFF_COUNTERS.map(c => <option key={c} value={c}>{counterLabels[c]}</option>)}
            </select>
          </label>
        ) : (
          <label className="block">
            <span className="label">{tr('طريقة الردّ')}</span>
            <select className="input w-full" value={method} onChange={e => setMethod(e.target.value as RefundMethod)}>
              {REFUND_METHODS.map(m => <option key={m} value={m}>{defaultMethodLabel(m, tr)}</option>)}
            </select>
          </label>
        )}
      </div>

      {writeoff && items && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="inline-flex items-center gap-1.5">
              <input type="radio" name="alloc-mode" checked={autoAllocate} onChange={() => setAutoAllocate(true)} />{tr('تخصيص تلقائي بالأقدم فالأقدم')}
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input type="radio" name="alloc-mode" checked={!autoAllocate} onChange={() => setAutoAllocate(false)} />{tr('تخصيص يدوي')}
            </label>
            {!autoAllocate && <button type="button" className="btn-secondary !py-1 !px-2 text-xs ms-auto" onClick={fillFifo}>{tr('توزيع المبلغ بالأقدم فالأقدم')}</button>}
          </div>
          {items.truncated && <p className="text-[11px] text-amber-900">{tr('تُعرض أقدم الفواتير المفتوحة وحدها')}</p>}
          <div className="overflow-x-auto max-h-72 overflow-y-auto rounded-xl border border-[#F1EBDF]">
            <table className="w-full text-xs">
              <thead className="text-[#9A8F7E] bg-[#FBF7F0] sticky top-0">
                <tr>
                  <th className="text-start px-2 py-1.5">{tr('الفاتورة')}</th>
                  <th className="text-start px-2 py-1.5">{tr('التاريخ')}</th>
                  <th className="text-start px-2 py-1.5">{tr('الاستحقاق')}</th>
                  <th className="text-end px-2 py-1.5">{tr('الإجمالي')}</th>
                  <th className="text-end px-2 py-1.5">{tr('المتبقّي')}</th>
                  <th className="text-end px-2 py-1.5">{tr('المشطوب')}</th>
                </tr>
              </thead>
              <tbody>
                {items.invoices.length === 0 && <tr><td colSpan={6} className="text-center py-4 text-[#6E6557]">{tr('لا فواتير آجلة مفتوحة لهذا العميل')}</td></tr>}
                {items.invoices.map(inv => {
                  const err = invoiceProblem(inv.invoiceId);
                  return (
                    <tr key={inv.invoiceId} className="border-t border-[#F1EBDF]">
                      <td className="px-2 py-1"><bdi>{inv.number}</bdi></td>
                      <td className="px-2 py-1 whitespace-nowrap">{formatDayOnly(inv.invoiceDate)}</td>
                      <td className="px-2 py-1 whitespace-nowrap">{inv.dueDate ? formatDayOnly(inv.dueDate) : '—'}</td>
                      <td className="text-end px-2"><LedgerAmount value={inv.total} decimals={dec} colored={false} /></td>
                      <td className="text-end px-2 font-semibold"><LedgerAmount value={inv.remaining} decimals={dec} colored={false} /></td>
                      <td className="text-end px-2 w-32">
                        {autoAllocate
                          ? <LedgerAmount value={milliWire(autoByInvoice.get(inv.invoiceId) ?? 0n)} decimals={dec} blankZero />
                          : (
                            <>
                              <input dir="ltr" inputMode="decimal" className={`input !py-1 text-xs text-end ${err ? '!border-[#C0392B]' : ''}`}
                                value={allocations[inv.invoiceId] ?? ''} aria-label={inv.number}
                                onChange={e => setAllocations(s => ({ ...s, [inv.invoiceId]: e.target.value }))} />
                              {err && <span className="block text-[10px] text-[#C0392B] text-start">{err}</span>}
                            </>
                          )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="font-semibold border-t border-[#E8E0D2]">
                <tr>
                  <td className="px-2 py-1.5" colSpan={4}>{tr('مجموع المخصَّص')}</td>
                  <td className="text-end px-2"><LedgerAmount value={milliWire(items.invoices.reduce((s, i) => s + numberMilli(i.remaining), 0n))} decimals={dec} colored={false} /></td>
                  <td className="text-end px-2"><LedgerAmount value={milliWire(check.allocatedMilli)} decimals={dec} colored={false} /></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label">{tr('المرجع')}</span>
          <input className="input" maxLength={100} value={reference} onChange={e => setReference(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">{tr('ملاحظة')}</span>
          <input className="input" maxLength={1000} value={note} onChange={e => setNote(e.target.value)} />
        </label>
      </div>

      {check.amountMilli !== null && (
        <div className="rounded-xl border border-[#E8E0D2] px-3 py-2 text-xs">
          <p className="font-semibold text-[#1F1A13] mb-1">{tr('معاينة القيد')}</p>
          <div className="flex justify-between gap-2"><span>{tr('مدين')}: {debitLabel}</span><LedgerAmount value={amountText} decimals={dec} /></div>
          <div className="flex justify-between gap-2"><span>{tr('دائن')}: {creditLabel}</span><LedgerAmount value={amountText} decimals={dec} /></div>
        </div>
      )}

      {(submitted || amount.trim() !== '') && problemsText.length > 0 && (
        <ul className="text-xs text-[#C0392B] list-disc ps-5 space-y-0.5">
          {problemsText.map(t => <li key={t}>{t}</li>)}
        </ul>
      )}
    </ConfigModal>
  );
}

function CancelAdjustmentDialog({ adjustment, decimals, onClose, onDone }: {
  adjustment: CustomerAdjustmentView; decimals: number; onClose: () => void; onDone: () => void;
}) {
  const tr = useTr();
  const [reason, setReason] = useState('');
  const kindLabels = customerAdjustmentKindLabels(tr);
  const cancel = useMutation({
    mutationFn: async () => (await ledgerOpsApi.adjustments.cancel(adjustment.id, reason.trim())).data.data,
    onSuccess: () => { toast.success(tr('أُلغيت التسوية وعُكس قيدها')); onDone(); },
    onError: e => toast.error(opsErrorMessage(tr, ledgerErrorOf(e), customerAdjustmentReasonLabels(tr))),
  });
  return (
    <ConfigModal title={tr('إلغاء التسوية')} onClose={onClose} footer={(
      <>
        <button type="button" className="btn-secondary" onClick={onClose}>{tr('تراجع')}</button>
        <button type="button" className="btn-danger disabled:opacity-50" disabled={!reason.trim() || cancel.isPending} onClick={() => cancel.mutate()}>
          {cancel.isPending && <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
          {tr('إلغاء التسوية')}
        </button>
      </>
    )}>
      <p className="text-sm text-[#1F1A13]">
        {kindLabels[adjustment.kind] ?? adjustment.kind} · {adjustment.customerName ?? ''} · <LedgerAmount value={adjustment.amount} decimals={decimals} colored={false} />
      </p>
      <p className="text-xs text-[#6E6557]">{tr('يُعكس القيد بتاريخ الإلغاء ويعود المتبقّي على الفواتير المشطوبة ورصيد العميل كما كانا')}</p>
      <label className="block">
        <span className="label">{tr('سبب الإلغاء')}</span>
        <textarea className="input min-h-[5rem]" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} />
      </label>
    </ConfigModal>
  );
}
