// صفحة «طرق الدفع» — منطقها الصرف (lib/paymentMethods.ts) وحرّاسٌ نصّية على توصيلها: القائمة تحت «الفواتير» بعَلَم الشركة
// والمحاسبة، والمسار بصلاحية التقارير، ومفتاح المالك مطفأ افتراضياً، وأسماء أوراق التصدير سليمة في اللغات الخمس.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PAYMENT_METHOD_KEYS, filterBlocks, localDay, methodLabel, paymentMethodsSheets, repLabel, sharePct, sumRows, uniqueSheetNames,
  type PmBlock, type PmRow,
} from './paymentMethods';
import { PHRASES } from '../i18n/strings';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const arTr = (s: string) => s;
const LANGS = ['en', 'fr', 'tr', 'zh'] as const;
const trOf = (l: typeof LANGS[number]) => (s: string) => PHRASES[s]?.[l] ?? s;

const row = (id: string, name: string, amount: number, count: number, over: Partial<PmRow> = {}): PmRow => ({
  salesRepId: id, repName: name, repActive: true, amount, count,
  receiptsAmount: amount, receiptsCount: count, invoicesAmount: 0, invoicesCount: 0, ...over,
});
const blockOf = (method: string, rows: PmRow[], noRep = { amount: 0, count: 0 }): PmBlock => ({ method, rows, total: sumRows(rows), noRep });

test('الطرق الخمس بترتيب الخادم، وأسماؤها من خريطة شاشة السندات', () => {
  assert.deepEqual([...PAYMENT_METHOD_KEYS], ['CASH', 'POS', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE']);
  assert.deepEqual(PAYMENT_METHOD_KEYS.map((m) => methodLabel(m, arTr)), ['نقدي', 'شبكة', 'تحويل بنكي', 'شيك', 'دفع الكتروني']);
  assert.equal(methodLabel('LEGACY', arTr), 'LEGACY', 'قيمةٌ غريبة تُعرض كما هي');
  // كل اسم طريقةٍ مترجمٌ في اللغات الأربع (الاسم يمرّ بـtr(متغيّر) فلا يلتقطه حارس القاموس الحرفيّ)
  for (const m of PAYMENT_METHOD_KEYS) for (const l of LANGS) assert.notEqual(methodLabel(m, trOf(l)), methodLabel(m, arTr), `${m}/${l}`);
});

test('اليوم بتقويم المتصفّح المحلي لا UTC', () => {
  assert.equal(localDay(new Date(2026, 9, 21, 1, 30)), '2026-10-21', 'الساعة ١:٣٠ فجراً يومٌ جديد');
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('المندوب الموقوف موسومٌ ويبقى تحصيله، والاسم الغائب شرطة', () => {
  assert.equal(repLabel({ repName: 'سالم', repActive: false }, arTr), 'سالم (موقوف)');
  assert.equal(repLabel({ repName: 'محمد', repActive: true }, arTr), 'محمد');
  assert.equal(repLabel({ repName: '', repActive: true }, arTr), '—');
});

test('البحث يقصّ الصفوف ويعيد حساب إجمالي المعروض — وبلا بحث الجداول كما جاءت', () => {
  const cash = blockOf('CASH', [
    row('a', 'محمد العتيبي', 300, 3, { receiptsAmount: 200, receiptsCount: 2, invoicesAmount: 100, invoicesCount: 1 }),
    row('b', 'خالد', 120.5, 2),
  ], { amount: 50, count: 1 });
  const pos = blockOf('POS', [row('b', 'خالد', 80, 1)]);
  const same = filterBlocks([cash, pos], '');
  assert.equal(same[0], cash, 'بلا بحث: الكائن نفسه (لا إعادة حساب)');
  const f = filterBlocks([cash, pos], 'محمد');
  assert.deepEqual(f[0].rows.map((r) => r.salesRepId), ['a']);
  assert.deepEqual([f[0].total.amount, f[0].total.count, f[0].total.receiptsAmount, f[0].total.invoicesAmount], [300, 3, 200, 100]);
  assert.deepEqual(f[0].noRep, { amount: 50, count: 1 }, 'سطر «بلا مندوب» من الخادم لا يمسّه البحث');
  assert.deepEqual(f[1].rows, [], 'جدولٌ بلا مطابق يبقى بلا صفوف');
  assert.deepEqual([f[1].total.amount, f[1].total.count], [0, 0]);
  // التطبيع العربي: «محمّد» بالتشكيل يطابق
  assert.equal(filterBlocks([cash], 'مُحمد')[0].rows.length, 1);
});

test('المجموع بالتقريب الموحّد (٣ منازل) والنسبة من المعروض', () => {
  assert.equal(sumRows([row('a', 'أ', 0.1, 1), row('b', 'ب', 0.2, 1)]).amount, 0.3);
  assert.equal(sumRows([row('a', 'أ', Number.NaN, 1)]).amount, 0);
  assert.equal(sharePct(25, 100), 25);
  assert.equal(sharePct(1, 3), 33);
  assert.equal(sharePct(5, 0), 0, 'إجمالي صفر لا قسمة');
});

test('أوراق التصدير: الإجمالي أولاً بالطرق الخمس، ثم ورقةٌ لكل طريقةٍ فيها تحصيل بصفّ إجماليها آخراً، والنقدي بشقّيه', () => {
  const blocks = [
    blockOf('CASH', [row('a', 'محمد', 315, 5, { receiptsAmount: 200, receiptsCount: 2, invoicesAmount: 115, invoicesCount: 3 })], { amount: 60, count: 1 }),
    blockOf('POS', []),
    blockOf('BANK_TRANSFER', [row('b', 'خالد', 100, 1), row('c', 'سالم', 40, 1, { repActive: false })]),
    blockOf('CHEQUE', []),
    blockOf('ONLINE', []),
  ];
  const sheets = paymentMethodsSheets(blocks, arTr);
  assert.deepEqual(sheets.map((s) => s.name), ['الإجمالي', 'نقدي', 'تحويل بنكي'], 'الطرق الفارغة بلا ورقة');
  assert.equal(sheets[0].rows.length, 5, 'ورقة الإجمالي بالطرق الخمس ولو صفراً');
  assert.deepEqual(sheets[0].rows[0], { 'طريقة الدفع': 'نقدي', 'المبلغ': 315, 'عدد العمليات': 5, 'تحصيل بلا مندوب': 60 });
  const cash = sheets[1].rows;
  assert.deepEqual(Object.keys(cash[0]), ['المندوب', 'المبلغ', 'عدد العمليات', 'من سندات القبض', 'عدد السندات', 'من الفواتير النقدية', 'عدد الفواتير']);
  assert.deepEqual(cash[cash.length - 1], { 'المندوب': 'الإجمالي', 'المبلغ': 315, 'عدد العمليات': 5, 'من سندات القبض': 200, 'عدد السندات': 2, 'من الفواتير النقدية': 115, 'عدد الفواتير': 3 });
  const bt = sheets[2].rows;
  assert.deepEqual(Object.keys(bt[0]), ['المندوب', 'المبلغ', 'عدد العمليات'], 'غير النقدي بلا أعمدة الشقّين');
  assert.equal(bt[1]['المندوب'], 'سالم (موقوف)');
  assert.deepEqual(bt[2], { 'المندوب': 'الإجمالي', 'المبلغ': 140, 'عدد العمليات': 2 });
});

test('أسماء الأوراق وعناوين الأعمدة سليمةٌ وفريدة في اللغات الخمس (التركية Havale/EFT فيها /)', () => {
  const full = PAYMENT_METHOD_KEYS.map((m) => blockOf(m, [row('a', 'محمد', 10, 1, m === 'CASH' ? { invoicesAmount: 5, invoicesCount: 1 } : {})]));
  for (const tr of [arTr, ...LANGS.map(trOf)]) {
    const sheets = paymentMethodsSheets(full, tr);
    const names = sheets.map((s) => s.name);
    assert.equal(new Set(names).size, names.length, `أسماء أوراق مكرّرة: ${names.join(' | ')}`);
    for (const n of names) {
      assert.ok(n.length > 0 && n.length <= 31, n);
      assert.ok(!/[\\/?*[\]:]/.test(n), `حرفٌ ممنوع في اسم ورقة Excel: ${n}`);
    }
    // مفاتيح الصفّ عناوين الأعمدة: ترجمتان متطابقتان تُسقطان عموداً بصمت
    const cashCols = Object.keys(sheets[1].rows[0]);
    assert.equal(cashCols.length, 7, `عمودٌ ابتلعه آخر: ${cashCols.join(' | ')}`);
    assert.equal(Object.keys(sheets[0].rows[0]).length, 4);
  }
  assert.deepEqual(uniqueSheetNames(['a/b', 'a·b', 'x'.repeat(40)]), ['a·b', 'a·b (2)', 'x'.repeat(31)]);
});

// ═══ حرّاس التوصيل ═══

test('القائمة: «طرق الدفع» تحت «الفواتير» مباشرة، بعَلَم الشركة `=== true` ومن الصفحات المحاسبية', () => {
  const s = read('layouts', 'MainLayout.tsx');
  const inv = s.indexOf("{ to: '/app/invoices'");
  const pm = s.indexOf("{ to: '/app/payment-methods'");
  const rc = s.indexOf("{ to: '/app/receipts'");
  assert.ok(inv > 0 && pm > inv && rc > pm, 'الترتيب: الفواتير ثم طرق الدفع ثم السندات');
  assert.match(s.slice(pm, s.indexOf('\n', pm)), /label: 'nav\.paymentMethods', permission: 'canViewReports' \}/);
  assert.ok(s.includes("(item.to !== '/app/payment-methods' || companyCfg?.paymentMethodsEnabled === true)"), 'العَلَم مطفأ افتراضياً: `=== true`');
  assert.match(s, /const ACCOUNTING_PAGES = \[[^\]]*'\/app\/payment-methods'/, 'المحاسبة المطفأة تخفيها');
  assert.match(s, /paymentMethodsEnabled\?: boolean \} \| null/, 'العَلَم في نوع إعدادات الشركة');
});

test('المسار بصلاحية التقارير، والصفحة تقدّم بوّابة المحاسبة على بوّابة العَلَم', () => {
  assert.ok(read('App.tsx').includes('<Route path="payment-methods" element={<PermissionRoute permission="canViewReports"><PaymentMethodsPage /></PermissionRoute>} />'));
  assert.match(read('api', 'client.ts'), /paymentMethods: \(params\?: Record<string, string>\) => api\.get\('\/reports\/payment-methods', \{ params \}\)/);
  const p = read('pages', 'PaymentMethodsPage.tsx');
  const acc = p.indexOf('if (!accountingOn) return <AccountingOffNotice />;');
  const flag = p.indexOf("if (!featureOn || errorCode(reportQ.error) === 'PAYMENT_METHODS_NOT_ALLOWED')");
  assert.ok(acc > 0 && flag > acc, 'المحاسبة أولاً ثم العَلَم');
  assert.match(p, /const featureOn = companyQ\.data\?\.paymentMethodsEnabled === true;/);
  assert.match(p, /enabled: accountingReady && accountingOn && featureOn && !rangeBad,/, 'لا طلب يردّه الخادم ٤٠٣');
  assert.ok(!p.includes('toISOString().slice(0, 10)'), 'اليوم المحلي لا UTC');
});

test('نافذة المالك: مفتاح «طرق الدفع» مطفأ افتراضياً (`!!`) ويُرسل في التحديث', () => {
  const s = read('pages', 'PlatformPage.tsx');
  assert.match(s, /useState\(!!tenant\.paymentMethodsEnabled\)/);
  assert.match(s, /\n {6}paymentMethodsEnabled,\n/, 'العَلَم في حمولة tenantApi.update');
  assert.ok(s.includes("{tr('تفعيل صفحة طرق الدفع لهذه الشركة')}"));
  assert.match(read('types', 'index.ts'), /paymentMethodsEnabled\?: boolean;/);
});
