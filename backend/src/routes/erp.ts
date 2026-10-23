import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { refuseStaffCredentials } from '../services/platformAccess';
import { isErpSyncRunning, startErpSync, testErpConnection } from '../services/erp';
import { erpUrlProblem } from '../services/erpPayload';
import { sealErpSecret } from '../services/erpSecrets';
import { adminScopeEnabled } from '../services/adminScope';

const router = Router();
router.use(authenticate, requireAdmin, requireAdminPermission('canManageCompanySettings'));

// بوابة الاشتراك: ميزة ربط ERP متاحة فقط للشركات التي فعّل لها المالك الصلاحية (erpEnabled)
router.use(async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId(req) }, select: { erpEnabled: true } });
    if (!t?.erpEnabled) {
      res.status(403).json({ success: false, code: 'ERP_NOT_ALLOWED', message: 'ميزة ربط ERP غير مفعلة لاشتراك شركتك تواصل مع مزود الخدمة لتفعيلها' });
      return;
    }
    next();
  } catch (err) { next(err); }
});

/**
 * ربط ERP ممنوع على المستخدم مقيّد النطاق — **على مستوى الراوتر لا المسار**.
 *
 * المزامنة تصدّر عملاء الشركة وفواتيرها وسنداتها **كاملةً إلى نظام خارجيّ**،
 * وصفحة الإعدادات تحدّد عنوان ذلك النظام ومفتاحه. تقييد الاستعلامات هنا لا
 * يكفي: من يملك تغيير الوجهة يملك سحب ما لا يراه. والحارس على الراوتر كي لا
 * يفلت مسار يُضاف لاحقاً.
 */
router.use(async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (await adminScopeEnabled(req)) {
      res.status(403).json({
        success: false,
        message: 'حسابك مقيد بنطاق محدد ربط ERP وتصدير بيانات الشركة يحتاج صلاحية غير مقيدة',
      });
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
    res.json({ success: true, data: config ? { ...publicSettings(config), syncRunning: isErpSyncRunning(tenantId(req)) } : null });
  } catch (err) { next(err); }
});

router.put('/settings', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // عنوان خادم ERP ومفاتيحه قناةٌ تُرسل إليها بيانات الشركة في كل مزامنة لاحقة — لا يضبطها موظف المنصة في جلسة «دخول»
    if (refuseStaffCredentials(req, res)) return;
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

    // رابطٌ آمن قبل الحفظ (https، بلا بيانات دخول فيه، لا عنوان داخلي ظاهر) — والفحص الكامل بحلّ الاسم عند كل اتصال
    const urlProblem = data.baseUrl ? erpUrlProblem(String(data.baseUrl)) : null;
    if (urlProblem) { res.status(400).json({ success: false, message: urlProblem }); return; }
    // المفاتيح مشفّرة في القاعدة (services/erpSecrets.ts)
    if (body.apiKey?.trim()) data.apiKey = sealErpSecret(tid, body.apiKey.trim());
    if (body.bearerToken?.trim()) data.bearerToken = sealErpSecret(tid, body.bearerToken.trim());
    if (body.basicPassword?.trim()) data.basicPassword = sealErpSecret(tid, body.basicPassword.trim());

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
    if (!config) { res.status(400).json({ success: false, message: 'احفظ إعدادات ERP أولا' }); return; }
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
    const config = await prisma.erpIntegration.findUnique({ where: { tenantId: tid }, select: { enabled: true, baseUrl: true } });
    if (!config?.enabled) { res.status(400).json({ success: false, message: 'تكامل ERP غير مفعل' }); return; }
    if (!config.baseUrl) { res.status(400).json({ success: false, message: 'رابط ERP مطلوب' }); return; }
    // في الخلفية: أول مزامنة قد تطول دقائق (كل السجلات على دفعات) — النتيجة في سجلّ المزامنة
    const started = startErpSync(tid, body.resource === 'all' ? undefined : body.resource);
    if (!started) { res.status(409).json({ success: false, code: 'ERP_SYNC_RUNNING', message: 'مزامنة جارية — انتظر انتهاءها' }); return; }
    res.status(202).json({ success: true, data: { started: true, resource: body.resource } });
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
