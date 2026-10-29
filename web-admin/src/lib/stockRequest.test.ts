import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseRequestQty, isInvalidRequestQty, stockRequestLines, stockRequestTotalQty, stockRequestRef,
  stockRequestToLabel, stockRequestApproverLabel, shortFirst,
  repItemQty, repRequestDirty, repRequestTotals, withRequestedProducts, requestedFirst, type RepStockRequest,
  requestUnitOf, defaultRequestUnit, prefillInUnit, stockRequestTotalText, repLineUnitId, repItemUnit, repEditItems, convertRepQty,
} from './stockRequest';

/**
 * «طلب مخزون» (طلب المالك، ١١ أكتوبر ٢٠٢٦): من صفحة مخزون الشركة يصدر المسؤول ورقة PDF
 * فيها الكمية المطلوبة لكل صنف، ويرسلها لإدارة المشتريات أو الإنتاج.
 */

test('الكمية المطلوبة: الموجب وحده طلب — والفارغ والصفر لا يدخلان الورقة', () => {
  assert.equal(parseRequestQty('12'), 12);
  assert.equal(parseRequestQty(' 2.5 '), 2.5);
  assert.equal(parseRequestQty('١٢٫٥'), 12.5, 'الأرقام الهندية والفاصلة العربية');
  assert.equal(parseRequestQty('1.256'), 1.26, 'خانتان عشريتان كالجدول');
  for (const v of ['', '   ', '0', '-3', 'abc', undefined]) assert.equal(parseRequestQty(v), null, String(v));
});

test('الخانة غير المفهومة توقف الإصدار ولا تسقط صامتة — والصفر ليس خطأ', () => {
  for (const v of ['-3', 'abc', '1e', '--']) assert.equal(isInvalidRequestQty(v), true, v);
  for (const v of ['', '0', '٠', '5', '0.5', undefined]) assert.equal(isInvalidRequestQty(v), false, String(v));
});

test('أسطر الطلب: بترتيب الأصناف المعطى، والصنف بلا كمية خارجها، والرصيد السالب يُحمل بإشارته', () => {
  const rows = [
    { productId: 'a', name: 'ماء', code: 'W1', unit: 'كرتون', onHand: 5 },
    { productId: 'b', name: 'بيض', code: 'E1', unit: 'كرتون', onHand: -4 },
    { productId: 'c', name: 'حليب', code: '', unit: 'علبة', onHand: 0 },
  ];
  const lines = stockRequestLines(rows, { a: '10', b: '20', c: '' });
  assert.deepEqual(lines.map(l => [l.productId, l.qty, l.onHand]), [['a', 10, 5], ['b', 20, -4]]);
  assert.equal(lines[0].code, 'W1');
  assert.equal(stockRequestTotalQty([{ qty: 0.1 }, { qty: 0.2 }]), 0.3, 'لا ذيل عشري من جمع الكسور');
  assert.equal(stockRequestTotalQty(lines), 30);
});

test('الناقص (صفر أو سالب) أولاً ثم البقية، وكلٌّ بترتيبه', () => {
  const r = shortFirst([{ id: 1, onHand: 3 }, { id: 2, onHand: 0 }, { id: 3, onHand: 7 }, { id: 4, onHand: -1 }]);
  assert.deepEqual(r.map(x => x.id), [2, 4, 1, 3]);
});

test('مرجع الطلب من لحظة الإصدار SR-سنةشهريوم-ساعةدقيقة', () => {
  assert.equal(stockRequestRef(new Date(2026, 9, 11, 9, 5)), 'SR-261011-0905');
});

test('الجهة وخانة اعتمادها مفاتيح ترجمة موجودة في القاموس بلغاتها', () => {
  const dict = fs.readFileSync(path.resolve(process.cwd(), 'src', 'i18n', 'strings.ts'), 'utf8');
  for (const to of ['PURCHASING', 'PRODUCTION'] as const) {
    for (const key of [stockRequestToLabel(to), stockRequestApproverLabel(to)]) {
      assert.match(dict, new RegExp(`'${key}': \\{ en: `), `مفتاح غائب: ${key}`);
    }
  }
  assert.notEqual(stockRequestToLabel('PURCHASING'), stockRequestToLabel('PRODUCTION'));
});

test('حارس ثابت: الزر بجانب «استلام / تسوية»، والورقة نوع مستند معروف يُرسم ويُسمّى', () => {
  const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...p), 'utf8');
  const page = read('pages', 'CompanyWarehousePage.tsx');
  const head = page.slice(page.indexOf("{tr('مخزون الشركة')}</h1>"), page.indexOf("{tr('استلام / تسوية')}"));
  assert.match(head, /onClick=\{\(\) => setShowRequest\(true\)\}/, 'زر طلب المخزون ليس في رأس الصفحة قبل زر الاستلام');
  assert.match(page, /<StockRequestModal rows=\{rows\}/);
  const docs = read('rep', 'RepDocuments.tsx');
  assert.match(docs, /\| StockRequestDoc;/, 'النوع خارج AnyDoc');
  assert.match(docs, /if \(doc\.kind === 'stockRequest'\) return <PrintableStockRequest/);
  assert.match(docs, /doc\.kind === 'stockRequest' \? `\$\{tr\('طلب مخزون'\)\}-\$\{doc\.ref\}`/, 'اسم الملف');
});

// ——— طلبات بضاعة المناديب (طلب المالك، ١٥ أكتوبر ٢٠٢٦) ———
const req = (id: string, items: [string, number, number][]): RepStockRequest => ({
  id, salesRepId: `rep-${id}`, repName: `مندوب ${id}`, note: null, createdAt: '', updatedAt: 'v1',
  items: items.map(([productId, requestedQty, qty]) => ({ productId, name: productId, requestedQty, qty })),
});

test('الكمية المعتمدة لبند: خانة الإداري إن كُتبت (فارغها صفر)، والنصّ غير المفهوم لا يغيّر المحفوظ', () => {
  assert.equal(repItemQty(5, undefined), 5);
  assert.equal(repItemQty(5, '3'), 3);
  assert.equal(repItemQty(5, ''), 0);
  assert.equal(repItemQty(5, '0'), 0);
  assert.equal(repItemQty(5, '٧'), 7);
  assert.equal(repItemQty(5, 'abc'), 5);
});

test('مجموع المناديب لكل صنف بالمعتمد وتعديلات الشاشة، والمتغيّر وحده «معدَّل»', () => {
  const a = req('a', [['x', 10, 8], ['y', 2, 2]]);
  const b = req('b', [['x', 4, 4], ['z', 1, 0]]);
  assert.deepEqual([...repRequestTotals([a, b], {})], [['x', 12], ['y', 2]]); // z معتمدُه صفر فلا يدخل
  assert.deepEqual([...repRequestTotals([a, b], { b: { x: '1.5', z: '3' } })], [['x', 9.5], ['y', 2], ['z', 3]]);
  assert.deepEqual([...repRequestTotals([a], { b: { x: '100' } })], [['x', 8], ['y', 2]], 'المستبعَد لا يدخل ولا تعديله');
  assert.equal(repRequestDirty(a, undefined), false);
  assert.equal(repRequestDirty(a, { x: '8' }), false, 'كتابة القيمة نفسها ليست تعديلاً');
  assert.equal(repRequestDirty(a, { x: '7' }), true);
});

test('صنف طلبه مندوب خارج جدول المستودع يُلحق برصيد صفر، وما طلبه المناديب أولاً ثم الناقص', () => {
  const rows = [{ productId: 'p1', name: 'أ', onHand: 5 }, { productId: 'p2', name: 'ب', onHand: 0 }, { productId: 'p3', name: 'ج', onHand: 9 }];
  const all = withRequestedProducts(rows, [req('a', [['p3', 1, 1], ['new', 2, 2]])]);
  assert.deepEqual(all.map(r => [r.productId, r.onHand]), [['p1', 5], ['p2', 0], ['p3', 9], ['new', 0]]);
  assert.deepEqual(requestedFirst(all, new Set(['p3', 'new'])).map(r => r.productId), ['p3', 'new', 'p2', 'p1']);
});

test('حارس ثابت: «طلب بضاعة» مكان «تحميل» لمن لا يملك الصلاحية وشركته تفعّل المستودع، والنافذة تقرأ طلبات المناديب', () => {
  const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...p), 'utf8');
  const app = read('rep', 'RepApp.tsx');
  assert.match(app, /<RepVanStock canLoad=\{user\.canManageVanStock !== false\} canRequest=\{\(company as \{ warehouseEnabled\?: boolean \} \| null\)\?\.warehouseEnabled === true\} \/>/);
  assert.match(app, /\{!canLoad && canRequest \? \(\s*<button onClick=\{openRequest\}/, 'الزر لا يتبدّل');
  assert.match(app, /repApi\.put\('\/rep-stock-requests\/mine'/);
  const modal = read('components', 'StockRequestModal.tsx');
  assert.match(modal, /queryKey: \['rep-stock-requests'\]/);
  // الإرسال يحفظ التعديل أولاً ثم يعلّم المشمول — والمرسَل نسخته من الخادم
  // (والوحدات المتعددة: تبديل وحدة بندٍ وحده تعديلٌ يُحفظ قبل الإرسال كتعديل الكمية)
  assert.match(modal, /repRequestDirty\(r, edits\[r\.id\], unitEdits\[r\.id\]\) \? await saveReq\(r\) : r\.updatedAt/);
  assert.ok(modal.indexOf('repStockRequestApi.send(') < modal.indexOf('setDoc({'), 'الورقة قبل نجاح الإرسال');
});

// ——— الوحدات المتعددة: صنف «ماء» أساسه الحبة والكرتون ٢٤ ———
const ctn = [{ id: 'u-ctn', name: 'كرتون', factor: 24, price: null, isActive: true }];
const water = { productId: 'w', name: 'ماء', code: 'W1', unit: 'حبة', onHand: 51, units: ctn };

test('الطلب العام بوحدةٍ لكل صنف: السطر يحمل معاملها ووحدات الصنف، وصنفٌ بلا وحدات كما كان حرفاً', () => {
  const egg = { productId: 'e', name: 'بيض', code: 'E1', unit: 'كرتون', onHand: 3 };
  const lines = stockRequestLines([water, egg], { w: '2', e: '5' }, { w: 'u-ctn' });
  assert.deepEqual(lines[0], { productId: 'w', name: 'ماء', code: 'W1', unit: 'كرتون', onHand: 51, qty: 2, unitFactor: 24, units: ctn, baseUnit: 'حبة' });
  assert.deepEqual(lines[1], { productId: 'e', name: 'بيض', code: 'E1', unit: 'كرتون', onHand: 3, qty: 5 }, 'بلا حقول إضافية');
  // بلا وحدةٍ مختارة ⇒ الأساس بمعامل ١
  assert.deepEqual([stockRequestLines([water], { w: '7' })[0].unit, stockRequestLines([water], { w: '7' })[0].unitFactor], ['حبة', 1]);
  // وحدةٌ لم تعد نشطة ⇒ الأساس (لا يُطبع «٢ كرتون» بمعاملٍ أُوقف)
  assert.equal(requestUnitOf({ ...water, units: [{ ...ctn[0], isActive: false }] }, 'u-ctn').id, null);
});

test('وحدة الطلب الافتراضية: ما ينقسم عليه مجموع المناديب تماماً، والأكبر بلا طلب، والأساس لصنفٍ بلا وحدات', () => {
  assert.equal(defaultRequestUnit(water, 48), 'u-ctn', '٤٨ حبة = ٢ كرتون');
  assert.equal(defaultRequestUnit(water, 13), null, '١٣ حبة لا تُكتب ٠٫٥٤ كرتون');
  assert.equal(defaultRequestUnit(water, 0), 'u-ctn', 'المشتريات تشتري بالكرتون');
  assert.equal(defaultRequestUnit({ productId: 'e', name: 'بيض', unit: 'كرتون', onHand: 0 }, 5), null);
  assert.equal(prefillInUnit(48, 24), '2');
  assert.equal(prefillInUnit(13, 1), '13');
});

test('«إجمالي الكميات»: الرقم كما كان بوحدة الأساس، ولكل وحدة حين تختلط — كالورقة المطبوعة', () => {
  assert.equal(stockRequestTotalText([{ qty: 2, unit: 'كرتون' }, { qty: 3, unit: 'علبة' }], String), '5');
  assert.equal(stockRequestTotalText([{ qty: 2, unit: 'كرتون', unitFactor: 24 }, { qty: 5, unit: 'حبة', unitFactor: 1 }, { qty: 1, unit: 'كرتون', unitFactor: 24 }], String), '3 كرتون · 5 حبة');
});

// طلب مندوب ببند كرتون (لقطته) وبند حبّات من الصنف نفسه عند مندوبٍ آخر
const unitReq = (id: string, unitName: string | null, unitFactor: number, qty: number): RepStockRequest => ({
  id, salesRepId: `rep-${id}`, repName: `مندوب ${id}`, note: null, createdAt: '', updatedAt: 'v1',
  items: [{ productId: 'w', name: 'ماء', unit: unitName ?? 'حبة', unitName, unitFactor, requestedQty: qty, qty, baseUnit: 'حبة', units: ctn }],
});

test('مجموع المناديب بالأساس: «٢ كرتون» و«٣ حبة» = ٥١ حبة لا «٥»، وتبديل الوحدة يدخل المجموع بمعاملها', () => {
  const a = unitReq('a', 'كرتون', 24, 2);
  const b = unitReq('b', null, 1, 3);
  assert.deepEqual([...repRequestTotals([a, b], {})], [['w', 51]]);
  // الإداري بدّل بند المندوب أ إلى الحبّة وكتب ٤٠
  assert.deepEqual([...repRequestTotals([a, b], { a: { w: '40' } }, { a: { w: null } })], [['w', 43]]);
  // وحدة السطر بين وحدات الصنف بمعرّفها، والأساس null، ووحدةٌ لم تعد نشطة undefined
  assert.equal(repLineUnitId(a.items[0]), 'u-ctn');
  assert.equal(repLineUnitId(b.items[0]), null);
  assert.equal(repLineUnitId({ ...a.items[0], unitFactor: 12 }), undefined, 'الكرتون صار ٢٤ بعد أن كان ١٢');
  assert.deepEqual(repItemUnit(a.items[0], undefined), { name: 'كرتون', factor: 24 });
  assert.deepEqual(repItemUnit(a.items[0], null), { name: 'حبة', factor: 1 });
});

test('حفظ تعديل الإداري: unitId حين تغيّرت الوحدة وحدها (null = الأساس)، وغيابه = وحدة سطر المندوب', () => {
  const a = unitReq('a', 'كرتون', 24, 2);
  assert.deepEqual(repEditItems(a, { w: '3' }), [{ productId: 'w', qty: 3 }], 'كميةٌ بوحدة السطر');
  assert.deepEqual(repEditItems(a, { w: '48' }, { w: null }), [{ productId: 'w', qty: 48, unitId: null }]);
  assert.deepEqual(repEditItems(a, undefined, { w: 'u-ctn' }), [], 'اختيار وحدة السطر نفسها ليس تعديلاً');
  assert.equal(repRequestDirty(a, undefined, { w: null }), true, 'تبديل الوحدة وحده تعديل');
  assert.equal(repRequestDirty(a, undefined, { w: 'u-ctn' }), false);
  // التبديل يحفظ الكمية نفسها بالأساس: ٢ كرتون ⇒ ٤٨ حبة، ولا الرقم نفسه بوحدةٍ أخرى
  assert.equal(convertRepQty(2, 24, 1), '48');
  assert.equal(convertRepQty(36, 1, 24), '1.5');
  assert.equal(convertRepQty(13, 1, 24), '0.54', 'بخانتين كما تُقرأ الخانة عند الحفظ — ما يُرى هو ما يُحفظ');
  assert.equal(repItemQty(13, convertRepQty(13, 1, 24)), 0.54);
});

test('صنفٌ طلبه مندوب خارج جدول المستودع يُلحق بوحدة الأساس ووحداته — لا بوحدة سطر المندوب', () => {
  const all = withRequestedProducts([], [unitReq('a', 'كرتون', 24, 2)]);
  assert.deepEqual(all, [{ productId: 'w', name: 'ماء', code: undefined, unit: 'حبة', onHand: 0, units: ctn }]);
});
