/**
 * «إعادة الترحيل من المصدر» (M3، DESIGN.md §6.1) — فوق PostingTx (لا prisma)، فيُختبر بالمخزن المزيّف.
 *
 * `POST /api/ledger/moves/:id/repost-from-source` بصلاحية canConfigureLedger ولقيد origin=AUTO وحده. في معاملة واحدة
 * تحت قفل gl-post (المسار يأخذه أولاً):
 *   1. يُعكس القيد الحيّ (origin=AUTO منسوخ، التاريخ تاريخه مُزاحاً وفق ADR‑7) بمفتاح `<base>:REPOST_REV:<n>`.
 *   2. يُعاد تشغيل الـbuilder على لقطة الحدث (حمولة POST، وإلا المستند) بالربط الحالي، ويُرحَّل بمفتاح `<base>:REPOST:<n>`،
 *      حيث n = 1 + عدد مفاتيح REPOST القائمة للمصدر.
 *   3. تدقيق MOVE_REPOST (والإشعار في المسار).
 * يُرفض: قيد غير AUTO، أو بلا مصدر POST، أو مؤمَّن (LEDGER_SECURED_MOVE)، أو ليس «القيد الحيّ» للمصدر، أو حدث REVERSE للمصدر DONE.
 * الأثر الصافي على 113001 و111003 و112005 و911001 صفر: الـbuilder نفسه، وللاستلام (P7) يُعاد التقسيم المخزَّن نفسه
 * (covered/recovered/r من الحدث، والمعلّق من سطور القيد الحيّ).
 */
import type { GlActor } from '../audit';
import { custodyComponents } from '../custody';
import { buildInvoiceMove, type InvoicePayload } from '../builders/invoice';
import { buildReceiptMove } from '../builders/receipt';
import { buildSettlementMove } from '../builders/custody';
import { buildImportEntryMove } from '../builders/importEntry';
import { buildPaylinkFeeMove, buildPayoutMove, type PaylinkFeePayload, type PayoutPayload } from '../builders/paylink';
import type { LedgerContext } from '../resolve';
import { LedgerError, isNoMove, type BuildResult, type LocalDate, type MoveDraft, type SourceType } from '../types';
import { debitTotalMilli, missingAutoSalePercents, settlementRebuildInputs } from './poster';
import { nextRepostIndex, parseSourceKey, repostKey, repostRevKey, reverseKeyOf } from './keys';
import type { PostingTx } from './postingStore';
import type { ArEntryEventPayload, ReceiptPostEventPayload, SettlementEventPayload } from './types';

export const REPOST_REVERSAL_REASON = 'إعادة الترحيل من المصدر بعد تعديل الربط';

export type RepostRejectReason =
  | 'NOT_AUTO_ORIGIN'
  | 'NOT_POSTED'
  | 'NO_SOURCE'
  | 'NOT_POST_SOURCE'
  | 'NOT_LIVE_MOVE'
  | 'SOURCE_REVERSED'
  | 'SOURCE_NOT_FOUND'
  | 'NO_RECIPE'
  | 'NO_MOVE';

/** رفض «إعادة الترحيل» بلا رمز في ملحق ب — المسار يحوّله 409 بـreason */
export class RepostRejectedError extends Error {
  constructor(readonly reason: RepostRejectReason, readonly details: Record<string, unknown> = {}) {
    super(reason);
    this.name = 'RepostRejectedError';
    Object.setPrototypeOf(this, RepostRejectedError.prototype);
  }
}

/** ما يلزم من القيد المقروء تحت القفل */
export interface RepostMoveFacts {
  id: string;
  number: string | null;
  state: string;
  origin: string;
  date: LocalDate;
  originalDate: LocalDate | null;
  lateArrival: boolean;
  secureHash: string | null;
  sources: readonly { sourceKey: string; sourceType: string; sourceId: string; event: string }[];
}

export interface RepostOptions {
  move: RepostMoveFacts;
  actor: GlActor;
  timezone: string;
  now?: Date;
}

export interface RepostResult {
  baseKey: string;
  n: number;
  sourceType: SourceType;
  sourceId: string;
  original: { id: string; number: string | null };
  reversal: { id: string; number: string | null; date: LocalDate | null; sourceKey: string };
  repost: { id: string; number: string; date: LocalDate; sourceKey: string };
}

const REPOSTABLE: readonly SourceType[] = ['INVOICE', 'RECEIPT', 'SETTLEMENT', 'AR_ENTRY', 'PAYLINK_FEE', 'PAYOUT'];

/** الفحوص الصرفة قبل أي قراءة: الأصل والحالة والتأمين ومفتاح POST — يعيد مفتاح المصدر المحلَّل */
export function repostPrecheck(move: RepostMoveFacts): { baseKey: string; sourceType: SourceType; sourceId: string } {
  if (move.origin !== 'AUTO') throw new RepostRejectedError('NOT_AUTO_ORIGIN', { origin: move.origin });
  if (move.secureHash) throw new LedgerError('LEDGER_SECURED_MOVE', { moveId: move.id });
  if (move.state !== 'POSTED' || !move.number) throw new RepostRejectedError('NOT_POSTED', { state: move.state });
  if (move.sources.length === 0) throw new RepostRejectedError('NO_SOURCE');
  const parsed = move.sources.map((s) => parseSourceKey(s.sourceKey)).find((p) => p && p.event === 'POST');
  if (!parsed) throw new RepostRejectedError('NOT_POST_SOURCE', { sourceKeys: move.sources.map((s) => s.sourceKey) });
  if (parsed.sourceType === 'CUSTODY_SHORTAGE' || !REPOSTABLE.includes(parsed.sourceType)) {
    throw new RepostRejectedError('NO_RECIPE', { sourceType: parsed.sourceType });
  }
  return { baseKey: parsed.baseKey, sourceType: parsed.sourceType, sourceId: parsed.sourceId };
}

async function snapshotPayload<T>(tx: PostingTx, baseKey: string, sourceType: SourceType, sourceId: string): Promise<T> {
  const ev = await tx.getEvent(baseKey);
  if (ev?.payload && typeof ev.payload === 'object') return ev.payload as unknown as T;
  const data = await tx.loadSourceData(sourceType, sourceId, 'POST');
  if (data.kind === 'MISSING' || !data.payload) throw new RepostRejectedError('SOURCE_NOT_FOUND', { sourceKey: baseKey });
  return data.payload as T;
}

async function rebuild(tx: PostingTx, sourceType: SourceType, sourceId: string, baseKey: string, date: LocalDate, context: LedgerContext, liveMoveId: string): Promise<{ result: BuildResult; context: LedgerContext }> {
  switch (sourceType) {
    case 'INVOICE': {
      const payload = await snapshotPayload<InvoicePayload>(tx, baseKey, sourceType, sourceId);
      let result = buildInvoiceMove(payload, context.ctx);
      const missing = missingAutoSalePercents(result, context);
      if (missing.length > 0) {
        const ensured = await tx.ensureAutoSaleTaxes(missing);
        if (ensured.context) {
          context = ensured.context;
          result = buildInvoiceMove(payload, context.ctx);
        }
      }
      return { result, context };
    }
    case 'RECEIPT': {
      const p = await snapshotPayload<ReceiptPostEventPayload>(tx, baseKey, sourceType, sourceId);
      const result = buildReceiptMove({
        receiptId: sourceId, number: p.number ?? null, date,
        payload: { salesRepId: p.salesRepId ?? null, paymentMethod: p.paymentMethod, amount: p.amount, customerId: p.customerId, paylinkId: p.paylinkId ?? null },
        customerName: p.customerName ?? null, salesRepName: p.salesRepName ?? null,
      }, context.ctx);
      return { result, context };
    }
    case 'SETTLEMENT': {
      const p = await snapshotPayload<SettlementEventPayload>(tx, baseKey, sourceType, sourceId);
      // التقسيم المرحَّل نفسه (القيم المخزّنة على الحدث تُقرأ في custodyComponents) — لا إعادة اشتقاق بترتيب جديد
      const inputs = await tx.loadCustodyInputs(p.salesRepId);
      const all = custodyComponents({ ...inputs, settlements: inputs.settlements.map((s) => (s.id === sourceId ? { ...s, reversedAt: null } : s)) });
      const outcome = all[p.salesRepId]?.settlements.find((s) => s.id === sourceId);
      if (!outcome) throw new RepostRejectedError('SOURCE_NOT_FOUND', { sourceKey: baseKey, reason: 'CUSTODY_OUTCOME' });
      // المعلّق (911001) من القيد الحيّ نفسه لا من إعادة اشتقاق العتبة: فاتورة نقدية أُدخلت لاحقاً بتاريخ سابق تغيّر
      // العتبة المعاد حسابها، فتتغير مبالغ النقد و911001 بإعادة ترحيل غرضها تبديل الحسابات وحده (أو NO_MOVE)
      const build = buildSettlementMove({
        settlementId: sourceId, payload: p, salesRepName: p.salesRepName ?? null, date,
        ...settlementRebuildInputs(outcome, debitTotalMilli(await tx.loadMoveLines(liveMoveId))),
      }, context.ctx);
      return { result: build.result, context };
    }
    case 'AR_ENTRY': {
      const p = await snapshotPayload<ArEntryEventPayload>(tx, baseKey, sourceType, sourceId);
      const result = buildImportEntryMove({
        entryId: p.entryId ?? sourceId, customerId: p.customerId, customerName: p.customerName ?? null,
        debit: p.debit, credit: p.credit, description: p.description ?? null, entryDate: p.entryDate, createdAt: p.createdAt ?? null,
      }, context.ctx);
      return { result, context };
    }
    case 'PAYLINK_FEE': {
      const p = await snapshotPayload<PaylinkFeePayload>(tx, baseKey, sourceType, sourceId);
      return { result: buildPaylinkFeeMove({ ...p, entryId: p.entryId ?? sourceId }, context.ctx), context };
    }
    case 'PAYOUT': {
      const p = await snapshotPayload<PayoutPayload>(tx, baseKey, sourceType, sourceId);
      return { result: buildPayoutMove({ ...p, payoutId: p.payoutId ?? sourceId }, context.ctx), context };
    }
    default:
      throw new RepostRejectedError('NO_RECIPE', { sourceType });
  }
}

/**
 * يعكس القيد الحيّ ويعيد ترحيله من لقطة المصدر داخل معاملة tx (القفل مأخوذ). يرمي RepostRejectedError أو LedgerError.
 * البناء يسبق العكس، فلا يُعكس قيد يتعذّر إعادة بنائه.
 */
export async function repostFromSource(tx: PostingTx, opts: RepostOptions): Promise<RepostResult> {
  const { move, actor } = opts;
  const { baseKey, sourceType, sourceId } = repostPrecheck(move);

  const revKey = reverseKeyOf(sourceType, sourceId);
  if (revKey) {
    const rev = await tx.getEvent(revKey);
    if (rev?.status === 'DONE') throw new RepostRejectedError('SOURCE_REVERSED', { sourceKey: revKey });
  }
  const live = await tx.findLiveMove(baseKey);
  if (live.liveMoveId !== move.id) {
    throw new RepostRejectedError('NOT_LIVE_MOVE', { liveMoveId: live.liveMoveId, existingReversalMoveId: live.existingReversalMoveId });
  }
  const n = nextRepostIndex(await tx.listSourceKeysUnder(baseKey), baseKey);

  const built = await rebuild(tx, sourceType, sourceId, baseKey, move.date, await tx.loadContext(), move.id);
  if (isNoMove(built.result)) throw new RepostRejectedError('NO_MOVE', { skipReason: built.result.reason });

  const reversal = await tx.reverseMove({
    moveId: move.id,
    actor,
    reason: REPOST_REVERSAL_REASON,
    mode: 'SYSTEM',
    requestedDate: move.date,
    sourceKey: repostRevKey(baseKey, n),
    sourceEvent: 'REVERSE',
    auditAction: 'MOVE_REPOST',
    now: opts.now,
  });
  if (reversal.alreadyReversed) throw new RepostRejectedError('NOT_LIVE_MOVE', { existingReversalMoveId: reversal.reversal.id });

  const draft: MoveDraft = {
    ...built.result,
    // تاريخ القيد الحيّ كما رُحّل (ومعه وسم الوصول المتأخر)؛ postMove يطبّق الإقفال الحالي (ADR‑7)
    date: move.date,
    lateArrival: move.lateArrival || built.result.lateArrival === true,
    originalDate: move.lateArrival ? (move.originalDate ?? built.result.originalDate ?? null) : (built.result.originalDate ?? null),
    sourceKey: repostKey(baseKey, n),
    sourceEvent: 'POST',
  };
  const posted = await tx.postMove(draft, {
    actor,
    context: built.context,
    validationMode: 'SYSTEM',
    lockPolicy: 'SHIFT',
    auditAction: 'MOVE_REPOST',
    auditSummary: `إعادة ترحيل القيد ${move.number ?? move.id} من المصدر ${baseKey} (${n})`,
    auditExtra: { baseKey, n, originalMoveId: move.id, reversalMoveId: reversal.reversal.id },
    now: opts.now,
  });
  return {
    baseKey, n, sourceType, sourceId,
    original: { id: move.id, number: move.number },
    reversal: { id: reversal.reversal.id, number: reversal.reversal.number, date: reversal.reversal.date, sourceKey: repostRevKey(baseKey, n) },
    repost: { id: posted.id, number: posted.number, date: posted.date, sourceKey: repostKey(baseKey, n) },
  };
}
