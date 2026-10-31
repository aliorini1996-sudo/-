// «نصوص المطبوعات» في الواجهة (lib/print/printTexts.ts + printTextsCore.ts) — طلب المالك ٣١ أكتوبر ٢٠٢٦.
// النواة نسخة حرفية من الخادم، والقراءة المتسامحة تعود لنصوص اليوم عند أي عطب، والمحلِّل: بلا نصوص = اليوم حرفاً (tr كما هو)،
// وبنصوص = العربية أولاً وسطر اللغة الثانية بأسبقيته (نصّ الشركة ثم ترجمة صياغتها ثم ترجمة الافتراضي)، والإخفاء بأقفاله،
// والعنوان (المرحلة الثانية تطبع عنوان القرار كما هو)، والمعاينة، والعدّاد.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PRINT_SECOND_LANGS, PRINT_TEXT_CATALOG, PRINT_TEXTS_ISSUES, SECOND_LANG_NAMES, emptyPrintTexts, makePrintTexts, normalizePrintTexts, phraseIn,
  printTextAltEditable, printTextsSummary,
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
    { ...emptyPrintTexts(), edits: { 'tot.vat': { text: 'الضريبة', alt: null, hidden: true } } }, // fixed: لا عربية ولا إخفاء
  ]) assert.equal(normalizePrintTexts(x), null, JSON.stringify(x));
});

test('normalizePrintTexts: الصالح بصورته القانونية — والمتسامح يُهمل المجهول والإخفاء المقفل ولا يُسقط الإعداد', () => {
  assert.deepEqual(normalizePrintTexts(raw()), raw());
  const messy = JSON.parse(JSON.stringify(raw()));
  messy.companyNameAlt = '  Al Riyada   Distribution ';
  messy.edits['h.phone'].text = ' الهاتف\n';
  messy.futureField = 1;
  messy.edits['h.fax'] = { text: 'فاكس', alt: null, hidden: false };
  messy.edits['h.taxNumber'] = { text: null, alt: null, hidden: true }; // إخفاءٌ مقفل يسقط وحده
  messy.edits['tot.grand'] = { text: 'المطلوب', alt: 'Amount due', hidden: true }; // الصياغة تبقى
  const t = normalizePrintTexts(messy);
  assert.ok(t);
  const expected = raw();
  expected.edits['tot.grand'] = { text: 'المطلوب', alt: 'Amount due', hidden: false };
  // الترتيب بالقائمة: tot.grand بعد col.discount وقبل qr.caption
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

test('الإخفاء: none وtitle يُخفيان، وstandard من المبسّطة وحدها، والإلزامي لا يُخفى ولو قاله كائنٌ خام', () => {
  const simplified = makePrintTexts(texts(), enTr, { standard: false });
  const standard = makePrintTexts(texts(), enTr, { standard: true });
  for (const k of ['cust.phone', 'inv.returnTitle', 'qr.caption']) {
    assert.equal(simplified.hidden(k), true, k);
    assert.equal(standard.hidden(k), true, `${k}: ليس قياسياً فيُخفى من القياسية أيضاً`);
  }
  assert.equal(simplified.hidden('col.discount'), true);
  assert.equal(standard.hidden('col.discount'), false, 'القياسية تُبقي ما قفله «القياسي»');
  assert.equal(standard.hiddenInSettings('col.discount'), true);
  for (const k of ['h.phone', 'inv.title', 'inv.number', 'x.unknown']) assert.equal(simplified.hidden(k), false, k);
  // كائنٌ خامٌ لم يمرّ بالقراءة المتسامحة يقول إن الإلزامي مخفي — المحلِّل لا يخفيه
  const t = texts();
  const crafted: PrintTextsV1 = {
    ...t,
    edits: { ...t.edits, 'h.taxNumber': { text: null, alt: null, hidden: true }, 'tot.vat': { text: null, alt: null, hidden: true }, 'rcp.number': { text: null, alt: null, hidden: true } },
  };
  for (const std of [false, true]) {
    const p = makePrintTexts(crafted, enTr, { standard: std });
    for (const k of ['h.taxNumber', 'tot.vat', 'rcp.number']) {
      assert.equal(p.hidden(k), false, `${k} (zatca/fixed/shape)`);
      assert.equal(p.hiddenInSettings(k), false, k);
    }
  }
  // والقراءة المتسامحة تُسقطها أصلاً
  const viaNormalize = normalizePrintTexts(crafted)!;
  for (const k of ['h.taxNumber', 'tot.vat', 'rcp.number']) assert.ok(!(k in viaNormalize.edits), k);
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

test('العنوان: المرحلة الثانية تطبع عنوان القرار كما هو (والإخفاء والصياغة لا يمسّانه)، والأولى بصياغة الشركة أو نصٌّ فارغ إذا أخفته', () => {
  const p = makePrintTexts(texts(), enTr, { standard: false });
  // المرحلة الثانية: inv.title مُعاد صياغته وinv.returnTitle مخفيّ — كلاهما يُتجاهل
  assert.deepEqual(p.title('فاتورة ضريبية', P2), { text: 'فاتورة ضريبية', alt: ph('فاتورة ضريبية') });
  assert.deepEqual(p.title('فاتورة ضريبية مبسطة', P2), { text: 'فاتورة ضريبية مبسطة', alt: ph('فاتورة ضريبية مبسطة') });
  assert.deepEqual(p.title('إشعار دائن مرتجع', P2R), { text: 'إشعار دائن مرتجع', alt: ph('إشعار دائن مرتجع') });
  assert.deepEqual(makePrintTexts(texts({ secondLang: null }), enTr, { standard: false }).title('فاتورة ضريبية', P2), { text: 'فاتورة ضريبية', alt: null });
  // المرحلة الأولى: صياغة الشركة بنصّها الثاني، والمرتجع المخفيّ ''
  assert.deepEqual(p.title('فاتورة ضريبية مبسطة', P1), { text: 'فاتورة مبيعات', alt: 'Sales invoice' });
  assert.deepEqual(p.title('فاتورة ضريبية', P1), { text: 'فاتورة مبيعات', alt: 'Sales invoice' }, 'القياسية أيضاً');
  assert.deepEqual(p.title('إشعار دائن مرتجع', P1R), { text: '', alt: null });
  // العنوان المخفيّ يبقى مخفياً على القياسية (قفل title لا standard — قرار المالك)
  const hiddenTitle = texts({ edits: { 'inv.title': { text: null, alt: null, hidden: true } } });
  assert.deepEqual(makePrintTexts(hiddenTitle, enTr, { standard: true }).title('فاتورة ضريبية', P1), { text: '', alt: null });
  assert.equal(makePrintTexts(hiddenTitle, enTr, { standard: true }).title('فاتورة ضريبية', P2).text, 'فاتورة ضريبية');
  // بلا تعديل: عنوان القرار وترجمته (لا ترجمة مدخل القائمة «المبسّطة» للقياسية)
  const plain = makePrintTexts(texts({ edits: { 'h.phone': { text: 'الهاتف', alt: null, hidden: false } } }), enTr, { standard: false });
  assert.deepEqual(plain.title('فاتورة ضريبية مبسطة', P1), { text: 'فاتورة ضريبية مبسطة', alt: ph('فاتورة ضريبية مبسطة') });
  assert.deepEqual(plain.title('فاتورة ضريبية', P1), { text: 'فاتورة ضريبية', alt: ph('فاتورة ضريبية') });
  assert.deepEqual(plain.title('إشعار دائن مرتجع', P1R), { text: 'إشعار دائن مرتجع', alt: ph('إشعار دائن مرتجع') });
  // صياغةٌ خارج القاموس بلا نصٍّ ثانٍ ⇒ بلا سطر ثانٍ
  const own = makePrintTexts(texts({ edits: { 'inv.title': { text: OUTSIDE, alt: null, hidden: false } } }), enTr, { standard: false });
  assert.deepEqual(own.title('فاتورة ضريبية مبسطة', P1), { text: OUTSIDE, alt: null });
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
  // إخفاءٌ مقفل في كائنٍ خام لا يُعدّ مخفياً (لا يُخفى عند الطباعة) — ونصّ اللغة الثانية يُعدّ متى اختيرت لغةٌ ثانية وحدها
  const crafted: PrintTextsV1 = { ...emptyPrintTexts(), secondLang: 'en', edits: { 'tot.vat': { text: null, alt: 'VAT', hidden: true }, 'h.taxNumber': { text: null, alt: null, hidden: true } } };
  assert.deepEqual(printTextsSummary(crafted), { reworded: 1, hidden: 0 });
  assert.deepEqual(printTextsSummary({ ...crafted, secondLang: null }), { reworded: 0, hidden: 0 }, 'نصٌّ ثانٍ بلا لغةٍ ثانية لا يُطبع فلا يُعدّ');
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
