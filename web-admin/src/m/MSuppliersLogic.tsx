import { roundHalfUp } from '../lib/money';

/**
 * «الموردون» في تطبيق الإدارة (`/m`) — المنطق الصرف بلا React ولا شبكة، يُختبر وحده (f4-suppliers.test.ts).
 *
 * لماذا وحدةٌ مستقلّة: سند الصرف مالٌ يخرج من الصندوق، وتخصيصه على فواتير المورّد يقرّر أيّها يُسدَّد. وكلّ قرارٍ رقميّ هنا
 * (التقريب، والتخصيص التلقائي على الأقدم، وحدود التخصيص اليدوي) نسخةٌ من قاعدة الخادم (services/suppliers/payments.ts):
 *  · المبالغ تُحسب **بالملّي الصحيح** (١/١٠٠٠) بعد تقريبها نصف-لأعلى إلى منازل العملة — كـtoMilliAmount حرفاً. الجمع بالعائمة
 *    كان سيقبل هنا تخصيصاً يزيد على المتبقّي بغبارٍ عشريّ فيردّه الخادم ٤٠٩.
 *  · التلقائي يمرّ على الفواتير **بترتيب الخادم نفسه** (الأقدم استحقاقاً أولاً كما يعيدها open-bills) — المعاينة هي ما سيُكتب.
 *  · الزائد على الفواتير يبقى دفعةً مقدّمة غير مخصَّصة (رصيدٌ مدين للمورّد) — لا يُرفض ولا يُوزَّع قسراً.
 */

// ═══ الطرق والأنواع ═══

export type PayMethod = 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'REP_CUSTODY';
export const PAY_METHODS: readonly PayMethod[] = ['CASH', 'BANK_TRANSFER', 'CHEQUE', 'REP_CUSTODY'];

/** أسماء الطرق كما تُعرض وتُطبع — «نقدي» صريحٌ بمصدره: السند يُخرج المال من صندوق الشركة لا من يد أحد */
export const PAY_METHOD_LABELS: Record<PayMethod, string> = {
  CASH: 'نقدي من الصندوق',
  BANK_TRANSFER: 'تحويل بنكي',
  CHEQUE: 'شيك',
  REP_CUSTODY: 'عهدة مندوب',
};

export function isPayMethod(m: unknown): m is PayMethod {
  return typeof m === 'string' && (PAY_METHODS as readonly string[]).includes(m);
}

/** اسم الطريقة — والمجهول (طريقةٌ أحدث من الواجهة) يُعرض برمزه لا يُخفى */
export function payMethodLabel(m: string | null | undefined): string {
  return isPayMethod(m) ? PAY_METHOD_LABELS[m] : (m || '—');
}

/** خانة المرجع تُسمّى بما يكتبه المستخدم فيها فعلاً */
export function referenceLabel(m: PayMethod | ''): string {
  return m === 'CHEQUE' ? 'رقم الشيك' : m === 'BANK_TRANSFER' ? 'مرجع التحويل' : 'المرجع';
}

/**
 * أنواع قيود كشف المورّد السبعة كما يكتبها الخادم (SUPPLIER_LEDGER_KINDS). الإشارة في الكشف: الدائن يزيد المستحقّ للمورّد
 * (فاتورة، عكس سند، استرداد)، والمدين ينقصه (سند، مرتجع، عكس فاتورة). والمجهول يُعرض برمزه بلونٍ محايد — لا يُسقط من الكشف.
 */
export type LedgerTone = 'bill' | 'pay' | 'return' | 'reverse' | 'refund' | 'opening' | 'other';
export const LEDGER_KINDS: Record<string, { label: string; tone: LedgerTone }> = {
  BILL: { label: 'فاتورة مورد', tone: 'bill' },
  BILL_REV: { label: 'إلغاء فاتورة مورد', tone: 'reverse' },
  PAYMENT: { label: 'سند صرف', tone: 'pay' },
  PAYMENT_REV: { label: 'إلغاء سند صرف', tone: 'reverse' },
  RETURN: { label: 'مرتجع للمورد', tone: 'return' },
  REFUND_IN: { label: 'استرداد نقدي من المورد', tone: 'refund' },
  OPENING: { label: 'رصيد افتتاحي', tone: 'opening' },
};

export function ledgerKindOf(kind: string): { label: string; tone: LedgerTone } {
  return LEDGER_KINDS[kind] ?? { label: kind, tone: 'other' };
}

/** القيد يفتح سنده (السند أو عكسه) — وغيره لا */
export function lineOpensPayment(line: { kind: string; supplierPaymentId: string | null }): boolean {
  return !!line.supplierPaymentId && (line.kind === 'PAYMENT' || line.kind === 'PAYMENT_REV');
}

// ═══ الملّي ═══

const decOf = (d: number): number => (Number.isFinite(d) ? Math.min(3, Math.max(0, Math.trunc(d))) : 2);

/** مبلغ ⇐ ملّي صحيح بعد تقريبه نصف-لأعلى إلى منازل العملة — كـtoMilliAmount في الخادم حرفاً. غير المنتهي ⇒ NaN */
export function toMilli(x: number, decimals: number): number {
  if (!Number.isFinite(x)) return NaN;
  return Math.round(roundHalfUp(x, decOf(decimals)) * 1000);
}

export const fromMilli = (m: number): number => m / 1000;

/** الأرقام الهندية والفارسية وفاصلتها العشرية ⇐ لاتينية — لوحة مفاتيحٍ عربية تكتبها في الخانة */
function latinDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.');
}

/**
 * نصّ خانة مبلغ ⇐ رقمٌ مقرَّب إلى منازل العملة، أو null لغير الصالح. `allowZero` لخانة التخصيص (الصفر = لا تخصيص).
 * لا فواصل آلاف ولا علامات: «1,5» تُرفض لا تُقرأ ١٥ ولا ١٫٥ — الخانة رقميّة، والغموض في المال لا يُخمَّن.
 */
export function parseAmount(text: string | number | null | undefined, decimals: number, allowZero = false): number | null {
  if (text == null) return null;
  const s = latinDigits(String(text)).trim();
  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const m = toMilli(n, decimals);
  if (m < 0 || (!allowZero && m === 0)) return null;
  return fromMilli(m);
}

// ═══ الرصيد ═══

export type BalanceState = 'owed' | 'advance' | 'settled';

/** رصيد المورّد: موجبٌ = مستحقٌّ له علينا، وسالبٌ = دفعنا مقدّماً (رصيدٌ مدين له)، والصفر بعد التقريب = مسدَّد */
export function balanceState(balance: number, decimals: number): { state: BalanceState; amount: number } {
  const m = toMilli(Number(balance) || 0, decimals);
  return { state: m > 0 ? 'owed' : m < 0 ? 'advance' : 'settled', amount: fromMilli(Math.abs(m)) };
}

export const BALANCE_LABELS: Record<BalanceState, string> = {
  owed: 'مستحق للمورد',
  advance: 'رصيد مدين للمورد دفعة مقدمة',
  settled: 'الحساب مسدد',
};

// ═══ التخصيص ═══

export interface BillLike { warehouseEntryId: string; outstanding: number }
export interface Allocation { warehouseEntryId: string; amount: number }

/**
 * معاينة التخصيص التلقائي — نسخة autoAllocate في الخادم: على الفواتير بترتيبها (الأقدم استحقاقاً أولاً كما يعيدها open-bills)،
 * لكلٍّ الأصغر من متبقّيها وما بقي من المبلغ، والزائد دفعة مقدّمة.
 */
export function autoAllocation(bills: readonly BillLike[], amount: number, decimals: number): {
  allocations: Allocation[]; allocated: number; unapplied: number;
} {
  let left = toMilli(amount, decimals);
  if (!(left > 0)) return { allocations: [], allocated: 0, unapplied: 0 };
  const total = left;
  const allocations: Allocation[] = [];
  for (const b of bills) {
    if (left <= 0) break;
    const room = toMilli(b.outstanding, decimals);
    if (!(room > 0)) continue;
    const take = Math.min(room, left);
    allocations.push({ warehouseEntryId: b.warehouseEntryId, amount: fromMilli(take) });
    left -= take;
  }
  return { allocations, allocated: fromMilli(total - left), unapplied: fromMilli(left) };
}

export interface ManualAllocationCheck {
  /** ما سيُرسل: الفواتير المفتوحة الحالية ذات مبلغٍ موجب وحدها */
  allocations: Allocation[];
  allocated: number;
  /** ما يبقى من المبلغ بلا فاتورة — دفعة مقدّمة */
  unapplied: number;
  /** فواتير خانتها ليست مبلغاً */
  invalid: string[];
  /** فواتير خُصّص لها أكثر من متبقّيها */
  overBill: string[];
  /** المجموع أكبر من مبلغ السند */
  overAmount: boolean;
}

/**
 * التخصيص اليدوي كما سيتحقّق منه الخادم: لكل فاتورة ≤ متبقّيها، وΣ ≤ المبلغ، والصفر والفارغ لا تخصيص. خانةٌ لفاتورةٍ لم تعد
 * مفتوحة (سُدّدت من جهازٍ آخر بين الجلبين) تسقط — لا تُرسل فاتورةٌ لا يراها المستخدم في القائمة.
 */
export function checkManualAllocation(
  bills: readonly BillLike[], alloc: Readonly<Record<string, string>>, amount: number | null, decimals: number,
): ManualAllocationCheck {
  const amountM = amount != null ? toMilli(amount, decimals) : 0;
  const allocations: Allocation[] = [];
  const invalid: string[] = [];
  const overBill: string[] = [];
  let sum = 0;
  for (const b of bills) {
    const raw = alloc[b.warehouseEntryId];
    if (raw == null || String(raw).trim() === '') continue;
    const v = parseAmount(raw, decimals, true);
    if (v == null) { invalid.push(b.warehouseEntryId); continue; }
    const m = toMilli(v, decimals);
    if (m === 0) continue;
    if (m > toMilli(b.outstanding, decimals)) overBill.push(b.warehouseEntryId);
    allocations.push({ warehouseEntryId: b.warehouseEntryId, amount: fromMilli(m) });
    sum += m;
  }
  const overAmount = sum > Math.max(0, amountM);
  return {
    allocations,
    allocated: fromMilli(sum),
    unapplied: fromMilli(Math.max(0, amountM - sum)),
    invalid, overBill, overAmount,
  };
}

// ═══ نموذج سند الصرف ═══

export type AllocMode = 'auto' | 'manual';

export interface PaymentDraft {
  supplierId: string;
  amountText: string;
  method: PayMethod | '';
  salesRepId: string;
  paidAt: string;
  reference: string;
  note: string;
  mode: AllocMode;
  alloc: Record<string, string>;
}

export type DraftProblem = 'AMOUNT' | 'METHOD' | 'REP' | 'DATE' | 'BILLS' | 'ALLOC_INVALID' | 'ALLOC_OVER_BILL' | 'ALLOC_OVER_AMOUNT';

export const DRAFT_PROBLEMS: Record<DraftProblem, string> = {
  AMOUNT: 'اكتب مبلغ السند',
  METHOD: 'اختر طريقة الدفع',
  REP: 'اختر المندوب الذي دفع من عهدته',
  DATE: 'تاريخ السند غير صالح',
  BILLS: 'انتظر تحميل الفواتير المفتوحة',
  ALLOC_INVALID: 'مبلغ التخصيص غير صالح',
  ALLOC_OVER_BILL: 'مبلغ التخصيص أكبر من المتبقي على الفاتورة',
  ALLOC_OVER_AMOUNT: 'مجموع التخصيص أكبر من مبلغ السند',
};

/** 'YYYY-MM-DD' ليومٍ حقيقيّ (لا ٣١ فبراير) */
export function isDay(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** «اليوم» بتقويم الجهاز — لا toISOString (UTC) التي تعطي الأمس في الرياض قبل الثالثة فجراً */
export function localDay(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * ما يمنع الإرسال — بالترتيب الذي يُقرأ به النموذج. `bills` null = الفواتير لم تصل بعد (أو تعذّرت): التلقائي لا يحتاجها (الخادم
 * يخصّص بنفسه)، أمّا اليدوي فيُوقَف حتى تصل — وإلّا أُرسل تخصيصٌ على قائمةٍ لم يرها المستخدم.
 */
export function paymentProblems(draft: PaymentDraft, bills: readonly BillLike[] | null, decimals: number): DraftProblem[] {
  const out: DraftProblem[] = [];
  const amount = parseAmount(draft.amountText, decimals);
  if (amount == null) out.push('AMOUNT');
  if (!isPayMethod(draft.method)) out.push('METHOD');
  else if (draft.method === 'REP_CUSTODY' && !draft.salesRepId) out.push('REP');
  if (!isDay(draft.paidAt)) out.push('DATE');
  if (draft.mode === 'manual') {
    if (bills == null) out.push('BILLS');
    else {
      const c = checkManualAllocation(bills, draft.alloc, amount, decimals);
      if (c.invalid.length) out.push('ALLOC_INVALID');
      if (c.overBill.length) out.push('ALLOC_OVER_BILL');
      if (c.overAmount) out.push('ALLOC_OVER_AMOUNT');
    }
  }
  return out;
}

export interface PaymentBody {
  supplierId: string;
  amount: number;
  method: PayMethod;
  salesRepId?: string;
  paidAt: string;
  reference?: string;
  note?: string;
  allocations?: Allocation[];
  autoAllocate: boolean;
}

/**
 * جسم POST /supplier-payments (بلا clientRef — يُضاف مفتاح المحاولة عند الإرسال). null حين يمنع الإرسال شيء.
 *  · المندوب يُرسل للعهدة وحدها: مندوبٌ بقي مختاراً من طريقةٍ سابقة لا يُلصق بسندٍ نقديّ.
 *  · التلقائي: autoAllocate بلا تخصيص صريح (الخادم يخصّص بترتيبه). اليدوي: التخصيص كما كُتب و`autoAllocate:false` صراحةً —
 *    فما لم يُخصَّص يبقى دفعةً مقدّمة ولا يوزّعه الخادم على ما لم يختره المستخدم.
 */
export function paymentBody(draft: PaymentDraft, bills: readonly BillLike[] | null, decimals: number): PaymentBody | null {
  if (paymentProblems(draft, bills, decimals).length) return null;
  const amount = parseAmount(draft.amountText, decimals) as number;
  const method = draft.method as PayMethod;
  const reference = draft.reference.trim();
  const note = draft.note.trim();
  return {
    supplierId: draft.supplierId,
    amount,
    method,
    ...(method === 'REP_CUSTODY' && { salesRepId: draft.salesRepId }),
    paidAt: draft.paidAt,
    ...(reference && { reference }),
    ...(note && { note }),
    ...(draft.mode === 'manual'
      ? { allocations: checkManualAllocation(bills ?? [], draft.alloc, amount, decimals).allocations, autoAllocate: false }
      : { autoAllocate: true }),
  };
}

// ═══ السند ═══

export interface PaymentLike {
  amount: number;
  status: string;
  autoForEntryId?: string | null;
  allocations?: readonly { amount: number }[] | null;
}

/**
 * يُلغى من هنا السند الساري اليدويّ وحده: الملغى لا يُلغى ثانية، والسند الآلي لاستلامٍ نقديّ يُلغى بإلغاء حركة الاستلام
 * (409 AUTO_PAYMENT_CANCEL_VIA_ENTRY) — زرٌّ يُفضي إلى رفضٍ مؤكَّد أسوأ من غيابه مع سببه.
 */
export function canCancelPayment(p: Pick<PaymentLike, 'status' | 'autoForEntryId'>): boolean {
  return p.status === 'POSTED' && !p.autoForEntryId;
}

/** ما لم يُخصَّص من السند لفاتورة — دفعة مقدّمة (لا يقلّ عن صفر) */
export function paymentUnapplied(p: Pick<PaymentLike, 'amount' | 'allocations'>, decimals: number): number {
  const total = toMilli(Number(p.amount) || 0, decimals);
  const used = (p.allocations ?? []).reduce((s, a) => s + toMilli(Number(a.amount) || 0, decimals), 0);
  return fromMilli(Math.max(0, total - used));
}

// ═══ ملخّص القائمة من تقرير الأعمار ═══

export interface AgingRowLike {
  balance?: number | null;
  total?: number | null;
  d1_30?: number | null; d31_60?: number | null; d61_90?: number | null; d90_plus?: number | null;
}

/**
 * أرقام رأس القائمة: المستحقّ للموردين (Σ الأرصدة الموجبة)، والدفعات المقدّمة (Σ السالبة بقيمتها)، ومتأخّر السداد (شرائح ما بعد
 * الاستحقاق). لا تُصافى الأرصدة: دفعةٌ مقدّمة لمورّد لا تُنقص ما ندين به لغيره. وصفٌّ بلا رصيد (خادمٌ بالعقد المختصر) يُقرأ
 * بمتبقّي فواتيره.
 */
export function agingSummary(rows: readonly AgingRowLike[], decimals: number): { owed: number; advance: number; overdue: number } {
  let owed = 0;
  let advance = 0;
  let overdue = 0;
  const m = (v: number | null | undefined) => toMilli(Number(v) || 0, decimals);
  for (const r of rows) {
    const bal = r.balance != null ? m(r.balance) : m(r.total);
    if (bal > 0) owed += bal; else advance -= bal;
    overdue += m(r.d1_30) + m(r.d31_60) + m(r.d61_90) + m(r.d90_plus);
  }
  return { owed: fromMilli(owed), advance: fromMilli(advance), overdue: fromMilli(overdue) };
}

/** Σ متبقّي الفواتير المفتوحة ومتأخّرها — لبطاقة المورّد */
export function openBillsTotals(bills: readonly (BillLike & { daysOverdue?: number })[], decimals: number): { outstanding: number; overdue: number; overdueCount: number } {
  let out = 0;
  let late = 0;
  let n = 0;
  for (const b of bills) {
    const v = toMilli(Number(b.outstanding) || 0, decimals);
    out += v;
    if ((b.daysOverdue ?? 0) > 0) { late += v; n += 1; }
  }
  return { outstanding: fromMilli(out), overdue: fromMilli(late), overdueCount: n };
}

// ═══ الأخطاء ═══

/** رموز الخادم ⇐ نصٌّ مترجَم: الرمز يغلب رسالة الخادم (الرسالة عربيةٌ لا ترجمة لها في القاموس) */
export const SUPPLIER_ERROR_TEXT: Record<string, string> = {
  SUPPLIER_PAYMENT_INVALID: 'بيانات سند الصرف غير صالحة',
  ALLOCATION_EXCEEDS_OUTSTANDING: 'مبلغ التخصيص أكبر من المتبقي على الفاتورة',
  AUTO_PAYMENT_CANCEL_VIA_ENTRY: 'سند الصرف الآلي لاستلام نقدي يلغى بإلغاء حركة الاستلام من المستودع',
  SUPPLIER_PAYMENT_ALREADY_CANCELLED: 'السند ملغى مسبقا',
  SUPPLIER_PAYMENT_NOT_FOUND: 'السند غير موجود',
  SUPPLIER_NOT_FOUND: 'المورد غير موجود',
  CLIENT_REF_REUSED: 'تعارض في مرجع الإرسال أعد المحاولة',
};

/** رمز الخطأ من ردّ الخادم */
export function supplierErrorCode(e: unknown): string | null {
  const c = (e as { response?: { data?: { code?: unknown } } } | null | undefined)?.response?.data?.code;
  return typeof c === 'string' && c ? c : null;
}

/**
 * نصّ الخطأ للمستخدم: رمزٌ معروف ⇐ نصّه المترجَم، وإلّا رسالة الخادم (تُفهم: «الفاتورة لمورّد آخر»)، وإلّا البديل.
 * والمُعاد مفتاحٌ يمرّ على tr() عند العرض.
 */
export function supplierErrorMessage(e: unknown, fallback: string): string {
  const code = supplierErrorCode(e);
  if (code && SUPPLIER_ERROR_TEXT[code]) return SUPPLIER_ERROR_TEXT[code];
  const msg = (e as { response?: { data?: { message?: unknown } } } | null | undefined)?.response?.data?.message;
  return typeof msg === 'string' && msg.trim() ? msg : fallback;
}
