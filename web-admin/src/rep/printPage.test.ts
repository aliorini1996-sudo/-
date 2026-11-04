// طباعة الصفحة والنقطية عبر نظام الطباعة («إعدادات الطباعة» M2، التصميم §3.2 و§1.5): مقاس @page لكل ورق، وحزمة MIP480 في
// منتصف A4 بعرض 8.0 بوصة، والنسخ الموسومة، ومظهر الطباعة (الافتراضي = اليوم حرفاً بحرف)، ومقاس صفحة الـPDF من جذر القالب.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYOUT_BREAK_CSS, LAYOUT_FREE_BREAK_CSS, TEMPLATE_WIDTH_PX, buildPageDocument, copiesOf, copyAnchorOf, copyLabelHtml, freeSheetHtml, pagePrintGeom, pageRule,
  pageSizeOf,
} from './printPage';
import { DEFAULT_PRINT_LOOK, PRINT_LOOK_CSS, SHEET_WIDTH_PX, lookFor, lookNeedsCss, lookRootAttrs, pdfFormatOfPaper } from './printLook';
import { pdfPageOf } from './pdf';
import {
  PAGE_STAMPED_QR_PX, PAGE_TEMPLATE_WIDTH_PX, PAPER_PRESETS, PRINT_ISSUES, PRINT_LIMITS, STAMPED_QR_CELLS, checkPrintSettings,
  defaultPrintLayout, defaultPrintOptions, legacyPageProfile, legacyPrintSettings, legacyThermalProfile, pageQrImageMm, pageQrModuleMm, presetPaper,
  type PaperPresetId, type PrintProfile, type PrinterType, type TemplateId,
} from '../lib/print/printSettings';
import fs from 'node:fs';
import path from 'node:path';

const profile = (printer: PrinterType, template: TemplateId, preset: PaperPresetId, patch?: Partial<PrintProfile['options']>): PrintProfile => ({
  id: 'p-1', name: 'p', printer, template, paper: presetPaper(preset)!, options: { ...defaultPrintOptions(printer), ...patch },
});

test('مقاس @page: الكلمات المعروفة باسمها، وغيرها بالمم', () => {
  assert.equal(pageSizeOf(presetPaper('a4')!), 'A4');
  assert.equal(pageSizeOf(presetPaper('a5')!), 'A5');
  assert.equal(pageSizeOf(presetPaper('letter')!), 'letter');
  assert.equal(pageSizeOf(presetPaper('cut_a4')!), 'A4');
  assert.equal(pageSizeOf(presetPaper('ff_95x11')!), '241mm 279.4mm');
  assert.equal(pageSizeOf(presetPaper('ff_95x55')!), '241mm 139.7mm');
});

test('العادية: القالب بعرض الورق (A4 بلا تكبير)، والهامشان العلوي والسفلي من القالب', () => {
  const a4 = pagePrintGeom(legacyPageProfile());
  assert.deepEqual(a4, { size: 'A4', widthMm: 210, leftMm: 0, marginTopMm: 10, marginBottomMm: 10, zoom: 1 });
  assert.equal(pageRule(a4), '@page { size: A4; margin: 10mm 0 10mm 0; }');
  const a5 = pagePrintGeom(profile('page', 'page_plain', 'a5'));
  assert.equal(a5.size, 'A5');
  assert.ok(Math.abs(a5.zoom - (148 * 96 / 25.4) / TEMPLATE_WIDTH_PX) < 1e-4, `${a5.zoom}`);
  assert.equal(pagePrintGeom(profile('page', 'page_branded', 'letter')).size, 'letter');
});

test('النقطية MIP480: حزمة 1440 نقطة (8.0 بوصة = 768 بكسل) في منتصف الورق ثم إزاحة المعايرة — ولا تخرج عنه', () => {
  const ff = pagePrintGeom(profile('impact', 'impact_plain', 'ff_a4'));
  assert.equal(ff.size, 'A4');
  assert.equal(ff.widthMm, 203.2);
  assert.equal(ff.leftMm, 3.4);
  assert.equal(ff.zoom, Math.round((768 / TEMPLATE_WIDTH_PX) * 10000) / 10000);
  assert.deepEqual([ff.marginTopMm, ff.marginBottomMm], [5, 5]);
  const wide = pagePrintGeom(profile('impact', 'impact_plain', 'ff_95x11'));
  assert.deepEqual([wide.size, wide.leftMm], ['241mm 279.4mm', 18.9]);
  const shifted = profile('impact', 'impact_preprinted', 'ff_a4');
  shifted.paper.offsetXmm = 2;
  assert.equal(pagePrintGeom(shifted).leftMm, 5.4);
  shifted.paper.offsetXmm = -15;
  assert.equal(pagePrintGeom(shifted).leftMm, 0);
  shifted.paper.offsetXmm = 15;
  assert.equal(pagePrintGeom(shifted).leftMm, 6.8, 'الحزمة لا تتجاوز حافة الورق');
});

test('الوثيقة: @page ثم الحزمة ثم النسخ كلٌّ في صفحته — والوسم سطرٌ تحت الترويسة مُهرَّب', () => {
  const g = pagePrintGeom(profile('impact', 'impact_plain', 'cut_a4'));
  const html = buildPageDocument(['<div>A</div>', '<div>B</div>'], g, '<style>x{}</style>');
  assert.ok(html.includes(pageRule(g)));
  assert.ok(html.includes('<style>x{}</style>'));
  assert.ok(html.includes(`.fs-band { width: 203.2mm; margin: 0 auto 0 3.4mm; }`));
  assert.ok(html.includes(`.fs-copy { zoom: ${g.zoom}; }`));
  assert.ok(html.includes('.fs-copy + .fs-copy { break-before: page;'));
  assert.ok(html.includes('<div class="fs-copy"><div>A</div></div><div class="fs-copy"><div>B</div></div>'));
  const seen: Array<string | null> = [];
  const make = (label: string | null) => { seen.push(label); return label ?? '-'; };
  assert.deepEqual(copiesOf(make, 3, ['الأصل', 'نسخة']), ['الأصل', 'نسخة', 'نسخة']);
  assert.deepEqual(copiesOf(make, 2, null), ['-', '-']);
  assert.equal(copiesOf(make, 9, null).length, 3, 'ثلاث نسخ حدّاً');
  assert.equal(copiesOf(make, 0, null).length, 1);
  assert.ok(copyLabelHtml('<b>').includes('&lt;b&gt;'));
});

test('مظهر الطباعة: ملف الـPDF الافتراضي = مظهر اليوم بلا سمة واحدة على الجذر', () => {
  assert.deepEqual(lookFor(legacyPageProfile()), DEFAULT_PRINT_LOOK);
  assert.deepEqual(lookRootAttrs(DEFAULT_PRINT_LOOK), {});
  assert.equal(lookNeedsCss(DEFAULT_PRINT_LOOK), false);
  assert.deepEqual(lookFor(legacyThermalProfile()), DEFAULT_PRINT_LOOK, 'الحرارية ليست قالب صفحة');
  // بسيط موفر للحبر: أحادي اللون بترويسة الشركة
  const plain = lookFor(profile('page', 'page_plain', 'a5'));
  assert.deepEqual([plain.mono, plain.minimalHeader, plain.pdfFormat], [true, false, 'a5']);
  assert.deepEqual(lookRootAttrs(plain), { 'data-print-look': 'mono', 'data-pdf-format': 'a5' });
  // النقطية: أحادي اللون + ترويسة بسيطة + خط عريض (افتراضيّها) + حشوة أضيق
  const imp = lookFor(profile('impact', 'impact_plain', 'ff_a4'));
  assert.deepEqual([imp.mono, imp.minimalHeader, imp.boldBody, imp.pagePadding, imp.showLogo], [true, true, true, 16, false]);
  assert.equal(lookRootAttrs(imp)['data-print-look'], 'mono bold');
  // على نموذج مطبوع مسبقاً: لا شعار ولو طُلب
  assert.equal(lookFor(profile('impact', 'impact_preprinted', 'ff_a4', { showLogo: true })).showLogo, false);
  assert.equal(lookFor(profile('impact', 'impact_plain', 'ff_a4', { showLogo: true })).showLogo, true);
  // المقاس المخصّص للـPDF بالمم
  assert.equal(pdfFormatOfPaper(presetPaper('ff_95x11')!), '241x279.4');
  assert.equal(pdfFormatOfPaper(presetPaper('letter')!), 'letter');
});

test('أحادي اللون يغلب النمط المضمّن ولا يمسّ صورة الرمز ولا إطاره', () => {
  assert.match(PRINT_LOOK_CSS, /\[data-print-look~="mono"\], \[data-print-look~="mono"\] \* \{ color: #000 !important; background: transparent !important; border-color: #000 !important;/);
  assert.match(PRINT_LOOK_CSS, /img:not\(\[alt="QR"\]\) \{ filter:/, 'المرشّح على الشعار وحده — الرمز بلا تعديل');
  assert.match(PRINT_LOOK_CSS, /div:has\(> img\[alt="QR"\]\) \{ border-color: transparent !important; \}/, 'لا حدّ أسود يأكل المنطقة الصامتة');
});

test('مقاس صفحة الـPDF من جذر القالب: الغياب والعطب A4 كما اليوم', () => {
  assert.deepEqual(pdfPageOf(undefined), { format: 'a4', orientation: 'portrait' });
  assert.deepEqual(pdfPageOf(''), { format: 'a4', orientation: 'portrait' });
  assert.deepEqual(pdfPageOf('a4'), { format: 'a4', orientation: 'portrait' });
  assert.deepEqual(pdfPageOf('a5'), { format: 'a5', orientation: 'portrait' });
  assert.deepEqual(pdfPageOf('letter'), { format: 'letter', orientation: 'portrait' });
  assert.deepEqual(pdfPageOf('241x279.4'), { format: [683.15, 792], orientation: 'portrait' });
  assert.deepEqual(pdfPageOf('241x139.7'), { format: [683.15, 396], orientation: 'landscape' }, 'نصف الصفحة أفقيّ');
  for (const bad of ['A4;', '9999x10', '10x10', 'x', '241X279', 'javascript:1']) assert.deepEqual(pdfPageOf(bad), { format: 'a4', orientation: 'portrait' }, bad);
  // أضيق من A5 ⇒ A4 (حدٌّ ثانٍ بعد النواة): الرمز المختوم لا يُصغَّر مع صفحةٍ ضيّقة
  for (const narrow of ['58x200', '80x297', '147.9x210']) assert.deepEqual(pdfPageOf(narrow), { format: 'a4', orientation: 'portrait' }, narrow);
  assert.deepEqual(pdfPageOf('148x210'), { format: [419.53, 595.28], orientation: 'portrait' });
});

test('الرمز المختوم في قالب الصفحة لا يُصغَّر تحت ~0.3 مم للخلية: قالبٌ عاديّ بورق 58 أو 80 مم مرفوض، وكل مقاسٍ مقبول يُبقي الخلية فوقه', () => {
  // ثوابت الحساب هي ما يرسمه القالب فعلاً: عرض 794 بكسل وصورة الرمز 176 بكسل بهامش خلية (margin: 1)
  assert.equal(PAGE_TEMPLATE_WIDTH_PX, SHEET_WIDTH_PX);
  const rep = fs.readFileSync(path.join(process.cwd(), 'src', 'rep', 'RepDocuments.tsx'), 'utf8');
  // «التحرير الحرّ» (P3): مربع QR في لوحةٍ أكبر يُكبّر الصورة (imgPx) ولا يصغّرها أبداً تحت 176 — إحدى الصيغتين
  const fixed = rep.includes(`<QrImage value={zDecision.qr.value} size={${PAGE_STAMPED_QR_PX}} ec="L" scale={4} />`);
  const grown = rep.includes(`<QrImage value={zDecision.qr.value} size={imgPx(${PAGE_STAMPED_QR_PX})} ec="L" scale={4} />`)
    && /const imgPx = \(today: number\): number => \([^;]*Math\.max\(today, [^;]*\) : today\);/.test(rep);
  assert.ok(fixed || grown, 'رمز الصفحة المختوم لم يعد 176 بكسل على الأقل');
  assert.ok(rep.includes("QRCode.toDataURL(value, { width: size * scale, margin: 1, errorCorrectionLevel: ec })"));
  // 58×200 مم كان يعطي ~0.14 مم للخلية (الرمز ~13 مم) — مرفوضٌ الآن في النواة لا في الواجهة وحدها
  assert.ok(pageQrModuleMm(58, STAMPED_QR_CELLS.max) < 0.15);
  for (const w of [58, 80]) {
    const s = legacyPrintSettings();
    s.profiles.push({ ...profile('page', 'page_plain', 'a4'), id: 'narrow', name: 'narrow', paper: { ...presetPaper('a4')!, preset: 'custom', widthMm: w, lengthMm: 200 } });
    const r = checkPrintSettings(s, true);
    assert.ok(!r.ok && r.issues.some((i) => i.message === PRINT_ISSUES.pageWidth && i.path === 'profiles[2].paper.widthMm'), `${w} مم`);
    assert.deepEqual(pdfPageOf(pdfFormatOfPaper({ ...presetPaper('a4')!, widthMm: w, lengthMm: 200 })), { format: 'a4', orientation: 'portrait' }, `${w} مم في الـPDF`);
  }
  // كل هندسة صفحةٍ مقبولة: المقاسات الجاهزة وأضيق مخصّص — الخلية ≥ 0.3 مم والرمز ≥ 28 مم
  const widths = [...PAPER_PRESETS.filter((x) => x.printer === 'page').map((x) => x.paper.widthMm), PRINT_LIMITS.pageMinWidthMm];
  for (const w of widths) {
    const mod = pageQrModuleMm(w, STAMPED_QR_CELLS.max);
    assert.ok(mod >= 0.3, `${w} مم: ${mod.toFixed(3)} مم للخلية`);
    assert.ok(pageQrImageMm(w) >= 28, `${w} مم: الرمز ${pageQrImageMm(w).toFixed(1)} مم`);
  }
  assert.ok(Math.abs(pageQrImageMm(210) - 46.55) < 0.05, 'A4 كما اليوم');
});

test('«تخطيط المطبوعات»: المظهر يحمل التخطيط مع options.layout وحده، والجذر يُوسَم بالتصميم — والقديم والحراري بلا مفتاح', () => {
  const plain = profile('page', 'page_branded', 'a4');
  assert.equal('layout' in lookFor(plain), false, 'ملفٌّ بلا تخطيط أخذ تخطيطاً');
  assert.equal('layout' in DEFAULT_PRINT_LOOK, false);
  const std = lookFor({ ...plain, options: { ...plain.options, layout: defaultPrintLayout('page') } });
  assert.equal(std.layout?.design, 'standard');
  assert.equal(lookRootAttrs(std)['data-print-layout'], 'standard');
  // ما عدا السمة: المظهر نفسه (الحشوة والأحادي ومقاس الـPDF وخانة الرمز)
  const { layout: _l, ...rest } = std;
  assert.deepEqual(rest, lookFor(plain));
  const imp = profile('impact', 'impact_plain', 'ff_a4');
  const grid = lookFor({ ...imp, options: { ...imp.options, layout: defaultPrintLayout('impact', 'grid_bilingual') } });
  assert.deepEqual(lookRootAttrs(grid), { ...lookRootAttrs(lookFor(imp)), 'data-print-layout': 'grid_bilingual' });
  assert.equal(grid.qrSlotPx, lookFor(imp).qrSlotPx, 'خانة رمز النقطية تغيّرت بالتصميم');
  assert.deepEqual(lookFor(legacyThermalProfile()), DEFAULT_PRINT_LOOK);
});

// ─── «التحرير الحرّ» (طلب المالك ٣ نوفمبر ٢٠٢٦): قاعدة القصّ الثانية ومرساة وسم النسخة ───

test('التحرير الحرّ: LAYOUT_FREE_BREAK_CSS ثابتٌ ثانٍ يُضاف لورقةٍ حرّة وحدها — وثيقة ورقة التخطيط العادية كما هي حرفاً', () => {
  const g = pagePrintGeom(legacyPageProfile());
  const std = '<div data-print-layout="standard"><div data-section="totals">A</div></div>';
  const doc = buildPageDocument([std], g, '');
  assert.ok(doc.includes(LAYOUT_BREAK_CSS) && !doc.includes(LAYOUT_FREE_BREAK_CSS), 'ورقة تخطيطٍ بلا مفاتيح حرّة أخذت القاعدة الثانية');
  assert.equal(LAYOUT_BREAK_CSS, '[data-print-layout] tr, [data-print-layout] [data-section="totals"], [data-print-layout] [data-section="signatures"] { break-inside: avoid; page-break-inside: avoid; }');
  for (const free of [
    '<div data-print-layout="standard" data-print-canvas="1"><div data-section="canvas-header" data-copy-anchor="">H</div></div>',
    '<div data-print-layout="grid_bilingual"><div data-sec="header" data-copy-anchor=""><div data-section="header">H</div></div></div>',
    '<div data-print-layout="standard"><div data-section="logo">L</div></div>',
    '<div data-print-layout="grid_bilingual"><div data-section="qr">Q</div></div>',
  ]) {
    const d = buildPageDocument([std, free], g, '');
    assert.ok(d.includes(`${LAYOUT_BREAK_CSS}\n    ${LAYOUT_FREE_BREAK_CSS}\n`), free);
    // بلا القاعدة الثانية: الوثيقة نفسها حرفاً
    assert.equal(d.replace(`\n    ${LAYOUT_FREE_BREAK_CSS}`, ''), buildPageDocument([std, free.replace(/data-(print-canvas|copy-anchor)=/g, 'data-x=').replace(/data-section="(logo|qr)"/g, 'data-x="$1"')], g, '')
      .replace(/data-x=""/g, 'data-copy-anchor=""').replace(/data-x="1"/g, 'data-print-canvas="1"').replace(/data-x="(logo|qr)"/g, 'data-section="$1"'));
  }
  // ورقةٌ بلا تخطيط (data-print-layout) لا تأخذ أيّاً من القاعدتين ولو حملت سمةً حرّة
  assert.ok(!buildPageDocument(['<div data-copy-anchor="">A</div>'], g, '').includes('break-inside'));
  for (const sel of ['[data-section^="canvas-"]', '[data-section="logo"]', '[data-section="qr"]']) assert.ok(LAYOUT_FREE_BREAK_CSS.includes(`[data-print-layout] ${sel}`), sel);
  assert.ok(!/zoom|filter/.test(LAYOUT_FREE_BREAK_CSS));
  assert.equal(freeSheetHtml('<div data-print-layout="standard"><div data-section="totals"></div></div>'), false);
});

/** عنصرٌ بسيط بلا DOM: أبناءٌ بوسم، وquerySelector على سمة المرساة وحدها (بعمق) */
interface FakeEl { tagName: string; anchor?: boolean; children: FakeEl[] }
const fake = (tagName: string, children: FakeEl[] = [], anchor = false): FakeEl => ({ tagName, children, anchor });
const asRoot = (el: FakeEl) => ({
  children: el.children as unknown as HTMLCollection,
  querySelector: ((sel: string) => {
    assert.equal(sel, '[data-copy-anchor]');
    const walk = (n: FakeEl): FakeEl | null => { for (const c of n.children) { if (c.anchor) return c; const d = walk(c); if (d) return d; } return null; };
    return walk(el) as unknown as Element | null;
  }) as ParentNode['querySelector'],
});

test('التحرير الحرّ: وسم النسخة بعد المرساة الصريحة (الرأس/لوحة الرأس) — وبلاها أوّل عنصرٍ ليس STYLE كاليوم', () => {
  const head = fake('DIV');
  const today = fake('DIV', [fake('STYLE'), head, fake('DIV')]);
  assert.equal(copyAnchorOf(asRoot(today)), head as unknown as Element, 'بلا مرساة: كاليوم');
  const logo = fake('DIV');
  const header = fake('DIV', [], true);
  const free = fake('DIV', [logo, header, fake('DIV')]);
  assert.equal(copyAnchorOf(asRoot(free)), header as unknown as Element, 'كتلة الشعار أعلى الورقة لا تأخذ الوسم');
  const band = fake('DIV', [], true);
  const nested = fake('DIV', [fake('DIV', [band]), fake('DIV', [], true)]);
  assert.equal(copyAnchorOf(asRoot(nested)), band as unknown as Element, 'أوّل مرساةٍ في ترتيب الوثيقة');
  assert.equal(copyAnchorOf(asRoot(fake('DIV', [fake('STYLE')]))), undefined);
  const src = fs.readFileSync(path.join(process.cwd(), 'src/rep/printPage.ts'), 'utf8');
  assert.ok(src.includes("if (label) copyAnchorOf(clone)?.insertAdjacentHTML('afterend', copyLabelHtml(label));"));
});
