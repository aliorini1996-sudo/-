import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import { sendMail, mailLayout } from '../services/mailer';
import { authLimiter, signupLimiter, mailLimiter } from '../middleware/rateLimits';
import { getCountryTax } from '../config/countries';

const router = Router();

// رابط الواجهة الأساسي (أول قيمة في FRONTEND_URL)
function frontendBase(): string {
  return (process.env.FRONTEND_URL || 'https://fieldsa.net').split(',')[0].trim().replace(/\/$/, '');
}

// رمز تأكيد البريد (JWT بلا تخزين إضافي) صالح يومين
function signVerifyToken(adminId: string): string {
  return jwt.sign({ id: adminId, purpose: 'verify-email' }, process.env.JWT_SECRET as jwt.Secret, { expiresIn: '2d' });
}

// قالب بريد تأكيد البريد الإلكتروني
function verifyEmailHtml(name: string, url: string): string {
  return `<div dir="rtl" style="font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#FAF7F0;padding:24px">
    <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E9E1D3;border-radius:16px;overflow:hidden">
      <div style="background:#1F1A13;padding:20px;color:#fff;font-size:18px;font-weight:700">FieldSales — تأكيد البريد الإلكتروني</div>
      <div style="padding:24px;color:#3a342b;font-size:15px;line-height:1.9">
        مرحباً ${name}،<br>شكراً لتسجيلك في FieldSales. لتأكيد بريدك الإلكتروني اضغط الزر التالي:
        <div style="text-align:center;margin:24px 0">
          <a href="${url}" style="background:#E15A30;color:#fff;text-decoration:none;font-weight:700;padding:13px 30px;border-radius:12px;display:inline-block">تأكيد البريد الإلكتروني</a>
        </div>
        أو انسخ الرابط في متصفّحك:<br><span style="color:#6E6557;word-break:break-all">${url}</span><br><br>
        الرابط صالح لمدة يومين. إن لم تكن أنت من سجّل، تجاهل هذه الرسالة.
      </div>
    </div>
  </div>`;
}

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  role: z.enum(['super_admin', 'admin', 'sales_rep']),
});

const signupSchema = z.object({
  companyName: z.string().min(2),
  adminName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().optional(),
  countryCode: z.string().length(2).optional(), // دولة الشركة — تُشتقّ منها العملة والضريبة ومزوّد الفوترة
  // عمودية التسجيل: صفحة هبوط التوزيع تُرسل distribution (افتراضي)، وهبوط المطاعم يُرسل restaurant.
  vertical: z.enum(['distribution', 'restaurant']).default('distribution'),
});
const TRIAL_DAYS = 10;

const adminPermissionSelect = {
  canAccessDashboard: true,
  canManageCustomers: true,
  canManageProducts: true,
  canManageSalesReps: true,
  canManageInvoices: true,
  canManageReceipts: true,
  canViewReports: true,
  canManageVanStock: true,
  canManageTracking: true,
  canManageCompanySettings: true,
  canManageCompanyUsers: true,
} as const;

function signToken(payload: object): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  const options: jwt.SignOptions = { expiresIn: (process.env.JWT_EXPIRES_IN || '8h') as jwt.SignOptions['expiresIn'] };
  return jwt.sign(payload, secret as jwt.Secret, options);
}

function tenantBlockReason(tenant: { isActive: boolean; subscriptionEndsAt: Date | null } | null): string | null {
  if (!tenant) return 'الشركة غير موجودة';
  if (!tenant.isActive) return 'اشتراك الشركة موقوف - تواصل مع مزود الخدمة';
  if (tenant.subscriptionEndsAt && tenant.subscriptionEndsAt.getTime() < Date.now()) {
    return 'انتهى اشتراك الشركة - تواصل مع مزود الخدمة';
  }
  return null;
}

router.post('/login', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password, role } = loginSchema.parse(req.body);

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

    if (role === 'admin') {
      const admin = await prisma.admin.findUnique({ where: { email: username }, include: { tenant: true } });
      if (!admin || !admin.isActive || !(await bcrypt.compare(password, admin.passwordHash))) {
        res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' });
        return;
      }
      const block = tenantBlockReason(admin.tenant);
      if (block) { res.status(403).json({ success: false, message: block }); return; }
      const vertical = (admin.tenant as any).vertical ?? 'distribution';
      const token = signToken({ id: admin.id, role: admin.role, name: admin.name, tenantId: admin.tenantId, vertical });
      res.json({
        success: true,
        data: {
          token,
          user: {
            id: admin.id,
            name: admin.name,
            email: admin.email,
            role: admin.role,
            tenantId: admin.tenantId,
            vertical,
            companyName: admin.tenant.name,
            emailVerified: (admin as any).emailVerified ?? true,
            ...Object.fromEntries(Object.keys(adminPermissionSelect).map(key => [key, (admin as any)[key]])),
          },
        },
      });
      return;
    }

    const rep = await prisma.salesRep.findUnique({ where: { username }, include: { tenant: true } });
    if (!rep || !rep.isActive || !(await bcrypt.compare(password, rep.passwordHash))) {
      res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' });
      return;
    }
    const block = tenantBlockReason(rep.tenant);
    if (block) { res.status(403).json({ success: false, message: block }); return; }
    const repVertical = (rep.tenant as any).vertical ?? 'distribution';
    const token = signToken({ id: rep.id, role: 'SALES_REP', name: rep.name, tenantId: rep.tenantId, vertical: repVertical });
    const { passwordHash: _ph, tenant: _t, ...repData } = rep;
    res.json({ success: true, data: { token, user: { ...repData, role: 'SALES_REP', vertical: repVertical, companyName: rep.tenant.name } } });
  } catch (err) { next(err); }
});

router.post('/signup', signupLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = signupSchema.parse(req.body);
    const taken = await prisma.admin.findUnique({ where: { email: body.email } });
    if (taken) { res.status(409).json({ success: false, message: 'البريد الإلكتروني مستخدم مسبقاً - سجل الدخول' }); return; }

    const passwordHash = await bcrypt.hash(body.password, 10);
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    // إعدادات دولة الشركة (العملة/الضريبة/مزوّد الفوترة) — تُشتقّ من رمز الدولة (افتراضي السعودية)
    const ct = getCountryTax(body.countryCode);

    const isResto = body.vertical === 'restaurant';
    const created = await prisma.$transaction(async tx => {
      const tenant = await tx.tenant.create({
        data: {
          name: body.companyName,
          plan: 'trial',
          vertical: body.vertical,
          subscriptionEndsAt: trialEndsAt,
          // حدود التجربة الافتراضية حسب العمودية: التوزيع بالمناديب، والمطاعم بنقاط البيع.
          maxSalesReps: isResto ? null : 5,
          maxAdminUsers: 1,
          maxPosStations: isResto ? 3 : null,
        } as any,
      });
      const admin = await tx.admin.create({
        data: { tenantId: tenant.id, name: body.adminName, email: body.email, passwordHash, role: 'ADMIN' } as any,
      });
      await tx.companySettings.create({ data: {
        tenantId: tenant.id, name: body.companyName, phone: body.phone,
        countryCode: ct.code, currency: ct.currency, defaultVatPct: ct.defaultVatPct, einvoiceProvider: ct.provider,
      } as any });
      return { tenant, admin };
    });

    // إشعار «عميل تجريبي جديد» إلى البريد الرئيسي للشركة
    const mailSent = await sendMail({
      to: process.env.MAIL_TO || 'info@fieldsa.net',
      subject: `🎉 عميل تجريبي جديد: ${body.companyName}`,
      replyTo: body.email,
      html: mailLayout('🎉 عميل تجريبي جديد', [
        ['الشركة', body.companyName],
        ['المسؤول', body.adminName],
        ['البريد', body.email],
        ['الجوال', body.phone || '—'],
        ['الدولة', `${ct.code} · ${ct.currency} · ${ct.defaultVatPct}%`],
        ['الباقة', 'تجريبية مجانية'],
        ['مدة التجربة', `${TRIAL_DAYS} أيام`],
        ['تاريخ التسجيل', new Date().toISOString().slice(0, 10)],
        ['تنتهي التجربة', trialEndsAt.toISOString().slice(0, 10)],
      ], 'سجّل عميل جديد للتجربة المجانية عبر fieldsa.net — يُنصح بالتواصل معه لتفعيل أفضل تجربة وتحويله لمشترك.'),
    });
    if (!mailSent) console.error('[mail] فشل إرسال إشعار عميل تجريبي جديد إلى info@fieldsa.net');

    // بريد تأكيد للعميل — يحقّق ملكية البريد (دخول فوري + لافتة تأكيد بالواجهة)
    const verifyUrl = `${frontendBase()}/verify-email?token=${signVerifyToken(created.admin.id)}`;
    const verifySent = await sendMail({
      to: body.email,
      subject: 'تأكيد بريدك الإلكتروني — FieldSales',
      html: verifyEmailHtml(body.adminName, verifyUrl),
    });

    const token = signToken({ id: created.admin.id, role: created.admin.role, name: created.admin.name, tenantId: created.tenant.id, vertical: body.vertical });
    res.status(201).json({
      success: true,
      data: {
        token,
        user: { id: created.admin.id, name: created.admin.name, email: created.admin.email, role: created.admin.role, tenantId: created.tenant.id, vertical: body.vertical, companyName: created.tenant.name, emailVerified: false },
        trialEndsAt,
        trialDays: TRIAL_DAYS,
        mailSent,
        verifySent,
      },
    });
  } catch (err) { next(err); }
});

// تأكيد البريد عبر الرمز (عام) — يستدعيه صفحة /verify-email
router.post('/verify-email', mailLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = z.object({ token: z.string().min(1) }).parse(req.body);
    let payload: { id?: string; purpose?: string };
    try { payload = jwt.verify(token, process.env.JWT_SECRET as jwt.Secret) as { id?: string; purpose?: string }; }
    catch { res.status(400).json({ success: false, message: 'رابط التأكيد غير صالح أو منتهي الصلاحية' }); return; }
    if (payload.purpose !== 'verify-email' || !payload.id) { res.status(400).json({ success: false, message: 'رابط غير صالح' }); return; }
    const admin = await prisma.admin.findUnique({ where: { id: payload.id }, select: { id: true, emailVerified: true } });
    if (!admin) { res.status(404).json({ success: false, message: 'الحساب غير موجود' }); return; }
    if (!admin.emailVerified) await prisma.admin.update({ where: { id: admin.id }, data: { emailVerified: true } as any });
    res.json({ success: true, data: { verified: true } });
  } catch (err) { next(err); }
});

// إعادة إرسال بريد التأكيد (للأدمن المسجّل)
router.post('/resend-verification', authenticate, mailLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.user || req.user.role === 'SUPER_ADMIN' || req.user.role === 'SALES_REP') {
      res.status(403).json({ success: false, message: 'غير متاح' }); return;
    }
    const admin = await prisma.admin.findUnique({ where: { id: req.user.id }, select: { id: true, name: true, email: true, emailVerified: true } });
    if (!admin) { res.status(404).json({ success: false, message: 'الحساب غير موجود' }); return; }
    if (admin.emailVerified) { res.json({ success: true, data: { alreadyVerified: true } }); return; }
    const verifyUrl = `${frontendBase()}/verify-email?token=${signVerifyToken(admin.id)}`;
    const sent = await sendMail({ to: admin.email, subject: 'تأكيد بريدك الإلكتروني — FieldSales', html: verifyEmailHtml(admin.name, verifyUrl) });
    res.json({ success: true, data: { sent } });
  } catch (err) { next(err); }
});

router.post('/refresh-fcm', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { fcmToken } = req.body;
    if (req.user?.role === 'SALES_REP') {
      await prisma.salesRep.update({ where: { id: req.user.id }, data: { fcmToken } });
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.post('/change-password', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if ((req.user as { impersonated?: boolean })?.impersonated) {
      res.status(403).json({ success: false, message: 'غير متاح أثناء تصفح شركة كمالك' });
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
          canSellOnCredit: true, canSellInCash: true,
          canChangePrice: true, maxDiscountPct: true, canSellBelowPrice: true,
          canCreateReceipt: true, canEditReceipt: true, canCancelReceipt: true,
          canManageVanStock: true,
          canAddCustomer: true, canEditCustomer: true, canViewStatement: true }
      });
      res.json({ success: true, data: { ...rep, role: 'SALES_REP' } });
    } else {
      const admin = await prisma.admin.findUnique({
        where: { id: req.user.id },
        select: { id: true, name: true, email: true, role: true, tenantId: true, emailVerified: true, ...adminPermissionSelect }
      });
      res.json({ success: true, data: admin });
    }
  } catch (err) { next(err); }
});

export default router;
