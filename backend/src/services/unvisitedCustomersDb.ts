import prisma from '../config/database';

/**
 * استعلاما الزيارات لتقرير «العملاء الذين لم تتم زيارتهم» (routes/reports.ts /unvisited-customers).
 *
 * لماذا groupBy هنا مع أن حارس work-day.test.ts يمنعه في موجّهات الزيارات: الحارس يمنع **عدّ** السجلّات الخام (المؤقّت
 * وملاحظته سجلّان ووقفةٌ واحدة، فالعدّ الخام يضاعف الزيارات). وهذان لا يعدّان شيئاً: الأول «هل للعميل أي زيارة في المدى؟»
 * (معرّفات مميّزة) والثاني «متى آخر زيارة قبل المدى؟» (أقصى تاريخ) — والدمج في وقفات لا يغيّر الجواب عن أيٍّ منهما.
 * ومكانهما خدمةٌ لا الموجّه كي يبقى الحارس صارماً على الموجّهات كما هو.
 */

/** العملاء الذين لهم أي زيارة في [fromDate, toEnd) — من أي مندوب في الشركة (لا نطاق المستخدم ولا الفريق) */
export async function visitedCustomerIds(tid: string, fromDate: Date, toEnd: Date): Promise<Set<string>> {
  const rows = await prisma.repVisit.groupBy({
    by: ['customerId'],
    where: { tenantId: tid, createdAt: { gte: fromDate, lt: toEnd } },
  });
  return new Set(rows.map(r => r.customerId));
}

/** آخر زيارة قبل fromDate لكل عميلٍ من القائمة — دفعاتٌ من ٥٠٠٠ معرّف كي لا يطول IN على القاعدة الصغيرة */
export async function lastVisitBeforeMap(tid: string, customerIds: string[], fromDate: Date): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  for (let i = 0; i < customerIds.length; i += 5000) {
    const rows = await prisma.repVisit.groupBy({
      by: ['customerId'],
      where: { tenantId: tid, customerId: { in: customerIds.slice(i, i + 5000) }, createdAt: { lt: fromDate } },
      _max: { createdAt: true },
    });
    for (const r of rows) if (r._max.createdAt) out.set(r.customerId, r._max.createdAt);
  }
  return out;
}
