/**
 * مراجعة A4 + النقطية + PDF لـ«التحرير الحرّ» (طلب المالك ٣ نوفمبر ٢٠٢٦) — عيوبٌ وُجدت وأُصلحت، كلٌّ باختبارٍ يفشل قبل الإصلاح:
 * ١) PDF: قسم الأصناف الملفوف (data-section="items") يبدأ في نصف الصفحة الأعلى ويعبر حدّها ⇒ كان القصّ يقع داخل صفّ (١٥ صنفاً).
 * ٢) لوحات المصمّم مربعاتها overflow:hidden: وسم البروفة وإشعار سند التسليم/الإبطال وختم «سند ملغى» لا تُقصّ داخل مربعٍ صغير.
 * ٣) مربع QR أطول من ضلعه بقليل: التعليق تحته كان يُفيض المحتوى فيتوسّط فيعلو الرمز فوق المربع (وفوق اللوحة) — يُقصّ بين صفحتين.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintableInvoice, PrintableReceipt, type Company, type InvoiceDoc, type ReceiptDoc } from './RepDocuments';
import { PrintLookContext, lookFor, type PrintLook } from './printLook';
import { layoutPageStarts, type KeepBox } from './pdf';
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
  renderToStaticMarkup(createElement(PrintLookContext.Provider, { value: look }, el)).replace(/data:image\/png;base64,[A-Za-z0-9+/=]{60,}/g, 'data:QR');
const canvasOf = (c: unknown) => c as PrintLayout['canvas'];

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

// ─── ١) PDF: لا قصّ داخل صفّ مع قسمٍ ملفوفٍ يعبر الحدّ ───

/** ورقة المسار الحرّ (بكسل العنصر): ترويسة وبيانات ثم أصناف ملفوفة بصفوفها ثم الإجماليات */
function freeSheetBoxes(items: number): { boxes: KeepBox[]; rows: KeepBox[]; total: number } {
  const rows: KeepBox[] = [{ top: 420, bottom: 460 }];
  for (let i = 0; i < items; i++) rows.push({ top: 460 + i * 45, bottom: 460 + (i + 1) * 45 });
  const itemsBottom = rows[rows.length - 1].bottom;
  const boxes: KeepBox[] = [
    { top: 40, bottom: 200 }, { top: 200, bottom: 420 }, { top: 420, bottom: itemsBottom }, ...rows, { top: itemsBottom, bottom: itemsBottom + 220 },
  ];
  return { boxes, rows, total: itemsBottom + 340 };
}

test('PDF المسار الحرّ: قسم الأصناف الملفوف العابر لحدّ الصفحة لا يُسقط حماية صفوفه (١ و١٥ و٦٠ صنفاً)', () => {
  const pagePx = (841.89 / 595.28) * 794;
  for (const n of [1, 15, 20, 60]) {
    const { boxes, rows, total } = freeSheetBoxes(n);
    const starts = layoutPageStarts(total, pagePx, boxes, 3, true);
    for (const s of starts.slice(1)) {
      assert.ok(!rows.some((r) => r.top < s - 0.5 && r.bottom > s + 0.5), `${n} صنفاً: قصٌّ داخل صفّ عند ${s.toFixed(1)}`);
      assert.ok(s > starts[starts.indexOf(s) - 1] + pagePx / 2 - 1, `${n} صنفاً: صفحةٌ أقصر من نصف صفحة`);
    }
  }
  // بلا الخيار (ورقة اليوم وثنائي اللغة بلا تحرير) السلوك كما كان حرفاً
  const { boxes, total } = freeSheetBoxes(15);
  assert.deepEqual(layoutPageStarts(total, pagePx, boxes), [0, pagePx]);
  assert.deepEqual(layoutPageStarts(2000, 1000, [{ top: 300, bottom: 1200 }], 3, true), [0, 1000]);
  // layoutPdf يمرّره لورقةٍ غير ثنائية اللغة أو لورقةٍ على مسار التحرير (مرساة النسخة)
  const src = readFileSync(new URL('./pdf.ts', import.meta.url), 'utf8');
  assert.ok(src.includes("const innerFirst = el.getAttribute('data-print-layout') !== 'grid_bilingual' || el.querySelector('[data-copy-anchor]') !== null;"));
  assert.ok(src.includes('layoutPageStarts(totalPx, pagePx, keep, undefined, innerFirst)'));
});

// ─── ٢) أشرطة الحالة لا تُقصّ داخل مربعات اللوحة ───

const SMALL_HEAD = canvasOf({ headerMm: 40, footerMm: 0, boxes: [
  { id: 'title', band: 'header', x: 0, y: 0, w: 80, h: 15 }, { id: 'company', band: 'header', x: 90, y: 0, w: 98, h: 30 },
  { id: 'docInfo', band: 'header', x: 0, y: 16, w: 85, h: 20 },
] });

test('سند التسليم والمستند المُبطل ووسم البروفة: الإشعار يسري خارج مربع العنوان الصغير، مرّةً واحدة', () => {
  const cases: Array<[string, Partial<ZatcaDocView>]> = [
    ['سلمت البضاعة وبانتظار اعتماد الهيئة', { printable: false, qr: null, mirror: null, documentStatus: 'SIGNED' }],
    ['أبطل هذا المستند', { mirror: 'rejected', printable: false }],
  ];
  for (const [notice, over] of cases) {
    const out = html(createElement(PrintableInvoice, { doc: inv({ zatca: zv(over) }) }), lookOf({ canvas: SMALL_HEAD }));
    assert.ok(out.includes(notice), `الإشعار غائب: ${notice}`);
    assert.equal(out.split(notice).length - 1, 1, `الإشعار مكرّر: ${notice}`);
    assert.ok(!boxSlice(out, 'title').includes(notice), `الإشعار داخل مربع العنوان (يُقصّ): ${notice}`);
    assert.ok(out.indexOf(notice) < out.indexOf('data-section="items"'), 'الإشعار ليس أعلى السريان');
  }
  const reh = html(createElement(PrintableInvoice, { doc: inv({ zatca: zv({ mode: 'rehearsal' as ZatcaDocView['mode'] }) }) }), lookOf({ canvas: SMALL_HEAD }));
  const wm = /<div style="background:#FEF3C7[^>]*>([^<]+)</.exec(reh);
  assert.ok(wm, 'وسم البروفة غائب');
  assert.ok(!boxSlice(reh, 'title').includes(wm![1]), 'وسم البروفة داخل مربع العنوان (يُقصّ)');
  // بلا لوحة للعنوان: الوسم تحت الترويسة كما في مسار التحرير
  const flow = html(createElement(PrintableInvoice, { doc: inv({ zatca: zv({ mode: 'rehearsal' as ZatcaDocView['mode'] }) }) }), lookOf({ sections: { info: { fontPct: 100 } } }));
  assert.ok(flow.slice(flow.indexOf('data-section="header"'), flow.indexOf('data-section="info"')).includes(wm![1]));
});

test('سند قبض ملغى ومربع «بيانات المستند» في اللوحة: ختم «سند ملغى» يسري خارج المربع', () => {
  const out = html(createElement(PrintableReceipt, { doc: rcp({ cancelled: true }) }), lookOf({ canvas: SMALL_HEAD }));
  assert.equal(out.split('سند ملغى').length - 1, 1);
  assert.ok(!boxSlice(out, 'docInfo').includes('سند ملغى'), 'الختم داخل مربع بيانات السند (يُقصّ)');
  assert.ok(boxSlice(out, 'docInfo').includes('RC-55'), 'رقم السند خرج من مربعه');
});

// ─── ٣) مربع QR: الرمز لا يعلو فوق مربعه ───

test('مربع QR أطول من ضلعه (التعليق تحته): الرمز أعلى المربع لا متوسّطاً يفيض فوقه — والمربع الضيّق بلا تعليق كما هو', () => {
  for (const [printer, template] of [['page', 'page_branded'], ['impact', 'impact_plain']] as const) {
    const look = lookOf({ canvas: canvasOf({ headerMm: 0, footerMm: 90, boxes: [{ id: 'qr', band: 'footer', x: 0, y: 0, w: 47, h: 47 }] }) }, printer, template);
    const side = (look.qrSlotPx ?? 190) / (96 / 25.4);
    const tall = lookOf({ canvas: canvasOf({ headerMm: 0, footerMm: 90, boxes: [{ id: 'qr', band: 'footer', x: 0, y: 0, w: 47, h: Math.ceil(side * 2) / 2 + 8 }] }) }, printer, template);
    const out = html(createElement(PrintableInvoice, { doc: inv({ zatca: zv() }) }), tall);
    assert.match(boxSlice(out, 'qr'), /<div style="text-align:center;align-self:flex-start">/, `${printer}: الرمز متوسّطٌ فيفيض فوق مربعه`);
    const sq = html(createElement(PrintableInvoice, { doc: inv({ zatca: zv() }) }), look);
    assert.ok(!boxSlice(sq, 'qr').includes('align-self'), `${printer}: المربع بلا تعليق تغيّر`);
  }
});
