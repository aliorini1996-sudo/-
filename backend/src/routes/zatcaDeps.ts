// ============================================================================
// ZATCA المرحلة الثانية — اعتماديات مسارات /api/zatca في الإنتاج (Prisma، المصادقة، البيئة، حلقة المفاتيح)
// ----------------------------------------------------------------------------
// مفصولة عن routes/zatca.ts عمداً: اختبارات الموجّه تحقن مخزن ذاكرة ولا تستورد config/database إطلاقاً.
// لا شيء هنا يتصل بقاعدة البيانات أو الشبكة عند الإنشاء: الاستعلامات تجري عند الطلب، وحلقة المفاتيح تُقرأ
// لكل طلب (مفتاح مفقود ⇒ 503 من الموجّه، لا انهيار عند الإقلاع).
// ============================================================================

import prisma from '../config/database';
import { authenticate } from '../middleware/auth';
import { adminScopeEnabled } from '../services/adminScope';
import { defaultFatooraClientFactory } from '../compliance/zatca/onboarding';
import { prismaEgsUnitStore } from '../compliance/zatca/onboardingStore';
import { keyringFromEnv } from '../compliance/zatca/secrets';
import { ZatcaRouteDeps, zatcaEnvConfig } from './zatca';
import { buyerDataReadiness } from './customersZatca';

export function productionZatcaDeps(env: NodeJS.ProcessEnv = process.env): ZatcaRouteDeps {
  return {
    authenticate,
    // صفّ الحساب من القاعدة لكل طلب (لا دور التوكن): الموجّه يشترط isActive وrole ADMIN وشركة التوكن وcanManageCompanySettings !== false
    loadAdmin: async req => (req.user?.id
      ? prisma.admin.findUnique({ where: { id: req.user.id }, select: { isActive: true, role: true, tenantId: true, canManageCompanySettings: true } })
      : null),
    isScopeRestricted: adminScopeEnabled,
    // مطفأ افتراضياً: === true وحدها تفتح (تعذّر القراءة يمنع)
    loadTenantFlag: async tenantId =>
      (await prisma.tenant.findUnique({ where: { id: tenantId }, select: { zatcaPhase2Enabled: true } }))?.zatcaPhase2Enabled === true,
    store: prismaEgsUnitStore(prisma),
    // updateMany لا update: شركة بلا صفّ إعدادات ⇒ count 0 ⇒ 404 بدل خطأ Prisma
    writeSeller: async (tenantId, patch) => (await prisma.companySettings.updateMany({ where: { tenantId }, data: patch })).count === 1,
    loadKeyring: () => keyringFromEnv(env),
    clientFactory: defaultFatooraClientFactory,
    now: () => new Date(),
    config: zatcaEnvConfig(env),
    // Z5.1a (D2): عدّادات جاهزية بيانات الفوترة (مسح محدود بالمؤشّر، إعلامي)
    loadReadiness: tenantId => buyerDataReadiness(prisma, tenantId),
  };
}
