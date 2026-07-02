import { Invoice } from '../../types';
import { formatCurrency, formatDate, statusLabels } from '../../utils/format';
import { useTr } from '../../i18n/strings';
import { X, Printer } from 'lucide-react';

interface Props { invoice: Invoice; onClose: () => void; }

export default function InvoiceDetailModal({ invoice, onClose }: Props) {
  const tr = useTr();
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b">
          <div>
            <h2 className="text-lg font-bold text-gray-800">{tr('فاتورة رقم')} {invoice.number}</h2>
            <p className="text-sm text-gray-500">{formatDate(invoice.invoiceDate)}</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => window.print()} className="btn-secondary"><Printer size={15} />{tr('طباعة')}</button>
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
          </div>
        </div>

        <div className="p-5 space-y-5">
          {/* Info */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="space-y-2">
              <p><span className="text-gray-500">{tr('العميل')}:</span> <span className="font-medium">{invoice.customer.name}</span></p>
              <p><span className="text-gray-500">{tr('الجوال')}:</span> <span>{invoice.customer.phone}</span></p>
            </div>
            <div className="space-y-2">
              <p><span className="text-gray-500">{tr('المندوب')}:</span> <span className="font-medium">{invoice.salesRep.name}</span></p>
              <p>
                <span className="text-gray-500">{tr('النوع')}:</span>
                <span className={`badge-${invoice.type.toLowerCase()} mr-1`}>{tr(statusLabels[invoice.type])}</span>
                <span className={`badge-${invoice.status.toLowerCase()} mr-1`}>{tr(statusLabels[invoice.status])}</span>
              </p>
            </div>
          </div>

          {/* حالة الفوترة الإلكترونية */}
          {invoice.einvoiceProvider && invoice.einvoiceProvider !== 'none' && (() => {
            const st = invoice.einvoiceStatus;
            const label = st === 'cleared' ? tr('معتمدة') : st === 'submitted' ? tr('مُرسَلة') : st === 'pending' ? tr('قيد الاعتماد') : st === 'error' ? tr('فشل الإرسال') : tr('جاهزة');
            const cls = st === 'cleared' || st === 'submitted' ? 'bg-[#E4F1EA] text-[#1E7A52] border-[#C9E4D6]'
              : st === 'error' ? 'bg-red-50 text-red-600 border-red-200'
              : st === 'pending' ? 'bg-amber-50 text-amber-700 border-amber-200'
              : 'bg-gray-50 text-gray-500 border-gray-200';
            return (
              <div className={`flex items-center flex-wrap gap-2 text-xs rounded-xl border px-3 py-2 ${cls}`}>
                <span className="font-semibold">{tr('الفوترة الإلكترونية')}:</span>
                <span className="uppercase font-bold">{invoice.einvoiceProvider}</span>
                <span>· {label}</span>
                {invoice.einvoiceUuid && <span className="font-mono ltr:ml-auto" dir="ltr" style={{ wordBreak: 'break-all' }}>UUID: {invoice.einvoiceUuid}</span>}
              </div>
            );
          })()}

          {/* Items */}
          {invoice.items && (
            <div className="border border-gray-100 rounded-xl overflow-hidden">
              <table className="table">
                <thead>
                  <tr><th>{tr('الصنف')}</th><th>{tr('الكمية')}</th><th>{tr('السعر')}</th><th>{tr('خصم')}</th><th>{tr('ضريبة')}</th><th>{tr('الإجمالي')}</th></tr>
                </thead>
                <tbody>
                  {invoice.items.map(item => (
                    <tr key={item.id}>
                      <td>
                        <p className="font-medium text-sm">{item.product.name}</p>
                        <p className="text-xs text-gray-400">{item.product.unit}</p>
                      </td>
                      <td>{Number(item.qty)}</td>
                      <td>{formatCurrency(item.unitPrice)}</td>
                      <td>{Number(item.discountPct) > 0 ? `${item.discountPct}%` : '-'}</td>
                      <td>{item.taxPct}%</td>
                      <td className="font-semibold">{formatCurrency(item.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Totals */}
          <div className="flex justify-end">
            <div className="w-56 space-y-1.5 text-sm border-t pt-3">
              <div className="flex justify-between"><span className="text-gray-500">{tr('قبل الخصم')}</span><span>{formatCurrency(invoice.subtotal)}</span></div>
              {Number(invoice.discountAmt) > 0 && (
                <div className="flex justify-between text-red-500"><span>{tr('الخصم')}</span><span>- {formatCurrency(invoice.discountAmt)}</span></div>
              )}
              <div className="flex justify-between text-[#E15A30]"><span>{tr('الضريبة')}</span><span>{formatCurrency(invoice.taxAmt)}</span></div>
              <div className="flex justify-between font-bold text-base border-t pt-2"><span>{tr('الإجمالي')}</span><span>{formatCurrency(invoice.total)}</span></div>
              <div className="flex justify-between text-green-600"><span>{tr('المدفوع')}</span><span>{formatCurrency(invoice.paidAmt)}</span></div>
              {Number(invoice.remainingAmt) > 0 && (
                <div className="flex justify-between text-red-600 font-semibold"><span>{tr('المتبقي')}</span><span>{formatCurrency(invoice.remainingAmt)}</span></div>
              )}
            </div>
          </div>

          {invoice.notes && (
            <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-600">
              <span className="font-medium">{tr('ملاحظات')}: </span>{invoice.notes}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
