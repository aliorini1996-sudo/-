import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../config/database';
import { tenantId } from '../../middleware/auth';
import { AuthRequest } from '../../types';
import { roundDecimal } from '../../utils/helpers';

// ورديات الكاشير ودرج النقد (M4). محمي بالمصادقة + requireVertical('restaurant') بالأعلى.
const router = Router();

// النقد المتوقّع في الدرج = الافتتاحي + المبيعات النقدية + الإيداعات − (المرتجعات + السحوبات + الإخراج)
function computeExpected(openingFloat: number, movements: { type: string; amount: number }[]): number {
  let cash = openingFloat;
  for (const m of movements) {
    if (m.type === 'SALE' || m.type === 'PAY_IN') cash += m.amount;
    else if (m.type === 'REFUND' || m.type === 'PAY_OUT' || m.type === 'DROP') cash -= m.amount;
  }
  return roundDecimal(cash, 2);
}

// الوردية المفتوحة حالياً + إجماليّاتها اللحظية
router.get('/current', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const shift = await prisma.posShift.findFirst({ where: { tenantId: tid, status: 'OPEN' }, include: { movements: true } });
    if (!shift) { res.json({ success: true, data: null }); return; }
    const cashSales = roundDecimal(shift.movements.filter(m => m.type === 'SALE').reduce((s, m) => s + m.amount, 0), 2);
    res.json({ success: true, data: { ...shift, cashSales, expectedCash: computeExpected(shift.openingFloat, shift.movements) } });
  } catch (err) { next(err); }
});

// فتح وردية (وحيدة مفتوحة لكل مطعم)
router.post('/open', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { openingFloat } = z.object({ openingFloat: z.number().min(0).default(0) }).parse(req.body);
    const existing = await prisma.posShift.findFirst({ where: { tenantId: tid, status: 'OPEN' }, select: { id: true } });
    if (existing) { res.status(409).json({ success: false, message: 'توجد وردية مفتوحة بالفعل' }); return; }
    const shift = await prisma.posShift.create({ data: { tenantId: tid, openingFloat, cashierName: req.user?.name || null } as any });
    res.status(201).json({ success: true, data: shift });
  } catch (err) { next(err); }
});

// حركة نقدية يدوية (إيداع/سحب/إخراج نقد)
router.post('/:id/movement', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { type, amount, reason } = z.object({
      type: z.enum(['PAY_IN', 'PAY_OUT', 'DROP']), amount: z.number().positive(), reason: z.string().nullish(),
    }).parse(req.body);
    const shift = await prisma.posShift.findFirst({ where: { id: req.params.id, tenantId: tid, status: 'OPEN' }, select: { id: true } });
    if (!shift) { res.status(404).json({ success: false, message: 'الوردية غير موجودة أو مغلقة' }); return; }
    await prisma.cashMovement.create({ data: { tenantId: tid, shiftId: shift.id, type, amount, reason: reason || null } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// إغلاق وردية بعدّ الدرج واحتساب الفرق
router.post('/:id/close', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { declaredCash, note } = z.object({ declaredCash: z.number().min(0), note: z.string().nullish() }).parse(req.body);
    const shift = await prisma.posShift.findFirst({ where: { id: req.params.id, tenantId: tid, status: 'OPEN' }, include: { movements: true } });
    if (!shift) { res.status(404).json({ success: false, message: 'الوردية غير موجودة أو مغلقة' }); return; }
    const expectedCash = computeExpected(shift.openingFloat, shift.movements);
    const variance = roundDecimal(declaredCash - expectedCash, 2);
    const updated = await prisma.posShift.update({
      where: { id: shift.id },
      data: { status: 'CLOSED', declaredCash, expectedCash, variance, note: note || null, closedAt: new Date() },
    });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

// تقرير Z لوردية (مفتوحة أو مغلقة)
router.get('/:id/zreport', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const shift = await prisma.posShift.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { movements: true } });
    if (!shift) { res.status(404).json({ success: false, message: 'الوردية غير موجودة' }); return; }

    const [sales, byMethod] = await Promise.all([
      prisma.invoice.aggregate({
        where: { tenantId: tid, shiftId: shift.id, status: 'CONFIRMED', type: { not: 'RETURN' } },
        _sum: { total: true, subtotal: true, taxAmt: true }, _count: { id: true },
      }),
      prisma.orderPayment.groupBy({
        by: ['method'], where: { order: { invoice: { shiftId: shift.id } } },
        _sum: { amount: true }, _count: { _all: true },
      }),
    ]);
    const expectedCash = computeExpected(shift.openingFloat, shift.movements);

    res.json({
      success: true,
      data: {
        shift: {
          id: shift.id, cashierName: shift.cashierName, status: shift.status,
          openedAt: shift.openedAt, closedAt: shift.closedAt,
          openingFloat: shift.openingFloat, declaredCash: shift.declaredCash,
          expectedCash: shift.status === 'CLOSED' ? shift.expectedCash : expectedCash,
          variance: shift.variance,
        },
        salesTotal: Number(sales._sum.total ?? 0),
        netTotal: Number(sales._sum.subtotal ?? 0),
        taxTotal: Number(sales._sum.taxAmt ?? 0),
        invoiceCount: sales._count.id,
        byMethod: byMethod.map(m => ({ method: m.method, amount: Number(m._sum.amount ?? 0), count: m._count._all })),
        movements: shift.movements
          .filter(m => m.type !== 'SALE')
          .map(m => ({ type: m.type, amount: m.amount, reason: m.reason, createdAt: m.createdAt })),
      },
    });
  } catch (err) { next(err); }
});

export default router;
