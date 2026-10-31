// «نصوص المطبوعات» في الواجهة (طلب المالك ٣١ أكتوبر ٢٠٢٦) — توصيل البطاقة في «هوية الشركة في المطبوعات»، والمحرّر ببوابة
// خارج النموذج العام، والحفظ بمساره المستقل، والمعاينة بالقوالب الحقيقية، وترجمة كل نصّ يعرضه المحرّر (حارس مصدري كـprintSettings.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PRINT_TEXT_CATALOG, PRINT_TEXTS_ISSUES } from '../../lib/print/printTextsCore';
import { PHRASES } from '../../i18n/strings';

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const page = () => read('src', 'pages', 'CompanySettingsPage.tsx');
const card = () => read('src', 'components', 'print', 'PrintTextsCard.tsx');
const editor = () => read('src', 'components', 'print', 'PrintTextsEditor.tsx');

/** كل وسم <button: type="button" أوّل سماته (بعد key) — البطاقة داخل <form> الإعدادات العامة، وزرٌّ بلا نوع يُرسله */
function assertButtonsTyped(src: string, name: string) {
  const all = src.match(/<button\b/g)?.length ?? 0;
  const typed = src.match(/<button(?:\s+key=\{[^}]*\})?\s+type="button"/g)?.length ?? 0;
  assert.ok(all > 0, `${name}: بلا أزرار؟`);
  assert.equal(typed, all, `${name}: زرٌّ بلا type="button"`);
}

test('التوصيل: البطاقة في «هوية الشركة في المطبوعات» بعد «شكل الترويسة» وداخل النموذج — والنموذج العام لا يحمل النصوص', () => {
  const s = page();
  assert.ok(s.includes("import PrintTextsCard from '../components/print/PrintTextsCard';"));
  assert.equal(s.match(/<PrintTextsCard\b/g)?.length, 1);
  const at = s.indexOf('<PrintTextsCard company={data} />');
  const identity = s.indexOf("tr('هوية الشركة في المطبوعات')");
  const shape = s.indexOf("tr('شكل الترويسة')");
  const lot = s.indexOf('{lotCardOn && <LotOnInvoiceCard value={lotFlags.onInvoice} />}');
  assert.ok(identity > 0 && identity < shape && shape < at && at < lot, 'البطاقة خارج بطاقة الهوية أو قبل «شكل الترويسة»');
  // آخر ما في بطاقة الهوية: لا بطاقة أخرى تفتح بين «شكل الترويسة» والبطاقة
  assert.doesNotMatch(s.slice(shape, at), /className="card"/);
  assert.match(s.slice(at, lot), /^<PrintTextsCard company=\{data\} \/>\n\s*<\/div>\n/, 'البطاقة ليست آخر بطاقة الهوية');
  assert.ok(s.indexOf('<form onSubmit=') < at && at < s.indexOf('</form>'), 'البطاقة خارج النموذج — اختبار البوابة بلا معنى');
  // المحرّر لا يُستورد ثابتاً في حزمة الصفحة، ولا حقل نصوص في حفظ النموذج العام (الخادم: companySchema بلا /print/i)
  assert.doesNotMatch(s, /PrintTextsEditor/);
  const form = s.slice(s.indexOf('const mutation = useMutation({'), s.indexOf('const onLogoChange'));
  assert.ok(!/printTexts/i.test(form), 'النصوص في حفظ النموذج العام');
  assert.ok(!/printTexts/.test(s.slice(0, s.indexOf('const mutation = useMutation({'))), 'النصوص في حالة النموذج العام');
});

test('البطاقة: الحال المحفوظة من ردّ /company، وأزرارها type="button"، والمحرّر كسول خلف حاجز أخطاء', () => {
  const c = card();
  assertButtonsTyped(c, 'PrintTextsCard');
  assert.ok(c.includes("const loadEditor = () => import('./PrintTextsEditor');"));
  assert.match(c, /const Editor = useMemo\(\(\) => lazy\(loadEditor\), \[attempt\]\);/);
  const boundary = c.indexOf('<EditorBoundary onRetry=');
  const suspense = c.indexOf('<Suspense fallback=');
  const el = c.indexOf('<Editor company={company} onClose=');
  assert.ok(boundary > 0 && boundary < suspense && suspense < el, 'المحرّر الكسول خارج الحاجز أو Suspense');
  assert.match(c, /static getDerivedStateFromError\(\)/);
  // القراءة المتسامحة للعمود المحفوظ وحده — لا قيمة خام ولا مسودة
  assert.ok(c.includes('normalizePrintTexts(company?.printTexts)'));
  assert.ok(c.includes('printTextsSummary(saved)'));
  for (const lit of ["tr('نصوص الفاتورة وسند القبض')", "tr('تحرير النصوص على الفاتورة')", "tr('العربية')"]) assert.ok(c.includes(lit), lit);
  assert.doesNotMatch(c, /from '\.\.\/\.\.\/api\/client'/, 'البطاقة لا تحفظ');
});

test('المحرّر: بوابة إلى document.body بلا <form>، وكل أزراره type="button"، وEsc والإغلاق يسألان عمّا لم يُحفظ', () => {
  const e = editor();
  assert.ok(e.includes("import { createPortal } from 'react-dom';"));
  assert.match(e, /return createPortal\(\n\s*<div ref=\{dialogRef\}[^\n]*role="dialog" aria-modal="true"/);
  assert.match(e, /\n\s*document\.body,\n\s*\);\n\}/, 'البوابة ليست إلى document.body');
  // حدث submit في بوابةٍ يصعد شجرة React إلى نموذج الصفحة — فلا نموذج هنا أصلاً
  assert.doesNotMatch(e, /<form\b/);
  assertButtonsTyped(e, 'PrintTextsEditor');
  assert.ok(e.includes("if (dirty && !window.confirm(tr('لديك تعديلات غير محفوظة — إغلاق دون حفظ؟'))) return;"));
  assert.match(e, /if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); requestClose\(\); return; \}/);
  // Tab محصورٌ في النافذة: خلفها زرّ «حفظ الإعدادات» العامّ وروابط الشريط الجانبي
  assert.match(e, /if \(e\.key !== 'Tab' \|\| !box\) return;/);
});

test('الحفظ: فحص الخادم الصارم قبله، وبمساره المستقل (companyApi.printTexts.put) لا companyApi.update، والإعداد بلا أثر = إعادة', () => {
  const e = editor();
  assert.ok(e.includes('mutationFn: (v: PrintTextsV1 | null) => companyApi.printTexts.put(v),'));
  assert.doesNotMatch(e, /companyApi\.update/);
  assert.ok(e.includes('const r = checkPrintTexts(draft, true);'), 'الفحص الصارم (نسخة الخادم الحرفية) قبل الحفظ');
  assert.ok(e.includes('save.mutate(isEmptyPrintTexts(draft) ? null : r.value);'));
  assert.ok(e.includes('disabled={!dirty || !valid || save.isPending}'), 'زرّ الحفظ لا يُعطَّل مع الأخطاء');
  assert.ok(e.includes("qc.invalidateQueries({ queryKey: ['company'] });"), 'الحفظ لا يحدّث ردّ /company الذي يطبع منه المندوب');
  assert.ok(e.includes('normalizePrintTexts(company?.printTexts) ?? emptyPrintTexts()'), 'المسودة الأولى من العمود المحفوظ');
  assert.ok(e.includes("toast.error(tr(saveErrorMessage(e)));"));
  // الاستعادة تُرسل الإعادة (null ⇒ { reset: true })
  assert.match(e, /const resetAll = \(\) => \{[\s\S]*?save\.mutate\(null\);/);
  const client = read('src', 'api', 'client.ts');
  assert.ok(client.includes("get: () => api.get('/company/print-texts'),"));
  assert.ok(client.includes("put: (data: PrintTextsV1 | null) => api.put('/company/print-texts', data ?? { reset: true }),"));
});

test('المعاينة: القالبان الحقيقيان ملفوفان بـPrintTextsPreviewContext ومظهر اليوم، بمستند المرحلة الأولى، والحرارية للعرض فقط', () => {
  const e = editor();
  assert.match(e, /import \{ PrintableInvoice, PrintableReceipt, [^}]*\} from '\.\.\/\.\.\/rep\/RepDocuments';/);
  assert.ok(e.includes("import { PrintTextsPreviewContext } from '../../rep/printTextsContext';"));
  const look = e.indexOf('<PrintLookContext.Provider value={DEFAULT_PRINT_LOOK}>');
  const open = e.indexOf('<PrintTextsPreviewContext.Provider value={preview}>');
  const inv = e.indexOf('<PrintableInvoice doc={invoiceDoc} />');
  const rcp = e.indexOf('<PrintableReceipt doc={receiptDoc} />');
  const close = e.indexOf('</PrintTextsPreviewContext.Provider>');
  assert.ok(look > 0 && look < open && open < inv && inv < rcp && rcp < close, 'القالبان خارج سياق المعاينة');
  assert.equal(e.match(/<PrintableInvoice\b/g)?.length, 1);
  assert.equal(e.match(/<PrintableReceipt\b/g)?.length, 1);
  assert.ok(e.includes('const preview = useMemo(() => ({ onPick, active }), [onPick, active]);'));
  // المسودة على مستند العيّنة بالقراءة المتسامحة (نصٌّ نصف مكتوب يُعايَن)
  assert.ok(e.includes('const texts = useMemo(() => normalizePrintTexts(draft), [draft]);'));
  assert.ok(e.includes('printTexts: texts,'));
  // المرحلة الأولى: لا zatca على العيّنة — وإلا طبع القالب عنوان القرار وغاب أثر تعديل العنوان
  const samples = e.slice(e.indexOf('function sampleCompany('), e.indexOf('/** عناوين المجموعات'));
  assert.ok(samples.length > 0);
  assert.doesNotMatch(samples, /\bzatca\s*:/);
  // الحرارية: وثيقة القالب الحراريّ نفسه في iframe بلا سكربت
  assert.ok(e.includes("import { thermalPreviewHtml } from '../../rep/thermal';"));
  assert.ok(e.includes('thermalPreviewHtml(doc, { tr, paperMm })'));
  assert.ok(e.includes('sandbox="allow-same-origin"'), 'iframe بلا sandbox');
  assert.doesNotMatch(e, /allow-scripts/);
});

test('القاموس: كل نصٍّ في القائمة وكل سبب رفض وكل عبارةٍ يعرضها المحرّر والبطاقة لها اللغات الأربع', () => {
  const e = editor();
  const c = card();
  const want = new Set<string>([...PRINT_TEXT_CATALOG.map((x) => x.ar), ...Object.values(PRINT_TEXTS_ISSUES), 'اسم الشركة في التذييل']);
  // نداءات tr('…') الحرفية
  for (const src of [e, c]) for (const m of src.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) want.add(m[1]);
  // الثوابت التي تمرّ بـtr متغيّرةً: عناوين المجموعات وأسباب القفل والتنبيهات
  for (const name of ['GROUP_TITLES', 'LOCK_REASONS']) {
    const at = e.indexOf(`const ${name}`);
    assert.ok(at > 0, name);
    const body = e.slice(at, e.indexOf('});', at));
    const vals = [...body.matchAll(/\w+: '([^']+)'/g)].map((m) => m[1]);
    assert.ok(vals.length >= 3, name);
    for (const v of vals) want.add(v);
  }
  for (const name of ['STANDARD_HINT', 'TITLE_WARNING', 'PHASE2_TITLE_NOTE']) {
    const m = e.match(new RegExp(`const ${name} = '([^']+)';`));
    assert.ok(m, name);
    want.add(m[1]);
  }
  // «العنوان» في القاموس «Address» — عنوان مجموعة العنوان غيرها
  assert.ok(!e.includes("title: 'العنوان'"), 'مجموعة عنوان المستند تُترجم «Address»');
  const missing: string[] = [];
  for (const ar of want) {
    const t = PHRASES[ar];
    if (!t || !t.en || !t.fr || !t.tr || !t.zh) { missing.push(ar); continue; }
    assert.ok(!t.fr.includes("'"), `«${ar}» فرنسية بفاصلة علوية`);
  }
  assert.deepEqual(missing, [], 'بلا مدخل كامل في القاموس');
});
