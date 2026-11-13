import prisma from '../config/database';

/**
 * علامة تقرير «العملاء الذين لم تتم زيارتهم» (طلب المالك ١٣ نوفمبر ٢٠٢٦): «علامة تفرّق بين من تم إصدار فواتير له بدون زيارة،
 * ومن لم تتم زيارته ولا إصدار فواتير». فواتير البيع في الفترة لكل عميلٍ لم يُزر فيها: عددها وتاريخ آخرها.
 *
 * - فواتير البيع المؤكَّدة وحدها (CASH/CREDIT، والحالة CONFIRMED): لا مسودة، ولا ملغاة، ولا مرتجع.
 * - بتاريخ الفاتورة (invoiceDate) في المدى نفسه للزيارات [fromDate, toEnd).
 * - من أي مندوب أو مستخدم في الشركة: السؤال عن العميل «هل بِيع له؟» كما «هل زاره أحد؟» (زيارات الشركة كلها).
 *
 * مكانها خدمةٌ مستقلة لا unvisitedCustomersDb، لأن حارس ذاك الملف يمنع أي عدّ. والعدّ هنا لفواتير لا لسجلّات زيارات.
 */

export interface SaleInvoiceStat { count: number; lastAt: Date | null }

/** فواتير البيع في [fromDate, toEnd) لكل عميلٍ من القائمة، على دفعاتٍ من ٥٠٠٠ معرّف كي لا يطول IN على القاعدة الصغيرة */
export async function saleInvoiceStatsMap(tid: string, customerIds: string[], fromDate: Date, toEnd: Date): Promise<Map<string, SaleInvoiceStat>> {
  const out = new Map<string, SaleInvoiceStat>();
  for (let i = 0; i < customerIds.length; i += 5000) {
    const rows = await prisma.invoice.groupBy({
      by: ['customerId'],
      where: {
        tenantId: tid, customerId: { in: customerIds.slice(i, i + 5000) },
        type: { in: ['CASH', 'CREDIT'] }, status: 'CONFIRMED', invoiceDate: { gte: fromDate, lt: toEnd },
      },
      _count: { _all: true },
      _max: { invoiceDate: true },
    });
    for (const r of rows) out.set(r.customerId, { count: r._count._all, lastAt: r._max.invoiceDate ?? null });
  }
  return out;
}
