/**
 * «التحرير الحرّ» على قالب A4/النقطية القياسي (الفاتورة والسند) — طلب المالك ٣ نوفمبر ٢٠٢٦ (pd_spec، الحزمة P3 A4-FLOW).
 *
 * ١) حجم الشعار بالملّيمتر بلا object-fit (أبعادٌ محسوبة من رأس الصورة)، ومحاذاته، وكتلته المستقلة أعلى الورقة أو بعد قسم.
 * ٢) تنسيق كل قسم: إخفاء، ومحاذاة (start = يمين الورقة)، ومسافة قبل/بعد، وحجم خطٍّ يضرب بكسل القالب (لا zoom ولا filter).
 * ٣) QR المرحلة الثانية لا يُحذف إلا بحذف الشركة الصريح (قرار المالك ٤ نوفمبر ٢٠٢٦، sections.qr.visible=false): قسم الإجماليات
 *    مخفيّ ⇒ كتلته وحدها بعد الأصناف؛ لوحاتٌ بلا مربع QR ⇒ يسري مع الإجماليات؛ والحذف الصريح ⇒ لا كتلة في أيّ مكان.
 * ٤) لوحتا الرأس والتذييل (PrintCanvasSheet): الكتل في اللوحة، والسريان مقلَّم، وdata-print-canvas على الجذر وحده مع لوحات.
 * ٥) وسم المصمّم data-pd داخل سياق المعاينة وحده، وdata-copy-anchor على غلاف الترويسة. ٦) السند خريطة أقسام على مسار التحرير.
 * ملفٌّ بلا المفاتيح الحرّة = ورقة اليوم حرفاً: الذهبيّان printA4.baseline وprintLayout6.baseline يثبتانه.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintableInvoice, PrintableReceipt, canvasQrMinMm, type Company, type InvoiceDoc, type ReceiptDoc } from './RepDocuments';
import { PrintLookContext, imageNaturalSize, logoImgStyle, lookFor, type PrintLook } from './printLook';
import { PrintDesignPreviewContext } from './printDesignContext';
import {
  defaultPrintLayout, defaultPrintOptions, presetPaper, type PrintLayout, type PrintProfile, type PrinterType, type TemplateId,
} from '../lib/print/printSettings';
import { MM_PX, mmToPx } from '../lib/print/layout';
import type { ZatcaDocView } from '../lib/zatca/docStatus';
import { useLang } from '../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';

process.env.TZ = 'Asia/Riyadh';
useLang.setState({ lang: 'ar' });
setActiveNumerals('latin');
setActiveCurrency('SAR');

/** PNG صالح الرأس بأبعادٍ معلومة (200×100) — المحرّك يقرأ IHDR وحده */
function pngOf(w: number, h: number): string {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8; b[25] = 6;
  return `data:image/png;base64,${b.toString('base64')}`;
}
const LOGO = pngOf(200, 100);
const STAMPED = 'AQ/YtNix2YPYqSDYp9mE2KfYrtiq2KjYp9ixAg8zMDAwMDAwMDAwMDAwMDMDFDIwMjYtMTEtMDJUMDk6MTU6MDBa';
const COMPANY: Company = {
  name: 'شركة الاختبار للتوزيع', address: 'الرياض، حي العليا', taxNumber: '300000000000003', commercialReg: '1010101010',
  phone: '0501234567', email: 'info@example.sa', logo: LOGO, primaryColor: '#1e3a8a', headerStyle: null, countryCode: 'SA',
};
const B2B = { name: 'محمد العتيبي', businessName: 'مؤسسة الأفق', commercialReg: '1010202020', taxNumber: '311111111111113', phone: '0112345678', address: 'طريق الملك فهد', city: 'الرياض' };
const inv = (over: Partial<InvoiceDoc> = {}, company: Company = COMPANY): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-777', date: '2026-11-02T09:15:00.000Z', type: 'CREDIT', company, customer: B2B, repName: 'أحمد السالم',
  items: [
    { name: 'مياه معدنية', unit: 'كرتون', qty: 2, unitPrice: 23, discountPct: 0, taxPct: 15, lineTotal: 46 },
    { name: 'عصير برتقال', unit: 'حبة', qty: 3, unitPrice: 2.5, discountPct: 10, taxPct: 15, lineTotal: 6.75 },
  ],
  subtotal: 48.5, discount: 2.5, tax: 6.88, total: 52.75, pricesIncludeTax: true, paidAmt: 21.5, remainingAmt: 31.25,
  ...over,
});
const zv = (over: Partial<ZatcaDocView> = {}): ZatcaDocView => ({
  phase: 2, mode: 'live', mirror: 'cleared', documentStatus: 'CLEARED', subtype: '01', documentKind: 'INVOICE', qr: STAMPED, printable: true,
  overdue: false, reportDeadline: null, issuedAt: '2026-11-02T09:15:00.000Z', uuid: '3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c', icv: 41, warnings: 0, ...over,
});
const rcp = (over: Partial<ReceiptDoc> = {}): ReceiptDoc => ({
  kind: 'receipt', number: 'RC-55', date: '2026-11-02T11:00:00.000Z', company: COMPANY,
  customer: { name: 'بقالة النور', phone: '0559998887', address: 'حي الروضة' },
  repName: 'أحمد السالم', amount: 150, paymentMethod: 'CASH', invoices: [{ number: 'INV-777', amount: 150 }], ...over,
});

const profile = (layout: Partial<PrintLayout> | null, printer: PrinterType = 'page', template: TemplateId = 'page_branded'): PrintProfile => ({
  id: 'p-1', name: 'p', printer, template, paper: presetPaper(printer === 'impact' ? 'ff_a4' : 'a4')!,
  options: { ...defaultPrintOptions(printer), ...(layout ? { layout: { ...defaultPrintLayout(printer), ...layout } as PrintLayout } : {}) },
});
const lookOf = (layout: Partial<PrintLayout> | null, printer: PrinterType = 'page', template: TemplateId = 'page_branded'): PrintLook =>
  lookFor(profile(layout, printer, template));

const wrap = (el: ReturnType<typeof createElement>, look: PrintLook, design = false) => {
  const inner = createElement(PrintLookContext.Provider, { value: look }, el);
  const tree = design ? createElement(PrintDesignPreviewContext.Provider, { value: { active: 'items' } }, inner) : inner;
  return renderToStaticMarkup(tree).replace(/data:image\/png;base64,[A-Za-z0-9+/=]{60,}/g, 'data:QR');
};
const a4 = (doc: InvoiceDoc, look: PrintLook, design = false) => wrap(createElement(PrintableInvoice, { doc }), look, design);
const a4r = (doc: ReceiptDoc, look: PrintLook, design = false) => wrap(createElement(PrintableReceipt, { doc }), look, design);

/** أوّل وسم img للشعار (src الشعار) وأسلوبه */
const logoImgs = (h: string) => [...h.matchAll(/<img src="data:image\/png;base64,[A-Za-z0-9+/=]{20,59}"[^>]*>/g)].map((m) => m[0]);
const px = (tag: string, prop: string): number => Number((new RegExp(`${prop}:([0-9.]+)px`).exec(tag) ?? [])[1]);
const sectionIds = (h: string) => [...h.matchAll(/data-section="([a-z-]+)"/g)].map((m) => m[1]);

// ─── ١) الشعار ───

test('حجم الشعار بالملّيمتر: أبعادٌ صريحة بنسبة الصورة داخل صندوق logoMm — لا object-fit ولا مربّع ممطوط', () => {
  for (const mm of [6, 30, 55.5, 120]) {
    const out = a4(inv(), lookOf({ logoMm: mm }));
    const imgs = logoImgs(out);
    assert.equal(imgs.length, 1, `${mm}: الشعار مرّةً واحدة`);
    const box = mmToPx(Math.min(mm, 120));
    const w = px(imgs[0], 'width');
    const h = px(imgs[0], 'height');
    assert.ok(w <= box + 0.01 && h <= box + 0.01, `${mm}: الشعار ${w}×${h} أكبر من صندوقه ${box}`);
    assert.ok(Math.abs(w / h - 2) < 0.01, `${mm}: نسبة الصورة تغيّرت`);
    assert.ok(Math.abs(w - box) < 0.02, `${mm}: العرض لا يملأ الصندوق`);
    assert.ok(!/object-fit/.test(imgs[0]), 'object-fit في الشعار الحرّ');
  }
  // الحجم الحرّ يتقدّم على logoSize، وغيابه = جداول s/m/l كاليوم
  assert.match(logoImgs(a4(inv(), lookOf({ logoSize: 'l' })))[0], /width:56px;height:56px;object-fit:contain/);
});

test('محاذاة الشعار في الترويسة: يمين الاسم (start) أو الوسط أو بجانب العنوان (end) — وبلا شعار لا صورة', () => {
  assert.match(a4(inv(), lookOf({ logoMm: 20, logo: 'center' })), /<div style="align-self:center"><img src="data:image\/png/);
  assert.match(a4(inv(), lookOf({ logoMm: 20, logo: 'end' })), /فاتورة ضريبية<\/div><img src="data:image\/png/);
  const start = a4(inv(), lookOf({ logoMm: 20, logo: 'start' }));
  assert.ok(start.indexOf('<img src="data:image/png') < start.indexOf('شركة الاختبار للتوزيع'), 'start: الشعار ليس يمين الاسم');
  assert.equal(logoImgs(a4(inv(), lookOf({ logoMm: 20, logo: 'none' }))).length, 0);
  assert.equal(logoImgs(a4(inv(), lookOf({ logoMm: 20, logoAfter: 'top', logo: 'none' }))).length, 0, 'none يخفي الكتلة المستقلة أيضاً');
  // خيار القالب «بلا شعار» والنماذج المطبوعة مسبقاً بلا شعار أبداً
  const noLogo = lookFor({ ...profile({ logoMm: 30, logoAfter: 'top' }), options: { ...profile({ logoMm: 30, logoAfter: 'top' }).options, showLogo: false } });
  assert.equal(logoImgs(a4(inv(), noLogo)).length, 0);
  assert.equal(logoImgs(a4(inv(), lookOf({ logoMm: 30, logoAfter: 'top' }, 'impact', 'impact_preprinted'))).length, 0);
});

test('الشعار كتلةٌ مستقلة: أعلى الورقة أو بعد أيّ قسم أو آخرها — والترويسة بلا شعار، والمحاذاة start = يمين (flex-start في RTL)', () => {
  const top = a4(inv(), lookOf({ logoAfter: 'top', logo: 'start', logoMm: 25 }));
  const ids = sectionIds(top);
  assert.equal(ids[0], 'logo', 'الكتلة ليست أعلى الورقة');
  assert.equal(logoImgs(top).length, 1, 'الشعار في الترويسة أيضاً');
  assert.match(top, /data-section="logo" style="display:flex;justify-content:flex-start/);
  const afterItems = a4(inv(), lookOf({ logoAfter: 'items', logo: 'end' }));
  const s2 = sectionIds(afterItems);
  assert.equal(s2[s2.indexOf('items') + 1], 'logo', 'الكتلة ليست بعد الأصناف');
  assert.match(afterItems, /data-section="logo" style="display:flex;justify-content:flex-end/);
  const last = a4(inv(), lookOf({ logoAfter: 'footer', logo: 'center' }));
  assert.equal(sectionIds(last).slice(-1)[0], 'logo');
  assert.match(last, /data-section="logo" style="display:flex;justify-content:center/);
  // بلا logoMm: حجم اليوم (m = 42 بكسل) صندوقاً أقصى
  const w = px(logoImgs(afterItems)[0], 'width');
  assert.ok(w <= 42.01 && w > 41, `حجم اليوم ${w}`);
  // السند كالفاتورة
  const r = a4r(rcp(), lookOf({ logoAfter: 'top' }));
  assert.equal(sectionIds(r)[0], 'logo');
  assert.equal(logoImgs(r).length, 1);
});

// ─── ٢) تنسيق الأقسام ───

test('تنسيق كل قسم: إخفاء، ومحاذاة (start = right)، ومسافة بالبكسل، وحجم خطٍّ يضرب أحجام القالب — بلا zoom ولا filter', () => {
  const look = lookOf({
    sections: {
      signatures: { visible: false }, installments: { visible: false },
      info: { align: 'start', fontPct: 150, spaceBeforeMm: 10 },
      items: { fontPct: 70 }, footer: { align: 'center', spaceAfterMm: 5 }, totals: { align: 'end' },
    },
  });
  const out = a4(inv({ paymentPlan: 'INSTALLMENT', installments: [{ seq: 1, dueDate: '2026-12-02T00:00:00.000Z', amount: 52.75 }] }), look);
  const ids = sectionIds(out);
  assert.deepEqual(ids, ['header', 'info', 'items', 'note', 'totals', 'footer']);
  assert.ok(!out.includes('توقيع المستلم') && !out.includes('جدول الأقساط'), 'المخفيّ طُبع');
  assert.match(out, new RegExp(`data-section="info" style="display:flow-root;text-align:right;margin-top:${mmToPx(10)}px"`));
  assert.match(out, /data-section="totals" style="display:flow-root;text-align:left"/);
  assert.match(out, new RegExp(`data-section="footer" style="display:flow-root;text-align:center;margin-bottom:${mmToPx(5)}px"`));
  // 13 × 150٪ = 19.5 في صناديق البيانات، و14 × 150٪ = 21 للعنوان؛ والجدول 13 × 70٪ = 9.1
  const info = out.slice(out.indexOf('data-section="info"'), out.indexOf('data-section="items"'));
  assert.ok(info.includes('font-size:19.5px') && info.includes('font-size:21px') && !info.includes('font-size:13px'), 'خط البيانات لم يتضاعف');
  const items = out.slice(out.indexOf('data-section="items"'), out.indexOf('data-section="note"'));
  assert.ok(items.includes('font-size:9.1px') && !items.includes('font-size:13px'), 'خط الجدول لم يتضاعف');
  // الترويسة 100٪: أحجام اليوم
  assert.ok(out.includes('font-size:26px'));
  assert.ok(!/zoom|filter/.test(out), 'zoom/filter في مخرجات التحرير الحرّ');
});

test('مسار التحرير بلا تنسيق: الأقسام ملفوفة بلا أسلوب إضافي وبالترتيب، والترويسة وحدها مرساة النسخة', () => {
  const out = a4(inv(), lookOf({ logoMm: 42 }));
  assert.deepEqual(sectionIds(out), ['header', 'info', 'items', 'note', 'totals', 'signatures', 'footer']);
  assert.equal((out.match(/data-copy-anchor=""/g) ?? []).length, 1);
  assert.match(out, /<div data-section="header" data-copy-anchor="" style="display:flow-root">/);
  assert.ok(!out.includes('data-pd'), 'وسم المصمّم خارج المعاينة');
  assert.ok(!out.includes('data-print-canvas'), 'سمة اللوحات بلا لوحات');
  // ترتيبٌ مخصّص يسري كما هو
  const moved = a4(inv(), lookOf({ logoMm: 42, order: ['header', 'items', 'info', 'note', 'totals', 'installments', 'signatures', 'footer'] }));
  assert.deepEqual(sectionIds(moved).slice(0, 3), ['header', 'items', 'info']);
});

test('معاينة المصمّم: data-pd على كل قسم والشعار المستقل (حتى لملفٍّ بلا مفاتيح حرّة) — وخارجها لا وسم', () => {
  const plain = a4(inv(), lookOf(null), true);
  for (const id of ['header', 'info', 'items', 'totals', 'footer']) assert.ok(plain.includes(`data-pd="${id}"`), `بلا data-pd لـ${id}`);
  assert.ok(plain.includes('data-pd="items" data-pd-active=""'));
  const withLogo = a4(inv(), lookOf({ logoAfter: 'top' }), true);
  assert.ok(withLogo.includes('data-pd="logo"'));
  assert.ok(!a4(inv(), lookOf({ logoAfter: 'top' })).includes('data-pd'));
  assert.ok(!a4(inv(), lookOf(null)).includes('data-section'), 'ملفٌّ بلا تخطيط خارج المصمّم سلك مسار التحرير');
});

// ─── ٣) QR لا يُحذف ───

test('QR المرحلة الثانية: الإجماليات مخفية ⇒ كتلة الرمز وحدها بعد الأصناف بمقاس اليوم (176) — والمرحلة الأولى كذلك', () => {
  const look = lookOf({ sections: { totals: { visible: false } } });
  const out = a4(inv({ zatca: zv() }), look);
  const ids = sectionIds(out);
  assert.equal(ids[ids.indexOf('items') + 1], 'qr');
  assert.ok(!ids.includes('totals'));
  const qr = out.slice(out.indexOf('data-section="qr"'));
  assert.match(qr, /<img width="176" height="176" alt="QR"/);
  assert.ok(!out.includes('الإجمالي النهائي'), 'صفوف الإجماليات طُبعت مع إخفاء قسمها');
  const p1 = a4(inv(), look);
  assert.match(p1.slice(p1.indexOf('data-section="qr"')), /alt="QR"/);
  // الإجماليات ظاهرة: لا كتلة يتيمة والرمز في قسمه
  const shown = a4(inv({ zatca: zv() }), lookOf({ logoMm: 30 }));
  assert.ok(!sectionIds(shown).includes('qr'));
  assert.match(shown.slice(shown.indexOf('data-section="totals"')), /alt="QR"/);
});

test('QR محذوفٌ صراحةً (قرار المالك ٤ نوفمبر ٢٠٢٦): لا كتلة في الإجماليات ولا يتيمة ولا في لوحة — والإجماليات والأصناف باقية', () => {
  const ICV = /ICV 41|3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c/;
  for (const printer of ['page', 'impact'] as const) {
    const tpl = printer === 'impact' ? 'impact_plain' : 'page_branded';
    // الإجماليات ظاهرة: صفوفها وحدها، ملتصقةً بطرفها كاليوم بلا رمز (flex-end)
    const shown = a4(inv({ zatca: zv() }), lookOf({ sections: { qr: { visible: false } } }, printer, tpl));
    assert.ok(!shown.includes('alt="QR"') && !shown.includes('data-qr-value="') && !ICV.test(shown), `${printer}: الرمز المحذوف مطبوع`);
    assert.ok(shown.includes('الإجمالي النهائي'));
    assert.match(shown.slice(shown.indexOf('data-section="totals"')), /justify-content:flex-end/);
    // الإجماليات مخفيّة أيضاً: لا كتلة يتيمة
    const host = a4(inv({ zatca: zv() }), lookOf({ sections: { totals: { visible: false }, qr: { visible: false } } }, printer, tpl));
    assert.ok(!sectionIds(host).includes('qr') && !host.includes('alt="QR"'), `${printer}: كتلةٌ يتيمة لرمزٍ محذوف`);
    // لوحةٌ ما زال فيها مربع QR: يُهمل المربع، والإجماليات في لوحتها
    const cv = a4(inv({ zatca: zv() }), lookOf({ canvas: CANVAS, sections: { qr: { visible: false } } }, printer, tpl));
    assert.ok(!cv.includes('alt="QR"') && !ICV.test(cv), `${printer}: مربع QR في لوحة لرمزٍ محذوف`);
    assert.ok(cv.slice(cv.indexOf('data-section="canvas-footer"')).includes('الإجمالي النهائي'));
    // المرحلة الأولى كذلك
    assert.ok(!a4(inv(), lookOf({ sections: { qr: { visible: false } } }, printer, tpl)).includes('alt="QR"'));
  }
  // بلا حذفٍ صريح: كما اليوم (الرمز في الإجماليات بمسافةٍ بينهما)
  const today = a4(inv({ zatca: zv() }), lookOf({ logoMm: 30 }));
  assert.match(today.slice(today.indexOf('data-section="totals"')), /justify-content:space-between/);
});

test('الأصناف مخفيّة صراحةً: الجدول يسقط، والإجماليات باقية، ومرساة الرمز اليتيم في موضع الأصناف ما زالت تعمل', () => {
  const noItems = a4(inv({ zatca: zv() }), lookOf({ sections: { items: { visible: false } } }));
  assert.ok(!noItems.includes('مياه معدنية') && !sectionIds(noItems).includes('items'));
  assert.ok(noItems.includes('الإجمالي النهائي') && noItems.includes('alt="QR"'));
  const both = a4(inv({ zatca: zv() }), lookOf({ sections: { items: { visible: false }, totals: { visible: false } } }));
  const ids = sectionIds(both);
  assert.ok(!ids.includes('items') && !ids.includes('totals'));
  assert.equal((both.match(/alt="QR"/g) ?? []).length, 1, 'الرمز اليتيم سقط مع الأصناف');
  assert.equal(ids[ids.indexOf('info') + 1], 'qr', 'اليتيم ليس في موضع الأصناف');
});

// ─── ٤) لوحتا الرأس والتذييل ───

const CANVAS = {
  headerMm: 60, footerMm: 80,
  boxes: [
    { id: 'logo', band: 'header', x: 150, y: 2, w: 36, h: 20 },
    { id: 'company', band: 'header', x: 0, y: 0, w: 110, h: 30, align: 'start' },
    { id: 'title', band: 'header', x: 0, y: 32, w: 110, h: 14, fontPct: 120 },
    { id: 'totals', band: 'footer', x: 0, y: 0, w: 90, h: 50 },
    { id: 'qr', band: 'footer', x: 120, y: 0, w: 55, h: 60 },
  ],
} as unknown as PrintLayout['canvas'];

test('اللوحات: الكتل في رأس الورقة وتذييلها، والأصناف تسري بينهما، والترويسة والإجماليات المنقولة لا تتكرّر', () => {
  const out = a4(inv({ zatca: zv() }), lookOf({ canvas: CANVAS }));
  assert.match(out, /^<div style="[^"]*" data-print-layout="standard" data-print-canvas="1">/);
  const ids = sectionIds(out);
  assert.equal(ids[0], 'canvas-header');
  assert.equal(ids[ids.length - 1], 'canvas-footer');
  assert.ok(!ids.includes('header'), 'الترويسة سرت رغم وضع الشركة والعنوان في اللوحة');
  assert.ok(!ids.includes('totals'), 'الإجماليات سرت رغم وضعها والرمز في اللوحة');
  assert.ok(ids.indexOf('items') > 0 && ids.indexOf('items') < ids.length - 1);
  const head = out.slice(out.indexOf('data-section="canvas-header"'), out.indexOf('data-section="info"'));
  assert.ok(head.includes('شركة الاختبار للتوزيع') && head.includes('الرقم الضريبي'), 'كتلة الشركة');
  assert.ok(head.includes('فاتورة ضريبية') && head.includes(`font-size:31.2px`), 'كتلة العنوان بخطّها');
  assert.equal(logoImgs(head).length, 1, 'الشعار في لوحة الرأس');
  assert.ok(!/object-fit/.test(logoImgs(head)[0]));
  const foot = out.slice(out.indexOf('data-section="canvas-footer"'));
  assert.ok(foot.includes('الإجمالي النهائي'), 'الإجماليات في لوحة التذييل');
  // الرمز في مربعه: لا يصغر عن 176 ويكبر مع المربع (55 مم ⇒ ضلع 207.87 − 14)
  const m = /<img width="(\d+(?:\.\d+)?)" height="\d+(?:\.\d+)?" alt="QR"/.exec(foot);
  assert.ok(m && Number(m[1]) >= 176, 'الرمز في لوحة التذييل أصغر من اليوم');
  assert.equal(Number(m![1]), Math.max(176, Math.floor(mmToPx(55)) - 14));
  assert.equal((out.match(/alt="QR"/g) ?? []).length, 1, 'الرمز مكرّر');
  // وسم النسخة بعد لوحة الرأس لا بعد الترويسة
  assert.equal((out.match(/data-copy-anchor=""/g) ?? []).length, 1);
  assert.match(out, /data-section="canvas-header" data-copy-anchor=""/);
});

test('لوحاتٌ بلا مربع QR ⇒ الرمز يسري مع الإجماليات (مكانه التلقائي)، ومربع QR في الرأس يُطبع هناك', () => {
  const noQr = { ...CANVAS!, boxes: CANVAS!.boxes.filter((b) => b.id !== 'qr' && b.id !== 'totals') };
  const out = a4(inv({ zatca: zv() }), lookOf({ canvas: noQr }));
  assert.match(out.slice(out.indexOf('data-section="totals"')), /alt="QR"/);
  // الرمز في لوحة الرأس والإجماليات مخفية: لا كتلة يتيمة ولا تكرار
  const inHead = { headerMm: 60, footerMm: 0, boxes: [{ id: 'qr', band: 'header', x: 0, y: 0, w: 50, h: 50 }] } as unknown as PrintLayout['canvas'];
  const h = a4(inv({ zatca: zv() }), lookOf({ canvas: inHead, sections: { totals: { visible: false } } }));
  assert.equal((h.match(/alt="QR"/g) ?? []).length, 1);
  assert.ok(h.indexOf('alt="QR"') < h.indexOf('data-section="items"'), 'الرمز ليس في لوحة الرأس');
  assert.ok(!sectionIds(h).includes('qr'));
  // لوحة بلا مربعات تبقي الترويسة في السريان ومرساة النسخة على لوحة الرأس
  const empty = a4(inv(), lookOf({ canvas: { headerMm: 20, footerMm: 0, boxes: [] } }));
  assert.deepEqual(sectionIds(empty).slice(0, 2), ['canvas-header', 'header']);
  assert.equal((empty.match(/data-copy-anchor=""/g) ?? []).length, 1);
});

test('النقطية مع اللوحات: خانة الرمز data-qr-value بحجم المربع (≥ خانة اليوم) فتعيد النقطية رسمه بنقاط صحيحة', () => {
  const look = lookOf({ canvas: { headerMm: 0, footerMm: 90, boxes: [{ id: 'qr', band: 'footer', x: 0, y: 0, w: 47, h: 47 }] } as unknown as PrintLayout['canvas'] }, 'impact', 'impact_plain');
  assert.ok(look.qrSlotPx && look.qrSlotPx > 200);
  const out = a4(inv({ zatca: zv() }), look);
  const foot = out.slice(out.indexOf('data-section="canvas-footer"'));
  const slot = new RegExp(`data-qr-value="${STAMPED.replace(/[/+]/g, (c) => `\\${c}`)}"`);
  assert.match(foot, slot);
  const w = px(/<div style="[^"]*" data-qr-value/.exec(foot)![0], 'width');
  assert.ok(w >= look.qrSlotPx!, `الخانة ${w} أصغر من ${look.qrSlotPx}`);
  assert.equal(canvasQrMinMm(look), Math.ceil((look.qrSlotPx! / MM_PX) * 2) / 2);
  assert.equal(canvasQrMinMm({ qrSlotPx: null }), 50.5);
});

// ─── ٥) السند ───

test('السند على مسار التحرير: خريطة أقسام (info/totals/signatures/footer) وتنسيقها، ولوحاتٌ بلا QR', () => {
  const r = a4r(rcp(), lookOf({ sections: { signatures: { visible: false }, totals: { fontPct: 120 } } }));
  assert.deepEqual(sectionIds(r), ['header', 'info', 'totals', 'footer']);
  assert.ok(!r.includes('توقيع الدافع'));
  assert.ok(r.includes(`font-size:45.6px`), 'خط المبلغ لم يتضاعف');
  const c = a4r(rcp(), lookOf({ canvas: { headerMm: 40, footerMm: 60, boxes: [
    { id: 'title', band: 'header', x: 0, y: 0, w: 80, h: 15 }, { id: 'company', band: 'header', x: 90, y: 0, w: 98, h: 30 },
    { id: 'totals', band: 'footer', x: 0, y: 0, w: 100, h: 50 }, { id: 'qr', band: 'footer', x: 110, y: 0, w: 50, h: 50 },
  ] } as unknown as PrintLayout['canvas'] }));
  assert.ok(!c.includes('alt="QR"'), 'رمزٌ على السند');
  const foot = c.slice(c.indexOf('data-section="canvas-footer"'));
  assert.ok(foot.includes('المبلغ المستلم') && foot.includes('مقابل الفاتورة رقم'), 'المبلغ وربط الفاتورة في التذييل');
  const flow = c.slice(c.indexOf('data-section="canvas-header"'), c.indexOf('data-section="canvas-footer"'));
  assert.ok(flow.includes('بيانات العميل') && !flow.includes('المبلغ المستلم'), 'العميل يسري والمبلغ لا يتكرّر');
  assert.ok(c.includes('سند قبض'));
});

// ─── ٦) قراءة أبعاد الصورة ───

test('imageNaturalSize/logoImgStyle: PNG وGIF وJPEG (واتجاه EXIF) وWebP — وSVG يسقط إلى max-width/max-height', () => {
  assert.deepEqual(imageNaturalSize(pngOf(640, 160)), { w: 640, h: 160 });
  const gif = Buffer.from('GIF89a', 'latin1');
  assert.deepEqual(imageNaturalSize(`data:image/gif;base64,${Buffer.concat([gif, Buffer.from([0x20, 0x03, 0x58, 0x02, 0, 0])]).toString('base64')}`), { w: 800, h: 600 });
  // JPEG: SOI ثم APP1 Exif باتجاه 6 (دوران ربعٍ) ثم SOF0 300×120 ⇒ يعرضه المتصفح 120×300
  const exif = Buffer.from([
    0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0,
  ]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, exif.length + 2]), exif]);
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 120, 1, 44, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const jpg = (parts: Buffer[]) => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8]), ...parts]).toString('base64')}`;
  assert.deepEqual(imageNaturalSize(jpg([sof])), { w: 300, h: 120 });
  assert.deepEqual(imageNaturalSize(jpg([app1, sof])), { w: 120, h: 300 });
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'latin1'); webp.write('WEBP', 8, 'latin1'); webp.write('VP8X', 12, 'latin1');
  webp.writeUIntLE(499, 24, 3); webp.writeUIntLE(249, 27, 3);
  assert.deepEqual(imageNaturalSize(`data:image/webp;base64,${webp.toString('base64')}`), { w: 500, h: 250 });
  assert.equal(imageNaturalSize('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), null);
  assert.equal(imageNaturalSize('data:image/png;base64,!!!!'), null);
  // تكبيراً وتصغيراً بالنسبة نفسها
  assert.deepEqual(logoImgStyle(pngOf(20, 10), 100, 100), { display: 'block', width: 100, height: 50 });
  assert.deepEqual(logoImgStyle(pngOf(100, 400), 80, 80), { display: 'block', width: 20, height: 80 });
  assert.deepEqual(logoImgStyle('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 80, 60), { display: 'block', maxWidth: 80, maxHeight: 60, width: 'auto', height: 'auto' });
});

test('QR محذوفٌ والإجماليات في لوحة: لا قسم إجماليات فارغ في السريان بمسافتيه — كما لو كان الرمز في لوحته (الصفحة والنقطية وA5)', () => {
  const SPACED = { totals: { spaceBeforeMm: 10, spaceAfterMm: 10 } };
  const noQrBox = { ...CANVAS!, boxes: CANVAS!.boxes.filter((b) => b.id !== 'qr') };
  for (const printer of ['page', 'impact'] as const) {
    const tpl = printer === 'impact' ? 'impact_plain' : 'page_branded';
    // اليوم: الرمز والإجماليات في اللوحة ⇒ لا قسم totals في السريان
    const today = a4(inv({ zatca: zv() }), lookOf({ canvas: CANVAS, sections: SPACED }, printer, tpl));
    assert.ok(!sectionIds(today).includes('totals'), `${printer}: الإجماليات سرت والرمز وصفوفها في اللوحة`);
    for (const [name, canvas] of [['qrBoxLingering', CANVAS], ['noQrBox', noQrBox]] as const) {
      for (const p of [profile({ canvas, sections: { ...SPACED, qr: { visible: false } } }, printer, tpl),
        { ...profile({ canvas, sections: { ...SPACED, qr: { visible: false } } }, printer, tpl), paper: presetPaper(printer === 'impact' ? 'ff_95x55' : 'a5')! }]) {
        const at = `${printer}/${name}/${p.paper.preset}`;
        const out = a4(inv({ zatca: zv() }), lookFor(p));
        assert.ok(!sectionIds(out).includes('totals'), `${at}: قسم إجماليات فارغ في السريان بعد حذف الرمز`);
        assert.ok(!out.includes('alt="QR"'), `${at}: الرمز المحذوف مطبوع`);
        assert.ok(out.slice(out.indexOf('data-section="canvas-footer"')).includes('الإجمالي النهائي'), `${at}: الإجماليات غابت عن لوحتها`);
        assert.ok(sectionIds(out).includes('items'), `${at}: الأصناف`);
      }
    }
    // الرمز محذوفٌ وصفوف الإجماليات ليست في لوحة: القسم باقٍ بصفوفه (بلا رمز)
    const rowsInFlow = a4(inv({ zatca: zv() }), lookOf({ canvas: { ...noQrBox, boxes: noQrBox.boxes.filter((b) => b.id !== 'totals') }, sections: { ...SPACED, qr: { visible: false } } }, printer, tpl));
    assert.ok(sectionIds(rowsInFlow).includes('totals') && rowsInFlow.includes('الإجمالي النهائي') && !rowsInFlow.includes('alt="QR"'), `${printer}: صفوف الإجماليات سقطت من السريان`);
    // الرمز ظاهرٌ بلا مربع: يبقى القسم ليحمل الرمز في مكانه التلقائي
    const qrInFlow = a4(inv({ zatca: zv() }), lookOf({ canvas: noQrBox, sections: SPACED }, printer, tpl));
    const totals = qrInFlow.slice(qrInFlow.indexOf('data-section="totals"'));
    assert.ok(sectionIds(qrInFlow).includes('totals') && /alt="QR"/.test(totals), `${printer}: الرمز غير الموضوع سقط مع الإجماليات`);
  }
});
