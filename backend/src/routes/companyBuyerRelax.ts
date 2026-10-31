// ============================================================================
// «فك قيد الرقم الضريبي والعنوان الوطني» — GET|PATCH /api/company/buyer-relax (مُركَّب في routes/company.ts بعد authenticate)
// ----------------------------------------------------------------------------
// طلب المالك ٣١ أكتوبر ٢٠٢٦: «في اعدادات فتح حساب عميل جديد اجعل لكل شركة امكانية فك قيد الرقم الضريبي و العنوان الوطني».
//   • الإعداد CompanySettings.buyerVatAddressRelaxed (مطفأ افتراضاً): صيغ الرقم الضريبي ورقم المبنى والرمز البريدي للعميل
//     تنبيهات لا تمنع الحفظ (routes/customersZatca.ts)، وفاتورة منشأة بياناتها لا تكفي للضريبية تصدر مبسطة (02) بدل 422
//     (compliance/zatca/issue.ts) — فلا يستطيع العميل خصم ضريبتها والمسؤولية على الشركة.
//   • القراءة لكل مستخدم شركة (ولمفتاح القراءة)، وتظهر القيمة أيضاً في GET /api/company (maskCompany ينشر الأعمدة كلها).
//   • التغيير قرارٌ ضريبي أمام تحذيره: لمدير الشركة (دوره من القاعدة لا التوكن) غير المقيّد بنطاق، أو جلسة مالك المنصة —
//     ومفتاح API مرفوض دائماً (403 API_KEY_FORBIDDEN). كل تغيير بسطر تدقيق (معرّفات وحالة فقط).
//   • PUT /api/company وcompanySchema لم يُمسّا: zod يُسقط المفتاح فلا يكتبه الحفظ العام.
// الاعتماديات مُحقنة (createBuyerRelaxRouter) فتختبرها tests/company-buyer-relax.test.ts بقاعدة مزيّفة بلا شبكة.
// ============================================================================

import { NextFunction, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import prisma from '../config/database';
import { requireAdmin, requireAdminPermission, tenantId as tenantIdOf } from '../middleware/auth';
import { adminScopeEnabled } from '../services/adminScope';
import type { AuthRequest } from '../types';

export interface BuyerRelaxDeps {
  db: Pick<PrismaClient, 'companySettings' | 'admin'>;
  /** هل المستخدم مقيّد النطاق؟ (الإنتاج: services/adminScope.adminScopeEnabled — من القاعدة لا التوكن) */
  scopeEnabled(req: AuthRequest): Promise<boolean>;
  tenantId(req: AuthRequest): string;
  /** سطر التدقيق (JSON) — افتراضياً console.warn */
  audit?(line: string): void;
  /** حارس صلاحية «إعدادات الشركة» للتغيير (الإنتاج: requireAdminPermission('canManageCompanySettings')) — يُحقن في الاختبار */
  permission?: RequestHandler;
}

export const BUYER_RELAX_AUDIT_EVENT = 'ZATCA_BUYER_RELAX';

export const BUYER_RELAX_CODES = Object.freeze({
  API_KEY_FORBIDDEN: 'هذا الإجراء غير متاح بمفتاح API',
  BUYER_RELAX_SCOPED: 'حسابك مقيد بنطاق محدد — فك قيد بيانات العملاء الضريبية لمدير الشركة غير المقيد',
  BUYER_RELAX_ADMIN_ONLY: 'فك قيد الرقم الضريبي والعنوان الوطني لمدير الشركة وحده',
  COMPANY_SETTINGS_MISSING: 'احفظ إعدادات الشركة أولاً',
});

const auditId = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, 128) : null);

/** سطر التدقيق: معرّفات الشركة والفاعل ودوره وهل هي جلسة المالك والحالة الجديدة — لا قيم أخرى. */
export function buyerRelaxAuditLine(f: { tenantId: string; actorId: string; role: string; impersonated: boolean; enabled: boolean }): string {
  return JSON.stringify({
    event: BUYER_RELAX_AUDIT_EVENT,
    tenantId: auditId(f.tenantId),
    actorId: auditId(f.actorId),
    role: auditId(f.role),
    impersonated: f.impersonated === true,
    enabled: f.enabled === true,
  });
}

const bodySchema = z.object({ enabled: z.boolean() });

type Code = keyof typeof BUYER_RELAX_CODES;
const refuse = (res: Response, status: number, code: Code) => {
  res.status(status).json({ success: false, code, message: BUYER_RELAX_CODES[code] });
};

export function createBuyerRelaxRouter(deps: BuyerRelaxDeps): Router {
  const router = Router();
  const audit = deps.audit ?? ((line: string) => console.warn(line));
  // مستخدمو الشركة وحدهم (المندوب 403 كسائر موجّهات الشركة)
  router.use(requireAdmin);

  router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const row = await deps.db.companySettings.findUnique({ where: { tenantId: deps.tenantId(req) }, select: { buyerVatAddressRelaxed: true } });
      res.json({ success: true, data: { enabled: row?.buyerVatAddressRelaxed === true } });
    } catch (err) { next(err); }
  });

  router.patch('/', deps.permission ?? requireAdminPermission('canManageCompanySettings'), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      // ١) قرارٌ ضريبي أمام تحذيره — لا يُتّخذ بمفتاح برمجي (كمسارات نطاق المستخدمين في teams.ts)
      if (req.user?.apiKeyId) { refuse(res, 403, 'API_KEY_FORBIDDEN'); return; }
      const impersonated = req.user?.impersonated === true;
      // ٢) المقيّد بنطاق لا يقرّر للشركة كلها (جلسة المالك لا نطاق لها)
      if (!impersonated && await deps.scopeEnabled(req)) { refuse(res, 403, 'BUYER_RELAX_SCOPED'); return; }
      const tid = deps.tenantId(req);
      // ٣) الدور من القاعدة لا من التوكن (كحقول البائع في PUT /api/company)
      const actor = await deps.db.admin.findUnique({ where: { id: req.user?.id ?? '' }, select: { role: true, tenantId: true, isActive: true } });
      if (!impersonated && !(actor?.role === 'ADMIN' && actor.tenantId === tid && actor.isActive === true)) {
        refuse(res, 403, 'BUYER_RELAX_ADMIN_ONLY');
        return;
      }
      // ٤) الجسم — ZodError إلى المعالج العام (400)
      const { enabled } = bodySchema.parse(req.body);
      // ٥) كتابة واحدة على صفّ الشركة — count 0 = لا صفّ بعد ⇒ 409 بلا إنشاء
      const r = await deps.db.companySettings.updateMany({ where: { tenantId: tid }, data: { buyerVatAddressRelaxed: enabled } });
      if (r.count === 0) { refuse(res, 409, 'COMPANY_SETTINGS_MISSING'); return; }
      // ٦) التدقيق
      audit(buyerRelaxAuditLine({ tenantId: tid, actorId: req.user?.id ?? '', role: actor?.role ?? req.user?.role ?? '', impersonated, enabled }));
      res.json({ success: true, data: { enabled } });
    } catch (err) { next(err); }
  });

  return router;
}

export default createBuyerRelaxRouter({
  db: prisma,
  scopeEnabled: adminScopeEnabled,
  tenantId: tenantIdOf,
  audit: line => console.warn(line),
});
