// الوحدات المتعددة في تطبيق المندوب (repUnits.ts وبانيات RepDocuments) — صنفٌ يُباع بالكرتون (٢٤ حبة) ويُرجَع بالحبّة.
// الحارس الأوّل دائماً: صنفٌ بلا وحدات يبقى سلوكه حرفياً كما قبل الميزة (لا منتقي، الجسم نفسه، الأرقام نفسها).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  cartBadge, cartCount, choiceById, choiceNet, defaultChoice, hasUnitChoice, invoiceItemUnit, lineUnitOf, linkedLineUnit, refreshLineUnit,
  unitChoices, unitsText,
} from './repUnits';
import { invoiceDocFromDetail, loadNoticeDocFromData, showsItemUnit, statementDocFromData, warehouseNoticeDocFromEntry } from './RepDocuments';

const water = {
  id: 'p-w', unit: 'حبة', basePrice: 0.5,
  units: [
    { id: 'u-ctn', name: 'كرتون', factor: 24, price: null, isActive: true },
    { id: 'u-pack', name: 'شدّة', factor: 6, price: 2.75, isActive: true },
    { id: 'u-old', name: 'صندوق', factor: 48, price: null, isActive: false },
  ],
};
const plain = { id: 'p-j', unit: 'كرتون', basePrice: 23 };

test('وحدات البند: الأساس أوّلاً ثم النشطة تصاعدياً، والموقوفة لا تُعرض (الخادم يردّها إلى الأساس)', () => {
  assert.deepEqual(unitChoices(water).map(c => [c.id, c.name, c.factor]), [[null, 'حبة', 1], ['u-pack', 'شدّة', 6], ['u-ctn', 'كرتون', 24]]);
  assert.equal(hasUnitChoice(water), true);
  // صنفٌ بلا وحدات وكاشٌ قديم بلا units: وحدةٌ واحدة — لا منتقي ولا تخمين
  assert.deepEqual(unitChoices(plain).map(c => [c.id, c.name, c.factor]), [[null, 'كرتون', 1]]);
  assert.equal(hasUnitChoice(plain), false);
  assert.equal(hasUnitChoice(undefined), false);
  assert.equal(choiceById(water, 'u-old'), null, 'وحدةٌ موقوفة لا تُختار');
  assert.equal(choiceById(water, null)!.name, 'حبة');
});

test('الافتراض في البيع = أكبر وحدة: بعد التحويل إلى الحبّة يبقى نقر المندوب «+١ كرتون»', () => {
  assert.equal(defaultChoice(water).id, 'u-ctn');
  assert.equal(defaultChoice(plain).id, null);
});

test('سعر الوحدة كمرجع حارس الخادم: الأساس حرفياً، والمشتقّ = الأساس × المعامل، وسعر العميل × المعامل يغلب المحدَّد', () => {
  const [base, pack, ctn] = unitChoices(water);
  assert.equal(choiceNet(base, 0.5), 0.5);
  assert.equal(choiceNet(base, 0.5, 1.2345), 1.2345, 'سعر عميلٍ بأربع خانات لا يُقصّ لوحدة الأساس');
  assert.equal(choiceNet(ctn, 0.5), 12);
  assert.equal(choiceNet(pack, 0.5), 2.75, 'بلا سعر عميل: سعر الشدّة المحدَّد (جملة)');
  assert.ok(Math.abs(choiceNet(ctn, 0.5, 0.45) - 10.8) < 1e-9, 'سعر العميل للحبّة × ٢٤');
  // سعر العميل يغلب سعر الوحدة المحدَّد — كما يحكم الخادم (ref = cp × factor)؛ وإلا رُفض مندوبٌ بلا «تغيير السعر» (٢٫٧٥ > ٢٫٧٠)
  assert.ok(Math.abs(choiceNet(pack, 0.5, 0.45) - 2.7) < 1e-9);
  assert.equal(choiceNet(base, 0.5, null), 0.5, 'null = لا سعر عميل');
});

test('لقطة البند وجسمه: unitId ومعه لقطة الجهاز، وبند الأساس لقطته بلا unitId (تكشف تحويل الأساس بعد الصفّ)', () => {
  const [base, , ctn] = unitChoices(water);
  assert.deepEqual(lineUnitOf(base), { unit: 'حبة', unitId: null, unitName: null, unitFactor: 1, unitDefPrice: null });
  assert.deepEqual(lineUnitOf(ctn), { unit: 'كرتون', unitId: 'u-ctn', unitName: 'كرتون', unitFactor: 24, unitDefPrice: null });
  assert.deepEqual(invoiceItemUnit(lineUnitOf(ctn)), { unitId: 'u-ctn', unitName: 'كرتون', unitFactor: 24 });
  // صنفٌ بلا وحدات: اسم أساسه بمعامل ١ ولا unitId — الخادم يحلّه أساساً كما كان (الاسم = أساسه)، وإن حُوِّل
  // أساسه بعد صفّ الفاتورة على الجهاز عرف أنّ «كرتون» صار وحدةً فلا يقيّد الكرتونين حبّتين
  assert.deepEqual(invoiceItemUnit(lineUnitOf(unitChoices(plain)[0])), { unitName: 'كرتون', unitFactor: 1 });
  assert.ok(!('unitId' in invoiceItemUnit(lineUnitOf(base))));
  assert.deepEqual(invoiceItemUnit({ unit: '', unitId: null }), {}, 'صنفٌ بلا اسم وحدة: لا لقطة');
  assert.deepEqual(linkedLineUnit({ unit: 'حبة', retUnitId: null, retUnitName: null, retUnitFactor: 1 }),
    { unit: 'حبة', unitId: null, unitName: null, unitFactor: 1, unitDefPrice: null });
});

test('بعد 409 UNIT_CHANGED: البند بوحدته كما هي الآن، وبند الأساس الذي صار اسمه وحدةً يصير بها (كرتونان لا حبّتان)', () => {
  // كاش الجهاز: «عصير» بأساس كرتون بلا وحدات. والخادم: حُوِّل إلى الحبّة والكرتون وحدةٌ بمعامل ١٢
  const converted = { id: 'p-j', unit: 'حبة', basePrice: 23 / 12, units: [{ id: 'u-j', name: 'كرتون', factor: 12, price: 23, isActive: true }] };
  assert.equal(refreshLineUnit({ unit: 'كرتون', unitId: null }, converted)!.id, 'u-j');
  assert.equal(refreshLineUnit({ unit: 'كرتونة', unitId: null }, { ...plain, unit: 'كرتون' })!.id, null, 'إعادة تسمية الأساس: يبقى أساساً');
  assert.equal(refreshLineUnit({ unit: 'كرتون', unitId: 'u-ctn' }, water)!.factor, 24);
  assert.equal(refreshLineUnit({ unit: 'صندوق', unitId: 'u-old' }, water), null, 'وحدةٌ أُوقفت: لا ردّ صامت إلى الأساس');
  assert.equal(refreshLineUnit({ unit: 'كرتون', unitId: null }, undefined), null);
});

test('شارة الشبكة وعدّاد الشريط: كما كانا لبنود الأساس، ولا جمع كرتونٍ مع حبّة في رقم', () => {
  const ctn = { productId: 'p-w', qty: 2, unitId: 'u-ctn', unitFactor: 24 };
  const pcs = { productId: 'p-w', qty: 3, unitId: null, unitFactor: 1 };
  const j = { productId: 'p-j', qty: 4, unitId: null, unitFactor: 1 };
  assert.equal(cartBadge([j], 'p-j', plain), 4);
  assert.equal(cartBadge([j], 'p-w', water), 0);
  assert.equal(cartBadge([ctn, pcs], 'p-w', water), '2 كرتون و3 حبة');
  assert.equal(cartBadge([pcs, { ...pcs, qty: 2 }], 'p-w', water), 5, 'بندان بالمعامل نفسه يُجمعان');
  assert.equal(cartCount([j, { ...j, qty: 1.5 }]), 5.5, 'بنود الأساس: مجموع الكميات كما كان');
  assert.equal(cartCount([ctn, pcs, j]), 3, 'وحداتٌ مختلطة: عدد البنود');
});

test('الكمية بالأساس للعرض: «٢ كرتون و٣ حبة» لصنفٍ له وحدات، وnull لغيره فيبقى العرض كما كان', () => {
  assert.equal(unitsText(51, water, n => String(n)), '2 كرتون و3 حبة');
  assert.equal(unitsText(-24, water, n => String(n)), '-1 كرتون', 'العجز بإشارته');
  assert.equal(unitsText(51, water, n => n.toLocaleString('ar-SA')), '٢ كرتون و٣ حبة', 'أرقام الشاشة بخيار الشركة');
  assert.equal(unitsText(5, plain, n => String(n)), null);
});

test('الطباعة: الوحدة تُطبع لبندٍ بغير الأساس أو لصنفٍ له وحدات ولو أخفاها القالب — وإلا بخيار القالب كما كان', () => {
  assert.equal(showsItemUnit({ unit: 'كرتون', unitFactor: 24 }, false), true);
  assert.equal(showsItemUnit({ unit: 'حبة', unitFactor: 1, multiUnit: true }, false), true);
  assert.equal(showsItemUnit({ unit: 'كرتون' }, false), false, 'صنفٌ بوحدةٍ واحدة: خيار الشركة يُحترم');
  assert.equal(showsItemUnit({ unit: 'كرتون' }, true), true);
  assert.equal(showsItemUnit({ unitFactor: 24 }, true), false, 'لا اسم ⇒ لا شيء يُطبع');
});

test('البانيات المشتركة (المندوب واللوحة و/m): لقطة وحدة البند لا وحدة الصنف الحالية', () => {
  const inv = invoiceDocFromDetail({
    number: 'INV-1', invoiceDate: '2026-10-29', type: 'CASH', customer: { name: 'بقالة' }, subtotal: 0, discountAmt: 0, taxAmt: 0, total: 0,
    items: [
      { product: { name: 'ماء', unit: 'حبة', units: [{ id: 'u-ctn' }] }, unitName: 'كرتون', unitFactor: 24, qty: 2, unitPrice: 12, discountPct: 0, taxPct: 15, lineTotal: 24 },
      { product: { name: 'ماء', unit: 'حبة', units: [{ id: 'u-ctn' }] }, unitName: null, unitFactor: 1, qty: 3, unitPrice: 0.5, discountPct: 0, taxPct: 15, lineTotal: 1.5 },
      // بندٌ من خادمٍ قبل الميزة: كما كان حرفياً
      { product: { name: 'عصير', unit: 'كرتون' }, qty: 1, unitPrice: 23, discountPct: 0, taxPct: 15, lineTotal: 23 },
    ],
  }, 'أحمد');
  assert.deepEqual(inv.items.map(i => [i.unit, i.unitFactor, i.multiUnit]), [['كرتون', 24, true], ['حبة', 1, true], ['كرتون', undefined, false]]);
  const load = loadNoticeDocFromData('أحمد', { kind: 'LOAD', date: '2026-10-29', items: [
    { name: 'ماء', qty: 10, unit: 'حبة', unitName: 'كرتون', unitFactor: 24 }, { name: 'عصير', qty: 3, unit: 'كرتون' },
  ] });
  assert.deepEqual(load.items, [{ name: 'ماء', qty: 10, unit: 'كرتون', unitFactor: 24 }, { name: 'عصير', qty: 3, unit: 'كرتون' }]);
  const wh = warehouseNoticeDocFromEntry({ id: 'e-1', type: 'RECEIVE', createdAt: '2026-10-29', totalCost: 240, items: [
    { qty: 2, unitName: 'كرتون', unitFactor: 24, unitCost: 120, lineCost: 240, product: { name: 'ماء', unit: 'حبة' } },
  ] });
  assert.deepEqual([wh.items[0].unit, wh.items[0].unitFactor, wh.items[0].unitCost], ['كرتون', 24, 120], 'سعر الوحدة بوحدة السطر لا الأساس');
  const st = statementDocFromData({ name: 'بقالة' } as never, [
    { entryDate: '2026-10-29', description: 'بيع', debit: 24, credit: 0, balance: 24, type: 'INVOICE_DEBIT', invoice: { number: 'INV-1', items: [
      { product: { name: 'ماء', unit: 'حبة' }, unitName: 'كرتون', unitFactor: 24, qty: 2 },
      { product: { name: 'عصير', unit: 'كرتون' }, qty: 1 },
    ] } },
  ], 'أحمد');
  assert.deepEqual(st.entries[0].items, [{ name: 'ماء', qty: 2, unit: 'كرتون', unitFactor: 24 }, { name: 'عصير', qty: 1, unit: 'كرتون' }]);
});

// ═══ حرّاسٌ نصّية على RepApp (المكوّن يعتمد IndexedDB والكاميرا فلا يُرسم هنا) ═══
const repApp = fs.readFileSync(path.join(process.cwd(), 'src', 'rep', 'RepApp.tsx'), 'utf8').replace(/\r\n/g, '\n');

test('بند الفاتورة يحمل وحدته ولقطتها — والجسم نفسه يُحفظ في الصندوق الأوف‑لاين ويُرفع', () => {
  const body = repApp.slice(repApp.indexOf('const body = {', repApp.indexOf('const submit = async () => {')), repApp.indexOf('attempt.current = attemptClientRef('));
  assert.match(body, /items: lines\.map\(l => \(\{[\s\S]*\.\.\.invoiceItemUnit\(l\),/, 'حمولة البند بلا وحدة: كرتونان يُخصمان حبّتين');
  assert.match(repApp, /const payload = \{ \.\.\.body, clientRef, clientCreatedAt \};/);
  assert.match(repApp, /await outboxAdd\(\{ clientRef, repId: currentRepId\(\), kind: 'invoice', payload,/, 'الصندوق يحفظ الجسم نفسه');
});

test('الدمج في السلّة بالصنف والوحدة، والتحميل والطلب يرسلان unitId', () => {
  assert.match(repApp, /prev\.findIndex\(l => l\.productId === p\.id && !l\.saleItemId && sameUnit\(l, \{ unitId: c0\.id \}\)\)/);
  assert.match(repApp, /rows\.map\(r => \(\{ productId: r\.productId, qty: Number\(r\.qty\), \.\.\.\(r\.unitId && \{ unitId: r\.unitId \}\) \}\)\)/);
  assert.match(repApp, /return \{ productId, qty: Number\(raw\), \.\.\.\(u\.id && \{ unitId: u\.id \}\) \};/);
});
