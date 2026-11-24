// مصافي تقارير تطبيق الإدارة على الجوال (طلب المالك ١٣ نوفمبر ٢٠٢٦): المنطق الصرف في m/mReportFilters.ts، وحرّاسٌ نصّية على الشاشة
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ymd, PRESETS, DEFAULT_PRESET, presetRange, activePreset,
  NO_FILTERS, FILTER_MODES, filterKeysFor, filterParams, clientPick, ignoredFilters, activeCount, filtersKey,
  normalizeSearch, matchesSearch, sortRows, viewRows, sortOf,
  thenByChoices, effectiveThenBy, salesParams, isNested, viewNested, shareOf, salesAccess, customerPickItems,
  type FilterAvail, type ReportFilters, type SalesNestedRow, type SortOption, type RowAccess,
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

// ═══ رقم العميل (طلب المالك ٢٣ نوفمبر ٢٠٢٦) ═══

interface C { name: string; phone?: string; number?: number | null }
// الجوالات مختارةٌ لا تحوي «12» ولا «10» ولا «120» — فكل مطابقةٍ رقمية أدناه من رقم العميل وحده
const custs: C[] = [
  { name: 'مؤسسة سمارة', phone: '0555000001', number: 12 },
  { name: 'بقالة النور', phone: '0555000002', number: 120 },
  { name: 'تموينات الخير', phone: '0533456789', number: 10 },
  { name: 'عميل قديم', phone: '0540000000', number: null },
  { name: 'عميل من خادم أقدم', phone: '0560000000' },
];
const CUST_ACC: RowAccess<C> = { name: c => c.name, extra: c => [c.phone], number: c => c.number };
const names = (q: string, acc: RowAccess<C> = CUST_ACC) => viewRows(custs, q, 'default', acc).map(c => c.name);

test('رقم العميل: «12» و«#12» و«١٢» و«＃ ١٢» و«۱۲» تجد العميل #12 مطابقةً تامة', () => {
  for (const q of ['12', '#12', '١٢', '＃ ١٢', '  #12  ', '۱۲', '# 12']) {
    assert.deepEqual(names(q), ['مؤسسة سمارة'], `«${q}»`);
  }
});

test('رقم العميل مطابقةٌ تامة لا احتواء: «12» لا تجد #120، و«1» لا تجد #10 ولا #12', () => {
  assert.ok(!names('12').includes('بقالة النور'), '«12» وجدت #120');
  assert.deepEqual(names('120'), ['بقالة النور']);
  assert.deepEqual(names('10'), ['تموينات الخير']);
  // «1» تطابق جوال «…0001» بالاحتواء كما كانت — لكنها لا تطابق رقمَي #10 و#12
  const one = names('1');
  assert.deepEqual(one, ['مؤسسة سمارة'], 'بالجوال وحده');
  assert.ok(!one.includes('تموينات الخير'), '«1» وجدت #10');
  const nameOnly: RowAccess<C> = { name: c => c.name, number: c => c.number };
  assert.deepEqual(names('1', nameOnly), [], 'بلا جوال: «1» لا تطابق #10 ولا #12');
  assert.deepEqual(names('2', nameOnly), [], '«2» لا تطابق #12 ولا #120');
});

test('رقم العميل يُضمّ إلى بحث الاسم والجوال ولا يزيحه: الجوال المحتوي على الأرقام ما زال يُطابق', () => {
  // «0533» لا تكون رقم عميلٍ (صفرٌ أوّل) فتبقى بحث جوالٍ بالاحتواء
  assert.deepEqual(names('0533'), ['تموينات الخير']);
  // «456» جزءٌ من جوال «تموينات الخير» ولا عميل برقم 456 — والاحتواء باقٍ
  assert.deepEqual(names('456'), ['تموينات الخير']);
  assert.deepEqual(names('0002'), ['بقالة النور']);
  assert.deepEqual(names('سماره'), ['مؤسسة سمارة']);
  assert.deepEqual(names('#0'), [], 'صفرٌ ليس رقم عميل');
  assert.equal(names('').length, custs.length, 'بحثٌ فارغ يعرض الكل');
});

test('بلا مُوصِل رقمٍ (تقارير المناديب والأصناف) لا يطابق البحث الرقميّ رقمَ عميل — وما فوق الحدّ ليس رقماً', () => {
  const noNum: RowAccess<C> = { name: c => c.name, extra: c => [c.phone] };
  assert.deepEqual(names('12', noNum), [], 'بلا مُوصِل: «12» بحثٌ بالاحتواء وحده');
  const big: C[] = [{ name: 'أخير', number: 2147483647 }];
  const one = (q: string) => viewRows(big, q, 'default', CUST_ACC).length;
  assert.equal(one('2147483647'), 1, 'أعلى رقمٍ ممكن يُطابق');
  assert.equal(one('2147483648'), 0, 'فوق الحدّ ليس رقماً');
});

test('المبيعات: رقم العميل لمستوى العميل وحده — لا مستوى المندوب ولا الصنف', () => {
  assert.ok(salesAccess('customer').number, 'مستوى العميل بلا مُوصِل رقم');
  assert.equal(salesAccess('rep').number, undefined);
  assert.equal(salesAccess('product').number, undefined);
  const flat = [
    { name: 'مؤسسة سمارة', total: 100, count: 2, number: 12 },
    { name: 'بقالة النور', total: 50, count: 1, number: 120 },
  ];
  assert.deepEqual(viewRows(flat, '#12', 'valueDesc', salesAccess('customer')).map(r => r.name), ['مؤسسة سمارة']);
  assert.deepEqual(viewRows(flat, '12', 'valueDesc', salesAccess('rep')).map(r => r.name), [], 'مستوى المندوب لا يقرأ رقماً');
  // «extra» لا يحمل الرقم أبداً — وإلا وجدت «12» العميل #120 بالاحتواء
  assert.deepEqual(salesAccess('customer').extra?.(flat[1]), []);
});

test('التجميعان: رقم العميل يطابق الصفّ الأب (حسب العميل) والصفوف الفرعية (ثم حسب العميل)', () => {
  const byCust: SalesNestedRow[] = [
    { key: 'c1', name: 'مؤسسة سمارة', number: 12, count: 2, total: 300, sub: [{ key: 'p1', name: 'بيبسي', code: 'P-1', qty: 5, total: 300 }] },
    { key: 'c2', name: 'بقالة النور', number: 120, count: 1, total: 100, sub: [{ key: 'p1', name: 'بيبسي', code: 'P-1', qty: 2, total: 100 }] },
  ];
  const v = viewNested(byCust, '١٢', 'valueDesc', 'customer', 'product');
  assert.deepEqual(v.map(x => [x.row.name, x.bySub]), [['مؤسسة سمارة', false]], 'الأب بكل فروعه');

  const byRep: SalesNestedRow[] = [
    { key: 'r1', name: 'أحمد', count: 3, total: 400, sub: [
      { key: 'c1', name: 'مؤسسة سمارة', number: 12, count: 2, total: 300 },
      { key: 'c2', name: 'بقالة النور', number: 120, count: 1, total: 100 },
    ] },
    { key: 'r2', name: 'خالد', count: 1, total: 120, sub: [{ key: 'c2', name: 'بقالة النور', number: 120, count: 1, total: 120 }] },
  ];
  const w = viewNested(byRep, '#12', 'valueDesc', 'rep', 'customer');
  assert.deepEqual(w.map(x => [x.row.name, x.bySub, x.subs.map(s => s.name)]), [['أحمد', true, ['مؤسسة سمارة']]]);
  // ثم حسب الصنف: رقمٌ لا يطابق صنفاً (المستوى بلا رقم)
  assert.deepEqual(viewNested(byCust, '120', 'valueDesc', 'customer', 'product').map(x => x.row.name), ['بقالة النور']);
});

test('ورقة «اختر العميل»: «#N · الاسم» للشريحة، والرمز التلقائيّ لا يظهر والمخصّص يبقى، والمطابق رقماً أوّلاً', () => {
  const list = [
    { id: 'a', name: 'جوال يحوي 12', phone: '0512000000', number: 7, code: 'cm3x9q2k5v0000abcdefghij' },
    { id: 'b', name: 'مؤسسة سمارة', phone: '0555000001', number: 12, code: 'ODOO-77', businessName: 'سمارة للتجارة' },
    { id: 'c', name: 'بلا رقم بعد', phone: '', number: null, code: '' },
    { id: 'd', name: 'خادم أقدم', phone: '0599' },
  ];
  const items = customerPickItems(list, '12');
  assert.deepEqual(items.map(i => i.id), ['b', 'a', 'c', 'd'], 'المطابق رقماً أوّلاً والباقي بترتيب الخادم');
  assert.equal(items[0].name, '#12 · مؤسسة سمارة');
  assert.equal(items[0].sub, 'سمارة للتجارة · ODOO-77 · 0555000001', 'الرمز المخصّص يبقى');
  assert.equal(items[1].sub, '0512000000', 'الرمز التلقائيّ (cuid) لا يظهر');
  assert.equal(items[2].name, 'بلا رقم بعد', 'بلا رقمٍ: الاسم وحده');
  assert.equal(items[2].sub, '');
  assert.equal(items[3].name, 'خادم أقدم');
  // بلا بحثٍ رقميّ: ترتيب الخادم كما وصل
  assert.deepEqual(customerPickItems(list, 'سمارة').map(i => i.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(customerPickItems(list, '').map(i => i.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(customerPickItems(list, '١٢').map(i => i.id)[0], 'b', 'الأرقام الهندية');
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
