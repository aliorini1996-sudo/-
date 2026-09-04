import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, requireAccounting, tenantId } from '../middleware/auth';
import { scopedRecordWhere, canAccessRep, SHAPE_INVOICE_RECEIPT } from '../services/adminScope';
import { AuthRequest } from '../types';
import { paginate, paginationMeta, generateInvoiceNumber, generateReturnNumber, withNumberRetry } from '../utils/helpers';
import { getCountryTax, currencyDecimalsOf } from '../config/countries';
import { computeInvoiceTotals } from '../lib/invoiceCalc';
import { netFromInclusive } from '../lib/money';
import { computeStock } from './vanStock';
import { canAccessCustomer, redactCustomer } from '../services/customerScope';
import { buildInstallments, MAX_INSTALLMENTS } from '../services/installments';
import {
  postInvoiceEntries,
  postCashInvoiceEntries,
  reverseInvoiceEntries,
  reverseCashInvoiceEntries,
  postReturnEntries,
  reverseReturnEntries,
} from '../services/accounting';

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

    res.json({ success: true, data: invoices, pagination: paginationMeta(total, page, limit) });
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
      select: { defaultVatPct: true, countryCode: true, currency: true, einvoiceProvider: true },
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
        include: { items: true, customer: true, installments: { orderBy: { seq: 'asc' } } },
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
      if (inv.type === 'RETURN') {
        await reverseReturnEntries(tx as never, tid, inv.id, inv.customerId, Number(inv.total));
      } else if (inv.type === 'CASH') {
        await reverseCashInvoiceEntries(tx as never, tid, inv.id, inv.customerId, Number(inv.total));
      } else {
        await reverseInvoiceEntries(tx as never, tid, inv.id, inv.customerId, Number(inv.total));
      }
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

    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
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
