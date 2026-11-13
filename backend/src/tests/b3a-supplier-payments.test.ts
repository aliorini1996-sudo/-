// «ربط الدفاتر» L1 (B3a): خدمة سندات صرف الموردين — services/suppliers/payments.ts بقاعدة مزيّفة (b3a-supplier-fake.ts).
// الترقيم والتحقق والتخصيص والمتبقّي والإلغاء ومنع التكرار وترتيب الأقفال، وصفر كتابات في gl_*.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  billOutstandingTx,
  cancelSupplierPaymentTx,
  createSupplierPaymentTx,
  SupplierError,
  supplierErrorBody,
  supplierPaymentDisplayNumber,
  type CreateSupplierPaymentInput,
} from '../services/suppliers/payments';
import { supplierBalanceMilli } from '../services/suppliers/core';
import { loadOpenBills } from '../services/suppliers/statement';
import { companyTimeZone, localDateIn } from '../services/erpPayload';
import { SupplierFakeDb, day, m, type Row } from './b3a-supplier-fake';

const T = 't1';

function world() {
  const db = new SupplierFakeDb();
  db.seed('glVendor', { id: 'V1', tenantId: T, name: 'مورّد الأول' });
  db.seed('glVendor', { id: 'V2', tenantId: T, name: 'مورّد مؤرشف', isActive: false });
  db.seed('glVendor', { id: 'VX', tenantId: 't2', name: 'مورّد شركة أخرى' });
  db.seed('salesRep', { id: 'R1', tenantId: T, name: 'مندوب' });
  db.seed('salesRep', { id: 'RX', tenantId: 't2', name: 'مندوب شركة أخرى' });
  db.seed('glSettings', { tenantId: T, timezone: 'Asia/Riyadh' });
  db.seed('companySettings', { tenantId: T, countryCode: 'SA' });
  return db;
}

/** فاتورة مورّد (حركة وارد مسعَّرة) */
function bill(db: SupplierFakeDb, o: { id: string; vendorId?: string; tenantId?: string; mode?: 'CASH' | 'CREDIT' | null; total: number; billDate?: string; dueDate?: string | null; status?: string; supplierRef?: string }): Row {
  return db.seed('warehouseEntry', {
    id: o.id,
    tenantId: o.tenantId ?? T,
    type: 'RECEIVE',
    vendorId: o.vendorId ?? 'V1',
    paymentMode: o.mode === undefined ? 'CREDIT' : o.mode,
    status: o.status ?? 'POSTED',
    supplierRef: o.supplierRef ?? `INV-${o.id}`,
    billDate: day(o.billDate ?? '2026-10-01'),
    dueDate: o.dueDate === null ? null : day(o.dueDate ?? o.billDate ?? '2026-10-01'),
    totalMilli: m(o.total),
  });
}

function input(o: Partial<CreateSupplierPaymentInput> = {}): CreateSupplierPaymentInput {
  return { tenantId: T, vendorId: 'V1', amountMilli: m(100), method: 'CASH', paidAt: day('2026-11-05'), allocations: [], ...o };
}

async function pay(db: SupplierFakeDb, o: Partial<CreateSupplierPaymentInput> = {}) {
  return db.tx((tx) => createSupplierPaymentTx(tx, input(o)));
}

async function rejects(p: Promise<unknown>, code: string, status: number): Promise<SupplierError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof SupplierError, `ليس SupplierError: ${String(e)}`);
    assert.equal(e.code, code, e.message);
    assert.equal(e.status, status);
    return e;
  }
  assert.fail(`لم يُرفض (${code})`);
}

const outstanding = async (db: SupplierFakeDb, id: string) => (await db.tx((tx) => billOutstandingTx(tx, T, [id]))).get(id);
const writesOf = (db: SupplierFakeDb) => db.calls.filter((c) => /\.(create|createMany|updateMany)$/.test(c.op)).map((c) => c.op);

// ═══ الترقيم ═══

test('الترقيم: max+1 لكل شركة، وقيد PAYMENT −المبلغ بتاريخ الدفع ومرجعه SP-000001', async () => {
  const db = world();
  db.seed('supplierPayment', { tenantId: 't2', vendorId: 'VX', number: 7, amountMilli: m(5), method: 'CASH', paidAt: day('2026-11-01') });
  const a = await pay(db, { amountMilli: m(250.5), note: '  دفعة أولى ', reference: ' TRX-1 ', createdBy: 'أحمد' });
  const b = await pay(db, { amountMilli: m(10) });
  assert.equal(a.number, 1, 'أرقام شركةٍ أخرى لا تدخل');
  assert.equal(b.number, 2);
  assert.equal(a.replay, false);
  const p = db.t.supplierPayment.find((x) => x.id === a.id)!;
  assert.equal(p.amountMilli, 250_500n);
  assert.equal(p.status, 'POSTED');
  assert.equal(p.reference, 'TRX-1');
  assert.equal(p.note, 'دفعة أولى');
  assert.equal(p.salesRepId, null);
  assert.deepEqual(p.paidAt, day('2026-11-05'));
  const led = db.t.supplierLedgerEntry.filter((l) => l.supplierPaymentId === a.id);
  assert.equal(led.length, 1);
  assert.equal(led[0].kind, 'PAYMENT');
  assert.equal(led[0].amountMilli, -250_500n);
  assert.equal(led[0].vendorId, 'V1');
  assert.deepEqual(led[0].docDate, day('2026-11-05'));
  assert.equal(led[0].ref, 'SP-000001');
  assert.equal(led[0].createdBy, 'أحمد');
  assert.equal(supplierPaymentDisplayNumber(123), 'SP-000123');
});

test('الترقيم يكمل من أعلى رقم (لا من العدد)، وتاريخ الدفع يُحفظ يوماً', async () => {
  const db = world();
  db.seed('supplierPayment', { tenantId: T, vendorId: 'V1', number: 41, amountMilli: m(5), method: 'CASH', paidAt: day('2026-11-01') });
  const r = await pay(db, { paidAt: new Date('2026-11-06T21:30:00.000Z') });
  assert.equal(r.number, 42);
  assert.deepEqual(db.t.supplierPayment.find((x) => x.id === r.id)!.paidAt, day('2026-11-06'));
});

test('ترتيب الأقفال: مرجع العميل ثم صفوف الفواتير FOR UPDATE ثم قفل الترقيم، وكلها $executeRaw للاستشاري', async () => {
  const db = world();
  bill(db, { id: 'B2', total: 100 });
  bill(db, { id: 'B1', total: 100 });
  db.calls.length = 0;
  await pay(db, { amountMilli: m(150), clientRef: 'cr-1', allocations: [{ warehouseEntryId: 'B2', amountMilli: m(100) }, { warehouseEntryId: 'B1', amountMilli: m(50) }] });
  const at = (pred: (c: { op: string; sql?: string }) => boolean) => db.calls.findIndex(pred);
  const ref = at((c) => c.op === '$executeRaw' && (c as { values?: unknown[] }).values?.[0] === 'supplier-payment-ref:t1:cr-1');
  const rows = at((c) => c.op === '$queryRaw' && !!c.sql?.includes('FOR UPDATE'));
  const num = at((c) => c.op === '$executeRaw' && (c as { values?: unknown[] }).values?.[0] === 'supplier-payment-number:t1');
  const create = at((c) => c.op === 'supplierPayment.create');
  assert.ok(ref >= 0 && ref < rows && rows < num && num < create, JSON.stringify(db.calls.map((c) => c.op)));
  assert.match(db.calls[rows].sql!, /ORDER BY id\s+FOR UPDATE/);
  assert.deepEqual(db.calls[rows].values, [T, ['B2', 'B1']]);
  for (const c of db.calls.filter((x) => x.op === '$executeRaw')) assert.match(c.sql!, /pg_advisory_xact_lock\(hashtext\(\?::text\)\)/);
});

test('حارس ثابت: القفل الاستشاري في payments.ts بـtx.$executeRaw وحده (لا $queryRaw ولا أقفال جلسة)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'suppliers', 'payments.ts'), 'utf8');
  const lines = src.split('\n').filter((l) => /pg_advisory/.test(l) && !/^\s*(\*|\/\/)/.test(l));
  assert.equal(lines.length, 2);
  for (const l of lines) assert.match(l, /await tx\.\$executeRaw`SELECT pg_advisory_xact_lock\(hashtext\(/);
  assert.doesNotMatch(src, /pg_advisory_lock\(|pg_try_advisory|pg_advisory_unlock/);
});

// ═══ التحقق ═══

test('التحقق: مبلغ ≤ ٠، طريقة مجهولة، عهدة بلا مندوب أو بمندوب شركة أخرى ⇒ 400؛ مورّد شركة أخرى ⇒ 404؛ ولا كتابة', async () => {
  const db = world();
  await rejects(pay(db, { amountMilli: 0n }), 'SUPPLIER_PAYMENT_INVALID', 400);
  await rejects(pay(db, { amountMilli: -5n }), 'SUPPLIER_PAYMENT_INVALID', 400);
  await rejects(pay(db, { method: 'GOLD' as never }), 'SUPPLIER_PAYMENT_INVALID', 400);
  await rejects(pay(db, { method: 'REP_CUSTODY' }), 'SUPPLIER_PAYMENT_INVALID', 400);
  await rejects(pay(db, { method: 'REP_CUSTODY', salesRepId: 'RX' }), 'SUPPLIER_PAYMENT_INVALID', 400);
  await rejects(pay(db, { vendorId: 'VX' }), 'SUPPLIER_NOT_FOUND', 404);
  await rejects(pay(db, { paidAt: new Date('x') }), 'SUPPLIER_PAYMENT_INVALID', 400);
  await rejects(pay(db, { clientRef: 'مرجع عربي' }), 'SUPPLIER_PAYMENT_INVALID', 400);
  assert.equal(db.t.supplierPayment.length, 0);
  assert.equal(db.t.supplierLedgerEntry.length, 0);
});

test('المورّد المؤرشف يُدفع له، والعهدة بمندوب الشركة تحفظ المندوب، ومندوبٌ لغير العهدة يُهمل', async () => {
  const db = world();
  const a = await pay(db, { vendorId: 'V2' });
  assert.equal(db.t.supplierPayment.find((p) => p.id === a.id)!.vendorId, 'V2');
  const b = await pay(db, { method: 'REP_CUSTODY', salesRepId: 'R1' });
  assert.equal(db.t.supplierPayment.find((p) => p.id === b.id)!.salesRepId, 'R1');
  const c = await pay(db, { method: 'BANK_TRANSFER', salesRepId: 'R1' });
  assert.equal(db.t.supplierPayment.find((p) => p.id === c.id)!.salesRepId, null);
});

test('supplierErrorBody: {success:false, code, message, details}', async () => {
  const db = world();
  bill(db, { id: 'B1', total: 10 });
  const e = await rejects(pay(db, { amountMilli: m(20), allocations: [{ warehouseEntryId: 'B1', amountMilli: m(20) }] }), 'ALLOCATION_EXCEEDS_OUTSTANDING', 409);
  assert.deepEqual(supplierErrorBody(e), {
    success: false, code: 'ALLOCATION_EXCEEDS_OUTSTANDING', message: e.message,
    details: { warehouseEntryId: 'B1', supplierRef: 'INV-B1', outstanding: 10, requested: 20 },
  });
  assert.equal(new SupplierError('SUPPLIER_CODE_EXISTS', 'الرمز مستعمل', 409).status, 409, 'رموز مسار الموردين بحالتها');
});

// ═══ التخصيص والمتبقّي ═══

test('تخصيص يتجاوز المتبقّي ⇒ 409 ALLOCATION_EXCEEDS_OUTSTANDING بلا أي كتابة (المعاملة تُجهض)', async () => {
  const db = world();
  bill(db, { id: 'B1', total: 1150 });
  await rejects(pay(db, { amountMilli: m(1150.001), allocations: [{ warehouseEntryId: 'B1', amountMilli: m(1150.001) }] }), 'ALLOCATION_EXCEEDS_OUTSTANDING', 409);
  assert.equal(db.t.supplierPayment.length, 0);
  assert.equal(db.t.supplierPaymentAllocation.length, 0);
  assert.equal(db.t.supplierLedgerEntry.length, 0);
});

test('Σ التخصيص > المبلغ ⇒ 400، والفاتورة المكرَّرة ⇒ 400، والتخصيص بصفر يُهمل', async () => {
  const db = world();
  bill(db, { id: 'B1', total: 500 });
  bill(db, { id: 'B2', total: 500 });
  await rejects(pay(db, { amountMilli: m(100), allocations: [{ warehouseEntryId: 'B1', amountMilli: m(60) }, { warehouseEntryId: 'B2', amountMilli: m(41) }] }), 'SUPPLIER_PAYMENT_INVALID', 400);
  await rejects(pay(db, { amountMilli: m(100), allocations: [{ warehouseEntryId: 'B1', amountMilli: m(10) }, { warehouseEntryId: 'B1', amountMilli: m(10) }] }), 'SUPPLIER_PAYMENT_INVALID', 400);
  await rejects(pay(db, { amountMilli: m(100), allocations: [{ warehouseEntryId: 'B1', amountMilli: -1n }] }), 'SUPPLIER_PAYMENT_INVALID', 400);
  const r = await pay(db, { amountMilli: m(100), allocations: [{ warehouseEntryId: 'B1', amountMilli: m(100) }, { warehouseEntryId: 'B2', amountMilli: 0n }] });
  assert.deepEqual(r.allocations, [{ warehouseEntryId: 'B1', amountMilli: m(100) }]);
  assert.equal(db.t.supplierPaymentAllocation.length, 1);
});

test('دفعة جزئية ثم المتبقّي: ١١٥٠ ⇒ ٤٠٠ ⇒ ٧٥٠ متبقٍّ ⇒ سداده ⇒ صفر ⇒ أي تخصيص بعدها 409', async () => {
  const db = world();
  bill(db, { id: 'B1', total: 1150 });
  await pay(db, { amountMilli: m(400), allocations: [{ warehouseEntryId: 'B1', amountMilli: m(400) }] });
  assert.equal(await outstanding(db, 'B1'), m(750));
  await pay(db, { amountMilli: m(750), allocations: [{ warehouseEntryId: 'B1', amountMilli: m(750) }] });
  assert.equal(await outstanding(db, 'B1'), 0n);
  await rejects(pay(db, { amountMilli: m(1), allocations: [{ warehouseEntryId: 'B1', amountMilli: m(0.001) }] }), 'ALLOCATION_EXCEEDS_OUTSTANDING', 409);
  const alloc = db.t.supplierPaymentAllocation;
  assert.deepEqual(alloc.map((a) => [a.tenantId, a.warehouseEntryId, a.amountMilli]), [[T, 'B1', m(400)], [T, 'B1', m(750)]]);
});

test('الدفعة الزائدة عن التخصيص تبقى مقدّمة غير مخصَّصة: الكشف = Σ القيود', async () => {
  const db = world();
  bill(db, { id: 'B1', total: 300 });
  db.seed('supplierLedgerEntry', { tenantId: T, vendorId: 'V1', kind: 'BILL', amountMilli: m(300), warehouseEntryId: 'B1', docDate: day('2026-10-01') });
  await pay(db, { amountMilli: m(500), allocations: [{ warehouseEntryId: 'B1', amountMilli: m(300) }] });
  assert.equal(await outstanding(db, 'B1'), 0n);
  assert.equal(supplierBalanceMilli(db.t.supplierLedgerEntry.filter((l) => l.vendorId === 'V1') as { amountMilli: bigint }[]), -m(200), 'رصيد مدين للمورّد بقدر المقدّمة');
});

test('التخصيص المرفوض: فاتورة مورّد آخر، نقدية بلا سند آلي، ملغاة، غير مصنَّفة، مرتجع، وفاتورة شركة أخرى (لا يُكشف وجودها)', async () => {
  const db = world();
  bill(db, { id: 'BV2', vendorId: 'V2', total: 100 });
  bill(db, { id: 'BC', mode: 'CASH', total: 100 });
  bill(db, { id: 'BX', status: 'CANCELLED', total: 100 });
  bill(db, { id: 'BU', mode: null, total: 100 });
  db.seed('warehouseEntry', { id: 'RET', tenantId: T, type: 'RETURN', vendorId: 'V1', returnOfEntryId: 'BV2', totalMilli: m(10) });
  bill(db, { id: 'BT2', tenantId: 't2', vendorId: 'VX', total: 100 });
  for (const id of ['BV2', 'BC', 'BX', 'BU', 'RET', 'BT2', 'NOPE']) {
    const e = await rejects(pay(db, { amountMilli: m(10), allocations: [{ warehouseEntryId: id, amountMilli: m(10) }] }), 'SUPPLIER_PAYMENT_INVALID', 400);
    assert.equal(e.detail?.warehouseEntryId, id);
  }
  const foreign = await rejects(pay(db, { amountMilli: m(10), allocations: [{ warehouseEntryId: 'BT2', amountMilli: m(10) }] }), 'SUPPLIER_PAYMENT_INVALID', 400);
  const missing = await rejects(pay(db, { amountMilli: m(10), allocations: [{ warehouseEntryId: 'NOPE', amountMilli: m(10) }] }), 'SUPPLIER_PAYMENT_INVALID', 400);
  assert.equal(foreign.message, missing.message);
  assert.equal(db.t.supplierPayment.length, 0);
});

test('مرتجع مرتبط يُنقص المتبقّي، والملغى لا يُنقصه، والمردود نقداً (REFUND_IN) لا يُنقصه بقدر المردود — والفواتير المفتوحة = رصيد الكشف', async () => {
  const db = world();
  bill(db, { id: 'B1', total: 1150 });
  db.seed('supplierLedgerEntry', { tenantId: T, vendorId: 'V1', kind: 'BILL', amountMilli: m(1150), warehouseEntryId: 'B1', docDate: day('2026-10-01') });
  db.seed('warehouseEntry', { id: 'R1', tenantId: T, type: 'RETURN', vendorId: 'V1', returnOfEntryId: 'B1', totalMilli: m(230), billDate: day('2026-10-05') });
  db.seed('supplierLedgerEntry', { tenantId: T, vendorId: 'V1', kind: 'RETURN', amountMilli: -m(230), warehouseEntryId: 'R1', docDate: day('2026-10-05') });
  assert.equal(await outstanding(db, 'B1'), m(920));
  db.seed('warehouseEntry', { id: 'R2', tenantId: T, type: 'RETURN', vendorId: 'V1', returnOfEntryId: 'B1', totalMilli: m(100), status: 'CANCELLED' });
  assert.equal(await outstanding(db, 'B1'), m(920), 'المرتجع الملغى لا يُخصم');
  await rejects(pay(db, { amountMilli: m(921), allocations: [{ warehouseEntryId: 'B1', amountMilli: m(921) }] }), 'ALLOCATION_EXCEEDS_OUTSTANDING', 409);
  // مرتجع ثانٍ ردّ المورّد قيمته نقداً: سُوِّي بالنقد لا بالفاتورة
  db.seed('warehouseEntry', { id: 'R3', tenantId: T, type: 'RETURN', vendorId: 'V1', returnOfEntryId: 'B1', totalMilli: m(115), billDate: day('2026-10-06') });
  db.seed('supplierLedgerEntry', { tenantId: T, vendorId: 'V1', kind: 'RETURN', amountMilli: -m(115), warehouseEntryId: 'R3', docDate: day('2026-10-06') });
  db.seed('supplierLedgerEntry', { tenantId: T, vendorId: 'V1', kind: 'REFUND_IN', amountMilli: m(115), warehouseEntryId: 'R3', docDate: day('2026-10-06') });
  assert.equal(await outstanding(db, 'B1'), m(920));
  await pay(db, { amountMilli: m(500), allocations: [{ warehouseEntryId: 'B1', amountMilli: m(500) }] });
  const open = await loadOpenBills(db as never, T, 'V1', day('2026-11-05'));
  const openSum = open.reduce((s, b) => s + b.outstandingMilli, 0n);
  const balance = supplierBalanceMilli(db.t.supplierLedgerEntry.filter((l) => l.vendorId === 'V1') as { amountMilli: bigint }[]);
  assert.equal(openSum, m(420));
  assert.equal(balance, openSum, 'الفواتير المفتوحة تطابق الكشف بفرق صفر');
});

test('billOutstandingTx: الملغاة صفر، وما ليس في الشركة أو غير موجود لا يظهر، وغير المسعَّرة صفر', async () => {
  const db = world();
  bill(db, { id: 'B1', total: 10 });
  bill(db, { id: 'BX', status: 'CANCELLED', total: 10 });
  bill(db, { id: 'BT2', tenantId: 't2', vendorId: 'VX', total: 10 });
  db.seed('warehouseEntry', { id: 'UNP', tenantId: T, type: 'RECEIVE', totalMilli: null });
  const map = await db.tx((tx) => billOutstandingTx(tx, T, ['B1', 'BX', 'BT2', 'NOPE', 'UNP']));
  assert.deepEqual([...map].sort(), [['B1', m(10)], ['BX', 0n], ['UNP', 0n]]);
  assert.equal((await db.tx((tx) => billOutstandingTx(tx, T, []))).size, 0);
});

test('autoAllocate: الأقدم استحقاقاً أولاً بعد التخصيص الصريح، والزائد مقدّمة؛ ولا يُقفل إلا المفتوح', async () => {
  const db = world();
  bill(db, { id: 'BLATE', total: 300, billDate: '2026-10-20', dueDate: '2026-11-20' });
  bill(db, { id: 'BOLD', total: 200, billDate: '2026-09-01', dueDate: '2026-10-01' });
  bill(db, { id: 'BMID', total: 100, billDate: '2026-10-01', dueDate: '2026-10-15' });
  bill(db, { id: 'BPAID', total: 50, billDate: '2026-08-01' });
  bill(db, { id: 'BOTHER', vendorId: 'V2', total: 999, dueDate: '2026-01-01' });
  await pay(db, { amountMilli: m(50), allocations: [{ warehouseEntryId: 'BPAID', amountMilli: m(50) }] });
  db.calls.length = 0;
  const r = await pay(db, { amountMilli: m(700), autoAllocate: true, allocations: [{ warehouseEntryId: 'BLATE', amountMilli: m(50) }] });
  const lock = db.calls.find((c) => c.op === '$queryRaw' && c.sql?.includes('FOR UPDATE'))!;
  assert.deepEqual([...(lock.values![1] as string[])].sort(), ['BLATE', 'BMID', 'BOLD'], 'المسدَّدة وفواتير غيره لا تُقفل');
  const got = new Map(r.allocations.map((a) => [a.warehouseEntryId, a.amountMilli]));
  assert.equal(got.get('BOLD'), m(200));
  assert.equal(got.get('BMID'), m(100));
  assert.equal(got.get('BLATE'), m(300), 'الصريح ٥٠ + الآلي ٢٥٠ = متبقّيها');
  assert.equal(got.has('BOTHER'), false);
  assert.equal([...got.values()].reduce((s, x) => s + x, 0n), m(600), 'الزائد ١٠٠ مقدّمة غير مخصَّصة');
  for (const id of ['BOLD', 'BMID', 'BLATE']) assert.equal(await outstanding(db, id), 0n);
});

// ═══ السند الآلي للاستلام النقدي ═══

test('السند الآلي: يُخصَّص كاملاً لحركته النقدية (بلا تخصيصٍ ممرَّر)، ولا ثانٍ ساري لها، ولا لغيرها', async () => {
  const db = world();
  bill(db, { id: 'BC', mode: 'CASH', total: 230 });
  bill(db, { id: 'B1', total: 100 });
  const r = await pay(db, { amountMilli: m(230), method: 'BANK_TRANSFER', autoForEntryId: 'BC' });
  assert.deepEqual(r.allocations, [{ warehouseEntryId: 'BC', amountMilli: m(230) }]);
  assert.equal(db.t.supplierPayment.find((p) => p.id === r.id)!.autoForEntryId, 'BC');
  assert.equal(await outstanding(db, 'BC'), 0n, 'الاستلام النقدي مسدَّد ١٠٠٪');
  await rejects(pay(db, { amountMilli: m(230), autoForEntryId: 'BC' }), 'AUTO_PAYMENT_EXISTS', 409);
  bill(db, { id: 'BC2', mode: 'CASH', total: 50 });
  await rejects(pay(db, { amountMilli: m(50), autoForEntryId: 'BC2', allocations: [{ warehouseEntryId: 'B1', amountMilli: m(50) }] }), 'SUPPLIER_PAYMENT_INVALID', 400);
  await rejects(pay(db, { amountMilli: m(50), autoForEntryId: 'BC2', allocations: [{ warehouseEntryId: 'BC2', amountMilli: m(40) }] }), 'SUPPLIER_PAYMENT_INVALID', 400);
  await rejects(pay(db, { amountMilli: m(100), autoForEntryId: 'B1' }), 'SUPPLIER_PAYMENT_INVALID', 400);
  await rejects(pay(db, { amountMilli: m(51), autoForEntryId: 'BC2' }), 'ALLOCATION_EXCEEDS_OUTSTANDING', 409);
});

// ═══ منع التكرار ═══

test('clientRef: المكرَّر لنفس المورّد والمبلغ ⇒ السند القائم replay بلا كتابة؛ ولسندٍ مختلف ⇒ 409 CLIENT_REF_REUSED', async () => {
  const db = world();
  bill(db, { id: 'B1', total: 100 });
  const a = await pay(db, { amountMilli: m(60), clientRef: 'pay-1', allocations: [{ warehouseEntryId: 'B1', amountMilli: m(60) }] });
  db.calls.length = 0;
  const b = await pay(db, { amountMilli: m(60), clientRef: 'pay-1', allocations: [{ warehouseEntryId: 'B1', amountMilli: m(60) }] });
  assert.equal(b.replay, true);
  assert.equal(b.id, a.id);
  assert.equal(b.number, a.number);
  assert.deepEqual(b.allocations, [{ warehouseEntryId: 'B1', amountMilli: m(60) }]);
  assert.deepEqual(writesOf(db), [], 'لا كتابة في الإعادة');
  assert.equal(db.t.supplierPayment.length, 1);
  await rejects(pay(db, { amountMilli: m(61), clientRef: 'pay-1' }), 'CLIENT_REF_REUSED', 409);
  await rejects(pay(db, { vendorId: 'V2', amountMilli: m(60), clientRef: 'pay-1' }), 'CLIENT_REF_REUSED', 409);
});

// ═══ الإلغاء ═══

test('الإلغاء: CANCELLED مع من ولماذا، وقيد PAYMENT_REV +المبلغ عكساً حرفياً، ويعود المتبقّي، ومرّة واحدة فقط', async () => {
  const db = world();
  bill(db, { id: 'B1', total: 1000 });
  const r = await pay(db, { amountMilli: m(600), paidAt: day('2026-11-02'), allocations: [{ warehouseEntryId: 'B1', amountMilli: m(600) }] });
  assert.equal(await outstanding(db, 'B1'), m(400));
  await db.tx((tx) => cancelSupplierPaymentTx(tx, T, r.id, { by: 'سارة', reason: ' خطأ في المبلغ ', docDate: day('2026-11-10') }));
  const p = db.t.supplierPayment.find((x) => x.id === r.id)!;
  assert.equal(p.status, 'CANCELLED');
  assert.equal(p.cancelledBy, 'سارة');
  assert.equal(p.cancelReason, 'خطأ في المبلغ');
  assert.ok(p.cancelledAt instanceof Date);
  const led = db.t.supplierLedgerEntry.filter((l) => l.supplierPaymentId === r.id);
  const orig = led.find((l) => l.kind === 'PAYMENT')!;
  const rev = led.find((l) => l.kind === 'PAYMENT_REV')!;
  assert.equal(rev.amountMilli, m(600));
  assert.equal(rev.reversesId, orig.id);
  assert.deepEqual(rev.docDate, day('2026-11-10'));
  assert.equal(rev.ref, 'SP-000001');
  assert.equal(supplierBalanceMilli(led as { amountMilli: bigint }[]), 0n);
  assert.equal(await outstanding(db, 'B1'), m(1000), 'تخصيصات الملغى لا تُخصم');
  assert.equal(db.t.supplierPaymentAllocation.length, 1, 'التخصيص يبقى أثراً');
  await rejects(db.tx((tx) => cancelSupplierPaymentTx(tx, T, r.id, {})), 'SUPPLIER_PAYMENT_ALREADY_CANCELLED', 409);
  assert.equal(db.t.supplierLedgerEntry.filter((l) => l.kind === 'PAYMENT_REV').length, 1, 'لا عكس ثانٍ');
});

test('الإلغاء: يقفل صفّ السند FOR UPDATE قبل القراءة، والسند الآلي بـallowAuto وحده، وسند شركة أخرى 404', async () => {
  const db = world();
  bill(db, { id: 'BC', mode: 'CASH', total: 230 });
  const auto = await pay(db, { amountMilli: m(230), autoForEntryId: 'BC' });
  await rejects(db.tx((tx) => cancelSupplierPaymentTx(tx, T, auto.id, {})), 'AUTO_PAYMENT_CANCEL_VIA_ENTRY', 409);
  await rejects(db.tx((tx) => cancelSupplierPaymentTx(tx, 't2', auto.id, { allowAuto: true })), 'SUPPLIER_PAYMENT_NOT_FOUND', 404);
  await rejects(db.tx((tx) => cancelSupplierPaymentTx(tx, T, 'nope', { allowAuto: true })), 'SUPPLIER_PAYMENT_NOT_FOUND', 404);
  db.calls.length = 0;
  await db.tx((tx) => cancelSupplierPaymentTx(tx, T, auto.id, { allowAuto: true, docDate: day('2026-11-06') }));
  const lock = db.calls.findIndex((c) => c.op === '$queryRaw' && !!c.sql?.includes('FROM supplier_payments') && !!c.sql?.includes('FOR UPDATE'));
  const read = db.calls.findIndex((c) => c.op === 'supplierPayment.findFirst');
  assert.ok(lock >= 0 && lock < read);
  assert.equal(db.t.supplierPayment.find((p) => p.id === auto.id)!.status, 'CANCELLED');
  assert.equal(await outstanding(db, 'BC'), m(230));
});

test('تاريخ العكس: لا يسبق تاريخ الدفع، وبلا تاريخٍ ممرَّر = يوم الشركة بمنطقتها', async () => {
  const db = world();
  const a = await pay(db, { paidAt: day('2026-12-01') });
  await db.tx((tx) => cancelSupplierPaymentTx(tx, T, a.id, { docDate: day('2026-11-20') }));
  assert.deepEqual(db.t.supplierLedgerEntry.find((l) => l.supplierPaymentId === a.id && l.kind === 'PAYMENT_REV')!.docDate, day('2026-12-01'));
  const b = await pay(db, { paidAt: day('2026-01-01') });
  await db.tx((tx) => cancelSupplierPaymentTx(tx, T, b.id, {}));
  const expected = localDateIn(new Date(), companyTimeZone('Asia/Riyadh', 'SA'));
  assert.equal(db.t.supplierLedgerEntry.find((l) => l.supplierPaymentId === b.id && l.kind === 'PAYMENT_REV')!.docDate.toISOString().slice(0, 10), expected);
});

// ═══ صفر كتابات في الدفاتر ═══

test('صفر كتابات في gl_*: الخدمة لا تكتب إلا السندات والتخصيصات وكشف المورّد', async () => {
  const db = world();
  bill(db, { id: 'B1', total: 100 });
  bill(db, { id: 'BC', mode: 'CASH', total: 30 });
  db.calls.length = 0;
  const r = await pay(db, { amountMilli: m(100), autoAllocate: true });
  await pay(db, { amountMilli: m(30), autoForEntryId: 'BC' });
  await db.tx((tx) => cancelSupplierPaymentTx(tx, T, r.id, {}));
  const written = new Set(writesOf(db).map((op) => op.split('.')[0]));
  assert.deepEqual([...written].sort(), ['supplierLedgerEntry', 'supplierPayment', 'supplierPaymentAllocation']);
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'suppliers', 'payments.ts'), 'utf8')
    + fs.readFileSync(path.join(__dirname, '..', 'services', 'suppliers', 'statement.ts'), 'utf8');
  assert.doesNotMatch(src, /from '\.\.\/gl\//, 'لا استيراد من services/gl');
  assert.doesNotMatch(src, /\b(glVendor|glSettings)\.(create|update|upsert|delete)/);
});
