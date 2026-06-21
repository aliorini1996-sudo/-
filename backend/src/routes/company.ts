import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin } from '../middleware/auth';
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

// متاح لأي مستخدم مسجّل (المندوب يحتاجه لطباعة المستندات)
router.get('/', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const company = await prisma.companySettings.findUnique({ where: { id: 'company' } });
    res.json({ success: true, data: company });
  } catch (err) { next(err); }
});

// التعديل للإدارة فقط
router.put('/', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = companySchema.parse(req.body);
    const clean = {
      ...data,
      email: data.email || null,
      logo: data.logo || null,
      primaryColor: data.primaryColor || null,
    };
    const company = await prisma.companySettings.upsert({
      where: { id: 'company' },
      update: clean,
      create: { id: 'company', ...clean },
    });
    res.json({ success: true, data: company });
  } catch (err) { next(err); }
});

export default router;
