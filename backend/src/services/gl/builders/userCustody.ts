// «ربط الدفاتر» L5 — وصفة توريد عهدة مستخدم الشركة USER_SETTLEMENT (العقد §5.5، القرار D6 وقرار المالك OD5، الفجوة C14).
// دالة صرفة: حمولة الحدث + تقسيم التوريد المحسوب تحت القفل (userDeliverySplitBefore) + BuildContext ⇒ MoveDraft أو NO_MOVE.
//
// دفتر CUST، moveType = CUSTODY_SETTLEMENT:
//    مدين حساب الطريقة (linkedMethodAccount: CASH 111001، BANK_TRANSFER 111101، POS 112004، CHEQUE 112003) = custody
//    دائن 111004 (adminUserId = المورِّد) = custody
// custody = الجزء النقدي من التوريد. الجزء «المارّ» من الوعاء غير النقدي (passThrough) بلا قيد: المال لم يمرّ بيد المستخدم
// أصلاً (P7 رحّله إلى البنك حين استلمه من المندوب — OD5)، والمُرحِّل يحفظه على الحدث nonCustodyClearedMilli.
// custody = 0 ⇒ NO_MOVE('NETTED'). العكس (حذف التوريد) يبنيه المُرحِّل بالتقسيم المخزَّن ثم invertDraft.
import { localDate } from '../dates';
import { toMilli } from '../money';
import { USER_CUSTODY_CODE } from '../coa/linkedAccounts';
import { linkedMethodAccount, methodLabel } from './receipt';
import {
  JOURNAL_CODE_BY_SYSTEM_KEY, noMove,
  type BuildContext, type BuildResult, type LineDraft, type LocalDate, type MoveDraft,
} from '../types';

/** مفتاح حدث التوريد: USER_SETTLEMENT:<id>:POST | USER_SETTLEMENT:<id>:REVERSE (keys.ts يعرّفه بالشكل نفسه) */
export const userSettlementKey = (id: string, event: 'POST' | 'REVERSE'): string => `USER_SETTLEMENT:${id}:${event}`;

/** حمولة USER_SETTLEMENT:<id>:POST|REVERSE — لقطة UserSettlement لحظة الاشتقاق (المبالغ نصوص بمنازل العملة) */
export interface UserSettlementPayload {
  userSettlementId: string;
  fromUserId: string;
  fromUserName?: string | null;
  amount: string;
  method: string;
  settledAt: string;
  createdAt: string;
  note?: string | null;
  receivedBy?: string | null;
}

export interface UserSettlementSplitInput {
  passThroughMilli: bigint;
  custodyMilli: bigint;
}

export interface UserSettlementBuild {
  result: BuildResult;
  /** ما يحفظه المُرحِّل على الحدث: nonCustodyClearedMilli = split.passThroughMilli */
  split: UserSettlementSplitInput;
}

const userName = (n: string | null | undefined): string => (n && n.trim() ? n.trim() : 'مستخدم');

function custJournalCode(ctx: BuildContext): string {
  return ctx.journals.bySystemKey('CUSTODY')?.code ?? JOURNAL_CODE_BY_SYSTEM_KEY.CUSTODY;
}

/**
 * توريد المستخدم: custody > 0 ⇒ Dr linkedMethodAccount({method}) / Cr 111004 (adminUserId = fromUserId)؛ custody = 0 ⇒ NO_MOVE('NETTED').
 * التقسيم يجب أن يساوي مبلغ الحمولة بالملّي تماماً — اختلافهما يعني مدخلات عهدة بمنازل غير منازل الحمولة: خطأ صريح لا تقريب صامت.
 */
export function buildUserSettlementMove(
  input: { userSettlementId: string; payload: UserSettlementPayload; date?: LocalDate; split: UserSettlementSplitInput },
  ctx: BuildContext,
): UserSettlementBuild {
  const { payload, split } = input;
  const amount = toMilli(payload.amount, ctx.settings.currencyDecimals);
  if (amount < 0n) throw new RangeError(`توريد عهدة بمبلغ سالب غير متوقع (${payload.amount})`);
  if (split.passThroughMilli < 0n || split.custodyMilli < 0n || split.passThroughMilli + split.custodyMilli !== amount) {
    throw new RangeError(
      `تقسيم توريد العهدة ${input.userSettlementId} لا يساوي مبلغه: مرور ${split.passThroughMilli} + عهدة ${split.custodyMilli} ≠ ${amount}`,
    );
  }
  if (amount === 0n) return { result: noMove('ZERO_VALUE', 'توريد عهدة بمبلغ صفري'), split };
  if (split.custodyMilli === 0n) {
    return { result: noMove('NETTED', 'توريد غير نقدي مرّ كله من المستلَم غير النقدي (لم يدخل عهدة المستخدم)'), split };
  }

  // طريقة مجهولة تُعامل نقداً كما في مسار الاستلام القائم (P7)
  const known = linkedMethodAccount({ method: payload.method }, ctx);
  const method = known ? payload.method : 'CASH';
  const target = known ?? linkedMethodAccount({ method: 'CASH' }, ctx);
  if (!target) throw new RangeError('تعذّر تحديد حساب الصندوق لتوريد العهدة');
  const name = userName(payload.fromUserName);
  const date = input.date ?? localDate(payload.settledAt, ctx.settings.timezone);
  const passNote = split.passThroughMilli > 0n ? ' (الجزء النقدي وحده)' : '';

  const lines: LineDraft[] = [
    {
      ...target, label: `توريد ${methodLabel(method)} من عهدة المستخدم ${name}${passNote}`,
      debitMilli: split.custodyMilli, creditMilli: 0n,
    },
    {
      accountCode: USER_CUSTODY_CODE, label: `تصفية عهدة المستخدم ${name}`,
      debitMilli: 0n, creditMilli: split.custodyMilli,
      adminUserId: payload.fromUserId, partnerName: name,
    },
  ];
  const move: MoveDraft = {
    kind: 'MOVE',
    journalCode: custJournalCode(ctx),
    journalSystemKey: 'CUSTODY',
    moveType: 'CUSTODY_SETTLEMENT',
    origin: 'AUTO',
    date,
    ref: null,
    narration: `توريد عهدة (${methodLabel(method)}) من المستخدم ${name}${payload.note ? ` — ${payload.note}` : ''}`,
    sourceType: 'USER_SETTLEMENT',
    sourceId: input.userSettlementId,
    sourceKey: userSettlementKey(input.userSettlementId, 'POST'),
    sourceEvent: 'POST',
    currencyCode: ctx.settings.currency,
    currencyDecimals: ctx.settings.currencyDecimals,
    needsAttention: false,
    attentionReason: null,
    lines,
  };
  return { result: move, split };
}
