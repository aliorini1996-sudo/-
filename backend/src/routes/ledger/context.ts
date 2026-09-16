import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../types';

/** سياق طلب الدفاتر — معرّف الشركة والمنفّذ ووسم الانتحال، مقروءة مرة واحدة من التوكن. */
export type LedgerLocals = {
  tenantId: string;
  actorId: string;
  impersonated: boolean;
};

/**
 * يأتي بعد `requireAdmin` و`requireAccountingSuite` في سلسلة `/api/ledger` (§9.1).
 * الشركة إلزامية هنا: كل استعلام دفاتر معزول بها (§9.4)، ومستخدم بلا شركة لا يبلغ
 * هذا الوسيط أصلاً (requireAdmin يمنع السوبر أدمن)، فغيابها يُرفض صراحةً لا يُمرَّر.
 * الانتحال يمرّ كصاحب الحساب ويُوسم، وكل كتابة من M2 تحمل الوسم في التدقيق.
 */
export function ledgerContext(req: AuthRequest, res: Response, next: NextFunction) {
  const tid = req.user?.tenantId;
  if (!req.user || !tid) {
    res.status(403).json({ success: false, code: 'ACCOUNTING_SUITE_NOT_ALLOWED', message: 'النظام المحاسبي المتكامل غير مفعّل لهذه الشركة تواصل مع مزود الخدمة' });
    return;
  }
  const ctx: LedgerLocals = { tenantId: tid, actorId: req.user.id, impersonated: req.user.impersonated === true };
  res.locals.ledger = ctx;
  next();
}
