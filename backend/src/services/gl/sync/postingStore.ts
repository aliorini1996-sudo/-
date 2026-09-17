/**
 * واجهة PostingStore (M3، DESIGN.md §5.1، §5.4) — كل ما يحتاجه المُرحِّل (poster.ts) والمجدول من القاعدة.
 *
 * - poster.ts لا يستورد prisma: يأخذ PostingStore. التنفيذ الفعلي sync/postingStore.prisma.ts (PrismaClient مستقل
 *   بـ?connection_limit=1)، والاختبارات بمخزن مزيّف في الذاكرة يفرض فرادة [tenantId, sourceKey] على gl_source_events
 *   وgl_move_sources، ويرمي عند التعارض خطأً بشكل Prisma {code:'P2002', meta:{target:['tenantId','sourceKey']}}
 *   (أو target:['tenantId','number'] لتعارض الترقيم) مع تراجع كامل لما كُتب داخل withPostLock.
 * - withPostLock: معاملة واحدة أول ما فيها pg_advisory_xact_lock(hashtext('gl-post:'||tid)) (acquirePostLock)،
 *   بمهلة POST_TX_TIMEOUT_MS. لا أقفال جلسة إطلاقاً (gl-no-session-locks).
 * - عقد الإيجار (§5.1) بساعة القاعدة: tryAcquireLease/releaseLease بـ$executeRaw ودون لمس updatedAt.
 * - هذا الملف أنواع فقط (لا تنفيذ، لا استيراد قيمي).
 */
import type { CustodyComponentsInput } from '../custody';
import type { PostMoveOptions, PostedMove } from '../post';
import type { LedgerContext } from '../resolve';
import type { ReverseMoveOptions, ReverseResult } from '../reverse';
import type { BackfillState, GlSettingsSnapshot, InventoryMode, LocalDate, Milli, MoveDraft, SourceEvent, SourceType } from '../types';
import type { LiveMoveState, OriginFacts, SiblingState } from './classify';
import type {
  CompositeKey, DesiredEvent, EventStatus, LeaseHandle, SourceEventPatch, SourceEventRecord, SyncCursorSource, SyncCursorState,
} from './types';

/** إعدادات المُرحِّل (GlSettings + عملة الشركة) كما تُقرأ في بداية نبضة الشركة */
export interface PosterSettings {
  tenantId: string;
  /** Tenant.accountingSuiteEnabled */
  suiteEnabled: boolean;
  activatedAt: Date | null;
  backfillState: BackfillState;
  setupMethod: 'OPENING' | 'FULL_HISTORY' | null;
  cutoverDate: LocalDate | null;
  /** T0 */
  openingSnapshotAt: Date | null;
  timezone: string;
  inventoryMode: InventoryMode;
  perpetualFromDate: LocalDate | null;
  /** GlSettings.currency (مجمّدة) */
  currency: string;
  /** عملة الشركة الحالية (Tenant/إعدادات الشركة) — لـHELD(CURRENCY_MISMATCH) */
  companyCurrency: string | null;
  lastSyncAt: Date | null;
  /** لقطة المحرك (المسارات والتواريخ المحلية وD2) */
  snapshot: GlSettingsSnapshot;
}

/** الشركات المؤهلة للنبضة: accountingSuiteEnabled=true وactivatedAt≠null، مرتبة بأقدم lastSyncAt (round‑robin) */
export interface EligibleTenant {
  tenantId: string;
  lastSyncAt: Date | null;
}

/** بيانات المستند الحيّة حين تغيب الحمولة أو لبناء عكس من المستند (§5.4: data = event.payload ?? sourceData) */
export type SourceData =
  | { kind: 'FOUND'; payload: unknown; /** أكبر createdAt لصفوف المصدر */ createdAt: Date }
  | { kind: 'MISSING' };

/** سطر من القيد الحيّ (لعكس P7/P8 أو استرداد r) — شكل MOVE_LINE_ENGINE_SELECT مختصراً */
export interface LiveMoveLine {
  accountId: string;
  label: string | null;
  debitMilli: Milli;
  creditMilli: Milli;
  salesRepId: string | null;
  customerId: string | null;
  partnerName: string | null;
  analyticAccountId: string | null;
}

/** عمليات داخل معاملة الترحيل (تحت قفل gl-post) */
export interface PostingTx {
  readonly tenantId: string;

  /** إعادة قراءة الحدث تحت القفل (null إن حُذف بإعادة الضبط) */
  getEvent(sourceKey: string): Promise<SourceEventRecord | null>;
  /** شقيق POST (أو أي مفتاح) كحالة البوابة */
  getSibling(sourceKey: string): Promise<SiblingState | null>;
  /** createMany({skipDuplicates}) — يعيد عدد المُدرج فعلاً */
  insertEvents(events: readonly DesiredEvent[]): Promise<number>;
  /** تحديث حدث بمعرّفه (للشركة وحدها) */
  updateEvent(id: string, patch: SourceEventPatch): Promise<void>;
  /** تحديث حدث بمفتاحه (شقيق POST في بوابة الأشقاء) — يعيد عدد المتأثر (0 إن لم يوجد أو تغيّرت حالته) */
  updateEventByKey(sourceKey: string, patch: SourceEventPatch, onlyIfStatusIn?: readonly EventStatus[]): Promise<number>;

  /** الربط القائم لمفتاح في gl_move_sources (بعد P2002 على sourceKey ⇒ DONE بنفس moveId) */
  findMoveIdBySourceKey(sourceKey: string): Promise<string | null>;
  /** «القيد الحيّ» (§5.4، §6.1): آخر GlMoveSource تحت نمط `<baseKey>*` ليس لقيده reversal، أو عكس قائم */
  findLiveMove(baseKey: string): Promise<LiveMoveState>;
  /** سطور قيد مرحّل (لـbuilders العكس التي تحتاج السطور: P6 غير ONLINE، P8) */
  loadMoveLines(moveId: string): Promise<LiveMoveLine[]>;
  /** مفاتيح المصادر تحت نمط الأساس (لـnextRepostIndex) */
  listSourceKeysUnder(baseKey: string): Promise<string[]>;

  /** سياق البناء بعد القفل (الحسابات والضرائب والدفاتر والإعدادات المعاد قراءتها) */
  loadContext(): Promise<LedgerContext>;
  /**
   * بصمة إعدادات البناء في GlSettings (D2 والمسارات) مقروءة داخل المعاملة بعد القفل — يعيد المُرحِّل تحميل السياق حين تتغير
   * (D2: التاريخ الساري لحظة الترحيل). اختياري: غيابه ⇒ السياق المخزَّن للنبضة كما هو.
   */
  settingsVersion?(): Promise<number | null>;
  /**
   * التزام M2 (5): ينشئ ضرائب AUTO_SALE_<pct> الناقصة (§4.4) متساوي الأثر قبل postMove، ويعيد سياقاً محدَّثاً إن أنشأ شيئاً.
   */
  ensureAutoSaleTaxes(percents: readonly number[]): Promise<{ created: string[]; context: LedgerContext | null }>;

  /** postMove(tx, draft, opts) القائم — يُنشئ GlMoveSource من draft.sourceKey داخل المعاملة (التزام M2 (4)) */
  postMove(draft: MoveDraft, opts: Omit<PostMoveOptions, 'tenantId'>): Promise<PostedMove>;
  /** reverseMove(tx, {mode:'SYSTEM', sourceKey, sourceEvent}) القائم */
  reverseMove(opts: Omit<ReverseMoveOptions, 'tenantId'>): Promise<ReverseResult>;

  /** مدخلات custodyComponents لمندوب مقروءة داخل المعاملة (التزام M2 (3) و(8): settlementInputsFrom) */
  loadCustodyInputs(salesRepId: string): Promise<CustodyComponentsInput>;
  /** resolveOrigin(event) (§5.4): للفاتورة والسند من أقدم صف AccountEntry للمصدر، وللاستلام والاستيراد من الحمولة */
  resolveOrigin(event: Pick<SourceEventRecord, 'sourceType' | 'sourceId' | 'event' | 'payload'>): Promise<OriginFacts | null>;
  /** بيانات المستند الحيّة (فاتورة/سند/…) بشكل حمولة §5.2 */
  loadSourceData(sourceType: SourceType, sourceId: string, event: SourceEvent): Promise<SourceData>;
  /** P7: أحداث RECEIPT للمندوب بحالة PENDING/BLOCKED بـeffectAt ≤ upTo (ترتيب §5.5) */
  listRepReceiptEvents(salesRepId: string, upTo: Date): Promise<{ status: EventStatus; effectAt: Date }[]>;
  /** ساعة القاعدة داخل المعاملة */
  dbNow(): Promise<Date>;

  /**
   * البند 4 (أ): مرشّحو حسم OPENING الجماعي — AR_ENTRY:POST بحالة PENDING/BLOCKED/ERROR وeffectAt < before، بترتيب
   * (effectAt, id) بعد after، مع حالة شقيق REVERSE. اختياري: غيابه ⇒ لا حسم جماعي (المسار الفردي كما هو).
   */
  listOpeningImportCandidates?(opts: { before: Date; after: CompositeKey | null; limit: number }): Promise<OpeningImportCandidate[]>;
  /**
   * updateMany: status=SKIPPED وskipReason=OPENING وprocessedAt=now وlastError/nextAttemptAt=null، بشرط id ∈ ids
   * وsourceType=AR_ENTRY وevent=POST وstatus ∈ (PENDING, BLOCKED, ERROR) — يعيد عدد المتأثر.
   */
  skipOpeningImports?(ids: readonly string[], now: Date): Promise<number>;
}

/** مرشّح حسم OPENING الجماعي كما يُقرأ تحت القفل */
export interface OpeningImportCandidate {
  id: string;
  sourceKey: string;
  sourceId: string;
  effectAt: Date;
  status: EventStatus;
  /** payload.sourceCreatedAt ?? payload.createdAt كما هو (selfRow في poster.ts يقرأ الشيء نفسه) */
  createdAtHint: unknown;
  /** حالة AR_ENTRY:<id>:REVERSE أو null إن لم يوجد */
  reverseStatus: EventStatus | null;
}

export interface WithPostLockOptions {
  /** الافتراضي POST_TX_TIMEOUT_MS */
  timeoutMs?: number;
}

export interface ListDueEventsOptions {
  now: Date;
  limit: number;
  /** استبعاد معرّفات عولجت في النبضة نفسها */
  excludeIds?: readonly string[];
  /** البند 4 (ب): ترشيح بالنوع (in أو notIn) — يُحترم فقط حين filtersDueEventsBySourceType=true */
  sourceTypes?: { in?: readonly SourceType[]; notIn?: readonly SourceType[] };
}

export interface PostingStore {
  // ── المجدول والعقد (§5.1) ──
  /** ساعة القاعدة (SELECT now()) */
  dbNow(): Promise<Date>;
  listEligibleTenants(limit?: number): Promise<EligibleTenant[]>;
  loadPosterSettings(tenantId: string): Promise<PosterSettings | null>;
  /**
   * UPDATE gl_settings SET workerLeaseUntil = NOW() + 90s, workerLeaseToken = token
   * WHERE tenantId = tid AND (workerLeaseUntil IS NULL OR workerLeaseUntil < NOW()) — true ⇔ النتيجة 1.
   */
  tryAcquireLease(tenantId: string, token: string): Promise<boolean>;
  /** UPDATE … SET workerLeaseUntil = NULL, workerLeaseToken = NULL WHERE tenantId = tid AND workerLeaseToken = token */
  releaseLease(lease: LeaseHandle): Promise<void>;
  /** lastSyncAt = now (بلا لمس updatedAt) بعد نبضة الشركة */
  touchLastSync(tenantId: string, at: Date): Promise<void>;

  // ── المؤشرات (يقرؤها المُرحِّل لبوابتي المخزون وP7) ──
  readCursor(tenantId: string, source: SyncCursorSource): Promise<SyncCursorState | null>;
  readCursors(tenantId: string): Promise<SyncCursorState[]>;
  /**
   * صفوف المصدر بعد المؤشر حتى الأفق (EXISTS نفسه في reconcilerStore) — للمؤشر الفعّال في ترتيب P7.
   * اختياري للمخازن المزيّفة القديمة: غيابه ⇒ المؤشر كما هو.
   */
  hasUnreadRows?(tenantId: string, source: 'ACCOUNT_ENTRY', watermark: CompositeKey, horizon: Date): Promise<boolean>;
  /** inventoryHorizon(tid) (§5.4، M9): min(watermarkAt لـACCOUNT_ENTRY وWAREHOUSE_ENTRY وVAN_LOAD) أو null */
  inventoryHorizon(tenantId: string): Promise<Date | null>;
  /** أبكر حدث مخزون ERROR/HELD/BLOCKED (رأس الطابور E0) */
  inventoryBlockedHead(tenantId: string): Promise<{ effectAt: Date; sourceKey: string } | null>;

  // ── الطابور (§5.4) ──
  /** PENDING، وBLOCKED/ERROR بـnextAttemptAt ≤ now، مرتبة effectAt ثم rank ثم sourceKey */
  listDueEvents(tenantId: string, opts: ListDueEventsOptions): Promise<SourceEventRecord[]>;
  /**
   * true ⇔ listDueEvents يحترم opts.sourceTypes، فيعمل المُرحِّل بمساري العدالة (البند 4 (ب)). غيابه (المخازن المزيّفة
   * القديمة) ⇒ الحلقة الواحدة بترتيب effectAt كما كانت.
   */
  readonly filtersDueEventsBySourceType?: boolean;
  /** PENDING + BLOCKED + ERROR(بـnextAttemptAt) — لـ202 {pendingEvents} ولشريط التقدم */
  countPendingEvents(tenantId: string): Promise<number>;

  /** معاملة الترحيل: القفل أولاً ثم fn؛ أي رمية تُسقط كل ما كُتب (ومنها P2002) */
  withPostLock<T>(tenantId: string, fn: (tx: PostingTx) => Promise<T>, opts?: WithPostLockOptions): Promise<T>;
  /** كتابة نتيجة فشل خارج المعاملة الساقطة (attempts، nextAttemptAt، lastError، status) */
  recordFailure(tenantId: string, eventId: string, patch: SourceEventPatch): Promise<void>;
}

/** للمخزن المزيّف والتنفيذ: شكل خطأ التعارض */
export type PostingStoreUniqueTarget = readonly ['tenantId', 'sourceKey'] | readonly ['tenantId', 'number'];

/** مؤشر المُطابِق كما يمرّره المُرحِّل لـsettlementOrderReady */
export type AccountEntryWatermark = CompositeKey | null;
