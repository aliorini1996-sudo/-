// «ربط الدفاتر» L0/L1 — محرّك الحذف (services/ownerPurge.ts):
//   • جداول الدفاتر (كل Gl* من نموذج Prisma) وكشف المورّد وتخصيصاته وسجلّ «إعادة المرتجع» لا تُستهدف لأي شركة.
//   • الشركة المربوطة: حذف مستندٍ مرحَّل أو تفريغ مفتاحٍ فيه ⇒ PurgeRefused 409 BOOKS_LINKED_NO_DELETE قبل أي كتابة.
//   • الشركة اليدوية: حذف وارد المستودع يحذف قيود مورّده وتخصيصات الدفعات عليه وسنده الآلي ومرتجعاته، وحذف سند الصرف يحذف
//     قيوده وتخصيصاته — على قاعدةٍ في الذاكرة **تفرض المفاتيح الأجنبية كما في المخطط** (Cascade/SetNull/NoAction/Restrict)،
//     فأي ترتيبٍ خاطئ أو تابعٍ منسيّ ينفجر هنا كما ينفجر في PostgreSQL.
// اختبارات النماذج الجديدة تحتاج عميل Prisma مولَّداً من المخطط الحالي (prisma generate)؛ مع عميلٍ قديم تُتخطّى بسببٍ ظاهر.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import {
  LINKED_POSTED_SOURCES, PurgeRefused, assertPurgeAllowedForBooks, buildPurgePlan, deletionOrder, isLedgerModel, linkedPurgeConflicts,
  purgeInTx, targetableModels,
} from '../services/ownerPurge';
import { LINKED_NO_DELETE_CODE, LINKED_NO_DELETE_MESSAGE } from '../services/booksMode';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const MODELS = Prisma.dmmf.datamodel.models;
const hasModel = (n: string): boolean => MODELS.some((m) => m.name === n);
const STALE = !hasModel('SupplierLedgerEntry') || !hasModel('SupplierPaymentAllocation');
const SKIP = STALE ? 'عميل Prisma المثبَّت قديم (لا يرى نماذج «ربط الدفاتر») — شغّل prisma generate' : false;

// ═══ قاعدة في الذاكرة تفرض المفاتيح الأجنبية من نموذج Prisma ═══

const delegateOf = (m: string): string => m.charAt(0).toLowerCase() + m.slice(1);
const modelOfDelegate = new Map(MODELS.map((m) => [delegateOf(m.name), m.name]));

interface Rel { child: string; fk: string; parent: string; ref: string; onDelete: string; relationName: string }
const RELS: Rel[] = [];
for (const m of MODELS) {
  for (const f of m.fields) {
    if (f.kind !== 'object' || !f.relationFromFields?.length) continue;
    if (f.relationFromFields.length !== 1) continue;
    const fkField = m.fields.find((x) => x.name === f.relationFromFields![0]);
    // افتراض Prisma حين لا onDelete: الإلزامي Restrict والاختياري SetNull
    const onDelete = (f as { relationOnDelete?: string }).relationOnDelete ?? (fkField?.isRequired ? 'Restrict' : 'SetNull');
    RELS.push({ child: m.name, fk: f.relationFromFields[0], parent: f.type, ref: f.relationToFields![0], onDelete, relationName: f.relationName ?? '' });
  }
}

class FkError extends Error { code = 'P2003'; }

function fkDb(seed: Record<string, Row[]>) {
  const tables = new Map<string, Row[]>();
  for (const [model, rows] of Object.entries(seed)) tables.set(model, rows.map((r) => ({ ...r })));
  const table = (model: string): Row[] => { let t = tables.get(model); if (!t) { t = []; tables.set(model, t); } return t; };
  const writes: string[] = [];

  const match = (model: string, row: Row, where: Row = {}): boolean => Object.entries(where).every(([k, v]) => {
    if (v === null) return row[k] == null;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('not' in v) return v.not === null ? row[k] != null : row[k] !== v.not;
      if ('none' in v) {
        // relation list filter (items: { none: {} }) — no child references this row through that list
        const field = MODELS.find((m) => m.name === model)!.fields.find((f) => f.name === k)!;
        const rel = RELS.find((r) => r.parent === model && r.child === field.type && r.relationName === field.relationName)!;
        return !table(rel.child).some((c) => c[rel.fk] === row[rel.ref]);
      }
      throw new Error(`fake: unsupported filter ${model}.${k}`);
    }
    return row[k] === v;
  });
  const pick = (row: Row, select?: Row): Row => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null])) : { ...row });

  /** حذف كما في PostgreSQL: التعاقب ثم SetNull، والمفتاح NoAction/Restrict الباقي في نهاية العبارة ⇒ P2003 */
  function deleteRows(model: string, rows: Row[]): number {
    const doomed = new Map<string, Set<Row>>();
    const queue: Array<[string, Row[]]> = [[model, rows]];
    while (queue.length) {
      const [m, rs] = queue.shift()!;
      let set = doomed.get(m);
      if (!set) { set = new Set(); doomed.set(m, set); }
      const fresh = rs.filter((r) => !set!.has(r));
      fresh.forEach((r) => set!.add(r));
      for (const rel of RELS.filter((x) => x.parent === m && x.onDelete === 'Cascade')) {
        const keys = new Set(fresh.map((r) => r[rel.ref]));
        queue.push([rel.child, table(rel.child).filter((c) => keys.has(c[rel.fk]))]);
      }
    }
    for (const [m, set] of doomed) tables.set(m, table(m).filter((r) => !set.has(r)));
    for (const [m, set] of doomed) {
      const keysOf = (ref: string) => new Set([...set].map((r) => r[ref]));
      for (const rel of RELS.filter((x) => x.parent === m)) {
        const keys = keysOf(rel.ref);
        const refs = table(rel.child).filter((c) => c[rel.fk] != null && keys.has(c[rel.fk]));
        if (!refs.length) continue;
        if (rel.onDelete === 'SetNull') { refs.forEach((c) => { c[rel.fk] = null; }); continue; }
        throw new FkError(`P2003: ${rel.child}.${rel.fk} → ${rel.parent} (${rel.onDelete}) still referenced`);
      }
    }
    return rows.length;
  }

  const client: Row = new Proxy({}, {
    get(_t, name: string) {
      if (name === 'then') return undefined;
      const model = modelOfDelegate.get(name);
      assert.ok(model, `fake: unknown delegate ${name}`);
      return {
        findMany: async (a: Row = {}) => table(model).filter((r) => match(model, r, a.where)).map((r) => pick(r, a.select)),
        findUnique: async (a: Row = {}) => { const r = table(model).find((x) => match(model, x, a.where)); return r ? pick(r, a.select) : null; },
        findFirst: async (a: Row = {}) => { const r = table(model).find((x) => match(model, x, a.where)); return r ? pick(r, a.select) : null; },
        count: async (a: Row = {}) => table(model).filter((r) => match(model, r, a.where)).length,
        updateMany: async (a: Row) => {
          writes.push(`${name}.updateMany`);
          const rs = table(model).filter((r) => match(model, r, a.where));
          rs.forEach((r) => Object.assign(r, a.data));
          return { count: rs.length };
        },
        deleteMany: async (a: Row) => {
          writes.push(`${name}.deleteMany`);
          return { count: deleteRows(model, table(model).filter((r) => match(model, r, a.where))) };
        },
      };
    },
  });
  const ids = (model: string): string[] => table(model).map((r) => String(r.id)).sort();
  return { client, tables, ids, writes, row: (model: string, id: string) => table(model).find((r) => r.id === id) };
}

const T = 't1';
const MANUAL_BOOKS = { tenantId: T, setupMethod: 'CLEAN', activatedAt: new Date('2026-01-01T00:00:00Z') };
const LINKED_BOOKS = { tenantId: T, setupMethod: 'LINKED', activatedAt: new Date('2026-11-01T00:00:00Z') };
const day = new Date('2026-11-10T00:00:00Z');

/**
 * عالم المورّد: W1 فاتورة آجلة (بند ومرفق وقيد BILL) ومرتجعها W2 (بند وقيد RETURN)، وسند صرف عادي P1 مخصَّص على W1 وعلى W3
 * (فاتورة أخرى باقية)، وW4 استلام نقدي بسنده الآلي P2 (تخصيص وقيد PAYMENT ثم ألغي: PAYMENT_REV)، وW5 تسوية بلا مورّد
 */
function supplierWorld(books: Row | null) {
  const L = (id: string, kind: string, amount: bigint, wid: string | null, pid: string | null) =>
    ({ id, tenantId: T, vendorId: 'v1', kind, amountMilli: amount, warehouseEntryId: wid, supplierPaymentId: pid, docDate: day });
  const W = (id: string, extra: Row = {}) => ({ id, tenantId: T, type: 'RECEIVE', vendorId: 'v1', status: 'POSTED', returnOfEntryId: null, ...extra });
  return fkDb({
    GlSettings: books ? [books] : [],
    GlVendor: [{ id: 'v1', tenantId: T, name: 'مورّد' }],
    Product: [{ id: 'p1', tenantId: T, name: 'شاي', unit: 'حبة' }, { id: 'p2', tenantId: T, name: 'سكر', unit: 'كيس' }],
    WarehouseEntry: [
      W('W1', { paymentMode: 'CREDIT', totalMilli: 115000n }),
      W('W2', { type: 'RETURN', returnOfEntryId: 'W1', totalMilli: 23000n }),
      W('W3', { paymentMode: 'CREDIT', totalMilli: 50000n }),
      W('W4', { paymentMode: 'CASH', totalMilli: 46000n }),
      W('W5', { type: 'ADJUST', vendorId: null }),
    ],
    WarehouseEntryItem: [
      { id: 'wi1', entryId: 'W1', productId: 'p1', qty: 10 }, { id: 'wi2', entryId: 'W2', productId: 'p1', qty: -2 },
      { id: 'wi3', entryId: 'W3', productId: 'p1', qty: 5 }, { id: 'wi4', entryId: 'W4', productId: 'p2', qty: 4 },
      { id: 'wi5', entryId: 'W5', productId: 'p1', qty: -1 },
    ],
    WarehouseEntryAttachment: [{ id: 'wa1', tenantId: T, entryId: 'W1', name: 'فاتورة.pdf' }],
    SupplierPayment: [
      { id: 'P1', tenantId: T, vendorId: 'v1', number: 1, amountMilli: 50000n, method: 'CASH', status: 'POSTED', autoForEntryId: null },
      { id: 'P2', tenantId: T, vendorId: 'v1', number: 2, amountMilli: 46000n, method: 'CASH', status: 'CANCELLED', autoForEntryId: 'W4' },
    ],
    SupplierPaymentAllocation: [
      { id: 'A1', tenantId: T, paymentId: 'P1', warehouseEntryId: 'W1', amountMilli: 30000n },
      { id: 'A2', tenantId: T, paymentId: 'P1', warehouseEntryId: 'W3', amountMilli: 20000n },
      { id: 'A3', tenantId: T, paymentId: 'P2', warehouseEntryId: 'W4', amountMilli: 46000n },
    ],
    SupplierLedgerEntry: [
      L('L1', 'BILL', 115000n, 'W1', null), L('L2', 'RETURN', -23000n, 'W2', null), L('L3', 'PAYMENT', -50000n, null, 'P1'),
      L('L4', 'BILL', 50000n, 'W3', null), L('L5', 'BILL', 46000n, 'W4', null), L('L6', 'PAYMENT', -46000n, null, 'P2'),
      L('L7', 'PAYMENT_REV', 46000n, null, 'P2'), L('L8', 'OPENING', 7000n, null, null),
    ],
  });
}

// ═══ لا استهداف لجداول الدفاتر وسجلّات المورّد ═══

test('NOT_TARGETABLE: كل Gl* في نموذج Prisma وفي schema.prisma، وكشف المورّد وتخصيصاته وسجلّ إعادة المرتجع — لكل الشركات', async () => {
  const t = new Set(targetableModels());
  const ledgerInDmmf = MODELS.map((m) => m.name).filter(isLedgerModel);
  assert.ok(ledgerInDmmf.length > 10, 'Gl* مشتقّة من النموذج');
  for (const m of ledgerInDmmf) assert.ok(!t.has(m), `${m} قابل للاستهداف`);
  // من المخطط نفسه: نموذج Gl* جديد يُضاف لاحقاً لا يفلت (مع عميلٍ مولَّد)
  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
  const ledgerInSchema = [...schema.matchAll(/^model (Gl[A-Z]\w*) \{/gm)].map((x) => x[1]);
  assert.ok(ledgerInSchema.includes('GlVendor') && ledgerInSchema.includes('GlMove'));
  for (const m of ledgerInSchema) assert.ok(!t.has(m), `${m} من المخطط قابل للاستهداف`);
  for (const m of ['SupplierLedgerEntry', 'SupplierPaymentAllocation', 'InvoiceRestockLog', 'Tenant']) assert.ok(!t.has(m), m);
  // المستندات التشغيلية باقية قابلة للاستهداف (الحذف النهائي للمالك كما كان)
  for (const m of ['Invoice', 'Receipt', 'VanLoad', 'WarehouseEntry', 'Customer', 'Product', 'SalesRep']) assert.ok(t.has(m), m);
  if (!STALE) assert.ok(t.has('SupplierPayment'), 'سند الصرف يُستهدف (والمربوطة تُرفض بحارسها)');
  // والاستهداف المباشر يُرفض 404 «نوع غير معروف» كما كان لغير المعروف
  const db = fkDb({});
  for (const m of ['GlMove', 'GlVendor', ...(STALE ? [] : ['SupplierLedgerEntry', 'SupplierPaymentAllocation', 'InvoiceRestockLog'])]) {
    await assert.rejects(buildPurgePlan(db.client as never, T, m, 'x'), (e: unknown) => e instanceof PurgeRefused && e.status === 404 && /غير معروف/.test(e.message), m);
  }
});

test('PurgeRefused: الرفض القديم 404 بلا رمز (المسار كما كان)، ورفض المربوطة يحمل 409 والرمز والنماذج', () => {
  const old = new PurgeRefused('السجل غير موجود في هذه الشركة');
  assert.deepEqual([old.status, old.code, old.models, old.message], [404, null, [], 'السجل غير موجود في هذه الشركة']);
  assert.ok(old instanceof Error && old instanceof PurgeRefused);
  const linked = new PurgeRefused(LINKED_NO_DELETE_MESSAGE, { status: 409, code: LINKED_NO_DELETE_CODE, models: ['Invoice'] });
  assert.deepEqual([linked.status, linked.code, linked.models], [409, 'BOOKS_LINKED_NO_DELETE', ['Invoice']]);
});

// ═══ الحارس النقيّ وقراءة وضع الدفاتر ═══

test('linkedPurgeConflicts: الحذف أو التفريغ في مستندٍ مرحَّل أو في جداول الدفاتر — مرتّباً بلا تكرار، وغيره لا شيء', () => {
  assert.deepEqual(linkedPurgeConflicts({ counts: { Customer: 1, CustomerPrice: 3, Notification: 2 }, nullCounts: {} }), []);
  assert.deepEqual(linkedPurgeConflicts({ counts: { SalesLocation: 1 }, nullCounts: { VanLoad: 4, Invoice: 2 } }), ['Invoice', 'VanLoad']);
  assert.deepEqual(linkedPurgeConflicts({ counts: { Product: 1, WarehouseEntryItem: 2, GlProductCategoryAccount: 1 }, nullCounts: { InvoiceItem: 5 } }),
    ['GlProductCategoryAccount', 'InvoiceItem', 'WarehouseEntryItem']);
  assert.deepEqual(linkedPurgeConflicts({ counts: { WarehouseEntry: 1, SupplierLedgerEntry: 2 }, nullCounts: { WarehouseEntry: 1 } }), ['SupplierLedgerEntry', 'WarehouseEntry']);
  // مصادر المُطابِق وكشف المورّد كلها في القائمة
  for (const m of ['Invoice', 'Receipt', 'AccountEntry', 'RepSettlement', 'UserSettlement', 'SettlementEntry', 'WarehouseEntry', 'VanLoad',
    'SupplierLedgerEntry', 'SupplierPayment', 'SupplierPaymentAllocation', 'InvoiceRestockLog']) assert.ok(LINKED_POSTED_SOURCES.has(m), m);
  for (const m of ['Customer', 'Product', 'SalesRep', 'SalesLocation']) assert.ok(!LINKED_POSTED_SOURCES.has(m), m);
});

test('assertPurgeAllowedForBooks: بلا تعارض لا يقرأ الوضع؛ اليدوية وغير المفعّلة تمرّ؛ المربوطة المفعّلة ⇒ 409 بالرسالة والنماذج', async () => {
  let reads = 0;
  const db = (s: Row | null) => ({ glSettings: { findUnique: async (a: Row) => { reads++; assert.deepEqual(a, { where: { tenantId: T }, select: { setupMethod: true, activatedAt: true } }); return s; } } });
  const posted = { counts: { Invoice: 1, InvoiceItem: 2 }, nullCounts: {} };
  await assertPurgeAllowedForBooks(db(LINKED_BOOKS), T, { counts: { Customer: 1 }, nullCounts: {} });
  assert.equal(reads, 0, 'خطة بلا مرحَّل لا تقرأ gl_settings');
  for (const s of [null, MANUAL_BOOKS, { ...LINKED_BOOKS, activatedAt: null }, { tenantId: T, setupMethod: 'OPENING', activatedAt: day }]) {
    await assertPurgeAllowedForBooks(db(s), T, posted);
  }
  assert.equal(reads, 4);
  await assert.rejects(assertPurgeAllowedForBooks(db(LINKED_BOOKS), T, posted), (e: unknown) => e instanceof PurgeRefused
    && e.status === 409 && e.code === LINKED_NO_DELETE_CODE && e.message === LINKED_NO_DELETE_MESSAGE && e.models.join() === 'Invoice,InvoiceItem');
});

// ═══ توابع المورّد في الشركة اليدوية — على قاعدةٍ تفرض المفاتيح ═══

test('اليدوية: حذف الوارد الآجل يحذف بنوده ومرفقه وقيد BILL وتخصيص السند عليه ومرتجعه بقيده — والسند العادي يبقى دفعةً مقدّمة', { skip: SKIP }, async () => {
  const w = supplierWorld(MANUAL_BOOKS);
  const plan = await buildPurgePlan(w.client as never, T, 'WarehouseEntry', 'W1');
  assert.deepEqual(plan.counts, {
    WarehouseEntry: 2, WarehouseEntryItem: 2, WarehouseEntryAttachment: 1, SupplierLedgerEntry: 2, SupplierPaymentAllocation: 1,
  });
  assert.deepEqual(plan.nullCounts, {}, 'لا قيد مورّد يُفرَّغ مفتاحه فيبقى بلا مستنده');
  const order = deletionOrder(plan);
  for (const child of ['SupplierLedgerEntry', 'SupplierPaymentAllocation', 'WarehouseEntryItem']) {
    assert.ok(order.indexOf(child) < order.indexOf('WarehouseEntry'), `${child} قبل الحركة`);
  }
  const r = await purgeInTx(w.client as never, T, 'WarehouseEntry', ['W1']);
  assert.equal(r.counts.WarehouseEntry, 2);
  assert.deepEqual(w.ids('WarehouseEntry'), ['W3', 'W4', 'W5']);
  assert.deepEqual(w.ids('WarehouseEntryItem'), ['wi3', 'wi4', 'wi5']);
  assert.deepEqual(w.ids('WarehouseEntryAttachment'), []);
  assert.deepEqual(w.ids('SupplierLedgerEntry'), ['L3', 'L4', 'L5', 'L6', 'L7', 'L8']);
  assert.deepEqual(w.ids('SupplierPaymentAllocation'), ['A2', 'A3']);
  assert.deepEqual(w.ids('SupplierPayment'), ['P1', 'P2'], 'السند العادي باقٍ بتخصيصه على W3 وحده');
  // كشف المورّد بعد الحذف = ما بقي من مستندات: لا أثر لـW1 ولا لمرتجعه
  const balance = (w.tables.get('SupplierLedgerEntry') as Row[]).reduce((s, l) => s + (l.amountMilli as bigint), 0n);
  assert.equal(balance, 50000n - 50000n + 46000n - 46000n + 46000n + 7000n);
});

test('اليدوية: حذف الاستلام النقدي يحذف سنده الآلي بتخصيصه وقيوده (PAYMENT وعكسه) — بلا انفجار مفتاح', { skip: SKIP }, async () => {
  const w = supplierWorld(MANUAL_BOOKS);
  const plan = await buildPurgePlan(w.client as never, T, 'WarehouseEntry', 'W4');
  assert.deepEqual(plan.counts, { WarehouseEntry: 1, WarehouseEntryItem: 1, SupplierLedgerEntry: 3, SupplierPaymentAllocation: 1, SupplierPayment: 1 });
  const order = deletionOrder(plan);
  assert.ok(order.indexOf('SupplierPaymentAllocation') < order.indexOf('SupplierPayment'));
  assert.ok(order.indexOf('SupplierLedgerEntry') < order.indexOf('SupplierPayment'));
  await purgeInTx(w.client as never, T, 'WarehouseEntry', 'W4');
  assert.deepEqual(w.ids('SupplierPayment'), ['P1']);
  assert.deepEqual(w.ids('SupplierPaymentAllocation'), ['A1', 'A2']);
  assert.deepEqual(w.ids('SupplierLedgerEntry'), ['L1', 'L2', 'L3', 'L4', 'L8']);
  assert.deepEqual(w.ids('WarehouseEntry'), ['W1', 'W2', 'W3', 'W5']);
});

test('اليدوية: حذف سند الصرف يحذف تخصيصاته وقيده — وفواتيره باقية بقيودها (يعود متبقّيها)', { skip: SKIP }, async () => {
  const w = supplierWorld(MANUAL_BOOKS);
  await purgeInTx(w.client as never, T, 'SupplierPayment', ['P1']);
  assert.deepEqual(w.ids('SupplierPayment'), ['P2']);
  assert.deepEqual(w.ids('SupplierPaymentAllocation'), ['A3']);
  assert.deepEqual(w.ids('SupplierLedgerEntry'), ['L1', 'L2', 'L4', 'L5', 'L6', 'L7', 'L8']);
  assert.deepEqual(w.ids('WarehouseEntry'), ['W1', 'W2', 'W3', 'W4', 'W5']);
});

test('اليدوية: حذف صنفٍ في فواتير موردين ⇒ 409 SUPPLIER_BILLS_NO_DELETE قبل أي كتابة — والفاتورة تُحذف مستهدفةً بذاتها ثم الصنف', { skip: SKIP }, async () => {
  const w = supplierWorld(MANUAL_BOOKS);
  const sizes = () => JSON.stringify([...w.tables].filter(([, v]) => v.length).map(([k, v]) => [k, v.length]));
  const before = sizes();
  // p2 وحده في W4 (نقدي بسند آلي): كان حذف الصنف يفرغ W4 فيمحوه بقيوده وسنده بالتعاقب — صار رفضاً (fix-L1 #1)
  // وp1 في W1 (آجل بتخصيص) وW2 (مرتجعه بقيده) وW3 (آجل): كان يمحوها فيبقى سند P1 «دفعة مقدّمة» عن دينٍ سُدّد
  for (const pid of ['p2', 'p1']) {
    await assert.rejects(purgeInTx(w.client as never, T, 'Product', [pid]), (e: unknown) => e instanceof PurgeRefused
      && e.status === 409 && e.code === 'SUPPLIER_BILLS_NO_DELETE' && e.models.join() === 'WarehouseEntry', pid);
  }
  assert.deepEqual(w.writes, [], 'لا كتابة');
  assert.equal(sizes(), before);
  // الفاتورة نفسها تُحذف مستهدفةً (بتوابعها كما في الاختبار أعلاه)، ثم يُحذف الصنف الذي لم يبقَ له سطرٌ في فاتورة مورّد
  await purgeInTx(w.client as never, T, 'WarehouseEntry', ['W4']);
  await purgeInTx(w.client as never, T, 'Product', ['p2']);
  assert.deepEqual(w.ids('Product'), ['p1']);
  assert.deepEqual(w.ids('WarehouseEntry'), ['W1', 'W2', 'W3', 'W5']);
  assert.deepEqual(w.ids('SupplierPayment'), ['P1']);
  assert.deepEqual(w.ids('SupplierLedgerEntry'), ['L1', 'L2', 'L3', 'L4', 'L8']);
});

// ═══ الشركة المربوطة: لا حذف للمرحَّل ولا تفريغ فيه ═══

test('المربوطة: حذف وارد المستودع أو سند الصرف أو صنفٍ له حركات ⇒ 409 BOOKS_LINKED_NO_DELETE قبل أي كتابة', { skip: SKIP }, async () => {
  for (const [model, id, models] of [
    ['WarehouseEntry', 'W1', ['SupplierLedgerEntry', 'SupplierPaymentAllocation', 'WarehouseEntry', 'WarehouseEntryItem']],
    ['SupplierPayment', 'P1', ['SupplierLedgerEntry', 'SupplierPayment', 'SupplierPaymentAllocation']],
    ['Product', 'p1', ['WarehouseEntryItem']],
  ] as const) {
    const w = supplierWorld(LINKED_BOOKS);
    // الجداول المأهولة وأعدادها (القراءة تُنشئ في المزيّف جداول فارغة — لا تعني كتابة)
    const sizes = () => JSON.stringify([...w.tables].filter(([, v]) => v.length).map(([k, v]) => [k, v.length]));
    const before = sizes();
    await assert.rejects(purgeInTx(w.client as never, T, model, [id]), (e: unknown) => e instanceof PurgeRefused
      && e.status === 409 && e.code === 'BOOKS_LINKED_NO_DELETE' && e.message === LINKED_NO_DELETE_MESSAGE
      && models.every((m) => e.models.includes(m)), model);
    assert.deepEqual(w.writes, [], `${model}: لا كتابة`);
    assert.equal(sizes(), before);
  }
});

test('المربوطة: ما لا يمسّ مرحَّلاً يُحذف كما كان، وتفريغ مفتاحٍ في مستندٍ مرحَّل (لوكيشن على تحميل) يُرفض', async () => {
  const world = (vanLoads: Row[]) => fkDb({
    GlSettings: [LINKED_BOOKS],
    SalesLocation: [{ id: 'loc1', tenantId: T, name: 'الرياض' }],
    VanLoad: vanLoads,
  });
  const free = world([]);
  const r = await purgeInTx(free.client as never, T, 'SalesLocation', ['loc1']);
  assert.equal(r.counts.SalesLocation, 1);
  assert.deepEqual(free.ids('SalesLocation'), []);
  const tagged = world([{ id: 'VL1', tenantId: T, locationId: 'loc1', type: 'LOAD' }]);
  await assert.rejects(purgeInTx(tagged.client as never, T, 'SalesLocation', ['loc1']), (e: unknown) => e instanceof PurgeRefused && e.status === 409 && e.models.join() === 'VanLoad');
  assert.equal(tagged.row('VanLoad', 'VL1')?.locationId, 'loc1', 'وسم التحميل المرحَّل لم يُفرَّغ');
  assert.deepEqual(tagged.ids('SalesLocation'), ['loc1']);
  // واليدوية: التفريغ كما كان
  const manual = fkDb({ GlSettings: [MANUAL_BOOKS], SalesLocation: [{ id: 'loc1', tenantId: T }], VanLoad: [{ id: 'VL1', tenantId: T, locationId: 'loc1' }] });
  await purgeInTx(manual.client as never, T, 'SalesLocation', ['loc1']);
  assert.equal(manual.row('VanLoad', 'VL1')?.locationId, null);
});
