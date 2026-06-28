import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { paginate, paginationMeta, generateReceiptNumber } from '../utils/helpers';
import { postReceiptEntries, reverseReceiptEntries } from '../services/accounting';

const router = Router();
router.use(authenticate);
router.use(requireAdminPermission('canManageReceipts'));

const receiptSchema = z.object({
  customerId: z.string(),
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
});

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
      ...(from && to && { receiptDate: { gte: new Date(from), lte: new Date(to) } }),
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
    const salesRepId = req.user!.role === 'SALES_REP' ? req.user!.id : body.salesRepId;
    if (!salesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }
    const rep = await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    const customer = await prisma.customer.findFirst({ where: { id: body.customerId, tenantId: tid } });
    if (!customer) { res.status(404).json({ success: false, message: 'العميل غير موجود' }); return; }
    const number = await generateReceiptNumber(tid);
    const docDate = body.receiptDate ? new Date(body.receiptDate) : undefined;

    const receipt = await prisma.$transaction(async tx => {
      const rcp = await tx.receipt.create({
        data: {
          tenantId: tid,
          number,
          customerId: body.customerId,
          salesRepId,
          ...(docDate && { receiptDate: docDate }),
          amount: body.amount,
          paymentMethod: body.paymentMethod,
          chequeNumber: body.chequeNumber,
          bankName: body.bankName,
          notes: body.notes,
        },
      });

      if (body.invoiceAllocations?.length) {
        // التحقق أن الفواتير المخصّصة تخص نفس الشركة
        const allocIds = body.invoiceAllocations.map(a => a.invoiceId);
        const valid = await tx.invoice.count({ where: { id: { in: allocIds }, tenantId: tid } });
        if (valid !== allocIds.length) throw new Error('فاتورة غير صالحة في التخصيص');

        await tx.receiptInvoice.createMany({
          data: body.invoiceAllocations.map(a => ({ receiptId: rcp.id, invoiceId: a.invoiceId, amount: a.amount })),
        });

        for (const alloc of body.invoiceAllocations) {
          await tx.invoice.update({
            where: { id: alloc.invoiceId },
            data: { paidAmt: { increment: alloc.amount }, remainingAmt: { decrement: alloc.amount } },
          });
        }
      }

      await postReceiptEntries(tx as never, tid, rcp.id, body.customerId, body.amount, docDate);
      return rcp;
    });

    res.status(201).json({ success: true, data: receipt });
  } catch (err) { next(err); }
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

    const updated = await prisma.$transaction(async tx => {
      const rcp = await tx.receipt.update({ where: { id: req.params.id }, data: { status: 'CANCELLED' } });

      for (const item of receipt.invoiceItems) {
        await tx.invoice.update({
          where: { id: item.invoiceId },
          data: { paidAmt: { decrement: Number(item.amount) }, remainingAmt: { increment: Number(item.amount) } },
        });
      }

      await reverseReceiptEntries(tx as never, tid, rcp.id, rcp.customerId, Number(rcp.amount));
      return rcp;
    });

    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

export default router;
