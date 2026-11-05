import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  docLinePricerOf, docPricingDayOf, docQtyKey, pickOptionsAtQty, repriceDocLines, rulesOfList, ruleOnDay,
  type DocPriceRule, type DocPricedProduct,
} from './invoiceModalRepPrice';
import { listPriceMap } from './priceLists';
import { roundHalfUp } from './money';
import { lineNetWithList, listResultFor, type PricedProduct } from './priceListPricing';
import { todayLocal } from './shelfLife';
import { rebaseCustPrices, unitChoices, type CustPriceInput } from '../rep/repUnits';

/**
 * مراجعة D5 (أداء المسعِّر) وD1 (يوم التسعير في الإدارة و/m) — المسعِّر الجديد يقيّم الحلّ مرّةً لكل نداء، ويُسقط قواعد خارج اليوم مرّةً،
 * ويحفظ ما يخصّ كل صنف، ويتشارك ناتج أصنافٍ بلا قاعدة صنفٍ ولا سعرٍ ثابت (فئتها ورئيسيّتها) — **والناتج حرفاً ما كان يحسبه**:
 * المرجع أدناه هو المسعِّر القديم نفسه (lineNetWithList ثم listResultFor للتقريب) بقواعد القائمة كلّها بلا فهرسٍ ولا ذاكرة.
 */

// ═══ الكتالوج ═══
const water: DocPricedProduct = {
  id: 'p-water', unit: 'قارورة', basePrice: 2, categoryId: 'c-water', primaryUnitId: 'u-ctn', baseConvertedAt: null,
  units: [{ id: 'u-ctn', name: 'كرتون', factor: 24, price: 45, isActive: true }],
  listPrices: [{ priceListId: 'l-whole', price: 4.166667 }],
};
const juice: DocPricedProduct = {
  id: 'p-juice', unit: 'علبة', basePrice: 3, categoryId: 'c-juice', primaryUnitId: 'u-jc', baseConvertedAt: null,
  units: [{ id: 'u-jc', name: 'كرتون', factor: 12, price: null, isActive: true }], listPrices: [],
};
// فئة العصير نفسها ورئيسيّته نفسها (١٢) بسعرٍ آخر: تتشارك ناتج القائمة مع العصير، وسعره يُحسب من أساسه هو
const juice2: DocPricedProduct = {
  id: 'p-juice2', unit: 'علبة', basePrice: 3.3, categoryId: 'c-juice', primaryUnitId: 'u-j2', baseConvertedAt: null,
  units: [{ id: 'u-j2', name: 'كرتون', factor: 12, price: 40, isActive: true }],
};
// الفئة نفسها ورئيسيّة ٦: سعر الفئة الثابت للرئيسية ÷ ٦ لا ÷ ١٢ — لا يتشارك مع العصير
const juice6: DocPricedProduct = {
  id: 'p-juice6', unit: 'علبة', basePrice: 3, categoryId: 'c-juice', primaryUnitId: 'u-j6', baseConvertedAt: null,
  units: [{ id: 'u-j6', name: 'شدّة', factor: 6, price: null, isActive: true }, { id: 'u-j24', name: 'كرتون', factor: 24, price: 70, isActive: true }],
};
const sugar: DocPricedProduct = { id: 'p-sugar', unit: 'كيس', basePrice: 7.5, categoryId: null, listPrices: [] };
const salt: DocPricedProduct = { id: 'p-salt', unit: 'كيس', basePrice: 1.1, listPrices: [{ priceListId: 'l-retail', price: 0.9 }] };
const odd: DocPricedProduct = { id: 'p-odd', unit: 'حبة', basePrice: '1.23456789', categoryId: 'c-juice' };
// سعرٌ ثابت في القائمة لصنفٍ في فئةٍ لها قواعد: الأخصّ (سعر الصنف) يغلب قواعد الفئة وكل الأصناف
const juiceItem: DocPricedProduct = {
  id: 'p-juice-item', unit: 'علبة', basePrice: 3, categoryId: 'c-juice', primaryUnitId: 'u-ji', baseConvertedAt: null,
  units: [{ id: 'u-ji', name: 'كرتون', factor: 12, price: null, isActive: true }],
  listPrices: [{ priceListId: 'l-whole', price: 2.8 }, { priceListId: 'l-retail', price: 2.9 }],
};
// سعرٌ ثابت سالب (صفٌّ تالف) لا يعدّه الحلّ سعراً: القواعد تحكم
const negItem: DocPricedProduct = { id: 'p-neg', unit: 'حبة', basePrice: 4, categoryId: 'c-juice', listPrices: [{ priceListId: 'l-whole', price: -1 }] };
// صنفٌ بمعرّفٍ فارغ: صفّ سعره الثابت لا يصلح في الحلّ (بلا معرّف صنف) إلا حين لا قاعدة أصلاً
const noId: DocPricedProduct = { id: '', unit: 'حبة', basePrice: 6, categoryId: 'c-juice', listPrices: [{ priceListId: 'l-whole', price: 5 }, { priceListId: 'l-gone', price: 5 }] };
const CATALOG = [water, juice, juice2, juice6, sugar, salt, odd, juiceItem, negItem, noId];

const R = (r: Partial<DocPriceRule> & Pick<DocPriceRule, 'id' | 'scope' | 'kind'>): DocPriceRule => ({
  priceListId: 'l-whole', productId: null, categoryId: null, basePrice: null, primaryPrice: null, percent: null, minQty: 0,
  startsOn: null, endsOn: null, updatedAt: '2026-11-01T00:00:00.000Z', ...r,
});
const RULES: DocPriceRule[] = [
  R({ id: 'r-cat', scope: 'category', categoryId: 'c-juice', kind: 'percent', percent: 10 }),
  R({ id: 'r-cat-fixed', scope: 'category', categoryId: 'c-juice', kind: 'fixed', primaryPrice: 30, minQty: 5 }),
  R({ id: 'r-qty', scope: 'product', productId: 'p-water', kind: 'fixed', basePrice: 3.75, minQty: 10 }),
  R({ id: 'r-date', scope: 'all', kind: 'percent', percent: -20, startsOn: '2026-11-10', endsOn: '2026-11-20' }),
  R({ id: 'r-month', scope: 'all', kind: 'percent', percent: 5, minQty: 2, startsOn: '2026-11-01', endsOn: '2026-11-30' }),
  R({ id: 'r-sugar', scope: 'product', productId: 'p-sugar', kind: 'percent', percent: 15, startsOn: '2026-11-04', endsOn: '2026-11-06' }),
  // قاعدة صنفٍ بحدٍّ أدنى بلا سعرٍ ثابت: تحت الحدّ تحكم قواعد فئته (خصم ١٠٪) وفوقه تغلبها
  R({ id: 'r-odd-min', scope: 'product', productId: 'p-odd', kind: 'fixed', basePrice: 1, minQty: 50 }),
  // صفوفٌ تالفة يرفضها الحلّ كما كان (سعرٌ ثابت لكل الأصناف، ويومٌ غير صحيح)
  R({ id: 'r-bad-all', scope: 'all', kind: 'fixed', basePrice: 1 }),
  R({ id: 'r-bad-day', scope: 'all', kind: 'percent', percent: 50, startsOn: '2026-1-1' }),
  R({ id: 'r-retail', priceListId: 'l-retail', scope: 'all', kind: 'percent', percent: 50 }),
  R({ id: 'r-retail-cat', priceListId: 'l-retail', scope: 'category', categoryId: 'c-juice', kind: 'percent', percent: -10, minQty: 3 }),
];

/** المسعِّر القديم حرفاً (قبل مراجعة D5) بقواعد القائمة كلّها: الحلّ يفرز الصنف والفئة بنفسه — المرجع الذي يُقاس به الجديد */
const legacyPricer = (listId: string | null, custRows: CustPriceInput[] | null, rules: DocPriceRule[] | null, day: string) =>
  (p: DocPricedProduct, c: ReturnType<typeof unitChoices>[number], q: number): number => {
    const mine = (custRows ?? []).filter(r => r.productId === p.id);
    const cust = mine.length ? rebaseCustPrices(mine, [p])[p.id] : undefined;
    const item = listId ? listPriceMap([p], listId)[p.id] : undefined;
    const rs = rulesOfList(rules, listId);
    const pp: PricedProduct = { id: p.id, basePrice: p.basePrice ?? 0, categoryId: p.categoryId ?? null, primaryUnitId: p.primaryUnitId ?? null, units: p.units ?? null };
    const net = lineNetWithList(c, pp, cust, item, rs, q, day);
    const fromCust = cust != null && Number.isFinite(Number(cust));
    return fromCust || listResultFor(pp, item, rs, q, day) !== null ? roundHalfUp(net, 4) : net;
  };

const DAYS = ['2026-10-31', '2026-11-01', '2026-11-04', '2026-11-05', '2026-11-10', '2026-11-20', '2026-11-21', '2026-12-01'];
const QTYS = [0, 1, 5, 6, 12, 23, 24, 29, 30, 59, 60, 72, 239, 240, 2400, -1, -24, Number.NaN, Number.POSITIVE_INFINITY];

test('المسعِّر الجديد = القديم حرفاً: كل قائمة وكل يوم وكل كمية (سالبة وتالفة) وكل وحدة، بذاكرةٍ واحدة في الاتجاهين', () => {
  const cust: CustPriceInput[] = [
    { productId: 'p-water', price: 3, unit: 'قارورة', baseConvertedAt: null },
    { productId: 'p-juice2', price: 2.5, unit: 'علبة', baseConvertedAt: null },
  ];
  let n = 0;
  for (const listId of [null, 'l-whole', 'l-retail', 'l-gone']) {
    for (const custRows of [null, cust]) {
      for (const rules of [null, RULES]) {
        for (const day of DAYS) {
          const fresh = docLinePricerOf({ listId, custRows, rules, day });
          const old = legacyPricer(listId, custRows, rules, day);
          // المسعِّر نفسه يُسأل صعوداً ثم نزولاً: الذاكرة لا تُرجع ناتج كميةٍ أخرى
          for (const qs of [QTYS, [...QTYS].reverse()]) {
            for (const p of CATALOG) {
              for (const c of unitChoices(p)) {
                for (const q of qs) {
                  assert.equal(fresh(p, c, q), old(p, c, q), `${listId} ${custRows ? 'cust' : '-'} ${rules ? 'rules' : '-'} ${day} ${p.id} ${c.name} ${q}`);
                  n++;
                }
              }
            }
          }
        }
      }
    }
  }
  assert.ok(n > 10_000);
});

test('أصناف الفئة نفسها: الناتج المشترك بالفئة والرئيسية وحدهما — سعر الفئة الثابت للرئيسية ÷ معاملها لكل صنف', () => {
  const pr = docLinePricerOf({ listId: 'l-whole', custRows: null, rules: RULES, day: '2026-11-05' });
  const [, jCtn] = unitChoices(juice);
  const [can2, jCtn2] = unitChoices(juice2);
  const [can6, pack6] = unitChoices(juice6);
  // ٥ كراتين (٦٠ علبة) ⇒ سعر الفئة الثابت ٣٠ للكرتون: ٢٫٥ للعلبة لكلا الصنفين (رئيسيّة ١٢)
  assert.equal(pr(juice, jCtn, 60), 30);
  assert.equal(pr(juice2, jCtn2, 60), 30);
  assert.equal(pr(juice2, can2, 60), 2.5);
  // رئيسيّة ٦: ٥ شدّات = ٣٠ علبة ⇒ ٣٠ للشدّة = ٥ للعلبة — لا ٢٫٥ من ناتج العصير
  assert.equal(pr(juice6, pack6, 30), 30);
  assert.equal(pr(juice6, can6, 30), 5);
  // تحت الحدّ: خصم الفئة ١٠٪ من سعر كلٍّ بلا قائمة (العصير ٣٦، العصير٢ كرتونه المحدَّد ٤٠)
  assert.equal(pr(juice, jCtn, 12), 32.4);
  assert.equal(pr(juice2, jCtn2, 12), 36);
});

/** قاعدةٌ تُعدّ قراءات نسبتها — لا يقرأها إلا الحلّ (usable ثم الناتج)، فعددها عدد تقييمات الحلّ لها */
function counted(r: DocPriceRule, hit: { reads: number }): DocPriceRule {
  const { percent, ...rest } = r;
  return Object.defineProperty({ ...rest }, 'percent', { enumerable: true, get() { hit.reads++; return percent; } }) as DocPriceRule;
}

test('الحلّ يُقيَّم مرّةً واحدة لكل نداء (كان مرّتين)، ومرّةً لكل صنفٍ وكمية في عمر المسعِّر — وبلا حدٍّ أدنى للكمية لا كمية', () => {
  const hit = { reads: 0 };
  const rules = [counted(R({ id: 'r-all', scope: 'all', kind: 'percent', percent: 10 }), hit)];
  const pr = docLinePricerOf({ listId: 'l-whole', custRows: null, rules, day: '2026-11-05' });
  const [bag] = unitChoices(sugar);
  assert.equal(pr(sugar, bag, 1), 6.75);
  assert.equal(hit.reads, 2, 'تقييمٌ واحد: usable ثم الناتج');
  // كمياتٌ أخرى غير سالبة: لا قاعدة بحدٍّ أدنى ⇒ الناتج نفسه بلا تقييم
  for (const q of [0, 2, 24, 1e6]) assert.equal(pr(sugar, bag, q), 6.75);
  assert.equal(hit.reads, 2);
  assert.equal(pr.dependsOnQty, false);
  // صنفٌ آخر بلا فئة ولا رئيسية ولا سعرٍ ثابت: الناتج نفسه مشترك
  const flour: DocPricedProduct = { id: 'p-flour', unit: 'كيس', basePrice: 4 };
  assert.equal(pr(flour, unitChoices(flour)[0], 3), 3.6);
  assert.equal(hit.reads, 2, 'لا تقييم ثانٍ لصنفٍ بالفئة والرئيسية نفسيهما');
  // كميةٌ سالبة: قاعدة الحدّ صفر لا تنطبق (الحلّ كما هو) — تُقيَّم وحدها ولا تُخلط بالمحفوظ
  assert.equal(pr(sugar, bag, -1), 7.5);
  assert.equal(pr(sugar, bag, 1), 6.75);
});

test('قاعدةٌ خارج يوم الفاتورة تُسقط مرّةً عند بناء المسعِّر — لا تمرّ بالحلّ أبداً، ولا تجعل الكمية تغيّر السعر', () => {
  const hit = { reads: 0 };
  const rules = [
    counted(R({ id: 'r-oct', scope: 'all', kind: 'percent', percent: 10, minQty: 5, endsOn: '2026-10-31' }), hit),
    counted(R({ id: 'r-dec', scope: 'all', kind: 'percent', percent: 10, minQty: 5, startsOn: '2026-12-01' }), hit),
  ];
  const pr = docLinePricerOf({ listId: 'l-whole', custRows: null, rules, day: '2026-11-05' });
  for (const q of [1, 5, 50]) assert.equal(pr(sugar, unitChoices(sugar)[0], q), 7.5);
  assert.equal(hit.reads, 0);
  assert.equal(pr.dependsOnQty, false, 'حدّها الأدنى خارج اليوم');
  assert.equal(docLinePricerOf({ listId: 'l-whole', custRows: null, rules, day: '2026-12-01' }).dependsOnQty, true);
  // الشرطان نفساهما في priceRuleMatches — والطرفان شاملان
  const r = R({ id: 'x', scope: 'all', kind: 'percent', percent: 1, startsOn: '2026-11-01', endsOn: '2026-11-30' });
  assert.deepEqual(['2026-10-31', '2026-11-01', '2026-11-30', '2026-12-01'].map(d => ruleOnDay(r, d)), [false, true, true, false]);
  assert.equal(ruleOnDay(R({ id: 'y', scope: 'all', kind: 'percent', percent: 1 }), '2026-11-05'), true, 'مفتوحة');
});

test('dependsOnQty: قاعدةٌ بحدٍّ أدنى في قائمة الفاتورة وحدها — شركةٌ بلا قوائم أو قائمةٌ بلا قواعد أو قاعدةٌ في قائمةٍ أخرى ⇒ false', () => {
  assert.equal(docLinePricerOf({ listId: null, custRows: null, rules: RULES, day: '2026-11-05' }).dependsOnQty, false);
  assert.equal(docLinePricerOf({ listId: 'l-whole', custRows: null, rules: null, day: '2026-11-05' }).dependsOnQty, false);
  assert.equal(docLinePricerOf({ listId: 'l-whole', custRows: null, rules: RULES, day: '2026-11-05' }).dependsOnQty, true);
  assert.equal(docLinePricerOf({ listId: 'l-retail', custRows: null, rules: RULES, day: '2026-11-05' }).dependsOnQty, true);
  const noMin = RULES.filter(r => !(Number(r.minQty) > 0));
  assert.equal(docLinePricerOf({ listId: 'l-whole', custRows: null, rules: noMin, day: '2026-11-05' }).dependsOnQty, false);
});

// ═══ الكتالوج الكبير: ١٠٠٠ صنف في ١٠ فئات و٢٠٠٠ قاعدة «كل الأصناف» سارية بحدودٍ دنيا (السيناريو الذي قاسته المراجعة بثوانٍ) ═══
const N = 1000;
const BIG: DocPricedProduct[] = Array.from({ length: N }, (_, i) => ({
  id: `p${i}`, unit: 'حبة', basePrice: 10 + (i % 7), categoryId: `c${i % 10}`, primaryUnitId: `u${i}`,
  units: [{ id: `u${i}`, name: 'كرتون', factor: 24, price: null, isActive: true }], baseConvertedAt: null,
}));
const bigRules = (hit: { reads: number }) => Array.from({ length: 2000 }, (_, i) => counted(R({
  id: `r${i}`, scope: 'all', kind: 'percent', percent: 1 + (i % 50), minQty: i % 100, startsOn: '2026-11-01', endsOn: '2026-11-30',
}), hit));

test('تلميحات المنتقي: الكتالوج مرّةً لكل مسعِّر بتقييمٍ لكل فئة، ثم حرف الكمية يعيد أصناف الفاتورة وحدها', () => {
  const hit = { reads: 0 };
  const pr = docLinePricerOf({ listId: 'l-whole', custRows: null, rules: bigRules(hit), day: '2026-11-05' });
  assert.equal(pr.dependsOnQty, true);
  const hintAt = (p: DocPricedProduct, qtyInDoc: number) => {
    const c = unitChoices(p)[1];
    return String(pr(p, c, qtyInDoc + c.factor));
  };
  const base = BIG.map(p => ({ value: p.id, hint: hintAt(p, 0) }));
  // كل صنفٍ بكرتونٍ واحد: عشر فئاتٍ برئيسيّة ٢٤ ⇒ عشرة تقييمات (٢٠٠٠ قراءةٍ لكلٍّ + الغالبة) — كان ١٠٠٠ صنف × تقييمين
  assert.equal(hit.reads, 10 * 2001);
  // حرف الكمية: البنود ثلاثة أصناف، والكتالوج لا يُعاد
  const lines = [
    { productId: 'p1', qty: 3, unitFactor: 24 }, { productId: 'p2', qty: 1, unitFactor: 1 }, { productId: 'p3', qty: 7, unitFactor: 24 },
  ];
  const before = hit.reads;
  const opts = pickOptionsAtQty(base, lines, pr.dependsOnQty, (o, q) => ({ ...o, hint: hintAt(BIG.find(p => p.id === o.value)!, q) }));
  assert.ok(hit.reads - before <= 3 * 2001, `${hit.reads - before}`);
  // والناتج ما كان يُحسب لكل صنفٍ بكميته حرفاً
  const byQty = new Map([['p1', 72], ['p2', 1], ['p3', 168]]);
  opts.forEach((o, i) => assert.equal(o.hint, hintAt(BIG[i], byQty.get(o.value) ?? 0), o.value));
  assert.equal(opts[0], base[0], 'صنفٌ ليس في الفاتورة: خياره نفسه');
  // الكمية نفسها مرّةً ثانية: محفوظةٌ بلا تقييم
  const again = hit.reads;
  pickOptionsAtQty(base, lines, pr.dependsOnQty, (o, q) => ({ ...o, hint: hintAt(BIG.find(p => p.id === o.value)!, q) }));
  assert.equal(hit.reads, again);
});

test('pickOptionsAtQty: مسعِّرٌ لا تغيّره الكمية أو فاتورةٌ فارغة ⇒ الخيارات نفسها (لا إعادة مع كل حرف)', () => {
  const base = [{ value: 'a', hint: '1' }, { value: 'b', hint: '2' }];
  const at = () => { throw new Error('لا يُعاد تسعير'); };
  assert.equal(pickOptionsAtQty(base, [{ productId: 'a', qty: 5 }], false, at), base);
  assert.equal(pickOptionsAtQty(base, [], true, at), base);
  assert.equal(pickOptionsAtQty(base, [{ productId: 'a', qty: 0 }], true, at), base, 'كميةٌ صفرٌ لا تُحسب');
  assert.deepEqual(pickOptionsAtQty(base, [{ productId: 'b', qty: 2, unitFactor: 12 }], true, (o, q) => ({ ...o, hint: `${o.hint}@${q}` })),
    [{ value: 'a', hint: '1' }, { value: 'b', hint: '2@24' }]);
  assert.equal(docQtyKey([{ productId: 'a', qty: 2, unitFactor: 12 }, { productId: 'a', qty: 3 }, { productId: 'b', qty: 1 }]), 'a:27|b:1');
});

test('repriceDocLines(…, productId): بنود الصنف الذي تغيّرت كميته وحدها تُعاد — بندٌ لصنفٍ آخر لا يُمسّ ولو قديماً', () => {
  const pr = docLinePricerOf({ listId: 'l-whole', custRows: null, rules: RULES, day: '2026-11-05' });
  const byId = new Map(CATALOG.map(p => [p.id, p]));
  type L = { productId: string; unitId: string | null; qty: number; unitFactor: number; unitPrice: number; refPrice: number };
  // الماء ١٠ كراتين (عُدّل إلى ٢٤٠ قارورة) ⇒ ٩٠؛ والعصير بسعرٍ قديم ٣٥ لم يُمسّ
  const lines: L[] = [
    { productId: 'p-water', unitId: 'u-ctn', qty: 10, unitFactor: 24, unitPrice: 100, refPrice: 100 },
    { productId: 'p-juice', unitId: 'u-jc', qty: 1, unitFactor: 12, unitPrice: 35, refPrice: 35 },
  ];
  const withPrice = (l: L, price: number) => ({ ...l, unitPrice: price });
  const one = repriceDocLines(lines, id => byId.get(id), pr, withPrice, 'p-water');
  assert.deepEqual(one.map(l => [l.unitPrice, l.refPrice]), [[90, 90], [35, 35]]);
  assert.equal(one[1], lines[1]);
  // صنفٌ لا بند له ⇒ المصفوفة نفسها؛ وبلا قيدٍ تُعاد البنود كلّها كما كانت
  assert.equal(repriceDocLines(lines, id => byId.get(id), pr, withPrice, 'p-sugar'), lines);
  assert.deepEqual(repriceDocLines(lines, id => byId.get(id), pr, withPrice).map(l => l.unitPrice), [90, 32.4]);
  assert.deepEqual(repriceDocLines(lines, id => byId.get(id), pr, withPrice, null).map(l => l.unitPrice), [90, 32.4]);
});

test('docPricingDayOf (D1): التاريخ المرسل، وإلا يوم الشركة الآن بمنطقتها — والتاريخ المخفيّ (إشعار المرحلة الثانية) لا يُقرأ', () => {
  // ٢٢:٣٠ بتوقيت غرينتش في ٥ نوفمبر = ٠١:٣٠ في الرياض يوم ٦
  const now = new Date('2026-11-05T22:30:00.000Z');
  assert.equal(docPricingDayOf('', { timezone: 'Asia/Riyadh', now }), '2026-11-06');
  assert.equal(docPricingDayOf(null, { timezone: 'Asia/Riyadh', now }), '2026-11-06');
  assert.equal(docPricingDayOf('2026-10-15', { timezone: 'Asia/Riyadh', now }), '2026-10-15', 'إصدارٌ بتاريخٍ مختار');
  // البيع بتاريخ ١٥ أكتوبر ثم التبديل إلى مرتجع المرحلة الثانية (الحقل مخفيّ ولا يُرسل): يوم الشركة الآن لا ١٥ أكتوبر
  assert.equal(docPricingDayOf('2026-10-15', { dateSent: false, timezone: 'Asia/Riyadh', now }), '2026-11-06');
  assert.equal(docPricingDayOf('2026-10-15', { dateSent: true, timezone: 'Asia/Riyadh', now }), '2026-10-15');
  // بلا منطقة (خادمٌ قبلها) أو منطقةٌ مجهولة: اليوم المحلي للجهاز كما كان
  assert.equal(docPricingDayOf('', { now }), todayLocal(now));
  assert.equal(docPricingDayOf('', { timezone: 'Mars/Olympus', now }), todayLocal(now));
  assert.equal(docPricingDayOf(''), todayLocal());
});

// ═══ حرّاس نصّية: النافذة و/m ═══
const modal = readFileSync(new URL('../components/forms/InvoiceModal.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const mobile = readFileSync(new URL('../m/MInvoiceCreate.tsx', import.meta.url), 'utf8');

test('النافذة: يوم التسعير يوم الخادم (الحقل المخفيّ لا يُقرأ)، والكتالوج مرّةً لكل مسعِّر، والكمية تعيد صنفها وحده حين تغيّر السعر', () => {
  // شرط إخفاء حقل التاريخ نفسه هو شرط إسقاطه من التسعير
  assert.ok(modal.includes('{!(isReturn && phase2) && ('));
  assert.ok(modal.includes('const pricingDay = docPricingDayOf(invoiceDate, { dateSent: !(isReturn && phase2), timezone: priceInfo?.timezone });'));
  assert.ok(modal.indexOf('const phase2 = zatcaRegimeOf(company).phase === 2;') < modal.indexOf('const pricingDay = '), 'المرحلة قبل اليوم');
  assert.equal(modal.split('const phase2 = ').length - 1, 1);
  assert.doesNotMatch(modal, /pricingDayOf\(invoiceDate\)/);
  // الكتالوج على [الأصناف، المسعِّر] وحدهما، وأصناف الفاتورة بكمياتها حين تغيّر الكمية السعر وحده
  assert.match(modal, /const catalogOptions = useMemo\(\s*\(\) => \(products \|\| \[\]\)\.map\(p => \(\{ value: p\.id, label: p\.name, hint: pickHint\(p, 0\) \}\)\),\s*\[products, pricer\],/);
  assert.ok(modal.includes("const qtyKey = pricer.dependsOnQty ? docQtyKey(lines) : '';"));
  assert.ok(modal.includes('const pickOptions = useMemo(() => pickOptionsAtQty(catalogOptions, lines, pricer.dependsOnQty, (o, qtyInDoc) => {'));
  assert.ok(modal.includes('}), [catalogOptions, qtyKey]);'));
  // خانة الكمية: بنود الصنف وحده، ولا شيء حين لا قاعدة بحدٍّ أدنى
  assert.ok(modal.includes("(field === 'qty' && pricer.dependsOnQty && productId ? repriceLines(ls, productId) : ls);"));
  assert.ok(modal.includes('}), ls[idx]?.productId));'));
  assert.ok(modal.includes('setLines(ls => repriceLines(ls.filter((_, j) => j !== i), ls[i]?.productId))'));
  assert.equal(modal.split(', p.id));').length - 1, 3, 'الإضافة (زيادةً وبنداً جديداً) وتبديل الوحدة: بنود الصنف وحده');
  // المسعِّر الجديد (قائمةٌ أو عميلٌ أو قواعد أو يوم) يعيد البنود كلّها كما كان
  assert.match(modal, /useEffect\(\(\) => \{\s*setLines\(ls => repriceLines\(ls\)\);\s*\}, \[pricer, products\]\);/);
  // الجسم كما كان: لا pricingDay من الإدارة (الخادم يقرؤه للمندوب وحده) — البيع والمرتجع الحرّ
  const sale = modal.slice(modal.indexOf('    mutation.mutate({\n      customerId, salesRepId, type'), modal.indexOf('      items: withSaleLots('));
  assert.ok(sale.length > 0);
  assert.doesNotMatch(sale, /pricingDay/);
  assert.ok(modal.includes('const base = { ...buildFreeReturnPayload(head, lines, discountPct), ...(priceListOn && { priceListId }) };'));
});

test('/m: يوم التسعير بمنطقة الشركة، وتلميحات قائمة البحث محفوظة لا تُحسب مع كل رسم', () => {
  assert.ok(mobile.includes('const pricingDay = docPricingDayOf(invoiceDate, { timezone: priceInfoQ.data?.timezone });'));
  assert.ok(mobile.includes("const pickQtyKey = priceOf.dependsOnQty === false ? '' : docQtyKey(lines);"));
  assert.match(mobile, /const pickPrices = useMemo\(\s*\(\) => pickerPrices\(lines, productsQ\.data, priceOf\),[\s\S]{0,140}\[productsQ\.data, priceOf, pickQtyKey\],/);
  assert.equal(mobile.split('pickPrices.get(p.id)').length - 1, 2);
  assert.doesNotMatch(mobile, /addedLinePrice\(/, 'لا تسعير في الرسم');
  const body = mobile.slice(mobile.indexOf('const res = await invoiceApi.create({'), mobile.indexOf('items: lines.map(l => ({'));
  assert.ok(body.length > 0);
  assert.doesNotMatch(body, /pricingDay/, 'الجسم كما كان');
});
