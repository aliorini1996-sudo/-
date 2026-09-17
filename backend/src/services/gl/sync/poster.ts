/**
 * المُرحِّل Poster (M3، DESIGN.md §5.4، §5.5، §5.6، ADR‑7).
 *
 * لكل حدث مستحق (PENDING، أو BLOCKED/ERROR بـnextAttemptAt ≤ now) بترتيب effectAt ثم rank ثم sourceKey:
 *   1. أفق المخزون (M9): حدث مخزون بعد الأفق أو بعد رأس طابور محجوب ⇒ يبقى PENDING بلا attempts++.
 *   2. HELD(CURRENCY_MISMATCH) لمصادر المبيعات حين تختلف عملة الإعدادات المجمّدة عن عملة الشركة.
 *   3. داخل withPostLock (pg_advisory_xact_lock أولاً): إعادة قراءة الحدث وشقيقه، ثم planEvent (التصنيف بالنسبة
 *      لتاريخ البدء + بوابة الأشقاء)، ثم builder صرف ⇐ مسودة ⇐ postMove، وتحديث الحدث DONE في المعاملة نفسها.
 *   4. P2002 بهدف [tenantId, sourceKey] ⇒ DONE بـmoveId الربط القائم (idempotent)؛ أي P2002 آخر أو خطأ ⇒ تراجع كامل
 *      ثم attempts++ بسلم 1m,5m,30m,2h,12h ⇒ ERROR نهائي بعد خمس. LEDGER_ACCOUNT_NOT_FOUND/ARCHIVED ⇒ HELD(MISSING_MAPPING).
 *   5. BLOCKED يُعاد جدولته 1m ثم 5m ثم 30m ثم 2h، وإعادة فحصه لا تُحتسب في ميزانية الأحداث.
 *
 * **لا يستورد prisma**: كل وصول للقاعدة عبر PostingStore (التنفيذ sync/postingStore.prisma.ts، والاختبارات بمخزن مزيّف).
 * الالتزامات: (3) priorSuspenseMilli من custodyComponents عبر settlementInputsFrom؛ (4) postMove يُنشئ GlMoveSource فلا يكرره
 * المُرحِّل؛ (5) ضرائب AUTO_SALE_<pct> تُنشأ قبل postMove؛ (8) settlementInputsFrom كما في custody.ts.
 */
import { SYSTEM_ACTOR, type GlActor } from '../audit';
import { custodyComponents, custodyComponentsForRep, settlementInputsFrom, type CustodyComponentsInput, type SettlementSplit } from '../custody';
import { localDate, maxLocalDate } from '../dates';
import { buildInvoiceMove, type InvoicePayload } from '../builders/invoice';
import { buildReceiptMove, buildReceiptReversalMove, type ReceiptPostPayload } from '../builders/receipt';
import { buildSettlementMove } from '../builders/custody';
import { buildImportEntryMove, type ImportEntryPayload } from '../builders/importEntry';
import { buildPaylinkFeeMove, buildPayoutMove, type PaylinkFeePayload, type PayoutPayload } from '../builders/paylink';
import type { LedgerContext } from '../resolve';
import {
  LedgerError, isNoMove,
  type BuildResult, type EventHoldReason, type LocalDate, type Milli, type MoveDraft, type SkipReason,
} from '../types';
import {
  blockedRetry, compareEventsForPosting, currencyMismatch, decodeEventNote, encodeEventNote, errorRetry, initialWatermarkAt,
  inventoryGate, isInventoryEvent, isStillActionable, isTombstoneSource, planEvent, settlementOrderReady,
  type CutoverContext, type CutoverRow, type EventPlan, type LiveMoveState, type OriginFacts, type SiblingState, type SiblingWrite,
} from './classify';
import { reverseKeyOf, siblingPostKey } from './keys';
import { reconcileHorizon } from './reconciler';
import type { PosterSettings, PostingStore, PostingTx } from './postingStore';
import {
  SOURCE_KEY_UNIQUE_TARGET, TICK_DB_BUDGET_MS, TICK_EVENT_BUDGET, TICK_POST_CUTOFF_MS, isUniqueViolation, maxCompositeKey,
  type ArEntryEventPayload, type BlockReason, type CompositeKey, type DesiredEvent, type InvoiceReverseEventPayload,
  type PendingHoldReason, type PostOutcome, type PosterRunResult, type ReceiptPostEventPayload, type ReceiptReverseEventPayload,
  type SettlementEventPayload, type SourceEventPatch, type SourceEventRecord,
} from './types';

// ═══ الميزانية ═══

/**
 * ميزانية مشتركة بين الشركات في النبضة (§5.1): زمن ≤ 3 ثوانٍ و≤ 300 حدث. المجدول ينشئ واحدة للنبضة كلها ويمرّرها
 * لكل شركة بالتناوب؛ «مزامنة الآن» تنشئ واحدة بـ2 ثانية للشركة وحدها.
 */
export interface SyncBudget {
  /** ساعة التطبيق بالمللي ثانية (قابلة للحقن في الاختبارات) */
  clock(): number;
  /** بداية النبضة (لقاطع TICK_POST_CUTOFF_MS) */
  readonly tickStartedAt: number;
  /** نهاية ميزانية الزمن (مطلقة) */
  readonly deadline: number;
  /** الأحداث المتبقية — تُنقص بكل حدث عولج فعلاً (لا تُنقص بإعادة فحص BLOCKED ولا بإبقاء مخزون PENDING) */
  eventsRemaining: number;
}

export function createSyncBudget(opts: { clock?: () => number; timeMs?: number; events?: number } = {}): SyncBudget {
  const clock = opts.clock ?? Date.now;
  const start = clock();
  return { clock, tickStartedAt: start, deadline: start + (opts.timeMs ?? TICK_DB_BUDGET_MS), eventsRemaining: opts.events ?? TICK_EVENT_BUDGET };
}

export function budgetExhausted(b: SyncBudget): PosterRunResult['stoppedBy'] | null {
  const now = b.clock();
  if (now - b.tickStartedAt > TICK_POST_CUTOFF_MS) return 'TICK_CUTOFF';
  if (now >= b.deadline) return 'TIME_BUDGET';
  if (b.eventsRemaining <= 0) return 'EVENT_BUDGET';
  return null;
}

// ═══ الخيارات ═══

export interface PosterOptions {
  actor?: GlActor;
  /** حجم دفعة القراءة من الطابور (الافتراضي 50) */
  batchSize?: number;
  /** سجل منظّم للأخطاء (الافتراضي console.error) */
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

/** أسباب العكس الآلي (G5: السبب إلزامي) */
export const AUTO_REVERSAL_REASONS: Readonly<Record<string, string>> = {
  INVOICE: 'إلغاء الفاتورة في النظام التشغيلي',
  RECEIPT: 'إلغاء سند القبض أو استرداد الدفع الإلكتروني',
  SETTLEMENT: 'حذف استلام تحصيل المندوب',
  AR_ENTRY: 'التراجع عن الاستيراد',
  CUSTOMER_ADJUSTMENT: 'إلغاء تسوية ذمة العميل',
};

/** رموز LedgerError التي تعني ربطاً أو حساباً ناقصاً ⇒ HELD(MISSING_MAPPING) لا ERROR */
export const MISSING_MAPPING_CODES = ['LEDGER_ACCOUNT_NOT_FOUND', 'LEDGER_ACCOUNT_ARCHIVED'] as const;

/** بيانات المصدر غائبة (لا حمولة ولا صف) ⇒ HELD(SOURCE_NOT_FOUND) */
export class PosterHoldError extends Error {
  constructor(readonly reason: EventHoldReason, readonly detail: string | null = null) {
    super(`${reason}${detail ? `: ${detail}` : ''}`);
    this.name = 'PosterHoldError';
  }
}

// ═══ سياق البدء ═══

const EPOCH = new Date(0);

/** سياق التصنيف من الإعدادات: الطريقة (ب) أو غياب تاريخ البدء ⇒ لا شيء مشمول بالافتتاح */
export function cutoverContextOf(s: Pick<PosterSettings, 'setupMethod' | 'cutoverDate' | 'openingSnapshotAt' | 'timezone'>): CutoverContext {
  if (!s.cutoverDate || !s.openingSnapshotAt) {
    return { cutoverDate: '1970-01-01', openingSnapshotAt: EPOCH, timezone: s.timezone, initialWatermarkAt: EPOCH };
  }
  const method = s.setupMethod === 'FULL_HISTORY' ? 'FULL_HISTORY' : 'OPENING';
  return {
    cutoverDate: s.cutoverDate,
    openingSnapshotAt: s.openingSnapshotAt,
    timezone: s.timezone,
    initialWatermarkAt: initialWatermarkAt({ method, cutoverDate: s.cutoverDate, openingSnapshotAt: s.openingSnapshotAt, timezone: s.timezone }),
  };
}

/**
 * المؤشر الفعّال لترتيب P7 (توضيح §5.5): مؤشر ACCOUNT_ENTRY كما هو، إلا حين لا صفوف غير مقروءة حتى الأفق
 * (dbNow − LATE_COMMIT_WINDOW) فيصير max(المؤشر، الأفق). المؤشر نفسه لا يتحرك (ثابت §5.2): المُطابِق لا يقدّمه إلا
 * بمفتاح آخر صف قرأه، فاستلام هو آخر عملية في اليوم كان يبقى BLOCKED(SETTLEMENT_ORDER) حتى يُنشأ صف جديد.
 * «لا صفوف غير مقروءة حتى الأفق» ⇔ كل صف AccountEntry أُنشئ حتى الأفق قُرئ وأُدرجت أحداثه.
 */
export async function effectiveAccountEntryWatermark(store: PostingStore, tenantId: string, dbNow: Date): Promise<CompositeKey | null> {
  const cursor = await store.readCursor(tenantId, 'ACCOUNT_ENTRY');
  if (!cursor) return null;
  const base: CompositeKey = { at: cursor.watermarkAt, id: cursor.watermarkId };
  if (!store.hasUnreadRows) return base;
  const horizon = reconcileHorizon(dbNow);
  if (horizon.getTime() <= base.at.getTime()) return base;
  if (await store.hasUnreadRows(tenantId, 'ACCOUNT_ENTRY', base, horizon)) return base;
  return maxCompositeKey(base, { at: horizon, id: '' });
}

// ═══ الحلقة ═══

interface RunEnv {
  store: PostingStore;
  settings: PosterSettings;
  cutover: CutoverContext;
  actor: GlActor;
  now: Date;
  accountEntryWatermark: CompositeKey | null;
  inventory: { loaded: boolean; horizon: Date | null; head: { effectAt: Date; sourceKey: string } | null };
  /** سياق البناء مخزَّن للنبضة (يُعاد تحميله بعد إنشاء ضرائب AUTO_SALE) — تواريخ الإقفال يعيد postMove قراءتها دائماً */
  context: LedgerContext | null;
  /** بصمة إعدادات البناء التي حُمِّل بها السياق — تغيّرها تحت القفل يُعيد التحميل (D2 والمسارات) */
  contextVersion?: number | null;
  log: (msg: string, data?: Record<string, unknown>) => void;
}

export function emptyPosterResult(stoppedBy: PosterRunResult['stoppedBy'] = 'EMPTY'): PosterRunResult {
  return { attempted: 0, done: 0, skipped: 0, blocked: 0, held: 0, errors: 0, keptPending: 0, blockedRechecks: 0, stoppedBy };
}

/**
 * يرحّل أحداث شركة واحدة ضمن الميزانية المشتركة. المُستدعي (tick.ts) يملك عقد الإيجار؛ الصحة هنا لا تعتمد عليه
 * (قفل gl-post داخل كل معاملة + @@unique([tenantId, sourceKey])).
 */
export async function runPoster(
  store: PostingStore, settings: PosterSettings, budget: SyncBudget, opts: PosterOptions = {},
): Promise<PosterRunResult> {
  const result = emptyPosterResult();
  if (!settings.activatedAt) return result;
  const now = await store.dbNow();
  const env: RunEnv = {
    store, settings,
    cutover: cutoverContextOf(settings),
    actor: opts.actor ?? SYSTEM_ACTOR,
    now,
    accountEntryWatermark: await effectiveAccountEntryWatermark(store, settings.tenantId, now),
    inventory: { loaded: false, horizon: null, head: null },
    context: null,
    log: opts.log ?? ((msg, data) => console.error(`📒 ledger poster: ${msg}`, data ?? '')),
  };
  const batchSize = Math.max(1, opts.batchSize ?? 50);
  const seen = new Set<string>();

  for (;;) {
    const stop = budgetExhausted(budget);
    if (stop) { result.stoppedBy = stop; return result; }
    const batch = await store.listDueEvents(settings.tenantId, {
      now: env.now, limit: Math.min(batchSize, Math.max(1, budget.eventsRemaining)), excludeIds: [...seen],
    });
    const fresh = batch.filter((e) => !seen.has(e.id)).sort(compareEventsForPosting);
    if (fresh.length === 0) { result.stoppedBy = 'EMPTY'; return result; }
    for (const ev of fresh) {
      const s = budgetExhausted(budget);
      if (s) { result.stoppedBy = s; return result; }
      seen.add(ev.id);
      const wasBlocked = ev.status === 'BLOCKED';
      const outcome = await processEvent(env, ev);
      tally(result, outcome, wasBlocked, budget);
    }
  }
}

function tally(r: PosterRunResult, o: PostOutcome, wasBlocked: boolean, budget: SyncBudget): void {
  if (o.status === 'PENDING') { r.keptPending++; return; }
  if (o.status === 'BLOCKED' && wasBlocked) { r.blockedRechecks++; r.blocked++; return; }
  r.attempted++;
  budget.eventsRemaining--;
  switch (o.status) {
    case 'DONE': r.done++; break;
    case 'SKIPPED': r.skipped++; break;
    case 'BLOCKED': r.blocked++; break;
    case 'HELD': r.held++; break;
    case 'ERROR': r.errors++; break;
  }
}

// ═══ حدث واحد ═══

/** قرار داخلي: النتيجة وما يُكتب على الحدث (داخل المعاملة أو بعدها) */
interface Decision {
  outcome: PostOutcome;
  patch: SourceEventPatch;
}

/** نسخة قابلة للاختبار: تعالج حدثاً واحداً وتعيد النتيجة (مع كل الكتابة) */
export async function postSourceEvent(
  store: PostingStore, settings: PosterSettings, ev: SourceEventRecord, opts: PosterOptions = {},
): Promise<PostOutcome> {
  const now = await store.dbNow();
  const env: RunEnv = {
    store, settings, cutover: cutoverContextOf(settings), actor: opts.actor ?? SYSTEM_ACTOR, now,
    accountEntryWatermark: await effectiveAccountEntryWatermark(store, settings.tenantId, now),
    inventory: { loaded: false, horizon: null, head: null }, context: null,
    log: opts.log ?? ((msg, data) => console.error(`📒 ledger poster: ${msg}`, data ?? '')),
  };
  return processEvent(env, ev);
}

async function processEvent(env: RunEnv, ev: SourceEventRecord): Promise<PostOutcome> {
  const { store, settings } = env;
  const tenantId = settings.tenantId;

  // (1) أفق المخزون — بلا attempts++ ولا BLOCKED
  if (isInventoryEvent(ev)) {
    if (!env.inventory.loaded) {
      const [horizon, head] = await Promise.all([store.inventoryHorizon(tenantId), store.inventoryBlockedHead(tenantId)]);
      env.inventory = { loaded: true, horizon, head };
    }
    const hold = inventoryGate(ev, env.inventory.horizon, env.inventory.head);
    if (hold) return keepPending(env, ev, hold);
  }

  // (2) العملة
  if (currencyMismatch(ev.sourceType, settings.currency, settings.companyCurrency)) {
    return hold(env, ev, 'CURRENCY_MISMATCH', `${settings.currency}≠${settings.companyCurrency}`);
  }

  // (3) المعاملة
  try {
    const decision = await store.withPostLock(tenantId, (tx) => decideAndPost(env, tx, ev));
    return decision.outcome;
  } catch (e) {
    return onFailure(env, ev, e);
  }
}

async function keepPending(env: RunEnv, ev: SourceEventRecord, reason: PendingHoldReason): Promise<PostOutcome> {
  const note = encodeEventNote({ kind: 'PENDING', reason });
  if (ev.lastError !== note) {
    await env.store.recordFailure(env.settings.tenantId, ev.id, { lastError: note }).catch(() => undefined);
  }
  return { status: 'PENDING', reason };
}

async function hold(env: RunEnv, ev: SourceEventRecord, reason: EventHoldReason, detail: string | null): Promise<PostOutcome> {
  await env.store.recordFailure(env.settings.tenantId, ev.id, {
    status: 'HELD', lastError: encodeEventNote({ kind: 'HELD', reason, detail }), nextAttemptAt: null,
  });
  return { status: 'HELD', reason, detail };
}

async function onFailure(env: RunEnv, ev: SourceEventRecord, e: unknown): Promise<PostOutcome> {
  const { store, settings } = env;
  // P2002 على [tenantId, sourceKey]: نبضة أخرى رحّلت المفتاح ⇒ DONE بنفس moveId
  if (isUniqueViolation(e, SOURCE_KEY_UNIQUE_TARGET)) {
    try {
      const done = await store.withPostLock(settings.tenantId, async (tx) => {
        const moveId = await tx.findMoveIdBySourceKey(ev.sourceKey);
        if (!moveId) return null;
        await tx.updateEvent(ev.id, donePatch(env.now, moveId));
        return moveId;
      });
      if (done) return { status: 'DONE', moveId: done, idempotent: true };
    } catch (inner) {
      e = inner;
    }
  }
  if (e instanceof PosterHoldError) return hold(env, ev, e.reason, e.detail);
  if (e instanceof LedgerError && (MISSING_MAPPING_CODES as readonly string[]).includes(e.code)) {
    return hold(env, ev, 'MISSING_MAPPING', `${e.code}${e.details?.accountCode ? ` ${String(e.details.accountCode)}` : ''}`);
  }
  const message = errorMessage(e);
  if (isTransientDbError(e)) {
    // مهلة المجمّع/المعاملة أو انقطاع الاتصال: ليس فشل الحدث ⇒ لا attempts++ ولا سلّم تراجع، إعادة بعد دقيقة
    const nextAttemptAt = new Date(env.now.getTime() + TRANSIENT_RETRY_MS);
    env.log('event deferred (transient db error)', { tenantId: settings.tenantId, sourceKey: ev.sourceKey, error: message });
    // BLOCKED يحتفظ بملاحظته (خطوة التراجع)؛ غيره يحمل رسالة الخطأ للتشخيص
    const patch: SourceEventPatch = ev.status === 'BLOCKED' ? { status: ev.status, nextAttemptAt } : { status: ev.status, nextAttemptAt, lastError: message };
    await store.recordFailure(settings.tenantId, ev.id, patch).catch(() => undefined);
    return { status: 'PENDING', reason: 'TRANSIENT_DB_ERROR', error: message };
  }
  const retry = errorRetry(ev.attempts, env.now);
  env.log('event failed', { tenantId: settings.tenantId, sourceKey: ev.sourceKey, attempts: retry.attempts, error: message });
  await store.recordFailure(settings.tenantId, ev.id, {
    status: 'ERROR', attempts: retry.attempts, nextAttemptAt: retry.nextAttemptAt, lastError: message,
  });
  return { status: 'ERROR', error: message, attempts: retry.attempts, nextAttemptAt: retry.nextAttemptAt };
}

/** رموز Prisma لأخطاء عابرة في الاتصال لا في الحدث: مهلة المجمّع، مهلة بدء المعاملة، تعذّر الوصول، إغلاق الاتصال */
export const TRANSIENT_DB_ERROR_CODES = ['P2024', 'P2028', 'P1001', 'P1017'] as const;
/** مهلة إعادة الحدث بعد خطأ عابر (لا تُحتسب محاولة) */
export const TRANSIENT_RETRY_MS = 60_000;

export function isTransientDbError(e: unknown): boolean {
  const code = e && typeof e === 'object' && 'code' in e ? (e as { code?: unknown }).code : undefined;
  return typeof code === 'string' && (TRANSIENT_DB_ERROR_CODES as readonly string[]).includes(code);
}

export function errorMessage(e: unknown): string {
  if (e instanceof LedgerError) return `${e.code}${e.details && Object.keys(e.details).length ? ` ${safeJson(e.details)}` : ''}`.slice(0, 1000);
  if (e && typeof e === 'object' && 'code' in e && (e as { code?: unknown }).code === 'P2002') {
    return `P2002 ${safeJson((e as { meta?: unknown }).meta ?? {})}`.slice(0, 1000);
  }
  return (e instanceof Error ? e.message : String(e)).slice(0, 1000);
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)); } catch { return '[unserializable]'; }
}

function donePatch(now: Date, moveId: string, extra: Partial<SourceEventPatch> = {}): SourceEventPatch {
  return { status: 'DONE', moveId, processedAt: now, lastError: null, nextAttemptAt: null, skipReason: null, ...extra };
}

function skippedPatch(now: Date, skipReason: SkipReason, extra: Partial<SourceEventPatch> = {}): SourceEventPatch {
  return { status: 'SKIPPED', skipReason, processedAt: now, lastError: null, nextAttemptAt: null, ...extra };
}

// ═══ داخل المعاملة ═══

async function decideAndPost(env: RunEnv, tx: PostingTx, stale: SourceEventRecord): Promise<Decision> {
  const ev = await tx.getEvent(stale.sourceKey);
  if (!ev) return { outcome: { status: 'SKIPPED', skipReason: 'MANUAL' }, patch: {} }; // حُذف (إعادة ضبط) — لا كتابة
  if (!isStillActionable(ev.status)) return settledOutcome(ev);

  if (!hasRecipe(ev)) throw new PosterHoldError('UNEXPECTED_ENTRY_SHAPE', `NO_RECIPE ${ev.sourceType}:${ev.event}`);

  const self = await selfRow(tx, ev);
  let plan = await planFor(env, tx, ev, self);
  if (plan.action === 'INSERT_SIBLING_AND_RECHECK') {
    await applySiblingWrite(env, tx, ev, plan.siblingWrite);
    plan = await planFor(env, tx, ev, self);
    if (plan.action === 'INSERT_SIBLING_AND_RECHECK') {
      // الإدراج لم يُغيّر شيئاً (لا ينبغي): احجب مؤقتاً بدل حلقة
      plan = { action: 'BLOCK', reason: 'AWAITING_RECONCILER', siblingWrite: null };
    }
  }

  switch (plan.action) {
    case 'SKIP': {
      await applySiblingWrite(env, tx, ev, plan.siblingWrite);
      const patch = skippedPatch(env.now, plan.skipReason);
      await tx.updateEvent(ev.id, patch);
      return { outcome: { status: 'SKIPPED', skipReason: plan.skipReason }, patch };
    }
    case 'BLOCK': {
      await applySiblingWrite(env, tx, ev, plan.siblingWrite);
      return block(env, tx, ev, plan.reason);
    }
    case 'DONE_EXISTING': {
      const patch = donePatch(env.now, plan.moveId);
      await tx.updateEvent(ev.id, patch);
      return { outcome: { status: 'DONE', moveId: plan.moveId, idempotent: true }, patch };
    }
    case 'ERROR':
      throw new Error(plan.error);
    case 'POST':
      return executePost(env, tx, ev, plan);
  }
}

/** حالة نهائية كتبها غيرنا (tombstone أو نبضة أخرى) */
function settledOutcome(ev: SourceEventRecord): Decision {
  if (ev.status === 'DONE' && ev.moveId) return { outcome: { status: 'DONE', moveId: ev.moveId, idempotent: true }, patch: {} };
  if (ev.status === 'SKIPPED') return { outcome: { status: 'SKIPPED', skipReason: ev.skipReason ?? 'MANUAL' }, patch: {} };
  const note = decodeEventNote(ev.lastError);
  return { outcome: { status: 'HELD', reason: note?.kind === 'HELD' ? note.reason : 'UNEXPECTED_ENTRY_SHAPE', detail: ev.lastError }, patch: {} };
}

function hasRecipe(ev: SourceEventRecord): boolean {
  switch (ev.sourceType) {
    case 'INVOICE': return ev.event === 'POST' || ev.event === 'REVERSE';
    case 'RECEIPT':
    case 'SETTLEMENT':
    case 'AR_ENTRY': return ev.event === 'POST' || ev.event === 'REVERSE';
    case 'PAYLINK_FEE':
    case 'PAYOUT': return ev.event === 'POST';
    default: return false; // WH_ENTRY/VAN_LOAD/RESTOCK/COGS (M9) وCUSTOMER_ADJUSTMENT (M4 يكتبه DONE)
  }
}

async function block(env: RunEnv, tx: PostingTx, ev: SourceEventRecord, reason: BlockReason): Promise<Decision> {
  const prev = ev.status === 'BLOCKED' ? decodeEventNote(ev.lastError) : null;
  const prevStep = prev?.kind === 'BLOCKED' ? prev.step : null;
  const r = blockedRetry(prevStep, env.now);
  const patch: SourceEventPatch = {
    status: 'BLOCKED', nextAttemptAt: r.nextAttemptAt, lastError: encodeEventNote({ kind: 'BLOCKED', reason, step: r.step }),
  };
  await tx.updateEvent(ev.id, patch);
  return { outcome: { status: 'BLOCKED', reason, step: r.step, nextAttemptAt: r.nextAttemptAt }, patch };
}

// ── الأثر الذاتي للتصنيف ──

type AnyPayload = Record<string, unknown>;

function payloadOf(ev: Pick<SourceEventRecord, 'payload'>): AnyPayload | null {
  return ev.payload && typeof ev.payload === 'object' ? (ev.payload as AnyPayload) : null;
}

const isLocalDateText = (v: unknown): v is LocalDate => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

async function selfRow(tx: PostingTx, ev: SourceEventRecord): Promise<CutoverRow> {
  const p = payloadOf(ev);
  let effectDate: LocalDate | null = null;
  if (p && (ev.sourceType === 'INVOICE' || ev.sourceType === 'RECEIPT') && isLocalDateText(p.entryDate)) effectDate = p.entryDate;
  let createdAt: Date | string | null = null;
  if (ev.event === 'REVERSE' && isTombstoneSource(ev.sourceType)) {
    // حمولة الـtombstone واحدة في المفتاحين وتحمل createdAt الصف الأصلي؛ أثر العكس لحظة الحذف (effectAt) وكشفه
    return { effectAt: ev.effectAt, effectDate: null, createdAt: ev.detectedAt.getTime() > ev.effectAt.getTime() ? ev.detectedAt : ev.effectAt };
  }
  if (p) {
    const c = p.sourceCreatedAt ?? p.createdAt;
    if (typeof c === 'string' || c instanceof Date) createdAt = c;
  }
  if (createdAt === null) {
    const data = await tx.loadSourceData(ev.sourceType, ev.sourceId, ev.event);
    createdAt = data.kind === 'FOUND' ? data.createdAt : ev.detectedAt;
  }
  return { effectAt: ev.effectAt, effectDate, createdAt };
}

async function planFor(env: RunEnv, tx: PostingTx, ev: SourceEventRecord, self: CutoverRow): Promise<EventPlan> {
  if (ev.event === 'POST') {
    let sibling: SiblingState | null = null;
    if (isTombstoneSource(ev.sourceType)) {
      const revKey = reverseKeyOf(ev.sourceType, ev.sourceId);
      sibling = revKey ? await tx.getSibling(revKey) : null;
    }
    return planEvent({ sourceType: ev.sourceType, event: 'POST', self, sibling, cutover: env.cutover });
  }
  const postKey = siblingPostKey(ev.sourceKey);
  const sibling = postKey ? await tx.getSibling(postKey) : null;
  let live: LiveMoveState | null = null;
  let origin: OriginFacts | null = null;
  if (sibling?.status === 'DONE' && ev.event === 'REVERSE' && postKey) live = await tx.findLiveMove(postKey);
  if (!sibling || (sibling.status !== 'DONE' && sibling.status !== 'SKIPPED')) origin = await tx.resolveOrigin(ev);
  if (ev.event === 'REVERSE' && (ev.sourceType === 'INVOICE' || ev.sourceType === 'RECEIPT')) {
    self = await reversalFollowsOrigin(env, tx, self, postKey, origin);
  }
  return planEvent({ sourceType: ev.sourceType, event: ev.event, self, sibling, live, origin, cutover: env.cutover });
}

/**
 * الإلغاء يتبع أصله (§5.6، §5.4): أثر العكس = max(أثر صف الإلغاء، أثر POST). إلغاء مستند مؤرخ مستقبلاً قبل البدء
 * صفُّه بتاريخ قبل البدء، فلولا ذلك لصُنِّف «مشمولاً بالافتتاح» (وأسقطه الافتتاح لغياب أثر مستنده) بينما يُرحَّل POST.
 */
async function reversalFollowsOrigin(env: RunEnv, tx: PostingTx, self: CutoverRow, postKey: string | null, origin: OriginFacts | null): Promise<CutoverRow> {
  const postEv = postKey ? await tx.getEvent(postKey) : null;
  let originAt: Date | null = null;
  let originDate: LocalDate | null = null;
  if (postEv) {
    originAt = postEv.effectAt;
    const pp = payloadOf(postEv);
    if (pp && isLocalDateText(pp.entryDate)) originDate = pp.entryDate;
  } else if (origin) {
    originAt = new Date(origin.originEffectAt instanceof Date ? origin.originEffectAt.getTime() : origin.originEffectAt);
    originDate = origin.originEffectDate ?? null;
  }
  if (!originAt || Number.isNaN(originAt.getTime())) return self;
  const selfAt = new Date(self.effectAt instanceof Date ? self.effectAt.getTime() : self.effectAt).getTime();
  if (originAt.getTime() <= selfAt) return self;
  return { ...self, effectAt: originAt, effectDate: originDate ?? localDate(originAt, env.settings.timezone) };
}

async function applySiblingWrite(env: RunEnv, tx: PostingTx, ev: SourceEventRecord, w: SiblingWrite | null): Promise<void> {
  if (!w) return;
  const key = ev.event === 'POST' ? reverseKeyOf(ev.sourceType, ev.sourceId) : siblingPostKey(ev.sourceKey);
  if (!key) return;
  if (w.op === 'UPDATE') {
    await tx.updateEventByKey(key, skippedPatch(env.now, w.skipReason), ['PENDING', 'BLOCKED', 'ERROR', 'HELD']);
    return;
  }
  const origin = await tx.resolveOrigin(ev);
  const effectAt = origin ? new Date(origin.originEffectAt instanceof Date ? origin.originEffectAt.getTime() : origin.originEffectAt) : ev.effectAt;
  const sibling: DesiredEvent = {
    sourceKey: key,
    sourceType: ev.sourceType,
    sourceId: ev.sourceId,
    event: 'POST',
    effectAt: Number.isNaN(effectAt.getTime()) ? ev.effectAt : effectAt,
    // tombstone يحمل الحمولة نفسها في المفتاحين؛ الفاتورة/السند تُقرأ من المستند عند الحاجة
    payload: isTombstoneSource(ev.sourceType) ? ev.payload : null,
    status: w.status,
    skipReason: w.status === 'SKIPPED' ? w.skipReason : null,
  };
  await tx.insertEvents([sibling]);
  if (w.status === 'SKIPPED') {
    // processedAt لما أُدرج SKIPPED (skipDuplicates قد لا يُدرج: الشقيق القائم لا يُمس)
    await tx.updateEventByKey(key, { processedAt: env.now }, ['SKIPPED']);
  }
}

// ── الترحيل ──

/**
 * السياق المخزَّن للنبضة يُعاد تحميله داخل المعاملة الحالية (بعد قفل gl-post) إن تغيّرت GlSettings منذ تحميله:
 * حفظ paylinkFeeTaxInvoiceFrom (D2) أو cashInvoiceRouting/receiptRouting يأخذ القفل نفسه، فالقيمة المقروءة هنا هي
 * السارية لحظة الترحيل (§8.1) لا ما قُرئ في أول النبضة.
 */
export async function contextOf(env: Pick<RunEnv, 'context' | 'contextVersion'>, tx: PostingTx): Promise<LedgerContext> {
  const version = tx.settingsVersion ? await tx.settingsVersion() : null;
  if (!env.context || (version !== null && version !== (env.contextVersion ?? null))) {
    env.context = await tx.loadContext();
    env.contextVersion = version;
  }
  return env.context;
}

function withPlanDate(draft: MoveDraft, plan: Extract<EventPlan, { action: 'POST' }>): MoveDraft {
  return {
    ...draft,
    date: plan.date,
    lateArrival: plan.lateArrival || draft.lateArrival === true,
    originalDate: plan.lateArrival ? (plan.originalDate ?? draft.originalDate ?? null) : (draft.originalDate ?? null),
  };
}

async function sourcePayload<T>(tx: PostingTx, ev: Pick<SourceEventRecord, 'sourceType' | 'sourceId'>, event: 'POST' | 'REVERSE', own?: SourceEventRecord['payload']): Promise<T> {
  if (own && typeof own === 'object') return own as unknown as T;
  const data = await tx.loadSourceData(ev.sourceType, ev.sourceId, event);
  if (data.kind === 'MISSING' || !data.payload) throw new PosterHoldError('SOURCE_NOT_FOUND', `${ev.sourceType}:${ev.sourceId}:${event}`);
  return data.payload as T;
}

/** حمولة POST للمصدر: حدث POST المخزّن أولاً، ثم المستند */
async function postPayloadOf<T>(tx: PostingTx, ev: SourceEventRecord): Promise<T> {
  const postKey = siblingPostKey(ev.sourceKey);
  const postEv = postKey ? await tx.getEvent(postKey) : null;
  if (isTombstoneSource(ev.sourceType)) return sourcePayload<T>(tx, ev, 'POST', postEv?.payload ?? ev.payload);
  return sourcePayload<T>(tx, ev, 'POST', postEv?.payload ?? null);
}

async function executePost(env: RunEnv, tx: PostingTx, ev: SourceEventRecord, plan: Extract<EventPlan, { action: 'POST' }>): Promise<Decision> {
  // ترتيب P7 (§5.5) قبل أي بناء
  if (ev.sourceType === 'SETTLEMENT' && ev.event === 'POST') {
    const p = await sourcePayload<SettlementEventPayload>(tx, ev, 'POST', ev.payload);
    const ready = settlementOrderReady({
      settlementCreatedAt: p.createdAt ?? ev.detectedAt,
      settledAt: p.settledAt,
      accountEntryWatermark: env.accountEntryWatermark,
      repReceiptEvents: await tx.listRepReceiptEvents(p.salesRepId, ev.effectAt),
    });
    if (!ready) {
      await applySiblingWrite(env, tx, ev, plan.siblingWrite);
      return block(env, tx, ev, 'SETTLEMENT_ORDER');
    }
  }

  await applySiblingWrite(env, tx, ev, plan.siblingWrite);

  if (plan.mode === 'REVERSE_LIVE') return reverseLive(env, tx, ev, plan);

  const context = await contextOf(env, tx);
  const built = await buildFor(env, tx, ev, plan, context);
  if (isNoMove(built.result)) {
    const patch = skippedPatch(env.now, built.result.reason, built.extra);
    await tx.updateEvent(ev.id, patch);
    return { outcome: { status: 'SKIPPED', skipReason: built.result.reason }, patch };
  }
  const draft = withPlanDate(built.result, plan);
  const posted = await tx.postMove(draft, {
    actor: env.actor,
    context: env.context ?? context,
    validationMode: 'SYSTEM',
    lockPolicy: 'SHIFT',
    ...(built.reversedMoveId ? { reversedMoveId: built.reversedMoveId, reversalReason: AUTO_REVERSAL_REASONS[ev.sourceType] } : {}),
    auditSummary: `ترحيل آلي ${ev.sourceKey}`,
    auditExtra: { sourceKey: ev.sourceKey, eventId: ev.id, mode: plan.mode },
  });
  const patch = donePatch(env.now, posted.id, built.extra);
  await tx.updateEvent(ev.id, patch);
  return {
    outcome: {
      status: 'DONE', moveId: posted.id, idempotent: false,
      nonCustodyClearedMilli: built.extra.nonCustodyClearedMilli ?? null,
      shortageRecoveredMilli: built.extra.shortageRecoveredMilli ?? null,
    },
    patch,
  };
}

/** عكس القيد الحيّ (P4، P8، P12، وP6 لغير الإلكتروني) — ولسند ONLINE: P6 بالـbuilder مقابل القيد الحيّ */
async function reverseLive(env: RunEnv, tx: PostingTx, ev: SourceEventRecord, plan: Extract<EventPlan, { action: 'POST' }>): Promise<Decision> {
  const liveMoveId = plan.liveMoveId as string;
  if (ev.sourceType === 'RECEIPT') {
    const original = await postPayloadOf<ReceiptPostEventPayload>(tx, ev);
    if (original.paymentMethod === 'ONLINE' && original.paylinkId) {
      const context = await contextOf(env, tx);
      const rev = payloadOf(ev) as ReceiptReverseEventPayload | null;
      const result = buildReceiptReversalMove({
        receiptId: ev.sourceId, number: original.number ?? null, date: plan.date,
        original, reverse: rev, customerName: original.customerName ?? null, salesRepName: original.salesRepName ?? null,
      }, context.ctx);
      if (isNoMove(result)) {
        const patch = skippedPatch(env.now, result.reason);
        await tx.updateEvent(ev.id, patch);
        return { outcome: { status: 'SKIPPED', skipReason: result.reason }, patch };
      }
      const posted = await tx.postMove(withPlanDate(result, plan), {
        actor: env.actor, context, validationMode: 'SYSTEM', lockPolicy: 'SHIFT',
        reversedMoveId: liveMoveId, reversalReason: AUTO_REVERSAL_REASONS.RECEIPT,
        auditAction: 'MOVE_REVERSE', auditSummary: `عكس آلي ${ev.sourceKey}`,
        auditExtra: { sourceKey: ev.sourceKey, eventId: ev.id, mode: plan.mode },
      });
      const patch = donePatch(env.now, posted.id, {});
      await tx.updateEvent(ev.id, patch);
      return { outcome: { status: 'DONE', moveId: posted.id, idempotent: false }, patch };
    }
  }
  const r = await tx.reverseMove({
    moveId: liveMoveId,
    actor: env.actor,
    reason: AUTO_REVERSAL_REASONS[ev.sourceType] ?? 'إلغاء المستند المصدر',
    mode: 'SYSTEM',
    requestedDate: plan.date,
    sourceKey: ev.sourceKey,
    sourceEvent: ev.event,
    auditAction: 'MOVE_REVERSE',
  });
  const patch = donePatch(env.now, r.reversal.id, {});
  await tx.updateEvent(ev.id, patch);
  return { outcome: { status: 'DONE', moveId: r.reversal.id, idempotent: r.alreadyReversed }, patch };
}

interface Built {
  result: BuildResult;
  extra: Partial<SourceEventPatch>;
  reversedMoveId?: string | null;
}

async function buildFor(
  env: RunEnv, tx: PostingTx, ev: SourceEventRecord, plan: Extract<EventPlan, { action: 'POST' }>, context: LedgerContext,
): Promise<Built> {
  const reverse = ev.event === 'REVERSE';
  switch (ev.sourceType) {
    case 'INVOICE': {
      const payload = reverse ? await postPayloadOf<InvoicePayload>(tx, ev) : await sourcePayload<InvoicePayload>(tx, ev, 'POST', ev.payload);
      const opts = reverse ? { event: 'REVERSE' as const, reverseDate: plan.date } : {};
      let result = buildInvoiceMove(payload, context.ctx, opts);
      const missing = missingAutoSalePercents(result, context);
      if (missing.length > 0) {
        const ensured = await tx.ensureAutoSaleTaxes(missing);
        if (ensured.context) {
          env.context = ensured.context;
          result = buildInvoiceMove(payload, ensured.context.ctx, opts);
        }
      }
      if (reverse) {
        // تحقّق دفاعي: حمولة REVERSE (إن وُجدت) لنوع الفاتورة نفسه
        const rp = payloadOf(ev) as Partial<InvoiceReverseEventPayload> | null;
        if (rp?.type && rp.type !== payload.type) throw new PosterHoldError('UNEXPECTED_ENTRY_SHAPE', `invoice type ${rp.type}≠${payload.type}`);
      }
      return { result, extra: {} };
    }
    case 'RECEIPT': {
      if (!reverse) {
        const p = await sourcePayload<ReceiptPostEventPayload>(tx, ev, 'POST', ev.payload);
        const result = buildReceiptMove({
          receiptId: ev.sourceId, number: p.number ?? null, date: plan.date, payload: receiptPayload(p),
          customerName: p.customerName ?? null, salesRepName: p.salesRepName ?? null,
        }, context.ctx);
        return { result, extra: {} };
      }
      const original = await postPayloadOf<ReceiptPostEventPayload>(tx, ev);
      const rev = (payloadOf(ev) as ReceiptReverseEventPayload | null) ?? (await optionalPayload<ReceiptReverseEventPayload>(tx, ev, 'REVERSE'));
      const result = buildReceiptReversalMove({
        receiptId: ev.sourceId, number: original.number ?? null, date: plan.date,
        original: receiptPayload(original), reverse: rev, originalLines: null,
        customerName: original.customerName ?? null, salesRepName: original.salesRepName ?? null,
      }, context.ctx);
      return { result, extra: {} };
    }
    case 'SETTLEMENT': {
      const p = reverse ? await postPayloadOf<SettlementEventPayload>(tx, ev) : await sourcePayload<SettlementEventPayload>(tx, ev, 'POST', ev.payload);
      const inputs = await tx.loadCustodyInputs(p.salesRepId);
      if (!reverse) {
        const scoped = custodyInputsBefore(inputs, ev.sourceId, p);
        const c = custodyComponentsForRep(scoped, p.salesRepId);
        const build = buildSettlementMove({
          settlementId: ev.sourceId, payload: p, salesRepName: p.salesRepName ?? null, date: plan.date,
          ...settlementInputsFrom(c),
        }, context.ctx);
        return {
          result: build.result,
          extra: { nonCustodyClearedMilli: build.split.nonCustodyClearedMilli, shortageRecoveredMilli: build.split.recoveredMilli },
        };
      }
      // عكس استلام مشمول بالافتتاح (الشقيق SKIPPED(OPENING)): تقسيمه المخزَّن (المجمَّد عند التفعيل) من تشغيل العهدة ثم يُقلب.
      // إن وُجد قيد POST حيّ يُؤخذ المعلّق من سطوره لا من إعادة الاشتقاق (§6.1، §5.5 P8)
      const all = custodyComponents({ ...inputs, settlements: inputs.settlements.map((s) => (s.id === ev.sourceId ? { ...s, reversedAt: null } : s)) });
      const outcome = all[p.salesRepId]?.settlements.find((s) => s.id === ev.sourceId);
      if (!outcome) throw new PosterHoldError('SOURCE_NOT_FOUND', `custody outcome ${ev.sourceId}`);
      const postKey = siblingPostKey(ev.sourceKey);
      const live = postKey ? await tx.findLiveMove(postKey) : null;
      const postedDebitMilli = live?.liveMoveId ? debitTotalMilli(await tx.loadMoveLines(live.liveMoveId)) : null;
      const forward = buildSettlementMove({
        settlementId: ev.sourceId, payload: p, salesRepName: p.salesRepName ?? null, date: plan.date,
        ...settlementRebuildInputs(outcome, postedDebitMilli),
      }, context.ctx);
      if (isNoMove(forward.result)) return { result: forward.result, extra: {} };
      return { result: invertDraft(forward.result, 'REVERSE', plan.date), extra: {} };
    }
    case 'AR_ENTRY': {
      const p = reverse ? await postPayloadOf<ArEntryEventPayload>(tx, ev) : await sourcePayload<ArEntryEventPayload>(tx, ev, 'POST', ev.payload);
      if (p.origin === 'CUSTOMER_ADJUSTMENT') throw new PosterHoldError('UNEXPECTED_ENTRY_SHAPE', 'CUSTOMER_ADJUSTMENT يكتبه مستنده DONE');
      const entry: ImportEntryPayload = {
        entryId: p.entryId ?? ev.sourceId, customerId: p.customerId, customerName: p.customerName ?? null,
        debit: p.debit, credit: p.credit, description: p.description ?? null, entryDate: p.entryDate, createdAt: p.createdAt ?? null,
      };
      // تاريخ القيد من الخطة؛ الـbuilder يشترط تاريخاً واحداً للصفوف ويقارن العكس بتاريخ الأصل
      const entryLocal = localDate(entry.entryDate, env.settings.timezone);
      const result = reverse
        ? buildImportEntryMove(entry, context.ctx, { event: 'REVERSE', date: maxLocalDate(plan.date, entryLocal) })
        : buildImportEntryMove(entry, context.ctx);
      return { result, extra: {} };
    }
    case 'PAYLINK_FEE': {
      const p = await sourcePayload<PaylinkFeePayload>(tx, ev, 'POST', ev.payload);
      return { result: buildPaylinkFeeMove({ ...p, entryId: p.entryId ?? ev.sourceId }, context.ctx), extra: {} };
    }
    case 'PAYOUT': {
      const p = await sourcePayload<PayoutPayload>(tx, ev, 'POST', ev.payload);
      return { result: buildPayoutMove({ ...p, payoutId: p.payoutId ?? ev.sourceId }, context.ctx), extra: {} };
    }
    default:
      throw new PosterHoldError('UNEXPECTED_ENTRY_SHAPE', `NO_RECIPE ${ev.sourceType}`);
  }
}

async function optionalPayload<T>(tx: PostingTx, ev: SourceEventRecord, event: 'POST' | 'REVERSE'): Promise<T | null> {
  const data = await tx.loadSourceData(ev.sourceType, ev.sourceId, event);
  return data.kind === 'FOUND' ? (data.payload as T) : null;
}

function receiptPayload(p: ReceiptPostEventPayload): ReceiptPostPayload {
  return { salesRepId: p.salesRepId ?? null, paymentMethod: p.paymentMethod, amount: p.amount, customerId: p.customerId, paylinkId: p.paylinkId ?? null };
}

/** P7: مدخلات العهدة قبل هذا الاستلام — بنود أثرها ≤ settledAt، واستلامات سابقة له بالترتيب (settledAt، createdAt) */
export function custodyInputsBefore(inputs: CustodyComponentsInput, settlementId: string, p: Pick<SettlementEventPayload, 'settledAt' | 'createdAt'>): CustodyComponentsInput {
  const at = new Date(p.settledAt).getTime();
  const created = p.createdAt ? new Date(p.createdAt).getTime() : at;
  const ms = (v: Date | string | number | null | undefined): number | null => (v == null ? null : new Date(v).getTime());
  const upTo = <T extends { effectAt: Date | string | number; reversedAt?: Date | string | number | null }>(list: readonly T[]): T[] =>
    list.filter((i) => (ms(i.effectAt) as number) <= at).map((i) => {
      const r = ms(i.reversedAt ?? null);
      return r !== null && r > at ? { ...i, reversedAt: null } : i;
    });
  const settlements = inputs.settlements.filter((s) => {
    if (s.id === settlementId) return false;
    const sAt = ms(s.effectAt) as number;
    const sCreated = ms(s.createdAt ?? null) ?? sAt;
    return sAt < at || (sAt === at && sCreated < created) || (sAt === at && sCreated === created && s.id < settlementId);
  }).map((s) => {
    const r = ms(s.reversedAt ?? null);
    return r !== null && r > at ? { ...s, reversedAt: null } : s;
  });
  return {
    ...inputs,
    receipts: upTo(inputs.receipts),
    onlineReceipts: upTo(inputs.onlineReceipts),
    outsideReceipts: upTo(inputs.outsideReceipts),
    cashInvoices: upTo(inputs.cashInvoices),
    shortages: upTo(inputs.shortages),
    custodyExpenses: upTo(inputs.custodyExpenses),
    settlements,
  };
}

/** Σ المدين لسطور قيد */
export function debitTotalMilli(lines: readonly { debitMilli: Milli }[]): Milli {
  return lines.reduce((a, l) => a + l.debitMilli, 0n);
}

/**
 * مدخلات buildSettlementMove تعيد تقسيماً معروفاً حرفياً (إعادة الترحيل من المصدر، وعكس استلام مبني من المصدر):
 * covered = amount − r − recovered وrecovered من القيم المخزّنة، والمعلّق من القيد المرحَّل نفسه:
 * Σ مدين القيد = covered + recovered + suspense ⇒ suspense = Σ المدين − (amount − r) — مستقل عن الربط الحالي لـ911001،
 * فلا يتغير بفاتورة نقدية أُدخلت لاحقاً بتاريخ سابق (عتبة P7 المعاد اشتقاقها). بلا قيد (postedDebitMilli = null)
 * يُستعمل المعلّق المعاد اشتقاقه كما كان.
 */
export function settlementRebuildInputs(
  outcome: Pick<SettlementSplit, 'coveredMilli' | 'recoveredMilli' | 'nonCustodyClearedMilli' | 'suspenseMilli'> & { amountMilli: Milli },
  postedDebitMilli: Milli | null,
): { custodyBalanceMilli: Milli; openShortageMilli: Milli; cumulativeNonCustodyClearedMilli: Milli; priorSuspenseMilli: Milli; nonCustodyAllowanceMilli: Milli } {
  const r = outcome.nonCustodyClearedMilli;
  const rec = outcome.recoveredMilli;
  const covered = outcome.amountMilli - r - rec;
  let suspense = outcome.suspenseMilli;
  if (postedDebitMilli !== null) {
    const s = postedDebitMilli - covered - rec;
    suspense = s < 0n ? 0n : s > r ? r : s;
  }
  return {
    custodyBalanceMilli: covered,
    openShortageMilli: rec,
    cumulativeNonCustodyClearedMilli: 0n,
    priorSuspenseMilli: r - suspense,
    nonCustodyAllowanceMilli: 0n,
  };
}

/** قلب قيد مبني (عكس من الحمولة): الجانبان سطراً بسطر والوعاء سالباً */
export function invertDraft(draft: MoveDraft, event: 'REVERSE', date: LocalDate): MoveDraft {
  const key = draft.sourceType && draft.sourceId ? reverseKeyOf(draft.sourceType, draft.sourceId) : null;
  return {
    ...draft,
    date,
    originalDate: null,
    lateArrival: false,
    narration: `عكس ${draft.narration}`,
    sourceKey: key ?? draft.sourceKey,
    sourceEvent: event,
    needsAttention: false,
    attentionReason: null,
    lines: draft.lines.map((l) => ({
      ...l,
      label: `عكس ${l.label}`,
      debitMilli: l.creditMilli,
      creditMilli: l.debitMilli,
      ...(l.taxBaseMilli !== undefined && l.taxBaseMilli !== null ? { taxBaseMilli: -l.taxBaseMilli } : {}),
    })),
  };
}

/** نِسب AUTO_SALE_<pct> التي تطلبها المسودة ولا توجد في السياق (التزام M2 (5)) */
export function missingAutoSalePercents(result: BuildResult, context: Pick<LedgerContext, 'ctx'>): number[] {
  if (isNoMove(result)) return [];
  const out = new Set<number>();
  for (const l of result.lines) {
    const code = l.taxCode;
    if (!code || !code.startsWith('AUTO_SALE_') || context.ctx.taxes.byKey(code)) continue;
    const pct = Number(code.slice('AUTO_SALE_'.length).replace('_', '.'));
    if (Number.isFinite(pct) && pct > 0) out.add(pct);
  }
  return [...out].sort((a, b) => a - b);
}

/** مجموع المبالغ الموقَّع (للتشخيص في الاختبارات) */
export function draftNetMilli(d: MoveDraft): Milli {
  return d.lines.reduce((a, l) => a + l.debitMilli - l.creditMilli, 0n);
}
