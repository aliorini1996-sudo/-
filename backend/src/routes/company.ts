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
});

// إعدادات شركة المستخدم الحالي â€” متاح لأي مستخدم مسجّل (المندوب يحتاجه للطباعة)
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const company = await prisma.companySettings.findUnique({ where: { tenantId: tid } });
    res.json({ success: true, data: company });
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
    };
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
    res.json({ success: true, data: company });
  } catch (err) { next(err); }
});

export default router;

