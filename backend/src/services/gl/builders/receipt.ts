// M1 — وصفتا سند القبض (DESIGN.md §5.5 P5 وP6، §5.2 الحمولة، §5.8، §10.3 D3/D10).
// دوال صرفة: حمولة الحدث + BuildContext ⇒ MoveDraft أو NO_MOVE. بلا قاعدة بيانات ولا I/O.
//
// P5 سند قبض (دفتر RCPT، moveType=CUST_RECEIPT): مدين حسب الطريقة / دائن 113001 = amount (العميل)
//    ONLINE + paylinkId ⇒ 112005؛ ONLINE بلا رابط ⇒ 911001 مع needsAttention
//    مندوب + receiptRouting[method]=CUSTODY ⇒ 111003 (المندوب)
//    وإلا: نقد 111001، تحويل 112001، نقطة بيع 112004، شيك 112003
// P6 إلغاء سند أو استرداد رابط: مدين 113001 / دائن عكس P5.
//    ONLINE: refundEntryId ⇒ دائن 112005 = |refund.amount| (والفرق دفاعياً إلى 911001)،
//            بلا REFUND ⇒ دائن 911001 مع needsAttention (المبلغ ما زال في الأمانات).
import { absMilli, toMilli } from '../money';
import { receiptCustodyClass } from '../custody';
import {
  JOURNAL_CODE_BY_SYSTEM_KEY, noMove,
  type BuildContext, type BuildResult, type LineDraft, type LocalDate, type MappingKey, type Milli, type MoveDraft,
} from '../types';

type Amount = string | number;

/** مفتاح حدث السند (§5.2): RECEIPT:<id>:POST | RECEIPT:<id>:REVERSE */
export const receiptKey = (receiptId: string, event: 'POST' | 'REVERSE'): string => `RECEIPT:${receiptId}:${event}`;

/** حمولة RECEIPT:<id>:POST الثابتة (§5.2) — المبالغ نصوص */
export interface ReceiptPostPayload {
  salesRepId: string | null;
  paymentMethod: string;
  amount: Amount;
  customerId: string;
  /** لسندات ONLINE: CustomerPaymentLink.receiptId = receipt.id (لا clientRef) */
  paylinkId?: string | null;
}

/** حمولة RECEIPT:<id>:REVERSE لسند ONLINE (§5.2) */
export interface ReceiptReversePayload {
  paylinkId?: string | null;
  refundEntryId?: string | null;
  /** SettlementEntry.amount لصف REFUND (موقَّع سالباً عادةً) — تُؤخذ قيمته المطلقة */
  refundedAmount?: Amount | null;
}

/** سطر من القيد الأصلي الحيّ يُعكس كما هو */
export type ReversibleLine = Pick<
  LineDraft,
  'accountId' | 'accountCode' | 'accountKey' | 'label' | 'debitMilli' | 'creditMilli' | 'customerId' | 'vendorId'
  | 'salesRepId' | 'partnerName' | 'analyticAccountId'
>;

export interface ReceiptNames {
  /** لقطة اسم العميل (G6 (ز)) */
  customerName?: string | null;
  /** لقطة اسم المندوب */
  salesRepName?: string | null;
}

export interface ReceiptPostInput extends ReceiptNames {
  receiptId: string;
  /** رقم السند للمرجع */
  number?: string | null;
  /** التاريخ المحلي لـentryDate صف RECEIPT_CREDIT */
  date: LocalDate;
  payload: ReceiptPostPayload;
}

export interface ReceiptReverseInput extends ReceiptNames {
  receiptId: string;
  number?: string | null;
  /** التاريخ المحلي لصف RECEIPT_DEBIT (الإزاحة لاحقاً في locks.ts) */
  date: LocalDate;
  /** حمولة POST الأصلية */
  original: ReceiptPostPayload;
  /** حمولة REVERSE (لسندات ONLINE) */
  reverse?: ReceiptReversePayload | null;
  /** سطور القيد الأصلي الحيّ غير سطر الذمة — إن وُجدت تُعكس حرفياً لغير ONLINE */
  originalLines?: readonly ReversibleLine[] | null;
}

const METHOD_KEYS: Record<string, MappingKey> = {
  CASH: 'MAIN_CASH',
  BANK_TRANSFER: 'OUTSTANDING_RECEIPTS',
  POS: 'POS_CLEARING',
  CHEQUE: 'CHEQUES_UNDER_COLLECTION',
};

const METHOD_LABELS: Record<string, string> = {
  CASH: 'نقداً',
  BANK_TRANSFER: 'تحويل بنكي',
  POS: 'نقطة بيع',
  CHEQUE: 'شيك',
  ONLINE: 'دفع إلكتروني',
};

export const NO_LINK_ATTENTION = 'سند إلكتروني بلا رابط دفع';
export const MANUAL_ONLINE_CANCEL_ATTENTION = 'إلغاء يدوي لسند إلكتروني دون استرداد — المبلغ ما زال في الأمانات';

/** حساب طريقة الدفع المباشر (P5 وP7): null لطريقة غير معروفة */
export function methodAccountKey(method: string): MappingKey | null {
  return METHOD_KEYS[method] ?? null;
}

export const methodLabel = (method: string): string => METHOD_LABELS[method] ?? method;

const nameOr = (name: string | null | undefined, fallback: string): string =>
  name && name.trim() ? name.trim() : fallback;

function rcptJournalCode(ctx: BuildContext): string {
  return ctx.journals.bySystemKey('RECEIPTS')?.code ?? JOURNAL_CODE_BY_SYSTEM_KEY.RECEIPTS;
}

export interface ReceiptDebitTarget {
  line: Pick<LineDraft, 'accountKey' | 'salesRepId' | 'partnerName' | 'label'>;
  needsAttention: boolean;
  attentionReason: string | null;
}

/** الطرف المدين لسند P5 حسب الطريقة والتوجيه والرابط */
export function receiptDebitTarget(
  payload: ReceiptPostPayload, ctx: BuildContext, names: ReceiptNames = {},
): ReceiptDebitTarget {
  const method = payload.paymentMethod;
  if (method === 'ONLINE') {
    if (payload.paylinkId) {
      return {
        line: { accountKey: 'PAYLINK_CLEARING', label: 'تحصيل إلكتروني في أمانات الدفع الإلكتروني' },
        needsAttention: false, attentionReason: null,
      };
    }
    return {
      line: { accountKey: 'POSTING_SUSPENSE', label: 'سند إلكتروني بلا رابط دفع — معلّق' },
      needsAttention: true, attentionReason: NO_LINK_ATTENTION,
    };
  }
  const cls = receiptCustodyClass({
    paymentMethod: method, salesRepId: payload.salesRepId, routing: ctx.settings.receiptRouting,
  });
  if (cls === 'CUSTODY') {
    return {
      line: {
        accountKey: 'REP_CUSTODY', label: `تحصيل ${methodLabel(method)} في عهدة المندوب`,
        salesRepId: payload.salesRepId, partnerName: nameOr(names.salesRepName, 'مندوب'),
      },
      needsAttention: false, attentionReason: null,
    };
  }
  const key = methodAccountKey(method);
  if (!key) {
    return {
      line: { accountKey: 'POSTING_SUSPENSE', label: `سند بطريقة دفع غير معروفة (${method}) — معلّق` },
      needsAttention: true, attentionReason: `طريقة دفع غير معروفة في السند: ${method}`,
    };
  }
  return {
    line: { accountKey: key, label: `تحصيل ${methodLabel(method)} من عميل` },
    needsAttention: false, attentionReason: null,
  };
}

function receiptAmount(amount: Amount, decimals: number): Milli {
  const m = toMilli(amount, decimals);
  if (m < 0n) throw new RangeError(`سند بمبلغ سالب غير متوقع (${String(amount)})`);
  return m;
}

function baseMove(
  ctx: BuildContext, receiptId: string, event: 'POST' | 'REVERSE', date: LocalDate, number: string | null | undefined,
  payload: ReceiptPostPayload, narration: string,
): Omit<MoveDraft, 'lines' | 'needsAttention' | 'attentionReason'> {
  return {
    kind: 'MOVE',
    journalCode: rcptJournalCode(ctx),
    journalSystemKey: 'RECEIPTS',
    moveType: 'CUST_RECEIPT',
    origin: 'AUTO',
    date,
    ref: number ?? null,
    narration,
    customerId: payload.customerId,
    salesRepId: payload.salesRepId ?? null,
    sourceType: 'RECEIPT',
    sourceId: receiptId,
    sourceKey: receiptKey(receiptId, event),
    sourceEvent: event,
    currencyCode: ctx.settings.currency,
    currencyDecimals: ctx.settings.currencyDecimals,
  };
}

/** P5 — قيد سند القبض */
export function buildReceiptMove(input: ReceiptPostInput, ctx: BuildContext): BuildResult {
  const { payload } = input;
  const amount = receiptAmount(payload.amount, ctx.settings.currencyDecimals);
  if (amount === 0n) return noMove('ZERO_VALUE', 'سند بمبلغ صفري');
  const customerName = nameOr(input.customerName, 'عميل');
  const target = receiptDebitTarget(payload, ctx, input);
  const numberPart = input.number ? ` رقم ${input.number}` : '';

  const lines: LineDraft[] = [
    { ...target.line, label: target.line.label!, debitMilli: amount, creditMilli: 0n },
    {
      accountKey: 'AR_CONTROL', label: `تحصيل من العميل ${customerName}`,
      debitMilli: 0n, creditMilli: amount,
      customerId: payload.customerId, partnerName: customerName,
    },
  ];
  return {
    ...baseMove(ctx, input.receiptId, 'POST', input.date, input.number, payload,
      `سند قبض${numberPart} (${methodLabel(payload.paymentMethod)}) من ${customerName}`),
    needsAttention: target.needsAttention,
    attentionReason: target.attentionReason,
    lines,
  };
}

/** P6 — قيد إلغاء السند أو استرداد رابط الدفع */
export function buildReceiptReversalMove(input: ReceiptReverseInput, ctx: BuildContext): BuildResult {
  const { original } = input;
  const dec = ctx.settings.currencyDecimals;
  const amount = receiptAmount(original.amount, dec);
  if (amount === 0n) return noMove('ZERO_VALUE', 'إلغاء سند بمبلغ صفري');
  const customerName = nameOr(input.customerName, 'عميل');
  const numberPart = input.number ? ` رقم ${input.number}` : '';

  let needsAttention = false;
  let attentionReason: string | null = null;
  const credit: LineDraft[] = [];

  if (original.paymentMethod === 'ONLINE' && original.paylinkId) {
    const rev = input.reverse ?? null;
    if (rev?.refundEntryId) {
      const refunded = rev.refundedAmount == null || rev.refundedAmount === ''
        ? amount
        : absMilli(toMilli(rev.refundedAmount, dec));
      const plnk = refunded > amount ? amount : refunded;
      if (plnk > 0n) {
        credit.push({
          accountKey: 'PAYLINK_CLEARING', label: 'استرداد الدفع الإلكتروني من الأمانات',
          debitMilli: 0n, creditMilli: plnk,
        });
      }
      const diff = amount - refunded;
      if (diff !== 0n) {
        // دفاعي فقط: الاسترداد اليوم كامل دائماً
        needsAttention = true;
        attentionReason = 'مبلغ الاسترداد يختلف عن مبلغ السند — الفرق في المعلّق';
        if (diff > 0n) {
          credit.push({
            accountKey: 'POSTING_SUSPENSE', label: 'فرق استرداد إلكتروني عن مبلغ السند — معلّق',
            debitMilli: 0n, creditMilli: diff,
          });
        } else {
          // استرداد أكبر من السند: الزائد يُخصم من الأمانات ويقابله مدين المعلّق
          credit.push(
            {
              accountKey: 'PAYLINK_CLEARING', label: 'زيادة الاسترداد الإلكتروني على مبلغ السند',
              debitMilli: 0n, creditMilli: -diff,
            },
            {
              accountKey: 'POSTING_SUSPENSE', label: 'زيادة الاسترداد الإلكتروني على مبلغ السند — معلّق',
              debitMilli: -diff, creditMilli: 0n,
            },
          );
        }
      }
    } else {
      needsAttention = true;
      attentionReason = MANUAL_ONLINE_CANCEL_ATTENTION;
      credit.push({
        accountKey: 'POSTING_SUSPENSE', label: 'إلغاء يدوي لسند إلكتروني دون استرداد — معلّق',
        debitMilli: 0n, creditMilli: amount,
      });
    }
  } else if (input.originalLines && input.originalLines.length > 0) {
    // عكس القيد الأصلي الحيّ حرفياً (عدا سطر الذمة الذي يُعاد بناؤه مديناً أدناه)
    for (const l of input.originalLines) {
      if (l.customerId) continue; // سطر الذمة (وحده يحمل العميل في P5)
      credit.push({ ...l, label: `عكس: ${l.label}`, debitMilli: l.creditMilli, creditMilli: l.debitMilli });
    }
  } else {
    // بلا سطور أصلية: إعادة اشتقاق طرف P5 من الحمولة والإعدادات الحالية
    const target = receiptDebitTarget(original, ctx, input);
    credit.push({ ...target.line, label: `عكس: ${target.line.label}`, debitMilli: 0n, creditMilli: amount });
    // سند ONLINE بلا رابط أصلاً: عكس المعلّق يصفّيه فلا تنبيه جديد
  }

  const lines: LineDraft[] = [
    {
      accountKey: 'AR_CONTROL', label: `إلغاء تحصيل من العميل ${customerName}`,
      debitMilli: amount, creditMilli: 0n,
      customerId: original.customerId, partnerName: customerName,
    },
    ...credit,
  ];
  const isRefund = original.paymentMethod === 'ONLINE' && !!input.reverse?.refundEntryId;
  return {
    ...baseMove(ctx, input.receiptId, 'REVERSE', input.date, input.number, original,
      `${isRefund ? 'استرداد دفع إلكتروني لسند' : 'إلغاء سند قبض'}${numberPart} من ${customerName}`),
    needsAttention,
    attentionReason,
    lines,
  };
}
