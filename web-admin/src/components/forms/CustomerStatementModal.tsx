import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { customerApi } from '../../api/client';
import { Customer, AccountEntry } from '../../types';
import { formatCurrency, formatDate } from '../../utils/format';
import { X, Printer } from 'lucide-react';

interface Props { customer: Customer; onClose: () => void; }

export default function CustomerStatementModal({ customer, onClose }: Props) {
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

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-bold text-gray-800">كشف حساب</h2>
            <p className="text-sm text-gray-500">{customer.name} • {customer.phone}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handlePrint} className="btn-secondary"><Printer size={15} />طباعة</button>
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex gap-3 p-4 border-b border-gray-100">
          <div>
            <label className="label">من</label>
            <input type="date" className="input w-36" value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="label">إلى</label>
            <input type="date" className="input w-36" value={to} onChange={e => setTo(e.target.value)} />
          </div>
        </div>

        {/* Balance Summary */}
        <div className="grid grid-cols-3 gap-4 p-4 bg-gray-50 border-b">
          <div className="text-center">
            <p className="text-xs text-gray-500">إجمالي المبيعات</p>
            <p className="font-bold text-blue-600">{formatCurrency(data?.customer.totalSales ?? 0)}</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-gray-500">إجمالي التحصيل</p>
            <p className="font-bold text-green-600">{formatCurrency(data?.customer.totalCollected ?? 0)}</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-gray-500">الرصيد الحالي</p>
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
                <th>التاريخ</th><th>البيان</th><th>رقم المستند</th>
                <th>مدين</th><th>دائن</th><th>الرصيد</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} className="text-center py-8 text-gray-400">جاري التحميل...</td></tr>
              ) : data?.entries.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-8 text-gray-400">لا توجد حركات</td></tr>
              ) : data?.entries.map(e => (
                <tr key={e.id}>
                  <td className="text-xs text-gray-500">{formatDate(e.entryDate)}</td>
                  <td className="text-sm text-gray-700">{e.description}</td>
                  <td className="text-xs text-gray-400 font-mono">
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
          </table>
        </div>
      </div>
    </div>
  );
}
