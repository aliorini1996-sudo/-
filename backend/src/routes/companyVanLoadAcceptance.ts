// ============================================================================
// «قبول المندوب للتحميل وتوقيعه» — GET|PATCH /api/company/van-load-acceptance (مُركَّب في routes/company.ts بعد authenticate)
// ----------------------------------------------------------------------------
// طلب المالك ٢٢ نوفمبر ٢٠٢٦: تحميل الإدارة لسيارة المندوب يُرسل له معلّقاً فيقبله ويوقّع عليه — إثبات تحميلٍ وإقرار استلام.
//   • الإعداد CompanySettings.vanLoadAcceptance (مطفأ افتراضاً). مفعّلاً: POST /api/van-stock/loads من اللوحة (LOAD) يصير صفّاً معلّقاً
//     بلا أثرٍ في أي مخزون حتى يقبله المندوب (routes/vanStock.ts «قبول المندوب للتحميل»، services/vanPendingLoads.ts).
//   • القراءة لكل مستخدم شركة (والعلم يصل أيضاً في GET /api/company — maskCompany ينشر الأعمدة)، ومعها عدد المفتوح (معلّق ومعترَض).
//   • القلب ضابطٌ يحمي الشركة (توقيع المندوب إثبات التحميل): لمدير الشركة (دوره ADMIN من القاعدة لا التوكن، نشطٌ وفي الشركة نفسها)
//     غير المقيّد بنطاق بصلاحية «إعدادات الشركة»، أو جلسة مالك المنصة — ومفتاح API مرفوض دائماً (403 API_KEY_FORBIDDEN)، ومدير
//     المبيعات والمحاسب 403 VAN_LOAD_ACCEPTANCE_ADMIN_ONLY (كفكّ قيد بيانات المشتري وإزالة الضريبة). كل تغيير بسطر تدقيق (معرّفاتٌ
//     وحالةٌ فقط). والإطفاء مرفوض ما دام تحميلٌ مفتوح (409 VAN_LOAD_ACCEPTANCE_OPEN_LOADS): يقبله مندوبه أو يُلغى أولاً — فلا يبقى
//     معلّقٌ في شركةٍ أطفأت الميزة.
//   • PUT /api/company وcompanySchema لم يُمسّا: zod يُسقط المفتاح فلا يكتبه الحفظ العام.
// الاعتماديات مُحقنة (createVanLoadAcceptanceRouter) فتختبرها tests/van-load-acceptance.test.ts بقاعدة مزيّفة بلا شبكة.
// ============================================================================

import { NextFunction, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import prisma from '../config/database';
import { requireAdmin, requireAdminPermission, tenantId as tenantIdOf } from '../middleware/auth';
import { adminScopeEnabled } from '../services/adminScope';
import type { AuthRequest } from '../types';

export interface VanLoadAcceptanceDeps {
  db: Pick<PrismaClient, 'companySettings' | 'pendingVanLoad' | 'admin'>;
  /** هل المستخدم مقيّد النطاق؟ (الإنتاج: services/adminScope.adminScopeEnabled — من القاعدة لا التوكن) */
  scopeEnabled(req: AuthRequest): Promise<boolean>;
  tenantId(req: AuthRequest): string;
  /** حارس صلاحية «إعدادات الشركة» للتغيير (الإنتاج: requireAdminPermission('canManageCompanySettings')) — يُحقن في الاختبار */
  permission?: RequestHandler;
  /** سطر التدقيق (JSON) — افتراضياً console.warn */
  audit?(line: string): void;
}

export const VAN_LOAD_ACCEPTANCE_AUDIT_EVENT = 'VAN_LOAD_ACCEPTANCE';

export const VAN_LOAD_ACCEPTANCE_CODES = Object.freeze({
  API_KEY_FORBIDDEN: 'هذا الإجراء غير متاح بمفتاح API',
  VAN_LOAD_ACCEPTANCE_SCOPED: 'حسابك مقيد بنطاق محدد — هذا الإعداد للشركة كلها',
  VAN_LOAD_ACCEPTANCE_ADMIN_ONLY: 'اشتراط قبول المندوب للتحميل لمدير الشركة وحده',
  VAN_LOAD_ACCEPTANCE_INVALID: 'قيمة الإعداد غير صحيحة — enabled: true أو false',
  VAN_LOAD_ACCEPTANCE_OPEN_LOADS: 'توجد تحميلات بانتظار قبول المناديب أو معترض عليها — لا تتوقف الميزة حتى يقبلها المناديب أو تلغيها',
  COMPANY_SETTINGS_MISSING: 'احفظ بيانات الشركة أولا',
});
type Code = keyof typeof VAN_LOAD_ACCEPTANCE_CODES;
const refuse = (res: Response, status: number, code: Code, extra: Record<string, unknown> = {}) => {
  res.status(status).json({ success: false, code, message: VAN_LOAD_ACCEPTANCE_CODES[code], ...extra });
};

const bodySchema = z.object({ enabled: z.boolean() }).strict();

const auditId = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, 128) : null);

/** سطر التدقيق: معرّفات الشركة والفاعل ودوره وهل هي جلسة المالك والحالة الجديدة — لا أسماء ولا قيم أخرى (كـbuyerRelaxAuditLine) */
export function vanLoadAcceptanceAuditLine(f: { tenantId: string; actorId: string; role: string; impersonated: boolean; enabled: boolean }): string {
  return JSON.stringify({
    event: VAN_LOAD_ACCEPTANCE_AUDIT_EVENT,
    tenantId: auditId(f.tenantId),
    actorId: auditId(f.actorId),
    role: auditId(f.role),
    impersonated: f.impersonated === true,
    enabled: f.enabled === true,
  });
}

export function createVanLoadAcceptanceRouter(deps: VanLoadAcceptanceDeps): Router {
  const router = Router();
  const audit = deps.audit ?? ((line: string) => console.warn(line));
  // مستخدمو الشركة وحدهم (المندوب 403 كسائر موجّهات الشركة — يعرف العلم من GET /api/company)
  router.use(requireAdmin);

  /** التحميلات المفتوحة للشركة: بانتظار القبول أو معترَضٌ عليها */
  const openCountOf = (tid: string) => deps.db.pendingVanLoad.count({ where: { tenantId: tid, status: { in: ['PENDING', 'DISPUTED'] } } });

  router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tid = deps.tenantId(req);
      const [row, openCount] = await Promise.all([
        deps.db.companySettings.findUnique({ where: { tenantId: tid }, select: { vanLoadAcceptance: true } }),
        openCountOf(tid),
      ]);
      res.json({ success: true, data: { enabled: row?.vanLoadAcceptance === true, openCount } });
    } catch (err) { next(err); }
  });

  router.patch('/', deps.permission ?? requireAdminPermission('canManageCompanySettings'), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      // ١) قرارٌ للشركة كلها من لوحة التحكم — لا يُتّخذ بمفتاح برمجي
      if (req.user?.apiKeyId) { refuse(res, 403, 'API_KEY_FORBIDDEN'); return; }
      const impersonated = req.user?.impersonated === true;
      // ٢) المقيّد بنطاق لا يقرّر للشركة كلها (جلسة المالك لا نطاق لها)
      if (!impersonated && await deps.scopeEnabled(req)) { refuse(res, 403, 'VAN_LOAD_ACCEPTANCE_SCOPED'); return; }
      const tid = deps.tenantId(req);
      // ٣) مدير الشركة وحده — دوره من القاعدة لا التوكن، نشطٌ وفي الشركة نفسها (كفكّ قيد بيانات المشتري)؛ وجلسة المالك تمرّ
      const actor = await deps.db.admin.findUnique({ where: { id: req.user?.id ?? '' }, select: { role: true, tenantId: true, isActive: true } });
      if (!impersonated && !(actor?.role === 'ADMIN' && actor.tenantId === tid && actor.isActive === true)) {
        refuse(res, 403, 'VAN_LOAD_ACCEPTANCE_ADMIN_ONLY');
        return;
      }
      // ٤) الجسم
      const parsed = bodySchema.safeParse(req.body ?? {});
      if (!parsed.success) { refuse(res, 400, 'VAN_LOAD_ACCEPTANCE_INVALID'); return; }
      const { enabled } = parsed.data;
      // ٥) الإطفاء والمفتوح قائم ⇒ 409 بعدده (القبول والاعتراض لا يقرآن الإعداد، فالمفتوح يُحسم أولاً)
      if (!enabled) {
        const count = await openCountOf(tid);
        if (count > 0) { refuse(res, 409, 'VAN_LOAD_ACCEPTANCE_OPEN_LOADS', { count }); return; }
      }
      // ٦) كتابة واحدة على صفّ الشركة — count 0 = لا صفّ بعد ⇒ 409 بلا إنشاء
      const r = await deps.db.companySettings.updateMany({ where: { tenantId: tid }, data: { vanLoadAcceptance: enabled } });
      if (r.count === 0) { refuse(res, 409, 'COMPANY_SETTINGS_MISSING'); return; }
      // ٧) التدقيق
      audit(vanLoadAcceptanceAuditLine({ tenantId: tid, actorId: req.user?.id ?? '', role: actor?.role ?? req.user?.role ?? '', impersonated, enabled }));
      res.json({ success: true, data: { enabled } });
    } catch (err) { next(err); }
  });

  return router;
}

export default createVanLoadAcceptanceRouter({
  db: prisma,
  scopeEnabled: adminScopeEnabled,
  tenantId: tenantIdOf,
  audit: line => console.warn(line),
});
