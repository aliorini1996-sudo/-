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
import { financeSnapshot, monthlyFinance, revenueRows, VAT_PCT, vatFromInclusive, round2 } from '../services/finance';

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

/** قائمة الإيرادات — مدفوعات ميسر بأسماء عملائها وتصنيف تكرارها */
router.get('/revenues', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await revenueRows(100) });
  } catch (err) { next(err); }
});

const expenseSchema = z.object({
  label: z.string().min(2).max(80),
  category: z.enum(['hosting', 'ai', 'marketing', 'tools', 'salaries', 'other']),
  amountSar: z.number().positive().max(1_000_000),
  /**
   * وضع الضريبة على المصروف — ثلاث حالات صريحة لا مفتاح ثنائي:
   *  • none      = بلا ضريبة سعودية (مورّد أجنبي: Render، Anthropic، نطاق) ← **الافتراض**
   *  • inclusive = المبلغ شامل ضريبة تُستخرَج منه
   *  • exclusive = الضريبة تُضاف فوق المبلغ، فالمدفوع نقداً = المبلغ + الضريبة
   * المفتاح الثنائي السابق لم يكن يملك حالة «صفر»، فكان يخترع ضريبة مدخلات على
   * فواتير أجنبية لا ضريبة فيها — فيُنقص المستحقّ للهيئة بلا سند.
   */
  vatMode: z.enum(['none', 'inclusive', 'exclusive']).optional(),
  vatSar: z.number().min(0).optional(),
  vatIncluded: z.boolean().optional(),   // توافق خلفي مع الواجهة القديمة
  isRecurring: z.boolean().default(false),
  startsOn: z.string(),
  endsOn: z.string().nullish(),
  note: z.string().max(300).nullish(),
});

/**
 * يحوّل ما أدخله المالك إلى الصورة المخزَّنة: `amountSar` = **النقد المدفوع
 * فعلاً** دائماً، و`vatSar` = المدخلات القابلة للخصم منه. توحيد الدلالة شرطُ
 * جمعٍ صحيح: عمودٌ يعني مرّةً «قبل الضريبة» ومرّةً «بعدها» لا يُجمع.
 */
function normalizeExpense(b: z.infer<typeof expenseSchema>): { amountSar: number; vatSar: number } {
  const mode = b.vatMode ?? (b.vatIncluded === true ? 'inclusive' : b.vatIncluded === false ? 'none' : 'none');
  if (b.vatSar !== undefined) {
    // ضريبة صريحة: المبلغ يبقى كما أُدخل والضريبة جزء منه
    return { amountSar: round2(b.amountSar), vatSar: round2(b.vatSar) };
  }
  if (mode === 'inclusive') {
    return { amountSar: round2(b.amountSar), vatSar: vatFromInclusive(b.amountSar) };
  }
  if (mode === 'exclusive') {
    const vat = round2((b.amountSar * VAT_PCT) / 100);
    return { amountSar: round2(b.amountSar + vat), vatSar: vat };
  }
  return { amountSar: round2(b.amountSar), vatSar: 0 };
}

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
    const { amountSar, vatSar } = normalizeExpense(b);
    const row = await prisma.operatingExpense.create({
      data: {
        label: b.label, category: b.category, amountSar, vatSar,
        isRecurring: b.isRecurring, startsOn: new Date(b.startsOn),
        endsOn: b.endsOn ? new Date(b.endsOn) : null, note: b.note ?? null,
      },
    });
    res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

const patchSchema = z.object({
  label: z.string().min(2).max(80).optional(),
  category: z.enum(['hosting', 'ai', 'marketing', 'tools', 'salaries', 'other']).optional(),
  amountSar: z.number().positive().max(1_000_000).optional(),
  vatSar: z.number().min(0).optional(),
  note: z.string().max(300).nullish(),
}).refine((v) => Object.keys(v).length > 0, 'لا تغيير مطلوب');

/**
 * تصحيح مصروف قائم — دون حذفه وإعادة إدخاله.
 * لزم لأن أسطراً سُجّلت قبل فصل أوضاع الضريبة تحمل ضريبة مدخلات مخترَعة على
 * فواتير أجنبية؛ الحذف كان سيمحو تاريخ الصرف معها.
 */
router.patch('/expenses/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const b = patchSchema.parse(req.body);
    const data: Record<string, unknown> = {};
    if (b.label !== undefined) data.label = b.label;
    if (b.category !== undefined) data.category = b.category;
    if (b.amountSar !== undefined) data.amountSar = round2(b.amountSar);
    if (b.vatSar !== undefined) data.vatSar = round2(b.vatSar);
    if ('note' in b) data.note = b.note ?? null;
    const row = await prisma.operatingExpense.update({ where: { id: req.params.id }, data });
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
