/**
 * مهمة معاينة «ربط الدفاتر» غير المتزامنة وصفّها `gl_link_previews` (L2 — العقد scratchpad/l23_contract.md §14.2).
 *
 * - **الكتابة الوحيدة** في هذا الملف على `gl_link_previews` (اختبار تجسّس): المعاينة نفسها قراءة فقط داخل لقطة
 *   REPEATABLE READ READ ONLY على عميلها المخصّص (اتصالان — المُصدِّرة والدوّارة في snapshot.ts)، والصفّ يُكتب بالعميل الرئيسي.
 *   في الإنتاج تعمل المعاينة في **عملية فرعية** بسقف ذاكرة وعميلها فيها (previewIsolate.ts، ownsClient) — لا في عملية الخادم.
 * - **طابور المنصّة**: عاملٌ واحد في العملية (سلسلة Promise) يأخذ أقدم QUEUED حيّ؛ القاعدة صغيرة جداً (٠٫١ نواة) فلا
 *   تجري معاينتان معاً، ولا تبدأ معاينة وعمليةٌ أخرى (نشر متداخل) تشغّل واحدة بنبضٍ حيّ.
 * - **النبض**: المهمة الجارية تكتب heartbeatAt كل PREVIEW_HEARTBEAT_MS (مؤقّت مستقل: مراحل كالمُطابِق لا تبلّغ تقدّماً)،
 *   وتجدّد في الكتابة نفسها نبض المنتظرة الحيّة فلا يُحسب انتظارها خلف معاينة شركة أخرى انقطاعاً. ما بقي QUEUED/RUNNING
 *   بلا نبضٍ أحدث من PREVIEW_STALE_MS (أُعيد تشغيل الخادم) يُعلَّم FAILED(INTERRUPTED) قبل أي قراءة.
 * - **الإعدادات تُحلّ لحظة التشغيل** من الصفوف (params.ts) لا لحظة الطلب: صفّ QUEUED قد يلتقطه عاملٌ آخر بعد إعادة تشغيل،
 *   فلا يُحمل في الذاكرة شيء لا يُعاد بناؤه من القاعدة؛ ويُحدَّث linkedFrom عند الالتقاط إن تبدّل اليوم.
 * - كل انتقال حالة شرطيّ (`updateMany where status`) فلا يكتب نبضٌ متأخر أو مهمةٌ انتهت مهلتها فوق حالة نهائية.
 */
import type { PrismaClient } from '@prisma/client';
import { Prisma, PrismaClient as PrismaClientCtor } from '@prisma/client';
import { fromDbDate, toDbDate } from '../dates';
import { toJsonMilli } from '../reports/incomeStatement';
import { withConnectionLimit } from '../sync/postingStore.prisma';
import type { LocalDate } from '../types';
import { LinkingParamsError, isLinkBasis, resolvePreviewOptions } from './params';
import { PREVIEW_ERROR_MESSAGES, previewErrorCodeOf, type runPreview } from './preview';
import {
  PREVIEW_KEEP_RESULTS, PREVIEW_LIST_CAPS, PREVIEW_PHASE_PCT, PREVIEW_RATE_LIMIT_PER_HOUR, PREVIEW_RESULT_MAX_BYTES, PREVIEW_STALE_MS,
  PREVIEW_TIMEOUT_MS,
  type LinkBasis, type LinkingDraft, type LinkingSettingsRow, type PreviewErrorCode, type PreviewOptions, type PreviewPhase,
  type PreviewResult, type PreviewResultJson, type PreviewStatus,
} from './types';

// ═══ الثوابت ═══

/** نبض المهمة الجارية وتجديد المنتظرة — ربع PREVIEW_STALE_MS فيحتمل فوات نبضتين */
export const PREVIEW_HEARTBEAT_MS = 30_000;
/** أقلّ فاصل بين كتابتَي تقدّم (§14.2: ≤ مرة كل ثانيتين) — والأخيرة المؤجّلة تُكتب عند انقضائه */
export const PREVIEW_PROGRESS_MIN_MS = 2_000;
/** إعادة محاولة الطابور حين تشغّل عمليةٌ أخرى معاينة حيّة */
export const PREVIEW_QUEUE_RETRY_MS = 15_000;
/** بعد المهلة: أقصى انتظار لتحرّر معاينةٍ متروكة قبل التالية (معاملتها تنتهي بمهلتها 14 دقيقة قبل مهلة المهمة 15) */
export const PREVIEW_ABANDON_GRACE_MS = 2 * 60_000;
export const PREVIEW_RATE_WINDOW_MS = 60 * 60_000;
export const PREVIEW_LIST_DEFAULT = 10;
export const PREVIEW_LIST_MAX = 20;

// ═══ الأنواع ═══

/** قراءة الإعدادات والشركة — PrismaClient أو معاملة (لقطة الـpreflight) */
export type LinkingFactsDb = Pick<Prisma.TransactionClient, 'glSettings' | 'tenant' | 'companySettings'>;

export interface PreviewJobDeps {
  /** عميل المعاينة المخصّص: PrismaClient مستقل بـwithConnectionLimit(DATABASE_URL, 2) يُنشأ كسولاً مرة لكل عملية (لا يُنشأ مع ownsClient) */
  previewDb(): { $transaction: PrismaClient['$transaction'] };
  /** العميل الرئيسي لكتابة صف GlLinkPreview وحده (وقراءة الإعدادات والشركة) */
  db: Pick<PrismaClient, 'glLinkPreview' | 'glSettings' | 'tenant' | 'companySettings'>;
  runPreview: typeof runPreview;
  now(): Date;
  /** GlSettings.setupDraft المخزّنة ⇒ أقسام المسودة — يحقنها المسار من parseStoredDraft (routes/ledger/setup.ts) */
  parseDraft(raw: unknown): LinkingDraft | null;
  /** تحرير اتصال المعاينة حين يفرغ الطابور (اختياري) — لا يبقى اتصالٌ خامل محجوزاً على القاعدة الصغيرة */
  releasePreviewDb?(): Promise<void>;
  env?: NodeJS.ProcessEnv;
  /** للاختبار: مهل ومؤقّتات أقصر */
  timing?: { timeoutMs?: number; heartbeatMs?: number; progressMinMs?: number; queueRetryMs?: number; abandonGraceMs?: number };
  /** سجلّ الخادم (التفاصيل التقنية لا تصل للمالك) */
  log?(message: string, meta: Record<string, unknown>, err?: unknown): void;
}

export interface GlLinkPreviewSummary {
  id: string;
  status: PreviewStatus;
  phase: PreviewPhase | null;
  progressPct: number;
  basis: LinkBasis;
  linkedFrom: LocalDate;
  /** T0 ISO — null حتى DONE */
  snapshotAt: string | null;
  dataHash: string | null;
  resultHash: string | null;
  resultBytes: number | null;
  errorCode: PreviewErrorCode | null;
  /** رسالة عربية للمالك */
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
}

export interface GlLinkPreviewView extends GlLinkPreviewSummary {
  /** null حتى DONE، وفي المعاينات الأقدم من آخر PREVIEW_KEEP_RESULTS (عدا المعتمدة) */
  result: PreviewResultJson | null;
}

export type StartPreviewResult =
  | { id: string; status: PreviewStatus; existing: boolean }
  | { rateLimited: true; retryAfterSeconds: number }
  | { alreadyActivated: true };

export interface StartPreviewInput {
  tenantId: string;
  basis: LinkBasis;
  /** actorOf(req): المعرّف أو OWNER:<id> لجلسة مالك المنصّة */
  requestedBy: string;
  /** للتدقيق في options: COMPANY_OWNER | OWNER_SESSION */
  requestedVia?: string;
}

/** تجاوزت المهمة PREVIEW_TIMEOUT_MS */
export class PreviewJobTimeoutError extends Error {
  readonly code = 'TIMEOUT' as const;
  constructor(readonly timeoutMs: number) {
    super(`تجاوزت معاينة الربط مهلتها (${timeoutMs}ms)`);
    this.name = 'PreviewJobTimeoutError';
  }
}

const ACTIVE_STATUSES: PreviewStatus[] = ['QUEUED', 'RUNNING'];

const SUMMARY_SELECT = {
  id: true, status: true, phase: true, progressPct: true, basis: true, linkedFrom: true, snapshotAt: true, dataHash: true,
  resultHash: true, resultBytes: true, errorCode: true, error: true, createdAt: true, startedAt: true, finishedAt: true, heartbeatAt: true,
} as const;

type SummaryRow = {
  id: string; status: string; phase: string | null; progressPct: number; basis: string; linkedFrom: Date; snapshotAt: Date | null;
  dataHash: string | null; resultHash: string | null; resultBytes: number | null; errorCode: string | null; error: string | null;
  createdAt: Date; startedAt: Date | null; finishedAt: Date | null; heartbeatAt: Date | null;
};

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const staleCut = (now: Date): Date => new Date(now.getTime() - PREVIEW_STALE_MS);

function defaultLog(message: string, meta: Record<string, unknown>, err?: unknown): void {
  console.error(`[ledger-linking] ${message}`, meta, err ?? '');
}
const logOf = (deps: PreviewJobDeps) => deps.log ?? defaultLog;

function summaryOf(r: SummaryRow): GlLinkPreviewSummary {
  return {
    id: r.id,
    status: r.status as PreviewStatus,
    phase: (r.phase ?? null) as PreviewPhase | null,
    progressPct: r.progressPct,
    basis: r.basis as LinkBasis,
    linkedFrom: fromDbDate(r.linkedFrom),
    snapshotAt: iso(r.snapshotAt),
    dataHash: r.dataHash ?? null,
    resultHash: r.resultHash ?? null,
    resultBytes: r.resultBytes ?? null,
    errorCode: (r.errorCode ?? null) as PreviewErrorCode | null,
    error: r.error ?? null,
    createdAt: r.createdAt.toISOString(),
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    heartbeatAt: iso(r.heartbeatAt),
  };
}

// ═══ الإعدادات (قراءة) ═══

export interface LinkingFacts {
  settingsRow: LinkingSettingsRow | null;
  draft: LinkingDraft | null;
  company: { countryCode: string; currency: string | null };
  tenant: { accountingSuiteEnabled: boolean; accountingEnabled: boolean; warehouseEnabled: boolean };
}

/** ثلاث قراءات بمفتاح فريد، متتابعة عمداً (تعمل داخل معاملة تفاعلية على اتصال واحد) */
export async function loadLinkingFacts(db: LinkingFactsDb, tenantId: string, parseDraft: (raw: unknown) => LinkingDraft | null): Promise<LinkingFacts> {
  const s = await db.glSettings.findUnique({ where: { tenantId } });
  const t = await db.tenant.findUnique({ where: { id: tenantId }, select: { accountingSuiteEnabled: true, accountingEnabled: true, warehouseEnabled: true } });
  const cs = await db.companySettings.findUnique({ where: { tenantId }, select: { countryCode: true, currency: true, currencyOverride: true } });
  let settingsRow: LinkingSettingsRow | null = null;
  let rawDraft: unknown = null;
  if (s) {
    // المسودة (حتى 5000 صفّ يدوي) تُفصل عن الصفّ فلا تُحمل مرتين في الخيارات
    const { setupDraft, ...rest } = s as typeof s & { setupDraft?: unknown };
    rawDraft = setupDraft ?? null;
    settingsRow = rest as LinkingSettingsRow;
  }
  return {
    settingsRow,
    draft: parseDraft(rawDraft),
    company: { countryCode: (cs?.countryCode || 'SA').toUpperCase(), currency: cs ? (cs.currencyOverride || cs.currency) : null },
    tenant: {
      accountingSuiteEnabled: t?.accountingSuiteEnabled === true,
      accountingEnabled: t?.accountingEnabled !== false,
      warehouseEnabled: t?.warehouseEnabled === true,
    },
  };
}

/** الخيارات المحلولة لشركة وأساس — للمهمة ولمسار الـpreflight */
export async function loadPreviewOptions(
  db: LinkingFactsDb, tenantId: string, basis: LinkBasis, now: Date,
  parseDraft: (raw: unknown) => LinkingDraft | null, env?: NodeJS.ProcessEnv,
): Promise<{ facts: LinkingFacts; options: PreviewOptions }> {
  const facts = await loadLinkingFacts(db, tenantId, parseDraft);
  const options = resolvePreviewOptions({ basis, dbNow: now, ...facts, env });
  return { facts, options };
}

// ═══ تعليم المنقطعة ═══

/** worker.currentId مستثنى: مهمة هذه العملية الجارية حيّة ولو تأخّر نبضها */
async function sweepInterrupted(deps: PreviewJobDeps, now: Date, tenantId: string | null): Promise<number> {
  const cut = staleCut(now);
  const where: Prisma.GlLinkPreviewWhereInput = {
    ...(tenantId ? { tenantId } : {}),
    status: { in: ACTIVE_STATUSES },
    OR: [{ heartbeatAt: { lt: cut } }, { heartbeatAt: null }],
    ...(worker.currentId ? { NOT: { id: worker.currentId } } : {}),
  };
  const r = await deps.db.glLinkPreview.updateMany({
    where,
    data: { status: 'FAILED', errorCode: 'INTERRUPTED', error: PREVIEW_ERROR_MESSAGES.INTERRUPTED, finishedAt: now },
  });
  return r.count;
}

// ═══ بدء المعاينة ═══

/** طلبان متزامنان للشركة نفسها لا ينشئان صفّين (نسخة واحدة على Render — قفل في الذاكرة يكفي) */
const tenantLocks = new Map<string, Promise<void>>();

async function withTenantLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tenantLocks.get(tenantId) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(() => undefined, () => undefined);
  tenantLocks.set(tenantId, tail);
  try {
    return await run;
  } finally {
    if (tenantLocks.get(tenantId) === tail) tenantLocks.delete(tenantId);
  }
}

/**
 * يبدأ معاينة (أو يعيد الجارية): المفعّلة ⇒ alreadyActivated (D7)؛ جارية حيّة ⇒ هي (existing)؛ ≥ حدّ المعدّل في آخر ساعة ⇒
 * rateLimited حتى خروج أقدم ما يحسب من النافذة؛ وإلا صفّ QUEUED جديد ويُنبَّه العامل.
 * يرمي LinkingParamsError (قالب أو نهاية سنة) قبل إنشاء أي صفّ.
 */
export async function startPreview(deps: PreviewJobDeps, input: StartPreviewInput): Promise<StartPreviewResult> {
  return withTenantLock(input.tenantId, async () => {
    const now = deps.now();
    await sweepInterrupted(deps, now, input.tenantId);
    const facts = await loadLinkingFacts(deps.db, input.tenantId, deps.parseDraft);
    if (facts.settingsRow?.activatedAt) return { alreadyActivated: true as const };
    const options = resolvePreviewOptions({ basis: input.basis, dbNow: now, ...facts, env: deps.env });

    const running = await deps.db.glLinkPreview.findFirst({
      where: { tenantId: input.tenantId, status: { in: ACTIVE_STATUSES }, heartbeatAt: { gte: staleCut(now) } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, status: true },
    });
    if (running) {
      kickPreviewWorker(deps);
      return { id: running.id, status: running.status as PreviewStatus, existing: true };
    }

    // السادس الأحدث في النافذة هو ما يُنزل العدد تحت الحدّ حين يخرج منها
    const recent = await deps.db.glLinkPreview.findMany({
      where: { tenantId: input.tenantId, createdAt: { gt: new Date(now.getTime() - PREVIEW_RATE_WINDOW_MS) } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PREVIEW_RATE_LIMIT_PER_HOUR,
      select: { createdAt: true },
    });
    if (recent.length >= PREVIEW_RATE_LIMIT_PER_HOUR) {
      const exitAt = recent[PREVIEW_RATE_LIMIT_PER_HOUR - 1].createdAt.getTime() + PREVIEW_RATE_WINDOW_MS;
      return { rateLimited: true as const, retryAfterSeconds: Math.max(1, Math.ceil((exitAt - now.getTime()) / 1000)) };
    }

    const row = await deps.db.glLinkPreview.create({
      data: {
        tenantId: input.tenantId,
        status: 'QUEUED',
        basis: input.basis,
        linkedFrom: toDbDate(options.linkedFrom),
        phase: 'QUEUED',
        progressPct: PREVIEW_PHASE_PCT.QUEUED,
        heartbeatAt: now,
        options: { basis: input.basis, requestedVia: input.requestedVia ?? 'COMPANY_OWNER' },
        requestedBy: input.requestedBy,
        // ساعة واحدة لكل المقارنات (النافذة والنبض) — ساعة التطبيق
        createdAt: now,
      },
      select: { id: true },
    });
    kickPreviewWorker(deps);
    return { id: row.id, status: 'QUEUED' as const, existing: false };
  });
}

// ═══ القراءة ═══

/** نشِطة بلا نبضٍ حيّ وليست مهمة هذه العملية */
function staleActive(r: { id: string; status: string; heartbeatAt: Date | null }, now: Date): boolean {
  return (r.status === 'QUEUED' || r.status === 'RUNNING') && r.id !== worker.currentId
    && (!r.heartbeatAt || r.heartbeatAt.getTime() < staleCut(now).getTime());
}

/**
 * تستطلعها الواجهة كل ثانيتين: قراءة واحدة، ولا كتابة إلا حين يكون الصفّ نفسه منقطعاً (يُعلَّم مع منقطعات الشركة ثم يُعاد
 * قراءته) — فالاستطلاع لا يضيف عبارة UPDATE كل ثانيتين على القاعدة الصغيرة.
 */
export async function getPreview(deps: PreviewJobDeps, tenantId: string, id: string): Promise<GlLinkPreviewView | null> {
  const now = deps.now();
  const read = () => deps.db.glLinkPreview.findFirst({ where: { id, tenantId }, select: { ...SUMMARY_SELECT, result: true } });
  let r = await read();
  if (!r) return null;
  if (staleActive(r, now)) {
    await sweepInterrupted(deps, now, tenantId);
    r = (await read()) ?? r;
  }
  // صفّ منتظر حيّ وعامل هذه العملية خامل (أُعيد تشغيل الخادم خلال مهلة النبض): الاستطلاع يستأنف الطابور
  if (r.status === 'QUEUED' && !worker.draining) kickPreviewWorker(deps);
  return { ...summaryOf(r as SummaryRow), result: (r.result ?? null) as PreviewResultJson | null };
}

export async function listPreviews(deps: PreviewJobDeps, tenantId: string, limit: number = PREVIEW_LIST_DEFAULT): Promise<GlLinkPreviewSummary[]> {
  const take = Math.min(PREVIEW_LIST_MAX, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : PREVIEW_LIST_DEFAULT)));
  await sweepInterrupted(deps, deps.now(), tenantId);
  const rows = await deps.db.glLinkPreview.findMany({
    where: { tenantId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
    select: SUMMARY_SELECT,
  });
  return rows.map((r) => summaryOf(r as SummaryRow));
}

// ═══ قصّ النتيجة ═══

const byteSize = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

/**
 * الحدّ المحميّ للقوائم المحدودة: 10٪ من سقوفها في PREVIEW_LIST_CAPS (200 سطر افتتاح، و20 صفّ تعمّق لكل مطابقة، و50
 * سطراً محجوزاً، و5 عناصر لكل فحص). لا تنزل القوائم دونه قبل أن تُسقط صفوف ميزان الشهور كلها — فما يحتاج انتباه
 * المالك (المحجوز وتفاصيل الفروق) لا يُفرَّغ إلى الصفر لأن الميزان عريض.
 */
export const PROTECTED_LIST_FRACTION = 0.1;
/** نِسَب القوائم فوق حدّها المحميّ، والميزان بكل صفوفه */
const LIST_FRACTIONS = [0.5, 0.25] as const;
/** ما دون الحدّ المحميّ، والميزان بلا صفوف */
const BELOW_PROTECTED_FRACTIONS = [0.04, 0.01, 0] as const;

type Json = PreviewResultJson;
type Trimmed = { json: Json; dropped: number; sections: Set<string> };

function capList<T>(list: T[] | undefined | null, n: number): { kept: T[]; dropped: number } {
  const arr = Array.isArray(list) ? list : [];
  if (arr.length <= n) return { kept: arr, dropped: 0 };
  return { kept: arr.slice(0, Math.max(0, n)), dropped: arr.length - Math.max(0, n) };
}

/** يقلّص القوائم المحدودة إلى نسبة f من سقوفها، ويزيد عدّادات القصّ في مواضعها */
function shrinkBoundedLists(src: Json, f: number): Trimmed {
  const json = structuredClone(src) as Json;
  let dropped = 0;
  const sections = new Set<string>();
  const cap = (base: number) => Math.floor(base * f);
  const note = (label: string, n: number) => { if (n > 0) { dropped += n; sections.add(label); } };

  if (json.opening) {
    const r = capList(json.opening.lines, cap(PREVIEW_LIST_CAPS.openingLines));
    json.opening.lines = r.kept;
    json.opening.linesTruncated = (json.opening.linesTruncated ?? 0) + r.dropped;
    note('سطور القيد الافتتاحي', r.dropped);
  }
  for (const p of json.parity ?? []) {
    const r = capList(p.drill, cap(PREVIEW_LIST_CAPS.drillRows));
    p.drill = r.kept;
    p.drillTruncated = (p.drillTruncated ?? 0) + r.dropped;
    note('تفاصيل المطابقة', r.dropped);
  }
  {
    const r = capList(json.heldLines, cap(PREVIEW_LIST_CAPS.heldLines));
    json.heldLines = r.kept;
    json.heldTruncated = (json.heldTruncated ?? 0) + r.dropped;
    note('السطور المحجوزة', r.dropped);
  }
  for (const c of json.preflight?.checks ?? []) {
    const r = capList(c.items, cap(PREVIEW_LIST_CAPS.preflightItems));
    if (r.dropped > 0) {
      c.items = r.kept;
      c.itemsTruncated = (c.itemsTruncated ?? 0) + r.dropped;
      note('عناصر الفحوص المسبقة', r.dropped);
    }
  }
  const cs = json.costing?.summary;
  if (cs) {
    const u = capList(cs.uncostedAtCutover, cap(PREVIEW_LIST_CAPS.openingLines));
    cs.uncostedAtCutover = u.kept;
    note('الأصناف بلا تكلفة في بداية السنة', u.dropped);
    const n = capList(cs.negativeAtCutover, cap(PREVIEW_LIST_CAPS.openingLines));
    cs.negativeAtCutover = n.kept;
    note('الأرصدة السالبة في بداية السنة', n.dropped);
    if (cs.holesFy) {
      const h = capList(cs.holesFy.sample, cap(PREVIEW_LIST_CAPS.holesSample));
      cs.holesFy.sample = h.kept;
      note('عيّنة الحُفر', h.dropped);
    }
    for (const w of cs.warnings ?? []) {
      const s = capList(w.sample, cap(20));
      w.sample = s.kept;
      note('عيّنات تحذيرات التكلفة', s.dropped);
    }
  }
  return { json, dropped, sections };
}

const isZeroMilli = (v: unknown): boolean => v === '0' || v === 0 || v === '-0' || v == null;

/** صفوف ميزان الشهور الصفرية كلها (افتتاح ومدين ودائن وإقفال) — لا تحمل معلومة */
function dropZeroTrialRows(t: Trimmed): Trimmed {
  const tb = t.json.trialBalanceByMonth;
  if (!tb || !Array.isArray(tb.rows)) return t;
  const before = tb.rows.length;
  tb.rows = tb.rows.filter((r) => !(isZeroMilli(r.openingMilli) && isZeroMilli(r.debitMilli) && isZeroMilli(r.creditMilli) && isZeroMilli(r.closingMilli)));
  const n = before - tb.rows.length;
  if (n > 0) { t.dropped += n; t.sections.add('صفوف ميزان المراجعة الصفرية'); }
  return t;
}

const isZeroCell = (c: { debitMilli: unknown; creditMilli: unknown }): boolean => isZeroMilli(c.debitMilli) && isZeroMilli(c.creditMilli);

/**
 * ميزان الشهور مضغوطاً قبل أي قصّ: خلايا الأشهر الصفرية تُحذف من كل صفّ **بلا فقد** (الواجهة تقرأ الشهر الغائب صفراً —
 * monthCell، والصفّ يحمل مجاميعه)، فلا يتضخّم الصفّ بأعمدة خالية حين يمتدّ الميزان إلى مستند مؤرّخ في المستقبل البعيد
 * (2061 ⇒ 432 شهراً × كل حساب). ثم تُسقط صفوفه الصفرية كلها (تُعدّ في التحذير). الأعمدة (months) تبقى كما هي.
 */
function compactTrialBalance(t: Trimmed): Trimmed {
  const tb = t.json.trialBalanceByMonth;
  if (!tb || !Array.isArray(tb.rows)) return t;
  for (const row of tb.rows) if (Array.isArray(row.months)) row.months = row.months.filter((c) => !isZeroCell(c));
  return dropZeroTrialRows(t);
}

const absMilli = (v: unknown): bigint => {
  try { const b = BigInt(String(v ?? '0')); return b < 0n ? -b : b; } catch { return 0n; }
};

/** فهارس صفوف الميزان بالأثقل حركةً (|مدين|+|دائن|+|إقفال|) ثم الأسبق — حتمي */
function trialRowsByWeight(rows: Json['trialBalanceByMonth']['rows']): number[] {
  const weight = (r: (typeof rows)[number]) => absMilli(r.debitMilli) + absMilli(r.creditMilli) + absMilli(r.closingMilli);
  return rows.map((r, i) => ({ i, w: weight(r) }))
    .sort((a, b) => (a.w === b.w ? a.i - b.i : a.w > b.w ? -1 : 1))
    .map((x) => x.i);
}

/**
 * نسخة **سطحية** من القصّ بأثقل `keep` صفّاً من الميزان بترتيبها الأصلي (والباقي يُعدّ) — لا نسخ عميق لكل محاولة تنصيف
 * على الخادم الصغير. `order` من trialRowsByWeight على صفوف `t` نفسها.
 */
function keepHeaviestTrialRows(t: Trimmed, order: readonly number[], keep: number): Trimmed {
  const tb = t.json.trialBalanceByMonth;
  const rows = tb?.rows ?? [];
  const n = Math.max(0, Math.floor(keep));
  if (!tb || n >= rows.length) return t;
  const keepIdx = new Set(order.slice(0, n));
  const sections = new Set(t.sections);
  sections.add('صفوف ميزان المراجعة بالأشهر');
  return {
    json: { ...t.json, trialBalanceByMonth: { ...tb, rows: rows.filter((_, i) => keepIdx.has(i)) } },
    dropped: t.dropped + rows.length - keepIdx.size,
    sections,
  };
}

/** الملاذ الأخير: تفاصيل العرض كلها (وصفوف الميزان) — وتبقى المجاميع والمطابقة والفحوص */
function dropDetailLists(t: Trimmed): Trimmed {
  const j = t.json;
  const drop = <T>(arr: T[] | undefined, label: string): T[] => {
    const a = Array.isArray(arr) ? arr : [];
    if (a.length > 0) { t.dropped += a.length; t.sections.add(label); return []; }
    return a;
  };
  if (j.trialBalanceByMonth) j.trialBalanceByMonth.rows = drop(j.trialBalanceByMonth.rows, 'صفوف ميزان المراجعة بالأشهر');
  if (j.opening) j.opening.byAccount = drop(j.opening.byAccount, 'مجاميع القيد الافتتاحي حسب الحساب');
  j.eventCounts = drop(j.eventCounts, 'أعداد الأحداث');
  j.vatByPeriodBox = drop(j.vatByPeriodBox, 'الضريبة بالفترة والمربع');
  if (j.pnlYtd) j.pnlYtd.lines = drop(j.pnlYtd.lines, 'سطور قائمة الدخل');
  if (j.balanceSheet) j.balanceSheet.lines = drop(j.balanceSheet.lines, 'سطور الميزانية');
  if (j.costing?.summary) {
    j.costing.summary.openingByLocation = drop(j.costing.summary.openingByLocation, 'مخزون الافتتاح بالموقع');
    j.costing.summary.nowByLocation = drop(j.costing.summary.nowByLocation, 'المخزون الحالي بالموقع');
    j.costing.summary.warnings = drop(j.costing.summary.warnings, 'تحذيرات التكلفة');
  }
  j.warnings = drop(j.warnings, 'تحذيرات المعاينة');
  return t;
}

/** النتيجة بتحذير RESULT_TRUNCATED (بلا تعديل t: تُبنى منه نسخ سطحية لمحاولات أخرى) */
function withTruncationWarning(t: Trimmed): Json {
  const warnings = (t.json.warnings ?? []).filter((w) => w.code !== 'RESULT_TRUNCATED');
  warnings.push({
    code: 'RESULT_TRUNCATED',
    count: t.dropped,
    message: `النتيجة أكبر من سقف الحفظ فقُصّت قوائم العرض الطويلة (${[...t.sections].join('، ')}) — المجاميع والمطابقة والفحوص كاملة`,
  });
  return { ...t.json, warnings };
}

/**
 * يحصر النتيجة في maxBytes (UTF-8 لـJSON) بمراحل متصاعدة الفقد، أولها يكفي يُعتمد:
 *  ١. ميزان الشهور مضغوطاً بلا فقد (compactTrialBalance) والقوائم المحدودة كاملة — فإن كفى ولم يُسقط شيء فلا تحذير.
 *  ٢. القوائم المحدودة بنسب متناقصة حتى حدّها المحميّ (PROTECTED_LIST_FRACTION)، والميزان بكل صفوفه.
 *  ٣. صفوف الميزان الأخفّ حركةً تُسقط بالتنصيف (الأثقل باقٍ بترتيبه) والقوائم عند حدّها المحميّ — **قبل** أن تُفرَّغ:
 *     ميزانٌ عريض لا يمحو السطور المحجوزة وتعمّق الفروق فتعرض الواجهة «لا شيء».
 *  ٤. القوائم دون حدّها المحميّ والميزان بلا صفوف، ثم ٥. الملاذ الأخير: تفاصيل العرض كلها.
 * كل ما أُسقط يُعدّ في عدّاد قائمته (…Truncated) وفي تحذير RESULT_TRUNCATED بأقسامه. حتميّ: المدخل نفسه ⇒ الناتج نفسه.
 * المجاميع والحالات (المطابقة R والفحوص P وresultHash) لا تُمسّ أبداً.
 */
export function capResult(r: PreviewResultJson, maxBytes: number): { json: PreviewResultJson; bytes: number; truncated: boolean } {
  const full = byteSize(r);
  if (full <= maxBytes) return { json: r, bytes: full, truncated: false };
  const attempt = (t: Trimmed) => {
    const json = t.dropped > 0 ? withTruncationWarning(t) : t.json;
    return { json, bytes: byteSize(json), truncated: t.dropped > 0 };
  };
  const fits = (a: { bytes: number }) => a.bytes <= maxBytes;
  const at = (f: number) => compactTrialBalance(shrinkBoundedLists(r, f));

  const whole = attempt(at(1));
  if (fits(whole)) return whole;
  // الحدّ المحميّ أولاً: إن لم يكفِ والميزان كامل فلا جدوى مما فوقه (توفير نسخٍ على الخادم الصغير)
  const guarded = at(PROTECTED_LIST_FRACTION);
  const atGuard = attempt(guarded);
  if (fits(atGuard)) {
    for (const f of LIST_FRACTIONS) {
      const a = attempt(at(f));
      if (fits(a)) return a;
    }
    return atGuard;
  }
  const rows = guarded.json.trialBalanceByMonth?.rows ?? [];
  const order = trialRowsByWeight(rows);
  for (let keep = Math.floor(rows.length / 2); keep > 0; keep = Math.floor(keep / 2)) {
    const a = attempt(keepHeaviestTrialRows(guarded, order, keep));
    if (fits(a)) return a;
  }
  for (const f of [PROTECTED_LIST_FRACTION, ...BELOW_PROTECTED_FRACTIONS]) {
    const a = attempt(keepHeaviestTrialRows(f === PROTECTED_LIST_FRACTION ? guarded : at(f), [], 0));
    if (fits(a)) return a;
  }
  // الهيكل بلا قوائم بضعة كيلوبايتات فهذا يكفي لأي نتاج حقيقي — ويُسجَّل حجمه الفعلي على أي حال
  return attempt(dropDetailLists(at(0)));
}

// ═══ العامل ═══

const worker: {
  deps: PreviewJobDeps | null;
  draining: Promise<void> | null;
  again: boolean;
  currentId: string | null;
  retry: ReturnType<typeof setTimeout> | null;
} = { deps: null, draining: null, again: false, currentId: null, retry: null };

/** ينبّه عامل العملية (يبدأ إن كان خاملاً، أو يعيد الفحص بعد دورته الحالية) */
export function kickPreviewWorker(deps: PreviewJobDeps): void {
  worker.deps = deps;
  if (worker.draining) { worker.again = true; return; }
  if (worker.retry) { clearTimeout(worker.retry); worker.retry = null; }
  worker.again = false;
  worker.draining = drainQueue(deps)
    .catch((e) => logOf(deps)('preview queue failed', {}, e))
    .finally(() => {
      worker.draining = null;
      if (worker.again && worker.deps) { worker.again = false; kickPreviewWorker(worker.deps); }
    });
}

/** يُحلّ حين يخمد العامل (للاختبار ولإيقاف الخادم بلطف) */
export async function previewWorkerIdle(): Promise<void> {
  while (worker.draining) await worker.draining;
}

function scheduleRetry(deps: PreviewJobDeps): void {
  if (worker.retry) return;
  worker.retry = setTimeout(() => { worker.retry = null; kickPreviewWorker(deps); }, deps.timing?.queueRetryMs ?? PREVIEW_QUEUE_RETRY_MS);
  worker.retry.unref?.();
}

async function drainQueue(deps: PreviewJobDeps): Promise<void> {
  try {
    for (;;) {
      worker.again = false;
      const now = deps.now();
      await sweepInterrupted(deps, now, null);
      // عمليةٌ أخرى (نشر متداخل) تشغّل معاينة حيّة ⇒ لا تبدأ ثانية على القاعدة نفسها؛ تلك تجدّد نبض المنتظرة
      const busy = await deps.db.glLinkPreview.count({ where: { status: 'RUNNING', heartbeatAt: { gte: staleCut(now) } } });
      if (busy > 0) { scheduleRetry(deps); return; }
      const next = await deps.db.glLinkPreview.findFirst({
        where: { status: 'QUEUED', heartbeatAt: { gte: staleCut(now) } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, tenantId: true, basis: true },
      });
      if (!next) return;
      await runOne(deps, next);
    }
  } finally {
    if (deps.releasePreviewDb) await deps.releasePreviewDb().catch((e) => logOf(deps)('preview client release failed', {}, e));
  }
}

async function failQueued(deps: PreviewJobDeps, id: string, code: PreviewErrorCode, message: string = PREVIEW_ERROR_MESSAGES[code]): Promise<void> {
  const now = deps.now();
  await deps.db.glLinkPreview.updateMany({
    where: { id, status: 'QUEUED' },
    data: { status: 'FAILED', errorCode: code, error: message, finishedAt: now, heartbeatAt: now },
  });
}

/** رمز الفشل: مهلة المهمة أو مهلة معاملة Prisma (P2028) ⇒ TIMEOUT، والبقية برمز المعاينة (preview.ts) */
export function jobFailureCodeOf(e: unknown): PreviewErrorCode {
  if (e instanceof PreviewJobTimeoutError) return 'TIMEOUT';
  if (e && typeof e === 'object' && (e as { code?: unknown }).code === 'P2028') return 'TIMEOUT';
  return previewErrorCodeOf(e);
}

function clampPct(p: number): number {
  return Number.isFinite(p) ? Math.max(0, Math.min(99, Math.round(p))) : 0;
}

/** كتابات التقدّم: ≤ مرة كل progressMinMs، والأحدث المؤجَّلة تُكتب عند انقضائه؛ شرطية على RUNNING ولا ترمي أبداً */
function progressWriter(deps: PreviewJobDeps, id: string) {
  const minMs = deps.timing?.progressMinMs ?? PREVIEW_PROGRESS_MIN_MS;
  let last = Number.NEGATIVE_INFINITY;
  let pending: { phase: PreviewPhase; pct: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const write = async (p: { phase: PreviewPhase; pct: number }) => {
    const now = deps.now();
    last = now.getTime();
    try {
      await deps.db.glLinkPreview.updateMany({ where: { id, status: 'RUNNING' }, data: { phase: p.phase, progressPct: p.pct, heartbeatAt: now } });
    } catch (e) {
      logOf(deps)('preview progress write failed', { id }, e);
    }
  };
  return {
    async onProgress(phase: PreviewPhase, pct: number): Promise<void> {
      // DONE تكتبه كتابة النتيجة نفسها
      if (stopped || phase === 'DONE') return;
      const p = { phase, pct: clampPct(pct) };
      const elapsed = deps.now().getTime() - last;
      if (elapsed >= minMs) {
        pending = null;
        if (timer) { clearTimeout(timer); timer = null; }
        await write(p);
        return;
      }
      pending = p;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          const q = pending;
          pending = null;
          if (q && !stopped) void write(q);
        }, Math.max(0, minMs - elapsed));
        timer.unref?.();
      }
    },
    stop(): void {
      stopped = true;
      pending = null;
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}

/** نبض الجارية + تجديد المنتظرة الحيّة في عبارة واحدة */
async function beat(deps: PreviewJobDeps, id: string): Promise<void> {
  const now = deps.now();
  try {
    await deps.db.glLinkPreview.updateMany({
      where: { OR: [{ id, status: 'RUNNING' }, { status: 'QUEUED', heartbeatAt: { gte: staleCut(now) } }] },
      data: { heartbeatAt: now },
    });
  } catch (e) {
    logOf(deps)('preview heartbeat failed', { id }, e);
  }
}

async function runOne(deps: PreviewJobDeps, cand: { id: string; tenantId: string; basis: string }): Promise<void> {
  const log = logOf(deps);
  const startNow = deps.now();
  let options: PreviewOptions;
  try {
    if (!isLinkBasis(cand.basis)) throw new LinkingParamsError('INVALID_BASIS', 'أساس الربط غير معروف', { basis: cand.basis });
    const loaded = await loadPreviewOptions(deps.db, cand.tenantId, cand.basis, startNow, deps.parseDraft, deps.env);
    if (loaded.facts.settingsRow?.activatedAt) { await failQueued(deps, cand.id, 'ALREADY_ACTIVATED'); return; }
    options = loaded.options;
  } catch (e) {
    log('preview inputs failed', { id: cand.id, tenantId: cand.tenantId }, e);
    await failQueued(deps, cand.id, 'INTERNAL', e instanceof LinkingParamsError ? e.message : PREVIEW_ERROR_MESSAGES.INTERNAL);
    return;
  }

  const claimed = await deps.db.glLinkPreview.updateMany({
    where: { id: cand.id, status: 'QUEUED' },
    data: {
      status: 'RUNNING', phase: 'READ', progressPct: PREVIEW_PHASE_PCT.QUEUED, startedAt: startNow, heartbeatAt: startNow,
      linkedFrom: toDbDate(options.linkedFrom),
    },
  });
  if (claimed.count !== 1) return;

  worker.currentId = cand.id;
  const heartbeat = setInterval(() => { void beat(deps, cand.id); }, deps.timing?.heartbeatMs ?? PREVIEW_HEARTBEAT_MS);
  heartbeat.unref?.();
  const progress = progressWriter(deps, cand.id);
  const timeoutMs = deps.timing?.timeoutMs ?? PREVIEW_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PreviewJobTimeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  timeout.catch(() => undefined);
  // متزامن أو غير متزامن، أيّ رمية تصير رفضاً
  const run = Promise.resolve().then(() => deps.runPreview(deps.previewDb(), cand.tenantId, options, { onProgress: progress.onProgress }));
  let timedOut = false;
  try {
    let result: PreviewResult;
    try {
      result = await Promise.race([run, timeout]);
    } catch (e) {
      timedOut = e instanceof PreviewJobTimeoutError;
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      progress.stop();
    }
    await finishDone(deps, cand.id, cand.tenantId, result);
  } catch (e) {
    await finishFailed(deps, cand.id, cand.tenantId, e);
    // المهلة لا توقف المعاينة نفسها: لا تبدأ التالية قبل أن تحرّر اتصالها (مهلة معاملتها 14 دقيقة تحدّها عادةً) —
    // ومهلة سماحٍ إضافية فلا يتوقف طابور المنصّة كله على معاينة عالقة
    if (timedOut) {
      let grace: ReturnType<typeof setTimeout> | null = null;
      const settled = await Promise.race([
        run.then(() => true, () => true),
        new Promise<false>((r) => { grace = setTimeout(() => r(false), deps.timing?.abandonGraceMs ?? PREVIEW_ABANDON_GRACE_MS); grace.unref?.(); }),
      ]);
      if (grace) clearTimeout(grace);
      if (!settled) log('timed-out preview still running after grace — continuing the queue', { id: cand.id, tenantId: cand.tenantId });
    }
  } finally {
    clearInterval(heartbeat);
    worker.currentId = null;
  }
}

async function finishDone(deps: PreviewJobDeps, id: string, tenantId: string, result: PreviewResult): Promise<void> {
  const json = toJsonMilli(result) as PreviewResultJson;
  const capped = capResult(json, PREVIEW_RESULT_MAX_BYTES);
  const now = deps.now();
  const done = await deps.db.glLinkPreview.updateMany({
    where: { id, status: 'RUNNING' },
    data: {
      status: 'DONE', phase: 'DONE', progressPct: 100,
      result: capped.json as unknown as Prisma.InputJsonValue,
      resultBytes: capped.bytes,
      dataHash: result.dataHash,
      resultHash: result.resultHash,
      snapshotAt: new Date(result.snapshotAt),
      linkedFrom: toDbDate(result.linkedFrom),
      finishedAt: now, heartbeatAt: now, errorCode: null, error: null,
    },
  });
  if (done.count !== 1) {
    logOf(deps)('preview finished after leaving RUNNING (interrupted or timed out) — result discarded', { id, tenantId });
    return;
  }
  try {
    await pruneOldResults(deps, tenantId);
  } catch (e) {
    logOf(deps)('preview result pruning failed', { id, tenantId }, e);
  }
}

async function finishFailed(deps: PreviewJobDeps, id: string, tenantId: string, e: unknown): Promise<void> {
  const code = jobFailureCodeOf(e);
  logOf(deps)('preview failed', { id, tenantId, code }, e);
  const now = deps.now();
  try {
    await deps.db.glLinkPreview.updateMany({
      where: { id, status: 'RUNNING' },
      data: { status: 'FAILED', errorCode: code, error: PREVIEW_ERROR_MESSAGES[code], finishedAt: now, heartbeatAt: now },
    });
  } catch (err) {
    logOf(deps)('preview failure write failed', { id, tenantId, code }, err);
  }
}

/**
 * تُبقى نتائج آخر PREVIEW_KEEP_RESULTS معاينة منجزة للشركة ومعاينةُ الاعتماد (GlSettings.linkPreviewId)، ويُفرَّغ result
 * لما سواها (الصفّ يبقى بحالته وبصمتيه للتدقيق). عبارة واحدة لا تمسّ إلا صفوفاً ما زالت تحمل نتيجة.
 */
export async function pruneOldResults(deps: Pick<PreviewJobDeps, 'db'>, tenantId: string): Promise<number> {
  const keep = await deps.db.glLinkPreview.findMany({
    where: { tenantId, status: 'DONE' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: PREVIEW_KEEP_RESULTS,
    select: { id: true },
  });
  const s = await deps.db.glSettings.findUnique({ where: { tenantId }, select: { linkPreviewId: true } });
  const exclude = [...keep.map((k) => k.id), ...(s?.linkPreviewId ? [s.linkPreviewId] : [])];
  const r = await deps.db.glLinkPreview.updateMany({
    where: { tenantId, id: { notIn: exclude }, result: { not: Prisma.DbNull } },
    data: { result: Prisma.DbNull },
  });
  return r.count;
}

// ═══ الاعتماديات الإنتاجية ═══

/** عميل المعاينة المخصّص — مرة لكل عملية، ويُفصل حين يفرغ الطابور (Prisma يعيد الاتصال كسولاً) */
let previewClient: PrismaClient | null = null;

export function createPreviewJobDeps(base: {
  db: PreviewJobDeps['db'] & { $transaction: PrismaClient['$transaction'] };
  runPreview: typeof runPreview;
  parseDraft: PreviewJobDeps['parseDraft'];
  env?: NodeJS.ProcessEnv;
  /**
   * runPreview يفتح عميله بنفسه (العملية الفرعية المعزولة — previewIsolate.ts): لا عميل معاينة في الخادم ولا اتصال خامل له —
   * previewDb() يعيد العميل الرئيسي ولا يُقرأ منه شيء
   */
  ownsClient?: boolean;
}): PreviewJobDeps {
  const env = base.env ?? process.env;
  if (base.ownsClient) {
    return {
      db: base.db, runPreview: base.runPreview, parseDraft: base.parseDraft, env, now: () => new Date(),
      previewDb: () => base.db,
      async releasePreviewDb() { /* لا عميل في الخادم */ },
    };
  }
  return {
    db: base.db,
    runPreview: base.runPreview,
    parseDraft: base.parseDraft,
    env,
    now: () => new Date(),
    previewDb() {
      // اتصالان: لقطة المعاينة معاملةٌ مُصدِّرة + معاملة قراءة دوّارة (snapshot.ts) — باتصالٍ واحد تنتظر الدوّارة المُصدِّرةَ أبداً
      if (!previewClient && env.DATABASE_URL) {
        previewClient = new PrismaClientCtor({ datasources: { db: { url: withConnectionLimit(env.DATABASE_URL, 2) } }, log: ['error'] });
      }
      // بلا DATABASE_URL (لا يحدث في الإنتاج) ⇒ العميل الرئيسي
      return previewClient ?? base.db;
    },
    async releasePreviewDb() {
      if (previewClient) await previewClient.$disconnect();
    },
  };
}
