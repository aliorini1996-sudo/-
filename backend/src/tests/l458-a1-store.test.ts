// «ربط الدفاتر» L4+L5 (A1): التحميل والمُطابِق ومؤشر USER_SETTLEMENT — بقاعدة مزيّفة في الذاكرة تلتقط الاستعلامات.
// - facts.prisma.ts: غير المربوطة بـselect اليوم حرفاً وبلا استعلام زائد، والمربوطة بالحقائق كلها، وكلاهما مجمّع بلا N+1.
// - reconcilerStore.prisma.ts: linked من gl_settings، وصفحة user_settlements، والأسماء والروابط للمربوطة وحدها.
// - reconciler.ts: لا قراءة لمؤشر USER_SETTLEMENT لغير المربوطة (ولا إعداداتها في شبكة الأمان)، والمربوطة تلتقط توريداتها.
// - locks.ts: activeSyncSources الافتراضي كما كان، وlinked يُلحق USER_SETTLEMENT (ويحجب الإقفال إن تأخر مؤشره).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAdminNames, loadInvoiceFacts, loadReceiptFacts, loadRefundLinks } from '../services/gl/sync/facts.prisma';
import { createPrismaReconcilerStore } from '../services/gl/sync/reconcilerStore.prisma';
import {
  reconcileTenant, safetyNetScan, type CommitPageResult, type PageQuery, type ReconcileSettings, type ReconcilerStore,
} from '../services/gl/sync/reconciler';
import { deriveSourceEvents, type DeriveContext, type ReconciledSource, type SourceRow } from '../services/gl/sync/desired';
import { compareCompositeKey, maxCompositeKey, type CompositeKey, type DesiredEvent, type SyncCursorState } from '../services/gl/sync/types';
import { activeSyncSources, lockSyncBlockers, type LockSyncInput } from '../services/gl/locks';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const AT = new Date('2026-11-14T09:00:00.000Z');

// ═══ قاعدة مزيّفة تلتقط الاستعلامات ═══

interface Call { model: string; op: string; args: Any }

function fakeDb(data: Record<string, Any[]>) {
  const calls: Call[] = [];
  const inList = (where: Any, field: string, row: Any) => !where?.[field]?.in || where[field].in.includes(row[field]);
  const model = (name: string) => ({
    findMany: async (args: Any) => {
      calls.push({ model: name, op: 'findMany', args });
      const w = args?.where ?? {};
      return (data[name] ?? []).filter((r) => (!w.tenantId || !r.tenantId || r.tenantId === w.tenantId)
        && inList(w, 'id', r) && inList(w, 'receiptId', r) && inList(w, 'linkId', r)
        && (!w.kind || r.kind === w.kind));
    },
    findFirst: async (args: Any) => { calls.push({ model: name, op: 'findFirst', args }); return (data[name] ?? [])[0] ?? null; },
    findUnique: async (args: Any) => { calls.push({ model: name, op: 'findUnique', args }); return (data[name] ?? [])[0] ?? null; },
  });
  const db: Any = new Proxy({}, { get: (_t, p: string) => (p === 'then' ? undefined : model(p)) });
  return { db, calls, count: (m: string) => calls.filter((c) => c.model === m).length };
}

// select المُطابِق قبل «ربط الدفاتر» حرفاً (من reconcilerStore.prisma.ts قبل التعديل)
const OLD_INVOICE_SELECT = {
  id: true, number: true, type: true, customerId: true, salesRepId: true, pricesIncludeTax: true,
  subtotal: true, discountAmt: true, taxAmt: true, total: true, dueDate: true,
  taxFree: true,
  customer: { select: { name: true } }, salesRep: { select: { name: true } },
  items: {
    select: { productId: true, qty: true, unitPrice: true, taxPct: true, taxAmt: true, lineTotal: true, vatCategory: true, product: { select: { categoryId: true } } },
    orderBy: { id: 'asc' },
  },
};
const OLD_RECEIPT_SELECT = {
  id: true, number: true, customerId: true, salesRepId: true, paymentMethod: true, amount: true,
  customer: { select: { name: true } }, salesRep: { select: { name: true } },
};

function invoiceRow(id: string, o: Any = {}): Any {
  return {
    id, tenantId: 't1', number: `INV-${id}`, type: 'CREDIT', customerId: 'c1', salesRepId: 'r1', pricesIncludeTax: false,
    subtotal: 1000, discountAmt: 0, taxAmt: 150, total: 1150, dueDate: null, taxFree: false,
    invoiceDate: AT, cashCollectedByRep: false, remainingApplied: null, documentKind: null, originalInvoiceId: null,
    customer: { name: 'عميل', paymentDays: 30 }, salesRep: { name: 'مندوب' },
    items: [{
      productId: 'p1', qty: 10, unitPrice: 100, taxPct: 15, taxAmt: 150, lineTotal: 1150, vatCategory: 'S',
      baseQty: 240, unitFactor: 24, itemName: null, returnOfItemId: null, product: { categoryId: 'cat1', name: 'كرتون ماء' },
    }],
    installments: [{ seq: 1, dueDate: new Date('2026-12-13T21:00:00Z'), amount: 575 }, { seq: 2, dueDate: new Date('2027-01-12T21:00:00Z'), amount: 575 }],
    ...o,
  };
}

function receiptRow(id: string, o: Any = {}): Any {
  return {
    id, tenantId: 't1', number: `RC-${id}`, customerId: 'c1', salesRepId: 'r1', paymentMethod: 'CASH', amount: 600,
    customer: { name: 'عميل' }, salesRep: { name: 'مندوب' },
    paymentMethodKey: null, cancelRefundFrom: null, cancelRefundUserId: null, invoiceItems: [],
    ...o,
  };
}

// ═══ facts.prisma.ts ═══

test('غير المربوطة: select الفاتورة والسند حرفاً كما كان، ولا استعلام بنود ولا بطاقة ولا مستخدم', async () => {
  const f = fakeDb({ invoice: [invoiceRow('i1', { type: 'RETURN', items: [{ ...invoiceRow('x').items[0], returnOfItemId: 'si1' }] })], receipt: [receiptRow('r1')] });
  const invs = await loadInvoiceFacts(f.db, 't1', ['i1', 'i1'], { linked: false });
  assert.deepEqual(f.calls[0].args.select, OLD_INVOICE_SELECT);
  assert.deepEqual(f.calls[0].args.where, { tenantId: 't1', id: { in: ['i1'] } });
  const facts = invs.get('i1')!;
  for (const k of ['installments', 'cashCollectedByRep', 'customerPaymentDays', 'saleInvoiceId', 'invoiceDate']) assert.ok(!(k in facts), k);
  assert.ok(!('baseQty' in facts.items[0]));
  await loadReceiptFacts(f.db, 't1', ['r1'], { linked: false });
  const rc = f.calls.find((c) => c.model === 'receipt')!;
  assert.deepEqual(rc.args.select, OLD_RECEIPT_SELECT);
  assert.deepEqual(f.calls.map((c) => c.model), ['invoice', 'receipt', 'customerPaymentLink']); // لا رابط ⇒ لا استعلام استرداد
});

test('المربوطة: الفاتورة بحقائقها كلها — الأقساط والختم والاستحقاق والاسم وفاتورة البيع للمرتجع (استعلام واحد مقيّد بالشركة)', async () => {
  const f = fakeDb({
    invoice: [
      invoiceRow('i1', { cashCollectedByRep: true, type: 'CASH', installments: [] }),
      invoiceRow('ret1', { type: 'RETURN', remainingApplied: 115, items: [
        { ...invoiceRow('x').items[0], returnOfItemId: null, itemName: 'مرتجع حر' },
        { ...invoiceRow('x').items[0], returnOfItemId: 'saleItem1', itemName: null, product: null },
      ], installments: [] }),
      invoiceRow('ret2', { type: 'RETURN', remainingApplied: 50, items: [{ ...invoiceRow('x').items[0], returnOfItemId: 'saleItem2' }], installments: [] }),
      invoiceRow('cn1', { type: 'RETURN', documentKind: 'CREDIT_NOTE', originalInvoiceId: 'i9', installments: [] }),
    ],
    invoiceItem: [{ id: 'saleItem1', invoiceId: 'sale1' }, { id: 'saleItem2', invoiceId: 'sale2' }],
  });
  const m = await loadInvoiceFacts(f.db, 't1', ['i1', 'ret1', 'ret2', 'cn1']);
  assert.equal(f.count('invoice'), 1);
  assert.equal(f.count('invoiceItem'), 1, 'فاتورة البيع لكل المرتجعات باستعلام واحد');
  const ii = f.calls.find((c) => c.model === 'invoiceItem')!.args;
  assert.deepEqual(ii.where, { id: { in: ['saleItem1', 'saleItem2'] }, invoice: { tenantId: 't1' } });
  const sel = f.calls[0].args.select;
  for (const k of ['invoiceDate', 'cashCollectedByRep', 'remainingApplied', 'documentKind', 'originalInvoiceId', 'installments']) assert.ok(sel[k], k);
  assert.deepEqual(sel.customer, { select: { name: true, paymentDays: true } });
  assert.equal(sel.items.select.baseQty, true);
  assert.equal(sel.items.select.returnOfItemId, true);
  assert.deepEqual(sel.installments.orderBy, { seq: 'asc' });
  const i1 = m.get('i1')!;
  assert.equal(i1.cashCollectedByRep, true);
  assert.equal(i1.customerPaymentDays, 30);
  assert.equal(i1.items[0].baseQty, 240);
  assert.equal(i1.items[0].unitFactor, 24);
  assert.equal(i1.items[0].productName, 'كرتون ماء'); // product.name حين لا itemName
  assert.equal(i1.saleInvoiceId, null);
  const ret1 = m.get('ret1')!;
  assert.equal(ret1.saleInvoiceId, 'sale1'); // أول بند مرتبط
  assert.equal(ret1.items[0].productName, 'مرتجع حر'); // itemName أولاً
  assert.equal(ret1.items[1].productName, null);
  assert.equal(m.get('ret2')!.saleInvoiceId, 'sale2');
  assert.equal(m.get('cn1')!.documentKind, 'CREDIT_NOTE');
  assert.equal(m.get('cn1')!.originalInvoiceId, 'i9');
  // بلا مرتجع مرتبط ⇒ لا استعلام بنود
  const g = fakeDb({ invoice: [invoiceRow('k1')] });
  const k = await loadInvoiceFacts(g.db, 't1', ['k1']);
  assert.equal(g.count('invoiceItem'), 0);
  assert.deepEqual(k.get('k1')!.installments!.map((x) => x.amount), [575, 575]);
});

test('المربوطة: السند بالطريقة المخصّصة والبطاقة والتخصيصات ومصدر الاسترداد واسم مستخدمه — استعلامات ثابتة العدد مهما كثرت السندات', async () => {
  const many = Array.from({ length: 40 }, (_, i) => receiptRow(`r${i}`, {
    paymentMethodKey: i === 0 ? 'c_stcpay' : null,
    invoiceItems: i === 0 ? [{ id: 'ri1', invoiceId: 'i1', amount: 575 }] : [],
    cancelRefundFrom: i % 2 ? 'USER_CUSTODY' : null, cancelRefundUserId: i % 2 ? `u${i % 4}` : null,
  }));
  const f = fakeDb({
    receipt: many,
    customerPaymentLink: [{ id: 'L1', receiptId: 'r2' }],
    settlementEntry: [{ id: 'se1', linkId: 'L1', amount: -600, kind: 'REFUND' }],
    cardPayment: [{ id: 'cp1', receiptId: 'r3' }],
    admin: [{ id: 'u1', name: 'سارة' }, { id: 'u3', name: 'ليلى' }],
  });
  const m = await loadReceiptFacts(f.db, 't1', many.map((r) => r.id));
  assert.deepEqual(f.calls.map((c) => c.model), ['receipt', 'customerPaymentLink', 'settlementEntry', 'cardPayment', 'admin']);
  assert.deepEqual(f.calls.find((c) => c.model === 'admin')!.args.where, { tenantId: 't1', id: { in: ['u1', 'u3'] } });
  assert.deepEqual(f.calls.find((c) => c.model === 'cardPayment')!.args.where.tenantId, 't1');
  const r0 = m.get('r0')!;
  assert.equal(r0.paymentMethodKey, 'c_stcpay');
  assert.deepEqual(r0.allocations, [{ id: 'ri1', invoiceId: 'i1', amount: 575 }]);
  assert.equal(r0.cardPaymentId, null);
  assert.equal(m.get('r3')!.cardPaymentId, 'cp1');
  assert.equal(m.get('r1')!.cancelRefundFrom, 'USER_CUSTODY');
  assert.equal(m.get('r1')!.cancelRefundUserName, 'سارة');
  assert.equal(m.get('r3')!.cancelRefundUserName, 'ليلى');
  assert.deepEqual(m.get('r2')!.refund, { entryId: 'se1', amount: -600 });
  assert.equal(m.get('r2')!.paylinkId, 'L1');
});

test('loadAdminNames وloadRefundLinks: مقيّدان بالشركة، وفارغان بلا استعلام', async () => {
  const f = fakeDb({ admin: [{ id: 'u1', name: 'سارة' }], customerPaymentLink: [{ id: 'L1', receiptId: 'r1', customerId: 'c1', customer: { name: 'عميل' } }, { id: 'L2', receiptId: null, customerId: 'c2', customer: null }] });
  assert.deepEqual([...(await loadAdminNames(f.db, 't1', []))], []);
  assert.deepEqual([...(await loadRefundLinks(f.db, 't1', []))], []);
  assert.equal(f.calls.length, 0);
  assert.deepEqual([...(await loadAdminNames(f.db, 't1', ['u1', 'u1']))], [['u1', 'سارة']]);
  const links = await loadRefundLinks(f.db, 't1', ['L1', 'L2']);
  assert.deepEqual(links.get('L1'), { receiptId: 'r1', customerId: 'c1', customerName: 'عميل' });
  assert.deepEqual(links.get('L2'), { receiptId: null, customerId: 'c2', customerName: null });
  for (const c of f.calls) assert.equal(c.args.where.tenantId, 't1');
});

// ═══ reconcilerStore.prisma.ts ═══

test('loadSettings: linked للمربوطة المفعّلة وحدها (CLEAN والقديمة وغير المفعّلة false)', async () => {
  for (const [setupMethod, activatedAt, want] of [
    ['LINKED', AT, true], ['LINKED', null, false], ['CLEAN', AT, false], ['OPENING', AT, false], ['FULL_HISTORY', AT, false],
  ] as const) {
    const f = fakeDb({ glSettings: [{ activatedAt, timezone: 'Asia/Riyadh', currency: 'SAR', currencyDecimals: 2, setupMethod }], companySettings: [{ currency: 'SAR' }] });
    const s = await createPrismaReconcilerStore(f.db).loadSettings('t1');
    assert.equal(s!.linked, want, `${setupMethod} ${String(activatedAt)}`);
    assert.equal(f.calls[0].args.select.setupMethod, true);
  }
});

test('readPage وhasUnreadRows: user_settlements بالمؤشر المركّب، والاستلام يقرأ receivedByUserId', async () => {
  const f = fakeDb({ userSettlement: [{ id: 'us1' }], repSettlement: [{ id: 's1', salesRepId: 'r1' }] });
  const store = createPrismaReconcilerStore(f.db);
  const q: PageQuery = { after: { at: AT, id: 'a' }, upTo: new Date(AT.getTime() + 1000), limit: 500 };
  await store.readPage('t1', 'USER_SETTLEMENT', q);
  const us = f.calls.find((c) => c.model === 'userSettlement')!.args;
  assert.deepEqual(us.orderBy, [{ createdAt: 'asc' }, { id: 'asc' }]);
  assert.equal(us.take, 500);
  assert.deepEqual(us.where, { tenantId: 't1', createdAt: { lte: q.upTo }, OR: [{ createdAt: { gt: AT } }, { createdAt: AT, id: { gt: 'a' } }] });
  assert.deepEqual(Object.keys(us.select).sort(), ['amount', 'createdAt', 'fromUserId', 'id', 'method', 'note', 'receivedBy', 'receivedByUserId', 'settledAt'].sort());
  await store.readPage('t1', 'REP_SETTLEMENT', q);
  assert.equal(f.calls.find((c) => c.model === 'repSettlement')!.args.select.receivedByUserId, true);
  assert.equal(await store.hasUnreadRows('t1', 'USER_SETTLEMENT', { at: AT, id: '' }, AT), true);
  assert.equal(f.calls[f.calls.length - 1].model, 'userSettlement');
  assert.equal(f.calls[f.calls.length - 1].op, 'findFirst');
});

test('loadFacts: الأسماء والروابط ووسم linked للمربوطة وحدها — وغيرها بالاستعلامات نفسها', async () => {
  const base: ReconcileSettings = { tenantId: 't1', activatedAt: AT, timezone: 'Asia/Riyadh', currency: 'SAR', currencyDecimals: 2 };
  const reps = [{ id: 's1', salesRepId: 'r1', amount: 800, method: 'CASH', note: null, settledAt: AT, createdAt: AT, receivedByUserId: 'u1' }];
  const refunds = [{ id: 'se1', kind: 'REFUND', amount: -10, feeNet: null, feeVat: null, linkId: 'L1', payoutId: null, note: null, createdAt: AT }];
  const data = { salesRep: [{ id: 'r1', name: 'أحمد' }], admin: [{ id: 'u1', name: 'سارة' }], customerPaymentLink: [{ id: 'L1', receiptId: 'rc1', customerId: 'c1', customer: { name: 'عميل' } }] };

  const off = fakeDb(data);
  const ctxOff = await createPrismaReconcilerStore(off.db).loadFacts('t1', 'REP_SETTLEMENT', reps as Any, base);
  await createPrismaReconcilerStore(off.db).loadFacts('t1', 'SETTLEMENT_ENTRY', refunds as Any, base);
  assert.deepEqual(off.calls.map((c) => c.model), ['salesRep']);
  assert.ok(!('linked' in ctxOff) && !('userNames' in ctxOff));

  const on = fakeDb(data);
  const settings = { ...base, linked: true };
  const ctxRep = await createPrismaReconcilerStore(on.db).loadFacts('t1', 'REP_SETTLEMENT', reps as Any, settings);
  assert.equal(ctxRep.linked, true);
  assert.equal(ctxRep.userNames!.get('u1'), 'سارة');
  const evRep = deriveSourceEvents('REP_SETTLEMENT', reps as Any, ctxRep)[0].payload as Any;
  assert.deepEqual([evRep.receivedByUserId, evRep.receivedByName], ['u1', 'سارة']);
  const ctxSe = await createPrismaReconcilerStore(on.db).loadFacts('t1', 'SETTLEMENT_ENTRY', refunds as Any, settings);
  const evSe = deriveSourceEvents('SETTLEMENT_ENTRY', refunds as Any, ctxSe);
  assert.deepEqual(evSe.map((e) => [e.sourceKey, (e.payload as Any).receiptId, e.status]), [['PAYLINK_REFUND:se1', 'rc1', undefined]]);
  const users = [{ id: 'us1', fromUserId: 'u1', amount: 5, method: 'CASH', note: null, receivedBy: null, receivedByUserId: null, settledAt: AT, createdAt: AT }];
  const ctxUs = await createPrismaReconcilerStore(on.db).loadFacts('t1', 'USER_SETTLEMENT', users as Any, settings);
  assert.equal((deriveSourceEvents('USER_SETTLEMENT', users as Any, ctxUs)[0].payload as Any).fromUserName, 'سارة');
});

test('loadFacts للمربوطة ⇒ حمولة الفاتورة بأقساطها من القاعدة إلى الحدث (المُطابِق كاملاً)', async () => {
  const f = fakeDb({ invoice: [invoiceRow('i1')] });
  const row = { id: 'ae1', customerId: 'c1', invoiceId: 'i1', receiptId: null, type: 'INVOICE_DEBIT', debit: 1150, credit: 0, description: null, entryDate: AT, createdAt: AT };
  const ctx = await createPrismaReconcilerStore(f.db).loadFacts('t1', 'ACCOUNT_ENTRY', [row], { tenantId: 't1', activatedAt: AT, timezone: 'Asia/Riyadh', currency: 'SAR', currencyDecimals: 2, linked: true });
  const p = deriveSourceEvents('ACCOUNT_ENTRY', [row], ctx)[0].payload as Any;
  assert.deepEqual(p.installments, [{ seq: 1, dueDate: '2026-12-14', amount: '575.00' }, { seq: 2, dueDate: '2027-01-13', amount: '575.00' }]);
  assert.equal(p.items[0].baseQty, 240);
  assert.equal(p.items[0].productName, 'كرتون ماء');
});

// ═══ reconciler.ts ═══

class MemStore implements ReconcilerStore {
  cursors = new Map<ReconciledSource, SyncCursorState>();
  rows: Partial<Record<ReconciledSource, SourceRow[]>> = {};
  events = new Map<string, DesiredEvent>();
  calls: string[] = [];
  constructor(public settings: ReconcileSettings) {}
  async dbNow() { return new Date(AT.getTime() + 3_600_000); }
  async loadSettings() { this.calls.push('loadSettings'); return this.settings; }
  async readCursor(_t: string, source: ReconciledSource) { this.calls.push(`readCursor:${source}`); const c = this.cursors.get(source); return c ? { ...c } : null; }
  async readPage(_t: string, source: ReconciledSource, q: PageQuery) {
    this.calls.push(`readPage:${source}`);
    return (this.rows[source] ?? [])
      .filter((r) => r.createdAt.getTime() <= q.upTo.getTime() && compareCompositeKey({ at: r.createdAt, id: r.id }, q.after) > 0)
      .slice(0, q.limit);
  }
  async loadFacts(_t: string, _s: ReconciledSource, _rows: readonly SourceRow[], s: ReconcileSettings): Promise<DeriveContext> {
    return { timezone: s.timezone, currency: s.currency, currencyDecimals: s.currencyDecimals, ...(s.linked ? { linked: true, userNames: new Map([['u1', 'سارة']]) } : {}) };
  }
  async commitPage(_t: string, source: ReconciledSource, events: readonly DesiredEvent[], advanceTo: CompositeKey): Promise<CommitPageResult> {
    let inserted = 0;
    for (const e of events) if (!this.events.has(e.sourceKey)) { this.events.set(e.sourceKey, e); inserted++; }
    const c = this.cursors.get(source)!;
    const w = maxCompositeKey({ at: c.watermarkAt, id: c.watermarkId }, advanceTo);
    c.watermarkAt = w.at; c.watermarkId = w.id;
    return { inserted, watermark: w };
  }
  async insertEvents(_t: string, events: readonly DesiredEvent[]) { let n = 0; for (const e of events) if (!this.events.has(e.sourceKey)) { this.events.set(e.sourceKey, e); n++; } return n; }
  async recordStall() { return 1; }
  async hasUnreadRows() { return false; }
}

function memStore(linked: boolean | undefined, withUserCursor: boolean): MemStore {
  const s = new MemStore({ tenantId: 't1', activatedAt: AT, timezone: 'Asia/Riyadh', currency: 'SAR', currencyDecimals: 2, ...(linked === undefined ? {} : { linked }) });
  const sources: ReconciledSource[] = ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY', ...(withUserCursor ? ['USER_SETTLEMENT' as const] : [])];
  for (const src of sources) s.cursors.set(src, { source: src, watermarkAt: new Date(0), watermarkId: '', lastRunAt: null, lastCount: 0, stallTicks: 0 });
  s.rows.USER_SETTLEMENT = [{ id: 'us1', fromUserId: 'u1', amount: 800, method: 'CASH', note: null, receivedBy: null, receivedByUserId: null, settledAt: AT, createdAt: AT }];
  return s;
}

test('reconcileTenant: غير المربوطة لا تقرأ مؤشر USER_SETTLEMENT ولو وُجد خطأً؛ والمربوطة تلتقط توريداتها وتحرّك مؤشرها', async () => {
  for (const linked of [undefined, false]) {
    const s = memStore(linked, true);
    const out = await reconcileTenant(s, 't1');
    assert.deepEqual(out.map((r) => r.source), ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY']);
    assert.ok(!s.calls.some((c) => c.endsWith(':USER_SETTLEMENT')), s.calls.join(','));
    assert.equal(s.events.size, 0);
  }
  const s = memStore(true, true);
  const out = await reconcileTenant(s, 't1');
  assert.deepEqual(out.map((r) => r.source), ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY', 'USER_SETTLEMENT']);
  const ev = s.events.get('USER_SETTLEMENT:us1:POST')!;
  assert.equal(ev.effectAt.getTime(), AT.getTime());
  assert.equal((ev.payload as Any).fromUserName, 'سارة');
  assert.deepEqual(s.cursors.get('USER_SETTLEMENT')!.watermarkId, 'us1');
  // مربوطة بلا مؤشر USER_SETTLEMENT بعد (قبل اعتماد L7) ⇒ لا شيء ولا خطأ
  const noCursor = memStore(true, false);
  assert.deepEqual((await reconcileTenant(noCursor, 't1')).map((r) => r.source), ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY']);
});

test('safetyNetScan(USER_SETTLEMENT) بلا إعدادات: غير المربوطة بلا مؤشر ⇒ استعلام مؤشر واحد ولا إعدادات؛ ومؤشر خاطئ لغير المربوطة ⇒ لا قراءة صفوف', async () => {
  const none = memStore(false, false);
  assert.equal(await safetyNetScan(none, 't1', 'USER_SETTLEMENT'), null);
  assert.deepEqual(none.calls, ['readCursor:USER_SETTLEMENT']);
  const stray = memStore(false, true);
  assert.equal(await safetyNetScan(stray, 't1', 'USER_SETTLEMENT'), null);
  assert.ok(!stray.calls.includes('readPage:USER_SETTLEMENT'));
  const linked = memStore(true, true);
  linked.cursors.get('USER_SETTLEMENT')!.watermarkAt = new Date(AT.getTime() + 60_000);
  const r = await safetyNetScan(linked, 't1', 'USER_SETTLEMENT', { lookbackMs: 86_400_000 });
  assert.equal(r!.rowsRead, 1);
  assert.ok(linked.events.has('USER_SETTLEMENT:us1:POST'));
  // المصادر القديمة بلا تغيير في التسلسل: الإعدادات أولاً
  const old = memStore(false, false);
  await safetyNetScan(old, 't1', 'ACCOUNT_ENTRY');
  assert.deepEqual(old.calls.slice(0, 2), ['loadSettings', 'readCursor:ACCOUNT_ENTRY']);
});

// ═══ locks.ts ═══

test('activeSyncSources: الافتراضي حرفاً كما كان، وlinked يُلحق USER_SETTLEMENT آخر القائمة', () => {
  assert.deepEqual(activeSyncSources('PERIODIC'), ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY']);
  assert.deepEqual(activeSyncSources('PERPETUAL'), ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY', 'WAREHOUSE_ENTRY', 'VAN_LOAD', 'RETURN_RESTOCK']);
  assert.deepEqual(activeSyncSources('PERIODIC', { linked: false }), ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY']);
  assert.deepEqual(activeSyncSources('PERIODIC', { linked: true }), ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY', 'USER_SETTLEMENT']);
  assert.deepEqual(activeSyncSources('PERPETUAL', { linked: true }).slice(-3), ['RETURN_RESTOCK', 'USER_SETTLEMENT', 'SUPPLIER_ENTRY']);
});

test('lockSyncBlockers: مؤشر USER_SETTLEMENT يُطلب للمربوطة وحدها', () => {
  const now = new Date('2026-11-14T09:00:00Z');
  const cursor = (source: string) => ({ source, watermarkAt: now, lastRunAt: now, hasUnreadRows: false });
  const input = (linked: boolean | undefined, sources: string[]): LockSyncInput => ({
    settings: { timezone: 'Asia/Riyadh', inventoryMode: 'PERIODIC', activatedAt: now, backfillState: 'DONE', ...(linked === undefined ? {} : { linked }) },
    cursors: sources.map(cursor), eventSummary: { events: [] }, newDate: '2026-10-31', now,
  });
  const three = ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY'];
  assert.equal(lockSyncBlockers(input(undefined, three)), null);
  assert.equal(lockSyncBlockers(input(false, three)), null);
  const b = lockSyncBlockers(input(true, three));
  assert.deepEqual(b?.laggingSources.map((l) => l.source), ['USER_SETTLEMENT']);
  assert.equal(lockSyncBlockers(input(true, [...three, 'USER_SETTLEMENT'])), null);
});
