/**
 * «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — فاتورة A4 والمرتجع المختومان بلا ضريبة (Invoice.taxFree):
 *
 *   «في حال ازالة الضريبة لا يكون لها ذكر في اي سطر في النظام ولا في اي مستند».
 *
 * القوالب: الورقة الافتراضية (بلا إعدادات)، والصفحة القياسية بتخطيط، والصفحة بلوحةٍ فيها مربع QR، والنقطية، والقالب ثنائي اللغة على
 * الصفحة والنقطية، وشركةٌ لها «نصوص مطبوعات» بلغةٍ ثانية. المستندات: بيعٌ نقدي لمشترٍ بلا رقم، وبيعٌ آجل بالتقسيط لمشترٍ برقمٍ ضريبي،
 * ومرتجع، وشركةٌ بلا رقمٍ ضريبي (كان يُطبع «أضف الرقم الضريبي…»)، ومزوّدٌ حكوميّ معلَّق (كان «قيد الاعتماد…»)، وختمٌ مع عرض مرحلة
 * ثانية (الختم يغلب). لكل خانة: لا نصّ ظاهر يذكر الضريبة (عربياً أو بلغةٍ ثانية) ولا رقمٌ ضريبيّ ولا رمز QR ولا خانة رمز — والعنوان
 * «فاتورة»/«فاتورة مرتجع»، والأصناف والإجمالي باقيان.
 * وبلا ختم (أو بختمٍ false): الورقة نفسها حرفاً — والمستند القديم بضريبته يُطبع بضريبته ولو أُزيلت عن الشركة بعده (قرار المالك ٢).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentResult, PrintableInvoice, docTaxOff, invoiceDocFromDetail, taxFreeView, type Company, type InvoiceDoc } from './RepDocuments';
import { PrintLookContext, lookFor } from './printLook';
import {
  defaultPrintLayout, defaultPrintOptions, presetPaper,
  type LayoutDesign, type PaperPresetId, type PrintLayout, type PrintProfile, type PrinterType, type TemplateId,
} from '../lib/print/printSettings';
import type { PrintCanvas } from '../lib/print/printSettingsCore';
import type { ZatcaDocView } from '../lib/zatca/docStatus';
import { TAX_FREE_TITLES } from '../lib/taxMode';
import { useLang } from '../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';

process.env.TZ = 'Asia/Riyadh';
useLang.setState({ lang: 'ar' });
setActiveNumerals('latin');
setActiveCurrency('SAR');

// ─── المستندات ───

const SELLER_VAT = '300000000000003';
const BUYER_VAT = '311111111111113';
const LOGO = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const COMPANY: Company = {
  name: 'شركة الاختبار للتوزيع', address: 'حي العليا شارع التحلية', taxNumber: SELLER_VAT, commercialReg: '1010101010',
  phone: '0501234567', email: 'info@example.sa', logo: LOGO, primaryColor: '#1e3a8a', headerStyle: null, countryCode: 'SA',
  addrCity: 'الرياض', addrPostalCode: '12345',
};
const OFF: Company = { ...COMPANY, taxDisabled: true };
const BUYER_STD = { name: 'محمد العتيبي', businessName: 'مؤسسة الأفق', taxNumber: BUYER_VAT, commercialReg: '2020202020', phone: '0112345678', address: 'طريق الملك فهد' };
const BUYER_SIMPLE = { name: 'بقالة الحي', phone: '0533333333' };
const ITEM_NAMES = ['مياه معدنية', 'عصير برتقال'];
/** بنود الإصدار بلا ضريبة كما يخزّنها الخادم: النسبة صفر والضريبة صفر والإجمالي هو الصافي */
const FREE_ITEMS: InvoiceDoc['items'] = [
  { name: 'مياه معدنية', unit: 'كرتون', qty: 2, unitPrice: 23, discountPct: 0, taxPct: 0, lineTotal: 46, code: 'W-1', taxAmt: 0 },
  { name: 'عصير برتقال', unit: 'حبة', qty: 3, unitPrice: 2.5, discountPct: 10, taxPct: 0, lineTotal: 6.75, code: 'J-2', taxAmt: 0 },
];
const TOTAL = '52.75';
const free = (o: Partial<InvoiceDoc> = {}): InvoiceDoc => ({
  kind: 'invoice', taxFree: true, number: 'INV-901', date: '2026-11-07T09:15:00.000Z', type: 'CASH', company: OFF, customer: BUYER_SIMPLE,
  repName: 'أحمد السالم', items: FREE_ITEMS, subtotal: 53.5, discount: 0.75, tax: 0, total: 52.75, pricesIncludeTax: true,
  paidAmt: 52.75, remainingAmt: 0, einvoice: { provider: 'none', status: null, uuid: null, qr: null }, zatca: null, ...o,
});
const STAMPED = 'AQ/YtNix2YPYqSDYp9mE2KfYrtiq2KjYp9ixAg8zMDAwMDAwMDAwMDAwMDMDFDIwMjYtMTEtMDJUMDk6MTU6MDBa';
const zv = (over: Partial<ZatcaDocView> = {}): ZatcaDocView => ({
  phase: 2, mode: 'live', mirror: 'reported', documentStatus: 'REPORTED', subtype: '02', documentKind: 'INVOICE', qr: STAMPED, printable: true,
  overdue: false, reportDeadline: null, issuedAt: '2026-11-07T09:15:00.000Z', uuid: '3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c', icv: 41, warnings: 0, ...over,
});
const INSTALLMENTS = [{ seq: 1, dueDate: '2026-12-07', amount: 26.37 }, { seq: 2, dueDate: '2027-01-07', amount: 26.38 }];

interface DocCase { name: string; doc: () => InvoiceDoc; title: string }
const DOCS: DocCase[] = [
  { name: 'saleCash', doc: () => free(), title: TAX_FREE_TITLES.sale },
  { name: 'saleInstallmentsStdBuyer', doc: () => free({ type: 'CREDIT', customer: BUYER_STD, paymentPlan: 'INSTALLMENT', installments: INSTALLMENTS, paidAmt: 0, remainingAmt: 52.75 }), title: TAX_FREE_TITLES.sale },
  { name: 'return', doc: () => free({ number: 'RET-31', isReturn: true, type: 'CREDIT', customer: BUYER_STD, paidAmt: undefined, remainingAmt: undefined, billingReference: 'INV-900', noteReason: 'بضاعة تالفة' }), title: TAX_FREE_TITLES.return },
  { name: 'noSellerVat', doc: () => free({ company: { ...OFF, taxNumber: undefined } }), title: TAX_FREE_TITLES.sale },
  { name: 'nonSaudiGovPending', doc: () => free({ company: { ...OFF, countryCode: 'EG', einvoiceProvider: 'eta' }, einvoice: { provider: 'eta', status: 'PENDING', uuid: null, qr: null } }), title: TAX_FREE_TITLES.sale },
  { name: 'stampWinsOverPhase2', doc: () => free({ customer: BUYER_STD, zatca: zv() }), title: TAX_FREE_TITLES.sale },
  { name: 'exclusivePrices', doc: () => free({ pricesIncludeTax: false, customer: BUYER_STD }), title: TAX_FREE_TITLES.sale },
];

// ─── القوالب ───

const CANVAS: PrintCanvas = {
  headerMm: 70, footerMm: 80, boxes: [
    { id: 'logo', band: 'header', x: 0, y: 0, w: 40, h: 25 },
    { id: 'company', band: 'header', x: 45, y: 0, w: 90, h: 30 },
    { id: 'title', band: 'header', x: 140, y: 0, w: 48, h: 20 },
    { id: 'customer', band: 'header', x: 0, y: 35, w: 90, h: 30 },
    { id: 'totals', band: 'footer', x: 0, y: 0, w: 100, h: 50 },
    { id: 'qr', band: 'footer', x: 120, y: 0, w: 50, h: 50 },
  ],
};
const plain = (printer: PrinterType, template: TemplateId, preset: PaperPresetId, design: LayoutDesign = 'standard', extra: Partial<PrintLayout> = {}): PrintProfile => ({
  id: `p-${template.replace(/_/g, '-')}`, name: template, printer, template, paper: presetPaper(preset)!,
  options: { ...defaultPrintOptions(printer), showLogo: true, layout: { ...defaultPrintLayout(printer, design), ...extra } },
});
interface Target { name: string; profile: PrintProfile | null; grid?: boolean }
const TARGETS: Target[] = [
  { name: 'today', profile: null },
  { name: 'page_standard', profile: plain('page', 'page_branded', 'a4') },
  { name: 'page_canvasQr', profile: plain('page', 'page_branded', 'a4', 'standard', { canvas: CANVAS }) },
  { name: 'impact_standard', profile: plain('impact', 'impact_plain', 'ff_a4') },
  { name: 'page_grid', profile: plain('page', 'page_branded', 'a4', 'grid_bilingual'), grid: true },
  { name: 'impact_grid', profile: plain('impact', 'impact_plain', 'ff_a4', 'grid_bilingual'), grid: true },
];

const norm = (h: string): string => h.replace(/data:image\/png;base64,[A-Za-z0-9+/=]{60,}/g, 'data:QR');
const sheet = (p: PrintProfile | null, doc: InvoiceDoc): string => {
  const el = createElement(PrintableInvoice, { doc });
  return norm(renderToStaticMarkup((p ? createElement(PrintLookContext.Provider, { value: lookFor(p) }, el) : el) as ReactElement));
};
/** النصّ الظاهر وحده (بلا وسوم ولا سمات): المفاتيح الداخلية (data-line="col.tax") ليست ذكراً للضريبة على الورقة */
const visible = (h: string): string => h.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

/** كل ما يُعدّ ذكراً للضريبة على الورقة — بالعربية واللغات الثانية */
const TAX_WORDS: RegExp[] = [
  /ضريب/, /الضرائب/, /ض\.ق\.م/, /مبسطة/, /إشعار دائن/, /إشعار مدين/, /هيئة الزكاة/, /الهيئة/, /قيد الاعتماد/, /أضف الرقم/,
  /رمز الاستجابة/, /الفوترة الإلكترونية/, /معرف الفاتورة/, /\bVAT\b/i, /\btax/i, /\bTVA\b/, /\bKDV\b/, /Vergi/i, /税/, /fiscal/i, /Credit Note/i,
  /\bICV\b/,
];
/** آثار الرمز وكتلته في الوسوم */
const QR_MARKS: RegExp[] = [/alt="QR"/, /data-qr-value=/, /data-qr-ec=/, /data-grid-qr=/, /data-section="qr"/, /data-qr-under=/];

function taxMentions(html: string): string[] {
  const text = visible(html);
  const out: string[] = [];
  for (const re of TAX_WORDS) if (re.test(text)) out.push(`نصّ ${re}`);
  for (const re of QR_MARKS) if (re.test(html)) out.push(`رمز ${re}`);
  for (const v of [SELLER_VAT, BUYER_VAT]) if (html.includes(v)) out.push(`رقم ضريبي ${v}`);
  // عمود النسبة «0%» (الخصم «10%» مشروع)
  if (/(^|[^\d.])0%/.test(text)) out.push('نسبة ضريبة 0%');
  return out;
}

const TEXTS_EN = { version: 1, secondLang: 'en', companyNameAlt: 'Test Distribution Co', companyAddressAlt: 'Olaya', edits: {} };
const TEXTS_REWORDED = {
  version: 1, secondLang: null, companyNameAlt: null, companyAddressAlt: null,
  edits: { 'inv.title': { text: 'فاتورة مبيعات', alt: null, hidden: false } },
};

// ─── المصفوفة ───

test('المختوم بلا ضريبة: لا ذكر للضريبة ولا رقم ضريبي ولا رمز في أيّ قالب — والعنوان والأصناف والإجمالي باقية', () => {
  const errors: string[] = [];
  let cells = 0;
  for (const t of TARGETS) {
    for (const d of DOCS) {
      for (const [tn, texts] of [['noTexts', undefined], ['textsEn', TEXTS_EN]] as const) {
        const base = d.doc();
        const doc = texts ? { ...base, company: { ...base.company!, printTexts: texts } } : base;
        const tag = `${t.name}/${d.name}/${tn}`;
        const html = sheet(t.profile, doc);
        cells++;
        const bad = taxMentions(html);
        if (bad.length) errors.push(`${tag}: ${bad.join(' · ')}`);
        // العنوان عنصرٌ وحده (قد يلحقه سطر اللغة الثانية) — لا جزءٌ من «رقم الفاتورة»
        if (!new RegExp(`>${d.title}<`).test(html)) errors.push(`${tag}: العنوان «${d.title}» غائب`);
        if (!ITEM_NAMES.every((n) => html.includes(n))) errors.push(`${tag}: الأصناف غائبة`);
        if (!html.includes(TOTAL)) errors.push(`${tag}: الإجمالي غائب`);
        if (!html.includes(COMPANY.commercialReg!)) errors.push(`${tag}: السجل التجاري سقط مع الرقم الضريبي`);
      }
    }
  }
  assert.ok(cells >= 80, `خانات قليلة ${cells}`);
  assert.deepEqual(errors, []);
});

test('برهان الفشل: المستند نفسه بلا ختم يُطبع بضريبته ورقمه ورمزه — فالمصفوفة تلتقط ما يتسرّب', () => {
  for (const t of TARGETS) {
    const taxed = sheet(t.profile, { ...free({ customer: BUYER_STD }), taxFree: undefined, company: COMPANY, items: FREE_ITEMS.map((it) => ({ ...it, taxPct: 15 })), tax: 6.88, einvoice: null });
    const bad = taxMentions(taxed);
    assert.ok(bad.some((b) => b.startsWith('نصّ')), `${t.name}: لا نصّ ضريبي في الورقة المضرَّبة`);
    assert.ok(bad.includes(`رقم ضريبي ${SELLER_VAT}`), `${t.name}: رقم البائع غائب عن الورقة المضرَّبة`);
    assert.ok(bad.some((b) => b.startsWith('رمز')), `${t.name}: لا رمز في الورقة المضرَّبة`);
  }
});

test('صياغة الشركة لعنوان الفاتورة تسري على المختوم بلا ضريبة كما اليوم — وحذفها يحذفه', () => {
  const doc = free({ company: { ...OFF, printTexts: TEXTS_REWORDED } });
  for (const t of TARGETS.filter((x) => !x.grid)) {
    const html = sheet(t.profile, doc);
    assert.ok(visible(html).includes('فاتورة مبيعات'), `${t.name}: صياغة الشركة لم تُطبع`);
    assert.deepEqual(taxMentions(html), [], t.name);
  }
});

test('بلا ختم أو بختمٍ false: الورقة نفسها حرفاً — وعلم الشركة وحده لا يغيّر فاتورةً صدرت بضريبتها (قرار المالك ٢)', () => {
  const taxed = (o: Partial<InvoiceDoc> = {}): InvoiceDoc => ({
    ...free({ customer: BUYER_STD, type: 'CREDIT', paymentPlan: 'INSTALLMENT', installments: INSTALLMENTS, paidAmt: 0, remainingAmt: 52.75 }),
    taxFree: undefined, company: COMPANY, items: FREE_ITEMS.map((it) => ({ ...it, taxPct: 15, taxAmt: undefined })), tax: 6.88, einvoice: null, ...o,
  });
  for (const t of TARGETS) {
    const today = sheet(t.profile, taxed());
    assert.equal(sheet(t.profile, taxed({ taxFree: false })), today, `${t.name}: taxFree:false غيّر الورقة`);
    // الشركة أُزيلت ضريبتها بعد إصدار هذه الفاتورة: تبقى كما صدرت بضريبتها ورقمها ورمزها
    const later = sheet(t.profile, taxed({ company: { ...COMPANY, taxDisabled: true } }));
    assert.equal(later, today, `${t.name}: علم الشركة غيّر فاتورةً صدرت بضريبتها`);
    assert.ok(later.includes(SELLER_VAT) && /ضريب/.test(visible(later)), `${t.name}: الفاتورة القديمة فقدت ضريبتها`);
    // وtaxDisabled:false كغيابه
    assert.equal(sheet(t.profile, taxed({ company: { ...COMPANY, taxDisabled: false } })), today);
  }
});

test('taxFreeView: المرجع نفسه بلا ختم، وبالختم نسخةٌ بلا الرقمين وحدهما — والختم والبيانات الأخرى باقية', () => {
  const taxed = { ...free({ customer: BUYER_STD }), taxFree: undefined, company: COMPANY };
  assert.equal(taxFreeView(taxed), taxed, 'نسخةٌ جديدة لمستندٍ بضريبته');
  assert.equal(taxFreeView({ ...taxed, company: OFF }).company, OFF, 'علم الشركة يمسّ فاتورةً بلا ختم');
  const doc = free({ customer: BUYER_STD });
  const v = taxFreeView(doc);
  assert.notEqual(v, doc);
  assert.equal(v.taxFree, true);
  assert.equal('taxNumber' in v.company!, false);
  assert.equal('taxNumber' in v.customer, false);
  assert.equal(v.company!.commercialReg, COMPANY.commercialReg);
  assert.equal(v.customer.commercialReg, BUYER_STD.commercialReg);
  assert.equal(v.customer.businessName, BUYER_STD.businessName);
  // المدخل لا يُمسّ
  assert.equal(doc.company!.taxNumber, SELLER_VAT);
  assert.equal(doc.customer.taxNumber, BUYER_VAT);
  assert.equal(docTaxOff(doc), true);
  assert.equal(docTaxOff({ ...doc, taxFree: false }), false);
});

test('invoiceDocFromDetail: الختم من صفّ الفاتورة (true وحده) — وغيابه أو false لا يضيف حقلاً', () => {
  const row = {
    number: 'INV-1', invoiceDate: '2026-11-07T09:00:00.000Z', type: 'CASH', customer: { name: 'عميل' }, salesRep: { name: 'م' },
    items: [{ product: { name: 'ماء', unit: 'حبة' }, qty: 1, unitPrice: 5, discountPct: 0, taxPct: 0, lineTotal: 5 }],
    subtotal: 5, discountAmt: 0, taxAmt: 0, total: 5, paidAmt: 5, remainingAmt: 0, einvoiceProvider: 'none',
  };
  const today = invoiceDocFromDetail(row, 'م', COMPANY);
  assert.equal('taxFree' in today, false);
  assert.deepEqual(invoiceDocFromDetail({ ...row, taxFree: false }, 'م', COMPANY), today);
  assert.deepEqual(invoiceDocFromDetail({ ...row, taxFree: null }, 'م', COMPANY), today);
  const stamped = invoiceDocFromDetail({ ...row, taxFree: true }, 'م', OFF);
  assert.equal(stamped.taxFree, true);
  assert.deepEqual({ ...stamped, taxFree: undefined, company: COMPANY }, { ...today, taxFree: undefined });
  // والشركة تمرّ كما وصلت بعلمها
  assert.equal(stamped.company?.taxDisabled, true);
  // وورقة الصفّ المختوم بلا ضريبة
  assert.deepEqual(taxMentions(sheet(null, { ...stamped, customer: { ...stamped.customer, taxNumber: BUYER_VAT } })), []);
});

test('شاشة النتيجة: المختوم بلا ضريبة بلا ذكرٍ للضريبة في الشاشة كلّها (المعاينة والنسخة الملتقطة والأزرار)', () => {
  const screen = (doc: InvoiceDoc) => renderToStaticMarkup(createElement(DocumentResult, { doc, onClose: () => {} }));
  for (const d of DOCS) {
    const html = screen(d.doc());
    assert.deepEqual(taxMentions(html), [], d.name);
    // الإصدار ناجح وزرّ المشاركة باقٍ
    assert.ok(html.includes('تم الإصدار بنجاح'), d.name);
    assert.ok(html.includes('مشاركة / حفظ PDF'), d.name);
  }
  // وبلا ختم كما اليوم حرفاً
  const taxed = { ...free(), taxFree: undefined, company: COMPANY, items: FREE_ITEMS.map((it) => ({ ...it, taxPct: 15 })), tax: 6.88 };
  assert.equal(screen({ ...taxed, taxFree: false }), screen(taxed));
});
