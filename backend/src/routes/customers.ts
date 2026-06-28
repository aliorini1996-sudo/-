import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { paginate, paginationMeta } from '../utils/helpers';

const router = Router();
router.use(authenticate);
router.use(requireAdminPermission('canManageCustomers'));

const customerSchema = z.object({
  name: z.string().min(1),
  businessName: z.string().optional(),
  commercialReg: z.string().optional(),
  taxNumber: z.string().optional(),
  phone: z.string().min(9),
  altPhone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  city: z.string().optional(),
  district: z.string().optional(),
  address: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'BLOCKED']).optional(),
  creditLimit: z.number().min(0).optional(),
  paymentDays: z.number().int().min(0).optional(),
});

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string | undefined;
    const status = req.query.status as string | undefined;

    const where = {
      tenantId: tid,
      ...(search && {
        OR: [
          { name: { contains: search } },
          { businessName: { contains: search } },
          { phone: { contains: search } },
          { code: { contains: search } },
        ],
      }),
      ...(status && { status: status as 'ACTIVE' | 'INACTIVE' | 'BLOCKED' }),
    };

    const [total, customers] = await Promise.all([
      prisma.customer.count({ where }),
      prisma.customer.findMany({
        where,
        ...paginate(page, limit),
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    res.json({ success: true, data: customers, pagination: paginationMeta(total, page, limit) });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, tenantId: tid },
      include: { customerPrices: { include: { product: true } } },
    });
    if (!customer) { res.status(404).json({ success: false, message: 'Ø§Ù„Ø¹Ù…ÙŠÙ„ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯' }); return; }
    res.json({ success: true, data: customer });
  } catch (err) { next(err); }
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // Ø§Ù„Ù…Ù†Ø¯ÙˆØ¨ ÙŠØ­ØªØ§Ø¬ ØµÙ„Ø§Ø­ÙŠØ© "Ø¥Ø¶Ø§ÙØ© Ø¹Ù…ÙŠÙ„"Ø› Ø§Ù„Ø¥Ø¯Ø§Ø±Ø© Ù…Ø³Ù…ÙˆØ­ Ù„Ù‡Ø§ Ø¯Ø§Ø¦Ù…Ø§Ù‹
    if (req.user?.role === 'SALES_REP') {
      const rep = await prisma.salesRep.findUnique({ where: { id: req.user.id }, select: { canAddCustomer: true } });
      if (!rep?.canAddCustomer) {
        res.status(403).json({ success: false, message: 'Ù„ÙŠØ³ Ù„Ø¯ÙŠÙƒ ØµÙ„Ø§Ø­ÙŠØ© Ø¥Ø¶Ø§ÙØ© Ø¹Ù…Ù„Ø§Ø¡' });
        return;
      }
    }
    const data = customerSchema.parse(req.body);
    const customer = await prisma.customer.create({ data: { ...data, email: data.email || null, tenantId: tid } as any });
    res.status(201).json({ success: true, data: customer });
  } catch (err) { next(err); }
});

router.put('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // Ø§Ù„Ù…Ù†Ø¯ÙˆØ¨ ÙŠØ­ØªØ§Ø¬ ØµÙ„Ø§Ø­ÙŠØ© "ØªØ¹Ø¯ÙŠÙ„ Ø§Ù„Ø¹Ù…ÙŠÙ„"Ø› Ø§Ù„Ø¥Ø¯Ø§Ø±Ø© Ù…Ø³Ù…ÙˆØ­ Ù„Ù‡Ø§ Ø¯Ø§Ø¦Ù…Ø§Ù‹
    if (req.user?.role === 'SALES_REP') {
      const rep = await prisma.salesRep.findUnique({ where: { id: req.user.id }, select: { canEditCustomer: true } });
      if (!rep?.canEditCustomer) {
        res.status(403).json({ success: false, message: 'Ù„ÙŠØ³ Ù„Ø¯ÙŠÙƒ ØµÙ„Ø§Ø­ÙŠØ© ØªØ¹Ø¯ÙŠÙ„ Ø§Ù„Ø¹Ù…Ù„Ø§Ø¡' });
        return;
      }
    }
    // Ø§Ù„ØªØ­Ù‚Ù‚ Ø£Ù† Ø§Ù„Ø¹Ù…ÙŠÙ„ ÙŠØ®Øµ Ø´Ø±ÙƒØ© Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… Ù‚Ø¨Ù„ Ø§Ù„ØªØ¹Ø¯ÙŠÙ„
    const exists = await prisma.customer.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!exists) { res.status(404).json({ success: false, message: 'Ø§Ù„Ø¹Ù…ÙŠÙ„ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯' }); return; }
    const data = customerSchema.partial().parse(req.body);
    const customer = await prisma.customer.update({
      where: { id: req.params.id },
      data: { ...data, email: data.email || null },
    });
    res.json({ success: true, data: customer });
  } catch (err) { next(err); }
});

router.get('/:id/statement', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { from, to } = req.query;
    if (req.user?.role === 'SALES_REP') {
      const rep = await prisma.salesRep.findFirst({ where: { id: req.user.id, tenantId: tid }, select: { canViewStatement: true } });
      if (!rep?.canViewStatement) { res.status(403).json({ success: false, message: 'لا تملك صلاحية عرض كشف الحساب' }); return; }
    }
    const where = {
      customerId: req.params.id,
      tenantId: tid,
      ...(from && to && {
        entryDate: { gte: new Date(from as string), lte: new Date(to as string) },
      }),
    };
    const entries = await prisma.accountEntry.findMany({
      where,
      include: { invoice: true, receipt: true },
      orderBy: { entryDate: 'asc' },
    });
    const customer = await prisma.customer.findFirst({ where: { id: req.params.id, tenantId: tid } });
    if (!customer) { res.status(404).json({ success: false, message: 'Ø§Ù„Ø¹Ù…ÙŠÙ„ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯' }); return; }
    res.json({ success: true, data: { customer, entries } });
  } catch (err) { next(err); }
});

router.get('/:id/invoices', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const invoices = await prisma.invoice.findMany({
      where: { customerId: req.params.id, tenantId: tid },
      include: { salesRep: { select: { name: true } }, items: { include: { product: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: invoices });
  } catch (err) { next(err); }
});

router.put('/:id/prices', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const exists = await prisma.customer.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!exists) { res.status(404).json({ success: false, message: 'Ø§Ù„Ø¹Ù…ÙŠÙ„ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯' }); return; }
    const { prices } = req.body as { prices: { productId: string; price: number }[] };
    await prisma.$transaction(
      prices.map(p =>
        prisma.customerPrice.upsert({
          where: { customerId_productId: { customerId: req.params.id, productId: p.productId } },
          create: { customerId: req.params.id, productId: p.productId, price: p.price },
          update: { price: p.price },
        })
      )
    );
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;


