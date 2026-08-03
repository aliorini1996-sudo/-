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

const COMPANY_ROLES = ['ADMIN', 'MANAGER', 'ACCOUNTANT'];

/**
 * التحقّق من الجلسة — **والحساب نفسه لمستخدمي لوحة الشركة**.
 *
 * التوكن يعيش ٨ ساعات، فالدور المحفور فيه لا يكفي: حسابٌ حُذف أو عُطِّل يبقى
 * توكنه صالحاً حتى انتهائه، يقرأ ويكتب كأن شيئاً لم يكن.
 *
 * والأخطر أن الحذف كان **يفتح** لا يغلق: قارئ النطاق `adminScopeEnabled` يبحث
 * عن الصفّ فلا يجده فيستنتج «بلا تقييد» = رؤية كاملة. أي أن مستخدماً مقيّداً
 * حُذف حسابه كان يكسب رؤيةً أوسع ممّا كانت له وهو قائم.
 *
 * **الفحص لمستخدمي اللوحة وحدهم عمداً:** المندوب يرسل نبضة موقع كل دقائق،
 * وإضافة قراءةٍ لكل نبضة كلفةٌ في مسار ساخن بلا مقابل — وحساباته يحرسها
 * مسارها. ومستخدمو اللوحة قلّة وطلباتهم تحميل صفحات لا نبضات.
 */
export async function authenticate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    res.status(401).json({ success: false, message: 'غير مصرح' });
    return;
  }
  let payload: AuthPayload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET!) as AuthPayload;
  } catch {
    res.status(401).json({ success: false, message: 'جلسة منتهية، يرجى تسجيل الدخول مجدداً' });
    return;
  }
  req.user = payload;

  if (!COMPANY_ROLES.includes(payload.role)) { next(); return; }
  try {
    const admin = await prisma.admin.findUnique({
      where: { id: payload.id },
      select: { isActive: true },
    });
    if (!admin?.isActive) {
      res.status(401).json({ success: false, message: 'انتهت صلاحية الحساب، سجّل الدخول مجدداً' });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** دور لوحة الشركة. حياة الحساب (حذف/تعطيل) تُفحص في `authenticate` قبله. */
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user || !COMPANY_ROLES.includes(req.user.role)) {
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
      // نجلب السجلّ كاملاً بدل select بمفتاح ديناميكي: المفتاح الديناميكي
      // يجعل نوع النتيجة اتّحاداً يشمل حقول العلاقات (adminScopes…) فيفشل
      // فحص الأنواع. السجلّ صغير وبمفتاح أساسي، فالكلفة مهملة والقراءة أوضح.
      const admin = await prisma.admin.findUnique({ where: { id: req.user.id } });
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
