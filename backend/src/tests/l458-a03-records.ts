/**
 * L4 (A3) — قيود مخزَّنة مزيّفة (MoveRecordForDraft) لاختبار reversalDraftFromRecord وOD17 ولقطته الذهبية.
 * صرفة: لا قاعدة ولا ساعة.
 */
import type { MoveRecordForDraft } from '../services/gl/resolve';

type RecLine = MoveRecordForDraft['lines'][number];

function line(p: Partial<RecLine> & Pick<RecLine, 'accountId' | 'debitMilli' | 'creditMilli'>): RecLine {
  return {
    label: 'سطر', customerId: null, vendorId: null, salesRepId: null, partnerName: null, analyticAccountId: null,
    productId: null, quantity: null, taxId: null, taxRole: null, taxBaseMilli: null, vatBox: null, vatAdjustment: false,
    dueDate: null, ...p,
  };
}

/** فاتورة آجلة 2026-09-28: ذمة 115 / إيراد 100 / ضريبة 15 (SA_1) / علامة صفرية */
export function saleRecord(date = '2026-09-28'): MoveRecordForDraft {
  return {
    moveType: 'OUT_INVOICE', origin: 'AUTO', date: new Date(`${date}T00:00:00.000Z`), originalDate: null, lateArrival: false,
    ref: 'INV-1', narration: 'فاتورة مبيعات آجلة INV-1', needsAttention: false, attentionReason: null,
    customerId: 'c1', vendorId: null, salesRepId: 'r1', sourceType: 'INVOICE', sourceId: 'inv1', currencyCode: 'SAR', currencyDecimals: 2,
    journal: { code: 'INV', systemKey: 'SALES' },
    lines: [
      line({ accountId: 'acc_113001', label: 'ذمة فاتورة مبيعات INV-1', debitMilli: 115_000n, creditMilli: 0n, customerId: 'c1', salesRepId: 'r1', partnerName: 'عميل', dueDate: new Date('2026-10-28T00:00:00.000Z') }),
      line({ accountId: 'acc_411001', label: 'إيراد مبيعات INV-1 — 15٪', debitMilli: 0n, creditMilli: 100_000n, taxId: 'tax_S15_SALE', taxRole: 'BASE', productId: 'pA', quantity: 24 }),
      line({ accountId: 'acc_212001', label: 'ضريبة القيمة المضافة 15٪ — INV-1', debitMilli: 0n, creditMilli: 15_000n, taxId: 'tax_S15_SALE', taxRole: 'TAX', taxBaseMilli: 100_000n, vatBox: 'SA_1' }),
      line({ accountId: 'acc_212001', label: 'وعاء مبيعات صفرية — INV-1', debitMilli: 0n, creditMilli: 0n, taxId: 'tax_Z_SALE', taxRole: 'MARKER', taxBaseMilli: 0n, vatBox: 'SA_4' }),
    ],
  };
}

/** مرتجع 2026-09-28: سطور الضريبة معلَّمة vatAdjustment=true أصلاً */
export function returnRecord(date = '2026-09-28'): MoveRecordForDraft {
  return {
    moveType: 'OUT_REFUND', origin: 'AUTO', date: new Date(`${date}T00:00:00.000Z`), originalDate: null, lateArrival: false,
    ref: 'RET-1', narration: 'مرتجع مبيعات RET-1', needsAttention: false, attentionReason: null,
    customerId: 'c1', vendorId: null, salesRepId: 'r1', sourceType: 'INVOICE', sourceId: 'ret1', currencyCode: 'SAR', currencyDecimals: 2,
    journal: { code: 'INV', systemKey: 'SALES' },
    lines: [
      line({ accountId: 'acc_412001', label: 'مردودات مبيعات RET-1', debitMilli: 100_000n, creditMilli: 0n, taxId: 'tax_S15_SALE', taxRole: 'BASE' }),
      line({ accountId: 'acc_212001', label: 'ضريبة — RET-1', debitMilli: 15_000n, creditMilli: 0n, taxId: 'tax_S15_SALE', taxRole: 'TAX', taxBaseMilli: -100_000n, vatBox: 'SA_1', vatAdjustment: true }),
      line({ accountId: 'acc_113001', label: 'ذمة مرتجع RET-1', debitMilli: 0n, creditMilli: 115_000n, customerId: 'c1', salesRepId: 'r1', partnerName: 'عميل' }),
    ],
  };
}

/** سند قبض بلا ضريبة (لا TAX ولا MARKER) */
export function receiptRecord(date = '2026-09-28'): MoveRecordForDraft {
  return {
    moveType: 'CUST_RECEIPT', origin: 'AUTO', date: new Date(`${date}T00:00:00.000Z`), originalDate: null, lateArrival: false,
    ref: 'RC-1', narration: 'سند قبض RC-1', needsAttention: false, attentionReason: null,
    customerId: 'c1', vendorId: null, salesRepId: null, sourceType: 'RECEIPT', sourceId: 'rc1', currencyCode: 'SAR', currencyDecimals: 2,
    journal: { code: 'RCPT', systemKey: 'RECEIPTS' },
    lines: [
      line({ accountId: 'acc_111001', label: 'تحصيل', debitMilli: 50_000n, creditMilli: 0n }),
      line({ accountId: 'acc_113001', label: 'ذمة', debitMilli: 0n, creditMilli: 50_000n, customerId: 'c1', partnerName: 'عميل' }),
    ],
  };
}

export function goldenRecords(): MoveRecordForDraft[] {
  return [saleRecord(), returnRecord(), receiptRecord()];
}
