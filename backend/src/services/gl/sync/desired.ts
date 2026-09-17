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
 */
import { localDate } from '../dates';
import { formatMilli, toMilli } from '../money';
import { invoicePayloadFromRows, INVOICE_KINDS, type InvoiceKind } from '../builders/invoice';
import { VAT_CATEGORIES, type VatCategory } from '../types';
import { encodeEventNote } from './classify';
import { arEntryKey, invoiceKey, paylinkFeeKey, payoutKey, receiptKey, settlementKey } from './keys';
import type {
  ArEntryEventPayload, DesiredEvent, InvoiceReverseEventPayload, PaylinkFeeEventPayload, PayoutEventPayload,
  ReceiptPostEventPayload, ReceiptReverseEventPayload, SettlementEventPayload, SourceEvent, SourceEventPayload,
  SourceType, SyncCursorSource,
} from './types';

// ═══ المصادر التي يقرؤها المُطابِق في M3 ═══

/** مصادر المبيعات والتحصيل (M3). WAREHOUSE_ENTRY وVAN_LOAD وRETURN_RESTOCK تصل مع M9. */
export const RECONCILED_SOURCES = ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY'] as const satisfies readonly SyncCursorSource[];
export type ReconciledSource = (typeof RECONCILED_SOURCES)[number];

export function isReconciledSource(s: string): s is ReconciledSource {
  return (RECONCILED_SOURCES as readonly string[]).includes(s);
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

export interface SourceRowMap {
  ACCOUNT_ENTRY: AccountEntrySourceRow;
  REP_SETTLEMENT: RepSettlementSourceRow;
  SETTLEMENT_ENTRY: SettlementEntrySourceRow;
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
  items: readonly InvoiceItemFacts[];
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
      const p: InvoiceReverseEventPayload = { invoiceId: inv.id, type: inv.type as InvoiceKind, entryDate, sourceCreatedAt };
      return p;
    }
    return {
      ...invoicePayloadFromRows({
        invoice: {
          id: inv.id, number: inv.number, type: inv.type, customerId: inv.customerId, salesRepId: inv.salesRepId,
          pricesIncludeTax: inv.pricesIncludeTax, subtotal: inv.subtotal, discountAmt: inv.discountAmt, taxAmt: inv.taxAmt, total: inv.total,
        },
        items: inv.items.map((it) => ({
          productId: it.productId, categoryId: it.categoryId, qty: it.qty, unitPrice: it.unitPrice,
          taxPct: it.taxPct, taxAmt: it.taxAmt, lineTotal: it.lineTotal, vatCategory: vatCategoryOf(it.vatCategory),
        })),
        customerName: inv.customerName,
        salesRepName: inv.salesRepName,
        entryDate,
        dueDate: inv.dueDate ? localDate(inv.dueDate, tz) : null,
        currency: ctx.currency,
        currencyDecimals: dec,
      }),
      sourceCreatedAt,
    };
  }
  if (plan.sourceType === 'RECEIPT') {
    const r = ctx.receipts?.get(plan.sourceId);
    if (!r) return null;
    if (plan.event === 'POST') {
      const p: ReceiptPostEventPayload = {
        receiptId: r.id, number: r.number, entryDate,
        salesRepId: r.salesRepId, paymentMethod: r.paymentMethod, amount: amountText(r.amount, dec), customerId: r.customerId,
        paylinkId: r.paylinkId,
        customerName: r.customerName, salesRepName: r.salesRepName, sourceCreatedAt,
      };
      return p;
    }
    const p: ReceiptReverseEventPayload = {
      receiptId: r.id, entryDate, paymentMethod: r.paymentMethod,
      paylinkId: r.paylinkId, refundEntryId: r.refund?.entryId ?? null,
      refundedAmount: r.refund ? amountText(r.refund.amount, dec) : null,
      sourceCreatedAt,
    };
    return p;
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
  }
  return out;
}

/** rep_settlements ⇒ SETTLEMENT:<id>:POST (effectAt = settledAt) */
export function settlementPayload(row: RepSettlementSourceRow, salesRepName: string | null, decimals: number): SettlementEventPayload {
  return {
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
}

export function deriveRepSettlementEvents(rows: readonly RepSettlementSourceRow[], ctx: DeriveContext): DesiredEvent[] {
  return rows.map((row) => ({
    sourceKey: settlementKey(row.id, 'POST'),
    sourceType: 'SETTLEMENT',
    sourceId: row.id,
    event: 'POST',
    effectAt: row.settledAt,
    payload: settlementPayload(row, ctx.salesRepNames?.get(row.salesRepId) ?? null, ctx.currencyDecimals),
  }));
}

/** settlement_entries: FEE ⇒ PAYLINK_FEE، PAYOUT ⇒ PAYOUT، COLLECTED/REFUND ⇒ لا حدث (تغطيهما قيود السند) */
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
    }
    // COLLECTED وREFUND: لا حدث (§5.2)
  }
  return [...out.values()];
}

/** موزّع حسب المصدر */
export function deriveSourceEvents(source: ReconciledSource, rows: readonly SourceRow[], ctx: DeriveContext): DesiredEvent[] {
  switch (source) {
    case 'ACCOUNT_ENTRY': return deriveAccountEntryEvents(rows as readonly AccountEntrySourceRow[], ctx);
    case 'REP_SETTLEMENT': return deriveRepSettlementEvents(rows as readonly RepSettlementSourceRow[], ctx);
    case 'SETTLEMENT_ENTRY': return deriveSettlementEntryEvents(rows as readonly SettlementEntrySourceRow[], ctx);
  }
}

/** معرّفات الحقائق اللازمة لصفحة (للتحميل بالمفتاح الأساسي) */
export function factIdsForRows(source: ReconciledSource, rows: readonly SourceRow[]): {
  invoiceIds: string[]; receiptIds: string[]; customerIds: string[]; salesRepIds: string[]; payoutIds: string[];
} {
  const inv = new Set<string>(), rec = new Set<string>(), cust = new Set<string>(), reps = new Set<string>(), pay = new Set<string>();
  if (source === 'ACCOUNT_ENTRY') {
    for (const r of rows as readonly AccountEntrySourceRow[]) {
      if (r.invoiceId) inv.add(r.invoiceId);
      else if (r.receiptId) rec.add(r.receiptId);
      else cust.add(r.customerId);
      if (r.invoiceId && r.receiptId) rec.add(r.receiptId);
    }
  } else if (source === 'REP_SETTLEMENT') {
    for (const r of rows as readonly RepSettlementSourceRow[]) reps.add(r.salesRepId);
  } else {
    for (const r of rows as readonly SettlementEntrySourceRow[]) if (r.kind === 'PAYOUT' && r.payoutId) pay.add(r.payoutId);
  }
  return { invoiceIds: [...inv], receiptIds: [...rec], customerIds: [...cust], salesRepIds: [...reps], payoutIds: [...pay] };
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
