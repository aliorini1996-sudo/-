import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { customerApi } from '../../api/client';
import { Customer, AccountEntry } from '../../types';
import { formatCurrency, formatDate, formatNumber } from '../../utils/format';
import { useTr } from '../../i18n/strings';
import { X, Printer, Download } from 'lucide-react';
import { shareOrDownloadExcel, num } from '../../utils/excel';
import toast from 'react-hot-toast';

interface Props { customer: Customer; onClose: () => void; }

export default function CustomerStatementModal({ customer, onClose }: Props) {
  const tr = useTr();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['statement', customer.id, from, to],
    queryFn: async () => {
      const res = await customerApi.statement(customer.id, from && to ? { from, to } : undefined);
      return res.data.data as { customer: Customer; entries: AccountEntry[] };
    },
  });

  const handlePrint = () => window.print();

  // تصدير/مشاركة كشف الحساب إلى Excel (ورقة ملخص + ورقة حركات)
  const exportStatement = async () => {
    if (!data) return;
    const summary = [
      { [tr('البند')]: tr('العميل'), [tr('القيمة')]: customer.name },
      { [tr('البند')]: tr('الجوال'), [tr('القيمة')]: customer.phone },
      { [tr('البند')]: tr('إجمالي المبيعات'), [tr('القيمة')]: num(data.customer.totalSales) },
      { [tr('البند')]: tr('إجمالي التحصيل'), [tr('القيمة')]: num(data.customer.totalCollected) },
      { [tr('البند')]: tr('الرصيد الحالي'), [tr('القيمة')]: num(data.customer.balance) },
    ];
    const rows = data.entries.map(e => ({
      [tr('التاريخ')]: formatDate(e.entryDate),
      [tr('البيان')]: e.description,
      [tr('الأصناف')]: (e.invoice?.items || []).map(it => `${it.product.name} ×${Number(it.qty)}`).join('، '),
      [tr('رقم المستند')]: e.invoice?.number || e.receipt?.number || '-',
      [tr('مدين')]: num(e.debit),
      [tr('دائن')]: num(e.credit),
      [tr('الرصيد')]: num(e.balance),
    })) as Record<string, string | number>[];
    // صف الإجمالي أسفل الحركات: عدد الأصناف المباعة + مجموع المدين/الدائن + الرصيد
    if (data.entries.length) {
      const soldItems = data.entries.reduce((s, e) => s + (e.invoice?.items || []).reduce((a, it) => a + Number(it.qty), 0), 0);
      const totalDebit = data.entries.reduce((s, e) => s + Number(e.debit), 0);
      const totalCredit = data.entries.reduce((s, e) => s + Number(e.credit), 0);
      rows.push({
        [tr('التاريخ')]: tr('الإجمالي'), [tr('البيان')]: '',
        [tr('الأصناف')]: `${soldItems} ${tr('وحدة مباعة')}`,
        [tr('رقم المستند')]: '', [tr('مدين')]: num(totalDebit), [tr('دائن')]: num(totalCredit), [tr('الرصيد')]: num(data.customer.balance),
      });
    }
    const out = await shareOrDownloadExcel([
      { name: tr('الملخص'), rows: summary, colWidths: [18, 22] },
      { name: tr('الحركات'), rows, colWidths: [16, 30, 34, 16, 12, 12, 12] },
    ], `${tr('كشف حساب')}-${customer.name}-${new Date().toISOString().slice(0, 10)}`);
    toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم تصدير كشف الحساب'));
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-bold text-gray-800">{tr('كشف حساب')}</h2>
            <p className="text-sm text-gray-500">{customer.name} • {customer.phone}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportStatement} disabled={isLoading} className="btn-secondary"><Download size={15} />Excel</button>
            <button onClick={handlePrint} className="btn-secondary"><Printer size={15} />{tr('طباعة')}</button>
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex gap-3 p-4 border-b border-gray-100">
          <div>
            <label className="label">{tr('من')}</label>
            <input type="date" className="input w-36" value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="label">{tr('إلى')}</label>
            <input type="date" className="input w-36" value={to} onChange={e => setTo(e.target.value)} />
          </div>
        </div>

        {/* Balance Summary */}
        <div className="grid grid-cols-3 gap-4 p-4 bg-gray-50 border-b">
          <div className="text-center">
            <p className="text-xs text-gray-500">{tr('إجمالي المبيعات')}</p>
            <p className="font-bold text-[#E15A30]">{formatCurrency(data?.customer.totalSales ?? 0)}</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-gray-500">{tr('إجمالي التحصيل')}</p>
            <p className="font-bold text-green-600">{formatCurrency(data?.customer.totalCollected ?? 0)}</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-gray-500">{tr('الرصيد الحالي')}</p>
            <p className={`font-bold ${Number(data?.customer.balance) > 0 ? 'text-red-600' : 'text-green-600'}`}>
              {formatCurrency(data?.customer.balance ?? 0)}
            </p>
          </div>
        </div>

        {/* Entries */}
        <div className="flex-1 overflow-y-auto">
          <table className="table">
            <thead>
              <tr>
                <th>{tr('التاريخ')}</th><th>{tr('البيان')}</th><th>{tr('رقم المستند')}</th>
                <th>{tr('مدين')}</th><th>{tr('دائن')}</th><th>{tr('الرصيد')}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} className="text-center py-8 text-gray-400">{tr('جاري التحميل...')}</td></tr>
              ) : data?.entries.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-8 text-gray-400">{tr('لا توجد حركات')}</td></tr>
              ) : data?.entries.map(e => (
                <tr key={e.id}>
                  <td className="text-xs text-gray-500 align-top">{formatDate(e.entryDate)}</td>
                  <td className="text-sm text-gray-700 align-top">
                    {e.description}
                    {e.invoice?.items && e.invoice.items.length > 0 && (
                      <div className="text-[11px] text-gray-500 mt-1 leading-relaxed">
                        <span className="font-semibold text-gray-600">{e.invoice.items.length} {tr('صنف')}:</span>{' '}
                        {e.invoice.items.map(it => `${it.product.name} ×${Number(it.qty)}`).join('، ')}
                      </div>
                    )}
                  </td>
                  <td className="text-xs text-gray-400 font-mono align-top">
                    {e.invoice?.number || e.receipt?.number || '-'}
                  </td>
                  <td className="text-red-600 font-medium">{Number(e.debit) > 0 ? formatCurrency(e.debit) : '-'}</td>
                  <td className="text-green-600 font-medium">{Number(e.credit) > 0 ? formatCurrency(e.credit) : '-'}</td>
                  <td className={`font-semibold ${Number(e.balance) > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                    {formatCurrency(e.balance)}
                  </td>
                </tr>
              ))}
            </tbody>
            {data && data.entries.length > 0 && (() => {
              const soldItems = data.entries.reduce((s, e) => s + (e.invoice?.items || []).reduce((a, it) => a + Number(it.qty), 0), 0);
              const totalDebit = data.entries.reduce((s, e) => s + Number(e.debit), 0);
              const totalCredit = data.entries.reduce((s, e) => s + Number(e.credit), 0);
              return (
                <tfoot>
                  <tr className="bg-[#FAF7F0] font-bold border-t-2 border-[#E15A30]">
                    <td className="text-[#1F1A13]">{tr('الإجمالي')}</td>
                    <td className="text-[#1F1A13]">{formatNumber(soldItems)} {tr('وحدة مباعة')}</td>
                    <td className="text-xs text-gray-500">{data.entries.length} {tr('حركة')}</td>
                    <td className="text-red-600">{formatCurrency(totalDebit)}</td>
                    <td className="text-green-600">{formatCurrency(totalCredit)}</td>
                    <td className={Number(data.customer.balance) > 0 ? 'text-orange-600' : 'text-green-600'}>{formatCurrency(data.customer.balance ?? 0)}</td>
                  </tr>
                </tfoot>
              );
            })()}
          </table>
        </div>
      </div>
    </div>
  );
}
