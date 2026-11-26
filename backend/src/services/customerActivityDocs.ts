// ============================================================================
// «أرشيف العميل — السجل الزمني» (طلب المالك ٢٦ نوفمبر ٢٠٢٦): أحداث المستندات المالية للعميل
// ----------------------------------------------------------------------------
// طبقةٌ رقيقة فوق services/customerActivity.ts يتشاركها كل مسار مستند مالي (الفاتورة والمرتجع والإشعاران، الإلغاء والإبطال،
// سند القبض وإلغاؤه، التسويات والأرصدة الافتتاحية، روابط الدفع والتحصيل بالبطاقة):
//   • recordDocActivity: يُكتب الحدث **بمقبض المعاملة نفسها** التي تكتب المستند — يلتزم معه أو يُلغى معه، فلا مستند بلا أثره
//     ولا أثر لمستندٍ لم يُكتب. المعاملات المزيّفة في الاختبارات القائمة (بلا جدول السجل) تُتخطّى بلا خطأ؛ عميل Prisma الحقيقي
//     يحمل الجدول دائماً.
//   • docActivityMeta: الفاعل والمصدر من الطلب مرّةً واحدة قبل المعاملة — لا يرمي أبداً (اختبارات المسارات تحقن بديلاً
//     لـmiddleware/auth، فالفاعل يُشتقّ من req.user وحده عند أيّ تعذّر).
//   • بُناة المدخلات: حدثٌ دلاليّ واحد لكل إجراء — نوعه من نوع المستند، ورقمه في refNo، ومبلغه في amount، وتفاصيله في data
//     (بلا أسرار ولا صور).
// السجل للإلحاق وحده: لا شيء هنا يعدّل صفّاً من سجلّ العميل أو يحذفه.
//
// عُرف المبلغ (amount) — ثابتٌ لكل مصدر فتُجمع الأسطر وتُقارن عبر المصادر:
//   • المستند (فاتورة، مرتجع، إشعار، سند قبض، رابط دفع، عملية بطاقة): قيمة المستند موجبةً كما طُبعت — ونوع الحدث يقول اتجاهه.
//   • ما يمسّ الرصيد مباشرةً (ADJUSTMENT_* وOPENING_BALANCE_SET وLEDGER_JOURNAL_*): **أثره الموقَّع على رصيد العميل** = مدين − دائن:
//     شطب دينٍ معدوم ٥٠٠ ⇒ −٥٠٠، وردّ رصيدٍ دائن ٥٠٠ ⇒ +٥٠٠، ورصيدٌ افتتاحي دائن ٥٠٠ ⇒ −٥٠٠، وإلغاء أيٍّ منها ⇒ سالب أثره الأصلي،
//     وحذف قيدٍ نهائياً ⇒ سالب (مدينه − دائنه). balanceEffect أدناه مصدره الواحد.
// ============================================================================

import type { AuthRequest } from '../types';
import {
  SYSTEM_ACTOR, actorFromReq, recordCustomerActivity, sourceFromReq,
  type ActivityActor, type ActivityInput, type CustomerActivityAction,
} from './customerActivity';

export { SYSTEM_ACTOR };
export type { ActivityActor, ActivityInput, CustomerActivityAction };

/** الفاعل والمصدر كما يُحملان من المسار إلى الخدمة (سياقات الإصدار والإبطال والتسوية) */
export interface DocActivityMeta {
  actor: ActivityActor;
  source?: string | null;
  /** نوع الحدث حين يقرّره المستدعي لا المستند (مرتجعٌ صدر إشعاراً دائناً ⇒ RETURN_ISSUED) */
  action?: CustomerActivityAction;
}

/** الفاعل حين يتعذّر actorFromReq — من req.user وحده (لا قراءة ولا رمي) */
function actorFromUser(req: AuthRequest | null | undefined): ActivityActor {
  const u = req?.user;
  if (!u) return SYSTEM_ACTOR;
  const name = typeof u.name === 'string' && u.name ? u.name : null;
  if (u.apiKeyId) return { kind: 'API', id: u.apiKeyId, name };
  if (u.impersonated) return { kind: u.byKind === 'STAFF' ? 'STAFF' : 'OWNER', id: u.by ?? u.id ?? null, name };
  if (u.role === 'SALES_REP') return { kind: 'REP', id: u.id ?? null, name };
  if (u.role === 'PLATFORM_STAFF') return { kind: 'STAFF', id: u.id ?? null, name };
  if (u.role === 'SUPER_ADMIN') return { kind: 'OWNER', id: u.id ?? null, name };
  return { kind: 'ADMIN', id: u.id ?? null, name };
}

/** الفاعل والمصدر من الطلب — يُحسبان قبل المعاملة ولا يرميان أبداً */
export function docActivityMeta(req: AuthRequest, action?: CustomerActivityAction): DocActivityMeta {
  let actor: ActivityActor;
  try {
    actor = actorFromReq(req) ?? actorFromUser(req);
  } catch {
    actor = actorFromUser(req);
  }
  let source: string | null = null;
  try {
    source = sourceFromReq(req) ?? null;
  } catch {
    source = req?.user?.apiKeyId ? 'api' : null;
  }
  return { actor, source, ...(action && { action }) };
}

type ActivityDb = { customerActivity: { createMany(args: { data: any[] }): Promise<unknown> } };

/** مقبضٌ يحمل جدول السجل؟ المعاملات المزيّفة القديمة في الاختبارات لا تحمله */
function hasActivityTable(db: unknown): db is ActivityDb {
  const d = (db as { customerActivity?: { createMany?: unknown } } | null | undefined)?.customerActivity;
  return !!d && typeof d.createMany === 'function';
}

/**
 * يُلحق حدثاً (أو أحداثاً) بسجلّ العميل بمقبض المعاملة الممرَّر — داخل معاملة المستند نفسها. حدثٌ بلا عميل يُسقط (لا سجلّ له).
 * أخطاء القاعدة تُرمى فتُلغي المعاملة كلها: المستند لا يلتزم بلا أثره.
 */
export async function recordDocActivity(db: unknown, input: ActivityInput | readonly (ActivityInput | null | undefined)[] | null | undefined): Promise<void> {
  if (!input) return;
  const raw: readonly unknown[] = Array.isArray(input) ? input : [input];
  const list = raw.filter((i): i is ActivityInput => {
    const c = (i as Partial<ActivityInput> | null | undefined)?.customerId;
    return typeof c === 'string' && c !== '';
  });
  if (!list.length || !hasActivityTable(db)) return;
  await recordCustomerActivity(db, list.length === 1 ? list[0] : list);
}

/** رقمٌ من Float/Decimal/نص — null لما لا يُقرأ */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(typeof v === 'object' && v !== null && 'toString' in v ? String(v) : v);
  return Number.isFinite(n) ? n : null;
}

/** أثر الحركة على رصيد العميل (عُرف المبلغ أعلاه): مدين − دائن، بأربع منازل بلا غبار طفو */
export function balanceEffect(debit: unknown, credit: unknown): number {
  const r = Math.round(((num(debit) ?? 0) - (num(credit) ?? 0)) * 10_000) / 10_000;
  return r === 0 ? 0 : r; // لا «−٠»
}

/** صفّ المستند كما تكتبه مسارات الإصدار (Invoice) — الحقول التي يقرؤها الحدث وحدها */
export interface InvoiceLike {
  id: string;
  number?: string | null;
  customerId: string;
  type?: string | null;
  documentKind?: string | null;
  total?: unknown;
  taxAmt?: unknown;
  discountAmt?: unknown;
  paymentPlan?: string | null;
  returnReason?: string | null;
  returnToStock?: boolean | null;
  noteReason?: string | null;
  billingReference?: string | null;
  zatcaPhase?: number | null;
  items?: readonly unknown[] | null;
  installments?: readonly unknown[] | null;
}

/** حدث الإصدار من نوع المستند: الإشعاران بنوعهما، والمرتجع، وإلا فاتورة بيع */
export function issuedActionOf(inv: Pick<InvoiceLike, 'type' | 'documentKind'>): CustomerActivityAction {
  if (inv.documentKind === 'DEBIT_NOTE') return 'DEBIT_NOTE_ISSUED';
  if (inv.documentKind === 'CREDIT_NOTE') return 'CREDIT_NOTE_ISSUED';
  if (inv.type === 'RETURN') return 'RETURN_ISSUED';
  return 'INVOICE_ISSUED';
}

const clip = (s: unknown, n = 300): string | undefined => (typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : undefined);

/** تفاصيل المستند في data — نوع الدفع والإجماليات وعدد البنود والسبب والأصل (ما لا قيمة له لا يُكتب) */
export function invoiceActivityData(inv: InvoiceLike, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const isNote = inv.documentKind === 'CREDIT_NOTE' || inv.documentKind === 'DEBIT_NOTE';
  const data: Record<string, unknown> = {
    ...(inv.type && inv.type !== 'RETURN' && !isNote && { paymentType: inv.type }),
    ...(inv.documentKind && inv.documentKind !== 'INVOICE' && { documentKind: inv.documentKind }),
    ...(num(inv.total) !== null && { total: num(inv.total) }),
    ...(num(inv.taxAmt) ? { taxTotal: num(inv.taxAmt) } : {}),
    ...(num(inv.discountAmt) ? { discount: num(inv.discountAmt) } : {}),
    ...(Array.isArray(inv.items) && { itemsCount: inv.items.length }),
    ...(inv.paymentPlan && { paymentPlan: inv.paymentPlan }),
    ...(Array.isArray(inv.installments) && inv.installments.length > 0 && { installmentsCount: inv.installments.length }),
    ...(inv.type === 'RETURN' && inv.returnReason && { returnReason: inv.returnReason }),
    ...(inv.type === 'RETURN' && typeof inv.returnToStock === 'boolean' && { returnToStock: inv.returnToStock }),
    ...(clip(inv.noteReason) && { reason: clip(inv.noteReason) }),
    ...(clip(inv.billingReference, 80) && { originalInvoiceNo: clip(inv.billingReference, 80) }),
    ...(inv.zatcaPhase === 2 && { zatcaPhase: 2 }),
  };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') data[k] = v;
  return data;
}

/** حدث إصدار مستند فاتورة (بيع، مرتجع، إشعار دائن أو مدين) */
export function invoiceIssuedInput(input: {
  tenantId: string; meta: DocActivityMeta; invoice: InvoiceLike; at?: Date | null; data?: Record<string, unknown>;
}): ActivityInput {
  const inv = input.invoice;
  return {
    tenantId: input.tenantId,
    customerId: inv.customerId,
    action: input.meta.action ?? issuedActionOf(inv),
    actor: input.meta.actor,
    refType: 'INVOICE',
    refId: inv.id,
    refNo: inv.number ?? null,
    amount: num(inv.total),
    data: invoiceActivityData(inv, input.data),
    source: input.meta.source ?? null,
    ...(input.at && { at: input.at }),
  };
}

/** حدثٌ على مستند فاتورة قائم (إلغاء، إبطال، إعادة إصدار، تعديل) */
export function invoiceEventInput(input: {
  tenantId: string; action: CustomerActivityAction; meta: DocActivityMeta;
  invoice: Pick<InvoiceLike, 'id' | 'number' | 'customerId' | 'type' | 'documentKind' | 'total'>;
  data?: Record<string, unknown>;
}): ActivityInput {
  const inv = input.invoice;
  const data: Record<string, unknown> = {
    ...(inv.type && { invoiceType: inv.type }),
    ...(inv.documentKind && inv.documentKind !== 'INVOICE' && { documentKind: inv.documentKind }),
  };
  for (const [k, v] of Object.entries(input.data ?? {})) if (v !== undefined && v !== null && v !== '') data[k] = v;
  return {
    tenantId: input.tenantId,
    customerId: inv.customerId,
    action: input.action,
    actor: input.meta.actor,
    refType: 'INVOICE',
    refId: inv.id,
    refNo: inv.number ?? null,
    amount: num(inv.total),
    data,
    source: input.meta.source ?? null,
  };
}

/** صفّ سند القبض — الحقول التي يقرؤها الحدث وحدها */
export interface ReceiptLike {
  id: string;
  number?: string | null;
  customerId: string;
  amount?: unknown;
  paymentMethod?: string | null;
  paymentMethodKey?: string | null;
  chequeNumber?: string | null;
  bankName?: string | null;
  notes?: string | null;
  /** مفتاح الرفع/التكرار — 'cardpay:…' و'paylink:…' للسندات التي يكتبها النظام نفسه (ملاحظتها بيانات بطاقة لا كلام مستخدم) */
  clientRef?: string | null;
}

/** بطاقةٌ مقنّعة (أول ٤–٦ أرقام ثم نجوم أو X ثم آخر ٢–٤) — كما يطبعها مزوّد الدفع على السند */
const MASKED_PAN_RE = /\d{4,6}[*xX•●]{2,}\d{2,4}/g;
/** الرقم المرجعي للعملية لدى الشبكة (RRN) بعنوانه */
const RRN_RE = /\bRRN\s*[:#-]?\s*\d{6,}/gi;
/** طرق الدفع التي يكتب النظام سنداتها وملاحظاتها (التحصيل بالبطاقة والدفع الإلكتروني) */
const SYSTEM_NOTE_METHODS: ReadonlySet<string> = new Set(['POS', 'ONLINE']);

/**
 * ملاحظة السند الصالحة لسجلّ العميل — قاعدة السجلّ: بيانات البطاقة لا تدخله أبداً (لا في الكتابة ولا في الاشتقاق التاريخي):
 *  • سند البطاقة أو الدفع الإلكتروني (طريقة الدفع POS/ONLINE، أو clientRef «cardpay:…»/«paylink:…») ⇒ null: ملاحظته يكتبها النظام
 *    وتحمل البطاقة المقنّعة ورقم العملية لدى الشبكة.
 *  • وغيره ⇒ الملاحظة بعد نزع ما يشبه البطاقة المقنّعة وRRN (مستخدمٌ نسخها يدوياً) — وما يفرغ بعدها ⇒ null.
 */
export function safeReceiptNote(
  note: string | null | undefined, meta: { paymentMethod?: string | null; clientRef?: string | null } = {},
): string | null {
  if (typeof note !== 'string' || !note.trim()) return null;
  if (meta.paymentMethod && SYSTEM_NOTE_METHODS.has(meta.paymentMethod)) return null;
  const ref = typeof meta.clientRef === 'string' ? meta.clientRef : '';
  if (ref.startsWith('cardpay:') || ref.startsWith('paylink:')) return null;
  const cleaned = note
    .replace(MASKED_PAN_RE, '')
    .replace(RRN_RE, '')
    // أجزاء الملاحظة بين فواصلها (— أو –): ما فرغ بالنزع يسقط بفاصله، ولا تبقى مسافتان
    .split(/\s*[—–]\s*/)
    .map((part) => part.replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)
    .join(' — ');
  return cleaned ? cleaned.slice(0, 300) : null;
}

/** تخصيص السند على فاتورة: المبلغ وهل سدّدها كاملة (restored: عاد مبلغه إلى فاتورةٍ باقية بحذف السند نهائياً) */
export interface ReceiptAllocationNote { invoiceId: string; invoiceNo?: string | null; amount: number; settled?: boolean; restored?: boolean }

/** حدث سند القبض (إصدار أو إلغاء أو حذفٌ نهائي) */
export function receiptEventInput(input: {
  tenantId: string; action: Extract<CustomerActivityAction, 'RECEIPT_ISSUED' | 'RECEIPT_CANCELLED' | 'RECEIPT_DELETED'>; meta: DocActivityMeta;
  receipt: ReceiptLike; allocations?: readonly ReceiptAllocationNote[]; at?: Date | null; data?: Record<string, unknown>;
}): ActivityInput {
  const r = input.receipt;
  const allocations = (input.allocations ?? []).slice(0, 50).map((a) => ({
    invoiceId: a.invoiceId,
    ...(a.invoiceNo && { invoiceNo: a.invoiceNo }),
    amount: num(a.amount) ?? 0,
    ...(a.settled === true && { settled: true }),
    ...(a.restored === true && { restored: true }),
  }));
  const note = safeReceiptNote(r.notes, { paymentMethod: r.paymentMethod, clientRef: r.clientRef });
  const data: Record<string, unknown> = {
    ...(r.paymentMethod && { paymentMethod: r.paymentMethod }),
    ...(r.paymentMethodKey && { paymentMethodKey: r.paymentMethodKey }),
    ...(clip(r.chequeNumber, 60) && { chequeNumber: clip(r.chequeNumber, 60) }),
    ...(clip(r.bankName, 120) && { bankName: clip(r.bankName, 120) }),
    ...(note && { note }),
    ...(allocations.length > 0 && { allocations, invoicesCount: allocations.length }),
  };
  for (const [k, v] of Object.entries(input.data ?? {})) if (v !== undefined && v !== null && v !== '') data[k] = v;
  return {
    tenantId: input.tenantId,
    customerId: r.customerId,
    action: input.action,
    actor: input.meta.actor,
    refType: 'RECEIPT',
    refId: r.id,
    refNo: r.number ?? null,
    amount: num(r.amount),
    data,
    source: input.meta.source ?? null,
    ...(input.at && { at: input.at }),
  };
}

/** عملية تحصيل بالبطاقة — الحقول التي يقرؤها الحدث وحدها (reference = رقم الفاتورة) */
export interface CardPaymentLike {
  id: string; tenantId: string; customerId: string; invoiceId?: string | null; amount?: unknown; reference?: string | null;
  createdById?: string | null; salesRepId?: string | null; salesRep?: { name?: string | null } | null;
}

/** من بدأ عملية البطاقة: الإداري من اللوحة، وإلا المندوب باسمه — وإلا النظام */
export function cardPaymentMeta(row: Pick<CardPaymentLike, 'createdById' | 'salesRepId' | 'salesRep'>): DocActivityMeta {
  if (row.createdById) return { actor: { kind: 'ADMIN', id: row.createdById, name: null }, source: 'web' };
  if (row.salesRepId) return { actor: { kind: 'REP', id: row.salesRepId, name: row.salesRep?.name ?? null }, source: 'rep' };
  return SYSTEM_META;
}

/**
 * حدث عملية البطاقة — المرجع العملية ورقمها رقم فاتورتها:
 *  COMPLETED نجاحها وقيد سندها · FAILED أوّل خروجٍ لها من «قيد الانتظار» بلا مال (انتهاءٌ أو رفضٌ أو فاتورةٌ تغيّرت) أو إغلاقها بعد
 *  المراجعة إن لم يُسجَّل لها فشلٌ قبله — فشلٌ واحد للمحاولة · HELD إيقافها للمراجعة (خُصم المال لدى المزوّد واختلف) ·
 *  REVERSED عكسها لدى المزوّد (عاد المال، وسندها يُلغى إن قُيد)
 */
export function cardPaymentEventInput(input: {
  action: Extract<CustomerActivityAction, 'CARD_PAYMENT_COMPLETED' | 'CARD_PAYMENT_FAILED' | 'CARD_PAYMENT_HELD' | 'CARD_PAYMENT_REVERSED'>;
  meta: DocActivityMeta;
  payment: CardPaymentLike; data?: Record<string, unknown>;
}): ActivityInput {
  const p = input.payment;
  const data: Record<string, unknown> = {
    ...(p.invoiceId && { invoiceId: p.invoiceId }),
    ...(p.reference && { invoiceNo: p.reference }),
  };
  for (const [k, v] of Object.entries(input.data ?? {})) if (v !== undefined && v !== null && v !== '') data[k] = typeof v === 'string' ? v.slice(0, 300) : v;
  return {
    tenantId: p.tenantId, customerId: p.customerId, action: input.action, actor: input.meta.actor,
    refType: 'CARD_PAYMENT', refId: p.id, refNo: p.reference ?? null, amount: num(p.amount), data, source: input.meta.source ?? null,
  };
}

/** رابط دفع فاتورة للعميل — الحقول التي يقرؤها الحدث وحدها */
export interface PaylinkLike { id: string; tenantId: string; customerId: string; invoiceId?: string | null; amount?: unknown; expiresAt?: Date | null }

/** حدث رابط الدفع (إصدار، سداد، إلغاء، انتهاء، استردادٌ لدى المزوّد بعد السداد) — المرجع الرابط ورقمه رقم فاتورته */
export function paylinkEventInput(input: {
  action: Extract<CustomerActivityAction, 'PAYLINK_CREATED' | 'PAYLINK_PAID' | 'PAYLINK_CANCELLED' | 'PAYLINK_EXPIRED' | 'PAYLINK_REFUNDED'>;
  meta: DocActivityMeta; link: PaylinkLike; invoiceNo?: string | null; amount?: unknown; data?: Record<string, unknown>;
}): ActivityInput {
  const l = input.link;
  const data: Record<string, unknown> = {
    ...(l.invoiceId && { invoiceId: l.invoiceId }),
    ...(input.invoiceNo && { invoiceNo: input.invoiceNo }),
    ...(input.action === 'PAYLINK_CREATED' && l.expiresAt instanceof Date && { expiresAt: l.expiresAt.toISOString() }),
  };
  for (const [k, v] of Object.entries(input.data ?? {})) if (v !== undefined && v !== null && v !== '') data[k] = typeof v === 'string' ? v.slice(0, 300) : v;
  return {
    tenantId: l.tenantId, customerId: l.customerId, action: input.action, actor: input.meta.actor,
    refType: 'PAYLINK', refId: l.id, refNo: input.invoiceNo ?? null, amount: num(input.amount ?? l.amount), data, source: input.meta.source ?? null,
  };
}

/** فاعل النظام (المجدولات والويب هوك) بمصدر النظام */
export const SYSTEM_META: DocActivityMeta = Object.freeze({ actor: SYSTEM_ACTOR, source: 'system' });

/** العميل نفسه (صفحة الدفع العامة) — باسمه إن عُرف */
export function customerMeta(name?: string | null): DocActivityMeta {
  return { actor: { kind: 'CUSTOMER', id: null, name: typeof name === 'string' && name ? name : null }, source: 'public' };
}

/**
 * سُجّل لمحاولة البطاقة هذه حدث «فشل» من قبل؟ (فشلٌ واحد للمحاولة: إغلاق الموقوفة للمراجعة بعد انتهاءٍ أو رفضٍ سُجّل لا يُكرّره).
 * بفهرس (tenantId, refType, refId) — ومقبضٌ بلا قراءة السجل (المزيّف القديم) ⇒ لا
 */
export async function cardFailureLogged(db: unknown, tenantId: string, cardPaymentId: string): Promise<boolean> {
  const d = (db as { customerActivity?: { findFirst?: (a: unknown) => Promise<unknown> } } | null | undefined)?.customerActivity;
  if (!d || typeof d.findFirst !== 'function') return false;
  const hit = await d.findFirst({
    where: { tenantId, refType: 'CARD_PAYMENT', refId: cardPaymentId, action: 'CARD_PAYMENT_FAILED' },
    select: { id: true },
  });
  return !!hit;
}

// ─── قيود الدفاتر اليدوية على العملاء ───

type Milliish = bigint | number | string | null | undefined;
const toBig = (v: Milliish): bigint => {
  if (typeof v === 'bigint') return v;
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? BigInt(Math.round(n)) : 0n;
};

/** قيد الدفاتر كما يُقرأ لحدثه: سطوره التي تحمل عميلاً (المبالغ بالمللي = ١/١٠٠٠ من وحدة العملة) */
export interface GlMoveLike {
  id: string;
  number?: string | null;
  ref?: string | null;
  narration?: string | null;
  date?: Date | string | null;
  origin?: string | null;
  sourceType?: string | null;
  lines: readonly { customerId: string | null; debitMilli: Milliish; creditMilli: Milliish; account?: { code?: string | null } | null }[];
}

export type LedgerJournalAction = Extract<CustomerActivityAction, 'LEDGER_JOURNAL_POSTED' | 'LEDGER_JOURNAL_REVERSED'>;

const isoDay = (d: Date | string | null | undefined): string | undefined => {
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : undefined;
};

/**
 * أحداث قيدٍ يدوي في الدفاتر على عملائه — حدثٌ واحد لكل عميلٍ في سطوره، مبلغه أثر سطوره على رصيده (مدين − دائن؛ والعكس و«إعادة
 * إلى مسودة» sign = −1: أثرٌ يُطرح). المرجع القيد الأصلي نفسه (ADJUSTMENT بمعرّف القيد، ورقمه في refNo). نقيّة
 */
export function ledgerJournalEvents(input: {
  tenantId: string; action: LedgerJournalAction; meta: DocActivityMeta; move: GlMoveLike; sign?: 1 | -1; data?: Record<string, unknown>;
}): ActivityInput[] {
  const m = input.move;
  const sign = input.sign === -1 ? -1n : 1n;
  const per = new Map<string, { debit: bigint; credit: bigint; lines: number; codes: Set<string> }>();
  for (const l of m.lines ?? []) {
    if (typeof l.customerId !== 'string' || !l.customerId) continue;
    const cur = per.get(l.customerId) ?? { debit: 0n, credit: 0n, lines: 0, codes: new Set<string>() };
    cur.debit += toBig(l.debitMilli);
    cur.credit += toBig(l.creditMilli);
    cur.lines += 1;
    if (l.account?.code) cur.codes.add(l.account.code);
    per.set(l.customerId, cur);
  }
  const out: ActivityInput[] = [];
  for (const [customerId, t] of per) {
    const data: Record<string, unknown> = {
      kind: 'GL_JOURNAL',
      ...(m.number && { moveNo: m.number }),
      ...(clip(m.ref, 200) && { reference: clip(m.ref, 200) }),
      ...(clip(m.narration) && { narration: clip(m.narration) }),
      ...(isoDay(m.date) && { docDate: isoDay(m.date) }),
      linesCount: t.lines,
      debit: Number(t.debit) / 1000,
      credit: Number(t.credit) / 1000,
      ...(t.codes.size > 0 && { accountCodes: [...t.codes].sort().slice(0, 20) }),
    };
    for (const [k, v] of Object.entries(input.data ?? {})) if (v !== undefined && v !== null && v !== '') data[k] = v;
    const net = Number((t.debit - t.credit) * sign) / 1000;
    out.push({
      tenantId: input.tenantId, customerId, action: input.action, actor: input.meta.actor, source: input.meta.source ?? null,
      refType: 'ADJUSTMENT', refId: m.id, refNo: m.number ?? null, amount: net === 0 ? 0 : net, data,
    });
  }
  return out;
}

/**
 * يُلحق أحداث قيدٍ يدوي على عملائه (ترحيله، أو عكسه و«إعادته إلى مسودة») **بمقبض معاملة العملية نفسها** — بعدها وقبل الالتزام.
 * يقرأ القيد وسطوره ذات العميل (فهرس moveId). القيد الآلي أو المملوك لمستند (origin AUTO أو sourceType) لا حدث له هنا: مستنده
 * (الفاتورة، السند، التسوية…) يُسجّله مساره. مقبضٌ بلا جدول السجل (المزيّف القديم) لا يُقرأ له شيء
 */
export async function recordLedgerJournalActivity(tx: unknown, opts: {
  tenantId: string; moveId: string; action: LedgerJournalAction; meta: DocActivityMeta; sign?: 1 | -1; data?: Record<string, unknown>;
}): Promise<number> {
  if (!hasActivityTable(tx)) return 0;
  const db = tx as { glMove?: { findFirst?: (a: unknown) => Promise<GlMoveLike | null> } };
  if (typeof db.glMove?.findFirst !== 'function') return 0;
  const move = await db.glMove.findFirst({
    where: { id: opts.moveId, tenantId: opts.tenantId },
    select: {
      id: true, number: true, ref: true, narration: true, date: true, origin: true, sourceType: true,
      lines: { where: { customerId: { not: null } }, select: { customerId: true, debitMilli: true, creditMilli: true, account: { select: { code: true } } } },
    },
  });
  if (!move || move.origin === 'AUTO' || move.sourceType) return 0;
  const events = ledgerJournalEvents({ tenantId: opts.tenantId, action: opts.action, meta: opts.meta, move, sign: opts.sign, data: opts.data });
  await recordDocActivity(tx, events);
  return events.length;
}
