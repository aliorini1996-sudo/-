import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notificationApi } from '../api/client';
import { formatDateTime } from '../utils/format';
import { useTr } from '../i18n/strings';
import { Bell, CheckCheck } from 'lucide-react';
import toast from 'react-hot-toast';

const typeLabels: Record<string, string> = {
  CREDIT_LIMIT_EXCEEDED: 'تجاوز الحد الائتماني',
  DISCOUNT_LIMIT_EXCEEDED: 'تجاوز حد الخصم',
  OVERDUE_PAYMENT: 'تأخر السداد',
  INVOICE_CANCELLED: 'إلغاء فاتورة',
  PRICE_MODIFIED: 'تعديل سعر',
  RECEIPT_CANCELLED: 'إلغاء سند',
};

const typeColors: Record<string, string> = {
  CREDIT_LIMIT_EXCEEDED: 'bg-red-100 text-red-700',
  INVOICE_CANCELLED: 'bg-orange-100 text-orange-700',
  OVERDUE_PAYMENT: 'bg-yellow-100 text-yellow-700',
};

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  isRead: boolean;
  createdAt: string;
}

export default function NotificationsPage() {
  const qc = useQueryClient();
  const tr = useTr();
  const { data, isLoading } = useQuery({
    queryKey: ['notifications'],
    queryFn: async () => {
      const res = await notificationApi.list();
      return res.data.data as Notification[];
    },
  });

  const markAllMutation = useMutation({
    mutationFn: () => notificationApi.markAllRead(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['notifications'] }); toast.success(tr('تم تحديد الكل كمقروء')); },
  });

  const unreadCount = data?.filter(n => !n.isRead).length ?? 0;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{tr('الإشعارات')}</h1>
          {unreadCount > 0 && <p className="text-sm text-gray-500">{unreadCount} {tr('إشعار غير مقروء')}</p>}
        </div>
        {unreadCount > 0 && (
          <button className="btn-secondary" onClick={() => markAllMutation.mutate()}>
            <CheckCheck size={15} />{tr('تحديد الكل كمقروء')}
          </button>
        )}
      </div>

      <div className="card p-0 divide-y divide-gray-50">
        {isLoading ? (
          <div className="text-center py-12 text-gray-400">{tr('جاري التحميل...')}</div>
        ) : data?.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <Bell size={40} className="mx-auto mb-3 opacity-30" />
            <p>{tr('لا توجد إشعارات')}</p>
          </div>
        ) : data?.map(n => (
          <div key={n.id} className={`flex items-start gap-4 p-4 ${!n.isRead ? 'bg-[#FBEBE2]/50' : ''}`}>
            <div className={`w-2 h-2 rounded-full mt-2 flex-shrink-0 ${!n.isRead ? 'bg-[#E15A30]' : 'bg-gray-200'}`} />
            <div className="flex-1">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full mb-1 ${typeColors[n.type] || 'bg-gray-100 text-gray-600'}`}>
                    {tr(typeLabels[n.type] || n.type)}
                  </span>
                  <p className="text-sm font-semibold text-gray-800">{n.title}</p>
                  <p className="text-sm text-gray-600 mt-0.5">{n.body}</p>
                </div>
                <p className="text-xs text-gray-400 whitespace-nowrap">{formatDateTime(n.createdAt)}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
