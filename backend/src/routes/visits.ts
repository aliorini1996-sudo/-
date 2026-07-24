import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { canAccessCustomer } from '../services/customerScope';

/**
 * الزيارات الميدانية — يسجّلها المندوب عند العميل (ملاحظة + صور + موقع GPS)، وتراها
 * الإدارة/المشرف من خريطة التتبّع. تُلتقط أوف‑لاين وتُرفع عبر الصفّ الصادر (clientRef).
 */
const router = Router();
router.use(authenticate);

const createVisitSchema = z.object({
  customerId: z.string().optional(),
  // العمل دون اتصال: بديل customerId حين يشير لعميل أُنشئ أوف‑لاين (يحلّه الخادم إلى id الحقيقي)
  customerClientRef: z.string().uuid().optional(),
  note: z.string().max(2000).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  // صور بصيغة data URL (مضغوطة على العميل) — حدّ معقول يحمي القاعدة
  photos: z.array(z.string().max(2_500_000)).max(8).optional(),
  clientRef: z.string().uuid().optional(), // idempotency للأوف‑لاين
  createdAt: z.string().optional(),        // لحظة الزيارة على الجهاز (قد تسبق الرفع)
}).refine((d) => !!d.customerId || !!d.customerClientRef, {
  message: 'يجب تحديد العميل (customerId أو customerClientRef)',
});

// المندوب يسجّل زيارة (مع صورها) — أو الإدارة نيابةً بتحديد المندوب
router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = createVisitSchema.parse(req.body);

    // idempotency: زيارة سبق رفعها (نفس clientRef) تُعاد بدل تكرار
    if (body.clientRef) {
      const existing = await prisma.repVisit.findFirst({
        where: { tenantId: tid, clientRef: body.clientRef },
        include: { _count: { select: { photos: true } } },
      });
      if (existing) { res.status(200).json({ success: true, data: existing, idempotent: true }); return; }
    }

    const salesRepId = req.user!.role === 'SALES_REP' ? req.user!.id
      : (req.body.salesRepId as string | undefined);
    if (!salesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }

    // حلّ تبعية العميل: عميل أُنشئ أوف‑لاين (customerClientRef) يُحلّ إلى id الحقيقي
    let customerId = body.customerId;
    if (body.customerClientRef) {
      const ref = await prisma.customer.findFirst({
        where: { tenantId: tid, clientRef: body.customerClientRef }, select: { id: true },
      });
      if (!ref) { res.status(400).json({ success: false, message: 'العميل المرجعي لم يُرفع بعد — أعِد المزامنة' }); return; }
      customerId = ref.id;
    }
    if (!customerId) { res.status(400).json({ success: false, message: 'يجب تحديد العميل' }); return; }

    const customer = await prisma.customer.findFirst({ where: { id: customerId, tenantId: tid }, select: { id: true } });
    if (!customer) { res.status(404).json({ success: false, message: 'العميل غير موجود' }); return; }
    // عزل العملاء: يُمنع تسجيل زيارة لعميل غير مُسنَد للمندوب
    if (!(await canAccessCustomer(req, tid, customerId))) {
      res.status(403).json({ success: false, message: 'هذا العميل غير مُسنَد لك' });
      return;
    }

    const visit = await prisma.repVisit.create({
      data: {
        tenantId: tid,
        salesRepId,
        customerId,
        note: body.note || null,
        lat: body.lat ?? null,
        lng: body.lng ?? null,
        clientRef: body.clientRef,
        ...(body.createdAt ? { createdAt: new Date(body.createdAt) } : {}),
        photos: body.photos?.length ? { create: body.photos.map((data) => ({ data })) } : undefined,
      },
      include: { _count: { select: { photos: true } } },
    });

    res.status(201).json({ success: true, data: visit });
  } catch (err) { next(err); }
});

// قائمة زيارات مندوب في يوم (للإدارة/المشرف) — بلا الصور (عدّها فقط)، الأحدث أولاً
router.get('/', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const salesRepId = req.query.salesRepId as string | undefined;
    if (!salesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }
    const dateStr = (req.query.date as string | undefined) || new Date().toISOString().slice(0, 10);
    const start = new Date(`${dateStr}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

    const visits = await prisma.repVisit.findMany({
      where: { tenantId: tid, salesRepId, createdAt: { gte: start, lt: end } },
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        _count: { select: { photos: true } },
      },
      take: 500,
    });
    res.json({ success: true, data: visits });
  } catch (err) { next(err); }
});

// عدد زيارات كل مندوب في يوم — لعرض العدّاد على الخريطة الحيّة (للإدارة)
router.get('/count-by-rep', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const dateStr = (req.query.date as string | undefined) || new Date().toISOString().slice(0, 10);
    const start = new Date(`${dateStr}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

    const rows = await prisma.repVisit.groupBy({
      by: ['salesRepId'],
      where: { tenantId: tid, createdAt: { gte: start, lt: end } },
      _count: { _all: true },
    });
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.salesRepId] = r._count._all;
    res.json({ success: true, data: counts });
  } catch (err) { next(err); }
});

// تفاصيل زيارة واحدة مع صورها كاملة (تُحمَّل عند الطلب فقط)
router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const visit = await prisma.repVisit.findFirst({
      where: { id: req.params.id, tenantId: tid },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        salesRep: { select: { id: true, name: true } },
        photos: { select: { id: true, data: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!visit) { res.status(404).json({ success: false, message: 'الزيارة غير موجودة' }); return; }
    // المندوب لا يرى إلا زياراته
    if (req.user?.role === 'SALES_REP' && visit.salesRepId !== req.user.id) {
      res.status(404).json({ success: false, message: 'الزيارة غير موجودة' }); return;
    }
    res.json({ success: true, data: visit });
  } catch (err) { next(err); }
});

export default router;
