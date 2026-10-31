import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { actorOf, isOwnerSession, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { regimeCandidate } from '../compliance/zatca/regime';
import { auditOwnerImpersonationWrite, zatcaActorId } from './zatca';
import {
  normalizeReturnPolicy, returnLinkDefault, returnLinkRequired, returnPolicyOutcome, returnPolicyPhase2, storedReturnPolicy,
} from '../services/returnPolicy';

/**
 * «اشتراط اختيار فاتورة البيع للمرتجع» (قرار المالك ٣١ أكتوبر ٢٠٢٦) — مُركَّبٌ تحت /api/company/return-policy (routes/company.ts)
 * بعد authenticate. الحفظ وحده (PUT): القراءة من GET /api/company (العمود خامٌ فيه، والجهاز يخبّئه أوف-لاين).
 *
 * لمدير الشركة وحده: دوره ADMIN من القاعدة لا التوكن (يعيش ٨ ساعات)، نشطٌ في الشركة نفسها وغير مقيّد النطاق — وجلسة
 * دخول المالك تعمل كحساب المدير الذي يمثّله توكنها (بسطر تدقيقها). ومفتاح API مرفوض دائماً: الإعداد يغيّر مستندات ضريبية.
 * والقيمة المساوية لافتراضيّ المرحلة تُحفظ null (services/returnPolicy.ts normalizeReturnPolicy).
 *
 * PUT /api/company وcompanySchema لم يُمسّا عمداً: حارس قفل ZATCA (company-zatca-lock.test.ts) يثبّت قراءتيه بالعدد.
 */
const router = Router();

const COMPANY_SETTINGS_MISSING = 'احفظ بيانات الشركة أولا';
const ADMIN_ONLY = 'هذا الإعداد لمدير الشركة وحده';

const bodySchema = z.object({ requireSaleInvoice: z.boolean().nullable() }).strict();

router.put('/', requireAdmin, requireAdminPermission('canManageCompanySettings'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // مفتاح API يحمل دور مُصدِره — والإعداد يقرّر هل يصدر إشعارٌ دائن بلا فاتورة في النظام: من اللوحة وحدها
    if (req.user?.apiKeyId) { res.status(403).json({ success: false, code: 'API_KEY_FORBIDDEN', message: 'هذا الإجراء غير متاح بمفتاح API' }); return; }
    const tid = tenantId(req);
    const owner = isOwnerSession(req);
    if (owner) auditOwnerImpersonationWrite(res, { tenantId: tid, actorAdminId: req.user!.id, action: 'company.return-policy' });
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ success: false, code: 'RETURN_POLICY_INVALID', message: 'قيمة الإعداد غير صحيحة — requireSaleInvoice: true أو false أو null' });
      return;
    }
    // الدور من القاعدة (كحقول البائع في PUT /api/company): مديرٌ نشطٌ في الشركة نفسها غير مقيّد النطاق، أو جلسة المالك
    const actor = await prisma.admin.findUnique({ where: { id: req.user!.id }, select: { role: true, tenantId: true, isActive: true, scopeEnabled: true } });
    if ((actor?.role !== 'ADMIN' && !owner) || actor?.tenantId !== tid || actor?.isActive !== true || (actor.scopeEnabled === true && !owner)) {
      res.status(403).json({ success: false, code: 'RETURN_POLICY_ADMIN_ONLY', message: ADMIN_ONLY });
      return;
    }
    const [row, tenant] = await Promise.all([
      prisma.companySettings.findUnique({
        where: { tenantId: tid },
        select: { countryCode: true, einvoiceProvider: true, zatcaPhase2StartedAt: true, returnRequiresSaleInvoice: true, returnPolicyChangedAt: true },
      }),
      prisma.tenant.findUnique({ where: { id: tid }, select: { zatcaPhase2Enabled: true } }),
    ]);
    if (!row) { res.status(409).json({ success: false, code: 'COMPANY_SETTINGS_MISSING', message: COMPANY_SETTINGS_MISSING }); return; }
    // افتراضيّ المرحلة كما يقرّره الإصدار نفسه (مفعّلة حيّاً، أو بروفة بعلم المالك) — لا تخمينٌ من العلم وحده
    const candidate = regimeCandidate({
      tenantId: tid,
      settings: { countryCode: row.countryCode ?? null, einvoiceProvider: row.einvoiceProvider ?? null, zatcaPhase2StartedAt: row.zatcaPhase2StartedAt ?? null, taxNumber: null },
      env: process.env,
    });
    const phase2 = returnPolicyPhase2({ candidate, tenantFlag: tenant?.zatcaPhase2Enabled, countryCode: row.countryCode, einvoiceProvider: row.einvoiceProvider });
    const before = storedReturnPolicy(row.returnRequiresSaleInvoice);
    const stored = normalizeReturnPolicy(parsed.data.requireSaleInvoice, phase2);
    const effective = returnLinkRequired(stored, phase2);
    let changedAt: Date | null = row.returnPolicyChangedAt ?? null;
    if (stored !== before) {
      const at = new Date();
      // شركة فوترةٍ إلكترونية (علم المالك أو مفعّلة): أثرٌ في zatca_api_logs بالمعاملة نفسها — قرارٌ يمسّ مستندات ضريبية لا يمرّ بلا سجلّ
      const zatcaTenant = tenant?.zatcaPhase2Enabled === true || row.zatcaPhase2StartedAt != null;
      const written = await prisma.$transaction(async (tx) => {
        // كتابة واحدة على صفّ الشركة — count 0 = لا صفّ ⇒ 409 بلا إنشاء
        const r = await tx.companySettings.updateMany({
          where: { tenantId: tid },
          data: { returnRequiresSaleInvoice: stored, returnPolicyChangedAt: at, returnPolicyChangedBy: actorOf(req) },
        });
        if (r.count === 0) return false;
        if (zatcaTenant) {
          await tx.zatcaApiLog.create({
            data: {
              tenantId: tid, actorId: zatcaActorId(req.user!), endpoint: 'ui:return-policy', outcome: returnPolicyOutcome(stored),
              response: { before, after: stored, effective, phaseDefault: returnLinkDefault(phase2) },
            },
          });
        }
        return true;
      });
      if (!written) { res.status(409).json({ success: false, code: 'COMPANY_SETTINGS_MISSING', message: COMPANY_SETTINGS_MISSING }); return; }
      changedAt = at;
    }
    res.json({
      success: true,
      data: { requireSaleInvoice: stored, effective, phaseDefault: returnLinkDefault(phase2), changedAt: changedAt ? changedAt.toISOString() : null },
    });
  } catch (err) { next(err); }
});

export default router;
