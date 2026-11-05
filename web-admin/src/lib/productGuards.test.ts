// مراجعة مخزون الشركة (S4/S6) ومراجعة المخزون (البند ٢) — حرّاس نافذة الصنف وحذفه (lib/productGuards.ts): التطبيع كما في الخادم،
// وتحذير الاسم المكرَّر من الردّ، ونصوص الإقرار بلغة الواجهة، ورصيد الحذف — وحرّاسٌ نصّية على مواضعها في النافذة والصفحة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PRODUCT_GUARD_TEXT, baseRenameAskText, deleteBalanceText, duplicateNameAskText, duplicateNameSavedText, duplicateNameWarningsOf,
  hasStockBalance, matchesText, nameMatchesOf, productNameKey, stockBalanceText, type StockSummary,
} from './productGuards';
import { PHRASES } from '../i18n/strings';

const id = (s: string) => s;
const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');

test('التطبيع كما في الخادم (services/productNames.ts): قصٌّ ودمج مسافات وأحرفٌ لاتينية صغيرة، بلا تطبيعٍ للعربية', () => {
  assert.equal(productNameKey('  كرتون   بيض M '), 'كرتون بيض m');
  assert.notEqual(productNameKey('مياة'), productNameKey('مياه'));
  assert.equal(productNameKey(undefined), '');
  const server = read('..', 'backend', 'src', 'services', 'productNames.ts');
  assert.ok(server.includes(".trim().replace(/\\s+/g, ' ').toLowerCase()"), 'تطبيع الخادم تغيّر — طابقه هنا');
});

test('تحذير DUPLICATE_NAME من ردّ الحفظ — مطابقاته، وما ليس صنفاً يُسقط، وبلا تحذيرٍ []', () => {
  const body = { success: true, data: {}, warnings: [
    { code: 'DUPLICATE_NAME', matches: [{ id: 'p1', code: 'EGG-M', name: 'كرتون بيض M', status: 'ACTIVE', archived: false }, { name: 'بلا كود' }] },
    { code: 'OTHER', matches: [{ id: 'x', code: 'X', name: 'x' }] },
  ] };
  assert.deepEqual(duplicateNameWarningsOf(body), [{ id: 'p1', code: 'EGG-M', name: 'كرتون بيض M', status: 'ACTIVE', archived: false }]);
  assert.deepEqual(duplicateNameWarningsOf({ success: true, data: {} }), []);
  assert.deepEqual(duplicateNameWarningsOf(null), []);
  assert.deepEqual(nameMatchesOf([{ code: 'A', name: 'a', archived: 'yes' }]), [{ id: null, code: 'A', name: 'a', status: 'ACTIVE', archived: false }]);
});

test('نصوص الاسم المكرَّر: كل مطابقة بكودها ووسم المحذوف والموقوف، حتى خمس', () => {
  const m = [
    { id: '1', code: 'A1', name: 'شاي', status: 'ACTIVE', archived: false },
    { id: '2', code: 'A2', name: 'شاي', status: 'INACTIVE', archived: false },
    { id: '3', code: 'A3', name: 'شاي', status: 'INACTIVE', archived: true },
  ];
  assert.equal(matchesText(m, id), 'شاي (A1)، شاي (A2 — موقوف)، شاي (A3 — محذوف)');
  assert.match(duplicateNameAskText(m, id), /^يوجد صنف بالاسم نفسه: شاي \(A1\)، .* أتحفظ على كل حال؟$/);
  assert.match(duplicateNameAskText(m, id), /فأضف له وحدة أصغر/);
  assert.match(duplicateNameSavedText(m.slice(0, 1), id), /: شاي \(A1\)$/);
  const many = Array.from({ length: 7 }, (_, i) => ({ id: String(i), code: `C${i}`, name: 'x', status: 'ACTIVE', archived: false }));
  assert.ok(matchesText(many, id).endsWith('، …'));
  assert.equal(matchesText(many, id).split('(').length - 1, 5);
});

const S = (o: Partial<StockSummary> = {}): StockSummary => ({ warehouseBase: 0, vansBase: 0, unit: 'حبة', units: [], primaryUnitId: null, ...o });
const q = (n: number) => `${n} حبة`;

test('الرصيد: غير صفري (ولو سالباً) في المستودع أو السيارات، ونصّه بلا مستودع حين الميزة مطفأة', () => {
  assert.equal(hasStockBalance(S()), false);
  assert.equal(hasStockBalance(S({ warehouseBase: null })), false);
  assert.equal(hasStockBalance(S({ warehouseBase: -25 })), true, 'السالب رصيدٌ يُذكر');
  assert.equal(hasStockBalance(S({ vansBase: 3 })), true);
  assert.equal(hasStockBalance(null), false);
  assert.equal(stockBalanceText(S({ warehouseBase: 100, vansBase: 4 }), id, q), '100 حبة في المستودع و4 حبة في السيارات');
  assert.equal(stockBalanceText(S({ warehouseBase: null, vansBase: 4 }), id, q), '4 حبة في السيارات');
});

test('إعادة تسمية الأساس: الاسمان والرصيد في نصّ الإقرار، وتوجيهٌ إلى «إضافة وحدة فرعية أصغر»', () => {
  const t = baseRenameAskText(' كرتون ', 'حبة', S({ warehouseBase: 100, vansBase: 100 }), id, q);
  assert.match(t, /من «كرتون» إلى «حبة» لا تغير الكميات/);
  assert.match(t, /\(100 حبة في المستودع و100 حبة في السيارات\)/);
  assert.match(t, /إضافة وحدة فرعية أصغر/);
});

test('تأكيد الحذف: جارٍ ⇒ «جار فحص»، وتعذّر ⇒ لا سطر، ورصيدٌ ⇒ يُذكر، وبلا رصيد ⇒ يُطمئن', () => {
  assert.equal(deleteBalanceText(undefined, id, q), PRODUCT_GUARD_TEXT.deleteChecking);
  assert.equal(deleteBalanceText(null, id, q), null);
  assert.match(deleteBalanceText(S({ warehouseBase: -14, vansBase: 0 }), id, q)!, /^للصنف رصيد الآن: -14 حبة في المستودع و0 حبة في السيارات/);
  assert.equal(deleteBalanceText(S(), id, q), PRODUCT_GUARD_TEXT.deleteNoBalance);
});

test('كل نصّ مترجمٌ بالأربع، وكل وسمٍ بين {} في كل لغة', () => {
  for (const ar of Object.values(PRODUCT_GUARD_TEXT)) {
    const e = PHRASES[ar];
    assert.ok(e, `غير مترجم: ${ar}`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) {
      assert.ok(e[lang], `${ar} بلا ${lang}`);
      for (const ph of ar.match(/\{[a-z]+\}/g) ?? []) assert.ok(e[lang].includes(ph), `${ph} غائب في ${lang}: ${ar}`);
    }
  }
});

test('حرّاس نصّية: النافذة تسأل قبل الحفظ (الاسم والأساس) وتمرّر الإقرار، والصفحة تُسقطه وتنبّه بتحذير الخادم وتذكر الرصيد في الحذف', () => {
  const modal = read('src', 'components', 'forms', 'ProductModal.tsx');
  assert.ok(modal.includes('void confirmThenSave(String(rest.name ?? \'\'), newBase, {'), 'الحفظ يمرّ بالإقرار');
  assert.equal((modal.match(/\bonSave\(/g) ?? []).length, 1, 'onSave واحد بعد الإقرار');
  const fn = modal.slice(modal.indexOf('const confirmThenSave = async'), modal.indexOf('} finally { setChecking(false); }'));
  assert.ok(fn.indexOf('fetchNameMatches(name, product?.id ?? null)') < fn.indexOf('fetchStockSummary(product.id)'));
  assert.match(fn, /if \(!window\.confirm\(duplicateNameAskText\(matches, tr\)\)\) return;/);
  assert.match(fn, /if \(s && hasStockBalance\(s\) && !window\.confirm\(baseRenameAskText\(savedBase, newBase, s, tr, qty\)\)\) return;/);
  assert.ok(modal.includes('disabled={loading || checking}'));
  const page = read('src', 'pages', 'ProductsPage.tsx');
  const save = page.slice(page.indexOf('mutationFn: async ({ listPriceEdits, ...values }: ProductSave) => {'), page.indexOf('if (!selected) return productApi.create('));
  assert.ok(save.includes('delete values.duplicateNameAck;'), 'الإقرار لا يُرسل للخادم');
  assert.ok(page.includes('onSave={(values) => saveMutation.mutate(values, {'), 'تحذير الخادم بعد الحفظ لكل حفظٍ من النافذة');
  assert.ok(page.includes('const dup = values.duplicateNameAck ? [] : duplicateNameWarningsOf('));
  assert.ok(page.includes("queryKey: ['product-stock-summary', deleting?.id]"));
  assert.ok(page.includes('extra={deleteBalanceLine ? ('));
  // الطلبان بمساري الخادم
  const api = read('src', 'lib', 'productGuardsApi.ts');
  assert.ok(api.includes("api.get('/products/name-check', { params: { name: name.trim(), ...(excludeId ? { excludeId } : {}) } })"));
  assert.ok(api.includes('api.get(`/products/${productId}/stock-summary`)'));
  const routes = read('..', 'backend', 'src', 'routes', 'products.ts');
  assert.ok(routes.includes("router.get('/name-check', requireAdmin,"));
  assert.ok(routes.includes("router.get('/:id/stock-summary', requireAdmin,"));
  assert.ok(routes.indexOf("router.get('/name-check'") < routes.indexOf("router.get('/:id',"), 'name-check قبل /:id');
});

test('جوال الإدارة (المراجعة UX3/F6): اسمٌ جديد يُفحص تكراره قبل الحفظ ويُؤكَّد، وتحذير الخادم بعده، ورصيد الصنف في تأكيد الحذف', () => {
  const m = read('src', 'm', 'MProducts.tsx');
  assert.ok(m.includes('const matches = await fetchNameMatches(form.name, product?.id ?? null);'));
  assert.ok(m.includes('if (matches && matches.length) { setDupAsk(matches); return; }'));
  assert.ok(m.includes('{duplicateNameAskText(dupAsk, tr)}'));
  assert.ok(m.includes("if (dups.length && !dupAcked.current) toast(duplicateNameSavedText(dups, tr)"));
  assert.ok(m.includes('return { lotChanged: \'lotTracked\' in lot, dups: duplicateNameWarningsOf(res?.data) };'));
  assert.ok(m.includes('queryFn: () => fetchStockSummary(product!.id),'));
  assert.ok(m.includes('{delBalanceLine && <p'));
});

test('نتيجة الاستيراد (المراجعة UX5): تحذير الاسم المكرَّر warnings.duplicateNames يُعرض بصفّه ومطابقاته', () => {
  const p = read('src', 'components', 'DataImportPanel.tsx');
  assert.ok(p.includes('duplicateNames?: { code?: string; row: number; name?: string; matches?: unknown }[];'));
  assert.ok(p.includes("const dupNames = Array.isArray(w?.duplicateNames) ? w!.duplicateNames! : [];"));
  assert.ok(p.includes('{matchesText(nameMatchesOf(d.matches), tr)}'));
  for (const k of ['أصناف أنشئت باسم موجود', 'يطابق']) {
    assert.ok(p.includes(`tr('${k}')`), k);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(PHRASES[k]?.[lang], `${k} بلا ${lang}`);
  }
});

test('الإشعارات (المراجعة UX1/F5): VAN_STOCK_REPLAY_HELD بوسمه ولونه كـLOT_REPLAY_HELD لا برمزه الخام', () => {
  const n = read('src', 'pages', 'NotificationsPage.tsx');
  assert.ok(n.includes("VAN_STOCK_REPLAY_HELD: 'بانتظار تحميل ناقص',"));
  assert.ok(n.includes("VAN_STOCK_REPLAY_HELD: 'bg-amber-100 text-amber-800',"));
});
