import { Router, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../../config/database';
import { requireAdmin, tenantId } from '../../middleware/auth';
import { AuthRequest } from '../../types';

// موظّفو المطعم (كاشير/نادل) — يُعادون استخدامهم كـSalesRep. الإدارة للأدمن فقط.
// الـPIN يُخزَّن مُجزّأً في passwordHash؛ canCreateReceipt = «يقبض الدفع» (كاشير=نعم، نادل=لا).
const router = Router();
router.use(requireAdmin);

// حساب النظام الافتراضي للإسناد — يُخفى من قائمة الموظّفين
const isSystemCashier = (username: string, tid: string) => username === `resto-cashier-${tid}`;

const staffSelect = { id: true, name: true, username: true, isActive: true, canCreateReceipt: true, createdAt: true } as const;

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const reps = await prisma.salesRep.findMany({ where: { tenantId: tid }, orderBy: { createdAt: 'asc' }, select: staffSelect });
    res.json({ success: true, data: reps.filter(r => !isSystemCashier(r.username, tid)) });
  } catch (err) { next(err); }
});

const createSchema = z.object({
  name: z.string().min(1),
  username: z.string().min(3).regex(/^[a-zA-Z0-9._-]+$/, 'اسم الدخول: حروف إنجليزية/أرقام فقط'),
  pin: z.string().regex(/^\d{4,6}$/, 'الرمز 4 إلى 6 أرقام'),
  canPay: z.boolean().optional(), // كاشير (يقبض) أم نادل (يأخذ الطلبات فقط)
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = createSchema.parse(req.body);
    const taken = await prisma.salesRep.findUnique({ where: { username: body.username }, select: { id: true } });
    if (taken) { res.status(409).json({ success: false, message: 'اسم الدخول مستخدم — اختر غيره' }); return; }
    const passwordHash = await bcrypt.hash(body.pin, 10);
    const rep = await prisma.salesRep.create({
      data: {
        tenantId: tid, name: body.name.trim(), phone: '', username: body.username.trim(), passwordHash,
        canCreateReceipt: body.canPay !== false,
        // كاشير المطعم لا يستخدم صلاحيات التوزيع — إطفاء ما لا يلزم
        canCreateInvoice: true, canSellOnCredit: false, canManageVanStock: false, canBeTracked: false,
      } as any,
      select: staffSelect,
    });
    res.status(201).json({ success: true, data: rep });
  } catch (err) { next(err); }
});

router.put('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = z.object({ name: z.string().min(1).optional(), isActive: z.boolean().optional(), canPay: z.boolean().optional() }).parse(req.body);
    const rep = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, username: true } });
    if (!rep || isSystemCashier(rep.username, tid)) { res.status(404).json({ success: false, message: 'الموظّف غير موجود' }); return; }
    const data: Record<string, unknown> = {};
    if (body.name != null) data.name = body.name.trim();
    if (body.isActive != null) data.isActive = body.isActive;
    if (body.canPay != null) data.canCreateReceipt = body.canPay;
    const updated = await prisma.salesRep.update({ where: { id: rep.id }, data, select: staffSelect });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

// إعادة تعيين الرمز
router.post('/:id/pin', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { pin } = z.object({ pin: z.string().regex(/^\d{4,6}$/, 'الرمز 4 إلى 6 أرقام') }).parse(req.body);
    const rep = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, username: true } });
    if (!rep || isSystemCashier(rep.username, tid)) { res.status(404).json({ success: false, message: 'الموظّف غير موجود' }); return; }
    await prisma.salesRep.update({ where: { id: rep.id }, data: { passwordHash: await bcrypt.hash(pin, 10) } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rep = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, username: true } });
    if (!rep || isSystemCashier(rep.username, tid)) { res.status(404).json({ success: false, message: 'الموظّف غير موجود' }); return; }
    // للموظّف فواتير مُسنَدة (قيد FK) — عطّله بدل حذفه حفاظاً على سجلّ المبيعات
    const invoices = await prisma.invoice.count({ where: { salesRepId: rep.id } });
    if (invoices > 0) { res.status(409).json({ success: false, message: 'للموظّف مبيعات مسجّلة — عطّله بدل حذفه' }); return; }
    await prisma.salesRep.delete({ where: { id: rep.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
