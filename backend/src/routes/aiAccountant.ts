/**
 * «المحاسب الذكي AI» — المسارات (/api/ai-accountant)، طلب المالك ١٧ نوفمبر ٢٠٢٦.
 *
 * خامل عند أي شركة لم يفعّل لها المالك Tenant.aiAccountantEnabled. سلسلة الحراسة بالترتيب:
 *   authenticate ⇒ requireAdmin ⇒ requireAiAccountant (ACCOUNTING_NOT_ALLOWED ثم AI_ACCOUNTANT_NOT_ALLOWED)
 *   ⇒ requireAdminPermission('canViewReports') ⇒ رفض المندوب ومفتاح API والمقيَّد النطاق (أرقام الشركة كلها).
 *
 *   GET  /status          ما تحتاجه الصفحة: الترحيل متاح؟ وضع الدفاتر وتفعيلها، العملة، المنطقة، اليوم المحلي، اسم الشركة
 *   POST /chat            دورة محادثة {messages 1..12 (الأخيرة للمستخدم), clientRef uuid} ⇒ {text, guard, turnId, reports, posted, warnings}
 *   GET  /posts?limit=50  «قيود المحاسب الذكي» لهذه الشركة (لمن يرى الدفاتر؛ وإلا قائمة فارغة)
 * عكس القيد: المسار القائم POST /api/ledger/moves/:moveId/reverse {reason} بحرّاس الدفاتر نفسها.
 *
 * الشركة من الجلسة وحدها في كل استعلام (tenantId(req)) — لا شيء من الجسم أو من النموذج.
 * مفاتيح البيئة: AI_ACCOUNTANT_LLM=0 يوقف المحادثة (503)، AI_ACCOUNTANT_WRITE=0 يوقف الترحيل وحده.
 */
import { Router, Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { authenticate, requireAdmin, requireAdminPermission, requireAiAccountant, tenantId } from '../middleware/auth';
import { adminScopeEnabled } from '../services/adminScope';
import { aiWriteEnabled, loadAcctCtx } from '../services/aiAccountant/context';
import { accountantChat } from '../services/aiAccountant/chat';
import { listAiPosts } from '../services/aiAccountant/writeTools';

const router = Router();

/**
 * آخر الحرّاس: المندوب مرفوض صراحةً (requireAdminPermission يمرّره)، ومفتاح API لا يحادث النموذج ولا يرحّل باسم صاحبه،
 * والمقيَّد النطاق مرفوض — التقارير والقيود على مستوى الشركة كلها (جلسة المالك لا نطاق لها: adminScopeEnabled).
 */
export async function refuseRepKeyScoped(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user || req.user.role === 'SALES_REP') {
      res.status(403).json({ success: false, code: 'AI_ACCOUNTANT_ADMIN_ONLY', message: 'المحاسب الذكي لإدارة الشركة وحدها' });
      return;
    }
    if (req.user.apiKeyId) {
      res.status(403).json({ success: false, code: 'AI_ACCOUNTANT_API_KEY', message: 'المحاسب الذكي من لوحة الشركة وحدها — لا يُستعمل بمفتاح API' });
      return;
    }
    if (await adminScopeEnabled(req)) {
      res.status(403).json({ success: false, code: 'AI_ACCOUNTANT_SCOPED', message: 'المحاسب الذكي على مستوى الشركة كلها وحسابك مقيد بنطاق محدد' });
      return;
    }
    next();
  } catch (err) { next(err); }
}

router.use(authenticate, requireAdmin, requireAiAccountant, requireAdminPermission('canViewReports'), refuseRepKeyScoped);

/** هوية الجلسة كما يحتاجها السياق — الشركة من tenantId(req) */
const userOf = (req: AuthRequest) => ({
  id: req.user!.id, role: req.user!.role, tenantId: tenantId(req), name: req.user!.name ?? null, impersonated: req.user!.impersonated === true,
  requestIp: req.ip ?? null,
});

router.get('/status', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { ctx, companyName } = await loadAcctCtx(userOf(req), { userMessages: [], clientRef: '' });
    res.json({
      success: true,
      data: {
        enabled: true,
        canPost: ctx.canPost && aiWriteEnabled(),
        booksMode: ctx.booksMode,
        booksActivated: ctx.booksActivated,
        canViewLedger: ctx.canViewLedger,
        warehouseOn: ctx.warehouseOn,
        currency: ctx.currency,
        timezone: ctx.tz,
        todayLocal: ctx.todayLocal,
        companyName,
      },
    });
  } catch (err) { next(err); }
});

router.post('/chat', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const r = await accountantChat(userOf(req), req.body);
    res.status(r.status).json(r.body);
  } catch (err) { next(err); }
});

export const POSTS_DEFAULT_LIMIT = 50;
export const POSTS_MAX_LIMIT = 200;

/** limit من الاستعلام: عددٌ صحيح ١..٢٠٠، وإلا الافتراض */
export function postsLimitOf(raw: unknown): number {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(v);
  if (v === undefined || v === '' || !Number.isFinite(n)) return POSTS_DEFAULT_LIMIT;
  return Math.min(POSTS_MAX_LIMIT, Math.max(1, Math.floor(n)));
}

router.get('/posts', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { ctx } = await loadAcctCtx(userOf(req), { userMessages: [], clientRef: '' });
    // قيود الدفاتر لمن يرى الدفاتر وحده (canViewLedger كحرّاس /api/ledger) — من رحّل يراها دائماً (الترحيل يشمل العرض)
    const rows = ctx.canViewLedger ? await listAiPosts(ctx.tenantId, postsLimitOf(req.query.limit)) : [];
    res.json({ success: true, data: { rows } });
  } catch (err) { next(err); }
});

export default router;
