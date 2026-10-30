import { DocumentResult, warehouseNoticeDocFromEntry, Company } from '../rep/RepDocuments';

/**
 * إشعار حركة مستودع الشركة — غلاف كسول حول عارض المستندات، كـ`MSettlementDoc`.
 *
 * **الكسل مقصود لا تجميل:** `RepDocuments` تستورد `jspdf` و`html2canvas`
 * و`qrcode` استيراداً ثابتاً، ولولا عزلها لدخلت حزمة شاشة المخزون فيدفع ثمنها
 * من فتح المخزون ولم يُصدر إشعاراً قطّ.
 *
 * والإشعار يُبنى من الحركة التي في اليد بقيمها المحسوبة في الخادم — لا طلبٌ
 * جديد ولا حسابٌ ثانٍ لرقمٍ واحد.
 *
 * «تتبّع اللوط»: سجل `/warehouse/entries` يضمّ `lot` لكل سطر حين الميزة مفعّلة وحدها (الحارس نفسه في الخادم، بلا معامل)،
 * والبانية تحوّله صفّاً بالأساس (D22) فيُطبع عمود «التشغيلة / الانتهاء» متى وُجدت تشغيلة؛ والمطفأة بلا `lot` فالإشعار
 * كما كان حرفاً.
 */
export default function MWarehouseNoticeDoc({ entry, company, onClose }: {
  entry: Parameters<typeof warehouseNoticeDocFromEntry>[0];
  /** إعدادات الشركة للترويسة — `null` يعطي مستنداً بلا اسمٍ ولا رقمٍ ضريبيّ */
  company: unknown;
  onClose: () => void;
}) {
  return (
    <DocumentResult
      doc={warehouseNoticeDocFromEntry(entry, (company as Company | null) ?? null)}
      onClose={onClose}
    />
  );
}
