// M3 — مخزن PostingStore مزيّف في الذاكرة لاختبارات المُرحِّل (gl-idempotency، gl-no-session-locks، gl-ar-parity).
// ليس ملف اختبار: يفرض فرادة [tenantId, sourceKey] على الأحداث والربط، ويرمي عند التعارض خطأً بشكل Prisma
// {code:'P2002', meta:{target:[…]}}، ويُسقط كل ما كُتب داخل withPostLock عند أي رمية (لقطة ثم استعادة).
// postMove يستعمل validateMove الحقيقي على سياق القالب السعودي، فالحسابات الناقصة ترمي LEDGER_ACCOUNT_NOT_FOUND.
//
// «ربط الدفاتر» L4+L5+L8 (عقد §3.6): خيار linked يضبط linkedPosting في لقطة الإعدادات والسياق معاً؛ ensureLinkedAccounts
// تضيف 111004/112007/214002 إلى السياق (كما ينشئها PrismaPostingTx)، وreconcileStore مطابقة جزئية في الذاكرة، وreverseMove
// يطبّق OD17 للمربوطة وحدها بدالة vat/period نفسها التي يمرّرها PrismaPostingTx. غير المربوطة كما كانت حرفاً.
import { validateMove } from '../services/gl/validate';
import { accountIdOf, saContext, taxIdOf, templateContextInput, type FixtureOverrides } from '../services/gl/testing/fixtures';
import { maxLocalDate } from '../services/gl/dates';
import { isManualBooks } from '../services/gl/mode';
import { toMilli } from '../services/gl/money';
import { SA_6D_TEMPLATE } from '../services/gl/coa/sa';
import { SA_DEFAULT_PURCHASE_TAX_KEY, SA_TAXES } from '../services/gl/taxes/sa';
import { linkedAccountRefs } from '../services/gl/coa/linkedAccounts';
import { applyReversalVatPeriod, linkedReversalVatPeriod } from '../services/gl/vat/period';
import type { CustodyComponentsInput } from '../services/gl/custody';
import type { LedgerContext } from '../services/gl/resolve';
import type { PostMoveOptions, PostedMove } from '../services/gl/post';
import type { ReverseMoveOptions, ReverseResult } from '../services/gl/reverse';
import type { OpenControlLine, PartialInsert, ReconcileStore } from '../services/gl/reconcile/types';
import type { UserCustodyInputs } from '../services/userCustodyCore';
import {
  createBuildContext, DEFAULT_GL_SETTINGS,
  type AccountRef, type BuildContext, type LocalDate, type MethodAccountRef, type Milli, type MoveDraft, type TaxRef,
} from '../services/gl/types';
import { compareEventsForPosting, tombstoneOrigin, type LiveMoveState, type OriginFacts, type SiblingState } from '../services/gl/sync/classify';
import { isUnderPostPattern } from '../services/gl/sync/keys';
import type {
  EligibleTenant, ListDueEventsOptions, LiveMoveLine, PosterSettings, PostingStore, PostingTx, SourceData, WithPostLockOptions,
} from '../services/gl/sync/postingStore';
import type {
  CompositeKey, DesiredEvent, EventStatus, LeaseHandle, SourceEventPatch, SourceEventRecord, SourceEvent, SourceType, SyncCursorSource, SyncCursorState,
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
  // ── «ربط الدفاتر» (اختيارية: صفوف الاختبارات القديمة المكتوبة يدوياً بلا هذه الحقول) ──
  /** معرّف السطر (للمطابقة الجزئية) — الغائب ⇒ `${moveId}:${index}` */
  id?: string;
  adminUserId?: string | null;
  productId?: string | null;
  quantity?: number | null;
  dueDate?: LocalDate | null;
  vatBox?: string | null;
  vatAdjustment?: boolean;
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
  /** «ربط الدفاتر»: نوع القيد ورمز الدفتر (اختياريان للصفوف القديمة) */
  moveType?: string;
  journalCode?: string;
}

/** صف GlPartialReconcile في الذاكرة */
export interface FakePartial {
  id: string;
  debitLineId: string;
  creditLineId: string;
  debitMoveId: string;
  creditMoveId: string;
  amountMilli: Milli;
  sourceRef: string;
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
  /** حسابات أنشأتها ensureLinkedAccounts (تتراجع مع المعاملة) */
  extraAccounts: AccountRef[];
  partials: FakePartial[];
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
  // ── «ربط الدفاتر» L4+L5+L8 ──
  /** دفاتر مربوطة (D1): linkedPosting في لقطة إعدادات النبضة وسياق البناء معاً */
  linked?: boolean;
  /** صفوف GlPaymentMethodMap (methodKey ⇒ الحساب) — تُمرَّر لسياق البناء paymentMethodMaps */
  paymentMethodMaps?: Readonly<Record<string, MethodAccountRef>>;
  /** مدخلات طيّ عهدة مستخدم الشركة (loadUserCustodyInputs) */
  userCustody?: (userId: string) => UserCustodyInputs;
  /** صفوف RepSettlement غير مقروءة بعد مؤشر REP_SETTLEMENT حتى الأفق (الافتراضي true ⇒ المؤشر كما هو) */
  unreadRepSettlements?: (watermark: CompositeKey, horizon: Date) => boolean;
  /** false ⇒ لا reconcileStore في المعاملة (المخزن القديم بلا L8)؛ الافتراضي مطابقة في الذاكرة */
  reconcile?: boolean;
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
  /** «ربط الدفاتر»: استدعاءات ensureLinkedAccounts (للمربوطة وحدها، ومرة بالنبضة بعد الإنشاء الملتزم) */
  ensureLinkedCalls = 0;
  private mutex: Promise<unknown> = Promise.resolve();

  constructor(opts: FakeStoreOptions = {}) {
    this.opts = opts;
    this.tenantId = opts.tenantId ?? 't1';
    this.state = {
      events: new Map(), moves: new Map(), sources: new Map(), balances: new Map(), numbers: new Set(), cursors: new Map(),
      lease: { until: null, token: null }, lastSyncAt: null, extraTaxes: [], extraAccounts: [], partials: [], seq: 0, idSeq: 0,
    };
    this.settings = {
      tenantId: this.tenantId, suiteEnabled: true, activatedAt: new Date('2027-01-15T09:00:00.000Z'), backfillState: 'DONE',
      setupMethod: 'OPENING', cutoverDate: '2027-01-01', openingSnapshotAt: new Date('2027-01-15T09:00:00.000Z'),
      timezone: 'Asia/Riyadh', inventoryMode: 'PERIODIC', perpetualFromDate: null, currency: 'SAR', companyCurrency: 'SAR',
      lastSyncAt: null, snapshot: { ...DEFAULT_GL_SETTINGS }, ...(opts.settings ?? {}),
    };
    if (opts.linked) this.settings = { ...this.settings, snapshot: { ...this.settings.snapshot, linkedPosting: true } };
  }

  nowMs(): number { return (this.opts.now ?? Date.now)(); }

  context(): LedgerContext {
    const o = this.opts.context ?? {};
    const overrides: FixtureOverrides = {
      ...o,
      ...(this.opts.linked ? { settings: { ...(o.settings ?? {}), linkedPosting: true as const } } : {}),
      ...(this.state.extraAccounts.length ? { extraAccounts: [...(o.extraAccounts ?? []), ...this.state.extraAccounts] } : {}),
      extraTaxes: [...(o.extraTaxes ?? []), ...this.state.extraTaxes],
    };
    // خريطة الطرق (L5) لا تدخل FixtureOverrides: السياق يُبنى بالقالب نفسه الذي يبنيه saContext ومعه الخريطة
    const ctx: BuildContext = this.opts.paymentMethodMaps
      ? createBuildContext({
        ...templateContextInput(SA_6D_TEMPLATE, SA_TAXES, { defaultPurchaseTaxId: taxIdOf(SA_DEFAULT_PURCHASE_TAX_KEY) }, overrides),
        paymentMethodMaps: this.opts.paymentMethodMaps,
      })
      : saContext(overrides);
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
  /** Σ(مدين − دائن) لحساب ببُعد شريك (salesRepId أو adminUserId) */
  balanceBy(accountId: string, dim: 'salesRepId' | 'adminUserId', partnerId: string): Milli {
    let t = 0n;
    for (const m of this.state.moves.values()) for (const l of m.lines) {
      if (l.accountId === accountId && (l[dim] ?? null) === partnerId) t += l.debitMilli - l.creditMilli;
    }
    return t;
  }
  periodBalanceTotal(accountId: string): Milli {
    let t = 0n;
    for (const [k, v] of this.state.balances) if (k.startsWith(`${accountId}|`)) t += v.debit - v.credit;
    return t;
  }
  /** المطابقات الجزئية الحالية (L8) */
  partials(): FakePartial[] { return this.state.partials.map((p) => ({ ...p })); }
  /** المتبقّي غير المطابَق لسطر = |مدين − دائن| − Σ مطابقاته */
  lineResidual(lineId: string): Milli {
    const hit = findLine(this.state, lineId);
    if (!hit) throw new Error(`line ${lineId} not found`);
    const l = hit.move.lines[hit.index];
    const amt = l.debitMilli > 0n ? l.debitMilli : l.creditMilli;
    return amt - this.state.partials.filter((p) => p.debitLineId === lineId || p.creditLineId === lineId).reduce((a, p) => a + p.amountMilli, 0n);
  }

  // ── PostingStore ──
  async dbNow(): Promise<Date> { return new Date(this.nowMs()); }
  /** مرآة eligibleTenantsWhere: المفعّلة بعَلَم المجموعة بلا الدفاتر اليدوية */
  async listEligibleTenants(): Promise<EligibleTenant[]> {
    return isManualBooks(this.settings) ? [] : this.listCheckTenants();
  }
  async listCheckTenants(): Promise<EligibleTenant[]> {
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
  async hasUnreadRepSettlements(_t: string, watermark: CompositeKey, horizon: Date): Promise<boolean> {
    return this.opts.unreadRepSettlements ? this.opts.unreadRepSettlements(watermark, horizon) : true;
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

/** معرّف سطر مخزَّن: id المكتوب في postMove، أو `${moveId}:${index}` لصفوف الاختبارات القديمة */
const lineIdOf = (m: FakeMove, index: number): string => m.lines[index].id ?? `${m.id}:${index}`;

function findLine(state: State, lineId: string): { move: FakeMove; index: number } | null {
  for (const m of state.moves.values()) {
    for (let i = 0; i < m.lines.length; i++) if (lineIdOf(m, i) === lineId) return { move: m, index: i };
  }
  return null;
}

/** القيد الحيّ تحت نمط مفتاح POST (§5.4) — مشترك بين findLiveMove وliveMoveIdOf */
function liveMoveOf(state: State, baseKey: string): LiveMoveState {
  const posts = [...state.sources.entries()]
    .filter(([k]) => isUnderPostPattern(k, baseKey))
    .map(([, id]) => state.moves.get(id)!)
    .filter((m) => m && !m.reversedMoveId)
    .sort((a, b) => a.seq - b.seq);
  const live = [...posts].reverse().find((m) => !m.reversalId);
  if (live) return { liveMoveId: live.id, existingReversalMoveId: null };
  const last = posts.filter((m) => m.reversalId).pop();
  return { liveMoveId: null, existingReversalMoveId: last?.reversalId ?? null };
}

class FakeTx implements PostingTx {
  readonly tenantId: string;
  /** L8: مخزن المطابقة في الذاكرة — غائب حين reconcile=false (فالمُرحِّل لا يطابق) */
  reconcileStore?: () => ReconcileStore;
  constructor(private readonly s: FakePostingStore) {
    this.tenantId = s.tenantId;
    if (s.opts.reconcile !== false) this.reconcileStore = () => new FakeReconcileStore(s);
  }
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
  async findLiveMove(baseKey: string): Promise<LiveMoveState> { return liveMoveOf(this.st, baseKey); }
  async loadMoveLines(moveId: string): Promise<LiveMoveLine[]> {
    return (this.st.moves.get(moveId)?.lines ?? []).map((l) => ({
      accountId: l.accountId, label: l.label, debitMilli: l.debitMilli, creditMilli: l.creditMilli, salesRepId: l.salesRepId,
      customerId: l.customerId, partnerName: l.partnerName, analyticAccountId: l.analyticAccountId, adminUserId: l.adminUserId ?? null,
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
    const lines: FakeLine[] = v.lines.map((r, i) => ({
      accountId: r.account.id, label: r.line.label, debitMilli: r.line.debitMilli, creditMilli: r.line.creditMilli,
      customerId: r.line.customerId ?? null, salesRepId: r.line.salesRepId ?? null, partnerName: r.line.partnerName ?? null,
      analyticAccountId: r.line.analyticAccountId ?? null, taxId: r.tax?.id ?? r.line.taxId ?? null, taxRole: r.line.taxRole ?? null,
      taxBaseMilli: r.line.taxBaseMilli ?? null,
      id: `${id}:${i}`, adminUserId: r.line.adminUserId ?? null, productId: r.line.productId ?? null, quantity: r.line.quantity ?? null,
      dueDate: r.line.dueDate ?? null, vatBox: r.line.vatBox ?? r.tax?.vatBox ?? null, vatAdjustment: r.line.vatAdjustment === true,
    }));
    const move: FakeMove = {
      id, number, date: draft.date, originalDate: draft.originalDate ?? null, lateArrival: draft.lateArrival === true, seq: st.seq,
      sourceType: draft.sourceType ?? null, sourceId: draft.sourceId ?? null, reversedMoveId: opts.reversedMoveId ?? null,
      reversalId: null, needsAttention: draft.needsAttention, lines, moveType: draft.moveType, journalCode: draft.journalCode,
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
    let draft: MoveDraft = {
      kind: 'MOVE', journalCode: 'REV', moveType: 'ENTRY', origin: 'AUTO', date, narration: `عكس ${orig.number}`, needsAttention: false,
      sourceType: orig.sourceType as SourceType | null, sourceId: orig.sourceId, sourceKey: opts.sourceKey ?? null, sourceEvent: opts.sourceEvent ?? null,
      currencyCode: 'SAR', currencyDecimals: 2,
      lines: orig.lines.map((l) => ({
        accountId: l.accountId, label: `عكس ${l.label}`, debitMilli: l.creditMilli, creditMilli: l.debitMilli, customerId: l.customerId,
        salesRepId: l.salesRepId, partnerName: l.partnerName, analyticAccountId: l.analyticAccountId, taxId: l.taxId,
        taxRole: l.taxRole as 'BASE' | 'TAX' | 'MARKER' | null, taxBaseMilli: l.taxBaseMilli === null ? null : -l.taxBaseMilli,
        // «ربط الدفاتر»: الأبعاد الجديدة تُنسخ كما ينسخها moveDraftFromRecord (الغائب في الصفوف القديمة لا يُكتب)
        ...(l.adminUserId ? { adminUserId: l.adminUserId } : {}),
        ...(l.productId ? { productId: l.productId } : {}),
        ...(l.quantity != null ? { quantity: l.quantity } : {}),
        ...(l.dueDate ? { dueDate: l.dueDate } : {}),
        ...(l.vatBox ? { vatBox: l.vatBox } : {}),
        ...(l.vatAdjustment ? { vatAdjustment: true } : {}),
      })),
    };
    // OD17 للمربوطة وحدها: ما يمرّره PrismaPostingTx.reverseMove إلى reversalDraftFromRecord (vat/period)
    const vat = linkedReversalVatPeriod(this.s.context().ctx);
    if (vat) draft = applyReversalVatPeriod(draft, orig.date, vat);
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

  // ── «ربط الدفاتر» L5 وL8 (عقد §3.6) ──

  async loadUserCustodyInputs(userId: string): Promise<UserCustodyInputs> {
    return this.s.opts.userCustody?.(userId) ?? { userId, received: [], delivered: [], refunds: [] };
  }
  /** أحداث SETTLEMENT غير النهائية لاستلامات المستخدم (الحمولة المربوطة تحمل receivedByUserId) */
  async listUserFeedEvents(userId: string, upTo: Date) {
    return [...this.st.events.values()]
      .filter((e) => e.sourceType === 'SETTLEMENT' && (e.status === 'PENDING' || e.status === 'BLOCKED') && e.effectAt.getTime() <= upTo.getTime()
        && (e.payload as { receivedByUserId?: string | null } | null)?.receivedByUserId === userId)
      .map((e) => ({ status: e.status, effectAt: e.effectAt }));
  }
  async getReceiptReverse(receiptId: string) {
    const e = this.st.events.get(`RECEIPT:${receiptId}:REVERSE`);
    if (!e) return null;
    const p = e.payload as { refundEntryId?: string | null; cancelRefundFrom?: string | null } | null;
    return { status: e.status, refundEntryId: p?.refundEntryId ?? null, cancelRefundFrom: p?.cancelRefundFrom ?? null };
  }
  /** كـPrismaPostingTx: الناقص من 111004/112007/214002 يُضاف (ويتراجع مع المعاملة)، والسياق يُعاد حين أُنشئ شيء */
  async ensureLinkedAccounts(): Promise<{ created: string[]; context: LedgerContext | null }> {
    this.s.ensureLinkedCalls++;
    const ctx = this.s.context().ctx;
    const missing = linkedAccountRefs(accountIdOf).filter((a) => !ctx.accounts.byCode(a.code));
    this.st.extraAccounts.push(...missing);
    return { created: missing.map((a) => a.code), context: missing.length ? this.s.context() : null };
  }
}

/**
 * ReconcileStore في الذاكرة (عقد §3.7) فوق قيود المخزن المزيّف: سطور الحسابات الرقابية AR/AP للقيد بمتبقّيها، والقيد الحيّ،
 * والتخصيصات المرحَّلة غير المطابَقة (RI:<allocId> من حمولة RECEIPT:POST المنفّذ وقيده حيّ)، وإدراج متساوي الأثر وحذف.
 */
class FakeReconcileStore implements ReconcileStore {
  constructor(private readonly s: FakePostingStore) {}
  private get st(): State { return this.s.state; }

  private residual(lineId: string, amount: Milli): Milli {
    return amount - this.st.partials.filter((p) => p.debitLineId === lineId || p.creditLineId === lineId).reduce((a, p) => a + p.amountMilli, 0n);
  }

  async controlLinesOfMove(moveId: string, kind: 'AR' | 'AP'): Promise<OpenControlLine[]> {
    const m = this.st.moves.get(moveId);
    if (!m) return [];
    const ctx = this.s.context().ctx;
    const out: OpenControlLine[] = [];
    m.lines.forEach((l, i) => {
      if (ctx.accounts.byId(l.accountId)?.controlKind !== kind) return;
      const partnerId = kind === 'AR' ? l.customerId : null;
      if (!partnerId) return;
      const debit = l.debitMilli > 0n;
      const amountMilli = debit ? l.debitMilli : l.creditMilli;
      if (amountMilli === 0n) return;
      const lineId = lineIdOf(m, i);
      out.push({
        lineId, moveId: m.id, accountId: l.accountId, kind, partnerId, side: debit ? 'DEBIT' : 'CREDIT',
        amountMilli, residualMilli: this.residual(lineId, amountMilli), date: m.date, dueDate: l.dueDate ?? null, seq: i,
      });
    });
    return out;
  }
  async liveMoveIdOf(baseKey: string): Promise<string | null> { return liveMoveOf(this.st, baseKey).liveMoveId; }
  /** FIFO (M4 والتسوية الموجّهة): السطور المفتوحة للعميل على جانب، بالأقدم استحقاقاً ثم تاريخاً ثم ترتيباً */
  async openLinesOfPartner(kind: 'AR' | 'AP', partnerId: string, side: 'DEBIT' | 'CREDIT'): Promise<OpenControlLine[]> {
    const out: OpenControlLine[] = [];
    for (const m of [...this.st.moves.values()].sort((a, b) => a.seq - b.seq)) {
      for (const l of await this.controlLinesOfMove(m.id, kind)) {
        if (l.partnerId === partnerId && l.side === side && l.residualMilli > 0n) out.push(l);
      }
    }
    const key = (l: OpenControlLine) => l.dueDate ?? l.date;
    return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
  }
  async pendingAllocationsForInvoice(invoiceId: string): Promise<{ sourceRef: string; creditMoveId: string; amountMilli: bigint }[]> {
    const dec = this.s.context().ctx.settings.currencyDecimals;
    const out: { sourceRef: string; creditMoveId: string; amountMilli: bigint }[] = [];
    for (const e of this.st.events.values()) {
      if (e.sourceType !== 'RECEIPT' || e.event !== 'POST' || e.status !== 'DONE' || !e.moveId) continue;
      const live = liveMoveOf(this.st, e.sourceKey).liveMoveId;
      if (!live) continue;
      const allocs = (e.payload as { allocations?: readonly { id: string; invoiceId: string; amount: string }[] } | null)?.allocations ?? [];
      for (const a of allocs) {
        if (a.invoiceId !== invoiceId) continue;
        const sourceRef = `RI:${a.id}`;
        const matched = this.st.partials.filter((p) => p.sourceRef === sourceRef).reduce((t, p) => t + p.amountMilli, 0n);
        const left = toMilli(a.amount, dec) - matched;
        if (left > 0n) out.push({ sourceRef, creditMoveId: live, amountMilli: left });
      }
    }
    return out;
  }
  async partialsOfMoves(moveIds: string[]) {
    const ids = new Set(moveIds);
    return this.st.partials
      .filter((p) => ids.has(p.debitMoveId) || ids.has(p.creditMoveId))
      .map((p) => ({ id: p.id, debitLineId: p.debitLineId, creditLineId: p.creditLineId, amountMilli: p.amountMilli, sourceRef: p.sourceRef }));
  }
  async insertPartials(rows: readonly PartialInsert[]): Promise<number> {
    let n = 0;
    for (const r of rows) {
      // @@unique([tenantId, sourceRef, debitLineId, creditLineId]) + skipDuplicates
      if (this.st.partials.some((p) => p.sourceRef === r.sourceRef && p.debitLineId === r.debitLineId && p.creditLineId === r.creditLineId)) continue;
      if (r.amountMilli <= 0n) throw new Error(`partial ${r.sourceRef} بمبلغ غير موجب`);
      this.st.idSeq++;
      this.st.partials.push({ id: `pr${this.st.idSeq}`, ...r });
      n++;
    }
    return n;
  }
  async deletePartials(ids: readonly string[]): Promise<number> {
    const set = new Set(ids);
    const before = this.st.partials.length;
    this.st.partials = this.st.partials.filter((p) => !set.has(p.id));
    return before - this.st.partials.length;
  }
}
