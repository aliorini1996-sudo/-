/**
 * تصفية التقارير بالاسم — الحالات التي تكسر تصفيةً ساذجة.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { norm, matches, filterFlat, filterNested } from './reportSearch';

test('التطبيع يوحّد الهمزات والتاء المربوطة والتشكيل والفراغات', () => {
  assert.equal(norm('أحمد'), norm('احمد'));
  assert.equal(norm('بقالة'), norm('بقاله'));
  assert.equal(norm('مُحَمَّد'), norm('محمد'));
  assert.equal(norm('  أسواق   الخير '), 'اسواق الخير');
  assert.equal(norm('ALI'), 'ali');
});

test('بحثٌ فارغ يطابق كل شيء', () => {
  assert.equal(matches('', 'أي شيء'), true);
  assert.equal(matches('   ', null), true);
  const rows = [{ name: 'أ' }, { name: 'ب' }];
  assert.equal(filterFlat(rows, '  ', r => [r.name]).length, 2);
});

test('يطابق جزءاً من الاسم وأي حقل مُمرَّر', () => {
  const rows = [
    { name: 'بقالة النور', phone: '0501234567', city: 'الرياض' },
    { name: 'أسواق الخير', phone: '0559999999', city: 'الدمام' },
  ];
  const f = (q: string) => filterFlat(rows, q, r => [r.name, r.phone, r.city]);
  assert.deepEqual(f('نور').map(r => r.name), ['بقالة النور']);
  assert.deepEqual(f('0559').map(r => r.name), ['أسواق الخير']);
  assert.deepEqual(f('الدمام').map(r => r.name), ['أسواق الخير']);
  assert.equal(f('لا يوجد').length, 0);
});

test('«احمد» بلا همزة تجد «أحمد» — الكتابة الشائعة لا تُخفي النتيجة', () => {
  const rows = [{ name: 'أحمد عبد الراضي' }];
  assert.equal(filterFlat(rows, 'احمد', r => [r.name]).length, 1);
  assert.equal(filterFlat(rows, 'أحمد', r => [r.name]).length, 1);
});

/* ── المعشَّش: مندوب ← عملاؤه ── */

interface C { name: string; businessName: string | null; balance: number }
interface P { id: string; name: string; customers: C[]; customersCount: number; debtorsCount: number; totalBalance: number }

const REPS: P[] = [
  { id: 'r1', name: 'محمد علاء', customersCount: 3, debtorsCount: 2, totalBalance: 5000,
    customers: [
      { name: 'بقالة النور', businessName: 'مؤسسة النور', balance: 3000 },
      { name: 'أسواق الخير', businessName: null, balance: 2000 },
      { name: 'تموينات الفجر', businessName: null, balance: 0 },
    ] },
  { id: 'r2', name: 'حسام', customersCount: 1, debtorsCount: 1, totalBalance: 900,
    customers: [{ name: 'سوبرماركت المدينة', businessName: null, balance: 900 }] },
];

const recount = (p: P, kept: C[]): P => ({
  ...p, customers: kept,
  customersCount: kept.length,
  debtorsCount: kept.filter(c => c.balance > 0).length,
  totalBalance: Math.round(kept.reduce((a, c) => a + c.balance, 0) * 100) / 100,
});
const run = (q: string) => filterNested(REPS, q, c => [c.name, c.businessName], recount);

test('مطابقة اسم المندوب تُبقي عملاءه كلّهم ومجاميعه كما هي', () => {
  const out = run('حسام');
  assert.equal(out.length, 1);
  assert.equal(out[0].customers.length, 1);
  assert.equal(out[0].totalBalance, 900);
});

test('مطابقة عميلٍ تكشف مندوبه وتُبقي المطابق وحده', () => {
  const out = run('النور');
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'محمد علاء', 'يُعرف مَن يتولّى هذا العميل');
  assert.deepEqual(out[0].customers.map(c => c.name), ['بقالة النور']);
});

test('**المجاميع تُعاد من المعروض** — لا إجماليَّ ثلاثةٍ فوق جدولِ واحد', () => {
  const out = run('النور');
  assert.equal(out[0].totalBalance, 3000, 'لا 5000');
  assert.equal(out[0].customersCount, 1);
  assert.equal(out[0].debtorsCount, 1);
});

test('يطابق النشاط التجاري لا الاسم وحده', () => {
  const out = run('مؤسسة');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].customers.map(c => c.name), ['بقالة النور']);
});

test('عميل برصيد صفر لا يُحتسب مديناً بعد التصفية', () => {
  const out = run('الفجر');
  assert.equal(out[0].customers.length, 1);
  assert.equal(out[0].debtorsCount, 0);
  assert.equal(out[0].totalBalance, 0);
});

test('بلا مطابقة ⇒ قائمة فارغة لا قائمة كاملة', () => {
  assert.equal(run('لا أحد بهذا الاسم').length, 0);
});

test('بحثٌ فارغ يُعيد المرجع نفسه بلا إعادة حساب', () => {
  const out = run('');
  assert.equal(out, REPS, 'لا نسخ ولا حساب حين لا بحث');
});

test('التصفية لا تُعدّل المصدر', () => {
  const before = JSON.stringify(REPS);
  run('النور');
  assert.equal(JSON.stringify(REPS), before);
});

/* ── «رقم العميل» (٢٣ نوفمبر ٢٠٢٦): مطابقةٌ تامّة لا جزءٌ من نصّ ── */

interface NC { name: string; phone: string; number: number | null }
// الجوالات لا تحوي «12» ولا «112» نصّاً — فما يُطابَق بها هو الرقم وحده
const NUMBERED: NC[] = [
  { name: 'بقالة النور', phone: '0502020202', number: 12 },
  { name: 'أسواق الخير', phone: '0503030303', number: 112 },
  { name: 'تموينات الفجر', phone: '0504040404', number: 120 },
  { name: 'سوبرماركت المدينة', phone: '0557654321', number: 1 },
  { name: 'عميل لم يُرقَّم', phone: '0506060606', number: null },
];
const byNum = (q: string) => filterFlat(NUMBERED, q, c => [c.name, c.phone], c => [c.number]).map(c => c.name);

test('رقم العميل: «12» و«#12» و«#١٢» و«۱۲» تجد #12 وحده', () => {
  for (const q of ['12', '#12', '# 12', '#١٢', '١٢', '۱۲', ' 12 ', '＃12']) {
    assert.deepEqual(byNum(q), ['بقالة النور'], q);
  }
});

test('رقم العميل: «12» لا تجد #112 ولا #120، و«1» لا تجد #10–#19 بالجزء', () => {
  assert.ok(!byNum('12').includes('أسواق الخير'), '#112 ليس 12');
  assert.ok(!byNum('12').includes('تموينات الفجر'), '#120 ليس 12');
  assert.deepEqual(byNum('112'), ['أسواق الخير']);
  assert.deepEqual(byNum('#1'), ['سوبرماركت المدينة'], '#1 وحده — لا #12 ولا #112 ولا #120');
});

test('رقم العميل «أو» مع النصّ: جوالٌ يحوي الأرقام نفسها يبقى مطابقاً', () => {
  // «7654» جزءٌ من جوال المدينة — ولا عميل بهذا الرقم: النصّ وحده يجده كما كان
  assert.deepEqual(byNum('7654'), ['سوبرماركت المدينة']);
  // «2020» رقمٌ صالح لا عميل به، وجزءٌ من جوال النور — يبقى مطابقاً بالنصّ
  assert.deepEqual(byNum('2020'), ['بقالة النور']);
  // «1» رقمُ المدينة تماماً — ولا يجد #12 ولا #112 ولا #120
  assert.deepEqual(byNum('1'), ['سوبرماركت المدينة']);
});

test('رقم العميل: صفرٌ بادئ (بادئة الجوال 05) ليس رقماً، والعميل بلا رقم لا يطابق رقماً', () => {
  // «05» نصٌّ يطابق الجوالات كلها كما كان — لا رقم عميل 5
  assert.equal(byNum('05').length, NUMBERED.length);
  assert.deepEqual(filterFlat(NUMBERED, '0', c => [c.name], c => [c.number]), []);
  assert.deepEqual(filterFlat(NUMBERED, '#', c => [c.name], c => [c.number]), []);
});

test('بلا `nums` يبقى البحث نصّياً كما كان حرفاً — الرقم لا يدخل حقول النصّ', () => {
  assert.deepEqual(filterFlat(NUMBERED, '12', c => [c.name]), [], 'لا مطابقة بلا مُوصِل الرقم');
  assert.deepEqual(filterFlat(NUMBERED, 'النور', c => [c.name], c => [c.number]).map(c => c.number), [12], 'النصّ كما كان');
  // بحثٌ فارغ يعيد المرجع نفسه ولو مُرِّر مُوصِل الرقم
  assert.equal(filterFlat(NUMBERED, '  ', c => [c.name], c => [c.number]), NUMBERED);
});

test('صفٌّ بأرقام عملاءٍ عدّة (مندوبٌ زار عملاء): يطابق متى كان أحدها الرقم تماماً', () => {
  const reps = [
    { name: 'محمد', visits: [{ n: 7 }, { n: 112 }] },
    { name: 'حسام', visits: [{ n: 12 }, { n: null }] },
  ];
  const f = (q: string) => filterFlat(reps, q, r => [r.name], r => r.visits.map(v => v.n)).map(r => r.name);
  assert.deepEqual(f('12'), ['حسام']);
  assert.deepEqual(f('#112'), ['محمد']);
  assert.deepEqual(f('11'), []);
});

/* ── المعشَّش برقم العميل: الابن المطابق برقمه وحده، ومجاميع أبيه من المعروض ── */

interface NCust { name: string; businessName: string | null; balance: number; number?: number | null }
interface NRep { id: string; name: string; customers: NCust[]; customersCount: number; debtorsCount: number; totalBalance: number }
const NREPS: NRep[] = [
  { id: 'r1', name: 'محمد علاء', customersCount: 3, debtorsCount: 2, totalBalance: 5000,
    customers: [
      { name: 'بقالة النور', businessName: null, balance: 3000, number: 12 },
      { name: 'أسواق الخير', businessName: null, balance: 2000, number: 112 },
      { name: 'تموينات الفجر', businessName: null, balance: 0, number: null },
    ] },
  { id: 'r2', name: 'حسام', customersCount: 1, debtorsCount: 1, totalBalance: 900,
    customers: [{ name: 'سوبرماركت المدينة', businessName: null, balance: 900, number: 120 }] },
];
const nrecount = (p: NRep, kept: NCust[]): NRep => ({
  ...p, customers: kept, customersCount: kept.length,
  debtorsCount: kept.filter(c => c.balance > 0).length,
  totalBalance: kept.reduce((a, c) => a + c.balance, 0),
});
const nrun = (q: string) => filterNested(NREPS, q, c => [c.name, c.businessName], nrecount, { childNums: c => [c.number] });

test('المعشَّش: «#12» يُبقي العميل #12 وحده تحت مندوبه ويُعيد حساب المجاميع', () => {
  for (const q of ['12', '#12', '#١٢']) {
    const out = nrun(q);
    assert.equal(out.length, 1, q);
    assert.equal(out[0].name, 'محمد علاء');
    assert.deepEqual(out[0].customers.map(c => c.number), [12], q);
    assert.equal(out[0].totalBalance, 3000, 'لا 5000');
    assert.equal(out[0].customersCount, 1);
  }
});

test('المعشَّش: «12» لا تجد #112 ولا #120، وبلا مُوصِل الرقم السلوك كما كان', () => {
  assert.ok(!nrun('12').some(r => r.customers.some(c => c.number === 112 || c.number === 120)));
  assert.deepEqual(nrun('120').map(r => r.name), ['حسام']);
  assert.deepEqual(filterNested(NREPS, '12', c => [c.name, c.businessName], nrecount), [], 'الاستدعاء القديم نصّيٌّ وحده');
  // مُوصِل رقم الأب: أبٌ عميلٌ برقمه يُبقي أبناءه كلّهم بمجاميعه
  const parents = NREPS.map((r, i) => ({ ...r, num: i === 0 ? 7 : null }));
  const out = filterNested(parents, '#7', c => [c.name], (p, kept) => ({ ...p, customers: kept }), { parentNums: p => [p.num] });
  assert.equal(out.length, 1);
  assert.equal(out[0].customers.length, 3, 'الأب المطابق برقمه كمطابقة اسمه');
});

/* ── حارس التوصيل: كل تقريرٍ يسرد عملاء في صفحة التقارير يطابق «رقم العميل» تماماً، ولا يدخل الرقم نصّاً مُطابَقاً ── */

test('حارس: مرشّحات صفحة التقارير وتقرير الربح تمرّر رقم العميل إلى nums لا إلى حقول النصّ', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8');
  const page = read('pages', 'ReportsPage.tsx');
  // كل مرشّحٍ يحمل عميلاً — مُوصِل رقمه حاضرٌ بنصّه
  for (const [label, accessor] of [
    ['المبيعات بتجميع العميل', "r => (groupBy === 'customer' ? [r.number] : [])"],
    ['الطلبات', 'o => [o.customer?.number]'],
    ['المرتجع', 'r => [r.customer?.number]'],
    ['التحصيل حسب المندوب', 'r => r.receipts.map(rc => rc.customer?.number)'],
    ['زيارات العملاء', 'v => [v.customerNumber]'],
    ['أداء المناديب', 'r => r.visits.map(v => v.customerNumber)'],
    ['ساعات العمل', 'r => r.days.flatMap(d => d.visits.map(v => v.customerNumber))'],
    ['مديونيات المندوب', '{ childNums: c => [c.number] }'],
  ] as const) {
    assert.ok(page.includes(accessor), `${label}: مُوصِل رقم العميل مفقود`);
  }
  // الأرصدة و«لم تتم زيارتهم»: الصفّ هو العميل
  assert.equal(page.split('}, c => [c.number]),').length - 1, 1, 'الأرصدة');
  assert.ok(page.includes('...c.reps], c => [c.number]),'), 'لم تتم زيارتهم');
  // الرقم لا يُصاغ «#N» إلا للعرض (CustNo وحده) — لا في حقول البحث ولا في التصدير
  assert.equal(page.split('formatCustomerNumber(').length - 1, 1, 'formatCustomerNumber في CustNo وحده');
  assert.ok(!/formatCustomerLabel\(|String\([^)]*\.(number|customerNumber)\)/.test(page), 'لا رقم عميلٍ نصّاً في الصفحة');
  // خانة البحث تذكر الرقم في التبويبات التي تسرد عملاء
  assert.ok(page.includes("searchByCustomerNo ? tr('اسم العميل أو رقمه أو المندوب') : tr('اسم العميل أو المندوب')"));

  const profit = read('components', 'reports', 'ProfitReport.tsx');
  assert.ok(profit.includes("(r) => (group === 'customer' ? [r.number] : [])"), 'الربح بتجميع العميل');
  assert.ok(profit.includes('filterFlat(rows, q, (r) => [profitRowName(r, group, tr), r.name, r.code],'), 'حقول نصّ الربح كما كانت');
  assert.ok(!/formatCustomerLabel\(|String\([^)]*\.number\)/.test(profit));
});
