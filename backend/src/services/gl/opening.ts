/**
 * القيد الافتتاحي OPEN ومعاينة الأرصدة المشتقة (M3، DESIGN.md §5.6 الخطوات 1 و4 و5 و6، §5.5 P25، §4.5، §2.5).
 *
 * - الأرصدة المشتقة «كما في تاريخ البدء»: كل صف أساسي يحقق الشرطين معاً (تاريخ الأثر < cutover **و** createdAt ≤ T0)،
 *   بالمسند نفسه الذي يصنّف به المُرحِّل (isIncludedInOpening من sync/classify.ts)، فلا صف يسقط من الافتتاح والترحيل
 *   معاً ولا يُعدّ فيهما.
 *     • الذمم لكل عميل = Σ AccountEntry (مدين − دائن).
 *     • العهدة لكل مندوب = custodyComponents(…).ledgerCustody (§5.5) على السندات الموجّهة للعهدة وصفوف إلغائها
 *       والاستلامات (settledAt) والفواتير النقدية (تدخل العهدة فقط حين cashInvoiceRouting=CUSTODY — الدالة تقرر).
 *     • الأمانات 112005 = Σ SettlementEntry.amount (createdAt).
 *     • مخزون المستودع 114001 = valueStock على الحركات (createdAt)، مع إعلان الكمية بلا تكلفة.
 * - الأرصدة اليدوية (الخطوة 5): صفوف {رمز الحساب، مدين، دائن، مورّد، تاريخ استحقاق}؛ سطر 211001 يحمل vendorId (I5).
 * - الفرق إلى 319002 OPENING_EQUITY. القيد بتاريخ cutover − 1 في دفتر OPEN (moveType=OPENING، origin=AUTO).
 * - المعاينة (/setup/preview-opening) إرشادية لا تُخزَّن؛ الاعتماد يعيد الحساب داخل معاملة التفعيل بـT0.
 *
 * الحساب صرف؛ القراءة من القاعدة في loadOpeningSources على عميل/معاملة يمرّرها المُستدعي.
 */
import type { Prisma } from '@prisma/client';
import {
  addDays, compareLocalDate, fiscalYearStart, isLocalDate, parseLocalDate, todayLocal, zonedStartOfDay,
} from './dates';
import { formatMilli, toMilli } from './money';
import {
  custodyComponents, receiptCustodyClass,
  type CustodyComponentsInput, type CustodyItem, type CustodySettlementItem,
} from './custody';
import { resolveTemplate } from './seed';
import { isIncludedInOpening } from './sync/classify';
import { LATE_COMMIT_WINDOW_MS } from './sync/types';
import { composeWarehouse } from '../warehouseStock';
import {
  JOURNAL_CODE_BY_SYSTEM_KEY, LedgerError, createBuildContext,
  type AccountRef, type BuildContext, type CashInvoiceRouting, type GlSettingsSnapshot, type JournalRef, type LineDraft,
  type LocalDate, type MappingKey, type Milli, type MoveDraft, type ReceiptRouting, type TaxPeriodicity, type TemplateKey,
} from './types';

type GlDb = Prisma.TransactionClient;

// ═══ اللقطة والحدود ═══

/** T0 = (SELECT now()) − LATE_COMMIT_WINDOW (§5.6 الخطوة 6، §5.2) — من ساعة القاعدة لا ساعة التطبيق */
export function openingSnapshotFromDbNow(dbNow: Date): Date {
  return new Date(dbNow.getTime() - LATE_COMMIT_WINDOW_MS);
}

export interface OpeningCutoff {
  cutoverDate: LocalDate;
  timezone: string;
  /** T0 في الاعتماد، وساعة القاعدة في المعاينة */
  snapshotAt: Date;
  /** zonedStartOfDay(cutoverDate) — «تاريخ الأثر < cutover» ⇔ effectAt < cutoverStart */
  cutoverStart: Date;
  /** cutover − 1 يوم: تاريخ قيد OPEN */
  openingDate: LocalDate;
}

export function openingCutoff(cutoverDate: LocalDate, timezone: string, snapshotAt: Date): OpeningCutoff {
  if (!isLocalDate(cutoverDate)) throw new RangeError(`تاريخ بدء غير صالح: ${String(cutoverDate)}`);
  return {
    cutoverDate, timezone, snapshotAt,
    cutoverStart: zonedStartOfDay(cutoverDate, timezone),
    openingDate: addDays(cutoverDate, -1),
  };
}

type Instant = Date | string | number;

/** مسند الافتتاح نفسه الذي يستعمله المُرحِّل (classify.isIncludedInOpening) */
export function includedInOpening(row: { effectAt: Instant; createdAt: Instant }, cut: OpeningCutoff): boolean {
  return isIncludedInOpening(row, { cutoverDate: cut.cutoverDate, openingSnapshotAt: cut.snapshotAt, timezone: cut.timezone });
}

// ═══ الخطوة 1: تاريخ البدء ═══

/**
 * لا تاريخ بدء في المستقبل (§5.6 الخطوة 1): بعد «اليوم» بتوقيت الشركة ⇒ 422 LEDGER_CUTOVER_IN_FUTURE.
 * يستدعيه حفظ مسودة الخطوة 1 و/setup/commit كلاهما.
 */
export function assertCutoverNotInFuture(cutoverDate: LocalDate, timezone: string, now: Date): void {
  const today = todayLocal(now, timezone);
  if (compareLocalDate(cutoverDate, today) > 0) {
    throw new LedgerError('LEDGER_CUTOVER_IN_FUTURE', { cutoverDate, today, timezone });
  }
}

const PERIOD_MONTHS: Readonly<Record<Exclude<TaxPeriodicity, 'FISCAL_YEAR'>, number>> = {
  MONTHLY: 1, BIMONTHLY: 2, QUARTERLY: 3, FOUR_MONTHS: 4, SEMIANNUAL: 6, ANNUAL: 12,
};

/**
 * هل التاريخ بداية فترة إقرار وفق الدورية؟ الفترات تقويمية (يناير، أبريل، يوليو، أكتوبر للربعية)،
 * وFISCAL_YEAR = بداية السنة المالية. ⚠️ تُحسم الحدود مع §7.8 في M5.
 */
export function isVatPeriodStart(date: LocalDate, periodicity: TaxPeriodicity, fiscalYearEndMonth = 12, fiscalYearEndDay = 31): boolean {
  if (periodicity === 'FISCAL_YEAR') return fiscalYearStart(date, fiscalYearEndMonth, fiscalYearEndDay) === date;
  const { m, d } = parseLocalDate(date);
  if (d !== 1) return false;
  return (m - 1) % PERIOD_MONTHS[periodicity] === 0;
}

export interface CutoverVatCheckInput {
  templateKey: TemplateKey;
  cutoverDate: LocalDate;
  taxPeriodicity: TaxPeriodicity;
  fiscalYearEndMonth: number;
  fiscalYearEndDay: number;
  /** تأكيد صريح لتاريخ بدء داخل فترة */
  confirmMidVatPeriod?: boolean | null;
  /** مبالغ المربعات قبل البدء للإقرار الأول (preCutoverBoxesJson، §6.6) */
  preCutoverBoxes?: Readonly<Record<string, unknown>> | null;
}

/**
 * SA_6D: تاريخ البدء يوافق بداية فترة إقرار، وإلا 422 LEDGER_CUTOVER_MID_VAT_PERIOD ما لم يؤكَّد صراحةً
 * مع مبالغ المربعات قبل البدء. يعيد true إن كان داخل فترة مؤكَّدة (فتُقبل أرصدة 212001/116001 في الخطوة 5).
 */
export function checkCutoverVatPeriod(i: CutoverVatCheckInput): { midPeriod: boolean } {
  if (i.templateKey !== 'SA_6D') return { midPeriod: false };
  if (isVatPeriodStart(i.cutoverDate, i.taxPeriodicity, i.fiscalYearEndMonth, i.fiscalYearEndDay)) return { midPeriod: false };
  const boxes = i.preCutoverBoxes;
  const hasBoxes = !!boxes && typeof boxes === 'object' && !Array.isArray(boxes) && Object.keys(boxes).length > 0;
  if (i.confirmMidVatPeriod === true && hasBoxes) return { midPeriod: true };
  throw new LedgerError('LEDGER_CUTOVER_MID_VAT_PERIOD', {
    cutoverDate: i.cutoverDate, taxPeriodicity: i.taxPeriodicity,
    confirmRequired: i.confirmMidVatPeriod !== true, preCutoverBoxesRequired: !hasBoxes,
  });
}

/** التاريخ المقترح: بداية السنة المالية لـSA_6D، وأول الشهر الحالي للقالب العام (§5.6 الخطوة 1) */
export function suggestedCutoverDate(templateKey: TemplateKey, now: Date, timezone: string, fiscalYearEndMonth = 12, fiscalYearEndDay = 31): LocalDate {
  const today = todayLocal(now, timezone);
  if (templateKey === 'SA_6D') return fiscalYearStart(today, fiscalYearEndMonth, fiscalYearEndDay);
  return `${today.slice(0, 8)}01`;
}

// ═══ صفوف المصادر ═══

export interface OpeningAccountEntryRow {
  id: string;
  customerId: string;
  invoiceId: string | null;
  receiptId: string | null;
  type: string;
  debit: number;
  credit: number;
  entryDate: Date;
  createdAt: Date;
  /** نوع الفاتورة (CASH/CREDIT/RETURN) لصفوف الفواتير — يحدد صف الأثر من صف الإلغاء؛ الغائب ⇒ لا يُسقط صف فاتورة */
  invoiceType?: string | null;
}

export interface OpeningReceiptRow {
  id: string;
  salesRepId: string | null;
  paymentMethod: string;
  amount: number;
}

export interface OpeningCashInvoiceRow {
  id: string;
  salesRepId: string | null;
  total: number;
}

export interface OpeningSettlementRow {
  id: string;
  salesRepId: string;
  amount: number;
  settledAt: Date;
  createdAt: Date;
}

export interface OpeningSettlementEntryRow {
  id: string;
  amount: number;
  createdAt: Date;
}

export interface OpeningWarehouseItemRow {
  productId: string;
  qty: number;
  /** RECEIVE | ADJUST */
  type: string;
  unitCost: number | null;
  createdAt: Date;
}

export interface OpeningVanItemRow {
  productId: string;
  qty: number;
  /** LOAD | UNLOAD | ADJUST */
  type: string;
  salesRepId: string | null;
  createdAt: Date;
}

export interface OpeningSources {
  accountEntries: readonly OpeningAccountEntryRow[];
  /** سندات المناديب (salesRepId ≠ null) */
  receipts: readonly OpeningReceiptRow[];
  /** فواتير المناديب النقدية */
  cashInvoices: readonly OpeningCashInvoiceRow[];
  settlements: readonly OpeningSettlementRow[];
  settlementEntries: readonly OpeningSettlementEntryRow[];
  warehouseItems?: readonly OpeningWarehouseItemRow[];
  vanItems?: readonly OpeningVanItemRow[];
  customerNames?: Readonly<Record<string, string>>;
  salesRepNames?: Readonly<Record<string, string>>;
}

export interface OpeningRouting {
  receiptRouting: ReceiptRouting | null;
  cashInvoiceRouting: CashInvoiceRouting;
}

// ═══ الأرصدة المشتقة (الخطوة 4) ═══

export interface OpeningReceivable {
  customerId: string;
  customerName: string;
  balanceMilli: Milli;
  rows: number;
}

export interface OpeningCustody {
  salesRepId: string;
  salesRepName: string;
  ledgerCustodyMilli: Milli;
  onlineUnclearedMilli: Milli;
  nonCustodyClearedMilli: Milli;
  suspenseClearedMilli: Milli;
  cashSalesOutsideCustodyMilli: Milli;
  opsOutstandingMilli: Milli;
}

export interface DerivedOpening {
  cutoff: OpeningCutoff;
  receivables: OpeningReceivable[];
  receivablesTotalMilli: Milli;
  custody: OpeningCustody[];
  custodyTotalMilli: Milli;
  paylinkHeldMilli: Milli;
  warehouse: { valueMilli: Milli; uncostedQty: number; uncostedProducts: number };
  /**
   * تقسيم P7 لكل استلام مشمول بالافتتاح كما حسبه الافتتاح (بالمجموعة نفسها لا بالوصول المتأخر) — يُجمَّد عند التفعيل
   * على حدث SETTLEMENT:<id>:POST بحالة SKIPPED(OPENING) فيقرؤه custodyComponents مخزّناً ولا يعيد اشتقاقه.
   */
  settlementSplits: Record<string, { salesRepId: string; nonCustodyClearedMilli: Milli; shortageRecoveredMilli: Milli }>;
  counts: {
    accountEntriesIncluded: number;
    /** يشمل صفوف الإلغاء المُسقطة لأن أثر مستندها خارج الافتتاح (مستند مؤرخ مستقبلاً أُلغي قبل البدء) */
    accountEntriesExcluded: number;
    settlementsIncluded: number;
    settlementEntriesIncluded: number;
    warehouseMovesIncluded: number;
  };
}

const EFFECT_ENTRY_TYPES: Readonly<Record<string, 'RECEIPT_EFFECT' | 'RECEIPT_REVERSAL' | 'INVOICE_EFFECT' | 'INVOICE_REVERSAL'>> = {
  RECEIPT_CREDIT: 'RECEIPT_EFFECT',
  RECEIPT_DEBIT: 'RECEIPT_REVERSAL',
  INVOICE_DEBIT: 'INVOICE_EFFECT',
  INVOICE_CREDIT: 'INVOICE_REVERSAL',
};

/** مفتاح المستند كما في desired.ts: الفاتورة إن وُجدت، وإلا السند؛ null لصفوف التسوية/الاستيراد */
function openingDocKey(e: Pick<OpeningAccountEntryRow, 'invoiceId' | 'receiptId'>): string | null {
  if (e.invoiceId) return `I:${e.invoiceId}`;
  if (e.receiptId) return `R:${e.receiptId}`;
  return null;
}

/** دور الصف في مستنده (POSTING_TYPES_BY_INVOICE في desired.ts): أثر أو إلغاء، وnull حين لا يُعرف (نوع فاتورة غائب) */
export function openingRowRole(e: Pick<OpeningAccountEntryRow, 'invoiceId' | 'receiptId' | 'type' | 'invoiceType'>): 'EFFECT' | 'REVERSAL' | null {
  if (e.invoiceId) {
    if (!e.invoiceType) return null;
    if (e.invoiceType === 'RETURN') return e.type === 'INVOICE_CREDIT' ? 'EFFECT' : e.type === 'INVOICE_DEBIT' ? 'REVERSAL' : null;
    if (e.type === 'INVOICE_DEBIT' || e.type === 'RECEIPT_CREDIT') return 'EFFECT';
    if (e.type === 'INVOICE_CREDIT' || e.type === 'RECEIPT_DEBIT') return 'REVERSAL';
    return null;
  }
  if (e.receiptId) return e.type === 'RECEIPT_CREDIT' ? 'EFFECT' : e.type === 'RECEIPT_DEBIT' ? 'REVERSAL' : null;
  return null;
}

/**
 * الأرصدة المشتقة كما في تاريخ البدء. كل صف يُفحص بالمسند includedInOpening — المُحمِّل قد يرشّح في SQL أيضاً،
 * والصفوف الزائدة (معاملة التزمت بين المعاينة والاعتماد…) تُصنَّف هنا بالقاعدة نفسها.
 */
export function computeDerivedOpening(src: OpeningSources, cut: OpeningCutoff, opts: { decimals: number; routing: OpeningRouting }): DerivedOpening {
  const dec = opts.decimals;
  const names = src.customerNames ?? {};
  const repNames = src.salesRepNames ?? {};

  // ── الذمم + آثار السندات والفواتير النقدية ──
  const ar = new Map<string, OpeningReceivable>();
  const receiptEffect = new Map<string, OpeningAccountEntryRow>();
  const receiptReversal = new Map<string, OpeningAccountEntryRow>();
  const invoiceEffect = new Map<string, OpeningAccountEntryRow>();
  const invoiceReversal = new Map<string, OpeningAccountEntryRow>();
  let included = 0;
  let excluded = 0;
  const inWindowRows = src.accountEntries.filter((e) => includedInOpening({ effectAt: e.entryDate, createdAt: e.createdAt }, cut));
  excluded += src.accountEntries.length - inWindowRows.length;
  // الإلغاء يتبع أصله: صف إلغاء مستندٍ لا صف أثر له في الافتتاح (مؤرخ مستقبلاً وأُلغي قبل البدء) يُسقط، فيُرحَّل
  // POST وREVERSE معاً على خط الأحداث (الفحص لمرة واحدة scanFutureDatedRows) ولا يُعدّ الإلغاء وحده في الذمم
  const docsWithEffect = new Set<string>();
  for (const e of inWindowRows) {
    const d = openingDocKey(e);
    if (d && openingRowRole(e) === 'EFFECT') docsWithEffect.add(d);
  }
  for (const e of inWindowRows) {
    const d = openingDocKey(e);
    if (d && openingRowRole(e) === 'REVERSAL' && !docsWithEffect.has(d)) { excluded++; continue; }
    included++;
    let r = ar.get(e.customerId);
    if (!r) {
      r = { customerId: e.customerId, customerName: names[e.customerId]?.trim() || `عميل ${e.customerId}`, balanceMilli: 0n, rows: 0 };
      ar.set(e.customerId, r);
    }
    r.balanceMilli += toMilli(e.debit, dec) - toMilli(e.credit, dec);
    r.rows++;
    const kind = EFFECT_ENTRY_TYPES[e.type];
    if (kind === 'RECEIPT_EFFECT' && e.receiptId) receiptEffect.set(e.receiptId, e);
    else if (kind === 'RECEIPT_REVERSAL' && e.receiptId) receiptReversal.set(e.receiptId, e);
    else if (kind === 'INVOICE_EFFECT' && e.invoiceId && !e.receiptId) invoiceEffect.set(e.invoiceId, e);
    else if (kind === 'INVOICE_REVERSAL' && e.invoiceId && !e.receiptId) invoiceReversal.set(e.invoiceId, e);
  }
  const receivables = [...ar.values()].filter((r) => r.balanceMilli !== 0n)
    .sort((a, b) => a.customerName.localeCompare(b.customerName, 'ar') || a.customerId.localeCompare(b.customerId));
  const receivablesTotalMilli = receivables.reduce((s, r) => s + r.balanceMilli, 0n);

  // ── العهدة: custodyComponents على ما قبل البدء (§5.5) ──
  const custodyInput: CustodyComponentsInput = {
    receipts: [], onlineReceipts: [], outsideReceipts: [], cashInvoices: [], settlements: [], shortages: [], custodyExpenses: [],
    routing: { cashInvoice: opts.routing.cashInvoiceRouting, receipt: opts.routing.receiptRouting },
  };
  for (const rc of src.receipts) {
    if (!rc.salesRepId) continue;
    const eff = receiptEffect.get(rc.id);
    if (!eff) continue; // أثره بعد البدء أو بعد اللقطة ⇒ خط الأحداث
    const rev = receiptReversal.get(rc.id);
    const item: CustodyItem = {
      id: rc.id, salesRepId: rc.salesRepId, amountMilli: toMilli(rc.amount, dec),
      effectAt: eff.entryDate, createdAt: eff.createdAt, reversedAt: rev ? rev.entryDate : null,
    };
    const cls = receiptCustodyClass({ paymentMethod: rc.paymentMethod, salesRepId: rc.salesRepId, routing: opts.routing.receiptRouting });
    ((cls === 'CUSTODY' ? custodyInput.receipts : cls === 'ONLINE' ? custodyInput.onlineReceipts : custodyInput.outsideReceipts) as CustodyItem[])
      .push(item);
  }
  for (const inv of src.cashInvoices) {
    if (!inv.salesRepId) continue;
    const eff = invoiceEffect.get(inv.id);
    if (!eff) continue;
    const rev = invoiceReversal.get(inv.id);
    (custodyInput.cashInvoices as CustodyItem[]).push({
      id: inv.id, salesRepId: inv.salesRepId, amountMilli: toMilli(inv.total, dec),
      effectAt: eff.entryDate, createdAt: eff.createdAt, reversedAt: rev ? rev.entryDate : null,
    });
  }
  let settlementsIncluded = 0;
  for (const st of src.settlements) {
    if (!includedInOpening({ effectAt: st.settledAt, createdAt: st.createdAt }, cut)) continue;
    settlementsIncluded++;
    (custodyInput.settlements as CustodySettlementItem[]).push({
      id: st.id, salesRepId: st.salesRepId, amountMilli: toMilli(st.amount, dec), effectAt: st.settledAt, createdAt: st.createdAt,
    });
  }
  const comps = custodyComponents(custodyInput);
  const settlementSplits: DerivedOpening['settlementSplits'] = {};
  for (const c of Object.values(comps)) {
    for (const o of c.settlements) {
      settlementSplits[o.id] = { salesRepId: c.salesRepId, nonCustodyClearedMilli: o.nonCustodyClearedMilli, shortageRecoveredMilli: o.recoveredMilli };
    }
  }
  const custody: OpeningCustody[] = Object.values(comps).map((c) => ({
    salesRepId: c.salesRepId,
    salesRepName: repNames[c.salesRepId]?.trim() || `مندوب ${c.salesRepId}`,
    ledgerCustodyMilli: c.ledgerCustody,
    onlineUnclearedMilli: c.onlineUncleared,
    nonCustodyClearedMilli: c.nonCustodyCleared,
    suspenseClearedMilli: c.suspenseCleared,
    cashSalesOutsideCustodyMilli: c.cashSalesOutsideCustody,
    opsOutstandingMilli: c.opsOutstanding,
  })).sort((a, b) => a.salesRepName.localeCompare(b.salesRepName, 'ar') || a.salesRepId.localeCompare(b.salesRepId));
  const custodyTotalMilli = custody.reduce((s, c) => s + c.ledgerCustodyMilli, 0n);

  // ── الأمانات 112005 ──
  let paylinkHeldMilli = 0n;
  let settlementEntriesIncluded = 0;
  for (const se of src.settlementEntries) {
    if (!includedInOpening({ effectAt: se.createdAt, createdAt: se.createdAt }, cut)) continue;
    settlementEntriesIncluded++;
    paylinkHeldMilli += toMilli(se.amount, dec);
  }

  // ── مخزون المستودع (valueStock عبر composeWarehouse) ──
  const inWindow = (at: Date) => includedInOpening({ effectAt: at, createdAt: at }, cut);
  const wh = (src.warehouseItems ?? []).filter((i) => inWindow(i.createdAt));
  const vans = (src.vanItems ?? []).filter((i) => inWindow(i.createdAt));
  let warehouseValueMilli = 0n;
  let uncostedQty = 0;
  let uncostedProducts = 0;
  if (wh.length || vans.length) {
    const productIds = [...new Set([...wh.map((i) => i.productId), ...vans.map((i) => i.productId)])];
    const rows = composeWarehouse(
      productIds.map((id) => ({ id, name: id, code: id, unit: '' })),
      wh.map((i) => ({ productId: i.productId, qty: i.qty, type: i.type, unitCost: i.unitCost, at: i.createdAt })),
      vans.map((i) => ({ productId: i.productId, qty: i.qty, type: i.type, salesRepId: i.salesRepId, at: i.createdAt })),
    );
    for (const r of rows) {
      if (Number.isFinite(r.stockValue)) warehouseValueMilli += toMilli(r.stockValue, dec);
      if (r.uncostedQty > 1e-9) { uncostedQty += r.uncostedQty; uncostedProducts++; }
    }
  }

  return {
    cutoff: cut,
    receivables, receivablesTotalMilli,
    custody, custodyTotalMilli,
    settlementSplits,
    paylinkHeldMilli,
    warehouse: { valueMilli: warehouseValueMilli, uncostedQty, uncostedProducts },
    counts: {
      accountEntriesIncluded: included, accountEntriesExcluded: excluded, settlementsIncluded, settlementEntriesIncluded,
      warehouseMovesIncluded: wh.length + vans.length,
    },
  };
}

// ═══ الأرصدة اليدوية (الخطوة 5) ═══

/** أعمدة قالب XLSX بالترتيب (الويب يحلّل الملف ويرسل الصفوف JSON) */
export const OPENING_BALANCE_TEMPLATE_COLUMNS = ['accountCode', 'debit', 'credit', 'vendorName', 'dueDate'] as const;

export interface ManualBalanceRowInput {
  accountCode: string;
  debit?: number | string | null;
  credit?: number | string | null;
  /** مورّد قائم (GlVendor.id) */
  vendorId?: string | null;
  /** اسم المورّد: يُنشأ GlVendor إن لم يوجد (سطور 211001) */
  vendorName?: string | null;
  dueDate?: LocalDate | null;
  /** بضاعة السيارات 114002 قبل M8، وسُلف الموظفين */
  salesRepId?: string | null;
  label?: string | null;
}

export const MANUAL_BALANCE_ISSUES = [
  'ACCOUNT_NOT_FOUND', 'ACCOUNT_ARCHIVED', 'DERIVED_ACCOUNT', 'OPENING_EQUITY', 'EQUITY_UNAFFECTED', 'OFF_BALANCE',
  'VAT_REQUIRES_MID_PERIOD', 'VENDOR_REQUIRED', 'INVALID_AMOUNT', 'NEGATIVE_AMOUNT', 'DEBIT_AND_CREDIT', 'ZERO_AMOUNT',
  'INVALID_DUE_DATE',
] as const;
export type ManualBalanceIssueReason = (typeof MANUAL_BALANCE_ISSUES)[number];

export interface ManualBalanceIssue {
  index: number;
  accountCode: string;
  reason: ManualBalanceIssueReason;
}

export interface ManualBalanceLine {
  index: number;
  account: AccountRef;
  debitMilli: Milli;
  creditMilli: Milli;
  vendorId: string | null;
  vendorName: string | null;
  dueDate: LocalDate | null;
  salesRepId: string | null;
  label: string | null;
}

/** مفاتيح الحسابات التي تُشتق أرصدتها من المصادر فلا تُدخل يدوياً */
export const DERIVED_OPENING_KEYS: readonly MappingKey[] = ['AR_CONTROL', 'REP_CUSTODY', 'PAYLINK_CLEARING', 'INVENTORY_WAREHOUSE'];
const DERIVED_CONTROL_KINDS = new Set(['AR', 'CUSTODY', 'PAYLINK']);

function amountOf(v: number | string | null | undefined, dec: number): Milli | 'INVALID' {
  if (v === null || v === undefined || v === '') return 0n;
  try {
    return toMilli(typeof v === 'string' ? v.replace(/[,\s]/g, '') : v, dec);
  } catch {
    return 'INVALID';
  }
}

/**
 * يتحقق من صفوف الأرصدة اليدوية مقابل السياق. `midVatPeriod`: تاريخ بدء داخل فترة مؤكَّد (فتُقبل 212001/116001).
 * لا يرمي: المسار يرد 422 بالمخالفات، والمعاينة تعرضها.
 */
export function validateManualBalanceRows(
  rows: readonly ManualBalanceRowInput[],
  ctx: BuildContext,
  opts: { midVatPeriod: boolean },
): { lines: ManualBalanceLine[]; issues: ManualBalanceIssue[] } {
  const dec = ctx.settings.currencyDecimals;
  const lines: ManualBalanceLine[] = [];
  const issues: ManualBalanceIssue[] = [];
  const derivedIds = new Set(DERIVED_OPENING_KEYS.map((k) => ctx.accounts.byKey(k)?.id).filter((x): x is string => !!x));
  const equityId = ctx.accounts.byKey('OPENING_EQUITY')?.id ?? null;
  rows.forEach((row, index) => {
    const code = String(row.accountCode ?? '').trim();
    const push = (reason: ManualBalanceIssueReason) => issues.push({ index, accountCode: code, reason });
    const account = ctx.accounts.byCode(code);
    if (!account) return push('ACCOUNT_NOT_FOUND');
    if (!account.isActive) return push('ACCOUNT_ARCHIVED');
    if (account.type === 'equity_unaffected') return push('EQUITY_UNAFFECTED');
    if (account.type === 'off_balance') return push('OFF_BALANCE');
    if (account.id === equityId) return push('OPENING_EQUITY');
    if (derivedIds.has(account.id) || (account.controlKind && DERIVED_CONTROL_KINDS.has(account.controlKind))) return push('DERIVED_ACCOUNT');
    if ((account.controlKind === 'VAT_OUT' || account.controlKind === 'VAT_IN') && ctx.settings.templateKey === 'SA_6D' && !opts.midVatPeriod) {
      return push('VAT_REQUIRES_MID_PERIOD');
    }
    const d = amountOf(row.debit, dec);
    const c = amountOf(row.credit, dec);
    if (d === 'INVALID' || c === 'INVALID') return push('INVALID_AMOUNT');
    if (d < 0n || c < 0n) return push('NEGATIVE_AMOUNT');
    if (d > 0n && c > 0n) return push('DEBIT_AND_CREDIT');
    if (d === 0n && c === 0n) return push('ZERO_AMOUNT');
    const vendorId = row.vendorId?.trim() || null;
    const vendorName = row.vendorName?.trim() || null;
    if (account.controlKind === 'AP' && !vendorId && !vendorName) return push('VENDOR_REQUIRED');
    const dueDate = row.dueDate ? String(row.dueDate).trim() : null;
    if (dueDate && !isLocalDate(dueDate)) return push('INVALID_DUE_DATE');
    const isAp = account.controlKind === 'AP';
    lines.push({
      index, account, debitMilli: d, creditMilli: c,
      vendorId: isAp ? vendorId : null, vendorName: isAp ? vendorName : null,
      dueDate: isAp ? (dueDate || null) : null,
      salesRepId: row.salesRepId?.trim() || null,
      label: row.label?.trim() || null,
    });
  });
  return { lines, issues };
}

// ═══ القيد الافتتاحي ═══

export interface OpeningMoveInput {
  derived: DerivedOpening;
  manual: readonly ManualBalanceLine[];
  ctx: BuildContext;
  /** أسماء المناديب لسطور يدوية تحمل salesRepId (لقطة partnerName) */
  salesRepNames?: Readonly<Record<string, string>>;
}

export interface OpeningMoveResult {
  /** null حين لا أرصدة إطلاقاً */
  draft: MoveDraft | null;
  /** فرق 319002 الموقَّع: موجب = دائن 319002 */
  equityDiffMilli: Milli;
  totalDebitMilli: Milli;
  manualDebitMilli: Milli;
  manualCreditMilli: Milli;
  lineCount: number;
}

function signed(line: Omit<LineDraft, 'debitMilli' | 'creditMilli'>, amount: Milli): LineDraft {
  return { ...line, debitMilli: amount > 0n ? amount : 0n, creditMilli: amount < 0n ? -amount : 0n };
}

/** قيد OPEN بتاريخ cutover − 1: الذمم والعهدة والأمانات والمخزون والأرصدة اليدوية، والفرق إلى 319002 (P25) */
export function buildOpeningMove(input: OpeningMoveInput): OpeningMoveResult {
  const { derived, ctx } = input;
  const s = ctx.settings;
  const date = derived.cutoff.openingDate;
  const lines: LineDraft[] = [];
  for (const r of derived.receivables) {
    lines.push(signed({
      accountKey: 'AR_CONTROL', label: `رصيد افتتاحي — ${r.customerName}`, customerId: r.customerId, partnerName: r.customerName, dueDate: date,
    }, r.balanceMilli));
  }
  for (const c of derived.custody) {
    if (c.ledgerCustodyMilli === 0n) continue;
    lines.push(signed({
      accountKey: 'REP_CUSTODY', label: `عهدة افتتاحية — ${c.salesRepName}`, salesRepId: c.salesRepId, partnerName: c.salesRepName,
    }, c.ledgerCustodyMilli));
  }
  if (derived.paylinkHeldMilli !== 0n) {
    lines.push(signed({ accountKey: 'PAYLINK_CLEARING', label: 'أمانات الدفع الإلكتروني الافتتاحية' }, derived.paylinkHeldMilli));
  }
  if (derived.warehouse.valueMilli !== 0n) {
    lines.push(signed({ accountKey: 'INVENTORY_WAREHOUSE', label: 'مخزون المستودع الافتتاحي' }, derived.warehouse.valueMilli));
  }
  let manualDebitMilli = 0n;
  let manualCreditMilli = 0n;
  const repNames = input.salesRepNames ?? {};
  for (const m of input.manual) {
    manualDebitMilli += m.debitMilli;
    manualCreditMilli += m.creditMilli;
    const isAp = m.account.controlKind === 'AP';
    const repName = m.salesRepId ? (repNames[m.salesRepId]?.trim() || `مندوب ${m.salesRepId}`) : null;
    lines.push({
      accountId: m.account.id,
      label: m.label || (isAp && m.vendorName ? `رصيد افتتاحي — ${m.vendorName}` : `رصيد افتتاحي — ${m.account.name}`),
      debitMilli: m.debitMilli, creditMilli: m.creditMilli,
      vendorId: isAp ? m.vendorId : null,
      partnerName: isAp ? (m.vendorName ?? null) : repName,
      salesRepId: m.salesRepId,
      dueDate: isAp ? (m.dueDate ?? date) : null,
    });
  }
  let net = 0n;
  let totalDebitMilli = 0n;
  for (const l of lines) { net += l.debitMilli - l.creditMilli; totalDebitMilli += l.debitMilli; }
  const equityDiffMilli = net;
  if (net !== 0n) {
    lines.push(signed({ accountKey: 'OPENING_EQUITY', label: 'فرق الأرصدة الافتتاحية' }, -net));
    if (net < 0n) totalDebitMilli += -net;
  }
  if (lines.length === 0) {
    return { draft: null, equityDiffMilli: 0n, totalDebitMilli: 0n, manualDebitMilli, manualCreditMilli, lineCount: 0 };
  }
  const draft: MoveDraft = {
    kind: 'MOVE',
    journalCode: ctx.journals.bySystemKey('OPENING')?.code ?? JOURNAL_CODE_BY_SYSTEM_KEY.OPENING,
    journalSystemKey: 'OPENING',
    moveType: 'OPENING',
    origin: 'AUTO',
    date,
    ref: null,
    narration: `القيد الافتتاحي كما في ${date}`,
    needsAttention: false,
    attentionReason: null,
    sourceType: null,
    sourceId: null,
    sourceKey: null,
    sourceEvent: null,
    currencyCode: s.currency,
    currencyDecimals: s.currencyDecimals,
    lines,
  };
  return { draft, equityDiffMilli, totalDebitMilli, manualDebitMilli, manualCreditMilli, lineCount: lines.length };
}

// ═══ سياق القالب قبل الزرع (للمعاينة) ═══

/**
 * سياق بناء في الذاكرة من القالب حين لم يُزرع بعد (معاينة الخطوة 4/5 قبل التفعيل): معرّفات tpl:<code>.
 * الاعتماد يقرأ السياق الحقيقي بعد الزرع داخل المعاملة.
 */
export function templatePreviewContext(templateKey: TemplateKey, countryCode: string, settings: Partial<GlSettingsSnapshot> = {}): BuildContext {
  const tpl = resolveTemplate(templateKey, templateKey === 'GENERIC_6D' ? { countryCode } : {});
  const idOf = (code: string) => `tpl:${code}`;
  const accounts: AccountRef[] = tpl.chart.accounts.map((a) => ({
    id: idOf(a.code), code: a.code, name: a.names.ar, type: a.type, isActive: a.isActive, reconcile: a.reconcile, controlKind: a.controlKind,
  }));
  const mappings: Partial<Record<MappingKey, string>> = {};
  for (const [k, code] of Object.entries(tpl.chart.mappings) as [MappingKey, string][]) mappings[k] = idOf(code);
  const journals: JournalRef[] = tpl.chart.journals.map((j) => ({
    id: `tpl-j:${j.code}`, code: j.code, name: j.names.ar, type: j.type, systemKey: j.systemKey,
    defaultAccountId: j.defaultAccountCode ? idOf(j.defaultAccountCode) : null, suspenseAccountId: null,
    useOutstandingAccounts: j.useOutstandingAccounts, sequenceReset: j.sequenceReset, isActive: true,
  }));
  return createBuildContext({
    settings: {
      templateKey: tpl.settings.templateKey, countryCode: tpl.settings.countryCode, currency: tpl.settings.currency,
      currencyDecimals: tpl.settings.currencyDecimals, ...settings,
    },
    accounts, mappings, journals,
  });
}

// ═══ القراءة من القاعدة ═══

/**
 * يقرأ صفوف المصادر المرشّحة في SQL بالشرطين (الأثر < cutoverStart و createdAt ≤ snapshotAt)، ويعيد
 * computeDerivedOpening الترشيح نفسه. داخل معاملة التفعيل يُمرَّر tx فتُقرأ الصفوف بلقطتها.
 */
export async function loadOpeningSources(db: GlDb, tenantId: string, cut: OpeningCutoff, opts: { includeInventory?: boolean } = {}): Promise<OpeningSources> {
  const before = { lt: cut.cutoverStart };
  const upTo = { lte: cut.snapshotAt };
  const [accountEntries, settlements, settlementEntries] = await Promise.all([
    db.accountEntry.findMany({
      where: { tenantId, entryDate: before, createdAt: upTo },
      select: {
        id: true, customerId: true, invoiceId: true, receiptId: true, type: true, debit: true, credit: true, entryDate: true, createdAt: true,
        invoice: { select: { type: true } },
      },
    }).then((rows) => rows.map(({ invoice, ...r }) => ({ ...r, invoiceType: invoice?.type ?? null }))),
    db.repSettlement.findMany({
      where: { tenantId, settledAt: before, createdAt: upTo },
      select: { id: true, salesRepId: true, amount: true, settledAt: true, createdAt: true },
    }),
    db.settlementEntry.findMany({
      where: { tenantId, createdAt: { lt: cut.cutoverStart, lte: cut.snapshotAt } },
      select: { id: true, amount: true, createdAt: true },
    }),
  ]);
  const receiptIds = [...new Set(accountEntries.map((e) => e.receiptId).filter((x): x is string => !!x))];
  const invoiceIds = [...new Set(accountEntries.filter((e) => e.invoiceId && !e.receiptId).map((e) => e.invoiceId as string))];
  const customerIds = [...new Set(accountEntries.map((e) => e.customerId))];
  const CHUNK = 5000;
  const chunks = <T>(xs: T[]): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK)); return out; };

  const receipts: OpeningReceiptRow[] = [];
  for (const ids of chunks(receiptIds)) {
    receipts.push(...await db.receipt.findMany({
      where: { tenantId, id: { in: ids }, salesRepId: { not: null } },
      select: { id: true, salesRepId: true, paymentMethod: true, amount: true },
    }));
  }
  const cashInvoices: OpeningCashInvoiceRow[] = [];
  for (const ids of chunks(invoiceIds)) {
    cashInvoices.push(...await db.invoice.findMany({
      where: { tenantId, id: { in: ids }, type: 'CASH', salesRepId: { not: null } },
      select: { id: true, salesRepId: true, total: true },
    }));
  }
  const customerNames: Record<string, string> = {};
  for (const ids of chunks(customerIds)) {
    for (const c of await db.customer.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true } })) customerNames[c.id] = c.name;
  }
  const repIds = [...new Set([...receipts.map((r) => r.salesRepId), ...cashInvoices.map((i) => i.salesRepId), ...settlements.map((s) => s.salesRepId)]
    .filter((x): x is string => !!x))];
  const salesRepNames: Record<string, string> = {};
  if (repIds.length) {
    for (const r of await db.salesRep.findMany({ where: { tenantId, id: { in: repIds } }, select: { id: true, name: true } })) salesRepNames[r.id] = r.name;
  }

  let warehouseItems: OpeningWarehouseItemRow[] = [];
  let vanItems: OpeningVanItemRow[] = [];
  if (opts.includeInventory !== false) {
    const [wh, van] = await Promise.all([
      db.warehouseEntryItem.findMany({
        where: { entry: { tenantId, createdAt: { lt: cut.cutoverStart, lte: cut.snapshotAt } } },
        select: { productId: true, qty: true, unitCost: true, entry: { select: { type: true, createdAt: true } } },
      }),
      db.vanLoadItem.findMany({
        where: { vanLoad: { tenantId, createdAt: { lt: cut.cutoverStart, lte: cut.snapshotAt } } },
        select: { productId: true, qty: true, vanLoad: { select: { type: true, createdAt: true, salesRepId: true } } },
      }),
    ]);
    warehouseItems = wh.map((i) => ({ productId: i.productId, qty: i.qty, type: i.entry.type, unitCost: i.unitCost, createdAt: i.entry.createdAt }));
    vanItems = van.map((i) => ({ productId: i.productId, qty: i.qty, type: i.vanLoad.type, salesRepId: i.vanLoad.salesRepId, createdAt: i.vanLoad.createdAt }));
  }

  return { accountEntries, receipts, cashInvoices, settlements, settlementEntries, warehouseItems, vanItems, customerNames, salesRepNames };
}

// ═══ JSON للاستجابة ═══

export function derivedOpeningJson(d: DerivedOpening, decimals: number) {
  const f = (m: Milli) => formatMilli(m, decimals);
  return {
    cutoverDate: d.cutoff.cutoverDate,
    openingDate: d.cutoff.openingDate,
    snapshotAt: d.cutoff.snapshotAt.toISOString(),
    receivables: d.receivables.map((r) => ({ customerId: r.customerId, customerName: r.customerName, balance: f(r.balanceMilli), rows: r.rows })),
    receivablesTotal: f(d.receivablesTotalMilli),
    custody: d.custody.map((c) => ({
      salesRepId: c.salesRepId, salesRepName: c.salesRepName, ledgerCustody: f(c.ledgerCustodyMilli),
      onlineUncleared: f(c.onlineUnclearedMilli), nonCustodyCleared: f(c.nonCustodyClearedMilli), suspenseCleared: f(c.suspenseClearedMilli),
      cashSalesOutsideCustody: f(c.cashSalesOutsideCustodyMilli), opsOutstanding: f(c.opsOutstandingMilli),
    })),
    custodyTotal: f(d.custodyTotalMilli),
    paylinkHeld: f(d.paylinkHeldMilli),
    warehouse: { value: f(d.warehouse.valueMilli), uncostedQty: d.warehouse.uncostedQty, uncostedProducts: d.warehouse.uncostedProducts },
    counts: d.counts,
  };
}

export function openingMoveJson(r: OpeningMoveResult, decimals: number) {
  const f = (m: Milli) => formatMilli(m, decimals);
  return {
    equityDiff: f(r.equityDiffMilli),
    totalDebit: f(r.totalDebitMilli),
    manualDebit: f(r.manualDebitMilli),
    manualCredit: f(r.manualCreditMilli),
    lineCount: r.lineCount,
  };
}
