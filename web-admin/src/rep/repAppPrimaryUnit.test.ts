// «الوحدة الرئيسية» (B6b) — تطبيق المندوب: الافتراض بالرئيسية مع «قيود المندوب»، وأسعار العميل على أساس الكتالوج (13ب)، وردود
// PRODUCT_UNITS_CHANGED/BUSY، وأساس الصفّ (baseUnitName) في التحميل وطلب البضاعة، والعرض بالرئيسية — primary_unit_spec §6 و§3 البندان
// 13 و13ب. المكوّن يعتمد IndexedDB والكاميرا فلا يُرسم هنا: الدالّتان الصرفتان في رأس RepApp.tsx (repStartChoice وcustPriceRowsOf)
// تُستخرجان من المصدر وتُترجمان وتُشغَّلان على مساعدات repUnits/repProductRules الحقيقية، والتوصيل داخل المكوّن بحرّاسٍ نصّية.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { choiceNet, defaultChoice, primaryChoice, rebaseCustPrices, unitChoices, type UnitChoice } from './repUnits';
import { repDefaultChoice, repUnitChoices, type RepAction } from './repProductRules';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const repApp = read('rep', 'RepApp.tsx');
const sync = read('rep', 'offlineSync.ts');
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

type P = Parameters<typeof repUnitChoices>[0];
// تُترجمان عند النداء (لا عند تحميل الملف): غياب الدالّة يُفشل اختباراتها وحدها
const repStartChoice = (p: P, a: RepAction): UnitChoice => compile<(p: P, a: RepAction) => UnitChoice>(
  between(repApp, 'function repStartChoice(', '\n}\n'), 'repStartChoice',
  { primaryChoice, repUnitChoices, repDefaultChoice, defaultChoice },
)(p, a);
type Row = { productId: string; price: number; unit?: string | null; baseConvertedAt?: string | null; seenAt?: number };
const custPriceRowsOf = (d: unknown, seenAt?: number | null) => compile<(d: unknown, seenAt?: number | null) => Row[]>(
  between(repApp, 'const custPriceRowsOf = ', ';\n'), 'custPriceRowsOf', {},
)(d, seenAt);

// قارورة أساساً، وكرتون ٢٤ رئيسيّ، وطبلية ١٢٠٠ فوقه
const units = [
  { id: 'u-c', name: 'كرتون', factor: 24, price: 48, isActive: true },
  { id: 'u-pl', name: 'طبلية', factor: 1200, price: null, isActive: true },
];
const plain = { id: 'p0', unit: 'حبة', units: [] };
const bottle = { id: 'p1', unit: 'قارورة', basePrice: 2, units };
const bottleP = { ...bottle, primaryUnitId: 'u-c' };

test('repStartChoice: بلا رئيسية مطابقٌ حرفاً لما قبل الميزة (repDefaultChoice ?? defaultChoice) لكل قيد وفعل — I1', () => {
  for (const base of [plain, bottle, { ...bottle, primaryUnitId: null }, { ...bottle, primaryUnitId: 'u-gone' }]) {
    for (const rule of [undefined, 'ANY', 'BASE', 'LARGE'] as const) {
      for (const action of ['SALE', 'RETURN'] as const) {
        const p = { ...base, repSaleUnit: rule, repReturnUnit: rule };
        assert.deepEqual(repStartChoice(p, action), repDefaultChoice(p, action) ?? defaultChoice(p), `${base.id} ${rule} ${action}`);
      }
    }
  }
});

test('repStartChoice: الرئيسية افتراضٌ ما سمح بها القيد، و«الصغرى فقط» يغلبها — و«الكبرى» تبقى بمعناها', () => {
  assert.equal(repStartChoice(bottleP, 'SALE').id, 'u-c', 'بلا قيد ⇒ الكرتون الرئيسي لا الطبلية');
  assert.equal(repStartChoice({ ...bottleP, repSaleUnit: 'ANY' }, 'SALE').id, 'u-c');
  assert.equal(repStartChoice({ ...bottleP, repSaleUnit: 'BASE' }, 'SALE').id, null, 'قيد الصغرى يغلب ⇒ القارورة');
  assert.equal(repStartChoice({ ...bottleP, repReturnUnit: 'BASE' }, 'RETURN').id, null);
  assert.equal(repStartChoice({ ...bottleP, repReturnUnit: 'BASE' }, 'SALE').id, 'u-c', 'قيد المرتجع لا يمسّ البيع');
  // «الكبرى» = كل وحدة معاملها > ١ (repProductRules) — الكرتون منها فيبقى الافتراض الرئيسية
  assert.equal(repStartChoice({ ...bottleP, repSaleUnit: 'LARGE' }, 'SALE').id, 'u-c');
  // ولا يتغيّر ترتيب الرقاقات: الأساس أوّلاً (I4)
  assert.equal(unitChoices(bottleP)[0].id, null);
});

test('custPriceRowsOf: يحفظ `unit` حين يردّه الخادم، وبلاه لا مفتاح (كاش ما قبل الميزة)، والسعر رقم', () => {
  assert.deepEqual(custPriceRowsOf([
    { productId: 'p1', price: '48', unit: 'كرتون' },
    { productId: 'p2', price: 3.5 },
    { productId: 'p3', price: 1, unit: null },
    null,
  ]), [
    { productId: 'p1', price: 48, unit: 'كرتون' },
    { productId: 'p2', price: 3.5 },
    { productId: 'p3', price: 1 },
  ]);
  assert.deepEqual(custPriceRowsOf(null), []);
  assert.deepEqual(custPriceRowsOf({}), []);
});

test('custPriceRowsOf: حقبة الأساس (baseConvertedAt) تُحفظ حين يردّها الخادم ولو null، ووقت القراءة seenAt يُختم', () => {
  assert.deepEqual(custPriceRowsOf([
    { productId: 'p1', price: 2, unit: 'قارورة', baseConvertedAt: '2026-10-30T10:00:00.000Z' },
    { productId: 'p2', price: 3, unit: 'حبة', baseConvertedAt: null },
    { productId: 'p3', price: 4 },
  ], 1_000), [
    { productId: 'p1', price: 2, unit: 'قارورة', baseConvertedAt: '2026-10-30T10:00:00.000Z', seenAt: 1_000 },
    { productId: 'p2', price: 3, unit: 'حبة', baseConvertedAt: null, seenAt: 1_000 },
    { productId: 'p3', price: 4, seenAt: 1_000 },
  ]);
});

test('money-1: كاشٌ بلا unit من قبل تحويلٍ لاحق ⇒ يُسقط (لا سعر كرتون ×٢٤)، ومن بعده أو لصنفٍ لم يُحوَّل ⇒ كما هو', () => {
  const conv = '2026-10-30T10:00:00.000Z';
  const after = { id: 'p', unit: 'قارورة', basePrice: 1.875, baseConvertedAt: conv, primaryUnitId: 'u1', units: [{ id: 'u1', name: 'كرتون', factor: 24, price: null, isActive: true }] };
  const carton = repStartChoice(after, 'SALE');
  // ما كان قبل الإصلاح: الصفّ بلا unit يبقى ٤٥ سعرَ قارورة ⇒ الكرتون ١٠٨٠
  assert.equal(choiceNet(carton, after.basePrice, 45), 1080);
  const before = Date.parse(conv) - 86_400_000;
  assert.deepEqual(rebaseCustPrices(custPriceRowsOf([{ productId: 'p', price: 45 }], before), [after]), {}, 'يُسقط فيحكم سعر الصنف والخادم');
  assert.deepEqual(rebaseCustPrices(custPriceRowsOf([{ productId: 'p', price: 45 }]), [after]), {}, 'بلا وقت قراءة ⇒ يُسقط');
  assert.deepEqual(rebaseCustPrices(custPriceRowsOf([{ productId: 'p', price: 45 }], Date.parse(conv) + 60_000), [after]), {}, 'داخل هامش الساعة ⇒ يُسقط');
  assert.deepEqual(rebaseCustPrices(custPriceRowsOf([{ productId: 'p', price: 1.8 }], Date.parse(conv) + 86_400_000), [after]), { p: 1.8 }, 'قُرئ بعد التحويل ⇒ سعر القارورة نفسه');
  // I1: صنفٌ لم يُحوَّل قطّ ⇒ كاشٌ بلا unit كما كان حرفاً
  assert.deepEqual(rebaseCustPrices(custPriceRowsOf([{ productId: 'p', price: 45 }], before), [{ ...after, baseConvertedAt: null }]), { p: 45 });
});

test('13ب: كاش أسعار العميل من قبل التحويل مع كتالوج بعده ⇒ سعر الكرتون للعميل ٤٨ كما كان لا ١١٥٢', () => {
  // صنفٌ كان أساسه كرتوناً بسعر عميلٍ ٤٨، ثم أُضيفت له القارورة (convert-base ×٢٤) فصار الكرتون رئيسياً
  const afterConvert = { id: 'p1', unit: 'قارورة', basePrice: 2, primaryUnitId: 'u-c', units: [{ id: 'u-c', name: 'كرتون', factor: 24, price: 50, isActive: true }] };
  const cached = custPriceRowsOf([{ productId: 'p1', price: 48, unit: 'كرتون' }]);
  const carton = repStartChoice(afterConvert, 'SALE');
  assert.equal(carton.id, 'u-c');
  // ما كان يحسبه RepApp قبل الإصلاح: الخريطة الخام (Object.fromEntries) تعامل سعر الكرتون سعرَ قارورة ثم × ٢٤
  const raw = Object.fromEntries(cached.map(r => [r.productId, r.price]));
  assert.equal(choiceNet(carton, afterConvert.basePrice, raw.p1), 1152);
  const cust = rebaseCustPrices(cached, [afterConvert]);
  assert.equal(choiceNet(carton, afterConvert.basePrice, cust.p1), 48);
  // كاشٌ بلا `unit` أو بالأساس نفسه ⇒ السعر كما هو حرفاً (I1)
  assert.deepEqual(rebaseCustPrices(custPriceRowsOf([{ productId: 'p1', price: 2 }]), [afterConvert]), { p1: 2 });
  assert.deepEqual(rebaseCustPrices(custPriceRowsOf([{ productId: 'p1', price: 2, unit: 'قارورة' }]), [afterConvert]), { p1: 2 });
});

test('RepApp: أسعار العميل تمرّ من rebaseCustPrices ويُعاد حسابها مع كل تغيّر للكتالوج — لا خريطة خام من الكاش', () => {
  assert.match(repApp, /const custPrices = useMemo<Record<string, number>>\(\(\) => \(custRows \? rebaseCustPrices\(custRows, products\) : \{\}\), \[custRows, products\]\);/);
  assert.doesNotMatch(repApp, /setCustPrices\(/, 'الخريطة الخام تضرب سعر كرتونٍ قديماً × المعامل');
  const load = between(repApp, 'const [custRows, setCustRows]', '}, [customer?.id]);');
  assert.match(load, /fetchThenCache\(`custprices:\$\{customer\.id\}`/);
  assert.match(load, /const \{ data, updatedAt \} = await fetchThenCache\(`custprices:/);
  assert.match(load, /if \(data\) setCustRows\(custPriceRowsOf\(data, updatedAt\)\);/);
  // الافتراض في البيع والمرتجع الحرّ والماسح وتلميح السعر كلّه من repStartChoice
  assert.match(repApp, /const startChoice = \(p: any\): UnitChoice => repStartChoice\(p, repAction\);/);
  assert.match(repApp, /const c0 = startChoice\(p\);/);
  assert.match(repApp, /inclOf\(p, startChoice\(p\)\)\)\} \/ \$\{startChoice\(p\)\.name\}/);
});

test('RepApp refreshUnits: الكتالوج وأسعار العميل معاً، والمرجع بالخريطة الطازجة لا المغلقة', () => {
  assert.match(repApp, /const inclOf = \(p: any, c: UnitChoice, cust: Record<string, number> = custPrices\) => roundDecimal\(choiceNet\(c, Number\(p\.basePrice\), cust\[p\.id\]\)/);
  const refresh = between(repApp, 'const refreshUnits = async', '\n  return (');
  assert.match(refresh, /await Promise\.all\(\[\s*fetchThenCache\('products'/);
  assert.match(refresh, /customer\?\.id && !customer\._offline\s*\? fetchThenCache\(`custprices:\$\{customer\.id\}`/, 'العميل الأوف‑لاين بلا أسعار خادم');
  assert.match(refresh, /if \(!data \|\| offline\) return;/, 'كاش الكتالوج القديم لا يُعاد عليه شيء');
  assert.match(refresh, /const freshRows = cust\?\.data \? custPriceRowsOf\(cust\.data, cust\.updatedAt\) : custRows;/);
  assert.match(refresh, /const freshCust = freshRows \? rebaseCustPrices\(freshRows, fresh\) : \{\};/);
  assert.match(refresh, /const ref = inclOf\(p, ch, freshCust\);/);
  assert.doesNotMatch(refresh, /inclOf\(p, ch\)/, 'الخريطة المغلقة في الـclosure قديمة');
  assert.match(refresh, /if \(freshRows\) setCustRows\(freshRows\);/);
});

test('الحفظ الحيّ: PRODUCT_UNITS_CHANGED يحدّث الكتالوج كـUNIT_INVALID، وPRODUCT_UNITS_BUSY رسالته وحدها', () => {
  const fail = between(repApp, 'if (isZatcaOutdatedClient(err)) setNeedsUpdate(true);', 'const refreshUnits = async');
  assert.match(fail, /code === 'UNIT_INVALID'\) void refreshUnits\(\);/);
  assert.match(fail, /code === 'PRODUCT_UNITS_CHANGED'\) void refreshUnits\(\);/);
  assert.match(fail, /setMsg\(err\?\.response\?\.data\?\.message/, 'رسالة الخادم (ومنها BUSY) تُعرض');
  // لا سطر يقرن BUSY بتحديث: التحويل جارٍ والكتالوج لم يتغيّر بعد
  assert.doesNotMatch(repApp, /code === 'PRODUCT_UNITS_BUSY'/);
  // التحميل وطلب البضاعة: الحارس نفسه يشمل CHANGED ولا يشمل BUSY
  const inv = between(repApp, 'const isUnitInvalid = (e: unknown) => {', '};');
  assert.match(inv, /return code === 'UNIT_INVALID' \|\| code === 'PRODUCT_UNITS_CHANGED';/);
  assert.doesNotMatch(inv, /PRODUCT_UNITS_BUSY/);
  assert.equal((repApp.match(/if \(isUnitInvalid\(e\)\) \{\s*const fresh = await reloadProducts\(\);/g) ?? []).length, 2);
});

test('التحميل يرسل baseUnitName من أساس الكتالوج حين أُضيف الصفّ، ويُحدَّث مع rebaseRow', () => {
  assert.match(repApp, /unit: c0\.name, baseUnit: String\(p\.unit \?\? ''\)\.trim\(\), qty: '1', unitId: c0\.id, unitFactor: c0\.factor \}/);
  assert.match(repApp, /const items = rows\.map\(r => \(\{ productId: r\.productId, qty: Number\(r\.qty\), \.\.\.\(r\.unitId && \{ unitId: r\.unitId \}\), \.\.\.\(r\.baseUnit && \{ baseUnitName: r\.baseUnit \}\) \}\)\)/);
  assert.match(repApp, /const x = rebaseRow\(r, fp\);\s*return x \? \{ [^\n]*baseUnit: String\(fp\?\.unit \?\? ''\)\.trim\(\) \} : r;/,
    'بعد إعادة الكتالوج يُرسل الأساس الجديد لا القديم فيُردّ 400 إلى الأبد');
});

test('طلب البضاعة يرسل baseUnitName من الكتالوج أو baseUnit البند المعلّق — لا `unit` السطر', () => {
  const base = between(repApp, 'const reqBaseOf = (productId: string): string =>', ';\n');
  assert.match(base, /products\.find\(x => x\.id === productId\)\?\.unit \?\? myReq\?\.pending\?\.items\.find\(i => i\.productId === productId\)\?\.baseUnit \?\? ''/);
  assert.doesNotMatch(base, /\bit\.unit\b|\bi\.unit\b/, 'وحدة السطر ليست الأساس');
  assert.match(repApp, /return \{ productId, qty: Number\(raw\), \.\.\.\(u\.id && \{ unitId: u\.id \}\), \.\.\.\(base && \{ baseUnitName: base \}\) \};/);
  // والافتراض في الطلب والتحميل من defaultChoice (الرئيسية وإلا الأكبر)
  assert.match(repApp, /: defaultChoice\(prod\);/);
  assert.match(repApp, /const c0 = defaultChoice\(p\);\n\s*setRows\(/);
});

test('العرض بالرئيسية: رصيد السيارة والمتاح للإرجاع والطلب يمرّرون primaryUnitId، ورقاقة الرئيسية مبرزة بلا تغيير الترتيب', () => {
  assert.match(repApp, /unitsText\(n, \{ unit: s\.unit \|\| prod\?\.unit, units: s\.units \?\? prod\?\.units, primaryUnitId: s\.primaryUnitId !== undefined \? s\.primaryUnitId : prod\?\.primaryUnitId \}, fmt\)/);
  assert.match(repApp, /unitsText\(l\.link\.returnableBase, \{ unit: l\.link\.baseUnit, units: l\.link\.units, primaryUnitId: products\.find\(x => x\.id === l\.productId\)\?\.primaryUnitId \}/);
  assert.match(repApp, /units: i\.units \?\? null, primaryUnitId: i\.primaryUnitId \?\? null \}\)\)\];/, 'صنف الطلب المعلّق خارج الكتالوج');
  assert.match(repApp, /function lotQtyText\(p: \{ unit\?: string \| null; units\?: UnitDef\[\] \| null; primaryUnitId\?: string \| null \}/);
  const chips = between(repApp, 'const opts: UnitChoice[] = l.saleItemId && l.link ? returnUnitChoices(l.link) : repUnitChoices(', '</button>');
  assert.match(chips, /const primaryId = primaryChoice\(products\.find\(x => x\.id === l\.productId\)\)\?\.id \?\? null;/);
  assert.match(chips, /\{opts\.map\(o => \(/, 'الرقاقات بترتيب unitChoices: الأساس أوّلاً (D5)');
  assert.match(chips, /title: tr\('الوحدة الرئيسية'\)/);
  // بلا رئيسية: الصنف كما كان حرفاً (إلحاقٌ فارغ)
  assert.match(chips, /\$\{primaryId && o\.id === primaryId && !sameUnit\(l, \{ unitId: o\.id \}\) \? [^}]+: ''\}`/);
});

test('D21: نصوص tr الجديدة في RepApp من كتلة WP0 وبلا «الأساس»', () => {
  const strings = read('i18n', 'strings.ts');
  assert.ok(repApp.includes("tr('الوحدة الرئيسية')"));
  assert.ok(strings.includes("'الوحدة الرئيسية': {"), 'المفتاح في كتلة WP0');
  assert.doesNotMatch(between(repApp, 'function repStartChoice(', '\n}\n'), /tr\(/);
});

test('الصندوق الأوف‑لاين (D16): الحمولة تُرفع كما التُقطت — clientCreatedAt ولقطة baseUnitName لكل بند — و5xx (BUSY) يبقيها مصفوفة', () => {
  // الحمولة المحفوظة = الجسم + clientRef + clientCreatedAt (docAt في إعادة الأساس)، وبنودها من invoiceItemUnit (unitId واللقطة وbaseUnitName)
  assert.match(repApp, /const payload = \{ \.\.\.body, clientRef, clientCreatedAt \};/);
  assert.match(repApp, /\.\.\.invoiceItemUnit\(l\),/);
  // إعادة الرفع ترسل doc.payload نفسه مع X-FS-Replay — فيقرأ الخادم docAt من clientCreatedAt في الجسم
  assert.match(sync, /await repApi\.post\(endpoint, doc\.payload, \{ headers: \{ 'X-FS-Replay': '1' \} \}\)/);
  // لا رمز «حجز» جديد (D16): 503 PRODUCT_UNITS_BUSY أو PRODUCT_UNITS_CHANGED (503 لإعادة الرفع) يقعان في فرع 5xx فيبقى المستند
  assert.doesNotMatch(sync, /PRODUCT_UNITS/);
  assert.match(sync, /if \(status && status >= 400 && status < 500\) \{[\s\S]*?\} else \{\s*\/\/[^\n]*\n\s*stopped = true;\s*break;/);
});
