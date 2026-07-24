import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../config/database';
import { requireAdmin, tenantId } from '../../middleware/auth';
import { AuthRequest } from '../../types';
import { roundDecimal } from '../../utils/helpers';

// المخزون والوصفات (M6). محمي بالمصادقة + requireVertical('restaurant') بالأعلى.
const router = Router();

// قائمة المكوّنات + علم النفاد + قيمة المخزون
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const ingredients = await prisma.ingredient.findMany({ where: { tenantId: tid }, orderBy: [{ name: 'asc' }] });
    const data = ingredients.map(i => ({
      ...i,
      lowStock: i.stockQty <= i.minQty,
      stockValue: roundDecimal(i.stockQty * i.avgCost, 2),
    }));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

const ingredientSchema = z.object({
  name: z.string().min(1),
  unit: z.string().min(1).optional(),
  minQty: z.number().min(0).optional(),
  isActive: z.boolean().optional(),
  // الرصيد الافتتاحي وتكلفته (عند الإنشاء فقط)
  openingQty: z.number().min(0).optional(),
  openingCost: z.number().min(0).optional(),
});

router.post('/ingredients', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { openingQty, openingCost, ...body } = ingredientSchema.parse(req.body);
    const ing = await prisma.ingredient.create({
      data: { ...body, tenantId: tid, stockQty: openingQty ?? 0, avgCost: openingCost ?? 0 } as any,
    });
    if (openingQty && openingQty > 0) {
      await prisma.ingredientMovement.create({
        data: { tenantId: tid, ingredientId: ing.id, type: 'PURCHASE', qty: openingQty, unitCost: openingCost ?? 0, reason: 'رصيد افتتاحي' },
      });
    }
    res.status(201).json({ success: true, data: ing });
  } catch (err) { next(err); }
});

router.put('/ingredients/:id', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { openingQty: _o, openingCost: _c, ...body } = ingredientSchema.partial().parse(req.body);
    const exists = await prisma.ingredient.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!exists) { res.status(404).json({ success: false, message: 'المكوّن غير موجود' }); return; }
    const ing = await prisma.ingredient.update({ where: { id: req.params.id }, data: body as any });
    res.json({ success: true, data: ing });
  } catch (err) { next(err); }
});

router.delete('/ingredients/:id', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const exists = await prisma.ingredient.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!exists) { res.status(404).json({ success: false, message: 'المكوّن غير موجود' }); return; }
    await prisma.ingredient.delete({ where: { id: req.params.id } }); // يحذف أسطر الوصفات وحركاته عبر Cascade
    res.json({ success: true });
  } catch (err) { next(err); }
});

// حركة مخزون يدوية: شراء (يحدّث متوسّط التكلفة) / تسوية (كمية موجبة أو سالبة) / هدر
router.post('/ingredients/:id/movement', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { type, qty, unitCost, reason } = z.object({
      type: z.enum(['PURCHASE', 'ADJUST', 'WASTE']),
      qty: z.number(),
      unitCost: z.number().min(0).nullish(),
      reason: z.string().nullish(),
    }).parse(req.body);
    if ((type === 'PURCHASE' || type === 'WASTE') && qty <= 0) {
      res.status(400).json({ success: false, message: 'الكمية يجب أن تكون أكبر من صفر' }); return;
    }
    const ing = await prisma.ingredient.findFirst({ where: { id: req.params.id, tenantId: tid } });
    if (!ing) { res.status(404).json({ success: false, message: 'المكوّن غير موجود' }); return; }

    const delta = type === 'PURCHASE' ? qty : type === 'WASTE' ? -Math.abs(qty) : qty; // ADJUST يقبل موجباً/سالباً
    // متوسّط التكلفة المرجّح — يُحدَّث عند الشراء بتكلفة معلومة فقط
    let avgCost = ing.avgCost;
    if (type === 'PURCHASE' && unitCost != null) {
      const newQty = ing.stockQty + qty;
      avgCost = newQty > 0 ? roundDecimal((ing.stockQty * ing.avgCost + qty * unitCost) / newQty, 4) : unitCost;
    }

    await prisma.$transaction([
      prisma.ingredient.update({ where: { id: ing.id }, data: { stockQty: roundDecimal(ing.stockQty + delta, 4), avgCost } }),
      prisma.ingredientMovement.create({
        data: { tenantId: tid, ingredientId: ing.id, type, qty: delta, unitCost: unitCost ?? null, reason: reason || null },
      }),
    ]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// وصفة صنف
router.get('/menu-items/:id/recipe', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const items = await prisma.recipeItem.findMany({
      where: { tenantId: tid, menuItemId: req.params.id },
      include: { ingredient: { select: { id: true, name: true, unit: true, avgCost: true } } },
    });
    const cost = roundDecimal(items.reduce((s, r) => s + r.qty * r.ingredient.avgCost, 0), 4);
    res.json({ success: true, data: { items, cost } });
  } catch (err) { next(err); }
});

// استبدال وصفة صنف بالكامل
router.put('/menu-items/:id/recipe', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { items } = z.object({
      items: z.array(z.object({ ingredientId: z.string(), qty: z.number().positive() })),
    }).parse(req.body);
    const menuItem = await prisma.menuItem.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!menuItem) { res.status(404).json({ success: false, message: 'الصنف غير موجود' }); return; }
    if (items.length) {
      const ids = [...new Set(items.map(i => i.ingredientId))];
      const cnt = await prisma.ingredient.count({ where: { id: { in: ids }, tenantId: tid } });
      if (cnt !== ids.length) { res.status(400).json({ success: false, message: 'أحد المكوّنات غير موجود' }); return; }
    }
    await prisma.$transaction(async tx => {
      await tx.recipeItem.deleteMany({ where: { menuItemId: menuItem.id } });
      if (items.length) {
        await tx.recipeItem.createMany({
          data: items.map(i => ({ tenantId: tid, menuItemId: menuItem.id, ingredientId: i.ingredientId, qty: i.qty })),
        });
      }
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
