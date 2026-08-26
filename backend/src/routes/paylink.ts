import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireSuperAdmin, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { canAccessCustomer } from '../services/customerScope';
import { issueLink, publicLinkView, confirmLinkPayment, paylinkConfigured } from '../services/paylink';
import { settlementBalance, recordPayout } from '../services/settlement';

/**
 * مسارات «الدفع الإلكتروني» — ميزة اشتراك يفعّلها المالك لكل شركة (نمط ERP).
 *
 * ثلاث جبهات في ملف واحد:
 *  - عام: بيانات صفحة /pay/:token (بلا مصادقة — الرمز نفسه هو الإذن).
 *  - الشركة (مندوب/أدمن): إصدار رابط لفاتورة وقراءة روابطها.
 *  - المالك: أمانات الشركات والتوريد الأسبوعي.
 */
const router = Router();

// ═══ الصفحة العامة — قبل أي مصادقة ═══

const TOKEN_RE = /^[A-Za-z0-9_-]{20,50}$/;

router.get('/public/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;
    if (!TOKEN_RE.test(token)) { res.status(404).json({ success: false }); return; }
    const view = await publicLinkView(token);
    if (!view) { res.status(404).json({ success: false }); return; }
    res.json({ success: true, data: view });
  } catch (err) { next(err); }
});

/**
 * تحديث حالة الرابط من صفحة الدفع بعد العودة من ميسر (?done=1).
 * صفحة النجاح ليست دليلاً — التأكيد يجلب الحقيقة من ميسر بمفتاحنا، فلا يضر
 * استدعاؤه من متصفح غريب: أسوأ ما يفعله مهاجمٌ به تأكيدُ دفعةٍ حقيقية مبكراً.
 */
// خنق التأكيد العام: الرابط الواحد لا يسأل ميسر أكثر من مرة كل ٦ ثوان —
// نقطة عامة بلا مصادقة تستدعي API ميسر تصير مضخة طلبات نحو حسابنا بدونه
const lastRefreshAt = new Map<string, number>();

router.post('/public/:token/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;
    if (!TOKEN_RE.test(token)) { res.status(404).json({ success: false }); return; }
    const link = await prisma.customerPaymentLink.findUnique({ where: { token }, select: { id: true, status: true } });
    if (!link) { res.status(404).json({ success: false }); return; }
    if (link.status !== 'initiated') { res.json({ success: true, data: { state: link.status } }); return; }
    const last = lastRefreshAt.get(link.id) || 0;
    if (Date.now() - last < 6000) { res.json({ success: true, data: { state: 'initiated' } }); return; }
    lastRefreshAt.set(link.id, Date.now());
    const out = await confirmLinkPayment(link.id);
    res.json({ success: true, data: { state: out.state } });
  } catch (err) { next(err); }
});

// ═══ مسارات الشركة — مصادقة ثم بوابة الاشتراك (نمط ERP حرفياً) ═══

router.use(authenticate);

router.use(async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // مسارات المالك تمر من بوابتها الخاصة أدناه لا من بوابة الشركة
    if (req.path.startsWith('/owner/')) { next(); return; }
    const t = await prisma.tenant.findUnique({ where: { id: tenantId(req) }, select: { paylinkEnabled: true } });
    if (!t?.paylinkEnabled) {
      res.status(403).json({ success: false, code: 'PAYLINK_NOT_ALLOWED', message: 'ميزة الدفع الالكتروني غير مفعلة لاشتراك شركتك تواصل مع مزود الخدمة لتفعيلها' });
      return;
    }
    next();
  } catch (err) { next(err); }
});

const issueSchema = z.object({ invoiceId: z.string().uuid() });

/**
 * إصدار رابط دفع لفاتورة — المندوب من تطبيقه والأدمن من اللوحة.
 * القاعدة (قرار المالك): لا رابط بلا فاتورة وبكامل المتبقّي فقط.
 */
router.post('/issue', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!paylinkConfigured()) { res.status(503).json({ success: false, message: 'بوابة الدفع غير مهيأة' }); return; }
    const tid = tenantId(req);
    const { invoiceId } = issueSchema.parse(req.body);

    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId: tid },
      select: { id: true, customerId: true, salesRepId: true },
    });
    if (!invoice) { res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); return; }

    // عزل العملاء: مندوب لا يرى العميل لا يصدر رابطاً على فاتورته
    if (!(await canAccessCustomer(req, tid, invoice.customerId))) {
      res.status(403).json({ success: false, message: 'هذا العميل غير مسند لك' }); return;
    }

    const isRep = req.user!.role === 'SALES_REP';
    const out = await issueLink({
      tenantId: tid,
      invoiceId,
      // السند اللاحق يُنسب لمصدر الرابط إن كان مندوباً، وإلا لمندوب الفاتورة
      salesRepId: isRep ? req.user!.id : invoice.salesRepId ?? undefined,
      createdById: isRep ? undefined : req.user!.id,
    });
    if (!out.ok) { res.status(400).json({ success: false, message: out.message }); return; }
    res.json({ success: true, data: out.link, reused: out.reused ?? false });
  } catch (err) { next(err); }
});

/** روابط فاتورة — لعرض الحالة في ملف العميل */
router.get('/for-invoice/:invoiceId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.invoiceId, tenantId: tid },
      select: { customerId: true },
    });
    if (!invoice || !(await canAccessCustomer(req, tid, invoice.customerId))) {
      res.status(404).json({ success: false }); return;
    }
    const links = await prisma.customerPaymentLink.findMany({
      where: { tenantId: tid, invoiceId: req.params.invoiceId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, token: true, amount: true, status: true, paidAt: true, expiresAt: true, createdAt: true },
    });
    res.json({ success: true, data: links });
  } catch (err) { next(err); }
});

// ═══ المالك: أمانات الشركات والتوريد ═══

router.use('/owner', requireSuperAdmin);

/** أرصدة أمانات الشركات المفعلة — شاشة التوريد الأسبوعي */
router.get('/owner/settlements', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenants = await prisma.tenant.findMany({
      where: { paylinkEnabled: true },
      select: { id: true, name: true, paylinkFeePct: true, paylinkFeeFlat: true },
    });
    const rows = [];
    for (const t of tenants) {
      const [balance, collectedAgg, lastPayout] = await Promise.all([
        settlementBalance(t.id),
        prisma.settlementEntry.aggregate({ where: { tenantId: t.id, kind: 'COLLECTED' }, _sum: { amount: true }, _count: true }),
        prisma.payout.findFirst({ where: { tenantId: t.id }, orderBy: { createdAt: 'desc' }, select: { amount: true, createdAt: true } }),
      ]);
      rows.push({
        tenantId: t.id, name: t.name, feePct: t.paylinkFeePct, feeFlat: t.paylinkFeeFlat,
        balance,
        totalCollected: Number(collectedAgg._sum.amount ?? 0),
        payments: collectedAgg._count,
        lastPayout,
      });
    }
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

const payoutSchema = z.object({
  tenantId: z.string().uuid(),
  amount: z.number().positive(),
  bankReference: z.string().max(120).optional(),
  note: z.string().max(300).optional(),
});

/** توثيق توريد نُفذ بنكياً — النظام يسجل ولا يحول */
router.post('/owner/payouts', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = payoutSchema.parse(req.body);
    const out = await recordPayout({ tenantId: body.tenantId, amount: body.amount, bankReference: body.bankReference, note: body.note });
    if (!out.ok) { res.status(400).json({ success: false, message: out.message }); return; }
    res.status(201).json({ success: true, data: { payoutId: out.payoutId } });
  } catch (err) { next(err); }
});

/** كشف قيود شركة — تدقيق المالك قبل التوريد */
router.get('/owner/settlements/:tenantId/entries', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const entries = await prisma.settlementEntry.findMany({
      where: { tenantId: req.params.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    res.json({ success: true, data: entries });
  } catch (err) { next(err); }
});

export default router;
