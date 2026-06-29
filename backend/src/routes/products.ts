import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { paginate, paginationMeta } from '../utils/helpers';

const router = Router();
router.use(authenticate); // القراءة متاحة للمندوب (للبحث عند إصدار الفاتورة)؛ الكتابة للإدارة فقط
router.use(requireAdminPermission('canManageProducts'));

const productSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  barcode: z.string().optional(),
  unit: z.string().min(1),
  basePrice: z.number().min(0),
  taxPct: z.number().min(0).max(100).default(15),
  image: z.string().nullish().or(z.literal('')), // صورة الصنف (base64 data URL)
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  categoryId: z.string().optional(),
});

const categorySchema = z.object({ name: z.string().min(1) });

const priceTierSchema = z.array(z.object({
  minQty: z.number().min(0),
  maxQty: z.number().optional(),
  price: z.number().min(0),
}));

router.get('/categories', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const cats = await prisma.productCategory.findMany({ where: { tenantId: tid }, orderBy: { name: 'asc' } });
    res.json({ success: true, data: cats });
  } catch (err) { next(err); }
});

router.post('/categories', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = categorySchema.parse(req.body);
    const cat = await prisma.productCategory.create({ data: { ...data, tenantId: tid } as any });
    res.status(201).json({ success: true, data: cat });
  } catch (err) { next(err); }
});

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const search = req.query.search as string | undefined;
    const categoryId = req.query.categoryId as string | undefined;
    const status = req.query.status as string | undefined;

    const where = {
      tenantId: tid,
      ...(search && {
        OR: [
          { name: { contains: search } },
          { code: { contains: search } },
          { barcode: { contains: search } },
        ],
      }),
      ...(categoryId && { categoryId }),
      ...(status && { status: status as 'ACTIVE' | 'INACTIVE' }),
    };

    const [total, products] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        include: { category: true, priceTiers: { orderBy: { minQty: 'asc' } } },
        ...paginate(page, limit),
        orderBy: { name: 'asc' },
      }),
    ]);

    res.json({ success: true, data: products, pagination: paginationMeta(total, page, limit) });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, tenantId: tid },
      include: { category: true, priceTiers: { orderBy: { minQty: 'asc' } } },
    });
    if (!product) { res.status(404).json({ success: false, message: 'الصنف غير موجود' }); return; }
    res.json({ success: true, data: product });
  } catch (err) { next(err); }
});

router.post('/', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = productSchema.parse(req.body);
    const product = await prisma.product.create({ data: { ...data, categoryId: data.categoryId || null, image: data.image || null, tenantId: tid } as any, include: { category: true } });
    res.status(201).json({ success: true, data: product });
  } catch (err) { next(err); }
});

router.put('/:id', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const exists = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!exists) { res.status(404).json({ success: false, message: 'الصنف غير موجود' }); return; }
    const data = productSchema.partial().parse(req.body);
    const updateData: Record<string, unknown> = { ...data };
    if ('categoryId' in updateData) updateData.categoryId = updateData.categoryId || null;
    if ('image' in updateData) updateData.image = updateData.image || null;
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: updateData,
      include: { category: true },
    });
    res.json({ success: true, data: product });
  } catch (err) { next(err); }
});

router.put('/:id/price-tiers', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const exists = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!exists) { res.status(404).json({ success: false, message: 'الصنف غير موجود' }); return; }
    const tiers = priceTierSchema.parse(req.body.tiers);
    await prisma.$transaction([
      prisma.priceTier.deleteMany({ where: { productId: req.params.id } }),
      ...tiers.map(t => prisma.priceTier.create({ data: { productId: req.params.id, ...t } as any })),
    ]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;

