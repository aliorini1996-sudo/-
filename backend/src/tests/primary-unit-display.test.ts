// «الوحدة الرئيسية» — عرض الخادم (primary_unit_spec §2.17، الحزمة B1): التقارير، والمندوب الذكي، ولوكيشن، ودقّة الاقتراح
// (ومعها إصلاح #12)، وشرح الاقتراح، ورسائل نقص LOT. صنفٌ أساسه قارورة، كرتونه ٢٤ رئيسيّ، وفوقه طبلية ١٢٠٠ — وكل ناتجٍ
// لصنفٍ بلا رئيسية (غائبة أو null أو تالفة) بشكله قبل الميزة حرفاً (I1). دوالّ صرفة بلا قاعدة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lotSalesRows, primaryKey, reportUnit, returnLineView, salesByProduct } from '../routes/reports';
import { ACTIVE_UNITS_SELECT, displayUnits, primaryIdOf, qtyText, unitSizes } from '../ai-rep/baseQty';
import { expectedFor } from '../ai-rep/googleDemand';
import { buildLocationsSummary, type ProductInfo } from '../services/locations';
import { computeAccuracy, mergeLoadItems } from '../services/suggestAccuracy';
import { suggestLoad, type SaleRow } from '../services/suggestLoad';
import { buildPlaceView, pickOutSources, withQtyProduct, zeroBuckets, type LotMeta } from '../services/lots';

const UNITS = [
  { id: 'u-c', name: 'كرتون', factor: 24, isActive: true },
  { id: 'u-pl', name: 'طبلية', factor: 1200, isActive: true },
];

// ═══ routes/reports.ts ═══

test('التقارير: reportUnit يحفظ المعرّف حين حضر، وprimaryKey يحضر بالرئيسية وحدها', () => {
  assert.deepEqual(reportUnit({ id: 'u-c', name: 'كرتون', factor: '24' }), { id: 'u-c', name: 'كرتون', factor: 24 });
  assert.deepEqual(reportUnit({ name: 'كرتون', factor: 24 }), { name: 'كرتون', factor: 24 }, 'بلا معرّف كما كان');
  assert.deepEqual(primaryKey('u-c'), { primaryUnitId: 'u-c' });
  assert.deepEqual(primaryKey(null), {});
  assert.deepEqual(primaryKey(undefined), {});
  assert.deepEqual(ACTIVE_UNITS_SELECT.select, { id: true, name: true, factor: true });
});

test('المبيعات حسب الصنف: صفّ الصنف ذي الرئيسية يحمل primaryUnitId، وبلاها (null) الصفّ كما كان حرفاً', () => {
  const item = (pid: string, primaryUnitId: string | null) => ({
    qty: 2, lineTotal: 96, unitName: 'كرتون', unitFactor: 24, baseQty: 48,
    product: { id: pid, name: 'ماء', code: pid, unit: 'قارورة', primaryUnitId },
  });
  const unitsOf = new Map([['p1', [{ id: 'u-c', name: 'كرتون', factor: 24 }]], ['p2', [{ id: 'u-c2', name: 'كرتون', factor: 24 }]]]);
  const rows = salesByProduct([{ items: [item('p1', 'u-c'), item('p2', null)] }], unitsOf);
  const p1 = rows.find((r) => r.productId === 'p1')!;
  const p2 = rows.find((r) => r.productId === 'p2')!;
  assert.equal(p1.primaryUnitId, 'u-c');
  assert.equal(p1.baseQty, 48, 'الكمية بالأساس لا تتغيّر');
  assert.deepEqual(p2, { productId: 'p2', name: 'ماء', code: 'p2', qty: 48, baseQty: 48, unit: 'قارورة', units: [{ id: 'u-c2', name: 'كرتون', factor: 24 }], total: 96 });
  assert.ok(!('primaryUnitId' in p2));
});

test('بند المرتجع: primaryUnitId حين للصنف رئيسية (فيُلحق العارض الوحدة)، وnull أو غائب ⇒ الشكل القائم', () => {
  const base = { qty: 5, lineTotal: 10, returnExpired: null, expiresAt: null, itemName: null, unitName: null, unitFactor: 1, baseQty: 5 };
  const withP = returnLineView({ ...base, product: { name: 'ماء', unit: 'قارورة', primaryUnitId: 'u-c' } });
  assert.equal(withP.primaryUnitId, 'u-c');
  assert.deepEqual([withP.qty, withP.unit, withP.baseQty, withP.unitFactor], [5, 'قارورة', 5, 1]);
  const nul = returnLineView({ ...base, product: { name: 'ماء', unit: 'قارورة', primaryUnitId: null } });
  const old = returnLineView({ ...base, product: { name: 'ماء', unit: 'قارورة' } });
  assert.deepEqual(nul, old);
  assert.deepEqual(Object.keys(old), ['name', 'unit', 'qty', 'unitFactor', 'baseQty', 'baseUnit', 'lineTotal', 'returnExpired', 'expiresAt'], 'ترتيب المفاتيح كما كان');
});

test('المبيع حسب التشغيلة: سطر الصنف ومجموعه يحملان primaryUnitId بالرئيسية وحدها', () => {
  const invoices = [{ id: 'i1', type: 'CASH', customerId: 'c1', items: [{ lots: [
    { productId: 'p1', lotId: null, quantity: 48, certainty: 'UNKNOWN' },
    { productId: 'p2', lotId: null, quantity: 3, certainty: 'UNKNOWN' },
  ] }] }];
  const products = new Map([
    ['p1', { name: 'ماء', code: 'P1', unit: 'قارورة', units: [{ id: 'u-c', name: 'كرتون', factor: 24 }], primaryUnitId: 'u-c' }],
    ['p2', { name: 'لبن', code: 'P2', unit: 'علبة', units: [], primaryUnitId: null }],
  ]);
  const r = lotSalesRows(invoices, products, new Map());
  const row1 = r.rows.find((x) => x.productId === 'p1')!;
  const row2 = r.rows.find((x) => x.productId === 'p2')!;
  assert.equal(row1.primaryUnitId, 'u-c');
  assert.equal(r.products.find((x) => x.productId === 'p1')!.primaryUnitId, 'u-c', 'مجموع الصنف أيضاً');
  assert.ok(!('primaryUnitId' in row2));
  assert.ok(!('primaryUnitId' in r.products.find((x) => x.productId === 'p2')!));
});

// ═══ ai-rep/baseQty.ts وgoogleDemand.ts ═══

test('المندوب الذكي: displayUnits يحفظ المعرّف ويَسِم الرئيسية الصالحة، وqtyText يقف عندها', () => {
  const rows = [{ id: 'u-pl', name: 'طبلية', factor: 1200 }, { id: 'u-c', name: 'كرتون', factor: '24' }];
  const plain = displayUnits(rows);
  assert.deepEqual(plain, [{ id: 'u-pl', name: 'طبلية', factor: 1200 }, { id: 'u-c', name: 'كرتون', factor: 24 }], 'بلا رئيسية: لا وسم');
  assert.deepEqual(displayUnits(rows, null), plain);
  assert.deepEqual(displayUnits(rows, 'u-gone'), plain, 'معرّفٌ تالف ⇒ لا وسم');
  const marked = displayUnits(rows, 'u-c');
  assert.deepEqual(marked, [{ id: 'u-pl', name: 'طبلية', factor: 1200 }, { id: 'u-c', name: 'كرتون', factor: 24, primary: true }]);
  assert.equal(primaryIdOf(marked), 'u-c');
  assert.equal(primaryIdOf(plain), null);
  // العرض: بالوسم، أو بالمعرّف الصريح — وبلا رئيسية القائم حرفاً
  assert.equal(qtyText(1250, marked, 'قارورة'), '52 كرتون و2 قارورة');
  assert.equal(qtyText(0, marked, 'قارورة'), '0 كرتون');
  assert.equal(qtyText(1250, plain, 'قارورة', 'u-c'), '52 كرتون و2 قارورة');
  assert.equal(qtyText(1250, plain, 'قارورة'), '1 طبلية و50 قارورة');
  assert.equal(qtyText(1250, plain, 'قارورة', null), '1 طبلية و50 قارورة');
  assert.equal(qtyText(51, [{ name: 'كرتون', factor: 24 }], 'حبة'), '2 كرتون و3 حبة', 'وحداتٌ بلا معرّف كما كانت');
  assert.deepEqual(unitSizes(marked, 'قارورة'), ['طبلية = 1200 قارورة', 'كرتون = 24 قارورة']);
});

test('الطلب المتوقع: الصنف ذو الرئيسية يحمل primaryUnitId مع وحداته، وبلاها لا مفتاح', () => {
  const marked = displayUnits(UNITS, 'u-c');
  const e = expectedFor({
    outletType: 'GROCERY', rating: null, ratingCount: null, source: 'VAN', showMoney: false,
    products: [
      { productId: 'p1', name: 'ماء', unit: 'قارورة', units: marked },
      { productId: 'p2', name: 'عصير', unit: 'علبة', units: displayUnits(UNITS) },
      { productId: 'p3', name: 'لبن', unit: 'علبة' },
    ],
    anchors: new Map(),
  });
  const by = new Map(e.products.map((p) => [p.productId, p]));
  assert.equal(by.get('p1')!.primaryUnitId, 'u-c');
  assert.ok(!('primaryUnitId' in by.get('p2')!));
  assert.ok(!('primaryUnitId' in by.get('p3')!) && !('units' in by.get('p3')!));
});

// ═══ services/locations.ts ═══

test('لوكيشن: سطر الصنف المحمَّل يحمل وحداته ورئيسيّه حين له رئيسية صالحة وحدها — وغيره بشكله القائم', () => {
  const products = new Map<string, ProductInfo>([
    ['P1', { name: 'ماء', unit: 'قارورة', units: UNITS, primaryUnitId: 'u-c' }],
    ['P2', { name: 'عصير', unit: 'علبة', units: UNITS, primaryUnitId: null }],
    ['P3', { name: 'لبن', unit: 'علبة', units: UNITS, primaryUnitId: 'u-gone' }],
    ['P4', { name: 'سكر', unit: 'كيس' }],
  ]);
  const s = buildLocationsSummary([], [{ locationId: null, items: [
    { productId: 'P1', qty: 1250 }, { productId: 'P2', qty: 30 }, { productId: 'P3', qty: 20 }, { productId: 'P4', qty: 10 },
  ] }], [], products);
  const by = new Map(s.none.loads.products.map((p) => [p.productId, p]));
  assert.deepEqual(by.get('P1'), { productId: 'P1', name: 'ماء', unit: 'قارورة', qty: 1250, units: UNITS, primaryUnitId: 'u-c' });
  assert.deepEqual(by.get('P2'), { productId: 'P2', name: 'عصير', unit: 'علبة', qty: 30 });
  assert.deepEqual(by.get('P3'), { productId: 'P3', name: 'لبن', unit: 'علبة', qty: 20 }, 'رئيسيةٌ تالفة ⇒ القائم');
  assert.deepEqual(by.get('P4'), { productId: 'P4', name: 'سكر', unit: 'كيس', qty: 10 });
});

// ═══ services/suggestAccuracy.ts ═══

const DAY = 86400000;
const NOW = new Date(2026, 9, 20, 12, 0, 0);
const at = (d: number) => new Date(NOW.getTime() - d * DAY);

test('#12 دقّة الاقتراح: بندا الصنف في التحميل الواحد يُدمجان بالأساس — «2 كرتون + 2 قارورة» لاقتراح 50 تبنٍّ', () => {
  const r = computeAccuracy({
    now: NOW,
    loads: [{ id: 'L1', at: at(2), items: [
      { productId: 'p1', qty: 48, suggestedQty: 50, expectedQty: 45 },   // «2 كرتون» بالأساس، وعليه الاقتراح
      { productId: 'p1', qty: 2, suggestedQty: null, expectedQty: null }, // «2 قارورة» بند ثانٍ للصنف نفسه
    ] }],
    sales: [{ productId: 'p1', qty: 45, at: at(2) }],
    products: [{ id: 'p1', name: 'ماء', code: 'P1', unit: 'قارورة' }],
  });
  assert.equal(r.days.length, 1);
  const d = r.days[0];
  assert.equal(d.loaded, 50, 'المحمَّل مجموع البندين بالأساس');
  assert.equal(d.adopted, true, 'المحمَّل = المقترح ⇒ تبنٍّ');
  assert.equal(d.expected, 45, 'التنبّؤ واحدٌ لا يتضاعف');
  assert.equal(r.summary.unmeasured, 0, 'البند الثاني ليس «بلا تنبّؤ»');
  assert.equal(r.summary.adoptionRate, 100);
});

test('#12 mergeLoadItems: بندٌ واحد لكل صنف كما هو حرفاً، والتنبّؤ والمقترح أوّل قيمةٍ غير فارغة لا مجموعهما', () => {
  const single = [{ productId: 'p1', qty: 24, suggestedQty: 24, expectedQty: 20 }];
  assert.equal(mergeLoadItems(single)[0], single[0], 'البند نفسه (===)');
  const m = mergeLoadItems([
    { productId: 'p1', qty: 2, suggestedQty: null, expectedQty: null },
    { productId: 'p2', qty: 5, suggestedQty: 5, expectedQty: 4 },
    { productId: 'p1', qty: 48, suggestedQty: 50, expectedQty: 45 },
    { productId: 'p1', qty: 24, suggestedQty: 99, expectedQty: 99 },
  ]);
  assert.deepEqual(m, [
    { productId: 'p1', qty: 74, suggestedQty: 50, expectedQty: 45 },
    { productId: 'p2', qty: 5, suggestedQty: 5, expectedQty: 4 },
  ]);
  assert.deepEqual(mergeLoadItems([{ productId: 'p1', qty: 1, suggestedQty: null, expectedQty: null }, { productId: 'p1', qty: 1, suggestedQty: null, expectedQty: null }]),
    [{ productId: 'p1', qty: 2, suggestedQty: null, expectedQty: null }]);
});

test('دقّة الاقتراح: صفّ الصنف ذي الرئيسية يحمل وحداته ورئيسيّه، وبلاها الصفّ بشكله القائم', () => {
  const loads = [{ id: 'L1', at: at(2), items: [{ productId: 'p1', qty: 48, suggestedQty: 48, expectedQty: 40 }, { productId: 'p2', qty: 48, suggestedQty: 48, expectedQty: 40 }] }];
  const r = computeAccuracy({
    now: NOW, loads, sales: [],
    products: [
      { id: 'p1', name: 'ماء', code: 'P1', unit: 'قارورة', units: UNITS, primaryUnitId: 'u-c' },
      { id: 'p2', name: 'عصير', code: 'P2', unit: 'علبة', units: UNITS, primaryUnitId: null },
    ],
  });
  const p1 = r.days.find((d) => d.productId === 'p1')!;
  const p2 = r.days.find((d) => d.productId === 'p2')!;
  assert.deepEqual([p1.units, p1.primaryUnitId], [UNITS, 'u-c']);
  assert.ok(!('units' in p2) && !('primaryUnitId' in p2));
  assert.deepEqual(Object.keys(p2), ['day', 'productId', 'name', 'unit', 'expected', 'suggested', 'loaded', 'actual', 'error', 'adopted', 'outcome', 'open']);
});

// ═══ services/suggestLoad.ts ═══

test('شرح الاقتراح: بالرئيسية «50 كرتون» لا «1 طبلية» — وبلا رئيسية القائم حرفاً', () => {
  const TARGET = new Date(2026, 9, 21);
  const sales: SaleRow[] = [];
  for (let i = 1; i <= 28; i++) sales.push({ productId: 'p1', qty: 1200, date: new Date(TARGET.getTime() - i * DAY) });
  const run = (primaryUnitId?: string | null) =>
    suggestLoad({ sales, targetDate: TARGET, bufferPct: 0, products: [{ id: 'p1', name: 'ماء', code: 'P1', unit: 'قارورة', units: UNITS, primaryUnitId }] }).rows[0];
  assert.equal(run('u-c').suggested, 1200);
  assert.ok(run('u-c').why.endsWith(' والمقترح 50 كرتون.'), run('u-c').why);
  assert.ok(run(null).why.endsWith(' والمقترح 1 طبلية.'), run(null).why);
  assert.equal(run(undefined).why, run(null).why);
  assert.equal(run('u-gone').why, run(null).why, 'رئيسيةٌ تالفة ⇒ القائم');
});

// ═══ services/lots.ts ═══

test('LOT: رسالة النقص بالرئيسية حين صفّ الصنف في العرض وله رئيسية — وإلا الرقم كما كان', () => {
  const meta: LotMeta = { id: 'L1', productId: 'p1', lotNumber: 'A1', productionDate: null, expiryDate: null, status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: new Date(0) };
  const view = buildPlaceView({
    productId: 'p1', place: 'WAREHOUSE', vanKey: null, total: { SELLABLE: 48, EXPIRED: 0, DAMAGED: 0 },
    named: new Map([['L1', { raw: { SELLABLE: 48, EXPIRED: 0, DAMAGED: 0 }, held: zeroBuckets() }]]),
    heldUnknown: zeroBuckets(), metas: new Map([['L1', meta]]),
  });
  assert.ok(!('qtyProduct' in view), 'العرض بلا صفّ الصنف كما كان');
  const msg = (v: typeof view) => { const r = pickOutSources(v, 'SELLABLE', 50); assert.equal(r.ok, false); return (r as { error: Error }).error.message; };
  assert.equal(msg(view), 'الكمية أكبر من المتاح في تشغيلات المستودع (48)');
  const prod = { unit: 'قارورة', units: UNITS, primaryUnitId: 'u-c' };
  assert.equal(msg(withQtyProduct(view, prod)), 'الكمية أكبر من المتاح في تشغيلات المستودع (2 كرتون)');
  assert.equal(msg(withQtyProduct(view, { ...prod, primaryUnitId: null })), 'الكمية أكبر من المتاح في تشغيلات المستودع (48)');
  assert.equal(withQtyProduct(view, null), view);
});
