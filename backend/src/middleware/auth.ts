import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';
import { AuthRequest, AuthPayload } from '../types';

export type AdminPermission =
  | 'canAccessDashboard'
  | 'canManageCustomers'
  | 'canManageProducts'
  | 'canManageSalesReps'
  | 'canManageInvoices'
  | 'canManageReceipts'
  | 'canViewReports'
  | 'canManageVanStock'
  | 'canManageTracking'
  | 'canManageCompanySettings'
  | 'canManageCompanyUsers';

export function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    res.status(401).json({ success: false, message: 'غير مصرح' });
    return;
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as AuthPayload;
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'جلسة منتهية، يرجى تسجيل الدخول مجدداً' });
  }
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user || !['ADMIN', 'MANAGER', 'ACCOUNTANT'].includes(req.user.role)) {
    res.status(403).json({ success: false, message: 'غير مسموح' });
    return;
  }
  next();
}

export function requireAdminPermission(permission: AdminPermission) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (req.user?.role === 'SALES_REP') { next(); return; }
      if (!req.user || !['ADMIN', 'MANAGER', 'ACCOUNTANT'].includes(req.user.role)) {
        res.status(403).json({ success: false, message: 'غير مسموح' });
        return;
      }
      const admin = await prisma.admin.findUnique({
        where: { id: req.user.id },
        select: { isActive: true, [permission]: true },
      });
      if (!admin?.isActive || admin[permission] === false) {
        res.status(403).json({ success: false, message: 'لا تملك صلاحية الوصول لهذا القسم' });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireSalesRep(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'SALES_REP') {
    res.status(403).json({ success: false, message: 'غير مسموح' });
    return;
  }
  next();
}

// مالك المنصّة فقط (إدارة الشركات والاشتراكات)
export function requireSuperAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'SUPER_ADMIN') {
    res.status(403).json({ success: false, message: 'غير مسموح' });
    return;
  }
  next();
}

// يضمن وجود معرّف شركة لكل مستخدم (عدا السوبر أدمن) — حارس ضد تسريب البيانات
export function tenantId(req: AuthRequest): string {
  if (!req.user?.tenantId) throw new Error('لا توجد شركة مرتبطة بالحساب');
  return req.user.tenantId;
}
