import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId, actorOf, isOwnerSession } from '../middleware/auth';
import { AuthRequest } from '../types';
import { generateApiKey, forgetLiveKey, API_KEY_RATE_PER_MINUTE } from '../services/apiKeys';

/**
 * إدارة مفاتيح «الربط البرمجي API» للشركة — إصدارٌ وقائمةٌ وإلغاء (services/apiKeys.ts).
 *
 * لا يبلغها مفتاح API نفسه (`/api-keys` في API_KEY_DENIED_PREFIXES): مفتاحٌ لا يلد مفتاحاً.
 * والمفتاح يُصدَر بهوية مُصدِره وصلاحياته؛ فلا يملك أحدٌ بمفتاحه أكثر ممّا يملك في اللوحة.
 */
const router = Router();
router.use(authenticate, requireAdmin, requireAdminPermission('canManageCompanySettings'));

/**
 * بوابة الاشتراك (apiEnabled، يفعّلها المالك لكل شركة) — على **الإصدار** وحده: إطفاء الميزة يعلّق المفاتيح
 * (authenticate يردّها) ولا يمنع الشركة من رؤيتها وإلغائها، وإلا عادت كلها حيّةً بإعادة التفعيل دون أن تملك إلغاءها.
 */
async function requireApiEnabled(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId(req) }, select: { apiEnabled: true } });
    if (t?.apiEnabled !== true) {
      res.status(403).json({ success: false, code: 'API_NOT_ALLOWED', message: 'الربط البرمجي API غير مفعل لاشتراك شركتك تواصل مع مزود الخدمة لتفعيله' });
      return;
    }
    next();
  } catch (err) { next(err); }
}

/**
 * المفاتيح شأن مدير الشركة وحده — عرضاً وإصداراً وإلغاءً: «إعدادات الشركة» مفتوحة افتراضاً لكل مستخدم،
 * ومدير مبيعات أو محاسب يُلغي مفتاح نظام الشركة يقطع مزامنتها بصمت. الدور من القاعدة لا من التوكن،
 * والمقيَّد النطاق لا يبلغها (المفتاح يعمل بصلاحياته فيرى الشركة ناقصة). جلسة المالك تمرّ — وتُوسم OWNER:.
 */
router.use(async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (isOwnerSession(req)) { next(); return; }
    const me = await prisma.admin.findUnique({ where: { id: req.user!.id }, select: { role: true, isActive: true, scopeEnabled: true, tenantId: true } });
    if (!me || !me.isActive || me.tenantId !== tenantId(req) || me.role !== 'ADMIN' || me.scopeEnabled) {
      res.status(403).json({ success: false, code: 'API_KEY_ADMIN_ONLY', message: 'إدارة مفاتيح API لمدير الشركة فقط' });
      return;
    }
    next();
  } catch (err) { next(err); }
});

/** أقصى عدد مفاتيح سارية للشركة — يكفي نظاماً ونسخة اختبار وتدويراً بلا انقطاع */
export const MAX_ACTIVE_API_KEYS = 10;

const keySelect = {
  id: true, name: true, prefix: true, readOnly: true, createdAt: true, lastUsedAt: true, revokedAt: true, createdBy: true,
  admin: { select: { id: true, name: true, email: true } },
} as const;

/** «من أصدر» للعرض: جلسة المالك تُعرض «الدعم الفني» كما في بقية التدقيق، والمعرّف لا يُكشف */
const shape = (k: {
  id: string; name: string; prefix: string; readOnly: boolean; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null; createdBy: string | null;
  admin: { id: string; name: string; email: string };
}) => ({
  id: k.id, name: k.name, prefix: k.prefix, readOnly: k.readOnly,
  createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt, active: !k.revokedAt,
  owner: { id: k.admin.id, name: k.admin.name, email: k.admin.email },
  issuedByOwner: (k.createdBy || '').startsWith('OWNER:'),
});

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const keys = await prisma.apiKey.findMany({ where: { tenantId: tenantId(req) }, orderBy: { createdAt: 'desc' }, select: keySelect });
    res.json({ success: true, data: { keys: keys.map(shape), ratePerMinute: API_KEY_RATE_PER_MINUTE, maxActive: MAX_ACTIVE_API_KEYS } });
  } catch (err) { next(err); }
});

const createSchema = z.object({
  name: z.string().trim().min(1, 'اكتب اسما للمفتاح').max(60, 'اسم المفتاح طويل'),
  readOnly: z.boolean().optional(),
});

router.post('/', requireApiEnabled, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = createSchema.parse(req.body);
    // المفتاح يعمل بهوية مُصدِره — وفي جلسة المالك بهوية مدير الشركة الذي وُقّع به توكن الانتحال،
    // **بلا** تجاوزات المالك. فإن كان هذا المستخدم مقيّد النطاق لرأى المفتاح بعض الشركة لا كلّها:
    // نرفض صراحةً بدل مفتاحٍ يعمل ناقصاً بصمت.
    const owner = await prisma.admin.findUnique({ where: { id: req.user!.id }, select: { tenantId: true, isActive: true, scopeEnabled: true, role: true } });
    if (!owner || owner.tenantId !== tid || !owner.isActive) {
      res.status(403).json({ success: false, message: 'غير مسموح' });
      return;
    }
    // المدير (ADMIN) وحده يصدر — والدور من القاعدة لا من التوكن. «إعدادات الشركة» مفتوحة افتراضاً لكل
    // مستخدم، ومفتاحٌ يبقى بعد الجلسة لا يُصدره مدير مبيعات أو محاسب ولو بصلاحياته هو
    if (owner.role !== 'ADMIN') {
      res.status(403).json({ success: false, code: 'API_KEY_ADMIN_ONLY', message: 'إصدار مفاتيح API لمدير الشركة فقط' });
      return;
    }
    if (owner.scopeEnabled) {
      res.status(403).json({ success: false, code: 'API_KEY_SCOPED_OWNER', message: 'حسابك مقيد بنطاق محدد والمفتاح يعمل بصلاحياتك فلن يرى بيانات الشركة كاملة أصدره من حساب غير مقيد' });
      return;
    }
    const active = await prisma.apiKey.count({ where: { tenantId: tid, revokedAt: null } });
    if (active >= MAX_ACTIVE_API_KEYS) {
      res.status(400).json({ success: false, code: 'API_KEY_LIMIT', message: `الحد الأقصى ${MAX_ACTIVE_API_KEYS} مفاتيح سارية ألغ مفتاحا قديما أولا` });
      return;
    }
    const { key, prefix, hash } = generateApiKey();
    const row = await prisma.apiKey.create({
      data: { tenantId: tid, adminId: req.user!.id, name: body.name, prefix, keyHash: hash, readOnly: body.readOnly === true, createdBy: actorOf(req) },
      select: keySelect,
    });
    // النصّ الكامل يُرسَل هنا وحده ولا يُحفظ — لا يمكن عرضه ثانية
    res.status(201).json({ success: true, data: { ...shape(row), key } });
  } catch (err) { next(err); }
});

router.post('/:id/revoke', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const where = { id: String(req.params.id), tenantId: tid, revokedAt: null };
    const target = await prisma.apiKey.findFirst({ where, select: { keyHash: true } });
    const r = await prisma.apiKey.updateMany({ where, data: { revokedAt: new Date(), revokedBy: actorOf(req) } });
    if (r.count === 0) {
      res.status(404).json({ success: false, message: 'المفتاح غير موجود أو ملغى مسبقا' });
      return;
    }
    // يخرج من ذاكرة «المفاتيح الحيّة» في الحال — فلا يُعدّ في دلوه بعد الإلغاء (authenticate يرفضه أصلاً)
    if (target) forgetLiveKey(target.keyHash);
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
