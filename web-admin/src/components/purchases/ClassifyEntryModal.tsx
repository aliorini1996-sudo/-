import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Tags, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { productApi, warehouseApi } from '../../api/client';
import { suppliersApi, type Supplier } from '../../api/suppliers';
import { useTr } from '../../i18n/strings';
import { backdropClose } from '../../lib/backdropClose';
import { formatCurrency } from '../../utils/format';
import { fmtTotalQty } from '../../lib/qtyView';
import { roundQty } from '../../lib/units';
import { PurchaseFields } from './PurchaseFields';
import { LineTaxInput, PurchaseSummary } from './PurchaseDisplay';
import {
  classifyBody, classifyInclusiveLocked, classifyPreview, dayOf, dueDateOf, emptyPurchaseDraft, parsePositive, purchaseErrorText, purchaseProblem,
  serverCodeOf, PURCHASE_PROBLEM_TEXT, type ClassifyPriceDraft, type PurchaseDraft,
} from './purchaseCalc';
import { activeDecimals, PURCHASE_INVALIDATE_KEYS, useRepsLite, type PurchaseEntry } from './purchaseTypes';

/**
 * «تصنيف» وارد غير مصنَّف («ربط الدفاتر» L1): المورّد ونوع الشراء (نقدي بمصدر دفعه / آجل) ورقم فاتورة المورّد وتاريخها،
 * وأسعار الأسطر الناقصة وحدها — السعر القائم لا يتغيّر (الخادم يملأ غير المسعَّر فقط). الملخّص بتقريب الخادم، والخادم يكتب
 * عند الحفظ ما يكتبه الإنشاء المصنَّف (قيد الفاتورة، وسند الصرف الآلي للنقدي).
 */

interface ProductTax { id: string; taxPct: number }

/** يوم الاستلام بتوقيت المتصفّح — افتراض تاريخ الفاتورة لواردٍ لم يُسجَّل له تاريخ */
const receiptDay = (createdAt: string) => {
  const d = new Date(createdAt);
  return Number.isNaN(d.getTime()) ? new Date().toLocaleDateString('en-CA') : d.toLocaleDateString('en-CA');
};

export default function ClassifyEntryModal({ entry, taxOff, onClose }: { entry: PurchaseEntry; taxOff: boolean; onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [vendor, setVendor] = useState<Supplier | null>(null);
  // المورّد المحفوظ على الحركة (إن وُجد) كاملاً — لمدة سداده ورقمه الضريبي
  const vendorQ = useQuery({
    queryKey: ['suppliers', 'one', entry.vendorId ?? ''],
    queryFn: async () => ((await suppliersApi.get(entry.vendorId as string)).data as { data?: Supplier }).data ?? null,
    enabled: !!entry.vendorId,
    staleTime: 60_000,
  });
  useEffect(() => { if (vendorQ.data) setVendor(v => v ?? vendorQ.data ?? null); }, [vendorQ.data]);

  const [draft, setDraft] = useState<PurchaseDraft>(() => ({
    ...emptyPurchaseDraft(dayOf(entry.billDate) ?? receiptDay(entry.createdAt)),
    supplierRef: entry.supplierRef ?? '',
  }));
  // «شاملة الضريبة» افتراضها ما حُفظ على الحركة، ومقيَّدةٌ به حين في الوارد أسعارٌ مُدخلة (الخادم يرفض الخلط بين الطريقتين)
  const inclusiveLocked = classifyInclusiveLocked(entry.items);
  const [inclusiveDraft, setInclusive] = useState(() => !!entry.costsIncludeTax);
  const inclusive = inclusiveLocked ? !!entry.costsIncludeTax : inclusiveDraft;
  // ضريبة الصنف لأسطر الحركة — افتراض نسبة السطر الناقص (مفتاح قائمة الأصناف نفسه في نافذة الاستلام)
  const prodQ = useQuery({
    queryKey: ['products-min'],
    queryFn: async () => (await productApi.list({ limit: 1000 })).data.data as ProductTax[],
    staleTime: 60_000,
  });
  const productPct = (id?: string) => (prodQ.data ?? []).find(p => p.id === id)?.taxPct ?? 0;
  const lines = entry.items.filter(i => i.qty > 0);
  const unpriced = lines.filter(i => !(typeof i.unitCost === 'number' && i.unitCost > 0));
  const [prices, setPrices] = useState<Record<string, ClassifyPriceDraft>>({});
  // افتراض نسبة كل سطرٍ ناقص من صنفه حين تصل الأصناف — ما كتبه المستخدم لا يُمسّ
  useEffect(() => {
    if (!prodQ.data) return;
    setPrices(ps => {
      const next = { ...ps };
      for (const i of unpriced) if (!next[i.id]) next[i.id] = { itemId: i.id, unitCost: '', taxPct: String(productPct(i.productId)) };
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prodQ.data]);
  const priceOf = (id: string): ClassifyPriceDraft => prices[id] ?? { itemId: id, unitCost: '', taxPct: '' };
  const patchPrice = (id: string, p: Partial<ClassifyPriceDraft>) => setPrices(ps => ({ ...ps, [id]: { ...priceOf(id), ...p } }));

  const repsQ = useRepsLite(draft.mode === 'CASH' && draft.paidFrom === 'REP_CUSTODY');
  const repName = repsQ.data?.find(r => r.id === draft.paidFromRepId)?.name ?? null;

  // الملخّص = classifyEntryTx في الخادم: المسعَّر بسعره المُدخل ونسبته، والناقص بالمكتوب، و«شاملة الضريبة» ومعاملة الضريبة كما
  // يحلّهما الخادم من الجسم والحركة — فما يُرى هو ما يُقيَّد في كشف المورّد وسند الصرف الآلي
  const { totals } = classifyPreview({
    items: entry.items, saved: entry, prices: unpriced.map(i => priceOf(i.id)), inclusive, taxOff, productPct, decimals: activeDecimals(),
  });
  const due = draft.mode === 'CREDIT' ? dueDateOf(draft.billDate, vendor?.paymentDays) : null;
  const problem = !draft.mode ? 'MODE' as const
    : purchaseProblem(draft, vendor?.id, unpriced.map(i => ({ unitCost: priceOf(i.id).unitCost, taxPct: priceOf(i.id).taxPct })), { taxOff });

  const save = useMutation({
    mutationFn: () => {
      if (!draft.mode || !vendor) throw new Error('invalid');
      return warehouseApi.classifyEntry(entry.id, classifyBody({
        vendorId: vendor.id, draft: { ...draft, mode: draft.mode }, costsIncludeTax: inclusive, taxOff,
        prices: unpriced.map(i => priceOf(i.id)),
      }));
    },
    onSuccess: () => {
      PURCHASE_INVALIDATE_KEYS.forEach(k => qc.invalidateQueries({ queryKey: [k] }));
      toast.success(tr('تم تصنيف الحركة'));
      onClose();
    },
    onError: (e: unknown) => {
      toast.error(tr(purchaseErrorText(e) ?? 'تعذر الحفظ'));
      // صُنّفت من مكانٍ آخر: السجلّ من جديد ولا معنى لإبقاء النافذة
      if (serverCodeOf(e) === 'ENTRY_ALREADY_CLASSIFIED') { qc.invalidateQueries({ queryKey: ['warehouse-entries'] }); onClose(); }
    },
  });

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <h2 className="text-lg font-bold text-[#1F1A13] flex items-center gap-2"><Tags size={20} className="text-[#E15A30]" /> {tr('تصنيف الوارد')}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500" aria-label={tr('إغلاق')}><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          <p className="text-xs text-[#6E6557]">{tr('حدد المورد ونوع الشراء وأكمل الأسعار الناقصة ليسجل الوارد فاتورة مورد الكميات لا تتغير')}</p>
          {entry.supplier && !entry.vendorId && (
            <p className="text-[11px] text-[#9A8F7E]">{tr('المورد المكتوب في الحركة')}: <b className="text-[#1F1A13]">{entry.supplier}</b></p>
          )}
          <PurchaseFields draft={draft} onDraft={setDraft} vendor={vendor} onVendor={setVendor} taxOff={taxOff} disabled={save.isPending} />

          <div className="border border-[#E9E1D3] rounded-xl overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-[#FAF7F0] text-[10px] font-semibold text-[#9A8F7E]">
              <span className="min-w-0 flex-1">{tr('الصنف')}</span>
              <span className="w-16 text-center">{tr('الكمية')}</span>
              <span className="w-24 text-center">{tr('سعر الوحدة')}</span>
              {!taxOff && <span className="w-16 text-center">{tr('الضريبة %')}</span>}
            </div>
            <div className="divide-y divide-[#F1EBDF]">
              {lines.map(i => {
                const u = i.unitName || i.product.unit;
                const priced = typeof i.unitCost === 'number' && i.unitCost > 0;
                const p = priceOf(i.id);
                const missing = draft.mode !== null && !priced && parsePositive(p.unitCost) == null;
                return (
                  <div key={i.id} className="flex items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-[#1F1A13] truncate">{i.product.name}</p>
                      <p className="text-[11px] text-[#9A8F7E]">{u}{i.lot?.lotNumber ? ` · ${i.lot.lotNumber}` : ''}</p>
                    </div>
                    <span className="w-16 text-center text-sm text-[#1F1A13]">{fmtTotalQty(roundQty(i.qty))}</span>
                    {priced ? (
                      <span className="w-24 text-center text-xs text-[#6E6557]" title={tr('السعر المسجل لا يتغير')}>{formatCurrency(i.unitCost as number, undefined, 4)}</span>
                    ) : (
                      <input type="number" step="any" min="0" inputMode="decimal" value={p.unitCost} disabled={save.isPending}
                        onChange={e => patchPrice(i.id, { unitCost: e.target.value })} aria-label={`${tr('سعر الوحدة')} ${i.product.name}`}
                        className={`input w-24 py-1.5 text-center ${missing ? 'border-red-400 bg-red-50/40' : ''}`} placeholder={tr('مطلوب')} />
                    )}
                    {!taxOff && (priced
                      ? <span className="w-16 text-center text-xs text-[#6E6557]">{i.taxPct ?? productPct(i.productId)}%</span>
                      : <LineTaxInput value={p.taxPct} onChange={v => patchPrice(i.id, { taxPct: v })} disabled={save.isPending} />)}
                  </div>
                );
              })}
            </div>
            <div className="px-3 py-2 bg-[#FAF7F0] border-t border-[#F1EBDF] space-y-2">
              {!taxOff && unpriced.length > 0 && (
                <label className="flex items-center gap-2 text-[11px] text-[#6E6557] cursor-pointer">
                  <input type="checkbox" checked={inclusive} disabled={inclusiveLocked || save.isPending} onChange={e => setInclusive(e.target.checked)} className="accent-[#E15A30]" />
                  {tr('الأسعار المدخلة شاملة الضريبة')}
                </label>
              )}
              <PurchaseSummary totals={totals} taxOff={taxOff} mode={draft.mode} dueDate={due} paidFrom={draft.paidFrom} repName={repName} paymentDays={vendor?.paymentDays} />
            </div>
          </div>
          {problem && (
            <p className="text-[11px] text-amber-700">{problem === 'MODE' ? tr('اختر نوع الشراء نقدي أو آجل') : tr(PURCHASE_PROBLEM_TEXT[problem])}</p>
          )}
        </div>
        <div className="flex gap-3 p-5 border-t border-[#E9E1D3]">
          <button onClick={() => save.mutate()} disabled={!!problem || save.isPending} className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
            {save.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Tags size={16} />}
            {tr('حفظ التصنيف')}
          </button>
          <button onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}
