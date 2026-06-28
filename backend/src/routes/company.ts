import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';

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
});

// Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø´Ø±ÙƒØ© Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… Ø§Ù„Ø­Ø§Ù„ÙŠ â€” Ù…ØªØ§Ø­ Ù„Ø£ÙŠ Ù…Ø³ØªØ®Ø¯Ù… Ù…Ø³Ø¬Ù‘Ù„ (Ø§Ù„Ù…Ù†Ø¯ÙˆØ¨ ÙŠØ­ØªØ§Ø¬Ù‡ Ù„Ù„Ø·Ø¨Ø§Ø¹Ø©)
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const company = await prisma.companySettings.findUnique({ where: { tenantId: tid } });
    res.json({ success: true, data: company });
  } catch (err) { next(err); }
});

// Ø§Ù„ØªØ¹Ø¯ÙŠÙ„ Ù„Ù„Ø¥Ø¯Ø§Ø±Ø© ÙÙ‚Ø· â€” Ø¶Ù…Ù† Ø´Ø±ÙƒØ© Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù…
router.put('/', requireAdmin, requireAdminPermission('canManageCompanySettings'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = companySchema.parse(req.body);
    const clean = {
      ...data,
      email: data.email || null,
      logo: data.logo || null,
      primaryColor: data.primaryColor || null,
    };
    const company = await prisma.companySettings.upsert({
      where: { tenantId: tid },
      update: clean,
      create: { tenantId: tid, ...clean } as any,
    });
    res.json({ success: true, data: company });
  } catch (err) { next(err); }
});

export default router;

