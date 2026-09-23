// البند 10 — متانة التراجع لدفعات العملاء والمنتجات. منطق صرف + محاكاة الحلقة بمخزن مزيّف، بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  FK_BLOCK_REASON, categoryDeletable, customerBlockReason, draftCategoryLinkIds, isFkBlockError, isLockBusyError, parseBatchRecordIds,
  productBlockReason, revertOutcome, revertResponse, serializeBatchRecordIds, type RevertBlocked,
} from '../services/importLedger';
import type { Prisma } from '@prisma/client';
// الدفعة 3: دوالّ المسار الصرفة (البنود 32 و33 و45 و46) — استيراد الوحدة لا يمسّ قاعدة البيانات
import {
  CUSTOMER_GL_BLOCK_REASON, OUTBOX_REPORT_MAX_AGE_MS, PRODUCT_GL_BLOCK_REASON,
  customerLedgerBlockReason, importBatchCategoryIds, outboxPendingTotal, outboxReportFloor, productLedgerBlockReason,
} from '../routes/import';

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
  // الحارس: المسار يقرأ المسودة قبل حلقة الفئات ويمرّر draftLinked (البند 48: القرار داخل deleteImportCategory)
  const src = read('routes/import.ts');
  const tail = src.slice(src.indexOf("if (batch.kind === 'customers' || batch.kind === 'products' || batch.kind === OPENING_STOCK_KIND)"));
  let pos = -1;
  for (const n of ['draftCategoryLinkIds(', 'select: { setupDraft: true }', 'for (const catId of parsed.categories)', 'deleteImportCategory(tid, catId, draftLinks.has(catId))']) {
    const k = tail.indexOf(n, pos + 1);
    assert.ok(k > pos, `تراجع المنتجات: ${n} خارج الترتيب`);
    pos = k;
  }
  // ولا حذف فئة خارج معاملة deleteImportCategory
  assert.doesNotMatch(tail, /productCategory\.deleteMany\(/, 'حذف فئة في المسار خارج معاملة القفل');
  const fn = src.slice(src.indexOf('async function deleteImportCategory('), src.indexOf('\n}\n', src.indexOf('async function deleteImportCategory(')));
  pos = -1;
  for (const n of ['prisma.$transaction(', 'FOR UPDATE', 'categoryDeletable(', 'draftLinked', 'tx.product.count(', 'glProductCategoryAccount.count(', 'tx.productCategory.deleteMany(']) {
    const k = fn.indexOf(n, pos + 1);
    assert.ok(k > pos, `deleteImportCategory: ${n} خارج الترتيب`);
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

// ═══ الدفعة 3 من مراجعة الاستيراد (البنود 32 و33 و45 و46 و48): أثر الدفاتر، والصفّ الصادر، وفئات التراجع ═══
// منطق صرف + حراس ثابتة على المسار، بلا قاعدة بيانات.

const importSrc = () => read('routes/import.ts');
/** جسم دالّة على مستوى الوحدة (حتى أول سطر إغلاق في العمود صفر) */
function fnBody(src: string, head: string): string {
  const i = src.indexOf(head);
  assert.ok(i > 0, `لم يُعثر على ${head}`);
  return src.slice(i, src.indexOf('\n}\n', i));
}
/** فرع من مسار التراجع */
function revertBranch(src: string, from: string, to: string): string {
  const rv = src.slice(src.indexOf("router.post('/batches/:id/revert'"));
  const a = rv.indexOf(from);
  const b = rv.indexOf(to, a + 1);
  assert.ok(a > 0 && b > a, `الفرع ${from} غير موجود`);
  return rv.slice(a, b);
}
function assertOrdered(body: string, parts: readonly string[], label: string): void {
  let pos = -1;
  for (const p of parts) {
    const i = body.indexOf(p, pos + 1);
    assert.ok(i > pos, `${label}: «${p}» مفقود أو خارج الترتيب`);
    pos = i;
  }
}

// البند 32: صندوق الإرسال (Outbox) يعيش على جهاز المندوب — الخادم لا يرى مستنداته ولا عميلها، بل عدّها في
// النبضة وحدها (SalesRep.outboxPending/outboxReportedAt). فالمحروس هو ما يراه الخادم فعلاً.
test('سيناريو البند 32: أرضية الإبلاغ = لحظة إنشاء الدفعة، والصمت أسبوعاً لا يحبس التراجع؛ والحزمة القديمة لا تُبلغ ⇒ صفر', () => {
  const now = new Date('2026-09-17T12:00:00Z');
  const batchAt = new Date('2026-09-17T11:00:00Z');
  // إبلاغ أقدم من الدفعة لا يخصّ عملاءها (لم يكونوا موجودين بعد) ⇒ الأرضية لحظة الدفعة
  assert.equal(outboxReportFloor(batchAt, now).toISOString(), batchAt.toISOString());
  // دفعة قديمة: جهاز لم يُبلغ منذ أسبوع لا يمنع التراجع إلى الأبد
  const oldBatch = new Date(now.getTime() - 30 * 24 * 3600_000);
  assert.equal(outboxReportFloor(oldBatch, now).getTime(), now.getTime() - OUTBOX_REPORT_MAX_AGE_MS);
  assert.equal(OUTBOX_REPORT_MAX_AGE_MS, 7 * 24 * 3600_000);
  // العدّ: الحقل الغائب (حزمة قديمة لا تُبلغ) صفر لا منع، والقيم تُجمع عبر الأجهزة
  assert.equal(outboxPendingTotal([]), 0);
  assert.equal(outboxPendingTotal([{ outboxPending: null }, { outboxPending: undefined }, { outboxPending: 0 }]), 0);
  assert.equal(outboxPendingTotal([{ outboxPending: 3 }, { outboxPending: 2 }, { outboxPending: null }]), 5);
});

test('حارس ثابت (البند 32): عدّ الصفّ الصادر يُقرأ قبل أي حذف، والمنع 409 بلا تغيير في الدفعة (تُعاد المحاولة)', () => {
  const src = importSrc();
  const branch = revertBranch(src, "if (batch.kind === 'customers') {", "} else if (batch.kind === 'products') {");
  assertOrdered(branch, [
    'const outboxPending = await pendingOutboxDocs(tid, batch.createdAt, new Date())', 'if (outboxPending > 0)',
    "code: 'IMPORT_REVERT_OUTBOX_PENDING'", 'for (const cid of ids) {', 'acquirePostLock(tx, tid)', 'tx.customer.deleteMany(',
  ], 'تراجع العملاء/الصفّ الصادر');
  // المنع قبل الحلقة: لا حذف جزئي ولا وسم للدفعة، والعدّ في التفاصيل
  assert.match(branch, /res\.status\(409\)\.json\(\{ success: false, code: 'IMPORT_REVERT_OUTBOX_PENDING', message: OUTBOX_PENDING_REASON, details: \{ pending: outboxPending \} \}\);\s*\n\s*return;/);
  // ولا جدول مخترع: النبضة وحدها، بالشركة وبأرضية الإبلاغ
  const fn = fnBody(src, 'async function pendingOutboxDocs(');
  assert.match(fn, /prisma\.salesRep\.findMany\(/);
  assert.match(fn, /tenantId: tid, outboxPending: \{ gt: 0 \}, outboxReportedAt: \{ gte: outboxReportFloor\(batchCreatedAt, now\) \}/);
  assert.match(src, /const OUTBOX_PENDING_REASON = 'مستندات لم تُرفع بعد من أجهزة المناديب، أكمل المزامنة ثم أعد التراجع';/);
});

// البندان 33 و45: GlMove.customerId وGlMoveLine.customerId/productId بلا مفتاح أجنبي، فالحذف يتركها تشير إلى
// سجلّ غير موجود: فحص C3 أحمر لعميل بلا اسم وزرّ التصحيح 500، وسطور قيود بصنف مفقود لا تُحفظ مسودتها.
test('حارس ثابت (البندان 33 و45): أثر الدفاتر يُفحص داخل معاملة الحذف نفسها، بعد البصمة القائمة وقبل أي حذف', () => {
  const src = importSrc();
  const customers = revertBranch(src, "if (batch.kind === 'customers') {", "} else if (batch.kind === 'products') {");
  assertOrdered(customers, ['customerBlockReason({', 'customerLedgerBlockReason(tx, tid, cid)', "status: 'blocked'", 'tx.customer.deleteMany('], 'تراجع العملاء/الدفاتر');
  const products = revertBranch(src, "} else if (batch.kind === 'products') {", "} else if (batch.kind === 'balances'");
  assertOrdered(products, ['productBlockReason({', 'productLedgerBlockReason(tx, tid, pid)', "status: 'blocked'", 'tx.product.deleteMany('], 'تراجع المنتجات/الدفاتر');
  // العدّ بالشركة مع المعرّف (لا عبر الشركات)، وبالسبب الصريح
  assert.match(src, /tx\.glMoveLine\.count\(\{ where: \{ tenantId: tid, customerId: cid \} \}\)/);
  assert.match(src, /tx\.glMove\.count\(\{ where: \{ tenantId: tid, customerId: cid \} \}\)/);
  assert.match(src, /tx\.glMoveLine\.count\(\{ where: \{ tenantId: tid, productId: pid \} \}\)/);
  assert.match(src, /const CUSTOMER_GL_BLOCK_REASON = 'للعميل حركات في الدفاتر';/);
  assert.match(src, /const PRODUCT_GL_BLOCK_REASON = 'للصنف سطور قيود';/);
  // عدّ لا ترحيل: لا خدمة gl جديدة في مسار الاستيراد سوى القائمتين (قفل الترحيل وشواهد المزامنة)، وopening
  // بقاعدتَي التاريخ الصرفتين وحدهما (البند 39) — لا حساب افتتاح ولا ترحيل من مسار الاستيراد
  assert.deepEqual([...src.matchAll(/from '\.\.\/services\/gl\/([\w/]+)'/g)].map(m => m[1]).sort(), ['post', 'sync/tombstone']);
});

// البند 46: فئة أنشأتها الدفعة A واستعملتها B تبقى عند التراجع عن A، ثم تسقط من التتبّع فتبقى فارغة أبداً.
test('سيناريو البند 46: الفئة المستبقاة تُفحص عند التراجع عن الدفعة التي استعملتها — لا سجلّ يتيم', () => {
  // A أنشأت «مشروبات» (cat-1) مع p1، وB أضافت p2 في الفئة نفسها دون تسجيلها في دفعتها
  const a = { recordIds: serializeBatchRecordIds('products', ['p1'], ['cat-1']) };
  const b = { recordIds: serializeBatchRecordIds('products', ['p2'], []) };
  // التراجع عن A: للفئة منتج B ⇒ تبقى (والدفعة تُوسم reverted، لكن recordIds تحتفظ بفئتها)
  assert.equal(categoryDeletable({ products: 1, accountRows: 0 }), false);
  assert.deepEqual(parseBatchRecordIds(a.recordIds).categories, ['cat-1']);
  // التراجع عن B: المرشّحات تُجمع من دفعات المنتجات الأخرى (ومنها A المتراجَع عنها) عدا فئات B نفسها
  assert.deepEqual(importBatchCategoryIds([a, b], parseBatchRecordIds(b.recordIds).categories), ['cat-1']);
  assert.equal(categoryDeletable({ products: 0, accountRows: 0 }), true);
  // بلا تكرار، وبلا ما استُثني، والتالف والفارغ يُتجاهلان، والسقف يحدّ العمل
  assert.deepEqual(importBatchCategoryIds([{ recordIds: '{"products":[],"categories":["x","y","x"]}' }, { recordIds: '{oops' }, { recordIds: null }], ['y']), ['x']);
  assert.deepEqual(importBatchCategoryIds([{ recordIds: '{"products":[],"categories":["x","y","z"]}' }], [], 2), ['x', 'y']);
});

test('حارس ثابت (البند 46): كنس فئات الدفعات الأخرى بعد فئات الدفعة، ولا يُحسب على keptCategories', () => {
  const src = importSrc();
  const tail = src.slice(src.indexOf("if (batch.kind === 'customers' || batch.kind === 'products' || batch.kind === OPENING_STOCK_KIND)"));
  assertOrdered(tail, ['for (const catId of parsed.categories)', 'keptCategories.push(catId)', 'orphanImportCategories(tid, batch.id, parsed.categories)', 'deleteImportCategory(tid, catId, draftLinks.has(catId))'], 'كنس الفئات');
  assert.equal((tail.match(/keptCategories\.push\(/g) ?? []).length, 1, 'فئة دفعة أخرى تُحسب على هذه الدفعة');
  const fn = fnBody(src, 'async function orphanImportCategories(');
  assert.match(fn, /kind: 'products', id: \{ not: exceptBatchId \}/);
  assert.doesNotMatch(fn, /reverted/, 'الدفعة المتراجَع عنها تحمل فئاتها في recordIds فلا تُستثنى من الكنس');
  assert.match(fn, /_count: \{ select: \{ products: true \} \}/);
  assert.match(fn, /r\._count\.products === 0/);
});

// البند 48: العلاقة Product.categoryId بلا onDelete صريح وحقلها اختياري ⇒ SET NULL: الحذف ينجح ويُفرّغ فئة
// الصنف بصمت، فلا يحرس isFkBlockError شيئاً. الحارس الوحيد إعادة العدّ داخل معاملة واحدة تحت قفل صفّ الفئة.
test('سيناريو البند 48: الفحص والحذف في معاملة واحدة بقفل صفّ الفئة، بلا قفل استشاري جديد', () => {
  const schema = read('../prisma/schema.prisma');
  assert.match(schema, /category\s+ProductCategory\?\s+@relation\(fields: \[categoryId\], references: \[id\]\)/, 'علاقة الفئة تغيّرت — أعد فحص السلوك عند الحذف');
  const fn = fnBody(importSrc(), 'async function deleteImportCategory(');
  assertOrdered(fn, ['prisma.$transaction(', "SET LOCAL lock_timeout = '5s'", 'FOR UPDATE', "return 'gone'", 'categoryDeletable(', 'draftLinked', "return 'kept'", 'tx.productCategory.deleteMany(', "return 'deleted'"], 'deleteImportCategory');
  // العدّان داخل المعاملة نفسها (لا على prisma خارجها)
  assert.match(fn, /tx\.product\.count\(\{ where: \{ tenantId: tid, categoryId: catId \} \}\)/);
  assert.match(fn, /tx\.glProductCategoryAccount\.count\(\{ where: \{ tenantId: tid, categoryId: catId \} \}\)/);
  assert.doesNotMatch(fn, /prisma\.product(Category)?\.(count|deleteMany)\(/, 'عدّ أو حذف خارج المعاملة');
  // بلا توسيع نطاق الأقفال: لا gl-post ولا import-entries هنا، فلا ينقلب ترتيبها
  assert.doesNotMatch(fn, /acquirePostLock|pg_advisory_xact_lock/);
  // والمزاحمة أو الارتباط الطارئ يُبقيان الفئة لا يُسقطان تراجع الدفعة
  assert.match(fn, /if \(isFkBlockError\(e\) \|\| isLockBusyError\(e\)\) return 'kept';/);
});

// ═══ البندان 33 و45: أثر الدفاتر قبل الحذف — سلوك الدالّتين نفسه، لا نصّ المسار وحده ═══
// GlMove.customerId وGlMoveLine.customerId/productId بلا مفتاح أجنبي، فالحذف لا يرمي P2003 ولا يحرسه
// isFkBlockError: الحارس الوحيد هو العدّ الصريح داخل معاملة الحذف. هذه الاختبارات تشغّل الدالّتين بعميل
// مزيّف يسجّل كل استعلام، فتثبت النتيجة والعزل وقصر الدائرة معاً.

type GlCount = { model: string; where: Record<string, unknown> };

function fakeGlTx(counts: { lines?: number; moves?: number }) {
  const calls: GlCount[] = [];
  const count = (model: string, n: number) => async ({ where }: { where: Record<string, unknown> }) => {
    calls.push({ model, where });
    return n;
  };
  const tx = {
    glMoveLine: { count: count('glMoveLine', counts.lines ?? 0) },
    glMove: { count: count('glMove', counts.moves ?? 0) },
  } as unknown as Prisma.TransactionClient;
  return { tx, calls };
}

test('سيناريو البند 33: عميل له سطر قيد أو قيد تصحيح C3 ⇒ blocked لا حذف يترك فحص الذمم أحمر لعميل بلا اسم', async () => {
  // لا أثر في الدفاتر ⇒ الحذف يمضي (والاستعلامان كلاهما نُفِّذا: لا منع بلا دليل)
  const clean = fakeGlTx({ lines: 0, moves: 0 });
  assert.equal(await customerLedgerBlockReason(clean.tx, 't1', 'c1'), null);
  assert.deepEqual(clean.calls.map(c => c.model), ['glMoveLine', 'glMove']);

  // سطر قيد على اسم العميل ⇒ منع بالسبب الصريح، وقصر الدائرة: لا استعلام ثانٍ بلا فائدة
  const lined = fakeGlTx({ lines: 3, moves: 0 });
  assert.equal(await customerLedgerBlockReason(lined.tx, 't1', 'c1'), CUSTOMER_GL_BLOCK_REASON);
  assert.deepEqual(lined.calls.map(c => c.model), ['glMoveLine']);

  // سيناريو المراجع بعينه: قيد تصحيح C3 على العميل بلا سطر يحمل اسمه (GlMove.customerId وحده) ⇒ منع كذلك
  const moved = fakeGlTx({ lines: 0, moves: 1 });
  assert.equal(await customerLedgerBlockReason(moved.tx, 't1', 'c1'), CUSTOMER_GL_BLOCK_REASON);
  assert.deepEqual(moved.calls.map(c => c.model), ['glMoveLine', 'glMove']);

  // العزل: كل عدّ بالشركة والعميل معاً — لا عدّ عبر الشركات يمنع تراجعاً مشروعاً، ولا عدّ بلا عميل يمنع الجميع
  for (const c of moved.calls) assert.deepEqual(c.where, { tenantId: 't1', customerId: 'c1' });
  assert.equal(CUSTOMER_GL_BLOCK_REASON, 'للعميل حركات في الدفاتر');
});

test('سيناريو البند 45: صنف له سطر قيد مُدخل عبر الـAPI ⇒ blocked، والصنف بلا أثر يُحذف؛ والعدّ بالشركة والصنف', async () => {
  const clean = fakeGlTx({ lines: 0 });
  assert.equal(await productLedgerBlockReason(clean.tx, 't1', 'p1'), null);
  assert.deepEqual(clean.calls.map(c => c.model), ['glMoveLine']);

  const lined = fakeGlTx({ lines: 1 });
  assert.equal(await productLedgerBlockReason(lined.tx, 't1', 'p1'), PRODUCT_GL_BLOCK_REASON);
  assert.deepEqual(lined.calls[0].where, { tenantId: 't1', productId: 'p1' });
  // القيود وحدها هنا: الفواتير والتحميل والمستودع يحرسها productBlockReason (لا ازدواج ولا ثغرة)
  assert.equal(lined.calls.length, 1);
  assert.equal(PRODUCT_GL_BLOCK_REASON, 'للصنف سطور قيود');
  assert.notEqual(PRODUCT_GL_BLOCK_REASON, CUSTOMER_GL_BLOCK_REASON);
});
