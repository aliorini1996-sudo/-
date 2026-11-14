// «ربط الدفاتر» L8 — إصلاح فجوات المطابقة الجزئية (مخزن Prisma فوق Prisma مزيّف في الذاكرة):
//  (١) مرتجع أو إشعار دائن رُحِّل قبل فاتورة بيعه يُلتقط عند ترحيل البيع (RET بباقيه ثم CN بالمفتوح)؛
//  (٢) سداد/مرتجع/شطب/إلغاء فاتورة مشمولة بالافتتاح (حدثها SKIPPED(OPENING)) يُطابَق بسطر افتتاح العميل، فتساوي الأعمار
//      remainingAmt ويخضرّ C16؛
//  (٣) liveMoveIdsOf بمفاتيح دقيقة على الفهرس الفريد بلا LIKE (startsWith)، والسلسلة REPOST:1..n صحيحة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrismaReconcileStore, liveMoveIdsOf } from '../services/gl/reconcile/store.prisma';
import { reconcileAfterPost } from '../services/gl/reconcile/apply';
import type { ReconcileEventInput } from '../services/gl/reconcile/types';
import { buildAging, DEFAULT_AGING_BUCKETS, type AgingItem } from '../services/gl/reports/aging';
import { evaluateC16 } from '../services/gl/checks/rules';
import type { GlDb } from '../services/gl/resolve';
import { FakeDb } from './l458-a10-fake-db';
import { M } from './l458-a10-mem-reconcile-store';

const T1 = 'tenant-1';
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));

function baseDb(): FakeDb {
  const db = new FakeDb();
  db.insert('glSettings', [{ tenantId: T1, currencyDecimals: 2 }]);
  db.insert('glAccount', [
    { id: 'ar', tenantId: T1, code: '113001', controlKind: 'AR' },
    { id: 'cash', tenantId: T1, code: '111001', controlKind: null },
    { id: 'rev', tenantId: T1, code: '411001', controlKind: null },
    { id: 'ret', tenantId: T1, code: '412001', controlKind: null },
    { id: 'bad', tenantId: T1, code: '711005', controlKind: null },
  ]);
  return db;
}

let clock = 0;
/** قيد مرحّل بسطوره ومفتاح مصدره */
function addMove(
  db: FakeDb, id: string, sourceKey: string | null, date: string,
  lines: { id: string; account: string; customerId?: string | null; debit?: number; credit?: number; dueDate?: string | null }[],
  extra: Record<string, unknown> = {},
): void {
  db.insert('glMove', [{ id, tenantId: T1, state: 'POSTED', createdAt: new Date(1_800_000_000_000 + (clock += 1000)), reversedMoveId: null, ...extra }]);
  if (sourceKey) db.insert('glMoveSource', [{ tenantId: T1, sourceKey, moveId: id }]);
  db.insert('glMoveLine', lines.map((l, i) => ({
    id: l.id, tenantId: T1, moveId: id, seq: i, accountId: l.account, customerId: l.customerId ?? null, vendorId: null,
    debitMilli: l.debit !== undefined ? M(l.debit) : 0n, creditMilli: l.credit !== undefined ? M(l.credit) : 0n,
    date: D(date), dueDate: l.dueDate ? D(l.dueDate) : null, posted: true,
  })));
}

const store = (db: FakeDb) => createPrismaReconcileStore(db.client() as unknown as GlDb, T1);

/** متبقّي سطر = مبلغه − Σ مطابقاته */
function residual(db: FakeDb, lineId: string): bigint {
  const l = db.table('glMoveLine').find((x) => x.id === lineId)!;
  const amt = (l.debitMilli as bigint) > 0n ? (l.debitMilli as bigint) : (l.creditMilli as bigint);
  return amt - db.table('glPartialReconcile')
    .filter((p) => p.debitLineId === lineId || p.creditLineId === lineId)
    .reduce((a, p) => a + (p.amountMilli as bigint), 0n);
}

/** بنود الأعمار وΣ مدين الذمة المفتوح لكل عميل (openArByCustomer بقاعدتها) من سطور الذمة بمتبقّيها */
function ledgerView(db: FakeDb): { items: AgingItem[]; openDebit: Map<string, bigint> } {
  const items: AgingItem[] = [];
  const openDebit = new Map<string, bigint>();
  for (const l of db.table('glMoveLine')) {
    if (l.accountId !== 'ar' || !l.customerId) continue;
    const r = residual(db, l.id as string);
    if (r === 0n) continue;
    const debit = (l.debitMilli as bigint) > 0n;
    const date = (l.date as Date).toISOString().slice(0, 10);
    items.push({ partnerId: l.customerId as string, lineId: l.id as string, date, dueDate: l.dueDate ? (l.dueDate as Date).toISOString().slice(0, 10) : null, residualMilli: debit ? r : -r });
    if (debit) openDebit.set(l.customerId as string, (openDebit.get(l.customerId as string) ?? 0n) + r);
  }
  return { items, openDebit };
}

const c16 = (ledgerOpen: Map<string, bigint>, opsRemaining: Map<string, bigint>) =>
  evaluateC16({ ledgerOpen, opsRemaining, names: new Map(), pendingCustomers: new Set(), pendingAll: false, invoices: [] });

// ═══ (١) المرتجع والإشعار الدائن قبل بيعهما ═══

/**
 * بيع آجل INV-1 بـ1,150 فشل ترحيله (عابر أو HELD) بينما رُحّل مرتجعه RET-1 (remainingApplied = 115) وإشعاره الدائن CN-1
 * بـ50 — المتبقّي التشغيلي 985.
 */
function returnsBeforeSale(): FakeDb {
  const db = baseDb();
  db.insert('invoice', [
    { id: 'INV-1', tenantId: T1, type: 'CREDIT', total: 1150, remainingAmt: 985, originalInvoiceId: null },
    { id: 'RET-1', tenantId: T1, type: 'RETURN', total: 115, remainingAmt: 0, originalInvoiceId: null },
    { id: 'CN-1', tenantId: T1, type: 'RETURN', total: 50, remainingAmt: 0, originalInvoiceId: 'INV-1' },
  ]);
  db.insert('invoiceItem', [
    { id: 'si1', invoiceId: 'INV-1', returnOfItemId: null },
    { id: 'si2', invoiceId: 'INV-1', returnOfItemId: null },
    { id: 'ri1', invoiceId: 'RET-1', returnOfItemId: 'si2' },
    { id: 'ci1', invoiceId: 'CN-1', returnOfItemId: null },
  ]);
  addMove(db, 'M-RET', 'INVOICE:RET-1:POST', '2026-03-02', [
    { id: 'T1', account: 'ret', debit: 115 }, { id: 'T3', account: 'ar', customerId: 'C', credit: 115 },
  ]);
  addMove(db, 'M-CN', 'INVOICE:CN-1:POST', '2026-03-03', [
    { id: 'N1', account: 'ret', debit: 50 }, { id: 'N2', account: 'ar', customerId: 'C', credit: 50 },
  ]);
  db.insert('glSourceEvent', [
    { tenantId: T1, sourceKey: 'INVOICE:RET-1:POST', status: 'DONE', payload: { type: 'RETURN', appliesTo: { invoiceId: 'INV-1', amount: '115.00' } } },
    { tenantId: T1, sourceKey: 'INVOICE:CN-1:POST', status: 'DONE', payload: { type: 'RETURN', appliesTo: { invoiceId: 'INV-1', amount: null } } },
    { tenantId: T1, sourceKey: 'INVOICE:INV-1:POST', status: 'ERROR', payload: { type: 'CREDIT' } },
  ]);
  return db;
}

const retInput = (id: string, moveId: string, amount: string | null): ReconcileEventInput => ({
  sourceType: 'INVOICE', sourceId: id, event: 'POST', moveId,
  payload: { type: 'RETURN', appliesTo: { invoiceId: 'INV-1', amount } } as never,
});
const saleInput = (moveId: string): ReconcileEventInput => ({ sourceType: 'INVOICE', sourceId: 'INV-1', event: 'POST', moveId, payload: { type: 'CREDIT' } as never });

test('مرتجع وإشعار دائن رُحّلا قبل فاتورة بيعهما ⇒ يُطابَقان عند ترحيل البيع (RET بباقيه ثم CN بالمفتوح)، وC16 أخضر', async () => {
  const db = returnsBeforeSale();
  const s = store(db);
  // المرتجع والإشعار أولاً: لا قيد حيّ للبيع ولا افتتاح ⇒ لا شيء (يلتقطهما البيع لاحقاً)
  assert.deepEqual(await reconcileAfterPost(s, retInput('RET-1', 'M-RET', '115.00')), { created: 0, removed: 0 });
  assert.deepEqual(await reconcileAfterPost(s, retInput('CN-1', 'M-CN', null)), { created: 0, removed: 0 });

  // البيع يُرحَّل بعد إعادة المحاولة
  addMove(db, 'M-INV', 'INVOICE:INV-1:POST', '2026-03-01', [
    { id: 'L1', account: 'ar', customerId: 'C', debit: 1150, dueDate: '2026-04-01' }, { id: 'L2', account: 'rev', credit: 1150 },
  ]);
  assert.deepEqual(await reconcileAfterPost(s, saleInput('M-INV')), { created: 2, removed: 0 });
  assert.deepEqual(
    db.table('glPartialReconcile').map((p) => [p.debitLineId, p.creditLineId, p.amountMilli, p.sourceRef]),
    [['L1', 'T3', M(115), 'RET:RET-1'], ['L1', 'N2', M(50), 'CN:CN-1']],
  );
  assert.equal(residual(db, 'L1'), M(985), 'مدين البيع = المتبقّي التشغيلي');
  assert.equal(residual(db, 'T3'), 0n);
  assert.equal(residual(db, 'N2'), 0n);

  // تساوي الأثر
  assert.deepEqual(await reconcileAfterPost(s, saleInput('M-INV')), { created: 0, removed: 0 });

  // الأعمار: لا رصيد دائن غير مخصّص، وC16 أخضر
  const v = ledgerView(db);
  const aging = buildAging({ kind: 'AR', asOf: '2026-05-15', basis: 'due', buckets: DEFAULT_AGING_BUCKETS, items: v.items, names: new Map() });
  assert.equal(aging.totals.unappliedCredits, 0n);
  assert.equal(aging.totals.total, M(985));
  assert.equal(c16(v.openDebit, new Map([['C', M(985)]])).status, 'GREEN');
  // وكل نداء مقيّد بالشركة
  for (const c of db.calls) assert.ok(json(c.args).includes(T1), `${c.model}.${c.method} بلا tenantId`);
});

test('المرتجع قبل بيعه: إعادة ترحيل البيع (فكٌّ بالعكس ثم قيد جديد) تعيد التقاطه بباقيه كاملاً', async () => {
  const db = returnsBeforeSale();
  const s = store(db);
  addMove(db, 'M-INV', 'INVOICE:INV-1:POST', '2026-03-01', [
    { id: 'L1', account: 'ar', customerId: 'C', debit: 1150 }, { id: 'L2', account: 'rev', credit: 1150 },
  ]);
  await reconcileAfterPost(s, saleInput('M-INV'));
  // REPOST_REV ثم REPOST
  addMove(db, 'M-INV-RV', 'INVOICE:INV-1:POST:REPOST_REV:1', '2026-03-01', [
    { id: 'V1', account: 'ar', customerId: 'C', credit: 1150 }, { id: 'V2', account: 'rev', debit: 1150 },
  ], { reversedMoveId: 'M-INV' });
  assert.deepEqual(
    await reconcileAfterPost(s, { sourceType: 'INVOICE', sourceId: 'INV-1', event: 'REVERSE', moveId: 'M-INV-RV', reversedMoveId: 'M-INV', payload: null }),
    { created: 1, removed: 2 },
  );
  addMove(db, 'M-INV2', 'INVOICE:INV-1:POST:REPOST:1', '2026-03-01', [
    { id: 'K1', account: 'ar', customerId: 'C', debit: 1150 }, { id: 'K2', account: 'rev', credit: 1150 },
  ]);
  assert.deepEqual(await reconcileAfterPost(s, saleInput('M-INV2')), { created: 2, removed: 0 });
  assert.equal(residual(db, 'K1'), M(985));
  assert.equal(residual(db, 'T3'), 0n);
  assert.equal(residual(db, 'L1'), 0n, 'الأصل مطابَق بعكسه');
});

test('الفحص الرخيص: بيع نقدي مسدّد بساقه، أو آجل متبقّيه = إجماليه ⇒ لا قراءة لبنود المرتجعات', async () => {
  const db = baseDb();
  db.insert('invoice', [{ id: 'CS-1', tenantId: T1, type: 'CASH', total: 100, remainingAmt: 0 }, { id: 'CR-1', tenantId: T1, type: 'CREDIT', total: 100, remainingAmt: 100 }]);
  addMove(db, 'M-CS', 'INVOICE:CS-1:POST', '2026-03-01', [
    { id: 'A1', account: 'ar', customerId: 'C', debit: 100 }, { id: 'A2', account: 'rev', credit: 100 },
    { id: 'A3', account: 'cash', debit: 100 }, { id: 'A4', account: 'ar', customerId: 'C', credit: 100 },
  ]);
  addMove(db, 'M-CR', 'INVOICE:CR-1:POST', '2026-03-01', [{ id: 'B1', account: 'ar', customerId: 'C', debit: 100 }, { id: 'B2', account: 'rev', credit: 100 }]);
  const s = store(db);
  db.calls = [];
  await reconcileAfterPost(s, { sourceType: 'INVOICE', sourceId: 'CS-1', event: 'POST', moveId: 'M-CS', payload: { type: 'CASH' } as never });
  await reconcileAfterPost(s, { sourceType: 'INVOICE', sourceId: 'CR-1', event: 'POST', moveId: 'M-CR', payload: { type: 'CREDIT' } as never });
  assert.ok(!db.calls.some((c) => c.model === 'invoiceItem'), 'لا مسح لبنود المرتجعات');
});

// ═══ (٢) المستند المشمول بالافتتاح ═══

/**
 * مربوطة بأثر رجعي من 2026-01-01: فاتورة INV-900 (2025-12-10) بـ1,000 داخل سطر افتتاح العميل C (2025-12-31) وحدثها
 * SKIPPED(OPENING)؛ وفاتورة INV-901 بعد التفعيل لم تُرحَّل بعد (PENDING).
 */
function openingDb(): FakeDb {
  const db = baseDb();
  addMove(db, 'M-OPEN', null, '2025-12-31', [
    { id: 'O1', account: 'ar', customerId: 'C', debit: 1000 }, { id: 'O2', account: 'ar', customerId: 'D', debit: 700 },
    { id: 'O3', account: 'cash', credit: 1700 },
  ], { moveType: 'OPENING' });
  db.insert('glSourceEvent', [
    { tenantId: T1, sourceKey: 'INVOICE:INV-900:POST', status: 'SKIPPED', skipReason: 'OPENING', payload: { type: 'CREDIT' } },
    { tenantId: T1, sourceKey: 'INVOICE:INV-901:POST', status: 'PENDING', skipReason: null, payload: { type: 'CREDIT' } },
    { tenantId: T1, sourceKey: 'INVOICE:INV-902:POST', status: 'SKIPPED', skipReason: 'NETTED', payload: { type: 'CREDIT' } },
  ]);
  return db;
}

test('سداد فاتورة مشمولة بالافتتاح ⇒ يُطابَق بسطر افتتاح العميل نفسه (لا عميل آخر)، والأعمار = remainingAmt وC16 أخضر', async () => {
  const db = openingDb();
  addMove(db, 'M-R', 'RECEIPT:R-1:POST', '2026-02-05', [
    { id: 'R1', account: 'cash', debit: 450 }, { id: 'R2', account: 'ar', customerId: 'C', credit: 450 },
  ]);
  const out = await reconcileAfterPost(store(db), {
    sourceType: 'RECEIPT', sourceId: 'R-1', event: 'POST', moveId: 'M-R',
    payload: { allocations: [
      { id: 'a1', invoiceId: 'INV-900', amount: '400.00' },
      // فاتورة لم تُرحَّل بعد (PENDING) ومُرحَّلة بلا قيد (NETTED): لا افتتاح — تنتظر INVOICE:POST كما كانت
      { id: 'a2', invoiceId: 'INV-901', amount: '30.00' }, { id: 'a3', invoiceId: 'INV-902', amount: '20.00' },
    ] } as never,
  });
  assert.deepEqual(out, { created: 1, removed: 0 });
  assert.deepEqual(db.table('glPartialReconcile').map((p) => [p.debitLineId, p.creditLineId, p.amountMilli, p.sourceRef]), [['O1', 'R2', M(400), 'RI:a1']]);
  assert.equal(residual(db, 'O1'), M(600));
  assert.equal(residual(db, 'O2'), M(700), 'افتتاح عميل آخر لا يُمسّ');

  const v = ledgerView(db);
  const aging = buildAging({ kind: 'AR', asOf: '2026-05-15', basis: 'due', buckets: DEFAULT_AGING_BUCKETS, items: v.items.filter((i) => i.partnerId === 'C'), names: new Map() });
  // المتبقّي من السند (50 لفاتورتين لم تُرحَّلا) رصيد دائن غير مخصّص كما في التشغيل حتى تُرحَّلا
  assert.equal(aging.totals.older, M(600), 'سطر الافتتاح بباقيه 600 لا بكامل 1,000');
  assert.equal(aging.totals.unappliedCredits, -M(50));
  assert.equal(c16(new Map([['C', v.openDebit.get('C')!]]), new Map([['C', M(600)]])).status, 'GREEN', 'C16: 600 مقابل 600');
  // تساوي الأثر
  assert.deepEqual(await reconcileAfterPost(store(db), {
    sourceType: 'RECEIPT', sourceId: 'R-1', event: 'POST', moveId: 'M-R', payload: { allocations: [{ id: 'a1', invoiceId: 'INV-900', amount: '400.00' }] } as never,
  }), { created: 0, removed: 0 });
});

test('الافتتاح: مرتجع البيع المشمول وشطبه (CA) يُطابَقان بسطر الافتتاح بحدّهما', async () => {
  const db = openingDb();
  addMove(db, 'M-RET9', 'INVOICE:RET-9:POST', '2026-02-06', [{ id: 'T9', account: 'ret', debit: 100 }, { id: 'T10', account: 'ar', customerId: 'C', credit: 120 }, { id: 'T11', account: 'rev', debit: 20 }]);
  const s = store(db);
  assert.deepEqual(await reconcileAfterPost(s, {
    sourceType: 'INVOICE', sourceId: 'RET-9', event: 'POST', moveId: 'M-RET9',
    payload: { type: 'RETURN', appliesTo: { invoiceId: 'INV-900', amount: '100.00' } } as never,
  }), { created: 1, removed: 0 });
  assert.equal(residual(db, 'T10'), M(20), 'بحدّ ما أسقطه من متبقّي بيعه');

  addMove(db, 'M-WO', 'AR_ENTRY:adj1:POST', '2026-02-07', [{ id: 'W1', account: 'bad', debit: 50 }, { id: 'W2', account: 'ar', customerId: 'C', credit: 50 }]);
  assert.deepEqual(await reconcileAfterPost(s, {
    sourceType: 'CUSTOMER_ADJUSTMENT', sourceId: 'adj1', event: 'POST', moveId: 'M-WO',
    payload: { origin: 'CUSTOMER_ADJUSTMENT', kind: 'BAD_DEBT_WRITEOFF', allocations: [{ id: 'al1', invoiceId: 'INV-900', amount: '50.00' }] },
  }), { created: 1, removed: 0 });
  assert.equal(residual(db, 'O1'), M(850));
  assert.deepEqual(db.table('glPartialReconcile').map((p) => p.sourceRef), ['RET:RET-9', 'CA:al1']);
});

test('الافتتاح: إلغاء فاتورة آجلة مشمولة (عكسٌ من المستند بلا أصل) يُسقط سطر الافتتاح؛ والنقدية الكاملة تتطابق داخلياً؛ وkeepCashLeg يبقى رصيداً دائناً', async () => {
  const db = openingDb();
  db.insert('glSourceEvent', [
    { tenantId: T1, sourceKey: 'INVOICE:CS-9:POST', status: 'SKIPPED', skipReason: 'OPENING', payload: { type: 'CASH' } },
    { tenantId: T1, sourceKey: 'INVOICE:CS-8:POST', status: 'SKIPPED', skipReason: 'OPENING', payload: { type: 'CASH' } },
  ]);
  const s = store(db);
  // آجلة: دائن 1,000 مقابل مدين الافتتاح ⇒ يُغلق السطر (التشغيل: الفاتورة الملغاة خارج C16)
  addMove(db, 'M-RV9', 'INVOICE:INV-900:REVERSE', '2026-03-01', [{ id: 'X1', account: 'ar', customerId: 'C', credit: 1000 }, { id: 'X2', account: 'rev', debit: 1000 }]);
  assert.deepEqual(await reconcileAfterPost(s, {
    sourceType: 'INVOICE', sourceId: 'INV-900', event: 'REVERSE', moveId: 'M-RV9', reversedMoveId: null, payload: { type: 'CREDIT' } as never,
  }), { created: 1, removed: 0 });
  assert.equal(residual(db, 'O1'), 0n);
  assert.equal(residual(db, 'X1'), 0n);
  // نقدية عُكست كاملة: ساقا الذمة في العكس نفسه
  addMove(db, 'M-RV8', 'INVOICE:CS-8:REVERSE', '2026-03-02', [
    { id: 'Y1', account: 'ar', customerId: 'D', credit: 80 }, { id: 'Y2', account: 'rev', debit: 80 },
    { id: 'Y3', account: 'ar', customerId: 'D', debit: 80 }, { id: 'Y4', account: 'cash', credit: 80 },
  ]);
  await reconcileAfterPost(s, { sourceType: 'INVOICE', sourceId: 'CS-8', event: 'REVERSE', moveId: 'M-RV8', reversedMoveId: null, payload: { type: 'CASH' } as never });
  assert.deepEqual([residual(db, 'Y1'), residual(db, 'Y3'), residual(db, 'O2')], [0n, 0n, M(700)]);
  // keepCashLeg (Q1): دائنه رصيد العميل الدائن — لا يُسقط افتتاحه
  addMove(db, 'M-RV7', 'INVOICE:CS-9:REVERSE', '2026-03-03', [{ id: 'Z1', account: 'ar', customerId: 'D', credit: 60 }, { id: 'Z2', account: 'rev', debit: 60 }]);
  assert.deepEqual(await reconcileAfterPost(s, {
    sourceType: 'INVOICE', sourceId: 'CS-9', event: 'REVERSE', moveId: 'M-RV7', reversedMoveId: null, payload: { type: 'CASH', keepCashLeg: true } as never,
  }), { created: 0, removed: 0 });
  assert.equal(residual(db, 'O2'), M(700));
  // مصدرٌ غير مشمول بالافتتاح بلا أصل ⇒ لا شيء كما كان
  addMove(db, 'M-RV6', 'INVOICE:INV-901:REVERSE', '2026-03-04', [{ id: 'Q1', account: 'ar', customerId: 'C', credit: 10 }, { id: 'Q2', account: 'rev', debit: 10 }]);
  assert.deepEqual(await reconcileAfterPost(s, {
    sourceType: 'INVOICE', sourceId: 'INV-901', event: 'REVERSE', moveId: 'M-RV6', reversedMoveId: null, payload: { type: 'CREDIT' } as never,
  }), { created: 0, removed: 0 });
});

// ═══ (٣) القيد الحيّ بلا LIKE ═══

test('liveMoveIdsOf: مفاتيح دقيقة على الفهرس الفريد (لا startsWith)، والسلسلة REPOST:1 ⇒ REPOST:2، واستعلام واحد حين الأساس حيّ', async () => {
  const db = baseDb();
  const t = (ms: number) => new Date(1_700_000_000_000 + ms);
  db.insert('glMove', [
    { id: 'A', tenantId: T1, state: 'POSTED', createdAt: t(1), reversedMoveId: null },
    { id: 'A-rv1', tenantId: T1, state: 'POSTED', createdAt: t(2), reversedMoveId: 'A' },
    { id: 'A1', tenantId: T1, state: 'POSTED', createdAt: t(3), reversedMoveId: null },
    { id: 'A1-rv2', tenantId: T1, state: 'POSTED', createdAt: t(4), reversedMoveId: 'A1' },
    { id: 'A2', tenantId: T1, state: 'POSTED', createdAt: t(5), reversedMoveId: null },
    { id: 'B', tenantId: T1, state: 'POSTED', createdAt: t(6), reversedMoveId: null },
    { id: 'C', tenantId: T1, state: 'POSTED', createdAt: t(7), reversedMoveId: null },
    { id: 'C-rv', tenantId: T1, state: 'POSTED', createdAt: t(8), reversedMoveId: 'C' },
  ]);
  db.insert('glMoveSource', [
    { tenantId: T1, sourceKey: 'INVOICE:a:POST', moveId: 'A' },
    { tenantId: T1, sourceKey: 'INVOICE:a:POST:REPOST_REV:1', moveId: 'A-rv1' },
    { tenantId: T1, sourceKey: 'INVOICE:a:POST:REPOST:1', moveId: 'A1' },
    { tenantId: T1, sourceKey: 'INVOICE:a:POST:REPOST_REV:2', moveId: 'A1-rv2' },
    { tenantId: T1, sourceKey: 'INVOICE:a:POST:REPOST:2', moveId: 'A2' },
    { tenantId: T1, sourceKey: 'INVOICE:b:POST', moveId: 'B' },
    { tenantId: T1, sourceKey: 'INVOICE:c:POST', moveId: 'C' },
    { tenantId: T1, sourceKey: 'INVOICE:c:REVERSE', moveId: 'C-rv' },
  ]);
  const gdb = db.client() as unknown as GlDb;
  db.calls = [];
  assert.deepEqual([...(await liveMoveIdsOf(gdb, T1, ['INVOICE:b:POST'])).entries()], [['INVOICE:b:POST', 'B']]);
  assert.equal(db.calls.filter((c) => c.model === 'glMoveSource').length, 1, 'الأساس حيّ ⇒ استعلام واحد');
  db.calls = [];
  const live = await liveMoveIdsOf(gdb, T1, ['INVOICE:a:POST', 'INVOICE:b:POST', 'INVOICE:c:POST', 'INVOICE:z:POST']);
  assert.deepEqual([...live.entries()].sort(), [['INVOICE:a:POST', 'A2'], ['INVOICE:b:POST', 'B']]);
  assert.ok(!json(db.calls).includes('startsWith'), 'لا LIKE على gl_move_sources');
  for (const c of db.calls) assert.ok(json(c.args).includes(T1));
  // السلسلة: الأساس (a وb وc وz) ثم REPOST:1 (a وc) ثم REPOST:2 (a)
  assert.equal(db.calls.filter((c) => c.model === 'glMoveSource').length, 3);
});
