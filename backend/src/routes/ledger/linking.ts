import { createHash } from 'node:crypto';
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../config/database';
import { actorOf, isOwnerSession, requireLedgerPermission } from '../../middleware/auth';
import { AuthRequest } from '../../types';
import { LedgerLocals } from './context';
import { LedgerHttpError, ledgerHandler } from './errors';
import { parseStoredDraft } from './setup';
import { toJsonMilli } from '../../services/gl/reports/incomeStatement';
import {
  createPreviewJobDeps, getPreview, listPreviews, loadPreviewOptions, startPreview, PREVIEW_LIST_DEFAULT, PREVIEW_LIST_MAX,
  type PreviewJobDeps,
} from '../../services/gl/linking/jobs';
import { canonicalJson } from '../../services/gl/linking/dataHash';
import { LinkingParamsError, preflightInputFromOptions } from '../../services/gl/linking/params';
import { runPreflight } from '../../services/gl/linking/preflight';
import { isolatedRunPreview } from '../../services/gl/linking/previewIsolate';
import { withReadOnlySnapshot } from '../../services/gl/linking/snapshot';
import { DEFAULT_LINK_BASIS, LINK_BASES, type LinkBasis, type LinkingDraft, type PreflightReport } from '../../services/gl/linking/types';

/**
 * «ربط الدفاتر بكامل النظام» — المعاينة والفحوص المسبقة (L2، العقد scratchpad/l23_contract.md §14.3). قراءة فقط:
 * لا كتابة إلا صفّ المعاينة gl_link_previews (jobs.ts)، والمعاينة نفسها داخل لقطة REPEATABLE READ READ ONLY.
 *
 * - POST /linking/preview       يبدأ معاينة غير متزامنة (202) أو يعيد الجارية (200)؛ 409 للمفعّلة؛ 429 بحدّ المعدّل.
 * - GET  /linking/preview/:id   حالة المعاينة وتقدّمها ونتيجتها (PreviewResultJson) — للشركة نفسها وإلا 404.
 * - GET  /linking/previews      آخر المعاينات بلا نتائجها (?limit ≤ 20).
 * - GET  /linking/preflight     الفحوص المسبقة الخفيفة (LIGHT) داخل لقطة قراءة قصيرة (30 ثانية).
 *
 * السلسلة الموروثة من index.ts: authenticate → requireAdmin → requireAccountingSuite → ledgerContext. ثم لكل مسار
 * canConfigureLedger ثم مالك الشركة وحده (OD18): ربط الدفاتر قرار لا رجعة فيه بعد الاعتماد (L7) فمعاينته لصاحب القرار.
 */
const router = Router();

const ledgerOf = (res: Response) => res.locals.ledger as LedgerLocals;

// ═══ الأخطاء المحلية (لا تُضاف إلى LEDGER_ERROR_HTTP — ملف مشترك) ═══

export const LEDGER_LINKING_OWNER_ONLY_MESSAGE = 'ربط الدفاتر بالنظام لمالك الشركة وحده';
export const LEDGER_LINKING_INTERACTIVE_ONLY_MESSAGE = 'ربط الدفاتر بالنظام من لوحة التحكم وحدها — لا يُطلب بمفتاح API';
export const LEDGER_LINK_ALREADY_ACTIVATED_MESSAGE = 'الدفاتر مفعّلة لهذه الشركة — معاينة الربط للشركات غير المفعّلة وحدها';
export const LEDGER_LINK_PREVIEW_RATE_LIMITED_MESSAGE = 'بلغت حدّ معاينات الربط في الساعة — أعد المحاولة بعد قليل';
export const LEDGER_LINK_PREVIEW_NOT_FOUND_MESSAGE = 'المعاينة غير موجودة';

function deny(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ success: false, ...extra, code, message });
}

/**
 * مالك الشركة: جلسة مالك المنصّة (isOwnerSession) أو Admin {role:'ADMIN', isActive, canManageCompanyUsers:true,
 * scopeEnabled:false, tenantId = الشركة} — يُقرأ من القاعدة لا من التوكن (كـrequireLedgerPermission). مفتاح API
 * (req.user.apiKeyId، ولو أصدره الدعم الفني) ⇒ 403 LEDGER_LINKING_INTERACTIVE_ONLY: المعاينة ثقيلة على القاعدة الصغيرة
 * وتمهيدٌ لقرار لا رجعة فيه، فلا تُشغَّل آلياً.
 */
export async function requireCompanyOwner(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.user?.apiKeyId) {
      deny(res, 403, 'LEDGER_LINKING_INTERACTIVE_ONLY', LEDGER_LINKING_INTERACTIVE_ONLY_MESSAGE);
      return;
    }
    if (isOwnerSession(req)) { next(); return; }
    const tid = req.user?.tenantId;
    if (!req.user || !tid) {
      deny(res, 403, 'LEDGER_LINKING_OWNER_ONLY', LEDGER_LINKING_OWNER_ONLY_MESSAGE);
      return;
    }
    const admin = await prisma.admin.findUnique({
      where: { id: req.user.id },
      select: { isActive: true, tenantId: true, role: true, canManageCompanyUsers: true, scopeEnabled: true },
    });
    const owner = !!admin && admin.isActive === true && admin.tenantId === tid && admin.role === 'ADMIN'
      && admin.canManageCompanyUsers === true && admin.scopeEnabled !== true;
    if (!owner) {
      deny(res, 403, 'LEDGER_LINKING_OWNER_ONLY', LEDGER_LINKING_OWNER_ONLY_MESSAGE);
      return;
    }
    next();
  } catch (err) { next(err); }
}

// ═══ الاعتماديات ═══

/** المسودة المخزّنة بمحلّل المعالج نفسه (ما يصحّ منها فقط) — فارغة ⇒ null */
export function linkingDraftFromStored(raw: unknown): LinkingDraft | null {
  const d = parseStoredDraft(raw);
  return Object.keys(d).length ? d : null;
}

let jobDeps: PreviewJobDeps | null = null;
/**
 * المعاينة تُشغَّل في عملية فرعية بسقف ذاكرة (previewIsolate.ts): نفاد ذاكرتها يُنهيها وحدها (TOO_LARGE) لا الخادم، ولا تجمّد
 * حلقة أحداث الـAPI — ولها عميل Prisma خاصّ فلا عميل معاينة في الخادم (ownsClient)
 */
function linkingJobDeps(): PreviewJobDeps {
  if (!jobDeps) jobDeps = createPreviewJobDeps({ db: prisma, runPreview: isolatedRunPreview, parseDraft: linkingDraftFromStored, ownsClient: true });
  return jobDeps;
}

function paramsError(e: unknown): never {
  if (e instanceof LinkingParamsError) {
    throw new LedgerHttpError(422, e.message, { reason: e.reason, ...e.details }, 'LEDGER_LINK_PARAMS_INVALID');
  }
  throw e;
}

// ═══ المسارات ═══

const previewBodySchema = z.object({ basis: z.enum(LINK_BASES).optional() }).strict();
const listQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(PREVIEW_LIST_MAX).optional() });
const preflightQuerySchema = z.object({ basis: z.enum(LINK_BASES).optional() });
/** مهلة لقطة الـpreflight الخفيف (العقد §14.3) */
export const PREFLIGHT_SNAPSHOT_TIMEOUT_MS = 30_000;

router.post('/linking/preview', requireLedgerPermission('canConfigureLedger'), requireCompanyOwner, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const body = previewBodySchema.parse(req.body ?? {});
  const basis: LinkBasis = body.basis ?? DEFAULT_LINK_BASIS;
  const out = await startPreview(linkingJobDeps(), {
    tenantId, basis, requestedBy: actorOf(req), requestedVia: isOwnerSession(req) ? 'OWNER_SESSION' : 'COMPANY_OWNER',
  }).catch(paramsError);
  if ('alreadyActivated' in out) {
    deny(res, 409, 'LEDGER_LINK_ALREADY_ACTIVATED', LEDGER_LINK_ALREADY_ACTIVATED_MESSAGE);
    return;
  }
  if ('rateLimited' in out) {
    res.setHeader('Retry-After', String(out.retryAfterSeconds));
    deny(res, 429, 'LEDGER_LINK_PREVIEW_RATE_LIMITED', LEDGER_LINK_PREVIEW_RATE_LIMITED_MESSAGE, { retryAfterSeconds: out.retryAfterSeconds });
    return;
  }
  res.status(out.existing ? 200 : 202).json({ success: true, data: { id: out.id, status: out.status, existing: out.existing } });
}));

router.get('/linking/preview/:id', requireLedgerPermission('canConfigureLedger'), requireCompanyOwner, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const id = String(req.params.id ?? '');
  // معرّف ليس للشركة كغير الموجود (العزل §9.4)
  const view = id ? await getPreview(linkingJobDeps(), tenantId, id) : null;
  if (!view) {
    deny(res, 404, 'LEDGER_LINK_PREVIEW_NOT_FOUND', LEDGER_LINK_PREVIEW_NOT_FOUND_MESSAGE);
    return;
  }
  res.json({ success: true, data: view });
}));

router.get('/linking/previews', requireLedgerPermission('canConfigureLedger'), requireCompanyOwner, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const q = listQuerySchema.parse(req.query ?? {});
  const data = await listPreviews(linkingJobDeps(), tenantId, q.limit ?? PREVIEW_LIST_DEFAULT);
  res.json({ success: true, data });
}));

/**
 * طلبات الـpreflight المتزامنة للشركة والأساس والإعدادات نفسها تتشارك تشغيلاً واحداً — فتح الصفحة مرتين لا يضاعف المسح على
 * القاعدة الصغيرة (النتيجة لقطة واحدة على أي حال).
 */
const inflightPreflight = new Map<string, Promise<PreflightReport>>();

/**
 * الفحص الخفيف يعدّ ويمسح جداول كبيرة (بنود الفواتير والوارد وقيود العملاء — بعضها بلا فهرسٍ يخدمه) على قاعدةٍ صغيرة يتشاركها
 * الجميع وبمجمّع الخادم الرئيسي، والواجهة تطلبه عند كل فتحٍ للصفحة: يُحفظ تقريره في الذاكرة PREFLIGHT_LIGHT_CACHE_MS لكل
 * (شركة، أساس)، **مقيَّداً ببصمة الإعدادات المحلولة** (المسودة وصفّ الإعدادات والشركة — ثلاث قراءات بمفتاحٍ فريد قبل المسح):
 * تعديل المعالج يُبطله فوراً، ونشاط التشغيل يظهر بعد دقائق على الأكثر (تقديرٌ لا يُبنى عليه اعتماد — المعاينة FULL هي الحَكَم).
 */
export const PREFLIGHT_LIGHT_CACHE_MS = 5 * 60_000;
const PREFLIGHT_CACHE_MAX = 500;
const preflightCache = new Map<string, { at: number; fingerprint: string; report: PreflightReport }>();
let preflightClock: () => number = () => Date.now();

/** للاختبار: تفريغ الذاكرة وضبط ساعتها */
export function resetPreflightCacheForTests(clock?: () => number): void {
  preflightCache.clear();
  preflightClock = clock ?? (() => Date.now());
}

function rememberPreflight(key: string, fingerprint: string, report: PreflightReport): void {
  const now = preflightClock();
  for (const [k, v] of preflightCache) if (now - v.at >= PREFLIGHT_LIGHT_CACHE_MS) preflightCache.delete(k);
  while (preflightCache.size >= PREFLIGHT_CACHE_MAX) preflightCache.delete(preflightCache.keys().next().value as string);
  preflightCache.set(key, { at: now, fingerprint, report });
}

router.get('/linking/preflight', requireLedgerPermission('canConfigureLedger'), requireCompanyOwner, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const q = preflightQuerySchema.parse(req.query ?? {});
  const basis: LinkBasis = q.basis ?? DEFAULT_LINK_BASIS;
  const key = `${tenantId}|${basis}`;
  // بصمة الإعدادات المحلولة الآن (بساعة التطبيق: اليوم المحلي يدخل linkedFrom) — قراءات بمفتاحٍ فريد لا مسح
  const { options: current } = await loadPreviewOptions(prisma, tenantId, basis, new Date(), linkingDraftFromStored, process.env).catch(paramsError);
  const fingerprint = createHash('sha256').update(canonicalJson(current)).digest('hex');
  const hit = preflightCache.get(key);
  if (hit && hit.fingerprint === fingerprint && preflightClock() - hit.at < PREFLIGHT_LIGHT_CACHE_MS) {
    res.json({ success: true, data: toJsonMilli(hit.report) });
    return;
  }
  const runKey = `${key}|${fingerprint}`;
  let run = inflightPreflight.get(runKey);
  if (!run) {
    run = withReadOnlySnapshot(prisma, async (tx, dbNow) => {
      // الإعدادات تُقرأ بالمعاملة نفسها (لا عبر الحارس: runPreflight وحده ممنوع من gl*) فيرى الفحص لقطة واحدة
      const { options } = await loadPreviewOptions(tx, tenantId, basis, dbNow, linkingDraftFromStored, process.env);
      return runPreflight(tx, tenantId, preflightInputFromOptions(options, 'LIGHT', dbNow));
    }, { timeoutMs: PREFLIGHT_SNAPSHOT_TIMEOUT_MS });
    inflightPreflight.set(runKey, run);
    run.then((r) => { inflightPreflight.delete(runKey); rememberPreflight(key, fingerprint, r); }, () => inflightPreflight.delete(runKey));
  }
  const report = await run.catch(paramsError);
  res.json({ success: true, data: toJsonMilli(report) });
}));

export default router;
