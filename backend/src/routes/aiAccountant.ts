/**
 * «المحاسب الذكي AI» — المسارات (/api/ai-accountant)، طلب المالك ١٧ نوفمبر ٢٠٢٦.
 *
 * خامل عند أي شركة لم يفعّل لها المالك Tenant.aiAccountantEnabled. سلسلة الحراسة بالترتيب:
 *   authenticate ⇒ requireAdmin ⇒ requireAiAccountant (ACCOUNTING_NOT_ALLOWED ثم AI_ACCOUNTANT_NOT_ALLOWED)
 *   ⇒ requireAdminPermission('canViewReports') ⇒ رفض المندوب ومفتاح API والمقيَّد النطاق (أرقام الشركة كلها).
 *
 *   GET  /status          ما تحتاجه الصفحة: الترحيل متاح؟ وضع الدفاتر وتفعيلها، العملة، المنطقة، اليوم المحلي، اسم الشركة،
 *                         وكتلة docs (رفع المستندات متاح؟ السقوف، حدّ الرسملة، أيام بقاء غير المرحّل)
 *   POST /chat            دورة محادثة {messages 1..12 (الأخيرة للمستخدم), clientRef uuid} ⇒ {text, guard, turnId, reports, posted, warnings}
 *   GET  /posts?limit=50  «قيود المحاسب الذكي» لهذه الشركة (لمن يرى الدفاتر؛ وإلا قائمة فارغة)
 * عكس القيد: المسار القائم POST /api/ledger/moves/:moveId/reverse {reason} بحرّاس الدفاتر نفسها.
 *
 * مستندات المحادثة (طلب المالك ١٨ نوفمبر ٢٠٢٦ — services/aiAccountant/documents): المستند لا يغادر المنصة (لا قارئ ذكاء
 * اصطناعي)، وحقائقه من رمز QR الزكوي (يفكّه الجهاز ويرسله في X-Zatca-Qr) أو من إدخال المستخدم، ولا يُرحَّل إلا بضغطة
 * «سجّل القيد» في البطاقة (POST /chat docConfirm).
 *   POST   /documents              خامٌ (PDF/JPEG/PNG) + X-File-Name مرمّز URI + X-Zatca-Qr اختياري ⇒ 201 {document, deduped}
 *   GET    /documents/:id          {document} — لمن يرى الدفاتر؛ غير المرحّل لرافعه وحده
 *   GET    /documents/:id/content  البايتات (nosniff، inline، no-store) بالشرط نفسه
 *   PATCH  /documents/:id          تصحيح جزئي للحقائق (نصوص عشرية) ⇒ {document} بعد إعادة الفحص؛ 409 لمستند في قيد حيّ
 *   DELETE /documents/:id          {deleted:true} ما لم يكن في قيد حيّ (يحرّر الحصة)
 * الرفع والتصحيح والحذف بشرط docsEnabledFor: AI_ACCOUNTANT_DOCS (مفعّل افتراضياً؛ 0/off تطفئ) + AI_ACCOUNTANT_WRITE +
 * المحادثة تعمل (AI_ACCOUNTANT_LLM ونموذجٌ مُعدّ — «سجّل القيد» دورةٌ فيها) + الترحيل متاح (الدفاتر مفعّلة وcanPostJournals).
 * القراءة بشرط canViewLedger.
 *
 * الشركة من الجلسة وحدها في كل استعلام (tenantId(req)) — لا شيء من الجسم أو من النموذج.
 * مفاتيح البيئة: AI_ACCOUNTANT_LLM=0 يوقف المحادثة (503)، AI_ACCOUNTANT_WRITE=0 يوقف الترحيل وحده.
 */
import express, { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { AuthRequest } from '../types';
import { authenticate, requireAdmin, requireAdminPermission, requireAiAccountant, tenantId } from '../middleware/auth';
import { adminScopeEnabled } from '../services/adminScope';
import { actorRefOf, aiWriteEnabled, loadAcctCtx, type AcctCtx } from '../services/aiAccountant/context';
import { accountantChat } from '../services/aiAccountant/chat';
import { listAiPosts } from '../services/aiAccountant/writeTools';
import { EXPENSE_CATEGORY_KEYS } from '../services/aiAccountant/posting';
import {
  ATTACHMENT_MIME_TYPES, docsEnabledFor, docsPlatformEnabled, docsStatusOf, rawBodyLimitBytes,
} from '../services/aiAccountant/documents/caps';
import {
  deleteDocument, docContent, docViewsFor, findDocForViewer, loadDocEnv, patchDocument, uploadDocument, DOC_MESSAGES,
  type DocFail, type DocsDb,
} from '../services/aiAccountant/documents/store';
import {
  ACCT_ASSET_CLASSES, ACCT_DOC_EXTRA_CATEGORIES, ACCT_DOC_TYPES, type AcctDocPatch,
} from '../services/aiAccountant/documents/types';
import { inlineDisposition } from './ledger/moves';

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
        docs: docsStatusOf(ctx),
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

// ═══ مستندات المحادثة ═══

const docsDb = (): DocsDb => prisma as unknown as DocsDb;

/** سياق الجلسة كما حمّله حارس المستندات (لا يُعاد تحميله في المعالج) */
type DocsRequest = AuthRequest & { acctDocsCtx?: AcctCtx };
const ctxOfReq = (req: AuthRequest): AcctCtx => (req as DocsRequest).acctDocsCtx!;

const failDoc = (res: Response, f: Pick<DocFail, 'status' | 'code' | 'message' | 'details'>): void => {
  res.status(f.status).json({ success: false, code: f.code, message: f.message, ...(f.details ? { details: f.details } : {}) });
};

const DOCS_DISABLED_MSG = 'رفع المستندات للمحاسب الذكي متوقف مؤقتاً';
const DOCS_NOT_ALLOWED_MSG = 'رفع المستندات وترحيلها لمن يرحّل القيود في دفاتر مفعّلة';
const DOCS_VIEW_MSG = 'عرض المستندات لمن يرى الدفاتر';

/**
 * حارس الكتابة (رفع، تصحيح، حذف): حكم المنصة أولاً بلا قراءة (DOCS_DISABLED: المفتاح أو الترحيل الموقوف أو المحادثة
 * المطفأة/بلا نموذج)، ثم السياق من الجلسة والترحيل متاح (NOT_ALLOWED) — قبل قراءة الجسم الخام.
 */
export async function requireDocs(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!docsPlatformEnabled()) {
      res.status(403).json({ success: false, code: 'DOCS_DISABLED', message: DOCS_DISABLED_MSG });
      return;
    }
    const { ctx } = await loadAcctCtx(userOf(req), { userMessages: [], clientRef: '' });
    if (!docsEnabledFor(ctx)) {
      res.status(403).json({ success: false, code: 'NOT_ALLOWED', message: DOCS_NOT_ALLOWED_MSG });
      return;
    }
    (req as DocsRequest).acctDocsCtx = ctx;
    next();
  } catch (err) { next(err); }
}

/** حارس القراءة: من يرى الدفاتر (canViewLedger) — والشركة والرافع في الاستعلام */
export async function requireDocsView(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { ctx } = await loadAcctCtx(userOf(req), { userMessages: [], clientRef: '' });
    if (!ctx.canViewLedger) {
      res.status(403).json({ success: false, code: 'NOT_ALLOWED', message: DOCS_VIEW_MSG });
      return;
    }
    (req as DocsRequest).acctDocsCtx = ctx;
    next();
  } catch (err) { next(err); }
}

/** الجسم الخام بعد الحرّاس (السقف من البيئة لحظة الطلب): ما فوق الحدّ ⇒ 413 FILE_TOO_LARGE لا خطأ عامّ */
function readRawDoc(req: AuthRequest, res: Response, next: NextFunction): void {
  const parse = express.raw({ type: [...ATTACHMENT_MIME_TYPES], limit: rawBodyLimitBytes() });
  parse(req, res, (err?: unknown) => {
    const e = err as { type?: string; status?: number } | undefined;
    if (e && (e.type === 'entity.too.large' || e.status === 413)) {
      res.status(413).json({ success: false, code: 'FILE_TOO_LARGE', message: DOC_MESSAGES.tooLarge });
      return;
    }
    next(err as Error | undefined);
  });
}

/** معرّف المستند من المسار (uuid) أو '' */
const docIdOf = (req: AuthRequest): string => {
  const id = String(req.params?.id ?? '');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : '';
};

/** ترويسة الطلب (Express أو طلب الاختبار) */
const headerOf = (req: AuthRequest, name: string): string | undefined => {
  const v = req.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
};

const actorRefOfCtx = (ctx: AcctCtx): string => actorRefOf(ctx.adminId, ctx.impersonated);

const docEnvOf = (ctx: AcctCtx) => loadDocEnv(docsDb(), {
  tenantId: ctx.tenantId, currency: ctx.currency, tz: ctx.tz, todayLocal: ctx.todayLocal, taxDisabled: ctx.taxDisabled,
});

const notFound = (res: Response): void => {
  res.status(404).json({ success: false, code: 'DOC_NOT_FOUND', message: DOC_MESSAGES.notFound });
};

router.post('/documents', requireDocs, readRawDoc, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = ctxOfReq(req);
    if (!Buffer.isBuffer(req.body)) {
      res.status(415).json({ success: false, code: 'ATTACHMENT_TYPE_NOT_ALLOWED', message: DOC_MESSAGES.type });
      return;
    }
    const db = docsDb();
    const env = await docEnvOf(ctx);
    const out = await uploadDocument(db, {
      tenantId: ctx.tenantId, actorRef: actorRefOfCtx(ctx), bytes: req.body,
      contentType: headerOf(req, 'content-type'), fileNameHeader: headerOf(req, 'x-file-name'), qrHeader: headerOf(req, 'x-zatca-qr'),
    }, env);
    if (!out.ok) { failDoc(res, out); return; }
    const [document] = await docViewsFor(db, ctx.tenantId, [out.doc], env);
    res.status(201).json({ success: true, data: { document, deduped: out.deduped } });
  } catch (err) { next(err); }
});

router.get('/documents/:id', requireDocsView, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = ctxOfReq(req);
    const id = docIdOf(req);
    const db = docsDb();
    const doc = id ? await findDocForViewer(db, { tenantId: ctx.tenantId, actorRef: actorRefOfCtx(ctx), id }) : null;
    if (!doc) { notFound(res); return; }
    const [document] = await docViewsFor(db, ctx.tenantId, [doc], await docEnvOf(ctx));
    res.json({ success: true, data: { document } });
  } catch (err) { next(err); }
});

router.get('/documents/:id/content', requireDocsView, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = ctxOfReq(req);
    const id = docIdOf(req);
    const db = docsDb();
    const doc = id ? await findDocForViewer(db, { tenantId: ctx.tenantId, actorRef: actorRefOfCtx(ctx), id }) : null;
    const file = doc ? await docContent(db, ctx.tenantId, doc) : null;
    if (!file) { notFound(res); return; }
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(file.bytes.length));
    res.setHeader('Content-Disposition', inlineDisposition(file.fileName));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(file.bytes);
  } catch (err) { next(err); }
});

/** نص قصير (null يمحو) */
const patchText = (max: number) => z.string().max(max).nullable().optional();
/** مبلغ: نص عشري (الأرقام الهندية والفواصل تُوحَّد في facts.ts) أو رقم يُحوَّل نصاً */
const patchAmount = z.union([z.string().max(40), z.number().finite().nonnegative()])
  .transform((v) => (typeof v === 'number' ? String(v) : v)).nullable().optional();
const CATEGORY_HINTS = [...EXPENSE_CATEGORY_KEYS, ...ACCT_DOC_EXTRA_CATEGORIES] as [string, ...string[]];

/** تصحيح المستخدم (AcctDocPatch): جزئي — الغائب لا يتغيّر وnull يمحو؛ المفاتيح المجهولة تسقط */
export const docPatchSchema = z.object({
  docType: z.enum(ACCT_DOC_TYPES as unknown as [string, ...string[]]).nullable().optional(),
  categoryHint: z.enum(CATEGORY_HINTS).nullable().optional(),
  assetClassHint: z.enum(ACCT_ASSET_CLASSES as unknown as [string, ...string[]]).nullable().optional(),
  vendorName: patchText(200),
  vendorVat: patchText(40),
  buyerName: patchText(200),
  buyerVat: patchText(40),
  invoiceNo: patchText(80),
  issueDate: patchText(40),
  periodFrom: patchText(40),
  periodTo: patchText(40),
  currency: patchText(20),
  subtotal: patchAmount,
  vatAmount: patchAmount,
  total: patchAmount,
  vatRatePct: z.number().finite().min(0).max(100).nullable().optional(),
  months: z.number().int().min(1).max(1200).nullable().optional(),
  paymentHint: z.enum(['PAID', 'UNPAID', 'UNKNOWN']).optional(),
});

router.patch('/documents/:id', requireDocs, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = ctxOfReq(req);
    const id = docIdOf(req);
    if (!id) { notFound(res); return; }
    const parsed = docPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        success: false, code: 'INVALID_BODY', message: 'بيانات التصحيح غير صالحة',
        details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      });
      return;
    }
    const db = docsDb();
    const env = await docEnvOf(ctx);
    const out = await patchDocument(db, { tenantId: ctx.tenantId, actorRef: actorRefOfCtx(ctx), id, patch: parsed.data as AcctDocPatch }, env);
    if (!out.ok) { failDoc(res, out); return; }
    const [document] = await docViewsFor(db, ctx.tenantId, [out.doc], env);
    res.json({ success: true, data: { document } });
  } catch (err) { next(err); }
});

router.delete('/documents/:id', requireDocs, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = ctxOfReq(req);
    const id = docIdOf(req);
    if (!id) { notFound(res); return; }
    const out = await deleteDocument(docsDb(), { tenantId: ctx.tenantId, actorRef: actorRefOfCtx(ctx), id });
    if (!out.ok) { failDoc(res, out); return; }
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

export default router;
