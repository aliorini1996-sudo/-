// «نموذج الشركة المطبوع مسبقاً» على النقطية (طلب المالك ١٣ نوفمبر ٢٠٢٦، SPEC §5.1): خانة رمز QR في مظهر القالب = ضلع حقل الرمز
// ببكسل CSS (formQrSlotPx) — لا خانة النقطية العامة 269 بكسل (≈ 71 مم) التي كانت تفيض عن الحقل فيمسح الرسم ما حوله. وغير النموذج كما كان.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CSS_PX_PER_MM, formQrSlotPx, impactQrSlotPx, lookFor, qrSlotStyle } from './printLook';
import {
  FORM_IMPACT_QR_MIN_MM, defaultPrintOptions, presetPaper, withDesign,
  type PaperPresetId, type PrintForm, type PrintProfile, type PrinterType, type TemplateId,
} from '../lib/print/printSettings';

const profile = (printer: PrinterType, template: TemplateId, preset: PaperPresetId): PrintProfile => ({
  id: 'p-form', name: 'p', printer, template, paper: presetPaper(preset)!, options: defaultPrintOptions(printer),
});
const IMPACT_PRESETS: PaperPresetId[] = ['ff_a4', 'cut_a4', 'ff_95x11', 'ff_95x12', 'ff_85x11', 'ff_95x55'];
/** القالب بنموذجٍ معدَّل الحقول */
const withFields = (p: PrintProfile, fields: (f: PrintForm['fields']) => PrintForm['fields']): PrintProfile => {
  const l = p.options.layout!;
  return { ...p, options: { ...p.options, layout: { ...l, form: { ...l.form!, fields: fields(l.form!.fields) } } } };
};

test('CSS_PX_PER_MM = 96 ÷ 25.4، وformQrSlotPx = min(w, h) بالبكسل بلا تقريب — وnull بلا حقل رمز أو بضلعٍ غير صالح', () => {
  assert.equal(CSS_PX_PER_MM, 96 / 25.4);
  const f = (w: number, h: number) => ({ fields: [{ id: 'docNumber' as const, x: 10, y: 10, w: 40, h: 6 }, { id: 'qr' as const, x: 12, y: 226, w, h }] });
  assert.equal(formQrSlotPx(f(55, 55)), 55 * CSS_PX_PER_MM);
  assert.ok(Math.abs((formQrSlotPx(f(55, 55)) as number) - (55 * 96) / 25.4) < 1e-9, '≈ 207.874 بكسل');
  assert.equal(formQrSlotPx(f(60, 55.5)), 55.5 * CSS_PX_PER_MM, 'الضلع الأصغر');
  assert.equal(formQrSlotPx({ fields: [{ id: 'docNumber', x: 10, y: 10, w: 40, h: 6 }] }), null);
  assert.equal(formQrSlotPx(f(0, 55)), null);
  assert.equal(formQrSlotPx(f(Number.NaN, 55)), null);
  assert.equal(formQrSlotPx(null), null);
  assert.equal(formQrSlotPx(undefined), null);
});

test('lookFor: نموذج الشركة على كل ورق النقطية ⇒ الخانة بمقاس حقل الرمز (55 مم في البداية المقترحة) — والتخطيط بـformReach', () => {
  for (const preset of IMPACT_PRESETS) {
    const p = withDesign(profile('impact', 'impact_plain', preset), 'preprinted');
    const look = lookFor(p);
    assert.equal(look.layout?.design, 'preprinted', preset);
    assert.ok(look.layout?.formReach, `${preset}: formReach`);
    const qr = look.layout?.form?.fields.find((x) => x.id === 'qr');
    assert.ok(qr, `${preset}: حقل الرمز في البداية المقترحة`);
    assert.ok(Math.min(qr.w, qr.h) >= FORM_IMPACT_QR_MIN_MM, `${preset}: ضلع الرمز ≥ 55 مم`);
    assert.equal(look.qrSlotPx, Math.min(qr.w, qr.h) * CSS_PX_PER_MM, preset);
    assert.ok((look.qrSlotPx as number) < (impactQrSlotPx(p) as number), `${preset}: أصغر من خانة النقطية العامة (لا تفيض عن الحقل)`);
    assert.deepEqual(qrSlotStyle(look), {
      width: look.qrSlotPx, height: look.qrSlotPx, padding: 0, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center',
    });
  }
  const a4 = lookFor(withDesign(profile('impact', 'impact_plain', 'ff_a4'), 'preprinted'));
  assert.ok(Math.abs((a4.qrSlotPx as number) - (55 * 96) / 25.4) < 1e-9, 'A4: 55 مم = 207.874 بكسل');
  // حقلٌ أكبر يكبر معه، وبلا حقل رمز لا خانة (FormInvoice لا يطبع الرمز بلا حقله)
  const big = withFields(withDesign(profile('impact', 'impact_plain', 'cut_a4'), 'preprinted'), (fs) => fs.map((x) => (x.id === 'qr' ? { ...x, w: 60, h: 62 } : x)));
  assert.equal(lookFor(big).qrSlotPx, 60 * CSS_PX_PER_MM);
  const none = withFields(withDesign(profile('impact', 'impact_plain', 'cut_a4'), 'preprinted'), (fs) => fs.filter((x) => x.id !== 'qr'));
  assert.equal(lookFor(none).layout?.design, 'preprinted');
  assert.equal(lookFor(none).qrSlotPx, null);
});

test('lookFor: غير النموذج كما كان — النقطية القياسية وثنائية اللغة 269 بكسل، والعادية بنموذجٍ أو بلا نموذج بلا خانة', () => {
  const imp = profile('impact', 'impact_plain', 'ff_a4');
  assert.equal(lookFor(imp).qrSlotPx, 269);
  assert.equal(lookFor(imp).qrSlotPx, impactQrSlotPx(imp));
  assert.equal(lookFor(profile('impact', 'impact_preprinted', 'cut_a4')).qrSlotPx, impactQrSlotPx(profile('impact', 'impact_preprinted', 'cut_a4')), 'قالب «على ورق بترويسة مطبوعة» القديم');
  const grid = withDesign(imp, 'grid_bilingual');
  assert.equal(lookFor(grid).layout?.design, 'grid_bilingual');
  assert.equal(lookFor(grid).qrSlotPx, 269);
  const page = withDesign(profile('page', 'page_branded', 'a4'), 'preprinted');
  assert.equal(lookFor(page).layout?.design, 'preprinted');
  assert.equal(lookFor(page).layout?.formReach, undefined, 'العادية بلا formReach');
  assert.equal(lookFor(page).qrSlotPx, null, 'العادية: صندوق اليوم');
  assert.deepEqual(qrSlotStyle(lookFor(page)), {});
});
