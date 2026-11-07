// ============================================================================
// «إزالة الضريبة» — GET|PATCH /api/company/tax-mode (مُركَّب في routes/company.ts بعد authenticate)
// ----------------------------------------------------------------------------
// طلب المالك ٧ نوفمبر ٢٠٢٦: «في حال ازالة الضريبة لا يكون لها ذكر في اي سطر في النظام ولا في اي مستند».
//   • الإعداد CompanySettings.taxDisabled (مطفأ افتراضاً) ومعه taxModeChangedAt/taxModeChangedBy (مرجع تسامح إعادة رفع صندوق
//     المندوب في POST /api/invoices). القواعد في services/taxMode.ts (المشترك حرفياً مع الواجهة).
//   • القراءة لكل مستخدم شركة (ولمفتاح القراءة)، والعلم يصل أيضاً في GET /api/company (maskCompany ينشر الأعمدة).
//   • القلب لمدير الشركة (دوره من القاعدة لا التوكن) غير المقيّد بنطاق، أو جلسة مالك المنصة — ومفتاح API مرفوض دائماً
//     (403 API_KEY_FORBIDDEN). كل تغيير فعليّ بسطر تدقيق (معرّفات وحالة فقط)، والقيمة نفسها لا تكتب شيئاً (فلا يتقدّم المرجع).
//   • «بلا ضريبة» وربط المرحلة الثانية لا يجتمعان (compliance/zatca/settingsGuards.ts): الإزالة 409 TAX_MODE_ZATCA_CONFLICT ما دام
//     علم المالك أو التفعيل الحيّ أو التسليح أو قائمة البروفة. والكتابة نفسها مشروطة بعمودي الإعدادات (لا تسليح ولا تفعيل) فلا
//     يسبقها تسليحٌ متزامن. وإعادة الضريبة حرّة دائماً.
//   • PUT /api/company وcompanySchema لم يُمسّا: zod يُسقط المفتاح فلا يكتبه الحفظ العام.
// الاعتماديات مُحقنة (createTaxModeRouter) فتختبرها tests/company-tax-mode.test.ts بقاعدة مزيّفة بلا شبكة.
// ============================================================================

import { NextFunction, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import prisma from '../config/database';
import { actorOf, requireAdmin, requireAdminPermission, tenantId as tenantIdOf } from '../middleware/auth';
import { adminScopeEnabled } from '../services/adminScope';
import { rehearsalTenantIds } from '../compliance/zatca/regime';
import { taxModeZatcaConflictBody, taxModeZatcaConflicts } from '../compliance/zatca/settingsGuards';
import type { AuthRequest } from '../types';

export interface TaxModeDeps {
  db: Pick<PrismaClient, 'companySettings' | 'admin' | 'tenant'>;
  /** هل المستخدم مقيّد النطاق؟ (الإنتاج: services/adminScope.adminScopeEnabled — من القاعدة لا التوكن) */
  scopeEnabled(req: AuthRequest): Promise<boolean>;
  tenantId(req: AuthRequest): string;
  /** سطر التدقيق (JSON) — افتراضياً console.warn */
  audit?(line: string): void;
  /** حارس صلاحية «إعدادات الشركة» للتغيير (الإنتاج: requireAdminPermission('canManageCompanySettings')) — يُحقن في الاختبار */
  permission?: RequestHandler;
  /** بيئة قائمة البروفة ZATCA_REHEARSAL_TENANT_IDS (افتراضياً process.env، تُقرأ لكل طلب) */
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
}

export const TAX_MODE_AUDIT_EVENT = 'TAX_MODE_TOGGLE';

export const TAX_MODE_ROUTE_CODES = Object.freeze({
  API_KEY_FORBIDDEN: 'هذا الإجراء غير متاح بمفتاح API',
  TAX_MODE_SCOPED: 'حسابك مقيد بنطاق محدد — إزالة الضريبة لمدير الشركة غير المقيد',
  TAX_MODE_ADMIN_ONLY: 'إزالة الضريبة لمدير الشركة وحده',
  COMPANY_SETTINGS_MISSING: 'احفظ بيانات الشركة أولا',
});

const auditId = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, 128) : null);

/** سطر التدقيق: معرّفات الشركة والفاعل ودوره وهل هي جلسة المالك والحالة الجديدة — لا قيم أخرى. */
export function taxModeAuditLine(f: { tenantId: string; actorId: string; role: string; impersonated: boolean; taxDisabled: boolean }): string {
  return JSON.stringify({
    event: TAX_MODE_AUDIT_EVENT,
    tenantId: auditId(f.tenantId),
    actorId: auditId(f.actorId),
    role: auditId(f.role),
    impersonated: f.impersonated === true,
    taxDisabled: f.taxDisabled === true,
  });
}

const bodySchema = z.object({ taxDisabled: z.boolean() });

type Code = keyof typeof TAX_MODE_ROUTE_CODES;
const refuse = (res: Response, status: number, code: Code) => {
  res.status(status).json({ success: false, code, message: TAX_MODE_ROUTE_CODES[code] });
};

const iso = (d: Date | null | undefined): string | null => (d instanceof Date ? d.toISOString() : null);

/** ما يقرؤه القلب من صفّ الشركة: الحالة ومرجعها، وعمودا المرحلة الثانية (التفعيل الحيّ والتسليح) */
const MODE_SELECT = { taxDisabled: true, taxModeChangedAt: true, zatcaPhase2StartedAt: true, zatcaGoLiveArmedAt: true } as const;

export function createTaxModeRouter(deps: TaxModeDeps): Router {
  const router = Router();
  const audit = deps.audit ?? ((line: string) => console.warn(line));
  const now = deps.now ?? (() => new Date());
  // مستخدمو الشركة وحدهم (المندوب 403 كسائر موجّهات الشركة — العلم يصله في GET /api/company)
  router.use(requireAdmin);

  router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const row = await deps.db.companySettings.findUnique({ where: { tenantId: deps.tenantId(req) }, select: { taxDisabled: true, taxModeChangedAt: true } });
      res.json({ success: true, data: { taxDisabled: row?.taxDisabled === true, taxModeChangedAt: iso(row?.taxModeChangedAt) } });
    } catch (err) { next(err); }
  });

  router.patch('/', deps.permission ?? requireAdminPermission('canManageCompanySettings'), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      // ١) قرارٌ ضريبي أمام تحذيره — لا يُتّخذ بمفتاح برمجي
      if (req.user?.apiKeyId) { refuse(res, 403, 'API_KEY_FORBIDDEN'); return; }
      const impersonated = req.user?.impersonated === true;
      // ٢) المقيّد بنطاق لا يقرّر للشركة كلها (جلسة المالك لا نطاق لها)
      if (!impersonated && await deps.scopeEnabled(req)) { refuse(res, 403, 'TAX_MODE_SCOPED'); return; }
      const tid = deps.tenantId(req);
      // ٣) الدور من القاعدة لا من التوكن: مديرٌ نشطٌ في الشركة نفسها، أو جلسة المالك (بلا شرط الدور، والعزل باقٍ)
      const actor = await deps.db.admin.findUnique({ where: { id: req.user?.id ?? '' }, select: { role: true, tenantId: true, isActive: true } });
      if (!(actor?.tenantId === tid && actor.isActive === true && (impersonated || actor.role === 'ADMIN'))) {
        refuse(res, 403, 'TAX_MODE_ADMIN_ONLY');
        return;
      }
      // ٤) الجسم — ZodError إلى المعالج العام (400)
      const { taxDisabled } = bodySchema.parse(req.body);
      // ٥) الحالة الحالية، وعلم المالك للإزالة وحدها
      const [row, tenant] = await Promise.all([
        deps.db.companySettings.findUnique({ where: { tenantId: tid }, select: MODE_SELECT }),
        taxDisabled ? deps.db.tenant.findUnique({ where: { id: tid }, select: { zatcaPhase2Enabled: true } }) : Promise.resolve(null),
      ]);
      if (!row) { refuse(res, 409, 'COMPANY_SETTINGS_MISSING'); return; }
      const rehearsal = rehearsalTenantIds(deps.env ?? process.env).has(tid);
      const conflictsOf = (r: { zatcaPhase2StartedAt: Date | null; zatcaGoLiveArmedAt: Date | null }) =>
        taxModeZatcaConflicts({ tenantFlag: tenant?.zatcaPhase2Enabled, liveAt: r.zatcaPhase2StartedAt, armedAt: r.zatcaGoLiveArmedAt, rehearsal });
      // ٦) الإزالة ممنوعة ما دام ربط المرحلة الثانية (§2 من خريطة الامتثال)
      if (taxDisabled) {
        const reasons = conflictsOf(row);
        if (reasons.length) { res.status(409).json(taxModeZatcaConflictBody(reasons)); return; }
      }
      // ٧) القيمة نفسها: لا كتابة ولا تدقيق — المرجع taxModeChangedAt لا يتقدّم بحفظٍ بلا تغيير
      if ((row.taxDisabled === true) === taxDisabled) {
        res.json({ success: true, data: { taxDisabled, taxModeChangedAt: iso(row.taxModeChangedAt) } });
        return;
      }
      // ٨) كتابة واحدة مشروطة (CAS): من الحالة السابقة، والإزالة بلا تسليحٍ ولا تفعيلٍ لحظة الكتابة نفسها
      const at = now();
      const r = await deps.db.companySettings.updateMany({
        where: taxDisabled
          ? { tenantId: tid, taxDisabled: false, zatcaPhase2StartedAt: null, zatcaGoLiveArmedAt: null }
          : { tenantId: tid, taxDisabled: true },
        data: { taxDisabled, taxModeChangedAt: at, taxModeChangedBy: actorOf(req) },
      });
      if (r.count === 0) {
        // سباق نادر: حُذف الصفّ، أو سبقنا قلبٌ مماثل (يُعاد كما هو بلا تدقيق)، أو سُلِّحت الشركة/فُعّلت بين القراءة والكتابة
        const cur = await deps.db.companySettings.findUnique({ where: { tenantId: tid }, select: MODE_SELECT });
        if (!cur) { refuse(res, 409, 'COMPANY_SETTINGS_MISSING'); return; }
        if ((cur.taxDisabled === true) === taxDisabled) {
          res.json({ success: true, data: { taxDisabled, taxModeChangedAt: iso(cur.taxModeChangedAt) } });
          return;
        }
        res.status(409).json(taxModeZatcaConflictBody(conflictsOf(cur)));
        return;
      }
      // ٩) التدقيق
      audit(taxModeAuditLine({ tenantId: tid, actorId: req.user?.id ?? '', role: actor.role, impersonated, taxDisabled }));
      res.json({ success: true, data: { taxDisabled, taxModeChangedAt: at.toISOString() } });
    } catch (err) { next(err); }
  });

  return router;
}

export default createTaxModeRouter({
  db: prisma,
  scopeEnabled: adminScopeEnabled,
  tenantId: tenantIdOf,
  audit: line => console.warn(line),
});
