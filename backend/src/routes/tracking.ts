import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { snapToRoads } from '../services/mapMatch';

const router = Router();
router.use(authenticate);
router.use(requireAdminPermission('canManageTracking'));

// إعدادات التتبّع — هل التتبّع مفعّل على مستوى الشركة
router.get('/settings', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const s = await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { trackingEnabled: true } });
    res.json({ success: true, data: { enabled: s?.trackingEnabled ?? false } });
  } catch (err) { next(err); }
});

router.patch('/settings', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const enabled = z.object({ enabled: z.boolean() }).parse(req.body).enabled;
    await prisma.companySettings.update({ where: { tenantId: tid }, data: { trackingEnabled: enabled } });
    res.json({ success: true, data: { enabled } });
  } catch (err) { next(err); }
});

const pingSchema = z.object({
  points: z.array(z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy: z.number().optional(),
    speed: z.number().nullable().optional(),
    capturedAt: z.string().optional(),
  })).min(1).max(200),
});

// استقبال نقاط موقع المندوب (دفعة) — يخزّنها ويحدّث آخر موقع معروف
router.post('/ping', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user?.role !== 'SALES_REP') { res.status(403).json({ success: false, message: 'غير مسموح' }); return; }
    const tid = tenantId(req);
    const repId = req.user.id;
    const { points } = pingSchema.parse(req.body);

    // احترام إعدادات الخصوصية: لا نخزّن إن كان التتبّع موقوفاً أو المندوب مستثنى
    const [settings, rep] = await Promise.all([
      prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { trackingEnabled: true } }),
      prisma.salesRep.findFirst({ where: { id: repId, tenantId: tid }, select: { canBeTracked: true } }),
    ]);
    if (!settings?.trackingEnabled || rep?.canBeTracked === false) {
      res.json({ success: true, data: { stored: 0, disabled: true } });
      return;
    }

    const rows = points.map(p => ({
      tenantId: tid, salesRepId: repId, lat: p.lat, lng: p.lng,
      accuracy: p.accuracy ?? null, speed: p.speed ?? null,
      capturedAt: p.capturedAt ? new Date(p.capturedAt) : new Date(),
    }));
    await prisma.repLocation.createMany({ data: rows });

    // أحدث نقطة = آخر موقع معروف
    const latest = rows.reduce((a, b) => (a.capturedAt > b.capturedAt ? a : b));
    await prisma.salesRep.update({
      where: { id: repId },
      data: { lastLat: latest.lat, lastLng: latest.lng, lastSeenAt: latest.capturedAt },
    });

    res.json({ success: true, data: { stored: rows.length } });
  } catch (err) { next(err); }
});

// نبضة حضور من تطبيق المندوب — تُمدّد جلسة العمل الحالية أو تبدأ جديدة (مستقلّة عن GPS).
// تُحسب منها ساعات العمل (الوقت الذي كان فيه متصلاً وفاتحاً التطبيق).
router.post('/heartbeat', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user?.role !== 'SALES_REP') { res.status(403).json({ success: false, message: 'غير مسموح' }); return; }
    const tid = tenantId(req);
    const repId = req.user.id;
    const now = new Date();
    const GAP_MS = 3 * 60 * 1000; // فجوة أكبر من 3 دقائق ⇒ جلسة جديدة (اعتُبر التطبيق مُغلقاً)

    const last = await prisma.repSession.findFirst({
      where: { tenantId: tid, salesRepId: repId },
      orderBy: { lastBeatAt: 'desc' },
      select: { id: true, lastBeatAt: true },
    });
    if (last && now.getTime() - new Date(last.lastBeatAt).getTime() <= GAP_MS) {
      await prisma.repSession.update({ where: { id: last.id }, data: { lastBeatAt: now } });
    } else {
      await prisma.repSession.create({ data: { tenantId: tid, salesRepId: repId, startedAt: now, lastBeatAt: now } });
    }
    // آخر ظهور = الآن (يجعل مؤشّر «متصل» يعكس فتح التطبيق حتى بلا GPS)
    await prisma.salesRep.update({ where: { id: repId }, data: { lastSeenAt: now } });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// المواقع الحالية لكل المناديب — للأدمن (الخريطة الحيّة) مع عدّاد زيارات اليوم
router.get('/live', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);

    const [reps, visitRows] = await Promise.all([
      // كل المناديب النشطين (لا فقط من أرسل موقعاً) — كي يظهر المضاف حديثاً فوراً؛
      // من له موقع أوّلاً (nulls last)، ومن لم يُحدّد موقعه بعد يظهر بلا دبّوس على الخريطة
      prisma.salesRep.findMany({
        where: { tenantId: tid, isActive: true },
        select: { id: true, name: true, phone: true, isActive: true, lastLat: true, lastLng: true, lastSeenAt: true },
        orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }],
      }),
      prisma.repVisit.groupBy({
        by: ['salesRepId'],
        where: { tenantId: tid, createdAt: { gte: dayStart } },
        _count: { _all: true },
      }),
    ]);
    const visitsByRep: Record<string, number> = {};
    for (const r of visitRows) visitsByRep[r.salesRepId] = r._count._all;

    res.json({ success: true, data: reps.map(r => ({ ...r, visitsToday: visitsByRep[r.id] || 0 })) });
  } catch (err) { next(err); }
});

// خطّ سير مندوب في يوم محدّد — للأدمن
router.get('/route', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const salesRepId = req.query.salesRepId as string | undefined;
    if (!salesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }
    const dateStr = (req.query.date as string | undefined) || new Date().toISOString().slice(0, 10);
    const start = new Date(`${dateStr}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

    const points = await prisma.repLocation.findMany({
      where: { tenantId: tid, salesRepId, capturedAt: { gte: start, lt: end } },
      orderBy: { capturedAt: 'asc' }, take: 5000,
      select: { lat: true, lng: true, accuracy: true, speed: true, capturedAt: true },
    });

    // مطابقة المسار مع الطرق ليظهر على الطريق لا فوق المباني (يسقط للخام عند التعذّر)
    const snap = (req.query.snap as string | undefined) !== '0';
    const snapped = snap
      ? await snapToRoads(points, `${salesRepId}:${dateStr}:${points.length}`)
      : null;

    res.json({ success: true, data: points, snapped });
  } catch (err) { next(err); }
});

export default router;
