import { Router, Response, NextFunction } from 'express';
import prisma from '../../config/database';
import { tenantId } from '../../middleware/auth';
import { AuthRequest } from '../../types';
import { roundDecimal } from '../../utils/helpers';

// تقارير مبيعات المطعم (M4). محمي بالمصادقة + requireVertical('restaurant') بالأعلى.
const router = Router();

// ملخّص المبيعات لمدى تاريخي: إجمالي/ضريبة/عدد + حسب اليوم + أعلى الأصناف + حسب طريقة الدفع
router.get('/summary', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    to.setHours(23, 59, 59, 999);
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 29 * 86400000);
    from.setHours(0, 0, 0, 0);
    const range = { gte: from, lte: to };
    const baseWhere = { tenantId: tid, status: 'CONFIRMED', invoiceDate: range } as const;

    const [sales, returns, invoices, byMethodRaw, topRaw] = await Promise.all([
      prisma.invoice.aggregate({ where: { ...baseWhere, type: { not: 'RETURN' } }, _sum: { total: true, subtotal: true, taxAmt: true }, _count: { id: true } }),
      prisma.invoice.aggregate({ where: { ...baseWhere, type: 'RETURN' }, _sum: { total: true }, _count: { id: true } }),
      prisma.invoice.findMany({ where: { ...baseWhere, type: { not: 'RETURN' } }, select: { invoiceDate: true, total: true } }),
      prisma.orderPayment.groupBy({ by: ['method'], where: { order: { invoice: { tenantId: tid, invoiceDate: range } } }, _sum: { amount: true } }),
      prisma.invoiceItem.groupBy({
        by: ['menuItemId'],
        where: { menuItemId: { not: null }, invoice: { tenantId: tid, type: { not: 'RETURN' }, invoiceDate: range } },
        _sum: { qty: true, lineTotal: true }, orderBy: { _sum: { lineTotal: 'desc' } }, take: 10,
      }),
    ]);

    // المبيعات حسب اليوم
    const dayMap = new Map<string, number>();
    for (const inv of invoices) {
      const d = inv.invoiceDate.toISOString().slice(0, 10);
      dayMap.set(d, roundDecimal((dayMap.get(d) ?? 0) + Number(inv.total), 2));
    }
    const byDay = [...dayMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, total]) => ({ date, total }));

    // أسماء أعلى الأصناف
    const ids = topRaw.map(t => t.menuItemId).filter((x): x is string => !!x);
    const items = ids.length ? await prisma.menuItem.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const nameById = new Map(items.map(i => [i.id, i.name]));
    const topItems = topRaw.map(t => ({ name: nameById.get(t.menuItemId as string) ?? 'صنف محذوف', qty: Number(t._sum.qty ?? 0), total: Number(t._sum.lineTotal ?? 0) }));

    res.json({
      success: true,
      data: {
        from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10),
        salesTotal: Number(sales._sum.total ?? 0),
        netTotal: Number(sales._sum.subtotal ?? 0),
        taxTotal: Number(sales._sum.taxAmt ?? 0),
        invoiceCount: sales._count.id,
        returnsTotal: Number(returns._sum.total ?? 0),
        byMethod: byMethodRaw.map(m => ({ method: m.method, amount: Number(m._sum.amount ?? 0) })),
        byDay, topItems,
      },
    });
  } catch (err) { next(err); }
});

export default router;
