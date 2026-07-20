import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../config/database';
import { requireAdmin, tenantId } from '../../middleware/auth';
import { AuthRequest } from '../../types';

// إدارة قائمة المطعم — أقسام/أصناف/مجموعات إضافات. القراءة متاحة لأي مستخدم مطعم
// (الكاشير يقرأ القائمة في M3)؛ الكتابة للإدارة فقط. العزل بـtenantId + requireVertical (بالأعلى).
const router = Router();

// يتحقّق أنّ القسم/مجموعات الإضافات المُشار إليها تخصّ نفس المطعم — منع ربط عابر للشركات
async function refError(tid: string, categoryId: string | null | undefined, groupIds: string[] | undefined): Promise<string | null> {
  if (categoryId) {
    const c = await prisma.menuCategory.findFirst({ where: { id: categoryId, tenantId: tid }, select: { id: true } });
    if (!c) return 'القسم غير موجود';
  }
  if (groupIds?.length) {
    const cnt = await prisma.modifierGroup.count({ where: { id: { in: groupIds }, tenantId: tid } });
    if (cnt !== new Set(groupIds).size) return 'إحدى مجموعات الإضافات غير موجودة';
  }
  return null;
}

// ---------- القائمة الكاملة (أقسام + أصناف مسطّحة + مجموعات إضافات) ----------
// الأصناف تُجلب مسطّحةً (لا متداخلةً تحت الأقسام) حتى تظهر الأصناف بلا قسم (categoryId=null) أيضاً.
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const [categories, items, groups] = await Promise.all([
      prisma.menuCategory.findMany({
        where: { tenantId: tid },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      prisma.menuItem.findMany({
        where: { tenantId: tid },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        include: { modifierGroups: { select: { groupId: true } } },
      }),
      prisma.modifierGroup.findMany({
        where: { tenantId: tid },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        include: { modifiers: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
      }),
    ]);
    res.json({ success: true, data: { categories, items, groups } });
  } catch (err) { next(err); }
});

// ---------- الأقسام ----------
const categorySchema = z.object({
  name: z.string().min(1),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

router.post('/categories', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = categorySchema.parse(req.body);
    const cat = await prisma.menuCategory.create({ data: { ...body, tenantId: tid } as any });
    res.status(201).json({ success: true, data: cat });
  } catch (err) { next(err); }
});

router.put('/categories/:id', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = categorySchema.partial().parse(req.body);
    const exists = await prisma.menuCategory.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!exists) { res.status(404).json({ success: false, message: 'القسم غير موجود' }); return; }
    const cat = await prisma.menuCategory.update({ where: { id: req.params.id }, data: body });
    res.json({ success: true, data: cat });
  } catch (err) { next(err); }
});

router.delete('/categories/:id', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const exists = await prisma.menuCategory.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!exists) { res.status(404).json({ success: false, message: 'القسم غير موجود' }); return; }
    // حذف القسم يترك أصنافه بلا قسم (categoryId=null عبر FK) — لا تُحذف الأصناف
    await prisma.menuCategory.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ---------- الأصناف ----------
const itemSchema = z.object({
  code: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().nullish(),
  basePrice: z.number().min(0),
  taxPct: z.number().min(0).max(100).optional(),
  costPrice: z.number().min(0).optional(),
  prepStation: z.enum(['KITCHEN', 'BAR', 'GRILL', 'COLD']).optional(),
  itemCode: z.string().nullish(),
  image: z.string().nullish().or(z.literal('')),
  isAvailable: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  categoryId: z.string().nullish(),
  groupIds: z.array(z.string()).optional(), // مجموعات الإضافات المرتبطة بالصنف
});

router.get('/items', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const where: Record<string, unknown> = { tenantId: tid };
    if (req.query.categoryId) where.categoryId = String(req.query.categoryId);
    const items = await prisma.menuItem.findMany({
      where, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { modifierGroups: { select: { groupId: true } } },
    });
    res.json({ success: true, data: items });
  } catch (err) { next(err); }
});

router.post('/items', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { groupIds, categoryId, ...body } = itemSchema.parse(req.body);
    const refErr = await refError(tid, categoryId, groupIds);
    if (refErr) { res.status(400).json({ success: false, message: refErr }); return; }
    const code = body.code || `ITM-${Date.now().toString(36).toUpperCase()}`;
    const item = await prisma.menuItem.create({
      data: {
        ...body, code, tenantId: tid,
        categoryId: categoryId || null,
        modifierGroups: groupIds?.length
          ? { create: groupIds.map((groupId, i) => ({ groupId, sortOrder: i })) }
          : undefined,
      } as any,
    });
    res.status(201).json({ success: true, data: item });
  } catch (err) { next(err); }
});

router.put('/items/:id', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { groupIds, categoryId, ...rest } = itemSchema.partial().parse(req.body);
    const exists = await prisma.menuItem.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!exists) { res.status(404).json({ success: false, message: 'الصنف غير موجود' }); return; }
    // طبّع categoryId ('' → null) وتحقّق من ملكية القسم/المجموعات لنفس المطعم
    const normCat = categoryId === '' ? null : categoryId;
    const refErr = await refError(tid, normCat ?? undefined, groupIds);
    if (refErr) { res.status(400).json({ success: false, message: refErr }); return; }
    const body = 'categoryId' in req.body ? { ...rest, categoryId: normCat } : rest;
    // تحديث الصنف + إعادة ضبط روابط المجموعات إن أُرسلت groupIds
    await prisma.$transaction(async tx => {
      await tx.menuItem.update({ where: { id: req.params.id }, data: body as any });
      if (groupIds) {
        await tx.menuItemModifierGroup.deleteMany({ where: { menuItemId: req.params.id } });
        if (groupIds.length) {
          await tx.menuItemModifierGroup.createMany({ data: groupIds.map((groupId, i) => ({ menuItemId: req.params.id, groupId, sortOrder: i })) });
        }
      }
    });
    const updated = await prisma.menuItem.findUnique({ where: { id: req.params.id }, include: { modifierGroups: { select: { groupId: true } } } });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

router.delete('/items/:id', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const exists = await prisma.menuItem.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!exists) { res.status(404).json({ success: false, message: 'الصنف غير موجود' }); return; }
    await prisma.menuItem.delete({ where: { id: req.params.id } }); // يحذف روابط المجموعات عبر Cascade
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ---------- مجموعات الإضافات + خياراتها ----------
const groupSchema = z.object({
  name: z.string().min(1),
  minSelect: z.number().int().min(0).optional(),
  maxSelect: z.number().int().min(1).optional(),
  sortOrder: z.number().int().optional(),
  modifiers: z.array(z.object({
    name: z.string().min(1),
    priceDelta: z.number().optional(),
    isDefault: z.boolean().optional(),
  })).optional(),
});

router.get('/groups', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const groups = await prisma.modifierGroup.findMany({
      where: { tenantId: tid }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { modifiers: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
    });
    res.json({ success: true, data: groups });
  } catch (err) { next(err); }
});

router.post('/groups', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { modifiers, ...body } = groupSchema.parse(req.body);
    const group = await prisma.modifierGroup.create({
      data: {
        ...body, tenantId: tid,
        modifiers: modifiers?.length
          ? { create: modifiers.map((m, i) => ({ ...m, tenantId: tid, sortOrder: i })) }
          : undefined,
      } as any,
      include: { modifiers: true },
    });
    res.status(201).json({ success: true, data: group });
  } catch (err) { next(err); }
});

router.put('/groups/:id', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { modifiers, ...body } = groupSchema.partial().parse(req.body);
    const exists = await prisma.modifierGroup.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!exists) { res.status(404).json({ success: false, message: 'المجموعة غير موجودة' }); return; }
    // استبدال كامل للخيارات إن أُرسلت (أبسط من التزامن الجزئي)
    await prisma.$transaction(async tx => {
      await tx.modifierGroup.update({ where: { id: req.params.id }, data: body });
      if (modifiers) {
        await tx.modifier.deleteMany({ where: { groupId: req.params.id } });
        if (modifiers.length) {
          await tx.modifier.createMany({ data: modifiers.map((m, i) => ({ ...m, groupId: req.params.id, tenantId: tid, sortOrder: i })) as any });
        }
      }
    });
    const updated = await prisma.modifierGroup.findUnique({ where: { id: req.params.id }, include: { modifiers: { orderBy: { sortOrder: 'asc' } } } });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

router.delete('/groups/:id', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const exists = await prisma.modifierGroup.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!exists) { res.status(404).json({ success: false, message: 'المجموعة غير موجودة' }); return; }
    await prisma.modifierGroup.delete({ where: { id: req.params.id } }); // يحذف الخيارات والروابط عبر Cascade
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
