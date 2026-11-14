// «ربط الدفاتر» L2 (P4) — حقائق التشغيل loadOperationalFacts على قاعدة Prisma مزيّفة (linking-fake-db.ts) وعبر العميل الحارس:
// التقريب لكل مستند (1.005 + 2.005 + 3.125 بمنزلتين = 6150 لا 6140)، الذمم والافتتاح بمرآة computeDerivedOpening، العهدة
// بالمحمّل نفسه للمُرحِّل، الأمانات، الموردون (BigInt)، الوارد المسعَّر غير المصنَّف منذ بداية السنة، الصفحات بأي حجم = القراءة
// الواحدة، وبلا N+1؛ ثم التكامل مع المعاينة الحقيقية (R1 وR2 وR3 وR5 = OK وتفاصيلها).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrismaCheckStore } from '../services/gl/checks/store.prisma';
import { custodyComponentsForRep } from '../services/gl/custody';
import { zonedStartOfDay } from '../services/gl/dates';
import { toMilli } from '../services/gl/money';
import { computeDerivedOpening, openingCutoff, type OpeningAccountEntryRow } from '../services/gl/opening';
import { createShadowClient } from '../services/gl/linking/shadowClient';
import { createPreviewShadow } from '../services/gl/linking/shadowStore';
import { loadOperationalFacts, type OperationalFactsInput } from '../services/gl/linking/parity';
import type { OperationalFacts } from '../services/gl/linking/types';
import {
  FIX_DB_NOW, FIX_LINKED_FROM, FIX_T0, FIX_TZ, FakeDb, TenantFixture, buildLinkingScenario, previewOptionsFor,
} from './linking-fake-db';

const TID = 't1';
const at = (iso: string) => new Date(iso);
const INPUT: OperationalFactsInput = {
  snapshotAt: FIX_T0, dbNow: FIX_DB_NOW, linkedFrom: FIX_LINKED_FROM, cutoverStart: zonedStartOfDay(FIX_LINKED_FROM, FIX_TZ),
  timezone: FIX_TZ, currencyDecimals: 2,
};
/** بعد ساعة القاعدة: صفّ لم يُلتزم داخل اللقطة */
const AFTER_NOW = at('2027-06-15T09:30:00Z');

function newDb(): { db: FakeDb; f: TenantFixture } {
  const db = new FakeDb({ now: () => FIX_DB_NOW });
  const f = new TenantFixture(db);
  f.tenant({ accountingSuiteEnabled: true, warehouseEnabled: true });
  f.company();
  return { db, f };
}

let aeSeq = 0;
function ae(db: FakeDb, row: { customerId: string; type?: string; debit?: number; credit?: number; entryDate: Date; createdAt: Date; invoiceId?: string | null; receiptId?: string | null; id?: string }): string {
  const id = row.id ?? `ae-x${String(++aeSeq).padStart(5, '0')}`;
  db.seed('accountEntry', [{
    id, tenantId: TID, customerId: row.customerId, invoiceId: row.invoiceId ?? null, receiptId: row.receiptId ?? null,
    type: row.type ?? ((row.debit ?? 0) > 0 ? 'ADJUSTMENT_DEBIT' : 'ADJUSTMENT_CREDIT'), debit: row.debit ?? 0, credit: row.credit ?? 0,
    balance: 0, description: '', entryDate: row.entryDate, createdAt: row.createdAt,
  }]);
  return id;
}

let whSeq = 0;
function receiveEntry(db: FakeDb, opts: {
  createdAt: Date; type?: string; paymentMode?: string | null; source?: string; id?: string;
  items: { qty: number; unitCost: number | null; unitFactor?: number; baseQty?: number | null }[];
}): string {
  const id = opts.id ?? `we-x${String(++whSeq).padStart(4, '0')}`;
  db.seed('warehouseEntry', [{ id, tenantId: TID, type: opts.type ?? 'RECEIVE', paymentMode: opts.paymentMode ?? null, source: opts.source ?? 'MANUAL', createdAt: opts.createdAt }]);
  db.seed('warehouseEntryItem', opts.items.map((it, i) => ({
    id: `${id}-i${i}`, entryId: id, productId: 'prd-1', qty: it.qty, unitFactor: it.unitFactor ?? 1,
    baseQty: it.baseQty === undefined ? it.qty * (it.unitFactor ?? 1) : it.baseQty, unitCost: it.unitCost,
  })));
  return id;
}

/** صورة قابلة للمقارنة حرفياً (الخرائط مرتّبة بالمفتاح) */
function plain(f: OperationalFacts) {
  const m = <V>(x: ReadonlyMap<string, V>) => [...x].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    ar: m(f.arByCustomer), arOpening: m(f.arOpeningByCustomer), custody: m(f.custodyByRep), settlement: f.settlementBalanceMilli,
    supplier: m(f.supplierByVendor), grni: f.unclassifiedPricedReceiptsFyMilli,
    names: { customers: m(f.names.customers), reps: m(f.names.reps), vendors: m(f.names.vendors) },
  };
}

// ═══ التقريب لكل مستند ═══

test('التقريب لكل مستند: 1.005 + 2.005 + 3.125 بمنزلتين ⇒ 6150 ملّي (لا 6140) في الذمم والأمانات والوارد', async () => {
  const { db, f } = newDb();
  const c = f.customer('عميل الكسور');
  const t = at('2027-02-01T08:00:00Z');
  const parts = [1.005, 2.005, 3.125];
  parts.forEach((x, i) => ae(db, { customerId: c, debit: x, entryDate: t, createdAt: new Date(t.getTime() + i) }));
  parts.forEach((x, i) => db.seed('settlementEntry', [{ id: `se-r${i}`, tenantId: TID, kind: 'COLLECTED', amount: x, createdAt: new Date(t.getTime() + i) }]));
  receiveEntry(db, { createdAt: t, items: parts.map((x) => ({ qty: 1, unitCost: x })) });
  // المرجع المرفوض: جمع ثم تقريب
  assert.equal(toMilli(parts[0] + parts[1] + parts[2], 2), 6140n);

  const facts = await loadOperationalFacts(db.client as never, TID, INPUT);
  assert.equal(facts.arByCustomer.get(c), 6150n);
  assert.equal(facts.settlementBalanceMilli, 6150n);
  assert.equal(facts.unclassifiedPricedReceiptsFyMilli, 6150n);
  // والدائن بالقاعدة نفسها، وبثلاث منازل لا تقريب
  const d = newDb();
  const c3 = d.f.customer('دينار');
  parts.forEach((x, i) => ae(d.db, { customerId: c3, credit: x + 0.0004, entryDate: t, createdAt: new Date(t.getTime() + i) }));
  const f3 = await loadOperationalFacts(d.db.client as never, TID, { ...INPUT, currencyDecimals: 3 });
  assert.equal(f3.arByCustomer.get(c3), -6135n);
  assert.equal(db.writeCount(), 0);
});

test('منازل غير مدعومة ⇒ RangeError قبل أي قراءة', async () => {
  const { db } = newDb();
  const before = db.readCount();
  await assert.rejects(() => loadOperationalFacts(db.client as never, TID, { ...INPUT, currencyDecimals: 4 }), RangeError);
  await assert.rejects(() => loadOperationalFacts(db.client as never, TID, INPUT, { pageSize: 0 }), RangeError);
  assert.equal(db.readCount(), before);
});

// ═══ الذمم والافتتاح ═══

test('الذمم: كل الصفوف حتى dbNow لكل عميل، والافتتاح بمرآة computeDerivedOpening (إلغاء مستند مؤرّخ مستقبلاً يُسقط، المرتجع، المتأخر)', async () => {
  const { db, f } = newDb();
  const c1 = f.customer('عميل أول');
  const c2 = f.customer('عميل ثانٍ');
  const c3 = f.customer('عميل ثالث');
  const p = 'prd-1';
  // ما قبل البدء: آجل وسند ومرتجع ملغى واستيراد
  f.invoice({ type: 'CREDIT', customerId: c1, lines: [{ productId: p, qty: 10, unitPrice: 10.005 }], at: at('2026-12-10T08:00:00Z') });
  f.receipt({ customerId: c1, amount: 50.125, at: at('2026-12-12T08:00:00Z') });
  const ret = f.invoice({ type: 'RETURN', customerId: c1, lines: [{ productId: p, qty: 1, unitPrice: 9.995 }], at: at('2026-12-14T08:00:00Z') });
  f.cancelInvoice(ret, 'RETURN', c1, at('2026-12-16T08:00:00Z'));
  f.importEntry({ customerId: c3, debit: 33.335, entryDate: at('2026-11-30T08:00:00Z'), at: at('2026-11-30T08:00:00Z') });
  // مؤرّخ مستقبلاً (أثره بعد البدء) أُلغي قبل البدء ⇒ صفّ الإلغاء في النافذة يُسقط من الافتتاح
  const fut = f.invoice({ type: 'CREDIT', customerId: c2, lines: [{ productId: p, qty: 3, unitPrice: 20 }], at: at('2026-12-20T08:00:00Z'), entryDate: at('2027-01-05T08:00:00Z') });
  f.cancelInvoice(fut, 'CREDIT', c2, at('2026-12-22T08:00:00Z'));
  // السنة، والمتأخر (أثر قبل البدء وإنشاء بعد T0)، وصفّ بعد ساعة القاعدة
  f.invoice({ type: 'CASH', customerId: c2, lines: [{ productId: p, qty: 2, unitPrice: 33.33 }], at: at('2027-02-03T08:00:00Z') });
  f.invoice({ type: 'CREDIT', customerId: c2, lines: [{ productId: p, qty: 1, unitPrice: 9 }], at: at('2027-06-15T08:55:00Z'), entryDate: at('2026-12-28T08:00:00Z') });
  ae(db, { customerId: c3, debit: 1_000, entryDate: at('2027-06-15T09:20:00Z'), createdAt: AFTER_NOW });

  const facts = await loadOperationalFacts(db.client as never, TID, INPUT);

  // المتوقَّع الكامل: Σ toMilli لكل صفّ حتى dbNow
  const rows = db.rows('accountEntry').filter((r) => r.tenantId === TID && (r.createdAt as Date).getTime() <= FIX_DB_NOW.getTime());
  const full = new Map<string, bigint>();
  for (const r of rows) full.set(r.customerId as string, (full.get(r.customerId as string) ?? 0n) + toMilli(r.debit as number, 2) - toMilli(r.credit as number, 2));
  assert.deepEqual([...facts.arByCustomer].sort(), [...full].sort());
  assert.ok(!rows.some((r) => (r.debit as number) === 1_000));

  // الافتتاح = computeDerivedOpening على الصفوف نفسها
  const invType = new Map(db.rows('invoice').map((i) => [i.id as string, i.type as string]));
  const src: OpeningAccountEntryRow[] = rows.map((r) => ({
    id: r.id as string, customerId: r.customerId as string, invoiceId: (r.invoiceId as string) ?? null, receiptId: (r.receiptId as string) ?? null,
    type: r.type as string, debit: r.debit as number, credit: r.credit as number, entryDate: r.entryDate as Date, createdAt: r.createdAt as Date,
    invoiceType: r.invoiceId ? invType.get(r.invoiceId as string) ?? null : null,
  }));
  const derived = computeDerivedOpening(
    { accountEntries: src, receipts: [], cashInvoices: [], settlements: [], settlementEntries: [] },
    openingCutoff(FIX_LINKED_FROM, FIX_TZ, FIX_T0), { decimals: 2, routing: { receiptRouting: null, cashInvoiceRouting: 'MAIN_CASH' } },
  );
  const nonZero = [...facts.arOpeningByCustomer].filter(([, v]) => v !== 0n).sort();
  assert.deepEqual(nonZero, derived.receivables.map((r) => [r.customerId, r.balanceMilli] as [string, bigint]).sort());
  // بالأرقام: ع1 = 115.06 − 50.13 (المرتجع 11.49 وإلغاؤه يتصافيان)، ع3 = 33.34، وع2 بلا افتتاح (الإلغاء المُسقط والمتأخر)
  assert.equal(facts.arOpeningByCustomer.get(c1), 115_060n - 50_130n);
  assert.equal(facts.arOpeningByCustomer.get(c3), 33_340n);
  assert.equal(facts.arOpeningByCustomer.get(c2) ?? 0n, 0n);
  assert.equal(derived.counts.accountEntriesExcluded > 0, true);
  // الأسماء
  assert.equal(facts.names.customers.get(c1), 'عميل أول');
  assert.equal(facts.names.customers.get(c3), 'عميل ثالث');
});

test('الصفحات: أي حجم (1، 2، 3، 7، الافتراضي) = القراءة الواحدة حرفياً، مع تعادل createdAt بين الصفوف والحركات', async () => {
  const { db, f } = newDb();
  const cs = [f.customer('أ'), f.customer('ب'), f.customer('ج')];
  const same = at('2027-03-01T08:00:00Z');
  for (let i = 0; i < 9; i++) {
    // ثلاث مجموعات بـcreatedAt متطابق تماماً — الترتيب بالمعرّف داخلها
    const createdAt = new Date(same.getTime() + Math.floor(i / 3) * 1000);
    ae(db, { customerId: cs[i % 3], debit: 1.005 * (i + 1), entryDate: i < 3 ? at('2026-12-01T08:00:00Z') : createdAt, createdAt: i < 3 ? at('2026-12-01T08:00:00Z') : createdAt, id: `ae-p${8 - i}` });
    db.seed('settlementEntry', [{ id: `se-p${8 - i}`, tenantId: TID, kind: 'COLLECTED', amount: 0.335 * (i + 1), createdAt }]);
  }
  // وارد: حركتان بلحظة واحدة وأسطر متعددة
  receiveEntry(db, { id: 'we-b', createdAt: same, items: [{ qty: 1, unitCost: 1.115 }, { qty: 2, unitCost: 2.225 }, { qty: 3, unitCost: 3.335 }] });
  receiveEntry(db, { id: 'we-a', createdAt: same, items: [{ qty: 4, unitCost: 4.445 }, { qty: 5, unitCost: 0.105 }] });

  const one = plain(await loadOperationalFacts(db.client as never, TID, INPUT));
  for (const pageSize of [1, 2, 3, 7]) {
    assert.deepEqual(plain(await loadOperationalFacts(db.client as never, TID, INPUT, { pageSize })), one, `pageSize ${pageSize}`);
  }
  // الصفحات بالضبط: 9 صفوف بصفحة 2 ⇒ 5 قراءات
  const k = 'accountEntry.findMany';
  const before = db.readCount(k);
  await loadOperationalFacts(db.client as never, TID, INPUT, { pageSize: 2 });
  assert.equal(db.readCount(k) - before, 5);
  // قيمة الوارد: Σ toMilli(qty × unitCost) لكل سطر
  const lines = [[1, 1.115], [2, 2.225], [3, 3.335], [4, 4.445], [5, 0.105]];
  assert.equal(one.grni, lines.reduce((s, [q, c]) => s + toMilli(q * c, 2), 0n));
});

// ═══ الوارد غير المصنَّف ═══

test('الوارد المسعَّر غير المصنَّف منذ بداية السنة: RECEIVE بلا نمط دفع، مسعَّر بكمية موجبة، بلا المخزون الافتتاحي المستورد', async () => {
  const { db } = newDb();
  const fy = at('2027-02-10T08:00:00Z');
  receiveEntry(db, {
    createdAt: fy, items: [
      { qty: 2, unitCost: 10.005 }, // 20.01 ⇒ 20010
      { qty: 3, unitFactor: 24, unitCost: 240.5 }, // كرتون: قيمة السطر بوحدته 721.5 ⇒ 721500 (لا ×24)
      { qty: 4, unitCost: null }, // بلا سعر
      { qty: 4, unitCost: 0 },
      { qty: -1, unitCost: 5 }, // سالب قديم
    ],
  });
  receiveEntry(db, { createdAt: fy, paymentMode: 'CREDIT', items: [{ qty: 1, unitCost: 100 }] });
  receiveEntry(db, { createdAt: fy, paymentMode: 'CASH', items: [{ qty: 1, unitCost: 100 }] });
  receiveEntry(db, { createdAt: fy, source: 'OPENING_IMPORT', items: [{ qty: 1, unitCost: 100 }] });
  receiveEntry(db, { createdAt: fy, type: 'ADJUST', items: [{ qty: 1, unitCost: 100 }] });
  receiveEntry(db, { createdAt: fy, type: 'RETURN', items: [{ qty: -1, unitCost: 100 }] });
  receiveEntry(db, { createdAt: AFTER_NOW, items: [{ qty: 1, unitCost: 100 }] });
  // حدّ بداية السنة بتوقيت الرياض: 2027-01-01 00:00 = 2026-12-31T21:00Z — شامل، وما قبله بلحظة خارج
  const start = zonedStartOfDay(FIX_LINKED_FROM, FIX_TZ);
  assert.equal(start.toISOString(), '2026-12-31T21:00:00.000Z');
  receiveEntry(db, { createdAt: start, items: [{ qty: 1, unitCost: 7 }] });
  receiveEntry(db, { createdAt: new Date(start.getTime() - 1), items: [{ qty: 1, unitCost: 100 }] });

  const facts = await loadOperationalFacts(db.client as never, TID, INPUT);
  assert.equal(facts.unclassifiedPricedReceiptsFyMilli, 20_010n + 721_500n + 7_000n);
});

// ═══ الموردون ═══

test('الموردون: Σ amountMilli (BigInt) لكل مورّد حتى dbNow، وأسماؤهم من سجلّ الموردين عبر الكشف — والعميل الحارس لا يعترض', async () => {
  const { db } = newDb();
  db.seed('glVendor', [{ id: 'v1', tenantId: TID, name: 'مورّد الأسمنت' }, { id: 'v2', tenantId: TID, name: 'مورّد الحديد' }]);
  const doc = at('2027-02-01T00:00:00Z');
  db.seed('supplierLedgerEntry', [
    { id: 'sl-1', tenantId: TID, vendorId: 'v1', kind: 'BILL', amountMilli: 1_150_005n, docDate: doc, createdAt: at('2027-02-01T08:00:00Z') },
    { id: 'sl-2', tenantId: TID, vendorId: 'v1', kind: 'PAYMENT', amountMilli: -500_000n, docDate: doc, createdAt: at('2027-02-02T08:00:00Z') },
    { id: 'sl-3', tenantId: TID, vendorId: 'v2', kind: 'OPENING', amountMilli: 77_777n, docDate: doc, createdAt: at('2027-01-01T08:00:00Z') },
    { id: 'sl-4', tenantId: TID, vendorId: 'v1', kind: 'BILL', amountMilli: 999_000n, docDate: doc, createdAt: AFTER_NOW },
    { id: 'sl-5', tenantId: 'other', vendorId: 'v9', kind: 'BILL', amountMilli: 5n, docDate: doc, createdAt: doc },
  ]);
  const built = createPreviewShadow(TID, previewOptionsFor(), FIX_DB_NOW);
  const client = createShadowClient(db.client as never, built.shadow);
  const facts = await loadOperationalFacts(client, TID, INPUT);
  assert.deepEqual([...facts.supplierByVendor].sort(), [['v1', 650_005n], ['v2', 77_777n]]);
  assert.deepEqual([...facts.names.vendors].sort(), [['v1', 'مورّد الأسمنت'], ['v2', 'مورّد الحديد']]);
  assert.deepEqual(built.shadow.glViolations, []);
});

// ═══ العهدة ═══

test('العهدة: المحمّل نفسه للمُرحِّل عبر العميل الحارس (توجيه الربط الافتراضي)، للمناديب ذوي الأثر وحدهم، بلا وصول gl* من القاعدة', async () => {
  const { db, f } = newDb();
  const c1 = f.customer('عميل أول');
  const r1 = f.rep('مندوب أول');
  const r2 = f.rep('مندوب بلا حركة');
  const r3 = f.rep('مندوب نقدي');
  f.receipt({ customerId: c1, repId: r1, amount: 25, at: at('2026-12-15T08:00:00Z') });
  f.receipt({ customerId: c1, repId: r1, amount: 40.005, at: at('2027-03-05T08:00:00Z') });
  f.receipt({ customerId: c1, repId: r1, amount: 12, method: 'BANK_TRANSFER', at: at('2027-03-06T08:00:00Z') });
  f.settlement({ repId: r1, amount: 40, at: at('2027-03-20T08:00:00Z') });
  f.invoice({ type: 'CASH', customerId: c1, repId: r3, lines: [{ productId: 'prd-1', qty: 1, unitPrice: 10 }], at: at('2027-02-01T08:00:00Z') });
  db.seed('repSettlement', [{ id: 'st-orphan', tenantId: TID, salesRepId: null, deletedSalesRepId: 'gone', amount: 9, settledAt: at('2027-02-01T08:00:00Z'), createdAt: at('2027-02-01T08:00:00Z') }]);

  const built = createPreviewShadow(TID, previewOptionsFor(), FIX_DB_NOW);
  const client = createShadowClient(db.client as never, built.shadow);
  const receiptReads = db.readCount('receipt.findMany');
  const entryReads = db.readCount('accountEntry.findMany');
  const facts = await loadOperationalFacts(client, TID, INPUT);

  // لا مندوب بلا أثر ولا مندوب محذوف (الاستلام اليتيم بلا مندوب لا يمسّ عهدة أحد)
  assert.deepEqual([...facts.custodyByRep.keys()].sort(), [r1, r3].sort());
  // لا N+1: سندات المناديب تُقرأ مسحاً واحداً (صفحة) وقيود الإلغاء من مسح الذمم نفسه — المحمّل لكل مندوب لا يصل القاعدة بهما
  assert.equal(db.readCount('receipt.findMany') - receiptReads, 1, 'مسحٌ واحد للسندات');
  assert.equal(db.readCount('accountEntry.findMany') - entryReads, 1, 'مسح الذمم وحده');
  // مطابق للمحمّل القائم حرفياً
  const store = createPrismaCheckStore(client, { custodyWindow: false }); // المرجع بمحمّل المعاينة نفسه (الطيّ الكامل — نافذة العهدة تقرأ gl_* الحقيقية)
  for (const rep of [r1, r3]) {
    const c = custodyComponentsForRep(await store.custodyInputs(TID, rep), rep);
    assert.deepEqual(facts.custodyByRep.get(rep), { ledgerCustodyMilli: c.ledgerCustody, opsOutstandingMilli: c.opsOutstanding });
  }
  // بالأرقام: النقد (25 + 40.01) عهدة، والتحويل مباشر (LINKED_DEFAULT_RECEIPT_ROUTING)، والاستلام 40 من العهدة
  assert.equal(facts.custodyByRep.get(r1)!.ledgerCustodyMilli, 25_000n + 40_010n - 40_000n);
  assert.equal(facts.custodyByRep.get(r1)!.opsOutstandingMilli, 25_000n + 40_010n + 12_000n - 40_000n);
  // الفاتورة النقدية بتوجيه MAIN_CASH خارج العهدة
  assert.equal(facts.custodyByRep.get(r3)!.ledgerCustodyMilli, 0n);
  assert.equal(facts.names.reps.get(r2), 'مندوب بلا حركة');
  // الحارس: لا مخالفة، ولا قراءة gl* من القاعدة (الإعدادات وأحداث الاستلام من الظلّ)
  assert.deepEqual(built.shadow.glViolations, []);
  assert.deepEqual([...db.stats.reads.keys()].filter((k) => k.startsWith('gl')), []);
  assert.equal(db.writeCount(), 0);
});

test('العهدة بلا N+1: عشرون مندوباً بسندات وفواتير نقدية وإلغاءات ⇒ القراءات لا تتبع عدد المناديب، والنتيجة = المحمّل لكل مندوب حرفياً', async () => {
  const { db, f } = newDb();
  const c = f.customer('عميل');
  const reps = Array.from({ length: 20 }, (_, i) => f.rep(`مندوب ${i}`));
  reps.forEach((r, i) => {
    const t = at(`2027-02-${String(1 + (i % 27)).padStart(2, '0')}T08:00:00Z`);
    const a = f.receipt({ customerId: c, repId: r, amount: 10 + i + 0.005, at: t });
    f.receipt({ customerId: c, repId: r, amount: 3, method: 'BANK_TRANSFER', at: new Date(t.getTime() + 1000) });
    if (i % 3 === 0) f.cancelReceipt(a, c, 10 + i + 0.005, at('2027-03-01T08:00:00Z'));
    const inv = f.invoice({ type: 'CASH', customerId: c, repId: r, lines: [{ productId: 'prd-1', qty: 1, unitPrice: 5 + i }], at: new Date(t.getTime() + 2000) });
    if (i % 5 === 0) f.cancelInvoice(inv, 'CASH', c, at('2027-03-02T08:00:00Z'));
    if (i % 4 === 0) f.settlement({ repId: r, amount: 5, at: at('2027-03-10T08:00:00Z') });
  });
  const built = createPreviewShadow(TID, previewOptionsFor(), FIX_DB_NOW);
  const client = createShadowClient(db.client as never, built.shadow);
  const before = { r: db.readCount('receipt.findMany'), e: db.readCount('accountEntry.findMany'), i: db.readCount('invoice.findMany') };
  const facts = await loadOperationalFacts(client, TID, INPUT);
  assert.equal(facts.custodyByRep.size, 20);
  assert.equal(db.readCount('receipt.findMany') - before.r, 1);
  assert.equal(db.readCount('accountEntry.findMany') - before.e, 1);
  // الفواتير: مسح النقدية بمندوب (صفحة) + أنواع فواتير الافتتاح + محمّل كل مندوب (مفهرسة: tenantId, salesRepId)
  assert.ok(db.readCount('invoice.findMany') - before.i <= 2 + 20);
  // المحمّل الأصلي بلا تجميع (العميل الحارس مباشرةً) لكل مندوب = ما حُسب
  const store = createPrismaCheckStore(client, { custodyWindow: false }); // المرجع بمحمّل المعاينة نفسه (الطيّ الكامل — نافذة العهدة تقرأ gl_* الحقيقية)
  for (const rep of reps) {
    const cc = custodyComponentsForRep(await store.custodyInputs(TID, rep), rep);
    assert.deepEqual(facts.custodyByRep.get(rep), { ledgerCustodyMilli: cc.ledgerCustody, opsOutstandingMilli: cc.opsOutstanding }, rep);
  }
  assert.deepEqual(built.shadow.glViolations, []);
  assert.equal(db.writeCount(), 0);
});

// ═══ الأمانات ═══

test('الأمانات: Σ toMilli لكل صفّ حتى dbNow (التحصيل والعمولة والاسترداد والتوريد) لهذه الشركة وحدها', async () => {
  const { db, f } = newDb();
  const c = f.customer('عميل');
  const online = f.receipt({ customerId: c, amount: 76.665, method: 'ONLINE', at: at('2027-03-10T08:00:00Z'), invoiceId: 'inv-x' });
  f.fee(online.linkId!, 2.305, at('2027-03-10T09:00:00Z'));
  f.payout(50, at('2027-04-01T08:00:00Z'));
  db.seed('settlementEntry', [
    { id: 'se-late', tenantId: TID, kind: 'COLLECTED', amount: 1_000, createdAt: AFTER_NOW },
    { id: 'se-other', tenantId: 'other', kind: 'COLLECTED', amount: 1_000, createdAt: at('2027-03-10T08:00:00Z') },
  ]);
  const facts = await loadOperationalFacts(db.client as never, TID, INPUT);
  assert.equal(facts.settlementBalanceMilli, toMilli(76.665, 2) + toMilli(-2.305, 2) + toMilli(-50, 2));
  assert.equal(facts.settlementBalanceMilli, 76_670n - 2_310n - 50_000n);
});

// ═══ التكامل مع المعاينة الحقيقية ═══

test('تكامل: المعاينة الحقيقية على سيناريو السنة ⇒ R1 وR2 وR3 وR5 = OK بتفاصيلها، وR8 ربط افتتاحه OK، وR9 = fyCogs', async () => {
  const { runPreview, defaultPreviewDeps } = await import('../services/gl/linking/preview');
  const s = buildLinkingScenario();
  const r = await runPreview(s.db.client as never, TID, previewOptionsFor({ manualRows: [{ accountCode: '111001', debit: 1000 }] }), {}, defaultPreviewDeps);
  const by = new Map(r.parity.map((p) => [p.code, p]));
  for (const code of ['R1', 'R2', 'R3', 'R5'] as const) assert.equal(by.get(code)!.status, 'OK', code);
  const r1 = by.get('R1')!;
  // الاستيراد بعد البدء 120 معلَّم على 319002، وفرق الافتتاح = −سطر 319002 في القيد الافتتاحي
  assert.equal(r1.info!.importAfterCutoverMilli, '-120000');
  assert.equal(r1.info!.otherMilli, '0');
  assert.equal(r1.info!.unbalancedMoves, 0);
  const r2 = by.get('R2')!;
  assert.equal(r2.info!.openingMismatches, 0);
  assert.equal(r2.drill.find((d) => d.partnerId === s.c1)!.name, 'عميل أول');
  // الأمانات: 76.66 − 2.30 + 30 − 30 − 50
  assert.equal(by.get('R5')!.expectedMilli, 24_360n);
  assert.equal(by.get('R3')!.info!.reps, 1);
  const r8 = by.get('R8')!;
  assert.equal(r8.status, 'NOT_AVAILABLE');
  assert.equal(r8.info!.openingTie, 'OK');
  assert.ok(r8.drill.some((d) => d.partnerId === 'WH' && d.name === 'المستودع'));
  assert.equal(by.get('R9')!.expectedMilli, r.costing.summary.fyCogsMilli);
  // وارد يناير المسعَّر بلا نمط دفع (50 × 6) ⇒ دائن 211002 متوقَّعاً
  assert.equal(by.get('R11')!.expectedMilli, -300_000n);
  assert.equal(s.db.writeCount(), 0);
});
