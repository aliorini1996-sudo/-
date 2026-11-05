// مراجعة التحقق L2.2 («قوائم الأسعار»، تطبيق المندوب): الإصدار يرسل `pricesSeenAt` — متى جُلبت بيانات قائمة الفاتورة التي سعّر بها
// الجهاز (ختم كاش 'pricelists' على مدخل القائمة) ISO — في الحمولة خارج مفتاح المحاولة كـpricingDay، ويعيده الصندوق كما هو. فيُسقط حارس
// الخادم في إعادة الرفع قاعدةً كُتبت بعد آخر جلبٍ للجهاز ولو سبقت لحظة البيع (D3 وحده يُسقط ما بعد لحظة البيع).
// المكوّن يعتمد IndexedDB والكاميرا فلا يُرسم هنا: listPriceRowsOf ومقطع الحمولة في submit يُستخرجان من RepApp.tsx حرفاً ويُترجمان
// ويُشغَّلان على المساعدات الحقيقية، ومرآة مرشّحي حارس الخادم (routes/invoices.ts: knownAt = min(لحظة الجهاز، pricesSeenAt)) من
// الحلّ المشترك lib/priceRules.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { unitChoices, type UnitChoice } from './repUnits';
import { repPriceRulesOf, repPricesSeenAt, type RepPriceRule } from './repPriceLists';
import { attemptClientRef } from './liveGate';
import { lineNetWithList } from '../lib/priceListPricing';
import { listLineRef, listPriceOf, qtyPrimaryOf } from '../lib/priceRules';
import { primaryUnitOf, unitPriceOf } from '../lib/units';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const repApp = read('rep', 'RepApp.tsx');
const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  assert.ok(a >= 0, `غائب: ${from}`);
  const b = s.indexOf(to, a + from.length);
  assert.ok(b > a, `غائب بعده: ${to}`);
  return s.slice(a, b + to.length);
};
function compile<T>(src: string, name: string, deps: Record<string, unknown>): T {
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(deps), `${js}\nreturn ${name};`)(...Object.values(deps)) as T;
}

type ListRows = Array<{ id: string; name: string; rows: unknown[]; rules: RepPriceRule[]; seenAt?: number }>;
const custPriceRowsOf = compile<(d: unknown, s?: number | null) => unknown[]>(between(repApp, 'const custPriceRowsOf = ', ';\n'), 'custPriceRowsOf', {});
/** listPriceRowsOf من RepApp حرفاً */
const listPriceRowsOf = compile<(d: unknown, s?: number | null) => ListRows>(
  between(repApp, 'const listPriceRowsOf = ', ';\n'), 'listPriceRowsOf', { custPriceRowsOf, repPriceRulesOf });

const submit = between(repApp, 'const submit = async () => {', 'const refreshUnits = async');
const PAYLOAD = 'const payload = { ...body, clientRef, clientCreatedAt };';
const SEEN_ASSIGN = 'if (pricesSeenAt) Object.assign(payload, { pricesSeenAt });';
type Build = (body: object, clientRef: string, clientCreatedAt: string, pricingDay: string | null, saleRef: unknown, listRows: unknown, listId: string | null) => Record<string, unknown>;
/** الحمولة كما يبنيها submit حرفاً — من الجسم حتى ختم pricesSeenAt (ويوم التسعير قبله) */
const build = compile<Build>(
  `const build = (body: any, clientRef: string, clientCreatedAt: string, pricingDay: string | null, saleRef: any, listRows: any, listId: string | null) => {\n${between(submit, PAYLOAD, SEEN_ASSIGN)}\nreturn payload;\n};`,
  'build', { repPricesSeenAt });

// ٠٨:٠٠ آخر جلبٍ للكاش، ١٠:٠٠ كتب المدير قاعدةً، ١١:٠٠ البيع دون اتصال، ١٤:٠٠ المزامنة
const T0800 = Date.parse('2026-11-05T05:00:00.000Z'); // ٠٨:٠٠ بالرياض
const T1000 = T0800 + 2 * 3_600_000;
const T1100 = T0800 + 3 * 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const serverRule = { id: 'r-all', priceListId: 'l-1', scope: 'all', productId: null, categoryId: null, kind: 'percent', basePrice: null, primaryPrice: null, percent: 5, minQty: 0, startsOn: null, endsOn: null, updatedAt: iso(T0800 - 3_600_000) };
// للعصير لا سعر ثابت في القائمة (السعر الثابت قاعدة صنفٍ تغلب الفئة): القائمة تسعّره بقواعدها وحدها، وبلاها سلّم اليوم (الأساس ١٢)
const withRules = [{ id: 'l-1', name: 'سعر الجملة', items: [{ productId: 'p-x', price: 3, unit: 'حبة', baseConvertedAt: null }], rules: [serverRule] }];
const noRules = [{ id: 'l-2', name: 'سعر التجزئة', items: [{ productId: 'p-x', price: 4, unit: 'حبة', baseConvertedAt: null }], rules: [] }];
const b = { customerId: 'c-1', type: 'CASH', items: [{ productId: 'p-j', qty: 1, unitPrice: 12 }] };

test('repPricesSeenAt: ختم مدخل قائمة الفاتورة في الكاش ISO — والسعر الأساسي وقائمةٌ ليست في الكاش وكاشٌ بلا ختمٍ أو بختمٍ تالف: null', () => {
  const lists = [{ id: 'l-1', seenAt: T0800 }, { id: 'l-2' }, { id: 'l-3', seenAt: T1000 }];
  assert.equal(repPricesSeenAt(lists, 'l-1'), '2026-11-05T05:00:00.000Z');
  assert.equal(repPricesSeenAt(lists, 'l-3'), iso(T1000), 'مدخل قائمة الفاتورة لا غيره');
  assert.equal(repPricesSeenAt(lists, 'l-2'), null, 'كاشٌ أقدم بلا ختم وقت');
  assert.equal(repPricesSeenAt(lists, 'l-gone'), null, 'قائمةٌ ليست في الكاش');
  assert.equal(repPricesSeenAt(lists, null), null, 'السعر الأساسي');
  assert.equal(repPricesSeenAt(null, 'l-1'), null, 'لم تصل الأسعار');
  assert.equal(repPricesSeenAt(undefined, 'l-1'), null);
  for (const bad of [NaN, Infinity, -Infinity, 0, -1, 9e15, '1762318800000', null, {}]) {
    assert.equal(repPricesSeenAt([{ id: 'l-1', seenAt: bad }], 'l-1'), null, String(bad));
  }
  // ISO يُقرأ في الخادم Date.parse بلا التباس منطقة
  assert.equal(Date.parse(repPricesSeenAt(lists, 'l-1')!), T0800);
});

test('listPriceRowsOf (من RepApp): وقت قراءة الكاش على مدخل القائمة ولو بلا بنودٍ ولا قواعد — وكاشٌ بلا ختم: لا مفتاح', () => {
  const lists = listPriceRowsOf([...withRules, ...noRules, { id: 'l-empty', name: 'فارغ' }], T0800);
  assert.deepEqual(lists.map((l) => [l.id, l.seenAt]), [['l-1', T0800], ['l-2', T0800], ['l-empty', T0800]]);
  assert.equal(lists[0].rules[0].seenAt, T0800, 'والقواعد بالختم نفسه (rebaseRepRules)');
  for (const none of [undefined, null]) {
    const old = listPriceRowsOf(withRules, none);
    assert.ok(!('seenAt' in old[0]), `كاشٌ بلا ختم (${String(none)})`);
    assert.equal(repPricesSeenAt(old, 'l-1'), null);
  }
  // كل مسارٍ يكتب listRows يختمه بوقت الكاش الذي قُرئ (الفتح وrefreshUnits) — فالختم وقت البيانات التي سعّرت بها الفاتورة
  assert.match(repApp, /if \(prices\.data\) setListRows\(listPriceRowsOf\(prices\.data, prices\.updatedAt\)\);/);
  assert.match(repApp, /const freshListRows = lists\?\.data \? listPriceRowsOf\(lists\.data, lists\.updatedAt\) : listRows;/);
  assert.equal((repApp.match(/listPriceRowsOf\(/g) ?? []).length, 2, 'لا مسار آخر يبني الصفوف');
  assert.match(repApp, /const listPrices = useMemo<Record<string, number>>\(\(\) => listPricesOf\(listRows, listId, products\)/);
  assert.match(repApp, /const listRules = useMemo\(\(\) => repListRulesOf\(listRows, listId, products\), \[listRows, listId, products\]\);/);
});

test('submit: pricesSeenAt في الحمولة لقائمة الفاتورة بقواعدها (مع pricingDay) — وبلا قائمةٍ أو مع فاتورة بيع أو بكاشٍ بلا ختم: الحمولة كما كانت حرفاً', () => {
  const cached = listPriceRowsOf([...withRules, ...noRules], T0800);
  const at = '2026-11-05T08:00:00.000Z';
  // قائمةٌ بقواعد: المفتاح وحده زائداً، ومع يوم التسعير كلاهما
  assert.deepEqual(build(b, 'ref-1', at, null, null, cached, 'l-1'), { ...b, clientRef: 'ref-1', clientCreatedAt: at, pricesSeenAt: iso(T0800) });
  assert.deepEqual(build(b, 'ref-1', at, '2026-11-05', null, cached, 'l-1'),
    { ...b, clientRef: 'ref-1', clientCreatedAt: at, pricingDay: '2026-11-05', pricesSeenAt: iso(T0800) });
  // شركةٌ بلا قوائم (لا صفوف) أو فاتورةٌ بالسعر الأساسي: الحمولة كما كانت حرفاً
  for (const [rows, id] of [[null, null], [cached, null], [[], null]] as const) {
    const p = build(b, 'ref-1', at, null, null, rows, id);
    assert.deepEqual(p, { ...b, clientRef: 'ref-1', clientCreatedAt: at });
    assert.ok(!('pricesSeenAt' in p));
  }
  // المرتجع من فاتورة بيع: سعره سعرها — لا مفتاح
  assert.ok(!('pricesSeenAt' in build(b, 'ref-1', at, null, { id: 'inv-1', number: 'S-1' }, cached, 'l-1')));
  // كاشٌ أقدم بلا ختم وقت: لا مفتاح (والخادم يبقى على لحظة البيع كما كان)
  assert.ok(!('pricesSeenAt' in build(b, 'ref-1', at, null, null, listPriceRowsOf(withRules, undefined), 'l-1')));
  // قائمةٌ ليست في الكاش (لا إصدار حينها أصلاً — listMissing): لا مفتاح
  assert.ok(!('pricesSeenAt' in build(b, 'ref-1', at, null, null, cached, 'l-gone')));
  // قائمة الفاتورة في الكاش بلا قواعد فيه: يُرسل — أول قاعدةٍ تُكتب لها بعد الكاش هي حالة المراجعة نفسها (الاختبار الأخير)
  assert.equal(build(b, 'ref-1', at, null, null, cached, 'l-2').pricesSeenAt, iso(T0800));
});

test('submit: pricesSeenAt خارج الجسم ومفتاح المحاولة (كاشٌ تجدّد بين ضغطتين لا يصنع مستنداً ثانياً) — ويحمله الطلب الحيّ والصندوق، ويُعاد كما هو', () => {
  const body = between(submit, 'const body = {', 'attempt.current = attemptClientRef(');
  assert.doesNotMatch(body, /pricesSeenAt|seenAt/, 'مفتاح المحاولة من الجسم: الختم خارجه');
  assert.match(submit, /attempt\.current = attemptClientRef\(attempt\.current, body, newClientRef\);/);
  const at0 = submit.indexOf('const pricesSeenAt = ');
  assert.ok(at0 > submit.indexOf(PAYLOAD), 'بعد الحمولة');
  assert.ok(at0 > submit.indexOf('if (pricingDay) Object.assign(payload, { pricingDay });'));
  assert.match(submit, /const pricesSeenAt = saleRef \? null : repPricesSeenAt\(listRows, listId\);\n\s*if \(pricesSeenAt\) Object\.assign\(payload, \{ pricesSeenAt \}\);/);
  assert.ok(submit.indexOf(SEEN_ASSIGN) < submit.indexOf("await repApi.post('/invoices', payload)"), 'الطلب الحيّ يحمله');
  assert.ok(submit.indexOf(SEEN_ASSIGN) < submit.indexOf("kind: 'invoice', payload"), 'والصندوق الأوف‑لاين يحفظه');
  assert.equal((repApp.match(/Object\.assign\(payload, \{ pricesSeenAt \}\)/g) ?? []).length, 1, 'لا مسار آخر يرسله');
  assert.equal((repApp.match(/const pricesSeenAt = /g) ?? []).length, 1);
  // الصندوق يرفع الحمولة المحفوظة كما هي (لا يعيد بناءها ولا يختمها من جديد)
  assert.match(read('rep', 'offlineSync.ts'), /repApi\.post\(endpoint, doc\.payload, \{ headers: \{ 'X-FS-Replay': '1'/);
  // ضغطتان بالجسم نفسه وكاشٌ تجدّد بينهما (ختمٌ آخر): clientRef نفسه، والختم في الحمولة وحدها
  let n = 0;
  const fresh = () => `ref-${++n}`;
  const a1 = attemptClientRef(null, b, fresh);
  const a2 = attemptClientRef(a1, { ...b }, fresh);
  assert.equal(a2.ref, a1.ref);
  const p1 = build(b, a1.ref, 'x', null, null, listPriceRowsOf(withRules, T0800), 'l-1');
  const p2 = build(b, a2.ref, 'x', null, null, listPriceRowsOf(withRules, T1000), 'l-1');
  assert.deepEqual([p1.clientRef, p1.pricesSeenAt, p2.clientRef, p2.pricesSeenAt], ['ref-1', iso(T0800), 'ref-1', iso(T1000)]);
});

// ═══ لماذا: مرآة مرشّحي حارس الخادم (D3 + L2.2) — قاعدةٌ كُتبت بعد آخر جلبٍ وقبل البيع ═══

type Prod = { id: string; basePrice: number; taxPct: number; categoryId: string | null; units: Array<{ id: string; name: string; factor: number; price: number | null; isActive: boolean }> };
const juice: Prod = { id: 'p-j', basePrice: 12, taxPct: 0, categoryId: 'c-juice', units: [] };
const PIECE: UnitChoice = unitChoices(juice)[0];
const DAY = '2026-11-05';
/** rowsKnownAt في الخادم (services/offlineInvoiceDate.ts): ما كُتب عند اللحظة أو قبلها */
const rowsKnownAt = <T extends { updatedAt?: unknown }>(rows: readonly T[], at: number) => rows.filter((r) => !(Date.parse(String(r.updatedAt)) > at));
const refOf = (rules: readonly RepPriceRule[]) => {
  const noList = PIECE.id ? unitPriceOf({ name: PIECE.name, factor: PIECE.factor, price: PIECE.price ?? undefined }, juice.basePrice) : juice.basePrice;
  const rp = { id: juice.id, categoryId: juice.categoryId, primaryFactor: Number(primaryUnitOf(juice)?.factor ?? 1) };
  return listLineRef(listPriceOf(null, rules, rp, qtyPrimaryOf(1, rp), DAY), PIECE.factor, noList) ?? noList;
};
/** مندوبٌ بلا تغيير السعر: الصافي ضمن [أدنى المراجع، أعلاها] بهامش TOL — مرشّحو القواعد: الحالية، وما عرفه الجهاز عند knownAt */
const serverAccepts = (net: number, docRules: readonly RepPriceRule[], instant: number, pricesSeenAt?: string) => {
  const seen = pricesSeenAt ? Date.parse(pricesSeenAt) : NaN;
  const knownAt = Number.isFinite(seen) ? Math.min(instant, seen) : instant;
  const known = rowsKnownAt(docRules, knownAt);
  const refs = (known.length !== docRules.length ? [docRules, known] : [docRules]).map(refOf);
  return net >= Math.min(...refs) - 0.01 && net <= Math.max(...refs) + 0.01;
};

test('حالة المراجعة L2.2: قاعدةٌ كُتبت ١٠:٠٠ والجهاز منقطعٌ منذ ٠٨:٠٠ — بيع ١١:٠٠ بسعر الكاش يُقبل بـpricesSeenAt، وبلحظة البيع وحدها يُردّ', () => {
  // (أ) كاش القائمة بلا قواعد (أول قاعدةٍ للقائمة): الجهاز يسعّر بسلّم اليوم ١٢، والمدير كتب «خصم ١٠٪ على العصائر» ١٠:٠٠ (١٠٫٨)
  const cat = repPriceRulesOf([{ id: 'r-cat', scope: 'category', categoryId: 'c-juice', kind: 'percent', percent: 10, minQty: 0, updatedAt: iso(T1000) }]);
  const cached = listPriceRowsOf([{ ...noRules[0], id: 'l-1' }], T0800);
  const deviceNet = lineNetWithList(PIECE, juice, undefined, undefined, cached[0].rules, 1, DAY);
  assert.equal(deviceNet, 12);
  const seenAt = build(b, 'r', iso(T1100), null, null, cached, 'l-1').pricesSeenAt as string;
  assert.equal(seenAt, iso(T0800));
  assert.equal(serverAccepts(deviceNet, cat, T1100), false, 'كان: ١١:٠٠ بعد القاعدة ⇒ 403 بعد تسليم البضاعة');
  assert.equal(serverAccepts(deviceNet, cat, T1100, seenAt), true, 'بختم الكاش: القاعدة لم يعرفها الجهاز');
  assert.ok(Math.abs(refOf(cat) - 10.8) < 1e-9);
  assert.equal(serverAccepts(10.8, cat, T1100, seenAt), true, 'وسعر القاعدة الحالية مقبولٌ أيضاً (السقف والأرضية)');
  // (ب) كاشٌ فيه قاعدة «كل الأصناف ٥٪» والمدير أضاف قاعدة الفئة الأخصّ ١٠:٠٠
  const all5 = listPriceRowsOf(withRules, T0800);
  const deviceAll = lineNetWithList(PIECE, juice, undefined, undefined, all5[0].rules, 1, DAY);
  assert.ok(Math.abs(deviceAll - 11.4) < 1e-9);
  const docRules = [...all5[0].rules, ...cat];
  assert.equal(serverAccepts(deviceAll, docRules, T1100), false);
  assert.equal(serverAccepts(deviceAll, docRules, T1100, build(b, 'r', 'x', null, null, all5, 'l-1').pricesSeenAt as string), true);
  // (ج) قاعدةٌ كُتبت قبل جلب الكاش يعرفها الجهاز: الختم لا يُسقطها (البيع بسعرٍ قبلها يبقى مردوداً)
  const known = repPriceRulesOf([{ ...cat[0], updatedAt: iso(T0800 - 60_000) }]);
  assert.equal(serverAccepts(12, known, T1100, iso(T0800)), false);
  // (د) ختمٌ بعد لحظة البيع (ساعةٌ رجعت) لا يوسّع شيئاً: الأدنى منهما
  assert.equal(serverAccepts(12, cat, T0800 + 30 * 60_000, iso(T1100)), true, 'البيع ٠٨:٣٠ قبل القاعدة كما كان (D3)');
  assert.equal(serverAccepts(12, cat, T1100, iso(T1100 + 3_600_000)), false);
});
