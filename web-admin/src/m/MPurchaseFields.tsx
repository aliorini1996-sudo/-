import { Banknote, CalendarClock, Info, Landmark, Truck, Wallet } from 'lucide-react';
import type { Supplier } from '../api/suppliers';
import type { PurchasePaidFrom, PurchasePaymentMode, WarehouseAdjustReason } from '../api/client';
import { useTr } from '../i18n/strings';
import { formatCurrency, formatDayOnly, formatNumber } from '../utils/format';
import {
  ADJUST_REASON_LABELS, PAID_FROM_LABELS, PAID_FROM_OPTIONS, PURCHASE_MODE_LABELS, PURCHASE_MODES, SUPPLIER_REF_MAX, WAREHOUSE_ADJUST_REASONS,
  type BillTotals, type PurchaseDraft,
} from '../components/purchases/purchaseCalc';
import { useRepsLite } from '../components/purchases/purchaseTypes';
import { MSupplierField } from './MPurchaseSupplier';
import { useMTaxOff } from './mTaxMode';

/*
 * حقول الشراء في نموذج «استلام بضاعة أو تسوية» على الجوال («ربط الدفاتر» L1، طلب المالك ١٣ نوفمبر ٢٠٢٦) — نظير PurchaseFields
 * في اللوحة بلبنات /m (بطاقات rounded-2xl، وأهداف لمس ≥ 44px):
 *  - المورّد من سجلّ الموردين (بحث وإضافة سريعة)، وزرّا «نقدي / آجل» اختياريّان: بلا اختيارٍ يبقى الوارد غير مصنَّف والجسم كما كان؛
 *  - للمصنَّف رقم فاتورة المورّد وتاريخها، وللنقدي «مدفوع من» (الصندوق/البنك/عهدة مندوب)؛
 *  - خانة نسبة السطر، والملخّص الحيّ بتقريب الخادم، وسبب التسوية.
 * «إزالة الضريبة»: كل ذكرٍ للضريبة هنا خلف `!taxOff &&` (حارس taxOffMScreens.test.ts يقرأ هذا الملف) — الإجمالي وحده.
 */

const PAID_ICON: Record<PurchasePaidFrom, typeof Wallet> = { MAIN_CASH: Wallet, BANK: Landmark, REP_CUSTODY: Truck };

/** عنوان قسمٍ في نموذج /m — كعناوين MWarehouse */
function H({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1 uppercase tracking-wide">{children}</h3>;
}

export function MPurchaseFields({ draft, onDraft, vendor, onVendor, disabled = false, requireMode = false }: {
  draft: PurchaseDraft;
  onDraft: (d: PurchaseDraft) => void;
  vendor: Supplier | null;
  onVendor: (s: Supplier | null) => void;
  disabled?: boolean;
  /** التصنيف: نوع الشراء إلزاميّ (لا «غير مصنَّف» يُختار فيه)، فلا يُلغى بالضغط على المختار */
  requireMode?: boolean;
}) {
  const tr = useTr();
  const taxOff = useMTaxOff();
  const set = (p: Partial<PurchaseDraft>) => onDraft({ ...draft, ...p });
  const repsQ = useRepsLite(draft.mode === 'CASH' && draft.paidFrom === 'REP_CUSTODY');
  const pickMode = (m: PurchasePaymentMode) => set({ mode: draft.mode === m && !requireMode ? null : m });
  return (
    <>
      {/* ─────────── المورّد ─────────── */}
      <section className="space-y-2.5">
        <H>{draft.mode ? tr('المورد') : tr('المورد اختياري')}</H>
        <div className="bg-white rounded-2xl border border-[#F1EBDF] p-3 space-y-1.5">
          <MSupplierField value={vendor} onChange={onVendor} disabled={disabled} />
          {vendor && <VendorFacts vendor={vendor} showVatHint={!!draft.mode} />}
        </div>
      </section>

      {/* ─────────── نوع الشراء ─────────── */}
      <section className="space-y-2.5">
        <H>{tr('نوع الشراء')}</H>
        <div className="grid grid-cols-2 gap-2.5">
          {PURCHASE_MODES.map(m => {
            const on = draft.mode === m;
            return (
              <button key={m} type="button" aria-pressed={on} disabled={disabled} onClick={() => pickMode(m)}
                className={`min-h-[48px] rounded-xl border text-sm font-bold flex items-center justify-center gap-2 ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white text-[#6E6557]'}`}>
                {m === 'CASH' ? <Banknote size={16} /> : <CalendarClock size={16} />} {tr(PURCHASE_MODE_LABELS[m])}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-[#9A8F7E] px-1 -mt-1 leading-relaxed">
          {draft.mode === 'CASH' ? tr('يسجل سند صرف للمورد بكامل قيمة الفاتورة')
            : draft.mode === 'CREDIT' ? tr('تضاف قيمة الفاتورة إلى المستحق للمورد حتى تسدد')
              : requireMode ? tr('اختر نوع الشراء نقدي أو آجل')
                : tr('بلا اختيار يسجل وارد غير مصنف ويمكن تصنيفه لاحقا من السجل')}
        </p>

        {draft.mode && (
          <div className="bg-white rounded-2xl border border-[#F1EBDF] p-3 space-y-2.5">
            <div className="grid grid-cols-2 gap-2">
              <label className="min-w-0">
                <span className="block text-[10px] text-[#9A8F7E] mb-1">{tr('رقم فاتورة المورد')}</span>
                <input className="input min-h-[44px]" dir="ltr" maxLength={SUPPLIER_REF_MAX} value={draft.supplierRef} disabled={disabled}
                  placeholder={tr('اختياري')} onChange={e => set({ supplierRef: e.target.value })} />
              </label>
              <label className="min-w-0">
                <span className="block text-[10px] text-[#9A8F7E] mb-1">{tr('تاريخ فاتورة المورد')}</span>
                <input type="date" className="input min-h-[44px]" value={draft.billDate} disabled={disabled}
                  onChange={e => set({ billDate: e.target.value })} />
              </label>
            </div>

            {draft.mode === 'CASH' && (
              <div className="space-y-2">
                <span className="block text-[10px] text-[#9A8F7E]">{tr('مدفوع من')}</span>
                <div className="grid grid-cols-3 gap-2">
                  {PAID_FROM_OPTIONS.map(p => {
                    const Icon = PAID_ICON[p];
                    const on = draft.paidFrom === p;
                    return (
                      <button key={p} type="button" aria-pressed={on} disabled={disabled} onClick={() => set({ paidFrom: p })}
                        className={`min-h-[48px] rounded-xl border text-[11px] font-bold flex flex-col items-center justify-center gap-0.5 px-1 ${on ? 'border-[#2F855A] bg-[#EAF6F0] text-[#2F855A]' : 'border-[#E9E1D3] bg-white text-[#6E6557]'}`}>
                        <Icon size={15} /> <span className="leading-tight text-center">{tr(PAID_FROM_LABELS[p])}</span>
                      </button>
                    );
                  })}
                </div>
                {draft.paidFrom === 'REP_CUSTODY' && (
                  <select className="input min-h-[44px]" value={draft.paidFromRepId} disabled={disabled} aria-label={tr('المندوب')}
                    onChange={e => set({ paidFromRepId: e.target.value })}>
                    <option value="">{repsQ.isLoading ? tr('جاري التحميل') : tr('اختر المندوب الذي دفع من عهدته')}</option>
                    {(repsQ.data ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </>
  );
}

/** ما يلزم معرفته عن المورّد المختار: مدة سداده ورقمه الضريبي ورصيده — وتنبيه مورّدٍ بلا رقم ضريبي في الشراء المصنَّف */
function VendorFacts({ vendor, showVatHint }: { vendor: Supplier; showVatHint: boolean }) {
  const tr = useTr();
  const taxOff = useMTaxOff();
  const days = vendor.paymentDays != null && vendor.paymentDays > 0 ? vendor.paymentDays : null;
  const hasBalance = typeof vendor.balance === 'number' && Math.abs(vendor.balance) > 1e-9;
  return (
    <>
      <p className="text-[11px] text-[#9A8F7E] px-0.5 leading-relaxed">
        {days != null && <span>{tr('مدة السداد')} {formatNumber(days)} {tr('يوم')}</span>}
        {!taxOff && vendor.vatNumber && <span>{days != null ? ' · ' : ''}{tr('الرقم الضريبي')} <span dir="ltr">{vendor.vatNumber}</span></span>}
        {hasBalance && (
          <span>{days != null || (!taxOff && vendor.vatNumber) ? ' · ' : ''}{vendor.balance > 0 ? tr('مستحق له') : tr('رصيد مدين له')} <b className="text-[#1F1A13] tabular-nums">{formatCurrency(Math.abs(vendor.balance))}</b></span>
        )}
      </p>
      {!taxOff && showVatHint && !vendor.vatNumber && (
        <p className="text-[11px] text-[#8A6D1F] px-0.5 flex items-start gap-1 leading-relaxed">
          <Info size={12} className="flex-shrink-0 mt-0.5" /> {tr('المورد بلا رقم ضريبي تأكد من نسبة الضريبة في فاتورته')}
        </p>
      )}
    </>
  );
}

/**
 * خانة نسبة ضريبة السطر في الشراء المصنَّف (افتراضها ضريبة الصنف في placeholder) — لا شيء مع «إزالة الضريبة» (النسبة المرسَلة صفر).
 * الخانة تعرض النصّ الخام: مسحها لإعادة الكتابة يعود بالحساب إلى نسبة الصنف لا بالخانة نفسها
 */
export function MLineTaxInput({ value, fallback, onChange, invalid = false, disabled = false }: {
  value: string; fallback: number; onChange: (v: string) => void; invalid?: boolean; disabled?: boolean;
}) {
  const tr = useTr();
  const taxOff = useMTaxOff();
  return (
    <>
      {!taxOff && (
        <label className="w-[72px] flex-shrink-0">
          <span className="block text-[10px] text-[#9A8F7E] mb-1">{tr('الضريبة %')}</span>
          <input className={`input text-center min-h-[44px] ${invalid ? 'border-[#C0392B]' : ''}`} dir="ltr" type="number" inputMode="decimal"
            step="any" min="0" max="100" value={value} disabled={disabled} placeholder={String(fallback)}
            aria-label={tr('نسبة ضريبة السطر')} onChange={e => onChange(e.target.value)} />
        </label>
      )}
    </>
  );
}

/** ملخّص الشراء الحيّ: الصافي والضريبة والإجمالي كما يقيّدها الخادم (entryBillTotals)، والاستحقاق للآجل ومصدر الدفع للنقدي */
export function MPurchaseSummary({ totals, mode, dueDate, paymentDays, paidFrom, repName, title, noTax = false }: {
  totals: BillTotals;
  mode: PurchasePaymentMode | null;
  dueDate?: string | null;
  paymentDays?: number | null;
  paidFrom?: PurchasePaidFrom;
  repName?: string | null;
  /** عنوان الإجمالي (قبل tr) — «إجمالي فاتورة المورد» افتراضاً، و«إجمالي المرتجع» في المرتجع */
  title?: string;
  /** مرتجع واردٍ مسجَّلٍ بلا ضريبة — الإجمالي وحده كإزالة الضريبة */
  noTax?: boolean;
}) {
  const tr = useTr();
  const taxOff = useMTaxOff() || noTax;
  return (
    <div className="space-y-1">
      {!taxOff && (
        <>
          <p className="text-[11px] text-[#6E6557] flex items-center justify-between gap-2">
            <span>{tr('الصافي قبل الضريبة')}</span><b className="text-[#1F1A13] tabular-nums">{formatCurrency(totals.net)}</b>
          </p>
          <p className="text-[11px] text-[#6E6557] flex items-center justify-between gap-2">
            <span>{tr('ضريبة المشتريات')}</span><b className="text-[#1F1A13] tabular-nums">{formatCurrency(totals.tax)}</b>
          </p>
        </>
      )}
      <p className="text-[13px] text-[#1F1A13] font-bold flex items-center justify-between gap-2">
        <span>{tr(title ?? 'إجمالي فاتورة المورد')}</span><span className="tabular-nums">{formatCurrency(totals.total)}</span>
      </p>
      {mode === 'CREDIT' && dueDate && (
        <p className="text-[11px] text-[#6E6557] flex items-center gap-1 flex-wrap">
          <CalendarClock size={12} className="text-[#E15A30] flex-shrink-0" /> {tr('تاريخ الاستحقاق')} <b className="text-[#1F1A13]">{formatDayOnly(dueDate)}</b>
          {paymentDays != null && paymentDays > 0
            ? <span>({formatNumber(paymentDays)} {tr('يوم')})</span>
            : <span>· {tr('بلا مدة سداد مستحقة في تاريخ الفاتورة')}</span>}
        </p>
      )}
      {mode === 'CASH' && paidFrom && (
        <p className="text-[11px] text-[#6E6557] flex items-center gap-1 flex-wrap">
          <Banknote size={12} className="text-[#2F855A] flex-shrink-0" /> {tr('يصرف كامل المبلغ من')}
          <b className="text-[#1F1A13]">{tr(PAID_FROM_LABELS[paidFrom])}{paidFrom === 'REP_CUSTODY' && repName ? ` · ${repName}` : ''}</b>
        </p>
      )}
    </div>
  );
}

/** «سبب التسوية» — جرد/تالف/منتهي الصلاحية/عينات/أخرى؛ اختياريّ (الضغط على المختار يلغيه) فلا يتغيّر حفظ من لا يختار */
export function MAdjustReason({ value, onChange, disabled = false }: {
  value: WarehouseAdjustReason | ''; onChange: (v: WarehouseAdjustReason | '') => void; disabled?: boolean;
}) {
  const tr = useTr();
  return (
    <section className="space-y-2.5">
      <H>{tr('سبب التسوية')}</H>
      <div className="flex flex-wrap gap-2" role="group" aria-label={tr('سبب التسوية')}>
        {WAREHOUSE_ADJUST_REASONS.map(r => {
          const on = value === r;
          return (
            <button key={r} type="button" aria-pressed={on} disabled={disabled} onClick={() => onChange(on ? '' : r)}
              className={`min-h-[40px] px-3.5 rounded-xl border text-[12px] font-bold ${on ? 'border-[#6B46C1] bg-[#F3EEFB] text-[#6B46C1]' : 'border-[#E9E1D3] bg-white text-[#6E6557]'}`}>
              {tr(ADJUST_REASON_LABELS[r])}
            </button>
          );
        })}
      </div>
    </section>
  );
}
