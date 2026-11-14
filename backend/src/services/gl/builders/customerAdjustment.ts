// «ربط الدفاتر» L4 — M4: تسويات ذمم العملاء (العقد §4.8، B17، أمثلة E4.13–E4.15). دوال صرفة: حمولة المستند + BuildContext ⇒ MoveDraft.
//
// شطب دين معدوم (BAD_DEBT_WRITEOFF، moveType CUSTOMER_ADJUSTMENT، دفتر MISC):
//    مدين 711005 الديون المعدومة (أو 113009 مخصص الديون المشكوك فيها حين يُشطب على المخصص) / دائن 113001 (العميل)
// ردّ رصيد دائن (CREDIT_REFUND، moveType CUSTOMER_REFUND، دفتر RCPT):
//    مدين 113001 (العميل) / دائن حساب الطريقة (linkedMethodAccount: النقد 111001، والتحويل 111101 — OD14)
//
// لماذا builder ومسار لا مُطابِق؟ التسوية مستند دفاتر بلا مستند تشغيلي سابق: المسار يكتب صفّ AccountEntry والقيد والحدث DONE في
// معاملة واحدة (لا قيد بلا صفّه ولا صفّ بلا قيده — R2)، فلا يمرّ بالمُطابِق ولا بالمُرحِّل. والمفتاح AR_ENTRY:<entryId>:POST هو مفتاح
// الصفّ نفسه، فإن قرأه المُطابِق لاحقاً تخطّاه (skipDuplicates) — والمعرّف adjustmentId = AccountEntry.id.
//
// الحمولة لقطة ثابتة (القاعدة 5): counterAccountCode محلول لحظة الإنشاء ومخزَّن، فإعادة البناء من الحمولة تعطي الحسابات نفسها ولو
// تغيّرت خريطة الطرق أو الربط بعدها.
import { isLocalDate } from '../dates';
import { toMilli } from '../money';
import { arEntryEventKey } from './importEntry';
import { linkedMethodAccount, type AccountTarget } from './receipt';
import {
  JOURNAL_CODE_BY_SYSTEM_KEY, noMove,
  type AccountRef, type BuildContext, type BuildResult, type LineDraft, type LocalDate, type MappingKey, type MoveDraft,
} from '../types';

// ═══ القواميس ═══

export const CUSTOMER_ADJUSTMENT_KINDS = ['BAD_DEBT_WRITEOFF', 'CREDIT_REFUND'] as const;
export type CustomerAdjustmentKind = (typeof CUSTOMER_ADJUSTMENT_KINDS)[number];

/** مقابل الشطب: مصروف الديون المعدومة، أو مخصص الديون المشكوك فيها المكوَّن سابقاً */
export const WRITEOFF_COUNTERS = ['BAD_DEBT', 'ALLOWANCE'] as const;
export type WriteoffCounter = (typeof WRITEOFF_COUNTERS)[number];

/** طرق ردّ الرصيد الدائن */
export const REFUND_METHODS = ['CASH', 'BANK_TRANSFER', 'CHEQUE'] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

export const CUSTOMER_ADJUSTMENT_STATUSES = ['ACTIVE', 'CANCELLED'] as const;
export type CustomerAdjustmentStatus = (typeof CUSTOMER_ADJUSTMENT_STATUSES)[number];

/** مفتاح الربط ثم الرمز الافتراضي في القالب (711005 / 113009) — الشركة قد تعيد ربط المفتاح بحساب آخر */
export const WRITEOFF_COUNTER_ACCOUNTS: Readonly<Record<WriteoffCounter, { key: MappingKey; code: string }>> = {
  BAD_DEBT: { key: 'BAD_DEBT', code: '711005' },
  ALLOWANCE: { key: 'DOUBTFUL_ALLOWANCE', code: '113009' },
};

/** عبارة الطريقة في البيان («ردّ رصيد دائن للعميل … نقداً / بتحويل بنكي / بشيك») */
export const REFUND_METHOD_PHRASES: Readonly<Record<RefundMethod, string>> = {
  CASH: 'نقداً',
  BANK_TRANSFER: 'بتحويل بنكي',
  CHEQUE: 'بشيك',
};

export const isCustomerAdjustmentKind = (v: unknown): v is CustomerAdjustmentKind =>
  typeof v === 'string' && (CUSTOMER_ADJUSTMENT_KINDS as readonly string[]).includes(v);
export const isRefundMethod = (v: unknown): v is RefundMethod =>
  typeof v === 'string' && (REFUND_METHODS as readonly string[]).includes(v);

/** مفتاح حدث التسوية (مفتاح صفّ AccountEntry نفسه — §4.8 الخطوة 7) */
export const customerAdjustmentKey = (adjustmentId: string, event: 'POST' | 'REVERSE' = 'POST'): string =>
  arEntryEventKey(adjustmentId, event);

// ═══ حلّ الحسابات ═══

/** حساب مقابل الشطب: صف الربط ثم الرمز الافتراضي — null إن غاب الاثنان من شجرة الشركة */
export function writeoffCounterAccount(counter: WriteoffCounter, ctx: Pick<BuildContext, 'accounts'>): AccountRef | null {
  const t = WRITEOFF_COUNTER_ACCOUNTS[counter];
  return ctx.accounts.byKey(t.key) ?? ctx.accounts.byCode(t.code);
}

/**
 * الحساب الدائن لردّ الرصيد (D3 عبر linkedMethodAccount): النقد ⇒ حساب CASH (111001 أو صفّ الخريطة)، والتحويل ⇒ BANK_TRANSFER
 * (111101 — OD14). **الشيك ⇒ حساب البنك كالتحويل**: شيك تحرّره الشركة لعميلها يُسحب من بنكها، لا من «شيكات تحت التحصيل» 112003
 * (ذاك أصلٌ لشيكات العملاء الواردة؛ قيده دائناً بشيكٍ صادر يُنقصه بلا شيكٍ وارد). ولا عهدة ولا حساب وسيط هنا أبداً.
 */
export function refundCreditTarget(method: RefundMethod, ctx: BuildContext): AccountTarget {
  const base = method === 'CHEQUE' ? 'BANK_TRANSFER' : method;
  // linkedMethodAccount لا يعيد null لمفتاح أساس معروف (CASH وBANK_TRANSFER)
  return linkedMethodAccount({ method: base }, ctx) as AccountTarget;
}

/** هدف سطر ⇐ الحساب في شجرة الشركة (للتحقق المسبق وتخزين الرمز) */
export function resolveAccountTarget(target: AccountTarget, ctx: Pick<BuildContext, 'accounts'>): AccountRef | null {
  if ('accountId' in target) return ctx.accounts.byId(target.accountId);
  if ('accountCode' in target) return ctx.accounts.byCode(target.accountCode);
  return ctx.accounts.byKey(target.accountKey);
}

// ═══ الحمولة والقيد ═══

/** حمولة المستند كما خُزّن (العقد §4.8) — المبلغ نصّ بمنازل العملة */
export interface CustomerAdjustmentPayload {
  adjustmentId: string;
  kind: CustomerAdjustmentKind;
  customerId: string;
  customerName: string | null;
  amount: string;
  /** رمز الحساب المقابل المحلول لحظة الإنشاء: 711005|113009 للشطب، وحساب النقد/البنك للاسترداد */
  counterAccountCode: string;
  /** للاسترداد: CASH | BANK_TRANSFER | CHEQUE — null للشطب */
  method?: string | null;
  docDate: LocalDate;
  reference?: string | null;
}

const nameOr = (name: string | null | undefined, fallback: string): string => (name && name.trim() ? name.trim() : fallback);

/** هل مقابل الشطب حساب المخصص؟ (للبيان وحده — الحساب نفسه من الرمز المخزَّن) */
function isAllowanceCounter(code: string, ctx: BuildContext): boolean {
  const allowance = writeoffCounterAccount('ALLOWANCE', ctx);
  return allowance !== null && allowance.code === code;
}

/**
 * قيد التسوية (العقد §4.8). المبلغ موجب دائماً والاتجاه من kind؛ قيدٌ واحد متّزن بسطرين على ذمة العميل ومقابلها.
 * الأخطاء البرمجية (حمولة ناقصة) RangeError؛ ومبلغ صفري ⇒ NO_MOVE(ZERO_VALUE) (المسار يرفضه قبل البناء أصلاً).
 */
export function buildCustomerAdjustmentMove(p: CustomerAdjustmentPayload, ctx: BuildContext): BuildResult {
  const { settings } = ctx;
  const dec = settings.currencyDecimals;
  if (!p.adjustmentId) throw new RangeError('تسوية ذمة بلا معرّف');
  if (!p.customerId) throw new RangeError(`تسوية ذمة ${p.adjustmentId} بلا عميل`);
  if (!isCustomerAdjustmentKind(p.kind)) throw new RangeError(`نوع تسوية غير معروف: ${String(p.kind)}`);
  if (!isLocalDate(p.docDate)) throw new RangeError(`تاريخ تسوية غير صالح: ${String(p.docDate)}`);
  const amount = toMilli(p.amount, dec);
  if (amount < 0n) throw new RangeError(`مبلغ تسوية سالب: ${p.amount}`);
  if (amount === 0n) return noMove('ZERO_VALUE', 'تسوية ذمة بمبلغ صفري');

  const customer = nameOr(p.customerName, `عميل ${p.customerId}`);
  const partner = { customerId: p.customerId, partnerName: customer };
  const ref = p.reference?.trim() || null;
  const tail = ref ? ` (${ref})` : '';
  const base = {
    kind: 'MOVE' as const,
    origin: 'AUTO' as const,
    date: p.docDate,
    ref,
    needsAttention: false,
    attentionReason: null,
    customerId: p.customerId,
    sourceType: 'CUSTOMER_ADJUSTMENT' as const,
    sourceId: p.adjustmentId,
    sourceKey: customerAdjustmentKey(p.adjustmentId, 'POST'),
    sourceEvent: 'POST' as const,
    currencyCode: settings.currency,
    currencyDecimals: dec,
  };

  if (p.kind === 'BAD_DEBT_WRITEOFF') {
    const code = p.counterAccountCode?.trim();
    if (!code) throw new RangeError(`شطب ${p.adjustmentId} بلا حساب مقابل`);
    const allowance = isAllowanceCounter(code, ctx);
    const what = allowance ? 'شطب ذمة على مخصص الديون المشكوك فيها' : 'شطب دين معدوم';
    const lines: LineDraft[] = [
      { accountCode: code, label: `${what} — ${customer}${tail}`, debitMilli: amount, creditMilli: 0n, ...partner },
      { accountKey: 'AR_CONTROL', label: `${what}${tail}`, debitMilli: 0n, creditMilli: amount, ...partner },
    ];
    const draft: MoveDraft = {
      ...base,
      journalCode: ctx.journals.bySystemKey('MISC')?.code ?? JOURNAL_CODE_BY_SYSTEM_KEY.MISC,
      journalSystemKey: 'MISC',
      moveType: 'CUSTOMER_ADJUSTMENT',
      narration: `${what} للعميل ${customer}`,
      lines,
    };
    return draft;
  }

  // CREDIT_REFUND
  const method = isRefundMethod(p.method) ? p.method : null;
  if (!method) throw new RangeError(`ردّ رصيد ${p.adjustmentId} بطريقة غير معروفة: ${String(p.method)}`);
  // الرمز المخزَّن أولاً (لقطة لحظة الإنشاء)، وإلا الحلّ الحالي من الطريقة
  const code = p.counterAccountCode?.trim();
  const target: AccountTarget = code ? { accountCode: code } : refundCreditTarget(method, ctx);
  const how = REFUND_METHOD_PHRASES[method];
  const lines: LineDraft[] = [
    {
      accountKey: 'AR_CONTROL', label: `ردّ رصيد دائن للعميل${tail}`, debitMilli: amount, creditMilli: 0n, ...partner,
      // الردّ يستحق يوم دفعه: سطر المدين يُطابَق فوراً مع الأرصدة الدائنة المفتوحة (FIFO) فلا يظهر متأخراً في الأعمار
      dueDate: p.docDate,
    },
    { ...target, label: `ردّ رصيد دائن ${how} — ${customer}${tail}`, debitMilli: 0n, creditMilli: amount, ...partner },
  ];
  const draft: MoveDraft = {
    ...base,
    journalCode: ctx.journals.bySystemKey('RECEIPTS')?.code ?? JOURNAL_CODE_BY_SYSTEM_KEY.RECEIPTS,
    journalSystemKey: 'RECEIPTS',
    moveType: 'CUSTOMER_REFUND',
    narration: `ردّ رصيد دائن للعميل ${customer} ${how}`,
    lines,
  };
  return draft;
}
