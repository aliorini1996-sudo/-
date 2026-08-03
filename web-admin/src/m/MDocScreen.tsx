import { useQuery } from '@tanstack/react-query';
import { XCircle } from 'lucide-react';
import { invoiceApi, receiptApi } from '../api/client';
import {
  DocumentResult, invoiceDocFromDetail, receiptDocFromDetail, Company,
} from '../rep/RepDocuments';
import { useTr } from '../i18n/strings';
import { MError, MSpinner } from './mobileUi';
import { expectObject } from './shape';

/**
 * شاشة مستند ملء الشاشة — غلاف كسول حول `DocumentResult` من تطبيق المندوب.
 *
 * **الكسل مقصود لا تجميل:** `RepDocuments` تستورد `jspdf` و`html2canvas`
 * و`qrcode` استيراداً ثابتاً؛ لولا عزلها في حزمة مستقلّة لدخلت كلّها في حزمة
 * إقلاع التطبيق ولو لم يفتح المستخدم مستنداً واحداً.
 *
 * وهي **المكوّن الوحيد** الذي يُعاد استخدامه من `src/rep` كما هو: لا يلمس
 * `repApi` ولا منظومة الأوف‑لاين، فهو محايد تجاه الهوية.
 */
export default function MDocScreen({ kind, id, company, userName, onClose, onCancel }: {
  kind: 'invoice' | 'receipt';
  id: string;
  company: unknown;
  userName: string;
  onClose: () => void;
  onCancel?: () => void;
}) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ['m-doc', kind, id],
    queryFn: async () => {
      const res = kind === 'invoice' ? await invoiceApi.get(id) : await receiptApi.get(id);
      return expectObject<Record<string, unknown>>(res.data?.data, kind === 'invoice' ? 'الفاتورة' : 'السند');
    },
  });

  if (q.isLoading) return <MSpinner />;
  if (q.isError || !q.data) return <MError onRetry={() => q.refetch()} />;

  const raw = q.data;
  // اسم المندوب على المستند لا اسم من فتحه: الأدمن يستعرض عمل غيره
  const stampName = (raw.salesRep as { name?: string } | undefined)?.name || userName;
  const doc = kind === 'invoice'
    ? invoiceDocFromDetail(raw, stampName, company as Company | null)
    : receiptDocFromDetail(raw, stampName, company as Company | null);

  const cancellable = onCancel && raw.status !== 'CANCELLED';

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-hidden">
        <DocumentResult doc={doc} onClose={onClose} />
      </div>
      {cancellable && (
        <div className="flex-shrink-0 border-t border-[#E9E1D3] bg-white p-3"
          style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
          <button onClick={onCancel}
            className="w-full border border-[#F5C6C0] text-[#C0392B] bg-[#FDF2F0] font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2">
            <XCircle size={17} />
            {kind === 'invoice' ? tr('إلغاء الفاتورة') : tr('إلغاء السند')}
          </button>
        </div>
      )}
    </div>
  );
}
