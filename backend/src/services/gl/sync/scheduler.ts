/**
 * مجدول المزامنة (M3، DESIGN.md §5.1).
 *
 * - نبضة كل 60 ثانية للشركات التي accountingSuiteEnabled=true وactivatedAt≠null، بالتناوب حسب أقدم lastSyncAt.
 * - ميزانية عامة للنبضة كلها لا لكل شركة: ≤ 3 ثوانٍ و≤ 300 حدث عبر كل الشركات.
 * - عزل عن مسار الطلبات: PrismaClient مستقل بـ?connection_limit=1، وتُتخطى النبضة إن تجاوزت الطلبات الجارية عتبة
 *   (trackLedgerRequestLoad يعدّها في index.ts بجانب عدّاد services/requestCounter.ts القائم).
 * - الإطفاء: LEDGER_WORKER_ENABLED=0.
 * - يبدأ من index.ts بنمط startPaylinkScheduler: startLedgerSyncScheduler().
 */
import type { NextFunction, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { backfillReconcilerFn, refreshBackfillState } from '../backfill';
import { recordChecksReport } from '../checks/notify';
import { runChecks } from '../checks/run';
import { createPrismaCheckStore } from '../checks/store.prisma';
import type { BackfillState } from '../types';
import { createSyncBudget, type SyncBudget } from './poster';
import type { PostingStore } from './postingStore';
import { PrismaPostingStore, createWorkerPrismaClient } from './postingStore.prisma';
import { createPrismaReconcilerStore } from './reconcilerStore.prisma';
import { runManualSync, runTenantTick, safetyNetFn, type TickDeps } from './tick';
import {
  SYNC_HEARTBEAT_MS, TICK_DB_BUDGET_MS, TICK_EVENT_BUDGET,
  type ManualSyncResponse, type SchedulerTickResult,
} from './types';

// ═══ ضغط الطلبات ═══

let inFlight = 0;

/** عدد طلبات HTTP الجارية الآن في العملية */
export function inFlightRequestCount(): number {
  return inFlight;
}

/**
 * الاتصالات طويلة العمر (SSE مثل GET /api/live/stream) لا تُعدّ طلبات جارية: تبقى مفتوحة ما دام التبويب مفتوحاً،
 * فلو عُدّت لتجاوز ٢١ تبويباً إدارياً مفتوحاً العتبة وتخطّى المعالج كل نبضة بلا أي حِمل فعلي.
 * الوسيط مركّب على '/api' فـreq.path هنا '/live/stream' وreq.originalUrl '/api/live/stream'.
 */
export function isLongLivedRequest(req: Pick<Request, 'path' | 'originalUrl' | 'headers'> & { url?: string }): boolean {
  const path = String(req.path ?? '');
  const url = String(req.originalUrl ?? req.url ?? '');
  if (path.startsWith('/live/') || url.startsWith('/api/live/')) return true;
  return String(req.headers?.accept ?? '').includes('text/event-stream');
}

/** وسيط Express يعدّ الطلبات الجارية فقط (لا يغيّر الطلب ولا الرد) — عدا الاتصالات طويلة العمر */
export function trackLedgerRequestLoad(req: Request, res: Response, next: NextFunction): void {
  if (isLongLivedRequest(req)) { next(); return; }
  inFlight++;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    inFlight = Math.max(0, inFlight - 1);
  };
  res.once('finish', finish);
  res.once('close', finish);
  // شبكة أمان: رد تحوّل إلى text/event-stream بعد عدّه يخرج من العدّ فوراً (لا يغيّر الترويسة نفسها)
  const setHeader = res.setHeader;
  if (typeof setHeader === 'function') {
    res.setHeader = function patchedSetHeader(this: Response, name: string, value: number | string | readonly string[]) {
      if (!done && String(name).toLowerCase() === 'content-type' && String(value).toLowerCase().startsWith('text/event-stream')) finish();
      return setHeader.call(this, name, value);
    } as Response['setHeader'];
  }
  next();
}

/** العتبة الافتراضية للطلبات الجارية (LEDGER_WORKER_MAX_INFLIGHT) */
export function requestPressureThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LEDGER_WORKER_MAX_INFLIGHT);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

export function isLedgerWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LEDGER_WORKER_ENABLED !== '0';
}

// ═══ النبضة العامة ═══

/** تقدم الترحيل التاريخي بعد نبضة شركة (refreshBackfillState): state بعد الكتابة الشرطية، وnull قبل التفعيل */
export type RefreshBackfillFn = (tenantId: string) => Promise<{ state: BackfillState; caughtUp: boolean } | null>;

export interface SchedulerDeps extends TickDeps {
  enabled?: boolean;
  clock?: () => number;
  inFlightRequests?: () => number;
  pressureThreshold?: number;
  tenantLimit?: number;
  budget?: { timeMs?: number; events?: number };
  /** §5.6: RUNNING ⇒ DONE حين تكتمل المؤشرات دون انتظار فتح GET /setup */
  refreshBackfill?: RefreshBackfillFn | null;
  /** الفحوص التلقائية عند DONE (§5.6 «وتُشغَّل فحوصات السلامة تلقائياً») */
  onBackfillDone?: ((tenantId: string) => Promise<void>) | null;
  /** أقل فاصل بين تقييمين للتقدم لكل شركة (الافتراضي BACKFILL_REFRESH_INTERVAL_MS) */
  backfillRefreshIntervalMs?: number;
  /** عدد التخطيات المتتالية بـREQUEST_PRESSURE قبل التسجيل (الافتراضي 5) */
  pressureLogAfter?: number;
  /** قفل العامل المشترك مع «مزامنة الآن» والفحوص الليلية (الافتراضي LEDGER_WORKER_MUTEX) */
  mutex?: WorkerMutex;
}

export interface LedgerSyncScheduler {
  tick(): Promise<SchedulerTickResult>;
  readonly running: boolean;
}

/** فاصل تقييم تقدم الترحيل التاريخي لكل شركة داخل النبضة */
export const BACKFILL_REFRESH_INTERVAL_MS = 5 * 60_000;

/**
 * قفل داخل العملية يتشاركه المجدول و«مزامنة الآن» والفحوص الليلية: عميل المعالج باتصال واحد (connection_limit=1)،
 * فتزاحُم مسارين عليه يُفشل استعلامات أحدهما بـP2024/P2028 فتُحتسب فشلاً على أحداث صالحة.
 */
export interface WorkerMutex { busy: boolean }
export const LEDGER_WORKER_MUTEX: WorkerMutex = { busy: false };

export function createLedgerSyncScheduler(deps: SchedulerDeps): LedgerSyncScheduler {
  let running = false;
  let pressureSkips = 0;
  const clock = deps.clock ?? Date.now;
  const store: PostingStore = deps.store;
  const mutex = deps.mutex ?? LEDGER_WORKER_MUTEX;
  const lastRefresh = new Map<string, number>();
  const log = deps.log ?? ((m: string, d?: Record<string, unknown>) => console.error(`📒 ledger scheduler: ${m}`, d ?? ''));
  return {
    get running() { return running; },
    async tick(): Promise<SchedulerTickResult> {
      const startedAt = new Date(clock());
      const skip = (skipped: SchedulerTickResult['skipped']): SchedulerTickResult => ({ startedAt, skipped, tenants: [], eventsProcessed: 0, dbTimeMs: 0 });
      if (deps.enabled === false) return skip('WORKER_DISABLED');
      if (running || mutex.busy) return skip('TICK_IN_PROGRESS');
      const load = (deps.inFlightRequests ?? inFlightRequestCount)();
      const threshold = deps.pressureThreshold ?? requestPressureThreshold();
      if (load > threshold) {
        pressureSkips++;
        if (pressureSkips === (deps.pressureLogAfter ?? 5)) log('ticks skipped under request pressure', { consecutive: pressureSkips, load, threshold });
        return skip('REQUEST_PRESSURE');
      }
      pressureSkips = 0;
      running = true;
      mutex.busy = true;
      const budget: SyncBudget = createSyncBudget({
        clock, timeMs: deps.budget?.timeMs ?? TICK_DB_BUDGET_MS, events: deps.budget?.events ?? TICK_EVENT_BUDGET,
      });
      const result: SchedulerTickResult = { startedAt, skipped: null, tenants: [], eventsProcessed: 0, dbTimeMs: 0 };
      try {
        const tenants = await store.listEligibleTenants(deps.tenantLimit);
        for (const t of tenants) {
          if (clock() >= budget.deadline || budget.eventsRemaining <= 0) break;
          try {
            const r = await runTenantTick(deps, t.tenantId, budget);
            result.tenants.push(r);
            result.eventsProcessed += r.post?.attempted ?? 0;
            if (r.leaseAcquired && r.backfillState === 'RUNNING' && deps.refreshBackfill) {
              await refreshBackfillAfterTick(deps, t.tenantId, lastRefresh, clock, log);
            }
          } catch (e) {
            log('tenant tick failed', { tenantId: t.tenantId, error: (e as Error)?.message });
          }
        }
      } finally {
        result.dbTimeMs = clock() - startedAt.getTime();
        running = false;
        mutex.busy = false;
      }
      return result;
    },
  };
}

/** تقييم التقدم بفاصل لكل شركة؛ الانتقال إلى DONE يشغّل الفحوص (الأخطاء تُسجَّل ولا توقف النبضة) */
async function refreshBackfillAfterTick(
  deps: SchedulerDeps, tenantId: string, lastRefresh: Map<string, number>, clock: () => number,
  log: (m: string, d?: Record<string, unknown>) => void,
): Promise<void> {
  const now = clock();
  const prev = lastRefresh.get(tenantId);
  if (prev !== undefined && now - prev < (deps.backfillRefreshIntervalMs ?? BACKFILL_REFRESH_INTERVAL_MS)) return;
  lastRefresh.set(tenantId, now);
  try {
    const p = await deps.refreshBackfill!(tenantId);
    if (p?.state === 'DONE' && deps.onBackfillDone) {
      try {
        await deps.onBackfillDone(tenantId);
      } catch (e) {
        log('checks at backfill DONE failed', { tenantId, error: (e as Error)?.message });
      }
    }
  } catch (e) {
    log('backfill refresh failed', { tenantId, error: (e as Error)?.message });
  }
}

// ═══ الفحوص الليلية (§5.9 «تعمل ليلياً وعند الطلب») ═══

/** فاصل فحص «هل حان تشغيل اليوم؟» */
export const NIGHTLY_CHECKS_POLL_MS = 60 * 60_000;
/** الساعة المحلية التي يبدأ منها تشغيل اليوم (فجراً بتوقيت الشركة) */
export const NIGHTLY_CHECKS_LOCAL_HOUR = 2;

export interface NightlyChecksDeps {
  listTenants(): Promise<{ tenantId: string }[]>;
  /** المنطقة الزمنية للشركة (null ⇒ غير مفعّلة أو المجموعة مطفأة: تُتخطى) */
  timezoneOf(tenantId: string): Promise<string | null>;
  /** runChecks ثم recordChecksReport (الكاش والإشعار) */
  runAndRecord(tenantId: string): Promise<void>;
  clock?: () => number;
  /** آخر يوم محلي شُغّل فيه لكل شركة */
  lastRun?: Map<string, string>;
  mutex?: WorkerMutex;
  enabled?: boolean;
  inFlightRequests?: () => number;
  pressureThreshold?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

const NIGHTLY_LAST_RUN = new Map<string, string>();

function localDayHour(now: Date, timezone: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/**
 * جولة واحدة: لكل شركة مؤهلة لم تُفحص اليوم المحلي بعد (وبعد الساعة NIGHTLY_CHECKS_LOCAL_HOUR) تُشغَّل الفحوص تسلسلياً،
 * خارج ميزانية النبضة وتحت قفل العامل نفسه، ويُعزل خطأ كل شركة. يعيد الشركات التي فُحصت.
 */
export async function runNightlyChecksRound(deps: NightlyChecksDeps): Promise<string[]> {
  const clock = deps.clock ?? Date.now;
  const mutex = deps.mutex ?? LEDGER_WORKER_MUTEX;
  const lastRun = deps.lastRun ?? NIGHTLY_LAST_RUN;
  const log = deps.log ?? ((m: string, d?: Record<string, unknown>) => console.error(`📒 ledger nightly checks: ${m}`, d ?? ''));
  if (deps.enabled === false || mutex.busy) return [];
  if ((deps.inFlightRequests ?? inFlightRequestCount)() > (deps.pressureThreshold ?? requestPressureThreshold())) return [];
  mutex.busy = true;
  const ran: string[] = [];
  try {
    for (const t of await deps.listTenants()) {
      try {
        const tz = await deps.timezoneOf(t.tenantId);
        if (!tz) continue;
        const { day, hour } = localDayHour(new Date(clock()), tz);
        if (hour < NIGHTLY_CHECKS_LOCAL_HOUR || lastRun.get(t.tenantId) === day) continue;
        lastRun.set(t.tenantId, day);
        await deps.runAndRecord(t.tenantId);
        ran.push(t.tenantId);
      } catch (e) {
        log('tenant checks failed', { tenantId: t.tenantId, error: (e as Error)?.message });
      }
    }
  } finally {
    mutex.busy = false;
  }
  return ran;
}

// ═══ التشغيل في العملية ═══

let workerClient: PrismaClient | null = null;
let workerDeps: SchedulerDeps | null = null;
let started = false;

/** اعتماديات المعالج الفعلية (PrismaClient مستقل بـconnection_limit=1) — null بلا DATABASE_URL */
export function ledgerWorkerDeps(): SchedulerDeps | null {
  if (workerDeps) return workerDeps;
  workerClient = workerClient ?? createWorkerPrismaClient();
  if (!workerClient) return null;
  const client = workerClient;
  const reconcilerStore = createPrismaReconcilerStore(client);
  workerDeps = {
    store: new PrismaPostingStore(client),
    // الإيقاع وإيقاف الترحيل التاريخي المؤقت (§5.6): حد صفحات أثناء RUNNING ولا قراءة أثناء PAUSED
    reconcile: backfillReconcilerFn(reconcilerStore),
    safetyNet: safetyNetFn(reconcilerStore),
    refreshBackfill: (id) => refreshBackfillState(client, id),
    onBackfillDone: (id) => runAndRecordChecks(client, id),
  };
  return workerDeps;
}

/** الفحوص كاملة لشركة ثم تسجيل التقرير (الكاش والإشعار المشترك مع POST /checks/run) */
export async function runAndRecordChecks(client: PrismaClient, tenantId: string): Promise<void> {
  const report = await runChecks(createPrismaCheckStore(client), tenantId);
  await recordChecksReport(client, tenantId, report);
}

export interface ManualSyncGuardDeps {
  enabled?: boolean;
  mutex?: WorkerMutex;
  inFlightRequests?: () => number;
  pressureThreshold?: number;
}

/**
 * «مزامنة الآن» بحراسة العامل: مطفأ (LEDGER_WORKER_ENABLED=0) ⇒ LEDGER_WORKER_UNAVAILABLE (503)؛ نبضة أو فحص ليلي جارٍ
 * على الاتصال الواحد، أو ضغط طلبات ⇒ {running: true, pendingEvents} (202) دون تزاحم.
 */
export async function guardedManualSync(deps: TickDeps, tenantId: string, guard: ManualSyncGuardDeps = {}): Promise<ManualSyncResponse> {
  if (guard.enabled === false) throw new Error('LEDGER_WORKER_UNAVAILABLE');
  const mutex = guard.mutex ?? LEDGER_WORKER_MUTEX;
  const pressured = (guard.inFlightRequests ?? inFlightRequestCount)() > (guard.pressureThreshold ?? requestPressureThreshold());
  if (mutex.busy || pressured) return { running: true, pendingEvents: await deps.store.countPendingEvents(tenantId) };
  mutex.busy = true;
  try {
    return await runManualSync(deps, tenantId);
  } finally {
    mutex.busy = false;
  }
}

/** «مزامنة الآن» لمسار POST /api/ledger/sync — عبر عميل المعالج نفسه وقفله */
export async function runLedgerManualSync(tenantId: string): Promise<ManualSyncResponse> {
  if (!isLedgerWorkerEnabled()) throw new Error('LEDGER_WORKER_UNAVAILABLE');
  const deps = ledgerWorkerDeps();
  if (!deps) throw new Error('LEDGER_WORKER_UNAVAILABLE');
  return guardedManualSync(deps, tenantId, { enabled: true });
}

/**
 * يُستدعى من index.ts بعد الإقلاع. لا شيء إن كان LEDGER_WORKER_ENABLED=0. الشركات غير المفعّلة (activatedAt فارغ،
 * أي كل الشركات اليوم) لا تُقرأ لها أي صفوف: الاستعلام الوحيد قائمة المؤهلين.
 */
export function startLedgerSyncScheduler(): void {
  if (started || !isLedgerWorkerEnabled()) return;
  const deps = ledgerWorkerDeps();
  if (!deps) return;
  started = true;
  const scheduler = createLedgerSyncScheduler({ ...deps, enabled: true });
  const tick = async () => {
    try {
      const r = await scheduler.tick();
      if (r.eventsProcessed > 0) {
        console.log(`📒 ledger sync: ${r.eventsProcessed} events across ${r.tenants.length} tenants in ${r.dbTimeMs}ms`);
      }
    } catch (e) {
      console.error('ledger sync tick error:', (e as Error)?.message);
    }
  };
  setInterval(() => { void tick(); }, SYNC_HEARTBEAT_MS);
  // الفحوص الليلية (§5.9): جولة كل ساعة، ومرة لكل شركة في اليوم المحلي — بالمفتاح نفسه LEDGER_WORKER_ENABLED
  const client = workerClient!;
  const nightly = async () => {
    try {
      await runNightlyChecksRound({
        listTenants: () => deps.store.listEligibleTenants(),
        timezoneOf: async (id) => {
          const s = await deps.store.loadPosterSettings(id);
          return s?.activatedAt && s.suiteEnabled ? s.timezone : null;
        },
        runAndRecord: (id) => runAndRecordChecks(client, id),
      });
    } catch (e) {
      console.error('ledger nightly checks error:', (e as Error)?.message);
    }
  };
  setInterval(() => { void nightly(); }, NIGHTLY_CHECKS_POLL_MS);
  console.log('📒 Ledger sync scheduler started (every 60s)');
}
