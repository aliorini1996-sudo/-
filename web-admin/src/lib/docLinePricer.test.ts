import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docBaseQty, docLinePricerOf, repriceDocLines, rulesOfList, type DocPriceRule, type DocPricedProduct } from './invoiceModalRepPrice';
import { priceOverrides, suggestedNetOf } from './priceLists';
import { pricingDayOf } from './priceListPricing';
import { todayLocal } from './shelfLife';
import { unitChoices, type CustPriceInput } from '../rep/repUnits';

/**
 * «قوائم الأسعار» بقواعدها (طلب المالك ٥ نوفمبر ٢٠٢٦) — المسعِّر الواحد لفاتورة الإدارة و/m (docLinePricerOf): سعر العميل الخاص ⇐
 * القائمة (سعر الصنف الثابت فيها وقواعدها بكمية الصنف في الفاتورة كلّها ويوم الفاتورة) ⇐ سلّم اليوم، ⚠️ صافياً قبل الضريبة.
 *
 * ماء: القارورة أساسٌ بسعر ٢، والكرتون ٢٤ رئيسيٌّ بسعرٍ محدَّد ٤٥، و«الجملة» ثابتٌ له 4.166667 للقارورة (الكرتون ١٠٠).
 * عصير: العلبة أساسٌ بسعر ٣، والكرتون ١٢ رئيسيٌّ بلا سعرٍ محدَّد (٣٦)، فئة العصائر. سكر: كيسٌ بسعر ٧٫٥ بلا وحدات ولا فئة.
 * قواعد «الجملة»: خصم ١٠٪ على فئة العصائر، و«من ١٠ كراتين» للماء ٩٠ للكرتون (3.75 للقارورة)، وزيادة ٢٠٪ على كل الأصناف
 * من ١٠ إلى ٢٠ نوفمبر. وقاعدة «التجزئة»: خصم ٥٠٪ على كل الأصناف — لا تمسّ فاتورةً بالجملة.
 */
const water: DocPricedProduct = {
  id: 'p1', unit: 'قارورة', basePrice: 2, categoryId: 'c-water', primaryUnitId: 'u-ctn', baseConvertedAt: null,
  units: [{ id: 'u-ctn', name: 'كرتون', factor: 24, price: 45, isActive: true }],
  listPrices: [{ priceListId: 'l-whole', price: 4.166667 }],
};
const juice: DocPricedProduct = {
  id: 'p2', unit: 'علبة', basePrice: 3, categoryId: 'c-juice', primaryUnitId: 'u-jc', baseConvertedAt: null,
  units: [{ id: 'u-jc', name: 'كرتون', factor: 12, price: null, isActive: true }], listPrices: [],
};
const sugar: DocPricedProduct = { id: 'p3', unit: 'كيس', basePrice: 7.5, categoryId: null, listPrices: [] };
const [bottle, carton] = unitChoices(water);
const [can, jCarton] = unitChoices(juice);
const [bag] = unitChoices(sugar);

const R = (r: Partial<DocPriceRule> & Pick<DocPriceRule, 'id' | 'scope' | 'kind'>): DocPriceRule => ({
  priceListId: 'l-whole', productId: null, categoryId: null, basePrice: null, primaryPrice: null, percent: null, minQty: 0,
  startsOn: null, endsOn: null, updatedAt: '2026-11-01T00:00:00.000Z', ...r,
});
const RULES: DocPriceRule[] = [
  R({ id: 'r-cat', scope: 'category', categoryId: 'c-juice', kind: 'percent', percent: 10 }),
  R({ id: 'r-qty', scope: 'product', productId: 'p1', kind: 'fixed', basePrice: 3.75, minQty: 10 }),
  R({ id: 'r-date', scope: 'all', kind: 'percent', percent: -20, startsOn: '2026-11-10', endsOn: '2026-11-20' }),
  R({ id: 'r-retail', priceListId: 'l-retail', scope: 'all', kind: 'percent', percent: 50 }),
];
const DAY = '2026-11-05';
const whole = docLinePricerOf({ listId: 'l-whole', custRows: null, rules: RULES, day: DAY });

test('شركةٌ بلا قوائم أو قائمةٌ بلا قواعد: المقترح هو suggestedNetOf(سعر العميل ?? السعر الثابت) حرفاً، والكمية لا تغيّره', () => {
  const cust: CustPriceInput[] = [{ productId: 'p1', price: 3, unit: 'قارورة', baseConvertedAt: null }];
  const odd: DocPricedProduct = { id: 'p4', unit: 'حبة', basePrice: '1.23456789' };
  for (const listId of [null, 'l-whole', 'l-retail', 'l-gone']) {
    for (const custRows of [null, [], cust]) {
      const pr = docLinePricerOf({ listId, custRows, rules: null, day: DAY });
      for (const p of [water, juice, sugar, odd]) {
        for (const c of unitChoices(p)) {
          const today = suggestedNetOf(c, p.basePrice ?? 0, priceOverrides([p], listId, custRows)[p.id]);
          for (const q of [0, 1, 24, 240, 100000]) assert.equal(pr(p, c, q), today, `${listId} ${p.id} ${c.name} ${q}`);
        }
      }
    }
  }
  // بلا قائمة: قواعد القوائم كلّها لا تمسّ الفاتورة (السعر الأساسي اختيارٌ صريح)
  const base = docLinePricerOf({ listId: null, custRows: null, rules: RULES, day: '2026-11-15' });
  assert.equal(base(sugar, bag, 1), 7.5);
  assert.equal(base(juice, jCarton, 12), 36);
  assert.equal(base(water, carton, 240), 45);
  assert.equal(base(odd, unitChoices(odd)[0], 1), 1.23456789, 'الأساس بلا تقريبٍ كما كان');
});

test('الحد الأدنى للكمية بالوحدة الرئيسية من مجموع كمية الصنف في الفاتورة (كل وحداته)', () => {
  assert.equal(whole(water, carton, 24), 100, 'كرتونٌ واحد: سعر الصنف الثابت في القائمة (4.166667 × 24 مقرَّباً)');
  assert.equal(whole(water, bottle, 24), 4.1667);
  assert.equal(whole(water, carton, 239), 100, '٢٣٩ قارورة < ١٠ كراتين');
  assert.equal(whole(water, carton, 240), 90, '١٠ كراتين ⇒ قاعدة الكمية تغلب السعر الثابت');
  assert.equal(whole(water, bottle, 240), 3.75, 'وبند القارورة من الصنف نفسه بالشريحة نفسها');
  assert.equal(whole(water, carton, 2400), 90);
});

test('قاعدة الفئة بنسبة من سعر البند بلا قائمة — والنسبة من سعر الوحدة المحدَّد إن كان', () => {
  assert.equal(whole(juice, jCarton, 12), 32.4, 'كرتون العصير ٣٦ − ١٠٪');
  assert.equal(whole(juice, can, 1), 2.7);
  // صنفٌ خارج الفئة لا يمسّه خصمها
  assert.equal(whole(sugar, bag, 1), 7.5);
  // «التجزئة»: خصم ٥٠٪ على كل الأصناف — الكرتون من سعره المحدَّد ٤٥ كحارس الخادم (unitPriceOf)
  const retail = docLinePricerOf({ listId: 'l-retail', custRows: null, rules: RULES, day: DAY });
  assert.equal(retail(water, carton, 24), 22.5);
  assert.equal(retail(water, bottle, 1), 1);
  assert.equal(retail(sugar, bag, 1), 3.75);
  assert.equal(retail(juice, jCarton, 12), 18, 'قاعدة فئة «الجملة» لا تمسّ «التجزئة»');
});

test('فترة الصلاحية بيوم الفاتورة شاملاً الطرفين — والأخصّ يغلب العرض المؤقت على كل الأصناف', () => {
  const on = (day: string) => docLinePricerOf({ listId: 'l-whole', custRows: null, rules: RULES, day });
  assert.equal(on('2026-11-09')(sugar, bag, 1), 7.5);
  assert.equal(on('2026-11-10')(sugar, bag, 1), 9, 'زيادة ٢٠٪ من أول يوم');
  assert.equal(on('2026-11-15')(sugar, bag, 1), 9);
  assert.equal(on('2026-11-20')(sugar, bag, 1), 9, 'وآخر يوم');
  assert.equal(on('2026-11-21')(sugar, bag, 1), 7.5);
  assert.equal(on('2026-11-15')(juice, jCarton, 12), 32.4, 'قاعدة الفئة أخصّ من كل الأصناف');
  assert.equal(on('2026-11-15')(water, carton, 24), 100, 'وسعر الصنف الثابت أخصّ منهما');
  // يوم الفاتورة: التاريخ المختار (إصدارٌ قديم) وإلا اليوم على الجهاز
  assert.equal(pricingDayOf('2026-11-15'), '2026-11-15');
  assert.equal(pricingDayOf('2026-11-15T10:00:00.000Z'), '2026-11-15');
  assert.equal(pricingDayOf(''), todayLocal());
});

test('سعر العميل الخاص يغلب القائمة وقواعدها كلّها، وتقريب أربع منازل حين يأتي السعر من العميل أو القائمة وحدهما', () => {
  const cust: CustPriceInput[] = [{ productId: 'p1', price: 3, unit: 'قارورة', baseConvertedAt: null }];
  const pr = docLinePricerOf({ listId: 'l-whole', custRows: cust, rules: RULES, day: '2026-11-15' });
  assert.equal(pr(water, carton, 2400), 72, 'لا شريحة الكمية ولا السعر الثابت');
  assert.equal(pr(water, bottle, 1), 3);
  assert.equal(pr(sugar, bag, 1), 9, 'صنفٌ بلا سعر عميل يأخذ القائمة');
  // نسبةٌ تُخرج كسوراً طويلة ⇒ أربع منازل؛ وبلا ما ينطبق ⇒ choiceNet كما كان (بلا تقريب)
  const p: DocPricedProduct = { id: 'p4', unit: 'حبة', basePrice: 2.0413 };
  const odd = [R({ id: 'r-odd', priceListId: 'l-odd', scope: 'all', kind: 'percent', percent: 3, minQty: 5 })];
  const prOdd = docLinePricerOf({ listId: 'l-odd', custRows: null, rules: odd, day: DAY });
  assert.equal(prOdd(p, unitChoices(p)[0], 5), 1.9801, '2.0413 × 0.97 = 1.980061');
  assert.equal(prOdd(p, unitChoices(p)[0], 4), 2.0413, 'القاعدة لا تنطبق ⇒ السعر كما كان حرفاً');
});

test('قواعد قائمة الفاتورة وحدها، وسعر قاعدة الصنف يُعاد إلى أساسه الحالي إن قُرئ قبل تحويله', () => {
  assert.deepEqual(rulesOfList(RULES, 'l-retail').map(r => r.id), ['r-retail']);
  assert.deepEqual(rulesOfList(RULES, null), []);
  assert.deepEqual(rulesOfList(null, 'l-whole'), []);
  // ردٌّ تالف (ليس مصفوفة) لا يكسر النافذة: لا قواعد فيبقى السعر الثابت وسلّم اليوم
  const broken = docLinePricerOf({ listId: 'l-whole', custRows: { x: 1 } as unknown as CustPriceInput[], rules: 'oops' as unknown as DocPriceRule[], day: DAY });
  assert.equal(broken(water, carton, 240), 100);
  assert.equal(broken(juice, jCarton, 12), 36);
  // الماء حُوِّل إلى القارورة بعد قراءة قاعدةٍ سعرها لكرتونٍ كان أساساً (٩٦): ٩٦ ÷ ٢٤ = ٤ للقارورة، لا ٩٦ للقارورة
  const conv: DocPricedProduct = { ...water, baseConvertedAt: '2026-10-30T10:00:00.000Z', listPrices: [] };
  const fixed = (r: Partial<DocPriceRule>) => [R({ id: 'r-p', scope: 'product', productId: 'p1', kind: 'fixed', ...r })];
  const at = (rules: DocPriceRule[]) => docLinePricerOf({ listId: 'l-whole', custRows: null, rules, day: DAY });
  const old = at(fixed({ basePrice: 96, unit: 'كرتون', baseConvertedAt: null }));
  assert.equal(old(conv, bottle, 1), 4);
  assert.equal(old(conv, carton, 24), 96);
  // قُرئت على الأساس الحالي ⇒ كما هي؛ وصفٌّ بلا حقبة الأساس (الخادم لم يرسلها) كما هو
  assert.equal(at(fixed({ basePrice: 4, unit: 'قارورة', baseConvertedAt: '2026-10-30T10:00:00.000Z' }))(conv, carton, 24), 96);
  assert.equal(at(fixed({ basePrice: 4 }))(conv, carton, 24), 96);
  // أساسٌ لا يُعرف (وحدةٌ ليست للصنف) ⇒ تسقط القاعدة فيُكمل سلّم اليوم — لا سعرٌ بمعاملٍ خاطئ
  assert.equal(at(fixed({ basePrice: 4, unit: 'طبلية', baseConvertedAt: null }))(conv, carton, 24), 45);
});

/** بند المحرّر كما في نافذة الإدارة (InvoiceModal) */
type L = { productId: string; unitId: string | null; qty: number; unitFactor: number; unitPrice: number; refPrice: number; lineTotal: number };
const catalog = new Map([[water.id, water], [juice.id, juice]]);
const reprice = (ls: L[], pr = whole) => repriceDocLines(ls, id => catalog.get(id), pr, (l, price) => ({ ...l, unitPrice: price, lineTotal: price * l.qty }));
const line = (p: DocPricedProduct, unitId: string | null, qty: number, unitFactor: number, unitPrice: number, refPrice = unitPrice): L =>
  ({ productId: p.id, unitId, qty, unitFactor, unitPrice, refPrice, lineTotal: unitPrice * qty });

test('تغيّر الكمية يعيد تسعير بنود الصنف التي لم تُمسّ، والمعدَّل يدويّاً يبقى بسعره ويتبع مرجعه وحده', () => {
  // ٩ كراتين و٢٣ قارورة = ٢٣٩ (أقلّ من ١٠ كراتين) — والقارورة عُدّل سعرها يدويّاً إلى ٤
  const lines = [line(water, 'u-ctn', 9, 24, 100), line(water, null, 23, 1, 4, 4.1667), line(juice, 'u-jc', 2, 12, 32.4)];
  assert.equal(docBaseQty(lines).get('p1'), 239);
  assert.equal(reprice(lines), lines, 'لا تغيّر ⇒ المصفوفة نفسها');
  // قارورةٌ أخرى ⇒ ٢٤٠ = ١٠ كراتين: الكرتون الذي لم يُمسّ ٩٠، والقارورة المعدَّلة ٤ ومرجعها 3.75، والعصير كما هو
  const up = reprice(lines.map((l, i) => (i === 1 ? { ...l, qty: 24 } : l)));
  assert.deepEqual(up.map(l => [l.unitPrice, l.refPrice]), [[90, 90], [4, 3.75], [32.4, 32.4]]);
  assert.equal(up[0].lineTotal, 810);
  assert.equal(up[2], lines[2]);
  // والعودة تحت الحدّ تعيد السعر الثابت
  const down = reprice(up.map((l, i) => (i === 0 ? { ...l, qty: 8 } : l)));
  assert.deepEqual(down.map(l => [l.unitPrice, l.refPrice]), [[100, 100], [4, 4.1667], [32.4, 32.4]]);
  // كميةٌ صفرٌ أو تالفة لا تُحسب، وصنفٌ لا يُعرف أو وحدةٌ لم تعد له كما هو
  assert.equal(docBaseQty([line(water, null, 0, 1, 2), line(water, 'u-ctn', Number.NaN, 24, 45)]).get('p1'), undefined);
  const stray = [line(sugar, null, 1, 1, 7.5), line(water, 'u-gone', 1, 24, 50)];
  assert.equal(reprice(stray), stray);
});
