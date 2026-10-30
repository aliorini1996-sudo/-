// «لوكيشن» — منطقها الصرف (lib/locations.ts) وحرّاسٌ نصّية على توصيلها: البند تحت «الفواتير» بعَلَم الشركة والمحاسبة،
// ومفتاح المالك مطفأ افتراضياً، وعمود «الموقع» وتصفيته في الفواتير وسجلّ التحميلات بالعَلَم وحده، والخريطة بدبابيس divIcon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LOCATION_ERRORS, assignOptions, bucketLabel, hasActivity, loadByLabel, loadQty, loadsLogRows, locationErrorMessage,
  locationFilterOptions, locationsAccess, locationsPageAllowed, parseLatLng, pointProblem, summaryBuckets, summarySheets,
  type LocBucket, type LocationsSummaryData, type SalesLocation, type VanLoadRow,
} from './locations';
import { PHRASES } from '../i18n/strings';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const arTr = (s: string) => s;
const LANGS = ['en', 'fr', 'tr', 'zh'] as const;
const trOf = (l: typeof LANGS[number]) => (s: string) => PHRASES[s]?.[l] ?? s;

const loc = (id: string, name: string, isActive = true, over: Partial<SalesLocation> = {}): SalesLocation =>
  ({ id, name, isActive, lat: null, lng: null, repsCount: 0, ...over });

test('الصلاحيات: ثلاثة أقسام بصلاحيات نظائرها، والتعريف لغير المقيَّد إلا في جلسة المالك', () => {
  assert.deepEqual(locationsAccess({}), { summary: true, assign: true, manage: true }, 'الغائب مسموح (`!== false`)');
  assert.deepEqual(locationsAccess(null), { summary: false, assign: false, manage: false });
  assert.equal(locationsAccess({ canViewReports: false }).summary, false);
  assert.equal(locationsAccess({ canManageSalesReps: false }).assign, false);
  assert.equal(locationsAccess({ canManageCompanySettings: false }).manage, false);
  assert.equal(locationsAccess({ scopeEnabled: true }).manage, false, 'المقيَّد لا يعيد رسم ما يراه غيره');
  assert.equal(locationsAccess({ scopeEnabled: true }, true).manage, true, 'جلسة المالك تمرّ كما على الخادم');
  assert.equal(locationsPageAllowed({ canViewReports: false, canManageSalesReps: false, canManageCompanySettings: false }), false);
  assert.equal(locationsPageAllowed({ canViewReports: false, canManageSalesReps: false }), true);
  assert.equal(locationsPageAllowed({ canViewReports: false, canManageSalesReps: false, scopeEnabled: true }), false);
});

test('فلتر «الموقع»: الكلّ ثم كل المواقع (المؤرشف موسوماً) ثم «بلا موقع» بالقيمة none', () => {
  const opts = locationFilterOptions([loc('a', 'الرياض'), loc('b', 'جدة', false)], arTr);
  assert.deepEqual(opts.map((o) => o.value), ['', 'a', 'b', 'none']);
  assert.deepEqual(opts.map((o) => o.label), ['كل المواقع', 'الرياض', 'جدة (مؤرشف)', 'بلا موقع']);
});

test('إسناد المندوب: الفعّال وحده، وموقعه الحاليّ المؤرشف يظهر معطَّلاً لا يختفي', () => {
  const list = [loc('a', 'الرياض'), loc('b', 'جدة', false), loc('c', 'الدمام', false)];
  assert.deepEqual(assignOptions(list, null, arTr).map((o) => o.value), ['', 'a']);
  const withArchived = assignOptions(list, 'b', arTr);
  assert.deepEqual(withArchived.map((o) => o.value), ['', 'a', 'b']);
  assert.equal(withArchived[2].disabled, true);
  assert.equal(withArchived[0].label, 'بلا موقع', 'القيمة الفارغة ⇒ null للخادم');
});

test('النقطة الملصوقة: إحداثيات وروابط Google والأرقام الهندية — والرابط المختصر بلا إحداثيات null', () => {
  assert.deepEqual(parseLatLng('24.7136, 46.6753'), { lat: 24.7136, lng: 46.6753 });
  assert.deepEqual(parseLatLng('24.7136 46.6753'), { lat: 24.7136, lng: 46.6753 });
  assert.deepEqual(parseLatLng('٢٤٫٧١٣٦، ٤٦٫٦٧٥٣'), { lat: 24.7136, lng: 46.6753 }, 'لوحة المفاتيح العربية');
  assert.deepEqual(parseLatLng('https://www.google.com/maps?q=21.4858,39.1925'), { lat: 21.4858, lng: 39.1925 });
  assert.deepEqual(parseLatLng('https://maps.google.com/?q=21.4858%2C39.1925'), { lat: 21.4858, lng: 39.1925 });
  assert.deepEqual(parseLatLng('https://www.google.com/maps/@26.4207,50.0888,15z'), { lat: 26.4207, lng: 50.0888 });
  // دبّوس المكان (!3d!4d) أدقّ من مركز العرض (@) فيُقدَّم عليه
  assert.deepEqual(parseLatLng('https://www.google.com/maps/place/X/@26.40,50.00,14z/data=!3m1!4b1!4m6!3m5!3d26.4207!4d50.0888'), { lat: 26.4207, lng: 50.0888 });
  assert.equal(parseLatLng('https://maps.app.goo.gl/abc123'), null);
  assert.equal(parseLatLng('الرياض'), null);
  assert.equal(parseLatLng('95, 46'), null, 'خارج المدى');
  assert.equal(parseLatLng(''), null);
});

test('النقطة: الزوج معاً أو لا شيء وفي مداه — رسائلها مترجمة في اللغات الأربع', () => {
  assert.equal(pointProblem(null, null), null, 'النقطة اختيارية');
  assert.equal(pointProblem(24.7, 46.6), null);
  const msgs = [pointProblem(24.7, null), pointProblem(91, 46), pointProblem(24, 181)];
  assert.ok(msgs.every((m) => typeof m === 'string'));
  // الرسائل تمرّ بـtr(متغيّر) فلا يلتقطها حارس القاموس الحرفيّ — تُفحص هنا
  for (const m of [...msgs as string[], ...Object.values(LOCATION_ERRORS)]) {
    for (const l of LANGS) assert.ok(PHRASES[m]?.[l], `${m} بلا ${l}`);
  }
});

test('رسالة الرفض: الرمز المعروف مترجماً (ومعه عدد المناديب)، وإلا رسالة الخادم، وإلا البديل', () => {
  const err = (data: object) => ({ response: { data } });
  assert.equal(locationErrorMessage(err({ code: 'LOCATION_NAME_TAKEN', message: 'x' }), arTr, 'f'), 'يوجد موقع بهذا الاسم');
  assert.equal(locationErrorMessage(err({ code: 'LOCATION_HAS_REPS', repsCount: 3 }), arTr, 'f'), 'في الموقع مناديب — انقلهم لموقع آخر أولا (3)');
  assert.equal(locationErrorMessage(err({ message: 'رسالة الخادم' }), arTr, 'f'), 'رسالة الخادم');
  assert.equal(locationErrorMessage(new Error('net'), arTr, 'بديل'), 'بديل');
  assert.equal(locationErrorMessage(err({ code: 'LOCATION_ARCHIVED' }), trOf('en'), 'f'), PHRASES['الموقع مؤرشف — استعده أولا أو اختر موقعا آخر'].en);
});

const bucket = (id: string | null, name: string | null, over: Partial<LocBucket> = {}): LocBucket => ({
  locationId: id, name, isActive: true, lat: null, lng: null,
  sales: { count: 0, amount: 0 }, returns: { count: 0, amount: 0 }, net: 0,
  loads: { count: 0, qty: 0, products: [] }, ...over,
});
const summaryOf = (): LocationsSummaryData => ({
  range: { from: '2026-10-21', to: '2026-10-21', timezone: 'Asia/Riyadh' },
  rows: [
    bucket('a', 'الرياض', {
      sales: { count: 3, amount: 1150.5 }, returns: { count: 1, amount: 50 }, net: 1100.5,
      loads: { count: 2, qty: 30, products: [{ productId: 'p1', name: 'مياه', unit: 'كرتون', qty: 20 }, { productId: 'p2', name: 'عصير', unit: null, qty: 10 }] },
    }),
    bucket('b', 'جدة', { isActive: false, sales: { count: 1, amount: 100 }, net: 100 }),
  ],
  none: bucket(null, null, { sales: { count: 2, amount: 40 }, net: 40, loads: { count: 1, qty: 5, products: [{ productId: 'p1', name: 'مياه', unit: 'كرتون', qty: 5 }] } }),
  totals: { sales: { count: 6, amount: 1290.5 }, returns: { count: 1, amount: 50 }, net: 1240.5, loads: { count: 3, qty: 35 } },
});

test('الملخّص: المواقع بترتيب الخادم ثم «بلا موقع» دائماً، والمؤرشف موسوم، والصفر يُبهت لا يختفي', () => {
  const data = summaryOf();
  assert.deepEqual(summaryBuckets(data).map((b) => bucketLabel(b, arTr)), ['الرياض', 'جدة (مؤرشف)', 'بلا موقع']);
  assert.equal(hasActivity(bucket('x', 'فارغ')), false);
  assert.equal(hasActivity(bucket('x', 'تحميل', { loads: { count: 1, qty: 0, products: [] } })), true);
});

test('التصدير: ورقة المواقع (سطرٌ لكل موقع ثم «بلا موقع» ثم الإجمالي) وورقة أصناف التحميل', () => {
  const sheets = summarySheets(summaryOf(), arTr);
  assert.deepEqual(sheets.map((s) => s.name), ['المواقع', 'أصناف التحميل']);
  const rows = sheets[0].rows;
  assert.deepEqual(Object.keys(rows[0]), ['الموقع', 'عدد فواتير البيع', 'مبلغ المبيعات', 'عدد المرتجعات', 'مبلغ المرتجعات', 'صافي المبيعات', 'عدد التحميلات', 'كمية التحميل']);
  assert.deepEqual(rows.map((r) => r['الموقع']), ['الرياض', 'جدة (مؤرشف)', 'بلا موقع', 'الإجمالي']);
  assert.deepEqual(rows[0], { 'الموقع': 'الرياض', 'عدد فواتير البيع': 3, 'مبلغ المبيعات': 1150.5, 'عدد المرتجعات': 1, 'مبلغ المرتجعات': 50, 'صافي المبيعات': 1100.5, 'عدد التحميلات': 2, 'كمية التحميل': 30 });
  assert.deepEqual(rows[3], { 'الموقع': 'الإجمالي', 'عدد فواتير البيع': 6, 'مبلغ المبيعات': 1290.5, 'عدد المرتجعات': 1, 'مبلغ المرتجعات': 50, 'صافي المبيعات': 1240.5, 'عدد التحميلات': 3, 'كمية التحميل': 35 });
  assert.deepEqual(sheets[1].rows, [
    { 'الموقع': 'الرياض', 'الصنف': 'مياه', 'الوحدة': 'كرتون', 'الكمية': 20 },
    { 'الموقع': 'الرياض', 'الصنف': 'عصير', 'الوحدة': '', 'الكمية': 10 },
    { 'الموقع': 'بلا موقع', 'الصنف': 'مياه', 'الوحدة': 'كرتون', 'الكمية': 5 },
  ]);
});

test('أسماء الأوراق وعناوين الأعمدة سليمةٌ وفريدة في اللغات الخمس', () => {
  for (const tr of [arTr, ...LANGS.map(trOf)]) {
    const sheets = summarySheets(summaryOf(), tr);
    const names = sheets.map((s) => s.name);
    assert.equal(new Set(names).size, names.length, names.join(' | '));
    for (const n of names) assert.ok(n.length > 0 && n.length <= 31 && !/[\\/?*[\]:]/.test(n), n);
    assert.equal(Object.keys(sheets[0].rows[0]).length, 8, 'عمودٌ ابتلعه آخر');
    assert.equal(Object.keys(sheets[1].rows[0]).length, 4);
    const log = loadsLogRows([loadRow()], tr, (s) => s, true);
    assert.equal(Object.keys(log[0]).length, 8, 'عمودٌ في السجلّ ابتلعه آخر');
  }
});

function loadRow(over: Partial<VanLoadRow> = {}): VanLoadRow {
  return {
    id: 'l1', type: 'LOAD', note: 'صباحي', createdBy: 'ADMIN', createdAt: '2026-10-21T06:00:00.000Z',
    salesRep: { id: 'r1', name: 'محمد' }, location: { id: 'a', name: 'الرياض' },
    items: [{ qty: 12, product: { name: 'مياه', unit: 'كرتون' } }, { qty: '3.5', product: { name: 'عصير', unit: null } }],
    ...over,
  };
}

test('سجلّ التحميلات: كمية الحركة، ومن سجّلها، وسطرٌ لكل صنف في التصدير بختم الموقع', () => {
  assert.equal(loadQty(loadRow()), 15.5);
  assert.equal(loadByLabel('REP', arTr), 'المندوب');
  assert.equal(loadByLabel('ADMIN', arTr), 'الإدارة');
  assert.equal(loadByLabel(null, arTr), '—');
  const rows = loadsLogRows([loadRow(), loadRow({ id: 'l2', location: null, createdBy: 'REP', note: null, items: [{ qty: 1, product: null }] })], arTr, (s) => s.slice(0, 10), true);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { 'التاريخ': '2026-10-21', 'المندوب': 'محمد', 'الموقع': 'الرياض', 'الصنف': 'مياه', 'الوحدة': 'كرتون', 'الكمية': 12, 'بواسطة': 'الإدارة', 'ملاحظة': 'صباحي' });
  assert.equal(rows[1]['الكمية'], 3.5);
  assert.deepEqual([rows[2]['الموقع'], rows[2]['الصنف'], rows[2]['ملاحظة']], ['بلا موقع', '—', '']);
  assert.ok(!('الموقع' in loadsLogRows([loadRow()], arTr, (s) => s, false)[0]), 'بلا الميزة لا عمود');
});

// ═══ حرّاس التوصيل ═══

test('القائمة: «لوكيشن» تحت «الفواتير» مباشرة، بعَلَم الشركة `=== true` وصلاحية أقسامها ومن الصفحات المحاسبية', () => {
  const s = read('layouts', 'MainLayout.tsx');
  const inv = s.indexOf("{ to: '/app/invoices'");
  const lc = s.indexOf("{ to: '/app/locations'");
  const pm = s.indexOf("{ to: '/app/payment-methods'");
  assert.ok(inv > 0 && lc > inv && pm > lc, 'الترتيب: الفواتير ثم لوكيشن');
  assert.equal(s.slice(inv, lc).split('\n').filter((l) => l.trim().startsWith('{ to:')).length, 1, 'لا بندٌ بين الفواتير ولوكيشن');
  assert.match(s.slice(lc, s.indexOf('\n', lc)), /label: 'nav\.locations' \}/);
  assert.ok(s.includes("(item.to !== '/app/locations' || (companyCfg?.locationsEnabled === true && locationsPageAllowed(user, !!impersonating)))"), 'العَلَم مطفأ افتراضياً والصلاحية');
  assert.match(s, /const ACCOUNTING_PAGES = \[[^\]]*'\/app\/locations'/, 'المحاسبة المطفأة تخفيها');
  assert.match(s, /locationsEnabled\?: boolean;[^\n]*\} \| null/, 'العَلَم في نوع إعدادات الشركة');
  assert.ok(read('i18n', 'strings.ts').includes("'nav.locations': { ar: 'لوكيشن'"));
});

test('المسار كسول، والصفحة تقدّم المحاسبة على العَلَم على الصلاحية — والخريطة في حزمتها وحدها', () => {
  const app = read('App.tsx');
  assert.ok(app.includes("const LocationsPage = lazy(() => import('./pages/LocationsPage'));"));
  assert.ok(app.includes('<Route path="locations" element={<LocationsPage />} />'));
  const c = read('api', 'client.ts');
  for (const re of [/list: \(\) => api\.get\('\/locations'\)/, /assignRep: \(salesRepId: string, locationId: string \| null\) => api\.put\(`\/locations\/reps\/\$\{salesRepId\}`, \{ locationId \}\)/,
    /summary: \(params\?: Record<string, string>\) => api\.get\('\/locations\/summary', \{ params \}\)/, /loadsLog: \(params: Record<string, string \| number>\) => api\.get\('\/van-stock\/loads', \{ params \}\)/]) {
    assert.match(c, re);
  }
  const p = read('pages', 'LocationsPage.tsx');
  const acc = p.indexOf('if (!accountingOn) return <AccountingOffNotice />;');
  const flag = p.indexOf("if (!featureOn || errorCode(locationsQ.error) === 'LOCATIONS_NOT_ALLOWED')");
  const perm = p.indexOf('if (!locationsPageAllowed(user, !!impersonating))');
  assert.ok(acc > 0 && flag > acc && perm > flag, 'المحاسبة ثم العَلَم ثم الصلاحية');
  assert.match(p, /const featureOn = companyQ\.data\?\.locationsEnabled === true;/);
  assert.match(p, /enabled: accountingReady && accountingOn && featureOn,/, 'لا طلب يردّه الخادم ٤٠٣');
  assert.ok(!p.includes('toISOString().slice(0, 10)'), 'اليوم المحلي لا UTC');
  // leaflet لا يدخل الحزمة الرئيسية: منتقي الخريطة يُستورد من الصفحة الكسولة وحدها
  const importers: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts') && fs.readFileSync(full, 'utf8').includes('locations/LocationMap')) importers.push(path.relative(path.join(process.cwd(), 'src'), full).replace(/\\/g, '/'));
    }
  };
  walk(path.join(process.cwd(), 'src'));
  assert.deepEqual(importers, ['pages/LocationsPage.tsx']);
});

test('الخريطة: دبابيس divIcon وحدها (أيقونة Leaflet الافتراضية تنكسر تحت Vite)، وإعادة القياس داخل النافذة', () => {
  const m = read('components', 'locations', 'LocationMap.tsx');
  assert.ok(m.includes("import 'leaflet/dist/leaflet.css';"));
  assert.ok(!/L\.icon\(|new L\.Icon|Icon\.Default/.test(m), 'أيقونة PNG افتراضية');
  assert.ok((m.match(/icon=\{/g) || []).length >= 2 && m.includes('L.divIcon('));
  assert.ok(m.includes('map.invalidateSize()'), 'خريطةٌ في نافذة تُرسم رمادية بلا إعادة قياس');
  assert.ok(m.includes('e.latlng.wrap()'), 'النقر على نسخة العالم المكرّرة يعطي طولاً خارج المدى');
});

test('نافذة المالك: مفتاح «لوكيشن» مطفأ افتراضياً (`!!`) ويُرسل في التحديث', () => {
  const s = read('pages', 'PlatformPage.tsx');
  assert.match(s, /useState\(!!tenant\.locationsEnabled\)/);
  assert.match(s, /\n {6}locationsEnabled,\n/, 'العَلَم في حمولة tenantApi.update');
  assert.ok(s.includes("{tr('تفعيل صفحة لوكيشن لهذه الشركة')}"));
  const pm = s.indexOf("{tr('تفعيل صفحة طرق الدفع لهذه الشركة')}");
  const lc = s.indexOf("{tr('تفعيل صفحة لوكيشن لهذه الشركة')}");
  assert.ok(pm > 0 && lc > pm, 'بجوار «طرق الدفع»');
  assert.match(read('types', 'index.ts'), /locationsEnabled\?: boolean;/);
});

test('الفواتير: عمود «الموقع» وتصفيته بالعَلَم وحده — في الجدول والتصدير والمفتاح، وبلا انهيار لختمٍ فارغ', () => {
  const s = read('pages', 'InvoicesPage.tsx');
  assert.match(s, /const locOn = \(company as \{ locationsEnabled\?: boolean \} \| undefined\)\?\.locationsEnabled === true;/);
  assert.match(s, /const locationId = locOn \? locationIdState : '';/, 'إطفاء الميزة يُسقط تصفيةً خفيّة');
  assert.match(s, /if \(locationId\) f\.locationId = locationId;/, 'التصفية في filters() — الجدول والتصدير معاً');
  assert.match(s, /queryKey: \['invoices', search, status, type, salesRepId, locationId, from, to, page\]/);
  assert.ok(s.includes("{locOn && <th>{tr('الموقع')}</th>}"));
  assert.ok(s.includes('inv.location?.name ??'), 'ختمٌ فارغ (مندوبٌ بلا موقع أو فاتورة قبل التفعيل)');
  assert.ok(!/inv\.location\.name/.test(s), 'قراءةٌ بلا ?. تُسقط الصفحة');
  assert.match(s, /\.\.\.\(locOn && \{ \[tr\('الموقع'\)\]: inv\.location\?\.name \?\? tr\('بلا موقع'\) \}\)/, 'عمود التصدير');
  assert.match(s, /enabled: accountingReady && accountingOn && locOn,/, 'لا طلب مواقع لشركةٍ مطفأة');
});

test('مخزون السيارات: «سجل التحميلات» بالعَلَم وحده، بنوع LOAD، وبعمود الموقع وتصفيته', () => {
  const v = read('pages', 'VanStockPage.tsx');
  assert.match(v, /const companyFlags = companyQ\.data as \{ locationsEnabled\?: boolean;[^}]*\} \| null \| undefined;/);
  assert.match(v, /const locOn = companyFlags\?\.locationsEnabled === true;/);
  assert.ok(v.includes('{locOn && <VanLoadsLog reps={reps} />}'));
  const l = read('components', 'VanLoadsLog.tsx');
  assert.ok(l.includes("type: 'LOAD', from, to,"), 'التحميلات وحدها — «فقط الفواتير والتحميلات»');
  assert.ok(l.includes('...(locationId && { locationId }),'));
  assert.ok(l.includes("{tr('الموقع')}</th>") && l.includes('l.location?.name ??'));
  assert.ok(!/l\.location\.name/.test(l));
});
