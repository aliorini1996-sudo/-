import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { paginate, paginationMeta, generateInvoiceNumber, generateReturnNumber, roundDecimal } from '../utils/helpers';
import { postInvoiceEntries, reverseInvoiceEntries, postReturnEntries, reverseReturnEntries } from '../services/accounting';

const router = Router();
router.use(authenticate);

const invoiceItemSchema = z.object({
  productId: z.string(),
  qty: z.number().positive(),
  unitPrice: z.number().min(0),
  discountPct: z.number().min(0).max(100).default(0),
  taxPct: z.number().min(0).max(100).default(15),
});

const createInvoiceSchema = z.object({
  customerId: z.string(),
  salesRepId: z.string().optional(), // يحدّده الأدمن؛ المندوب يُستخدم معرّفه تلقائياً
  invoiceDate: z.string().optional(), // يسمح للأدمن بإصدار فاتورة بتاريخ قديم
  type: z.enum(['CASH', 'CREDIT', 'RETURN']).default('CREDIT'),
  dueDate: z.string().optional(),
  notes: z.string().optional(),
  discountPct: z.number().min(0).max(100).default(0),
  items: z.array(invoiceItemSchema).min(1),
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

    const isSalesRep = req.user?.role === 'SALES_REP';

    const where = {
      tenantId: tid,
      ...(isSalesRep && { salesRepId: req.user!.id }),
      ...(salesRepId && !isSalesRep && { salesRepId }),
      ...(customerId && { customerId }),
      ...(status && { status: status as 'DRAFT' | 'CONFIRMED' | 'CANCELLED' }),
      ...(type && { type: type as 'CASH' | 'CREDIT' }),
      ...(search && {
        OR: [
          { number: { contains: search } },
          { customer: { name: { contains: search } } },
        ],
      }),
      ...(from && to && { invoiceDate: { gte: new Date(from), lte: new Date(to) } }),
    };

    const [total, invoices] = await Promise.all([
      prisma.invoice.count({ where }),
      prisma.invoice.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          salesRep: { select: { id: true, name: true } },
          _count: { select: { items: true } },
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
      where: { id: req.params.id, tenantId: tid },
      include: {
        customer: true,
        salesRep: { select: { id: true, name: true, phone: true } },
        items: { include: { product: { select: { id: true, name: true, code: true, unit: true } } } },
        receiptItems: { include: { receipt: true } },
      },
    });
    if (!invoice) { res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); return; }
    // المندوب يرى فواتيره فقط
    if (req.user?.role === 'SALES_REP' && invoice.salesRepId !== req.user.id) {
      res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); return;
    }
    res.json({ success: true, data: invoice });
  } catch (err) { next(err); }
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = createInvoiceSchema.parse(req.body);
    // المندوب يستخدم معرّفه؛ الأدمن يجب أن يحدّد مندوباً (الفاتورة تُنسب لمندوب)
    const salesRepId = req.user!.role === 'SALES_REP' ? req.user!.id : body.salesRepId;
    if (!salesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }
    const rep = await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }

    const customer = await prisma.customer.findFirst({ where: { id: body.customerId, tenantId: tid } });
    if (!customer) { res.status(404).json({ success: false, message: 'العميل غير موجود' }); return; }

    // التحقق أن كل الأصناف تخص الشركة + جلب الأسعار المرجعية لفرض صلاحيات التسعير
    const productIds = [...new Set(body.items.map(i => i.productId))];
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, tenantId: tid },
      select: { id: true, basePrice: true, priceTiers: { select: { price: true } } },
    });
    if (products.length !== productIds.length) { res.status(400).json({ success: false, message: 'أحد الأصناف غير موجود' }); return; }

    // فرض صلاحيات الخصم والتسعير على المندوب (الأدمن غير مقيّد) — حارس أمني خلف الواجهة
    if (req.user!.role === 'SALES_REP') {
      const cps = await prisma.customerPrice.findMany({
        where: { customerId: body.customerId, productId: { in: productIds } },
        select: { productId: true, price: true },
      });
      const cpMap = new Map(cps.map(c => [c.productId, c.price]));
      const maxD = rep.maxDiscountPct || 0;
      const TOL = 0.01; // تسامح تقريب بسيط
      const fail = (msg: string) => { res.status(403).json({ success: false, message: msg }); };

      // حد الخصم — على مستوى الفاتورة وعلى مستوى كل صنف
      if (body.discountPct > maxD + 1e-9) { fail(`لا تملك صلاحية منح خصم يتجاوز ${maxD}%`); return; }

      for (const it of body.items) {
        if (it.discountPct > maxD + 1e-9) { fail(`لا تملك صلاحية منح خصم يتجاوز ${maxD}% على الأصناف`); return; }
        const p = products.find(x => x.id === it.productId)!;
        const ref = cpMap.has(it.productId) ? cpMap.get(it.productId)! : p.basePrice; // السعر الرسمي للعميل
        const minTier = p.priceTiers.length ? Math.min(...p.priceTiers.map(t => t.price)) : ref;
        const minAllowed = Math.min(ref, minTier); // أدنى سعر رسمي مسموح
        if (!rep.canChangePrice) {
          // لا يملك تغيير السعر: يجب أن يبقى ضمن الأسعار الرسمية للصنف
          if (it.unitPrice < minAllowed - TOL || it.unitPrice > ref + TOL) { fail('لا تملك صلاحية تغيير سعر البيع'); return; }
        } else if (!rep.canSellBelowPrice && it.unitPrice < minAllowed - TOL) {
          // يملك التغيير لكن لا يملك البيع بأقل من السعر
          fail('لا تملك صلاحية البيع بأقل من السعر المحدّد'); return;
        }
      }
    }

    let subtotal = 0;
    const items = body.items.map(item => {
      const lineBase = roundDecimal(item.qty * item.unitPrice);
      const lineDiscount = roundDecimal(lineBase * item.discountPct / 100);
      const lineAfterDiscount = lineBase - lineDiscount;
      const lineTax = roundDecimal(lineAfterDiscount * item.taxPct / 100);
      const lineTotal = lineAfterDiscount + lineTax;
      subtotal += lineBase;
      return { ...item, discountAmt: lineDiscount, taxAmt: lineTax, lineTotal };
    });

    const discountAmt = roundDecimal(subtotal * body.discountPct / 100);
    const taxableSubtotal = subtotal - discountAmt;

    let taxAmt = 0;
    const finalItems = items.map(item => { taxAmt += item.taxAmt; return item; });

    const total = roundDecimal(taxableSubtotal + taxAmt);
    const isReturn = body.type === 'RETURN';
    const number = isReturn ? await generateReturnNumber(tid) : await generateInvoiceNumber(tid);
    const docDate = body.invoiceDate ? new Date(body.invoiceDate) : undefined;

    const creditCheck = !isReturn && Number(customer.balance) + total > Number(customer.creditLimit) && Number(customer.creditLimit) > 0;

    const invoice = await prisma.$transaction(async tx => {
      const inv = await tx.invoice.create({
        data: {
          tenantId: tid,
          number,
          customerId: body.customerId,
          salesRepId,
          type: body.type,
          ...(docDate && { invoiceDate: docDate }),
          dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
          notes: body.notes,
          subtotal,
          discountPct: body.discountPct,
          discountAmt,
          taxAmt,
          total,
          paidAmt: isReturn ? 0 : (body.type === 'CASH' ? total : 0),
          remainingAmt: isReturn ? 0 : (body.type === 'CASH' ? 0 : total),
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
        include: { items: true, customer: true },
      });

      if (isReturn) {
        await postReturnEntries(tx as never, tid, inv.id, body.customerId, total, docDate);
      } else {
        await postInvoiceEntries(tx as never, tid, inv.id, body.customerId, total, docDate);
        if (creditCheck) {
          await tx.notification.create({
            data: {
              tenantId: tid,
              type: 'CREDIT_LIMIT_EXCEEDED',
              title: 'تجاوز الحد الائتماني',
              body: `العميل ${customer.name} تجاوز حده الائتماني`,
              customerId: body.customerId,
              salesRepId,
              data: JSON.stringify({ invoiceId: inv.id, balance: Number(customer.balance) + total, limit: Number(customer.creditLimit) }),
            },
          });
        }
      }

      return inv;
    });

    res.status(201).json({ success: true, data: invoice });
  } catch (err) { next(err); }
});

router.patch('/:id/cancel', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const invoice = await prisma.invoice.findFirst({ where: { id: req.params.id, tenantId: tid } });
    if (!invoice) { res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); return; }
    if (invoice.status === 'CANCELLED') { res.status(400).json({ success: false, message: 'الفاتورة ملغاة مسبقاً' }); return; }
    if (Number(invoice.paidAmt) > 0) { res.status(400).json({ success: false, message: 'لا يمكن إلغاء فاتورة تم تحصيل جزء منها' }); return; }

    const updated = await prisma.$transaction(async tx => {
      const inv = await tx.invoice.update({ where: { id: req.params.id }, data: { status: 'CANCELLED' } });
      if (inv.type === 'RETURN') {
        await reverseReturnEntries(tx as never, tid, inv.id, inv.customerId, Number(inv.total));
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

    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

export default router;
