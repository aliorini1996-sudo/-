// تقرير «العملاء الذين لم تتم زيارتهم» (طلب المالك ٩ نوفمبر ٢٠٢٦): العملاء النشطون بلا زيارة في الفترة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DAY_MS, buildUnvisitedRows, unvisitedRange, type UnvisitedCustomerIn } from '../services/unvisitedCustomers';

const src = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('الفترة: تعريف «زيارات العملاء» نفسه — يوم «إلى» كاملاً، وبلا تواريخ منذ البداية حتى الآن', () => {
  const now = new Date('2026-11-09T10:00:00Z');
  const r = unvisitedRange('2026-11-01', '2026-11-05', now);
  assert.ok(!('error' in r));
  assert.equal(r.fromDate.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(r.toEnd.toISOString(), '2026-11-06T00:00:00.000Z');
  assert.equal(r.hasFrom, true);
  const one = unvisitedRange('2026-11-03', '2026-11-03', now);
  assert.ok(!('error' in one) && one.toEnd.getTime() - one.fromDate.getTime() === DAY_MS, 'يوم واحد');
  const all = unvisitedRange(undefined, '', now);
  assert.ok(!('error' in all));
  assert.equal(all.fromDate.getTime(), 0);
  assert.equal(all.toEnd.getTime(), now.getTime());
  assert.equal(all.hasFrom, false);
  // «من» وحده: حتى الآن، ويومه كاملاً على الأقل فلا تنقلب النافذة (فجر الرياض ما زال أمسِ بـUTC، أو تاريخٌ قادم)
  const dawn = unvisitedRange('2026-11-09', '', new Date('2026-11-08T22:30:00Z'));
  assert.ok(!('error' in dawn));
  assert.equal(dawn.toEnd.toISOString(), '2026-11-10T00:00:00.000Z');
  const past = unvisitedRange('2026-11-01', undefined, now);
  assert.ok(!('error' in past));
  assert.equal(past.toEnd.getTime(), now.getTime(), '«من» ماضٍ ⇒ حتى الآن');
});

test('الفترة: تاريخ فاسد أو «من» بعد «إلى» ⇒ خطأ لا تقرير', () => {
  assert.deepEqual(unvisitedRange('2026-13-45x', '', new Date()), { error: 'تاريخ غير صالح' });
  assert.deepEqual(unvisitedRange('', 'yesterday', new Date()), { error: 'تاريخ غير صالح' });
  assert.deepEqual(unvisitedRange(['2026-11-01'], '', new Date()), { error: 'تاريخ غير صالح' }, 'تكرار المعامل في الاستعلام (مصفوفة) ⇒ خطأ لا تجاهل');
  assert.deepEqual(unvisitedRange('2026-11-06', '2026-11-05', new Date()), { error: 'تاريخ البداية بعد تاريخ النهاية' });
});

const cust = (id: string, name: string, reps: (string | null)[] = []): UnvisitedCustomerIn => ({
  id, name, businessName: null, phone: '05' + id, city: null, createdAt: new Date('2026-01-01T00:00:00Z'),
  assignments: reps.map(n => ({ salesRep: n === null ? null : { name: n } })),
});

test('الصفوف: يُستبعد من زِير، ومن لم يُزر قط أولاً ثم الأقدم زيارة ثم بالاسم، والمناديب بلا تكرار', () => {
  const rows = buildUnvisitedRows(
    [cust('a', 'بقالة النور', ['أحمد', 'أحمد', null, ' ']), cust('b', 'تموينات الخير'), cust('c', 'سوبر ماركت'), cust('d', 'أسواق'), cust('e', 'ألف')],
    ['c'],
    new Map([['a', new Date('2026-10-01')], ['b', new Date('2026-09-01')]]),
  );
  assert.deepEqual(rows.map(r => r.id), ['d', 'e', 'b', 'a'], 'd وe لم يُزارا قط (بالاسم)، ثم b الأقدم ثم a، وc زِير فاستُبعد');
  assert.deepEqual(rows.find(r => r.id === 'a')!.reps, ['أحمد']);
  assert.equal(rows.find(r => r.id === 'd')!.lastVisitAt, null);
  assert.deepEqual(buildUnvisitedRows([cust('x', 'س')], ['x'], new Map()), [], 'الكل زِير ⇒ لا صفوف');
});

test('الوصل: المسار محروس بصلاحية التقارير، ويحترم نطاق عملاء المستخدم، ويعدّ زيارات الشركة كلها في الفترة', () => {
  const r = src('routes', 'reports.ts');
  assert.match(r, /router\.use\(authenticate, requireAdmin, requireAdminPermission\('canViewReports'\)\)/);
  const route = r.slice(r.indexOf("router.get('/unvisited-customers'"), r.indexOf("router.get('/rep-receivables'"));
  assert.ok(route.length > 100, 'المسار موجود قبل مديونيات المندوب');
  assert.match(route, /Promise\.all\(\[adminCustomerFilter\(req\), adminRepFilter\(req\)\]\)/);
  assert.match(route, /status: 'ACTIVE', createdAt: \{ lt: toEnd \}, \.\.\.custScope/);
  // أسماء المناديب داخل نطاق المستخدم والنشطون وحدهم (قاعدة AND: عميلٌ ظاهر لا يكشف مندوباً خارج النطاق)
  assert.match(route, /assignments: \{ where: \{ salesRep: \{ isActive: true, \.\.\.repScope \} \}/);
  assert.match(route, /await visitedCustomerIds\(tid, fromDate, toEnd\)/);
  // حارس work-day.test.ts: لا عدّ خام للزيارات في الموجّه — الاستعلامان (وجودٌ وأقصى تاريخ، لا عدّ) في الخدمة
  assert.doesNotMatch(route, /repVisit\.(groupBy|count)\(/);
  const db = src('services', 'unvisitedCustomersDb.ts');
  assert.match(db, /prisma\.repVisit\.groupBy\(\{\s*by: \['customerId'\],\s*where: \{ tenantId: tid, createdAt: \{ gte: fromDate, lt: toEnd \} \},\s*\}\)/);
  assert.match(db, /createdAt: \{ lt: fromDate \} \},\s*_max: \{ createdAt: true \},/);
  assert.doesNotMatch(db, /_count|repVisit\.count\(/, 'لا عدّ في الخدمة أيضاً');
  assert.match(route, /res\.status\(400\)/);
  // تعريف الفترة نفسه في تقرير الزيارات (المكمّل)
  const visits = r.slice(r.indexOf("router.get('/customer-visits'"), r.indexOf("router.get('/unvisited-customers'"));
  assert.match(visits, /const toEnd = to \? new Date\(new Date\(to\)\.getTime\(\) \+ 24 \* 60 \* 60 \* 1000\) : new Date\(\);/);
});
