/**
 * الترحيل التاريخي بإيقاع محدد (M3، DESIGN.md §5.6 الخطوتان 2 و6 و«التقدم»، §5.1، §5.2، §8.4 القسم 2).
 *
 * - الحالة GlSettings.backfillState: NONE ⇒ RUNNING (عند التفعيل) ⇒ DONE حين تكتمل مؤشرات كل المصادر النشطة حتى
 *   الأفق ولا حدث PENDING؛ و«إيقاف مؤقت» RUNNING ⇄ PAUSED من صفحة الإعدادات.
 * - الإيقاع: backfillReconcilerFn يلفّ reconcileTenant بحد صفحات لكل نبضة أثناء RUNNING، ولا يقرأ شيئاً أثناء PAUSED.
 * - الطريقة (ب) «التاريخ الكامل»: cutoverDate = بداية السنة المالية لأقدم أثر، ويُمنع الخيار فوق 60 ألف صف
 *   (422 LEDGER_HISTORY_TOO_LARGE).
 * - الفحص لمرة واحدة (§5.6): صفوف أُنشئت قبل المؤشر الابتدائي بتاريخ أثر ≥ cutover (مستندات مؤرخة مستقبلاً)
 *   لا تقرؤها التمريرة الدائمة أبداً ⇒ تُدرج أحداثها داخل معاملة التفعيل (scanFutureDatedRows).
 *
 * الدوال الصرفة بلا قاعدة؛ دوال Prisma تأخذ العميل/المعاملة من المُستدعي.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { fiscalYearStart, localDate } from './dates';
import { activeSyncSources } from './locks';
import { LedgerError, type BackfillState, type InventoryMode, type LocalDate } from './types';
import { deriveSourceEvents, isReconciledSource, sourceEventCreateRow, type SourceRow } from './sync/desired';
import { reconcileHorizon, reconcileTenant, type ReconcileSettings, type ReconcilerStore } from './sync/reconciler';
import { createPrismaReconcilerStore } from './sync/reconcilerStore.prisma';
import type { ReconcileFn } from './sync/tick';
import {
  IMPORT_LANE_SOURCE_TYPES, SYNC_HEARTBEAT_MS, TICK_DB_BUDGET_MS, TICK_EVENT_BUDGET,
  type DesiredEvent, type SyncCursorSource,
} from './sync/types';

type GlDb = Prisma.TransactionClient;

// ═══ الحجم والتقدير (الخطوة 2) ═══

/** سقف الترحيل التاريخي الكامل بالصفوف المتوقعة (§5.6 الخطوة 2) */
export const HISTORY_MAX_ROWS = 60_000;

/** صفحات المُطابِق لكل مصدر في النبضة أثناء الترحيل التاريخي (الإيقاع المحدد) */
export const BACKFILL_PAGES_PER_TICK = 2;

export interface HistoryCounts {
  accountEntries: number;
  repSettlements: number;
  settlementEntries: number;
  /** الجرد المستمر (M9) فقط */
  inventoryMoves?: number;
}

export interface HistoryEstimate {
  rows: number;
  /** حد أعلى تقريبي للأحداث (صف ≈ حدث) */
  estimatedEvents: number;
  /** بالدقائق بالإنتاجية المقيسة، أو بالحد المتحفظ المقيّد بـTICK_DB_BUDGET_MS حين لا قياس */
  estimatedMinutes: number;
  /** الأحداث في الدقيقة المستعملة في التقدير */
  eventsPerMinute: number;
  /** MEASURED: من سجل الترحيل الفعلي؛ CONSERVATIVE: حد متحفظ (معاملة لكل حدث ضمن ميزانية زمن النبضة) */
  throughputBasis: ThroughputBasis;
  maxRows: number;
  tooLarge: boolean;
}

export type ThroughputBasis = 'MEASURED' | 'CONSERVATIVE';

/**
 * زمن متحفظ لمعاملة ترحيل حدث واحد (قفل + قراءة + بناء + postMove + تحديث الحدث) على قاعدة Render الصغيرة.
 * TICK_EVENT_BUDGET (300) سقف لا إنتاجية: ميزانية الزمن 3 ثوانٍ للنبضة تسمح بنحو 75 حدثاً بهذا الزمن.
 */
export const CONSERVATIVE_MS_PER_EVENT = 40;
/** أقل عدد أحداث مقيسة في النافذة ليُعتمد القياس */
export const MIN_MEASURED_EVENTS = 50;
/** نافذة قياس الإنتاجية من سجل الترحيل */
export const THROUGHPUT_WINDOW_MS = 30 * 60_000;

/** الحد المتحفظ للأحداث في الدقيقة: min(TICK_EVENT_BUDGET، TICK_DB_BUDGET_MS / زمن الحدث) لكل نبضة */
export function conservativeEventsPerMinute(): number {
  const perTick = Math.max(1, Math.min(TICK_EVENT_BUDGET, Math.floor(TICK_DB_BUDGET_MS / CONSERVATIVE_MS_PER_EVENT)));
  return perTick * (60_000 / SYNC_HEARTBEAT_MS);
}

/** الإنتاجية المعتمدة: المقيسة (مقيّدة بالسقف الاسمي) إن وُجدت وإلا الحد المتحفظ */
export function throughputOf(measuredEventsPerMinute?: number | null): { eventsPerMinute: number; basis: ThroughputBasis } {
  const nominal = TICK_EVENT_BUDGET * (60_000 / SYNC_HEARTBEAT_MS);
  if (typeof measuredEventsPerMinute === 'number' && Number.isFinite(measuredEventsPerMinute) && measuredEventsPerMinute > 0) {
    return { eventsPerMinute: Math.min(nominal, measuredEventsPerMinute), basis: 'MEASURED' };
  }
  return { eventsPerMinute: conservativeEventsPerMinute(), basis: 'CONSERVATIVE' };
}

/**
 * من سجل الترحيل (البند 4 (ج)): أحداث حُسمت فعلاً (DONE أو SKIPPED غير الافتتاح) في النافذة، مقسومة على مدة العمل بين
 * أول حسم وآخره (فترة خمول قبل استيراد جديد لا تُخفض الإنتاجية)، بحد أدنى دقيقة واحدة (نبضة). null إن قلّت عن
 * MIN_MEASURED_EVENTS.
 */
export function measuredEventsPerMinute(input: { processed: number; firstProcessedAt: Date | null; lastProcessedAt?: Date | null; dbNow: Date }): number | null {
  if (input.processed < MIN_MEASURED_EVENTS || !input.firstProcessedAt) return null;
  const end = input.lastProcessedAt ?? input.dbNow;
  const minutes = Math.max(1, (end.getTime() - input.firstProcessedAt.getTime()) / 60_000);
  return input.processed / minutes;
}

/** الإنتاجية المقيسة للشركة من GlSourceEvent.processedAt في THROUGHPUT_WINDOW_MS — null ⇒ الحد المتحفظ (ولمعاينة المعالج) */
export async function loadMeasuredEventsPerMinute(db: GlDb | PrismaClient, tenantId: string, dbNow: Date): Promise<number | null> {
  const since = new Date(dbNow.getTime() - THROUGHPUT_WINDOW_MS);
  const processed = await db.glSourceEvent.aggregate({
    where: {
      tenantId, status: { in: ['DONE', 'SKIPPED'] }, processedAt: { gte: since },
      // SKIPPED(OPENING) يُحسم جماعياً بلا ترحيل ⇒ لا يُعدّ إنتاجية
      OR: [{ skipReason: null }, { skipReason: { not: 'OPENING' } }],
    },
    _count: { _all: true }, _min: { processedAt: true }, _max: { processedAt: true },
  });
  return measuredEventsPerMinute({
    processed: processed._count._all, firstProcessedAt: processed._min.processedAt ?? null,
    lastProcessedAt: processed._max.processedAt ?? null, dbNow,
  });
}

export function estimateHistory(c: HistoryCounts, opts: { measuredEventsPerMinute?: number | null } = {}): HistoryEstimate {
  const rows = c.accountEntries + c.repSettlements + c.settlementEntries + (c.inventoryMoves ?? 0);
  const t = throughputOf(opts.measuredEventsPerMinute);
  return {
    rows,
    estimatedEvents: rows,
    estimatedMinutes: rows === 0 ? 0 : Math.ceil(rows / t.eventsPerMinute),
    eventsPerMinute: t.eventsPerMinute,
    throughputBasis: t.basis,
    maxRows: HISTORY_MAX_ROWS,
    tooLarge: rows > HISTORY_MAX_ROWS,
  };
}

/** 422 LEDGER_HISTORY_TOO_LARGE إن تجاوز التقدير السقف */
export function assertHistoryNotTooLarge(e: HistoryEstimate): void {
  if (e.tooLarge) throw new LedgerError('LEDGER_HISTORY_TOO_LARGE', { rows: e.rows, maxRows: e.maxRows });
}

/** الطريقة (ب): بداية السنة المالية لأقدم أثر (null ⇒ لا مستندات، فيُقترح تاريخ الطريقة (أ)) */
export function fullHistoryCutoverDate(oldestEffectAt: Date | null, timezone: string, fiscalYearEndMonth = 12, fiscalYearEndDay = 31): LocalDate | null {
  if (!oldestEffectAt) return null;
  return fiscalYearStart(localDate(oldestEffectAt, timezone), fiscalYearEndMonth, fiscalYearEndDay);
}

/** العدّ وأقدم أثر من القاعدة (الجداول الثلاثة المُطابَقة) */
export async function loadHistoryFacts(db: GlDb | PrismaClient, tenantId: string): Promise<{ counts: HistoryCounts; oldestEffectAt: Date | null }> {
  const where = { tenantId };
  const [accountEntries, repSettlements, settlementEntries, oldestEntry, oldestSettlement, oldestSe] = await Promise.all([
    db.accountEntry.count({ where }),
    db.repSettlement.count({ where }),
    db.settlementEntry.count({ where }),
    db.accountEntry.findFirst({ where, orderBy: { entryDate: 'asc' }, select: { entryDate: true } }),
    db.repSettlement.findFirst({ where, orderBy: { settledAt: 'asc' }, select: { settledAt: true } }),
    db.settlementEntry.findFirst({ where, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
  ]);
  const candidates = [oldestEntry?.entryDate, oldestSettlement?.settledAt, oldestSe?.createdAt].filter((d): d is Date => d instanceof Date);
  const oldestEffectAt = candidates.length ? new Date(Math.min(...candidates.map((d) => d.getTime()))) : null;
  return { counts: { accountEntries, repSettlements, settlementEntries }, oldestEffectAt };
}

// ═══ المؤشرات الابتدائية (الخطوة 6) ═══

export function initialCursorRows(tenantId: string, inventoryMode: InventoryMode, watermarkAt: Date): Prisma.GlSyncCursorCreateManyInput[] {
  return activeSyncSources(inventoryMode).map((source) => ({ tenantId, source, watermarkAt, watermarkId: '', lastCount: 0, stallTicks: 0 }));
}

// ═══ الحالة والتقدم ═══

export type BackfillAction = 'PAUSE' | 'RESUME';

/** RUNNING ⇄ PAUSED فقط؛ غير ذلك null (المسار يرد 409) */
export function backfillTransition(current: BackfillState, action: BackfillAction): BackfillState | null {
  if (action === 'PAUSE') return current === 'RUNNING' ? 'PAUSED' : null;
  return current === 'PAUSED' ? 'RUNNING' : null;
}

/** المُطابِق يقرأ للشركة ما لم يكن الترحيل التاريخي موقوفاً مؤقتاً */
export function shouldReconcile(state: BackfillState | string): boolean {
  return state !== 'PAUSED';
}

export interface BackfillSourceState {
  source: SyncCursorSource;
  watermarkAt: Date;
  lastRunAt: Date | null;
  lastCount: number;
  stallTicks: number;
  /** توجد صفوف غير مقروءة حتى الأفق */
  unread: boolean;
}

export interface BackfillProgressInput {
  state: BackfillState;
  sources: readonly BackfillSourceState[];
  /** أحداث PENDING (بلا BLOCKED/ERROR/HELD: تلك تظهر في المراجعة ولا تؤخر اكتمال المؤشرات) */
  pendingEvents: number;
  /** منها أحداث الاستيراد (AR_ENTRY) — والباقي مستندات حية (البند 4 (ج)) */
  pendingImportEvents?: number;
  /** الإنتاجية المقيسة (أحداث/دقيقة) أو null ⇒ الحد المتحفظ */
  measuredEventsPerMinute?: number | null;
  /** PENDING + BLOCKED + ERROR + HELD — للعرض */
  openEvents: number;
  doneEvents: number;
  dbNow: Date;
}

export interface BackfillProgress {
  state: BackfillState;
  caughtUp: boolean;
  /** الحالة بعد التقييم: RUNNING ⇒ DONE حين caughtUp */
  nextState: BackfillState;
  sources: { source: SyncCursorSource; watermarkAt: string; lastRunAt: string | null; lagMs: number; caughtUp: boolean; stallTicks: number }[];
  pendingEvents: number;
  /** المعلّق مفصولاً: الاستيراد والمستندات الحية */
  pendingByLane: { import: number; live: number };
  openEvents: number;
  doneEvents: number;
  /** دقائق تقريبية بالإنتاجية المقيسة أو الحد المتحفظ */
  etaMinutes: number | null;
  eventsPerMinute: number;
  throughputBasis: ThroughputBasis;
}

/** اكتمال المؤشرات حتى اللحظة: لا صفوف غير مقروءة حتى الأفق في أي مصدر، ولا حدث PENDING */
export function backfillProgress(i: BackfillProgressInput): BackfillProgress {
  const sources = i.sources.map((s) => ({
    source: s.source,
    watermarkAt: s.watermarkAt.toISOString(),
    lastRunAt: s.lastRunAt ? s.lastRunAt.toISOString() : null,
    lagMs: s.unread ? Math.max(0, i.dbNow.getTime() - s.watermarkAt.getTime()) : 0,
    caughtUp: !s.unread,
    stallTicks: s.stallTicks,
  }));
  const caughtUp = sources.length > 0 && sources.every((s) => s.caughtUp) && i.pendingEvents === 0;
  const nextState: BackfillState = i.state === 'RUNNING' && caughtUp ? 'DONE' : i.state;
  const t = throughputOf(i.measuredEventsPerMinute);
  const importPending = Math.max(0, Math.min(i.pendingEvents, i.pendingImportEvents ?? 0));
  return {
    state: i.state, caughtUp, nextState, sources,
    pendingEvents: i.pendingEvents,
    pendingByLane: { import: importPending, live: i.pendingEvents - importPending },
    openEvents: i.openEvents, doneEvents: i.doneEvents,
    etaMinutes: caughtUp ? 0 : i.pendingEvents > 0 ? Math.ceil(i.pendingEvents / t.eventsPerMinute) : null,
    eventsPerMinute: t.eventsPerMinute,
    throughputBasis: t.basis,
  };
}

/**
 * يقرأ التقدم، ويكتب DONE بتحديث مشروط (backfillState='RUNNING') حين تكتمل المؤشرات. null قبل التفعيل.
 * يُستدعى من GET /setup (ومن المجدول إن رُبط).
 */
export async function refreshBackfillState(db: PrismaClient, tenantId: string): Promise<BackfillProgress | null> {
  const s = await db.glSettings.findUnique({ where: { tenantId }, select: { activatedAt: true, backfillState: true, inventoryMode: true } });
  if (!s?.activatedAt) return null;
  const store = createPrismaReconcilerStore(db);
  const dbNow = await store.dbNow();
  const horizon = reconcileHorizon(dbNow);
  const active = activeSyncSources(s.inventoryMode === 'PERPETUAL' ? 'PERPETUAL' : 'PERIODIC');
  const cursors = await db.glSyncCursor.findMany({ where: { tenantId, source: { in: active } } });
  const sources: BackfillSourceState[] = [];
  for (const source of active) {
    const c = cursors.find((x) => x.source === source);
    if (!c) {
      sources.push({ source, watermarkAt: new Date(0), lastRunAt: null, lastCount: 0, stallTicks: 0, unread: true });
      continue;
    }
    // مصادر المخزون (M9) بلا مُطابِق بعد: تُعدّ غير مكتملة ما دامت بلا تشغيل
    const unread = isReconciledSource(source)
      ? await store.hasUnreadRows(tenantId, source, { at: c.watermarkAt, id: c.watermarkId }, horizon)
      : c.lastRunAt === null;
    sources.push({ source, watermarkAt: c.watermarkAt, lastRunAt: c.lastRunAt, lastCount: c.lastCount, stallTicks: c.stallTicks, unread });
  }
  const grouped = await db.glSourceEvent.groupBy({ by: ['status', 'sourceType'], where: { tenantId }, _count: { _all: true } });
  const countOf = (st: string, types?: readonly string[]) => grouped
    .filter((g) => g.status === st && (!types || types.includes(g.sourceType)))
    .reduce((n, g) => n + g._count._all, 0);
  // الإنتاجية المقيسة للشركة (البند 4 (ج)): الحسم الجماعي SKIPPED(OPENING) لا يُعدّ إنتاجية ترحيل
  const measured = await loadMeasuredEventsPerMinute(db, tenantId, dbNow);
  const progress = backfillProgress({
    state: (s.backfillState || 'NONE') as BackfillState,
    sources,
    pendingEvents: countOf('PENDING'),
    pendingImportEvents: countOf('PENDING', IMPORT_LANE_SOURCE_TYPES),
    measuredEventsPerMinute: measured,
    openEvents: countOf('PENDING') + countOf('BLOCKED') + countOf('ERROR') + countOf('HELD'),
    doneEvents: countOf('DONE') + countOf('SKIPPED'),
    dbNow,
  });
  if (progress.nextState !== progress.state) {
    const r = await db.glSettings.updateMany({ where: { tenantId, backfillState: 'RUNNING' }, data: { backfillState: progress.nextState } });
    if (r.count === 1) return { ...progress, state: progress.nextState };
  }
  return progress;
}

// ═══ الإيقاع في النبضة ═══

/**
 * المُطابِق بإيقاع الترحيل التاريخي: PAUSED ⇒ لا قراءة؛ RUNNING ⇒ حد صفحات لكل نبضة؛ غير ذلك ⇒ بلا حد.
 * بديل reconcilerFn في SchedulerDeps.reconcile.
 */
export function backfillReconcilerFn(store: ReconcilerStore, opts: { pagesPerTick?: number } = {}): ReconcileFn {
  const pages = opts.pagesPerTick ?? BACKFILL_PAGES_PER_TICK;
  return async (tenantId, budget, ctx) => {
    if (!shouldReconcile(ctx.settings.backfillState)) return [];
    return reconcileTenant(store, tenantId, {
      clock: budget.clock, deadline: budget.deadline, dbNow: ctx.dbNow,
      ...(ctx.settings.backfillState === 'RUNNING' ? { maxPages: pages } : {}),
    });
  };
}

// ═══ الفحص لمرة واحدة: المستندات المؤرخة مستقبلاً (§5.6) ═══

function mergeRowsById<T extends { id: string; createdAt: Date }>(a: readonly T[], b: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const r of [...a, ...b]) if (!byId.has(r.id)) byId.set(r.id, r);
  return [...byId.values()].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/**
 * قاعدة الوصول المتأخر للإلغاء (§5.6، §5.4): أثر REVERSE = max(تاريخ صف الإلغاء، أثر POST لمستنده). إلغاء مستند مؤرخ
 * مستقبلاً قبل البدء صفُّه بتاريخ قبل البدء، فلو بقي أثره كذلك لصُنِّف «مشمولاً بالافتتاح» وتخطّاه المُرحِّل بينما يُرحَّل
 * POST — فيُحاذى إلى أثر POST (ومعه entryDate في الحمولة) فيُرحَّل العكس بعده بالتاريخ نفسه.
 */
export function alignReversalsToOrigin(events: readonly DesiredEvent[], timezone: string): DesiredEvent[] {
  const posts = new Map<string, DesiredEvent>();
  for (const e of events) if (e.event === 'POST') posts.set(`${e.sourceType}:${e.sourceId}`, e);
  return events.map((e) => {
    if (e.event !== 'REVERSE' || (e.sourceType !== 'INVOICE' && e.sourceType !== 'RECEIPT')) return e;
    const post = posts.get(`${e.sourceType}:${e.sourceId}`);
    if (!post || post.effectAt.getTime() <= e.effectAt.getTime()) return e;
    const effectAt = new Date(post.effectAt.getTime());
    const payload = e.payload && typeof e.payload === 'object'
      ? { ...(e.payload as unknown as Record<string, unknown>), entryDate: localDate(effectAt, timezone) } as unknown as DesiredEvent['payload']
      : e.payload;
    return { ...e, effectAt, payload };
  });
}

// ═══ تجميد تقسيم الاستلامات المشمولة بالافتتاح (§5.6 الخطوة 6، §5.5 P7) ═══

export interface OpeningSettlementFreezeInput {
  /** DerivedOpening.settlementSplits المحسوبة داخل معاملة التفعيل بـT0 */
  splits: Readonly<Record<string, { salesRepId: string; nonCustodyClearedMilli: bigint; shortageRecoveredMilli: bigint }>>;
  settings: ReconcileSettings;
  processedAt: Date;
}

/** صفوف gl_source_events لأحداث SETTLEMENT:<id>:POST مجمّدة: SKIPPED(OPENING) بتقسيم الافتتاح (صرفة) */
export function openingSettlementEventRows(tenantId: string, events: readonly DesiredEvent[], input: Pick<OpeningSettlementFreezeInput, 'splits' | 'processedAt'>): Prisma.GlSourceEventCreateManyInput[] {
  const out: Prisma.GlSourceEventCreateManyInput[] = [];
  for (const e of events) {
    if (e.sourceType !== 'SETTLEMENT' || e.event !== 'POST') continue;
    const split = input.splits[e.sourceId];
    if (!split) continue;
    out.push({
      ...(sourceEventCreateRow(tenantId, { ...e, status: 'SKIPPED', skipReason: 'OPENING' }) as Prisma.GlSourceEventCreateManyInput),
      processedAt: input.processedAt,
      nonCustodyClearedMilli: split.nonCustodyClearedMilli,
      shortageRecoveredMilli: split.shortageRecoveredMilli,
    });
  }
  return out;
}

/**
 * داخل معاملة التفعيل بعد قيد OPEN: لكل استلام مشمول بالافتتاح يُدرج حدث POST بحالة SKIPPED(OPENING) يحمل r وrecovered
 * كما حسبهما الافتتاح. بلا ذلك يعيد custodyComponents اشتقاق التقسيم في كل ترحيل على **كل** السندات، ومنها الواصلة
 * متأخرة (أثر < cutover، createdAt > T0) التي استبعدها الافتتاح، فيصير C4 أحمر دائماً ويُعكس covered لم يُقيد.
 * المُطابِق وبوابة الأشقاء يُدرجان بـskipDuplicates فلا يمسّان الحدث المجمّد.
 */
export async function freezeOpeningSettlementSplits(tx: GlDb, tenantId: string, input: OpeningSettlementFreezeInput): Promise<number> {
  const ids = Object.keys(input.splits);
  if (ids.length === 0) return 0;
  const store = createPrismaReconcilerStore(tx as unknown as PrismaClient);
  let inserted = 0;
  const CHUNK = 2000;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await tx.repSettlement.findMany({
      where: { tenantId, id: { in: ids.slice(i, i + CHUNK) } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, salesRepId: true, amount: true, method: true, note: true, settledAt: true, createdAt: true },
    });
    if (rows.length === 0) continue;
    const facts = await store.loadFacts(tenantId, 'REP_SETTLEMENT', rows, input.settings);
    const data = openingSettlementEventRows(tenantId, deriveSourceEvents('REP_SETTLEMENT', rows, facts), input);
    if (data.length === 0) continue;
    const r = await tx.glSourceEvent.createMany({ data, skipDuplicates: true });
    inserted += r.count;
  }
  return inserted;
}

export interface FutureDatedScanInput {
  /** المؤشر الابتدائي (الصفوف createdAt ≤ هذا لا تقرؤها التمريرة الدائمة) */
  watermarkAt: Date;
  /** zonedStartOfDay(cutoverDate) */
  cutoverStart: Date;
  settings: ReconcileSettings;
}

export interface FutureDatedScanResult {
  accountEntries: number;
  repSettlements: number;
  eventsInserted: number;
}

/**
 * داخل معاملة التفعيل: صفوف account_entries (entryDate ≥ cutover) وrep_settlements (settledAt ≥ cutover)
 * المنشأة حتى المؤشر الابتدائي ⇒ أحداثها بالاشتقاق نفسه (desired.ts) وcreateMany({skipDuplicates}).
 * settlement_entries أثرها createdAt فلا تقع هنا.
 */
export async function scanFutureDatedRows(tx: GlDb, tenantId: string, input: FutureDatedScanInput): Promise<FutureDatedScanResult> {
  const created = { lte: input.watermarkAt };
  const entrySelect = { id: true, customerId: true, invoiceId: true, receiptId: true, type: true, debit: true, credit: true, description: true, entryDate: true, createdAt: true } as const;
  const [futureEntries, settlements] = await Promise.all([
    tx.accountEntry.findMany({
      where: { tenantId, createdAt: created, entryDate: { gte: input.cutoverStart } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: entrySelect,
    }),
    tx.repSettlement.findMany({
      where: { tenantId, createdAt: created, settledAt: { gte: input.cutoverStart } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, salesRepId: true, amount: true, method: true, note: true, settledAt: true, createdAt: true },
    }),
  ]);
  // صفوف إلغاء المستندات نفسها بتاريخ قبل البدء (entryDate = لحظة الإلغاء): أسقطها الافتتاح لغياب أثر مستندها،
  // فتُدمج هنا ليُنشأ REVERSE مع POST (وإلا رُحّل إيراد وضريبة فاتورة ملغاة بلا فحص يلتقطه)
  const invoiceIds = [...new Set(futureEntries.map((e) => e.invoiceId).filter((x): x is string => !!x))];
  const receiptIds = [...new Set(futureEntries.filter((e) => !e.invoiceId && e.receiptId).map((e) => e.receiptId as string))];
  const cancellations = invoiceIds.length || receiptIds.length
    ? await tx.accountEntry.findMany({
      where: {
        tenantId, createdAt: created, entryDate: { lt: input.cutoverStart },
        OR: [
          ...(invoiceIds.length ? [{ invoiceId: { in: invoiceIds } }] : []),
          ...(receiptIds.length ? [{ receiptId: { in: receiptIds } }] : []),
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: entrySelect,
    })
    : [];
  const entries = mergeRowsById(futureEntries, cancellations);
  const store = createPrismaReconcilerStore(tx as unknown as PrismaClient);
  let eventsInserted = 0;
  const run = async (source: 'ACCOUNT_ENTRY' | 'REP_SETTLEMENT', rows: readonly SourceRow[]) => {
    if (rows.length === 0) return;
    const facts = await store.loadFacts(tenantId, source, rows, input.settings);
    const events = alignReversalsToOrigin(deriveSourceEvents(source, rows, facts), input.settings.timezone);
    if (events.length === 0) return;
    const r = await tx.glSourceEvent.createMany({
      data: events.map((e) => sourceEventCreateRow(tenantId, e) as Prisma.GlSourceEventCreateManyInput),
      skipDuplicates: true,
    });
    eventsInserted += r.count;
  };
  await run('ACCOUNT_ENTRY', entries);
  await run('REP_SETTLEMENT', settlements);
  return { accountEntries: entries.length, repSettlements: settlements.length, eventsInserted };
}
