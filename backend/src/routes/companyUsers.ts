import { Router, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
router.use(authenticate, requireAdmin);

const roles = ['ADMIN', 'MANAGER', 'ACCOUNTANT'] as const;

const userSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  role: z.enum(roles),
  password: z.string().optional(),
  isActive: z.boolean().optional(),
  canAccessDashboard: z.boolean().optional(),
  canManageCustomers: z.boolean().optional(),
  canManageProducts: z.boolean().optional(),
  canManageSalesReps: z.boolean().optional(),
  canManageInvoices: z.boolean().optional(),
  canManageReceipts: z.boolean().optional(),
  canViewReports: z.boolean().optional(),
  canManageVanStock: z.boolean().optional(),
  canManageTracking: z.boolean().optional(),
  canManageCompanySettings: z.boolean().optional(),
  canManageCompanyUsers: z.boolean().optional(),
});

const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
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
  createdAt: true,
} as const;

async function requireCompanyOwner(req: AuthRequest, res: Response): Promise<boolean> {
  if (!req.user || !['ADMIN', 'MANAGER', 'ACCOUNTANT'].includes(req.user.role)) {
    res.status(403).json({ success: false, message: 'غير مسموح' });
    return false;
  }
  const admin = await prisma.admin.findUnique({
    where: { id: req.user.id },
    select: { isActive: true, canManageCompanyUsers: true },
  });
  if (!admin?.isActive || !admin.canManageCompanyUsers) {
    res.status(403).json({ success: false, message: 'إدارة مستخدمي الشركة غير متاحة لهذا الحساب' });
    return false;
  }
  return true;
}

async function duplicateEmail(email: string, excludeId?: string): Promise<boolean> {
  const existing = await prisma.admin.findUnique({ where: { email }, select: { id: true } });
  return !!existing && existing.id !== excludeId;
}

async function blocksLastAdmin(tid: string, target: { id: string; role: string; isActive: boolean; canManageCompanyUsers: boolean }, data: { role?: string; isActive?: boolean; canManageCompanyUsers?: boolean }) {
  const willLoseAdmin = target.role === 'ADMIN'
    && target.isActive
    && target.canManageCompanyUsers
    && ((data.role && data.role !== 'ADMIN') || data.isActive === false || data.canManageCompanyUsers === false);
  if (!willLoseAdmin) return false;

  const otherAdmins = await prisma.admin.count({
    where: { tenantId: tid, id: { not: target.id }, role: 'ADMIN', isActive: true, canManageCompanyUsers: true },
  });
  return otherAdmins === 0;
}

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!(await requireCompanyOwner(req, res))) return;
    const tid = tenantId(req);
    const users = await prisma.admin.findMany({
      where: { tenantId: tid },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
      select: userSelect,
    });
    res.json({ success: true, data: users });
  } catch (err) { next(err); }
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!(await requireCompanyOwner(req, res))) return;
    const tid = tenantId(req);
    const body = userSchema.parse(req.body);
    if (!body.password) { res.status(400).json({ success: false, message: 'كلمة المرور مطلوبة' }); return; }
    if (body.password.length < 6) { res.status(400).json({ success: false, message: 'كلمة المرور 6 أحرف على الأقل' }); return; }
    if (await duplicateEmail(body.email)) { res.status(409).json({ success: false, message: 'البريد الإلكتروني مستخدم مسبقاً' }); return; }

    const passwordHash = await bcrypt.hash(body.password, 10);
    const user = await prisma.admin.create({
      data: {
        tenantId: tid,
        name: body.name,
        email: body.email,
        role: body.role,
        passwordHash,
        isActive: body.isActive ?? true,
        canAccessDashboard: body.canAccessDashboard ?? true,
        canManageCustomers: body.canManageCustomers ?? true,
        canManageProducts: body.canManageProducts ?? true,
        canManageSalesReps: body.canManageSalesReps ?? true,
        canManageInvoices: body.canManageInvoices ?? true,
        canManageReceipts: body.canManageReceipts ?? true,
        canViewReports: body.canViewReports ?? true,
        canManageVanStock: body.canManageVanStock ?? true,
        canManageTracking: body.canManageTracking ?? true,
        canManageCompanySettings: body.canManageCompanySettings ?? true,
        canManageCompanyUsers: body.canManageCompanyUsers ?? false,
      },
      select: userSelect,
    });
    res.status(201).json({ success: true, data: user });
  } catch (err) { next(err); }
});

router.put('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!(await requireCompanyOwner(req, res))) return;
    const tid = tenantId(req);
    const current = await prisma.admin.findFirst({ where: { id: req.params.id, tenantId: tid } });
    if (!current) { res.status(404).json({ success: false, message: 'المستخدم غير موجود' }); return; }

    const { password, ...data } = userSchema.partial().parse(req.body);
    if (password && password.length < 6) { res.status(400).json({ success: false, message: 'كلمة المرور 6 أحرف على الأقل' }); return; }
    if (data.email && await duplicateEmail(data.email, current.id)) {
      res.status(409).json({ success: false, message: 'البريد الإلكتروني مستخدم مسبقاً' });
      return;
    }
    if (current.id === req.user?.id && (data.isActive === false || (data.role && data.role !== current.role) || data.canManageCompanyUsers === false)) {
      res.status(400).json({ success: false, message: 'لا يمكنك تعطيل حسابك أو تغيير دورك أو إزالة صلاحية إدارة المستخدمين من حسابك' });
      return;
    }
    if (await blocksLastAdmin(tid, current, data)) {
      res.status(400).json({ success: false, message: 'يجب أن يبقى مستخدم مدير نشط واحد على الأقل للشركة' });
      return;
    }

    const updateData: Record<string, unknown> = { ...data };
    if (password) updateData.passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.admin.update({
      where: { id: current.id },
      data: updateData,
      select: userSelect,
    });
    res.json({ success: true, data: user });
  } catch (err) { next(err); }
});

export default router;
