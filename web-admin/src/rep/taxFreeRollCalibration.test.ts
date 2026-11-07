/**
 * «إزالة الضريبة» في صفحة المعايرة والطباعة التجريبية (lib/print/calibration.ts) — طلب المالك ٧ نوفمبر ٢٠٢٦: لا ذكر للضريبة في أيّ
 * مستندٍ يخرج من طابعة الشركة، ومنه ورقتا الإعدادات:
 *
 * ١) صفحة المعايرة بـ`taxOff`: شريط «نموذج اختبار» وحده (لا «ليس مستندا ضريبيا»)، وعيّنة الخط «فاتورة»، ولا رمز تجريبيّ (حمولته
 *    «not a tax invoice» وتعليقه «ليس رمزا ضريبيا») — ولا قسم رمزٍ على الورق القصير.
 * ٢) المستند التجريبيّ لشركةٍ أزالت الضريبة مختومٌ بلا ضريبة: بلا رقمٍ ضريبيّ (ولا الوهميّ) ولا عرض المرحلة الثانية — ويمرّ بالشريط
 *    والقالب ثنائي اللغة بلا أيّ ذكرٍ للضريبة.
 * ٣) بلا العلم: الصفحة والمستند حرفاً كما اليوم (rasterBytes.baseline وcalibration.test لا يتغيّران).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildCalibrationDocument, calibrationLayout, sampleInvoiceDoc } from '../lib/print/calibration';
import {
  PRINT_SAMPLE_WATERMARK, defaultPrintOptions, presetPaper, withLayout, type PaperPresetId, type PrintProfile, type PrinterType, type TemplateId,
} from '../lib/print/printSettings';
import { TAX_FREE_SAMPLE_WATERMARK, firstTaxMention, sampleWatermarkFor } from '../lib/print/taxFreePrint';
import { printThermalInvoice } from './thermal';
import { GridInvoice } from './printGrid';
import { DEFAULT_PRINT_LOOK } from './printLook';
import { zatcaPrintDecision } from '../lib/zatca/docPrint';
import { makePrintTexts } from '../lib/print/printTexts';
import { DEFAULT_SECTIONS, type ResolvedLayout } from '../lib/print/layout';
import { isDocTaxFree } from '../lib/taxMode';
import type { Company } from './RepDocuments';

const tr = (s: string) => s;
const profile = (printer: PrinterType, template: TemplateId, preset: PaperPresetId): PrintProfile => ({
  id: 'p-1', name: 'p', printer, template, paper: presetPaper(preset)!, options: defaultPrintOptions(printer),
});
const PROFILES: readonly [PrinterType, TemplateId, PaperPresetId][] = [
  ['thermal', 'roll_compact', 'roll58'], ['thermal', 'roll_compact', 'roll80'], ['thermal', 'roll_detailed', 'roll112'],
  ['impact', 'impact_plain', 'ff_a4'], ['impact', 'impact_plain', 'ff_95x55'], ['impact', 'impact_plain', 'cut_a4'],
  ['page', 'page_branded', 'a4'], ['page', 'page_branded', 'a5'],
];
const SELLER_VAT = '311111111111113';
const offCompany: Company = { name: 'شركة', taxNumber: SELLER_VAT, countryCode: 'SA', taxDisabled: true, printSettings: { x: 1 } };

test('صفحة المعايرة بلا ضريبة: «نموذج اختبار» وحده و«فاتورة» ولا رمز تجريبيّ — في كل ورقٍ وطريقة', () => {
  for (const [printer, template, preset] of PROFILES) {
    const p = profile(printer, template, preset);
    for (const mode of ['system', 'raster'] as const) {
      const html = buildCalibrationDocument(p, tr, { mode, name: 'قالب السيارة', taxOff: true });
      const label = `${preset}/${mode}`;
      assert.equal(firstTaxMention(html), null, label);
      assert.ok(html.includes(`<div class="banner">${TAX_FREE_SAMPLE_WATERMARK}</div>`), `${label}: شريط «نموذج اختبار»`);
      assert.ok(!html.includes(PRINT_SAMPLE_WATERMARK), `${label}: «ليس مستندا ضريبيا»`);
      assert.ok(!html.includes('data-qr-value') && !html.includes('class="qrwrap"') && !html.includes('data-cal="qr"'), `${label}: رمز تجريبيّ`);
      assert.ok(html.includes('— فاتورة 0123456789'), `${label}: عيّنة الخط`);
      assert.ok(html.includes('class="ruler"') && html.includes('class="bar"'), `${label}: المسطرة والشريط الأسود باقيان`);
    }
    const l = calibrationLayout(p, tr, 'x', true);
    assert.ok(l.sections.every((s) => s.kind !== 'qr'), `${preset}: لا قسم رمز`);
    if (l.bodyMm !== null) for (const s of l.sections) assert.ok(s.mm <= l.bodyMm, `${preset}: القسم داخل طول الورقة`);
  }
});

test('صفحة المعايرة بلا العلم: حرفاً كما اليوم (taxOff غائب = false)', () => {
  for (const [printer, template, preset] of PROFILES) {
    const p = profile(printer, template, preset);
    for (const mode of ['system', 'raster'] as const) {
      const today = buildCalibrationDocument(p, tr, { mode, name: 'x' });
      assert.equal(buildCalibrationDocument(p, tr, { mode, name: 'x', taxOff: false }), today, `${preset}/${mode}`);
      assert.ok(today.includes(PRINT_SAMPLE_WATERMARK) && today.includes('فاتورة ضريبية مبسطة'), `${preset}/${mode}: اليوم`);
    }
    assert.deepEqual(calibrationLayout(p, tr, 'x', false), calibrationLayout(p, tr, 'x'), preset);
  }
  // والرمز المحذوف صراحةً مع العلم: الصفحة نفسها (الحذف والعلم يلتقيان)
  const p = profile('thermal', 'roll_compact', 'roll58');
  const noQr = withLayout(p, { sections: { qr: { visible: false } } });
  assert.equal(buildCalibrationDocument(noQr, tr, { mode: 'raster', name: 'x', taxOff: true }), buildCalibrationDocument(p, tr, { mode: 'raster', name: 'x', taxOff: true }));
});

test('sampleWatermarkFor: «نموذج اختبار» للشركة بلا ضريبة، وعبارة اليوم حرفاً لغيرها', () => {
  assert.equal(sampleWatermarkFor(true), 'نموذج اختبار');
  assert.equal(sampleWatermarkFor(false), PRINT_SAMPLE_WATERMARK);
  assert.equal(firstTaxMention(sampleWatermarkFor(true)), null);
});

test('المستند التجريبيّ لشركةٍ أزالت الضريبة: مختومٌ بلا ضريبة، بلا رقمٍ ضريبيّ ولا وهميّ، وبلا عرض المرحلة الثانية — والمبالغ كما هي', () => {
  const now = new Date('2026-11-07T08:00:00Z');
  for (const c of [offCompany, { ...offCompany, taxNumber: undefined }] as Company[]) {
    const d = sampleInvoiceDoc(c, tr, now);
    assert.equal(d.taxFree, true);
    assert.equal(d.zatca, null);
    assert.equal(d.company?.taxNumber, undefined);
    assert.equal(d.company?.printSettings, undefined);
    assert.equal(d.company?.name, 'شركة');
    assert.deepEqual([d.subtotal, d.discount, d.tax, d.total], [115, 0, 0, 115]);
    assert.ok(d.items.every((it) => it.taxPct === 0 && (it as { taxAmt?: number }).taxAmt === 0));
    assert.equal(d.items.reduce((s, it) => s + it.lineTotal, 0), d.total);
  }
  // بلا العلم: كاليوم حرفاً (الرقم الوهميّ والمحاكاة)
  const today = sampleInvoiceDoc({ ...offCompany, taxDisabled: false }, tr, now);
  assert.equal(today.taxFree, undefined);
  assert.equal(today.zatca?.mode, 'rehearsal');
  assert.equal(sampleInvoiceDoc({ name: 'x' }, tr, now).company?.taxNumber, '300000000000003');
  const absent = sampleInvoiceDoc({ ...offCompany, taxDisabled: undefined }, tr, now);
  assert.deepEqual({ ...absent, company: { ...absent.company, taxDisabled: false } }, today, 'العلم الغائب = false');
});

test('المستند التجريبيّ بلا ضريبة يمرّ بالشريط والقالب ثنائي اللغة بلا أيّ ذكرٍ للضريبة', async () => {
  const d = sampleInvoiceDoc(offCompany, tr, new Date('2026-11-07T08:00:00Z'));
  for (const [template, preset] of [['roll_compact', 'roll58'], ['roll_detailed', 'roll80']] as const) {
    let html = '';
    await printThermalInvoice(d, { profile: profile('thermal', template, preset), tr, capture: (h) => { html = h; } });
    assert.ok(html.length > 500, preset);
    assert.equal(firstTaxMention(html), null, `${template}/${preset}`);
    assert.ok(!html.includes(SELLER_VAT) && !html.includes('300000000000003') && !html.includes('data-qr-value'), preset);
  }
  const pt = makePrintTexts(null, tr);
  const zDecision = zatcaPrintDecision({ isReturn: false, saudi: true, taxFree: isDocTaxFree(d) }, d.zatca);
  const layout = { design: 'grid_bilingual', logo: 'center', logoSize: 'm', accent: null, tableStyle: 'grid', fontScale: 1, order: DEFAULT_SECTIONS.grid, printer: 'page' } as ResolvedLayout;
  const grid = renderToStaticMarkup(createElement(GridInvoice, {
    doc: d, look: DEFAULT_PRINT_LOOK, layout, qr: null,
    facts: { pt, zDecision, title: pt.title(zDecision.title, { isReturn: false, phase2: false }), inclusiveDoc: false, vatRate: '0%', noteRefs: { ref: null, reason: null } },
  }));
  assert.equal(firstTaxMention(grid), null, 'grid');
  assert.ok(!grid.includes(SELLER_VAT) && grid.includes('صنف تجريبي'), 'grid');
});
