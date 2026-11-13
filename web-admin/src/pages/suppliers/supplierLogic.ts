/**
 * منطق صفحة «الموردون» الصِّرف («ربط الدفاتر» L1، طلب المالك ١٣ نوفمبر ٢٠٢٦) — بلا React ولا شبكة، فيُختبر وحده
 * (f3-supplierLogic.test.ts). الحساب كله **بالملّي الصحيح** (المبلغ × ١٠٠٠) كما يحسب الخادم بـBigInt: جمع الكسور العشرية
 * بالعائم يُنتج 0.30000000000000004 فيظهر «متبقٍّ» وهميّ أو يُرفض تخصيصٌ يساوي المتبقّي تماماً.
 *
 * دلالة الكشف (services/suppliers/core.ts): الموجب مستحقٌّ للمورّد علينا. الدائن يزيده (فاتورة/إلغاء سند/استرداد)،
 * والمدين يُنقصه (سند صرف/مرتجع/عكس فاتورة). رصيدٌ سالب = دفعةٌ مقدَّمة للمورّد (مدين).
 */
import { roundHalfUp } from '../../lib/money';
import type { ExcelSheet } from '../../utils/excel';
import type {
  OpenBill, Supplier, SupplierAging, SupplierAgingRow, SupplierInput, SupplierPaymentInput, SupplierPaymentMethod, SupplierPaymentView,
  SupplierStatement, SupplierUpdateInput,
} from '../../api/suppliers';

export type Tr = (ar: string) => string;

// ═══ الملّي ═══

/** مبلغ ⇐ ملّي صحيح بتقريب نصف-لأعلى إلى منازل العملة — مرآة toMilliAmount في الخادم */
export function toMilli(x: number, decimals: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(roundHalfUp(x, decimals) * 1000);
}

/** ملّي ⇐ مبلغ للعرض والإرسال */
export function fromMilli(m: number): number {
  return m / 1000;
}

/** مجموع مبالغٍ وصلت من الخادم (أرقام بوحدة العملة) — بالملّي فلا غبار عائم */
export function sumAmounts(values: readonly (number | null | undefined)[]): number {
  let s = 0;
  for (const v of values) s += Math.round((Number(v) || 0) * 1000);
  return fromMilli(s);
}

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** يطبّع ما يكتبه المستخدم: الأرقام العربية والفارسية، والفاصلة العربية والإنجليزية فاصلةً عشرية، وفواصل الآلاف «٬» تُحذف */
export function normalizeNumberText(raw: string): string {
  return raw
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[٬\s]/g, '')
    .replace(/[,٫]/g, '.')
    .trim();
}

export type AmountParse = { ok: true; value: number; milli: number } | { ok: false; reason: 'EMPTY' | 'INVALID' | 'DECIMALS' };

/**
 * مبلغٌ مكتوب ⇐ رقم وملّي. منازلٌ أكثر من منازل العملة **تُرفض** لا تُقرَّب: المحاسب كتب 10.005 ريالاً فلا نصرف 10.01
 * دون أن يعلم. السالب والصفر مقبولان هنا والحكم عليهما للمتصل (التخصيص يقبل الصفر، والسند لا).
 */
export function parseAmount(raw: string | null | undefined, decimals: number): AmountParse {
  const t = normalizeNumberText(String(raw ?? ''));
  if (!t) return { ok: false, reason: 'EMPTY' };
  const m = /^(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) return { ok: false, reason: 'INVALID' };
  if ((m[2]?.length ?? 0) > decimals) return { ok: false, reason: 'DECIMALS' };
  const value = Number(t);
  if (!Number.isFinite(value)) return { ok: false, reason: 'INVALID' };
  return { ok: true, value, milli: toMilli(value, decimals) };
}

/** نصّ المبلغ لخانة إدخال بمنازل العملة بلا فواصل آلاف (10 ⇒ "10.00") */
export function amountInputText(v: number, decimals: number): string {
  return roundHalfUp(Number(v) || 0, decimals).toFixed(decimals);
}

// ═══ الأيام ═══

/** يوم 'YYYY-MM-DD' صالحٌ تقويمياً */
export function isValidDay(s: string | null | undefined): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** الفترة الافتراضية لكشف المورّد: من أول السنة حتى اليوم — ما يطلبه المحاسب للمطابقة السنوية */
export function defaultStatementPeriod(today: string): { from: string; to: string } {
  const y = isValidDay(today) ? today.slice(0, 4) : String(new Date().getFullYear());
  return { from: `${y}-01-01`, to: isValidDay(today) ? today : `${y}-12-31` };
}

/** «من» بعد «إلى» ⇒ الفترة مقلوبة فلا يُطلب الكشف */
export function periodInverted(from: string, to: string): boolean {
  return isValidDay(from) && isValidDay(to) && from > to;
}

// ═══ الرصيد ═══

export type BalanceSide = 'PAYABLE' | 'ADVANCE' | 'ZERO';

/** جهة الرصيد: مستحقٌّ للمورّد، أو دفعةٌ مقدَّمة له، أو صفر (بعد التقريب إلى الملّي) */
export function balanceSide(balance: number | null | undefined): BalanceSide {
  const m = Math.round((Number(balance) || 0) * 1000);
  return m > 0 ? 'PAYABLE' : m < 0 ? 'ADVANCE' : 'ZERO';
}

// ═══ التسميات (تمرّ بـtr في الواجهة) ═══

export const STATEMENT_KIND_LABELS: Record<string, string> = {
  OPENING: 'رصيد افتتاحي',
  BILL: 'فاتورة مورد',
  BILL_REV: 'عكس فاتورة مورد',
  PAYMENT: 'سند صرف',
  PAYMENT_REV: 'إلغاء سند صرف',
  RETURN: 'مرتجع للمورد',
  REFUND_IN: 'استرداد نقدي من المورد',
};

/** نوعٌ لا تعرفه الواجهة (خادمٌ أحدث) يُعرض برمزه لا يُخفى سطره */
export function statementKindLabel(kind: string): string {
  return STATEMENT_KIND_LABELS[kind] ?? kind;
}

export const SUPPLIER_PAYMENT_METHODS: readonly SupplierPaymentMethod[] = ['CASH', 'BANK_TRANSFER', 'CHEQUE', 'REP_CUSTODY'];
export const PAYMENT_METHOD_LABELS: Record<SupplierPaymentMethod, string> = {
  CASH: 'نقدي من الصندوق',
  BANK_TRANSFER: 'تحويل بنكي',
  CHEQUE: 'شيك',
  REP_CUSTODY: 'من عهدة مندوب',
};
export function paymentMethodLabel(m: string): string {
  return (PAYMENT_METHOD_LABELS as Record<string, string>)[m] ?? m;
}

/** وسم مرجع الدفع بحسب الطريقة — رقم الشيك أو رقم الحوالة */
export function referenceLabel(m: SupplierPaymentMethod | string): string {
  return m === 'CHEQUE' ? 'رقم الشيك' : m === 'BANK_TRANSFER' ? 'رقم الحوالة' : 'المرجع';
}

/** مدة السداد للعرض: فوري للصفر، و«بلا مدة» لغيابها */
export function paymentDaysText(days: number | null | undefined, tr: Tr): string {
  if (days == null) return tr('بلا مدة');
  if (days === 0) return tr('فوري');
  return `${days} ${tr('يوم')}`;
}

// ═══ رسائل الخادم بالرمز ═══

/** نصوص رموز الخادم (تمرّ بـtr) — SUPPLIER_PAYMENT_INVALID رسالته من الخادم أدقّ فلا تُستبدل */
export const SUPPLIER_ERROR_TEXT: Record<string, string> = {
  SUPPLIER_CODE_EXISTS: 'رمز المورد مستعمل لمورد آخر',
  SUPPLIER_VAT_EXISTS: 'الرقم الضريبي مسجل لمورد آخر',
  SUPPLIER_HAS_HISTORY: 'للمورد حركات أو قيود أو دفعات فلا يحذف أرشفه بدلا من الحذف',
  SUPPLIER_NOT_FOUND: 'المورد غير موجود',
  SUPPLIER_PAYMENT_NOT_FOUND: 'سند الصرف غير موجود',
  ALLOCATION_EXCEEDS_OUTSTANDING: 'مبلغ التخصيص أكبر من المتبقي على الفاتورة',
  CLIENT_REF_REUSED: 'تعذر حفظ السند لتعارض في مرجع الإرسال أعد فتح النافذة وحاول مجددا',
  SUPPLIER_PAYMENT_ALREADY_CANCELLED: 'سند الصرف ملغى من قبل',
  AUTO_PAYMENT_CANCEL_VIA_ENTRY: 'هذا سند آلي لشراء نقدي ويلغى بإلغاء حركة الشراء من مخزون الشركة',
  AUTO_PAYMENT_EXISTS: 'للحركة سند صرف آلي قائم',
};

export function serverCodeOf(e: unknown): string | null {
  const c = (e as { response?: { data?: { code?: unknown } } } | null | undefined)?.response?.data?.code;
  return typeof c === 'string' && c ? c : null;
}

/** نصّ الخطأ للعرض (قبل tr): نصّ الرمز المعروف، وإلا رسالة الخادم، وإلا البديل */
export function supplierErrorText(e: unknown, fallback: string): string {
  const code = serverCodeOf(e);
  if (code && SUPPLIER_ERROR_TEXT[code]) return SUPPLIER_ERROR_TEXT[code];
  const m = (e as { response?: { data?: { message?: unknown } } } | null | undefined)?.response?.data?.message;
  return typeof m === 'string' && m.trim() ? m : fallback;
}

// ═══ نموذج المورّد ═══

export const SUPPLIER_NAME_MAX = 120;
export const PAYMENT_DAYS_MAX = 365;

/** حدود الخانات في النموذج (maxLength) — الخادم هو الحَكَم، وهذه تمنع الإدخال العبثي قبل الإرسال */
export const SUPPLIER_FIELD_MAX = {
  name: SUPPLIER_NAME_MAX, nameEn: 120, code: 40, vatNumber: 30, crNumber: 30, phone: 30, email: 120,
  city: 80, address: 250, iban: 42, bankName: 120, notes: 1000,
} as const;

export interface SupplierDraft {
  name: string; nameEn: string; code: string; vatNumber: string; crNumber: string; phone: string; email: string;
  address: string; city: string; iban: string; bankName: string; paymentDays: string; notes: string;
}

const TEXT_FIELDS = ['name', 'nameEn', 'code', 'vatNumber', 'crNumber', 'phone', 'email', 'address', 'city', 'iban', 'bankName', 'notes'] as const;
type TextField = (typeof TEXT_FIELDS)[number];

export function draftOfSupplier(s?: Partial<Supplier> | null): SupplierDraft {
  const v = (x: string | null | undefined) => (typeof x === 'string' ? x : '');
  return {
    name: v(s?.name), nameEn: v(s?.nameEn), code: v(s?.code), vatNumber: v(s?.vatNumber), crNumber: v(s?.crNumber),
    phone: v(s?.phone), email: v(s?.email), address: v(s?.address), city: v(s?.city), iban: v(s?.iban),
    bankName: v(s?.bankName), paymentDays: s?.paymentDays == null ? '' : String(s.paymentDays), notes: v(s?.notes),
  };
}

/** الآيبان بلا مسافات وبحروفٍ كبيرة — كما يُطبع على الشيك وكشف البنك */
export function normalizeIban(raw: string): string {
  return normalizeNumberText(raw).replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

/** صحّة الآيبان (ISO 13616): البنية ثم باقي القسمة على ٩٧ = ١ — يمسك خطأ رقمٍ واحد أو تبديل رقمين متجاورين */
export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  if (iban.startsWith('SA') && iban.length !== 24) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const code = ch.charCodeAt(0);
    const digits = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

/** مدة السداد: فارغة ⇒ null، وإلا عددٌ صحيح ٠..٣٦٥ — غير ذلك ⇒ undefined (غير صالحة) */
export function parsePaymentDays(raw: string): number | null | undefined {
  const t = normalizeNumberText(raw);
  if (!t) return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n <= PAYMENT_DAYS_MAX ? n : undefined;
}

export type SupplierProblem = 'NAME_REQUIRED' | 'NAME_TOO_LONG' | 'PAYMENT_DAYS_INVALID' | 'EMAIL_INVALID' | 'IBAN_INVALID';
export const SUPPLIER_PROBLEM_TEXT: Record<SupplierProblem, string> = {
  NAME_REQUIRED: 'اسم المورد مطلوب',
  NAME_TOO_LONG: 'اسم المورد أطول من 120 حرفا',
  PAYMENT_DAYS_INVALID: 'مدة السداد عدد أيام صحيح من 0 إلى 365',
  EMAIL_INVALID: 'البريد الإلكتروني غير صحيح',
  IBAN_INVALID: 'رقم الآيبان غير صحيح راجع الأرقام',
};

export function supplierProblem(d: SupplierDraft): SupplierProblem | null {
  const name = d.name.trim();
  if (!name) return 'NAME_REQUIRED';
  if (name.length > SUPPLIER_NAME_MAX) return 'NAME_TOO_LONG';
  if (parsePaymentDays(d.paymentDays) === undefined) return 'PAYMENT_DAYS_INVALID';
  const email = d.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'EMAIL_INVALID';
  if (d.iban.trim() && !isValidIban(d.iban)) return 'IBAN_INVALID';
  return null;
}

/** قيمة الخانة كما تُرسل: نصٌّ مقصوص، والآيبان مطبَّعاً، والفارغ ⇒ null */
function fieldValue(d: SupplierDraft, k: TextField): string | null {
  const t = k === 'iban' ? normalizeIban(d.iban) : d[k].trim();
  return t ? t : null;
}

/** جسم الإنشاء: الاسم وما كُتب فقط — الفارغ لا يُرسل */
export function supplierCreateBody(d: SupplierDraft): SupplierInput {
  const body: SupplierInput = { name: d.name.trim() };
  for (const k of TEXT_FIELDS) {
    if (k === 'name') continue;
    const v = fieldValue(d, k);
    if (v != null) (body as unknown as Record<string, unknown>)[k] = v;
  }
  const days = parsePaymentDays(d.paymentDays);
  if (typeof days === 'number') body.paymentDays = days;
  return body;
}

/**
 * جسم التعديل: **ما تغيّر وحده** — والممسوح null صريحاً فيُمسح في الخادم. خانةٌ لم تُلمس لا تُرسل، فلا يُعاد كتابة ما لا تراه
 * الشاشة (الرقم الضريبي مخفيّ في شركة «بلا ضريبة» فيبقى كما هو).
 */
export function supplierUpdateBody(d: SupplierDraft, original: Partial<Supplier>): SupplierUpdateInput {
  const body: SupplierUpdateInput = {};
  const before = draftOfSupplier(original);
  for (const k of TEXT_FIELDS) {
    const now = fieldValue(d, k);
    const was = fieldValue(before, k);
    if (now !== was) {
      if (k === 'name') { if (now) body.name = now; continue; }
      (body as Record<string, unknown>)[k] = now;
    }
  }
  const days = parsePaymentDays(d.paymentDays);
  const wasDays = original.paymentDays ?? null;
  if (days !== undefined && days !== wasDays) body.paymentDays = days;
  return body;
}

// ═══ سند الصرف: التخصيص ═══

export type AllocationMode = 'AUTO' | 'MANUAL' | 'NONE';

export interface PlanBill { warehouseEntryId: string; outstanding: number }
export interface AllocationPlan {
  lines: { warehouseEntryId: string; milli: number }[];
  allocatedMilli: number;
  /** ما بقي من المبلغ بلا تخصيص — دفعةٌ مقدَّمة للمورّد (رصيد مدين) */
  unappliedMilli: number;
}

/**
 * خطّة التخصيص للمعاينة — مرآة createSupplierPaymentTx: التلقائي على الفواتير **بترتيبها** (open-bills يردّها الأقدم استحقاقاً
 * أولاً بـcompareByDue) بما لا يتجاوز متبقّي كلٍّ منها ولا المبلغ؛ واليدوي كما كُتب (الصفر يُهمل)؛ وبلا تخصيص كلّه مقدَّم.
 * الخادم يعيد حساب التلقائي تحت القفل، فالمعاينة تطابقه ما لم تتغيّر الفواتير بين الفتح والحفظ.
 */
export function planAllocations(
  amountMilli: number,
  bills: readonly PlanBill[],
  mode: AllocationMode,
  manualMilli: ReadonlyMap<string, number> = new Map(),
): AllocationPlan {
  const lines: { warehouseEntryId: string; milli: number }[] = [];
  const amount = Math.max(0, Math.trunc(amountMilli) || 0);
  if (mode === 'AUTO') {
    let remaining = amount;
    for (const b of bills) {
      if (remaining <= 0) break;
      const room = Math.round((Number(b.outstanding) || 0) * 1000);
      if (room <= 0) continue;
      const take = Math.min(room, remaining);
      lines.push({ warehouseEntryId: b.warehouseEntryId, milli: take });
      remaining -= take;
    }
  } else if (mode === 'MANUAL') {
    for (const b of bills) {
      const m = manualMilli.get(b.warehouseEntryId) ?? 0;
      if (m > 0) lines.push({ warehouseEntryId: b.warehouseEntryId, milli: m });
    }
  }
  const allocatedMilli = lines.reduce((s, l) => s + l.milli, 0);
  return { lines, allocatedMilli, unappliedMilli: amount - allocatedMilli };
}

export interface PaymentDraft {
  amount: string;
  method: SupplierPaymentMethod;
  salesRepId: string;
  paidAt: string;
  reference: string;
  note: string;
  mode: AllocationMode;
  /** مبالغ التخصيص اليدوي المكتوبة لكل فاتورة */
  manual: Record<string, string>;
}

export const PAYMENT_REFERENCE_MAX = 100;
export const PAYMENT_NOTE_MAX = 500;

export function emptyPaymentDraft(today: string, mode: AllocationMode = 'AUTO'): PaymentDraft {
  return { amount: '', method: 'CASH', salesRepId: '', paidAt: today, reference: '', note: '', mode, manual: {} };
}

export type PaymentProblem =
  | 'AMOUNT_REQUIRED' | 'AMOUNT_INVALID' | 'AMOUNT_DECIMALS' | 'REP_REQUIRED' | 'DATE_INVALID'
  | 'ALLOC_INVALID' | 'ALLOC_DECIMALS' | 'ALLOC_OVER_OUTSTANDING' | 'ALLOC_OVER_AMOUNT' | 'REFERENCE_TOO_LONG' | 'NOTE_TOO_LONG';

export const PAYMENT_PROBLEM_TEXT: Record<PaymentProblem, string> = {
  AMOUNT_REQUIRED: 'اكتب مبلغ السند',
  AMOUNT_INVALID: 'مبلغ السند يجب أن يكون أكبر من صفر',
  AMOUNT_DECIMALS: 'منازل المبلغ أكثر من منازل العملة',
  REP_REQUIRED: 'اختر المندوب الذي يدفع من عهدته',
  DATE_INVALID: 'تاريخ الدفع غير صحيح',
  ALLOC_INVALID: 'مبلغ تخصيص غير صحيح',
  ALLOC_DECIMALS: 'منازل مبلغ التخصيص أكثر من منازل العملة',
  ALLOC_OVER_OUTSTANDING: 'مبلغ التخصيص أكبر من المتبقي على الفاتورة',
  ALLOC_OVER_AMOUNT: 'مجموع التخصيص أكبر من مبلغ السند',
  REFERENCE_TOO_LONG: 'المرجع أطول من 100 حرف',
  NOTE_TOO_LONG: 'البيان أطول من 500 حرف',
};

/** مبالغ التخصيص اليدوي بالملّي — أو المشكلة الأولى (خانة غير صالحة أو فوق متبقّي فاتورتها) */
export function manualAllocationMilli(
  draft: Pick<PaymentDraft, 'manual'>,
  bills: readonly PlanBill[],
  decimals: number,
): { ok: true; map: Map<string, number> } | { ok: false; problem: PaymentProblem; warehouseEntryId: string } {
  const map = new Map<string, number>();
  for (const b of bills) {
    const raw = draft.manual[b.warehouseEntryId];
    if (raw == null || !normalizeNumberText(raw)) continue;
    const p = parseAmount(raw, decimals);
    if (!p.ok) return { ok: false, problem: p.reason === 'DECIMALS' ? 'ALLOC_DECIMALS' : 'ALLOC_INVALID', warehouseEntryId: b.warehouseEntryId };
    if (p.milli > Math.round((Number(b.outstanding) || 0) * 1000)) {
      return { ok: false, problem: 'ALLOC_OVER_OUTSTANDING', warehouseEntryId: b.warehouseEntryId };
    }
    if (p.milli > 0) map.set(b.warehouseEntryId, p.milli);
  }
  return { ok: true, map };
}

/** المشكلة الأولى في نموذج السند — null ⇒ يُرسل */
export function paymentProblem(d: PaymentDraft, bills: readonly PlanBill[], decimals: number): PaymentProblem | null {
  const a = parseAmount(d.amount, decimals);
  if (!a.ok) return a.reason === 'EMPTY' ? 'AMOUNT_REQUIRED' : a.reason === 'DECIMALS' ? 'AMOUNT_DECIMALS' : 'AMOUNT_INVALID';
  if (a.milli <= 0) return 'AMOUNT_INVALID';
  if (d.method === 'REP_CUSTODY' && !d.salesRepId) return 'REP_REQUIRED';
  if (!isValidDay(d.paidAt)) return 'DATE_INVALID';
  if (d.reference.trim().length > PAYMENT_REFERENCE_MAX) return 'REFERENCE_TOO_LONG';
  if (d.note.trim().length > PAYMENT_NOTE_MAX) return 'NOTE_TOO_LONG';
  if (d.mode === 'MANUAL') {
    const m = manualAllocationMilli(d, bills, decimals);
    if (!m.ok) return m.problem;
    let sum = 0;
    for (const v of m.map.values()) sum += v;
    if (sum > a.milli) return 'ALLOC_OVER_AMOUNT';
  }
  return null;
}

/** خطّة المعاينة من النموذج (مبلغٌ غير صالح ⇒ صفر، وتخصيصٌ يدويّ غير صالح ⇒ بلا سطور) */
export function draftPlan(d: PaymentDraft, bills: readonly PlanBill[], decimals: number): AllocationPlan {
  const a = parseAmount(d.amount, decimals);
  const amountMilli = a.ok ? a.milli : 0;
  const m = d.mode === 'MANUAL' ? manualAllocationMilli(d, bills, decimals) : null;
  return planAllocations(amountMilli, bills, d.mode, m && m.ok ? m.map : new Map());
}

/**
 * جسم POST /supplier-payments (بلا clientRef — يضيفه المتصل بمرجع المحاولة). التلقائي يُرسل autoAllocate فيخصّص الخادم تحت
 * القفل على الحال الراهنة؛ واليدوي بسطوره؛ وبلا تخصيص لا هذا ولا ذاك (دفعة مقدّمة). المندوب لعهدة المندوب وحدها.
 * يُستدعى بعد paymentProblem = null.
 */
export function paymentBody(d: PaymentDraft, supplierId: string, bills: readonly PlanBill[], decimals: number): SupplierPaymentInput {
  const a = parseAmount(d.amount, decimals);
  const amountMilli = a.ok ? a.milli : 0;
  const body: SupplierPaymentInput = {
    supplierId,
    amount: fromMilli(amountMilli),
    method: d.method,
    paidAt: d.paidAt,
  };
  if (d.method === 'REP_CUSTODY' && d.salesRepId) body.salesRepId = d.salesRepId;
  const ref = d.reference.trim();
  if (ref) body.reference = ref;
  const note = d.note.trim();
  if (note) body.note = note;
  if (d.mode === 'AUTO') body.autoAllocate = true;
  if (d.mode === 'MANUAL') {
    const m = manualAllocationMilli(d, bills, decimals);
    const lines = m.ok ? [...m.map].map(([warehouseEntryId, milli]) => ({ warehouseEntryId, amount: fromMilli(milli) })) : [];
    if (lines.length) body.allocations = lines;
  }
  return body;
}

// ═══ السند المحفوظ ═══

/** Σ تخصيصات السند وما بقي منه دفعةً مقدَّمة — بالملّي */
export function voucherSplit(p: Pick<SupplierPaymentView, 'amount' | 'allocations'>): { allocated: number; unapplied: number } {
  const amountMilli = Math.round((Number(p.amount) || 0) * 1000);
  let alloc = 0;
  for (const a of p.allocations ?? []) alloc += Math.round((Number(a.amount) || 0) * 1000);
  return { allocated: fromMilli(alloc), unapplied: fromMilli(Math.max(0, amountMilli - alloc)) };
}

/**
 * ردّ الخادم سندٌ كامل بشكل SupplierPaymentView؟ — ما تُرسم به ورقة السند (الرقم والمبلغ والتخصيصات). ردٌّ أنحف (معرّفٌ ورقمٌ
 * وحدهما) لا يُرسم منه شيء فيُجلب السند بمعرّفه، بدل ورقةٍ تسقط على تخصيصاتٍ غائبة
 */
export function isPaymentView(x: unknown): x is SupplierPaymentView {
  const p = x as Partial<SupplierPaymentView> | null | undefined;
  return !!p && typeof p === 'object' && typeof p.id === 'string' && typeof p.displayNumber === 'string'
    && typeof p.amount === 'number' && Array.isArray(p.allocations) && typeof p.status === 'string';
}

/** معرّف السند من ردّ الإنشاء أيّاً كان شكله (السند أو {id}) */
export function paymentIdOf(x: unknown): string | null {
  const id = (x as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' && id ? id : null;
}

/** ما يمكن فعله بالسند من الواجهة: الإلغاء للساري غير الآلي (الآلي يُلغى بإلغاء حركة الشراء) */
export function paymentActions(p: Pick<SupplierPaymentView, 'status' | 'autoForEntryId'>, canEdit: boolean): { cancel: boolean; autoLocked: boolean } {
  const posted = p.status === 'POSTED';
  const auto = !!p.autoForEntryId;
  return { cancel: canEdit && posted && !auto, autoLocked: posted && auto };
}

// ═══ الفواتير المفتوحة ═══

/** ملخّص المتأخّر: عدد الفواتير المتأخّرة ومتبقّيها — للبطاقة فوق الجدول */
export function overdueSummary(bills: readonly Pick<OpenBill, 'daysOverdue' | 'outstanding'>[]): { count: number; outstanding: number; total: number } {
  const late = bills.filter((b) => (b.daysOverdue ?? 0) > 0);
  return { count: late.length, outstanding: sumAmounts(late.map((b) => b.outstanding)), total: sumAmounts(bills.map((b) => b.outstanding)) };
}

// ═══ أعمار الذمم ═══

export const AGING_COLUMNS: readonly { key: keyof Pick<SupplierAgingRow, 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus'>; label: string }[] = [
  { key: 'current', label: 'غير مستحقة بعد' },
  { key: 'd1_30', label: '1 إلى 30 يوما' },
  { key: 'd31_60', label: '31 إلى 60 يوما' },
  { key: 'd61_90', label: '61 إلى 90 يوما' },
  { key: 'd90_plus', label: 'أكثر من 90 يوما' },
];

/** في التقرير ما ليس على فاتورة (دفعة مقدّمة أو افتتاحي)؟ — عموده يظهر حينها وحده */
export function agingHasUnapplied(a: Pick<SupplierAging, 'rows'>): boolean {
  return a.rows.some((r) => Math.round((Number(r.unapplied) || 0) * 1000) !== 0);
}

// ═══ التصدير ═══

/** خليّة نصّية تبدأ بـ= أو + أو - أو @ تُسبق بفاصلة عليا فلا يفسّرها Excel معادلة (اسم مورّد خبيث) */
export function formulaSafe(text: string): string {
  const first = text.replace(/^\s+/, '').charAt(0);
  return first === '=' || first === '+' || first === '-' || first === '@' ? `'${text}` : text;
}

/** رقمٌ لخلية بمنازل العملة (رقمٌ فعليّ لا نصّ) */
export function cellAmount(v: number | null | undefined, decimals: number): number {
  return roundHalfUp(Number(v) || 0, decimals);
}

type Row = Record<string, string | number>;

export interface StatementExportOpts { tr: Tr; decimals: number; dayText: (d: string | null) => string }

/** صفوف كشف المورّد للتصدير: الافتتاحي ثم السطور ثم الإجمالي — المبالغ أرقام، والنصوص محيَّدة */
export function statementRows(st: SupplierStatement, o: StatementExportOpts): Row[] {
  const { tr, decimals } = o;
  const H = {
    date: tr('التاريخ'), kind: tr('النوع'), ref: tr('المرجع'), desc: tr('البيان'), due: tr('تاريخ الاستحقاق'),
    debit: tr('مدين'), credit: tr('دائن'), balance: tr('الرصيد'),
  };
  const row = (r: Partial<Record<keyof typeof H, string | number>>): Row => ({
    [H.date]: r.date ?? '', [H.kind]: r.kind ?? '', [H.ref]: r.ref ?? '', [H.desc]: r.desc ?? '', [H.due]: r.due ?? '',
    [H.debit]: r.debit ?? '', [H.credit]: r.credit ?? '', [H.balance]: r.balance ?? '',
  });
  const out: Row[] = [];
  out.push(row({ date: st.from ? o.dayText(st.from) : '', kind: tr('رصيد افتتاحي'), balance: cellAmount(st.opening, decimals) }));
  for (const l of st.lines) {
    out.push(row({
      date: o.dayText(l.date),
      kind: tr(statementKindLabel(l.kind)),
      ref: formulaSafe(l.ref ?? ''),
      desc: formulaSafe(l.description ?? ''),
      due: l.dueDate ? o.dayText(l.dueDate) : '',
      debit: l.debit ? cellAmount(l.debit, decimals) : '',
      credit: l.credit ? cellAmount(l.credit, decimals) : '',
      balance: cellAmount(l.balance, decimals),
    }));
  }
  out.push(row({
    kind: tr('الإجمالي'),
    debit: cellAmount(st.totalDebit, decimals),
    credit: cellAmount(st.totalCredit, decimals),
    balance: cellAmount(st.closing, decimals),
  }));
  return out;
}

export function statementSheet(st: SupplierStatement, o: StatementExportOpts): ExcelSheet {
  return { name: o.tr('كشف حساب مورد'), rows: statementRows(st, o), colWidths: [14, 22, 18, 36, 14, 14, 14, 16] };
}

/** صفوف أعمار الذمم للتصدير: مورّدٌ لكل صفّ ثم الإجمالي. عمود «غير مخصص» حين في التقرير ما ليس على فاتورة */
export function agingRows(a: SupplierAging, o: { tr: Tr; decimals: number }): Row[] {
  const { tr, decimals } = o;
  const withUnapplied = agingHasUnapplied(a);
  const make = (name: string, code: string, r: Partial<SupplierAgingRow>): Row => {
    const out: Row = { [tr('المورد')]: formulaSafe(name), [tr('الرمز')]: formulaSafe(code) };
    for (const c of AGING_COLUMNS) out[tr(c.label)] = cellAmount(r[c.key] as number, decimals);
    out[tr('إجمالي الفواتير المفتوحة')] = cellAmount(r.total, decimals);
    if (withUnapplied) {
      out[tr('غير مخصص')] = cellAmount(r.unapplied, decimals);
      out[tr('رصيد الحساب')] = cellAmount(r.balance, decimals);
    }
    return out;
  };
  const rows = a.rows.map((r) => make(r.name, r.code ?? '', r));
  rows.push(make(tr('الإجمالي'), '', a.totals));
  return rows;
}

export function agingSheet(a: SupplierAging, o: { tr: Tr; decimals: number }): ExcelSheet {
  return { name: o.tr('أعمار ذمم الموردين'), rows: agingRows(a, o), colWidths: [30, 12, 16, 16, 16, 16, 16, 18, 16, 16] };
}

/**
 * CSV بترميز UTF-8 مع BOM (يفتحه Excel بالعربية صحيحاً) وأسطر CRLF، والخانة التي فيها فاصلة أو اقتباس أو سطر جديد بين
 * علامتي اقتباس مع مضاعفة الاقتباس الداخلي (RFC 4180). الأعمدة من مفاتيح الصفّ الأول.
 */
export function toCsv(rows: readonly Row[]): string {
  if (!rows.length) return '﻿';
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown): string => {
    const s = v == null ? '' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map(cell).join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))];
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** اسم ملفٍ آمن: بلا محارف يمنعها نظام الملفات */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'export';
}
