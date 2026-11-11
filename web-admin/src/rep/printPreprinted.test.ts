/**
 * «نموذج الشركة المطبوع مسبقاً» (rep/printPreprinted.tsx — FormInvoice): القيم وحدها في مواضعها على ورق الشركة.
 *
 * ١) المواضع بالمم من ركن الورقة + معايرة الطابعة dx/dy، وكل ورقة بطول الورق ناقص نصف مم مقصوصة، وفاصل الصفحة بين الأوراق وحدها.
 * ٢) التقسيم: صفوف الجدول لكل ورقة، والرأس في كل ورقة، والإجماليات ورمز QR على الأخيرة وحدها، ورقم الصفحة «n/m».
 * ٣) القيم كالقالب ثنائي اللغة: طريقة الدفع، والعنوان «العنوان، الحي»، والبائع، وسعر الوحدة قبل الضريبة في الشامل، والإجماليات.
 * ٤) «إزالة الضريبة»: لا عبارة ضريبة ولا رقم ضريبيّ ولا رمز ولا عمود نسبة — وحقول الضريبة متى أظهر القرار تفصيلها وحده.
 * ٥) رمز QR من الخاصية وحدها، ولغة القيم، والأرقام اللاتينية أو أرقام الشركة، والخلفية بمُحمِّلٍ محقون وعلم تعذّرها.
 * ٦) الفرع في PrintableInvoice (القالب والقرار والرمز المحروس أنفسها) وحرّاس المصدر.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FormInvoice, formSheetOfLook, type FormInvoiceFacts } from './printPreprinted';
import { PrintableInvoice, invoiceDocFromDetail, type InvoiceDoc } from './RepDocuments';
import { DEFAULT_PRINT_LOOK, PrintLookContext, lookFor, type PrintLook } from './printLook';
import { zatcaPrintDecision, type ZatcaPrintDecision } from '../lib/zatca/docPrint';
import { makePrintTexts, type PrintTexts } from '../lib/print/printTexts';
import type { ResolvedLayout } from '../lib/print/layout';
import { defaultPrintOptions, presetPaper, withDesign, type PrintProfile } from '../lib/print/printSettings';
import type { PrintForm } from '../lib/print/formModel';
import { firstTaxMention } from '../lib/print/taxFreePrint';
import { createFormImageLoader, FormImageLoaderContext } from '../lib/print/formImage';
import { isDocTaxFree } from '../lib/taxMode';
import { setActiveNumerals } from '../utils/format';

const SELLER_VAT = '300123456700003';
const BUYER_VAT = '310987654300003';
const company = {
  name: 'مؤسسة مروج الخليج للتجارة', address: 'شارع الخرج', taxNumber: SELLER_VAT, commercialReg: '1010456789',
  phone: '0551234567', countryCode: 'SA', addrCity: 'الرياض', addrPostalCode: '14322',
};
const customer = {
  name: 'سوبرماركت النخبة', taxNumber: BUYER_VAT, commercialReg: '1010999888', phone: '0500000000',
  address: 'طريق أنس بن مالك', district: 'حي الملقا', city: 'جدة', postalCode: '13524',
};
const item = (n: number, o: Partial<InvoiceDoc['items'][number]> = {}) => ({
  name: `صنف رقم ${n}`, code: `P-${n}`, barcode: `628100000${n}`, unit: 'كرتون', qty: n, unitPrice: 11.5, discountPct: n === 2 ? 10 : 0,
  taxPct: 15, lineTotal: 11.5 * n, ...o,
});
const inv = (o: Partial<InvoiceDoc> = {}): InvoiceDoc => ({
  kind: 'invoice', number: 'SI-2026-000123', date: '2026-11-07T10:42:00', type: 'CREDIT', paymentPlan: null,
  company: company as InvoiceDoc['company'], customer: customer as InvoiceDoc['customer'], repName: 'خالد العتيبي',
  items: [1, 2, 3, 4, 5].map((n) => item(n)) as InvoiceDoc['items'],
  subtotal: 1073.48, discount: 0, tax: 161.02, total: 1234.5, pricesIncludeTax: true, paidAmt: 234.5, remainingAmt: 1000,
  notes: 'التسليم صباحاً', dueDate: '2026-12-07', zatca: null, ...o,
});

const FORM: PrintForm = {
  image: null, dxMm: 1.5, dyMm: -2, background: false, latinDigits: true, valueLang: 'ar',
  fields: [
    { id: 'docNumber', x: 60, y: 44, w: 90, h: 6, align: 'center' },
    { id: 'docDate', x: 60, y: 51, w: 50, h: 6 },
    { id: 'docTime', x: 120, y: 51, w: 20, h: 6 },
    { id: 'paymentType', x: 60, y: 58, w: 50, h: 6 },
    { id: 'dueDate', x: 120, y: 58, w: 30, h: 6 },
    { id: 'docTitle', x: 65, y: 30, w: 80, h: 6, align: 'center', bold: true },
    { id: 'customerName', x: 140, y: 67, w: 60, h: 6 },
    { id: 'customerBusiness', x: 140, y: 74, w: 60, h: 6 },
    { id: 'customerAddress', x: 140, y: 81, w: 60, h: 6 },
    { id: 'customerVat', x: 140, y: 88, w: 60, h: 6 },
    { id: 'sellerName', x: 10, y: 67, w: 60, h: 6 },
    { id: 'sellerCity', x: 10, y: 74, w: 60, h: 6 },
    { id: 'sellerPostal', x: 10, y: 81, w: 60, h: 6 },
    { id: 'sellerVat', x: 10, y: 88, w: 60, h: 6 },
    { id: 'repName', x: 10, y: 95, w: 60, h: 6 },
    { id: 'notes', x: 40, y: 250, w: 90, h: 12 },
    { id: 'subtotal', x: 150, y: 250, w: 40, h: 6 },
    { id: 'discount', x: 150, y: 256, w: 40, h: 6 },
    { id: 'vatAmount', x: 150, y: 262, w: 40, h: 6 },
    { id: 'totalDue', x: 150, y: 268, w: 40, h: 6, fontPct: 120, bold: true },
    { id: 'paidAmt', x: 150, y: 274, w: 40, h: 6 },
    { id: 'remainingAmt', x: 150, y: 280, w: 40, h: 6 },
    { id: 'pageNo', x: 185, y: 10, w: 20, h: 6, align: 'end' },
    { id: 'qr', x: 12, y: 265, w: 22, h: 24 },
  ],
  table: {
    y: 105, rowMm: 7, rows: 2, fontPct: 90,
    columns: [
      { id: 'sr', x: 10, w: 7, align: 'center' }, { id: 'itemCode', x: 17, w: 18 }, { id: 'barcode', x: 35, w: 30 },
      { id: 'description', x: 65, w: 50 }, { id: 'qty', x: 115, w: 10 }, { id: 'unit', x: 125, w: 15 }, { id: 'unitPrice', x: 140, w: 18 },
      { id: 'discountPct', x: 158, w: 10 }, { id: 'vatPct', x: 168, w: 10 }, { id: 'lineTotal', x: 178, w: 22 },
    ],
  },
};

const layoutOf = (form: PrintForm | undefined = FORM): ResolvedLayout => ({
  design: 'preprinted', logo: 'start', logoSize: 'm', accent: null, tableStyle: 'lines', fontScale: 1, order: [], printer: 'page',
  ...(form ? { form } : {}),
} as unknown as ResolvedLayout);

const pt0: PrintTexts = makePrintTexts(null, (s) => s);
function factsFor(doc: InvoiceDoc, over: Partial<ZatcaPrintDecision> = {}, pt: PrintTexts = pt0): FormInvoiceFacts {
  const zDecision = {
    ...zatcaPrintDecision({ isReturn: !!doc.isReturn, buyerHasTaxNumber: !!doc.customer.taxNumber, saudi: true, taxFree: isDocTaxFree(doc) }, doc.zatca),
    ...over,
  };
  return {
    pt, zDecision, title: pt.title(zDecision.title, { isReturn: !!doc.isReturn, phase2: false }),
    inclusiveDoc: !!doc.pricesIncludeTax, vatRate: '15%', noteRefs: { ref: null, reason: null },
  };
}
const QR = createElement('img', { alt: 'QR', src: 'data:image/png;base64,iVBORw0KGgo=', 'data-test-qr': '1' });

function render(o: { doc?: InvoiceDoc; form?: PrintForm; qr?: ReactNode | null; look?: PrintLook; over?: Partial<ZatcaPrintDecision>; wrap?: (el: ReactElement) => ReactElement } = {}): string {
  const doc = o.doc ?? inv();
  const el = createElement(FormInvoice, {
    doc, facts: factsFor(doc, o.over), look: o.look ?? DEFAULT_PRINT_LOOK, layout: layoutOf(o.form), qr: o.qr === undefined ? QR : o.qr,
  });
  return renderToStaticMarkup(o.wrap ? o.wrap(el) : el);
}
/** الأوراق بالترتيب (نصّ كل ورقة) */
const sheetsOf = (html: string): string[] => html.split('data-form-sheet="').slice(1);
/** صندوق حقلٍ أو خليّة: النصّ من سمته إلى إغلاق عنصره */
function boxOf(html: string, attr: string): string | null {
  const at = html.indexOf(attr);
  if (at < 0) return null;
  return html.slice(at, html.indexOf('</div>', at));
}
const count = (s: string, needle: string): number => s.split(needle).length - 1;

test('المواضع بالمم من ركن الورقة + المعايرة dx/dy — والخط 11pt بنسبته والعريض والمحاذاة', () => {
  const html = render();
  const num = boxOf(html, 'data-form-field="docNumber"')!;
  assert.match(num, /left:61\.5mm;top:42mm;width:90mm;height:6mm/);
  assert.match(num, /line-height:6mm;font-size:11pt/);
  assert.match(num, /text-align:center/);
  assert.match(num, /white-space:nowrap;overflow:hidden;text-overflow:ellipsis/);
  assert.match(num, />SI-2026-000123</);
  const total = boxOf(html, 'data-form-field="totalDue"')!;
  assert.match(total, /left:151\.5mm;top:266mm/);
  assert.match(total, /font-size:13\.2pt;font-weight:700/);
  assert.match(boxOf(html, 'data-form-field="pageNo"')!, /text-align:end/);
  assert.match(boxOf(html, 'data-form-field="customerName"')!, /text-align:start/);
  // بلا معايرة: المحفوظ كما هو
  const plain = render({ form: { ...FORM, dxMm: 0, dyMm: 0 } });
  assert.match(boxOf(plain, 'data-form-field="docNumber"')!, /left:60mm;top:44mm/);
  // صفوف الجدول: أعلى الصفّ y + i×rowMm + dy، والعمود x + dx، والخطّ بنسبة الجدول
  const r1 = boxOf(html, 'data-form-col="description"')!;
  assert.match(r1, /left:66\.5mm;top:103mm;width:50mm;height:7mm/);
  assert.match(r1, /font-size:9\.9pt/);
  const row2 = html.slice(html.indexOf('data-form-row="2"'));
  assert.match(boxOf(row2, 'data-form-col="description"')!, /top:110mm/);
});

test('الأوراق: الجذر data-print-layout="preprinted"، وكل ورقة بعرض الورق وطوله ناقص نصف مم مقصوصة، والفاصل بين الأوراق وحدها', () => {
  const html = render();
  assert.match(html, /^<div[^>]*data-print-layout="preprinted"/);
  assert.match(html, /data-form-sheets="3"/);
  const sheets = sheetsOf(html);
  assert.equal(sheets.length, 3, '5 أصناف بصفّين لكل ورقة ⇒ 3 أوراق');
  for (const s of sheets) assert.match(s, /^\d+" style="position:relative;width:210mm;height:296\.5mm;overflow:hidden/);
  assert.equal(count(html, 'break-after:page'), 2);
  assert.equal(count(html, 'page-break-after:always'), 2);
  assert.ok(!sheets[2].slice(0, 200).includes('break-after'), 'لا فاصل بعد الأخيرة');
  // A5 من مظهر القالب
  const a5 = render({ look: { ...DEFAULT_PRINT_LOOK, pdfFormat: 'a5' } });
  assert.match(a5, /data-form-sheet="1" style="position:relative;width:148mm;height:209\.5mm/);
});

test('التقسيم: الرأس في كل ورقة، والإجماليات ورمز QR على الأخيرة وحدها، والتسلسل متّصل، ورقم الصفحة n/m', () => {
  const sheets = sheetsOf(render());
  sheets.forEach((s, i) => {
    assert.ok(s.includes('data-form-field="docNumber"'), `رقم المستند في الورقة ${i + 1}`);
    assert.ok(s.includes('data-form-field="customerName"'));
    assert.match(boxOf(s, 'data-form-field="pageNo"')!, new RegExp(`>${i + 1}/3<`));
    const last = i === sheets.length - 1;
    for (const id of ['totalDue', 'subtotal', 'discount', 'vatAmount', 'notes', 'paidAmt', 'remainingAmt']) {
      assert.equal(s.includes(`data-form-field="${id}"`), last, `${id} في الورقة ${i + 1}`);
    }
    assert.equal(s.includes('data-form-qr'), last, 'رمز QR على الأخيرة وحدها');
  });
  assert.deepEqual(sheets.map((s) => [...s.matchAll(/data-form-row="(\d+)"/g)].map((m) => Number(m[1]))), [[1, 2], [3, 4], [5]]);
  // التسلسل في الورقة الثالثة 5، وأعلى صفّها الأول كأعلى الورقة الأولى
  assert.match(boxOf(sheets[2], 'data-form-col="sr"')!, />5</);
  assert.match(boxOf(sheets[2], 'data-form-col="sr"')!, /top:103mm/);
  // مستندٌ بلا أصناف ورقةٌ واحدة برأسه وإجمالياته
  const one = sheetsOf(render({ doc: inv({ items: [] }) }));
  assert.equal(one.length, 1);
  assert.ok(one[0].includes('data-form-field="totalDue"') && one[0].includes('>1/1<'));
  // بلا جدول: ورقةٌ واحدة بلا أصناف
  const noTable = render({ form: { ...FORM, table: null } });
  assert.equal(sheetsOf(noTable).length, 1);
  assert.ok(!noTable.includes('data-form-row'));
});

test('القيم كالقالب ثنائي اللغة: الدفع والعنوان والبائع والتواريخ والملاحظات والباركود وسعر الوحدة قبل الضريبة في الشامل', () => {
  const html = render();
  const v = (id: string) => boxOf(html, `data-form-field="${id}"`);
  assert.match(v('paymentType')!, />آجل</);
  assert.match(v('customerAddress')!, />طريق أنس بن مالك، حي الملقا</);
  assert.match(v('sellerName')!, />مؤسسة مروج الخليج للتجارة</);
  assert.match(v('sellerCity')!, />الرياض</);
  assert.match(v('sellerPostal')!, />14322</);
  assert.match(v('docDate')!, />07\/11\/2026</);
  assert.match(v('docTime')!, />10:42</);
  assert.match(v('dueDate')!, />07\/12\/2026</);
  assert.match(v('notes')!, />التسليم صباحاً</);
  assert.match(v('repName')!, />خالد العتيبي</);
  assert.match(v('totalDue')!, />1,234\.50</);
  assert.match(v('paidAmt')!, />234\.50</);
  assert.match(v('remainingAmt')!, />1,000\.00</);
  assert.match(v('docTitle')!, />فاتورة ضريبية</);
  assert.equal(v('customerBusiness'), null, 'الفارغ لا يُطبع');
  const cells = (col: string) => [...html.matchAll(new RegExp(`data-form-col="${col}"[^>]*>(?:<span[^>]*>)?([^<]*)<`, 'g'))].map((m) => m[1]);
  assert.deepEqual(cells('barcode'), ['6281000001', '6281000002', '6281000003', '6281000004', '6281000005']);
  assert.deepEqual(cells('itemCode').slice(0, 2), ['P-1', 'P-2']);
  // الشامل والتفصيل ظاهر: 11.50 شاملاً ⇒ 10.00 قبل الضريبة (كالقالب ثنائي اللغة)، والإجمالي كما خُزّن
  assert.deepEqual(cells('unitPrice').slice(0, 1), ['10.00']);
  assert.deepEqual(cells('lineTotal').slice(0, 2), ['11.50', '23.00']);
  assert.deepEqual(cells('discountPct'), ['10%'], 'نسبة الخصم للبند المخصوم وحده');
  assert.deepEqual(cells('vatPct').slice(0, 1), ['15%']);
  // النقدي، والتقسيط، والمرتجع بلا طريقة دفع ولا مدفوع/متبقٍّ وعنوانه من القرار
  assert.match(boxOf(render({ doc: inv({ type: 'CASH' }) }), 'data-form-field="paymentType"')!, />نقدي</);
  assert.match(boxOf(render({ doc: inv({ paymentPlan: 'INSTALLMENT' }) }), 'data-form-field="paymentType"')!, />تقسيط</);
  const ret = render({ doc: inv({ isReturn: true }) });
  assert.equal(boxOf(ret, 'data-form-field="paymentType"'), null);
  assert.equal(boxOf(ret, 'data-form-field="paidAmt"'), null);
  assert.match(boxOf(ret, 'data-form-field="docTitle"')!, />إشعار دائن مرتجع</);
});

test('«إزالة الضريبة»: لا عبارة ضريبة ولا رقم ضريبيّ ولا رمز (ولو مُرِّرت عقدته) ولا عمود نسبة ولا مبلغ ضريبة', () => {
  const doc = inv({ taxFree: true, tax: 0, total: 1073.48, items: [1, 2, 3].map((n) => item(n, { taxPct: 0 })) as InvoiceDoc['items'], pricesIncludeTax: false });
  for (const valueLang of ['ar', 'en'] as const) {
    const html = render({ doc, form: { ...FORM, valueLang } });
    assert.equal(firstTaxMention(html), null, `${valueLang}: ذكرٌ للضريبة`);
    assert.ok(!html.includes(SELLER_VAT) && !html.includes(BUYER_VAT), 'رقمٌ ضريبيّ');
    assert.ok(!html.includes('data-test-qr') && !html.includes('data-form-qr'), 'رمز QR');
    for (const id of ['customerVat', 'sellerVat', 'vatAmount']) assert.ok(!html.includes(`data-form-field="${id}"`), id);
    assert.ok(!html.includes('data-form-col="vatPct"'));
    assert.match(boxOf(html, 'data-form-field="docTitle"')!, valueLang === 'ar' ? />فاتورة</ : />Invoice</);
  }
  // المرتجع المعفى: «فاتورة مرتجع»
  const ret = render({ doc: { ...doc, isReturn: true } });
  assert.equal(firstTaxMention(ret), null);
  assert.match(boxOf(ret, 'data-form-field="docTitle"')!, />فاتورة مرتجع</);
});

test('حقول الضريبة متى أظهر القرار تفصيلها ولم يُخفِ أرقامها وحده — وسعر الوحدة كما هو بلا تفصيل', () => {
  const on = render();
  for (const id of ['customerVat', 'sellerVat', 'vatAmount']) assert.ok(on.includes(`data-form-field="${id}"`), id);
  assert.ok(on.includes(SELLER_VAT) && on.includes(BUYER_VAT));
  assert.match(boxOf(on, 'data-form-field="vatAmount"')!, />161\.02</);
  // سند التسليم/المُبطل (showTaxBreakdown:false): لا ضريبة، والسعر الشامل كما خُزّن
  const off = render({ over: { showTaxBreakdown: false } });
  for (const id of ['customerVat', 'sellerVat', 'vatAmount']) assert.ok(!off.includes(`data-form-field="${id}"`), id);
  assert.ok(!off.includes('data-form-col="vatPct"'));
  assert.match(boxOf(off, 'data-form-col="unitPrice"')!, />11\.50</);
  // hideTaxIds وحده يكفي
  const hidden = render({ over: { hideTaxIds: true } });
  assert.ok(!hidden.includes(SELLER_VAT) && !hidden.includes('data-form-field="vatAmount"'));
});

test('رمز QR من الخاصية وحدها: في مربعه على الأخيرة بضلع min(w,h)، وبلا عقدةٍ لا مربع ولا قاعدة', () => {
  const html = render();
  assert.equal(count(html, 'data-test-qr'), 1);
  const box = boxOf(html, 'data-form-qr')!;
  assert.match(box, /left:13\.5mm;top:263mm;width:22mm;height:24mm;overflow:hidden/);
  assert.match(html, /\[data-form-qr\] img\[alt=QR\] \{ display: block !important; width: 22mm !important; height: 22mm !important;/);
  const none = render({ qr: null });
  assert.ok(!none.includes('data-form-qr') && !none.includes('img[alt=QR]'));
  // بلا حقل QR (الشركة حذفت الرمز صراحةً): العقدة لا تُطبع
  const noField = render({ form: { ...FORM, fields: FORM.fields.filter((f) => f.id !== 'qr') } });
  assert.ok(!noField.includes('data-test-qr'));
});

test('لغة القيم: الإنجليزية لطريقة الدفع والعنوان — والبيانات كما هي', () => {
  const html = render({ form: { ...FORM, valueLang: 'en' } });
  assert.match(boxOf(html, 'data-form-field="paymentType"')!, /dir="ltr"[^>]*>Credit</);
  assert.match(boxOf(html, 'data-form-field="docTitle"')!, />Tax Invoice</);
  assert.match(boxOf(html, 'data-form-field="customerName"')!, />سوبرماركت النخبة</);
  assert.match(boxOf(render({ doc: inv({ type: 'CASH' }), form: { ...FORM, valueLang: 'en' } }), 'data-form-field="paymentType"')!, />Cash</);
  assert.match(boxOf(render({ doc: inv({ paymentPlan: 'INSTALLMENT' }), form: { ...FORM, valueLang: 'en' } }), 'data-form-field="paymentType"')!, />Installments</);
});

test('الأرقام: اللاتينية 0-9، وأرقام الشركة العربية-الهندية للمبالغ والتواريخ والتسلسل ورقم الصفحة — والمعرّفات كما هي', () => {
  setActiveNumerals('arabic');
  try {
    const html = render({ form: { ...FORM, latinDigits: false } });
    assert.match(boxOf(html, 'data-form-field="totalDue"')!, />١٬٢٣٤٫٥٠</);
    assert.match(boxOf(html, 'data-form-field="docDate"')!, />٠٧\/١١\/٢٠٢٦</);
    assert.match(boxOf(html, 'data-form-field="docTime"')!, />١٠:٤٢</);
    assert.match(boxOf(html, 'data-form-field="pageNo"')!, />١\/٣</);
    assert.match(boxOf(html, 'data-form-col="sr"')!, />١</);
    assert.match(boxOf(html, 'data-form-col="discountPct"')!, />١٠٪</);
    // المعرّفات (رقم المستند والباركود والرقم الضريبي) لاتينيةٌ دائماً
    assert.match(boxOf(html, 'data-form-field="docNumber"')!, />SI-2026-000123</);
    assert.match(boxOf(html, 'data-form-col="barcode"')!, />6281000001</);
    // شركةٌ أرقامها لاتينية: لاتينية ولو لم يطلبها النموذج
    setActiveNumerals('latin');
    assert.match(boxOf(render({ form: { ...FORM, latinDigits: false } }), 'data-form-field="totalDue"')!, />1,234\.50</);
  } finally {
    setActiveNumerals('arabic');
  }
  assert.match(boxOf(render(), 'data-form-field="totalDue"')!, />1,234\.50</);
});

test('الخلفية: صورة النموذج تحت القيم بالمعايرة متى جهزت — وتعذّرها يطبع القيم وحدها مع علم data-form-bg', async () => {
  const REF = { id: '3f2b8c1e-1234-4abc-9def-0123456789ab', v: 'a1b2c3d4e5f60718', wPx: 1240, hPx: 1754 };
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0xff, 0xd9]);
  const okLoader = createFormImageLoader({ fetch: async () => JPEG });
  await okLoader.load(REF);
  const withBg = { ...FORM, image: REF, background: true };
  const wrapWith = (loader: ReturnType<typeof createFormImageLoader>) => (el: ReactElement) => createElement(FormImageLoaderContext.Provider, { value: loader }, el);
  const html = render({ form: withBg, wrap: wrapWith(okLoader) });
  assert.match(html, /^<div[^>]*data-form-bg="ready"/);
  // الصورة مرّةً واحدة (أسلوب الجذر) لا في كل ورقة — وكل ورقةٍ طبقةٌ فارغةٌ بها، بلا <img> فلا يمسّها مرشّح الأبيض والأسود
  assert.equal(count(html, 'data:image/jpeg;base64,'), 1, 'مرّةً واحدة');
  assert.equal(count(html, '<style data-form-bg-css="">'), 1);
  assert.equal(count(html, 'data-form-bg-layer=""'), 3, 'طبقةٌ في كل ورقة');
  assert.ok(!html.includes('<img src="data:image/jpeg'), 'لا <img> للخلفية');
  assert.match(html, /data-form-bg-layer="" style="position:absolute;left:1\.5mm;top:-2mm;width:210mm;height:297mm/);
  // بلا علامات اقتباس: نصّ <style> يُهرَّب في تصيير الخادم (&quot;) فيفسد الرابط
  assert.match(html, /\[data-form-bg-layer\] \{ background-image: url\(data:image\/jpeg;base64,[A-Za-z0-9+/=]+\) !important;/);
  assert.ok(!/url\((&quot;|"|')/.test(html.slice(html.indexOf('data-form-bg-css'))), 'لا اقتباس');
  // أول عنصرٍ في الورقة: تحت القيم
  assert.match(sheetsOf(html)[0], /^\d+" style="[^"]*"><div aria-hidden="true" data-form-bg-layer=""/);
  // مظهر الأبيض والأسود (mono): مرشّحه لـ<img> وحدها — والخلفية طبقةٌ لا صورة
  const mono = render({ form: withBg, wrap: wrapWith(okLoader), look: { ...DEFAULT_PRINT_LOOK, mono: true } as PrintLook });
  assert.ok(!/<img[^>]*data-form-bg/.test(mono));
  // ومحوُ المظهر للخلفيات (background: transparent !important) لا يمحوها: محدِّدٌ أخصّ بـ!important
  assert.match(mono, /\[data-print-layout=preprinted\] \[data-form-bg-layer\] \{ background-image: url\([^)]*\) !important/);
  assert.match(mono, /\[data-print-look~=(&quot;|")mono(&quot;|")\] \* \{[^}]*background: transparent !important/);
  // الخلفية مطفأة: لا صورة ولا علم ولا جلب
  let calls = 0;
  const spy = createFormImageLoader({ fetch: async () => { calls++; return JPEG; } });
  const off = render({ form: { ...withBg, background: false }, wrap: wrapWith(spy) });
  assert.ok(!off.includes('data:image/jpeg') && !off.includes('data-form-bg'));
  assert.equal(calls, 0);
  // تعذّر الجلب: القيم وحدها والعلم failed
  const bad = createFormImageLoader({ fetch: async () => { throw new Error('offline'); } });
  await bad.load(REF);
  const failed = render({ form: withBg, wrap: wrapWith(bad) });
  assert.match(failed, /^<div[^>]*data-form-bg="failed"/);
  assert.ok(!failed.includes('data:image/jpeg') && !failed.includes('data-form-bg-layer'));
  assert.ok(failed.includes('data-form-field="docNumber"'));
});

test('ما لا يُحذف بحذف حقله: علامة البروفة وتنبيه سند التسليم في شريط أعلى كل ورقة (إلا بحذف الأختام صراحةً) — بالمعايرة', () => {
  const doc = inv({ items: [1, 2, 3].map((n) => item(n)) as InvoiceDoc['items'] });
  const NOTICE = 'سلمت البضاعة وبانتظار اعتماد الهيئة وتصلك الفاتورة الضريبية المعتمدة بعد الاعتماد';
  const el = (layout: ResolvedLayout) => createElement(FormInvoice, {
    doc, facts: factsFor(doc, { kind: 'deliveryNote', title: 'سند تسليم', notice: NOTICE, watermark: 'بروفة — ليست فاتورة', showTaxBreakdown: false, qr: { source: 'none', value: null, caption: null } } as Partial<ZatcaPrintDecision>),
    look: DEFAULT_PRINT_LOOK, layout, qr: null,
  });
  const html = renderToStaticMarkup(el(layoutOf()));
  const sheets = sheetsOf(html);
  assert.equal(sheets.length, 2);
  for (const sh of sheets) {
    const band = boxOf(sh, 'data-form-marks=""')!;
    assert.ok(band, 'الشريط في كل ورقة');
    assert.match(band, /left:9\.5mm;top:0mm;width:194mm/, 'بين هامشين 8 مم + المعايرة (1.5، −2)');
  }
  assert.ok(sheets[0].includes(NOTICE) && sheets[0].includes('بروفة — ليست فاتورة'));
  assert.match(sheets[0], /font-weight:700"><span dir="auto"[^>]*>بروفة — ليست فاتورة/);
  // حذف الأختام صراحةً (stamps:false) يُسقط العلامة والتنبيه كالقالب ثنائي اللغة
  const off = renderToStaticMarkup(el({ ...layoutOf(), stamps: false } as ResolvedLayout));
  assert.ok(!off.includes(NOTICE) && !off.includes('data-form-marks'));
  // فاتورة عادية: لا شريط
  assert.ok(!render().includes('data-form-marks'));
});

test('الإشعار: الفاتورة الأصلية وسببه في حقليهما متى وُضعا — وإلا ففي شريط أعلى الورقة بتسميتهما (بلغة القيم)', () => {
  const doc = inv({ isReturn: true });
  const facts = { ...factsFor(doc), noteRefs: { ref: 'SI-2026-000100', reason: 'بضاعة تالفة' } };
  const render2 = (form: PrintForm) => renderToStaticMarkup(createElement(FormInvoice, { doc, facts, look: DEFAULT_PRINT_LOOK, layout: layoutOf(form), qr: null }));
  /** الشريط كلّه (سطوره عناصر div متتالية داخله) */
  const marksOf = (html: string): string => { const at = html.indexOf('data-form-marks=""'); return at < 0 ? '' : html.slice(at, html.indexOf('</div></div>', at)); };
  // بلا حقليهما: الشريط بالتسمية
  const band = marksOf(render2(FORM));
  assert.match(band, /الفاتورة الأصلية: SI-2026-000100/);
  assert.match(band, /سبب الإرجاع: بضاعة تالفة/);
  const en = marksOf(render2({ ...FORM, valueLang: 'en' }));
  assert.match(en, /Original invoice: SI-2026-000100/);
  assert.match(en, /Return reason: بضاعة تالفة/);
  // بحقليهما: في موضعيهما ولا شريط
  const placed = render2({ ...FORM, fields: [...FORM.fields, { id: 'originalRef', x: 10, y: 20, w: 50, h: 6 }, { id: 'noteReason', x: 70, y: 20, w: 60, h: 6 }] });
  assert.ok(!placed.includes('data-form-marks'));
  assert.match(boxOf(placed, 'data-form-field="originalRef"')!, /left:11\.5mm;top:18mm;width:50mm;height:6mm[\s\S]*dir="ltr"[^>]*>SI-2026-000100</);
  assert.match(boxOf(placed, 'data-form-field="noteReason"')!, />بضاعة تالفة</);
  // فاتورة البيع (لا مرجع): لا حقل ولا شريط
  const sale = renderToStaticMarkup(createElement(FormInvoice, { doc: inv(), facts: factsFor(inv()), look: DEFAULT_PRINT_LOOK, layout: layoutOf({ ...FORM, fields: [...FORM.fields, { id: 'originalRef', x: 10, y: 20, w: 50, h: 6 }] }), qr: null }));
  assert.ok(!sale.includes('data-form-field="originalRef"') && !sale.includes('data-form-marks'));
});

test('لغة القيم الإنجليزية: عنوان الشركة الإنجليزي من نصوص مطبوعاتها قبل القاموس', () => {
  const doc = inv();
  const base = factsFor(doc);
  const pt = { ...base.pt, on: true, lang: 'en' } as PrintTexts;
  const facts = { ...base, pt, title: { text: 'فاتورة ضريبية', alt: 'Sales Invoice — Murouj' } };
  const html = renderToStaticMarkup(createElement(FormInvoice, { doc, facts, look: DEFAULT_PRINT_LOOK, layout: layoutOf({ ...FORM, valueLang: 'en' }), qr: QR }));
  assert.match(boxOf(html, 'data-form-field="docTitle"')!, /dir="ltr"[^>]*>Sales Invoice — Murouj</);
  // بلا صياغةٍ للشركة: القاموس كما كان
  assert.match(boxOf(render({ form: { ...FORM, valueLang: 'en' } }), 'data-form-field="docTitle"')!, />Tax Invoice</);
  // ولغة القيم العربية: العنوان العربي
  const ar = renderToStaticMarkup(createElement(FormInvoice, { doc, facts, look: DEFAULT_PRINT_LOOK, layout: layoutOf(FORM), qr: QR }));
  assert.match(boxOf(ar, 'data-form-field="docTitle"')!, />فاتورة ضريبية</);
});

test('مقاس الورقة من مظهر القالب: a4 وa5 وletter و«العرض×الطول» — والمجهول A4', () => {
  assert.deepEqual(formSheetOfLook({ pdfFormat: 'a4' }), { widthMm: 210, lengthMm: 297 });
  assert.deepEqual(formSheetOfLook({ pdfFormat: 'a5' }), { widthMm: 148, lengthMm: 210 });
  assert.deepEqual(formSheetOfLook({ pdfFormat: 'letter' }), { widthMm: 215.9, lengthMm: 279.4 });
  assert.deepEqual(formSheetOfLook({ pdfFormat: '200x148.5' }), { widthMm: 200, lengthMm: 148.5 });
  assert.deepEqual(formSheetOfLook({ pdfFormat: 'x' }), { widthMm: 210, lengthMm: 297 });
});

test('PrintableInvoice: قالب النموذج المطبوع مسبقاً يرسم FormInvoice بقرار القالب ورمزه المحروس — والمعفى بلا رمز', () => {
  const base: PrintProfile = {
    id: 'a4-form', name: 'نموذج مروج', printer: 'page', template: 'page_branded', paper: presetPaper('a4')!, options: defaultPrintOptions('page'),
  };
  const p = withDesign(base, 'preprinted');
  assert.equal(p.options.layout?.design, 'preprinted');
  const look = lookFor(p);
  assert.equal(look.layout?.design, 'preprinted');
  const a4 = (doc: InvoiceDoc) => renderToStaticMarkup(createElement(PrintLookContext.Provider, { value: look }, createElement(PrintableInvoice, { doc })));
  const html = a4(inv());
  assert.match(html, /^<div[^>]*data-print-layout="preprinted"/);
  assert.ok(html.includes('data-form-sheet="1"'));
  assert.ok(html.includes('>SI-2026-000123<'));
  // الرمز كتلة القالب نفسها في مربعه (البداية المقترحة فيها حقل QR) — لا إطار ولا عنوان ولا شعار من القالب الحالي
  assert.ok(html.includes('data-form-qr'));
  assert.ok(html.includes('alt="QR"'));
  assert.ok(!html.includes('data-grid-qr') && !html.includes('data-section='));
  // المعفى: لا رمز ولا ضريبة (taxFreeView في القالب يُسقط الرقمين)
  const free = a4(inv({ taxFree: true, tax: 0, items: [item(1, { taxPct: 0 })] as InvoiceDoc['items'], pricesIncludeTax: false }));
  assert.ok(!free.includes('alt="QR"') && !free.includes(SELLER_VAT) && !free.includes(BUYER_VAT));
  assert.equal(firstTaxMention(free), null);
});

test('invoiceDocFromDetail: الباركود والملاحظات وتاريخ الاستحقاق متى وُجدت وحدها — والشكل كما كان بدونها', () => {
  const row = {
    number: 'SI-1', invoiceDate: '2026-11-07T10:00:00Z', type: 'CASH', customer: { name: 'ع' }, items: [
      { product: { name: 'أ', code: 'P-1', barcode: ' 6281 ' }, qty: 1, unitPrice: 1, discountPct: 0, taxPct: 15, lineTotal: 1.15 },
      { product: { name: 'ب', barcode: '  ' }, qty: 1, unitPrice: 1, discountPct: 0, taxPct: 15, lineTotal: 1.15 },
    ],
    subtotal: 2, discountAmt: 0, taxAmt: 0.3, total: 2.3, paidAmt: 2.3, remainingAmt: 0, notes: ' ملاحظة ', dueDate: '2026-12-01T00:00:00Z',
  };
  const d = invoiceDocFromDetail(row, 'م');
  assert.equal(d.items[0].barcode, '6281');
  assert.ok(!('barcode' in d.items[1]));
  assert.equal(d.notes, 'ملاحظة');
  assert.equal(d.dueDate, '2026-12-01T00:00:00Z');
  const bare = invoiceDocFromDetail({ ...row, notes: null, dueDate: null, items: [{ ...row.items[0], product: { name: 'أ' } }] }, 'م');
  assert.ok(!('notes' in bare) && !('dueDate' in bare) && !('barcode' in bare.items[0]));
  assert.ok(!('dueDate' in invoiceDocFromDetail({ ...row, dueDate: 'not a date' }, 'م')));
});

test('حرّاس المصدر: لا بناء رمز ولا قيمة رمز ولا قرار ولا تباعد أحرف ولا استيراد تشغيليّ من RepDocuments', () => {
  const src = readFileSync(new URL('./printPreprinted.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /buildZatcaQr|QRCode|data-qr-value|data-qr-ec|zatcaPrintDecision\(|buyerNotice|letterSpacing|letter-spacing|qrcode/);
  assert.doesNotMatch(src, /^import (?!type ).*from '\.\/RepDocuments'/m);
  // الفرع في PrintableInvoice بعد القرار والعنوان والرمز المحروس، وبالحقائق نفسها
  const rep = readFileSync(new URL('./RepDocuments.tsx', import.meta.url), 'utf8');
  const a4 = rep.slice(rep.indexOf('export const PrintableInvoice = forwardRef'), rep.indexOf("PrintableInvoice.displayName = 'PrintableInvoice';"));
  const at = a4.indexOf("if (layout?.design === 'preprinted') {");
  assert.ok(at > a4.indexOf("if (layout?.design === 'grid_bilingual') {"));
  assert.ok(at > a4.indexOf('const qrShown = '));
  assert.match(a4, /<FormInvoice ref=\{ref\} doc=\{doc\} facts=\{\{ pt, zDecision, title: docTitle, inclusiveDoc, vatRate, noteRefs \}\} look=\{look\} layout=\{layout\} qr=\{qrShown\} \/>/);
});

test('الخلفية عند الطباعة: تنبيه «بلا خلفية» متى خرجت الورقة قبل جهوزها أو تعذّرت — وتطبيق المندوب يجلب صورها مسبقاً بعد إعدادات الشركة', () => {
  const rep = readFileSync(new URL('./RepDocuments.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(rep.includes("setFormBgSkipped(['loading', 'failed'].includes(formRoot?.getAttribute('data-form-bg') ?? ''));"));
  assert.ok(rep.includes("{(formBg.status === 'failed' || (formBgSkipped && formBg.status !== 'ready')) && ("));
  const app = readFileSync(new URL('./RepApp.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(app.includes('const formBgRefs = formBackgroundRefsOf(company?.printSettings);'));
  assert.ok(app.includes('void prefetchFormImages(defaultFormImageLoader(), formBgRefs);'));
});
