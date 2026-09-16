/**
 * ترحيل القيود (M2، DESIGN.md §5.4 postMove، §2.1 I1–I8، §2.4، §2.5، §9.3، §9.5 G1/G2/G5).
 *
 * كل الدوال تعمل **داخل معاملة المُستدعي** (tx) ولا تفتح معاملة: المُرحِّل (M3) والمسارات تلفّها بـprisma.$transaction.
 * ترتيب postMove:
 *   1. pg_advisory_xact_lock(hashtext('gl-post:'||tid)) — قفل معاملة لا جلسة.
 *   2. إعادة قراءة الإعدادات والسياق بعد القفل (تواريخ الإقفال الحالية، §2.5).
 *   3. validateMove (I1–I5، I8) من M1.
 *   4. الإقفال: اليدوي يُرفض LEDGER_PERIOD_LOCKED، والآلي يُزاح (ADR‑7) — locks.ts.
 *   5. الرقم من gl_sequences داخل المعاملة (I6: UPDATE … nextNumber + 1 RETURNING — يتراجع مع المعاملة فلا فجوات).
 *   6. القيد وسطوره posted=true (أو قلب المسودة القائمة بشرط state:'DRAFT' وnumber:null).
 *   7. الأرصدة الشهرية GlPeriodBalance تزايدياً (INSERT … ON CONFLICT DO UPDATE)، والعلامات مستبعدة.
 *   8. GlAuditLog في المعاملة نفسها.
 * **لا فحص activatedAt هنا** (§6.1): قيد OPEN يُرحَّل داخل معاملة التفعيل قبل ضبطه؛ الفحص في المسارات والمجدول.
 */
import crypto from 'node:crypto';
import { appendAudit, type GlActor, type GlTx } from './audit';
import { fromDbDate, parseLocalDate, toDbDate } from './dates';
import { applyAutoLockShift, assertManualDateOpen, lockScopeOfDraft, type LockDates } from './locks';
import { formatMoveNumber, isSequenceReset, journalCodeConflict, sequenceGroup, type SequenceGroup } from './sequence';
import { validateMove, validationModeOf, type ValidationMode } from './validate';
import {
  GlNotFoundError, loadBuildContext, moveDraftFromRecord, requireMoveRecord, settingsSnapshotFromRow,
  type LedgerContext,
} from './resolve';
import {
  LedgerError,
  type JournalRef, type LocalDate, type Milli, type MoveDraft, type MoveType, type TaxRole,
} from './types';

export type { GlTx } from './audit';

// ═══ القفل ═══

export const POST_LOCK_PREFIX = 'gl-post:';

/**
 * قفل الترحيل الاستشاري للشركة داخل المعاملة: pg_advisory_xact_lock(hashtext('gl-post:'||tid)).
 * يُحرَّر تلقائياً بنهاية المعاملة، ويجوز أخذه مرتين في المعاملة نفسها (قيد + عكس).
 */
export async function acquirePostLock(tx: GlTx, tenantId: string): Promise<void> {
  if (!tenantId) throw new RangeError('acquirePostLock: tenantId مطلوب');
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${POST_LOCK_PREFIX + tenantId}::text))`;
}

// ═══ الترقيم (I6) ═══

/**
 * يمنح الرقم التالي لمجموعة (دفتر، بادئة، فترة) داخل المعاملة: upsert أولي ثم
 * UPDATE gl_sequences SET nextNumber = nextNumber + 1 … RETURNING — يتراجع مع المعاملة فلا فجوات.
 */
export async function nextSequenceNumber(tx: GlTx, tenantId: string, group: SequenceGroup): Promise<number> {
  await tx.glSequence.upsert({
    where: { journalId_prefix_periodKey: { journalId: group.journalId, prefix: group.prefix, periodKey: group.periodKey } },
    create: { tenantId, journalId: group.journalId, prefix: group.prefix, periodKey: group.periodKey, nextNumber: 1 },
    update: {},
  });
  const rows = await tx.$queryRaw<{ n: number }[]>`
    UPDATE "gl_sequences" SET "nextNumber" = "nextNumber" + 1
    WHERE "journalId" = ${group.journalId} AND "prefix" = ${group.prefix} AND "periodKey" = ${group.periodKey}
      AND "tenantId" = ${tenantId}
    RETURNING ("nextNumber" - 1) AS "n"`;
  const n = Number(rows[0]?.n);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`تعذّر منح رقم التسلسل ${group.prefix}/${group.periodKey}`);
  return n;
}

// ═══ الأرصدة الشهرية (صرفة + SQL) ═══

/** مفتاح الرصيد: YYYY-MM من التاريخ المحاسبي، و"YYYY-CL" لبنود قيد إقفال السنة (§2.5). */
export function periodKeyForBalance(date: LocalDate, moveType: MoveType | string): string {
  const { y, m } = parseLocalDate(date);
  const yyyy = String(y).padStart(4, '0');
  return moveType === 'FY_CLOSING' ? `${yyyy}-CL` : `${yyyy}-${String(m).padStart(2, '0')}`;
}

export interface BalanceLine {
  accountId: string;
  debitMilli: Milli;
  creditMilli: Milli;
  taxRole?: TaxRole | string | null;
}

export interface PeriodBalanceDelta {
  accountId: string;
  periodKey: string;
  debitMilli: Milli;
  creditMilli: Milli;
}

/** تجميع البنود غير الصفرية حسب (حساب، فترة) — سطور MARKER مستبعدة (I1). مرتبة بالحساب للحتمية. */
export function periodBalanceDeltas(lines: readonly BalanceLine[], date: LocalDate, moveType: MoveType | string): PeriodBalanceDelta[] {
  const periodKey = periodKeyForBalance(date, moveType);
  const byAccount = new Map<string, PeriodBalanceDelta>();
  for (const l of lines) {
    if (l.taxRole === 'MARKER') continue;
    if (l.debitMilli === 0n && l.creditMilli === 0n) continue;
    const cur = byAccount.get(l.accountId) ?? { accountId: l.accountId, periodKey, debitMilli: 0n, creditMilli: 0n };
    cur.debitMilli += l.debitMilli;
    cur.creditMilli += l.creditMilli;
    byAccount.set(l.accountId, cur);
  }
  return [...byAccount.values()].sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
}

/** يضيف الفروق إلى gl_period_balances تزايدياً (لا طرح ولا كتابة فوق): INSERT … ON CONFLICT DO UPDATE. */
export async function applyPeriodBalances(tx: GlTx, tenantId: string, deltas: readonly PeriodBalanceDelta[]): Promise<void> {
  for (const d of deltas) {
    await tx.$executeRaw`
      INSERT INTO "gl_period_balances" ("id", "tenantId", "accountId", "periodKey", "debitMilli", "creditMilli")
      VALUES (${crypto.randomUUID()}, ${tenantId}, ${d.accountId}, ${d.periodKey}, ${d.debitMilli}, ${d.creditMilli})
      ON CONFLICT ("tenantId", "accountId", "periodKey") DO UPDATE SET
        "debitMilli" = "gl_period_balances"."debitMilli" + EXCLUDED."debitMilli",
        "creditMilli" = "gl_period_balances"."creditMilli" + EXCLUDED."creditMilli"`;
  }
}

// ═══ postMove ═══

export interface PostMoveOptions {
  tenantId: string;
  actor: GlActor;
  /** سياق محمَّل مسبقاً (الحسابات والضرائب والدفاتر)؛ تواريخ الإقفال تُعاد قراءتها بعد القفل دائماً */
  context?: LedgerContext;
  /** الافتراضي من origin: MANUAL ⇒ MANUAL، AUTO ⇒ SYSTEM */
  validationMode?: ValidationMode;
  /** الافتراضي من origin: MANUAL ⇒ REJECT (LEDGER_PERIOD_LOCKED)، AUTO ⇒ SHIFT (ADR‑7) */
  lockPolicy?: 'REJECT' | 'SHIFT';
  /** للقيد العكسي (reverse.ts) */
  reversedMoveId?: string | null;
  reversalReason?: string | null;
  /** نسخة «إعادة إلى مسودة» لا تُرحَّل هنا؛ الحقل للقيود التي تُنشأ مرحّلة من مسودة سابقة */
  draftOfMoveId?: string | null;
  /** يُنشئ GlMoveSource من draft.sourceKey (الافتراضي true حين يوجد المفتاح) — P2002 عليه يُسقط المعاملة (§5.4) */
  createSource?: boolean;
  auditAction?: string;
  auditSummary?: string;
  /** يُدمج في afterJson */
  auditExtra?: Record<string, unknown>;
  now?: Date;
}

export interface PostedMove {
  id: string;
  number: string;
  journalId: string;
  date: LocalDate;
  originalDate: LocalDate | null;
  lateArrival: boolean;
  totalMilli: Milli;
  sequence: SequenceGroup & { n: number };
  auditSeq: number;
}

interface PreparedPost {
  draft: MoveDraft;
  journal: JournalRef;
  resolvedLines: {
    seq: number; accountId: string; taxId: string | null; line: MoveDraft['lines'][number];
  }[];
  totalMilli: Milli;
  number: string;
  group: SequenceGroup & { n: number };
}

function resolveJournal(draft: MoveDraft, context: LedgerContext, journalId?: string): JournalRef {
  const ctx = context.ctx;
  // مسودة مخزّنة: دفترها بمعرّفه؛ وإلا systemKey ثم الرمز
  const j = (journalId ? context.journalById.get(journalId) : null)
    ?? (draft.journalSystemKey ? ctx.journals.bySystemKey(draft.journalSystemKey) : null) ?? ctx.journals.byCode(draft.journalCode);
  if (!j) {
    throw new LedgerError('LEDGER_ACCOUNT_NOT_FOUND', {
      reason: 'JOURNAL_NOT_FOUND', journalCode: draft.journalCode, journalSystemKey: draft.journalSystemKey ?? null,
    });
  }
  return j;
}

/** الخطوات 2–5 المشتركة بين قيد جديد وترحيل مسودة قائمة — بعد أخذ القفل. */
async function preparePost(tx: GlTx, input: MoveDraft, opts: PostMoveOptions, journalId?: string): Promise<PreparedPost> {
  const { tenantId } = opts;
  // (2) إعادة القراءة بعد القفل
  const settingsRow = await tx.glSettings.findUnique({ where: { tenantId } });
  if (!settingsRow) throw new LedgerError('LEDGER_NOT_SETUP', { reason: 'SETTINGS_MISSING' });
  const context = opts.context ?? (await loadBuildContext(tx, tenantId));
  const ctx = context.ctx;
  const fresh = settingsSnapshotFromRow(settingsRow);
  const locks: LockDates = {
    salesLockDate: fresh.salesLockDate, purchaseLockDate: fresh.purchaseLockDate,
    taxLockDate: fresh.taxLockDate, hardLockDate: fresh.hardLockDate,
  };

  // (3) الثوابت I1–I5 وI8
  const mode = opts.validationMode ?? validationModeOf(input);
  const validated = validateMove(input, ctx, { mode });

  // (4) تواريخ الإقفال
  const scope = lockScopeOfDraft(input, ctx);
  const policy = opts.lockPolicy ?? (input.origin === 'AUTO' ? 'SHIFT' : 'REJECT');
  let draft = input;
  if (policy === 'SHIFT') draft = applyAutoLockShift(input, locks, scope);
  else assertManualDateOpen(input.date, locks, scope);

  const journal = resolveJournal(draft, context, journalId);

  // (5) الرقم داخل المعاملة
  const g = sequenceGroup({ journal, moveType: draft.moveType, date: draft.date, sequencePrefix: draft.sequencePrefix });
  const n = await nextSequenceNumber(tx, tenantId, g);
  const number = formatMoveNumber(g.prefix, g.periodKey, journal.sequenceReset, n);

  let totalMilli = 0n;
  const resolvedLines = validated.lines.map((r, i) => {
    totalMilli += r.line.debitMilli;
    return { seq: i, accountId: r.account.id, taxId: r.tax?.id ?? r.line.taxId ?? null, line: r.line };
  });
  return { draft, journal, resolvedLines, totalMilli, number, group: { ...g, n } };
}

function auditAfter(p: PreparedPost, opts: PostMoveOptions, id: string): Record<string, unknown> {
  return {
    id,
    number: p.number,
    journalCode: p.journal.code,
    date: p.draft.date,
    originalDate: p.draft.originalDate ?? null,
    lateArrival: p.draft.lateArrival === true,
    moveType: p.draft.moveType,
    origin: p.draft.origin,
    totalMilli: p.totalMilli.toString(),
    lineCount: p.resolvedLines.length,
    sourceType: p.draft.sourceType ?? null,
    sourceId: p.draft.sourceId ?? null,
    sourceKey: p.draft.sourceKey ?? null,
    reversedMoveId: opts.reversedMoveId ?? null,
    reversalReason: opts.reversalReason ?? null,
    ...(opts.auditExtra ?? {}),
  };
}

/**
 * يُنشئ قيداً مرحّلاً من MoveDraft داخل المعاملة tx (القيود الآلية، القيد العكسي، قيد OPEN).
 * الأخطاء: LedgerError من validate/locks (LEDGER_UNBALANCED، LEDGER_ACCOUNT_ARCHIVED، LEDGER_CONTROL_ACCOUNT_MANUAL،
 * LEDGER_VAT_LINE_UNTAGGED، LEDGER_PARTNER_REQUIRED، LEDGER_ACCOUNT_NOT_FOUND، LEDGER_OFF_BALANCE_MIXED، LEDGER_PERIOD_LOCKED)،
 * وLEDGER_NOT_SETUP{reason:'SETTINGS_MISSING'} بلا صف GlSettings، وP2002 من Prisma على gl_move_sources أو number.
 */
export async function postMove(tx: GlTx, input: MoveDraft, opts: PostMoveOptions): Promise<PostedMove> {
  const { tenantId, actor } = opts;
  // (1) القفل أولاً
  await acquirePostLock(tx, tenantId);
  const p = await preparePost(tx, input, opts);
  const now = opts.now ?? new Date();
  const d = p.draft;

  // (6) القيد وسطوره مرحّلة
  const move = await tx.glMove.create({
    data: {
      tenantId,
      journalId: p.journal.id,
      number: p.number,
      state: 'POSTED',
      moveType: d.moveType,
      origin: d.origin,
      date: toDbDate(d.date),
      originalDate: d.originalDate ? toDbDate(d.originalDate) : null,
      lateArrival: d.lateArrival === true,
      ref: d.ref ?? null,
      narration: d.narration,
      currencyCode: d.currencyCode,
      currencyDecimals: d.currencyDecimals,
      totalMilli: p.totalMilli,
      customerId: d.customerId ?? null,
      vendorId: d.vendorId ?? null,
      salesRepId: d.salesRepId ?? null,
      sourceType: d.sourceType ?? null,
      sourceId: d.sourceId ?? null,
      reversedMoveId: opts.reversedMoveId ?? null,
      reversalReason: opts.reversalReason ?? null,
      draftOfMoveId: opts.draftOfMoveId ?? null,
      needsAttention: d.needsAttention,
      attentionReason: d.attentionReason ?? null,
      createdBy: actor.actorId,
      createdByImpersonated: actor.impersonated === true,
      postedAt: now,
      postedBy: actor.actorId,
      postedByImpersonated: actor.impersonated === true,
      lines: {
        create: p.resolvedLines.map((r) => ({
          tenantId,
          seq: r.seq,
          accountId: r.accountId,
          journalId: p.journal.id,
          date: toDbDate(d.date),
          posted: true,
          label: r.line.label,
          debitMilli: r.line.debitMilli,
          creditMilli: r.line.creditMilli,
          customerId: r.line.customerId ?? null,
          vendorId: r.line.vendorId ?? null,
          salesRepId: r.line.salesRepId ?? null,
          partnerName: r.line.partnerName ?? null,
          analyticAccountId: r.line.analyticAccountId ?? null,
          productId: r.line.productId ?? null,
          quantity: r.line.quantity ?? null,
          taxId: r.taxId,
          taxRole: r.line.taxRole ?? null,
          taxBaseMilli: r.line.taxBaseMilli ?? null,
          vatBox: r.line.vatBox ?? null,
          vatAdjustment: r.line.vatAdjustment === true,
          dueDate: r.line.dueDate ? toDbDate(r.line.dueDate) : null,
        })),
      },
    },
    select: { id: true },
  });

  // مفتاح المصدر — الحماية القاطعة من التكرار (§5.4)
  if (opts.createSource !== false && d.sourceKey && d.sourceType && d.sourceId && d.sourceEvent) {
    await tx.glMoveSource.create({
      data: { tenantId, moveId: move.id, sourceKey: d.sourceKey, sourceType: d.sourceType, sourceId: d.sourceId, event: d.sourceEvent },
    });
  }

  // (7) الأرصدة الشهرية
  await applyPeriodBalances(tx, tenantId, periodBalanceDeltas(
    p.resolvedLines.map((r) => ({ accountId: r.accountId, debitMilli: r.line.debitMilli, creditMilli: r.line.creditMilli, taxRole: r.line.taxRole })),
    d.date, d.moveType,
  ));

  // (8) التدقيق في المعاملة نفسها
  const audit = await appendAudit(tx, {
    tenantId,
    actor,
    action: opts.auditAction ?? (d.origin === 'AUTO' ? 'AUTO_POST' : 'MOVE_POST'),
    entityType: 'MOVE',
    entityId: move.id,
    summary: opts.auditSummary ?? `ترحيل القيد ${p.number}`,
    after: auditAfter(p, opts, move.id),
    at: now,
  });

  return {
    id: move.id, number: p.number, journalId: p.journal.id, date: d.date, originalDate: d.originalDate ?? null,
    lateArrival: d.lateArrival === true, totalMilli: p.totalMilli, sequence: p.group, auditSeq: audit.seq,
  };
}

export interface PostDraftOptions extends Omit<PostMoveOptions, 'reversedMoveId' | 'reversalReason' | 'draftOfMoveId' | 'createSource'> {
  moveId: string;
}

/**
 * يرحّل مسودة قائمة (POST /moves/:id/post، /moves/post-drafts، مجدول autoPostOn) داخل المعاملة tx.
 * يقرأ المسودة وسطورها **بعد** القفل، ويقلب الرأس بشرط state:'DRAFT' وnumber:null (سباق ⇒ LEDGER_MOVE_NOT_DRAFT)،
 * ويقلب posted على السطور وينسخ إليها date وjournalId فقط — لا مساس بالمبالغ أو الحسابات.
 * الأخطاء: GlNotFoundError، LEDGER_MOVE_NOT_DRAFT، LEDGER_SECURED_MOVE، وكل أخطاء postMove.
 * **لا فحص activatedAt** — المسار والمجدول يردّان LEDGER_NOT_SETUP قبل الاستدعاء (§6.1).
 */
export async function postDraftMove(tx: GlTx, opts: PostDraftOptions): Promise<PostedMove> {
  const { tenantId, actor, moveId } = opts;
  await acquirePostLock(tx, tenantId);
  const rec = await requireMoveRecord(tx, tenantId, moveId);
  if (rec.state !== 'DRAFT' || rec.number !== null || rec.postedAt !== null) {
    throw new LedgerError('LEDGER_MOVE_NOT_DRAFT', { moveId, state: rec.state, number: rec.number });
  }
  if (rec.secureSeq !== null || rec.secureHash !== null) throw new LedgerError('LEDGER_SECURED_MOVE', { moveId });

  const p = await preparePost(tx, moveDraftFromRecord(rec), opts, rec.journalId);
  const now = opts.now ?? new Date();
  const d = p.draft;

  const flipped = await tx.glMove.updateMany({
    where: { id: moveId, tenantId, state: 'DRAFT', number: null },
    data: {
      state: 'POSTED',
      number: p.number,
      journalId: p.journal.id,
      date: toDbDate(d.date),
      originalDate: d.originalDate ? toDbDate(d.originalDate) : null,
      lateArrival: d.lateArrival === true,
      totalMilli: p.totalMilli,
      postedAt: now,
      postedBy: actor.actorId,
      postedByImpersonated: actor.impersonated === true,
    },
  });
  if (flipped.count !== 1) throw new LedgerError('LEDGER_MOVE_NOT_DRAFT', { moveId, reason: 'RACE' });

  // قلب posted على السطور (والتاريخ والدفتر المنسوخان) — داخل معاملة الترحيل وحدها
  await tx.glMoveLine.updateMany({
    where: { tenantId, moveId },
    data: { posted: true, date: toDbDate(d.date), journalId: p.journal.id },
  });

  await applyPeriodBalances(tx, tenantId, periodBalanceDeltas(
    p.resolvedLines.map((r) => ({ accountId: r.accountId, debitMilli: r.line.debitMilli, creditMilli: r.line.creditMilli, taxRole: r.line.taxRole })),
    d.date, d.moveType,
  ));

  const audit = await appendAudit(tx, {
    tenantId,
    actor,
    action: opts.auditAction ?? (d.origin === 'AUTO' ? 'AUTO_POST' : 'MOVE_POST'),
    entityType: 'MOVE',
    entityId: moveId,
    summary: opts.auditSummary ?? `ترحيل القيد ${p.number}`,
    before: { id: moveId, state: 'DRAFT', number: null, date: fromDbDate(rec.date) },
    after: auditAfter(p, opts, moveId),
    at: now,
  });

  return {
    id: moveId, number: p.number, journalId: p.journal.id, date: d.date, originalDate: d.originalDate ?? null,
    lateArrival: d.lateArrival === true, totalMilli: p.totalMilli, sequence: p.group, auditSeq: audit.seq,
  };
}


// ═══ G2: قفل ترقيم الدفتر بعد أول ترحيل ═══

export interface JournalNumberingChange {
  code?: string | null;
  sequenceReset?: string | null;
}

/**
 * صرفة: الحقول التي تقسم سلسلة الترقيم (code، sequenceReset) وتتغيّر فعلاً على دفتر له قيد مرحَّل
 * ⇒ LedgerError LEDGER_JOURNAL_HAS_POSTED_MOVES {journalId, fields, postedMoves}، وإلا null (§9.5 G2).
 */
export function journalNumberingViolation(
  journal: { id: string; code: string; sequenceReset: string },
  next: JournalNumberingChange,
  postedMoves: number,
): LedgerError | null {
  const fields: ('code' | 'sequenceReset')[] = [];
  if (next.code != null && next.code !== journal.code) fields.push('code');
  if (next.sequenceReset != null && next.sequenceReset !== journal.sequenceReset) fields.push('sequenceReset');
  if (fields.length === 0 || postedMoves === 0) return null;
  return new LedgerError('LEDGER_JOURNAL_HAS_POSTED_MOVES', { journalId: journal.id, fields, postedMoves });
}

/**
 * لمسار PUT /journals/:id (وPOST بلا journalId): يرمي LEDGER_JOURNAL_HAS_POSTED_MOVES إن تغيّر code أو sequenceReset
 * لدفتر له قيد مرحَّل (G2)، وLEDGER_JOURNAL_CODE_CONFLICT {code, conflictsWith} إن ساوى الرمز الجديد رمز دفتر آخر
 * أو بادئة مرتجعه (journalCodeConflict). يُستدعى داخل معاملة الحفظ بعد acquirePostLock حتى لا يسبقه ترحيل.
 * دفتر غير موجود للشركة ⇒ GlNotFoundError (من resolve.ts).
 */
export async function assertJournalNumberingEditable(
  tx: GlTx,
  input: { tenantId: string; journalId?: string | null } & JournalNumberingChange,
): Promise<void> {
  const { tenantId, journalId } = input;
  if (input.sequenceReset != null && !isSequenceReset(input.sequenceReset)) {
    throw new RangeError(`sequenceReset غير صالح: ${String(input.sequenceReset)}`);
  }
  if (journalId) {
    const journal = await tx.glJournal.findFirst({ where: { id: journalId, tenantId }, select: { id: true, code: true, sequenceReset: true } });
    if (!journal) throw new GlNotFoundError('GlJournal', journalId);
    const changes = (input.code != null && input.code !== journal.code) || (input.sequenceReset != null && input.sequenceReset !== journal.sequenceReset);
    if (changes) {
      const posted = await tx.glMove.count({ where: { tenantId, journalId, state: 'POSTED' } });
      const violation = journalNumberingViolation(journal, input, posted);
      if (violation) throw violation;
    }
    if (input.code == null || input.code === journal.code) return;
  }
  if (input.code == null) return;
  const others = await tx.glJournal.findMany({
    where: { tenantId, ...(journalId ? { id: { not: journalId } } : {}) },
    select: { code: true },
  });
  const conflict = journalCodeConflict(input.code, others.map((j) => j.code));
  if (conflict) throw new LedgerError('LEDGER_JOURNAL_CODE_CONFLICT', { code: input.code, conflictsWith: conflict });
}
