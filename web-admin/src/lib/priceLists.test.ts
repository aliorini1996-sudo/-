import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_BASE_PRICE_LABEL, baseLabelOf, listBaseMap, listEntryFactor, listPriceEditsOf, listPriceInput, listPriceMap, listPricesCreateBody,
  listShownPrice, priceListNameProblem, priceListsOf, priceOverrides, repriceUntouched, suggestedNetOf,
  BASE_PRICE_TYPE, allowedPriceTypesOf, defaultPriceTypeOf, priceTypeAllowed, switchablePriceTypesOf,
  priceListInUseMessage, repAllowedTokensOf, repDefaultChoices, repPriceTypeTokens, repPriceTypesSummary, repToggleAllowedType,
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
  // والمندوب و/m بالعبارة نفسها (و/m قد يختار بينها و«ليس نوع سعر المندوب» حين يأتي الافتراضي من المندوب)، وحُذف
  // المفتاح القديم من القاموس
  for (const src of [read('rep', 'RepApp.tsx'), read('m', 'MInvoiceCreate.tsx')]) {
    assert.match(src, /\{tr\([^)]*'ليس نوع سعر العميل'/);
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

// ═══ نوع سعر المندوب (طلب المالك ٢ نوفمبر ٢٠٢٦): الافتراضي = نوع العميل ?? نوع المندوب ?? الأساسي، والمسموح بلا قيد = كل الأنواع ═══
const BACKEND_PRICE_LISTS = path.resolve(process.cwd(), '..', 'backend', 'src', 'services', 'priceLists.ts');
const SHARED_MARK = '// ═══ نوع سعر المندوب (طلب المالك ٢ نوفمبر ٢٠٢٦)';
const sharedBlock = (src: string) => src.replace(/\r\n/g, '\n').slice(src.replace(/\r\n/g, '\n').indexOf(SHARED_MARK)).trimEnd();

test('نوع سعر المندوب: النسخة المشتركة مطابقةٌ لنسخة الخادم حرفاً (من علامتها إلى آخر الملف)', () => {
  const web = read('lib', 'priceLists.ts');
  const server = fs.readFileSync(BACKEND_PRICE_LISTS, 'utf8');
  assert.ok(web.includes(SHARED_MARK) && server.includes(SHARED_MARK), 'العلامة في النسختين');
  assert.equal(sharedBlock(web), sharedBlock(server));
});

test('نوع الفاتورة الافتراضي: نوع العميل يغلب نوع المندوب، والمندوب يغلب السعر الأساسي (null)', () => {
  assert.equal(defaultPriceTypeOf('l-cust', 'l-rep'), 'l-cust');
  assert.equal(defaultPriceTypeOf(null, 'l-rep'), 'l-rep');
  assert.equal(defaultPriceTypeOf(undefined, 'l-rep'), 'l-rep');
  assert.equal(defaultPriceTypeOf('l-cust', null), 'l-cust');
  assert.equal(defaultPriceTypeOf(null, null), null, 'لا نوع للعميل ولا للمندوب ⇒ الأساسي كاليوم');
  assert.equal(defaultPriceTypeOf('', ''), null, 'النصّ الفارغ لا نوع');
});

test('الأنواع المسموحة من عمود JSON: null بلا قيد، و«base» = null، بلا تكرار بترتيبها، وما ليس نصّاً يُهمل', () => {
  assert.equal(BASE_PRICE_TYPE, 'base');
  assert.equal(allowedPriceTypesOf(null), null);
  assert.equal(allowedPriceTypesOf(undefined), null);
  assert.equal(allowedPriceTypesOf({ a: 1 }), null, 'ليس مصفوفة ⇒ بلا قيد');
  assert.deepEqual(allowedPriceTypesOf(['l-b', 'base', 'l-b', 7, '', null, 'l-a']), ['l-b', null, 'l-a']);
  assert.deepEqual(allowedPriceTypesOf([]), [], 'المصفوفة الفارغة تبقى فارغة');
});

test('التبديل: بلا قيد كل شيء، وبالقيد افتراضيّ الفاتورة (نوع العميل) دائماً والمسموح وحده', () => {
  assert.equal(priceTypeAllowed('l-x', null, null), true);
  assert.equal(priceTypeAllowed(null, null, 'l-a'), true);
  const allowed = allowedPriceTypesOf(['base', 'l-whole']);
  assert.equal(priceTypeAllowed(null, allowed, 'l-whole'), true, 'الأساسي مسموح');
  assert.equal(priceTypeAllowed('l-whole', allowed, null), true);
  assert.equal(priceTypeAllowed('l-retail', allowed, null), false, 'غير المسموح ⇒ 403 في الخادم');
  assert.equal(priceTypeAllowed('l-vip', allowed, 'l-vip'), true, 'نوع العميل نفسه متاحٌ دائماً');
  assert.equal(priceTypeAllowed(null, ['l-whole'], 'l-whole'), false, 'الأساسي خارج المسموح');
});

test('الأنواع التي يبدّل بينها المندوب: الافتراضي أولاً ثم المسموح (أو الأساسي وكل الأنواع) بلا تكرار، والمحذوف يُسقط', () => {
  const all = ['l-whole', 'l-retail', 'l-vip'];
  assert.deepEqual(switchablePriceTypesOf(null, null, all), [null, 'l-whole', 'l-retail', 'l-vip'], 'بلا قيد = اليوم');
  assert.deepEqual(switchablePriceTypesOf(null, 'l-retail', all), ['l-retail', null, 'l-whole', 'l-vip']);
  assert.deepEqual(switchablePriceTypesOf(['l-whole', null], 'l-vip', all), ['l-vip', 'l-whole', null], 'نوع العميل مع المسموح');
  assert.deepEqual(switchablePriceTypesOf(['l-whole', 'l-gone'], 'l-whole', all), ['l-whole'], 'معرّفٌ لم يعد في الشركة يُسقط');
  assert.deepEqual(switchablePriceTypesOf([], null, all), [null], 'لا مسموح إلا الافتراضي');
  // المسموح بعد allowedPriceTypesOf: «base» صار null — فالأساسي يلحق بنوع العميل
  assert.deepEqual(switchablePriceTypesOf(allowedPriceTypesOf(['base']), 'l-whole', all), ['l-whole', null]);
});

test('نافذة المندوب: الخانات بترتيب الشركة، والافتراضي يتبع المحدَّد، وآخر خانةٍ تُلغى ⇒ كل الأنواع (null)', () => {
  const all = ['l-whole', 'l-retail'];
  assert.deepEqual(repPriceTypeTokens(all), ['base', 'l-whole', 'l-retail']);
  assert.equal(repAllowedTokensOf(null, all), null);
  assert.deepEqual(repAllowedTokensOf(['l-retail', 'base', 'l-gone'], all), ['base', 'l-retail'], 'بترتيب الشركة والمحذوف يُسقط');
  assert.equal(repAllowedTokensOf(['l-gone'], all), null, 'لا شيء صالح ⇒ لا تحديد');
  // من «كل الأنواع» إلى أوّل خانة: الافتراضي المحفوظ يُحدَّد معها ويبقى — لا يصير «التجزئة» في الخفاء (فواتير عملاءٍ بلا نوع)
  let st = repToggleAllowedType({ allowed: null, defaultId: 'l-whole' }, 'l-retail', true, all);
  assert.deepEqual(st, { allowed: ['l-whole', 'l-retail'], defaultId: 'l-whole' }, 'الافتراضي باقٍ ومحدَّد');
  assert.deepEqual(repToggleAllowedType({ allowed: null, defaultId: null }, 'l-retail', true, all), { allowed: ['base', 'l-retail'], defaultId: null },
    'الافتراضي الأساسي يُحدَّد معها كذلك');
  assert.deepEqual(repToggleAllowedType({ allowed: null, defaultId: 'l-whole' }, 'l-whole', true, all), { allowed: ['l-whole'], defaultId: 'l-whole' });
  // إلغاء الافتراضي بيد المدير ⇒ أوّل المحدَّد — فلا يُرسل افتراضيٌّ خارج المسموح
  st = repToggleAllowedType(st, 'l-whole', false, all);
  assert.deepEqual(st, { allowed: ['l-retail'], defaultId: 'l-retail' });
  st = repToggleAllowedType(st, 'base', true, all);
  assert.deepEqual(st, { allowed: ['base', 'l-retail'], defaultId: 'l-retail' }, 'الافتراضي باقٍ ما دام محدَّداً');
  st = repToggleAllowedType(st, 'l-retail', false, all);
  assert.deepEqual(st, { allowed: ['base'], defaultId: null }, 'إلغاء الافتراضي ⇒ أوّل المحدَّد (الأساسي = null)');
  st = repToggleAllowedType(st, 'base', false, all);
  assert.deepEqual(st, { allowed: null, defaultId: null }, 'لا تحديد = كل الأنواع');
  assert.deepEqual(repToggleAllowedType({ allowed: null, defaultId: null }, 'base', true, all), { allowed: ['base'], defaultId: null });
  // خيارات «النوع الافتراضي»: المحدَّد وحده، أو الأساسي وكل الأنواع
  assert.deepEqual(repDefaultChoices(null, all), [null, 'l-whole', 'l-retail']);
  assert.deepEqual(repDefaultChoices(['base', 'l-retail'], all), [null, 'l-retail']);
  // والحمولة رموزٌ يقبلها الخادم كما هي: allowedPriceTypesOf يعيدها إلى قاعدة التبديل
  assert.deepEqual(allowedPriceTypesOf(['base', 'l-retail']), [null, 'l-retail']);
});

test('جدول المناديب ورسالة الحذف: الافتراضي باسمه وما يبدّل بينه، وعدد العملاء والمناديب على النوع مترجماً', () => {
  const info = { basePriceLabel: null, lists: [{ id: 'l-whole', name: 'سعر الجملة', sortOrder: 0 }, { id: 'l-retail', name: 'سعر التجزئة', sortOrder: 1 }] };
  assert.deepEqual(repPriceTypesSummary({ defaultPriceListId: 'l-whole', allowedPriceTypes: null, canChangePriceList: true }, info, tr),
    { defaultName: 'سعر الجملة', switchable: tr('كل الأنواع') });
  assert.deepEqual(repPriceTypesSummary({ defaultPriceListId: null, allowedPriceTypes: ['l-retail', 'base'], canChangePriceList: true }, info, tr),
    { defaultName: tr(DEFAULT_BASE_PRICE_LABEL), switchable: `${tr(DEFAULT_BASE_PRICE_LABEL)}، سعر التجزئة` });
  assert.deepEqual(repPriceTypesSummary({ defaultPriceListId: 'l-retail', allowedPriceTypes: ['l-retail'], canChangePriceList: false }, { ...info, basePriceLabel: 'سعر المستهلك' }, tr),
    { defaultName: 'سعر التجزئة', switchable: tr('بلا تبديل') });
  assert.equal(repPriceTypesSummary({}, { ...info, basePriceLabel: 'سعر المستهلك' }, tr).defaultName, 'سعر المستهلك', 'صفٌّ بلا المفتاح ⇒ الأساسي باسم الشركة');
  const id = (s: string) => s;
  assert.equal(priceListInUseMessage({ code: 'PRICE_LIST_IN_USE', customersCount: 3, repsCount: 2 }, id), 'نوع السعر مستخدم لعملاء (3) ومناديب (2) انقلهم إلى نوع آخر أولا');
  assert.equal(priceListInUseMessage({ code: 'PRICE_LIST_IN_USE', customersCount: 0, repsCount: 1 }, id), 'نوع السعر مستخدم لمناديب (1) أزله من نوعهم الافتراضي وأنواعهم المسموحة أولا');
  assert.equal(priceListInUseMessage({ code: 'PRICE_LIST_IN_USE', customersCount: 4 }, id), 'نوع السعر مستخدم لعملاء (4) انقلهم إلى نوع آخر من ملفاتهم أولا', 'خادمٌ بلا repsCount');
  assert.equal(priceListInUseMessage({ code: 'PRICE_LIST_INVALID' }, id), null, 'غيرها ⇒ رسالة الخادم');
  assert.equal(priceListInUseMessage(undefined, id), null);
});

test('نافذة المندوب والجدول والإعدادات: القسم خلف أنواعٍ عرّفتها الشركة، والحقلان يُرسلان مع النموذج، والحذف يقول المناديب', () => {
  const m = read('components', 'forms', 'SalesRepModal.tsx');
  assert.ok(m.includes('const priceLists = accountingOn && (!rep || rep.defaultPriceListId !== undefined) ? priceInfo?.lists ?? [] : [];'), 'صفٌّ بلا المفتاح بلا قسم');
  assert.ok(m.includes('enabled: accountingOn,'), 'لا طلب والمحاسبة مطفأة');
  assert.ok(m.includes('{priceLists.length > 0 && ('), 'القسم لشركةٍ عرّفت أنواعاً');
  assert.ok(m.includes('defaultPriceListId: defaults.defaultPriceListId ?? null, allowedPriceTypes: defaults.allowedPriceTypes ?? null,'));
  assert.ok(m.includes("setValue('allowedPriceTypes', next.allowed, { shouldDirty: true });"));
  assert.ok(m.includes("setValue('defaultPriceListId', next.defaultId, { shouldDirty: true });"));
  assert.ok(m.includes("onChange={e => setValue('defaultPriceListId', e.target.value || null, { shouldDirty: true })}"), 'الأساسي = null صريحاً');
  assert.ok(m.includes('{repDefaultChoices(allowedTok, listIds).map('), 'الافتراضي من المحدَّد وحده');
  assert.ok(m.indexOf('data-rep-price-types=""') > m.indexOf("register('canChangePriceList')"), 'بعد صلاحيات التسعير');
  const page = read('pages', 'SalesRepsPage.tsx');
  assert.ok(page.includes('const priceTypesCol = accountingOn && (priceInfo?.lists.length ?? 0) > 0 ? priceInfo : null;'));
  assert.ok(page.includes('const repCols = (accountingOn ? 13 : 6) + (priceTypesCol ? 1 : 0);'), 'عرض صفّ التحميل يتبع العمود');
  const panel = read('components', 'priceLists', 'PriceListsPanel.tsx');
  assert.ok(panel.includes('toast.error(priceListInUseMessage((e as Err)?.response?.data, tr) ?? errMsg(e, tr(\'تعذر الحذف\')), { duration: 7000 });'));
  for (const f of [m, page, panel, read('lib', 'priceLists.ts')]) {
    for (const k of f.matchAll(/\btr\('((?:[^'\\]|\\.)*)'\)/g)) {
      const e = PHRASES[k[1]];
      assert.ok(e, `غير موجودة في القاموس: ${k[1]}`);
      for (const lang of ['en', 'fr', 'tr', 'zh'] as const) {
        assert.ok(e[lang]?.trim(), `${k[1]} بلا ${lang}`);
        for (const ph of k[1].match(/\{\w+\}/g) ?? []) assert.ok(e[lang].includes(ph), `${k[1]} (${lang}) بلا ${ph}`);
      }
    }
  }
  // عبارات الشاشات الأخرى (تطبيق المندوب وفاتورة الإدارة و/m) جاهزةٌ في القاموس
  for (const k of ['نوع المندوب', 'نوع سعر العميل', 'نوع السعر الافتراضي', 'الأنواع المسموحة', 'كل الأنواع', 'نوع السعر غير مسموح لك', 'لا تملك صلاحية تبديل نوع السعر']) {
    assert.ok(PHRASES[k]?.zh, k);
  }
});
