import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasBigUnit, qtyText, signedQtyText, unitsBrief, lineKey, invoiceLine, addInvoiceLine, setInvoiceLineUnit,
  stepInvoiceLine, refreshInvoiceLines, stockLineUnit, freeChoices, nextStockLineUnit, splitLoadRows, suggestionLine, movementQtyText,
  tierBaseBounds, tierPayload, biggestUnit, unitDraftProblem, unitDraftPayload, unitDraftOf, convertDraftProblem,
  convertedBasePrice, statementItemText, UNIT_FACTOR_HINT, type SalePick, tierToPrimary, tierFromPrimary,
} from './mUnits';
import { unitChoices, invoiceItemUnit } from '../rep/repUnits';
import { lineTotal } from './docMath';

/**
 * الوحدات المتعددة في تطبيق الإدارة على الجوال — حرّاس الفخّ الحاكم: رقمٌ بالأساس بجانب اسم كرتون، وبندٌ بوحدةٍ
 * يُسعَّر بسعر أخرى، وسطر كرتونٍ يُزاد بنقرة حبّة. وصنفٌ بلا وحدات: كل شيءٍ كما قبل الميزة حرفاً.
 */

const num = (n: number) => String(n);

/** حبة أساس، كرتون ٢٤ بسعرٍ محدَّد، وطبلية ١٢٠٠ بلا سعر */
const UNITS = [
  { id: 'u-ctn', name: 'كرتون', factor: 24, price: 200, isActive: true },
  { id: 'u-plt', name: 'طبلية', factor: 1200, price: null, isActive: true },
];
const multi: SalePick = { id: 'p1', name: 'ماء', unit: 'حبة', basePrice: 10, taxPct: 15, units: UNITS };
const plain: SalePick = { id: 'p2', name: 'سكر', unit: 'كيس', basePrice: 7.5, taxPct: 15 };

// ═══════════════ العرض ═══════════════

test('hasBigUnit: الموقوفة والمعامل ١ لا تُحتسب', () => {
  assert.equal(hasBigUnit(UNITS), true);
  assert.equal(hasBigUnit([{ name: 'كرتون', factor: 24, isActive: false }]), false);
  assert.equal(hasBigUnit([]), false);
  assert.equal(hasBigUnit(null), false);
});

test('qtyText: صنفٌ له وحدات يُفكَّك، وغيره رقمه كما كان', () => {
  assert.equal(qtyText(51, multi, num), '2 كرتون و3 حبة');
  assert.equal(qtyText(48, multi, num), '2 كرتون');
  // الفخّ الحاكم: لا «٤٨ كرتون» أبداً — الرقم بالأساس يُعرض بالأساس
  assert.equal(qtyText(5, multi, num), '5 حبة');
  assert.equal(qtyText(12, plain, num), '12');
  assert.equal(qtyText(12, plain, num, { withUnit: true }), '12 كيس');
  assert.equal(qtyText(12, null, num, { withUnit: true }), '12');
});

test('qtyText: منسّق الأرقام يُطبَّق على الأرقام وحدها لا على أسماء الوحدات', () => {
  const ar = (n: number) => new Intl.NumberFormat('ar-EG').format(n);
  assert.equal(qtyText(51, multi, ar), `${ar(2)} كرتون و${ar(3)} حبة`);
});

test('signedQtyText: إشارةٌ صريحة، والصفر بلا إشارة', () => {
  assert.equal(signedQtyText(-27, multi, num), '−1 كرتون و3 حبة');
  assert.equal(signedQtyText(24, multi, num), '+1 كرتون');
  assert.equal(signedQtyText(0, multi, num), '0 حبة');
  assert.equal(signedQtyText(-3, plain, num), '−3');
});

test('unitsBrief: النشطة تصاعدياً بمعاملها، وفارغٌ لصنفٍ بلا وحدات', () => {
  assert.equal(unitsBrief(UNITS, num), 'كرتون 24 · طبلية 1200');
  assert.equal(unitsBrief([{ name: 'كرتون', factor: 24, isActive: false }], num), '');
  assert.equal(unitsBrief(undefined, num), '');
});

// ═══════════════ بنود الفاتورة ═══════════════

test('invoiceLine: الافتراض أكبر وحدة وسعرها — لا سعر الحبّة على بند طبلية', () => {
  const l = invoiceLine(multi);
  assert.equal(l.unitId, 'u-plt');
  assert.equal(l.unitFactor, 1200);
  assert.equal(l.unit, 'طبلية');
  assert.equal(l.unitPrice, 12000); // بلا سعرٍ محدَّد ⇒ الأساس × المعامل
  const ctn = invoiceLine(multi, unitChoices(multi).find(c => c.id === 'u-ctn'));
  assert.equal(ctn.unitPrice, 200); // سعر الكرتون المحدَّد يغلب ١٠ × ٢٤
  assert.equal(ctn.unitName, 'كرتون');
});

test('invoiceLine: صنفٌ بلا وحدات = بند ما قبل الميزة حرفاً (السعر والوحدة والضريبة)', () => {
  const l = invoiceLine(plain);
  assert.equal(l.unitPrice, 7.5);
  assert.equal(l.unit, 'كيس');
  assert.equal(l.unitId, null);
  assert.equal(l.unitFactor, 1);
  assert.equal(l.taxPct, 15);
  assert.equal(l.qty, 1);
  assert.equal(invoiceLine({ ...plain, taxPct: undefined }).taxPct, 15);
});

test('addInvoiceLine: «+١ حبة» لا تُضاف إلى بند الكرتون — بندان بمفتاحين', () => {
  const [base, ctn] = unitChoices(multi);
  let ls = addInvoiceLine([], multi, ctn);
  ls = addInvoiceLine(ls, multi, ctn);
  assert.equal(ls.length, 1);
  assert.equal(ls[0].qty, 2);
  ls = addInvoiceLine(ls, multi, base);
  assert.equal(ls.length, 2);
  assert.deepEqual(ls.map(l => [lineKey(l), l.qty]), [['p1:u-ctn', 2], ['p1:', 1]]);
  // صنفٌ بلا وحدات: النقرة الثانية تزيد بنده كما كانت
  const p = addInvoiceLine(addInvoiceLine([], plain), plain);
  assert.equal(p.length, 1);
  assert.equal(p[0].qty, 2);
});

test('setInvoiceLineUnit: التبديل يعيد التسعير بسعر الوحدة الجديدة، ولا ينتقل إلى وحدةٍ أخذها بندٌ آخر', () => {
  const [base, ctn, plt] = unitChoices(multi);
  let ls = addInvoiceLine([], multi, base);
  ls = [{ ...ls[0], discountPct: 5, qty: 3 }];
  ls = setInvoiceLineUnit(ls, 'p1:', multi, ctn);
  assert.equal(ls[0].unitId, 'u-ctn');
  assert.equal(ls[0].unitPrice, 200);
  assert.equal(ls[0].qty, 3);           // الكمية والخصم لا يمسّهما التبديل
  assert.equal(ls[0].discountPct, 5);
  ls = addInvoiceLine(ls, multi, plt);
  const same = setInvoiceLineUnit(ls, 'p1:u-ctn', multi, plt);
  assert.equal(same, ls, 'الطبلية مأخوذة لبندٍ آخر — القائمة كما هي');
  const back = setInvoiceLineUnit(ls, 'p1:u-ctn', multi, base);
  assert.equal(back[0].unitPrice, 10);
  assert.equal(back[0].unitId, null);
  assert.equal(back[0].unitFactor, 1);
});

test('refreshInvoiceLines: بند الأساس بعد تحويل الأساس يصير بوحدته القديمة وسعره المكتوب كما هو', () => {
  // قبل التحويل: كرتون أساسٌ بسعر ٢٤٠، والمستخدم عدّل السعر إلى ٢٣٠
  const before: SalePick = { id: 'p3', name: 'عصير', unit: 'كرتون', basePrice: 240, taxPct: 15 };
  const ls = [{ ...invoiceLine(before), qty: 2, unitPrice: 230 }];
  assert.equal(ls[0].baseUnit, 'كرتون');
  // بعد التحويل: حبة أساس، والكرتون وحدةٌ بمعامل ٢٤ بسعره القديم
  const after: SalePick = { id: 'p3', name: 'عصير', unit: 'حبة', basePrice: 10, taxPct: 15,
    units: [{ id: 'u-old', name: 'كرتون', factor: 24, price: 240, isActive: true }] };
  const r = refreshInvoiceLines(ls, after);
  assert.equal(r[0].unitId, 'u-old');
  assert.equal(r[0].unitFactor, 24);
  assert.equal(r[0].unit, 'كرتون');
  assert.equal(r[0].baseUnit, 'حبة', 'أساس الجهاز يتبع الصنف الآن فلا يُرفض البند ثانيةً');
  assert.equal(r[0].unitPrice, 230, 'سعر الكرتون المكتوب لا يُمسّ — الكرتون هو هو');
  assert.equal(r[0].qty, 2);
  assert.deepEqual(invoiceItemUnit(r[0]), { unitId: 'u-old', unitName: 'كرتون', unitFactor: 24, baseUnitName: 'حبة' });
});

test('refreshInvoiceLines: معاملٌ تغيّر يعيد التسعير، ووحدةٌ زالت تبقى للمستخدم، وبلا تغيير القائمة نفسها', () => {
  const [, ctn] = unitChoices(multi);
  const ls = addInvoiceLine([], multi, ctn);
  // لا تغيير ⇒ المرجع نفسه (لا رسمٌ بلا داعٍ)
  assert.equal(refreshInvoiceLines(ls, multi), ls);
  // الكرتون صار ١٢ بلا سعرٍ محدَّد ⇒ ١٠ × ١٢
  const smaller: SalePick = { ...multi, units: [{ id: 'u-ctn', name: 'كرتون', factor: 12, price: null, isActive: true }] };
  const r = refreshInvoiceLines(ls, smaller);
  assert.equal(r[0].unitFactor, 12);
  assert.equal(r[0].unitPrice, 120);
  // أُوقف الكرتون ⇒ لا يُردّ إلى الأساس بصمت
  const off: SalePick = { ...multi, units: [{ id: 'u-ctn', name: 'كرتون', factor: 24, price: 200, isActive: false }] };
  assert.equal(refreshInvoiceLines(ls, off), ls);
  // أصناف أخرى لا تُمسّ
  const two = addInvoiceLine(ls, plain);
  assert.equal(refreshInvoiceLines(two, smaller)[1], two[1]);
});

test('stepInvoiceLine: يمسّ بند المفتاح وحده، والصفر يحذفه', () => {
  const [base, ctn] = unitChoices(multi);
  let ls = addInvoiceLine(addInvoiceLine([], multi, ctn), multi, base);
  ls = stepInvoiceLine(ls, 'p1:u-ctn', 1);
  assert.deepEqual(ls.map(l => l.qty), [2, 1]);
  ls = stepInvoiceLine(ls, 'p1:', -1);
  assert.deepEqual(ls.map(lineKey), ['p1:u-ctn']);
});

test('جسم البند: unitId ولقطة الوحدة، وبند الأساس يحمل اسم أساسه بمعامل ١', () => {
  const [, ctn] = unitChoices(multi);
  assert.deepEqual(invoiceItemUnit(invoiceLine(multi, ctn)), { unitId: 'u-ctn', unitName: 'كرتون', unitFactor: 24, baseUnitName: 'حبة' });
  assert.deepEqual(invoiceItemUnit(invoiceLine(plain)), { unitName: 'كيس', unitFactor: 1, baseUnitName: 'كيس' });
});

test('المبلغ بوحدة البند: كرتونان بسعر الكرتون — المعامل لا يدخل الحساب', () => {
  const [, ctn] = unitChoices(multi);
  const l = { ...invoiceLine(multi, ctn), qty: 2 };
  assert.equal(lineTotal(l), 460); // 400 + 15%
});

// ═══════════════ أسطر التحميل والوارد ═══════════════

test('stockLineUnit: الأساس بلا unitId ومعامل ١، والوحدة بمعرّفها ومعاملها', () => {
  const [base, ctn] = unitChoices(multi);
  assert.deepEqual(stockLineUnit(multi, base), { unitId: null, unit: 'حبة', unitFactor: 1, baseUnit: 'حبة', units: UNITS });
  assert.equal(stockLineUnit(multi, ctn).unitFactor, 24);
  assert.deepEqual(stockLineUnit(plain, unitChoices(plain)[0]).units, []);
});

test('freeChoices: المأخوذة للصنف نفسه تُستبعد، وسطر الاستثناء لا يحجب وحدته', () => {
  const lines = [{ productId: 'p1', unitId: 'u-ctn' }, { productId: 'p2', unitId: null }];
  assert.deepEqual(freeChoices(multi, lines, 'p1').map(c => c.id), [null, 'u-plt']);
  assert.deepEqual(freeChoices(multi, lines, 'p1', 'p1:u-ctn').map(c => c.id), [null, 'u-ctn', 'u-plt']);
});

test('nextStockLineUnit: أوّل نقرة بالأكبر، وبعدها الأساس، وnull حين تُؤخذ كلّها', () => {
  const lines: { productId: string; unitId: string | null }[] = [];
  const a = nextStockLineUnit(multi, lines, 'p1');
  assert.equal(a?.unitId, 'u-plt');
  lines.push({ productId: 'p1', unitId: a!.unitId });
  const b = nextStockLineUnit(multi, lines, 'p1');
  assert.equal(b?.unitId, null);
  lines.push({ productId: 'p1', unitId: b!.unitId });
  const c = nextStockLineUnit(multi, lines, 'p1');
  assert.equal(c?.unitId, 'u-ctn');
  lines.push({ productId: 'p1', unitId: c!.unitId });
  assert.equal(nextStockLineUnit(multi, lines, 'p1'), null);
  // صنفٌ بلا وحدات: سطرٌ واحد كما قبل الميزة
  assert.equal(nextStockLineUnit(plain, [], 'p2')?.unitId, null);
  assert.equal(nextStockLineUnit(plain, [{ productId: 'p2', unitId: null }], 'p2'), null);
});

test('splitLoadRows: الوحدة تمرّ في الشقّين، والأساس بلا حقل، والمقترح للتحميل وحده', () => {
  const s = splitLoadRows([
    { productId: 'p1', qty: 2, unitId: 'u-ctn', suggestedQty: 48, expectedQty: 40 },
    { productId: 'p1', qty: -3, unitId: null, suggestedQty: 5 },
    { productId: 'p2', qty: 0 },
    { productId: 'p2', qty: -1, unitId: 'u-x' },
  ]);
  assert.deepEqual(s.out, [{ productId: 'p1', qty: 2, unitId: 'u-ctn', suggestedQty: 48, expectedQty: 40 }]);
  assert.deepEqual(s.back, [{ productId: 'p1', qty: 3 }, { productId: 'p2', qty: 1, unitId: 'u-x' }]);
});

test('suggestionLine: أكبر وحدةٍ تنقسم عليها الكمية تماماً، والمقترح والمتوقَّع بالأساس دائماً', () => {
  const r = suggestionLine({ unit: 'حبة', units: UNITS, suggested: 48, expected: 40 });
  assert.equal(r.unitId, 'u-ctn');
  assert.equal(r.qty, 2);
  assert.equal(r.suggestedQty, 48);
  assert.equal(r.expectedQty, 40);
  // لا تنقسم ⇒ بالأساس كما هي، لا تقريب إلى كرتونٍ كامل
  const odd = suggestionLine({ unit: 'حبة', units: UNITS, suggested: 50, expected: 41 });
  assert.equal(odd.unitId, null);
  assert.equal(odd.qty, 50);
  assert.equal(suggestionLine({ unit: 'حبة', units: UNITS, suggested: 2400, expected: 0 }).unitId, 'u-plt');
  // صنفٌ بلا وحدات: الرقم المقترح كما هو
  const p = suggestionLine({ unit: 'كيس', suggested: 7, expected: 6 });
  assert.equal(p.qty, 7);
  assert.equal(p.unitId, null);
  assert.equal(p.unit, 'كيس');
});

test('movementQtyText: مجموعٌ لكل وحدة حين تختلط، وnull حين كلّها بالأساس', () => {
  assert.equal(movementQtyText([
    { qty: 2, unit: 'كرتون', baseQty: 48 },
    { qty: 5, unit: 'حبة', baseQty: 5 },
    { qty: -1, unit: 'كرتون', baseQty: -24 },
  ], num), '3 كرتون · 5 حبة');
  assert.equal(movementQtyText([{ qty: 2, unit: 'كيس', baseQty: 2 }, { qty: 3, unit: 'حبة' }], num), null);
});

// ═══════════════ الشرائح ═══════════════

test('tierBaseBounds: العمودان بالأساس أوّلاً، والشريحة غير المرحَّلة من القديمين', () => {
  assert.deepEqual(tierBaseBounds({ minQty: 2, maxQty: 5, baseMinQty: 48, baseMaxQty: 120, price: 9 }), { min: 48, max: 120 });
  assert.deepEqual(tierBaseBounds({ minQty: 10, baseMinQty: 0, price: 9 }), { min: 10, max: null });
  assert.deepEqual(tierBaseBounds({ minQty: 0, baseMinQty: 0, price: 9 }), { min: 0, max: null });
  assert.deepEqual(tierBaseBounds({ minQty: 3, maxQty: 9, price: 9 }), { min: 3, max: 9 });
});

test('tierPayload: الحدود بالأساس في العمودين، والحدّ الأعلى الفارغ بلا مفتاح', () => {
  assert.deepEqual(tierPayload(48, 120, 9.5), { minQty: 48, baseMinQty: 48, price: 9.5, maxQty: 120, baseMaxQty: 120 });
  const open = tierPayload(10, null, 9);
  assert.deepEqual(open, { minQty: 10, baseMinQty: 10, price: 9 });
  assert.equal('maxQty' in open, false);
});

test('biggestUnit: الأكبر النشطة أو null', () => {
  assert.equal(biggestUnit(UNITS)?.name, 'طبلية');
  assert.equal(biggestUnit([{ name: 'طبلية', factor: 1200, isActive: false }, { name: 'كرتون', factor: 24 }])?.name, 'كرتون');
  assert.equal(biggestUnit([]), null);
});

// ═══════════════ إدارة الوحدات والتحويل ═══════════════

test('unitDraftProblem: المعامل ١ يُقال صراحةً، والاسم المكرر واسم الأساس مرفوضان كالخادم', () => {
  const others = [{ name: 'كرتون', factor: 24 }];
  const d = (o: Partial<{ name: string; factor: string; price: string; unitCode: string }>) =>
    ({ name: 'طبلية', factor: '1200', price: '', unitCode: '', ...o });
  assert.equal(unitDraftProblem(d({}), 'حبة', others), null);
  assert.equal(unitDraftProblem(d({ factor: '1' }), 'حبة', others), UNIT_FACTOR_HINT);
  assert.equal(unitDraftProblem(d({ factor: '' }), 'حبة', others), UNIT_FACTOR_HINT);
  assert.equal(unitDraftProblem(d({ factor: '2.5' }), 'حبة', others), 'معامل التحويل عدد صحيح — وحدة الأساس هي الأصغر');
  assert.equal(unitDraftProblem(d({ name: 'حبة' }), 'حبة', others), 'اسم الوحدة مكرر لهذا الصنف');
  assert.equal(unitDraftProblem(d({ name: 'كرتون' }), 'حبة', others), 'اسم الوحدة مكرر لهذا الصنف');
  assert.equal(unitDraftProblem(d({ factor: '24' }), 'حبة', others), 'يوجد وحدة بالمعامل نفسه لهذا الصنف');
  assert.equal(unitDraftProblem(d({ name: '  ' }), 'حبة', others), 'اسم الوحدة مطلوب');
  assert.equal(unitDraftProblem(d({ price: '-1' }), 'حبة', others), 'سعر الوحدة رقم موجب');
  assert.equal(unitDraftProblem(d({ unitCode: 'X'.repeat(17) }), 'حبة', others), 'رمز الوحدة لا يتجاوز 16 حرفا');
});

test('unitDraftPayload: السعر والرمز الفارغان null صريحاً — مسحُ سعرٍ قديم يصل الخادم', () => {
  assert.deepEqual(unitDraftPayload({ name: ' كرتون ', factor: '24', price: '', unitCode: ' ' }),
    { name: 'كرتون', factor: 24, price: null, unitCode: null });
  assert.deepEqual(unitDraftPayload({ name: 'كرتون', factor: '24', price: '199.5', unitCode: 'CT' }),
    { name: 'كرتون', factor: 24, price: 199.5, unitCode: 'CT' });
  assert.deepEqual(unitDraftOf({ name: 'كرتون', factor: 24, price: null, unitCode: null }),
    { name: 'كرتون', factor: '24', price: '', unitCode: '' });
  assert.deepEqual(unitDraftOf(null), { name: '', factor: '', price: '', unitCode: '' });
});

test('convertDraftProblem: شروط الخادم قبل نافذة التأكيد', () => {
  const p = { unit: 'كرتون', units: [{ name: 'طبلية', factor: 50 }] };
  assert.equal(convertDraftProblem({ newBaseName: 'حبة', factor: '24' }, p), null);
  assert.equal(convertDraftProblem({ newBaseName: '', factor: '24' }, p), 'اسم وحدة الأساس الجديدة مطلوب');
  assert.equal(convertDraftProblem({ newBaseName: 'كرتون', factor: '24' }, p), 'وحدة الأساس الجديدة هي الحالية نفسها');
  assert.equal(convertDraftProblem({ newBaseName: 'طبلية', factor: '24' }, p), 'اسم وحدة الأساس الجديدة مستخدم لوحدة أخرى لهذا الصنف');
  assert.equal(convertDraftProblem({ newBaseName: 'حبة', factor: '1' }, p), 'معامل التحويل عدد صحيح أكبر من 1 كم وحدة أساس جديدة في الوحدة الحالية');
  assert.equal(convertDraftProblem({ newBaseName: 'حبة', factor: '2.5' }, p), 'معامل التحويل عدد صحيح أكبر من 1 كم وحدة أساس جديدة في الوحدة الحالية');
  // الطبلية ٥٠ × ٤٠٠٠ = ٢٠٠٠٠٠ تتجاوز الحدّ بعد الضرب
  assert.equal(convertDraftProblem({ newBaseName: 'حبة', factor: '4000' }, p), 'معامل التحويل كبير جدا');
});

test('convertedBasePrice: سعر الوحدة القديمة ÷ المعامل بأربع منازل كالخادم', () => {
  assert.equal(convertedBasePrice(240, 24), 10);
  assert.equal(convertedBasePrice(100, 3), 33.3333);
  assert.equal(convertedBasePrice('abc', 3), 0);
});

// ═══════════════ بنود المستندات ═══════════════

test('statementItemText: الوحدة بجانب الكمية حين البند بغير الأساس — كالكشف المطبوع', () => {
  assert.equal(statementItemText({ qty: 2, unitName: 'كرتون', unitFactor: 24, product: { name: 'ماء', unit: 'حبة' } }, num), 'ماء ×2 كرتون');
  assert.equal(statementItemText({ qty: 3, unitName: null, unitFactor: 1, product: { name: 'ماء', unit: 'حبة' } }, num), 'ماء ×3');
  assert.equal(statementItemText({ qty: '4', product: null }, num), '- ×4');
});

// ═══ «الوحدة الرئيسية» (B1): صنفٌ أساسه قارورة، كرتونه ٢٤ رئيسيّ، وفوقه طبلية ١٢٠٠ ═══
const PU = [
  { id: 'u-c', name: 'كرتون', factor: 24, price: 48, isActive: true },
  { id: 'u-pl', name: 'طبلية', factor: 1200, price: null, isActive: true },
];
const bottleP = { unit: 'قارورة', units: PU, primaryUnitId: 'u-c' };

test('qtyText وsignedQtyText بالرئيسية — وبلاها (null أو تالفة) القائم حرفاً', () => {
  assert.equal(qtyText(1250, bottleP, num), '52 كرتون و2 قارورة');
  assert.equal(qtyText(0, bottleP, num), '0 كرتون');
  assert.equal(qtyText(1250, { ...bottleP, primaryUnitId: null }, num), '1 طبلية و50 قارورة');
  assert.equal(qtyText(1250, { ...bottleP, primaryUnitId: 'u-x' }, num), '1 طبلية و50 قارورة');
  assert.equal(signedQtyText(-26, bottleP, num), '−1 كرتون و2 قارورة');
  assert.equal(signedQtyText(1200, bottleP, num), '+50 كرتون');
  assert.equal(signedQtyText(1200, { ...bottleP, primaryUnitId: undefined }, num), '+1 طبلية');
});

test('unitsBrief بالرئيسية: «رئيسية: كرتون 24 · طبلية 1200»، والوسم مترجماً، وبلا رئيسية صالحة القائم حرفاً', () => {
  assert.equal(unitsBrief(PU, num, 'u-c'), 'رئيسية: كرتون 24 · طبلية 1200');
  assert.equal(unitsBrief(PU, num, 'u-pl'), 'رئيسية: طبلية 1200 · كرتون 24', 'الرئيسية أوّلاً ولو كانت الأكبر');
  assert.equal(unitsBrief(PU, num, 'u-c', 'Main'), 'Main: كرتون 24 · طبلية 1200');
  assert.equal(unitsBrief(PU, num), 'كرتون 24 · طبلية 1200');
  assert.equal(unitsBrief(PU, num, null), 'كرتون 24 · طبلية 1200');
  assert.equal(unitsBrief(PU, num, 'u-gone'), 'كرتون 24 · طبلية 1200');
  assert.equal(unitsBrief([{ ...PU[0], isActive: false }, PU[1]], num, 'u-c'), 'طبلية 1200', 'رئيسية موقوفة ⇒ القائم');
});

test('suggestionLine بالرئيسية: لا قفز إلى الطبلية — والقاعدة نفسها في suggestionChoice', () => {
  const r = suggestionLine({ unit: 'قارورة', units: PU, primaryUnitId: 'u-c', suggested: 1200, expected: 1100 });
  assert.equal(r.unitId, 'u-c');
  assert.equal(r.qty, 50);
  assert.equal(r.suggestedQty, 1200, 'المقترح بالأساس');
  assert.equal(r.expectedQty, 1100);
  assert.equal(suggestionLine({ unit: 'قارورة', units: PU, suggested: 1200, expected: 0 }).unitId, 'u-pl', 'بلا رئيسية: القائم');
  assert.equal(suggestionLine({ unit: 'قارورة', units: PU, primaryUnitId: null, suggested: 1200, expected: 0 }).unitId, 'u-pl');
  const odd = suggestionLine({ unit: 'قارورة', units: PU, primaryUnitId: 'u-c', suggested: 50, expected: 0 });
  assert.deepEqual([odd.unitId, odd.qty, odd.unit], [null, 50, 'قارورة']);
});

test('statementItemText: يلحق الوحدة دائماً حين للصنف رئيسية، و`primaryUnitId: null` = القائم حرفاً', () => {
  assert.equal(statementItemText({ qty: 5, unitName: null, unitFactor: 1, product: { name: 'ماء', unit: 'قارورة', primaryUnitId: 'u-c' } }, num), 'ماء ×5 قارورة');
  assert.equal(statementItemText({ qty: 5, unitName: null, unitFactor: 1, product: { name: 'ماء', unit: 'قارورة', primaryUnitId: null } }, num), 'ماء ×5');
  assert.equal(statementItemText({ qty: 5, unitName: null, unitFactor: 1, product: { name: 'ماء', unit: 'قارورة' } }, num), 'ماء ×5');
  assert.equal(statementItemText({ qty: 2, unitName: 'كرتون', unitFactor: 24, product: { name: 'ماء', unit: 'قارورة', primaryUnitId: 'u-c' } }, num), 'ماء ×2 كرتون');
});

test('tierToPrimary وtierFromPrimary: الحدّ ÷F أو ×F والسعر ×F أو ÷F، والذهاب والعودة يعيدان الأصل', () => {
  const t = { minQty: 48, maxQty: 240, baseMinQty: 48, baseMaxQty: 240, price: 1.75 };
  assert.deepEqual(tierToPrimary(t, 24), { min: 2, max: 10, price: 42 });
  assert.deepEqual(tierFromPrimary(2, 10, 42, 24), tierPayload(48, 240, 1.75));
  const back = tierToPrimary(t, 24);
  assert.deepEqual(tierFromPrimary(back.min, back.max, back.price, 24), { minQty: 48, baseMinQty: 48, price: 1.75, maxQty: 240, baseMaxQty: 240 });
  const open = { minQty: 0, baseMinQty: 24, price: 2 };
  assert.deepEqual(tierToPrimary(open, 24), { min: 1, max: null, price: 48 });
  const o = tierFromPrimary(1, null, 48, 24);
  assert.deepEqual(o, { minQty: 24, baseMinQty: 24, price: 2 });
  assert.ok(!('maxQty' in o), 'الحدّ الأعلى الفارغ بلا مفتاح');
  // بلا تقريبٍ وسيط: سعر الكرتون 50 ⇒ القارورة 50/24 كما هي
  assert.equal(tierFromPrimary(1, null, 50, 24).price, 50 / 24);
  // شريحة غير مرحَّلة (baseMinQty = 0 وminQty ≠ 0) تُقرأ من القديمين كـtierBaseBounds
  assert.deepEqual(tierToPrimary({ minQty: 48, baseMinQty: 0, price: 1 }, 24), { min: 2, max: null, price: 24 });
});
