/**
 * تنفيذ PostingStore بـPrisma (M3، DESIGN.md §5.1، §5.2، §5.4).
 *
 * - يُنشأ بـPrismaClient **مستقل** بـ?connection_limit=1 (createWorkerPrismaClient) فلا يزاحم مجمّع اتصالات الـAPI.
 * - withPostLock: prisma.$transaction تفاعلية أول ما فيها acquirePostLock ⇒ pg_advisory_xact_lock (قفل معاملة لا جلسة).
 * - عقد الإيجار: $executeRaw بساعة القاعدة NOW() ودون لمس updatedAt؛ الفك بشرط الرمز نفسه.
 * - كل استعلام مقيّد بـtenantId (§9.4).
 * هذا الملف وحده (مع scheduler.ts) يعرف prisma؛ poster.ts وtick.ts يعملان على الواجهة.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { fromDbDate, localDate, maxLocalDate } from '../dates';
import { formatMilli, toMilli } from '../money';
import { acquirePostLock, postMove } from '../post';
import {
  loadBuildContext, requireMoveRecord, settingsSnapshotFromRow, type GlDb, type LedgerContext,
} from '../resolve';
import { reversalDraftFromRecord, reverseMove, type ReverseResult } from '../reverse';
import { autoSaleKey, invoicePayloadFromRows } from '../builders/invoice';
import { receiptCustodyClass, type CustodyComponentsInput, type CustodyItem, type CustodySettlementItem } from '../custody';
import {
  type BackfillState, type EventStatus, type SkipReason, type SourceEvent, type SourceType, type VatCategory,
} from '../types';
import { tombstoneOrigin, type LiveMoveState, type OriginFacts, type SiblingState } from './classify';
import type {
  EligibleTenant, ListDueEventsOptions, LiveMoveLine, PosterSettings, PostingStore, PostingTx, SourceData, WithPostLockOptions,
} from './postingStore';
import {
  POST_TX_TIMEOUT_MS, SYNC_CURSOR_SOURCES, WORKER_LEASE_SECONDS,
  type CompositeKey, type DesiredEvent, type LeaseHandle, type SourceEventPatch, type SourceEventPayload, type SourceEventRecord,
  type SyncCursorSource, type SyncCursorState,
} from './types';

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

// ═══ المخزن ═══

export class PrismaPostingStore implements PostingStore {
  constructor(private readonly db: PrismaClient) {}

  async dbNow(): Promise<Date> {
    return dbNowOf(this.db);
  }

  async listEligibleTenants(limit = 200): Promise<EligibleTenant[]> {
    const rows = await this.db.glSettings.findMany({
      where: { activatedAt: { not: null }, tenant: { accountingSuiteEnabled: true, accountingEnabled: true } },
      select: { tenantId: true, lastSyncAt: true },
      orderBy: [{ lastSyncAt: { sort: 'asc', nulls: 'first' } }, { tenantId: 'asc' }],
      take: limit,
    });
    return rows;
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
      setupMethod: row.setupMethod === 'FULL_HISTORY' ? 'FULL_HISTORY' : row.setupMethod === 'OPENING' ? 'OPENING' : null,
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
  private settingsCache: { timezone: string; currency: string; decimals: number; routing: unknown; cashInvoiceRouting: string } | null = null;

  constructor(private readonly tx: GlDb, readonly tenantId: string) {}

  private async settings() {
    if (!this.settingsCache) {
      const s = await this.tx.glSettings.findUnique({
        where: { tenantId: this.tenantId },
        select: { timezone: true, currency: true, currencyDecimals: true, receiptRouting: true, cashInvoiceRouting: true },
      });
      this.settingsCache = {
        timezone: s?.timezone || 'Asia/Riyadh', currency: s?.currency ?? 'SAR', decimals: s?.currencyDecimals ?? 2,
        routing: s?.receiptRouting ?? null, cashInvoiceRouting: s?.cashInvoiceRouting ?? 'MAIN_CASH',
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
    const draft = reversalDraftFromRecord(rec, {
      date, reason, originalNumber: rec.number, sourceKey: opts.sourceKey ?? null, sourceEvent: opts.sourceEvent ?? null,
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

    const [receipts, invoices, settlements, settlementEvents] = await Promise.all([
      this.tx.receipt.findMany({
        where: { tenantId, salesRepId },
        select: { id: true, amount: true, paymentMethod: true, receiptDate: true, createdAt: true },
      }),
      this.tx.invoice.findMany({
        where: { tenantId, salesRepId, type: 'CASH' },
        select: { id: true, total: true, invoiceDate: true, createdAt: true },
      }),
      this.tx.repSettlement.findMany({
        where: { tenantId, salesRepId },
        select: { id: true, amount: true, settledAt: true, createdAt: true },
      }),
      this.tx.glSourceEvent.findMany({
        where: { tenantId, sourceType: 'SETTLEMENT', payload: { path: ['salesRepId'], equals: salesRepId } },
        select: { sourceId: true, event: true, status: true, effectAt: true, payload: true, nonCustodyClearedMilli: true, shortageRecoveredMilli: true },
      }),
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
        select: { receiptId: true, invoiceId: true, type: true, entryDate: true },
      })
      : [];
    const receiptEffect = new Map<string, Date>();
    const receiptReversed = new Map<string, Date>();
    const invoiceReversed = new Map<string, Date>();
    for (const e of entries) {
      if (e.receiptId && e.type === 'RECEIPT_CREDIT') receiptEffect.set(e.receiptId, e.entryDate);
      if (e.receiptId && e.type === 'RECEIPT_DEBIT') receiptReversed.set(e.receiptId, e.entryDate);
      if (!e.receiptId && e.invoiceId && e.type === 'INVOICE_CREDIT') invoiceReversed.set(e.invoiceId, e.entryDate);
    }

    const out: CustodyComponentsInput = {
      receipts: [], onlineReceipts: [], outsideReceipts: [], cashInvoices: [], settlements: [], shortages: [], custodyExpenses: [],
      routing: { cashInvoice: s.cashInvoiceRouting === 'CUSTODY' ? 'CUSTODY' : 'MAIN_CASH', receipt: routing ?? null },
    };
    for (const r of receipts) {
      const item: CustodyItem = {
        id: r.id, salesRepId, amountMilli: toMilli(r.amount, dec), effectAt: receiptEffect.get(r.id) ?? r.receiptDate,
        createdAt: r.createdAt, reversedAt: receiptReversed.get(r.id) ?? null,
      };
      const cls = receiptCustodyClass({ paymentMethod: r.paymentMethod, salesRepId, routing });
      ((cls === 'CUSTODY' ? out.receipts : cls === 'ONLINE' ? out.onlineReceipts : out.outsideReceipts) as CustodyItem[]).push(item);
    }
    for (const i of invoices) {
      (out.cashInvoices as CustodyItem[]).push({
        id: i.id, salesRepId, amountMilli: toMilli(i.total, dec), effectAt: i.invoiceDate, createdAt: i.createdAt,
        reversedAt: invoiceReversed.get(i.id) ?? null,
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
      const v = stored.get(id);
      (out.settlements as CustodySettlementItem[]).push({
        id, salesRepId, amountMilli: toMilli(t.amount, dec), effectAt: t.settledAt, createdAt: t.createdAt,
        reversedAt: reversedAt.get(id) ?? null, nonCustodyClearedMilli: v?.nonCustody ?? null, shortageRecoveredMilli: v?.recovered ?? null,
      });
    }
    return out;
  }

  async resolveOrigin(event: Pick<SourceEventRecord, 'sourceType' | 'sourceId' | 'event' | 'payload'>): Promise<OriginFacts | null> {
    if (event.sourceType === 'SETTLEMENT' || event.sourceType === 'AR_ENTRY') {
      const fromPayload = tombstoneOrigin(event.sourceType, event.payload);
      if (fromPayload) {
        const exists = event.sourceType === 'SETTLEMENT'
          ? !!(await this.tx.repSettlement.findFirst({ where: { id: event.sourceId, tenantId: this.tenantId }, select: { id: true } }))
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

    switch (sourceType) {
      case 'INVOICE': {
        const inv = await this.tx.invoice.findFirst({
          where: { id: sourceId, tenantId },
          select: {
            id: true, number: true, type: true, customerId: true, salesRepId: true, pricesIncludeTax: true, subtotal: true,
            discountAmt: true, taxAmt: true, total: true, dueDate: true,
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
          where: { id: sourceId, tenantId },
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
}

/** مبلغ Float مخزّن ⇒ نص بمنازل العملة (عبر الملّي) */
function toMilliText(v: number, decimals: number): string {
  return formatMilli(toMilli(v, decimals), decimals);
}
