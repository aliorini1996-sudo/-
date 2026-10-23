/**
 * «موظفو المنصة» (طلب المالك، ٢٣ أكتوبر ٢٠٢٦) — موجّهان:
 * - `staffAuthRouter` على /api/staff-auth: دخول الموظف وتغيير كلمة مروره وحسابه. بلا platformGate: كلمة المرور المؤقتة
 *   تُغيَّر من هنا قبل أن يصل الموظف أي قسم.
 * - `platformStaffRouter` على /api/platform-staff: إدارة الموظفين وسجل النشاط — للمالك وحده (platformGate بلا قاعدة ⇒ الموظف ٤٠٣)،
 *   وإلا فتح موظفٌ لنفسه حساباً بكل الصلاحيات.
 * الحرّاس كلها في services/platformAccess.ts.
 */
import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { z } from 'zod';
import prisma from '../config/database';
import { staffAuthLimiter } from '../middleware/rateLimits';
import {
  STAFF_PERMISSIONS, STAFF_SELECT, isStaffPermissionKey, platformGate, signStaffToken, verifyStaffToken, liveStaffFor,
  writePlatformAudit, PlatformRequest,
} from '../services/platformAccess';

/** محاولات خاطئة متتالية قبل قفل الحساب، ومدته — للموظف وحده (حساب المالك لا يُقفل فلا يحجبه غريبٌ يعرف بريده) */
export const STAFF_MAX_FAILED = 5;
export const STAFF_LOCK_MS = 15 * 60 * 1000;
/** العدّاد يتقادم: لا محاولة منذ ربع ساعة ⇒ يبدأ من الصفر (لا تتراكم أخطاء أيامٍ متفرقة إلى قفل) */
export const STAFF_FAIL_WINDOW_MS = 15 * 60 * 1000;
const PASSWORD_MIN = 8;

/** تجزئةٌ ثابتة لمقارنةٍ وهمية حين لا حساب — زمن الردّ لا يكشف وجود البريد */
const DUMMY_HASH = bcrypt.hashSync('platform-staff-dummy-password', 10);

/** كلمة مرور مؤقتة: ١٢ حرفاً بلا حروفٍ ملتبسة */
export function tempPassword(): string {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += chars[bytes[i] % chars.length];
  return out;
}

const sessionUser = (s: { id: string; name: string; email: string; permissions: string[]; mustChangePassword: boolean }) => ({
  id: s.id, name: s.name, email: s.email, role: 'PLATFORM_STAFF' as const, permissions: s.permissions, mustChangePassword: s.mustChangePassword,
});

// ═══════════════════════════ /api/staff-auth ═══════════════════════════

export const staffAuthRouter = Router();

const loginSchema = z.object({ email: z.string().trim().min(3).max(200), password: z.string().min(1).max(200) });

/** ردٌّ واحد لكل فشل (لا حساب، خاطئة، مقفل، معطَّل) — رمزٌ أو نصٌّ مختلف للمقفل يكشف أن البريد لموظفٍ حقيقي */
export const STAFF_LOGIN_FAIL = { success: false, message: 'بيانات الدخول غير صحيحة والمحاولات الخاطئة المتكررة تقفل الدخول مؤقتا' } as const;

staffAuthRouter.post('/login', staffAuthLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const bad = () => res.status(401).json(STAFF_LOGIN_FAIL);
    const staff = await prisma.platformStaff.findUnique({ where: { email: email.toLowerCase() } });
    const now = Date.now();
    if (!staff) {
      // رحلتا القاعدة نفسها لحسابٍ موجود (معرّفٌ لا يطابق صفاً) ثم المقارنة الوهمية — زمن الردّ لا يكشف وجود البريد
      const ghost = crypto.randomUUID();
      await prisma.platformStaff.updateMany({ where: { id: ghost, failedLogins: { gt: 0 } }, data: { failedLogins: 0 } });
      await prisma.platformStaff.updateMany({ where: { id: ghost }, data: { failedLogins: { increment: 1 } } });
      await bcrypt.compare(password, DUMMY_HASH); bad(); return;
    }
    // تقادم العدّاد — شرطيٌّ في العبارة نفسها: لا يمحو محاولةً حُجزت خلال ربع الساعة الأخيرة
    await prisma.platformStaff.updateMany({
      where: { id: staff.id, failedLogins: { gt: 0 }, lastFailedAt: { lt: new Date(now - STAFF_FAIL_WINDOW_MS) } },
      data: { failedLogins: 0 },
    });
    // حجز المحاولة ذرّياً **قبل** bcrypt: قراءةٌ ثم كتابة كانت تجعل الطلبات المتوازية كلها «المحاولة الأولى» فتتجاوز الحدّ.
    // لا تُحجز (مقفل أو بلغ الحدّ) ⇒ مقارنةٌ وهمية والردّ نفسه
    const reserved = await prisma.platformStaff.updateMany({
      where: {
        id: staff.id, failedLogins: { lt: STAFF_MAX_FAILED },
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: new Date(now) } }],
      },
      data: { failedLogins: { increment: 1 }, lastFailedAt: new Date(now) },
    });
    if (reserved.count === 0) { await bcrypt.compare(password, DUMMY_HASH); bad(); return; }
    const ok = await bcrypt.compare(password, staff.passwordHash);
    if (!ok) {
      // بلغ الحدّ ⇒ قفل ربع ساعة؛ شرطيٌّ: أول فاشلٍ يصل يقفل ويصفّر، ومن بعده لا يمدّد القفل
      await prisma.platformStaff.updateMany({
        where: { id: staff.id, failedLogins: { gte: STAFF_MAX_FAILED } },
        data: { failedLogins: 0, lockedUntil: new Date(Date.now() + STAFF_LOCK_MS) },
      });
      bad(); return;
    }
    if (!staff.isActive) { bad(); return; }
    await prisma.platformStaff.update({ where: { id: staff.id }, data: { failedLogins: 0, lastFailedAt: null, lockedUntil: null, lastLoginAt: new Date() } });
    await writePlatformAudit({ actorType: 'STAFF', actorId: staff.id, actorName: staff.name, action: 'staff.login', ip: req.ip ?? null })
      .catch(() => { /* الدخول نفسه لا يُمنع بتعذّر سطره — أفعاله بعده تُمنع */ });
    res.json({ success: true, data: { token: signStaffToken(staff), user: sessionUser(staff) } });
  } catch (err) { next(err); }
});

/** توكن الموظف لمساري حسابه — يقبل «يجب تغيير كلمة المرور» (لا يمرّ من platformGate حتى يغيّرها) */
async function staffSelf(req: PlatformRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const sp = token ? verifyStaffToken(token) : null;
    if (!sp) { res.status(401).json({ success: false, message: 'جلسة منتهية يرجى تسجيل الدخول مجددا' }); return; }
    const staff = await liveStaffFor(sp);
    if (!staff) { res.status(401).json({ success: false, message: 'انتهت صلاحية الحساب سجل الدخول مجددا' }); return; }
    req.user = { id: staff.id, role: 'PLATFORM_STAFF', name: staff.name };
    req.platformStaff = { id: staff.id, name: staff.name, permissions: staff.permissions, tokenVersion: staff.tokenVersion };
    next();
  } catch (err) { next(err); }
}

staffAuthRouter.get('/me', staffSelf, async (req: PlatformRequest, res: Response, next: NextFunction) => {
  try {
    const s = await prisma.platformStaff.findUnique({ where: { id: req.platformStaff!.id }, select: STAFF_SELECT });
    if (!s) { res.status(401).json({ success: false, message: 'انتهت صلاحية الحساب سجل الدخول مجددا' }); return; }
    res.json({ success: true, data: sessionUser(s) });
  } catch (err) { next(err); }
});

const changeSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(PASSWORD_MIN, 'كلمة المرور 8 أحرف على الأقل').max(200),
});

/** تغيير كلمة المرور يُسقط جلساته الأخرى (tokenVersion) ويعيد له توكناً جديداً */
staffAuthRouter.post('/change-password', staffAuthLimiter, staffSelf, async (req: PlatformRequest, res: Response, next: NextFunction) => {
  try {
    const { currentPassword, newPassword } = changeSchema.parse(req.body);
    const s = await prisma.platformStaff.findUnique({ where: { id: req.platformStaff!.id } });
    if (!s || !(await bcrypt.compare(currentPassword, s.passwordHash))) {
      res.status(400).json({ success: false, message: 'كلمة المرور الحالية غير صحيحة' }); return;
    }
    if (currentPassword === newPassword) {
      res.status(400).json({ success: false, message: 'اختر كلمة مرور جديدة غير الحالية' }); return;
    }
    const updated = await prisma.platformStaff.update({
      where: { id: s.id },
      data: { passwordHash: await bcrypt.hash(newPassword, 10), mustChangePassword: false, tokenVersion: { increment: 1 } },
      select: STAFF_SELECT,
    });
    await writePlatformAudit({ actorType: 'STAFF', actorId: s.id, actorName: s.name, action: 'staff.changePassword', ip: req.ip ?? null })
      .catch(() => { /* أفضل جهد */ });
    res.json({ success: true, data: { token: signStaffToken(updated), user: sessionUser(updated) } });
  } catch (err) { next(err); }
});

// ═══════════════════════════ /api/platform-staff (المالك وحده) ═══════════════════════════

export const platformStaffRouter = Router();
// platformGate: المالك يمرّ، والموظف ٤٠٣ (لا قاعدة لهذه المسارات في ROUTE_RULES)
platformStaffRouter.use(platformGate);

const LIST_SELECT = {
  id: true, name: true, email: true, isActive: true, permissions: true, mustChangePassword: true,
  lockedUntil: true, lastLoginAt: true, lastSeenAt: true, createdAt: true,
} as const;

const permissionsSchema = z.array(z.string()).max(STAFF_PERMISSIONS.length)
  .refine((a) => a.every(isStaffPermissionKey), 'صلاحية غير معروفة')
  .transform((a) => [...new Set(a)]);

const ownerAudit = (req: PlatformRequest, action: string, targetId: string | null, detail?: unknown) => writePlatformAudit({
  actorType: 'OWNER', actorId: req.user!.id, actorName: req.user!.name ?? null, action, method: req.method,
  path: `${req.baseUrl}${req.path}`, targetId, detail, ip: req.ip ?? null,
});

platformStaffRouter.get('/catalog', (_req: Request, res: Response) => {
  res.json({ success: true, data: STAFF_PERMISSIONS });
});

platformStaffRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await prisma.platformStaff.findMany({ orderBy: { createdAt: 'asc' }, select: LIST_SELECT });
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

const createSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(200),
  permissions: permissionsSchema.default([]),
});

platformStaffRouter.post('/', async (req: PlatformRequest, res: Response, next: NextFunction) => {
  try {
    const body = createSchema.parse(req.body);
    const email = body.email.toLowerCase();
    if (await prisma.platformStaff.findUnique({ where: { email }, select: { id: true } })) {
      res.status(409).json({ success: false, message: 'يوجد موظف بهذا البريد' }); return;
    }
    const password = tempPassword();
    const row = await prisma.platformStaff.create({
      data: { name: body.name, email, permissions: body.permissions, passwordHash: await bcrypt.hash(password, 10), mustChangePassword: true },
      select: LIST_SELECT,
    });
    await ownerAudit(req, 'staff.create', row.id, { email, permissions: body.permissions });
    // كلمة المرور المؤقتة تظهر للمالك هذه المرة وحدها — لا تُخزَّن إلا مجزّأة
    res.status(201).json({ success: true, data: { staff: row, password } });
  } catch (err) { next(err); }
});

const updateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  email: z.string().trim().email().max(200).optional(),
  permissions: permissionsSchema.optional(),
  isActive: z.boolean().optional(),
});

platformStaffRouter.put('/:id', async (req: PlatformRequest, res: Response, next: NextFunction) => {
  try {
    const body = updateSchema.parse(req.body);
    const cur = await prisma.platformStaff.findUnique({ where: { id: req.params.id }, select: { id: true, email: true, permissions: true } });
    if (!cur) { res.status(404).json({ success: false, message: 'الموظف غير موجود' }); return; }
    const email = body.email?.toLowerCase();
    if (email && email !== cur.email && await prisma.platformStaff.findUnique({ where: { email }, select: { id: true } })) {
      res.status(409).json({ success: false, message: 'يوجد موظف بهذا البريد' }); return;
    }
    // يُسقط الجلسات: التعطيل (إعادة التفعيل لا تُحيي توكناً صدر قبله)، وسحب «الدخول» — جلسات «دخول» أصدرها تحمل btv فلا
    // تحييها إعادة منح الصلاحية لاحقاً (impersonationIssuerOk). ثمنه خروجه من لوحته أيضاً
    const lostImpersonate = body.permissions !== undefined
      && cur.permissions.includes('tenants.impersonate') && !body.permissions.includes('tenants.impersonate');
    const revoke = body.isActive === false || lostImpersonate;
    const row = await prisma.platformStaff.update({
      where: { id: cur.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(email !== undefined ? { email } : {}),
        ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(revoke ? { tokenVersion: { increment: 1 } } : {}),
      },
      select: LIST_SELECT,
    });
    await ownerAudit(req, 'staff.update', row.id, body);
    res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

platformStaffRouter.post('/:id/reset-password', async (req: PlatformRequest, res: Response, next: NextFunction) => {
  try {
    const cur = await prisma.platformStaff.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!cur) { res.status(404).json({ success: false, message: 'الموظف غير موجود' }); return; }
    const password = tempPassword();
    await prisma.platformStaff.update({
      where: { id: cur.id },
      data: {
        passwordHash: await bcrypt.hash(password, 10), mustChangePassword: true,
        tokenVersion: { increment: 1 }, failedLogins: 0, lastFailedAt: null, lockedUntil: null,
      },
    });
    await ownerAudit(req, 'staff.resetPassword', cur.id);
    res.json({ success: true, data: { password } });
  } catch (err) { next(err); }
});

/** «إخراج من كل الأجهزة»: كل توكن صدر قبله يسقط، ومعه جلسات «دخول» أصدرها إلى حسابات الشركات */
platformStaffRouter.post('/:id/revoke-sessions', async (req: PlatformRequest, res: Response, next: NextFunction) => {
  try {
    const cur = await prisma.platformStaff.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!cur) { res.status(404).json({ success: false, message: 'الموظف غير موجود' }); return; }
    await prisma.platformStaff.update({ where: { id: cur.id }, data: { tokenVersion: { increment: 1 } } });
    await ownerAudit(req, 'staff.revokeSessions', cur.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

/** الحذف يُبقي سطور سجل النشاط باسم الموظف ومعرّفه */
platformStaffRouter.delete('/:id', async (req: PlatformRequest, res: Response, next: NextFunction) => {
  try {
    const cur = await prisma.platformStaff.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, email: true } });
    if (!cur) { res.status(404).json({ success: false, message: 'الموظف غير موجود' }); return; }
    await ownerAudit(req, 'staff.delete', cur.id, { name: cur.name, email: cur.email });
    await prisma.platformStaff.delete({ where: { id: cur.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

const auditQuery = z.object({
  actorId: z.string().max(100).optional(),
  actorType: z.enum(['OWNER', 'STAFF']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // إزاحة توقيت متصفّح المالك بالدقائق شرقي UTC — أيام المرشّح بتوقيته (الرياض +180) لا بأيام UTC
  tz: z.coerce.number().int().min(-840).max(840).default(0),
  // مؤشّر الصفحة التالية: لحظة آخر سطر ومعرّفه — سطران في الملّي ثانية نفسها لا يسقط أحدهما بين صفحتين
  before: z.string().datetime().optional(),
  beforeId: z.string().max(100).optional(),
});

/** سجل النشاط — الأحدث أولاً، ١٠٠ سطر للصفحة، و`before`/`beforeId` للصفحة التالية */
platformStaffRouter.get('/audit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = auditQuery.parse(req.query);
    const dayStart = (d: string) => new Date(new Date(`${d}T00:00:00.000Z`).getTime() - q.tz * 60 * 1000);
    const and: Record<string, unknown>[] = [];
    if (q.from) and.push({ at: { gte: dayStart(q.from) } });
    if (q.to) and.push({ at: { lt: new Date(dayStart(q.to).getTime() + 24 * 60 * 60 * 1000) } });
    if (q.before) {
      const b = new Date(q.before);
      and.push(q.beforeId ? { OR: [{ at: { lt: b } }, { at: b, id: { lt: q.beforeId } }] } : { at: { lt: b } });
    }
    const rows = await prisma.platformAuditLog.findMany({
      where: {
        ...(q.actorId ? { actorId: q.actorId } : {}),
        ...(q.actorType ? { actorType: q.actorType } : {}),
        ...(and.length ? { AND: and } : {}),
      },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});
