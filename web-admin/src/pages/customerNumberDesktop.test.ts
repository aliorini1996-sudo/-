/**
 * «رقم العميل» في شاشات الإدارة على سطح المكتب (طلب المالك ٢٣ نوفمبر ٢٠٢٦):
 * «في صفحة العملاء استبدل الكود برقمٍ للعميل… يُستعمل في بحث التقارير وخطوط السير وكل مكانٍ يُبحث فيه».
 *
 * حرّاسٌ نصّية على الشاشات (بلا DOM) ورسمٌ لرأس «أرشيف العميل»:
 *  - صفحة العملاء: العمود «رقم العميل» بـcustomerNumberCell بدل الرمز الآلي، والتصدير في الموضع نفسه بالعروض نفسها.
 *  - منتقيا العميل في الفاتورة والسند: الرقم في num (مطابقةٌ تامّة وعرضٌ «#12 · ») لا في نصّ الاسم المُصفّى،
 *    والجوال والنشاط والرمز المخصّص كلمات بحث.
 *  - خطوط السير: الرقم للعرض وحده بجانب الاسم، والحفظ يرسل customerId وحده.
 *  - لا شاشة تعرض الرمز الآلي (cuid) في قوائم العملاء.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CUSTOMER_EXPORT_TAX_COL, customerExportColWidths } from './taxOffScreens1';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
/** مقطعٌ من الملف بين علامتين — لحصر الفحص في موضعه (المنتقي، صفّ التصدير…) */
const slice = (s: string, from: string, to: string) => {
  const i = s.indexOf(from);
  assert.ok(i >= 0, `العلامة مفقودة: ${from}`);
  const j = s.indexOf(to, i + from.length);
  assert.ok(j > i, `نهاية المقطع مفقودة: ${to}`);
  return s.slice(i, j);
};

// ═══ صفحة العملاء ═══

test('صفحة العملاء: العمود «رقم العميل» بـcustomerNumberCell (#12 أو —) — والرمز الآلي لا يُرسم', () => {
  const page = read('pages', 'CustomersPage.tsx');
  assert.match(page, /import \{ customerNumberCell, visibleCustomerCode \} from '\.\.\/lib\/customerNumber';/);
  const head = slice(page, '<thead>', '</thead>');
  assert.ok(head.includes("<th>{tr('رقم العميل')}</th><th>{tr('العميل')}</th>"), 'الترويسة');
  assert.ok(!head.includes("tr('الكود')"), '«الكود» ما زال في الترويسة');
  const body = slice(page, '<tbody>', '</tbody>');
  assert.ok(body.includes('{customerNumberCell(c.number)}'), 'الخانة لا تعرض رقم العميل');
  assert.match(body, /<span dir="ltr" className="tabular-nums">\{customerNumberCell\(c\.number\)\}<\/span>/, 'أرقامٌ لاتينية باتجاهها');
  // c.code في الصفحة لقنوات البيع (SALES_CHANNELS في فلتر القناة) وللكود المخصّص في التصدير وحده — لا رمز عميلٍ في الجدول
  assert.doesNotMatch(body, /c\.code\b/, 'الرمز الآلي ما زال يُرسم في القائمة');
  assert.deepEqual([...page.matchAll(/\bc\.code\b/g)].length, 4, 'c.code خارج خيار القناة وتصدير الكود المخصّص');
  assert.equal([...page.matchAll(/visibleCustomerCode\(c\.code\)/g)].length, 2, 'الكود في التصدير خاماً لا مخصّصاً وحده');
  assert.ok(page.includes('<option key={c.code} value={c.code}>{tr(c.ar)}</option>'));
  // الخانة نفسها لصفوف قائمة بيانات الفوترة (BUYER_ROW_SELECT يحمل number) — لا فرعٌ يُخفيها في bucketMode
  assert.doesNotMatch(body, /!bucketMode && <td[^>]*>\s*<span dir="ltr" className="tabular-nums">\{customerNumberCell/);
});

test('صفحة العملاء: البحث يذكر رقم العميل، وفتح الأرشيف يمرّر الرقم', () => {
  const page = read('pages', 'CustomersPage.tsx');
  assert.ok(page.includes("placeholder={tr('بحث بالاسم أو الجوال أو رقم العميل')}"));
  assert.ok(!page.includes("tr('بحث بالاسم أو الجوال أو الكود')"), 'العبارة القديمة ما زالت في الصفحة');
  // البحث نفسه في الخادم (search) كما كان — لا تصفية محلية تخالفه
  assert.ok(page.includes('customerApi.list({ search, status, channel, page, limit: 15 })'));
  assert.ok(page.includes('setStudioFor({ id: c.id, name: c.name, number: c.number })'));
  assert.ok(page.includes('setStudioFor({ id: selected.id, name: selected.name, number: selected.number })'));
});

test('تصدير العملاء: «رقم العميل» مكان «الكود» في موضعه — العروض كما هي والرقم الضريبي العاشر', () => {
  const page = read('pages', 'CustomersPage.tsx');
  const row = slice(page, 'const rows = all.map(c => ({', 'const out = await shareOrDownloadExcel(');
  const keys = [...row.matchAll(/\[tr\('([^']+)'\)\]:/g)].map((x) => x[1]);
  assert.equal(keys[0], 'رقم العميل', 'العمود الأول');
  assert.ok(!keys.includes('الكود'), '«الكود» ما زال في التصدير');
  assert.ok(row.includes("[tr('رقم العميل')]: c.number ?? '',"), 'خلية فارغة لعميلٍ لم يُرقَّم — لا null');
  assert.equal(keys.indexOf('الرقم الضريبي'), CUSTOMER_EXPORT_TAX_COL);
  // كل الأعمدة (المحاسبة مفعّلة وبضريبة، ومعها «كود العميل») = عدد العروض: لا عمود زائد يزيح العروض
  assert.equal(keys.length, customerExportColWidths(true, false, true).length);
  assert.ok(page.includes('colWidths: customerExportColWidths(accountingOn, taxOff, withCode)'));
});

test('تصدير العملاء: «كود العميل» عمودٌ أخير للكود المخصّص وحده (يُطابَق به عند إعادة الاستيراد) — ولا عمود حين كل الأكواد آلية', () => {
  const page = read('pages', 'CustomersPage.tsx');
  const row = slice(page, 'const rows = all.map(c => ({', 'const out = await shareOrDownloadExcel(');
  const keys = [...row.matchAll(/\[tr\('([^']+)'\)\]:/g)].map((x) => x[1]);
  assert.equal(keys[keys.length - 1], 'كود العميل', 'العمود الأخير');
  assert.ok(row.includes("...(withCode ? { [tr('كود العميل')]: visibleCustomerCode(c.code) } : {}),"));
  assert.ok(page.includes("const withCode = all.some(c => visibleCustomerCode(c.code) !== '');"));
  // العمود الاختياري أخيرٌ: الرقم الضريبي في موضعه وعروض ما قبله كما هي
  for (const acc of [true, false]) for (const off of [true, false]) {
    const base = customerExportColWidths(acc, off);
    assert.deepEqual(customerExportColWidths(acc, off, true), [...base, 18]);
    assert.deepEqual(customerExportColWidths(acc, off, false), base);
  }
});

// ═══ منتقيا العميل في الفاتورة والسند ═══

for (const [file, anchor] of [
  ['InvoiceModal.tsx', "placeholder={tr('اختر العميل')}"],
  ['ReceiptModal.tsx', "placeholder={tr('اختر العميل')}"],
] as const) {
  test(`${file}: المنتقي يطابق الرقم بالضبط (num) ويبحث بالجوال والنشاط والرمز المخصّص — والاسم خالص`, () => {
    const s = read('components', 'forms', file);
    assert.match(s, /import \{ visibleCustomerCode \} from '\.\.\/\.\.\/lib\/customerNumber';/);
    const picker = slice(s, anchor, 'onChange={(v) =>');
    assert.ok(picker.includes("searchPlaceholder={tr('اكتب اسم أو جوال أو رقم العميل')}"));
    assert.ok(picker.includes('label: c.name,'), 'الاسم وحده في label');
    assert.ok(picker.includes('num: c.number,'), 'الرقم لا يصل المنتقي');
    assert.ok(picker.includes('keywords: [c.phone, c.businessName, visibleCustomerCode(c.code)],'));
    // الرقم لا يدخل نصاً يُطابَق بالاحتواء: «#1» كانت ستُظهر #10..#19
    assert.doesNotMatch(picker, /label:[^\n]*(number|#)/, 'الرقم دخل نصّ الاسم');
    assert.doesNotMatch(picker, /hint:[^\n]*number/, 'الرقم دخل التلميح');
    assert.doesNotMatch(picker, /keywords:[^\n]*number/, 'الرقم دخل كلمات البحث');
    assert.doesNotMatch(picker, /c\.code\b(?!\))/, 'الرمز الآلي خاماً');
  });
}

// ═══ خطوط السير ═══

test('خطوط السير: الرقم بجانب الاسم في النتائج والمختارين، والاسم خالص، والحفظ بالمعرّف وحده', () => {
  const s = read('pages', 'RepRoutesPage.tsx');
  assert.match(s, /import \{ formatCustomerNumber, matchesCustomerNumber \} from '\.\.\/lib\/customerNumber';/);
  assert.match(s, /interface Stop \{ customerId: string; customerName: string; customerNumber\?: number \| null; note\?: string \| null(; hasLoc\?: boolean)? \}/);
  assert.match(s, /interface Named \{ id: string; name: string; businessName\?: string \| null; number\?: number \| null(; lat\?: number \| null; lng\?: number \| null)? \}/);
  // المحفوظة: customerNumber من GET /rep-routes/:id
  assert.ok(s.includes('customerNumber: s.customerNumber ?? null'));
  // المضاف من البحث: الاسم (أو النشاط) خالصاً والرقم في حقله
  assert.ok(s.includes('{ customerId: c.id, customerName: label, customerNumber: c.number ?? null, hasLoc }'), 'الرقم يُحمل مع المختار (وعلامة الموقع للعرض)');
  assert.ok(s.includes('const label = c.businessName || c.name;'), 'customerName صار يحمل الرقم');
  // «ترتيب بالمسافة» لا يُسقط الرقم
  assert.ok(s.includes('r.ordered.map(({ customerId, customerName, customerNumber, note }) => ({ customerId, customerName, customerNumber, note }))'));
  // الحفظ: customerId والملاحظة وحدهما — الرقم ليس مدخلاً
  assert.ok(s.includes('stops: stops.map(s => ({ customerId: s.customerId, note: s.note ?? null })),'));
  assert.equal((s.match(/formatCustomerNumber\((s\.customerNumber|c\.number)\)/g) || []).length, 2, 'العرض في القائمتين');
  // المطابق بالرقم يتصدّر نتائج البحث
  assert.match(s, /\.sort\(\(a, b\) => Number\(matchesCustomerNumber\(search, b\.number\)\) - Number\(matchesCustomerNumber\(search, a\.number\)\)\)/);
  assert.ok(s.includes("placeholder={tr('ابحث بالاسم أو الجوال أو رقم العميل')}"));
});

// ═══ القوائم الأخرى: لا رمز آلي، والرقم معروض ═══

test('نطاق المستخدم وإسناد العملاء: «#12» بدل الرمز الآلي — وتبويب المناديب كما كان', () => {
  const scope = read('components', 'UserScopeModal.tsx');
  assert.ok(scope.includes("? [formatCustomerNumber(item.number), item.businessName, item.phone]"));
  assert.ok(scope.includes(': [item.code, item.businessName, item.phone]'), 'تبويب المناديب تغيّر');
  assert.match(scope, /interface Pick \{[^}]*number\?: number \| null \}/);
  const reps = read('pages', 'SalesRepsPage.tsx');
  const assign = slice(reps, 'function AssignCustomersModal(', '/* نوع الاستلام');
  assert.ok(assign.includes("placeholder={tr('ابحث بالاسم أو الجوال أو رقم العميل')}"));
  assert.doesNotMatch(assign, /c\.code/, 'الرمز الآلي ما زال احتياطياً في صفّ الإسناد');
  assert.ok(assign.includes('{formatCustomerNumber(c.number)}'));
});

test('الفواتير ولوحة البيانات والتتبّع والمندوب الذكي: الرقم بجانب اسم العميل', () => {
  const inv = read('pages', 'InvoicesPage.tsx');
  assert.ok(inv.includes("placeholder={tr('رقم الفاتورة أو اسم العميل أو رقمه')}"));
  assert.ok(inv.includes('{formatCustomerNumber(inv.customer.number)}'));
  const row = slice(inv, 'const rows = invoices.map(inv => ({', 'const res2 = await shareOrDownloadExcel(');
  const keys = [...row.matchAll(/\[tr\('([^']+)'\)\]:/g)].map((x) => x[1]);
  assert.deepEqual(keys.slice(0, 3), ['رقم الفاتورة', 'رقم العميل', 'العميل']);
  // العروض تتبع الأعمدة: كل مفتاح (والموقع حين يُفعَّل) له عرض
  const widths = inv.match(/colWidths: locOn \? \[([^\]]+)\] : \[([^\]]+)\]/);
  assert.ok(widths);
  assert.equal(widths![1].split(',').length, keys.length, 'عروض «لوكيشن»');
  assert.equal(widths![2].split(',').length, keys.length - 1, 'العروض بلا الموقع');
  const dash = read('pages', 'DashboardPage.tsx');
  assert.ok(dash.includes('{formatCustomerLabel(inv.customer)}') && dash.includes('{formatCustomerLabel(c)}'));
  const tracking = read('pages', 'TrackingPage.tsx');
  assert.ok(tracking.includes('{formatCustomerNumber(c.number)}') && tracking.includes('{formatCustomerNumber(p.customerNumber)}'));
  assert.ok(read('pages', 'AiRepPage.tsx').includes('{formatCustomerNumber(row.number)}'));
});

test('سندات القبض (سطح المكتب و/m): بحث الخادم برقم السند أو اسم العميل أو رقمه، والرقم بجانب الاسم وفي التصدير', () => {
  const rc = read('pages', 'ReceiptsPage.tsx');
  assert.ok(rc.includes("placeholder={tr('رقم السند أو اسم العميل أو رقمه')}"));
  assert.ok(rc.includes('if (search.trim()) f.search = search.trim();'), 'البحث يُرسل إلى GET /receipts');
  assert.ok(rc.includes("queryKey: ['receipts', search.trim(), salesRepId, from, to, page],"), 'مفتاح الاستعلام يتبع البحث');
  assert.ok(rc.includes('{formatCustomerNumber(r.customer.number)}'));
  const row = slice(rc, 'const rows = receipts.map(r => ({', 'const out = await shareOrDownloadExcel(');
  const keys = [...row.matchAll(/\[tr\('([^']+)'\)\]:/g)].map((x) => x[1]);
  assert.deepEqual(keys.slice(0, 3), ['رقم السند', 'رقم العميل', 'العميل']);
  const widths = rc.match(/colWidths: \[([^\]]+)\] \}\]/);
  assert.ok(widths);
  assert.equal(widths![1].split(',').length, keys.length, 'لكل عمودٍ عرض');
  const docs = read('m', 'MDocList.tsx');
  assert.ok(docs.includes('formatCustomerLabel({ name: cust.name, number: cust.number })'), '/m: «#12 · الاسم» في قائمة المستندات');
});

test('الدفاتر: منتقيا الشريك يعرضان الرقم، والقائمتان تقرآن customerNumber، والأرصدة اليدوية بلا الرمز الآلي', () => {
  for (const f of ['ledgerOps.ts', 'ledgerPartners.ts']) {
    assert.match(read('api', f), /export interface PartnerSearchItem \{ id: string; name: string; hint: string \| null; number\?: number \| null \}/, f);
  }
  const adj = read('pages', 'ledger', 'customers', 'CustomerAdjustmentsPage.tsx');
  assert.ok(adj.includes("placeholder={tr('ابحث بالاسم أو الجوال أو رقم العميل')}"));
  assert.ok(adj.includes('{numPrefix(value.number)}{value.name}') && adj.includes('{numPrefix(c.number)}{c.name}'));
  const parts = read('pages', 'ledger', 'reports', 'parts', 'PartnerReportParts.tsx');
  assert.ok(parts.includes("type === 'customer' && it.number != null"), 'الرقم للعملاء وحدهم');
  // خانة العميل في قوائم «العملاء» الثلاث من مصدرٍ واحد (postingFilters.customerCell)
  const shared = read('pages', 'ledger', 'customers', 'postingFilters.tsx');
  assert.ok(shared.includes('export function customerCell('), 'الخانة المشتركة');
  assert.ok(shared.includes('if (r.customerNumber == null) return r.customerName ?? \'\';'), 'صفٌّ بلا رقم كما كان');
  for (const f of ['InvoicePostingList.tsx', 'ReceiptPostingList.tsx', 'PaylinkClearingPage.tsx']) {
    const s = read('pages', 'ledger', 'customers', f);
    assert.match(s, /import \{[^}]*\bcustomerCell\b[^}]*\} from '\.\/postingFilters';/, `${f}: لا يستورد الخانة المشتركة`);
    assert.ok(/\{ key: 'customer', label: tr\('العميل'\), render: (customerCell|\(r: PaylinkEntryRow\) => customerCell\(r\)) \},/.test(s), f);
    assert.doesNotMatch(s, /function customerCell\(/, `${f}: نسخةٌ محلية من الخانة`);
  }
  const manual = read('pages', 'ledger', 'setup', 'ManualBalances.tsx');
  assert.ok(manual.includes("placeholder={tr('رقم العميل أو رمزه أو اسمه')}"));
  assert.ok(manual.includes('{formatCustomerNumber(c.number) || visibleCustomerCode(c.code)}'));
  assert.doesNotMatch(manual, /\{c\.code \?\? ''\}/, 'الرمز الآلي ما زال تسميةً في القائمة');
  assert.match(manual, /list="opening-balance-customers"/);
});

test('لا شاشة من شاشات سطح المكتب المعنيّة ترسم الرمز الآلي للعميل', () => {
  const files: string[][] = [
    ['pages', 'CustomersPage.tsx'], ['components', 'UserScopeModal.tsx'], ['pages', 'RepRoutesPage.tsx'],
    ['pages', 'ledger', 'setup', 'ManualBalances.tsx'],
  ];
  for (const f of files) {
    // خيار «القناة» في صفحة العملاء يحمل c.code لقناة البيع (SALES_CHANNELS) لا للعميل — يُستثنى سطره وحده
    const s = read(...f).replace('<option key={c.code} value={c.code}>{tr(c.ar)}</option>', '');
    // c.code خاماً في JSX — المسموح visibleCustomerCode(c.code) وحده (وitem.code لتبويب المناديب)
    assert.doesNotMatch(s, /\{c\.code\b/, f.join('/'));
    assert.doesNotMatch(s, /(\|\||\?\?) c\.code\b/, `${f.join('/')}: الرمز الآلي احتياطٌ للعرض`);
  }
});

// ═══ رسم: رأس «أرشيف العميل» ═══

let envReady = false;
function browserEnv(): void {
  if (envReady) return;
  envReady = true;
  const g = globalThis as { localStorage?: Storage };
  if (!g.localStorage) {
    const m = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); },
      removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null,
      get length() { return m.size; },
    } as Storage;
  }
  g.localStorage!.setItem('user', JSON.stringify({ id: 'u1', role: 'ADMIN', scopeEnabled: false }));
  const hook = `export async function load(url, ctx, next) {
    const r = await next(url, ctx);
    if (url.includes('/web-admin/src/') && r.source != null) {
      let src = String(r.source);
      if (src.includes('import.meta.env')) src = src.replace(/import\\.meta\\.env/g, '({})');
      if (url.endsWith('/src/store/authStore.ts')) src = src.replace(/window\\.location\\.pathname/g, '"/app"');
      return { ...r, source: src };
    }
    return r;
  }`;
  register(`data:text/javascript,${encodeURIComponent(hook)}`);
}

test('أرشيف العميل: الرأس يعرض «رقم العميل #12» متى رُقِّم — وبلا رقم الاسمُ وحده', async () => {
  browserEnv();
  const { default: CustomerStudioModal } = await import('../components/CustomerStudioModal');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  const render = (customer: { id: string; name: string; number?: number | null }) =>
    renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(CustomerStudioModal, { customer, onClose: () => {} })));
  const numbered = render({ id: 'c1', name: 'مؤسسة سمارة', number: 12 });
  assert.ok(numbered.includes('مؤسسة سمارة'));
  assert.ok(numbered.includes('رقم العميل'), 'العنوان');
  assert.match(numbered, /<span dir="ltr" class="tabular-nums">#12<\/span>/, 'الرقم بأرقامٍ لاتينية وباتجاهه');
  for (const n of [null, undefined]) {
    const plain = render({ id: 'c2', name: 'بقالة النور', number: n });
    assert.ok(plain.includes('بقالة النور'));
    assert.ok(!plain.includes('رقم العميل'), 'عنوانٌ بلا رقم');
    // نصٌّ «#N» ظاهر (لا ألوان الصفّ #1F1A13 في class)
    assert.doesNotMatch(plain, />[^<]*#\d+[^<]*</, 'رقمٌ معروض لعميلٍ لم يُرقَّم');
    assert.doesNotMatch(plain, /tabular-nums">/, 'خانة رقمٍ فارغة');
  }
});
