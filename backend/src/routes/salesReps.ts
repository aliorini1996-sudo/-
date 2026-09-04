import { Router, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { adminRepFilter, adminCustomerFilter } from '../services/adminScope';
import { AuthRequest } from '../types';
import { paginate, paginationMeta } from '../utils/helpers';
import { clean } from '../services/accounting';

const router = Router();
router.use(authenticate, requireAdmin, requireAdminPermission('canManageSalesReps'));

const emailSchema = z.preprocess(value => value === null ? '' : value, z.string().email().optional().or(z.literal('')));

const repSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(9),
  email: emailSchema,
  username: z.string().min(4),
  password: z.string().optional(), // طول كلمة المرور يُفحص في المعالج لرسالة أوضح
  isActive: z.boolean().optional(),
  canCreateInvoice: z.boolean().optional(),
  canSellOnCredit: z.boolean().optional(),
  canSellOnInstallment: z.boolean().optional(),
  canSellInCash: z.boolean().optional(),
  canEditInvoice: z.boolean().optional(),
  canDeleteInvoice: z.boolean().optional(),
  canCancelInvoice: z.boolean().optional(),
  canChangePrice: z.boolean().optional(),
  maxDiscountPct: z.number().min(0).max(100).optional(),
  canSellBelowPrice: z.boolean().optional(),
  canCreateReceipt: z.boolean().optional(),
  canEditReceipt: z.boolean().optional(),
  canCancelReceipt: z.boolean().optional(),
  canManageVanStock: z.boolean().optional(),
  canAddCustomer: z.boolean().optional(),
  canEditCustomer: z.boolean().optional(),
  canViewStatement: z.boolean().optional(),
  showCollectionBalance: z.boolean().optional(),
  requireCustomerProximity: z.boolean().optional(),
});

const repSelect = {
  id: true, name: true, phone: true, email: true, username: true, isActive: true,
  canCreateInvoice: true, canSellOnCredit: true, canSellOnInstallment: true, canSellInCash: true,
  canEditInvoice: true, canDeleteInvoice: true, canCancelInvoice: true,
  canChangePrice: true, maxDiscountPct: true, canSellBelowPrice: true,
  canCreateReceipt: true, canEditReceipt: true, canCancelReceipt: true,
  canManageVanStock: true,
  canAddCustomer: true, canEditCustomer: true, canViewStatement: true,
  showCollectionBalance: true,
  requireCustomerProximity: true,
  createdAt: true,
} as const;

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string | undefined;

    const where = {
      tenantId: tid,
      // نطاق المستخدم: مستخدم الشركة مقيّد النطاق لا يرى إلا مناديبه المُسنَدين
      ...(await adminRepFilter(req)),
      ...(search && { OR: [{ name: { contains: search } }, { phone: { contains: search } }, { username: { contains: search } }] }),
    };

    const [total, reps] = await Promise.all([
      prisma.salesRep.count({ where }),
      prisma.salesRep.findMany({ where, ...paginate(page, limit), orderBy: { name: 'asc' }, select: repSelect }),
    ]);

    res.json({ success: true, data: reps, pagination: paginationMeta(total, page, limit) });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rep = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid, ...(await adminRepFilter(req)) }, select: repSelect });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    res.json({ success: true, data: rep });
  } catch (err) { next(err); }
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { password, ...rest } = repSchema.parse(req.body);
    if (!password) { res.status(400).json({ success: false, message: 'كلمة المرور مطلوبة' }); return; }
    if (password.length < 8) { res.status(400).json({ success: false, message: 'كلمة المرور 8 أحرف على الأقل' }); return; }

    // فرض الحد الأقصى لعدد المناديب المسموح للشركة (إن وُجد)
    const tenant = await prisma.tenant.findUnique({ where: { id: tid }, select: { maxSalesReps: true } });
    if (tenant?.maxSalesReps != null) {
      const current = await prisma.salesRep.count({ where: { tenantId: tid } });
      if (current >= tenant.maxSalesReps) {
        res.status(403).json({ success: false, message: `بلغت الشركة الحد الأقصى المسموح للمناديب (${tenant.maxSalesReps}) تواصل مع مزود الخدمة لرفع الحد` });
        return;
      }
    }

    const dup = await checkRepDuplicates(tid, rest.username, rest.phone, rest.email);
    if (dup) { res.status(409).json({ success: false, message: dup }); return; }

    const passwordHash = await bcrypt.hash(password, 10);
    const rep = await prisma.salesRep.create({
      data: { ...rest, passwordHash, email: rest.email || null, tenantId: tid } as any,
      select: { id: true, name: true, phone: true, username: true, isActive: true },
    });
    res.status(201).json({ success: true, data: rep });
  } catch (err) { next(err); }
});

// تفرّد اسم المستخدم عالمي (للدخول)، والجوال/البريد ضمن الشركة
async function checkRepDuplicates(tid: string, username: string, phone: string, email?: string, excludeId?: string): Promise<string | null> {
  const notSelf = excludeId ? { id: { not: excludeId } } : {};
  if (await prisma.salesRep.findFirst({ where: { username, ...notSelf } })) return 'اسم المستخدم مستخدم مسبقا اختر اسما آخر';
  if (await prisma.salesRep.findFirst({ where: { tenantId: tid, phone, ...notSelf } })) return 'رقم الجوال مستخدم مسبقا لمندوب آخر';
  if (email && await prisma.salesRep.findFirst({ where: { tenantId: tid, email, ...notSelf } })) return 'البريد الإلكتروني مستخدم مسبقا';
  return null;
}

router.put('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const current = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid, ...(await adminRepFilter(req)) } });
    if (!current) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }

    const { password, ...rest } = repSchema.partial().parse(req.body);
    if (password && password.length < 8) { res.status(400).json({ success: false, message: 'كلمة المرور 8 أحرف على الأقل' }); return; }
    if (rest.username || rest.phone || rest.email) {
      const dup = await checkRepDuplicates(
        tid,
        rest.username ?? current.username,
        rest.phone ?? current.phone,
        rest.email ?? current.email ?? undefined,
        req.params.id
      );
      if (dup) { res.status(409).json({ success: false, message: dup }); return; }
    }
    const updateData: Record<string, unknown> = { ...rest, email: rest.email || null };
    if (password) updateData.passwordHash = await bcrypt.hash(password, 10);
    const rep = await prisma.salesRep.update({
      where: { id: req.params.id },
      data: updateData,
      select: { id: true, name: true, phone: true, username: true, isActive: true },
    });
    res.json({ success: true, data: rep });
  } catch (err) { next(err); }
});

router.get('/:id/stats', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { from, to } = req.query;
    // طرفٌ واحد يكفي؛ و«إلى» تشمل يومها كاملاً (لا حتى منتصف ليله)
    const dateFilter = (from || to) ? {
      ...(from ? { gte: new Date(from as string) } : {}),
      ...(to ? { lte: new Date(new Date(to as string).setHours(23, 59, 59, 999)) } : {}),
    } : undefined;

    const [invoices, receipts] = await Promise.all([
      prisma.invoice.aggregate({
        where: { tenantId: tid, salesRepId: req.params.id, status: 'CONFIRMED', ...(dateFilter && { invoiceDate: dateFilter }) },
        _count: { id: true }, _sum: { total: true },
      }),
      prisma.receipt.aggregate({
        where: { tenantId: tid, salesRepId: req.params.id, status: 'ACTIVE', ...(dateFilter && { receiptDate: dateFilter }) },
        _count: { id: true }, _sum: { amount: true },
      }),
    ]);

    res.json({
      success: true,
      data: {
        invoicesCount: invoices._count.id,
        salesTotal: invoices._sum.total ?? 0,
        receiptsCount: receipts._count.id,
        collectionsTotal: receipts._sum.amount ?? 0,
      },
    });
  } catch (err) { next(err); }
});

// حذف مندوب — للأدمن الرئيسي فقط (role=ADMIN، لا MANAGER/ACCOUNTANT)، مهما ارتبط بأي شيء.
// الفواتير والسندات (سجلّات مالية) تُحفظ ويُفرَّغ مرجع المندوب منها؛ بياناته التشغيلية تُحذف.
router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // القيد: الأدمن الرئيسي فقط (لا مدير/محاسب) — والدور من القاعدة لا من التوكن.
    // هذا المسار يمحو في معاملته كل استلامات تحصيل المندوب، فلا يصحّ أن يكون
    // حارسه أضعف من حارس حذف استلامٍ واحد.
    if (!(await isPrimaryAdmin(req))) {
      res.status(403).json({ success: false, message: 'حذف المندوب متاح للأدمن الرئيسي فقط' });
      return;
    }
    const rep = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid, ...(await adminRepFilter(req)) }, select: { id: true, name: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }

    // معاملة واحدة: تفريغ مرجع المندوب من الفواتير/السندات (حفظ السجلّ المالي)،
    // ثم حذف بياناته التشغيلية (إشعارات/تحميلات/مواقع/زيارات/تسويات) وأخيراً المندوب.
    await prisma.$transaction([
      prisma.invoice.updateMany({ where: { tenantId: tid, salesRepId: req.params.id }, data: { salesRepId: null } }),
      prisma.receipt.updateMany({ where: { tenantId: tid, salesRepId: req.params.id }, data: { salesRepId: null } }),
      prisma.notification.deleteMany({ where: { tenantId: tid, salesRepId: req.params.id } }),
      prisma.vanLoadItem.deleteMany({ where: { vanLoad: { salesRepId: req.params.id } } }),
      prisma.vanLoad.deleteMany({ where: { salesRepId: req.params.id } }),
      prisma.repLocation.deleteMany({ where: { salesRepId: req.params.id } }),
      prisma.repVisit.deleteMany({ where: { salesRepId: req.params.id } }), // صورها تُحذف تعاقبياً
      prisma.repSettlement.deleteMany({ where: { salesRepId: req.params.id } }),
      prisma.customerAssignment.deleteMany({ where: { salesRepId: req.params.id } }), // إسنادات العملاء
      prisma.salesRep.delete({ where: { id: req.params.id } }),
    ]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ===== إسناد العملاء للمندوب (عزل العملاء) =====

// حالة مفتاح «عزل عملاء المناديب» للشركة. مسار من مقطعين فلا يتعارض مع /:id
router.get('/settings/isolation', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const s = await prisma.companySettings.findUnique({
      where: { tenantId: tid }, select: { customerIsolationEnabled: true },
    });
    res.json({ success: true, data: { enabled: s?.customerIsolationEnabled === true } });
  } catch (err) { next(err); }
});

// تشغيل/إيقاف العزل للشركة — عند الإيقاف يعود كل المناديب لرؤية كل العملاء (الإسنادات تبقى محفوظة)
router.patch('/settings/isolation', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    await prisma.companySettings.update({
      where: { tenantId: tid },
      data: { customerIsolationEnabled: enabled },
    });
    res.json({ success: true, data: { enabled } });
  } catch (err) { next(err); }
});

// العملاء المُسنَدون لمندوب — تملأ نافذة «إسناد العملاء» في صفحة المناديب
router.get('/:id/customers', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rep = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid, ...(await adminRepFilter(req)) }, select: { id: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    // نُرفق بيانات العميل كي تعرض النافذة المُسنَدين دون تحميل كل عملاء الشركة
    const rows = await prisma.customerAssignment.findMany({
      where: { tenantId: tid, salesRepId: req.params.id },
      select: {
        customerId: true, source: true,
        customer: { select: { id: true, name: true, businessName: true, phone: true, code: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      success: true,
      data: {
        customerIds: rows.map(r => r.customerId),
        // AUTO = فتحه المندوب بنفسه، MANUAL = أسندته الإدارة (لتمييزها في الواجهة)
        autoIds: rows.filter(r => r.source === 'AUTO').map(r => r.customerId),
        customers: rows.map(r => r.customer).filter(Boolean),
      },
    });
  } catch (err) { next(err); }
});

// تعديل عملاء المندوب بالفروقات فقط — {add, remove}.
// عمداً ليست «استبدالاً كاملاً»: الواجهة لا تحمّل كل العملاء دفعةً واحدة، فإرسال قائمة
// كاملة كان سيحذف صامتاً إسنادَ كل عميل لم يظهر في نافذة الإدارة. الفروقات تجعل ذلك مستحيلاً.
router.put('/:id/customers', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const repId = req.params.id;
    const rep = await prisma.salesRep.findFirst({ where: { id: repId, tenantId: tid, ...(await adminRepFilter(req)) }, select: { id: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }

    const body = z.object({
      add: z.array(z.string()).max(50000).optional(),
      remove: z.array(z.string()).max(50000).optional(),
    }).parse(req.body);

    const toRemove = [...new Set(body.remove ?? [])];
    const wantAdd = [...new Set(body.add ?? [])].filter(id => !toRemove.includes(id));

    // لا يُسنَد إلا عميل من نفس الشركة (حارس ضد تسريب بين الشركات)، **وضمن نطاق
    // المستخدم**: مستخدم مقيّد لا يُسنِد عميلاً لا يراه. بلا هذا القيد يستطيع
    // تمرير معرّفات مباشرةً فيتجاوز عزله من حيث لا تراه الواجهة.
    const valid = wantAdd.length
      ? await prisma.customer.findMany({
          where: { tenantId: tid, id: { in: wantAdd }, ...(await adminCustomerFilter(req)) },
          select: { id: true },
        })
      : [];
    const toAdd = valid.map(c => c.id);

    await prisma.$transaction([
      ...(toRemove.length ? [prisma.customerAssignment.deleteMany({
        where: { tenantId: tid, salesRepId: repId, customerId: { in: toRemove } },
      })] : []),
      ...(toAdd.length ? [prisma.customerAssignment.createMany({
        data: toAdd.map(customerId => ({ tenantId: tid, salesRepId: repId, customerId, source: 'MANUAL' })),
        skipDuplicates: true,
      })] : []),
    ]);

    const total = await prisma.customerAssignment.count({ where: { tenantId: tid, salesRepId: repId } });
    res.json({ success: true, data: { added: toAdd.length, removed: toRemove.length, total } });
  } catch (err) { next(err); }
});

// رصيد التحصيل لدى المندوب = مجموع سنداته النشطة − مجموع ما استلمه الأدمن منه
async function repCollection(tid: string, repId: string) {
  const [collected, settled] = await Promise.all([
    prisma.receipt.aggregate({ where: { tenantId: tid, salesRepId: repId, status: 'ACTIVE' }, _sum: { amount: true } }),
    prisma.repSettlement.aggregate({ where: { tenantId: tid, salesRepId: repId }, _sum: { amount: true } }),
  ]);
  const c = collected._sum.amount ?? 0;
  const s = settled._sum.amount ?? 0;
  return { collected: clean(c), settled: clean(s), outstanding: clean(c - s) };
}

// ملخّص رصيد التحصيل لمندوب (للإدارة)
router.get('/:id/collection', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rep = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid, ...(await adminRepFilter(req)) }, select: { id: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    res.json({ success: true, data: await repCollection(tid, req.params.id) });
  } catch (err) { next(err); }
});

// استلام تحصيل من المندوب — يُسجّل المبلغ المستلم فينقص الرصيد المتراكم
router.post('/:id/settlements', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rep = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid, ...(await adminRepFilter(req)) }, select: { id: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) { res.status(400).json({ success: false, message: 'أدخل مبلغا صحيحا أكبر من صفر' }); return; }
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 300) : undefined;
    const by = req.user as { name?: string; id?: string } | undefined;
    await prisma.repSettlement.create({
      data: { tenantId: tid, salesRepId: req.params.id, amount, note, createdBy: by?.name || by?.id },
    });
    res.status(201).json({ success: true, data: await repCollection(tid, req.params.id) });
  } catch (err) { next(err); }
});

// سجلّ استلامات التحصيل لمندوب
//
// نطاق المستخدم المقيَّد يُفرض هنا كما يُفرض على شقيقيه (collection/settle):
// جدول التسويات لا يحمل علاقة عميل تُقيَّد بها، فالقيد يكون على المندوب نفسه.
// وبدونه كان مستخدمٌ مقيَّد يُعدّد استلامات مندوبٍ خارج نطاقه بتمرير معرّفه.
router.get('/:id/settlements', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rep = await prisma.salesRep.findFirst({
      where: { id: req.params.id, tenantId: tid, ...(await adminRepFilter(req)) },
      select: { id: true },
    });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    const items = await prisma.repSettlement.findMany({
      where: { tenantId: tid, salesRepId: rep.id },
      orderBy: { settledAt: 'desc' },
      take: 100,
    });
    res.json({ success: true, data: items });
  } catch (err) { next(err); }
});

/**
 * الأدمن الرئيسي للشركة — الدور من القاعدة لا من التوكن.
 *
 * التوكن يحمل الدور لحظة إصداره، فمن خُفّض من ADMIN إلى MANAGER يبقى توكنه
 * القديم يقول ADMIN حتى ينتهي أجله. لا يصحّ أن يُفتح بتوكنٍ فائتٍ بابُ عمليةٍ
 * ماليّة لا رجعة فيها، فنقرأ الدور الحيّ. (والشركة تُطابَق أيضاً كي لا يُسقِط
 * توكنُ شركةٍ حارساً على أخرى.)
 */
async function isPrimaryAdmin(req: AuthRequest): Promise<boolean> {
  const id = req.user?.id;
  if (!id) return false;
  const admin = await prisma.admin.findUnique({ where: { id }, select: { role: true, tenantId: true, isActive: true } });
  return !!admin && admin.isActive && admin.role === 'ADMIN' && admin.tenantId === tenantId(req);
}

/**
 * حذف استلام تحصيل من سجلّ المندوب — للأدمن الرئيسي وحده.
 *
 * لماذا يُسمح بالحذف أصلاً: تسجيل الاستلام خطوة يدويّة، مبلغٌ يُكتب بلوحة
 * مفاتيح. وخطؤها يقلب رصيد المندوب فيظهر مسدِّداً وهو لم يسدّد، أو تُسجَّل
 * الدفعة مرّتين. فالتصحيح حاجةٌ تشغيليّة لا ترف.
 *
 * ولماذا للأدمن الرئيسي وحده: الحذف **يرفع** الرصيد المتبقّي على المندوب — أي
 * يعيد مطالبته بمالٍ سلّمه فعلاً. قرارٌ ماليّ لا يُترك لمشرفٍ ولا لمحاسب،
 * مطابقةً لحذف المندوب وحذف مستخدم الشركة.
 *
 * ولا يمضي الحذف صامتاً: يُقيَّد في الإشعارات بمبلغه ومن حذفه، ومعه نسخةٌ
 * كاملة من الصفّ في `data` — فمن حذف خطأً يعيد تسجيله كما كان بلا تخمين.
 */
router.delete('/:id/settlements/:settlementId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    if (!(await isPrimaryAdmin(req))) {
      res.status(403).json({ success: false, message: 'حذف استلام التحصيل متاح للأدمن الرئيسي فقط' });
      return;
    }
    const rep = await prisma.salesRep.findFirst({
      where: { id: req.params.id, tenantId: tid, ...(await adminRepFilter(req)) },
      select: { id: true, name: true },
    });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }

    // الشروط الثلاثة معاً: لا يُحذف صفّ شركةٍ أخرى ولا صفّ مندوبٍ آخر بمعرّفٍ منقول
    const row = await prisma.repSettlement.findFirst({
      where: { id: req.params.settlementId, tenantId: tid, salesRepId: rep.id },
    });
    if (!row) { res.status(404).json({ success: false, message: 'سجل الاستلام غير موجود' }); return; }

    const by = req.user;
    // من نفّذ الحذف — وجلسة تصفّح المالك تُوسَم كي لا يُنسب فعله لأدمن الشركة
    const actor = `${by?.name || 'الادمن'}${by?.impersonated ? ' (الدعم الفني)' : ''}`;
    const when = new Date(row.settledAt).toISOString().slice(0, 10);

    await prisma.$transaction(async tx => {
      await tx.repSettlement.delete({ where: { id: row.id } });
      await tx.notification.create({
        data: {
          tenantId: tid,
          type: 'REP_SETTLEMENT_DELETED',
          title: 'حذف استلام تحصيل',
          // النصّ يحمل كل ما يلزم لإعادة التسجيل يدوياً: المبلغ وتاريخه ومن
          // استلمه ومن حذفه. حقل data نسخةٌ للآلة، وهذا السطر نسخةٌ للإنسان —
          // ولا شاشة في المنتج تعرض data، فلو اكتُفي به لضاع الأثر عملياً.
          body: `حذف ${actor} استلام تحصيل بمبلغ ${clean(row.amount)} كان مسجلا بتاريخ ${when}`
            + ` باسم ${row.createdBy || 'غير معروف'} من المندوب ${rep.name}`
            + ` — عاد المبلغ رصيدا مطلوبا من المندوب`,
          salesRepId: rep.id,
          data: JSON.stringify({
            settlementId: row.id, amount: row.amount, note: row.note,
            createdBy: row.createdBy, settledAt: row.settledAt,
            deletedBy: actor, deletedById: by?.id,
          }),
        },
      });
    });

    // الرصيد بعد الحذف — لتُحدّث الواجهة بطاقاتها من مصدرٍ واحد لا من حسابٍ محلّي
    res.json({ success: true, data: await repCollection(tid, rep.id) });
  } catch (err) { next(err); }
});

export default router;

