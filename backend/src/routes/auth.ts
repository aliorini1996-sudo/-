import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  role: z.enum(['super_admin', 'admin', 'sales_rep']),
});

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
