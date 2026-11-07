// مراجعة «قوائم الأسعار» (CONTRACT2) — تطبيق المندوب:
//   D1: يوم صلاحية القواعد في الجهاز يوم الشركة بمنطقتها (من كاش 'pricelists:names') كيوم حارس الخادم، والإصدار يعيد تسعير السلّة
//       بيوم لحظته قبل بناء الجسم ثم يرسل `pricingDay` في الحمولة (فيُعاد مع الصندوق الأوف‑لاين) — وكاشٌ أقدم بلا منطقة = اليوم المحلي.
//   D4: مندوبٌ بلا «البيع بأقل من السعر» عدّل سعر بندٍ يدوياً ثم تحرّك مرجعه (نزلت الكمية تحت الحدّ الأدنى، أو تبدّل اليوم) ⇒ يُرفع
//       سعره إلى المرجع الجديد إن صار دونه، والمرجع يُحدَّث دائماً، وبند فاتورة البيع لا يُمسّ.
// المكوّن يعتمد IndexedDB والكاميرا فلا يُرسم هنا: inclOf وrepriceLines ومقطع الإصدار تُستخرج من RepApp.tsx حرفاً وتُترجم وتُشغَّل على
// المساعدات الحقيقية، ومرآة حارس الخادم (routes/invoices.ts) من النسخة المشتركة lib/priceRules.ts ويوم companyDayOf (Intl en-CA).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { lineUnitOf, unitChoices, type UnitChoice } from './repUnits';
import { roundDecimal } from './invoiceCalc';
import {
  repBaseQtyByProduct, repCachedNamesOf, repKeptPrice, repNamesOf, repPriceRulesOf, repPricesMoved, repPricingDay, repRepriceLines,
  repRulesDated, repTimezoneOf, type RepPriceRule,
} from './repPriceLists';
import { attemptClientRef } from './liveGate';
import { lineNetWithList } from '../lib/priceListPricing';
import { listLineRef, listPriceOf, qtyPrimaryOf } from '../lib/priceRules';
import { priceListsOf, repriceUntouched } from '../lib/priceLists';
import { todayLocal } from '../lib/shelfLife';
import { primaryUnitOf, unitPriceOf } from '../lib/units';
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
const transpiled = new Map<string, string>();
function compile<T>(src: string, name: string, deps: Record<string, unknown>): T {
  let js = transpiled.get(src);
  if (js === undefined) {
    js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
    transpiled.set(src, js);
  }
  return new Function(...Object.keys(deps), `${js}\nreturn ${name};`)(...Object.values(deps)) as T;
}

type Line = Record<string, any>;
type Incl = (p: unknown, c: UnitChoice, baseQty?: number, cust?: unknown, list?: unknown, rules?: unknown, day?: string) => number;
/** inclOf من CreateInvoice حرفاً — بقواعد القائمة ويوم الرسم (priceDay) المعطيين */
const inclOfWith = (rules: readonly RepPriceRule[], day: string): Incl =>
  compile<Incl>(between(repApp, 'const inclOf = ', ';\n'), 'inclOf', {
    custPrices: {}, listPrices: {}, listRules: rules, lineNetWithList, roundDecimal,
    priceDay: day, currencyDecimals: () => 2, getActiveCurrency: () => 'SAR',
    // «إزالة الضريبة»: النسبة الفعلية من وضع الشركة — شركةٌ بلا العلم = نسبة الصنف كما كانت (taxOffRep.test.ts يغطّي الإزالة)
    effectiveTaxPct, company: null,
  });
/** repriceLines من CreateInvoice حرفاً (المؤثّر والإصدار) — الخرائط undefined فتعمل افتراضات inclOf المعطى، و`floor` = بلا «البيع بأقل» */
const repriceLinesWith = (products: unknown[], inclOf: Incl, day: string, floor: boolean) =>
  compile<(prev: Line[], day?: string) => Line[]>(between(repApp, 'const repriceLines = (prev: any[], day: string = priceDay): any[] => {', '\n  };\n'), 'repriceLines', {
    repBaseQtyByProduct, repRepriceLines, products, inclOf, custPrices: undefined, listPrices: undefined, listRules: undefined,
    priceDay: day, priceFloor: floor,
  });

/** يوم حارس الخادم: companyDayOf(at, tenantTz) = localDateIn بـIntl en-CA (services/lots.ts ← shelfLife.ts) */
const serverDay = (at: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
type Prod = { id: string; basePrice: number; taxPct: number; categoryId?: string | null; primaryUnitId?: string | null; units: Array<{ id: string; name: string; factor: number; price: number | null; isActive: boolean }> };
/** مرجع حارس الخادم الصافي لوحدة البند (routes/invoices.ts): سعر الوحدة المحدَّد وإلا الأساس × المعامل، ثم ما تقوله القائمة */
const serverRef = (p: Prod, c: UnitChoice, rules: readonly RepPriceRule[], baseQty: number, day: string) => {
  const noList = c.id ? unitPriceOf({ name: c.name, factor: c.factor, price: c.price ?? undefined }, p.basePrice) : Number(p.basePrice);
  const rp = { id: p.id, categoryId: p.categoryId ?? null, primaryFactor: Number(primaryUnitOf(p)?.factor ?? 1) };
  return listLineRef(listPriceOf(null, rules, rp, qtyPrimaryOf(baseQty, rp), day), c.factor, noList) ?? noList;
};
const TOL = 0.01;
/** مندوبٌ بلا تغيير السعر: الصافي من الشامل ضمن TOL من المرجع وإلا 403 */
const serverAccepts = (incl: number, taxPct: number, ref: number) => {
  const net = incl / (1 + taxPct / 100);
  return net >= ref - TOL && net <= ref + TOL;
};

const at = '2026-11-01T08:00:00.000Z';
// عصير: الحبّة أساسٌ بسعر ٢، والكرتون ١٢ رئيسيّ، في فئة العصائر — وعرض نوفمبر: خصم ١٠٪ على الفئة حتى ٣٠ نوفمبر
const juice: Prod = {
  id: 'p-j', basePrice: 2, taxPct: 15, categoryId: 'c-juice', primaryUnitId: 'u-c',
  units: [{ id: 'u-c', name: 'كرتون', factor: 12, price: null, isActive: true }],
};
const [, CARTON] = unitChoices(juice);
const promo = repPriceRulesOf([
  { id: 'r-promo', priceListId: 'l-1', scope: 'category', categoryId: 'c-juice', kind: 'percent', percent: 10, minQty: 0, startsOn: '2026-11-01', endsOn: '2026-11-30', updatedAt: at },
], 1_000);
const undated = repPriceRulesOf([{ id: 'r-all', scope: 'all', kind: 'percent', percent: 5, minQty: 0, startsOn: null, endsOn: null, updatedAt: at }], 1_000);
const RIYADH = { timezone: 'Asia/Riyadh' };

// ═══ D1: منطقة الشركة في كاش الأسماء ═══

test('repNamesOf/repCachedNamesOf: منطقة الشركة من ردّ GET /price-lists وكاشه — والكاش الأقدم بلا منطقة كما كان حرفاً', () => {
  const lists = [{ id: 'l-1', name: 'جملة', sortOrder: 0 }];
  const fresh = { basePriceLabel: null, lists, timezone: 'Asia/Riyadh' };
  assert.deepEqual(repNamesOf(fresh), { ...priceListsOf(fresh), timezone: 'Asia/Riyadh' });
  const old = { basePriceLabel: 'سعر المصنع', lists };
  assert.deepEqual(repNamesOf(old), priceListsOf(old), 'خادمٌ أقدم أو كاشٌ من قبل الإصلاح: الشكل نفسه');
  assert.ok(!('timezone' in repNamesOf(old)));
  for (const bad of ['', '   ', 7, null, {}, undefined]) assert.ok(!('timezone' in repNamesOf({ lists, timezone: bad })), String(bad));
  assert.equal(repTimezoneOf(null), null);
  assert.equal(repTimezoneOf('Asia/Riyadh'), null, 'ردٌّ تالف');
  // الكاش: repCachedNamesOf يحمل المنطقة حين وصلت، وكاشٌ بلاها بلا مفتاح
  const t0 = 1_000_000_000_000;
  assert.equal(repCachedNamesOf({ data: fresh, updatedAt: t0 }, t0 + 1, 'l-1')?.timezone, 'Asia/Riyadh');
  const oldHit = repCachedNamesOf({ data: old, updatedAt: t0 }, t0 + 1, 'l-1');
  assert.ok(oldHit && !('timezone' in oldHit));
  // RepApp: أسماء الخادم بالمساعد نفسه (priceListsOf لا تحمل المنطقة)، والكاش عبر repCachedNamesOf كما كان
  assert.match(between(repApp, 'const namesFromNet = async () => {', '\n  };\n'), /return \{ info: repNamesOf\(data\), fromServer: !offline \};/);
  assert.match(repApp, /const cachedNames = force \? null : repCachedNamesOf\(await cacheGet<unknown>\('pricelists:names'\), /);
});

test('repPricingDay = يوم حارس الخادم (companyDayOf بمنطقة الشركة) لكل لحظة — لا يوم ساعة الجهاز ومنطقته؛ وبلا منطقة اليوم المحلي', () => {
  const zones = ['Asia/Riyadh', 'UTC', 'Africa/Cairo', 'Asia/Dubai', 'Asia/Kolkata', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'];
  const start = Date.parse('2026-11-05T00:00:00Z');
  let n = 0;
  for (const tz of zones) {
    for (let h = 0; h < 48; h += 0.25) {
      const now = new Date(start + h * 3_600_000);
      assert.equal(repPricingDay({ timezone: tz }, now), serverDay(now, tz), `${tz} ${now.toISOString()}`);
      n++;
    }
  }
  assert.ok(n > 1000);
  // حالة المراجعة: 22:30Z — جهازٌ على UTC يقول الخامس، والشركة (والخادم) في الرياض السادس
  const now = new Date('2026-11-05T22:30:00Z');
  assert.equal(repPricingDay(RIYADH, now), '2026-11-06');
  assert.equal(serverDay(now, 'UTC'), '2026-11-05', 'يوم الجهاز القديم على UTC');
  // كاشٌ أقدم بلا منطقة، أو منطقةٌ مجهولة، أو أسماءٌ لم تصل ⇒ اليوم المحلي كما كان (todayLocal)
  for (const info of [null, undefined, {}, { timezone: null }, { timezone: '' }, { timezone: 'Mars/Olympus' }]) {
    assert.equal(repPricingDay(info, now), todayLocal(now), JSON.stringify(info));
  }
});

test('RepApp: يوم التسعير مرّةً لكل رسم من repPricingDay(listInfo)، وinclOf يأخذه افتراضاً بلا todayLocal — والمؤثّر يتبعه', () => {
  assert.match(repApp, /const priceDay = repPricingDay\(listInfo\);/);
  const incl = between(repApp, 'const inclOf = ', ';\n');
  assert.match(incl, /rules: readonly RepPriceRule\[\] = listRules, day: string = priceDay\) =>/);
  assert.match(incl, /lineNetWithList\(c, p, cust\[p\.id\], list\[p\.id\], rules, baseQty, day\)/);
  assert.doesNotMatch(incl, /todayLocal|new Date|repPricingDay/, 'لا Intl لكل صنفٍ في الكتالوج: اليوم مرّةً لكل رسم');
  assert.match(repApp, /\}, \[custPrices, listPrices, listRules, priceDay, qtyKey\]\);/);
});

test('inclOf بيوم الشركة يطابق حارس الخادم عند حدّ العرض (حالة المراجعة) — وبيوم الجهاز القديم على UTC كان يُردّ', () => {
  // عرض «خصم ١٠٪ على الفئة» ينتهي ٣٠ نوفمبر، والشركة في الرياض. اللحظات حول منتصف ليل الرياض (21:00Z) وحول منتصف ليل UTC
  for (const iso of ['2026-11-30T20:59:00Z', '2026-11-30T21:00:00Z', '2026-11-30T22:30:00Z', '2026-12-01T00:30:00Z', '2026-10-31T21:30:00Z', '2026-10-31T20:30:00Z']) {
    const now = new Date(iso);
    const day = repPricingDay(RIYADH, now);
    const incl = inclOfWith(promo, day)(juice, CARTON, 12);
    const ref = serverRef(juice, CARTON, promo, 12, serverDay(now, 'Asia/Riyadh'));
    assert.ok(serverAccepts(incl, 15, ref), `${iso}: ${incl} مقابل ${ref}`);
  }
  // 22:30Z آخر يومٍ للعرض بتوقيت UTC: الجهاز القديم (todayLocal على UTC) يطبّق العرض والخادم (الرياض: أول ديسمبر) لا ⇒ 403
  const now = new Date('2026-11-30T22:30:00Z');
  const oldIncl = inclOfWith(promo, serverDay(now, 'UTC'))(juice, CARTON, 12);
  assert.equal(oldIncl, 24.84);
  assert.equal(serverAccepts(oldIncl, 15, serverRef(juice, CARTON, promo, 12, '2026-12-01')), false);
  assert.equal(inclOfWith(promo, repPricingDay(RIYADH, now))(juice, CARTON, 12), 27.6, 'يوم الشركة: بلا العرض كالخادم');
});

// ═══ D1: الإصدار يعيد التسعير بيوم لحظته ويرسل pricingDay ═══

/** مقطع الإصدار من submit حرفاً: يوم التسعير وإعادة السلّة بيومه قبل بناء الجسم — `undefined` = توقّف الإصدار */
function submitPricing(o: { lines: Line[]; rules: readonly RepPriceRule[]; day0: string; now: Date; info?: unknown; saleRef?: unknown; floor?: boolean }) {
  const block = between(repApp, 'const pricingDay = !saleRef && repRulesDated(listRules) ? repPricingDay(listInfo) : null;', "ثم أصدر')); return; }\n    }");
  const setLines: Line[][] = [];
  const msgs: string[] = [];
  const repriceLines = repriceLinesWith([juice], inclOfWith(o.rules, o.day0), o.day0, o.floor ?? false);
  const run = compile<(lines: Line[]) => { pricingDay: string | null } | undefined>(`const run = (lines: any[]) => {\n${block}\nreturn { pricingDay };\n};`, 'run', {
    saleRef: o.saleRef ?? null, repRulesDated, listRules: o.rules, listInfo: o.info === undefined ? RIYADH : o.info,
    repPricingDay: (info: { timezone?: string | null } | null) => repPricingDay(info, o.now),
    repriceLines, setLines: (x: Line[]) => { setLines.push(x); }, repPricesMoved, setMsg: (m: string) => { msgs.push(m); }, tr: (s: string) => s,
  });
  return { out: run(o.lines), setLines, msgs };
}
const cartonLine = (unitPrice: number, refPrice: number = unitPrice, extra: Line = {}): Line =>
  ({ productId: 'p-j', name: 'عصير', ...lineUnitOf(CARTON, 'حبة'), qty: 1, unitPrice, refPrice, discountPct: 0, taxPct: 15, ...extra });
// سلّةٌ سُعّرت ٢٣:٥٥ بتوقيت الرياض في ٣٠ نوفمبر (العرض) وأُصدرت ٠٠:٠٢ في أول ديسمبر بلا رسمٍ بينهما
const priced = new Date('2026-11-30T20:55:00Z');
const issued = new Date('2026-11-30T21:02:00Z');
const MSG = 'أعيد تسعير البنود حسب قائمة الأسعار راجعها ثم أصدر';

test('الإصدار عبر منتصف الليل (حالة المراجعة ب): البنود تُعاد بيوم الإصدار قبل الجسم، وتغيّر السعر يوقفه ليراه المندوب', () => {
  const day0 = repPricingDay(RIYADH, priced);
  assert.equal(day0, '2026-11-30');
  const lines = [cartonLine(inclOfWith(promo, day0)(juice, CARTON, 12))];
  assert.equal(lines[0].unitPrice, 24.84, 'بالعرض');
  // كان: الجسم يحمل 24.84 والخادم بيوم الإصدار (أول ديسمبر) مرجعه 24 صافياً ⇒ 403، ودون اتصال بعد تسليم البضاعة
  assert.equal(serverAccepts(24.84, 15, serverRef(juice, CARTON, promo, 12, serverDay(issued, 'Asia/Riyadh'))), false);
  const r = submitPricing({ lines, rules: promo, day0, now: issued });
  assert.equal(r.out, undefined, 'توقّف الإصدار');
  assert.deepEqual(r.msgs, [MSG]);
  assert.equal(r.setLines.length, 1);
  assert.deepEqual([r.setLines[0][0].unitPrice, r.setLines[0][0].refPrice], [27.6, 27.6]);
  assert.ok(serverAccepts(27.6, 15, serverRef(juice, CARTON, promo, 12, '2026-12-01')), 'وبعد المراجعة يقبله الخادم');
  // الإعادة على السلّة الجديدة (رسمٌ بعد منتصف الليل): لا تغيّر ⇒ يُصدر بيومه
  const again = submitPricing({ lines: r.setLines[0], rules: promo, day0: '2026-12-01', now: issued });
  assert.deepEqual(again.out, { pricingDay: '2026-12-01' });
  assert.deepEqual([again.setLines.length, again.msgs.length], [0, 0]);
});

test('الإصدار في يوم التسعير نفسه: لا إعادة ولا رسالة، وpricingDay = يوم الشركة — وبلا قاعدةٍ مؤرَّخة أو مع فاتورة بيع: لا شيء', () => {
  const day0 = '2026-11-30';
  const lines = [cartonLine(24.84)];
  const same = submitPricing({ lines, rules: promo, day0, now: priced });
  assert.deepEqual(same.out, { pricingDay: '2026-11-30' });
  assert.deepEqual([same.setLines.length, same.msgs.length], [0, 0]);
  // قواعد بلا تواريخ (أو شركةٌ بلا قوائم: NO_RULES): اليوم لا يعني شيئاً ⇒ لا إعادة ولا مفتاح في الحمولة — ولو عبر منتصف الليل
  for (const rules of [undated, [] as RepPriceRule[]]) {
    const r = submitPricing({ lines: [cartonLine(inclOfWith(rules, day0)(juice, CARTON, 12))], rules, day0, now: issued });
    assert.deepEqual(r.out, { pricingDay: null });
    assert.deepEqual([r.setLines.length, r.msgs.length], [0, 0]);
  }
  assert.equal(repRulesDated(undated), false);
  assert.equal(repRulesDated([]), false);
  assert.equal(repRulesDated(null), false);
  assert.equal(repRulesDated(promo), true);
  assert.equal(repRulesDated([{ id: 'x', scope: 'all', kind: 'percent', percent: 1, endsOn: '2026-12-31' }]), true);
  // المرتجع من فاتورة بيع: سعره سعرها ⇒ لا يوم
  const linked = submitPricing({ lines: [cartonLine(30, 30, { saleItemId: 's-1' })], rules: promo, day0, now: issued, saleRef: { id: 'inv-1' } });
  assert.deepEqual(linked.out, { pricingDay: null });
  // كاش أسماءٍ أقدم بلا منطقة ⇒ اليوم المحلي للجهاز (todayLocal) كما كان
  const localDay = todayLocal(priced);
  const localLines = [cartonLine(inclOfWith(promo, localDay)(juice, CARTON, 12))];
  const local = submitPricing({ lines: localLines, rules: promo, day0: localDay, now: priced, info: { lists: [] } });
  assert.equal(local.out?.pricingDay ?? null, todayLocal(priced));
});

test('D4 عند الإصدار: معدَّلٌ يدوياً صار دون مرجعه الجديد بتبدّل اليوم يُرفع إليه ويتوقّف الإصدار — ومن يبيع بأقل يبقى سعره ويُصدر', () => {
  // المندوب كتب 26 فوق مرجع العرض 24.84، وبعد منتصف الليل المرجع 27.6
  const lines = [cartonLine(26, 24.84)];
  const floor = submitPricing({ lines, rules: promo, day0: '2026-11-30', now: issued, floor: true });
  assert.equal(floor.out, undefined);
  assert.deepEqual([floor.setLines[0][0].unitPrice, floor.setLines[0][0].refPrice], [27.6, 27.6]);
  const below = submitPricing({ lines, rules: promo, day0: '2026-11-30', now: issued, floor: false });
  assert.deepEqual(below.out, { pricingDay: '2026-12-01' }, 'السعر لم يتغيّر: يُصدر بيوم الإصدار');
  assert.deepEqual([below.setLines[0][0].unitPrice, below.setLines[0][0].refPrice], [26, 27.6], 'والمرجع يُحدَّث دائماً');
  assert.equal(below.msgs.length, 0);
});

test('RepApp submit: المقطع بعد الحرّاس وقبل الجسم، وpricingDay في الحمولة خارج مفتاح المحاولة (لا مستند ثانٍ عبر منتصف الليل) ويُحفظ مع الصندوق', () => {
  const submit = between(repApp, 'const submit = async () => {', 'const refreshUnits = async');
  const at0 = submit.indexOf('const pricingDay = ');
  assert.ok(at0 > submit.indexOf('if (zatcaPhase2 && !navigator.onLine)'), 'بعد الحرّاس');
  assert.ok(at0 > submit.indexOf('if (!saleRef && listMissing)'));
  assert.ok(at0 < submit.indexOf("setLoading(true); setMsg('');"), 'قبل التحميل');
  assert.ok(at0 < submit.indexOf('const body = {'), 'قبل بناء الجسم');
  assert.match(submit, /const repriced = repriceLines\(lines, pricingDay\);\n\s*if \(repriced !== lines\) setLines\(repriced\);\n\s*if \(repPricesMoved\(lines, repriced\)\) \{ setMsg\(tr\('أعيد تسعير البنود حسب قائمة الأسعار راجعها ثم أصدر'\)\); return; \}/);
  const body = between(submit, 'const body = {', 'attempt.current = attemptClientRef(');
  assert.doesNotMatch(body, /pricingDay/, 'مفتاح المحاولة من الجسم: اليوم خارجه');
  assert.match(submit, /attempt\.current = attemptClientRef\(attempt\.current, body, newClientRef\);/);
  const tail = between(submit, 'const payload = { ...body, clientRef, clientCreatedAt };', 'if (pricingDay) Object.assign(payload, { pricingDay });');
  assert.ok(submit.indexOf('Object.assign(payload, { pricingDay })') < submit.indexOf("await repApi.post('/invoices', payload)"), 'الطلب الحيّ يحمله');
  assert.ok(submit.indexOf('Object.assign(payload, { pricingDay })') < submit.indexOf("kind: 'invoice', payload"), 'والصندوق الأوف‑لاين يحفظه فيُعاد مع الرفع');
  assert.equal((repApp.match(/pricingDay/g) ?? []).length >= 4, true);
  // الحمولة كما تُبنى حرفاً: بلا يومٍ لا مفتاح (الجسم كما كان)، وبه المفتاح وحده زائداً
  const build = compile<(body: object, clientRef: string, clientCreatedAt: string, pricingDay: string | null) => Record<string, unknown>>(
    `const build = (body: any, clientRef: string, clientCreatedAt: string, pricingDay: string | null) => {\n${tail}\nreturn payload;\n};`, 'build', {});
  const b = { customerId: 'c-1', items: [{ productId: 'p-j', qty: 1, unitPrice: 27.6 }] };
  assert.deepEqual(build(b, 'ref-1', '2026-11-30T21:02:00.000Z', null), { ...b, clientRef: 'ref-1', clientCreatedAt: '2026-11-30T21:02:00.000Z' });
  assert.ok(!('pricingDay' in build(b, 'ref-1', 'x', null)));
  assert.deepEqual(build(b, 'ref-1', 'x', '2026-12-01'), { ...b, clientRef: 'ref-1', clientCreatedAt: 'x', pricingDay: '2026-12-01' });
  // إعادة الضغط بالجسم نفسه بعد منتصف الليل: clientRef نفسه (الخادم يعيد المستند الأول إن ضاع ردّه)
  let n = 0;
  const fresh = () => `ref-${++n}`;
  const a1 = attemptClientRef(null, b, fresh);
  assert.equal(attemptClientRef(a1, { ...b }, fresh).ref, a1.ref);
});

// ═══ D4: أرضية السعر المعدَّل يدوياً حين يتحرّك مرجعه ═══

// حالة المراجعة: سعرٌ ثابت ١٫٥ للحبّة من ١٠ كراتين (٢٤)، والأساس ٢، والضريبة ١٥٪
const p1: Prod = { id: 'p1', basePrice: 2, taxPct: 15, categoryId: 'c1', primaryUnitId: 'uc', units: [{ id: 'uc', name: 'كرتون', factor: 24, price: null, isActive: true }] };
const C24 = unitChoices(p1)[1];
const tier = repPriceRulesOf([{ id: 'tier', scope: 'product', productId: 'p1', kind: 'fixed', basePrice: 1.5, minQty: 10, startsOn: null, endsOn: null, updatedAt: at, unit: 'حبة', baseConvertedAt: null }], 1_000);
const day = '2026-11-15';
const tierIncl = inclOfWith(tier, day);
const step = (lines: Line[], floor: boolean) => repriceLinesWith([p1], tierIncl, day, floor)(lines);
const p1Line = (qty: number, unitPrice: number, refPrice: number, extra: Line = {}): Line =>
  ({ productId: 'p1', name: 'عصير', ...lineUnitOf(C24, 'حبة'), qty, unitPrice, refPrice, discountPct: 0, taxPct: 15, ...extra });

test('D4 (حالة المراجعة): نزول الكمية تحت حدّ الشريحة يرفع السعر اليدوي إلى المرجع الجديد لمن لا يبيع بأقل — فيقبله الخادم', () => {
  // عشرة كراتين ⇒ الشريحة 41.40، والمندوب كتب 50 (فوقها: مسموح)، ثم خمسة كراتين ⇒ المرجع 55.20
  const tierLine = step([p1Line(10, 0, 0)], false)[0];
  assert.deepEqual([tierLine.unitPrice, tierLine.refPrice], [41.4, 41.4]);
  const manual = [{ ...tierLine, unitPrice: 50, qty: 5 }];
  const lifted = step(manual, true)[0];
  assert.deepEqual([lifted.unitPrice, lifted.refPrice], [55.2, 55.2]);
  const ref = serverRef(p1, C24, tier, 5 * 24, day);
  assert.equal(ref, 48);
  assert.ok(lifted.unitPrice / 1.15 >= ref - TOL, 'لا 403 «لا تملك صلاحية البيع بأقل من السعر المحدد»');
  assert.ok(50 / 1.15 < ref - TOL, 'وكان 50 يُردّ');
  // من يبيع بأقل (canSellBelowPrice): سعره يبقى ومرجعه يتبع — كما كان
  const kept = step(manual, false)[0];
  assert.deepEqual([kept.unitPrice, kept.refPrice], [50, 55.2]);
  // سعرٌ يدويّ فوق المرجع الجديد يبقى كما هو (الأرضية ترفع ولا تخفض)
  const above = step([{ ...tierLine, unitPrice: 60, qty: 5 }], true)[0];
  assert.deepEqual([above.unitPrice, above.refPrice], [60, 55.2]);
  // وعودة الكمية فوق الحدّ: المرفوع صار مرجعه (غير معدَّل) فيتبع الشريحة — كحدّ التعديل اليدوي في upd
  assert.deepEqual([step([{ ...lifted, qty: 10 }], true)[0].unitPrice], [41.4]);
});

test('repRepriceLines: repriceUntouched حرفاً + الأرضية حين يتحرّك المرجع وحده — وبند فاتورة البيع لا يُمسّ، ولا تغيّر ⇒ المصفوفة نفسها', () => {
  type PL = { id: string; unitPrice: number; refPrice: number; saleItemId?: string };
  const lines: PL[] = [
    { id: 'a', unitPrice: 10, refPrice: 10 },                 // غير معدَّل
    { id: 'b', unitPrice: 12, refPrice: 10 },                 // معدَّل فوق مرجعه
    { id: 'c', unitPrice: 9, refPrice: 10 },                  // معدَّل دون مرجعه (صلاحيةٌ تبدّلت أثناء الفاتورة) — مرجعه لا يتحرّك
    { id: 'd', unitPrice: 30, refPrice: 30, saleItemId: 's' }, // فاتورة بيع
  ];
  const fresh: Record<string, number | null> = { a: 11, b: 13, c: 10, d: 99 };
  const withPrice = (l: PL, price: number) => ({ ...l, unitPrice: price });
  const plain = repriceUntouched(lines, (l) => (l.saleItemId ? null : fresh[l.id]), withPrice);
  // بلا أرضية: repriceUntouched حرفاً (ولا يمسّ بند فاتورة البيع ولو أعاد له المستدعي مرجعاً)
  assert.deepEqual(repRepriceLines(lines, (l) => fresh[l.id], false), plain);
  const out = repRepriceLines(lines, (l) => fresh[l.id], true);
  assert.deepEqual(out.map((l) => [l.id, l.unitPrice, l.refPrice]), [['a', 11, 11], ['b', 13, 13], ['c', 9, 10], ['d', 30, 30]]);
  assert.equal(out[2], lines[2], 'مرجعٌ لم يتحرّك: البند نفسه (الأرضية حين يتحرّك المرجع وحده)');
  assert.equal(out[3], lines[3], 'بند فاتورة البيع لا يُمسّ أبداً');
  // لا تغيّر ⇒ المصفوفة نفسها (لا رسم ولا حلقة)، بالأرضية وبلاها
  const same = (l: PL) => l.refPrice;
  assert.equal(repRepriceLines(lines, same, true), lines);
  assert.equal(repRepriceLines(lines, () => null, true), lines);
  // تحرّكٌ لا ينزل بأي معدَّلٍ تحت مرجعه: النتيجة كـrepriceUntouched حرفاً (المصفوفة نفسها التي أعادها)
  const down = (l: PL) => (l.saleItemId ? null : l.refPrice - 1);
  assert.deepEqual(repRepriceLines(lines, down, true), repriceUntouched(lines, down, withPrice));
  // repKeptPrice: يرفع لمن لا يبيع بأقل وحده، وبهامش الفاصلة
  assert.equal(repKeptPrice(50, 55.2, true), 55.2);
  assert.equal(repKeptPrice(50, 55.2, false), 50);
  assert.equal(repKeptPrice(60, 55.2, true), 60);
  assert.equal(repKeptPrice(55.2 - 1e-12, 55.2, true), 55.2 - 1e-12, 'غبار الفاصلة ليس نزولاً');
  // repPricesMoved: السعر لا المرجع
  assert.equal(repPricesMoved(lines, lines.map((l) => ({ ...l, refPrice: 1 }))), false);
  assert.equal(repPricesMoved(lines, lines.map((l, i) => (i === 1 ? { ...l, unitPrice: 12.01 } : l))), true);
});

test('RepApp: المؤثّر والإصدار بأرضية !canSellBelowPrice في قائمةٍ بقواعد، وrefreshUnits كذلك — وبلا قواعد سلوك اليوم حرفاً، وحدّ upd كما كان', () => {
  assert.match(repApp, /const priceFloor = !perms\?\.canSellBelowPrice && listRules\.length > 0;/);
  const rl = between(repApp, 'const repriceLines = (prev: any[], day: string = priceDay): any[] => {', '\n  };\n');
  assert.match(rl, /\}, priceFloor\);$/m);
  const refresh = between(repApp, 'const refreshUnits = async', '\n  return (');
  assert.match(refresh, /refPrice: ref, unitPrice: keep \? repKeptPrice\(l\.unitPrice, ref, !perms\?\.canSellBelowPrice && freshRules\.length > 0\) : ref \}/);
  // شركةٌ بلا قوائم أو قائمةٌ بلا قواعد (priceFloor مطفأ): المؤثّر repriceUntouched حرفاً — سعر العميل الذي وصل بعد تعديلٍ يدويّ يُبقيه كما كان
  const plainIncl = inclOfWith([], day);
  const manual: Array<Line & { unitPrice: number; refPrice: number }> = [{ ...p1Line(5, 50, 48.3), unitPrice: 50, refPrice: 48.3 }];
  const cust = repriceLinesWith([p1], plainIncl, day, false)(manual);
  const viaUntouched = repriceUntouched(manual, () => plainIncl(p1, C24, 5 * 24), (l, price) => ({ ...l, unitPrice: price }));
  assert.deepEqual(cust, viaUntouched);
  assert.deepEqual([cust[0].unitPrice, cust[0].refPrice], [50, 55.2]);
  // الأرضية نفسها التي يفرضها التعديل اليدوي (upd) — لم تتغيّر
  assert.match(repApp, /if \(!perms\?\.canSellBelowPrice\) v = Math\.max\(v \|\| 0, c\[i\]\.refPrice\);/);
  assert.match(repApp, /c\[i\]\.unitPrice = perms\?\.canSellBelowPrice \? p : Math\.max\(p, c\[i\]\.refPrice\);/);
  // refreshUnits بالأرضية: المرجع الطازج أعلى من المعدَّل ⇒ يُرفع، ومن يبيع بأقل يبقى
  const keepFn = compile<(l: Line, ref: number, floor: boolean) => number>(
    'const keepFn = (l: any, ref: number, floor: boolean) => repKeptPrice(l.unitPrice, ref, floor);', 'keepFn', { repKeptPrice });
  assert.equal(keepFn({ unitPrice: 50 }, 55.2, true), 55.2);
  assert.equal(keepFn({ unitPrice: 50 }, 55.2, false), 50);
});
