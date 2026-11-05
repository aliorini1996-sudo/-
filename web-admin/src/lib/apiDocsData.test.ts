import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { API_DENIED, API_SYNC_RESOURCES, API_RATE_PER_MINUTE, API_BASE_URL, API_MAX_PAGE } from './apiDocsData';

/**
 * مستند «الربط البرمجي API» مرآةٌ للخادم — يُسلَّم لمبرمج الشركة فلا يصحّ أن يَعِد بما لا يفعله الخادم.
 * موردٌ يُضاف للمزامنة، أو بادئةٌ تُمنع على المفاتيح، أو حدٌّ يتغيّر، ولا يتغيّر هنا ⇒ يفشل هذا.
 */
const backend = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), '..', 'backend', 'src', ...p), 'utf8');

test('موارد المزامنة في المستند هي موارد الخادم نفسها — بالاسم والنمط والحذف الفعلي والصلاحية', () => {
  const src = backend('services', 'apiSync.ts');
  const server = [...src.matchAll(/name: '([a-z-]+)', model: '\w+', mode: '(\w+)'(?:, tsColumn: '\w+')?, permission: '(\w+)'[^\n]*?hardDeletes: (true|false)/g)]
    .map(m => ({ name: m[1], mode: m[2], permission: m[3], hardDeletes: m[4] === 'true' }));
  assert.ok(server.length >= 10, `قراءة موارد الخادم فشلت (${server.length})`);
  const docs = API_SYNC_RESOURCES.map(r => ({ name: r.name, mode: r.mode, permission: r.permission, hardDeletes: r.hardDeletes }));
  assert.deepEqual([...docs].sort((a, b) => a.name.localeCompare(b.name)), [...server].sort((a, b) => a.name.localeCompare(b.name)));
});

test('المسارات الممنوعة على المفتاح في المستند هي قائمة الخادم نفسها', () => {
  const src = backend('services', 'apiKeys.ts');
  const block = src.slice(src.indexOf('API_KEY_DENIED_PREFIXES'), src.indexOf(']);', src.indexOf('API_KEY_DENIED_PREFIXES')));
  const server = [...block.matchAll(/'(\/[a-z-]+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(API_DENIED.map(d => d.prefix).sort(), server);
});

test('حدّ الدقيقة وأقصى الصفحة والعنوان كما في الخادم والواجهة الحية', () => {
  assert.match(backend('services', 'apiKeys.ts'), new RegExp(`API_KEY_RATE_PER_MINUTE = ${API_RATE_PER_MINUTE};`));
  assert.match(backend('services', 'apiKeys.ts'), new RegExp(`API_KEY_MAX_PAGE = ${API_MAX_PAGE};`));
  assert.equal(API_BASE_URL, 'https://api.fieldsa.net/api');
});

test('مورد المنتجات في المستند يصف primaryUnitId وbaseConvertedAt — وهما مكشوفان في قائمة سماح الخادم', () => {
  const src = backend('services', 'apiSync.ts');
  const cols = src.slice(src.indexOf('const PRODUCT_COLS = ['), src.indexOf('];', src.indexOf('const PRODUCT_COLS = [')));
  const products = API_SYNC_RESOURCES.find(r => r.name === 'products')!;
  for (const k of ['primaryUnitId', 'baseConvertedAt']) {
    assert.ok(cols.includes(`'${k}'`), `${k} ليس في PRODUCT_COLS`);
    assert.match(products.what, new RegExp(k), `وصف المورد لا يذكر ${k}`);
  }
  assert.match(products.what, /بوحدة الأساس/);
});

test('مورد المناديب في المستند يصف defaultPriceListId وallowedPriceTypes — وهما مكشوفان في قائمة سماح الخادم', () => {
  const src = backend('services', 'apiSync.ts');
  const cols = src.slice(src.indexOf('const SALES_REP_COLS = ['), src.indexOf('];', src.indexOf('const SALES_REP_COLS = [')));
  const reps = API_SYNC_RESOURCES.find(r => r.name === 'sales-reps')!;
  for (const k of ['defaultPriceListId', 'allowedPriceTypes']) {
    assert.ok(cols.includes(`'${k}'`), `${k} ليس في SALES_REP_COLS`);
    assert.match(reps.what, new RegExp(k), `وصف المورد لا يذكر ${k}`);
  }
  assert.match(reps.what, /'base'/);
});

/** «قوائم الأسعار» (٥ نوفمبر ٢٠٢٦، اسمها السابق «أنواع الأسعار»): الموارد بالاسم الجديد، والقوائم وقواعدها ليست مورد مزامنة */
test('موارد المزامنة تصف «قوائم الأسعار» باسمها الجديد — وأسعار القوائم وقواعدها تُقرأ من /api/price-lists لا من المزامنة', () => {
  const what = (n: string) => API_SYNC_RESOURCES.find(r => r.name === n)!.what;
  assert.match(what('customers'), /«قوائم الأسعار»/);
  assert.match(what('sales-reps'), /«تبديل قائمة الأسعار»/);
  assert.ok(what('products').includes('GET /api/price-lists/prices وGET /api/price-lists/rules'), 'مورد المنتجات يدلّ على القواعد');
  for (const r of API_SYNC_RESOURCES) assert.doesNotMatch(r.what, /أنواع الأسعار|أنواع أسعار|نوع السعر|نوع سعر/, r.name);
  // لا مورد للقوائم ولا لقواعدها — في المستند وفي الخادم
  assert.ok(!API_SYNC_RESOURCES.some(r => /price-list|price-rule/.test(r.name)));
  assert.doesNotMatch(backend('services', 'apiSync.ts'), /model: 'priceList(Item|Rule)?'/);
});

/**
 * مراجعة ٥ نوفمبر (CONTRACT2 D7): مورد المنتجات كان يقول «تغيّر القواعد لا يحرّكه» وموجّه القوائم يلمس الصنف في كتابة قاعدة الصنف
 * (إنشاءً وتعديلاً وحذفاً) — ويقول «الرئيسية للعرض وحده» وبها يُحسب سعر الفئة الثابت والحد الأدنى للكمية
 */
test('مورد المنتجات: كتابة قاعدة صنفٍ تحرّك updatedAt الصنف وقواعد الفئة وكل الأصناف لا — كما يلمسه موجّه القوائم، والرئيسية مدخلٌ في القواعد', () => {
  const what = API_SYNC_RESOURCES.find(r => r.name === 'products')!.what;
  assert.doesNotMatch(what, /تغيّر القواعد لا يحرّكه/);
  assert.match(what, /قائمة أو قاعدة صنفٍ — إنشاءً وتعديلاً وحذفاً — تحرّك updatedAt الصنف/);
  assert.match(what, /أما قواعد الفئة وكل الأصناف فلا تحرّكه/);
  // الخادم: المسارات الثلاثة تلمس صنف قاعدة الصنف داخل معاملتها (touchProducts)
  const lists = backend('routes', 'priceLists.ts');
  for (const route of ["router.post('/:id/rules'", "router.put('/rules/:ruleId'", "router.delete('/rules/:ruleId'"]) {
    const at = lists.indexOf(route);
    assert.ok(at > 0, route);
    const next = lists.indexOf('\nrouter.', at + route.length);
    assert.match(lists.slice(at, next > 0 ? next : undefined), /touchProducts\(tx, tid, \[[^\]]*product\?\.id/, `${route}: لا يلمس الصنف`);
  }
  // والرئيسية ليست «للعرض وحده»: بها سعر الفئة الثابت والحد الأدنى للكمية
  assert.doesNotMatch(what, /للعرض والإدخال الافتراضي وحده/);
  assert.match(what, /سعر الفئة الثابت والحد الأدنى للكمية بالوحدة الرئيسية/);
});
