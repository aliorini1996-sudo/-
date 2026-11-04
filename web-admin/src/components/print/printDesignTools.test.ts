// «أدوات التصميم» في محرّر القالب (طلب المالك ٣ نوفمبر ٢٠٢٦، pd_spec P7): حجم الشعار بمنزلقة مستمرة بالمم ومحاذاته الأربع على الرول
// أيضاً ومكانه قسماً مستقلاً، وأدوات كل قسم (SectionStyleFields)، وشكل الجدول على الرول، و«تحرير الشريط الكلاسيكي» بنسخةٍ لا تمسّ
// الكلاسيكي، والسحب باللمس في «ترتيب الأقسام» (Pointer Events) مع بقاء سحب الفأرة و▲▼، وتركيب المصمّم الحرّ كسولاً خلف حاجز.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ALIGN_LABELS, CANVAS_BAND_LABELS, CANVAS_BOX_LABELS, LEGACY_THERMAL_ID, LOGO_POSITIONS, PRINT_ISSUES, TABLE_STYLES, defaultPrintOptions,
  layoutIssues, layoutOf, legacyPrintSettings, presetPaper, sectionsFor, withLayout,
  type PrintProfile, type PrintSettingsV1,
} from '../../lib/print/printSettings';
import { logoMmRange, withSectionStyle } from '../../lib/print/designModel';
import { PHRASES } from '../../i18n/strings';
import { HIDE_MANDATORY_WARNING, LOCKED_VISIBLE_HINT } from './designer/SectionStyleFields';
import { DESIGNER_DISCARD_CONFIRM, MONO_PREVIEW_HINT } from './designer/PrintDesigner';
import PrintDesignTools, { CLASSIC_COPY_NAME, classicCopyFor, isClassicRoll, logoSlider, toolRows } from './PrintDesignTools';
import { LayoutFields, logoChoices, rowIndexAtY } from './PrintPreview';

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const printDir = ['src', 'components', 'print'];

const prof = (pid: string, printer: PrintProfile['printer'], template: PrintProfile['template'], preset: Parameters<typeof presetPaper>[0]): PrintProfile =>
  ({ id: pid, name: pid, printer, template, paper: presetPaper(preset)!, options: defaultPrintOptions(printer) });
const page = () => prof('office', 'page', 'page_branded', 'a4');
const mip = () => prof('mip480', 'impact', 'impact_plain', 'ff_a4');
const pre = () => prof('pre', 'impact', 'impact_preprinted', 'ff_a4');
const van = () => prof('van-80', 'thermal', 'roll_compact', 'roll80');
const van58 = () => prof('van-58', 'thermal', 'roll_compact', 'roll58');
const classic = () => prof('cls', 'thermal', 'roll_classic', 'roll58');
const valid = (p: PrintProfile) => assert.deepEqual(layoutIssues(p, 'p'), [], JSON.stringify(p.options.layout));
const render = (p: PrintProfile, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(PrintDesignTools, { p, update: () => {}, phase2: true, ...extra }));

test('الرول: الشعار بمواضعه الأربعة (يمين/وسط/يسار/بلا) — وكل موضعٍ صالحٌ بقواعد الخادم، وشكل الجدول الثلاثة', () => {
  assert.deepEqual([...logoChoices(van())], [...LOGO_POSITIONS]);
  assert.deepEqual([...logoChoices(page())], [...LOGO_POSITIONS]);
  for (const logo of LOGO_POSITIONS) valid(withLayout(van(), { logo }));
  for (const tableStyle of TABLE_STYLES) valid(withLayout(van58(), { tableStyle }));
  const h = render(van());
  const logoGroup = h.slice(h.indexOf('aria-label="مكان الشعار"'));
  assert.equal(logoGroup.slice(0, logoGroup.indexOf('</div>')).match(/<button/g)?.length, 4, 'أربع شرائح للشعار على الرول');
  assert.ok(h.includes('aria-label="شكل الجدول"'), 'شكل الجدول على الرول في الأدوات');
  assert.ok(!render(page()).includes('aria-label="شكل الجدول"'), 'الصفحة: شكل الجدول في «التخطيط» كاليوم');
});

test('منزلقة الشعار: حدودها لكل ورق (الرول حتى عرض الحزمة)، وقيمتها الحجم الفعّال، وكل قيمةٍ منها صالحة — ومطفأةٌ حيث لا شعار', () => {
  // الشعار مطفأ افتراضاً على النقطية والرول (showLogo) — يُشغَّل لاختبار المنزلقة
  const on = (p: PrintProfile): PrintProfile => ({ ...p, options: { ...p.options, showLogo: true } });
  for (const p of [page(), on(mip()), on(van()), on(van58())]) {
    const s = logoSlider(p);
    assert.deepEqual([s.min, s.max], [...logoMmRange(p)], p.id);
    assert.equal(s.step, 0.5);
    assert.ok(s.value >= s.min && s.value <= s.max, `${p.id}: ${s.value}`);
    assert.equal(s.disabled, false, p.id);
  }
  assert.equal(logoSlider(van()).disabled, true, 'الرول بلا شعار افتراضاً');
  assert.ok(logoSlider(van58()).max <= 48, 'رول 58: لا يتجاوز عرض الحزمة المطبوعة');
  const off = { ...page(), options: { ...page().options, showLogo: false } };
  assert.equal(logoSlider(off).disabled, true, 'الشعار مطفأ في المحتوى');
  assert.equal(logoSlider(withLayout(page(), { logo: 'none' })).disabled, true, 'بلا شعار');
  const h = render(page());
  const range = h.match(/<input type="range"[^>]*aria-label="حجم الشعار"[^>]*>/)?.[0] ?? '';
  assert.ok(range, 'منزلقة مستمرة');
  assert.match(range, /min="6"/);
  assert.match(range, /step="0.5"/);
  assert.match(range, /touch-action:pan-y/);
  assert.ok(!render(pre()).includes('aria-label="حجم الشعار"'), 'الورق المطبوع مسبقاً بلا شعار');
});

test('مكان الشعار: داخل الترويسة كاليوم، أو أعلى الورقة، أو بعد أي قسمٍ من أقسام التصميم — في الصفحة والرول', () => {
  for (const p of [page(), van()]) {
    const h = render(p);
    const sel = h.slice(h.indexOf('data-logo-placement'), h.indexOf('</select>', h.indexOf('data-logo-placement')));
    const l = layoutOf(p);
    assert.equal(sel.match(/<option/g)?.length, 2 + sectionsFor(p.printer, l.design).length, p.id);
    assert.ok(sel.includes('value="top"'));
  }
});

test('صفوف الأقسام: صفٌّ لكل قسم بأدواته، والأصناف ورمز QR لا تُخفى، والمخفي والمعدَّل موسومان، والمحدَّد مفتوح', () => {
  const p0 = page();
  assert.deepEqual(toolRows(p0).map((r) => r.id), [...sectionsFor('page', 'standard')]);
  const h0 = render(p0);
  assert.equal(h0.match(/data-section-style="/g)?.length, sectionsFor('page', 'standard').length);
  const items = h0.slice(h0.indexOf('data-section-style="items"'));
  assert.ok(items.slice(0, items.indexOf('</button>')).includes('disabled=""'), 'إخفاء الأصناف معطّل');
  const p1 = withSectionStyle(withSectionStyle(p0, 'note', { visible: false }), 'totals', { fontPct: 120 });
  const rows = toolRows(p1);
  assert.equal(rows.find((r) => r.id === 'note')!.hidden, true);
  assert.equal(rows.find((r) => r.id === 'totals')!.styled, true);
  assert.equal(rows.find((r) => r.id === 'items')!.locked, true);
  assert.equal(rows.find((r) => r.id === 'header')!.styled, false);
  const h1 = render(p1, { selected: 'totals' });
  assert.match(h1, /<details[^>]*data-tool-row="totals"[^>]*open=""/, 'القسم المحدَّد في المصمّم مفتوح');
  assert.doesNotMatch(h1, /<details[^>]*data-tool-row="header"[^>]*open=""/);
  // الرول بأقسامه، ورمز QR الرول مقفل الظهور
  assert.deepEqual(toolRows(van()).map((r) => r.id), [...sectionsFor('thermal', 'standard')]);
  assert.equal(toolRows(van()).find((r) => r.id === 'qr')!.locked, true);
});

test('القسم الحامل لرمز QR مخفيّاً: تنبيه أن الرمز يطبع وحده — ولا تنبيه بدونه', () => {
  const hidden = withSectionStyle(page(), 'totals', { visible: false });
  assert.ok(render(hidden).includes('data-qr-orphan'));
  assert.ok(!render(page()).includes('data-qr-orphan'));
});

test('الكلاسيكي والافتراضي: بلا أدوات تحرير — والكلاسيكي يُعرَف لـ«تحرير الشريط الكلاسيكي»', () => {
  assert.equal(isClassicRoll(classic()), true);
  assert.equal(isClassicRoll(legacyPrintSettings().profiles[0]), true);
  assert.equal(isClassicRoll(van()), false);
  assert.equal(isClassicRoll(page()), false);
  const h = render(classic());
  assert.ok(!h.includes('type="range"'));
  assert.ok(!h.includes('data-section-style'));
  assert.ok(h.includes('data-tools-locked'));
});

test('«تحرير الشريط الكلاسيكي»: نسخة roll_compact على 58 مم بتخطيطٍ صالح، والتوجيه ينتقل إليها، والكلاسيكي لا يُمسّ', () => {
  const s0 = legacyPrintSettings();
  const before = JSON.stringify(s0);
  const r = classicCopyFor(s0, s0.profiles[0], 0, 'شريط');
  assert.ok(r);
  assert.equal(JSON.stringify(s0), before, 'المدخل لا يتغيّر');
  assert.equal(r.settings.profiles.length, 3);
  assert.equal(r.index, 2);
  assert.equal(r.profile.id, r.settings.profiles[2].id);
  assert.equal(r.profile.template, 'roll_compact');
  assert.equal(r.profile.paper.widthMm, s0.profiles[0].paper.widthMm);
  valid(r.profile);
  assert.deepEqual(r.settings.profiles[0], s0.profiles[0], 'الكلاسيكي كما هو');
  assert.equal(r.settings.routing.invoice, r.profile.id);
  assert.equal(r.settings.routing.receipt, r.profile.id);
  assert.equal(r.settings.pdfProfileId, s0.pdfProfileId);
  // قالبٌ مفتوحٌ لم يُضف بعد (نسخةٌ من الكلاسيكي): يُضاف ثم يُنسخ
  const dup = { ...classic(), id: 'thermal-2' };
  const r2 = classicCopyFor(s0, dup, null, 'شريط');
  assert.ok(r2);
  assert.equal(r2.settings.profiles.length, 4);
  assert.equal(r2.settings.routing.invoice, LEGACY_THERMAL_ID, 'التوجيه لا ينتقل من كلاسيكيٍّ آخر');
  assert.equal(classicCopyFor(s0, van(), null, 'x'), null, 'غير الكلاسيكي');
  const full: PrintSettingsV1 = { ...s0, profiles: [...s0.profiles, ...Array.from({ length: 10 }, (_, i) => ({ ...van(), id: `t-${i}` }))] };
  assert.equal(classicCopyFor(full, full.profiles[0], 0, 'x'), null, 'الحد 12 قالباً');
  assert.ok(PHRASES[CLASSIC_COPY_NAME], 'اسم النسخة مترجم');
});

test('ترتيب الأقسام باللمس: الصفّ تحت الإصبع من مستطيلات الصفوف، ومقبض السحب بلا تمرير — وسحب الفأرة و▲▼ باقية', () => {
  const rects = [{ top: 0, bottom: 20 }, { top: 20, bottom: 40 }, { top: 40, bottom: 60 }];
  assert.equal(rowIndexAtY(rects, -30), 0);
  assert.equal(rowIndexAtY(rects, 5), 0);
  assert.equal(rowIndexAtY(rects, 25), 1);
  assert.equal(rowIndexAtY(rects, 59), 2);
  assert.equal(rowIndexAtY(rects, 400), 2);
  assert.equal(rowIndexAtY([], 10), -1);
  const h = renderToStaticMarkup(createElement(LayoutFields, { p: page(), update: () => {} }));
  const li = (sid: string) => { const at = h.indexOf(`<li data-section="${sid}"`); return h.slice(at, h.indexOf('</li>', at)); };
  assert.match(li('items'), /data-grip=""[^>]*touch-action:none/, 'المقبض المتحرّك بلا تمرير لمس');
  assert.doesNotMatch(li('header'), /data-grip=""[^>]*touch-action:none/, 'الثابت يُمرَّر عليه كالعادة');
  const v = read(...printDir, 'PrintPreview.tsx');
  const sec = v.slice(v.indexOf('export function LayoutFields('), v.indexOf('function AccentPicker('));
  for (const frag of ['onPointerDown=', 'setPointerCapture', 'onPointerCancel=', "e.pointerType === 'mouse'", 'canMoveSection(p, t.id, t.over)', 'draggable={movable}']) {
    assert.ok(sec.includes(frag), frag);
  }
});

test('التوصيل: «أدوات التصميم» بعد «التخطيط»، والمصمّم الحرّ كسولاً خلف حاجز، و«تحرير الشريط الكلاسيكي» في المحرّر والقائمة', () => {
  const s = read(...printDir, 'PrintSettingsPanel.tsx');
  const layout = "<Section title={tr('التخطيط')} open><LayoutFields p={p} update={update} /></Section>";
  const tools = "<Section title={tr('أدوات التصميم')} open>";
  assert.ok(s.includes(layout), 'سطر التخطيط المحروس كما هو');
  assert.ok(s.indexOf(tools) > s.indexOf(layout));
  assert.ok(s.includes('<PrintDesignTools p={p} update={update} phase2={phase2} />'));
  assert.ok(s.includes("const loadDesigner = () => import('./designer/PrintDesigner');"));
  assert.ok(s.includes('lazy(loadDesigner)'));
  assert.ok(s.includes('<DesignerBoundary'));
  assert.ok(s.includes('<Suspense'));
  assert.ok(s.includes('onApply={update}'), 'المصمّم يكتب القالب المفتوح نفسه');
  assert.ok(s.includes("tr('المصمم الحر')"));
  assert.ok(s.includes("tr('تحرير الشريط الكلاسيكي')"));
  assert.ok(s.includes('classicCopyFor('));
  assert.doesNotMatch(s, /import PrintDesigner\b|from '\.\/designer\/PrintDesigner'/, 'لا استيراد مباشر يُدخل المصمّم في حزمة اللوحة');
  // كل زرٍّ type="button"، ولا رمز QR حقيقي في الأدوات
  const files = [s, read(...printDir, 'PrintDesignTools.tsx'), read(...printDir, 'PrintPreview.tsx')];
  for (const src of files) {
    const all = src.match(/<button\b/g)?.length ?? 0;
    const typed = src.match(/<button(?:\s+key=\{[^}]*\})?\s+type="button"/g)?.length ?? 0;
    assert.equal(typed, all);
    assert.doesNotMatch(src, /from 'qrcode'|buildZatcaQr|QRCode\.|QrImage/);
  }
  assert.doesNotMatch(read(...printDir, 'PrintDesignTools.tsx'), /api\/client/, 'الأدوات بلا عميل الـAPI فتُختبر في node');
});

test('الترجمة: كل tr(\'…\') في الأدوات واللوحة والمعاينة والمصمّم، وتسميات التحرير الحرّ ورسائله — بلا فاصلة علوية في الفرنسية', () => {
  const designer = path.join(root, ...printDir, 'designer');
  const sources = [
    read(...printDir, 'PrintDesignTools.tsx'), read(...printDir, 'PrintSettingsPanel.tsx'), read(...printDir, 'PrintPreview.tsx'),
    ...fs.readdirSync(designer).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts')).map((f) => read(...printDir, 'designer', f)),
  ];
  const ours = new Set<string>([
    ...Object.values(ALIGN_LABELS), ...Object.values(CANVAS_BOX_LABELS), ...Object.values(CANVAS_BAND_LABELS),
    HIDE_MANDATORY_WARNING, LOCKED_VISIBLE_HINT, DESIGNER_DISCARD_CONFIRM, MONO_PREVIEW_HINT, CLASSIC_COPY_NAME,
    PRINT_ISSUES.layoutLogoMm, PRINT_ISSUES.layoutLogoAfter, PRINT_ISSUES.layoutSectionUnknown, PRINT_ISSUES.layoutSectionBounds,
    PRINT_ISSUES.layoutLockedVisible, PRINT_ISSUES.layoutCanvasPrinter, PRINT_ISSUES.layoutCanvasBands, PRINT_ISSUES.layoutCanvasBox,
    PRINT_ISSUES.layoutCanvasFooterOnly, PRINT_ISSUES.layoutCanvasQr, PRINT_ISSUES.layoutRoll, PRINT_ISSUES.tooLarge,
  ]);
  const want = new Set(ours);
  for (const src of sources) for (const m of src.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) want.add(m[1]);
  const designerSrc = sources.slice(3).join('\n') + read(...printDir, 'PrintDesignTools.tsx');
  for (const m of designerSrc.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) ours.add(m[1]);
  // تسميات المقابض في المصمّم (ثابتٌ محلي يمرّ بـtr)
  const a4 = read(...printDir, 'designer', 'A4BandsCanvas.tsx');
  const handles = a4.slice(a4.indexOf('const HANDLE_LABELS'), a4.indexOf('});', a4.indexOf('const HANDLE_LABELS')));
  for (const m of handles.matchAll(/'([^']*[؀-ۿ][^']*)'/g)) { want.add(m[1]); ours.add(m[1]); }
  const missing: string[] = [];
  for (const ar of want) {
    if (!/[؀-ۿ]/.test(ar)) continue;
    const t = PHRASES[ar];
    if (!t) { missing.push(ar); continue; }
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(t[lang] && !/[؀-ۿ]/.test(t[lang]), `«${ar}» ${lang}`);
    if (ours.has(ar)) assert.ok(!/['’]/.test(t.fr), `«${ar}» فرنسية بفاصلة علوية`);
  }
  assert.deepEqual(missing, []);
});
