// «أنواع الأسعار» في تطبيق المندوب (طلب المالك: رقاقات تبديلٍ بأسماء تختارها الشركة، وللمندوب صلاحية التبديل) — المكوّن يعتمد
// IndexedDB والكاميرا فلا يُرسم هنا: الدوالّ الصرفة في رأس RepApp.tsx (listPriceRowsOf وlistPricesOf وrepInvoiceListOf) تُستخرج من
// المصدر وتُترجم وتُشغَّل على مساعدات repUnits الحقيقية، والتوصيل داخل CreateInvoice بحرّاسٍ نصّية.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { choiceNet, rebaseCustPrices, unitChoices } from './repUnits';
import { roundDecimal } from './invoiceCalc';
import { listIdOf, repCachedNamesOf, repCustomerListOf, repListChipsOf, repListMissing } from './repPriceLists';
import { COMPANY_REFRESH_MIN_GAP_MS } from './companyRefresh';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const repApp = read('rep', 'RepApp.tsx');
const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  assert.ok(a >= 0, `غائب: ${from}`);
  const b = s.indexOf(to, a + from.length);
  assert.ok(b > a, `غائب بعده: ${to}`);
  return s.slice(a, b + to.length);
};
/** يترجم مقطع TypeScript من RepApp ويعيد ما يسمّيه، بالتبعيات المعطاة (الحقيقية) */
function compile<T>(src: string, name: string, deps: Record<string, unknown>): T {
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(deps), `${js}\nreturn ${name};`)(...Object.values(deps)) as T;
}

type Row = { productId: string; price: number; unit?: string | null; baseConvertedAt?: string | null; seenAt?: number };
type Lists = Array<{ id: string; name: string; rows: Row[] }>;
type Prod = { id: string; unit?: string | null; units?: unknown[]; baseConvertedAt?: string | null };
// تُترجم عند النداء (لا عند تحميل الملف): غياب الدالّة يُفشل اختباراتها وحدها
const custPriceRowsOf = (d: unknown, seenAt?: number | null) => compile<(d: unknown, seenAt?: number | null) => Row[]>(
  between(repApp, 'const custPriceRowsOf = ', ';\n'), 'custPriceRowsOf', {},
)(d, seenAt);
const listPriceRowsOf = (d: unknown, seenAt?: number | null) => compile<(d: unknown, seenAt?: number | null) => Lists>(
  between(repApp, 'const listPriceRowsOf = ', ';\n'), 'listPriceRowsOf', { custPriceRowsOf },
)(d, seenAt);
const listPricesOf = (lists: Lists | null, listId: string | null, products: Prod[]) => compile<(l: Lists | null, id: string | null, p: Prod[]) => Record<string, number>>(
  between(repApp, 'function listPricesOf(', '\n}\n'), 'listPricesOf', { rebaseCustPrices },
)(lists, listId, products);
const repInvoiceListOf = (cust: unknown, picked: string | null | undefined, can: boolean) => compile<(c: unknown, p: string | null | undefined, k: boolean) => string | null>(
  between(repApp, 'function repInvoiceListOf(', '\n}\n'), 'repInvoiceListOf', {},
)(cust, picked, can);

// ماء: القارورة أساسٌ بسعر ٢، والكرتون ٢٤ رئيسيٌّ بسعرٍ محدَّد ٤٥ — و«سعر الجملة» للكرتون ١٠٠ (مخزَّنٌ للأساس 4.166667 بست منازل)
const water = {
  id: 'p-w', unit: 'قارورة', basePrice: 2, taxPct: 15, primaryUnitId: 'u-c', baseConvertedAt: null as string | null,
  units: [{ id: 'u-c', name: 'كرتون', factor: 24, price: 45, isActive: true }],
};
const sugar = { id: 'p-s', unit: 'كيس', basePrice: 10, taxPct: 15, units: [] as typeof water.units, baseConvertedAt: null as string | null };
const pricesResponse = [
  { id: 'l-whole', name: 'سعر الجملة', items: [{ productId: 'p-w', price: 4.166667, unit: 'قارورة', baseConvertedAt: null }] },
  { id: 'l-retail', name: 'سعر التجزئة', items: [{ productId: 'p-w', price: 2.5, unit: 'قارورة', baseConvertedAt: null }, { productId: 'p-s', price: '12' }] },
];
/** شامل البند كما يحسبه inclOf في المكوّن حرفاً: choiceNet بثالثه (سعر العميل ?? سعر النوع) ثم تقريبٌ واحد على الشامل */
const incl = (p: typeof water | typeof sugar, unitIdx: number, cust: Record<string, number>, list: Record<string, number>) =>
  roundDecimal(choiceNet(unitChoices(p)[unitIdx], Number(p.basePrice), cust[p.id] ?? list[p.id]) * (1 + p.taxPct / 100), 2);

test('listPriceRowsOf: ردّ /price-lists/prices بصفوف أسعار العميل نفسها (السعر رقم، والأساس وحقبته، ووقت القراءة) — والتالف يُسقط', () => {
  const lists = listPriceRowsOf([...pricesResponse, null, { id: 7, items: [] }, { id: 'l-empty', name: 'فارغ' }], 1_000);
  assert.deepEqual(lists.map(l => [l.id, l.name, l.rows.length]), [['l-whole', 'سعر الجملة', 1], ['l-retail', 'سعر التجزئة', 2], ['l-empty', 'فارغ', 0]]);
  assert.deepEqual(lists[0].rows, [{ productId: 'p-w', price: 4.166667, unit: 'قارورة', baseConvertedAt: null, seenAt: 1_000 }]);
  assert.deepEqual(lists[1].rows[1], { productId: 'p-s', price: 12, seenAt: 1_000 }, 'كاشٌ بلا unit: لا مفتاح كأسعار العميل');
  assert.deepEqual(listPriceRowsOf(null), []);
  assert.deepEqual(listPriceRowsOf({ lists: [] }), [], 'ردٌّ غير مصفوفة ⇒ لا أنواع');
});

test('listPricesOf: أسعار نوع الفاتورة وحده على أساس الكتالوج — السعر الأساسي أو نوعٌ لم تصل أسعاره: لا شيء', () => {
  const lists = listPriceRowsOf(pricesResponse, 1_000);
  assert.deepEqual(listPricesOf(lists, 'l-whole', [water, sugar]), { 'p-w': 4.166667 });
  assert.deepEqual(listPricesOf(lists, 'l-retail', [water, sugar]), { 'p-w': 2.5, 'p-s': 12 });
  assert.deepEqual(listPricesOf(lists, null, [water]), {}, 'السعر الأساسي');
  assert.deepEqual(listPricesOf(lists, 'l-gone', [water]), {}, 'نوعٌ ليس في الكاش');
  assert.deepEqual(listPricesOf(null, 'l-whole', [water]), {}, 'لم تصل الأسعار بعد');
  // كاشٌ من قبل تحويل الأساس (السعر للكرتون حين كان أساساً) مع كتالوجٍ من بعده ⇒ ÷٢٤ لا سعر كرتونٍ يُضرب ×٢٤ مرّةً ثانية
  const conv = '2026-10-30T10:00:00.000Z';
  const old = listPriceRowsOf([{ id: 'l-whole', name: 'سعر الجملة', items: [{ productId: 'p-w', price: 100, unit: 'كرتون', baseConvertedAt: null }] }]);
  const m = listPricesOf(old, 'l-whole', [{ ...water, baseConvertedAt: conv }]);
  assert.ok(Math.abs(m['p-w'] - 100 / 24) < 1e-12);
});

test('repInvoiceListOf: نوع العميل افتراضاً، واختيار المندوب يُقرأ بصلاحية «تبديل نوع السعر» وحدها', () => {
  assert.equal(repInvoiceListOf('l-whole', undefined, false), 'l-whole');
  assert.equal(repInvoiceListOf('l-whole', 'l-retail', false), 'l-whole', 'بلا الصلاحية لا تبديل ولو بقي اختيارٌ قديم');
  assert.equal(repInvoiceListOf('l-whole', null, false), 'l-whole');
  assert.equal(repInvoiceListOf('l-whole', undefined, true), 'l-whole', 'لم يختر ⇒ نوع العميل');
  assert.equal(repInvoiceListOf('l-whole', 'l-retail', true), 'l-retail');
  assert.equal(repInvoiceListOf('l-whole', null, true), null, 'السعر الأساسي صراحةً');
  for (const none of [null, undefined, '', 7]) assert.equal(repInvoiceListOf(none, undefined, false), null, `عميلٌ بلا نوع (${String(none)})`);
});

test('القاعدة الواحدة في الشامل: سعر العميل يغلب النوع، والنوع يغلب سعر الكرتون المحدَّد والأساس — ومرجع الخادم يقبله بلا canChangePrice', () => {
  const lists = listPriceRowsOf(pricesResponse);
  const whole = listPricesOf(lists, 'l-whole', [water, sugar]);
  const none = {};
  // بلا نوع: الكرتون بسعره المحدَّد ٤٥ (51.75 شاملاً) كما كان حرفاً
  assert.equal(incl(water, 1, none, none), 51.75);
  // بـ«سعر الجملة»: سعر النوع × ٢٤ = 100.000008 ⇒ 115 شاملاً بتقريبٍ واحد
  assert.equal(incl(water, 1, none, whole), 115);
  assert.equal(incl(water, 0, none, whole), 4.79, 'القارورة: 4.166667 × 1.15');
  // صنفٌ ليس في النوع ⇒ سلسلة اليوم (الأساس)
  assert.equal(incl(sugar, 0, none, whole), 11.5);
  // سعر العميل الخاص (للأساس) يغلب النوع
  assert.equal(incl(water, 1, { 'p-w': 3 }, whole), 82.8);
  // حارس الخادم (routes/invoices.ts): ref = (cp ?? lp) × المعامل، والصافي من الشامل ضمن TOL = 0.01 — فلا يُردّ مندوبٌ لم يغيّر السعر
  const ref = whole['p-w'] * 24;
  const net = 115 / 1.15;
  assert.ok(Math.abs(net - ref) <= 0.01, `${net} مقابل ${ref}`);
});

test('CreateInvoice: الأنواع وأسعارها بكاشٍ للعمل دون اتصال — والأسعار ونوع العميل الحالي بعد الأسماء لشركةٍ لها أنواع وحدها', () => {
  const load = between(repApp, 'const [listInfo, setListInfo] = useState<PriceListsInfo | null>(null);', 'useEffect(() => { void loadPriceLists(); }, [canSwitchList]);');
  assert.match(load, /fetchThenCache\('pricelists:names', async \(\) => \(await repApi\.get\('\/price-lists'\)\)\.data\.data\);/);
  // الأسماء من كاش الجهاز بحكم repCachedNamesOf (نوع العميل المخبّأ والصلاحية) إلا بعد رفضٍ أو نوعٍ بلا أسعار (force)
  assert.match(load, /const cachedNames = force \? null : repCachedNamesOf\(await cacheGet<unknown>\('pricelists:names'\), Date\.now\(\), custListCached, canSwitchList\);/);
  assert.match(load, /if \(!names\.info\.lists\.length\) return;/, 'شركةٌ بلا أنواع: لا أسعار ولا ملف عميل');
  assert.match(load, /fetchThenCache\('pricelists', async \(\) => \(await repApi\.get\('\/price-lists\/prices'\)\)\.data\.data\),/);
  // نوع العميل **الآن** (لا صفّ قائمة العملاء من الصباح) مع الأسعار — والعميل المُنشأ دون اتصال بلا ملفٍ على الخادم
  assert.match(load, /customer\?\.id && !customer\._offline \? customerListNow\(customer\.id, navigator\.onLine\) : Promise\.resolve\(undefined\),/);
  assert.match(load, /if \(prices\.data\) setListRows\(listPriceRowsOf\(prices\.data, prices\.updatedAt\)\);/);
  assert.match(load, /setCustListLive\(live\);/);
  assert.match(load, /const custListId = repCustomerListOf\(custListCached, custListLive, listInfo, namesFromServer\);/);
  assert.match(load, /const canSwitchList = perms\.canChangePriceList === true && !switchRevoked;/);
  assert.match(load, /const listId = repInvoiceListOf\(custListId, pickedList, canSwitchList\);/);
  assert.match(load, /const listMissing = repListMissing\(listId, listRows\);/);
  assert.match(load, /const listPrices = useMemo<Record<string, number>>\(\(\) => listPricesOf\(listRows, listId, products\), \[listRows, listId, products\]\);/);
  assert.match(load, /if \(!mine\(\)\) return;/, 'ردٌّ أبطأ من تحميلٍ أحدث لا يكتب فوقه');
  // نوعٌ بلا أسعار في الجهاز والجهاز متصل: تُجلب مرّةً لكل نوع
  const retry = between(repApp, 'const listRetried = useRef<string | null>(null);', '}, [listMissing, listsLoading, listId]);');
  assert.match(retry, /if \(!listMissing \|\| listsLoading \|\| !navigator\.onLine \|\| listRetried\.current === listId\) return;/);
  assert.match(retry, /void loadPriceLists\(true\);/);
  // صلاحية المندوب من /auth/me (يُدمج الردّ كاملاً فوق rep_user)
  assert.match(repApp, /canChangePriceList\?: boolean;/);
  assert.match(repApp, /const merged = \{ \.\.\.prev, \.\.\.fresh \} as RepUser;/);
});

test('customerListNow: نوع العميل من ملفه على الخادم متصلاً ويُكتب في صفّه المخبّأ، وإلا من الصفّ المخبّأ — وخادمٌ بلا الحقل لا يحكم', () => {
  const fn = between(repApp, 'async function customerListNow(', '\n}\n');
  assert.match(fn, /repApi\.get\(`\/customers\/\$\{id\}`\)/, 'GET /customers/:id يحترم عزل العملاء (customerScope)');
  assert.match(fn, /'priceListId' in c/);
  assert.match(fn, /cacheUpdate<any\[\] \| undefined>\('customers', cur => /, 'الكاش يعرف النوع الجديد دون اتصال بعدها');
  assert.match(fn, /return row && typeof row === 'object' && 'priceListId' in row \? listIdOf\(row\.priceListId\) : undefined;/);
});

test('repCustomerListOf (رجعة: نوع العميل القديم من قائمة العملاء): ملفه الآن يغلب صفّه المخبّأ — والحذف يُحكم بأسماء الخادم الطازجة وحدها', () => {
  const names = { lists: [{ id: 'l-whole', name: 'سعر الجملة', sortOrder: 0 }, { id: 'l-retail', name: 'سعر التجزئة', sortOrder: 1 }] };
  // صفّ الصباح بلا نوع والمدير أسند «سعر الجملة» بعده: الملف الطازج يحكم (كان التطبيق يسعّر بالأساس فيردّه الخادم 403)
  assert.equal(repCustomerListOf(null, 'l-whole', names, true), 'l-whole');
  // والعكس: نُقل من النوع إلى السعر الأساسي
  assert.equal(repCustomerListOf('l-whole', null, names, true), null);
  assert.equal(repCustomerListOf('l-whole', 'l-retail', names, false), 'l-retail');
  // لم يُقرأ الملف (دون اتصال، عميلٌ أوف‑لاين، خادمٌ أقدم): الصفّ المخبّأ
  assert.equal(repCustomerListOf('l-whole', undefined, names, false), 'l-whole');
  assert.equal(repCustomerListOf(undefined, undefined, names, true), null);
  // نوعٌ غائبٌ عن أسماء الخادم الطازجة حُذف (SetNull) ⇒ السعر الأساسي؛ وأسماء الكاش لا تحكم بذلك (قد تسبق إنشاءه)
  assert.equal(repCustomerListOf('l-gone', undefined, names, true), null);
  assert.equal(repCustomerListOf('l-new', undefined, names, false), 'l-new');
  assert.equal(repCustomerListOf('l-new', undefined, null, true), 'l-new', 'الأسماء لم تصل بعد');
  for (const bad of ['', 7, {}, null, undefined]) assert.equal(listIdOf(bad), null);
  // المال: الصفّ القديم بلا نوع + الملف الطازج «سعر الجملة» ⇒ الكرتون ١١٥ شاملاً كمرجع الخادم (٤٥ × ١٫١٥ = 51.75 كان يُردّ)
  const lists = listPriceRowsOf(pricesResponse, 1_000);
  const listId = repInvoiceListOf(repCustomerListOf(null, 'l-whole', names, true), undefined, false);
  assert.equal(listId, 'l-whole');
  assert.equal(incl(water, 1, {}, listPricesOf(lists, listId, [water, sugar])), 115);
  assert.equal(incl(water, 1, {}, listPricesOf(lists, repInvoiceListOf(null, undefined, false), [water, sugar])), 51.75, 'الصفّ القديم وحده');
});

test('repListMissing (رجعة: نوعٌ بلا أسعار في الجهاز): لا يُسعَّر بالأساس صامتاً — والسعر الأساسي والنوع الفارغ ليسا غائبين، والإصدار ممنوعٌ حينها', () => {
  const rows = [{ id: 'l-whole' }, { id: 'l-empty' }];
  assert.equal(repListMissing(null, null), false, 'السعر الأساسي لا يحتاج أسعاراً');
  assert.equal(repListMissing('l-whole', rows), false);
  assert.equal(repListMissing('l-empty', rows), false, 'نوعٌ حاضرٌ بلا بنود: سلسلة اليوم سعره فعلاً');
  assert.equal(repListMissing('l-retail', rows), true, 'كاشٌ محصورٌ بأنواع العملاء أو أقدم من النوع');
  assert.equal(repListMissing('l-whole', null), true, 'لم تصل الأسعار (دون اتصال بلا كاش)');
  assert.equal(repListMissing('l-whole', []), true);
  // والإصدار ممنوعٌ حينها (المرتجع من فاتورة بيع سعره سعرها) — ومتصلاً تُجلب الأسعار من جديد
  const submit = between(repApp, 'const submit = async () => {', 'const manualRef =');
  assert.match(submit, /if \(!saleRef && listMissing\) \{\s*setMsg\(listsLoading \? tr\('جاري التحميل'\) : tr\('اتصل مرة لتحديث أسعار نوع السعر'\)\);\s*if \(!listsLoading && navigator\.onLine\) void loadPriceLists\(true\);\s*return;\s*\}/);
});

test('repListChipsOf (رجعة: رقاقةٌ بلا أسعار): رقاقات التبديل للأنواع التي وصلت أسعارها وحدها — ونوع الفاتورة الحالي يبقى ظاهراً', () => {
  const lists = [{ id: 'l-whole', name: 'جملة' }, { id: 'l-retail', name: 'تجزئة' }, { id: 'l-vip', name: 'خاص' }];
  const rows = [{ id: 'l-whole' }];
  // صلاحيةٌ مُنحت بعد قراءة أسعارٍ محصورة بأنواع العملاء: «تجزئة» و«خاص» بلا أسعار ⇒ لا رقاقة (كانت تُسعَّر بالأساس والجسم يحمل معرّفها)
  assert.deepEqual(repListChipsOf(lists, rows, null).map((l) => l.id), ['l-whole']);
  assert.deepEqual(repListChipsOf(lists, rows, 'l-vip').map((l) => l.id), ['l-whole', 'l-vip'], 'نوع العميل الغائب ظاهرٌ مختاراً مع تنبيه');
  assert.deepEqual(repListChipsOf(lists, null, null), []);
  assert.deepEqual(repListChipsOf(null, rows, null), []);
});

test('repCachedNamesOf (رجعة: طلبٌ مع كل فاتورة): شركةٌ بلا أنواع ومندوبٌ لا يبدّل وعميلٌ بلا نوع ⇒ لا طلب بعد أول قراءة — وإلا ٥ دقائق، ونوع العميل المجهول يُجلب', () => {
  const t0 = 1_000_000_000_000;
  const gap = COMPANY_REFRESH_MIN_GAP_MS;
  const none = { data: { basePriceLabel: null, lists: [] }, updatedAt: t0 };
  const some = { data: { basePriceLabel: 'سعر المصنع', lists: [{ id: 'l-whole', name: 'جملة', sortOrder: 0 }] }, updatedAt: t0 };
  assert.equal(repCachedNamesOf(null, t0, null), null, 'لا كاش ⇒ اجلب');
  // شركةٌ بلا أنواع: الكاش يكفي ولو بعد يوم (الزيارات الميدانية تتباعد أكثر من ٥ دقائق فلا تكفي نافذةٌ زمنية)
  assert.deepEqual(repCachedNamesOf(none, t0 + 24 * 3600_000, null)?.lists, []);
  // …إلا لمن يبدّل (يحتاج الرقاقات حين تُنشأ) أو لعميلٍ بنوعٍ لا يعرفه الكاش (أُنشئ بعده)
  assert.equal(repCachedNamesOf(none, t0 + gap, null, true), null);
  assert.ok(repCachedNamesOf(none, t0 + gap - 1, null, true));
  assert.equal(repCachedNamesOf(none, t0, 'l-whole'), null);
  // شركةٌ لها أنواع: ٥ دقائق كإعدادات الشركة
  assert.equal(repCachedNamesOf(some, t0 + gap - 1, 'l-whole')?.basePriceLabel, 'سعر المصنع');
  assert.equal(repCachedNamesOf(some, t0 + gap, null), null);
  assert.equal(repCachedNamesOf(some, t0, 'l-retail'), null, 'نوع العميل أحدث من الكاش');
  // كاشٌ تالفٌ لا يُعدّ «شركةً بلا أنواع» فيُطفئ الميزة على الجهاز
  assert.equal(repCachedNamesOf({ data: null, updatedAt: t0 }, t0, null), null);
  assert.equal(repCachedNamesOf({ data: { lists: 'x' }, updatedAt: t0 }, t0, null), null);
});

test('CreateInvoice: تبديل النوع ووصول أسعاره يعيدان تسعير البنود غير المعدَّلة وحدها — وبند فاتورة البيع ثابت', () => {
  const eff = between(repApp, 'setLines(prev => repriceUntouched(prev, (l) => {', '}, [custPrices, listPrices]);');
  assert.match(eff, /if \(l\.saleItemId\) return null;/);
  assert.match(eff, /return inclOf\(p, unit\);/, 'المرجع الجديد بالقاعدة نفسها (العميل ?? النوع) وتقريبها الواحد');
  assert.match(eff, /\(l, price\) => \(\{ \.\.\.l, unitPrice: price \}\)/);
  assert.doesNotMatch(repApp, /choiceNet\(unit, cp, cp\)/, 'المصحِّح القديم لأسعار العميل وحدها صار هذا');
});

test('CreateInvoice: الرقاقات بالصلاحية والاسم للعلم بلاها، والجسم يحمل priceListId لمن يبدّل وحده — والمرتجع المرتبط بلا شيء', () => {
  const ui = between(repApp, '{(listsOn || (listMissing && !listsLoading)) && !saleRef && (() => {', '})()}');
  assert.match(ui, /baseLabelOf\(listInfo, tr\)/, 'اسم الرقاقة الأولى كما سمّته الشركة');
  assert.match(ui, /\.\.\.repListChipsOf\(listInfo\?\.lists, listRows, listId\)/, 'رقاقات الأنواع التي وصلت أسعارها وحدها');
  assert.match(ui, /\{canSwitchList \? \(/);
  assert.match(ui, /onClick=\{\(\) => setPickedList\(o\.id\)\}/);
  assert.match(ui, /\{listId !== custListId && <span[^>]*>\{tr\('ليس نوع سعر العميل'\)\}<\/span>\}/);
  assert.match(ui, /\{current\?\.name \?\? '—'\}/, 'بلا الصلاحية: اسم النوع وحده');
  assert.match(ui, /\{listMissing && !listsLoading && <p[^>]*>\{tr\('اتصل مرة لتحديث أسعار نوع السعر'\)\}<\/p>\}/);
  assert.doesNotMatch(ui, /tr\(o\.name\)|tr\(current\??\.name\)/, 'أسماء الأنواع بيانات الشركة لا تمرّ بـtr');
  const body = between(repApp, 'const body = {', 'attempt.current = attemptClientRef(');
  // لمن يبدّل وحده — ولعميلٍ بنوعٍ لا تعرفه أسماء الجهاز اختار له المبدِّل السعر الأساسي: null صريحاً لا غياب المفتاح (= نوع العميل)
  assert.match(body, /\.\.\.\(canSwitchList && !saleRef && \(listsOn \|\| custListId != null\) && \{ priceListId: listId \}\),/);
  assert.equal((repApp.match(/priceListId: listId/g) ?? []).length, 1, 'لا مسار آخر يرسل النوع');
  // سحب الصلاحية بعد الفتح (403 PRICE_LIST_FORBIDDEN): رسالة الخادم ثم العودة إلى نوع العميل وإطفاء الرقاقات محلياً حتى refreshUser
  const fail = between(repApp, 'if (isZatcaOutdatedClient(err)) setNeedsUpdate(true);', 'const refreshUnits = async');
  assert.match(fail, /if \(err\?\.response\?\.data\?\.code === 'PRICE_LIST_FORBIDDEN'\) \{ setPickedList\(undefined\); setSwitchRevoked\(true\); \}/);
  // ورفضٌ سعريّ بلا رمز: نوع العميل وأسعاره من الخادم الآن (لعلّ المدير نقله بعد الفتح) فتُعاد البنود غير المعدَّلة
  assert.match(fail, /if \(err\?\.response\?\.status === 403 && !saleRef && \(!err\?\.response\?\.data\?\.code \|\| err\.response\.data\.code === 'PRICE_LIST_FORBIDDEN'\)\) void loadPriceLists\(true\);/);
  assert.match(fail, /setMsg\(err\?\.response\?\.data\?\.message/);
});
