/**
 * تنفيذ PostingStore بـPrisma (M3، DESIGN.md §5.1، §5.2، §5.4).
 *
 * - يُنشأ بـPrismaClient **مستقل** بـ?connection_limit=1 (createWorkerPrismaClient) فلا يزاحم مجمّع اتصالات الـAPI.
 * - withPostLock: prisma.$transaction تفاعلية أول ما فيها acquirePostLock ⇒ pg_advisory_xact_lock (قفل معاملة لا جلسة).
 * - عقد الإيجار: $executeRaw بساعة القاعدة NOW() ودون لمس updatedAt؛ الفك بشرط الرمز نفسه.
 * - كل استعلام مقيّد بـtenantId (§9.4).
 * هذا الملف وحده (مع scheduler.ts) يعرف prisma؛ poster.ts وtick.ts يعملان على الواجهة.
 */
import { SETTLEMENT_HAS_REP } from '../settlementRep';
import { Prisma, PrismaClient } from '@prisma/client';
import { fromDbDate, localDate, maxLocalDate } from '../dates';
import { formatMilli, toMilli } from '../money';
import { acquirePostLock, postMove } from '../post';
import {
  loadBuildContext, requireMoveRecord, settingsSnapshotFromRow, type GlDb, type LedgerContext,
} from '../resolve';
import { reversalDraftFromRecord, reverseMove, type ReverseResult } from '../reverse';
import { isManualBooks, SETUP_METHODS } from '../mode';
import { autoSaleKey, invoicePayloadFromRows } from '../builders/invoice';
import { receiptCustodyClass, type CustodyComponentsInput, type CustodyItem, type CustodySettlementItem } from '../custody';
import {
  type BackfillState, type EventStatus, type SkipReason, type SourceEvent, type SourceType, type VatCategory,
} from '../types';
import { setupMethodOf, tombstoneOrigin, type LiveMoveState, type OriginFacts, type SiblingState } from './classify';
import type {
  EligibleTenant, ListDueEventsOptions, LiveMoveLine, OpeningImportCandidate, PosterSettings, PostingStore, PostingTx, SourceData,
  WithPostLockOptions,
} from './postingStore';
import {
  POST_TX_TIMEOUT_MS, SYNC_CURSOR_SOURCES, WORKER_LEASE_SECONDS,
  type CompositeKey, type DesiredEvent, type LeaseHandle, type SourceEventPatch, type SourceEventPayload, type SourceEventRecord,
  type SyncCursorSource, type SyncCursorState,
} from './types';
// «ربط الدفاتر» L4+L5+L8 (عقد §5.6) — استيرادات منفصلة لا تمسّ ما فوقها (دمج L0+L1 وL2+L3 بلا تعارض)
import { CASH_VOID_KEEP_COLLECTION_NOTE } from '../../../lib/ledgerNotes';
import { zonedStartOfDay } from '../dates';
import { isLinked } from '../mode';
import { ensureLinkedAccounts as ensureLinkedAccountRows } from '../coa/linkedAccounts';
import { linkedReversalVatPeriod } from '../vat/period';
import { linkedReceiptCustodyClass } from '../builders/receipt';
import { createPrismaReconcileStore } from '../reconcile/store.prisma';
import type { ReconcileStore } from '../reconcile/types';
import type { CustodyOpening, CustodyRouting, ReceiptCustodyClass } from '../custody';
import type { BuildContext, Milli, ReceiptRouting } from '../types';
import type { UserCustodyDeliveredRow, UserCustodyInputs, UserCustodyReceivedRow, UserCustodyRefundRow } from '../../userCustodyCore';
import { readUserCustodyOpsRows, userCustodyInputsFromRows } from '../../userCustody';
import {
  invoicePostEventPayload, paylinkRefundPayload, receiptPostEventPayload, receiptReverseEventPayload, settlementPayload, userSettlementPayload,
  type DeriveContext, type InvoiceFacts, type RepSettlementSourceRow,
} from './desired';
import { loadAdminNames, loadInvoiceFacts, loadReceiptFacts, loadRefundLinks } from './facts.prisma';
import { receiptKey, settlementKey } from './keys';

// ═══ عميل المعالج ═══

/** يضيف connection_limit=1 إلى رابط القاعدة (يستبدل القيمة القائمة إن وُجدت) */
export function withConnectionLimit(url: string, limit = 1): string {
  const [base, query = ''] = url.split('?');
  const params = query.split('&').filter((p) => p && !/^connection_limit=/i.test(p));
  params.push(`connection_limit=${limit}`);
  return `${base}?${params.join('&')}`;
}

/** PrismaClient مستقل للمعالج (§5.1) — null إن لم يُضبط DATABASE_URL */
export function createWorkerPrismaClient(env: NodeJS.ProcessEnv = process.env): PrismaClient | null {
  const url = env.DATABASE_URL;
  if (!url) return null;
  return new PrismaClient({ datasources: { db: { url: withConnectionLimit(url, 1) } }, log: ['error'] });
}

if (WORKER_LEASE_SECONDS !== 90) throw new Error('WORKER_LEASE_SECONDS يجب أن يطابق INTERVAL \'90 seconds\' في SQL العقد');

// ═══ التحويلات ═══

type EventRow = Prisma.GlSourceEventGetPayload<object>;

function recordOf(r: EventRow): SourceEventRecord {
  return {
    id: r.id,
    tenantId: r.tenantId,
    sourceKey: r.sourceKey,
    sourceType: r.sourceType as SourceType,
    sourceId: r.sourceId,
    event: r.event as SourceEvent,
    effectAt: r.effectAt,
    detectedAt: r.detectedAt,
    payload: (r.payload ?? null) as SourceEventPayload | null,
    status: r.status as EventStatus,
    skipReason: (r.skipReason ?? null) as SkipReason | null,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt,
    lastError: r.lastError,
    moveId: r.moveId,
    processedAt: r.processedAt,
    nonCustodyClearedMilli: r.nonCustodyClearedMilli,
    shortageRecoveredMilli: r.shortageRecoveredMilli,
  };
}

function patchData(p: SourceEventPatch): Prisma.GlSourceEventUpdateManyMutationInput {
  const d: Prisma.GlSourceEventUpdateManyMutationInput = {};
  if (p.status !== undefined) d.status = p.status;
  if (p.skipReason !== undefined) d.skipReason = p.skipReason;
  if (p.attempts !== undefined) d.attempts = p.attempts;
  if (p.nextAttemptAt !== undefined) d.nextAttemptAt = p.nextAttemptAt;
  if (p.lastError !== undefined) d.lastError = p.lastError === null ? null : p.lastError.slice(0, 4000);
  if (p.moveId !== undefined) d.moveId = p.moveId;
  if (p.processedAt !== undefined) d.processedAt = p.processedAt;
  if (p.nonCustodyClearedMilli !== undefined) d.nonCustodyClearedMilli = p.nonCustodyClearedMilli;
  if (p.shortageRecoveredMilli !== undefined) d.shortageRecoveredMilli = p.shortageRecoveredMilli;
  return d;
}

function jsonOf(v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (v === null || v === undefined) return Prisma.DbNull;
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))) as Prisma.InputJsonValue;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

// ═══ أهلية الشركات ═══

/** طرق الإعداد اليدوية مشتقّةً من services/gl/mode (لا مقارنة حرفية): اليوم ['CLEAN'] */
const MANUAL_SETUP_METHODS: string[] = SETUP_METHODS.filter((m) => isManualBooks({ setupMethod: m }));

/**
 * where الشركات المفعّلة بعَلَم المجموعة (صرفة، تُختبر بلا قاعدة). excludeManual ⇒ تُستبعد الدفاتر اليدوية في SQL نفسه
 * («ربط الدفاتر» L0 A4): كانت تمرّ إلى النبضة فتُتخطّى بـMANUAL_LEDGER بلا لمس lastSyncAt، فتبقى بـNULL في رأس الترتيب
 * (NULLS FIRST) أبداً وتأكل سقف 200 من المربوطة. setupMethod الفارغ يبقى مؤهلاً كما كان: `NOT IN` وحده يُسقط NULL في SQL،
 * فالفرع `setupMethod: null` صريح.
 */
export function eligibleTenantsWhere(opts: { excludeManual: boolean }): Prisma.GlSettingsWhereInput {
  return {
    activatedAt: { not: null },
    tenant: { accountingSuiteEnabled: true, accountingEnabled: true },
    ...(opts.excludeManual ? { OR: [{ setupMethod: null }, { setupMethod: { notIn: MANUAL_SETUP_METHODS } }] } : {}),
  };
}

// ═══ المخزن ═══

export class PrismaPostingStore implements PostingStore {
  /** listDueEvents يحترم opts.sourceTypes ⇒ المُرحِّل يعمل بمساري العدالة (البند 4 (ب)) */
  readonly filtersDueEventsBySourceType = true;

  constructor(private readonly db: PrismaClient) {}

  async dbNow(): Promise<Date> {
    return dbNowOf(this.db);
  }

  /** النبضة: بلا الدفاتر اليدوية (لا شيء فيها للمُطابِق ولا للمُرحِّل) */
  async listEligibleTenants(limit = 200): Promise<EligibleTenant[]> {
    return this.listTenants(eligibleTenantsWhere({ excludeManual: true }), limit);
  }

  /** الفحوص الليلية: كل المفعّلة ومنها اليدوية — كما كانت قائمة الأهلية قبل الاستبعاد (runChecks يتخطّى لها فحوص المطابقة) */
  async listCheckTenants(limit = 200): Promise<EligibleTenant[]> {
    return this.listTenants(eligibleTenantsWhere({ excludeManual: false }), limit);
  }

  private async listTenants(where: Prisma.GlSettingsWhereInput, limit: number): Promise<EligibleTenant[]> {
    return this.db.glSettings.findMany({
      where,
      select: { tenantId: true, lastSyncAt: true },
      orderBy: [{ lastSyncAt: { sort: 'asc', nulls: 'first' } }, { tenantId: 'asc' }],
      take: limit,
    });
  }

  async loadPosterSettings(tenantId: string): Promise<PosterSettings | null> {
    const row = await this.db.glSettings.findUnique({
      where: { tenantId },
      include: { tenant: { select: { accountingSuiteEnabled: true, accountingEnabled: true } } },
    });
    if (!row) return null;
    const company = await this.db.companySettings.findUnique({ where: { tenantId }, select: { currency: true, currencyOverride: true } });
    const snapshot = settingsSnapshotFromRow(row);
    return {
      tenantId,
      suiteEnabled: row.tenant?.accountingSuiteEnabled === true && row.tenant?.accountingEnabled !== false,
      activatedAt: row.activatedAt,
      backfillState: (row.backfillState || 'NONE') as BackfillState,
      setupMethod: setupMethodOf(row.setupMethod),
      cutoverDate: row.cutoverDate ? fromDbDate(row.cutoverDate) : null,
      openingSnapshotAt: row.openingSnapshotAt,
      timezone: snapshot.timezone,
      inventoryMode: snapshot.inventoryMode,
      perpetualFromDate: snapshot.perpetualFromDate,
      currency: row.currency,
      companyCurrency: company ? (company.currencyOverride || company.currency) : null,
      lastSyncAt: row.lastSyncAt,
      snapshot,
    };
  }

  async tryAcquireLease(tenantId: string, token: string): Promise<boolean> {
    const n = await this.db.$executeRaw`
      UPDATE "gl_settings" SET "workerLeaseUntil" = NOW() + INTERVAL '90 seconds', "workerLeaseToken" = ${token}
      WHERE "tenantId" = ${tenantId} AND ("workerLeaseUntil" IS NULL OR "workerLeaseUntil" < NOW())`;
    return n === 1;
  }

  async releaseLease(lease: LeaseHandle): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "gl_settings" SET "workerLeaseUntil" = NULL, "workerLeaseToken" = NULL
      WHERE "tenantId" = ${lease.tenantId} AND "workerLeaseToken" = ${lease.token}`;
  }

  async touchLastSync(tenantId: string, at: Date): Promise<void> {
    await this.db.$executeRaw`UPDATE "gl_settings" SET "lastSyncAt" = ${at} WHERE "tenantId" = ${tenantId}`;
  }

  async readCursor(tenantId: string, source: SyncCursorSource): Promise<SyncCursorState | null> {
    const r = await this.db.glSyncCursor.findUnique({ where: { tenantId_source: { tenantId, source } } });
    return r ? cursorOf(r) : null;
  }

  /** EXISTS نفسه في reconcilerStore.hasUnreadRows: ("createdAt","id") > المؤشر AND "createdAt" <= الأفق */
  async hasUnreadRows(tenantId: string, _source: 'ACCOUNT_ENTRY', watermark: CompositeKey, horizon: Date): Promise<boolean> {
    const row = await this.db.accountEntry.findFirst({
      where: {
        tenantId,
        createdAt: { lte: horizon },
        OR: [{ createdAt: { gt: watermark.at } }, { createdAt: watermark.at, id: { gt: watermark.id } }],
      },
      select: { id: true },
    });
    return !!row;
  }

  /**
   * «ربط الدفاتر» L5: صفوف RepSettlement بعد مؤشر REP_SETTLEMENT حتى الأفق — EXISTS نفسه في reconcilerStore.hasUnreadRows
   * للمصدر (مرشّح المندوب القائم SETTLEMENT_HAS_REP)، لمؤشر ترتيب USER_SETTLEMENT الفعّال (poster.effectiveRepSettlementWatermark).
   */
  async hasUnreadRepSettlements(tenantId: string, watermark: CompositeKey, horizon: Date): Promise<boolean> {
    const row = await this.db.repSettlement.findFirst({
      where: {
        tenantId, ...SETTLEMENT_HAS_REP,
        createdAt: { lte: horizon },
        OR: [{ createdAt: { gt: watermark.at } }, { createdAt: watermark.at, id: { gt: watermark.id } }],
      },
      select: { id: true },
    });
    return !!row;
  }

  async readCursors(tenantId: string): Promise<SyncCursorState[]> {
    const rows = await this.db.glSyncCursor.findMany({ where: { tenantId }, orderBy: { source: 'asc' } });
    return rows.filter((r) => (SYNC_CURSOR_SOURCES as readonly string[]).includes(r.source)).map(cursorOf);
  }

  async inventoryHorizon(tenantId: string): Promise<Date | null> {
    const s = await this.db.glSettings.findUnique({ where: { tenantId }, select: { inventoryMode: true, backfillState: true } });
    if (!s || s.inventoryMode !== 'PERPETUAL' || s.backfillState !== 'DONE') return null;
    const rows = await this.db.glSyncCursor.findMany({
      where: { tenantId, source: { in: ['ACCOUNT_ENTRY', 'WAREHOUSE_ENTRY', 'VAN_LOAD'] } }, select: { watermarkAt: true },
    });
    if (rows.length < 3) return null;
    return rows.reduce((m, r) => (r.watermarkAt < m ? r.watermarkAt : m), rows[0].watermarkAt);
  }

  async inventoryBlockedHead(tenantId: string): Promise<{ effectAt: Date; sourceKey: string } | null> {
    return this.db.glSourceEvent.findFirst({
      where: {
        tenantId, status: { in: ['ERROR', 'HELD', 'BLOCKED'] },
        OR: [{ sourceType: { in: ['WH_ENTRY', 'VAN_LOAD', 'RESTOCK'] } }, { event: { in: ['COGS', 'RESTOCK'] } }],
      },
      orderBy: [{ effectAt: 'asc' }, { sourceKey: 'asc' }],
      select: { effectAt: true, sourceKey: true },
    });
  }

  async listDueEvents(tenantId: string, opts: ListDueEventsOptions): Promise<SourceEventRecord[]> {
    const rows = await this.db.glSourceEvent.findMany({
      where: {
        tenantId,
        OR: [{ status: 'PENDING' }, { status: { in: ['BLOCKED', 'ERROR'] }, nextAttemptAt: { lte: opts.now } }],
        ...(opts.excludeIds && opts.excludeIds.length ? { id: { notIn: [...opts.excludeIds] } } : {}),
        // فهرس [tenantId, status, sourceType, effectAt] (البند 4 (ب))
        ...(opts.sourceTypes?.in ? { sourceType: { in: [...opts.sourceTypes.in] } } : opts.sourceTypes?.notIn ? { sourceType: { notIn: [...opts.sourceTypes.notIn] } } : {}),
      },
      orderBy: [{ effectAt: 'asc' }, { sourceKey: 'asc' }],
      take: opts.limit,
    });
    return rows.map(recordOf);
  }

  async countPendingEvents(tenantId: string): Promise<number> {
    return this.db.glSourceEvent.count({
      where: { tenantId, OR: [{ status: { in: ['PENDING', 'BLOCKED'] } }, { status: 'ERROR', nextAttemptAt: { not: null } }] },
    });
  }

  async withPostLock<T>(tenantId: string, fn: (tx: PostingTx) => Promise<T>, opts: WithPostLockOptions = {}): Promise<T> {
    return this.db.$transaction(async (tx) => {
      await acquirePostLock(tx, tenantId);
      return fn(new PrismaPostingTx(tx, tenantId));
    }, { timeout: opts.timeoutMs ?? POST_TX_TIMEOUT_MS, maxWait: 5_000 });
  }

  async recordFailure(tenantId: string, eventId: string, patch: SourceEventPatch): Promise<void> {
    // لا يكتب فوق حالة نهائية (نبضة أخرى أو tombstone حسما الحدث بين المعاملة الساقطة وهذه الكتابة)
    await this.db.glSourceEvent.updateMany({
      where: { id: eventId, tenantId, status: { in: ['PENDING', 'BLOCKED', 'ERROR', 'HELD'] } },
      data: patchData(patch),
    });
  }
}

async function dbNowOf(db: Pick<PrismaClient, '$queryRaw'> | GlDb): Promise<Date> {
  const rows = await (db as GlDb).$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`;
  return rows[0]?.now instanceof Date ? rows[0].now : new Date(rows[0]?.now ?? Date.now());
}

function cursorOf(r: { source: string; watermarkAt: Date; watermarkId: string; lastRunAt: Date | null; lastCount: number; stallTicks: number }): SyncCursorState {
  return {
    source: r.source as SyncCursorSource, watermarkAt: r.watermarkAt, watermarkId: r.watermarkId,
    lastRunAt: r.lastRunAt, lastCount: r.lastCount, stallTicks: r.stallTicks,
  };
}

// ═══ داخل المعاملة ═══


export class PrismaPostingTx implements PostingTx {
  private settingsCache: { timezone: string; currency: string; decimals: number; routing: unknown; cashInvoiceRouting: string; cleanSince: Date | null } | null = null;
  /** «ربط الدفاتر» (D1): وضع الدفاتر ونافذة العهدة — يُملأ مع settingsCache من القراءة نفسها (لا استعلام زائد) */
  private linkCache: LinkedStoreSettings | null = null;

  constructor(private readonly tx: GlDb, readonly tenantId: string) {}

  private async settings() {
    if (!this.settingsCache) {
      const s = await this.tx.glSettings.findUnique({
        where: { tenantId: this.tenantId },
        select: {
          timezone: true, currency: true, currencyDecimals: true, receiptRouting: true, cashInvoiceRouting: true,
          setupMethod: true, openingSnapshotAt: true,
          activatedAt: true, linkedFrom: true, linkSnapshotAt: true, cutoverDate: true,
        },
      });
      this.linkCache = linkedStoreSettingsOf(s);
      this.settingsCache = {
        timezone: s?.timezone || 'Asia/Riyadh', currency: s?.currency ?? 'SAR', decimals: s?.currencyDecimals ?? 2,
        routing: s?.receiptRouting ?? null, cashInvoiceRouting: s?.cashInvoiceRouting ?? 'MAIN_CASH',
        // البداية النظيفة (الدفاتر اليدوية وحدها؛ LINKED كـOPENING بلا نافذة): ما أُنشئ حتى T0 خارج الدفاتر — نافذة محمّل العهدة
        cleanSince: isManualBooks(s) && s?.openingSnapshotAt ? s.openingSnapshotAt : null,
      };
    }
    return this.settingsCache;
  }

  async getEvent(sourceKey: string): Promise<SourceEventRecord | null> {
    const r = await this.tx.glSourceEvent.findUnique({ where: { tenantId_sourceKey: { tenantId: this.tenantId, sourceKey } } });
    return r ? recordOf(r) : null;
  }

  async getSibling(sourceKey: string): Promise<SiblingState | null> {
    const r = await this.tx.glSourceEvent.findUnique({
      where: { tenantId_sourceKey: { tenantId: this.tenantId, sourceKey } },
      select: { status: true, skipReason: true, moveId: true },
    });
    return r ? { status: r.status as EventStatus, skipReason: (r.skipReason ?? null) as SkipReason | null, moveId: r.moveId } : null;
  }

  async insertEvents(events: readonly DesiredEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const res = await this.tx.glSourceEvent.createMany({
      data: events.map((e) => ({
        tenantId: this.tenantId,
        sourceKey: e.sourceKey,
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        event: e.event,
        effectAt: e.effectAt,
        payload: jsonOf(e.payload),
        status: e.status ?? 'PENDING',
        skipReason: e.skipReason ?? null,
        lastError: e.lastError ?? null,
      })),
      skipDuplicates: true,
    });
    return res.count;
  }

  async updateEvent(id: string, patch: SourceEventPatch): Promise<void> {
    await this.tx.glSourceEvent.updateMany({ where: { id, tenantId: this.tenantId }, data: patchData(patch) });
  }

  /** البند 4 (أ): مرشّحو حسم OPENING الجماعي بترتيب (effectAt, id) — فهرس [tenantId, status, sourceType, effectAt] */
  async listOpeningImportCandidates(opts: { before: Date; after: CompositeKey | null; limit: number }): Promise<OpeningImportCandidate[]> {
    const rows = await this.tx.glSourceEvent.findMany({
      where: {
        tenantId: this.tenantId, sourceType: 'AR_ENTRY', event: 'POST', status: { in: ['PENDING', 'BLOCKED', 'ERROR'] },
        effectAt: { lt: opts.before },
        ...(opts.after ? { OR: [{ effectAt: { gt: opts.after.at } }, { effectAt: opts.after.at, id: { gt: opts.after.id } }] } : {}),
      },
      orderBy: [{ effectAt: 'asc' }, { id: 'asc' }],
      take: opts.limit,
      select: { id: true, sourceKey: true, sourceId: true, effectAt: true, status: true, payload: true },
    });
    if (rows.length === 0) return [];
    const reverseKeys = rows.map((r) => `AR_ENTRY:${r.sourceId}:REVERSE`);
    const reverses = await this.tx.glSourceEvent.findMany({
      where: { tenantId: this.tenantId, sourceKey: { in: reverseKeys } }, select: { sourceKey: true, status: true },
    });
    const revStatus = new Map(reverses.map((r) => [r.sourceKey, r.status as EventStatus]));
    return rows.map((r) => {
      const p = r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload) ? (r.payload as Record<string, unknown>) : null;
      return {
        id: r.id, sourceKey: r.sourceKey, sourceId: r.sourceId, effectAt: r.effectAt, status: r.status as EventStatus,
        createdAtHint: p ? (p.sourceCreatedAt ?? p.createdAt ?? null) : null,
        reverseStatus: revStatus.get(`AR_ENTRY:${r.sourceId}:REVERSE`) ?? null,
      };
    });
  }

  async skipOpeningImports(ids: readonly string[], now: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await this.tx.glSourceEvent.updateMany({
      where: {
        tenantId: this.tenantId, id: { in: [...ids] }, sourceType: 'AR_ENTRY', event: 'POST', status: { in: ['PENDING', 'BLOCKED', 'ERROR'] },
      },
      data: { status: 'SKIPPED', skipReason: 'OPENING', processedAt: now, lastError: null, nextAttemptAt: null },
    });
    return res.count;
  }

  async updateEventByKey(sourceKey: string, patch: SourceEventPatch, onlyIfStatusIn?: readonly EventStatus[]): Promise<number> {
    const res = await this.tx.glSourceEvent.updateMany({
      where: { tenantId: this.tenantId, sourceKey, ...(onlyIfStatusIn ? { status: { in: [...onlyIfStatusIn] } } : {}) },
      data: patchData(patch),
    });
    return res.count;
  }

  async findMoveIdBySourceKey(sourceKey: string): Promise<string | null> {
    const r = await this.tx.glMoveSource.findUnique({
      where: { tenantId_sourceKey: { tenantId: this.tenantId, sourceKey } }, select: { moveId: true },
    });
    return r?.moveId ?? null;
  }

  async findLiveMove(baseKey: string): Promise<LiveMoveState> {
    const rows = await this.tx.glMoveSource.findMany({
      where: {
        tenantId: this.tenantId,
        OR: [{ sourceKey: baseKey }, { sourceKey: { startsWith: `${baseKey}:REPOST:` } }, { sourceKey: { startsWith: `${baseKey}:REPOST_REV:` } }],
      },
      select: {
        sourceKey: true,
        move: { select: { id: true, state: true, createdAt: true, reversedMoveId: true, reversal: { select: { id: true, createdAt: true } } } },
      },
    });
    const posts = rows
      .filter((r) => r.move.state === 'POSTED' && !r.move.reversedMoveId)
      .sort((a, b) => a.move.createdAt.getTime() - b.move.createdAt.getTime());
    const live = [...posts].reverse().find((r) => !r.move.reversal);
    if (live) return { liveMoveId: live.move.id, existingReversalMoveId: null };
    const reversed = posts.filter((r) => r.move.reversal).sort((a, b) => (a.move.reversal!.createdAt.getTime() - b.move.reversal!.createdAt.getTime()));
    const last = reversed[reversed.length - 1];
    return { liveMoveId: null, existingReversalMoveId: last?.move.reversal?.id ?? null };
  }

  async loadMoveLines(moveId: string): Promise<LiveMoveLine[]> {
    return this.tx.glMoveLine.findMany({
      where: { tenantId: this.tenantId, moveId },
      orderBy: { seq: 'asc' },
      select: {
        accountId: true, label: true, debitMilli: true, creditMilli: true, salesRepId: true, customerId: true,
        partnerName: true, analyticAccountId: true,
        adminUserId: true, // «ربط الدفاتر» L5: بُعد مستخدم الشركة على 111004 — عكس P7 وتوريد المستخدم من القيد الحيّ يحمله
      },
    });
  }

  async listSourceKeysUnder(baseKey: string): Promise<string[]> {
    const rows = await this.tx.glMoveSource.findMany({
      where: { tenantId: this.tenantId, sourceKey: { startsWith: baseKey } }, select: { sourceKey: true },
    });
    return rows.map((r) => r.sourceKey).filter((k) => k === baseKey || k.startsWith(`${baseKey}:`));
  }

  async loadContext(): Promise<LedgerContext> {
    return loadBuildContext(this.tx, this.tenantId);
  }

  /** بصمة الإعدادات التي يبني بها المُرحِّل ويحفظها المالك/الأدمن أثناء النبضة: D2 ومسارا الفواتير النقدية والسندات */
  async settingsVersion(): Promise<number | null> {
    const r = await this.tx.glSettings.findUnique({
      where: { tenantId: this.tenantId },
      select: { paylinkFeeTaxInvoiceFrom: true, cashInvoiceRouting: true, receiptRouting: true },
    });
    if (!r) return null;
    const text = JSON.stringify([r.paylinkFeeTaxInvoiceFrom ? r.paylinkFeeTaxInvoiceFrom.toISOString() : null, r.cashInvoiceRouting, r.receiptRouting ?? null]);
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return h;
  }

  async ensureAutoSaleTaxes(percents: readonly number[]): Promise<{ created: string[]; context: LedgerContext | null }> {
    const created: string[] = [];
    for (const pct of [...new Set(percents)].filter((p) => Number.isFinite(p) && p > 0)) {
      const key = autoSaleKey(pct);
      const existing = await this.tx.glTax.findUnique({ where: { tenantId_key: { tenantId: this.tenantId, key } }, select: { id: true } });
      if (existing) continue;
      await this.tx.glTax.create({
        data: {
          tenantId: this.tenantId, key, name: `ضريبة مبيعات آلية ${pct}٪`, use: 'SALE', rate: pct, vatCategory: 'S',
          priceInclude: false, accountId: null, vatBox: null, isActive: true, isSystem: true,
        },
      });
      created.push(key);
    }
    return { created, context: created.length ? await loadBuildContext(this.tx, this.tenantId) : null };
  }

  async postMove(draft: Parameters<PostingTx['postMove']>[0], opts: Parameters<PostingTx['postMove']>[1]) {
    return postMove(this.tx, draft, { ...opts, tenantId: this.tenantId });
  }

  /**
   * reverseMove القائم؛ وبوضع SYSTEM مع requestedDate (المُرحِّل): تاريخ العكس = max(تاريخ صف العكس، تاريخ الأصل)
   * لا «اليوم» (P4: التاريخ = entryDate لصف العكس)، ثم إزاحة الإقفال في postMove.
   */
  async reverseMove(opts: Parameters<PostingTx['reverseMove']>[0]): Promise<ReverseResult> {
    if (opts.mode !== 'SYSTEM' || !opts.requestedDate) return reverseMove(this.tx, { ...opts, tenantId: this.tenantId });
    const tenantId = this.tenantId;
    const reason = (opts.reason ?? '').trim();
    await acquirePostLock(this.tx, tenantId);
    const rec = await requireMoveRecord(this.tx, tenantId, opts.moveId);
    if (rec.reversal) {
      const existing = await this.tx.glMove.findFirst({ where: { id: rec.reversal.id, tenantId }, select: { number: true, date: true } });
      return {
        alreadyReversed: true,
        original: { id: rec.id, number: rec.number },
        reversal: { id: rec.reversal.id, number: existing?.number ?? rec.reversal.number, date: existing ? fromDbDate(existing.date) : null },
      };
    }
    if (rec.state !== 'POSTED' || rec.number === null || reason === '') return reverseMove(this.tx, { ...opts, tenantId });
    const context = await loadBuildContext(this.tx, tenantId);
    const date = maxLocalDate(opts.requestedDate, fromDbDate(rec.date));
    // «ربط الدفاتر» OD17 (عقد §4.3): للمربوطة وحدها سطور الضريبة/العلامة تُعلَّم vatAdjustment حين يقع العكس في فترة إقرار
    // غير فترة الأصل (بتاريخ ترحيله الفعلي بعد إزاحة الإقفال). linkedReversalVatPeriod يعيد undefined لغيرها ⇒ المسودة كما كانت
    const vatPeriod = linkedReversalVatPeriod(context.ctx);
    const draft = reversalDraftFromRecord(rec, {
      date, reason, originalNumber: rec.number, sourceKey: opts.sourceKey ?? null, sourceEvent: opts.sourceEvent ?? null,
      ...(vatPeriod ? { vatPeriod } : {}),
    });
    const posted = await postMove(this.tx, draft, {
      tenantId, actor: opts.actor, context, validationMode: 'SYSTEM', lockPolicy: 'SHIFT',
      reversedMoveId: rec.id, reversalReason: reason, auditAction: opts.auditAction ?? 'MOVE_REVERSE',
      auditSummary: `عكس القيد ${rec.number}: ${reason}`, auditExtra: { originalNumber: rec.number, originalDate: fromDbDate(rec.date) },
      now: opts.now,
    });
    return {
      alreadyReversed: false,
      original: { id: rec.id, number: rec.number },
      reversal: { id: posted.id, number: posted.number, date: posted.date, posted },
    };
  }

  async loadCustodyInputs(salesRepId: string): Promise<CustodyComponentsInput> {
    const s = await this.settings();
    const dec = s.decimals;
    const tenantId = this.tenantId;
    const routing = (s.routing && typeof s.routing === 'object' ? s.routing : null) as Parameters<typeof receiptCustodyClass>[0]['routing'];
    // «ربط الدفاتر» §5.6 (3): نافذة العهدة للمربوطة — ما قبل linkedFrom (وأُنشئ حتى T0) صيغةٌ مغلقة من مجاميع SQL، وعناصر
    // النافذة وحدها صفوفاً: O(النافذة) لكل استلام بدل التاريخ كله. null ⇒ تعذّرت الصيغة المغلقة فيُطوى التاريخ كله أدناه
    const link = this.linkCache ?? LINK_NONE;
    if (link.window) {
      const windowed = await this.loadLinkedCustodyInputs(salesRepId, link.window, dec, s.cashInvoiceRouting, routing ?? null);
      if (windowed) return windowed;
    }
    // البداية النظيفة (ملاحظة الخبير المحاسبي): عهدة المندوب في الدفاتر = ما أدخله المحاسب في القيد الافتتاحي + عمليات ما بعد
    // التفعيل وحدها. لا يُعاد تشغيل تاريخ التشغيل السابق للتفعيل (سندات واستلامات لم تدخل الدفاتر قط) — لا في قسمة التوريد
    // عند ترحيله، ولا في فحص C4، ولا في صفحة العهدة. المحمّل واحد للثلاثة فيبقون متّسقين.
    const since = s.cleanSince;
    const win = since ? { createdAt: { gt: since } } : {};

    const [receipts, invoices, settlements, settlementEvents, openingCustody] = await Promise.all([
      this.tx.receipt.findMany({
        where: { tenantId, salesRepId, ...win },
        select: { id: true, amount: true, paymentMethod: true, receiptDate: true, createdAt: true, cancelRefundFrom: true },
      }),
      this.tx.invoice.findMany({
        where: { tenantId, salesRepId, type: 'CASH', ...win },
        select: { id: true, total: true, invoiceDate: true, createdAt: true, cashCollectedByRep: true },
      }),
      this.tx.repSettlement.findMany({
        where: { tenantId, salesRepId, ...win },
        select: { id: true, amount: true, settledAt: true, createdAt: true },
      }),
      this.tx.glSourceEvent.findMany({
        where: { tenantId, sourceType: 'SETTLEMENT', payload: { path: ['salesRepId'], equals: salesRepId } },
        select: { sourceId: true, event: true, status: true, effectAt: true, payload: true, nonCustodyClearedMilli: true, shortageRecoveredMilli: true },
      }),
      // عهدة المندوب الافتتاحية كما أدخلها المحاسب (سطور 111003 بمندوبه في قيد OPENING)
      since
        ? this.tx.glMoveLine.aggregate({
          where: { tenantId, posted: true, salesRepId, account: { controlKind: 'CUSTODY' }, move: { moveType: 'OPENING', state: 'POSTED' } },
          _sum: { debitMilli: true, creditMilli: true },
        })
        : Promise.resolve(null),
    ]);

    // آثار الإلغاء من account_entries (الإلحاقية)
    const receiptIds = receipts.map((r) => r.id);
    const invoiceIds = invoices.map((i) => i.id);
    const entries = receiptIds.length || invoiceIds.length
      ? await this.tx.accountEntry.findMany({
        where: {
          tenantId,
          OR: [
            ...(receiptIds.length ? [{ receiptId: { in: receiptIds } }] : []),
            ...(invoiceIds.length ? [{ invoiceId: { in: invoiceIds }, receiptId: null }] : []),
          ],
        },
        select: { receiptId: true, invoiceId: true, type: true, entryDate: true, description: true },
      })
      : [];
    const receiptEffect = new Map<string, Date>();
    const receiptReversed = new Map<string, Date>();
    const invoiceReversed = new Map<string, Date>();
    // C17 (E5.13): إبطال ZATCA يحتفظ بالنقد (وسم CASH_VOID_KEEP_COLLECTION_NOTE على INVOICE_CREDIT بلا RECEIPT_DEBIT) لا يعكس
    // شقّ التحصيل — مرآة keepCashLeg في desired.ts حرفاً، وإلا رأت العهدة الفاتورة معكوسة والقيد أبقى 111003 فاحمرّ C4
    const keepCashVoid = new Set<string>();
    const cashLegReversed = new Set<string>();
    for (const e of entries) {
      if (e.receiptId && e.type === 'RECEIPT_CREDIT') receiptEffect.set(e.receiptId, e.entryDate);
      if (e.receiptId && e.type === 'RECEIPT_DEBIT') receiptReversed.set(e.receiptId, e.entryDate);
      if (!e.receiptId && e.invoiceId && e.type === 'INVOICE_CREDIT') invoiceReversed.set(e.invoiceId, e.entryDate);
      if (!e.receiptId && e.invoiceId && e.type === 'INVOICE_CREDIT' && e.description === CASH_VOID_KEEP_COLLECTION_NOTE) keepCashVoid.add(e.invoiceId);
      if (!e.receiptId && e.invoiceId && e.type === 'RECEIPT_DEBIT') cashLegReversed.add(e.invoiceId);
    }
    for (const id of keepCashVoid) if (!cashLegReversed.has(id)) invoiceReversed.delete(id);

    const out: CustodyComponentsInput = {
      receipts: [], onlineReceipts: [], outsideReceipts: [], cashInvoices: [], settlements: [], shortages: [], custodyExpenses: [],
      routing: { cashInvoice: s.cashInvoiceRouting === 'CUSTODY' ? 'CUSTODY' : 'MAIN_CASH', receipt: routing ?? null },
    };
    // OD2/D5: في المربوطة يوجّه ختمُ الفاتورة النقدية نقدَها إلى 111003 أياً كان cashInvoiceRouting (custody.ts)
    if (link.linked) out.routing = { ...out.routing, stampDrivesCustody: true };
    if (openingCustody) {
      const opening = (openingCustody._sum.debitMilli ?? 0n) - (openingCustody._sum.creditMilli ?? 0n);
      // العهدة الافتتاحية نقدٌ بيد المندوب ينتظر التوريد: تدخل رصيد الدفاتر والمعلّق معاً فيغطّيها أول توريد (والمعلّق التشغيلي لـC4b
      // وصفحة العهدة يضيف الافتتاحي نفسه في loadRepCustodyFacts)
      if (opening !== 0n) out.opening = { [salesRepId]: { ledgerCustodyMilli: opening, activeReceiptsMilli: opening } };
    }
    for (const r of receipts) {
      const item: CustodyItem = {
        id: r.id, salesRepId, amountMilli: toMilli(r.amount, dec), effectAt: receiptEffect.get(r.id) ?? r.receiptDate,
        createdAt: r.createdAt, reversedAt: receiptReversed.get(r.id) ?? null,
      };
      const cls = custodyClassOf(r.paymentMethod, salesRepId, routing ?? null, link.linked);
      // C11: عكسٌ رُدّ ماله من خارج عهدة المندوب — للمربوطة وحدها (الـbuilder لا يبني الردّ من خارجها إلا لها)
      if (link.linked && cls === 'CUSTODY' && item.reversedAt != null && cancelRefundOutsideCustody(r.cancelRefundFrom)) item.reversalOutsideCustody = true;
      ((cls === 'CUSTODY' ? out.receipts : cls === 'ONLINE' ? out.onlineReceipts : out.outsideReceipts) as CustodyItem[]).push(item);
    }
    for (const i of invoices) {
      (out.cashInvoices as CustodyItem[]).push({
        id: i.id, salesRepId, amountMilli: toMilli(i.total, dec), effectAt: i.invoiceDate, createdAt: i.createdAt,
        reversedAt: invoiceReversed.get(i.id) ?? null,
        // OD2: الختم يُعدّ تحصيلاً في الشاشة (REP_COLLECTED_CASH_SALE) — وفي المربوطة يوجّه نقده إلى العهدة (stampDrivesCustody)
        ...(i.cashCollectedByRep ? { stamped: true } : {}),
      });
    }

    const stored = new Map<string, { nonCustody: bigint | null; recovered: bigint | null }>();
    const reversedAt = new Map<string, Date>();
    const tombstones = new Map<string, { amount: string; settledAt: string; createdAt: string | null }>();
    for (const e of settlementEvents) {
      if (e.event === 'POST' && (e.status === 'DONE' || e.status === 'SKIPPED') && e.nonCustodyClearedMilli !== null) {
        stored.set(e.sourceId, { nonCustody: e.nonCustodyClearedMilli, recovered: e.shortageRecoveredMilli });
      }
      if (e.event === 'REVERSE') reversedAt.set(e.sourceId, e.effectAt);
      const p = (e.payload ?? null) as { amount?: unknown; settledAt?: unknown; createdAt?: unknown } | null;
      if (p && typeof p.settledAt === 'string' && p.amount !== undefined && !tombstones.has(e.sourceId)) {
        tombstones.set(e.sourceId, { amount: String(p.amount), settledAt: p.settledAt, createdAt: typeof p.createdAt === 'string' ? p.createdAt : null });
      }
    }
    const live = new Set<string>();
    for (const st of settlements) {
      live.add(st.id);
      const v = stored.get(st.id);
      (out.settlements as CustodySettlementItem[]).push({
        id: st.id, salesRepId, amountMilli: toMilli(st.amount, dec), effectAt: st.settledAt, createdAt: st.createdAt,
        reversedAt: reversedAt.get(st.id) ?? null, nonCustodyClearedMilli: v?.nonCustody ?? null, shortageRecoveredMilli: v?.recovered ?? null,
      });
    }
    // استلامات محذوفة: من حمولة الـtombstone، معكوسة بتاريخ حدث REVERSE
    for (const [id, t] of tombstones) {
      if (live.has(id)) continue;
      // البداية النظيفة: استلامٌ محذوف أُنشئ حتى T0 (أو مجهول الإنشاء) لم يدخل الدفاتر
      if (since && (!t.createdAt || new Date(t.createdAt).getTime() <= since.getTime())) continue;
      const v = stored.get(id);
      (out.settlements as CustodySettlementItem[]).push({
        id, salesRepId, amountMilli: toMilli(t.amount, dec), effectAt: t.settledAt, createdAt: t.createdAt,
        reversedAt: reversedAt.get(id) ?? null, nonCustodyClearedMilli: v?.nonCustody ?? null, shortageRecoveredMilli: v?.recovered ?? null,
      });
    }
    return out;
  }

  async resolveOrigin(event: Pick<SourceEventRecord, 'sourceType' | 'sourceId' | 'event' | 'payload'>): Promise<OriginFacts | null> {
    // «ربط الدفاتر» C13/C14: توريد عهدة المستخدم مصدرُ tombstone كالاستلام — الأصل من حمولته (settledAt/createdAt) ووجود صفّه
    if (event.sourceType === 'USER_SETTLEMENT') {
      const fromPayload = tombstoneOrigin('USER_SETTLEMENT', event.payload);
      if (!fromPayload) return null;
      const exists = !!(await this.tx.userSettlement.findFirst({ where: { id: event.sourceId, tenantId: this.tenantId }, select: { id: true } }));
      return { ...fromPayload, sourceExists: exists };
    }
    if (event.sourceType === 'SETTLEMENT' || event.sourceType === 'AR_ENTRY') {
      const fromPayload = tombstoneOrigin(event.sourceType, event.payload);
      if (fromPayload) {
        const exists = event.sourceType === 'SETTLEMENT'
          ? !!(await this.tx.repSettlement.findFirst({ where: { id: event.sourceId, tenantId: this.tenantId, ...SETTLEMENT_HAS_REP }, select: { id: true } }))
          : !!(await this.tx.accountEntry.findFirst({ where: { id: event.sourceId, tenantId: this.tenantId }, select: { id: true } }));
        return { ...fromPayload, sourceExists: exists };
      }
      return null;
    }
    if (event.sourceType === 'INVOICE' || event.sourceType === 'RECEIPT') {
      const where = event.sourceType === 'INVOICE'
        ? { tenantId: this.tenantId, invoiceId: event.sourceId, receiptId: null }
        : { tenantId: this.tenantId, receiptId: event.sourceId };
      const first = await this.tx.accountEntry.findFirst({
        where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { entryDate: true, createdAt: true },
      });
      if (!first) return null;
      const s = await this.settings();
      return { originEffectAt: first.entryDate, originEffectDate: localDate(first.entryDate, s.timezone), originCreatedAt: first.createdAt, sourceExists: true };
    }
    return null;
  }

  async loadSourceData(sourceType: SourceType, sourceId: string, event: SourceEvent): Promise<SourceData> {
    const tenantId = this.tenantId;
    const s = await this.settings();
    const tz = s.timezone;
    const dec = s.decimals;
    const str = (v: number | null | undefined): string | null => (v === null || v === undefined ? null : String(v));
    // «ربط الدفاتر» (D1، عقد §5.6 البند 1): المربوطة تبني حمولتها بدوال A1 نفسها وحقائق facts.prisma التي يكتب بها المُطابِق
    // (مصدر واحد للحمولة، ومعها حقول L4/L5)، والمصدران الجديدان لها وحدها. غيرها يكمل أدناه حرفاً كما كان.
    const linkedData = await this.loadLinkedSourceData(sourceType, sourceId, event);
    if (linkedData) return linkedData;

    switch (sourceType) {
      case 'INVOICE': {
        const inv = await this.tx.invoice.findFirst({
          where: { id: sourceId, tenantId },
          select: {
            id: true, number: true, type: true, customerId: true, salesRepId: true, pricesIncludeTax: true, subtotal: true,
            discountAmt: true, taxAmt: true, total: true, dueDate: true,
            // «إزالة الضريبة»: الختم يصل الحمولة (invoicePayloadFromRows يضعه حين true وحده) فقيد المختومة بلا علامة ولا مفتاح ضريبة
            taxFree: true,
            customer: { select: { name: true } }, salesRep: { select: { name: true } },
            items: { select: { productId: true, qty: true, unitPrice: true, taxPct: true, taxAmt: true, lineTotal: true, vatCategory: true, product: { select: { categoryId: true } } } },
          },
        });
        if (!inv) return { kind: 'MISSING' };
        const rows = await this.tx.accountEntry.findMany({
          where: { tenantId, invoiceId: sourceId, receiptId: null }, select: { type: true, entryDate: true, createdAt: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        const postType = inv.type === 'RETURN' ? 'INVOICE_CREDIT' : 'INVOICE_DEBIT';
        const revType = inv.type === 'RETURN' ? 'INVOICE_DEBIT' : 'INVOICE_CREDIT';
        const wanted = rows.filter((r) => r.type === (event === 'REVERSE' ? revType : postType));
        if (event === 'REVERSE') {
          const row = wanted[wanted.length - 1];
          if (!row) return { kind: 'MISSING' };
          return { kind: 'FOUND', createdAt: row.createdAt, payload: { invoiceId: inv.id, type: inv.type, entryDate: localDate(row.entryDate, tz), sourceCreatedAt: iso(row.createdAt) } };
        }
        const primary = wanted[0] ?? rows[0];
        if (!primary) return { kind: 'MISSING' };
        const payload = invoicePayloadFromRows({
          invoice: { ...inv, pricesIncludeTax: inv.pricesIncludeTax },
          items: inv.items.map((it) => ({
            productId: it.productId, categoryId: it.product?.categoryId ?? null, qty: it.qty, unitPrice: it.unitPrice,
            taxPct: it.taxPct, taxAmt: it.taxAmt, lineTotal: it.lineTotal,
            vatCategory: (it.vatCategory && ['S', 'Z', 'E', 'O'].includes(it.vatCategory) ? it.vatCategory : null) as VatCategory | null,
          })),
          customerName: inv.customer?.name ?? null,
          salesRepName: inv.salesRep?.name ?? null,
          entryDate: localDate(primary.entryDate, tz),
          dueDate: inv.dueDate ? localDate(inv.dueDate, tz) : null,
          currency: s.currency,
          currencyDecimals: dec,
        });
        const createdAt = wanted.length ? wanted[wanted.length - 1].createdAt : primary.createdAt;
        return { kind: 'FOUND', createdAt, payload: { ...payload, sourceCreatedAt: iso(createdAt) } };
      }
      case 'RECEIPT': {
        const rc = await this.tx.receipt.findFirst({
          where: { id: sourceId, tenantId },
          select: {
            id: true, number: true, customerId: true, salesRepId: true, amount: true, paymentMethod: true,
            customer: { select: { name: true } }, salesRep: { select: { name: true } },
          },
        });
        if (!rc) return { kind: 'MISSING' };
        const row = await this.tx.accountEntry.findFirst({
          where: { tenantId, receiptId: sourceId, type: event === 'REVERSE' ? 'RECEIPT_DEBIT' : 'RECEIPT_CREDIT' },
          orderBy: [{ createdAt: event === 'REVERSE' ? 'desc' : 'asc' }], select: { entryDate: true, createdAt: true },
        });
        if (!row) return { kind: 'MISSING' };
        const link = await this.tx.customerPaymentLink.findFirst({ where: { tenantId, receiptId: sourceId }, select: { id: true } });
        if (event === 'REVERSE') {
          const refund = link
            ? await this.tx.settlementEntry.findFirst({ where: { tenantId, kind: 'REFUND', linkId: link.id }, orderBy: { createdAt: 'desc' }, select: { id: true, amount: true } })
            : null;
          return {
            kind: 'FOUND', createdAt: row.createdAt,
            payload: {
              receiptId: rc.id, entryDate: localDate(row.entryDate, tz), paymentMethod: rc.paymentMethod,
              paylinkId: link?.id ?? null, refundEntryId: refund?.id ?? null, refundedAmount: str(refund?.amount), sourceCreatedAt: iso(row.createdAt),
            },
          };
        }
        return {
          kind: 'FOUND', createdAt: row.createdAt,
          payload: {
            receiptId: rc.id, number: rc.number, entryDate: localDate(row.entryDate, tz), salesRepId: rc.salesRepId ?? null,
            paymentMethod: rc.paymentMethod, amount: toMilliText(rc.amount, dec), customerId: rc.customerId,
            paylinkId: rc.paymentMethod === 'ONLINE' ? (link?.id ?? null) : null,
            customerName: rc.customer?.name ?? null, salesRepName: rc.salesRep?.name ?? null, sourceCreatedAt: iso(row.createdAt),
          },
        };
      }
      case 'SETTLEMENT': {
        const st = await this.tx.repSettlement.findFirst({
          where: { id: sourceId, tenantId, ...SETTLEMENT_HAS_REP },
          select: { id: true, amount: true, method: true, salesRepId: true, settledAt: true, createdAt: true, note: true, salesRep: { select: { name: true } } },
        });
        if (!st) return { kind: 'MISSING' };
        return {
          kind: 'FOUND', createdAt: st.createdAt,
          payload: {
            settlementId: st.id, amount: toMilliText(st.amount, dec), method: st.method, salesRepId: st.salesRepId,
            settledAt: st.settledAt.toISOString(), createdAt: st.createdAt.toISOString(), note: st.note ?? null, salesRepName: st.salesRep?.name ?? null,
          },
        };
      }
      case 'AR_ENTRY':
      case 'CUSTOMER_ADJUSTMENT': {
        const e = await this.tx.accountEntry.findFirst({
          where: { id: sourceId, tenantId },
          select: { id: true, customerId: true, debit: true, credit: true, description: true, entryDate: true, createdAt: true, customer: { select: { name: true } } },
        });
        if (!e) return { kind: 'MISSING' };
        return {
          kind: 'FOUND', createdAt: e.createdAt,
          payload: {
            entryId: e.id, customerId: e.customerId, customerName: e.customer?.name ?? null, debit: toMilliText(e.debit, dec),
            credit: toMilliText(e.credit, dec), description: e.description, entryDate: e.entryDate.toISOString(), createdAt: e.createdAt.toISOString(),
            origin: 'IMPORT',
          },
        };
      }
      case 'PAYLINK_FEE': {
        const e = await this.tx.settlementEntry.findFirst({
          where: { id: sourceId, tenantId, kind: 'FEE' },
          select: { id: true, amount: true, feeNet: true, feeVat: true, linkId: true, note: true, createdAt: true },
        });
        if (!e) return { kind: 'MISSING' };
        return {
          kind: 'FOUND', createdAt: e.createdAt,
          payload: {
            entryId: e.id, amount: toMilliText(e.amount, dec), feeNet: e.feeNet === null ? null : toMilliText(e.feeNet, dec),
            feeVat: e.feeVat === null ? null : toMilliText(e.feeVat, dec), linkId: e.linkId, note: e.note, createdAt: e.createdAt.toISOString(),
          },
        };
      }
      case 'PAYOUT': {
        const e = await this.tx.settlementEntry.findFirst({
          where: { tenantId, kind: 'PAYOUT', payoutId: sourceId },
          select: { amount: true, note: true, createdAt: true, payout: { select: { bankReference: true } } },
        });
        if (!e) return { kind: 'MISSING' };
        return {
          kind: 'FOUND', createdAt: e.createdAt,
          payload: {
            payoutId: sourceId, amount: toMilliText(e.amount, dec), bankReference: e.payout?.bankReference ?? null, note: e.note,
            createdAt: e.createdAt.toISOString(),
          },
        };
      }
      default:
        return { kind: 'MISSING' };
    }
  }

  async listRepReceiptEvents(salesRepId: string, upTo: Date): Promise<{ status: EventStatus; effectAt: Date }[]> {
    const rows = await this.tx.glSourceEvent.findMany({
      where: {
        tenantId: this.tenantId, sourceType: 'RECEIPT', status: { in: ['PENDING', 'BLOCKED'] }, effectAt: { lte: upTo },
        payload: { path: ['salesRepId'], equals: salesRepId },
      },
      select: { status: true, effectAt: true },
    });
    return rows.map((r) => ({ status: r.status as EventStatus, effectAt: r.effectAt }));
  }

  async dbNow(): Promise<Date> {
    return dbNowOf(this.tx);
  }

  // ═══ «ربط الدفاتر» L4+L5+L8 (عقد §3.6، §5.6) — لا يستدعيها المُرحِّل إلا لأحداث المربوطة ═══

  /** إعدادات الربط من قراءة settings() نفسها */
  private async linkSettings(): Promise<LinkedStoreSettings> {
    await this.settings();
    return this.linkCache ?? LINK_NONE;
  }

  /** D6: مدخلات طيّ عهدة المستخدم (loadUserCustodyInputsMany بمستخدم واحد — خمس قراءات بلا N+1) */
  async loadUserCustodyInputs(userId: string): Promise<UserCustodyInputs> {
    const s = await this.settings();
    const m = await loadUserCustodyInputsMany(this.tx, this.tenantId, s.decimals, [userId]);
    return m.get(userId) ?? emptyUserCustodyInputs(userId);
  }

  /** ترتيب USER_SETTLEMENT: أحداث SETTLEMENT غير النهائية لاستلاماتٍ بيد المستخدم (حمولة المربوطة تحمل receivedByUserId) */
  async listUserFeedEvents(userId: string, upTo: Date): Promise<{ status: EventStatus; effectAt: Date }[]> {
    const rows = await this.tx.glSourceEvent.findMany({
      where: {
        tenantId: this.tenantId, sourceType: 'SETTLEMENT', status: { in: ['PENDING', 'BLOCKED'] }, effectAt: { lte: upTo },
        payload: { path: ['receivedByUserId'], equals: userId },
      },
      select: { status: true, effectAt: true },
    });
    return rows.map((r) => ({ status: r.status as EventStatus, effectAt: r.effectAt }));
  }

  /** حالة RECEIPT:<id>:REVERSE وحمولته (C9) — حدثٌ بلا حمولة (أدرجته بوابة الأشقاء) ⇒ الحقلان من المستند نفسه */
  async getReceiptReverse(receiptId: string): Promise<{ status: EventStatus; refundEntryId: string | null; cancelRefundFrom: string | null } | null> {
    const ev = await this.tx.glSourceEvent.findUnique({
      where: { tenantId_sourceKey: { tenantId: this.tenantId, sourceKey: receiptKey(receiptId, 'REVERSE') } },
      select: { status: true, payload: true },
    });
    if (!ev) return null;
    let p = payloadRecord(ev.payload);
    if (!p) {
      const data = await this.loadSourceData('RECEIPT', receiptId, 'REVERSE');
      p = data.kind === 'FOUND' ? payloadRecord(data.payload) : null;
    }
    return { status: ev.status as EventStatus, refundEntryId: textOrNull(p?.refundEntryId), cancelRefundFrom: textOrNull(p?.cancelRefundFrom) };
  }

  /**
   * D2: حسابات المربوطة 111004/112007/214002 الناقصة تُنشأ متساوية الأثر داخل المعاملة ويُعاد السياق إن أُنشئ شيء. لغير
   * المربوطة لا كتابة ولا قراءة زائدة (حارس دفاعي فوق حارس المُرحِّل: شجرة اليدوية والقديمة لا تتغيّر حساباً واحداً).
   */
  async ensureLinkedAccounts(): Promise<{ created: string[]; context: LedgerContext | null }> {
    const link = await this.linkSettings();
    if (!link.linked) return { created: [], context: null };
    const r = await ensureLinkedAccountRows(this.tx, this.tenantId);
    return { created: r.created, context: r.created.length ? await loadBuildContext(this.tx, this.tenantId) : null };
  }

  /** L8: مخزن المطابقة الجزئية على المعاملة نفسها (services/gl/reconcile، A10) */
  reconcileStore(): ReconcileStore {
    return createPrismaReconcileStore(this.tx, this.tenantId);
  }

  /**
   * حمولة المربوطة لمصادرها (§5.6 البند 1) — null لغير المربوطة أو لمصدرٍ يبقى مساره القائم (AR_ENTRY وPAYLINK_FEE وPAYOUT).
   * المصدران الجديدان (USER_SETTLEMENT وPAYLINK_REFUND) لا يشتقّهما المُطابِق إلا للمربوطة ⇒ MISSING لغيرها.
   */
  private async loadLinkedSourceData(sourceType: SourceType, sourceId: string, event: SourceEvent): Promise<SourceData | null> {
    if (!LINKED_PAYLOAD_SOURCES.has(sourceType)) return null;
    const link = await this.linkSettings();
    if (!link.linked) return sourceType === 'USER_SETTLEMENT' || sourceType === 'PAYLINK_REFUND' ? { kind: 'MISSING' } : null;
    const s = await this.settings();
    const tenantId = this.tenantId;
    const dec = s.decimals;
    const ctx: DeriveContext = { timezone: s.timezone, currency: s.currency, currencyDecimals: dec, linked: true };

    switch (sourceType) {
      case 'INVOICE': {
        const facts = (await loadInvoiceFacts(this.tx, tenantId, [sourceId], { linked: true })).get(sourceId);
        const plan = facts ? INVOICE_ROW_PLAN[facts.type] : undefined;
        if (!facts || !plan) return { kind: 'MISSING' };
        const rows = await this.tx.accountEntry.findMany({
          where: { tenantId, invoiceId: sourceId, receiptId: null },
          select: { type: true, entryDate: true, createdAt: true, description: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        return linkedInvoiceSourceData(facts, plan, rows, event, ctx);
      }
      case 'RECEIPT': {
        const facts = (await loadReceiptFacts(this.tx, tenantId, [sourceId], { linked: true })).get(sourceId);
        if (!facts) return { kind: 'MISSING' };
        const rows = await this.tx.accountEntry.findMany({
          where: { tenantId, receiptId: sourceId, type: event === 'REVERSE' ? 'RECEIPT_DEBIT' : 'RECEIPT_CREDIT' },
          select: { entryDate: true, createdAt: true },
        });
        if (rows.length === 0) return { kind: 'MISSING' };
        // مرآة المُطابِق: الأثر أصغر entryDate لصفوف المفتاح، والإنشاء أكبر createdAt
        const effectAt = minDateOf(rows.map((r) => r.entryDate));
        const createdAt = maxDateOf(rows.map((r) => r.createdAt));
        const entryDate = localDate(effectAt, s.timezone);
        const payload = event === 'REVERSE'
          ? receiptReverseEventPayload(facts, entryDate, ctx, iso(createdAt))
          : receiptPostEventPayload(facts, entryDate, ctx, iso(createdAt));
        return { kind: 'FOUND', createdAt, payload };
      }
      case 'SETTLEMENT': {
        const st = await this.tx.repSettlement.findFirst({
          where: { id: sourceId, tenantId, ...SETTLEMENT_HAS_REP },
          select: {
            id: true, salesRepId: true, amount: true, method: true, note: true, settledAt: true, createdAt: true, receivedByUserId: true,
            salesRep: { select: { name: true } },
          },
        });
        if (!st || !st.salesRepId) return { kind: 'MISSING' };
        const receivedByName = st.receivedByUserId ? (await loadAdminNames(this.tx, tenantId, [st.receivedByUserId])).get(st.receivedByUserId) ?? null : null;
        const row: RepSettlementSourceRow = {
          id: st.id, salesRepId: st.salesRepId, amount: st.amount, method: st.method, note: st.note ?? null,
          settledAt: st.settledAt, createdAt: st.createdAt, receivedByUserId: st.receivedByUserId ?? null,
        };
        return { kind: 'FOUND', createdAt: st.createdAt, payload: settlementPayload(row, st.salesRep?.name ?? null, dec, { linked: true, receivedByName }) };
      }
      case 'USER_SETTLEMENT': {
        const us = await this.tx.userSettlement.findFirst({
          where: { id: sourceId, tenantId },
          select: { id: true, fromUserId: true, amount: true, method: true, note: true, receivedBy: true, receivedByUserId: true, settledAt: true, createdAt: true },
        });
        if (!us) return { kind: 'MISSING' };
        const name = (await loadAdminNames(this.tx, tenantId, [us.fromUserId])).get(us.fromUserId) ?? null;
        return { kind: 'FOUND', createdAt: us.createdAt, payload: userSettlementPayload(us, name, dec) };
      }
      case 'PAYLINK_REFUND': {
        const e = await this.tx.settlementEntry.findFirst({
          where: { id: sourceId, tenantId, kind: 'REFUND' },
          select: { id: true, kind: true, amount: true, feeNet: true, feeVat: true, linkId: true, payoutId: true, note: true, createdAt: true },
        });
        if (!e) return { kind: 'MISSING' };
        const refundLink = e.linkId ? (await loadRefundLinks(this.tx, tenantId, [e.linkId])).get(e.linkId) ?? null : null;
        return { kind: 'FOUND', createdAt: e.createdAt, payload: paylinkRefundPayload(e, refundLink, dec) };
      }
      default:
        return null;
    }
  }

  /**
   * §5.6 البند 3 — نافذة العهدة للمربوطة: صفوف عناصر النافذة (وما قبلها عُكس داخلها) ومجاميع ما قبلها بتقريب كل مستند
   * نصف-لأعلى في SQL، ثم linkedCustodyInputs الصرفة. التصنيف بصفوف account_entries نفسها التي يصنّف بها المُطابِق أحداثه
   * (أصغر entryDate وأكبر createdAt للمفتاح) ⇒ حدّ النافذة هنا هو حدّ classifyCutover حرفاً. null ⇒ يُطوى التاريخ كله.
   */
  private async loadLinkedCustodyInputs(
    salesRepId: string, w: CustodyWindow, dec: number, cashInvoiceRouting: string, routing: ReceiptRouting | null,
  ): Promise<CustodyComponentsInput | null> {
    const tenantId = this.tenantId;
    const [receiptRows, invoiceRows, windowSettlements, settledBefore, reverseEvents, openingCustody] = await Promise.all([
      this.tx.$queryRaw<LinkedReceiptSqlRow[]>(linkedCustodyReceiptsSql(tenantId, salesRepId, w, dec)),
      this.tx.$queryRaw<LinkedInvoiceSqlRow[]>(linkedCustodyInvoicesSql(tenantId, salesRepId, w, dec)),
      this.tx.repSettlement.findMany({
        where: { tenantId, salesRepId, OR: [{ settledAt: { gte: w.start } }, { createdAt: { gt: w.snapshotAt } }] },
        select: { id: true, amount: true, settledAt: true, createdAt: true },
      }),
      this.tx.$queryRaw<{ total: string | null }[]>`
        SELECT COALESCE(SUM(ROUND(s."amount"::numeric, ${dec}::int)), 0)::text AS "total"
        FROM "rep_settlements" s
        WHERE s."tenantId" = ${tenantId} AND s."salesRepId" = ${salesRepId} AND s."settledAt" < ${w.start} AND s."createdAt" <= ${w.snapshotAt}`,
      // استلامات المندوب المحذوفة: حمولة الـtombstone (حدث REVERSE يحمل حمولة POST نفسها) ولحظة الحذف
      this.tx.glSourceEvent.findMany({
        where: { tenantId, sourceType: 'SETTLEMENT', event: 'REVERSE', payload: { path: ['salesRepId'], equals: salesRepId } },
        select: { sourceId: true, effectAt: true, detectedAt: true, payload: true },
      }),
      // العهدة الافتتاحية (المشتقّة عند الاعتماد L7): سطور 111003 للمندوب في قيد OPENING
      this.tx.glMoveLine.aggregate({
        where: { tenantId, posted: true, salesRepId, account: { controlKind: 'CUSTODY' }, move: { moveType: 'OPENING', state: 'POSTED' } },
        _sum: { debitMilli: true, creditMilli: true },
      }),
    ]);

    const settlements: LinkedCustodySettlementRow[] = [];
    const live = new Set(windowSettlements.map((st) => st.id));
    for (const st of windowSettlements) {
      settlements.push({ id: st.id, salesRepId, amountMilli: toMilli(st.amount, dec), effectAt: st.settledAt, createdAt: st.createdAt, reversedAt: null, inWindow: true });
    }
    for (const ev of reverseEvents) {
      if (live.has(ev.sourceId)) continue;
      const p = payloadRecord(ev.payload);
      const settledAt = textOrNull(p?.settledAt);
      if (!p || !settledAt || p.amount === undefined || p.amount === null) continue;
      const createdAt = textOrNull(p.createdAt) ?? settledAt;
      const inWindow = inCustodyWindow(settledAt, createdAt, w);
      // عكس tombstone: أثره لحظة الحذف وكشفه (مرآة selfRow في poster.ts)
      const revCreated = ev.detectedAt.getTime() > ev.effectAt.getTime() ? ev.detectedAt : ev.effectAt;
      if (!inWindow && !inCustodyWindow(ev.effectAt, revCreated, w)) continue; // قبل النافذة أُثبت وحُذف: صافيه صفر
      settlements.push({
        id: ev.sourceId, salesRepId, amountMilli: toMilli(String(p.amount), dec), effectAt: settledAt, createdAt, reversedAt: ev.effectAt, inWindow,
      });
    }
    // التقسيم المخزَّن على أحداث POST (المرحَّلة، والمجمَّد عند الاعتماد لما قبل النافذة)
    const keys = settlements.map((st) => settlementKey(st.id, 'POST'));
    for (let i = 0; i < keys.length; i += 1000) {
      const stored = await this.tx.glSourceEvent.findMany({
        where: { tenantId, sourceKey: { in: keys.slice(i, i + 1000) } },
        select: { sourceId: true, status: true, nonCustodyClearedMilli: true, shortageRecoveredMilli: true },
      });
      const byId = new Map(stored.map((e) => [e.sourceId, e]));
      for (const st of settlements) {
        const e = byId.get(st.id);
        if (e && (e.status === 'DONE' || e.status === 'SKIPPED') && e.nonCustodyClearedMilli !== null) {
          st.nonCustodyClearedMilli = e.nonCustodyClearedMilli;
          st.shortageRecoveredMilli = e.shortageRecoveredMilli;
        }
      }
    }

    const facts = linkedCustodyFactsFromSql({
      salesRepId, dec, receiptRows, invoiceRows, settlements,
      settledBeforeMilli: toMilli(settledBefore[0]?.total ?? '0', dec),
      openingLedgerMilli: (openingCustody._sum.debitMilli ?? 0n) - (openingCustody._sum.creditMilli ?? 0n),
      routing: { cashInvoice: cashInvoiceRouting === 'CUSTODY' ? 'CUSTODY' : 'MAIN_CASH', receipt: routing, stampDrivesCustody: true },
    });
    return linkedCustodyInputs(facts);
  }
}

/** مبلغ Float مخزّن ⇒ نص بمنازل العملة (عبر الملّي) */
function toMilliText(v: number, decimals: number): string {
  return formatMilli(toMilli(v, decimals), decimals);
}

// ═══ «ربط الدفاتر» L4+L5 (عقد §5.6) — مساعدات صرفة ومحمّلات مجمّعة ═══

const payloadRecord = (v: unknown): Record<string, unknown> | null =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const minDateOf = (ds: readonly Date[]): Date => ds.reduce((m, d) => (d.getTime() < m.getTime() ? d : m), ds[0]);
const maxDateOf = (ds: readonly Date[]): Date => ds.reduce((m, d) => (d.getTime() > m.getTime() ? d : m), ds[0]);

/** المصادر التي تُبنى حمولتها للمربوطة بدوال A1 (desired.ts) — والباقية بمسارها القائم */
const LINKED_PAYLOAD_SOURCES: ReadonlySet<string> = new Set(['INVOICE', 'RECEIPT', 'SETTLEMENT', 'USER_SETTLEMENT', 'PAYLINK_REFUND']);

/** صفوف كل مفتاح للفاتورة والصف الأساسي — مرآة POSTING_TYPES_BY_INVOICE في desired.ts (لا يصدّرها) */
export interface InvoiceRowPlan { post: readonly string[]; reverse: readonly string[]; primaryPost: string; primaryReverse: string }
const INVOICE_ROW_PLAN: Readonly<Record<string, InvoiceRowPlan>> = {
  CASH: { post: ['INVOICE_DEBIT', 'RECEIPT_CREDIT'], reverse: ['INVOICE_CREDIT', 'RECEIPT_DEBIT'], primaryPost: 'INVOICE_DEBIT', primaryReverse: 'INVOICE_CREDIT' },
  CREDIT: { post: ['INVOICE_DEBIT'], reverse: ['INVOICE_CREDIT'], primaryPost: 'INVOICE_DEBIT', primaryReverse: 'INVOICE_CREDIT' },
  RETURN: { post: ['INVOICE_CREDIT'], reverse: ['INVOICE_DEBIT'], primaryPost: 'INVOICE_CREDIT', primaryReverse: 'INVOICE_DEBIT' },
};

/**
 * حمولة الفاتورة للمربوطة من صفوف account_entries — مرآة المُطابِق: الأثر أصغر entryDate للصفوف الأساسية، والإنشاء أكبر
 * createdAt لصفوف المفتاح، والعكس النقدي يحمل keepCashLeg بالقاعدة نفسها (Q1). صرفة (يختبرها l458-a07).
 */
export function linkedInvoiceSourceData(
  facts: InvoiceFacts, plan: InvoiceRowPlan,
  rows: readonly { type: string; entryDate: Date; createdAt: Date; description: string | null }[],
  event: SourceEvent, ctx: DeriveContext,
): SourceData {
  const wanted = event === 'REVERSE' ? plan.reverse : plan.post;
  let group = rows.filter((r) => wanted.includes(r.type));
  // POST أدرجته بوابة الأشقاء قبل صفّه الأساسي: أيّ صف للمستند كما في المسار القائم (wanted[0] ?? rows[0])
  if (group.length === 0 && event !== 'REVERSE') group = [...rows];
  if (group.length === 0) return { kind: 'MISSING' };
  const primaryType = event === 'REVERSE' ? plan.primaryReverse : plan.primaryPost;
  const primary = group.filter((r) => r.type === primaryType);
  const effectAt = minDateOf((primary.length > 0 ? primary : group).map((r) => r.entryDate));
  const createdAt = maxDateOf(group.map((r) => r.createdAt));
  const entryDate = localDate(effectAt, ctx.timezone);
  if (event === 'REVERSE') {
    const keepCashLeg = facts.type === 'CASH'
      && group.some((r) => r.type === 'INVOICE_CREDIT' && r.description === CASH_VOID_KEEP_COLLECTION_NOTE)
      && !group.some((r) => r.type === 'RECEIPT_DEBIT');
    return {
      kind: 'FOUND', createdAt,
      payload: { invoiceId: facts.id, type: facts.type, entryDate, sourceCreatedAt: iso(createdAt), ...(keepCashLeg ? { keepCashLeg: true } : {}) },
    };
  }
  return { kind: 'FOUND', createdAt, payload: invoicePostEventPayload(facts, entryDate, ctx, iso(createdAt)) };
}

// ── نافذة عهدة المندوب للمربوطة (§5.6 البند 3) ──

/** نافذة الإعادة: [بداية يوم linkedFrom بتوقيت الشركة، …) أو ما أُنشئ بعد T0 (linkSnapshotAt) */
export interface CustodyWindow {
  start: Date;
  snapshotAt: Date;
}

/** وضع الدفاتر ونافذة العهدة كما يقرؤهما مخزن الترحيل */
export interface LinkedStoreSettings {
  linked: boolean;
  /** null للمربوطة بلا linkedFrom/linkSnapshotAt (قبل اعتماد L7) ⇒ التاريخ كله */
  window: CustodyWindow | null;
}

const LINK_NONE: LinkedStoreSettings = { linked: false, window: null };

/**
 * من صف gl_settings: المربوطة المفعّلة وحدها (isLinked)، ونافذتها linkedFrom/linkSnapshotAt (واحتياطاً cutoverDate/openingSnapshotAt
 * اللذان يصنّف بهما المُرحِّل: L7 يكتبهما بالقيمتين نفسيهما).
 */
export function linkedStoreSettingsOf(s: {
  timezone?: string | null; setupMethod?: string | null; activatedAt?: Date | null;
  linkedFrom?: Date | null; linkSnapshotAt?: Date | null; cutoverDate?: Date | null; openingSnapshotAt?: Date | null;
} | null | undefined): LinkedStoreSettings {
  if (!s || !isLinked({ setupMethod: s.setupMethod ?? null, activatedAt: s.activatedAt ?? null })) return LINK_NONE;
  const from = s.linkedFrom ?? s.cutoverDate ?? null;
  const snap = s.linkSnapshotAt ?? s.openingSnapshotAt ?? null;
  return {
    linked: true,
    window: from && snap ? { start: zonedStartOfDay(fromDbDate(from), s.timezone || 'Asia/Riyadh'), snapshotAt: snap } : null,
  };
}

/** داخل النافذة ⇔ الأثر ≥ بدايتها أو الإنشاء > T0 — نفي isIncludedInOpening (classifyCutover) حرفاً */
export function inCustodyWindow(effectAt: Date | string, createdAt: Date | string, w: CustodyWindow): boolean {
  return new Date(effectAt).getTime() >= w.start.getTime() || new Date(createdAt).getTime() > w.snapshotAt.getTime();
}

/** C11: الردّ من خارج عهدة المندوب (عهدة مستخدم، صندوق رئيسي، بنك) — REP_CUSTODY وMETHOD وnull مرآة الأصل */
export function cancelRefundOutsideCustody(from: string | null | undefined): boolean {
  return from === 'USER_CUSTODY' || from === 'MAIN_CASH' || from === 'BANK';
}

/**
 * تصنيف السند للعهدة كما يبنيه القيد: غير المربوطة receiptCustodyClass حرفاً، والمربوطة بقاعدة D4 في
 * builders/receipt.linkedReceiptCustodyClass نفسها (CUSTODY للنقد والشيك وحدهما) — فلا يرى الطيّ تحويلاً في العهدة والقيد في البنك.
 */
export function custodyClassOf(paymentMethod: string, salesRepId: string, routing: ReceiptRouting | null, linked: boolean): ReceiptCustodyClass {
  if (!linked) return receiptCustodyClass({ paymentMethod, salesRepId, routing });
  // الدالة تقرأ ctx.settings وحده: سياقٌ بالإعدادين يكفيها (البطاقة POS فلا تبلغ CUSTODY في المربوطة أصلاً)
  const ctx = { settings: { receiptRouting: routing, linkedPosting: true } } as unknown as BuildContext;
  return linkedReceiptCustodyClass({ paymentMethod, salesRepId, cardPaymentId: null }, ctx);
}

export interface LinkedCustodyReceiptRow {
  id: string;
  amountMilli: Milli;
  paymentMethod: string;
  cancelRefundFrom: string | null;
  effectAt: Date | string;
  createdAt: Date | string;
  reversedAt: Date | string | null;
  /** false ⇒ قبل النافذة وعُكس داخلها: يدخل كاملاً ويُطرح أثره من العهدة الافتتاحية */
  inWindow: boolean;
}
/** مجموع سندات ما قبل النافذة (غير المعكوسة داخلها) بتقريب كل سند */
export interface LinkedCustodyReceiptSum { paymentMethod: string; cancelRefundFrom: string | null; reversed: boolean; totalMilli: Milli }
export interface LinkedCustodyInvoiceRow {
  id: string;
  amountMilli: Milli;
  stamped: boolean;
  effectAt: Date | string;
  createdAt: Date | string;
  reversedAt: Date | string | null;
  inWindow: boolean;
}
export interface LinkedCustodyInvoiceSum { stamped: boolean; reversed: boolean; totalMilli: Milli }
export interface LinkedCustodySettlementRow extends CustodySettlementItem { inWindow: boolean }

export interface LinkedCustodyWindowFacts {
  salesRepId: string;
  /** cashInvoice وreceipt وstampDrivesCustody (المربوطة) */
  routing: CustodyRouting;
  /** Σ سطور 111003 للمندوب في قيد OPENING (المشتقّ عند الاعتماد: الحالة عند البدء، والمعكوس داخل النافذة فيها نشط) */
  openingLedgerMilli: Milli;
  receipts: readonly LinkedCustodyReceiptRow[];
  receiptSums: readonly LinkedCustodyReceiptSum[];
  invoices: readonly LinkedCustodyInvoiceRow[];
  invoiceSums: readonly LinkedCustodyInvoiceSum[];
  /** استلامات النافذة (والمحذوفة) وما قبلها حُذف داخلها، بالتقسيم المخزَّن */
  settlements: readonly LinkedCustodySettlementRow[];
  /** Σ استلامات ما قبل النافذة القائمة */
  settledBeforeMilli: Milli;
}

/**
 * الصيغة المغلقة (§5.6 البند 3): عناصر النافذة صفوفاً، وما قبلها حالةً افتتاحية واحدة للمندوب:
 *  - الأرصدة الجارية (النشطة بكل الطرق، والإلكترونية، وخارج العهدة، ونقد الفواتير خارج العهدة، والمستلَم) = مجاميع ما قبل
 *    النافذة غير المعكوس؛ والمعكوس قبلها صافيه صفر، إلا سند CUSTODY رُدّ ماله من خارج العهدة (C11): أثره على 111003 باقٍ
 *    ويدخل cancelRefundOutside.
 *  - 111003 الافتتاحي = سطور قيد OPENING − أثر ما قبل النافذة المعكوس داخلها (يدخل كاملاً فيُعاد أثره عند تاريخه).
 *  - r التراكمي = المستلَم − (ما دخل 111003 − الافتتاحي): هويّة P7 (covered = الداخل − الباقي، وr = المستلَم − covered).
 *  - المعلّق صفر: لا 911001 لما قبل النافذة.
 * null ⇒ استلامٌ قبل النافذة حُذف داخلها بلا تقسيم مخزَّن: لا تُعرف تغطيته من الافتتاح، فيُطوى التاريخ كله (المُستدعي).
 */
export function linkedCustodyInputs(f: LinkedCustodyWindowFacts): CustodyComponentsInput | null {
  const rep = f.salesRepId;
  const routing = f.routing.receipt ?? null;
  const cashToCustody = f.routing.cashInvoice === 'CUSTODY';
  const stampDrives = f.routing.stampDrivesCustody === true;
  const toLedger = (stamped: boolean): boolean => (stamped ? stampDrives || cashToCustody : cashToCustody);
  const out: CustodyComponentsInput = {
    receipts: [], onlineReceipts: [], outsideReceipts: [], cashInvoices: [], settlements: [], shortages: [], custodyExpenses: [],
    routing: f.routing,
  };
  let preEffect = 0n; // أثر عناصر ما قبل النافذة المعكوسة داخلها على 111003 (مضمَّن في قيد OPENING)

  for (const r of f.receipts) {
    const cls = custodyClassOf(r.paymentMethod, rep, routing, true);
    const item: CustodyItem = {
      id: r.id, salesRepId: rep, amountMilli: r.amountMilli, effectAt: r.effectAt, createdAt: r.createdAt, reversedAt: r.reversedAt,
      ...(cls === 'CUSTODY' && r.reversedAt != null && cancelRefundOutsideCustody(r.cancelRefundFrom) ? { reversalOutsideCustody: true } : {}),
    };
    ((cls === 'CUSTODY' ? out.receipts : cls === 'ONLINE' ? out.onlineReceipts : out.outsideReceipts) as CustodyItem[]).push(item);
    if (!r.inWindow && cls === 'CUSTODY') preEffect += r.amountMilli;
  }
  for (const i of f.invoices) {
    (out.cashInvoices as CustodyItem[]).push({
      id: i.id, salesRepId: rep, amountMilli: i.amountMilli, effectAt: i.effectAt, createdAt: i.createdAt, reversedAt: i.reversedAt,
      ...(i.stamped ? { stamped: true } : {}),
    });
    if (!i.inWindow && toLedger(i.stamped)) preEffect += i.amountMilli;
  }
  for (const st of f.settlements) {
    const { inWindow, ...item } = st;
    if (!inWindow) {
      if (item.nonCustodyClearedMilli == null) return null;
      // أثره عند البدء −covered (المخزَّن: covered = المبلغ − r − المسترد)
      preEffect -= item.amountMilli - item.nonCustodyClearedMilli - (item.shortageRecoveredMilli ?? 0n);
    }
    (out.settlements as CustodySettlementItem[]).push(item);
  }

  let active = 0n;
  let online = 0n;
  let outside = 0n;
  let cashOutside = 0n;
  let inflows = 0n;
  let cancelOutside = 0n;
  for (const g of f.receiptSums) {
    const cls = custodyClassOf(g.paymentMethod, rep, routing, true);
    if (g.reversed) {
      if (cls === 'CUSTODY' && cancelRefundOutsideCustody(g.cancelRefundFrom)) {
        inflows += g.totalMilli;
        cancelOutside += g.totalMilli;
      }
      continue;
    }
    active += g.totalMilli;
    if (cls === 'CUSTODY') inflows += g.totalMilli;
    else if (cls === 'ONLINE') online += g.totalMilli;
    else outside += g.totalMilli;
  }
  for (const g of f.invoiceSums) {
    if (g.reversed) continue;
    if (g.stamped) {
      active += g.totalMilli;
      if (toLedger(true)) inflows += g.totalMilli;
      else outside += g.totalMilli;
    } else if (cashToCustody) {
      inflows += g.totalMilli;
    } else {
      cashOutside += g.totalMilli;
    }
  }
  const ledgerOpen = f.openingLedgerMilli - preEffect;
  const opening: CustodyOpening = {
    ledgerCustodyMilli: ledgerOpen,
    onlineActiveMilli: online,
    outsideActiveMilli: outside,
    cashSalesOutsideMilli: cashOutside,
    activeReceiptsMilli: active,
    settledMilli: f.settledBeforeMilli,
    nonCustodyClearedMilli: f.settledBeforeMilli - (inflows - ledgerOpen),
    suspenseMilli: 0n,
    cancelRefundOutsideMilli: cancelOutside,
  };
  out.opening = { [rep]: opening };
  return out;
}

/** صفّ استعلام نافذة السندات: ROW (عنصر النافذة أو ما قبلها عُكس داخلها) أو SUM (مجموع ما قبلها بتقريب كل سند) */
export interface LinkedReceiptSqlRow {
  kind: 'ROW' | 'SUM';
  id: string | null;
  method: string | null;
  refundFrom: string | null;
  amount: number | null;
  effAt: Date | null;
  createdAt: Date | null;
  revAt: Date | null;
  inWin: boolean | null;
  reversed: boolean | null;
  total: string | null;
}
export interface LinkedInvoiceSqlRow {
  kind: 'ROW' | 'SUM';
  id: string | null;
  stamped: boolean | null;
  amount: number | null;
  effAt: Date | null;
  createdAt: Date | null;
  revAt: Date | null;
  inWin: boolean | null;
  reversed: boolean | null;
  total: string | null;
}

/** صفوف الاستعلامين ⇒ حقائق الصيغة المغلقة (صرفة: ملّي بمنازل العملة لكل سند، والمجاميع نصوص عشرية مقرّبة في SQL) */
export function linkedCustodyFactsFromSql(input: {
  salesRepId: string; dec: number; routing: CustodyRouting; openingLedgerMilli: Milli; settledBeforeMilli: Milli;
  receiptRows: readonly LinkedReceiptSqlRow[]; invoiceRows: readonly LinkedInvoiceSqlRow[]; settlements: readonly LinkedCustodySettlementRow[];
}): LinkedCustodyWindowFacts {
  const dec = input.dec;
  const receipts: LinkedCustodyReceiptRow[] = [];
  const receiptSums: LinkedCustodyReceiptSum[] = [];
  for (const r of input.receiptRows) {
    if (r.kind === 'SUM') {
      receiptSums.push({ paymentMethod: r.method ?? 'CASH', cancelRefundFrom: r.refundFrom ?? null, reversed: r.reversed === true, totalMilli: toMilli(r.total ?? '0', dec) });
      continue;
    }
    if (!r.id || r.amount === null || !r.effAt || !r.createdAt) continue;
    receipts.push({
      id: r.id, amountMilli: toMilli(Number(r.amount), dec), paymentMethod: r.method ?? 'CASH', cancelRefundFrom: r.refundFrom ?? null,
      effectAt: r.effAt, createdAt: r.createdAt, reversedAt: r.revAt ?? null, inWindow: r.inWin === true,
    });
  }
  const invoices: LinkedCustodyInvoiceRow[] = [];
  const invoiceSums: LinkedCustodyInvoiceSum[] = [];
  for (const r of input.invoiceRows) {
    if (r.kind === 'SUM') {
      invoiceSums.push({ stamped: r.stamped === true, reversed: r.reversed === true, totalMilli: toMilli(r.total ?? '0', dec) });
      continue;
    }
    if (!r.id || r.amount === null || !r.effAt || !r.createdAt) continue;
    invoices.push({
      id: r.id, amountMilli: toMilli(Number(r.amount), dec), stamped: r.stamped === true,
      effectAt: r.effAt, createdAt: r.createdAt, reversedAt: r.revAt ?? null, inWindow: r.inWin === true,
    });
  }
  return {
    salesRepId: input.salesRepId, routing: input.routing, openingLedgerMilli: input.openingLedgerMilli,
    receipts, receiptSums, invoices, invoiceSums, settlements: input.settlements, settledBeforeMilli: input.settledBeforeMilli,
  };
}

/**
 * سندات المندوب: تصنيف كل سند بصفوف account_entries للمفتاح (RECEIPT_CREDIT للترحيل: أصغر entryDate وأكبر createdAt؛
 * RECEIPT_DEBIT للعكس) — classifyCutover نفسه. يعيد صفوف النافذة (وما قبلها عُكس داخلها) ومجاميع ما قبلها مجمّعةً بالطريقة
 * ومصدر الردّ والعكس، بتقريب كل سند نصف-لأعلى إلى منازل العملة (ROUND على numeric) ثم الجمع. صفوف الدفتر تُمسح مرة
 * (فهرس tenantId) وتُضمّ بالتجزئة — لا استعلام لكل سند.
 */
export function linkedCustodyReceiptsSql(tenantId: string, salesRepId: string, w: CustodyWindow, dec: number): Prisma.Sql {
  return Prisma.sql`
    WITH "ent" AS (
      SELECT e."receiptId" AS "rid",
             MIN(e."entryDate") FILTER (WHERE e."type" = 'RECEIPT_CREDIT') AS "cAt",
             MAX(e."createdAt") FILTER (WHERE e."type" = 'RECEIPT_CREDIT') AS "cCreated",
             MIN(e."entryDate") FILTER (WHERE e."type" = 'RECEIPT_DEBIT') AS "dAt",
             MAX(e."createdAt") FILTER (WHERE e."type" = 'RECEIPT_DEBIT') AS "dCreated"
      FROM "account_entries" e
      WHERE e."tenantId" = ${tenantId} AND e."type" IN ('RECEIPT_CREDIT', 'RECEIPT_DEBIT')
        AND e."receiptId" IN (SELECT r0."id" FROM "receipts" r0 WHERE r0."tenantId" = ${tenantId} AND r0."salesRepId" = ${salesRepId})
      GROUP BY e."receiptId"
    ), "t" AS (
      SELECT r."id", r."amount", r."paymentMethod" AS "method", r."cancelRefundFrom" AS "refundFrom", r."createdAt",
             COALESCE(ent."cAt", r."receiptDate") AS "effAt",
             ent."dAt" AS "revAt",
             (COALESCE(ent."cAt", r."receiptDate") >= ${w.start} OR COALESCE(ent."cCreated", r."createdAt") > ${w.snapshotAt}) AS "inWin",
             (ent."dAt" IS NOT NULL AND (ent."dAt" >= ${w.start} OR ent."dCreated" > ${w.snapshotAt})) AS "revInWin"
      FROM "receipts" r LEFT JOIN "ent" ON ent."rid" = r."id"
      WHERE r."tenantId" = ${tenantId} AND r."salesRepId" = ${salesRepId}
    )
    SELECT 'ROW' AS "kind", t."id", t."method", t."refundFrom", t."amount", t."effAt", t."createdAt", t."revAt", t."inWin",
           (t."revAt" IS NOT NULL) AS "reversed", NULL::text AS "total"
    FROM "t" WHERE t."inWin" OR t."revInWin"
    UNION ALL
    SELECT 'SUM', NULL, t."method", t."refundFrom", NULL, NULL, NULL, NULL, NULL,
           (t."revAt" IS NOT NULL), COALESCE(SUM(ROUND(t."amount"::numeric, ${dec}::int)), 0)::text
    FROM "t" WHERE NOT (t."inWin" OR t."revInWin")
    GROUP BY t."method", t."refundFrom", (t."revAt" IS NOT NULL)`;
}

/**
 * فواتير المندوب النقدية: الترحيل INVOICE_DEBIT (والمفتاح معه RECEIPT_CREDIT)، والعكس INVOICE_CREDIT (ومعه RECEIPT_DEBIT).
 * عكسٌ يحتفظ بالنقد (C17: وسم الإبطال بلا RECEIPT_DEBIT) لا يُعدّ عكساً للعهدة — مرآة keepCashLeg في desired.ts. ومجاميع ما
 * قبل النافذة مجمّعة بالختم والعكس.
 */
export function linkedCustodyInvoicesSql(tenantId: string, salesRepId: string, w: CustodyWindow, dec: number): Prisma.Sql {
  return Prisma.sql`
    WITH "ent" AS (
      SELECT e."invoiceId" AS "iid",
             MIN(e."entryDate") FILTER (WHERE e."type" = 'INVOICE_DEBIT') AS "pAt",
             MAX(e."createdAt") FILTER (WHERE e."type" IN ('INVOICE_DEBIT', 'RECEIPT_CREDIT')) AS "pCreated",
             MIN(e."entryDate") FILTER (WHERE e."type" = 'INVOICE_CREDIT') AS "rAt",
             MAX(e."createdAt") FILTER (WHERE e."type" IN ('INVOICE_CREDIT', 'RECEIPT_DEBIT')) AS "rCreated",
             BOOL_OR(e."type" = 'INVOICE_CREDIT') AS "hasCredit",
             BOOL_OR(e."type" = 'INVOICE_CREDIT' AND e."description" = ${CASH_VOID_KEEP_COLLECTION_NOTE}) AS "hasKeep",
             BOOL_OR(e."type" = 'RECEIPT_DEBIT') AS "hasRd"
      FROM "account_entries" e
      WHERE e."tenantId" = ${tenantId} AND e."receiptId" IS NULL
        AND e."invoiceId" IN (SELECT i0."id" FROM "invoices" i0 WHERE i0."tenantId" = ${tenantId} AND i0."salesRepId" = ${salesRepId} AND i0."type" = 'CASH')
      GROUP BY e."invoiceId"
    ), "t" AS (
      SELECT i."id", i."total", i."invoiceDate", i."createdAt", i."cashCollectedByRep" AS "stamped",
             CASE WHEN COALESCE(ent."hasCredit", false) AND NOT (COALESCE(ent."hasKeep", false) AND NOT COALESCE(ent."hasRd", false))
                  THEN ent."rAt" END AS "revAt",
             ent."rCreated",
             (COALESCE(ent."pAt", i."invoiceDate") >= ${w.start} OR COALESCE(ent."pCreated", i."createdAt") > ${w.snapshotAt}) AS "inWin"
      FROM "invoices" i LEFT JOIN "ent" ON ent."iid" = i."id"
      WHERE i."tenantId" = ${tenantId} AND i."salesRepId" = ${salesRepId} AND i."type" = 'CASH'
    ), "u" AS (
      SELECT t.*, (t."revAt" IS NOT NULL AND (t."revAt" >= ${w.start} OR t."rCreated" > ${w.snapshotAt})) AS "revInWin" FROM "t"
    )
    SELECT 'ROW' AS "kind", u."id", u."stamped", u."total" AS "amount", u."invoiceDate" AS "effAt", u."createdAt", u."revAt", u."inWin",
           (u."revAt" IS NOT NULL) AS "reversed", NULL::text AS "total"
    FROM "u" WHERE u."inWin" OR u."revInWin"
    UNION ALL
    SELECT 'SUM', NULL, u."stamped", NULL, NULL, NULL, NULL, NULL,
           (u."revAt" IS NOT NULL), COALESCE(SUM(ROUND(u."total"::numeric, ${dec}::int)), 0)::text
    FROM "u" WHERE NOT (u."inWin" OR u."revInWin")
    GROUP BY u."stamped", (u."revAt" IS NOT NULL)`;
}

// ── عهدة مستخدمي الشركة (D6) ──

const emptyUserCustodyInputs = (userId: string): UserCustodyInputs => ({ userId, received: [], delivered: [], refunds: [] });

/**
 * مدخلات foldUserCustody لمستخدمين (null = كل من له تاريخ عهدة) بخمس قراءات أياً كان عددهم (بلا N+1):
 *  - الصفوف الحيّة (الاستلامات والتوريدات والاستردادات) من المصدر الواحد مع الشاشة: readUserCustodyOpsRows ثم
 *    userCustodyInputsFromRows بمنظور الدفاتر (services/userCustody.ts — مراجعة ١٤ نوفمبر: كان لكلٍّ محمّله فاختلفا).
 *    استلام المندوب المحذوف يُقرأ ويُوسم outsideCustody: المُطابِق لا يرحّله (SETTLEMENT_HAS_REP) وسنداته OUTSIDE في 111001،
 *    فيدخل الوعاء — توريد ماله يمرّ بلا قيد (لا 111004 سالب ولا 111001 مرّتين). كان يُسقَط فيُقيَّد توريده كاملاً على 111004.
 *  - المحذوف من الاستلام من حمولة tombstone المربوطة (SETTLEMENT REVERSE تحمل receivedByUserId) بلحظة الحذف عكساً.
 *  - المحذوف من التوريد من حمولة USER_SETTLEMENT REVERSE بلحظة الحذف؛ والتقسيم المخزَّن من حدث POST المنفّذ أو المحسوم
 *    (nonCustodyClearedMilli) يُقرأ ولا يُعاد اشتقاقه.
 * المبالغ ملّي بمنازل العملة لكل مستند (نصف-لأعلى كـtoMilli) — المبلغ نفسه الذي يُرحَّل به P7 والتوريد والعكس.
 */
export async function loadUserCustodyInputsMany(
  db: GlDb, tenantId: string, decimals: number, userIds: readonly string[] | null,
): Promise<Map<string, UserCustodyInputs>> {
  const out = new Map<string, UserCustodyInputs>();
  if (userIds && userIds.length === 0) return out;
  const want = userIds ? new Set(userIds) : null;
  const single = userIds && userIds.length === 1 ? userIds[0] : null;
  const wanted = (u: unknown): u is string => typeof u === 'string' && u !== '' && (!want || want.has(u));
  const of = (u: string): UserCustodyInputs => {
    let x = out.get(u);
    if (!x) { x = emptyUserCustodyInputs(u); out.set(u, x); }
    return x;
  };
  const [ops, settlementReverses, userEvents] = await Promise.all([
    readUserCustodyOpsRows(db, tenantId, userIds),
    db.glSourceEvent.findMany({
      where: { tenantId, sourceType: 'SETTLEMENT', event: 'REVERSE', ...(single ? { payload: { path: ['receivedByUserId'], equals: single } } : {}) },
      select: { sourceId: true, effectAt: true, payload: true },
    }),
    db.glSourceEvent.findMany({
      where: { tenantId, sourceType: 'USER_SETTLEMENT', ...(single ? { payload: { path: ['fromUserId'], equals: single } } : {}) },
      select: { sourceId: true, event: true, status: true, effectAt: true, payload: true, nonCustodyClearedMilli: true },
    }),
  ]);
  for (const [u, x] of userCustodyInputsFromRows(ops, { decimals, ledgerView: true, wanted })) out.set(u, x);

  const liveReceived = new Set(ops.received.map((r) => r.id));
  const deletedReceived = new Set<string>();
  for (const e of settlementReverses) {
    if (liveReceived.has(e.sourceId) || deletedReceived.has(e.sourceId)) continue;
    const p = payloadRecord(e.payload);
    const at = textOrNull(p?.settledAt);
    const user = p?.receivedByUserId;
    if (!p || !at || p.amount === undefined || p.amount === null || !wanted(user)) continue;
    deletedReceived.add(e.sourceId);
    const row: UserCustodyReceivedRow = {
      id: e.sourceId, amountMilli: toMilli(String(p.amount), decimals), method: textOrNull(p.method) ?? 'CASH', at,
      createdAt: textOrNull(p.createdAt) ?? at, reversedAt: e.effectAt,
    };
    of(user).received.push(row);
  }

  const stored = new Map<string, bigint>();
  const deletedAt = new Map<string, Date>();
  const tombstones = new Map<string, Record<string, unknown>>();
  for (const e of userEvents) {
    if (e.event === 'POST' && (e.status === 'DONE' || e.status === 'SKIPPED') && e.nonCustodyClearedMilli !== null) stored.set(e.sourceId, e.nonCustodyClearedMilli);
    if (e.event === 'REVERSE') {
      deletedAt.set(e.sourceId, e.effectAt);
      const p = payloadRecord(e.payload);
      if (p) tombstones.set(e.sourceId, p);
    }
  }
  const liveDelivered = new Set(ops.delivered.map((d) => d.id));
  // التقسيم المخزَّن على التوريد الحيّ (منظور الدفاتر وحده — الشاشة لا تقرأ أحداث الدفاتر)
  for (const x of out.values()) for (const d of x.delivered) d.storedPassThroughMilli = stored.get(d.id) ?? null;
  for (const [id, p] of tombstones) {
    if (liveDelivered.has(id)) continue;
    const at = textOrNull(p.settledAt);
    const user = p.fromUserId;
    if (!at || p.amount === undefined || p.amount === null || !wanted(user)) continue;
    const row: UserCustodyDeliveredRow = {
      id, amountMilli: toMilli(String(p.amount), decimals), method: textOrNull(p.method) ?? 'CASH', at,
      createdAt: textOrNull(p.createdAt) ?? at, reversedAt: deletedAt.get(id) ?? null, storedPassThroughMilli: stored.get(id) ?? null,
    };
    of(user).delivered.push(row);
  }
  return out;
}
