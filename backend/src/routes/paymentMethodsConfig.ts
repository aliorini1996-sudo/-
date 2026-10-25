import { Router, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { requireAdmin, requireAdminPermission, requirePaymentMethods, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import {
  isDefaultPaymentMethodsConfig, isPaymentMethodsReset, parsePaymentMethodsConfig, paymentMethodsTransitionIssues,
  paymentMethodsView, readPaymentMethodsConfig, resetPaymentMethodsConfig, storedPaymentMethodsConfig,
  type PaymentMethodsConfigV1, type PaymentMethodsIssue,
} from '../services/paymentMethodsConfig';

/**
 * «إدارة طرق الدفع» (طلب المالك ٢٥ أكتوبر ٢٠٢٦) — مُركَّبٌ تحت /api/company/payment-methods (routes/company.ts) بعد authenticate.
 *
 * القراءة لكل مستخدم مسجّل: المندوب يبني منها اختيارات سند القبض وأسماءه المطبوعة (وGET /api/company يحمل العمود نفسه
 * خاماً لجهازه وذاكرته أوف‑لاين؛ الواجهة تقرؤه دائماً عبر readPaymentMethodsConfig).
 *
 * الحفظ (قرار المالك ٤): مستخدم الشركة بصلاحية «إعدادات الشركة» — requireAdmin أولاً لأن requireAdminPermission يمرّر
 * المندوب كما هو. ثم عَلَم الصفحة (requirePaymentMethods: المحاسبة ثم paymentMethodsEnabled): الإدارة تعيش في صفحة «طرق
 * الدفع» المدفوعة، فإطفاؤها يجمّد التعديل — والأسماء تبقى معروضة في كل مكان لأن السندات تحمل مفاتيحها.
 *
 * الكتابة داخل معاملة تقفل صفّ الشركة (FOR UPDATE): حفظان متزامنان قرأ كلٌّ منهما القديم كانا سيمرّان بفحص الانتقال معاً
 * فيمحو الثاني طريقةً أضافها الأول. وبلا صفّ ⇒ 409 بلا إنشاء (لا اسم نخترعه للشركة). PUT /api/company وcompanySchema لم يُمسّا.
 */
const router = Router();

const COMPANY_SETTINGS_MISSING = 'احفظ بيانات الشركة أولا';

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const row = await prisma.companySettings.findUnique({ where: { tenantId: tenantId(req) }, select: { paymentMethodsConfig: true } });
    const { config } = storedPaymentMethodsConfig(row?.paymentMethodsConfig ?? null);
    res.json({ success: true, ...paymentMethodsView(config, !!row) });
  } catch (err) { next(err); }
});

type SaveOutcome =
  | { kind: 'missing' }
  | { kind: 'conflict'; issues: PaymentMethodsIssue[] }
  | { kind: 'ok'; value: PaymentMethodsConfigV1 | null };

router.put('/', requireAdmin, requireAdminPermission('canManageCompanySettings'), requirePaymentMethods, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const reset = isPaymentMethodsReset(req.body);
    // التحليل الصارم قبل المعاملة (لا قفل على جسمٍ مرفوض) — ومفاتيح الطرق الجديدة تُولَّد هنا
    const parsed = reset ? null : parsePaymentMethodsConfig(req.body);
    if (parsed && !parsed.ok) {
      res.status(parsed.status).json({ success: false, code: parsed.code, message: parsed.message, issues: parsed.issues });
      return;
    }
    const outcome = await prisma.$transaction(async (tx): Promise<SaveOutcome> => {
      // القفل بالخام (Prisma لا يعبّر عن FOR UPDATE) والقراءة بالنموذج المنمَّط — عمود JSON يعود كائناً لا نصّاً
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM company_settings WHERE "tenantId" = ${tid} FOR UPDATE`;
      if (!locked.length) return { kind: 'missing' };
      const row = await tx.companySettings.findUnique({ where: { tenantId: tid }, select: { paymentMethodsConfig: true } });
      const prev = readPaymentMethodsConfig(row?.paymentMethodsConfig ?? null);
      const next: PaymentMethodsConfigV1 | null = parsed?.ok ? parsed.value : resetPaymentMethodsConfig(prev);
      if (next) {
        // لا حذف ولا تبديل أساس — من تبويبٍ قديم أو من عميلٍ لا يحترم الواجهة (الإعادة تحفظ المخصّصة فتمرّ دائماً)
        const issues = paymentMethodsTransitionIssues(prev, next);
        if (issues.length) return { kind: 'conflict', issues };
      }
      // ما يساوي الافتراضي يُكتب NULL حرفياً — «null = سلوك اليوم»، لا نسخةٌ منه
      const value = next && !isDefaultPaymentMethodsConfig(next) ? next : null;
      await tx.companySettings.updateMany({
        where: { tenantId: tid },
        data: { paymentMethodsConfig: value ? (value as unknown as Prisma.InputJsonValue) : Prisma.DbNull },
      });
      return { kind: 'ok', value };
    });
    if (outcome.kind === 'missing') {
      res.status(409).json({ success: false, code: 'COMPANY_SETTINGS_MISSING', message: COMPANY_SETTINGS_MISSING });
      return;
    }
    if (outcome.kind === 'conflict') {
      res.status(409).json({ success: false, code: 'PAYMENT_METHODS_CONFLICT', message: outcome.issues[0].message, issues: outcome.issues });
      return;
    }
    res.json({ success: true, ...paymentMethodsView(outcome.value, true) });
  } catch (err) { next(err); }
});

export default router;
