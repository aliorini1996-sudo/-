// M3 — حسابات فئات المنتجات (CFG‑03، §3.8، §8.2 تبويب «فئات المنتجات»، ملحق أ `/mappings/categories`).
// قواعد الحقول صرفة، والدمج (null = الافتراضي وغياب الحقول الأربعة = حذف الصف)، وحراس ثابتة على المسارين:
// الصلاحية canConfigureLedger، وقفل الترحيل أولاً، والتدقيق داخل المعاملة، والتحقق من انتماء الفئة والحساب.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CATEGORY_ACCOUNT_FIELDS, CATEGORY_ACCOUNT_RULES, categoryAccountIssue, mergeCategoryAccounts,
} from '../routes/ledger/config';
import { MAPPING_KEY_ALLOWED_TYPES } from '../services/gl/coa/sa';

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = stripComments(fs.readFileSync(path.join(__dirname, '../routes/ledger/config.ts'), 'utf8'));

const acc = (type: string, controlKind: string | null = null, isActive = true) => ({ type, controlKind, isActive });

test('قواعد الحقول: الاحتياطي من مفاتيح الربط والأنواع المقبولة', () => {
  assert.deepEqual([...CATEGORY_ACCOUNT_FIELDS], ['incomeAccountId', 'expenseAccountId', 'cogsAccountId', 'inventoryAccountId']);
  assert.equal(CATEGORY_ACCOUNT_RULES.incomeAccountId.fallbackKey, 'SALES_REVENUE');
  assert.equal(CATEGORY_ACCOUNT_RULES.expenseAccountId.fallbackKey, 'PURCHASES');
  assert.equal(CATEGORY_ACCOUNT_RULES.cogsAccountId.fallbackKey, 'COGS');
  assert.equal(CATEGORY_ACCOUNT_RULES.inventoryAccountId.fallbackKey, 'INVENTORY_WAREHOUSE');
  assert.deepEqual(CATEGORY_ACCOUNT_RULES.cogsAccountId.allowedTypes, MAPPING_KEY_ALLOWED_TYPES.COGS);
  assert.equal(CATEGORY_ACCOUNT_RULES.inventoryAccountId.controlKind, 'INVENTORY');
});

test('categoryAccountIssue: النوع والحساب الرئيسي والأرشفة', () => {
  assert.equal(categoryAccountIssue('incomeAccountId', acc('income')), null);
  assert.equal(categoryAccountIssue('incomeAccountId', acc('income_other')), null, 'كتحقق الخطوة 3 في المعالج');
  assert.equal(categoryAccountIssue('incomeAccountId', acc('expense')), 'CATEGORY_ACCOUNT_TYPE');
  assert.equal(categoryAccountIssue('incomeAccountId', acc('income', null, false)), 'ACCOUNT_ARCHIVED');
  assert.equal(categoryAccountIssue('cogsAccountId', acc('expense_direct_cost')), null);
  assert.equal(categoryAccountIssue('expenseAccountId', acc('income')), 'CATEGORY_ACCOUNT_TYPE');
  assert.equal(categoryAccountIssue('inventoryAccountId', acc('asset_current', 'INVENTORY')), null);
  assert.equal(categoryAccountIssue('inventoryAccountId', acc('asset_current', null)), 'CATEGORY_ACCOUNT_TYPE', 'المخزون حساب رئيسي');
});

test('mergeCategoryAccounts: المرسَل يحل محل قيمته، والغائب يبقى، وnull يعيد الافتراضي', () => {
  const cur = { incomeAccountId: 'a', expenseAccountId: null, cogsAccountId: 'c', inventoryAccountId: null };
  const r = mergeCategoryAccounts(cur, { categoryId: 'k', incomeAccountId: 'b' });
  assert.deepEqual(r.next, { incomeAccountId: 'b', expenseAccountId: null, cogsAccountId: 'c', inventoryAccountId: null });
  assert.deepEqual(r.changed, ['incomeAccountId']);
  assert.equal(r.remove, false);
  const same = mergeCategoryAccounts(cur, { categoryId: 'k', incomeAccountId: 'a' });
  assert.deepEqual(same.changed, []);
  const cleared = mergeCategoryAccounts(cur, { categoryId: 'k', incomeAccountId: null, cogsAccountId: null });
  assert.deepEqual(cleared.changed, ['incomeAccountId', 'cogsAccountId']);
  assert.equal(cleared.remove, true, 'غياب الحقول الأربعة = حذف الصف (الافتراضي)');
  const fresh = mergeCategoryAccounts(null, { categoryId: 'k', inventoryAccountId: 'i' });
  assert.deepEqual(fresh.changed, ['inventoryAccountId']);
  assert.equal(fresh.remove, false);
  assert.deepEqual(mergeCategoryAccounts(null, { categoryId: 'k' }), { next: { incomeAccountId: null, expenseAccountId: null, cogsAccountId: null, inventoryAccountId: null }, changed: [], remove: true });
});

test('حراس المسارين: canConfigureLedger، قفل الترحيل أولاً، الانتماء، التدقيق داخل المعاملة', () => {
  assert.match(code, /router\.get\('\/mappings\/categories', CONFIGURE,/);
  const i = code.indexOf("router.put('/mappings/categories', CONFIGURE,");
  assert.ok(i >= 0, 'PUT /mappings/categories مفقود أو بلا CONFIGURE');
  const body = code.slice(i, code.indexOf('\n}));', i));
  const tx = body.indexOf('prisma.$transaction(');
  const lock = body.indexOf('acquirePostLock(tx, tenantId)');
  assert.ok(tx >= 0 && lock > tx, 'القفل داخل المعاملة');
  const firstTxRead = body.slice(tx).search(/tx\.\w+\.(findMany|findFirst|findUnique|upsert|deleteMany)/);
  assert.ok(lock - tx < firstTxRead, 'قفل الترحيل أول عبارة في المعاملة');
  assert.match(body, /productCategory\.findMany\(\{ where: \{ tenantId,/, 'الفئة تُتحقق بانتمائها للشركة');
  assert.match(body, /glAccount\.findMany\(\{ where: \{ tenantId,/, 'الحساب يُتحقق بانتمائه للشركة');
  assert.match(body, /GlNotFoundError\('ProductCategory'/);
  assert.match(body, /GlNotFoundError\('GlAccount'/);
  const audit = body.indexOf('appendAudit(tx,');
  assert.ok(audit > lock && audit < body.indexOf('TX_OPTS'), 'التدقيق داخل المعاملة');
  // عزل: كل كتابة على الصف بـtenantId
  // الاستدعاء قد يمتد على عدة أسطر (upsert): المطابقة حتى أول `});` يغلق معامله، والـtenantId داخل where
  const writes = [...body.matchAll(/glProductCategoryAccount\.(deleteMany|upsert)\(\{([\s\S]*?)\}\);/g)];
  assert.ok(writes.length >= 2, 'كتابتا deleteMany وupsert موجودتان');
  for (const m of writes) assert.match(m[2], /where:\s*\{[^}]*\btenantId/, m[0]);
});
