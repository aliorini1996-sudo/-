// إصلاحات «ربط الدفاتر» L1 (fixb) #1 — حذف الصنف لا يمسّ فواتير الموردين، لكل شركة (لا المربوطة وحدها):
//   • المحرّك (services/ownerPurge.ts — assertPurgeKeepsSupplierBills): خطةٌ تحذف أسطر حركة مستودعٍ لها أثرٌ في كشف المورّد (مصنَّفة،
//     أو عليها قيود مورّد أو تخصيصات سندات) دون الحركة نفسها ⇒ PurgeRefused 409 SUPPLIER_BILLS_NO_DELETE قبل أي كتابة:
//       (أ) الفاتورة تفرغ فيُحذف رأسها بقيوده وتخصيصاته فيبقى سند الصرف اليدوي «دفعة مقدّمة» عن دينٍ سُدّد؛
//       (ب) يبقى فيها صنفٌ آخر فيبقى إجماليها 230 وقيد BILL كذلك، فيأخذ مرتجع الوحدة الباقية (115) المتبقّي كاملاً −230.
//     والحركة المستهدفة بذاتها، والحركات بلا أثر مورّد (غير مصنَّفة، تسوية) — كما كانت.
//   • المسار DELETE /api/products/:id: الرفض 409 برسالة «أوقِفه بدلاً من الحذف» والمعاملة تُستعاد (لقطة الاسم لا تبقى).
// على قاعدةٍ في الذاكرة **تفرض المفاتيح الأجنبية من نموذج Prisma** (نمط b2a-owner-purge-books). تحتاج عميل Prisma مولَّداً من
// المخطط الحالي (prisma generate)؛ مع عميلٍ قديم تُتخطّى بسببٍ ظاهر.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

/* eslint-disable @typescript-eslint/no-var-requires */
const { Prisma } = require('@prisma/client') as typeof import('@prisma/client');
const MODELS = Prisma.dmmf.datamodel.models;
const hasModel = (n: string): boolean => MODELS.some((x) => x.name === n);
const STALE = !hasModel('SupplierLedgerEntry') || !MODELS.find((x) => x.name === 'WarehouseEntry')?.fields.some((f) => f.name === 'paymentMode');
const SKIP = STALE ? 'عميل Prisma المثبَّت قديم (لا يرى نماذج «ربط الدفاتر») — شغّل prisma generate' : false;

// ═══ قاعدة في الذاكرة تفرض المفاتيح الأجنبية من نموذج Prisma (مع معاملةٍ تُستعاد عند الرمي) ═══

const delegateOf = (x: string): string => x.charAt(0).toLowerCase() + x.slice(1);
const modelOfDelegate = new Map(MODELS.map((x) => [delegateOf(x.name), x.name]));
interface Rel { child: string; fk: string; parent: string; ref: string; onDelete: string; relationName: string }
const RELS: Rel[] = [];
for (const md of MODELS) {
  for (const f of md.fields) {
    if (f.kind !== 'object' || f.relationFromFields?.length !== 1) continue;
    const fkField = md.fields.find((x) => x.name === f.relationFromFields![0]);
    const onDelete = (f as { relationOnDelete?: string }).relationOnDelete ?? (fkField?.isRequired ? 'Restrict' : 'SetNull');
    RELS.push({ child: md.name, fk: f.relationFromFields[0], parent: f.type, ref: f.relationToFields![0], onDelete, relationName: f.relationName ?? '' });
  }
}
class FkError extends Error { code = 'P2003'; }

let tables = new Map<string, Row[]>();
let writes: string[] = [];
const table = (model: string): Row[] => { let t = tables.get(model); if (!t) { t = []; tables.set(model, t); } return t; };
function seed(s: Record<string, Row[]>): void {
  tables = new Map(Object.entries(s).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
  writes = [];
}
const ids = (model: string): string[] => table(model).map((r) => String(r.id)).sort();

function match(model: string, row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (v === null) return row[k] == null;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('not' in v) return v.not === null ? row[k] != null : row[k] !== v.not;
      if ('none' in v) {
        const field = MODELS.find((x) => x.name === model)!.fields.find((f) => f.name === k)!;
        const rel = RELS.find((r) => r.parent === model && r.child === field.type && r.relationName === field.relationName)!;
        return !table(rel.child).some((c) => c[rel.fk] === row[rel.ref]);
      }
      throw new Error(`fake: unsupported filter ${model}.${k}`);
    }
    return row[k] === v;
  });
}
const pick = (row: Row, select?: Row): Row => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null])) : { ...row });

/** حذف كما في PostgreSQL: التعاقب ثم SetNull، والمفتاح NoAction/Restrict الباقي ⇒ P2003 */
function deleteRows(model: string, rows: Row[]): number {
  const doomed = new Map<string, Set<Row>>();
  const queue: Array<[string, Row[]]> = [[model, rows]];
  while (queue.length) {
    const [mm, rs] = queue.shift()!;
    let set = doomed.get(mm);
    if (!set) { set = new Set(); doomed.set(mm, set); }
    const fresh = rs.filter((r) => !set!.has(r));
    fresh.forEach((r) => set!.add(r));
    for (const rel of RELS.filter((x) => x.parent === mm && x.onDelete === 'Cascade')) {
      const keys = new Set(fresh.map((r) => r[rel.ref]));
      queue.push([rel.child, table(rel.child).filter((c) => keys.has(c[rel.fk]))]);
    }
  }
  for (const [mm, set] of doomed) tables.set(mm, table(mm).filter((r) => !set.has(r)));
  for (const [mm, set] of doomed) {
    for (const rel of RELS.filter((x) => x.parent === mm)) {
      const keys = new Set([...set].map((r) => r[rel.ref]));
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
    if (name === '$transaction') {
      return async (fn: (tx: unknown) => Promise<unknown>) => {
        const snap = new Map([...tables].map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
        try { return await fn(client); } catch (e) { tables = snap; throw e; }
      };
    }
    if (name === '$queryRaw') {
      return async (s: TemplateStringsArray, ...values: unknown[]) => {
        const sql = Array.from(s).join('?');
        if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '0' }];
        if (sql.includes('FROM products WHERE id =') && sql.includes('FOR UPDATE')) {
          return table('Product').filter((p) => p.id === values[0] && p.tenantId === values[1]).map((p) => ({ id: p.id }));
        }
        throw new Error(`fake: SQL غير متوقّع ${sql}`);
      };
    }
    if (name === '$executeRaw') return async () => 1;
    const model = modelOfDelegate.get(name);
    assert.ok(model, `fake: unknown delegate ${name}`);
    return {
      findMany: async (a: Row = {}) => table(model).filter((r) => match(model, r, a.where)).map((r) => pick(r, a.select)),
      findUnique: async (a: Row = {}) => { const r = table(model).find((x) => match(model, x, a.where)); return r ? pick(r, a.select) : null; },
      findFirst: async (a: Row = {}) => { const r = table(model).find((x) => match(model, x, a.where)); return r ? pick(r, a.select) : null; },
      count: async (a: Row = {}) => table(model).filter((r) => match(model, r, a.where)).length,
      update: async (a: Row) => { writes.push(`${name}.update`); const r = table(model).find((x) => match(model, x, a.where)); Object.assign(r!, a.data); return r; },
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
stub('config/database', { default: client });

const { PurgeRefused, buildPurgePlan, purgeInTx, assertPurgeKeepsSupplierBills, SUPPLIER_BILLS_NO_DELETE_CODE } =
  require('../services/ownerPurge') as typeof import('../services/ownerPurge');
const products = require('../routes/products') as typeof import('../routes/products');
/* eslint-enable @typescript-eslint/no-var-requires */

const T = 't1';
const day = new Date('2026-11-10T00:00:00Z');
const MANUAL_BOOKS = { tenantId: T, setupMethod: 'CLEAN', activatedAt: new Date('2026-01-01T00:00:00Z') };

/**
 * عالم المشتريات (شركة بلا دفاتر مفعّلة — أغلب الشركات، وL1 حيٌّ لها):
 *   W1 فاتورة آجلة لـX (p1) وY (p2): كلٌّ ١ × ١٠٠ بضريبة ١٥٪ ⇒ 230، وقيد BILL 230.
 *   W2 فاتورة آجلة لـX وحده 1150 سُدّدت بسند صرفٍ يدوي SP-1 (تخصيص كامل وقيد PAYMENT).
 *   W3 وارد غير مصنَّف لـX (بلا مورّد ولا قيود)، وW4 تسوية لـX، وp3 (Z) في وارد غير مصنَّف وحده W5.
 */
function world(books: Row | null = null): void {
  const L = (id: string, kind: string, amount: bigint, wid: string | null, pid: string | null) =>
    ({ id, tenantId: T, vendorId: 'v1', kind, amountMilli: amount, warehouseEntryId: wid, supplierPaymentId: pid, docDate: day });
  seed({
    GlSettings: books ? [books] : [],
    GlVendor: [{ id: 'v1', tenantId: T, name: 'مورّد' }],
    Product: [
      { id: 'p1', tenantId: T, name: 'X', unit: 'حبة' }, { id: 'p2', tenantId: T, name: 'Y', unit: 'حبة' }, { id: 'p3', tenantId: T, name: 'Z', unit: 'حبة' },
    ],
    WarehouseEntry: [
      { id: 'W1', tenantId: T, type: 'RECEIVE', vendorId: 'v1', paymentMode: 'CREDIT', status: 'POSTED', totalMilli: 230_000n, returnOfEntryId: null },
      { id: 'W2', tenantId: T, type: 'RECEIVE', vendorId: 'v1', paymentMode: 'CREDIT', status: 'POSTED', totalMilli: 1_150_000n, returnOfEntryId: null },
      { id: 'W3', tenantId: T, type: 'RECEIVE', vendorId: null, paymentMode: null, status: 'POSTED', returnOfEntryId: null },
      { id: 'W4', tenantId: T, type: 'ADJUST', vendorId: null, paymentMode: null, status: 'POSTED', returnOfEntryId: null },
      { id: 'W5', tenantId: T, type: 'RECEIVE', vendorId: null, paymentMode: null, status: 'POSTED', returnOfEntryId: null },
    ],
    WarehouseEntryItem: [
      { id: 'w1x', entryId: 'W1', productId: 'p1', qty: 1 }, { id: 'w1y', entryId: 'W1', productId: 'p2', qty: 1 },
      { id: 'w2x', entryId: 'W2', productId: 'p1', qty: 10 }, { id: 'w3x', entryId: 'W3', productId: 'p1', qty: 2 },
      { id: 'w4x', entryId: 'W4', productId: 'p1', qty: -1 }, { id: 'w5z', entryId: 'W5', productId: 'p3', qty: 3 },
    ],
    SupplierPayment: [{ id: 'SP1', tenantId: T, vendorId: 'v1', number: 1, amountMilli: 1_150_000n, method: 'CASH', status: 'POSTED', autoForEntryId: null }],
    SupplierPaymentAllocation: [{ id: 'A1', tenantId: T, paymentId: 'SP1', warehouseEntryId: 'W2', amountMilli: 1_150_000n }],
    SupplierLedgerEntry: [L('L1', 'BILL', 230_000n, 'W1', null), L('L2', 'BILL', 1_150_000n, 'W2', null), L('L3', 'PAYMENT', -1_150_000n, null, 'SP1')],
  });
}
const balance = (): bigint => table('SupplierLedgerEntry').reduce((s, l) => s + (l.amountMilli as bigint), 0n);
const sizes = (): string => JSON.stringify([...tables].filter(([, v]) => v.length).map(([k, v]) => [k, v.length]));
const refused = (e: unknown): boolean => e instanceof PurgeRefused && e.status === 409 && e.code === SUPPLIER_BILLS_NO_DELETE_CODE && e.models.join() === 'WarehouseEntry';

test('#1 (ب) صنفٌ في فاتورةٍ فيها صنفٌ آخر ⇒ 409 قبل أي كتابة: لا تبقى الفاتورة بإجماليها القديم (230) فيُقيَّد مرتجع الوحدة الباقية −230', { skip: SKIP }, async () => {
  world();
  const before = sizes();
  // p2 (Y) في W1 وحدها — بجوار X
  await assert.rejects(purgeInTx(client as never, T, 'Product', ['p2']), refused);
  assert.deepEqual(writes, [], 'لا كتابة');
  assert.equal(sizes(), before);
  assert.deepEqual(ids('WarehouseEntryItem'), ['w1x', 'w1y', 'w2x', 'w3x', 'w4x', 'w5z']);
  assert.equal(balance(), 230_000n);
});

test('#1 (أ) صنفٌ وحده في فاتورةٍ سُدّدت بسندٍ يدوي ⇒ 409: لا تُمحى الفاتورة وقيد BILL والتخصيص فيبقى SP-1 «دفعة مقدّمة» −1150', { skip: SKIP }, async () => {
  world();
  await assert.rejects(purgeInTx(client as never, T, 'Product', ['p1']), refused);
  assert.deepEqual(writes, []);
  assert.deepEqual(ids('WarehouseEntry'), ['W1', 'W2', 'W3', 'W4', 'W5']);
  assert.deepEqual(ids('SupplierPaymentAllocation'), ['A1']);
  assert.equal(balance(), 230_000n, 'BILL 230 + BILL 1150 − PAYMENT 1150');
  // والشركة اليدوية المفعّلة (CLEAN) كذلك — الحارس لكل شركة لا للمربوطة وحدها
  world(MANUAL_BOOKS);
  await assert.rejects(purgeInTx(client as never, T, 'Product', ['p1']), refused);
});

test('#1 الفاتورة مستهدفةً بذاتها تُحذف كما كانت، وبعدها يُحذف صنفٌ لم يبقَ له سطرٌ في فاتورة مورّد — وغير المصنَّف والتسوية كما كانا', { skip: SKIP }, async () => {
  world();
  // صنفٌ في وارد غير مصنَّف وحده: يُحذف ويُحذف رأسه الفارغ (المسار القائم)
  await purgeInTx(client as never, T, 'Product', ['p3']);
  assert.deepEqual(ids('Product'), ['p1', 'p2']);
  assert.ok(!ids('WarehouseEntry').includes('W5'), 'الرأس الفارغ حُذف');
  // حذف الفاتورتين مستهدفتين (بقيودهما وتخصيصهما كما في b2a)، ثم الصنف X: أسطره الباقية في غير المصنَّف والتسوية وحدها
  await purgeInTx(client as never, T, 'WarehouseEntry', ['W1', 'W2']);
  assert.deepEqual(ids('SupplierLedgerEntry'), ['L3'], 'سند الصرف باقٍ بقيده');
  await purgeInTx(client as never, T, 'Product', ['p1']);
  assert.deepEqual(ids('Product'), ['p2']);
  assert.deepEqual(ids('WarehouseEntry'), [], 'W3 وW4 فرغتا فحُذفتا كما كان');
});

test('#1 الحارس نقيّ القراءة: بلا أسطر حركات في الخطة لا استعلام؛ والمعاينة (buildPurgePlan + الحارس) ترفض كالتنفيذ', { skip: SKIP }, async () => {
  world();
  let reads = 0;
  const counting = new Proxy({}, { get: () => ({ findMany: async () => { reads++; return []; } }) });
  await assertPurgeKeepsSupplierBills(counting, T, { batches: [{ model: 'Customer', keys: [{ id: 'c1' }] }] });
  assert.equal(reads, 0);
  const plan = await buildPurgePlan(client as never, T, 'Product', 'p2');
  await assert.rejects(assertPurgeKeepsSupplierBills(client, T, plan), refused);
  // مستهدفةً بذاتها: أسطرها في الخطة مع رأسها ⇒ لا رفض
  const own = await buildPurgePlan(client as never, T, 'WarehouseEntry', 'W1');
  await assertPurgeKeepsSupplierBills(client, T, own);
});

test('#1 المربوطة: رفض الدفاتر (BOOKS_LINKED_NO_DELETE) أولاً كما كان — ثم حارس فواتير المورّد لغيرها', { skip: SKIP }, async () => {
  world({ tenantId: T, setupMethod: 'LINKED', activatedAt: new Date('2026-11-01T00:00:00Z') });
  await assert.rejects(purgeInTx(client as never, T, 'Product', ['p2']), (e: unknown) => e instanceof PurgeRefused && e.code === 'BOOKS_LINKED_NO_DELETE');
});

/** معالج DELETE /api/products/:id نفسه (آخر طبقاته بعد requireAdmin) */
async function deleteProduct(id: string): Promise<{ status: number; body: Row | null }> {
  const layer = (products.default as unknown as { stack: Row[] }).stack.find((l) => l.route?.path === '/:id' && l.route.methods?.delete);
  assert.ok(layer, 'DELETE /:id مفقود');
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  let err: unknown;
  await layer.route.stack[layer.route.stack.length - 1].handle(
    { params: { id }, query: {}, body: {}, headers: {}, user: { id: 'ADM', role: 'ADMIN', name: 'المدير', tenantId: T } }, res, (e?: unknown) => { err = e; },
  );
  if (err) throw err;
  return { status: res.statusCode, body: res.body };
}

test('#1 DELETE /api/products/:id لصنفٍ في فاتورة مورّد ⇒ 409 SUPPLIER_BILLS_NO_DELETE «أوقِفه»، والمعاملة تُستعاد كلها — وصنفٌ بلا فواتير موردين يُحذف', { skip: SKIP }, async () => {
  world();
  table('InvoiceItem').push({ id: 'ii1', invoiceId: 'inv1', productId: 'p2', itemName: null });
  const r = await deleteProduct('p2');
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.deepEqual(r.body, { success: false, code: 'SUPPLIER_BILLS_NO_DELETE', message: products.PRODUCT_SUPPLIER_BILLS_MESSAGE });
  assert.match(r.body!.message, /أوقِفه بدلاً من الحذف/);
  assert.equal(table('InvoiceItem')[0].itemName, null, 'لقطة الاسم استُعيدت مع المعاملة');
  assert.deepEqual(ids('Product'), ['p1', 'p2', 'p3']);
  const ok = await deleteProduct('p3');
  assert.deepEqual([ok.status, ok.body], [200, { success: true, archived: false }]);
  assert.deepEqual(ids('Product'), ['p1', 'p2']);
});
