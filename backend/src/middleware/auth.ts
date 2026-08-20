import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';
import { AuthRequest, AuthPayload } from '../types';
import { bumpRequest } from '../services/requestCounter';

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

// خنق تحديث «آخر ظهور» لمستخدمي الشركة: لا نكتب أكثر من مرة/دقيقة للحساب الواحد.
const PRESENCE_THROTTLE_MS = 60 * 1000;

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
    res.status(401).json({ success: false, message: 'جلسة منتهية يرجى تسجيل الدخول مجددا' });
    return;
  }
  req.user = payload;

  // عدّ الطلبات (الاستهلاك) لكل مستخدم — تراكمٌ في الذاكرة، إفراغٌ دوريّ. نتخطّى
  // المالك (لا شركة له) وجلساتِ الانتحال (كي لا تُنسَب طلبات المالك لمستخدم الشركة).
  if (payload.tenantId && !payload.impersonated) {
    if (payload.role === 'SALES_REP') bumpRequest('rep', payload.id, payload.tenantId);
    else if (COMPANY_ROLES.includes(payload.role)) bumpRequest('admin', payload.id, payload.tenantId);
  }

  if (!COMPANY_ROLES.includes(payload.role)) { next(); return; }
  try {
    const admin = await prisma.admin.findUnique({
      where: { id: payload.id },
      select: { isActive: true, lastSeenAt: true },
    });
    if (!admin?.isActive) {
      res.status(401).json({ success: false, message: 'انتهت صلاحية الحساب سجل الدخول مجددا' });
      return;
    }
    // لمسة «آخر ظهور» لعدّاد «الزيارات الحية» في لوحة المالك — مخنوقة لمرة/دقيقة،
    // وغير مُنتظَرة كي لا تؤخّر الرد؛ فشلها لا يهمّ فالحضور best-effort.
    //
    // نتخطّاها في جلسة انتحال المالك (impersonated): وإلّا لبمّط دخولُ المالك لوحةَ
    // شركةٍ صفَّ أدمنها كأنه «متصل الآن» فتظهر الشركة حيّة زوراً — تلويثٌ للمقياس نفسه.
    //
    // البوّابة السريعة (القيمة المقروءة) تتجنّب إطلاق أمرٍ حين يكون الظهور حديثاً،
    // والكتابة نفسها ذرّيّة مشروطة (updateMany بشرط النافذة على الصفّ): تحت برستٍ
    // من طلبات متوازية للحساب ذاته يربح صفٌّ واحد فقط ويُلغى الباقي في القاعدة،
    // فلا يتحوّل الخنق إلى N كتابة. (dsd-backend نسخة واحدة، لكن هذا يصمد أيّاً كان.)
    if (!payload.impersonated && (!admin.lastSeenAt || Date.now() - new Date(admin.lastSeenAt).getTime() > PRESENCE_THROTTLE_MS)) {
      const cutoff = new Date(Date.now() - PRESENCE_THROTTLE_MS);
      prisma.admin.updateMany({
        where: { id: payload.id, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }] },
        data: { lastSeenAt: new Date() },
      }).catch(() => { /* لمسة حضور best-effort */ });
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
