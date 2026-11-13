// «ربط الدفاتر» L1 (B3a): قراءات الموردين — services/suppliers/statement.ts بقاعدة مزيّفة (b3a-supplier-fake.ts):
// كشف الحساب بافتتاحي ورصيد جارٍ ومرفقات، الفواتير المفتوحة، أعمار الذمم «حتى تاريخ»، أرصدة الموردين، عزل الشركة، ولا N+1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agingJson,
  loadAging,
  loadOpenBills,
  loadSupplierBalances,
  loadSupplierStatement,
  openBillJson,
  settleBills,
  statementJson,
  type SettlementBill,
} from '../services/suppliers/statement';
import { SupplierFakeDb, day, m, type Row } from './b3a-supplier-fake';

const T = 't1';

/**
 * عالم المورّد V1 (الأرقام بوحدة العملة):
 *   09-10 BILL B1 +1150 (استحقاق 10-10، مرفقان) · 09-20 SP-1 −400 مخصَّص لـB1
 *   10-01 BILL B2 +2300 (استحقاق 10-31) · 10-05 RETURN R1 من B2 −230 · 10-15 SP-2 −1000 مخصَّص لـB2
 *   11-02 BILL B3 +575 (استحقاق 12-02) · 11-03 SP-3 −100 بلا تخصيص (مقدّمة)
 * وV2 (مؤرشف): 09-01 BILL BV +500 (استحقاق 09-01) · 09-05 SP-4 −500 مخصَّص لـBV · أُلغي بقيد عكسيّ مؤرَّخ 10-20 (+500)
 * وV3: 09-01 BILL BC3 +300 (استحقاق 09-15) · أُلغيت الفاتورة بمرتجع كامل 10-20 (−300)
 * وV4 بلا حركة. وصفوف شركةٍ أخرى t2 بالمعرّفات نفسها لا يجب أن تظهر.
 */
function world() {
  const db = new SupplierFakeDb();
  db.seed('glVendor', { id: 'V1', tenantId: T, name: 'ب مورّد', code: 'S-1' });
  db.seed('glVendor', { id: 'V2', tenantId: T, name: 'أ مورّد مؤرشف', isActive: false });
  db.seed('glVendor', { id: 'V3', tenantId: T, name: 'ج مورّد' });
  db.seed('glVendor', { id: 'V4', tenantId: T, name: 'د بلا حركة' });
  db.seed('glVendor', { id: 'VX', tenantId: 't2', name: 'شركة أخرى' });

  const bill = (id: string, vendorId: string, total: number, billDate: string, dueDate: string, extra: Row = {}) => {
    db.seed('warehouseEntry', { id, tenantId: T, type: 'RECEIVE', vendorId, paymentMode: 'CREDIT', supplierRef: `INV-${id}`, billDate: day(billDate), dueDate: day(dueDate), totalMilli: m(total), ...extra });
    db.seed('supplierLedgerEntry', { tenantId: T, vendorId, kind: 'BILL', amountMilli: m(total), warehouseEntryId: id, docDate: day(billDate), dueDate: day(dueDate), ref: `INV-${id}` });
  };
  const payment = (id: string, n: number, vendorId: string, amount: number, paidAt: string, allocTo?: string, extra: Row = {}) => {
    db.seed('supplierPayment', { id, tenantId: T, vendorId, number: n, amountMilli: m(amount), method: 'CASH', paidAt: day(paidAt), ...extra });
    if (allocTo) db.seed('supplierPaymentAllocation', { tenantId: T, paymentId: id, warehouseEntryId: allocTo, amountMilli: m(amount) });
    db.seed('supplierLedgerEntry', { id: `L-${id}`, tenantId: T, vendorId, kind: 'PAYMENT', amountMilli: -m(amount), supplierPaymentId: id, docDate: day(paidAt), ref: `SP-${String(n).padStart(6, '0')}` });
  };
  const ret = (id: string, ofId: string, vendorId: string, total: number, date: string) => {
    db.seed('warehouseEntry', { id, tenantId: T, type: 'RETURN', vendorId, returnOfEntryId: ofId, billDate: day(date), totalMilli: m(total) });
    db.seed('supplierLedgerEntry', { tenantId: T, vendorId, kind: 'RETURN', amountMilli: -m(total), warehouseEntryId: id, docDate: day(date) });
  };

  bill('B1', 'V1', 1150, '2026-09-10', '2026-10-10');
  payment('SP1', 1, 'V1', 400, '2026-09-20', 'B1');
  bill('B2', 'V1', 2300, '2026-10-01', '2026-10-31');
  ret('R1', 'B2', 'V1', 230, '2026-10-05');
  payment('SP2', 2, 'V1', 1000, '2026-10-15', 'B2');
  bill('B3', 'V1', 575, '2026-11-02', '2026-12-02');
  payment('SP3', 3, 'V1', 100, '2026-11-03');

  bill('BV', 'V2', 500, '2026-09-01', '2026-09-01');
  payment('SP4', 4, 'V2', 500, '2026-09-05', 'BV', { status: 'CANCELLED', cancelledAt: new Date('2026-10-20T09:00:00Z') });
  db.seed('supplierLedgerEntry', { tenantId: T, vendorId: 'V2', kind: 'PAYMENT_REV', amountMilli: m(500), supplierPaymentId: 'SP4', reversesId: 'L-SP4', docDate: day('2026-10-20') });

  bill('BC3', 'V3', 300, '2026-09-01', '2026-09-15', { status: 'CANCELLED' });
  ret('R3', 'BC3', 'V3', 300, '2026-10-20');

  db.seed('warehouseEntryAttachment', { tenantId: T, entryId: 'B1', name: 'a.pdf' });
  db.seed('warehouseEntryAttachment', { tenantId: T, entryId: 'B1', name: 'b.jpg' });
  db.seed('warehouseEntryAttachment', { tenantId: 't2', entryId: 'B1', name: 'foreign.pdf' });
  // شركة أخرى: قيود بالمورّد نفسه وفاتورة — لا يجب أن تظهر
  db.seed('supplierLedgerEntry', { tenantId: 't2', vendorId: 'V1', kind: 'BILL', amountMilli: m(99999), docDate: day('2026-10-02') });
  db.seed('warehouseEntry', { id: 'BT2', tenantId: 't2', type: 'RECEIVE', vendorId: 'V1', paymentMode: 'CREDIT', billDate: day('2026-10-01'), dueDate: day('2026-10-01'), totalMilli: m(99999) });
  return db;
}

// ═══ كشف الحساب ═══

test('كشف بفترة: الافتتاحي = Σ ما قبل from، والسطور بالترتيب ورصيدٌ جارٍ، والإجماليات والختامي، ومرفقات الحركة بعزل الشركة', async () => {
  const db = world();
  const s = (await loadSupplierStatement(db as never, T, 'V1', day('2026-10-01'), day('2026-10-31')))!;
  assert.equal(s.vendor.id, 'V1');
  assert.equal(s.openingMilli, m(750));
  assert.deepEqual(s.lines.map((l) => [l.row.kind, l.debitMilli, l.creditMilli, l.balanceMilli]), [
    ['BILL', 0n, m(2300), m(3050)],
    ['RETURN', m(230), 0n, m(2820)],
    ['PAYMENT', m(1000), 0n, m(1820)],
  ]);
  assert.equal(s.closingMilli, m(1820));
  assert.equal(s.totalDebitMilli, m(1230));
  assert.equal(s.totalCreditMilli, m(2300));
  const full = (await loadSupplierStatement(db as never, T, 'V1'))!;
  assert.equal(full.openingMilli, 0n);
  assert.equal(full.lines.length, 7, 'قيد الشركة الأخرى لا يظهر');
  assert.equal(full.lines[0].attachmentsCount, 2, 'مرفقات B1 في الشركة وحدها');
  assert.ok(full.lines.slice(1).every((l) => l.attachmentsCount === 0));
});

test('القبول: ختامي الكشف = Σ الفواتير − الدفعات − المرتجعات لكل مورّد، وكشف «حتى» يقف عند to', async () => {
  const db = world();
  const full = (await loadSupplierStatement(db as never, T, 'V1'))!;
  assert.equal(full.closingMilli, m(1150 + 2300 + 575) - m(400 + 1000 + 100) - m(230));
  assert.equal(full.lines[full.lines.length - 1].balanceMilli, full.closingMilli);
  const upTo = (await loadSupplierStatement(db as never, T, 'V1', null, day('2026-10-05')))!;
  assert.equal(upTo.closingMilli, m(1150 - 400 + 2300 - 230));
  assert.equal(upTo.lines.length, 4);
  const v2 = (await loadSupplierStatement(db as never, T, 'V2'))!;
  assert.deepEqual(v2.lines.map((l) => l.row.kind), ['BILL', 'PAYMENT', 'PAYMENT_REV']);
  assert.equal(v2.closingMilli, m(500), 'الدفعة الملغاة تعود ذمّةً');
});

test('كشف: ترتيب حتمي لليوم نفسه (لحظة الكتابة ثم المعرّف)، ومورّد خارج الشركة ⇒ null', async () => {
  const db = new SupplierFakeDb();
  db.seed('glVendor', { id: 'V1', tenantId: T, name: 'م' });
  db.seed('supplierLedgerEntry', { id: 'z', tenantId: T, vendorId: 'V1', kind: 'BILL', amountMilli: m(10), docDate: day('2026-11-01') });
  db.seed('supplierLedgerEntry', { id: 'a', tenantId: T, vendorId: 'V1', kind: 'PAYMENT', amountMilli: -m(4), docDate: day('2026-11-01') });
  db.seed('supplierLedgerEntry', { id: 'b', tenantId: T, vendorId: 'V1', kind: 'BILL', amountMilli: m(1), docDate: day('2026-10-31') });
  const s = (await loadSupplierStatement(db as never, T, 'V1'))!;
  assert.deepEqual(s.lines.map((l) => l.row.id), ['b', 'z', 'a']);
  assert.deepEqual(s.lines.map((l) => l.balanceMilli), [m(1), m(11), m(7)]);
  assert.equal(await loadSupplierStatement(db as never, 't2', 'V1'), null);
  assert.equal(await loadSupplierStatement(db as never, T, 'nope'), null);
});

test('statementJson: شكل العقد بأرقام لا BigInt', async () => {
  const db = world();
  const json = statementJson((await loadSupplierStatement(db as never, T, 'V1', day('2026-10-01'), day('2026-10-31')))!);
  assert.equal(json.from, '2026-10-01');
  assert.equal(json.to, '2026-10-31');
  assert.equal(json.opening, 750);
  assert.equal(json.closing, 1820);
  assert.equal(json.totalDebit, 1230);
  assert.equal(json.totalCredit, 2300);
  assert.deepEqual(Object.keys(json.lines[0]).sort(), ['attachmentsCount', 'balance', 'credit', 'date', 'debit', 'description', 'dueDate', 'id', 'kind', 'ref', 'supplierPaymentId', 'warehouseEntryId'].sort());
  assert.deepEqual({ ...json.lines[0], id: 'x' }, {
    id: 'x', date: '2026-10-01', kind: 'BILL', ref: 'INV-B2', description: null, debit: 0, credit: 2300, balance: 3050,
    dueDate: '2026-10-31', warehouseEntryId: 'B2', supplierPaymentId: null, attachmentsCount: 0,
  });
  assert.equal(json.lines[2].ref, 'SP-000002');
  assert.doesNotThrow(() => JSON.stringify(json));
});

// ═══ الفواتير المفتوحة ═══

test('الفواتير المفتوحة: الأقدم استحقاقاً أولاً، بالمدفوع والمرتجع والمتبقّي وأيام التأخير؛ والمسدَّدة والملغاة وفواتير الشركة الأخرى لا تظهر', async () => {
  const db = world();
  const rows = await loadOpenBills(db as never, T, 'V1', day('2026-11-05'));
  assert.deepEqual(rows.map((r) => [r.warehouseEntryId, r.totalMilli, r.paidMilli, r.returnedMilli, r.outstandingMilli, r.daysOverdue]), [
    ['B1', m(1150), m(400), 0n, m(750), 26],
    ['B2', m(2300), m(1000), m(230), m(1070), 5],
    ['B3', m(575), 0n, 0n, m(575), 0],
  ]);
  assert.deepEqual(openBillJson(rows[1]), {
    warehouseEntryId: 'B2', supplierRef: 'INV-B2', billDate: '2026-10-01', dueDate: '2026-10-31',
    total: 2300, paid: 1000, returned: 230, outstanding: 1070, daysOverdue: 5,
  });
  assert.deepEqual(await loadOpenBills(db as never, T, 'V3', day('2026-11-05')), [], 'الملغاة لا تظهر');
  assert.equal((await loadOpenBills(db as never, T, 'V2', day('2026-11-05')))[0].outstandingMilli, m(500), 'دفعتها الملغاة لا تُخصم');
});

// ═══ أعمار الذمم ═══

test('الأعمار اليوم: شرائح على الاستحقاق، والرصيد والفرق غير المخصَّص (المقدّمة سالبة)، والمؤرشف يظهر، ومن لا شيء عليه لا يظهر', async () => {
  const db = world();
  const a = await loadAging(db as never, T, day('2026-11-05'));
  assert.deepEqual(a.rows.map((r) => r.vendorId), ['V2', 'V1'], 'بالاسم: أ ثم ب؛ V3 (ملغاة) وV4 بلا شيء');
  const v1 = a.rows.find((r) => r.vendorId === 'V1')!;
  assert.deepEqual(v1.buckets, { current: m(575), d1_30: m(750 + 1070), d31_60: 0n, d61_90: 0n, d90_plus: 0n });
  assert.equal(v1.totalMilli, m(2395));
  assert.equal(v1.balanceMilli, m(2295));
  assert.equal(v1.unappliedMilli, -m(100), 'الدفعة المقدّمة');
  assert.equal(v1.openBillsCount, 3);
  const v2 = a.rows.find((r) => r.vendorId === 'V2')!;
  assert.equal(v2.isActive, false);
  assert.equal(v2.buckets.d61_90, m(500), '٦٥ يوماً بعد الاستحقاق');
  assert.equal(v2.unappliedMilli, 0n);
  assert.equal(a.totals.totalMilli, m(2895));
  assert.equal(a.totals.balanceMilli, m(2795));
  assert.equal(a.totals.unappliedMilli, -m(100));
  assert.equal(a.totals.totalMilli + a.totals.unappliedMilli, a.totals.balanceMilli, 'الأعمار تطابق الكشف بفرق صفر');
  const j = agingJson(a);
  assert.equal(j.asOf, '2026-11-05');
  assert.deepEqual(j.rows[1], { supplierId: 'V1', name: 'ب مورّد', code: 'S-1', isActive: true, current: 575, d1_30: 1820, d31_60: 0, d61_90: 0, d90_plus: 0, total: 2395, balance: 2295, unapplied: -100, openBillsCount: 3 });
  assert.deepEqual(j.totals, { current: 575, d1_30: 1820, d31_60: 0, d61_90: 2895 - 575 - 1820, d90_plus: 0, total: 2895, balance: 2795, unapplied: -100 });
});

test('الأعمار «حتى تاريخ» مضى: لا فاتورة ولا دفعة ولا مرتجع بعده، والدفعة الملغاة بعده سارية يومها، والفاتورة الملغاة بعده مفتوحة يومها', async () => {
  const db = world();
  const a = await loadAging(db as never, T, day('2026-10-10'));
  const v1 = a.rows.find((r) => r.vendorId === 'V1')!;
  // B1: 1150−400 = 750 (يوم الاستحقاق ⇒ current) · B2: 2300−230 (SP-2 في 10-15 لم تقع بعد) = 2070 · B3 لم تصدر
  assert.deepEqual(v1.buckets, { current: m(750 + 2070), d1_30: 0n, d31_60: 0n, d61_90: 0n, d90_plus: 0n });
  assert.equal(v1.balanceMilli, m(1150 - 400 + 2300 - 230));
  assert.equal(v1.unappliedMilli, 0n);
  assert.equal(a.rows.some((r) => r.vendorId === 'V2'), false, 'دفعة V2 كانت سارية يوم 10-10 (أُلغيت 10-20)');
  const v3 = a.rows.find((r) => r.vendorId === 'V3')!;
  assert.equal(v3.buckets.d1_30, m(300), 'BC3 أُلغيت 10-20: مفتوحة يوم 10-10 (٢٥ يوماً)');
  assert.equal(v3.balanceMilli, m(300));
  for (const r of a.rows) assert.equal(r.totalMilli + r.unappliedMilli, r.balanceMilli);
});

// ═══ الأرصدة ═══

test('loadSupplierBalances: الرصيد وعدد الفواتير المفتوحة لكل مورّد مطلوب (أصفار لمن لا حركة له)، بعزل الشركة', async () => {
  const db = world();
  const map = await loadSupplierBalances(db as never, T, ['V1', 'V2', 'V3', 'V4', 'V1']);
  assert.deepEqual([...map.keys()], ['V1', 'V2', 'V3', 'V4']);
  assert.deepEqual(map.get('V1'), { balanceMilli: m(2295), openBillsCount: 3, openBillsMilli: m(2395) });
  assert.deepEqual(map.get('V2'), { balanceMilli: m(500), openBillsCount: 1, openBillsMilli: m(500) });
  assert.deepEqual(map.get('V3'), { balanceMilli: 0n, openBillsCount: 0, openBillsMilli: 0n });
  assert.deepEqual(map.get('V4'), { balanceMilli: 0n, openBillsCount: 0, openBillsMilli: 0n });
  assert.equal((await loadSupplierBalances(db as never, T, [])).size, 0);
});

// ═══ لا N+1 ═══

test('لا N+1: عدد الاستعلامات ثابت مهما كثر الموردون والفواتير (الأرصدة والأعمار والفواتير المفتوحة والكشف)', async () => {
  const build = (vendors: number, billsPer: number) => {
    const db = new SupplierFakeDb();
    for (let v = 0; v < vendors; v++) {
      const vid = `V${v}`;
      db.seed('glVendor', { id: vid, tenantId: T, name: `مورّد ${v}` });
      for (let b = 0; b < billsPer; b++) {
        const id = `B${v}-${b}`;
        db.seed('warehouseEntry', { id, tenantId: T, type: 'RECEIVE', vendorId: vid, paymentMode: 'CREDIT', billDate: day('2026-10-01'), dueDate: day('2026-10-15'), totalMilli: m(100) });
        db.seed('supplierLedgerEntry', { tenantId: T, vendorId: vid, kind: 'BILL', amountMilli: m(100), warehouseEntryId: id, docDate: day('2026-10-01') });
        db.seed('supplierPayment', { id: `P${v}-${b}`, tenantId: T, vendorId: vid, number: v * 100 + b + 1, amountMilli: m(30), method: 'CASH', paidAt: day('2026-10-05'), status: b % 2 ? 'CANCELLED' : 'POSTED' });
        db.seed('supplierPaymentAllocation', { tenantId: T, paymentId: `P${v}-${b}`, warehouseEntryId: id, amountMilli: m(30) });
        db.seed('warehouseEntry', { id: `R${v}-${b}`, tenantId: T, type: 'RETURN', vendorId: vid, returnOfEntryId: id, totalMilli: m(10), billDate: day('2026-10-06') });
        db.seed('warehouseEntryAttachment', { tenantId: T, entryId: id, name: 'x.pdf' });
      }
    }
    return db;
  };
  const count = async (db: SupplierFakeDb, fn: () => Promise<unknown>) => { db.calls.length = 0; await fn(); return db.queryCount(); };
  const small = build(2, 2); // فيه دفعة ملغاة ومرتجع كالكبير — الفرق المقيس الحجم وحده
  const big = build(30, 6);
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `V${i}`);
  assert.equal(await count(big, () => loadSupplierBalances(big as never, T, ids(30))), await count(small, () => loadSupplierBalances(small as never, T, ids(2))));
  assert.equal(await count(big, () => loadAging(big as never, T, day('2026-11-05'))), await count(small, () => loadAging(small as never, T, day('2026-11-05'))));
  assert.equal(await count(big, () => loadOpenBills(big as never, T, 'V0', day('2026-11-05'))), await count(small, () => loadOpenBills(small as never, T, 'V0', day('2026-11-05'))));
  assert.equal(await count(big, () => loadSupplierStatement(big as never, T, 'V0', day('2026-10-01'))), await count(small, () => loadSupplierStatement(small as never, T, 'V0', day('2026-10-01'))));
  // والقيم صحيحة على العالم الكبير: كل فاتورة 100 − 30 (للسارية) − 10
  const bal = await loadSupplierBalances(big as never, T, ['V5']);
  assert.equal(bal.get('V5')!.openBillsMilli, m(3 * 60 + 3 * 90));
});

// ═══ settleBills (صرفة) ═══

test('settleBills: استردادٌ مربوط بالفاتورة نفسها يُطرح من مرتجعاتها ولا ينزل تحت الصفر، والملغاة بلا مرتجعات صفر، وما بعد asOf لا يُعاد', () => {
  const b = (id: string, o: Partial<SettlementBill> = {}): SettlementBill => ({
    id, vendorId: 'V1', type: 'RECEIVE', paymentMode: 'CREDIT', status: 'POSTED', supplierRef: null,
    billDate: day('2026-10-01'), dueDate: null, createdAt: new Date('2026-10-01T10:00:00Z'), totalMilli: m(100), ...o,
  });
  const out = settleBills(
    [b('A'), b('B', { status: 'CANCELLED' }), b('C', { billDate: day('2026-12-01') }), b('D', { totalMilli: null }), b('E', { billDate: null, createdAt: new Date('2026-10-03T22:00:00Z') })],
    [],
    [{ id: 'RA', returnOfEntryId: 'A', totalMilli: m(40), day: day('2026-10-02') }],
    [{ warehouseEntryId: 'A', amountMilli: m(25), day: day('2026-10-03') }, { warehouseEntryId: 'E', amountMilli: m(5), day: day('2026-10-03') }],
    day('2026-11-01'),
  );
  const by = new Map(out.map((s) => [s.bill.id, s]));
  assert.equal(by.get('A')!.returnedMilli, m(15));
  assert.equal(by.get('A')!.outstandingMilli, m(85));
  assert.equal(by.get('B')!.outstandingMilli, 0n);
  assert.equal(by.has('C'), false);
  assert.equal(by.get('D')!.outstandingMilli, 0n);
  assert.equal(by.get('E')!.outstandingMilli, m(100), 'استردادٌ بلا مرتجع لا يرفع المتبقّي فوق الإجمالي');
  assert.deepEqual(by.get('E')!.billDay, day('2026-10-03'), 'بلا billDate: يوم الكتابة');
  assert.deepEqual(by.get('A')!.dueDay, day('2026-10-01'), 'بلا dueDate: تاريخ الفاتورة');
});
