import { Filter } from 'lucide-react';
import type { Supplier } from '../../api/suppliers';
import { useTr } from '../../i18n/strings';
import SupplierPicker from './SupplierPicker';

export type EntryTypeFilter = '' | 'RECEIVE' | 'ADJUST' | 'RETURN';

/** فلتر السجلّ: المورّد (ومنه المؤرشف) ونوع الحركة ومنه «مرتجع للمورد» */
export function EntriesFilterBar({ vendor, onVendor, type, onType }: {
  vendor: Supplier | null; onVendor: (s: Supplier | null) => void; type: EntryTypeFilter; onType: (t: EntryTypeFilter) => void;
}) {
  const tr = useTr();
  return (
    <div className="flex flex-wrap items-center gap-2 font-normal">
      <Filter size={13} className="text-[#9A8F7E]" aria-hidden />
      <div className="w-48">
        <SupplierPicker value={vendor} onChange={onVendor} quickAdd={false} status="all" placeholder={tr('كل الموردين')} compact />
      </div>
      <select className="input w-auto py-1.5 text-xs" value={type} aria-label={tr('نوع الحركة')} onChange={ev => onType(ev.target.value as EntryTypeFilter)}>
        <option value="">{tr('كل الحركات')}</option>
        <option value="RECEIVE">{tr('وارد')}</option>
        <option value="ADJUST">{tr('تسوية')}</option>
        <option value="RETURN">{tr('مرتجع للمورد')}</option>
      </select>
    </div>
  );
}
