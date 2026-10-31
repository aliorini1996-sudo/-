import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultRequestUnit, stockRequestLines, repEditItems, withRequestedProducts, isStaleUnitsError, type RepStockRequest,
  crossSumLabel, anyPrimary, loadSumLabel, withBaseUnitNames, removalStart, removalBaseQty, suggestPrimarySource,
} from './stockRequest';

/**
 * «الوحدة الرئيسية» في طلب المخزون (primary_unit_spec §5.1 و§5.3، حزمة B5b): الصنف «ماء» أساسه القارورة، وله كرتون ٢٤
 * رئيسيّ وطبلية ١٢٠٠. الافتراض بالرئيسية لا بالطبلية، والسطر يحمل الرئيسية لطباعة الرصيد بها، والحمولة تحمل الأساس
 * كما رآه الإداري (baseUnitName) — وصنفٌ بلا رئيسية كما كان حرفاً (I1).
 */
const units = [
  { id: 'u-ctn', name: 'كرتون', factor: 24, price: null, isActive: true },
  { id: 'u-plt', name: 'طبلية', factor: 1200, price: null, isActive: true },
];
const plain = { productId: 'w', name: 'ماء', code: 'W1', unit: 'قارورة', onHand: 1250, units };
const primary = { ...plain, primaryUnitId: 'u-ctn' };

test('وحدة الطلب الافتراضية: الرئيسية بلا طلب مناديب — لا الطبلية الأكبر منها', () => {
  assert.equal(defaultRequestUnit(primary, 0), 'u-ctn');
  // تكافؤ الإطفاء: بلا رئيسية الأكبر كما كان
  assert.equal(defaultRequestUnit(plain, 0), 'u-plt');
  assert.equal(defaultRequestUnit({ ...plain, primaryUnitId: null }, 0), 'u-plt');
});

test('وحدة الطلب الافتراضية: الرئيسية حين ينقسم عليها مجموع المناديب، وإلّا القاعدة القائمة', () => {
  assert.equal(defaultRequestUnit(primary, 1200), 'u-ctn', '١٢٠٠ قارورة = ٥٠ كرتون لا «١ طبلية»');
  assert.equal(defaultRequestUnit(plain, 1200), 'u-plt', 'بلا رئيسية: أكبر وحدةٍ ينقسم عليها كما كان');
  assert.equal(defaultRequestUnit(primary, 48), 'u-ctn');
  assert.equal(defaultRequestUnit(primary, 13), null, '١٣ قارورة لا تُكتب ٠٫٥٤ كرتون');
});

test('رئيسيةٌ تالفة أو موقوفة ⇒ سلوك اليوم (I5)', () => {
  assert.equal(defaultRequestUnit({ ...plain, primaryUnitId: 'u-gone' }, 0), 'u-plt');
  const stopped = { ...primary, units: [{ ...units[0], isActive: false }, units[1]] };
  assert.equal(defaultRequestUnit(stopped, 0), 'u-plt');
});

test('سطر الورقة يحمل الرئيسية الصالحة وحدها — وبلاها السطر كما كان حرفاً', () => {
  const [a] = stockRequestLines([primary], { w: '2' }, { w: 'u-ctn' });
  assert.equal(a.primaryUnitId, 'u-ctn');
  const [b] = stockRequestLines([plain], { w: '2' }, { w: 'u-ctn' });
  assert.equal('primaryUnitId' in b, false, 'لا مفتاح جديد لصنفٍ بلا رئيسية');
  const [c] = stockRequestLines([{ ...plain, primaryUnitId: 'u-gone' }], { w: '2' }, { w: 'u-ctn' });
  assert.equal('primaryUnitId' in c, false, 'معرّفٌ تالف لا يُحمل');
});

const req = (baseUnit: string | null): RepStockRequest => ({
  id: 'r1', salesRepId: 'rep', repName: 'مندوب', note: null, createdAt: '', updatedAt: 'v1',
  items: [{ productId: 'w', name: 'ماء', unit: 'قارورة', unitName: null, unitFactor: 1, requestedQty: 30, qty: 30, ...(baseUnit !== null && { baseUnit }), units }],
});

test('حفظ تعديل الإداري يحمل baseUnitName (الأساس كما رآه) — وخادمٌ قبل الميزة بلا baseUnit لا يُرسل شيئاً', () => {
  assert.deepEqual(repEditItems(req('قارورة'), { w: '24' }), [{ productId: 'w', qty: 24, baseUnitName: 'قارورة' }]);
  assert.deepEqual(repEditItems(req('قارورة'), undefined, { w: 'u-ctn' }), [{ productId: 'w', qty: 30, unitId: 'u-ctn', baseUnitName: 'قارورة' }]);
  assert.deepEqual(repEditItems(req(null), { w: '24' }), [{ productId: 'w', qty: 24 }], 'الجسم كما كان');
});

test('صنفٌ طلبه مندوب خارج الجدول يُلحق برئيسيّه حين يرسلها الخادم', () => {
  const r = req('قارورة');
  r.items[0].primaryUnitId = 'u-ctn';
  assert.equal(withRequestedProducts([], [r])[0].primaryUnitId, 'u-ctn');
  assert.equal('primaryUnitId' in withRequestedProducts([], [req('قارورة')])[0], false);
});

test('ردّ «وحدات الصنف تغيّرت»: UNIT_INVALID وPRODUCT_UNITS_CHANGED وحدهما — لا 503 الانشغال', () => {
  const err = (code?: string) => ({ response: { data: { code, message: 'x' } } });
  assert.equal(isStaleUnitsError(err('UNIT_INVALID')), true);
  assert.equal(isStaleUnitsError(err('PRODUCT_UNITS_CHANGED')), true);
  assert.equal(isStaleUnitsError(err('PRODUCT_UNITS_BUSY')), false);
  assert.equal(isStaleUnitsError(err()), false);
  assert.equal(isStaleUnitsError(null), false);
  assert.equal(isStaleUnitsError(new Error('net')), false);
});

// ═══ شاشات المخزون (مخزون السيارات والتحميل والمستودع والسجلّ) ═══

test('وسم المجاميع عبر الأصناف (R3): «بالوحدات الصغرى» مع رئيسية صادقة وحدها — null وغيابها الوسم القائم', () => {
  assert.equal(crossSumLabel(true), 'بالوحدات الصغرى');
  assert.equal(crossSumLabel(false), 'مجموع بوحدات الأساس');
  assert.equal(anyPrimary([{ primaryUnitId: null }, {}, null]), false, 'D18: null حاضرٌ في كل select ولا يُعدّ');
  assert.equal(anyPrimary([{ primaryUnitId: 'u-ctn' }]), true);
  assert.equal(anyPrimary([{ product: { primaryUnitId: 'u-ctn' } }]), true, 'من صنف البند');
  assert.equal(anyPrimary([{ product: { primaryUnitId: null } }]), false);
});

test('سجلّ التحميلات: وسم عمود الكمية — بلا رئيسية كما كان حرفاً، ومع رئيسية «بالوحدات الصغرى» ولو بنودٌ بالقارورة وحدها', () => {
  const ctn = { unitName: 'كرتون', unitFactor: 24 };
  const base = { unitName: null, unitFactor: 1 };
  assert.equal(loadSumLabel([base, base]), null, 'وحدة واحدة: لا وسم (I1)');
  assert.equal(loadSumLabel([ctn, base]), 'مجموع بوحدات الأساس', 'مختلطة: الوسم القائم');
  assert.equal(loadSumLabel([{ ...ctn, product: { primaryUnitId: null } }, base]), 'مجموع بوحدات الأساس', 'null لا يغيّر شيئاً');
  assert.equal(loadSumLabel([{ ...base, product: { primaryUnitId: 'u-ctn' } }]), 'بالوحدات الصغرى');
  assert.equal(loadSumLabel([{ ...ctn, product: { primaryUnitId: 'u-ctn' } }, base]), 'بالوحدات الصغرى');
});

test('baseUnitName على كل بند يُرسل — بعد التقسيم، ولا يمسّ الوحدة ولا التشغيلات، والفارغ لا يُرسل', () => {
  const bases: Record<string, string> = { w: 'قارورة', x: '  حبة ' };
  const out = withBaseUnitNames(
    [{ productId: 'w', qty: 2, unitId: 'u-ctn', lots: [{ lotId: 'L1', qty: 48 }] }, { productId: 'x', qty: 3 }, { productId: 'gone', qty: 1 }],
    id => bases[id],
  );
  assert.deepEqual(out, [
    { productId: 'w', qty: 2, unitId: 'u-ctn', lots: [{ lotId: 'L1', qty: 48 }], baseUnitName: 'قارورة' },
    { productId: 'x', qty: 3, baseUnitName: 'حبة' },
    { productId: 'gone', qty: 1 },
  ]);
});

test('إزالة المنتهي/التالف (D8): بالرئيسية حين ينقسم الرصيد عليها، وإلّا بالقارورة — وصنفٌ بلا رئيسية بالأساس كما كان', () => {
  assert.deepEqual(removalStart(primary, 48), { unitId: 'u-ctn', factor: 24, qty: 2 }, 'لا الطبلية الأكبر منها');
  assert.deepEqual(removalStart(primary, 50), { unitId: null, factor: 1, qty: 50 }, 'كامل الرصيد لا يُقرَّب إلى كراتين');
  assert.deepEqual(removalStart(primary, 0.5), { unitId: null, factor: 1, qty: 0.5 });
  assert.deepEqual(removalStart(plain, 48), { unitId: null, factor: 1, qty: 48 }, 'I1: بلا رئيسية الأساس رغم الوحدات');
  assert.deepEqual(removalStart({ ...plain, primaryUnitId: null }, 1200), { unitId: null, factor: 1, qty: 1200 });
  assert.deepEqual(removalStart({ ...plain, primaryUnitId: 'u-gone' }, 48), { unitId: null, factor: 1, qty: 48 }, 'رئيسيةٌ تالفة');
});

test('كمية الإزالة بالأساس قبل الإرسال والمقارنة: الخانة × المعامل — وبالأساس الرقم كما كُتب حرفاً', () => {
  assert.equal(removalBaseQty('2', 24), 48);
  assert.equal(removalBaseQty('0.1', 24), 2.4, 'لا ذيل عشري (2.4000000000000004)');
  assert.equal(removalBaseQty('5', 1), 5);
  assert.equal(removalBaseQty('0.1234567', 1), 0.1234567, 'الأساس بلا تقريب: كما قبل الميزة');
  assert.ok(Number.isNaN(removalBaseQty('abc', 24)));
});

test('اقتراح التحميل (R7): الرئيسية من صفّ الاقتراح نفسه أولاً — وnull صريحاً يغلب كتالوجاً قديماً، والكتالوج بأساسه نفسه وحده', () => {
  const row = { unit: 'قارورة', units, primaryUnitId: 'u-ctn' };
  const cat = { unit: 'قارورة', units, primaryUnitId: 'u-ctn' };
  assert.equal(suggestPrimarySource(row, undefined), row, 'الصفّ يكفي ولو لم تُحمَّل قائمة الأصناف بعد');
  assert.equal(suggestPrimarySource({ ...row, primaryUnitId: null }, cat), null, 'الخادم قال: بلا رئيسية');
  assert.equal(suggestPrimarySource({ ...row, primaryUnitId: 'u-gone' }, cat), null, 'رئيسيةٌ تالفة في الصفّ (I5)');
  // خادمٌ لا يرسل المفتاح: الكتالوج بأساس الاقتراح نفسه (baseNameKey على الطرفين)
  const old = { unit: 'قارورة', units };
  assert.equal(suggestPrimarySource(old, cat), cat);
  const padded = { ...cat, unit: ' قارورة ' };
  assert.equal(suggestPrimarySource(old, padded), padded);
  assert.equal(suggestPrimarySource(old, { ...cat, unit: 'كرتون' }), null, 'كتالوجٌ بأساسٍ آخر لا يُقرأ منه شيء');
  assert.equal(suggestPrimarySource(old, { ...cat, primaryUnitId: null }), null, 'I1: بلا رئيسية الاقتراح كما كان');
  assert.equal(suggestPrimarySource(old, undefined), null);
});
