// M3 — الأحداث المرغوبة من صفوف المصادر (DESIGN.md §5.2، §10.1 صف M3: gl-sync-desired-events.test.ts، GL‑01).
// صرفة بلا قاعدة: الحدث من نوع الصف ونوع الفاتورة لا من ترتيب الآثار ولا من createdAt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveAccountEntryEvents, deriveRepSettlementEvents, deriveSettlementEntryEvents, deriveSourceEvents, planAccountEntry,
  sourceEventCreateRow,
  type AccountEntrySourceRow, type DeriveContext, type InvoiceFacts, type ReceiptFacts, type SettlementEntrySourceRow,
} from '../services/gl/sync/desired';
import { decodeEventNote } from '../services/gl/sync/classify';
import { arEntryKey } from '../services/gl/sync/keys';
import type { DesiredEvent, InvoicePostEventPayload, ReceiptPostEventPayload, ReceiptReverseEventPayload } from '../services/gl/sync/types';

const T = Date.parse('2026-09-10T09:00:00.000Z');
const at = (ms: number) => new Date(T + ms);

function inv(id: string, type: 'CASH' | 'CREDIT' | 'RETURN', extra: Partial<InvoiceFacts> = {}): InvoiceFacts {
  return {
    id, number: `INV-${id}`, type, customerId: 'c1', salesRepId: 'r1', pricesIncludeTax: false,
    subtotal: 100, discountAmt: 10, taxAmt: 13.5, total: 103.5, dueDate: null, customerName: 'عميل', salesRepName: 'مندوب',
    items: [{ productId: 'p1', categoryId: 'cat1', qty: 2, unitPrice: 50, taxPct: 15, taxAmt: 13.5, lineTotal: 103.5, vatCategory: 'S' }],
    ...extra,
  };
}

function rec(id: string, extra: Partial<ReceiptFacts> = {}): ReceiptFacts {
  return {
    id, number: `RC-${id}`, customerId: 'c1', salesRepId: 'r1', paymentMethod: 'CASH', amount: 50,
    customerName: 'عميل', salesRepName: 'مندوب', paylinkId: null, refund: null, ...extra,
  };
}

function row(id: string, type: string, o: Partial<AccountEntrySourceRow> & { createdMs?: number; entryMs?: number } = {}): AccountEntrySourceRow {
  const { createdMs = 0, entryMs = createdMs, ...rest } = o;
  return {
    id, customerId: 'c1', invoiceId: null, receiptId: null, type, debit: 0, credit: 0, description: 'x',
    entryDate: at(entryMs), createdAt: at(createdMs), ...rest,
  };
}

function ctx(invoices: InvoiceFacts[] = [], receipts: ReceiptFacts[] = [], extra: Partial<DeriveContext> = {}): DeriveContext {
  return {
    timezone: 'Asia/Riyadh', currency: 'SAR', currencyDecimals: 2,
    invoices: new Map(invoices.map((i) => [i.id, i])), receipts: new Map(receipts.map((r) => [r.id, r])),
    customerNames: new Map([['c1', 'عميل واحد']]), ...extra,
  };
}

const keys = (evs: readonly DesiredEvent[]) => evs.map((e) => e.sourceKey).sort();

// ═══ الفاتورة النقدية ═══

test('صفّا فاتورة نقدية يختلف createdAt بينهما 1..5 مللي ثانية، بأي ترتيب ⇒ POST واحد بلا REVERSE', () => {
  const c = ctx([inv('i1', 'CASH')]);
  for (let d = 1; d <= 5; d++) {
    const debit = row('a1', 'INVOICE_DEBIT', { invoiceId: 'i1', createdMs: 0, debit: 103.5 });
    const credit = row('a2', 'RECEIPT_CREDIT', { invoiceId: 'i1', createdMs: d, credit: 103.5 });
    for (const order of [[debit, credit], [credit, debit]]) {
      const evs = deriveAccountEntryEvents(order, c);
      assert.deepEqual(keys(evs), ['INVOICE:i1:POST'], `d=${d}`);
      assert.equal(evs[0].event, 'POST');
      assert.equal(evs[0].status, undefined);
    }
  }
});

test('صفّا النقدية على جانبي حد صفحة ⇒ المفتاح نفسه في الصفحتين (يندمجان بـskipDuplicates) بلا REVERSE', () => {
  const c = ctx([inv('i1', 'CASH')]);
  const page1 = [row('a0', 'ADJUSTMENT_DEBIT', { createdMs: -5 }), row('a2', 'RECEIPT_CREDIT', { invoiceId: 'i1', createdMs: 0 })];
  const page2 = [row('a1', 'INVOICE_DEBIT', { invoiceId: 'i1', createdMs: 3 }), row('a3', 'ADJUSTMENT_CREDIT', { createdMs: 9 })];
  const all = new Set([...deriveAccountEntryEvents(page1, c), ...deriveAccountEntryEvents(page2, c)].map((e) => e.sourceKey));
  assert.deepEqual([...all].sort(), ['AR_ENTRY:a0:POST', 'AR_ENTRY:a3:POST', 'INVOICE:i1:POST']);
});

test('إلغاء نقدي: INVOICE_CREDIT وRECEIPT_DEBIT بمللي ثانية مختلفة ⇒ REVERSE واحد', () => {
  const c = ctx([inv('i1', 'CASH')]);
  const evs = deriveAccountEntryEvents([
    row('b2', 'RECEIPT_DEBIT', { invoiceId: 'i1', createdMs: 60_000 }),
    row('b1', 'INVOICE_CREDIT', { invoiceId: 'i1', createdMs: 60_004 }),
  ], c);
  assert.deepEqual(keys(evs), ['INVOICE:i1:REVERSE']);
  assert.equal(evs[0].event, 'REVERSE');
  const p = evs[0].payload as { invoiceId: string; type: string; entryDate: string };
  assert.deepEqual({ invoiceId: p.invoiceId, type: p.type, entryDate: p.entryDate }, { invoiceId: 'i1', type: 'CASH', entryDate: '2026-09-10' });
});

// ═══ الآجلة والمرتجع ═══

test('فاتورة RETURN: INVOICE_CREDIT ⇒ POST ثم INVOICE_DEBIT لاحقاً ⇒ REVERSE', () => {
  const c = ctx([inv('r1', 'RETURN')]);
  assert.deepEqual(keys(deriveAccountEntryEvents([row('x1', 'INVOICE_CREDIT', { invoiceId: 'r1' })], c)), ['INVOICE:r1:POST']);
  assert.deepEqual(keys(deriveAccountEntryEvents([row('x2', 'INVOICE_DEBIT', { invoiceId: 'r1', createdMs: 86_400_000 })], c)), ['INVOICE:r1:REVERSE']);
});

test('فاتورة CREDIT: INVOICE_DEBIT ⇒ POST ثم INVOICE_CREDIT ⇒ REVERSE (ومعاً في صفحة ⇒ الاثنان)', () => {
  const c = ctx([inv('k1', 'CREDIT')]);
  assert.deepEqual(keys(deriveAccountEntryEvents([row('x1', 'INVOICE_DEBIT', { invoiceId: 'k1' })], c)), ['INVOICE:k1:POST']);
  assert.deepEqual(keys(deriveAccountEntryEvents([row('x2', 'INVOICE_CREDIT', { invoiceId: 'k1' })], c)), ['INVOICE:k1:REVERSE']);
  assert.deepEqual(keys(deriveAccountEntryEvents([row('x1', 'INVOICE_DEBIT', { invoiceId: 'k1' }), row('x2', 'INVOICE_CREDIT', { invoiceId: 'k1', createdMs: 1 })], c)),
    ['INVOICE:k1:POST', 'INVOICE:k1:REVERSE']);
});

test('صف عكس في النافذة أصله أقدم من المؤشر ⇒ REVERSE لا POST أبداً', () => {
  for (const [type, t, kind] of [['INVOICE_CREDIT', 'CREDIT', 'k'], ['INVOICE_CREDIT', 'CASH', 'c'], ['RECEIPT_DEBIT', 'CASH', 'c'], ['INVOICE_DEBIT', 'RETURN', 'r']] as const) {
    const c = ctx([inv(`${kind}9`, t)]);
    const evs = deriveAccountEntryEvents([row('z', type, { invoiceId: `${kind}9`, createdMs: 10 })], c);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].event, 'REVERSE', `${type} على ${t}`);
  }
  const evs = deriveAccountEntryEvents([row('z', 'RECEIPT_DEBIT', { receiptId: 'rc1' })], ctx([], [rec('rc1')]));
  assert.deepEqual(keys(evs), ['RECEIPT:rc1:REVERSE']);
});

test('إعادة قراءة الصفوف نفسها عبر نافذة التداخل أو شبكة الأمان ⇒ مجموعة المفاتيح نفسها', () => {
  const c = ctx([inv('i1', 'CASH'), inv('k1', 'CREDIT'), inv('r1', 'RETURN')], [rec('rc1')]);
  const rows = [
    row('a1', 'INVOICE_DEBIT', { invoiceId: 'i1', createdMs: 0 }),
    row('a2', 'RECEIPT_CREDIT', { invoiceId: 'i1', createdMs: 2 }),
    row('a3', 'INVOICE_DEBIT', { invoiceId: 'k1', createdMs: 4 }),
    row('a4', 'RECEIPT_CREDIT', { receiptId: 'rc1', createdMs: 6 }),
    row('a5', 'INVOICE_CREDIT', { invoiceId: 'r1', createdMs: 8 }),
    row('a6', 'ADJUSTMENT_DEBIT', { createdMs: 10 }),
    row('a7', 'INVOICE_CREDIT', { invoiceId: 'k1', createdMs: 12 }),
  ];
  const whole = new Set(keys(deriveAccountEntryEvents(rows, c)));
  // نوافذ متداخلة بأحجام مختلفة
  for (const size of [1, 2, 3, 5]) {
    for (let overlap = 0; overlap < size; overlap++) {
      const seen = new Set<string>();
      for (let i = 0; i < rows.length; i += Math.max(1, size - overlap)) {
        for (const k of keys(deriveAccountEntryEvents(rows.slice(i, i + size), c))) seen.add(k);
      }
      assert.deepEqual([...seen].sort(), [...whole].sort(), `size=${size} overlap=${overlap}`);
    }
  }
  // مرتان (شبكة الأمان) بترتيب معكوس
  assert.deepEqual(keys(deriveAccountEntryEvents([...rows].reverse(), c)), keys(deriveAccountEntryEvents(rows, c)));
});

// ═══ HELD ═══

test('صف RECEIPT_* على فاتورة CREDIT أو RETURN أو فاتورة مفقودة ⇒ HELD(UNEXPECTED_ENTRY_SHAPE) بلا تخمين', () => {
  const c = ctx([inv('k1', 'CREDIT'), inv('r1', 'RETURN')]);
  const cases: [AccountEntrySourceRow, string][] = [
    [row('h1', 'RECEIPT_CREDIT', { invoiceId: 'k1' }), 'INVOICE:k1:POST'],
    [row('h2', 'RECEIPT_DEBIT', { invoiceId: 'r1' }), 'INVOICE:r1:REVERSE'],
    [row('h3', 'INVOICE_DEBIT', { invoiceId: 'missing' }), 'INVOICE:missing:POST'],
    [row('h4', 'RECEIPT_CREDIT', { receiptId: 'nope' }), 'RECEIPT:nope:POST'],
  ];
  for (const [r, key] of cases) {
    const [e] = deriveAccountEntryEvents([r], c);
    assert.equal(e.sourceKey, key);
    assert.equal(e.status, 'HELD');
    const note = decodeEventNote(e.lastError ?? '');
    assert.ok(note && note.kind === 'HELD' && note.reason === 'UNEXPECTED_ENTRY_SHAPE', String(e.lastError));
  }
  // الفاتورة المفقودة بلا حمولة
  assert.equal(deriveAccountEntryEvents([cases[2][0]], c)[0].payload, null);
  // HELD يغلب في المفتاح نفسه داخل الدفعة
  const mixed = deriveAccountEntryEvents([row('m1', 'INVOICE_DEBIT', { invoiceId: 'k1' }), row('m2', 'RECEIPT_CREDIT', { invoiceId: 'k1', createdMs: 1 })], c);
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].status, 'HELD');
  assert.equal(sourceEventCreateRow('t', mixed[0]).status, 'HELD');
});

// ═══ effectAt ═══

test('effectAt من الصف الأساسي، أو أصغر entryDate حين يغيب', () => {
  const c = ctx([inv('i1', 'CASH'), inv('r1', 'RETURN')]);
  // الأساسي INVOICE_DEBIT وإن كان المقترن أبكر
  const both = deriveAccountEntryEvents([
    row('a2', 'RECEIPT_CREDIT', { invoiceId: 'i1', entryMs: -3_600_000 }),
    row('a1', 'INVOICE_DEBIT', { invoiceId: 'i1', entryMs: 0 }),
  ], c);
  assert.equal(both[0].effectAt.getTime(), T);
  // المقترن وحده ⇒ أصغر entryDate تحته
  const only = deriveAccountEntryEvents([
    row('a2', 'RECEIPT_CREDIT', { invoiceId: 'i1', entryMs: 500 }),
  ], c);
  assert.equal(only[0].effectAt.getTime(), T + 500);
  // المرتجع: INVOICE_DEBIT أساسي العكس
  const rev = deriveAccountEntryEvents([row('x', 'INVOICE_DEBIT', { invoiceId: 'r1', entryMs: 7_000 })], c);
  assert.equal(rev[0].effectAt.getTime(), T + 7_000);
  assert.equal(planAccountEntry(row('x', 'INVOICE_DEBIT', { invoiceId: 'r1' }), c.invoices).primary, true);
  assert.equal(planAccountEntry(row('y', 'RECEIPT_CREDIT', { invoiceId: 'i1' }), c.invoices).primary, false);
});

// ═══ مصادر الأمانات والاستلام ═══

test('COLLECTED وREFUND بلا حدث، وFEE ⇒ PAYLINK_FEE:<entryId>، وPAYOUT ⇒ PAYOUT:<payoutId> (effectAt=createdAt)', () => {
  const se = (id: string, kind: string, o: Partial<SettlementEntrySourceRow> = {}): SettlementEntrySourceRow => ({
    id, kind, amount: -4.5, feeNet: null, feeVat: null, linkId: 'L1', payoutId: null, note: null, createdAt: at(1000), ...o,
  });
  const c = ctx([], [], { payouts: new Map([['p1', { id: 'p1', bankReference: 'BR-1' }]]) });
  assert.deepEqual(deriveSettlementEntryEvents([se('e1', 'COLLECTED', { amount: 100 }), se('e2', 'REFUND', { amount: -100 })], c), []);
  const evs = deriveSettlementEntryEvents([
    se('e3', 'FEE', { feeNet: 3.91, feeVat: 0.59 }),
    se('e4', 'PAYOUT', { amount: -500, payoutId: 'p1', linkId: null }),
  ], c);
  assert.deepEqual(evs.map((e) => [e.sourceKey, e.sourceType, e.sourceId, e.effectAt.getTime()]), [
    ['PAYLINK_FEE:e3', 'PAYLINK_FEE', 'e3', T + 1000],
    ['PAYOUT:p1', 'PAYOUT', 'p1', T + 1000],
  ]);
  assert.deepEqual(
    { ...(evs[0].payload as object), createdAt: undefined, sourceCreatedAt: undefined },
    { entryId: 'e3', amount: '-4.50', feeNet: '3.91', feeVat: '0.59', createdAt: undefined, linkId: 'L1', note: null, sourceCreatedAt: undefined },
  );
  assert.equal((evs[1].payload as { bankReference: string; amount: string }).bankReference, 'BR-1');
  assert.equal((evs[1].payload as { amount: string }).amount, '-500.00');
});

test('rep_settlements ⇒ SETTLEMENT:<id>:POST بحمولة {amount, method, salesRepId, settledAt, createdAt} وeffectAt=settledAt', () => {
  const evs = deriveRepSettlementEvents([{ id: 's1', salesRepId: 'r1', amount: 200, method: 'CASH', note: null, settledAt: at(-86_400_000), createdAt: at(0) }],
    ctx([], [], { salesRepNames: new Map([['r1', 'أحمد']]) }));
  assert.equal(evs[0].sourceKey, 'SETTLEMENT:s1:POST');
  assert.equal(evs[0].effectAt.getTime(), T - 86_400_000);
  const p = evs[0].payload as Record<string, unknown>;
  assert.equal(p.amount, '200.00');
  assert.equal(p.method, 'CASH');
  assert.equal(p.salesRepId, 'r1');
  assert.equal(p.settledAt, at(-86_400_000).toISOString());
  assert.equal(p.createdAt, at(0).toISOString());
  assert.equal(p.salesRepName, 'أحمد');
});

// ═══ AR_ENTRY ═══

test('صفوف بلا مستند ⇒ AR_ENTRY:<entryId>:POST من arEntryKey بحمولة {customerId, debit, credit, description, entryDate, createdAt} ولقطة الاسم', () => {
  const evs = deriveAccountEntryEvents([
    row('e1', 'ADJUSTMENT_DEBIT', { debit: 250.255, description: 'رصيد افتتاحي', entryMs: -86_400_000 * 30 }),
    row('e2', 'ADJUSTMENT_CREDIT', { credit: 10, createdMs: 1 }),
  ], ctx());
  assert.deepEqual(evs.map((e) => e.sourceKey), [arEntryKey('e1'), arEntryKey('e2')]);
  assert.equal(evs[0].sourceType, 'AR_ENTRY');
  assert.equal(evs[0].effectAt.getTime(), T - 86_400_000 * 30);
  const p = evs[0].payload as Record<string, unknown>;
  assert.equal(p.entryId, 'e1');
  assert.equal(p.customerId, 'c1');
  assert.equal(p.customerName, 'عميل واحد');
  assert.equal(p.debit, '250.26');
  assert.equal(p.credit, '0.00');
  assert.equal(p.description, 'رصيد افتتاحي');
  assert.equal(p.entryDate, new Date(T - 86_400_000 * 30).toISOString());
  assert.equal(p.createdAt, at(0).toISOString());
  // صف INVOICE_* بلا فاتورة ولا سند ⇒ HELD
  const [odd] = deriveAccountEntryEvents([row('e3', 'INVOICE_DEBIT')], ctx());
  assert.equal(odd.sourceKey, 'AR_ENTRY:e3:POST');
  assert.equal(odd.status, 'HELD');
});

// ═══ لقطة الحمولة ═══

test('INVOICE POST يحمل الحمولة الدنيا بمبالغ نصية وأوزان البنود وsourceCreatedAt = أكبر createdAt', () => {
  const c = ctx([inv('i1', 'CASH', { dueDate: new Date('2026-10-10T21:30:00Z'), pricesIncludeTax: true })]);
  const [e] = deriveAccountEntryEvents([
    row('a1', 'INVOICE_DEBIT', { invoiceId: 'i1', createdMs: 0, entryMs: 0 }),
    row('a2', 'RECEIPT_CREDIT', { invoiceId: 'i1', createdMs: 4 }),
  ], c);
  const p = e.payload as InvoicePostEventPayload;
  assert.equal(p.invoiceId, 'i1');
  assert.equal(p.type, 'CASH');
  assert.equal(p.salesRepId, 'r1');
  assert.equal(p.subtotal, '100.00');
  assert.equal(p.discountAmt, '10.00');
  assert.equal(p.taxAmt, '13.50');
  assert.equal(p.total, '103.50');
  assert.equal(p.currency, 'SAR');
  assert.equal(p.currencyDecimals, 2);
  assert.equal(p.pricesIncludeTax, true);
  assert.equal(p.entryDate, '2026-09-10');
  assert.equal(p.dueDate, '2026-10-11'); // بتوقيت الرياض
  assert.deepEqual(p.items[0], { productId: 'p1', categoryId: 'cat1', qty: 2, unitPrice: 50, taxPct: 15, taxAmt: '13.50', lineTotal: '103.50', vatCategory: 'S' });
  assert.equal(p.sourceCreatedAt, at(4).toISOString());
  for (const k of ['subtotal', 'discountAmt', 'taxAmt', 'total'] as const) assert.equal(typeof p[k], 'string');
  // لا BigInt في الحمولة (Json)
  assert.doesNotThrow(() => JSON.stringify(e.payload));
});

test('سند ONLINE يحمل paylinkId من CustomerPaymentLink.receiptId، وREVERSE يحمل {paylinkId, refundEntryId, refundedAmount}', () => {
  const online = rec('rc1', { paymentMethod: 'ONLINE', amount: 115, paylinkId: 'link-by-receiptId', refund: { entryId: 'se-refund', amount: -115 } });
  const c = ctx([], [online]);
  const [post] = deriveAccountEntryEvents([row('p1', 'RECEIPT_CREDIT', { receiptId: 'rc1' })], c);
  const pp = post.payload as ReceiptPostEventPayload;
  assert.equal(post.sourceKey, 'RECEIPT:rc1:POST');
  assert.deepEqual(
    { salesRepId: pp.salesRepId, paymentMethod: pp.paymentMethod, amount: pp.amount, customerId: pp.customerId, paylinkId: pp.paylinkId },
    { salesRepId: 'r1', paymentMethod: 'ONLINE', amount: '115.00', customerId: 'c1', paylinkId: 'link-by-receiptId' },
  );
  const [rev] = deriveAccountEntryEvents([row('p2', 'RECEIPT_DEBIT', { receiptId: 'rc1', createdMs: 5000 })], c);
  const rp = rev.payload as ReceiptReverseEventPayload;
  assert.equal(rev.sourceKey, 'RECEIPT:rc1:REVERSE');
  assert.deepEqual({ paylinkId: rp.paylinkId, refundEntryId: rp.refundEntryId, refundedAmount: rp.refundedAmount },
    { paylinkId: 'link-by-receiptId', refundEntryId: 'se-refund', refundedAmount: '-115.00' });
  // إلغاء يدوي بلا REFUND
  const manual = deriveAccountEntryEvents([row('p3', 'RECEIPT_DEBIT', { receiptId: 'rc2' })], ctx([], [rec('rc2', { paymentMethod: 'ONLINE', paylinkId: 'L2' })]));
  assert.deepEqual({ ...(manual[0].payload as ReceiptReverseEventPayload), receiptId: undefined, entryDate: undefined, sourceCreatedAt: undefined, paymentMethod: undefined },
    { receiptId: undefined, entryDate: undefined, sourceCreatedAt: undefined, paymentMethod: undefined, paylinkId: 'L2', refundEntryId: null, refundedAmount: null });
});

test('deriveSourceEvents يوزّع حسب المصدر، وsourceEventCreateRow الافتراضي PENDING بلا SKIPPED', () => {
  const evs = deriveSourceEvents('ACCOUNT_ENTRY', [row('e1', 'ADJUSTMENT_DEBIT')], ctx());
  const r = sourceEventCreateRow('t1', evs[0]);
  assert.equal(r.status, 'PENDING');
  assert.equal(r.tenantId, 't1');
  assert.equal('skipReason' in r, false);
});
