// «ربط الدفاتر» L4+L5+L8 — سيناريو التكامل للمُرحِّل (A6، عقد §8 A6). ليس ملف اختبار: يستعمله l458-a06-parity.test.ts،
// ويُشغَّل نفسه على شجرة master الأصلية لالتقاط مخرجات اليوم (l458-a06-legacy-golden.json) — لذا لا يستورد قيمةً جديدة
// إلا عبر استيراد الوحدة كاملة (desired/tombstone) ولا يستدعيها إلا للمربوطة.
//
// محاكٍ تشغيلي صغير يكتب ما يكتبه النظام فعلاً (صفوف account_entries وrep_settlements وuser_settlements وsettlement_entries
// وحقائق الفواتير والسندات)، ويشتقّ الأحداث بدوال المُطابِق الحقيقية (deriveSourceEvents) وخطافات الحذف الحقيقية
// (tombstone)، ثم يرحّلها المُرحِّل الحقيقي (runPoster) على المخزن المزيّف. ويوفّر المحاكي «مرايا» التشغيل التي تقارن بها
// اختبارات المطابقة R1–R7: Σ AccountEntry لكل عميل، ومدخلات عهدة المندوب (كما يقرؤها PrismaPostingTx.loadCustodyInputs)،
// ومدخلات طيّ عهدة المستخدم، وصفوف الأمانات، وصافي المبيعات وضريبتها لكل مستند.
import { CASH_VOID_KEEP_COLLECTION_NOTE } from '../lib/ledgerNotes';
import * as desired from '../services/gl/sync/desired';
import * as tombstone from '../services/gl/sync/tombstone';
import { addDays, localDate } from '../services/gl/dates';
import { formatMilli, toMilli } from '../services/gl/money';
import { accountIdOf } from '../services/gl/testing/fixtures';
import { createSyncBudget, runPoster } from '../services/gl/sync/poster';
import type { CustodyComponentsInput } from '../services/gl/custody';
import type {
  AccountEntrySourceRow, DeriveContext, InvoiceFacts, InvoiceItemFacts, ReceiptFacts, RepSettlementSourceRow, SettlementEntrySourceRow,
} from '../services/gl/sync/desired';
import type { DesiredEvent } from '../services/gl/sync/types';
import { FakePostingStore } from './gl-fake-posting-store';

export const TZ = 'Asia/Riyadh';
/** بداية الربط (linkedFrom) — كل عمليات السيناريو بعدها وبعد T0، فتُرحَّل كلها بتواريخها */
export const CUTOVER = '2026-07-01';
export const T0 = new Date('2026-06-30T21:00:00.000Z');
export const ACTIVATED = new Date(T0.getTime() + 10 * 60_000);
/** صندوق «بنك STC» الذي ربط به المحاسب الطريقة المخصّصة c_stc (E5.3) — ليس في القالب */
export const STC_BANK = '111102';
export const CAT1 = 'cat1';
/** توجيه السندات: النقد والشيك بمندوب ⇒ العهدة (OD4)، والتحويل ونقاط البيع مباشرة */
export const ROUTING = { CASH: 'CUSTODY', CHEQUE: 'CUSTODY', BANK_TRANSFER: 'DIRECT', POS: 'DIRECT' } as const;

export type Dec = 0 | 2 | 3;
/** تحجيم الأسعار لكل منازل: الريال كما هو، والعملة الصفرية ×10، والثلاثية ÷100 (فتظهر المنزلة الثالثة) */
const SCALE: Record<Dec, number> = { 0: 10, 2: 1, 3: 0.01 };

const CUSTOMERS = new Map([['c1', 'عميل أول'], ['c2', 'عميل ثانٍ'], ['c3', 'عميل ثالث']]);
const PAYMENT_DAYS: Record<string, number> = { c1: 30, c2: 0, c3: 15 };
const REPS = new Map([['r1', 'مندوب أ'], ['r2', 'مندوب ب']]);
const USERS = new Map([['u1', 'مستخدم أ'], ['u2', 'مستخدم ب']]);

/** لحظة بتوقيت الرياض: t('09-20T09:00') */
export const t = (s: string): Date => new Date(`2026-${s}:00+03:00`);

interface SimInvoice extends InvoiceFacts {
  at: Date;
  createdAt: Date;
  status: 'CONFIRMED' | 'CANCELLED';
  cancelledAt: Date | null;
  /** إبطال ZATCA يحتفظ بالنقد (Q1/C17) */
  keepCash: boolean;
}

interface SimReceipt extends ReceiptFacts {
  at: Date;
  createdAt: Date;
  cancelledAt: Date | null;
  card: boolean;
}

interface SimRepSettlement extends RepSettlementSourceRow { deletedAt: Date | null }
interface SimUserSettlement {
  id: string; fromUserId: string; amount: number; method: string; note: string | null; receivedBy: string | null;
  receivedByUserId: string | null; settledAt: Date; createdAt: Date; deletedAt: Date | null;
}

export interface ItemSpec { productId: string; productName: string; categoryId?: string | null; qty: number; unitFactor?: number; price: number; taxPct?: number }

export class Sim {
  now: number;
  readonly dec: Dec;
  readonly linked: boolean;
  store!: FakePostingStore;
  entries: AccountEntrySourceRow[] = [];
  invoices = new Map<string, SimInvoice>();
  receipts = new Map<string, SimReceipt>();
  repSettlements = new Map<string, SimRepSettlement>();
  userSettlements = new Map<string, SimUserSettlement>();
  settlementEntries: SettlementEntrySourceRow[] = [];
  links = new Map<string, { receiptId: string | null; customerId: string | null; customerName: string | null }>();
  private seq = 0;

  constructor(dec: Dec, linked: boolean) {
    this.dec = dec;
    this.linked = linked;
    this.now = t('09-01T08:00').getTime();
  }

  /** مبلغ مخزَّن (Float) مقرَّب نصف-لأعلى لمنازل العملة — كما يخزّنه التشغيل لكل مستند */
  r(x: number): number { return Number(formatMilli(toMilli(x, this.dec), this.dec)); }
  /** سعر الأساس (بالريال) محجَّماً لمنازل السيناريو */
  px(x: number): number { return this.r(x * SCALE[this.dec]); }
  m(x: number): bigint { return toMilli(x, this.dec); }
  /** وحدة العملة الصغرى (لفاتورة قديمة غير متّزنة E4.6) */
  unit(): number { return 1 / 10 ** this.dec; }

  private id(prefix: string): string { this.seq++; return `${prefix}${String(this.seq).padStart(4, '0')}`; }

  // ── الاشتقاق والبذر ──

  ctx(): DeriveContext {
    const invoices = new Map<string, InvoiceFacts>();
    for (const [k, v] of this.invoices) invoices.set(k, { ...v, items: v.items.map((i) => ({ ...i })) });
    const receipts = new Map<string, ReceiptFacts>();
    for (const [k, v] of this.receipts) receipts.set(k, { ...v });
    return {
      timezone: TZ, currency: 'SAR', currencyDecimals: this.dec, invoices, receipts,
      customerNames: new Map(CUSTOMERS), salesRepNames: new Map(REPS), payouts: new Map(),
      linked: this.linked, userNames: new Map(USERS), refundLinks: new Map(this.links),
    } as DeriveContext;
  }

  /** نبضة مُرحِّل واحدة بساعة السيناريو (المحجوب يُعاد في نبضة لاحقة بعد تقدّم الساعة) */
  async post(): Promise<void> {
    const settings = (await this.store.loadPosterSettings(this.store.tenantId))!;
    await runPoster(this.store, settings, createSyncBudget({ clock: () => this.now, timeMs: 1e12, events: 1e6 }), { log: () => undefined });
  }

  /** المُطابِق يقرأ الصفوف بعد دقيقة من كتابتها، والحقائق لحظتها */
  private seed(at: Date, events: readonly DesiredEvent[]): void {
    this.now = Math.max(this.now, at.getTime() + 60_000);
    this.store.seedEvents(events);
  }

  private addEntries(at: Date, rows: Omit<AccountEntrySourceRow, 'id' | 'createdAt' | 'entryDate'>[], entryDate: Date = at): void {
    const made = rows.map((r) => ({ ...r, id: this.id('ae'), createdAt: at, entryDate }));
    this.entries.push(...made);
    this.seed(at, desired.deriveSourceEvents('ACCOUNT_ENTRY', made, this.ctx()));
  }

  // ── الفواتير ──

  invoice(o: {
    id: string; type: 'CASH' | 'CREDIT' | 'RETURN'; customerId: string; repId: string | null; at: Date; items: ItemSpec[];
    discountPct?: number; stamped?: boolean; installments?: { seq: number; due: string; share: number }[];
    returnOf?: { saleId: string; remainingApplied: number }; extraUnits?: number;
  }): SimInvoice {
    let subtotal = 0, discount = 0, tax = 0;
    const items: InvoiceItemFacts[] = o.items.map((s) => {
      const gross = this.r(s.qty * s.price);
      const disc = this.r((gross * (o.discountPct ?? 0)) / 100);
      const net = this.r(gross - disc);
      const pct = s.taxPct ?? 15;
      const itemTax = this.r((net * pct) / 100);
      subtotal = this.r(subtotal + gross);
      discount = this.r(discount + disc);
      tax = this.r(tax + itemTax);
      return {
        productId: s.productId, categoryId: s.categoryId ?? null, qty: s.qty, unitPrice: s.price, taxPct: pct, taxAmt: itemTax,
        lineTotal: this.r(net + itemTax), vatCategory: null, baseQty: null, unitFactor: s.unitFactor ?? 1, productName: s.productName,
      };
    });
    // فاتورة قديمة غير متّزنة (E4.6): الإجمالي المخزّن يزيد وحدةً صغرى أو أكثر
    const total = this.r(subtotal - discount + tax + (o.extraUnits ?? 0) * this.unit());
    const day = localDate(o.at, TZ);
    // B1 (A8، للمربوطة وحدها): آجلة بلا أقساط ⇒ يوم الفاتورة + paymentDays يُكتب عند الإصدار
    const b1 = this.linked && o.type === 'CREDIT' && !o.installments;
    const inv: SimInvoice = {
      id: o.id, number: o.id, type: o.type, customerId: o.customerId, salesRepId: o.repId, pricesIncludeTax: false,
      subtotal, discountAmt: discount, taxAmt: tax, total,
      dueDate: b1 ? t(`${addDays(day, PAYMENT_DAYS[o.customerId]).slice(5)}T00:00`) : null,
      customerName: CUSTOMERS.get(o.customerId) ?? null, salesRepName: o.repId ? REPS.get(o.repId) ?? null : null, items,
      invoiceDate: o.at, cashCollectedByRep: o.stamped === true, customerPaymentDays: PAYMENT_DAYS[o.customerId],
      installments: o.installments?.map((i) => ({ seq: i.seq, dueDate: t(`${i.due}T00:00`), amount: this.r(total * i.share) })),
      remainingApplied: o.returnOf ? this.r(o.returnOf.remainingApplied) : null, saleInvoiceId: o.returnOf?.saleId ?? null,
      documentKind: null, originalInvoiceId: null,
      at: o.at, createdAt: o.at, status: 'CONFIRMED', cancelledAt: null, keepCash: false,
    };
    this.invoices.set(inv.id, inv);
    const c = inv.customerId;
    if (o.type === 'CREDIT') this.addEntries(o.at, [{ customerId: c, invoiceId: inv.id, receiptId: null, type: 'INVOICE_DEBIT', debit: total, credit: 0, description: null }]);
    if (o.type === 'CASH') {
      this.addEntries(o.at, [
        { customerId: c, invoiceId: inv.id, receiptId: null, type: 'INVOICE_DEBIT', debit: total, credit: 0, description: null },
        { customerId: c, invoiceId: inv.id, receiptId: null, type: 'RECEIPT_CREDIT', debit: 0, credit: total, description: null },
      ]);
    }
    if (o.type === 'RETURN') this.addEntries(o.at, [{ customerId: c, invoiceId: inv.id, receiptId: null, type: 'INVOICE_CREDIT', debit: 0, credit: total, description: null }]);
    return inv;
  }

  /** إلغاء (المرحلة الأولى) أو إبطال ZATCA يحتفظ بالنقد (keepCash: صفّ INVOICE_CREDIT الموسوم وحده) */
  cancelInvoice(id: string, at: Date, opts: { keepCash?: boolean } = {}): void {
    const inv = this.invoices.get(id)!;
    inv.status = 'CANCELLED';
    inv.cancelledAt = at;
    inv.keepCash = opts.keepCash === true;
    const c = inv.customerId;
    if (inv.type === 'CASH' && opts.keepCash) {
      this.addEntries(at, [{ customerId: c, invoiceId: id, receiptId: null, type: 'INVOICE_CREDIT', debit: 0, credit: inv.total, description: CASH_VOID_KEEP_COLLECTION_NOTE }]);
    } else if (inv.type === 'CASH') {
      this.addEntries(at, [
        { customerId: c, invoiceId: id, receiptId: null, type: 'INVOICE_CREDIT', debit: 0, credit: inv.total, description: null },
        { customerId: c, invoiceId: id, receiptId: null, type: 'RECEIPT_DEBIT', debit: inv.total, credit: 0, description: null },
      ]);
    } else if (inv.type === 'CREDIT') {
      this.addEntries(at, [{ customerId: c, invoiceId: id, receiptId: null, type: 'INVOICE_CREDIT', debit: 0, credit: inv.total, description: null }]);
    } else {
      this.addEntries(at, [{ customerId: c, invoiceId: id, receiptId: null, type: 'INVOICE_DEBIT', debit: inv.total, credit: 0, description: null }]);
    }
  }

  // ── السندات والدفع الإلكتروني ──

  receipt(o: {
    id: string; customerId: string; repId: string | null; method: string; amount: number; at: Date; methodKey?: string;
    card?: boolean; link?: string; allocations?: { invoiceId: string; amount: number }[];
  }): SimReceipt {
    const rec: SimReceipt = {
      id: o.id, number: o.id, customerId: o.customerId, salesRepId: o.repId, paymentMethod: o.method, amount: this.r(o.amount),
      customerName: CUSTOMERS.get(o.customerId) ?? null, salesRepName: o.repId ? REPS.get(o.repId) ?? null : null,
      paylinkId: o.link ?? null, refund: null, paymentMethodKey: o.methodKey ?? null, cardPaymentId: o.card ? `cp-${o.id}` : null,
      allocations: (o.allocations ?? []).map((a, i) => ({ id: `${o.id}-a${i + 1}`, invoiceId: a.invoiceId, amount: this.r(a.amount) })),
      cancelRefundFrom: null, cancelRefundUserId: null, cancelRefundUserName: null,
      at: o.at, createdAt: o.at, cancelledAt: null, card: o.card === true,
    };
    this.receipts.set(rec.id, rec);
    if (o.link) {
      this.links.set(o.link, { receiptId: rec.id, customerId: rec.customerId, customerName: rec.customerName });
      this.settlementEntries.push({ id: this.id('se'), kind: 'COLLECTED', amount: rec.amount, feeNet: null, feeVat: null, linkId: o.link, payoutId: null, note: null, createdAt: o.at });
    }
    this.addEntries(o.at, [{ customerId: rec.customerId, invoiceId: null, receiptId: rec.id, type: 'RECEIPT_CREDIT', debit: 0, credit: rec.amount, description: null }]);
    return rec;
  }

  /**
   * إلغاء السند. refund: الاسترداد العادي (يلغي السند في معاملته). refundFrom: مصدر ردّ المال (C11) — يُكتب للمربوطة وحدها
   * (القاعدة (ج): غير المربوطة لا ترسله واجهتها فلا يُكتب).
   */
  cancelReceipt(id: string, at: Date, opts: { refund?: boolean; refundFrom?: string; refundUserId?: string } = {}): void {
    const rec = this.receipts.get(id)!;
    rec.cancelledAt = at;
    if (this.linked && opts.refundFrom) {
      rec.cancelRefundFrom = opts.refundFrom;
      rec.cancelRefundUserId = opts.refundUserId ?? null;
      rec.cancelRefundUserName = opts.refundUserId ? USERS.get(opts.refundUserId) ?? null : null;
    }
    if (opts.refund && rec.paylinkId) {
      const entry: SettlementEntrySourceRow = { id: this.id('se'), kind: 'REFUND', amount: -rec.amount, feeNet: null, feeVat: null, linkId: rec.paylinkId, payoutId: null, note: null, createdAt: at };
      this.settlementEntries.push(entry);
      rec.refund = { entryId: entry.id, amount: -rec.amount };
      this.addEntries(at, [{ customerId: rec.customerId, invoiceId: null, receiptId: id, type: 'RECEIPT_DEBIT', debit: rec.amount, credit: 0, description: null }]);
      this.seed(at, desired.deriveSourceEvents('SETTLEMENT_ENTRY', [entry], this.ctx()));
      return;
    }
    this.addEntries(at, [{ customerId: rec.customerId, invoiceId: null, receiptId: id, type: 'RECEIPT_DEBIT', debit: rec.amount, credit: 0, description: null }]);
  }

  /** استرداد لاحق لسند إلكتروني أُلغي يدوياً (C9) — صف REFUND وحده */
  refundLater(receiptId: string, at: Date): void {
    const rec = this.receipts.get(receiptId)!;
    const entry: SettlementEntrySourceRow = { id: this.id('se'), kind: 'REFUND', amount: -rec.amount, feeNet: null, feeVat: null, linkId: rec.paylinkId, payoutId: null, note: null, createdAt: at };
    this.settlementEntries.push(entry);
    rec.refund = { entryId: entry.id, amount: -rec.amount };
    this.seed(at, desired.deriveSourceEvents('SETTLEMENT_ENTRY', [entry], this.ctx()));
  }

  paylinkFee(linkId: string, net: number, vat: number, at: Date): void {
    const n = this.r(net), v = this.r(vat);
    const entry: SettlementEntrySourceRow = { id: this.id('se'), kind: 'FEE', amount: -this.r(n + v), feeNet: n, feeVat: v, linkId, payoutId: null, note: null, createdAt: at };
    this.settlementEntries.push(entry);
    this.seed(at, desired.deriveSourceEvents('SETTLEMENT_ENTRY', [entry], this.ctx()));
  }

  payout(payoutId: string, amount: number, at: Date): void {
    const entry: SettlementEntrySourceRow = { id: this.id('se'), kind: 'PAYOUT', amount: -this.r(amount), feeNet: null, feeVat: null, linkId: null, payoutId, note: null, createdAt: at };
    this.settlementEntries.push(entry);
    this.seed(at, desired.deriveSourceEvents('SETTLEMENT_ENTRY', [entry], this.ctx()));
  }

  /** رصيد مستورد بعد البداية (OD12): صف ADJUSTMENT_DEBIT بلا فاتورة ولا سند */
  importBalance(customerId: string, debit: number, entryDate: Date, createdAt: Date): void {
    const row: AccountEntrySourceRow = {
      id: this.id('ae'), customerId, invoiceId: null, receiptId: null, type: 'ADJUSTMENT_DEBIT', debit: this.r(debit), credit: 0,
      description: 'رصيد مستورد', entryDate, createdAt,
    };
    this.entries.push(row);
    this.seed(createdAt, desired.deriveSourceEvents('ACCOUNT_ENTRY', [row], this.ctx()));
  }

  // ── العهد ──

  repSettlement(o: { id: string; repId: string; amount: number; method: string; at: Date; userId?: string }): void {
    const row: SimRepSettlement = {
      id: o.id, salesRepId: o.repId, amount: this.r(o.amount), method: o.method, note: null, settledAt: o.at, createdAt: o.at,
      receivedByUserId: o.userId ?? null, deletedAt: null,
    };
    this.repSettlements.set(row.id, row);
    const { deletedAt: _d, ...src } = row;
    this.seed(o.at, desired.deriveSourceEvents('REP_SETTLEMENT', [src], this.ctx()));
  }

  deleteRepSettlement(id: string, at: Date): void {
    const row = this.repSettlements.get(id)!;
    row.deletedAt = at;
    this.seed(at, tombstone.settlementTombstoneEvents(row, this.dec, { deletedAt: at, salesRepName: REPS.get(row.salesRepId) ?? null }));
  }

  userSettlement(o: { id: string; userId: string; amount: number; method: string; at: Date }): void {
    const row: SimUserSettlement = {
      id: o.id, fromUserId: o.userId, amount: this.r(o.amount), method: o.method, note: null, receivedBy: 'المالك',
      receivedByUserId: 'owner', settledAt: o.at, createdAt: o.at, deletedAt: null,
    };
    this.userSettlements.set(row.id, row);
    // المصدر الجديد للمربوطة وحدها (D13): غيرها لا مؤشر له ولا حدث
    if (!this.linked) return;
    const { deletedAt: _d, ...src } = row;
    this.seed(o.at, desired.deriveSourceEvents('USER_SETTLEMENT' as never, [src as never], this.ctx()));
  }

  deleteUserSettlement(id: string, at: Date): void {
    const row = this.userSettlements.get(id)!;
    row.deletedAt = at;
    if (!this.linked) return;
    this.seed(at, tombstone.userSettlementTombstoneEvents({ ...row, fromUserName: USERS.get(row.fromUserId) ?? null }, this.dec, { deletedAt: at }));
  }

  // ── مرايا التشغيل (كما يقرؤها PrismaPostingTx) ──

  private storedSplit(key: string): { nonCustody: bigint | null; recovered: bigint | null } {
    const e = this.store.event(key);
    if (!e || (e.status !== 'DONE' && e.status !== 'SKIPPED') || e.nonCustodyClearedMilli === null) return { nonCustody: null, recovered: null };
    return { nonCustody: e.nonCustodyClearedMilli, recovered: e.shortageRecoveredMilli };
  }

  /**
   * مدخلات عهدة المندوب كما يقرؤها loadCustodyInputs (عقد §5.6): السندات مصنّفة (البطاقة خارج العهدة دائماً)، والفاتورة النقدية
   * مختومة للمربوطة (stamped)، وإبطال «يحتفظ بالنقد» ليس عكساً (C17)، والعكس المردود من خارج العهدة (C11) معلَّم،
   * والاستلامات بتقسيمها المخزَّن.
   */
  custodyInputs(repId: string): CustodyComponentsInput {
    const out = {
      receipts: [] as object[], onlineReceipts: [] as object[], outsideReceipts: [] as object[], cashInvoices: [] as object[],
      settlements: [] as object[], shortages: [], custodyExpenses: [],
      routing: { cashInvoice: 'MAIN_CASH', receipt: { ...ROUTING }, ...(this.linked ? { stampDrivesCustody: true } : {}) },
    };
    for (const r of this.receipts.values()) {
      if (r.salesRepId !== repId) continue;
      const cls = r.paymentMethod === 'ONLINE' ? 'ONLINE'
        : !r.card && (ROUTING as Record<string, string>)[r.paymentMethod] === 'CUSTODY' ? 'CUSTODY' : 'OUTSIDE';
      const outside = this.linked && cls === 'CUSTODY' && r.cancelledAt !== null
        && r.cancelRefundFrom !== null && r.cancelRefundFrom !== 'REP_CUSTODY' && r.cancelRefundFrom !== 'METHOD';
      const item = {
        id: r.id, salesRepId: repId, amountMilli: this.m(r.amount), effectAt: r.at, createdAt: r.createdAt, reversedAt: r.cancelledAt,
        ...(outside ? { reversalOutsideCustody: true } : {}),
      };
      (cls === 'CUSTODY' ? out.receipts : cls === 'ONLINE' ? out.onlineReceipts : out.outsideReceipts).push(item);
    }
    for (const i of this.invoices.values()) {
      if (i.type !== 'CASH' || i.salesRepId !== repId) continue;
      out.cashInvoices.push({
        id: i.id, salesRepId: repId, amountMilli: this.m(i.total), effectAt: i.at, createdAt: i.createdAt,
        reversedAt: i.status === 'CANCELLED' && !i.keepCash ? i.cancelledAt : null,
        ...(this.linked && i.cashCollectedByRep ? { stamped: true } : {}),
      });
    }
    for (const s of this.repSettlements.values()) {
      if (s.salesRepId !== repId) continue;
      const v = this.storedSplit(`SETTLEMENT:${s.id}:POST`);
      out.settlements.push({
        id: s.id, salesRepId: repId, amountMilli: this.m(s.amount), effectAt: s.settledAt, createdAt: s.createdAt, reversedAt: s.deletedAt,
        nonCustodyClearedMilli: v.nonCustody, shortageRecoveredMilli: v.recovered,
      });
    }
    return out as unknown as CustodyComponentsInput;
  }

  /** مدخلات طيّ عهدة المستخدم (D6): المستلَم من المناديب، والتوريدات بتقسيمها المخزَّن، والاستردادات من عهدته */
  userCustodyInputs(userId: string): { userId: string; received: object[]; delivered: object[]; refunds: object[] } {
    const received = [...this.repSettlements.values()].filter((s) => s.receivedByUserId === userId).map((s) => ({
      id: s.id, amountMilli: this.m(s.amount), method: s.method, at: s.settledAt, createdAt: s.createdAt, reversedAt: s.deletedAt,
    }));
    const delivered = [...this.userSettlements.values()].filter((s) => s.fromUserId === userId).map((s) => ({
      id: s.id, amountMilli: this.m(s.amount), method: s.method, at: s.settledAt, createdAt: s.createdAt, reversedAt: s.deletedAt,
      storedPassThroughMilli: this.storedSplit(`USER_SETTLEMENT:${s.id}:POST`).nonCustody,
    }));
    const refunds = [...this.receipts.values()]
      .filter((r) => r.cancelledAt && r.cancelRefundFrom === 'USER_CUSTODY' && r.cancelRefundUserId === userId)
      .map((r) => ({ id: r.id, amountMilli: this.m(r.amount), at: r.cancelledAt as Date, createdAt: r.cancelledAt as Date }));
    return { userId, received, delivered, refunds };
  }
}

/** المخزن المزيّف بإعدادات السيناريو: SA_6D، منازل dec، توجيه العهدة، فئة إيراد 411002، وبنك STC (+ الخريطة للمربوطة) */
export function makeStore(sim: Sim, opts: { reconcile?: boolean } = {}): FakePostingStore {
  const linkedOpts = sim.linked
    ? {
      linked: true,
      paymentMethodMaps: { c_stc: { accountId: accountIdOf(STC_BANK), journalId: null } },
      userCustody: (u: string) => sim.userCustodyInputs(u) as never,
      ...(opts.reconcile === false ? { reconcile: false } : {}),
    }
    : {};
  const store = new FakePostingStore({
    now: () => sim.now,
    settings: { activatedAt: ACTIVATED, openingSnapshotAt: T0, cutoverDate: CUTOVER, setupMethod: 'OPENING', backfillState: 'DONE' },
    context: {
      settings: { currencyDecimals: sim.dec, receiptRouting: { ...ROUTING }, cashInvoiceRouting: 'MAIN_CASH', cutoverDate: CUTOVER, taxPeriodicity: 'QUARTERLY' },
      categoryAccounts: { [CAT1]: { incomeAccountId: accountIdOf('411002'), expenseAccountId: null, cogsAccountId: null, inventoryAccountId: null } },
      extraAccounts: [{ id: accountIdOf(STC_BANK), code: STC_BANK, name: 'بنك STC', type: 'asset_cash', isActive: true, reconcile: false, controlKind: null }],
    },
    custody: (repId) => sim.custodyInputs(repId),
    ...linkedOpts,
  } as ConstructorParameters<typeof FakePostingStore>[0]);
  // المؤشران تجاوزا كل الصفوف (المُطابِق قرأها)، فبوابتا ترتيب P7 وUSER_SETTLEMENT تحكمهما الأحداث وحدها
  store.setCursor('ACCOUNT_ENTRY', new Date('2099-01-01T00:00:00.000Z'));
  store.setCursor('REP_SETTLEMENT', new Date('2099-01-01T00:00:00.000Z'));
  sim.store = store;
  return store;
}

/**
 * العمليات (أمثلة العقد §7 محلولة على سيناريو واحد): فواتير نقدية مختومة وغير مختومة وآجلة بقسطين ومرتجع مرتبط وإلغاءان
 * عبر فترتين وفي فترة واحدة وإبطال يحتفظ بالنقد وفاتورة قديمة غير متّزنة؛ سندات بكل الطرق ومخصّصة وبطاقة وإلكترونية برابط
 * (استرداد عادي، وإلغاء يدوي ثم استرداد)، وإلغاءات قبل التسليم وبعده (من عهدة مستخدم ومن الصندوق)، وسند إلكتروني بلا رابط
 * (مفتاح API)؛ استلامات بمستخدم وبلا مستخدم وبتحويل، وحذف استلام؛ توريدات مستخدمين (نقد، مرور، إيداع) وحذف توريد؛
 * رصيد مستورد بعد البداية؛ عمولة وتوريد أمانات.
 */
export async function runOps(sim: Sim): Promise<void> {
  // المُرحِّل يعمل بعد كل عملية (نبضة حيّة): الاستلام يُرحَّل قبل حذفه، والتوريد بعد استلاماته — كما في الإنتاج
  const step = () => sim.post();
  const P = { productId: 'P', productName: 'كرتون عصير', price: sim.px(100), unitFactor: 24 };
  const P1 = { productId: 'P1', productName: 'علبة شاي', price: sim.px(50) };
  const P2 = { productId: 'P2', productName: 'خدمة توصيل', price: sim.px(100), categoryId: CAT1 };
  const P3 = { productId: 'P3', productName: 'حبة قهوة', price: sim.px(33.33) };

  // L4 — الفواتير
  sim.invoice({ id: 'INV-1', type: 'CASH', customerId: 'c1', repId: 'r1', at: t('09-20T09:00'), stamped: true, items: [{ ...P, qty: 1 }] }); await step();
  sim.invoice({ id: 'INV-2', type: 'CASH', customerId: 'c2', repId: 'r1', at: t('09-20T10:00'), items: [{ ...P1, qty: 2 }] }); await step();
  sim.invoice({
    id: 'INV-3', type: 'CREDIT', customerId: 'c1', repId: 'r1', at: t('09-21T09:00'), items: [{ ...P, qty: 10 }],
    installments: [{ seq: 1, due: '10-21', share: 0.5 }, { seq: 2, due: '11-20', share: 0.5 }],
  }); await step();
  sim.invoice({ id: 'INV-4', type: 'CREDIT', customerId: 'c3', repId: 'r2', at: t('09-22T09:00'), discountPct: 10, items: [{ ...P1, qty: 2 }, { ...P2, qty: 1 }] }); await step();
  sim.invoice({ id: 'INV-5', type: 'CREDIT', customerId: 'c2', repId: 'r1', at: t('09-28T09:00'), items: [{ ...P, qty: 1 }] }); await step();
  sim.invoice({ id: 'INV-6', type: 'CREDIT', customerId: 'c2', repId: 'r2', at: t('09-29T09:00'), items: [{ ...P3, qty: 3 }] }); await step();
  sim.cancelInvoice('INV-6', t('09-30T09:00')); await step(); // الفترة نفسها (الربع الثالث)
  sim.importBalance('c3', sim.px(50), t('10-01T00:00'), t('10-01T12:00')); await step(); // OD12: بعد البداية ⇒ 319002 مع تنبيه
  sim.invoice({ id: 'INV-9', type: 'CREDIT', customerId: 'c3', repId: 'r1', at: t('10-02T09:00'), items: [{ ...P, qty: 1 }], extraUnits: 1 }); await step();
  sim.cancelInvoice('INV-5', t('10-03T09:00')); await step(); // OD17: فترة لاحقة (الربع الرابع)
  const inv3 = sim.invoices.get('INV-3')!;
  sim.invoice({ id: 'RET-7', type: 'RETURN', customerId: 'c1', repId: 'r1', at: t('10-05T09:00'), items: [{ ...P, qty: 1 }], returnOf: { saleId: 'INV-3', remainingApplied: sim.px(115) } }); await step();

  // L5 — السندات
  sim.receipt({ id: 'R-1', customerId: 'c1', repId: 'r1', method: 'CASH', amount: sim.px(500), at: t('10-06T09:00'), allocations: [{ invoiceId: 'INV-3', amount: sim.px(500) }] }); await step();
  const inv4 = sim.invoices.get('INV-4')!;
  sim.receipt({ id: 'R-2', customerId: 'c3', repId: 'r1', method: 'BANK_TRANSFER', amount: sim.px(200), at: t('10-06T10:00'), allocations: [{ invoiceId: 'INV-4', amount: sim.px(200) }] }); await step();
  const rest4 = sim.r(inv4.total - sim.px(200));
  sim.receipt({ id: 'R-3', customerId: 'c3', repId: 'r2', method: 'BANK_TRANSFER', methodKey: 'c_stc', amount: rest4, at: t('10-07T09:00'), allocations: [{ invoiceId: 'INV-4', amount: rest4 }] }); await step();
  sim.receipt({ id: 'R-4', customerId: 'c2', repId: 'r1', method: 'POS', card: true, amount: sim.px(115), at: t('10-07T10:00') }); await step();
  sim.receipt({ id: 'R-5', customerId: 'c3', repId: 'r2', method: 'POS', amount: sim.px(30), at: t('10-08T09:00') }); await step();
  sim.receipt({ id: 'R-6', customerId: 'c1', repId: 'r1', method: 'CHEQUE', amount: sim.px(100), at: t('10-08T10:00'), allocations: [{ invoiceId: 'INV-3', amount: sim.px(100) }] }); await step();
  sim.receipt({ id: 'R-7', customerId: 'c2', repId: 'r2', method: 'ONLINE', link: 'L1', amount: sim.px(230), at: t('10-09T09:00') }); await step();
  sim.paylinkFee('L1', sim.px(6), sim.px(0.9), t('10-09T09:05')); await step();
  sim.receipt({ id: 'R-8', customerId: 'c1', repId: null, method: 'ONLINE', link: 'L2', amount: sim.px(100), at: t('10-10T09:00') }); await step();
  sim.receipt({ id: 'R-9', customerId: 'c3', repId: null, method: 'ONLINE', link: 'L3', amount: sim.px(80), at: t('10-11T09:00') }); await step();
  sim.cancelReceipt('R-9', t('10-12T09:00')); await step(); // إلغاء يدوي بلا استرداد ⇒ 214002 للمربوطة
  sim.receipt({ id: 'R-10', customerId: 'c2', repId: 'r1', method: 'CASH', amount: sim.px(60), at: t('10-12T10:00') }); await step();
  sim.cancelReceipt('R-10', t('10-13T09:00'), { refundFrom: 'REP_CUSTODY' }); await step(); // قبل التسليم: مرآة
  sim.receipt({ id: 'R-11', customerId: 'c1', repId: 'r2', method: 'CASH', amount: sim.px(40), at: t('10-14T09:00') }); await step();
  sim.receipt({ id: 'R-12', customerId: 'c3', repId: 'r1', method: 'CASH', amount: sim.px(70), at: t('10-14T10:00') }); await step();

  // استلامات (P7): بلا مستخدم، وشيك ونقد بمستخدم (111004)، وتحويل بمستخدم (OD5 ⇒ البنك)
  sim.repSettlement({ id: 'S-1', repId: 'r1', amount: sim.px(670), method: 'CASH', at: t('10-15T10:00') }); await step();
  sim.repSettlement({ id: 'S-1b', repId: 'r1', amount: sim.px(100), method: 'CHEQUE', at: t('10-15T10:30'), userId: 'u1' }); await step();
  sim.repSettlement({ id: 'S-2', repId: 'r2', amount: sim.px(40), method: 'CASH', at: t('10-15T11:00'), userId: 'u1' }); await step();
  sim.repSettlement({ id: 'S-3', repId: 'r1', amount: sim.px(200), method: 'BANK_TRANSFER', at: t('10-16T08:00'), userId: 'u2' }); await step();
  sim.cancelReceipt('R-11', t('10-16T09:00'), { refundFrom: 'USER_CUSTODY', refundUserId: 'u1' }); await step(); // بعد التسليم لمستخدم (E5.7)
  sim.cancelReceipt('R-12', t('10-17T09:00'), { refundFrom: 'MAIN_CASH' }); await step(); // بعد التسليم بلا مستخدم (E5.7)
  sim.invoice({ id: 'INV-8', type: 'CASH', customerId: 'c2', repId: 'r2', at: t('10-18T09:00'), stamped: true, items: [{ ...P, qty: 1 }] }); await step();
  sim.cancelInvoice('INV-8', t('10-19T09:00'), { keepCash: true }); await step(); // E4.11/E5.13
  sim.cancelReceipt('R-8', t('10-20T09:00'), { refund: true }); await step(); // الاسترداد العادي ⇒ PAYLINK_REFUND NETTED
  sim.repSettlement({ id: 'S-4', repId: 'r2', amount: sim.px(100), method: 'CASH', at: t('10-20T10:00'), userId: 'u2' }); await step();
  sim.deleteRepSettlement('S-4', t('10-21T10:00')); await step();
  sim.receipt({ id: 'R-13', customerId: 'c1', repId: null, method: 'ONLINE', amount: sim.px(10), at: t('10-21T11:00') }); await step(); // مفتاح API بلا رابط

  // توريدات المستخدمين (C14)
  sim.userSettlement({ id: 'U-1', userId: 'u1', amount: sim.px(60), method: 'CASH', at: t('10-22T09:00') }); await step();
  sim.userSettlement({ id: 'U-1x', userId: 'u1', amount: sim.px(40), method: 'CHEQUE', at: t('10-22T10:00') }); await step();
  sim.deleteUserSettlement('U-1x', t('10-23T09:00')); await step();
  sim.userSettlement({ id: 'U-2', userId: 'u2', amount: sim.px(200), method: 'BANK_TRANSFER', at: t('10-23T10:00') }); await step(); // مرور كامل
  sim.repSettlement({ id: 'S-5', repId: 'r2', amount: sim.px(15), method: 'CASH', at: t('10-24T09:00'), userId: 'u2' }); await step();
  sim.userSettlement({ id: 'U-5', userId: 'u1', amount: sim.px(40), method: 'CASH', at: t('10-24T10:00') }); await step();
  sim.refundLater('R-9', t('10-25T09:00')); await step(); // C9: Dr 214002 / Cr 112005
  sim.userSettlement({ id: 'U-3', userId: 'u2', amount: sim.px(15), method: 'BANK_TRANSFER', at: t('10-25T10:00') }); await step(); // إيداع نقد
  sim.payout('PO-1', sim.r(sim.px(230) - sim.px(6) - sim.px(0.9)), t('10-30T09:00')); await step();
  void inv3;
}

/** يرحّل كل ما بُذر حتى لا يبقى مستحق (BLOCKED يعاد بعد تقديم الساعة) */
export async function drain(sim: Sim, store: FakePostingStore): Promise<void> {
  sim.now = Math.max(sim.now, t('11-01T09:00').getTime());
  for (let i = 0; i < 12; i++) {
    const settings = (await store.loadPosterSettings(store.tenantId))!;
    await runPoster(store, settings, createSyncBudget({ clock: () => sim.now, timeMs: 1e12, events: 1e6 }), { log: () => undefined });
    if ((await store.countPendingEvents()) === 0) return;
    sim.now += 3 * 60 * 60_000;
  }
}

export async function runScenario(dec: Dec, linked: boolean, opts: { reconcile?: boolean } = {}): Promise<{ sim: Sim; store: FakePostingStore }> {
  const sim = new Sim(dec, linked);
  const store = makeStore(sim, opts);
  await runOps(sim);
  await drain(sim, store);
  return { sim, store };
}

/** لقطة الدفتر للمقارنة الذهبية (BigInt نصوص، والحسابات برموزها، والقيود بأرقامها) */
export function ledgerSnapshot(store: FakePostingStore): unknown {
  const moves = store.moves();
  const no = new Map(moves.map((m) => [m.id, m.number]));
  const code = (id: string) => id.replace(/^acc_/, '');
  const big = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());
  return {
    moves: moves.map((m) => ({
      number: m.number, date: m.date, originalDate: m.originalDate, lateArrival: m.lateArrival, needsAttention: m.needsAttention,
      sourceType: m.sourceType, sourceId: m.sourceId, reverses: m.reversedMoveId ? no.get(m.reversedMoveId) ?? null : null,
      lines: m.lines.map((l) => [
        code(l.accountId), l.label, big(l.debitMilli), big(l.creditMilli), l.customerId, l.salesRepId, l.partnerName, l.analyticAccountId,
        l.taxId, l.taxRole, big(l.taxBaseMilli),
      ]),
    })),
    sources: [...store.state.sources].map(([k, id]) => [k, no.get(id) ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    events: [...store.state.events.values()]
      .map((e) => [e.sourceKey, e.status, e.skipReason, e.moveId ? no.get(e.moveId) ?? null : null, big(e.nonCustodyClearedMilli), big(e.shortageRecoveredMilli), e.lastError])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  };
}
