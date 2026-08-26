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
import {
  financeSnapshot, monthlyFinance, quarterFinance, revenueRows,
  staleDaysOf, EXPENSE_STALE_DAYS, VAT_PCT, vatFromInclusive, round2,
} from '../services/finance';
import { backfillInvoices, invoicingReady, platformSeller } from '../services/platformInvoice';

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

/** ربع سنة — الفترة التي تُقدَّم بها الإقرارات فعلاً */
router.get('/quarter/:year/:q', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const year = Number(req.params.year), q = Number(req.params.q);
    if (!Number.isInteger(year) || !Number.isInteger(q) || q < 1 || q > 4) {
      res.status(400).json({ success: false, message: 'سنة أو ربع غير صحيح' });
      return;
    }
    res.json({ success: true, data: await quarterFinance(year, q) });
  } catch (err) { next(err); }
});

/** الفواتير الضريبية التي أصدرناها لمشتركينا */
router.get('/invoices', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const rows = await prisma.platformInvoice.findMany({
      orderBy: { issuedAt: 'desc' }, take: 100,
      select: { id: true, number: true, buyerName: true, description: true, totalSar: true, vatSar: true, issuedAt: true },
    });
    const seller = platformSeller();
    res.json({
      success: true,
      data: {
        rows,
        ready: invoicingReady(),
        sellerName: seller.name,
        vatNumber: seller.vatNumber ? `${seller.vatNumber.slice(0, 3)}…${seller.vatNumber.slice(-3)}` : '',
        note: invoicingReady()
          ? 'تُصدَر آلياً لحظة تأكيد كل دفعة'
          : 'اضبط PLATFORM_VAT_NUMBER (١٥ رقماً) في بيئة الخادم ليبدأ الإصدار',
      },
    });
  } catch (err) { next(err); }
});

/** إصدار ما فات — لدفعات تمّت قبل ضبط الرقم الضريبي أو تعثّر إصدارها */
router.post('/invoices/backfill', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await backfillInvoices(50) });
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
  /**
   * عملة الفاتورة الأصلية وسعر تحويلها. حفظُ الأصل يمنع الانحراف الصامت: حين
   * ترتفع فاتورة Render بالدولار يُحدَّث رقم واحد بدل إعادة حساب الريال يدوياً.
   * الريال مربوط بالدولار عند ٣٫٧٥ رسمياً — فالسعر افتراضٌ لا استدعاءُ سوق.
   */
  currency: z.enum(['SAR', 'USD', 'EUR']).optional(),
  fxRate: z.number().positive().max(100).optional(),
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
const DEFAULT_FX: Record<string, number> = { SAR: 1, USD: 3.75, EUR: 4.1 };

function normalizeExpense(b: z.infer<typeof expenseSchema>): {
  amountSar: number; vatSar: number; amountOriginal: number | null; currency: string; fxRate: number | null;
} {
  const currency = b.currency || 'SAR';
  const fxRate = currency === 'SAR' ? 1 : (b.fxRate ?? DEFAULT_FX[currency] ?? 1);
  const inSar = round2(b.amountSar * fxRate);
  const orig = currency === 'SAR' ? null : round2(b.amountSar);
  const money = normalizeVat({ ...b, amountSar: inSar });
  return { ...money, amountOriginal: orig, currency, fxRate: currency === 'SAR' ? null : fxRate };
}

function normalizeVat(b: z.infer<typeof expenseSchema>): { amountSar: number; vatSar: number } {
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
      data: (await prisma.operatingExpense.findMany({
        orderBy: [{ isRecurring: 'desc' }, { startsOn: 'desc' }], take: 200,
      })).map((e) => {
        const days = staleDaysOf(e.reviewedAt);
        // التقادم يخصّ المتكرّر وحده: مصروفٌ لمرّة لا يتقادم — صُرف وانتهى
        return { ...e, staleDays: days, isStale: e.isRecurring && days >= EXPENSE_STALE_DAYS };
      }),
      staleDaysThreshold: EXPENSE_STALE_DAYS,
    });
  } catch (err) { next(err); }
});

router.post('/expenses', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const b = expenseSchema.parse(req.body);
    const { amountSar, vatSar, amountOriginal, currency, fxRate } = normalizeExpense(b);
    const row = await prisma.operatingExpense.create({
      data: {
        label: b.label, category: b.category, amountSar, vatSar,
        amountOriginal, currency, fxRate,
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
    data.reviewedAt = new Date();   // كل تعديل مراجعةٌ بطبعه
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

/**
 * «راجعتُه ولم يتغيّر» — يجدّد تاريخ المراجعة وحده.
 * بدونه لا سبيل لإسكات وسم التقادم إلا بتغيير مبلغٍ صحيح، فيصير الوسم ضجيجاً
 * يتعلّم المالك تجاهله — وتجاهُلُ الإنذار أسوأ من غيابه.
 */
router.patch('/expenses/:id/reviewed', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const row = await prisma.operatingExpense.update({
      where: { id: req.params.id },
      data: { reviewedAt: new Date() },
    });
    res.json({ success: true, data: row });
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
