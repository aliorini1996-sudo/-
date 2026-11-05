import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  invoiceLine, addInvoiceLine, setInvoiceLineUnit, stepInvoiceLine, removeInvoiceLine, refreshInvoiceLines, repriceInvoiceLines,
  addedLinePrice, productBaseQty, priceOverrideOf, lineKey, type SalePick,
} from './mUnits';
import { unitChoices } from '../rep/repUnits';
import { invoiceTotals } from './docMath';
import { docLinePricerOf, type DocPriceRule } from '../lib/invoiceModalRepPrice';

/**
 * «قوائم الأسعار» بقواعدها في فاتورة الجوال (طلب المالك ٥ نوفمبر ٢٠٢٦) — المسعِّر نفسه في فاتورة اللوحة (docLinePricerOf) يمرّ في
 * دوال البنود (mUnits)، وكل تغيّرٍ في كمية صنف (نقرة الإضافة، +/−، تبديل الوحدة، الحذف) يعيد بنوده التي لم يمسّها المستخدم
 * بكميته الجديدة — والمعدَّل يدويّاً يبقى بسعره. ⚠️ الأسعار صافية قبل الضريبة (docMath.ts).
 *
 * ماء: القارورة أساسٌ بسعر ٢، والكرتون ٢٤ رئيسيٌّ بسعرٍ محدَّد ٤٥، و«الجملة» ثابتٌ له 4.166667 للقارورة (الكرتون ١٠٠) و«من ١٠
 * كراتين» ٩٠ للكرتون. عصير: كرتون ١٢ بلا سعرٍ محدَّد (٣٦) وخصم ١٠٪ على فئته. سكر: زيادة ٢٠٪ على كل الأصناف ١٠–٢٠ نوفمبر.
 */
const water: SalePick = {
  id: 'p1', name: 'ماء', unit: 'قارورة', basePrice: 2, taxPct: 15, categoryId: 'c-water', primaryUnitId: 'u-ctn', baseConvertedAt: null,
  units: [{ id: 'u-ctn', name: 'كرتون', factor: 24, price: 45, isActive: true }],
  listPrices: [{ priceListId: 'l-whole', price: 4.166667 }],
};
const juice: SalePick = {
  id: 'p2', name: 'عصير', unit: 'علبة', basePrice: 3, taxPct: 15, categoryId: 'c-juice', primaryUnitId: 'u-jc', baseConvertedAt: null,
  units: [{ id: 'u-jc', name: 'كرتون', factor: 12, price: null, isActive: true }], listPrices: [],
};
const sugar: SalePick = { id: 'p3', name: 'سكر', unit: 'كيس', basePrice: 7.5, taxPct: 15, categoryId: null, listPrices: [] };
const [bottle, carton] = unitChoices(water);
const [, jCarton] = unitChoices(juice);
const catalog = { p1: water, p2: juice, p3: sugar };

const R = (r: Partial<DocPriceRule> & Pick<DocPriceRule, 'id' | 'scope' | 'kind'>): DocPriceRule => ({
  priceListId: 'l-whole', productId: null, categoryId: null, basePrice: null, primaryPrice: null, percent: null, minQty: 0,
  startsOn: null, endsOn: null, updatedAt: '2026-11-01T00:00:00.000Z', ...r,
});
const RULES: DocPriceRule[] = [
  R({ id: 'r-cat', scope: 'category', categoryId: 'c-juice', kind: 'percent', percent: 10 }),
  R({ id: 'r-qty', scope: 'product', productId: 'p1', kind: 'fixed', basePrice: 3.75, minQty: 10 }),
  R({ id: 'r-date', scope: 'all', kind: 'percent', percent: -20, startsOn: '2026-11-10', endsOn: '2026-11-20' }),
];
const priceOf = docLinePricerOf({ listId: 'l-whole', custRows: null, rules: RULES, day: '2026-11-05' });
const prices = (ls: { unitPrice: number; refPrice?: number }[]) => ls.map(l => [l.unitPrice, l.refPrice]);

test('الحد الأدنى للكمية: نقرة الإضافة وزيادة الكمية تعيدان بنود الصنف بشريحته — والنزول تحت الحدّ يعيد السعر الثابت', () => {
  let ls = addInvoiceLine([], water, carton, priceOf);
  assert.deepEqual(prices(ls), [[100, 100]], 'كرتونٌ واحد بسعر القائمة الثابت صافياً');
  ls = stepInvoiceLine(ls, 'p1:u-ctn', 8, catalog, priceOf);
  assert.deepEqual(prices(ls), [[100, 100]], '٩ كراتين');
  // النقرة العاشرة على الصنف نفسه (زيادةٌ على البند القائم) ⇒ ١٠ كراتين: ٩٠
  ls = addInvoiceLine(ls, water, carton, priceOf);
  assert.deepEqual(ls.map(l => [lineKey(l), l.qty, l.unitPrice, l.refPrice]), [['p1:u-ctn', 10, 90, 90]]);
  assert.equal(invoiceTotals(ls, 0).total, 1035, '٩٠٠ صافياً + ١٥٪ — الضريبة فوق الصافي مرّةً واحدة');
  // قارورةٌ بعدها بندٌ جديد بسعر الشريحة نفسها (كمية الصنف كلّه)
  ls = addInvoiceLine(ls, water, bottle, priceOf);
  assert.deepEqual(prices(ls), [[90, 90], [3.75, 3.75]]);
  assert.equal(productBaseQty(ls, 'p1'), 241);
  // − كرتون ⇒ ٢١٧ قارورة: الكرتون والقارورة يعودان إلى السعر الثابت
  ls = stepInvoiceLine(ls, 'p1:u-ctn', -1, catalog, priceOf);
  assert.deepEqual(prices(ls), [[100, 100], [4.1667, 4.1667]]);
});

test('تغيّر الكمية يُبقي السعر المعدَّل يدويّاً ويُحدّث مرجعه وحده', () => {
  let ls = stepInvoiceLine(addInvoiceLine([], water, carton, priceOf), 'p1:u-ctn', 9, catalog, priceOf);
  assert.deepEqual(prices(ls), [[90, 90]]);
  ls = addInvoiceLine(ls, water, bottle, priceOf);
  // المستخدم كتب سعر الكرتون ٩٥ بيده
  ls = ls.map(l => (lineKey(l) === 'p1:u-ctn' ? { ...l, unitPrice: 95 } : l));
  ls = stepInvoiceLine(ls, 'p1:u-ctn', -1, catalog, priceOf);
  assert.deepEqual(prices(ls), [[95, 100], [4.1667, 4.1667]], 'المعدَّل يبقى ٩٥ ومرجعه يتبع، والقارورة التي لم تُمسّ تُعاد');
  // وعودة الكمية فوق الحدّ لا تمسّه كذلك
  ls = stepInvoiceLine(ls, 'p1:u-ctn', 1, catalog, priceOf);
  assert.deepEqual(prices(ls), [[95, 90], [3.75, 3.75]]);
});

test('تبديل الوحدة والحذف يغيّران كمية الصنف بالأساس فيُعاد تسعير بنوده', () => {
  // ١٠ قوارير ⇒ تبديلها إلى كرتون = ١٠ كراتين (٢٤٠): ٩٠
  let ls = stepInvoiceLine(addInvoiceLine([], water, bottle, priceOf), 'p1:', 9, catalog, priceOf);
  assert.deepEqual(prices(ls), [[4.1667, 4.1667]]);
  ls = setInvoiceLineUnit(ls, 'p1:', water, carton, priceOf);
  assert.deepEqual(ls.map(l => [lineKey(l), l.qty, l.unitPrice, l.refPrice]), [['p1:u-ctn', 10, 90, 90]]);
  // ٩ كراتين و٢٤ قارورة = ٢٤٠ ⇒ ٩٠ و3.75؛ حذف القارورة ⇒ ٢١٦: الكرتون ١٠٠
  ls = stepInvoiceLine(ls, 'p1:u-ctn', -1, catalog, priceOf);
  ls = stepInvoiceLine(addInvoiceLine(ls, water, bottle, priceOf), 'p1:', 23, catalog, priceOf);
  assert.deepEqual(prices(ls), [[90, 90], [3.75, 3.75]]);
  ls = removeInvoiceLine(ls, 'p1:', catalog, priceOf);
  assert.deepEqual(ls.map(l => [lineKey(l), l.unitPrice, l.refPrice]), [['p1:u-ctn', 100, 100]]);
  // بلا مسعِّر: الحذف والخطوة كما كانا حرفاً
  assert.deepEqual(removeInvoiceLine(ls, 'p1:u-ctn'), []);
  assert.equal(stepInvoiceLine(ls, 'p1:u-ctn', 1)[0].unitPrice, 100);
});

test('قاعدة الفئة والنسبة والفترة في بنود الجوال، وتلميح القائمة بالسعر كما سيُضاف', () => {
  assert.equal(invoiceLine(juice, jCarton, priceOf).unitPrice, 32.4, 'كرتون العصير ٣٦ − ١٠٪');
  assert.equal(invoiceLine(sugar, unitChoices(sugar)[0], priceOf).unitPrice, 7.5, 'خارج الفترة');
  const midMonth = docLinePricerOf({ listId: 'l-whole', custRows: null, rules: RULES, day: '2026-11-15' });
  assert.equal(invoiceLine(sugar, unitChoices(sugar)[0], midMonth).unitPrice, 9, 'زيادة ٢٠٪ في الفترة');
  // تبديل يوم الفاتورة (المسعِّر) يعيد ما لم يُمسّ
  const ls = [invoiceLine(sugar, unitChoices(sugar)[0], priceOf), { ...invoiceLine(juice, jCarton, priceOf), unitPrice: 30 }];
  const moved = repriceInvoiceLines(ls, catalog, midMonth);
  assert.deepEqual(prices(moved), [[9, 9], [30, 32.4]]);
  // تلميح قائمة الأصناف: ٩ كراتين في البنود ⇒ الكرتون التالي بـ٩٠ (كمية الصنف بعد الإضافة)، والقارورة 4.1667
  const nine = stepInvoiceLine(addInvoiceLine([], water, carton, priceOf), 'p1:u-ctn', 8, catalog, priceOf);
  assert.equal(addedLinePrice(nine, water, carton, priceOf), 90);
  assert.equal(addedLinePrice(nine, water, bottle, priceOf), 4.1667);
  assert.equal(addedLinePrice([], water, carton, priceOf), 100);
  assert.equal(addedLinePrice([], water, carton), 45, 'بلا مسعِّر: سعر الوحدة كما كان');
});

test('وحداتٌ تغيّرت (UNIT_INVALID): المعامل الجديد يغيّر كمية الصنف فيُعاد البند المحدَّث وبنود الصنف الأخرى التي لم تُمسّ', () => {
  // ٥ كراتين (١٢٠) و١٢٠ قارورة = ٢٤٠ ⇒ ٩٠ و3.75
  let ls = addInvoiceLine([], water, carton, priceOf);
  ls = stepInvoiceLine(ls, 'p1:u-ctn', 4, catalog, priceOf);
  ls = stepInvoiceLine(addInvoiceLine(ls, water, bottle, priceOf), 'p1:', 119, catalog, priceOf);
  assert.deepEqual(prices(ls), [[90, 90], [3.75, 3.75]]);
  // الكرتون صار ٤٨: ٥ كراتين = ٢٤٠ + ١٢٠ = ٣٦٠ قارورة = ٧٫٥ كرتون (الرئيسية ٤٨) < ١٠ ⇒ السعر الثابت للكرتون الجديد والقارورة
  const bigger: SalePick = { ...water, units: [{ id: 'u-ctn', name: 'كرتون', factor: 48, price: 45, isActive: true }] };
  const r = refreshInvoiceLines(ls, bigger, priceOf);
  assert.deepEqual(r.map(l => [l.unitFactor, l.unitPrice, l.refPrice]), [[48, 200, 200], [1, 4.1667, 4.1667]]);
  assert.equal(refreshInvoiceLines(r, bigger, priceOf), r, 'بلا تغيير ⇒ القائمة نفسها');
});

test('شركةٌ بلا قوائم: المسعِّر بلا قائمة ولا قواعد يطابق شكل ما قبل القواعد (priceOverrideOf) حرفاً، والكمية لا تغيّر شيئاً', () => {
  const cust = [{ productId: 'p1', price: 3, unit: 'قارورة', baseConvertedAt: null }];
  for (const listId of [null, 'l-whole']) {
    for (const custRows of [null, cust]) {
      const pr = docLinePricerOf({ listId, custRows, rules: null, day: '2026-11-15' });
      for (const p of [water, juice, sugar]) {
        for (const c of unitChoices(p)) {
          const old = invoiceLine(p, c, priceOverrideOf(p, listId, custRows));
          assert.deepEqual(invoiceLine(p, c, pr), old, `${listId} ${p.id} ${c.name}`);
        }
      }
      let a = addInvoiceLine([], water, carton, pr);
      let b = addInvoiceLine([], water, carton, priceOverrideOf(water, listId, custRows));
      for (let i = 0; i < 12; i++) {
        a = addInvoiceLine(a, water, carton, pr);
        b = addInvoiceLine(b, water, carton, priceOverrideOf(water, listId, custRows));
      }
      assert.deepEqual(stepInvoiceLine(a, 'p1:u-ctn', 5, catalog, pr), stepInvoiceLine(b, 'p1:u-ctn', 5));
    }
  }
});
