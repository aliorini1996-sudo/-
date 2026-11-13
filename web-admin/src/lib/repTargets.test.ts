// «هدف الشهر» (طلب المالك ٩ نوفمبر ٢٠٢٦) — منطقه الصرف (lib/repTargets.ts) وحرّاسٌ نصّية على توصيله: أيقونة صفحة المناديب
// بعَلَم المحاسبة ونافذتها، وبطاقة رئيسية المندوب بنسختها المحفوظة، والقاموس بلغاته الأربع لكل عبارة.
// وتوسعة ١١ نوفمبر ٢٠٢٦: نوعا «عدد زيارات» و«عملاء جدد نشطون»، و«كمية صنف» بعدة أصناف، و«دمج الأهداف» بمكافأةٍ واحدة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_TARGET_PRODUCTS, MAX_TARGETS_PER_MONTH, REP_TARGET_TEXTS, REWARD_KINDS, TARGET_ERRORS, TARGET_KINDS, TARGET_MAX, barPct, cleanDecimal, comboDone,
  daysLeftText, draftOf, draftProblem, emptyDraft, groupTargets, monthLabel, pctText, readNum, rewardText, shiftMonth, targetAmountText, targetErrorCode,
  targetErrorMessage, targetKindLabel, targetRemaining, targetStateText, targetTitle, targetUnitText, targetsFetchDue, toTargetInput,
  type RepTargetProductView, type RepTargetView, type TargetDraft,
} from './repTargets';
import type { UnitChoice } from '../rep/repUnits';
import { PHRASES } from '../i18n/strings';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const arTr = (s: string) => s;
const LANGS = ['en', 'fr', 'tr', 'zh'] as const;
const money = (n: number) => `${n.toFixed(2)} ر.س`;

const draft = (over: Partial<TargetDraft> = {}): TargetDraft => ({ ...emptyDraft('2026-11'), targetValue: '50000', rewardValue: '2', ...over });

const view = (over: Partial<RepTargetView> = {}): RepTargetView => ({
  id: 't1', month: '2026-11', kind: 'SALES_AMOUNT', targetValue: 50000, productId: null, productName: null, unitId: null, unitName: null,
  unitFactor: 1, rewardKind: 'COMMISSION_SALES_PCT', rewardValue: 2, note: null, createdByName: 'المدير', createdAt: '2026-11-01T08:00:00Z',
  updatedAt: '2026-11-01T08:00:00Z',
  progress: { state: 'OK', achieved: 20000, goal: 50000, pct: 40, done: false },
  reward: { kind: 'COMMISSION_SALES_PCT', value: 2, amount: 400, earned: false },
  ...over,
});

const carton: UnitChoice = { id: 'u-carton', name: 'كرتون', factor: 24, price: null };
const piece: UnitChoice = { id: null, name: 'حبة', factor: 1, price: null };

/** صنفٌ في هدف الكمية كما يردّه الخادم */
const prod = (productId: string | null, productName: string | null, unitName: string | null, unitId: string | null = null, unitFactor = 1): RepTargetProductView =>
  ({ productId, productName, unitId, unitName, unitFactor });
/** هدفٌ بتقدّمٍ محقَّق أو لا وبمعرّف دمج */
const member = (id: string, comboId: string | null, done = false): RepTargetView =>
  view({ id, comboId, progress: { state: 'OK', achieved: done ? 50000 : 20000, goal: 50000, pct: done ? 100 : 40, done } });

test('الأنواع الخمسة: المبيعات والكمية والتحصيل ثم الزيارات والعملاء الجدد، بسقوفها ووسومها', () => {
  assert.deepEqual(TARGET_KINDS.map(k => k.kind), ['SALES_AMOUNT', 'PRODUCT_QTY', 'COLLECTION_PCT', 'VISITS_COUNT', 'NEW_CUSTOMERS']);
  assert.equal(targetKindLabel('VISITS_COUNT'), 'عدد زيارات');
  assert.equal(targetKindLabel('NEW_CUSTOMERS'), 'عملاء جدد نشطون');
  assert.equal(TARGET_MAX.VISITS_COUNT, 1e6);
  assert.equal(TARGET_MAX.NEW_CUSTOMERS, 1e6);
  assert.equal(MAX_TARGET_PRODUCTS, 20);
  for (const k of TARGET_KINDS) assert.ok(TARGET_MAX[k.kind] > 0, k.kind);
});

test('emptyDraft بلا أصنافٍ إضافية، وdraftOf يأخذ ما بعد الأول من products لهدف الكمية وحده', () => {
  assert.deepEqual(emptyDraft('2026-11').extraProducts, []);
  const multi = view({
    kind: 'PRODUCT_QTY', productId: 'p1', productName: 'ماء', unitId: 'u-carton', unitName: 'كرتون', unitFactor: 24, targetValue: 30,
    products: [prod('p1', 'ماء', 'كرتون', 'u-carton', 24), prod('p2', 'عصير', 'كرتون', 'u-c2', 12), prod('p3', 'حليب', 'حبة')],
  });
  const d = draftOf(multi);
  assert.equal(d.productId, 'p1', 'الأول في productId كما كان');
  assert.equal(d.unitId, 'u-carton');
  assert.deepEqual(d.extraProducts, [{ productId: 'p2', unitId: 'u-c2' }, { productId: 'p3', unitId: null }], 'الإضافية بترتيبها ووحداتها');
  assert.deepEqual(draftOf(view({ kind: 'PRODUCT_QTY', productId: 'p1', productName: 'ماء' })).extraProducts, [], 'خادمٌ أقدم بلا products ⇒ صنفٌ واحد');
  assert.deepEqual(draftOf(view({ kind: 'PRODUCT_QTY', productId: 'p1', products: [prod('p1', 'ماء', 'حبة')] })).extraProducts, []);
  // غير الكمية: لا صنف ولا إضافيات حتى لو حملها الردّ
  const visits = draftOf(view({ kind: 'VISITS_COUNT', targetValue: 40, productId: 'x', products: [prod('x', 'س', null), prod('y', 'ص', null)] }));
  assert.equal(visits.kind, 'VISITS_COUNT');
  assert.equal(visits.productId, null);
  assert.deepEqual(visits.extraProducts, []);
  assert.equal(visits.targetValue, '40');
});

test('draftProblem لهدف الكمية بعدة أصناف وللنوعين الجديدين', () => {
  const qty = (over: Partial<TargetDraft> = {}) => draft({ kind: 'PRODUCT_QTY', productId: 'p1', targetValue: '10', ...over });
  assert.equal(draftProblem(qty({ extraProducts: [{ productId: 'p2', unitId: null }, { productId: 'p3', unitId: 'u' }] })), null);
  assert.equal(draftProblem(qty({ extraProducts: [{ productId: null, unitId: null }] })), 'اختر صنفاً صحيحاً', 'سطرٌ إضافي بلا صنف');
  assert.equal(draftProblem(qty({ extraProducts: [{ productId: 'p1', unitId: 'u' }] })), 'الصنف مكرر في الهدف', 'الإضافي يكرر الأول');
  assert.equal(draftProblem(qty({ extraProducts: [{ productId: 'p2', unitId: null }, { productId: 'p2', unitId: 'u' }] })), 'الصنف مكرر في الهدف',
    'إضافيان مكرران ولو بوحدتين');
  assert.equal(draftProblem(qty({ productId: null, extraProducts: [{ productId: 'p2', unitId: null }] })), 'اختر صنفاً صحيحاً', 'الأول مطلوب');
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ productId: `x${i}`, unitId: null }));
  assert.equal(draftProblem(qty({ extraProducts: many(MAX_TARGET_PRODUCTS - 1) })), null, '٢٠ صنفاً بالأول مقبولة');
  assert.equal(draftProblem(qty({ extraProducts: many(MAX_TARGET_PRODUCTS) })), 'أصناف الهدف 20 على الأكثر');
  // الأصناف الإضافية لا تُفحص في غير الكمية (بقايا نموذجٍ بُدّل نوعه)
  assert.equal(draftProblem(draft({ extraProducts: [{ productId: null, unitId: null }] })), null);

  // عدد الزيارات والعملاء الجدد: عددٌ > 0 و≤ ١٠٠٠٠٠٠ بلا صنف
  for (const kind of ['VISITS_COUNT', 'NEW_CUSTOMERS'] as const) {
    assert.equal(draftProblem(draft({ kind, targetValue: '40' })), null, `${kind} بلا صنف`);
    assert.equal(draftProblem(draft({ kind, targetValue: '1000000' })), null, `${kind} السقف نفسه`);
    assert.equal(draftProblem(draft({ kind, targetValue: '1000001' })), 'العدد كبير جدا', kind);
  }
  for (const v of ['0', '', '-1', 'abc']) {
    assert.equal(draftProblem(draft({ kind: 'VISITS_COUNT', targetValue: v })), 'عدد الزيارات رقم أكبر من صفر', v);
    assert.equal(draftProblem(draft({ kind: 'NEW_CUSTOMERS', targetValue: v })), 'عدد العملاء رقم أكبر من صفر', v);
  }
  assert.equal(draftProblem(draft({ kind: 'VISITS_COUNT', targetValue: '٤٠' })), null, 'الأرقام الهندية');
});

test('toTargetInput بعدة أصناف: products القائمة كاملةً (الأول أولاً) حين توجد إضافيات وحدها، ولكل سطرٍ أساسه', () => {
  const d = draft({ kind: 'PRODUCT_QTY', productId: 'p1', unitId: 'u-carton', targetValue: '30',
    extraProducts: [{ productId: 'p2', unitId: null }, { productId: 'p3', unitId: 'u-box' }] });
  const box: UnitChoice = { id: 'u-box', name: 'علبة', factor: 6, price: null };
  const body = toTargetInput(d, carton, 'حبة', [
    { productId: 'p2', unit: piece, baseUnitName: ' حبة ' },
    { productId: 'p3', unit: box, baseUnitName: null },
  ]);
  assert.equal(body.productId, 'p1', 'الأول في productId/unitId كما كان');
  assert.equal(body.unitId, 'u-carton');
  assert.equal(body.baseUnitName, 'حبة');
  assert.equal(body.targetValue, 30, 'الكمية كما كُتبت');
  assert.deepEqual(body.products, [
    { productId: 'p1', unitId: 'u-carton', baseUnitName: 'حبة' },
    { productId: 'p2', unitId: null, baseUnitName: 'حبة' },
    { productId: 'p3', unitId: 'u-box' },
  ], 'وحدة الأساس null، والأساس المجهول بلا الحقل');
  // صنفٌ واحد ⇒ بلا products (الجسم كما كان قبل التوسعة)
  assert.equal('products' in toTargetInput(d, carton, 'حبة'), false);
  assert.equal('products' in toTargetInput(d, carton, 'حبة', []), false);
  // الأول بلا أساسٍ معروف ⇒ سطره بلا الحقل
  assert.deepEqual(toTargetInput(d, carton, null, [{ productId: 'p2', unit: null }]).products,
    [{ productId: 'p1', unitId: 'u-carton' }, { productId: 'p2', unitId: null }]);
  // غير الكمية لا يحمل أصنافاً ولو مُرّرت
  const visits = toTargetInput(draft({ kind: 'VISITS_COUNT', targetValue: '٤٠', productId: 'p1' }), carton, 'حبة', [{ productId: 'p2', unit: piece }]);
  assert.equal('products' in visits, false);
  assert.equal(visits.productId, null);
  assert.equal(visits.unitId, null);
  assert.equal(visits.targetValue, 40);
  // نموذج التعديل يعود بالأصناف نفسها
  const t = view({ kind: 'PRODUCT_QTY', productId: 'p1', productName: 'ماء', unitId: 'u-carton', unitName: 'كرتون', unitFactor: 24, targetValue: 30,
    products: [prod('p1', 'ماء', 'كرتون', 'u-carton', 24), prod('p2', 'عصير', 'حبة'), prod('p3', 'حليب', 'علبة', 'u-box', 6)] });
  assert.deepEqual(draftOf(t).extraProducts.map(e => e.productId), ['p2', 'p3']);
});

test('targetUnitText: الوحدة المشتركة بين الأصناف، ووحداتٌ مختلفة أو مجهولة ⇒ رقمٌ بلا وحدة', () => {
  assert.equal(targetUnitText({ unitName: 'كرتون' }), 'كرتون', 'خادمٌ أقدم بلا products');
  assert.equal(targetUnitText({ unitName: ' كرتون ' }), 'كرتون');
  assert.equal(targetUnitText({ unitName: null }), '');
  assert.equal(targetUnitText({ unitName: 'كرتون', products: [] }), 'كرتون', 'قائمةٌ فارغة ⇒ الصنف الواحد');
  assert.equal(targetUnitText({ unitName: 'كرتون', products: [{ unitName: 'كرتون' }, { unitName: ' كرتون' }] }), 'كرتون');
  assert.equal(targetUnitText({ unitName: 'كرتون', products: [{ unitName: 'كرتون' }, { unitName: 'حبة' }] }), '', 'كراتين وحبّات لا تُجمع بوحدةٍ واحدة');
  assert.equal(targetUnitText({ unitName: 'كرتون', products: [{ unitName: 'كرتون' }, { unitName: null }] }), '');
});

test('targetTitle وقيم الهدف للأنواع الجديدة وبعدة أصناف: العدّ بلا عملة، والأسماء بفاصلة والوحدة المشتركة', () => {
  assert.equal(targetTitle(view({ kind: 'VISITS_COUNT', targetValue: 40 }), arTr), 'زيارات الشهر');
  assert.equal(targetTitle(view({ kind: 'NEW_CUSTOMERS', targetValue: 5 }), arTr), 'عملاء جدد نشطون');
  const same = view({ kind: 'PRODUCT_QTY', productName: 'ماء', unitName: 'كرتون', products: [prod('p1', 'ماء', 'كرتون'), prod('p2', 'عصير', 'كرتون')] });
  assert.equal(targetTitle(same, arTr), 'ماء، عصير — كرتون');
  const mixed = view({ kind: 'PRODUCT_QTY', productName: 'ماء', unitName: 'كرتون', products: [prod('p1', 'ماء', 'كرتون'), prod(null, null, 'حبة')] });
  assert.equal(targetTitle(mixed, arTr), 'ماء، صنف محذوف', 'وحداتٌ مختلفة ⇒ الأسماء وحدها، والمحذوف باسمه البديل');
  assert.equal(targetTitle(view({ kind: 'PRODUCT_QTY', productName: 'ماء', unitName: 'كرتون', products: [prod('p1', 'ماء', 'كرتون')] }), arTr), 'ماء — كرتون',
    'صنفٌ واحد في القائمة كما كان');

  // العدّ رقمٌ بمنسّق الأرقام لا مال
  const n = (x: number) => `#${x}`;
  assert.equal(targetAmountText(view({ kind: 'VISITS_COUNT' }), 12, money), '12');
  assert.equal(targetAmountText(view({ kind: 'NEW_CUSTOMERS' }), 3, money, n), '#3');
  assert.equal(targetAmountText(view({ kind: 'VISITS_COUNT' }), Number.NaN, money), '0');
  assert.equal(targetAmountText(same, 7.5, money), '7.5 كرتون', 'الوحدة المشتركة');
  assert.equal(targetAmountText(mixed, 7.5, money), '7.5', 'وحداتٌ مختلفة ⇒ رقمٌ بلا وحدة');
  assert.equal(targetAmountText(view({ kind: 'SALES_AMOUNT' }), 1500, money, n), '1500.00 ر.س', 'المبيعات مالٌ كما كانت');
});

test('groupTargets: المدمج مجموعةٌ واحدة في موضع أول أعضائه، والمستقل كما هو، وعضوٌ وحيد بمعرّف دمج مستقل', () => {
  const a = member('a', null), b = member('b', 'c1'), c = member('c', null), d = member('d', 'c1'), e = member('e', 'c2'), f = member('f', 'c3'), g = member('g', 'c3');
  const groups = groupTargets([a, b, c, d, e, f, g]);
  assert.deepEqual(groups.map(x => x.kind === 'combo' ? `combo:${x.comboId}[${x.members.map(m => m.id).join(',')}]` : x.target.id),
    ['a', 'combo:c1[b,d]', 'c', 'e', 'combo:c3[f,g]'], 'ترتيب الإنشاء محفوظ، والعضو الوحيد (c2) مستقل');
  assert.deepEqual(groupTargets([]), []);
  assert.deepEqual(groupTargets([a, c]).map(x => x.kind), ['single', 'single'], 'بلا دمج ⇒ كما كانت');
  // comboId غائب (خادمٌ أقدم — view() بلا الحقل) أو null سواء
  assert.equal('comboId' in view(), false);
  assert.deepEqual(groupTargets([view({ id: 'old' }), view({ id: 'old2' })]).map(x => x.kind), ['single', 'single']);
  const combo = groupTargets([member('x', 'k'), member('y', 'k'), member('z', 'k')])[0];
  assert.ok(combo.kind === 'combo' && combo.members.length === 3, 'ثلاثة أعضاء');
});

test('comboDone: المدمج يتحقق بتحقق كل أعضائه، والفارغ لا يتحقق', () => {
  assert.equal(comboDone([member('a', 'k', true), member('b', 'k', true)]), true);
  assert.equal(comboDone([member('a', 'k', true), member('b', 'k', false)]), false, 'عضوٌ واحد ناقص يحبس المكافأة');
  assert.equal(comboDone([member('a', 'k', false), member('b', 'k', false)]), false);
  assert.equal(comboDone([]), false);
  // رموز رفض الدمج والأصناف مترجمة
  for (const code of ['TARGET_PRODUCT_DUPLICATE', 'TARGET_COMBO_INVALID', 'TARGET_IN_COMBO']) assert.ok(TARGET_ERRORS[code], code);
  assert.equal(targetErrorMessage({ response: { data: { code: 'TARGET_PRODUCT_DUPLICATE' } } }, arTr, 'ف'), 'الصنف مكرر في الهدف');
});

test('draftProblem مرآة حدود الخادم: الشهر YYYY-MM، والقيمة أكبر من صفر حتى سقف نوعها، والمكافأة كذلك، والملاحظة ٣٠٠', () => {
  assert.equal(draftProblem(draft()), null, 'هدف مبيعاتٍ سليم');
  for (const m of ['2026-13', '2026-00', '2026-1', '26-11', '']) assert.equal(draftProblem(draft({ month: m })), 'الشهر غير صحيح', m);

  // المبيعات: > 0 و≤ 1e12
  for (const v of ['0', '-5', '', 'abc']) assert.equal(draftProblem(draft({ targetValue: v })), 'مبلغ الهدف رقم أكبر من صفر', v);
  assert.equal(draftProblem(draft({ targetValue: '1000000000000' })), null, 'السقف نفسه مقبول');
  assert.equal(draftProblem(draft({ targetValue: '1000000000001' })), 'مبلغ الهدف كبير جدا');

  // الكمية: بصنفٍ، > 0 و≤ 1e9
  assert.equal(draftProblem(draft({ kind: 'PRODUCT_QTY', targetValue: '10' })), 'اختر صنفاً صحيحاً', 'هدف كميةٍ بلا صنف');
  assert.equal(draftProblem(draft({ kind: 'PRODUCT_QTY', productId: 'p1', targetValue: '1000000000' })), null);
  assert.equal(draftProblem(draft({ kind: 'PRODUCT_QTY', productId: 'p1', targetValue: '1000000001' })), 'كمية الهدف كبيرة جدا');
  assert.equal(draftProblem(draft({ kind: 'PRODUCT_QTY', productId: 'p1', targetValue: '0' })), 'كمية الهدف رقم أكبر من صفر');

  // التحصيل: نسبة > 0 و≤ 100
  assert.equal(draftProblem(draft({ kind: 'COLLECTION_PCT', targetValue: '100' })), null);
  assert.equal(draftProblem(draft({ kind: 'COLLECTION_PCT', targetValue: '100.5' })), 'نسبة التحصيل أكبر من صفر وحتى 100');
  assert.equal(draftProblem(draft({ kind: 'COLLECTION_PCT', targetValue: '0' })), 'نسبة التحصيل أكبر من صفر وحتى 100');

  // المكافأة: العمولة ≤ 100 · الراتب ≤ 1000 · المبلغ ≤ 1e9، وكلها > 0
  assert.equal(draftProblem(draft({ rewardValue: '100' })), null);
  assert.equal(draftProblem(draft({ rewardValue: '101' })), 'نسبة العمولة أكبر من صفر وحتى 100');
  assert.equal(draftProblem(draft({ rewardValue: '0' })), 'نسبة العمولة أكبر من صفر وحتى 100');
  assert.equal(draftProblem(draft({ rewardKind: 'SALARY_PCT', rewardValue: '1000' })), null, 'نسبة الراتب قد تتجاوز ١٠٠٪');
  assert.equal(draftProblem(draft({ rewardKind: 'SALARY_PCT', rewardValue: '1001' })), 'نسبة الراتب أكبر من صفر وحتى 1000');
  assert.equal(draftProblem(draft({ rewardKind: 'FIXED_AMOUNT', rewardValue: '1000000000' })), null);
  assert.equal(draftProblem(draft({ rewardKind: 'FIXED_AMOUNT', rewardValue: '1000000001' })), 'مبلغ المكافأة كبير جدا');
  assert.equal(draftProblem(draft({ rewardKind: 'FIXED_AMOUNT', rewardValue: '' })), 'مبلغ المكافأة رقم أكبر من صفر');

  assert.equal(draftProblem(draft({ note: `  ${'م'.repeat(300)}  ` })), null, 'المسافات حول الملاحظة لا تُحسب');
  assert.equal(draftProblem(draft({ note: 'م'.repeat(301) })), 'الملاحظة 300 حرف على الأكثر');

  // الأرقام العربية والفاصلة العشرية العربية تُقرأ
  assert.equal(draftProblem(draft({ targetValue: '١٥٠٠٠', rewardValue: '٢٫٥' })), null);
  assert.equal(MAX_TARGETS_PER_MONTH, 20);
});

test('readNum وcleanDecimal: الأرقام الهندية والفاصلة نقطةٌ عشرية كخانة DecimalInput، والدخيل لا يُكتب', () => {
  assert.equal(readNum('١٢٫٥'), 12.5);
  assert.equal(readNum('12,5'), 12.5);
  assert.equal(readNum(''), null);
  assert.ok(Number.isNaN(readNum('ab')));
  assert.equal(cleanDecimal('١٢٫٥'), '12.5');
  assert.equal(cleanDecimal('12a'), null, 'حرفٌ دخيل يُتجاهل');
  assert.equal(cleanDecimal('1.2.3'), null);
  assert.equal(cleanDecimal(''), '');
});

test('toTargetInput: الكمية كما كُتبت بوحدة الهدف (الخادم يضرب بالمعامل) ووحدة الأساس null، وغير الكمية بلا صنفٍ ولا وحدة', () => {
  const qty = draft({ kind: 'PRODUCT_QTY', productId: 'p1', unitId: 'u-carton', targetValue: '10', note: '  ركّز على الماء  ' });
  assert.deepEqual(toTargetInput(qty, carton), {
    month: '2026-11', kind: 'PRODUCT_QTY', targetValue: 10, productId: 'p1', unitId: 'u-carton',
    rewardKind: 'COMMISSION_SALES_PCT', rewardValue: 2, note: 'ركّز على الماء',
  });
  assert.equal(toTargetInput(qty, carton).targetValue, 10, '١٠ كراتين تُرسل ١٠ لا ٢٤٠ — الضرب في الخادم مرّةً واحدة');
  assert.equal(toTargetInput(qty, piece).unitId, null, 'وحدة الأساس = unitId null');
  const sales = toTargetInput(draft({ productId: 'p-stale', unitId: 'u-stale', note: '   ', targetValue: '٥٠٠٠٠' }), carton);
  assert.equal(sales.productId, null);
  assert.equal(sales.unitId, null);
  assert.equal(sales.note, null, 'الملاحظة الفارغة null');
  assert.equal(sales.targetValue, 50000);
  // نموذج التعديل يعود بالقيم نفسها
  const t = view({ kind: 'PRODUCT_QTY', productId: 'p1', productName: 'ماء', unitId: 'u-carton', unitName: 'كرتون', unitFactor: 24, targetValue: 10, note: 'م' });
  assert.deepEqual(toTargetInput(draftOf(t), carton), { ...toTargetInput(qty, carton), note: 'م' });
  // أساس الصنف كما رآه النموذج (حارس الخادم من كاشٍ قديم): لهدف الكمية وحده وحين يُعرف
  assert.equal(toTargetInput(qty, piece, 'حبة').baseUnitName, 'حبة');
  assert.equal(toTargetInput(qty, carton, '  حبة ').baseUnitName, 'حبة');
  assert.equal('baseUnitName' in toTargetInput(qty, carton, null), false, 'الصنف لم يُحمَّل ⇒ بلا الحقل (مسار الخادم كما كان)');
  assert.equal('baseUnitName' in toTargetInput(qty, carton, '  '), false);
  assert.equal('baseUnitName' in toTargetInput(draft(), null, 'حبة'), false, 'غير الكمية بلا أساس');
});

test('barPct: ٠–١٠٠ للشريط والنسبة غير مسقوفة من الخادم، وnull وNaN صفر', () => {
  assert.equal(barPct(null), 0);
  assert.equal(barPct(undefined), 0);
  assert.equal(barPct(Number.NaN), 0);
  assert.equal(barPct(-5), 0);
  assert.equal(barPct(42.5), 42.5);
  assert.equal(barPct(150), 100);
  assert.equal(pctText(null, 'en-US'), '—');
  assert.equal(pctText(42.5, 'en-US'), '42.5%');
});

test('rewardText: عمولة بمبلغها من الخادم، ونسبة الراتب نصّاً فقط، والمبلغ المحدد', () => {
  assert.equal(rewardText(view(), arTr, money), 'عمولة 2% من المبيعات ≈ 400.00 ر.س');
  assert.equal(rewardText(view({ reward: { kind: 'COMMISSION_SALES_PCT', value: 2, amount: null, earned: false } }), arTr, money), 'عمولة 2% من المبيعات',
    'بلا مبلغٍ (معاينة النموذج) النسبة وحدها');
  assert.equal(rewardText(view({ rewardKind: 'SALARY_PCT', rewardValue: 10, reward: { kind: 'SALARY_PCT', value: 10, amount: null, earned: true } }), arTr, money),
    'يستحق 10% من الراتب');
  assert.equal(rewardText(view({ rewardKind: 'FIXED_AMOUNT', rewardValue: 500, reward: { kind: 'FIXED_AMOUNT', value: 500, amount: 500, earned: false } }), arTr, money),
    'مكافأة 500.00 ر.س');
  // الإنجليزية من القاموس بأرقامها
  const en = (s: string) => PHRASES[s]?.en ?? s;
  assert.equal(rewardText(view({ rewardKind: 'SALARY_PCT', rewardValue: 10 }), en, money), 'Earns 10% of salary');
});

test('shiftMonth عبر السنوات، وmonthLabel بتوقيت UTC، والشهر التالف كما هو', () => {
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-11', 14), '2028-01');
  assert.equal(shiftMonth('2026-11', -24), '2024-11');
  assert.equal(shiftMonth('2026-11', 0), '2026-11');
  assert.equal(shiftMonth('bad', 1), 'bad');
  assert.equal(monthLabel('2026-11', 'en-US'), 'November 2026');
  assert.ok(monthLabel('2026-01', 'ar-SA-u-nu-latn').includes('2026'), 'يناير لا ينزلق إلى ديسمبر في أي منطقة');
  assert.equal(monthLabel('2026-13', 'en-US'), '2026-13');
});

test('targetTitle وقيم الهدف: المبيعات والتحصيل مالٌ، والكمية رقمٌ ومعه اسم وحدة الهدف', () => {
  assert.equal(targetTitle(view(), arTr), 'مبيعات الشهر');
  assert.equal(targetTitle(view({ kind: 'PRODUCT_QTY', productName: 'ماء ٣٣٠', unitName: 'كرتون' }), arTr), 'ماء ٣٣٠ — كرتون');
  assert.equal(targetTitle(view({ kind: 'PRODUCT_QTY', productName: null, unitName: null }), arTr), 'صنف محذوف');
  assert.equal(targetTitle(view({ kind: 'COLLECTION_PCT', targetValue: 50 }), arTr), 'تحصيل 50% من الديون السابقة');

  const qty = view({ kind: 'PRODUCT_QTY', unitName: 'كرتون' });
  assert.equal(targetAmountText(qty, 12.5, money), '12.5 كرتون', 'الكمية بلا وحدةٍ تُقرأ حبّاتٍ');
  assert.equal(targetAmountText(view(), 1500, money), '1500.00 ر.س');
  assert.equal(targetAmountText(view({ kind: 'COLLECTION_PCT' }), 300, money), '300.00 ر.س', 'هدف التحصيل مبلغٌ = الأساس × النسبة');
  assert.equal(targetRemaining({ achieved: 20000, goal: 50000 }), 30000);
  assert.equal(targetRemaining({ achieved: 60000, goal: 50000 }), 0, 'لا متبقٍّ سالب');
  assert.equal(targetStateText({ state: 'OK' }), null);
  assert.equal(targetStateText({ state: 'NO_BASE' }), 'لا توجد ديون سابقة مفتوحة في بداية الشهر');
  assert.equal(targetStateText({ state: 'PRODUCT_DELETED' }), 'الصنف محذوف');
});

test('daysLeftText: العربية بتمييز العدد، وغيرها بالقاموس، والصفر بلا نصّ', () => {
  assert.equal(daysLeftText(1, 'ar', arTr), 'متبقي يوم واحد');
  assert.equal(daysLeftText(2, 'ar', arTr), 'متبقي يومان');
  assert.equal(daysLeftText(5, 'ar', arTr), 'متبقي 5 أيام');
  assert.equal(daysLeftText(21, 'ar', arTr), 'متبقي 21 يوماً');
  assert.equal(daysLeftText(0, 'ar', arTr), '');
  assert.equal(daysLeftText(21, 'en', s => PHRASES[s]?.en ?? s), '21 days left');
});

test('targetErrorMessage: رموز الخادم مترجمة، وإلا رسالته، وإلا البديل', () => {
  const err = (data: unknown) => ({ response: { data } });
  assert.equal(targetErrorMessage(err({ code: 'TARGET_LIMIT', message: 'x' }), arTr, 'ف'), 'وصلت للحد الأعلى من الأهداف لهذا الشهر (20)');
  assert.equal(targetErrorMessage(err({ code: 'TARGET_UNIT_INVALID' }), s => PHRASES[s]?.en ?? s, 'f'), 'Invalid item unit');
  assert.equal(targetErrorMessage(err({ message: 'رسالة الخادم' }), arTr, 'ف'), 'رسالة الخادم', 'أخطاء التحقق ٤٠٠ برسالتها');
  assert.equal(targetErrorMessage(new Error('net'), arTr, 'تعذر الحفظ'), 'تعذر الحفظ');
  assert.equal(targetErrorMessage(null, arTr, 'ف'), 'ف');
  for (const code of ['REP_NOT_FOUND', 'TARGET_NOT_FOUND', 'TARGET_PRODUCT_INVALID', 'TARGET_UNIT_INVALID', 'TARGET_LIMIT']) assert.ok(TARGET_ERRORS[code], code);
  // حارس أساس الصنف: كاشٌ قديم (400) وتحويلٌ أثناء الحفظ (409) ⇒ راجع الوحدة، والانتظار (503) ⇒ أعد المحاولة — بالترجمة لا برسالة الخادم العربية
  assert.equal(targetErrorMessage(err({ code: 'UNIT_INVALID', message: 'تغيّرت وحدات «ماء»' }), arTr, 'ف'), 'تغيرت وحدات الصنف راجع الوحدة ثم احفظ');
  assert.equal(targetErrorMessage(err({ code: 'PRODUCT_UNITS_CHANGED' }), arTr, 'ف'), 'تغيرت وحدات الصنف راجع الوحدة ثم احفظ');
  assert.equal(targetErrorMessage(err({ code: 'PRODUCT_UNITS_BUSY' }), s => PHRASES[s]?.en ?? s, 'f'), 'The item’s units are being updated. Try again in a moment');
  assert.equal(targetErrorCode(err({ code: 'TARGET_NOT_FOUND' })), 'TARGET_NOT_FOUND');
  assert.equal(targetErrorCode(err({ message: 'x' })), undefined);
  assert.equal(targetErrorCode(new Error('net')), undefined);
});

test('targetsFetchDue: أول مرة، وبعد مستندٍ أو مزامنة (refreshKey)، وبعد ٣٠ ثانية — وإلّا تكفي المحفوظة', () => {
  assert.equal(targetsFetchDue(null, 0, 1000), true);
  assert.equal(targetsFetchDue({ at: 1000, key: 0 }, 0, 1000 + 29_999), false, 'تبديل تبويبٍ سريع لا يطلب');
  assert.equal(targetsFetchDue({ at: 1000, key: 0 }, 0, 1000 + 30_000), true);
  assert.equal(targetsFetchDue({ at: 1000, key: 0 }, 1, 1001), true, 'صدر مستند ⇒ جلبٌ فوري');
  assert.equal(targetsFetchDue({ at: 5000, key: 0 }, 0, 1000), true, 'ساعةٌ رجعت للخلف لا تحبس الجلب');
});

test('القاموس: كل عبارةٍ تنتجها الوحدة وكل tr في النافذة والبطاقة بلغاتها الأربع ومواضعها {..}', () => {
  const keys = new Set<string>(REP_TARGET_TEXTS);
  for (const k of TARGET_KINDS) assert.ok(keys.has(k.label), k.label);
  for (const k of REWARD_KINDS) assert.ok(keys.has(k.label), k.label);
  const files = [read('components', 'RepTargetsModal.tsx'), read('rep', 'RepTargetsCard.tsx'), read('lib', 'repTargets.ts')];
  let literals = 0;
  for (const f of files) for (const m of f.matchAll(/\btr\('((?:[^'\\]|\\.)*)'\)/g)) { keys.add(m[1]); literals += 1; }
  assert.ok(literals > 40, `قُرئت ${literals} عبارة فقط`);
  // تُجمع النواقص كلها في رسالةٍ واحدة (لا أوّلها فقط) فتُضاف ترجماتها دفعةً واحدة
  const problems: string[] = [];
  for (const k of keys) {
    const e = PHRASES[k];
    if (!e) { problems.push(`غير موجودة في القاموس: ${k}`); continue; }
    for (const lang of LANGS) {
      if (!e[lang]?.trim()) { problems.push(`${k} بلا ${lang}`); continue; }
      for (const ph of k.match(/\{\w+\}/g) ?? []) if (!e[lang].includes(ph)) problems.push(`${k} (${lang}) بلا ${ph}`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
  // لا ذكر للضريبة في الميزة (وضع «إزالة الضريبة»)
  for (const k of keys) assert.doesNotMatch(k, /ضريب/, k);
});

test('صفحة المناديب: أيقونة «هدف الشهر» أوّل الإجراءات بعَلَم المحاسبة، وتفتح نافذة الأهداف', () => {
  const page = read('pages', 'SalesRepsPage.tsx');
  assert.match(page, /import \{[^}]*\bTarget\b[^}]*\} from 'lucide-react';/);
  assert.ok(page.includes("import RepTargetsModal from '../components/RepTargetsModal';"));
  assert.ok(page.includes('const [targetsRep, setTargetsRep] = useState<SalesRep | null>(null);'));
  const btn = "{accountingOn && (\n                        <button onClick={() => setTargetsRep(r)} className=\"p-1.5 hover:bg-[#FBEBE2] rounded text-[#E15A30]\" title={tr('هدف الشهر')} aria-label={tr('هدف الشهر')}><Target size={14} /></button>\n                      )}";
  const at = page.indexOf(btn);
  assert.ok(at > 0, 'الزرّ محروسٌ بـaccountingOn');
  assert.ok(at < page.indexOf('onClick={() => setCollectRep(r)}'), 'قبل زرّ استلام التحصيل');
  assert.ok(page.includes('{targetsRep && <RepTargetsModal rep={targetsRep} onClose={() => setTargetsRep(null)} />}'));
  // النافذة: مفاتيح react-query وإبطالها، وحذفٌ بتأكيد، وإغلاق الخلفية الآمن
  const modal = read('components', 'RepTargetsModal.tsx');
  assert.ok(modal.includes("queryKey: ['rep-targets', rep.id, month],"));
  // الحفظ والحذف (ومعهما الدمج وفكّه) يبطلان أشهر المندوب
  assert.ok((modal.match(/qc\.invalidateQueries\(\{ queryKey: \['rep-targets', rep\.id\] \}\)/g)?.length ?? 0) >= 2, 'الحفظ والحذف يبطلان أشهر المندوب');
  assert.ok(modal.includes('{...backdropClose(onClose)}'));
  assert.ok(modal.includes('<ConfirmDialog'));
  assert.ok(modal.includes("queryKey: ['products-min'],"), 'كاش الأصناف المشترك');
  assert.ok(modal.includes('choiceById(product, d.unitId)') && modal.includes('defaultChoice(p).id'), 'وحدة الصنف من repUnits');
  // أساس الصنف المحمَّل يُرسل مع هدف الكمية (ومعه الأصناف الإضافية إن وُجدت)، ورفض الحارس يعيد جلب الأصناف
  // ومعه اعتماد حجم الوحدة الحالي بقرارٍ صريح وحده (F4)
  assert.ok(modal.includes('onSave({ ...toTargetInput(d, choice, product?.unit ?? null, extras), ...unitRefreshFlag(drifts, refreshUnits) });'));
  assert.match(modal, /if \(isStaleUnitsError\(e\)\) \{\n\s*void qc\.invalidateQueries\(\{ queryKey: \['products-min'\] \}\);\n\s*void qc\.invalidateQueries\(\{ queryKey: \['rep-target-product-search'\] \}\);/,
    'رفض الحارس يعيد جلب الأصناف ونتائج البحث');
  // تعذّر قائمة الأصناف (بلا صلاحية الأصناف) يُقال تحت المنتقي لا قائمةٌ فارغة صامتة
  assert.ok(modal.includes("prodStatus === 403 ? tr('اختيار الصنف يحتاج صلاحية إدارة الأصناف')"));
  assert.ok(modal.includes('{productsError && ('));
  // هدفٌ يُعدَّل اختفى من القائمة ⇒ يُغلق نموذجه فلا تبقى الأزرار معطّلة
  assert.ok(modal.includes("if (editing && editing !== 'new' && data && !q.isPlaceholderData && !data.targets.some(t => t.id === editing)) setEditing(null);"));
  const client = read('api', 'client.ts');
  assert.ok(client.includes('export const repTargetsApi = {'));
  for (const s of ["api.get(`/rep-targets/rep/${repId}`", "api.post(`/rep-targets/rep/${repId}`, body)", "api.put(`/rep-targets/${id}`, body)", "api.delete(`/rep-targets/${id}`)",
    "combine: (body: RepTargetComboInput) => api.post('/rep-targets/combo', body)", 'uncombine: (comboId: string) => api.delete(`/rep-targets/combo/${comboId}`)']) {
    assert.ok(client.includes(s), s);
  }
});

test('بطاقة المندوب: الأهداف مجمّعةً بـgroupTargets، والمدمج كتلةٌ واحدة بمكافأةٍ تُستحق بتحقق كل أعضائه', () => {
  const card = read('rep', 'RepTargetsCard.tsx');
  assert.ok(card.includes('groupTargets(data.targets).map('), 'لا تُرسم الأهداف واحداً واحداً');
  assert.ok(card.includes("g.kind === 'combo'"));
  assert.ok(card.includes("tr('هدف مدمج')") && card.includes("tr('يتحقق بتحقق كل الأهداف')"));
  assert.ok(card.includes('const done = comboDone(members);'));
  assert.ok(card.includes('<RewardLine t={members[0]} earned={done} />'), 'مكافأةٌ واحدة للمدمج (منسوخةٌ على أعضائه) بتحقق الجميع');
  assert.ok(card.includes('<RewardLine t={t} earned={t.reward.earned} />'), 'والمستقل بمكافأته كما كان');
  // العناوين والقيم من الوحدة (الأصناف المتعددة والزيارات والعملاء الجدد) لا نصٌّ محلي
  assert.ok(card.includes('targetTitle(t, tr, num)') && card.includes('targetAmountText(t, p.achieved, money, num)'));
  assert.doesNotMatch(card, /ضريب/);
});

test('تطبيق المندوب: بطاقة «هدف الشهر» في الرئيسية بعد خط السير، تُحفظ وتُعرض بلا اتصال، ومحروسةٌ بالمحاسبة', () => {
  const app = read('rep', 'RepApp.tsx');
  const home = app.slice(app.indexOf('function RepHome('), app.indexOf('function RepCustomers('));
  assert.ok(home.length > 1000, 'RepHome موجودة');
  assert.ok(home.includes('{accountingOn && targets && <RepTargetsCard data={targets} stale={targetsStale} onRetry={() => { void loadTargets(true); }} />}'));
  assert.ok(home.includes("await cacheSet('rep-targets', data);"));
  assert.ok(home.includes("cacheGet<RepTargetsData>('rep-targets')"));
  // المحفوظة المعروضة قبل جلبٍ جارٍ موسومةٌ بزمنها (لا تقدّم الأمس كأنه اللحظة)، و«تحديث» الإحصائيات يحدّث الأهداف أيضاً
  assert.ok(home.includes('if (cached?.data) { setTargets(cached.data); setTargetsStale(due ? cached.updatedAt : null); }'));
  assert.ok(home.includes('onClick={() => { void load(); void loadTargets(true); }}'));
  assert.ok(read('rep', 'RepTargetsCard.tsx').includes('{onRetry && <button type="button" onClick={onRetry}'), 'البطاقة الموسومة تُحدَّث وحدها');
  assert.ok(home.includes('if (!accountingOn) { setTargets(null); setTargetsStale(null); return; }'), 'لا طلب والمحاسبة مطفأة');
  assert.ok(home.indexOf('<RepTargetsCard') > home.indexOf("onClick={() => onQuick('route')}"), 'بعد بطاقة خط السير');
  assert.ok(home.indexOf('<RepTargetsCard') < home.indexOf("{tr('إحصائيات اليوم')}"), 'قبل إحصائيات اليوم');
  // السطر المحروس لم يتغيّر (repRoutesFixes.test.ts)
  assert.match(app, /await cacheSet\('rep-home-stats', fresh\);\s*\n\s*loadRoute\(\);/);
  assert.ok(app.includes('<RepHome key={refreshKey} refreshKey={refreshKey} '), 'الرئيسية تعرف مفتاح تحديثها');
  const fetcher = read('rep', 'repTargetsFetch.ts');
  assert.ok(fetcher.includes("repApi.get('/rep-targets/mine', { background: true })"), 'طلبٌ خلفيّ لا يُخرج المندوب');
});

// ═══ «مدة الهدف» (طلب المالك ١٣ نوفمبر ٢٠٢٦): الشهر كله أو فترةٌ مخصّصة ═══

test('مدة الهدف — النموذج: الشهر كله افتراضاً بلا حقلي الفترة في الجسم، والمخصّصة شهرها شهر بدايتها، وتُرفض الناقصة والمقلوبة والأطول من سنة', async () => {
  const L = await import('./repTargets');
  const d0 = draft();
  assert.deepEqual([d0.periodMode, d0.periodFrom, d0.periodTo], ['MONTH', '2026-11-01', '2026-11-30'], 'الفترة المقترحة الشهر المعروض');
  const body = toTargetInput(d0, null);
  assert.equal('periodFrom' in body || 'periodTo' in body, false, 'الشهر كله: الجسم كما كان');
  assert.equal(body.month, '2026-11');
  const custom = toTargetInput(draft({ periodMode: 'CUSTOM', periodFrom: '2026-12-05', periodTo: '2027-01-20' }), null);
  assert.deepEqual([custom.month, custom.periodFrom, custom.periodTo], ['2026-12', '2026-12-05', '2027-01-20']);
  assert.equal(draftProblem(draft({ periodMode: 'CUSTOM', periodFrom: '2026-11-15', periodTo: '2026-11-14' })), 'نهاية الفترة قبل بدايتها');
  assert.equal(draftProblem(draft({ periodMode: 'CUSTOM', periodFrom: '2026-01-01', periodTo: '2027-01-02' })), 'فترة الهدف سنة على الأكثر');
  assert.equal(draftProblem(draft({ periodMode: 'CUSTOM', periodFrom: '', periodTo: '2026-11-14' })), 'حدد بداية الفترة ونهايتها');
  assert.equal(draftProblem(draft({ periodMode: 'CUSTOM', periodFrom: '2026-02-30', periodTo: '2026-03-04' })), 'حدد بداية الفترة ونهايتها');
  assert.equal(draftProblem(draft({ periodMode: 'CUSTOM', periodFrom: '2026-11-10', periodTo: '2026-11-10' })), null, 'يومٌ واحد');
  assert.equal(L.periodDays('2026-11-08', '2026-11-14'), 7);
  // التعديل يعيد الفترة كما حُفظت، والشهر كله يقترح حدود شهره
  const p = { from: '2026-11-08', to: '2026-11-14', custom: true, state: 'ACTIVE' as const, daysLeft: 5 };
  assert.deepEqual([draftOf(view({ period: p })).periodMode, draftOf(view({ period: p })).periodFrom], ['CUSTOM', '2026-11-08']);
  assert.equal(draftOf(view()).periodMode, 'MONTH', 'خادمٌ أقدم بلا period ⇒ الشهر كله');
});

test('مدة الهدف — العرض: «مبيعات الفترة» للمخصّصة، وحالها (متبقي/تبدأ/انتهت)، ونصّ «لا ديون» بالفترة، وكل عبارةٍ مترجمة', async () => {
  const L = await import('./repTargets');
  const p = { from: '2026-11-08', to: '2026-11-14', custom: true, state: 'ACTIVE' as const, daysLeft: 5 };
  assert.equal(targetTitle(view({ period: p }), arTr), 'مبيعات الفترة');
  assert.equal(targetTitle(view({ kind: 'VISITS_COUNT', period: p }), arTr), 'زيارات الفترة');
  assert.equal(targetTitle(view({ period: { ...p, custom: false } }), arTr), 'مبيعات الشهر');
  assert.equal(L.periodStatusText(p, 'ar', arTr, 'ar-SA-u-nu-latn', String), 'متبقي 5 أيام');
  assert.equal(L.periodStatusText({ ...p, state: 'ENDED', daysLeft: 0 }, 'ar', arTr, 'ar-SA'), 'انتهت الفترة');
  assert.match(L.periodStatusText({ ...p, state: 'UPCOMING', daysLeft: 7 }, 'ar', arTr, 'en-US'), /^تبدأ November 8$/);
  assert.match(L.periodLabel(p, 'en-US'), /Nov(ember)?\s+8\s*[–-]\s*14,\s*2026/);
  assert.equal(targetStateText({ state: 'NO_BASE' }, true), 'لا توجد ديون سابقة مفتوحة في بداية الفترة');
  assert.equal(targetStateText({ state: 'NO_BASE' }), 'لا توجد ديون سابقة مفتوحة في بداية الشهر');
  for (const k of ['مدة الهدف', 'الشهر كاملا', 'فترة محددة', 'الديون المفتوحة بداية الفترة', '{n} يوما', 'أقل من شهر أو أكثر حتى سنة وتحسب أرقام الهدف كلها داخل الفترة']) {
    for (const l of LANGS) assert.ok(PHRASES[k]?.[l], `${k} ${l}`);
  }
  // النافذة وبطاقة المندوب تعرضان الفترة، والنموذج يعرض خانتيها
  assert.match(read('components', 'RepTargetsModal.tsx'), /data-target-period-field=""/);
  assert.match(read('rep', 'RepTargetsCard.tsx'), /<PeriodLine t=\{t\} \/>/);
});

test('مدة الهدف — طول الفترة بتمييز العدد، والهدف في الشهر المعروض (لينتقل إليه بعد الحفظ)، ومفتاح النافذة للدمج', async () => {
  const L = await import('./repTargets');
  assert.deepEqual([1, 2, 7, 15, 100].map(n => L.periodDaysText(n, 'ar', arTr, String)), ['يوم واحد', 'يومان', '7 أيام', '15 يوماً', '100 يوم']);
  assert.equal(L.periodDaysText(1, 'en', (s: string) => (PHRASES[s]?.en ?? s), String), '1 day');
  assert.equal(L.periodDaysText(5, 'en', (s: string) => (PHRASES[s]?.en ?? s), String), '5 days');
  const p = (from: string, to: string) => ({ from, to, custom: true, state: 'ACTIVE' as const, daysLeft: 1 });
  assert.equal(L.targetInMonth({ month: '2026-11', period: p('2026-11-20', '2027-01-10') }, '2026-12'), true, 'الممتدّة تُرى في ديسمبر');
  assert.equal(L.targetInMonth({ month: '2026-12', period: p('2026-12-05', '2026-12-20') }, '2026-11'), false, 'حُفظت في ديسمبر من نافذة نوفمبر');
  assert.equal(L.targetInMonth({ month: '2026-11' }, '2026-11'), true);
  assert.notEqual(L.windowKeyOf({ month: '2026-11' }), L.windowKeyOf({ month: '2026-11', period: p('2026-11-01', '2026-11-30') }));
  assert.ok(TARGET_ERRORS.TARGET_COMBO_PERIOD && PHRASES[TARGET_ERRORS.TARGET_COMBO_PERIOD]?.en);
});
