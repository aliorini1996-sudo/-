// «أنواع الأسعار» في تطبيق المندوب (طلب المالك: رقاقات تبديلٍ بأسماء تختارها الشركة، وللمندوب صلاحية التبديل) — المكوّن يعتمد
// IndexedDB والكاميرا فلا يُرسم هنا: الدوالّ الصرفة في رأس RepApp.tsx (listPriceRowsOf وlistPricesOf) تُستخرج من المصدر وتُترجم
// وتُشغَّل على مساعدات repUnits الحقيقية، وقرارات repPriceLists.ts تُستورد، والتوصيل داخل CreateInvoice بحرّاسٍ نصّية.
// و«نوع سعر المندوب» (طلب المالك ٢ نوفمبر ٢٠٢٦): افتراضيّ الفاتورة نوع العميل ?? نوع المندوب، والتبديل بين أنواعه المسموحة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { choiceNet, rebaseCustPrices, unitChoices } from './repUnits';
import { roundDecimal } from './invoiceCalc';
import {
  listIdOf, repCachedNamesOf, repCustomerListOf, repDefaultListOf, repInvoiceListOf, repListChipsOf, repListMissing, repPriceCacheStale,
  repPriceRulesOf, repSwitchChipsOf,
} from './repPriceLists';
import { allowedPriceTypesOf, defaultPriceTypeOf } from '../lib/priceLists';
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
// «قوائم الأسعار» بقواعدها: الصفّ يحمل قواعد القائمة أيضاً (repPriceRulesOf من repPriceLists.ts — repPriceRules.test.ts)
const listPriceRowsOf = (d: unknown, seenAt?: number | null) => compile<(d: unknown, seenAt?: number | null) => Lists>(
  between(repApp, 'const listPriceRowsOf = ', ';\n'), 'listPriceRowsOf', { custPriceRowsOf, repPriceRulesOf },
)(d, seenAt);
const listPricesOf = (lists: Lists | null, listId: string | null, products: Prod[]) => compile<(l: Lists | null, id: string | null, p: Prod[]) => Record<string, number>>(
  between(repApp, 'function listPricesOf(', '\n}\n'), 'listPricesOf', { rebaseCustPrices },
)(lists, listId, products);

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

test('repInvoiceListOf: افتراضيّ الفاتورة، واختيار المندوب يُقرأ بصلاحية «تبديل نوع السعر» وحدها', () => {
  assert.equal(repInvoiceListOf('l-whole', undefined, false), 'l-whole');
  assert.equal(repInvoiceListOf('l-whole', 'l-retail', false), 'l-whole', 'بلا الصلاحية لا تبديل ولو بقي اختيارٌ قديم');
  assert.equal(repInvoiceListOf('l-whole', null, false), 'l-whole');
  assert.equal(repInvoiceListOf('l-whole', undefined, true), 'l-whole', 'لم يختر ⇒ الافتراضيّ');
  assert.equal(repInvoiceListOf('l-whole', 'l-retail', true), 'l-retail');
  assert.equal(repInvoiceListOf('l-whole', null, true), null, 'السعر الأساسي صراحةً');
  assert.equal(repInvoiceListOf(null, undefined, false), null, 'لا نوع للعميل ولا للمندوب');
  // الافتراضيّ يُطبَّع في defaultPriceTypeOf (النسخة المشتركة مع الخادم): الفارغ = السعر الأساسي
  for (const none of [null, undefined, '']) assert.equal(repInvoiceListOf(defaultPriceTypeOf(none, none), undefined, false), null, `بلا نوع (${String(none)})`);
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
  const load = between(repApp, 'const [listInfo, setListInfo] = useState<PriceListsInfo | null>(null);', 'useEffect(() => { void loadPriceLists(); }, [canSwitchList, repListCached]);');
  assert.match(load, /fetchThenCache\('pricelists:names', async \(\) => \(await repApi\.get\('\/price-lists'\)\)\.data\.data\);/);
  // الأسماء من كاش الجهاز بحكم repCachedNamesOf (نوع العميل المخبّأ والصلاحية) إلا بعد رفضٍ أو نوعٍ بلا أسعار (force)
  // …ونوع المندوب الافتراضي كذلك: كاش أسماءٍ لا يعرفه (أُنشئ أو أُسند بعده) يُجلب
  assert.match(load, /const cachedNames = force \? null : repCachedNamesOf\(await cacheGet<unknown>\('pricelists:names'\), Date\.now\(\), \[custListCached, repListCached\], canSwitchList\);/);
  assert.match(load, /if \(!names\.info\.lists\.length\) return;/, 'شركةٌ بلا أنواع: لا أسعار ولا ملف عميل');
  assert.match(load, /fetchThenCache\('pricelists', async \(\) => \(await repApi\.get\('\/price-lists\/prices'\)\)\.data\.data\),/);
  // نوع العميل **الآن** (لا صفّ قائمة العملاء من الصباح) مع الأسعار — والعميل المُنشأ دون اتصال بلا ملفٍ على الخادم
  assert.match(load, /customer\?\.id && !customer\._offline \? customerListNow\(customer\.id, navigator\.onLine\) : Promise\.resolve\(undefined\),/);
  assert.match(load, /if \(prices\.data\) setListRows\(listPriceRowsOf\(prices\.data, prices\.updatedAt\)\);/);
  assert.match(load, /setCustListLive\(live\);/);
  assert.match(load, /const custListId = repCustomerListOf\(custListCached, custListLive, listInfo, namesFromServer\);/);
  assert.match(load, /const canSwitchList = perms\.canChangePriceList === true && !switchRevoked;/);
  // «نوع سعر المندوب»: الافتراضيّ نوع العميل ?? نوع المندوب (rep_user) بالمساعد المشترك مع الخادم، والتبديل ضمن المسموح
  assert.match(load, /const repListCached = listIdOf\(perms\.defaultPriceListId\);/);
  assert.match(load, /const repListId = repDefaultListOf\(repListCached, listInfo, namesFromServer\);/);
  assert.match(load, /const docDefault = defaultPriceTypeOf\(custListId, repListId\);/);
  assert.match(load, /const allowedTypes = allowedPriceTypesOf\(perms\.allowedPriceTypes\);/);
  assert.match(load, /const listId = repInvoiceListOf\(docDefault, pickedList, canSwitchList, allowedTypes\);/);
  assert.match(load, /const listMissing = repListMissing\(listId, listRows\);/);
  assert.match(load, /const listPrices = useMemo<Record<string, number>>\(\(\) => listPricesOf\(listRows, listId, products\), \[listRows, listId, products\]\);/);
  assert.match(load, /if \(!mine\(\)\) return;/, 'ردٌّ أبطأ من تحميلٍ أحدث لا يكتب فوقه');
  // نوعٌ بلا أسعار في الجهاز والجهاز متصل: تُجلب مرّةً لكل نوع
  const retry = between(repApp, 'const listRetried = useRef<string | null>(null);', '}, [listMissing, listsLoading, listId]);');
  assert.match(retry, /if \(!listMissing \|\| listsLoading \|\| !navigator\.onLine \|\| listRetried\.current === listId\) return;/);
  assert.match(retry, /void loadPriceLists\(true\);/);
  // صلاحية المندوب ونوعه الافتراضي وأنواعه المسموحة من /auth/me (يُدمج الردّ كاملاً فوق rep_user فلا يُسقط حقلٌ جديد)
  assert.match(repApp, /canChangePriceList\?: boolean;/);
  assert.match(repApp, /defaultPriceListId\?: string \| null;/);
  assert.match(repApp, /allowedPriceTypes\?: string\[\] \| null;/);
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
  // «قوائم الأسعار» (إعادة التسمية، ٥ نوفمبر ٢٠٢٦): الحارس نفسه بالعبارة الجديدة
  assert.match(submit, /if \(!saleRef && listMissing\) \{\s*setMsg\(listsLoading \? tr\('جاري التحميل'\) : tr\('اتصل مرة لتحديث أسعار القائمة'\)\);\s*if \(!listsLoading && navigator\.onLine\) void loadPriceLists\(true\);\s*return;\s*\}/);
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
  // «قوائم الأسعار» بقواعدها: المؤثّر نفسه يعيد التسعير أيضاً حين تصل القواعد أو يتبدّل اليوم أو تتغيّر كمية صنفٍ (qtyKey) — والقاعدة
  // باقية: غير المعدَّل وحده، وبند فاتورة البيع ثابت، والمرجع بالقاعدة نفسها (inclOf) بكمية الصنف في الفاتورة كلّها
  const eff = between(repApp, 'return repriceUntouched(prev, (l) => {', '}, [custPrices, listPrices, listRules, priceDay, qtyKey]);');
  assert.match(eff, /if \(l\.saleItemId\) return null;/);
  assert.match(eff, /return inclOf\(p, unit, qtyOf\.get\(l\.productId\) \?\? 0\);/, 'المرجع الجديد بالقاعدة نفسها (العميل ?? القائمة) وتقريبها الواحد');
  assert.match(eff, /\(l, price\) => \(\{ \.\.\.l, unitPrice: price \}\)/);
  assert.doesNotMatch(repApp, /choiceNet\(unit, cp, cp\)/, 'المصحِّح القديم لأسعار العميل وحدها صار هذا');
});

test('CreateInvoice: الرقاقات بالصلاحية والاسم للعلم بلاها، والجسم يحمل priceListId لمن يبدّل وحده — والمرتجع المرتبط بلا شيء', () => {
  const ui = between(repApp, '{(listsOn || (listMissing && !listsLoading)) && !saleRef && (() => {', '})()}');
  assert.match(ui, /baseLabelOf\(listInfo, tr\)/, 'اسم الرقاقة الأولى كما سمّته الشركة');
  // المسموح للمندوب مما وصلت أسعاره (repSwitchChipsOf)، ورقاقة السعر الأساسي حين يُسمح بها
  assert.match(ui, /const chips = repSwitchChipsOf\(listInfo\?\.lists, listRows, listId, allowedTypes, docDefault\);/);
  assert.match(ui, /const opts = \[\.\.\.\(chips\.base \? \[\{ id: null as string \| null, name: baseLabelOf\(listInfo, tr\) \}\] : \[\]\), \.\.\.chips\.lists\];/);
  // رقاقةٌ واحدة (لا بديل مسموح) = اسم النوع للعلم
  assert.match(ui, /\{canSwitchList && \(opts\.length > 1 \|\| listId !== docDefault\) \? \(/);
  assert.match(ui, /onClick=\{\(\) => setPickedList\(o\.id\)\}/);
  // التنبيه على غير الافتراضيّ: «نوع سعر العميل» كاليوم، و«نوعك الافتراضي» حين جاء الافتراضيّ من المندوب لعميلٍ بلا نوع
  // «قوائم الأسعار» (إعادة التسمية): «ليست قائمتك الافتراضية» و«ليست قائمة العميل» مكان عبارتي «نوع السعر» بالشرط نفسه
  assert.match(ui, /\{listId !== docDefault && \(custListId == null && repListId != null\s*\? <span[^>]*>\{tr\('ليست قائمتك الافتراضية'\)\}<\/span>\s*: <span[^>]*>\{tr\('ليست قائمة العميل'\)\}<\/span>\)\}/);
  assert.match(ui, /<span className="text-xs text-gray-600">\{tr\('قائمة الأسعار'\)\}:<\/span>/);
  assert.match(ui, /role="radiogroup" aria-label=\{tr\('قائمة الأسعار'\)\}/);
  assert.doesNotMatch(repApp, /tr\('[^']*(?:نوع السعر|نوع سعر|أنواع الأسعار)[^']*'\)/, 'لا عبارة «نوع السعر» ظاهرة للمندوب');
  assert.match(ui, /\{current\?\.name \?\? '—'\}/, 'بلا الصلاحية: اسم النوع وحده');
  assert.match(ui, /\{listMissing && !listsLoading && <p[^>]*>\{tr\('اتصل مرة لتحديث أسعار القائمة'\)\}<\/p>\}/);
  assert.doesNotMatch(ui, /tr\(o\.name\)|tr\(current\??\.name\)/, 'أسماء الأنواع بيانات الشركة لا تمرّ بـtr');
  const body = between(repApp, 'const body = {', 'attempt.current = attemptClientRef(');
  // لمن يبدّل وحده — ولعميلٍ بنوعٍ لا تعرفه أسماء الجهاز اختار له المبدِّل السعر الأساسي: null صريحاً لا غياب المفتاح (= الافتراضيّ).
  // ويُرسل للمبدِّل ولو كان الافتراضيّ: افتراضيٌّ تغيّر في الخادم بعد كاش الجهاز يُسعَّر بما سُعّرت به البنود إن كان مسموحاً
  assert.match(body, /\.\.\.\(canSwitchList && !saleRef && \(listsOn \|\| docDefault != null\) && \{ priceListId: listId \}\),/);
  assert.equal((repApp.match(/priceListId: listId/g) ?? []).length, 1, 'لا مسار آخر يرسل النوع');
  // سحب الصلاحية بعد الفتح (403 PRICE_LIST_FORBIDDEN): رسالة الخادم ثم العودة إلى نوع العميل وإطفاء الرقاقات محلياً حتى refreshUser
  const fail = between(repApp, 'if (isZatcaOutdatedClient(err)) setNeedsUpdate(true);', 'const refreshUnits = async');
  assert.match(fail, /if \(err\?\.response\?\.data\?\.code === 'PRICE_LIST_FORBIDDEN'\) \{ setPickedList\(undefined\); setRevokedFor\(perms\); \}/);
  // ورفضٌ سعريّ بلا رمز: نوع العميل وأسعاره من الخادم الآن (لعلّ المدير نقله بعد الفتح) فتُعاد البنود غير المعدَّلة
  // …وصلاحيات المندوب ونوعه الافتراضي وأنواعه المسموحة من /auth/me الآن (refreshUser) لا بعد خمس دقائق
  assert.match(fail, /if \(err\?\.response\?\.status === 403 && !saleRef && \(!err\?\.response\?\.data\?\.code \|\| err\.response\.data\.code === 'PRICE_LIST_FORBIDDEN'\)\) \{ void loadPriceLists\(true\); onPermsStale\?\.\(\); \}/);
  assert.equal((repApp.match(/<CreateInvoice [^\n]*perms=\{user\} onPermsStale=\{\(\) => \{ void refreshUser\(\); \}\}/g) ?? []).length, 2, 'البيع والمرتجع');
  assert.match(fail, /setMsg\(err\?\.response\?\.data\?\.message/);
});

// ═══ «نوع سعر المندوب» (طلب المالك ٢ نوفمبر ٢٠٢٦): افتراضيّ الفاتورة نوع العميل ?? نوع المندوب، والتبديل بين أنواعه المسموحة ═══

test('نوع سعر المندوب: افتراضيّ الفاتورة نوع العميل ?? نوع المندوب ?? السعر الأساسي — والمبلغ كمرجع الخادم', () => {
  const names = { lists: [{ id: 'l-whole', name: 'سعر الجملة', sortOrder: 0 }, { id: 'l-retail', name: 'سعر التجزئة', sortOrder: 1 }] };
  // عميلٌ بلا نوع ومندوبٌ نوعه «سعر الجملة»: تُسعَّر بالجملة
  const rep = repDefaultListOf('l-whole', names, true);
  assert.equal(rep, 'l-whole');
  assert.equal(defaultPriceTypeOf(null, rep), 'l-whole');
  // نوع العميل يغلب نوع المندوب
  assert.equal(defaultPriceTypeOf('l-retail', rep), 'l-retail');
  // لا نوع للمندوب (لم تضبطه الشركة: اليوم حرفاً) ⇒ نوع العميل وإلا الأساسي
  assert.equal(defaultPriceTypeOf('l-retail', repDefaultListOf(undefined, names, true)), 'l-retail');
  assert.equal(defaultPriceTypeOf(null, repDefaultListOf(null, names, true)), null);
  // rep_user أقدم من تبديل المدير ثم حذف النوع القديم (الحذف ممنوعٌ ما دام لمندوب): أسماء الخادم الطازجة تحكم ⇒ الأساسي؛ وأسماء الكاش لا
  assert.equal(repDefaultListOf('l-gone', names, true), null);
  assert.equal(repDefaultListOf('l-new', names, false), 'l-new');
  assert.equal(repDefaultListOf('l-new', null, true), 'l-new', 'الأسماء لم تصل بعد');
  for (const bad of ['', 7, {}, null, undefined]) assert.equal(repDefaultListOf(bad, names, true), null);
  // المال: الكرتون بسعر الجملة ١١٥ شاملاً لعميلٍ بلا نوع (٤٥ × ١٫١٥ = 51.75 كان يُردّ وقد سعّر الخادم بنوع المندوب)
  const lists = listPriceRowsOf(pricesResponse, 1_000);
  const listId = repInvoiceListOf(defaultPriceTypeOf(repCustomerListOf(null, undefined, names, true), rep), undefined, false);
  assert.equal(listId, 'l-whole');
  assert.equal(incl(water, 1, {}, listPricesOf(lists, listId, [water, sugar])), 115);
  assert.ok(Math.abs(115 / 1.15 - listPricesOf(lists, listId, [water])['p-w'] * 24) <= 0.01, 'ضمن TOL حارس الخادم');
  // وسعر العميل الخاص يغلب نوع المندوب كما يغلب نوع العميل
  assert.equal(incl(water, 1, { 'p-w': 3 }, listPricesOf(lists, listId, [water])), 82.8);
});

test('repInvoiceListOf بأنواع المندوب المسموحة: الاختيار يُقرأ ضمنها وإلا الافتراضيّ — وبلا قيدٍ كاليوم', () => {
  const allowed = allowedPriceTypesOf(['base', 'l-retail']);
  assert.deepEqual(allowed, [null, 'l-retail']);
  assert.equal(repInvoiceListOf('l-whole', 'l-retail', true, allowed), 'l-retail');
  assert.equal(repInvoiceListOf('l-whole', null, true, allowed), null, 'السعر الأساسي مسموح');
  assert.equal(repInvoiceListOf('l-whole', 'l-vip', true, allowed), 'l-whole', 'غير مسموح (سُحب بعد الاختيار) ⇒ الافتراضيّ لا 403');
  assert.equal(repInvoiceListOf('l-whole', 'l-whole', true, allowedPriceTypesOf([])), 'l-whole', 'الافتراضيّ مسموحٌ دائماً');
  assert.equal(repInvoiceListOf('l-whole', null, true, allowedPriceTypesOf([])), 'l-whole');
  assert.equal(repInvoiceListOf('l-whole', 'l-vip', true, allowedPriceTypesOf(null)), 'l-vip', 'null = بلا قيد (اليوم)');
  assert.equal(repInvoiceListOf('l-whole', 'l-vip', true, allowedPriceTypesOf(undefined)), 'l-vip', 'rep_user قديم بلا الحقل = بلا قيد');
  assert.equal(repInvoiceListOf('l-whole', 'l-retail', false, allowed), 'l-whole', 'بلا الصلاحية لا تبديل ولو مسموحاً');
});

test('repSwitchChipsOf: بلا قيدٍ رقاقات اليوم، وبقيدٍ المسموح ∪ الافتراضيّ مما وصلت أسعاره — بترتيب الشركة، والحالي ظاهر', () => {
  const lists = [{ id: 'l-whole', name: 'جملة' }, { id: 'l-retail', name: 'تجزئة' }, { id: 'l-vip', name: 'خاص' }];
  const rows = [{ id: 'l-whole' }, { id: 'l-retail' }, { id: 'l-vip' }];
  const ids = (c: { base: boolean; lists: Array<{ id: string }> }) => [...(c.base ? ['base'] : []), ...c.lists.map((l) => l.id)];
  // بلا قيد (allowedPriceTypes null): كما كانت repListChipsOf حرفاً — والترتيب لا يتبع الافتراضيّ فلا تتنقّل الرقاقات بين العملاء
  for (const def of [null, 'l-retail']) {
    assert.deepEqual(ids(repSwitchChipsOf(lists, rows, def, null, def)), ['base', 'l-whole', 'l-retail', 'l-vip']);
  }
  assert.deepEqual(ids(repSwitchChipsOf(lists, [{ id: 'l-whole' }], null, null, null)), ['base', 'l-whole'], 'بلا أسعار في الجهاز: لا رقاقة كاليوم');
  // مسموحٌ «تجزئة» والأساسي، والافتراضيّ «جملة» (نوع العميل) ⇒ ثلاث رقاقات بترتيب الشركة بلا «خاص»
  const allowed = allowedPriceTypesOf(['l-retail', 'base']);
  assert.deepEqual(ids(repSwitchChipsOf(lists, rows, 'l-whole', allowed, 'l-whole')), ['base', 'l-whole', 'l-retail']);
  // الأساسي ليس في المسموح ⇒ لا رقاقة له، إلا أن يكون الافتراضيّ أو الحالي
  const noBase = allowedPriceTypesOf(['l-retail']);
  assert.deepEqual(ids(repSwitchChipsOf(lists, rows, 'l-whole', noBase, 'l-whole')), ['l-whole', 'l-retail']);
  assert.deepEqual(ids(repSwitchChipsOf(lists, rows, null, noBase, null)), ['base', 'l-retail'], 'افتراضيّ أساسيّ (لا نوع للعميل ولا للمندوب)');
  // مسموحٌ فارغ: الافتراضيّ وحده (رقاقةٌ واحدة ⇒ المكوّن يعرض الاسم للعلم)
  assert.deepEqual(ids(repSwitchChipsOf(lists, rows, 'l-whole', [], 'l-whole')), ['l-whole']);
  // مسموحٌ لم تصل أسعاره في الجهاز: لا رقاقة؛ ونوع الفاتورة الحالي بلا أسعار يبقى ظاهراً مع تنبيه غيابه
  assert.deepEqual(ids(repSwitchChipsOf(lists, [{ id: 'l-whole' }], 'l-whole', allowed, 'l-whole')), ['base', 'l-whole']);
  assert.deepEqual(ids(repSwitchChipsOf(lists, [], 'l-vip', noBase, 'l-vip')), ['l-vip']);
  // نوعٌ مسموحٌ حُذف من الشركة لا يظهر (ليس في الأسماء)
  assert.deepEqual(ids(repSwitchChipsOf(lists, rows, null, allowedPriceTypesOf(['l-gone', 'base']), null)), ['base']);
  assert.deepEqual(ids(repSwitchChipsOf(null, rows, null, null, null)), ['base']);
  // repListChipsOf باقٍ أساساً لها
  assert.deepEqual(repListChipsOf(lists, rows, null).map((l) => l.id), ['l-whole', 'l-retail', 'l-vip']);
});

test('repCachedNamesOf بنوع المندوب: كاشٌ لا يعرف نوعه الافتراضي يُجلب ولو لشركةٍ «بلا أنواع» — والمعروف يكفي كاليوم', () => {
  const t0 = 1_000_000_000_000;
  const none = { data: { basePriceLabel: null, lists: [] }, updatedAt: t0 };
  const some = { data: { basePriceLabel: null, lists: [{ id: 'l-whole', name: 'جملة', sortOrder: 0 }] }, updatedAt: t0 };
  assert.deepEqual(repCachedNamesOf(none, t0 + 24 * 3600_000, [null, null])?.lists, [], 'لا نوع للعميل ولا للمندوب: لا طلب أبداً كاليوم');
  assert.equal(repCachedNamesOf(none, t0, [null, 'l-whole']), null, 'نوع المندوب أحدث من الكاش');
  assert.equal(repCachedNamesOf(some, t0, ['l-whole', 'l-retail']), null);
  assert.equal(repCachedNamesOf(some, t0 + 1, [null, 'l-whole'])?.lists.length, 1);
  assert.equal(repCachedNamesOf(some, t0 + 1, ['l-whole', 'l-whole'])?.lists.length, 1);
});

// ═══ مراجعة المرحلة الثانية: كاش أسعار المندوب يُجدَّد حين تتبدّل حقوله، وإقفال الرقاقات بعد 403 لا يبقى مع صلاحياتٍ طازجة ═══

test('repPriceCacheStale: نوع المندوب أو أنواعه المسموحة أو «تبديل نوع السعر» تبدّلت ⇒ يُجدَّد الكاش؛ والمعنى لا الحرف', () => {
  const base = { defaultPriceListId: null, allowedPriceTypes: null, canChangePriceList: false };
  // بلاغ المراجعة: المدير جعل افتراضيّ المندوب «جملة» — rep_user يتبدّل والكاش أقدم ⇒ يُجلب (وإلا مُنع الإصدار دون اتصال لعميلٍ بلا نوع)
  assert.equal(repPriceCacheStale(base, { ...base, defaultPriceListId: 'l-whole' }), true);
  assert.equal(repPriceCacheStale({ ...base, defaultPriceListId: 'l-whole' }, { ...base, defaultPriceListId: 'l-retail' }), true);
  assert.equal(repPriceCacheStale(base, { ...base, allowedPriceTypes: ['base', 'l-retail'] }), true);
  assert.equal(repPriceCacheStale({ ...base, allowedPriceTypes: ['l-retail'] }, { ...base, allowedPriceTypes: ['l-retail', 'l-vip'] }), true);
  assert.equal(repPriceCacheStale(base, { ...base, canChangePriceList: true }), true, 'صلاحيةٌ مُنحت: أسعار كل الأنواع');
  // لا تغيير ⇒ لا طلب — ومندوبٌ لم تُضبط أنواعه (صفٌّ قديم بلا الحقول) كـnull: لا طلب زائد لشركةٍ بلا أنواع
  assert.equal(repPriceCacheStale(base, { ...base }), false);
  assert.equal(repPriceCacheStale({}, base), false, 'rep_user قبل الميزة = الأساسي وبلا قيد وبلا صلاحية');
  assert.equal(repPriceCacheStale({ canChangePriceList: undefined }, { canChangePriceList: false }), false);
  assert.equal(repPriceCacheStale({ defaultPriceListId: '' }, { defaultPriceListId: null }), false);
  assert.equal(repPriceCacheStale({ allowedPriceTypes: ['base', 'base', 'l-x'] }, { allowedPriceTypes: ['base', 'l-x'] }), false, 'المكرّر بالمعنى نفسه');
  assert.equal(repPriceCacheStale({ allowedPriceTypes: [] }, { allowedPriceTypes: null }), true, 'لا شيء مسموح ≠ بلا قيد');
  assert.equal(repPriceCacheStale(null, undefined), false);
});

test('refreshUser: حقول «نوع سعر المندوب» تبدّلت ⇒ كاش الأنواع وأسعارها من الخادم الآن (خلفياً)، وإلا لا طلب', () => {
  const refresh = between(repApp, 'const refreshUser = useCallback(async (): Promise<void> => {', '}, []);');
  // المخزَّن قبل الدمج يُقرأ قبل setUser، والمقارنة بما سيُدمج ({...قبل, ...الطازج}: خادمٌ قديم بلا الحقول لا يبدّل شيئاً)
  assert.ok(refresh.indexOf("before = JSON.parse(localStorage.getItem('rep_user') || 'null')") < refresh.indexOf('setUser(prev => {'));
  assert.match(refresh, /if \(before\?\.id === fresh\.id && repPriceCacheStale\(before, \{ \.\.\.before, \.\.\.fresh \}\)\) void warmRepPriceCache\(\);/);
  const warm = between(repApp, 'async function warmRepPriceCache(): Promise<void> {', '\n}\n');
  // المفاتيح نفسها التي تقرأ منها الفاتورة (loadPriceLists) — والأسعار لشركةٍ لها أنواع وحدها، وطلبٌ خلفيّ لا يُخرج المندوب
  assert.match(warm, /fetchThenCache\('pricelists:names', async \(\) => \(await repApi\.get\('\/price-lists', \{ background: true \}\)\)\.data\.data\);/);
  assert.match(warm, /if \(names\.offline \|\| !priceListsOf\(names\.data\)\.lists\.length\) return;/);
  assert.match(warm, /fetchThenCache\('pricelists', async \(\) => \(await repApi\.get\('\/price-lists\/prices', \{ background: true \}\)\)\.data\.data\);/);
  assert.match(warm, /catch \{/, 'فشله صامت');
  assert.equal((repApp.match(/warmRepPriceCache\(\)/g) ?? []).length, 2, 'تعريفه ونداءٌ واحد في refreshUser');
});

test('CreateInvoice: إقفال الرقاقات بعد 403 PRICE_LIST_FORBIDDEN مربوطٌ بصلاحيات تلك اللحظة — الطازجة من refreshUser تحكم بعدها', () => {
  // بلاغ المراجعة: مبدِّلٌ ما زال يملك الصلاحية وتبدّلت أنواعه المسموحة (rep_user قديم أرسل الافتراضيّ القديم) — كان الإقفال يبقى
  // فلا يختار نوعاً مسموحاً جديداً حتى يغلق الفاتورة
  assert.match(repApp, /const \[revokedFor, setRevokedFor\] = useState<RepUser \| null>\(null\);\n\s*const switchRevoked = revokedFor === perms;\n\s*const canSwitchList = perms\.canChangePriceList === true && !switchRevoked;/);
  assert.doesNotMatch(repApp, /setSwitchRevoked/, 'لا إقفالٌ لا يُفكّ');
  // refreshUser يبدّل كائن المندوب دائماً (دمجٌ جديد)، ولا مسار آخر يبدّله والجلسة قائمة — فتبدّل الكائن = صلاحياتٌ طازجة
  assert.match(repApp, /const merged = \{ \.\.\.prev, \.\.\.fresh \} as RepUser;/);
  assert.equal((repApp.match(/setUser\(/g) ?? []).length, 3, 'refreshUser والدخول والخروج وحدها');
});
