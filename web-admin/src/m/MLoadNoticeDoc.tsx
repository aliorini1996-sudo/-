import { DocumentResult, loadNoticeDocFromData, Company } from '../rep/RepDocuments';
import type { LoadNoticeAcceptance } from '../lib/pendingLoads';

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
 *
 * «تتبّع اللوط»: `MRepLoad` يجلب الحركات بـ`withLots=1` حين الميزة مفعّلة وحدها، فيحمل كل بندٍ `lots` (صفوف توزيعه
 * بتشغيلتها، بالأساس D22)، والبانية تضمّها إلى بنود الإشعار فيُطبع عمود «التشغيلة / الانتهاء» متى وُجدت تشغيلة. والمطفأة
 * بلا `lots` فالإشعار كما كان حرفاً. لا جلب هنا ولا نسخةٌ ثانية للتحويل.
 */
export default function MLoadNoticeDoc({ repName, movement, company, acceptance = null, onClose }: {
  repName: string;
  /**
   * الحركة كما يردّها `movements`: البند بلقطة وحدته (`unit` = unitName البند) وكميته بالأساس (`baseQty`) — فيطبع
   * الإشعار «٥٠ كرتون» لا «٥٠ حبة»، ويُجمع الإجمالي لكل وحدة حين تختلط (عقد loadNoticeDocFromData نفسه). و`lots`
   * تشغيلات البند (withLots) تمرّ كما هي
   */
  movement: Parameters<typeof loadNoticeDocFromData>[1];
  /** إعدادات الشركة للترويسة — `null` يعطي إشعاراً بلا اسمٍ ولا رقمٍ ضريبيّ */
  company: unknown;
  /** «قبول المندوب للتحميل»: إقرار المندوب الموقَّع لتحميلٍ قبله — يُطبع بتوقيعه ولحظة قبوله، وغيابه الإشعار كما كان */
  acceptance?: LoadNoticeAcceptance | null;
  onClose: () => void;
}) {
  return (
    <DocumentResult
      doc={loadNoticeDocFromData(repName, movement, (company as Company | null) ?? null, acceptance)}
      onClose={onClose}
    />
  );
}
