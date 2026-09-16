import { Router, Response, NextFunction } from 'express';
import { authenticate, requireAdmin, requireAccountingSuite, requireLedgerPermission } from '../../middleware/auth';
import { AuthRequest } from '../../types';
import { ledgerContext, LedgerLocals } from './context';

/**
 * النظام المحاسبي المتكامل — `/api/ledger` (§9.1، ملحق أ).
 *
 * سلسلة الحراسة مركّبة **قبل أول مسار** فلا يُفلت منها مسارٌ يُضاف لاحقاً:
 * المصادقة ← دور لوحة الشركة (يمنع المندوب، لأن requireAdminPermission يمرّره)
 * ← العَلَم (`accountingSuiteEnabled === true` و`accountingEnabled !== false`)
 * ← سياق الدفاتر. ثم لكل مسار `requireLedgerPermission(...)`.
 *
 * M0: مسار `GET /status` وحده، ولا جداول gl بعد.
 */
const router = Router();
router.use(authenticate, requireAdmin, requireAccountingSuite, ledgerContext);

router.get('/status', requireLedgerPermission('canViewLedger'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = res.locals.ledger as LedgerLocals;
    // لا GlSettings قبل M2: الميزة مفعّلة والدفاتر لم تُعدّ بعد
    res.json({
      success: true,
      data: {
        tenantId: ctx.tenantId,
        suiteEnabled: true,
        activatedAt: null,
        setupRequired: true,
      },
    });
  } catch (err) { next(err); }
});

export default router;
