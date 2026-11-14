// «ربط الدفاتر» L4+L5 (A1) — صفوف وحقائق مزيّفة مشتركة بين الاختبار الذهبي ومولّد لقطته.
// الحقائق تحمل الحقول الجديدة كلها (الختم والأقساط والتخصيصات ومصدر الاسترداد…): غير المربوطة يجب أن تتجاهلها حرفاً،
// فاللقطة الذهبية l458-a1-golden.json وُلّدت من desired.ts **قبل** التعديل على هذه الصفوف نفسها.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { CASH_VOID_KEEP_COLLECTION_NOTE } from '../lib/ledgerNotes';

const T = Date.parse('2026-11-14T09:00:00.000Z');
export const at = (ms: number): Date => new Date(T + ms);
const DAY = 86_400_000;

type Row = Record<string, any>;

function entry(id: string, type: string, o: Row = {}): Row {
  const { createdMs = 0, entryMs = createdMs, ...rest } = o;
  return {
    id, customerId: 'c1', invoiceId: null, receiptId: null, type, debit: 0, credit: 0, description: 'x',
    entryDate: at(entryMs), createdAt: at(createdMs), ...rest,
  };
}

function item(o: Row = {}): Row {
  return {
    productId: 'p1', categoryId: 'cat1', qty: 10, unitPrice: 100, taxPct: 15, taxAmt: 150, lineTotal: 1150, vatCategory: 'S',
    baseQty: 240, unitFactor: 24, productName: 'كرتون ماء', ...o,
  };
}

function invoice(id: string, type: string, o: Row = {}): Row {
  return {
    id, number: `INV-${id}`, type, customerId: 'c1', salesRepId: 'r1', pricesIncludeTax: false,
    subtotal: 1000, discountAmt: 0, taxAmt: 150, total: 1150, dueDate: null, customerName: 'عميل', salesRepName: 'مندوب',
    items: [item()],
    // الحقول الجديدة (L4) — يتجاهلها غير المربوط
    invoiceDate: at(0), cashCollectedByRep: false, installments: [], customerPaymentDays: 30, remainingApplied: null,
    saleInvoiceId: null, documentKind: null, originalInvoiceId: null,
    ...o,
  };
}

function receipt(id: string, o: Row = {}): Row {
  return {
    id, number: `RC-${id}`, customerId: 'c1', salesRepId: 'r1', paymentMethod: 'CASH', amount: 600,
    customerName: 'عميل', salesRepName: 'مندوب', paylinkId: null, refund: null,
    // الحقول الجديدة (L5)
    paymentMethodKey: null, cardPaymentId: null, allocations: [], cancelRefundFrom: null, cancelRefundUserId: null, cancelRefundUserName: null,
    ...o,
  };
}

export const INVOICES: Row[] = [
  // E4.2: نقدية مختومة
  invoice('cash1', 'CASH', { subtotal: 100, taxAmt: 15, total: 115, cashCollectedByRep: true, items: [item({ qty: 1, unitPrice: 100, taxAmt: 15, lineTotal: 115, baseQty: null, unitFactor: 1, productName: null })] }),
  // E4.1: آجلة بقسطين
  invoice('cr1', 'CREDIT', {
    dueDate: at(60 * DAY),
    installments: [
      { seq: 2, dueDate: new Date('2027-01-12T21:00:00.000Z'), amount: 575 },
      { seq: 1, dueDate: new Date('2026-12-13T21:00:00.000Z'), amount: 575 },
    ],
  }),
  // E4.4: آجلة بلا استحقاق ولا أقساط
  invoice('cr2', 'CREDIT', { items: [item({ productName: null, baseQty: null, unitFactor: 6, qty: 2.5, unitPrice: 400, lineTotal: 1150 })] }),
  // آجلة باستحقاق صريح
  invoice('cr3', 'CREDIT', { dueDate: new Date('2026-12-01T21:00:00.000Z') }),
  // مرتجع مرتبط أسقط من متبقّي البيع
  invoice('ret1', 'RETURN', { remainingApplied: 115, saleInvoiceId: 'cr1', subtotal: 100, taxAmt: 15, total: 115 }),
  // إشعار دائن (المرحلة الثانية)
  invoice('cn1', 'RETURN', { documentKind: 'CREDIT_NOTE', originalInvoiceId: 'cr3', subtotal: 100, taxAmt: 15, total: 115 }),
  // إشعار مدين: لا appliesTo
  invoice('dn1', 'CREDIT', { documentKind: 'DEBIT_NOTE', originalInvoiceId: 'cr3', customerPaymentDays: 0 }),
  // نقدية غير مختومة تُبطل بقاعدة Q1
  invoice('cash2', 'CASH', { subtotal: 100, taxAmt: 15, total: 115 }),
];

export const RECEIPTS: Row[] = [
  receipt('rc1', { allocations: [{ id: 'ri2', invoiceId: 'cr2', amount: 25 }, { id: 'ri1', invoiceId: 'cr1', amount: 575 }], paymentMethodKey: 'c_stcpay', paymentMethod: 'BANK_TRANSFER' }),
  receipt('rc2', { cancelRefundFrom: 'USER_CUSTODY', cancelRefundUserId: 'u1', cancelRefundUserName: 'سارة', amount: 500 }),
  receipt('rc3', { paymentMethod: 'POS', cardPaymentId: 'cp1', amount: 230, allocations: [{ id: 'ri3', invoiceId: 'cr3', amount: 230 }] }),
  receipt('rc4', { paymentMethod: 'ONLINE', amount: 1000, paylinkId: 'L1', refund: { entryId: 'se-r1', amount: -1000 }, cancelRefundFrom: 'MAIN_CASH' }),
  receipt('rc5', { paymentMethod: 'ONLINE', amount: 1000, paylinkId: 'L2', refund: null }),
];

export const ACCOUNT_ENTRY_ROWS: Row[] = [
  entry('a01', 'INVOICE_DEBIT', { invoiceId: 'cash1', debit: 115, createdMs: 0 }),
  entry('a02', 'RECEIPT_CREDIT', { invoiceId: 'cash1', credit: 115, createdMs: 2 }),
  entry('a03', 'INVOICE_DEBIT', { invoiceId: 'cr1', debit: 1150, createdMs: 10 }),
  entry('a04', 'INVOICE_DEBIT', { invoiceId: 'cr2', debit: 1150, createdMs: 20, entryMs: -DAY }),
  entry('a05', 'INVOICE_DEBIT', { invoiceId: 'cr3', debit: 1150, createdMs: 30 }),
  entry('a06', 'INVOICE_CREDIT', { invoiceId: 'ret1', credit: 115, createdMs: 40 }),
  entry('a07', 'INVOICE_CREDIT', { invoiceId: 'cn1', credit: 115, createdMs: 50 }),
  entry('a08', 'INVOICE_DEBIT', { invoiceId: 'dn1', debit: 1150, createdMs: 60 }),
  entry('a09', 'RECEIPT_CREDIT', { receiptId: 'rc1', credit: 600, createdMs: 70 }),
  entry('a10', 'RECEIPT_CREDIT', { receiptId: 'rc2', credit: 500, createdMs: 80 }),
  entry('a11', 'RECEIPT_DEBIT', { receiptId: 'rc2', debit: 500, createdMs: 90 }),
  entry('a12', 'RECEIPT_CREDIT', { receiptId: 'rc3', credit: 230, createdMs: 100 }),
  entry('a13', 'RECEIPT_CREDIT', { receiptId: 'rc4', credit: 1000, createdMs: 110 }),
  entry('a14', 'RECEIPT_DEBIT', { receiptId: 'rc4', debit: 1000, createdMs: 120 }),
  entry('a15', 'RECEIPT_DEBIT', { receiptId: 'rc5', debit: 1000, createdMs: 130 }),
  entry('a16', 'ADJUSTMENT_DEBIT', { debit: 500.555, description: 'رصيد مستورد', createdMs: 140, entryMs: -30 * DAY }),
  entry('a17', 'INVOICE_CREDIT', { invoiceId: 'cash2', credit: 115, createdMs: 150, description: CASH_VOID_KEEP_COLLECTION_NOTE }),
  entry('a18', 'INVOICE_CREDIT', { invoiceId: 'cr3', credit: 1150, createdMs: 160 }),
];

export const REP_SETTLEMENT_ROWS: Row[] = [
  { id: 's1', salesRepId: 'r1', amount: 800, method: 'CASH', note: null, settledAt: at(-DAY), createdAt: at(200), receivedByUserId: 'u1' },
  { id: 's2', salesRepId: 'r1', amount: 700.005, method: 'CHEQUE', note: 'شيك', settledAt: at(0), createdAt: at(210), receivedByUserId: null },
  { id: 's3', salesRepId: 'r2', amount: 300, method: 'BANK_TRANSFER', note: null, settledAt: at(5), createdAt: at(220), receivedByUserId: 'u2' },
];

export const SETTLEMENT_ENTRY_ROWS: Row[] = [
  { id: 'se-c1', kind: 'COLLECTED', amount: 1000, feeNet: null, feeVat: null, linkId: 'L1', payoutId: null, note: null, createdAt: at(300) },
  { id: 'se-f1', kind: 'FEE', amount: -41, feeNet: 35.65, feeVat: 5.35, linkId: 'L1', payoutId: null, note: 'عمولة', createdAt: at(301) },
  { id: 'se-r1', kind: 'REFUND', amount: -1000, feeNet: null, feeVat: null, linkId: 'L1', payoutId: null, note: 'استرداد', createdAt: at(302) },
  { id: 'se-p1', kind: 'PAYOUT', amount: -950, feeNet: null, feeVat: null, linkId: null, payoutId: 'po1', note: null, createdAt: at(303) },
  { id: 'se-r2', kind: 'REFUND', amount: -20, feeNet: null, feeVat: null, linkId: null, payoutId: null, note: null, createdAt: at(304) },
  { id: 'se-r3', kind: 'REFUND', amount: -30, feeNet: null, feeVat: null, linkId: 'L9', payoutId: null, note: null, createdAt: at(305) },
];

export const USER_SETTLEMENT_ROWS: Row[] = [
  { id: 'us1', fromUserId: 'u1', amount: 800, method: 'CASH', note: null, receivedBy: 'المدير', receivedByUserId: 'boss', settledAt: at(2 * DAY), createdAt: at(400) },
  { id: 'us2', fromUserId: 'u2', amount: 300.0049, method: 'BANK_TRANSFER', note: 'إيداع', receivedBy: null, receivedByUserId: null, settledAt: at(3 * DAY), createdAt: at(410) },
];

/** سياق الاشتقاق بالحقائق كلها والحقول الجديدة؛ linked يُضبط من المُستدعي */
export function deriveCtx(decimals: number, extra: Row = {}): any {
  const tz = 'Asia/Riyadh';
  return {
    timezone: tz, currency: decimals === 3 ? 'BHD' : decimals === 0 ? 'IQD' : 'SAR', currencyDecimals: decimals,
    invoices: new Map(INVOICES.map((i) => [i.id, i])),
    receipts: new Map(RECEIPTS.map((r) => [r.id, r])),
    customerNames: new Map([['c1', 'عميل واحد']]),
    salesRepNames: new Map([['r1', 'أحمد'], ['r2', 'خالد']]),
    payouts: new Map([['po1', { id: 'po1', bankReference: 'BR-1' }]]),
    userNames: new Map([['u1', 'سارة'], ['u2', 'ليلى'], ['boss', 'المدير']]),
    refundLinks: new Map([['L1', { receiptId: 'rc4', customerId: 'c1', customerName: 'عميل واحد' }], ['L9', { receiptId: null, customerId: 'c1', customerName: 'عميل واحد' }]]),
    ...extra,
  };
}

/** أحداث قابلة للتسلسل (effectAt ISO) للمقارنة العميقة باللقطة */
export function serializeEvents(evs: readonly Row[]): Row[] {
  return JSON.parse(JSON.stringify(evs.map((e) => ({ ...e, effectAt: (e.effectAt as Date).toISOString() }))));
}

export const GOLDEN_DECIMALS = [2, 3, 0] as const;
export const GOLDEN_SOURCES = ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY'] as const;

export function rowsOf(source: (typeof GOLDEN_SOURCES)[number]): Row[] {
  return source === 'ACCOUNT_ENTRY' ? ACCOUNT_ENTRY_ROWS : source === 'REP_SETTLEMENT' ? REP_SETTLEMENT_ROWS : SETTLEMENT_ENTRY_ROWS;
}
