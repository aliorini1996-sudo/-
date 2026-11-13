// مصافي تقارير تطبيق الإدارة على الجوال (طلب المالك ١٣ نوفمبر ٢٠٢٦): المنطق الصرف في m/mReportFilters.ts، وحرّاسٌ نصّية على الشاشة
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ymd, PRESETS, DEFAULT_PRESET, presetRange, activePreset,
  NO_FILTERS, FILTER_MODES, filterKeysFor, filterParams, clientPick, ignoredFilters, activeCount, filtersKey,
  normalizeSearch, matchesSearch, sortRows, viewRows, sortOf,
  thenByChoices, effectiveThenBy, salesParams, isNested, viewNested, shareOf,
  type FilterAvail, type ReportFilters, type SalesNestedRow, type SortOption,
} from './mReportFilters';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const ALL: FilterAvail = { rep: true, customer: true, team: true, location: true };

// ═══ المدى ═══

test('المديات الجاهزة بتوقيت الجهاز — الجمعة ١٣ نوفمبر ٢٠٢٦', () => {
  const now = new Date(2026, 10, 13, 1, 30); // الواحدة والنصف ليلاً: يوم UTC ما زال ١٢ في الرياض
  assert.deepEqual(presetRange('today', now), { from: '2026-11-13', to: '2026-11-13' });
  assert.deepEqual(presetRange('yesterday', now), { from: '2026-11-12', to: '2026-11-12' });
  // الأسبوع يبدأ السبت: ١٣ نوفمبر ٢٠٢٦ جمعة ⇒ السبت ٧
  assert.equal(now.getDay(), 5);
  assert.deepEqual(presetRange('week', now), { from: '2026-11-07', to: '2026-11-13' });
  assert.deepEqual(presetRange('last7', now), { from: '2026-11-07', to: '2026-11-13' });
  assert.deepEqual(presetRange('month', now), { from: '2026-11-01', to: '2026-11-13' });
  assert.deepEqual(presetRange('lastMonth', now), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(presetRange('last30', now), { from: '2026-10-15', to: '2026-11-13' });
  assert.deepEqual(presetRange('year', now), { from: '2026-01-01', to: '2026-11-13' });
});

test('حدود الشهر والسنة: أمس في أول يناير، والشهر الماضي في مارس (فبراير ٢٨ يوماً)، والأسبوع يوم السبت', () => {
  assert.deepEqual(presetRange('yesterday', new Date(2027, 0, 1)), { from: '2026-12-31', to: '2026-12-31' });
  assert.deepEqual(presetRange('lastMonth', new Date(2027, 2, 10)), { from: '2027-02-01', to: '2027-02-28' });
  assert.deepEqual(presetRange('lastMonth', new Date(2027, 0, 5)), { from: '2026-12-01', to: '2026-12-31' });
  const sat = new Date(2026, 10, 14);
  assert.equal(sat.getDay(), 6);
  assert.deepEqual(presetRange('week', sat), { from: '2026-11-14', to: '2026-11-14' });
  assert.equal(ymd(new Date(2026, 0, 5)), '2026-01-05');
});

test('ثمانية مديات بالترتيب و«هذا الشهر» افتراضاً', () => {
  assert.deepEqual(PRESETS.map(p => p.label), ['اليوم', 'أمس', 'هذا الأسبوع', 'آخر 7 أيام', 'هذا الشهر', 'الشهر الماضي', 'آخر 30 يوما', 'هذه السنة']);
  assert.equal(DEFAULT_PRESET, 'month');
});

test('المدى المضيء: المنقور أولاً حين يتطابق مديان، ولا شيء لمدىً مخصّص أو فارغ', () => {
  const first = new Date(2026, 10, 1);
  const r = presetRange('month', first);
  assert.equal(activePreset(r.from, r.to, null, first), 'today', 'بلا تفضيل: أوّل مطابقٍ في الشريط');
  assert.equal(activePreset(r.from, r.to, 'month', first), 'month', 'المنقور يبقى مضيئاً');
  assert.equal(activePreset('2026-11-02', '2026-11-05', 'month', first), undefined);
  assert.equal(activePreset('', '', 'month', first), undefined);
});

// ═══ المصافي ═══

const picked: ReportFilters = {
  rep: { id: 'r1', name: 'أحمد' }, customer: { id: 'c1', name: 'بقالة النور' },
  team: { id: 'none', name: 'بلا فريق' }, location: { id: 'l1', name: 'الرياض' },
};

test('المبيعات: المصافي الأربع معاملاتٌ للخادم بأسماء العقد', () => {
  assert.deepEqual(filterParams('sales', picked, ALL), { salesRepId: 'r1', customerId: 'c1', teamId: 'none', locationId: 'l1' });
  assert.deepEqual(filterKeysFor('sales', ALL), ['rep', 'customer', 'team', 'location']);
});

test('بلا مصافٍ لا معامل يُرسل — الطلب كما كان حرفاً', () => {
  for (const r of Object.keys(FILTER_MODES) as Array<keyof typeof FILTER_MODES>) {
    assert.deepEqual(filterParams(r, NO_FILTERS, ALL), {}, r);
    assert.deepEqual(ignoredFilters(r, NO_FILTERS, ALL), [], r);
  }
});

test('التحصيل بلا موقع (السند لا يُختم)، والزيارات بلا موقع، والأداء والساعات بلا عميل', () => {
  assert.deepEqual(filterParams('collections', picked, ALL), { salesRepId: 'r1', customerId: 'c1', teamId: 'none' });
  assert.deepEqual(ignoredFilters('collections', picked, ALL), ['location']);
  assert.deepEqual(filterParams('visits', picked, ALL), { salesRepId: 'r1', customerId: 'c1', teamId: 'none' });
  assert.deepEqual(filterParams('performance', picked, ALL), { salesRepId: 'r1', teamId: 'none', locationId: 'l1' });
  assert.deepEqual(filterParams('hours', picked, ALL), { salesRepId: 'r1', teamId: 'none', locationId: 'l1' });
  assert.deepEqual(ignoredFilters('hours', picked, ALL), ['customer']);
});

test('التقارير بصفوف مندوبين أو عملاء تُصفّى على الجهاز ولا تُرسل المعامل', () => {
  assert.deepEqual(filterParams('receivables', picked, ALL), { teamId: 'none' });
  assert.equal(clientPick('receivables', picked, ALL, 'rep')?.id, 'r1');
  assert.equal(clientPick('receivables', picked, ALL, 'location')?.id, 'l1');
  assert.equal(clientPick('receivables', picked, ALL, 'team'), null, 'الفريق في الخادم لا على الجهاز');
  assert.deepEqual(filterParams('balances', picked, ALL), {});
  assert.equal(clientPick('balances', picked, ALL, 'customer')?.id, 'c1');
  assert.deepEqual(ignoredFilters('balances', picked, ALL), ['rep', 'team', 'location']);
  assert.deepEqual(filterParams('unvisited', picked, ALL), {});
  assert.equal(clientPick('unvisited', picked, ALL, 'rep')?.name, 'أحمد');
});

test('مصفاةٌ غير متاحة (صلاحية أو ميزة مطفأة) لا تظهر ولا تُرسل وتُذكر كغير منطبقة', () => {
  const noLoc: FilterAvail = { ...ALL, location: false, team: false };
  assert.deepEqual(filterKeysFor('sales', noLoc), ['rep', 'customer']);
  assert.deepEqual(filterParams('sales', picked, noLoc), { salesRepId: 'r1', customerId: 'c1' });
  assert.deepEqual(ignoredFilters('sales', picked, noLoc), ['team', 'location']);
  assert.equal(activeCount('sales', picked, noLoc), 2);
  assert.equal(clientPick('receivables', picked, noLoc, 'location'), null);
});

test('مفتاح الكاش يتغيّر بالمختار، والمعرّف يُقصّ', () => {
  assert.equal(filtersKey(NO_FILTERS), '|||');
  assert.equal(filtersKey(picked), 'r1|c1|none|l1');
  assert.deepEqual(filterParams('sales', { ...NO_FILTERS, rep: { id: '  r9 ', name: 'x' } }, ALL), { salesRepId: 'r9' });
  assert.deepEqual(filterParams('sales', { ...NO_FILTERS, rep: { id: '   ', name: 'x' } }, ALL), {});
});

// ═══ البحث والترتيب ═══

test('البحث يتسامح مع الهمزات والتاء المربوطة والتشكيل والأرقام الهندية', () => {
  assert.equal(normalizeSearch('  أحمدُ  إبراهيم '), 'احمد ابراهيم');
  assert.ok(matchesSearch('احمد', ['أحمد علي']));
  assert.ok(matchesSearch('مكه', ['مكة المكرمة']));
  assert.ok(matchesSearch('١٢٣', ['P-123']));
  assert.ok(matchesSearch('علي احمد', ['أحمد', 'علي']), 'كل كلمة في أيّ حقل');
  assert.ok(!matchesSearch('خالد', ['أحمد']));
  assert.ok(matchesSearch('   ', ['أي شيء']), 'بحثٌ فارغ يطابق الكل');
});

interface R { name: string; v: number; n: number; d: string }
const rows: R[] = [
  { name: 'باء', v: 10, n: 1, d: '2026-11-02' },
  { name: 'ألف', v: 30, n: 5, d: '2026-11-01' },
  { name: 'جيم', v: 20, n: 5, d: '2026-11-03' },
];
const acc = { name: (r: R) => r.name, value: (r: R) => r.v, count: (r: R) => r.n, date: (r: R) => r.d };

test('الترتيب: الافتراضي ترتيب الخادم، والمبلغ صعوداً ونزولاً، والعدد ثم المبلغ، والأحدث، والاسم', () => {
  assert.deepEqual(sortRows(rows, 'default', acc).map(r => r.name), ['باء', 'ألف', 'جيم']);
  assert.deepEqual(sortRows(rows, 'valueDesc', acc).map(r => r.v), [30, 20, 10]);
  assert.deepEqual(sortRows(rows, 'valueAsc', acc).map(r => r.v), [10, 20, 30]);
  assert.deepEqual(sortRows(rows, 'count', acc).map(r => r.name), ['ألف', 'جيم', 'باء']);
  assert.deepEqual(sortRows(rows, 'recent', acc).map(r => r.d), ['2026-11-03', '2026-11-02', '2026-11-01']);
  assert.deepEqual(sortRows(rows, 'name', acc).map(r => r.name), ['ألف', 'باء', 'جيم']);
  assert.deepEqual(sortRows(rows, 'count', { name: acc.name }).map(r => r.name), ['باء', 'ألف', 'جيم'], 'بلا مُوصِل يبقى ترتيب الخادم');
  assert.deepEqual(rows.map(r => r.name), ['باء', 'ألف', 'جيم'], 'لا يُعدَّل الأصل');
});

test('viewRows: البحث ثم الترتيب، وsortOf يردّ خياراً غريباً إلى الأول', () => {
  assert.deepEqual(viewRows(rows, 'ا', 'valueAsc', acc).map(r => r.name), ['باء', 'ألف']);
  const opts: SortOption[] = [{ id: 'valueDesc', label: 'الأعلى مبلغا' }, { id: 'name', label: 'الاسم' }];
  assert.equal(sortOf(opts, 'name'), 'name');
  assert.equal(sortOf(opts, 'recent'), 'valueDesc');
  assert.equal(sortOf([], 'name'), 'default');
});

// ═══ التجميعان المتداخلان ═══

test('«ثم حسب»: المستويان الآخران، والمطابق يسقط، وبلاه الطلب كما كان', () => {
  assert.deepEqual(thenByChoices('rep'), ['customer', 'product']);
  assert.deepEqual(thenByChoices('product'), ['rep', 'customer']);
  assert.equal(effectiveThenBy('rep', 'rep'), '');
  assert.equal(effectiveThenBy('rep', ''), '');
  assert.equal(effectiveThenBy('rep', 'product'), 'product');
  assert.deepEqual(salesParams('rep', ''), { groupBy: 'rep' });
  assert.deepEqual(salesParams('rep', 'rep'), { groupBy: 'rep' });
  assert.deepEqual(salesParams('rep', 'product'), { groupBy: 'rep', thenBy: 'product' });
});

const nested: SalesNestedRow[] = [
  { key: 'r1', name: 'أحمد', count: 4, total: 900, sub: [
    { key: 'p1', name: 'بيبسي', code: 'P-1', qty: 48, baseQty: 48, total: 600 },
    { key: 'p2', name: 'ماء', code: 'W-2', qty: 100, baseQty: 100, total: 300 },
  ] },
  { key: 'r2', name: 'خالد', count: 2, total: 400, sub: [
    { key: 'p2', name: 'ماء', code: 'W-2', qty: 50, baseQty: 50, total: 250 },
    { key: 'p1', name: 'بيبسي', code: 'P-1', qty: 12, baseQty: 12, total: 150 },
  ] },
];

test('التداخل: الردّ بلا sub (خادمٌ أقدم) يُعرض مسطّحاً', () => {
  assert.equal(isNested(nested), true);
  assert.equal(isNested([{ name: 'أحمد', total: 1 }]), false);
  assert.equal(isNested([]), false);
});

test('بحثٌ يطابق صنفاً فرعياً: كل مندوبٍ بذلك الصنف وحده، مفتوحاً، ومجموعه كما ردّه الخادم', () => {
  const v = viewNested(nested, 'بيبسي', 'valueDesc', 'rep', 'product');
  assert.deepEqual(v.map(x => [x.row.name, x.bySub, x.subs.map(s => s.total)]), [['أحمد', true, [600]], ['خالد', true, [150]]]);
  assert.equal(v[0].row.total, 900);
  // الرمز يُبحث في مستوى الصنف
  assert.deepEqual(viewNested(nested, 'w-2', 'valueDesc', 'rep', 'product').map(x => x.subs.map(s => s.name)), [['ماء'], ['ماء']]);
});

test('بحثٌ يطابق الصفّ نفسه يبقيه بكل فروعه، والترتيب يسري على المستويين', () => {
  const v = viewNested(nested, 'خالد', 'valueAsc', 'rep', 'product');
  assert.equal(v.length, 1);
  assert.equal(v[0].bySub, false);
  assert.deepEqual(v[0].subs.map(s => s.total), [150, 250]);
  const all = viewNested(nested, '', 'count', 'rep', 'product');
  assert.deepEqual(all.map(x => x.row.name), ['أحمد', 'خالد'], 'الأب بعدد الفواتير');
  assert.deepEqual(all[0].subs.map(s => s.name), ['ماء', 'بيبسي'], 'الفرع (صنف) بالكمية');
  assert.deepEqual(viewNested(nested, 'لا شيء', 'valueDesc', 'rep', 'product'), []);
});

test('الحصّة من الأب: موجبٌ وحده', () => {
  assert.equal(shareOf(600, 900), 67);
  assert.equal(shareOf(10, 0), null);
  assert.equal(shareOf(10, -5), null);
});

// ═══ حرّاس الشاشة ═══

test('الشاشة: المدى الافتراضي «هذا الشهر»، والمصافي تمرّ بـfilterParams لكل تقرير، وthenBy بـsalesParams', () => {
  const m = read('m', 'MReports.tsx');
  assert.match(m, /presetRange\(DEFAULT_PRESET\)/, 'المدى الافتراضي ليس «هذا الشهر»');
  assert.match(m, /salesParams\(groupBy, thenBy\)/);
  for (const r of ['sales', 'collections', 'performance', 'hours', 'visits', 'receivables']) {
    assert.match(m, new RegExp(`fp\\('${r}'\\)`), `تقرير ${r} لا يمرّر المصافي`);
  }
  // الثوابت القائمة لا تنكسر
  assert.match(m, /qtyTotalLabel\(tr, 'إجمالي الكمية', 'إجمالي الكمية بوحدات الأساس', \{ primary: anyPrimary\(rows\), multi: anyMulti \}\)/);
  assert.match(m, /methodLabel\(r\.paymentMethod, tr, company, r\.paymentMethodKey\)/);
});
