import { Banknote, CalendarClock, Info, Landmark, Truck, Wallet } from 'lucide-react';
import type { Supplier } from '../../api/suppliers';
import type { PurchasePaidFrom, PurchasePaymentMode } from '../../api/client';
import { useTr } from '../../i18n/strings';
import { formatCurrency } from '../../utils/format';
import SupplierPicker from './SupplierPicker';
import { PAID_FROM_LABELS, PAID_FROM_OPTIONS, PURCHASE_MODE_LABELS, PURCHASE_MODES, SUPPLIER_REF_MAX, type PurchaseDraft } from './purchaseCalc';
import { useRepsLite } from './purchaseTypes';

/*
 * حقول الشراء في نافذة «استلام / تسوية» («ربط الدفاتر» L1، طلب المالك ١٣ نوفمبر ٢٠٢٦):
 *  - المورّد من سجلّ الموردين (بحث وإضافة سريعة)، وزرّا «نقدي / آجل» — اختياريان: بلا اختيارٍ يبقى الوارد غير مصنَّف كما كان؛
 *  - للنقدي «مدفوع من» (الصندوق الرئيسي/البنك/عهدة مندوب)، ورقم فاتورة المورّد وتاريخها، وللآجل تاريخ الاستحقاق من مدة المورّد؛
 *  - نسبة ضريبة لكل سطر (افتراضها ضريبة الصنف) وملخّصٌ حيّ = حساب الخادم (purchaseCalc.draftBillTotals ⇐ entryBillTotals).
 * «إزالة الضريبة»: لا خانة نسبة ولا سطر ضريبة — الإجمالي وحده.
 */

const PAID_ICON: Record<PurchasePaidFrom, typeof Wallet> = { MAIN_CASH: Wallet, BANK: Landmark, REP_CUSTODY: Truck };

export function PurchaseFields({ draft, onDraft, vendor, onVendor, taxOff, disabled = false }: {
  draft: PurchaseDraft;
  onDraft: (d: PurchaseDraft) => void;
  vendor: Supplier | null;
  onVendor: (s: Supplier | null) => void;
  taxOff: boolean;
  disabled?: boolean;
}) {
  const tr = useTr();
  const set = (p: Partial<PurchaseDraft>) => onDraft({ ...draft, ...p });
  const repsQ = useRepsLite(draft.mode === 'CASH' && draft.paidFrom === 'REP_CUSTODY');
  const pickMode = (m: PurchasePaymentMode) => set({ mode: draft.mode === m ? null : m });
  return (
    <div className="space-y-3">
      <div>
        <label className="label">{draft.mode ? tr('المورد') : tr('المورد اختياري')}</label>
        <SupplierPicker value={vendor} onChange={onVendor} disabled={disabled} />
        {vendor && <VendorFacts vendor={vendor} taxOff={taxOff} showVatHint={!!draft.mode} />}
      </div>

      <div>
        <label className="label">{tr('نوع الشراء')}</label>
        <div className="grid grid-cols-2 gap-2">
          {PURCHASE_MODES.map(m => {
            const on = draft.mode === m;
            return (
              <button key={m} type="button" aria-pressed={on} disabled={disabled} onClick={() => pickMode(m)}
                className={`py-2 rounded-xl border text-sm font-semibold flex items-center justify-center gap-2 ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] text-[#6E6557] hover:border-[#E15A30]/40'}`}>
                {m === 'CASH' ? <Banknote size={15} /> : <CalendarClock size={15} />} {tr(PURCHASE_MODE_LABELS[m])}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-[#9A8F7E] mt-1">
          {draft.mode === 'CASH' ? tr('يسجل سند صرف للمورد بكامل قيمة الفاتورة')
            : draft.mode === 'CREDIT' ? tr('تضاف قيمة الفاتورة إلى المستحق للمورد حتى تسدد')
              : tr('بلا اختيار يسجل وارد غير مصنف ويمكن تصنيفه لاحقا من السجل')}
        </p>
      </div>

      {draft.mode && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">{tr('رقم فاتورة المورد')}</label>
              <input className="input" dir="ltr" maxLength={SUPPLIER_REF_MAX} value={draft.supplierRef} disabled={disabled}
                onChange={e => set({ supplierRef: e.target.value })} placeholder={tr('اختياري')} />
            </div>
            <div>
              <label className="label">{tr('تاريخ فاتورة المورد')}</label>
              <input type="date" className="input" value={draft.billDate} disabled={disabled} onChange={e => set({ billDate: e.target.value })} />
            </div>
          </div>

          {draft.mode === 'CASH' && (
            <div>
              <label className="label">{tr('مدفوع من')}</label>
              <div className="grid grid-cols-3 gap-2">
                {PAID_FROM_OPTIONS.map(p => {
                  const Icon = PAID_ICON[p];
                  const on = draft.paidFrom === p;
                  return (
                    <button key={p} type="button" aria-pressed={on} disabled={disabled} onClick={() => set({ paidFrom: p })}
                      className={`py-2 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1.5 ${on ? 'border-[#1E7A52] bg-green-50 text-[#1E7A52]' : 'border-[#E9E1D3] text-[#6E6557]'}`}>
                      <Icon size={14} /> {tr(PAID_FROM_LABELS[p])}
                    </button>
                  );
                })}
              </div>
              {draft.paidFrom === 'REP_CUSTODY' && (
                <select className="input mt-2" value={draft.paidFromRepId} disabled={disabled} aria-label={tr('المندوب')}
                  onChange={e => set({ paidFromRepId: e.target.value })}>
                  <option value="">{repsQ.isLoading ? tr('جار التحميل') : tr('اختر المندوب الذي دفع من عهدته')}</option>
                  {(repsQ.data ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** ما يلزم معرفته عن المورّد المختار: مدة سداده ورقمه الضريبي ورصيده — وتنبيه مورّدٍ بلا رقم ضريبي في الشراء المصنَّف */
function VendorFacts({ vendor, taxOff, showVatHint }: { vendor: Supplier; taxOff: boolean; showVatHint: boolean }) {
  const tr = useTr();
  const facts: string[] = [];
  if (vendor.paymentDays != null && vendor.paymentDays > 0) facts.push(`${tr('مدة السداد')} ${vendor.paymentDays} ${tr('يوم')}`);
  if (vendor.vatNumber) facts.push(`${tr('الرقم الضريبي')} ${vendor.vatNumber}`);
  if (typeof vendor.balance === 'number' && Math.abs(vendor.balance) > 1e-9) {
    facts.push(`${vendor.balance > 0 ? tr('مستحق له') : tr('رصيد مدين له')} ${formatCurrency(Math.abs(vendor.balance))}`);
  }
  return (
    <>
      {facts.length > 0 && <p className="text-[11px] text-[#9A8F7E] mt-1">{facts.join(' · ')}</p>}
      {showVatHint && !taxOff && !vendor.vatNumber && (
        <p className="text-[11px] text-amber-700 mt-1 flex items-center gap-1">
          <Info size={12} className="shrink-0" /> {tr('المورد بلا رقم ضريبي تأكد من نسبة الضريبة في فاتورته')}
        </p>
      )}
    </>
  );
}
