/**
 * «تخطيط المطبوعات» و«حذف السطر» على قالب A4 الحالي (الفاتورة والسند) — طلبا المالك ٣ نوفمبر ٢٠٢٦ (pl_spec v2، الحزمة P4a).
 *
 * ١) ملفٌّ بلا options.layout ⇒ لا سمة ولا تغيير (الذهبيّ printA4.baseline.test.ts يثبت الحرف) — وتخطيطٌ بقيم اليوم لا يغيّر إلا سمة الجذر.
 * ٢) مكان الشعار وحجمه، ولون التمييز، وشكل الجدول، وحجم الخط، وترتيب الأقسام.
 * ٣) «حذف السطر»: كل مفتاحٍ يُحذف بوحدته كاملة (التسمية وقيمتها، العمود، صفّ الإجمالي، الصندوق، الخانة) — ومنها ما كان مقفلاً:
 *    الرقم الضريبي للمشتري، والعنوان، والإجماليات وصفوف الضريبة، وسطر المنصّة. والرمز المختوم يبقى مهما حُذف ومهما رُتّب.
 * ٤) القالب ثنائي اللغة يُختار من التخطيط ويأخذ رمزه من كتلة A4 نفسها. ٥) بانية المستند تنقل رمز الصنف وضريبة السطر والرمز البريدي.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintableInvoice, PrintableReceipt, invoiceDocFromDetail, type Company, type InvoiceDoc, type ReceiptDoc } from './RepDocuments';
import { DEFAULT_PRINT_LOOK, PrintLookContext, lookFor, type PrintLook } from './printLook';
import {
  defaultPrintLayout, defaultPrintOptions, presetPaper, type PrintLayout, type PrintProfile, type PrinterType, type TemplateId,
} from '../lib/print/printSettings';
import { PRINT_TEXT_CATALOG, PRINT_TEXT_LINE, type PrintTextsV1 } from '../lib/print/printTexts';
import type { ZatcaDocView } from '../lib/zatca/docStatus';
import { useLang } from '../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';

process.env.TZ = 'Asia/Riyadh';
useLang.setState({ lang: 'ar' });
setActiveNumerals('latin');
setActiveCurrency('SAR');

const LOGO = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const STAMPED = 'AQ/YtNix2YPYqSDYp9mE2KfYrtiq2KjYp9ixAg8zMDAwMDAwMDAwMDAwMDMDFDIwMjYtMTEtMDJUMDk6MTU6MDBa';
const COMPANY: Company = {
  name: 'شركة الاختبار للتوزيع', address: 'الرياض، حي العليا', taxNumber: '300000000000003', commercialReg: '1010101010',
  phone: '0501234567', email: 'info@example.sa', logo: LOGO, primaryColor: '#1e3a8a', headerStyle: null, countryCode: 'SA',
};
const B2B = { name: 'محمد العتيبي', businessName: 'مؤسسة الأفق', commercialReg: '1010202020', taxNumber: '311111111111113', phone: '0112345678', address: 'طريق الملك فهد', city: 'الرياض' };

const inv = (over: Partial<InvoiceDoc> = {}, company: Company = COMPANY): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-777', date: '2026-11-02T09:15:00.000Z', type: 'CREDIT', company, customer: B2B, repName: 'أحمد السالم',
  deliveryDate: '2026-11-05T00:00:00.000Z',
  items: [
    { name: 'مياه معدنية', unit: 'كرتون', qty: 2, unitPrice: 23, discountPct: 0, taxPct: 15, lineTotal: 46 },
    { name: 'عصير برتقال', unit: 'حبة', qty: 3, unitPrice: 2.5, discountPct: 10, taxPct: 15, lineTotal: 6.75 },
  ],
  subtotal: 48.5, discount: 2.5, tax: 6.88, total: 52.75, pricesIncludeTax: true, paidAmt: 21.5, remainingAmt: 31.25,
  paymentPlan: 'INSTALLMENT', installments: [
    { seq: 1, dueDate: '2026-12-02T00:00:00.000Z', amount: 26.38 }, { seq: 2, dueDate: '2027-01-02T00:00:00.000Z', amount: 26.37 },
  ],
  ...over,
});
const zv = (over: Partial<ZatcaDocView> = {}): ZatcaDocView => ({
  phase: 2, mode: 'live', mirror: 'cleared', documentStatus: 'CLEARED', subtype: '01', documentKind: 'INVOICE', qr: STAMPED, printable: true,
  overdue: false, reportDeadline: null, issuedAt: '2026-11-02T09:15:00.000Z', uuid: '3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c', icv: 41, warnings: 0, ...over,
});
const rcp = (over: Partial<ReceiptDoc> = {}, company: Company = COMPANY): ReceiptDoc => ({
  kind: 'receipt', number: 'RC-55', date: '2026-11-02T11:00:00.000Z', company,
  customer: { name: 'بقالة النور', businessName: 'مؤسسة النور', commercialReg: '4030303030', taxNumber: '399999999999993', phone: '0559998887', address: 'حي الروضة' },
  repName: 'أحمد السالم', amount: 150, paymentMethod: 'CASH', notes: 'دفعة نوفمبر', invoices: [{ number: 'INV-777', amount: 150 }], ...over,
});

const texts = (edits: PrintTextsV1['edits'], over: Partial<PrintTextsV1> = {}): PrintTextsV1 =>
  ({ version: 1, secondLang: null, companyNameAlt: null, companyAddressAlt: null, edits, ...over });
const del = (...keys: string[]) => texts(Object.fromEntries(keys.map((k) => [k, { text: null, alt: null, hidden: true }])));
const withTexts = (c: Company, t: PrintTextsV1 | null): Company => ({ ...c, printTexts: t });

const profile = (printer: PrinterType, template: TemplateId, layout?: Partial<PrintLayout> | null): PrintProfile => ({
  id: 'p-1', name: 'p', printer, template, paper: presetPaper(printer === 'impact' ? 'ff_a4' : 'a4')!,
  options: { ...defaultPrintOptions(printer), ...(layout === undefined || layout === null ? {} : { layout: { ...defaultPrintLayout(printer), ...layout } }) },
});
const lookOf = (layout?: Partial<PrintLayout> | null, printer: PrinterType = 'page', template: TemplateId = 'page_branded'): PrintLook =>
  lookFor(profile(printer, template, layout));

const render = (el: ReturnType<typeof createElement>, look: PrintLook = DEFAULT_PRINT_LOOK) =>
  renderToStaticMarkup(createElement(PrintLookContext.Provider, { value: look }, el)).replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, 'data:QR');
const a4 = (doc: InvoiceDoc, look?: PrintLook) => render(createElement(PrintableInvoice, { doc }), look);
const a4r = (doc: ReceiptDoc, look?: PrintLook) => render(createElement(PrintableReceipt, { doc }), look);
const strip = (h: string) => h.replace(/ data-print-layout="[^"]*"/, '');

// ─── ١) بلا تخطيط = اليوم، وتخطيطٌ بقيم اليوم لا يغيّر إلا سمة الجذر ───

test('ملفٌّ بلا تخطيط: لا سمة data-print-layout ولا مفتاح layout في المظهر — وتخطيط الصفحة الافتراضي لا يغيّر حرفاً سوى السمة', () => {
  const plain = lookOf(null);
  assert.equal('layout' in plain, false, 'المظهر بلا تخطيط يحمل المفتاح');
  const ref = a4(inv(), plain);
  assert.ok(!ref.includes('data-print-layout'));
  assert.equal(ref, a4(inv(), DEFAULT_PRINT_LOOK), 'page_branded بلا تخطيط ≠ اليوم');
  const dflt = lookOf({});
  assert.equal(dflt.layout?.design, 'standard');
  const out = a4(inv(), dflt);
  assert.ok(out.includes('data-print-layout="standard"'));
  assert.equal(strip(out), ref, 'التخطيط الافتراضي غيّر الورقة');
  assert.equal(strip(a4r(rcp(), dflt)), a4r(rcp(), plain), 'السند بالتخطيط الافتراضي تغيّر');
  // الإشعارات والكشف لا تأخذ التخطيط: الترويسة لا تُمرَّر إليها
});

// ─── ٢) مقابض التخطيط ───

test('مكان الشعار وحجمه: يمين الاسم (اليوم) أو الوسط أو بجانب العنوان أو بلا شعار — بالأحجام 34/42/56', () => {
  const img = (h: string) => [...h.matchAll(/<img src="data:image\/gif[^>]*>/g)].map((m) => m[0]);
  const start = a4(inv(), lookOf({ logo: 'start', logoSize: 'l' }));
  assert.equal(img(start).length, 1);
  assert.match(img(start)[0], /width:56px/);
  const center = a4(inv(), lookOf({ logo: 'center', logoSize: 's' }));
  assert.match(center, /<div style="align-self:center"><img src="data:image\/gif[^>]*width:34px/, 'الشعار ليس في الوسط');
  const end = a4(inv(), lookOf({ logo: 'end' }));
  // بجانب العنوان: العنوان ثم الشعار داخل صفٍّ واحد
  assert.match(end, /فاتورة ضريبية<\/div><img src="data:image\/gif[^>]*width:42px/, 'الشعار ليس بجانب العنوان');
  assert.equal(img(a4(inv(), lookOf({ logo: 'none' }))).length, 0, 'بلا شعار طُبع الشعار');
  // الأشكال الثلاثة (بانر وبسيط وكلاسيكي) تتبع المكان
  for (const headerStyle of ['banner', 'minimal', 'classic']) {
    const c = { ...COMPANY, headerStyle };
    assert.equal(img(a4(inv({}, c), lookOf({ logo: 'none' }))).length, 0, `${headerStyle}: بلا شعار`);
    assert.match(a4(inv({}, c), lookOf({ logo: 'center' })), /align-self:center"><img/, `${headerStyle}: الوسط`);
  }
  // السند كالفاتورة
  assert.match(a4r(rcp(), lookOf({ logo: 'center' })), /align-self:center"><img/);
});

test('لون التمييز يحلّ محلّ لون الشركة في الترويسة ورأس الجدول — ولا أثر له على الأحادي (الأسود)', () => {
  const out = a4(inv(), lookOf({ accent: '#0F766E' }));
  assert.ok(out.includes('background:#0F766E') && out.includes('border-bottom:3px solid #0F766E'), 'لون التمييز لم يُطبَّق');
  assert.ok(!out.includes('#1e3a8a'), 'لون الشركة بقي');
  const mono = a4(inv(), lookOf({ accent: '#0F766E' }, 'page', 'page_plain'));
  assert.ok(!mono.includes('#0F766E') && mono.includes('background:#000'), 'الأحادي أخذ اللون');
  // بلا لون مختار ⇒ لون الشركة كاليوم
  assert.ok(a4(inv(), lookOf({ accent: null })).includes('background:#1e3a8a'));
});

test('شكل الجدول: شبكة (حدود لكل خلية) ومخطّط (صفوف متناوبة) — والخطوط كاليوم', () => {
  const grid = a4(inv(), lookOf({ tableStyle: 'grid' }));
  assert.match(grid, /<td style="[^"]*border:1px solid #d1d5db/, 'الشبكة بلا حدود');
  const striped = a4(inv(), lookOf({ tableStyle: 'striped' }));
  assert.match(striped, /<tr style="background:#f9fafb">/, 'المخطّط بلا تناوب');
  assert.equal((striped.match(/<tr style="background:#f9fafb">/g) || []).length, 1, 'صفٌّ واحد من اثنين');
  assert.equal(strip(a4(inv(), lookOf({ tableStyle: 'lines' }))), a4(inv()));
});

test('حجم الخط: zoom على جذر الورقة مع التخطيط وحده (والملف القديم بخط 1.15 كاليوم)', () => {
  const p = profile('page', 'page_branded', {});
  p.options = { ...p.options, fontScale: 1.15 };
  assert.match(a4(inv(), lookFor(p)), /^<div style="[^"]*zoom:1\.15"/);
  const old = profile('page', 'page_branded', null);
  old.options = { ...old.options, fontScale: 1.15 };
  assert.equal(a4(inv(), lookFor(old)), a4(inv()), 'ملفٌّ بلا تخطيط تغيّر بحجم الخط');
});

test('ترتيب الأقسام: الأقسام تُرسم بترتيب الملف — والرمز المختوم في الإجماليات أينما وقعت', () => {
  const order = ['header', 'items', 'totals', 'info', 'note', 'installments', 'signatures', 'footer'] as PrintLayout['order'];
  const doc = inv({ zatca: zv() });
  const out = a4(doc, lookOf({ order }));
  const at = (s: string) => { const i = out.indexOf(s); assert.ok(i > 0, s); return i; };
  assert.ok(at('<table') < at('بيانات الفاتورة'), 'الأصناف لم تسبق بيانات الفاتورة');
  assert.ok(at('alt="QR"') < at('بيانات الفاتورة'), 'الإجماليات لم تسبق بيانات الفاتورة');
  assert.ok(at('بيانات الفاتورة') < at('جدول الأقساط'));
  assert.ok(out.indexOf('شكرا لتعاملكم معنا') > at('جدول الأقساط'), 'التذييل ليس آخراً');
  assert.equal((out.match(/alt="QR"/g) || []).length, 1);
  // الترتيب الافتراضي = اليوم
  assert.equal(strip(a4(doc, lookOf({ order: defaultPrintLayout('page').order }))), a4(doc));
});

// ─── ٣) حذف السطر ───

/** وحدة كل مفتاح على A4 الحالي: نصٌّ (أو أكثر) يختفي بحذفه — والوحدة كاملة: التسمية والقيمة */
const INVOICE_UNITS: Record<string, string[]> = {
  'h.taxNumber': ['300000000000003'], 'h.commercialReg': ['1010101010'], 'h.address': ['الرياض، حي العليا'],
  'h.phone': ['0501234567'], 'h.email': ['info@example.sa'],
  'inv.infoHeading': ['بيانات الفاتورة', 'INV-777', 'وقت الإصدار'], // «block»: الصندوق كلّه
  'inv.number': ['رقم الفاتورة', 'INV-777'], 'inv.date': ['>التاريخ'], 'inv.time': ['وقت الإصدار'],
  'inv.type': ['>النوع', 'تقسيط'], 'inv.deliveryDate': ['تاريخ التسليم'], 'inv.rep': ['>المندوب', 'أحمد السالم'],
  'cust.heading': ['بيانات العميل', 'محمد العتيبي', '311111111111113'], // «block»
  'cust.name': ['>الاسم', 'محمد العتيبي'], 'cust.business': ['مؤسسة الأفق'], 'cust.commercialReg': ['1010202020'],
  'cust.taxNumber': ['311111111111113'], 'cust.phone': ['0112345678'], 'cust.address': ['طريق الملك فهد'],
  'col.seq': ['>#</th>'], 'col.item': ['>الصنف', 'مياه معدنية', 'عصير برتقال'], 'col.qty': ['>الكمية'],
  'col.priceIncl': ['السعر شامل الضريبة', '23.00'], 'col.price': ['السعر شامل الضريبة', '23.00'], 'col.discount': ['>الخصم</th>', '>10%<'],
  'col.tax': ['>الضريبة</th>', '>15%<'], 'col.total': ['>الإجمالي</th>', '46.00'],
  'item.beforeTax': ['قبل الضريبة'], 'note.pricesIncl': ['الأسعار المعروضة شاملة'],
  'tot.subtotal': ['المجموع قبل الخصم', '48.50'], 'tot.discount': ['<span>الخصم</span>'], 'tot.taxable': ['الوعاء الخاضع للضريبة', '45.87'],
  'tot.vatIncl': ['منها ضريبة القيمة المضافة', '6.88'], 'tot.vat': ['منها ضريبة القيمة المضافة', '6.88'],
  'tot.grand': ['الإجمالي النهائي', '52.75'], 'tot.paid': ['المدفوع', '21.50'], 'tot.remaining': ['المتبقي', '31.25'],
  'inst.heading': ['جدول الأقساط', '26.38', 'مجموع الأقساط'], // «block»: الجدول كلّه
  'inst.dueDate': ['تاريخ الاستحقاق'], 'inst.amount': ['>المبلغ<', '26.38'], 'inst.sum': ['مجموع الأقساط'],
  'inst.note': ['الضريبة مستحقة بالكامل'], 'sig.recipient': ['توقيع المستلم'], 'sig.rep': ['توقيع المندوب'],
  'foot.thanks': ['شكرا لتعاملكم معنا'], 'foot.company': ['— شركة الاختبار'], 'foot.platform': ['Field Sales · fieldsa.net'],
  'qr.caption': ['رمز الاستجابة السريعة للفاتورة الضريبية'],
};

test('حذف السطر (الفاتورة): كل مفتاحٍ يُحذف بوحدته كاملة — ومنها ما كان مقفلاً (الرقم الضريبي والإجماليات وسطر المنصّة)', () => {
  // «#» رأس جدول الأقساط أيضاً ومجموع الأقساط = الإجمالي — فيُختبران على فاتورةٍ بلا أقساط
  const noInst: Partial<InvoiceDoc> = { paymentPlan: null, installments: undefined };
  const over: Record<string, Partial<InvoiceDoc>> = { 'col.seq': noInst, 'tot.grand': noInst };
  for (const [key, gone] of Object.entries(INVOICE_UNITS)) {
    const base = a4(inv(over[key], withTexts(COMPANY, texts({}))));
    for (const g of gone) assert.ok(base.includes(g), `${key}: «${g}» غائبٌ قبل الحذف`);
    const out = a4(inv(over[key], withTexts(COMPANY, del(key))));
    for (const g of gone) assert.ok(!out.includes(g), `${key}: «${g}» بقي بعد الحذف`);
    assert.ok(out.includes('alt="QR"'), `${key}: الرمز سقط`);
  }
  // العمود كلّه لا رأسه وحده: خلية لكل صفّ (والمبلغ معها خلية مجموع الأقساط)، والمجموع يضيق إلى عمودٍ واحد
  const tds = (h: string) => (h.match(/<td/g) || []).length;
  const base = a4(inv({}, withTexts(COMPANY, texts({}))));
  for (const [key, n] of [['col.seq', 2], ['col.item', 2], ['col.qty', 2], ['col.price', 2], ['col.total', 2], ['inst.dueDate', 2], ['inst.amount', 3]] as const) {
    assert.equal(tds(base) - tds(a4(inv({}, withTexts(COMPANY, del(key))))), n, `${key}: خلايا العمود`);
  }
  assert.ok(a4(inv({}, withTexts(COMPANY, del('inst.dueDate')))).includes('colSpan="1"') || a4(inv({}, withTexts(COMPANY, del('inst.dueDate')))).includes('colspan="1"'));
});

test('حذف السطر: العنوان (المرحلة الأولى والمختوم) والمرتجع ومرجعه — والرمز المختوم يبقى ولو حُذف كل نص وبأيّ ترتيب', () => {
  // العنوان: الوحدة «title» — النصّ يختفي والترويسة تبقى
  assert.ok(!a4(inv({}, withTexts(COMPANY, del('inv.title')))).includes('فاتورة ضريبية<'));
  const ret = inv({ isReturn: true, number: 'RET-9', billingReference: 'INV-100', noteReason: 'تالف', paymentPlan: null, installments: undefined });
  const retBase = a4({ ...ret, company: withTexts(COMPANY, texts({})) });
  for (const [k, g] of [['inv.returnNumber', 'RET-9'], ['inv.originalRef', 'INV-100'], ['inv.noteReason', 'تالف'], ['tot.returnGrand', 'إجمالي المرتجع دائن'], ['inv.returnInfoHeading', 'بيانات المرتجع']] as const) {
    assert.ok(retBase.includes(g), `${k}: غائب قبل الحذف`);
    assert.ok(!a4({ ...ret, company: withTexts(COMPANY, del(k)) }).includes(g), `${k}: بقي بعد الحذف`);
  }
  // كل مفتاح محذوف + ترتيب معكوس الوسط: الرمز المختوم ما زال مطبوعاً (خانة النقطية تحمل قيمته)
  const all = del(...PRINT_TEXT_CATALOG.map((e) => e.key));
  const stamped = inv({ zatca: zv() }, withTexts(COMPANY, all));
  const orders: PrintLayout['order'][] = [
    defaultPrintLayout('page').order,
    ['header', 'totals', 'items', 'info', 'note', 'installments', 'signatures', 'footer'],
    ['header', 'installments', 'note', 'totals', 'info', 'items', 'signatures', 'footer'].filter(Boolean) as PrintLayout['order'],
  ];
  for (const order of orders) {
    for (const look of [lookOf({ order }), lookOf({ order }, 'impact', 'impact_plain')]) {
      const out = a4(stamped, look);
      assert.ok(out.includes('alt="QR"'), `الرمز سقط (${order.join(',')})`);
      if (look.qrSlotPx) assert.ok(out.includes(`data-qr-value="${STAMPED}"`), 'خانة النقطية بلا القيمة المختومة');
    }
  }
  const out = a4(stamped);
  assert.ok(out.includes('alt="QR"') && !out.includes('Field Sales') && !out.includes('300000000000003'));
});

test('حذف السطر (السند): المبلغ والرقم والتاريخ والعميل وربط الفاتورة — كلٌّ بوحدته، والصندوق بعنوانه', () => {
  const UNITS: Record<string, string[]> = {
    'rcp.title': ['سند قبض'], 'rcp.number': ['رقم السند', 'RC-55'], 'rcp.date': ['>التاريخ'], 'rcp.time': ['وقت الإصدار'],
    'rcp.rep': ['>المندوب'], 'rcp.amount': ['المبلغ المستلم', '150.00'], 'rcp.forInvoice': ['مقابل الفاتورة رقم', 'INV-777'],
    'rcp.customerHeading': ['بيانات العميل', 'بقالة النور', 'دفعة نوفمبر'], 'rcp.from': ['استلمنا من السيد', 'بقالة النور'],
    'rcp.taxNumber': ['399999999999993'], 'rcp.method': ['طريقة الدفع'], 'rcp.notes': ['دفعة نوفمبر'],
    'rcp.sigPayer': ['توقيع الدافع'], 'rcp.sigCollector': ['توقيع المستلم المندوب'], 'foot.company': ['padding-top:12px">شركة الاختبار للتوزيع'],
    'foot.platform': ['Field Sales'], 'h.taxNumber': ['300000000000003'],
  };
  for (const [key, gone] of Object.entries(UNITS)) {
    const base = a4r(rcp({}, withTexts(COMPANY, texts({}))));
    for (const g of gone) assert.ok(base.includes(g), `${key}: «${g}» غائبٌ قبل الحذف`);
    const out = a4r(rcp({}, withTexts(COMPANY, del(key))));
    for (const g of gone) assert.ok(!out.includes(g), `${key}: «${g}» بقي بعد الحذف`);
  }
  // عدّة فواتير: «مقابل الفواتير» بوحدة block يحذف الصندوق، و«فاتورة رقم» يحذف صفوفها بأرقامها
  const multi = rcp({ invoices: [{ number: 'INV-1', amount: 100 }, { number: 'INV-2', amount: 50 }] });
  assert.ok(!a4r({ ...multi, company: withTexts(COMPANY, del('rcp.forInvoices')) }).includes('INV-1'));
  const noRows = a4r({ ...multi, company: withTexts(COMPANY, del('rcp.invoiceNo')) });
  assert.ok(!noRows.includes('INV-1') && noRows.includes('مقابل الفواتير'));
});

test('سطر المنصّة: بلا صياغة تعبير اليوم، وبصياغة الشركة نصّها، ومحذوفاً لا سطر', () => {
  const today = a4(inv());
  assert.ok(today.includes('صدرت عبر منصة Field Sales · fieldsa.net'));
  const reworded = a4(inv({}, withTexts(COMPANY, texts({ 'foot.platform': { text: 'نظام الفوترة: فيلد سيلز', alt: null, hidden: false } }))));
  assert.ok(reworded.includes('نظام الفوترة: فيلد سيلز') && !reworded.includes('صدرت عبر منصة'));
  assert.ok(!a4(inv({}, withTexts(COMPANY, del('foot.platform')))).includes('fieldsa.net'));
  // نصوصٌ بلا تعديلٍ لهذا السطر ⇒ تعبير اليوم كما هو
  assert.ok(a4(inv({}, withTexts(COMPANY, texts({ 'inv.rep': { text: 'البائع', alt: null, hidden: false } })))).includes('صدرت عبر منصة Field Sales · fieldsa.net'));
});

test('كل مفتاح فاتورة/سند/مشترك في PRINT_TEXT_LINE إمّا يغيّر ورقة A4 الحالية بحذفه أو هو من مفاتيح القالب ثنائي اللغة وحده', () => {
  const GRID_ONLY = new Set(['col.code', 'col.unit', 'col.vatAmount', 'sel.heading', 'sel.name', 'sel.address', 'sel.city', 'sel.postalCode', 'sel.taxNumber',
    'cust.city', 'cust.postalCode', 'inv.paymentType', 'sig.warehouse', 'sig.remarks', 'tot.exclVat', 'tot.due']);
  const ret = inv({ isReturn: true, billingReference: 'INV-1', noteReason: 'تالف', paymentPlan: null, installments: undefined });
  // الإشعار المدين بالمرحلة الثانية (عنوانه inv.debitTitle — طلب المالك ٤ نوفمبر ٢٠٢٦)
  const debit = inv({ number: 'DN-12', zatca: zv({ documentKind: 'DEBIT_NOTE' } as Partial<ZatcaDocView>) });
  // عناوين الحالة بمفاتيحها (قرار المالك ٤ نوفمبر ٢٠٢٦): سند التسليم والمُبطل والمعلَّق
  const status = [
    inv({ zatca: zv({ mirror: 'clearance_pending', printable: false, qr: null }) }),
    inv({ zatca: zv({ subtype: '02', mirror: 'rejected', printable: false, qr: null }) }),
    inv({ zatca: zv({ subtype: '02', mirror: 'signed', printable: false, qr: null }) }),
  ];
  for (const entry of PRINT_TEXT_CATALOG) {
    assert.ok(entry.key in PRINT_TEXT_LINE, `${entry.key} بلا وحدة`);
    if (GRID_ONLY.has(entry.key)) continue;
    // سندٌ بفاتورة واحدة وآخر بفاتورتين ورصيدٍ دائن (150 − 130)
    const rcps = [rcp(), rcp({ invoices: [{ number: 'INV-1', amount: 100 }, { number: 'INV-2', amount: 30 }] })];
    const docs = entry.doc === 'receipt' ? rcps : entry.doc === 'invoice' ? [inv(), ret, debit, ...status] : [inv(), ...rcps];
    const changed = docs.some((d) => {
      const r = (c: Company) => (d.kind === 'invoice' ? a4({ ...d, company: c }) : a4r({ ...d, company: c }));
      return r(withTexts(COMPANY, texts({}))) !== r(withTexts(COMPANY, del(entry.key)));
    });
    assert.ok(changed, `${entry.key}: حذفه لا يغيّر الورقة`);
  }
});

// ─── ٤) القالب ثنائي اللغة ───

test('التصميم «كلاسيكي بإطارات — ثنائي اللغة» من التخطيط: الجذر موسوم ورمز A4 المختوم فيه — والسند كذلك بلا رمز', () => {
  const look = lookOf({}, 'page', 'page_plain');
  const grid = lookFor(profile('page', 'page_plain', defaultPrintLayout('page', 'grid_bilingual')));
  assert.equal(grid.layout?.design, 'grid_bilingual');
  const out = a4(inv({ zatca: zv() }), grid);
  assert.ok(out.includes('data-print-layout="grid_bilingual"'));
  assert.equal((out.match(/alt="QR"/g) || []).length, 1, 'الرمز المختوم ليس مرّةً واحدة');
  assert.notEqual(strip(out), strip(a4(inv({ zatca: zv() }), look)));
  // النقطية: خانة الرمز تحمل القيمة المختومة (إعادة الرسم بالنقاط)
  const imp = lookFor(profile('impact', 'impact_plain', defaultPrintLayout('impact', 'grid_bilingual')));
  assert.ok(a4(inv({ zatca: zv() }), imp).includes(`data-qr-value="${STAMPED}"`));
  const r = a4r(rcp(), grid);
  assert.ok(r.includes('data-print-layout="grid_bilingual"') && !r.includes('alt="QR"'));
});

// ─── ٥) بانية المستند ───

test('invoiceDocFromDetail: رمز الصنف وضريبة السطر والرمز البريدي للمشتري — وغيابها لا يضيف حقلاً', () => {
  const row = (item: Record<string, unknown>, customer: Record<string, unknown>) => ({
    number: 'INV-1', invoiceDate: '2026-11-02T09:00:00Z', type: 'CASH', customer, items: [{ qty: 1, unitPrice: 10, discountPct: 0, taxPct: 15, lineTotal: 11.5, ...item }],
    subtotal: 10, discountAmt: 0, taxAmt: 1.5, total: 11.5, paidAmt: 11.5, remainingAmt: 0,
  });
  const d = invoiceDocFromDetail(row({ product: { name: 'ماء', code: 'P-001' }, taxAmt: '1.50' }, { name: 'ع', addrPostalCode: '12345' }), '', null);
  assert.equal(d.items[0].code, 'P-001');
  assert.equal(d.items[0].taxAmt, 1.5);
  assert.equal(d.customer.postalCode, '12345');
  const bare = invoiceDocFromDetail(row({ product: { name: 'ماء' } }, { name: 'ع' }), '', null);
  assert.equal('code' in bare.items[0], false);
  assert.equal('taxAmt' in bare.items[0], false);
  assert.equal('postalCode' in bare.customer, false);
});
