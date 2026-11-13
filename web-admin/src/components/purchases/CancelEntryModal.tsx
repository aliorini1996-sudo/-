import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban } from 'lucide-react';
import toast from 'react-hot-toast';
import { warehouseApi } from '../../api/client';
import { useTr } from '../../i18n/strings';
import { backdropClose } from '../../lib/backdropClose';
import { formatCurrency, formatDate } from '../../utils/format';
import { purchaseErrorText, serverCodeOf } from './purchaseCalc';
import { PURCHASE_INVALIDATE_KEYS, type PurchaseEntry } from './purchaseTypes';

/**
 * «إلغاء الحركة» («ربط الدفاتر» L1) بتأكيدٍ صريح: مرتجعٌ كامل لما بقي من الوارد وحالته «ملغاة» — لا حذف. النقدي يُلغى سند صرفه
 * الآلي، والآجل الذي عليه دفعات سارية يُمنع (409 BILL_HAS_PAYMENTS: تُلغى السندات أولاً)، وغير المصنَّف حركة RETURN بلا قيود مورّد.
 * الخادم هو الحَكَم؛ والمنع هنا للآجل المسدَّد جزئياً يقول السبب قبل الإرسال.
 */
export default function CancelEntryModal({ entry, onClose }: { entry: PurchaseEntry; onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [sure, setSure] = useState(false);
  const mode = entry.paymentMode === 'CASH' || entry.paymentMode === 'CREDIT' ? entry.paymentMode : null;
  const paidOnCredit = mode === 'CREDIT' && (entry.paid ?? 0) > 1e-9;

  const save = useMutation({
    mutationFn: () => warehouseApi.cancelEntry(entry.id, reason.slice(0, 300)),
    onSuccess: () => {
      PURCHASE_INVALIDATE_KEYS.forEach(k => qc.invalidateQueries({ queryKey: [k] }));
      toast.success(tr('ألغيت الحركة'));
      onClose();
    },
    onError: (e: unknown) => {
      toast.error(tr(purchaseErrorText(e) ?? 'تعذر إلغاء الحركة'));
      if (serverCodeOf(e) === 'BILL_HAS_PAYMENTS') qc.invalidateQueries({ queryKey: ['warehouse-entries'] });
    },
  });

  const effects = [
    tr('تسجل حركة مرتجع بكل ما بقي من بضاعة الوارد فتخرج كمياتها من رصيد المستودع'),
    mode === 'CASH' ? tr('يلغى سند الصرف الآلي للمورد وتعود قيمته إلى مصدر الدفع') : null,
    mode === 'CREDIT' ? tr('يعكس المستحق للمورد عن هذه الفاتورة') : null,
    tr('تبقى الحركة في السجل موسومة ملغاة ولا يمكن التراجع عن الإلغاء'),
  ].filter((x): x is string => !!x);

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="p-6">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-3 bg-[#FBE3DF]">
            <AlertTriangle size={28} className="text-[#C0392B]" />
          </div>
          <h2 className="text-lg font-bold text-[#1F1A13] text-center">{tr('إلغاء الحركة')}</h2>
          <p className="text-xs text-[#6E6557] text-center mt-1">
            {[entry.vendor?.name ?? entry.supplier, entry.supplierRef, formatDate(entry.createdAt)].filter(Boolean).join(' · ')}
            {typeof entry.total === 'number' && mode && <> · <b className="text-[#1F1A13]">{formatCurrency(entry.total)}</b></>}
          </p>
          <ul className="mt-4 space-y-1.5 text-[12px] text-[#6E6557] list-disc ps-5">
            {effects.map(t => <li key={t}>{t}</li>)}
          </ul>
          {paidOnCredit ? (
            <p className="mt-4 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-700">
              {tr('على هذه الفاتورة دفعات سارية ألغ سندات الصرف المخصصة لها أولا')} ({tr('المدفوع')} {formatCurrency(entry.paid ?? 0)})
            </p>
          ) : (
            <>
              <div className="mt-4">
                <label className="label">{tr('سبب الإلغاء اختياري')}</label>
                <input className="input" maxLength={300} value={reason} onChange={e => setReason(e.target.value)} placeholder={tr('مثال فاتورة مكررة')} />
              </div>
              <label className="mt-3 flex items-start gap-2 text-[12px] text-[#1F1A13] cursor-pointer">
                <input type="checkbox" checked={sure} onChange={e => setSure(e.target.checked)} className="accent-[#C0392B] mt-0.5" />
                {tr('أؤكد إلغاء الحركة وإرجاع كل ما بقي من بضاعتها')}
              </label>
            </>
          )}
        </div>
        <div className="flex gap-3 p-5 pt-0">
          <button onClick={() => save.mutate()} disabled={!sure || paidOnCredit || save.isPending}
            className="flex-1 justify-center py-2.5 rounded-xl text-white font-semibold flex items-center gap-2 transition-colors bg-[#C0392B] hover:bg-[#a8311f] disabled:opacity-60">
            {save.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Ban size={16} />}
            {tr('إلغاء الحركة')}
          </button>
          <button onClick={onClose} className="btn-secondary">{tr('رجوع')}</button>
        </div>
      </div>
    </div>
  );
}
