/**
 * الإدارة المالية — مسارات المالك وحده.
 *
 * كل الأرقام مشتقّة من مصادر الحقيقة (payment_links · tenants · operating_expenses)
 * ولا يُدخل المالك إلا **مصروفاته**، والباقي يُحسب. الضريبة تُستخرَج من مبالغ
 * شاملة لها لا تُضاف إليها — راجع التعليق في services/finance.ts.
 */

import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { AuthRequest } from '../types';
import { financeSnapshot, monthlyFinance, VAT_PCT, vatFromInclusive, round2 } from '../services/finance';

const router = Router();
router.use(authenticate, requireSuperAdmin);

/** الصورة المالية الكاملة — نقطة واحدة تكفي اللوحة */
router.get('/snapshot', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await financeSnapshot() });
  } catch (err) { next(err); }
});

/** تفصيل شهر بعينه */
router.get('/month/:year/:month', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const year = Number(req.params.year), month = Number(req.params.month);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      res.status(400).json({ success: false, message: 'سنة أو شهر غير صحيح' });
      return;
    }
    res.json({ success: true, data: await monthlyFinance(year, month) });
  } catch (err) { next(err); }
});

const expenseSchema = z.object({
  label: z.string().min(2).max(80),
  category: z.enum(['hosting', 'ai', 'marketing', 'tools', 'salaries', 'other']),
  amountSar: z.number().positive().max(1_000_000),
  // الضريبة على المصروف: تُحسب آلياً من المبلغ إن لم تُعطَ، فالمالك لا يحسب يدوياً
  vatSar: z.number().min(0).optional(),
  vatIncluded: z.boolean().optional(),   // المبلغ شامل الضريبة؟ (الافتراض: لا)
  isRecurring: z.boolean().default(false),
  startsOn: z.string(),
  endsOn: z.string().nullish(),
  note: z.string().max(300).nullish(),
});

router.get('/expenses', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json({
      success: true,
      data: await prisma.operatingExpense.findMany({ orderBy: [{ isRecurring: 'desc' }, { startsOn: 'desc' }], take: 200 }),
    });
  } catch (err) { next(err); }
});

router.post('/expenses', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const b = expenseSchema.parse(req.body);
    // إن كان المبلغ شاملاً الضريبة نستخرجها منه؛ وإلا نحسبها فوقه — والفرق جوهري
    const vatSar = b.vatSar !== undefined
      ? round2(b.vatSar)
      : b.vatIncluded
        ? vatFromInclusive(b.amountSar)
        : round2((b.amountSar * VAT_PCT) / 100);
    const row = await prisma.operatingExpense.create({
      data: {
        label: b.label, category: b.category, amountSar: round2(b.amountSar), vatSar,
        isRecurring: b.isRecurring, startsOn: new Date(b.startsOn),
        endsOn: b.endsOn ? new Date(b.endsOn) : null, note: b.note ?? null,
      },
    });
    res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

router.delete('/expenses/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await prisma.operatingExpense.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

/** إيقاف مصروف متكرّر بتاريخ — أصدق من الحذف: يحفظ تاريخ ما صُرف فعلاً */
router.patch('/expenses/:id/stop', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const row = await prisma.operatingExpense.update({
      where: { id: req.params.id },
      data: { endsOn: new Date() },
    });
    res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

export default router;
