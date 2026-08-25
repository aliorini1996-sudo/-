import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, requireSalesRep, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { adminScopeEnabled } from '../services/adminScope';
import { toE164 } from '../lib/phone';
import { parseCallWebhook, recordCallEvent, syncChannels, testHatifConnection, webhookSecretMatches } from '../services/telephony';

/**
 * أرقام العمل وتكامل هاتف — ميزة اشتراك يفعّلها مالك المنصّة لكل شركة (كنمط
 * بترو آب/ERP): علم hatifEnabled على الشركة، وعند الإطفاء تُخفى وتُرفض طلباتها.
 *
 * جوهر التصميم: الرقم كيان يملكه المستأجر لا المندوب — يُسنَد ويُحرَّر، فتبقى
 * علاقة العميل عند الشركة بعد استقالة المندوب. provider=manual يعمل بصفر مزوّد.
 */

// ═══ ويبهوك المزوّد — يُصدَّر منفصلاً ويُركَّب قبل apiLimiter (كواتساب وميسر) ═══

export const telephonyWebhookRouter = Router();

/**
 * عقد هاتف بلا توقيع HMAC موثّق ⇒ سرّ عشوائي لكل شركة في المسار نفسه، يُقارن
 * بأمان زمني، و404 عند الفشل (لا 401 — لا نكشف وجود المسار). نردّ 200 فوراً
 * ونعالج بعده: الويبهوك لا ينتظرنا، وخطؤنا المنطقي لا يستحق إعادة إرسال.
 */
telephonyWebhookRouter.post('/hatif/:tenantId/:secret', async (req, res) => {
  const { tenantId: tid, secret } = req.params;
  const integ = await prisma.telephonyIntegration.findUnique({ where: { tenantId: tid }, select: { webhookSecret: true } }).catch(() => null);
  if (!integ || !webhookSecretMatches(integ.webhookSecret, secret)) { res.status(404).end(); return; }
  res.status(200).json({ ok: true });
  try {
    const ev = parseCallWebhook((req.body ?? {}) as Record<string, unknown>);
    if (ev) await recordCallEvent(tid, ev);
  } catch (e) {
    console.error('telephony webhook:', e);
  }
});

// ═══ المسارات المصادَقة ═══

const router = Router();

/** تبويب المندوب: رقم عمله وآخر مكالماته — enabled:false بهدوء حين لا ميزة */
router.get('/rep/summary', authenticate, requireSalesRep, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const repId = req.user!.id;
    const gate = await prisma.tenant.findUnique({ where: { id: tid }, select: { hatifEnabled: true } });
    if (!gate?.hatifEnabled) { res.json({ success: true, data: { enabled: false } }); return; }
    const [channel, lastCalls] = await Promise.all([
      prisma.workChannel.findFirst({ where: { tenantId: tid, assignedRepId: repId, isActive: true }, select: { e164: true, label: true, kind: true } }),
      prisma.callLog.findMany({
        where: { tenantId: tid, salesRepId: repId },
        orderBy: { startedAt: 'desc' }, take: 10,
        select: { direction: true, fromE164: true, toE164: true, startedAt: true, durationSec: true, aiSummary: true },
      }),
    ]);
    res.json({ success: true, data: { enabled: true, channel, lastCalls } });
  } catch (err) { next(err); }
});

router.use(authenticate, requireAdmin, requireAdminPermission('canManageCompanySettings'));

// بوابة الاشتراك (كنمط بترو آب): متاحة فقط للشركات التي فعّل لها المالك الميزة
router.use(async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId(req) }, select: { hatifEnabled: true } });
    if (!t?.hatifEnabled) {
      res.status(403).json({ success: false, code: 'HATIF_NOT_ALLOWED', message: 'ميزة ارقام العمل وربط هاتف غير مفعلة لاشتراك شركتك تواصل مع مزود الخدمة لتفعيلها' });
      return;
    }
    next();
  } catch (err) { next(err); }
});

/**
 * كنمط ERP وبترو آب: إعدادات على مستوى الشركة كاملة (مفاتيح حساب اتصالات +
 * سجلّ مكالمات كل المناديب) — لا يديرها مستخدم مقيّد النطاق.
 */
router.use(async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (await adminScopeEnabled(req)) {
      res.status(403).json({ success: false, message: 'حسابك مقيد بنطاق محدد ادارة ارقام العمل تحتاج صلاحية غير مقيدة' });
      return;
    }
    next();
  } catch (err) { next(err); }
});

function publicIntegration(i: Record<string, unknown> | null, tid: string) {
  if (!i) return null;
  const { clientSecret, webhookSecret, ...safe } = i;
  return {
    ...safe,
    hasClientSecret: !!clientSecret,
    // عنوان الويبهوك الجاهز للصق في لوحة هاتف (Settings ← API Connect)
    webhookUrl: `https://api.fieldsa.net/api/telephony/webhook/hatif/${tid}/${webhookSecret}`,
  };
}

// ═══ الإعدادات ═══

router.get('/settings', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const [integ, channels, callCount] = await Promise.all([
      prisma.telephonyIntegration.findUnique({ where: { tenantId: tid } }),
      prisma.workChannel.count({ where: { tenantId: tid } }),
      prisma.callLog.count({ where: { tenantId: tid } }),
    ]);
    res.json({ success: true, data: { settings: publicIntegration(integ as unknown as Record<string, unknown> | null, tid), counts: { channels, calls: callCount } } });
  } catch (err) { next(err); }
});

const settingsSchema = z.object({
  provider: z.enum(['manual', 'hatif']).optional(),
  baseUrl: z.string().url().optional(),
  clientId: z.string().max(300).optional(),
  clientSecret: z.string().max(500).optional(), // فارغ = إبقاء المحفوظ
});

router.put('/settings', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = settingsSchema.parse(req.body);
    const tid = tenantId(req);
    const { clientSecret, ...rest } = body;
    const data: Record<string, unknown> = { ...rest };
    if (clientSecret) data.clientSecret = clientSecret.trim();
    const integ = await prisma.telephonyIntegration.upsert({
      where: { tenantId: tid },
      create: { tenantId: tid, ...data },
      update: data,
    });
    res.json({ success: true, data: publicIntegration(integ as unknown as Record<string, unknown>, tid) });
  } catch (err) { next(err); }
});

router.post('/test', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const integ = await prisma.telephonyIntegration.findUnique({ where: { tenantId: tid } });
    if (!integ || integ.provider !== 'hatif' || !integ.clientId || !integ.clientSecret) {
      res.status(400).json({ success: false, message: 'اختر مزود هاتف واحفظ المفاتيح اولا' });
      return;
    }
    const r = await testHatifConnection(tid, { baseUrl: integ.baseUrl, clientId: integ.clientId, clientSecret: integ.clientSecret });
    await prisma.telephonyIntegration.update({ where: { tenantId: tid }, data: { status: r.ok ? 'OK' : 'ERROR', lastError: r.ok ? null : r.message.slice(0, 900) } });
    res.json({ success: r.ok, message: r.message, count: r.count });
  } catch (err) { next(err); }
});

router.post('/sync', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const r = await syncChannels(tenantId(req));
    res.json({ success: r.ok, count: r.count, message: r.error });
  } catch (err) { next(err); }
});

// ═══ مخزون الأرقام ═══

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const rows = await prisma.workChannel.findMany({
      where: { tenantId: tenantId(req) },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
      include: { assignedRep: { select: { id: true, name: true } } },
    });
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

const addSchema = z.object({
  e164: z.string().min(8).max(20),
  label: z.string().max(120).optional(),
  kind: z.enum(['voice', 'whatsapp', 'both']).optional(),
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = addSchema.parse(req.body);
    const e164 = toE164(body.e164);
    if (!e164) { res.status(400).json({ success: false, message: 'رقم غير مفهوم — ادخله بصيغة دولية او محلية سعودية' }); return; }
    const tid = tenantId(req);
    const row = await prisma.workChannel.create({
      data: { tenantId: tid, e164, label: body.label, kind: body.kind ?? 'voice', provider: 'manual' },
    });
    res.json({ success: true, data: row });
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: string }).code === 'P2002') {
      res.status(409).json({ success: false, message: 'الرقم موجود مسبقا في المخزون' });
      return;
    }
    next(err);
  }
});

const patchSchema = z.object({ label: z.string().max(120).nullish(), isActive: z.boolean().optional() });

router.patch('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = patchSchema.parse(req.body);
    const r = await prisma.workChannel.updateMany({ where: { id: req.params.id, tenantId: tenantId(req) }, data: body });
    if (!r.count) { res.status(404).json({ success: false, message: 'الرقم غير موجود' }); return; }
    res.json({ success: true });
  } catch (err) { next(err); }
});

/** إسناد ذرّي: يسحب القناة من مندوبها السابق والقناةَ السابقة من المندوب الجديد في معاملة واحدة */
router.post('/:id/assign', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { salesRepId } = z.object({ salesRepId: z.string() }).parse(req.body);
    const tid = tenantId(req);
    const rep = await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid }, select: { id: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    const channel = await prisma.workChannel.findFirst({ where: { id: req.params.id, tenantId: tid } });
    if (!channel) { res.status(404).json({ success: false, message: 'الرقم غير موجود' }); return; }
    const now = new Date();
    await prisma.$transaction([
      // حرّر أي قناة أخرى مُسنَدة لهذا المندوب (قناة واحدة لكل مندوب)
      prisma.workChannel.updateMany({ where: { tenantId: tid, assignedRepId: salesRepId }, data: { assignedRepId: null, assignedAt: null } }),
      prisma.workChannel.update({ where: { id: channel.id }, data: { assignedRepId: salesRepId, assignedAt: now } }),
    ]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

/** تحرير الرقم للمخزون (زرّ «استقال المندوب») — علاقة العميل تبقى عند الشركة */
router.post('/:id/release', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const r = await prisma.workChannel.updateMany({
      where: { id: req.params.id, tenantId: tenantId(req) },
      data: { assignedRepId: null, assignedAt: null },
    });
    if (!r.count) { res.status(404).json({ success: false, message: 'الرقم غير موجود' }); return; }
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const ch = await prisma.workChannel.findFirst({ where: { id: req.params.id, tenantId: tid } });
    if (!ch) { res.status(404).json({ success: false, message: 'الرقم غير موجود' }); return; }
    if (ch.assignedRepId) { res.status(400).json({ success: false, message: 'حرر الرقم من مندوبه اولا' }); return; }
    await prisma.workChannel.delete({ where: { id: ch.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ═══ سجلّ المكالمات وتقرير المناديب ═══

router.get('/calls', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 30 * 86400_000);
    const calls = await prisma.callLog.findMany({
      where: { tenantId: tid, startedAt: { gte: from, lte: to } },
      orderBy: { startedAt: 'desc' },
      take: 500,
      select: { id: true, direction: true, fromE164: true, toE164: true, startedAt: true, durationSec: true, salesRepId: true, customerId: true, aiSummary: true, recordingUrl: true },
    });
    const reps = await prisma.salesRep.findMany({ where: { tenantId: tid }, select: { id: true, name: true } });
    const nameOf = new Map(reps.map(r => [r.id, r.name]));
    const byRep = new Map<string, { repId: string | null; name: string; calls: number; durationSec: number; missed: number }>();
    for (const c of calls) {
      const key = c.salesRepId ?? '__none__';
      let row = byRep.get(key);
      if (!row) {
        row = { repId: c.salesRepId, name: c.salesRepId ? (nameOf.get(c.salesRepId) ?? 'مندوب محذوف') : 'غير منسوب', calls: 0, durationSec: 0, missed: 0 };
        byRep.set(key, row);
      }
      row.calls++; row.durationSec += c.durationSec;
      if (c.direction === 'MISSED') row.missed++;
    }
    res.json({
      success: true,
      data: {
        from, to,
        calls: calls.map(c => ({ ...c, repName: c.salesRepId ? (nameOf.get(c.salesRepId) ?? null) : null })),
        byRep: [...byRep.values()].sort((a, b) => b.calls - a.calls),
      },
    });
  } catch (err) { next(err); }
});

export default router;
