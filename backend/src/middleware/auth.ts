import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';
import { AuthRequest, AuthPayload } from '../types';
import { bumpRequest } from '../services/requestCounter';
import { ledgerPermissionDecision, LedgerKey } from '../services/gl/permissions';

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
  | 'canManageCompanyUsers'
  | 'canManageDailyReport'
  // استلام (توريد) عهدة التحصيل من مستخدمي الشركة — افتراضها false، فيحرسها
  // requireAdminPermission بأمان (يمنع عند القيمة false، فلا يمرّ إلا المفعَّل له)
  | 'canReceiveUserCollections'
  // صلاحيات الدفاتر — تُحرس بـrequireLedgerPermission لا بـrequireAdminPermission
  // (ذاك يمنع عند === false وحدها ويتجاهل الدور، وهذه افتراضها false)
  | 'canViewLedger'
  | 'canPostJournals'
  | 'canManagePayables'
  | 'canManageBank'
  | 'canCloseLedgerPeriods'
  | 'canConfigureLedger';

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

// حارس «النظام المحاسبي» — يعزل المنتجات ومخزون السيارات والمستودع والفواتير والسندات.
// خلافاً لبقيّة أعلام الاشتراك، افتراض هذا العَلَم `true`: فلا نمنع إلا حين يكون
// `false` صراحةً. و`!t?.accountingEnabled` خطأٌ هنا لأنّه يمنع أيضاً عند تعذّر القراءة.
// ونقرأ tenantId من الطلب مباشرةً لا عبر tenantId(req): الأخيرة ترمي استثناءً
// للسوبر أدمن (لا شركة له) فتحوّل مروره من 403 إلى 500.
/**
 * التقرير اليومي — ميزة اشتراك **مطفأة افتراضياً**.
 *
 * الشرط `!== true` لا `=== false`، عكسَ حارس المحاسبة: ذاك عَلَمٌ مفعّل
 * افتراضياً فيُمنع عند false الصريحة وحدها؛ وهذا مطفأ افتراضياً، فتعذّرُ
 * قراءة الصفّ يجب أن **يمنع** لا أن يفتح. وقلبُ الشرط هنا يفتح الميزة
 * لكل شركة تعذّرت قراءة صفّها.
 */
export async function requireDailyReport(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const tid = req.user?.tenantId;
    // لا شركة = سوبر أدمن؛ تمريره كما في requireAccounting (tenantId(req) ترمي له)
    if (!tid) { next(); return; }
    const t = await prisma.tenant.findUnique({ where: { id: tid }, select: { dailyReportEnabled: true } });
    if (t?.dailyReportEnabled !== true) {
      res.status(403).json({ success: false, code: 'DAILY_REPORT_NOT_ALLOWED', message: 'التقرير اليومي غير مفعّل لهذه الشركة تواصل مع مزود الخدمة' });
      return;
    }
    next();
  } catch (err) { next(err); }
}

export async function requireAccounting(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const tid = req.user?.tenantId;
    if (!tid) { next(); return; }
    const t = await prisma.tenant.findUnique({ where: { id: tid }, select: { accountingEnabled: true } });
    if (t?.accountingEnabled === false) {
      res.status(403).json({ success: false, code: 'ACCOUNTING_NOT_ALLOWED', message: 'النظام المحاسبي غير مفعّل لهذه الشركة تواصل مع مزود الخدمة' });
      return;
    }
    next();
  } catch (err) { next(err); }
}

/**
 * النظام المحاسبي المتكامل — مطفأ افتراضياً: الشرط `!== true` (نمط requireDailyReport).
 * ويشترط أيضاً ألا يكون النظام المحاسبي (accountingEnabled) مطفأً صراحةً.
 * tenantId من req.user مباشرةً: tenantId(req) ترمي للسوبر أدمن فتحوّل 403 إلى 500.
 */
export async function requireAccountingSuite(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const tid = req.user?.tenantId;
    if (!tid) { next(); return; }
    const t = await prisma.tenant.findUnique({ where: { id: tid }, select: { accountingSuiteEnabled: true, accountingEnabled: true } });
    if (t?.accountingSuiteEnabled !== true || t?.accountingEnabled === false) {
      res.status(403).json({ success: false, code: 'ACCOUNTING_SUITE_NOT_ALLOWED', message: 'النظام المحاسبي المتكامل غير مفعّل لهذه الشركة تواصل مع مزود الخدمة' });
      return;
    }
    next();
  } catch (err) { next(err); }
}

/**
 * صلاحية الدفاتر (§9.1) — يُقرأ المستخدم من القاعدة لا من التوكن، والمسند الصرف
 * `ledgerPermissionDecision` يطابق `canLedger` في الويب:
 * مقيّد النطاق ⇒ LEDGER_SCOPED_ADMIN؛ مالك الشركة (ADMIN مع canManageCompanyUsers)
 * يمرّ؛ canViewLedger يمرّ بأيٍّ من الست؛ غير ذلك true الصريحة وحدها ⇒ وإلا
 * LEDGER_PERMISSION_DENIED. المندوب يمنعه requireAdmin قبله في سلسلة الموجّه.
 */
export function requireLedgerPermission(key: LedgerKey) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tid = req.user?.tenantId;
      if (!req.user || !tid || !COMPANY_ROLES.includes(req.user.role)) {
        res.status(403).json({ success: false, code: 'LEDGER_PERMISSION_DENIED', message: 'لا تملك صلاحية الوصول لهذا القسم' });
        return;
      }
      const admin = await prisma.admin.findUnique({
        where: { id: req.user.id },
        select: {
          isActive: true, tenantId: true, role: true, canManageCompanyUsers: true, scopeEnabled: true,
          canViewLedger: true, canPostJournals: true, canManagePayables: true,
          canManageBank: true, canCloseLedgerPeriods: true, canConfigureLedger: true,
        },
      });
      const decision = ledgerPermissionDecision(admin, key, tid);
      if (decision === 'SCOPED') {
        res.status(403).json({ success: false, code: 'LEDGER_SCOPED_ADMIN', message: 'الدفاتر على مستوى الشركة كلها وحسابك مقيد بنطاق محدد' });
        return;
      }
      if (decision !== 'ALLOW') {
        res.status(403).json({ success: false, code: 'LEDGER_PERMISSION_DENIED', message: 'لا تملك صلاحية الوصول لهذا القسم' });
        return;
      }
      next();
    } catch (err) { next(err); }
  };
}
