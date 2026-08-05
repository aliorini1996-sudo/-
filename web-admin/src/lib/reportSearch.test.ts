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
