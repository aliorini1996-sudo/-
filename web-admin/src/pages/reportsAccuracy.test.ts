/**
 * دقّة التقارير (طلب المالك ١٣ نوفمبر ٢٠٢٦ — البنود ٢ و٦ و٧ و٩) على الويب: سلوك وحدة lib/reportsAccuracy الصرفة، وحرّاسٌ ثابتة
 * لصفحة التقارير (pages/ReportsPage.tsx) تمنع عودة الحساب من القائمة المقصوصة أو «كل الفترات» فوق نافذةٍ افتراضية.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  appliedRangeOf, truncationOf, rangeText, periodText, defaultedRangeNote, truncationNote,
  customerStatusLabel, customerStatusBadge, hasCustomerStatus, perfHasCash, perfCompanyRate, rateBarWidth, listTotals,
} from '../lib/reportsAccuracy';

const tr = (s: string) => s;
const fmt = (n: number) => n.toLocaleString('en-US');
const page = () => fs.readFileSync(path.join(process.cwd(), 'src', 'pages', 'ReportsPage.tsx'), 'utf8');

// ═══ البند ٩: المدى المطبَّق ═══

test('appliedRangeOf: يقرأ meta.appliedRange أعلى الردّ — ولو كانت data مصفوفة تجميع', () => {
  const body = { success: true, data: [{ name: 'أحمد', total: 10 }], meta: { appliedRange: { from: '2026-08-15', to: '2026-11-13', defaulted: true } } };
  assert.deepEqual(appliedRangeOf(body), { from: '2026-08-15', to: '2026-11-13', defaulted: true });
  // طرفٌ واحد: الآخر بلا حدّ
  assert.deepEqual(appliedRangeOf({ data: {}, meta: { appliedRange: { from: '2026-11-01', to: null, defaulted: false } } }),
    { from: '2026-11-01', to: null, defaulted: false });
});

test('appliedRangeOf: خادمٌ أقدم أو قيمةٌ تالفة ⇒ null (العرض كما كان)', () => {
  assert.equal(appliedRangeOf({ success: true, data: [] }), null);
  assert.equal(appliedRangeOf(null), null);
  assert.equal(appliedRangeOf({ meta: { appliedRange: { from: null, to: null, defaulted: true } } }), null);
  assert.equal(appliedRangeOf({ meta: { appliedRange: 'كل الفترات' } }), null);
  // احتياطاً: meta داخل data
  assert.deepEqual(appliedRangeOf({ data: { meta: { appliedRange: { from: '2026-11-07', to: '2026-11-13', defaulted: true } } } }),
    { from: '2026-11-07', to: '2026-11-13', defaulted: true });
});

test('رأس PDF: بلا إعلانٍ من الخادم نصوص اليوم حرفاً، ومعه المدى المطبَّق موسوماً بالافتراضي', () => {
  assert.equal(periodText(null, '', '', tr), 'كل الفترات');
  assert.equal(periodText(null, '2026-11-01', '', tr), 'من 2026-11-01');
  assert.equal(periodText(null, '', '2026-11-30', tr), 'إلى 2026-11-30');
  assert.equal(periodText(null, '2026-11-01', '2026-11-30', tr), '2026-11-01 — 2026-11-30');
  // سيناريو التدقيق: لا تواريخ ⇒ كان يُطبع «كل الفترات» فوق تسعين يوماً
  assert.equal(periodText({ from: '2026-08-15', to: '2026-11-13', defaulted: true }, '', '', tr), '2026-08-15 — 2026-11-13 (مدى افتراضي من الخادم)');
  // ساعات العمل: ثلاثة أشهر طُلبت فقُصّت إلى ٣١ يوماً — يُطبع المقصوص لا المطلوب
  assert.equal(periodText({ from: '2026-03-01', to: '2026-03-31', defaulted: false }, '2026-01-01', '2026-03-31', tr), '2026-03-01 — 2026-03-31');
  assert.equal(rangeText(null, '2026-03-31', tr), 'إلى 2026-03-31');
});

test('تنبيه الشاشة للنافذة الافتراضية بتاريخيها — ولا شيء لمدىً حدّده المستخدم', () => {
  assert.equal(defaultedRangeNote({ from: '2026-08-15', to: '2026-11-13', defaulted: true }, tr),
    'بلا تحديد مدة يعرض الخادم الفترة من 2026-08-15 إلى 2026-11-13 فقط');
  assert.equal(defaultedRangeNote({ from: '2026-11-01', to: '2026-11-13', defaulted: false }, tr), null);
  assert.equal(defaultedRangeNote(null, tr), null);
  // النافذة الافتراضية بلا حدٍّ أعلى (يُعلنها الخادم to = null: الطلبات القادمة تسليماً داخلة) — يقال «فصاعداً» لا «إلى … فقط»
  assert.equal(defaultedRangeNote({ from: '2026-08-15', to: null, defaulted: true }, tr), 'بلا تحديد مدة يعرض الخادم من 2026-08-15 فصاعدا');
  assert.equal(periodText({ from: '2026-08-15', to: null, defaulted: true }, '', '', tr), 'من 2026-08-15 (مدى افتراضي من الخادم)');
});

test('الطلبات: المدى المطبَّق كما أعلنه الخادم بلا تعديلٍ في الصفحة — الخادم نفسه يعلن الطرف الأعلى المفتوح', () => {
  const s = page();
  const at = s.indexOf("queryKey: ['report-orders'");
  assert.ok(at > 0);
  const q = s.slice(at, s.indexOf('enabled:', at));
  assert.match(q, /applied: appliedRangeOf\(res\.data\), trunc: truncationOf\(res\.data\)/);
  assert.equal(q.includes('to: null'), false, 'لا تصحيح على العميل');
});

// ═══ البند ٧: القصّ ═══

test('truncationOf: meta.truncated والسقف — وغيابه أو false ⇒ لا قصّ', () => {
  assert.deepEqual(truncationOf({ data: { count: 3, visits: [] }, meta: { truncated: true, limit: 200000 } }), { truncated: true, limit: 200000 });
  assert.deepEqual(truncationOf({ data: [], meta: { truncated: false, limit: 200000 } }), { truncated: false, limit: null });
  assert.deepEqual(truncationOf({ data: [] }), { truncated: false, limit: null });
  assert.deepEqual(truncationOf({ data: [], truncated: true }), { truncated: true, limit: null }, 'احتياطاً: علامةٌ أعلى الردّ');
});

test('نصّ القصّ: الزيارات «أحدث N سجل»، والقائمة «مقطوعة عند N» والإجماليات كاملة', () => {
  assert.equal(truncationNote({ truncated: true, limit: 200000 }, tr, fmt, 'newest'), 'عرض أحدث 200,000 سجل فقط — ضيق الفترة لنتيجة كاملة');
  assert.equal(truncationNote({ truncated: true, limit: 5000 }, tr, fmt, 'list', 5000),
    'القائمة مقطوعة عند 5,000 سجل والإجماليات أعلاه تشمل الفترة كاملة — ضيق الفترة لعرض كل السجلات');
  // بلا سقفٍ معلَن: صفوف القائمة الواصلة هي السقف نفسه
  assert.match(truncationNote({ truncated: true, limit: null }, tr, fmt, 'list', 4999) ?? '', /4,999/);
  assert.equal(truncationNote({ truncated: true, limit: null }, tr, fmt, 'newest'), 'النتيجة مقطوعة عند الحد الأقصى — ضيق الفترة لنتيجة كاملة');
  assert.equal(truncationNote({ truncated: false, limit: 200000 }, tr, fmt, 'newest'), null);
  assert.equal(truncationNote(undefined, tr, fmt, 'list'), null);
  // في الملف لا بطاقات «أعلاه»: الإجمالي ورقةٌ في أوّله
  assert.equal(truncationNote({ truncated: true, limit: 5000 }, tr, fmt, 'listExport', 5000),
    'القائمة مقطوعة عند 5,000 سجل والإجمالي في أول الملف يشمل الفترة كاملة — ضيق الفترة لعرض كل السجلات');
  assert.equal(truncationNote({ truncated: false, limit: 5000 }, tr, fmt, 'listExport'), null);
});

test('تصدير المرتجع والطلبات المقطوعين: ورقة «الإجمالي» أوّل الملف من إجماليّ الشاشة، وتنبيه الملف يحيل إليها لا إلى «أعلاه»', () => {
  const s = page().replace(/\r\n/g, '\n');
  const ret = s.indexOf("fname = tr('تقرير المرتجع');");
  const retTotals = s.lastIndexOf("if (returnsQ.data?.trunc.truncated) sheets.unshift({ name: tr('الإجمالي'), rows: [{", ret);
  assert.ok(retTotals > 0 && ret - retTotals < 900, 'ورقة إجمالي المرتجع');
  const rt = s.slice(retTotals, ret);
  for (const k of ["[tr('عدد المرتجعات')]: returnTotals.count", "[tr('إجمالي قيمة المرتجعات')]: num(returnTotals.total)", "tr('نسبة المرتجع من المبيعات')", 'summary.byReason']) {
    assert.ok(rt.includes(k), k);
  }
  const ord = s.indexOf("fname = tr('تقرير الطلبات');");
  const ordTotals = s.lastIndexOf("if (ordersQ.data?.trunc.truncated) sheets.unshift({ name: tr('الإجمالي'), rows: [{", ord);
  assert.ok(ordTotals > 0 && ord - ordTotals < 500, 'ورقة إجمالي الطلبات');
  const ot = s.slice(ordTotals, ord);
  for (const k of ['orderTotals.count', 'num(orderTotals.total)', 'num(orderTotals.remaining)']) assert.ok(ot.includes(k), k);
  // تنبيه الملف (رأس PDF وورقة «الفترة») بنصّ التصدير، وتنبيه الشاشة بنصّها
  assert.match(s, /salesType === 'orders' \? truncText\(ordersQ\.data\?\.trunc, 'listExport'/);
  assert.match(s, /salesType === 'returns' \? truncText\(returnsQ\.data\?\.trunc, 'listExport'/);
  assert.match(s, /\{truncText\(returnsQ\.data\.trunc, 'list', returnsQ\.data\.returns\.length\)\}/);
  assert.match(s, /\{truncText\(ordersQ\.data\.trunc, 'list', ordersQ\.data\.orders\.length\)\}/);
});

test('البند ٦ في الملف: شرح «نسبة التحصيل» يرافق PDF وExcel الأداء حين يرسل الخادم النقدي المحصَّل', () => {
  const s = page().replace(/\r\n/g, '\n');
  assert.match(s, /const perfRateNote = tab === 'performance' && perfType === 'performance' && perfCash\s*\n\s*\? tr\('نسبة التحصيل تشمل المبيعات النقدية المحصلة مع سندات القبض'\) : null;/);
  assert.match(s, /const exportNote: string \| null = \[activeTruncText, perfRateNote\]\.filter\(Boolean\)\.join\(' — '\) \|\| null;/);
  // تحت رأس PDF وفي ورقة «الفترة» — لا تنبيه القصّ وحده
  assert.match(s, /const truncLine = exportNote \?/);
  assert.match(s, /const periodSheets = \(title: string\): ExcelSheet\[\] => \(activeApplied \|\| exportNote \?/);
  assert.match(s, /\.\.\.\(exportNote \? \{ \[tr\('ملاحظة'\)\]: exportNote \} : \{\}\),/);
});

test('إجماليات المرتجع والطلبات: بلا بحثٍ من ملخّص الخادم ولو قُصّت القائمة — ومع البحث من المعروض', () => {
  // سيناريو التدقيق: ٦٣٠٠ مرتجع في المدى، والقائمة ٥٠٠٠ فقط
  const rows = Array.from({ length: 5000 }, () => ({ total: 10 }));
  assert.deepEqual(listTotals({ count: 6300, total: 63000 }, rows, r => r.total, false), { count: 6300, total: 63000 });
  assert.deepEqual(listTotals({ count: 6300, total: 63000 }, rows.slice(0, 3), r => r.total, true), { count: 3, total: 30 });
  assert.deepEqual(listTotals(undefined, rows.slice(0, 2), r => r.total, false), { count: 2, total: 20 }, 'بلا ملخّص: من الصفوف كما كان');
});

// ═══ البند ٢: حالة العميل ═══

test('حالة العميل: شارةٌ للمحظور والموقوف وحدهما، ونصّ عمود Excel للثلاث', () => {
  assert.equal(customerStatusBadge('BLOCKED'), 'محظور');
  assert.equal(customerStatusBadge('INACTIVE'), 'غير نشط');
  assert.equal(customerStatusBadge('ACTIVE'), null);
  assert.equal(customerStatusBadge(undefined), null);
  assert.equal(customerStatusLabel('ACTIVE'), 'نشط');
  assert.equal(customerStatusLabel('BLOCKED'), 'محظور');
  assert.equal(customerStatusLabel(undefined), '');
  assert.equal(hasCustomerStatus([{ status: 'ACTIVE' }]), true);
  assert.equal(hasCustomerStatus([{}]), false, 'خادمٌ أقدم ⇒ لا عمود');
  assert.equal(hasCustomerStatus(undefined), false);
});

// ═══ البند ٦: نسبة التحصيل ═══

test('نسبة التحصيل: (السندات + البيع النقدي المحصَّل) ÷ صافي المبيعات — سيناريوهات التدقيق', () => {
  // A: نقدي ١٠٬٠٠٠ وآجل ١٠٬٠٠٠ حُصّل بسندات ١٠٬٠٠٠ ⇒ ١٠٠٪ (كانت ٥٠٪)
  assert.equal(perfCompanyRate([{ salesTotal: 20000, collectionsTotal: 10000, cashSalesTotal: 10000 }]), 100);
  // B: نقدي ١٥٬٠٠٠ بلا آجل ⇒ ١٠٠٪ (كانت ٠٪ حمراء)
  assert.equal(perfCompanyRate([{ salesTotal: 15000, collectionsTotal: 0, cashSalesTotal: 15000 }]), 100);
  // الشركة من المجاميع لا متوسّط النسب
  assert.equal(perfCompanyRate([
    { salesTotal: 15000, collectionsTotal: 0, cashSalesTotal: 15000 },
    { salesTotal: 10000, collectionsTotal: 3000, cashSalesTotal: 0 },
  ]), 72);
  // خادمٌ أقدم بلا الحقل ⇒ السندات وحدها كما كانت
  assert.equal(perfCompanyRate([{ salesTotal: 20000, collectionsTotal: 10000 }]), 50);
  assert.equal(perfCompanyRate([{ salesTotal: 0, collectionsTotal: 500, cashSalesTotal: 0 }]), 0);
  assert.equal(perfHasCash([{ salesTotal: 1, collectionsTotal: 0, cashSalesTotal: 0 }]), true);
  assert.equal(perfHasCash([{ salesTotal: 1, collectionsTotal: 0 }]), false);
  // الشريط بين ٠ و١٠٠ — سندات ديونٍ قديمة قد ترفع النسبة فوقها
  assert.equal(rateBarWidth(140), 100);
  assert.equal(rateBarWidth(-5), 0);
  assert.equal(rateBarWidth(37), 37);
});

// ═══ حرّاس صفحة التقارير ═══

test('حارس البند ٢: الأرصدة بشارة الحالة وعمود «الحالة» في التصدير حين يرسلها الخادم، والبحث بها', () => {
  const s = page();
  assert.match(s, /return res\.data\.data as BalanceRow\[\];/);
  assert.match(s, /const balHasStatus = hasCustomerStatus\(balancesData\);/);
  assert.match(s, /\.\.\.\(balHasStatus && \{ \[tr\('الحالة'\)\]: tr\(customerStatusLabel\(c\.status\)\) \}\)/);
  assert.match(s, /\{customerStatusBadge\(c\.status\) && \(/, 'الشارة بجانب الاسم في الجدول');
  assert.match(s, /return \[c\.name, c\.phone, badge \? tr\(badge\) : null\];/);
});

test('حارس البند ٦: عمود «مبيعات نقدية محصلة» وشرح النسبة وقصّ الشريط، وورقتا التصدير من مصدرٍ واحد', () => {
  const s = page();
  assert.match(s, /const perfCash = perfHasCash\(perfData\);/);
  assert.match(s, /\{perfCash && <th>\{tr\('مبيعات نقدية محصلة'\)\}<\/th>\}/);
  assert.match(s, /\{perfCash && <td className="text-green-600">\{formatCurrency\(r\.cashSalesTotal \?\? 0\)\}<\/td>\}/);
  assert.match(s, /style=\{\{ width: `\$\{rateBarWidth\(r\.collectionRate\)\}%` \}\}/);
  assert.ok(!s.includes('style={{ width: `${r.collectionRate}%` }}'), 'الشريط بلا قصّ يفيض فوق ١٠٠٪');
  assert.match(s, /tr\('نسبة التحصيل تشمل المبيعات النقدية المحصلة مع سندات القبض'\)/);
  assert.match(s, /colSpan=\{perfCash \? 10 : 9\}/);
  assert.match(s, /rows: perfRows\.map\(r => perfSheetRow\(r, perfCash\)\), colWidths: perfColWidths\(perfCash\)/);
  assert.match(s, /\[perfSheetRow\(r, withCash\)\]/, 'ملف المندوب الواحد من صفّ الورقة نفسه');
  assert.match(s, /\.\.\.\(withCash && \{ \[tr\('مبيعات نقدية محصلة'\)\]: num\(r\.cashSalesTotal \?\? 0\) \}\)/);
});

test('حارس البند ٧: المرتجع والطلبات من ملخّص الخادم، وعلامة القصّ مقروءة لكل تقرير مقصوص', () => {
  const s = page();
  assert.match(s, /listTotals\(returnsQ\.data\?\.summary, returnRows, r => Number\(r\.total \|\| 0\), !!q\)/);
  assert.match(s, /listTotals\(sm, orderRows, o => Number\(o\.total \|\| 0\), !!q\)/);
  assert.ok(!/count: returnRows\.length,\s*\n\s*total: Math\.round\(returnRows\.reduce/.test(s), 'عاد عدّ المرتجع من القائمة المقصوصة');
  // كل تقريرٍ مقصوص يقرأ العلامة من meta
  for (const key of ['report-orders', 'report-returns', 'report-customer-visits', 'report-performance', 'report-rep-ranking', 'report-work-hours']) {
    const at = s.indexOf(`queryKey: ['${key}'`);
    assert.ok(at > 0, key);
    assert.match(s.slice(at, s.indexOf('enabled:', at)), /truncationOf\(res\.data\)/, `${key} يتجاهل علامة القصّ`);
  }
  // التنبيه على الشاشة
  assert.match(s, /visitsData\?\.trunc\.truncated &&/);
  assert.match(s, /perfRes\?\.trunc\.truncated &&/);
  assert.match(s, /hoursData\?\.trunc\.truncated &&/);
  assert.match(s, /rankingQ\.data\?\.trunc\.truncated &&/);
  assert.match(s, /returnsQ\.data\?\.trunc\.truncated &&/);
  assert.match(s, /ordersQ\.data\?\.trunc\.truncated &&/);
});

test('حارس البند ٩: المدى المطبَّق لكل تقريرٍ بنافذةٍ افتراضية، ورأس PDF وورقة «الفترة» منه', () => {
  const s = page();
  for (const key of ['report-sales', 'report-orders', 'report-returns', 'report-lot-sales', 'report-rep-ranking', 'report-work-hours']) {
    const at = s.indexOf(`queryKey: ['${key}'`);
    assert.ok(at > 0, key);
    assert.match(s.slice(at, s.indexOf('enabled:', at)), /appliedRangeOf\(res\.data\)/, `${key} يتجاهل المدى المطبَّق`);
  }
  assert.match(s, /: periodText\(activeApplied, from, to, tr\);/, 'رأس PDF من المدى المطبَّق');
  assert.ok(!s.includes("to ? `${tr('إلى')} ${to}` : tr('كل الفترات')"), 'عاد رأس PDF من مدخلات المستخدم وحدها');
  assert.match(s, /shareOrDownloadExcel\(\[\.\.\.exportSheets\(built\.sheets\), \.\.\.periodSheets\(withTeam\(built\.fname\)\)\]/);
  // تنبيه التسعين يوماً على تجميعة المبيعات والطلبات (كانا صامتين على الويب)
  assert.match(s, /\{salesRangeNote && <div className=\{noteCls\}>\{salesRangeNote\}<\/div>\}/);
  assert.match(s, /\{ordersRangeNote && <div className=\{noteCls\}>\{ordersRangeNote\}<\/div>\}/);
  assert.match(s, /\{hoursRangeNote && <div className=\{noteCls\}>\{hoursRangeNote\}<\/div>\}/);
});
