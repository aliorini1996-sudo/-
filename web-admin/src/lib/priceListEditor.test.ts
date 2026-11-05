import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  PRICE_LIST_ITEMS_PAGE, RULE_FORM_MESSAGES, emptyRuleDraft, failedItemRowsOf, fillText, isUnitsChangedCode, itemCommitOf, itemShownPrice,
  itemsPageClampOf, itemsPageOf, itemsPagerShown, itemsRefetchTypeOf, patchItemsPage, percentShown, priceListCountsText, pricedChangedOf,
  ruleDatesText, ruleDraftDirty, ruleDraftOf, ruleDraftPatch, ruleFixedShown, ruleFormKindOf, ruleInputOf, ruleSummaryText, ruleTimingOf,
  savedItemsOf, syncItemsCacheAfterSave, type ItemsCacheClient, type ItemsPage, type RuleDraft, type RuleProductRef,
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
  // ومعه onDirtyChange: نموذج قاعدةٍ لم يُحفظ تسأل عنه النافذة قبل الإغلاق (D6)
  assert.ok(panel.includes('<PriceListEditor key={openList.id} list={openList} onBack={() => setOpenId(null)} onDirtyChange={onDirtyChange} />'));
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
  // والتالف يُقال بأسماء أصنافه (D6: لا رسالة بلا اسم بعد غياب الجدول)
  assert.match(s, /const flushOnUnmount = \(\) => \{[\s\S]*if \(c\.kind === 'write'\) send\(pid, raw\);[\s\S]*if \(invalid\.length\) toast\.error\(`\$\{invalid\.join/);
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

// ═══ إصلاحات المراجعة (قرار D6): المحرّر ═══

test('نموذج القاعدة (D6): تبديل النوع بين الثابت والنسبة أو النطاق والسعر ثابت يمسح الرقم، وبين الخصم والزيادة يبقى', () => {
  const base: RuleDraft = { ...emptyRuleDraft('product'), productId: 'p-water', kind: 'fixed', value: '25', minQty: '10', startsOn: '2026-11-01' };
  assert.equal(ruleDraftPatch(base, { kind: 'discount' }).value, '', 'سعر 25 لا يصير خصم 25%');
  const pct: RuleDraft = { ...base, kind: 'discount', value: '10' };
  assert.equal(ruleDraftPatch(pct, { kind: 'fixed' }).value, '', 'خصم 10% لا يصير سعر 10');
  assert.equal(ruleDraftPatch(pct, { kind: 'markup' }).value, '10', 'الخصم والزيادة نسبةٌ موجبة في الحالين');
  assert.equal(ruleDraftPatch(base, { scope: 'category' }).value, '', 'سعر كرتون صنفٍ ليس سعر كل صنفٍ في الفئة');
  const all = ruleDraftPatch(base, { scope: 'all' });
  assert.deepEqual([all.scope, all.kind, all.value], ['all', 'discount', ''], 'كل الأصناف: الثابت خصمٌ بلا رقم');
  assert.equal(ruleDraftPatch(pct, { scope: 'category' }).value, '10', 'النسبة لا يتغيّر معناها بالنطاق');
  assert.equal(ruleDraftPatch(pct, { scope: 'all' }).value, '10');
  assert.deepEqual([ruleDraftPatch(base, { scope: 'category' }).minQty, ruleDraftPatch(base, { kind: 'discount' }).startsOn], ['10', '2026-11-01'],
    'بقية الخانات كما هي');
  assert.equal(ruleDraftPatch(base, { value: '30' }).value, '30');
  assert.equal(ruleDraftPatch(base, { kind: 'fixed' }).value, '25', 'النوع نفسه لا يمسح');
  assert.equal(ruleDraftPatch(base, { minQty: '5' }).value, '25');
  // بعد التبديل لا يُحفظ سعرٌ نسبةً: الخانة فارغة ⇒ رسالة النسبة أو السعر
  const cat: RuleDraft = { ...base, scope: 'category', categoryId: 'c-juice' };
  assert.equal(ruleInputOf(ruleDraftPatch(cat, { kind: 'discount' }), null).problem, RULE_FORM_MESSAGES.discount);
  assert.equal(ruleInputOf(ruleDraftPatch({ ...pct, scope: 'category', categoryId: 'c-juice' }, { kind: 'fixed' }), null).problem, PRICE_RULE_MESSAGES.price);
});

test('نموذج القاعدة (D6): ما لم يُحفظ — للتعديل أيّ تغيير، وللجديد خانةٌ فيها شيء (النطاق والنوع وحدهما لا)', () => {
  const init = emptyRuleDraft('category');
  assert.equal(ruleDraftDirty(init, init, true), false);
  assert.equal(ruleDraftDirty({ ...init, scope: 'product', kind: 'fixed' }, init, true), false, 'اختيار النطاق والنوع وحده');
  assert.equal(ruleDraftDirty({ ...init, categoryId: 'c' }, init, true), true);
  assert.equal(ruleDraftDirty({ ...init, value: ' 5 ' }, init, true), true);
  assert.equal(ruleDraftDirty({ ...init, minQty: '3' }, init, true), true);
  assert.equal(ruleDraftDirty({ ...init, endsOn: '2026-11-30' }, init, true), true);
  assert.equal(ruleDraftDirty({ ...init, value: '   ' }, init, true), false, 'المسافات وحدها لا شيء');
  const saved = ruleDraftOf(rule({ percent: 10, categoryName: 'العصائر' }));
  assert.equal(ruleDraftDirty(saved, saved, false), false);
  assert.equal(ruleDraftDirty({ ...saved, value: '10 ' }, saved, false), false, 'المسافات لا تُعدّ تعديلاً');
  assert.equal(ruleDraftDirty({ ...saved, kind: 'markup' }, saved, false), true);
  assert.equal(ruleDraftDirty({ ...saved, startsOn: '2026-11-01' }, saved, false), true);
  assert.equal(ruleDraftDirty({ ...saved, value: '' }, saved, false), true, 'مسحٌ في التعديل تعديل');
});

test('أسعار الأصناف (D6): حفظٌ يُدخل صنفاً المسعّرة أو يُخرجه يعيد الصفحات، وأخطاء الأسطر باسم صنفها، ورموز تغيّر الوحدات', () => {
  const known = new Map<string, number | null>([['p-water', 100], ['p-sugar', null]]);
  const before = (pid: string) => (known.has(pid) ? known.get(pid) ?? null : undefined);
  assert.equal(pricedChangedOf([{ productId: 'p-water', listPrice: 96 }], before), false, 'سعرٌ تغيّر والصنف مسعّرٌ قبله وبعده: ترقيعٌ بلا جلب');
  assert.equal(pricedChangedOf([{ productId: 'p-sugar', listPrice: 6.5 }], before), true, 'دخل المسعّرة من «كل الأصناف»');
  assert.equal(pricedChangedOf([{ productId: 'p-water', listPrice: null }], before), true, 'خرج منها');
  assert.equal(pricedChangedOf([{ productId: 'p-sugar', listPrice: null }], before), false);
  assert.equal(pricedChangedOf([{ productId: 'p-new', listPrice: 5 }], before), true, 'لا يُعرف ما كان ⇒ يُعاد');
  assert.equal(pricedChangedOf([], before), false);
  const status = {
    'p-water': { state: 'error', message: 'تغيرت وحدات الصنف' }, 'p-sugar': { state: 'saved' },
    'p-gone': { state: 'error', message: 'الصنف غير موجود' }, 'p-busy': { state: 'saving' },
  };
  const rows = new Map<string, PriceListItemRow>([['p-water', waterRow]]);
  assert.deepEqual(failedItemRowsOf(status, pid => rows.get(pid)), [
    { productId: 'p-water', name: 'ماء', message: 'تغيرت وحدات الصنف' },
    { productId: 'p-gone', name: 'p-gone', message: 'الصنف غير موجود' },
  ], 'الخطأ وحده باسم صنفه، وصنفٌ غاب عن الجدول بمعرّفه');
  assert.deepEqual(failedItemRowsOf(status, () => ({ name: '', code: 'W1' })).map(f => f.name), ['W1', 'W1'], 'بلا اسم ⇒ الكود');
  assert.deepEqual(failedItemRowsOf({}, () => undefined), []);
  for (const c of ['BASE_UNIT_CHANGED', 'PRIMARY_UNIT_CHANGED', 'PRODUCT_UNITS_CHANGED']) assert.equal(isUnitsChangedCode(c), true, c);
  for (const c of ['PRODUCT_NOT_FOUND', '', undefined, null, 'PRIMARY_UNIT_IN_USE', 'PRICE_RULES_UNIT_ACK']) assert.equal(isUnitsChangedCode(c), false, String(c));
});

test('المحرّر (D6): ٤٠٩ تغيّر الوحدات يُسقط المكتوب ولا يعيد إرساله، والمسعّرة تُعاد بعد حفظٍ يغيّرها، وقائمة أخطاءٍ ثابتة باسم الصنف', () => {
  const s = read('components', 'priceLists', 'PriceListItemsTab.tsx');
  const onErr = s.slice(s.indexOf('.catch((e) => {'), s.indexOf('.finally(() => {'));
  assert.match(onErr, /if \(isUnitsChangedCode\(serverCode\(e\)\)\) \{\s*queued\.current\.delete\(pid\);\s*setDraft\(pid, undefined\);\s*qc\.invalidateQueries\(\{ queryKey: \['price-list-items', listId\] \}\);/,
    'المكتوب بالوحدة القديمة يبقى فيُرسل بالجديدة عند الخروج أو الإغلاق');
  assert.ok(onErr.includes('if (!mounted.current) toast.error(`${row.name}: ${msg}`);'), 'بعد الفكّ الرسالة باسم الصنف');
  // الترقيع وإعادة الجلب في syncItemsCacheAfterSave (المسعّرة تغيّرت أو جلبٌ جارٍ ⇒ 'active') — مختبرٌ بعميلٍ حقيقيّ أدناه
  assert.ok(s.includes('syncItemsCacheAfterSave(qc, listId, saved, pricedChanged);'));
  assert.doesNotMatch(s, /refetchType: pricedChanged \? 'active' : 'none'/, 'إعادة الجلب بلا الجلب الجاري');
  assert.ok(s.indexOf('const pricedChanged = pricedChangedOf(saved, pid => rowsRef.current.get(pid)?.listPrice);')
    < s.indexOf('if (r) rowsRef.current.set(s.productId, { ...r, listPrice: s.listPrice });'), 'ما كان قبل الترقيع');
  assert.ok(s.indexOf('if (r) rowsRef.current.set(s.productId, { ...r, listPrice: s.listPrice });')
    < s.indexOf('syncItemsCacheAfterSave(qc, listId, saved, pricedChanged);'));
  assert.ok(s.includes('const failed = failedItemRowsOf(status, pid => rowsRef.current.get(pid));'));
  assert.ok(s.includes('data-list-item-errors=""') && s.includes('sticky top-0'), 'قائمة الأخطاء ثابتة أعلى التبويب');
  assert.ok(s.indexOf('data-list-item-errors=""') < s.indexOf('ref={searchRef}'), 'فوق البحث');
  // نموذج القاعدة: التبديل عبر ruleDraftPatch، و٤٠٩ يمسح السعر الثابت ويعيد الصنف والقواعد، وأسماءٌ مقروءة وتركيز
  const f = read('components', 'priceLists', 'PriceRuleForm.tsx');
  assert.ok(f.includes('const set = (patch: Partial<RuleDraft>) => { setDraft(d => ruleDraftPatch(d, patch)); setProblem(null); };'));
  assert.doesNotMatch(f, /set\(\{ scope, \.\.\.\(scope === 'all'/, 'التبديل القديم بلا مسح');
  assert.ok(f.includes('if (isUnitsChangedCode(code) && draftRef.current.productId) unitsChanged(draftRef.current.productId);'));
  assert.match(f, /if \(fixedOfProduct\) setDraft\(x => \(x\.productId === productId && x\.kind === 'fixed' \? \{ \.\.\.x, value: '' \} : x\)\);/);
  assert.ok(f.includes('loadProduct(productId, false);') && f.includes('void onStale().then((fresh) => {'));
  for (const k of ['value', 'minQty', 'from', 'to', 'category']) assert.ok(f.includes(`htmlFor={ids.${k}}`) && f.includes(`id={ids.${k}}`), `اسم الخانة: ${k}`);
  assert.ok(f.includes('useEffect(() => { headRef.current?.focus(); }, []);'), 'التركيز على النموذج حين يُفتح');
  assert.ok(f.includes('useEffect(() => () => dirtyCb.current?.(false), []);'));
  const t = read('components', 'priceLists', 'PriceListRulesTab.tsx');
  assert.ok(t.includes('onStale={refetchRules} onDirtyChange={formDirtyChange}'));
  assert.ok(t.includes('if (editing !== null && formDirty.current && !window.confirm(tr(RULE_FORM_DISCARD_ASK))) return;'));
  assert.ok(t.includes("(back === 'new' ? addBtnRef.current : editBtns.current.get(back) ?? addBtnRef.current)?.focus();"), 'التركيز يعود لزرّ الفتح');
  // ترك النموذج: الرجوع وتبديل التبويب بسؤال، وإغلاق النافذة كذلك (confirmClose)
  const ed = read('components', 'priceLists', 'PriceListEditor.tsx');
  assert.ok(ed.includes('const leaveOk = () => !ruleDirty.current || window.confirm(tr(RULE_FORM_DISCARD_ASK));'));
  assert.ok(ed.includes('onClick={back}') && ed.includes("onClick={() => goTab('items')}") && ed.includes('onDirtyChange={rulesDirtyChange}'));
  const modal = read('components', 'PagePanelModal.tsx');
  assert.ok(modal.includes('const close = () => { if (!confirmClose || confirmClose()) onClose(); };'));
  assert.ok(modal.includes('{...backdropClose(close)}') && modal.includes('<button type="button" onClick={close}'));
  const page = read('pages', 'ProductsPage.tsx');
  assert.ok(page.includes('confirmClose={() => !pricePanelDirty.current || window.confirm(tr(RULE_FORM_DISCARD_ASK))}'));
  assert.ok(page.includes('<PriceListsPanel onDirtyChange={(d) => { pricePanelDirty.current = d; }} />'));
  // D5: العدّادات للوحة وحدها بمفتاحها
  const panel = read('components', 'priceLists', 'PriceListsPanel.tsx');
  assert.ok(panel.includes("useQuery({ queryKey: ['price-lists', 'counts'], queryFn: async () => priceListsOf((await priceListApi.listWithCounts()).data.data) })"));
  assert.doesNotMatch(panel, /priceListApi\.list\(\)/);
});

// ═══ إصلاحات التحقّق: الجلب الجاري لحظة الحفظ، والصفحة بعد آخر صفحة ═══

/**
 * خادمٌ مصغّر لصفحة أصناف: GET يقرأ القاعدة لحظة الطلب ويردّ حين يفتح الاختبار بابه — فترتيب الالتزام والردود بيد الاختبار، كما
 * في سباق المراجعة: GET يقرأ قبل التزام PUT ويردّ بعد ردّه
 */
function itemsServer(initial: Record<string, number | null>) {
  const db: Record<string, number | null> = { ...initial };
  const gets: Array<{ snap: Record<string, number | null>; open: () => void }> = [];
  const pageOf = (snap: Record<string, number | null>): ItemsPage => {
    const rows = Object.entries(snap).map(([productId, listPrice]): PriceListItemRow => ({
      productId, code: productId, name: productId, categoryId: null, categoryName: null, unit: 'حبة', primaryUnit: null, defaultPrice: 10, listPrice,
    }));
    return { rows, pagination: { total: rows.length, page: 1, limit: PRICE_LIST_ITEMS_PAGE, pages: 1 }, pricedCount: rows.filter((r) => r.listPrice != null).length };
  };
  const queryFn = async (): Promise<ItemsPage> => {
    const snap = { ...db };
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    gets.push({ snap, open });
    await gate;
    return pageOf(snap);
  };
  return { db, gets, queryFn };
}
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: 0, staleTime: 30_000 } } });
const shown = (obs: QueryObserver<ItemsPage>) => Object.fromEntries((obs.getCurrentResult().data?.rows ?? []).map((r) => [r.productId, r.listPrice]));
/** السلوك السابق (لا يُرى الجلب الجاري): للتحقّق أن الاختبار يعيد السباق فعلاً */
const blindTo = (qc: QueryClient): ItemsCacheClient => ({
  isFetching: () => 0,
  cancelQueries: qc.cancelQueries.bind(qc),
  setQueriesData: qc.setQueriesData.bind(qc) as ItemsCacheClient['setQueriesData'],
  invalidateQueries: qc.invalidateQueries.bind(qc),
});

test('أسعار الأصناف (تحقّق): نوع إعادة الجلب، والصفحة بعد آخر صفحة، وشريط الصفحات', () => {
  assert.equal(itemsRefetchTypeOf(false, false), 'none', 'تعديل سعرٍ بلا جلبٍ جارٍ: ترقيعٌ بلا طلب كما كان');
  assert.equal(itemsRefetchTypeOf(true, false), 'active');
  assert.equal(itemsRefetchTypeOf(false, true), 'active', 'جلبٌ جارٍ قد قرأ قبل الالتزام');
  assert.equal(itemsRefetchTypeOf(true, true), 'active');
  assert.equal(itemsPageClampOf(2, 1), 1, 'حُذف الصنف الوحيد في الصفحة الأخيرة ⇒ الصفحة الأخيرة الباقية');
  assert.equal(itemsPageClampOf(5, 3), 3);
  assert.equal(itemsPageClampOf(2, 2), 2);
  assert.equal(itemsPageClampOf(1, 4), 1, 'ما دون الأخيرة كما هو');
  assert.equal(itemsPageClampOf(3, 0), 1, 'صفحاتٌ صفر أو تالفة ⇒ ١ على الأقل');
  assert.equal(itemsPageClampOf(3, Number.NaN), 1);
  assert.equal(itemsPagerShown(1, 1), false, 'صفحةٌ واحدة بلا شريط كما كان');
  assert.equal(itemsPagerShown(1, 2), true);
  assert.equal(itemsPagerShown(2, 1), true, 'صفحةٌ بعد الأولى فارغة: الشريط باقٍ للرجوع');
});

test('أسعار الأصناف (تحقّق): جلبٌ جارٍ قرأ قبل التزام الحفظ لا يكتب السعر القديم فوق المحفوظ — بعميل react-query حقيقي', async () => {
  // سيناريو المراجعة: «كل الأصناف» — A يُسعَّر جديداً (null→5) فيُعاد الجلب (GET1)، وB يُعدَّل 7→8 فيلتزم بعد قراءة GET1 ويصل ردّه قبله
  const run = async (client: (qc: QueryClient) => ItemsCacheClient) => {
    const qc = newClient();
    const srv = itemsServer({ A: null, B: 7 });
    const obs = new QueryObserver<ItemsPage>(qc, { queryKey: ['price-list-items', 'L1', 'all', '', '', 1], queryFn: srv.queryFn });
    const unsub = obs.subscribe(() => {});
    srv.gets[0].open(); await flush();
    assert.deepEqual(shown(obs), { A: null, B: 7 });
    srv.db.A = 5;
    const typeA = syncItemsCacheAfterSave(client(qc), 'L1', [{ productId: 'A', listPrice: 5 }], true);
    srv.db.B = 8; // يلتزم بعد قراءة GET1
    const typeB = syncItemsCacheAfterSave(client(qc), 'L1', [{ productId: 'B', listPrice: 8 }], false);
    srv.gets[1].open(); await flush(); // ردّ GET1 المتأخّر (B=7)
    const afterLate = shown(obs);
    for (const g of srv.gets.slice(2)) g.open();
    await flush();
    const cur = obs.getCurrentResult();
    unsub();
    return { typeA, typeB, gets: srv.gets.length, afterLate, final: shown(obs), stale: cur.isStale, fetchStatus: cur.fetchStatus };
  };
  const before = await run(blindTo);
  assert.deepEqual([before.typeB, before.final.B], ['none', 7], 'السلوك السابق: الخانة ٧ والخادم ٨ (الاختبار يعيد السباق)');
  const fixed = await run((qc) => qc);
  assert.deepEqual([fixed.typeA, fixed.typeB], ['active', 'active'], 'جلبٌ جارٍ ⇒ يُعاد');
  assert.deepEqual(fixed.afterLate, { A: 5, B: 8 }, 'ردّ GET1 الملغى لا يهبط فوق الترقيع');
  assert.deepEqual(fixed.final, { A: 5, B: 8 });
  assert.equal(fixed.gets, 3, 'جلبٌ واحدٌ زائد لا أكثر');
  assert.deepEqual([fixed.stale, fixed.fetchStatus], [false, 'idle']);
  // وإعادة كتابة القديم (٧) تُرسل لا تُسقط «كما كان»
  const rowB: PriceListItemRow = { ...sugarRow, productId: 'B', listPrice: fixed.final.B as number };
  assert.equal(itemCommitOf(rowB, '7').kind, 'write');
});

test('أسعار الأصناف (تحقّق): أول تحميلٍ لصفحةٍ أو بحثٍ جديد، وصفحةٌ غير معروضة يجري جلبها — لا يبقى فيهما السعر القديم', async () => {
  // أول تحميل (بلا بيانات بعد): refetch وحده ينضمّ إلى الجلب الجاري ولا يلغيه — فيُلغى ويُعاد
  for (const blind of [true, false]) {
    const qc = newClient();
    const srv = itemsServer({ B: 7 });
    const obs = new QueryObserver<ItemsPage>(qc, { queryKey: ['price-list-items', 'L1', 'all', 'b', '', 1], queryFn: srv.queryFn });
    const unsub = obs.subscribe(() => {});
    srv.db.B = 8;
    syncItemsCacheAfterSave(blind ? blindTo(qc) : qc, 'L1', [{ productId: 'B', listPrice: 8 }], false);
    for (let i = 0; i < srv.gets.length; i++) { srv.gets[i].open(); await flush(); }
    const final = shown(obs).B;
    unsub();
    if (blind) assert.equal(final, 7, 'السلوك السابق: أول تحميلٍ قرأ قبل الالتزام يعرض ٧');
    else assert.deepEqual([final, srv.gets.length], [8, 2], 'يُلغى ويُعاد بعد الالتزام');
  }
  // صفحةٌ غير معروضة ببياناتٍ يجري جلبها: تُلغى وتعود ببياناتها مرقَّعةً «قديمة» (تُعاد عند فتحها) — بلا طلبٍ لها الآن
  const qc = newClient();
  const srv = itemsServer({ B: 7 });
  const key = ['price-list-items', 'L1', 'priced', '', '', 2];
  const obs = new QueryObserver<ItemsPage>(qc, { queryKey: key, queryFn: srv.queryFn });
  const unsub = obs.subscribe(() => {});
  srv.gets[0].open(); await flush();
  unsub();
  void qc.refetchQueries({ queryKey: key });
  assert.equal(srv.gets.length, 2);
  srv.db.B = 8;
  syncItemsCacheAfterSave(qc, 'L1', [{ productId: 'B', listPrice: 8 }], false);
  srv.gets[1].open(); await flush();
  assert.equal(srv.gets.length, 2, 'غير المعروضة لا تُجلب الآن');
  assert.equal(qc.getQueryData<ItemsPage>(key)?.rows[0].listPrice, 8);
  assert.equal(qc.getQueryState(key)?.isInvalidated, true, 'تُعاد من الخادم عند فتحها');
});

test('أسعار الأصناف (تحقّق): تعديل سعرٍ بلا جلبٍ جارٍ ترقيعٌ بلا طلب، وتغيّر «المسعّرة» جلبٌ واحد للمعروضة', async () => {
  const qc = newClient();
  const srv = itemsServer({ A: null, B: 7 });
  const shownKey = ['price-list-items', 'L1', 'priced', '', '', 1];
  const otherKey = ['price-list-items', 'L1', 'all', '', '', 1];
  const otherList = ['price-list-items', 'L2', 'all', '', '', 1];
  qc.setQueryData<ItemsPage>(otherKey, itemsPageOf({ rows: [{ ...sugarRow, productId: 'B', listPrice: 7 }] }));
  qc.setQueryData<ItemsPage>(otherList, itemsPageOf({ rows: [{ ...sugarRow, productId: 'B', listPrice: 7 }] }));
  const obs = new QueryObserver<ItemsPage>(qc, { queryKey: shownKey, queryFn: srv.queryFn });
  const unsub = obs.subscribe(() => {});
  srv.gets[0].open(); await flush();
  srv.db.B = 8;
  assert.equal(syncItemsCacheAfterSave(qc, 'L1', [{ productId: 'B', listPrice: 8 }], false), 'none');
  await flush();
  assert.equal(srv.gets.length, 1, 'لا طلب');
  assert.equal(shown(obs).B, 8);
  assert.equal(qc.getQueryData<ItemsPage>(otherKey)?.rows[0].listPrice, 8, 'المخبّأة مرقَّعة');
  assert.equal(qc.getQueryState(otherKey)?.isInvalidated, true);
  assert.equal(qc.getQueryData<ItemsPage>(otherList)?.rows[0].listPrice, 7, 'قائمةٌ أخرى لا تُمسّ');
  assert.equal(qc.getQueryState(otherList)?.isInvalidated, false);
  srv.db.A = 5;
  assert.equal(syncItemsCacheAfterSave(qc, 'L1', [{ productId: 'A', listPrice: 5 }], true), 'active');
  assert.equal(srv.gets.length, 2, 'المعروضة وحدها');
  srv.gets[1].open(); await flush();
  assert.deepEqual(shown(obs), { A: 5, B: 8 });
  unsub();
});

test('أسعار الأصناف (تحقّق): المكوّن ينقل الصفحة بعد آخر صفحة ببياناتها المستقرّة، ويُبقي شريط الصفحات لصفحةٍ بعد الأولى', () => {
  const s = read('components', 'priceLists', 'PriceListItemsTab.tsx');
  assert.match(s, /if \(!d \|\| itemsQ\.isPlaceholderData \|\| itemsQ\.isFetching\) return;\s*const to = itemsPageClampOf\(page, d\.pagination\.pages\);\s*if \(to !== page\) setPage\(to\);/);
  assert.ok(s.includes('}, [itemsQ.data, itemsQ.isPlaceholderData, itemsQ.isFetching, page]);'));
  assert.ok(s.includes('{itemsPagerShown(page, pages) && ('));
  assert.doesNotMatch(s, /\{pages > 1 && \(/, 'الشريط القديم يختفي في صفحةٍ فارغة بعد الأولى');
});
