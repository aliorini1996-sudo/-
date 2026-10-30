// صفحة «طرق الدفع» — منطقها الصرف (lib/paymentMethods.ts) وحرّاسٌ نصّية على توصيلها: القائمة تحت «الفواتير» بعَلَم الشركة
// والمحاسبة، والمسار بصلاحية التقارير، ومفتاح المالك مطفأ افتراضياً، وأسماء أوراق التصدير سليمة في اللغات الخمس.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PAYMENT_METHOD_KEYS, listTotal, localDay, methodLabel, repLabel, repListSheets, repMethodList, sumRows, uniqueSheetNames,
  type PaymentMethodsData, type PmBlock, type PmRow,
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

const dataOf = (blocks: PmBlock[], roster?: PaymentMethodsData['roster']): PaymentMethodsData => ({
  range: { from: '2026-10-21', to: '2026-10-21', timezone: 'Asia/Riyadh' },
  methods: blocks, total: { amount: 0, count: 0 }, noRep: { amount: 0, count: 0 }, repsCount: 0, roster,
});
const FIVE = (cash: PmRow[], bt: PmRow[] = [], noRepCash = { amount: 0, count: 0 }) => [
  blockOf('CASH', cash, noRepCash), blockOf('POS', []), blockOf('BANK_TRANSFER', bt), blockOf('CHEQUE', []), blockOf('ONLINE', []),
];

test('القائمة: كلّ مناديب النطاق بالطرق الخمس ولو صفراً، بترتيب الخادم، وإجماليُّ كلّ مندوب', () => {
  const blocks = FIVE(
    [row('a', 'محمد', 300, 3, { receiptsAmount: 200, receiptsCount: 2, invoicesAmount: 100, invoicesCount: 1 })],
    [row('a', 'محمد', 50, 1)],
  );
  const roster = [{ salesRepId: 'b', repName: 'بدر', repActive: true }, { salesRepId: 'a', repName: 'محمد', repActive: true }];
  const list = repMethodList(dataOf(blocks, roster));
  assert.deepEqual(list.map((g) => g.salesRepId), ['b', 'a'], 'ترتيب الخادم (بالاسم) كما جاء');
  for (const g of list) assert.deepEqual(g.lines.map((l) => l.method), ['CASH', 'POS', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE'], 'المندوب يتكرّر مع كلّ طريقة');
  assert.deepEqual(list[0].lines.map((l) => l.amount), [0, 0, 0, 0, 0], 'بلا تحصيل: أصفار لا غياب');
  const m = list[1];
  assert.deepEqual([m.lines[0].amount, m.lines[0].receiptsAmount, m.lines[0].invoicesAmount], [300, 200, 100], 'النقدي بشقّيه');
  assert.equal(m.lines[2].amount, 50);
  assert.deepEqual([m.total.amount, m.total.count], [350, 4]);
  assert.deepEqual([listTotal(list).amount, listTotal(list).count], [350, 4]);
});

test('ردٌّ قديم بلا roster، أو حصّل مندوبٌ ليس فيها: يُلحق فلا يسقط تحصيله', () => {
  const blocks = FIVE([row('a', 'محمد', 10, 1), row('z', 'سالم', 5, 1, { repActive: false })]);
  assert.deepEqual(repMethodList(dataOf(blocks)).map((g) => g.salesRepId), ['a', 'z']);
  const list = repMethodList(dataOf(blocks, [{ salesRepId: 'a', repName: 'محمد', repActive: true }]));
  assert.deepEqual(list.map((g) => g.salesRepId), ['a', 'z']);
  assert.equal(list[1].repActive, false);
});

test('البحث يقصّ المناديب ويُبقي سطورهم كاملة — وإجماليُّ المعروض لهم وحدهم', () => {
  const blocks = FIVE([row('a', 'محمد العتيبي', 300, 3), row('b', 'خالد', 120.5, 2)]);
  const all = repMethodList(dataOf(blocks));
  assert.equal(all.length, 2);
  const f = repMethodList(dataOf(blocks), 'محمد');
  assert.deepEqual(f.map((g) => g.salesRepId), ['a']);
  assert.equal(f[0].lines.length, 5);
  assert.equal(listTotal(f).amount, 300);
  assert.equal(repMethodList(dataOf(blocks), 'مُحمد').length, 1, 'التطبيع العربي');
  assert.equal(repMethodList(dataOf(blocks), 'لا أحد').length, 0);
});

test('المجموع بالتقريب الموحّد (٣ منازل)', () => {
  assert.equal(sumRows([row('a', 'أ', 0.1, 1), row('b', 'ب', 0.2, 1)]).amount, 0.3);
  assert.equal(sumRows([row('a', 'أ', Number.NaN, 1)]).amount, 0);
});

test('التصدير: ورقة القائمة باسم المندوب مكرَّراً مع كلّ طريقة ثم إجماليّه والإجمالي العامّ، ثم ورقة الإجمالي بالطرق', () => {
  const blocks = FIVE(
    [row('a', 'محمد', 315, 5, { receiptsAmount: 200, receiptsCount: 2, invoicesAmount: 115, invoicesCount: 3 })],
    [row('c', 'سالم', 40, 1, { repActive: false })],
    { amount: 60, count: 1 },
  );
  const data = dataOf(blocks, [{ salesRepId: 'a', repName: 'محمد', repActive: true }, { salesRepId: 'c', repName: 'سالم', repActive: false }]);
  const sheets = repListSheets(repMethodList(data), data, arTr);
  assert.deepEqual(sheets.map((s) => s.name), ['قائمة المناديب', 'الإجمالي']);
  const rows = sheets[0].rows;
  assert.equal(rows.length, 2 * 6 + 1, 'لكل مندوب خمس طرق وإجماليّه، ثم الإجمالي العام');
  assert.deepEqual(Object.keys(rows[0]), ['المندوب', 'طريقة الدفع', 'المبلغ', 'عدد العمليات', 'من سندات القبض', 'من الفواتير النقدية']);
  assert.deepEqual(rows[0], { 'المندوب': 'محمد', 'طريقة الدفع': 'نقدي', 'المبلغ': 315, 'عدد العمليات': 5, 'من سندات القبض': 200, 'من الفواتير النقدية': 115 });
  assert.equal(rows[1]['من سندات القبض'], '', 'الشقّان للنقدي وحده');
  assert.deepEqual(rows[5], { 'المندوب': 'محمد', 'طريقة الدفع': 'الإجمالي', 'المبلغ': 315, 'عدد العمليات': 5, 'من سندات القبض': 200, 'من الفواتير النقدية': 115 });
  assert.equal(rows[6]['المندوب'], 'سالم (موقوف)');
  assert.deepEqual(rows[12], { 'المندوب': 'الإجمالي', 'طريقة الدفع': '', 'المبلغ': 355, 'عدد العمليات': 6, 'من سندات القبض': 240, 'من الفواتير النقدية': 115 });
  assert.equal(sheets[1].rows.length, 5);
  assert.deepEqual(sheets[1].rows[0], { 'طريقة الدفع': 'نقدي', 'المبلغ': 315, 'عدد العمليات': 5, 'تحصيل بلا مندوب': 60 });
});

test('أسماء الأوراق وعناوين الأعمدة سليمةٌ وفريدة في اللغات الخمس', () => {
  const blocks = PAYMENT_METHOD_KEYS.map((m) => blockOf(m, [row('a', 'محمد', 10, 1)]));
  for (const tr of [arTr, ...LANGS.map(trOf)]) {
    const data = dataOf(blocks);
    const sheets = repListSheets(repMethodList(data), data, tr);
    const names = sheets.map((s) => s.name);
    assert.equal(new Set(names).size, names.length, `أسماء أوراق مكرّرة: ${names.join(' | ')}`);
    for (const n of names) {
      assert.ok(n.length > 0 && n.length <= 31, n);
      assert.ok(!/[\\/?*[\]:]/.test(n), `حرفٌ ممنوع في اسم ورقة Excel: ${n}`);
    }
    assert.equal(Object.keys(sheets[0].rows[0]).length, 6, 'عمودٌ ابتلعه آخر');
    assert.equal(Object.keys(sheets[1].rows[0]).length, 4);
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
  assert.match(s, /paymentMethodsEnabled\?: boolean(; \w+\?: boolean)* \} \| null/, 'العَلَم في نوع إعدادات الشركة');
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
