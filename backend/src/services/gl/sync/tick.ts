/**
 * نبضة شركة واحدة (M3، DESIGN.md §5.1): عقد الإيجار ⇒ المُطابِق ⇒ المُرحِّل ⇒ فك العقد في finally.
 *
 * - Set داخل العملية للشركات الجاري معالجتها (IN_PROCESS_TENANTS)، فلا تتداخل نبضة setInterval مع بطيئة ولا «مزامنة الآن».
 * - token = randomUUID() **لكل نبضة**؛ tryAcquireLease بساعة القاعدة ويستمر فقط إن كانت النتيجة 1.
 * - الصحة لا تعتمد على العقد: قفل gl-post داخل كل معاملة ترحيل، و@@unique([tenantId, sourceKey])، وتقدم المؤشر أحادي الاتجاه.
 * - «مزامنة الآن» (runManualSync): الخطوة نفسها بميزانية 2 ثانية، ومرة كل 60 ثانية لكل شركة؛ دون العقد ⇒ {running: true, pendingEvents}.
 * بلا prisma: المخزنان يُحقنان (scheduler.ts يبني تنفيذي Prisma).
 */
import { randomUUID } from 'node:crypto';
import {
  RECONCILED_SOURCES,
} from './desired';
import { reconcileTenant, safetyNetScan, type ReconcilerStore } from './reconciler';
import { budgetExhausted, createSyncBudget, runPoster, type PosterOptions, type SyncBudget } from './poster';
import type { PosterSettings, PostingStore } from './postingStore';
import {
  MANUAL_SYNC_BUDGET_MS, MANUAL_SYNC_MIN_INTERVAL_MS, SAFETY_NET_INTERVAL_MS, TICK_EVENT_BUDGET,
  type ManualSyncResponse, type ReconcileSourceResult, type TenantTickResult,
} from './types';

/**
 * المُطابِق كما تستدعيه النبضة. الافتراضي (reconcilerFn) يلفّ reconcileTenant(store, tenantId, {clock, deadline, dbNow})
 * من sync/reconciler.ts بالميزانية المشتركة نفسها.
 */
export type ReconcileFn = (tenantId: string, budget: SyncBudget, ctx: { settings: PosterSettings; dbNow: Date }) => Promise<ReconcileSourceResult[]>;

/** شبكة الأمان (§5.2 البند 4): مسح آخر 24 ساعة كل 30 دقيقة لكل شركة، داخل ميزانية النبضة */
export type SafetyNetFn = (tenantId: string, budget: SyncBudget, ctx: { settings: PosterSettings; dbNow: Date }) => Promise<void>;

export interface TickDeps {
  store: PostingStore;
  reconcile?: ReconcileFn | null;
  safetyNet?: SafetyNetFn | null;
  /** الافتراضي IN_PROCESS_TENANTS المشترك في العملية */
  inProcess?: Set<string>;
  newToken?: () => string;
  poster?: PosterOptions;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

/** الشركات الجاري معالجتها في هذه العملية (§5.1 البند 4) */
export const IN_PROCESS_TENANTS = new Set<string>();

export function reconcilerFn(store: ReconcilerStore): ReconcileFn {
  return (tenantId, budget, ctx) => reconcileTenant(store, tenantId, { clock: budget.clock, deadline: budget.deadline, dbNow: ctx.dbNow });
}

/** آخر مسح شبكة أمان لكل شركة (بساعة التطبيق) */
const lastSafetyNet = new Map<string, number>();

export function safetyNetFn(store: ReconcilerStore, opts: { intervalMs?: number; lastRun?: Map<string, number> } = {}): SafetyNetFn {
  const interval = opts.intervalMs ?? SAFETY_NET_INTERVAL_MS;
  const last = opts.lastRun ?? lastSafetyNet;
  return async (tenantId, budget, ctx) => {
    const now = budget.clock();
    const prev = last.get(tenantId);
    if (prev !== undefined && now - prev < interval) return;
    let exhausted = false;
    for (const source of RECONCILED_SOURCES) {
      if (budgetExhausted(budget)) { exhausted = true; break; }
      const r = await safetyNetScan(store, tenantId, source, { clock: budget.clock, deadline: budget.deadline, dbNow: ctx.dbNow });
      if (r?.budgetExhausted) { exhausted = true; break; }
    }
    // لا يُسجَّل «تم» إلا بعد مسح كامل، فيُستأنف في نبضة لاحقة
    if (!exhausted) last.set(tenantId, now);
  };
}

function skippedResult(tenantId: string, skipped: TenantTickResult['skipped'], settings: PosterSettings | null, pendingEvents: number, started: number, clock: () => number): TenantTickResult {
  return {
    tenantId, leaseAcquired: false, skipped, reconcile: [], post: null, pendingEvents,
    backfillState: settings?.backfillState ?? 'NONE', durationMs: clock() - started,
  };
}

/**
 * نبضة شركة: NOT_ACTIVATED/SUITE_DISABLED (المؤشرات لا تتقدم أثناء الإطفاء §5.7) ⇒ IN_PROCESS ⇒ LEASE_HELD ⇒
 * المُطابِق ثم المُرحِّل ضمن budget، ثم lastSyncAt وفك العقد.
 */
export async function runTenantTick(deps: TickDeps, tenantId: string, budget: SyncBudget): Promise<TenantTickResult> {
  const { store } = deps;
  const clock = budget.clock;
  const started = clock();
  const inProcess = deps.inProcess ?? IN_PROCESS_TENANTS;
  const log = deps.log ?? ((msg, data) => console.error(`📒 ledger tick: ${msg}`, data ?? ''));

  const settings = await store.loadPosterSettings(tenantId);
  if (!settings || !settings.activatedAt) return skippedResult(tenantId, 'NOT_ACTIVATED', settings, 0, started, clock);
  if (!settings.suiteEnabled) return skippedResult(tenantId, 'SUITE_DISABLED', settings, 0, started, clock);
  if (inProcess.has(tenantId)) {
    return skippedResult(tenantId, 'IN_PROCESS', settings, await store.countPendingEvents(tenantId), started, clock);
  }

  inProcess.add(tenantId);
  const token = (deps.newToken ?? randomUUID)();
  let leased = false;
  try {
    leased = await store.tryAcquireLease(tenantId, token);
    if (!leased) return skippedResult(tenantId, 'LEASE_HELD', settings, await store.countPendingEvents(tenantId), started, clock);

    const dbNow = await store.dbNow();
    let reconcile: ReconcileSourceResult[] = [];
    if (deps.reconcile) {
      try {
        reconcile = await deps.reconcile(tenantId, budget, { settings, dbNow });
      } catch (e) {
        // فشل المُطابِق لا يمنع ترحيل ما أُدرج سابقاً
        log('reconcile failed', { tenantId, error: (e as Error)?.message });
      }
    }
    // «إيقاف مؤقت» الترحيل التاريخي (§5.6): لا قراءة لصفوف المصادر إطلاقاً، ومنها مسح شبكة الأمان
    if (deps.safetyNet && settings.backfillState !== 'PAUSED' && !budgetExhausted(budget)) {
      try {
        await deps.safetyNet(tenantId, budget, { settings, dbNow });
      } catch (e) {
        log('safety net failed', { tenantId, error: (e as Error)?.message });
      }
    }
    const post = await runPoster(store, settings, budget, { log, ...(deps.poster ?? {}) });
    await store.touchLastSync(tenantId, await store.dbNow());
    return {
      tenantId, leaseAcquired: true, skipped: null, reconcile, post,
      pendingEvents: await store.countPendingEvents(tenantId),
      backfillState: settings.backfillState,
      durationMs: clock() - started,
    };
  } finally {
    if (leased) {
      await store.releaseLease({ tenantId, token }).catch((e) => log('lease release failed', { tenantId, error: (e as Error)?.message }));
    }
    inProcess.delete(tenantId);
  }
}

// ═══ «مزامنة الآن» (§5.1) ═══

/** آخر «مزامنة الآن» لكل شركة (بساعة التطبيق) */
export const MANUAL_SYNC_LAST_RUN = new Map<string, number>();

export interface ManualSyncOptions {
  clock?: () => number;
  lastRun?: Map<string, number>;
}

/**
 * POST /api/ledger/sync: 200 {running:false, pendingEvents, result} أو 202 {running:true, pendingEvents, retryAfterSeconds?}
 * حين لم يفز بالعقد أو قبل مرور 60 ثانية على آخر مزامنة للشركة. المسار يقرر رمز الحالة من running.
 */
export async function runManualSync(deps: TickDeps, tenantId: string, opts: ManualSyncOptions = {}): Promise<ManualSyncResponse> {
  const clock = opts.clock ?? Date.now;
  const last = opts.lastRun ?? MANUAL_SYNC_LAST_RUN;
  const now = clock();
  const prev = last.get(tenantId);
  if (prev !== undefined && now - prev < MANUAL_SYNC_MIN_INTERVAL_MS) {
    return {
      running: true,
      pendingEvents: await deps.store.countPendingEvents(tenantId),
      retryAfterSeconds: Math.max(1, Math.ceil((MANUAL_SYNC_MIN_INTERVAL_MS - (now - prev)) / 1000)),
    };
  }
  last.set(tenantId, now);
  const budget = createSyncBudget({ clock, timeMs: MANUAL_SYNC_BUDGET_MS, events: TICK_EVENT_BUDGET });
  const result = await runTenantTick(deps, tenantId, budget);
  if (result.skipped === 'LEASE_HELD' || result.skipped === 'IN_PROCESS') {
    return { running: true, pendingEvents: result.pendingEvents };
  }
  return { running: false, pendingEvents: result.pendingEvents, result };
}
