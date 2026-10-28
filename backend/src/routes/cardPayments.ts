import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { platformGate } from '../services/platformAccess';
import { AuthRequest } from '../types';
import { canAccessCustomer } from '../services/customerScope';
import { adminRepFilter, scopedRecordWhere, SHAPE_INVOICE_RECEIPT } from '../services/adminScope';
import { cardPayLaunchLimiter } from '../middleware/rateLimits';
import { CardPayError, checkCardPayment, createCardPayment, redeemLaunchToken } from '../services/cardPayment';
import { listMerchantTerminals, listMerchants, nearpayConfigured, NearpayError } from '../services/nearpay';

/**
 * «التحصيل بالبطاقة» عبر NearPay — مسارات /api/card-payments (services/cardPayment.ts يشرح المسار كاملاً).
 *
 *  - POST /launch            عامّ (بلا دخول) لوحدة الدفع الأصلية: يستبدل رمز التسليم بتفاصيل العملية مرة واحدة.
 *  - /owner/merchants        المالك: تجّار NearPay لربط كل شركة بتاجرها.
 *  - POST /issue             المندوب: عملية دفع لفاتورة على نقطة بيعه (محروسٌ بـ«اشتراط تفعيل الموقع» كروابط الدفع).
 *  - POST /:id/check         المندوب أو الإدارة: اسأل NearPay الآن (المجدول يسأل كل دقيقة على أي حال).
 *  - GET  /                  عمليات فاتورة أو آخر عمليات المندوب.
 *  - GET  /terminals, PUT /reps/:salesRepId   الإدارة: نقاط بيع تاجر الشركة وإسنادها للمناديب.
 */
const router = Router();

function sendError(res: Response, e: unknown, next: NextFunction): void {
  if (e instanceof CardPayError) { res.status(e.status).json({ success: false, code: e.code, message: e.message }); return; }
  if (e instanceof NearpayError) {
    console.error('cardpay nearpay:', e.message);
    res.status(502).json({ success: false, code: 'NEARPAY_UNAVAILABLE', message: 'تعذر الاتصال بخدمة الدفع حاول بعد لحظات' });
    return;
  }
  next(e);
}

// ═══ عامّ: وحدة الدفع الأصلية تستبدل رمز التسليم — الرمز وحده هو الإذن (عشوائي، لمرة، عشر دقائق) ═══
router.post('/launch', cardPayLaunchLimiter, async (req, res: Response, next: NextFunction) => {
  try {
    const { token } = z.object({ token: z.string().min(20).max(100) }).parse(req.body);
    res.json({ success: true, data: await redeemLaunchToken(token) });
  } catch (e) { sendError(res, e, next); }
});

// ═══ المالك ═══
router.use('/owner', platformGate);
router.get('/owner/merchants', async (_req, res: Response, next: NextFunction) => {
  try {
    if (!nearpayConfigured()) { res.json({ success: true, data: [], configured: false }); return; }
    res.json({ success: true, data: await listMerchants(), configured: true });
  } catch (e) { sendError(res, e, next); }
});

// ═══ الشركة: دخول ثم بوابة الميزة ═══
router.use(authenticate);
router.use(async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.path.startsWith('/owner/')) { next(); return; }
    const t = await prisma.tenant.findUnique({ where: { id: tenantId(req) }, select: { cardPayEnabled: true, accountingEnabled: true } });
    if (t?.accountingEnabled === false) {
      res.status(403).json({ success: false, code: 'ACCOUNTING_NOT_ALLOWED', message: 'النظام المحاسبي غير مفعّل لهذه الشركة' }); return;
    }
    if (!t?.cardPayEnabled) {
      res.status(403).json({ success: false, code: 'CARD_PAY_NOT_ALLOWED', message: 'التحصيل بالبطاقة غير مفعل لاشتراك شركتك تواصل مع مزود الخدمة' }); return;
    }
    next();
  } catch (e) { next(e); }
});

const isRep = (req: AuthRequest) => req.user?.role === 'SALES_REP';

/** المندوب يبدأ تحصيلاً بالبطاقة لفاتورة — بكامل المتبقّي أو بمبلغ أقل */
router.post('/issue', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isRep(req)) { res.status(403).json({ success: false, message: 'التحصيل بالبطاقة من تطبيق المندوب' }); return; }
    const tid = tenantId(req);
    const body = z.object({ invoiceId: z.string().uuid(), amount: z.number().positive().max(1_000_000).optional() }).parse(req.body);
    const rep = await prisma.salesRep.findFirst({ where: { id: req.user!.id, tenantId: tid }, select: { canCreateReceipt: true } });
    if (!rep?.canCreateReceipt) { res.status(403).json({ success: false, message: 'لا تملك صلاحية إصدار سندات القبض' }); return; }
    const invoice = await prisma.invoice.findFirst({ where: { id: body.invoiceId, tenantId: tid }, select: { id: true, customerId: true } });
    if (!invoice) { res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); return; }
    if (!(await canAccessCustomer(req, tid, invoice.customerId))) {
      res.status(403).json({ success: false, message: 'هذا العميل غير مسند لك' }); return;
    }
    const out = await createCardPayment({ tenantId: tid, invoiceId: invoice.id, salesRepId: req.user!.id, amount: body.amount });
    res.status(201).json({ success: true, data: out });
  } catch (e) { sendError(res, e, next); }
});

/** عمليات فاتورة (?invoiceId=) أو آخر ٢٠ عملية — المندوب يرى عملياته وحده، والإدارة بنطاقها */
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const invoiceId = typeof req.query.invoiceId === 'string' ? req.query.invoiceId : undefined;
    const where: Record<string, unknown> = { tenantId: tid, ...(invoiceId ? { invoiceId } : {}) };
    if (isRep(req)) where.salesRepId = req.user!.id;
    else where.invoice = await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT);
    const rows = await prisma.cardPayment.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 20,
      select: {
        id: true, invoiceId: true, amount: true, reference: true, tid: true, status: true, statusDetail: true, rrn: true, approvalCode: true,
        cardScheme: true, maskedPan: true, receiptId: true, approvedAt: true, createdAt: true, salesRep: { select: { name: true } },
      },
    });
    res.json({ success: true, data: rows });
  } catch (e) { sendError(res, e, next); }
});

/** اسأل NearPay الآن عن عملية — بعد رجوع المندوب من وحدة الدفع، أو من الإدارة */
router.post('/:id/check', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const where: Record<string, unknown> = { id: String(req.params.id), tenantId: tid };
    if (isRep(req)) where.salesRepId = req.user!.id;
    else where.invoice = await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT);
    const row = await prisma.cardPayment.findFirst({ where, select: { id: true } });
    if (!row) { res.status(404).json({ success: false, message: 'العملية غير موجودة' }); return; }
    res.json({ success: true, data: await checkCardPayment(row.id) });
  } catch (e) { sendError(res, e, next); }
});

// ═══ الإدارة: نقاط بيع تاجر الشركة وإسنادها ═══
// requireAdmin أولاً: requireAdminPermission يمرّر المندوب (لا صلاحيات إدارية له) — وبدونه يعيد مندوبٌ إسناد نقاط زملائه
const manageReps = [requireAdmin, requireAdminPermission('canManageSalesReps')];

router.get('/terminals', manageReps, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const tenant = await prisma.tenant.findUnique({ where: { id: tid }, select: { nearpayMerchantId: true } });
    const reps = await prisma.salesRep.findMany({
      where: { tenantId: tid, ...(await adminRepFilter(req)) }, orderBy: { name: 'asc' },
      select: { id: true, name: true, isActive: true, nearpayTid: true },
    });
    if (!tenant?.nearpayMerchantId) { res.json({ success: true, data: { merchantLinked: false, terminals: [], reps } }); return; }
    const terminals = await listMerchantTerminals(tenant.nearpayMerchantId);
    res.json({
      success: true,
      data: {
        merchantLinked: true,
        terminals: terminals.map((t) => ({ tid: t.tid, connected: t.connected, merchantName: t.merchantName })),
        reps,
      },
    });
  } catch (e) { sendError(res, e, next); }
});

router.put('/reps/:salesRepId', manageReps, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { tid: terminalTid } = z.object({ tid: z.string().regex(/^\d{8,20}$/).nullable() }).parse(req.body);
    // نطاق المستخدم المقيَّد: مندوبٌ خارجه «غير موجود»
    const rep = await prisma.salesRep.findFirst({ where: { id: String(req.params.salesRepId), tenantId: tid, ...(await adminRepFilter(req)) }, select: { id: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    if (terminalTid) {
      const tenant = await prisma.tenant.findUnique({ where: { id: tid }, select: { nearpayMerchantId: true } });
      if (!tenant?.nearpayMerchantId) {
        res.status(409).json({ success: false, code: 'CARD_PAY_NO_MERCHANT', message: 'لم يُربط تاجر الشركة لدى NearPay بعد تواصل مع مزود الخدمة' }); return;
      }
      // نقطة البيع لتاجر هذه الشركة وحده — وإلا ذهب مالها لتاجرٍ آخر
      const terminals = await listMerchantTerminals(tenant.nearpayMerchantId);
      if (!terminals.some((t) => t.tid === terminalTid)) {
        res.status(400).json({ success: false, code: 'CARD_PAY_TERMINAL_FOREIGN', message: 'نقطة البيع ليست لتاجر شركتك' }); return;
      }
      // نقطة البيع تتصل بجهاز واحد — لا تُسند لمندوبَين
      const taken = await prisma.salesRep.findFirst({ where: { tenantId: tid, nearpayTid: terminalTid, id: { not: rep.id } }, select: { id: true } });
      if (taken) {
        res.status(409).json({ success: false, code: 'CARD_PAY_TERMINAL_TAKEN', message: 'نقطة البيع مسندة لمندوب آخر' }); return;
      }
    }
    const updated = await prisma.salesRep.update({ where: { id: rep.id }, data: { nearpayTid: terminalTid }, select: { id: true, name: true, nearpayTid: true } });
    res.json({ success: true, data: updated });
  } catch (e) { sendError(res, e, next); }
});

export default router;
