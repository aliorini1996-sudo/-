import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PRICE_LIST_ITEMS_PAGE, RULE_FORM_MESSAGES, emptyRuleDraft, fillText, itemCommitOf, itemShownPrice, itemsPageOf, patchItemsPage,
  percentShown, priceListCountsText, ruleDatesText, ruleDraftOf, ruleFixedShown, ruleFormKindOf, ruleInputOf, ruleSummaryText,
  ruleTimingOf, savedItemsOf, type RuleProductRef,
} from './priceListEditor';
import { PRICE_RULE_MESSAGES } from './priceRules';
import type { PriceListItemRow, PriceListRule } from '../types';

/**
 * «قوائم الأسعار» بقواعدها (طلب المالك ٥ نوفمبر ٢٠٢٦) — محرّر القائمة: «ماء» أساسه القارورة والكرتون ٢٤ رئيسيّته،
 * و«سكر» بلا رئيسية (الكيلو). وtr هنا يلفّ النصّ بعلامتين فيُرى أنه مرّ بالترجمة.
 */
const tr = (s: string) => `«${s}»`;
/** Intl يفصل المدى بمسافاتٍ رقيقة (U+2009) — تُقرأ مسافاتٍ عادية */
const THIN_SPACES = new RegExp(`[${String.fromCharCode(0x2009, 0x202f)}]`, 'g');
const norm = (s: string | null) => (s === null ? null : s.replace(THIN_SPACES, ' '));
const id = (s: string) => s;
const carton = { id: 'u-ctn', name: 'كرتون', factor: 24 };
const waterRow: PriceListItemRow = {
  productId: 'p-water', code: 'W1', name: 'ماء', categoryId: 'c-drinks', categoryName: 'مشروبات', unit: 'قارورة',
  primaryUnit: carton, defaultPrice: 45, listPrice: 100,
};
const sugarRow: PriceListItemRow = {
  productId: 'p-sugar', code: 'S1', name: 'سكر', categoryId: null, categoryName: null, unit: 'كيلو', primaryUnit: null,
  defaultPrice: 7, listPrice: null,
};
const rule = (r: Partial<PriceListRule>): PriceListRule => ({
  id: 'r1', priceListId: 'l1', scope: 'category', productId: null, categoryId: 'c-juice', kind: 'percent', basePrice: null,
  primaryPrice: null, percent: 10, minQty: 0, startsOn: null, endsOn: null, ...r,
});

test('صفّ القائمة: «{n} صنف · {m} قاعدة · {k} عميل» — وخادمٌ بلا العدّين يبقي عدد العملاء وحده', () => {
  assert.equal(priceListCountsText({ itemsCount: 12, rulesCount: 3, customersCount: 5 }, id), '12 صنف · 3 قاعدة · 5 عميل');
  assert.equal(priceListCountsText({ itemsCount: 0, rulesCount: 0 }, id), '0 صنف · 0 قاعدة · 0 عميل');
  assert.equal(priceListCountsText({ customersCount: 2 }, id), '2 عميل', 'خادمٌ قبل الميزة');
  assert.equal(priceListCountsText({ itemsCount: 1, rulesCount: 2, customersCount: 3 }, tr), '«1 صنف» · «2 قاعدة» · «3 عميل»');
  assert.equal(priceListCountsText({ itemsCount: 1, rulesCount: 0, customersCount: 0 }, id, (n) => `#${n}`), '#1 صنف · #0 قاعدة · #0 عميل');
  assert.equal(fillText('{a} و{b} و{c}', { a: '{b}', b: 2 }), '{b} و2 و{c}', 'القيم لا يُعاد فحصها والمجهول يبقى');
});

test('ردّ أصناف القائمة مطبَّعاً: سعرٌ تالف ⇒ ليس في القائمة، والترقيم بقيمٍ آمنة', () => {
  const p = itemsPageOf({
    rows: [{ ...waterRow, listPrice: '100' }, { ...sugarRow, listPrice: 'x' }, null, { name: 'بلا معرّف' }],
    pagination: { total: 120, page: 2, limit: 50, pages: 3 }, pricedCount: 7,
  });
  assert.deepEqual(p.rows.map((r) => [r.productId, r.listPrice]), [['p-water', 100], ['p-sugar', null]]);
  assert.deepEqual(p.pagination, { total: 120, page: 2, limit: 50, pages: 3 });
  assert.equal(p.pricedCount, 7);
  const empty = itemsPageOf(undefined);
  assert.deepEqual(empty, { rows: [], pagination: { total: 0, page: 1, limit: PRICE_LIST_ITEMS_PAGE, pages: 1 }, pricedCount: 0 });
  assert.equal(itemShownPrice(4.16666), '4.1667');
  assert.equal(itemShownPrice(null), '');
  assert.equal(itemShownPrice(100), '100');
});

test('الحفظ التلقائي للسطر: المعاد كما كان لا يُرسل، والفارغ يحذف، والتالف رسالة، والكتابة بأساس الصنف ورئيسيّته', () => {
  assert.deepEqual(itemCommitOf(waterRow, '100'), { kind: 'same' });
  assert.deepEqual(itemCommitOf(waterRow, ' 100.0 '), { kind: 'same' }, '«100.0» هو «100»');
  assert.deepEqual(itemCommitOf(waterRow, '١٠٠'), { kind: 'same' }, 'الأرقام الهندية');
  assert.deepEqual(itemCommitOf(sugarRow, ''), { kind: 'same' }, 'فارغٌ لصنفٍ ليس في القائمة: لا شيء');
  assert.deepEqual(itemCommitOf(sugarRow, undefined), { kind: 'same' });
  assert.deepEqual(itemCommitOf(waterRow, '96'), {
    kind: 'write', write: { productId: 'p-water', price: 96, expectedBaseName: 'قارورة', expectedPrimary: { id: 'u-ctn', factor: 24 } },
  });
  assert.deepEqual(itemCommitOf(waterRow, '  '), {
    kind: 'write', write: { productId: 'p-water', price: null, expectedBaseName: 'قارورة', expectedPrimary: { id: 'u-ctn', factor: 24 } },
  }, 'الفارغ يحذف سعر الصنف من القائمة');
  // صنفٌ بلا رئيسية: expectedPrimary null صريحاً (الخادم يتحقّق أنه ما زال بلا رئيسية)
  assert.deepEqual(itemCommitOf(sugarRow, '6٫5'), {
    kind: 'write', write: { productId: 'p-sugar', price: 6.5, expectedBaseName: 'كيلو', expectedPrimary: null },
  });
  assert.deepEqual(itemCommitOf(sugarRow, '0'), {
    kind: 'write', write: { productId: 'p-sugar', price: 0, expectedBaseName: 'كيلو', expectedPrimary: null },
  }, 'الصفر سعر');
  assert.deepEqual(itemCommitOf(waterRow, '-1'), { kind: 'invalid', problem: PRICE_RULE_MESSAGES.price });
  assert.deepEqual(itemCommitOf(waterRow, 'abc'), { kind: 'invalid', problem: PRICE_RULE_MESSAGES.price });
});

test('بعد الحفظ: صفوف الردّ تُرقِّع الصفحة المخبّأة وعدّ المسعّرة، وردٌّ بلا صفوف ⇒ المرسل نفسه', () => {
  const page = itemsPageOf({ rows: [waterRow, sugarRow], pagination: { total: 2, page: 1, limit: 50, pages: 1 }, pricedCount: 1 });
  const sent = [{ productId: 'p-sugar', price: 6.123456, expectedBaseName: 'كيلو', expectedPrimary: null }];
  assert.deepEqual(savedItemsOf(undefined, sent), [{ productId: 'p-sugar', listPrice: 6.1235 }]);
  assert.deepEqual(savedItemsOf({ rows: [{ productId: 'p-sugar', listPrice: '6.1235' }] }, sent), [{ productId: 'p-sugar', listPrice: 6.1235 }]);
  assert.deepEqual(savedItemsOf({ rows: [] }, [{ ...sent[0], price: null }]), [{ productId: 'p-sugar', listPrice: null }]);
  const added = patchItemsPage(page, [{ productId: 'p-sugar', listPrice: 6.5 }]);
  assert.equal(added.rows[1].listPrice, 6.5);
  assert.equal(added.pricedCount, 2);
  assert.equal(added.rows[0], page.rows[0], 'السطر الآخر كما هو');
  const removed = patchItemsPage(added, [{ productId: 'p-water', listPrice: null }]);
  assert.equal(removed.rows[0].listPrice, null);
  assert.equal(removed.pricedCount, 1);
  assert.equal(patchItemsPage(page, [{ productId: 'p-water', listPrice: 100 }]), page, 'لا تغيّر ⇒ الصفحة نفسها');
  assert.equal(patchItemsPage(page, [{ productId: 'p-gone', listPrice: 5 }]), page, 'صنفٌ ليس في الصفحة');
});

test('نموذج القاعدة: الزيادة تُكتب موجبةً وتُخزَّن سالبة، والخصم موجب، والحدود برسالةٍ مفهومة', () => {
  const d = { ...emptyRuleDraft('category'), categoryId: 'c-juice', value: '10' };
  assert.deepEqual(ruleInputOf(d, null), {
    problem: null,
    input: { scope: 'category', productId: null, categoryId: 'c-juice', kind: 'percent', price: null, percent: 10, minQty: 0, startsOn: null, endsOn: null },
  });
  const up = ruleInputOf({ ...d, kind: 'markup', value: '١٥' }, null);
  assert.equal(up.input?.percent, -15, 'الزيادة سالبة في التخزين');
  assert.equal(ruleInputOf({ ...d, kind: 'markup', value: '500' }, null).input?.percent, -500);
  assert.equal(ruleInputOf({ ...d, kind: 'markup', value: '501' }, null).problem, RULE_FORM_MESSAGES.markup);
  assert.equal(ruleInputOf({ ...d, kind: 'markup', value: '-5' }, null).problem, RULE_FORM_MESSAGES.markup, 'المستخدم يكتب موجباً دائماً');
  assert.equal(ruleInputOf({ ...d, value: '100' }, null).input?.percent, 100, 'خصمٌ كامل');
  assert.equal(ruleInputOf({ ...d, value: '100.5' }, null).problem, RULE_FORM_MESSAGES.discount);
  assert.equal(ruleInputOf({ ...d, value: '0' }, null).problem, RULE_FORM_MESSAGES.discount);
  assert.equal(ruleInputOf({ ...d, value: '' }, null).problem, RULE_FORM_MESSAGES.discount);
  // الحدّ الأدنى والفترة: الفارغ صفرٌ ومفتوح، والتالف برسائل priceRuleProblem نفسها
  const full = ruleInputOf({ ...d, minQty: '10', startsOn: '2026-11-01', endsOn: '2026-11-30' }, null);
  assert.deepEqual([full.input?.minQty, full.input?.startsOn, full.input?.endsOn], [10, '2026-11-01', '2026-11-30']);
  assert.equal(ruleInputOf({ ...d, minQty: 'x' }, null).problem, PRICE_RULE_MESSAGES.minQty);
  assert.equal(ruleInputOf({ ...d, minQty: '-1' }, null).problem, PRICE_RULE_MESSAGES.minQty);
  assert.equal(ruleInputOf({ ...d, startsOn: '2026-11-31' }, null).problem, PRICE_RULE_MESSAGES.day);
  assert.equal(ruleInputOf({ ...d, startsOn: '2026-11-10', endsOn: '2026-11-01' }, null).problem, PRICE_RULE_MESSAGES.range);
  assert.equal(ruleInputOf({ ...d, categoryId: '' }, null).problem, PRICE_RULE_MESSAGES.category);
  assert.equal(ruleInputOf({ ...emptyRuleDraft('product'), value: '5' }, null).problem, PRICE_RULE_MESSAGES.product);
  // كل الأصناف: نسبةٌ وحدها
  assert.equal(ruleInputOf({ ...emptyRuleDraft('all'), kind: 'fixed', value: '5' }, null).problem, PRICE_RULE_MESSAGES.allFixed);
  assert.deepEqual(ruleInputOf({ ...emptyRuleDraft('all'), kind: 'markup', value: '5', productId: 'stale', categoryId: 'stale' }, null).input,
    { scope: 'all', productId: null, categoryId: null, kind: 'percent', price: null, percent: -5, minQty: 0, startsOn: null, endsOn: null },
    'المعرّفات المتروكة من نطاقٍ سابق لا تُرسل');
});

test('سعرٌ ثابت: للفئة بالرئيسية كما كُتب، وللصنف بأساسه ورئيسيّته كما عُرضا (حارس 409)', () => {
  const cat = ruleInputOf({ ...emptyRuleDraft('category'), categoryId: 'c-juice', kind: 'fixed', value: '90' }, null);
  assert.deepEqual(cat.input, { scope: 'category', productId: null, categoryId: 'c-juice', kind: 'fixed', price: 90, percent: null, minQty: 0, startsOn: null, endsOn: null });
  assert.equal(ruleInputOf({ ...emptyRuleDraft('category'), categoryId: 'c', kind: 'fixed', value: '' }, null).problem, PRICE_RULE_MESSAGES.price);
  assert.equal(ruleInputOf({ ...emptyRuleDraft('category'), categoryId: 'c', kind: 'fixed', value: '-2' }, null).problem, PRICE_RULE_MESSAGES.price);
  const water: RuleProductRef = { id: 'p-water', name: 'ماء', unit: 'قارورة', primaryUnit: carton };
  const draft = { ...emptyRuleDraft('product'), productId: 'p-water', kind: 'fixed' as const, value: '95', minQty: '10' };
  assert.deepEqual(ruleInputOf(draft, water).input, {
    scope: 'product', productId: 'p-water', categoryId: null, kind: 'fixed', price: 95, percent: null, minQty: 10, startsOn: null, endsOn: null,
    expectedBaseName: 'قارورة', expectedPrimary: { id: 'u-ctn', factor: 24 },
  });
  assert.deepEqual(ruleInputOf({ ...draft, productId: 'p-sugar' }, { id: 'p-sugar', name: 'سكر', unit: 'كيلو', primaryUnit: null }).input?.expectedPrimary, null);
  assert.equal(ruleInputOf(draft, null).problem, PRICE_RULE_MESSAGES.product, 'بلا أساس الصنف لا سعر ثابت');
  assert.equal(ruleInputOf(draft, { ...water, id: 'p-other' }).problem, PRICE_RULE_MESSAGES.product, 'صنفٌ غير المختار');
  // نسبةٌ على صنف: بلا حارس أساس (النسبة لا تتغيّر بالتحويل)
  const pct = ruleInputOf({ ...draft, kind: 'discount', value: '5' }, null);
  assert.equal(pct.problem, null);
  assert.equal('expectedBaseName' in (pct.input ?? {}), false);
});

test('تعديل قاعدة محفوظة: المسودّة تعرض النسبة موجبةً ونوعها، والسعر الثابت للصنف × معامل رئيسيّته', () => {
  assert.equal(ruleFormKindOf({ kind: 'percent', percent: -20 }), 'markup');
  assert.equal(ruleFormKindOf({ kind: 'percent', percent: 20 }), 'discount');
  assert.equal(ruleFormKindOf({ kind: 'fixed', percent: null }), 'fixed');
  assert.equal(percentShown(-12.5), '12.5');
  assert.equal(percentShown(0.1 + 0.2), '0.3', 'بلا غبار الفاصلة');
  assert.equal(percentShown(null), '');
  const prod = rule({ scope: 'product', productId: 'p-water', categoryId: null, kind: 'fixed', basePrice: 4.166667, percent: null, minQty: 10, primaryUnit: carton, startsOn: '2026-11-01' });
  assert.equal(ruleFixedShown(prod, 24), '100');
  assert.equal(ruleFixedShown(prod, null), '4.1667', 'بلا رئيسية: الأساس');
  assert.deepEqual(ruleDraftOf(prod), {
    scope: 'product', productId: 'p-water', categoryId: '', kind: 'fixed', value: '100', minQty: '10', startsOn: '2026-11-01', endsOn: '',
  });
  assert.equal(ruleDraftOf(prod, 12).value, '50', 'معامل الصنف كما يراه النموذج');
  assert.equal(ruleDraftOf(rule({ percent: -15 })).value, '15');
  assert.equal(ruleDraftOf(rule({ percent: -15 })).kind, 'markup');
  assert.equal(ruleDraftOf(rule({ kind: 'fixed', percent: null, primaryPrice: 88.5 })).value, '88.5');
  // والمسودّة المعادة دون لمس تعطي الجسم نفسه (لا انجراف)
  const back = ruleInputOf(ruleDraftOf(rule({ percent: -15, minQty: 2.5, endsOn: '2026-12-31' })), null);
  assert.deepEqual([back.input?.percent, back.input?.minQty, back.input?.endsOn, back.input?.startsOn], [-15, 2.5, '2026-12-31', null]);
});

test('ملخّص القاعدة بلغة المالك: النوع والهدف والحدّ الأدنى بوحدته والفترة — والأسماء بيانات لا tr', () => {
  const now = new Date(2026, 10, 5);
  const juice = rule({ categoryName: 'العصائر', minQty: 10, startsOn: '2026-11-01', endsOn: '2026-11-30' });
  assert.equal(norm(ruleSummaryText(juice, id, { locale: 'en-US', now })), 'خصم 10% على فئة العصائر · من 10 بالوحدة الرئيسية · Nov 1 – 30');
  assert.equal(norm(ruleSummaryText(juice, tr, { locale: 'en-US', now })),
    '«خصم 10%» «على فئة العصائر» · «من 10 بالوحدة الرئيسية» · Nov 1 – 30');
  const prod = rule({ scope: 'product', productId: 'p', categoryId: null, kind: 'fixed', basePrice: 4.166667, percent: null, minQty: 5, productName: 'ماء', primaryUnit: carton });
  assert.equal(ruleSummaryText(prod, id), 'سعر ثابت 100 لكل كرتون على الصنف ماء · من 5 كرتون');
  assert.equal(ruleSummaryText({ ...prod, primaryUnit: null, unit: 'كيلو', basePrice: 7 }, id), 'سعر ثابت 7 لكل كيلو على الصنف ماء · من 5 كيلو');
  assert.equal(ruleSummaryText({ ...prod, primaryUnit: null, minQty: 0, basePrice: 7, productName: null, productCode: 'W1' }, id), 'سعر ثابت 7 على الصنف W1');
  assert.equal(ruleSummaryText(rule({ scope: 'all', categoryId: null, percent: -12.5 }), id), 'زيادة 12.5% على كل الأصناف');
  assert.equal(ruleSummaryText(rule({ kind: 'fixed', percent: null, primaryPrice: 90, categoryName: 'العصائر' }), id), 'سعر ثابت 90 لكل وحدة رئيسية على فئة العصائر');
  assert.equal(ruleSummaryText(rule({ categoryName: 'العصائر' }), id, { fmtNum: (n) => `[${n}]` }), 'خصم [10]% على فئة العصائر');
});

test('فترة القاعدة: مدى بلغة الواجهة، وطرفٌ واحد «ابتداء من/حتى»، والسنة لغير السنة الحالية', () => {
  const now = new Date(2026, 10, 5);
  assert.equal(ruleDatesText(null, null, id), null);
  assert.equal(ruleDatesText('', 'bad', id), null);
  assert.equal(norm(ruleDatesText('2026-11-01', '2026-11-30', id, 'en-US', now)), 'Nov 1 – 30');
  assert.equal(norm(ruleDatesText('2026-10-25', '2026-11-05', id, 'en-US', now)), 'Oct 25 – Nov 5');
  assert.equal(norm(ruleDatesText('2026-11-05', '2026-11-05', id, 'en-US', now)), 'Nov 5');
  assert.equal(norm(ruleDatesText('2026-12-25', '2027-01-05', id, 'en-US', now)), 'Dec 25, 2026 – Jan 5, 2027');
  assert.equal(norm(ruleDatesText('2026-11-01', null, id, 'en-US', now)), 'ابتداء من Nov 1');
  assert.equal(norm(ruleDatesText(null, '2026-11-30', tr, 'en-US', now)), '«حتى Nov 30»');
  assert.match(ruleDatesText('2026-11-01', '2026-11-30', id, 'ar-SA-u-nu-latn', now) ?? '', /1.30 نوفمبر/);
  // حالة القاعدة اليوم
  assert.equal(ruleTimingOf({ startsOn: null, endsOn: null }, '2026-11-05'), 'active');
  assert.equal(ruleTimingOf({ startsOn: '2026-11-01', endsOn: '2026-11-05' }, '2026-11-05'), 'active', 'الطرفان شاملان');
  assert.equal(ruleTimingOf({ startsOn: null, endsOn: '2026-11-04' }, '2026-11-05'), 'expired');
  assert.equal(ruleTimingOf({ startsOn: '2026-11-06', endsOn: null }, '2026-11-05'), 'upcoming');
});

// ═══ حرّاس نصّية: المحرّر موصولٌ بالمسارات والمفاتيح والحفظ التلقائي ═══
const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...p), 'utf8');

test('اللوحة: صفّ القائمة بعدّاته و«الأسعار والقواعد» يفتح المحرّر في النافذة نفسها مع «رجوع»', () => {
  const panel = read('components', 'priceLists', 'PriceListsPanel.tsx');
  assert.ok(panel.includes('priceListCountsText(l, tr, formatNumber)'));
  assert.ok(panel.includes("{tr('الأسعار والقواعد')}"));
  assert.ok(panel.includes('<PriceListEditor key={openList.id} list={openList} onBack={() => setOpenId(null)} />'));
  const ed = read('components', 'priceLists', 'PriceListEditor.tsx');
  assert.ok(ed.includes("{tr('رجوع')}"));
  assert.ok(ed.includes("{tr('أسعار الأصناف')}") && ed.includes("{tr('القواعد')}"));
});

test('تبويب الأصناف: صفحةٌ من الخادم، والحفظ سطراً سطراً عند Enter أو الخروج، ولا تضيع مسودّةٌ عند الإغلاق', () => {
  const s = read('components', 'priceLists', 'PriceListItemsTab.tsx');
  assert.ok(s.includes("queryKey: ['price-list-items', listId, scope, search, categoryId, page],"));
  assert.match(s, /priceListApi\.listItems\(listId, \{\s*scope, page, limit: PRICE_LIST_ITEMS_PAGE,/);
  assert.ok(s.includes('useQuery({ ...priceListItemsQuery(listId, scope, debounced, categoryId, page), placeholderData: keepPreviousData })'));
  assert.ok(s.includes('priceListApi.saveItems(listId, [write])'), 'سطرٌ واحد في كل حفظ');
  assert.ok(s.includes('onBlur={() => commit(r)}'));
  assert.ok(s.includes("if (e.key === 'Enter')"));
  // سطرٌ يُحفظ ويُكتب فيه ثانيةً: الجديد بعد انتهاء الأول (لا طلبان متسابقان للصنف نفسه)
  assert.ok(s.includes('if (inflight.current.has(pid)) { queued.current.add(pid); return; }'));
  // الإغلاق والرجوع وتبديل التبويب: ما لم يُحفظ يُرسل بعد الفكّ سطراً سطراً (سطرٌ تالف الوحدات لا يُسقط غيره)، والتالف يُقال
  assert.match(s, /const flushOnUnmount = \(\) => \{[\s\S]*if \(c\.kind === 'write'\) send\(pid, raw\);[\s\S]*if \(invalid\) toast\.error/);
  assert.match(s, /useEffect\(\(\) => \{\s*mounted\.current = true;\s*return \(\) => \{\s*mounted\.current = false;\s*flushOnUnmount\(\);/);
  for (const k of ["['price-lists']", "['products-all']", "['price-list-rules']"]) assert.ok(s.includes(`queryKey: ${k}`), k);
});

test('تبويب القواعد: النموذج بنطاقه ونوعه الثلاثي وحدّه الأدنى وفترته، والتحقّق priceRuleProblem عبر tr، والحذف بتأكيد', () => {
  const s = read('components', 'priceLists', 'PriceListRulesTab.tsx');
  const f = read('components', 'priceLists', 'PriceRuleForm.tsx');
  assert.ok(s.includes("queryKey: ['price-list-rules-of', listId]"));
  assert.ok(s.includes('priceListApi.listRules(listId)'));
  assert.ok(s.includes('priceListApi.removeRule('));
  assert.ok(s.includes('<ConfirmDialog'));
  assert.ok(s.includes("{tr('القاعدة الأخص تغلب: الصنف ثم الفئة ثم كل الأصناف، ثم الأعلى كمية، ثم العرض المؤقت، وسعر العميل الخاص يغلب القائمة دائما')}"));
  for (const k of ["['price-lists']", "['price-list-rules']", "['products-all']", "['price-list-rules-of', listId]"]) assert.ok(s.includes(`queryKey: ${k}`), k);
  assert.ok(f.includes('const res = ruleInputOf(draft, productRef);'));
  assert.ok(f.includes('setProblem(tr(res.problem))'));
  assert.ok(f.includes('priceListApi.createRule(listId, input)') && f.includes('priceListApi.updateRule(rule.id, input)'));
  assert.ok(f.includes("{tr('الحد الأدنى للكمية (بالوحدة الرئيسية)')}"));
  assert.equal(f.split('type="date"').length - 1, 2);
  assert.equal(f.split('dir="ltr"').length - 1 >= 2, true);
});
