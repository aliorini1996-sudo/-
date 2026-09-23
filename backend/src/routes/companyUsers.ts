import { Router, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { clean } from '../services/accounting';
import { getAdminScope, setAdminScope, adminScopeEnabled } from '../services/adminScope';
import { userCustody, lockCustody, handoverAllowed, CustodyExceeded, CUSTODY_EPS } from '../services/userCustody';
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
  canReceiveUserCollections: z.boolean().optional(),
  // صلاحيات الدفاتر (§9.2) — تُنزع في الإنشاء والتعديل ما لم تكن الميزة مفعّلة للشركة
  canViewLedger: z.boolean().optional(),
  canPostJournals: z.boolean().optional(),
  canManagePayables: z.boolean().optional(),
  canManageBank: z.boolean().optional(),
  canCloseLedgerPeriods: z.boolean().optional(),
  canConfigureLedger: z.boolean().optional(),
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
  canReceiveUserCollections: true,
  // بدونها يقرأ نموذج التعديل undefined فيعيد كل حفظٍ كتابة صلاحيات الدفاتر
  canViewLedger: true,
  canPostJournals: true,
  canManagePayables: true,
  canManageBank: true,
  canCloseLedgerPeriods: true,
  canConfigureLedger: true,
  createdAt: true,
} as const;

const LEDGER_PERMISSION_KEYS = ['canViewLedger', 'canPostJournals', 'canManagePayables', 'canManageBank', 'canCloseLedgerPeriods', 'canConfigureLedger'] as const;

/** النظام المحاسبي المتكامل مفعّل للشركة؟ مطفأ افتراضياً ⇒ `=== true` (تعذّر القراءة يمنع). */
async function ledgerSuiteOn(tid: string): Promise<boolean> {
  const t = await prisma.tenant.findUnique({ where: { id: tid }, select: { accountingSuiteEnabled: true, accountingEnabled: true } });
  return t?.accountingSuiteEnabled === true && t?.accountingEnabled !== false;
}

/** حارس الخادم: صلاحية مخفية لا تُكتب — تُحذف مفاتيح الدفاتر حين تكون الميزة مطفأة. */
function stripLedgerKeys(data: Record<string, unknown>): void {
  for (const k of LEDGER_PERMISSION_KEYS) delete data[k];
}

/** من يدير مستخدمي الشركة — يعيد دوره من القاعدة (لا من التوكن) لحارس حسابات المدير، أو null بعد ردّ 403. */
async function requireCompanyOwner(req: AuthRequest, res: Response): Promise<{ role: string } | null> {
  if (!req.user || !['ADMIN', 'MANAGER', 'ACCOUNTANT'].includes(req.user.role)) {
    res.status(403).json({ success: false, message: 'غير مسموح' });
    return null;
  }
  const admin = await prisma.admin.findUnique({
    where: { id: req.user.id },
    select: { isActive: true, canManageCompanyUsers: true, role: true },
  });
  if (!admin?.isActive || !admin.canManageCompanyUsers) {
    res.status(403).json({ success: false, message: 'إدارة مستخدمي الشركة غير متاحة لهذا الحساب' });
    return null;
  }
  return { role: admin.role };
}

export const ADMIN_ACCOUNT_REFUSALS = Object.freeze({
  // لكل الشركات: الإنشاء والترقية والخفض وكلمة المرور وحدها (تقييد النطاق بلا علم المالك يغيّره المشرف والمحاسب كما كان)
  COMPANY_ADMIN_ACCOUNT_ONLY: 'حسابات مدير الشركة (إنشاؤها أو الترقية إليها أو تغيير دورها أو كلمة مرورها) يديرها مدير الشركة فقط',
  // لشركة بعلم المالك وحدها: تغيير تقييد نطاق مدير (بلا دور ولا كلمة مرور) من مشرف أو محاسب
  COMPANY_ADMIN_SCOPE_ONLY: 'تقييد نطاق حساب مدير الشركة أو رفعه مرتبط بربط الفوترة الإلكترونية — يديره مدير الشركة فقط',
  ADMIN_ACCOUNT_SCOPED: 'حسابك مقيد بنطاق محدد — حسابات مدير الشركة (إنشاؤها أو الترقية إليها أو تغيير دورها أو كلمة مرورها أو تقييد نطاقها) يديرها مدير شركة بصلاحية غير مقيدة',
});
export type AdminAccountRefusal = keyof typeof ADMIN_ACCOUNT_REFUSALS;

/**
 * targetRole = دور الحساب قبل التعديل (null عند الإنشاء)، newRole = الدور المرسَل، password = أُرسلت كلمة مرور جديدة،
 * scope = يتغيّر تفعيل تقييد النطاق (PUT /:id/scope) — رفعه عن مدير مقيّد يفتح له بوابة /api/zatca وحقول البائع.
 */
export interface AdminAccountChange { targetRole: string | null; newRole?: string; password?: boolean; scope?: boolean }

/** تغيير يمسّ حساب «مدير الشركة»: إنشاء مدير أو الترقية إليه، أو خفض دور مدير أو تعيين كلمة مروره أو تغيير تقييد نطاقه. */
export function changesAdminAccount(change: AdminAccountChange): boolean {
  if (change.newRole === 'ADMIN' && change.targetRole !== 'ADMIN') return true;
  return change.targetRole === 'ADMIN' && ((change.newRole !== undefined && change.newRole !== 'ADMIN') || change.password === true || change.scope === true);
}

/**
 * حسابات «مدير الشركة» (ADMIN) لا يُنشئها ولا يرقّي إليها ولا يخفّض منها ولا يغيّر كلمة مرورها إلا مدير شركة (دوره في القاعدة).
 * وإلا فمشرف أو محاسب يملك canManageCompanyUsers ينشئ حساب مدير بكلمة مرور يختارها، أو يرقّي حساباً، أو يعيد تعيين كلمة مرور
 * المدير — ثم يدخل به فيلتفّ بطلبين على ما قصره المالك على مدير الشركة (ربط فوترة ZATCA المرحلة الثانية، وحذف المستخدمين).
 * ولشركة فعّل لها المالك ربط فوترة المرحلة الثانية: المدير مقيّد النطاق — تردّه بوابة /api/zatca — لا يُنشئ مديراً غير مقيّد ولا
 * يعيد تعيين كلمة مرور مدير فيدخل به. التقييد (من القاعدة) وعلم الشركة يُقرآن عند تغيير يمسّ حساب مدير وحده، وبلا العلم يبقى
 * سلوكه كما كان (لا أثر على الشركات الأخرى). جلسة دخول مالك المنصة تُعامل كحساب المدير الذي يمثّله توكنها — دوره ونطاقه من صفّه
 * في القاعدة (قرار المالك 17 سبتمبر 2026: الانتحال يربط الفوترة كالمدير، فلا رفض خاصّ به هنا). null = مسموح.
 * وتقييد نطاق المدير وحده (بلا دور ولا كلمة مرور) يُحرس لشركة بعلم المالك وحدها — وإلا فمدير مقيّد ينشئ مشرفاً يملك إدارة
 * المستخدمين (أو يعيد تعيين كلمة مرور مشرف) ثم يرفع به تقييد نفسه فيعبر بوابة /api/zatca؛ وبلا العلم كما كان لكل الأدوار.
 */
export async function adminAccountChangeRefusal(
  caller: { role: string },
  change: AdminAccountChange,
  load: { scoped: () => Promise<boolean>; zatcaPhase2On: () => Promise<boolean> },
): Promise<AdminAccountRefusal | null> {
  if (!changesAdminAccount(change)) return null;
  if (caller.role !== 'ADMIN') {
    const scopeOnly = !changesAdminAccount({ ...change, scope: false });
    if (!scopeOnly) return 'COMPANY_ADMIN_ACCOUNT_ONLY';
    return (await load.zatcaPhase2On()) === true ? 'COMPANY_ADMIN_SCOPE_ONLY' : null;
  }
  if ((await load.scoped()) !== true) return null;
  return (await load.zatcaPhase2On()) === true ? 'ADMIN_ACCOUNT_SCOPED' : null;
}

/** يطبّق adminAccountChangeRefusal على الطلب: false بعد ردّ 403 برمز الرفض ورسالته. */
async function guardAdminAccountChange(req: AuthRequest, res: Response, caller: { role: string }, change: AdminAccountChange): Promise<boolean> {
  const tid = tenantId(req);
  const refusal = await adminAccountChangeRefusal({ role: caller.role }, change, {
    scoped: () => adminScopeEnabled(req),
    zatcaPhase2On: async () => (await prisma.tenant.findUnique({ where: { id: tid }, select: { zatcaPhase2Enabled: true } }))?.zatcaPhase2Enabled === true,
  });
  if (!refusal) return true;
  res.status(403).json({ success: false, code: refusal, message: ADMIN_ACCOUNT_REFUSALS[refusal] });
  return false;
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

/**
 * حارس شاشة عهدة التحصيل: من يدير مستخدمي الشركة **وغير مقيّد بنطاق**.
 *
 * ولماذا يُستثنى المقيّد بنطاق: رصيد العهدة مجموعُ استلاماتٍ من مناديب الشركة
 * كلّهم، وتقييدُ النطاق إنّما وُضع ليحجب عن صاحبه ما ليس في نطاقه (تفرضه
 * `scopedRecordWhere` في كلّ شاشةٍ أخرى). فلو مرّ من هنا لقرأ في عمودٍ واحد
 * حصيلةَ مناديب مُنع من رؤية صفحاتهم، ولاستلم نقداً من عهدةٍ لا تخصّه.
 *
 * والحارس الثابت في `adminScope.test` يعرف هذا الاسم: لا يقبل مساراً في هذا
 * الملفّ إلّا بأحد حرّاسه، وهذا أوّلُ ما يفعله استدعاءُ `requireCompanyOwner`.
 */
async function guardCustody(req: AuthRequest, res: Response): Promise<{ role: string } | null> {
  const caller = await requireCompanyOwner(req, res);
  if (!caller) return null;
  if (await adminScopeEnabled(req)) {
    res.status(403).json({ success: false, message: 'حسابك مقيد بنطاق محدد وعهدة التحصيل تخص مناديب الشركة كلهم' });
    return null;
  }
  return caller;
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
    // عمود العهدة لغير المقيّد بنطاق وحده (لماذا: `guardCustody` أعلاه). والقائمة
    // تُردّ كما هي للمقيّد فلا تنكسر صفحته — العمود وحده يغيب.
    if (await adminScopeEnabled(req)) { res.json({ success: true, data: users }); return; }
    // عهدة كل مستخدم بتجميعتين لا باستعلامٍ لكلّ صفّ (N+1)
    const [recAgg, delAgg] = await Promise.all([
      prisma.repSettlement.groupBy({ by: ['receivedByUserId'], where: { tenantId: tid, receivedByUserId: { not: null } }, _sum: { amount: true } }),
      prisma.userSettlement.groupBy({ by: ['fromUserId'], where: { tenantId: tid }, _sum: { amount: true } }),
    ]);
    const recMap = new Map(recAgg.map((g) => [g.receivedByUserId as string, g._sum.amount ?? 0]));
    const delMap = new Map(delAgg.map((g) => [g.fromUserId, g._sum.amount ?? 0]));
    const withCustody = users.map((u) => ({ ...u, custody: clean((recMap.get(u.id) ?? 0) - (delMap.get(u.id) ?? 0)) }));
    res.json({ success: true, data: withCustody });
  } catch (err) { next(err); }
});

// ملخّص عهدة مستخدم (للإدارة)
router.get('/:id/custody', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!(await guardCustody(req, res))) return;
    const tid = tenantId(req);
    const target = await prisma.admin.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!target) { res.status(404).json({ success: false, message: 'المستخدم غير موجود' }); return; }
    res.json({ success: true, data: await userCustody(prisma, tid, target.id) });
  } catch (err) { next(err); }
});

// استلام (توريد نهائيّ) عهدة مستخدم — يخرج المبلغ من النظام ولا يدخل عهدة المستلِم.
// محروسٌ بصلاحية مستقلّة مطفأة (canReceiveUserCollections)، ولا يستلم أحدٌ من نفسه.
router.post('/:id/settlements', requireAdminPermission('canReceiveUserCollections'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // حارسان: صلاحية الاستلام (الوسيط أعلاه) **و**حارس صفحة مستخدمي الشركة غير
    // المقيّد — الأيقونة تسكن تلك الصفحة، فمن لا يبلغها لا يستلم من مسارها.
    if (!(await guardCustody(req, res))) return;
    const tid = tenantId(req);
    if (req.params.id === req.user?.id) { res.status(400).json({ success: false, message: 'لا يمكنك استلام عهدتك من نفسك' }); return; }
    /* جلسة انتحال المالك لا تقبض نقداً: توكنها موقَّعٌ بمعرّف أقدم مديرٍ في
     * الشركة، فالتوريد يُسجَّل باسم رجلٍ لم يستلم شيئاً — وخروج المال نهائيّ لا
     * يُراجَع. من يقبض المبلغ يوقّعه بحسابه. */
    if (req.user?.impersonated === true) {
      res.status(403).json({ success: false, message: 'استلام العهدة يسجل من حساب الشركة نفسه لا من جلسة الدعم الفني' });
      return;
    }
    const target = await prisma.admin.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!target) { res.status(404).json({ success: false, message: 'المستخدم غير موجود' }); return; }

    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) { res.status(400).json({ success: false, message: 'أدخل مبلغا صحيحا أكبر من صفر' }); return; }
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 300) : undefined;
    const METHODS = ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE'];
    const method = METHODS.includes(String(req.body?.method)) ? String(req.body.method) : 'CASH';

    /* المرفقات: رفضٌ صريح لا إسقاطٌ صامت. إسقاطُ صورةٍ كبيرة بصمتٍ يعني أن
     * المستلِم يظنّ إثباتَه محفوظاً وليس في القاعدة منه شيء — وهو إثبات نقدٍ. */
    const rawPhotos = Array.isArray(req.body?.photos) ? req.body.photos : [];
    if (rawPhotos.length > 4) { res.status(400).json({ success: false, message: 'أربع صور إثبات كحد أقصى' }); return; }
    const badPhoto = rawPhotos.some((p: unknown) => typeof p !== 'string'
      || !/^data:image\/(png|jpe?g|webp);base64,/i.test(p) || p.length > 2_500_000);
    if (badPhoto) { res.status(400).json({ success: false, message: 'المرفقات صور فقط وبحجم أصغر لكل صورة' }); return; }
    const photos = rawPhotos as string[];

    const by = req.user;
    /* المعاملة والقفل: السقف يُقرأ ويُكتب داخل قفلٍ واحد. قراءتُه قبلها تسمح
     * لطلبين متزامنين أن يمرّ كلٌّ منهما بالعهدة كاملةً فتصير سالبة. */
    await prisma.$transaction(async tx => {
      await lockCustody(tx, tid, target.id);
      const { outstanding } = await userCustody(tx, tid, target.id);
      if (!handoverAllowed(outstanding, amount)) throw new CustodyExceeded(outstanding, amount);
      await tx.userSettlement.create({
        data: {
          tenantId: tid, fromUserId: target.id, amount, method, note,
          receivedBy: `${by?.name || by?.id || 'الادمن'}`, receivedByUserId: by?.id,
          ...(photos.length && { photos: { create: photos.map((data) => ({ data })) } }),
        },
      });
    });
    res.status(201).json({ success: true, data: await userCustody(prisma, tid, target.id) });
  } catch (err) {
    if (err instanceof CustodyExceeded) { res.status(400).json({ success: false, message: err.message }); return; }
    next(err);
  }
});

// سجلّ توريدات مستخدم (مع تصفية مدى على الخادم، سقف ١٠٠)
router.get('/:id/settlements', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!(await guardCustody(req, res))) return;
    const tid = tenantId(req);
    const target = await prisma.admin.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!target) { res.status(404).json({ success: false, message: 'المستخدم غير موجود' }); return; }
    const from = typeof req.query.from === 'string' ? req.query.from : '';
    const to = typeof req.query.to === 'string' ? req.query.to : '';
    const gte = from ? new Date(from) : null;
    const lte = to ? new Date(new Date(to).setHours(23, 59, 59, 999)) : null;
    const items = await prisma.userSettlement.findMany({
      where: {
        tenantId: tid, fromUserId: target.id,
        ...((gte || lte) && { settledAt: { ...(gte && { gte }), ...(lte && { lte }) } }),
      },
      orderBy: { settledAt: 'desc' }, take: 100,
      // معرّفات الصور لا محتواها: مئةُ صفٍّ بأربع صورٍ base64 تعني عشرات
      // الميجابايتات في ردٍّ لا يعرض منها إلّا عدّاداً. المحتوى بمساره أدناه.
      include: { photos: { select: { id: true } } },
    });
    res.json({ success: true, data: items });
  } catch (err) { next(err); }
});

// صور إثبات توريدٍ واحد — تُطلب عند فتح العارض وحده (انظر سقفَ الردّ أعلاه)
router.get('/:id/settlements/:sid/photos', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!(await guardCustody(req, res))) return;
    const tid = tenantId(req);
    // الشرطان معاً: لا صفّ شركةٍ أخرى ولا صفّ مستخدمٍ آخر بمعرّفٍ منقول
    const row = await prisma.userSettlement.findFirst({
      where: { id: req.params.sid, tenantId: tid, fromUserId: req.params.id },
      select: { id: true },
    });
    if (!row) { res.status(404).json({ success: false, message: 'سجل التوريد غير موجود' }); return; }
    const photos = await prisma.userSettlementPhoto.findMany({
      where: { settlementId: row.id }, orderBy: { createdAt: 'asc' }, select: { id: true, data: true },
    });
    res.json({ success: true, data: photos });
  } catch (err) { next(err); }
});

/**
 * حذف توريدٍ سُجِّل خطأً — يعيد مبلغه إلى عهدة المستخدم.
 *
 * ولماذا يلزم مسارٌ للحذف: التوريد خروجُ مالٍ نهائيّ، ورقمٌ يُكتب خطأً (٥٠٠٠
 * بدل ٥٠٠) يخفض العهدة إلى ما لا يمثّل الواقع، ولا يعالَج بتوريدٍ مضادّ لأنّ
 * المبالغ لا تُسجَّل سالبة. فبلا هذا المسار لا علاج إلّا في قاعدة البيانات.
 *
 * وحرّاسه كحذف استلام المندوب: المدير الرئيسيّ وحده، وإشعارٌ يحمل ما يلزم
 * لإعادة التسجيل يدوياً — فلا يُمحى أثرُ نقدٍ بصمت.
 */
router.delete('/:id/settlements/:sid', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const caller = await guardCustody(req, res);
    if (!caller) return;
    if (caller.role !== 'ADMIN') {
      res.status(403).json({ success: false, message: 'حذف سجل التوريد متاح للمدير الرئيسي فقط' });
      return;
    }
    const tid = tenantId(req);
    const target = await prisma.admin.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, name: true } });
    if (!target) { res.status(404).json({ success: false, message: 'المستخدم غير موجود' }); return; }
    const row = await prisma.userSettlement.findFirst({
      where: { id: req.params.sid, tenantId: tid, fromUserId: target.id },
    });
    if (!row) { res.status(404).json({ success: false, message: 'سجل التوريد غير موجود' }); return; }

    const by = req.user;
    const actor = `${by?.name || 'الادمن'}${by?.impersonated ? ' (الدعم الفني)' : ''}`;
    const when = new Date(row.settledAt).toISOString().slice(0, 10);
    await prisma.$transaction(async tx => {
      // الصور تمضي مع الصفّ (onDelete: Cascade في المخطّط)
      await tx.userSettlement.delete({ where: { id: row.id } });
      await tx.notification.create({
        data: {
          tenantId: tid,
          type: 'USER_SETTLEMENT_DELETED',
          title: 'حذف توريد عهدة',
          body: `حذف ${actor} توريد عهدة بمبلغ ${clean(row.amount)} كان مسجلا بتاريخ ${when}`
            + ` من المستخدم ${target.name} واستلمه ${row.receivedBy || 'غير معروف'}`
            + ` — عاد المبلغ إلى عهدة المستخدم`,
          data: JSON.stringify({
            settlementId: row.id, amount: row.amount, method: row.method, note: row.note,
            fromUserId: row.fromUserId, receivedBy: row.receivedBy, receivedByUserId: row.receivedByUserId,
            settledAt: row.settledAt, deletedBy: actor, deletedById: by?.id,
          }),
        },
      });
    });
    res.json({ success: true, data: await userCustody(prisma, tid, target.id) });
  } catch (err) { next(err); }
});

/**
 * صلاحية استلام عهدة التحصيل — **منحُها** لمدير الشركة وحده.
 *
 * الثقب الذي يسدّه: من يملك `canManageCompanyUsers` (مشرفاً أو محاسباً) يعدّل
 * المستخدمين، فلولا هذا الحارس لمنح نفسه بطلبٍ واحد صلاحيةَ استلام نقدٍ من
 * عهدة أيّ زميل — وهي صلاحيةٌ قرّر المالك أن تكون مطفأة افتراضياً لأنّ المال
 * يخرج بها من النظام نهائياً. السحب (`false`) يبقى متاحاً لكلّ من يدير
 * المستخدمين: تقليل صلاحيةٍ لا يُحبس عن أحد.
 */
function blocksCustodyGrant(caller: { role: string }, requested: unknown, currentHas?: boolean): boolean {
  return requested === true && currentHas !== true && caller.role !== 'ADMIN';
}

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const caller = await requireCompanyOwner(req, res);
    if (!caller) return;
    const tid = tenantId(req);
    const body = userSchema.parse(req.body);
    if (blocksCustodyGrant(caller, body.canReceiveUserCollections)) {
      res.status(403).json({ success: false, message: 'منح صلاحية استلام التحصيل من المستخدمين يخص مدير الشركة' });
      return;
    }
    if (!(await guardAdminAccountChange(req, res, caller, { targetRole: null, newRole: body.role }))) return;
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

    if (!(await ledgerSuiteOn(tid))) stripLedgerKeys(body as Record<string, unknown>);

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
        canReceiveUserCollections: body.canReceiveUserCollections ?? false,
        // الدفاتر ميزة جديدة: ?? false لا ?? true كنظائرها
        canViewLedger: body.canViewLedger ?? false,
        canPostJournals: body.canPostJournals ?? false,
        canManagePayables: body.canManagePayables ?? false,
        canManageBank: body.canManageBank ?? false,
        canCloseLedgerPeriods: body.canCloseLedgerPeriods ?? false,
        canConfigureLedger: body.canConfigureLedger ?? false,
      },
      select: userSelect,
    });
    res.status(201).json({ success: true, data: user });
  } catch (err) { next(err); }
});

router.put('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const caller = await requireCompanyOwner(req, res);
    if (!caller) return;
    const tid = tenantId(req);
    const current = await prisma.admin.findFirst({ where: { id: req.params.id, tenantId: tid } });
    if (!current) { res.status(404).json({ success: false, message: 'المستخدم غير موجود' }); return; }

    const { password, ...data } = userSchema.partial().parse(req.body);
    if (blocksCustodyGrant(caller, data.canReceiveUserCollections, current.canReceiveUserCollections)) {
      res.status(403).json({ success: false, message: 'منح صلاحية استلام التحصيل من المستخدمين يخص مدير الشركة' });
      return;
    }
    if (!(await guardAdminAccountChange(req, res, caller, { targetRole: current.role, newRole: data.role, password: !!password }))) return;
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
    // صلاحيات الدفاتر لا تُكتب ما لم تكن الميزة مفعّلة للشركة (§9.2)
    if (!(await ledgerSuiteOn(tid))) stripLedgerKeys(updateData);
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
 * لمستخدم اللوحة، فلا سجلّ ماليّ يُمسّ — إلّا عهدةَ التحصيل: رصيدٌ في يده يمنع
 * الحذف حتى يُستلم (أوّل الحرّاس أدناه).
 *
 * ويبقى **جدولان** يشيران إلى Admin بلا مفتاح أجنبيّ، وكلاهما مُعالَج أدناه:
 * أصحاب عقد سلسلة التقرير اليومي (حارساً وتنظيفاً)، ومستلمو التقرير الشامل
 * (تنظيفاً). ولا ثالث لهما — بقيّة الجداول تُنسَب للمندوب لا لمستخدم اللوحة.
 */
router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const caller = await requireCompanyOwner(req, res);
    if (!caller) return;
    const tid = tenantId(req);

    // القيد: المدير الرئيسي فقط (لا مشرف/محاسب) — مطابقةً لحذف المندوب. الدور من القاعدة لا التوكن (كالإنشاء والتعديل):
    // مدير خُفِّض إلى مشرف وبقي توكنه ADMIN لا يحذف حتى انتهائه
    if (caller.role !== 'ADMIN') {
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

    /* عهدةٌ في يده: الحذف يُسقط المبلغ من كلّ شاشة.
     *
     * `RepSettlement.receivedByUserId` نصٌّ **بلا مفتاح أجنبيّ** (كعقد التقرير
     * اليومي أدناه): حذفُ الحساب لا يمسّ صفوفه، لكن لا شاشة تعرضها بعده —
     * فالعمود يُقرأ بأسماء المستخدمين الأحياء. فيختفي نقدٌ استلمه الرجل من
     * المناديب ولم يورّده، بلا أثرٍ يسأل عنه أحد. وبما أنّ الرصيد قد يكون
     * سالباً في حالةٍ عارضة، الشرط قيمةٌ مطلقة لا «أكبر من صفر».
     */
    const custody = await userCustody(prisma, tid, target.id);
    if (Math.abs(custody.outstanding) > CUSTODY_EPS) {
      res.status(400).json({
        success: false,
        message: `في عهدة ${target.name} مبلغ ${clean(custody.outstanding)} استلم عهدته من صفحة مستخدمي الشركة قبل حذفه`,
      });
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
     * ولو انقطع الطلب بين السطرين.
     *
     * وسطرا العقد يسقطان حين لا يملك المستخدم عقدةً أصلاً — لا لتوفير استعلام،
     * بل لأنّ `in: []` مدخلٌ **لا يُراهَن عليه في مسار حذف**: تفسيرُه «لا شيء»
     * هو المتوقَّع، وثمنُ الخطأ فيه محوُ توجيهات الشركة كلّها في جدولٍ لا مفتاح
     * أجنبيّ يحميه. وثمن تجنّبه سطرٌ واحد. */
    const chainCleanup = myNodes.length
      ? [
        prisma.dailyReportOwnerRep.deleteMany({ where: { tenantId: tid, ownerId: { in: myNodes.map(n => n.id) } } }),
        prisma.dailyReportLevelOwner.deleteMany({ where: { tenantId: tid, adminId: target.id } }),
      ]
      : [];
    await prisma.$transaction([
      ...chainCleanup,
      /* ومستلمو التقرير الشامل — الجدول الثاني بلا مفتاح أجنبيّ.
       *
       * تعليقُ عموده في المخطّط يقول «بلا FK كي لا يمحو حذفُه تاريخ الإسناد»،
       * والجدول **لا يحفظ تاريخاً**: مسار `PUT /config/digest-viewers` يمسح
       * صفوف الشركة كلّها ويعيد كتابتها عند كلّ حفظ. فما يبقى ليس سجلّاً بل
       * اسمُ رجلٍ محذوف في قائمة «من يستلم» الحيّة، تعرضها شاشة التهيئة كما
       * هي بينما قائمة المرشّحين لا تعرض إلّا الأحياء. ولا أثر له على الوصول
       * (الفحص بمعرّفٍ لا يستطيع الدخول) — أثره أن يقرأ المالك اسم من رحل. */
      prisma.dailyReportDigestViewer.deleteMany({ where: { tenantId: tid, adminId: target.id } }),
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
async function guardScopeAdmin(req: AuthRequest, res: Response): Promise<{ role: string } | null> {
  const caller = await requireCompanyOwner(req, res);
  if (!caller) return null;
  if (await adminScopeEnabled(req)) {
    res.status(403).json({ success: false, message: 'حسابك مقيد بنطاق محدد تحديد النطاقات يحتاج صلاحية غير مقيدة' });
    return null;
  }
  return caller;
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
    const caller = await guardScopeAdmin(req, res);
    if (!caller) return;
    const tid = tenantId(req);
    const admin = await prisma.admin.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, role: true, scopeEnabled: true } });
    if (!admin) { res.status(404).json({ success: false, message: 'المستخدم غير موجود' }); return; }

    // null (أو غياب المفتاح) = «لا تلمس هذه القائمة» — يسمح بتحديث إحداهما وحدها
    const body = z.object({
      customerIds: z.array(z.string()).max(50000).nullable().optional(),
      salesRepIds: z.array(z.string()).max(5000).nullable().optional(),
      scopeEnabled: z.boolean().optional(),
    }).parse(req.body);
    // تغيير تقييد نطاق مدير الشركة حسابُ مدير (لشركة بعلم المالك): لا يرفعه مشرف أو محاسب ولا مدير مقيّد (ولو بجلسة دخول المالك)
    const scopeChange = body.scopeEnabled !== undefined && body.scopeEnabled !== admin.scopeEnabled;
    if (!(await guardAdminAccountChange(req, res, caller, { targetRole: admin.role, scope: scopeChange }))) return;

    if (body.scopeEnabled !== undefined) {
      await prisma.admin.update({ where: { id: admin.id }, data: { scopeEnabled: body.scopeEnabled } });
    }
    const counts = await setAdminScope(tid, admin.id, body.customerIds ?? null, body.salesRepIds ?? null);
    res.json({ success: true, data: counts });
  } catch (err) { next(err); }
});

export default router;
