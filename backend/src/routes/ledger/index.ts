import { Router, Response, NextFunction } from 'express';
import prisma from '../../config/database';
import { authenticate, requireAdmin, requireAccountingSuite, requireLedgerPermission } from '../../middleware/auth';
import { AuthRequest } from '../../types';
import { ledgerContext, LedgerLocals } from './context';
import { fromDbDate } from '../../services/gl/dates';
import configRouter from './config';
import lockDatesRouter from './lockDates';
import movesRouter from './moves';
import savedFiltersRouter from './savedFilters';
import listsRouter from './lists';
import checksRouter from './checks';
import syncRouter from './sync';
import setupRouter from './setup';
import customersRouter from './customers';
import reviewRouter from './review';
import reportsRouter from './reports';

/**
 * النظام المحاسبي المتكامل — `/api/ledger` (§9.1، ملحق أ).
 *
 * سلسلة الحراسة مركّبة **قبل أول مسار** فلا يُفلت منها مسارٌ يُضاف لاحقاً:
 * المصادقة ← دور لوحة الشركة (يمنع المندوب، لأن requireAdminPermission يمرّره)
 * ← العَلَم (`accountingSuiteEnabled === true` و`accountingEnabled !== false`)
 * ← سياق الدفاتر. ثم لكل مسار `requireLedgerPermission(...)`.
 *
 * M0: `GET /status`. M2: الموجّهات الفرعية تُركَّب **بعد** السلسلة (فتمرّ بها كلها) وكلٌّ منها يحرس
 * مساراته بـrequireLedgerPermission: التهيئة (config)، تواريخ الإقفال (lockDates)، القيود وبنودها (moves)،
 * المفضلات (savedFilters)، وتصدير القوائم (lists).
 */
const router = Router();
router.use(authenticate, requireAdmin, requireAccountingSuite, ledgerContext);

router.get('/status', requireLedgerPermission('canViewLedger'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = res.locals.ledger as LedgerLocals;
    // M2: الحالة من GlSettings — غياب الصف أو activatedAt فارغ ⇒ الإعداد مطلوب (§5.6 الخطوة 2، §8.1)
    const s = await prisma.glSettings.findUnique({
      where: { tenantId: ctx.tenantId },
      select: {
        activatedAt: true, backfillState: true, templateKey: true, countryCode: true, currency: true,
        currencyDecimals: true, cutoverDate: true, setupMethod: true, timezone: true, lastSyncAt: true,
      },
    });
    res.json({
      success: true,
      data: {
        tenantId: ctx.tenantId,
        suiteEnabled: true,
        activatedAt: s?.activatedAt ?? null,
        setupRequired: s?.activatedAt == null,
        seeded: !!s,
        backfillState: s?.backfillState ?? 'NONE',
        templateKey: s?.templateKey ?? null,
        countryCode: s?.countryCode ?? null,
        currency: s?.currency ?? null,
        currencyDecimals: s?.currencyDecimals ?? null,
        cutoverDate: s?.cutoverDate ? fromDbDate(s.cutoverDate) : null,
        setupMethod: s?.setupMethod ?? null,
        timezone: s?.timezone ?? null,
        lastSyncAt: s?.lastSyncAt ?? null,
      },
    });
  } catch (err) { next(err); }
});

router.use(configRouter);
router.use(lockDatesRouter);
router.use(movesRouter);
router.use(savedFiltersRouter);
router.use(listsRouter);
// M3: الإعداد المبدئي (setup)، والمزامنة والأحداث (sync)، وفحوصات السلامة (checks) — §5.1، §5.6، §5.9، ملحق أ
router.use(setupRouter);
router.use(syncRouter);
router.use(checksRouter);
// M3: قائمة «العملاء» (حالة الترحيل والعهدة والأمانات) و«مراجعة ← سجل التدقيق» — §8.2
router.use(customersRouter);
router.use(reviewRouter);
// M4: التقارير المالية (§7) — `GET /reports/:key` و`POST /reports/:key/export` بصلاحية canViewLedger
router.use(reportsRouter);

export default router;
