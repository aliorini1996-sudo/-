import { Router, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
router.use(authenticate, requireAdmin, requireAdminPermission('canViewReports'));

router.get('/sales', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { from, to, salesRepId, customerId, groupBy } = req.query as Record<string, string>;
    // نطاق شامل ليوم «إلى» كاملاً (حتى منتصف ليلته) — يُصلح التصفية ليوم واحد وآخر يوم
    const dateFilter = from && to ? { gte: new Date(from), lt: new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000) } : undefined;

    const invoices = await prisma.invoice.findMany({
      where: {
        tenantId: tid,
        status: 'CONFIRMED',
        type: { not: 'RETURN' }, // تقرير المبيعات لا يشمل المرتجعات
        ...(dateFilter && { invoiceDate: dateFilter }),
        ...(salesRepId && { salesRepId }),
        ...(customerId && { customerId }),
      },
      include: {
        customer: { select: { id: true, name: true, channel: true, city: true } },
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

    // تجميع حسب قناة البيع (تصنيف مؤسسي) — العملاء بلا قناة يُجمَّعون تحت "غير محدّد"
    if (groupBy === 'channel') {
      const byChannel: Record<string, { name: string; count: number; total: number }> = {};
      invoices.forEach(inv => {
        const key = inv.customer.channel || 'UNSET';
        if (!byChannel[key]) byChannel[key] = { name: key, count: 0, total: 0 };
        byChannel[key].count++;
        byChannel[key].total += Number(inv.total);
      });
      res.json({ success: true, data: Object.values(byChannel).sort((a, b) => b.total - a.total) });
      return;
    }

    // تجميع حسب المنطقة الجغرافية (المدينة)
    if (groupBy === 'region') {
      const byRegion: Record<string, { name: string; count: number; total: number }> = {};
      invoices.forEach(inv => {
        const key = inv.customer.city || '—';
        if (!byRegion[key]) byRegion[key] = { name: key, count: 0, total: 0 };
        byRegion[key].count++;
        byRegion[key].total += Number(inv.total);
      });
      res.json({ success: true, data: Object.values(byRegion).sort((a, b) => b.total - a.total) });
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
    const tid = tenantId(req);
    const { from, to, salesRepId, paymentMethod } = req.query as Record<string, string>;
    // نطاق شامل ليوم «إلى» كاملاً (حتى منتصف ليلته) — يُصلح التصفية ليوم واحد وآخر يوم
    const dateFilter = from && to ? { gte: new Date(from), lt: new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000) } : undefined;

    const receipts = await prisma.receipt.findMany({
      where: {
        tenantId: tid,
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
    const tid = tenantId(req);
    const { type } = req.query as Record<string, string>;

    let where = {};
    if (type === 'overdue') where = { balance: { gt: 0 } };
    if (type === 'exceeded') where = { creditLimit: { gt: 0 } };

    const customers = await prisma.customer.findMany({
      where: { tenantId: tid, status: 'ACTIVE', ...where },
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
    const tid = tenantId(req);
    const { from, to } = req.query as Record<string, string>;
    // نطاق شامل ليوم «إلى» كاملاً (حتى منتصف ليلته) — يُصلح التصفية ليوم واحد وآخر يوم
    const dateFilter = from && to ? { gte: new Date(from), lt: new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000) } : undefined;

    // نطاق زمني للحضور والزيارات (بداية اليوم من → نهاية اليوم إلى)
    const fromDate = from ? new Date(from) : new Date(0);
    const toEnd = to ? new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000) : new Date();

    const [reps, sessions, visitCounts, visitRows] = await Promise.all([
      prisma.salesRep.findMany({
        where: { tenantId: tid, isActive: true },
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
      }),
      // ساعات العمل من جلسات الحضور
      prisma.repSession.findMany({
        where: { tenantId: tid, startedAt: { gte: fromDate, lt: toEnd } },
        select: { salesRepId: true, startedAt: true, lastBeatAt: true },
      }),
      // عدد الزيارات لكل مندوب (دقيق)
      prisma.repVisit.groupBy({
        by: ['salesRepId'],
        where: { tenantId: tid, createdAt: { gte: fromDate, lt: toEnd } },
        _count: { _all: true },
      }),
      // زيارات لها إحداثيات — لبناء روابط المواقع
      prisma.repVisit.findMany({
        where: { tenantId: tid, createdAt: { gte: fromDate, lt: toEnd }, lat: { not: null }, lng: { not: null } },
        select: { salesRepId: true, createdAt: true, lat: true, lng: true, customer: { select: { name: true } } },
        orderBy: { createdAt: 'asc' }, take: 5000,
      }),
    ]);

    const minutesByRep = new Map<string, number>();
    for (const s of sessions) {
      minutesByRep.set(s.salesRepId, (minutesByRep.get(s.salesRepId) || 0) + Math.max(0, (s.lastBeatAt.getTime() - s.startedAt.getTime()) / 60000));
    }
    const countByRep = new Map<string, number>();
    for (const c of visitCounts) countByRep.set(c.salesRepId, c._count._all);
    const visitsByRep = new Map<string, { customerName: string; createdAt: Date; lat: number; lng: number; mapsUrl: string }[]>();
    for (const v of visitRows) {
      const arr = visitsByRep.get(v.salesRepId) || [];
      if (arr.length < 300) { // سقف معقول لروابط كل مندوب
        arr.push({
          customerName: v.customer?.name || '', createdAt: v.createdAt, lat: v.lat!, lng: v.lng!,
          mapsUrl: `https://www.google.com/maps?q=${v.lat},${v.lng}`,
        });
        visitsByRep.set(v.salesRepId, arr);
      }
    }

    const data = reps.map(r => {
      const salesTotal = r.invoices.reduce((s, i) => s + Number(i.total), 0);
      const collectionsTotal = r.receipts.reduce((s, rc) => s + Number(rc.amount), 0);
      const discountTotal = r.invoices.reduce((s, i) => s + Number(i.discountAmt), 0);
      const workMinutes = Math.round(minutesByRep.get(r.id) || 0);
      return {
        id: r.id,
        name: r.name,
        invoicesCount: r.invoices.length,
        salesTotal,
        collectionsTotal,
        discountTotal,
        collectionRate: salesTotal > 0 ? Math.round((collectionsTotal / salesTotal) * 100) : 0,
        avgInvoice: r.invoices.length > 0 ? Math.round(salesTotal / r.invoices.length) : 0,
        workMinutes,
        workHours: Math.floor(workMinutes / 60),
        workMins: workMinutes % 60,
        visitsCount: countByRep.get(r.id) || 0,
        visits: visitsByRep.get(r.id) || [],
      };
    }).sort((a, b) => b.salesTotal - a.salesTotal);

    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// تقرير ساعات العمل — إجمالي الوقت الذي كان فيه كل مندوب متصلاً وفاتحاً التطبيق
// (من جلسات الحضور RepSession)، مع عدد الجلسات وأول/آخر ظهور.
router.get('/work-hours', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { from, to } = req.query as Record<string, string>;
    const fromDate = from ? new Date(from) : new Date(0);
    const toEnd = to ? new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000) : new Date();

    const [reps, sessions] = await Promise.all([
      prisma.salesRep.findMany({ where: { tenantId: tid, isActive: true }, select: { id: true, name: true } }),
      prisma.repSession.findMany({
        where: { tenantId: tid, startedAt: { gte: fromDate, lt: toEnd } },
        select: { salesRepId: true, startedAt: true, lastBeatAt: true },
      }),
    ]);

    const acc = new Map<string, { minutes: number; sessions: number; first: Date | null; last: Date | null }>();
    for (const s of sessions) {
      const m = acc.get(s.salesRepId) || { minutes: 0, sessions: 0, first: null, last: null };
      m.minutes += Math.max(0, (s.lastBeatAt.getTime() - s.startedAt.getTime()) / 60000);
      m.sessions += 1;
      if (!m.first || s.startedAt < m.first) m.first = s.startedAt;
      if (!m.last || s.lastBeatAt > m.last) m.last = s.lastBeatAt;
      acc.set(s.salesRepId, m);
    }

    const data = reps.map(r => {
      const m = acc.get(r.id) || { minutes: 0, sessions: 0, first: null, last: null };
      const totalMinutes = Math.round(m.minutes);
      return {
        id: r.id, name: r.name,
        totalMinutes,
        hours: Math.floor(totalMinutes / 60),
        minutes: totalMinutes % 60,
        sessions: m.sessions,
        firstSeen: m.first,
        lastSeen: m.last,
      };
    }).sort((a, b) => b.totalMinutes - a.totalMinutes);

    res.json({ success: true, data });
  } catch (err) { next(err); }
});

export default router;
