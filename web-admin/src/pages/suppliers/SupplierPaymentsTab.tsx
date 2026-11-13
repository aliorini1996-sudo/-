import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, Banknote, ChevronLeft, ChevronRight, Lock, Printer } from 'lucide-react';
import toast from 'react-hot-toast';
import { supplierPaymentsApi, type Supplier, type SupplierPaymentView } from '../../api/suppliers';
import { useTr } from '../../i18n/strings';
import { backdropClose } from '../../lib/backdropClose';
import { formatCurrency, formatDayOnly } from '../../utils/format';
import { paymentActions, paymentMethodLabel, periodInverted, supplierErrorText, voucherSplit } from './supplierLogic';
import { SUPPLIER_KEYS } from './SupplierFormModal';
import { SupplierPaymentVoucherModal, type VoucherSupplier } from './SupplierPaymentVoucher';

const PAGE_SIZE = 50;
type StatusFilter = '' | 'POSTED' | 'CANCELLED';

/**
 * إلغاء سند صرف بسببٍ وتأكيدٍ صريح: قيدٌ عكسيّ (PAYMENT_REV) يعيد المبلغ مستحقاً للمورّد وتتحرّر الفواتير التي خصّصها السند،
 * والسند يبقى في السجلّ موسوماً «ملغى» — لا حذف. السند الآلي لشراءٍ نقدي لا يُلغى من هنا (409 AUTO_PAYMENT_CANCEL_VIA_ENTRY).
 */
function CancelPaymentDialog({ payment, onClose }: { payment: SupplierPaymentView; onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [sure, setSure] = useState(false);
  const save = useMutation({
    mutationFn: () => supplierPaymentsApi.cancel(payment.id, reason.slice(0, 300)),
    onSuccess: () => {
      SUPPLIER_KEYS.forEach(k => qc.invalidateQueries({ queryKey: [k] }));
      qc.invalidateQueries({ queryKey: ['supplier-payment', payment.id] });
      qc.invalidateQueries({ queryKey: ['warehouse-entries'] });
      toast.success(tr('ألغي سند الصرف'));
      onClose();
    },
    onError: (e: unknown) => toast.error(tr(supplierErrorText(e, 'تعذر إلغاء سند الصرف'))),
  });
  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="p-6">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-3 bg-[#FBE3DF]">
            <AlertTriangle size={28} className="text-[#C0392B]" />
          </div>
          <h2 className="text-lg font-bold text-[#1F1A13] text-center">{tr('إلغاء سند الصرف')}</h2>
          <p className="text-xs text-[#6E6557] text-center mt-1">
            <bdi dir="ltr">{payment.displayNumber}</bdi> · {formatDayOnly(payment.paidAt)} · <b className="text-[#1F1A13]">{formatCurrency(payment.amount)}</b>
          </p>
          <ul className="mt-4 space-y-1.5 text-[12px] text-[#6E6557] list-disc ps-5">
            <li>{tr('يسجل قيد عكسي في كشف المورد فيعود المبلغ مستحقا له')}</li>
            {payment.allocations.length > 0 && <li>{tr('تعود الفواتير التي سددها السند مفتوحة بمتبقيها')}</li>}
            <li>{tr('يبقى السند في السجل موسوما ملغى ولا يمكن التراجع عن الإلغاء')}</li>
          </ul>
          <div className="mt-4">
            <label className="label">{tr('سبب الإلغاء اختياري')}</label>
            <input className="input w-full" maxLength={300} value={reason} onChange={e => setReason(e.target.value)} placeholder={tr('مثال سند مكرر')} />
          </div>
          <label className="mt-3 flex items-start gap-2 text-[12px] text-[#1F1A13] cursor-pointer">
            <input type="checkbox" checked={sure} onChange={e => setSure(e.target.checked)} className="accent-[#C0392B] mt-0.5" />
            {tr('أؤكد إلغاء سند الصرف')}
          </label>
        </div>
        <div className="flex gap-3 p-5 pt-0">
          <button onClick={() => save.mutate()} disabled={!sure || save.isPending}
            className="flex-1 justify-center py-2.5 rounded-xl text-white font-semibold flex items-center gap-2 transition-colors bg-[#C0392B] hover:bg-[#a8311f] disabled:opacity-60">
            {save.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Ban size={16} />}
            {tr('إلغاء السند')}
          </button>
          <button onClick={onClose} className="btn-secondary">{tr('رجوع')}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * «سندات الصرف» للمورّد: القائمة بالحالة والفترة والترقيم، و«سند جديد»، والطباعة PDF، والإلغاء بسبب. السند الآلي لشراءٍ نقدي
 * موسومٌ ويُلغى بإلغاء حركة الشراء من «مخزون الشركة».
 */
export default function SupplierPaymentsTab({ supplier, canEdit, onNew }: {
  supplier: Supplier; canEdit: boolean; onNew: () => void;
}) {
  const tr = useTr();
  const [status, setStatus] = useState<StatusFilter>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const inverted = periodInverted(from, to);
  const listQ = useQuery({
    queryKey: ['supplier-payments', supplier.id, status, from, to, page],
    queryFn: async () => (await supplierPaymentsApi.list({
      supplierId: supplier.id, status: status || undefined, from: from || undefined, to: to || undefined, page, limit: PAGE_SIZE,
    })).data.data as { items: SupplierPaymentView[]; total: number },
    enabled: !inverted,
    placeholderData: keepPreviousData,
  });
  const items = listQ.data?.items ?? [];
  const total = listQ.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const [voucher, setVoucher] = useState<SupplierPaymentView | null>(null);
  const [cancelOf, setCancelOf] = useState<SupplierPaymentView | null>(null);
  const vs: VoucherSupplier = supplier;
  const resetPage = () => setPage(1);

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex gap-3 flex-wrap items-end">
          <div>
            <label className="label">{tr('الحالة')}</label>
            <select className="input w-36" value={status} onChange={e => { setStatus(e.target.value as StatusFilter); resetPage(); }}>
              <option value="">{tr('الكل')}</option>
              <option value="POSTED">{tr('سارية')}</option>
              <option value="CANCELLED">{tr('ملغاة')}</option>
            </select>
          </div>
          <div>
            <label className="label">{tr('من')}</label>
            <input type="date" className="input w-40" value={from} max={to || undefined} onChange={e => { setFrom(e.target.value); resetPage(); }} />
          </div>
          <div>
            <label className="label">{tr('إلى')}</label>
            <input type="date" className="input w-40" value={to} min={from || undefined} onChange={e => { setTo(e.target.value); resetPage(); }} />
          </div>
          {canEdit && (
            <button className="btn-primary ms-auto" onClick={onNew}><Banknote size={16} /> {tr('سند صرف جديد')}</button>
          )}
        </div>
        {inverted && <p className="text-xs text-red-600 mt-2">{tr('تاريخ البداية بعد تاريخ النهاية')}</p>}
      </div>

      {inverted ? null : listQ.isPending ? (
        <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل')}</div>
      ) : listQ.isError ? (
        <div className="card flex flex-col items-center gap-3 py-10 text-gray-500">
          <span>{tr('تعذر تحميل سندات الصرف')}</span>
          <button onClick={() => listQ.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
        </div>
      ) : (
        <div className="card p-0">
          {items.length === 0 ? (
            <div className="text-center text-gray-400 text-sm py-10">{tr('لا سندات صرف')}</div>
          ) : (
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th>{tr('رقم السند')}</th>
                    <th>{tr('تاريخ الدفع')}</th>
                    <th>{tr('طريقة الدفع')}</th>
                    <th>{tr('المبلغ')}</th>
                    <th>{tr('مخصص للفواتير')}</th>
                    <th>{tr('دفعة مقدمة')}</th>
                    <th>{tr('الحالة')}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(p => {
                    const split = voucherSplit(p);
                    const act = paymentActions(p, canEdit);
                    const cancelled = p.status === 'CANCELLED';
                    return (
                      <tr key={p.id} className={cancelled ? 'opacity-60' : undefined}>
                        <td className="font-semibold">
                          <button type="button" className="text-[#C94E28] hover:underline" onClick={() => setVoucher(p)}><bdi dir="ltr">{p.displayNumber}</bdi></button>
                          {p.autoForEntryId && <span className="block text-[10px] font-normal text-[#9A8F7E]">{tr('آلي لشراء نقدي')}</span>}
                        </td>
                        <td className="whitespace-nowrap">{formatDayOnly(p.paidAt)}</td>
                        <td>
                          {tr(paymentMethodLabel(p.method))}
                          {p.method === 'REP_CUSTODY' && p.salesRepName && <span className="block text-[11px] text-[#9A8F7E]">{p.salesRepName}</span>}
                          {p.reference && <span className="block text-[11px] text-[#9A8F7E]"><bdi>{p.reference}</bdi></span>}
                        </td>
                        <td className={`tabular-nums font-bold ${cancelled ? 'line-through' : ''}`}>{formatCurrency(p.amount)}</td>
                        <td className="tabular-nums text-green-700">
                          {split.allocated ? formatCurrency(split.allocated) : '—'}
                          {p.allocations.length > 0 && (
                            <span className="block text-[10px] text-[#9A8F7E] max-w-[180px] truncate" title={p.allocations.map(a => a.supplierRef ?? '—').join('، ')}>
                              {p.allocations.map(a => a.supplierRef ?? '—').join('، ')}
                            </span>
                          )}
                        </td>
                        <td className="tabular-nums text-amber-700">{split.unapplied ? formatCurrency(split.unapplied) : '—'}</td>
                        <td>
                          {cancelled
                            ? <span className="badge badge-cancelled" title={p.cancelReason ?? undefined}>{tr('ملغى')}</span>
                            : <span className="badge badge-confirmed">{tr('ساري')}</span>}
                        </td>
                        <td>
                          <div className="flex items-center gap-1 justify-end">
                            <button type="button" title={tr('طباعة السند')} className="p-1.5 rounded-lg hover:bg-[#F6F1E7] text-[#6E6557]" onClick={() => setVoucher(p)}>
                              <Printer size={15} />
                            </button>
                            {act.cancel && (
                              <button type="button" title={tr('إلغاء السند')} className="p-1.5 rounded-lg hover:bg-red-50 text-[#C0392B]" onClick={() => setCancelOf(p)}>
                                <Ban size={15} />
                              </button>
                            )}
                            {act.autoLocked && canEdit && (
                              <span title={tr('هذا سند آلي لشراء نقدي ويلغى بإلغاء حركة الشراء من مخزون الشركة')} className="p-1.5 text-[#9A8F7E]">
                                <Lock size={14} />
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {pages > 1 && (
            <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-[#F1EBDF] text-sm text-[#6E6557]">
              <span className="tabular-nums">{tr('صفحة')} {page} / {pages} · {total} {tr('سند')}</span>
              <div className="flex gap-2">
                <button className="btn-secondary !px-2.5 !py-1.5" disabled={page <= 1} onClick={() => setPage(p => p - 1)} aria-label={tr('السابق')}><ChevronRight size={16} /></button>
                <button className="btn-secondary !px-2.5 !py-1.5" disabled={page >= pages} onClick={() => setPage(p => p + 1)} aria-label={tr('التالي')}><ChevronLeft size={16} /></button>
              </div>
            </div>
          )}
        </div>
      )}

      {voucher && <SupplierPaymentVoucherModal payment={voucher} supplier={vs} onClose={() => setVoucher(null)} />}
      {cancelOf && <CancelPaymentDialog payment={cancelOf} onClose={() => setCancelOf(null)} />}
    </div>
  );
}
