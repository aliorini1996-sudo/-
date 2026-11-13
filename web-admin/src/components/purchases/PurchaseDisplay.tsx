import { Ban, Banknote, CalendarClock, Tags, Undo2 } from 'lucide-react';
import type { PurchasePaidFrom, PurchasePaymentMode, WarehouseAdjustReason } from '../../api/client';
import { useTr } from '../../i18n/strings';
import { formatCurrency, formatDayOnly } from '../../utils/format';
import {
  adjustReasonLabel, dayOf, paidFromOf, ADJUST_REASON_LABELS, PAID_FROM_LABELS, PURCHASE_MODE_LABELS, WAREHOUSE_ADJUST_REASONS, type BillTotals,
} from './purchaseCalc';
import type { PurchaseEntry } from './purchaseTypes';

/*
 * مكوّنات عرضٍ صرفة للشراء في «مخزون الشركة» («ربط الدفاتر» L1) — بلا طلب شبكة ولا استيرادٍ وقت التشغيل لطبقة الـAPI، فتُرسم
 * في الاختبار: ملخّص الفاتورة الحيّ، وخانة نسبة ضريبة السطر، وسبب التسوية، وسطر الشراء في السجلّ وأفعاله.
 *
 * سطر السجلّ: نوع الشراء ومصدر دفعه، ورقم فاتورة المورّد وتاريخها، والصافي والضريبة والإجمالي، وللآجل الاستحقاق والمتبقّي،
 * والحالة (ملغاة/عليها مرتجع)، وسبب التسوية — وأفعال «تصنيف» و«مرتجع للمورد» و«إلغاء الحركة». خادمٌ أقدم لا يرسل status ⇒
 * لا شيء من هذا يُعرض (الصفّ كما كان). «إزالة الضريبة»: لا صافي ولا ضريبة — الإجمالي وحده.
 */

const chip = 'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold border';

export function EntryPurchaseInfo({ e, taxOff, returned, repName }: {
  e: PurchaseEntry;
  taxOff: boolean;
  /** في السجلّ حركة مرتجع تابعة لهذا الوارد */
  returned: boolean;
  repName: (id: string) => string | null;
}) {
  const tr = useTr();
  if (e.status == null) return null;
  const mode = e.paymentMode === 'CASH' || e.paymentMode === 'CREDIT' ? e.paymentMode : null;
  const pf = paidFromOf(e.paidAccountRef);
  const reason = e.type === 'ADJUST' ? adjustReasonLabel(e.reason) : null;
  const billDay = dayOf(e.billDate);
  const dueDay = dayOf(e.dueDate);
  const cancelled = e.status === 'CANCELLED';
  // المبالغ للمصنَّف وللمرتجع وحدهما — الوارد غير المصنَّف يبقى بسطر «قيمة البضاعة» القائم
  const showTotals = typeof e.total === 'number' && (mode !== null || e.type === 'RETURN');
  const outstanding = typeof e.outstanding === 'number' ? e.outstanding : null;
  const today = new Date().toLocaleDateString('en-CA');
  const overdue = mode === 'CREDIT' && !cancelled && outstanding != null && outstanding > 1e-9 && !!dueDay && dueDay < today;
  const paidLabel = pf ? `${tr(PAID_FROM_LABELS[pf.kind])}${pf.kind === 'REP_CUSTODY' && pf.repId ? ` · ${repName(pf.repId) ?? ''}` : ''}` : null;

  const chips = [
    cancelled && <span key="c" className={`${chip} text-red-700 bg-red-50 border-red-200`}>{tr('ملغاة')}</span>,
    !cancelled && returned && <span key="r" className={`${chip} text-amber-700 bg-amber-50 border-amber-200`}>{tr('عليها مرتجع')}</span>,
    e.type === 'RECEIVE' && mode && (
      <span key="m" className={`${chip} ${mode === 'CASH' ? 'text-[#1E7A52] bg-green-50 border-green-200' : 'text-sky-700 bg-sky-50 border-sky-200'}`}>
        {tr(PURCHASE_MODE_LABELS[mode])}{mode === 'CASH' && paidLabel ? ` · ${paidLabel}` : ''}
      </span>
    ),
    e.type === 'RECEIVE' && !mode && e.source !== 'OPENING_IMPORT' && (
      <span key="u" className={`${chip} text-slate-600 bg-slate-50 border-slate-200`} title={tr('لم يحدد المورد ونوع الشراء صنفه من زر تصنيف')}>{tr('غير مصنف')}</span>
    ),
    e.source === 'OPENING_IMPORT' && <span key="o" className={`${chip} text-slate-600 bg-slate-50 border-slate-200`}>{tr('مخزون افتتاحي')}</span>,
    e.source === 'API' && <span key="a" className={`${chip} text-indigo-700 bg-indigo-50 border-indigo-200`}>{tr('الربط البرمجي')}</span>,
    reason && <span key="s" className={`${chip} text-purple-700 bg-purple-50 border-purple-200`}>{tr(reason)}</span>,
  ].filter(Boolean);

  const ref = e.supplierRef || billDay;
  if (!chips.length && !ref && !showTotals) return null;
  return (
    <div className="mt-1.5 space-y-1">
      {(chips.length > 0 || ref) && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[#6E6557]">
          {chips}
          {e.supplierRef && <span>{e.type === 'RETURN' ? tr('إشعار المورد') : tr('فاتورة المورد')} <b dir="ltr" className="text-[#1F1A13]">{e.supplierRef}</b></span>}
          {billDay && <span>{formatDayOnly(billDay)}</span>}
        </div>
      )}
      {showTotals && (
        <p className="text-[11px] text-[#6E6557] flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {!taxOff && <span>{tr('الصافي')} <b className="text-[#1F1A13]">{formatCurrency(Math.abs(e.net ?? 0))}</b></span>}
          {!taxOff && <span>{tr('الضريبة')} <b className="text-[#1F1A13]">{formatCurrency(Math.abs(e.tax ?? 0))}</b></span>}
          <span>{e.type === 'RETURN' ? tr('إجمالي المرتجع') : tr('الإجمالي')} <b className="text-[#1F1A13]">{formatCurrency(Math.abs(e.total ?? 0))}</b></span>
          {mode === 'CREDIT' && dueDay && !cancelled && (
            <span className={`inline-flex items-center gap-0.5 ${overdue ? 'text-red-600 font-semibold' : ''}`}>
              <CalendarClock size={11} /> {tr('يستحق')} {formatDayOnly(dueDay)}
            </span>
          )}
          {mode === 'CREDIT' && outstanding != null && !cancelled && (
            outstanding > 1e-9
              ? <span className={overdue ? 'text-red-600 font-semibold' : 'text-amber-700'}>{tr('المتبقي')} <b>{formatCurrency(outstanding)}</b></span>
              : <span className="text-[#1E7A52] font-semibold">{tr('مسددة')}</span>
          )}
        </p>
      )}
    </div>
  );
}

/** أفعال الصفّ — تظهر لمن يسجّل حركات المستودع وحده (entryActions) */
export function EntryPurchaseActions({ acts, onClassify, onReturn, onCancel }: {
  acts: { classify: boolean; ret: boolean; cancel: boolean };
  onClassify: () => void;
  onReturn: () => void;
  onCancel: () => void;
}) {
  const tr = useTr();
  if (!acts.classify && !acts.ret && !acts.cancel) return null;
  const btn = 'inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold whitespace-nowrap';
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {acts.classify && (
        <button type="button" onClick={onClassify} className={`${btn} border-[#E9E1D3] text-[#E15A30] hover:bg-[#FBEBE2]`}>
          <Tags size={12} /> {tr('تصنيف')}
        </button>
      )}
      {acts.ret && (
        <button type="button" onClick={onReturn} className={`${btn} border-[#E9E1D3] text-amber-700 hover:bg-amber-50`}>
          <Undo2 size={12} /> {tr('مرتجع للمورد')}
        </button>
      )}
      {acts.cancel && (
        <button type="button" onClick={onCancel} className={`${btn} border-[#E9E1D3] text-[#C0392B] hover:bg-red-50`}>
          <Ban size={12} /> {tr('إلغاء الحركة')}
        </button>
      )}
    </div>
  );
}

/** رأس عمود نسبة ضريبة السطر في نافذة الاستلام */
export function LineTaxHeader() {
  const tr = useTr();
  return <span className="w-16 text-center">{tr('الضريبة %')}</span>;
}

/** خانة نسبة ضريبة السطر (افتراضها ضريبة الصنف) */
export function LineTaxInput({ value, onChange, invalid = false, disabled = false }: { value: string; onChange: (v: string) => void; invalid?: boolean; disabled?: boolean }) {
  const tr = useTr();
  return (
    <input type="number" step="any" min="0" max="100" inputMode="decimal" value={value} disabled={disabled}
      onChange={e => onChange(e.target.value)} aria-label={tr('نسبة ضريبة السطر')} title={tr('نسبة ضريبة السطر')}
      className={`input w-16 py-1.5 text-center ${invalid ? 'border-red-400 bg-red-50/40' : ''}`} placeholder="%" />
  );
}

/** ملخّص الشراء الحيّ: الصافي والضريبة والإجمالي بتقريب الخادم، والاستحقاق للآجل ومصدر الدفع للنقدي */
export function PurchaseSummary({ totals, taxOff, mode, dueDate, paidFrom, repName, paymentDays, title }: {
  totals: BillTotals;
  taxOff: boolean;
  mode: PurchasePaymentMode | null;
  dueDate?: string | null;
  paidFrom?: PurchasePaidFrom;
  repName?: string | null;
  paymentDays?: number | null;
  /** عنوان الإجمالي — «إجمالي فاتورة المورد» افتراضاً، و«إجمالي المرتجع» في نافذته */
  title?: string;
}) {
  const tr = useTr();
  const row = (label: string, value: string, strong = false) => (
    <div className={`flex items-center justify-between ${strong ? 'text-sm' : 'text-xs'}`}>
      <span className="text-[#6E6557]">{label}</span>
      {strong ? <b className="text-[#1F1A13]">{value}</b> : <span className="text-[#1F1A13]">{value}</span>}
    </div>
  );
  return (
    <div className="space-y-1">
      {!taxOff && row(tr('الصافي قبل الضريبة'), formatCurrency(totals.net))}
      {!taxOff && row(tr('ضريبة المشتريات'), formatCurrency(totals.tax))}
      {row(tr(title ?? 'إجمالي فاتورة المورد'), formatCurrency(totals.total), true)}
      {mode === 'CREDIT' && dueDate && (
        <p className="text-[11px] text-[#6E6557] flex items-center gap-1">
          <CalendarClock size={12} className="text-[#E15A30]" /> {tr('تاريخ الاستحقاق')} <b className="text-[#1F1A13]">{formatDayOnly(dueDate)}</b>
          {paymentDays != null && paymentDays > 0 ? <span>({paymentDays} {tr('يوم')})</span> : <span>· {tr('بلا مدة سداد مستحقة في تاريخ الفاتورة')}</span>}
        </p>
      )}
      {mode === 'CASH' && paidFrom && (
        <p className="text-[11px] text-[#6E6557] flex items-center gap-1">
          <Banknote size={12} className="text-[#1E7A52]" /> {tr('يصرف كامل المبلغ من')} <b className="text-[#1F1A13]">{tr(PAID_FROM_LABELS[paidFrom])}{paidFrom === 'REP_CUSTODY' && repName ? ` · ${repName}` : ''}</b>
        </p>
      )}
    </div>
  );
}

/** «سبب التسوية» — جرد/تالف/منتهي الصلاحية/عينات/أخرى؛ اختياريّ (الضغط على المختار يلغيه) فلا يتغيّر حفظ من لا يختار */
export function AdjustReasonSelect({ value, onChange, disabled = false }: {
  value: WarehouseAdjustReason | ''; onChange: (v: WarehouseAdjustReason | '') => void; disabled?: boolean;
}) {
  const tr = useTr();
  return (
    <div>
      <label className="label">{tr('سبب التسوية')}</label>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={tr('سبب التسوية')}>
        {WAREHOUSE_ADJUST_REASONS.map(r => {
          const on = value === r;
          return (
            <button key={r} type="button" aria-pressed={on} disabled={disabled} onClick={() => onChange(on ? '' : r)}
              className={`px-3 py-1.5 rounded-lg border text-xs font-semibold ${on ? 'border-purple-500 bg-purple-50 text-purple-700' : 'border-[#E9E1D3] text-[#6E6557] hover:border-purple-300'}`}>
              {tr(ADJUST_REASON_LABELS[r])}
            </button>
          );
        })}
      </div>
    </div>
  );
}
