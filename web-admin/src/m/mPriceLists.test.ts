import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  invoiceLine, addInvoiceLine, setInvoiceLineUnit, refreshInvoiceLines, repriceInvoiceLines, priceOverrideOf, suggestedNet, lineKey,
  addedLinePrice, pickerChoice, pickerPrices, type LinePricer, type SalePick,
} from './mUnits';
import { unitChoices } from '../rep/repUnits';
import { invoiceTotals } from './docMath';
import { defaultPriceTypeOf } from '../lib/priceLists';
import {
  repPriceTypesOf, priceTypesWithin, togglePriceType, setDefaultPriceType, defaultOptionsOf, repPriceTypesBody, repPriceTypesDirty,
} from './mRepPriceTypes';

/**
 * «أنواع الأسعار» في تطبيق الإدارة على الجوال: رقاقات نوع السعر في الفاتورة ونوع السعر في ملف العميل و«تبديل نوع السعر» للمندوب.
 * ⚠️ الفخّ الحاكم هنا (docMath.ts): الأسعار **صافية قبل الضريبة** — سعر النوع يُقترح صافياً كما خُزِّن، لا شاملاً كتطبيق المندوب.
 *
 * ماء: القارورة أساسٌ بسعر ٢، والكرتون ٢٤ بسعرٍ محدَّد ٤٥ — و«سعر الجملة» للكرتون ١٠٠ (مخزَّنٌ للأساس 4.166667 بست منازل كما يكتبه
 * الخادم)، و«سعر التجزئة» للقارورة ٢٫٥. وسكر بلا وحدات وبلا سعرٍ في الأنواع.
 */
const UNITS = [{ id: 'u-ctn', name: 'كرتون', factor: 24, price: 45, isActive: true }];
const water: SalePick = {
  id: 'p1', name: 'ماء', unit: 'قارورة', basePrice: 2, taxPct: 15, units: UNITS, primaryUnitId: 'u-ctn', baseConvertedAt: null,
  listPrices: [{ priceListId: 'l-whole', price: 4.166667 }, { priceListId: 'l-retail', price: 2.5 }],
};
const sugar: SalePick = { id: 'p2', name: 'سكر', unit: 'كيس', basePrice: 7.5, taxPct: 15, listPrices: [] };
const [bottle, carton] = unitChoices(water);
/** مسعِّرٌ من سعرٍ ثابت لكل صنف (سعر العميل ?? القائمة لوحدة الأساس — الشكل قبل القواعد): suggestedNet بثالثه */
const byOverride = (of: (p: SalePick) => number | null): LinePricer => (p, c) => suggestedNet(p, c, of(p));

test('priceOverrideOf: سعر العميل الخاص يغلب سعر النوع، والنوع من listPrices الصنف — ولا هذا ولا ذاك ⇒ null', () => {
  assert.equal(priceOverrideOf(water, 'l-whole', null), 4.166667);
  assert.equal(priceOverrideOf(water, 'l-retail', []), 2.5);
  assert.equal(priceOverrideOf(water, null, null), null, 'السعر الأساسي');
  assert.equal(priceOverrideOf(water, 'l-gone', null), null, 'نوعٌ لا سعر للصنف فيه');
  assert.equal(priceOverrideOf(sugar, 'l-whole', null), null);
  const cust = [{ productId: 'p1', price: 3, unit: 'قارورة', baseConvertedAt: null }, { productId: 'p2', price: 7, unit: 'كيس', baseConvertedAt: null }];
  assert.equal(priceOverrideOf(water, 'l-whole', cust), 3, 'العميل يغلب النوع');
  assert.equal(priceOverrideOf(sugar, null, cust), 7, 'وسعره يُقترح بلا أنواعٍ أصلاً');
  // صفّ عميلٍ من قبل تحويل الأساس (unit = كرتون) يُعاد إلى أساس الصنف الحالي (÷٢٤) لا يُضرب ×٢٤ مرّةً ثانية
  const converted = { ...water, baseConvertedAt: '2026-10-30T10:00:00.000Z' };
  assert.equal(priceOverrideOf(converted, null, [{ productId: 'p1', price: 48, unit: 'كرتون', baseConvertedAt: null }]), 2);
});

test('بند الفاتورة بسعر النوع ⚠️ صافياً: الكرتون ١٠٠ لا ١١٥، مقرَّباً لأربع منازل — وبلا override كما كان حرفاً', () => {
  const l = invoiceLine(water, carton, priceOverrideOf(water, 'l-whole', null));
  assert.equal(l.unitPrice, 100, 'سعر الجملة صافياً (4.166667 × 24 = 100.000008 مقرَّباً)');
  assert.equal(l.refPrice, 100);
  assert.equal(invoiceTotals([l], 0).total, 115, 'الضريبة يحسبها المحرّك فوق الصافي — لا مرّتين');
  assert.equal(invoiceLine(water, bottle, 4.166667).unitPrice, 4.1667);
  // بلا نوع ولا سعر عميل: سعر الكرتون المحدَّد ٤٥ — والنوع يغلبه
  assert.equal(invoiceLine(water, carton).unitPrice, 45);
  assert.equal(invoiceLine(water, carton, null).unitPrice, 45);
  assert.equal(invoiceLine(sugar).unitPrice, 7.5);
  assert.equal(suggestedNet(water, carton, 3), 72, 'سعر العميل للأساس × المعامل');
  // الإضافة تزيد البند القائم بالوحدة نفسها كما كانت، والجديد بالمقترح
  let ls = addInvoiceLine([], water, carton, 4.166667);
  ls = addInvoiceLine(ls, water, carton, 4.166667);
  assert.deepEqual(ls.map(x => [lineKey(x), x.qty, x.unitPrice]), [['p1:u-ctn', 2, 100]]);
});

test('تبديل وحدة البند يعيد تسعيره بسعر النوع بالوحدة الجديدة، ومعامل الوحدة الذي تغيّر كذلك', () => {
  const ls = addInvoiceLine([], water, carton, 2.5);
  assert.equal(ls[0].unitPrice, 60);
  const back = setInvoiceLineUnit(ls, 'p1:u-ctn', water, bottle, 2.5);
  assert.equal(back[0].unitPrice, 2.5);
  assert.equal(back[0].refPrice, 2.5);
  // الكرتون صار ١٢ ⇒ يُعاد تسعيره بسعر النوع × ١٢
  const smaller: SalePick = { ...water, units: [{ ...UNITS[0], factor: 12 }] };
  const r = refreshInvoiceLines(ls, smaller, 2.5);
  assert.equal(r[0].unitPrice, 30);
  assert.equal(r[0].refPrice, 30);
  assert.equal(refreshInvoiceLines(ls, water, 2.5), ls, 'بلا تغيير ⇒ القائمة نفسها');
});

test('تبديل النوع أو العميل: البند الذي لم يُمسّ يأخذ المقترح الجديد، والمعدَّل يدويّاً يبقى بسعره ويتبع مرجعه وحده', () => {
  const catalog = { p1: water, p2: sugar };
  const whole = (p: SalePick) => priceOverrideOf(p, 'l-whole', null);
  const lines = [
    invoiceLine(water, carton, whole(water)),                    // ١٠٠ لم يُمسّ
    { ...invoiceLine(water, bottle, whole(water)), unitPrice: 4 }, // عُدِّل يدويّاً
    invoiceLine(sugar, unitChoices(sugar)[0], whole(sugar)),      // ليس في النوع
  ];
  const retail = repriceInvoiceLines(lines, catalog, byOverride(p => priceOverrideOf(p, 'l-retail', null)));
  assert.equal(retail[0].unitPrice, 60, 'سعر التجزئة للكرتون');
  assert.equal(retail[0].refPrice, 60);
  assert.equal(retail[1].unitPrice, 4, 'المعدَّل يبقى');
  assert.equal(retail[1].refPrice, 2.5, 'ومرجعه يتبع النوع');
  assert.equal(retail[2], lines[2], 'سعر السكر لم يتغيّر');
  // العودة إلى السعر الأساسي: الكرتون بسعره المحدَّد ٤٥
  assert.equal(repriceInvoiceLines(retail, catalog, byOverride(() => null))[0].unitPrice, 45);
  // لا تغيّر ⇒ المصفوفة نفسها، وصنفٌ خارج الكتالوج كما هو
  assert.equal(repriceInvoiceLines(retail, catalog, byOverride(p => priceOverrideOf(p, 'l-retail', null))), retail);
  assert.equal(repriceInvoiceLines(retail, {}, () => 1), retail);
});

test('pickerPrices: تلميح كل صنفٍ دفعةً واحدة = addedLinePrice بوحدته الافتراضية (والأساس بلا وحدات) بكمية صنفه بعد الإضافة', () => {
  const pr = byOverride(p => priceOverrideOf(p, 'l-whole', null));
  const lines = addInvoiceLine(addInvoiceLine([], water, carton, pr), water, bottle, pr);
  for (const price of [pr, undefined, 2.5]) {
    const m = pickerPrices(lines, [water, sugar], price);
    assert.equal(m.get('p1'), addedLinePrice(lines, water, pickerChoice(water), price));
    assert.equal(m.get('p2'), addedLinePrice(lines, sugar, pickerChoice(sugar), price));
  }
  assert.deepEqual(pickerChoice(water), carton, 'الرئيسية');
  assert.deepEqual(pickerChoice(sugar), unitChoices(sugar)[0], 'الأساس لصنفٍ بلا وحدات');
  assert.equal(pickerPrices(lines, [water], pr).get('p1'), 100, 'سعر الجملة صافياً للكرتون');
  assert.equal(pickerPrices([], null, pr).size, 0, 'لا نتيجة بحثٍ بعد');
});

// ═══ حرّاس نصّية: التوصيل في الشاشات ═══
const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');

test('MInvoiceCreate: النوع من ملف العميل، والرقاقات تبدّله، وكل اقتراح سعرٍ بالقاعدة الواحدة صافياً — والجسم يحمل priceListId', () => {
  const s = read('m', 'MInvoiceCreate.tsx');
  // افتراضيّ الفاتورة بالقاعدة الواحدة مع الخادم: نوع العميل ?? نوع المندوب المختار ?? الأساسي
  assert.ok(s.includes("const repListId: string | null = repsQ.data?.find(r => r.id === salesRepId)?.defaultPriceListId ?? null;"));
  assert.ok(s.includes('const docDefault: string | null = defaultPriceTypeOf(custListId, repListId);'));
  assert.ok(s.includes("const listId: string | null = !listsOn ? null : listChoice !== undefined ? listChoice : docDefault;"));
  // مندوبٌ آخر يغيّر الافتراضي وحده (رقاقةٌ اختارها المستخدم تبقى كاللوحة) — والتنبيه بقاعدة اللوحة نفسها
  assert.ok(s.includes('onChange={e => setSalesRepId(e.target.value)}'));
  assert.ok(s.includes('const listHint = adminListHintOf(listId, custListId, repListId, custListId !== undefined);'));
  // «قوائم الأسعار» (طلب المالك ٥ نوفمبر ٢٠٢٦): العبارة باسم القائمة
  assert.ok(s.includes("tr(listHint === 'rep' ? 'ليست قائمة المندوب' : 'ليست قائمة العميل')"));
  assert.doesNotMatch(s, /ليس نوع سعر/);
  assert.doesNotMatch(s, /pricesIncludeTax/, 'الجوال يرسل أسعاراً صافية بلا مفتاح الشمول');
  // المسعِّر الواحد مع فاتورة اللوحة: سعر العميل ثم القائمة (ثابتها وقواعدها بكمية الصنف ويوم الفاتورة) ثم سلّم اليوم
  assert.ok(s.includes('() => docLinePricerOf({ listId, custRows, rules: listsOn ? rulesQ.data : null, day: pricingDay }),'));
  assert.ok(s.includes('[listId, custRows, listsOn, rulesQ.data, pricingDay],'));
  // يوم الفاتورة المختار وإلا يوم الشركة الآن بمنطقتها (مراجعة D1)
  assert.ok(s.includes('const pricingDay = docPricingDayOf(invoiceDate, { timezone: priceInfoQ.data?.timezone });'));
  assert.match(s, /queryKey: \['price-list-rules'\],[\s\S]{0,200}enabled: listsOn,/, 'القواعد بمفتاح اللوحة وحين للشركة قوائم وحدها');
  assert.ok(s.includes('productApi.customerPrices(customerId)'), 'أسعار العميل الخاصة تغلب القائمة');
  // «إزالة الضريبة» (٧ نوفمبر ٢٠٢٦): البند الجديد بنسبته الفعلية من إعدادات الشركة (taxCo) — المسعِّر نفسه
  assert.ok(s.includes('setLines(ls => addInvoiceLine(ls, p, c, priceOf, taxCo));'));
  assert.ok(s.includes('setLines(ls => setInvoiceLineUnit(ls, key, p, c, priceOf));'));
  assert.ok(s.includes('refreshInvoiceLines(acc, p, priceOf)'));
  // تغيّر الكمية (+/−، والحذف) يعيد بنود الصنف التي لم تُمسّ — كانت الكمية لا تعيد التسعير قبل القواعد
  assert.ok(s.includes('setLines(ls => stepInvoiceLine(ls, key, d, catalog, priceOf))'));
  assert.ok(s.includes('setLines(ls => removeInvoiceLine(ls, k, catalog, priceOf))'));
  assert.doesNotMatch(s, /ls\.filter\(x => lineKey\(x\) !== k\)/, 'الحذف بلا إعادة تسعير');
  assert.match(s, /setLines\(ls => repriceInvoiceLines\(ls, catalog, priceOf\)\);[\s\S]{0,200}\}, \[priceOf\]\);/);
  assert.ok(s.includes('...(listsOn && { priceListId: listId }),'), 'شركةٌ بلا أنواع: الجسم كما كان');
  assert.ok(s.includes('if (c.id !== customerId) setListChoice(undefined);'), 'عميلٌ آخر يأخذ نوعه');
  assert.ok(s.includes('onClick={() => setListChoice(o.id)}'));
  assert.ok(s.includes('baseLabelOf(priceInfoQ.data, tr)'), 'اسم الرقاقة الأولى كما سمّته الشركة');
  assert.doesNotMatch(s, /import \{[^}]*\bchoiceNet\b[^}]*\} from '\.\.\/rep\/repUnits';/, 'لا سعرٌ مقترح بلا ثالثه (سعر العميل ?? النوع): suggestedNet وحده');
  // تلميح السعر في القائمة بالمقترح نفسه (بوحدات وبلاها) وبكمية الصنف بعد الإضافة — محفوظاً (pickerPrices) لا محسوباً مع كل رسم (D5)
  assert.ok(s.includes('() => pickerPrices(lines, productsQ.data, priceOf),'));
  assert.equal(s.split('formatCurrency(pickPrices.get(p.id) ?? 0)').length - 1, 2);
  assert.doesNotMatch(s, /suggestedNet\(|priceOverrideOf\(/, 'لا مقترح بغير المسعِّر');
  assert.doesNotMatch(s, /tr\(o\.name\)|tr\(l\.name\)/, 'أسماء الأنواع بيانات لا تمرّ بـtr');
  // أسماء الأنواع مرّةً كل ٥ دقائق لا مع كل فاتورة — ونوع عميلٍ لا تعرفه (أُنشئ بعدها) يعيد قراءتها مرّةً، وإلا لا مفتاح فيسعّر
  // الخادم بنوع العميل والبنود مقترحةٌ بالأساس
  assert.match(s, /queryKey: \['m-price-lists'\],[\s\S]{0,400}staleTime: 5 \* 60_000,/);
  // والافتراضي نوع العميل أو المندوب — كلاهما قد يكون أحدث من الأسماء المخبّأة
  const retry = s.slice(s.indexOf('const namesRetried = useRef<string | null>(null);'));
  assert.match(retry, /^const namesRetried[\s\S]{0,120}if \(!docDefault \|\| priceLists\.some\(l => l\.id === docDefault\) \|\| priceInfoQ\.isFetching \|\| namesRetried\.current === docDefault\) return;\s*namesRetried\.current = docDefault;\s*void priceInfoQ\.refetch\(\);/);
  assert.match(retry, /\}, \[docDefault, priceInfoQ\.data, priceInfoQ\.isFetching\]\);/);
});

test('MCustomerForm وMSalesReps: «نوع السعر» يُرسل null صريحاً للسعر الأساسي والخانة الظاهرة وحدها، و«تبديل نوع السعر» بين صلاحيات التسعير', () => {
  const f = read('m', 'MCustomerForm.tsx');
  assert.ok(f.includes('if (showPriceList) payload.priceListId = form.priceListId || null;'));
  assert.ok(f.includes("const priceLists = accountingOn && (!customer || customer.priceListId !== undefined) ? priceInfoQ.data?.lists ?? [] : [];"),
    'صفٌّ بلا المفتاح (خادمٌ قبل الميزة) لا يُكتب فوقه null');
  assert.ok(f.includes('enabled: accountingOn,'), 'لا طلب والمحاسبة مطفأة');
  const r = read('m', 'MSalesReps.tsx');
  assert.ok(r.includes("{ title: 'صلاحيات التسعير', keys: ['canChangePrice', 'canSellBelowPrice', 'canChangePriceList'] },"));
  assert.ok(r.includes("canChangePriceList: 'تبديل قائمة الأسعار',"));
  assert.ok(r.includes('canChangePrice: false, canSellBelowPrice: false, canChangePriceList: false,'), 'افتراض الخادم: مطفأة');
  // صلاحيةٌ مانحة (تُقلب مع «تحديد الكل») ومحاسبية (تُخفى والمحاسبة مطفأة)
  const grants = r.slice(r.indexOf('const GRANTS = ['), r.indexOf('] as const;', r.indexOf('const GRANTS = [')));
  assert.match(grants, /'canChangePriceList'/);
  const acc = r.slice(r.indexOf('const ACCOUNTING_PERMS = new Set<PermKey>(['), r.indexOf(']);', r.indexOf('const ACCOUNTING_PERMS')));
  assert.match(acc, /'canChangePriceList'/);
});

// ═══ نوع سعر المندوب (طلب المالك ٢ نوفمبر ٢٠٢٦) ═══

test('افتراضيّ فاتورة الجوال مع المندوب المختار: نوع العميل ثم نوع المندوب ثم الأساسي — وتبديل المندوب يعيد تسعير ما لم يُمسّ صافياً', () => {
  assert.equal(defaultPriceTypeOf('l-retail', 'l-whole'), 'l-retail', 'نوع العميل يغلب نوع المندوب');
  assert.equal(defaultPriceTypeOf(null, 'l-whole'), 'l-whole', 'عميلٌ بلا نوع ⇒ نوع المندوب');
  assert.equal(defaultPriceTypeOf(undefined, 'l-whole'), 'l-whole', 'والعميل لم يُعرف بعد ⇒ نوع المندوب حتى يصل');
  assert.equal(defaultPriceTypeOf(null, null), null, 'ولا هذا ولا ذاك ⇒ السعر الأساسي');
  // مندوبٌ بلا نوع ⇒ بنودٌ بالأساس (الكرتون ٤٥)، ثم مندوبٌ بنوع الجملة ⇒ الكرتون ١٠٠ صافياً، والمعدَّل يدويّاً يبقى
  const catalog = { p1: water, p2: sugar };
  const by = (repDefault: string | null) => (p: SalePick) => priceOverrideOf(p, defaultPriceTypeOf(null, repDefault), null);
  const lines = [invoiceLine(water, carton, by(null)(water)), { ...invoiceLine(water, bottle, by(null)(water)), unitPrice: 1.8 }];
  assert.equal(lines[0].unitPrice, 45);
  const whole = repriceInvoiceLines(lines, catalog, byOverride(by('l-whole')));
  assert.equal(whole[0].unitPrice, 100, 'سعر الجملة صافياً لا شاملاً');
  assert.equal(whole[1].unitPrice, 1.8, 'المعدَّل يبقى');
  assert.equal(whole[1].refPrice, 4.1667, 'ومرجعه يتبع النوع');
  assert.equal(invoiceTotals([whole[0]], 0).total, 115);
  // عميلٌ بنوع التجزئة بعده: نوعه يغلب نوع المندوب
  const retail = repriceInvoiceLines(whole, catalog, byOverride(p => priceOverrideOf(p, defaultPriceTypeOf('l-retail', 'l-whole'), null)));
  assert.equal(retail[0].unitPrice, 60);
});

test('mRepPriceTypes: خانات أنواع المندوب — لا اختيار = كل الأنواع (null)، والافتراضي داخل المختارة دائماً', () => {
  const ids = ['l-whole', 'l-retail'];
  // مندوبٌ قبل الضبط (الحقلان null): لا خانة مختارة، والافتراضي الأساسي، والخيارات كلها
  const fresh = repPriceTypesOf({ defaultPriceListId: null, allowedPriceTypes: null }, ids);
  assert.deepEqual(fresh, { checked: [], def: null });
  assert.deepEqual(defaultOptionsOf(fresh.checked, ids), [null, 'l-whole', 'l-retail']);
  assert.deepEqual(repPriceTypesBody(fresh), { defaultPriceListId: null, allowedPriceTypes: null });
  // صفٌّ مضبوط: 'base' = null، بترتيب العرض (الأساسي ثم أنواع الشركة) أيّاً كان ترتيب المخزَّن، وبلا نوعٍ لم يعد للشركة
  const set = repPriceTypesOf({ defaultPriceListId: 'l-retail', allowedPriceTypes: ['l-retail', 'l-gone', 'base', 'base'] }, ids);
  assert.deepEqual(set, { checked: [null, 'l-retail'], def: 'l-retail' });
  assert.deepEqual(defaultOptionsOf(set.checked, ids), [null, 'l-retail'], 'الافتراضي من المختارة وحدها');
  assert.deepEqual(repPriceTypesBody(set), { defaultPriceListId: 'l-retail', allowedPriceTypes: ['base', 'l-retail'] });
  // نوعٌ افتراضيٌّ لم يعد للشركة ⇒ أول الخيارات
  assert.equal(repPriceTypesOf({ defaultPriceListId: 'l-gone', allowedPriceTypes: null }, ids).def, null);
  // أول خانةٍ من «كل الأنواع»: تُضاف بترتيب العرض ومعها الافتراضيّ الحالي مختاراً — لا ينتقل الافتراضيّ إليها في الخفاء.
  // بلاغ المراجعة: افتراضيّ X بلا اختيار، نقر Y ثم X ⇒ كانت [X، Y] بافتراضيّ Y فيُحفظ Y ويتبدّل تسعير عملاء المندوب بلا نوع
  const a = togglePriceType({ checked: [], def: 'l-whole' }, 'l-retail', ids);
  assert.deepEqual(a, { checked: ['l-whole', 'l-retail'], def: 'l-whole' });
  assert.deepEqual(repPriceTypesBody(a), { defaultPriceListId: 'l-whole', allowedPriceTypes: ['l-whole', 'l-retail'] }, 'الحفظ بالافتراضيّ نفسه');
  assert.deepEqual(togglePriceType({ checked: [], def: null }, 'l-retail', ids), { checked: [null, 'l-retail'], def: null }, 'والسعر الأساسي افتراضياً كذلك');
  assert.deepEqual(togglePriceType({ checked: [], def: 'l-retail' }, 'l-retail', ids), { checked: ['l-retail'], def: 'l-retail' }, 'خانة الافتراضيّ نفسه: بلا تكرار');
  assert.deepEqual(togglePriceType({ checked: [], def: 'l-gone' }, 'l-retail', ids), { checked: ['l-retail'], def: 'l-retail' }, 'افتراضيٌّ لم يعد للشركة لا يُضاف');
  // ثم إزالة خانة الافتراضيّ القديم بيد المدير تنقله أمام العين إلى أول الباقية
  assert.deepEqual(togglePriceType(a, 'l-whole', ids), { checked: ['l-retail'], def: 'l-retail' });
  // وإضافةٌ إلى اختيارٍ قائم: بترتيب العرض والافتراضيّ داخلها يبقى
  const b = togglePriceType({ checked: ['l-retail'], def: 'l-retail' }, null, ids);
  assert.deepEqual(b, { checked: [null, 'l-retail'], def: 'l-retail' }, 'افتراضيٌّ داخلها يبقى');
  // إزالة خانة الافتراضي تنقله إلى أول الباقية، وإزالة الكل تعيد «كل الأنواع» بالافتراضي كما هو
  const c = togglePriceType(b, 'l-retail', ids);
  assert.deepEqual(c, { checked: [null], def: null });
  const none = togglePriceType({ checked: ['l-whole'], def: 'l-whole' }, 'l-whole', ids);
  assert.deepEqual(none, { checked: [], def: 'l-whole' });
  assert.deepEqual(repPriceTypesBody(none), { defaultPriceListId: 'l-whole', allowedPriceTypes: null });
  // اختيار الافتراضي من الخيارات وحدها
  assert.equal(setDefaultPriceType(b, null, ids).def, null);
  assert.equal(setDefaultPriceType(b, 'l-whole', ids), b, 'نوعٌ غير مختار لا يصير افتراضياً');
  // نوعٌ حُذف بعد التعديل (ردّ PRICE_LIST_INVALID ثم أنواعٌ أحدث): تسقط خانته والافتراضي إلى أول الباقية
  assert.deepEqual(priceTypesWithin({ checked: [null, 'l-retail'], def: 'l-retail' }, ['l-whole']), { checked: [null], def: null });
  assert.deepEqual(priceTypesWithin(b, ids), b);
  // «لم يُمسّ» يُقاس بالجسم: الحالة نفسها ⇒ لا يُرسل شيء، وأي تغيير ⇒ يُرسلان
  assert.equal(repPriceTypesDirty(set, { ...set }), false);
  assert.equal(repPriceTypesDirty(set, togglePriceType(set, 'l-whole', ids)), true);
  assert.equal(repPriceTypesDirty(fresh, setDefaultPriceType(fresh, 'l-whole', ids)), true);
});

test('MSalesReps: قسم «أنواع الأسعار» في الصلاحيات — والشركة لها أنواع والمحاسبة مفعّلة والصفّ يحمل الحقل، والحقلان يُرسلان معدَّلين وحدهما', () => {
  const r = read('m', 'MSalesReps.tsx');
  assert.ok(r.includes('const typesShown = accountingOn && priceLists.length > 0 && rep.defaultPriceListId !== undefined;'),
    'خادمٌ قبل الميزة (الحقل غائب) لا يُكتب فوقه');
  assert.ok(r.includes("queryKey: ['m-price-lists'],"), 'مفتاح الأنواع نفسه في الفاتورة وملف العميل');
  assert.ok(r.includes('const typesBody = typesShown && repPriceTypesDirty(typesInitial, types) ? repPriceTypesBody(types) : null;'));
  assert.ok(r.includes('...(typesBody ?? {}),'));
  assert.ok(r.includes('const types = typesEdited ? priceTypesWithin(typesEdited, listIds) : typesInitial;'));
  assert.match(r, /queryKey: \['m-price-lists'\],[\s\S]{0,300}refetchOnMount: 'always',/, 'نوعٌ أحدث من الأسماء المخبّأة لا يسقط من الحفظ');
  assert.ok(r.includes('{typesShown && ('));
  assert.ok(r.includes('onClick={() => setTypesEdited(togglePriceType(types, o.id, listIds))}'));
  assert.ok(r.includes('defaultOptionsOf(types.checked, listIds).map('), 'الافتراضي من المختارة وحدها');
  assert.ok(r.includes("baseLabelOf(priceInfoQ.data, tr)"), 'السعر الأساسي باسمه عند الشركة');
  assert.doesNotMatch(r, /tr\(o\.name\)|tr\(l\.name\)/, 'أسماء الأنواع بيانات لا تمرّ بـtr');
  // عنوان الخانات كنسخة اللوحة: هي ما يبدّل بينه المندوب لا «نوع سعره»
  assert.match(r, /\{typesShown && \([\s\S]{0,400}<p className="label px-3\.5 pt-3">\{tr\('القوائم المسموحة'\)\}<\/p>\s*<div data-m-rep-price-types=""/);
});

test('MSalesReps: حفظ الصلاحيات يُبطل قائمة مناديب فاتورة الجوال — نوع المندوب الافتراضي منها، والمخبّأ قبل الحفظ يسعّر بالقديم', () => {
  const r = read('m', 'MSalesReps.tsx');
  const inv = read('m', 'MInvoiceCreate.tsx');
  // المفتاح نفسه الذي تقرأ منه الفاتورة نوع المندوب (staleTime العامّ ٣٠ ثانية)
  assert.ok(inv.includes("queryKey: ['m-inv-reps'],"));
  assert.match(inv, /const repListId: string \| null = repsQ\.data\?\.find\(r => r\.id === salesRepId\)\?\.defaultPriceListId \?\? null;/);
  const perms = r.slice(r.indexOf('...(typesBody ?? {}),'), r.indexOf("toast.success(tr('تم حفظ الصلاحيات'));"));
  assert.ok(perms.length > 0 && perms.includes("qc.invalidateQueries({ queryKey: ['m-inv-reps'] });"), 'الصلاحيات (النوع الافتراضي والمسموح)');
  const form = r.slice(r.indexOf('onSuccess: (saved) => {'), r.indexOf("tr('تم إنشاء حساب المندوب')"));
  assert.ok(form.length > 0 && form.includes("qc.invalidateQueries({ queryKey: ['m-inv-reps'] });"), 'ونموذج المندوب (جديدٌ أو اسمٌ/حالة)');
});
