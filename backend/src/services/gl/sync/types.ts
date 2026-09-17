/**
 * عقود المزامنة المشتركة (M3، DESIGN.md §3.4، §5.1، §5.2، §5.4، §5.6).
 *
 * أنواع وثوابت فقط (مع مساعدات صغيرة صرفة للمؤشر المركّب وأخطاء Prisma): المُطابِق والمُرحِّل والمجدول وخطافات
 * الحذف والفحوص والمسارات تستوردها من هنا، فلا يعيد أحد تعريف حالة أو سبب أو شكل حمولة.
 * لا استيراد لـprisma هنا (قيمةً أو نوعاً).
 *
 * الحمولة (§5.2): لقطة ثابتة لحظة الأثر، **المبالغ نصوص** (Json لا يحمل BigInt)، والتواريخ الزمنية ISO،
 * والتواريخ المحاسبية المحلية 'YYYY-MM-DD'. أشكالها هي مدخلات الـbuilders القائمة نفسها (M1) لا نسخ منها.
 */
import type { InvoicePayload } from '../builders/invoice';
import type { ReceiptPostPayload, ReceiptReversePayload } from '../builders/receipt';
import type { SettlementPayload } from '../builders/custody';
import type { ImportEntryPayload } from '../builders/importEntry';
import type { PaylinkFeePayload, PayoutPayload } from '../builders/paylink';
import { LOCK_SYNC_HEARTBEAT_MS, LOCK_SYNC_LATE_COMMIT_WINDOW_MS, SYNC_CURSOR_SOURCES, type SyncCursorSource } from '../locks';
import {
  EVENT_HOLD_REASONS, EVENT_STATUSES, SKIP_REASONS, SOURCE_EVENTS, SOURCE_TYPES,
  type BackfillState, type EventHoldReason, type EventStatus, type LocalDate, type Milli, type SkipReason,
  type SourceEvent, type SourceType,
} from '../types';

// ═══ إعادة تصدير القواميس القائمة (مصدر واحد: services/gl/types.ts وlocks.ts) ═══

export {
  EVENT_HOLD_REASONS, EVENT_STATUSES, SKIP_REASONS, SOURCE_EVENTS, SOURCE_TYPES, SYNC_CURSOR_SOURCES,
};
export type { EventHoldReason, EventStatus, SkipReason, SourceEvent, SourceType, SyncCursorSource };

// ═══ الثوابت (§5.1، §5.2، §5.4) ═══

/** LATE_COMMIT_WINDOW = 10 دقائق (§5.2 البند 1) — القيمة نفسها في locks.ts؛ sync/constants.ts إن أُنشئ يعيد تصديرها. */
export const LATE_COMMIT_WINDOW_MS = LOCK_SYNC_LATE_COMMIT_WINDOW_MS;
/** نبضة المجدول (§5.1) */
export const SYNC_HEARTBEAT_MS = LOCK_SYNC_HEARTBEAT_MS;
/** عقد الإيجار في gl_settings (§5.1): NOW() + INTERVAL '90 seconds' */
export const WORKER_LEASE_SECONDS = 90;
/** ميزانية النبضة العامة لكل الشركات (§5.1) */
export const TICK_DB_BUDGET_MS = 3_000;
export const TICK_EVENT_BUDGET = 300;
/** قبل كل معاملة ترحيل يتوقف المُرحِّل إن تجاوزت النبضة هذا (§5.1 البند 3) */
export const TICK_POST_CUTOFF_MS = 60_000;
/** صفحة المُطابِق لكل مصدر (§5.1، §5.2) */
export const RECONCILE_PAGE_SIZE = 500;
/** «مزامنة الآن» (§5.1): نبضة محدودة، ومرة كل 60 ثانية لكل شركة */
export const MANUAL_SYNC_BUDGET_MS = 2_000;
export const MANUAL_SYNC_MIN_INTERVAL_MS = 60_000;
/** شبكة الأمان (§5.2 البند 4): آخر 24 ساعة كل 30 دقيقة */
export const SAFETY_NET_LOOKBACK_MS = 24 * 60 * 60_000;
export const SAFETY_NET_INTERVAL_MS = 30 * 60_000;
/** مهلة معاملة الترحيل (§5.4) */
export const POST_TX_TIMEOUT_MS = 15_000;
/** تراجع ERROR (§5.4): 1m، 5m، 30m، 2h، 12h ثم ERROR نهائي بلا nextAttemptAt بعد خمس محاولات */
export const ERROR_BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];
export const MAX_ERROR_ATTEMPTS = 5;
/** إعادة جدولة BLOCKED (§5.4): 1m ثم 5m ثم 30m ثم 2h (ويبقى 2h) — لا تُحتسب في ميزانية الأحداث */
export const BLOCKED_BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
/** ترتيب المعالجة (§5.4): effectAt ثم rank(POST<COGS<RESTOCK<REVERSE) ثم sourceKey */
export const EVENT_RANK: Readonly<Record<SourceEvent, number>> = { POST: 0, COGS: 1, RESTOCK: 2, REVERSE: 3 };
/** حالات الحدث التي يلتقطها المُرحِّل (PENDING دائماً، والباقيتان بـnextAttemptAt ≤ now) */
export const POSTER_PICKUP_STATUSES = ['PENDING', 'BLOCKED', 'ERROR'] as const satisfies readonly EventStatus[];
/** حالات نهائية لبوابة الأشقاء (§5.4) */
export const FINAL_EVENT_STATUSES = ['DONE', 'SKIPPED'] as const satisfies readonly EventStatus[];
/** مصادر المبيعات التي تخضع لـHELD(CURRENCY_MISMATCH) (§5.4، §5.8) */
export const SALES_SOURCE_TYPES = ['INVOICE', 'RECEIPT', 'AR_ENTRY', 'SETTLEMENT', 'PAYLINK_FEE', 'PAYOUT', 'CUSTOMER_ADJUSTMENT'] as const satisfies readonly SourceType[];
/** مصادر tombstone: قد يُحذف صفها فتُقرأ الحمولة وحدها (§5.3، §5.4) */
export const TOMBSTONE_SOURCE_TYPES = ['SETTLEMENT', 'AR_ENTRY'] as const satisfies readonly SourceType[];
/** مصادر المخزون الخاضعة للأفق الآمن (§5.4، M9) — ومعها أحداث COGS وRESTOCK */
export const INVENTORY_SOURCE_TYPES = ['WH_ENTRY', 'VAN_LOAD', 'RESTOCK'] as const satisfies readonly SourceType[];

/**
 * مسارا العدالة داخل الشركة (البند 4 (ب)): أحداث الاستيراد (AR_ENTRY) في مسار، وكل ما سواها (المستندات الحية) في آخر.
 * AR_ENTRY لا يعتمد على ترتيب المخزون ولا P7، وبوابة الأشقاء تحمي REVERSE، فلا يلزم ترتيب effectAt عبر المسارين.
 */
export const IMPORT_LANE_SOURCE_TYPES = ['AR_ENTRY'] as const satisfies readonly SourceType[];
/** نمط التناوب بين المسارين: 3 من 5 للمستندات الحية (~60٪) والباقي للاستيراد؛ مسار فارغ يترك دوره للآخر */
export const POSTER_LANE_PATTERN: readonly ('LIVE' | 'IMPORT')[] = ['LIVE', 'IMPORT', 'LIVE', 'IMPORT', 'LIVE'];
/** حسم OPENING الجماعي (البند 4 (أ)): معاملة لكل دفعة من المئات تحت قفل gl-post، وسقف دفعات لكل نبضة شركة */
export const OPENING_BULK_BATCH_SIZE = 500;
export const OPENING_BULK_MAX_BATCHES = 10;
/** حصة الحسم الجماعي من زمن الميزانية المتبقي عند بدئه: الباقي للمستندات الحية والاستيراد المرحَّل في النبضة نفسها */
export const OPENING_BULK_TIME_SHARE = 0.5;
/** سبب «يحتاج انتباهاً» لحركة مستوردة بتاريخ ≥ البدء بلا وصول متأخر (البند 7 (أ)) */
export const IMPORT_AFTER_CUTOVER_ATTENTION_REASON = 'حركة مستوردة بعد تاريخ البدء رُحّلت إلى 319002 — راجع تصنيفها';

/** مصدر كل مؤشر ⇒ أنواع الأحداث التي يولّدها (§5.2) */
export const CURSOR_SOURCE_EVENT_TYPES: Readonly<Record<SyncCursorSource, readonly SourceType[]>> = {
  ACCOUNT_ENTRY: ['INVOICE', 'RECEIPT', 'AR_ENTRY'],
  REP_SETTLEMENT: ['SETTLEMENT'],
  SETTLEMENT_ENTRY: ['PAYLINK_FEE', 'PAYOUT'],
  WAREHOUSE_ENTRY: ['WH_ENTRY'],
  VAN_LOAD: ['VAN_LOAD'],
  RETURN_RESTOCK: ['RESTOCK'],
};

// ═══ أسباب الحجب المؤقت BLOCKED والإبقاء PENDING ═══

export const BLOCK_REASONS = [
  /** شقيق POST ليس نهائياً والمصدر قائم (§5.4) */
  'SIBLING_NOT_FINAL',
  /** لا POST والمصدر قائم وغير مشمول بالافتتاح: ينتظر المُطابِق (§5.4 (ب)) */
  'AWAITING_RECONCILER',
  /** P7: مؤشر ACCOUNT_ENTRY لم يتجاوز settlement.createdAt، أو للمندوب RECEIPT PENDING/BLOCKED بـeffectAt ≤ settledAt (§5.5) */
  'SETTLEMENT_ORDER',
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

/** أسباب إبقاء حدث مخزون PENDING بلا attempts++ ولا BLOCKED (§5.4) */
export const PENDING_HOLD_REASONS = ['INVENTORY_HORIZON', 'INVENTORY_HEAD_OF_LINE'] as const;
export type PendingHoldReason = (typeof PENDING_HOLD_REASONS)[number];

// ═══ الحمولات (§5.2) ═══

/** حقول مشتركة في كل حمولة يكتبها المُطابِق أو الـtombstone */
export interface EventPayloadMeta {
  /** أكبر createdAt (ISO) بين صفوف المفتاح لحظة الكشف — لاختبار اللقطة (§5.2 آخر بند، §5.6) */
  sourceCreatedAt?: string | null;
}

/** INVOICE:<id>:POST — InvoicePayload كما يقرؤها buildInvoiceMove (سلال الضريبة وأوزان البنود من items)، المبالغ نصوص */
export type InvoicePostEventPayload = InvoicePayload & EventPayloadMeta;

/** INVOICE:<id>:REVERSE — التاريخ المحلي لصف العكس (INVOICE_CREDIT، أو INVOICE_DEBIT للمرتجع) */
export interface InvoiceReverseEventPayload extends EventPayloadMeta {
  invoiceId: string;
  type: InvoicePayload['type'];
  entryDate: LocalDate;
}

/** RECEIPT:<id>:POST — ReceiptPostPayload (paylinkId من CustomerPaymentLink.receiptId لا clientRef) ومعها لقطات العرض */
export interface ReceiptPostEventPayload extends ReceiptPostPayload, EventPayloadMeta {
  receiptId: string;
  number?: string | null;
  /** التاريخ المحلي لـentryDate صف RECEIPT_CREDIT */
  entryDate: LocalDate;
  customerName?: string | null;
  salesRepName?: string | null;
  /** المبلغ نص */
  amount: string;
}

/** RECEIPT:<id>:REVERSE — لسند ONLINE: {paylinkId|null, refundEntryId|null, refundedAmount} من SettlementEntry kind=REFUND */
export interface ReceiptReverseEventPayload extends ReceiptReversePayload, EventPayloadMeta {
  receiptId: string;
  /** التاريخ المحلي لصف RECEIPT_DEBIT */
  entryDate: LocalDate;
  paymentMethod?: string | null;
  refundedAmount?: string | null;
}

/**
 * AR_ENTRY:<entryId>:POST|REVERSE — {entryId, customerId, customerName (لقطة)، debit, credit, description, entryDate, createdAt}.
 * الـtombstone يكتب الحمولة نفسها في المفتاحين. entryDate وcreatedAt ISO، والمبالغ نصوص.
 */
export interface ArEntryEventPayload extends ImportEntryPayload, EventPayloadMeta {
  debit: string;
  credit: string;
  entryDate: string;
  createdAt: string;
  /** IMPORT (استيراد/أرصدة، P11) أو CUSTOMER_ADJUSTMENT (M4، يكتبه المستند DONE) */
  origin?: 'IMPORT' | 'CUSTOMER_ADJUSTMENT' | null;
  /** دفعة الاستيراد إن عُرفت (لتجميع P11) */
  batchId?: string | null;
}

/** SETTLEMENT:<id>:POST|REVERSE — {amount, method, salesRepId, settledAt, createdAt} (الـtombstone في المفتاحين) */
export interface SettlementEventPayload extends SettlementPayload, EventPayloadMeta {
  settlementId: string;
  amount: string;
  settledAt: string;
  createdAt: string;
  salesRepName?: string | null;
}

/** PAYLINK_FEE:<entryId> — من SettlementEntry kind=FEE كما خُزّن */
export interface PaylinkFeeEventPayload extends PaylinkFeePayload, EventPayloadMeta {
  amount: string;
  feeNet?: string | null;
  feeVat?: string | null;
  createdAt: string;
}

/** PAYOUT:<payoutId> — من SettlementEntry kind=PAYOUT وسجل Payout */
export interface PayoutEventPayload extends PayoutPayload, EventPayloadMeta {
  amount: string;
  createdAt: string;
}

/** M9 وM4 — تُعرَّف أشكالها مع مراحلها */
export type OpaqueEventPayload = Record<string, unknown> & EventPayloadMeta;

/** خريطة (sourceType, event) ⇒ الحمولة */
export interface SourceEventPayloadMap {
  INVOICE: { POST: InvoicePostEventPayload; REVERSE: InvoiceReverseEventPayload; COGS: OpaqueEventPayload; RESTOCK: OpaqueEventPayload };
  RECEIPT: { POST: ReceiptPostEventPayload; REVERSE: ReceiptReverseEventPayload };
  AR_ENTRY: { POST: ArEntryEventPayload; REVERSE: ArEntryEventPayload };
  SETTLEMENT: { POST: SettlementEventPayload; REVERSE: SettlementEventPayload };
  PAYLINK_FEE: { POST: PaylinkFeeEventPayload };
  PAYOUT: { POST: PayoutEventPayload };
  WH_ENTRY: { POST: OpaqueEventPayload };
  VAN_LOAD: { POST: OpaqueEventPayload };
  RESTOCK: { RESTOCK: OpaqueEventPayload };
  CUSTOMER_ADJUSTMENT: { POST: OpaqueEventPayload; REVERSE: OpaqueEventPayload };
}

export type PayloadOf<T extends SourceType, E extends SourceEvent> =
  E extends keyof SourceEventPayloadMap[T] ? SourceEventPayloadMap[T][E] : never;

export type SourceEventPayload =
  | InvoicePostEventPayload | InvoiceReverseEventPayload | ReceiptPostEventPayload | ReceiptReverseEventPayload
  | ArEntryEventPayload | SettlementEventPayload | PaylinkFeeEventPayload | PayoutEventPayload | OpaqueEventPayload;

// ═══ الحدث ═══

/** صف gl_source_events كما يقرؤه المُرحِّل (§3.4) */
export interface SourceEventRecord {
  id: string;
  tenantId: string;
  sourceKey: string;
  sourceType: SourceType;
  sourceId: string;
  event: SourceEvent;
  effectAt: Date;
  detectedAt: Date;
  payload: SourceEventPayload | null;
  status: EventStatus;
  skipReason: SkipReason | null;
  attempts: number;
  nextAttemptAt: Date | null;
  /** للحالات غير النهائية: ملاحظة مرمَّزة (classify.ts → encodeEventNote) أو رسالة الخطأ */
  lastError: string | null;
  moveId: string | null;
  processedAt: Date | null;
  nonCustodyClearedMilli: Milli | null;
  shortageRecoveredMilli: Milli | null;
}

/** حدث مرغوب يُدرَج بـcreateMany({skipDuplicates}) — من المُطابِق أو الـtombstone أو بوابة الأشقاء */
export interface DesiredEvent {
  sourceKey: string;
  sourceType: SourceType;
  sourceId: string;
  event: SourceEvent;
  effectAt: Date;
  payload: SourceEventPayload | null;
  /** الافتراضي PENDING. HELD(UNEXPECTED_ENTRY_SHAPE) من المُطابِق، وSKIPPED من بوابة الأشقاء وحدها (الـtombstone لا يضبط SKIPPED أبداً) */
  status?: Extract<EventStatus, 'PENDING' | 'HELD' | 'SKIPPED'>;
  skipReason?: SkipReason | null;
  /** مع HELD: encodeEventNote({kind:'HELD', reason}) */
  lastError?: string | null;
}

/** تعديل حالة حدث داخل معاملة الترحيل */
export interface SourceEventPatch {
  status?: EventStatus;
  skipReason?: SkipReason | null;
  attempts?: number;
  nextAttemptAt?: Date | null;
  lastError?: string | null;
  moveId?: string | null;
  processedAt?: Date | null;
  nonCustodyClearedMilli?: Milli | null;
  shortageRecoveredMilli?: Milli | null;
}

/** نتيجة معالجة حدث واحد في المُرحِّل */
export type PostOutcome =
  | { status: 'DONE'; moveId: string; /** P2002 على sourceKey أو عكس قائم ⇒ الربط القائم */ idempotent: boolean; nonCustodyClearedMilli?: Milli | null; shortageRecoveredMilli?: Milli | null }
  | { status: 'SKIPPED'; skipReason: SkipReason }
  | { status: 'BLOCKED'; reason: BlockReason; step: number; nextAttemptAt: Date }
  | { status: 'HELD'; reason: EventHoldReason; detail?: string | null }
  | { status: 'ERROR'; error: string; attempts: number; /** null ⇒ نهائي بعد MAX_ERROR_ATTEMPTS */ nextAttemptAt: Date | null }
  /** TRANSIENT_DB_ERROR: مهلة مجمّع/معاملة أو انقطاع (P2024/P2028/P1001/P1017) ⇒ تأجيل دقيقة بلا attempts++ */
  | { status: 'PENDING'; reason: PendingHoldReason | 'TRANSIENT_DB_ERROR'; error?: string };

// ═══ المؤشر المركّب (§5.2) ═══

/** (createdAt, id) متزايد تماماً */
export interface CompositeKey {
  at: Date;
  id: string;
}

/** صف gl_sync_cursors */
export interface SyncCursorState {
  source: SyncCursorSource;
  watermarkAt: Date;
  watermarkId: string;
  lastRunAt: Date | null;
  lastCount: number;
  stallTicks: number;
}

/** مقارنة (createdAt, id) بترتيب بوستجرس للصفوف: الزمن ثم id نصياً (المعرّفات uuid بحروف صغيرة) */
export function compareCompositeKey(a: CompositeKey, b: CompositeKey): number {
  const d = a.at.getTime() - b.at.getTime();
  if (d !== 0) return d < 0 ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** GREATEST للمؤشر: لا يتراجع أبداً (§5.2 البند 2) */
export function maxCompositeKey(a: CompositeKey, b: CompositeKey): CompositeKey {
  return compareCompositeKey(a, b) >= 0 ? a : b;
}

/** مؤشر الطريقة (أ) عند التفعيل (§5.6 الخطوة 6): min(cutover − 1 يوم بتوقيت الشركة، T0)، و'' للمعرّف */
export interface InitialWatermark {
  watermarkAt: Date;
  watermarkId: '';
}

// ═══ عقد الإيجار والنبضة (§5.1) ═══

export interface LeaseHandle {
  tenantId: string;
  token: string;
}

export interface ReconcileSourceResult {
  source: SyncCursorSource;
  /** صفحات التمريرة الدائمة */
  pages: number;
  rowsRead: number;
  eventsInserted: number;
  tailRowsRead: number;
  tailEventsInserted: number;
  watermarkBefore: CompositeKey;
  watermarkAfter: CompositeKey;
  /** صفحة ممتلئة لم تحرّك المؤشر ⇒ stallTicks++ وسجل ERROR (§5.2 البند 5) */
  stalled: boolean;
  budgetExhausted: boolean;
}

export interface PosterRunResult {
  attempted: number;
  done: number;
  skipped: number;
  blocked: number;
  held: number;
  errors: number;
  /** أحداث مخزون أُبقيت PENDING للأفق الآمن أو حجب رأس الطابور */
  keptPending: number;
  /** إعادة فحص BLOCKED لا تُحتسب في ميزانية الأحداث (§5.4) */
  blockedRechecks: number;
  stoppedBy: 'EMPTY' | 'EVENT_BUDGET' | 'TIME_BUDGET' | 'TICK_CUTOFF';
  /** أحداث AR_ENTRY:POST حُسمت SKIPPED(OPENING) جماعياً قبل الحلقة (البند 4 (أ)) — لا تُحتسب في ميزانية الأحداث */
  bulkOpeningSkipped?: number;
  /** ما عولج (attempted) لكل مسار حين يدعم المخزن ترشيح النوع (البند 4 (ب)) */
  lanes?: { live: number; import: number };
}

export type TenantTickSkip = 'LEASE_HELD' | 'IN_PROCESS' | 'NOT_ACTIVATED' | 'SUITE_DISABLED';

export interface TenantTickResult {
  tenantId: string;
  leaseAcquired: boolean;
  skipped: TenantTickSkip | null;
  reconcile: ReconcileSourceResult[];
  post: PosterRunResult | null;
  /** PENDING + BLOCKED + ERROR(قابل للإعادة) بعد النبضة */
  pendingEvents: number;
  backfillState: BackfillState;
  durationMs: number;
}

export type SchedulerTickSkip = 'WORKER_DISABLED' | 'REQUEST_PRESSURE' | 'TICK_IN_PROGRESS';

export interface SchedulerTickResult {
  startedAt: Date;
  skipped: SchedulerTickSkip | null;
  tenants: TenantTickResult[];
  eventsProcessed: number;
  dbTimeMs: number;
}

/** POST /api/ledger/sync (§5.1، ملحق أ): 200 بنتيجة النبضة، أو 202 {running: true, pendingEvents} دون العقد أو قبل 60 ثانية */
export type ManualSyncResponse =
  | { running: true; pendingEvents: number; retryAfterSeconds?: number }
  | { running: false; pendingEvents: number; result: TenantTickResult };

// ═══ أخطاء Prisma بلا استيراد prisma ═══

/** شكل P2002 كما يرميه Prisma والمخزن المزيّف (§5.4): {code:'P2002', meta:{target:['tenantId','sourceKey']}} */
export interface UniqueViolationLike {
  code: 'P2002';
  meta?: { target?: readonly string[] | string };
}

/** هل الخطأ P2002، واختيارياً على هذه الأعمدة بالضبط (بأي ترتيب)؟ */
export function isUniqueViolation(e: unknown, target?: readonly string[]): e is UniqueViolationLike {
  if (!e || typeof e !== 'object' || (e as { code?: unknown }).code !== 'P2002') return false;
  if (!target) return true;
  const t = (e as UniqueViolationLike).meta?.target;
  const cols = Array.isArray(t) ? t.map(String) : typeof t === 'string' ? t.split(/[_,\s]+/) : [];
  const want = [...target].sort();
  if (Array.isArray(t)) return [...cols].sort().join('|') === want.join('|');
  // Prisma قد يعيد اسم القيد نصاً (gl_move_sources_tenantId_sourceKey_key)
  return want.every((c) => cols.includes(c));
}

/** P2002 على [tenantId, sourceKey] ⇒ DONE بالربط القائم؛ غيره ⇒ ERROR (§5.4) */
export const SOURCE_KEY_UNIQUE_TARGET = ['tenantId', 'sourceKey'] as const;
