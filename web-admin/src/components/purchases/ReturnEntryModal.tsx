import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Landmark, Undo2, Wallet, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { warehouseApi } from '../../api/client';
import { useTr } from '../../i18n/strings';
import { backdropClose } from '../../lib/backdropClose';
import { fmtTotalQty } from '../../lib/qtyView';
import { roundQty } from '../../lib/units';
import { formatCurrency } from '../../utils/format';
import { PurchaseSummary } from './PurchaseDisplay';
import {
  mergeEntries, paidFromOf, purchaseErrorText, remainingByItem, returnBody, returnPreview, returnProblem, RETURN_PROBLEM_TEXT, SUPPLIER_REF_MAX,
} from './purchaseCalc';
import { activeDecimals, PURCHASE_INVALIDATE_KEYS, todayDay, useVendorReturns, type PurchaseEntry } from './purchaseTypes';

/**
 * «مرتجع للمورد» لوارد مصنَّف («ربط الدفاتر» L1): كميةٌ لكل سطر ≤ المتبقّي منه، بتكلفة السطر الأصلي ونسبة ضريبته (الخادم يكتب
 * حركة RETURN بكميات سالبة واللوط نفسه، وقيد RETURN بإجمالي المرتجع). «خصم من المستحق» يُنقص ما ندين به للمورّد، و«استرداد
 * نقدي» المورّد ردّ المال إلى الصندوق أو البنك. الملخّص = حساب الخادم (returnPreview): السعر المُدخل للسطر الأصلي، والمتبقّي من
 * الفاتورة بعد المرتجعات السابقة — ولها تُجلب مرتجعات المورّد (السجلّ المعروض قد يكون مفلتراً بنوعٍ يخفيها).
 */
export default function ReturnEntryModal({ entry, all, taxOff, onClose }: {
  entry: PurchaseEntry;
  /** صفوف السجلّ — منها المرتجعات السابقة لهذا الوارد (المتبقّي) */
  all: readonly PurchaseEntry[];
  taxOff: boolean;
  onClose: () => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const vendorReturnsQ = useVendorReturns(entry.vendorId);
  // السجلّ المعروض + مرتجعات المورّد بلا تكرار: منها المتبقّي من كل سطر ومن الفاتورة
  const pool = useMemo(() => mergeEntries(all, vendorReturnsQ.data), [all, vendorReturnsQ.data]);
  const remaining = useMemo(() => remainingByItem(entry, pool), [entry, pool]);
  const lines = entry.items.filter(i => i.qty > 0);
  const [qtys, setQtys] = useState<Map<string, string>>(() => new Map(lines.map(i => [i.id, ''])));
  const setQty = (id: string, v: string) => setQtys(m => new Map(m).set(id, v));
  // النقدي يُسترد افتراضاً إلى مصدر دفعه (البنك للبنك، وإلا الصندوق)، والآجل يُخصم من المستحق
  const pf = paidFromOf(entry.paidAccountRef);
  const [refundMode, setRefundMode] = useState<'CREDIT' | 'CASH'>(entry.paymentMode === 'CASH' ? 'CASH' : 'CREDIT');
  const [refundTo, setRefundTo] = useState<'MAIN_CASH' | 'BANK'>(pf?.kind === 'BANK' ? 'BANK' : 'MAIN_CASH');
  const [supplierRef, setSupplierRef] = useState('');
  const [billDate, setBillDate] = useState(todayDay());
  const [note, setNote] = useState('');

  // الحساب بمعاملة ضريبة الوارد كما يفعل الخادم (ولو أُطفئت الضريبة بعده)؛ و«إزالة الضريبة» تُخفي سطري الصافي والضريبة وحدهما
  const preview = returnPreview(entry, pool, qtys, activeDecimals());
  const problem = returnProblem(qtys, remaining, { supplierRef, billDate });

  const save = useMutation({
    mutationFn: () => warehouseApi.returnEntry(entry.id, returnBody({ qtys, note, supplierRef, billDate, refundMode, refundTo })),
    onSuccess: () => {
      PURCHASE_INVALIDATE_KEYS.forEach(k => qc.invalidateQueries({ queryKey: [k] }));
      toast.success(tr('تم تسجيل المرتجع للمورد'));
      onClose();
    },
    onError: (e: unknown) => {
      toast.error(tr(purchaseErrorText(e) ?? 'تعذر الحفظ'));
      // المتبقّي تغيّر (مرتجعٌ من مكانٍ آخر): السجلّ من جديد فتُحسب البقية
      qc.invalidateQueries({ queryKey: ['warehouse-entries'] });
    },
  });

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <h2 className="text-lg font-bold text-[#1F1A13] flex items-center gap-2"><Undo2 size={20} className="text-amber-600" /> {tr('مرتجع للمورد')}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500" aria-label={tr('إغلاق')}><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          <p className="text-xs text-[#6E6557]">
            {entry.vendor?.name && <b className="text-[#1F1A13]">{entry.vendor.name}</b>}
            {entry.supplierRef && <> · {tr('فاتورة المورد')} <span dir="ltr">{entry.supplierRef}</span></>}
          </p>

          <div className="border border-[#E9E1D3] rounded-xl overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-[#FAF7F0] text-[10px] font-semibold text-[#9A8F7E]">
              <span className="min-w-0 flex-1">{tr('الصنف')}</span>
              <span className="w-20 text-center">{tr('المتبقي')}</span>
              <span className="w-28 text-center">{tr('كمية المرتجع')}</span>
            </div>
            <div className="divide-y divide-[#F1EBDF]">
              {lines.map(i => {
                const u = i.unitName || i.product.unit;
                const rem = remaining.get(i.id) ?? 0;
                const v = qtys.get(i.id) ?? '';
                const q = Number(v);
                const over = v.trim() !== '' && (!Number.isFinite(q) || q < 0 || q > rem + 1e-9);
                return (
                  <div key={i.id} className="flex items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-[#1F1A13] truncate">{i.product.name}</p>
                      <p className="text-[11px] text-[#9A8F7E]">
                        {u}{i.lot?.lotNumber ? ` · ${i.lot.lotNumber}` : ''}
                        {typeof i.unitCost === 'number' && <> · {formatCurrency(i.unitCost, undefined, 4)}/{u}</>}
                      </p>
                    </div>
                    <span className={`w-20 text-center text-sm ${rem > 0 ? 'text-[#1F1A13]' : 'text-[#C9BFAE]'}`}>{fmtTotalQty(roundQty(rem))}</span>
                    <div className="w-28 flex items-center gap-1">
                      <input type="number" step="any" min="0" max={rem} inputMode="decimal" value={v} disabled={rem <= 0 || save.isPending}
                        onChange={e => setQty(i.id, e.target.value)} aria-label={`${tr('كمية المرتجع')} ${i.product.name}`}
                        className={`input w-16 py-1.5 text-center ${over ? 'border-red-400 bg-red-50/40' : ''}`} placeholder="0" />
                      {rem > 0 && (
                        <button type="button" onClick={() => setQty(i.id, String(roundQty(rem)))} className="text-[10px] font-semibold text-[#E15A30] whitespace-nowrap">{tr('الكل')}</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <label className="label">{tr('تسوية قيمة المرتجع')}</label>
            <div className="grid grid-cols-2 gap-2">
              {(['CREDIT', 'CASH'] as const).map(m => (
                <button key={m} type="button" aria-pressed={refundMode === m} onClick={() => setRefundMode(m)}
                  className={`py-2 rounded-xl border text-xs font-semibold ${refundMode === m ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] text-[#6E6557]'}`}>
                  {m === 'CREDIT' ? tr('خصم من المستحق للمورد') : tr('المورد رد المبلغ نقدا')}
                </button>
              ))}
            </div>
            {refundMode === 'CASH' && (
              <div className="grid grid-cols-2 gap-2 mt-2">
                {(['MAIN_CASH', 'BANK'] as const).map(t => (
                  <button key={t} type="button" aria-pressed={refundTo === t} onClick={() => setRefundTo(t)}
                    className={`py-1.5 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 ${refundTo === t ? 'border-[#1E7A52] bg-green-50 text-[#1E7A52]' : 'border-[#E9E1D3] text-[#6E6557]'}`}>
                    {t === 'BANK' ? <Landmark size={13} /> : <Wallet size={13} />} {t === 'BANK' ? tr('إلى البنك') : tr('إلى الصندوق الرئيسي')}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">{tr('رقم إشعار المورد')}</label>
              <input className="input" dir="ltr" maxLength={SUPPLIER_REF_MAX} value={supplierRef} onChange={e => setSupplierRef(e.target.value)} placeholder={tr('اختياري')} />
            </div>
            <div>
              <label className="label">{tr('تاريخ المرتجع')}</label>
              <input type="date" className="input" value={billDate} onChange={e => setBillDate(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">{tr('ملاحظة اختياري')}</label>
            <input className="input" maxLength={300} value={note} onChange={e => setNote(e.target.value)} placeholder={tr('مثال بضاعة تالفة')} />
          </div>

          {preview.lines > 0 && (
            <div className="rounded-xl bg-[#FAF7F0] border border-[#F1EBDF] px-3 py-2">
              <PurchaseSummary totals={preview.totals} taxOff={taxOff || entry.vatTreatment === 'NONE'} mode={null} title="إجمالي المرتجع" />
            </div>
          )}
          <p className="text-[11px] text-[#9A8F7E]">{tr('تخرج كميات المرتجع من رصيد المستودع')}</p>
          {problem && problem !== 'NOTHING' && <p className="text-[11px] text-red-600">{tr(RETURN_PROBLEM_TEXT[problem])}</p>}
        </div>
        <div className="flex gap-3 p-5 border-t border-[#E9E1D3]">
          <button onClick={() => save.mutate()} disabled={!!problem || save.isPending} className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
            {save.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Undo2 size={16} />}
            {tr('حفظ المرتجع')}
          </button>
          <button onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}
