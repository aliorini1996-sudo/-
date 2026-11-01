import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_BASE_PRICE_LABEL, baseLabelOf, listBaseMap, listEntryFactor, listPriceEditsOf, listPriceInput, listPriceMap, listPricesCreateBody,
  listShownPrice, priceListNameProblem, priceListsOf, priceOverrides, repriceUntouched, suggestedNetOf,
} from './priceLists';
import { choiceNet, unitChoices } from '../rep/repUnits';
import { PHRASES } from '../i18n/strings';

/**
 * «أنواع الأسعار» في لوحة الإدارة: صنف «ماء» أساسه القارورة (٢)، والكرتون ٢٤ قارورة رئيسيّته بسعرٍ محدَّد ٤٥،
 * و«سعر الجملة» للكرتون ١٠٠ (مخزَّنٌ للأساس 4.166667 بست منازل كما يكتبه الخادم).
 */
const carton = { id: 'u-ctn', name: 'كرتون', factor: 24, price: 45, isActive: true };
const water = {
  id: 'p-water', unit: 'قارورة', basePrice: 2, units: [carton], primaryUnitId: 'u-ctn', baseConvertedAt: null,
  listPrices: [{ priceListId: 'l-whole', price: 4.166667 }, { priceListId: 'l-retail', price: 2.5 }],
};
const plain = { id: 'p-plain', unit: 'حبة', basePrice: 10, units: [], primaryUnitId: null, baseConvertedAt: null, listPrices: [] };
const ctnChoice = unitChoices(water)[1];
const baseChoice = unitChoices(water)[0];
const tr = (s: string) => `«${s}»`;

test('ردّ الأنواع مطبَّعاً: الصفوف الصالحة بترتيب sortOrder ثابتاً، والاسم الافتراضي null حين يُترك فارغاً', () => {
  const info = priceListsOf({
    basePriceLabel: '  ',
    lists: [{ id: 'b', name: 'سعر التجزئة', sortOrder: 1, customersCount: 3 }, null, { id: 7, name: 'تالف' }, { id: 'a', name: 'سعر الجملة', sortOrder: 0 }, { id: 'c', name: 'ج', sortOrder: 1 }],
  });
  assert.deepEqual(info.lists.map(l => l.id), ['a', 'b', 'c'], 'المتساويان بترتيب الخادم');
  assert.equal(info.lists[1].customersCount, 3);
  assert.equal(info.basePriceLabel, null);
  assert.deepEqual(priceListsOf(undefined), { basePriceLabel: null, lists: [] }, 'ردٌّ غائب ⇒ لا أنواع');
  // اسم الرقاقة الأولى: ما سمّته الشركة كما هو (بيانات لا tr)، وإلا «السعر الأساسي» مترجماً
  assert.equal(baseLabelOf({ basePriceLabel: 'سعر المستهلك' }, tr), 'سعر المستهلك');
  assert.equal(baseLabelOf(null, tr), tr(DEFAULT_BASE_PRICE_LABEL));
  assert.equal(priceListNameProblem('  '), 'اكتب اسم نوع السعر');
  assert.equal(priceListNameProblem('x'.repeat(41)), 'اسم نوع السعر 40 حرفا على الأكثر');
  assert.equal(priceListNameProblem(' سعر الجملة '), null);
});

test('القاعدة الواحدة: choiceNet بثالثه = سعر العميل ?? سعر النوع — النوع يغلب سعر الكرتون المحدَّد والأساس، والعميل يغلب النوع', () => {
  const list = listPriceMap([water, plain], 'l-whole');
  assert.deepEqual({ ...list }, { 'p-water': 4.166667 }, 'صنفٌ بلا سعرٍ في النوع خارجها');
  assert.deepEqual(listPriceMap([water], null), {}, 'السعر الافتراضي: لا شيء');
  // بلا نوع: الكرتون بسعره المحدَّد ٤٥ — وبالنوع: سعر النوع × المعامل
  assert.equal(choiceNet(ctnChoice, water.basePrice), 45);
  assert.ok(Math.abs(choiceNet(ctnChoice, water.basePrice, list[water.id]) - 100) < 1e-4);
  assert.equal(choiceNet(baseChoice, water.basePrice, list[water.id]), 4.166667);
  // سعر العميل الخاص (للأساس) يغلب النوع
  const o = priceOverrides([water, plain], 'l-whole', [{ productId: 'p-water', price: 3, unit: 'قارورة', baseConvertedAt: null }]);
  assert.equal(o['p-water'], 3);
  assert.equal(choiceNet(ctnChoice, water.basePrice, o['p-water']), 72);
  // وصفّ عميلٍ من قبل تحويل الأساس (unit = كرتون) يُعاد إلى الأساس الحالي لا يُضرب ×٢٤ مرّتين
  const pre = priceOverrides([{ ...water, baseConvertedAt: '2026-10-01T00:00:00.000Z' }], null, [{ productId: 'p-water', price: 48, unit: 'كرتون', baseConvertedAt: null }]);
  assert.equal(pre['p-water'], 2);
});

test('السعر المقترح في فاتورة الإدارة: من النوع أو العميل يُقرَّب لأربع منازل (غبار ÷٢٤ ×٢٤)، وبلاهما كما كان حرفاً', () => {
  assert.equal(suggestedNetOf(ctnChoice, water.basePrice, 4.166667), 100);
  assert.equal(suggestedNetOf(baseChoice, water.basePrice, 4.166667), 4.1667);
  assert.equal(suggestedNetOf(ctnChoice, water.basePrice), 45);
  assert.equal(suggestedNetOf(baseChoice, 2.0413), 2.0413);
  assert.equal(suggestedNetOf({ id: null, name: 'حبة', factor: 1, price: null }, '1.23456789'), 1.23456789, 'الأساس بلا تقريبٍ كما كان');
});

test('نافذة الصنف: سعر النوع يُعرض بالوحدة الرئيسية (الأساس × المعامل)، والمتغيّر وحده يُرسل، والفارغ يحذف', () => {
  assert.equal(listEntryFactor(water), 24);
  assert.equal(listEntryFactor(plain), 1, 'بلا رئيسية: الأساس');
  assert.equal(listEntryFactor({ primaryUnitId: 'u-ctn', units: [{ ...carton, isActive: false }] }), 1, 'رئيسيةٌ موقوفة ⇒ الأساس');
  const base = listBaseMap(water.listPrices);
  assert.deepEqual({ ...base }, { 'l-whole': 4.166667, 'l-retail': 2.5 });
  const shown = (id: string) => listShownPrice(base[id], 24);
  assert.equal(shown('l-whole'), '100');
  assert.equal(shown('l-retail'), '60');
  assert.equal(shown('l-none'), '');
  assert.equal(listPriceInput('١٠٠٫٥'), 100.5, 'الأرقام الهندية والفاصلة العربية');
  assert.equal(listPriceInput('  '), null);
  assert.ok(Number.isNaN(listPriceInput('abc') as number));

  const lists = [{ id: 'l-whole', name: 'سعر الجملة' }, { id: 'l-retail', name: 'سعر التجزئة' }, { id: 'l-new', name: 'سعر خاص' }];
  // لم يُلمس شيء، أو أُعيد كما كان ⇒ لا بنود
  assert.deepEqual(listPriceEditsOf(lists, {}, shown).items, []);
  assert.deepEqual(listPriceEditsOf(lists, { 'l-whole': ' 100 ' }, shown).items, []);
  const e = listPriceEditsOf(lists, { 'l-whole': '96', 'l-retail': '', 'l-new': '80' }, shown);
  assert.equal(e.problem, null);
  assert.deepEqual(e.items, [
    { priceListId: 'l-whole', price: 96 },
    { priceListId: 'l-retail', price: null },
    { priceListId: 'l-new', price: 80 },
  ]);
  // رقمٌ تالف أو سالب ⇒ اسم النوع لرسالته، ولا بنود
  assert.deepEqual(listPriceEditsOf(lists, { 'l-new': '-1' }, shown), { items: [], problem: { listId: 'l-new', name: 'سعر خاص' } });
  // الإنشاء: المكتوب وحده في listPrices، وبلا شيءٍ لا مفتاح
  assert.deepEqual(listPricesCreateBody({ items: e.items, expectedPrimary: null }), { listPrices: [{ priceListId: 'l-whole', price: 96 }, { priceListId: 'l-new', price: 80 }] });
  assert.deepEqual(listPricesCreateBody(undefined), {});
  assert.deepEqual(listPricesCreateBody({ items: [{ priceListId: 'x', price: null }], expectedPrimary: null }), {});
});

test('عدد الفرعية في الرئيسية تغيّر في الحفظ: الأنواع كلها تُرسل بسعر الكرتون المعروض فيبقى كما رآه المدير (لا ٤٨ مكان ٩٦)', () => {
  // كرتون ٢٤ قارورة، و«سعر الجملة» مخزَّنٌ للأساس 4 ⇒ الكرتون 96. المدير يغيّر العدد إلى ١٢ ولا يلمس خانة النوع
  const base: Record<string, number> = { 'l-whole': 4, 'l-retail': 4.5 };
  const shown = (id: string) => listShownPrice(base[id], 24);
  const lists = [{ id: 'l-whole', name: 'سعر الجملة' }, { id: 'l-retail', name: 'سعر التجزئة' }, { id: 'l-none', name: 'سعر خاص' }];
  assert.deepEqual(listPriceEditsOf(lists, {}, shown).items, [], 'المعامل كما هو: لا يُعاد نوعٌ لم يُلمس');
  // المعامل تغيّر: كل نوعٍ له سعرٌ يُرسل بما تعرضه خانته، والمُفرَّغ يُحذف، والنوع بلا سعرٍ لا يُرسل
  const e = listPriceEditsOf(lists, { 'l-retail': '' }, shown, true);
  assert.equal(e.problem, null);
  assert.deepEqual(e.items, [{ priceListId: 'l-whole', price: 96 }, { priceListId: 'l-retail', price: null }]);
  assert.deepEqual(listPriceEditsOf(lists, { 'l-whole': '90' }, shown, true).items, [{ priceListId: 'l-whole', price: 90 }, { priceListId: 'l-retail', price: 108 }]);
  // والخادم يقسمه على المعامل الجديد (expectedPrimary = ١٢): 96 ÷ 12 = 8 للقارورة، والكرتون 96 كما عُرض لا 4 × 12 = 48
  assert.equal(listShownPrice(96 / 12, 12), '96');
  assert.deepEqual(listPriceEditsOf(lists, { 'l-none': 'x' }, shown, true), { items: [], problem: { listId: 'l-none', name: 'سعر خاص' } });
});

test('نافذة الصنف: العدد المتغيّر يعيد الأنواع كلها، وتبديل طريقة صنفٍ جديد يمسح المسودّة، وخطأ السعر يعيد الرقاقة الأولى، والافتراضي صفراً يُسأل عنه', () => {
  const m = read('components', 'forms', 'ProductModal.tsx');
  // (١) سعر الكرتون في كل نوعٍ يبقى كما عُرض حين يتغيّر عدد الفرعية — كسعر الكرتون الافتراضي
  assert.ok(m.includes('const factorChanged = reverseLayout && !!product && !!primary && Math.round(fieldNum(rev.factor)) !== Math.round(Number(primary.factor));'));
  assert.ok(m.includes('const listEdits = listPriceEditsOf(lists, listDraft, shownList, factorChanged);'));
  // (٢) صنفٌ جديد: مسودّة الأنواع كُتبت بوحدة الطريقة السابقة (قارورة ↔ كرتون) فتُمسح مع تبديلها
  assert.match(m, /if \(!product\) \{\s*if \(m !== defMode\) \{ setListDraft\(\{\}\); setPriceTab\(null\); \}\s*setDefMode\(m\); writeDefMode\(userId, m\); return;/);
  // (٣) الطريقة العكسية: خطأ سعرٍ في خانةٍ تخفيها رقاقة نوعٍ يعيد الرقاقة الأولى
  assert.match(m, /if \(problem\) \{ if \(activeList && REVERSE_PRICE_PROBLEMS\.has\(problem\)\) setPriceTab\(null\); toast\.error\(tr\(problem\)\); return; \}/);
  // (٤) صنفٌ جديد بأسعار أنواعٍ وحدها والسعر الافتراضي المخفي صفر ⇒ الرقاقة الأولى وسؤالٌ قبل الحفظ
  assert.ok(m.includes("if (!product && !reverseLayout && listEdits.items.some(i => i.price != null) && !(Number(rest.basePrice) > 0)) {"));
  assert.ok(m.includes("if (!window.confirm(fill(tr('{label} صفر وبه تسعر فواتير العميل الذي لا نوع له — أتحفظ الصنف هكذا؟'), { label: baseLabel }))) return;"));
  // (٥) خانة السعر الافتراضي باسم الرقاقة الأولى الذي سمّته الشركة
  assert.ok(m.includes("{primary ? fill(tr('سعر {unit} الواحدة'), { unit: savedBase }) : baseLabel} *"));
});

test('قائمة الفواتير تُظهر نوع السعر تحت شارة النوع بلا طلبٍ لصفحةٍ بلا نوع، والعبارات بلا لبس، ولا مسار عميلٍ ميّت', () => {
  const page = read('pages', 'InvoicesPage.tsx');
  assert.ok(page.includes('const pricedRows = !!data?.data.some(inv => inv.priceListId);'));
  assert.ok(page.includes('enabled: accountingReady && accountingOn && pricedRows,'), 'لا طلب ما دامت الصفحة بلا فاتورةٍ لها نوع');
  assert.ok(page.includes("queryKey: ['price-lists'],"), 'مفتاح النوافذ نفسه');
  assert.ok(page.includes('data-invoice-price-type=""'));
  // «غير نوع سعر العميل» تُقرأ بلا تشكيل أمراً «غيِّر نوع سعر العميل»
  const inv = read('components', 'forms', 'InvoiceModal.tsx');
  assert.ok(inv.includes("{tr('ليس نوع سعر العميل')}"));
  assert.ok(!inv.includes("tr('غير نوع سعر العميل')"));
  // والمندوب و/m بالعبارة نفسها، وحُذف المفتاح القديم من القاموس
  for (const src of [read('rep', 'RepApp.tsx'), read('m', 'MInvoiceCreate.tsx')]) {
    assert.ok(src.includes("{tr('ليس نوع سعر العميل')}"));
    assert.ok(!src.includes("tr('غير نوع سعر العميل')"));
  }
  assert.ok(!('غير نوع سعر العميل' in PHRASES));
  assert.ok(!read('components', 'priceLists', 'PriceListsPanel.tsx').includes('ويباع به العميل'), 'العميل لا يُباع');
  assert.ok(!read('api', 'client.ts').includes("'/price-lists/prices'"), 'الإدارة تقرأ أسعار الأنواع من GET /products');
});

test('إعادة تسعير البنود: غير المعدَّل يأخذ المقترح الجديد، والمعدَّل يدويّاً يبقى بسعره ويتبع مرجعه وحده', () => {
  type L = { id: string; unitPrice: number; refPrice: number; lineTotal: number };
  const lines: L[] = [
    { id: 'a', unitPrice: 45, refPrice: 45, lineTotal: 45 },
    { id: 'b', unitPrice: 40, refPrice: 45, lineTotal: 40 },
    { id: 'c', unitPrice: 10, refPrice: 10, lineTotal: 10 },
  ];
  const fresh: Record<string, number | null> = { a: 100, b: 100, c: null };
  const next = repriceUntouched(lines, l => fresh[l.id], (l, price) => ({ ...l, unitPrice: price, lineTotal: price }));
  assert.deepEqual(next, [
    { id: 'a', unitPrice: 100, refPrice: 100, lineTotal: 100 },
    { id: 'b', unitPrice: 40, refPrice: 100, lineTotal: 40 },
    { id: 'c', unitPrice: 10, refPrice: 10, lineTotal: 10 },
  ]);
  // لا تغيّر ⇒ المصفوفة نفسها (لا رسم زائد)
  assert.equal(repriceUntouched(next, l => l.refPrice, (l) => l), next);
});

// ═══ حرّاس نصّية: الحمولات والتوصيل ═══
const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...p), 'utf8');

test('نافذة الصنف والصفحة: لقطة listPrices لا تُعاد مع الصنف، والأسعار بمسارها بعد نجاح حفظه وبأساسه من الردّ', () => {
  const m = read('components', 'forms', 'ProductModal.tsx');
  assert.ok(m.includes('const { listPrices: _listPrices, ...data } = form;'), 'نزع لقطة listPrices');
  assert.match(m, /units: _units, \.\.\.rest \} = data;/, 'نزع الوحدات كما كان');
  // والمعامل المتغيّر في الحفظ نفسه يعيد الأنواع كلها (اختبار «العدد المتغيّر» أدناه)
  assert.ok(m.includes('const listEdits = listPriceEditsOf(lists, listDraft, shownList, factorChanged);'));
  assert.ok(m.includes("expectedPrimary: reverseLayout && product && primary?.id ? { id: primary.id, factor: Math.round(fieldNum(rev.factor)) } : null"));
  // الرقاقات متى قُرئت الأنواع ولو صفراً (قرار المالك: رقاقة الافتراضي و«+»)، وفي الطريقتين فوق خانة السعر
  assert.ok(m.includes('const chipsOn = !!priceInfo;'));
  assert.equal(m.split('data-price-types=""').length - 1, 2, 'الطريقتان');
  assert.ok(m.indexOf('data-price-types=""') < m.indexOf("register('unit'"), 'فوق خانتي الوحدة والسعر');
  // خانة السعر الافتراضي باقيةٌ مسجّلة (مخفيّة خلف رقاقة نوع) فلا يضيع basePrice
  assert.ok(m.includes("{...register('basePrice', { required: !reverseLayout, valueAsNumber: true })}"));
  const page = read('pages', 'ProductsPage.tsx');
  assert.ok(page.includes('mutationFn: async ({ listPriceEdits, ...values }: ProductSave) => {'));
  assert.ok(page.includes('if (!selected) return productApi.create({ ...values, ...listPricesCreateBody(listPriceEdits) });'));
  assert.ok(page.includes('await productApi.updateListPrices(selected.id, { expectedBaseName: saved.unit, expectedPrimary: listPriceEdits.expectedPrimary, items: listPriceEdits.items });'));
  assert.ok(page.indexOf('const res = await productApi.update(selected.id, values);') < page.indexOf('await productApi.updateListPrices('), 'بعد الصنف');
});

test('فاتورة الإدارة: النوع من ملف العميل، والمفتاح خلف أنواعٍ عرّفتها الشركة وحدها، والمرتجع المرتبط بلا مفتاح', () => {
  const s = read('components', 'forms', 'InvoiceModal.tsx');
  assert.equal(s.split('...(priceListOn && { priceListId })').length - 1, 2, 'البيع والمرتجع الحرّ');
  assert.ok(s.includes('const priceListOn = priceLists.length > 0;'));
  assert.ok(s.includes('mutation.mutate(buildLinkedReturnPayload(head, linked, retDec))'), 'المرتبط كما كان');
  assert.ok(s.includes('unlinkSale(); pickCustomerList(v); }}'), 'تغيير العميل يأخذ نوعه');
  assert.ok(s.includes('const overrides = useMemo(() => priceOverrides(products, priceListId, custRows), [products, priceListId, custRows]);'));
  assert.ok(s.includes('productApi.customerPrices(customerId)'), 'أسعار العميل الخاصة');
  // الإضافة وتبديل الوحدة وتلميح المنتقي بالمقترح نفسه — لا choiceNet بلا ثالثه بعد اليوم
  assert.equal(s.split('const price = suggestedNet(p, c);').length - 1, 2);
  assert.doesNotMatch(s, /choiceNet\(c, p\.basePrice\)/);
});

test('ملف العميل والمندوب وإعدادات الشركة: «نوع السعر» يُرسل null صريحاً، و«تبديل نوع السعر»، والتبويب لصلاحية الأصناف', () => {
  const c = read('components', 'forms', 'CustomerModal.tsx');
  assert.ok(c.includes("{...register('priceListId', { setValueAs: (v: unknown) => (v ? String(v) : null) })}"));
  assert.ok(c.includes('enabled: accountingOn,'), 'لا طلب والمحاسبة مطفأة');
  assert.ok(read('components', 'forms', 'SalesRepModal.tsx').includes("<PermToggle label={tr('تبديل نوع السعر')} {...register('canChangePriceList')} />"));
  const page = read('pages', 'CompanySettingsPage.tsx');
  assert.ok(page.includes('const pricesTabOn = accountingOn && canManageProducts;'));
  assert.ok(page.includes("(tab === 'prices' && !pricesTabOn) ? 'general' : tab;"));
  assert.ok(page.includes('<PriceListsPanel />'));
  const client = read('api', 'client.ts');
  for (const k of ["list: () => api.get('/price-lists'),", "setBaseLabel: (label: string | null) => api.put('/price-lists/base-label', { label }),",
    'api.put(`/products/${id}/list-prices`, data),', 'customerPrices: (customerId: string) => api.get(`/products/customer-prices/${customerId}`),']) {
    assert.ok(client.includes(k), k);
  }
});

test('عبارات «أنواع الأسعار» مترجمةٌ بلغاتها الأربع وتُبقي عناصرها، ولا «قوائم الأسعار» (استيراد أسعار العملاء) في الميزة', () => {
  const files = [read('components', 'priceLists', 'PriceListsPanel.tsx'), read('components', 'PriceTypeChips.tsx'), read('lib', 'priceLists.ts')];
  const keys = new Set<string>(['اكتب اسم نوع السعر', 'اسم نوع السعر 40 حرفا على الأكثر', DEFAULT_BASE_PRICE_LABEL]);
  for (const f of files) for (const m of f.matchAll(/\btr\('((?:[^'\\]|\\.)*)'\)/g)) keys.add(m[1]);
  for (const k of ['نوع السعر', 'تبديل نوع السعر', 'أنواع الأسعار', 'سعر «{name}» رقم موجب', 'فارغ يعني {label}', 'ليس نوع سعر العميل', '{label} صفر وبه تسعر فواتير العميل الذي لا نوع له — أتحفظ الصنف هكذا؟']) keys.add(k);
  for (const k of keys) {
    const e = PHRASES[k];
    assert.ok(e, `غير موجودة في القاموس: ${k}`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) {
      assert.ok(e[lang]?.trim(), `${k} بلا ${lang}`);
      for (const ph of k.match(/\{\w+\}/g) ?? []) assert.ok(e[lang].includes(ph), `${k} (${lang}) بلا ${ph}`);
    }
  }
  for (const f of files) assert.ok(!f.includes("tr('قوائم الأسعار')"), 'الاسم محجوزٌ لاستيراد أسعار العملاء');
});
