import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, Landmark, Loader2, Tags, Undo2, Wallet } from 'lucide-react';
import toast from 'react-hot-toast';
import { productApi, warehouseApi } from '../api/client';
import { suppliersApi, type Supplier } from '../api/suppliers';
import { useTr } from '../i18n/strings';
import { useBackClose } from '../lib/useBackClose';
import { fmtTotalQty } from '../lib/qtyView';
import { roundQty } from '../lib/units';
import { activeLocale, formatCurrency, formatDate } from '../utils/format';
import {
  classifyBody, classifyInclusiveLocked, classifyPreview, dayOf, dueDateOf, emptyPurchaseDraft, mergeEntries, parsePositive, parseTaxPct,
  purchaseErrorText, purchaseProblem, remainingByItem, returnBody, returnPreview, returnProblem, serverCodeOf, PURCHASE_PROBLEM_TEXT,
  RETURN_PROBLEM_TEXT, SUPPLIER_REF_MAX, type ClassifyPriceDraft, type PurchaseDraft,
} from '../components/purchases/purchaseCalc';
import {
  activeDecimals, PURCHASE_INVALIDATE_KEYS, todayDay, useRepsLite, useVendorReturns, type PurchaseEntry,
} from '../components/purchases/purchaseTypes';
import { MHeader } from './mobileUi';
import { MLineTaxInput, MPurchaseFields, MPurchaseSummary } from './MPurchaseFields';
import {
  cancelEffects, classifyItems, invalidateKeys, paidOnCredit, receiptDayOf, returnDefaults, returnNoTax, unpricedItems,
} from './MPurchaseLogic';
import { useMTaxOff } from './mTaxMode';

/*
 * أفعال حركة المستودع على الجوال («ربط الدفاتر» L1، طلب المالك ١٣ نوفمبر ٢٠٢٦) — نظائر نوافذ اللوحة بتصميم /m:
 *  - «تصنيف الوارد» و«مرتجع للمورد» طبقتان ملء الشاشة (كنموذج الحركة) بشريط حفظٍ ثابت أسفلها؛
 *  - «إلغاء الحركة» ورقةٌ سفلية بتأكيدٍ صريح (كـMConfirm).
 * الحساب من purchaseCalc (مرآة الخادم بفرق صفر)، والخادم هو الحَكَم: رموزه بنصّها العربي (purchaseErrorText). وكل ذكرٍ للضريبة
 * خلف `!taxOff &&` (حارس taxOffMScreens.test.ts).
 */

/** كمية السطر كما تُعرض — كسورٌ حتى أربع منازل بلا أصفار زائدة (كـfmtQty في MWarehouse) */
const fmtQ = (n: number) => fmtTotalQty(roundQty(n), activeLocale());

/** الكاش بعد كل فعل: الجوال واللوحة والموردون وسنداتهم، والتشغيلات حين الميزة مفعّلة */
function useInvalidateAll(lotOn: boolean) {
  const qc = useQueryClient();
  return () => invalidateKeys(PURCHASE_INVALIDATE_KEYS, lotOn).forEach(k => qc.invalidateQueries({ queryKey: [k] }));
}

/** غلاف طبقةٍ ملء الشاشة بترويسةٍ وشريطٍ سفلي ثابت — كنموذج الحركة في MWarehouse */
function Layer({ title, subtitle, onClose, footer, children }: {
  title: string; subtitle?: string; onClose: () => void; footer: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={title} subtitle={subtitle} onBack={onClose} />
      <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-4">
        {children}
        <div className="h-2" />
      </div>
      <div className="flex-shrink-0 border-t border-[#E9E1D3] bg-white p-3"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
        {footer}
      </div>
    </div>
  );
}

const primaryBtn = 'w-full bg-[#E15A30] text-white font-bold py-3.5 rounded-xl min-h-[50px] flex items-center justify-center gap-2 disabled:bg-[#E89B7E]';

/* ═══════════════════════ تصنيف الوارد ═══════════════════════ */

interface ProductTax { id: string; taxPct?: number }

/**
 * «تصنيف» واردٍ غير مصنَّف: المورّد ونوع الشراء (نقدي بمصدر دفعه / آجل) ورقم فاتورة المورّد وتاريخها، وأسعار الأسطر الناقصة وحدها —
 * السعر القائم لا يتغيّر والكميات لا تتغيّر (الخادم يملأ غير المسعَّر فقط، ويكتب ما يكتبه الإنشاء المصنَّف).
 */
export function MClassifyEntry({ entry, lotOn, onClose }: { entry: PurchaseEntry; lotOn: boolean; onClose: () => void }) {
  const tr = useTr();
  const taxOff = useMTaxOff();
  const invalidate = useInvalidateAll(lotOn);
  const qc = useQueryClient();
  const [vendor, setVendor] = useState<Supplier | null>(null);
  // المورّد المحفوظ على الحركة (إن وُجد) كاملاً — لمدة سداده ورقمه
  const vendorQ = useQuery({
    queryKey: ['suppliers', 'one', entry.vendorId ?? ''],
    queryFn: async () => ((await suppliersApi.get(entry.vendorId as string)).data as { data?: Supplier }).data ?? null,
    enabled: !!entry.vendorId,
    staleTime: 60_000,
  });
  useEffect(() => { if (vendorQ.data) setVendor(v => v ?? vendorQ.data ?? null); }, [vendorQ.data]);

  const [draft, setDraft] = useState<PurchaseDraft>(() => ({
    ...emptyPurchaseDraft(dayOf(entry.billDate) ?? receiptDayOf(entry.createdAt)),
    supplierRef: entry.supplierRef ?? '',
  }));
  // «شاملة الضريبة» افتراضها ما حُفظ على الحركة، ومقيَّدةٌ به حين في الوارد أسعارٌ مُدخلة (الخادم يرفض الخلط بين الطريقتين)
  const inclusiveLocked = classifyInclusiveLocked(entry.items);
  const [inclusiveDraft, setInclusive] = useState(() => !!entry.costsIncludeTax);
  useEffect(() => { if (taxOff) setInclusive(false); }, [taxOff]);
  const inclusive = inclusiveLocked ? !!entry.costsIncludeTax && !taxOff : inclusiveDraft;

  // نسبة الصنف لأسطر الحركة — افتراض نسبة السطر الناقص (مفتاح اللوحة نفسه)
  const prodQ = useQuery({
    queryKey: ['products-min'],
    queryFn: async () => (await productApi.list({ limit: 1000 })).data.data as ProductTax[],
    staleTime: 60_000,
  });
  const productPct = (id?: string) => {
    const p = (prodQ.data ?? []).find(x => x.id === id)?.taxPct;
    return typeof p === 'number' && Number.isFinite(p) ? p : 0;
  };
  const lines = classifyItems(entry.items);
  const unpriced = unpricedItems(entry.items);
  const [prices, setPrices] = useState<Record<string, ClassifyPriceDraft>>({});
  const priceOf = (id: string): ClassifyPriceDraft => prices[id] ?? { itemId: id, unitCost: '', taxPct: '' };
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
  const patchPrice = (id: string, p: Partial<ClassifyPriceDraft>) => setPrices(ps => ({ ...ps, [id]: { ...priceOf(id), ...p } }));

  const repsQ = useRepsLite(draft.mode === 'CASH' && draft.paidFrom === 'REP_CUSTODY');
  const repName = repsQ.data?.find(r => r.id === draft.paidFromRepId)?.name ?? null;
  // الملخّص = classifyEntryTx في الخادم (مرآة اللوحة نفسها): المسعَّر بسعره المُدخل، والناقص بالمكتوب، و«شاملة» ومعاملة الضريبة كالخادم
  const { totals } = classifyPreview({
    items: entry.items, saved: entry, prices: unpriced.map(i => priceOf(i.id)), inclusive, taxOff, productPct, decimals: activeDecimals(),
  });
  const due = draft.mode === 'CREDIT' ? dueDateOf(draft.billDate, vendor?.paymentDays) : null;
  const problem = !draft.mode ? null
    : purchaseProblem(draft, vendor?.id, unpriced.map(i => ({ unitCost: priceOf(i.id).unitCost, taxPct: priceOf(i.id).taxPct })), { taxOff });

  const save = useMutation({
    mutationFn: () => {
      if (!draft.mode || !vendor) throw new Error('invalid');
      return warehouseApi.classifyEntry(entry.id, classifyBody({
        vendorId: vendor.id, draft: { ...draft, mode: draft.mode }, costsIncludeTax: inclusive, taxOff, prices: unpriced.map(i => priceOf(i.id)),
      }));
    },
    onSuccess: () => {
      invalidate();
      toast.success(tr('تم تصنيف الحركة'));
      onClose();
    },
    onError: (e: unknown) => {
      toast.error(tr(purchaseErrorText(e) ?? 'تعذر الحفظ'));
      // صُنّفت من مكانٍ آخر: السجلّ من جديد ولا معنى لإبقاء الطبقة
      if (serverCodeOf(e) === 'ENTRY_ALREADY_CLASSIFIED') { qc.invalidateQueries({ queryKey: ['m-wh-entries'] }); onClose(); }
    },
  });

  return (
    <Layer title={tr('تصنيف الوارد')} subtitle={[entry.supplier, formatDate(entry.createdAt)].filter(Boolean).join(' · ')} onClose={onClose}
      footer={(
        <>
          <div className="mb-2 px-0.5">
            <MPurchaseSummary totals={totals} mode={draft.mode} dueDate={due} paymentDays={vendor?.paymentDays} paidFrom={draft.paidFrom} repName={repName} />
          </div>
          {(problem || !draft.mode) && (
            <p className="text-[11px] text-[#B7791F] mb-2 px-0.5">{problem ? tr(PURCHASE_PROBLEM_TEXT[problem]) : tr('اختر نوع الشراء نقدي أو آجل')}</p>
          )}
          <button onClick={() => save.mutate()} disabled={!draft.mode || !!problem || save.isPending} className={primaryBtn}>
            {save.isPending ? <Loader2 size={16} className="animate-spin" /> : <Tags size={16} />}
            {tr('حفظ التصنيف')}
          </button>
        </>
      )}>
      <p className="text-[11px] text-[#6E6557] px-1 leading-relaxed">{tr('حدد المورد ونوع الشراء وأكمل الأسعار الناقصة ليسجل الوارد فاتورة مورد الكميات لا تتغير')}</p>
      {entry.supplier && !entry.vendorId && (
        <p className="text-[11px] text-[#9A8F7E] px-1">{tr('المورد المكتوب في الحركة')}: <b className="text-[#1F1A13]">{entry.supplier}</b></p>
      )}

      <MPurchaseFields draft={draft} onDraft={setDraft} vendor={vendor} onVendor={setVendor} disabled={save.isPending} requireMode />

      <section className="space-y-2.5">
        <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1 uppercase tracking-wide">{tr('الأصناف')}</h3>
        <div className="bg-white rounded-2xl border border-[#F1EBDF]">
          {lines.map(i => {
            const u = i.unitName || i.product.unit;
            const priced = typeof i.unitCost === 'number' && i.unitCost > 0;
            const p = priceOf(i.id);
            const missing = draft.mode !== null && !priced && parsePositive(p.unitCost) == null;
            return (
              <div key={i.id} className="p-3 space-y-2 border-b border-[#F1EBDF] last:border-0">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-[#1F1A13] truncate">{i.product.name}</span>
                    <span className="block text-[11px] text-[#9A8F7E] truncate">{fmtQ(i.qty)} {u}{i.lot?.lotNumber ? ` · ${i.lot.lotNumber}` : ''}</span>
                  </span>
                  {priced && (
                    <span className="text-end flex-shrink-0">
                      <span className="block text-xs font-bold text-[#1F1A13] tabular-nums" dir="ltr">{formatCurrency(i.unitCost as number, undefined, 4)}</span>
                      <span className="block text-[9px] text-[#9A8F7E]">{tr('السعر المسجل لا يتغير')}</span>
                    </span>
                  )}
                </div>
                {!priced && (
                  <div className="flex items-end gap-2">
                    <label className="flex-1 min-w-0">
                      <span className="block text-[10px] text-[#9A8F7E] mb-1">{tr('سعر الوحدة')} ({u})</span>
                      <input className={`input text-center min-h-[44px] ${missing ? 'border-[#C0392B]' : ''}`} dir="ltr" type="number" inputMode="decimal"
                        step="any" min="0" value={p.unitCost} disabled={save.isPending} placeholder={tr('مطلوب')}
                        onChange={e => patchPrice(i.id, { unitCost: e.target.value })} />
                    </label>
                    <MLineTaxInput value={p.taxPct} fallback={productPct(i.productId)} disabled={save.isPending}
                      invalid={draft.mode !== null && parseTaxPct(p.taxPct) == null} onChange={v => patchPrice(i.id, { taxPct: v })} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {!taxOff && unpriced.length > 0 && (
          <label className="flex items-center gap-2.5 min-h-[44px] cursor-pointer px-1">
            <input type="checkbox" checked={inclusive} disabled={inclusiveLocked || save.isPending} className="w-5 h-5 accent-[#E15A30] flex-shrink-0"
              onChange={e => setInclusive(e.target.checked)} />
            <span className="text-[13px] font-semibold text-[#1F1A13]">{tr('الأسعار المدخلة شاملة الضريبة')}</span>
          </label>
        )}
      </section>
    </Layer>
  );
}

/* ═══════════════════════ مرتجع للمورد ═══════════════════════ */

/**
 * «مرتجع للمورد» لواردٍ مصنَّف: كميةٌ لكل سطر ≤ المتبقّي منه بتكلفة السطر الأصلي ونسبته (الخادم يكتب حركة RETURN بكميات سالبة
 * واللوط نفسه). «خصم من المستحق» يُنقص ما ندين به، و«المورد رد المبلغ نقدا» إلى الصندوق أو البنك.
 */
export function MReturnEntry({ entry, all, lotOn, onClose }: {
  entry: PurchaseEntry;
  /** صفوف السجلّ — منها مرتجعات هذا الوارد السابقة (المتبقّي) */
  all: readonly PurchaseEntry[];
  lotOn: boolean;
  onClose: () => void;
}) {
  const tr = useTr();
  const taxOff = useMTaxOff();
  const invalidate = useInvalidateAll(lotOn);
  const qc = useQueryClient();
  const vendorReturnsQ = useVendorReturns(entry.vendorId);
  // السجلّ المعروض + مرتجعات المورّد بلا تكرار (السجلّ قد يكون مفلتراً بنوعٍ يخفيها): منها المتبقّي من كل سطر ومن الفاتورة
  const pool = useMemo(() => mergeEntries(all, vendorReturnsQ.data), [all, vendorReturnsQ.data]);
  const remaining = useMemo(() => remainingByItem(entry, pool), [entry, pool]);
  const lines = classifyItems(entry.items);
  const [qtys, setQtys] = useState<Map<string, string>>(() => new Map(lines.map(i => [i.id, ''])));
  const setQty = (id: string, v: string) => setQtys(m => new Map(m).set(id, v));
  const defaults = returnDefaults(entry);
  const [refundMode, setRefundMode] = useState<'CREDIT' | 'CASH'>(defaults.refundMode);
  const [refundTo, setRefundTo] = useState<'MAIN_CASH' | 'BANK'>(defaults.refundTo);
  const [supplierRef, setSupplierRef] = useState('');
  const [billDate, setBillDate] = useState(todayDay());
  const [note, setNote] = useState('');

  // الحساب = reverseEntryTx (السعر المُدخل والمتبقّي من الفاتورة) بمعاملة ضريبة الوارد؛ noTax يُخفي سطري الضريبة وحدهما
  const preview = returnPreview(entry, pool, qtys, activeDecimals());
  const noTax = returnNoTax(entry, taxOff);
  const problem = returnProblem(qtys, remaining, { supplierRef, billDate });

  const save = useMutation({
    mutationFn: () => warehouseApi.returnEntry(entry.id, returnBody({ qtys, note, supplierRef, billDate, refundMode, refundTo })),
    onSuccess: () => {
      invalidate();
      toast.success(tr('تم تسجيل المرتجع للمورد'));
      onClose();
    },
    onError: (e: unknown) => {
      toast.error(tr(purchaseErrorText(e) ?? 'تعذر الحفظ'));
      // المتبقّي تغيّر (مرتجعٌ من مكانٍ آخر): السجلّ من جديد فتُحسب البقية
      qc.invalidateQueries({ queryKey: ['m-wh-entries'] });
    },
  });

  const toggle = (on: boolean) => `min-h-[48px] rounded-xl border text-[12px] font-bold flex items-center justify-center gap-1.5 px-2 ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white text-[#6E6557]'}`;

  return (
    <Layer title={tr('مرتجع للمورد')} subtitle={[entry.vendor?.name ?? entry.supplier, entry.supplierRef].filter(Boolean).join(' · ')} onClose={onClose}
      footer={(
        <>
          {preview.lines > 0 && (
            <div className="mb-2 px-0.5">
              <MPurchaseSummary totals={preview.totals} mode={null} title="إجمالي المرتجع" noTax={noTax} />
            </div>
          )}
          {problem && problem !== 'NOTHING' && <p className="text-[11px] text-[#C0392B] mb-2 px-0.5">{tr(RETURN_PROBLEM_TEXT[problem])}</p>}
          <button onClick={() => save.mutate()} disabled={!!problem || save.isPending} className={primaryBtn}>
            {save.isPending ? <Loader2 size={16} className="animate-spin" /> : <Undo2 size={16} />}
            {tr('حفظ المرتجع')}
          </button>
        </>
      )}>
      <section className="space-y-2.5">
        <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1 uppercase tracking-wide">{tr('كمية المرتجع')}</h3>
        <div className="bg-white rounded-2xl border border-[#F1EBDF]">
          {lines.map(i => {
            const u = i.unitName || i.product.unit;
            const rem = remaining.get(i.id) ?? 0;
            const v = qtys.get(i.id) ?? '';
            const q = Number(v);
            const over = v.trim() !== '' && (!Number.isFinite(q) || q < 0 || q > rem + 1e-9);
            return (
              <div key={i.id} className="p-3 space-y-2 border-b border-[#F1EBDF] last:border-0">
                <div className="min-w-0">
                  <span className="block text-sm font-semibold text-[#1F1A13] truncate">{i.product.name}</span>
                  <span className="block text-[11px] text-[#9A8F7E] truncate">
                    {u}{i.lot?.lotNumber ? ` · ${i.lot.lotNumber}` : ''}
                    {typeof i.unitCost === 'number' && <> · <span dir="ltr">{formatCurrency(i.unitCost, undefined, 4)}</span>/{u}</>}
                  </span>
                </div>
                <div className="flex items-end gap-2">
                  <div className="flex-1 min-w-0 rounded-xl bg-[#FAF7F0] border border-[#F1EBDF] px-3 py-2">
                    <span className="block text-[10px] text-[#9A8F7E]">{tr('المتبقي')}</span>
                    <span className={`block text-[13px] font-bold tabular-nums ${rem > 0 ? 'text-[#1F1A13]' : 'text-[#C9BFB0]'}`}>{fmtQ(rem)}</span>
                  </div>
                  <label className="flex-1 min-w-0">
                    <span className="block text-[10px] text-[#9A8F7E] mb-1">{tr('كمية المرتجع')}</span>
                    <input className={`input text-center min-h-[44px] text-base font-bold ${over ? 'border-[#C0392B]' : ''}`} dir="ltr" type="number"
                      inputMode="decimal" step="any" min="0" max={rem} value={v} disabled={rem <= 0 || save.isPending} placeholder="0"
                      aria-label={`${tr('كمية المرتجع')} ${i.product.name}`} onChange={e => setQty(i.id, e.target.value)} />
                  </label>
                  {rem > 0 && (
                    <button type="button" onClick={() => setQty(i.id, String(roundQty(rem)))} disabled={save.isPending}
                      className="min-h-[44px] px-3 rounded-xl border border-[#E9E1D3] bg-white text-[12px] font-bold text-[#E15A30] active:bg-[#FBEBE2] flex-shrink-0">
                      {tr('الكل')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-[#9A8F7E] px-1">{tr('تخرج كميات المرتجع من رصيد المستودع')}</p>
      </section>

      <section className="space-y-2.5">
        <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1 uppercase tracking-wide">{tr('تسوية قيمة المرتجع')}</h3>
        <div className="grid grid-cols-2 gap-2.5">
          {(['CREDIT', 'CASH'] as const).map(m => (
            <button key={m} type="button" aria-pressed={refundMode === m} disabled={save.isPending} onClick={() => setRefundMode(m)} className={toggle(refundMode === m)}>
              {m === 'CREDIT' ? tr('خصم من المستحق للمورد') : tr('المورد رد المبلغ نقدا')}
            </button>
          ))}
        </div>
        {refundMode === 'CASH' && (
          <div className="grid grid-cols-2 gap-2.5">
            {(['MAIN_CASH', 'BANK'] as const).map(t => (
              <button key={t} type="button" aria-pressed={refundTo === t} disabled={save.isPending} onClick={() => setRefundTo(t)}
                className={`min-h-[44px] rounded-xl border text-[12px] font-bold flex items-center justify-center gap-1.5 ${refundTo === t ? 'border-[#2F855A] bg-[#EAF6F0] text-[#2F855A]' : 'border-[#E9E1D3] bg-white text-[#6E6557]'}`}>
                {t === 'BANK' ? <Landmark size={14} /> : <Wallet size={14} />} {t === 'BANK' ? tr('إلى البنك') : tr('إلى الصندوق الرئيسي')}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="bg-white rounded-2xl border border-[#F1EBDF] p-3 space-y-2.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="min-w-0">
            <span className="block text-[10px] text-[#9A8F7E] mb-1">{tr('رقم إشعار المورد')}</span>
            <input className="input min-h-[44px]" dir="ltr" maxLength={SUPPLIER_REF_MAX} value={supplierRef} disabled={save.isPending}
              placeholder={tr('اختياري')} onChange={e => setSupplierRef(e.target.value)} />
          </label>
          <label className="min-w-0">
            <span className="block text-[10px] text-[#9A8F7E] mb-1">{tr('تاريخ المرتجع')}</span>
            <input type="date" className="input min-h-[44px]" value={billDate} disabled={save.isPending} onChange={e => setBillDate(e.target.value)} />
          </label>
        </div>
        <label className="block">
          <span className="block text-[10px] text-[#9A8F7E] mb-1">{tr('ملاحظة اختياري')}</span>
          <input className="input min-h-[44px]" maxLength={300} value={note} disabled={save.isPending} placeholder={tr('مثال بضاعة تالفة')}
            onChange={e => setNote(e.target.value)} />
        </label>
      </section>
    </Layer>
  );
}

/* ═══════════════════════ إلغاء الحركة ═══════════════════════ */

/**
 * «إلغاء الحركة» بتأكيدٍ صريح في ورقةٍ سفلية: مرتجعٌ كامل لما بقي من الوارد وحالته «ملغاة» — لا حذف. النقدي يُلغى سنده الآلي، والآجل
 * الذي عليه دفعات سارية يُمنع ويُقال السبب قبل الإرسال (والخادم الحَكَم: 409 BILL_HAS_PAYMENTS).
 */
export function MCancelEntry({ entry, lotOn, onClose }: { entry: PurchaseEntry; lotOn: boolean; onClose: () => void }) {
  const tr = useTr();
  const invalidate = useInvalidateAll(lotOn);
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [sure, setSure] = useState(false);
  const blocked = paidOnCredit(entry);
  const mode = entry.paymentMode === 'CASH' || entry.paymentMode === 'CREDIT' ? entry.paymentMode : null;

  const save = useMutation({
    mutationFn: () => warehouseApi.cancelEntry(entry.id, reason.slice(0, 300)),
    onSuccess: () => {
      invalidate();
      toast.success(tr('ألغيت الحركة'));
      onClose();
    },
    onError: (e: unknown) => {
      toast.error(tr(purchaseErrorText(e) ?? 'تعذر إلغاء الحركة'));
      if (serverCodeOf(e) === 'BILL_HAS_PAYMENTS') qc.invalidateQueries({ queryKey: ['m-wh-entries'] });
    },
  });
  // الرجوع يُغلق الورقة — إلا والفعل جارٍ، فإغلاقٌ وقتها يُخفي نتيجته (كـMConfirm)
  const close = () => { if (!save.isPending) onClose(); };
  useBackClose(true, onClose);

  return (
    <div className="absolute inset-0 z-[700] bg-black/50 flex items-end" onClick={close}>
      <div className="w-full bg-white rounded-t-3xl p-4 space-y-3 max-h-[90%] overflow-y-auto" onClick={e => e.stopPropagation()}
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }} role="dialog" aria-modal="true">
        <div className="flex items-start gap-3">
          <span className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-[#FDF2F0] text-[#C0392B]">
            <AlertTriangle size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-[#1F1A13]">{tr('إلغاء الحركة')}</span>
            <span className="block text-[12px] text-[#6E6557] mt-0.5">
              {[entry.vendor?.name ?? entry.supplier, entry.supplierRef, formatDate(entry.createdAt)].filter(Boolean).join(' · ')}
              {typeof entry.total === 'number' && mode && <> · <b className="text-[#1F1A13]">{formatCurrency(Math.abs(entry.total))}</b></>}
            </span>
          </span>
        </div>
        <ul className="space-y-1.5 text-[12px] text-[#6E6557] list-disc ps-5 leading-relaxed">
          {cancelEffects(entry).map(t => <li key={t}>{tr(t)}</li>)}
        </ul>
        {blocked ? (
          <p className="rounded-xl bg-[#FDF2F0] border border-[#F5C6C0] px-3 py-2.5 text-[12px] text-[#C0392B] leading-relaxed">
            {tr('على هذه الفاتورة دفعات سارية ألغ سندات الصرف المخصصة لها أولا')} ({tr('المدفوع')} {formatCurrency(entry.paid ?? 0)})
          </p>
        ) : (
          <>
            <label className="block">
              <span className="block text-[11px] text-[#9A8F7E] mb-1">{tr('سبب الإلغاء اختياري')}</span>
              <input className="input min-h-[44px]" maxLength={300} value={reason} disabled={save.isPending} placeholder={tr('مثال فاتورة مكررة')}
                onChange={e => setReason(e.target.value)} />
            </label>
            <label className="flex items-start gap-2.5 min-h-[44px] cursor-pointer">
              <input type="checkbox" checked={sure} disabled={save.isPending} onChange={e => setSure(e.target.checked)}
                className="w-5 h-5 accent-[#C0392B] flex-shrink-0 mt-0.5" />
              <span className="text-[12px] text-[#1F1A13] leading-relaxed">{tr('أؤكد إلغاء الحركة وإرجاع كل ما بقي من بضاعتها')}</span>
            </label>
          </>
        )}
        <div className="flex gap-2.5 pt-1">
          <button type="button" onClick={close} disabled={save.isPending}
            className="flex-1 min-h-[48px] rounded-xl border border-[#E9E1D3] bg-white font-bold text-sm text-[#1F1A13]">
            {tr('رجوع')}
          </button>
          <button type="button" onClick={() => save.mutate()} disabled={!sure || blocked || save.isPending}
            className="flex-1 min-h-[48px] rounded-xl font-bold text-sm text-white flex items-center justify-center gap-2 bg-[#C0392B] disabled:bg-[#D98A80]">
            {save.isPending ? <Loader2 size={16} className="animate-spin" /> : <Ban size={16} />}
            {tr('إلغاء الحركة')}
          </button>
        </div>
      </div>
    </div>
  );
}
