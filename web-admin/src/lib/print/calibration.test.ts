// صفحة المعايرة والطباعة التجريبية («إعدادات الطباعة» M3، التصميم §5.1 E و§4.14): الرمز التجريبيّ بطول المختوم ويقول عن نفسه
// إنه تجربة، والعلامة «نموذج اختبار» على كل صفحة، والمسطرة بعرض الحزمة، وصفحاتٌ بطول مساحة الطباعة (المتصل ثلاث)، وخانة الرمز بنقاط
// qrPlan — والمستند التجريبيّ يمرّ بقرارٍ «بيئة محاكاة» ورمزه تجريبيّ لا رمز مرحلةٍ أولى.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import {
  CALIBRATION_ROLL_MM, DUMMY_QR_LENGTH, buildCalibrationDocument, calibrationLayout, calibrationPages, calibrationQr, dummyQrValue,
  sampleBannerHtml, sampleInvoiceDoc,
} from './calibration';
import {
  PAPER_PRESETS, PRINT_SAMPLE_WATERMARK, STAMPED_QR_CELLS, defaultPrintOptions, legacyPageProfile, legacyThermalProfile, presetPaper,
  type PaperPresetId, type PrintProfile, type PrinterType, type TemplateId,
} from './printSettings';
import { REHEARSAL_WATERMARK, zatcaPrintDecision } from '../zatca/docPrint';

const tr = (s: string) => s;
const profile = (printer: PrinterType, template: TemplateId, preset: PaperPresetId): PrintProfile => ({
  id: 'p-1', name: 'p', printer, template, paper: presetPaper(preset)!, options: defaultPrintOptions(printer),
});

test('الرمز التجريبيّ: بطول المختوم (~700) وخلاياه (النسخة 18) — ويقول لمن يمسحه إنه ليس فاتورة', () => {
  const v = dummyQrValue();
  assert.equal(v.length, DUMMY_QR_LENGTH);
  assert.ok(v.includes('not a tax invoice'));
  assert.equal(QRCode.create(v, { errorCorrectionLevel: 'L' }).modules.size, STAMPED_QR_CELLS.typical);
  assert.ok(!/^AQ|^AR/.test(v), 'لا يبدأ بوسم TLV الحقيقيّ');
});

test('خلية الرمز في المعايرة من qrPlan: 5 نقاط على MIP480 و4 على 80 مم — والعادية 0.5 مم', () => {
  const imp = calibrationQr(profile('impact', 'impact_plain', 'ff_a4'));
  assert.deepEqual([imp.dotsPerCell, imp.fits], [5, true]);
  assert.ok(Math.abs(imp.cellMm - 5 / (180 / 25.4)) < 1e-9);
  assert.equal(calibrationQr(profile('thermal', 'roll_compact', 'roll80')).dotsPerCell, 4);
  assert.deepEqual(calibrationQr(legacyPageProfile()), { cells: STAMPED_QR_CELLS.typical, dotsPerCell: null, cellMm: 0.5, fits: true });
});

test('وثيقة المعايرة للبلوتوث: الحزمة بعرضها بلا @page، والعلامة والمسطرة والشريط الأسود وأحجام الخط والرمز التجريبيّ', () => {
  const p = profile('thermal', 'roll_compact', 'roll80');
  const html = buildCalibrationDocument(p, tr, { mode: 'raster', name: 'PRO-V 80' });
  assert.ok(!html.includes('@page'), 'المُرمِّز يضع الهامش لا CSS');
  assert.ok(html.includes('body { width: 72mm; margin: 0 auto 0 0;'));
  assert.equal((html.match(/<section class="cal"/g) || []).length, 1);
  assert.ok(html.includes(PRINT_SAMPLE_WATERMARK));
  assert.ok(html.includes('PRO-V 80'));
  assert.equal((html.match(/<i style="left:/g) || []).length, 73, 'علامة لكل مم من 0 إلى 72');
  assert.ok(html.includes('.bar { height: 5mm; background: #000;'));
  for (const s of ['90%', '100%', '115%', '130%']) assert.ok(html.includes(`حجم الخط ${s}`), s);
  assert.ok(html.includes(`data-qr-value="${dummyQrValue()}" data-qr-ec="L"`));
  // خانة الرمز: (89 + 4) × 4 نقاط ÷ 8 نقاط/مم + سماح
  assert.ok(html.includes('width:46.9mm;height:46.9mm'), 'الخانة بمقاس الرمز ومنطقته الصامتة');
  assert.ok(html.includes('576 dots · 203 dpi'));
});

test('وثيقة المعايرة لنظام الطباعة: @page بمقاس الورق والحزمة في موضعها — والمتصل ثلاث صفحاتٍ بطول مساحة الطباعة ومسطرة عمودية', () => {
  const ff = profile('impact', 'impact_plain', 'ff_a4');
  assert.equal(calibrationPages(ff), 3);
  const html = buildCalibrationDocument(ff, tr, { mode: 'system', name: 'MIP480' });
  assert.ok(html.includes('@page { size: 210mm 297mm; margin: 5mm 0 5mm 0; }'));
  assert.ok(html.includes('body { width: 203.2mm; margin: 0 auto 0 3.4mm;'));
  assert.equal((html.match(/<section class="cal" data-cal="all" style="min-height:286.5mm">/g) || []).length, 3, '297 − 5 − 5 − 0.5');
  assert.ok(!/overflow: hidden/.test(html) && !html.includes('style="height:'), 'طولٌ أدنى لا ثابت: ما زاد يمدّ القسم ولا يُقصّ');
  assert.ok(html.includes('class="vruler"') && html.includes('نهاية مساحة الطباعة'));
  assert.ok(html.includes('1/3') && html.includes('3/3'));
  // الرول: طولٌ ثابت لـ@page، وصفحة واحدة بلا مسطرة عمودية
  const roll = buildCalibrationDocument(legacyThermalProfile(), tr, { mode: 'system', name: 'x' });
  assert.ok(roll.includes(`@page { size: 58mm ${CALIBRATION_ROLL_MM}mm; margin: 0; }`));
  assert.ok(!roll.includes('class="vruler"'));
  assert.equal(calibrationPages(legacyThermalProfile()), 1);
});

test('المعايرة تتسع لكل قسم: كل مقاسٍ نقطيّ جاهز وA4 الحراري بالرمز التلقائي والكبير — ونصف الصفحة ينقسم قسمين لا يُقصّ رمزه', () => {
  const impact = PAPER_PRESETS.filter((x) => x.printer === 'impact').map((x) => x.id);
  assert.deepEqual(impact, ['cut_a4', 'ff_a4', 'ff_95x11', 'ff_95x12', 'ff_85x11', 'ff_95x55']);
  const cases: Array<[PrinterType, TemplateId, PaperPresetId]> = [
    ...impact.map((id): [PrinterType, TemplateId, PaperPresetId] => ['impact', 'impact_plain', id]),
    ['thermal', 'roll_detailed', 'roll_a4'],
  ];
  for (const [printer, template, preset] of cases) {
    for (const qrSize of ['auto', 'large'] as const) {
      const p = profile(printer, template, preset);
      p.options.qrSize = qrSize;
      const at = `${preset}/${qrSize}`;
      const layout = calibrationLayout(p, tr, 'MIP480 الشاحنة');
      assert.ok(layout.bodyMm !== null, at);
      for (const sec of layout.sections) assert.ok(sec.mm <= (layout.bodyMm as number), `${at}: قسم ${sec.kind} ${sec.mm.toFixed(1)} > ${layout.bodyMm} مم`);
      for (const mode of ['system', 'raster'] as const) {
        const html = buildCalibrationDocument(p, tr, { mode, name: 'MIP480 الشاحنة' });
        const sections = html.match(/<section class="cal"[^>]*>/g) || [];
        assert.equal(sections.length, layout.sheets, at);
        assert.ok(sections.every((t) => t.includes(`style="min-height:${Math.round((layout.bodyMm as number) * 10) / 10}mm"`)), at);
        // لكل ورقةٍ علامة التجربة وخطّ نهايتها، والرمز التجريبيّ في كل ورقة رمز — ولا تُقصّ ولا ارتفاع ثابت
        assert.equal((html.match(/<div class="banner">/g) || []).length, layout.sheets, at);
        assert.equal((html.match(/<div class="end">/g) || []).length, layout.sheets, at);
        const qrSheets = Array.from({ length: layout.sheets }, (_, i) => layout.sections[i % layout.sections.length]).filter((x) => x.kind !== 'rulers').length;
        assert.equal((html.match(/class="qrslot"/g) || []).length, qrSheets, at);
        assert.ok(qrSheets >= 1, `${at}: الرمز يُطبع`);
        assert.ok(!html.includes('overflow: hidden'), at);
      }
    }
  }
  // نصف الصفحة المتصلة: قسمان (الرأس والمساطر وأحجام الخط، ثم الرمز وشرحه) على ثلاث أوراقٍ للانجراف
  for (const qrSize of ['auto', 'large'] as const) {
    const half = profile('impact', 'impact_plain', 'ff_95x55');
    half.options.qrSize = qrSize;
    const l = calibrationLayout(half, tr);
    assert.deepEqual(l.sections.map((x) => [x.kind, x.fonts]), [['rulers', true], ['qr', false]], qrSize);
    assert.equal(l.sheets, 3);
    const html = buildCalibrationDocument(half, tr, { mode: 'system', name: 'x' });
    assert.deepEqual((html.match(/data-cal="(\w+)"/g) || []), ['data-cal="rulers"', 'data-cal="qr"', 'data-cal="rulers"']);
    assert.ok(html.includes('1/3') && html.includes('3/3'));
  }
  // وورق A4 كامل: قسمٌ واحد كما كان
  assert.deepEqual(calibrationLayout(profile('impact', 'impact_plain', 'ff_a4'), tr).sections.map((x) => x.kind), ['all']);
  assert.deepEqual(calibrationLayout(profile('impact', 'impact_plain', 'cut_a4'), tr).sheets, 1);
  // وورقٌ مقطوعٌ قصير جداً (مخصّص): قسمان على ورقتين، وأحجام الخط تُترك إن ضاق القسم الأوّل عنها
  const tiny = profile('impact', 'impact_plain', 'cut_a4');
  tiny.paper = { ...tiny.paper, preset: 'custom', lengthMm: 80, marginTopMm: 0, marginBottomMm: 0 };
  const t = calibrationLayout(tiny, tr);
  assert.equal(t.sheets, 2);
  assert.deepEqual(t.sections.map((x) => [x.kind, x.fonts]), [['rulers', false], ['qr', false]]);
  assert.ok(!buildCalibrationDocument(tiny, tr, { mode: 'raster', name: 'x' }).includes('class="fonts"'));
  // الرول بلا حدّ: قسمٌ واحد بلا طول أدنى ولا خطّ نهاية
  const roll = calibrationLayout(profile('thermal', 'roll_compact', 'roll80'), tr);
  assert.deepEqual([roll.bodyMm, roll.sections.length, roll.sheets], [null, 1, 1]);
});

test('المستند التجريبيّ: قرار «بيئة محاكاة» برمزٍ تجريبيّ — علامة الهيئة المائية، ولا رمز مرحلةٍ أولى يُبنى', () => {
  const doc = sampleInvoiceDoc({ name: 'شركة', taxNumber: '311111111111113', countryCode: 'SA', printSettings: { x: 1 } }, tr, new Date('2026-10-23T10:00:00Z'));
  assert.equal(doc.zatca?.mode, 'rehearsal');
  assert.equal(doc.zatca?.qr, dummyQrValue());
  assert.equal(doc.company?.printSettings, undefined, 'لا تحمل إعدادات الطباعة');
  const d = zatcaPrintDecision({ isReturn: false, buyerHasTaxNumber: false, saudi: true }, doc.zatca);
  assert.deepEqual([d.qr.source, d.qr.value, d.watermark, d.canPrint], ['stamped', dummyQrValue(), REHEARSAL_WATERMARK, true]);
  assert.equal(doc.items.reduce((s, it) => s + it.lineTotal, 0), doc.total, 'البنود تساوي الإجمالي');
  assert.equal(doc.subtotal + doc.tax, doc.total);
  // شركةٌ بلا اسمٍ أو رقم: بدائل نموذجية
  assert.equal(sampleInvoiceDoc(null, tr).company?.taxNumber, '300000000000003');
  assert.ok(sampleBannerHtml('<x>').includes('&lt;x&gt;'));
});
