import { Router, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { paginate, paginationMeta } from '../utils/helpers';

const router = Router();
router.use(authenticate, requireAdmin);

const repSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(9),
  email: z.string().email().optional().or(z.literal('')),
  username: z.string().min(4),
  password: z.string().optional(), // طول كلمة المرور يُفحص في المعالج لرسالة أوضح
  isActive: z.boolean().optional(),
  canCreateInvoice: z.boolean().optional(),
  canSellOnCredit: z.boolean().optional(),
  canSellInCash: z.boolean().optional(),
  canEditInvoice: z.boolean().optional(),
  canDeleteInvoice: z.boolean().optional(),
  canCancelInvoice: z.boolean().optional(),
  canChangePrice: z.boolean().optional(),
  maxDiscountPct: z.number().min(0).max(100).optional(),
  canSellBelowPrice: z.boolean().optional(),
  canCreateReceipt: z.boolean().optional(),
  canEditReceipt: z.boolean().optional(),
  canCancelReceipt: z.boolean().optional(),
  canAddCustomer: z.boolean().optional(),
  canEditCustomer: z.boolean().optional(),
  canViewStatement: z.boolean().optional(),
});

const repSelect = {
  id: true, name: true, phone: true, email: true, username: true, isActive: true,
  canCreateInvoice: true, canSellOnCredit: true, canSellInCash: true,
  canEditInvoice: true, canDeleteInvoice: true, canCancelInvoice: true,
  canChangePrice: true, maxDiscountPct: true, canSellBelowPrice: true,
  canCreateReceipt: true, canEditReceipt: true, canCancelReceipt: true,
  canAddCustomer: true, canEditCustomer: true, canViewStatement: true,
  createdAt: true,
} as const;

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string | undefined;

    const where = {
      tenantId: tid,
      ...(search && { OR: [{ name: { contains: search } }, { phone: { contains: search } }, { username: { contains: search } }] }),
    };

    const [total, reps] = await Promise.all([
      prisma.salesRep.count({ where }),
      prisma.salesRep.findMany({ where, ...paginate(page, limit), orderBy: { name: 'asc' }, select: repSelect }),
    ]);

    res.json({ success: true, data: reps, pagination: paginationMeta(total, page, limit) });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rep = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid }, select: repSelect });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    res.json({ success: true, data: rep });
  } catch (err) { next(err); }
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { password, ...rest } = repSchema.parse(req.body);
    if (!password) { res.status(400).json({ success: false, message: 'كلمة المرور مطلوبة' }); return; }
    if (password.length < 6) { res.status(400).json({ success: false, message: 'كلمة المرور 6 أحرف على الأقل' }); return; }

    // فرض الحد الأقصى لعدد المناديب المسموح للشركة (إن وُجد)
    const tenant = await prisma.tenant.findUnique({ where: { id: tid }, select: { maxSalesReps: true } });
    if (tenant?.maxSalesReps != null) {
      const current = await prisma.salesRep.count({ where: { tenantId: tid } });
      if (current >= tenant.maxSalesReps) {
        res.status(403).json({ success: false, message: `بلغت الشركة الحد الأقصى المسموح للمناديب (${tenant.maxSalesReps}). تواصل مع مزوّد الخدمة لرفع الحد.` });
        return;
      }
    }

    const dup = await checkRepDuplicates(tid, rest.username, rest.phone, rest.email);
    if (dup) { res.status(409).json({ success: false, message: dup }); return; }

    const passwordHash = await bcrypt.hash(password, 10);
    const rep = await prisma.salesRep.create({
      data: { ...rest, passwordHash, email: rest.email || null, tenantId: tid },
      select: { id: true, name: true, phone: true, username: true, isActive: true },
    });
    res.status(201).json({ success: true, data: rep });
  } catch (err) { next(err); }
});

// تفرّد اسم المستخدم عالمي (للدخول)، والجوال/البريد ضمن الشركة
async function checkRepDuplicates(tid: string, username: string, phone: string, email?: string, excludeId?: string): Promise<string | null> {
  const notSelf = excludeId ? { id: { not: excludeId } } : {};
  if (await prisma.salesRep.findFirst({ where: { username, ...notSelf } })) return 'اسم المستخدم مستخدم مسبقاً';
  if (await prisma.salesRep.findFirst({ where: { tenantId: tid, phone, ...notSelf } })) return 'رقم الجوال مستخدم مسبقاً';
  if (email && await prisma.salesRep.findFirst({ where: { tenantId: tid, email, ...notSelf } })) return 'البريد الإلكتروني مستخدم مسبقاً';
  return null;
}

router.put('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const current = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid } });
    if (!current) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }

    const { password, ...rest } = repSchema.partial().parse(req.body);
    if (password && password.length < 6) { res.status(400).json({ success: false, message: 'كلمة المرور 6 أحرف على الأقل' }); return; }
    if (rest.username || rest.phone || rest.email) {
      const dup = await checkRepDuplicates(
        tid,
        rest.username ?? current.username,
        rest.phone ?? current.phone,
        rest.email ?? current.email ?? undefined,
        req.params.id
      );
      if (dup) { res.status(409).json({ success: false, message: dup }); return; }
    }
    const updateData: Record<string, unknown> = { ...rest, email: rest.email || null };
    if (password) updateData.passwordHash = await bcrypt.hash(password, 10);
    const rep = await prisma.salesRep.update({
      where: { id: req.params.id },
      data: updateData,
      select: { id: true, name: true, phone: true, username: true, isActive: true },
    });
    res.json({ success: true, data: rep });
  } catch (err) { next(err); }
});

router.get('/:id/stats', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { from, to } = req.query;
    const dateFilter = from && to ? { gte: new Date(from as string), lte: new Date(to as string) } : undefined;

    const [invoices, receipts] = await Promise.all([
      prisma.invoice.aggregate({
        where: { tenantId: tid, salesRepId: req.params.id, status: 'CONFIRMED', ...(dateFilter && { invoiceDate: dateFilter }) },
        _count: { id: true }, _sum: { total: true },
      }),
      prisma.receipt.aggregate({
        where: { tenantId: tid, salesRepId: req.params.id, status: 'ACTIVE', ...(dateFilter && { receiptDate: dateFilter }) },
        _count: { id: true }, _sum: { amount: true },
      }),
    ]);

    res.json({
      success: true,
      data: {
        invoicesCount: invoices._count.id,
        salesTotal: invoices._sum.total ?? 0,
        receiptsCount: receipts._count.id,
        collectionsTotal: receipts._sum.amount ?? 0,
      },
    });
  } catch (err) { next(err); }
});

export default router;
