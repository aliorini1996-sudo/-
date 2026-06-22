import { Router, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { AuthRequest } from '../types';

// إدارة الشركات المشتركة — لمالك المنصّة (السوبر أدمن) فقط
const router = Router();
router.use(authenticate, requireSuperAdmin);

const createTenantSchema = z.object({
  companyName: z.string().min(1),       // اسم الشركة
  plan: z.enum(['basic', 'pro', 'enterprise']).default('basic'),
  subscriptionEndsAt: z.string().optional(), // ISO date — فارغ = غير محدود
  notes: z.string().optional(),
  // بيانات أدمن الشركة الأول
  adminName: z.string().min(1),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(6),
});

const updateTenantSchema = z.object({
  name: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
  plan: z.enum(['basic', 'pro', 'enterprise']).optional(),
  subscriptionEndsAt: z.string().nullish(),
  notes: z.string().nullish(),
});

// قائمة الشركات مع ملخص لكل واحدة
router.get('/', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenants = await prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { admins: true, salesReps: true, customers: true, invoices: true } },
        admins: { select: { name: true, email: true }, take: 1, orderBy: { createdAt: 'asc' } },
      },
    });
    res.json({ success: true, data: tenants });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      include: {
        admins: { select: { id: true, name: true, email: true, isActive: true } },
        _count: { select: { salesReps: true, customers: true, products: true, invoices: true, receipts: true } },
      },
    });
    if (!tenant) { res.status(404).json({ success: false, message: 'الشركة غير موجودة' }); return; }
    res.json({ success: true, data: tenant });
  } catch (err) { next(err); }
});

// إنشاء شركة جديدة + أدمنها الأول + إعدادات شركتها
router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = createTenantSchema.parse(req.body);

    const emailTaken = await prisma.admin.findUnique({ where: { email: body.adminEmail } });
    if (emailTaken) { res.status(409).json({ success: false, message: 'البريد الإلكتروني مستخدم مسبقاً' }); return; }

    const passwordHash = await bcrypt.hash(body.adminPassword, 10);

    const tenant = await prisma.$transaction(async tx => {
      const t = await tx.tenant.create({
        data: {
          name: body.companyName,
          plan: body.plan,
          subscriptionEndsAt: body.subscriptionEndsAt ? new Date(body.subscriptionEndsAt) : null,
          notes: body.notes,
        },
      });
      await tx.admin.create({
        data: { tenantId: t.id, name: body.adminName, email: body.adminEmail, passwordHash, role: 'ADMIN' },
      });
      // إعدادات الشركة الافتراضية (تظهر في المطبوعات)
      await tx.companySettings.create({
        data: { tenantId: t.id, name: body.companyName },
      });
      return t;
    });

    res.status(201).json({ success: true, data: { ...tenant, adminEmail: body.adminEmail } });
  } catch (err) { next(err); }
});

// تعديل اشتراك الشركة (تفعيل/تعطيل، تاريخ انتهاء، خطة)
router.put('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = updateTenantSchema.parse(req.body);
    const data: Record<string, unknown> = { ...body };
    if ('subscriptionEndsAt' in body) {
      data.subscriptionEndsAt = body.subscriptionEndsAt ? new Date(body.subscriptionEndsAt) : null;
    }
    const tenant = await prisma.tenant.update({ where: { id: req.params.id }, data });
    res.json({ success: true, data: tenant });
  } catch (err) { next(err); }
});

// دخول المالك إلى لوحة الشركة (انتحال) — يُصدر توكن بصلاحيات أدمن الشركة
router.post('/:id/impersonate', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) { res.status(404).json({ success: false, message: 'الشركة غير موجودة' }); return; }
    const admin = await prisma.admin.findFirst({ where: { tenantId: tenant.id }, orderBy: { createdAt: 'asc' } });
    if (!admin) { res.status(404).json({ success: false, message: 'لا يوجد مدير لهذه الشركة' }); return; }

    const token = jwt.sign(
      { id: admin.id, role: admin.role, name: admin.name, tenantId: tenant.id, impersonated: true },
      process.env.JWT_SECRET!,
      { expiresIn: '2h' }
    );
    res.json({
      success: true,
      data: { token, user: { id: admin.id, name: admin.name, email: admin.email, role: admin.role, tenantId: tenant.id, companyName: tenant.name } },
    });
  } catch (err) { next(err); }
});

// إعادة تعيين كلمة مرور أدمن الشركة
router.post('/:id/reset-admin', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({ adminId: z.string(), newPassword: z.string().min(6) });
    const { adminId, newPassword } = schema.parse(req.body);
    const admin = await prisma.admin.findFirst({ where: { id: adminId, tenantId: req.params.id } });
    if (!admin) { res.status(404).json({ success: false, message: 'المدير غير موجود' }); return; }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.admin.update({ where: { id: adminId }, data: { passwordHash } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
