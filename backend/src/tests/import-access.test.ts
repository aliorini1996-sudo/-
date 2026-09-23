// البندان 5 و21 (مراجعة استيراد البيانات 2026-09-17): صلاحيات الاستيراد والتراجع والمستخدم مقيّد النطاق. بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ACCOUNTING_NOT_ALLOWED_MESSAGE, IMPORT_ACCOUNTING_KINDS, IMPORT_KINDS, IMPORT_KIND_PERMISSION, importAccessBody, importAccessDecision, importKindsAllowed,
  type ImportActor,
} from '../services/importAccess';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const full = (perms: Partial<Record<string, boolean | null | undefined>> = {}, scopeEnabled: boolean | null = false): ImportActor => ({
  scopeEnabled,
  perms: { canManageCustomers: true, canManageProducts: true, canManageVanStock: true, ...perms },
});

test('ربط النوع بالصلاحية والأنواع المحاسبية حسب العقد', () => {
  assert.deepEqual({ ...IMPORT_KIND_PERMISSION }, {
    customers: 'canManageCustomers', balances: 'canManageCustomers', ledger: 'canManageCustomers',
    products: 'canManageProducts', prices: 'canManageProducts', opening_stock: 'canManageVanStock',
  });
  assert.deepEqual([...IMPORT_ACCOUNTING_KINDS].sort(), ['balances', 'ledger', 'opening_stock', 'prices', 'products']);
  // نص requireAccounting نفسه
  assert.ok(read('middleware/auth.ts').includes(`message: '${ACCOUNTING_NOT_ALLOWED_MESSAGE}'`));
});

test('سيناريو البند 5: محاسب سُحبت منه صلاحية العملاء ⇒ 403 IMPORT_PERMISSION_DENIED للعملاء والأرصدة والكشوف، ويبقى المنتجات', () => {
  const accountant = full({ canManageCustomers: false });
  for (const kind of ['customers', 'balances', 'ledger'] as const) {
    const d = importAccessDecision(accountant, kind);
    assert.equal(d.ok, false, kind);
    if (d.ok) continue;
    assert.equal(d.status, 403);
    assert.equal(d.code, 'IMPORT_PERMISSION_DENIED');
    assert.equal(d.message, 'لا تملك صلاحية استيراد هذا النوع من البيانات');
    assert.deepEqual(d.details, { kind, permission: 'canManageCustomers' });
    assert.deepEqual(importAccessBody(d), {
      success: false, code: 'IMPORT_PERMISSION_DENIED', message: 'لا تملك صلاحية استيراد هذا النوع من البيانات', kind, permission: 'canManageCustomers',
    });
  }
  assert.equal(importAccessDecision(accountant, 'products').ok, true);
  assert.deepEqual(importKindsAllowed(accountant), ['products', 'prices', 'opening_stock']);
  // المنتجات والأسعار
  const noProducts = full({ canManageProducts: false });
  assert.equal(importAccessDecision(noProducts, 'products').ok, false);
  assert.equal(importAccessDecision(noProducts, 'prices').ok, false);
  // المستودع
  const noVan = full({ canManageVanStock: false });
  const d = importAccessDecision(noVan, 'opening_stock');
  assert.ok(!d.ok && d.code === 'IMPORT_PERMISSION_DENIED' && d.details.permission === 'canManageVanStock');
});

test('سيناريو البند 21: مقيّد النطاق ⇒ IMPORT_SCOPED_ADMIN لكل الأنواع وللتراجع قبل البحث عن الدفعة، ولا دفعات', () => {
  const scoped = full({}, true);
  for (const kind of [...IMPORT_KINDS, null]) {
    const d = importAccessDecision(scoped, kind);
    assert.ok(!d.ok, String(kind));
    if (d.ok) continue;
    assert.equal(d.code, 'IMPORT_SCOPED_ADMIN');
    assert.equal(d.message, 'حسابك مقيّد بنطاق عملاء محدد، واستيراد البيانات والتراجع عنها على مستوى الشركة كلها، فيتولاها مستخدم غير مقيّد');
    assert.deepEqual(importAccessBody(d), { success: false, code: 'IMPORT_SCOPED_ADMIN', message: d.message });
  }
  assert.deepEqual(importKindsAllowed(scoped), []);
});

test('null وundefined في الصلاحيات ⇒ مسموح (افتراضها true)، وصف المدير الغائب والنوع المجهول ⇒ مرفوض', () => {
  const nulls: ImportActor = { scopeEnabled: null, perms: { canManageCustomers: null, canManageProducts: undefined } };
  for (const kind of IMPORT_KINDS) assert.equal(importAccessDecision(nulls, kind).ok, true, kind);
  assert.equal(importAccessDecision(nulls, null).ok, true);
  assert.deepEqual(importKindsAllowed(nulls), [...IMPORT_KINDS]);
  assert.equal(importAccessDecision(null, 'customers').ok, false);
  assert.equal(importAccessDecision(undefined, null).ok, false);
  assert.deepEqual(importKindsAllowed(null), []);
  const unknown = importAccessDecision(full(), 'legacy_kind');
  assert.ok(!unknown.ok && unknown.code === 'IMPORT_PERMISSION_DENIED');
});

// ═══ حراس ثابتة على routes/import.ts ═══

function handlerBody(src: string, marker: string): string {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `لم يُعثر على ${marker}`);
  const end = src.indexOf('\nrouter.', start + marker.length);
  return src.slice(start, end < 0 ? undefined : end);
}

test('حارس ثابت: كل مسار كتابة يحمل requireImportAccess(نوعه)، والمخزون الافتتاحي بلا فحص محاسبي مكرر', () => {
  const src = read('routes/import.ts');
  const routes: [string, string][] = [
    ['/customers', 'customers'], ['/products', 'products'], ['/balances', 'balances'], ['/ledger', 'ledger'], ['/prices', 'prices'], ['/opening-stock', 'opening_stock'],
  ];
  for (const [p, kind] of routes) {
    const line = src.split('\n').find((l) => l.startsWith(`router.post('${p}',`));
    assert.ok(line, `المسار مفقود: ${p}`);
    assert.ok(line!.includes(`requireImportAccess('${kind}'`), `${p} بلا requireImportAccess('${kind}')`);
  }
  // لا مسار post آخر بلا حارس
  const posts = src.split('\n').filter((l) => l.startsWith('router.post('));
  for (const l of posts) {
    if (l.startsWith("router.post('/batches/:id/revert'")) continue;
    assert.match(l, /requireImportAccess\('/, l);
  }
  const os = src.split('\n').find((l) => l.startsWith("router.post('/opening-stock',"))!;
  assert.match(os, /requireImportAccess\('opening_stock', \{ accounting: false \}\), requireAccounting,/);
  // /products لا يكرر requireAccounting بعد الوسيط (الوسيط يطبقه)
  assert.doesNotMatch(src.split('\n').find((l) => l.startsWith("router.post('/products',"))!, /, requireAccounting,/);
  const access = read('services/importAccess.ts');
  assert.match(access, /await requireAccounting\(req, res, next\)/);
  assert.match(access, /select: \{ scopeEnabled: true, canManageCustomers: true, canManageProducts: true, canManageVanStock: true \}/);
});

test('حارس ثابت: التراجع يفحص النطاق قبل findFirst وصلاحية النوع والنظام المحاسبي قبل أي معاملة؛ GET /batches يرشّح بالأنواع', () => {
  const src = read('routes/import.ts');
  const rv = handlerBody(src, "router.post('/batches/:id/revert'");
  const order = ['loadImportActor(req)', 'importAccessDecision(actor, null)', 'prisma.importBatch.findFirst(', 'importAccessDecision(actor, batch.kind)',
    'isImportAccountingKind(batch.kind)', "'ACCOUNTING_NOT_ALLOWED'", 'assertBatchRevertible('];
  let pos = -1;
  for (const n of order) {
    const i = rv.indexOf(n, pos + 1);
    assert.ok(i > pos, `التراجع: ${n} خارج الترتيب`);
    pos = i;
  }
  assert.ok(rv.indexOf('importAccessDecision(actor, batch.kind)') < rv.indexOf('prisma.$transaction('), 'صلاحية النوع بعد المعاملة');
  // التراجع عن الأسعار بمستأجر الشركة لا بالمعرّف وحده
  const prices = rv.slice(rv.indexOf("batch.kind === 'prices'"), rv.indexOf('batch.kind === OPENING_STOCK_KIND'));
  assert.doesNotMatch(prices, /deleteMany\(\{ where: \{ id: \{ in: ids \} \} \}\)/);
  assert.match(prices, /customer: \{ tenantId: tid \}/);

  const batches = handlerBody(src, "router.get('/batches'");
  assert.match(batches, /const actor = await loadImportActor\(req\);/);
  // البند 52: المقيّد النطاق يردّ صفحة فارغة مغلقة (لا cursor يطلبه) قبل أي قراءة
  assert.match(batches, /if \(actor\?\.scopeEnabled === true\) \{ res\.json\(\{ success: true, data: \[\], hasMore: false, nextCursor: null, scoped: true \}\); return; \}/);
  assert.match(batches, /kind: \{ in: importKindsAllowed\(actor\) \}/);
  assert.match(batches, /scoped: false/);
  assert.ok(batches.indexOf('loadImportActor(') < batches.indexOf('prisma.importBatch.findMany('));
});

// ═══ الدفعة 3 (البند 52): تصفّح سجلّ الدفعات — بعد الخمسين لا يبقى التراجع عن دفعة قديمة مستحيلاً ═══

/** ترقيم المسار نفسه: take = limit + 1 يحسم hasMore، والصفّ الزائد يُقصّ، وnextCursor آخر معروض */
function pageOf(all: readonly { id: string }[], cursor: string | null, limit: number) {
  const from = cursor ? all.findIndex((b) => b.id === cursor) + 1 : 0; // skip:1 بعد الدفعة المعروضة
  const taken = all.slice(from, from + limit + 1);
  const hasMore = taken.length > limit;
  const rows = hasMore ? taken.slice(0, limit) : taken;
  return { rows, hasMore, nextCursor: hasMore && rows.length ? rows[rows.length - 1].id : null };
}

test('سيناريو البند 52: 120 دفعة ⇒ ثلاث صفحات متتابعة بلا تكرار ولا فقد، وآخرها hasMore=false ونهاية التصفّح', () => {
  const all = Array.from({ length: 120 }, (_, i) => ({ id: `b${i + 1}` })); // مرتّبة createdAt desc
  const p1 = pageOf(all, null, 50);
  assert.equal(p1.rows.length, 50);
  assert.deepEqual([p1.hasMore, p1.nextCursor], [true, 'b50']);
  const p2 = pageOf(all, p1.nextCursor, 50);
  assert.deepEqual([p2.rows[0].id, p2.rows[49].id, p2.hasMore, p2.nextCursor], ['b51', 'b100', true, 'b100']);
  const p3 = pageOf(all, p2.nextCursor, 50);
  assert.deepEqual([p3.rows[0].id, p3.rows.length, p3.hasMore, p3.nextCursor], ['b101', 20, false, null]);
  // لا تكرار ولا فقد: الصفحات الثلاث = السجلّ كله بالترتيب نفسه
  const seen = [...p1.rows, ...p2.rows, ...p3.rows].map((b) => b.id);
  assert.deepEqual(seen, all.map((b) => b.id));
  assert.equal(new Set(seen).size, 120);
  // صفحة ممتلئة تماماً بلا خلفها: hasMore=false فلا يدّعي الزرّ وجود أقدم
  const exact = pageOf(all.slice(0, 50), null, 50);
  assert.deepEqual([exact.rows.length, exact.hasMore, exact.nextCursor], [50, false, null]);
  // سجلّ فارغ
  assert.deepEqual(pageOf([], null, 50), { rows: [], hasMore: false, nextCursor: null });
});

test('حارس ثابت (البند 52): GET /batches يقبل cursor وlimit بحدّ أعلى، ويعيد hasMore وnextCursor بالترتيب نفسه', () => {
  const src = read('routes/import.ts');
  const body = handlerBody(src, "router.get('/batches'");
  assert.match(src, /const BATCHES_PAGE_SIZE = 50;/, 'حجم الصفحة الافتراضي = سلوك ما قبل التصفّح');
  assert.match(src, /const BATCHES_PAGE_MAX = 200;/);
  assert.match(src, /cursor: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(64\)\.optional\(\),/);
  assert.match(src, /limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(BATCHES_PAGE_MAX\)\.optional\(\),/);
  assert.match(body, /const limit = q\.limit \?\? BATCHES_PAGE_SIZE;/);
  // الترتيب نفسه مع فاصل حاسم (id) فلا تتكرر دفعتان بالثانية نفسها ولا تسقط واحدة بين صفحتين
  assert.match(body, /orderBy: \[\{ createdAt: 'desc' \}, \{ id: 'desc' \}\], take: limit \+ 1,/);
  assert.match(body, /\.\.\.\(q\.cursor \? \{ skip: 1, cursor: \{ id: q\.cursor \} \} : \{\}\),/);
  assert.match(body, /const hasMore = page\.length > limit;/);
  assert.match(body, /nextCursor: hasMore && batches\.length \? batches\[batches\.length - 1\]\.id : null/);
  // العزل والصلاحيات كما هي: الشركة ونوعها في where نفسه، والصفحة لا تتخطاهما
  assert.match(body, /where: \{ tenantId: tid, reverted: false, kind: \{ in: importKindsAllowed\(actor\) \} \}/);
});
