import { useState } from 'react';
import { Ban, CalendarClock, Filter, Tags, Undo2, X } from 'lucide-react';
import type { Supplier } from '../api/suppliers';
import { useTr } from '../i18n/strings';
import { formatCurrency, formatDayOnly } from '../utils/format';
import { PAID_FROM_LABELS, PURCHASE_MODE_LABELS } from '../components/purchases/purchaseCalc';
import { MSupplierField } from './MPurchaseSupplier';
import { ENTRY_TYPE_FILTERS, ENTRY_TYPE_FILTER_LABELS, type MEntryFacts, type MEntryTypeFilter } from './MPurchaseLogic';
import { useMTaxOff } from './mTaxMode';

/*
 * سجلّ «مخزون الشركة» على الجوال بحقول الشراء («ربط الدفاتر» L1، طلب المالك ١٣ نوفمبر ٢٠٢٦) — نظير EntryPurchaseInfo في اللوحة:
 * نوع الشراء ومصدر دفعه، ورقم فاتورة المورّد وتاريخها، والصافي والضريبة والإجمالي، وللآجل الاستحقاق والمتبقّي، والحالة (ملغاة/عليها
 * مرتجع)، وسبب التسوية — وأزرار «تصنيف» و«مرتجع للمورد» و«إلغاء الحركة». الوقائع من entryFacts (MPurchaseLogic)، وخادمٌ أقدم لا
 * يرسل حالة الحركة ⇒ لا شيء من هذا يُرسم (الصفّ كما كان). كل ذكرٍ للضريبة خلف `!taxOff &&`.
 */

const chip = 'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold';

export function MEntryPurchaseInfo({ f, repName }: {
  f: MEntryFacts;
  /** اسم المندوب لوسم «عهدة مندوب» */
  repName: (id: string) => string | null;
}) {
  const tr = useTr();
  const taxOff = useMTaxOff();
  const paidLabel = f.paidFrom
    ? `${tr(PAID_FROM_LABELS[f.paidFrom.kind])}${f.paidFrom.kind === 'REP_CUSTODY' && f.paidFrom.repId ? ` · ${repName(f.paidFrom.repId) ?? ''}` : ''}`
    : null;
  const chips = [
    f.cancelled && <span key="c" className={`${chip} text-[#C0392B] bg-[#FDECEA]`}>{tr('ملغاة')}</span>,
    !f.cancelled && f.returned && <span key="r" className={`${chip} text-[#8A6D1F] bg-[#FDF6E7]`}>{tr('عليها مرتجع')}</span>,
    f.mode && (
      <span key="m" className={`${chip} ${f.mode === 'CASH' ? 'text-[#2F855A] bg-[#EAF6F0]' : 'text-[#2B6CB0] bg-[#EBF4FF]'}`}>
        {tr(PURCHASE_MODE_LABELS[f.mode])}{f.mode === 'CASH' && paidLabel ? ` · ${paidLabel}` : ''}
      </span>
    ),
    f.unclassified && <span key="u" className={`${chip} text-[#5A6270] bg-[#EEF0F3]`}>{tr('غير مصنف')}</span>,
    f.opening && <span key="o" className={`${chip} text-[#5A6270] bg-[#EEF0F3]`}>{tr('مخزون افتتاحي')}</span>,
    f.api && <span key="a" className={`${chip} text-[#4C51BF] bg-[#EEF0FF]`}>{tr('الربط البرمجي')}</span>,
    f.reason && <span key="s" className={`${chip} text-[#6B46C1] bg-[#F3EEFB]`}>{tr(f.reason)}</span>,
  ].filter(Boolean);

  if (!chips.length && !f.supplierRef && !f.billDay && !f.showTotals) return null;
  return (
    <div className="px-3.5 pb-2.5 -mt-1.5 space-y-1">
      {(chips.length > 0 || f.supplierRef || f.billDay) && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[#6E6557]">
          {chips}
          {f.supplierRef && (
            <span>{f.kind === 'RETURN' ? tr('إشعار المورد') : tr('فاتورة المورد')} <b dir="ltr" className="text-[#1F1A13]">{f.supplierRef}</b></span>
          )}
          {f.billDay && <span>{formatDayOnly(f.billDay)}</span>}
        </div>
      )}
      {f.showTotals && (
        <p className="text-[11px] text-[#6E6557] flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {!taxOff && <span>{tr('الصافي')} <b className="text-[#1F1A13] tabular-nums">{formatCurrency(f.net)}</b></span>}
          {!taxOff && <span>{tr('الضريبة')} <b className="text-[#1F1A13] tabular-nums">{formatCurrency(f.tax)}</b></span>}
          <span>{f.kind === 'RETURN' ? tr('إجمالي المرتجع') : tr('الإجمالي')} <b className="text-[#1F1A13] tabular-nums">{formatCurrency(f.total)}</b></span>
          {f.mode === 'CREDIT' && f.dueDay && !f.cancelled && (
            <span className={`inline-flex items-center gap-0.5 ${f.overdue ? 'text-[#C0392B] font-bold' : ''}`}>
              <CalendarClock size={11} /> {tr('يستحق')} {formatDayOnly(f.dueDay)}
            </span>
          )}
          {f.mode === 'CREDIT' && f.outstanding != null && !f.cancelled && (
            f.outstanding > 1e-9
              ? <span className={f.overdue ? 'text-[#C0392B] font-bold' : 'text-[#8A6D1F]'}>{tr('المتبقي')} <b className="tabular-nums">{formatCurrency(f.outstanding)}</b></span>
              : <span className="text-[#2F855A] font-bold">{tr('مسددة')}</span>
          )}
        </p>
      )}
    </div>
  );
}

/** أزرار أفعال الصفّ (entryActions) — هدف لمسٍ ٤٠px كأزرار الصفّ القائمة، ولا شيء حين لا فعل */
export function MEntryActions({ acts, onClassify, onReturn, onCancel }: {
  acts: { classify: boolean; ret: boolean; cancel: boolean };
  onClassify: () => void;
  onReturn: () => void;
  onCancel: () => void;
}) {
  const tr = useTr();
  if (!acts.classify && !acts.ret && !acts.cancel) return null;
  const btn = 'min-h-[40px] px-3 rounded-xl border bg-white text-[12px] font-bold flex items-center gap-1.5 whitespace-nowrap';
  return (
    <div className="px-3.5 pb-3 flex flex-wrap items-center gap-2">
      {acts.classify && (
        <button type="button" onClick={onClassify} className={`${btn} border-[#F3C9B8] text-[#E15A30] active:bg-[#FBEBE2]`}>
          <Tags size={14} /> {tr('تصنيف')}
        </button>
      )}
      {acts.ret && (
        <button type="button" onClick={onReturn} className={`${btn} border-[#F0E0B8] text-[#8A6D1F] active:bg-[#FDF6E7]`}>
          <Undo2 size={14} /> {tr('مرتجع للمورد')}
        </button>
      )}
      {acts.cancel && (
        <button type="button" onClick={onCancel} className={`${btn} border-[#F5C6C0] text-[#C0392B] active:bg-[#FDF2F0]`}>
          <Ban size={14} /> {tr('إلغاء الحركة')}
        </button>
      )}
    </div>
  );
}

/** فلتر السجلّ: نوع الحركة (ومنه «مرتجع للمورد») وزرّ المورّد (ومنه المؤرشف) — يُطوى خلف زرّ «تصفية» فلا يزحم الشاشة */
export function MEntriesFilter({ vendor, onVendor, type, onType }: {
  vendor: Supplier | null; onVendor: (s: Supplier | null) => void; type: MEntryTypeFilter; onType: (t: MEntryTypeFilter) => void;
}) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  const active = !!vendor || type !== '';
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 overflow-x-auto -mx-1 px-1 pb-0.5">
        {ENTRY_TYPE_FILTERS.map(t => {
          const on = type === t;
          return (
            <button key={t || 'all'} type="button" aria-pressed={on} onClick={() => onType(t)}
              className={`min-h-[36px] px-3 rounded-full border text-[11px] font-bold whitespace-nowrap flex-shrink-0 ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white text-[#6E6557]'}`}>
              {tr(ENTRY_TYPE_FILTER_LABELS[t])}
            </button>
          );
        })}
        <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)}
          className={`min-h-[36px] px-3 rounded-full border text-[11px] font-bold whitespace-nowrap flex-shrink-0 flex items-center gap-1 ${vendor ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white text-[#6E6557]'}`}>
          <Filter size={12} /> {vendor ? vendor.name : tr('كل الموردين')}
        </button>
        {active && (
          <button type="button" onClick={() => { onVendor(null); onType(''); setOpen(false); }} aria-label={tr('مسح الفلاتر')}
            className="min-h-[36px] w-9 rounded-full border border-[#E9E1D3] bg-white text-[#9A8F7E] flex items-center justify-center flex-shrink-0">
            <X size={14} />
          </button>
        )}
      </div>
      {open && (
        <div className="bg-white rounded-2xl border border-[#F1EBDF] p-3">
          <MSupplierField value={vendor} onChange={s => { onVendor(s); setOpen(false); }} quickAdd={false} status="all" placeholder={tr('كل الموردين')} />
        </div>
      )}
    </div>
  );
}
