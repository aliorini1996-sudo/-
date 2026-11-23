// «عمر الدين» في تقرير أرصدة العملاء (طلب المالك ٢٣ نوفمبر ٢٠٢٦): قراءة حقل aging من الخادم وعرضه، ثم ربطه بصفحة التقارير
// وتطبيق الجوال، والمفاتيح المترجمة، ومستند API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEBT_AGE_BANDS, DEBT_AGE_BAND_LABELS, debtAgeParts, debtAgeSplit, debtAgeTone, debtAgingOf, type DebtAging } from './debtAging';
import { PHRASES } from '../i18n/strings';

const src = (rel: string) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const aging = (o: Partial<DebtAging> = {}): DebtAging => ({
  oldestDay: '2026-10-01', ageDays: 53, overdueDays: 0, overdueAmount: 0,
  bands: { d0_30: 0, d31_60: 900, d61_90: 0, d90_plus: 0 }, undated: 0, ...o,
});

test('القراءة: حقلٌ غائب أو تالف ⇒ null (خادمٌ أقدم أو عميلٌ غير مدين)، والأرقام غير الصالحة صفر لا NaN', () => {
  assert.equal(debtAgingOf({}), null);
  assert.equal(debtAgingOf({ aging: null }), null);
  assert.equal(debtAgingOf({ aging: 'x' }), null);
  assert.equal(debtAgingOf({ aging: { ageDays: 3 } }), null, 'بلا شرائح');
  assert.equal(debtAgingOf(null), null);
  const a = debtAgingOf({ aging: { oldestDay: '2026-10-01', ageDays: 53, overdueDays: 'x', bands: { d0_30: 5, d90_plus: Number.NaN }, undated: 2 } })!;
  assert.equal(a.ageDays, 53);
  assert.equal(a.overdueDays, 0);
  assert.deepEqual(a.bands, { d0_30: 5, d31_60: 0, d61_90: 0, d90_plus: 0 });
  assert.equal(a.undated, 2);
  assert.equal(debtAgingOf({ aging: { ageDays: null, bands: {} } })!.ageDays, null, 'العمر المجهول يبقى null لا صفراً');
});

test('الشرائح: ذوات المبلغ وحدها بترتيبها، و«بلا تاريخ» آخراً — والتوزيع يُعرض حين تتعدّد', () => {
  const one = aging();
  assert.deepEqual(debtAgeParts(one).map(p => p.key), ['d31_60']);
  assert.equal(debtAgeSplit(one), false);
  const many = aging({ bands: { d0_30: 100, d31_60: 0, d61_90: 0, d90_plus: 300 }, undated: 50 });
  assert.deepEqual(debtAgeParts(many).map(p => p.key), ['d0_30', 'd90_plus', 'undated']);
  assert.deepEqual(debtAgeParts(many).map(p => p.label), ['0 إلى 30 يوما', 'أكثر من 90 يوما', 'بلا تاريخ']);
  assert.equal(debtAgeSplit(many), true);
});

test('اللون: المتأخّر عن مهلته أحمر، وأكثر من ٩٠ يوماً أحمر ولو ضمن مهلة طويلة، وأكثر من ٣٠ تنبيه، وغير ذلك عادي', () => {
  assert.equal(debtAgeTone(aging({ ageDays: 10, overdueDays: 3 })), 'bad');
  assert.equal(debtAgeTone(aging({ ageDays: 120, overdueDays: 0 })), 'bad');
  assert.equal(debtAgeTone(aging({ ageDays: 45 })), 'warn');
  assert.equal(debtAgeTone(aging({ ageDays: 30 })), 'ok');
  assert.equal(debtAgeTone(aging({ ageDays: null })), 'ok');
});

test('الترجمة: عناوين الشرائح وكل نصوص العمود والتصدير مفاتيح بلغاتها الأربع', () => {
  const keys = [
    ...DEBT_AGE_BANDS.map(k => DEBT_AGE_BAND_LABELS[k]), 'بلا تاريخ', 'عمر الدين', 'متأخر عن السداد', 'عمر الدين (يوم)',
    'أقدم دين منذ', 'المتأخر عن السداد', 'أيام التأخير', 'يوماً', 'منذ', 'توزيع الأعمار',
    'من أقدم دين لم يسدد بعد احتساب السندات والمرتجعات، وتوزيع الرصيد على أعمار الديون',
  ];
  for (const k of keys) {
    const e = (PHRASES as Record<string, Record<string, string>>)[k];
    assert.ok(e, `مفتاح غائب: ${k}`);
    for (const lang of ['en', 'fr', 'tr', 'zh']) assert.ok(e[lang]?.trim(), `${k} بلا ${lang}`);
  }
});

test('صفحة التقارير: عمود «عمر الدين» بعد الحد الائتماني وقبل نسبة الاستخدام في الرأس والصفّ، والتصدير بأعمدته', () => {
  const page = src('pages/ReportsPage.tsx');
  const head = page.slice(page.indexOf("<th>{tr('الحد الائتماني')}</th>"));
  assert.match(head.slice(0, 400), /^<th>\{tr\('الحد الائتماني'\)\}<\/th><th title=\{tr\('[^']+'\)\}>\{tr\('عمر الدين'\)\}<\/th><th>\{tr\('نسبة الاستخدام'\)\}<\/th>/);
  const row = page.slice(page.indexOf('{formatCurrency(c.creditLimit)}</td>'));
  assert.ok(row.indexOf('debtAgingOf(c)') > 0 && row.indexOf('debtAgingOf(c)') < row.indexOf('Number(c.creditLimit) > 0'), 'خلية العمر قبل نسبة الاستخدام');
  const exp = page.slice(page.indexOf("custType === 'balances' && balanceRows?.length"));
  for (const k of ['عمر الدين (يوم)', 'أقدم دين منذ', 'أيام التأخير', 'المتأخر عن السداد', 'بلا تاريخ']) {
    assert.ok(exp.slice(0, 2500).includes(`tr('${k}')`), `عمود التصدير ${k}`);
  }
  assert.match(exp.slice(0, 2500), /DEBT_AGE_BANDS\.map\(k => \[tr\(DEBT_AGE_BAND_LABELS\[k\]\)/);
  // PDF: صفوفٌ أضيق (pdfRows) — الشرائح نصّاً واحداً «توزيع الأعمار»، بلا أعمدة الشرائح ولا «أقدم دين منذ»
  const pdf = exp.slice(exp.indexOf('pdfRows: balanceRows.map'), exp.indexOf("sheets.unshift({ name: tr('الإجمالي')"));
  assert.ok(pdf.length > 0, 'صفوف PDF الأضيق');
  assert.ok(pdf.includes("tr('توزيع الأعمار')") && pdf.includes('debtAgeParts(a)'));
  assert.ok(!pdf.includes('DEBT_AGE_BANDS') && !pdf.includes("tr('أقدم دين منذ')"));
  assert.match(page, /const sh = sheet\.pdfRows \? \{ \.\.\.sheet, rows: sheet\.pdfRows \} : sheet;/, 'sheetsToPdf يطبع pdfRows');
  // وعروضٌ نسبية بعدد أعمدة PDF (ثمانية، وتاسعٌ للحالة) — الجوال الدوليّ لا ينكسر داخل رقمه
  assert.match(pdf, /pdfColWidths: \[17, 14, 10, 9, 6, 6, 9, 21, \.\.\.\(balHasStatus \? \[8\] : \[\]\)\]/);
  const pdfCols = (pdf.match(/\[tr\('[^']+'\)\]:/g) ?? []).length;
  assert.equal(pdfCols, 9, 'أعمدة صفّ PDF (مع الحالة) = أوزان العروض');
  assert.match(page, /sh\.pdfColWidths && sh\.pdfColWidths\.length === cols\.length/, 'العروض تُهمل إن لم يطابق عددها الأعمدة');
  assert.match(page, /\$\{colgroup\}\$\{thead\}\$\{tbody\}/);
});

test('تطبيق الجوال: العمر أوّل سطره والتأخّر أوّل سطر التنبيه — القصّ بالنقاط يُسقط الحد لا رقم العمر', () => {
  const m = src('m/MReports.tsx');
  assert.match(m, /subtitle=\{\[ageText\(c\), c\.phone, c\.creditLimit > 0 \?/);
  assert.match(m, /note=\{\[overdueText\(c\), over \? tr\('تجاوز الحد الائتماني'\) : null\]/);
});

test('مستند API: ردّ /reports/balances يذكر aging بحقوله وقاعدته', () => {
  const docs = src('lib/apiDocsCatalog.ts');
  const at = docs.indexOf('"path": "/reports/balances"');
  const entry = docs.slice(at, docs.indexOf('"path":', at + 10));
  assert.match(entry, /aging:\{oldestDay, ageDays, overdueDays, overdueAmount, bands:\{d0_30, d31_60, d61_90, d90_plus\}, undated\}\|null/);
  assert.match(entry, /مجموع bands مع undated يساوي balance دائماً/);
});
