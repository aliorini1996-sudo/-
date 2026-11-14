/**
 * الظلّ في الذاكرة لمعاينة «ربط الدفاتر» (L2 — العقد §10.3، D8).
 *
 * المعاينة = المحرّك الحقيقي فوق ظلّ: reconcileTenant وrunPoster والـbuilders وvalidateMove بلا تعديل، تغذّيها:
 *  - ShadowReconcilerStore: قراءة الصفحات والحقائق والصفوف غير المقروءة تفويضاً إلى createPrismaReconcilerStore على العميل
 *    الحارس (قراءات تشغيلية داخل لقطة REPEATABLE READ READ ONLY)، والأحداث والمؤشرات في الذاكرة.
 *  - ShadowPostingStore/ShadowPostingTx: نسخة إنتاجية من tests/gl-fake-posting-store.ts — الأحداث والقيود والمصادر في
 *    الذاكرة، والتراجع **بسجلّ تراجع** (إغلاق لكل تعديل: O(1) لكل معاملة، لا نسخ للحالة)، وpostMove = validateMove +
 *    إزاحة الإقفال + تسجيل القيد (معرّف pv:<n>، رقم <البادئة>/<YYYY-MM>/<n>)، وreverseMove = reversalDraftFromRecord بتاريخ
 *    max(المطلوب، الأصل)، وضرائب AUTO_SALE_<pct> افتراضية بلا مربع (تُسجَّل نسبها لفحص P7).
 *    loadSourceData وresolveOrigin وloadCustodyInputs **بلا تعديل**: تفويض إلى PrismaPostingTx على العميل الحارس (وقراءات
 *    العهدة التشغيلية تُذكَّر داخل اللقطة الثابتة — نتيجتها لا تتغيّر — فلا تُعاد لكل استلام على قاعدة بـ٠٫١ نواة).
 *  - shadowBalanceView: أرصدة الأستاذ للمطابقة (GlBalanceView).
 * لا شيء هنا يكتب في القاعدة؛ ولا Date.now: الساعة افتراضية (ساعة القاعدة داخل اللقطة، وتُقدَّم صراحةً).
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { autoSaleKey } from '../builders/invoice';
import type { CustodyComponentsInput } from '../custody';
import { maxLocalDate, toDbDate, todayLocal } from '../dates';
import { applyAutoLockShift, assertManualDateOpen, lockScopeOfDraft, type LockDates } from '../locks';
import type { PostMoveOptions, PostedMove } from '../post';
import { openingSnapshotFromDbNow } from '../opening';
import { GlNotFoundError, settingsSnapshotFromRow, type LedgerContext, type MoveRecordForDraft } from '../resolve';
import { reversalDraftFromRecord, type ReverseMoveOptions, type ReverseResult } from '../reverse';
import { sequencePrefixFor } from '../sequence';
import { compareEventsForPosting, type LiveMoveState, type OriginFacts, type SiblingState } from '../sync/classify';
import { isUnderPostPattern } from '../sync/keys';
import { PrismaPostingTx } from '../sync/postingStore.prisma';
import type {
  EligibleTenant, ListDueEventsOptions, LiveMoveLine, OpeningImportCandidate, PosterSettings, PostingStore, PostingTx, SourceData,
} from '../sync/postingStore';
import type { CommitPageResult, PageQuery, ReconcileSettings, ReconcilerStore } from '../sync/reconciler';
import { createPrismaReconcilerStore } from '../sync/reconcilerStore.prisma';
import type { ReconciledSource, SourceRow } from '../sync/desired';
import {
  IMPORT_LANE_SOURCE_TYPES, compareCompositeKey, maxCompositeKey,
  type CompositeKey, type DesiredEvent, type EventStatus, type SourceEventPatch, type SourceEventPayload, type SourceEventRecord,
  type SyncCursorSource, type SyncCursorState,
} from '../sync/types';
import { validateMove, validationModeOf, type ValidationMode } from '../validate';
import {
  LedgerError, isMappingKey,
  type BuildContextInput, type LocalDate, type Milli, type MoveDraft, type MoveType, type SkipReason, type SourceEvent, type SourceType,
  type TaxRef, type TaxRole,
} from '../types';
import type { GlBalanceQuery, GlBalanceView, PreviewOptions } from './types';
import { ledgerContextFromInput, virtualContextInput, virtualSettingsRow, type VirtualSettingsRow } from './virtualContext';

// ═══ القيود في الذاكرة ═══

export interface ShadowLine {
  moveId: string;
  seq: number;
  /** تاريخ القيد (منسوخ كالسطر الحقيقي GlMoveLine.date) */
  date: LocalDate;
  accountId: string;
  label: string;
  debitMilli: Milli;
  creditMilli: Milli;
  customerId: string | null;
  vendorId: string | null;
  salesRepId: string | null;
  partnerName: string | null;
  analyticAccountId: string | null;
  productId: string | null;
  quantity: number | null;
  taxId: string | null;
  taxRole: TaxRole | null;
  taxBaseMilli: Milli | null;
  vatBox: string | null;
  vatAdjustment: boolean;
  dueDate: LocalDate | null;
}

export interface ShadowMove {
  id: string;
  /** ترتيب الإنشاء (بديل createdAt في findLiveMove) */
  seq: number;
  number: string;
  journalId: string;
  journalCode: string;
  journalSystemKey: string | null;
  date: LocalDate;
  originalDate: LocalDate | null;
  lateArrival: boolean;
  moveType: MoveType;
  origin: MoveDraft['origin'];
  ref: string | null;
  narration: string;
  needsAttention: boolean;
  attentionReason: string | null;
  customerId: string | null;
  vendorId: string | null;
  salesRepId: string | null;
  sourceType: SourceType | null;
  sourceId: string | null;
  /** مفتاح GlMoveSource إن أُنشئ */
  sourceKey: string | null;
  sourceEvent: SourceEvent | null;
  currencyCode: string;
  currencyDecimals: number;
  reversedMoveId: string | null;
  reversalId: string | null;
  reversalReason: string | null;
  totalMilli: Milli;
  lines: ShadowLine[];
}

/** أحداث الظلّ فوق السقف ⇒ المعاينة FAILED(TOO_LARGE) */
export class ShadowTooLargeError extends Error {
  readonly code = 'TOO_LARGE' as const;
  constructor(readonly events: number, readonly maxEvents: number) {
    super(`أحداث المعاينة تجاوزت السقف (${events} > ${maxEvents})`);
    this.name = 'ShadowTooLargeError';
  }
}

export interface ShadowInit {
  tenantId: string;
  settingsRow: VirtualSettingsRow;
  /** مدخل سياق القالب (virtualContextInput) — يُعاد بناؤه حين تُضاف ضرائب AUTO_SALE */
  contextInput: BuildContextInput;
  reconcileSettings: ReconcileSettings;
  posterSettings: PosterSettings;
  /** الساعة الافتراضية الابتدائية (ساعة القاعدة داخل اللقطة) */
  now: Date;
  maxEvents?: number;
}

type Lane = 'LIVE' | 'IMPORT';
const IMPORT_TYPES = new Set<string>(IMPORT_LANE_SOURCE_TYPES);
const laneOf = (t: string): Lane => (IMPORT_TYPES.has(t) ? 'IMPORT' : 'LIVE');

const FAILURE_PATCHABLE: readonly EventStatus[] = ['PENDING', 'BLOCKED', 'ERROR', 'HELD'];

/** حمولة كما تخزّنها عمود Json (نصوص التواريخ، BigInt نصاً، وDbNull/JsonNull ⇒ null) */
function storedPayload(v: unknown): SourceEventPayload | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return null; // Prisma.DbNull / JsonNull
  }
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))) as SourceEventPayload;
}

function bigOrNull(v: unknown): Milli | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'bigint' ? v : BigInt(v as string | number);
}

function project(row: Record<string, unknown>, select: Record<string, unknown> | null): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [k, on] of Object.entries(select)) if (on) out[k] = row[k] === undefined ? null : row[k];
  return out;
}

function payloadRep(p: SourceEventPayload | null): string | null {
  const v = p && typeof p === 'object' ? (p as unknown as Record<string, unknown>).salesRepId : null;
  return typeof v === 'string' && v ? v : null;
}

// ═══ الحالة ═══

export class ShadowState {
  readonly tenantId: string;
  readonly settingsRow: VirtualSettingsRow;
  readonly reconcileSettings: ReconcileSettings;
  readonly posterSettings: PosterSettings;
  readonly maxEvents: number;
  context: LedgerContext;
  private readonly contextInput: BuildContextInput;
  private extraTaxes: TaxRef[] = [];
  /** نسب AUTO_SALE_<pct> التي احتاجها الترحيل (P7) */
  readonly autoSalePercents = new Set<number>();

  readonly events = new Map<string, SourceEventRecord>();
  private readonly eventsById = new Map<string, SourceEventRecord>();
  private readonly receiptEventsByRep = new Map<string, SourceEventRecord[]>();
  private readonly settlementEventsByRep = new Map<string, SourceEventRecord[]>();
  readonly moves = new Map<string, ShadowMove>();
  /** القيود بترتيب إنشائها (حتمي) */
  readonly moveList: ShadowMove[] = [];
  /** GlMoveSource: sourceKey ⇒ moveId */
  readonly sources = new Map<string, string>();
  private readonly repostKeys = new Set<string>();
  private readonly linesByAccount = new Map<string, ShadowLine[]>();
  private readonly cursors = new Map<string, SyncCursorState>();
  /** وصول gl* مرفوض (يُفحص بعد كل مرحلة لأن المُرحِّل يبتلع أخطاء الحدث) */
  readonly glViolations: string[] = [];
  tooLarge = false;
  /** معاملات الترحيل المنفّذة (للتقدّم والتشخيص) */
  postTxCount = 0;
  /**
   * نبض نشاط: يستدعيه العميل الحارس عند كل قراءة تشغيلية — runPreview يحوّله نبضاً مقيَّداً بالزمن لصفّ المعاينة، فلا تُعلَّم
   * مرحلةٌ طويلة (تحميل حركات سنوات على قاعدة بـ٠٫١ نواة) منقطعةً (PREVIEW_STALE_MS) وهي تعمل.
   */
  activity: (() => void) | null = null;
  rollbacks = 0;

  private clockMs: number;
  private idSeq = 0;
  private moveSeq = 0;
  private readonly numberSeq = new Map<string, number>();
  private undo: (() => void)[] | null = null;
  private readonly queues: Record<Lane, { list: SourceEventRecord[]; head: number; dirty: boolean }> = {
    LIVE: { list: [], head: 0, dirty: false },
    IMPORT: { list: [], head: 0, dirty: false },
  };

  constructor(init: ShadowInit) {
    this.tenantId = init.tenantId;
    this.settingsRow = init.settingsRow;
    this.contextInput = init.contextInput;
    this.reconcileSettings = init.reconcileSettings;
    this.posterSettings = init.posterSettings;
    this.maxEvents = init.maxEvents ?? Number.POSITIVE_INFINITY;
    this.clockMs = init.now.getTime();
    this.context = ledgerContextFromInput(this.contextInput);
  }

  // ── الساعة ──

  now(): Date { return new Date(this.clockMs); }
  advanceClock(ms: number): void { this.clockMs += ms; }

  // ── سجلّ التراجع ──

  begin(): void {
    if (this.undo) throw new Error('معاملة ظلّ متداخلة');
    this.undo = [];
  }
  commit(): void { this.undo = null; }
  rollback(): void {
    const log = this.undo;
    this.undo = null;
    if (!log) return;
    for (let i = log.length - 1; i >= 0; i--) log[i]();
    this.rollbacks++;
  }
  get inTransaction(): boolean { return this.undo !== null; }
  private onUndo(fn: () => void): void { if (this.undo) this.undo.push(fn); }

  noteActivity(): void {
    if (this.activity) this.activity();
  }

  recordGlViolation(access: string): void {
    if (this.glViolations.length < 50) this.glViolations.push(access);
  }

  // ── الإعدادات للعميل الحارس ──

  settingsRowSelect(select: Record<string, unknown> | null): Record<string, unknown> {
    return project({ id: `shadow:${this.tenantId}`, tenantId: this.tenantId, ...this.settingsRow }, select);
  }

  // ── المؤشرات ──

  setCursor(source: SyncCursorSource, at: Date, id = ''): void {
    this.cursors.set(source, { source, watermarkAt: at, watermarkId: id, lastRunAt: null, lastCount: 0, stallTicks: 0 });
  }
  readCursor(source: string): SyncCursorState | null {
    const c = this.cursors.get(source);
    return c ? { ...c } : null;
  }
  readCursors(): SyncCursorState[] {
    return [...this.cursors.values()].map((c) => ({ ...c })).sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  }
  /** GREATEST كالتحديث المشروط في commitPage الحقيقي */
  advanceCursor(source: string, to: CompositeKey, rowCount: number): CompositeKey {
    const c = this.cursors.get(source);
    if (!c) return to;
    const next = maxCompositeKey({ at: c.watermarkAt, id: c.watermarkId }, to);
    this.cursors.set(source, { ...c, watermarkAt: next.at, watermarkId: next.id, lastRunAt: this.now(), lastCount: rowCount });
    return next;
  }
  recordStall(source: string): number {
    const c = this.cursors.get(source);
    if (!c) return 0;
    c.stallTicks++;
    return c.stallTicks;
  }

  // ── الأحداث ──

  private nextEventId(): string {
    this.idSeq++;
    return `pv-ev:${String(this.idSeq).padStart(9, '0')}`;
  }

  /** إدراج بمفتاحه (skipDuplicates) — يعيد true إن أُدرج */
  private addEvent(rec: SourceEventRecord): void {
    if (this.events.size >= this.maxEvents) {
      this.tooLarge = true;
      throw new ShadowTooLargeError(this.events.size + 1, this.maxEvents);
    }
    this.events.set(rec.sourceKey, rec);
    this.eventsById.set(rec.id, rec);
    const rep = rec.sourceType === 'RECEIPT' || rec.sourceType === 'SETTLEMENT' ? payloadRep(rec.payload) : null;
    const idx = rec.sourceType === 'RECEIPT' ? this.receiptEventsByRep : rec.sourceType === 'SETTLEMENT' ? this.settlementEventsByRep : null;
    if (idx && rep) {
      const list = idx.get(rep);
      if (list) list.push(rec); else idx.set(rep, [rec]);
    }
    this.enqueue(rec);
    this.onUndo(() => {
      this.events.delete(rec.sourceKey);
      this.eventsById.delete(rec.id);
      if (idx && rep) idx.get(rep)?.pop();
      this.idSeq--;
    });
  }

  /** DesiredEvent (المُطابِق، بوابة الأشقاء) ⇒ صفّ حدث كما يكتبه insertEvents/createMany الحقيقيان */
  insertDesired(events: readonly DesiredEvent[]): number {
    let n = 0;
    for (const e of events) {
      if (this.events.has(e.sourceKey)) continue;
      this.addEvent({
        id: this.nextEventId(), tenantId: this.tenantId, sourceKey: e.sourceKey, sourceType: e.sourceType, sourceId: e.sourceId,
        event: e.event, effectAt: new Date(e.effectAt), detectedAt: this.now(), payload: storedPayload(e.payload),
        status: e.status ?? 'PENDING', skipReason: e.skipReason ?? null, attempts: 0, nextAttemptAt: null, lastError: e.lastError ?? null,
        moveId: null, processedAt: null, nonCustodyClearedMilli: null, shortageRecoveredMilli: null,
      });
      n++;
    }
    return n;
  }

  /** صفوف glSourceEvent.createMany من العميل الحارس (scanFutureDatedRows، freezeOpeningSettlementSplits) */
  insertEventRows(rows: readonly Record<string, unknown>[], skipDuplicates: boolean): number {
    let n = 0;
    for (const r of rows) {
      const key = String(r.sourceKey);
      if (this.events.has(key)) {
        if (skipDuplicates) continue;
        throw Object.assign(new Error(`Unique constraint failed on the fields: (tenantId,sourceKey)`), {
          code: 'P2002', meta: { target: ['tenantId', 'sourceKey'] },
        });
      }
      this.addEvent({
        id: this.nextEventId(), tenantId: this.tenantId, sourceKey: key, sourceType: r.sourceType as SourceType,
        sourceId: String(r.sourceId), event: r.event as SourceEvent, effectAt: new Date(r.effectAt as Date),
        detectedAt: this.now(), payload: storedPayload(r.payload), status: ((r.status as EventStatus | undefined) ?? 'PENDING'),
        skipReason: (r.skipReason as SkipReason | null | undefined) ?? null, attempts: 0, nextAttemptAt: null,
        lastError: (r.lastError as string | null | undefined) ?? null, moveId: null,
        processedAt: r.processedAt ? new Date(r.processedAt as Date) : null,
        nonCustodyClearedMilli: bigOrNull(r.nonCustodyClearedMilli), shortageRecoveredMilli: bigOrNull(r.shortageRecoveredMilli),
      });
      n++;
    }
    return n;
  }

  private patchEvent(rec: SourceEventRecord, patch: SourceEventPatch): void {
    const before: Partial<SourceEventRecord> = {};
    for (const k of Object.keys(patch) as (keyof SourceEventPatch)[]) {
      if (patch[k] === undefined) continue;
      (before as Record<string, unknown>)[k] = rec[k];
      let v: unknown = patch[k];
      if (k === 'lastError' && typeof v === 'string') v = v.slice(0, 4000);
      (rec as unknown as Record<string, unknown>)[k] = v;
    }
    this.onUndo(() => { Object.assign(rec, before); });
  }

  updateEventById(id: string, patch: SourceEventPatch): void {
    const rec = this.eventsById.get(id);
    if (rec) this.patchEvent(rec, patch);
  }

  updateEventByKey(key: string, patch: SourceEventPatch, onlyIfStatusIn?: readonly EventStatus[]): number {
    const rec = this.events.get(key);
    if (!rec || (onlyIfStatusIn && !onlyIfStatusIn.includes(rec.status))) return 0;
    this.patchEvent(rec, patch);
    return 1;
  }

  /** recordFailure الحقيقي: لا يكتب فوق حالة نهائية */
  recordFailure(id: string, patch: SourceEventPatch): void {
    const rec = this.eventsById.get(id);
    if (rec && FAILURE_PATCHABLE.includes(rec.status)) this.patchEvent(rec, patch);
  }

  settlementEventsOfRep(salesRepId: string, select: Record<string, unknown> | null): Record<string, unknown>[] {
    return (this.settlementEventsByRep.get(salesRepId) ?? [])
      .filter((e) => this.events.get(e.sourceKey) === e)
      .map((e) => project(e as unknown as Record<string, unknown>, select));
  }

  repReceiptEvents(salesRepId: string, upTo: Date): { status: EventStatus; effectAt: Date }[] {
    const at = upTo.getTime();
    return (this.receiptEventsByRep.get(salesRepId) ?? [])
      .filter((e) => this.events.get(e.sourceKey) === e && (e.status === 'PENDING' || e.status === 'BLOCKED') && e.effectAt.getTime() <= at)
      .map((e) => ({ status: e.status, effectAt: e.effectAt }));
  }

  // ── طابور المستحق (بترتيب compareEventsForPosting، لكل مسار) ──

  private queueable(e: SourceEventRecord): boolean {
    return e.status === 'PENDING' || e.status === 'BLOCKED' || (e.status === 'ERROR' && e.nextAttemptAt !== null);
  }

  private enqueue(rec: SourceEventRecord): void {
    if (!this.queueable(rec)) return;
    const q = this.queues[laneOf(rec.sourceType)];
    // إدراج المُطابِق بالجملة خارج المعاملات ⇒ إعادة بناء كسولة؛ داخل معاملة (شقيق POST) ⇒ إدراج ثنائي
    if (q.dirty || !this.undo) { q.dirty = true; return; }
    let lo = 0;
    let hi = q.list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareEventsForPosting(q.list[mid], rec) <= 0) lo = mid + 1; else hi = mid;
    }
    q.list.splice(lo, 0, rec);
    if (lo < q.head) q.head = lo;
  }

  /** إعادة بناء الطابورين (بعد الإدراج بالجملة، وبعد تقديم الساعة) */
  rebuildQueues(): void {
    for (const lane of ['LIVE', 'IMPORT'] as const) {
      const q = this.queues[lane];
      q.list = [...this.events.values()].filter((e) => laneOf(e.sourceType) === lane && this.queueable(e)).sort(compareEventsForPosting);
      q.head = 0;
      q.dirty = false;
    }
  }

  listDue(opts: ListDueEventsOptions): SourceEventRecord[] {
    const now = opts.now.getTime();
    const inSet = opts.sourceTypes?.in ? new Set<string>(opts.sourceTypes.in) : null;
    const notIn = opts.sourceTypes?.notIn ? new Set<string>(opts.sourceTypes.notIn) : null;
    const typeOk = (t: string) => (!inSet || inSet.has(t)) && (!notIn || !notIn.has(t));
    const lanes: Lane[] = inSet ? [...new Set([...inSet].map(laneOf))]
      : notIn ? (['LIVE', 'IMPORT'] as Lane[]).filter((l) => l === 'LIVE' || [...IMPORT_TYPES].some((t) => !notIn.has(t)))
        : ['LIVE', 'IMPORT'];
    let excl: Set<string> | null = null;
    const excluded = (id: string): boolean => {
      if (!opts.excludeIds || opts.excludeIds.length === 0) return false;
      if (!excl) excl = this.excludeSetOf(opts.excludeIds);
      return excl.has(id);
    };
    const out: SourceEventRecord[] = [];
    for (const lane of lanes) {
      const q = this.queues[lane];
      if (q.dirty) this.rebuildQueues();
      while (q.head < q.list.length) {
        const r = q.list[q.head];
        if (this.events.get(r.sourceKey) === r && this.queueable(r)) break;
        q.head++;
      }
      let taken = 0;
      for (let i = q.head; i < q.list.length && taken < opts.limit; i++) {
        const r = q.list[i];
        if (this.events.get(r.sourceKey) !== r || !typeOk(r.sourceType)) continue;
        const due = r.status === 'PENDING'
          || ((r.status === 'BLOCKED' || r.status === 'ERROR') && r.nextAttemptAt !== null && r.nextAttemptAt.getTime() <= now);
        if (!due || excluded(r.id)) continue;
        out.push(r);
        taken++;
      }
    }
    return out.sort(compareEventsForPosting).slice(0, opts.limit);
  }

  /**
   * المُرحِّل يمرّر [...seen] كاملةً في كل دفعة (تنمو بالإلحاق داخل التشغيل): تُبنى المجموعة تزايدياً متى كانت المصفوفة
   * الجديدة امتداداً للسابقة (مقارنة === رخيصة) بدل Set جديدة من عشرات الآلاف لكل دفعة.
   */
  private readonly exclCache: { ids: string[]; set: Set<string> } = { ids: [], set: new Set() };
  private excludeSetOf(ids: readonly string[]): Set<string> {
    const c = this.exclCache;
    let prefix = ids.length >= c.ids.length;
    for (let i = 0; prefix && i < c.ids.length; i++) if (ids[i] !== c.ids[i]) prefix = false;
    if (!prefix) { c.ids = []; c.set = new Set(); }
    for (let i = c.ids.length; i < ids.length; i++) { c.ids.push(ids[i]); c.set.add(ids[i]); }
    return c.set;
  }

  countPending(): number {
    let n = 0;
    for (const e of this.events.values()) if (e.status === 'PENDING' || e.status === 'BLOCKED' || (e.status === 'ERROR' && e.nextAttemptAt !== null)) n++;
    return n;
  }

  /** ما زال BLOCKED أو ERROR قابل للإعادة */
  hasRetryable(): boolean {
    for (const e of this.events.values()) if (e.status === 'BLOCKED' || (e.status === 'ERROR' && e.nextAttemptAt !== null)) return true;
    return false;
  }

  openingImportCandidates(opts: { before: Date; after: CompositeKey | null; limit: number }): OpeningImportCandidate[] {
    const before = opts.before.getTime();
    // كالاستعلام الحقيقي: ERROR النهائي (بلا nextAttemptAt) مرشّح أيضاً، فالمسح على كل الأحداث لا على الطابور
    const rows = [...this.events.values()]
      .filter((e) => e.sourceType === 'AR_ENTRY' && e.event === 'POST'
        && (e.status === 'PENDING' || e.status === 'BLOCKED' || e.status === 'ERROR') && e.effectAt.getTime() < before
        && (!opts.after || compareCompositeKey({ at: e.effectAt, id: e.id }, opts.after) > 0))
      .sort((a, b) => compareCompositeKey({ at: a.effectAt, id: a.id }, { at: b.effectAt, id: b.id }))
      .slice(0, opts.limit);
    return rows.map((r) => {
      const p = r.payload && typeof r.payload === 'object' ? (r.payload as unknown as Record<string, unknown>) : null;
      return {
        id: r.id, sourceKey: r.sourceKey, sourceId: r.sourceId, effectAt: r.effectAt, status: r.status,
        createdAtHint: p ? (p.sourceCreatedAt ?? p.createdAt ?? null) : null,
        reverseStatus: this.events.get(`AR_ENTRY:${r.sourceId}:REVERSE`)?.status ?? null,
      };
    });
  }

  skipOpeningImports(ids: readonly string[], now: Date): number {
    let n = 0;
    for (const id of ids) {
      const e = this.eventsById.get(id);
      if (!e || e.sourceType !== 'AR_ENTRY' || e.event !== 'POST' || !['PENDING', 'BLOCKED', 'ERROR'].includes(e.status)) continue;
      this.patchEvent(e, { status: 'SKIPPED', skipReason: 'OPENING', processedAt: now, lastError: null, nextAttemptAt: null });
      n++;
    }
    return n;
  }

  // ── السياق وضرائب AUTO_SALE ──

  ensureAutoSaleTaxes(percents: readonly number[]): { created: string[]; context: LedgerContext | null } {
    const created: string[] = [];
    for (const pct of [...new Set(percents)].filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b)) {
      const key = autoSaleKey(pct);
      if (this.context.ctx.taxes.byKey(key)) continue;
      const tax: TaxRef = {
        id: `pv-tax:${key}`, key, name: `ضريبة مبيعات آلية ${pct}٪`, use: 'SALE', rate: pct, vatCategory: 'S', priceInclude: false,
        accountId: null, rcOutputAccountId: null, deductible: true, vatBox: null, isActive: true,
      };
      const prev = { extra: this.extraTaxes, context: this.context, had: this.autoSalePercents.has(pct) };
      this.extraTaxes = [...this.extraTaxes, tax];
      this.context = ledgerContextFromInput(this.contextInput, this.extraTaxes);
      this.autoSalePercents.add(pct);
      this.onUndo(() => {
        this.extraTaxes = prev.extra;
        this.context = prev.context;
        if (!prev.had) this.autoSalePercents.delete(pct);
      });
      created.push(key);
    }
    return { created, context: created.length ? this.context : null };
  }

  // ── الترحيل ──

  private lockDates(): LockDates {
    const s = this.posterSettings.snapshot;
    return { salesLockDate: s.salesLockDate, purchaseLockDate: s.purchaseLockDate, taxLockDate: s.taxLockDate, hardLockDate: s.hardLockDate };
  }

  /**
   * postMove الحقيقي في الذاكرة: validateMove ثم الإقفال ثم الدفتر ثم الرقم ثم القيد وسطوره وGlMoveSource والعكس.
   * التعارضات (sourceKey، reversedMoveId) تُفحص قبل أي تعديل وترمي P2002 بالشكل الذي يعرفه المُرحِّل.
   * lockPolicy 'NONE' للقيد الافتتاحي في المعاينة (P4 في الـpreflight يحجب الإقفال ≥ linkedFrom).
   */
  postDraft(input: MoveDraft, o: {
    context?: LedgerContext; validationMode?: ValidationMode; lockPolicy?: 'SHIFT' | 'REJECT' | 'NONE';
    reversedMoveId?: string | null; reversalReason?: string | null; createSource?: boolean;
  } = {}): PostedMove {
    const context = o.context ?? this.context;
    const ctx = context.ctx;
    const mode = o.validationMode ?? validationModeOf(input);
    const validated = validateMove(input, ctx, { mode });
    const policy = o.lockPolicy ?? (input.origin === 'AUTO' ? 'SHIFT' : 'REJECT');
    let draft = input;
    if (policy === 'SHIFT') draft = applyAutoLockShift(input, this.lockDates(), lockScopeOfDraft(input, ctx));
    else if (policy === 'REJECT') assertManualDateOpen(input.date, this.lockDates(), lockScopeOfDraft(input, ctx));
    const journal = (draft.journalSystemKey ? ctx.journals.bySystemKey(draft.journalSystemKey) : null) ?? ctx.journals.byCode(draft.journalCode);
    if (!journal) {
      throw new LedgerError('LEDGER_ACCOUNT_NOT_FOUND', {
        reason: 'JOURNAL_NOT_FOUND', journalCode: draft.journalCode, journalSystemKey: draft.journalSystemKey ?? null,
      });
    }
    const createSource = o.createSource !== false && !!draft.sourceKey && !!draft.sourceType && !!draft.sourceId && !!draft.sourceEvent;
    if (createSource && this.sources.has(draft.sourceKey as string)) {
      throw Object.assign(new Error('Unique constraint failed on the fields: (tenantId,sourceKey)'), { code: 'P2002', meta: { target: ['tenantId', 'sourceKey'] } });
    }
    const reversed = o.reversedMoveId ? this.moves.get(o.reversedMoveId) : null;
    if (o.reversedMoveId && !reversed) throw new GlNotFoundError('GlMove', o.reversedMoveId);
    if (reversed?.reversalId) {
      throw Object.assign(new Error('Unique constraint failed on the fields: (reversedMoveId)'), { code: 'P2002', meta: { target: ['reversedMoveId'] } });
    }

    const prefix = sequencePrefixFor(journal.code, draft.moveType, draft.sequencePrefix);
    const periodKey = draft.date.slice(0, 7);
    const groupKey = `${journal.id}|${prefix}|${periodKey}`;
    const n = (this.numberSeq.get(groupKey) ?? 0) + 1;
    this.numberSeq.set(groupKey, n);
    this.moveSeq++;
    const id = `pv:${this.moveSeq}`;
    let totalMilli = 0n;
    const lines: ShadowLine[] = validated.lines.map((r, i) => {
      totalMilli += r.line.debitMilli;
      return {
        moveId: id, seq: i, date: draft.date, accountId: r.account.id, label: r.line.label,
        debitMilli: r.line.debitMilli, creditMilli: r.line.creditMilli,
        customerId: r.line.customerId ?? null, vendorId: r.line.vendorId ?? null, salesRepId: r.line.salesRepId ?? null,
        partnerName: r.line.partnerName ?? null, analyticAccountId: r.line.analyticAccountId ?? null,
        productId: r.line.productId ?? null, quantity: r.line.quantity ?? null,
        taxId: r.tax?.id ?? r.line.taxId ?? null, taxRole: r.line.taxRole ?? null, taxBaseMilli: r.line.taxBaseMilli ?? null,
        vatBox: r.line.vatBox ?? null, vatAdjustment: r.line.vatAdjustment === true, dueDate: r.line.dueDate ?? null,
      };
    });
    const move: ShadowMove = {
      id, seq: this.moveSeq, number: `${prefix}/${periodKey}/${n}`, journalId: journal.id, journalCode: journal.code,
      journalSystemKey: journal.systemKey ?? null, date: draft.date, originalDate: draft.originalDate ?? null,
      lateArrival: draft.lateArrival === true, moveType: draft.moveType, origin: draft.origin, ref: draft.ref ?? null,
      narration: draft.narration, needsAttention: draft.needsAttention, attentionReason: draft.attentionReason ?? null,
      customerId: draft.customerId ?? null, vendorId: draft.vendorId ?? null, salesRepId: draft.salesRepId ?? null,
      sourceType: draft.sourceType ?? null, sourceId: draft.sourceId ?? null, sourceKey: createSource ? (draft.sourceKey as string) : null,
      sourceEvent: draft.sourceEvent ?? null, currencyCode: draft.currencyCode, currencyDecimals: draft.currencyDecimals,
      reversedMoveId: o.reversedMoveId ?? null, reversalId: null, reversalReason: o.reversalReason ?? null, totalMilli, lines,
    };
    this.moves.set(id, move);
    this.moveList.push(move);
    const touched: [ShadowLine[], number][] = [];
    for (const l of lines) {
      let arr = this.linesByAccount.get(l.accountId);
      if (!arr) { arr = []; this.linesByAccount.set(l.accountId, arr); }
      touched.push([arr, arr.length]);
      arr.push(l);
    }
    if (createSource) {
      this.sources.set(move.sourceKey as string, id);
      if (move.sourceKey!.includes(':REPOST')) this.repostKeys.add(move.sourceKey as string);
    }
    if (reversed) reversed.reversalId = id;
    this.onUndo(() => {
      if (reversed) reversed.reversalId = null;
      if (createSource) { this.sources.delete(move.sourceKey as string); this.repostKeys.delete(move.sourceKey as string); }
      for (let i = touched.length - 1; i >= 0; i--) touched[i][0].length = touched[i][1];
      this.moveList.pop();
      this.moves.delete(id);
      this.moveSeq--;
      if (n === 1) this.numberSeq.delete(groupKey); else this.numberSeq.set(groupKey, n - 1);
    });
    return {
      id, number: move.number, journalId: journal.id, date: draft.date, originalDate: move.originalDate, lateArrival: move.lateArrival,
      totalMilli, sequence: { journalId: journal.id, prefix, periodKey, n }, auditSeq: move.seq,
    };
  }

  private recordForDraft(m: ShadowMove): MoveRecordForDraft {
    return {
      moveType: m.moveType, origin: m.origin, date: toDbDate(m.date), originalDate: m.originalDate ? toDbDate(m.originalDate) : null,
      lateArrival: m.lateArrival, ref: m.ref, narration: m.narration, needsAttention: m.needsAttention, attentionReason: m.attentionReason,
      customerId: m.customerId, vendorId: m.vendorId, salesRepId: m.salesRepId, sourceType: m.sourceType, sourceId: m.sourceId,
      currencyCode: m.currencyCode, currencyDecimals: m.currencyDecimals,
      journal: { code: m.journalCode, systemKey: m.journalSystemKey },
      lines: m.lines.map((l) => ({
        accountId: l.accountId, label: l.label, debitMilli: l.debitMilli, creditMilli: l.creditMilli, customerId: l.customerId,
        vendorId: l.vendorId, salesRepId: l.salesRepId, partnerName: l.partnerName, analyticAccountId: l.analyticAccountId,
        productId: l.productId, quantity: l.quantity, taxId: l.taxId, taxRole: l.taxRole, taxBaseMilli: l.taxBaseMilli,
        vatBox: l.vatBox, vatAdjustment: l.vatAdjustment, dueDate: l.dueDate ? toDbDate(l.dueDate) : null,
      })),
    };
  }

  /** reverseMove الحقيقي بوضع SYSTEM: التاريخ max(المطلوب، الأصل) (أو max(اليوم، الأصل) بلا طلب) ثم الإزاحة */
  reverse(opts: Omit<ReverseMoveOptions, 'tenantId'>): ReverseResult {
    const orig = this.moves.get(opts.moveId);
    if (!orig) throw new GlNotFoundError('GlMove', opts.moveId);
    if (orig.reversalId) {
      const r = this.moves.get(orig.reversalId)!;
      return { alreadyReversed: true, original: { id: orig.id, number: orig.number }, reversal: { id: r.id, number: r.number, date: r.date } };
    }
    const reason = (opts.reason ?? '').trim() || 'إلغاء المستند المصدر';
    const date = opts.requestedDate
      ? maxLocalDate(opts.requestedDate, orig.date)
      : maxLocalDate(todayLocal(this.now(), this.posterSettings.timezone), orig.date);
    const draft = reversalDraftFromRecord(this.recordForDraft(orig), {
      date, reason, originalNumber: orig.number, sourceKey: opts.sourceKey ?? null, sourceEvent: opts.sourceEvent ?? null,
    });
    const posted = this.postDraft(draft, { validationMode: 'SYSTEM', lockPolicy: 'SHIFT', reversedMoveId: orig.id, reversalReason: reason });
    return {
      alreadyReversed: false, original: { id: orig.id, number: orig.number },
      reversal: { id: posted.id, number: posted.number, date: posted.date, posted },
    };
  }

  findLiveMove(baseKey: string): LiveMoveState {
    const ids: string[] = [];
    const base = this.sources.get(baseKey);
    if (base) ids.push(base);
    for (const k of this.repostKeys) if (k !== baseKey && isUnderPostPattern(k, baseKey)) ids.push(this.sources.get(k) as string);
    const posts = ids.map((i) => this.moves.get(i)).filter((m): m is ShadowMove => !!m && !m.reversedMoveId).sort((a, b) => a.seq - b.seq);
    const live = [...posts].reverse().find((m) => !m.reversalId);
    if (live) return { liveMoveId: live.id, existingReversalMoveId: null };
    const reversed = posts.filter((m) => m.reversalId).sort((a, b) => this.moves.get(a.reversalId!)!.seq - this.moves.get(b.reversalId!)!.seq);
    return { liveMoveId: null, existingReversalMoveId: reversed[reversed.length - 1]?.reversalId ?? null };
  }

  loadMoveLines(moveId: string): LiveMoveLine[] {
    return (this.moves.get(moveId)?.lines ?? []).map((l) => ({
      accountId: l.accountId, label: l.label, debitMilli: l.debitMilli, creditMilli: l.creditMilli, salesRepId: l.salesRepId,
      customerId: l.customerId, partnerName: l.partnerName, analyticAccountId: l.analyticAccountId,
    }));
  }

  listSourceKeysUnder(baseKey: string): string[] {
    const out = this.sources.has(baseKey) ? [baseKey] : [];
    for (const k of this.repostKeys) if (k.startsWith(`${baseKey}:`)) out.push(k);
    return out;
  }

  /** سطور حساب بترتيب الترحيل (للأرصدة والتعمّق) */
  linesOn(accountId: string): readonly ShadowLine[] {
    return this.linesByAccount.get(accountId) ?? [];
  }

  accountIdsWithLines(): string[] {
    return [...this.linesByAccount.entries()].filter(([, v]) => v.length > 0).map(([k]) => k);
  }
}

// ═══ بناء الظلّ من خيارات المعاينة ═══

export interface PreviewShadow {
  shadow: ShadowState;
  /** T0 = dbNow − LATE_COMMIT_WINDOW (openingSnapshotFromDbNow) */
  t0: Date;
  reconcileSettings: ReconcileSettings;
  posterSettings: PosterSettings;
  /** رموز حسابات دخل فئات في المسودة لا يعرفها القالب */
  unknownCategoryAccounts: string[];
}

/**
 * الظلّ كما يبنيه runPreview: صفّ الإعدادات الافتراضي (LINKED عند T0)، وسياق القالب، وإعدادات المُطابِق والمُرحِّل.
 * D9: setupMethod 'OPENING' في المُرحِّل = دلالة LINKED (cleanStart=false) — يُبدَّل بـ'LINKED' حين يعرفه PosterSettings (L0).
 */
export function createPreviewShadow(tenantId: string, opts: PreviewOptions, dbNow: Date, maxEvents?: number): PreviewShadow {
  const t0 = openingSnapshotFromDbNow(dbNow);
  const settingsRow = virtualSettingsRow(opts, opts.settingsRow, t0);
  const snapshot = settingsSnapshotFromRow(settingsRow);
  const vci = virtualContextInput({
    templateKey: opts.templateKey, countryCode: opts.countryCode, settings: snapshot, categoryIncomeAccounts: opts.categoryIncomeAccounts,
  });
  const reconcileSettings: ReconcileSettings = {
    tenantId, activatedAt: t0, timezone: opts.timezone, currency: opts.currency, currencyDecimals: opts.currencyDecimals,
  };
  const posterSettings: PosterSettings = {
    tenantId, suiteEnabled: true, activatedAt: t0, backfillState: 'RUNNING', setupMethod: 'OPENING', cutoverDate: opts.linkedFrom,
    openingSnapshotAt: t0, timezone: opts.timezone, inventoryMode: opts.inventoryMode, perpetualFromDate: opts.linkedFrom,
    currency: opts.currency, companyCurrency: opts.currency, lastSyncAt: null, snapshot,
  };
  const shadow = new ShadowState({ tenantId, settingsRow, contextInput: vci.contextInput, reconcileSettings, posterSettings, now: dbNow, maxEvents });
  return { shadow, t0, reconcileSettings, posterSettings, unknownCategoryAccounts: vci.unknownCategoryAccounts };
}

// ═══ المُطابِق ═══

export class ShadowReconcilerStore implements ReconcilerStore {
  private readonly ops: ReconcilerStore;

  constructor(private readonly shadow: ShadowState, client: Prisma.TransactionClient) {
    this.ops = createPrismaReconcilerStore(client as unknown as PrismaClient);
  }

  async dbNow(): Promise<Date> { return this.shadow.now(); }
  async loadSettings(tenantId: string): Promise<ReconcileSettings | null> {
    return tenantId === this.shadow.tenantId ? this.shadow.reconcileSettings : null;
  }
  async readCursor(_tenantId: string, source: ReconciledSource): Promise<SyncCursorState | null> { return this.shadow.readCursor(source); }
  readPage(tenantId: string, source: ReconciledSource, q: PageQuery): Promise<SourceRow[]> { return this.ops.readPage(tenantId, source, q); }
  loadFacts(tenantId: string, source: ReconciledSource, rows: readonly SourceRow[], settings: ReconcileSettings) {
    return this.ops.loadFacts(tenantId, source, rows, settings);
  }
  async commitPage(_tenantId: string, source: ReconciledSource, events: readonly DesiredEvent[], advanceTo: CompositeKey, rowCount: number): Promise<CommitPageResult> {
    const inserted = this.shadow.insertDesired(events);
    return { inserted, watermark: this.shadow.advanceCursor(source, advanceTo, rowCount) };
  }
  async insertEvents(_tenantId: string, events: readonly DesiredEvent[]): Promise<number> { return this.shadow.insertDesired(events); }
  async recordStall(_tenantId: string, source: ReconciledSource): Promise<number> { return this.shadow.recordStall(source); }
  hasUnreadRows(tenantId: string, source: ReconciledSource, watermark: CompositeKey, horizon: Date): Promise<boolean> {
    return this.ops.hasUnreadRows(tenantId, source, watermark, horizon);
  }
}

// ═══ المُرحِّل ═══

const MEMO_READS = new Set(['findMany', 'findFirst', 'findUnique', 'count', 'aggregate', 'groupBy']);

function stableKey(v: unknown): string {
  return JSON.stringify(v, (_k, x) => {
    if (typeof x === 'bigint') return `${x}n`;
    if (x && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Date)) {
      return Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]]));
    }
    return x;
  });
}

/**
 * تذكّر القراءات التشغيلية داخل اللقطة الثابتة (REPEATABLE READ: الاستعلام نفسه يعطي النتيجة نفسها): لمسار عهدة المندوب
 * الذي يقرأ سندات المندوب وفواتيره واستلاماته كلها عند كل استلام. gl* لا تُذكَّر (أحداث الظلّ تتغيّر) وتمرّ إلى العميل الحارس.
 */
function memoReads(client: Prisma.TransactionClient): Prisma.TransactionClient {
  const cache = new Map<string, Promise<unknown>>();
  const wrapped = new Map<string, unknown>();
  return new Proxy(client as object, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (typeof prop !== 'string' || prop.startsWith('$') || /^gl[A-Z]/.test(prop) || !v || typeof v !== 'object') {
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      }
      let w = wrapped.get(prop);
      if (!w) {
        w = new Proxy(v as object, {
          get(dt, method) {
            const fn = Reflect.get(dt, method);
            if (typeof fn !== 'function') return fn;
            if (typeof method !== 'string' || !MEMO_READS.has(method)) return (fn as (...a: unknown[]) => unknown).bind(dt);
            return (args: unknown) => {
              const key = `${prop}.${method}:${stableKey(args ?? null)}`;
              let p = cache.get(key);
              if (!p) {
                p = Promise.resolve((fn as (a: unknown) => unknown).call(dt, args));
                cache.set(key, p);
              }
              return p;
            };
          },
        });
        wrapped.set(prop, w);
      }
      return w;
    },
  }) as Prisma.TransactionClient;
}

class ShadowPostingTx implements PostingTx {
  readonly tenantId: string;
  constructor(private readonly s: ShadowState, private readonly ops: PrismaPostingTx, private readonly custody: PrismaPostingTx) {
    this.tenantId = s.tenantId;
  }

  async getEvent(sourceKey: string): Promise<SourceEventRecord | null> {
    const e = this.s.events.get(sourceKey);
    return e ? { ...e } : null;
  }
  async getSibling(sourceKey: string): Promise<SiblingState | null> {
    const e = this.s.events.get(sourceKey);
    return e ? { status: e.status, skipReason: e.skipReason, moveId: e.moveId } : null;
  }
  async insertEvents(events: readonly DesiredEvent[]): Promise<number> { return this.s.insertDesired(events); }
  async updateEvent(id: string, patch: SourceEventPatch): Promise<void> { this.s.updateEventById(id, patch); }
  async updateEventByKey(sourceKey: string, patch: SourceEventPatch, onlyIfStatusIn?: readonly EventStatus[]): Promise<number> {
    return this.s.updateEventByKey(sourceKey, patch, onlyIfStatusIn);
  }
  async findMoveIdBySourceKey(sourceKey: string): Promise<string | null> { return this.s.sources.get(sourceKey) ?? null; }
  async findLiveMove(baseKey: string): Promise<LiveMoveState> { return this.s.findLiveMove(baseKey); }
  async loadMoveLines(moveId: string): Promise<LiveMoveLine[]> { return this.s.loadMoveLines(moveId); }
  async listSourceKeysUnder(baseKey: string): Promise<string[]> { return this.s.listSourceKeysUnder(baseKey); }
  async loadContext(): Promise<LedgerContext> { return this.s.context; }
  /** الإعدادات الافتراضية ثابتة طوال المعاينة */
  async settingsVersion(): Promise<number | null> { return 1; }
  async ensureAutoSaleTaxes(percents: readonly number[]) { return this.s.ensureAutoSaleTaxes(percents); }
  async postMove(draft: MoveDraft, opts: Omit<PostMoveOptions, 'tenantId'>): Promise<PostedMove> {
    return this.s.postDraft(draft, {
      context: opts.context, validationMode: opts.validationMode, lockPolicy: opts.lockPolicy,
      reversedMoveId: opts.reversedMoveId, reversalReason: opts.reversalReason, createSource: opts.createSource,
    });
  }
  async reverseMove(opts: Omit<ReverseMoveOptions, 'tenantId'>): Promise<ReverseResult> { return this.s.reverse(opts); }
  loadCustodyInputs(salesRepId: string): Promise<CustodyComponentsInput> { return this.custody.loadCustodyInputs(salesRepId); }
  resolveOrigin(event: Pick<SourceEventRecord, 'sourceType' | 'sourceId' | 'event' | 'payload'>): Promise<OriginFacts | null> {
    return this.ops.resolveOrigin(event);
  }
  loadSourceData(sourceType: SourceType, sourceId: string, event: SourceEvent): Promise<SourceData> {
    return this.ops.loadSourceData(sourceType, sourceId, event);
  }
  async listRepReceiptEvents(salesRepId: string, upTo: Date) { return this.s.repReceiptEvents(salesRepId, upTo); }
  async dbNow(): Promise<Date> { return this.s.now(); }
  async listOpeningImportCandidates(opts: { before: Date; after: CompositeKey | null; limit: number }): Promise<OpeningImportCandidate[]> {
    return this.s.openingImportCandidates(opts);
  }
  async skipOpeningImports(ids: readonly string[], now: Date): Promise<number> { return this.s.skipOpeningImports(ids, now); }
}

export interface ShadowPostingHooks {
  /** بعد كل معاملة ترحيل (للتقدّم المقيَّد بالزمن) — أخطاؤه لا تمسّ الترحيل */
  afterTx?: () => void | Promise<void>;
}

export class ShadowPostingStore implements PostingStore {
  /** listDueEvents يحترم sourceTypes ⇒ المُرحِّل بمساري العدالة كالإنتاج */
  readonly filtersDueEventsBySourceType = true;
  private readonly ops: PrismaPostingTx;
  private readonly custody: PrismaPostingTx;
  private readonly reconciler: ReconcilerStore;

  constructor(private readonly shadow: ShadowState, client: Prisma.TransactionClient, private readonly hooks: ShadowPostingHooks = {}) {
    this.ops = new PrismaPostingTx(client, shadow.tenantId);
    this.custody = new PrismaPostingTx(memoReads(client), shadow.tenantId);
    this.reconciler = createPrismaReconcilerStore(client as unknown as PrismaClient);
  }

  async dbNow(): Promise<Date> { return this.shadow.now(); }
  async listEligibleTenants(): Promise<EligibleTenant[]> { return [{ tenantId: this.shadow.tenantId, lastSyncAt: null }]; }
  async loadPosterSettings(tenantId: string): Promise<PosterSettings | null> {
    return tenantId === this.shadow.tenantId ? { ...this.shadow.posterSettings } : null;
  }
  async tryAcquireLease(): Promise<boolean> { return true; }
  async releaseLease(): Promise<void> { /* لا عقد في الظلّ */ }
  async touchLastSync(): Promise<void> { /* لا شيء يُكتب */ }
  async readCursor(_tenantId: string, source: SyncCursorSource): Promise<SyncCursorState | null> { return this.shadow.readCursor(source); }
  async readCursors(): Promise<SyncCursorState[]> { return this.shadow.readCursors(); }
  hasUnreadRows(tenantId: string, _source: 'ACCOUNT_ENTRY', watermark: CompositeKey, horizon: Date): Promise<boolean> {
    return this.reconciler.hasUnreadRows(tenantId, 'ACCOUNT_ENTRY', watermark, horizon);
  }
  /** لا أحداث مخزون في الظلّ قبل L6 */
  async inventoryHorizon(): Promise<Date | null> { return null; }
  async inventoryBlockedHead(): Promise<{ effectAt: Date; sourceKey: string } | null> { return null; }
  async listDueEvents(_tenantId: string, opts: ListDueEventsOptions): Promise<SourceEventRecord[]> {
    return this.shadow.listDue(opts).map((e) => ({ ...e }));
  }
  async countPendingEvents(): Promise<number> { return this.shadow.countPending(); }
  async withPostLock<T>(_tenantId: string, fn: (tx: PostingTx) => Promise<T>): Promise<T> {
    this.shadow.begin();
    try {
      const r = await fn(new ShadowPostingTx(this.shadow, this.ops, this.custody));
      this.shadow.commit();
      return r;
    } catch (e) {
      this.shadow.rollback();
      throw e;
    } finally {
      this.shadow.postTxCount++;
      if (this.hooks.afterTx) {
        try { await this.hooks.afterTx(); } catch { /* التقدّم لا يُسقط الترحيل */ }
      }
    }
  }
  async recordFailure(_tenantId: string, eventId: string, patch: SourceEventPatch): Promise<void> {
    this.shadow.recordFailure(eventId, patch);
  }
}

// ═══ أرصدة الأستاذ للمطابقة ═══

export function shadowBalanceView(shadow: ShadowState): GlBalanceView {
  const pass = (l: ShadowLine, q?: GlBalanceQuery): boolean => {
    if (!q) return true;
    if (q.upTo && l.date > q.upTo) return false;
    if (!q.moveTypes && !q.excludeMoveTypes) return true;
    const mt = shadow.moves.get(l.moveId)!.moveType as string;
    if (q.moveTypes && !q.moveTypes.includes(mt)) return false;
    if (q.excludeMoveTypes && q.excludeMoveTypes.includes(mt)) return false;
    return true;
  };
  const uniq = (ids: readonly string[]) => [...new Set(ids)];
  return {
    accountIdByKey(key: string): string | null {
      return isMappingKey(key) ? shadow.context.ctx.accounts.byKey(key)?.id ?? null : null;
    },
    balanceByPartner(accountIds, partner, q) {
      const out = new Map<string, Milli>();
      for (const id of uniq(accountIds)) {
        for (const l of shadow.linesOn(id)) {
          if (!pass(l, q)) continue;
          const k = l[partner] ?? '';
          out.set(k, (out.get(k) ?? 0n) + l.debitMilli - l.creditMilli);
        }
      }
      return out;
    },
    total(accountIds, q) {
      let t = 0n;
      for (const id of uniq(accountIds)) for (const l of shadow.linesOn(id)) if (pass(l, q)) t += l.debitMilli - l.creditMilli;
      return t;
    },
    unbalancedMoves() {
      const out: { moveRef: string; sourceKey: string | null; debitMilli: Milli; creditMilli: Milli }[] = [];
      for (const m of shadow.moveList) {
        let d = 0n;
        let c = 0n;
        for (const l of m.lines) { d += l.debitMilli; c += l.creditMilli; }
        if (d !== c) out.push({ moveRef: m.number, sourceKey: m.sourceKey, debitMilli: d, creditMilli: c });
      }
      return out;
    },
    grandTotals() {
      let d = 0n;
      let c = 0n;
      for (const m of shadow.moveList) for (const l of m.lines) { d += l.debitMilli; c += l.creditMilli; }
      return { debitMilli: d, creditMilli: c };
    },
    linesOn(accountId, limit) {
      return [...shadow.linesOn(accountId)]
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : shadow.moves.get(a.moveId)!.seq - shadow.moves.get(b.moveId)!.seq || a.seq - b.seq))
        .slice(0, Math.max(0, limit))
        .map((l) => {
          const m = shadow.moves.get(l.moveId)!;
          return {
            moveRef: m.number, date: l.date, moveType: m.moveType, sourceKey: m.sourceKey, needsAttention: m.needsAttention,
            attentionReason: m.attentionReason, debitMilli: l.debitMilli, creditMilli: l.creditMilli,
          };
        });
    },
  };
}
