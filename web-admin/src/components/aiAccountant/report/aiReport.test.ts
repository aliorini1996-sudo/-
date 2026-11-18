import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHRASES } from '../../../i18n/strings';
import { formatDayOnly, setActiveNumerals } from '../../../utils/format';
import {
  buildReportPrintHtml, flattenReport, isEstimatedReport, notesWeight, paginateReport, pdfDeliveryFor, reportFileName,
  reportKindName, reportPeriodSlug, reportPeriodText, reportRowView, reportTitle, roundToCurrency, rowNote, rowWeight, type FlatRow,
} from './reportPdf';

/**
 * «المحاسب الذكي AI» — حزمة C2 (تقارير الويب): منطق البطاقة والورقة النقيّ، وحرّاس المصدر (الهوية والشرائح والتقويم الميلادي)،
 * وكل نصٍّ معروض له ترجماته الأربع في القاموس (عبارات الحزمة مدموجةٌ فيه — C2_PHRASES أدناه).
 */
const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(join(here, f), 'utf8');
const CARD = src('ReportCard.tsx');
const SHEET = src('AiReportSheet.tsx');
const LOGIC = src('reportPdf.ts');

// أرقام لاتينية للتحقّق النصّي (الافتراضي العربية ٠١٢٣ — اختيار الشركة يسري على كل رقم)
setActiveNumerals('latin');

type Report = Parameters<typeof flattenReport>[0] & Parameters<typeof reportFileName>[0] & { currency: string; notes: string[]; estimated?: boolean };
const income = (over: Partial<Report> = {}): Report => ({
  kind: 'income-statement',
  title: 'قائمة الدخل — نوفمبر 2026',
  period: { from: '2026-11-01', to: '2026-11-18' },
  currency: 'SAR',
  sections: [
    { title: 'الإيرادات', rows: [{ label: 'المبيعات', amount: 12500.5, level: 1 }, { label: 'إجمالي الإيرادات', amount: 12500.5, bold: true }] },
    { title: 'المصروفات', rows: [{ label: 'إيجار', amount: -3000, level: 1 }, { label: 'عدد الفواتير', amount: null, text: '12 فاتورة' }] },
  ],
  notes: [],
  ...over,
});

test('اسم الملف: «قائمة-الدخل-2026-11.pdf» — نوعٌ معتمد وشهرٌ بأرقام لاتينية', () => {
  assert.equal(reportFileName(income()), 'قائمة-الدخل-2026-11.pdf');
  // شهرٌ كامل بحدٍّ مفتوح (أوّل الشهر التالي) شهرٌ أيضاً
  assert.equal(reportFileName(income({ period: { from: '2026-11-01', to: '2026-12-01' } })), 'قائمة-الدخل-2026-11.pdf');
  // ديسمبر ⇒ يناير السنة التالية
  assert.equal(reportPeriodSlug({ from: '2026-12-01', to: '2027-01-01' }), '2026-12');
  assert.equal(reportFileName(income({ kind: 'trial-balance', period: { from: '2026-01-01', to: '2026-12-31' } })), 'ميزان-المراجعة-2026.pdf');
  assert.equal(reportFileName(income({ kind: 'balance-sheet', period: { from: '2026-11-18', to: '2026-11-18' } })), 'الميزانية-العمومية-2026-11-18.pdf');
  assert.equal(reportFileName(income({ kind: 'sales', period: { from: '2026-01-15', to: '2026-03-31' } })), 'ملخص-المبيعات-2026-01-15_2026-03-31.pdf');
  assert.equal(reportFileName(income({ kind: 'receivables', period: null })), 'ذمم-العملاء.pdf');
  // تاريخٌ بلحظة (ISO كامل) يُقرأ يومه
  assert.equal(reportPeriodSlug({ from: '2026-11-01T00:00:00.000Z', to: '2026-11-30T00:00:00.000Z' }), '2026-11');
  assert.equal(reportPeriodSlug({ from: 'x', to: '2026-11-30' }), '');
});

test('اسم الملف آمن: نوعٌ مجهول ⇒ العنوان بلا محارف ممنوعة، وبلا عنوان ⇒ «تقرير»، والترجمة تسري', () => {
  const odd = income({ kind: 'mystery' as string as Report['kind'], title: 'تقرير: أ/ب * "خاص" <x>|?', period: null });
  const name = reportFileName(odd);
  assert.doesNotMatch(name, /[\\/:*?"<>|\s]/);
  assert.ok(name.endsWith('.pdf'));
  assert.equal(reportFileName(income({ kind: 'mystery' as string as Report['kind'], title: '', period: null })), 'تقرير.pdf');
  const en = (s: string) => (s === 'قائمة الدخل' ? 'Income statement' : s);
  assert.equal(reportFileName(income(), en), 'Income-statement-2026-11.pdf');
  assert.ok(reportFileName(income({ title: 'x'.repeat(400), kind: 'mystery' as string as Report['kind'] })).length <= 124);
});

test('أسماء الأنواع الاثني عشر كلّها معرّفة ومارّة بالترجمة', () => {
  const kinds = ['income-statement', 'balance-sheet', 'trial-balance', 'executive-summary', 'general-ledger', 'sales', 'collections',
    'purchases-inventory', 'receivables', 'expenses', 'profit-estimate', 'top'];
  const seen: string[] = [];
  for (const k of kinds) {
    const name = reportKindName(k, (s) => { seen.push(s); return s; });
    assert.ok(name.length > 0, k);
  }
  assert.equal(new Set(seen).size, kinds.length, 'اسمٌ مكرّر لنوعين');
  assert.equal(reportKindName('nope'), '');
});

test('سطر التقرير: المبلغ بالعملة بمنزلتين، والنصّ حين لا مبلغ، والمستوى والإبراز والسالب', () => {
  const fmt = (a: number, c?: string) => `${c}:${a.toFixed(2)}`;
  assert.deepEqual(reportRowView({ label: 'المبيعات', amount: 12500.5, level: 1 }, 'SAR', fmt),
    { label: 'المبيعات', value: 'SAR:12500.50', note: '', level: 1, bold: false, negative: false, muted: false });
  assert.deepEqual(reportRowView({ label: 'إيجار', amount: -3000, bold: true }, 'SAR', fmt),
    { label: 'إيجار', value: 'SAR:-3000.00', note: '', level: 0, bold: true, negative: true, muted: false });
  assert.deepEqual(reportRowView({ label: 'عدد الفواتير', amount: null, text: ' 12 فاتورة ' }, 'SAR', fmt),
    { label: 'عدد الفواتير', value: '12 فاتورة', note: '', level: 0, bold: false, negative: false, muted: true });
  assert.equal(reportRowView({ label: 'x', amount: null }, 'SAR', fmt).value, '');
  // مستوىً خارج ٠–٢ ⇒ ٠، وNaN لا يُكتب مبلغاً
  assert.equal(reportRowView({ label: 'x', amount: 1, level: 7 as number as 0 }, 'SAR', fmt).level, 0);
  assert.equal(reportRowView({ label: 'x', amount: Number.NaN }, 'SAR', fmt).muted, true);
});

test('سطرٌ بمبلغٍ ونصٍّ معاً: المبلغ قيمةٌ والنصّ ملاحظةٌ بجانب البند — لا تضيع أعداد الفواتير ولا الكميات ولا حالة العميل', () => {
  const fmt = (a: number, c?: string) => `${c}:${a.toFixed(2)}`;
  // كـopsTools: row('مبيعات نقدية', m(cashTotal), { text: '12 فاتورة' })
  assert.deepEqual(reportRowView({ label: 'مبيعات نقدية', amount: 4800, text: ' 12 فاتورة ' }, 'SAR', fmt),
    { label: 'مبيعات نقدية', value: 'SAR:4800.00', note: '12 فاتورة', level: 0, bold: false, negative: false, muted: false });
  // كمية الصنف بجانب مبلغه، وحالة العميل («محظور») بجانب رصيده
  assert.equal(reportRowView({ label: 'أرز ١٠ كجم', amount: 900, text: '30 كرتون' }, 'SAR', fmt).note, '30 كرتون');
  assert.equal(reportRowView({ label: 'مؤسسة الندى', amount: 5200, level: 1, text: 'محظور' }, 'SAR', fmt).note, 'محظور');
  // بلا مبلغ يبقى النصّ قيمةً لا ملاحظة (لا تكرار)، ونصٌّ فارغ لا ملاحظة
  assert.equal(rowNote({ amount: null, text: '12 فاتورة' }), '');
  assert.equal(rowNote({ amount: 10, text: '   ' }), '');
  assert.equal(rowNote({ amount: Number.NaN, text: 'x' }), '');
  // الملاحظة تُحسب في وزن السطر (بندٌ قصير بملاحظةٍ طويلة يلتفّ)
  assert.equal(rowWeight({ kind: 'row', key: 'k', row: { label: 'ب'.repeat(40), amount: 1, text: 'ن'.repeat(20) } }), 2);
  assert.equal(rowWeight({ kind: 'row', key: 'k', row: { label: 'ب'.repeat(40), amount: null, text: 'ن'.repeat(20) } }), 1);
  // البطاقة والورقة ترسمانها بجانب البند
  assert.match(CARD, /\{v\.note && <span className="ms-1\.5 [^"]*">\{tr\(v\.note\)\}<\/span>\}/);
  assert.match(SHEET, /\{v\.note && <span style=\{\{[^}]*marginRight: 6[^}]*\}\}>\{tr\(v\.note\)\}<\/span>\}/);
});

test('العنوان: بالعربية عنوان الخادم بتفصيله، وبغيرها اسم النوع مترجماً — لا ترويسة PDF عربية في الواجهة الإنجليزية', () => {
  const en = (s: string) => PHRASES[s]?.en ?? s;
  assert.equal(reportTitle(income(), 'en', en), en('قائمة الدخل'));
  assert.match(reportTitle(income(), 'en', en), /^Income statement$/i);
  assert.equal(reportTitle(income({ kind: 'receivables', title: 'ذمم العملاء كما في 2026-11-18' }), 'en', en), en('ذمم العملاء'));
  assert.doesNotMatch(reportTitle(income({ kind: 'profit-estimate', title: 'تقدير الربح الإجمالي' }), 'en', en), /[؀-ۿ]/);
  for (const k of ['income-statement', 'balance-sheet', 'trial-balance', 'executive-summary', 'general-ledger', 'sales', 'collections',
    'purchases-inventory', 'receivables', 'expenses', 'profit-estimate', 'top']) {
    for (const l of ['en', 'fr', 'tr', 'zh'] as const) {
      const t = reportTitle(income({ kind: k as Report['kind'] }), l, (s) => PHRASES[s]?.[l] ?? s);
      assert.doesNotMatch(t, /[؀-ۿ]/, `${k}/${l}: ${t}`);
    }
  }
  // العربية: عنوان الخادم كما هو (يحمل «كما في …»)، وبلا عنوانٍ اسم النوع
  assert.equal(reportTitle(income({ kind: 'receivables', title: 'ذمم العملاء كما في 2026-11-18' }), 'ar'), 'ذمم العملاء كما في 2026-11-18');
  assert.equal(reportTitle(income({ title: '' }), 'ar'), 'قائمة الدخل');
  // نوعٌ مجهول: عنوان الخادم (عبر tr)، وبلا شيء «تقرير»
  assert.equal(reportTitle(income({ kind: 'mystery' as string as Report['kind'], title: 'تقرير خاص' }), 'en', en), 'تقرير خاص');
  assert.equal(reportTitle(income({ kind: 'mystery' as string as Report['kind'], title: '' }), 'en', en), en('تقرير'));
  // البطاقة والورقة تأخذان العنوان منه بلغة الواجهة، وعناوين الأقسام والبنود تمرّ بـtr
  for (const s of [CARD, SHEET]) {
    assert.match(s, /const title = reportTitle\(report, lang, tr\)/);
    assert.match(s, /const lang = useLang\(\(s\) => s\.lang\)/);
    assert.match(s, /\{tr\(f\.title\)\}/);
    assert.match(s, /\{tr\(v\.label\)\}/);
  }
});

test('بنود الخادم الثابتة وعناوين أقسامه مترجمةٌ في القاموس (تمرّ بـtr في البطاقة والورقة)', () => {
  const fixed = ['الإيرادات', 'المصروفات', 'المبيعات', 'التحصيل', 'سندات القبض حسب طريقة الدفع', 'أعلى العملاء', 'أعلى الأصناف',
    'أعلى المناديب', 'أعلى العملاء مديونية', 'الأداء', 'النقد والسيولة', 'مبيعات نقدية', 'مبيعات آجلة', 'إجمالي المحصَّل',
    'الربح الإجمالي التقديري', 'تكلفة البضاعة المباعة (تقديرية)', 'أرصدة مدينة', 'أرصدة دائنة', 'إجمالي المصروفات', 'محظور', 'موقوف'];
  for (const k of fixed) {
    const v = PHRASES[k];
    assert.ok(v, `${k} غائب عن القاموس`);
    for (const l of ['en', 'fr', 'tr', 'zh'] as const) assert.doesNotMatch(v[l], /[؀-ۿ]/, `${k}.${l}`);
    assert.ok(!v.fr.includes("'"), `${k}.fr فيه فاصلة عليا لاتينية`);
  }
});

test('التقريب لمنازل العملة: لا «-0.00» ولا أحمر لسالبٍ يقرَّب صفراً، والدينار ثلاث منازل', () => {
  assert.equal(roundToCurrency(-0.004, 'SAR'), 0);
  assert.ok(Object.is(roundToCurrency(-0.004, 'SAR'), 0));
  assert.equal(roundToCurrency(1.005, 'KWD'), 1.005);
  assert.equal(roundToCurrency(2.345, 'SAR'), 2.35);
  const v = reportRowView({ label: 'فرق', amount: -0.001 }, 'SAR');
  assert.equal(v.negative, false);
  assert.doesNotMatch(v.value, /-/);
});

test('التنسيق الفعلي (formatCurrency): منزلتان وأرقام الشركة — لاتينية هنا', () => {
  const v = reportRowView({ label: 'المبيعات', amount: 12500.5 }, 'SAR');
  assert.match(v.value, /12,500\.50/);
  assert.doesNotMatch(v.value, /[٠-٩]/);
});

test('التاريخ ميلادي دائماً (ca-gregory) — لا سنة هجرية في الفترة', () => {
  const t = reportPeriodText({ from: '2026-11-01', to: '2026-11-18' });
  assert.match(t, /2026/);
  assert.doesNotMatch(t, /1448|هـ/);
  assert.equal(reportPeriodText({ from: '2026-11-18', to: '2026-11-18' }), formatDayOnly('2026-11-18'));
  assert.equal(reportPeriodText(null), '');
  assert.equal(reportPeriodText({ from: '2026-11-01', to: '2026-11-18' }, (d) => d), '2026-11-01 — 2026-11-18');
});

test('«تقديري»: العلم الصريح أو نوع تقدير الربح', () => {
  assert.equal(isEstimatedReport({ kind: 'income-statement', estimated: undefined }), false);
  assert.equal(isEstimatedReport({ kind: 'sales', estimated: true }), true);
  assert.equal(isEstimatedReport({ kind: 'profit-estimate', estimated: undefined }), true);
});

test('التسطيح: عنوان القسم ثم بنوده، وقسمٌ بلا بنود ⇒ «لا توجد بيانات»، وتقريرٌ فارغ ⇒ سطرٌ واحد', () => {
  const flat = flattenReport(income());
  assert.deepEqual(flat.map((f) => f.kind), ['section', 'row', 'row', 'section', 'row', 'row']);
  assert.equal(new Set(flat.map((f) => f.key)).size, flat.length, 'مفاتيح مكرّرة');
  assert.deepEqual(flattenReport({ sections: [{ title: 'الأصول', rows: [] }] }).map((f) => f.kind), ['section', 'empty']);
  assert.deepEqual(flattenReport({ sections: [] }).map((f) => f.kind), ['empty']);
  assert.deepEqual(flattenReport({ sections: [{ title: null, rows: [{ label: 'أ', amount: 1 }] }] }).map((f) => f.kind), ['row']);
});

test('الشرائح: لا تتجاوز سعتها، ولا عنوان قسمٍ يتيم آخر شريحة، والذيل يأخذ شريحةً إن لم يتّسع', () => {
  const rows: FlatRow[] = [];
  for (let s = 0; s < 6; s++) {
    rows.push({ kind: 'section', key: `s${s}`, title: `قسم ${s}` });
    for (let r = 0; r < 15; r++) rows.push({ kind: 'row', key: `s${s}r${r}`, row: { label: `بند ${r}`, amount: r } });
  }
  const cap = { first: 24, rest: 38 };
  const slices = paginateReport(rows, cap);
  assert.deepEqual(slices.flat().map((r) => r.key), rows.map((r) => r.key), 'سطورٌ ضاعت أو تكرّرت أو تبدّل ترتيبها');
  slices.forEach((sl, i) => {
    const w = sl.reduce((s, r) => s + rowWeight(r), 0);
    assert.ok(w <= (i === 0 ? cap.first : cap.rest), `الشريحة ${i} تجاوزت سعتها (${w})`);
    if (sl.length > 1) assert.notEqual(sl[sl.length - 1].kind, 'section', `عنوان قسمٍ يتيم آخر الشريحة ${i}`);
  });
  // بندٌ طويلٌ يلتفّ سطرين
  assert.equal(rowWeight({ kind: 'row', key: 'k', row: { label: 'ح'.repeat(80), amount: 1 } }), 2);
  // ذيلٌ لا يتّسع ⇒ شريحةٌ أخيرة فارغة له
  const full: FlatRow[] = Array.from({ length: 24 }, (_, i) => ({ kind: 'row', key: `r${i}`, row: { label: 'ب', amount: i } }));
  assert.equal(paginateReport(full, cap, notesWeight(['ملاحظة'])).length, 2);
  assert.equal(paginateReport(full.slice(0, 10), cap, notesWeight(['ملاحظة'])).length, 1);
  assert.equal(paginateReport([], cap).length, 1);
});

test('وثيقة الطباعة: A4 وكل شريحة صفحة، وأنماط الصفحة في الرأس', () => {
  const html = buildReportPrintHtml(['<div data-pdf-slice>أ</div>', '<div data-pdf-slice>ب</div>'], '<style>x{}</style>');
  assert.match(html, /^<!DOCTYPE html><html dir="rtl">/);
  assert.match(html, /@page \{ size: A4;/);
  assert.match(html, /break-before: page/);
  assert.match(html, /<style>x\{\}<\/style>/);
  assert.equal((html.match(/class="ai-sheet"/g) ?? []).length, 2);
});

test('التسليم: /m مشاركةٌ (الجوال)، واللوحة تنزيل', () => {
  assert.equal(pdfDeliveryFor('/m'), 'share');
  assert.equal(pdfDeliveryFor('/m/ai-accountant'), 'share');
  assert.equal(pdfDeliveryFor('/app/ai-accountant'), 'download');
  assert.equal(pdfDeliveryFor('/maghreb'), 'download');
});

test('المصدر: الورقة بهوية الشركة — Header وvoucherCompany ولون الشركة وشرائح A4 بعرض 794', () => {
  assert.match(SHEET, /<Header title=\{title\} company=\{co\} \/>/);
  assert.match(SHEET, /const co = voucherCompany\(company\)/);
  assert.match(SHEET, /brandColor\(co\)/);
  assert.match(SHEET, /background: brand/);
  assert.match(SHEET, /data-pdf-slice/);
  assert.match(SHEET, /width: 794/);
  assert.match(SHEET, /forwardRef<HTMLDivElement/);
  assert.match(SHEET, /export default AiReportSheet/);
});

test('المصدر: البطاقة تجلب الهوية بـ[\'company\'] وتلتقط خارج الشاشة بإطارين ثم PDF أو طباعة', () => {
  assert.match(CARD, /queryKey: \['company'\]/);
  assert.match(CARD, /companyApi\.get\(\)/);
  assert.match(CARD, /left: '-10000px'/);
  assert.match(CARD, /requestAnimationFrame\(\(\) => requestAnimationFrame\(r\)\)/);
  assert.match(CARD, /elementsToPdfBlob\(slices\)/);
  assert.match(CARD, /downloadPdf\(blob, name\)/);
  assert.match(CARD, /shareOrDownloadPdf\(blob, name\)/);
  assert.match(CARD, /printHtmlDocument\(/);
  assert.match(CARD, /export default function ReportCard\(\{ report \}: \{ report: AiReport \}\)/);
  // الأنواع من عقد C1 لا تعريفٌ محلّي منافس
  for (const s of [CARD, SHEET, LOGIC]) assert.match(s, /from '\.\.\/\.\.\/\.\.\/lib\/aiAccountant'/);
});

test('المصدر: لا تنسيق تاريخٍ خارج أدوات utils/format (الميلادية) ولا innerHTML بنصّ الخادم', () => {
  for (const [name, s] of [['ReportCard', CARD], ['AiReportSheet', SHEET], ['reportPdf', LOGIC]] as const) {
    assert.doesNotMatch(s, /toLocaleDateString|toLocaleString\(|new Intl\.DateTimeFormat|islamic/, `${name}: تنسيق تاريخٍ خارج الأدوات`);
    assert.doesNotMatch(s, /dangerouslySetInnerHTML|\.innerHTML\s*=/, `${name}: innerHTML`);
  }
  assert.match(SHEET, /formatDateTime\(/);
  assert.match(LOGIC, /formatDayOnly/);
});

/**
 * العبارات التي أضافتها حزمة C2 — مدموجةٌ في القاموس (strings.ts، قسم «المحاسب الذكي AI — حزمة C2»). القائمة تُبقي حارس
 * «لا عبارة ميتة»: كلٌّ منها مستعملٌ في ملفات الحزمة، وترجماتها الأربع من القاموس نفسه لا نسخةٌ تنحرف عنه.
 */
export const C2_PHRASES: readonly string[] = [
  'تحميل PDF', 'تقديري', 'أرقام تقديرية وليست من الدفاتر المحاسبية', 'أعده المحاسب الذكي من بيانات النظام',
  'ملخص المبيعات', 'تقدير الربح', 'أفضل العملاء والأصناف',
];

const ARABIC = /[؀-ۿ]/;

test('الترجمات: كل tr(\'…\') في ملفات الحزمة في القاموس، وعبارات الحزمة كلها مستعملة', () => {
  const used = new Set<string>();
  for (const s of [CARD, SHEET, LOGIC]) {
    for (const m of s.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) if (ARABIC.test(m[1])) used.add(m[1]);
  }
  assert.ok(used.size >= 20, `عبارات أقلّ من المتوقّع (${used.size})`);
  const missing = [...used].filter((k) => !PHRASES[k]);
  assert.deepEqual(missing, [], `بلا ترجمة: ${missing.join(' | ')}`);
  // القائمة لا تحمل عبارةً غير مستعملة
  const unused = C2_PHRASES.filter((k) => !used.has(k));
  assert.deepEqual(unused, [], `عبارات غير مستعملة: ${unused.join(' | ')}`);
});

test('الترجمات: أربع لغات غير فارغة، بلا عربية متسرّبة، والفرنسية بـ’ لا \'', () => {
  for (const k of C2_PHRASES) {
    const v = PHRASES[k];
    assert.ok(v, `${k} غائب عن القاموس`);
    assert.deepEqual(Object.keys(v).sort(), ['en', 'fr', 'tr', 'zh'], k);
    for (const l of ['en', 'fr', 'tr', 'zh'] as const) {
      assert.ok(v[l].trim().length > 0, `${k}.${l} فارغ`);
      assert.doesNotMatch(v[l], ARABIC, `${k}.${l} فيه عربية`);
    }
    assert.ok(!v.fr.includes("'"), `${k}.fr فيه فاصلة عليا لاتينية`);
  }
});
