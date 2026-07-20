import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../config/database';
import { tenantId } from '../../middleware/auth';
import { AuthRequest } from '../../types';
import { roundDecimal, withNumberRetry } from '../../utils/helpers';
import { checkoutOrder } from '../../services/restaurant/checkout';

// كاشير المطعم — الطلبات والدفع. كل ما تحته محمي بالمصادقة + requireVertical('restaurant') (بالأعلى).
const router = Router();

const orderItemInput = z.object({
  menuItemId: z.string(),
  qty: z.number().positive().default(1),
  note: z.string().nullish(),
  modifierIds: z.array(z.string()).optional(),
});
const orderInput = z.object({
  channel: z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY']).default('DINE_IN'),
  tableId: z.string().nullish(),
  guests: z.number().int().min(1).optional(),
  notes: z.string().nullish(),
  items: z.array(orderItemInput).min(1),
});

// يبني بنود الطلب من القائمة (أسعار/إضافات/ضريبة موثوقة من الخادم، مع لقطات الأسماء)
async function buildLines(tid: string, items: z.infer<typeof orderItemInput>[]) {
  const ids = [...new Set(items.map(i => i.menuItemId))];
  const menuItems = await prisma.menuItem.findMany({ where: { tenantId: tid, id: { in: ids } } });
  const byId = new Map(menuItems.map(m => [m.id, m]));
  const modIds = [...new Set(items.flatMap(i => i.modifierIds ?? []))];
  const mods = modIds.length ? await prisma.modifier.findMany({ where: { tenantId: tid, id: { in: modIds } } }) : [];
  const modById = new Map(mods.map(m => [m.id, m]));

  const lines = items.map(input => {
    const mi = byId.get(input.menuItemId);
    if (!mi) throw Object.assign(new Error('أحد الأصناف غير موجود'), { status: 400 });
    const chosen = (input.modifierIds ?? []).map(id => modById.get(id)).filter((m): m is NonNullable<typeof m> => !!m);
    const modifiersTotal = roundDecimal(chosen.reduce((s, m) => s + Number(m.priceDelta), 0), 2);
    const unitPrice = roundDecimal(Number(mi.basePrice) + modifiersTotal, 2);
    const net = roundDecimal(input.qty * unitPrice, 2);
    const taxAmt = roundDecimal(net * Number(mi.taxPct) / 100, 2);
    return {
      menuItemId: mi.id, nameSnap: mi.name, qty: input.qty, unitPrice, modifiersTotal,
      taxPct: Number(mi.taxPct), taxAmt, lineTotal: roundDecimal(net + taxAmt, 2),
      unitCost: Number(mi.costPrice), station: mi.prepStation, note: input.note || null,
      modifiers: { create: chosen.map(m => ({ nameSnap: m.name, priceDelta: Number(m.priceDelta) })) },
    };
  });
  const subtotal = roundDecimal(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0), 2);
  const taxAmt = roundDecimal(lines.reduce((s, l) => s + l.taxAmt, 0), 2);
  return { lines, subtotal, taxAmt, total: roundDecimal(subtotal + taxAmt, 2) };
}

const orderInclude = { items: { include: { modifiers: true } }, payments: true, table: { select: { number: true } } } as const;

// قائمة الطلبات (المفتوحة افتراضياً)
router.get('/orders', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const status = req.query.status ? String(req.query.status) : 'OPEN';
    const orders = await prisma.order.findMany({
      where: { tenantId: tid, ...(status !== 'ALL' && { status }) },
      orderBy: { createdAt: 'desc' }, take: 100, include: orderInclude,
    });
    res.json({ success: true, data: orders });
  } catch (err) { next(err); }
});

router.get('/orders/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const order = await prisma.order.findFirst({ where: { id: req.params.id, tenantId: tid }, include: orderInclude });
    if (!order) { res.status(404).json({ success: false, message: 'الطلب غير موجود' }); return; }
    res.json({ success: true, data: order });
  } catch (err) { next(err); }
});

// إنشاء طلب جديد ببنوده
router.post('/orders', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = orderInput.parse(req.body);
    const { lines, subtotal, taxAmt, total } = await buildLines(tid, body.items);
    // الطاولة (إن وُردت) يجب أن تخصّ نفس المطعم — منع ربط عابر للشركات
    if (body.tableId) {
      const t = await prisma.restaurantTable.findFirst({ where: { id: body.tableId, tenantId: tid }, select: { id: true } });
      if (!t) { res.status(400).json({ success: false, message: 'الطاولة غير موجودة' }); return; }
    }
    // الرقم داخل withNumberRetry: عند تصادم @@unique([tenantId, number]) تحت التزامن يُعاد التوليد
    const order = await withNumberRetry(async () => {
      const last = await prisma.order.findFirst({ where: { tenantId: tid }, orderBy: { number: 'desc' }, select: { number: true } });
      const number = (last?.number ?? 0) + 1;
      return prisma.$transaction(async tx => {
        const o = await tx.order.create({
          data: {
            tenantId: tid, number, channel: body.channel, tableId: body.tableId || null,
            guests: body.guests ?? 1, notes: body.notes || null,
            cashierName: req.user?.name || null,
            subtotal, taxAmt, total,
            items: { create: lines },
          } as any,
          include: orderInclude,
        });
        if (body.channel === 'DINE_IN' && body.tableId) {
          await tx.restaurantTable.updateMany({ where: { id: body.tableId, tenantId: tid }, data: { status: 'OCCUPIED' } });
        }
        return o;
      });
    });
    res.status(201).json({ success: true, data: order });
  } catch (err) { next(err); }
});

// استبدال بنود طلب مفتوح (إضافة/حذف أصناف)
router.put('/orders/:id/items', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = z.object({ items: z.array(orderItemInput).min(1) }).parse(req.body);
    const order = await prisma.order.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, status: true } });
    if (!order) { res.status(404).json({ success: false, message: 'الطلب غير موجود' }); return; }
    if (order.status !== 'OPEN') { res.status(400).json({ success: false, message: 'الطلب غير مفتوح' }); return; }
    const { lines, subtotal, taxAmt, total } = await buildLines(tid, body.items);

    const updated = await prisma.$transaction(async tx => {
      await tx.orderItem.deleteMany({ where: { orderId: order.id } }); // يحذف الإضافات عبر Cascade
      await tx.order.update({ where: { id: order.id }, data: { subtotal, taxAmt, total, items: { create: lines } } as any });
      return tx.order.findUnique({ where: { id: order.id }, include: orderInclude });
    });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

// الدفع → تسجيل الدفعات + إنشاء فاتورة CASH عبر checkout
router.post('/orders/:id/pay', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = z.object({
      payments: z.array(z.object({
        method: z.enum(['CASH', 'CARD', 'WALLET', 'ON_ACCOUNT']),
        amount: z.number().min(0),
        tendered: z.number().min(0).nullish(),
      })).min(1),
    }).parse(req.body);
    const order = await prisma.order.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, status: true, total: true } });
    if (!order) { res.status(404).json({ success: false, message: 'الطلب غير موجود' }); return; }
    if (order.status !== 'OPEN') { res.status(409).json({ success: false, message: 'الطلب مدفوع أو غير مفتوح' }); return; }
    // تحقّق تغطية الدفع: مجموع الدفعات يجب أن يغطّي إجمالي الطلب (المحسوب من الخادم) — منع نجاح دفع زائف
    const paid = roundDecimal(body.payments.reduce((s, p) => s + p.amount, 0), 2);
    if (paid + 0.01 < order.total) {
      res.status(400).json({ success: false, message: 'مبلغ الدفع أقل من إجمالي الطلب — حدّث القائمة وأعد المحاولة' });
      return;
    }
    // الدفعات + الفاتورة + تحرير الطاولة ذرّياً داخل checkout (لا إنشاء دفعات خارج المعاملة)
    const result = await checkoutOrder(tid, order.id, body.payments);
    const full = await prisma.order.findUnique({ where: { id: order.id }, include: orderInclude });
    res.json({ success: true, data: { order: full, invoice: result } });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status) { res.status(status).json({ success: false, message: (err as Error).message }); return; }
    next(err);
  }
});

// إلغاء طلب مفتوح (يحرّر الطاولة)
router.post('/orders/:id/void', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : null;
    const order = await prisma.order.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, status: true, tableId: true } });
    if (!order) { res.status(404).json({ success: false, message: 'الطلب غير موجود' }); return; }
    if (order.status !== 'OPEN') { res.status(400).json({ success: false, message: 'لا يمكن إلغاء طلب غير مفتوح' }); return; }
    await prisma.$transaction(async tx => {
      await tx.order.update({ where: { id: order.id }, data: { status: 'VOID', voidReason: reason } });
      if (order.tableId) await tx.restaurantTable.update({ where: { id: order.tableId }, data: { status: 'FREE' } });
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
