// ============================================================================
// ZATCA المرحلة الثانية (Z5.3) — توصيل محرّك الإرسال بالإنتاج: مخازن Prisma، عميل «فاتورة»، الإشعارات، المسح الدوري، مفتاح الإيقاف
// ----------------------------------------------------------------------------
// z5_plan §3 «Z5.3»:
//   • كل شيء هنا اختياري الإعداد: بلا أيّ متغيّر بيئة يقلع الخادم كما اليوم، والمسح دورةٌ خاملة باستعلام واحد في الدقيقة
//     (لا مستندات مرحلة ثانية في الإنتاج اليوم ⇒ لا عمل ولا كلفة).
//   • الحصص والذاكرات (401 و429) نسخة واحدة لكل عملية، يتشاركها المسح والطلب الحيّ (Z5.4) — المقعد المحجوز للحيّ.
//   • الإشعارات صفوف Notification لإدارة الشركة (نصّها عربي)، وتنبيه المالك سطرُ سجلٍّ برموز ثابتة بلا أسرار.
//   • خنق الإشعارات المتكرّرة في الذاكرة: عطل وحدة واحد لا يولّد عشرات الصفوف.
// لا يستورد services/gl.
// ============================================================================

import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { FatooraClient, type ApiLogEntry, type FatooraEnv } from '../compliance/zatca/api';
import { prismaZatcaDocumentStore, type DocumentStoreTx } from '../compliance/zatca/documentStore.prisma';
import { prismaEgsUnitStore } from '../compliance/zatca/onboardingStore';
import { FINAL_DOCUMENT_STATUSES } from '../compliance/zatca/status';
import { keyringFromEnv } from '../compliance/zatca/secrets';
import {
  AuthFailureMemory, UnitPauseMemory, retryDocumentNow, submitDocument,
  type SubmitDeps, type SubmitNotification, type SubmitOptions, type SubmitResult, type TenantSubmitGate,
} from '../compliance/zatca/submit';
import {
  SubmitSlots, ZatcaSweepRunner, sweepEnabled, sweepIntervalMs, type SweepDeps, type SweepOptions, type SweepRunOutcome,
} from '../compliance/zatca/sweep';
import { INLINE_CLEARANCE_CALL_TIMEOUT_MS, INLINE_CLEARANCE_TIMEOUT_MS, withDeadline } from '../compliance/zatca/clearance';
import { afterVoidCommit, voidInvoiceInTx, type VoidTx } from './invoiceVoid';
import { publishInvoicesChanged } from './liveEvents';

// ─── مهل المعاملة (كتابة النتيجة والمرآة والإبطال فقط — لا شبكة داخلها) ───

export const OUTCOME_TX_MAX_WAIT_MS = 10_000;
export const OUTCOME_TX_TIMEOUT_MS = 20_000;
export const SUBMIT_CONCURRENCY_VAR = 'ZATCA_SUBMIT_CONCURRENCY';

function concurrency(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt((env[SUBMIT_CONCURRENCY_VAR] ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 1 && n <= 16 ? n : 3;
}

// ─── ذاكرات العملية (مشتركة بين المسح والطلب الحيّ) ───

export const submitSlots = new SubmitSlots({ total: concurrency() });
export const submitAuthMemory = new AuthFailureMemory();
export const submitPauses = new UnitPauseMemory();

// ─── الإشعارات ───

const NOTIFICATION_TYPES: Readonly<Record<SubmitNotification['kind'], string>> = Object.freeze({
  REJECTED: 'ZATCA_DOCUMENT_REJECTED',
  AUTH_BLOCKED: 'ZATCA_AUTH_BLOCKED',
  UNIT_AUTH_FAILED: 'ZATCA_UNIT_AUTH_FAILED',
  CONFIG_ERROR: 'ZATCA_SUBMIT_FAILED',
  CLEARED_NO_XML: 'ZATCA_CLEARED_NO_XML',
  STALE_KEY: 'ZATCA_STALE_KEY',
  DRAINING_UNIT: 'ZATCA_UNIT_DRAINING',
  OUTCOME_LOST: 'ZATCA_OUTCOME_LOST',
  OVERDUE: 'ZATCA_REPORT_OVERDUE',
});

/** خنق في الذاكرة: الرسالة نفسها لنفس المستند/الوحدة لا تتكرّر خلال ٦ ساعات (محاولات الإرسال كثيرة والإشعار واحد). */
const NOTIFY_THROTTLE_MS = 6 * 60 * 60 * 1000;
const NOTIFY_THROTTLE_MAX = 2000;
const notifiedAt = new Map<string, number>();

function throttled(n: SubmitNotification, at: number): boolean {
  const key = `${n.kind}:${n.documentId ?? n.egsUnitId ?? n.tenantId}:${n.level ?? ''}`;
  const prev = notifiedAt.get(key);
  if (prev !== undefined && at - prev < NOTIFY_THROTTLE_MS) return true;
  if (notifiedAt.size >= NOTIFY_THROTTLE_MAX) {
    for (const [k, t] of notifiedAt) {
      if (at - t >= NOTIFY_THROTTLE_MS) notifiedAt.delete(k);
    }
    if (notifiedAt.size >= NOTIFY_THROTTLE_MAX) notifiedAt.clear();
  }
  notifiedAt.set(key, at);
  return false;
}

async function notifyProduction(n: SubmitNotification): Promise<void> {
  const at = Date.now();
  if (throttled(n, at)) return;
  if (n.owner) {
    // تنبيه المالك: رموز ثابتة فقط (لا أسرار ولا نصّ فاتورة)
    console.error(`[zatca:submit] ${n.kind} tenant=${n.tenantId} unit=${n.egsUnitId ?? '-'} doc=${n.documentId ?? '-'} level=${n.level ?? '-'}`);
  }
  try {
    await prisma.notification.create({
      data: {
        tenantId: n.tenantId,
        type: NOTIFICATION_TYPES[n.kind],
        title: n.titleAr,
        body: n.bodyAr,
        data: JSON.stringify({ documentId: n.documentId, invoiceId: n.invoiceId, egsUnitId: n.egsUnitId, ...n.data }),
      },
    });
  } catch { /* الإشعار لا يغيّر نتيجة الإرسال */ }
}

// ─── ما بعد الالتزام (Z5.4) ───

/**
 * أعمال تُنفَّذ **بعد** التزام معاملة النتيجة وحدها (إماتة روابط الدفع والبثّ): خطّاف الإبطال يعمل داخل المعاملة،
 * ولا نداء شبكيّ ولا بثّ تحت قفل. المفتاح مقبض المعاملة نفسه، والصفّ يُمحى مع خروجها (لا تسرّب).
 */
const afterCommitJobs = new Map<object, (() => void)[]>();

function onCommit(tx: unknown, job: () => void): void {
  afterCommitJobs.get(tx as object)?.push(job);
}

// ─── الاعتماديات ───

let cached: SweepDeps<DocumentStoreTx> | null = null;

export function productionSubmitDeps(env: NodeJS.ProcessEnv = process.env): SweepDeps<DocumentStoreTx> {
  if (cached) return cached;
  const documents = prismaZatcaDocumentStore(prisma);
  const units = prismaEgsUnitStore(prisma);
  const deps: SweepDeps<DocumentStoreTx> = {
    documents,
    units,
    gate: {
      async loadSubmitGate(tenantId: string): Promise<TenantSubmitGate | null> {
        const s = await prisma.companySettings.findUnique({
          where: { tenantId },
          select: { zatcaPhase2StartedAt: true, zatcaSubmitPausedAt: true },
        });
        if (!s) return null;
        return { live: s.zatcaPhase2StartedAt != null, pausedAt: s.zatcaSubmitPausedAt };
      },
    },
    // حلقة المفاتيح تُقرأ لكل إرسال (مفتاح مفقود ⇒ حسم محلّي بإشعار لا انهيار عند الإقلاع)
    keyring: () => keyringFromEnv(env),
    client: ({ env: fatooraEnv, log, timeoutMs }: { env: FatooraEnv; log: (e: ApiLogEntry) => Promise<void>; timeoutMs: number }) =>
      new FatooraClient({ env: fatooraEnv, log, submissionTimeoutMs: timeoutMs }),
    transaction: async <T>(fn: (tx: DocumentStoreTx) => Promise<T>): Promise<T> => {
      const jobs: (() => void)[] = [];
      const out = await prisma.$transaction(async tx => {
        afterCommitJobs.set(tx as object, jobs);
        try {
          return await fn(tx as DocumentStoreTx);
        } finally {
          afterCommitJobs.delete(tx as object);
        }
      }, { maxWait: OUTCOME_TX_MAX_WAIT_MS, timeout: OUTCOME_TX_TIMEOUT_MS });
      // التُزمت المعاملة: الآن وحدها تموت روابط الدفع وتُبثّ الفواتير (فشلها لا يُلغي إبطالاً حُسم)
      for (const job of jobs) {
        try { job(); } catch (e) { console.error('[zatca:submit] after-commit job failed:', (e as Error).message); }
      }
      return out;
    },
    /**
     * Z5.4 (نقد 7): إبطال الفاتورة القياسية المرفوضة **داخل معاملة النتيجة نفسها** — لا انهيار يترك فاتورةً مرفوضةً
     * قائمةً إلى الأبد (المستند المرفوض نهائيّ فلا يُطالَب ثانيةً). المبسّطة لا تُبطل: ورقتها مع المشتري (design Z5.9).
     */
    onRejectedInTx: async (tx, info) => {
      if (info.subtype !== '01') return;
      const outcome = await voidInvoiceInTx(tx as unknown as VoidTx, {
        tenantId: info.tenantId, invoiceId: info.invoiceId, subtype: info.subtype, reason: 'REJECTED',
        documentId: info.documentId, errors: info.errors.map(e => ({ code: e.code ?? null, message: e.message ?? null })), at: info.at,
      });
      if (outcome.voided) onCommit(tx, () => afterVoidCommit(info.tenantId, info.invoiceId));
      else if (outcome.refusal !== null) {
        console.error(`[zatca:submit] rejected invoice not voided (${outcome.refusal}) tenant=${info.tenantId} invoice=${info.invoiceId}`);
      }
    },
    publish: publishInvoicesChanged,
    notify: notifyProduction,
    authMemory: submitAuthMemory,
    pauses: submitPauses,
    slots: submitSlots,
    now: () => new Date(),
    env,
  };
  cached = deps;
  return deps;
}

let runner: ZatcaSweepRunner<DocumentStoreTx> | null = null;

export function sweepRunner(opts: SweepOptions = {}): ZatcaSweepRunner<DocumentStoreTx> {
  if (!runner) runner = new ZatcaSweepRunner(productionSubmitDeps(), opts);
  return runner;
}

// ─── الواجهة التشغيلية ───

/** المسح الدوري داخل العملية (كما startPaylinkScheduler): ZATCA_SWEEP_ENABLED=false يطفئه. */
export function startZatcaSweep(): void {
  if (!sweepEnabled()) {
    console.log('🧾 ZATCA sweep disabled (ZATCA_SWEEP_ENABLED=false)');
    return;
  }
  const ms = sweepIntervalMs();
  sweepRunner().start(ms);
  console.log(`🧾 ZATCA submission sweep started (every ${Math.round(ms / 1000)}s · idle = one indexed query)`);
}

export function stopZatcaSweep(): void {
  runner?.stop();
}

/** تشغيل يدوي واحد (نقطة التشغيل /api/ops/zatca-sweep). */
export async function runZatcaSweepNow(opts: SweepOptions = {}): Promise<SweepRunOutcome> {
  return sweepRunner().runOnce(opts);
}

/**
 * صنف المقعد مفصولٌ عن استراتيجية الإرسال (مراجعة عدائية ٢): `inline` يعني «تجاهل الجدولة بلا إعادة إدراج»، وهو ما
 * لا يصلح لمستند محجوب (nextAttemptAt فارغ ⇒ لا يُستولى عليه)؛ فالإعادة اليدوية تحتاج `retryDocumentNow` **ومقعد**
 * الطلب الحيّ معاً. `slot` يفصلهما فلا يقف طلبُ مديرٍ خلف طابور المسح.
 */
export type SubmitNowOptions = SubmitOptions & { slot?: 'inline' | 'sweep' };

/** إرسال مستند بعينه الآن (Z5.4 للاعتماد الحيّ، وZ5.6c للإعادة اليدوية). */
export async function submitDocumentNow(ref: { documentId: string; tenantId: string }, opts: SubmitNowOptions = {}): Promise<SubmitResult> {
  const deps = productionSubmitDeps();
  const run = (): Promise<SubmitResult> => (opts.ignoreSchedule && !opts.inline
    ? retryDocumentNow(deps, ref, opts)
    : submitDocument(deps, ref, opts));
  return submitSlots.run(opts.slot ?? (opts.inline ? 'inline' : 'sweep'), run);
}

/** لماذا رُفضت الإعادة اليدوية (نصوصها العربية في المسار). */
export type RetryRefusal = 'NO_DOCUMENT' | 'DOCUMENT_FINAL' | 'IN_FLIGHT' | 'NOT_RETRYABLE' | 'PAUSED';

export interface RetryPhase2Result {
  ok: boolean;
  refusal: RetryRefusal | null;
  documentId: string | null;
  documentStatus: string | null;
  mirror: string | null;
  /** انقضت نافذة الانتظار والإرسال يكمل في الخلفية (المسح شبكة الأمان) — المسار يردّ 202 لا 200. */
  pending?: boolean;
}

/**
 * الإعادة اليدوية (مدير الشركة) — المخرج الذي كان ينقص المستندَ المحجوب: يعيده إلى الطابور بالبايتات نفسها ويرسله
 * الآن (المقعد المحجوز للحيّ). لا يتخطّى إيقاف الشركة ولا إيقاف 429، ولا يلمس مستنداً حسمته الهيئة ولا مستنداً
 * يرسله عاملٌ الآن.
 */
export async function retryPhase2Document(input: { tenantId: string; invoiceId: string }): Promise<RetryPhase2Result> {
  const documents = prismaZatcaDocumentStore(prisma);
  const p = await documents.loadProjection(input.tenantId, input.invoiceId);
  const none: RetryPhase2Result = { ok: false, refusal: 'NO_DOCUMENT', documentId: null, documentStatus: null, mirror: null };
  if (!p) return none;
  const base = { documentId: p.id, documentStatus: p.status, mirror: null as string | null };
  if ((FINAL_DOCUMENT_STATUSES as readonly string[]).includes(p.status)) return { ok: false, refusal: 'DOCUMENT_FINAL', ...base };
  if (p.status === 'SUBMITTING') return { ok: false, refusal: 'IN_FLIGHT', ...base };
  /* مقعد الطلب الحيّ ومهلةٌ صريحة (مراجعة عدائية ٢): كان الطلب يأخذ مقعد المسح بلا حدٍّ زمنيّ، فينتظر المديرُ خلف
   * دفعة المسح كاملةً ثمّ ثلاثين ثانية أخرى بلا ردّ. الإرسال يكمل في الخلفية على كلّ حال. */
  const deadline = await withDeadline(
    submitDocumentNow({ documentId: p.id, tenantId: input.tenantId },
      { ignoreSchedule: true, slot: 'inline', timeoutMs: INLINE_CLEARANCE_CALL_TIMEOUT_MS }),
    INLINE_CLEARANCE_TIMEOUT_MS,
  );
  if (deadline.timedOut) return { ok: true, refusal: null, ...base, documentStatus: 'SUBMITTING', pending: true };
  if (deadline.error) throw deadline.error;
  const r = deadline.value as SubmitResult;
  if (r.kind === 'skipped') {
    const refusal: RetryRefusal = r.reason === 'PAUSED' || r.reason === 'RATE_PAUSED' ? 'PAUSED'
      : r.reason === 'LEASE_EXPIRED' ? 'IN_FLIGHT' : 'NOT_RETRYABLE';
    return { ok: false, refusal, ...base };
  }
  return { ok: true, refusal: null, documentId: r.documentId, documentStatus: r.status, mirror: r.mirror };
}

/** مفتاح إيقاف الإرسال لشركة (المالك): يُستبعد مستنداتها من الاستيلاء في الاستعلام نفسه. */
export async function setTenantSubmitPaused(tenantId: string, paused: boolean): Promise<{ tenantId: string; pausedAt: Date | null }> {
  const pausedAt = paused ? new Date() : null;
  const data: Prisma.CompanySettingsUpdateManyMutationInput = { zatcaSubmitPausedAt: pausedAt };
  const r = await prisma.companySettings.updateMany({ where: { tenantId }, data });
  if (r.count !== 1) throw new Error('COMPANY_SETTINGS_NOT_FOUND');
  return { tenantId, pausedAt };
}
