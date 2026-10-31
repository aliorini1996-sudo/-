import { Router, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { mailLayout, sendMail } from '../services/mailer';
import { platformGate, impersonationIssuer, writePlatformAudit, type PlatformRequest } from '../services/platformAccess';
import { escapeHtml, frontendBase } from '../services/affiliate/core';
import { tempPassword } from './platformStaff';
import { AuthRequest } from '../types';
import { cardStatuses, platformMetrics, sendWeeklyReport } from '../services/opsSchedule';
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
import { adminPermissionFields, ownerSessionPermissionFields } from './auth';
import { tenantDeleteArchiveBlock } from '../compliance/zatca/settingsGuards';
import { lotErr, lotErrorBody, lotHttpError } from '../services/lots';
import { listMerchants, nearpayConfigured } from '../services/nearpay';
import { recordLotEvent, type LotEventActor } from '../services/lotsDb';
import { CONVERT_BASE_OPEN_TO_COMPANY } from '../services/convertBaseAccess';

// إدارة الشركات المشتركة — لمالك المنصّة (السوبر أدمن) فقط
const router = Router();
// مالك المنصة وموظفوها بصلاحياتهم (services/platformAccess.ts: platformGate — ما لا قاعدة له للمالك وحده)
router.use(platformGate);

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
  // المالك يضعها؛ وموظف المنصة لا يرسلها — يولّدها الخادم ويرسلها إلى بريد المدير (POST /)
  adminPassword: z.string().min(8, 'كلمة المرور 8 أحرف على الأقل').optional(),
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
  attendanceEnabled: z.boolean().optional(),
  invoiceSignatureEnabled: z.boolean().optional(),
  // ربط فوترة ZATCA المرحلة الثانية — في التحديث وحده (مطفأ افتراضياً)
  zatcaPhase2Enabled: z.boolean().optional(),
  // المندوب الذكي AI — في التحديث وحده (مطفأ افتراضياً)
  aiRepEnabled: z.boolean().optional(),
  // «الربط البرمجي API» (مفاتيح API للشركة) — في التحديث وحده (مطفأ افتراضياً)
  apiEnabled: z.boolean().optional(),
  // صفحة «طرق الدفع» (تحصيل المناديب لكل طريقة دفع) — في التحديث وحده (مطفأ افتراضياً)
  paymentMethodsEnabled: z.boolean().optional(),
  // «لوكيشن» (مواقع الشركة وختم الفواتير والتحميلات بموقع المندوب) — في التحديث وحده (مطفأ افتراضياً)
  locationsEnabled: z.boolean().optional(),
  // «تتبّع اللوط» (التشغيلات، services/lots.ts) — في التحديث وحده (مطفأ افتراضياً)؛ كل انتقالٍ إلى المفعّل يبدأ حقبةً جديدة (D25)
  lotTrackingEnabled: z.boolean().optional(),
  // «إضافة وحدة فرعية أصغر» (convert-base) لمديري الشركة (الوحدة الرئيسية D14-ب) — في التحديث وحده (مطفأ افتراضياً)، ولمالك
  // المنصّة وحده (PUT /:id). لا أثر له ما دامت بوابة الإطلاق في الكود مغلقة (CONVERT_BASE_OPEN_TO_COMPANY)
  convertBaseOpen: z.boolean().optional(),
  // «التحصيل بالبطاقة» (NearPay SoftPOS) وتاجر الشركة لديهم — في التحديث وحده (مطفأ افتراضياً)
  cardPayEnabled: z.boolean().optional(),
  nearpayMerchantId: z.string().uuid().nullable().optional(),
  // النظام المحاسبي المتكامل — في التحديث وحده، ومحروسٌ بقائمة التجربة في PUT /:id (§8.1)
  accountingSuiteEnabled: z.boolean().optional(),
  subscriptionEndsAt: z.string().nullish(),
  notes: z.string().nullish(),
});

// ————— «تتبّع اللوط» على مستوى الشركة (المواصفة §٤.١، §٤.١٩، D25، D31) —————

/** productId حدثِ الشركة (TRACKING_ON/OFF لعلمها) في lot_events — العمود إلزامي بلا مفتاح أجنبي، وأحداث الصنف تحمل معرّفه */
export const TENANT_LOT_EVENT_PRODUCT = '*';
/** مدة حفظ سجلات توزيع التشغيلات بعد انتهائها (D31) */
export const LOT_RECORDS_RETENTION_DAYS = 180;
/** مهلة انتظار عمليات اللوط الجارية عند بدء حقبة الشركة — دون مهلة المعاملة (٣٠ ثانية) وفوق مهلة معاملة اللوط (٢٠ ثانية، D13) */
const TENANT_LOT_WAIT_TIMEOUT = '25s';

/** أقدم انتهاءٍ يُحفظ سجلّه: تاريخ اليوم (UTC — يومٌ أبكر من الرياض قبل منتصف ليلها، أي أحوط) ناقص مدة الحفظ */
export function lotRecordsKeepFrom(now: Date): Date {
  const d = new Date(now.getTime() - LOT_RECORDS_RETENTION_DAYS * 86_400_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** تشغيلاتٌ سجلّها محفوظ (D31): انتهاؤها في المدة أو بعدها أو بلا انتهاء، ولها صفّ توزيع على سيارة أو فاتورة */
export function lotRecordsRetainedWhere(tid: string, keepFrom: Date): Prisma.ProductLotWhereInput {
  return {
    tenantId: tid,
    OR: [{ expiryDate: null }, { expiryDate: { gte: keepFrom } }],
    AND: [{ OR: [{ vanLoadItemLots: { some: {} } }, { invoiceItemLots: { some: {} } }] }],
  };
}

/** ?confirmLotRecords=1 (وحده، كتأكيد حذف الدفاتر) */
export function isLotRecordsConfirmed(queryValue: unknown): boolean {
  return queryValue === '1' || (Array.isArray(queryValue) && queryValue.length === 1 && queryValue[0] === '1');
}

/**
 * تبدأ حقبة الشركة **بعد** عمليات اللوط الجارية: كل عملية لوطٍ تمسك صفوف أصنافها FOR KEY SHARE حتى تلتزم (lockLotProducts)،
 * وFOR UPDATE على الأصناف المتتبَّعة ينتظرها — ومنها عمليةٌ قرأت حقبةً سابقة قبل إطفاءٍ وإعادة تفعيلٍ متتابعين، فلو كتبت صفوفها
 * بعد بداية الجديدة لصار لوطٌ مسمّى سالباً (I1). وما يبدأ بعدنا ينتظر التزامنا فيقرأ الحقبة الجديدة. الصفوف بترتيب المعرّف كما يقفلها
 * lockLotProducts (ORDER BY id) فلا تعطّل متبادل معها. المهلة محلية بالحفظ والاستعادة (نمطه نفسه): تجاوزها 55P03 ⇒ 503 LOT_BUSY،
 * والمعاملة تُجهَض فلا حقبة نصفية.
 */
async function waitLotOperations(tx: Prisma.TransactionClient, tid: string): Promise<void> {
  const prev = await tx.$queryRaw<{ lock_timeout: string }[]>`SELECT current_setting('lock_timeout') AS lock_timeout`;
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${TENANT_LOT_WAIT_TIMEOUT}, true)`;
  await tx.$executeRaw`SELECT 1 FROM products WHERE "tenantId" = ${tid} AND "lotTracked" = true ORDER BY id FOR UPDATE`;
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${prev[0]?.lock_timeout ?? '0'}, true)`;
}

/**
 * علم الشركة السابق تحت قفل صفّها: FOR NO KEY UPDATE هو قفل tenant.update نفسه مأخوذاً مبكّراً — يرتّب تبديلين متزامنين فيقرأ
 * الثاني ما التزمه الأوّل، ولا يتعارض مع FOR KEY SHARE الذي تأخذه مفاتيح ProductLot وLotEvent الأجنبية (فلا ينتظره كاتب لوط).
 */
async function lockedTenantLotFlag(tx: Prisma.TransactionClient, tid: string): Promise<{ lotTrackingEnabled: boolean } | null> {
  const rows = await tx.$queryRaw<{ lotTrackingEnabled: boolean }[]>`SELECT "lotTrackingEnabled" FROM tenants WHERE id = ${tid} FOR NO KEY UPDATE`;
  return rows[0] ?? null;
}

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

/**
 * ما مرّ عبر المنصة: عدد الفواتير المصدرة وإجمالي مبيعاتها (طلب المالك، ٢ أكتوبر ٢٠٢٦). التعريف تعريف نافذة أداء
 * الشركة نفسه: فواتير مؤكَّدة غير مرتجعة. والمبيعات لكل عملة على حدة — شركاتٌ بالريال وأخرى بالدينار أو الدولار، وجمعها
 * في رقم واحد كاذب. يُحفظ دقيقةً: تجميع على جدول الفواتير كله في قاعدة صغيرة.
 */
let platformTotalsCache: { at: number; data: unknown } | null = null;
router.get('/platform-totals', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (platformTotalsCache && Date.now() - platformTotalsCache.at < 60_000) {
      res.json({ success: true, data: platformTotalsCache.data });
      return;
    }
    const [byTenant, settings] = await Promise.all([
      prisma.invoice.groupBy({
        by: ['tenantId'],
        where: { status: 'CONFIRMED', type: { not: 'RETURN' } },
        _count: { _all: true },
        _sum: { total: true },
      }),
      prisma.companySettings.findMany({ select: { tenantId: true, currency: true } }),
    ]);
    const currencyOf = new Map(settings.map(s => [s.tenantId, s.currency || 'SAR']));
    const totals = new Map<string, { total: number; invoices: number }>();
    let invoicesCount = 0;
    for (const row of byTenant) {
      const cur = currencyOf.get(row.tenantId) ?? 'SAR';
      const t = totals.get(cur) ?? { total: 0, invoices: 0 };
      t.total += Number(row._sum.total ?? 0);
      t.invoices += row._count._all;
      totals.set(cur, t);
      invoicesCount += row._count._all;
    }
    const data = {
      invoicesCount,
      salesByCurrency: [...totals].map(([currency, t]) => ({ currency, total: Math.round(t.total * 1000) / 1000, invoices: t.invoices }))
        .sort((a, b) => b.invoices - a.invoices),
    };
    platformTotalsCache = { at: Date.now(), data };
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// قائمة الشركات مع ملخص لكل واحدة
router.get('/', async (req: PlatformRequest, res: Response, next: NextFunction) => {
  try {
    const tenants = await prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        // عدد العملاء للمالك وحده (طلب المالك): لا يُقرأ لموظف المنصة فلا يصل ردّه
        _count: { select: { admins: true, salesReps: true, customers: !req.platformStaff, invoices: true } },
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
    res.json({
      success: true,
      data: tenants.map(t => ({
        ...t,
        ledgerStatus: ledgerStatusOf({
          accountingSuiteEnabled: t.accountingSuiteEnabled,
          accountingEnabled: t.accountingEnabled,
          activatedAt: t.glSettings?.activatedAt ?? null,
          stuckEvents: stuck.get(t.id) ?? 0,
        }),
        ledgerActivatedAt: t.glSettings?.activatedAt ?? null,
        // بوابة الإطلاق (للقراءة فقط): مغلقة ⇒ خانة علم «إضافة وحدة فرعية أصغر» معطّلة في صفحة المنصّة
        convertBaseReleased: CONVERT_BASE_OPEN_TO_COMPANY,
      })),
    });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: PlatformRequest, res: Response, next: NextFunction) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      include: {
        admins: { select: { id: true, name: true, email: true, isActive: true } },
        // عدد العملاء للمالك وحده — كقائمة الشركات
        _count: { select: { salesReps: true, customers: !req.platformStaff, products: true, invoices: true, receipts: true } },
      },
    });
    if (!tenant) { res.status(404).json({ success: false, message: 'الشركة غير موجودة' }); return; }
    // convertBaseOpen من الصفّ نفسه، وبوابة الإطلاق للقراءة فقط (الوحدة الرئيسية §2.4)
    res.json({ success: true, data: { ...tenant, convertBaseReleased: CONVERT_BASE_OPEN_TO_COMPANY } });
  } catch (err) { next(err); }
});

// إنشاء شركة جديدة + أدمنها الأول + إعدادات شركتها
router.post('/', async (req: PlatformRequest, res: Response, next: NextFunction) => {
  try {
    const body = createTenantSchema.parse(req.body);
    // موظف المنصة لا يختار كلمة مرور المدير: كلمةٌ يعرفها كانت دخولاً دائماً بهوية المدير لا يسقطه تعطيله (كإعادة كلمة المرور)
    const byStaff = !!req.platformStaff;
    if (byStaff && body.adminPassword !== undefined) {
      res.status(400).json({ success: false, code: 'STAFF_CREATE_NO_PASSWORD', message: 'كلمة مرور المدير ترسل الى بريده ولا تكتب هنا' });
      return;
    }
    if (!byStaff && !body.adminPassword) { res.status(400).json({ success: false, message: 'كلمة المرور 8 أحرف على الأقل' }); return; }

    const emailTaken = await prisma.admin.findUnique({ where: { email: body.adminEmail } });
    if (emailTaken) { res.status(409).json({ success: false, message: 'البريد الإلكتروني مستخدم مسبقا' }); return; }

    const password = byStaff ? tempPassword() : body.adminPassword!;
    if (byStaff) {
      // تُرسل قبل الإنشاء: تعذّر البريد ⇒ لا شركة بمديرٍ لا يعرف كلمته
      const sent = await sendMail({
        to: body.adminEmail,
        subject: 'حسابك في فيلد سيلز جاهز',
        html: mailLayout('حسابك جاهز', [
          ['الشركة', escapeHtml(body.companyName)], ['البريد', escapeHtml(body.adminEmail)], ['كلمة المرور المؤقتة', `<bdi dir="ltr">${password}</bdi>`],
        ], `أنشأ فريق فيلد سيلز حساب شركتك. ادخل من <a href="${escapeHtml(frontendBase())}/login">${escapeHtml(frontendBase())}/login</a> ثم غيّر كلمة المرور من حسابك.`),
      });
      if (!sent) { res.status(502).json({ success: false, code: 'CREATE_MAIL_FAILED', message: 'تعذر ارسال البريد الى المدير فلم تنشأ الشركة' }); return; }
    }
    const passwordHash = await bcrypt.hash(password, 10);

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

    res.status(201).json({ success: true, data: { ...tenant, adminEmail: body.adminEmail, ...(byStaff ? { passwordSentTo: maskEmail(body.adminEmail) } : {}) } });
  } catch (err) { next(err); }
});

// تعديل اشتراك الشركة (تفعيل/تعطيل، تاريخ انتهاء، خطة)
router.put('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = updateTenantSchema.parse(req.body);
    // «التحصيل بالبطاقة» للمالك وحده (مراجعة ٣١ أكتوبر ٢٠٢٦): تاجر NearPay يحدّد إلى أين يذهب مال الشركة، فموظف المنصة — ولو بـ
    // tenants.edit — لا يفعّله ولا يغيّر التاجر. الجسم الذي يعيد القيم نفسها يمرّ (نموذج الحفظ يرسلهما دائماً)
    const cardPayCur = body.cardPayEnabled !== undefined || body.nearpayMerchantId !== undefined
      ? await prisma.tenant.findUnique({ where: { id: req.params.id }, select: { cardPayEnabled: true, nearpayMerchantId: true } })
      : null;
    const merchantChanged = !!cardPayCur && body.nearpayMerchantId !== undefined && (body.nearpayMerchantId ?? null) !== cardPayCur.nearpayMerchantId;
    if ((req as PlatformRequest).platformStaff && cardPayCur
      && (merchantChanged || (body.cardPayEnabled !== undefined && body.cardPayEnabled !== cardPayCur.cardPayEnabled))) {
      res.status(403).json({ success: false, code: 'STAFF_CARDPAY_FORBIDDEN', message: 'التحصيل بالبطاقة وتاجر NearPay يضبطهما مالك المنصة وحده' });
      return;
    }
    // «إضافة وحدة فرعية أصغر» (الوحدة الرئيسية D14-ب): يقلبه مالك المنصّة وحده — العلم يفتح إعادة كتابة تاريخ الأصناف لمديري
    // الشركة، فلا يكفيه «تعديل الاشتراك» لموظف المنصّة (platformGate يسمح له بالمسار كله). الجسم الذي يعيد القيمة نفسها يمرّ
    // (نموذج الحفظ قد يرسل الأعلام كلها) — كالتحصيل بالبطاقة أعلاه
    if ((req as PlatformRequest).platformStaff && body.convertBaseOpen !== undefined) {
      const cur = await prisma.tenant.findUnique({ where: { id: req.params.id }, select: { convertBaseOpen: true } });
      if (cur && cur.convertBaseOpen !== body.convertBaseOpen) {
        res.status(403).json({ success: false, code: 'CONVERT_BASE_FLAG_OWNER_ONLY', message: 'هذا الإعداد لمالك المنصة وحده' });
        return;
      }
    }
    // التاجر الجديد موجودٌ فعلاً بين تجّار حسابنا لدى NearPay — لا يُربط معرّفٌ مكتوب باليد، ويفشل مغلقاً إن تعذّر السؤال
    if (merchantChanged && body.nearpayMerchantId) {
      const known = nearpayConfigured() ? await listMerchants().catch(() => null) : null;
      if (!known) { res.status(503).json({ success: false, code: 'NEARPAY_UNAVAILABLE', message: 'تعذر التحقق من التاجر لدى NearPay حاول بعد لحظات' }); return; }
      if (!known.some((m) => m.id === body.nearpayMerchantId)) {
        res.status(400).json({ success: false, code: 'NEARPAY_MERCHANT_UNKNOWN', message: 'التاجر غير موجود لدى NearPay' }); return;
      }
    }
    // «التحصيل بالبطاقة»: تاجرٌ واحد لشركة واحدة — لا تتقاسم شركتان نقاط بيعٍ ومالاً
    if (body.nearpayMerchantId) {
      const owner = await prisma.tenant.findFirst({ where: { nearpayMerchantId: body.nearpayMerchantId, id: { not: req.params.id } }, select: { name: true } });
      if (owner) { res.status(409).json({ success: false, message: `تاجر NearPay مربوط بشركة أخرى (${owner.name})` }); return; }
    }
    // النظام المحاسبي المتكامل: يفعّله المالك لأي شركة (قرار المالك 17 سبتمبر 2026 بإزالة قائمة التجربة، §8.1)
    const data: Record<string, unknown> = { ...body };
    if ('subscriptionEndsAt' in body) {
      data.subscriptionEndsAt = body.subscriptionEndsAt ? new Date(body.subscriptionEndsAt) : null;
    }
    // M2 (§5.6 الخطوة 1، §9.3): تبديل العَلَم يُدوَّن FLAG_TOGGLE في معاملة التحديث نفسها، حين تتغير
    // القيمة فعلاً وحدها، دون اشتراط صف GlSettings ولا أي زرع في مسار المالك.
    // «تتبّع اللوط» (§٤.١): الجسم بلا العلم ⇒ المعاملة كما كانت حرفياً (لا قراءة ولا مهلة جديدة)
    const lotToggle = body.lotTrackingEnabled !== undefined;
    const tenant = await prisma.$transaction(async tx => {
      const before = body.accountingSuiteEnabled === undefined
        ? null
        : await tx.tenant.findUnique({ where: { id: req.params.id }, select: { accountingSuiteEnabled: true } });
      // «تتبّع اللوط» (D25): السابق داخل المعاملة، وكل انتقالٍ إلى المفعّل يبدأ حقبةً جديدة (lotTrackingSince) بعد عمليات اللوط
      // الجارية — فأرصدة التشغيلات تصير غير مسمّاة حتى تُسمّى (D8). وقبل أي كتابة: صفوف الأصناف قبل صفّ الشركة كترتيب §٣.١.
      // القراءة الأولى بلا قفل تقرّر الانتظار وحده؛ والمرجع للحقبة والحدث هو السابق تحت قفل صفّ الشركة بعده: تبديلان متزامنان
      // (نقرة حفظٍ مزدوجة) يرى ثانيهما ما التزمه الأوّل، فلا حقبة ثانية فوق الأولى ولا TRACKING_ON/OFF مكرّر
      const lotHint = lotToggle
        ? await tx.tenant.findUnique({ where: { id: req.params.id }, select: { lotTrackingEnabled: true } })
        : null;
      const lotWaited = lotHint !== null && lotHint.lotTrackingEnabled !== true && body.lotTrackingEnabled === true;
      if (lotWaited) await waitLotOperations(tx, req.params.id);
      const lotBefore = lotHint ? await lockedTenantLotFlag(tx, req.params.id) : null;
      if (lotBefore && lotBefore.lotTrackingEnabled !== true && body.lotTrackingEnabled === true) {
        // إطفاءٌ متزامن التزم بين القراءتين (نادر): الانتظار هنا بعد صفّ الشركة — لا تأخذ عملية لوطٍ عليه إلا FOR KEY SHARE
        if (!lotWaited) await waitLotOperations(tx, req.params.id);
        data.lotTrackingSince = new Date();
      }
      // «التحصيل بالبطاقة»: تغيير تاجر الشركة لدى NearPay يُسقط إسناد نقاط البيع القديمة — نقطةُ التاجر السابق لا يبقى مالها لهذه الشركة
      if (body.nearpayMerchantId !== undefined) {
        const prev = await tx.tenant.findUnique({ where: { id: req.params.id }, select: { nearpayMerchantId: true } });
        if (prev && prev.nearpayMerchantId !== body.nearpayMerchantId) {
          await tx.salesRep.updateMany({ where: { tenantId: req.params.id, nearpayTid: { not: null } }, data: { nearpayTid: null } });
        }
      }
      const updated = await tx.tenant.update({ where: { id: req.params.id }, data });
      if (before && before.accountingSuiteEnabled !== updated.accountingSuiteEnabled) {
        await appendAudit(tx, {
          tenantId: updated.id,
          // المالك OWNER، وموظف المنصة بـtenants.edit STAFF باسمه — لا يُنسب فعله إلى المالك
          actor: ownerActor(req),
          action: 'FLAG_TOGGLE',
          entityType: 'TENANT',
          entityId: updated.id,
          summary: updated.accountingSuiteEnabled ? 'تفعيل النظام المحاسبي المتكامل' : 'إطفاء النظام المحاسبي المتكامل',
          before: { accountingSuiteEnabled: before.accountingSuiteEnabled },
          after: { accountingSuiteEnabled: updated.accountingSuiteEnabled },
        });
      }
      // سجل تدقيق اللوط (المادة ٥٢): تبديل علم الشركة حدثٌ على مستوى الشركة (productId = TENANT_LOT_EVENT_PRODUCT)، حين تتغيّر القيمة وحدها
      if (lotBefore && (lotBefore.lotTrackingEnabled === true) !== (updated.lotTrackingEnabled === true)) {
        await recordLotEvent(tx, {
          tenantId: updated.id, lotId: null, productId: TENANT_LOT_EVENT_PRODUCT,
          kind: updated.lotTrackingEnabled === true ? 'TRACKING_ON' : 'TRACKING_OFF',
          before: { lotTrackingEnabled: lotBefore.lotTrackingEnabled === true },
          after: { lotTrackingEnabled: updated.lotTrackingEnabled === true, lotTrackingSince: updated.lotTrackingSince ? updated.lotTrackingSince.toISOString() : null },
          actor: lotEventActorOf(req),
        });
      }
      return updated;
    }, lotToggle ? { maxWait: 10_000, timeout: 30_000 } : undefined); // بدء الحقبة قد ينتظر عملية لوطٍ جارية (D13: حتى ٢٠ ثانية)
    res.json({ success: true, data: tenant });
  } catch (err) {
    // تبديل «تتبّع اللوط» وحده: انتظارٌ تجاوز المهلة (55P03) أو مهلة المعاملة ⇒ 503 LOT_BUSY (أعد المحاولة)
    const lh = req.body?.lotTrackingEnabled !== undefined ? lotHttpError(err) : null;
    if (lh) { res.status(lh.status).json(lh.body); return; }
    next(err);
  }
});

// دخول المالك إلى لوحة الشركة (انتحال) — يُصدر توكن بصلاحيات أدمن الشركة
router.post('/:id/impersonate', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) { res.status(404).json({ success: false, message: 'الشركة غير موجودة' }); return; }
    // نشطاً أوّلاً: `requireAdmin` صار يتحقّق من الحساب نفسه، فانتحالُ أقدمِ
    // مديرٍ ولو كان معطَّلاً يُصدر توكناً يُرفض على كل مسار إداري.
    // مدير الشركة (ADMIN) أولاً: بعض بوابات الخادم تشترط دور المدير من القاعدة (زاتكا وحقول البائع) — ثم أي حساب نشط
    const admin = await prisma.admin.findFirst({ where: { tenantId: tenant.id, isActive: true, role: 'ADMIN' }, orderBy: { createdAt: 'asc' } })
      ?? await prisma.admin.findFirst({ where: { tenantId: tenant.id, isActive: true }, orderBy: { createdAt: 'asc' } })
      ?? await prisma.admin.findFirst({ where: { tenantId: tenant.id }, orderBy: { createdAt: 'asc' } });
    if (!admin) { res.status(404).json({ success: false, message: 'لا يوجد مدير لهذه الشركة' }); return; }
    if (!admin.isActive) { res.status(409).json({ success: false, message: 'كل مديري هذه الشركة معطلون فعل حسابا قبل الدخول' }); return; }

    // المُصدِر (المالك أو الموظف ونسخة جلسته) يُفحص حيّاً في كل طلب من الجلسة (authenticate ← impersonationIssuerOk)
    const token = jwt.sign(
      { id: admin.id, role: admin.role, name: admin.name, tenantId: tenant.id, impersonated: true, ...impersonationIssuer(req) },
      process.env.JWT_SECRET!,
      { expiresIn: '2h' }
    );
    res.json({
      success: true,
      // صلاحيات صاحب الحساب ونطاقه — وإلا أخفى الويب الدفاتر التي يسمح بها الخادم (§9.1)
      // جلسة مالك المنصة: كل الصلاحيات مفتوحة ولا نطاق (أمر المالك: «صلاحية تعديل كل شيء بلا استثناء») — الخادم يطابقها بـisOwnerSession
      data: { token, user: { id: admin.id, name: admin.name, email: admin.email, role: admin.role, tenantId: tenant.id, companyName: tenant.name, ...adminPermissionFields(admin), ...ownerSessionPermissionFields() } },
    });
  } catch (err) { next(err); }
});

// حذف شركة نهائياً مع كل بياناتها (بترتيب آمن لقيود المفاتيح الأجنبية)
router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = req.params.id;
    const tenant = await prisma.tenant.findUnique({ where: { id: tid } });
    if (!tenant) { res.status(404).json({ success: false, message: 'الشركة غير موجودة' }); return; }

    // فوترة ZATCA (Z5.0، F12): وحدات الفوترة ومستنداتها محفوظة نظاماً (onDelete: Restrict) — ردّ 409 واضح قبل أي حذف بدل
    // P2003 يصل 500. شركة بلا وحدة ⇒ الحذف كما اليوم
    const einvoiceArchive = tenantDeleteArchiveBlock(await prisma.zatcaEgsUnit.count({ where: { tenantId: tid } }));
    if (einvoiceArchive) { res.status(einvoiceArchive.status).json(einvoiceArchive.body); return; }

    // ضمانة الحفظ G6 (§3.9، §9.5 (د) و(ط)): قبل أول عبارة حذف وقبل قراءة confirmLedgerDestroy.
    // بلا صف GlSettings لا قيد مرحَّل ممكن ⇒ الحذف كما اليوم دون أي عدّ.
    const glSettings = await prisma.glSettings.findUnique({
      where: { tenantId: tid },
      select: { fiscalYearEndMonth: true, fiscalYearEndDay: true, timezone: true },
    });
    let postedMoves = 0;
    let lastPostedDate: Date | null = null;
    if (glSettings) {
      const agg = await prisma.glMove.aggregate({ where: { tenantId: tid, number: { not: null } }, _count: { _all: true }, _max: { date: true } });
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

    // «تتبّع اللوط» — حارس الحفظ (D31): سجلات توزيع تشغيلاتٍ حديثة تلزم لاستدعاء المنتج ١٨٠ يوماً بعد انتهائها؛ الحذف يتطلب
    // ?confirmLotRecords=1 بعد تصديرها. بعد حرّاس الفوترة والدفاتر (ما لا يتجاوزه تأكيد أولاً) وقبل أول حذف. عدٌّ واحد في مسارٍ
    // نادر للمالك (§١٠.١)، ولا عدّ بعد التأكيد
    if (!isLotRecordsConfirmed(req.query.confirmLotRecords)) {
      const keepFrom = lotRecordsKeepFrom(new Date());
      const retainedLots = await prisma.productLot.count({ where: lotRecordsRetainedWhere(tid, keepFrom) });
      if (retainedLots > 0) {
        res.status(409).json(lotErrorBody(lotErr('LOT_RECORDS_RETAINED', {}, {
          lots: retainedLots, expiryFrom: keepFrom.toISOString().slice(0, 10), retentionDays: LOT_RECORDS_RETENTION_DAYS,
        })));
        return;
      }
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
        const aggNow = gsNow ? await tx.glMove.aggregate({ where: { tenantId: tid, number: { not: null } }, _count: { _all: true }, _max: { date: true } }) : null;
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
        await tx.cardPayment.deleteMany({ where: { tenantId: tid } });
        await tx.receiptInvoice.deleteMany({ where: { receipt: { tenantId: tid } } });
        await tx.invoiceItem.deleteMany({ where: { invoice: { tenantId: tid } } });
        await tx.accountEntry.deleteMany({ where: { tenantId: tid } });
        await tx.receipt.deleteMany({ where: { tenantId: tid } });
        await tx.invoice.deleteMany({ where: { tenantId: tid } });
        await tx.customerPrice.deleteMany({ where: { customer: { tenantId: tid } } });
        await tx.priceTier.deleteMany({ where: { product: { tenantId: tid } } });
        await tx.notification.deleteMany({ where: { tenantId: tid } });
        await tx.customer.deleteMany({ where: { tenantId: tid } });
        // «تتبّع اللوط» (§٤.١٩): ما يشير إلى اللوطات بلا تعاقب (NoAction) قبلها، واللوطات قبل الأصناف (Restrict). صفوف
        // invoice_item_lots حُذفت تعاقبياً مع البنود أعلاه، وlot_events تُحذف تعاقبياً مع الشركة
        await tx.lotRelabel.deleteMany({ where: { tenantId: tid } });
        await tx.vanLoadItemLot.deleteMany({ where: { tenantId: tid } });
        await tx.warehouseEntryItem.updateMany({ where: { entry: { tenantId: tid }, lotId: { not: null } }, data: { lotId: null } });
        await tx.productLot.deleteMany({ where: { tenantId: tid } });
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

/** «ab***@domain» — يعرف الموظف أين ذهبت الرسالة بلا كشف عنوان المدير كاملاً */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email.slice(0, at > 2 ? 2 : 1)}***${email.slice(at)}`;
}

const staffResetAdminSchema = z.object({ adminId: z.string().optional() });

/**
 * إعادة كلمة مرور المدير بيد موظف المنصة: لا يضع كلمةً يعرفها — كان يدخل بها /api/auth/login دخولاً عادياً دائماً بهوية
 * المدير لا يسقطه تعطيله. الخادم يولّد كلمة مؤقتة ويرسلها إلى بريد المدير وحده **قبل** حفظ تجزئتها (تعذّر الإرسال ⇒ لا
 * يتغيّر شيء)، ولا تعود في الردّ. وسطرٌ في سجل النشاط بمعرّف المدير قبل الفعل (سطر الحارس يحمل معرّف الشركة وحده)
 */
async function staffResetAdmin(req: PlatformRequest, res: Response): Promise<void> {
  const staff = req.platformStaff!;
  if (req.body?.newPassword !== undefined) {
    res.status(400).json({ success: false, code: 'STAFF_RESET_NO_PASSWORD', message: 'كلمة المرور المؤقتة ترسل الى بريد المدير ولا تكتب هنا' });
    return;
  }
  const { adminId } = staffResetAdminSchema.parse(req.body ?? {});
  const admin = adminId
    ? await prisma.admin.findFirst({ where: { id: adminId, tenantId: req.params.id } })
    : await prisma.admin.findFirst({ where: { tenantId: req.params.id }, orderBy: { createdAt: 'asc' } });
  if (!admin) { res.status(404).json({ success: false, message: 'المدير غير موجود' }); return; }
  // sendMail بلا `to` يرسل إلى بريد المالك (MAIL_TO) — فلا إرسال إلا إلى بريدٍ صالح للمدير نفسه
  if (!z.string().email().safeParse(admin.email).success) {
    res.status(409).json({ success: false, code: 'ADMIN_EMAIL_MISSING', message: 'لا بريد صالح لهذا المدير فلا يمكن ارسال كلمة مرور مؤقتة' });
    return;
  }
  const email = maskEmail(admin.email);
  try {
    await writePlatformAudit({
      actorType: 'STAFF', actorId: staff.id, actorName: staff.name, action: 'tenants.resetPassword.admin', method: req.method,
      path: `${req.baseUrl}${req.path}`, targetId: admin.id, detail: { tenantId: admin.tenantId, email }, ip: req.ip ?? null,
    });
  } catch {
    res.status(503).json({ success: false, code: 'AUDIT_UNAVAILABLE', message: 'تعذر تسجيل العملية في سجل النشاط فلم تنفذ حاول مجددا' });
    return;
  }
  const tenant = await prisma.tenant.findUnique({ where: { id: admin.tenantId }, select: { name: true } });
  const password = tempPassword();
  const sent = await sendMail({
    to: admin.email,
    subject: 'كلمة مرور مؤقتة لحسابك في فيلد سيلز',
    html: mailLayout('كلمة مرور مؤقتة', [
      ['الشركة', escapeHtml(tenant?.name ?? '—')], ['البريد', escapeHtml(admin.email)], ['كلمة المرور المؤقتة', `<bdi dir="ltr">${password}</bdi>`],
    ], `أعاد فريق فيلد سيلز تعيين كلمة مرور حسابك. ادخل بها من <a href="${escapeHtml(frontendBase())}/login">${escapeHtml(frontendBase())}/login</a> ثم غيّرها من حسابك، وإن لم تطلب ذلك فتواصل معنا فوراً.`),
  });
  if (!sent) {
    res.status(502).json({ success: false, code: 'RESET_MAIL_FAILED', message: 'تعذر ارسال البريد الى المدير فلم تتغير كلمة المرور' });
    return;
  }
  await prisma.admin.update({ where: { id: admin.id }, data: { passwordHash: await bcrypt.hash(password, 10) } });
  res.json({ success: true, data: { sent: true, email } });
}

// إعادة تعيين كلمة مرور أدمن الشركة — موظف المنصة عبر بريد المدير (staffResetAdmin)، والمالك كما كان
router.post('/:id/reset-admin', async (req: PlatformRequest, res: Response, next: NextFunction) => {
  try {
    if (req.platformStaff) { await staffResetAdmin(req, res); return; }
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

/** منفّذ إجراءات لوحة المنصة في سجل تدقيق الدفاتر: المالك OWNER، وموظف المنصة STAFF باسمه (req.user.id معرّفه) */
export function ownerActor(req: PlatformRequest): GlActor {
  const base = { actorId: req.user!.id, impersonated: false, requestIp: req.ip ?? null };
  if (!req.platformStaff) return { actorType: 'OWNER', actorName: req.user!.name ?? null, ...base };
  return { actorType: 'STAFF', actorName: `موظف المنصة: ${req.platformStaff.name}`, ...base };
}

/** منفّذ حدث اللوط من منفّذ اللوحة (ownerActor): المالك، أو موظف المنصة باسمه */
function lotEventActorOf(req: PlatformRequest): LotEventActor {
  const a = ownerActor(req);
  return { type: a.actorType === 'STAFF' ? 'STAFF' : 'OWNER', id: a.actorId, name: a.actorName ?? null };
}

/** رمية داخل المعاملة لرد منظّم بعد تراجعها */
class OwnerLedgerReply extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) { super(String(body.code ?? 'OWNER_LEDGER_REPLY')); }
}

// إعادة ضبط الدفاتر (§5.7): قبل أول ترحيل وحده؛ القفل أول عبارة، ثم الشروط، ثم الحذف بـGL_RESET_ORDER، ثم LEDGER_RESET.
router.post('/:id/ledger-reset', async (req: PlatformRequest, res: Response, next: NextFunction) => {
  try {
    const tid = req.params.id;
    const tenant = await prisma.tenant.findUnique({ where: { id: tid }, select: { id: true, name: true } });
    if (!tenant) { res.status(404).json({ success: false, message: 'الشركة غير موجودة' }); return; }
    // الخادم يتحقق من confirmName حرفياً ولا يكتفي بالواجهة
    if (!resetConfirmNameMatches(req.body?.confirmName, tenant.name)) {
      res.status(422).json({ success: false, code: 'LEDGER_RESET_CONFIRM_MISMATCH', message: 'اسم التأكيد لا يطابق اسم الشركة حرفياً' });
      return;
    }
    // تجاوز مالك المنصّة (§5.7، قرار المالك): الأسباب النظامية تحجب الأدمن، لكن مالك المنصّة — ومعه موظفٌ
    // منحه tenants.ledger (platformGate) ويُدوَّن STAFF باسمه — يستطيع الحذف الكامل بـforce، فتعود الشركة كأنّ
    // الدفاتر لم تُفعَّل قطّ. لا يُمَسّ إلا gl_* (لا فواتير ولا مخزون ولا سندات ولا account_entries)،
    // وسجل التدقيق يبقى ويُكتب فيه ما جرى تجاوزه.
    const force = req.body?.force === true;
    const actor = ownerActor(req);
    const result = await prisma.$transaction(async tx => {
      await acquirePostLock(tx, tid);
      const [postedMoves, securedMoves, settings, customerAdjustmentSources] = [
        // كل قيدٍ رُقّم يوماً (ومنه المسودة المُعادة برقمها) — الإعادة إلى مسودة لا تتخطّى الحارس
        await tx.glMove.count({ where: { tenantId: tid, number: { not: null } } }),
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
      if (reasons.length > 0 && !force) {
        throw new OwnerLedgerReply(409, {
          success: false, code: 'LEDGER_RESET_BLOCKED', reasons, canForce: true,
          message: 'الدفاتر سجلات نظامية بعد أول ترحيل. يمكنك — بصفتك مالك المنصّة — الحذف الكامل رغم ذلك',
        });
      }
      const deleted = await deleteLedgerRows(tx as unknown as ResetTx, tid);
      const summary = ledgerResetSummary(deleted);
      const forced = reasons.length > 0; // وصلنا هنا معها ⇒ تجاوزٌ صريح من المالك أو موظفٍ بـtenants.ledger
      const overrider = req.platformStaff ? `موظف المنصّة ${req.platformStaff.name}` : 'مالك المنصّة';
      await appendAudit(tx, {
        tenantId: tid, actor, action: 'LEDGER_RESET', entityType: 'TENANT', entityId: tid,
        summary: forced ? `${summary.text} (تجاوز ${overrider}: ${reasons.join(', ')})` : summary.text,
        before: { activatedAt: settings?.activatedAt ?? null, ...(forced ? { overrodeReasons: reasons } : {}) },
        after: { deleted, total: summary.total, forced },
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
