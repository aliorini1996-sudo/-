/**
 * الأحداث المرغوبة من صفوف المصادر (M3، DESIGN.md §5.2) — دوال صرفة بلا I/O ولا prisma.
 *
 * **الحدث من نوع الصف ونوع الفاتورة، لا من ترتيب الآثار ولا من createdAt** (صفّا الفاتورة النقدية يختلف
 * createdAt بينهما لأن Prisma يملأ now() لكل طلب): كل صف يُخطَّط إلى مفتاح مستقلاً عن جيرانه، وصفّا
 * النقدية يعطيان المفتاح نفسه فيندمجان هنا وبـcreateMany({skipDuplicates}) عبر حدود الصفحات.
 *
 * | الصف (ACCOUNT_ENTRY)                                   | الحدث                                   |
 * | CASH: INVOICE_DEBIT/RECEIPT_CREDIT ؛ INVOICE_CREDIT/RECEIPT_DEBIT | INVOICE:<id>:POST ؛ INVOICE:<id>:REVERSE |
 * | CREDIT: INVOICE_DEBIT ؛ INVOICE_CREDIT                 | INVOICE:<id>:POST ؛ REVERSE              |
 * | RETURN: INVOICE_CREDIT ؛ INVOICE_DEBIT                 | INVOICE:<id>:POST ؛ REVERSE              |
 * | receiptId: RECEIPT_CREDIT ؛ RECEIPT_DEBIT              | RECEIPT:<id>:POST ؛ REVERSE              |
 * | بلا فاتورة ولا سند (ADJUSTMENT_*)                      | AR_ENTRY:<entryId>:POST                   |
 * | أي تركيبة أخرى                                         | الحدث المرجّح HELD(UNEXPECTED_ENTRY_SHAPE) |
 * REP_SETTLEMENT ⇒ SETTLEMENT:<id>:POST (effectAt=settledAt)؛ SETTLEMENT_ENTRY: FEE ⇒ PAYLINK_FEE:<id>،
 * PAYOUT ⇒ PAYOUT:<payoutId> (effectAt=createdAt)، COLLECTED/REFUND ⇒ لا حدث.
 *
 * effectAt: entryDate للصف الأساسي (INVOICE_DEBIT للترحيل وINVOICE_CREDIT للعكس، ومقلوبان للمرتجع)، وإن لم
 * يوجد بين صفوف المفتاح إلا المقترن فأصغر entryDate تحته.
 * الحمولة (§5.2): لقطة دنيا ثابتة، المبالغ نصوص بمنازل العملة، و sourceCreatedAt = أكبر createdAt بين صفوف المفتاح.
 *
 * «ربط الدفاتر» L4+L5 (العقد §3.2، D1): كل حقل حمولة جديد يُكتب **للمربوطة وحدها** (ctx.linked === true) و**حين يحمل قيمة**،
 * فحمولة غير المربوطة (القديمة LEGACY) حرفاً كما كانت (اختبار l458-a1-golden). والجديد:
 *  - الفاتورة: ختم cashCollectedByRep، والأقساط، والاستحقاق الافتراضي dueDateDerived، وappliesTo للمرتجع/الإشعار الدائن،
 *    وفي البنود baseQty وproductName (مدخل الإيراد لكل صنف ومحرّك التكلفة لاحقاً).
 *  - السند: paymentMethodKey وcardPaymentId وallocations؛ والعكس: مصدر ردّ المال cancelRefundFrom ومستخدمه.
 *  - الاستلام: receivedByUserId وreceivedByName (P7 ⇒ 111004).
 *  - USER_SETTLEMENT:<id>:POST (effectAt = settledAt) من user_settlements، وSETTLEMENT_ENTRY REFUND ⇒ PAYLINK_REFUND:<entryId>.
 * دوال الحمولة صرفة ومصدر واحد: يستعملها المُطابِق وpostingStore.loadSourceData معاً (لا نسختان تتباعدان).
 */
import { CASH_VOID_KEEP_COLLECTION_NOTE } from '../../../lib/ledgerNotes';
import { localDate } from '../dates';
import { formatMilli, toMilli } from '../money';
import { invoicePayloadFromRows, INVOICE_KINDS, type InvoiceKind } from '../builders/invoice';
import { VAT_CATEGORIES, type VatCategory } from '../types';
import { encodeEventNote } from './classify';
import { arEntryKey, invoiceKey, paylinkFeeKey, payoutKey, receiptKey, settlementKey } from './keys';
import { addDays } from '../dates';
import { paylinkRefundKey, userSettlementKey } from './keys';
import { fromDbDate, zonedStartOfDay } from '../dates';
import { invoiceCogsRevKey, invoiceRestockKey, supplierEntryKey, vanLoadKey, whEntryKey } from './keys';
import type { LocalDate } from '../types';
import type {
  CogsEventPayload, CogsLeg, ReconcileCursorSource, RestockEventPayload, SupplierEntryEventPayload, SupplierEntryWarehouseFacts,
  VanLoadEventPayload, WhEntryEventPayload,
} from './types';
import type { InvoicePostEventPayload, PaylinkRefundEventPayload, UserSettlementEventPayload } from './types';
import type {
  ArEntryEventPayload, DesiredEvent, InvoiceReverseEventPayload, PaylinkFeeEventPayload, PayoutEventPayload,
  ReceiptPostEventPayload, ReceiptReverseEventPayload, SettlementEventPayload, SourceEvent, SourceEventPayload,
  SourceType, SyncCursorSource,
} from './types';

// ═══ المصادر التي يقرؤها المُطابِق في M3 ═══

/**
 * مصادر المبيعات والتحصيل (M3). WAREHOUSE_ENTRY وVAN_LOAD وRETURN_RESTOCK تصل مع M9.
 * USER_SETTLEMENT («ربط الدفاتر» L5، D13) للمربوطة وحدها: reconciledSourceEnabled يحرسه في المُطابِق.
 */
export const RECONCILED_SOURCES = ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY', 'USER_SETTLEMENT'] as const satisfies readonly SyncCursorSource[];

/**
 * «ربط الدفاتر» L6: مصادر المخزون والمشتريات — للمربوطة بالجرد المستمر وحدها (inventoryPosting). منفصلة عن RECONCILED_SOURCES
 * عمداً: مستهلكوه (المعاينة وشبكة الأمان وفحص تأخر المؤشّر وتواريخ الإقفال) يبقون لغير المربوطة حرفاً كما كانوا، والمُطابِق
 * يقرأ ALL_RECONCILED_SOURCES.
 */
export const INVENTORY_RECONCILED_SOURCES = ['WAREHOUSE_ENTRY', 'VAN_LOAD', 'RETURN_RESTOCK', 'SUPPLIER_ENTRY'] as const satisfies readonly ReconcileCursorSource[];
export const ALL_RECONCILED_SOURCES = [...RECONCILED_SOURCES, ...INVENTORY_RECONCILED_SOURCES] as const;
export type ReconciledSource = (typeof ALL_RECONCILED_SOURCES)[number];

/** مصادر المُطابِق القائمة (M3 + USER_SETTLEMENT) — كما كانت */
export function isReconciledSource(s: string): s is (typeof RECONCILED_SOURCES)[number] {
  return (RECONCILED_SOURCES as readonly string[]).includes(s);
}

/** «ربط الدفاتر» L6: أي مصدر يقرؤه المُطابِق لشركةٍ ما (ومنها مصادر المخزون والمشتريات للمربوطة) */
export function isAnyReconciledSource(s: string): s is ReconciledSource {
  return (ALL_RECONCILED_SOURCES as readonly string[]).includes(s);
}

/**
 * هل يقرأ المُطابِق هذا المصدر لهذه الشركة؟ الثلاثة القديمة لكل شركة مفعّلة كما اليوم، وUSER_SETTLEMENT للمربوطة وحدها
 * (D13) — فلا استعلام زائد ولا حدث جديد لغيرها ولو وُجد مؤشره خطأً.
 */
export function reconciledSourceEnabled(source: ReconciledSource, opts: { linked?: boolean; inventoryPosting?: boolean } | null | undefined): boolean {
  if ((INVENTORY_RECONCILED_SOURCES as readonly string[]).includes(source)) return opts?.linked === true && opts?.inventoryPosting === true;
  return source !== 'USER_SETTLEMENT' || opts?.linked === true;
}

// ═══ الصفوف كما تُقرأ ═══

/** account_entries */
export interface AccountEntrySourceRow {
  id: string;
  customerId: string;
  invoiceId: string | null;
  receiptId: string | null;
  type: string;
  debit: number;
  credit: number;
  description: string | null;
  entryDate: Date;
  createdAt: Date;
}

/** rep_settlements */
export interface RepSettlementSourceRow {
  id: string;
  salesRepId: string;
  amount: number;
  method: string;
  note: string | null;
  settledAt: Date;
  createdAt: Date;
  /**
   * «ربط الدفاتر» L5 (C12): مستخدم الشركة الذي استلم (Admin.id) ⇒ P7 إلى 111004 للمربوطة. اختياري في النوع لأن صفوف
   * الـtombstone والافتتاح القديمة لا تحمله؛ الغائب = null (لا مستلِم).
   */
  receivedByUserId?: string | null;
}

/** user_settlements («ربط الدفاتر» L5، C14) — توريد مستخدم الشركة ما في عهدته */
export interface UserSettlementSourceRow {
  id: string;
  fromUserId: string;
  amount: number;
  method: string;
  note: string | null;
  receivedBy: string | null;
  receivedByUserId: string | null;
  settledAt: Date;
  createdAt: Date;
}

/** settlement_entries */
export interface SettlementEntrySourceRow {
  id: string;
  kind: string;
  amount: number;
  feeNet: number | null;
  feeVat: number | null;
  linkId: string | null;
  payoutId: string | null;
  note: string | null;
  createdAt: Date;
}

/** بند حركة مستودع أو سيارة كما يُقرأ مع صفّه (L6) */
export interface StockItemRow {
  id: string;
  qty: number;
  baseQty: number | null;
}

/** warehouse_entries («ربط الدفاتر» L6) */
export interface WarehouseEntrySourceRow {
  id: string;
  type: string;
  source: string | null;
  reason: string | null;
  zeroRunId: string | null;
  vendorId: string | null;
  supplierRef: string | null;
  note: string | null;
  billDate: Date | null;
  totalMilli: bigint | null;
  createdAt: Date;
  items: StockItemRow[];
}

/** van_loads («ربط الدفاتر» L6) */
export interface VanLoadSourceRow {
  id: string;
  type: string;
  reason: string | null;
  zeroRunId: string | null;
  salesRepId: string | null;
  deletedSalesRepId: string | null;
  note: string | null;
  createdAt: Date;
  items: StockItemRow[];
}

/** invoice_restock_logs («ربط الدفاتر» L6) */
export interface RestockLogSourceRow {
  id: string;
  invoiceId: string;
  previous: boolean;
  returnToStock: boolean;
  createdAt: Date;
}

/** supplier_ledger_entries («ربط الدفاتر» L6) */
export interface SupplierEntrySourceRow {
  id: string;
  vendorId: string;
  kind: string;
  amountMilli: bigint;
  netMilli: bigint | null;
  taxMilli: bigint | null;
  warehouseEntryId: string | null;
  supplierPaymentId: string | null;
  reversesId: string | null;
  docDate: Date;
  dueDate: Date | null;
  ref: string | null;
  note: string | null;
  createdAt: Date;
}

export interface SourceRowMap {
  ACCOUNT_ENTRY: AccountEntrySourceRow;
  REP_SETTLEMENT: RepSettlementSourceRow;
  SETTLEMENT_ENTRY: SettlementEntrySourceRow;
  USER_SETTLEMENT: UserSettlementSourceRow;
  WAREHOUSE_ENTRY: WarehouseEntrySourceRow;
  VAN_LOAD: VanLoadSourceRow;
  RETURN_RESTOCK: RestockLogSourceRow;
  SUPPLIER_ENTRY: SupplierEntrySourceRow;
}
export type SourceRow = SourceRowMap[ReconciledSource];

// ═══ الحقائق المحمَّلة بالمفتاح الأساسي لصفوف الصفحة ═══

export interface InvoiceItemFacts {
  productId: string | null;
  categoryId: string | null;
  qty: number;
  unitPrice: number;
  taxPct: number;
  taxAmt: number;
  lineTotal: number;
  vatCategory: string | null;
  /** «ربط الدفاتر» L4: InvoiceItem.baseQty (null = صفّ سبق الميزة ⇒ qty × unitFactor) */
  baseQty?: number | null;
  /** InvoiceItem.unitFactor (الافتراضي 1) */
  unitFactor?: number | null;
  /** لقطة الاسم: itemName ?? product.name */
  productName?: string | null;
}

/** invoice.findMany({where:{tenantId, id:{in}}}) — Invoice.type لا يتغير بعد الإنشاء */
export interface InvoiceFacts {
  id: string;
  number: string | null;
  type: string;
  customerId: string;
  salesRepId: string | null;
  pricesIncludeTax: boolean;
  subtotal: number;
  discountAmt: number;
  taxAmt: number;
  total: number;
  dueDate: Date | null;
  customerName: string | null;
  salesRepName: string | null;
  /** «إزالة الضريبة»: Invoice.taxFree — يدخل الحمولة حين يكون true وحده (الغائب/false = حمولة اليوم حرفاً) */
  taxFree?: boolean | null;
  items: readonly InvoiceItemFacts[];
  // ── «ربط الدفاتر» L4 (تدخل حمولة المربوطة وحدها) ──
  /** Invoice.invoiceDate — أساس الاستحقاق الافتراضي (D9): يومه بتوقيت الشركة + paymentDays، كقاعدة الإصدار B1 */
  invoiceDate?: Date;
  /** ختم «البيع النقدي تحصيل لدى المندوب» (OD2) */
  cashCollectedByRep?: boolean | null;
  /** InvoiceInstallment (B2) — المبلغ حصّة القسط شاملة الضريبة */
  installments?: readonly { seq: number; dueDate: Date; amount: number }[];
  /** Customer.paymentDays لحظة الاشتقاق (D9) */
  customerPaymentDays?: number | null;
  /** مرتجع المرحلة الأولى المرتبط: ما أسقطه من متبقّي فاتورة بيعه */
  remainingApplied?: number | null;
  /** فاتورة البيع للمرتجع المرتبط: items.returnOfItemId ⇒ InvoiceItem.invoiceId (أول بند مرتبط) */
  saleInvoiceId?: string | null;
  /** CREDIT_NOTE | DEBIT_NOTE | INVOICE | null */
  documentKind?: string | null;
  originalInvoiceId?: string | null;
}

export interface ReceiptFacts {
  id: string;
  number: string | null;
  customerId: string;
  salesRepId: string | null;
  paymentMethod: string;
  amount: number;
  customerName: string | null;
  salesRepName: string | null;
  /** CustomerPaymentLink.receiptId = receipt.id (لا clientRef) */
  paylinkId: string | null;
  /** SettlementEntry kind=REFUND للرابط (الأحدث) */
  refund: { entryId: string; amount: number } | null;
  // ── «ربط الدفاتر» L5 (تدخل حمولة المربوطة وحدها) ──
  /** Receipt.paymentMethodKey — الطريقة المخصّصة c_… (D3) */
  paymentMethodKey?: string | null;
  /** CardPayment.id حيث CardPayment.receiptId = receipt.id (C4: البطاقة إلى 112007 لا العهدة) */
  cardPaymentId?: string | null;
  /** ReceiptInvoice (C16 ⇒ المطابقة الجزئية L8) */
  allocations?: readonly { id: string; invoiceId: string; amount: number }[];
  /** Receipt.cancelRefundFrom (C11) */
  cancelRefundFrom?: string | null;
  cancelRefundUserId?: string | null;
  /** لقطة اسم المستخدم (Admin.name) لـcancelRefundUserId */
  cancelRefundUserName?: string | null;
}

export interface PayoutFacts {
  id: string;
  bankReference: string | null;
}

/** ما يحتاجه الاشتقاق غير الصفوف */
export interface DeriveContext {
  timezone: string;
  /** عملة الشركة لحظة الكشف (لقطة الحمولة) */
  currency: string;
  currencyDecimals: number;
  invoices?: ReadonlyMap<string, InvoiceFacts>;
  receipts?: ReadonlyMap<string, ReceiptFacts>;
  /** لقطة اسم العميل لصفوف AR_ENTRY (الالتزام 7) */
  customerNames?: ReadonlyMap<string, string>;
  salesRepNames?: ReadonlyMap<string, string>;
  payouts?: ReadonlyMap<string, PayoutFacts>;
  /** «ربط الدفاتر» (D1): الدفاتر المربوطة المفعّلة — وحدها تُكتب لها حقول الحمولة الجديدة وأحداث USER_SETTLEMENT وPAYLINK_REFUND */
  linked?: boolean;
  /** Admin.id ⇒ الاسم (المستلِم في P7، وصاحب التوريد في USER_SETTLEMENT، ومستخدم الاسترداد) */
  userNames?: ReadonlyMap<string, string>;
  /** SETTLEMENT_ENTRY REFUND: linkId ⇒ {receiptId, customerId, customerName} */
  refundLinks?: ReadonlyMap<string, { receiptId: string | null; customerId: string | null; customerName: string | null }>;
  // ── «ربط الدفاتر» L6 (المربوطة بالجرد المستمر وحدها) ──
  /** أحداث المخزون والمشتريات وتكلفة المبيعات */
  inventoryPosting?: boolean;
  /** ACCOUNT_ENTRY: بنود الفواتير بمعرّفاتها (أحداث COGS) */
  costItems?: ReadonlyMap<string, readonly CostItemFacts[]>;
  /** RETURN_RESTOCK: فاتورة المرتجع، ورقم التبديل لكل صفّ (ترتيبه بين صفوف فاتورته بـ(createdAt, id)، من 1) */
  restockInvoices?: ReadonlyMap<string, RestockInvoiceFacts>;
  restockGenerations?: ReadonlyMap<string, number>;
  /** gl_vendors.id ⇒ الاسم */
  vendorNames?: ReadonlyMap<string, string>;
  /** SUPPLIER_ENTRY: سندات الصرف وحركات المستودع المرتبطة */
  supplierPayments?: ReadonlyMap<string, { id: string; number: number | null; method: string; salesRepId: string | null }>;
  supplierWarehouse?: ReadonlyMap<string, SupplierEntryWarehouseFacts>;
}

/** بند فاتورة لأحداث التكلفة (L6) */
export interface CostItemFacts {
  id: string;
  invoiceId: string;
  productId: string | null;
  qty: number;
  baseQty: number | null;
  unitFactor: number | null;
  returnExpired: boolean | null;
  categoryId: string | null;
}

/** فاتورة المرتجع لحدث تبديل «الإعادة للمخزون» (L6) */
export interface RestockInvoiceFacts {
  id: string;
  number: string | null;
  type: string;
  salesRepId: string | null;
  salesRepName: string | null;
  /** isDamagedVanReturn: مرتجع تالف لا يعود للمخزون أبداً */
  damaged: boolean;
  items: readonly CostItemFacts[];
}

// ═══ أدوات ═══

/** مبلغ نصي بمنازل العملة (Json لا يحمل BigInt، §5.2) */
export function amountText(v: number | string | null | undefined, decimals: number): string {
  return formatMilli(toMilli(Number(v ?? 0), decimals), decimals);
}

const iso = (d: Date): string => d.toISOString();

function heldNote(detail: string): string {
  return encodeEventNote({ kind: 'HELD', reason: 'UNEXPECTED_ENTRY_SHAPE', detail });
}

/** تخطيط صف واحد (بلا جيرانه) */
export interface AccountEntryPlan {
  sourceType: Extract<SourceType, 'INVOICE' | 'RECEIPT' | 'AR_ENTRY'>;
  sourceId: string;
  event: Extract<SourceEvent, 'POST' | 'REVERSE'>;
  sourceKey: string;
  /** الصف الأساسي للمفتاح (يحدد effectAt) */
  primary: boolean;
  /** سبب HELD(UNEXPECTED_ENTRY_SHAPE) أو null */
  unexpected: string | null;
}

const POSTING_TYPES_BY_INVOICE: Readonly<Record<InvoiceKind, { post: readonly string[]; reverse: readonly string[]; primaryPost: string; primaryReverse: string }>> = {
  CASH: { post: ['INVOICE_DEBIT', 'RECEIPT_CREDIT'], reverse: ['INVOICE_CREDIT', 'RECEIPT_DEBIT'], primaryPost: 'INVOICE_DEBIT', primaryReverse: 'INVOICE_CREDIT' },
  CREDIT: { post: ['INVOICE_DEBIT'], reverse: ['INVOICE_CREDIT'], primaryPost: 'INVOICE_DEBIT', primaryReverse: 'INVOICE_CREDIT' },
  RETURN: { post: ['INVOICE_CREDIT'], reverse: ['INVOICE_DEBIT'], primaryPost: 'INVOICE_CREDIT', primaryReverse: 'INVOICE_DEBIT' },
};

/** الحدث المرجّح لنوع صف حين لا يُعرف نوع المستند: جانب «الإنشاء» ترحيل، والمقابل عكس */
function likelyEvent(type: string): 'POST' | 'REVERSE' {
  return type === 'INVOICE_CREDIT' || type === 'RECEIPT_DEBIT' || type === 'ADJUSTMENT_CREDIT' ? 'REVERSE' : 'POST';
}

/** تخطيط صف account_entries (§5.2) — عديم الحالة */
export function planAccountEntry(row: AccountEntrySourceRow, invoices?: ReadonlyMap<string, InvoiceFacts>, receipts?: ReadonlyMap<string, ReceiptFacts>): AccountEntryPlan {
  const t = row.type;
  if (row.invoiceId) {
    const id = row.invoiceId;
    const mk = (event: 'POST' | 'REVERSE', primary: boolean, unexpected: string | null): AccountEntryPlan =>
      ({ sourceType: 'INVOICE', sourceId: id, event, sourceKey: invoiceKey(id, event), primary, unexpected });
    if (row.receiptId) return mk(likelyEvent(t), false, `صف ${row.id} (${t}) يحمل فاتورة وسنداً معاً`);
    const inv = invoices?.get(id);
    if (!inv) return mk(likelyEvent(t), false, `صف ${row.id} (${t}) لفاتورة مفقودة ${id}`);
    const kind = inv.type as InvoiceKind;
    if (!INVOICE_KINDS.includes(kind)) return mk(likelyEvent(t), false, `صف ${row.id} (${t}) لفاتورة بنوع غير معروف ${inv.type}`);
    const rule = POSTING_TYPES_BY_INVOICE[kind];
    if (rule.post.includes(t)) return mk('POST', t === rule.primaryPost, null);
    if (rule.reverse.includes(t)) return mk('REVERSE', t === rule.primaryReverse, null);
    return mk(likelyEvent(t), false, `صف ${row.id} (${t}) على فاتورة ${kind}`);
  }
  if (row.receiptId) {
    const id = row.receiptId;
    const mk = (event: 'POST' | 'REVERSE', primary: boolean, unexpected: string | null): AccountEntryPlan =>
      ({ sourceType: 'RECEIPT', sourceId: id, event, sourceKey: receiptKey(id, event), primary, unexpected });
    if (!receipts?.get(id)) return mk(likelyEvent(t), false, `صف ${row.id} (${t}) لسند مفقود ${id}`);
    if (t === 'RECEIPT_CREDIT') return mk('POST', true, null);
    if (t === 'RECEIPT_DEBIT') return mk('REVERSE', true, null);
    return mk(likelyEvent(t), false, `صف ${row.id} (${t}) على سند`);
  }
  const unexpected = t === 'ADJUSTMENT_DEBIT' || t === 'ADJUSTMENT_CREDIT' ? null : `صف ${row.id} (${t}) بلا فاتورة ولا سند`;
  return { sourceType: 'AR_ENTRY', sourceId: row.id, event: 'POST', sourceKey: arEntryKey(row.id, 'POST'), primary: true, unexpected };
}

interface KeyGroup {
  plan: AccountEntryPlan;
  rows: AccountEntrySourceRow[];
  primaryRows: AccountEntrySourceRow[];
  unexpected: string[];
}

function minDate(rows: readonly { entryDate: Date }[]): Date {
  return rows.reduce((m, r) => (r.entryDate.getTime() < m.getTime() ? r.entryDate : m), rows[0].entryDate);
}

function maxCreated(rows: readonly { createdAt: Date }[]): Date {
  return rows.reduce((m, r) => (r.createdAt.getTime() > m.getTime() ? r.createdAt : m), rows[0].createdAt);
}

function vatCategoryOf(v: string | null): VatCategory | null {
  return v && (VAT_CATEGORIES as readonly string[]).includes(v) ? (v as VatCategory) : null;
}

// ═══ دوال الحمولة المشتركة (المُطابِق وpostingStore.loadSourceData — مصدر واحد، العقد §3.2) ═══

/** مصادر ردّ المال عند إلغاء السند (C11) — قيمة غير معروفة في الصف لا تدخل الحمولة (دفاعاً: الـbuilder يعكس بالمرآة حينها) */
const CANCEL_REFUND_SOURCES = ['REP_CUSTODY', 'USER_CUSTODY', 'MAIN_CASH', 'BANK', 'METHOD'] as const;
type CancelRefundSource = (typeof CANCEL_REFUND_SOURCES)[number];

function cancelRefundSourceOf(v: string | null | undefined): CancelRefundSource | null {
  return v && (CANCEL_REFUND_SOURCES as readonly string[]).includes(v) ? (v as CancelRefundSource) : null;
}

/** كمية الأساس بلا غبار طفو (2.5 × 6 = 15، 0.1 × 3 = 0.3): ست منازل كـclean في التشغيل */
function cleanQty(x: number): number {
  const r = Math.round(x * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * InvoiceItem.baseQty ?? qty × unitFactor (العقد §4.1). null حين لم تُحمَّل الوحدة أصلاً (حقائق ناقصة: لا تخمين بمعامل 1 لبند
 * قد يكون كرتوناً) أو تعذّر رقم منتهٍ — فلا يُكتب الحقل.
 */
function linkedBaseQty(it: InvoiceItemFacts): number | null {
  if (it.baseQty != null) return Number.isFinite(Number(it.baseQty)) ? cleanQty(Number(it.baseQty)) : null;
  if (it.unitFactor == null) return null;
  const raw = Number(it.qty) * Number(it.unitFactor);
  return Number.isFinite(raw) ? cleanQty(raw) : null;
}

/** أيام الاستحقاق من Customer.paymentDays (D9): عدد صحيح ≥ 0، وإلا null (لا استحقاق مشتق) */
function derivedPaymentDays(d: number | null | undefined): number | null {
  if (typeof d !== 'number' || !Number.isFinite(d)) return null;
  return Math.max(0, Math.trunc(d));
}

/** الأقساط بالترتيب (B2): الاستحقاق تاريخ محلي بتوقيت الشركة، والمبلغ كما خُزّن (invoicePayloadFromRows يكتبه نصاً نصف-لأعلى لكل قسط) */
function linkedInstallments(inv: InvoiceFacts, tz: string): { seq: number; dueDate: LocalDate; amount: number }[] {
  if (!inv.installments || inv.installments.length === 0) return [];
  return [...inv.installments]
    .sort((a, b) => Number(a.seq) - Number(b.seq))
    .map((i) => ({ seq: Number(i.seq), dueDate: localDate(i.dueDate, tz), amount: Number(i.amount) }));
}

/**
 * ما يُسقطه المستند من ذمة أصله (L8):
 *  - مرتجع مرتبط أسقط من متبقّي بيعه (remainingApplied > 0 بمنازل العملة) ⇒ {فاتورة البيع، المبلغ المُسقَط بعينه}.
 *  - إشعار دائن (المرحلة الثانية) على أصله ⇒ {الأصل، null}: لا يخزّن ما أسقطه (D8)، فالمطابقة بحدّ المفتوح لحظة الترحيل.
 * الإشعار المدين وغير المرتبط ⇒ null.
 */
function linkedAppliesTo(inv: InvoiceFacts, dec: number): { invoiceId: string; amount: number | null } | null {
  if (inv.type !== 'RETURN') return null;
  const applied = Number(inv.remainingApplied ?? 0);
  if (Number.isFinite(applied) && applied > 0 && inv.saleInvoiceId && toMilli(applied, dec) > 0n) return { invoiceId: inv.saleInvoiceId, amount: applied };
  if (inv.documentKind === 'CREDIT_NOTE' && inv.originalInvoiceId) return { invoiceId: inv.originalInvoiceId, amount: null };
  return null;
}

/** مدخلات invoicePayloadFromRows الإضافية للمربوطة (D1) — يكتبها هو حين تحمل قيمة؛ وهنا يتقرّر «متى» وحده (العقد §4.2) */
interface LinkedInvoiceInputs {
  dueDate: LocalDate | null;
  cashCollectedByRep: boolean | null;
  installments: { seq: number; dueDate: LocalDate; amount: number }[] | null;
  dueDateDerived: boolean | null;
  appliesTo: { invoiceId: string; amount: number | null } | null;
}

function linkedInvoiceInputs(inv: InvoiceFacts, entryDate: LocalDate, ctx: DeriveContext): LinkedInvoiceInputs {
  const tz = ctx.timezone;
  const stored = inv.dueDate ? localDate(inv.dueDate, tz) : null;
  const installments = linkedInstallments(inv, tz);
  let dueDate = stored;
  let dueDateDerived: boolean | null = null;
  // D9: آجلة بلا استحقاق ولا أقساط ⇒ يوم الفاتورة (بتوقيت الشركة، كقاعدة الإصدار B1) + paymentDays؛ والأقساط تحمل استحقاقاتها
  if (stored === null && inv.type === 'CREDIT' && installments.length === 0) {
    const days = derivedPaymentDays(inv.customerPaymentDays);
    if (days !== null) {
      dueDate = addDays(inv.invoiceDate ? localDate(inv.invoiceDate, tz) : entryDate, days);
      dueDateDerived = true;
    }
  }
  return {
    dueDate,
    cashCollectedByRep: inv.cashCollectedByRep === true ? true : null,
    installments: installments.length > 0 ? installments : null,
    dueDateDerived,
    appliesTo: linkedAppliesTo(inv, ctx.currencyDecimals),
  };
}

/**
 * INVOICE:<id>:POST — حمولة اليوم حرفاً (invoicePayloadFromRows + sourceCreatedAt)، ومعها حقول L4 للمربوطة وحدها: الختم،
 * والأقساط، والاستحقاق المشتق، وappliesTo، وفي البنود baseQty وproductName. entryDate: التاريخ المحلي للصف الأساسي.
 * يرمي RangeError لنوع فاتورة غير معروف (كـinvoicePayloadFromRows).
 */
export function invoicePostEventPayload(inv: InvoiceFacts, entryDate: LocalDate, ctx: DeriveContext, sourceCreatedAt: string | null): InvoicePostEventPayload {
  const tz = ctx.timezone;
  const dec = ctx.currencyDecimals;
  const lf = ctx.linked === true ? linkedInvoiceInputs(inv, entryDate, ctx) : null;
  return {
    ...invoicePayloadFromRows({
      invoice: {
        id: inv.id, number: inv.number, type: inv.type, customerId: inv.customerId, salesRepId: inv.salesRepId,
        pricesIncludeTax: inv.pricesIncludeTax, subtotal: inv.subtotal, discountAmt: inv.discountAmt, taxAmt: inv.taxAmt, total: inv.total,
        taxFree: inv.taxFree,
      },
      items: inv.items.map((it) => ({
        productId: it.productId, categoryId: it.categoryId, qty: it.qty, unitPrice: it.unitPrice,
        taxPct: it.taxPct, taxAmt: it.taxAmt, lineTotal: it.lineTotal, vatCategory: vatCategoryOf(it.vatCategory),
        ...(lf ? { baseQty: linkedBaseQty(it), productName: it.productName ?? null } : {}),
      })),
      customerName: inv.customerName,
      salesRepName: inv.salesRepName,
      entryDate,
      dueDate: lf ? lf.dueDate : inv.dueDate ? localDate(inv.dueDate, tz) : null,
      currency: ctx.currency,
      currencyDecimals: dec,
      ...(lf ? {
        cashCollectedByRep: lf.cashCollectedByRep, installments: lf.installments, dueDateDerived: lf.dueDateDerived, appliesTo: lf.appliesTo,
      } : {}),
    }),
    sourceCreatedAt,
  };
}

/** RECEIPT:<id>:POST — حمولة اليوم حرفاً، ومعها للمربوطة: paymentMethodKey وcardPaymentId وallocations (≥1) */
export function receiptPostEventPayload(r: ReceiptFacts, entryDate: LocalDate, ctx: DeriveContext, sourceCreatedAt: string | null): ReceiptPostEventPayload {
  const dec = ctx.currencyDecimals;
  const p: ReceiptPostEventPayload = {
    receiptId: r.id, number: r.number, entryDate,
    salesRepId: r.salesRepId, paymentMethod: r.paymentMethod, amount: amountText(r.amount, dec), customerId: r.customerId,
    paylinkId: r.paylinkId,
    customerName: r.customerName, salesRepName: r.salesRepName, sourceCreatedAt,
  };
  if (ctx.linked !== true) return p;
  // التخصيصات بترتيب المعرّف (ثابت عبر إعادة الاشتقاق)؛ الصفرية لا أثر لها في المطابقة فلا تُكتب
  const allocations = [...(r.allocations ?? [])]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((a) => ({ id: a.id, invoiceId: a.invoiceId, amount: amountText(a.amount, dec) }))
    .filter((a) => toMilli(a.amount, dec) !== 0n);
  return {
    ...p,
    ...(r.paymentMethodKey ? { paymentMethodKey: r.paymentMethodKey } : {}),
    ...(r.cardPaymentId ? { cardPaymentId: r.cardPaymentId } : {}),
    ...(allocations.length > 0 ? { allocations } : {}),
  };
}

/** RECEIPT:<id>:REVERSE — حمولة اليوم حرفاً، ومعها للمربوطة مصدر ردّ المال (C11) ومستخدمه ولقطة اسمه */
export function receiptReverseEventPayload(r: ReceiptFacts, entryDate: LocalDate, ctx: DeriveContext, sourceCreatedAt: string | null): ReceiptReverseEventPayload {
  const dec = ctx.currencyDecimals;
  const p: ReceiptReverseEventPayload = {
    receiptId: r.id, entryDate, paymentMethod: r.paymentMethod,
    paylinkId: r.paylinkId, refundEntryId: r.refund?.entryId ?? null,
    refundedAmount: r.refund ? amountText(r.refund.amount, dec) : null,
    sourceCreatedAt,
  };
  if (ctx.linked !== true) return p;
  const from = cancelRefundSourceOf(r.cancelRefundFrom);
  const userId = r.cancelRefundUserId ?? null;
  const userName = r.cancelRefundUserName ?? (userId ? ctx.userNames?.get(userId) ?? null : null);
  return {
    ...p,
    ...(from ? { cancelRefundFrom: from } : {}),
    ...(userId ? { cancelRefundUserId: userId } : {}),
    ...(userName ? { cancelRefundUserName: userName } : {}),
  };
}

function accountEntryPayload(g: KeyGroup, effectAt: Date, ctx: DeriveContext): SourceEventPayload | null {
  const { plan } = g;
  const tz = ctx.timezone;
  const dec = ctx.currencyDecimals;
  const sourceCreatedAt = iso(maxCreated(g.rows));
  const entryDate = localDate(effectAt, tz);
  if (plan.sourceType === 'INVOICE') {
    const inv = ctx.invoices?.get(plan.sourceId);
    if (!inv || !INVOICE_KINDS.includes(inv.type as InvoiceKind)) return null;
    if (plan.event === 'REVERSE') {
      /* عكس نقديّ بلا شقّ التحصيل (ZATCA Z5.4 / قرار المالك Q1). الدليل **وسمُ صفّ العكس نفسه**: كاتب Q1 وحده يكتب
       * `CASH_VOID_KEEP_COLLECTION_NOTE` على صفّ INVOICE_CREDIT، والوسم ثابتٌ بعد الكتابة فلا يقلب اشتقاقاً سابقاً.
       * (مرآة الفاتورة لا تصلح دليلاً — مراجعة عدائية ٢: تُكتب بعد صفوف الدفتر بزمنٍ عشوائيّ، فإعادةُ اشتقاقٍ لاحقة
       * كانت تُرحّل عكساً جزئياً فوق عكسٍ كامل ويتباعد حساب الذمم عن دفتر العملاء بمقدار الفاتورة.)
       * وصفُّ RECEIPT_DEBIT في المجموعة يمنع الجزئية مهما كان الوسم: وجودُه يعني أنّ التحصيل عُكس فعلاً. */
      const keepCashLeg = inv.type === 'CASH'
        && g.rows.some((r) => r.type === 'INVOICE_CREDIT' && r.description === CASH_VOID_KEEP_COLLECTION_NOTE)
        && !g.rows.some((r) => r.type === 'RECEIPT_DEBIT');
      const p: InvoiceReverseEventPayload = {
        invoiceId: inv.id, type: inv.type as InvoiceKind, entryDate, sourceCreatedAt, ...(keepCashLeg ? { keepCashLeg: true } : {}),
      };
      return p;
    }
    return invoicePostEventPayload(inv, entryDate, ctx, sourceCreatedAt);
  }
  if (plan.sourceType === 'RECEIPT') {
    const r = ctx.receipts?.get(plan.sourceId);
    if (!r) return null;
    if (plan.event === 'POST') return receiptPostEventPayload(r, entryDate, ctx, sourceCreatedAt);
    return receiptReverseEventPayload(r, entryDate, ctx, sourceCreatedAt);
  }
  // AR_ENTRY: صف واحد لكل مفتاح
  const row = g.rows[0];
  return arEntryPayload(row, ctx.customerNames?.get(row.customerId) ?? null, dec, { sourceCreatedAt });
}

/** حمولة AR_ENTRY (§5.2، §5.3) — يستعملها المُطابِق والـtombstone معاً */
export function arEntryPayload(
  row: Pick<AccountEntrySourceRow, 'id' | 'customerId' | 'debit' | 'credit' | 'description' | 'entryDate' | 'createdAt'>,
  customerName: string | null,
  decimals: number,
  extra: { sourceCreatedAt?: string | null; batchId?: string | null } = {},
): ArEntryEventPayload {
  return {
    entryId: row.id,
    customerId: row.customerId,
    customerName: customerName ?? null,
    debit: amountText(row.debit, decimals),
    credit: amountText(row.credit, decimals),
    description: row.description ?? null,
    entryDate: iso(row.entryDate),
    createdAt: iso(row.createdAt),
    origin: 'IMPORT',
    ...(extra.batchId ? { batchId: extra.batchId } : {}),
    sourceCreatedAt: extra.sourceCreatedAt ?? iso(row.createdAt),
  };
}

/** صفوف account_entries ⇒ أحداث مرغوبة (مفتاح واحد لكل مجموعة، بترتيب أول ظهور) */
export function deriveAccountEntryEvents(rows: readonly AccountEntrySourceRow[], ctx: DeriveContext): DesiredEvent[] {
  const groups = new Map<string, KeyGroup>();
  for (const row of rows) {
    const plan = planAccountEntry(row, ctx.invoices, ctx.receipts);
    let g = groups.get(plan.sourceKey);
    if (!g) {
      g = { plan, rows: [], primaryRows: [], unexpected: [] };
      groups.set(plan.sourceKey, g);
    }
    g.rows.push(row);
    if (plan.primary && !plan.unexpected) g.primaryRows.push(row);
    if (plan.unexpected) g.unexpected.push(plan.unexpected);
  }
  const out: DesiredEvent[] = [];
  for (const g of groups.values()) {
    const effectAt = g.primaryRows.length > 0 ? minDate(g.primaryRows) : minDate(g.rows);
    const payload = accountEntryPayload(g, effectAt, ctx);
    const ev: DesiredEvent = {
      sourceKey: g.plan.sourceKey, sourceType: g.plan.sourceType, sourceId: g.plan.sourceId, event: g.plan.event,
      effectAt, payload,
    };
    if (g.unexpected.length > 0) {
      // لا تخمين: الحدث المرجّح محجوز للمراجعة
      ev.status = 'HELD';
      ev.lastError = heldNote(g.unexpected.join('؛ ').slice(0, 900));
    }
    out.push(ev);
    // «ربط الدفاتر» L6: تكلفة البيع/المرتجع وإلغاؤهما (المربوطة بالجرد المستمر وحدها)
    if (ctx.inventoryPosting === true && g.unexpected.length === 0) {
      const cogs = cogsEventFor(g, effectAt, ctx);
      if (cogs) out.push(cogs);
    }
  }
  return out;
}

// ═══ «ربط الدفاتر» L6: المخزون والمشتريات وتكلفة المبيعات ═══

const cmpRow = (a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }): number =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** الكمية بالأساس: baseQty ?? qty × unitFactor (صفّ سبق الميزة) */
export function costItemBaseQty(it: Pick<CostItemFacts, 'qty' | 'baseQty' | 'unitFactor'>): number {
  if (it.baseQty != null && Number.isFinite(Number(it.baseQty))) return Number(it.baseQty);
  return Number(it.qty) * Number(it.unitFactor ?? 1);
}

const nonZeroStockItems = (items: readonly StockItemRow[]): string[] =>
  items.filter((i) => { const q = i.baseQty ?? i.qty; return Number.isFinite(q) && q !== 0; }).map((i) => i.id).sort();

const costRefOf = (r: { createdAt: Date; id: string }) => ({ at: iso(r.createdAt), id: r.id });

const repNamesOf = (repId: string | null, name: string | null | undefined): Record<string, string> | null =>
  repId && name ? { [repId]: name } : null;

/**
 * INVOICE:<id>:COGS (البيع OUT أو المرتجع RET) وINVOICE:<id>:COGS_REV (إلغاؤهما CANCEL/RETCANCEL) — حدث واحد لكل مجموعة صفوف
 * أساسية، بمؤشّر أقدم صفّ أساسي (المحرّك يطوي الأقدم وحده: DUPLICATE_PRIMARY_ROW). الإشعار المدين والفاتورة بلا بنود أصناف
 * موجبة ⇒ لا حدث (لا لقطة تُنتظر).
 */
function cogsEventFor(g: KeyGroup, effectAt: Date, ctx: DeriveContext): DesiredEvent | null {
  if (g.plan.sourceType !== 'INVOICE' || g.primaryRows.length === 0) return null;
  const inv = ctx.invoices?.get(g.plan.sourceId);
  if (!inv || !INVOICE_KINDS.includes(inv.type as InvoiceKind) || inv.documentKind === 'DEBIT_NOTE') return null;
  const items = (ctx.costItems?.get(inv.id) ?? []).filter((it) => !!it.productId && costItemBaseQty(it) > 0);
  if (items.length === 0) return null;
  const ret = inv.type === 'RETURN';
  const leg: CogsLeg = g.plan.event === 'POST' ? (ret ? 'RET' : 'OUT') : (ret ? 'RETCANCEL' : 'CANCEL');
  const primary = [...g.primaryRows].sort(cmpRow)[0];
  const categories: Record<string, string> = {};
  for (const it of items) if (it.categoryId) categories[it.id] = it.categoryId;
  const payload: CogsEventPayload = {
    invoiceId: inv.id, number: inv.number, invoiceType: inv.type, leg,
    salesRepId: inv.salesRepId, salesRepName: inv.salesRepName,
    entryDate: localDate(effectAt, ctx.timezone),
    costRef: costRefOf(primary),
    expectedItemIds: items.map((i) => i.id).sort(),
    repNames: repNamesOf(inv.salesRepId, inv.salesRepName),
    ...(Object.keys(categories).length > 0 ? { categories } : {}),
    sourceCreatedAt: iso(maxCreated(g.rows)),
  };
  return {
    sourceKey: g.plan.event === 'POST' ? invoiceKey(inv.id, 'COGS') : invoiceCogsRevKey(inv.id),
    sourceType: 'INVOICE', sourceId: inv.id, event: 'COGS', effectAt, payload,
  };
}

/**
 * warehouse_entries ⇒ WH_ENTRY:<id> (effectAt = createdAt، لحظة الحركة كمحرّك التكلفة). مرتجع المورّد المسعَّر بمورّد
 * (له قيد RETURN في كشف المورّد) يملكه SUPPLIER_ENTRY (قيد واحد: الذمة والمخزون والضريبة) فلا حدث هنا.
 */
export function deriveWarehouseEntryEvents(rows: readonly WarehouseEntrySourceRow[], ctx: DeriveContext): DesiredEvent[] {
  if (ctx.inventoryPosting !== true) return []; // المربوطة بالجرد المستمر وحدها
  const out: DesiredEvent[] = [];
  for (const r of rows) {
    const type = (r.type ?? '').toUpperCase();
    if (type === 'RETURN' && r.vendorId && r.totalMilli != null && r.totalMilli > 0n && r.billDate) continue;
    const expected = nonZeroStockItems(r.items);
    if (expected.length === 0) continue;
    const payload: WhEntryEventPayload = {
      entryId: r.id, type, source: r.source ?? null, reason: r.reason ?? null, zeroRunId: r.zeroRunId ?? null,
      vendorId: r.vendorId ?? null, vendorName: r.vendorId ? (ctx.vendorNames?.get(r.vendorId) ?? null) : null,
      supplierRef: r.supplierRef ?? null, note: r.note ?? null,
      entryDate: localDate(r.createdAt, ctx.timezone), costRef: costRefOf(r), expectedItemIds: expected,
      sourceCreatedAt: iso(r.createdAt),
    };
    out.push({ sourceKey: whEntryKey(r.id), sourceType: 'WH_ENTRY', sourceId: r.id, event: 'POST', effectAt: r.createdAt, payload });
  }
  return out;
}

/** van_loads ⇒ VAN_LOAD:<id>:POST. DAMAGED_OUT/EXPIRED_OUT قيمتها صفر (الشطب عند المرتجع، E5) والنوع المجهول ⇒ لا حدث */
export function deriveVanLoadEvents(rows: readonly VanLoadSourceRow[], ctx: DeriveContext): DesiredEvent[] {
  if (ctx.inventoryPosting !== true) return []; // المربوطة بالجرد المستمر وحدها
  const out: DesiredEvent[] = [];
  for (const r of rows) {
    const type = (r.type ?? '').toUpperCase();
    if (type !== 'LOAD' && type !== 'UNLOAD' && type !== 'ADJUST') continue;
    const expected = nonZeroStockItems(r.items);
    if (expected.length === 0) continue;
    const rep = r.salesRepId ?? r.deletedSalesRepId ?? null;
    const name = rep ? (ctx.salesRepNames?.get(rep) ?? null) : null;
    const payload: VanLoadEventPayload = {
      loadId: r.id, type, reason: r.reason ?? null, zeroRunId: r.zeroRunId ?? null, salesRepId: rep, salesRepName: name,
      note: r.note ?? null,
      entryDate: localDate(r.createdAt, ctx.timezone), costRef: costRefOf(r), expectedItemIds: expected,
      repNames: repNamesOf(rep, name), sourceCreatedAt: iso(r.createdAt),
    };
    out.push({ sourceKey: vanLoadKey(r.id), sourceType: 'VAN_LOAD', sourceId: r.id, event: 'POST', effectAt: r.createdAt, payload });
  }
  return out;
}

/**
 * invoice_restock_logs ⇒ INVOICE:<invoiceId>:RESTOCK:<n> (B11). صفّ بلا تبديل فعلي، ومرتجع تالف (لا يعود أبداً)، وبنود
 * منتهية الصلاحية ⇒ لا لقطة تُنتظر لها.
 */
export function deriveRestockEvents(rows: readonly RestockLogSourceRow[], ctx: DeriveContext): DesiredEvent[] {
  if (ctx.inventoryPosting !== true) return []; // المربوطة بالجرد المستمر وحدها
  const out: DesiredEvent[] = [];
  for (const r of rows) {
    if (r.previous === r.returnToStock) continue;
    const inv = ctx.restockInvoices?.get(r.invoiceId);
    const gen = ctx.restockGenerations?.get(r.id);
    if (!inv || inv.type !== 'RETURN' || inv.damaged || !gen) continue;
    const items = inv.items.filter((it) => !!it.productId && costItemBaseQty(it) > 0 && it.returnExpired !== true);
    if (items.length === 0) continue;
    const payload: RestockEventPayload = {
      logId: r.id, invoiceId: inv.id, number: inv.number, previous: r.previous, returnToStock: r.returnToStock,
      salesRepId: inv.salesRepId, salesRepName: inv.salesRepName,
      entryDate: localDate(r.createdAt, ctx.timezone), costRef: costRefOf(r), expectedItemIds: items.map((i) => i.id).sort(),
      repNames: repNamesOf(inv.salesRepId, inv.salesRepName), sourceCreatedAt: iso(r.createdAt),
    };
    out.push({ sourceKey: invoiceRestockKey(inv.id, gen), sourceType: 'RESTOCK', sourceId: inv.id, event: 'RESTOCK', effectAt: r.createdAt, payload });
  }
  return out;
}

const SUPPLIER_KINDS_NEED_ENTRY = ['BILL', 'BILL_REV', 'RETURN'] as const;
const SUPPLIER_KINDS = ['BILL', 'BILL_REV', 'PAYMENT', 'PAYMENT_REV', 'RETURN', 'REFUND_IN', 'OPENING'] as const;

/**
 * supplier_ledger_entries ⇒ SUPPLIER_ENTRY:<id> (effectAt = بداية يوم docDate بتوقيت الشركة). الفاتورة والمرتجع يلزمهما
 * حركة المستودع (القيمة من لقطاتها)، والدفعة يلزمها سندها — وغيابهما ⇒ HELD(UNEXPECTED_ENTRY_SHAPE) لا تخمين.
 */
export function deriveSupplierEntryEvents(rows: readonly SupplierEntrySourceRow[], ctx: DeriveContext): DesiredEvent[] {
  if (ctx.inventoryPosting !== true) return []; // المربوطة بالجرد المستمر وحدها
  const out: DesiredEvent[] = [];
  for (const r of rows) {
    const kind = (r.kind ?? '').toUpperCase();
    const entryDate = fromDbDate(r.docDate);
    const we = r.warehouseEntryId ? (ctx.supplierWarehouse?.get(r.warehouseEntryId) ?? null) : null;
    const pay = r.supplierPaymentId ? (ctx.supplierPayments?.get(r.supplierPaymentId) ?? null) : null;
    const repId = pay?.salesRepId ?? null;
    const repName = repId ? (ctx.salesRepNames?.get(repId) ?? null) : null;
    const paidRep = we?.paidAccountRef ? (/^REP_CUSTODY:(.+)$/.exec(we.paidAccountRef)?.[1] ?? null) : null;
    const repNames: Record<string, string> = {};
    if (repId && repName) repNames[repId] = repName;
    const paidRepName = paidRep ? ctx.salesRepNames?.get(paidRep) : null;
    if (paidRep && paidRepName) repNames[paidRep] = paidRepName;
    const payload: SupplierEntryEventPayload = {
      entryId: r.id, kind, vendorId: r.vendorId, vendorName: ctx.vendorNames?.get(r.vendorId) ?? null,
      amountMilli: r.amountMilli.toString(), netMilli: r.netMilli != null ? r.netMilli.toString() : null,
      taxMilli: r.taxMilli != null ? r.taxMilli.toString() : null,
      entryDate, dueDate: r.dueDate ? fromDbDate(r.dueDate) : null, ref: r.ref ?? null, note: r.note ?? null,
      reversesId: r.reversesId ?? null, warehouseEntry: we,
      payment: pay ? { ...pay, salesRepName: repName } : null,
      ...((SUPPLIER_KINDS_NEED_ENTRY as readonly string[]).includes(kind) && we ? { costRef: we.costRef } : {}),
      ...(Object.keys(repNames).length > 0 ? { repNames } : {}),
      sourceCreatedAt: iso(r.createdAt),
    };
    const ev: DesiredEvent = {
      sourceKey: supplierEntryKey(r.id), sourceType: 'SUPPLIER_ENTRY', sourceId: r.id, event: 'POST',
      effectAt: zonedStartOfDay(entryDate, ctx.timezone), payload,
    };
    const problem = !(SUPPLIER_KINDS as readonly string[]).includes(kind)
      ? `نوع قيد مورّد غير معروف ${kind}`
      : (SUPPLIER_KINDS_NEED_ENTRY as readonly string[]).includes(kind) && !we
        ? `قيد مورّد ${kind} بلا حركة مستودع`
        : (kind === 'PAYMENT' || kind === 'PAYMENT_REV') && !pay
          ? `قيد مورّد ${kind} بلا سند صرف`
          : null;
    if (problem) {
      ev.status = 'HELD';
      ev.lastError = heldNote(`${problem} (${r.id})`);
    }
    out.push(ev);
  }
  return out;
}

/**
 * rep_settlements ⇒ SETTLEMENT:<id>:POST (effectAt = settledAt).
 * extra.linked («ربط الدفاتر» C12): مستلِمٌ من مستخدمي الشركة ⇒ receivedByUserId ولقطة اسمه (حين تحمل قيمة) — وغيره حرفاً كما كان.
 */
export function settlementPayload(
  row: RepSettlementSourceRow, salesRepName: string | null, decimals: number,
  extra?: { receivedByName?: string | null; linked?: boolean },
): SettlementEventPayload {
  const p: SettlementEventPayload = {
    settlementId: row.id,
    amount: amountText(row.amount, decimals),
    method: row.method,
    salesRepId: row.salesRepId,
    settledAt: iso(row.settledAt),
    createdAt: iso(row.createdAt),
    note: row.note ?? null,
    salesRepName: salesRepName ?? null,
    sourceCreatedAt: iso(row.createdAt),
  };
  if (extra?.linked !== true || !row.receivedByUserId) return p;
  return {
    ...p,
    receivedByUserId: row.receivedByUserId,
    ...(extra.receivedByName ? { receivedByName: extra.receivedByName } : {}),
  };
}

export function deriveRepSettlementEvents(rows: readonly RepSettlementSourceRow[], ctx: DeriveContext): DesiredEvent[] {
  const linked = ctx.linked === true;
  return rows.map((row) => ({
    sourceKey: settlementKey(row.id, 'POST'),
    sourceType: 'SETTLEMENT',
    sourceId: row.id,
    event: 'POST',
    effectAt: row.settledAt,
    payload: settlementPayload(
      row, ctx.salesRepNames?.get(row.salesRepId) ?? null, ctx.currencyDecimals,
      linked ? { linked, receivedByName: row.receivedByUserId ? ctx.userNames?.get(row.receivedByUserId) ?? null : null } : undefined,
    ),
  }));
}

/**
 * ما تحتاجه حمولة التوريد من صفّه — UserSettlementSourceRow كاملاً أو صفّ الـtombstone قبل الحذف (الاختيارية قد تغيب).
 * receivedByUserId يُقبل ولا يدخل الحمولة (شكل UserSettlementPayload).
 */
export type UserSettlementPayloadRow = Pick<UserSettlementSourceRow, 'id' | 'fromUserId' | 'amount' | 'method' | 'settledAt' | 'createdAt'>
  & Partial<Pick<UserSettlementSourceRow, 'note' | 'receivedBy' | 'receivedByUserId'>>;

/**
 * user_settlements ⇒ حمولة USER_SETTLEMENT:<id>:POST|REVERSE («ربط الدفاتر» C14): المبلغ نص بمنازل العملة، والتاريخان ISO،
 * ولقطة اسم صاحب العهدة. الطريقة كما خُزّنت (CASH|BANK_TRANSFER|POS|CHEQUE) — الـbuilder يحلّ حسابها (D3) والمرور (D6).
 */
export function userSettlementPayload(row: UserSettlementPayloadRow, fromUserName: string | null, decimals: number): UserSettlementEventPayload {
  return {
    userSettlementId: row.id,
    fromUserId: row.fromUserId,
    fromUserName: fromUserName ?? null,
    amount: amountText(row.amount, decimals),
    method: row.method,
    settledAt: iso(row.settledAt),
    createdAt: iso(row.createdAt),
    note: row.note ?? null,
    receivedBy: row.receivedBy ?? null,
    sourceCreatedAt: iso(row.createdAt),
  };
}

/** user_settlements ⇒ USER_SETTLEMENT:<id>:POST (effectAt = settledAt) — للمربوطة وحدها (D1، D13) */
export function deriveUserSettlementEvents(rows: readonly UserSettlementSourceRow[], ctx: DeriveContext): DesiredEvent[] {
  if (ctx.linked !== true) return [];
  return rows.map((row) => ({
    sourceKey: userSettlementKey(row.id, 'POST'),
    sourceType: 'USER_SETTLEMENT',
    sourceId: row.id,
    event: 'POST',
    effectAt: row.settledAt,
    payload: userSettlementPayload(row, ctx.userNames?.get(row.fromUserId) ?? null, ctx.currencyDecimals),
  }));
}

/**
 * SettlementEntry kind=REFUND ⇒ حمولة PAYLINK_REFUND:<entryId> («ربط الدفاتر» C9). المبلغ موقَّع كما خُزّن (سالب: −المسترد)
 * كـPAYLINK_FEE وPAYOUT، والرابط ⇒ سنده (يحسم المُرحِّل به: عكسُ السند صفّى 112005 أم لا) وعميله.
 */
export function paylinkRefundPayload(
  row: SettlementEntrySourceRow,
  link: { receiptId: string | null; customerId: string | null; customerName: string | null } | null,
  decimals: number,
): PaylinkRefundEventPayload {
  return {
    entryId: row.id,
    linkId: row.linkId,
    receiptId: link?.receiptId ?? null,
    amount: amountText(row.amount, decimals),
    createdAt: iso(row.createdAt),
    customerId: link?.customerId ?? null,
    customerName: link?.customerName ?? null,
    note: row.note ?? null,
    sourceCreatedAt: iso(row.createdAt),
  };
}

/**
 * settlement_entries: FEE ⇒ PAYLINK_FEE، PAYOUT ⇒ PAYOUT، COLLECTED/REFUND ⇒ لا حدث (تغطيهما قيود السند).
 * «ربط الدفاتر» (المربوطة وحدها): REFUND ⇒ PAYLINK_REFUND:<entryId> (effectAt = createdAt).
 */
export function deriveSettlementEntryEvents(rows: readonly SettlementEntrySourceRow[], ctx: DeriveContext): DesiredEvent[] {
  const dec = ctx.currencyDecimals;
  const out = new Map<string, DesiredEvent>();
  for (const row of rows) {
    if (row.kind === 'FEE') {
      const payload: PaylinkFeeEventPayload = {
        entryId: row.id, amount: amountText(row.amount, dec),
        feeNet: row.feeNet === null ? null : amountText(row.feeNet, dec),
        feeVat: row.feeVat === null ? null : amountText(row.feeVat, dec),
        createdAt: iso(row.createdAt), linkId: row.linkId, note: row.note, sourceCreatedAt: iso(row.createdAt),
      };
      const key = paylinkFeeKey(row.id);
      if (!out.has(key)) out.set(key, { sourceKey: key, sourceType: 'PAYLINK_FEE', sourceId: row.id, event: 'POST', effectAt: row.createdAt, payload });
    } else if (row.kind === 'PAYOUT') {
      const payoutId = row.payoutId;
      const payload: PayoutEventPayload = {
        payoutId: payoutId ?? row.id, amount: amountText(row.amount, dec), createdAt: iso(row.createdAt),
        bankReference: payoutId ? (ctx.payouts?.get(payoutId)?.bankReference ?? null) : null,
        note: row.note, sourceCreatedAt: iso(row.createdAt),
      };
      const key = payoutKey(payoutId ?? row.id);
      if (out.has(key)) continue;
      const ev: DesiredEvent = { sourceKey: key, sourceType: 'PAYOUT', sourceId: payoutId ?? row.id, event: 'POST', effectAt: row.createdAt, payload };
      if (!payoutId) {
        ev.status = 'HELD';
        ev.lastError = heldNote(`صف توريد ${row.id} بلا payoutId`);
      }
      out.set(key, ev);
    } else if (row.kind === 'REFUND' && ctx.linked === true) {
      // «ربط الدفاتر» C9 (المربوطة وحدها): الاسترداد بعد إلغاء يدوي يصفّي 214002 مقابل 112005، وفي المسار العادي
      // (الاسترداد يلغي السند في معاملته) يحسمه المُرحِّل NETTED. رابطٌ مجهول أو بلا سند ⇒ HELD للمراجعة لا تخمين
      const link = row.linkId ? ctx.refundLinks?.get(row.linkId) ?? null : null;
      const key = paylinkRefundKey(row.id);
      if (out.has(key)) continue;
      const ev: DesiredEvent = {
        sourceKey: key, sourceType: 'PAYLINK_REFUND', sourceId: row.id, event: 'POST', effectAt: row.createdAt,
        payload: paylinkRefundPayload(row, link, dec),
      };
      if (!link?.receiptId) {
        ev.status = 'HELD';
        ev.lastError = heldNote(row.linkId ? `صف استرداد ${row.id} لرابط ${row.linkId} بلا سند قبض` : `صف استرداد ${row.id} بلا رابط دفع`);
      }
      out.set(key, ev);
    }
    // COLLECTED (وREFUND لغير المربوطة): لا حدث (§5.2) — تغطيهما قيود السند
  }
  return [...out.values()];
}

/** موزّع حسب المصدر */
export function deriveSourceEvents(source: ReconciledSource, rows: readonly SourceRow[], ctx: DeriveContext): DesiredEvent[] {
  switch (source) {
    case 'ACCOUNT_ENTRY': return deriveAccountEntryEvents(rows as readonly AccountEntrySourceRow[], ctx);
    case 'REP_SETTLEMENT': return deriveRepSettlementEvents(rows as readonly RepSettlementSourceRow[], ctx);
    case 'SETTLEMENT_ENTRY': return deriveSettlementEntryEvents(rows as readonly SettlementEntrySourceRow[], ctx);
    case 'USER_SETTLEMENT': return deriveUserSettlementEvents(rows as readonly UserSettlementSourceRow[], ctx);
    case 'WAREHOUSE_ENTRY': return deriveWarehouseEntryEvents(rows as readonly WarehouseEntrySourceRow[], ctx);
    case 'VAN_LOAD': return deriveVanLoadEvents(rows as readonly VanLoadSourceRow[], ctx);
    case 'RETURN_RESTOCK': return deriveRestockEvents(rows as readonly RestockLogSourceRow[], ctx);
    case 'SUPPLIER_ENTRY': return deriveSupplierEntryEvents(rows as readonly SupplierEntrySourceRow[], ctx);
  }
}

/**
 * معرّفات الحقائق اللازمة لصفحة (للتحميل بالمفتاح الأساسي).
 * «ربط الدفاتر»: linkIds لصفوف REFUND، وuserIds لمستلِمي الاستلامات (receivedByUserId) ولأصحاب توريدات العهد (fromUserId) —
 * يحمّلها المخزن للمربوطة وحدها.
 */
export function factIdsForRows(source: ReconciledSource, rows: readonly SourceRow[]): {
  invoiceIds: string[]; receiptIds: string[]; customerIds: string[]; salesRepIds: string[]; payoutIds: string[];
  linkIds: string[]; userIds: string[];
} {
  const inv = new Set<string>(), rec = new Set<string>(), cust = new Set<string>(), reps = new Set<string>(), pay = new Set<string>();
  const links = new Set<string>(), users = new Set<string>();
  if (source === 'ACCOUNT_ENTRY') {
    for (const r of rows as readonly AccountEntrySourceRow[]) {
      if (r.invoiceId) inv.add(r.invoiceId);
      else if (r.receiptId) rec.add(r.receiptId);
      else cust.add(r.customerId);
      if (r.invoiceId && r.receiptId) rec.add(r.receiptId);
    }
  } else if (source === 'REP_SETTLEMENT') {
    for (const r of rows as readonly RepSettlementSourceRow[]) {
      reps.add(r.salesRepId);
      if (r.receivedByUserId) users.add(r.receivedByUserId);
    }
  } else if (source === 'USER_SETTLEMENT') {
    for (const r of rows as readonly UserSettlementSourceRow[]) users.add(r.fromUserId);
  } else if ((INVENTORY_RECONCILED_SOURCES as readonly string[]).includes(source)) {
    // «ربط الدفاتر» L6: حقائق هذه المصادر يحمّلها المخزن بنفسه (reconcilerStore.prisma loadInventoryFacts)
  } else {
    for (const r of rows as readonly SettlementEntrySourceRow[]) {
      if (r.kind === 'PAYOUT' && r.payoutId) pay.add(r.payoutId);
      if (r.kind === 'REFUND' && r.linkId) links.add(r.linkId);
    }
  }
  return {
    invoiceIds: [...inv], receiptIds: [...rec], customerIds: [...cust], salesRepIds: [...reps], payoutIds: [...pay],
    linkIds: [...links], userIds: [...users],
  };
}

/** صف createMany لـgl_source_events (الحالة الافتراضية PENDING، والـtombstone لا يضبط SKIPPED أبداً) */
export interface SourceEventCreateRow {
  tenantId: string;
  sourceKey: string;
  sourceType: string;
  sourceId: string;
  event: string;
  effectAt: Date;
  payload?: unknown;
  status: string;
  skipReason?: string | null;
  lastError?: string | null;
}

export function sourceEventCreateRow(tenantId: string, e: DesiredEvent): SourceEventCreateRow {
  return {
    tenantId,
    sourceKey: e.sourceKey,
    sourceType: e.sourceType,
    sourceId: e.sourceId,
    event: e.event,
    effectAt: e.effectAt,
    ...(e.payload !== null ? { payload: e.payload } : {}),
    status: e.status ?? 'PENDING',
    ...(e.skipReason ? { skipReason: e.skipReason } : {}),
    ...(e.lastError ? { lastError: e.lastError } : {}),
  };
}
