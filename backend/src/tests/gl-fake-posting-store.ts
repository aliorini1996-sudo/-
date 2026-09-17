// M3 — مخزن PostingStore مزيّف في الذاكرة لاختبارات المُرحِّل (gl-idempotency، gl-no-session-locks، gl-ar-parity).
// ليس ملف اختبار: يفرض فرادة [tenantId, sourceKey] على الأحداث والربط، ويرمي عند التعارض خطأً بشكل Prisma
// {code:'P2002', meta:{target:[…]}}، ويُسقط كل ما كُتب داخل withPostLock عند أي رمية (لقطة ثم استعادة).
// postMove يستعمل validateMove الحقيقي على سياق القالب السعودي، فالحسابات الناقصة ترمي LEDGER_ACCOUNT_NOT_FOUND.
import { validateMove } from '../services/gl/validate';
import { saContext, taxIdOf, type FixtureOverrides } from '../services/gl/testing/fixtures';
import { maxLocalDate } from '../services/gl/dates';
import type { CustodyComponentsInput } from '../services/gl/custody';
import type { LedgerContext } from '../services/gl/resolve';
import type { PostMoveOptions, PostedMove } from '../services/gl/post';
import type { ReverseMoveOptions, ReverseResult } from '../services/gl/reverse';
import { DEFAULT_GL_SETTINGS, type LocalDate, type Milli, type MoveDraft, type TaxRef } from '../services/gl/types';
import { compareEventsForPosting, tombstoneOrigin, type LiveMoveState, type OriginFacts, type SiblingState } from '../services/gl/sync/classify';
import { isUnderPostPattern } from '../services/gl/sync/keys';
import type {
  EligibleTenant, ListDueEventsOptions, LiveMoveLine, PosterSettings, PostingStore, PostingTx, SourceData, WithPostLockOptions,
} from '../services/gl/sync/postingStore';
import type {
  DesiredEvent, EventStatus, LeaseHandle, SourceEventPatch, SourceEventRecord, SourceEvent, SourceType, SyncCursorSource, SyncCursorState,
} from '../services/gl/sync/types';

export interface FakeLine {
  accountId: string;
  label: string;
  debitMilli: Milli;
  creditMilli: Milli;
  customerId: string | null;
  salesRepId: string | null;
  partnerName: string | null;
  analyticAccountId: string | null;
  taxId: string | null;
  taxRole: string | null;
  taxBaseMilli: Milli | null;
}

export interface FakeMove {
  id: string;
  number: string;
  date: LocalDate;
  originalDate: LocalDate | null;
  lateArrival: boolean;
  seq: number;
  sourceType: string | null;
  sourceId: string | null;
  reversedMoveId: string | null;
  reversalId: string | null;
  needsAttention: boolean;
  lines: FakeLine[];
}

interface State {
  events: Map<string, SourceEventRecord>;
  moves: Map<string, FakeMove>;
  sources: Map<string, string>;
  balances: Map<string, { debit: Milli; credit: Milli }>;
  numbers: Set<string>;
  cursors: Map<SyncCursorSource, SyncCursorState>;
  lease: { until: number | null; token: string | null };
  lastSyncAt: Date | null;
  extraTaxes: TaxRef[];
  seq: number;
  idSeq: number;
}

export interface FakeStoreOptions {
  tenantId?: string;
  settings?: Partial<PosterSettings>;
  context?: FixtureOverrides;
  /** ساعة القاعدة (ms) */
  now?: () => number;
  /** مدخلات العهدة لمندوب */
  custody?: (salesRepId: string) => CustodyComponentsInput;
  /** أصل المستند (للفاتورة والسند: أقدم صف AccountEntry) */
  origin?: (ev: Pick<SourceEventRecord, 'sourceType' | 'sourceId' | 'event' | 'payload'>) => OriginFacts | null;
  /** بيانات المستند الحيّة */
  sourceData?: (sourceType: SourceType, sourceId: string, event: SourceEvent) => SourceData;
  /** يُستدعى قبل كل postMove داخل المعاملة (لحقن P2002 على number مثلاً) */
  beforePostMove?: (draft: MoveDraft) => void;
  /** صفوف AccountEntry غير مقروءة بعد المؤشر حتى الأفق (الافتراضي true ⇒ المؤشر الفعّال = المؤشر كما هو) */
  unreadAccountEntries?: (watermark: { at: Date; id: string }, horizon: Date) => boolean;
  /** نسخة GlSettings داخل المعاملة (الافتراضي null ⇒ السياق المخزَّن للنبضة) */
  settingsVersion?: () => number | null;
}

const clone = <T>(v: T): T => structuredClone(v);

export class FakePostingStore implements PostingStore {
  readonly tenantId: string;
  state: State;
  settings: PosterSettings;
  opts: FakeStoreOptions;
  /** عدّاد استدعاءات المعاملة (للتأكد من القفل) */
  lockCalls = 0;
  ensureCalls: number[][] = [];
  private mutex: Promise<unknown> = Promise.resolve();

  constructor(opts: FakeStoreOptions = {}) {
    this.opts = opts;
    this.tenantId = opts.tenantId ?? 't1';
    this.state = {
      events: new Map(), moves: new Map(), sources: new Map(), balances: new Map(), numbers: new Set(), cursors: new Map(),
      lease: { until: null, token: null }, lastSyncAt: null, extraTaxes: [], seq: 0, idSeq: 0,
    };
    this.settings = {
      tenantId: this.tenantId, suiteEnabled: true, activatedAt: new Date('2027-01-15T09:00:00.000Z'), backfillState: 'DONE',
      setupMethod: 'OPENING', cutoverDate: '2027-01-01', openingSnapshotAt: new Date('2027-01-15T09:00:00.000Z'),
      timezone: 'Asia/Riyadh', inventoryMode: 'PERIODIC', perpetualFromDate: null, currency: 'SAR', companyCurrency: 'SAR',
      lastSyncAt: null, snapshot: { ...DEFAULT_GL_SETTINGS }, ...(opts.settings ?? {}),
    };
  }

  nowMs(): number { return (this.opts.now ?? Date.now)(); }

  context(): LedgerContext {
    const ctx = saContext({ ...(this.opts.context ?? {}), extraTaxes: [...(this.opts.context?.extraTaxes ?? []), ...this.state.extraTaxes] });
    return { ctx, settings: null, accounts: [], taxes: [], journals: [], accountById: new Map(), taxById: new Map(), journalById: new Map() };
  }

  // ── أدوات الاختبار ──
  seedEvents(events: readonly DesiredEvent[]): number { return insertInto(this.state, this.tenantId, events, this.nowMs()); }
  event(key: string): SourceEventRecord | undefined { return this.state.events.get(key); }
  moves(): FakeMove[] { return [...this.state.moves.values()]; }
  setCursor(source: SyncCursorSource, at: Date, id = ''): void {
    this.state.cursors.set(source, { source, watermarkAt: at, watermarkId: id, lastRunAt: null, lastCount: 0, stallTicks: 0 });
  }
  /** Σ(مدين − دائن) لحساب (ولعميل اختيارياً) */
  balance(accountId: string, customerId?: string): Milli {
    let t = 0n;
    for (const m of this.state.moves.values()) for (const l of m.lines) {
      if (l.accountId === accountId && (customerId === undefined || l.customerId === customerId)) t += l.debitMilli - l.creditMilli;
    }
    return t;
  }
  periodBalanceTotal(accountId: string): Milli {
    let t = 0n;
    for (const [k, v] of this.state.balances) if (k.startsWith(`${accountId}|`)) t += v.debit - v.credit;
    return t;
  }

  // ── PostingStore ──
  async dbNow(): Promise<Date> { return new Date(this.nowMs()); }
  async listEligibleTenants(): Promise<EligibleTenant[]> {
    return this.settings.activatedAt && this.settings.suiteEnabled ? [{ tenantId: this.tenantId, lastSyncAt: this.state.lastSyncAt }] : [];
  }
  async loadPosterSettings(tenantId: string): Promise<PosterSettings | null> {
    return tenantId === this.tenantId ? { ...this.settings, lastSyncAt: this.state.lastSyncAt } : null;
  }
  async tryAcquireLease(tenantId: string, token: string): Promise<boolean> {
    if (tenantId !== this.tenantId) return false;
    const now = this.nowMs();
    if (this.state.lease.until === null || this.state.lease.until < now) {
      this.state.lease = { until: now + 90_000, token };
      return true;
    }
    return false;
  }
  async releaseLease(lease: LeaseHandle): Promise<void> {
    if (lease.tenantId === this.tenantId && this.state.lease.token === lease.token) this.state.lease = { until: null, token: null };
  }
  async touchLastSync(_t: string, at: Date): Promise<void> { this.state.lastSyncAt = at; }
  async readCursor(_t: string, source: SyncCursorSource): Promise<SyncCursorState | null> { return this.state.cursors.get(source) ?? null; }
  async readCursors(): Promise<SyncCursorState[]> { return [...this.state.cursors.values()]; }
  async hasUnreadRows(_t: string, _source: 'ACCOUNT_ENTRY', watermark: { at: Date; id: string }, horizon: Date): Promise<boolean> {
    return this.opts.unreadAccountEntries ? this.opts.unreadAccountEntries(watermark, horizon) : true;
  }
  async inventoryHorizon(): Promise<Date | null> { return null; }
  async inventoryBlockedHead(): Promise<{ effectAt: Date; sourceKey: string } | null> { return null; }
  async listDueEvents(_t: string, opts: ListDueEventsOptions): Promise<SourceEventRecord[]> {
    const ex = new Set(opts.excludeIds ?? []);
    return [...this.state.events.values()]
      .filter((e) => !ex.has(e.id) && (e.status === 'PENDING'
        || ((e.status === 'BLOCKED' || e.status === 'ERROR') && e.nextAttemptAt !== null && e.nextAttemptAt.getTime() <= opts.now.getTime())))
      .sort(compareEventsForPosting)
      .slice(0, opts.limit)
      .map(clone);
  }
  async countPendingEvents(): Promise<number> {
    return [...this.state.events.values()].filter((e) => e.status === 'PENDING' || e.status === 'BLOCKED' || (e.status === 'ERROR' && e.nextAttemptAt !== null)).length;
  }
  async withPostLock<T>(_tenantId: string, fn: (tx: PostingTx) => Promise<T>, _opts?: WithPostLockOptions): Promise<T> {
    const run = async () => {
      this.lockCalls++;
      const snapshot = clone(this.state);
      try {
        return await fn(new FakeTx(this));
      } catch (e) {
        this.state = snapshot;
        throw e;
      }
    };
    const p = this.mutex.then(run, run);
    this.mutex = p.catch(() => undefined);
    return p;
  }
  async recordFailure(_t: string, eventId: string, patch: SourceEventPatch): Promise<void> {
    for (const e of this.state.events.values()) {
      if (e.id === eventId && ['PENDING', 'BLOCKED', 'ERROR', 'HELD'].includes(e.status)) Object.assign(e, patch);
    }
  }
}

function insertInto(state: State, tenantId: string, events: readonly DesiredEvent[], now: number): number {
  let n = 0;
  for (const e of events) {
    if (state.events.has(e.sourceKey)) continue; // skipDuplicates
    state.idSeq++;
    state.events.set(e.sourceKey, {
      id: `ev${state.idSeq}`, tenantId, sourceKey: e.sourceKey, sourceType: e.sourceType, sourceId: e.sourceId, event: e.event,
      effectAt: new Date(e.effectAt), detectedAt: new Date(now), payload: e.payload ? clone(e.payload) : null,
      status: e.status ?? 'PENDING', skipReason: e.skipReason ?? null, attempts: 0, nextAttemptAt: null, lastError: e.lastError ?? null,
      moveId: null, processedAt: null, nonCustodyClearedMilli: null, shortageRecoveredMilli: null,
    });
    n++;
  }
  return n;
}

export function p2002(target: string[]): Error & { code: 'P2002'; meta: { target: string[] } } {
  return Object.assign(new Error(`Unique constraint failed on the fields: (${target.join(',')})`), { code: 'P2002' as const, meta: { target } });
}

class FakeTx implements PostingTx {
  readonly tenantId: string;
  constructor(private readonly s: FakePostingStore) { this.tenantId = s.tenantId; }
  private get st(): State { return this.s.state; }

  async getEvent(key: string) { const e = this.st.events.get(key); return e ? clone(e) : null; }
  async getSibling(key: string): Promise<SiblingState | null> {
    const e = this.st.events.get(key);
    return e ? { status: e.status, skipReason: e.skipReason, moveId: e.moveId } : null;
  }
  async insertEvents(events: readonly DesiredEvent[]) { return insertInto(this.st, this.tenantId, events, this.s.nowMs()); }
  async updateEvent(id: string, patch: SourceEventPatch) {
    for (const e of this.st.events.values()) if (e.id === id) Object.assign(e, patch);
  }
  async updateEventByKey(key: string, patch: SourceEventPatch, only?: readonly EventStatus[]) {
    const e = this.st.events.get(key);
    if (!e || (only && !only.includes(e.status))) return 0;
    Object.assign(e, patch);
    return 1;
  }
  async findMoveIdBySourceKey(key: string) { return this.st.sources.get(key) ?? null; }
  async findLiveMove(baseKey: string): Promise<LiveMoveState> {
    const posts = [...this.st.sources.entries()]
      .filter(([k]) => isUnderPostPattern(k, baseKey))
      .map(([, id]) => this.st.moves.get(id)!)
      .filter((m) => m && !m.reversedMoveId)
      .sort((a, b) => a.seq - b.seq);
    const live = [...posts].reverse().find((m) => !m.reversalId);
    if (live) return { liveMoveId: live.id, existingReversalMoveId: null };
    const last = posts.filter((m) => m.reversalId).pop();
    return { liveMoveId: null, existingReversalMoveId: last?.reversalId ?? null };
  }
  async loadMoveLines(moveId: string): Promise<LiveMoveLine[]> {
    return (this.st.moves.get(moveId)?.lines ?? []).map((l) => ({
      accountId: l.accountId, label: l.label, debitMilli: l.debitMilli, creditMilli: l.creditMilli, salesRepId: l.salesRepId,
      customerId: l.customerId, partnerName: l.partnerName, analyticAccountId: l.analyticAccountId,
    }));
  }
  async listSourceKeysUnder(baseKey: string) { return [...this.st.sources.keys()].filter((k) => k === baseKey || k.startsWith(`${baseKey}:`)); }
  async loadContext() { return this.s.context(); }
  async settingsVersion() { return this.s.opts.settingsVersion ? this.s.opts.settingsVersion() : null; }
  async ensureAutoSaleTaxes(percents: readonly number[]) {
    this.s.ensureCalls.push([...percents]);
    const created: string[] = [];
    for (const pct of percents) {
      const key = `AUTO_SALE_${String(pct).replace('.', '_')}`;
      if (this.st.extraTaxes.some((t) => t.key === key)) continue;
      this.st.extraTaxes.push({
        id: taxIdOf(key), key, name: `ضريبة مبيعات آلية ${pct}٪`, use: 'SALE', rate: pct, vatCategory: 'S', priceInclude: false,
        accountId: null, rcOutputAccountId: null, deductible: true, vatBox: null, isActive: true,
      });
      created.push(key);
    }
    return { created, context: created.length ? this.s.context() : null };
  }

  async postMove(draft: MoveDraft, opts: Omit<PostMoveOptions, 'tenantId'>): Promise<PostedMove> {
    this.s.opts.beforePostMove?.(draft);
    const context = this.s.context();
    const v = validateMove(draft, context.ctx, { mode: opts.validationMode ?? 'SYSTEM' });
    const st = this.st;
    st.seq++;
    st.idSeq++;
    const id = `mv${st.idSeq}`;
    const number = `${draft.journalCode}/${draft.date.slice(0, 7)}/${String(st.seq).padStart(4, '0')}`;
    if (st.numbers.has(number)) throw p2002(['tenantId', 'number']);
    st.numbers.add(number);
    const lines: FakeLine[] = v.lines.map((r) => ({
      accountId: r.account.id, label: r.line.label, debitMilli: r.line.debitMilli, creditMilli: r.line.creditMilli,
      customerId: r.line.customerId ?? null, salesRepId: r.line.salesRepId ?? null, partnerName: r.line.partnerName ?? null,
      analyticAccountId: r.line.analyticAccountId ?? null, taxId: r.tax?.id ?? r.line.taxId ?? null, taxRole: r.line.taxRole ?? null,
      taxBaseMilli: r.line.taxBaseMilli ?? null,
    }));
    const move: FakeMove = {
      id, number, date: draft.date, originalDate: draft.originalDate ?? null, lateArrival: draft.lateArrival === true, seq: st.seq,
      sourceType: draft.sourceType ?? null, sourceId: draft.sourceId ?? null, reversedMoveId: opts.reversedMoveId ?? null,
      reversalId: null, needsAttention: draft.needsAttention, lines,
    };
    st.moves.set(id, move);
    if (opts.reversedMoveId) {
      const orig = st.moves.get(opts.reversedMoveId);
      if (!orig) throw new Error('reversed move not found');
      if (orig.reversalId) throw p2002(['reversedMoveId']);
      orig.reversalId = id;
    }
    if (opts.createSource !== false && draft.sourceKey) {
      if (st.sources.has(draft.sourceKey)) throw p2002(['tenantId', 'sourceKey']);
      st.sources.set(draft.sourceKey, id);
    }
    for (const l of lines) {
      if (l.taxRole === 'MARKER') continue;
      const k = `${l.accountId}|${draft.date.slice(0, 7)}`;
      const b = st.balances.get(k) ?? { debit: 0n, credit: 0n };
      b.debit += l.debitMilli;
      b.credit += l.creditMilli;
      st.balances.set(k, b);
    }
    return {
      id, number, journalId: 'j', date: draft.date, originalDate: move.originalDate, lateArrival: move.lateArrival,
      totalMilli: v.totalDebitMilli, sequence: { journalId: 'j', prefix: draft.journalCode, periodKey: draft.date.slice(0, 7), n: st.seq } as PostedMove['sequence'],
      auditSeq: st.seq,
    };
  }

  async reverseMove(opts: Omit<ReverseMoveOptions, 'tenantId'>): Promise<ReverseResult> {
    const orig = this.st.moves.get(opts.moveId);
    if (!orig) throw new Error(`move ${opts.moveId} not found`);
    if (orig.reversalId) {
      const r = this.st.moves.get(orig.reversalId)!;
      return { alreadyReversed: true, original: { id: orig.id, number: orig.number }, reversal: { id: r.id, number: r.number, date: r.date } };
    }
    const date = maxLocalDate(opts.requestedDate ?? orig.date, orig.date);
    const draft: MoveDraft = {
      kind: 'MOVE', journalCode: 'REV', moveType: 'ENTRY', origin: 'AUTO', date, narration: `عكس ${orig.number}`, needsAttention: false,
      sourceType: orig.sourceType as SourceType | null, sourceId: orig.sourceId, sourceKey: opts.sourceKey ?? null, sourceEvent: opts.sourceEvent ?? null,
      currencyCode: 'SAR', currencyDecimals: 2,
      lines: orig.lines.map((l) => ({
        accountId: l.accountId, label: `عكس ${l.label}`, debitMilli: l.creditMilli, creditMilli: l.debitMilli, customerId: l.customerId,
        salesRepId: l.salesRepId, partnerName: l.partnerName, analyticAccountId: l.analyticAccountId, taxId: l.taxId,
        taxRole: l.taxRole as 'BASE' | 'TAX' | 'MARKER' | null, taxBaseMilli: l.taxBaseMilli === null ? null : -l.taxBaseMilli,
      })),
    };
    const posted = await this.postMove(draft, { actor: opts.actor, validationMode: 'SYSTEM', reversedMoveId: orig.id, reversalReason: opts.reason });
    return { alreadyReversed: false, original: { id: orig.id, number: orig.number }, reversal: { id: posted.id, number: posted.number, date: posted.date, posted } };
  }

  async loadCustodyInputs(salesRepId: string): Promise<CustodyComponentsInput> {
    return this.s.opts.custody?.(salesRepId) ?? {
      receipts: [], onlineReceipts: [], outsideReceipts: [], cashInvoices: [], settlements: [], shortages: [], custodyExpenses: [],
      routing: { cashInvoice: 'MAIN_CASH' },
    };
  }
  async resolveOrigin(ev: Pick<SourceEventRecord, 'sourceType' | 'sourceId' | 'event' | 'payload'>): Promise<OriginFacts | null> {
    if (this.s.opts.origin) return this.s.opts.origin(ev);
    return tombstoneOrigin(ev.sourceType, ev.payload);
  }
  async loadSourceData(t: SourceType, id: string, e: SourceEvent): Promise<SourceData> {
    return this.s.opts.sourceData?.(t, id, e) ?? { kind: 'MISSING' };
  }
  async listRepReceiptEvents(salesRepId: string, upTo: Date) {
    return [...this.st.events.values()]
      .filter((e) => e.sourceType === 'RECEIPT' && (e.status === 'PENDING' || e.status === 'BLOCKED') && e.effectAt.getTime() <= upTo.getTime()
        && (e.payload as { salesRepId?: string } | null)?.salesRepId === salesRepId)
      .map((e) => ({ status: e.status, effectAt: e.effectAt }));
  }
  async dbNow() { return new Date(this.s.nowMs()); }
}

