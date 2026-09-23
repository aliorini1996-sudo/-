import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, requireAccounting, tenantId } from '../middleware/auth';
import { scopedRecordWhere, canAccessRep, SHAPE_INVOICE_RECEIPT } from '../services/adminScope';
import { AuthRequest } from '../types';
import { publishInvoicesChanged } from '../services/liveEvents';
import { paginate, paginationMeta, generateInvoiceNumber, generateReturnNumber, withNumberRetry } from '../utils/helpers';
import { getCountryTax, currencyDecimalsOf } from '../config/countries';
import { computeInvoiceTotals } from '../lib/invoiceCalc';
import { netFromInclusive } from '../lib/money';
import { computeStock } from './vanStock';
import { canAccessCustomer, redactCustomer } from '../services/customerScope';
import { buildInstallments, MAX_INSTALLMENTS } from '../services/installments';
// ZATCA المرحلة الثانية (Z5.2): فرعٌ واحد للإصدار، وحارس قدرات العميل على القراءات — المرحلة الأولى لا تمرّ بشيء منه
import { regimeCandidate } from '../compliance/zatca/regime';
import { ALLOCATION_ALLOWED_WHERE } from '../compliance/zatca/status';
import { ZatcaHttpError } from '../compliance/zatca/errors';
import { issuanceHttpError } from '../compliance/zatca/issue';
import {
  capsFromHeaders, capsGate, isPhase2Invoice, issuePhase2Invoice, phase2ReadBody, phase2ReplayBody, type Phase2IssuanceContext,
} from './invoicesZatca';
import { productionPhase2Deps } from './invoicesZatcaDeps';
import { withdrawPhase2Invoice } from '../services/invoiceVoid';
import { reissuePhase2Invoice } from '../services/invoiceReissue';
import { retryPhase2Document } from '../services/zatcaSubmit';
import {
  postInvoiceEntries,
  postCashInvoiceEntries,
  postReturnEntries,
} from '../services/accounting';
// عكس قيود فاتورة أُلغيت — نسخةٌ واحدة يتشاركها الإلغاء اليدويّ وإبطال المرحلة الثانية (Z5.4)
import { reverseInvoiceInTx } from '../services/invoiceVoid';

const router = Router();
router.use(authenticate);
// عزل «النظام المحاسبي»: هنا لا بعد حارس الصلاحية، لأنّ GET /open أدناه مُعرَّف قبله فيفلت منه.
router.use(requireAccounting);

/**
 * فواتير العميل الآجلة المفتوحة — للتوزيع الإلزاميّ لسند القبض عليها.
 *
 * لماذا مسارٌ مستقلّ ولا يكفي `GET /invoices?customerId=`: ذاك يفرض على المندوب
 * `salesRepId = معرّفه` (أعلاه) فلا يرى إلا فواتيره هو. وهو صوابٌ في شاشة تصفّح
 * الفواتير، وخطأٌ هنا: المندوب يحصّل من العميل **دَينه كلّه** لا حصّته منه،
 * والخادم عند إنشاء السند يوزّعه على كلّ فواتير العميل (`receipts.ts`) بلا نظرٍ
 * إلى مُصدرها. فكانت القائمة التي تحرس بها الواجهةُ الإلزامَ أضيق من القائمة
 * التي يوزّع عليها الخادم ⇒ يمرّ السند بتوزيعٍ ناقص، أو بلا توزيعٍ أصلاً حين
 * تكون فواتير العميل صادرةً عن مندوبٍ آخر — وهو ما يُبطل الإلزام في التطبيق.
 *
 * والترتيب `invoiceDate: 'asc'` مقصود: هو ترتيب FIFO نفسه الذي يُكمل به الخادمُ
 * التوزيعَ الناقص، فيتطابق ما يقترحه زرّ «التوزيع التلقائي على الأقدم» مع ما
 * يفعله الخادم فعلاً. (كان المسار العام يرتّب `createdAt: 'desc'` فيوزّع الزرّ
 * على **الأحدث** بينما يوزّع الخادم على الأقدم — وعدٌ في التسمية يخالف الفعل.)
 *
 * والحارس هنا هو حارس إنشاء السند نفسه — `canAccessCustomer` — فلا يصير هذا
 * المسار باباً يقرأ به مندوبٌ فواتير عميلٍ ليس من عملائه.
 *
 * وبوابة صلاحيته `canManageReceipts` لا `canManageInvoices`: هو يخدم إصدار
 * السند لا تصفّح الفواتير، وهما عمودان مستقلّان لكل مستخدم شركة. ولو بقي تحت
 * بوابة الفواتير لرُدّ بـ403 مستخدمٌ يملك حقّ السند دون الفواتير، فتختفي واجهة
 * التوزيع كلّها بصمت ويمرّ سنده بلا توزيع — أي أن حارس صلاحيةٍ خاطئ كان
 * سيُلغي الإلزام بدل أن يحميه. (والمندوب يمرّ من كلتا البوابتين بلا فحص.)
 */
router.get('/open', requireAdminPermission('canManageReceipts'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : '';
    if (!customerId) { res.status(400).json({ success: false, message: 'معرف العميل مطلوب' }); return; }
    if (!(await canAccessCustomer(req, tid, customerId))) {
      res.status(403).json({ success: false, message: 'لا تملك صلاحية الوصول لهذا العميل' }); return;
    }
    const invoices = await prisma.invoice.findMany({
      where: {
        tenantId: tid,
        // نطاق مستخدم الشركة يبقى مطبَّقاً؛ ولا يُقيَّد المندوب بمُصدر الفاتورة
        ...(await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT)),
        customerId,
        status: 'CONFIRMED',
        type: 'CREDIT',
        remainingAmt: { gt: 0.004 },
        // ZATCA المرحلة الثانية (F2): لا تُعرض للتحصيل فاتورةٌ لم تصر نهائية عند الهيئة — والشرط نفسه حرفياً في الخادم
        ...ALLOCATION_ALLOWED_WHERE,
      },
      orderBy: { invoiceDate: 'asc' },
      select: { id: true, number: true, remainingAmt: true, invoiceDate: true },
      take: 200,
    });
    res.json({ success: true, data: invoices });
  } catch (err) { next(err); }
});

// بقيّة مسارات الفواتير تبقى على صلاحية الفواتير
router.use(requireAdminPermission('canManageInvoices'));

const invoiceItemSchema = z.object({
  productId: z.string(),
  qty: z.number().positive(),
  unitPrice: z.number().min(0),
  discountPct: z.number().min(0).max(100).default(0),
  taxPct: z.number().min(0).max(100).optional(), // يُورَث من ضريبة دولة الشركة عند الغياب
});

/** صورة توقيع: PNG base64 كما تصدرها لوحة التوقيع، ≤٣٠٠ كيلوبايت */
const signaturePng = z.string().max(300_000, 'صورة التوقيع كبيرة')
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/, 'صورة التوقيع غير صالحة').optional();

const createInvoiceSchema = z.object({
  // تطبيق المندوب يرسل الاسعار شاملة الضريبة كما اعلنت للعميل — المحرك يشتق
  // الضريبة من الداخل فلا يدفع العميل قرشا فوق السعر المعلن بسبب تحويل وسيط
  pricesIncludeTax: z.boolean().optional().default(false),
  customerId: z.string().optional(),
  // العمل دون اتصال: بديل customerId حين يشير لعميل أُنشئ أوف‑لاين (يحلّه الخادم إلى id الحقيقي)
  customerClientRef: z.string().uuid().optional(),
  salesRepId: z.string().optional(),
  invoiceDate: z.string().optional(),
  deliveryDate: z.string().optional(), // تاريخ التسليم الاختياري (YYYY-MM-DD)
  // توقيع المستلم اليدويّ (PNG base64) — يُحفظ فقط إن فعّل المالك الميزة للشركة، ويُهمَل صامتاً
  // إن أُطفئت بين التوقيع والرفع: فاتورةٌ أوف-لاين لا تُرفض بسبب مرفقٍ اختياريّ
  recipientSignature: signaturePng,
  repSignature: signaturePng, // توقيع المندوب — بالقيود نفسها
  type: z.enum(['CASH', 'CREDIT', 'RETURN']).default('CREDIT'),
  // سبب الإرجاع (يُستخدم فقط عند type=RETURN): عادي/تالف/استبدال
  returnReason: z.enum(['NORMAL', 'DAMAGED', 'EXCHANGE']).optional(),
  // هل يعود المرتجع لمخزون السيارة؟ (اختياري — يُشتقّ من السبب إن غاب)
  returnToStock: z.boolean().optional(),
  dueDate: z.string().optional(),
  notes: z.string().optional(),
  discountPct: z.number().min(0).max(100).default(0),
  items: z.array(invoiceItemSchema).min(1),
  // العمل دون اتصال: مفتاح idempotency ولحظة الإنشاء على الجهاز (اختياريان — لا يؤثّران أونلاين)
  clientRef: z.string().uuid().optional(),
  clientCreatedAt: z.string().optional(),
  // ═══ خطة السداد ═══
  // `type` يبقى CASH|CREDIT|RETURN حرفياً: التقسيط بيعٌ آجل بجدول، لا نوع رابع.
  // انظر تعليق `paymentPlan` في المخطط لسبب المنع.
  paymentPlan: z.enum(['IMMEDIATE', 'INSTALLMENT']).optional(),
  installmentPlan: z.object({
    count: z.number().int().min(2).max(60),
    firstDueDate: z.string(),
    period: z.enum(['MONTHLY', 'SEMI_MONTHLY', 'WEEKLY']).default('MONTHLY'),
  }).optional(),
}).refine((d) => !!d.customerId || !!d.customerClientRef, {
  message: 'يجب تحديد العميل customerId أو customerClientRef',
}).superRefine((d, ctx) => {
  const wantsPlan = d.paymentPlan === 'INSTALLMENT';
  if (wantsPlan && !d.installmentPlan) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'جدولة الأقساط مطلوبة للبيع بالتقسيط' });
  }
  if (!wantsPlan && d.installmentPlan) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'جدولة الأقساط لا تُرسل إلا مع خطة التقسيط' });
  }
  // التقسيط ائتمان: لا يُجمع مع بيع نقديّ ولا مع مرتجع
  if (wantsPlan && d.type !== 'CREDIT') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'التقسيط بيع آجل — لا يُجمع مع نقدي ولا مرتجع' });
  }
});

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string | undefined;
    const status = req.query.status as string | undefined;
    const type = req.query.type as string | undefined;
    const salesRepId = req.query.salesRepId as string | undefined;
    const customerId = req.query.customerId as string | undefined;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const withItems = req.query.withItems === '1' || req.query.withItems === 'true'; // تضمين بنود الفاتورة (لكشوف المندوب)
    const isSalesRep = req.user?.role === 'SALES_REP';

    const where = {
      tenantId: tid,
      // نطاق مستخدم الشركة: لا تظهر فاتورة لعميل أو مندوب خارج نطاقه
      ...(await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT)),
      ...(isSalesRep && { salesRepId: req.user!.id }),
      ...(salesRepId && !isSalesRep && { salesRepId }),
      ...(customerId && { customerId }),
      ...(status && { status: status as 'DRAFT' | 'CONFIRMED' | 'CANCELLED' }),
      ...(type && { type: type as 'CASH' | 'CREDIT' | 'RETURN' }),
      ...(search && {
        OR: [
          { number: { contains: search } },
          { customer: { name: { contains: search } } },
        ],
      }),
      // فلترة التاريخ: تقبل «من» أو «إلى» منفردة، و«إلى» تشمل كامل ذلك اليوم
      ...((from || to) && {
        invoiceDate: {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lte: new Date(new Date(to).setHours(23, 59, 59, 999)) } : {}),
        },
      }),
    };

    const [total, invoices] = await Promise.all([
      prisma.invoice.count({ where }),
      prisma.invoice.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          salesRep: { select: { id: true, name: true } },
          _count: { select: { items: true } },
          ...(withItems && { items: { include: { product: { select: { name: true, unit: true } } } } }),
        },
        ...paginate(page, limit),
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    /* لقطة الـXML (einvoiceSnapshot) لا تُشحن في صفوف القائمة: تُقرأ في التفصيل وفي الإرسال للهيئة وحدهما.
     * هي كيلوبايتات لكل صفّ (البائع والمشتري وكل بند)، وتصدير اللوحة يطلب 5000 صفّ في نداء واحد — فكانت تضيف
     * ميغابايتات لا يقرؤها أحد على قاعدةٍ هي عنق الزجاجة. قيمتها null في المرحلة الأولى فلا شيء يتغيّر لها. */
    res.json({ success: true, data: invoices.map(({ einvoiceSnapshot, ...row }) => row), pagination: paginationMeta(total, page, limit) });
  } catch (err) { next(err); }
});

/**
 * ZATCA المرحلة الثانية (Z5.4): قراءة فاتورة بمفتاح المنع من التكرار (clientRef) — للحزمة التي أضاعت ردّ الرفع
 * فتسأل «ماذا صار لفاتورتي؟» بلا إعادة رفع. نطاقه نطاق إعادة الرفع نفسه، ولا ينادي الهيئة أبداً (قراءة محضة).
 * **مُعرَّف قبل `/:id`** وإلّا التقطه كمعرّف فاتورة اسمه by-client-ref.
 */
router.get('/by-client-ref/:clientRef', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const clientRef = req.params.clientRef;
    if (!clientRef) { res.status(400).json({ success: false, message: 'المرجع مطلوب' }); return; }
    // نطاق مستخدم الشركة كاملاً كما في GET /:id: العميل **والمندوب** معاً (adminScope: الجمع بـAND لا OR) —
    // وإلّا كشف مرجعُ فاتورةٍ مندوباً خارج النطاق لمن يعرفه. القيد الفريد (tenantId, clientRef) يبقى يخدم القراءة.
    const invoice = await prisma.invoice.findFirst({
      where: { tenantId: tid, clientRef, ...(await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT)) },
      include: { items: true, customer: true },
    });
    if (!invoice) { res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); return; }
    // النطاق يسبق الردّ (كإعادة الرفع): لا يُكشف عميلٌ خارج النطاق لمن يعرف مرجع فاتورته
    if (invoice.customerId && !(await canAccessCustomer(req, tid, invoice.customerId))) {
      res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); return;
    }
    if (req.user?.role === 'SALES_REP' && invoice.salesRepId !== req.user.id) {
      res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); return;
    }
    const p2 = isPhase2Invoice(invoice) ? await phase2ReadBody(invoice, capsFromHeaders(req.headers), productionPhase2Deps(), tid) : null;
    if (p2?.error) { res.status(p2.status).json(p2.error.body()); return; }
    if (p2) { res.json({ success: true, data: { ...invoice, einvoice: p2.einvoice } }); return; }
    res.json({ success: true, data: invoice });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, tenantId: tid, ...(await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT)) },
      include: {
        customer: true,
        salesRep: { select: { id: true, name: true, phone: true } },
        installments: { orderBy: { seq: 'asc' } },
        items: { include: { product: { select: { id: true, name: true, code: true, unit: true } } } },
        receiptItems: { include: { receipt: true } },
        signature: { select: { image: true, repImage: true, createdAt: true } },
      },
    });
    if (!invoice) { res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); return; }
    if (req.user?.role === 'SALES_REP' && invoice.salesRepId !== req.user.id) {
      res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); return;
    }
    // العزل: المندوب يبقى يرى فاتورته القديمة، لكن بيانات العميل الحيّة (رصيد/ائتمان/موقع)
    // تُحجب إن لم يعد العميل مُسنَداً له
    if (req.user?.role === 'SALES_REP' && invoice.customerId && !(await canAccessCustomer(req, tid, invoice.customerId))) {
      invoice.customer = redactCustomer(invoice.customer);
    }
    // ZATCA المرحلة الثانية (نقد الخطة 6): صفٌّ مختوم لا يُسلَّم لحزمة قديمة — تبني QR المرحلة الأولى بخمس وسوم من
    // إعدادات الشركة وتطبع «فاتورة ضريبية» غير مختومة (وقياسيةً لم تعتمدها الهيئة بعد). صفوف المرحلة الأولى: لا استعلام.
    const p2 = isPhase2Invoice(invoice) ? await phase2ReadBody(invoice, capsFromHeaders(req.headers), productionPhase2Deps(), tid) : null;
    if (p2?.error) { res.status(p2.status).json(p2.error.body()); return; }
    if (p2) { res.json({ success: true, data: { ...invoice, einvoice: p2.einvoice } }); return; }
    res.json({ success: true, data: invoice });
  } catch (err) { next(err); }
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = createInvoiceSchema.parse(req.body);

    // idempotency: إن سبق رفع هذه الفاتورة (نفس clientRef) نعيد القائمة بدل إنشاء مكرّرة.
    // يحمي من إعادة المحاولة والشبكة المتقطّعة في مسار العمل دون اتصال — قبل أي منطق أو قيد.
    if (body.clientRef) {
      const existing = await prisma.invoice.findUnique({
        where: { tenantId_clientRef: { tenantId: tid, clientRef: body.clientRef } },
        include: { items: true, customer: true },
      });
      if (existing) {
        // النطاق يسبق الـidempotency: وإلا كُشف عميل خارج النطاق (برصيده وحدّه الائتماني)
        // لمن يعرف clientRef فاتورته — فالمسار يُعيد سجلّ العميل كاملاً.
        if (existing.customerId && !(await canAccessCustomer(req, tid, existing.customerId))) {
          res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); return;
        }
        // ZATCA المرحلة الثانية (نقد الخطة 6): إعادة الرفع لا تُعيد صفّاً مختوماً لعميل بلا قدرات، وتُرفق إسقاط المستند لمن يفهمه.
        // وZ5.4: قياسيةٌ عالقة «بانتظار الاعتماد» حان موعد محاولتها تُجرَّب مرّة واحدة هنا — فإن جرت، الصفّ الذي بيدنا قديم.
        const p2 = isPhase2Invoice(existing) ? await phase2ReplayBody(existing, capsFromHeaders(req.headers), productionPhase2Deps(), tid) : null;
        if (p2) {
          const row = p2.reload
            ? (await prisma.invoice.findUnique({ where: { id: existing.id }, include: { items: true, customer: true } })) ?? existing
            : existing;
          // ردّ إعادة الرفع = ردّ الرفع الأوّل: مرفوضة ⇒ 422، معلّقة ⇒ 202، معتمدة ⇒ 200. والصفّ يُرفق مع الردود
          // المشتقّة من حالة المستند وحدها — لا مع حارس القدرات (صفٌّ مختوم لا يصل حزمةً لا تفهمه، نقد 6).
          if (p2.error) {
            const body = p2.error.body();
            if (p2.einvoice) body.data = { ...row, einvoice: p2.einvoice };
            res.status(p2.status).json(body); return;
          }
          res.status(200).json({ success: true, data: { ...row, einvoice: p2.einvoice }, idempotent: true }); return;
        }
        res.status(200).json({ success: true, data: existing, idempotent: true }); return;
      }
    }

    // حلّ تبعية العميل: إن أشارت الفاتورة لعميل أُنشئ أوف‑لاين (customerClientRef) نحلّه إلى id
    // الحقيقي. الترتيب في محرّك المزامنة يضمن رفع العميل قبل فاتورته، فالمرجع موجود هنا.
    let customerId = body.customerId;
    if (body.customerClientRef) {
      const ref = await prisma.customer.findFirst({
        where: { tenantId: tid, clientRef: body.customerClientRef },
        select: { id: true },
      });
      if (!ref) { res.status(400).json({ success: false, message: 'العميل المرجعي لم يرفع بعد أعد المزامنة' }); return; }
      customerId = ref.id;
    }
    if (!customerId) { res.status(400).json({ success: false, message: 'يجب تحديد العميل' }); return; }

    const salesRepId = req.user!.role === 'SALES_REP' ? req.user!.id : body.salesRepId;
    if (!salesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }

    // توقيع المستلم: ميزةٌ يفعّلها المالك — ولا توقيع على مرتجع (المستلم هناك المندوب لا العميل)
    const signatureOn = (!!body.recipientSignature || !!body.repSignature) && body.type !== 'RETURN'
      && (await prisma.tenant.findUnique({ where: { id: tid }, select: { invoiceSignatureEnabled: true } }))?.invoiceSignatureEnabled === true;
    const signatureImages = signatureOn
      ? { image: body.recipientSignature ?? null, repImage: body.repSignature ?? null }
      : null;

    const rep = await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    // نطاق المستخدم الإداري: لا يُنسِب فاتورة لمندوب لا يراه (كتابة عمياء تظهر في تقاريره)
    if (!(await canAccessRep(req, tid, salesRepId))) {
      res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return;
    }

    const customer = await prisma.customer.findFirst({ where: { id: customerId, tenantId: tid } });
    if (!customer) { res.status(404).json({ success: false, message: 'العميل غير موجود' }); return; }
    if (customer.status === 'BLOCKED') { res.status(400).json({ success: false, message: 'العميل محظور' }); return; }
    // عزل العملاء: يُمنع المندوب من الفوترة لعميل غير مُسنَد له (لا يُتجاوز العزل بتمرير معرّف)
    if (!(await canAccessCustomer(req, tid, customerId))) {
      res.status(403).json({ success: false, message: 'هذا العميل غير مسند لك' });
      return;
    }

    const productIds = [...new Set(body.items.map(i => i.productId))];
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, tenantId: tid, status: 'ACTIVE' },
      select: { id: true, name: true, basePrice: true, taxPct: true, damagedReturnToStock: true, priceTiers: { select: { price: true } } },
    });
    if (products.length !== productIds.length) { res.status(400).json({ success: false, message: 'أحد الأصناف غير موجود أو غير نشط' }); return; }

    if (req.user!.role === 'SALES_REP') {
      if (!rep.canCreateInvoice) { res.status(403).json({ success: false, message: 'لا تملك صلاحية إنشاء فاتورة' }); return; }
      if (body.type === 'CREDIT' && !rep.canSellOnCredit) { res.status(403).json({ success: false, message: 'لا تملك صلاحية البيع الآجل' }); return; }
      if (body.type === 'CASH' && !rep.canSellInCash) { res.status(403).json({ success: false, message: 'لا تملك صلاحية البيع النقدي' }); return; }
      // التقسيط فوق الآجل لا بديلاً عنه: يلزم الإذنان معاً
      if (body.paymentPlan === 'INSTALLMENT' && !rep.canSellOnInstallment) {
        res.status(403).json({ success: false, message: 'لا تملك صلاحية البيع بالتقسيط' }); return;
      }

      const cps = await prisma.customerPrice.findMany({
        where: { customerId: customerId, productId: { in: productIds } },
        select: { productId: true, price: true },
      });
      const cpMap = new Map(cps.map(c => [c.productId, c.price]));
      const isReturnDoc = body.type === 'RETURN';
      const maxD = rep.maxDiscountPct || 0;
      const TOL = 0.01;
      const fail = (msg: string) => { res.status(403).json({ success: false, message: msg }); };

      if (!isReturnDoc && body.discountPct > maxD + 1e-9) { fail(`لا تملك صلاحية منح خصم يتجاوز ${maxD}%`); return; }

      // المرتجع يعكس سعر بيع سابقا لا تسعيرا جديدا — حبسه على الحارس السعري يمنع
      // المندوب من تسجيل بضاعة راجعة اصلا، وهو اشد ضررا من بيع بسعر غير مصرح
      // (كما هو معفى اصلا من فحص مخزون السيارة ادناه)
      for (const it of body.items) {
        if (isReturnDoc) break;
        if (it.discountPct > maxD + 1e-9) { fail(`لا تملك صلاحية منح خصم يتجاوز ${maxD}% على الأصناف`); return; }
        const p = products.find(x => x.id === it.productId)!;
        const ref = cpMap.has(it.productId) ? cpMap.get(it.productId)! : p.basePrice;
        const minTier = p.priceTiers.length ? Math.min(...p.priceTiers.map(t => t.price)) : ref;
        const minAllowed = Math.min(ref, minTier);
        // المراجع (basePrice/سعر العميل/الشرائح) مخزنة **صافية قبل الضريبة**، بينما
        // تطبيق المندوب يرسل السعر **شاملا** كما اعلن للعميل — فنرد المرسل الى الاساس
        // الصافي قبل المقارنة، وإلا رفض الحارس مندوبا لم يغير السعر اصلا (1.15 مقابل 1.00)
        const refTaxPct = it.taxPct ?? p.taxPct ?? 0;
        const priceNet = body.pricesIncludeTax ? netFromInclusive(it.unitPrice, refTaxPct) : it.unitPrice;
        if (!rep.canChangePrice) {
          if (priceNet < minAllowed - TOL || priceNet > ref + TOL) { fail('لا تملك صلاحية تغيير سعر البيع'); return; }
        } else if (!rep.canSellBelowPrice && priceNet < minAllowed - TOL) {
          fail('لا تملك صلاحية البيع بأقل من السعر المحدد'); return;
        }
      }

      // فرض مخزون السيارة: من لا يملك «البيع بدون مخزون» لا يبيع أكثر من متبقّي سيارته
      if (rep.canSellWithoutStock === false && body.type !== 'RETURN') {
        const stock = await computeStock(tid, salesRepId);
        const remById = new Map(stock.map(s => [s.productId, s.remaining]));
        const wantById = new Map<string, number>();
        for (const it of body.items) wantById.set(it.productId, (wantById.get(it.productId) || 0) + it.qty);
        for (const [pid, want] of wantById) {
          const rem = remById.get(pid) ?? 0;
          if (want > rem + 1e-9) {
            const p = products.find(x => x.id === pid);
            fail(`الكمية المطلوبة من «${p?.name || 'الصنف'}» تتجاوز مخزون سيارتك المتاح (${Number(rem.toFixed(2))})`);
            return;
          }
        }
      }
    }

    // ضريبة وعملة دولة الشركة — تُطبَّق على البنود التي لم تُحدَّد ضريبتها، وتضبط خانات التقريب
    const company = await prisma.companySettings.findUnique({
      where: { tenantId: tid },
      // zatcaPhase2StartedAt: قرار النظام الضريبي (Z5.2) يُقرأ من هذا الصفّ المحمَّل أصلاً — صفر استعلامات للمرحلة الأولى
      select: { defaultVatPct: true, countryCode: true, currency: true, einvoiceProvider: true, zatcaPhase2StartedAt: true },
    });
    const companyVat = company?.defaultVatPct ?? 15;
    // الخانات من العملة الفعلية (تجاوز الدولار/اليورو يغلب خانات الدولة — كويتية بالدولار: خانتان لا ثلاث)
    const dec = currencyDecimalsOf(company?.currency ?? getCountryTax(company?.countryCode).currency);
    // مزوّد الفوترة الإلكترونية وحالتها المبدئية: ZATCA/none = جاهزة (QR محلي)؛ ETA/Peppol/TTN = بانتظار الإرسال الحكومي
    const einvoiceProvider = (company as { einvoiceProvider?: string } | null)?.einvoiceProvider || getCountryTax(company?.countryCode).provider;
    const einvoiceStatus = ['eta', 'peppol', 'ttn'].includes(einvoiceProvider) ? 'pending' : 'generated';

    // محرّك الحساب المشترك — نفس الوحدة التي يستخدمها تطبيق المندوب أوف-لاين، فتتطابق
    // الورقة المطبوعة مع سجلّ الخادم (lib/invoiceCalc.ts).
    const calc = computeInvoiceTotals(
      body.items.map(i => ({ qty: i.qty, unitPrice: i.unitPrice, discountPct: i.discountPct, taxPct: i.taxPct })),
      { companyVat, decimals: dec, invoiceDiscountPct: body.discountPct, pricesIncludeTax: body.pricesIncludeTax },
    );
    const { subtotal, discountAmt, taxAmt, total } = calc;
    // نُبقي معرّف الصنف بجانب نتائج الحساب (المحرّك نقيّ لا يعرف productId)
    const finalItems = body.items.map((src, idx) => ({ ...src, ...calc.items[idx] }));
    const isReturn = body.type === 'RETURN';
    const docDate = body.invoiceDate ? new Date(body.invoiceDate) : undefined;
    // تاريخ التسليم: اختياري — القيمة غير المفهومة تُهمل بصمت (عرض لا محاسبة)
    const deliveryDate = body.deliveryDate ? new Date(body.deliveryDate) : undefined;
    const deliveryOk = deliveryDate && !Number.isNaN(deliveryDate.getTime()) ? deliveryDate : undefined;
    const creditCheck = body.type === 'CREDIT' && Number(customer.balance) + total > Number(customer.creditLimit) && Number(customer.creditLimit) > 0;

    /**
     * جدول الأقساط يُبنى على **الخادم** من الإجمالي الذي حسبه المحرّك أعلاه.
     *
     * لا من إجماليٍّ قدّرته الواجهة: الضريبة وخانات العملة و`pricesIncludeTax`
     * كلّها تُحسم هنا، فجدولٌ مبنيّ على تقدير العميل قد لا يساوي مجموعه إجمال
     * الفاتورة. والواجهة تعرض معاينة، والخادم يكتب الحقيقة.
     */
    let installmentRows: { seq: number; dueDate: Date; amount: number }[] = [];
    if (body.paymentPlan === 'INSTALLMENT' && body.installmentPlan) {
      try {
        installmentRows = buildInstallments(total, {
          count: body.installmentPlan.count,
          startDate: body.installmentPlan.firstDueDate,
          period: body.installmentPlan.period,
        }, dec);
      } catch (e) {
        res.status(400).json({ success: false, message: (e as Error).message }); return;
      }
      // حارس رخيص على ثابتٍ غالٍ: لا تُولَد فاتورة تقسيط مجموع أقساطها ≠ إجمالها
      const unit = Math.pow(10, dec);
      const sum = installmentRows.reduce((s, r) => s + Math.round(r.amount * unit), 0);
      if (!installmentRows.length || sum !== Math.round(total * unit)) {
        res.status(400).json({ success: false, message: 'تعذر تقسيم إجمالي الفاتورة على الأقساط بالضبط' }); return;
      }
      if (installmentRows.length > MAX_INSTALLMENTS) {
        res.status(400).json({ success: false, message: `عدد الأقساط يتجاوز الحد المسموح (${MAX_INSTALLMENTS})` }); return;
      }
    }

    /* ═══ ZATCA المرحلة الثانية (Z5.2) — الفرع الوحيد ═══
     *
     * القرار نقيٌّ من صفّ الإعدادات المحمَّل أعلاه ومن البيئة (`regimeCandidate`): **المرحلة الأولى — وهي كلّ الشركات
     * اليوم — لا تدفع استعلاماً واحداً ولا تنفّذ سطراً واحداً ممّا بعده**، فيبقى ما تحت هذا الفرع كما هو حرفاً بحرف:
     * الترقيم والمعاملة وقيود الدفتر والبثّ اللحظيّ وردّ 201 بجسمه نفسه.
     *
     * وعودة `null` من الفرع تعني «تبيّن أنّ النظام مرحلة أولى فعلاً» (شركةٌ في قائمة البروفة وعلمُها مطفأ) — فيكمل
     * المسار القديم كما لو لم يكن الفرع. وكلّ ما عدا ذلك ردٌّ جاهز: 201/202 للإصدار، و426 لحزمة قديمة، و409 لإعادة
     * رفعٍ من قبل التفعيل، و422 لبيانات المشتري أو المبالغ، و503 لوحدة محجوبة.
     */
    if (regimeCandidate({
      tenantId: tid,
      settings: {
        countryCode: company?.countryCode ?? null,
        einvoiceProvider: company?.einvoiceProvider ?? null,
        zatcaPhase2StartedAt: company?.zatcaPhase2StartedAt ?? null,
        taxNumber: null,
      },
      env: process.env,
    }) !== 'phase1') {
      const phase2Ctx: Phase2IssuanceContext = {
        tenantId: tid,
        caps: capsFromHeaders(req.headers),
        body,
        customerId,
        customer,
        customerName: customer.name,
        customerBalance: Number(customer.balance),
        customerCreditLimit: Number(customer.creditLimit),
        salesRepId,
        companyVat,
        engine: calc,
        items: finalItems,
        installments: installmentRows,
        signatureImages,
        creditCheck,
        deliveryDate: deliveryOk,
        dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
      };
      const phase2 = await issuePhase2Invoice(phase2Ctx, productionPhase2Deps());
      if (phase2) { res.status(phase2.status).json(phase2.body); return; }
    }

    // الرقم يُولَّد داخل إعادة المحاولة: عند تصادم P2002 (طلبان متزامنان بنفس الرقم) يُعاد التوليد والإنشاء
    const invoice = await withNumberRetry(async () => {
    // البادئة تُشتقّ من تاريخ الفاتورة (docDate) لا وقت الرفع — يحفظ تسلسل الفترة للمستندات الأوف-لاين
    const number = isReturn ? await generateReturnNumber(tid, docDate) : await generateInvoiceNumber(tid, docDate);
    return prisma.$transaction(async tx => {
      const inv = await tx.invoice.create({
        data: {
          tenantId: tid,
          number,
          clientRef: body.clientRef,
          clientCreatedAt: body.clientCreatedAt ? new Date(body.clientCreatedAt) : undefined,
          customerId: customerId,
          salesRepId,
          type: body.type,
          ...(isReturn && {
            returnReason: body.returnReason || 'NORMAL',
            // العودة للمخزون: صريحة إن وُردت؛ وإلا للتالف تُشتقّ من سياسة الأصناف
            // (يعود فقط إن سمحت كل أصناف المرتجع)، ولغير التالف يعود افتراضاً.
            returnToStock: body.returnToStock ?? (
              body.returnReason === 'DAMAGED'
                ? products.length > 0 && products.every(p => p.damagedReturnToStock)
                : true
            ),
          }),
          ...(docDate && { invoiceDate: docDate }),
          ...(deliveryOk && { deliveryDate: deliveryOk }),
          // مع خطة أقساط: الاستحقاق هو آخر قسط (لحظة براءة الذمّة) لا ما أرسله العميل
          dueDate: installmentRows.length
            ? installmentRows[installmentRows.length - 1].dueDate
            : (body.dueDate ? new Date(body.dueDate) : undefined),
          ...(body.paymentPlan && { paymentPlan: body.paymentPlan }),
          ...(installmentRows.length && {
            installments: {
              create: installmentRows.map(r => ({
                tenantId: tid, seq: r.seq, dueDate: r.dueDate, amount: r.amount,
              })),
            },
          }),
          notes: body.notes,
          ...(signatureImages && { signature: { create: { tenantId: tid, ...signatureImages } } }),
          pricesIncludeTax: body.pricesIncludeTax,
          subtotal,
          discountPct: body.discountPct,
          discountAmt,
          taxAmt,
          total,
          paidAmt: isReturn ? 0 : (body.type === 'CASH' ? total : 0),
          remainingAmt: isReturn ? 0 : (body.type === 'CASH' ? 0 : total),
          einvoiceProvider,
          einvoiceStatus,
          items: {
            create: finalItems.map(i => ({
              productId: i.productId,
              qty: i.qty,
              unitPrice: i.unitPrice,
              discountPct: i.discountPct,
              discountAmt: i.discountAmt,
              taxPct: i.taxPct,
              taxAmt: i.taxAmt,
              lineTotal: i.lineTotal,
            })),
          },
        },
        include: { items: true, customer: true, installments: { orderBy: { seq: 'asc' } }, signature: { select: { image: true, repImage: true } } },
      });

      if (isReturn) {
        await postReturnEntries(tx as never, tid, inv.id, customerId, total, docDate);
      } else if (body.type === 'CASH') {
        await postCashInvoiceEntries(tx as never, tid, inv.id, customerId, total, docDate);
      } else {
        await postInvoiceEntries(tx as never, tid, inv.id, customerId, total, docDate);
        if (creditCheck) {
          await tx.notification.create({
            data: {
              tenantId: tid,
              type: 'CREDIT_LIMIT_EXCEEDED',
              title: 'تجاوز الحد الائتماني',
              body: `العميل ${customer.name} تجاوز حده الائتماني`,
              customerId: customerId,
              salesRepId,
              data: JSON.stringify({ invoiceId: inv.id, balance: Number(customer.balance) + total, limit: Number(customer.creditLimit) }),
            },
          });
        }
      }

      return inv;
    });
    });

    // فاتورة جديدة (ونقدية مدفوعة معها) تظهر في قوائم الشاشات المفتوحة لحظتها
    publishInvoicesChanged(tid);
    res.status(201).json({ success: true, data: invoice });
  } catch (err) {
    // سباق تزامن: رفعان متزامنان بنفس clientRef تجاوزا الفحص المبكر — الثاني يصطدم بالقيد.
    // نعيد الفاتورة القائمة بدل الفشل (idempotency تحت التزامن).
    const e = err as { code?: string; meta?: { target?: unknown } };
    if (e?.code === 'P2002' && String(e?.meta?.target ?? '').includes('clientRef') && req.body?.clientRef) {
      try {
        const tid2 = tenantId(req);
        const existing = await prisma.invoice.findUnique({
          where: { tenantId_clientRef: { tenantId: tid2, clientRef: req.body.clientRef } },
          include: { items: true, customer: true },
        });
        // نفس حارس النطاق في المسار المبكر: السباق لا يفتح باباً مغلقاً
        if (existing && existing.customerId && !(await canAccessCustomer(req, tid2, existing.customerId))) {
          res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); return;
        }
        // ZATCA المرحلة الثانية (نقد الخطة 6): السباق لا يفتح باباً مغلقاً هنا أيضاً — لا صفّ مختوم لعميل بلا قدرات
        const p2 = isPhase2Invoice(existing) ? await phase2ReadBody(existing, capsFromHeaders(req.headers), productionPhase2Deps(), tid2) : null;
        if (p2?.error) { res.status(p2.status).json(p2.error.body()); return; }
        if (p2 && existing) { res.status(200).json({ success: true, data: { ...existing, einvoice: p2.einvoice }, idempotent: true }); return; }
        if (existing) { res.status(200).json({ success: true, data: existing, idempotent: true }); return; }
      } catch { /* يسقط لمعالج الأخطاء */ }
    }
    next(err);
  }
});

router.patch('/:id/cancel', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, tenantId: tid, ...(await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT)) },
      include: { receiptItems: true },
    });
    if (!invoice) { res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); return; }
    if (invoice.status === 'CANCELLED') { res.status(400).json({ success: false, message: 'الفاتورة ملغاة مسبقا' }); return; }
    /* ZATCA المرحلة الثانية (مراجعة عدائية ٢): الإلغاء اليدويّ يعكس القيود ولا يمسّ zatca_documents إطلاقاً، فكان
     * المسحُ يواصل إرسال مستند فاتورةٍ عُكست قيودها — ضريبة مخرجات مُقرَّة على بيعٍ مُلغى بلا إشعار دائن. المخرجان
     * المحروسان وحدهما: السحب قبل أن تستلم الهيئة، والإشعار الدائن بعد الاعتماد. */
    if (invoice.zatcaPhase === 2) {
      const e = new ZatcaHttpError('ZATCA_CANCEL_NOT_ALLOWED', { reason: invoice.einvoiceStatus ?? 'UNKNOWN' });
      res.status(e.status).json(e.body()); return;
    }

    if (req.user?.role === 'SALES_REP') {
      if (invoice.salesRepId !== req.user.id) { res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); return; }
      const rep = await prisma.salesRep.findFirst({ where: { id: req.user.id, tenantId: tid }, select: { canCancelInvoice: true } });
      if (!rep?.canCancelInvoice) { res.status(403).json({ success: false, message: 'لا تملك صلاحية إلغاء الفواتير' }); return; }
    }

    if (invoice.type === 'CREDIT' && Number(invoice.paidAmt) > 0) {
      res.status(400).json({ success: false, message: 'لا يمكن إلغاء فاتورة آجلة تم تحصيل جزء منها' }); return;
    }
    if (invoice.receiptItems.length > 0) {
      res.status(400).json({ success: false, message: 'لا يمكن إلغاء فاتورة مرتبطة بسند قبض' }); return;
    }

    const updated = await prisma.$transaction(async tx => {
      const inv = await tx.invoice.update({ where: { id: req.params.id }, data: { status: 'CANCELLED' } });
      // نسخةٌ واحدة من فرع العكس يتشاركها الإلغاء اليدويّ وإبطالُ المرحلة الثانية (Z5.4) — والوضع 'CANCEL' هو
      // السلوك القديم حرفاً بحرف (مرتجع ⇒ عكس المرتجع، نقدية ⇒ عكس شقّيها، وإلا عكس الآجلة)
      await reverseInvoiceInTx(
        tx as never,
        { id: inv.id, tenantId: tid, type: inv.type, customerId: inv.customerId, total: Number(inv.total) },
        'CANCEL',
      );
      await tx.notification.create({
        data: {
          tenantId: tid,
          type: 'INVOICE_CANCELLED',
          title: 'إلغاء فاتورة',
          body: `تم إلغاء الفاتورة رقم ${inv.number}`,
          salesRepId: inv.salesRepId,
          customerId: inv.customerId,
          data: JSON.stringify({ invoiceId: inv.id }),
        },
      });
      return inv;
    });

    // فاتورة ملغاة لا تُدفع: نميت روابط دفعها الحية ونلغي فواتير ميسر نفسها —
    // كان الرابط يبقى قابلا للدفع بعد الإلغاء. خارج المعاملة عمدا (نداء شبكي)
    void import('../services/paylink')
      .then(m => m.expireStaleLinks(tid, updated.id))
      .catch(e => console.error('invoice cancel: expire links failed:', (e as Error).message));

    publishInvoicesChanged(tid);
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

// ═══ ZATCA المرحلة الثانية (Z5.4): إجراءان إداريّان على المستند الضريبي ═══

/** يقرأ صفّ الفاتورة داخل نطاق المستخدم (لا يُكشف ما خارجه، ولا يُفعَل به شيء). */
async function scopedInvoiceId(req: AuthRequest, tid: string): Promise<string | null> {
  const row = await prisma.invoice.findFirst({
    where: { id: req.params.id, tenantId: tid, ...(await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT)) },
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * سحب فاتورة ضريبية قياسية عالقة «بانتظار الاعتماد» (نقد 11): مخرجٌ وحيد حين يرفض العميل البضاعة ولا الهيئة حسمت.
 * لا يمرّ إلا بإثبات أنّ الهيئة **لم تستلم** المستند (سجلّ الطلبات شاهده) — والسحب بعد وصوله مخالفة، فيُردّ 409.
 */
router.post('/:id/einvoice/withdraw', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const id = await scopedInvoiceId(req, tid);
    if (!id) { res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); return; }
    const r = await withdrawPhase2Invoice({ tenantId: tid, invoiceId: id });
    if (!r.ok) {
      const e = new ZatcaHttpError('ZATCA_WITHDRAW_NOT_ALLOWED', {
        messageAr: r.decision.ok ? undefined : r.decision.messageAr,
        reason: r.decision.ok ? 'STATE_CHANGED' : r.decision.refusal,
      });
      res.status(e.status).json(e.body()); return;
    }
    res.json({
      success: true,
      data: { id, number: r.outcome?.number ?? null, status: 'CANCELLED', einvoiceStatus: 'withdrawn', proof: r.decision.ok ? r.decision.proof : null },
    });
  } catch (err) { next(err); }
});

/**
 * إعادة إرسال يدوية (مدير الشركة) — مخرج المستند المحجوب (401 أو عطل إعداد) بعد إصلاح سببه: البايتات نفسها تُعاد
 * إلى الطابور وتُرسل الآن. بلا هذا المسار كان الحجب يعني فوات مهلة الإبلاغ على القياسية التي لا استرداد تلقائيّ لها.
 */
const RETRY_REFUSAL_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  NO_DOCUMENT: 'لا يوجد مستند ضريبي لهذه الفاتورة',
  DOCUMENT_FINAL: 'حسمت الهيئة هذا المستند — لا إعادة إرسال',
  IN_FLIGHT: 'المستند قيد الإرسال إلى الهيئة الآن — أعد المحاولة بعد دقيقة',
  PAUSED: 'الإرسال إلى الهيئة موقوف مؤقّتاً — أعد المحاولة لاحقاً',
  NOT_RETRYABLE: 'تعذّرت إعادة إرسال المستند الآن — أعد المحاولة',
});

router.post('/:id/einvoice/retry', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const id = await scopedInvoiceId(req, tid);
    if (!id) { res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); return; }
    const r = await retryPhase2Document({ tenantId: tid, invoiceId: id });
    if (!r.ok) {
      const e = new ZatcaHttpError('ZATCA_RETRY_NOT_ALLOWED', {
        messageAr: RETRY_REFUSAL_MESSAGES[r.refusal ?? 'NOT_RETRYABLE'],
        reason: r.refusal ?? 'NOT_RETRYABLE',
      });
      res.status(e.status).json(e.body()); return;
    }
    // 202 حين انقضت نافذة الانتظار والإرسال يكمل في الخلفية (المسح شبكة الأمان) — لا «تمّ» عن شيء لم يُحسم بعد
    res.status(r.pending === true ? 202 : 200)
      .json({ success: true, data: { id, documentId: r.documentId, documentStatus: r.documentStatus, einvoiceStatus: r.mirror, pending: r.pending === true } });
  } catch (err) { next(err); }
});

/**
 * إعادة إصدار مستند **مبسّط** رفضته الهيئة (design Z5.9): الورقة عند المشتري فعلاً فلا إبطال — مستندٌ جديد بالرقم
 * والتاريخ نفسيهما ومحاولة جديدة. القياسية المرفوضة لا تمرّ من هنا: أُبطلت تلقائياً وتُصدَر فاتورةٌ جديدة.
 */
router.post('/:id/einvoice/reissue', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // نقد 6: الرمز الجديد لا يصل حزمةً لا تفهم المرحلة الثانية (تبني QR المرحلة الأولى وتطبعه)
    const gate = capsGate(capsFromHeaders(req.headers));
    if (gate) { res.status(gate.status).json(gate.body()); return; }
    const id = await scopedInvoiceId(req, tid);
    if (!id) { res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); return; }
    const r = await reissuePhase2Invoice({ tenantId: tid, invoiceId: id });
    if (!r.ok || !r.result) {
      const e = new ZatcaHttpError('ZATCA_REISSUE_NOT_ALLOWED', {
        messageAr: r.decision.ok ? undefined : r.decision.messageAr,
        reason: r.decision.ok ? 'UNKNOWN' : r.decision.refusal,
      });
      res.status(e.status).json(e.body()); return;
    }
    res.json({
      success: true,
      data: {
        id,
        attemptNo: r.result.attemptNo,
        documentStatus: r.documentStatus,
        einvoiceStatus: r.result.mirror.einvoiceStatus,
        einvoiceQr: r.result.mirror.einvoiceQr,
        icv: r.result.icv,
        uuid: r.result.uuid,
        reportDeadline: r.result.reportDeadline ? r.result.reportDeadline.toISOString() : null,
        warnings: r.result.warnings,
      },
    });
  } catch (err) {
    const e = issuanceHttpError(err);
    if (e) { res.status(e.status).json(e.body()); return; }
    next(err);
  }
});

// تحكّم الأدمن: هل يعود هذا المرتجع لمخزون السيارة؟ (يغيّر حساب المخزون فوراً — للمرتجعات فقط)
router.patch('/:id/restock', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { returnToStock } = z.object({ returnToStock: z.boolean() }).parse(req.body);
    const invoice = await prisma.invoice.findFirst({ where: { id: req.params.id, tenantId: tid, ...(await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT)) }, select: { id: true, type: true } });
    if (!invoice) { res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); return; }
    if (invoice.type !== 'RETURN') { res.status(400).json({ success: false, message: 'هذا الإجراء للمرتجعات فقط' }); return; }
    const updated = await prisma.invoice.update({ where: { id: req.params.id }, data: { returnToStock } });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

export default router;
