import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
router.use(authenticate);
router.use(requireAdminPermission('canManageVanStock'));

const loadSchema = z.object({
  salesRepId: z.string().optional(), // الأدمن يحدّده؛ المندوب يُستخدم معرّفه تلقائياً
  type: z.enum(['LOAD', 'UNLOAD', 'ADJUST']).default('LOAD'),
  note: z.string().optional(),
  items: z.array(z.object({
    productId: z.string(),
    qty: z.number(), // موجب للتحميل/الإرجاع للمستودع؛ قد تكون سالبة لـADJUST
  })).min(1),
});

// يحدّد المندوب المستهدف: المندوب=نفسه، الأدمن=من الطلب
function resolveRep(req: AuthRequest, bodyRepId?: string): { salesRepId: string; isRep: boolean } {
  const isRep = req.user?.role === 'SALES_REP';
  if (isRep) return { salesRepId: req.user!.id, isRep: true };
  if (!bodyRepId) throw Object.assign(new Error('يجب تحديد المندوب'), { status: 400 });
  return { salesRepId: bodyRepId, isRep: false };
}

interface StockRow {
  productId: string; name: string; code: string; unit: string;
  loaded: number; unloaded: number; adjusted: number; sold: number; returned: number; remaining: number;
}

// يحسب مخزون سيارة مندوب لكل منتج: المتبقي = المحمّل − المنزَّل + التسوية − المُباع + المُرتجع
async function computeStock(tid: string, salesRepId: string): Promise<StockRow[]> {
  const [loadItems, invItems, products] = await Promise.all([
    prisma.vanLoadItem.findMany({
      where: { vanLoad: { tenantId: tid, salesRepId } },
      select: { productId: true, qty: true, vanLoad: { select: { type: true } } },
    }),
    prisma.invoiceItem.findMany({
      where: { invoice: { tenantId: tid, salesRepId, status: 'CONFIRMED' } },
      select: { productId: true, qty: true, invoice: { select: { type: true } } },
    }),
    prisma.product.findMany({ where: { tenantId: tid }, select: { id: true, name: true, unit: true, code: true } }),
  ]);

  const acc = new Map<string, Omit<StockRow, 'productId' | 'name' | 'code' | 'unit' | 'remaining'>>();
  const ensure = (pid: string) => {
    if (!acc.has(pid)) acc.set(pid, { loaded: 0, unloaded: 0, adjusted: 0, sold: 0, returned: 0 });
    return acc.get(pid)!;
  };
  for (const it of loadItems) {
    const m = ensure(it.productId);
    if (it.vanLoad.type === 'LOAD') m.loaded += it.qty;
    else if (it.vanLoad.type === 'UNLOAD') m.unloaded += it.qty;
    else m.adjusted += it.qty;
  }
  for (const it of invItems) {
    const m = ensure(it.productId);
    if (it.invoice.type === 'RETURN') m.returned += it.qty;
    else m.sold += it.qty;
  }

  const prodById = new Map(products.map(p => [p.id, p]));
  const rows: StockRow[] = [];
  for (const [pid, m] of acc) {
    const p = prodById.get(pid);
    if (!p) continue;
    const remaining = m.loaded - m.unloaded + m.adjusted - m.sold + m.returned;
    rows.push({ productId: pid, name: p.name, code: p.code, unit: p.unit, ...m, remaining });
  }
  rows.sort((a, b) => b.remaining - a.remaining);
  return rows;
}

// تسجيل حركة تحميل/تنزيل/تسوية لسيارة المندوب
router.post('/loads', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = loadSchema.parse(req.body);
    const { salesRepId, isRep } = resolveRep(req, data.salesRepId);

    const rep = await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    if (isRep && rep.canManageVanStock === false) { res.status(403).json({ success: false, message: 'غير مسموح لك بإدارة مخزون السيارة' }); return; }

    const items = data.items.filter(i => i.qty !== 0);
    if (!items.length) { res.status(400).json({ success: false, message: 'لا توجد كميات صالحة' }); return; }

    const productIds = [...new Set(items.map(i => i.productId))];
    const valid = await prisma.product.count({ where: { id: { in: productIds }, tenantId: tid } });
    if (valid !== productIds.length) { res.status(400).json({ success: false, message: 'منتج غير صالح' }); return; }

    const load = await prisma.vanLoad.create({
      data: {
        tenantId: tid, salesRepId, type: data.type, note: data.note,
        createdBy: isRep ? 'REP' : 'ADMIN',
        items: { create: items.map(i => ({ productId: i.productId, qty: i.qty })) },
      },
      include: { items: { include: { product: { select: { id: true, name: true, unit: true } } } } },
    });
    res.status(201).json({ success: true, data: load });
  } catch (err) { next(err); }
});

// المخزون الحالي لمندوب (المندوب=سيارته، الأدمن=يمرّر salesRepId)
router.get('/current', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const isRep = req.user?.role === 'SALES_REP';
    const salesRepId = isRep ? req.user!.id : (req.query.salesRepId as string | undefined);
    if (!salesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }
    const rows = await computeStock(tid, salesRepId);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ملخّص مخزون كل المناديب — للأدمن (ينعكس بلوحة التحكم)
router.get('/summary', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const reps = await prisma.salesRep.findMany({ where: { tenantId: tid }, select: { id: true, name: true, isActive: true } });
    const data = await Promise.all(reps.map(async r => {
      const rows = await computeStock(tid, r.id);
      const lastLoad = await prisma.vanLoad.findFirst({
        where: { tenantId: tid, salesRepId: r.id, type: 'LOAD' },
        orderBy: { createdAt: 'desc' }, select: { createdAt: true },
      });
      return {
        salesRepId: r.id, repName: r.name, isActive: r.isActive,
        productCount: rows.filter(x => Math.abs(x.remaining) > 1e-9).length,
        totalRemaining: rows.reduce((s, x) => s + x.remaining, 0),
        totalLoaded: rows.reduce((s, x) => s + x.loaded, 0),
        totalSold: rows.reduce((s, x) => s + x.sold, 0),
        lastLoadAt: lastLoad?.createdAt || null,
      };
    }));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// سجل التحميلات
router.get('/loads', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const isRep = req.user?.role === 'SALES_REP';
    const salesRepId = isRep ? req.user!.id : (req.query.salesRepId as string | undefined);
    const loads = await prisma.vanLoad.findMany({
      where: { tenantId: tid, ...(salesRepId && { salesRepId }) },
      orderBy: { createdAt: 'desc' }, take: 100,
      include: {
        items: { include: { product: { select: { id: true, name: true, unit: true } } } },
        salesRep: { select: { id: true, name: true } },
      },
    });
    res.json({ success: true, data: loads });
  } catch (err) { next(err); }
});

// حركة المخزون عبر الزمن (تحميلات + مبيعات + مرتجعات) — كم نزل من البضاعة ومتى
router.get('/movements', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const isRep = req.user?.role === 'SALES_REP';
    const salesRepId = isRep ? req.user!.id : (req.query.salesRepId as string | undefined);
    if (!salesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }

    const [loads, invoices] = await Promise.all([
      prisma.vanLoad.findMany({
        where: { tenantId: tid, salesRepId }, orderBy: { createdAt: 'desc' }, take: 50,
        include: { items: { include: { product: { select: { name: true, unit: true } } } } },
      }),
      prisma.invoice.findMany({
        where: { tenantId: tid, salesRepId, status: 'CONFIRMED' }, orderBy: { invoiceDate: 'desc' }, take: 50,
        include: { items: { include: { product: { select: { name: true, unit: true } } } }, customer: { select: { name: true } } },
      }),
    ]);

    const movements = [
      ...loads.map(l => ({
        kind: l.type, date: l.createdAt, ref: l.note || '', by: l.createdBy,
        items: l.items.map(i => ({ name: i.product.name, unit: i.product.unit, qty: i.qty })),
      })),
      ...invoices.map(inv => ({
        kind: inv.type === 'RETURN' ? 'RETURN' : 'SALE', date: inv.invoiceDate,
        ref: `${inv.number} · ${inv.customer.name}`, by: 'REP',
        items: inv.items.map(i => ({ name: i.product.name, unit: i.product.unit, qty: i.qty })),
      })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 60);

    res.json({ success: true, data: movements });
  } catch (err) { next(err); }
});

export default router;
