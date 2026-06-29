import { Router, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { paginate, paginationMeta } from '../utils/helpers';

const router = Router();
router.use(authenticate, requireAdmin, requireAdminPermission('canManageSalesReps'));

const emailSchema = z.preprocess(value => value === null ? '' : value, z.string().email().optional().or(z.literal('')));

const repSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(9),
  email: emailSchema,
  username: z.string().min(4),
  password: z.string().optional(), // Ø·ÙˆÙ„ ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± ÙŠÙÙØ­Øµ ÙÙŠ Ø§Ù„Ù…Ø¹Ø§Ù„Ø¬ Ù„Ø±Ø³Ø§Ù„Ø© Ø£ÙˆØ¶Ø­
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
  canManageVanStock: z.boolean().optional(),
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
  canManageVanStock: true,
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
    if (!rep) { res.status(404).json({ success: false, message: 'Ø§Ù„Ù…Ù†Ø¯ÙˆØ¨ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯' }); return; }
    res.json({ success: true, data: rep });
  } catch (err) { next(err); }
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { password, ...rest } = repSchema.parse(req.body);
    if (!password) { res.status(400).json({ success: false, message: 'ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± Ù…Ø·Ù„ÙˆØ¨Ø©' }); return; }
    if (password.length < 6) { res.status(400).json({ success: false, message: 'ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± 6 Ø£Ø­Ø±Ù Ø¹Ù„Ù‰ Ø§Ù„Ø£Ù‚Ù„' }); return; }

    // ÙØ±Ø¶ Ø§Ù„Ø­Ø¯ Ø§Ù„Ø£Ù‚ØµÙ‰ Ù„Ø¹Ø¯Ø¯ Ø§Ù„Ù…Ù†Ø§Ø¯ÙŠØ¨ Ø§Ù„Ù…Ø³Ù…ÙˆØ­ Ù„Ù„Ø´Ø±ÙƒØ© (Ø¥Ù† ÙˆÙØ¬Ø¯)
    const tenant = await prisma.tenant.findUnique({ where: { id: tid }, select: { maxSalesReps: true } });
    if (tenant?.maxSalesReps != null) {
      const current = await prisma.salesRep.count({ where: { tenantId: tid } });
      if (current >= tenant.maxSalesReps) {
        res.status(403).json({ success: false, message: `Ø¨Ù„ØºØª Ø§Ù„Ø´Ø±ÙƒØ© Ø§Ù„Ø­Ø¯ Ø§Ù„Ø£Ù‚ØµÙ‰ Ø§Ù„Ù…Ø³Ù…ÙˆØ­ Ù„Ù„Ù…Ù†Ø§Ø¯ÙŠØ¨ (${tenant.maxSalesReps}). ØªÙˆØ§ØµÙ„ Ù…Ø¹ Ù…Ø²ÙˆÙ‘Ø¯ Ø§Ù„Ø®Ø¯Ù…Ø© Ù„Ø±ÙØ¹ Ø§Ù„Ø­Ø¯.` });
        return;
      }
    }

    const dup = await checkRepDuplicates(tid, rest.username, rest.phone, rest.email);
    if (dup) { res.status(409).json({ success: false, message: dup }); return; }

    const passwordHash = await bcrypt.hash(password, 10);
    const rep = await prisma.salesRep.create({
      data: { ...rest, passwordHash, email: rest.email || null, tenantId: tid } as any,
      select: { id: true, name: true, phone: true, username: true, isActive: true },
    });
    res.status(201).json({ success: true, data: rep });
  } catch (err) { next(err); }
});

// ØªÙØ±Ù‘Ø¯ Ø§Ø³Ù… Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… Ø¹Ø§Ù„Ù…ÙŠ (Ù„Ù„Ø¯Ø®ÙˆÙ„)ØŒ ÙˆØ§Ù„Ø¬ÙˆØ§Ù„/Ø§Ù„Ø¨Ø±ÙŠØ¯ Ø¶Ù…Ù† Ø§Ù„Ø´Ø±ÙƒØ©
async function checkRepDuplicates(tid: string, username: string, phone: string, email?: string, excludeId?: string): Promise<string | null> {
  const notSelf = excludeId ? { id: { not: excludeId } } : {};
  if (await prisma.salesRep.findFirst({ where: { username, ...notSelf } })) return 'Ø§Ø³Ù… Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… Ù…Ø³ØªØ®Ø¯Ù… Ù…Ø³Ø¨Ù‚Ø§Ù‹';
  if (await prisma.salesRep.findFirst({ where: { tenantId: tid, phone, ...notSelf } })) return 'Ø±Ù‚Ù… Ø§Ù„Ø¬ÙˆØ§Ù„ Ù…Ø³ØªØ®Ø¯Ù… Ù…Ø³Ø¨Ù‚Ø§Ù‹';
  if (email && await prisma.salesRep.findFirst({ where: { tenantId: tid, email, ...notSelf } })) return 'Ø§Ù„Ø¨Ø±ÙŠØ¯ Ø§Ù„Ø¥Ù„ÙƒØªØ±ÙˆÙ†ÙŠ Ù…Ø³ØªØ®Ø¯Ù… Ù…Ø³Ø¨Ù‚Ø§Ù‹';
  return null;
}

router.put('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const current = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid } });
    if (!current) { res.status(404).json({ success: false, message: 'Ø§Ù„Ù…Ù†Ø¯ÙˆØ¨ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯' }); return; }

    const { password, ...rest } = repSchema.partial().parse(req.body);
    if (password && password.length < 6) { res.status(400).json({ success: false, message: 'ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± 6 Ø£Ø­Ø±Ù Ø¹Ù„Ù‰ Ø§Ù„Ø£Ù‚Ù„' }); return; }
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

// حذف مندوب — للإدارة فقط (المسار محميّ بـ requireAdmin عالمياً). يُمنع الحذف إن كانت له فواتير/سندات.
router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rep = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, name: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }

    // منع الحذف عند وجود فواتير أو سندات مرتبطة بالمندوب — يُقترح التعطيل بدلاً منه
    const [invoices, receipts] = await Promise.all([
      prisma.invoice.count({ where: { salesRepId: req.params.id } }),
      prisma.receipt.count({ where: { salesRepId: req.params.id } }),
    ]);
    if (invoices > 0 || receipts > 0) {
      res.status(409).json({ success: false, message: 'لا يمكن حذف المندوب لوجود فواتير أو سندات مرتبطة به. يمكنك تعطيله (تغيير حالته إلى «غير نشط») بدلاً من الحذف.' });
      return;
    }

    // حذف البيانات التابعة (إشعارات، تحميلات السيارة وعناصرها، مواقع GPS) ثم المندوب، في معاملة واحدة
    await prisma.$transaction([
      prisma.notification.deleteMany({ where: { salesRepId: req.params.id } }),
      prisma.vanLoadItem.deleteMany({ where: { vanLoad: { salesRepId: req.params.id } } }),
      prisma.vanLoad.deleteMany({ where: { salesRepId: req.params.id } }),
      prisma.repLocation.deleteMany({ where: { salesRepId: req.params.id } }),
      prisma.salesRep.delete({ where: { id: req.params.id } }),
    ]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;

