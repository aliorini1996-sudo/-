import { Router, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { authenticate, requireAdmin } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
router.use(authenticate, requireAdmin);

router.get('/sales', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { from, to, salesRepId, customerId, groupBy } = req.query as Record<string, string>;
    const dateFilter = from && to ? { gte: new Date(from), lte: new Date(to) } : undefined;

    const invoices = await prisma.invoice.findMany({
      where: {
        status: 'CONFIRMED',
        type: { not: 'RETURN' }, // تقرير المبيعات لا يشمل المرتجعات
        ...(dateFilter && { invoiceDate: dateFilter }),
        ...(salesRepId && { salesRepId }),
        ...(customerId && { customerId }),
      },
      include: {
        customer: { select: { id: true, name: true } },
        salesRep: { select: { id: true, name: true } },
        items: { include: { product: { select: { id: true, name: true, code: true } } } },
      },
      orderBy: { invoiceDate: 'asc' },
    });

    if (groupBy === 'product') {
      const byProduct: Record<string, { name: string; code: string; qty: number; total: number }> = {};
      invoices.forEach(inv => {
        inv.items.forEach(item => {
          const key = item.product.id;
          if (!byProduct[key]) byProduct[key] = { name: item.product.name, code: item.product.code, qty: 0, total: 0 };
          byProduct[key].qty += Number(item.qty);
          byProduct[key].total += Number(item.lineTotal);
        });
      });
      res.json({ success: true, data: Object.values(byProduct).sort((a, b) => b.total - a.total) });
      return;
    }

    if (groupBy === 'rep') {
      const byRep: Record<string, { name: string; count: number; total: number }> = {};
      invoices.forEach(inv => {
        const key = inv.salesRep.id;
        if (!byRep[key]) byRep[key] = { name: inv.salesRep.name, count: 0, total: 0 };
        byRep[key].count++;
        byRep[key].total += Number(inv.total);
      });
      res.json({ success: true, data: Object.values(byRep).sort((a, b) => b.total - a.total) });
      return;
    }

    if (groupBy === 'customer') {
      const byCustomer: Record<string, { name: string; count: number; total: number }> = {};
      invoices.forEach(inv => {
        const key = inv.customer.id;
        if (!byCustomer[key]) byCustomer[key] = { name: inv.customer.name, count: 0, total: 0 };
        byCustomer[key].count++;
        byCustomer[key].total += Number(inv.total);
      });
      res.json({ success: true, data: Object.values(byCustomer).sort((a, b) => b.total - a.total) });
      return;
    }

    const summary = {
      total: invoices.reduce((s, i) => s + Number(i.total), 0),
      count: invoices.length,
      taxTotal: invoices.reduce((s, i) => s + Number(i.taxAmt), 0),
      discountTotal: invoices.reduce((s, i) => s + Number(i.discountAmt), 0),
    };
    res.json({ success: true, data: { invoices, summary } });
  } catch (err) { next(err); }
});

router.get('/collections', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { from, to, salesRepId, paymentMethod } = req.query as Record<string, string>;
    const dateFilter = from && to ? { gte: new Date(from), lte: new Date(to) } : undefined;

    const receipts = await prisma.receipt.findMany({
      where: {
        status: 'ACTIVE',
        ...(dateFilter && { receiptDate: dateFilter }),
        ...(salesRepId && { salesRepId }),
        ...(paymentMethod && { paymentMethod: paymentMethod as 'CASH' | 'BANK_TRANSFER' | 'POS' | 'CHEQUE' }),
      },
      include: {
        customer: { select: { id: true, name: true } },
        salesRep: { select: { id: true, name: true } },
      },
      orderBy: { receiptDate: 'asc' },
    });

    const summary = {
      total: receipts.reduce((s, r) => s + Number(r.amount), 0),
      count: receipts.length,
      byMethod: receipts.reduce((acc, r) => {
        acc[r.paymentMethod] = (acc[r.paymentMethod] ?? 0) + Number(r.amount);
        return acc;
      }, {} as Record<string, number>),
    };

    res.json({ success: true, data: { receipts, summary } });
  } catch (err) { next(err); }
});

router.get('/balances', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { type } = req.query as Record<string, string>;

    let where = {};
    if (type === 'overdue') where = { balance: { gt: 0 } };
    if (type === 'exceeded') where = { creditLimit: { gt: 0 } };

    const customers = await prisma.customer.findMany({
      where: { status: 'ACTIVE', ...where },
      select: { id: true, name: true, phone: true, balance: true, creditLimit: true, paymentDays: true, totalSales: true, totalCollected: true },
      orderBy: { balance: 'desc' },
    });

    const result = type === 'exceeded'
      ? customers.filter(c => Number(c.balance) > Number(c.creditLimit))
      : customers;

    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

router.get('/rep-performance', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { from, to } = req.query as Record<string, string>;
    const dateFilter = from && to ? { gte: new Date(from), lte: new Date(to) } : undefined;

    const reps = await prisma.salesRep.findMany({
      where: { isActive: true },
      select: {
        id: true, name: true,
        invoices: {
          where: { status: 'CONFIRMED', type: { not: 'RETURN' }, ...(dateFilter && { invoiceDate: dateFilter }) },
          select: { total: true, discountAmt: true, type: true },
        },
        receipts: {
          where: { status: 'ACTIVE', ...(dateFilter && { receiptDate: dateFilter }) },
          select: { amount: true },
        },
      },
    });

    const data = reps.map(r => {
      const salesTotal = r.invoices.reduce((s, i) => s + Number(i.total), 0);
      const collectionsTotal = r.receipts.reduce((s, rc) => s + Number(rc.amount), 0);
      const discountTotal = r.invoices.reduce((s, i) => s + Number(i.discountAmt), 0);
      return {
        id: r.id,
        name: r.name,
        invoicesCount: r.invoices.length,
        salesTotal,
        collectionsTotal,
        discountTotal,
        collectionRate: salesTotal > 0 ? Math.round((collectionsTotal / salesTotal) * 100) : 0,
        avgInvoice: r.invoices.length > 0 ? Math.round(salesTotal / r.invoices.length) : 0,
      };
    }).sort((a, b) => b.salesTotal - a.salesTotal);

    res.json({ success: true, data });
  } catch (err) { next(err); }
});

export default router;
