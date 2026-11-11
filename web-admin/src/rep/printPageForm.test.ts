// طباعة «نموذج الشركة المطبوع مسبقاً» عبر نظام الطباعة (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦): ورقة القالب (data-print-layout="preprinted")
// تُطبع بمقاس الورق نفسه بالمم بلا هوامش ولا zoom، بلا وسم «الأصل/نسخة» في التدفّق ولا ضبط طول ثنائي اللغة، والشريط التجريبيّ فوقها
// بلا ارتفاع، والنسخ تكرّر الأوراق — وكل ورقةٍ غيرها كما هي حرفاً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  FORM_SHEET_LAYOUT, LAYOUT_BREAK_CSS, LAYOUT_FREE_BREAK_CSS, buildFormDocument, buildPageDocument, cloneWithLabel, copiesOf, copyLabelHtml, formBannerHtml, formMarksBannerHtml,
  formBgUrlOf, formPageRule, formPrintGeom, gridSheetHeightPx, hoistFormBgCss, isFormSheet, pagePrintGeom, sheetReady,
} from './printPage';
import { defaultPrintOptions, legacyPageProfile, presetPaper, withDesign, type PaperPresetId, type PrintProfile } from '../lib/print/printSettings';
import { formBgCss } from './printPreprinted';

const page = (preset: PaperPresetId = 'a4'): PrintProfile =>
  ({ id: 'office', name: 'office', printer: 'page', template: 'page_branded', paper: presetPaper(preset)!, options: defaultPrintOptions('page') });
const form = (preset: PaperPresetId = 'a4'): PrintProfile => withDesign(page(preset), 'preprinted');

test('هندسة النموذج: مقاس الورق نفسه بالمم بلا هامشين ولا إزاحة ولا تكبير — والقياسية كما هي', () => {
  assert.deepEqual(formPrintGeom(form()), { size: '210mm 297mm', widthMm: 210, leftMm: 0, marginTopMm: 0, marginBottomMm: 0, zoom: 1 });
  assert.deepEqual(formPrintGeom(form('a5')), { size: '148mm 210mm', widthMm: 148, leftMm: 0, marginTopMm: 0, marginBottomMm: 0, zoom: 1 }, 'A5 بلا تكبير القالب');
  assert.equal(formPrintGeom(form('letter')).size, '215.9mm 279.4mm');
  // ورقٌ بلا طول (لا يقبله النموذج) ⇒ A4 طولاً
  assert.equal(formPrintGeom({ ...page(), paper: { ...page().paper, lengthMm: null } }).size, '210mm 297mm');
  assert.equal(formPageRule(formPrintGeom(form())), '@page { size: 210mm 297mm; margin: 0; }');
  // هامشا A4 القياسية (10/10) لا يمسّهما النموذج — وهندسة القالب نفسه بلا هامشين بعد withDesign
  assert.deepEqual(pagePrintGeom(legacyPageProfile()), { size: 'A4', widthMm: 210, leftMm: 0, marginTopMm: 10, marginBottomMm: 10, zoom: 1 });
  assert.deepEqual([form().paper.marginTopMm, form().paper.marginBottomMm], [0, 0]);
});

test('وثيقة النموذج: @page بلا هامش، بلا zoom ولا قاعدة «لا تقصّ الصفّ»، وكل نسخةٍ أوراقها كلها في صفحةٍ جديدة', () => {
  const g = formPrintGeom(form());
  const sheets = `<div data-print-layout="${FORM_SHEET_LAYOUT}"><div style="height:296.5mm">1</div><div style="height:296.5mm">2</div></div>`;
  const doc = buildFormDocument([sheets, sheets], g, '<style>x{}</style>');
  assert.ok(doc.includes('@page { size: 210mm 297mm; margin: 0; }'));
  assert.ok(doc.includes('<style>x{}</style>'));
  assert.ok(doc.includes('.fs-form { width: 210mm; margin: 0; padding: 0; }'));
  assert.ok(doc.includes('.fs-copy + .fs-copy { break-before: page; page-break-before: always; }'));
  assert.ok(!/zoom|break-inside/.test(doc), 'لا تكبير ولا منع قصّ في وثيقة النموذج');
  assert.ok(!doc.includes(LAYOUT_BREAK_CSS) && !doc.includes(LAYOUT_FREE_BREAK_CSS));
  assert.equal(doc.split('<div class="fs-copy">').length - 1, 2, 'نسختان = الأوراق مرّتين');
  assert.ok(doc.includes(`<body><div class="fs-form"><div class="fs-copy">${sheets}</div><div class="fs-copy">${sheets}</div></div></body>`));
  // وثيقة الصفحة لغير النموذج كما هي (الحرّاس في printPage.test.ts وlineDeletion.matrix.test.ts)
  const std = buildPageDocument(['<div>A</div>'], pagePrintGeom(legacyPageProfile()), '');
  assert.ok(std.includes('@page { size: A4; margin: 10mm 0 10mm 0; }') && std.includes('.fs-copy { zoom: 1; }'));
});

test('جذر النموذج: سمته وحدها تعني النموذج — ثنائي اللغة والقياسي وبلا سمة ليست منه', () => {
  const el = (v: string | null) => ({ getAttribute: (n: string) => (n === 'data-print-layout' ? v : null) });
  assert.equal(isFormSheet(el('preprinted')), true);
  for (const v of ['grid_bilingual', 'standard', null, 'Preprinted', 'impact_preprinted']) assert.equal(isFormSheet(el(v)), false, String(v));
  assert.equal(FORM_SHEET_LAYOUT, 'preprinted');
});

/** عقدةٌ بلا DOM: سمة الجذر وأبناءٌ وinsertAdjacentHTML — ونسختها تسجّل ما أُدرج */
interface FakeNode {
  attrs: Record<string, string>;
  style: { minHeight?: string };
  inserted: Array<[string, string]>;
  children: FakeNode[];
  tagName: string;
  getAttribute(n: string): string | null;
  insertAdjacentHTML(pos: string, html: string): void;
  querySelector(sel: string): FakeNode | null;
  cloneNode(deep: boolean): FakeNode;
}
function fakeNode(attrs: Record<string, string>, children: FakeNode[] = [], tagName = 'DIV'): FakeNode {
  const n: FakeNode = {
    attrs, style: {}, inserted: [], children, tagName,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    insertAdjacentHTML: (pos, html) => { n.inserted.push([pos, html]); },
    querySelector: () => null,
    cloneNode: () => fakeNode({ ...attrs }, children.map((c) => c.cloneNode(true)), tagName),
  };
  return n;
}

test('نسخة ورقة النموذج: لا وسم «الأصل/نسخة» ولا ضبط طول، والشريط التجريبيّ مرساةٌ بلا ارتفاع أوّلها — وغيرها كما كان', () => {
  const banner = '<div data-sample-banner="">نموذج اختبار</div>';
  const node = fakeNode({ 'data-print-layout': 'preprinted' }, [fakeNode({ 'data-form-sheet': '' })]);
  const clone = cloneWithLabel(node as unknown as HTMLElement, 'الأصل', banner, 1100) as unknown as FakeNode;
  assert.equal(clone.style.minHeight, undefined, 'لا طول ثنائي اللغة');
  assert.deepEqual(clone.inserted, [['afterbegin', formBannerHtml(banner)]], 'الشريط وحده — بلا وسم النسخة');
  assert.deepEqual(clone.children[0].inserted, [], 'لا وسم بعد الورقة الأولى');
  const plain = cloneWithLabel(node as unknown as HTMLElement, 'نسخة', null) as unknown as FakeNode;
  assert.deepEqual(plain.inserted, []);
  assert.deepEqual(plain.children[0].inserted, []);
  // الشريط فوق الورقة لا في تدفّقها
  const b = formBannerHtml(banner);
  assert.ok(b.startsWith('<div data-form-banner="" style="position:relative;height:0;overflow:visible;z-index:2"><div style="position:absolute;top:1.5mm;'));
  assert.ok(b.includes(banner));
  // ثنائي اللغة: الطول والوسم بعد الترويسة والشريط كما كانت
  const head = fakeNode({}, []);
  const grid = fakeNode({ 'data-print-layout': 'grid_bilingual' }, [head]);
  const gc = cloneWithLabel(grid as unknown as HTMLElement, 'الأصل', banner, 1100) as unknown as FakeNode;
  assert.equal(gc.style.minHeight, '1100px');
  assert.deepEqual(gc.children[0].inserted, [['afterend', copyLabelHtml('الأصل')]]);
  assert.deepEqual(gc.inserted, [['afterbegin', banner]]);
});

test('نسخة ورقة النموذج بشريط علامات القرار: الشريط التجريبيّ سطرٌ أوّل داخله لا فوقه في الموضع نفسه', () => {
  const banner = '<div data-sample-banner="">نموذج اختبار</div>';
  const marks = fakeNode({ 'data-form-marks': '' });
  const sheet = fakeNode({ 'data-form-sheet': '1' }, [marks]);
  const node = fakeNode({ 'data-print-layout': 'preprinted' }, [sheet]);
  const orig = node.cloneNode;
  node.cloneNode = () => {
    const c = orig(true);
    c.querySelector = (sel: string) => (sel === '[data-form-marks]' ? marks : null);
    return c;
  };
  const clone = cloneWithLabel(node as unknown as HTMLElement, 'الأصل', banner) as unknown as FakeNode;
  assert.deepEqual(marks.inserted, [['afterbegin', formMarksBannerHtml(banner)]], 'الشريط أوّل شريط العلامات');
  assert.deepEqual(clone.inserted, [], 'لا مرساة مطلقة فوق العلامات');
  assert.ok(formMarksBannerHtml(banner).includes(banner));
  assert.ok(!formMarksBannerHtml(banner).includes('position:absolute'), 'في التدفّق لا مطلقاً');
});

test('printPageNode: النموذج بهندسته ووثيقته بلا وسوم ولا طول — وسطر القوالب الأخرى كما كان حرفاً', () => {
  const src = fs.readFileSync(new URL('./printPage.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const fn = src.slice(src.indexOf('export async function printPageNode('), src.indexOf('export async function printHtmlDocument('));
  assert.ok(fn.includes('const form = isFormSheet(node);'));
  assert.ok(fn.includes('const g = form ? formPrintGeom(p) : pagePrintGeom(p);'));
  assert.ok(fn.includes('const sheetPx = form ? null : gridSheetHeightPx(p);'));
  assert.ok(fn.includes('const formCopies = form ? hoistFormBgCss(copiesOf(html, p.options.copies, null)) : null;'));
  assert.ok(fn.includes('? buildFormDocument(formCopies.copies, g, headStyles() + formCopies.css)'));
  assert.ok(fn.includes('await settle(idoc, formCopies ? formBgUrlOf(formCopies.css) : null);'), 'خلفية الأسلوب تُنتظر قبل نافذة الطباعة');
  assert.ok(fn.includes(': buildPageDocument(copiesOf(html, p.options.copies, p.options.copyLabels ? labels : null), g, headStyles());'));
  // حرّاس الملفات الأخرى (lineDeletion.matrix وprintPage وprintAnywhere) على أسطرها كما هي
  assert.ok(src.includes('cloneWithLabel(node, label, bannerHtml, sheetPx)'));
  assert.ok(src.includes('if (sheetHeightPx && isGridSheet(clone)) clone.style.minHeight = `${sheetHeightPx}px`;'));
  assert.ok(src.includes("if (label) copyAnchorOf(clone)?.insertAdjacentHTML('afterend', copyLabelHtml(label));"));
  assert.ok(fn.indexOf('if (iosSystemPrintAvailable())') < fn.indexOf("document.createElement('iframe')"));
  // النسخ: عدد نسخ القالب (1..3) يكرّر الأوراق، بلا وسم
  const seen: Array<string | null> = [];
  assert.equal(copiesOf((l) => { seen.push(l); return 'S'; }, 2, null).length, 2);
  assert.deepEqual(seen, [null, null]);
  // ورقة النموذج لا ضبط طول لها ولو كان القالب يحسبه (الطول للورق ثنائي اللغة وحده)
  assert.ok(gridSheetHeightPx(form()) !== null, 'القالب نفسه يحسب طولاً — والفرع يتركه للنموذج');
});

test('خلفية النموذج مرّةً في الوثيقة: أسلوبها يُرفع من كل نسخةٍ إلى الرأس، ورابطها يُستخرج للانتظار — وبلا أسلوب فالنسخ كما هي', () => {
  const url = 'data:image/jpeg;base64,/9j/AAAA';
  // كما يكتبه القالب (formBgCss): الرابط بلا اقتباس
  const css = `<style data-form-bg-css="">${formBgCss(url)}</style>`;
  const copy = `<div data-print-layout="preprinted"><div data-form-sheet="1"><div data-form-bg-layer=""></div></div>${css}</div>`;
  const out = hoistFormBgCss([copy, copy, copy]);
  assert.equal(out.css, css);
  assert.equal(out.copies.length, 3);
  for (const c of out.copies) assert.ok(!c.includes(url) && c.includes('data-form-bg-layer'), 'لا رابط في النسخ');
  const doc = buildFormDocument(out.copies, formPrintGeom(form()), out.css);
  assert.equal(doc.split(url).length - 1, 1, 'الرابط مرّةً واحدة في الوثيقة كلها');
  assert.ok(doc.indexOf(url) < doc.indexOf('<body>'), 'في الرأس');
  assert.equal(formBgUrlOf(out.css), url);
  assert.equal(formBgUrlOf(`url("${url}")`), url, 'والمقتبس كذلك');
  assert.equal(formBgUrlOf(''), null);
  const plain = hoistFormBgCss(['<div>A</div>', '<div>B</div>']);
  assert.deepEqual(plain, { copies: ['<div>A</div>', '<div>B</div>'], css: '' });
});

test('sheetReady: خلفية النموذج قيد الجلب (data-form-bg="loading") تُنتظر في المهلة ثم يُمضى بدونها — والجاهزة لا تُنتظر', async () => {
  const attrs: Record<string, string> = { 'data-print-layout': 'preprinted', 'data-form-bg': 'loading' };
  const node = {
    getAttribute: (k: string) => attrs[k] ?? null,
    querySelector: () => null,
    querySelectorAll: () => [] as unknown[],
  } as unknown as HTMLElement;
  const t0 = Date.now();
  assert.equal(await sheetReady(node, 250), true, 'المهلة لا تمنع الطباعة (القيم وحدها)');
  assert.ok(Date.now() - t0 >= 200, 'انتظرت الخلفية');
  attrs['data-form-bg'] = 'loading';
  setTimeout(() => { attrs['data-form-bg'] = 'ready'; }, 120);
  const t1 = Date.now();
  assert.equal(await sheetReady(node, 3000), true);
  const waited = Date.now() - t1;
  assert.ok(waited >= 100 && waited < 2000, `انتظرت حتى الجهوز وحده (${waited})`);
  attrs['data-form-bg'] = 'failed';
  const t2 = Date.now();
  assert.equal(await sheetReady(node, 3000), true);
  assert.ok(Date.now() - t2 < 100, 'المتعذّرة لا تُنتظر');
});
