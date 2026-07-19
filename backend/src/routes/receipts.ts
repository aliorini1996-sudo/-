import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { paginate, paginationMeta, generateReceiptNumber, withNumberRetry } from '../utils/helpers';
import { postReceiptEntries, reverseReceiptEntries } from '../services/accounting';

const router = Router();
router.use(authenticate);
router.use(requireAdminPermission('canManageReceipts'));

const receiptSchema = z.object({
  customerId: z.string().optional(),
  customerClientRef: z.string().uuid().optional(), // بديل للعميل المُنشأ أوف‑لاين (M5)
  salesRepId: z.string().optional(),
  receiptDate: z.string().optional(),
  amount: z.number().positive(),
  paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE']).default('CASH'),
  chequeNumber: z.string().optional(),
  bankName: z.string().optional(),
  notes: z.string().optional(),
  invoiceAllocations: z.array(z.object({
    invoiceId: z.string(),
    amount: z.number().positive(),
  })).optional(),
  // العمل دون اتصال: idempotency + لحظة الإنشاء على الجهاز (اختياريان)
  clientRef: z.string().uuid().optional(),
  clientCreatedAt: z.string().optional(),
}).refine((d) => !!d.customerId || !!d.customerClientRef, {
  message: 'يجب تحديد العميل (customerId أو customerClientRef)',
});

function groupAllocations(allocations: { invoiceId: string; amount: number }[] = []) {
  const grouped = new Map<string, number>();
  for (const alloc of allocations) {
    grouped.set(alloc.invoiceId, (grouped.get(alloc.invoiceId) || 0) + alloc.amount);
  }
  return [...grouped.entries()].map(([invoiceId, amount]) => ({ invoiceId, amount }));
}

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
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
      // فلترة التاريخ: تقبل «من» أو «إلى» منفردة، و«إلى» تشمل كامل ذلك اليوم
      ...((from || to) && {
        receiptDate: {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lte: new Date(new Date(to).setHours(23, 59, 59, 999)) } : {}),
        },
      }),
      status: 'ACTIVE' as const,
    };

    const [total, receipts] = await Promise.all([
      prisma.receipt.count({ where }),
      prisma.receipt.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true } },
          salesRep: { select: { id: true, name: true } },
          invoiceItems: { include: { invoice: { select: { number: true } } } },
        },
        ...paginate(page, limit),
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    res.json({ success: true, data: receipts, pagination: paginationMeta(total, page, limit) });
  } catch (err) { next(err); }
});

// رصيد التحصيل المتراكم لدى المندوب = مجموع سنداته النشطة − مجموع ما استلمه الأدمن منه.
// متاح للمندوب (يخصّ نفسه) وللإدارة (تمرّر salesRepId). لا يُصفَّر يوميًا — ينقص فقط بتسجيل استلام.
router.get('/collection-balance', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const isSalesRep = req.user?.role === 'SALES_REP';
    const repId = isSalesRep ? req.user!.id : (req.query.salesRepId as string | undefined);
    if (!repId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }
    // الميزة اختيارية لكل مندوب — إن لم يفعّلها الأدمن للمندوب لا تُعرض له
    if (isSalesRep) {
      const rep = await prisma.salesRep.findFirst({ where: { id: repId, tenantId: tid }, select: { showCollectionBalance: true } });
      if (!rep?.showCollectionBalance) { res.json({ success: true, data: { enabled: false } }); return; }
    }
    const [collected, settled] = await Promise.all([
      prisma.receipt.aggregate({ where: { tenantId: tid, salesRepId: repId, status: 'ACTIVE' }, _sum: { amount: true } }),
      prisma.repSettlement.aggregate({ where: { tenantId: tid, salesRepId: repId }, _sum: { amount: true } }),
    ]);
    const c = collected._sum.amount ?? 0;
    const s = settled._sum.amount ?? 0;
    res.json({ success: true, data: { enabled: true, collected: c, settled: s, outstanding: c - s } });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const receipt = await prisma.receipt.findFirst({
      where: { id: req.params.id, tenantId: tid },
      include: {
        customer: true,
        salesRep: { select: { id: true, name: true, phone: true } },
        invoiceItems: { include: { invoice: true } },
      },
    });
    if (!receipt) { res.status(404).json({ success: false, message: 'السند غير موجود' }); return; }
    if (req.user?.role === 'SALES_REP' && receipt.salesRepId !== req.user.id) {
      res.status(404).json({ success: false, message: 'السند غير موجود' }); return;
    }
    res.json({ success: true, data: receipt });
  } catch (err) { next(err); }
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = receiptSchema.parse(req.body);

    // idempotency: سند سبق رفعه (نفس clientRef) يُعاد بدل إنشاء مكرّر — قبل أي منطق
    if (body.clientRef) {
      const existing = await prisma.receipt.findUnique({
        where: { tenantId_clientRef: { tenantId: tid, clientRef: body.clientRef } },
      });
      if (existing) { res.status(200).json({ success: true, data: existing, idempotent: true }); return; }
    }

    // حلّ تبعية العميل المُنشأ أوف‑لاين (customerClientRef → id الحقيقي)
    let customerId = body.customerId;
    if (body.customerClientRef) {
      const ref = await prisma.customer.findFirst({
        where: { tenantId: tid, clientRef: body.customerClientRef },
        select: { id: true },
      });
      if (!ref) { res.status(400).json({ success: false, message: 'العميل المرجعي لم يُرفع بعد — أعِد المزامنة' }); return; }
      customerId = ref.id;
    }
    if (!customerId) { res.status(400).json({ success: false, message: 'يجب تحديد العميل' }); return; }

    const salesRepId = req.user!.role === 'SALES_REP' ? req.user!.id : body.salesRepId;
    if (!salesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }

    const rep = await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    if (req.user?.role === 'SALES_REP' && !rep.canCreateReceipt) {
      res.status(403).json({ success: false, message: 'لا تملك صلاحية إصدار سند قبض' }); return;
    }

    const customer = await prisma.customer.findFirst({ where: { id: customerId, tenantId: tid } });
    if (!customer) { res.status(404).json({ success: false, message: 'العميل غير موجود' }); return; }

    const allocations = groupAllocations((body.invoiceAllocations ?? []) as { invoiceId: string; amount: number }[]);
    const allocatedTotal = allocations.reduce((sum, item) => sum + item.amount, 0);
    if (allocatedTotal > body.amount + 0.001) {
      res.status(400).json({ success: false, message: 'مجموع تخصيص الفواتير أكبر من مبلغ السند' }); return;
    }

    const docDate = body.receiptDate ? new Date(body.receiptDate) : undefined;

    // الرقم يُولَّد داخل إعادة المحاولة: عند تصادم P2002 (سندان متزامنان بنفس الرقم) يُعاد التوليد والإنشاء
    const receipt = await withNumberRetry(async () => {
    const number = await generateReceiptNumber(tid, docDate); // البادئة من تاريخ السند لا وقت الرفع
    return prisma.$transaction(async tx => {
      if (allocations.length) {
        const invoices = await tx.invoice.findMany({
          where: {
            id: { in: allocations.map(a => a.invoiceId) },
            tenantId: tid,
            customerId: customerId,
            status: 'CONFIRMED',
            type: 'CREDIT',
          },
          select: { id: true, remainingAmt: true },
        });
        if (invoices.length !== allocations.length) throw new Error('توجد فاتورة غير صالحة في التخصيص');

        const remainingById = new Map(invoices.map(inv => [inv.id, Number(inv.remainingAmt)]));
        for (const alloc of allocations) {
          const remaining = remainingById.get(alloc.invoiceId) ?? 0;
          if (alloc.amount > remaining + 0.001) throw new Error('مبلغ التخصيص أكبر من المتبقي على إحدى الفواتير');
        }
      }

      const rcp = await tx.receipt.create({
        data: {
          tenantId: tid,
          number,
          clientRef: body.clientRef,
          clientCreatedAt: body.clientCreatedAt ? new Date(body.clientCreatedAt) : undefined,
          customerId: customerId,
          salesRepId,
          ...(docDate && { receiptDate: docDate }),
          amount: body.amount,
          paymentMethod: body.paymentMethod,
          chequeNumber: body.chequeNumber,
          bankName: body.bankName,
          notes: body.notes,
        },
      });

      if (allocations.length) {
        await tx.receiptInvoice.createMany({
          data: allocations.map(a => ({ receiptId: rcp.id, invoiceId: a.invoiceId, amount: a.amount })),
        });

        for (const alloc of allocations) {
          await tx.invoice.update({
            where: { id: alloc.invoiceId },
            data: { paidAmt: { increment: alloc.amount }, remainingAmt: { decrement: alloc.amount } },
          });
        }
      }

      await postReceiptEntries(tx as never, tid, rcp.id, customerId, body.amount, docDate);
      return rcp;
    });
    });

    res.status(201).json({ success: true, data: receipt });
  } catch (err) {
    // سباق تزامن: رفعان متزامنان بنفس clientRef — نعيد السند القائم بدل الفشل
    const e = err as { code?: string; meta?: { target?: unknown } };
    if (e?.code === 'P2002' && String(e?.meta?.target ?? '').includes('clientRef') && req.body?.clientRef) {
      try {
        const existing = await prisma.receipt.findUnique({
          where: { tenantId_clientRef: { tenantId: tenantId(req), clientRef: req.body.clientRef } },
        });
        if (existing) { res.status(200).json({ success: true, data: existing, idempotent: true }); return; }
      } catch { /* يسقط لمعالج الأخطاء */ }
    }
    next(err);
  }
});

router.patch('/:id/cancel', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const receipt = await prisma.receipt.findFirst({
      where: { id: req.params.id, tenantId: tid },
      include: { invoiceItems: true },
    });
    if (!receipt) { res.status(404).json({ success: false, message: 'السند غير موجود' }); return; }
    if (receipt.status === 'CANCELLED') { res.status(400).json({ success: false, message: 'السند ملغى مسبقاً' }); return; }

    if (req.user?.role === 'SALES_REP') {
      if (receipt.salesRepId !== req.user.id) { res.status(404).json({ success: false, message: 'السند غير موجود' }); return; }
      const rep = await prisma.salesRep.findFirst({ where: { id: req.user.id, tenantId: tid }, select: { canCancelReceipt: true } });
      if (!rep?.canCancelReceipt) { res.status(403).json({ success: false, message: 'لا تملك صلاحية إلغاء سند قبض' }); return; }
    }

    const updated = await prisma.$transaction(async tx => {
      const rcp = await tx.receipt.update({ where: { id: req.params.id }, data: { status: 'CANCELLED' } });

      for (const item of receipt.invoiceItems) {
        await tx.invoice.update({
          where: { id: item.invoiceId },
          data: { paidAmt: { decrement: Number(item.amount) }, remainingAmt: { increment: Number(item.amount) } },
        });
      }

      await reverseReceiptEntries(tx as never, tid, rcp.id, rcp.customerId, Number(rcp.amount));
      await tx.notification.create({
        data: {
          tenantId: tid,
          type: 'RECEIPT_CANCELLED',
          title: 'إلغاء سند قبض',
          body: `تم إلغاء سند القبض رقم ${rcp.number}`,
          salesRepId: rcp.salesRepId,
          customerId: rcp.customerId,
          data: JSON.stringify({ receiptId: rcp.id }),
        },
      });
      return rcp;
    });

    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

export default router;

