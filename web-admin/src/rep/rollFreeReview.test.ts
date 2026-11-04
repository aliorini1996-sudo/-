/**
 * مراجعة «التحرير الحرّ» على الرول طرفاً لطرف (pd_spec B.3/B.6/E.7): ثلاثة عيوب ظهرت حين رُسمت الوثائق في متصفحٍ حقيقيّ
 * والتُقطت بـhtml2canvas بعرض الحزمة (384/576 نقطة):
 *
 * ١) الخط المكبَّر (fontPct > 100) يدفع صفّ «تسمية | قيمة» وجدول المفصّل خارج الحزمة (حتى ~180 بكسل على 80 مم بخط 160٪)،
 *    والالتقاط بحدود الحزمة فيضيع الرقم من الورق — فالصفّ ينزل سطراً والخلايا تنكسر، على المسار الحرّ وحده.
 * ٢) محاذاة قسم الرمز كانت تحرّك ICV/UUID وحدهما والرمز في الوسط — فالرمز (صورةً وخانةً) يتبع محاذاة قسمه.
 * ٣) قسمٌ فارغ في هذا المستند (تواقيع لم تُجمع) كان يأخذ مسافته فيترك بياضاً على الورق — فلا غلاف له في الطباعة، وفي
 *    المصمّم غلافٌ بلا أسلوب.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { printThermalInvoice, thermalPreviewHtml, type ThermalPrintOptions } from './thermal';
import type { Company, InvoiceDoc } from './RepDocuments';
import { defaultPrintOptions, presetPaper, type PaperPresetId, type PrintOptions, type PrintProfile, type TemplateId } from '../lib/print/printSettings';
import { DEFAULT_SECTIONS } from '../lib/print/layout';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const STAMPED = 'AQ' + 'Zm'.repeat(150) + 'x'.repeat(398);
const company: Company = { name: 'شركة الاختبار', taxNumber: '300000000000003', address: 'الرياض', phone: '0501234567', logo: PNG, countryCode: 'SA' };
const inv = (over: Partial<InvoiceDoc> = {}): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-4096', date: '2026-10-23T10:30:00', type: 'CASH', company,
  customer: { name: 'مؤسسة الريان', taxNumber: '311111111111113' }, repName: 'أحمد',
  items: [{ name: 'أرز', unit: 'كيس', qty: 4, unitPrice: 1257.5, discountPct: 0, taxPct: 15, lineTotal: 5030 }],
  subtotal: 5030, discount: 0, tax: 656.09, total: 5030, pricesIncludeTax: true,
  zatca: {
    phase: 2, mode: 'live', mirror: 'cleared', documentStatus: 'CLEARED', subtype: '01', documentKind: 'INVOICE',
    qr: STAMPED, printable: true, overdue: false, reportDeadline: null, issuedAt: null,
    uuid: '3cf5ee18-ee25-44ea-a444-2c37ba7f28be', icv: 42, warnings: 0,
  } as NonNullable<InvoiceDoc['zatca']>,
  ...over,
});
function prof(template: TemplateId, preset: PaperPresetId, layout: Record<string, unknown>): PrintProfile {
  const options = { ...defaultPrintOptions('thermal'), showLogo: true, layout: layout as unknown as PrintOptions['layout'] } as PrintOptions;
  return { id: 'van-1', name: 'سيارة', printer: 'thermal', template, paper: presetPaper(preset) as PrintProfile['paper'], options };
}
const L = (over: Record<string, unknown>): Record<string, unknown> => ({
  design: 'standard', logo: 'center', logoSize: 'm', accent: null, tableStyle: 'lines', order: [...DEFAULT_SECTIONS.thermal], ...over,
});
async function roll(doc: InvoiceDoc, profile: PrintProfile, raster = false): Promise<string> {
  let out = '';
  const opts: ThermalPrintOptions = { profile, tr: (s) => s };
  if (raster) opts.raster = async (html) => { out = html; };
  else opts.capture = (html) => { out = html; };
  await printThermalInvoice(doc, opts);
  return out;
}
const freeCss = (html: string): string => /<style data-fs-free="">([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';

test('الخط المكبَّر لا يخرج عن الحزمة: الصفّ ينزل سطراً والخلايا تنكسر لقسمه وحده — وبخطٍّ 100٪ أو أصغر لا قاعدة', async () => {
  for (const [tpl, preset] of [['roll_compact', 'roll58'], ['roll_detailed', 'roll80']] as const) {
    const css = freeCss(await roll(inv(), prof(tpl, preset, L({ sections: { customer: { fontPct: 160 }, items: { fontPct: 130 }, totals: { fontPct: 90 } } }))));
    // جدول المفصّل لا يكبر (rollTableFit.test.ts) — فلا قاعدة التفافٍ لأصنافه
    for (const id of tpl === 'roll_detailed' ? ['customer'] : ['customer', 'items']) {
      assert.ok(css.includes(`[data-sec="${id}"] .row { flex-wrap: wrap; }`), `${tpl}/${id}: الصفّ لا ينزل سطراً`);
      assert.ok(css.includes(`[data-sec="${id}"] .row > span, [data-sec="${id}"] .iname { overflow-wrap: anywhere; }`), `${tpl}/${id}: الرقم الأعرض من السطر لا ينكسر`);
    }
    assert.ok(!css.includes('[data-sec="totals"] .row { flex-wrap'), 'خطٌّ أصغر أخذ قاعدة الالتفاف');
    assert.ok(!css.includes('[data-sec="header"] .row { flex-wrap'), 'قسمٌ بلا تكبير أخذ قاعدة الالتفاف');
    assert.ok(!/zoom|filter|word-break:\s*break-all/.test(css), 'لا zoom ولا filter ولا break-all (يقطّع وصل الحروف العربية في html2canvas)');
  }
});

test('محاذاة قسم الرمز تحرّك الرمز نفسه: الصورة بـtext-align وخانة البلوتوث بهامشها — والوسط كما كان', async () => {
  for (const [align, phys, margin] of [['start', 'right', '0 0 0 auto'], ['end', 'left', '0 auto 0 0'], ['center', 'center', '0 auto']] as const) {
    const p = prof('roll_compact', 'roll80', L({ sections: { qr: { align } } }));
    const sys = await roll(inv(), p);
    assert.ok(freeCss(sys).includes(`[data-sec="qr"] .qr { text-align: ${phys}; }`), `${align}: صورة الرمز لم تتبع القسم`);
    assert.match(sys, /<div class="qrbox" style="--qr:[\d.]+mm"><div class="qr"><img src="data:image\/png;base64,/, 'الرمز سقط');
    const bt = await roll(inv(), p, true);
    assert.ok(freeCss(bt).includes(`[data-sec="qr"] .qrslot { margin: ${margin}; }`), `${align}: خانة البلوتوث لم تتبع القسم`);
    assert.ok(bt.includes(`data-qr-value="${STAMPED}"`), 'خانة الرمز سقطت');
  }
  // بلا محاذاةٍ للرمز: لا قاعدة له (الوسط من أسلوب الوثيقة كاليوم)
  const none = freeCss(await roll(inv(), prof('roll_compact', 'roll80', L({ sections: { header: { align: 'start' } } }))));
  assert.ok(!none.includes('.qrslot'));
});

test('قسمٌ فارغ في هذا المستند لا يترك بياضاً: لا غلاف ولا مسافة في الطباعة — وفي المصمّم غلافٌ بلا أسلوب', async () => {
  const p = prof('roll_compact', 'roll80', L({ sections: { signatures: { spaceBeforeMm: 12, spaceAfterMm: 8 }, info: { spaceBeforeMm: 3 } } }));
  const doc = inv({ recipientSignature: undefined, repSignature: undefined });
  for (const raster of [false, true]) {
    const html = await roll(doc, p, raster);
    assert.ok(!html.includes('data-sec="signatures"'), 'قسم التواقيع الفارغ أخذ غلافاً');
    assert.ok(!html.includes('margin-top:12mm'), 'مسافة القسم الفارغ طُبعت');
    assert.ok(html.includes('<div data-sec="info" style="margin-top:3mm">'), 'قسمٌ ذو محتوى فقد مسافته');
  }
  // مع تواقيع: الغلاف ومسافته كما حُفظت
  const signed = await roll(inv({ recipientSignature: PNG }), p);
  assert.ok(signed.includes('<div data-sec="signatures" style="margin-top:12mm;margin-bottom:8mm">'), 'قسم التواقيع فقد مسافته');
  // المصمّم: مقبضٌ للقسم الفارغ بلا مسافة — فالمعاينة كالطباعة
  const pv = await thermalPreviewHtml(doc, { tr: (s) => s, paperMm: 80, profile: p, markers: true });
  assert.match(pv, /<div data-sec="signatures" data-pd="signatures">\s*<\/div>/, 'المصمّم فقد مقبض القسم الفارغ أو أخذ مسافته');
});
