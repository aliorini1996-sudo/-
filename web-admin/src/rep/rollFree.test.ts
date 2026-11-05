/**
 * «التحرير الحرّ» على الرول (طلب المالك ٣ نوفمبر ٢٠٢٦ — pd_spec B.2/B.3/B.5/C.(iii)، الحزمة P6):
 *
 * ١) الشعار: حجمٌ بالملّيمتر (logoMm صندوقٌ أقصى: العرض والارتفاع ≤ logoMm، ولا يتجاوز عرض الحزمة)، ومحاذاة يمين/وسط/يسار،
 *    وكتلةٌ مستقلة أوّل الشريط أو بعد قسم (logoAfter) والرأس بلا شعار.
 * ٢) الأقسام: إظهار/إخفاء (الأصناف والرمز لا يُخفيان)، والمحاذاة، وحجم الخط بضرب البكسل (لا zoom)، والمسافة — في غلاف data-sec
 *    وأسلوبٍ مضمَّن، والقواعد في <style> ثانٍ لا يُكتب إلا على المسار الحرّ.
 * ٣) شكل الجدول على الحراري بالأسود وحده (شبكة/مخطط) — ولا تعبئة رمادية.
 * ٤) وسوم المصمّم data-pd مع markers وحدها، والطباعة الحقيقية بلا وسوم.
 * ٥) رمز المرحلة الثانية المختوم يُطبع في كل تحرير (صورةً لنظام الطباعة وخانةً للبلوتوث).
 * ٦) بلا مفاتيح حرّة: الوثيقة كما كانت حرفاً بحرف (والحارس الأكبر rollThermal.baseline + printLayout6.baseline).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { printThermalInvoice, printThermalReceipt, thermalPreviewHtml, type ThermalPrintOptions } from './thermal';
import type { Company, InvoiceDoc, ReceiptDoc } from './RepDocuments';
import { PRINT_WARNINGS, defaultPrintOptions, presetPaper, type PaperPresetId, type PrintOptions, type PrintProfile, type TemplateId } from '../lib/print/printSettings';
import { PrintRefusedError } from '../lib/print/printErrors';
import { DEFAULT_SECTIONS } from '../lib/print/layout';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const STAMPED = 'AQ' + 'Zm'.repeat(150) + 'x'.repeat(398);
const same = (s: string): string => s;
const norm = (s: string): string => s.replace(/data:image\/png;base64,[A-Za-z0-9+/=]{200,}/g, 'data:QR');

const company: Company = {
  name: 'شركة الاختبار', taxNumber: '300000000000003', address: 'الرياض حي العليا', phone: '0501234567', logo: PNG, countryCode: 'SA',
};
const ITEMS: InvoiceDoc['items'] = [
  { name: 'أرز', unit: 'كيس', qty: 4, unitPrice: 57.5, discountPct: 0, taxPct: 15, lineTotal: 230 },
  { name: 'زيت', unit: 'حبة', qty: 6, unitPrice: 12.25, discountPct: 0, taxPct: 15, lineTotal: 73.5 },
];
const inv = (over: Partial<InvoiceDoc> = {}): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-2048', date: '2026-10-23T10:30:00', type: 'CASH', company,
  customer: { name: 'مؤسسة الريان', taxNumber: '311111111111113' }, repName: 'أحمد', items: ITEMS,
  subtotal: 303.5, discount: 0, tax: 39.59, total: 303.5, pricesIncludeTax: true,
  recipientSignature: PNG, repSignature: PNG, ...over,
});
const p2 = (): InvoiceDoc => inv({
  number: 'INV-4096', zatca: {
    phase: 2, mode: 'live', mirror: 'cleared', documentStatus: 'CLEARED', subtype: '01', documentKind: 'INVOICE',
    qr: STAMPED, printable: true, overdue: false, reportDeadline: null, issuedAt: null,
    uuid: '3cf5ee18-ee25-44ea-a444-2c37ba7f28be', icv: 42, warnings: 0,
  } as NonNullable<InvoiceDoc['zatca']>,
});
const rcp = (): ReceiptDoc => ({
  kind: 'receipt', number: 'RC-77', date: '2026-10-23T11:05:00', company, customer: { name: 'بقالة النور' },
  repName: 'أحمد', amount: 137.05, paymentMethod: 'CASH', invoices: [{ number: 'INV-1024', amount: 137.05 }],
});

function prof(template: TemplateId, preset: PaperPresetId, layout?: Record<string, unknown>, o: Partial<PrintOptions> = {}): PrintProfile {
  const options = { ...defaultPrintOptions('thermal'), showLogo: true, ...o, ...(layout ? { layout } : {}) } as PrintOptions;
  return { id: 'van-1', name: 'سيارة', printer: 'thermal', template, paper: presetPaper(preset) as PrintProfile['paper'], options };
}
const L = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  design: 'standard', logo: 'center', logoSize: 'l', accent: null, tableStyle: 'lines', order: [...DEFAULT_SECTIONS.thermal], ...over,
});

async function roll(doc: InvoiceDoc | ReceiptDoc, profile: PrintProfile | null, raster = false): Promise<string> {
  let out = '';
  const opts: ThermalPrintOptions = { profile, tr: same };
  if (raster) opts.raster = async (html) => { out = html; };
  else opts.capture = (html) => { out = html; };
  if (doc.kind === 'invoice') await printThermalInvoice(doc, opts); else await printThermalReceipt(doc, opts);
  return norm(out);
}
/** جسم الوثيقة (النسخة الأولى) — بلا رأسها */
const bodyOf = (html: string): string => html.slice(html.indexOf('<body>'));
const freeCss = (html: string): string => /<style data-fs-free="">([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
const mmOf = (s: string, prop: string): number => Number(new RegExp(`${prop}:([\\d.]+)mm`).exec(s)?.[1] ?? NaN);
const logoTag = (html: string): string => /<div class="(?:c )?logo"[^>]*><img src="data:image\/png;base64,[^"]+" alt=""[^>]*\/><\/div>/.exec(html)?.[0] ?? '';

test('بلا مفاتيح حرّة: لا غلاف ولا وسم ولا <style> ثانٍ — وتخطيطٌ بستة مفاتيح كما كان', async () => {
  for (const tpl of ['roll_compact', 'roll_detailed'] as const) {
    for (const p of [prof(tpl, 'roll80'), prof(tpl, 'roll80', L()), prof(tpl, 'roll58', L({ logoSize: 's' }))]) {
      for (const doc of [inv(), p2(), rcp()]) {
        const html = await roll(doc, p);
        assert.ok(!html.includes('data-sec='), `${tpl}: غلاف قسم بلا تحرير حرّ`);
        assert.ok(!html.includes('data-pd='), `${tpl}: وسم مصمّم في طباعة حقيقية`);
        assert.ok(!html.includes('data-fs-free'), `${tpl}: <style> ثانٍ بلا تحرير حرّ`);
      }
    }
  }
});

test('الشعار logoMm: صندوقٌ أقصى بالملّيمتر (عرضاً وارتفاعاً) ولا يتجاوز عرض الحزمة — 58 و80', async () => {
  const at30 = logoTag(await roll(inv(), prof('roll_compact', 'roll80', L({ logoMm: 30 }))));
  assert.ok(at30, 'الشعار غاب');
  assert.equal(mmOf(at30, 'max-width'), 30);
  assert.equal(mmOf(at30, 'max-height'), 30);
  assert.ok(!/object-fit|zoom|filter/.test(at30), 'لا object-fit/zoom/filter في الوسم الجديد');
  // 120 مم على 58: لا يتجاوز الحزمة (48 مم) — وعلى 80: لا يتجاوز 72
  for (const [preset, band] of [['roll58', 48], ['roll80', 72]] as const) {
    const big = logoTag(await roll(inv(), prof(preset === 'roll58' ? 'roll_compact' : 'roll_detailed', preset, L({ logoMm: 120 }))));
    assert.ok(mmOf(big, 'max-width') <= band, `${preset}: العرض ${mmOf(big, 'max-width')} > ${band}`);
    assert.ok(mmOf(big, 'max-height') <= 120 && mmOf(big, 'max-height') <= band);
  }
  // logoMm يتقدّم على logoSize
  const s = logoTag(await roll(inv(), prof('roll_compact', 'roll80', L({ logoSize: 's', logoMm: 22.5 }))));
  assert.equal(mmOf(s, 'max-width'), 22.5);
  assert.ok(!s.includes('%'), 'نسبة logoSize بقيت مع logoMm');
});

test('محاذاة الشعار على الرول: البداية يمين الورقة (RTL) والنهاية يسارها والوسط بصنف اليوم', async () => {
  const start = logoTag(await roll(inv(), prof('roll_compact', 'roll80', L({ logo: 'start', logoMm: 20 }))));
  assert.match(start, /^<div class="logo" style="text-align:right">/);
  const end = logoTag(await roll(inv(), prof('roll_compact', 'roll80', L({ logo: 'end', logoMm: 20 }))));
  assert.match(end, /^<div class="logo" style="text-align:left">/);
  const center = logoTag(await roll(inv(), prof('roll_compact', 'roll80', L({ logo: 'center', logoMm: 20 }))));
  assert.match(center, /^<div class="c logo">/);
  // بلا شعار: لا صورة في أيّ مكان
  const none = await roll(inv(), prof('roll_compact', 'roll80', L({ logo: 'none', logoMm: 20, logoAfter: 'top' })));
  assert.equal(logoTag(none), '');
  // showLogo مطفأ يغلب
  assert.equal(logoTag(await roll(inv(), prof('roll_compact', 'roll80', L({ logoMm: 20, logoAfter: 'top' }), { showLogo: false }))), '');
});

test('كتلة الشعار المستقلة: أوّل الشريط أو بعد قسمه أو آخره — والرأس بلا شعار', async () => {
  const top = bodyOf(await roll(inv(), prof('roll_compact', 'roll80', L({ logoAfter: 'top', logoMm: 25 }))));
  const logoAt = top.indexOf('data-sec="logo"');
  assert.ok(logoAt > 0, 'لا كتلة شعار');
  assert.ok(logoAt < top.indexOf('data-sec="header"'), 'الكتلة ليست أوّل الشريط');
  assert.equal(top.match(/<div class="(?:c )?logo"/g)?.length, 1, 'الشعار مكرّر في الرأس');
  const afterTotals = bodyOf(await roll(inv(), prof('roll_detailed', 'roll80', L({ logoAfter: 'totals', logoMm: 25 }))));
  const tot = afterTotals.indexOf('data-sec="totals"');
  const lg = afterTotals.indexOf('data-sec="logo"');
  const sig = afterTotals.indexOf('data-sec="signatures"');
  assert.ok(tot > 0 && lg > tot && lg < sig, 'الكتلة ليست بعد الإجماليات مباشرة');
  const bottom = bodyOf(await roll(rcp(), prof('roll_compact', 'roll80', L({ logoAfter: 'footer', logoMm: 25 }))));
  assert.ok(bottom.indexOf('data-sec="logo"') > bottom.indexOf('data-sec="footer"'), 'السند: الكتلة ليست آخر الشريط');
  // قسمٌ مخفيّ: الكتلة في موضعه
  const hidden = bodyOf(await roll(inv(), prof('roll_compact', 'roll80', L({ logoAfter: 'customer', logoMm: 25, sections: { customer: { visible: false } } }))));
  assert.ok(!hidden.includes('data-sec="customer"'));
  assert.ok(hidden.indexOf('data-sec="logo"') > hidden.indexOf('data-sec="info"') && hidden.indexOf('data-sec="logo"') < hidden.indexOf('data-sec="items"'));
});

test('إخفاء الأقسام: المخفيّ يسقط كاملاً — والأصناف والرمز بإخفاء الشركة الصريح وحده (قرار المالك ٤ نوفمبر ٢٠٢٦)', async () => {
  // بلا إخفاءٍ صريح للأصناف والرمز: باقيان مهما أُخفي غيرهما
  const kept = await roll(p2(), prof('roll_compact', 'roll80', L({ sections: { customer: { visible: false }, footer: { visible: false } } })));
  assert.ok(!kept.includes('<span>العميل</span>'), 'العميل لم يُخفَ');
  assert.ok(!kept.includes('شكرا لتعاملكم معنا'), 'التذييل لم يُخفَ');
  assert.ok(kept.includes('class="iname"'), 'الأصناف أُخفيت بلا إخفاء');
  assert.match(kept, /<div class="qr"><img src="data:QR" width="168" height="168"\/><\/div>/, 'الرمز أُخفي بلا إخفاء');
  // إخفاءٌ صريح: الأصناف تسقط (والإجماليات باقية)، والرمز يسقط بسطري ICV/UUID وفاصله — في الطباعة والبلوتوث
  const p = prof('roll_compact', 'roll80', L({ sections: { customer: { visible: false }, footer: { visible: false }, items: { visible: false }, qr: { visible: false } } }));
  for (const raster of [false, true]) {
    const html = await roll(p2(), p, raster);
    assert.ok(!html.includes('class="iname"') && !html.includes('data-sec="items"'), `${raster}: الأصناف المخفيّة مطبوعة`);
    assert.ok(html.includes('data-sec="totals"'), `${raster}: الإجماليات سقطت`);
    assert.ok(!html.includes('class="qr"') && !html.includes('class="qrbox"') && !html.includes('data-qr-value'), `${raster}: الرمز المحذوف مطبوع`);
    assert.ok(!/ICV (42|٤٢)/.test(html) && !html.includes('data-sec="qr"'), `${raster}: قسم الرمز أو ICV باقٍ`);
  }
  // إخفاء الأصناف وحده لا يمسّ الرمز
  const noItems = await roll(p2(), prof('roll_compact', 'roll80', L({ sections: { items: { visible: false } } })));
  assert.match(noItems, /<div class="qrbox" style="--qr:[\d.]+mm"><div class="qr"><img src="data:QR"/);
  assert.ok(!noItems.includes('class="iname"'));
});

test('58 مم ضيّق بالمرحلة الثانية: الرمز المختوم يُرفض اليوم (qrNoFit) — والرمز المحذوف صراحةً يُطبع بلا رفضٍ ولا رمز', async () => {
  const narrow = (layout: Record<string, unknown>): PrintProfile => {
    const p = prof('roll_compact', 'roll58', layout);
    return { ...p, paper: { ...p.paper, printableDots: 256 } };
  };
  for (const raster of [false, true]) {
    await assert.rejects(roll(p2(), narrow(L({ sections: { header: { align: 'start' } } })), raster),
      (e: unknown) => e instanceof PrintRefusedError && e.message === PRINT_WARNINGS.qrNoFit, `${raster}: اليوم لا يُرفض`);
    const html = await roll(p2(), narrow(L({ sections: { qr: { visible: false } } })), raster);
    assert.ok(html.includes('class="iname"'), `${raster}: لم يُطبع`);
    assert.ok(!html.includes('class="qr"') && !html.includes('data-qr-value') && !/ICV (42|٤٢)/.test(html), `${raster}: رمزٌ محذوف مطبوع`);
  }
});

test('محاذاة القسم وحجم خطه ومسافته: قواعد مضمَّنة وفي <style> ثانٍ — بضرب البكسل لا zoom، والبداية يمين', async () => {
  const p = prof('roll_compact', 'roll80', L({ sections: {
    info: { align: 'start', spaceBeforeMm: 30, spaceAfterMm: 2.5 },
    totals: { fontPct: 160, align: 'end' },
    footer: { fontPct: 70, align: 'center' },
  } }));
  const html = await roll(inv(), p);
  const css = freeCss(html);
  assert.ok(css, '<style> الحرّ غائب');
  assert.match(css, /\[data-sec="info"\], \[data-sec="info"\] \.c:not\(\.logo\), \[data-sec="info"\] \.copy-label \{ text-align: right; \}/);
  assert.match(css, /\[data-sec="info"\] \.row \{ justify-content: flex-start; \}/);
  assert.match(css, /\[data-sec="totals"\] \.row \{ justify-content: flex-end; \}/);
  // 11 × 1.6 = 17.6، 14 × 1.6 = 22.4، 17 × 1.6 = 27.2، 10 × 1.6 = 16 — و70%: 7.7 / 7
  assert.match(css, /\[data-sec="totals"\] \{ font-size: 17\.6px; \}/);
  assert.match(css, /\[data-sec="totals"\] \.lg \{ font-size: 22\.4px; \}/);
  assert.match(css, /\[data-sec="totals"\] \.xl \{ font-size: 27\.2px; \}/);
  assert.match(css, /\[data-sec="totals"\] \.muted, \[data-sec="totals"\] \.copy-label \{ font-size: 16px; \}/);
  assert.match(css, /\[data-sec="footer"\] \{ font-size: 7\.7px; \}/);
  assert.ok(!/zoom|filter|object-fit|background/.test(css), 'zoom/filter/خلفية في القواعد الحرّة');
  // المسافة على غلاف القسم (أسلوبٌ مضمَّن)
  const wrap = /<div data-sec="info" style="([^"]*)">/.exec(html)?.[1] ?? '';
  assert.ok(/margin-top/.test(wrap), `لا مسافة قبل القسم: ${wrap}`);
  assert.ok(!/zoom|filter/.test(wrap));
  // fontScale القالب يُضرب أيضاً: 11 × 1.3 × 1.6 = 22.88
  const scaled = freeCss(await roll(inv(), prof('roll_compact', 'roll80', L({ sections: { totals: { fontPct: 160 } } }), { fontScale: 1.3 as PrintOptions['fontScale'] })));
  assert.match(scaled, /\[data-sec="totals"\] \{ font-size: 22\.88px; \}/);
  // قسمٌ بلا تنسيق في تخطيطٍ حرّ: غلافٌ بلا style
  assert.match(html, /<div data-sec="items">/);
});

test('شكل الجدول على الحراري: شبكة = خلايا/بند بإطار أسود، مخطط = خطٌّ منقّط بين البنود — بلا تعبئة رمادية', async () => {
  const gd = freeCss(await roll(inv(), prof('roll_detailed', 'roll80', L({ tableStyle: 'grid' }))));
  const gc = freeCss(await roll(inv(), prof('roll_compact', 'roll58', L({ tableStyle: 'grid' }))));
  const sd = freeCss(await roll(inv(), prof('roll_detailed', 'roll80', L({ tableStyle: 'striped' }))));
  const sc = freeCss(await roll(inv(), prof('roll_compact', 'roll80', L({ tableStyle: 'striped' }))));
  assert.ok(gd.includes('.t th, .t td { border: 1px solid #000; }'), gd);
  assert.ok(gc.includes('.item { border: 1px solid #000;'), gc);
  assert.ok(sd.includes('.t tbody tr + tr td { border-top: 1px dotted #000; }'), sd);
  assert.ok(sc.includes('.item + .item { border-top: 1px dotted #000;'), sc);
  for (const css of [gd, gc, sd, sc]) {
    assert.ok(!/background|#[0-9a-f]{3,6}(?<!#000)\b/i.test(css.replace(/#000\b/g, '')), `لونٌ غير الأسود: ${css}`);
  }
});

test('وسوم المصمّم: data-pd لكل قسمٍ ظاهر وللشعار مع markers وحدها — وبلاها المعاينة كما كانت', async () => {
  for (const p of [prof('roll_compact', 'roll80'), prof('roll_detailed', 'roll80', L()), prof('roll_compact', 'roll58', L({ logoMm: 20, logoAfter: 'items' }))]) {
    const plain = await thermalPreviewHtml(p2(), { tr: same, paperMm: 80, profile: p });
    assert.ok(!plain.includes('data-pd='), 'وسمٌ بلا markers');
    const marked = await thermalPreviewHtml(p2(), { tr: same, paperMm: 80, profile: p, markers: true });
    for (const id of DEFAULT_SECTIONS.thermal) assert.ok(marked.includes(`data-pd="${id}"`), `${id}: لا وسم`);
    assert.ok(marked.includes('data-pd="logo"'), 'الشعار بلا وسم');
    // الوسوم أغلفةٌ لا تغيّر المحتوى: النصّ نفسه، ولا أسلوب على غلافٍ بلا تحرير حرّ
    assert.equal(marked.replace(/<[^>]*>/g, '').replace(/\s+/g, ''), plain.replace(/<[^>]*>/g, '').replace(/\s+/g, ''), 'النصّ تغيّر بالوسوم');
    if (!p.options.layout || !('logoMm' in (p.options.layout as object))) assert.ok(!/<div data-sec="[a-z]+" data-pd="[a-z]+" style=/.test(marked));
  }
  // السند أيضاً
  const r = await thermalPreviewHtml(rcp(), { tr: same, paperMm: 80, profile: prof('roll_compact', 'roll80'), markers: true });
  for (const id of ['header', 'info', 'customer', 'totals', 'footer']) assert.ok(r.includes(`data-pd="${id}"`), `السند ${id}`);
});

test('الرأس المخفيّ لا يُسقط سطر «الأصل/نسخة» — موضعه أوّل كل نسخة', async () => {
  const p = prof('roll_compact', 'roll80', L({ sections: { header: { visible: false } } }), { copies: 2, copyLabels: true });
  const html = await roll(inv(), p);
  assert.ok(!html.includes('class="c b lg"'), 'الرأس لم يُخفَ');
  assert.equal(html.match(/<div class="copy-label">الأصل<\/div>/g)?.length, 1);
  assert.equal(html.match(/<div class="copy-label">نسخة<\/div>/g)?.length, 1);
});

test('رمز المرحلة الثانية في أقصى تحرير: شعار 120 مم وخط 160% ومسافة 30 مم وكل قسمٍ منقول ومخفيّ (إلا الرمز والأصناف) — صورةً وخانةً', async () => {
  // قرار المالك ٤ نوفمبر ٢٠٢٦: إخفاء الرمز أو الأصناف حذفٌ صريح لهما — فأقصى تحريرٍ «لا يحذفهما» يُبقيهما ظاهرين بأقصى تنسيق
  const sections = Object.fromEntries(DEFAULT_SECTIONS.thermal.map((id) => [id, {
    fontPct: 160, spaceBeforeMm: 30, spaceAfterMm: 30, align: 'end', ...(id === 'qr' || id === 'items' ? {} : { visible: false }),
  }]));
  const order = ['header', 'qr', 'items', 'totals', 'customer', 'info', 'signatures', 'footer'];
  for (const [tpl, preset] of [['roll_compact', 'roll58'], ['roll_compact', 'roll80'], ['roll_detailed', 'roll80']] as const) {
    const p = prof(tpl, preset, L({ order, logo: 'end', logoMm: 120, logoAfter: 'qr', tableStyle: 'grid', sections }));
    const sys = await roll(p2(), p);
    assert.match(sys, /<div class="qrbox" style="--qr:[\d.]+mm"><div class="qr"><img src="data:QR" width="168" height="168"\/><\/div><\/div>/, `${tpl}/${preset}: الرمز سقط`);
    assert.match(sys, /ICV (42|٤٢)/);
    assert.ok(sys.includes('class="iname"') || sys.includes('<table class="t">'), 'الأصناف سقطت');
    const bt = await roll(p2(), p, true);
    assert.ok(bt.includes(`data-qr-value="${STAMPED}"`), `${tpl}/${preset}: خانة البلوتوث سقطت`);
    // الحزمة بعرضها الفعليّ (384 نقطة = 48 مم، 576 = 72 مم) والشعار لا يتجاوزها
    const band = preset === 'roll58' ? 48 : 72;
    assert.ok(bt.includes(`body { width: ${band}mm;`), `${preset}: عرض الحزمة تغيّر`);
    const lg = logoTag(bt);
    assert.ok(lg && mmOf(lg, 'max-height') <= 120 && mmOf(lg, 'max-width') <= band, `الشعار: ${lg.slice(0, 40)}…`);
    assert.ok(!/zoom/.test(freeCss(bt)));
    // والأقصى نفسه مع حذف الرمز الصريح: لا رمز ولا خانة ولا ICV، بلا رفض
    const gone = { ...sections, qr: { ...sections.qr, visible: false } };
    for (const raster of [false, true]) {
      const h = await roll(p2(), prof(tpl, preset, L({ order, logo: 'end', logoMm: 120, logoAfter: 'qr', tableStyle: 'grid', sections: gone })), raster);
      assert.ok(!h.includes('class="qr"') && !h.includes('data-qr-value') && !/ICV (42|٤٢)/.test(h), `${tpl}/${preset}/${raster}: رمزٌ محذوف مطبوع`);
      assert.ok(h.includes('data-sec="logo"'), `${tpl}/${preset}: كتلة الشعار بعد قسمٍ محذوف سقطت`);
    }
  }
});

test('نسخة الشريط الكلاسيكي القابلة للتحرير (roll_compact على 58 مم بتخطيط البداية) تُطبع بالمختصر على 58 — والتحرير يسري', async () => {
  const starter = L({ logo: 'none', logoSize: 'm' });
  const copy = prof('roll_compact', 'roll58', starter);
  const html = await roll(inv(), copy);
  assert.ok(html.includes('body { width: 48mm;'), 'ليست حزمة 58');
  assert.ok(!html.includes('58mm auto'), 'طُبعت بالكلاسيكي');
  assert.equal(logoTag(html), '', 'الشعار ظهر في تخطيط البداية');
  const edited = await roll(inv(), prof('roll_compact', 'roll58', { ...starter, logo: 'center', logoMm: 30, sections: { header: { align: 'start' } } }));
  assert.equal(mmOf(logoTag(edited), 'max-width'), 30);
  assert.ok(freeCss(edited).includes('[data-sec="header"]'));
});

test('الرول بستة مفاتيح موسَّعة (B.1): الشعار يمين/يسار بحجم اليوم بلا مفتاحٍ حرّ — ولا غلاف أقسام', async () => {
  const start = await roll(inv(), prof('roll_compact', 'roll80', L({ logo: 'start' })));
  assert.ok(start.includes(`<div class="logo" style="text-align:right"><img src="${PNG}" alt=""/></div>`), logoTag(start));
  const endS = await roll(inv(), prof('roll_compact', 'roll80', L({ logo: 'end', logoSize: 's' })));
  assert.ok(endS.includes(`<div class="logo" style="text-align:left"><img src="${PNG}" alt="" style="max-width:36%;max-height:9.6mm"/></div>`), logoTag(endS));
  assert.ok(!start.includes('data-sec='));
});
