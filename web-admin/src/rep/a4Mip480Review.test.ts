/**
 * المراجعة الثانية لـA4 + النقطية MIP480 + PDF في «التحرير الحرّ» (طلب المالك ٣ نوفمبر ٢٠٢٦) — كل عيبٍ باختبارٍ يفشل قبل إصلاحه:
 * ١) النقطية: صفحةٌ لا تجد صفاً أبيض قبل حدّها كانت تقطع عند أوّل مدىً محفوظٍ في القائمة — صفوف الرمز تسبق اللوحات، فلوحة تذييلٍ
 *    فيها مربع QR يعبر الحدّ كانت تُقطع من أعلى الرمز (الإجماليات فوقه في صفحة والرمز في التالية). الآن: أعلى مدىً عابر.
 * ٢) مربع QR في لوحة بارتفاعٍ يتّسع لسطرٍ تحت الرمز: التعليق وسطر ICV/UUID (سطران أو ثلاثة بخطّ Kufi) كانا يفيضان أسفل المربع
 *    (٥١ بكسل في Chrome بمربع 50.5×58.5 مم) فيعلوان على أول قسمٍ سارٍ بعد لوحة الرأس — الآن محصوران في المتبقّي تحت الخانة.
 * ٣) المصمّم يقيس الفيض على مستند المعاينة وحده (نقدية بلا خصم، سندٌ لفاتورة واحدة): مربعٌ مضبوطٌ عليه يقصّ في فاتورةٍ آجلة بخصم
 *    «الإجمالي النهائي» و«المدفوع/المتبقي» (+١١١ بكسل في Chrome)، وفي الإشعار الدائن مرجعه وسببه الإلزاميين، وفي سندٍ لعدّة فواتير
 *    أرقامها — بلا أي تنبيه. الآن يُرسم مستندٌ «أطول ما يحمله كل مربع» مخفيّاً ويُضمّ فيضه إلى الشارة.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintableInvoice, PrintableReceipt, type Company, type InvoiceDoc, type ReceiptDoc } from './RepDocuments';
import { PrintLookContext, lookFor, type PrintLook } from './printLook';
import { createBitmap, fillRect, paginate, splitPages, type Bitmap } from '../lib/print/raster';
import { defaultPrintLayout, defaultPrintOptions, presetPaper, type PrintLayout, type PrintProfile, type PrinterType, type TemplateId } from '../lib/print/printSettings';
import type { ZatcaDocView } from '../lib/zatca/docStatus';
import { useLang } from '../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';

process.env.TZ = 'Asia/Riyadh';
useLang.setState({ lang: 'ar' });
setActiveNumerals('latin');
setActiveCurrency('SAR');

const STAMPED = 'AQ/YtNix2YPYqSDYp9mE2KfYrtiq2KjYp9ixAg8zMDAwMDAwMDAwMDAwMDMDFDIwMjYtMTEtMDJUMDk6MTU6MDBa';
const COMPANY: Company = {
  name: 'شركة الاختبار للتوزيع', address: 'الرياض', taxNumber: '300000000000003', commercialReg: '1010101010',
  phone: '0501234567', email: 'info@example.sa', logo: null, primaryColor: '#1e3a8a', headerStyle: null, countryCode: 'SA',
};
const inv = (over: Partial<InvoiceDoc> = {}): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-1', date: '2026-11-02T09:15:00.000Z', type: 'CASH', company: COMPANY,
  customer: { name: 'محمد', businessName: 'مؤسسة الأفق', taxNumber: '311111111111113' }, repName: 'أحمد',
  items: [{ name: 'مياه', unit: 'كرتون', qty: 2, unitPrice: 23, discountPct: 0, taxPct: 15, lineTotal: 46 }],
  subtotal: 46, discount: 0, tax: 6, total: 46, pricesIncludeTax: true, ...over,
});
const zv = (over: Partial<ZatcaDocView> = {}): ZatcaDocView => ({
  phase: 2, mode: 'live', mirror: 'cleared', documentStatus: 'CLEARED', subtype: '01', documentKind: 'INVOICE', qr: STAMPED, printable: true,
  overdue: false, reportDeadline: null, issuedAt: '2026-11-02T09:15:00.000Z', uuid: '3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c', icv: 41, warnings: 0, ...over,
});
const rcp = (over: Partial<ReceiptDoc> = {}): ReceiptDoc => ({
  kind: 'receipt', number: 'RC-55', date: '2026-11-02T11:00:00.000Z', company: COMPANY, customer: { name: 'بقالة النور' },
  repName: 'أحمد', amount: 150, paymentMethod: 'CASH', invoices: [{ number: 'INV-1', amount: 150 }], ...over,
});
const lookOf = (layout: Partial<PrintLayout>, printer: PrinterType = 'page', template: TemplateId = 'page_branded'): PrintLook => {
  const p: PrintProfile = {
    id: 'p-1', name: 'p', printer, template, paper: presetPaper(printer === 'impact' ? 'ff_a4' : 'a4')!,
    options: { ...defaultPrintOptions(printer), layout: { ...defaultPrintLayout(printer), ...layout } as PrintLayout },
  };
  return lookFor(p);
};
const html = (el: ReturnType<typeof createElement>, look: PrintLook) =>
  renderToStaticMarkup(createElement(PrintLookContext.Provider, { value: look }, el));
const canvasOf = (c: unknown) => c as PrintLayout['canvas'];
const MM = 96 / 25.4;

/** محتوى مربعٍ في لوحة: من وسم فتحه إلى إغلاقه (عدّ أعماق div) */
function boxSlice(out: string, id: string): string {
  const at = out.lastIndexOf('<div', out.indexOf(`data-canvas-box="${id}"`));
  assert.ok(at >= 0 && out.includes(`data-canvas-box="${id}"`), `لا مربع ${id}`);
  const re = /<div\b|<\/div>/g;
  re.lastIndex = at;
  let depth = 0;
  for (let m = re.exec(out); m; m = re.exec(out)) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return out.slice(at, m.index + 6);
  }
  return out.slice(at);
}
const boxHeightPx = (slice: string): number => Number(/^<div[^>]*height:([\d.]+)px/.exec(slice)?.[1] ?? NaN);

// ─── ١) النقطية: لوحةٌ فيها مربع QR يعبر حدّ الصفحة ───

const inked = (h: number): Bitmap => { const b = createBitmap(16, h); fillRect(b, 0, 0, 16, h, true); return b; };

test('النقطية: لوحة تذييلٍ فيها رمزٌ يعبر حدّ الصفحة تنتقل كاملةً — القطع أعلى اللوحة لا أعلى الرمز', () => {
  // ورقةٌ بلا صفٍّ أبيض: لوحة [150، 260) وفيها صفوف الرمز [180، 240) — الحدّ 200 يعبر الاثنين
  const b = inked(300);
  assert.deepEqual(splitPages(b, 200, 30, [[180, 240], [150, 260]]), [[0, 150], [150, 300]]);
  const pages = paginate(b, [[180, 240]], 200, 30, () => null, [[150, 260]]);
  assert.deepEqual(pages.map((p) => p.bitmap.height), [150, 150], 'اللوحة قُطعت من أعلى رمزها');
  assert.deepEqual(pages.map((p) => p.qrRows), [[], [[30, 90]]], 'صفوف الرمز تنتقل مع اللوحة');
  // مدياتٌ متفرّقة (اليوم: صفوف رمزٍ وحدها) — كما كانت حرفاً: الرمز العابر يُقطع أعلاه، ومدىً يبدأ أول الصفحة لا يحبسها
  assert.deepEqual(splitPages(b, 200, 30, [[180, 240]]), [[0, 180], [180, 300]]);
  assert.deepEqual(splitPages(b, 200, 30, [[0, 250]]), [[0, 200], [200, 300]]);
  assert.deepEqual(splitPages(b, 200, 30, []), [[0, 200], [200, 300]]);
});

// ─── ٢) ما تحت الرمز لا يفيض أسفل مربعه ───

test('مربع QR في لوحة الرأس بمتّسعٍ لسطرٍ تحته: التعليق وICV محصوران في المتبقّي تحت الخانة (الصفحة والنقطية، المرحلتان)', () => {
  const cases: Array<[PrinterType, TemplateId, number, Partial<InvoiceDoc>, string]> = [
    ['page', 'page_branded', 58.5, { zatca: zv() }, 'المرحلة الثانية'],
    ['page', 'page_branded', 70, { zatca: zv() }, 'المرحلة الثانية (متّسع أكبر)'],
    ['impact', 'impact_plain', 90, { zatca: zv() }, 'النقطية'],
    ['page', 'page_branded', 58.5, {}, 'المرحلة الأولى'],
  ];
  for (const [printer, template, hMm, over, name] of cases) {
    const look = lookOf({ canvas: canvasOf({ headerMm: hMm + 1.5, footerMm: 0, boxes: [{ id: 'qr', band: 'header', x: 0, y: 1.5, w: 50.5, h: hMm }] }) }, printer, template);
    const out = html(createElement(PrintableInvoice, { doc: inv(over) }), look);
    const box = boxSlice(out, 'qr');
    const h = boxHeightPx(box);
    const side = Math.floor(Math.min(Number(/width:([\d.]+)px/.exec(box)?.[1]), h));
    const slot = Math.max(side, look.qrSlotPx ?? 0);
    const under = /<div data-qr-under="" style="max-height:(\d+)px;overflow:hidden">/.exec(box);
    assert.ok(under, `${name}: ما تحت الرمز بلا حصر — يفيض أسفل المربع فيعلو على السريان`);
    assert.equal(Number(under![1]), Math.max(0, Math.floor(h) - slot), `${name}: الحصر ليس المتبقّي تحت الخانة`);
    assert.ok(box.indexOf('data-qr-under') > box.indexOf('<img'), `${name}: الرمز نفسه داخل الحصر`);
    if (over.zatca) assert.ok(box.slice(box.indexOf('data-qr-under')).includes('ICV 41'), `${name}: سطر ICV خرج من الحصر`);
  }
  // بلا لوحة: كتلة اليوم بلا غلاف (الذهبيّات تثبت البايتات)
  const flow = html(createElement(PrintableInvoice, { doc: inv({ zatca: zv() }) }), lookOf({ sections: { info: { fontPct: 100 } } }));
  assert.ok(!flow.includes('data-qr-under'));
  // مربعٌ بلا متّسع تحته: الرمز وحده كما كان
  const tight = html(createElement(PrintableInvoice, { doc: inv({ zatca: zv() }) }),
    lookOf({ canvas: canvasOf({ headerMm: 52, footerMm: 0, boxes: [{ id: 'qr', band: 'header', x: 0, y: 0, w: 50.5, h: 50.5 }] }) }));
  assert.ok(!boxSlice(tight, 'qr').includes('data-qr-under') && !boxSlice(tight, 'qr').includes('ICV'));
  assert.ok(Math.abs(MM * 50.5 - 190.87) < 0.01);
});

// ─── ٣) المصمّم يقيس الفيض على أطول ما يحمله كل مربع ───

test('مستندات القياس: آجلة بخصمٍ ومدفوعٍ ومتبقٍّ، وإشعارٌ دائن بمرجعه وسببه، وسندٌ لأربع فواتير برصيدٍ دائن — كلٌّ في مربعه', async () => {
  const { stressInvoiceDocs, stressReceiptDoc } = await import('../components/print/designer/stressDocs');
  const canvas = canvasOf({ headerMm: 80, footerMm: 70, boxes: [
    { id: 'docInfo', band: 'header', x: 0, y: 0, w: 90, h: 70 }, { id: 'customer', band: 'header', x: 95, y: 0, w: 90, h: 70 },
    { id: 'totals', band: 'footer', x: 0, y: 0, w: 90, h: 60 },
  ] });
  const look = lookOf({ canvas });
  const sample = inv({ zatca: zv() });
  const docs = stressInvoiceDocs(sample);
  const outs = docs.map((d) => html(createElement(PrintableInvoice, { doc: d }), look));
  const all = (id: string) => outs.map((o) => boxSlice(o, id)).join('');
  for (const label of ['الخصم', 'المدفوع', 'المتبقي', 'الإجمالي النهائي']) assert.ok(all('totals').includes(label), `الإجماليات بلا «${label}»`);
  for (const label of ['الفاتورة الأصلية', 'سبب الإرجاع', 'تاريخ التسليم', 'النوع']) assert.ok(all('docInfo').includes(label), `بيانات المستند بلا «${label}»`);
  for (const label of ['السجل التجاري', 'الجوال', 'العنوان']) assert.ok(all('customer').includes(label), `العميل بلا «${label}»`);
  assert.ok(docs.every((d) => d.items.length === 1), 'الأصناف تسري لا مربع لها — صنفٌ واحد يكفي');
  assert.ok(!outs.some((o) => o.includes('data-pd')), 'القياس بلا سياق المصمّم');

  const r = stressReceiptDoc(rcp());
  const rOut = html(createElement(PrintableReceipt, { doc: r }), lookOf({ canvas }));
  const amount = boxSlice(rOut, 'totals');
  for (let i = 1; i <= 4; i++) assert.ok(amount.includes(`INV-1-${i}`), `السند بلا الفاتورة ${i}`);
  assert.ok(amount.includes('رصيد دائن'), 'السند بلا الرصيد الدائن');
  assert.ok(boxSlice(rOut, 'customer').includes('ملاحظات'));

  // المصمّم يرسمها مخفيّةً بالمظهر نفسه ويضمّ فيضها إلى الشارة
  const src = readFileSync(new URL('../components/print/designer/A4BandsCanvas.tsx', import.meta.url), 'utf8');
  assert.ok(src.includes("from './stressDocs'"));
  assert.ok(src.includes('ref={stressRef}') && src.includes("visibility: 'hidden'"));
  assert.ok(src.includes('canvasOverflowIds(stressRef.current)'), 'فيض مستندات القياس لا يصل الشارة');
});
