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
//
// «ربط الدفاتر» L5 (العقد §5.2، D3/D4) — للدفاتر المربوطة وحدها (ctx.settings.linkedPosting === true)؛ غيرها حرفياً كما أعلاه:
//    البطاقة (cardPaymentId) ⇒ 112007 أبداً لا عهدة؛ العهدة لطريقتي النقد والشيك وحدهما؛ وإلا خريطة الطرق linkedMethodAccount
//    (صف المفتاح المخصّص ثم صف الأساس ثم الافتراضي: التحويل ⇒ البنك 111101 لا 112001).
//    إلغاء سند إلكتروني يدوياً بلا استرداد ⇒ دائن 214002 بلا تنبيه (C9)، ومصدر الردّ cancelRefundFrom يحدّد دائن العكس (C11).
import { absMilli, toMilli } from '../money';
import { receiptCustodyClass, type ReceiptCustodyClass } from '../custody';
import { CARD_CLEARING_CODE, CUSTOMER_CREDITS_CODE, USER_CUSTODY_CODE } from '../coa/linkedAccounts';
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
  /** «ربط الدفاتر» (C10): مفتاح الطريقة المخصّصة c_… (Receipt.paymentMethodKey) — paymentMethod أعلاه أساسها. للمربوطة وحدها */
  paymentMethodKey?: string | null;
  /** «ربط الدفاتر» (C4): CardPayment.id حين أصدرت السندَ موافقةُ بطاقة — 112007 ولا عهدة أبداً. للمربوطة وحدها */
  cardPaymentId?: string | null;
  /** «ربط الدفاتر» (C16/L8): تخصيصات السند على الفواتير (ReceiptInvoice) لقطةً لحظة الاشتقاق — تقرؤها المطابقة لا الـbuilder */
  allocations?: readonly { id: string; invoiceId: string; amount: string }[];
}

/** مصدر ردّ المال عند إلغاء السند (Receipt.cancelRefundFrom، C11) */
export type CancelRefundFrom = 'REP_CUSTODY' | 'USER_CUSTODY' | 'MAIN_CASH' | 'BANK' | 'METHOD';

/** حمولة RECEIPT:<id>:REVERSE لسند ONLINE (§5.2) */
export interface ReceiptReversePayload {
  paylinkId?: string | null;
  refundEntryId?: string | null;
  /** SettlementEntry.amount لصف REFUND (موقَّع سالباً عادةً) — تُؤخذ قيمته المطلقة */
  refundedAmount?: Amount | null;
  /** «ربط الدفاتر» (C11): من أين رُدّ المال للعميل — null/REP_CUSTODY/METHOD = مرآة الأصل كاليوم. للمربوطة وحدها */
  cancelRefundFrom?: CancelRefundFrom | null;
  /** مع USER_CUSTODY: مستخدم الشركة (Admin.id) الذي ردّ المال من عهدته (111004) */
  cancelRefundUserId?: string | null;
  /** لقطة اسمه لحظة الاشتقاق */
  cancelRefundUserName?: string | null;
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
  line: Pick<LineDraft, 'accountKey' | 'accountCode' | 'accountId' | 'salesRepId' | 'partnerName' | 'label'>;
  needsAttention: boolean;
  attentionReason: string | null;
}

/** الطرف المدين لسند P5 حسب الطريقة والتوجيه والرابط */
export function receiptDebitTarget(
  payload: ReceiptPostPayload, ctx: BuildContext, names: ReceiptNames = {},
): ReceiptDebitTarget {
  const method = payload.paymentMethod;
  const linked = ctx.settings.linkedPosting === true ? linkedReceiptDebitTarget(payload, ctx, names) : null;
  if (linked) return linked;
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
  const refundFrom = linkedRefundSource(original, input.reverse, ctx);

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
    } else if (ctx.settings.linkedPosting === true) {
      // C9: المبلغ ما زال في الأمانات 112005 وصار مستحقاً للعميل — يُصفّيه حدث PAYLINK_REFUND حين يُستردّ (لا معلّق ولا تنبيه)
      credit.push(manualOnlineCancelCredit(original, customerName, amount));
    } else {
      needsAttention = true;
      attentionReason = MANUAL_ONLINE_CANCEL_ATTENTION;
      credit.push({
        accountKey: 'POSTING_SUSPENSE', label: 'إلغاء يدوي لسند إلكتروني دون استرداد — معلّق',
        debitMilli: 0n, creditMilli: amount,
      });
    }
  } else if (refundFrom) {
    // C11: رُدّ المال من خارج عهدة المندوب (بعد التسليم) — الدائن حيث المال الآن لا مرآة الأصل، فلا تسلب 111003
    const r = refundSourceCredit(refundFrom, input.reverse ?? null, amount, ctx);
    credit.push(r.line);
    needsAttention = r.needsAttention;
    attentionReason = r.attentionReason;
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

// ═══ «ربط الدفاتر» L5 — خريطة الطرق والتوجيه ومصدر الردّ (العقد §5.2، D3/D4، C2/C4/C9/C10/C11، OD4/OD14) ═══

/** هدف حساب السطر: معرّف صريح (صف خريطة الطرق) أو مفتاح ربط أو رمز حساب خارج القالب (112007 …) */
export type AccountTarget = { accountId: string } | { accountKey: MappingKey } | { accountCode: string };

/** مفاتيح الأساس في GlPaymentMethodMap (= PAYMENT_METHOD_MAP_KEYS في types.ts) وحسابها حين يغيب صفّها (D3) */
export const LINKED_METHOD_DEFAULTS: Readonly<Record<'CASH' | 'BANK_TRANSFER' | 'POS' | 'CHEQUE' | 'CARD' | 'PAYOUT', AccountTarget>> = {
  CASH: { accountKey: 'MAIN_CASH' },
  // OD14: التحويل إلى البنك مباشرة لا 112001 — «مقبوضات قيد الإيداع» لا يُصفّى قبل مطابقة البنك (M7) فيتضخّم بلا نهاية
  BANK_TRANSFER: { accountKey: 'MAIN_BANK' },
  POS: { accountKey: 'POS_CLEARING' },
  CHEQUE: { accountKey: 'CHEQUES_UNDER_COLLECTION' },
  CARD: { accountCode: CARD_CLEARING_CODE },
  // C8: توريد الأمانات يصل حساب الشركة البنكي — لا 112001 الذي لا يُصفّى
  PAYOUT: { accountKey: 'MAIN_BANK' },
};

/** D4: العهدة تحمل ما يُسلَّم باليد — النقد والشيك. التحويل ونقطة البيع لا يمرّان بيد المندوب */
const LINKED_CUSTODY_METHODS: ReadonlySet<string> = new Set(['CASH', 'CHEQUE']);

const isLinkedBaseKey = (k: string): k is keyof typeof LINKED_METHOD_DEFAULTS =>
  Object.prototype.hasOwnProperty.call(LINKED_METHOD_DEFAULTS, k);

/**
 * صف GlPaymentMethodMap صالحاً للاستعمال. المسار (A9) لا يقبل إلا حساباً نشطاً غير رقابي، والدفاع هنا لصفٍّ تعلّق بحساب حُذف
 * أو صار رقابياً بعد الحفظ: يُتخطّى إلى المستوى التالي بدل قيدٍ على حساب لا يُحلّ أو يملكه مصدر آخر.
 * (الحساب المؤرشف لا يُتخطّى عمداً: قراره للمحاسب، فيظهر خطأ الترحيل ليصحّح الخريطة لا يُعاد توجيه المال صامتاً.)
 */
function mappedMethodAccount(key: string, ctx: BuildContext): AccountTarget | null {
  const ref = ctx.paymentMethodAccount?.(key) ?? null;
  if (!ref) return null;
  const acc = ctx.accounts.byId(ref.accountId);
  if (!acc || acc.controlKind !== null) return null;
  return { accountId: acc.id };
}

/**
 * D3 — الحساب المدين لطريقة دفع في الدفاتر المربوطة: صف المفتاح المخصّص c_… ثم صف الأساس ثم الافتراضي.
 * card ⇒ مفتاح CARD (112007) أيّاً كانت الطريقة. ONLINE غير قابل للربط (112005 بالرابط و911001 بدونه) ⇒ null،
 * وطريقة مجهولة ⇒ null (911001 مع تنبيه كاليوم).
 */
export function linkedMethodAccount(input: { method: string; methodKey?: string | null; card?: boolean }, ctx: BuildContext): AccountTarget | null {
  if (input.card === true) return mappedMethodAccount('CARD', ctx) ?? LINKED_METHOD_DEFAULTS.CARD;
  const base = input.method;
  if (base === 'ONLINE' || !isLinkedBaseKey(base)) return null;
  const custom = typeof input.methodKey === 'string' ? input.methodKey.trim() : '';
  // المفتاح المخصّص وحده يُبحث بصفّه — مفتاح أساس مخزَّن في paymentMethodKey لا يقفز إلى صفّ أساس آخر (CARD/PAYOUT)
  if (custom && custom !== base && !isLinkedBaseKey(custom)) {
    const own = mappedMethodAccount(custom, ctx);
    if (own) return own;
  }
  return mappedMethodAccount(base, ctx) ?? LINKED_METHOD_DEFAULTS[base];
}

/**
 * تصنيف السند للعهدة في الدفاتر المربوطة (D4 وC4): البطاقة خارج العهدة دائماً، وتوجيه CUSTODY المخزَّن لطريقة غير نقدية
 * يُتجاهل دفاعاً (الحفظ يرفضه §5.9). غير المربوطة: receiptCustodyClass كما هي.
 */
export function linkedReceiptCustodyClass(
  p: Pick<ReceiptPostPayload, 'paymentMethod' | 'salesRepId' | 'cardPaymentId'>, ctx: BuildContext,
): ReceiptCustodyClass {
  const cls = receiptCustodyClass({ paymentMethod: p.paymentMethod, salesRepId: p.salesRepId, routing: ctx.settings.receiptRouting });
  if (ctx.settings.linkedPosting !== true || cls !== 'CUSTODY') return cls;
  if (p.cardPaymentId) return 'OUTSIDE';
  return LINKED_CUSTODY_METHODS.has(p.paymentMethod) ? 'CUSTODY' : 'OUTSIDE';
}

/** §5.2: الطرف المدين للمربوطة — null للسند الإلكتروني فيبقى مساره كاليوم */
function linkedReceiptDebitTarget(payload: ReceiptPostPayload, ctx: BuildContext, names: ReceiptNames): ReceiptDebitTarget | null {
  const method = payload.paymentMethod;
  if (payload.cardPaymentId) {
    // C4: موافقة البطاقة تذهب إلى حساب التسوية لا إلى يد المندوب، ولو وُجّهت نقاط البيع إلى العهدة
    const target = linkedMethodAccount({ method, card: true }, ctx) as AccountTarget;
    return { line: { ...target, label: 'تحصيل بطاقة دفع من عميل' }, needsAttention: false, attentionReason: null };
  }
  if (method === 'ONLINE') return null;
  if (linkedReceiptCustodyClass(payload, ctx) === 'CUSTODY') {
    return {
      line: {
        accountKey: 'REP_CUSTODY', label: `تحصيل ${methodLabel(method)} في عهدة المندوب`,
        salesRepId: payload.salesRepId, partnerName: nameOr(names.salesRepName, 'مندوب'),
      },
      needsAttention: false, attentionReason: null,
    };
  }
  const target = linkedMethodAccount({ method, methodKey: payload.paymentMethodKey ?? null }, ctx);
  if (!target) {
    return {
      line: { accountKey: 'POSTING_SUSPENSE', label: `سند بطريقة دفع غير معروفة (${method}) — معلّق` },
      needsAttention: true, attentionReason: `طريقة دفع غير معروفة في السند: ${method}`,
    };
  }
  return { line: { ...target, label: `تحصيل ${methodLabel(method)} من عميل` }, needsAttention: false, attentionReason: null };
}

type BuiltRefundSource = Exclude<CancelRefundFrom, 'REP_CUSTODY' | 'METHOD'>;

/** مصادر الردّ التي تُبنى بالـbuilder (C11)؛ REP_CUSTODY وMETHOD وnull مرآة القيد الأصلي كاليوم */
const BUILT_REFUND_SOURCES: ReadonlySet<string> = new Set<BuiltRefundSource>(['USER_CUSTODY', 'MAIN_CASH', 'BANK']);

/** مصدر الردّ الذي يحدّد دائن العكس — للمربوطة ولغير الإلكتروني وحدهما (السند الإلكتروني لا يقبل مصدراً: A8 يتجاهله) */
function linkedRefundSource(
  original: ReceiptPostPayload, reverse: ReceiptReversePayload | null | undefined, ctx: BuildContext,
): BuiltRefundSource | null {
  if (ctx.settings.linkedPosting !== true || original.paymentMethod === 'ONLINE') return null;
  const from = reverse?.cancelRefundFrom ?? null;
  return from && BUILT_REFUND_SOURCES.has(from) ? (from as BuiltRefundSource) : null;
}

/**
 * هل يُبنى عكس السند بالـbuilder بدل مرآة القيد الحيّ (المُرحِّل reverseLive)؟
 * سند إلكتروني برابط (كاليوم)، أو مربوطة رُدّ مالها من عهدة مستخدم أو الصندوق أو البنك.
 */
export function receiptReversalNeedsBuild(
  original: ReceiptPostPayload, reverse: ReceiptReversePayload | null | undefined, ctx: BuildContext,
): boolean {
  if (original.paymentMethod === 'ONLINE' && original.paylinkId) return true;
  return linkedRefundSource(original, reverse, ctx) !== null;
}

/** C9: إلغاء يدوي لسند إلكتروني في المربوطة — دائن 214002 بالعميل */
function manualOnlineCancelCredit(original: ReceiptPostPayload, customerName: string, amount: Milli): LineDraft {
  return {
    accountCode: CUSTOMER_CREDITS_CODE, label: `مستحق للعميل ${customerName} بإلغاء سند إلكتروني قبل استرداده`,
    debitMilli: 0n, creditMilli: amount, customerId: original.customerId, partnerName: customerName,
  };
}

/** C11: دائن العكس حيث المال الآن */
function refundSourceCredit(
  from: BuiltRefundSource, reverse: ReceiptReversePayload | null, amount: Milli, ctx: BuildContext,
): { line: LineDraft; needsAttention: boolean; attentionReason: string | null } {
  if (from === 'USER_CUSTODY') {
    const userId = reverse?.cancelRefundUserId?.trim() || null;
    if (!userId) {
      // دفاعي: المسار يرفض USER_CUSTODY بلا مستخدم (400) — ولا يجوز سطر عهدة بلا بُعد
      return {
        line: { accountKey: 'POSTING_SUSPENSE', label: 'ردّ مبلغ سند ملغى من عهدة مستخدم غير محدَّد — معلّق', debitMilli: 0n, creditMilli: amount },
        needsAttention: true, attentionReason: 'إلغاء سند بردٍّ من عهدة مستخدم دون تحديد المستخدم',
      };
    }
    const name = nameOr(reverse?.cancelRefundUserName, 'مستخدم');
    return {
      line: {
        accountCode: USER_CUSTODY_CODE, label: `ردّ مبلغ السند الملغى من عهدة المستخدم ${name}`,
        debitMilli: 0n, creditMilli: amount, adminUserId: userId, partnerName: name,
      },
      needsAttention: false, attentionReason: null,
    };
  }
  if (from === 'MAIN_CASH') {
    return {
      line: { accountKey: 'MAIN_CASH', label: 'ردّ مبلغ السند الملغى من الصندوق الرئيسي', debitMilli: 0n, creditMilli: amount },
      needsAttention: false, attentionReason: null,
    };
  }
  const bank = linkedMethodAccount({ method: 'BANK_TRANSFER' }, ctx) as AccountTarget;
  return {
    line: { ...bank, label: 'ردّ مبلغ السند الملغى بتحويل بنكي', debitMilli: 0n, creditMilli: amount },
    needsAttention: false, attentionReason: null,
  };
}
