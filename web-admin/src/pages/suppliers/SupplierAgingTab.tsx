import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet } from 'lucide-react';
import toast from 'react-hot-toast';
import { suppliersApi, type SupplierAging } from '../../api/suppliers';
import { currencyDecimals } from '../../i18n/countries';
import { useTr } from '../../i18n/strings';
import { localDay } from '../../lib/paymentMethods';
import { exportExcel } from '../../utils/excel';
import { formatCurrency, formatDayOnly, getActiveCurrency } from '../../utils/format';
import { AGING_COLUMNS, agingHasUnapplied, agingRows, agingSheet, isValidDay, safeFileName, toCsv } from './supplierLogic';

/** خلية مبلغ: الصفر رماديّ خافت (الشرائح الفارغة كثيرة فتُقرأ المملوءة بعينها) */
function AmountTd({ v, strong, tone }: { v: number; strong?: boolean; tone?: string }) {
  const zero = Math.round((Number(v) || 0) * 1000) === 0;
  return <td className={`tabular-nums ${zero ? 'text-gray-300' : tone ?? 'text-[#1F1A13]'} ${strong ? 'font-bold' : ''}`}>{formatCurrency(v)}</td>;
}

/**
 * «أعمار ذمم الموردين» لكل الموردين حتى تاريخٍ (الافتراضي اليوم): متبقّي الفواتير المفتوحة بشرائح التأخير عن الاستحقاق
 * (غير مستحقة، ١–٣٠، ٣١–٦٠، ٦١–٩٠، أكثر من ٩٠)، والإجمالي. وحين يكون للمورّد ما ليس على فاتورة (دفعة مقدّمة أو افتتاحي)
 * يظهر عمودا «غير مخصص» و«رصيد الحساب» فيطابق التقريرُ كشفَ كل مورّد بفرق صفر. التصدير Excel وCSV.
 */
export default function SupplierAgingTab({ onOpenSupplier }: { onOpenSupplier: (id: string) => void }) {
  const tr = useTr();
  const [asOf, setAsOf] = useState(() => localDay());
  const valid = isValidDay(asOf);
  const agingQ = useQuery({
    queryKey: ['supplier-aging', asOf],
    queryFn: async () => (await suppliersApi.aging(asOf)).data.data as SupplierAging,
    enabled: valid,
    placeholderData: keepPreviousData,
  });
  const a = agingQ.data;
  const withUnapplied = a ? agingHasUnapplied(a) : false;
  const decimals = currencyDecimals(getActiveCurrency());
  const fileBase = () => safeFileName(`${tr('أعمار ذمم الموردين')} ${a?.asOf ?? asOf}`);

  const exportXlsx = async () => {
    if (!a) return;
    try {
      await exportExcel([agingSheet(a, { tr, decimals })], fileBase());
      toast.success(tr('تم التصدير'));
    } catch { toast.error(tr('تعذر إنشاء الملف حاول مجددا')); }
  };
  const exportCsv = () => {
    if (!a) return;
    const blob = new Blob([toCsv(agingRows(a, { tr, decimals }))], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = url; el.download = `${fileBase()}.csv`;
    document.body.appendChild(el); el.click(); el.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast.success(tr('تم التصدير'));
  };

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex gap-3 flex-wrap items-end">
          <div>
            <label className="label">{tr('حتى تاريخ')}</label>
            <input type="date" className="input w-40" value={asOf} onChange={e => setAsOf(e.target.value || localDay())} />
          </div>
          <div className="flex gap-2 flex-wrap ms-auto">
            <button className="btn-secondary" onClick={exportXlsx} disabled={!a}><FileSpreadsheet size={15} /> {tr('تصدير Excel')}</button>
            <button className="btn-secondary" onClick={exportCsv} disabled={!a}><Download size={15} /> {tr('تصدير CSV')}</button>
          </div>
        </div>
        <p className="text-[11px] text-[#9A8F7E] mt-2">{tr('متبقي فواتير الموردين الآجلة موزعا على أيام التأخير عن تاريخ الاستحقاق')}</p>
      </div>

      {agingQ.isPending ? (
        <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل')}</div>
      ) : agingQ.isError || !a ? (
        <div className="card flex flex-col items-center gap-3 py-10 text-gray-500">
          <span>{tr('تعذر تحميل أعمار الذمم')}</span>
          <button onClick={() => agingQ.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            {AGING_COLUMNS.map(c => (
              <div key={c.key} className="card text-center">
                <p className="text-xs text-gray-500">{tr(c.label)}</p>
                <p className={`text-lg font-bold tabular-nums mt-0.5 ${c.key === 'current' ? 'text-green-700' : c.key === 'd90_plus' ? 'text-red-700' : 'text-[#1F1A13]'}`}>{formatCurrency(a.totals[c.key])}</p>
              </div>
            ))}
            <div className="card text-center bg-[#FBEBE2] border-[#F3C9B6]">
              <p className="text-xs text-[#C94E28]">{tr('الإجمالي')}</p>
              <p className="text-lg font-bold tabular-nums mt-0.5 text-[#C94E28]">{formatCurrency(a.totals.total)}</p>
            </div>
          </div>

          <div className="card p-0">
            <div className="px-5 py-3 border-b border-[#F1EBDF] text-sm text-[#6E6557]">
              {tr('حتى تاريخ')} <b className="text-[#1F1A13]">{formatDayOnly(a.asOf)}</b> · {a.rows.length} {tr('مورد')}
            </div>
            {a.rows.length === 0 ? (
              <div className="text-center text-gray-400 text-sm py-10">{tr('لا ذمم مستحقة للموردين في هذا التاريخ')}</div>
            ) : (
              <div className="table-wrapper">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{tr('المورد')}</th>
                      {AGING_COLUMNS.map(c => <th key={c.key}>{tr(c.label)}</th>)}
                      <th>{tr('إجمالي الفواتير المفتوحة')}</th>
                      {withUnapplied && <th title={tr('دفعات مقدمة أو أرصدة ليست على فاتورة')}>{tr('غير مخصص')}</th>}
                      {withUnapplied && <th>{tr('رصيد الحساب')}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {a.rows.map(r => (
                      <tr key={r.supplierId}>
                        <td>
                          <button type="button" className="font-semibold text-[#C94E28] hover:underline text-start" onClick={() => onOpenSupplier(r.supplierId)}>{r.name}</button>
                          {(r.code || r.isActive === false) && (
                            <span className="block text-[11px] text-[#9A8F7E]">{r.code ?? ''}{r.isActive === false ? ` ${tr('مؤرشف')}` : ''}</span>
                          )}
                        </td>
                        {AGING_COLUMNS.map(c => <AmountTd key={c.key} v={r[c.key]} tone={c.key === 'd90_plus' ? 'text-red-700 font-semibold' : c.key === 'current' ? 'text-green-700' : undefined} />)}
                        <AmountTd v={r.total} strong />
                        {withUnapplied && <AmountTd v={r.unapplied ?? 0} tone="text-amber-700" />}
                        {withUnapplied && <AmountTd v={r.balance ?? 0} strong />}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-[#F1EBDF]/60 font-bold">
                      <td>{tr('الإجمالي')}</td>
                      {AGING_COLUMNS.map(c => <AmountTd key={c.key} v={a.totals[c.key]} strong />)}
                      <AmountTd v={a.totals.total} strong />
                      {withUnapplied && <AmountTd v={a.totals.unapplied ?? 0} strong tone="text-amber-700" />}
                      {withUnapplied && <AmountTd v={a.totals.balance ?? 0} strong />}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
          {withUnapplied && (
            <p className="text-[11px] text-[#9A8F7E]">{tr('غير المخصص هو الفرق بين رصيد الحساب والفواتير المفتوحة والسالب منه دفعة مقدمة للمورد')}</p>
          )}
        </>
      )}
    </div>
  );
}
