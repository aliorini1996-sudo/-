import { useQuery } from '@tanstack/react-query';
import { Banknote, Eye } from 'lucide-react';
import { suppliersApi, type OpenBill, type Supplier } from '../../api/suppliers';
import { useTr } from '../../i18n/strings';
import type { Company } from '../../rep/RepDocuments';
import { formatCurrency, formatDayOnly } from '../../utils/format';
import { overdueSummary } from './supplierLogic';
import { useEntryNotice } from './useEntryNotice';

/** شارة التأخير: «متأخرة N يوم» بالأحمر، و«تستحق اليوم»، و«غير مستحقة» */
function DueBadge({ b, tr }: { b: OpenBill; tr: (s: string) => string }) {
  if (b.daysOverdue > 0) {
    const tone = b.daysOverdue > 90 ? 'bg-red-100 text-red-800 border-red-200' : b.daysOverdue > 30 ? 'bg-red-50 text-red-700 border-red-200' : 'bg-amber-50 text-amber-800 border-amber-200';
    return <span className={`inline-block rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${tone}`}>{tr('متأخرة')} {b.daysOverdue} {tr('يوم')}</span>;
  }
  return <span className="inline-block rounded-md border border-green-200 bg-green-50 px-1.5 py-0.5 text-[11px] font-semibold text-green-700">{tr('غير مستحقة بعد')}</span>;
}

/**
 * «الفواتير المفتوحة» للمورّد: فواتيره الآجلة غير الملغاة التي بقي منها شيء، الأقدم استحقاقاً أولاً (ترتيب الخادم)، بالإجمالي
 * والمدفوع والمرتجع والمتبقّي وأيام التأخير. «سداد» يفتح سند صرفٍ مخصَّصاً لها بمتبقّيها.
 */
export default function SupplierBillsTab({ supplier, company, canEdit, onPay }: {
  supplier: Supplier; company: Company | null; canEdit: boolean; onPay: (bill: OpenBill | null) => void;
}) {
  const tr = useTr();
  const billsQ = useQuery({
    queryKey: ['supplier-open-bills', supplier.id],
    queryFn: async () => (await suppliersApi.openBills(supplier.id)).data.data as OpenBill[],
  });
  const notice = useEntryNotice(supplier.id, company);
  const bills = billsQ.data ?? [];
  const sum = overdueSummary(bills);

  if (billsQ.isPending) return <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل')}</div>;
  if (billsQ.isError) {
    return (
      <div className="card flex flex-col items-center gap-3 py-10 text-gray-500">
        <span>{tr('تعذر تحميل الفواتير المفتوحة')}</span>
        <button onClick={() => billsQ.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="card text-center">
          <p className="text-xs text-gray-500">{tr('متبقي الفواتير المفتوحة')}</p>
          <p className="text-xl font-bold tabular-nums text-[#1F1A13] mt-0.5">{formatCurrency(sum.total)}</p>
          <p className="text-[11px] text-gray-400 mt-0.5 tabular-nums">{bills.length} {tr('فاتورة')}</p>
        </div>
        <div className="card text-center">
          <p className="text-xs text-gray-500">{tr('المتأخر عن الاستحقاق')}</p>
          <p className={`text-xl font-bold tabular-nums mt-0.5 ${sum.count ? 'text-red-600' : 'text-gray-400'}`}>{formatCurrency(sum.outstanding)}</p>
          <p className="text-[11px] text-gray-400 mt-0.5 tabular-nums">{sum.count} {tr('فاتورة')}</p>
        </div>
        <div className="card flex items-center justify-center">
          {canEdit && (
            <button className="btn-primary" onClick={() => onPay(null)}><Banknote size={16} /> {tr('سند صرف جديد')}</button>
          )}
        </div>
      </div>

      <div className="card p-0">
        {bills.length === 0 ? (
          <div className="text-center text-gray-400 text-sm py-10">{tr('لا فواتير مفتوحة لهذا المورد')}</div>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>{tr('فاتورة المورد')}</th>
                  <th>{tr('تاريخ الفاتورة')}</th>
                  <th>{tr('تاريخ الاستحقاق')}</th>
                  <th>{tr('الإجمالي')}</th>
                  <th>{tr('المدفوع')}</th>
                  <th>{tr('المرتجع')}</th>
                  <th>{tr('المتبقي')}</th>
                  <th>{tr('الحالة')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {bills.map(b => (
                  <tr key={b.warehouseEntryId} className={b.daysOverdue > 0 ? 'bg-red-50/30' : undefined}>
                    <td className="font-medium">
                      <button type="button" className="text-[#C94E28] hover:underline" onClick={() => notice.open(b.warehouseEntryId)}>
                        {b.supplierRef ? <bdi>{b.supplierRef}</bdi> : tr('بلا رقم فاتورة')}
                      </button>
                    </td>
                    <td className="whitespace-nowrap">{formatDayOnly(b.billDate)}</td>
                    <td className="whitespace-nowrap">{formatDayOnly(b.dueDate)}</td>
                    <td className="tabular-nums">{formatCurrency(b.total)}</td>
                    <td className="tabular-nums text-green-700">{b.paid ? formatCurrency(b.paid) : '—'}</td>
                    <td className="tabular-nums text-[#6E6557]">{b.returned ? formatCurrency(b.returned) : '—'}</td>
                    <td className="tabular-nums font-bold">{formatCurrency(b.outstanding)}</td>
                    <td><DueBadge b={b} tr={tr} /></td>
                    <td>
                      <div className="flex items-center gap-1 justify-end">
                        <button type="button" title={tr('عرض الحركة')} className="p-1.5 rounded-lg hover:bg-[#F6F1E7] text-[#6E6557]" onClick={() => notice.open(b.warehouseEntryId)}>
                          <Eye size={15} />
                        </button>
                        {canEdit && (
                          <button type="button" className="btn-secondary !py-1 !px-2.5 text-xs" onClick={() => onPay(b)}>
                            <Banknote size={14} /> {tr('سداد')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {notice.modal}
    </div>
  );
}
