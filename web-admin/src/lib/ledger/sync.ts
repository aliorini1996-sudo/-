import type { CheckKey, CheckStatus, EventAction, EventNote, EventStatus, PostingState } from '../../api/ledgerReview';
import { milliToDecimalString } from './format';
import type {
  CancelRefundFrom, ClearingInput, ClearingKind, ClearingOpenLineView, CreateCustomerAdjustmentInput, CustodyExplanationView,
  CustomerAdjustmentKind, OpenInvoiceView, PaymentMethodMapRow, ReceiptCancelBody, ReceiptCancelOptions, RefundMethod, WriteoffCounter,
} from '../../api/ledgerOps';
import { parseAmountToMilli } from './format';
import { ledgerErrorMessage, type LedgerErrorLike } from './errors';
import { DEFAULT_METHOD_LABELS, defaultMethodLabel } from '../paymentMethodsConfig';

/**
 * تسميات «مراجعة» و«العملاء» في الدفاتر (M3) — صرفة ومختبَرة في sync.test.ts، بنداءات tr حرفية.
 * نصوص الخادم العربية (عناوين الفحوص وملخصاتها ورسائل الخطأ) لا تُعرض خاماً في الواجهة غير العربية (§8.7).
 */

type Tr = (ar: string) => string;

export const eventStatusLabels = (tr: Tr): Record<EventStatus, string> => ({
  PENDING: tr('بانتظار الترحيل'),
  DONE: tr('مُرحّل'),
  SKIPPED: tr('متخطّى'),
  BLOCKED: tr('محجوب مؤقتا'),
  ERROR: tr('خطأ'),
  HELD: tr('موقوف'),
});

export const postingStateLabels = (tr: Tr): Record<PostingState, string> => ({
  NOT_SYNCED: tr('لم يُلتقط بعد'),
  PENDING: tr('بانتظار الترحيل'),
  BLOCKED: tr('محجوب مؤقتا'),
  ERROR: tr('خطأ'),
  HELD: tr('موقوف'),
  POSTED: tr('مُرحّل'),
  IN_OPENING: tr('ضمن القيد الافتتاحي'),
  SKIPPED: tr('متخطّى'),
  REVERSE_PENDING: tr('العكس بانتظار الترحيل'),
  REVERSED: tr('معكوس'),
});

export type Tone = 'green' | 'amber' | 'red' | 'gray' | 'blue';

export function postingTone(state: PostingState): Tone {
  switch (state) {
    case 'POSTED': return 'green';
    case 'IN_OPENING': case 'REVERSED': case 'SKIPPED': return 'gray';
    case 'ERROR': case 'HELD': return 'red';
    case 'BLOCKED': case 'REVERSE_PENDING': return 'amber';
    default: return 'blue';
  }
}

export function eventTone(status: EventStatus): Tone {
  switch (status) {
    case 'DONE': return 'green';
    case 'SKIPPED': return 'gray';
    case 'ERROR': case 'HELD': return 'red';
    case 'BLOCKED': return 'amber';
    default: return 'blue';
  }
}

export const checkStatusTone = (s: CheckStatus): Tone => (s === 'GREEN' ? 'green' : s === 'YELLOW' ? 'amber' : 'red');

export const TONE_CLASSES: Record<Tone, string> = {
  green: 'bg-emerald-50 text-emerald-700',
  amber: 'bg-amber-50 text-amber-800',
  red: 'bg-[#FBE3DF] text-[#8E2A1F]',
  gray: 'bg-[#F1EBDF] text-[#6E6557]',
  blue: 'bg-sky-50 text-sky-800',
};

export const skipReasonLabels = (tr: Tr): Record<string, string> => ({
  OPENING: tr('مشمول بالقيد الافتتاحي'),
  NETTED: tr('تقاصّ مع عكسه'),
  MANUAL: tr('تخطّاه المسؤول'),
  NEVER_MATERIALIZED: tr('أُنشئ وحُذف قبل ترحيله'),
  ZERO_VALUE: tr('قيمة صفرية'),
});

export const sourceTypeLabels = (tr: Tr): Record<string, string> => ({
  INVOICE: tr('فاتورة'),
  RECEIPT: tr('سند قبض'),
  AR_ENTRY: tr('قيد ذمم مستورد'),
  SETTLEMENT: tr('استلام تحصيل'),
  PAYLINK_FEE: tr('عمولة دفع إلكتروني'),
  PAYOUT: tr('توريد أمانات'),
  WH_ENTRY: tr('حركة مستودع'),
  VAN_LOAD: tr('تحميل سيارة'),
  RESTOCK: tr('إرجاع للمخزون'),
  CUSTOMER_ADJUSTMENT: tr('تسوية ذمة عميل'),
  USER_SETTLEMENT: tr('توريد عهدة مستخدم'),
  PAYLINK_REFUND: tr('استرداد دفع إلكتروني'),
  SUPPLIER_ENTRY: tr('قيد كشف مورّد'),
});

export const sourceEventLabels = (tr: Tr): Record<string, string> => ({
  POST: tr('ترحيل'),
  REVERSE: tr('عكس'),
  COGS: tr('تكلفة المبيعات'),
  RESTOCK: tr('إرجاع للمخزون'),
});

/** سبب الإيقاف أو الحجب أو الانتظار المفكوك (decodeEventNote في الخادم) ⇒ نص مترجم. */
export function eventNoteText(tr: Tr, note: EventNote | null | undefined): string | null {
  if (!note) return null;
  if (note.kind === 'ERROR') return note.message;
  const labels: Record<string, string> = {
    CURRENCY_MISMATCH: tr('عملة المستند تختلف عن عملة الدفاتر'),
    MISSING_MAPPING: tr('حساب مربوط غير موجود أو مؤرشف'),
    SOURCE_NOT_FOUND: tr('المستند المصدر غير موجود'),
    UNEXPECTED_ENTRY_SHAPE: tr('شكل قيد غير متوقع في كشف الحساب'),
    SIBLING_NOT_FINAL: tr('بانتظار ترحيل الحدث الأصلي'),
    AWAITING_RECONCILER: tr('بانتظار التقاط المستند'),
    SETTLEMENT_ORDER: tr('بانتظار ترحيل سندات المندوب السابقة'),
    INVENTORY_HORIZON: tr('بانتظار أفق المخزون'),
    INVENTORY_HEAD_OF_LINE: tr('بانتظار حدث مخزون سابق'),
  };
  const text = labels[note.reason] ?? note.reason;
  return 'detail' in note && note.detail ? `${text} (${note.detail})` : text;
}

/** الإجراءات المسموحة لحالة الحدث — مرآة EVENT_ACTION_ALLOWED في services/gl/checks/eventActions.ts. */
export const EVENT_ACTION_ALLOWED: Readonly<Record<EventAction, readonly EventStatus[]>> = {
  retry: ['ERROR', 'BLOCKED'],
  release: ['HELD'],
  skip: ['PENDING', 'BLOCKED', 'ERROR', 'HELD'],
};

export function eventActionsFor(status: EventStatus): EventAction[] {
  return (['retry', 'release', 'skip'] as const).filter(a => EVENT_ACTION_ALLOWED[a].includes(status));
}

export const checkTitles = (tr: Tr): Record<CheckKey | LinkedCheckKey, string> => ({
  C1: tr('توازن القيود'),
  C2: tr('الأرصدة الشهرية'),
  C3: tr('ذمم العملاء'),
  C4: tr('عهدة المناديب'),
  C4b: tr('العهدة مقابل الشاشة التشغيلية'),
  C5: tr('أمانات الدفع الإلكتروني'),
  C8: tr('أحداث الترحيل الآلي'),
  C9: tr('الحسابات المعلّقة'),
  C10: tr('المسودات قبل الإقفال'),
  C11: tr('ضرائب غير مربوطة بمربع'),
  C12: tr('تسلسل الترقيم'),
  C14: tr('ازدواج القيد مع ERP'),
  C15: tr('تأخّر مؤشر المزامنة'),
  C4u: tr('عهدة مستخدمي الشركة'),
  C16: tr('الذمم المفتوحة مقابل متبقّي الفواتير'),
});

export const checkStatusLabels = (tr: Tr): Record<CheckStatus, string> => ({
  GREEN: tr('سليم'),
  YELLOW: tr('يحتاج متابعة'),
  RED: tr('خلل'),
});

/** فحوص يُتاح منها قيد تصحيح حساب رئيسي (§5.9، C6 من M9). */
export const CONTROL_ADJUSTABLE: readonly CheckKey[] = ['C3', 'C4', 'C5'];

/** مبلغ ملّي نصي من الخادم ⇒ نص عشري لـLedgerAmount (null ⇒ «0»). */
export const milliAmount = (m: string | null | undefined): string => (m === null || m === undefined ? '0' : milliToDecimalString(m));

/** صفوف أعمدة المبلغ في تعمّق الفحص: المفاتيح المنتهية بـMilli. */
export const isMilliKey = (k: string): boolean => /Milli$/.test(k);

/**
 * رابط المستند التشغيلي لمصدر قيد أو حدث (§6.1 «المصدر: <المستند>»): الصفحات القائمة لا تفتح مستنداً بمعرّفه،
 * فالعميل يُفتح بملفه (`/app/customers?open=`) والباقي بصفحة قائمته.
 */
export function sourceDocumentHref(sourceType: string | null | undefined, opts: { customerId?: string | null } = {}): string | null {
  switch (sourceType) {
    case 'INVOICE':
    case 'CUSTOMER_ADJUSTMENT':
    case 'AR_ENTRY':
      return opts.customerId ? `/app/customers?open=${encodeURIComponent(opts.customerId)}` : sourceType === 'INVOICE' ? '/app/invoices' : '/app/customers';
    case 'RECEIPT':
      return opts.customerId ? `/app/customers?open=${encodeURIComponent(opts.customerId)}` : '/app/receipts';
    case 'SETTLEMENT': return '/app/sales-reps';
    case 'PAYLINK_FEE':
    case 'PAYOUT': return '/app/paylink';
    case 'WH_ENTRY': return '/app/warehouse';
    case 'VAN_LOAD':
    case 'RESTOCK': return '/app/van-stock';
    case 'USER_SETTLEMENT': return '/app/company-users';
    case 'PAYLINK_REFUND': return '/app/paylink';
    default: return null;
  }
}

/** مفتاح المصدر ⇒ رابط قائمة الأحداث مفلترة به. */
export const eventsHrefFor = (sourceKeyOrId: string): string => `/app/ledger/review/events?q=${encodeURIComponent(sourceKeyOrId)}`;

// ═══ «ربط الدفاتر» L4/L5 (A11): أنواع القيود الجديدة ومنطق شاشات العمليات — صرف، مختبَر في l458-a11-ops.test.ts ═══

/** فحصا الربط الجديدان (C4u عهدة المستخدمين، C16 الذمم المفتوحة) — قبل أن يتّسع CheckKey في api/ledgerReview.ts */
export type LinkedCheckKey = 'C4u' | 'C16';

/** أنواع القيود (MOVE_TYPES في services/gl/types.ts) — CUSTOMER_REFUND (D12) لردّ رصيد العميل واسترداد الدفع الإلكتروني */
export const moveTypeLabels = (tr: Tr): Record<string, string> => ({
  ENTRY: tr('قيد يومية'),
  OUT_INVOICE: tr('فاتورة مبيعات'),
  OUT_REFUND: tr('مردود مبيعات'),
  CUST_RECEIPT: tr('سند قبض'),
  CUSTODY_SETTLEMENT: tr('تسوية عهدة'),
  PAYLINK_FEE: tr('عمولة دفع إلكتروني'),
  PAYLINK_PAYOUT: tr('توريد أمانات'),
  IMPORT: tr('استيراد'),
  IN_INVOICE: tr('فاتورة مشتريات'),
  IN_REFUND: tr('مردود مشتريات'),
  PAYMENT: tr('دفعة'),
  EXPENSE: tr('مصروف'),
  STATEMENT_LINE: tr('سطر كشف بنك'),
  RECONCILE: tr('تسوية حسابات'),
  STOCK: tr('حركة مخزون'),
  COGS: tr('تكلفة المبيعات'),
  INV_CLOSING: tr('إقفال المخزون'),
  DEPRECIATION: tr('إهلاك'),
  LOAN: tr('قرض'),
  DEFERRAL: tr('تأجيل إيراد أو مصروف'),
  TAX_CLOSING: tr('إقفال الضريبة'),
  OPENING: tr('قيد افتتاحي'),
  FY_CLOSING: tr('إقفال السنة المالية'),
  FX: tr('فروقات عملة'),
  CUSTOMER_ADJUSTMENT: tr('تسوية ذمة عميل'),
  CUSTODY_SHORTAGE: tr('عجز عهدة'),
  CONTROL_ADJUSTMENT: tr('قيد تصحيح حساب رئيسي'),
  CUSTOMER_REFUND: tr('ردّ مبلغ لعميل'),
});

/**
 * نص خطأ شاشة عمليات: تسمية الشاشة للسبب أو الرمز أولاً (أدقّ من العامة)، ثم ledgerErrorMessage — ولا رسالة خادم عربية أبداً.
 */
export function opsErrorMessage(tr: Tr, e: LedgerErrorLike | null | undefined, specific?: Readonly<Record<string, string>>): string {
  const reason = typeof e?.reason === 'string' ? e.reason : typeof e?.details?.reason === 'string' ? e.details.reason : undefined;
  if (reason && specific?.[reason]) return specific[reason];
  if (typeof e?.code === 'string' && specific?.[e.code]) return specific[e.code];
  return ledgerErrorMessage(tr, e);
}

// —— المبالغ: ملّي BigInt بلا أعداد عائمة ولا تقريب صامت (العقد §0.5) ——

/** أصغر وحدة في العملة بالملّي: 3 منازل ⇒ 1، منزلتان ⇒ 10، صفر ⇒ 1000 */
export const unitMilliOf = (decimals: number): bigint => 10n ** BigInt(3 - Math.max(0, Math.min(3, Math.trunc(decimals))));

/** مضاعفٌ لأصغر وحدة في العملة؟ (fitsCurrency في الخادم) */
export const fitsCurrencyMilli = (m: bigint, decimals: number): boolean => m % unitMilliOf(decimals) === 0n;

/** منازل النص المُدخل الفعلية بعد تطبيع parseAmountToMilli نفسه (الأرقام العربية، «٫»، الفواصل) وبلا الأصفار اللاحقة */
function enteredDecimals(input: string): number {
  let s = input.trim().replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)).replace(/٫/g, '.').replace(/[٬\s  ]/g, '');
  if (s.includes('.') || /,\d{3}(?!\d)/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  const m = /\.(\d*)$/.exec(s);
  return m ? m[1].replace(/0+$/, '').length : 0;
}

export type OpsAmount = { ok: true; milli: bigint } | { ok: false; reason: 'REQUIRED' | 'INVALID_AMOUNT' | 'PRECISION' };

/**
 * مبلغ مُدخل ⇒ ملّي. الفارغ ⇒ REQUIRED (أو صفر لحقلٍ اختياري)، وغير الصالح ⇒ INVALID_AMOUNT، ومنازل أكثر من منازل العملة
 * ⇒ PRECISION — يُرفض كما يرفضه الخادم (لا يُقرَّب صامتاً في مستند محاسبي). السالب يُعاد سالباً ويُفحص عند المستدعي.
 */
export function parseOpsAmount(input: string | number | null | undefined, decimals: number, opts: { required?: boolean } = {}): OpsAmount {
  const s = input === null || input === undefined ? '' : String(input).trim();
  if (s === '') return opts.required ? { ok: false, reason: 'REQUIRED' } : { ok: true, milli: 0n };
  const milli = parseAmountToMilli(s, 3);
  if (milli === null) return { ok: false, reason: 'INVALID_AMOUNT' };
  const places = enteredDecimals(s);
  if (places > Math.max(0, Math.min(3, Math.trunc(decimals))) || !fitsCurrencyMilli(milli, decimals)) return { ok: false, reason: 'PRECISION' };
  return { ok: true, milli };
}

/** مبلغ من الخادم (رقم بوحدة العملة، مقرَّب لكل مستند) ⇒ ملّي */
export const numberMilli = (n: number | null | undefined): bigint => parseAmountToMilli(Number(n ?? 0).toFixed(6), 3) ?? 0n;

/** ملّي ⇒ نص عشري للإرسال («1940.500») — الخادم يقرؤه بـtoMilli(v, 3) ثم يفحص منازل العملة */
export const milliWire = (m: bigint): string => milliToDecimalString(m);

const isLocalDateText = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

// —— حوار إلغاء السند: «من أين رُدّ المال؟» (C11، العقد §5.3 و§6.4) ——

export interface RefundChoice { refundFrom: CancelRefundFrom; userId: string | null }

/**
 * يستحق السند سؤال الخادم عن مصدر الردّ (GET cancel-options)؟ لا يدخل عهدةَ المندوب في الدفاتر المربوطة إلا نقدٌ أو شيكٌ
 * بيد مندوب (D4) — فغيرها (تحويل، شبكة، إلكتروني، بلا مندوب) يُلغى بلا طلبٍ إضافي ولا جسم، كما كان حرفاً.
 */
export function receiptMayNeedRefundSource(r: { paymentMethod: string; salesRep?: { id: string } | null; status?: string } | null | undefined): boolean {
  return !!r && r.status !== 'CANCELLED' && !!r.salesRep?.id && (r.paymentMethod === 'CASH' || r.paymentMethod === 'CHEQUE');
}

/**
 * المنتقي يظهر للدفاتر المربوطة وحدها، لسند عهدةٍ سُلِّم ماله (المندوب لم يعد يحمل ما يكفي لردّه)، وبخياراتٍ أعادها الخادم.
 * غير ذلك (غير المربوطة، الإلكتروني، خارج العهدة، لم يُسلَّم، خيارات تعذّر جلبها) ⇒ لا منتقي ولا جسم: الإلغاء حرفياً كاليوم.
 */
export function refundPickerVisible(o: ReceiptCancelOptions | null | undefined): o is ReceiptCancelOptions {
  return !!o && o.linked === true && o.custodyClass === 'CUSTODY' && o.handedOver === true
    && Array.isArray(o.options) && o.options.length > 0;
}

/** الاختيار الأوّل = مقترح الخادم (ومستخدمه لعهدة المستخدم)، وإلا أول خيار */
export function initialRefundChoice(o: ReceiptCancelOptions | null | undefined): RefundChoice | null {
  if (!refundPickerVisible(o)) return null;
  const opt = o.options.find(x => x.value === o.suggested) ?? o.options[0];
  return { refundFrom: opt.value, userId: opt.value === 'USER_CUSTODY' ? opt.userId ?? o.suggestedUserId ?? null : null };
}

/** الاختيار مكتمل؟ (عهدة المستخدم تحتاج مستخدمها) — زرّ التأكيد معطّل بدونه */
export function refundChoiceComplete(o: ReceiptCancelOptions | null | undefined, c: RefundChoice | null | undefined): boolean {
  if (!refundPickerVisible(o)) return true;
  if (!c || !o.options.some(x => x.value === c.refundFrom)) return false;
  return c.refundFrom !== 'USER_CUSTODY' || !!c.userId;
}

/** جسم PATCH /receipts/:id/cancel — undefined (لا جسم، كاليوم حرفاً) إلا حين يظهر المنتقي ويكتمل الاختيار */
export function cancelRequestBody(o: ReceiptCancelOptions | null | undefined, c: RefundChoice | null | undefined): ReceiptCancelBody | undefined {
  if (!refundPickerVisible(o) || !c || !refundChoiceComplete(o, c)) return undefined;
  return c.refundFrom === 'USER_CUSTODY' ? { refundFrom: c.refundFrom, refundFromUserId: c.userId! } : { refundFrom: c.refundFrom };
}

// —— التسوية الموجّهة للحسابات الوسيطة (العقد §5.2، E5.14) ——

export interface ClearingDraftInput {
  date: string;
  bankAccountId: string;
  gross: string;
  fee: string;
  feeVat: string;
  /** السطور المختارة — الفارغ ⇒ الأقدم فالأقدم على كل المفتوح (يقرّره الخادم) */
  selected: readonly string[];
}

export interface ClearingCheckContext {
  decimals: number;
  lines: readonly Pick<ClearingOpenLineView, 'lineId' | 'residual'>[];
  /** Σ متبقّي كل السطور المفتوحة على الحساب (لا المعروضة وحدها) */
  openTotal: number;
  /** رصيد الحساب الوسيط المرحَّل */
  balance: number;
}

export type ClearingField = 'date' | 'bankAccountId' | 'gross' | 'fee' | 'feeVat' | 'lines';
export interface ClearingProblemView { reason: string; field: ClearingField }
export interface ClearingPreviewLine { role: 'BANK' | 'FEE' | 'FEE_VAT' | 'CLEARING'; debitMilli: bigint; creditMilli: bigint }

export interface ClearingCheck {
  problems: ClearingProblemView[];
  grossMilli: bigint | null;
  feeMilli: bigint | null;
  feeVatMilli: bigint | null;
  /** الصافي المودَع = الإجمالي − العمولة − ضريبتها */
  netMilli: bigint | null;
  /** المتاح للتصفية: متبقّي المختارة، أو كل المفتوح بلا اختيار */
  availableMilli: bigint;
  /** معاينة القيد (فارغة ما دامت المبالغ غير صالحة) — Σ المدين = Σ الدائن = الإجمالي */
  preview: ClearingPreviewLine[];
}

/** Σ متبقّي السطور المختارة بالملّي (زرّ «الإجمالي = المختار») */
export function selectedResidualMilli(lines: readonly Pick<ClearingOpenLineView, 'lineId' | 'residual'>[], selected: readonly string[]): bigint {
  const chosen = new Set(selected);
  return lines.reduce((s, l) => (chosen.has(l.lineId) ? s + numberMilli(l.residual) : s), 0n);
}

/**
 * تحقّق مستند التسوية قبل الإرسال — مرآة clearingInputProblems وحدود المسار (EXCEEDS_OPEN ثم EXCEEDS_BALANCE) بالترتيب نفسه،
 * ومعاينة القيد: مدين البنك بالصافي + مدين العمولة + مدين ضريبتها / دائن الوسيط بالإجمالي (متّزن دائماً بالبناء).
 * حسابات البنك والضريبة والرسوم يحسمها الخادم (VAT_TAX_UNAVAILABLE وFEE_ACCOUNT_MISSING) فلا تُخمَّن هنا.
 */
export function clearingDraftCheck(d: ClearingDraftInput, ctx: ClearingCheckContext): ClearingCheck {
  const problems: ClearingProblemView[] = [];
  const add = (reason: string, field: ClearingField) => problems.push({ reason, field });
  if (!isLocalDateText(d.date)) add('INVALID_DATE', 'date');

  const amount = (v: string, field: ClearingField, required: boolean): bigint | null => {
    const p = parseOpsAmount(v, ctx.decimals, { required });
    if (p.ok) return p.milli;
    add(p.reason === 'REQUIRED' ? 'GROSS_REQUIRED' : p.reason, field);
    return null;
  };
  const gross = amount(d.gross, 'gross', true);
  const fee = amount(d.fee, 'fee', false);
  const vat = amount(d.feeVat, 'feeVat', false);
  if (gross !== null && gross <= 0n) add('GROSS_NOT_POSITIVE', 'gross');
  if (fee !== null && fee < 0n) add('FEE_NEGATIVE', 'fee');
  if (vat !== null && vat < 0n) add('FEE_VAT_NEGATIVE', 'feeVat');
  if (gross !== null && fee !== null && vat !== null && fee >= 0n && vat >= 0n && gross > 0n && fee + vat > gross) add('FEES_EXCEED_GROSS', 'fee');
  if (fee !== null && vat !== null && vat > 0n && fee === 0n) add('FEE_VAT_WITHOUT_FEE', 'feeVat');
  if (!d.bankAccountId) add('BANK_REQUIRED', 'bankAccountId');

  const availableMilli = d.selected.length > 0 ? selectedResidualMilli(ctx.lines, d.selected) : numberMilli(ctx.openTotal);
  if (ctx.lines.length === 0 && numberMilli(ctx.openTotal) === 0n) add('NO_OPEN_LINES', 'lines');
  else if (gross !== null && gross > 0n && gross > availableMilli) add('EXCEEDS_OPEN', 'gross');
  else if (gross !== null && gross > 0n && gross > numberMilli(ctx.balance)) add('EXCEEDS_BALANCE', 'gross');

  const amountsOk = gross !== null && fee !== null && vat !== null && gross > 0n && fee >= 0n && vat >= 0n && fee + vat <= gross;
  const net = amountsOk ? gross - fee - vat : null;
  const preview: ClearingPreviewLine[] = [];
  if (amountsOk) {
    if (net! > 0n) preview.push({ role: 'BANK', debitMilli: net!, creditMilli: 0n });
    if (fee > 0n) preview.push({ role: 'FEE', debitMilli: fee, creditMilli: 0n });
    if (vat > 0n) preview.push({ role: 'FEE_VAT', debitMilli: vat, creditMilli: 0n });
    preview.push({ role: 'CLEARING', debitMilli: 0n, creditMilli: gross });
  }
  return { problems, grossMilli: gross, feeMilli: fee, feeVatMilli: vat, netMilli: net, availableMilli, preview };
}

/** جسم POST /ledger/clearing من مسودة صالحة — العمولة وضريبتها الصفريتان لا تُرسلان، والاختيار الفارغ = الأقدم فالأقدم */
export function clearingRequestBody(
  kind: ClearingKind, d: ClearingDraftInput, c: ClearingCheck, extra: { ref?: string; note?: string } = {},
): ClearingInput | null {
  if (c.problems.length > 0 || c.grossMilli === null) return null;
  const ref = extra.ref?.trim();
  const note = extra.note?.trim();
  return {
    kind, date: d.date, bankAccountId: d.bankAccountId, gross: milliWire(c.grossMilli),
    ...(c.feeMilli ? { fee: milliWire(c.feeMilli) } : {}),
    ...(c.feeVatMilli ? { feeVat: milliWire(c.feeVatMilli) } : {}),
    ...(ref ? { ref } : {}),
    ...(note ? { note } : {}),
    ...(d.selected.length > 0 ? { lineIds: [...d.selected] } : {}),
  };
}

// —— تسويات ذمم العملاء (M4، العقد §4.8، E4.13–E4.15) ——

export interface AdjustmentDraftInput {
  customerId: string | null;
  kind: CustomerAdjustmentKind;
  amount: string;
  docDate: string;
  /** الشطب: تخصيص تلقائي بالأقدم فالأقدم (يُرسل autoAllocate وحده) */
  autoAllocate: boolean;
  /** الشطب اليدوي: الفاتورة ⇒ نص المبلغ (الفارغ = لا تخصيص لها) */
  allocations: Readonly<Record<string, string>>;
}

export interface AdjustmentCheckContext {
  decimals: number;
  /** اليوم بتوقيت الشركة */
  today: string;
  /** أول يوم تقبله التسويات (open-items.linkedFrom) */
  linkedFrom: string | null;
  /** فواتير العميل الآجلة المفتوحة بترتيب الخادم (تاريخ الفاتورة ثم المعرّف) */
  invoices: readonly Pick<OpenInvoiceView, 'invoiceId' | 'remaining'>[];
  debitBalance: number;
  creditBalance: number;
}

export interface AdjustmentProblemView { reason: string; invoiceId?: string }
export interface AdjustmentAllocation { invoiceId: string; amountMilli: bigint }

export interface AdjustmentCheck {
  problems: AdjustmentProblemView[];
  amountMilli: bigint | null;
  /** اليدوية الصالحة، أو معاينة التلقائي */
  allocations: AdjustmentAllocation[];
  allocatedMilli: bigint;
}

/** معاينة التخصيص التلقائي — planAllocations في الخادم: الأقدم فالأقدم، كلٌّ بحدّ متبقّيه، حتى يُستوفى المبلغ */
export function autoAllocationPreview(
  invoices: readonly Pick<OpenInvoiceView, 'invoiceId' | 'remaining'>[], amountMilli: bigint,
): { allocations: AdjustmentAllocation[]; leftMilli: bigint } {
  const allocations: AdjustmentAllocation[] = [];
  let left = amountMilli > 0n ? amountMilli : 0n;
  for (const inv of invoices) {
    if (left === 0n) break;
    const remaining = numberMilli(inv.remaining);
    if (remaining <= 0n) continue;
    const take = remaining < left ? remaining : left;
    allocations.push({ invoiceId: inv.invoiceId, amountMilli: take });
    left -= take;
  }
  return { allocations, leftMilli: left };
}

/**
 * تحقّق مستند التسوية قبل الإرسال (مرآة executeCreateAdjustment وplanAllocations): المبلغ ومنازله، والتاريخ بين بداية الربط
 * واليوم، والشطب ≤ الرصيد المدين ومخصَّصٌ بالضبط (Σ = المبلغ بالملّي، وكلٌّ ≤ متبقّي فاتورته)، والردّ ≤ الرصيد الدائن.
 */
export function adjustmentDraftCheck(d: AdjustmentDraftInput, ctx: AdjustmentCheckContext): AdjustmentCheck {
  const problems: AdjustmentProblemView[] = [];
  const add = (reason: string, invoiceId?: string) => problems.push(invoiceId ? { reason, invoiceId } : { reason });
  if (!d.customerId) add('CUSTOMER_REQUIRED');

  let amountMilli: bigint | null = null;
  const p = parseOpsAmount(d.amount, ctx.decimals, { required: true });
  if (!p.ok) add(p.reason === 'REQUIRED' ? 'AMOUNT_REQUIRED' : p.reason);
  else if (p.milli <= 0n) add('AMOUNT_NOT_POSITIVE');
  else amountMilli = p.milli;

  if (!isLocalDateText(d.docDate)) add('INVALID_DATE');
  else if (d.docDate > ctx.today) add('DOC_DATE_IN_FUTURE');
  else if (ctx.linkedFrom && d.docDate < ctx.linkedFrom) add('BEFORE_CUTOVER');

  let allocations: AdjustmentAllocation[] = [];
  let allocatedMilli = 0n;
  if (d.kind === 'BAD_DEBT_WRITEOFF') {
    if (amountMilli !== null && amountMilli > numberMilli(ctx.debitBalance)) add('WRITEOFF_EXCEEDS_DEBIT_BALANCE');
    if (d.autoAllocate) {
      if (amountMilli !== null) {
        const auto = autoAllocationPreview(ctx.invoices, amountMilli);
        allocations = auto.allocations;
        allocatedMilli = amountMilli - auto.leftMilli;
        if (auto.leftMilli > 0n) add('AUTO_INSUFFICIENT');
      }
    } else {
      const remainingOf = new Map(ctx.invoices.map(i => [i.invoiceId, numberMilli(i.remaining)]));
      for (const [invoiceId, text] of Object.entries(d.allocations)) {
        if (!text || !text.trim()) continue;
        const a = parseOpsAmount(text, ctx.decimals, { required: true });
        if (!a.ok) { add(a.reason === 'REQUIRED' ? 'INVALID_AMOUNT' : a.reason, invoiceId); continue; }
        if (a.milli <= 0n) { add('AMOUNT_NOT_POSITIVE', invoiceId); continue; }
        const remaining = remainingOf.get(invoiceId);
        if (remaining === undefined) { add('INVOICE_NOT_FOUND', invoiceId); continue; }
        if (a.milli > remaining) add('EXCEEDS_REMAINING', invoiceId);
        allocations.push({ invoiceId, amountMilli: a.milli });
        allocatedMilli += a.milli;
      }
      if (allocations.length === 0) add('ALLOCATIONS_REQUIRED');
      else if (amountMilli !== null && allocatedMilli !== amountMilli) add('SUM_MISMATCH');
    }
  } else if (amountMilli !== null && amountMilli > numberMilli(ctx.creditBalance)) {
    add('REFUND_EXCEEDS_CREDIT_BALANCE');
  }
  return { problems, amountMilli, allocations, allocatedMilli };
}

/** جسم POST /ledger/customer-adjustments من مسودة صالحة (null ما دامت فيها مشكلة) */
export function adjustmentRequestBody(
  d: AdjustmentDraftInput, c: AdjustmentCheck,
  extra: { counter?: WriteoffCounter; method?: RefundMethod; reference?: string; note?: string } = {},
): CreateCustomerAdjustmentInput | null {
  if (c.problems.length > 0 || c.amountMilli === null || !d.customerId) return null;
  const writeoff = d.kind === 'BAD_DEBT_WRITEOFF';
  const reference = extra.reference?.trim();
  const note = extra.note?.trim();
  return {
    customerId: d.customerId, kind: d.kind, amount: milliWire(c.amountMilli), docDate: d.docDate,
    ...(writeoff ? { counter: extra.counter ?? 'BAD_DEBT' } : { method: extra.method ?? 'CASH' }),
    ...(writeoff
      ? d.autoAllocate ? { autoAllocate: true } : { allocations: c.allocations.map(a => ({ invoiceId: a.invoiceId, amount: milliWire(a.amountMilli) })) }
      : {}),
    ...(reference ? { reference } : {}),
    ...(note ? { note } : {}),
  };
}

// —— شرح فرق عهدة المندوب (OD3) ——

/** مفتاح أحداث مصدر بند التفسير (لرابط «الأحداث») — null لبندٍ بلا مصدر مزامنة (الافتتاح، المصروف، مستند العجز) */
export function explainEventKey(kind: string, refId: string, amountMilli: string): string | null {
  switch (kind) {
    case 'ONLINE':
    case 'OUTSIDE':
    case 'CANCEL_REFUND_OUTSIDE': return `RECEIPT:${refId}`;
    case 'STAMPED_OUTSIDE':
    case 'CASH_INVOICE_CUSTODY': return `INVOICE:${refId}`;
    case 'SETTLEMENT_R': return `SETTLEMENT:${refId}`;
    // المسترد من العجز على الاستلام بند SHORTAGE سالب معرّفه الاستلام؛ والموجب مستند عجز
    case 'SHORTAGE': return /^-/.test(amountMilli) ? `SETTLEMENT:${refId}` : null;
    default: return null;
  }
}

/** اتساق التفسير: Σ البنود = totalMilli، والفرق (الشاشة − الأستاذ) = Σ البنود + الباقي، والباقي صفر */
export function explainConsistency(e: Pick<CustodyExplanationView, 'opsMilli' | 'ledgerMilli' | 'items' | 'totalMilli' | 'unexplainedMilli'>): {
  gapMilli: bigint; itemsMilli: bigint; unexplainedMilli: bigint; consistent: boolean;
} {
  const big = (v: string): bigint => { try { return BigInt(v); } catch { return 0n; } };
  const itemsMilli = e.items.reduce((s, i) => s + big(i.amountMilli), 0n);
  const gapMilli = big(e.opsMilli) - big(e.ledgerMilli);
  const unexplainedMilli = big(e.unexplainedMilli);
  return { gapMilli, itemsMilli, unexplainedMilli, consistent: itemsMilli === big(e.totalMilli) && gapMilli - itemsMilli === unexplainedMilli && unexplainedMilli === 0n };
}

// —— خريطة طرق الدفع (D3) ——

/**
 * اسم صفّ الخريطة: البطاقة وتوريد الأمانات بلا اسم مزوّد؛ المخصّصة باسم الشركة كما كتبته (لا tr)؛ المدمجة المسمّاة باسمها؛
 * وإلا الافتراضي مترجماً (قاعدة الاسم في lib/paymentMethodsConfig).
 */
export function methodMapRowLabel(m: Pick<PaymentMethodMapRow, 'methodKey' | 'label' | 'custom'>, tr: Tr): string {
  if (m.methodKey === 'CARD') return tr('الدفع بالبطاقة');
  if (m.methodKey === 'PAYOUT') return tr('توريد أمانات الدفع الإلكتروني');
  if (m.custom) return m.label || m.methodKey;
  const def = (DEFAULT_METHOD_LABELS as Readonly<Record<string, string>>)[m.methodKey];
  if (m.label && def && m.label !== def) return m.label;
  return defaultMethodLabel(m.methodKey, tr);
}

/** الحسابات التي يقبلها PUT للطريقة: نشط، نقد أو أصل متداول، غير رئيسي، وليس المعلّق 911001 ولا أمانات 112005 */
export const METHOD_MAP_FORBIDDEN_CODES: readonly string[] = ['911001', '112005'];
export function methodAccountCandidates<A extends { code: string; type: string; controlKind: string | null; isActive: boolean }>(accounts: readonly A[]): A[] {
  return accounts.filter(a => a.isActive && (a.type === 'asset_cash' || a.type === 'asset_current') && a.controlKind === null
    && !METHOD_MAP_FORBIDDEN_CODES.includes(a.code));
}

/** دفاتر الطريقة المقبولة: نشطة، ليست مبيعات ولا مشتريات */
export function methodJournalCandidates<J extends { type: string; isActive: boolean }>(journals: readonly J[]): J[] {
  return journals.filter(j => j.isActive && j.type !== 'SALE' && j.type !== 'PURCHASE');
}
