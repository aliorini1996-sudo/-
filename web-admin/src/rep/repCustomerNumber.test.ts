// «رقم العميل» في تطبيق المندوب (طلب المالك ٢٣ نوفمبر ٢٠٢٦: «رقم للعميل … يمكن استخدامه في بحث التقارير وبحث خطوط السير وكل
// الأماكن التي يبحث فيها»):
//   • منتقي «العملاء» يبحث في القائمة المخزّنة (GET /customers?limit=1000 ⇒ كاش IndexedDB) — فالرقم يُطابَق بالضبط محلياً ويعمل
//     دون اتصال: num لا يدخل أي نصٍّ يُطابَق بالاحتواء (بحث «1» لا يطابق 12 و21)، والجوال والاسم التجاري والكود المخصّص كلماتٌ مفتاحية.
//   • يُعرض «#12 · الاسم» في بطاقات القائمة، و«رقم العميل #12» تحت الاسم في صفحة العميل، و«#12 · الاسم» في محطّات خط السير.
//   • العميل المضاف دون اتصال (local-…) لا يُخترع له رقمٌ محلياً أبداً — يمنحه الخادم وحده عند الرفع ويصل بالجلب التالي.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { filterSelectOptions, type SelectOption } from '../components/SearchableSelect';
import { visibleCustomerCode, formatCustomerNumber } from '../lib/customerNumber';

const here = path.dirname(fileURLToPath(import.meta.url));
const repApp = fs.readFileSync(path.join(here, 'RepApp.tsx'), 'utf8');
const route = fs.readFileSync(path.join(here, 'RepRouteScreen.tsx'), 'utf8');
const sync = fs.readFileSync(path.join(here, 'offlineSync.ts'), 'utf8');

/** جسم دالةٍ من المصدر: من توقيعها حتى أول دالةٍ علويّة بعدها */
function fnBody(src: string, sig: string): string {
  const at = src.indexOf(sig);
  assert.ok(at >= 0, `غائب: ${sig}`);
  const next = src.indexOf('\nfunction ', at + sig.length);
  return src.slice(at, next < 0 ? undefined : next);
}

const customersFn = fnBody(repApp, 'function RepCustomers(');
const pickerBlock = customersFn.slice(customersFn.indexOf('<SearchableSelect'), customersFn.indexOf('/>', customersFn.indexOf('<SearchableSelect')));
const detailFn = fnBody(repApp, 'function CustomerDetail(');
const addFn = fnBody(repApp, 'function AddCustomer(');

// ═══ المنتقي: الحقول كما في المصدر ═══

test('منتقي العملاء: num لرقم العميل وkeywords للجوال والاسم التجاري والكود المخصّص، والتلميح الجديد', () => {
  assert.ok(pickerBlock.includes("searchPlaceholder={tr('اكتب اسم أو جوال أو رقم العميل')}"), 'تلميح البحث الجديد');
  assert.ok(!pickerBlock.includes("tr('اكتب اسم أو جوال العميل')"), 'التلميح القديم باقٍ في المنتقي');
  assert.ok(pickerBlock.includes('label: c.name,'), 'الاسم وحده في label');
  assert.ok(pickerBlock.includes('num: c.number ?? null,'), 'رقم العميل في num');
  assert.ok(pickerBlock.includes('keywords: [c.phone, c.businessName, visibleCustomerCode(c.code)],'), 'الكلمات المفتاحية');
  // التلميح كما كان (رصيدٌ أو جوال) — لا رقم فيه
  assert.ok(pickerBlock.includes("hint: accountingOn && Number(c.balance) > 0 ? `${tr('رصيد')} ${formatCurrency(c.balance)}` : c.phone,"));
  // الرقم لا يدخل نصّاً يُطابَق بالاحتواء: لا تسمية «#12 · الاسم» ولا رقمٌ في label/hint/keywords
  assert.ok(!/formatCustomerLabel\(|formatCustomerNumber\(/.test(pickerBlock), 'الرقم داخل نصٍّ مُطابَق بالاحتواء');
  for (const line of pickerBlock.split('\n').filter(l => /^\s*(label|hint|keywords):/.test(l))) {
    assert.ok(!/\bnumber\b/.test(line), `الرقم في نصٍّ مُطابَق بالاحتواء: ${line.trim()}`);
  }
  assert.match(repApp, /import \{ formatCustomerNumber, visibleCustomerCode \} from '\.\.\/lib\/customerNumber';/);
});

test('القائمة المخزّنة صفوفٌ كاملة من الخادم (فيصل number ويُخزَّن بلا تغيير مخطّط IndexedDB) — والمنتقي يبحث فيها محلياً', () => {
  assert.ok(customersFn.includes("const { data } = await fetchThenCache('customers', async () =>\n        (await repApi.get('/customers', { params: { limit: 1000 } })).data.data);"));
  // لا onSearchChange: التصفية محلية في SearchableSelect (filterSelectOptions) فتعمل دون اتصال
  assert.ok(!pickerBlock.includes('onSearchChange'), 'المنتقي صار يبحث في الخادم فلا يعمل دون اتصال');
});

// ═══ المنتقي: السلوك دون اتصال على صفوف الكاش ═══

/** خيارٌ كما يبنيه RepCustomers (الحقول المثبَّتة أعلاه حرفاً؛ التلميح بلا tr/formatCurrency) */
function toOption(c: any, accountingOn = true): SelectOption {
  return {
    value: c.id,
    label: c.name,
    num: c.number ?? null,
    hint: accountingOn && Number(c.balance) > 0 ? `رصيد ${c.balance}` : c.phone,
    keywords: [c.phone, c.businessName, visibleCustomerCode(c.code)],
  };
}

const cached = [
  { id: 'a', number: 12, name: 'مؤسسة سمارة', phone: '0551112233', businessName: 'سمارة للتجارة', code: 'cm3x9k2p0000abcd1234efgh', balance: 0 },
  { id: 'b', number: 112, name: 'بقالة النور', phone: '0559998877', code: 'cm3x9k2p0000abcd1234efgi', balance: 250 },
  { id: 'c', number: 121, name: 'تموينات الريف', phone: '0531200000', code: 'RIF-7', balance: 40 },
  { id: 'd', number: 3, name: 'مخبز الفجر', phone: '', code: 'cm3x9k2p0000abcd1234efgj', balance: 0 },
  // كاشٌ قديم قبل الميزة (بلا الحقل) وعميلٌ أُضيف دون اتصال: بلا رقم
  { id: 'e', name: 'محل قديم', phone: '0501234567', code: 'cm3x9k2p0000abcd1234efgk', balance: 0 },
  { id: 'local-r1', name: 'عميل جديد', phone: '0561212121', _offline: true, clientRef: 'r1', balance: 0 },
];
const options = cached.map(c => toOption(c));
const ids = (q: string) => filterSelectOptions(options, q).map(o => o.value);

test('البحث بالرقم بالضبط: «12» و«#12» و«١٢» تجد #12 أوّلاً، لا 112 ولا 121 — والجوالات التي تحوي الأرقام تبقى مطابقة', () => {
  for (const q of ['12', '#12', '# 12', '١٢', '۱۲', ' 12 ']) {
    const got = ids(q);
    assert.equal(got[0], 'a', `صاحب الرقم أوّلاً: «${q}»`);
    assert.ok(!got.includes('b'), `112 لا يطابق «${q}» (جواله بلا 12)`);
  }
  // الجوال يحوي «12» ⇒ يبقى مطابقاً كما كان (المطابقة «أو» لا «بدل»)
  const got = ids('12');
  assert.ok(got.includes('c') && got.includes('e') && got.includes('local-r1'), 'جوالٌ يحوي الأرقام لم يعد يطابق');
  // «3» رقمُ «مخبز الفجر» بالضبط فيتقدّم — و112 (لا «3» في بياناته) لا يطابق لمجرّد أنّ رقمه يحوي الحرف
  assert.equal(ids('3')[0], 'd');
  assert.ok(!ids('3').includes('b'), '112 يطابق «3» بالاحتواء');
});

test('ما ليس رقماً لا يُعامل رقماً: بادئة الجوال «05» والصفر البادئ يبقيان بحثاً بالجوال وحده', () => {
  assert.deepEqual(ids('0551112233'), ['a']);
  // «012» ليس رقم العميل 12: يطابق الجوال الذي يحويه وحده (0501234567)، لا صاحب #12
  assert.deepEqual(ids('012'), ['e']);
});

test('الجوال يُبحث به ولو كان التلميح رصيداً، والاسم التجاري والكود المخصّص كذلك — والكود الآلي (cuid) لا', () => {
  assert.deepEqual(ids('0559998877'), ['b'], 'جوال عميلٍ رصيده ظاهرٌ في التلميح');
  assert.deepEqual(ids('سمارة للتجارة'), ['a'], 'الاسم التجاري');
  assert.deepEqual(ids('rif-7'), ['c'], 'الكود المخصّص بلا حساسية حالة');
  assert.deepEqual(ids('cm3x9k2p'), [], 'الكود الآلي لا يُعرض ولا يُبحث به في القائمة');
});

test('بلا رقم (كاشٌ قديم أو عميلٌ دون اتصال): لا بادئة ولا مطابقة رقم، ويبقى بالاسم والجوال كما كان', () => {
  const old = options.find(o => o.value === 'e')!;
  assert.equal(old.num, null);
  assert.equal(formatCustomerNumber(old.num), '', 'بادئةٌ لعميلٍ بلا رقم');
  assert.deepEqual(ids('محل قديم'), ['e']);
  assert.deepEqual(ids('عميل جديد'), ['local-r1']);
});

// ═══ العرض ═══

test('بطاقات القائمة: «#12 · الاسم» برقمٍ ltr بأرقامٍ جدولية قبل الاسم، وسطر الجوال كما كان', () => {
  const list = customersFn.slice(customersFn.indexOf('shown.map(c =>'));
  assert.ok(list.includes('{formatCustomerNumber(c.number) && <><span dir="ltr" className="tabular-nums font-normal text-gray-400">{formatCustomerNumber(c.number)}</span><span className="font-normal text-gray-400">{\' · \'}</span></>}'));
  assert.ok(list.indexOf('formatCustomerNumber(c.number)') < list.indexOf('{c.name}\n'), 'الرقم قبل الاسم');
  assert.ok(list.includes('customerSubline(c.phone, c.city)'), 'سطر الجوال والمدينة');
});

test('صفحة العميل: «رقم العميل #12» تحت الاسم حين يوجد رقم فقط', () => {
  const at = detailFn.indexOf('<p className="font-bold text-lg">{customer.name}</p>');
  assert.ok(at >= 0);
  const head = detailFn.slice(at, detailFn.indexOf('{customer.businessName &&', at));
  assert.ok(head.includes('{formatCustomerNumber(customer.number) && ('), 'مشروطٌ بوجود الرقم');
  assert.ok(head.includes('{tr(\'رقم العميل\')} <span dir="ltr" className="tabular-nums">{formatCustomerNumber(customer.number)}</span>'));
});

// ═══ العميل المضاف دون اتصال: لا رقم محلياً ═══

test('العميل المضاف دون اتصال بلا رقمٍ مخترع، والمتصل يأخذ صفّ الخادم (ومعه رقمه) كما هو', () => {
  const offline = addFn.split('\n').find(l => l.includes("id: 'local-' + clientRef"));
  assert.ok(offline, 'سطر العميل المحلي');
  assert.equal(offline!.trim(), "onCreated({ ...custPayload, name: shownName, id: 'local-' + clientRef, clientRef, _offline: true, balance: 0, creditLimit: payload.creditLimit ?? 0, status: 'ACTIVE' });");
  assert.ok(!/\bnumber\s*:/.test(offline!), 'رقمٌ مخترع في العميل المحلي');
  // جسم الإضافة (المرسل للخادم والمصفوف دون اتصال) بلا number: الرقم يمنحه الخادم وحده ولا يُقبل من المستخدم
  const body = addFn.slice(addFn.indexOf('const body = {'), addFn.indexOf('};', addFn.indexOf('const body = {')));
  assert.ok(!/\bnumber\b/.test(body), 'number في جسم الإضافة');
  assert.ok(addFn.includes("const res = await repApi.post('/customers', payload);\n      onCreated(res.data.data);"), 'المتصل: صفّ الخادم كما هو');
  // ولا تعيين رقمٍ لعميلٍ في أي مكانٍ من التطبيق أو المزامنة
  for (const [name, src] of [['RepApp.tsx', repApp], ['offlineSync.ts', sync]] as const) {
    assert.ok(!/\b(c|customer|cust|merged|x)\.number\s*=(?!=)/.test(src), `${name}: تعيين رقم عميل محلياً`);
    assert.ok(!/customerSeq/.test(src), `${name}: عدّادٌ محلي`);
  }
  // الرفع من الصفّ يرسل العميل إلى POST /customers كما كان، والخادم يرقّمه
  assert.ok(sync.includes("k === 'customer' ? '/customers'"));
});

// ═══ خط السير ═══

test('خط السير: «#12 · الاسم» من customerNumber في ردّ الخادم، واحتياطاً من القائمة المخزّنة — ولا بادئة بلا رقم', () => {
  assert.ok(route.includes('customerNumber?: number | null;'), 'الحقل في RouteStop');
  assert.ok(route.includes("import { formatCustomerNumber } from '../lib/customerNumber';"));
  assert.ok(route.includes('<span className="truncate">{stopNumberPrefix(s.customerNumber ?? cachedNums[s.customerId])}{s.customerName}</span>'));
  assert.ok(route.includes("if (typeof c.number === 'number') nums[c.id] = c.number;"), 'الاحتياط من الكاش');
  const fn = route.slice(route.indexOf('function stopNumberPrefix('), route.indexOf('\n}\n', route.indexOf('function stopNumberPrefix(')));
  assert.ok(fn.includes('const s = formatCustomerNumber(n);\n  if (!s) return null;'), 'بلا رقم ⇒ لا شيء');
  assert.ok(fn.includes('<span dir="ltr" className="tabular-nums font-normal text-gray-500">{s}</span>'), 'الرقم ltr بأرقامٍ جدولية');
  // ما يثبّته حارس «خط السير» (locationGate.test.ts) باقٍ
  assert.match(route, /onClick=\{\(\) => onOpenCustomer\?\.\(s\.customerId\)\}/);
  assert.match(route, /cacheGet<any\[\]>\('customers'\)/);
  assert.match(route, /\{accountingOn && finance\[s\.customerId\] &&/);
});
