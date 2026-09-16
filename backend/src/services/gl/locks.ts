/**
 * تواريخ الإقفال (M1، DESIGN.md §2.5، ADR‑7، §9.5 G3) — دوال صرفة بلا prisma ولا I/O.
 *
 * - الإقفال شامل: التاريخ ≤ تاريخ الإقفال مقفل، وأول يوم مفتوح = الإقفال + 1.
 * - salesLockDate: دفاتر SALE وسطور ذمم العملاء؛ purchaseLockDate: دفاتر PURCHASE وسطور ذمم الموردين؛
 *   taxLockDate: أي قيد فيه سطر ضريبي؛ hardLockDate: كل القيود ولا يتراجع أبداً.
 * - القيد الآلي يُزاح إلى أول يوم مفتوح مع lateArrival وoriginalDate (ADR‑7)، واليدوي يُرفض LEDGER_PERIOD_LOCKED.
 * - lockSyncBlockers: لا يُقفل تاريخ والترحيل متأخر عنه (§2.5 أ/ب/ج).
 */
import {
  LedgerError,
  type AccountRef,
  type AccountType,
  type BackfillState,
  type BuildContext,
  type ControlKind,
  type GlSettingsSnapshot,
  type InventoryMode,
  type JournalType,
  type LocalDate,
  type MoveDraft,
  type TaxRole,
} from './types';
import {
  DEFAULT_TIMEZONE,
  addDays,
  compareLocalDate,
  isLocalDate,
  maxLocalDate,
  zonedStartOfDay,
} from './dates';

// ═══ الحقول والنطاق ═══

export const LOCK_DATE_FIELDS = ['salesLockDate', 'purchaseLockDate', 'taxLockDate', 'hardLockDate'] as const;
export type LockDateField = (typeof LOCK_DATE_FIELDS)[number];
export type LockDates = Pick<GlSettingsSnapshot, LockDateField>;

/** ما يمسّه القيد مما تحكمه تواريخ الإقفال. */
export interface LockScope {
  /** نوع دفتر القيد؛ null إن تعذّر حلّه (يبقى الحكم للسطور وللإقفال النهائي) */
  journalType: JournalType | null;
  /** سطر على ذمم العملاء (controlKind=AR أو نوع asset_receivable) */
  touchesReceivable: boolean;
  /** سطر على ذمم الموردين (controlKind=AP أو نوع liability_payable) */
  touchesPayable: boolean;
  /** سطر ضريبي: taxRole أو taxId أو taxCode أو vatBox، أو حساب VAT_OUT/VAT_IN */
  touchesTax: boolean;
}

export interface LockScopeLine {
  controlKind?: ControlKind | null;
  accountType?: AccountType | null;
  taxRole?: TaxRole | null;
  taxId?: string | null;
  taxCode?: string | null;
  vatBox?: string | null;
}

function isTaxLine(l: LockScopeLine): boolean {
  return (
    l.taxRole != null ||
    !!l.taxId ||
    !!l.taxCode ||
    !!l.vatBox ||
    l.controlKind === 'VAT_OUT' ||
    l.controlKind === 'VAT_IN'
  );
}

export function lockScopeOf(input: { journalType: JournalType | null; lines: readonly LockScopeLine[] }): LockScope {
  const { journalType, lines } = input;
  return {
    journalType,
    touchesReceivable: lines.some(l => l.controlKind === 'AR' || l.accountType === 'asset_receivable'),
    touchesPayable: lines.some(l => l.controlKind === 'AP' || l.accountType === 'liability_payable'),
    touchesTax: lines.some(isTaxLine),
  };
}

/** نطاق مسودة قيد: الدفتر بـsystemKey ثم الرمز، والحساب بالأولوية id ثم code ثم key (كما في LineDraft). */
export function lockScopeOfDraft(
  draft: MoveDraft,
  ctx: Pick<BuildContext, 'accounts' | 'journals'>,
): LockScope {
  const journal =
    (draft.journalSystemKey ? ctx.journals.bySystemKey(draft.journalSystemKey) : null) ??
    ctx.journals.byCode(draft.journalCode);
  const lines: LockScopeLine[] = draft.lines.map(l => {
    let acc: AccountRef | null = null;
    if (l.accountId) acc = ctx.accounts.byId(l.accountId);
    if (!acc && l.accountCode) acc = ctx.accounts.byCode(l.accountCode);
    if (!acc && l.accountKey) acc = ctx.accounts.byKey(l.accountKey);
    return {
      controlKind: acc?.controlKind ?? null,
      accountType: acc?.type ?? null,
      taxRole: l.taxRole ?? null,
      taxId: l.taxId ?? null,
      taxCode: l.taxCode ?? null,
      vatBox: l.vatBox ?? null,
    };
  });
  return lockScopeOf({ journalType: journal?.type ?? null, lines });
}

/** حقول الإقفال التي تنطبق على النطاق — hardLockDate دائماً. */
export function applicableLockFields(scope: LockScope): LockDateField[] {
  const out: LockDateField[] = [];
  if (scope.journalType === 'SALE' || scope.touchesReceivable) out.push('salesLockDate');
  if (scope.journalType === 'PURCHASE' || scope.touchesPayable) out.push('purchaseLockDate');
  if (scope.touchesTax) out.push('taxLockDate');
  out.push('hardLockDate');
  return out;
}

export interface EffectiveLock {
  /** أكبر تاريخ إقفال منطبق، أو null إن لا إقفال */
  lockDate: LocalDate | null;
  /** الحقول التي تساوي lockDate (المسؤولة عن الحجب) */
  fields: LockDateField[];
}

export function effectiveLockDate(locks: LockDates, scope: LockScope): EffectiveLock {
  let lockDate: LocalDate | null = null;
  let fields: LockDateField[] = [];
  for (const f of applicableLockFields(scope)) {
    const v = locks[f];
    if (v == null) continue;
    assertLocalDate(v, f);
    const c = lockDate == null ? 1 : compareLocalDate(v, lockDate);
    if (c > 0) {
      lockDate = v;
      fields = [f];
    } else if (c === 0) {
      fields.push(f);
    }
  }
  return { lockDate, fields };
}

/** أول يوم مفتوح للنطاق = الإقفال الفعّال + 1، أو null إن لا إقفال. */
export function firstOpenDate(locks: LockDates, scope: LockScope): LocalDate | null {
  const { lockDate } = effectiveLockDate(locks, scope);
  return lockDate == null ? null : addDays(lockDate, 1);
}

export function isDateLocked(date: LocalDate, locks: LockDates, scope: LockScope): boolean {
  assertLocalDate(date, 'date');
  const { lockDate } = effectiveLockDate(locks, scope);
  return lockDate != null && compareLocalDate(date, lockDate) <= 0;
}

// ═══ القيود الآلية: الإزاحة ADR‑7 ═══

export interface ShiftedDate {
  date: LocalDate;
  lateArrival: boolean;
  /** التاريخ الأصلي عند الإزاحة، وإلا null */
  originalDate: LocalDate | null;
}

/** date = max(docDate, lock+1) لكل إقفال ينطبق (§2.5). لا يُرفض أبداً. */
export function shiftAutoMoveDate(docDate: LocalDate, locks: LockDates, scope: LockScope): ShiftedDate {
  assertLocalDate(docDate, 'docDate');
  const open = firstOpenDate(locks, scope);
  if (open != null && compareLocalDate(docDate, open) < 0) {
    return { date: open, lateArrival: true, originalDate: docDate };
  }
  return { date: docDate, lateArrival: false, originalDate: null };
}

/**
 * يطبّق الإزاحة على مسودة آلية ويعيد نسخة. إن كانت المسودة مُزاحة مسبقاً (تاريخ البدء §5.6)
 * يُحفظ originalDate الأقدم ويبقى lateArrival=true.
 */
export function applyAutoLockShift(draft: MoveDraft, locks: LockDates, scope: LockScope): MoveDraft {
  const s = shiftAutoMoveDate(draft.date, locks, scope);
  const wasLate = draft.lateArrival === true;
  const lateArrival = wasLate || s.lateArrival;
  const originalDate = lateArrival ? (draft.originalDate ?? s.originalDate ?? draft.date) : (draft.originalDate ?? null);
  return { ...draft, date: s.date, lateArrival, originalDate };
}

/** العكس الآلي (P4/P6/P8/P12، §2.4): max(اليوم المحلي، تاريخ الأصل) ثم الإزاحة إلى أول يوم مفتوح. */
export function autoReversalDate(
  today: LocalDate,
  originalMoveDate: LocalDate,
  locks: LockDates,
  scope: LockScope,
): ShiftedDate {
  assertLocalDate(today, 'today');
  assertLocalDate(originalMoveDate, 'originalMoveDate');
  return shiftAutoMoveDate(maxLocalDate(today, originalMoveDate), locks, scope);
}

// ═══ القيود اليدوية: الرفض ═══

/** يرمي LEDGER_PERIOD_LOCKED إن وقع التاريخ في فترة مقفلة للنطاق (القيود اليدوية وفواتير الموردين ومستندات الواجهة). */
export function assertManualDateOpen(date: LocalDate, locks: LockDates, scope: LockScope): void {
  assertLocalDate(date, 'date');
  const { lockDate, fields } = effectiveLockDate(locks, scope);
  if (lockDate != null && compareLocalDate(date, lockDate) <= 0) {
    throw new LedgerError('LEDGER_PERIOD_LOCKED', {
      date,
      lockDate,
      lockFields: fields,
      firstOpenDate: addDays(lockDate, 1),
    });
  }
}

/**
 * تاريخ العكس اليدوي (معالج JE‑06، §2.4): الافتراضي max(اليوم، الأصل)؛ المطلوب يُقبل إن كان ≥ الأصل
 * وخارج الفترات المقفلة، وإلا LEDGER_PERIOD_LOCKED.
 */
export function manualReversalDate(input: {
  requested?: LocalDate | null;
  today: LocalDate;
  originalMoveDate: LocalDate;
  locks: LockDates;
  scope: LockScope;
}): LocalDate {
  const { today, originalMoveDate, locks, scope } = input;
  assertLocalDate(today, 'today');
  assertLocalDate(originalMoveDate, 'originalMoveDate');
  const date = input.requested ?? maxLocalDate(today, originalMoveDate);
  assertLocalDate(date, 'requested');
  if (compareLocalDate(date, originalMoveDate) < 0) {
    throw new LedgerError('LEDGER_PERIOD_LOCKED', {
      reason: 'BEFORE_ORIGINAL_DATE',
      date,
      originalDate: originalMoveDate,
    });
  }
  assertManualDateOpen(date, locks, scope);
  return date;
}

// ═══ تغيير تواريخ الإقفال ═══

export type LockDateDirection = 'ADVANCE' | 'BACKWARD' | 'UNCHANGED';

export interface LockDateChange {
  field: LockDateField;
  from: LocalDate | null;
  to: LocalDate | null;
  direction: LockDateDirection;
}

export interface LockDateChangePlan {
  changes: LockDateChange[];
  /** الحقول المتقدمة (new > old أو old = null) — كلٌّ منها يُفحص بـlockSyncBlockers والمسودات */
  advancing: { field: LockDateField; newDate: LocalDate }[];
  /** القيم الناتجة بعد التغيير */
  result: LockDates;
}

function directionOf(from: LocalDate | null, to: LocalDate | null): LockDateDirection {
  if (from === to) return 'UNCHANGED';
  if (to == null) return 'BACKWARD';
  if (from == null) return 'ADVANCE';
  const c = compareLocalDate(to, from);
  return c > 0 ? 'ADVANCE' : c < 0 ? 'BACKWARD' : 'UNCHANGED';
}

/**
 * يتحقق من تغيير تواريخ الإقفال (PUT /lock-dates):
 * - hardLockDate لا يتراجع أبداً (ولا يُمسح) ⇒ LEDGER_LOCK_DATE_BACKWARD.
 * - لا تاريخ إقفال في المستقبل (بعد اليوم المحلي للشركة) ⇒ LEDGER_PERIOD_LOCKED بـreason='LOCK_DATE_IN_FUTURE'.
 * - تراجع الثلاثة الأخرى مسموح ولا يُفحص.
 * الحقل الغائب من next (undefined) يبقى كما هو.
 */
export function planLockDateChange(input: {
  current: LockDates;
  next: Partial<LockDates>;
  today: LocalDate;
}): LockDateChangePlan {
  const { current, next, today } = input;
  assertLocalDate(today, 'today');
  const changes: LockDateChange[] = [];
  const advancing: { field: LockDateField; newDate: LocalDate }[] = [];
  const result = { ...pickLocks(current) };
  for (const field of LOCK_DATE_FIELDS) {
    const from = current[field] ?? null;
    if (from != null) assertLocalDate(from, field);
    const to = next[field] === undefined ? from : next[field] ?? null;
    if (to != null) assertLocalDate(to, field);
    const direction = directionOf(from, to);
    changes.push({ field, from, to, direction });
    if (direction === 'UNCHANGED') continue;
    if (field === 'hardLockDate' && direction === 'BACKWARD') {
      throw new LedgerError('LEDGER_LOCK_DATE_BACKWARD', { field, from, to });
    }
    if (to != null && compareLocalDate(to, today) > 0) {
      throw new LedgerError('LEDGER_PERIOD_LOCKED', { reason: 'LOCK_DATE_IN_FUTURE', field, date: to, today });
    }
    if (direction === 'ADVANCE' && to != null) advancing.push({ field, newDate: to });
    result[field] = to;
  }
  return { changes, advancing, result };
}

function pickLocks(l: LockDates): LockDates {
  return {
    salesLockDate: l.salesLockDate ?? null,
    purchaseLockDate: l.purchaseLockDate ?? null,
    taxLockDate: l.taxLockDate ?? null,
    hardLockDate: l.hardLockDate ?? null,
  };
}

// ═══ المسودات قبل الإقفال ═══

export interface DraftsBeforeLock {
  ids: string[];
  count: number;
  listUrl: string;
}

export function draftsListUrl(lockDate: LocalDate): string {
  return `/app/ledger/entries?state=DRAFT&dateTo=${lockDate}`;
}

/** المسودات بتاريخ ≤ تاريخ الإقفال الجديد، أو null إن لا شيء. */
export function draftsBeforeLock(
  drafts: readonly { id: string; date: LocalDate }[],
  lockDate: LocalDate,
): DraftsBeforeLock | null {
  assertLocalDate(lockDate, 'lockDate');
  const ids = drafts.filter(d => compareLocalDate(d.date, lockDate) <= 0).map(d => d.id);
  if (ids.length === 0) return null;
  return { ids, count: ids.length, listUrl: draftsListUrl(lockDate) };
}

export function assertNoDraftsBeforeLock(drafts: readonly { id: string; date: LocalDate }[], lockDate: LocalDate): void {
  const r = draftsBeforeLock(drafts, lockDate);
  if (r) throw new LedgerError('LEDGER_DRAFTS_BEFORE_LOCK', { ...r });
}

// ═══ lockSyncBlockers (§2.5) ═══

/** نبضة المجدول (§5.1). */
export const LOCK_SYNC_HEARTBEAT_MS = 60_000;
/** LATE_COMMIT_WINDOW (§5.2 البند 1) — نسخة محلية حتى يُنشأ sync/constants.ts في M3 بالقيمة نفسها. */
export const LOCK_SYNC_LATE_COMMIT_WINDOW_MS = 10 * 60_000;
/** حد الأحداث المعروضة في الاستجابة. */
export const LOCK_SYNC_EVENT_LIMIT = 50;

export const LOCK_BLOCKING_EVENT_STATUSES = ['PENDING', 'BLOCKED', 'ERROR', 'HELD'] as const;

export const SYNC_CURSOR_SOURCES = [
  'ACCOUNT_ENTRY',
  'REP_SETTLEMENT',
  'SETTLEMENT_ENTRY',
  'WAREHOUSE_ENTRY',
  'VAN_LOAD',
  'RETURN_RESTOCK',
] as const;
export type SyncCursorSource = (typeof SYNC_CURSOR_SOURCES)[number];

/** المؤشرات النشطة: الثلاثة دائماً، ومعها مصادر المخزون في الجرد المستمر. */
export function activeSyncSources(inventoryMode: InventoryMode): SyncCursorSource[] {
  const base: SyncCursorSource[] = ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY'];
  return inventoryMode === 'PERPETUAL' ? [...base, 'WAREHOUSE_ENTRY', 'VAN_LOAD', 'RETURN_RESTOCK'] : base;
}

export interface LockSyncSettings {
  timezone: string;
  inventoryMode: InventoryMode;
  activatedAt: Date | string | null;
  backfillState: BackfillState;
}

export interface SyncCursorSnapshot {
  source: string;
  watermarkAt: Date | null;
  lastRunAt: Date | null;
  /** نتيجة EXISTS … ("createdAt","id") > المؤشر AND "createdAt" <= horizon (§5.2 البند 5) */
  hasUnreadRows: boolean;
}

export interface SourceEventSnapshot {
  id: string;
  sourceKey: string;
  status: string;
  effectAt: Date;
  lastError: string | null;
}

export interface LockEventSummary {
  /** الأحداث المرشّحة (يكفي أول 50 من الاستعلام، ويجوز تمرير أكثر؛ الدالة تعيد التصفية) */
  events: readonly SourceEventSnapshot[];
  /** عدد الأحداث المطابقة للشرط في القاعدة إن كانت events مقطوعة */
  eventCount?: number;
}

export interface LockSyncInput {
  settings: LockSyncSettings;
  cursors: readonly SyncCursorSnapshot[];
  eventSummary: LockEventSummary;
  newDate: LocalDate;
  /** ساعة القاعدة (dbNow) */
  now: Date;
}

export interface LockSyncBlockers {
  code: 'LEDGER_NOT_SETUP' | 'LEDGER_SYNC_PENDING';
  backfillState: BackfillState;
  laggingSources: { source: string; watermarkAt: string | null; lastRunAt: string | null }[];
  events: { id: string; sourceKey: string; status: string; effectAt: string; lastError: string | null }[];
  eventCount: number;
}

/** حد الاستعلام: effectAt < zonedStartOfDay(newDate + 1 يوم, timezone) — أي تاريخه المحلي ≤ newDate. */
export function lockSyncEventCutoff(newDate: LocalDate, timeZone: string = DEFAULT_TIMEZONE): Date {
  assertLocalDate(newDate, 'newDate');
  return zonedStartOfDay(addDays(newDate, 1), timeZone);
}

/** شرط where الجاهز للمسار: {status in [...], effectAt < cutoff} على الفهرس [tenantId, status, effectAt]. */
export function lockSyncEventWhere(newDate: LocalDate, timeZone: string = DEFAULT_TIMEZONE) {
  return {
    status: { in: [...LOCK_BLOCKING_EVENT_STATUSES] as string[] },
    effectAt: { lt: lockSyncEventCutoff(newDate, timeZone) },
  };
}

/** هل المؤشر متأخر (§2.5 ج)؟ */
export function isCursorLagging(cursor: SyncCursorSnapshot | undefined, now: Date): boolean {
  if (!cursor) return true;
  const nowMs = now.getTime();
  const twoBeats = 2 * LOCK_SYNC_HEARTBEAT_MS;
  if (cursor.lastRunAt == null || nowMs - cursor.lastRunAt.getTime() > twoBeats) return true;
  if (!cursor.hasUnreadRows) return false;
  if (cursor.watermarkAt == null) return true;
  return nowMs - cursor.watermarkAt.getTime() > LOCK_SYNC_LATE_COMMIT_WINDOW_MS + twoBeats;
}

/**
 * عوائق تقديم تاريخ إقفال (أو قفل الإقرار periodEnd، أو إقفال المخزون/السنة): null إن لا عائق.
 * (أ) activatedAt فارغ ⇒ LEDGER_NOT_SETUP؛ backfillState ≠ DONE ⇒ محجوب.
 * (ب) أحداث PENDING/BLOCKED/ERROR/HELD تاريخها المحلي ≤ newDate.
 * (ج) مؤشر نشط متأخر (lastRunAt أقدم من نبضتين، أو صفوف غير مقروءة مع watermarkAt متأخر).
 */
export function lockSyncBlockers(input: LockSyncInput): LockSyncBlockers | null {
  const { settings, cursors, eventSummary, newDate, now } = input;
  const tz = settings.timezone || DEFAULT_TIMEZONE;
  const cutoff = lockSyncEventCutoff(newDate, tz).getTime();

  const blocking = new Set<string>(LOCK_BLOCKING_EVENT_STATUSES);
  const matched = eventSummary.events
    .filter(e => blocking.has(e.status) && e.effectAt.getTime() < cutoff)
    .slice()
    .sort((a, b) => a.effectAt.getTime() - b.effectAt.getTime() || (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0));
  const eventCount = Math.max(matched.length, eventSummary.eventCount ?? 0);

  const bySource = new Map<string, SyncCursorSnapshot>();
  for (const c of cursors) bySource.set(c.source, c);
  const laggingSources: LockSyncBlockers['laggingSources'] = [];
  for (const source of activeSyncSources(settings.inventoryMode)) {
    const c = bySource.get(source);
    if (isCursorLagging(c, now)) {
      laggingSources.push({
        source,
        watermarkAt: c?.watermarkAt ? c.watermarkAt.toISOString() : null,
        lastRunAt: c?.lastRunAt ? c.lastRunAt.toISOString() : null,
      });
    }
  }

  const notSetup = settings.activatedAt == null;
  const backfillBlocked = settings.backfillState !== 'DONE';
  if (!notSetup && !backfillBlocked && laggingSources.length === 0 && eventCount === 0) return null;

  return {
    code: notSetup ? 'LEDGER_NOT_SETUP' : 'LEDGER_SYNC_PENDING',
    backfillState: settings.backfillState,
    laggingSources,
    events: matched.slice(0, LOCK_SYNC_EVENT_LIMIT).map(e => ({
      id: e.id,
      sourceKey: e.sourceKey,
      status: e.status,
      effectAt: e.effectAt.toISOString(),
      lastError: e.lastError ?? null,
    })),
    eventCount,
  };
}

/** يرمي LEDGER_NOT_SETUP أو LEDGER_SYNC_PENDING بتفاصيل الاستجابة (§2.5). */
export function assertNoLockSyncBlockers(input: LockSyncInput): void {
  const b = lockSyncBlockers(input);
  if (!b) return;
  const { code, ...details } = b;
  throw new LedgerError(code, details);
}

// ─── مساعدات ───

function assertLocalDate(v: unknown, name: string): asserts v is LocalDate {
  if (!isLocalDate(v)) throw new RangeError(`${name}: تاريخ محلي غير صالح (YYYY-MM-DD): ${String(v)}`);
}
