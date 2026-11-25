// «رقم العميل» في تطبيق الإدارة على الجوال /m (طلب المالك ٢٣ نوفمبر ٢٠٢٦): «في صفحة العملاء استبدل الكود برقم للعميل… يمكن استخدامه
// في بحث التقارير وبحث خطوط السير وكل الأماكن التي يبحث فيها». حرّاسٌ ثابتة على مصدر الشاشات — المنطق الصرف (المطابقة التامة في
// بحث التقارير وصفوف ورقة الاختيار) مختبَرٌ سلوكاً في mReportFilters.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');

test('MCustomers: الصفّ يعرض «#N» بدل الرمز، والترويسة «رقم العميل #N» بدل الرمز التلقائيّ', () => {
  const s = read('m', 'MCustomers.tsx');
  assert.ok(s.includes("subtitle={[formatCustomerNumber(c.number), c.phone, c.city].filter(Boolean).join(' · ') || tr('بلا بيانات')}"),
    'سطر الصفّ الثاني لا يبدأ برقم العميل');
  assert.ok(!s.includes('[c.code, c.phone, c.city]'), 'الرمز عاد إلى سطر الصفّ');
  assert.ok(!/subtitle=\{c\.code\}/.test(s), 'الرمز التلقائيّ (cuid) عاد إلى ترويسة العميل');
  assert.ok(s.includes("subtitle={c.number != null ? `${tr('رقم العميل')} #${c.number}` : '—'}"), 'الترويسة بلا رقم العميل');
  // لا يُعرض الرمز في أيّ موضعٍ من الشاشة (يبقى مخزَّناً ويُبحث على الخادم)
  assert.doesNotMatch(s, /\bc\.code\b/, 'الرمز معروضٌ في شاشة العملاء');
  assert.ok(s.includes("placeholder={tr('ابحث بالاسم أو الجوال أو رقم العميل')}"));
  assert.ok(!s.includes("'ابحث باسم أو جوال أو كود'"), 'العبارة القديمة («كود») باقية في البحث');
});

test('منتقيا العميل في فاتورة /m وسند القبض: «#N · الاسم» والجوال — بلا الرمز', () => {
  for (const f of ['MInvoiceCreate.tsx', 'MReceiptCreate.tsx']) {
    const s = read('m', f);
    assert.match(s, /import \{ formatCustomerLabel \} from '\.\.\/lib\/customerNumber';/, `${f}: لا مساعد العرض`);
    assert.match(s, /interface Pick \{[^}]*number\?: number \| null;?/, `${f}: صفّ العميل بلا رقمه`);
    assert.ok(s.includes('{formatCustomerLabel(c)}</span>'), `${f}: الاسم بلا رقم العميل`);
    assert.ok(!s.includes('[c.code, c.phone]'), `${f}: الرمز التلقائيّ عاد إلى السطر الثاني`);
    // البحث على الخادم كما كان: GET /customers يطابق الرقم تماماً (backend/routes/customers.ts)
    assert.match(s, /customerApi\.list\(\{ search: cq, limit: 40 \}\)/, `${f}: البحث لم يعد على الخادم`);
    // المستخدم يعرف أن الرقم يُكتب في البحث
    assert.ok(s.includes("placeholder={tr('ابحث بالاسم أو الجوال أو رقم العميل')}"), `${f}: البحث لا يذكر رقم العميل`);
  }
  assert.ok(read('m', 'MInvoiceCreate.tsx').includes("v={customer?.name ? formatCustomerLabel(customer) : '—'}"), 'المراجعة بلا رقم العميل');
});

test('إسناد العملاء للمندوب (/m): «#N» أوّل السطر الثاني، والبحث يذكر رقم العميل', () => {
  const s = read('m', 'MRepCustomers.tsx');
  assert.ok(s.includes("subtitle={[formatCustomerNumber(c.number), c.businessName || c.phone].filter(Boolean).join(' · ')}"));
  assert.ok(!s.includes('c.phone || c.code'), 'الرمز التلقائيّ عاد بديلاً');
  assert.ok(s.includes("placeholder={tr('ابحث بالاسم أو الجوال أو رقم العميل')}"));
});

test('ورقة «اختر العميل» في التقارير: الصفوف من customerPickItems (الرقم والمطابق أوّلاً) لا الرمز التلقائيّ', () => {
  const s = read('m', 'MReportFilterBar.tsx');
  assert.match(s, /if \(kind === 'customer'\) return customerPickItems\(custQ\.data \?\? \[\], dq\);/);
  assert.ok(!s.includes('[c.businessName, c.code, c.phone]'), 'الرمز التلقائيّ عاد إلى السطر الثاني');
  // الشريحة تعرض اسم المختار كما حُفظ — وهو «#N · الاسم» من customerPickItems
  assert.ok(s.includes('onPick({ id: it.id, name: it.name })'));
  assert.ok(s.includes("'ابحث بالاسم أو الجوال أو رقم العميل'"));
  const f = read('m', 'mReportFilters.ts');
  assert.match(f, /name: formatCustomerLabel\(c\),/);
  assert.match(f, /visibleCustomerCode\(c\.code\)/, 'الرمز المخصّص (Odoo وغيره) يبقى مرئياً');
});

test('بحث التقارير في /m: كل تقريرٍ صفوفه عملاء يمرّر رقم العميل مُوصِلاً — ولا رقمٌ في extra (احتواء)', () => {
  const s = read('m', 'MReports.tsx');
  const acc = (name: string) => {
    const i = s.indexOf(`const ${name}: RowAccess<`);
    assert.ok(i > 0, `${name} غائب`);
    return s.slice(i, s.indexOf('};', i) + 2);
  };
  assert.match(acc('COLL_ACC'), /number: r => r\.customer\.number,/, 'التحصيل: رقم العميل لا رقم السند');
  assert.match(acc('COLL_ACC'), /extra: r => \[r\.number, r\.salesRep\?\.name\]/, 'رقم السند يبقى بحثاً بالاحتواء كما كان');
  assert.match(acc('BAL_ACC'), /number: c => c\.number/);
  assert.match(acc('UNVISITED_ACC'), /number: c => c\.number,/);
  assert.match(acc('VISIT_ACC'), /number: g => g\.customerNumber,/);
  assert.match(s, /customerNumber: vs\[0\]\.customerNumber \?\? null,/, 'تجميع الزيارات يُسقط رقم العميل');
  // المبيعات عبر salesAccess (مستوى العميل وحده)
  assert.match(s, /rep: salesAccess\('rep'\), customer: salesAccess\('customer'\), product: salesAccess\('product'\),/);
  for (const name of ['COLL_ACC', 'BAL_ACC', 'UNVISITED_ACC', 'VISIT_ACC']) {
    assert.doesNotMatch(acc(name).split('number:')[0], /String\([^)]*number|customerNumber|c\.number|customer\.number/,
      `${name}: رقم العميل في extra — «12» تجد #120 بالاحتواء`);
  }
  const f = read('m', 'mReportFilters.ts');
  assert.match(f, /matchesSearch\(q, \[acc\.name\(r\), \.\.\.\(acc\.extra\?\.\(r\) \?\? \[\]\)\]\) \|\| matchesCustomerNumber\(q, acc\.number\?\.\(r\)\)/);
  assert.match(f, /if \(!searching \|\| rowHit\(q, row, pa\)\)/, 'التجميع المتداخل: الأب');
  assert.match(f, /const hit = subs\.filter\(s => rowHit\(q, s, sa\)\);/, 'التجميع المتداخل: الفروع');
});

test('عرض رقم العميل في قوائم التقارير: «#N · الاسم» حيث الصفّ عميل، والأرصدة في عنوانها قبل الاسم (العمر أوّل السطر الثاني)', () => {
  const s = read('m', 'MReports.tsx');
  assert.match(s, /import \{ formatCustomerLabel \} from '\.\.\/lib\/customerNumber';/);
  assert.match(s, /return level === 'customer' \? formatCustomerLabel\(r\) : r\.name;/, 'المبيعات حسب العميل');
  assert.match(s, /title=\{levelName\(r, groupBy, tr\)\}/, 'الصفوف المسطّحة بالاسم الخام');
  assert.match(s, /title=\{formatCustomerLabel\(r\.customer\)\}/, 'التحصيل');
  // الأرصدة: السطر الثاني للعمر أوّلاً («عمر الدين»)، فالرقم في العنوان قبل الاسم
  assert.match(s, /<span className="truncate min-w-0">\{formatCustomerLabel\(c\)\}<\/span>/, 'الأرصدة (بشارة)');
  assert.match(s, /subtitle=\{\[ageText\(c\), c\.phone, /, 'الأرصدة: العمر أوّل السطر الثاني');
  assert.match(s, /title=\{formatCustomerLabel\(\{ name: c\.name \|\| tr\('عميل بلا اسم'\), number: c\.number \}\)\}/, 'لم تتم زيارتهم');
  assert.match(s, /title=\{formatCustomerLabel\(\{ name: g\.customerName \|\| tr\('عميل بلا اسم'\), number: g\.customerNumber \}\)\}/, 'الزيارات');
  // Initial (الحرف الأول) من الاسم لا من «#»
  assert.doesNotMatch(s, /<Initial name=\{formatCustomerLabel/);
});

test('كشف حساب العميل في /m: «#N · الاسم» في الترويسة', () => {
  const s = read('m', 'MCustomerStatement.tsx');
  assert.ok(s.includes("subtitle={formatCustomerLabel(customer)}"));
});
