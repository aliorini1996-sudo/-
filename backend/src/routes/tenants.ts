import { Router, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { mailLayout, sendMail } from '../services/mailer';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { AuthRequest } from '../types';
import { cardStatuses, platformMetrics, sendWeeklyReport } from '../services/opsSchedule';
import { isLedgerPilotTenant } from '../services/gl/pilot';
import { appendAudit } from '../services/gl/audit';
import type { GlActor } from '../services/gl/audit';
import { acquirePostLock } from '../services/gl/post';
import { DEFAULT_TIMEZONE, fromDbDate, isLocalDate, localDate, toDbDate, todayLocal, zonedStartOfDay } from '../services/gl/dates';
import { GL_RESET_KEEP, GL_RESET_ORDER, deleteLedgerRows, ledgerResetBlockReasons, resetConfirmNameMatches, resetDelegateName, type ResetTx } from '../services/gl/reset';
import { RetentionChangedError, isLedgerDestroyConfirmed, retentionActiveMessage, tenantDeleteRetentionGuard } from '../services/gl/retention';
import { PAYLINK_FEE_INVOICE_DATE_MESSAGES, validatePaylinkFeeInvoiceFrom } from '../services/gl/paylinkFee';
import {
  LEDGER_STUCK_EVENT_STATUSES, ledgerResetSummary, ledgerStatusOf, ledgerStuckCutoff, paylinkFeeInvoiceFromSummary,
  stuckCountsByTenant, summarizePendingFees,
} from '../services/gl/ownerLedger';
import { adminPermissionFields } from './auth';

// إدارة الشركات المشتركة — لمالك المنصّة (السوبر أدمن) فقط
const router = Router();
router.use(authenticate, requireSuperAdmin);

const createTenantSchema = z.object({
  companyName: z.string().min(1),       // اسم الشركة
  maxSalesReps: z.number().int().min(1).nullable().optional(), // null/غياب = عدد مناديب غير محدود
  maxAdminUsers: z.number().int().min(1).nullable().optional(), // null/غياب = عدد مستخدمين غير محدود
  erpEnabled: z.boolean().optional(),          // صلاحية ربط ERP (يمنحها المالك حسب الاشتراك)
  petroappEnabled: z.boolean().optional(),     // صلاحية ربط بترو آب (يمنحها المالك حسب الاشتراك)
  hatifEnabled: z.boolean().optional(),        // ميزة ارقام العمل وربط هاتف (يمنحها المالك حسب الاشتراك)
  catalogEnabled: z.boolean().optional(),
  paylinkEnabled: z.boolean().optional(), // ميزة الدفع الإلكتروني — روابط دفع ميسر (يمنحها المالك حسب الاشتراك)
  subscriptionEndsAt: z.string().optional(), // ISO date — فارغ = غير محدود
  notes: z.string().optional(),
  // بيانات أدمن الشركة الأول
  adminName: z.string().min(1),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8, 'كلمة المرور 8 أحرف على الأقل'),
});

const updateTenantSchema = z.object({
  name: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
  maxSalesReps: z.number().int().min(1).nullable().optional(),
  maxAdminUsers: z.number().int().min(1).nullable().optional(),
  erpEnabled: z.boolean().optional(),
  petroappEnabled: z.boolean().optional(),
  hatifEnabled: z.boolean().optional(),
  catalogEnabled: z.boolean().optional(),
  paylinkEnabled: z.boolean().optional(),
  warehouseEnabled: z.boolean().optional(),
  receivablesSummaryEnabled: z.boolean().optional(),
  accountingEnabled: z.boolean().optional(),
  dailyReportEnabled: z.boolean().optional(),
  invoiceSignatureEnabled: z.boolean().optional(),
  // النظام المحاسبي المتكامل — في التحديث وحده، ومحروسٌ بقائمة التجربة في PUT /:id (§8.1)
  accountingSuiteEnabled: z.boolean().optional(),
  subscriptionEndsAt: z.string().nullish(),
  notes: z.string().nullish(),
});

// ————— نظام تشغيل المالك (خطة فجوة التنفيذ) —————
// بطاقات القرار بحالتها (العمر، التأخر عن SLA، المهل التقويمية)
router.get('/ops/cards', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: cardStatuses() }); } catch (err) { next(err); }
});

// عدّاد الاشتراكات وMRR التقديري من جدول Tenant (يشمل التجارب — لا يعكس تحصيلاً فعلياً)
router.get('/ops/metrics', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await platformMetrics() }); } catch (err) { next(err); }
});

// إرسال التقرير الأسبوعي يدوياً (الجدولة الآلية: كل اثنين 8ص بتوقيت الرياض)
router.post('/ops/weekly-report', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try { const sent = await sendWeeklyReport(); res.json({ success: true, data: { sent } }); } catch (err) { next(err); }
});

// قائمة الشركات مع ملخص لكل واحدة
router.get('/', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenants = await prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { admins: true, salesReps: true, customers: true, invoices: true } },
        admins: { select: { name: true, email: true }, take: 1, orderBy: { createdAt: 'asc' } },
        // M2 (§8.1): حالة الدفاتر لشارة بطاقة الشركة
        glSettings: { select: { activatedAt: true, backfillState: true } },
      },
    });
    // M3 (§8.1): استعلام واحد للأحداث المتعثرة أقدم من 24 ساعة لكل الشركات (الحالات التي يحمرّ لها C8)
    const stuckRows = await prisma.glSourceEvent.groupBy({
      by: ['tenantId'],
      where: { status: { in: [...LEDGER_STUCK_EVENT_STATUSES] }, detectedAt: { lt: ledgerStuckCutoff(new Date()) } },
      _count: { _all: true },
    });
    const stuck = stuckCountsByTenant(stuckRows);
    // ledgerPilotAllowed: هل تقبل الشركة تفعيل النظام المحاسبي المتكامل الآن (قائمة التجربة، بلا استعلام إضافي)
    res.json({
      success: true,
      data: tenants.map(t => ({
        ...t,
        ledgerPilotAllowed: isLedgerPilotTenant(t.id, process.env),
        ledgerStatus: ledgerStatusOf({
          accountingSuiteEnabled: t.accountingSuiteEnabled,
          accountingEnabled: t.accountingEnabled,
          activatedAt: t.glSettings?.activatedAt ?? null,
          stuckEvents: stuck.get(t.id) ?? 0,
        }),
        ledgerActivatedAt: t.glSettings?.activatedAt ?? null,
      })),
    });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      include: {
        admins: { select: { id: true, name: true, email: true, isActive: true } },
        _count: { select: { salesReps: true, customers: true, products: true, invoices: true, receipts: true } },
      },
    });
    if (!tenant) { res.status(404).json({ success: false, message: 'الشركة غير موجودة' }); return; }
    res.json({ success: true, data: tenant });
  } catch (err) { next(err); }
});

// إنشاء شركة جديدة + أدمنها الأول + إعدادات شركتها
router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = createTenantSchema.parse(req.body);

    const emailTaken = await prisma.admin.findUnique({ where: { email: body.adminEmail } });
    if (emailTaken) { res.status(409).json({ success: false, message: 'البريد الإلكتروني مستخدم مسبقا' }); return; }

    const passwordHash = await bcrypt.hash(body.adminPassword, 10);

    const tenant = await prisma.$transaction(async tx => {
      const t = await tx.tenant.create({
        data: {
          name: body.companyName,
          maxSalesReps: body.maxSalesReps ?? null,
          maxAdminUsers: body.maxAdminUsers ?? null,
          erpEnabled: body.erpEnabled ?? false,
          petroappEnabled: body.petroappEnabled ?? false,
          hatifEnabled: body.hatifEnabled ?? false,
          catalogEnabled: body.catalogEnabled ?? false,
          paylinkEnabled: body.paylinkEnabled ?? false,
          subscriptionEndsAt: body.subscriptionEndsAt ? new Date(body.subscriptionEndsAt) : null,
          notes: body.notes,
        } as any,
      });
      await tx.admin.create({
        data: { tenantId: t.id, name: body.adminName, email: body.adminEmail, passwordHash, role: 'ADMIN' },
      });
      // إعدادات الشركة الافتراضية (تظهر في المطبوعات)
      await tx.companySettings.create({
        data: { tenantId: t.id, name: body.companyName },
      });
      return t;
    });

    res.status(201).json({ success: true, data: { ...tenant, adminEmail: body.adminEmail } });
  } catch (err) { next(err); }
});

// تعديل اشتراك الشركة (تفعيل/تعطيل، تاريخ انتهاء، خطة)
router.put('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = updateTenantSchema.parse(req.body);
    // حارس قائمة التجربة (§8.1): التغيير من غير true إلى true لشركة خارج
    // LEDGER_PILOT_TENANTS مرفوض قبل الكتابة. الإطفاء وحفظ بقية الحقول مع true
    // قائمة لا يُفحصان، فتبقى الشركة التي أُزيلت من القائمة قابلةً للإطفاء.
    if (body.accountingSuiteEnabled === true) {
      const prev = await prisma.tenant.findUnique({ where: { id: req.params.id }, select: { accountingSuiteEnabled: true } });
      if (prev && prev.accountingSuiteEnabled !== true && !isLedgerPilotTenant(req.params.id, process.env)) {
        res.status(403).json({ success: false, code: 'LEDGER_PILOT_ONLY', message: 'النظام المحاسبي المتكامل في مرحلة تجربة ولا يفعل إلا للشركات المدرجة في قائمة التجربة' });
        return;
      }
    }
    const data: Record<string, unknown> = { ...body };
    if ('subscriptionEndsAt' in body) {
      data.subscriptionEndsAt = body.subscriptionEndsAt ? new Date(body.subscriptionEndsAt) : null;
    }
    // M2 (§5.6 الخطوة 1، §9.3): تبديل العَلَم يُدوَّن FLAG_TOGGLE في معاملة التحديث نفسها، حين تتغير
    // القيمة فعلاً وحدها، دون اشتراط صف GlSettings ولا أي زرع في مسار المالك.
    const tenant = await prisma.$transaction(async tx => {
      const before = body.accountingSuiteEnabled === undefined
        ? null
        : await tx.tenant.findUnique({ where: { id: req.params.id }, select: { accountingSuiteEnabled: true } });
      const updated = await tx.tenant.update({ where: { id: req.params.id }, data });
      if (before && before.accountingSuiteEnabled !== updated.accountingSuiteEnabled) {
        await appendAudit(tx, {
          tenantId: updated.id,
          actor: { actorType: 'OWNER', actorId: req.user!.id, actorName: req.user!.name ?? null, impersonated: false, requestIp: req.ip ?? null },
          action: 'FLAG_TOGGLE',
          entityType: 'TENANT',
          entityId: updated.id,
          summary: updated.accountingSuiteEnabled ? 'تفعيل النظام المحاسبي المتكامل' : 'إطفاء النظام المحاسبي المتكامل',
          before: { accountingSuiteEnabled: before.accountingSuiteEnabled },
          after: { accountingSuiteEnabled: updated.accountingSuiteEnabled },
        });
      }
      return updated;
    });
    res.json({ success: true, data: tenant });
  } catch (err) { next(err); }
});

// دخول المالك إلى لوحة الشركة (انتحال) — يُصدر توكن بصلاحيات أدمن الشركة
router.post('/:id/impersonate', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) { res.status(404).json({ success: false, message: 'الشركة غير موجودة' }); return; }
    // نشطاً أوّلاً: `requireAdmin` صار يتحقّق من الحساب نفسه، فانتحالُ أقدمِ
    // مديرٍ ولو كان معطَّلاً يُصدر توكناً يُرفض على كل مسار إداري.
    const admin = await prisma.admin.findFirst({ where: { tenantId: tenant.id, isActive: true }, orderBy: { createdAt: 'asc' } })
      ?? await prisma.admin.findFirst({ where: { tenantId: tenant.id }, orderBy: { createdAt: 'asc' } });
    if (!admin) { res.status(404).json({ success: false, message: 'لا يوجد مدير لهذه الشركة' }); return; }
    if (!admin.isActive) { res.status(409).json({ success: false, message: 'كل مديري هذه الشركة معطلون فعل حسابا قبل الدخول' }); return; }

    const token = jwt.sign(
      { id: admin.id, role: admin.role, name: admin.name, tenantId: tenant.id, impersonated: true },
      process.env.JWT_SECRET!,
      { expiresIn: '2h' }
    );
    res.json({
      success: true,
      // صلاحيات صاحب الحساب ونطاقه — وإلا أخفى الويب الدفاتر التي يسمح بها الخادم (§9.1)
      data: { token, user: { id: admin.id, name: admin.name, email: admin.email, role: admin.role, tenantId: tenant.id, companyName: tenant.name, ...adminPermissionFields(admin) } },
    });
  } catch (err) { next(err); }
});

// حذف شركة نهائياً مع كل بياناتها (بترتيب آمن لقيود المفاتيح الأجنبية)
router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = req.params.id;
    const tenant = await prisma.tenant.findUnique({ where: { id: tid } });
    if (!tenant) { res.status(404).json({ success: false, message: 'الشركة غير موجودة' }); return; }

    // ضمانة الحفظ G6 (§3.9، §9.5 (د) و(ط)): قبل أول عبارة حذف وقبل قراءة confirmLedgerDestroy.
    // بلا صف GlSettings لا قيد مرحَّل ممكن ⇒ الحذف كما اليوم دون أي عدّ.
    const glSettings = await prisma.glSettings.findUnique({
      where: { tenantId: tid },
      select: { fiscalYearEndMonth: true, fiscalYearEndDay: true, timezone: true },
    });
    let postedMoves = 0;
    let lastPostedDate: Date | null = null;
    if (glSettings) {
      const agg = await prisma.glMove.aggregate({ where: { tenantId: tid, state: 'POSTED' }, _count: { _all: true }, _max: { date: true } });
      postedMoves = agg._count._all;
      lastPostedDate = agg._max.date ?? null;
    }
    const retention = tenantDeleteRetentionGuard({
      postedMoves,
      lastPostedDate,
      fiscalYearEndMonth: glSettings?.fiscalYearEndMonth ?? 12,
      fiscalYearEndDay: glSettings?.fiscalYearEndDay ?? 31,
      timezone: glSettings?.timezone ?? DEFAULT_TIMEZONE,
      now: new Date(),
    });
    if (retention.action === 'RETENTION_ACTIVE') {
      // لا معامل يتجاوزه — البديل إيقاف الشركة (isActive=false)
      res.status(409).json({
        success: false, code: 'LEDGER_RETENTION_ACTIVE', message: retentionActiveMessage(retention.retentionUntil),
        retentionUntil: retention.retentionUntil, postedMoves: retention.postedMoves,
      });
      return;
    }
    const destroyLedger = retention.action === 'EXPIRED';
    if (destroyLedger && !isLedgerDestroyConfirmed(req.query.confirmLedgerDestroy)) {
      res.status(409).json({
        success: false, code: 'LEDGER_HAS_POSTED_MOVES',
        message: 'للشركة دفاتر بقيود مرحّلة انقضت مدة حفظها — أكّد حذف الدفاتر نهائياً',
        retentionUntil: retention.retentionUntil, postedMoves: retention.postedMoves,
      });
      return;
    }

    // معاملة تفاعلية أولها قفل gl-post: المُرحِّل يرحّل تحت القفل نفسه، فيُعاد حارس الحفظ داخلها قبل أي حذف
    // (قيد رُحّل بعد القراءة أعلاه يغيّر القرار ⇒ لا يُحذف شيء، §9.5 G6 (د))
    let finalCounts = { postedMoves, retentionUntil: retention.retentionUntil as string | null };
    try {
      await prisma.$transaction(async (tx) => {
        await acquirePostLock(tx, tid);
        const gsNow = await tx.glSettings.findUnique({
          where: { tenantId: tid },
          select: { fiscalYearEndMonth: true, fiscalYearEndDay: true, timezone: true },
        });
        const aggNow = gsNow ? await tx.glMove.aggregate({ where: { tenantId: tid, state: 'POSTED' }, _count: { _all: true }, _max: { date: true } }) : null;
        const again = tenantDeleteRetentionGuard({
          postedMoves: aggNow?._count._all ?? 0,
          lastPostedDate: aggNow?._max.date ?? null,
          fiscalYearEndMonth: gsNow?.fiscalYearEndMonth ?? 12,
          fiscalYearEndDay: gsNow?.fiscalYearEndDay ?? 31,
          timezone: gsNow?.timezone ?? DEFAULT_TIMEZONE,
          now: new Date(),
        });
        if (again.action !== retention.action || (gsNow === null) !== (glSettings === null)) throw new RetentionChangedError(again);
        finalCounts = { postedMoves: again.postedMoves, retentionUntil: again.retentionUntil };
        // بعد انقضاء مدة الحفظ وبالتأكيد الثاني وحده: جداول gl صراحةً بالترتيب (الأبناء قبل الآباء) ومعها سجل التدقيق
        const ledgerDelegates = [
          ...(destroyLedger ? [...GL_RESET_ORDER, ...GL_RESET_KEEP].map(m => (tx as unknown as Record<string, { deleteMany(a: { where: { tenantId: string } }): Promise<{ count: number }> }>)[resetDelegateName(m)]) : []),
        ];
        for (const d of ledgerDelegates) await d.deleteMany({ where: { tenantId: tid } });
        await tx.receiptInvoice.deleteMany({ where: { receipt: { tenantId: tid } } });
        await tx.invoiceItem.deleteMany({ where: { invoice: { tenantId: tid } } });
        await tx.accountEntry.deleteMany({ where: { tenantId: tid } });
        await tx.receipt.deleteMany({ where: { tenantId: tid } });
        await tx.invoice.deleteMany({ where: { tenantId: tid } });
        await tx.customerPrice.deleteMany({ where: { customer: { tenantId: tid } } });
        await tx.priceTier.deleteMany({ where: { product: { tenantId: tid } } });
        await tx.notification.deleteMany({ where: { tenantId: tid } });
        await tx.customer.deleteMany({ where: { tenantId: tid } });
        await tx.product.deleteMany({ where: { tenantId: tid } });
        await tx.productCategory.deleteMany({ where: { tenantId: tid } });
        await tx.companySettings.deleteMany({ where: { tenantId: tid } });
        await tx.salesRep.deleteMany({ where: { tenantId: tid } });
        await tx.admin.deleteMany({ where: { tenantId: tid } });
        await tx.tenant.delete({ where: { id: tid } });
      }, { timeout: 120_000, maxWait: 30_000 });
    } catch (e) {
      if (!(e instanceof RetentionChangedError)) throw e;
      const d = e.decision;
      if (d.action === 'RETENTION_ACTIVE') {
        res.status(409).json({
          success: false, code: 'LEDGER_RETENTION_ACTIVE', message: retentionActiveMessage(d.retentionUntil),
          retentionUntil: d.retentionUntil, postedMoves: d.postedMoves,
        });
        return;
      }
      if (d.action === 'EXPIRED' && !isLedgerDestroyConfirmed(req.query.confirmLedgerDestroy)) {
        res.status(409).json({
          success: false, code: 'LEDGER_HAS_POSTED_MOVES',
          message: 'للشركة دفاتر بقيود مرحّلة انقضت مدة حفظها — أكّد حذف الدفاتر نهائياً',
          retentionUntil: d.retentionUntil, postedMoves: d.postedMoves,
        });
        return;
      }
      // تغيّر القرار إلى ما يسمح (أو صف الإعدادات ظهر/اختفى): لا حذف في هذا الطلب — يُعاد المحاولة
      res.status(409).json({ success: false, code: 'LEDGER_RETENTION_CHANGED', message: 'تغيّرت حالة دفاتر الشركة أثناء الحذف — أعد المحاولة' });
      return;
    }
    // §9.3: الحذف لا يترك أثراً داخل جداول الشركة — سطر سجل منظّم خارجها
    console.warn(JSON.stringify({ event: 'TENANT_DELETED', tenantId: tid, name: tenant.name, actorId: req.user?.id ?? null, hadLedger: glSettings !== null }));
    if (glSettings !== null) {
      // بريد للمالك إن كان مهيأً (يتخطى بهدوء غير ذلك) — لا يُدّعى أن السجل محفوظ بعد الحذف
      void sendMail({
        subject: `حذف شركة لها دفاتر: ${tenant.name}`,
        html: mailLayout('حذف شركة لها دفاتر', [
          ['الشركة', tenant.name], ['المعرّف', tid], ['المنفّذ', req.user?.name ?? req.user?.id ?? '—'],
          ['قيود مرحّلة', String(finalCounts.postedMoves)], ['نهاية مدة الحفظ', finalCounts.retentionUntil ?? '—'],
        ]),
      }).catch(() => undefined);
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// أداء شركة معيّنة — إحصائيات شاملة للسوبر أدمن
router.get('/:id/performance', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = req.params.id;
    const tenant = await prisma.tenant.findUnique({ where: { id: tid } });
    if (!tenant) { res.status(404).json({ success: false, message: 'الشركة غير موجودة' }); return; }

    const [customers, products, salesReps, sales, returns, receipts, topReps] = await Promise.all([
      prisma.customer.count({ where: { tenantId: tid } }),
      prisma.product.count({ where: { tenantId: tid } }),
      prisma.salesRep.count({ where: { tenantId: tid } }),
      prisma.invoice.aggregate({ where: { tenantId: tid, status: 'CONFIRMED', type: { not: 'RETURN' } }, _count: { id: true }, _sum: { total: true } }),
      prisma.invoice.aggregate({ where: { tenantId: tid, status: 'CONFIRMED', type: 'RETURN' }, _count: { id: true }, _sum: { total: true } }),
      prisma.receipt.aggregate({ where: { tenantId: tid, status: 'ACTIVE' }, _count: { id: true }, _sum: { amount: true } }),
      prisma.salesRep.findMany({
        where: { tenantId: tid },
        take: 5,
        select: { id: true, name: true, invoices: { where: { status: 'CONFIRMED', type: { not: 'RETURN' } }, select: { total: true } } },
      }),
    ]);

    const reps = topReps.map(r => ({
      id: r.id, name: r.name,
      invoicesCount: r.invoices.length,
      salesTotal: r.invoices.reduce((s, i) => s + Number(i.total), 0),
    })).sort((a, b) => b.salesTotal - a.salesTotal);

    res.json({
      success: true,
      data: {
        company: { name: tenant.name, plan: tenant.plan, isActive: tenant.isActive, subscriptionEndsAt: tenant.subscriptionEndsAt, createdAt: tenant.createdAt },
        counts: { customers, products, salesReps },
        invoicesCount: sales._count.id,
        salesTotal: Number(sales._sum.total ?? 0),
        returnsCount: returns._count.id,
        returnsTotal: Number(returns._sum.total ?? 0),
        receiptsCount: receipts._count.id,
        collectionsTotal: Number(receipts._sum.amount ?? 0),
        topReps: reps,
      },
    });
  } catch (err) { next(err); }
});

// إعادة تعيين كلمة مرور أدمن الشركة
router.post('/:id/reset-admin', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({ adminId: z.string().optional(), newPassword: z.string().min(8, 'كلمة المرور 8 أحرف على الأقل') });
    const { adminId, newPassword } = schema.parse(req.body);
    // إن لم يُحدَّد adminId نعيد تعيين كلمة مرور المدير الرئيسي (الأقدم) للشركة
    const admin = adminId
      ? await prisma.admin.findFirst({ where: { id: adminId, tenantId: req.params.id } })
      : await prisma.admin.findFirst({ where: { tenantId: req.params.id }, orderBy: { createdAt: 'asc' } });
    if (!admin) { res.status(404).json({ success: false, message: 'المدير غير موجود' }); return; }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.admin.update({ where: { id: admin.id }, data: { passwordHash } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ————— النظام المحاسبي المتكامل: إجراءات المالك (M3، §5.7، §8.1، §10.3 D2) —————

function ownerActor(req: AuthRequest): GlActor {
  return { actorType: 'OWNER', actorId: req.user!.id, actorName: req.user!.name ?? null, impersonated: false, requestIp: req.ip ?? null };
}

/** رمية داخل المعاملة لرد منظّم بعد تراجعها */
class OwnerLedgerReply extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) { super(String(body.code ?? 'OWNER_LEDGER_REPLY')); }
}

// إعادة ضبط الدفاتر (§5.7): قبل أول ترحيل وحده؛ القفل أول عبارة، ثم الشروط، ثم الحذف بـGL_RESET_ORDER، ثم LEDGER_RESET.
router.post('/:id/ledger-reset', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = req.params.id;
    const tenant = await prisma.tenant.findUnique({ where: { id: tid }, select: { id: true, name: true } });
    if (!tenant) { res.status(404).json({ success: false, message: 'الشركة غير موجودة' }); return; }
    // الخادم يتحقق من confirmName حرفياً ولا يكتفي بالواجهة
    if (!resetConfirmNameMatches(req.body?.confirmName, tenant.name)) {
      res.status(422).json({ success: false, code: 'LEDGER_RESET_CONFIRM_MISMATCH', message: 'اسم التأكيد لا يطابق اسم الشركة حرفياً' });
      return;
    }
    const actor = ownerActor(req);
    const result = await prisma.$transaction(async tx => {
      await acquirePostLock(tx, tid);
      const [postedMoves, securedMoves, settings, customerAdjustmentSources] = [
        await tx.glMove.count({ where: { tenantId: tid, state: 'POSTED' } }),
        await tx.glMove.count({ where: { tenantId: tid, secureHash: { not: null } } }),
        await tx.glSettings.findUnique({ where: { tenantId: tid }, select: { hardLockDate: true, activatedAt: true } }),
        await tx.glMoveSource.count({ where: { tenantId: tid, sourceType: 'CUSTOMER_ADJUSTMENT' } }),
      ];
      const reasons = ledgerResetBlockReasons({
        postedMoves,
        filedReturns: 0, // نموذج الإقرارات يصل في M5
        securedMoves,
        hardLockDate: settings?.hardLockDate ?? null,
        customerAdjustmentSources,
      });
      if (reasons.length > 0) {
        throw new OwnerLedgerReply(409, {
          success: false, code: 'LEDGER_RESET_BLOCKED', reasons,
          message: 'إعادة ضبط الدفاتر مرفوضة — الدفاتر سجلات نظامية بعد أول ترحيل، والتصحيح بقيود',
        });
      }
      const deleted = await deleteLedgerRows(tx as unknown as ResetTx, tid);
      const summary = ledgerResetSummary(deleted);
      await appendAudit(tx, {
        tenantId: tid, actor, action: 'LEDGER_RESET', entityType: 'TENANT', entityId: tid,
        summary: summary.text,
        before: { activatedAt: settings?.activatedAt ?? null },
        after: { deleted, total: summary.total },
      });
      await tx.notification.create({
        data: {
          tenantId: tid, type: 'LEDGER_RESET', title: 'إعادة ضبط الدفاتر', body: summary.text,
          data: JSON.stringify({ deleted, actorId: actor.actorId, at: new Date().toISOString() }),
        },
      });
      return { deleted, total: summary.total };
    }, { maxWait: 10_000, timeout: 120_000 });
    res.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof OwnerLedgerReply) { res.status(err.status).json(err.body); return; }
    next(err);
  }
});

// D2 (§8.1): تاريخ بداية الفواتير الضريبية لعمولة الدفع الإلكتروني — مالك المنصة وحده (router.use أعلاه).
// ?preview=1 يتحقق ويحسب pendingFeesAffected دون كتابة (يعرضه الحوار قبل التأكيد النهائي).
const paylinkFeeInvoiceFromSchema = z.object({
  from: z.string().refine(isLocalDate, 'تاريخ غير صالح YYYY-MM-DD').nullable(),
});

router.put('/:id/ledger-paylink-fee-invoice-from', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = req.params.id;
    const parsed = paylinkFeeInvoiceFromSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(422).json({ success: false, code: 'LEDGER_PAYLINK_FEE_INVOICE_DATE_INVALID', reason: 'FORMAT', message: PAYLINK_FEE_INVOICE_DATE_MESSAGES.FORMAT });
      return;
    }
    const preview = req.query.preview === '1';
    const actor = ownerActor(req);
    const result = await prisma.$transaction(async tx => {
      await acquirePostLock(tx, tid);
      const s = await tx.glSettings.findUnique({
        where: { tenantId: tid },
        select: { id: true, activatedAt: true, timezone: true, currencyDecimals: true, paylinkFeeTaxInvoiceFrom: true, taxLockDate: true, hardLockDate: true },
      });
      if (!s || !s.activatedAt) {
        throw new OwnerLedgerReply(409, { success: false, code: 'LEDGER_NOT_SETUP', message: 'الدفاتر لم تُعدّ لهذه الشركة بعد' });
      }
      const tz = s.timezone || DEFAULT_TIMEZONE;
      const lastFee = await tx.glSourceEvent.aggregate({
        where: { tenantId: tid, sourceType: 'PAYLINK_FEE', status: 'DONE' },
        _max: { effectAt: true },
      });
      const lastPostedFeeDate = lastFee._max.effectAt ? localDate(lastFee._max.effectAt, tz) : null;
      const decision = validatePaylinkFeeInvoiceFrom({
        from: parsed.data.from,
        current: s.paylinkFeeTaxInvoiceFrom,
        lastPostedFeeDate,
        taxLockDate: s.taxLockDate,
        hardLockDate: s.hardLockDate,
        today: todayLocal(new Date(), tz),
      });
      if (!decision.ok) {
        if (decision.code === 'LEDGER_PAYLINK_FEE_INVOICE_DATE_LOCKED') {
          throw new OwnerLedgerReply(409, {
            success: false, code: decision.code, message: PAYLINK_FEE_INVOICE_DATE_MESSAGES.LOCKED,
            current: decision.current, lastPostedFeeDate: decision.lastPostedFeeDate,
          });
        }
        throw new OwnerLedgerReply(422, {
          success: false, code: decision.code, reason: decision.reason, message: PAYLINK_FEE_INVOICE_DATE_MESSAGES[decision.reason],
          minDate: decision.minDate, maxDate: decision.maxDate, lastPostedFeeDate,
        });
      }

      // العمولات غير المرحّلة بتاريخ ≥ from (PENDING/ERROR/HELD/BLOCKED وما لم يُلتقط بعد) — لا تمنع الحفظ
      let pendingFeesAffected = { count: 0, feeMilli: 0, fee: '0' };
      if (decision.from !== null) {
        const since = zonedStartOfDay(decision.from, tz);
        const [fees, finals] = [
          await tx.settlementEntry.findMany({ where: { tenantId: tid, kind: 'FEE', createdAt: { gte: since } }, select: { id: true, amount: true } }),
          await tx.glSourceEvent.findMany({
            where: { tenantId: tid, sourceType: 'PAYLINK_FEE', status: { in: ['DONE', 'SKIPPED'] }, effectAt: { gte: since } },
            select: { sourceId: true },
          }),
        ];
        pendingFeesAffected = summarizePendingFees(fees, new Set(finals.map(f => f.sourceId)), s.currencyDecimals);
      }

      const before = s.paylinkFeeTaxInvoiceFrom ? fromDbDate(s.paylinkFeeTaxInvoiceFrom) : null;
      const out = { paylinkFeeTaxInvoiceFrom: decision.from, previous: before, lastPostedFeeDate, pendingFeesAffected, preview, changed: false };
      if (preview || decision.unchanged) return out;

      await tx.glSettings.update({
        where: { tenantId: tid },
        data: { paylinkFeeTaxInvoiceFrom: decision.from ? toDbDate(decision.from) : null },
      });
      const summary = paylinkFeeInvoiceFromSummary(before, decision.from);
      await appendAudit(tx, {
        tenantId: tid, actor, action: 'SETTINGS_CHANGE', entityType: 'SETTINGS', entityId: s.id,
        summary,
        before: { paylinkFeeTaxInvoiceFrom: before },
        after: { paylinkFeeTaxInvoiceFrom: decision.from },
      });
      await tx.notification.create({
        data: {
          tenantId: tid, type: 'LEDGER_SETTINGS_CHANGE', title: 'ضريبة عمولة الدفع الإلكتروني', body: summary,
          data: JSON.stringify({ before, after: decision.from, pendingFeesAffected, actorId: actor.actorId }),
        },
      });
      return { ...out, changed: true };
    }, { maxWait: 10_000, timeout: 30_000 });
    res.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof OwnerLedgerReply) { res.status(err.status).json(err.body); return; }
    next(err);
  }
});

export default router;
