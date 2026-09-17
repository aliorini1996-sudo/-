import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  importAccess, revertAllowed, importAccessNote, visibleImportKinds, batchesView,
  IMPORT_SCOPED_NOTE, IMPORT_HIDDEN_KINDS_NOTE,
} from './importAccess';

const ALL = ['customers', 'products', 'balances', 'ledger', 'prices', 'opening_stock'] as const;

test('البند 5: محاسب بلا صلاحية العملاء ⇒ العملاء والأرصدة والكشوف مخفية والتراجع عنها معطّل', () => {
  const a = importAccess({ canManageCustomers: false, canManageProducts: true, canManageVanStock: true });
  assert.equal(a.scoped, false);
  assert.deepEqual(visibleImportKinds(a, ALL), ['products', 'prices', 'opening_stock']);
  assert.equal(revertAllowed(a, 'customers'), false);
  assert.equal(revertAllowed(a, 'balances'), false);
  assert.equal(revertAllowed(a, 'ledger'), false);
  assert.equal(revertAllowed(a, 'products'), true);
  assert.equal(importAccessNote(a), IMPORT_HIDDEN_KINDS_NOTE);
});

test('البند 5: بلا صلاحية المنتجات ⇒ المنتجات والأسعار مخفية؛ بلا المستودع ⇒ المخزون الافتتاحي', () => {
  assert.deepEqual(visibleImportKinds(importAccess({ canManageProducts: false }), ALL), ['customers', 'balances', 'ledger', 'opening_stock']);
  assert.deepEqual(visibleImportKinds(importAccess({ canManageVanStock: false }), ALL), ['customers', 'products', 'balances', 'ledger', 'prices']);
});

test('الصلاحية الغائبة مسموحة كالخادم، والمستخدم الكامل بلا ملاحظة', () => {
  const a = importAccess({});
  assert.deepEqual(visibleImportKinds(a, ALL), [...ALL]);
  assert.equal(importAccessNote(a), null);
  assert.equal(importAccessNote(importAccess(null)), null);
  assert.equal(revertAllowed(a, 'weird'), false);
  assert.equal(revertAllowed(a, undefined), false);
});

test('البند 21: المقيّد النطاق ⇒ كل البطاقات مخفية، لا تراجع، والملاحظة ظاهرة، وسجل الدفعات فارغ', () => {
  const a = importAccess({ scopeEnabled: true, canManageCustomers: true, canManageProducts: true, canManageVanStock: true });
  assert.equal(a.scoped, true);
  assert.deepEqual(visibleImportKinds(a, ALL), []);
  for (const k of ALL) { assert.equal(a.allowed[k], false); assert.equal(revertAllowed(a, k), false); }
  assert.equal(importAccessNote(a), IMPORT_SCOPED_NOTE);
  // حتى لو أعاد خادم قديم قائمة
  assert.deepEqual(batchesView(a, { data: [{ id: 'b1' }], scoped: false }), { scoped: true, list: [] });
});

test('batchesView: scoped:true من الخادم يُحترم ولو كان المستخدم المحلي غير مقيّد', () => {
  const a = importAccess({});
  assert.deepEqual(batchesView(a, { data: [], scoped: true }), { scoped: true, list: [] });
  assert.deepEqual(batchesView(a, { data: [{ id: 'b1' }], scoped: false }), { scoped: false, list: [{ id: 'b1' }] });
  assert.deepEqual(batchesView(a, undefined), { scoped: false, list: [] });
});
