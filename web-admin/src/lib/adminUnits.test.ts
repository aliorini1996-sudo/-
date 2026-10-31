import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  hasBigUnit, biggestUnit, baseQtyText, docQtyText, totalsByUnit, lineKey, unitTaken, suggestionChoice,
  unitFormProblem, unitFormPayload, unitFormOf, EMPTY_UNIT_FORM, convertFormProblem, convertPreview, convertPayload,
  primaryOrBiggest, productUnitLabel, reverseFormProblem, reverseCreatePayload, reverseEditPatch, reverseFormOf, reverseSubPrice,
  EMPTY_REVERSE_FORM, type ReverseForm,
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
  // «الوحدة الرئيسية» §4.2: كل كتابة وحدةٍ ترسل الأساس كما رآه النموذج (expectedBaseName) فيُرفض نموذجٌ قديم بـ٤٠٩
  assert.match(s, /productApi\.addUnit\(productId, \{ \.\.\.unitFormPayload\(adding\),[^\n]*expectedBaseName: baseUnit \}\)/);
  assert.match(s, /productApi\.updateUnit\(productId, u\.id, \{ \.\.\.unitFormPayload\(editing\), expectedBaseName: baseUnit \}\)/);
  assert.match(s, /\{ isActive: u\.isActive === false, expectedBaseName: baseUnit \}/, 'الإيقاف والتفعيل');
  assert.match(s, /productApi\.removeUnit\(productId, u\.id\)/);
  // «إضافة وحدة فرعية أصغر»: الجسم من convertPayload بالأساس المتوقَّع، والمعاينة dryRun قبل التنفيذ (§4.3)
  assert.match(s, /\.\.\.convertPayload\(form, expected\)/);
  assert.match(s, /productApi\.convertBase\(productId, \{ \.\.\.body\(\), dryRun: true \}\)/);
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

// ═══ «الوحدة الرئيسية» (B1): صنفٌ أساسه قارورة، كرتونه ٢٤ رئيسيّ، وفوقه طبلية ١٢٠٠ ═══
const bottleUnits = [
  { id: 'u-c', name: 'كرتون', factor: 24, price: 48, isActive: true, unitCode: 'CT' },
  { id: 'u-pl', name: 'طبلية', factor: 1200, price: null, isActive: true },
];
const bottle = { unit: 'قارورة', basePrice: 2, unitCode: 'PCE', units: bottleUnits };
const bottleP = { ...bottle, primaryUnitId: 'u-c' };

test('baseQtyText بالرئيسية يقف عندها، وبلاها (غائبة/null/تالفة) القائم حرفاً', () => {
  assert.equal(baseQtyText(1250, bottleP, plain), '52 كرتون و2 قارورة');
  assert.equal(baseQtyText(0, bottleP, plain), '0 كرتون');
  assert.equal(baseQtyText(5, bottleP, plain), '5 قارورة');
  assert.equal(baseQtyText(-26, bottleP, plain), '-1 كرتون و2 قارورة');
  assert.equal(baseQtyText(1250, bottle, plain), '1 طبلية و50 قارورة');
  assert.equal(baseQtyText(1250, { ...bottle, primaryUnitId: null }, plain), '1 طبلية و50 قارورة');
  assert.equal(baseQtyText(1250, { ...bottle, primaryUnitId: 'u-gone' }, plain), '1 طبلية و50 قارورة');
  assert.equal(baseQtyText(1250, bottleP, n => `«${n}»`), '«52» كرتون و«2» قارورة');
});

test('primaryOrBiggest وproductUnitLabel: الرئيسية أولاً، وبلاها biggestUnit وp.unit حرفاً', () => {
  assert.equal(primaryOrBiggest(bottleP)!.name, 'كرتون');
  assert.equal(primaryOrBiggest(bottle)!.name, 'طبلية', 'بلا رئيسية = biggestUnit');
  assert.deepEqual(primaryOrBiggest(bottle), biggestUnit(bottle.units));
  assert.equal(primaryOrBiggest({ unit: 'كرتون' } as any), null);
  assert.equal(productUnitLabel(bottleP), 'كرتون (24 قارورة)');
  assert.equal(productUnitLabel(bottleP, n => n.toLocaleString('ar-SA')), 'كرتون (٢٤ قارورة)');
  assert.equal(productUnitLabel(bottle), 'قارورة');
  assert.equal(productUnitLabel({ ...bottle, primaryUnitId: null }), 'قارورة');
  assert.equal(productUnitLabel(null), '');
});

test('suggestionChoice بالرئيسية: لا قفز إلى الطبلية — وبلا رئيسية القائم حرفاً', () => {
  const s = suggestionChoice(bottleP, 1200);
  assert.deepEqual([s.choice.id, s.qty], ['u-c', 50], '1200 قارورة ⇒ 50 كرتون لا 1 طبلية');
  assert.deepEqual([suggestionChoice(bottle, 1200).choice.id, suggestionChoice(bottle, 1200).qty], ['u-pl', 1], 'بلا رئيسية: الأكبر كما اليوم');
  assert.deepEqual([suggestionChoice(bottleP, 50).choice.id, suggestionChoice(bottleP, 50).qty], [null, 50], 'لا تنقسم ⇒ الأساس');
  assert.deepEqual([suggestionChoice(bottleP, 48).choice.id, suggestionChoice(bottleP, 48).qty], ['u-c', 2]);
});

test('docQtyText: «×5 قارورة» مع الرئيسية (من البند أو من صنفه)، و«×5» بلاها ومع primaryUnitId: null (D18)', () => {
  assert.equal(docQtyText({ qty: 5, unitName: null, unitFactor: 1, unit: 'قارورة', primaryUnitId: 'u-c' }, plain), '5 قارورة');
  assert.equal(docQtyText({ qty: 5, unitName: null, unitFactor: 1, unit: 'قارورة', product: { primaryUnitId: 'u-c' } }, plain), '5 قارورة');
  assert.equal(docQtyText({ qty: 5, unitName: null, unitFactor: 1, unit: 'قارورة' }, plain), '5');
  assert.equal(docQtyText({ qty: 5, unitName: null, unitFactor: 1, unit: 'قارورة', primaryUnitId: null }, plain), '5');
  assert.equal(docQtyText({ qty: 5, unitName: null, unitFactor: 1, unit: 'قارورة', product: { primaryUnitId: null } }, plain), '5');
  assert.equal(docQtyText({ qty: 2, unitName: 'كرتون', unitFactor: 24, product: { primaryUnitId: 'u-c' } }, plain), '2 كرتون');
  assert.equal(docQtyText({ qty: 5, unitFactor: 1, primaryUnitId: 'u-c' }, plain), '5', 'بلا اسم وحدة لا يُلحق شيء');
});

const rf = (o: Partial<ReverseForm> = {}): ReverseForm => ({ ...EMPTY_REVERSE_FORM, primaryName: 'كرتون', primaryPrice: '48', subName: 'قارورة', factor: '24', ...o });

test('reverseFormProblem: الأسماء غير فارغة ومختلفة و≤ ٢٤، والعدد صحيح ٢..١٠٠٠٠٠، وسعر الرئيسية ≥ ٠ — وبلا «الأساس» في رسائله', () => {
  assert.equal(reverseFormProblem(rf()), null);
  assert.equal(reverseFormProblem(rf({ factor: '٢٤', primaryPrice: '٤٨٫٥' })), null, 'أرقام هندية وفاصلة عربية');
  const bad: Array<[Partial<ReverseForm>, string]> = [
    [{ primaryName: ' ' }, 'اسم الوحدة الرئيسية مطلوب'],
    [{ subName: '' }, 'اسم الوحدة الفرعية مطلوب'],
    [{ subName: 'ق'.repeat(25) }, 'اسم الوحدة طويل'],
    [{ subName: ' كرتون ' }, 'الوحدة الرئيسية والفرعية باسمين مختلفين'],
    [{ factor: '1' }, 'عدد الوحدات الفرعية في الرئيسية عدد صحيح من 2 إلى 100000'],
    [{ factor: '2.5' }, 'عدد الوحدات الفرعية في الرئيسية عدد صحيح من 2 إلى 100000'],
    [{ factor: '100001' }, 'عدد الوحدات الفرعية في الرئيسية عدد صحيح من 2 إلى 100000'],
    [{ factor: '' }, 'عدد الوحدات الفرعية في الرئيسية عدد صحيح من 2 إلى 100000'],
    [{ primaryPrice: '' }, 'سعر الوحدة الرئيسية مطلوب'],
    [{ primaryPrice: '-1' }, 'سعر الوحدة رقم موجب'],
    [{ subPrice: 'x' }, 'سعر الوحدة رقم موجب'],
    [{ primaryUnitCode: 'X'.repeat(17) }, 'رمز الوحدة الضريبي 16 حرفا على الأكثر'],
  ];
  for (const [o, msg] of bad) {
    const got = reverseFormProblem(rf(o));
    assert.equal(got, msg, JSON.stringify(o));
    assert.doesNotMatch(got!, /الأساس/, 'D21');
  }
  assert.equal(reverseFormProblem(rf({ factor: '100000', primaryPrice: '0' })), null, 'الحدّ الأعلى والسعر الصفري مقبولان');
});

test('reverseCreatePayload: الفرعية unit وسعرها (فارغ ⇒ null يشتقّه الخادم)، والرئيسية وحدةٌ بسعرها الصريح و primaryUnitName', () => {
  assert.deepEqual(reverseCreatePayload(rf({ primaryUnitCode: ' CT ', subUnitCode: 'PCE' })), {
    unit: 'قارورة', basePrice: null, unitCode: 'PCE',
    units: [{ name: 'كرتون', factor: 24, price: 48, unitCode: 'CT' }],
    primaryUnitName: 'كرتون',
  });
  const explicit = reverseCreatePayload(rf({ subPrice: '2.1', primaryName: ' كرتون ' }));
  assert.equal(explicit.basePrice, 2.1);
  assert.equal(explicit.primaryUnitName, 'كرتون', 'الاسم مقصوص كاسم الوحدة');
  assert.equal(explicit.units[0].name, explicit.primaryUnitName);
  assert.equal(explicit.unitCode, null);
});

test('reverseSubPrice وreverseEditPatch: الفارغ ⇒ derivedBasePrice صريحاً (16.33/8 = 2.0413)، والرقعة تحمل معرّف الرئيسية', () => {
  assert.equal(reverseSubPrice(rf({ primaryPrice: '50' })), 2.0833);
  assert.equal(reverseSubPrice(rf({ primaryPrice: '16.33', factor: '8' })), 2.0413);
  assert.equal(reverseSubPrice(rf({ subPrice: '1.95' })), 1.95);
  assert.deepEqual(reverseEditPatch(rf({ primaryPrice: '16.33', factor: '8', primaryUnitCode: 'CT' }), 'u-c'), {
    unit: 'قارورة', basePrice: 2.0413, unitCode: null,
    primaryUnit: { id: 'u-c', name: 'كرتون', factor: 8, price: 16.33, unitCode: 'CT' },
  });
  assert.equal(reverseEditPatch(rf({ subPrice: '2.5' }), 'u-c').basePrice, 2.5);
});

test('reverseFormOf: سعر مشتقّ ⇒ خانة الفرعية فارغة، وصريح ⇒ يُعرض، وصنفٌ حُوِّل بـ16.33/8 «مشتقّ» — وبلا رئيسية null', () => {
  assert.deepEqual(reverseFormOf(bottleP), {
    primaryName: 'كرتون', primaryPrice: '48', subName: 'قارورة', factor: '24', subPrice: '', primaryUnitCode: 'CT', subUnitCode: 'PCE',
  }, '48 ÷ 24 = 2 = basePrice ⇒ مشتقّ');
  assert.equal(reverseFormOf({ ...bottleP, basePrice: 1.9 })!.subPrice, '1.9', 'سعر صريح');
  assert.equal(reverseFormOf({ ...bottleP, basePrice: '2' })!.subPrice, '', 'Decimal نصّاً من الخادم');
  // صنفٌ حُوِّل: كرتونه 16.33 صريحٌ على وحدته وقارورته roundDecimal(16.33 ÷ 8, 4) = 2.0413 بخطوة التحويل الخامسة
  const converted = { unit: 'قارورة', basePrice: '2.0413', units: [{ id: 'u-c8', name: 'كرتون', factor: 8, price: 16.33, isActive: true }], primaryUnitId: 'u-c8' };
  assert.equal(reverseFormOf(converted)!.subPrice, '');
  assert.equal(reverseFormOf(converted)!.primaryPrice, '16.33');
  // كرتونٌ بلا سعرٍ صريح: سعره الفعلي القارورة × المعامل
  assert.equal(reverseFormOf({ unit: 'قارورة', basePrice: 2, units: [{ id: 'u', name: 'كرتون', factor: 24, price: null }], primaryUnitId: 'u' })!.primaryPrice, '48');
  assert.equal(reverseFormOf(bottle), null);
  assert.equal(reverseFormOf({ ...bottle, primaryUnitId: null }), null);
  assert.equal(reverseFormOf(null), null);
  // والنموذج المملوء صالحٌ ويُرجع الرقعة نفسها بلا تغيير سعر
  const f = reverseFormOf(converted)!;
  assert.equal(reverseFormProblem(f), null);
  assert.equal(reverseEditPatch(f, 'u-c8').basePrice, 2.0413);
});
