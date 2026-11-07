// «قوائم الأسعار» بقواعدها في تطبيق المندوب (طلب المالك ٥ نوفمبر ٢٠٢٦: نسبة خصم/زيادة، قاعدة على فئة، حدٌّ أدنى للكمية، فترة صلاحية).
// المكوّن يعتمد IndexedDB والكاميرا فلا يُرسم هنا: الدوالّ داخل CreateInvoice (inclOf، وخطوة مؤثّر إعادة التسعير، وaddLine) تُستخرج من
// المصدر حرفاً وتُترجم وتُشغَّل على المساعدات الحقيقية (lineNetWithList والحلّ المشترك lib/priceRules.ts، وrepUnits، وrepPriceLists)،
// وقرارات repPriceLists.ts تُستورد. ومرآة حارس الخادم (routes/invoices.ts) تُبنى من النسخة المشتركة نفسها لتثبيت هامش TOL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { choiceNet, lineUnitOf, rebaseCustPrices, sameUnit, unitChoices, type UnitChoice } from './repUnits';
import { roundDecimal } from './invoiceCalc';
import {
  rebaseRepRules, repBaseQtyByProduct, repListRulesOf, repPriceRulesOf, repProductBaseQty, repQtyKey, repRepriceLines, type RepPriceRule,
} from './repPriceLists';
import { lineNetWithList, listDependsOnQty } from '../lib/priceListPricing';
import { listLineRef, listPriceOf, qtyPrimaryOf } from '../lib/priceRules';
import { roundHalfUp } from '../lib/money';
import { primaryUnitOf, toBase, unitPriceOf } from '../lib/units';
import { effectiveTaxPct } from '../lib/taxMode';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const repApp = read('rep', 'RepApp.tsx');
const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  assert.ok(a >= 0, `غائب: ${from}`);
  const b = s.indexOf(to, a + from.length);
  assert.ok(b > a, `غائب بعده: ${to}`);
  return s.slice(a, b + to.length);
};
/** يترجم مقطع TypeScript من RepApp ويعيد ما يسمّيه، بالتبعيات المعطاة (الحقيقية) — الترجمة مرّةً لكل مقطع */
const transpiled = new Map<string, string>();
function compile<T>(src: string, name: string, deps: Record<string, unknown>): T {
  let js = transpiled.get(src);
  if (js === undefined) {
    js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
    transpiled.set(src, js);
  }
  return new Function(...Object.keys(deps), `${js}\nreturn ${name};`)(...Object.values(deps)) as T;
}

type Map2 = Record<string, number>;
type Incl = (p: unknown, c: UnitChoice, baseQty?: number, cust?: Map2, list?: Map2, rules?: readonly RepPriceRule[]) => number;
/** inclOf كما في CreateInvoice حرفاً — بخرائط المكوّن ويوم الرسم (priceDay: يوم الشركة، D1) وخانات العملة المعطاة */
function inclOfWith(o: { cust?: Map2; list?: Map2; rules?: readonly RepPriceRule[]; day?: string; dec?: number } = {}): Incl {
  return compile<Incl>(between(repApp, 'const inclOf = ', ';\n'), 'inclOf', {
    custPrices: o.cust ?? {}, listPrices: o.list ?? {}, listRules: o.rules ?? [], lineNetWithList, roundDecimal,
    priceDay: o.day ?? '2026-11-15', currencyDecimals: () => o.dec ?? 2, getActiveCurrency: () => 'SAR',
    // «إزالة الضريبة»: النسبة الفعلية من وضع الشركة — شركةٌ بلا العلم = نسبة الصنف كما كانت (taxOffRep.test.ts يغطّي الإزالة)
    effectiveTaxPct, company: null,
  });
}
type Line = Record<string, any>;
/**
 * خطوة مؤثّر إعادة التسعير في CreateInvoice حرفاً (repriceLines: ما يمرّره المؤثّر لـsetLines والإصدار بيوم لحظته) — الخرائط تُمرَّر
 * إلى inclOf undefined فتعمل افتراضاته (خرائط inclOfWith المعطاة)، واليوم يومه، و`floor` = مندوبٌ بلا «البيع بأقل من السعر» (D4)
 */
function repriceStep(prev: Line[], products: unknown[], inclOf: Incl, o: { day?: string; floor?: boolean } = {}): Line[] {
  return compile<(p: Line[]) => Line[]>(between(repApp, 'const repriceLines = (prev: any[], day: string = priceDay): any[] => {', '\n  };\n'), 'repriceLines', {
    repBaseQtyByProduct, repRepriceLines, products, inclOf, custPrices: undefined, listPrices: undefined, listRules: undefined,
    priceDay: o.day ?? '2026-11-15', priceFloor: o.floor === true,
  })(prev);
}
/** addLine في CreateInvoice حرفاً */
function addLineWith(inclOf: Incl): (prev: Line[], p: unknown, c0: UnitChoice) => Line[] {
  return compile(between(repApp, 'const addLine = (prev: any[], p: any, c0: UnitChoice): any[] => {', '\n  };\n'), 'addLine',
    { sameUnit, lineUnitOf, repProductBaseQty, inclOf, effectiveTaxPct, company: null });
}

// عصير: الحبّة أساسٌ بسعر ٢، والكرتون ١٢ رئيسيٌّ بلا سعرٍ محدَّد (٢٤ = الأساس × المعامل)، في فئة العصائر. وماء بلا وحدات في فئة المياه
const juice = {
  id: 'p-j', name: 'عصير', unit: 'حبة', basePrice: 2, taxPct: 15, categoryId: 'c-juice', primaryUnitId: 'u-c', baseConvertedAt: null as string | null,
  units: [{ id: 'u-c', name: 'كرتون', factor: 12, price: null as number | null, isActive: true }],
};
const water = { id: 'p-w', name: 'ماء', unit: 'قارورة', basePrice: 1, taxPct: 15, categoryId: 'c-water', units: [] as typeof juice.units, baseConvertedAt: null };
const [PIECE, CARTON] = unitChoices(juice);
const BOTTLE = unitChoices(water)[0];
const at = '2026-11-01T08:00:00.000Z';
// قواعد «سعر الجملة» كما يرسلها الخادم في /price-lists/prices (rules) — قاعدة سعر الصنف الثابت بأساس الصنف وحقبته (ضمّ الصنف)
const serverRules = [
  { id: 'r-all', priceListId: 'l-1', scope: 'all', productId: null, categoryId: null, kind: 'percent', basePrice: null, primaryPrice: null, percent: 5, minQty: 0, startsOn: null, endsOn: null, updatedAt: at },
  { id: 'r-cat', priceListId: 'l-1', scope: 'category', productId: null, categoryId: 'c-juice', kind: 'percent', basePrice: null, primaryPrice: null, percent: 10, minQty: 10, startsOn: '2026-11-01', endsOn: '2026-11-30', updatedAt: at },
  { id: 'r-prod', priceListId: 'l-1', scope: 'product', productId: 'p-j', categoryId: null, kind: 'fixed', basePrice: 1.5, primaryPrice: null, percent: null, minQty: 20, startsOn: null, endsOn: null, updatedAt: at, unit: 'حبة', baseConvertedAt: null },
  { id: 'r-wfix', priceListId: 'l-1', scope: 'category', productId: null, categoryId: 'c-water', kind: 'fixed', basePrice: null, primaryPrice: 0.8, percent: null, minQty: 0, startsOn: null, endsOn: null, updatedAt: at },
  { id: 'r-wup', priceListId: 'l-1', scope: 'product', productId: 'p-w', categoryId: null, kind: 'percent', basePrice: null, primaryPrice: null, percent: -20, minQty: 0, startsOn: '2026-12-01', endsOn: null, updatedAt: at, unit: 'قارورة', baseConvertedAt: null },
];
const rules = repPriceRulesOf(serverRules, 1_000);

// ═══ الكاش: القواعد تُقرأ من ردّ /price-lists/prices وتُخبّأ معه، والكاش الأقدم بلا قواعد = اليوم حرفاً ═══

test('repPriceRulesOf: صفّ الحلّ كما وصل (بلا تطبيع) ووقت القراءة، وأساس الصنف وحقبته حين يردّهما الخادم — والتالف يُسقط', () => {
  assert.equal(rules.length, 5);
  assert.deepEqual(rules[2], {
    id: 'r-prod', scope: 'product', kind: 'fixed', productId: 'p-j', categoryId: null, basePrice: 1.5, primaryPrice: null, percent: null,
    minQty: 20, startsOn: null, endsOn: null, updatedAt: at, unit: 'حبة', baseConvertedAt: null, seenAt: 1_000,
  });
  assert.ok(!('unit' in rules[0]) && !('baseConvertedAt' in rules[0]), 'قاعدةٌ بلا ضمّ صنف: لا مفتاح');
  // القيم كما وصلت: يومٌ تالف أو رقمٌ نصّيّ يحكم فيهما الحلّ المشترك (فيتّفق الجهاز والخادم) لا التطبيع هنا
  const raw = repPriceRulesOf([{ id: 'x', scope: 'all', kind: 'percent', percent: '7', startsOn: 20261101 }]);
  assert.equal(raw[0].percent as unknown, '7');
  assert.equal(raw[0].startsOn as unknown, 20261101);
  assert.equal(raw[0].productId, null, 'الغائب null (الحلّ يعاملهما سواءً)');
  assert.ok(!('seenAt' in raw[0]));
  assert.deepEqual(repPriceRulesOf([null, 7, { id: 1, scope: 'all', kind: 'percent' }, { id: 'y', kind: 'percent' }, { id: 'z', scope: 'all' }]), []);
  for (const old of [undefined, null, {}, 'x']) assert.deepEqual(repPriceRulesOf(old), [], `كاشٌ قديم/تالف (${String(old)})`);
});

test('listPriceRowsOf (من RepApp): القواعد في كاش \'pricelists\' مع البنود — والكاش الأقدم من الميزة بلا `rules` يُقرأ «بلا قواعد»', () => {
  const custPriceRowsOf = compile<(d: unknown, s?: number | null) => unknown[]>(between(repApp, 'const custPriceRowsOf = ', ';\n'), 'custPriceRowsOf', {});
  const listPriceRowsOf = compile<(d: unknown, s?: number | null) => Array<{ id: string; rows: unknown[]; rules: RepPriceRule[] }>>(
    between(repApp, 'const listPriceRowsOf = ', ';\n'), 'listPriceRowsOf', { custPriceRowsOf, repPriceRulesOf });
  const fresh = listPriceRowsOf([{ id: 'l-1', name: 'سعر الجملة', items: [{ productId: 'p-j', price: 1.9, unit: 'حبة', baseConvertedAt: null }], rules: serverRules }], 1_000);
  assert.deepEqual(fresh[0].rules, rules);
  const old = listPriceRowsOf([{ id: 'l-1', name: 'سعر الجملة', items: [{ productId: 'p-j', price: 1.9 }] }], 1_000);
  assert.deepEqual(old[0].rules, [], 'كاشٌ قبل الميزة');
  assert.equal(old[0].rows.length, 1);
  // ولا مسار جلبٍ جديد: القواعد تصل في الردّ نفسه (المفاتيح والطلبات كما كانت — لا طلب زائد لشركةٍ بلا قوائم)
  assert.equal((repApp.match(/repApi\.get\('\/price-lists\/prices'/g) ?? []).length, 3, 'loadPriceLists وrefreshUnits وwarmRepPriceCache');
  assert.doesNotMatch(repApp, /price-lists\/rules/);
  assert.match(repApp, /const listRules = useMemo\(\(\) => repListRulesOf\(listRows, listId, products\), \[listRows, listId, products\]\);/);
});

test('rebaseRepRules: قاعدة سعر الصنف الثابت يُعاد أساسها كبنود القائمة (÷ المعامل أو تُسقط)، والفئة والنسبة والحدّ كما هي', () => {
  const conv = '2026-10-30T10:00:00.000Z';
  // الصنف كان أساسه كرتوناً (سعر القاعدة ١٨ للكرتون) ثم حُوِّل إلى الحبّة (convert-base ×١٢) بعد كاش الجهاز
  const after = { ...juice, baseConvertedAt: conv };
  const cached = repPriceRulesOf([{ ...serverRules[2], basePrice: 18, unit: 'كرتون', baseConvertedAt: null }], Date.parse(conv) - 86_400_000);
  const r = rebaseRepRules(cached, [after]);
  assert.equal(r.length, 1);
  assert.ok(Math.abs(Number(r[0].basePrice) - 1.5) < 1e-12, 'سعر الكرتون ١٨ ÷ ١٢ — لا ١٨ للحبّة (٢١٦ للكرتون)');
  assert.equal(r[0].minQty, 20, 'الحدّ بالرئيسية لا يمسّه التحويل');
  // اسمٌ مجهول (تحويلٌ في الاتجاه الآخر أو وحدةٌ حُذفت) ⇒ تُسقط فيحكم الخادم — كبند القائمة
  assert.deepEqual(rebaseRepRules(repPriceRulesOf([{ ...serverRules[2], unit: 'طبلية', baseConvertedAt: null }]), [after]), []);
  // كاشٌ بلا unit من قبل التحويل ⇒ يُسقط (سعر الكرتون القديم)، ولصنفٍ لم يُحوَّل قطّ ⇒ كما هو حرفاً
  const noUnit = repPriceRulesOf([{ id: 'r', scope: 'product', productId: 'p-j', kind: 'fixed', basePrice: 18 }], Date.parse(conv) - 1);
  assert.deepEqual(rebaseRepRules(noUnit, [after]), []);
  assert.equal(rebaseRepRules(noUnit, [juice])[0], noUnit[0]);
  // الحقبة نفسها ⇒ الصفّ نفسه (لا نسخ)، وصنفٌ غائب عن الكتالوج ⇒ كما هو
  assert.equal(rebaseRepRules(rules, [juice, water])[2], rules[2]);
  assert.equal(rebaseRepRules(rules, [])[2], rules[2]);
  // الفئة (primaryPrice للرئيسية) والنسب لا تُمسّ ولو حُوِّل الصنف
  const all = rebaseRepRules(rules, [after, water]);
  for (const id of ['r-all', 'r-cat', 'r-wfix', 'r-wup']) assert.equal(all.find((x) => x.id === id), rules.find((x) => x.id === id));
  // بلا قواعد ⇒ مصفوفةٌ ثابتة (المرجع نفسه في كل رسم: لا يعيد مؤثّراً)
  assert.equal(rebaseRepRules([], [juice]), rebaseRepRules(null, null));
  assert.equal(repListRulesOf([{ id: 'l-1', rules }], null, [juice]), repListRulesOf(null, 'l-1', [juice]), 'السعر الأساسي = لا قواعد');
  assert.equal(repListRulesOf([{ id: 'l-1' }], 'l-1', [juice]).length, 0, 'صفٌّ بلا rules (حالةٌ قديمة)');
  assert.equal(repListRulesOf([{ id: 'l-1', rules }, { id: 'l-2', rules: [] }], 'l-2', [juice]).length, 0, 'قواعد قائمة الفاتورة وحدها');
  assert.equal(repListRulesOf([{ id: 'l-1', rules }], 'l-1', [juice, water]).length, 5);
});

// ═══ التسعير: inclOf (من RepApp حرفاً) بالحلّ المشترك ═══

test('inclOf: النسبة على الفئة بحدٍّ أدنى للكمية وفترة، والنسبة على كل الأصناف، وسعر الصنف الثابت بحدّه — بكمية الصنف كلّها', () => {
  const list = repListRulesOf([{ id: 'l-1', rules }], 'l-1', [juice, water]);
  const incl = inclOfWith({ rules: list });
  // كرتونٌ واحد: «خصم 5% على كل الأصناف» ⇒ 24 × 0.95 = 22.8 صافياً ⇒ 26.22
  assert.equal(incl(juice, CARTON), 26.22, 'افتراض الكمية: بندٌ واحد بوحدته (التلميح والإضافة)');
  assert.equal(incl(juice, CARTON, 12), 26.22);
  // عشرة كراتين (١٢٠ حبّة = ١٠ بالرئيسية) خلال نوفمبر: «خصم 10% على فئة العصائر من 10 كرتون» تغلب كل الأصناف ⇒ 21.6 ⇒ 24.84
  assert.equal(incl(juice, CARTON, 120), 24.84);
  assert.equal(incl(juice, CARTON, 119), 26.22, 'دون الحدّ بحبّة');
  // والحدّ على مجموع الصنف بكل وحداته: ٩ كراتين و١٢ حبّة = ١٠ كراتين ⇒ بند الحبّات بالخصم نفسه من سعر حبّته
  assert.equal(incl(juice, PIECE, 9 * 12 + 12), roundDecimal(2 * 0.9 * 1.15, 2));
  // الفترة شاملةٌ طرفيها بيوم الرسم (priceDay: يوم الشركة، D1)، وبعدها يعود سعر كل الأصناف
  assert.equal(inclOfWith({ rules: list, day: '2026-11-30' })(juice, CARTON, 120), 24.84);
  assert.equal(inclOfWith({ rules: list, day: '2026-11-01' })(juice, CARTON, 120), 24.84);
  assert.equal(inclOfWith({ rules: list, day: '2026-12-01' })(juice, CARTON, 120), 26.22);
  assert.equal(inclOfWith({ rules: list, day: '2026-10-31' })(juice, CARTON, 120), 26.22);
  // عشرون كرتوناً: سعر الصنف الثابت بحدّه (١٫٥ للحبّة) — الصنف أخصّ من الفئة ⇒ 18 للكرتون ⇒ 20.7
  assert.equal(incl(juice, CARTON, 240), 20.7);
  // فئةٌ بسعرٍ ثابت للرئيسية (الماء بلا رئيسية: للأساس) ⇒ 0.8 ⇒ 0.92، وزيادة 20% على الصنف من ديسمبر تغلب الفئة (الأخصّ)
  assert.equal(incl(water, BOTTLE), 0.92);
  assert.equal(inclOfWith({ rules: list, day: '2026-12-02' })(water, BOTTLE), 1.38);
  // سعر العميل الخاص يغلب القائمة كلّها كما اليوم، بأي كمية ويوم
  for (const q of [12, 120, 240]) assert.equal(incl(juice, CARTON, q, { 'p-j': 1.7 }), roundDecimal(1.7 * 12 * 1.15, 2));
  // سعر الصنف الثابت في القائمة (PriceListItem) قاعدةُ صنفٍ بلا شرط: يغلب الفئة وكل الأصناف، وتغلبه قاعدة الصنف الأعلى حدّاً
  assert.equal(incl(juice, CARTON, 120, {}, { 'p-j': 1.875 }), roundDecimal(1.875 * 12 * 1.15, 2));
  assert.equal(incl(juice, CARTON, 240, {}, { 'p-j': 1.875 }), 20.7);
});

test('inclOf بلا قواعد (شركةٌ بلا قوائم، أو كاشٌ أقدم من الميزة) = معادلة اليوم حرفاً لكل وحدةٍ وكمية', () => {
  /** inclOf قبل الميزة: choiceNet بثالثه (سعر العميل ?? سعر القائمة) ثم تقريبٌ واحد على الشامل */
  const today = (p: typeof juice, c: UnitChoice, cust: Map2, list: Map2) =>
    roundDecimal(choiceNet(c, Number(p.basePrice), cust[p.id] ?? list[p.id]) * (1 + p.taxPct / 100), 2);
  const withUnitPrice = { ...juice, units: [{ ...juice.units[0], price: 21.5 }] };
  for (const p of [juice, withUnitPrice, water as unknown as typeof juice]) {
    for (const c of unitChoices(p)) {
      for (const [cust, list] of [[{}, {}], [{}, { [p.id]: 1.875 }], [{ [p.id]: 1.7 }, { [p.id]: 1.875 }], [{ [p.id]: 0 }, {}]] as Array<[Map2, Map2]>) {
        for (const q of [undefined, 1, 120, 10_000]) {
          const got = inclOfWith({ cust, list, rules: [] })(p, c, q);
          assert.equal(got, today(p, c, cust, list), `${p.id} ${c.name} ${JSON.stringify([cust, list, q])}`);
        }
      }
    }
  }
  // والكاش القديم (بلا rules) يصل إلى inclOf مصفوفةً فارغة: repListRulesOf ⇒ لا قواعد
  assert.equal(repListRulesOf([{ id: 'l-1', rules: repPriceRulesOf(undefined) }], 'l-1', [juice]).length, 0);
  assert.equal(listDependsOnQty([]), false, 'ولا إعادة تسعيرٍ بالكمية (qtyKey فارغ)');
});

test('التقريب مقابل حارس الخادم: الشامل المقرَّب لخانات العملة يقع ضمن TOL من مرجع الخادم بالسلسلة نفسها (النسبة من unitPriceOf المقرَّب، والضرب بالمعامل)', () => {
  // مرآة routes/invoices.ts: المرجع بلا قائمة = سعر الوحدة المحدَّد وإلا الأساس × المعامل (unitPriceOf يقرّب لمنزلتين)، ثم ما تقوله القائمة
  // (listPriceOf + listLineRef من النسخة المشتركة)، والصافي من الشامل netFromInclusive، والهامش TOL = max(0.01, نصف وحدة العملة)
  const server = (p: typeof juice, c: UnitChoice, rule: RepPriceRule, baseQty: number, day: string) => {
    const noList = c.id ? unitPriceOf({ name: c.name, factor: c.factor, price: c.price ?? undefined }, p.basePrice) : Number(p.basePrice) * 1;
    const rp = { id: p.id, categoryId: p.categoryId, primaryFactor: Number(primaryUnitOf(p)?.factor ?? 1) };
    return listLineRef(listPriceOf(null, [rule], rp, qtyPrimaryOf(baseQty, rp), day), c.factor, noList) ?? noList;
  };
  let n = 0;
  for (const dec of [0, 2, 3]) {
    const TOL = Math.max(0.01, 0.5 / 10 ** dec + 1e-9);
    for (const taxPct of [0, 5, 15]) {
      for (const basePrice of [0.37, 1.875, 2, 7.333, 13.99, 1234.567]) {
        for (const [factor, unitPrice] of [[12, null], [24, null], [6, 9.99], [24, 41.666667]] as Array<[number, number | null]>) {
          const p = { ...juice, basePrice, taxPct, units: [{ id: 'u-c', name: 'كرتون', factor, price: unitPrice, isActive: true }] };
          const rulesHere: RepPriceRule[] = [
            ...[-500, -12.5, 3.3, 10, 33.333, 99.99, 100].map((percent) => ({ id: `p${percent}`, scope: 'category', categoryId: 'c-juice', kind: 'percent', percent })),
            ...[0.01, 7.7777, 41.6667, 1000].map((primaryPrice) => ({ id: `f${primaryPrice}`, scope: 'category', categoryId: 'c-juice', kind: 'fixed', primaryPrice })),
            { id: 'b', scope: 'product', productId: p.id, kind: 'fixed', basePrice: 1.666667 },
          ];
          for (const rule of rulesHere) {
            for (const c of unitChoices(p)) {
              const q = c.factor * 3;
              const incl = inclOfWith({ rules: [rule], dec })(p, c, q);
              const ref = server(p, c, rule, q, '2026-11-15');
              const priceNet = taxPct > 0 ? incl / (1 + taxPct / 100) : incl;
              assert.ok(priceNet <= ref + TOL && priceNet >= ref - TOL, `${JSON.stringify({ dec, taxPct, basePrice, factor, unitPrice, rule: rule.id, unit: c.name, incl, ref })}`);
              // والصافي الذي يقترحه الجهاز هو مرجع الخادم نفسه بلا تقريبٍ وسيط (التقريب الوحيد على الشامل)
              assert.equal(lineNetWithList(c, p, null, null, [rule], q, '2026-11-15'), ref);
              assert.equal(incl, roundHalfUp(ref * (1 + taxPct / 100), dec));
              n++;
            }
          }
        }
      }
    }
  }
  assert.ok(n > 1000);
});

// ═══ إعادة التسعير حين تتغيّر الكمية: غير المعدَّل وحده، والمرتبط بفاتورة بيع ثابت ═══

const list = repListRulesOf([{ id: 'l-1', rules }], 'l-1', [juice, water]);
const incl = inclOfWith({ rules: list });
const line = (p: typeof juice, c: UnitChoice, qty: number, extra: Line = {}): Line => {
  const ref = incl(p, c, c.factor * qty);
  return { productId: p.id, name: p.name, ...lineUnitOf(c, p.unit), qty, unitPrice: ref, refPrice: ref, discountPct: 0, taxPct: p.taxPct, ...extra };
};

test('مؤثّر إعادة التسعير (من RepApp): تغيّر كمية صنفٍ يعيد تسعير بنوده غير المعدَّلة بكميته كلّها، ويُبقي المعدَّل يدوياً ويتبع مرجعه', () => {
  const carton = line(juice, CARTON, 1);
  const pieces = { ...line(juice, PIECE, 6), unitPrice: 2.5 }; // سعرٌ عدّله المندوب يدوياً
  const w = line(water as unknown as typeof juice, BOTTLE, 3);
  const linked = { ...line(juice, CARTON, 5), saleItemId: 's-1', unitPrice: 30, refPrice: 30 };
  const cart = [carton, pieces, w, linked];
  assert.equal(carton.unitPrice, 26.22);
  // الكمية كما هي ⇒ المصفوفة نفسها (لا رسم ولا حلقة)
  assert.equal(repriceStep(cart, [juice, water], incl), cart);
  // تسعة كراتين وستّ حبّات = ٩٫٥ كرتون (والمرتجع المرتبط لا يُحسب: لو حُسب لصار ١٤٫٥ وانطبق خصم الفئة)
  const nine = cart.map((l, i) => (i === 0 ? { ...l, qty: 9 } : l));
  const n9 = repriceStep(nine, [juice, water], incl);
  assert.equal(n9[0].unitPrice, 26.22);
  // عشرة كراتين ⇒ خصم الفئة: الكرتون غير المعدَّل 24.84، والحبّات المعدَّلة تبقى 2.5 ومرجعها (الأرضية) يصير 2.07
  const ten = cart.map((l, i) => (i === 0 ? { ...l, qty: 10 } : l));
  const n10 = repriceStep(ten, [juice, water], incl);
  assert.deepEqual([n10[0].unitPrice, n10[0].refPrice], [24.84, 24.84]);
  assert.deepEqual([n10[1].unitPrice, n10[1].refPrice], [2.5, 2.07], 'التعديل اليدوي يبقى');
  assert.equal(n10[2], w, 'صنفٌ آخر لم تتغيّر كميته: البند نفسه');
  assert.equal(n10[3], linked, 'بند فاتورة البيع: سعر الاسترداد ثابتاً أبداً');
  // ونزول الكمية تحت الحدّ يعيد السعر (غير المعدَّل)
  const back = repriceStep(n10.map((l, i) => (i === 0 ? { ...l, qty: 2 } : l)), [juice, water], incl);
  assert.equal(back[0].unitPrice, 26.22);
  // صنفٌ خرج من الكتالوج: كما هو
  assert.equal(repriceStep(ten, [water], incl)[0], ten[0]);
});

test('addLine (من RepApp): البند الجديد بكمية الصنف كلّها بعد إضافته، و«+١» على بندٍ قائم يغيّر الكمية وحدها (والمؤثّر يعيد التسعير)', () => {
  const addLine = addLineWith(incl);
  const pieces = line(juice, PIECE, 114);
  assert.equal(pieces.unitPrice, roundDecimal(2 * 0.95 * 1.15, 2), '٩٫٥ كرتون بالحبّة: كل الأصناف');
  // كرتونٌ فوق ١١٤ حبّة = ١٠٫٥ كرتون ⇒ البند الجديد بخصم الفئة لا بسعر الكرتون الواحد
  const next = addLine([pieces], juice, CARTON);
  assert.equal(next.length, 2);
  assert.deepEqual([next[1].unitPrice, next[1].refPrice, next[1].qty, next[1].unitId], [24.84, 24.84, 1, 'u-c']);
  // والحبّات غير المعدَّلة تتبعها في المؤثّر
  assert.equal(repriceStep(next, [juice], incl)[0].unitPrice, roundDecimal(2 * 0.9 * 1.15, 2));
  // «+١» على الكرتون القائم: الكمية وحدها في addLine (السعر في المؤثّر بكمية الصنف الجديدة)
  const nine = [line(juice, CARTON, 9)];
  const plus = addLine(nine, juice, CARTON);
  assert.equal(plus.length, 1);
  assert.deepEqual([plus[0].qty, plus[0].unitPrice], [10, 26.22]);
  assert.notEqual(repQtyKey(plus), repQtyKey(nine), 'الكمية تغيّرت ⇒ المؤثّر يعمل');
  assert.equal(repriceStep(plus, [juice], incl)[0].unitPrice, 24.84);
  // بلا قواعد: البند الجديد كما كان حرفاً (inclOf بكمية بندٍ واحد)
  const plain = addLineWith(inclOfWith())([pieces], juice, CARTON);
  assert.equal(plain[1].unitPrice, inclOfWith()(juice, CARTON));
});

test('repBaseQtyByProduct وrepQtyKey: مجموع الصنف بالأساس بكل وحداته بلا بنود فاتورة البيع، والبصمة تتغيّر بالكمية وحدها', () => {
  const cart: Line[] = [line(juice, CARTON, 2), line(juice, PIECE, 5), line(water as unknown as typeof juice, BOTTLE, 3), { ...line(juice, CARTON, 7), saleItemId: 's' }];
  assert.deepEqual([...repBaseQtyByProduct(cart)], [['p-j', 29], ['p-w', 3]]);
  assert.equal(repProductBaseQty(cart, 'p-j'), 29);
  assert.equal(repProductBaseQty(cart, 'p-x'), 0);
  const key = repQtyKey(cart);
  assert.equal(key, 'p-j:29|p-w:3');
  assert.equal(repQtyKey(cart.map((l): Line => ({ ...l, unitPrice: 1, refPrice: 9 }))), key, 'السعر وحده لا يغيّرها (لا حلقة)');
  assert.equal(repQtyKey([...cart].reverse()), key, 'ترتيبٌ ثابت');
  assert.notEqual(repQtyKey(cart.map((l, i) => (i === 1 ? { ...l, qty: 6 } : l))), key);
  assert.notEqual(repQtyKey(cart.filter((_, i) => i !== 1)), key, 'حذف بند');
  assert.notEqual(repQtyKey(cart.map((l, i) => (i === 1 ? { ...l, ...lineUnitOf(CARTON, 'حبة') } : l))), key, 'تبديل الوحدة');
  assert.equal(repQtyKey(cart.map((l, i) => (i === 3 ? { ...l, qty: 99 } : l))), key, 'بند فاتورة البيع خارجها');
  assert.equal(repQtyKey([]), '');
  // المجموع كحارس الخادم حرفاً (docBaseQty): toBase لكل بند (مقرَّبٌ لستّ منازل) مجموعاً بترتيب البنود — لا الضرب الخام
  const odd: Line[] = [{ productId: 'p', qty: 0.1234567, unitFactor: 12 }, { productId: 'p', qty: 0.3, unitFactor: 1 }, { productId: 'p', qty: 0.1, unitFactor: 1 }];
  const server = odd.reduce((s, l) => s + toBase(l.qty, { unitFactor: l.unitFactor }), 0);
  assert.equal(repProductBaseQty(odd, 'p'), server);
  assert.notEqual(server, odd.reduce((s, l) => s + l.qty * l.unitFactor, 0), 'الضرب الخام يختلف في الكسور');
  assert.equal(repProductBaseQty([{ productId: 'p', qty: 0, unitFactor: 12 }, { productId: 'p', qty: 'x' }], 'p'), 0, 'الصفر والتالف لا يُعدّان');
});

test('CreateInvoice: إعادة التسعير بالكمية خلف قاعدةٍ بحدٍّ أدنى للكمية وحدها، والمؤثّر يتبع القواعد واليوم — وتبديل الوحدة وrefreshUnits بالمجموع', () => {
  // بلا قاعدة كمية: البصمة فارغة فلا عمل زائد مع كل تعديل كمية (اليوم حرفاً)
  assert.match(repApp, /const qtyRules = useMemo\(\(\) => listDependsOnQty\(listRules\), \[listRules\]\);/);
  assert.match(repApp, /const qtyKey = qtyRules \? repQtyKey\(lines\) : '';/);
  assert.equal(listDependsOnQty(list), true);
  assert.equal(listDependsOnQty(list.filter((r) => !Number(r.minQty))), false);
  const eff = between(repApp, 'useEffect(() => {\n    setLines(prev => repriceLines(prev));', '}, [custPrices, listPrices, listRules, priceDay, qtyKey]);');
  assert.ok(eff.length < 200, 'المؤثّر يمرّر repriceLines وحدها');
  assert.match(between(repApp, 'const repriceLines = (prev: any[], day: string = priceDay): any[] => {', '\n  };\n'), /return repRepriceLines\(prev, \(l\) => \{/);
  // اليوم يوم الشركة بمنطقتها من كاش الأسماء (D1) — لا todayLocal() في التسعير
  assert.match(repApp, /const priceDay = repPricingDay\(listInfo\);/);
  assert.doesNotMatch(between(repApp, 'const inclOf = ', ';\n'), /todayLocal/);
  // تبديل الوحدة: السعر والأرضية بعد قصّ اللوط وبكمية الصنف بالوحدة الجديدة
  const unit = between(repApp, 'const setLineUnit = (', '// مسح باركود مستمرّ');
  assert.ok(unit.indexOf('const ref = inclOf(p, ch, repProductBaseQty(c, l.productId));') > unit.indexOf('c[i].qty = fit;'), 'بعد قصّ الكمية');
  assert.equal(unit.split('inclOf(').length - 1, 1);
  // refreshUnits: المجموع على وحدات البنود بعد التحديث، وبند فاتورة البيع خارجه ولا يُعاد تسعيره
  const refresh = between(repApp, 'const refreshUnits = async', '\n  return (');
  assert.match(refresh, /const freshBaseQty = \(rows: any\[\], productId: string\) => repProductBaseQty\(rows\.map\(x => \{\s*if \(x\.saleItemId \|\| x\.productId !== productId\) return x;/);
  assert.match(refresh, /setLines\(prev => prev\.map\(l => \{\s*if \(l\.saleItemId\) return l;/);
  // التلميح كما كان: الوحدة الافتراضية بكمية بندٍ واحد
  assert.match(repApp, /const priceHint = \(p: any\) => \(hasUnitChoice\(p\) \? `\$\{formatCurrency\(inclOf\(p, startChoice\(p\)\)\)\} \/ \$\{startChoice\(p\)\.name\}` : formatCurrency\(inclPrice\(p\)\)\);/);
  assert.match(repApp, /const inclPrice = \(p: any\) => inclOf\(p, unitChoices\(p\)\[0\]\);/);
  // «إزالة الضريبة» (٧ نوفمبر ٢٠٢٦): مؤثّر انقلاب وضع الشركة (repRetaxLines) يسعّر بوحدة البند ومجموع الصنف كـrepriceLines
  assert.match(repApp, /refOf: \(l, p\) => inclOf\(p, l\.unitId \? [^\n]*, qtyOf\.get\(l\.productId\) \?\? 0\),/);
  // كل نداءات inclOf معدودة: لا مسار تسعيرٍ لم يُمرَّر له مجموع الصنف إلا التلميح
  assert.equal((repApp.match(/inclOf\(/g) ?? []).length, 7, 'التعريف لا يُعدّ (const inclOf =): repriceLines (المؤثّر والإصدار) وaddLine وsetLineUnit وrefreshUnits وinclPrice وpriceHint ومؤثّر «إزالة الضريبة»');
});

test('rebaseCustPrices يبقى أساس rebaseRepRules (لا حسابٌ موازٍ): الحقبة ثم الاسم ثم وقت القراءة', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'rep', 'repPriceLists.ts'), 'utf8');
  assert.match(src, /const m = rebaseCustPrices\(\[row\], p \? \[p\] : \[\]\);/);
  // والصفّ الممرَّر بالمفاتيح نفسها التي يحفظها custPriceRowsOf (unit وbaseConvertedAt حين وُجدا، وseenAt)
  const conv = '2026-10-30T10:00:00.000Z';
  const after = { ...juice, baseConvertedAt: conv };
  for (const [u, bca, seen] of [['كرتون', null, 1], ['حبة', conv, 1], [undefined, undefined, Date.parse(conv) + 3_600_000], [undefined, undefined, 1]] as Array<[string | undefined, string | null | undefined, number]>) {
    const row = { productId: 'p-j', price: 18, ...(u !== undefined && { unit: u }), ...(bca !== undefined && { baseConvertedAt: bca }), seenAt: seen };
    const want = rebaseCustPrices([row], [after])['p-j'];
    const rule = repPriceRulesOf([{ id: 'r', scope: 'product', productId: 'p-j', kind: 'fixed', basePrice: 18, ...(u !== undefined && { unit: u }), ...(bca !== undefined && { baseConvertedAt: bca }) }], seen);
    const got = rebaseRepRules(rule, [after]);
    assert.equal(got[0]?.basePrice, want, JSON.stringify(row));
  }
});
