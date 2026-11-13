/**
 * دقّة التقارير (طلب المالك ١٣ نوفمبر ٢٠٢٦ — البنود ٢ و٦ و٧ و٩) على تطبيق الإدارة /m: حرّاسٌ ثابتة لشاشة التقارير
 * (m/MReports.tsx). سلوك الوحدة المشتركة (lib/reportsAccuracy) مختبَرٌ في pages/reportsAccuracy.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { perfCompanyRate } from '../lib/reportsAccuracy';

const src = () => fs.readFileSync(path.join(process.cwd(), 'src', 'm', 'MReports.tsx'), 'utf8');
/** جسم دالّة تقريرٍ في الملف — من توقيعها إلى التالية */
const body = (s: string, fn: string) => {
  const at = s.indexOf(`function ${fn}(`);
  assert.ok(at > 0, fn);
  const next = s.indexOf('\nfunction ', at + 10);
  return s.slice(at, next > 0 ? next : undefined);
};

test('البند ٢: الأرصدة بشارة «محظور/غير نشط» بجانب الاسم، والإجمالي من كل الصفوف كما يرسلها الخادم', () => {
  const b = body(src(), 'BalancesReport');
  assert.match(b, /const badge = customerStatusBadge\(c\.status\);/);
  // الاسم وحده يُقصّ والشارة لا تنكمش (سطر MRow مقصوص): اسمٌ تجاريٌّ طويل لا يدفعها إلى ما بعد «…»
  assert.match(b, /title=\{badge\s*\n?\s*\? <span className="flex items-center gap-1\.5 min-w-0"><span className="truncate min-w-0">\{c\.name\}<\/span><span className=\{`shrink-0 /);
  assert.match(b, /total: rows\.reduce\(\(s, c\) => s \+ c\.balance, 0\)/, 'الإجمالي يجمع الصفوف كلها — المحظور والموقوف منها');
  assert.ok(!/status === 'ACTIVE'|filter\(c => c\.status/.test(b), 'لا تُستبعد حالةٌ على الجهاز');
});

test('البند ٦: نسبة الشركة بتعريف الخادم (السندات + النقدي المحصَّل)، وبطاقة «مبيعات نقدية محصلة» وشرحها', () => {
  const s = src();
  const p = body(s, 'PerformanceReport');
  assert.match(p, /const rate = perfCompanyRate\(rows\);/);
  assert.ok(!p.includes('Math.round((sum.collected / sum.sales) * 100)'), 'عادت النسبة سنداتٍ وحدها');
  assert.match(p, /\{withCash && <MStat label=\{tr\('مبيعات نقدية محصلة'\)\} value=\{formatCurrency\(sum\.cash\)\} tone="good" icon=\{Banknote\} \/>\}/);
  // سبع بطاقات مع النقدي: الأخيرة بعرض الصفّ فلا تبقى وحيدةً في صفّها
  assert.match(p, /<div className=\{withCash \? 'col-span-2' : undefined\}>\s*<MStat label=\{tr\('المناديب'\)\}/);
  assert.match(p, /\{withCash && <Hint>\{tr\('نسبة التحصيل تشمل المبيعات النقدية المحصلة مع سندات القبض'\)\}<\/Hint>\}/);
  const d = body(s, 'PerfDetail');
  assert.match(d, /typeof row\.cashSalesTotal === 'number' && \(\s*<MStat label=\{tr\('مبيعات نقدية محصلة'\)\} value=\{formatCurrency\(row\.cashSalesTotal\)\} tone="good" icon=\{Banknote\} \/>/);
  assert.match(d, /<div className=\{typeof row\.cashSalesTotal === 'number' \? 'col-span-2' : undefined\}>\s*<MStat label=\{tr\('عدد الزيارات'\)\}/);
  // سيناريو التدقيق: مندوبٌ نقديّ بالكامل كان ٠٪ أحمر على الجوال
  assert.equal(perfCompanyRate([{ salesTotal: 15000, collectionsTotal: 0, cashSalesTotal: 15000 }]), 100);
});

test('البند ٧: الأداء والساعات والزيارات تقرأ علامة القصّ وتعرض تنبيهها', () => {
  const s = src();
  for (const fn of ['PerformanceReport', 'HoursReport', 'VisitsReport']) {
    const b = body(s, fn);
    assert.match(b, /truncationOf\(res\.data\)/, `${fn} يتجاهل علامة القصّ`);
    assert.match(b, /\{q\.data\?\.trunc\.truncated && <Note>\{truncText\(q\.data\.trunc, tr\)\}<\/Note>\}/, `${fn} بلا تنبيه`);
  }
});

test('البند ٩: المبيعات والساعات بتاريخي النافذة الافتراضية من الخادم — وقبل الردّ أو من خادمٍ أقدم التنبيه القائم', () => {
  const s = src();
  const sales = body(s, 'SalesReport');
  assert.match(sales, /applied: appliedRangeOf\(res\.data\)/);
  assert.match(sales, /\? defaultedRangeNote\(q\.data\.applied, tr\)\s*\n\s*: \(!from && !to \? tr\('بلا مدى محدد يعرض الخادم آخر تسعين يوما فقط'\) : null\)/);
  assert.match(sales, /\{rangeNote && <Hint>\{rangeNote\}<\/Hint>\}/);
  const hours = body(s, 'HoursReport');
  assert.match(hours, /applied: appliedRangeOf\(res\.data\)/);
  assert.match(hours, /: \(!from && !to \? tr\('بلا مدى محدد يعرض الخادم آخر سبعة أيام'\) : null\)/);
  assert.match(hours, /\{rangeNote && <Hint>\{rangeNote\}<\/Hint>\}/);
});
