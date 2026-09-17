// البند 10 — متانة التراجع لدفعات العملاء والمنتجات. منطق صرف + محاكاة الحلقة بمخزن مزيّف، بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  FK_BLOCK_REASON, categoryDeletable, customerBlockReason, draftCategoryLinkIds, isFkBlockError, isLockBusyError, parseBatchRecordIds,
  productBlockReason, revertOutcome, revertResponse, serializeBatchRecordIds, type RevertBlocked,
} from '../services/importLedger';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

/** محاكاة حلقة التراجع كما في import.ts: gone ⇒ منتهٍ، blocked ⇒ يبقى، خطأ FK ⇒ blocked */
async function simulate(ids: string[], step: (id: string) => Promise<'removed' | 'gone' | { blocked: string }>) {
  const done = new Set<string>();
  const blocked: RevertBlocked[] = [];
  let removed = 0;
  for (const id of ids) {
    try {
      const out = await step(id);
      if (typeof out === 'object') { blocked.push({ id, name: `n-${id}`, reason: out.blocked }); continue; }
      if (out === 'removed') removed++;
      done.add(id);
    } catch (e) {
      if (!isFkBlockError(e)) throw e;
      blocked.push({ id, name: `n-${id}`, reason: FK_BLOCK_REASON });
    }
  }
  return { done, blocked, removed, ...revertOutcome(ids, done) };
}

const ids = Array.from({ length: 200 }, (_, i) => `p${i + 1}`);

test('فشل FK في العنصر 121 ⇒ blocked، والبقية تُزال، والدفعة تبقى reverted:false بالمعرّف المتبقي وحده', async () => {
  const db = new Set(ids);
  const r = await simulate(ids, async (id) => {
    if (!db.has(id)) return 'gone';
    if (id === 'p121') throw Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003' });
    db.delete(id);
    return 'removed';
  });
  assert.equal(r.removed, 199);
  assert.deepEqual(r.blocked, [{ id: 'p121', name: 'n-p121', reason: FK_BLOCK_REASON }]);
  assert.equal(r.reverted, false);
  assert.deepEqual(r.remainingIds, ['p121']);
  const saved = serializeBatchRecordIds('products', r.remainingIds, ['cat1']);
  assert.deepEqual(parseBatchRecordIds(saved), { records: ['p121'], categories: ['cat1'], previous: {}, imported: {} });
  assert.deepEqual(revertResponse('products', r.removed, r.blocked, r.remainingIds.length),
    { removed: 199, blocked: [{ id: 'p121', name: 'n-p121', reason: FK_BLOCK_REASON }], remaining: 1, kind: 'products', reverted: false });
});

test('إعادة المحاولة بالمعرّفات القديمة كلها لا ترمي P2025: غير الموجود يُتخطى ويُعدّ منتهياً', async () => {
  const db = new Set(['p121']);
  const r = await simulate(ids, async (id) => {
    if (!db.has(id)) return 'gone'; // deleteMany {id, tenantId} ⇒ count 0 بدل P2025
    db.delete(id);
    return 'removed';
  });
  assert.equal(r.removed, 1);
  assert.equal(r.reverted, true);
  assert.deepEqual(r.blocked, []);
  assert.deepEqual(revertResponse('customers', 1, [], 0), { removed: 1, blocked: 0, remaining: 0, kind: 'customers', reverted: true });
});

test('P2003 وP2014 محميان لا P2025، وP2028/مهلة القفل = قفل مشغول', () => {
  assert.equal(isFkBlockError({ code: 'P2003' }), true);
  assert.equal(isFkBlockError({ code: 'P2014' }), true);
  assert.equal(isFkBlockError({ code: 'P2025' }), false);
  assert.equal(isFkBlockError(null), false);
  assert.equal(isLockBusyError({ code: 'P2028' }), true);
  assert.equal(isLockBusyError(new Error('canceling statement due to lock timeout')), true);
  assert.equal(isLockBusyError(new Error('other')), false);
});

test('صنف له vanLoadItem ⇒ blocked دون حذف التحميل؛ وبنود الفواتير والمستودع كذلك', () => {
  assert.equal(productBlockReason({ invoiceItems: 0, vanLoadItems: 0, warehouseEntryItems: 0 }), null);
  assert.ok(productBlockReason({ invoiceItems: 0, vanLoadItems: 1, warehouseEntryItems: 0 }));
  assert.ok(productBlockReason({ invoiceItems: 2, vanLoadItems: 0, warehouseEntryItems: 0 }));
  assert.ok(productBlockReason({ invoiceItems: 0, vanLoadItems: 0, warehouseEntryItems: 3 }));
});

test('العميل: الفواتير والسندات وروابط الدفع والزيارات تحميه، والبند 17 يضيف القيود والأسعار والمحطات', () => {
  const zero = { invoices: 0, receipts: 0, paymentLinks: 0, visits: 0, importedEntries: 0, otherEntries: 0, prices: 0, routeStops: 0, assignments: 0 };
  assert.equal(customerBlockReason(zero), null);
  for (const k of Object.keys(zero) as (keyof typeof zero)[]) assert.ok(customerBlockReason({ ...zero, [k]: 1 }), k);
});

test('فئة مربوطة بحساب تبقى، وفئة يتيمة غير مربوطة تُحذف، وفئة لها منتج تبقى', () => {
  assert.equal(categoryDeletable({ products: 0, accountRows: 1 }), false);
  assert.equal(categoryDeletable({ products: 0, accountRows: 0 }), true);
  assert.equal(categoryDeletable({ products: 3, accountRows: 0 }), false);
});

test('سيناريو البند 26: فئة مربوطة بحساب إيراد في مسودة المعالج تبقى عند التراجع عن دفعة المنتجات', () => {
  const draft = { step1: { cutoverDate: '2026-01-01' }, step3: { categoryIncomeAccounts: [{ categoryId: 'cat-1', accountCode: '4101' }, { categoryId: 'cat-2', accountCode: '4102' }] } };
  const linked = draftCategoryLinkIds(draft);
  assert.deepEqual([...linked].sort(), ['cat-1', 'cat-2']);
  // الفئة يتيمة تماماً (لا منتج ولا صف حساب) لكنها مربوطة في المسودة ⇒ تبقى، وإلا فشل «تفعيل الدفاتر» بـ404
  assert.equal(categoryDeletable({ products: 0, accountRows: 0, draftLinked: linked.has('cat-1') }), false);
  assert.equal(categoryDeletable({ products: 0, accountRows: 0, draftLinked: linked.has('cat-9') }), true);
  // مسودة بلا روابط أو تالفة ⇒ لا حماية زائدة
  for (const bad of [null, undefined, 'x', 42, [], {}, { step3: {} }, { step3: { categoryIncomeAccounts: 'no' } }, { step3: { categoryIncomeAccounts: [{ accountCode: '4101' }, null, 5] } }]) {
    assert.equal(draftCategoryLinkIds(bad).size, 0);
  }
  // الحارس: المسار يقرأ المسودة قبل حلقة الفئات ويمرّر draftLinked
  const src = read('routes/import.ts');
  const tail = src.slice(src.indexOf("if (batch.kind === 'customers' || batch.kind === 'products' || batch.kind === OPENING_STOCK_KIND)"));
  let pos = -1;
  for (const n of ['draftCategoryLinkIds(', 'select: { setupDraft: true }', 'for (const catId of parsed.categories)', 'categoryDeletable(', 'draftLinked: draftLinks.has(catId)', 'glProductCategoryAccount.count(', 'productCategory.deleteMany(']) {
    const k = tail.indexOf(n, pos + 1);
    assert.ok(k > pos, `تراجع المنتجات: ${n} خارج الترتيب`);
    pos = k;
  }
});

test('recordIds القديمة (مصفوفة) تُقرأ، والجديدة {products, categories}، والتالفة فارغة؛ والأنواع الأخرى تبقى مصفوفة', () => {
  assert.deepEqual(parseBatchRecordIds('["a","b"]'), { records: ['a', 'b'], categories: [], previous: {}, imported: {} });
  assert.deepEqual(parseBatchRecordIds('{"products":["a"],"categories":["c"]}'), { records: ['a'], categories: ['c'], previous: {}, imported: {} });
  assert.deepEqual(parseBatchRecordIds('{oops'), { records: [], categories: [], previous: {}, imported: {} });
  assert.deepEqual(parseBatchRecordIds(null), { records: [], categories: [], previous: {}, imported: {} });
  assert.equal(serializeBatchRecordIds('balances', ['e1']), '["e1"]');
  assert.equal(serializeBatchRecordIds('customers', ['c1']), '["c1"]');
  assert.equal(serializeBatchRecordIds('products', ['p1'], []), '{"products":["p1"],"categories":[]}');
});
