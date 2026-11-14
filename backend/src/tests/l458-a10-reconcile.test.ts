// «ربط الدفاتر» L8 (A10) — المطابقة الجزئية: المخطِّط الصرف (الأقدم استحقاقاً، حدود المتبقّي، الشريك والحساب)،
// وقواعد reconcileAfterPost بأمثلة العقد المحلولة E8.1 وE8.3 وE4.2 وE4.11 وE4.13 وE4.14، وتساوي الأثر بالمرجع.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMatches, planReversalMatches, compareOpenLines, mergeInserts, consumePlan } from '../services/gl/reconcile/planner';
import { reconcileAfterPost, reconcileSupplierAllocation } from '../services/gl/reconcile/apply';
import { sourceRefKind, type OpenControlLine } from '../services/gl/reconcile/types';
import { MemReconcileStore, M } from './l458-a10-mem-reconcile-store';

const AR = 'acc-113001';
const AR2 = 'acc-113002';
const AP = 'acc-211001';
const REV = 'acc-411001';
const CASH = 'acc-111003';
const C = 'cust-C';

const ol = (o: Partial<OpenControlLine> & Pick<OpenControlLine, 'lineId' | 'side' | 'amountMilli'>): OpenControlLine => ({
  moveId: `m-${o.lineId}`, accountId: AR, kind: 'AR', partnerId: C, residualMilli: o.amountMilli, date: '2026-11-14', dueDate: null, seq: 0, ...o,
});

// ═══ المخطِّط ═══

test('planMatches: الأقدم استحقاقاً أولاً وبحدّ المبلغ (E8.1: 575 ثم 25)', () => {
  const d2 = ol({ lineId: 'i2', side: 'DEBIT', amountMilli: M(575), dueDate: '2027-01-13', seq: 1 });
  const d1 = ol({ lineId: 'i1', side: 'DEBIT', amountMilli: M(575), dueDate: '2026-12-14', seq: 0 });
  const c = ol({ lineId: 'r', side: 'CREDIT', amountMilli: M(600) });
  const plan = planMatches([d2, d1], [c], M(600), 'RI:x');
  assert.deepEqual(plan.map((p) => [p.debitLineId, p.creditLineId, p.amountMilli, p.sourceRef]), [
    ['i1', 'r', M(575), 'RI:x'], ['i2', 'r', M(25), 'RI:x'],
  ]);
});

test('planMatches: لا يتجاوز متبقّي أيّ طرف ولا المبلغ، وnull = بحدّ المفتوح', () => {
  const d = ol({ lineId: 'd', side: 'DEBIT', amountMilli: M(100), residualMilli: M(40) });
  const c = ol({ lineId: 'c', side: 'CREDIT', amountMilli: M(100), residualMilli: M(70) });
  assert.equal(planMatches([d], [c], null, 'X')[0].amountMilli, M(40));
  assert.equal(planMatches([d], [c], M(15), 'X')[0].amountMilli, M(15));
  assert.deepEqual(planMatches([d], [c], 0n, 'X'), []);
  assert.deepEqual(planMatches([d], [c], -5n, 'X'), []);
  // متبقٍّ صفري لا يُطابَق
  assert.deepEqual(planMatches([{ ...d, residualMilli: 0n }], [c], null, 'X'), []);
});

test('planMatches: لا مطابقة بين شريكين أو حسابين مختلفين، ولا لجانبٍ خاطئ', () => {
  const d = ol({ lineId: 'd', side: 'DEBIT', amountMilli: M(100) });
  assert.deepEqual(planMatches([d], [ol({ lineId: 'c', side: 'CREDIT', amountMilli: M(100), partnerId: 'other' })], null, 'X'), []);
  assert.deepEqual(planMatches([d], [ol({ lineId: 'c', side: 'CREDIT', amountMilli: M(100), accountId: AR2 })], null, 'X'), []);
  assert.deepEqual(planMatches([d], [ol({ lineId: 'c', side: 'DEBIT', amountMilli: M(100) })], null, 'X'), []);
});

test('planMatches: الترتيب حتمي (dueDate ثم date ثم seq) ولا يتأثّر بترتيب المدخل', () => {
  const lines = [
    ol({ lineId: 'a', side: 'DEBIT', amountMilli: M(10), date: '2026-01-05', dueDate: null }),
    ol({ lineId: 'b', side: 'DEBIT', amountMilli: M(10), date: '2026-01-01', dueDate: '2026-01-10' }),
    ol({ lineId: 'c', side: 'DEBIT', amountMilli: M(10), date: '2026-01-04', dueDate: null, seq: 2 }),
    ol({ lineId: 'd', side: 'DEBIT', amountMilli: M(10), date: '2026-01-04', dueDate: null, seq: 1 }),
  ];
  assert.deepEqual([...lines].sort(compareOpenLines).map((l) => l.lineId), ['d', 'c', 'a', 'b']);
  const credit = ol({ lineId: 'x', side: 'CREDIT', amountMilli: M(25) });
  const fwd = planMatches(lines, [credit], null, 'R');
  const back = planMatches([...lines].reverse(), [credit], null, 'R');
  assert.deepEqual(fwd, back);
  assert.deepEqual(fwd.map((p) => [p.debitLineId, p.amountMilli]), [['d', M(10)], ['c', M(10)], ['a', M(5)]]);
});

test('planReversalMatches: المرآة سطراً بسطر، وkeepCashLeg يُبقي دائن ساق النقد مفتوحاً', () => {
  const o1 = ol({ lineId: 'o1', moveId: 'O', side: 'DEBIT', amountMilli: M(115), seq: 0 });
  const o2 = ol({ lineId: 'o2', moveId: 'O', side: 'CREDIT', amountMilli: M(115), seq: 4 });
  const r1 = ol({ lineId: 'r1', moveId: 'R', side: 'CREDIT', amountMilli: M(115), seq: 0 });
  const r2 = ol({ lineId: 'r2', moveId: 'R', side: 'DEBIT', amountMilli: M(115), seq: 4 });
  assert.deepEqual(planReversalMatches([o1, o2], [r1, r2], 'REV:R').map((p) => [p.debitLineId, p.creditLineId, p.amountMilli]),
    [['o1', 'r1', M(115)], ['r2', 'o2', M(115)]]);
  // keepCashLeg: العكس دائنٌ وحده
  assert.deepEqual(planReversalMatches([o1, o2], [r1], 'REV:R').map((p) => [p.debitLineId, p.creditLineId]), [['o1', 'r1']]);
  // الأقساط: كل قسط مع مرآته باستحقاقه حتى بمبلغين متساويين
  const i1 = ol({ lineId: 'i1', moveId: 'O', side: 'DEBIT', amountMilli: M(575.01), dueDate: '2026-12-14', seq: 0 });
  const i2 = ol({ lineId: 'i2', moveId: 'O', side: 'DEBIT', amountMilli: M(574.99), dueDate: '2027-01-13', seq: 1 });
  const j1 = ol({ lineId: 'j1', moveId: 'R', side: 'CREDIT', amountMilli: M(575.01), dueDate: '2026-12-14', seq: 0 });
  const j2 = ol({ lineId: 'j2', moveId: 'R', side: 'CREDIT', amountMilli: M(574.99), dueDate: '2027-01-13', seq: 1 });
  assert.deepEqual(planReversalMatches([i1, i2], [j2, j1], 'REV:R').map((p) => [p.debitLineId, p.creditLineId, p.amountMilli]),
    [['i1', 'j1', M(575.01)], ['i2', 'j2', M(574.99)]]);
});

test('mergeInserts وconsumePlan وsourceRefKind', () => {
  const p = { debitLineId: 'd', creditLineId: 'c', debitMoveId: 'D', creditMoveId: 'C', sourceRef: 'RI:1' };
  assert.deepEqual(mergeInserts([{ ...p, amountMilli: 1n }, { ...p, amountMilli: 2n }]), [{ ...p, amountMilli: 3n }]);
  const after = consumePlan([ol({ lineId: 'd', side: 'DEBIT', amountMilli: 10n })], [{ ...p, amountMilli: 4n }]);
  assert.equal(after[0].residualMilli, 6n);
  assert.equal(sourceRefKind('RI:abc'), 'RI');
  assert.equal(sourceRefKind('REV:m'), 'REV');
  assert.equal(sourceRefKind(null), null);
  assert.equal(sourceRefKind('XYZ:1'), null);
});

// ═══ قواعد reconcileAfterPost على مخزن الذاكرة ═══

/** E4.1: INV-1001 آجلة بقسطين 575 (2026-12-14) و575 (2027-01-13) */
function e41(store: MemReconcileStore) {
  store.addMove({
    id: 'M-INV', number: 'INV/1001', date: '2026-11-14', lines: [
      { id: 'L1', accountId: AR, kind: 'AR', partnerId: C, debit: M(575), credit: 0n, dueDate: '2026-12-14' },
      { id: 'L2', accountId: AR, kind: 'AR', partnerId: C, debit: M(575), credit: 0n, dueDate: '2027-01-13' },
      { id: 'L3', accountId: REV, kind: null, partnerId: null, debit: 0n, credit: M(1000) },
      { id: 'L4', accountId: 'acc-212001', kind: null, partnerId: null, debit: 0n, credit: M(150) },
    ],
  });
  store.live.set('INVOICE:INV-1001:POST', 'M-INV');
}

function receiptMove(store: MemReconcileStore, id: string, amount: number, date = '2026-11-20') {
  store.addMove({
    id, date, lines: [
      { id: `${id}-d`, accountId: CASH, kind: null, partnerId: null, debit: M(amount), credit: 0n },
      { id: `${id}-c`, accountId: AR, kind: 'AR', partnerId: C, debit: 0n, credit: M(amount) },
    ],
  });
}

const receiptPayload = (allocations: { id: string; invoiceId: string; amount: string }[]) =>
  ({ receiptId: 'R-x', entryDate: '2026-11-20', amount: '600.00', salesRepId: null, paymentMethod: 'CASH', customerId: C, allocations }) as never;

test('E8.1: سند 600 مخصّص لـINV-1001 ⇒ (القسط 1) 575 و(القسط 2) 25 بالمرجع RI، والمفتوح 550 — وتساوي الأثر', async () => {
  const store = new MemReconcileStore();
  e41(store);
  receiptMove(store, 'M-R', 600);
  const input = { sourceType: 'RECEIPT' as const, sourceId: 'R-x', event: 'POST' as const, moveId: 'M-R',
    payload: receiptPayload([{ id: 'x', invoiceId: 'INV-1001', amount: '600.00' }]) };
  assert.deepEqual(await reconcileAfterPost(store, input), { created: 2, removed: 0 });
  assert.deepEqual(store.partials.map((p) => [p.debitLineId, p.amountMilli, p.sourceRef]), [['L1', M(575), 'RI:x'], ['L2', M(25), 'RI:x']]);
  assert.equal(store.residual('L1'), 0n);
  assert.equal(store.residual('L2'), M(550));
  assert.equal(store.residual('M-R-c'), 0n);
  // إعادة الاستدعاء لا تضاعف شيئاً
  assert.deepEqual(await reconcileAfterPost(store, input), { created: 0, removed: 0 });
  assert.equal(store.partials.length, 2);
});

test('E8.1 (تساوي الأثر بالمرجع): سند 1000 مخصّص 600 فقط ⇒ الباقي 400 رصيد دائن لا يُطابَق مرة ثانية (D7)', async () => {
  const store = new MemReconcileStore();
  e41(store);
  receiptMove(store, 'M-R', 1000);
  const input = { sourceType: 'RECEIPT' as const, sourceId: 'R-x', event: 'POST' as const, moveId: 'M-R',
    payload: receiptPayload([{ id: 'x', invoiceId: 'INV-1001', amount: '600.00' }]) };
  await reconcileAfterPost(store, input);
  await reconcileAfterPost(store, input);
  assert.equal(store.residual('M-R-c'), M(400));
  assert.equal(store.residual('L2'), M(550));
  // سند بلا تخصيص: لا FIFO
  receiptMove(store, 'M-R2', 50);
  assert.deepEqual(await reconcileAfterPost(store, { ...input, sourceId: 'R2', moveId: 'M-R2', payload: receiptPayload([]) }), { created: 0, removed: 0 });
});

test('E8.3: عكس السند ⇒ تُحذف مطابقتا RI ويُطابَق دائن السند مع مدين عكسه REV، فيعود المفتوح 1,150', async () => {
  const store = new MemReconcileStore();
  e41(store);
  receiptMove(store, 'M-R', 600);
  await reconcileAfterPost(store, { sourceType: 'RECEIPT', sourceId: 'R-x', event: 'POST', moveId: 'M-R',
    payload: receiptPayload([{ id: 'x', invoiceId: 'INV-1001', amount: '600.00' }]) });
  store.addMove({
    id: 'M-RV', date: '2026-11-25', reversedMoveId: 'M-R', lines: [
      { id: 'RV-d', accountId: AR, kind: 'AR', partnerId: C, debit: M(600), credit: 0n },
      { id: 'RV-c', accountId: CASH, kind: null, partnerId: null, debit: 0n, credit: M(600) },
    ],
  });
  const input = { sourceType: 'RECEIPT' as const, sourceId: 'R-x', event: 'REVERSE' as const, moveId: 'M-RV', reversedMoveId: 'M-R', payload: null };
  assert.deepEqual(await reconcileAfterPost(store, input), { created: 1, removed: 2 });
  assert.deepEqual(store.partials.map((p) => [p.debitLineId, p.creditLineId, p.amountMilli, p.sourceRef]), [['RV-d', 'M-R-c', M(600), 'REV:M-RV']]);
  assert.equal(store.residual('L1') + store.residual('L2'), M(1150));
  // إعادة الاستدعاء: لا تحذف مطابقة REV نفسها ولا تكرّرها
  assert.deepEqual(await reconcileAfterPost(store, input), { created: 0, removed: 0 });
  // عكس بلا أصل حيّ (أصل في الافتتاح) ⇒ لا شيء
  assert.deepEqual(await reconcileAfterPost(store, { ...input, reversedMoveId: null }), { created: 0, removed: 0 });
});

test('E4.2 ثم E4.11: النقدية المختومة CASH:<moveId>، وإبطالها مع الاحتفاظ بالنقد يُبقي دائن ساق النقد رصيداً للعميل', async () => {
  const store = new MemReconcileStore();
  store.addMove({
    id: 'M-C', date: '2026-11-14', lines: [
      { id: 'C1', accountId: AR, kind: 'AR', partnerId: C, debit: M(115), credit: 0n },
      { id: 'C2', accountId: REV, kind: null, partnerId: null, debit: 0n, credit: M(100) },
      { id: 'C3', accountId: 'acc-212001', kind: null, partnerId: null, debit: 0n, credit: M(15) },
      { id: 'C4', accountId: CASH, kind: null, partnerId: null, debit: M(115), credit: 0n },
      { id: 'C5', accountId: AR, kind: 'AR', partnerId: C, debit: 0n, credit: M(115) },
    ],
  });
  store.live.set('INVOICE:INV-1002:POST', 'M-C');
  const post = await reconcileAfterPost(store, { sourceType: 'INVOICE', sourceId: 'INV-1002', event: 'POST', moveId: 'M-C',
    payload: { type: 'CASH', invoiceId: 'INV-1002' } as never });
  assert.deepEqual(post, { created: 1, removed: 0 });
  assert.equal(store.partials[0].sourceRef, 'CASH:M-C');
  assert.equal(store.residual('C1'), 0n);
  // الإبطال: العكس بلا ساق النقد (Dr 411001 100 / Dr 212001 15 / Cr 113001 115)
  store.addMove({
    id: 'M-CV', date: '2026-11-16', reversedMoveId: 'M-C', lines: [
      { id: 'V1', accountId: AR, kind: 'AR', partnerId: C, debit: 0n, credit: M(115) },
      { id: 'V2', accountId: REV, kind: null, partnerId: null, debit: M(100), credit: 0n },
      { id: 'V3', accountId: 'acc-212001', kind: null, partnerId: null, debit: M(15), credit: 0n },
    ],
  });
  const rev = await reconcileAfterPost(store, { sourceType: 'INVOICE', sourceId: 'INV-1002', event: 'REVERSE', moveId: 'M-CV', reversedMoveId: 'M-C', payload: null });
  assert.deepEqual(rev, { created: 1, removed: 1 });
  assert.equal(store.residual('C1'), 0n);
  assert.equal(store.residual('V1'), 0n);
  assert.equal(store.residual('C5'), M(115), 'دائن ساق النقد مفتوح = رصيد العميل الدائن');
});

test('فاتورة رُحّلت بعد سندها: pendingAllocationsForInvoice تلتقطه بالمرجع نفسه', async () => {
  const store = new MemReconcileStore();
  receiptMove(store, 'M-R', 600);
  // السند أولاً والفاتورة غير مرحّلة ⇒ لا مطابقة
  const r = await reconcileAfterPost(store, { sourceType: 'RECEIPT', sourceId: 'R-x', event: 'POST', moveId: 'M-R',
    payload: receiptPayload([{ id: 'x', invoiceId: 'INV-1001', amount: '600.00' }]) });
  assert.deepEqual(r, { created: 0, removed: 0 });
  e41(store);
  store.pending.push({ invoiceId: 'INV-1001', sourceRef: 'RI:x', creditMoveId: 'M-R', amountMilli: M(600) });
  const i = await reconcileAfterPost(store, { sourceType: 'INVOICE', sourceId: 'INV-1001', event: 'POST', moveId: 'M-INV',
    payload: { type: 'CREDIT', invoiceId: 'INV-1001' } as never });
  assert.deepEqual(i, { created: 2, removed: 0 });
  assert.equal(store.residual('L2'), M(550));
  // المرتجع لا يسأل عن تخصيصات
  const calls = store.calls.filter((c) => c.startsWith('pending:'));
  assert.deepEqual(calls, ['pending:INV-1001']);
});

test('E4.9 مرتجع مرتبط RET بحدّ remainingApplied، والإشعار الدائن CN بحدّ المفتوح (D8)', async () => {
  const store = new MemReconcileStore();
  e41(store);
  store.addMove({
    id: 'M-RET', date: '2026-11-15', lines: [
      { id: 'T1', accountId: 'acc-412001', kind: null, partnerId: null, debit: M(100), credit: 0n },
      { id: 'T2', accountId: 'acc-212001', kind: null, partnerId: null, debit: M(15), credit: 0n },
      { id: 'T3', accountId: AR, kind: 'AR', partnerId: C, debit: 0n, credit: M(115) },
    ],
  });
  // remainingApplied = 80 فقط، والباقي 35 رصيد دائن للعميل
  const r = await reconcileAfterPost(store, { sourceType: 'INVOICE', sourceId: 'RET-901', event: 'POST', moveId: 'M-RET',
    payload: { type: 'RETURN', invoiceId: 'RET-901', appliesTo: { invoiceId: 'INV-1001', amount: '80.00' } } as never });
  assert.deepEqual(r, { created: 1, removed: 0 });
  assert.deepEqual(store.partials.map((p) => [p.debitLineId, p.creditLineId, p.amountMilli, p.sourceRef]), [['L1', 'T3', M(80), 'RET:RET-901']]);
  assert.equal(store.residual('T3'), M(35));
  assert.ok(!store.calls.includes('pending:RET-901'), 'المرتجع لا يقرأ التخصيصات');

  // إشعار دائن 2,000 على فاتورة مفتوحها 1,070 ⇒ يُسقط 1,070 فقط (D8)
  store.addMove({
    id: 'M-CN', date: '2026-11-16', lines: [
      { id: 'N1', accountId: AR, kind: 'AR', partnerId: C, debit: 0n, credit: M(2000) },
      { id: 'N2', accountId: 'acc-412001', kind: null, partnerId: null, debit: M(2000), credit: 0n },
    ],
  });
  await reconcileAfterPost(store, { sourceType: 'INVOICE', sourceId: 'CN-1', event: 'POST', moveId: 'M-CN',
    payload: { type: 'RETURN', invoiceId: 'CN-1', appliesTo: { invoiceId: 'INV-1001', amount: null } } as never });
  assert.equal(store.residual('L1') + store.residual('L2'), 0n);
  assert.equal(store.residual('N1'), M(930));
  assert.ok(store.partials.filter((p) => p.sourceRef === 'CN:CN-1').reduce((a, p) => a + p.amountMilli, 0n) === M(1070));
});

test('E4.13 شطب CA:<alloc>، وE4.14 ردّ الرصيد الدائن FIFO، والمخزن بلا FIFO لا يرمي', async () => {
  const store = new MemReconcileStore();
  e41(store);
  store.addMove({
    id: 'M-WO', date: '2026-11-20', lines: [
      { id: 'W1', accountId: 'acc-711005', kind: null, partnerId: null, debit: M(300), credit: 0n },
      { id: 'W2', accountId: AR, kind: 'AR', partnerId: C, debit: 0n, credit: M(300) },
    ],
  });
  const wo = await reconcileAfterPost(store, { sourceType: 'CUSTOMER_ADJUSTMENT', sourceId: 'ADJ-1', event: 'POST', moveId: 'M-WO',
    payload: { origin: 'CUSTOMER_ADJUSTMENT', kind: 'BAD_DEBT_WRITEOFF', allocations: [{ id: 'al1', invoiceId: 'INV-1001', amount: '300.00' }] } });
  assert.deepEqual(wo, { created: 1, removed: 0 });
  assert.deepEqual(store.partials.map((p) => [p.debitLineId, p.amountMilli, p.sourceRef]), [['L1', M(300), 'CA:al1']]);

  // دائن 200 من مرتجع غير مطبّق، ثم ردّه نقداً: Dr 113001 [C] 200 / Cr 111001 200 ⇒ FIFO:<سطر المدين>
  store.addMove({ id: 'M-RT', date: '2026-11-21', lines: [
    { id: 'RT1', accountId: AR, kind: 'AR', partnerId: C, debit: 0n, credit: M(200) },
    { id: 'RT2', accountId: 'acc-412001', kind: null, partnerId: null, debit: M(200), credit: 0n },
  ] });
  store.addMove({ id: 'M-RF', date: '2026-11-22', lines: [
    { id: 'RF1', accountId: AR, kind: 'AR', partnerId: C, debit: M(200), credit: 0n },
    { id: 'RF2', accountId: 'acc-111001', kind: null, partnerId: null, debit: 0n, credit: M(200) },
  ] });
  const rf = await reconcileAfterPost(store, { sourceType: 'AR_ENTRY', sourceId: 'ADJ-2', event: 'POST', moveId: 'M-RF',
    payload: { origin: 'CUSTOMER_ADJUSTMENT', kind: 'CREDIT_REFUND' } as never });
  assert.deepEqual(rf, { created: 1, removed: 0 });
  assert.equal(store.residual('RT1'), 0n);
  assert.equal(store.residual('RF1'), 0n);
  assert.ok(store.partials.some((p) => p.sourceRef === 'FIFO:RF1'));

  // AR_ENTRY استيراد عادي: لا قاعدة
  assert.deepEqual(await reconcileAfterPost(store, { sourceType: 'AR_ENTRY', sourceId: 'E', event: 'POST', moveId: 'M-RF',
    payload: { origin: 'IMPORT', kind: 'CREDIT_REFUND' } as never }), { created: 0, removed: 0 });

  // E4.15 إلغاء الشطب: عكسه يحرّر INV-1001 ويطابق سطري الشطب وعكسه
  store.addMove({ id: 'M-WOV', date: '2026-11-25', reversedMoveId: 'M-WO', lines: [
    { id: 'WV1', accountId: 'acc-711005', kind: null, partnerId: null, debit: 0n, credit: M(300) },
    { id: 'WV2', accountId: AR, kind: 'AR', partnerId: C, debit: M(300), credit: 0n },
  ] });
  await reconcileAfterPost(store, { sourceType: 'CUSTOMER_ADJUSTMENT', sourceId: 'ADJ-1', event: 'REVERSE', moveId: 'M-WOV', reversedMoveId: 'M-WO', payload: null });
  assert.equal(store.residual('L1'), M(575), 'المتبقّي يعود 300');

  const noFifo = new MemReconcileStore();
  noFifo.openLinesOfPartner = undefined;
  noFifo.addMove({ id: 'X', date: '2026-11-22', lines: [{ id: 'X1', accountId: AR, kind: 'AR', partnerId: C, debit: M(1), credit: 0n }] });
  assert.deepEqual(await reconcileAfterPost(noFifo, { sourceType: 'CUSTOMER_ADJUSTMENT', sourceId: 'A', event: 'POST', moveId: 'X',
    payload: { kind: 'CREDIT_REFUND' } }), { created: 0, removed: 0 });
});

test('سند لعميل آخر أو لفاتورة غير مرحّلة: لا مطابقة؛ ومصادر بلا قاعدة (PAYLINK_REFUND/SETTLEMENT POST) لا تلمس شيئاً', async () => {
  const store = new MemReconcileStore();
  e41(store);
  store.addMove({ id: 'M-O', date: '2026-11-20', lines: [{ id: 'O1', accountId: AR, kind: 'AR', partnerId: 'cust-other', debit: 0n, credit: M(100) }] });
  await reconcileAfterPost(store, { sourceType: 'RECEIPT', sourceId: 'R-o', event: 'POST', moveId: 'M-O',
    payload: receiptPayload([{ id: 'o', invoiceId: 'INV-1001', amount: '100.00' }, { id: 'n', invoiceId: 'INV-NONE', amount: '5.00' }]) });
  assert.equal(store.partials.length, 0);
  assert.deepEqual(await reconcileAfterPost(store, { sourceType: 'PAYLINK_REFUND', sourceId: 'e', event: 'POST', moveId: 'M-O', payload: null }), { created: 0, removed: 0 });
  assert.deepEqual(await reconcileAfterPost(store, { sourceType: 'INVOICE', sourceId: 'i', event: 'COGS', moveId: 'M-O', payload: null }), { created: 0, removed: 0 });
});

test('ثلاث منازل وصفر منازل: المبالغ النصية تُقرأ حرفاً بالملّي', async () => {
  for (const [amt, want] of [['1.099', 1099n], ['3000', 3_000_000n]] as const) {
    const store = new MemReconcileStore();
    store.addMove({ id: 'I', date: '2026-11-14', lines: [{ id: 'I1', accountId: AR, kind: 'AR', partnerId: C, debit: want, credit: 0n }] });
    store.live.set('INVOICE:I:POST', 'I');
    store.addMove({ id: 'R', date: '2026-11-15', lines: [{ id: 'R1', accountId: AR, kind: 'AR', partnerId: C, debit: 0n, credit: want }] });
    await reconcileAfterPost(store, { sourceType: 'RECEIPT', sourceId: 'r', event: 'POST', moveId: 'R',
      payload: receiptPayload([{ id: 'a', invoiceId: 'I', amount: amt }]) });
    assert.equal(store.residual('I1'), 0n, amt);
  }
});

test('reconcileSupplierAllocation: SPA بالأقدم استحقاقاً ومتساوي الأثر', async () => {
  const store = new MemReconcileStore();
  store.addMove({ id: 'B', date: '2026-10-01', lines: [
    { id: 'B1', accountId: AP, kind: 'AP', partnerId: 'V', debit: 0n, credit: M(400), dueDate: '2026-11-30' },
    { id: 'B2', accountId: AP, kind: 'AP', partnerId: 'V', debit: 0n, credit: M(400), dueDate: '2026-10-31' },
  ] });
  store.addMove({ id: 'P', date: '2026-11-05', lines: [{ id: 'P1', accountId: AP, kind: 'AP', partnerId: 'V', debit: M(500), credit: 0n }] });
  const a = { allocationId: 'spa1', billMoveId: 'B', paymentMoveId: 'P', amountMilli: M(500) };
  assert.equal(await reconcileSupplierAllocation(store, a), 2);
  assert.equal(store.residual('B2'), 0n);
  assert.equal(store.residual('B1'), M(300));
  assert.equal(await reconcileSupplierAllocation(store, a), 0);
  assert.equal(await reconcileSupplierAllocation(store, { ...a, amountMilli: 0n }), 0);
});
