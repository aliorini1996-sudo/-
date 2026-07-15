import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { syncErpAll, syncErpResource, testErpConnection } from '../services/erp';

const router = Router();
router.use(authenticate, requireAdmin, requireAdminPermission('canManageCompanySettings'));

// بوابة الاشتراك: ميزة ربط ERP متاحة فقط للشركات التي فعّل لها المالك الصلاحية (erpEnabled)
router.use(async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId(req) }, select: { erpEnabled: true } });
    if (!t?.erpEnabled) {
      res.status(403).json({ success: false, code: 'ERP_NOT_ALLOWED', message: 'ميزة ربط ERP غير مفعّلة لاشتراك شركتك — تواصل مع مزوّد الخدمة لتفعيلها.' });
      return;
    }
    next();
  } catch (err) { next(err); }
});

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(['CUSTOM', 'ODOO', 'SAP', 'ZOHO', 'OTHER']).optional(),
  baseUrl: z.string().url().optional().or(z.literal('')),
  authType: z.enum(['NONE', 'API_KEY', 'BEARER', 'BASIC']).optional(),
  apiKey: z.string().optional(),
  bearerToken: z.string().optional(),
  basicUsername: z.string().optional(),
  basicPassword: z.string().optional(),
  customersEndpoint: z.string().optional(),
  productsEndpoint: z.string().optional(),
  invoicesEndpoint: z.string().optional(),
  receiptsEndpoint: z.string().optional(),
  syncCustomers: z.boolean().optional(),
  syncProducts: z.boolean().optional(),
  syncInvoices: z.boolean().optional(),
  syncReceipts: z.boolean().optional(),
});

function publicSettings(config: any) {
  if (!config) return null;
  const { apiKey, bearerToken, basicPassword, ...safe } = config;
  return {
    ...safe,
    hasApiKey: !!apiKey,
    hasBearerToken: !!bearerToken,
    hasBasicPassword: !!basicPassword,
  };
}

router.get('/settings', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const config = await prisma.erpIntegration.findUnique({ where: { tenantId: tenantId(req) } });
    res.json({ success: true, data: publicSettings(config) });
  } catch (err) { next(err); }
});

router.put('/settings', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = settingsSchema.parse(req.body);
    const data: Record<string, unknown> = {
      enabled: body.enabled ?? false,
      provider: body.provider ?? 'CUSTOM',
      baseUrl: body.baseUrl || null,
      authType: body.authType ?? 'NONE',
      basicUsername: body.basicUsername || null,
      customersEndpoint: body.customersEndpoint || null,
      productsEndpoint: body.productsEndpoint || null,
      invoicesEndpoint: body.invoicesEndpoint || null,
      receiptsEndpoint: body.receiptsEndpoint || null,
      syncCustomers: body.syncCustomers ?? true,
      syncProducts: body.syncProducts ?? true,
      syncInvoices: body.syncInvoices ?? true,
      syncReceipts: body.syncReceipts ?? true,
    };

    if (body.apiKey?.trim()) data.apiKey = body.apiKey.trim();
    if (body.bearerToken?.trim()) data.bearerToken = body.bearerToken.trim();
    if (body.basicPassword?.trim()) data.basicPassword = body.basicPassword.trim();

    const config = await prisma.erpIntegration.upsert({
      where: { tenantId: tid },
      update: data,
      create: { tenantId: tid, ...data },
    });
    res.json({ success: true, data: publicSettings(config) });
  } catch (err) { next(err); }
});

router.post('/test', async (req: AuthRequest, res: Response, next: NextFunction) => {
  const tid = tenantId(req);
  const startedAt = new Date();
  try {
    const config = await prisma.erpIntegration.findUnique({ where: { tenantId: tid } });
    if (!config) { res.status(400).json({ success: false, message: 'احفظ إعدادات ERP أولاً' }); return; }
    const result = await testErpConnection(config);
    await prisma.erpSyncLog.create({
      data: { tenantId: tid, resource: 'connection', status: result.ok ? 'SUCCESS' : 'FAILED', count: 0, message: result.message, startedAt, finishedAt: new Date() },
    });
    res.json({ success: result.ok, data: result, message: result.message });
  } catch (err) {
    await prisma.erpSyncLog.create({
      data: { tenantId: tid, resource: 'connection', status: 'FAILED', count: 0, message: (err as Error).message, startedAt, finishedAt: new Date() },
    }).catch(() => {});
    next(err);
  }
});

router.post('/sync', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = z.object({ resource: z.enum(['all', 'customers', 'products', 'invoices', 'receipts']).default('all') }).parse(req.body || {});
    const result = body.resource === 'all' ? await syncErpAll(tid) : await syncErpResource(tid, body.resource);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

router.get('/logs', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const logs = await prisma.erpSyncLog.findMany({
      where: { tenantId: tenantId(req) },
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
    res.json({ success: true, data: logs });
  } catch (err) { next(err); }
});

export default router;
