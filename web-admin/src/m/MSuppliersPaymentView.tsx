import { useState, lazy, Suspense } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Share2, XCircle, Loader2, Info } from 'lucide-react';
import toast from 'react-hot-toast';
import { supplierPaymentsApi, type SupplierPaymentView } from '../api/suppliers';
import { formatCurrency, formatDateTime, formatDayOnly, getActiveCurrency } from '../utils/format';
import { currencyDecimals } from '../i18n/countries';
import { useTr } from '../i18n/strings';
import { useBackClose } from '../lib/useBackClose';
import { useAuthStore } from '../store/authStore';
import { MCard, MHeader, MError, MSpinner } from './mobileUi';
import { expectObject } from './shape';
import { canCancelPayment, payMethodLabel, paymentUnapplied, supplierErrorMessage } from './MSuppliersLogic';
import { SUPPLIER_PAYMENT_INVALIDATE } from './MSuppliersPayForm';

/* الورقة في حزمة مستقلّة — تجرّ jspdf وhtml2canvas معها */
const MSuppliersDocs = lazy(() => import('./MSuppliersDocs'));

/**
 * سند صرف مورّد — تفاصيله وتخصيصه، ومشاركته ورقةً، وإلغاؤه.
 *
 * الإلغاء لا يمحو: يُكتب قيدٌ عكسيّ (PAYMENT_REV) فيعود المبلغ مستحقّاً للمورّد، ويبقى السند في الكشف موسوماً ملغى بسببه.
 * والسند الآلي لشراءٍ نقديّ لا يُلغى من هنا (يُلغى بإلغاء حركة الاستلام) — فلا زرّ له، بل سطرٌ يقول أين يُلغى.
 */
export default function MSuppliersPaymentView({ paymentId, company, onClose }: {
  paymentId: string;
  company?: unknown;
  onClose: () => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const user = useAuthStore(s => s.user);
  const decimals = currencyDecimals(getActiveCurrency());
  const [doc, setDoc] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState('');
  useBackClose(doc, () => setDoc(false));
  useBackClose(confirm, () => setConfirm(false));

  const q = useQuery({
    queryKey: ['m-suppliers', 'payment', paymentId],
    queryFn: async () => expectObject<SupplierPaymentView>((await supplierPaymentsApi.get(paymentId)).data?.data, 'سند الصرف'),
  });

  const cancel = useMutation({
    mutationFn: async () => { await supplierPaymentsApi.cancel(paymentId, reason); },
    onSuccess: () => {
      for (const key of SUPPLIER_PAYMENT_INVALIDATE) void qc.invalidateQueries({ queryKey: [...key] });
      toast.success(tr('ألغي سند الصرف'));
      setConfirm(false);
      setReason('');
    },
    onError: (e: unknown) => toast.error(tr(supplierErrorMessage(e, 'تعذر إلغاء السند'))),
  });

  if (q.isLoading) return <MSpinner />;
  if (q.isError || !q.data) return <MError onRetry={() => q.refetch()} text={tr('تعذر فتح سند الصرف')} />;
  const p = q.data;

  if (doc) {
    return (
      <Suspense fallback={<MSpinner />}>
        <MSuppliersDocs doc={{ kind: 'payment', payment: p }} company={company} issuer={user?.name || tr('الإدارة')} onClose={() => setDoc(false)} />
      </Suspense>
    );
  }

  const cancelled = p.status === 'CANCELLED';
  const unapplied = paymentUnapplied(p, decimals);
  const cancellable = canCancelPayment(p);

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0] relative">
      <MHeader title={`${tr('سند صرف')} ${p.displayNumber}`} subtitle={p.supplierName} onBack={onClose}
        action={
          <button onClick={() => setDoc(true)} className="p-2 text-[#9A8F7E] hover:text-white"
            aria-label={tr('مشاركة / طباعة')} title={tr('مشاركة / طباعة')}>
            <Share2 size={18} />
          </button>
        } />

      <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-3">
        <div className={`rounded-2xl border p-4 text-center ${cancelled ? 'border-[#F5C6C0] bg-[#FDF2F0]' : 'border-[#F1EBDF] bg-white'}`}>
          <p className="text-[11px] text-[#9A8F7E] mb-1">{tr('المبلغ')}</p>
          <p className={`text-2xl font-extrabold tabular-nums ${cancelled ? 'text-[#C0392B] line-through' : 'text-[#1F1A13]'}`} dir="ltr">{formatCurrency(p.amount)}</p>
          {cancelled && <p className="text-xs font-bold text-[#C0392B] mt-1">{tr('ملغى')}</p>}
        </div>

        <MCard>
          <Line label={tr('رقم السند')} value={p.displayNumber} ltr />
          <Line label={tr('المورد')} value={p.supplierName} />
          <Line label={tr('تاريخ السند')} value={formatDayOnly(p.paidAt)} />
          <Line label={tr('طريقة الدفع')} value={tr(payMethodLabel(p.method))} />
          {p.method === 'REP_CUSTODY' && <Line label={tr('المندوب')} value={p.salesRepName || '—'} />}
          {p.reference && <Line label={tr('المرجع')} value={p.reference} ltr />}
          {p.note && <Line label={tr('ملاحظات')} value={p.note} />}
          {p.createdBy && <Line label={tr('سجله')} value={p.createdBy} />}
          <Line label={tr('تاريخ التسجيل')} value={formatDateTime(p.createdAt)} />
          {cancelled && p.cancelledAt && <Line label={tr('تاريخ الإلغاء')} value={formatDateTime(p.cancelledAt)} />}
          {cancelled && p.cancelReason && <Line label={tr('سبب الإلغاء')} value={p.cancelReason} />}
        </MCard>

        {/* التخصيص — وما بقي بلا فاتورة دفعةٌ مقدّمة باسمها */}
        <section className="space-y-2">
          <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1">{tr('التخصيص على الفواتير')}</h3>
          <MCard>
            {p.allocations.length === 0 && unapplied === 0 ? (
              <p className="text-center text-xs text-[#9A8F7E] py-5">{tr('لا تخصيص')}</p>
            ) : (
              <>
                {p.allocations.map(a => (
                  <div key={a.warehouseEntryId} className="flex items-center justify-between gap-2 px-3.5 py-2.5 border-b border-[#F1EBDF] last:border-0">
                    <span className="text-sm text-[#1F1A13] truncate" dir="auto">{a.supplierRef || tr('بلا رقم فاتورة')}</span>
                    <span className="text-sm font-bold tabular-nums text-[#1F1A13]" dir="ltr">{formatCurrency(a.amount)}</span>
                  </div>
                ))}
                {unapplied > 0 && (
                  <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
                    <span className="text-sm text-[#2B6CB0]">{tr('دفعة مقدمة غير مخصصة')}</span>
                    <span className="text-sm font-bold tabular-nums text-[#2B6CB0]" dir="ltr">{formatCurrency(unapplied)}</span>
                  </div>
                )}
              </>
            )}
          </MCard>
          {cancelled && p.allocations.length > 0 && (
            <p className="text-[11px] text-[#6E6557] px-1">{tr('بالإلغاء عادت هذه المبالغ متبقية على فواتيرها')}</p>
          )}
        </section>

        {p.autoForEntryId && p.status === 'POSTED' && (
          <p className="text-[11px] text-[#6E6557] bg-white border border-[#F1EBDF] rounded-xl px-3 py-2 leading-relaxed flex gap-2">
            <Info size={14} className="flex-shrink-0 mt-0.5 text-[#9A8F7E]" />
            <span>{tr('سند آلي لشراء نقدي يلغى بإلغاء حركة الاستلام من مخزون الشركة')}</span>
          </p>
        )}
        <div className="h-2" />
      </div>

      {cancellable && (
        <div className="flex-shrink-0 border-t border-[#E9E1D3] bg-white p-3"
          style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
          <button type="button" onClick={() => setConfirm(true)}
            className="w-full border border-[#F5C6C0] text-[#C0392B] bg-[#FDF2F0] font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2">
            <XCircle size={17} /> {tr('إلغاء السند')}
          </button>
        </div>
      )}

      {/* تأكيد الإلغاء — ورقةٌ سفليّة فوق الشاشة لا حوار متصفّح: السبب يُكتب فيها ويُحفظ مع السند */}
      {confirm && (
        <div className="absolute inset-0 z-30 bg-black/40 flex items-end" onClick={() => !cancel.isPending && setConfirm(false)}>
          <div className="w-full bg-white rounded-t-3xl p-4 space-y-3" onClick={e => e.stopPropagation()}
            style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
            <p className="text-sm font-bold text-[#1F1A13]">{tr('إلغاء سند الصرف')} {p.displayNumber}</p>
            <p className="text-xs text-[#6E6557] leading-relaxed">
              {tr('يعود مبلغ السند مستحقا للمورد وتعود تخصيصاته متبقية على فواتيرها ويبقى السند في الكشف موسوما ملغى ولا يمكن التراجع عن الإلغاء')}
            </p>
            <div>
              <label className="label">{tr('سبب الإلغاء اختياري')}</label>
              <input className="input" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setConfirm(false)} disabled={cancel.isPending}
                className="bg-gray-100 text-gray-700 font-semibold py-3 rounded-xl min-h-[48px]">{tr('تراجع')}</button>
              <button type="button" onClick={() => cancel.mutate()} disabled={cancel.isPending}
                className="bg-[#C0392B] text-white font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2 disabled:opacity-60">
                {cancel.isPending && <Loader2 size={16} className="animate-spin" />} {tr('تأكيد الإلغاء')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Line({ label, value, ltr = false }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5 min-h-[44px] border-b border-[#F1EBDF] last:border-0">
      <span className="text-[11px] text-[#9A8F7E] w-24 flex-shrink-0">{label}</span>
      <span className="text-sm flex-1 text-[#1F1A13] break-words" dir={ltr ? 'ltr' : 'auto'}>{value}</span>
    </div>
  );
}
