import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  statementTotals, statementPeriodLabel, fetchAllPages, pageOf, truncationNote, isReturnDoc,
  STATEMENT_PAGE_SIZE, STATEMENT_CEILING, type PageResult,
} from '../lib/repStatement';

/**
 * حرّاس «كشف أداء وعمل المندوب» (المناديب ← كشف المندوب) — مراجعة دقّة التقارير، البند ٣.
 *
 * ثلاثة أخطاء أرقامٍ لا شكل:
 *  (أ) تذييل «الإجمالي» جمع المرتجع موجباً مع البيع: مبيعات ١٠٬٠٠٠ ومرتجع ١٬٠٠٠ ⇒ «١١٬٠٠٠».
 *  (ب) بطاقة «إجمالي المبيعات» كانت قبل المرتجع، وكل «مبيعات» في المنصّة صافيةٌ منه (netSales.ts).
 *  (ج) ٥٠٠٠ مستند ثم صمت: pagination.total مُهمَل، فأقدم مستندات المندوب تسقط من كل رقم.
 *  (د) طرفٌ واحد من المدّة كان يُكتب «كل الفترات».
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

const idTr = (s: string) => s;
const day = (d: string) => d;

/* ═══ (أ) و(ب): البيع والمرتجع وصافيهما ═══ */

test('المرتجع يُطرح ولا يُجمع: سيناريو المراجعة ١٠٬٠٠٠ بيع و١٬٠٠٠ مرتجع', () => {
  const docs = [
    { type: 'CASH', total: '6000' },
    { type: 'CREDIT', total: 4000 },
    { type: 'RETURN', total: '1000' }, // المرتجع يُخزَّن بإجماليٍّ موجب
  ];
  const t = statementTotals(docs);
  assert.equal(t.salesTotal, 10000, 'المبيعات = مستندات البيع وحدها');
  assert.equal(t.returnsTotal, 1000, 'المرتجعات مبلغاً موجباً بعنوانها');
  assert.equal(t.netSales, 9000, 'صافي المبيعات = البيع − المرتجع، كتقارير المنصّة');
  assert.notEqual(t.salesTotal + t.returnsTotal, t.netSales);
  assert.equal(t.salesCount, 2);
  assert.equal(t.returnsCount, 1);
});

test('بلا مرتجع: الصافي هو البيع، وبلا مستندات: أصفار', () => {
  assert.deepEqual(statementTotals([{ type: 'CASH', total: 250 }]),
    { salesCount: 1, returnsCount: 0, salesTotal: 250, returnsTotal: 0, netSales: 250 });
  assert.deepEqual(statementTotals([]),
    { salesCount: 0, returnsCount: 0, salesTotal: 0, returnsTotal: 0, netSales: 0 });
});

test('مرتجعٌ أكبر من البيع في المدّة: الصافي سالبٌ صادق لا صفرٌ مُخفى', () => {
  const t = statementTotals([{ type: 'CASH', total: 100 }, { type: 'RETURN', total: 300 }]);
  assert.equal(t.netSales, -200);
});

test('الجمع بلا ذيلٍ عائم — آلاف الكسور تبقى دقيقة حتى ثلاث خانات', () => {
  const docs = Array.from({ length: 3000 }, () => ({ type: 'CASH', total: '0.1' }));
  assert.equal(statementTotals(docs).salesTotal, 300, 'جمع 0.1 ثلاثة آلاف مرة عائماً = 299.99999999999');
  assert.equal(statementTotals([{ type: 'CASH', total: '0.1' }, { type: 'CASH', total: '0.2' }]).salesTotal, 0.3);
  // الدينار بثلاث خانات
  assert.equal(statementTotals([{ type: 'CASH', total: '1.125' }, { type: 'RETURN', total: '0.005' }]).netSales, 1.12);
});

test('قيمةٌ غير رقمية لا تُسقط الكشف (NaN) — تُعدّ صفراً', () => {
  const t = statementTotals([{ type: 'CASH', total: 'x' as unknown as string }, { type: 'CASH', total: 5 }]);
  assert.equal(t.salesTotal, 5);
  assert.ok(Number.isFinite(t.netSales));
});

test('المرتجع يُعرف بنوعه وحده', () => {
  assert.equal(isReturnDoc({ type: 'RETURN' }), true);
  assert.equal(isReturnDoc({ type: 'CASH' }), false);
  assert.equal(isReturnDoc({ type: 'CREDIT' }), false);
});

/* ═══ (د) عنوان المدّة ═══ */

test('عنوان المدّة: الطرفان، وكل طرفٍ وحده، ولا شيء', () => {
  assert.equal(statementPeriodLabel('2026-10-01', '2026-10-31', idTr, day), '2026-10-01 — 2026-10-31');
  assert.equal(statementPeriodLabel('2026-10-01', '', idTr, day), 'من 2026-10-01', '«من» وحدها مدّةٌ لا «كل الفترات»');
  assert.equal(statementPeriodLabel('', '2026-10-31', idTr, day), 'حتى 2026-10-31', '«إلى» وحدها مدّةٌ لا «كل الفترات»');
  assert.equal(statementPeriodLabel('', '', idTr, day), 'كل الفترات');
  assert.equal(statementPeriodLabel(undefined, null, idTr, day), 'كل الفترات');
  assert.equal(statementPeriodLabel('  ', ' ', idTr, day), 'كل الفترات', 'الفراغ كالغياب');
});

test('العنوان يمرّ بالترجمة وبمنسّق اليوم الممرَّر', () => {
  const en = (s: string) => ({ 'من': 'From', 'حتى {date}': 'until {date}', 'كل الفترات': 'All periods' } as Record<string, string>)[s] ?? s;
  const pretty = (d: string) => `<${d}>`;
  assert.equal(statementPeriodLabel('2026-10-01', '', en, pretty), 'From <2026-10-01>');
  assert.equal(statementPeriodLabel('', '2026-10-31', en, pretty), 'until <2026-10-31>');
  // عبارة قالب لا الكلمة المفردة 'حتى' (ترجمتها التركية «Son güncelleme:» لسياقٍ آخر)
  const trk = (s: string) => ({ 'حتى {date}': '{date} tarihine kadar', 'حتى': 'Son güncelleme:' } as Record<string, string>)[s] ?? s;
  assert.equal(statementPeriodLabel('', '2026-10-31', trk, pretty), '<2026-10-31> tarihine kadar');
  assert.equal(statementPeriodLabel('2026-10-01', '2026-10-31', en, pretty), '<2026-10-01> — <2026-10-31>');
  assert.equal(statementPeriodLabel('', '', en, pretty), 'All periods');
});

/* ═══ (ج) جلب كل الصفحات ═══ */

/** خادمٌ مزيّف بترتيب القائمة الحقيقي: الأحدث أولاً، وترقيمٌ بالإزاحة (skip = (page-1)*limit) */
function fakeServer(count: number, opts: { noPagination?: boolean } = {}) {
  // n0 أحدثها … n{count-1} أقدمها
  let rows = Array.from({ length: count }, (_, i) => ({ id: `n${i}` }));
  const calls: Array<{ page: number; limit: number }> = [];
  const fetchPage = async (page: number, limit: number): Promise<PageResult<{ id: string }>> => {
    calls.push({ page, limit });
    const slice = rows.slice((page - 1) * limit, page * limit);
    return opts.noPagination ? { rows: slice } : { rows: slice, total: rows.length };
  };
  return { fetchPage, calls, insertNewest: (id: string) => { rows = [{ id }, ...rows]; } };
}

test('تُجلب كل الصفحات حتى pagination.total — لا تسقط أقدم المستندات', async () => {
  const s = fakeServer(12);
  const r = await fetchAllPages(s.fetchPage, { pageSize: 5, ceiling: 100 });
  assert.equal(r.rows.length, 12);
  assert.equal(r.total, 12);
  assert.equal(r.truncated, false);
  assert.deepEqual(s.calls.map(c => c.page), [1, 2, 3]);
  assert.ok(s.calls.every(c => c.limit === 5), 'الحدّ ثابت فلا تنكسر الإزاحة');
  assert.equal(r.rows[11].id, 'n11', 'الأقدم حاضر');
});

test('إجماليٌّ على حدّ الصفحة تماماً: لا طلب صفحةٍ فارغة زائدة', async () => {
  const s = fakeServer(10);
  const r = await fetchAllPages(s.fetchPage, { pageSize: 5, ceiling: 100 });
  assert.equal(r.rows.length, 10);
  assert.deepEqual(s.calls.map(c => c.page), [1, 2]);
});

test('قائمة فارغة: طلبٌ واحد ولا قطع', async () => {
  const s = fakeServer(0);
  const r = await fetchAllPages(s.fetchPage, { pageSize: 5, ceiling: 100 });
  assert.deepEqual(r, { rows: [], total: 0, truncated: false });
  assert.equal(s.calls.length, 1);
});

test('فوق السقف: يُبقى الأحدث ويُعلَن القطع بالإجمالي الحقيقي', async () => {
  const s = fakeServer(23);
  const r = await fetchAllPages(s.fetchPage, { pageSize: 5, ceiling: 10 });
  assert.equal(r.rows.length, 10);
  assert.equal(r.total, 23, 'الإجمالي من الخادم لا عدد المجلوب');
  assert.equal(r.truncated, true);
  assert.equal(r.rows[0].id, 'n0', 'الأحدث أولاً');
  assert.equal(r.rows[9].id, 'n9');
  assert.deepEqual(s.calls.map(c => c.page), [1, 2], 'لا يُطلب ما فوق السقف');
});

test('سقفٌ لا يقبل القسمة على حجم الصفحة: يُقصّ عند السقف بالضبط', async () => {
  const s = fakeServer(30);
  const r = await fetchAllPages(s.fetchPage, { pageSize: 5, ceiling: 12 });
  assert.equal(r.rows.length, 12);
  assert.equal(r.truncated, true);
  assert.deepEqual(s.calls.map(c => c.page), [1, 2, 3]);
});

test('الإجمالي يساوي السقف تماماً: كاملٌ لا مقطوع', async () => {
  const s = fakeServer(10);
  const r = await fetchAllPages(s.fetchPage, { pageSize: 5, ceiling: 10 });
  assert.equal(r.rows.length, 10);
  assert.equal(r.truncated, false);
});

test('مستندٌ جديد أثناء الجلب: لا تكرار في الأرقام ولا سقوط للأقدم', async () => {
  let inserted = false;
  const s = fakeServer(10);
  const fetchPage = async (page: number, limit: number) => {
    const res = await s.fetchPage(page, limit);
    // بعد الصفحة الأولى يُصدر المندوب فاتورةً جديدة: تدفع آخر الصفحة الأولى إلى أول الثانية
    if (!inserted) { inserted = true; s.insertNewest('fresh'); }
    return res;
  };
  const r = await fetchAllPages(fetchPage, { pageSize: 5, ceiling: 100 });
  const ids = r.rows.map(x => x.id);
  assert.equal(new Set(ids).size, ids.length, 'مستندٌ مكرّر يضاعف مبلغه في الإجماليات');
  for (let i = 0; i < 10; i++) assert.ok(ids.includes(`n${i}`), `سقط n${i}`);
  assert.equal(r.total, 11, 'الإجمالي الأحدث من الخادم');
});

test('صفحةٌ أقصر من حجمها نهايةٌ أكيدة — لا حلقة لو بالغ الإجمالي', async () => {
  let n = 0;
  const r = await fetchAllPages(async () => { n++; return { rows: [{ id: 'a' }, { id: 'b' }], total: 999 }; }, { pageSize: 5, ceiling: 100 });
  assert.equal(n, 1);
  assert.equal(r.rows.length, 2);
  assert.equal(r.truncated, false, 'ليس قطعاً بالسقف');
});

test('خادمٌ يعيد الصفحة نفسها دائماً — يتوقف عند حدّ الصفحات لا يدور بلا نهاية', async () => {
  let n = 0;
  const same = Array.from({ length: 5 }, (_, i) => ({ id: `x${i}` }));
  const r = await fetchAllPages(async () => { n++; return { rows: same, total: 1000 }; }, { pageSize: 5, ceiling: 20 });
  assert.equal(n, 4, 'ceil(السقف / حجم الصفحة)');
  assert.equal(r.rows.length, 5);
  assert.equal(r.truncated, true, 'بقي في الخادم ما لم يُجلب');
});

test('خادمٌ بلا pagination: الصفوف المستلمة هي الإجمالي', async () => {
  const s = fakeServer(3, { noPagination: true });
  const r = await fetchAllPages(s.fetchPage, { pageSize: 5, ceiling: 100 });
  assert.deepEqual(r, { rows: [{ id: 'n0' }, { id: 'n1' }, { id: 'n2' }], total: 3, truncated: false });
});

test('الافتراضيّ: صفحات ٥٠٠٠ وسقف ٥٠٬٠٠٠ — مندوبٌ بـ٦٠٬٠٠٠ مستند يُعرض أحدث ٥٠٬٠٠٠ مع تنبيه', async () => {
  assert.equal(STATEMENT_PAGE_SIZE, 5000, 'حمل الطلب الواحد كما كان');
  assert.equal(STATEMENT_CEILING, 50000);
  const s = fakeServer(60000);
  const r = await fetchAllPages(s.fetchPage);
  assert.equal(s.calls.length, 10);
  assert.ok(s.calls.every(c => c.limit === 5000));
  assert.equal(r.rows.length, 50000);
  assert.equal(r.total, 60000);
  assert.equal(r.truncated, true);
});

test('مندوبٌ بـ٦٣٠٠ فاتورة (سيناريو المراجعة): كلها تُجلب بصفحتين', async () => {
  const s = fakeServer(6300);
  const r = await fetchAllPages(s.fetchPage);
  assert.equal(r.rows.length, 6300);
  assert.equal(r.truncated, false);
  assert.equal(s.calls.length, 2);
});

test('pageOf يقرأ ردّ القائمة { data, pagination.total }', () => {
  assert.deepEqual(pageOf({ data: [{ id: 'a' }], pagination: { total: 7 } }), { rows: [{ id: 'a' }], total: 7 });
  assert.deepEqual(pageOf({ data: [{ id: 'a' }] }), { rows: [{ id: 'a' }], total: null });
  assert.deepEqual(pageOf(undefined), { rows: [], total: null });
});

test('نصّ التنبيه: «عُرض أحدث N فاتورة فقط من أصل M»', () => {
  const fmt = (n: number) => n.toLocaleString('en-US');
  assert.equal(truncationNote('invoices', { shown: 50000, total: 63210 }, idTr, fmt), 'عُرض أحدث 50,000 فاتورة فقط من أصل 63,210');
  assert.equal(truncationNote('receipts', { shown: 50000, total: 50001 }, idTr, fmt), 'عُرض أحدث 50,000 سند قبض فقط من أصل 50,001');
});

/* ═══ وصل القواعد بالنافذة ═══ */

const modalSrc = () => {
  const s = read('src', 'pages', 'SalesRepsPage.tsx');
  const a = s.indexOf('function RepStatementModal(');
  const b = s.indexOf('function CredentialsModal(');
  assert.ok(a > 0 && b > a, 'حدود نافذة الكشف لم تُعثر');
  return s.slice(a, b);
};

test('النافذة تجلب كل الصفحات للفواتير والسندات — لا سقف ٥٠٠٠ صامت', () => {
  const m = modalSrc();
  assert.doesNotMatch(m, /limit: 5000/, 'عاد الطلب الواحد المقطوع');
  assert.equal((m.match(/fetchAllPages<(Invoice|Receipt)>\(/g) || []).length, 2, 'الفواتير والسندات كلتاهما');
  assert.match(m, /invoiceApi\.list\(\{ \.\.\.base, status: 'CONFIRMED', page, limit \}\)/);
  assert.match(m, /receiptApi\.list\(\{ \.\.\.base, page, limit \}\)/);
  // التنبيه الكهرماني على الشاشة والورقة والملف
  assert.match(m, /cutNotes\.length > 0 && \(/, 'لا تنبيه على الشاشة');
  assert.match(m, /bg-amber-50/);
  assert.match(m, /\$\{cutBox\}/, 'لا تنبيه في الورقة المطبوعة');
  assert.match(m, /summary\.push\(\{ \[tr\('البند'\)\]: tr\('ملاحظة'\)/, 'لا تنبيه في ملف Excel');
});

test('الإجماليات من الحساب الواحد — لا جمعٌ موجب لكل المستندات', () => {
  const m = modalSrc();
  assert.match(m, /const totals = statementTotals\(invoices\);/);
  assert.doesNotMatch(m, /invoicesAmountTotal/, 'المجموع الذي أضاف المرتجع إلى البيع عاد');
  assert.doesNotMatch(m, /invoices\.reduce\(\(s, i\) => s \+ Number\(i\.total\)/);
  assert.doesNotMatch(m, /salesTotal - returnsTotal/, 'الصافي يُحسب في مكانٍ واحد');
});

test('البطاقة على الشاشة صافيةٌ من المرتجع، والبيع والمرتجع تحتها', () => {
  const m = modalSrc();
  assert.doesNotMatch(m, /stat\(formatCurrency\(salesTotal\), tr\('إجمالي المبيعات'\)/, 'بطاقة «إجمالي المبيعات» قبل المرتجع عادت');
  assert.match(m, /stat\(formatCurrency\(netSales\), tr\('صافي المبيعات'\)/);
  assert.match(m, /\$\{tr\('المبيعات'\)\} \$\{formatCurrency\(salesTotal\)\} · \$\{tr\('المرتجعات'\)\} \$\{formatCurrency\(returnsTotal\)\}/);
});

test('التذييل بثلاثة أسطر في الشاشة والملف والورقة: المبيعات · المرتجعات · صافي المبيعات', () => {
  const m = modalSrc();
  // الشاشة
  // تذييل الشاشة (JSX) هو الأخير — الأول قالب الورقة المطبوعة
  const tfoot = m.slice(m.lastIndexOf('<tfoot>'), m.lastIndexOf('</tfoot>'));
  assert.ok(tfoot.length > 0);
  assert.doesNotMatch(tfoot, /tr\('الإجمالي'\)/, 'تذييلٌ بعنوان «الإجمالي» واحد');
  for (const k of ['المبيعات', 'المرتجعات', 'صافي المبيعات']) assert.match(tfoot, new RegExp(`tr\\('${k}'\\)`), `الشاشة بلا «${k}»`);
  assert.match(tfoot, /formatCurrency\(salesTotal\)/);
  assert.match(tfoot, /formatCurrency\(returnsTotal\)/);
  assert.match(tfoot, /formatCurrency\(netSales\)/);
  // Excel
  assert.match(m, /invFoot\(tr\('المبيعات'\), `\$\{tr\('الوحدات المباعة'\)\}: \$\{soldUnits\}`, salesTotal\)/);
  assert.match(m, /invFoot\(tr\('المرتجعات'\), '', returnsTotal\)/);
  assert.match(m, /invFoot\(tr\('صافي المبيعات'\), '', netSales\)/);
  // الطباعة
  assert.match(m, /footRow\(tr\('المبيعات'\), soldUnits, `\$\{totals\.salesCount\} \$\{tr\('فاتورة'\)\}`, salesTotal, true\)/);
  assert.match(m, /footRow\(tr\('المرتجعات'\), '', `\$\{totals\.returnsCount\} \$\{tr\('مرتجع'\)\}`, returnsTotal\)/);
  assert.match(m, /footRow\(tr\('صافي المبيعات'\), '', '', netSales\)/);
  assert.match(m, /<tfoot>\$\{invFootHtml\}<\/tfoot>/);
});

test('عنوان المدّة من القاعدة الواحدة على الشاشة والورقة', () => {
  const m = modalSrc();
  assert.match(m, /const periodLabel = statementPeriodLabel\(from, to, tr, formatDayOnly\);/);
  assert.doesNotMatch(m, /from && to \? `\$\{formatDate\(from\)\}/, 'العنوان القديم «كل الفترات» لطرفٍ واحد عاد');
  assert.match(m, /<p className="text-xs text-\[#6E6557\]">\{periodLabel\}<\/p>/, 'رأس النافذة');
  assert.match(m, /\$\{tr\('الفترة'\)\}: \$\{periodLabel\}/, 'رأس الورقة');
  // والملف: صفّ «الفترة» أوّل الملخّص — ملفٌّ مُتداول لـ«من X» يقول إنه مُصفّى
  assert.match(m, /const summary = \[\s*\{ \[tr\('البند'\)\]: tr\('الفترة'\), \[tr\('القيمة'\)\]: periodLabel \},/, 'ملف Excel');
});

test('الورقة والملف يسمّيان الإجمالي قبل المرتجع «المبيعات» كالشاشة — «إجمالي المبيعات» في المنصّة صافٍ', () => {
  const m = modalSrc();
  assert.doesNotMatch(m, /tr\('إجمالي المبيعات'\)/, '«إجمالي المبيعات» على رقمٍ قبل المرتجع');
  assert.doesNotMatch(m, /tr\('إجمالي المرتجعات'\)/);
  assert.match(m, /\{ \[tr\('البند'\)\]: tr\('المبيعات'\), \[tr\('القيمة'\)\]: num\(salesTotal\) \}/, 'ملخّص Excel');
  assert.match(m, /\{ \[tr\('البند'\)\]: tr\('المرتجعات'\), \[tr\('القيمة'\)\]: num\(returnsTotal\) \}/);
  assert.match(m, /\$\{num\(salesTotal\)\.toFixed\(2\)\}<\/div><div class="k">\$\{tr\('المبيعات'\)\}/, 'بطاقة الطباعة');
  assert.match(m, /\$\{num\(returnsTotal\)\.toFixed\(2\)\}<\/div><div class="k">\$\{tr\('المرتجعات'\)\}/);
});
