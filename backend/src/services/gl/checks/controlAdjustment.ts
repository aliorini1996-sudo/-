/**
 * «قيد تصحيح حساب رئيسي» CONTROL_ADJUSTMENT (M3، DESIGN.md §5.9) — صرف بلا prisma.
 *
 * - يُنشأ **فقط** من تعمّق فحص أحمر C3 أو C4 أو C5 (C6 من M9) عبر `POST /api/ledger/checks/:key/control-adjustment`.
 * - سطران لا غير: الحساب الرئيسي المنحرف نفسه (مع customerId لـC3 أو salesRepId لـC4) مقابل 911001 POSTING_SUSPENSE.
 * - المبلغ = الانحراف المحسوب لحظتها تحت قفل gl-post، أو جزء منه، ولا يتجاوزه.
 * - moveType=CONTROL_ADJUSTMENT، origin=MANUAL، needsAttention=true، والسبب في narration. إعفاء I4 في validate.ts بنوع القيد.
 */
import type { BuildContext, LocalDate, MappingKey, Milli, MoveDraft } from '../types';
import type { ControlAdjustableCheck } from './types';

export const CONTROL_ADJUSTMENT_ATTENTION = 'قيد تصحيح حساب رئيسي — سوِّ حساب المعلّق 911001 إلى الحساب المقابل الصحيح';

/** مفتاح ربط الحساب الرئيسي لكل فحص */
export const CONTROL_ACCOUNT_KEY: Readonly<Record<ControlAdjustableCheck, MappingKey>> = {
  C3: 'AR_CONTROL',
  C4: 'REP_CUSTODY',
  C5: 'PAYLINK_CLEARING',
};

/** نوع الحساب الرئيسي لكل فحص (controlKind) */
export const CONTROL_KIND_OF_CHECK: Readonly<Record<ControlAdjustableCheck, string>> = {
  C3: 'AR',
  C4: 'CUSTODY',
  C5: 'PAYLINK',
};

export type ControlAdjustmentRejectReason =
  | 'REASON_REQUIRED'
  | 'PARTNER_REQUIRED'
  | 'NO_DEVIATION'
  | 'CHECK_NOT_RED'
  | 'AMOUNT_INVALID'
  | 'AMOUNT_EXCEEDS_DEVIATION'
  | 'ACCOUNT_NOT_MAPPED';

export class ControlAdjustmentError extends Error {
  constructor(readonly reason: ControlAdjustmentRejectReason, readonly status: 409 | 422, readonly details: Record<string, unknown> = {}) {
    super(reason);
    this.name = 'ControlAdjustmentError';
    Object.setPrototypeOf(this, ControlAdjustmentError.prototype);
  }
}

export interface ControlAdjustmentInput {
  key: ControlAdjustableCheck;
  /** الانحراف = رصيد الأستاذ − المتوقَّع (موقَّعاً، بطبيعة مدينة) */
  gapMilli: Milli;
  /** جزء من الانحراف (اختياري) — لا يتجاوز |gap| */
  amountMilli?: Milli | null;
  customerId?: string | null;
  salesRepId?: string | null;
  partnerName?: string | null;
  reason: string;
  date: LocalDate;
  /** يتجاوز حساب الربط (حين يختلف الحساب الرئيسي المنحرف عن المربوط) */
  controlAccountId?: string | null;
}

/** يعيد المبلغ الموجب المعتمد أو يرمي ControlAdjustmentError */
export function controlAdjustmentAmount(gapMilli: Milli, amountMilli?: Milli | null): Milli {
  const abs = gapMilli < 0n ? -gapMilli : gapMilli;
  if (abs === 0n) throw new ControlAdjustmentError('NO_DEVIATION', 409);
  if (amountMilli === null || amountMilli === undefined) return abs;
  if (amountMilli <= 0n) throw new ControlAdjustmentError('AMOUNT_INVALID', 422, { amountMilli: amountMilli.toString() });
  if (amountMilli > abs) {
    throw new ControlAdjustmentError('AMOUNT_EXCEEDS_DEVIATION', 422, { amountMilli: amountMilli.toString(), gapMilli: gapMilli.toString() });
  }
  return amountMilli;
}

export function buildControlAdjustmentDraft(input: ControlAdjustmentInput, ctx: BuildContext): MoveDraft {
  const reason = (input.reason ?? '').trim();
  if (!reason) throw new ControlAdjustmentError('REASON_REQUIRED', 422);
  if (input.key === 'C3' && !input.customerId) throw new ControlAdjustmentError('PARTNER_REQUIRED', 422, { field: 'customerId' });
  if (input.key === 'C4' && !input.salesRepId) throw new ControlAdjustmentError('PARTNER_REQUIRED', 422, { field: 'salesRepId' });
  const amount = controlAdjustmentAmount(input.gapMilli, input.amountMilli);

  const control = input.controlAccountId ? ctx.accounts.byId(input.controlAccountId) : ctx.accounts.byKey(CONTROL_ACCOUNT_KEY[input.key]);
  const suspense = ctx.accounts.byKey('POSTING_SUSPENSE');
  if (!control || !suspense) {
    throw new ControlAdjustmentError('ACCOUNT_NOT_MAPPED', 422, { control: control?.code ?? null, suspense: suspense?.code ?? null });
  }
  const partner = {
    customerId: input.key === 'C3' ? input.customerId ?? null : null,
    salesRepId: input.key === 'C4' ? input.salesRepId ?? null : null,
    partnerName: input.key === 'C5' ? null : (input.partnerName?.trim() || (input.key === 'C3' ? 'عميل' : 'مندوب')),
  };
  // الأستاذ أعلى من المتوقَّع ⇒ دائن الحساب الرئيسي؛ أدنى ⇒ مدين
  const ledgerAbove = input.gapMilli > 0n;
  const journal = ctx.journals.bySystemKey('MISC');
  return {
    kind: 'MOVE',
    journalCode: journal?.code ?? 'MISC',
    journalSystemKey: 'MISC',
    moveType: 'CONTROL_ADJUSTMENT',
    origin: 'MANUAL',
    date: input.date,
    ref: input.key,
    narration: `قيد تصحيح حساب رئيسي (${input.key}): ${reason}`,
    needsAttention: true,
    attentionReason: CONTROL_ADJUSTMENT_ATTENTION,
    customerId: partner.customerId,
    salesRepId: partner.salesRepId,
    currencyCode: ctx.settings.currency,
    currencyDecimals: ctx.settings.currencyDecimals,
    lines: [
      {
        accountId: control.id,
        label: `تصحيح ${control.name}`,
        debitMilli: ledgerAbove ? 0n : amount,
        creditMilli: ledgerAbove ? amount : 0n,
        ...partner,
      },
      {
        accountId: suspense.id,
        label: `تصحيح ${control.name} — معلّق`,
        debitMilli: ledgerAbove ? amount : 0n,
        creditMilli: ledgerAbove ? 0n : amount,
      },
    ],
  };
}
