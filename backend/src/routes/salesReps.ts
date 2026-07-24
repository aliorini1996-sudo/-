import { Router, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { paginate, paginationMeta } from '../utils/helpers';

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
});

const repSelect = {
  id: true, name: true, phone: true, email: true, username: true, isActive: true,
  canCreateInvoice: true, canSellOnCredit: true, canSellInCash: true,
  canEditInvoice: true, canDeleteInvoice: true, canCancelInvoice: true,
  canChangePrice: true, maxDiscountPct: true, canSellBelowPrice: true,
  canCreateReceipt: true, canEditReceipt: true, canCancelReceipt: true,
  canManageVanStock: true,
  canAddCustomer: true, canEditCustomer: true, canViewStatement: true,
  showCollectionBalance: true,
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
    const rep = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid }, select: repSelect });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    res.json({ success: true, data: rep });
  } catch (err) { next(err); }
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { password, ...rest } = repSchema.parse(req.body);
    if (!password) { res.status(400).json({ success: false, message: 'كلمة المرور مطلوبة' }); return; }
    if (password.length < 6) { res.status(400).json({ success: false, message: 'كلمة المرور 6 أحرف على الأقل' }); return; }

    // فرض الحد الأقصى لعدد المناديب المسموح للشركة (إن وُجد)
    const tenant = await prisma.tenant.findUnique({ where: { id: tid }, select: { maxSalesReps: true } });
    if (tenant?.maxSalesReps != null) {
      const current = await prisma.salesRep.count({ where: { tenantId: tid } });
      if (current >= tenant.maxSalesReps) {
        res.status(403).json({ success: false, message: `بلغت الشركة الحد الأقصى المسموح للمناديب (${tenant.maxSalesReps}). تواصل مع مزوّد الخدمة لرفع الحد.` });
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
  if (await prisma.salesRep.findFirst({ where: { username, ...notSelf } })) return 'اسم المستخدم مستخدم مسبقاً، اختر اسماً آخر';
  if (await prisma.salesRep.findFirst({ where: { tenantId: tid, phone, ...notSelf } })) return 'رقم الجوال مستخدم مسبقاً لمندوب آخر';
  if (email && await prisma.salesRep.findFirst({ where: { tenantId: tid, email, ...notSelf } })) return 'البريد الإلكتروني مستخدم مسبقاً';
  return null;
}

router.put('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const current = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid } });
    if (!current) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }

    const { password, ...rest } = repSchema.partial().parse(req.body);
    if (password && password.length < 6) { res.status(400).json({ success: false, message: 'كلمة المرور 6 أحرف على الأقل' }); return; }
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
    const dateFilter = from && to ? { gte: new Date(from as string), lte: new Date(to as string) } : undefined;

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
    // القيد: الأدمن الرئيسي فقط (لا مدير/محاسب)
    if (req.user?.role !== 'ADMIN') {
      res.status(403).json({ success: false, message: 'حذف المندوب متاح للأدمن الرئيسي فقط.' });
      return;
    }
    const rep = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, name: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }

    // معاملة واحدة: تفريغ مرجع المندوب من الفواتير/السندات (حفظ السجلّ المالي)،
    // ثم حذف بياناته التشغيلية (إشعارات/تحميلات/مواقع/زيارات/تسويات) وأخيراً المندوب.
    await prisma.$transaction([
      prisma.invoice.updateMany({ where: { tenantId: tid, salesRepId: req.params.id }, data: { salesRepId: null } }),
      prisma.receipt.updateMany({ where: { tenantId: tid, salesRepId: req.params.id }, data: { salesRepId: null } }),
      prisma.notification.deleteMany({ where: { salesRepId: req.params.id } }),
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
    const rep = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
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
    const rep = await prisma.salesRep.findFirst({ where: { id: repId, tenantId: tid }, select: { id: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }

    const body = z.object({
      add: z.array(z.string()).max(50000).optional(),
      remove: z.array(z.string()).max(50000).optional(),
    }).parse(req.body);

    const toRemove = [...new Set(body.remove ?? [])];
    const wantAdd = [...new Set(body.add ?? [])].filter(id => !toRemove.includes(id));

    // لا يُسنَد إلا عميل من نفس الشركة (حارس ضد تسريب بين الشركات)
    const valid = wantAdd.length
      ? await prisma.customer.findMany({ where: { tenantId: tid, id: { in: wantAdd } }, select: { id: true } })
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
  return { collected: c, settled: s, outstanding: c - s };
}

// ملخّص رصيد التحصيل لمندوب (للإدارة)
router.get('/:id/collection', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rep = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    res.json({ success: true, data: await repCollection(tid, req.params.id) });
  } catch (err) { next(err); }
});

// استلام تحصيل من المندوب — يُسجّل المبلغ المستلم فينقص الرصيد المتراكم
router.post('/:id/settlements', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rep = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) { res.status(400).json({ success: false, message: 'أدخل مبلغاً صحيحاً أكبر من صفر' }); return; }
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 300) : undefined;
    const by = req.user as { name?: string; id?: string } | undefined;
    await prisma.repSettlement.create({
      data: { tenantId: tid, salesRepId: req.params.id, amount, note, createdBy: by?.name || by?.id },
    });
    res.status(201).json({ success: true, data: await repCollection(tid, req.params.id) });
  } catch (err) { next(err); }
});

// سجلّ استلامات التحصيل لمندوب
router.get('/:id/settlements', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const items = await prisma.repSettlement.findMany({
      where: { tenantId: tid, salesRepId: req.params.id },
      orderBy: { settledAt: 'desc' },
      take: 100,
    });
    res.json({ success: true, data: items });
  } catch (err) { next(err); }
});

export default router;

