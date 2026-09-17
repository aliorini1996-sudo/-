import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { getCountryTax, OVERRIDE_CURRENCIES } from '../config/countries';
import { ZATCA_ROUTE_CODES, auditOwnerImpersonationWrite, companyZatcaFieldChanges } from './zatca';
import { phase2LockedSettingChanges, phase2SettingsLockedBody } from '../compliance/zatca/settingsGuards';

const router = Router();
router.use(authenticate);

const companySchema = z.object({
  name: z.string().min(1),
  address: z.string().nullish(),
  taxNumber: z.string().nullish(),
  commercialReg: z.string().nullish(),
  phone: z.string().nullish(),
  email: z.string().email().nullish().or(z.literal('')),
  logo: z.string().nullish().or(z.literal('')),        // base64 data URL
  primaryColor: z.string().nullish().or(z.literal('')), // hex
  headerStyle: z.enum(['classic', 'banner', 'minimal']).nullish(),
  numerals: z.enum(['arabic', 'latin']).nullish(),
  countryCode: z.string().length(2).nullish(),          // دولة الشركة (تُشتقّ منها العملة والضريبة)
  currencyOverride: z.enum(['USD', 'EUR']).nullish().or(z.literal('')), // '' أو null = عملة الدولة
  // بيانات ربط الفوترة الإلكترونية (تُدخلها الشركة نفسها)
  einvoiceEnabled: z.boolean().nullish(),
  einvoiceEnv: z.enum(['preprod', 'production']).nullish(),
  einvoiceClientId: z.string().nullish().or(z.literal('')),
  einvoiceClientSecret: z.string().nullish().or(z.literal('')),
  einvoiceActivityCode: z.string().nullish().or(z.literal('')),
  einvoiceBranchCode: z.string().nullish().or(z.literal('')),
  einvoiceIntermediaryUrl: z.string().nullish().or(z.literal('')),
});

// لا نُعيد السرّ للواجهة إطلاقاً — نستبدله بمؤشّر «مضبوط أم لا»
function maskCompany<T extends Record<string, unknown> | null>(c: T): T {
  if (!c) return c;
  const { einvoiceClientSecret, ...rest } = c as Record<string, unknown>;
  return { ...rest, einvoiceHasSecret: !!einvoiceClientSecret } as unknown as T;
}

// إعدادات شركة المستخدم الحالي — متاح لأي مستخدم مسجّل (المندوب يحتاجه للطباعة)
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const company = await prisma.companySettings.findUnique({ where: { tenantId: tid } });
    // نُرفق أعلام الاشتراك التي يتحكّم بها المالك (لإظهار/إخفاء الميزات في الواجهة)
    const tenant = await prisma.tenant.findUnique({ where: { id: tid }, select: { erpEnabled: true, petroappEnabled: true, hatifEnabled: true, catalogEnabled: true, paylinkEnabled: true, warehouseEnabled: true, receivablesSummaryEnabled: true, accountingEnabled: true, dailyReportEnabled: true, invoiceSignatureEnabled: true, accountingSuiteEnabled: true, zatcaPhase2Enabled: true } });
    const data = { ...(maskCompany(company as Record<string, unknown> | null) as object), erpEnabled: !!tenant?.erpEnabled, petroappEnabled: !!tenant?.petroappEnabled, hatifEnabled: !!tenant?.hatifEnabled, catalogEnabled: !!tenant?.catalogEnabled, paylinkEnabled: !!tenant?.paylinkEnabled, warehouseEnabled: !!tenant?.warehouseEnabled, receivablesSummaryEnabled: !!tenant?.receivablesSummaryEnabled, accountingEnabled: tenant?.accountingEnabled !== false, dailyReportEnabled: tenant?.dailyReportEnabled === true, invoiceSignatureEnabled: tenant?.invoiceSignatureEnabled === true, accountingSuiteEnabled: tenant?.accountingSuiteEnabled === true, zatcaPhase2Enabled: tenant?.zatcaPhase2Enabled === true };
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// التعديل للإدارة فقط — ضمن شركة المستخدم
router.put('/', requireAdmin, requireAdminPermission('canManageCompanySettings'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = companySchema.parse(req.body);
    const clean: Record<string, unknown> = {
      ...data,
      email: data.email || null,
      logo: data.logo || null,
      primaryColor: data.primaryColor || null,
      einvoiceClientId: data.einvoiceClientId || null,
      einvoiceActivityCode: data.einvoiceActivityCode || null,
      einvoiceBranchCode: data.einvoiceBranchCode || null,
      einvoiceIntermediaryUrl: data.einvoiceIntermediaryUrl || null,
    };
    // السرّ لا يُكتب إلا عند إرسال قيمة جديدة غير فارغة (حتى لا يُمحى عند الحفظ بعد إخفائه)
    if (data.einvoiceClientSecret && data.einvoiceClientSecret.trim()) clean.einvoiceClientSecret = data.einvoiceClientSecret.trim();
    else delete clean.einvoiceClientSecret;
    // عند تحديد الدولة: نشتقّ العملة والضريبة ومزوّد الفوترة من السجلّ الموثوق (لا نثق بقيم العميل)
    if (data.countryCode) {
      const country = getCountryTax(data.countryCode);
      clean.countryCode = country.code;
      clean.currency = country.currency;
      clean.defaultVatPct = country.defaultVatPct;
      clean.einvoiceProvider = country.provider;
    } else {
      delete clean.countryCode; // لا نلمس إعداد الدولة إن لم يُرسَل
    }
    // ربط فوترة ZATCA المرحلة الثانية (علم المالك): الرقم الضريبي والسجل التجاري والدولة تغذّي شهادة الوحدة وبوابة /api/zatca —
    // تغييرها لمدير الشركة وحده (دوره من القاعدة لا التوكن) غير مقيّد النطاق (كبوابة /api/zatca)، وبصيغ PUT /api/zatca/seller
    // ومعالجتها. جلسة دخول مالك المنصة تعمل كحساب المدير الذي يمثّله توكنها (قرار المالك 17 سبتمبر 2026) بسطر تدقيق واحد
    {
      const flag = await prisma.tenant.findUnique({ where: { id: tid }, select: { zatcaPhase2Enabled: true } });
      if (flag?.zatcaPhase2Enabled === true) {
        const current = await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { taxNumber: true, commercialReg: true, countryCode: true } });
        const z = companyZatcaFieldChanges(current, { taxNumber: data.taxNumber, commercialReg: data.commercialReg, countryCode: clean.countryCode as string | undefined });
        if (z.changed.length > 0) {
          // أسماء الحقول المتغيّرة وحالة الردّ فقط — لا قيمها
          if (req.user?.impersonated === true) {
            auditOwnerImpersonationWrite(res, { tenantId: tid, actorAdminId: req.user.id, action: 'company.seller-fields', fields: z.changed });
          }
          const actor = await prisma.admin.findUnique({ where: { id: req.user!.id }, select: { role: true, tenantId: true, isActive: true, scopeEnabled: true } });
          if (actor?.role !== 'ADMIN' || actor.tenantId !== tid || actor.isActive !== true) {
            res.status(403).json({ success: false, code: 'SELLER_FIELDS_ADMIN_ONLY', message: ZATCA_ROUTE_CODES.SELLER_FIELDS_ADMIN_ONLY, fields: z.changed });
            return;
          }
          // مدير مقيّد النطاق: بوابة /api/zatca تردّه SCOPED_ADMIN (ومنها PUT /seller) — فلا يغيّر الحقول نفسها من هنا
          if (actor.scopeEnabled === true) {
            res.status(403).json({ success: false, code: 'SELLER_FIELDS_SCOPED', message: ZATCA_ROUTE_CODES.SELLER_FIELDS_SCOPED, fields: z.changed });
            return;
          }
          if (z.errors.length > 0) {
            res.status(400).json({ success: false, code: 'SELLER_INVALID', message: ZATCA_ROUTE_CODES.SELLER_INVALID, fieldErrors: z.errors });
            return;
          }
        }
        Object.assign(clean, z.write);
        for (const f of z.unchanged) delete clean[f];
      }
    }
    // تجاوز العملة (دولار/يورو): يغلب عملة الدولة، والدولة تبقى للضريبة والفوترة.
    // القيمة تؤخذ من الطلب إن أُرسلت، وإلا من المحفوظ — كي لا يمحو حفظٌ عاديّ تجاوزاً قائماً.
    {
      const existing = await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { currencyOverride: true, countryCode: true, currency: true, einvoiceProvider: true, zatcaPhase2StartedAt: true } });
      const sent = 'currencyOverride' in (req.body ?? {});
      const override = sent ? (data.currencyOverride || null) : (existing?.currencyOverride ?? null);
      clean.currencyOverride = override;
      if (override && OVERRIDE_CURRENCIES[override]) {
        clean.currency = OVERRIDE_CURRENCIES[override].currency;
      } else if (!data.countryCode && sent) {
        // أُزيل التجاوز دون تغيير الدولة ⇒ نرجع لعملة الدولة المحفوظة
        clean.currency = getCountryTax(existing?.countryCode).currency;
      }
      // فوترة ZATCA (Z5.0، D9): بعد التفعيل الحيّ لا تتغيّر الدولة ولا العملة ولا تجاوزها ولا المزوّد — مقارنةً بالقيم المشتقّة
      // النهائية (حفظ بلا تغيير فعلي يمرّ). شركة غير مفعّلة (zatcaPhase2StartedAt فارغ) ⇒ لا شيء يتغيّر عمّا اليوم
      const zatcaLocked = phase2LockedSettingChanges(existing, clean);
      if (zatcaLocked.length > 0) {
        res.status(409).json(phase2SettingsLockedBody(zatcaLocked));
        return;
      }
    }
    const company = await prisma.companySettings.upsert({
      where: { tenantId: tid },
      update: clean,
      create: { tenantId: tid, ...clean } as any,
    });
    res.json({ success: true, data: maskCompany(company as Record<string, unknown> | null) });
  } catch (err) { next(err); }
});

export default router;

