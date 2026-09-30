import type { Prisma } from '@prisma/client';
import { clean } from './accounting';

/**
 * إلغاء الفاتورة والسند تحت القفل (مراجعة ٣٠ سبتمبر ٢٠٢٦، MD-5 وL8-1).
 *
 * كانت فحوص الإلغاء تجري على قراءةٍ سابقة للمعاملة، ثمّ يُحدَّث الصفّ داخلها بلا شرطٍ على حالته. فطلبان متقاربان
 * (نقرتان، أو مشرفان، أو webhook استرداد مكرّر) يمرّان من الفحص معاً ويعكس كلٌّ منهما القيد: رصيدٌ دائنٌ وهمي للعميل،
 * أو مبلغ السند يُعاد إلى متبقّي الفاتورة مرّتين. وكان إرجاع مبالغ التخصيص يقرأ الفاتورة بلا قفل ثمّ يكتب قيمةً مطلقة،
 * فيدهس سنداً التُزم بينهما.
 *
 * القاعدة هنا: أوّل ما في المعاملة قفلٌ أو مقارنةٌ وتبديل على صفّ المستند نفسه، وكلّ فحصٍ يُعاد تحته. الطلب الثاني
 * ينتظر الأول ثمّ يجد المستند ملغى فيُرفض قبل أيّ كتابة. والفواتير تُقفل بترتيب المعرّف ثمّ صفّ العميل في دوالّ
 * القيود، كإصدار السند. حذف المندوب وحده يقفل فواتيره قبل سنداته (عكس إلغاء السند)، فتزامنهما النادر على مستندات
 * المندوب نفسه قد يتشابك: يُجهض PostgreSQL إحدى المعاملتين كاملةً بلا أثرٍ جزئي، ويعيدها المستخدم.
 */

/**
 * رفضُ إلغاءٍ يُرفع داخل المعاملة فيلغيها كاملةً، ويردّه المسار 400 برسالته كما هي. وسبب HAS_NOTES يعيد المسار
 * بناءه بردّ ما قبل المعاملة نفسه (409 وبديل الإلغاء)، فلا تختلف الحالة الواحدة باختلاف توقيتها.
 */
export class CancelRefused extends Error {
  constructor(message: string, readonly reason?: 'HAS_NOTES') { super(message); this.name = 'CancelRefused'; }
}

type Tx = Prisma.TransactionClient;

/**
 * يقفل صفّ الفاتورة (FOR UPDATE) ويعيد تحته فحوص الإلغاء التي أجراها المسار قبل المعاملة. أيّ تغيّرٍ في الأثناء
 * (إلغاءٌ متزامن، سندٌ خُصّص عليها، إشعارٌ صدر عليها) يرفع CancelRefused.
 */
export async function lockInvoiceForCancel(tx: Tx, tenantId: string, invoiceId: string): Promise<void> {
  const [row] = await tx.$queryRaw<{ status: string; type: string; paidAmt: number }[]>`
    SELECT status, type, "paidAmt" FROM invoices WHERE id = ${invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (!row || row.status === 'CANCELLED') throw new CancelRefused('الفاتورة ملغاة مسبقا');
  if (row.type === 'CREDIT' && Number(row.paidAmt) > 0) throw new CancelRefused('لا يمكن إلغاء فاتورة آجلة تم تحصيل جزء منها');
  if (await tx.receiptInvoice.count({ where: { invoiceId } }) > 0) throw new CancelRefused('لا يمكن إلغاء فاتورة مرتبطة بسند قبض');
  if (await tx.invoice.count({ where: { tenantId, originalInvoiceId: invoiceId, status: 'CONFIRMED' } }) > 0) {
    throw new CancelRefused('صدر على هذه الفاتورة إشعار دائن أو مدين — لا تُلغى؛ أصدر إشعاراً دائناً بما تبقّى منها', 'HAS_NOTES');
  }
}

/**
 * ينقل السند إلى CANCELLED بمقارنةٍ وتبديل (updateMany مشروطٌ بأنه غير ملغى). في PostgreSQL ينتظر الطلبُ الثاني قفلَ
 * الصفّ ثمّ يعيد تقييم الشرط فلا يطابق شيئاً. يعيد true لمن فاز بالإلغاء وحده.
 */
export async function claimReceiptCancel(tx: Tx, tenantId: string, receiptId: string): Promise<boolean> {
  const r = await tx.receipt.updateMany({
    where: { id: receiptId, tenantId, status: { not: 'CANCELLED' } },
    data: { status: 'CANCELLED' },
  });
  return r.count === 1;
}

/**
 * يعيد مبالغ تخصيص سندٍ ملغى إلى فواتيرها: يقفل الصفوف بترتيب المعرّف (كإصدار السند) ثمّ يقرأ ويكتب تحت القفل،
 * فلا يدهس سداداً التُزم في الأثناء.
 */
export async function restoreAllocations(tx: Tx, tenantId: string, items: { invoiceId: string; amount: unknown }[]): Promise<void> {
  if (!items.length) return;
  const ids = [...new Set(items.map(i => i.invoiceId))];
  const rows = await tx.$queryRaw<{ id: string; paidAmt: number; remainingAmt: number }[]>`
    SELECT id, "paidAmt", "remainingAmt" FROM invoices
     WHERE id = ANY(${ids}::text[]) AND "tenantId" = ${tenantId}
     ORDER BY id
     FOR UPDATE`;
  const byId = new Map(rows.map(r => [r.id, { paid: Number(r.paidAmt), remaining: Number(r.remainingAmt) }]));
  for (const item of items) {
    const inv = byId.get(item.invoiceId);
    if (!inv) continue;
    inv.paid = clean(inv.paid - Number(item.amount));
    inv.remaining = clean(inv.remaining + Number(item.amount));
    await tx.invoice.update({ where: { id: item.invoiceId }, data: { paidAmt: inv.paid, remainingAmt: inv.remaining } });
  }
}
