/**
 * العكس و«إعادة إلى مسودة» وحذف المسودة (M2، DESIGN.md §2.4، §6.1، §2.1 I7، §9.5 G1/G5).
 *
 * - assertManualOwned قبل reverseMove/resetDraft في المسارات اليدوية: قيد مملوك لمصدر ⇒ 409 LEDGER_SOURCE_OWNED_MOVE
 *   مع {sourceType, sourceId, ownerAction}.
 * - reversalReason إلزامي دائماً (G5) ⇒ 422 LEDGER_REVERSAL_REASON_REQUIRED؛ العكس الآلي يملؤه من المستند.
 * - القيد العكسي يُبنى من **القيد الأصلي الحيّ** بقلب الجانبين سطراً بسطر (والوعاء سالباً)، وينسخ origin وsourceType وsourceId.
 * - حذف المسودة بالترتيب الحرفي في §6.1: القفل ⇒ لقطة التدقيق MOVE_DELETE_DRAFT ⇒ glAttachment.deleteMany
 *   ⇒ glMove.deleteMany بشرط state:'DRAFT' وnumber:null والعدد 1.
 */
import type { Prisma } from '@prisma/client';
import { appendAudit, type GlActor, type GlTx } from './audit';
import { fromDbDate, todayLocal } from './dates';
import { autoReversalDate, lockScopeOfDraft, manualReversalDate, type LockDates } from './locks';
import { acquirePostLock, postMove, type PostedMove } from './post';
import { draftRowsFromMoveDraft, moveAuditHeader, saveDraftMove } from './draft';
import {
  GlNotFoundError, loadBuildContext, manualOwnership, moveDraftFromRecord, requireMoveRecord,
  type MoveRecord, type MoveRecordForDraft, type SourceOwnership,
} from './resolve';
import { sequencePrefixFor } from './sequence';
import { LedgerError, type LocalDate, type MoveDraft, type SourceEvent } from './types';

// ═══ G5: سبب العكس ═══

/** يعيد السبب مشذّباً أو يرمي LEDGER_REVERSAL_REASON_REQUIRED (422). */
export function assertReversalReason(reason: unknown): string {
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (r === '') throw new LedgerError('LEDGER_REVERSAL_REASON_REQUIRED', {});
  return r;
}

// ═══ I7 ═══

/** حقائق الملكية من قيد مخزَّن بسطوره (controlKind لكل سطر من سياق الحسابات). */
export function ownershipOfRecord(
  rec: Pick<MoveRecord, 'origin' | 'sourceType' | 'sourceId' | 'salesRepId' | 'moveType' | 'sources'> & { lines: readonly { accountId: string }[] },
  controlKindOf: (accountId: string) => string | null | undefined,
): SourceOwnership | null {
  return manualOwnership({
    origin: rec.origin,
    sourceType: rec.sourceType,
    sourceId: rec.sourceId,
    salesRepId: rec.salesRepId,
    moveType: rec.moveType,
    moveSources: rec.sources,
    lineControlKinds: rec.lines.map((l) => controlKindOf(l.accountId)),
  });
}

function throwOwned(o: SourceOwnership, moveId: string): never {
  throw new LedgerError('LEDGER_SOURCE_OWNED_MOVE', {
    sourceType: o.sourceType, sourceId: o.sourceId, ownerAction: o.ownerAction, reasons: o.reasons, moveId,
  });
}

/**
 * I7 للمسارات اليدوية: يقرأ القيد وسطوره ومصادره وcontrolKind حساباته، ويرمي LEDGER_SOURCE_OWNED_MOVE
 * {sourceType, sourceId, ownerAction} إن كان مملوكاً لمصدر. يعيد القيد المقروء.
 * غير موجود للشركة ⇒ GlNotFoundError (404).
 */
export async function assertManualOwned(db: GlTx, tenantId: string, moveId: string): Promise<MoveRecord> {
  const rec = await requireMoveRecord(db, tenantId, moveId);
  const accountIds = [...new Set(rec.lines.map((l) => l.accountId))];
  const accounts = accountIds.length
    ? await db.glAccount.findMany({ where: { tenantId, id: { in: accountIds } }, select: { id: true, controlKind: true } })
    : [];
  const kinds = new Map(accounts.map((a) => [a.id, a.controlKind]));
  const owned = ownershipOfRecord(rec, (id) => kinds.get(id));
  if (owned) throwOwned(owned, moveId);
  return rec;
}

// ═══ القيد العكسي (صرفة) ═══

export interface ReversalDraftOptions {
  date: LocalDate;
  reason: string;
  /** رقم الأصل للبيان */
  originalNumber?: string | null;
  /** للعكس الآلي: مفتاح المصدر (مثل INVOICE:<id>:REVERSE) وحدثه */
  sourceKey?: string | null;
  sourceEvent?: SourceEvent | null;
}

/**
 * القيد العكسي من القيد الأصلي الحيّ: قلب الجانبين سطراً بسطر، والوعاء سالباً، وvatAdjustment كما هو،
 * وorigin/sourceType/sourceId منسوخة (§2.4)، والتاريخ المعطى بلا إزاحة (postMove يطبّق الإقفال).
 */
export function reversalDraftFromRecord(original: MoveRecordForDraft, opts: ReversalDraftOptions): MoveDraft {
  const base = moveDraftFromRecord(original);
  const ref = opts.originalNumber ? ` ${opts.originalNumber}` : '';
  return {
    ...base,
    sequencePrefix: sequencePrefixFor(base.journalCode, base.moveType),
    date: opts.date,
    originalDate: null,
    lateArrival: false,
    narration: `عكس القيد${ref}: ${opts.reason}`,
    needsAttention: false,
    attentionReason: null,
    sourceKey: opts.sourceKey ?? null,
    sourceEvent: opts.sourceEvent ?? null,
    lines: base.lines.map((l) => ({
      ...l,
      label: `عكس ${l.label}`.trim(),
      debitMilli: l.creditMilli,
      creditMilli: l.debitMilli,
      taxBaseMilli: l.taxBaseMilli === null || l.taxBaseMilli === undefined ? l.taxBaseMilli : -l.taxBaseMilli,
    })),
  };
}

// ═══ reverseMove ═══

export interface ReverseMoveOptions {
  tenantId: string;
  moveId: string;
  actor: GlActor;
  /** إلزامي (G5) */
  reason: string;
  /**
   * MANUAL (الافتراضي، معالج JE‑06): I7 يُفحص، والتاريخ requestedDate أو max(اليوم، الأصل) ويُرفض المقفل.
   * SYSTEM (المُرحِّل وخدمات الوحدات): بلا I7، وتاريخ max(اليوم، الأصل) مُزاحاً إلى أول يوم مفتوح (ADR‑7).
   */
  mode?: 'MANUAL' | 'SYSTEM';
  requestedDate?: LocalDate | null;
  sourceKey?: string | null;
  sourceEvent?: SourceEvent | null;
  auditAction?: string;
  now?: Date;
}

export interface ReverseResult {
  /** true ⇒ القيد معكوس مسبقاً ولم يُنشأ شيء (reversal = العكس القائم) */
  alreadyReversed: boolean;
  original: { id: string; number: string | null };
  reversal: { id: string; number: string | null; date: LocalDate | null; posted?: PostedMove };
}

/**
 * يعكس قيداً مرحّلاً داخل المعاملة tx. الأخطاء: LEDGER_REVERSAL_REASON_REQUIRED، GlNotFoundError،
 * LEDGER_MOVE_NOT_DRAFT{reason:'NOT_POSTED'} لقيد غير مرحّل، LEDGER_SOURCE_OWNED_MOVE (MANUAL)،
 * LEDGER_PERIOD_LOCKED (MANUAL)، وأخطاء postMove. العكس المكرر يعيد alreadyReversed=true بلا خطأ (§5.4).
 */
export async function reverseMove(tx: GlTx, opts: ReverseMoveOptions): Promise<ReverseResult> {
  const reason = assertReversalReason(opts.reason);
  const { tenantId, moveId, actor } = opts;
  const mode = opts.mode ?? 'MANUAL';
  await acquirePostLock(tx, tenantId);

  const rec = mode === 'MANUAL' ? await assertManualOwned(tx, tenantId, moveId) : await requireMoveRecord(tx, tenantId, moveId);
  if (rec.state !== 'POSTED' || rec.number === null) {
    throw new LedgerError('LEDGER_MOVE_NOT_DRAFT', { reason: 'NOT_POSTED', moveId, state: rec.state });
  }
  if (rec.reversal) {
    const existing = await tx.glMove.findFirst({ where: { id: rec.reversal.id, tenantId }, select: { id: true, number: true, date: true } });
    return {
      alreadyReversed: true,
      original: { id: rec.id, number: rec.number },
      reversal: { id: rec.reversal.id, number: existing?.number ?? rec.reversal.number, date: existing ? fromDbDate(existing.date) : null },
    };
  }

  const context = await loadBuildContext(tx, tenantId);
  const settings = context.ctx.settings;
  const locks: LockDates = {
    salesLockDate: settings.salesLockDate, purchaseLockDate: settings.purchaseLockDate,
    taxLockDate: settings.taxLockDate, hardLockDate: settings.hardLockDate,
  };
  const originalDate = fromDbDate(rec.date);
  const today = todayLocal(opts.now ?? new Date(), settings.timezone);
  const probe = reversalDraftFromRecord(rec, { date: originalDate, reason, originalNumber: rec.number });
  const scope = lockScopeOfDraft(probe, context.ctx);
  const date = mode === 'MANUAL'
    ? manualReversalDate({ requested: opts.requestedDate ?? null, today, originalMoveDate: originalDate, locks, scope })
    : autoReversalDate(today, originalDate, locks, scope).date;

  const draft = reversalDraftFromRecord(rec, {
    date, reason, originalNumber: rec.number, sourceKey: opts.sourceKey ?? null, sourceEvent: opts.sourceEvent ?? null,
  });
  const posted = await postMove(tx, draft, {
    tenantId,
    actor,
    context,
    validationMode: mode === 'MANUAL' ? 'MANUAL' : 'SYSTEM',
    lockPolicy: mode === 'MANUAL' ? 'REJECT' : 'SHIFT',
    reversedMoveId: rec.id,
    reversalReason: reason,
    auditAction: opts.auditAction ?? 'MOVE_REVERSE',
    auditSummary: `عكس القيد ${rec.number}: ${reason}`,
    auditExtra: { originalNumber: rec.number, originalDate },
    now: opts.now,
  });
  return {
    alreadyReversed: false,
    original: { id: rec.id, number: rec.number },
    reversal: { id: posted.id, number: posted.number, date: posted.date, posted },
  };
}

// ═══ resetDraft ═══

export interface ResetDraftOptions {
  tenantId: string;
  moveId: string;
  actor: GlActor;
  /** إلزامي (G5) */
  reason: string;
  requestedDate?: LocalDate | null;
  now?: Date;
}

export interface ResetDraftResult {
  reversal: ReverseResult['reversal'];
  draft: { id: string };
}

/**
 * «إعادة إلى مسودة» (§6.1) للقيود اليدوية وحدها: عكس يدوي ثم نسخة مسودة origin=MANUAL بـdraftOfMoveId = الأصل،
 * بتاريخ الأصل وسطوره كما هي. تدقيقان: MOVE_REVERSE للعكس وMOVE_RESET_DRAFT للنسخة.
 * الأخطاء: كأخطاء reverseMove بوضع MANUAL، وLEDGER_MOVE_NOT_DRAFT{reason:'ALREADY_REVERSED'} لقيد معكوس مسبقاً.
 */
export async function resetDraft(tx: GlTx, opts: ResetDraftOptions): Promise<ResetDraftResult> {
  const reason = assertReversalReason(opts.reason);
  const { tenantId, moveId, actor } = opts;
  await acquirePostLock(tx, tenantId);
  const rec = await assertManualOwned(tx, tenantId, moveId);
  if (rec.reversal) throw new LedgerError('LEDGER_MOVE_NOT_DRAFT', { reason: 'ALREADY_REVERSED', moveId, reversalId: rec.reversal.id });

  const rev = await reverseMove(tx, { tenantId, moveId, actor, reason, mode: 'MANUAL', requestedDate: opts.requestedDate, now: opts.now });

  const context = await loadBuildContext(tx, tenantId);
  const copy: MoveDraft = { ...moveDraftFromRecord(rec), origin: 'MANUAL', sourceType: null, sourceId: null, sourceKey: null, sourceEvent: null };
  const rows = draftRowsFromMoveDraft(copy, context.ctx, { tenantId, journalId: rec.journalId, actor, draftOfMoveId: rec.id });
  const saved = await saveDraftMove(tx, {
    tenantId, actor, rows,
    auditAction: 'MOVE_RESET_DRAFT',
    auditSummary: `إعادة القيد ${rec.number ?? ''} إلى مسودة: ${reason}`,
    now: opts.now,
  });
  return { reversal: rev.reversal, draft: { id: saved.id } };
}

// ═══ حذف المسودة (JE‑05b) ═══

export type DeleteDraftRejectCode = 'LEDGER_MOVE_NOT_DRAFT' | 'LEDGER_SOURCE_OWNED_MOVE' | 'LEDGER_MOVE_DOCUMENT_OWNED' | 'NOT_FOUND';

export interface DeleteDraftOptions {
  tenantId: string;
  moveId: string;
  actor: GlActor;
  /**
   * الشرط 3 (§6.1): مستند يشير إلى المسودة (GlVendorBill، GlPayment، GlExpense، GlBankStatementLine … من M6+).
   * لا نماذج لها في M2 — TODO(M6): تُمرَّر هنا دالة تفحصها وتعيد نوع المستند أو null.
   */
  documentOwner?: (tx: GlTx, tenantId: string, moveId: string) => Promise<string | null>;
  now?: Date;
}

const DELETE_SNAPSHOT_SELECT = {
  id: true, tenantId: true, journalId: true, number: true, state: true, moveType: true, origin: true, date: true,
  ref: true, narration: true, totalMilli: true, sourceType: true, sourceId: true, salesRepId: true, draftOfMoveId: true,
  autoPostOn: true, postedAt: true, secureSeq: true,
  lines: {
    select: {
      seq: true, accountId: true, label: true, debitMilli: true, creditMilli: true, customerId: true, vendorId: true,
      salesRepId: true, partnerName: true, taxId: true, taxRole: true, taxBaseMilli: true, vatBox: true,
    },
    orderBy: { seq: 'asc' as const },
  },
  sources: { select: { sourceKey: true, sourceType: true, sourceId: true, event: true } },
  notes: { select: { authorName: true, body: true, createdAt: true } },
} as const;

type DeleteSnapshot = Prisma.GlMoveGetPayload<{ select: typeof DELETE_SNAPSHOT_SELECT }>;

/** فحص الشروط 1–3 على قيد مقروء (بعد القفل). يعيد رمز الرفض وتفاصيله أو null. */
async function deleteDraftRejection(
  tx: GlTx, opts: DeleteDraftOptions, rec: DeleteSnapshot | null,
): Promise<{ code: DeleteDraftRejectCode; details: Record<string, unknown> } | null> {
  if (!rec) return { code: 'NOT_FOUND', details: { moveId: opts.moveId } };
  if (rec.state !== 'DRAFT' || rec.number !== null || rec.postedAt !== null || rec.secureSeq !== null) {
    return { code: 'LEDGER_MOVE_NOT_DRAFT', details: { moveId: rec.id, state: rec.state, number: rec.number } };
  }
  const accountIds = [...new Set(rec.lines.map((l) => l.accountId))];
  const accounts = accountIds.length
    ? await tx.glAccount.findMany({ where: { tenantId: opts.tenantId, id: { in: accountIds } }, select: { id: true, controlKind: true } })
    : [];
  const kinds = new Map(accounts.map((a) => [a.id, a.controlKind]));
  const owned = rec.origin !== 'MANUAL'
    ? manualOwnership({ origin: 'AUTO', sourceType: rec.sourceType, sourceId: rec.sourceId, salesRepId: rec.salesRepId, moveSources: rec.sources, lineControlKinds: [] })
    : ownershipOfRecord(rec, (id) => kinds.get(id));
  // مسودة يدوية على حساب رئيسي لم تُرحَّل قط (I4 يمنع ترحيلها) — حذفها مسموح، فالملكية هنا بالمصدر وحده
  const blocking = owned && owned.reasons.some((r) => r !== 'CONTROL_ACCOUNT') ? owned : null;
  if (blocking) {
    return { code: 'LEDGER_SOURCE_OWNED_MOVE', details: { sourceType: blocking.sourceType, sourceId: blocking.sourceId, ownerAction: blocking.ownerAction } };
  }
  if (opts.documentOwner) {
    const doc = await opts.documentOwner(tx, opts.tenantId, rec.id);
    if (doc) return { code: 'LEDGER_MOVE_DOCUMENT_OWNED', details: { moveId: rec.id, documentType: doc } };
  }
  return null;
}

/**
 * يحذف مسودة يدوية داخل المعاملة tx بالترتيب الحرفي (§6.1):
 *   1. pg_advisory_xact_lock(hashtext('gl-post:'||tid))
 *   2. GlAuditLog MOVE_DELETE_DRAFT بلقطة: الرأس والسطور ونصوص الملاحظات وبيانات المرفقات الوصفية (fileName، sha256)
 *   3. tx.glAttachment.deleteMany({where:{tenantId, entityType:'MOVE', entityId:id}})
 *   4. tx.glMove.deleteMany({where:{id, tenantId, state:'DRAFT', number:null}}) — العدد ≠ 1 ⇒ LEDGER_MOVE_NOT_DRAFT
 * الأخطاء: GlNotFoundError، LEDGER_MOVE_NOT_DRAFT، LEDGER_SOURCE_OWNED_MOVE، LEDGER_MOVE_DOCUMENT_OWNED.
 */
export async function deleteDraftMove(tx: GlTx, opts: DeleteDraftOptions): Promise<{ id: string }> {
  const { tenantId, moveId, actor } = opts;
  await acquirePostLock(tx, tenantId);
  const rec = await tx.glMove.findFirst({ where: { id: moveId, tenantId }, select: DELETE_SNAPSHOT_SELECT });
  const rejection = await deleteDraftRejection(tx, opts, rec);
  if (rejection) {
    if (rejection.code === 'NOT_FOUND') throw new GlNotFoundError('GlMove', moveId);
    throw new LedgerError(rejection.code, rejection.details);
  }
  const move = rec as DeleteSnapshot;
  const attachments = await tx.glAttachment.findMany({
    where: { tenantId, entityType: 'MOVE', entityId: moveId },
    select: { id: true, fileName: true, sha256: true, mimeType: true, sizeBytes: true },
  });
  await appendAudit(tx, {
    tenantId, actor, action: 'MOVE_DELETE_DRAFT', entityType: 'MOVE', entityId: moveId,
    summary: `حذف مسودة قيد${move.narration ? `: ${move.narration}` : ''}`,
    before: {
      move: moveAuditHeader(move),
      lines: move.lines,
      notes: move.notes.map((n) => ({ authorName: n.authorName, body: n.body, createdAt: n.createdAt })),
      attachments,
    },
    at: opts.now,
  });
  await tx.glAttachment.deleteMany({ where: { tenantId, entityType: 'MOVE', entityId: moveId } });
  const deleted = await tx.glMove.deleteMany({ where: { id: moveId, tenantId, state: 'DRAFT', number: null } });
  if (deleted.count !== 1) throw new LedgerError('LEDGER_MOVE_NOT_DRAFT', { moveId, reason: 'RACE' });
  return { id: moveId };
}


export interface DeleteDraftsResult {
  deleted: string[];
  rejected: { id: string; code: DeleteDraftRejectCode; details: Record<string, unknown> }[];
}

/**
 * الحذف الجماعي (POST /moves/delete-drafts) — كل شيء أو لا شيء: يفحص كل المعرّفات تحت القفل أولاً؛
 * إن رُفض أيٌّ منها لا يُحذف شيء ويُعاد {deleted: [], rejected}. وإلا يحذف كلاً بترتيب deleteDraftMove.
 */
export async function deleteDraftMoves(
  tx: GlTx, opts: Omit<DeleteDraftOptions, 'moveId'> & { ids: readonly string[] },
): Promise<DeleteDraftsResult> {
  const ids = [...new Set(opts.ids)];
  await acquirePostLock(tx, opts.tenantId);
  const rejected: DeleteDraftsResult['rejected'] = [];
  for (const id of ids) {
    const rec = await tx.glMove.findFirst({ where: { id, tenantId: opts.tenantId }, select: DELETE_SNAPSHOT_SELECT });
    const r = await deleteDraftRejection(tx, { ...opts, moveId: id }, rec);
    if (r) rejected.push({ id, ...r });
  }
  if (rejected.length > 0) return { deleted: [], rejected };
  for (const id of ids) await deleteDraftMove(tx, { ...opts, moveId: id });
  return { deleted: ids, rejected: [] };
}
