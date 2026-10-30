/**
 * «إجمالي المبيعات» صافٍ من المرتجع (طلب المالك ٢٩ أكتوبر ٢٠٢٦).
 *
 * كل رقمٍ يُعرض «مبيعات» = فواتير البيع المؤكَّدة ناقص المرتجع المؤكَّد في المدى والنطاق نفسيهما — كما يفعل حساب العميل
 * (Customer.totalSales يُنقصه postReturnEntries) وتقرير المواقع والدفاتر. عدد الفواتير يبقى عدد فواتير البيع وحدها.
 *
 * ويبقى إجمالياً عمداً: مقام «نسبة المرتجع» في GET /reports/returns (المرتجع ÷ المبيعات)، ولوحة مالك المنصة (حجم التداول
 * لكل شركة، وتفصيل الشركة يعرض المرتجع سطراً مستقلاً).
 */

/** فاتورة إرجاعٍ أو إشعارٌ دائن (يُخزَّن الدائن type: 'RETURN'، والمدين type: 'CREDIT' فيُجمع بيعاً) */
export const isReturnInvoice = (inv: { type?: string | null }): boolean => inv.type === 'RETURN';

/** المبلغ بإشارته: المرتجع سالب. المرتجع يُخزَّن موجباً كالبيع */
export const signedAmount = (inv: { type?: string | null }, amount: unknown): number =>
  (isReturnInvoice(inv) ? -1 : 1) * Number(amount ?? 0);

/** ضجيج الفاصلة العائمة بعد الطرح (ست منازل كـaccounting.clean)، و‎-0 صفرٌ لا «‎-٠٫٠٠» على الشاشة */
export const cleanMoney = (n: number): number => (Math.round(n * 1e6) / 1e6) || 0;

/** صافي المبيعات من مجموعين (بيع، مرتجع) — مجموع Prisma قد يكون null */
export const netSales = (sales: unknown, returns: unknown): number =>
  cleanMoney(Number(sales ?? 0) - Number(returns ?? 0));

/** فواتير مختلطة (بيع ومرتجع): المجموع بإشارته، وعدد فواتير البيع منها */
export function netOfInvoices(rows: readonly { type?: string | null; total: unknown }[]): { salesTotal: number; invoicesCount: number } {
  let total = 0;
  let count = 0;
  for (const r of rows) {
    total += signedAmount(r, r.total);
    if (!isReturnInvoice(r)) count++;
  }
  return { salesTotal: cleanMoney(total), invoicesCount: count };
}
