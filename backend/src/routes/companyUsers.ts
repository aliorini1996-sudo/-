import { Router, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, tenantId } from '../middleware/auth';
import { getAdminScope, setAdminScope, adminScopeEnabled } from '../services/adminScope';
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
  canManageDailyReport: z.boolean().optional(),
  canManageCompanyUsers: z.boolean().optional(),
  // ⚠️ **`scopeEnabled` مقصودٌ غيابه هنا** — لا يُكتب إلا من `PUT /:id/scope`
  // المحروس بـ`guardScopeAdmin`.
  //
  // كان مُدرَجاً في هذا المخطّط فيمرّ عبر `updateData = { ...data }` إلى
  // `admin.update` بلا حارس نطاق: مستخدمٌ مقيّد يملك `canManageCompanyUsers`
  // يرسل `PUT /company-users/<معرّفه>` بـ`{scopeEnabled:false}` **فيفكّ عزل
  // نفسه بطلب واحد** — ناقضاً الحارس المبنيّ على مسارَي `/scope` وحدهما.
  // ويسري فوراً لأن النطاق يُقرأ من القاعدة لا من التوكن.
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
  canManageDailyReport: true,
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
    if (body.password.length < 8) { res.status(400).json({ success: false, message: 'كلمة المرور 8 أحرف على الأقل' }); return; }
    if (await duplicateEmail(body.email)) { res.status(409).json({ success: false, message: 'البريد الإلكتروني مستخدم مسبقا' }); return; }

    const tenant = await prisma.tenant.findUnique({ where: { id: tid }, select: { maxAdminUsers: true } });
    if (tenant?.maxAdminUsers != null) {
      const current = await prisma.admin.count({ where: { tenantId: tid } });
      if (current >= tenant.maxAdminUsers) {
        res.status(403).json({ success: false, message: `بلغت الشركة الحد الأقصى المسموح لمستخدمي الشركة (${tenant.maxAdminUsers}) تواصل مع مالك المنصة لرفع الحد` });
        return;
      }
    }

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
        canManageDailyReport: body.canManageDailyReport ?? true,
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
    if (password && password.length < 8) { res.status(400).json({ success: false, message: 'كلمة المرور 8 أحرف على الأقل' }); return; }
    if (data.email && await duplicateEmail(data.email, current.id)) {
      res.status(409).json({ success: false, message: 'البريد الإلكتروني مستخدم مسبقا' });
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
    // حزامٌ ثانٍ فوق حذفه من المخطّط: حقلُ نطاقٍ يُضاف مستقبلاً لـ`userSchema`
    // سيمرّ من هنا صامتاً وإلا. النطاق لا يُكتب إلا من مساره المحروس.
    delete updateData.scopeEnabled;
    if (password) updateData.passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.admin.update({
      where: { id: current.id },
      data: updateData,
      select: userSelect,
    });
    res.json({ success: true, data: user });
  } catch (err) { next(err); }
});

/**
 * حذف مستخدم شركة — نظير حذف المندوب، بحُرّاسه الثلاثة.
 *
 * لماذا الحرّاس أشدّ من حذف المندوب: المندوب لا يملك مفاتيح اللوحة، أمّا هنا
 * فالحذف قد يقفل الشركة على نفسها إن أزال آخر مديرٍ يملك إدارة المستخدمين.
 *
 * ولا يُترك للحذف أثرٌ يتيم: `AdminCustomerScope` و`AdminRepScope` معرَّفان
 * بـ`onDelete: Cascade` فيمضيان مع السجلّ. والفواتير والسندات تُنسَب للمندوب لا
 * لمستخدم اللوحة، فلا سجلّ ماليّ يُمسّ.
 *
 * ويبقى جدولٌ واحد يشير إلى Admin **بلا مفتاح أجنبيّ**: أصحاب عقد سلسلة
 * التقرير اليومي — وهم مُعالَجون داخل المسار أدناه حارساً وتنظيفاً.
 */
router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!(await requireCompanyOwner(req, res))) return;
    const tid = tenantId(req);

    // القيد: المدير الرئيسي فقط (لا مشرف/محاسب) — مطابقةً لحذف المندوب
    if (req.user?.role !== 'ADMIN') {
      res.status(403).json({ success: false, message: 'حذف مستخدم الشركة متاح للمدير الرئيسي فقط' });
      return;
    }

    const target = await prisma.admin.findFirst({
      where: { id: req.params.id, tenantId: tid },
      select: { id: true, name: true, role: true, isActive: true, canManageCompanyUsers: true },
    });
    if (!target) { res.status(404).json({ success: false, message: 'المستخدم غير موجود' }); return; }

    // حذف الذات يقطع الجلسة الحاليّة ويترك المستخدم أمام شاشة لا يفهمها
    if (target.id === req.user?.id) {
      res.status(400).json({ success: false, message: 'لا يمكنك حذف حسابك الخاص' });
      return;
    }

    // آخر مديرٍ نشط يملك إدارة المستخدمين: حذفه يقفل الشركة خارج لوحتها بلا رجعة
    if (target.role === 'ADMIN' && target.isActive && target.canManageCompanyUsers) {
      const others = await prisma.admin.count({
        where: { tenantId: tid, id: { not: target.id }, role: 'ADMIN', isActive: true, canManageCompanyUsers: true },
      });
      if (others === 0) {
        res.status(400).json({ success: false, message: 'يجب أن يبقى مستخدم مدير نشط واحد على الأقل للشركة' });
        return;
      }
    }

    /* عقدة سلسلة الاعتماد — الأثر اليتيم الذي كان يفلت.
     *
     * `DailyReportLevelOwner.adminId` نصٌّ **بلا مفتاح أجنبيّ**: القاعدة لا تمنع
     * شيئاً، فتبقى العقدة باسم رجلٍ لا حساب له — مهامّها لا تظهر في صندوق أحد،
     * ولا تصدر حصيلة أيّامها، ولا تُحذف العقدة (مهامّها واقفة). ولا شكوى من
     * أيّ شيء في المنظومة كلّها، أسبوعاً كاملاً.
     *
     * والرفض محصورٌ في الحالتين اللتين **توقفان** المسار، لا كل عضوية:
     *  ١) آخر صاحبٍ حيٍّ لمستوى — فلا مستقبِل لتقاريره إطلاقاً.
     *  ٢) آخر صاحبٍ **افتراضيٍّ** حيّ — فالمناديب غير المُوجَّهين بلا مستقبِل،
     *     وهو نفسه ما يرفضه مسار تعيين الأصحاب حين تُفرَّغ قائمة الافتراضيين.
     * وما عدا ذلك تُحذف عقدُه مع حسابه: عقدةٌ شاغرة أسوأ من غيابها، والمناديب
     * المُوجَّهون إليه يعودون إلى الصاحب الافتراضي وهو مقصود.
     *
     * والرفض مشروطٌ بكون الميزة **مفعّلة**: شركةٌ أُطفئت عندها لا تستطيع فتح
     * شاشة السلسلة أصلاً (حارس `requireDailyReport`)، فرفضُ الحذف يحبسها أمام
     * علاجٍ لا سبيل إليه. أمّا التنظيف فيجري في الحالين.
     */
    const myNodes = await prisma.dailyReportLevelOwner.findMany({
      where: { tenantId: tid, adminId: target.id },
      select: { id: true, levelId: true, isDefault: true },
    });
    const feature = await prisma.tenant.findUnique({ where: { id: tid }, select: { dailyReportEnabled: true } });
    if (myNodes.length && feature?.dailyReportEnabled === true) {
      const levelIds = [...new Set(myNodes.map(n => n.levelId))];
      const [levels, siblings, liveAdmins] = await Promise.all([
        prisma.dailyReportLevel.findMany({ where: { tenantId: tid, id: { in: levelIds } }, select: { id: true, name: true } }),
        prisma.dailyReportLevelOwner.findMany({
          where: { tenantId: tid, levelId: { in: levelIds }, adminId: { not: target.id } },
          select: { levelId: true, adminId: true, isDefault: true },
        }),
        // «حيّ» = موجودٌ ونشِط: المعطَّل لا يفتح صندوقه فلا يُحسب خلَفاً
        prisma.admin.findMany({ where: { tenantId: tid, isActive: true }, select: { id: true } }),
      ]);
      const liveIds = new Set(liveAdmins.map(a => a.id));
      const nameOf = new Map(levels.map(l => [l.id, l.name]));
      for (const lid of levelIds) {
        const label = nameOf.get(lid) || 'مستوى';
        const rest = siblings.filter(s => s.levelId === lid && liveIds.has(s.adminId));
        if (!rest.length) {
          res.status(400).json({
            success: false,
            message: `${target.name} آخر صاحب لمستوى «${label}» في سلسلة التقرير اليومي عين صاحبا غيره من صفحة التقرير اليومي قبل حذفه`,
          });
          return;
        }
        const mineHere = myNodes.filter(n => n.levelId === lid);
        if (mineHere.some(n => n.isDefault) && !rest.some(s => s.isDefault)) {
          res.status(400).json({
            success: false,
            message: `${target.name} الصاحب الافتراضي لمستوى «${label}» في سلسلة التقرير اليومي عين افتراضيا غيره قبل حذفه`,
          });
          return;
        }
      }
    }

    /* معاملة واحدة: التوجيهات ثمّ العقد ثمّ الحساب — فلا تبقى عقدة باسم محذوف
     * ولو انقطع الطلب بين السطرين. */
    await prisma.$transaction([
      prisma.dailyReportOwnerRep.deleteMany({ where: { tenantId: tid, ownerId: { in: myNodes.map(n => n.id) } } }),
      prisma.dailyReportLevelOwner.deleteMany({ where: { tenantId: tid, adminId: target.id } }),
      prisma.admin.delete({ where: { id: target.id } }),
    ]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

/**
 * نطاق مستخدم الشركة: العملاء والمناديب الذين يراهم.
 *
 * ⚠️ كان هذا التعليق يَعِد بحماية **غير موجودة في الكود**: المسارَان كانا بلا
 * `requireCompanyOwner`، و`requireAdmin` يقبل المشرف والمحاسب بلا فحص صلاحيات
 * ⇒ أي مستخدم شركة يستطيع `PUT /company-users/<معرّفه>/scope` بـ
 * `scopeEnabled:false` فيفكّ عزل نفسه بطلب واحد، ويسري فوراً لأن النطاق يُقرأ
 * من قاعدة البيانات لا من التوكن. حارسان الآن، ووحدة الاختبار أدناه تمنع عودته:
 *  1. `requireCompanyOwner` — من يملك تعديل الصلاحيات وحده يحدّد النطاق.
 *  2. المستخدم المقيّد نفسه ممنوع من إدارة النطاقات إطلاقاً — ولو مُنح
 *     canManageCompanyUsers سهواً — فلا يوسّع نطاقه ولا يقرأ نطاق غيره.
 */
async function guardScopeAdmin(req: AuthRequest, res: Response): Promise<boolean> {
  if (!(await requireCompanyOwner(req, res))) return false;
  if (await adminScopeEnabled(req)) {
    res.status(403).json({ success: false, message: 'حسابك مقيد بنطاق محدد تحديد النطاقات يحتاج صلاحية غير مقيدة' });
    return false;
  }
  return true;
}

router.get('/:id/scope', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!(await guardScopeAdmin(req, res))) return;
    const tid = tenantId(req);
    const admin = await prisma.admin.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, scopeEnabled: true } });
    if (!admin) { res.status(404).json({ success: false, message: 'المستخدم غير موجود' }); return; }
    const scope = await getAdminScope(admin.id);
    res.json({ success: true, data: { scopeEnabled: admin.scopeEnabled, ...scope } });
  } catch (err) { next(err); }
});

router.put('/:id/scope', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!(await guardScopeAdmin(req, res))) return;
    const tid = tenantId(req);
    const admin = await prisma.admin.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!admin) { res.status(404).json({ success: false, message: 'المستخدم غير موجود' }); return; }

    // null (أو غياب المفتاح) = «لا تلمس هذه القائمة» — يسمح بتحديث إحداهما وحدها
    const body = z.object({
      customerIds: z.array(z.string()).max(50000).nullable().optional(),
      salesRepIds: z.array(z.string()).max(5000).nullable().optional(),
      scopeEnabled: z.boolean().optional(),
    }).parse(req.body);

    if (body.scopeEnabled !== undefined) {
      await prisma.admin.update({ where: { id: admin.id }, data: { scopeEnabled: body.scopeEnabled } });
    }
    const counts = await setAdminScope(tid, admin.id, body.customerIds ?? null, body.salesRepIds ?? null);
    res.json({ success: true, data: counts });
  } catch (err) { next(err); }
});

export default router;
