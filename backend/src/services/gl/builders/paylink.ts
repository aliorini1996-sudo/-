// M1 — وصفتا الدفع الإلكتروني (DESIGN.md §5.5 P9 وP10، §2.2، §10.3 D2).
// دوال صرفة: حمولة الحدث + BuildContext ⇒ MoveDraft أو NO_MOVE. لا prisma ولا I/O.
//
// P9  عمولة الدفع الإلكتروني (دفتر PLNK، moveType=PAYLINK_FEE):
//     غير مستردة (الافتراض):  مدين 611007 = feeGross      / دائن 112005 = feeGross
//     مستردة (D2):            مدين 611007 = feeNet
//                             مدين 116001 = feeVat (S15_PURCH، TAX، وعاء feeNet، SA_7) / دائن 112005 = feeGross
// P10 توريد الأمانات (دفتر PLNK، moveType=PAYLINK_PAYOUT):
//     مدين PAYLINK_PAYOUT_ACCOUNT (112001) = المبلغ / دائن 112005 = المبلغ
import { compareLocalDate, isLocalDate, localDate } from '../dates';
import { toMilli } from '../money';
import {
  JOURNAL_CODE_BY_SYSTEM_KEY, noMove,
  type BuildContext, type BuildResult, type GlSettingsSnapshot, type LineDraft,
  type Milli, type MoveDraft, type TaxRef,
} from '../types';

/** مفتاح ضريبة المشتريات التي تُسترد بها ضريبة العمولة (§5.5 P9) */
export const PAYLINK_FEE_TAX_KEY = 'S15_PURCH';

/** مفتاح حدث العمولة (§5.2): PAYLINK_FEE:<entryId> */
export const paylinkFeeKey = (entryId: string): string => `PAYLINK_FEE:${entryId}`;
/** مفتاح حدث التوريد (§5.2): PAYOUT:<payoutId> */
export const payoutKey = (payoutId: string): string => `PAYOUT:${payoutId}`;

type Amount = string | number;

/** حمولة حدث PAYLINK_FEE — من SettlementEntry kind=FEE كما خُزّن (المبالغ نصوص §5.2) */
export interface PaylinkFeePayload {
  entryId: string;
  /** SettlementEntry.amount الموقَّع: −feeGross */
  amount: Amount;
  /** المخزّنة على صف FEE دون إعادة حساب؛ قد تغيب في صفوف قديمة */
  feeNet?: Amount | null;
  feeVat?: Amount | null;
  /** SettlementEntry.createdAt — يحدد التاريخ المحلي وقرار D2 */
  createdAt: Date | string;
  linkId?: string | null;
  note?: string | null;
}

/** حمولة حدث PAYOUT — من SettlementEntry kind=PAYOUT وسجل Payout */
export interface PayoutPayload {
  payoutId: string;
  /** SettlementEntry.amount الموقَّع: −المبلغ المورَّد */
  amount: Amount;
  createdAt: Date | string;
  bankReference?: string | null;
  note?: string | null;
}

function plnkJournalCode(ctx: BuildContext): string {
  return ctx.journals.bySystemKey('PAYLINK')?.code ?? JOURNAL_CODE_BY_SYSTEM_KEY.PAYLINK;
}

function milliOf(v: Amount | null | undefined, decimals: number): Milli | null {
  if (v === null || v === undefined || v === '') return null;
  return toMilli(v, decimals);
}

/**
 * قاعدة D2: recoverable = paylinkFeeTaxInvoiceFrom ≠ null && localDate(fee.createdAt, tz) ≥ from.
 * تُحسب بتاريخ العمولة الأصلي (createdAt) لا بتاريخ القيد بعد أي إزاحة ADR‑7.
 */
export function isPaylinkFeeVatRecoverable(
  feeCreatedAt: Date | string,
  settings: Pick<GlSettingsSnapshot, 'paylinkFeeTaxInvoiceFrom' | 'timezone'>,
): boolean {
  const from = settings.paylinkFeeTaxInvoiceFrom;
  if (from === null || from === undefined) return false;
  if (!isLocalDate(from)) throw new RangeError(`paylinkFeeTaxInvoiceFrom غير صالح: ${String(from)}`);
  return compareLocalDate(localDate(feeCreatedAt, settings.timezone), from) >= 0;
}

/** ضريبة الاسترداد إن كانت صالحة للاستعمال (نشطة، مشتريات، لها حساب أو ربط INPUT_VAT) */
function recoveryTax(ctx: BuildContext): TaxRef | null {
  const tax = ctx.taxes.byKey(PAYLINK_FEE_TAX_KEY);
  if (!tax || !tax.isActive || tax.use !== 'PURCHASE') return null;
  if (!tax.accountId && !ctx.accounts.byKey('INPUT_VAT')) return null;
  return tax;
}

/** P9 — قيد عمولة الدفع الإلكتروني */
export function buildPaylinkFeeMove(payload: PaylinkFeePayload, ctx: BuildContext): BuildResult {
  const { settings } = ctx;
  const dec = settings.currencyDecimals;
  const signed = toMilli(payload.amount, dec);
  const feeGross = -signed;
  if (feeGross === 0n) return noMove('ZERO_VALUE', 'عمولة صفرية');
  if (feeGross < 0n) {
    throw new RangeError(`صف FEE بمبلغ موجب غير متوقع (${String(payload.amount)}) — المتوقع −feeGross`);
  }

  const date = localDate(payload.createdAt, settings.timezone);
  const feeNet = milliOf(payload.feeNet, dec);
  const feeVat = milliOf(payload.feeVat, dec);
  const noteSuffix = payload.note ? ` — ${payload.note}` : '';

  let needsAttention = false;
  let attentionReason: string | null = null;
  let lines: LineDraft[];

  const recoverable = isPaylinkFeeVatRecoverable(payload.createdAt, settings);
  const splitValid = feeNet !== null && feeVat !== null && feeNet >= 0n && feeVat >= 0n && feeNet + feeVat === feeGross;
  const tax = recoverable ? recoveryTax(ctx) : null;

  if (recoverable && splitValid && tax && feeVat! > 0n) {
    lines = [
      {
        accountKey: 'PAYLINK_FEE_EXPENSE',
        label: 'عمولة الدفع الإلكتروني قبل الضريبة',
        debitMilli: feeNet!, creditMilli: 0n,
      },
      {
        ...(tax.accountId ? { accountId: tax.accountId } : { accountKey: 'INPUT_VAT' as const }),
        label: 'ضريبة القيمة المضافة على عمولة الدفع الإلكتروني',
        debitMilli: feeVat!, creditMilli: 0n,
        taxId: tax.id, taxCode: tax.key ?? PAYLINK_FEE_TAX_KEY, taxRole: 'TAX',
        taxBaseMilli: feeNet!, vatBox: tax.vatBox,
      },
      {
        accountKey: 'PAYLINK_CLEARING',
        label: 'اقتطاع عمولة الدفع الإلكتروني من الأمانات',
        debitMilli: 0n, creditMilli: feeGross,
      },
    ];
  } else {
    if (recoverable) {
      // مستردة بالتاريخ لكن لا يمكن استردادها بأمان: تُرحَّل كاملةً مصروفاً ويُنبَّه المحاسب
      if (!splitValid) {
        needsAttention = true;
        attentionReason = 'عمولة إلكترونية بلا تفصيل ضريبة مخزّن صالح (feeNet + feeVat ≠ feeGross) — رُحّلت كاملةً مصروفاً';
      } else if (!tax) {
        needsAttention = true;
        attentionReason = `ضريبة المشتريات ${PAYLINK_FEE_TAX_KEY} غير متاحة — رُحّلت العمولة كاملةً مصروفاً`;
      }
      // feeVat = 0 مع تفصيل صالح: لا ضريبة تُسترد، فلا تنبيه
    }
    lines = [
      {
        accountKey: 'PAYLINK_FEE_EXPENSE',
        label: 'عمولة الدفع الإلكتروني شاملة الضريبة',
        debitMilli: feeGross, creditMilli: 0n,
      },
      {
        accountKey: 'PAYLINK_CLEARING',
        label: 'اقتطاع عمولة الدفع الإلكتروني من الأمانات',
        debitMilli: 0n, creditMilli: feeGross,
      },
    ];
  }

  const draft: MoveDraft = {
    kind: 'MOVE',
    journalCode: plnkJournalCode(ctx),
    journalSystemKey: 'PAYLINK',
    moveType: 'PAYLINK_FEE',
    origin: 'AUTO',
    date,
    ref: payload.linkId ?? null,
    narration: `عمولة الدفع الإلكتروني${noteSuffix}`,
    needsAttention,
    attentionReason,
    sourceType: 'PAYLINK_FEE',
    sourceId: payload.entryId,
    sourceKey: paylinkFeeKey(payload.entryId),
    sourceEvent: 'POST',
    currencyCode: settings.currency,
    currencyDecimals: dec,
    lines,
  };
  return draft;
}

/** P10 — قيد توريد الأمانات */
export function buildPayoutMove(payload: PayoutPayload, ctx: BuildContext): BuildResult {
  const { settings } = ctx;
  const dec = settings.currencyDecimals;
  const amount = -toMilli(payload.amount, dec);
  if (amount === 0n) return noMove('ZERO_VALUE', 'توريد صفري');
  if (amount < 0n) {
    throw new RangeError(`صف PAYOUT بمبلغ موجب غير متوقع (${String(payload.amount)}) — المتوقع −المبلغ المورَّد`);
  }
  const refSuffix = payload.bankReference ? ` — مرجع التحويل ${payload.bankReference}` : '';
  const draft: MoveDraft = {
    kind: 'MOVE',
    journalCode: plnkJournalCode(ctx),
    journalSystemKey: 'PAYLINK',
    moveType: 'PAYLINK_PAYOUT',
    origin: 'AUTO',
    date: localDate(payload.createdAt, settings.timezone),
    ref: payload.bankReference ?? null,
    narration: `توريد أمانات الدفع الإلكتروني${refSuffix}`,
    needsAttention: false,
    attentionReason: null,
    sourceType: 'PAYOUT',
    sourceId: payload.payoutId,
    sourceKey: payoutKey(payload.payoutId),
    sourceEvent: 'POST',
    currencyCode: settings.currency,
    currencyDecimals: dec,
    lines: [
      {
        accountKey: 'PAYLINK_PAYOUT_ACCOUNT',
        label: 'توريد أمانات الدفع الإلكتروني للحساب البنكي',
        debitMilli: amount, creditMilli: 0n,
      },
      {
        accountKey: 'PAYLINK_CLEARING',
        label: 'تصفية أمانات الدفع الإلكتروني بالتوريد',
        debitMilli: 0n, creditMilli: amount,
      },
    ],
  };
  return draft;
}
