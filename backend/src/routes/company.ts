import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { getCountryTax } from '../config/countries';

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
  countryCode: z.string().length(2).nullish(),          // دولة الشركة (تُشتقّ منها العملة والضريبة)
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

// إعدادات شركة المستخدم الحالي â€” متاح لأي مستخدم مسجّل (المندوب يحتاجه للطباعة)
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const company = await prisma.companySettings.findUnique({ where: { tenantId: tid } });
    res.json({ success: true, data: maskCompany(company as Record<string, unknown> | null) });
  } catch (err) { next(err); }
});

// التعديل للإدارة فقط â€” ضمن شركة المستخدم
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
    const company = await prisma.companySettings.upsert({
      where: { tenantId: tid },
      update: clean,
      create: { tenantId: tid, ...clean } as any,
    });
    res.json({ success: true, data: maskCompany(company as Record<string, unknown> | null) });
  } catch (err) { next(err); }
});

export default router;

