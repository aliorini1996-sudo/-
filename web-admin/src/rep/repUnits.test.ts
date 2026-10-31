// الوحدات المتعددة في تطبيق المندوب (repUnits.ts وبانيات RepDocuments) — صنفٌ يُباع بالكرتون (٢٤ حبة) ويُرجَع بالحبّة.
// الحارس الأوّل دائماً: صنفٌ بلا وحدات يبقى سلوكه حرفياً كما قبل الميزة (لا منتقي، الجسم نفسه، الأرقام نفسها).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  cartBadge, cartCount, choiceById, choiceNet, defaultChoice, hasUnitChoice, invoiceItemUnit, lineUnitOf, linkedLineUnit, primaryChoice, rebaseRow, refreshLineUnit,
  rebaseCustPrices, unitChoices, unitsText,
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

test('رقاقة «الوحدة الرئيسية» (primaryChoice): رقاقة الرئيسية الصالحة من unitChoices، وإلا null — والأساس يبقى أوّل الرقاقات (I4)', () => {
  const withPrimary = { ...water, primaryUnitId: 'u-pack' };
  assert.deepEqual(primaryChoice(withPrimary), unitChoices(withPrimary)[1]);
  assert.equal(primaryChoice(withPrimary)!.name, 'شدّة');
  assert.equal(unitChoices(withPrimary)[0].id, null, 'الأساس أوّلاً ولو كانت للصنف رئيسية');
  assert.deepEqual(unitChoices(withPrimary), unitChoices(water), 'الرئيسية لا تغيّر الرقاقات ولا ترتيبها');
  assert.equal(primaryChoice(water), null, 'بلا رئيسية');
  assert.equal(primaryChoice({ ...water, primaryUnitId: null }), null);
  assert.equal(primaryChoice({ ...water, primaryUnitId: 'u-old' }), null, 'الرئيسية الموقوفة ⇒ null (primaryUnitOf)');
  assert.equal(primaryChoice({ ...water, primaryUnitId: 'u-gone' }), null, 'معرّف لا يطابق وحدة (كاش قديم) ⇒ null');
  assert.equal(primaryChoice({ ...plain, primaryUnitId: 'u-ctn' }), null, 'صنف بلا وحدات');
  assert.equal(primaryChoice(undefined), null);
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

test('لقطة البند وجسمه: unitId ومعه لقطة الجهاز ووحدة أساسه، وبند الأساس لقطته بلا unitId (تكشف تحويل الأساس بعد الصفّ)', () => {
  const [base, , ctn] = unitChoices(water);
  assert.deepEqual(lineUnitOf(base, 'حبة'), { unit: 'حبة', unitId: null, unitName: null, unitFactor: 1, unitDefPrice: null, baseUnit: 'حبة' });
  assert.deepEqual(lineUnitOf(ctn, 'حبة'), { unit: 'كرتون', unitId: 'u-ctn', unitName: 'كرتون', unitFactor: 24, unitDefPrice: null, baseUnit: 'حبة' });
  // لقطة الجهاز كاملة (القاعدة ٧): الوحدة ومعاملها **ووحدة الأساس كما رآها** — «١ كرتون = ٢٤» محسوبةٌ على «حبة»
  assert.deepEqual(invoiceItemUnit(lineUnitOf(ctn, 'حبة')), { unitId: 'u-ctn', unitName: 'كرتون', unitFactor: 24, baseUnitName: 'حبة' });
  // مستدعٍ لا يعرف الأساس لبندٍ بوحدةٍ أكبر: بلا baseUnitName (سلوك اللقطة وحدها) — لا اسمٌ مخمَّن
  assert.deepEqual(invoiceItemUnit(lineUnitOf(ctn)), { unitId: 'u-ctn', unitName: 'كرتون', unitFactor: 24 });
  // صنفٌ بلا وحدات: اسم أساسه بمعامل ١ ولا unitId — الخادم يحلّه أساساً كما كان (الاسم = أساسه)، وإن حُوِّل
  // أساسه بعد صفّ الفاتورة على الجهاز عرف أنّ «كرتون» صار وحدةً فلا يقيّد الكرتونين حبّتين
  assert.deepEqual(invoiceItemUnit(lineUnitOf(unitChoices(plain)[0], 'كرتون')), { unitName: 'كرتون', unitFactor: 1, baseUnitName: 'كرتون' });
  assert.deepEqual(invoiceItemUnit(lineUnitOf(unitChoices(plain)[0])), { unitName: 'كرتون', unitFactor: 1, baseUnitName: 'كرتون' }, 'بند الأساس: أساسه اسمه');
  assert.ok(!('unitId' in invoiceItemUnit(lineUnitOf(base, 'حبة'))));
  assert.deepEqual(invoiceItemUnit({ unit: '', unitId: null }), {}, 'صنفٌ بلا اسم وحدة: لا لقطة');
  assert.deepEqual(linkedLineUnit({ unit: 'حبة', baseUnit: 'حبة', retUnitId: null, retUnitName: null, retUnitFactor: 1 }),
    { unit: 'حبة', unitId: null, unitName: null, unitFactor: 1, unitDefPrice: null, baseUnit: 'حبة' });
  // بند مرتجعٍ بالشدّة من بيع كرتون: أساسه من ردّ الخادم
  assert.deepEqual(invoiceItemUnit(linkedLineUnit({ unit: 'شدّة', baseUnit: 'حبة', retUnitId: 'u-pack', retUnitName: 'شدّة', retUnitFactor: 6 })),
    { unitId: 'u-pack', unitName: 'شدّة', unitFactor: 6, baseUnitName: 'حبة' });
});

test('مرآة حارس الخادم (resolveLineUnit الحيّ): جسمٌ من كاشٍ حديث يمرّ، ومن كاشٍ قبل تحويل الأساس يُكشف فيُردّ 400 UNIT_INVALID', () => {
  // نسخةٌ حرفية من شرط «stale» في backend/src/routes/invoices.ts للإصدار الحيّ — كي لا يُرسل الجهاز لقطةً يرفضها خادمٌ صحيح
  const stale = (prod: { unit: string; units: { id: string; name: string; factor: number }[] }, it: ReturnType<typeof invoiceItemUnit>) => {
    const i = it as { unitId?: string; unitName?: string | null; unitFactor?: number; baseUnitName?: string };
    const u = i.unitId ? prod.units.find(x => x.id === i.unitId) : undefined;
    const resolved = u ? { name: u.name, factor: u.factor } : { name: null, factor: 1 };
    return (i.unitFactor != null && i.unitFactor !== resolved.factor)
      || (i.unitName != null && i.unitName !== (resolved.name ?? prod.unit))
      || (i.baseUnitName != null && i.baseUnitName !== prod.unit);
  };
  const srv = { unit: 'حبة', units: [{ id: 'u-ctn', name: 'كرتون', factor: 24 }, { id: 'u-pack', name: 'شدّة', factor: 6 }] };
  for (const c of unitChoices(water)) assert.equal(stale(srv, invoiceItemUnit(lineUnitOf(c, water.unit))), false, c.name);
  // كاش الجهاز: «عصير» بأساس كرتون بلا وحدات — والخادم حوّله إلى حبّة وكرتونٍ بمعامل ١٢
  const converted = { unit: 'حبة', units: [{ id: 'u-j', name: 'كرتون', factor: 12 }] };
  assert.equal(stale(converted, invoiceItemUnit(lineUnitOf(unitChoices(plain)[0], plain.unit))), true);
  // وكرتونٌ تغيّر معامله من ٢٤ إلى ١٢
  assert.equal(stale({ ...srv, units: [{ id: 'u-ctn', name: 'كرتون', factor: 12 }] }, invoiceItemUnit(lineUnitOf(unitChoices(water)[2], 'حبة'))), true);
});

test('بعد 400 UNIT_INVALID: البند بوحدته كما هي الآن، وبند الأساس الذي صار اسمه وحدةً يصير بها (كرتونان لا حبّتان)', () => {
  // كاش الجهاز: «عصير» بأساس كرتون بلا وحدات. والخادم: حُوِّل إلى الحبّة والكرتون وحدةٌ بمعامل ١٢
  const converted = { id: 'p-j', unit: 'حبة', basePrice: 23 / 12, units: [{ id: 'u-j', name: 'كرتون', factor: 12, price: 23, isActive: true }] };
  assert.equal(refreshLineUnit({ unit: 'كرتون', unitId: null }, converted)!.id, 'u-j');
  assert.equal(refreshLineUnit({ unit: 'كرتونة', unitId: null }, { ...plain, unit: 'كرتون' })!.id, null, 'إعادة تسمية الأساس: يبقى أساساً');
  assert.equal(refreshLineUnit({ unit: 'كرتون', unitId: 'u-ctn' }, water)!.factor, 24);
  assert.equal(refreshLineUnit({ unit: 'صندوق', unitId: 'u-old' }, water), null, 'وحدةٌ أُوقفت: لا ردّ صامت إلى الأساس');
  assert.equal(refreshLineUnit({ unit: 'كرتون', unitId: null }, undefined), null);
});

test('صفّ التحميل والطلب بعد UNIT_INVALID: وحدته إن بقيت، وإلا بالأساس بمعامله — «١٠ كرتون» لا تصير «١٠ حبة»', () => {
  // الكرتون ما زال نشطاً: يبقى كما هو (ولو تغيّر معامله — العبوة تُعدّ عبوة)
  assert.deepEqual(rebaseRow({ unitId: 'u-ctn', unitFactor: 24, qty: '10' }, water), { choice: unitChoices(water)[2], qty: '10' });
  // أُوقف الكرتون: الأساس و٢٤٠ حبة
  const stopped = { ...water, units: water.units.map(u => (u.id === 'u-ctn' ? { ...u, isActive: false } : u)) };
  const r = rebaseRow({ unitId: 'u-ctn', unitFactor: 24, qty: '10' }, stopped)!;
  assert.deepEqual([r.choice.id, r.choice.name, r.qty], [null, 'حبة', 240]);
  assert.equal(rebaseRow({ unitId: 'u-ctn', unitFactor: 24, qty: 2.5 }, stopped)!.qty, 60);
  // كميةٌ لم تُكتب بعد أو غير رقمية: كما هي
  assert.equal(rebaseRow({ unitId: 'u-ctn', unitFactor: 24, qty: '' }, stopped)!.qty, '');
  // بند الأساس وصنفٌ بلا وحدات: كما كان حرفياً
  assert.deepEqual(rebaseRow({ unitId: null, unitFactor: 1, qty: '3' }, plain), { choice: unitChoices(plain)[0], qty: '3' });
  // صنفٌ خرج من الكتالوج: الصفّ كما هو
  assert.equal(rebaseRow({ unitId: 'u-ctn', unitFactor: 24, qty: '10' }, undefined), null);
  // صفّ أساسٍ «١٠ كرتون» وحُوِّل الصنف إلى الحبّة (الكرتون وحدةٌ بمعامل ١٢): عشرة كراتين لا عشر حبّات
  const converted = { id: 'p-j', unit: 'حبة', basePrice: 23 / 12, units: [{ id: 'u-j', name: 'كرتون', factor: 12, price: 23, isActive: true }] };
  const b = rebaseRow({ unit: 'كرتون', unitId: null, unitFactor: 1, qty: '10' }, converted)!;
  assert.deepEqual([b.choice.id, b.choice.factor, b.qty], ['u-j', 12, '10']);
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

test('ردّ 400 UNIT_INVALID في الإصدار الحيّ: الرسالة تُعرض والأصناف تُحدَّث من الخادم — لا من كاشٍ قديم', () => {
  const fail = repApp.slice(repApp.indexOf('if (isZatcaOutdatedClient(err)) setNeedsUpdate(true);'), repApp.indexOf('const refreshUnits = async'));
  assert.match(fail, /code === 'UNIT_INVALID'\) void refreshUnits\(\);/);
  assert.match(fail, /setMsg\(err\?\.response\?\.data\?\.message/);
  assert.doesNotMatch(repApp, /UNIT_CHANGED/, 'رمزٌ لا يرسله الخادم');
  const refresh = repApp.slice(repApp.indexOf('const refreshUnits = async'), repApp.indexOf('return (', repApp.indexOf('const refreshUnits = async')));
  assert.match(refresh, /if \(!data \|\| offline\) return;/, 'كاشٌ يعود بدل الخادم هو القديم نفسه');
  assert.match(refresh, /lineUnitOf\(ch, p\.unit\)/);
  assert.match(refresh, /refreshLinkedLine\(/, 'بنود المرتجع من فاتورة بيع تُقرأ من جديد');
  // والتحميل وطلب البضاعة: الكتالوج من الخادم والصفوف تُعاد بـrebaseRow — بالمعامل الذي اختير به الصفّ
  assert.equal((repApp.match(/if \(isUnitInvalid\(e\)\) \{\s*const fresh = await reloadProducts\(\);/g) ?? []).length, 2);
  assert.match(repApp, /unitId: c0\.id, unitFactor: c0\.factor \}/);
  assert.match(repApp, /unitId: o\.id, unit: o\.name, unitFactor: o\.factor \}/);
});

test('الدمج في السلّة بالصنف والوحدة، والتحميل والطلب يرسلان unitId، ولقطة البند تحمل أساس الصنف', () => {
  assert.match(repApp, /prev\.findIndex\(l => l\.productId === p\.id && !l\.saleItemId && sameUnit\(l, \{ unitId: c0\.id \}\)\)/);
  assert.match(repApp, /\.\.\.lineUnitOf\(c0, p\.unit\)/, 'بندٌ بلا أساسه: تحويل الأساس قبل رفعه يُقرأ على الأساس الجديد');
  assert.match(repApp, /\.\.\.lineUnitOf\(ch, p\.unit\), unitPrice: inclOf\(p, ch\)/);
  // و«الوحدة الرئيسية» §6.4: كل صفّ تحميلٍ أو طلبٍ يرسل أساس الصنف كما يعرفه كتالوج الجهاز (baseUnitName)
  assert.match(repApp, /rows\.map\(r => \(\{ productId: r\.productId, qty: Number\(r\.qty\), \.\.\.\(r\.unitId && \{ unitId: r\.unitId \}\), \.\.\.\(r\.baseUnit && \{ baseUnitName: r\.baseUnit \}\) \}\)\)/);
  assert.match(repApp, /return \{ productId, qty: Number\(raw\), \.\.\.\(u\.id && \{ unitId: u\.id \}\), \.\.\.\(base && \{ baseUnitName: base \}\) \};/);
});

// ═══ «الوحدة الرئيسية» (B1): الافتراض والعرض وأسعار العميل على أساس الكتالوج ═══
// صنفٌ أساسه قارورة، وكرتونه ٢٤ رئيسيّ، وفوقه طبلية ١٢٠٠ — الافتراض الكرتون لا الطبلية، والعرض يقف عند الكرتون
const bottle = {
  id: 'p-b', unit: 'قارورة', basePrice: 2,
  units: [
    { id: 'u-c', name: 'كرتون', factor: 24, price: 48, isActive: true },
    { id: 'u-pl', name: 'طبلية', factor: 1200, price: null, isActive: true },
  ],
};
const bottleP = { ...bottle, primaryUnitId: 'u-c' };

test('defaultChoice: الرئيسية تغلب الأكبر، وبلا رئيسية (أو رئيسية تالفة/null/كاش قديم) الأكبر حرفاً كما قبل الميزة', () => {
  assert.equal(defaultChoice(bottleP).id, 'u-c', 'كرتون رئيسي مع طبلية ⇒ الكرتون');
  assert.equal(defaultChoice(bottle).id, 'u-pl', 'بلا رئيسية ⇒ الأكبر (تكافؤ I1)');
  assert.equal(defaultChoice({ ...bottle, primaryUnitId: null }).id, 'u-pl');
  assert.equal(defaultChoice({ ...bottle, primaryUnitId: 'u-gone' }).id, 'u-pl', 'معرّف لا يطابق ⇒ الأكبر');
  assert.equal(defaultChoice({ ...water, primaryUnitId: 'u-old' }).id, 'u-ctn', 'رئيسية موقوفة ⇒ الأكبر النشط');
  assert.equal(defaultChoice({ ...plain, primaryUnitId: 'x' }).id, null, 'صنف بلا وحدات ⇒ الأساس');
  assert.equal(unitChoices(bottleP)[0].id, null, 'I4: الأساس أوّل الرقاقات ولو للصنف رئيسية');
});

test('unitsText وcartBadge بالرئيسية: «52 كرتون و2 قارورة» لا «1 طبلية و…»، والصفر «0 كرتون» — وبلاها القائم حرفاً', () => {
  const n = (x: number) => String(x);
  assert.equal(unitsText(1250, bottleP, n), '52 كرتون و2 قارورة');
  assert.equal(unitsText(1250, bottle, n), '1 طبلية و50 قارورة', 'بلا رئيسية: الأكبر كما اليوم');
  assert.equal(unitsText(1250, { ...bottle, primaryUnitId: null }, n), '1 طبلية و50 قارورة');
  assert.equal(unitsText(0, bottleP, n), '0 كرتون');
  assert.equal(unitsText(5, bottleP, n), '5 قارورة');
  assert.equal(unitsText(-26, bottleP, n), '-1 كرتون و2 قارورة');
  assert.equal(unitsText(1250, bottleP, x => x.toLocaleString('ar-SA')), '٥٢ كرتون و٢ قارورة');
  const lines = [
    { productId: 'p-b', qty: 1, unitId: 'u-pl', unitFactor: 1200 },
    { productId: 'p-b', qty: 2, unitId: 'u-c', unitFactor: 24 },
    { productId: 'p-b', qty: 2, unitId: null, unitFactor: 1 },
  ];
  assert.equal(cartBadge(lines, 'p-b', bottleP), '52 كرتون و2 قارورة');
  assert.equal(cartBadge(lines, 'p-b', bottle), '1 طبلية و50 قارورة', 'بلا رئيسية كما اليوم');
  assert.equal(cartCount(lines), 3, 'cartCount لا يتغيّر');
});

test('rebaseCustPrices: نفس الأساس كما هو، أساسٌ قديم صار وحدة ٢٤ ⇒ ÷٢٤، اسم مجهول يُسقط، وبلا unit أو صنف غائب كما هو', () => {
  const catalog = [bottleP, plain];
  const out = rebaseCustPrices([
    { productId: 'p-b', price: 1.9, unit: 'قارورة' },
    { productId: 'p-j', price: '22.5' },
    { productId: 'p-x', price: 7, unit: 'علبة' },
  ], catalog);
  assert.deepEqual(out, { 'p-b': 1.9, 'p-j': 22.5, 'p-x': 7 });
  // كاشٌ من قبل التحويل: السعر ٤٨ للكرتون (كان الأساس)، والكتالوج الآن أساسه قارورة والكرتون ٢٤
  assert.deepEqual(rebaseCustPrices([{ productId: 'p-b', price: 48, unit: 'كرتون' }], catalog), { 'p-b': 2 });
  assert.deepEqual(rebaseCustPrices([{ productId: 'p-b', price: 48, unit: ' كرتون ' }], catalog), { 'p-b': 2 }, 'baseNameKey: القصّ');
  assert.equal(rebaseCustPrices([{ productId: 'p-b', price: 50, unit: 'كرتون' }], catalog)['p-b'], 50 / 24, 'بلا تقريبٍ وسيط');
  // والعكس (كاش بعد التحويل وكتالوج قبله) أو اسم لا يعرفه الكتالوج ⇒ يُسقط فيحكم سعر الصنف والخادم
  assert.deepEqual(rebaseCustPrices([{ productId: 'p-b', price: 2, unit: 'حبة' }], catalog), {});
  assert.deepEqual(rebaseCustPrices([{ productId: 'p-w', price: 0.4, unit: 'صندوق' }], [water]), {}, 'وحدة موقوفة لا يُقسم عليها');
  assert.deepEqual(rebaseCustPrices([{ productId: 'p-b', price: 2, unit: null }, { productId: 'p-j', price: 23, unit: '' }], catalog), { 'p-b': 2, 'p-j': 23 }, 'بلا unit: كما هو');
  assert.deepEqual(rebaseCustPrices(null, catalog), {});
  assert.deepEqual(rebaseCustPrices([{ productId: 'p-b', price: 3, unit: 'كرتون' }], undefined), { 'p-b': 3 }, 'بلا كتالوج: كما هو');
});
