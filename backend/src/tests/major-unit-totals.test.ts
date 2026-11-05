// «عرض الكميات بالوحدة الكبرى» (طلب المالك ٤ نوفمبر ٢٠٢٦) — مجاميع المخزون عبر الأصناف بوحدة كل صنفٍ الكبرى بدل
// «8,191 بالوحدات الصغرى»: الوحدة الكبرى (الرئيسية الصالحة ثم أكبر وحدةٍ نشطة ثم الأساس)، والضمّ بالاسم، والتقريب في آخر
// الجمع، والسالب، وملخّص المناديب، وبطاقة «في مخزون السيارات» من الأرقام نفسها — والناتج بلا أصنافٍ كما كان حرفياً. دوالّ صرفة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { majorTotals, majorUnitOf, repStockMajor, type MajorUnitProduct } from '../services/majorUnitTotals';
import { summarizeVansStock } from '../services/warehouseStock';

const CT = { id: 'u-c', name: 'كرتون', factor: 24, isActive: true };
const PL = { id: 'u-pl', name: 'طبلية', factor: 1200, isActive: true };

// ═══ majorUnitOf ═══

test('الوحدة الكبرى: الرئيسية الصالحة أولاً — لا الطبلية الأكبر منها', () => {
  assert.deepEqual(majorUnitOf({ unit: 'قارورة', units: [CT, PL], primaryUnitId: 'u-c' }), { name: 'كرتون', factor: 24 });
});

test('الوحدة الكبرى: بلا رئيسية (أو رئيسيةٍ تالفة) ⇒ أكبر وحدةٍ نشطة', () => {
  assert.deepEqual(majorUnitOf({ unit: 'قارورة', units: [CT, PL] }), { name: 'طبلية', factor: 1200 });
  assert.deepEqual(majorUnitOf({ unit: 'قارورة', units: [CT, PL], primaryUnitId: null }), { name: 'طبلية', factor: 1200 });
  assert.deepEqual(majorUnitOf({ unit: 'قارورة', units: [CT, PL], primaryUnitId: 'gone' }), { name: 'طبلية', factor: 1200 }, 'معرّفٌ لا يطابق');
  // الرئيسية الموقوفة لا تُختار، ولا تُعدّ «أكبر وحدة نشطة» بعدها
  assert.deepEqual(majorUnitOf({ unit: 'قارورة', units: [{ ...PL, isActive: false }, CT], primaryUnitId: 'u-pl' }), { name: 'كرتون', factor: 24 });
  // رئيسيةٌ بمعاملٍ غير صحيح (كسر) يرفضها primaryUnitOf ⇒ أكبر وحدة
  assert.deepEqual(majorUnitOf({ unit: 'قارورة', units: [{ id: 'h', name: 'نصف', factor: 2.5 }, CT], primaryUnitId: 'h' }), { name: 'كرتون', factor: 24 });
  // وحدات التقارير بلا معرّف: أكبرها بالاسم والمعامل وحدهما
  assert.deepEqual(majorUnitOf({ unit: 'حبة', units: [{ name: 'شدّة', factor: 6 }, { name: 'كرتون', factor: 24 }] }), { name: 'كرتون', factor: 24 });
});

test('الوحدة الكبرى: الموقوفة ومعامل ١ والمعامل التالف تُهمل، والتساوي لأوّلها', () => {
  assert.deepEqual(majorUnitOf({ unit: 'حبة', units: [{ name: 'كرتون', factor: 24, isActive: false }, { name: 'شدّة', factor: 6 }] }), { name: 'شدّة', factor: 6 });
  assert.deepEqual(majorUnitOf({ unit: 'حبة', units: [{ name: 'حبة٢', factor: 1 }, { name: 'x', factor: Number.NaN }, { name: 'y', factor: -3 }] }), { name: 'حبة', factor: 1 });
  assert.deepEqual(majorUnitOf({ unit: 'حبة', units: [{ name: 'أ', factor: 12 }, { name: 'ب', factor: 12 }] }), { name: 'أ', factor: 12 });
});

test('الوحدة الكبرى: بلا وحدةٍ أكبر ⇒ الأساس بمعامل ١، والأسماء مقصوصة، والصنف الغائب بلا اسم', () => {
  assert.deepEqual(majorUnitOf({ unit: 'كيس', units: [] }), { name: 'كيس', factor: 1 });
  assert.deepEqual(majorUnitOf({ unit: ' كيس ' }), { name: 'كيس', factor: 1 });
  assert.deepEqual(majorUnitOf({ unit: 'حبة', units: [{ name: '  كرتون ', factor: 24 }] }), { name: 'كرتون', factor: 24 });
  assert.deepEqual(majorUnitOf({ unit: 'حبة', units: [{ name: '   ', factor: 24 }] }), { name: 'حبة', factor: 1 }, 'وحدةٌ بلا اسم لا تُعرض');
  assert.deepEqual(majorUnitOf(null), { name: '', factor: 1 });
  assert.deepEqual(majorUnitOf(undefined), { name: '', factor: 1 });
});

// ═══ majorTotals ═══

const P1: MajorUnitProduct = { unit: 'حبة', units: [CT] };
const P2: MajorUnitProduct = { unit: 'علبة', units: [{ name: 'كرتون', factor: 12 }] };
const P3: MajorUnitProduct = { unit: 'حبة', units: [] };

test('المجاميع: الضمّ باسم الوحدة الكبرى عبر الأصناف، والأكبر قيمةً أولاً', () => {
  assert.deepEqual(majorTotals([
    { product: P1, baseQty: 48 },  // ٢ كرتون (٢٤)
    { product: P2, baseQty: 6 },   // نصف كرتون (١٢)
    { product: P3, baseQty: 40 },  // ٤٠ حبة بلا وحدة أكبر
  ]), [{ unit: 'حبة', qty: 40 }, { unit: 'كرتون', qty: 2.5 }]);
});

test('المجاميع: التقريب لأربع خانات في آخر الجمع لا لكل صنف', () => {
  // ثلاث ثُلثات كرتون = كرتونٌ واحد؛ تقريب كل حدٍّ قبل الجمع كان يعطي 0.9999
  assert.deepEqual(majorTotals([{ product: P1, baseQty: 8 }, { product: P1, baseQty: 8 }, { product: P1, baseQty: 8 }]), [{ unit: 'كرتون', qty: 1 }]);
  assert.deepEqual(majorTotals([{ product: P1, baseQty: 1 }]), [{ unit: 'كرتون', qty: 0.0417 }]);
  assert.deepEqual(majorTotals([{ product: P1, baseQty: 43 }]), [{ unit: 'كرتون', qty: 1.7917 }]);
});

test('المجاميع: السالب بإشارته، وما يتصافى أو يصغر عن المعنى يسقط', () => {
  assert.deepEqual(majorTotals([{ product: P1, baseQty: -48 }, { product: P2, baseQty: 6 }]), [{ unit: 'كرتون', qty: -1.5 }]);
  assert.deepEqual(majorTotals([{ product: P1, baseQty: 24 }, { product: P2, baseQty: -12 }]), [], 'كرتونٌ لهذا وكرتونٌ ناقصٌ لذاك');
  assert.deepEqual(majorTotals([{ product: P3, baseQty: 1e-12 }]), []);
  assert.deepEqual(majorTotals([{ product: P3, baseQty: 0 }]), []);
});

test('المجاميع: التساوي في القيمة المطلقة يُرتَّب بالاسم', () => {
  const box: MajorUnitProduct = { unit: 'علبة' };
  assert.deepEqual(majorTotals([{ product: box, baseQty: 2 }, { product: P3, baseQty: -2 }]), [{ unit: 'حبة', qty: -2 }, { unit: 'علبة', qty: 2 }]);
});

test('المجاميع: صنفٌ غائب أو بلا اسم وحدة أو كميةٌ غير رقم ⇒ يُتخطّى بلا خطأ، وبلا وحداتٍ ⇒ أساسه', () => {
  assert.deepEqual(majorTotals([]), []);
  assert.deepEqual(majorTotals([
    { product: undefined, baseQty: 10 },
    { product: null, baseQty: 10 },
    { product: { unit: '' }, baseQty: 10 },
    { product: P1, baseQty: Number.NaN },
    { product: P1, baseQty: Number.POSITIVE_INFINITY },
    { product: { unit: 'لتر' }, baseQty: 3.5 },
  ]), [{ unit: 'لتر', qty: 3.5 }]);
});

// ═══ ملخّص المناديب (GET /van-stock/summary) ═══

test('ملخّص المناديب: الأعمدة الأربعة بالوحدة الكبرى من الصفوف نفسها، والتالف بموجبه وحده كـtotalDamaged', () => {
  const rows = [
    { productId: 'P1', unit: 'قارورة', primaryUnitId: 'u-c', remaining: 43, loaded: 48, sold: 5, damaged: -3 },
    { productId: 'P2', unit: 'علبة', primaryUnitId: null, remaining: -6, loaded: 0, sold: 6, damaged: 12 },
  ];
  const units = new Map([['P1', [CT, PL]], ['P2', [{ name: 'كرتون', factor: 12 }]]]);
  // P1 بالرئيسية (كرتون ٢٤ لا الطبلية)، وP2 بكرتونه (١٢) — والاسم واحد فيُضمّان
  assert.deepEqual(repStockMajor(rows, units), {
    remaining: [{ unit: 'كرتون', qty: 1.2917 }], // 43/24 − 6/12
    onVan: [{ unit: 'كرتون', qty: 1.7917 }],     // 43/24 — العجز لا يُطرح من «ما في السيارة» (UX2)
    loaded: [{ unit: 'كرتون', qty: 2 }],
    sold: [{ unit: 'كرتون', qty: 0.7083 }],      // 5/24 + 6/12
    damaged: [{ unit: 'كرتون', qty: 1 }],        // max(0, −3) + 12/12
  });
  // بلا وحدات (صنفٌ لا وحدة أكبر له) ⇒ كل صنفٍ بأساسه، والصفر يسقط
  assert.deepEqual(repStockMajor(rows, new Map()), {
    remaining: [{ unit: 'قارورة', qty: 43 }, { unit: 'علبة', qty: -6 }],
    onVan: [{ unit: 'قارورة', qty: 43 }],
    loaded: [{ unit: 'قارورة', qty: 48 }],
    sold: [{ unit: 'علبة', qty: 6 }, { unit: 'قارورة', qty: 5 }],
    damaged: [{ unit: 'علبة', qty: 12 }],
  });
  assert.deepEqual(repStockMajor([], new Map()), { remaining: [], onVan: [], loaded: [], sold: [], damaged: [] });
});

// ═══ بطاقة «في مخزون السيارات» (GET /warehouse/vans) ═══

const perRep = [
  { repId: 'A', products: [{ productId: 'a', remaining: 30, unsellable: 2 }, { productId: 'b', remaining: -5, unsellable: 0 }, { productId: 'c', remaining: 6, unsellable: 0 }] },
  { repId: 'B', products: [{ productId: 'a', remaining: 10, unsellable: 0 }] },
  { repId: 'C', products: [] },
];
const meta = new Map<string, MajorUnitProduct>([
  ['a', { unit: 'حبة', units: [CT] }],
  ['b', { unit: 'حبة', units: [CT] }],
  ['c', { unit: 'كيس', units: [] }],
]);
const avg = new Map([['a', 2]]); // c بلا تكلفة معروفة ⇒ خارج القيمة

test('بطاقة السيارات: major من الأرقام نفسها — المتاح الموجب وحده، وغير المقيَّم، وما لا يُباع', () => {
  const s = summarizeVansStock(perRep, new Map(), avg, 2, meta);
  assert.equal(s.qty, 46);
  assert.equal(s.uncostedQty, 6);
  assert.equal(s.unsellableQty, 2);
  assert.deepEqual(s.major, {
    qty: [{ unit: 'كيس', qty: 6 }, { unit: 'كرتون', qty: 1.6667 }], // ٤٠ حبة = 1.6667 كرتون، والسالب في b لا يُنقصها
    uncostedQty: [{ unit: 'كيس', qty: 6 }],
    unsellableQty: [{ unit: 'كرتون', qty: 0.0833 }],
  });
});

test('بطاقة السيارات: بلا أصناف ⇒ الناتج كما كان حرفياً بلا مفتاح major، والحقول القائمة لا تتغيّر بتمريرها', () => {
  const before = summarizeVansStock(perRep, new Map(), avg, 2);
  assert.ok(!('major' in before));
  const { major, ...rest } = summarizeVansStock(perRep, new Map(), avg, 2, meta);
  assert.ok(major);
  assert.deepEqual(rest, before);
  // سياراتٌ فارغة ⇒ قوائم فارغة لا غياب
  assert.deepEqual(summarizeVansStock([], new Map(), avg, 2, meta).major, { qty: [], uncostedQty: [], unsellableQty: [] });
});
