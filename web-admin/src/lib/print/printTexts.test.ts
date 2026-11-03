// «نصوص المطبوعات» في الواجهة (lib/print/printTexts.ts + printTextsCore.ts) — طلب المالك ٣١ أكتوبر ٢٠٢٦.
// النواة نسخة حرفية من الخادم، والقراءة المتسامحة تعود لنصوص اليوم عند أي عطب، والمحلِّل: بلا نصوص = اليوم حرفاً (tr كما هو)،
// وبنصوص = العربية أولاً وسطر اللغة الثانية بأسبقيته (نصّ الشركة ثم ترجمة صياغتها ثم ترجمة الافتراضي)، و«حذف السطر» لكل مفتاح
// (طلب المالك ٣ نوفمبر ٢٠٢٦: لا قفل)، والعنوان في المرحلتين، والمعاينة، والعدّاد، والتسمية الإنجليزية للقالب ثنائي اللغة، والتنبيهات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PRINT_SECOND_LANGS, PRINT_TEXT_CATALOG, PRINT_TEXT_LINE, PRINT_TEXT_WARNINGS, PRINT_TEXTS_ISSUES, SECOND_LANG_NAMES, canonicalPrintTexts, checkPrintTexts,
  emptyPrintTexts, isLineDeleted, makePrintTexts, normalizePrintTexts, phraseIn, printTextAltEditable, printTextEntry, printTextHideable,
  printTextRewordable, printTextWarning, printTextsSummary,
  type PrintSecondLang, type PrintTextsPreview, type PrintTextsV1,
} from './printTexts';
import { PHRASES } from '../../i18n/strings';

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
/** جسم الملف بعد أسطر التعليق // والفراغ في أوّله (كحارس نسخ ZATCA) */
const copyBody = (s: string) => s.replace(/\r\n/g, '\n').replace(/^(?:[ \t]*\/\/[^\n]*\n|[ \t]*\n)*/, '');

/** مترجم واجهةٍ إنجليزية — ليظهر أن الشركة ذات النصوص تطبع بالعربية أولاً مهما كانت لغة الجهاز */
const enTr = (ar: string): string => PHRASES[ar]?.en ?? ar;
/** مترجمٌ مُعلَّم — ليظهر أن الشركة بلا نصوص تمرّ بـtr حرفاً بحرف */
const markTr = (ar: string): string => `«${ar}»`;
const OUTSIDE = 'مندوبنا الكريم'; // صياغةٌ خارج القاموس
/** ترجمة الورقة (ترجمات الطباعة ثم القاموس) — ويجب أن توجد */
const ph = (ar: string, lang: PrintSecondLang = 'en'): string => {
  const v = phraseIn(ar, lang);
  assert.ok(v, `«${ar}» بلا ترجمة ${lang}`);
  return v!;
};

/** شركةٌ بالعربية والإنجليزية — بترتيب القائمة (صورتها القانونية) */
function raw(): PrintTextsV1 {
  return {
    version: 1, secondLang: 'en', companyNameAlt: 'Al Riyada Distribution', companyAddressAlt: 'Riyadh, Al Sulay',
    edits: {
      'h.phone': { text: 'الهاتف', alt: 'Tel', hidden: false }, // نصّ الشركة باللغة الثانية
      'h.email': { text: 'Email', alt: 'Email', hidden: false }, // سطرٌ ثانٍ يساوي الأساسيّ ⇒ لا يُكرَّر
      'inv.title': { text: 'فاتورة مبيعات', alt: 'Sales invoice', hidden: false },
      'inv.returnTitle': { text: null, alt: null, hidden: true },
      'inv.number': { text: 'رقم', alt: null, hidden: false }, // ترجمة صياغتها من القاموس
      'inv.rep': { text: OUTSIDE, alt: null, hidden: false }, // صياغةٌ خارج القاموس ⇒ لا سطر ثانٍ (لا ترجمة الافتراضي)
      'cust.phone': { text: null, alt: null, hidden: true }, // none
      'col.priceIncl': { text: null, alt: 'Unit price incl. VAT', hidden: false }, // fixed: اللغة الثانية وحدها
      'col.discount': { text: null, alt: null, hidden: true }, // standard
      'qr.caption': { text: null, alt: null, hidden: true }, // يُخفى فقط
      'rcp.title': { text: 'إيصال استلام', alt: null, hidden: false },
    },
  };
}
const texts = (over: Partial<PrintTextsV1> = {}): PrintTextsV1 => {
  const t = normalizePrintTexts({ ...raw(), ...over });
  assert.ok(t, 'إعداد العيّنة صالح');
  return t!;
};
const P1 = { isReturn: false, phase2: false };
const P1R = { isReturn: true, phase2: false };
const P2 = { isReturn: false, phase2: true };
const P2R = { isReturn: true, phase2: true };
/** يكتم console.warn أثناء fn ويعيد عدد التحذيرات */
function quiet<T>(fn: () => T): { value: T; warns: number } {
  let warns = 0;
  const orig = console.warn;
  console.warn = () => { warns++; };
  try { return { value: fn(), warns }; } finally { console.warn = orig; }
}

test('النواة نسخة حرفية من الخادم — قاعدة واحدة تحفظ وتقرأ', () => {
  const web = read('src', 'lib', 'print', 'printTextsCore.ts');
  const server = read('..', 'backend', 'src', 'services', 'printTextsCore.ts');
  assert.ok(web.startsWith('// ====') && web.includes('نسخة حرفية من backend/src/services/printTextsCore.ts'));
  assert.equal(copyBody(web), copyBody(server), 'printTextsCore.ts في الواجهة يختلف عن الخادم — انسخه من جديد');
});

test('normalizePrintTexts: null وundefined والعطب والنسخة الأحدث وما لا أثر له ⇒ null (نصوص اليوم)', () => {
  assert.equal(normalizePrintTexts(null), null);
  assert.equal(normalizePrintTexts(undefined), null);
  const { value, warns } = quiet(() => [
    'garbage', 42, [], { version: 1 }, { ...raw(), version: 2 }, { ...raw(), secondLang: 'de' },
    { ...raw(), edits: { 'h.phone': { text: 1, alt: null, hidden: false } } },
  ].map((x) => normalizePrintTexts(x)));
  assert.deepEqual(value, Array(7).fill(null));
  assert.ok(warns <= 1, `تحذيرٌ واحد لا سيل (${warns})`);
  for (const x of [
    emptyPrintTexts(),
    { ...emptyPrintTexts(), companyNameAlt: '   ', edits: { 'h.phone': { text: '  ', alt: '', hidden: false } } },
    { ...emptyPrintTexts(), edits: { 'h.fax': { text: 'فاكس', alt: null, hidden: false } } }, // مفتاحٌ من خادمٍ أحدث وحده
  ]) assert.equal(normalizePrintTexts(x), null, JSON.stringify(x));
  // طلب المالك ٣ نوفمبر ٢٠٢٦: العبارة الضريبية بصياغتها (fixed سابقاً) تُصاغ وتُحذف — فإعدادها له أثر
  assert.deepEqual(normalizePrintTexts({ ...emptyPrintTexts(), edits: { 'tot.vat': { text: 'الضريبة', alt: null, hidden: true } } })?.edits,
    { 'tot.vat': { text: 'الضريبة', alt: null, hidden: true } });
});

test('normalizePrintTexts: الصالح بصورته القانونية — والمتسامح يُهمل المجهول ويُبقي حذف كل سطر (لا قفل) ولا يُسقط الإعداد', () => {
  assert.deepEqual(normalizePrintTexts(raw()), raw());
  const messy = JSON.parse(JSON.stringify(raw()));
  messy.companyNameAlt = '  Al Riyada   Distribution ';
  messy.edits['h.phone'].text = ' الهاتف\n';
  messy.futureField = 1;
  messy.edits['h.fax'] = { text: 'فاكس', alt: null, hidden: false };
  messy.edits['h.taxNumber'] = { text: null, alt: null, hidden: true }; // حذف سطرٍ كان مقفلاً يبقى
  messy.edits['tot.grand'] = { text: 'المطلوب', alt: 'Amount due', hidden: true }; // الصياغة والحذف يبقيان
  const t = normalizePrintTexts(messy);
  assert.ok(t);
  const expected = raw();
  expected.edits['h.taxNumber'] = { text: null, alt: null, hidden: true };
  expected.edits['tot.grand'] = { text: 'المطلوب', alt: 'Amount due', hidden: true };
  // الترتيب بالقائمة: h.taxNumber أوّلاً، وtot.grand بعد col.discount وقبل qr.caption
  const order = PRINT_TEXT_CATALOG.map((x) => x.key);
  const sorted = Object.fromEntries(Object.entries(expected.edits).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)));
  assert.equal(JSON.stringify(t), JSON.stringify({ ...expected, edits: sorted }));
});

test('بلا نصوص: المحلِّل يمرّ بـtr حرفاً بحرف — لا سطر ثانٍ ولا إخفاء ولا اسم بلغة أخرى (حارس «لا يتغيّر حرف»)', () => {
  const preview: PrintTextsPreview = { onPick: () => {}, active: null };
  for (const p of [makePrintTexts(null, markTr), makePrintTexts(null, markTr, { standard: true }), makePrintTexts(null, markTr, { standard: false, preview })]) {
    assert.equal(p.on, false);
    assert.equal(p.tr, markTr, 'tr نفسه');
    assert.equal(p.lang, null);
    for (const x of PRINT_TEXT_CATALOG) {
      assert.equal(p.text(x.key, x.ar), markTr(x.ar), x.key);
      assert.equal(p.text(x.key, 'رقم'), markTr('رقم'), 'افتراضي القالب نفسه');
      assert.equal(p.alt(x.key, x.ar), null, x.key);
      assert.equal(p.hidden(x.key), false, x.key);
      assert.equal(p.hiddenInSettings(x.key), false, x.key);
    }
    assert.equal(p.valueAlt('نقدي', 'نقدي'), null);
    for (const f of [P1, P1R, P2, P2R]) assert.deepEqual(p.title('فاتورة ضريبية مبسطة', f), { text: markTr('فاتورة ضريبية مبسطة'), alt: null });
    assert.deepEqual([p.companyNameAlt, p.companyAddressAlt], [null, null]);
  }
  assert.equal(makePrintTexts(null, markTr).preview, null);
  assert.equal(makePrintTexts(null, markTr, { standard: false, preview }).preview, preview);
  // شركةٌ حفظت إعداداً بلا أثر = شركةٌ بلا نصوص
  assert.equal(makePrintTexts(normalizePrintTexts({ ...emptyPrintTexts(), edits: { 'h.phone': { text: ' ', alt: null, hidden: false } } }), markTr).on, false);
});

test('بنصوص: العربية أولاً أيّاً كانت لغة الجهاز، وصياغة الشركة، وافتراضي القالب حين لا صياغة', () => {
  const p = makePrintTexts(texts(), enTr, { standard: false });
  assert.equal(p.on, true);
  assert.equal(p.lang, 'en');
  assert.notEqual(p.tr, enTr);
  assert.equal(p.tr('سند قبض'), 'سند قبض', 'tr هويّة: ما ليس في القائمة بالعربية أيضاً');
  assert.equal(enTr('التاريخ'), 'Date', 'الشرط المسبق: مترجم الجهاز يترجم');
  assert.equal(p.text('inv.date', 'التاريخ'), 'التاريخ');
  assert.equal(p.text('inv.date', 'تاريخ'), 'تاريخ', 'افتراضي القالب نفسه (الشريط) لا مدخل القائمة');
  assert.equal(p.text('h.phone', 'هاتف'), 'الهاتف');
  assert.equal(p.text('inv.number', 'رقم الفاتورة'), 'رقم');
  assert.equal(p.text('inv.rep', 'المندوب'), OUTSIDE);
  assert.equal(p.text('col.priceIncl', 'السعر شامل الضريبة'), 'السعر شامل الضريبة', 'fixed: العربية كما هي');
  assert.equal(p.text('x.unknown', 'نص'), 'نص');
});

test('سطر اللغة الثانية: نصّ الشركة ثم ترجمة صياغتها ثم ترجمة افتراضي القالب ثم ترجمة مدخل القائمة — ولا يكرّر الأساسيّ', () => {
  assert.equal(phraseIn(OUTSIDE, 'en'), null, 'الشرط المسبق: الصياغة خارج القاموس');
  assert.equal(phraseIn('رقم المرتجع للعميل', 'en'), null);
  assert.notEqual(ph('رقم'), ph('رقم المرتجع'), 'الافتراضيان مختلفا الترجمة');
  const p = makePrintTexts(texts(), enTr, { standard: false });
  assert.equal(p.alt('h.phone', 'هاتف'), 'Tel', '١) نصّ الشركة');
  assert.equal(p.alt('inv.number', 'رقم الفاتورة'), ph('رقم'), '٢) ترجمة صياغتها العربية');
  assert.equal(p.alt('inv.rep', 'المندوب'), null, 'صياغةٌ خارج القاموس: لا ترجمة الافتراضي (تخالف ما طُبع بالعربية)');
  assert.equal(p.alt('inv.date', 'التاريخ'), ph('التاريخ'), '٣) ترجمة افتراضي القالب');
  assert.equal(p.alt('inv.returnNumber', 'رقم'), ph('رقم'), 'افتراضي القالب قبل مدخل القائمة');
  assert.equal(p.alt('inv.returnNumber', 'رقم المرتجع للعميل'), ph('رقم المرتجع'), '٤) ترجمة مدخل القائمة');
  assert.equal(p.alt('h.email', 'البريد'), null, 'السطر الثاني يساوي الأساسيّ');
  assert.equal(p.alt('col.priceIncl', 'السعر شامل الضريبة'), 'Unit price incl. VAT', 'fixed: نصّها باللغة الثانية');
  assert.equal(p.alt('tot.vat', 'ضريبة القيمة المضافة'), ph('ضريبة القيمة المضافة'));
  assert.equal(p.alt('x.unknown', 'نص خارج القاموس'), null);
  // اللغات الأربع من القاموس
  for (const lang of PRINT_SECOND_LANGS) {
    const q = makePrintTexts(texts({ secondLang: lang }), enTr, { standard: false });
    assert.equal(q.lang, lang);
    assert.equal(q.alt('h.taxNumber', 'الرقم الضريبي'), ph('الرقم الضريبي', lang), lang);
    assert.equal(q.alt('h.phone', 'هاتف'), 'Tel', `${lang}: نصّ الشركة أيّاً كانت اللغة`);
  }
  // بلا لغة ثانية: لا سطر ثانٍ ولو حُفظ نصّه، والصياغة العربية باقية
  const ar = makePrintTexts(texts({ secondLang: null }), enTr, { standard: false });
  assert.equal(ar.on, true);
  assert.equal(ar.lang, null);
  assert.equal(ar.alt('h.phone', 'هاتف'), null);
  assert.equal(ar.alt('inv.date', 'التاريخ'), null);
  assert.equal(ar.text('h.phone', 'هاتف'), 'الهاتف');
  assert.equal(ar.tr('التاريخ'), 'التاريخ');
});

test('حذف السطر: كل مفتاح يُحذف على المبسّطة والقياسية سواء (لا قفل ولا استثناء «القياسي») — وisLineDeleted = hidden', () => {
  const simplified = makePrintTexts(texts(), enTr, { standard: false });
  const standard = makePrintTexts(texts(), enTr, { standard: true });
  for (const k of ['cust.phone', 'inv.returnTitle', 'qr.caption', 'col.discount']) {
    assert.equal(simplified.hidden(k), true, k);
    assert.equal(standard.hidden(k), true, `${k}: يُحذف من القياسية أيضاً`);
    assert.equal(isLineDeleted(standard, k), true, k);
  }
  for (const k of ['h.phone', 'inv.title', 'inv.number', 'x.unknown']) assert.equal(simplified.hidden(k), false, k);
  // كل مفتاح في القائمة — الإلزامي سابقاً (zatca/fixed/shape/title/standard) وسطر المنصّة — يُحذف وحده إن حُذف
  for (const x of PRINT_TEXT_CATALOG) {
    const one = normalizePrintTexts({ ...emptyPrintTexts(), edits: { [x.key]: { text: null, alt: null, hidden: true } } });
    assert.ok(one, x.key);
    for (const std of [false, true]) {
      const p = makePrintTexts(one, enTr, { standard: std });
      assert.equal(p.hidden(x.key), true, `${x.key} std=${std}`);
      assert.equal(isLineDeleted(p, x.key), true, x.key);
      assert.equal(p.hiddenInSettings(x.key), true, x.key);
      assert.deepEqual(PRINT_TEXT_CATALOG.filter((y) => p.hidden(y.key)).map((y) => y.key), [x.key], 'لا يُحذف غيره');
    }
  }
  // بلا نصوص: لا يُحذف شيء
  for (const x of PRINT_TEXT_CATALOG) assert.equal(isLineDeleted(makePrintTexts(null, markTr), x.key), false, x.key);
});

test('المعاينة: لا يختفي شيء (يُرسم مشطوباً بـhiddenInSettings)، والعنوان المخفيّ يبقى ظاهراً فيها', () => {
  const preview: PrintTextsPreview = { onPick: () => {}, active: 'cust.phone' };
  const p = makePrintTexts(texts(), enTr, { standard: false, preview });
  assert.equal(p.preview, preview);
  for (const k of ['cust.phone', 'inv.returnTitle', 'qr.caption', 'col.discount']) {
    assert.equal(p.hidden(k), false, k);
    assert.equal(p.hiddenInSettings(k), true, k);
  }
  assert.equal(p.hiddenInSettings('h.phone'), false);
  assert.deepEqual(p.title('إشعار دائن مرتجع', P1R), { text: 'إشعار دائن مرتجع', alt: ph('إشعار دائن مرتجع') });
  assert.equal(makePrintTexts(texts(), enTr, { standard: false }).preview, null);
});

test('العنوان: صياغة الشركة وحذفها في المرحلتين (طلب المالك ٣ نوفمبر) — وعناوين القرار التي ليست فاتورة تبقى كما قرّرها', () => {
  // ما يكتبه المحرّر الجديد: العنوان موسومٌ phase2 (يسري على المرحلتين)
  const flagged = (t: PrintTextsV1): PrintTextsV1 => ({ ...t, edits: Object.fromEntries(Object.entries(t.edits)
    .map(([k, e]) => [k, k === 'inv.title' || k === 'inv.returnTitle' ? { ...e, phase2: true } : e])) });
  const p = makePrintTexts(flagged(texts()), enTr, { standard: false });
  // المرحلة الثانية: inv.title مُعاد صياغته وinv.returnTitle محذوف — يسريان الآن
  assert.deepEqual(p.title('فاتورة ضريبية', P2), { text: 'فاتورة مبيعات', alt: 'Sales invoice' });
  assert.deepEqual(p.title('فاتورة ضريبية مبسطة', P2), { text: 'فاتورة مبيعات', alt: 'Sales invoice' });
  assert.deepEqual(p.title('إشعار دائن مرتجع', P2R), { text: '', alt: null });
  assert.deepEqual(p.title('إشعار دائن', P2R), { text: '', alt: null });
  // عناوين القرار التي ليست عنوان فاتورة أو إشعار دائن: لا يمسّها inv.title ولا inv.returnTitle ولا حذفهما
  for (const [decided, f] of [
    ['سند تسليم — ليست فاتورة ضريبية', P2], ['مستند ملغى — لا يعتمد للخصم الضريبي', P2], ['مستند بانتظار اعتماد الهيئة', P2],
    ['إشعار مدين', P2], ['سند تسليم — ليست فاتورة ضريبية', P2R], ['مستند ملغى — لا يعتمد للخصم الضريبي', P1R], ['إشعار مدين', P2R],
  ] as const) {
    assert.deepEqual(p.title(decided, f), { text: decided, alt: phraseIn(decided, 'en') }, `${decided} ${JSON.stringify(f)}`);
  }
  assert.deepEqual(makePrintTexts(texts({ secondLang: null }), enTr, { standard: false }).title('سند تسليم — ليست فاتورة ضريبية', P2),
    { text: 'سند تسليم — ليست فاتورة ضريبية', alt: null });
  // بلا تعديل على العنوان: المرحلة الثانية كما كانت حرفاً
  const plain2 = makePrintTexts(texts({ edits: { 'h.phone': { text: 'الهاتف', alt: null, hidden: false } } }), enTr, { standard: false });
  assert.deepEqual(plain2.title('فاتورة ضريبية', P2), { text: 'فاتورة ضريبية', alt: ph('فاتورة ضريبية') });
  assert.deepEqual(plain2.title('إشعار دائن', P2R), { text: 'إشعار دائن', alt: ph('إشعار دائن') });
  assert.deepEqual(makePrintTexts(texts({ secondLang: null, edits: { 'h.phone': { text: 'الهاتف', alt: null, hidden: false } } }), enTr, { standard: false })
    .title('فاتورة ضريبية', P2), { text: 'فاتورة ضريبية', alt: null });
  // المرحلة الأولى: صياغة الشركة بنصّها الثاني، والمرتجع المخفيّ ''
  assert.deepEqual(p.title('فاتورة ضريبية مبسطة', P1), { text: 'فاتورة مبيعات', alt: 'Sales invoice' });
  assert.deepEqual(p.title('فاتورة ضريبية', P1), { text: 'فاتورة مبيعات', alt: 'Sales invoice' }, 'القياسية أيضاً');
  assert.deepEqual(p.title('إشعار دائن مرتجع', P1R), { text: '', alt: null });
  // العنوان المحذوف محذوفٌ على القياسية وفي المرحلة الثانية (والمعاينة تُظهره لتستعيده)
  const hiddenTitle = texts({ edits: { 'inv.title': { text: null, alt: null, hidden: true, phase2: true } } });
  assert.deepEqual(makePrintTexts(hiddenTitle, enTr, { standard: true }).title('فاتورة ضريبية', P1), { text: '', alt: null });
  assert.deepEqual(makePrintTexts(hiddenTitle, enTr, { standard: true }).title('فاتورة ضريبية', P2), { text: '', alt: null });
  assert.equal(makePrintTexts(hiddenTitle, enTr, { standard: true, preview: { onPick: () => {}, active: null } }).title('فاتورة ضريبية', P2).text, 'فاتورة ضريبية');
  // بلا تعديل: عنوان القرار وترجمته (لا ترجمة مدخل القائمة «المبسّطة» للقياسية)
  const plain = makePrintTexts(texts({ edits: { 'h.phone': { text: 'الهاتف', alt: null, hidden: false } } }), enTr, { standard: false });
  assert.deepEqual(plain.title('فاتورة ضريبية مبسطة', P1), { text: 'فاتورة ضريبية مبسطة', alt: ph('فاتورة ضريبية مبسطة') });
  assert.deepEqual(plain.title('فاتورة ضريبية', P1), { text: 'فاتورة ضريبية', alt: ph('فاتورة ضريبية') });
  assert.deepEqual(plain.title('إشعار دائن مرتجع', P1R), { text: 'إشعار دائن مرتجع', alt: ph('إشعار دائن مرتجع') });
  // صياغةٌ خارج القاموس بلا نصٍّ ثانٍ ⇒ بلا سطر ثانٍ
  const own = makePrintTexts(texts({ edits: { 'inv.title': { text: OUTSIDE, alt: null, hidden: false } } }), enTr, { standard: false });
  assert.deepEqual(own.title('فاتورة ضريبية مبسطة', P1), { text: OUTSIDE, alt: null });
});

test('العنوان المحفوظ قبل ٣ نوفمبر ٢٠٢٦ (بلا وسم phase2): للمرحلة الأولى وحدها كما حُفظ — مستند المرحلة الثانية يطبع عنوان الهيئة كاليوم', () => {
  // texts(): صياغة inv.title وحذف inv.returnTitle بلا وسم — إعداد شركةٍ محفوظٌ بالقواعد السابقة (والخادم يقرؤه كما هو)
  const legacy = makePrintTexts(texts(), enTr, { standard: false });
  assert.deepEqual(legacy.title('فاتورة ضريبية', P2), { text: 'فاتورة ضريبية', alt: ph('فاتورة ضريبية') });
  assert.deepEqual(legacy.title('فاتورة ضريبية مبسطة', P2), { text: 'فاتورة ضريبية مبسطة', alt: ph('فاتورة ضريبية مبسطة') });
  assert.deepEqual(legacy.title('إشعار دائن مرتجع', P2R), { text: 'إشعار دائن مرتجع', alt: ph('إشعار دائن مرتجع') });
  // المرحلة الأولى: كما حُفظ
  assert.deepEqual(legacy.title('فاتورة ضريبية مبسطة', P1), { text: 'فاتورة مبيعات', alt: 'Sales invoice' });
  assert.deepEqual(legacy.title('إشعار دائن مرتجع', P1R), { text: '', alt: null });
  const hidden = makePrintTexts(texts({ edits: { 'inv.title': { text: null, alt: null, hidden: true } } }), enTr, { standard: true });
  assert.deepEqual(hidden.title('فاتورة ضريبية', P2), { text: 'فاتورة ضريبية', alt: ph('فاتورة ضريبية') });
  assert.deepEqual(hidden.title('فاتورة ضريبية', P1), { text: '', alt: null });
  // الخادم الصارم يقبل الوسم ويحفظه لعنواني الفاتورة وحدهما، ولا يكتبه لغيرهما ولا يكتب false — وغيابه بايتات اليوم
  const r = checkPrintTexts(texts({ edits: {
    'inv.title': { text: 'فاتورة مبيعات', alt: null, hidden: false, phase2: true },
    'inv.returnTitle': { text: null, alt: null, hidden: true, phase2: false },
    'h.phone': { text: 'الهاتف', alt: null, hidden: false, phase2: true },
  } }), true);
  assert.ok(r.ok);
  assert.equal(JSON.stringify(r.ok && r.value.edits), JSON.stringify({
    'h.phone': { text: 'الهاتف', alt: null, hidden: false },
    'inv.title': { text: 'فاتورة مبيعات', alt: null, hidden: false, phase2: true },
    'inv.returnTitle': { text: null, alt: null, hidden: true },
  }));
  assert.equal(JSON.stringify(canonicalPrintTexts(raw()).edits['inv.title']), '{"text":"فاتورة مبيعات","alt":"Sales invoice","hidden":false}');
  // المتسامح (الجهاز) يحفظ الوسم أيضاً
  const l = checkPrintTexts({ ...raw(), edits: { 'inv.title': { text: 'فاتورة مبيعات', alt: null, hidden: false, phase2: true } } }, false);
  assert.equal(l.ok && l.value.edits['inv.title']?.phase2, true);
});

test('اسم الشركة وعنوانها باللغة الثانية مع لغةٍ ثانية وحدها، وvalueAlt للقيم الثابتة', () => {
  const p = makePrintTexts(texts(), enTr, { standard: false });
  assert.deepEqual([p.companyNameAlt, p.companyAddressAlt], ['Al Riyada Distribution', 'Riyadh, Al Sulay']);
  const ar = makePrintTexts(texts({ secondLang: null }), enTr, { standard: false });
  assert.deepEqual([ar.companyNameAlt, ar.companyAddressAlt], [null, null], 'محفوظان لكن لا لغة ثانية');
  assert.equal(p.valueAlt('نقدي', 'نقدي'), ph('نقدي'));
  assert.equal(p.valueAlt('آجل', 'آجل'), ph('آجل'));
  assert.equal(p.valueAlt('نقدي', ph('نقدي')), null, 'لا يكرّر الأساسيّ');
  assert.equal(p.valueAlt('قيمة خارج القاموس', 'قيمة خارج القاموس'), null);
  assert.equal(ar.valueAlt('نقدي', 'نقدي'), null);
  assert.equal(makePrintTexts(texts({ secondLang: 'fr' }), enTr, { standard: false }).valueAlt('نقدي', 'نقدي'), ph('نقدي', 'fr'));
});

test('printTextsSummary: المُعاد صياغته (نصّ أو نصّ ثانٍ) والمخفيّ — والمخفيّ بصياغته يُعدّ مخفياً وحده', () => {
  assert.deepEqual(printTextsSummary(null), { reworded: 0, hidden: 0 });
  assert.deepEqual(printTextsSummary(emptyPrintTexts()), { reworded: 0, hidden: 0 });
  // h.phone وh.email وinv.title وinv.number وinv.rep وcol.priceIncl وrcp.title / inv.returnTitle وcust.phone وcol.discount وqr.caption
  assert.deepEqual(printTextsSummary(texts()), { reworded: 7, hidden: 4 });
  assert.deepEqual(printTextsSummary(texts({ edits: { 'cust.heading': { text: 'العميل', alt: 'Client', hidden: true } } })), { reworded: 0, hidden: 1 });
  // حذف سطرٍ كان مقفلاً يُعدّ محذوفاً (يُحذف عند الطباعة) — ونصّ اللغة الثانية يُعدّ متى اختيرت لغةٌ ثانية وحدها
  const crafted: PrintTextsV1 = { ...emptyPrintTexts(), secondLang: 'en', edits: { 'tot.vat': { text: null, alt: 'VAT', hidden: true }, 'h.taxNumber': { text: null, alt: null, hidden: true }, 'h.phone': { text: null, alt: 'Tel', hidden: false } } };
  assert.deepEqual(printTextsSummary(crafted), { reworded: 1, hidden: 2 });
  assert.deepEqual(printTextsSummary({ ...crafted, secondLang: null }), { reworded: 0, hidden: 2 }, 'نصٌّ ثانٍ بلا لغةٍ ثانية لا يُطبع فلا يُعدّ');
});

test('القاموس: كل نصٍّ يُكتب له سطرٌ ثانٍ له ترجمةٌ باللغات الأربع — فلا يسقط سطر اللغة الثانية الافتراضي بصمت', () => {
  for (const x of PRINT_TEXT_CATALOG.filter((y) => printTextAltEditable(y))) {
    for (const lang of PRINT_SECOND_LANGS) {
      const v = phraseIn(x.ar, lang);
      assert.ok(typeof v === 'string' && v.trim() && v !== x.ar, `${x.key}.${lang}: «${x.ar}» بلا ترجمة`);
    }
  }
  assert.equal(phraseIn('نص خارج القاموس', 'en'), null);
  assert.deepEqual(Object.keys(SECOND_LANG_NAMES), [...PRINT_SECOND_LANGS]);
});

test('رسائل رفض الحفظ (PRINT_TEXTS_ISSUES) مترجمةٌ في القاموس باللغات الأربع — المحرّر يعرضها بـtr', () => {
  for (const m of Object.values(PRINT_TEXTS_ISSUES)) {
    const p = PHRASES[m];
    assert.ok(p, `«${m}» ليس في PHRASES`);
    for (const lang of PRINT_SECOND_LANGS) assert.ok(p[lang] && p[lang].trim(), `«${m}».${lang}`);
  }
});

test('مراجعة: ترجمةٌ للعنوان بلا صياغةٍ عربية تخصّ العنوان الذي تترجمه — فلا تُطبع «Simplified» تحت عنوان الفاتورة القياسية', () => {
  const t = makePrintTexts({ ...emptyPrintTexts(), secondLang: 'en', edits: { 'inv.title': { text: null, alt: 'Simplified VAT Invoice', hidden: false } } }, (s) => s, { standard: false });
  const P1 = { isReturn: false, phase2: false };
  assert.deepEqual(t.title('فاتورة ضريبية مبسطة', P1), { text: 'فاتورة ضريبية مبسطة', alt: 'Simplified VAT Invoice' });
  assert.deepEqual(t.title('فاتورة ضريبية', P1), { text: 'فاتورة ضريبية', alt: phraseIn('فاتورة ضريبية', 'en') });
  assert.deepEqual(t.title('فاتورة', P1), { text: 'فاتورة', alt: phraseIn('فاتورة', 'en') });
  // وصياغةٌ عربية مع ترجمتها تُطبع على كل عنوانٍ من المرحلة الأولى (قرار المالك: إزالة «ضريبية»)
  const r = makePrintTexts({ ...emptyPrintTexts(), secondLang: 'en', edits: { 'inv.title': { text: 'فاتورة', alt: 'Invoice', hidden: false } } }, (s) => s, { standard: true });
  assert.deepEqual(r.title('فاتورة ضريبية', P1), { text: 'فاتورة', alt: 'Invoice' });
});

// ═══ طلب المالك ٣ نوفمبر ٢٠٢٦: لا عبارة لا تُحرَّر أو تُحذف ═══

test('كل مفتاح يُحرَّر ويُحذف: الحفظ الصارم يقبل الصياغة والنصّ الثاني والحذف معاً لكل مفتاح — والدوالّ القديمة true دائماً', () => {
  for (const x of PRINT_TEXT_CATALOG) {
    assert.equal(printTextHideable(x), true, x.key);
    assert.equal(printTextRewordable(x), true, x.key);
    assert.equal(printTextAltEditable(x), true, x.key);
    const r = checkPrintTexts({ ...emptyPrintTexts(), secondLang: 'en', edits: { [x.key]: { text: 'صياغة الشركة', alt: 'Company wording', hidden: true } } }, true);
    assert.ok(r.ok, `${x.key}: ${JSON.stringify(r)}`);
    if (r.ok) assert.deepEqual(r.value.edits, { [x.key]: { text: 'صياغة الشركة', alt: 'Company wording', hidden: true } }, x.key);
    const lenient = checkPrintTexts({ ...emptyPrintTexts(), edits: { [x.key]: { text: null, alt: null, hidden: true } } }, false);
    assert.ok(lenient.ok && lenient.value.edits[x.key]?.hidden === true, `${x.key}: الجهاز يُبقي الحذف`);
  }
  const all = checkPrintTexts({ ...emptyPrintTexts(), edits: Object.fromEntries(PRINT_TEXT_CATALOG.map((x) => [x.key, { text: null, alt: null, hidden: true }])) }, true);
  assert.ok(all.ok && Object.keys(all.value.edits).length === PRINT_TEXT_CATALOG.length, 'حذف كل السطور معاً يُقبل');
});

test('PRINT_TEXT_LINE: وحدة حذفٍ واحدة لكل مفتاح في القائمة، ولا مفتاح زائد، وبالأنواع المعروفة', () => {
  assert.deepEqual(Object.keys(PRINT_TEXT_LINE).sort(), PRINT_TEXT_CATALOG.map((x) => x.key).sort());
  const scopes = ['row', 'column', 'totalsRow', 'block', 'title', 'slot', 'line', 'part'];
  for (const [k, v] of Object.entries(PRINT_TEXT_LINE)) assert.ok(scopes.includes(v), `${k}: ${v}`);
  assert.ok(Object.isFrozen(PRINT_TEXT_LINE));
  const by = (scope: string) => Object.entries(PRINT_TEXT_LINE).filter(([, v]) => v === scope).map(([k]) => k).sort();
  assert.deepEqual(by('title'), ['inv.returnTitle', 'inv.title', 'rcp.title']);
  assert.deepEqual(by('slot'), ['rcp.sigCollector', 'rcp.sigPayer', 'sig.recipient', 'sig.remarks', 'sig.rep', 'sig.warehouse']);
  assert.deepEqual(by('column'), ['col.code', 'col.discount', 'col.item', 'col.price', 'col.priceIncl', 'col.qty', 'col.seq', 'col.tax', 'col.total', 'col.unit', 'col.vatAmount', 'inst.amount', 'inst.dueDate']);
  assert.deepEqual(by('block'), ['cust.heading', 'inst.heading', 'inv.infoHeading', 'inv.returnInfoHeading', 'rcp.amount', 'rcp.customerHeading', 'rcp.forInvoices', 'sel.heading']);
  for (const k of Object.keys(PRINT_TEXT_LINE).filter((k) => k.startsWith('tot.'))) assert.equal(PRINT_TEXT_LINE[k], 'totalsRow', k);
  assert.equal(PRINT_TEXT_LINE['foot.platform'], 'line');
});

test('التنبيهات: صنفٌ لكل مفتاح من قفله القديم — tax لما كان zatca/fixed/shape/title أو يُخفى فقط، وstandard، وplatform لسطر المنصّة', () => {
  const cls = (w: string | null) => PRINT_TEXT_CATALOG.filter((x) => printTextWarning(x) === w).map((x) => x.key).sort();
  assert.deepEqual(cls('platform'), ['foot.platform']);
  assert.deepEqual(cls('standard'), [
    'col.discount', 'col.tax', 'col.vatAmount', 'cust.address', 'cust.business', 'cust.city', 'cust.commercialReg', 'cust.name', 'cust.postalCode', 'sel.city',
    'sel.postalCode', 'tot.discount',
  ].sort());
  assert.deepEqual(cls('tax'), [
    'h.taxNumber', 'h.commercialReg', 'h.address', 'foot.company', 'inv.title', 'inv.returnTitle', 'inv.number', 'inv.returnNumber', 'inv.date',
    'inv.time', 'inv.deliveryDate', 'cust.taxNumber', 'col.item', 'col.qty', 'col.price', 'col.priceIncl', 'col.total', 'item.beforeTax',
    'note.pricesIncl', 'tot.taxable', 'tot.vat', 'tot.vatIncl', 'tot.grand', 'tot.returnGrand', 'inst.heading', 'inst.dueDate', 'inst.amount',
    'inst.sum', 'inst.note', 'qr.caption', 'inv.originalRef', 'inv.noteReason', 'rcp.number', 'rcp.date', 'rcp.amount', 'rcp.from',
    'sel.name', 'sel.address', 'sel.taxNumber', 'tot.exclVat', 'tot.due',
  ].sort());
  const warned = new Set([...cls('platform'), ...cls('standard'), ...cls('tax')]);
  assert.deepEqual(cls(null), PRINT_TEXT_CATALOG.map((x) => x.key).filter((k) => !warned.has(k)).sort());
  for (const x of PRINT_TEXT_CATALOG) {
    const expected = x.key === 'foot.platform' ? 'platform' : x.lock === 'standard' ? 'standard' : x.lock !== 'none' || x.hideOnly ? 'tax' : null;
    assert.equal(printTextWarning(x), expected, x.key);
    // المحلِّل يعيد الصنف نفسه بنصوصٍ وبلا نصوص
    assert.equal(makePrintTexts(null, markTr).warning(x.key), expected, x.key);
    assert.equal(makePrintTexts(texts(), enTr, { standard: true }).warning(x.key), expected, x.key);
  }
  assert.equal(makePrintTexts(texts(), enTr).warning('x.unknown'), null);
  assert.deepEqual(PRINT_TEXT_WARNINGS, {
    tax: 'حذف هذا قد يجعل الفاتورة الضريبية غير مطابقة لمتطلبات هيئة الزكاة والضريبة والجمارك',
    standard: 'إلزامي في الفاتورة الضريبية للمنشآت — حذفه قد يجعلها غير مطابقة لمتطلبات هيئة الزكاة والضريبة والجمارك',
    platform: 'سطر المنصة في تذييل المطبوعات',
  });
});

test('المفاتيح الجديدة: بنصّها ومستندها ومجموعتها وقفلها كما في المواصفة — مضافةٌ آخر القائمة (ترتيب المحفوظ ثابت)', () => {
  const NEW: [string, string, string, string, string][] = [
    ['col.seq', 'رقم', 'invoice', 'items', 'none'], ['col.code', 'رقم الصنف', 'invoice', 'items', 'none'],
    ['col.unit', 'الوحدة', 'invoice', 'items', 'none'], ['col.vatAmount', 'ضريبة القيمة المضافة', 'invoice', 'items', 'standard'],
    ['sel.heading', 'بيانات البائع', 'invoice', 'seller', 'none'], ['sel.name', 'الاسم', 'invoice', 'seller', 'zatca'],
    ['sel.address', 'العنوان', 'invoice', 'seller', 'zatca'], ['sel.city', 'المدينة', 'invoice', 'seller', 'standard'],
    ['sel.postalCode', 'الرمز البريدي', 'invoice', 'seller', 'standard'], ['sel.taxNumber', 'الرقم الضريبي', 'invoice', 'seller', 'zatca'],
    ['cust.city', 'المدينة', 'shared', 'customer', 'standard'], ['cust.postalCode', 'الرمز البريدي', 'shared', 'customer', 'standard'],
    ['inv.paymentType', 'طريقة الدفع', 'invoice', 'info', 'none'], ['sig.warehouse', 'المستودع', 'invoice', 'footer', 'none'],
    ['sig.remarks', 'ملاحظات وتعليمات', 'invoice', 'footer', 'none'],
    ['tot.exclVat', 'الإجمالي الخاضع للضريبة (غير شامل الضريبة)', 'invoice', 'totals', 'fixed'],
    ['tot.due', 'إجمالي المبلغ المستحق', 'invoice', 'totals', 'zatca'],
    ['foot.platform', 'صدرت عبر منصة Field Sales · fieldsa.net', 'shared', 'footer', 'fixed'],
  ];
  assert.deepEqual(PRINT_TEXT_CATALOG.slice(-NEW.length).map((x) => [x.key, x.ar, x.doc, x.group, x.lock]), NEW);
  assert.equal(PRINT_TEXT_CATALOG.length, 74 + NEW.length);
  // سطر المنصّة الافتراضي = تعبير قالب A4 اليوم حرفاً (tr('صدرت عبر منصة') + ' Field Sales · fieldsa.net') بلا ترجمة
  const a4Today = (tr: (s: string) => string) => `${tr('صدرت عبر منصة')} Field Sales · fieldsa.net`;
  assert.equal(printTextEntry('foot.platform')!.ar, a4Today((x) => x));
});

test('التسمية الإنجليزية en(): المحذوف null، ونصّ الشركة الإنجليزي، وإلا ترجمة صياغتها ثم الافتراضي — وبلا نصوص ترجمة النصّ', () => {
  // بلا نصوص: phraseIn(ar,'en') (وترجمة المفتاح لافتراضي المفاتيح الجديدة)
  const off = makePrintTexts(null, markTr);
  assert.equal(off.en('inv.date', 'التاريخ'), ph('التاريخ'));
  assert.equal(off.en('h.taxNumber', 'الرقم الضريبي'), 'VAT No.');
  assert.equal(off.en('x.unknown', 'نص خارج القاموس'), null);
  assert.equal(off.en('col.code', 'رقم الصنف'), 'Item Code');
  assert.equal(off.en('col.seq', 'رقم'), 'Sr.', 'ترجمة المفتاح لا ترجمة «رقم» العامة');
  assert.equal(off.en('inv.number', 'رقم'), ph('رقم'), 'ترجمة المفتاح للمفتاح الجديد وحده');
  assert.equal(off.en('inv.paymentType', 'طريقة الدفع'), 'Payment Type Name');
  assert.equal(off.en('rcp.method', 'طريقة الدفع'), ph('طريقة الدفع'));
  assert.equal(off.en('sel.taxNumber', 'الرقم الضريبي'), 'VAT Number');
  assert.equal(off.en('tot.exclVat', 'الإجمالي الخاضع للضريبة (غير شامل الضريبة)'), 'Total Taxable Amount (Excluding VAT)');
  assert.equal(off.en('tot.due', 'إجمالي المبلغ المستحق'), 'Total Amount Due');
  assert.equal(off.en('foot.platform', 'صدرت عبر منصة Field Sales · fieldsa.net'), 'Issued via Field Sales · fieldsa.net');
  // بنصوص بالإنجليزية: نصّ الشركة أوّلاً، ثم ترجمة صياغتها، ثم الافتراضي (ولو كانت صياغتها خارج القاموس)، والمحذوف null
  const p = makePrintTexts(texts(), enTr, { standard: false });
  assert.equal(p.en('h.phone', 'هاتف'), 'Tel');
  assert.equal(p.en('h.email', 'البريد'), 'Email');
  assert.equal(p.en('inv.number', 'رقم الفاتورة'), ph('رقم'), 'ترجمة صياغتها');
  assert.equal(p.en('inv.rep', 'المندوب'), ph('المندوب'), 'صياغةٌ خارج القاموس ⇒ ترجمة الافتراضي (القالب ثنائي اللغة يحتاج تسمية)');
  assert.equal(p.en('col.priceIncl', 'السعر شامل الضريبة'), 'Unit price incl. VAT');
  assert.equal(p.en('cust.phone', 'الجوال'), null, 'محذوف');
  assert.equal(p.en('col.discount', 'الخصم'), null, 'محذوف (standard سابقاً) ولو على القياسية');
  assert.equal(makePrintTexts(texts(), enTr, { standard: true }).en('col.discount', 'الخصم'), null);
  // بلغةٍ ثانية غير الإنجليزية: نصّ الشركة (بتلك اللغة) لا يصير تسميةً إنجليزية
  const fr = makePrintTexts(texts({ secondLang: 'fr' }), enTr, { standard: false });
  assert.equal(fr.en('h.phone', 'هاتف'), ph('الهاتف'), 'ترجمة صياغتها العربية «الهاتف»');
  assert.equal(fr.en('col.priceIncl', 'السعر شامل الضريبة'), ph('السعر شامل الضريبة'));
  // بلا لغة ثانية: الإنجليزية من الترجمة — والقالب ثنائي اللغة يطبعها
  const ar = makePrintTexts(texts({ secondLang: null }), enTr, { standard: false });
  assert.equal(ar.en('h.phone', 'هاتف'), ph('الهاتف'));
  assert.equal(ar.en('inv.date', 'التاريخ'), ph('التاريخ'));
  // المعاينة: المحذوف يُرسم مشطوباً فتبقى تسميته
  const pv = makePrintTexts(texts(), enTr, { standard: false, preview: { onPick: () => {}, active: null } });
  assert.equal(pv.en('cust.phone', 'الجوال'), ph('الجوال'));
});

test('ترجمة المفتاح الجديد لا تغيّر سطر اللغة الثانية القائم: «رقم» و«طريقة الدفع» و«الرقم الضريبي» لمفاتيح اليوم كما كانت', () => {
  const p = makePrintTexts(texts(), enTr, { standard: false });
  assert.equal(p.alt('inv.returnNumber', 'رقم'), ph('رقم'));
  assert.equal(p.alt('rcp.method', 'طريقة الدفع'), ph('طريقة الدفع'));
  assert.equal(p.alt('h.taxNumber', 'الرقم الضريبي'), ph('الرقم الضريبي'));
  assert.equal(p.alt('col.seq', 'رقم'), 'Sr.');
  assert.equal(p.alt('col.seq', '#'), 'Sr.', 'افتراضي قالبٍ خارج القاموس ⇒ ترجمة المفتاح');
  assert.equal(p.alt('sel.taxNumber', 'الرقم الضريبي'), 'VAT Number');
  for (const lang of PRINT_SECOND_LANGS) {
    const q = makePrintTexts(texts({ secondLang: lang }), enTr, { standard: false });
    for (const k of ['col.seq', 'inv.paymentType', 'sel.taxNumber']) assert.ok(q.alt(k, printTextEntry(k)!.ar), `${k}.${lang}`);
  }
});
