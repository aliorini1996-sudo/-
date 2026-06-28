import { Router, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
router.use(authenticate, requireAdmin, requireAdminPermission('canAccessDashboard'));

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 86400000 - 1);
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const [
      dailySales, dailyReceipts, monthSales, monthReceipts,
      totalCustomers, overdueCustomers, creditExceeded,
      topReps, topCustomers, recentInvoices,
    ] = await Promise.all([
      prisma.invoice.aggregate({
        where: { tenantId: tid, status: 'CONFIRMED', type: { not: 'RETURN' }, invoiceDate: { gte: startOfDay, lte: endOfDay } },
        _sum: { total: true }, _count: { id: true },
      }),
      prisma.receipt.aggregate({
        where: { tenantId: tid, status: 'ACTIVE', receiptDate: { gte: startOfDay, lte: endOfDay } },
        _sum: { amount: true }, _count: { id: true },
      }),
      prisma.invoice.aggregate({
        where: { tenantId: tid, status: 'CONFIRMED', type: { not: 'RETURN' }, invoiceDate: { gte: startOfMonth } },
        _sum: { total: true }, _count: { id: true },
      }),
      prisma.receipt.aggregate({
        where: { tenantId: tid, status: 'ACTIVE', receiptDate: { gte: startOfMonth } },
        _sum: { amount: true }, _count: { id: true },
      }),
      prisma.customer.count({ where: { tenantId: tid, status: 'ACTIVE' } }),
      prisma.customer.count({ where: { tenantId: tid, status: 'ACTIVE', balance: { gt: 0 } } }),
      prisma.customer.count({
        where: { tenantId: tid, status: 'ACTIVE', creditLimit: { gt: 0 }, balance: { gt: prisma.customer.fields.creditLimit as never } },
      }).catch(() => 0),
      prisma.salesRep.findMany({
        where: { tenantId: tid },
        take: 5,
        select: { id: true, name: true, invoices: { where: { status: 'CONFIRMED', type: { not: 'RETURN' }, invoiceDate: { gte: startOfMonth } }, select: { total: true } } },
      }),
      prisma.customer.findMany({
        where: { tenantId: tid },
        take: 5, orderBy: { totalSales: 'desc' },
        select: { id: true, name: true, totalSales: true, balance: true },
      }),
      prisma.invoice.findMany({
        where: { tenantId: tid, status: 'CONFIRMED', type: { not: 'RETURN' } },
        take: 10, orderBy: { createdAt: 'desc' },
        include: { customer: { select: { name: true } }, salesRep: { select: { name: true } } },
      }),
    ]);

    const topRepsWithStats = topReps.map(r => ({
      id: r.id,
      name: r.name,
      invoicesCount: r.invoices.length,
      salesTotal: r.invoices.reduce((s, i) => s + Number(i.total), 0),
    })).sort((a, b) => b.salesTotal - a.salesTotal);

    res.json({
      success: true,
      data: {
        today: {
          salesTotal: Number(dailySales._sum.total ?? 0),
          invoicesCount: dailySales._count.id,
          collectionsTotal: Number(dailyReceipts._sum.amount ?? 0),
          receiptsCount: dailyReceipts._count.id,
        },
        month: {
          salesTotal: Number(monthSales._sum.total ?? 0),
          invoicesCount: monthSales._count.id,
          collectionsTotal: Number(monthReceipts._sum.amount ?? 0),
          receiptsCount: monthReceipts._count.id,
        },
        customers: { total: totalCustomers, withBalance: overdueCustomers, creditExceeded },
        topReps: topRepsWithStats,
        topCustomers,
        recentInvoices,
      },
    });
  } catch (err) { next(err); }
});

router.get('/sales-trend', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const days = parseInt(req.query.days as string) || 30;
    const from = new Date();
    from.setDate(from.getDate() - days);

    const invoices = await prisma.invoice.findMany({
      where: { tenantId: tid, status: 'CONFIRMED', type: { not: 'RETURN' }, invoiceDate: { gte: from } },
      select: { invoiceDate: true, total: true },
      orderBy: { invoiceDate: 'asc' },
    });

    const byDate: Record<string, number> = {};
    invoices.forEach(inv => {
      const d = inv.invoiceDate.toISOString().slice(0, 10);
      byDate[d] = (byDate[d] ?? 0) + Number(inv.total);
    });

    res.json({ success: true, data: Object.entries(byDate).map(([date, total]) => ({ date, total })) });
  } catch (err) { next(err); }
});

export default router;
