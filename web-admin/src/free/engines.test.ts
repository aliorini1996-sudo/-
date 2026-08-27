import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCommission, computeVanReconciliation, computeRepsNeeded, computeAging,
  type CommissionTier,
} from './engines';

const TIERS: CommissionTier[] = [
  { from: 0, to: 50000, pct: 1 },
  { from: 50000, to: 100000, pct: 2 },
  { from: 100000, to: Infinity, pct: 3 },
];

/* ------------------------- العمولة ------------------------- */

test('العمولة التدرّجية تحسب كل شريحة على جزئها فقط', () => {
  // 50,000×1% = 500 · 50,000×2% = 1,000 · 20,000×3% = 600 ⇒ 2,100
  const r = computeCommission({ sales: 120000, tiers: TIERS });
  assert.equal(r.total, 2100);
  assert.equal(r.rows.length, 3);
});

test('مبيعات داخل الشريحة الأولى لا تلمس ما بعدها', () => {
  const r = computeCommission({ sales: 30000, tiers: TIERS });
  assert.equal(r.total, 300);
  assert.equal(r.rows.length, 1);
});

test('حدّ الشريحة بالضبط لا يُحتسب مرّتين', () => {
  const r = computeCommission({ sales: 50000, tiers: TIERS });
  assert.equal(r.total, 500); // لا 500+0 من الشريحة الثانية
  assert.equal(r.rows.length, 1);
});

test('المرتجعات تُخصم من الأساس ولا تجعله سالباً', () => {
  const r = computeCommission({ sales: 60000, returns: 10000, tiers: TIERS });
  assert.equal(r.base, 50000);
  assert.equal(r.total, 500);
  const neg = computeCommission({ sales: 1000, returns: 9999, tiers: TIERS });
  assert.equal(neg.base, 0);
  assert.equal(neg.total, 0);
});

test('الأرضية ترفع العمولة الضعيفة وتُوسم', () => {
  const r = computeCommission({ sales: 1000, tiers: TIERS, floor: 300 });
  assert.equal(r.raw, 10);
  assert.equal(r.total, 300);
  assert.equal(r.adjusted, 'floor');
});

test('السقف يحدّ العمولة العالية ويُوسم', () => {
  const r = computeCommission({ sales: 500000, tiers: TIERS, cap: 5000 });
  assert.ok(r.raw > 5000);
  assert.equal(r.total, 5000);
  assert.equal(r.adjusted, 'cap');
});

test('غير التدرّجي يطبّق نسبة الشريحة على كامل الأساس', () => {
  const r = computeCommission({ sales: 120000, tiers: TIERS, progressive: false });
  assert.equal(r.total, 3600); // 120,000 × 3%
});

test('صفر مبيعات ⇒ صفر عمولة بلا انهيار', () => {
  const r = computeCommission({ sales: 0, tiers: TIERS });
  assert.equal(r.total, 0);
  assert.equal(r.rows.length, 0);
});

/* ------------------------- عهدة السيارة ------------------------- */

test('معادلة الاتزان: المرتجع يُضاف والتالف يُطرح', () => {
  // 20 + 30 − 38 + 2 − 1 = 13
  const r = computeVanReconciliation([
    { code: 'P-1', opening: 20, loaded: 30, sold: 38, returned: 2, damaged: 1, counted: 13 },
  ]);
  assert.equal(r.lines[0].expected, 13);
  assert.equal(r.lines[0].diff, 0);
  assert.equal(r.balanced, true);
});

test('العجز سالب والزيادة موجبة، والقيمة تُحسب بالتكلفة', () => {
  const r = computeVanReconciliation([
    { code: 'A', opening: 10, loaded: 0, sold: 0, returned: 0, damaged: 0, counted: 8, unitCost: 25 },
    { code: 'B', opening: 10, loaded: 0, sold: 0, returned: 0, damaged: 0, counted: 12, unitCost: 25 },
  ]);
  assert.equal(r.lines[0].diff, -2);
  assert.equal(r.lines[1].diff, 2);
  assert.equal(r.totalShortageUnits, 2);
  assert.equal(r.totalSurplusUnits, 2);
  // قيمة العجز موجبة دائماً (مبلغ خسارة لا رقم سالب)
  assert.equal(r.totalShortageValue, 50);
  assert.equal(r.balanced, false);
});

/* ------------------------- عدد المناديب ------------------------- */

test('عدد المناديب يُقرَّب لأعلى — لا نصف مندوب', () => {
  // 100 منفذ × 4 زيارات = 400 ÷ (25×24=600) = 0.67 ⇒ 1
  const r = computeRepsNeeded({ outlets: 100, visitsPerMonth: 4, visitsPerDay: 25, workDays: 24 });
  assert.equal(r.reps, 1);
  assert.equal(r.valid, true);
});

test('الحساسية ±٢٠٪: إنتاجية أعلى ⇒ مناديب أقلّ أو مساوٍ', () => {
  const r = computeRepsNeeded({ outlets: 600, visitsPerMonth: 4, visitsPerDay: 20, workDays: 24 });
  assert.ok(r.low <= r.reps);
  assert.ok(r.high >= r.reps);
});

test('القسمة على صفر تُرجع valid=false لا Infinity', () => {
  const r = computeRepsNeeded({ outlets: 100, visitsPerMonth: 4, visitsPerDay: 0, workDays: 24 });
  assert.equal(r.valid, false);
  assert.equal(r.reps, 0);
  assert.ok(Number.isFinite(r.exact));
});

/* ------------------------- أعمار الدين ------------------------- */

test('أعمار الدين توزّع المبالغ على الشرائح الصحيحة', () => {
  const r = computeAging([
    { amount: 1000, daysOverdue: 0 },
    { amount: 2000, daysOverdue: 15 },
    { amount: 3000, daysOverdue: 45 },
    { amount: 4000, daysOverdue: 120 },
  ]);
  assert.equal(r.total, 10000);
  assert.equal(r.overdueTotal, 9000); // كل ما تجاوز 0 يوم
  // بالموضع لا بنصّ التسمية: التسمية نصُّ عرضٍ تغيّرت شرطته فانكسر البحث،
  // وترتيب الشرائح ثابت بحكم التعريف
  assert.equal(r.buckets[1].amount, 2000, r.buckets[1].label);
  assert.equal(r.buckets[4].amount, 4000, r.buckets[4].label);
});

test('حدّ الائتمان المقترح يتناسب مع مدّة السداد', () => {
  const a = computeAging([], 30000, 30);
  const b = computeAging([], 30000, 60);
  assert.equal(a.suggestedLimit, 30000);
  assert.equal(b.suggestedLimit, 60000);
});
