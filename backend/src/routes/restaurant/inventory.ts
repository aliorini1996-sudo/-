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
    // انجراف طرح العائمة في القاعدة (1−0.7−0.2 = 0.10000000000000003) كان يعطل
    // انذار النفاد ويعرض 17 خانة — نقرب القراءة والمقارنة معا
    const data = ingredients.map(i => ({
      ...i,
      stockQty: roundDecimal(i.stockQty, 4),
      lowStock: roundDecimal(i.stockQty, 4) <= i.minQty,
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
    // الرصيد الافتتاحي وحركته ذرّيان معاً — لا رصيد بلا حركة مقابِلة
    const ing = await prisma.$transaction(async tx => {
      const created = await tx.ingredient.create({
        data: { ...body, tenantId: tid, stockQty: openingQty ?? 0, avgCost: openingCost ?? 0 } as any,
      });
      if (openingQty && openingQty > 0) {
        await tx.ingredientMovement.create({
          data: { tenantId: tid, ingredientId: created.id, type: 'PURCHASE', qty: openingQty, unitCost: openingCost ?? 0, reason: 'رصيد افتتاحي' },
        });
      }
      return created;
    });
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
    // الحذف يُسقط أسطر الوصفات وسجلّ الحركات عبر Cascade فتنخفض تكلفة الأصناف صامتةً — امنعه عند الاستخدام
    const used = await prisma.recipeItem.count({ where: { ingredientId: req.params.id, tenantId: tid } });
    if (used > 0) {
      res.status(409).json({ success: false, message: 'المكوّن مستخدم في وصفات — أزِله منها أولاً أو عطّله بدل حذفه' });
      return;
    }
    await prisma.ingredient.delete({ where: { id: req.params.id } });
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
    }).superRefine((v, ctx) => {
      if ((v.type === 'PURCHASE' || v.type === 'WASTE') && v.qty <= 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'الكمية يجب أن تكون أكبر من صفر', path: ['qty'] });
      }
      // الشراء بلا تكلفة يرفع الكمية ويُبقي المتوسّط كما هو ⇒ تقييم مخزون خاطئ
      if (v.type === 'PURCHASE' && (v.unitCost == null || v.unitCost <= 0)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'تكلفة الوحدة مطلوبة عند الشراء', path: ['unitCost'] });
      }
    }).parse(req.body);

    const delta = type === 'PURCHASE' ? qty : type === 'WASTE' ? -Math.abs(qty) : qty; // ADJUST يقبل موجباً/سالباً

    // القراءة والكتابة داخل معاملة واحدة، والرصيد يُحدَّث ذرّياً بـincrement (لا قيمة مطلقة من
    // قراءة قديمة) — وإلا محت هذه الحركة خصومات البيع المتزامنة من الكاشير.
    const done = await prisma.$transaction(async tx => {
      const cur = await tx.ingredient.findFirst({ where: { id: req.params.id, tenantId: tid } });
      if (!cur) return false;
      let avgCost = cur.avgCost;
      if (type === 'PURCHASE' && unitCost != null) {
        // أساس الترجيح لا ينزل تحت الصفر حتى لا ينحرف المتوسّط عند رصيد سالب
        const base = Math.max(0, cur.stockQty);
        const newQty = base + qty;
        avgCost = newQty > 0 ? roundDecimal((base * cur.avgCost + qty * unitCost) / newQty, 4) : unitCost;
      }
      await tx.ingredient.update({ where: { id: cur.id }, data: { stockQty: { increment: delta }, avgCost } });
      await tx.ingredientMovement.create({
        data: { tenantId: tid, ingredientId: cur.id, type, qty: delta, unitCost: unitCost ?? null, reason: reason || null },
      });
      return true;
    });
    if (!done) { res.status(404).json({ success: false, message: 'المكوّن غير موجود' }); return; }
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
    // دمج المكوّن المكرّر (تُجمع كمياته) — وإلا انتهك @@unique([menuItemId,ingredientId]) بخطأ 500 غامض
    const merged = [...items.reduce((m, i) => m.set(i.ingredientId, (m.get(i.ingredientId) ?? 0) + i.qty), new Map<string, number>())]
      .map(([ingredientId, qty]) => ({ ingredientId, qty }));
    if (merged.length) {
      const ids = merged.map(i => i.ingredientId);
      const cnt = await prisma.ingredient.count({ where: { id: { in: ids }, tenantId: tid } });
      if (cnt !== ids.length) { res.status(400).json({ success: false, message: 'أحد المكوّنات غير موجود' }); return; }
    }
    await prisma.$transaction(async tx => {
      await tx.recipeItem.deleteMany({ where: { menuItemId: menuItem.id } });
      if (merged.length) {
        await tx.recipeItem.createMany({
          data: merged.map(i => ({ tenantId: tid, menuItemId: menuItem.id, ingredientId: i.ingredientId, qty: i.qty })),
        });
      }
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
