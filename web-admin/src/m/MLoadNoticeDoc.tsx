import { DocumentResult, loadNoticeDocFromData, Company } from '../rep/RepDocuments';

/**
 * إشعار حركة سيارة (تحميل · تنزيل · تسوية) — غلاف كسول حول عارض المستندات،
 * كـ`MSettlementDoc` تماماً.
 *
 * **الكسل مقصود:** `RepDocuments` تستورد `jspdf` و`html2canvas` و`qrcode`
 * استيراداً ثابتاً، ولولا عزلها لدخلت حزمةَ شاشة التحميل فدفع ثمنها من سجّل
 * حركةً ولم يُصدّر إشعاراً قطّ.
 *
 * والمستند يُبنى من صفّ السجلّ الذي في اليد لا بطلبٍ جديد: استعلام `movements`
 * يردّ الأصناف وكمّياتها ومَن سجّلها، فكلّ حقول الإشعار حاضرة — وهو ما تفعله
 * اللوحة حرفياً (`VanStockPage.tsx`).
 */
export default function MLoadNoticeDoc({ repName, movement, company, onClose }: {
  repName: string;
  movement: { kind: string; date: string; ref?: string; by?: string | null; items: { name: string; qty: number; unit?: string }[] };
  /** إعدادات الشركة للترويسة — `null` يعطي إشعاراً بلا اسمٍ ولا رقمٍ ضريبيّ */
  company: unknown;
  onClose: () => void;
}) {
  return (
    <DocumentResult
      doc={loadNoticeDocFromData(repName, movement, (company as Company | null) ?? null)}
      onClose={onClose}
    />
  );
}
