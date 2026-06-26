import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import { sendMail, mailLayout } from '../services/mailer';

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  role: z.enum(['super_admin', 'admin', 'sales_rep']),
});

// التسجيل الذاتي للتجربة المجانية (إنشاء شركة جديدة + أدمنها)
const signupSchema = z.object({
  companyName: z.string().min(2),
  adminName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().optional(),
});
const TRIAL_DAYS = 14;

function signToken(payload: object): string {
  return jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
}

// يتحقق أن اشتراك الشركة نشط وغير منتهٍ — يُرجع رسالة الخطأ أو null
function tenantBlockReason(tenant: { isActive: boolean; subscriptionEndsAt: Date | null } | null): string | null {
  if (!tenant) return 'الشركة غير موجودة';
  if (!tenant.isActive) return 'اشتراك الشركة موقوف — تواصل مع مزوّد الخدمة';
  if (tenant.subscriptionEndsAt && tenant.subscriptionEndsAt.getTime() < Date.now()) {
    return 'انتهى اشتراك الشركة — تواصل مع مزوّد الخدمة';
  }
  return null;
}

router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password, role } = loginSchema.parse(req.body);

    // ===== مالك المنصّة =====
    if (role === 'super_admin') {
      const sa = await prisma.superAdmin.findUnique({ where: { email: username } });
      if (!sa || !sa.isActive || !(await bcrypt.compare(password, sa.passwordHash))) {
        res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' });
        return;
      }
      const token = signToken({ id: sa.id, role: 'SUPER_ADMIN', name: sa.name });
      res.json({ success: true, data: { token, user: { id: sa.id, name: sa.name, email: sa.email, role: 'SUPER_ADMIN' } } });
      return;
    }

    // ===== أدمن شركة =====
    if (role === 'admin') {
      const admin = await prisma.admin.findUnique({ where: { email: username }, include: { tenant: true } });
      if (!admin || !admin.isActive || !(await bcrypt.compare(password, admin.passwordHash))) {
        res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' });
        return;
      }
      const block = tenantBlockReason(admin.tenant);
      if (block) { res.status(403).json({ success: false, message: block }); return; }
      const token = signToken({ id: admin.id, role: admin.role, name: admin.name, tenantId: admin.tenantId });
      res.json({ success: true, data: { token, user: { id: admin.id, name: admin.name, email: admin.email, role: admin.role, tenantId: admin.tenantId, companyName: admin.tenant.name } } });
      return;
    }

    // ===== مندوب =====
    const rep = await prisma.salesRep.findUnique({ where: { username }, include: { tenant: true } });
    if (!rep || !rep.isActive || !(await bcrypt.compare(password, rep.passwordHash))) {
      res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' });
      return;
    }
    const block = tenantBlockReason(rep.tenant);
    if (block) { res.status(403).json({ success: false, message: block }); return; }
    const token = signToken({ id: rep.id, role: 'SALES_REP', name: rep.name, tenantId: rep.tenantId });
    const { passwordHash: _ph, tenant: _t, ...repData } = rep;
    res.json({ success: true, data: { token, user: { ...repData, role: 'SALES_REP', companyName: rep.tenant.name } } });
  } catch (err) {
    next(err);
  }
});

// تسجيل ذاتي — إنشاء شركة بتجربة مجانية والدخول مباشرة
router.post('/signup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = signupSchema.parse(req.body);
    const taken = await prisma.admin.findUnique({ where: { email: body.email } });
    if (taken) { res.status(409).json({ success: false, message: 'البريد الإلكتروني مستخدم مسبقاً — سجّل الدخول' }); return; }

    const passwordHash = await bcrypt.hash(body.password, 10);
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    const created = await prisma.$transaction(async tx => {
      const tenant = await tx.tenant.create({
        data: {
          name: body.companyName,
          plan: 'basic',
          subscriptionEndsAt: trialEndsAt,
          notes: body.phone ? `تجربة مجانية — جوال: ${body.phone}` : 'تجربة مجانية (تسجيل ذاتي)',
        },
      });
      const admin = await tx.admin.create({
        data: { tenantId: tenant.id, name: body.adminName, email: body.email, passwordHash, role: 'ADMIN' },
      });
      await tx.companySettings.create({ data: { tenantId: tenant.id, name: body.companyName, phone: body.phone } });
      return { tenant, admin };
    });

    // إشعار بريدي بطلب التجربة الجديد (لا يُعطّل التسجيل إن تعذّر)
    sendMail({
      subject: `🎉 طلب تجربة مجانية جديد — ${body.companyName}`,
      replyTo: body.email,
      html: mailLayout('طلب تجربة مجانية جديد', [
        ['الشركة', body.companyName],
        ['المسؤول', body.adminName],
        ['البريد', body.email],
        ['الجوال', body.phone || ''],
        ['تنتهي التجربة', trialEndsAt.toISOString().slice(0, 10)],
      ]),
    }).catch(() => { /* تجاهل */ });

    const token = signToken({ id: created.admin.id, role: created.admin.role, name: created.admin.name, tenantId: created.tenant.id });
    res.status(201).json({
      success: true,
      data: {
        token,
        user: { id: created.admin.id, name: created.admin.name, email: created.admin.email, role: created.admin.role, tenantId: created.tenant.id, companyName: created.tenant.name },
        trialEndsAt,
        trialDays: TRIAL_DAYS,
      },
    });
  } catch (err) { next(err); }
});

router.post('/refresh-fcm', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { fcmToken } = req.body;
    if (req.user?.role === 'SALES_REP') {
      await prisma.salesRep.update({ where: { id: req.user.id }, data: { fcmToken } });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// تغيير كلمة المرور للحساب الحالي (سوبر أدمن / أدمن شركة / مندوب)
router.post('/change-password', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if ((req.user as { impersonated?: boolean })?.impersonated) {
      res.status(403).json({ success: false, message: 'غير متاح أثناء تصفّح شركة كمالك' });
      return;
    }
    const schema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(6) });
    const { currentPassword, newPassword } = schema.parse(req.body);
    const role = req.user!.role;

    const record = role === 'SUPER_ADMIN'
      ? await prisma.superAdmin.findUnique({ where: { id: req.user!.id } })
      : role === 'SALES_REP'
        ? await prisma.salesRep.findUnique({ where: { id: req.user!.id } })
        : await prisma.admin.findUnique({ where: { id: req.user!.id } });
    if (!record) { res.status(404).json({ success: false, message: 'الحساب غير موجود' }); return; }

    const valid = await bcrypt.compare(currentPassword, record.passwordHash);
    if (!valid) { res.status(400).json({ success: false, message: 'كلمة المرور الحالية غير صحيحة' }); return; }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    if (role === 'SUPER_ADMIN') await prisma.superAdmin.update({ where: { id: req.user!.id }, data: { passwordHash } });
    else if (role === 'SALES_REP') await prisma.salesRep.update({ where: { id: req.user!.id }, data: { passwordHash } });
    else await prisma.admin.update({ where: { id: req.user!.id }, data: { passwordHash } });

    res.json({ success: true });
  } catch (err) { next(err); }
});

router.get('/me', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.user) { res.status(401).json({ success: false }); return; }
    if (req.user.role === 'SUPER_ADMIN') {
      const sa = await prisma.superAdmin.findUnique({ where: { id: req.user.id }, select: { id: true, name: true, email: true } });
      res.json({ success: true, data: { ...sa, role: 'SUPER_ADMIN' } });
      return;
    }
    if (req.user.role === 'SALES_REP') {
      const rep = await prisma.salesRep.findUnique({
        where: { id: req.user.id },
        select: { id: true, name: true, phone: true, email: true, username: true, tenantId: true,
          canCreateInvoice: true, canEditInvoice: true, canDeleteInvoice: true, canCancelInvoice: true,
          canChangePrice: true, maxDiscountPct: true, canSellBelowPrice: true,
          canCreateReceipt: true, canEditReceipt: true, canCancelReceipt: true,
          canAddCustomer: true, canEditCustomer: true, canViewStatement: true }
      });
      res.json({ success: true, data: { ...rep, role: 'SALES_REP' } });
    } else {
      const admin = await prisma.admin.findUnique({
        where: { id: req.user.id },
        select: { id: true, name: true, email: true, role: true, tenantId: true }
      });
      res.json({ success: true, data: admin });
    }
  } catch (err) {
    next(err);
  }
});

export default router;
