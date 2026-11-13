import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { warehouseApi } from '../../api/client';
import DocumentModal from '../../components/DocumentModal';
import { useTr } from '../../i18n/strings';
import { warehouseNoticeDocFromEntry, type Company } from '../../rep/RepDocuments';
import { voucherCompany } from './SupplierPaymentVoucher';

type NoticeEntry = Parameters<typeof warehouseNoticeDocFromEntry>[0];

/**
 * فتح حركة مستودعٍ (فاتورة مورّد أو مرتجعه) بإشعارها القائم (PrintableWarehouseNotice) من كشف المورّد وفواتيره المفتوحة.
 * لا مسار لحركةٍ واحدة، فتُقرأ حركات المورّد من سجلّ المستودع (آخر ١٠٠ — سقف السجلّ) عند أول فتحٍ لا مع الصفحة، بمفتاح الصفحة
 * نفسه ['warehouse-entries', vendorId, ''] فيتشاركان الكاش. حركةٌ أقدم من السقف ⇒ تنبيهٌ صريح لا نافذةٌ فارغة.
 */
export function useEntryNotice(vendorId: string, company: Company | null) {
  const tr = useTr();
  const [on, setOn] = useState(false);
  const entriesQ = useQuery({
    queryKey: ['warehouse-entries', vendorId, ''],
    queryFn: async () => (await warehouseApi.entries({ vendorId })).data.data as (NoticeEntry & { id: string })[],
    enabled: on,
  });
  const [want, setWant] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeEntry | null>(null);
  useEffect(() => {
    if (!want || !entriesQ.data) return;
    const e = entriesQ.data.find(x => x.id === want);
    if (e) setNotice(e);
    else toast(tr('الحركة ليست ضمن آخر 100 حركة للمورد افتحها من مخزون الشركة'));
    setWant(null);
  }, [want, entriesQ.data, tr]);
  useEffect(() => {
    if (want && entriesQ.isError) { toast.error(tr('تعذر تحميل الحركة')); setWant(null); }
  }, [want, entriesQ.isError, tr]);

  const open = (entryId: string) => { setOn(true); setWant(entryId); };
  const modal = notice
    ? <DocumentModal doc={warehouseNoticeDocFromEntry(notice, voucherCompany(company))} onClose={() => setNotice(null)} />
    : null;
  return { open, modal, loading: !!want && entriesQ.isFetching };
}
