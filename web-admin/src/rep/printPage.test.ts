// طباعة الصفحة والنقطية عبر نظام الطباعة («إعدادات الطباعة» M2، التصميم §3.2 و§1.5): مقاس @page لكل ورق، وحزمة MIP480 في
// منتصف A4 بعرض 8.0 بوصة، والنسخ الموسومة، ومظهر الطباعة (الافتراضي = اليوم حرفاً بحرف)، ومقاس صفحة الـPDF من جذر القالب.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATE_WIDTH_PX, buildPageDocument, copiesOf, copyLabelHtml, pagePrintGeom, pageRule, pageSizeOf } from './printPage';
import { DEFAULT_PRINT_LOOK, PRINT_LOOK_CSS, SHEET_WIDTH_PX, lookFor, lookNeedsCss, lookRootAttrs, pdfFormatOfPaper } from './printLook';
import { pdfPageOf } from './pdf';
import {
  PAGE_STAMPED_QR_PX, PAGE_TEMPLATE_WIDTH_PX, PAPER_PRESETS, PRINT_ISSUES, PRINT_LIMITS, STAMPED_QR_CELLS, checkPrintSettings,
  defaultPrintOptions, legacyPageProfile, legacyPrintSettings, legacyThermalProfile, pageQrImageMm, pageQrModuleMm, presetPaper,
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
  assert.ok(rep.includes(`<QrImage value={zDecision.qr.value} size={${PAGE_STAMPED_QR_PX}} ec="L" scale={4} />`));
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
