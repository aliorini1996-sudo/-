import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../config/database';
import { requireAdmin, tenantId } from '../../middleware/auth';
import { AuthRequest } from '../../types';

// إدارة الصالات والطاولات. القراءة لأي مستخدم مطعم (خريطة الصالة في M3)؛ الكتابة للإدارة.
const router = Router();

// يتحقّق أنّ الصالة المُشار إليها تخصّ نفس المطعم — منع ربط عابر للشركات
async function areaError(tid: string, areaId: string | null | undefined): Promise<string | null> {
  if (areaId) {
    const a = await prisma.restaurantArea.findFirst({ where: { id: areaId, tenantId: tid }, select: { id: true } });
    if (!a) return 'الصالة غير موجودة';
  }
  return null;
}

// ---------- كل الصالات مع طاولاتها ----------
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const [areas, tables] = await Promise.all([
      prisma.restaurantArea.findMany({ where: { tenantId: tid }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
      prisma.restaurantTable.findMany({ where: { tenantId: tid }, orderBy: [{ createdAt: 'asc' }] }),
    ]);
    res.json({ success: true, data: { areas, tables } });
  } catch (err) { next(err); }
});

// ---------- الصالات ----------
const areaSchema = z.object({
  name: z.string().min(1),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

router.post('/areas', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = areaSchema.parse(req.body);
    const area = await prisma.restaurantArea.create({ data: { ...body, tenantId: tid } as any });
    res.status(201).json({ success: true, data: area });
  } catch (err) { next(err); }
});

router.put('/areas/:id', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = areaSchema.partial().parse(req.body);
    const exists = await prisma.restaurantArea.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!exists) { res.status(404).json({ success: false, message: 'الصالة غير موجودة' }); return; }
    const area = await prisma.restaurantArea.update({ where: { id: req.params.id }, data: body });
    res.json({ success: true, data: area });
  } catch (err) { next(err); }
});

router.delete('/areas/:id', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const exists = await prisma.restaurantArea.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!exists) { res.status(404).json({ success: false, message: 'الصالة غير موجودة' }); return; }
    // حذف الصالة يترك طاولاتها بلا صالة (areaId=null عبر FK) — لا تُحذف الطاولات
    await prisma.restaurantArea.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ---------- الطاولات ----------
const tableSchema = z.object({
  number: z.string().min(1),
  seats: z.number().int().min(1).optional(),
  areaId: z.string().nullish(),
  posX: z.number().nullish(),
  posY: z.number().nullish(),
  status: z.enum(['FREE', 'OCCUPIED', 'BILL_REQUESTED', 'RESERVED']).optional(),
  isActive: z.boolean().optional(),
});

router.post('/', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = tableSchema.parse(req.body);
    const aErr = await areaError(tid, body.areaId);
    if (aErr) { res.status(400).json({ success: false, message: aErr }); return; }
    const table = await prisma.restaurantTable.create({ data: { ...body, tenantId: tid, areaId: body.areaId || null } as any });
    res.status(201).json({ success: true, data: table });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') { res.status(409).json({ success: false, message: 'رقم الطاولة مستخدم مسبقاً' }); return; }
    next(err);
  }
});

router.put('/:id', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const parsed = tableSchema.partial().parse(req.body);
    const exists = await prisma.restaurantTable.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!exists) { res.status(404).json({ success: false, message: 'الطاولة غير موجودة' }); return; }
    // طبّع areaId ('' → null) وتحقّق من ملكية الصالة لنفس المطعم
    const normArea = parsed.areaId === '' ? null : parsed.areaId;
    const aErr = await areaError(tid, normArea);
    if (aErr) { res.status(400).json({ success: false, message: aErr }); return; }
    const body = 'areaId' in req.body ? { ...parsed, areaId: normArea } : parsed;
    const table = await prisma.restaurantTable.update({ where: { id: req.params.id }, data: body as any });
    res.json({ success: true, data: table });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') { res.status(409).json({ success: false, message: 'رقم الطاولة مستخدم مسبقاً' }); return; }
    next(err);
  }
});

router.delete('/:id', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const exists = await prisma.restaurantTable.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!exists) { res.status(404).json({ success: false, message: 'الطاولة غير موجودة' }); return; }
    await prisma.restaurantTable.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
