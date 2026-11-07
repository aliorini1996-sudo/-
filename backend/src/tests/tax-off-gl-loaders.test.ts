// «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — ختم الفاتورة Invoice.taxFree يصل قيدها في الدفاتر من المحمّلات الثلاثة:
// المُطابِق (reconcilerStore.loadFacts ⇒ InvoiceFacts ⇒ desired)، والمُرحِّل (PrismaPostingTx.loadSourceData)، فيبلغ فرع
// buildInvoiceMove: لا مفتاح ضريبة ولا سطر علامة ولا «0٪». والفاتورة بضريبتها (taxFree=false أو غائب) حمولتها حرفاً كما كانت.
// Prisma مزيّف في الذاكرة يلتقط الاستعلامات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoiceMove, type InvoicePayload } from '../services/gl/builders/invoice';
import { saContext } from '../services/gl/testing/fixtures';
import type { MoveDraft } from '../services/gl/types';
import { deriveAccountEntryEvents, type AccountEntrySourceRow, type DeriveContext, type InvoiceFacts } from '../services/gl/sync/desired';
import { createPrismaReconcilerStore } from '../services/gl/sync/reconcilerStore.prisma';
import { PrismaPostingTx } from '../services/gl/sync/postingStore.prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const AT = new Date('2026-11-07T09:00:00.000Z');

/** صفّ الفاتورة كما تعيده القاعدة (select المحمّلَين): بنود صفرية؛ taxFree: undefined ⇒ صفٌّ قبل العمود */
function invoiceRow(taxFree: boolean | undefined): Row {
  return {
    id: 'inv1', number: 'INV-0001', type: 'CREDIT', customerId: 'c1', salesRepId: 'r1', pricesIncludeTax: false,
    subtotal: 120, discountAmt: 0, taxAmt: 0, total: 120, dueDate: null,
    ...(taxFree !== undefined && { taxFree }),
    customer: { name: 'مؤسسة النور' }, salesRep: { name: 'خالد' },
    items: [{ productId: 'p1', qty: 3, unitPrice: 40, taxPct: 0, taxAmt: 0, lineTotal: 120, vatCategory: null, product: { categoryId: null } }],
  };
}
const debitRow: AccountEntrySourceRow = {
  id: 'ae1', customerId: 'c1', invoiceId: 'inv1', receiptId: null, type: 'INVOICE_DEBIT', debit: 120, credit: 0,
  description: 'فاتورة INV-0001', entryDate: AT, createdAt: AT,
};

// ═══ المُطابِق: reconcilerStore.loadFacts ⇒ desired ═══

async function reconcilerPayload(taxFree: boolean | undefined) {
  const selects: Row[] = [];
  const db = {
    invoice: { findMany: async (a: Row) => { selects.push(a.select); return [invoiceRow(taxFree)]; } },
  };
  const store = createPrismaReconcilerStore(db as never);
  const ctx: DeriveContext = await store.loadFacts('t1', 'ACCOUNT_ENTRY', [debitRow], {
    tenantId: 't1', activatedAt: AT, timezone: 'Asia/Riyadh', currency: 'SAR', currencyDecimals: 2,
  });
  const evs = deriveAccountEntryEvents([debitRow], ctx);
  assert.deepEqual(evs.map((e) => e.sourceKey), ['INVOICE:inv1:POST']);
  return { selects, facts: ctx.invoices!.get('inv1')!, payload: evs[0].payload as unknown as InvoicePayload & Row };
}

test('المُطابِق: select الفاتورة يحمل taxFree، والحقائق تمرّره، والحمولة تحمله حين true', async () => {
  const r = await reconcilerPayload(true);
  assert.equal(r.selects[0].taxFree, true);
  assert.equal(r.facts.taxFree, true);
  assert.equal(r.payload.taxFree, true);
});

test('المُطابِق: الفاتورة بضريبتها (false أو صفٌّ قبل العمود) ⇒ الحمولة بلا المفتاح وحرفاً كما كانت', async () => {
  const off = await reconcilerPayload(false);
  const legacy = await reconcilerPayload(undefined);
  assert.ok(!('taxFree' in off.payload));
  assert.equal(JSON.stringify(off.payload), JSON.stringify(legacy.payload));
});

test('desired: InvoiceFacts بـtaxFree يمرّ إلى الحمولة، وfalse/الغائب لا يغيّران حرفاً', () => {
  const base: InvoiceFacts = {
    id: 'inv1', number: 'INV-0001', type: 'CREDIT', customerId: 'c1', salesRepId: 'r1', pricesIncludeTax: false,
    subtotal: 120, discountAmt: 0, taxAmt: 0, total: 120, dueDate: null, customerName: 'مؤسسة النور', salesRepName: 'خالد',
    items: [{ productId: 'p1', categoryId: null, qty: 3, unitPrice: 40, taxPct: 0, taxAmt: 0, lineTotal: 120, vatCategory: null }],
  };
  const payloadOf = (f: InvoiceFacts) => {
    const ctx: DeriveContext = { timezone: 'Asia/Riyadh', currency: 'SAR', currencyDecimals: 2, invoices: new Map([['inv1', f]]) };
    return deriveAccountEntryEvents([debitRow], ctx)[0].payload as unknown as Row;
  };
  const legacy = payloadOf(base);
  assert.equal(JSON.stringify(payloadOf({ ...base, taxFree: false })), JSON.stringify(legacy));
  assert.equal(JSON.stringify(payloadOf({ ...base, taxFree: null })), JSON.stringify(legacy));
  const free = payloadOf({ ...base, taxFree: true });
  assert.equal(free.taxFree, true);
  const { taxFree: _t, ...rest } = free;
  void _t;
  assert.equal(JSON.stringify(rest), JSON.stringify(legacy), 'المفتاح وحده يُضاف');
});

// ═══ المُرحِّل: PrismaPostingTx.loadSourceData ═══

async function posterPayload(taxFree: boolean | undefined) {
  const selects: Row[] = [];
  const tx = {
    glSettings: { findUnique: async () => ({ timezone: 'Asia/Riyadh', currency: 'SAR', currencyDecimals: 2, receiptRouting: null, cashInvoiceRouting: 'MAIN_CASH', setupMethod: null, openingSnapshotAt: null }) },
    invoice: { findFirst: async (a: Row) => { selects.push(a.select); return invoiceRow(taxFree); } },
    accountEntry: { findMany: async () => [{ type: 'INVOICE_DEBIT', entryDate: AT, createdAt: AT }] },
  };
  const ptx = new PrismaPostingTx(tx as never, 't1');
  const data = await ptx.loadSourceData('INVOICE', 'inv1', 'POST');
  assert.equal(data.kind, 'FOUND');
  return { selects, payload: (data as { payload: unknown }).payload as InvoicePayload & Row };
}

test('المُرحِّل: select الفاتورة يحمل taxFree والحمولة تحمله حين true — وبضريبتها بلا المفتاح وحرفاً كما كانت', async () => {
  const free = await posterPayload(true);
  assert.equal(free.selects[0].taxFree, true);
  assert.equal(free.payload.taxFree, true);
  const off = await posterPayload(false);
  const legacy = await posterPayload(undefined);
  assert.ok(!('taxFree' in off.payload));
  assert.equal(JSON.stringify(off.payload), JSON.stringify(legacy.payload));
});

// ═══ القيد من حمولة المحمّلَين ═══

test('القيد من حمولة المحمّلَين: الفاتورة المختومة بلا علامة ولا مفتاح ضريبة ولا «0٪» — وغير المختومة كما كانت (علامة Z_SALE)', async () => {
  const ctx = saContext();
  for (const load of [reconcilerPayload, posterPayload]) {
    const before = buildInvoiceMove((await load(false)).payload, ctx) as MoveDraft;
    assert.equal(before.kind, 'MOVE');
    assert.equal(before.lines.filter((l) => l.taxRole === 'MARKER').length, 1, 'سلوك اليوم: علامة الصفرية');

    const m = buildInvoiceMove((await load(true)).payload, ctx) as MoveDraft;
    assert.equal(m.kind, 'MOVE');
    assert.deepEqual(m.lines.filter((l) => l.taxRole || l.taxId || l.taxCode || l.vatBox), [], 'لا أثر ضريبي في أي سطر');
    for (const l of m.lines) assert.doesNotMatch(l.label, /٪|ضريب/, l.label);
    const sums = (x: MoveDraft) => x.lines.filter((l) => l.taxRole !== 'MARKER').map((l) => [l.debitMilli, l.creditMilli]);
    assert.deepEqual(sums(m), sums(before), 'المبالغ نفسها');
  }
});
