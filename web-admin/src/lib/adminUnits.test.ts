import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  hasBigUnit, biggestUnit, baseQtyText, docQtyText, totalsByUnit, lineKey, unitTaken, suggestionChoice,
  unitFormProblem, unitFormPayload, unitFormOf, EMPTY_UNIT_FORM, convertFormProblem, convertPreview, convertPayload,
} from './adminUnits';

/**
 * الوحدات المتعددة في لوحة الإدارة على الويب: صنف «ماء» أساسه الحبة، والكرتون ٢٤ حبة والطبلية ١٢٠٠.
 */
const units = [
  { id: 'u-ctn', name: 'كرتون', factor: 24, price: null, isActive: true },
  { id: 'u-pal', name: 'طبلية', factor: 1200, price: 2000, isActive: true },
];
const water = { unit: 'حبة', units };
const plain = (n: number) => String(n);

test('العرض: رصيدٌ بالأساس مفكَّكٌ بوحدات الصنف، والرقم كما كان لصنفٍ بلا وحدات', () => {
  assert.equal(baseQtyText(51, water, plain), '2 كرتون و3 حبة');
  assert.equal(baseQtyText(-24, water, plain), '-1 كرتون');
  assert.equal(baseQtyText(0, water, plain), '0 حبة');
  // صنفٌ بلا وحدات: الرقم وحده (كما كان حرفاً)، ومعه اسم الأساس حين يُطلب
  assert.equal(baseQtyText(5, { unit: 'كرتون', units: [] }, plain), '5');
  assert.equal(baseQtyText(5, { unit: 'كرتون' }, plain, { withUnit: true }), '5 كرتون');
  // المنسّق على الأرقام وحدها لا على أسماء الوحدات
  assert.equal(baseQtyText(51, water, n => `«${n}»`), '«2» كرتون و«3» حبة');
  // وحدةٌ موقوفة لا تُفكَّك بها الكمية
  assert.equal(baseQtyText(48, { unit: 'حبة', units: [{ name: 'كرتون', factor: 24, isActive: false }] }, plain), '48');
  assert.equal(hasBigUnit(units), true);
  assert.equal(hasBigUnit([]), false);
  assert.equal(biggestUnit(units)?.name, 'طبلية');
  assert.equal(biggestUnit([{ name: 'x', factor: 1 }]), null);
});

test('بند مستند: الوحدة بجانب الكمية حين البند بغير الأساس وحده — كالكشف المطبوع', () => {
  assert.equal(docQtyText({ qty: 2, unitName: 'كرتون', unitFactor: 24 }, plain), '2 كرتون');
  assert.equal(docQtyText({ qty: 3, unitName: null, unitFactor: 1, unit: 'حبة' }, plain), '3');
  assert.equal(docQtyText({ qty: 3 }, plain), '3', 'بندٌ سبق الميزة كما كان');
});

test('المجموع لكل وحدة: كرتونٌ وحبّةٌ لا يُجمعان رقماً واحداً، والبند بلا لقطة تحت وحدة صنفه', () => {
  const m = totalsByUnit([
    { qty: 2, unitName: 'كرتون', unit: 'حبة' }, { qty: 5, unit: 'حبة' }, { qty: '1', unitName: 'كرتون' }, { qty: 4 },
  ], 'وحدة');
  assert.deepEqual([...m], [['كرتون', 3], ['حبة', 5], ['وحدة', 4]]);
});

test('أسطر النماذج: المفتاح صنفٌ ووحدة، والوحدة التي أخذها سطرٌ آخر للصنف مأخوذة', () => {
  const lines = [{ productId: 'p', unitId: 'u-ctn' }, { productId: 'p', unitId: null }, { productId: 'q', unitId: 'u-ctn' }];
  assert.equal(lineKey(lines[0]), 'p:u-ctn');
  assert.equal(lineKey({ productId: 'p' }), 'p:');
  assert.equal(unitTaken(lines, 'p', null, 'p:u-ctn'), true, 'حبّة الصنف لها سطر');
  assert.equal(unitTaken(lines, 'p', 'u-ctn', 'p:u-ctn'), false, 'وحدة السطر نفسه ليست مأخوذة');
  assert.equal(unitTaken(lines, 'p', 'u-pal', 'p:u-ctn'), false);
  assert.equal(unitTaken(lines, 'q', null), false, 'صنفٌ آخر');
});

test('سطر الاقتراح: المقترَح بالأساس يُحمَّل بأكبر وحدةٍ تنقسم عليه تماماً، وإلّا بالأساس كما هو', () => {
  const s48 = suggestionChoice(water, 48);
  assert.deepEqual([s48.choice.id, s48.qty], ['u-ctn', 2]);
  const s2400 = suggestionChoice(water, 2400);
  assert.deepEqual([s2400.choice.id, s2400.qty], ['u-pal', 2], 'الأكبر أولاً');
  const s50 = suggestionChoice(water, 50);
  assert.deepEqual([s50.choice.id, s50.qty], [null, 50], 'لا تقريب صامت إلى كرتونين');
  const s0 = suggestionChoice({ unit: 'كرتون', units: [] }, 7);
  assert.deepEqual([s0.choice.id, s0.choice.name, s0.qty], [null, 'كرتون', 7], 'صنفٌ بلا وحدات كما كان');
});

test('محرّر الوحدات: قاعدة الخادم نفسها والأساس بين الأخريات', () => {
  const f = (o: Partial<typeof EMPTY_UNIT_FORM>) => ({ ...EMPTY_UNIT_FORM, ...o });
  assert.equal(unitFormProblem(f({ name: 'شدّة', factor: '6' }), water), null);
  assert.equal(unitFormProblem(f({ name: '', factor: '6' }), water), 'اسم الوحدة مطلوب');
  assert.equal(unitFormProblem(f({ name: 'حبة', factor: '6' }), water), 'اسم الوحدة مكرر لهذا الصنف', 'اسم الأساس');
  assert.equal(unitFormProblem(f({ name: 'كرتون', factor: '12' }), water), 'اسم الوحدة مكرر لهذا الصنف');
  assert.equal(unitFormProblem(f({ name: 'علبة', factor: '24' }), water), 'يوجد وحدة بالمعامل نفسه لهذا الصنف');
  assert.match(unitFormProblem(f({ name: 'علبة', factor: '1' }), water) ?? '', /المعامل 1 هو وحدة الأساس/);
  assert.match(unitFormProblem(f({ name: 'علبة', factor: '2.5' }), water) ?? '', /عدد صحيح/);
  assert.equal(unitFormProblem(f({ name: 'علبة', factor: '' }), water), 'معامل التحويل رقم أكبر من صفر');
  assert.equal(unitFormProblem(f({ name: 'علبة', factor: '6', price: 'abc' }), water), 'سعر الوحدة رقم موجب');
  // التعديل لا يقارن الوحدة بنفسها: الكرتون يبقى ٢٤ باسمه
  assert.equal(unitFormProblem(unitFormOf(units[0]), water, 'u-ctn'), null);
  assert.equal(unitFormProblem(f({ name: 'كرتون', factor: '١٢' }), water, 'u-ctn'), null, 'الأرقام الهندية');
});

test('حمولة الوحدة: السعر الفارغ null (مشتقّ)، والرمز الفارغ null، والمعامل صحيح', () => {
  assert.deepEqual(unitFormPayload({ name: ' شدّة ', factor: '6', price: '', unitCode: ' ' }), { name: 'شدّة', factor: 6, price: null, unitCode: null });
  assert.deepEqual(unitFormPayload({ name: 'كرتون', factor: '24', price: '45.5', unitCode: 'CT' }), { name: 'كرتون', factor: 24, price: 45.5, unitCode: 'CT' });
  assert.deepEqual(unitFormOf({ name: 'كرتون', factor: 24, price: null, unitCode: null }), { name: 'كرتون', factor: '24', price: '', unitCode: '' });
});

test('تحويل الأساس: مرآة رفض الخادم، ومعاينةٌ بسعر الكرتون كما هو وسعر الحبة ÷ المعامل', () => {
  const carton = { unit: 'كرتون', basePrice: 48, units: [{ id: 'u-pal', name: 'طبلية', factor: 50 }] };
  const form = { newBaseName: 'حبة', factor: '24', basePrice: '' };
  assert.equal(convertFormProblem(form, carton), null);
  assert.match(convertFormProblem({ ...form, factor: '1' }, carton) ?? '', /أكبر من 1/);
  assert.match(convertFormProblem({ ...form, factor: '2.5' }, carton) ?? '', /عدد صحيح/);
  assert.equal(convertFormProblem({ ...form, newBaseName: ' ' }, carton), 'اسم وحدة الأساس الجديدة مطلوب');
  assert.equal(convertFormProblem({ ...form, newBaseName: 'كرتون' }, carton), 'وحدة الأساس الجديدة هي الحالية نفسها');
  assert.equal(convertFormProblem({ ...form, newBaseName: 'طبلية' }, carton), 'اسم وحدة الأساس الجديدة مستخدم لوحدة أخرى لهذا الصنف');
  assert.equal(convertFormProblem(form, { ...carton, units: [{ name: 'كرتون', factor: 2 }] }), 'يوجد وحدة باسم وحدة الأساس الحالية لهذا الصنف');
  assert.equal(convertFormProblem({ ...form, factor: '5000' }, carton), 'معامل إحدى الوحدات يتجاوز الحد بعد التحويل', 'طبلية ٥٠ × ٥٠٠٠');
  assert.equal(convertFormProblem({ ...form, basePrice: '-1' }, carton), 'سعر الوحدة رقم موجب');

  const pv = convertPreview(carton, form)!;
  assert.equal(pv.factor, 24);
  assert.deepEqual(pv.oldAsUnit, { name: 'كرتون', factor: 24, price: 48 }, 'الكرتون بسعره القديم');
  assert.equal(pv.newBasePrice, 2, '٤٨ ÷ ٢٤');
  assert.deepEqual(pv.scaled, [{ name: 'طبلية', from: 50, to: 1200 }]);
  assert.equal(convertPreview({ ...carton, basePrice: 10 }, form)!.newBasePrice, 0.4167, 'أربع منازل كالخادم');
  assert.equal(convertPreview(carton, { ...form, basePrice: '2.25' })!.newBasePrice, 2.25, 'سعر المالك يغلب');
  assert.equal(convertPreview(carton, { ...form, factor: '' }), null);

  // expectedBaseName: الأساس كما رآه المالك — نقرةٌ ثانية بعد الالتزام يردّها الخادم ٤٠٩
  assert.deepEqual(convertPayload(form, 'كرتون'), { newBaseName: 'حبة', factor: 24, expectedBaseName: 'كرتون' });
  assert.deepEqual(convertPayload({ ...form, basePrice: '2.1' }, 'كرتون'), { newBaseName: 'حبة', factor: 24, expectedBaseName: 'كرتون', basePrice: 2.1 });
});

// ═══ حرّاس نصّية على الشاشات: عقود الخادم وفخّ ٢٤ ضعفاً ═══
const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...p), 'utf8');

test('نافذة الصنف: الوحدات بمساراتها، والتحويل بالأساس المتوقَّع، و٤٠٩ برسالته', () => {
  const s = read('components', 'forms', 'ProductModal.tsx');
  assert.match(s, /productApi\.addUnit\(productId, unitFormPayload\(adding\)\)/);
  assert.match(s, /productApi\.updateUnit\(productId, u\.id, unitFormPayload\(editing\)\)/);
  assert.match(s, /productApi\.updateUnit\(productId, u\.id, \{ isActive: u\.isActive === false \}\)/, 'الإيقاف والتفعيل');
  assert.match(s, /productApi\.removeUnit\(productId, u\.id\)/);
  assert.match(s, /productApi\.convertBase\(productId, convertPayload\(form, expected\)\)/);
  // الأساس المتوقَّع لحظة فتح النافذة لا ما يتغيّر بعدها
  assert.match(s, /const \[expected\] = useState\(baseUnit\);/);
  // الرفض (٤٠٩ «تغيّرت وحدة الأساس») يُعرض برسالة الخادم داخل النافذة
  assert.match(s, /setError\(tr\(serverMessage\(err\) \|\| 'تعذر التحويل'\)\)/);
  // بعد التحويل تتبع خانتا الوحدة والسعر الأساس الجديد — وإلا أعاد «حفظ التعديلات» الاسم القديم
  assert.match(s, /setValue\('unit', p\.unit\);\s*setValue\('basePrice', Number\(p\.basePrice\)\);/);
  // الوحدات لا تُرسل مع حفظ الصنف
  assert.match(s, /units: _units, \.\.\.rest \} = data;/);
});

test('فاتورة الإدارة: وحدة البند ولقطتها في الجسم، والمرتجع المرتبط بوحدته وخانات العملة', () => {
  const s = read('components', 'forms', 'InvoiceModal.tsx');
  assert.match(s, /\.\.\.invoiceItemUnit\(\{ unit: l\.unit, unitId: l\.unitId, unitName: l\.unitId \? l\.unit : null, unitFactor: l\.unitFactor, baseUnit: l\.baseUnit \}\)/);
  assert.match(s, /const c = defaultChoice\(p\);/, 'الوحدة الافتراضية الأكبر');
  assert.match(s, /buildLinkedReturnPayload\(head, linked, retDec\)/);
  assert.match(s, /max=\{maxReturnQty\(l\)\}/);
  assert.match(s, /<tr key=\{lineKey\(l\)\}>/, 'الصنف بوحدتين بندان');
  assert.match(s, /data\?\.code === 'UNIT_INVALID'/, 'قائمةٌ قديمة تُحدَّث');
});

test('التحميل والوارد: unitId يُرسل مع البند، والاقتراح بالأساس', () => {
  const v = read('pages', 'VanStockPage.tsx');
  assert.match(v, /qty: Number\(r\.qty\), unitId: r\.unitId, suggestedQty: r\.suggestedQty, expectedQty: r\.expectedQty/);
  assert.match(v, /suggestionChoice\(\{ unit: r\.unit, units: r\.units \?\? \[\] \}, r\.suggested\)/);
  assert.match(v, /qty: String\(qty\), suggestedQty: r\.suggested,/, 'المقترَح يبقى بالأساس');
  const w = read('pages', 'CompanyWarehousePage.tsx');
  assert.match(w, /\.\.\.\(r\.unitId && \{ unitId: r\.unitId \}\),/);
  assert.match(w, /tr\('متوسط التكلفة لوحدة الأساس'\)/);
});
