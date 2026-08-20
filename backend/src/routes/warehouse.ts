// ============================================================================
// مخزون الشركة (المستودع المركزيّ) — مرتبطٌ بمخزون السيارات.
// الرصيد محسوبٌ: الوارد + تسويات المستودع + العائد من السيارات − المحمّل لها.
// ============================================================================
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { computeWarehouseStock } from '../services/warehouseStock';

const router = Router();
router.use(authenticate);
// نفس صلاحية إدارة المخزون؛ المستودع مركزيّ على مستوى الشركة (لا يخصّ مندوباً)
router.use(requireAdminPermission('canManageVanStock'));

// حارس التفعيل: الميزة مطفأة افتراضياً، يُفعّلها المالك لكل شركة على حدة (طرح مدروس)
router.use(async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId(req) }, select: { warehouseEnabled: true } });
    if (!t?.warehouseEnabled) { res.status(403).json({ success: false, message: 'ميزة مخزون الشركة غير مفعلة لهذه الشركة' }); return; }
    next();
  } catch (err) { next(err); }
});

// رصيد مخزون الشركة لكل منتج (مع تفصيل الوارد/الخارج للسيارات/العائد)
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await computeWarehouseStock(tenantId(req)) });
  } catch (err) { next(err); }
});

const entrySchema = z.object({
  type: z.enum(['RECEIVE', 'ADJUST']).default('RECEIVE'),
  note: z.string().max(300).optional(),
  supplier: z.string().max(200).optional(),
  items: z.array(z.object({ productId: z.string(), qty: z.number() })).min(1),
});

// تسجيل وارد (استلام/شراء) أو تسوية للمستودع
router.post('/entries', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = entrySchema.parse(req.body);
    const items = data.items.filter((i) => i.qty !== 0);
    if (!items.length) { res.status(400).json({ success: false, message: 'لا توجد كميات صالحة' }); return; }
    // الوارد موجبٌ دائماً؛ التنقيص يكون تسويةً صريحة
    if (data.type === 'RECEIVE' && items.some((i) => i.qty < 0)) {
      res.status(400).json({ success: false, message: 'كمية الوارد يجب أن تكون موجبة استخدم تسوية للتنقيص' });
      return;
    }
    const productIds = [...new Set(items.map((i) => i.productId))];
    const valid = await prisma.product.count({ where: { id: { in: productIds }, tenantId: tid } });
    if (valid !== productIds.length) { res.status(400).json({ success: false, message: 'منتج غير صالح' }); return; }

    const by = req.user as { name?: string } | undefined;
    const entry = await prisma.warehouseEntry.create({
      data: {
        tenantId: tid, type: data.type, note: data.note, supplier: data.supplier, createdBy: by?.name,
        items: { create: items.map((i) => ({ productId: i.productId, qty: i.qty })) },
      },
      include: { items: { include: { product: { select: { id: true, name: true, unit: true } } } } },
    });
    res.status(201).json({ success: true, data: entry });
  } catch (err) { next(err); }
});

// سجلّ حركات المستودع (الوارد/التسوية) — للعرض والتصدير
router.get('/entries', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const entries = await prisma.warehouseEntry.findMany({
      where: { tenantId: tid },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { items: { include: { product: { select: { name: true, unit: true } } } } },
    });
    res.json({ success: true, data: entries });
  } catch (err) { next(err); }
});

export default router;
