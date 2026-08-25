import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, requireSalesRep, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { adminScopeEnabled } from '../services/adminScope';
import { reattributeFuel, syncPetroappTenant, testPetroappConnection } from '../services/petroapp';

/**
 * تكامل بترو آب — ميزة اشتراك يفعّلها مالك المنصّة لكل شركة (كنمط ERP تماماً):
 * علم petroappEnabled على الشركة، وعند الإطفاء تُخفى الميزة وتُرفض طلباتها.
 * الإدارة تُدخل مفاتيح حساب شركتها لدى بترو آب وتختار الخدمات حسب احتياجها.
 */
const router = Router();

// ═══ مسار المندوب — قبل حرّاس الأدمن كي لا تلتقطه ═══

/**
 * تبويب «الوقود» في تطبيق المندوب: الرصيد الحيّ + آخر الفواتير + أقرب المحطات.
 * يُرجع enabled:false بهدوء حين لا ربط — التطبيق يخفي التبويب بلا خطأ.
 */
router.get('/rep/summary', authenticate, requireSalesRep, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const repId = req.user!.id;
    const gate = await prisma.tenant.findUnique({ where: { id: tid }, select: { petroappEnabled: true } });
    if (!gate?.petroappEnabled) { res.json({ success: true, data: { enabled: false } }); return; }
    const integ = await prisma.petroappIntegration.findUnique({
      where: { tenantId: tid },
      select: { enabled: true, apiKey: true, stationsJson: true, lastSyncAt: true },
    });
    if (!integ?.enabled || !integ.apiKey) { res.json({ success: true, data: { enabled: false } }); return; }

    const [vehicle, delegate, lastTx] = await Promise.all([
      prisma.petroappVehicle.findFirst({ where: { tenantId: tid, salesRepId: repId }, select: { plate: true, model: true, balance: true, balanceAt: true } }),
      prisma.petroappDelegate.findFirst({ where: { tenantId: tid, salesRepId: repId }, select: { name: true, balance: true, balanceAt: true } }),
      prisma.fuelTransaction.findMany({
        where: { tenantId: tid, salesRepId: repId },
        orderBy: { occurredAt: 'desc' },
        take: 10,
        select: { kind: true, amount: true, liters: true, stationName: true, occurredAt: true, odometer: true },
      }),
    ]);

    // أقرب المحطات من الكاش — الحساب على الخادم كي لا تُنقل قائمة بآلاف المحطات للجوال
    let stations: { name?: string; lat: number; lng: number; km: number; services?: string }[] = [];
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (integ.stationsJson && Number.isFinite(lat) && Number.isFinite(lng)) {
      try {
        const all = JSON.parse(integ.stationsJson) as { name?: string; lat: number; lng: number; services?: string }[];
        const rad = Math.PI / 180;
        stations = all
          .map(s => {
            const dLat = (s.lat - lat) * rad, dLng = (s.lng - lng) * rad;
            const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * rad) * Math.cos(s.lat * rad) * Math.sin(dLng / 2) ** 2;
            return { ...s, km: Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10 };
          })
          .sort((x, y) => x.km - y.km)
          .slice(0, 5);
      } catch { /* كاش تالف — نتجاهله */ }
    }

    res.json({
      success: true,
      data: {
        enabled: true,
        linked: !!(vehicle || delegate),
        vehicle, delegate,
        balance: delegate?.balance ?? vehicle?.balance ?? null,
        balanceAt: delegate?.balanceAt ?? vehicle?.balanceAt ?? null,
        lastTransactions: lastTx,
        stations,
        lastSyncAt: integ.lastSyncAt,
      },
    });
  } catch (err) { next(err); }
});

// ═══ مسارات الإدارة ═══

router.use(authenticate, requireAdmin, requireAdminPermission('canManageCompanySettings'));

// بوابة الاشتراك (كنمط ERP): الميزة متاحة فقط للشركات التي فعّل لها المالك الصلاحية
router.use(async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId(req) }, select: { petroappEnabled: true } });
    if (!t?.petroappEnabled) {
      res.status(403).json({ success: false, code: 'PETROAPP_NOT_ALLOWED', message: 'ميزة ربط بترو اب غير مفعلة لاشتراك شركتك تواصل مع مزود الخدمة لتفعيلها' });
      return;
    }
    next();
  } catch (err) { next(err); }
});

/**
 * كحارس ERP: إعدادات التكامل شأن على مستوى الشركة كاملة (مفاتيح حساب وقود بأرصدة
 * مالية + ربط مناديب خارج أي نطاق) — لا يديرها مستخدم مقيّد النطاق.
 */
router.use(async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (await adminScopeEnabled(req)) {
      res.status(403).json({ success: false, message: 'حسابك مقيد بنطاق محدد ادارة تكامل بترو اب تحتاج صلاحية غير مقيدة' });
      return;
    }
    next();
  } catch (err) { next(err); }
});

function publicSettings(integ: Record<string, unknown> | null) {
  if (!integ) return null;
  const { apiKey, stationsJson, ...safe } = integ;
  return { ...safe, hasApiKey: !!apiKey, stationsCount: stationsJson ? (() => { try { return (JSON.parse(stationsJson as string) as unknown[]).length; } catch { return 0; } })() : 0 };
}

router.get('/settings', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const [integ, vehicles, delegates, txCount] = await Promise.all([
      prisma.petroappIntegration.findUnique({ where: { tenantId: tid } }),
      prisma.petroappVehicle.count({ where: { tenantId: tid } }),
      prisma.petroappDelegate.count({ where: { tenantId: tid } }),
      prisma.fuelTransaction.count({ where: { tenantId: tid } }),
    ]);
    res.json({ success: true, data: { settings: publicSettings(integ), counts: { vehicles, delegates, transactions: txCount } } });
  } catch (err) { next(err); }
});

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().max(500).optional(), // فارغ = لا تغيير (المفتاح لا يُعاد للواجهة)
  syncFuel: z.boolean().optional(),
  syncService: z.boolean().optional(),
  syncWash: z.boolean().optional(),
});

router.put('/settings', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = settingsSchema.parse(req.body);
    const tid = tenantId(req);
    const { apiKey, ...rest } = body;
    const data: Record<string, unknown> = { ...rest };
    if (apiKey) data.apiKey = apiKey.trim(); // سلسلة فارغة تعني «أبقِ المفتاح المحفوظ»
    const integ = await prisma.petroappIntegration.upsert({
      where: { tenantId: tid },
      create: { tenantId: tid, ...data },
      update: data,
    });
    res.json({ success: true, data: publicSettings(integ as unknown as Record<string, unknown>) });
  } catch (err) { next(err); }
});

router.post('/test', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const integ = await prisma.petroappIntegration.findUnique({ where: { tenantId: tenantId(req) } });
    if (!integ?.apiKey) { res.status(400).json({ success: false, message: 'احفظ مفتاح API اولا' }); return; }
    const result = await testPetroappConnection({ baseUrl: integ.baseUrl, apiKey: integ.apiKey });
    res.json({ success: result.ok, message: result.message, count: result.count });
  } catch (err) { next(err); }
});

router.post('/sync', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await syncPetroappTenant(tenantId(req));
    res.json({ success: result.ok, data: result.steps });
  } catch (err) { next(err); }
});

// ═══ المطابقة: مركبة/سائق ↔ مندوب ═══

router.get('/vehicles', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const rows = await prisma.petroappVehicle.findMany({ where: { tenantId: tenantId(req) }, orderBy: { plate: 'asc' } });
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

router.get('/delegates', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const rows = await prisma.petroappDelegate.findMany({ where: { tenantId: tenantId(req) }, orderBy: { name: 'asc' } });
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

const linkSchema = z.object({ salesRepId: z.string().nullable() });

router.put('/vehicles/:id/link', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { salesRepId } = linkSchema.parse(req.body);
    const tid = tenantId(req);
    if (salesRepId) {
      const rep = await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid } });
      if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    }
    const r = await prisma.petroappVehicle.updateMany({ where: { id: req.params.id, tenantId: tid }, data: { salesRepId } });
    if (!r.count) { res.status(404).json({ success: false, message: 'المركبة غير موجودة' }); return; }
    const reattributed = await reattributeFuel(tid);
    res.json({ success: true, reattributed });
  } catch (err) { next(err); }
});

router.put('/delegates/:id/link', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { salesRepId } = linkSchema.parse(req.body);
    const tid = tenantId(req);
    if (salesRepId) {
      const rep = await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid } });
      if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    }
    const r = await prisma.petroappDelegate.updateMany({ where: { id: req.params.id, tenantId: tid }, data: { salesRepId } });
    if (!r.count) { res.status(404).json({ success: false, message: 'السائق غير موجود' }); return; }
    const reattributed = await reattributeFuel(tid);
    res.json({ success: true, reattributed });
  } catch (err) { next(err); }
});

// ═══ تقرير الكلفة لكل مندوب ═══

router.get('/report', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 30 * 86400_000);

    const tx = await prisma.fuelTransaction.findMany({
      where: { tenantId: tid, occurredAt: { gte: from, lte: to } },
      select: { salesRepId: true, kind: true, amount: true, liters: true },
    });
    const reps = await prisma.salesRep.findMany({ where: { tenantId: tid }, select: { id: true, name: true } });
    const nameOf = new Map(reps.map(r => [r.id, r.name]));

    const byRep = new Map<string, { repId: string | null; name: string; fuel: number; service: number; wash: number; liters: number; count: number }>();
    for (const t of tx) {
      const key = t.salesRepId ?? '__unlinked__';
      let row = byRep.get(key);
      if (!row) {
        row = { repId: t.salesRepId, name: t.salesRepId ? (nameOf.get(t.salesRepId) ?? 'مندوب محذوف') : 'غير منسوب', fuel: 0, service: 0, wash: 0, liters: 0, count: 0 };
        byRep.set(key, row);
      }
      if (t.kind === 'FUEL') { row.fuel += t.amount; row.liters += t.liters ?? 0; }
      else if (t.kind === 'SERVICE') row.service += t.amount;
      else row.wash += t.amount;
      row.count++;
    }
    const rows = [...byRep.values()]
      .map(r => ({ ...r, total: r.fuel + r.service + r.wash }))
      .sort((a, b) => b.total - a.total);
    const totals = rows.reduce((s, r) => ({ fuel: s.fuel + r.fuel, service: s.service + r.service, wash: s.wash + r.wash, total: s.total + r.total, liters: s.liters + r.liters, count: s.count + r.count }), { fuel: 0, service: 0, wash: 0, total: 0, liters: 0, count: 0 });
    res.json({ success: true, data: { from, to, rows, totals } });
  } catch (err) { next(err); }
});

export default router;
