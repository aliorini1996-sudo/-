/**
 * التصنيف وقرارات المُرحِّل الصرفة (M3، DESIGN.md §5.4، §5.6).
 *
 * بلا I/O: كل ما يحتاجه المُرحِّل ليقرر مصير حدث من حقائق مقروءة (تحت قفل gl-post حين يلزم):
 *  - classifyCutover: التصنيف بالنسبة لتاريخ البدء وT0 = openingSnapshotAt (§5.6):
 *      مشمول بالافتتاح ⇔ effectDate < cutover **و** createdAt ≤ T0 ⇒ OPENING (SKIPPED(OPENING))؛
 *      effectDate ≥ cutover ⇒ POST_AT(effectDate)؛
 *      effectDate < cutover وcreatedAt > T0 ⇒ POST_AT(cutover) مع lateArrival وoriginalDate (ومنه (T0, commit])؛
 *      futureDated: التاريخ المحلي لـcreatedAt < cutover وeffectDate ≥ cutover (فحص لمرة واحدة).
 *  - siblingGate: بوابة الأشقاء لأحداث REVERSE/COGS/RESTOCK (§5.4).
 *  - planEvent: التصنيف الذاتي ثم البوابة ثم تاريخ القيد.
 *  - بوابات مساعدة: العملة، أفق المخزون، ترتيب P7، الترتيب، التراجع، ترميز ملاحظة الحالة في lastError.
 */
import { addDays, compareLocalDate, localDate, zonedStartOfDay } from '../dates';
import type { EventHoldReason, EventStatus, LocalDate, SkipReason, SourceEvent, SourceType } from '../types';
import {
  BLOCKED_BACKOFF_MS, BLOCK_REASONS, ERROR_BACKOFF_MS, EVENT_HOLD_REASONS, EVENT_RANK, INVENTORY_SOURCE_TYPES,
  MAX_ERROR_ATTEMPTS, PENDING_HOLD_REASONS, SALES_SOURCE_TYPES, TOMBSTONE_SOURCE_TYPES,
  type ArEntryEventPayload, type BlockReason, type CompositeKey, type PendingHoldReason, type SettlementEventPayload,
} from './types';

type Instant = Date | string | number;
const toDate = (v: Instant): Date => (v instanceof Date ? v : new Date(v));

// ═══ سياق البدء ═══

export interface CutoverContext {
  /** تاريخ البدء المحلي */
  cutoverDate: LocalDate;
  /** T0 = (SELECT now()) − LATE_COMMIT_WINDOW داخل معاملة التفعيل (§5.6 الخطوة 6) */
  openingSnapshotAt: Date;
  timezone: string;
  /** المؤشر الابتدائي للمصادر (initialWatermarkAt) — للبوابة (ب) */
  initialWatermarkAt: Date;
}

export type SetupMethod = 'OPENING' | 'FULL_HISTORY';

/**
 * المؤشر الابتدائي عند التفعيل (§5.6 الخطوة 6): الطريقة (أ) min(بداية اليوم المحلي cutover − 1 يوم، T0)،
 * والطريقة (ب) epoch. المعرّف دائماً ''.
 */
export function initialWatermarkAt(input: { method: SetupMethod; cutoverDate: LocalDate; openingSnapshotAt: Date; timezone: string }): Date {
  if (input.method === 'FULL_HISTORY') return new Date(0);
  const dayBefore = zonedStartOfDay(addDays(input.cutoverDate, -1), input.timezone);
  return dayBefore.getTime() <= input.openingSnapshotAt.getTime() ? dayBefore : new Date(input.openingSnapshotAt.getTime());
}

// ═══ التصنيف بالنسبة لتاريخ البدء (§5.6) ═══

export interface CutoverRow {
  /** لحظة الأثر (entryDate / settledAt / createdAt) */
  effectAt: Instant;
  /** تاريخ الأثر المحلي إن كان معروفاً (يتقدّم على localDate(effectAt)) */
  effectDate?: LocalDate | null;
  /** أكبر createdAt بين صفوف المفتاح */
  createdAt: Instant;
}

export type CutoverClass =
  | { kind: 'OPENING'; effectDate: LocalDate }
  | { kind: 'POST_AT'; date: LocalDate; effectDate: LocalDate; lateArrival: boolean; originalDate: LocalDate | null; futureDated: boolean };

export function effectDateOf(row: Pick<CutoverRow, 'effectAt' | 'effectDate'>, timezone: string): LocalDate {
  return row.effectDate ?? localDate(toDate(row.effectAt), timezone);
}

/** مشمول بالافتتاح ⇔ effectDate < cutover و createdAt ≤ openingSnapshotAt */
export function isIncludedInOpening(row: CutoverRow, c: Pick<CutoverContext, 'cutoverDate' | 'openingSnapshotAt' | 'timezone'>): boolean {
  return compareLocalDate(effectDateOf(row, c.timezone), c.cutoverDate) < 0
    && toDate(row.createdAt).getTime() <= c.openingSnapshotAt.getTime();
}

export function classifyCutover(row: CutoverRow, c: Pick<CutoverContext, 'cutoverDate' | 'openingSnapshotAt' | 'timezone'>): CutoverClass {
  const effectDate = effectDateOf(row, c.timezone);
  const createdAt = toDate(row.createdAt);
  if (compareLocalDate(effectDate, c.cutoverDate) >= 0) {
    const futureDated = compareLocalDate(localDate(createdAt, c.timezone), c.cutoverDate) < 0;
    return { kind: 'POST_AT', date: effectDate, effectDate, lateArrival: false, originalDate: null, futureDated };
  }
  if (createdAt.getTime() <= c.openingSnapshotAt.getTime()) return { kind: 'OPENING', effectDate };
  return { kind: 'POST_AT', date: c.cutoverDate, effectDate, lateArrival: true, originalDate: effectDate, futureDated: false };
}

// ═══ أصل المصدر (resolveOrigin) ═══

export interface OriginFacts {
  /** لحظة أثر POST الأصلي */
  originEffectAt: Instant;
  originEffectDate?: LocalDate | null;
  originCreatedAt: Instant;
  /** صف المصدر ما زال موجوداً (الفاتورة والسند دائماً؛ الاستلام والاستيراد قد يُحذفان) */
  sourceExists: boolean;
}

/**
 * أصل POST من حمولة tombstone (§5.3، §5.4): SETTLEMENT ⇒ settledAt/createdAt، AR_ENTRY ⇒ entryDate/createdAt.
 * null لغير مصادر tombstone أو حمولة ناقصة. sourceExists=false دائماً (الصف محذوف).
 */
export function tombstoneOrigin(sourceType: SourceType, payload: unknown): OriginFacts | null {
  if (!payload || typeof payload !== 'object') return null;
  if (sourceType === 'SETTLEMENT') {
    const p = payload as Partial<SettlementEventPayload>;
    if (!p.settledAt || !p.createdAt) return null;
    return { originEffectAt: p.settledAt as Instant, originCreatedAt: p.createdAt as Instant, sourceExists: false };
  }
  if (sourceType === 'AR_ENTRY') {
    const p = payload as Partial<ArEntryEventPayload>;
    if (!p.entryDate || !p.createdAt) return null;
    return { originEffectAt: p.entryDate as Instant, originCreatedAt: p.createdAt as Instant, sourceExists: false };
  }
  return null;
}

export function isTombstoneSource(sourceType: SourceType): boolean {
  return (TOMBSTONE_SOURCE_TYPES as readonly string[]).includes(sourceType);
}

// ═══ بوابة الأشقاء (§5.4) ═══

export interface SiblingState {
  status: EventStatus;
  skipReason: SkipReason | null;
  moveId: string | null;
}

export interface LiveMoveState {
  /** آخر GlMoveSource تحت نمط POST* ليس لقيده reversal (ولا هو نفسه عكس) */
  liveMoveId: string | null;
  /** إن لم يوجد حيّ لأنه عُكس مسبقاً: معرّف قيد العكس القائم */
  existingReversalMoveId: string | null;
}

/**
 * كتابة على الشقيق المقابل: لحدث REVERSE/COGS/RESTOCK هو مفتاح POST (siblingPostKey)، ولحدث POST هو مفتاح REVERSE
 * (reverseKeyOf). INSERT بـcreateMany({skipDuplicates}) ثم إعادة قراءة، وUPDATE بشرط حالة غير نهائية.
 */
export type SiblingWrite =
  /** createMany({skipDuplicates}) لشقيق POST ثم إعادة قراءته */
  | { op: 'INSERT'; status: 'SKIPPED'; skipReason: Extract<SkipReason, 'OPENING' | 'NEVER_MATERIALIZED'> }
  | { op: 'INSERT'; status: 'PENDING' }
  /** تحديث شقيق POST غير النهائي لمصدر tombstone (في المعاملة نفسها) */
  | { op: 'UPDATE'; status: 'SKIPPED'; skipReason: Extract<SkipReason, 'OPENING' | 'NETTED'> };

export type SiblingGateDecision =
  /** POST = DONE: يُعكس القيد الحيّ */
  | { action: 'REVERSE_LIVE'; liveMoveId: string }
  /** POST = DONE وعُكس مسبقاً: DONE بـmoveId العكس القائم (لا خطأ reversedMoveId) */
  | { action: 'DONE_EXISTING'; moveId: string }
  /** يُبنى العكس (أو COGS/RESTOCK) من المستند أو الحمولة بالـbuilder */
  | { action: 'BUILD_FROM_SOURCE'; siblingWrite: SiblingWrite | null }
  /** COGS/RESTOCK: الشقيق DONE أو SKIPPED(ZERO_VALUE) ⇒ يُرحَّل كالمعتاد */
  | { action: 'PROCEED' }
  | { action: 'SKIP'; skipReason: SkipReason; siblingWrite: SiblingWrite | null }
  | { action: 'BLOCK'; reason: BlockReason; siblingWrite: SiblingWrite | null }
  /** (ج): إدراج شقيق SKIPPED(NEVER_MATERIALIZED) بـskipDuplicates ثم إعادة القراءة وتشغيل البوابة مجدداً */
  | { action: 'INSERT_SIBLING_AND_RECHECK'; siblingWrite: Extract<SiblingWrite, { op: 'INSERT'; status: 'SKIPPED' }> }
  /** حالة غير متسقة (POST DONE بلا قيد حيّ ولا عكس) ⇒ ERROR */
  | { action: 'ERROR'; error: 'LIVE_MOVE_NOT_FOUND' };

export interface SiblingGateInput {
  sourceType: SourceType;
  event: Exclude<SourceEvent, 'POST'>;
  /** شقيق POST مُعاد قراءته تحت القفل؛ null إن لم يوجد */
  sibling: SiblingState | null;
  /** مطلوب حين الشقيق DONE */
  live?: LiveMoveState | null;
  /**
   * resolveOrigin(event): مطلوب حين لا شقيق، وحين الشقيق غير نهائي لمصدر tombstone
   * (للفاتورة والسند من أقدم صف AccountEntry، وللاستلام والاستيراد من الحمولة).
   */
  origin?: OriginFacts | null;
  cutover: CutoverContext;
}

const NON_FINAL: readonly EventStatus[] = ['PENDING', 'BLOCKED', 'ERROR', 'HELD'];

export function siblingGate(input: SiblingGateInput): SiblingGateDecision {
  const { sibling, cutover } = input;
  const isReverse = input.event === 'REVERSE';

  if (sibling && sibling.status === 'DONE') {
    if (!isReverse) return { action: 'PROCEED' };
    const live = input.live;
    if (live?.liveMoveId) return { action: 'REVERSE_LIVE', liveMoveId: live.liveMoveId };
    if (live?.existingReversalMoveId) return { action: 'DONE_EXISTING', moveId: live.existingReversalMoveId };
    return { action: 'ERROR', error: 'LIVE_MOVE_NOT_FOUND' };
  }

  if (sibling && sibling.status === 'SKIPPED') {
    const reason = sibling.skipReason ?? 'MANUAL';
    if (reason === 'OPENING') {
      return isReverse ? { action: 'BUILD_FROM_SOURCE', siblingWrite: null } : { action: 'SKIP', skipReason: 'OPENING', siblingWrite: null };
    }
    if (reason === 'ZERO_VALUE') {
      // العكس من المستند يعطي NO_MOVE ⇒ SKIPPED(ZERO_VALUE)؛ وCOGS/RESTOCK مستحقة في الجرد المستمر
      return isReverse ? { action: 'SKIP', skipReason: 'ZERO_VALUE', siblingWrite: null } : { action: 'PROCEED' };
    }
    // NETTED | MANUAL | NEVER_MATERIALIZED: لا يُبنى من المستند (وإلا عُكس ما لم يُرحَّل)
    return { action: 'SKIP', skipReason: reason, siblingWrite: null };
  }

  if (sibling && NON_FINAL.includes(sibling.status)) {
    const origin = input.origin ?? null;
    if (isTombstoneSource(input.sourceType) && origin && !origin.sourceExists) {
      const opening = isIncludedInOpening(
        { effectAt: origin.originEffectAt, effectDate: origin.originEffectDate, createdAt: origin.originCreatedAt }, cutover,
      );
      if (opening) {
        const write: SiblingWrite = { op: 'UPDATE', status: 'SKIPPED', skipReason: 'OPENING' };
        return isReverse ? { action: 'BUILD_FROM_SOURCE', siblingWrite: write } : { action: 'SKIP', skipReason: 'OPENING', siblingWrite: write };
      }
      // تعميم P12: الحدثان SKIPPED(NETTED) في المعاملة نفسها
      return { action: 'SKIP', skipReason: 'NETTED', siblingWrite: { op: 'UPDATE', status: 'SKIPPED', skipReason: 'NETTED' } };
    }
    return { action: 'BLOCK', reason: 'SIBLING_NOT_FINAL', siblingWrite: null };
  }

  // لا حدث POST إطلاقاً
  const origin = input.origin;
  if (!origin) return { action: 'BLOCK', reason: 'AWAITING_RECONCILER', siblingWrite: null };
  const row: CutoverRow = { effectAt: origin.originEffectAt, effectDate: origin.originEffectDate, createdAt: origin.originCreatedAt };
  if (isIncludedInOpening(row, cutover)) {
    // (أ)
    const write: SiblingWrite = { op: 'INSERT', status: 'SKIPPED', skipReason: 'OPENING' };
    return isReverse ? { action: 'BUILD_FROM_SOURCE', siblingWrite: write } : { action: 'SKIP', skipReason: 'OPENING', siblingWrite: write };
  }
  if (origin.sourceExists) {
    // (ب) مستند أقدم من المؤشر الابتدائي (مؤرخ مستقبلاً قبل البدء) لن يقرأه المُطابِق ⇒ شقيق PENDING
    const beforeInitial = toDate(origin.originCreatedAt).getTime() < cutover.initialWatermarkAt.getTime();
    return { action: 'BLOCK', reason: 'AWAITING_RECONCILER', siblingWrite: beforeInitial ? { op: 'INSERT', status: 'PENDING' } : null };
  }
  // (ج)
  return { action: 'INSERT_SIBLING_AND_RECHECK', siblingWrite: { op: 'INSERT', status: 'SKIPPED', skipReason: 'NEVER_MATERIALIZED' } };
}

// ═══ خطة الحدث ═══

export type EventPlan =
  | { action: 'SKIP'; skipReason: SkipReason; siblingWrite: SiblingWrite | null }
  | { action: 'BLOCK'; reason: BlockReason; siblingWrite: SiblingWrite | null }
  | { action: 'INSERT_SIBLING_AND_RECHECK'; siblingWrite: Extract<SiblingWrite, { op: 'INSERT'; status: 'SKIPPED' }> }
  | { action: 'ERROR'; error: string }
  | { action: 'DONE_EXISTING'; moveId: string }
  /** يُرحَّل: POST من الـbuilder، أو REVERSE للقيد الحيّ (liveMoveId)، أو من المستند/الحمولة */
  | {
    action: 'POST';
    mode: 'BUILD' | 'REVERSE_LIVE' | 'BUILD_FROM_SOURCE';
    liveMoveId: string | null;
    date: LocalDate;
    lateArrival: boolean;
    originalDate: LocalDate | null;
    futureDated: boolean;
    siblingWrite: SiblingWrite | null;
  };

export interface PlanEventInput {
  sourceType: SourceType;
  event: SourceEvent;
  /** الأثر الذاتي للحدث: effectAt وأكبر createdAt لصفوف مفتاحه */
  self: CutoverRow;
  /**
   * الشقيق المقابل مُعاداً قراءته تحت القفل: لأحداث REVERSE/COGS/RESTOCK = شقيق POST؛
   * ولحدث POST لمصدر tombstone (SETTLEMENT/AR_ENTRY) = شقيق REVERSE (يكتبه الـtombstone مع POST).
   */
  sibling?: SiblingState | null;
  /** لحدث POST: هل صف المصدر ما زال موجوداً؟ (الغائب = مجهول ⇒ يُستنتج من وجود شقيق REVERSE لمصدر tombstone) */
  sourceExists?: boolean | null;
  live?: LiveMoveState | null;
  origin?: OriginFacts | null;
  cutover: CutoverContext;
}

/**
 * classify(event) vs cutover ثم بوابة الأشقاء (§5.4): حدث مشمول بالافتتاح ⇒ SKIPPED(OPENING) أياً كان نوعه
 * (أصله أقدم منه فهو مشمول أيضاً)؛ وإلا POST مباشرةً أو قرار البوابة، بتاريخ التصنيف (cutover مع lateArrival إن لزم).
 * إزاحة الإقفال (ADR‑7) لاحقة في postMove.
 */
export function planEvent(input: PlanEventInput): EventPlan {
  const own = classifyCutover(input.self, input.cutover);
  if (own.kind === 'OPENING') return { action: 'SKIP', skipReason: 'OPENING', siblingWrite: null };
  const post = (mode: 'BUILD' | 'REVERSE_LIVE' | 'BUILD_FROM_SOURCE', liveMoveId: string | null, siblingWrite: SiblingWrite | null): EventPlan => ({
    action: 'POST', mode, liveMoveId, date: own.date, lateArrival: own.lateArrival, originalDate: own.originalDate,
    futureDated: own.futureDated, siblingWrite,
  });
  if (input.event === 'POST') {
    // POST لمصدر tombstone غير مشمول بالافتتاح وحُذف قبل ترحيله (أُنشئ وحُذف في نبضة، أو أثناء إطفاء العَلَم):
    // الحدثان SKIPPED(NETTED) في المعاملة نفسها (تعميم P12، §5.4) — والكتابة على شقيق REVERSE غير النهائي
    const rev = input.sibling ?? null;
    if (isTombstoneSource(input.sourceType) && rev && input.sourceExists !== true) {
      if (NON_FINAL.includes(rev.status)) {
        return { action: 'SKIP', skipReason: 'NETTED', siblingWrite: { op: 'UPDATE', status: 'SKIPPED', skipReason: 'NETTED' } };
      }
      if (rev.status === 'SKIPPED' && rev.skipReason === 'NETTED') return { action: 'SKIP', skipReason: 'NETTED', siblingWrite: null };
    }
    return post('BUILD', null, null);
  }
  const g = siblingGate({
    sourceType: input.sourceType, event: input.event, sibling: input.sibling ?? null, live: input.live ?? null,
    origin: input.origin ?? null, cutover: input.cutover,
  });
  switch (g.action) {
    case 'REVERSE_LIVE': return post('REVERSE_LIVE', g.liveMoveId, null);
    case 'BUILD_FROM_SOURCE': return post('BUILD_FROM_SOURCE', null, g.siblingWrite);
    case 'PROCEED': return post('BUILD', null, null);
    case 'DONE_EXISTING': return { action: 'DONE_EXISTING', moveId: g.moveId };
    case 'SKIP': return { action: 'SKIP', skipReason: g.skipReason, siblingWrite: g.siblingWrite };
    case 'BLOCK': return { action: 'BLOCK', reason: g.reason, siblingWrite: g.siblingWrite };
    case 'INSERT_SIBLING_AND_RECHECK': return g;
    case 'ERROR': return { action: 'ERROR', error: g.error };
  }
}

/** قبل ترحيل POST يُعاد قراءة حالته تحت القفل: tombstone قد يكون صفّاه SKIPPED(NETTED) (سباق §10.1) */
export function isStillActionable(status: EventStatus): boolean {
  return status === 'PENDING' || status === 'BLOCKED' || status === 'ERROR';
}

// ═══ بوابات مساعدة ═══

/** HELD(CURRENCY_MISMATCH) لمصادر المبيعات حين تختلف عملة الإعدادات المجمّدة عن عملة الشركة (§5.4، §5.8) */
export function currencyMismatch(sourceType: SourceType, settingsCurrency: string, companyCurrency: string | null | undefined): boolean {
  if (!(SALES_SOURCE_TYPES as readonly string[]).includes(sourceType)) return false;
  return !!companyCurrency && companyCurrency.toUpperCase() !== settingsCurrency.toUpperCase();
}

export function isInventoryEvent(e: { sourceType: SourceType; event: SourceEvent }): boolean {
  return (INVENTORY_SOURCE_TYPES as readonly string[]).includes(e.sourceType) || e.event === 'COGS' || e.event === 'RESTOCK';
}

/**
 * الأفق الآمن للمخزون (§5.4): null ⇒ لا يُرحَّل أي حدث مخزون؛ effectAt > H ⇒ PENDING؛ وحدث بعد رأس طابور محجوب E0 ⇒ PENDING.
 * يعيد null إن كان جاهزاً.
 */
export function inventoryGate(
  e: { sourceType: SourceType; event: SourceEvent; effectAt: Date; sourceKey: string },
  horizon: Date | null,
  blockedHead?: { effectAt: Date; sourceKey: string } | null,
): PendingHoldReason | null {
  if (!isInventoryEvent(e)) return null;
  if (blockedHead && (e.effectAt.getTime() > blockedHead.effectAt.getTime()
    || (e.effectAt.getTime() === blockedHead.effectAt.getTime() && e.sourceKey > blockedHead.sourceKey))) {
    return 'INVENTORY_HEAD_OF_LINE';
  }
  if (horizon === null || e.effectAt.getTime() > horizon.getTime()) return 'INVENTORY_HORIZON';
  return null;
}

/**
 * ترتيب P7 (§5.5): جاهز حين يتجاوز مؤشر ACCOUNT_ENTRY settlement.createdAt، ولا حدث RECEIPT للمندوب
 * بحالة PENDING/BLOCKED بـeffectAt ≤ settledAt.
 */
export function settlementOrderReady(input: {
  settlementCreatedAt: Instant;
  settledAt: Instant;
  accountEntryWatermark: CompositeKey | null;
  repReceiptEvents: readonly { status: EventStatus; effectAt: Date }[];
}): boolean {
  const w = input.accountEntryWatermark;
  if (!w || w.at.getTime() <= toDate(input.settlementCreatedAt).getTime()) return false;
  const settled = toDate(input.settledAt).getTime();
  return !input.repReceiptEvents.some((r) => (r.status === 'PENDING' || r.status === 'BLOCKED') && r.effectAt.getTime() <= settled);
}

/** ترتيب المعالجة (§5.4): effectAt ثم rank(POST<COGS<RESTOCK<REVERSE) ثم sourceKey */
export function compareEventsForPosting(
  a: { effectAt: Date; event: SourceEvent; sourceKey: string },
  b: { effectAt: Date; event: SourceEvent; sourceKey: string },
): number {
  const d = a.effectAt.getTime() - b.effectAt.getTime();
  if (d !== 0) return d < 0 ? -1 : 1;
  const r = EVENT_RANK[a.event] - EVENT_RANK[b.event];
  if (r !== 0) return r;
  return a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0;
}

// ═══ التراجع (§5.4) ═══

/** بعد فشل: attempts = السابقة + 1؛ nextAttemptAt بالسلم 1m,5m,30m,2h,12h، وnull (ERROR نهائي) عند بلوغ الحد */
export function errorRetry(previousAttempts: number, now: Date): { attempts: number; nextAttemptAt: Date | null } {
  const attempts = previousAttempts + 1;
  if (attempts >= MAX_ERROR_ATTEMPTS) return { attempts, nextAttemptAt: null };
  return { attempts, nextAttemptAt: new Date(now.getTime() + ERROR_BACKOFF_MS[attempts - 1]) };
}

/** BLOCKED: step = عدد مرات الحجب المتتالية السابقة (0 أول مرة) ⇒ 1m ثم 5m ثم 30m ثم 2h ثابتاً */
export function blockedRetry(previousStep: number | null, now: Date): { step: number; nextAttemptAt: Date } {
  const step = previousStep === null || previousStep < 0 ? 0 : previousStep + 1;
  const delay = BLOCKED_BACKOFF_MS[Math.min(step, BLOCKED_BACKOFF_MS.length - 1)];
  return { step, nextAttemptAt: new Date(now.getTime() + delay) };
}

// ═══ ملاحظة الحالة في lastError (لا عمود سبب للحجز أو الحجب في §3.4) ═══

export type EventNote =
  | { kind: 'HELD'; reason: EventHoldReason; detail?: string | null }
  | { kind: 'BLOCKED'; reason: BlockReason; step: number; detail?: string | null }
  | { kind: 'PENDING'; reason: PendingHoldReason }
  | { kind: 'ERROR'; message: string };

/** HELD:<reason>[|detail] — BLOCKED:<reason>#<step>[|detail] — PENDING:<reason> — ERROR ⇒ الرسالة كما هي */
export function encodeEventNote(n: EventNote): string {
  const tail = (d?: string | null) => (d ? `|${d}` : '');
  switch (n.kind) {
    case 'HELD': return `HELD:${n.reason}${tail(n.detail)}`;
    case 'BLOCKED': return `BLOCKED:${n.reason}#${n.step}${tail(n.detail)}`;
    case 'PENDING': return `PENDING:${n.reason}`;
    case 'ERROR': return n.message;
  }
}

export function decodeEventNote(s: string | null | undefined): EventNote | null {
  if (!s) return null;
  let m = /^HELD:([A-Z_]+)(?:\|([\s\S]*))?$/.exec(s);
  if (m && (EVENT_HOLD_REASONS as readonly string[]).includes(m[1])) {
    return { kind: 'HELD', reason: m[1] as EventHoldReason, detail: m[2] ?? null };
  }
  m = /^BLOCKED:([A-Z_]+)#(\d+)(?:\|([\s\S]*))?$/.exec(s);
  if (m && (BLOCK_REASONS as readonly string[]).includes(m[1])) {
    return { kind: 'BLOCKED', reason: m[1] as BlockReason, step: Number(m[2]), detail: m[3] ?? null };
  }
  m = /^PENDING:([A-Z_]+)$/.exec(s);
  if (m && (PENDING_HOLD_REASONS as readonly string[]).includes(m[1])) return { kind: 'PENDING', reason: m[1] as PendingHoldReason };
  return { kind: 'ERROR', message: s };
}
