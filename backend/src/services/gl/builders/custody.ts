// M1 — وصفتا استلام تحصيل المندوب وحذفه (DESIGN.md §5.5 P7 وP8، P27 الاسترداد، §5.3، §5.8، §10.3 D3).
// دوال صرفة: حمولة الحدث + مدخلات العهدة المحسوبة تحت القفل + BuildContext ⇒ MoveDraft أو NO_MOVE.
//
// P7 (دفتر CUST، moveType=CUSTODY_SETTLEMENT):
//    مدين حساب الطريقة = covered + recovered + suspense
//    دائن 111003 = covered (المندوب)
//    دائن 113003 = recovered (عجز العهدة المسترد، المندوب)
//    دائن 911001 = suspense (زيادة r على العتبة) مع needsAttention
//    r = amount − covered − recovered بلا مدين نقد أو بنك (يُحفظ على الحدث nonCustodyClearedMilli)
// P8 حذف استلام واحد: عكس سطور القيد الأصلي الحيّ (والحدث يستعيد r بحذف قيمه من التراكمي).
import { localDate } from '../dates';
import { toMilli } from '../money';
import { settlementSplit, type SettlementSplit } from '../custody';
import { methodAccountKey, methodLabel } from './receipt';
import {
  JOURNAL_CODE_BY_SYSTEM_KEY, noMove,
  type BuildContext, type BuildResult, type LineDraft, type LocalDate, type Milli, type MoveDraft,
} from '../types';

type Amount = string | number;

/** رمز حساب سُلف وذمم الموظفين (بلا مفتاح ربط في §4.5) */
export const EMPLOYEE_ADVANCES_CODE = '113003';

/** مفتاح حدث الاستلام (§5.2، §5.3): SETTLEMENT:<id>:POST | SETTLEMENT:<id>:REVERSE */
export const settlementKey = (settlementId: string, event: 'POST' | 'REVERSE'): string =>
  `SETTLEMENT:${settlementId}:${event}`;

/** حمولة SETTLEMENT (§5.2): {amount, method, salesRepId, settledAt, createdAt} */
export interface SettlementPayload {
  amount: Amount;
  method: string;
  salesRepId: string;
  settledAt: Date | string;
  createdAt?: Date | string | null;
  note?: string | null;
}

export interface SettlementPostInput {
  settlementId: string;
  payload: SettlementPayload;
  /** لقطة اسم المندوب (G6 (ز)) */
  salesRepName?: string | null;
  /** الافتراضي: localDate(settledAt, timezone) */
  date?: LocalDate;
  /** رصيد 111003 للمندوب تحت القفل */
  custodyBalanceMilli: Milli;
  /** العجز المفتوح على 113003 (من M4؛ صفر قبلها) */
  openShortageMilli?: Milli;
  /** Σ r السابقة منذ بدء الشركة (custodyComponents) */
  cumulativeNonCustodyClearedMilli: Milli;
  /** Σ suspense السابقة غير المحذوفة (custodyComponents.suspenseCleared) */
  priorSuspenseMilli?: Milli;
  /** مجموع العتبة (custodyComponents.nonCustodyAllowance) */
  nonCustodyAllowanceMilli: Milli;
}

export interface SettlementBuild {
  result: BuildResult;
  /** ما يحفظه المُرحِّل على الحدث: nonCustodyClearedMilli = split.nonCustodyClearedMilli، shortageRecoveredMilli = split.recoveredMilli */
  split: SettlementSplit;
}

/** سطر من القيد الأصلي الحيّ لـP7 */
export type SettlementOriginalLine = Pick<
  LineDraft,
  'accountId' | 'accountCode' | 'accountKey' | 'label' | 'debitMilli' | 'creditMilli' | 'salesRepId' | 'partnerName'
  | 'analyticAccountId'
>;

export interface SettlementReverseInput {
  settlementId: string;
  payload: SettlementPayload;
  salesRepName?: string | null;
  /** تاريخ العكس (المُرحِّل: autoReversalDate) */
  date: LocalDate;
  /** سطور قيد P7 الحيّ؛ null ⇒ لم يُرحَّل قيد (NETTED أو لم يتحقق) */
  originalLines: readonly SettlementOriginalLine[] | null;
  /** قيم الحدث الأصلي المخزّنة — تُعاد كما هي لإعلام المُرحِّل بما يُستعاد */
  nonCustodyClearedMilli?: Milli | null;
  shortageRecoveredMilli?: Milli | null;
}

export interface SettlementReverseBuild {
  result: BuildResult;
  /** ما يُطرح من التراكمي باستعادة الاستلام (P8 يستعيد r) */
  restoredNonCustodyClearedMilli: Milli;
  restoredShortageRecoveredMilli: Milli;
}

const repName = (n: string | null | undefined): string => (n && n.trim() ? n.trim() : 'مندوب');

function custJournalCode(ctx: BuildContext): string {
  return ctx.journals.bySystemKey('CUSTODY')?.code ?? JOURNAL_CODE_BY_SYSTEM_KEY.CUSTODY;
}

function baseMove(
  ctx: BuildContext, settlementId: string, event: 'POST' | 'REVERSE', date: LocalDate, salesRepId: string,
  narration: string,
): Omit<MoveDraft, 'lines' | 'needsAttention' | 'attentionReason'> {
  return {
    kind: 'MOVE',
    journalCode: custJournalCode(ctx),
    journalSystemKey: 'CUSTODY',
    moveType: 'CUSTODY_SETTLEMENT',
    origin: 'AUTO',
    date,
    ref: null,
    narration,
    salesRepId,
    sourceType: 'SETTLEMENT',
    sourceId: settlementId,
    sourceKey: settlementKey(settlementId, event),
    sourceEvent: event,
    currencyCode: ctx.settings.currency,
    currencyDecimals: ctx.settings.currencyDecimals,
  };
}

/** P7 — قيد استلام التحصيل من المندوب */
export function buildSettlementMove(input: SettlementPostInput, ctx: BuildContext): SettlementBuild {
  const { payload } = input;
  const amount = toMilli(payload.amount, ctx.settings.currencyDecimals);
  if (amount < 0n) throw new RangeError(`استلام بمبلغ سالب غير متوقع (${String(payload.amount)})`);
  const split = settlementSplit({
    amountMilli: amount,
    custodyBalanceMilli: input.custodyBalanceMilli,
    openShortageMilli: input.openShortageMilli ?? 0n,
    cumulativeNonCustodyClearedMilli: input.cumulativeNonCustodyClearedMilli,
    priorSuspenseMilli: input.priorSuspenseMilli ?? 0n,
    nonCustodyAllowanceMilli: input.nonCustodyAllowanceMilli,
  });
  if (amount === 0n) return { result: noMove('ZERO_VALUE', 'استلام بمبلغ صفري'), split };

  const debit = split.coveredMilli + split.recoveredMilli + split.suspenseMilli;
  if (debit === 0n) {
    // كل المبلغ r ضمن العتبة: لا مدين نقد أو بنك ولا قيد؛ الحدث يحفظ r وحده
    return { result: noMove('NETTED', 'الاستلام صفّى جزءاً غير مقيد في العهدة بالكامل (r ضمن العتبة)'), split };
  }

  // طريقة غير معروفة تُعامل نقداً كما في مسار الاستلام القائم (salesReps.ts)
  const method = methodAccountKey(payload.method) ? payload.method : 'CASH';
  const methodKey = methodAccountKey(method)!;
  const name = repName(input.salesRepName);
  const rep = { salesRepId: payload.salesRepId, partnerName: name };
  const date = input.date ?? localDate(payload.settledAt, ctx.settings.timezone);

  const lines: LineDraft[] = [
    {
      accountKey: methodKey, label: `استلام تحصيل ${methodLabel(method)} من المندوب ${name}`,
      debitMilli: debit, creditMilli: 0n, ...rep,
    },
  ];
  if (split.coveredMilli > 0n) {
    lines.push({
      accountKey: 'REP_CUSTODY', label: `تصفية عهدة المندوب ${name}`,
      debitMilli: 0n, creditMilli: split.coveredMilli, ...rep,
    });
  }
  if (split.recoveredMilli > 0n) {
    lines.push({
      accountCode: EMPLOYEE_ADVANCES_CODE, label: `استرداد عجز عهدة المندوب ${name}`,
      debitMilli: 0n, creditMilli: split.recoveredMilli, ...rep,
    });
  }
  let needsAttention = false;
  let attentionReason: string | null = null;
  if (split.suspenseMilli > 0n) {
    needsAttention = true;
    attentionReason = 'استلام يتجاوز عهدة المندوب وما يبرره (إلكتروني وخارج العهدة ونقد فواتير ومصروفات) — الزائد معلّق';
    lines.push({
      accountKey: 'POSTING_SUSPENSE', label: `زيادة استلام على عهدة المندوب ${name} — معلّق`,
      debitMilli: 0n, creditMilli: split.suspenseMilli, ...rep,
    });
  }

  const move: MoveDraft = {
    ...baseMove(ctx, input.settlementId, 'POST', date, payload.salesRepId,
      `استلام تحصيل (${methodLabel(method)}) من المندوب ${name}${payload.note ? ` — ${payload.note}` : ''}`),
    needsAttention,
    attentionReason,
    lines,
  };
  return { result: move, split };
}

/** P8 — عكس استلام واحد محذوف من سطور قيده الأصلي */
export function buildSettlementReversalMove(input: SettlementReverseInput, ctx: BuildContext): SettlementReverseBuild {
  const restored = {
    restoredNonCustodyClearedMilli: input.nonCustodyClearedMilli ?? 0n,
    restoredShortageRecoveredMilli: input.shortageRecoveredMilli ?? 0n,
  };
  const lines = input.originalLines ?? [];
  if (lines.length === 0) {
    return { result: noMove('NETTED', 'لا قيد أصلي لاستلام صُفّي كله بلا أثر في الأستاذ'), ...restored };
  }
  const name = repName(input.salesRepName);
  const move: MoveDraft = {
    ...baseMove(ctx, input.settlementId, 'REVERSE', input.date, input.payload.salesRepId,
      `حذف استلام تحصيل من المندوب ${name}`),
    needsAttention: false,
    attentionReason: null,
    lines: lines.map((l) => ({ ...l, label: `عكس: ${l.label}`, debitMilli: l.creditMilli, creditMilli: l.debitMilli })),
  };
  return { result: move, ...restored };
}
