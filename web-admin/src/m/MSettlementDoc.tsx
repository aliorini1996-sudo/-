import { DocumentResult, settlementLogDocFromData, Company } from '../rep/RepDocuments';

/**
 * سند استلام تحصيلٍ واحد — غلاف كسول حول عارض المستندات، كـ`MDocScreen`.
 *
 * **الكسل مقصود لا تجميل:** `RepDocuments` تستورد `jspdf` و`html2canvas`
 * و`qrcode` استيراداً ثابتاً. ولولا عزلها في حزمة مستقلّة لدخلت كلّها في حزمة
 * شاشة المناديب، فيدفع ثمنها من فتح قائمة المناديب ولم يُصدّر سنداً قطّ.
 *
 * والمستند يُبنى من الصفّ الذي في اليد لا بطلبٍ جديد: `settlements` ردّت
 * بالسجلّ كاملاً فكلّ حقول السند حاضرة، وطلبُ الخادم ثانيةً لأجلها زيادةٌ بلا
 * فائدة — وهو ما تفعله اللوحة حرفياً (`SalesRepsPage.tsx`).
 */
export default function MSettlementDoc({ repName, settlement, company, onClose }: {
  repName: string;
  settlement: { amount: number | string; note?: string | null; createdBy?: string | null; settledAt: string };
  /** إعدادات الشركة للترويسة — `null` يعطي مستنداً بلا اسمٍ ولا رقمٍ ضريبيّ */
  company: unknown;
  onClose: () => void;
}) {
  return (
    <DocumentResult
      doc={settlementLogDocFromData(repName, [settlement], (company as Company | null) ?? null)}
      onClose={onClose}
    />
  );
}
