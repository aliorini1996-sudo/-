/**
 * خطّ الأساس الذهبيّ لقوالب الصفحة (A4/A5/Letter والنقطية) — كما تطبعها المنصّة اليوم (f037417، ٣ نوفمبر ٢٠٢٦) قبل
 * «تخطيط المطبوعات» و«القوالب الجديدة» و«حذف السطر».
 *
 * لماذا: كل تغييرٍ لاحق في القوالب يجب أن يترك ورقة كل شركةٍ لم تختر قالباً أو خياراً جديداً **حرفاً بحرف** كما هي.
 * الاختبارات النسبية (بلا نصوص = بنصوصٍ فارغة) لا تكشف تغييراً يصيب الحالتين معاً؛ هذا الملف يقارن المخرَج الكامل
 * (renderToStaticMarkup) بنسخةٍ مجمّدة في `__baseline__/a4.manifest.json` و`__baseline__/a4.markup.json.br`.
 *
 * التغطية: كل مستندٍ تطبعه قوالب الصفحة — المبسّطة والضريبية (المرحلة الأولى)، والمرحلة الثانية برمزها المختوم (مبسّطة
 * ومعتمدة وبروفة وإشعار دائن وسند تسليم ومُبطل ومعلّق وبلا رمز)، والمرتجع والإشعار الدائن، وسند القبض بحالاته — على كل قالب
 * صفحةٍ أو نقطيّةٍ قائم (page_branded/page_plain/impact_plain/impact_preprinted والملف الافتراضي legacy-a4 وغياب الإعداد)،
 * وكل خيارٍ في «إعدادات الطباعة» يغيّر ورقة الصفحة (أو يُفترض ألا يغيّرها)، وأشكال الترويسة وبيانات الشركة، وبلا نصوص
 * مطبوعات وبنصوصٍ محفوظة ممثِّلة (عربية فقط، وبلغةٍ ثانية).
 *
 * النصوص المحفوظة الممثِّلة تقتصر عمداً على ما لا يغيّر معناه بعد طلب المالك الثالث (لا إخفاء لعنوان قسم ولا لمفتاحٍ
 * «قياسي» ولا صياغة لعنوان المستند): صياغة تسميات، وإخفاء صفوفٍ كاملة غير إلزامية، ولغة ثانية.
 *
 * هذا الملف وملفّا `__baseline__/a4.*` لا يعدّلها إلا كاتبها. التجديد لا يقع إلا صراحةً:
 *   BASELINE_WRITE=1 npx tsx --test src/rep/printA4.baseline.test.ts      (يُرفض داخل CI)
 * والوضع الافتراضي مقارنةٌ فقط: حالةٌ بلا نسخة مجمّدة أو نسخةٌ بلا حالة = فشل.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintableInvoice, PrintableReceipt, type Company, type DocCustomer, type InvoiceDoc, type ReceiptDoc } from './RepDocuments';
import { PrintLookContext, lookFor, type PrintLook } from './printLook';
import {
  defaultPrintOptions, legacyPageProfile, presetPaper, type PaperPresetId, type PrintOptions, type PrintProfile, type TemplateId,
} from '../lib/print/printSettings';
import type { ZatcaDocView } from '../lib/zatca/docStatus';
import { useLang } from '../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';

// ─── بيئةٌ ثابتة: المنطقة الزمنية واللغة والترقيم والعملة (التواريخ بلا إزاحة، والأرقام بشكلٍ واحد) ───
process.env.TZ = 'Asia/Riyadh';
useLang.setState({ lang: 'ar' });
setActiveNumerals('arabic');
setActiveCurrency('SAR');

const DIR = fileURLToPath(new URL('./__baseline__/', import.meta.url));
const MANIFEST = path.join(DIR, 'a4.manifest.json');
const BUNDLE = path.join(DIR, 'a4.markup.json.br');
const WRITE = process.env.BASELINE_WRITE === '1';

// ─── البيانات الثابتة ───
/** شعار GIF بكسلٌ واحد (ليس PNG كي لا يُخلط بصورة رمز) */
const LOGO = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
/** توقيع يدويّ PNG (isSignatureSrc) */
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
/** حمولة رمز مختومٍ ثابتة (لا تُفكّ — يكفي أنها نصّ base64 ثابت) */
const STAMPED_QR = 'AQ/YtNix2YPYqSDYp9mE2KfYrtiq2KjYp9ixAg8zMDAwMDAwMDAwMDAwMDMDFDIwMjYtMTEtMDJUMDk6MTU6MDBaBAU3MC4wMAUEOS4xMwYsWlhoaGJYQnNaU0J6YVdkdVlYUjFjbVVnYUdGemFDQjJZV3gxWlE9PQcgU0lHTkFUVVJFX1NJR05BVFVSRV9TSUdOQVRVUkVfMDE=';

const COMPANY: Company = {
  name: 'شركة الاختبار للتوزيع', address: 'الرياض، حي العليا، شارع التحلية', taxNumber: '300000000000003',
  commercialReg: '1010101010', phone: '0501234567', email: 'info@example.sa', logo: LOGO,
  primaryColor: null, headerStyle: null, countryCode: 'SA',
};

const RETAIL: DocCustomer = { name: 'بقالة النور', phone: '0551112223', address: 'شارع الأمير سلطان', district: 'حي الملز', city: 'الرياض' };
const WALK_IN: DocCustomer = { name: 'عميل نقدي' };
const B2B: DocCustomer = {
  name: 'محمد العتيبي', businessName: 'مؤسسة الأفق التجارية', commercialReg: '1010202020', taxNumber: '311111111111113',
  phone: '0112345678', address: 'طريق الملك فهد', district: 'حي الصحافة', city: 'الرياض',
};

type Item = InvoiceDoc['items'][number];
/** أسعار شاملة (تطبيق المندوب): كرتون بوحدات متعددة، وخصم بند، وكمية كسرية، وبندٌ بلا وحدة */
const ITEMS_INCL: Item[] = [
  { name: 'مياه معدنية 330 مل', unit: 'كرتون', qty: 2, unitPrice: 23, discountPct: 0, taxPct: 15, lineTotal: 46, unitFactor: 24, multiUnit: true },
  { name: 'عصير برتقال 250 مل', unit: 'حبة', qty: 3, unitPrice: 2.5, discountPct: 10, taxPct: 15, lineTotal: 6.75 },
  { name: 'بسكويت بالتمر', qty: 1.5, unitPrice: 11.5, discountPct: 0, taxPct: 15, lineTotal: 17.25 },
];
const TOTALS_INCL = { subtotal: 61.52, discount: 0.65, tax: 9.13, total: 70, pricesIncludeTax: true };
/** أسعار غير شاملة (اللوحة) */
const ITEMS_EXCL: Item[] = [
  { name: 'زيت دوار الشمس 1.5 لتر', unit: 'كرتون', qty: 2, unitPrice: 20, discountPct: 0, taxPct: 15, lineTotal: 40 },
  { name: 'أرز بسمتي 5 كجم', unit: 'كيس', qty: 3, unitPrice: 2.17, discountPct: 10, taxPct: 15, lineTotal: 5.86 },
];
const TOTALS_EXCL = { subtotal: 46.51, discount: 0.65, tax: 6.88, total: 52.74, pricesIncludeTax: false };
/** نسب مختلطة ⇒ «نسب متعددة» */
const ITEMS_MIXED: Item[] = [
  { name: 'مياه معدنية 330 مل', unit: 'كرتون', qty: 2, unitPrice: 23, discountPct: 0, taxPct: 15, lineTotal: 46 },
  { name: 'حليب أطفال', unit: 'علبة', qty: 1, unitPrice: 40, discountPct: 0, taxPct: 0, lineTotal: 40 },
];

const DATE = '2026-11-02T09:15:00.000Z';

function inv(over: Partial<InvoiceDoc> = {}): InvoiceDoc {
  return {
    kind: 'invoice', number: 'INV-2611-000123', date: DATE, type: 'CREDIT', company: COMPANY, customer: RETAIL, repName: 'أحمد السالم',
    items: ITEMS_INCL, ...TOTALS_INCL, paidAmt: 20, remainingAmt: 50, ...over,
  };
}

function zv(over: Partial<ZatcaDocView>): ZatcaDocView {
  return {
    phase: 2, mode: 'live', mirror: 'reported', documentStatus: 'REPORTED', subtype: '02', documentKind: 'INVOICE',
    qr: STAMPED_QR, printable: true, overdue: false, reportDeadline: null, issuedAt: DATE,
    uuid: '3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c', icv: 4127, warnings: 0, ...over,
  };
}

/** فواتير ومرتجعات وإشعارات (قالب PrintableInvoice) */
const INVOICES: Record<string, InvoiceDoc> = {
  'p1-simplified-credit': inv(),
  'p1-simplified-cash': inv({ type: 'CASH', customer: WALK_IN, paidAmt: undefined, remainingAmt: undefined }),
  'p1-installments': inv({
    paymentPlan: 'INSTALLMENT', paidAmt: 0, remainingAmt: 70,
    installments: [
      { seq: 1, dueDate: '2026-12-02T00:00:00.000Z', amount: 23.34 },
      { seq: 2, dueDate: '2027-01-02T00:00:00.000Z', amount: 23.33 },
      { seq: 3, dueDate: '2027-02-02T00:00:00.000Z', amount: 23.33 },
    ],
  }),
  'p1-standard': inv({
    customer: B2B, deliveryDate: '2026-11-05T00:00:00.000Z', recipientSignature: SIG, repSignature: SIG, paidAmt: 0, remainingAmt: 70,
  }),
  'p1-standard-exclusive': inv({ customer: B2B, type: 'CASH', items: ITEMS_EXCL, ...TOTALS_EXCL, paidAmt: undefined, remainingAmt: undefined }),
  'p1-simplified-exclusive': inv({ items: ITEMS_EXCL, ...TOTALS_EXCL, paidAmt: 52.74, remainingAmt: 0 }),
  'p1-mixed-vat': inv({ items: ITEMS_MIXED, subtotal: 80, discount: 0, tax: 6, total: 86, pricesIncludeTax: true, paidAmt: 0, remainingAmt: 86 }),
  'p1-zero-tax': inv({
    items: [{ name: 'حليب أطفال', unit: 'علبة', qty: 2, unitPrice: 40, discountPct: 0, taxPct: 0, lineTotal: 80 }],
    subtotal: 80, discount: 0, tax: 0, total: 80, pricesIncludeTax: true, paidAmt: 0, remainingAmt: 80,
  }),
  'p1-lots': inv({
    company: { ...COMPANY, lotTrackingEnabled: true, lotOnInvoice: true },
    items: [
      { ...ITEMS_INCL[0], lots: [{ lotNumber: 'L-2610-A', qty: 24, expiryDate: '2027-03-01' }, { lotNumber: 'L-2610-B', qty: 24, expiryDate: null }] },
      ITEMS_INCL[1], ITEMS_INCL[2],
    ],
  }),
  'p1-return': inv({
    isReturn: true, number: 'RET-2611-000009', customer: RETAIL,
    items: [
      { ...ITEMS_INCL[0], returnExpired: true, expiresAt: '2026-10-20' },
      { ...ITEMS_INCL[1], returnExpired: false, expiresAt: '2027-01-15' },
      ITEMS_INCL[2],
    ],
  }),
  'p1-return-ref': inv({
    isReturn: true, number: 'RET-2611-000010', customer: B2B, billingReference: 'INV-2610-000777', noteReason: 'بضاعة تالفة عند الاستلام',
  }),
  'nonSA-eta-approved': inv({
    company: { ...COMPANY, countryCode: 'EG', einvoiceProvider: 'eta' },
    einvoice: { provider: 'eta', status: 'VALID', uuid: 'ETA-UUID-0001-ABCD', qr: 'https://invoicing.eta.gov.eg/print/ETA-UUID-0001-ABCD' },
  }),
  'nonSA-eta-pending': inv({ company: { ...COMPANY, countryCode: 'EG', einvoiceProvider: 'eta' }, einvoice: { provider: 'eta', status: 'SUBMITTED', uuid: null, qr: null } }),
  'p1-no-company-vat': inv({ company: { ...COMPANY, taxNumber: undefined } }),

  // ── المرحلة الثانية (الرمز المختوم من الخادم) ──
  'p2-simplified-reported': inv({ zatca: zv({}) }),
  'p2-simplified-cash': inv({ type: 'CASH', customer: WALK_IN, paidAmt: undefined, remainingAmt: undefined, zatca: zv({ icv: 4128 }) }),
  'p2-standard-cleared': inv({ customer: B2B, zatca: zv({ subtype: '01', mirror: 'cleared', documentStatus: 'CLEARED' }) }),
  'p2-standard-cleared-exclusive': inv({
    customer: B2B, type: 'CASH', items: ITEMS_EXCL, ...TOTALS_EXCL, paidAmt: undefined, remainingAmt: undefined,
    zatca: zv({ subtype: '01', mirror: 'cleared', documentStatus: 'CLEARED' }),
  }),
  'p2-standard-reported-303': inv({ customer: B2B, zatca: zv({ subtype: '01', mirror: 'reported' }) }),
  'p2-rehearsal': inv({ zatca: zv({ mode: 'rehearsal' }) }),
  'p2-credit-note': inv({
    isReturn: true, number: 'RET-2611-000011', billingReference: 'INV-2610-000777', noteReason: 'إرجاع بضاعة قريبة الانتهاء',
    zatca: zv({ documentKind: 'CREDIT_NOTE' }),
  }),
  'p2-credit-note-standard': inv({
    isReturn: true, number: 'RET-2611-000012', customer: B2B, billingReference: 'INV-2610-000778', noteReason: 'خطأ في الكمية',
    zatca: zv({ documentKind: 'CREDIT_NOTE', subtype: '01', mirror: 'cleared', documentStatus: 'CLEARED' }),
  }),
  'p2-delivery-note': inv({ customer: B2B, zatca: zv({ subtype: '01', mirror: 'clearance_pending', printable: false, qr: null, documentStatus: 'SUBMITTING' }) }),
  'p2-void': inv({ zatca: zv({ mirror: 'rejected', printable: false, qr: null, documentStatus: 'REJECTED' }) }),
  'p2-pending': inv({ zatca: zv({ mirror: 'signed', printable: false, qr: null, documentStatus: 'RETRY_WAIT' }) }),
  'p2-no-qr': inv({ zatca: zv({ qr: null, icv: null, uuid: null }) }),
};

function rcp(over: Partial<ReceiptDoc> = {}): ReceiptDoc {
  return {
    kind: 'receipt', number: 'RC-2611-000045', date: DATE, company: COMPANY, customer: RETAIL, repName: 'أحمد السالم',
    amount: 100, paymentMethod: 'CASH', ...over,
  };
}

/** سندات القبض (قالب PrintableReceipt) */
const RECEIPTS: Record<string, ReceiptDoc> = {
  'rcp-single': rcp({ invoices: [{ number: 'INV-2611-000123', amount: 100 }] }),
  'rcp-multi-credit': rcp({ amount: 300, paymentMethod: 'BANK_TRANSFER', invoices: [{ number: 'INV-2611-000101', amount: 150 }, { number: 'INV-2611-000102', amount: 100 }] }),
  'rcp-unknown-b2b': rcp({ customer: B2B, paymentMethod: 'CHEQUE', notes: 'شيك رقم 445566 على مصرف الراجحي' }),
  'rcp-on-account': rcp({ invoices: [], paymentMethod: 'POS', notes: 'دفعة مقدمة' }),
  'rcp-offline-pending': rcp({ offline: true, number: 'OFF-7F3A' }),
  'rcp-cancelled': rcp({ cancelled: true, invoices: [{ number: 'INV-2611-000123', amount: 100 }] }),
};

// ─── مظاهر الطباعة: كل قالب صفحةٍ/نقطيّةٍ قائم وكل خيار ───
const PAGE_OPTS = defaultPrintOptions('page');
const IMPACT_OPTS = defaultPrintOptions('impact');
function prof(template: TemplateId, preset: Exclude<PaperPresetId, 'custom'>, over: Partial<PrintOptions> = {}): PrintProfile {
  const printer = template.startsWith('impact_') ? 'impact' : 'page';
  return {
    id: 'baseline', name: 'baseline', printer, template, paper: presetPaper(preset)!,
    options: { ...(printer === 'impact' ? IMPACT_OPTS : PAGE_OPTS), ...over },
  };
}
const CUSTOM_PAGE: PrintProfile = {
  ...prof('page_branded', 'a4'),
  paper: { preset: 'custom', widthMm: 200, lengthMm: 280, feed: 'sheet', dpi: null, printableDots: null, offsetXmm: 0, marginTopMm: 10, marginBottomMm: 10 },
};

/** null = بلا مزوّد سياق (DocumentModal قبل «إعدادات الطباعة» ومعاينة المحرّر) */
const LOOKS: Record<string, PrintLook | null> = {
  'none': null,
  'legacy-a4': lookFor(legacyPageProfile()),
  'page_branded-a4': lookFor(prof('page_branded', 'a4')),
  'page_branded-a5': lookFor(prof('page_branded', 'a5')),
  'page_branded-letter': lookFor(prof('page_branded', 'letter')),
  'page_branded-custom200x280': lookFor(CUSTOM_PAGE),
  'page_branded-noLogo': lookFor(prof('page_branded', 'a4', { showLogo: false })),
  'page_branded-noContact': lookFor(prof('page_branded', 'a4', { showContact: false })),
  'page_branded-noRepName': lookFor(prof('page_branded', 'a4', { showRepName: false })),
  'page_branded-noSignatures': lookFor(prof('page_branded', 'a4', { showSignatures: false })),
  'page_branded-noItemUnit': lookFor(prof('page_branded', 'a4', { showItemUnit: false })),
  'page_branded-footerText': lookFor(prof('page_branded', 'a4', { footerText: 'نسعد بخدمتكم — للاستفسار 920000000' })),
  'page_branded-bold': lookFor(prof('page_branded', 'a4', { boldBody: true })),
  'page_branded-fontScale1.3': lookFor(prof('page_branded', 'a4', { fontScale: 1.3 })),
  'page_branded-qrLarge': lookFor(prof('page_branded', 'a4', { qrSize: 'large' })),
  'page_branded-itemCodes-balance': lookFor(prof('page_branded', 'a4', { showItemCodes: true, showCustomerBalance: true })),
  'page_branded-copies3-labels': lookFor(prof('page_branded', 'a4', { copies: 3, copyLabels: true, graphicsQuality: 'draft' })),
  'page_plain-a4': lookFor(prof('page_plain', 'a4')),
  'page_plain-a5': lookFor(prof('page_plain', 'a5')),
  'page_plain-bold-noLogo': lookFor(prof('page_plain', 'a4', { boldBody: true, showLogo: false })),
  'impact_plain-ff_a4': lookFor(prof('impact_plain', 'ff_a4')),
  'impact_plain-cut_a4': lookFor(prof('impact_plain', 'cut_a4')),
  'impact_plain-ff_95x11': lookFor(prof('impact_plain', 'ff_95x11')),
  'impact_plain-ff_95x12': lookFor(prof('impact_plain', 'ff_95x12')),
  'impact_plain-ff_85x11': lookFor(prof('impact_plain', 'ff_85x11')),
  'impact_plain-ff_95x55': lookFor(prof('impact_plain', 'ff_95x55')),
  'impact_plain-ff_a4-qrLarge': lookFor(prof('impact_plain', 'ff_a4', { qrSize: 'large' })),
  'impact_plain-ff_a4-notBold-logo': lookFor(prof('impact_plain', 'ff_a4', { boldBody: false, showLogo: true })),
  'impact_plain-ff_a4-minimal-options': lookFor(prof('impact_plain', 'ff_a4', {
    showContact: false, showRepName: false, showSignatures: false, showItemUnit: false, footerText: 'شكراً',
  })),
  'impact_preprinted-ff_a4': lookFor(prof('impact_preprinted', 'ff_a4')),
  'impact_preprinted-cut_a4-logo': lookFor(prof('impact_preprinted', 'cut_a4', { showLogo: true })),
};

// ─── نصوص المطبوعات المحفوظة الممثِّلة ───
const TEXTS: Record<string, unknown> = {
  'none': undefined,
  /** صياغة عربية وإخفاء صفوفٍ كاملة غير إلزامية — بلا لغة ثانية */
  'ar': {
    version: 1, secondLang: null, companyNameAlt: null, companyAddressAlt: null,
    edits: {
      'inv.number': { text: 'رقم الفاتورة الضريبية', alt: null, hidden: false },
      'inv.rep': { text: 'مندوب المبيعات', alt: null, hidden: false },
      'inv.type': { text: null, alt: null, hidden: true },
      'cust.phone': { text: 'رقم الجوال', alt: null, hidden: false },
      'col.item': { text: 'البيان', alt: null, hidden: false },
      'tot.subtotal': { text: 'الإجمالي قبل الخصم', alt: null, hidden: false },
      'tot.paid': { text: 'المبلغ المدفوع', alt: null, hidden: false },
      'tot.remaining': { text: null, alt: null, hidden: true },
      'h.email': { text: null, alt: null, hidden: true },
      'h.phone': { text: 'جوال', alt: null, hidden: false },
      'foot.thanks': { text: 'نشكر زيارتكم ونتطلع لخدمتكم دائماً', alt: null, hidden: false },
      'sig.recipient': { text: 'استلمت البضاعة كاملة', alt: null, hidden: false },
      'rcp.time': { text: null, alt: null, hidden: true },
      'rcp.notes': { text: 'البيان', alt: null, hidden: false },
      'rcp.sigPayer': { text: 'توقيع العميل', alt: null, hidden: false },
    },
  },
  /** لغة ثانية (الإنجليزية) واسم الشركة وعنوانها بها، وصياغة وترجمة يدوية وإخفاء صفوف غير إلزامية */
  'bi': {
    version: 1, secondLang: 'en', companyNameAlt: 'Test Distribution Co.', companyAddressAlt: 'Tahlia St, Olaya, Riyadh',
    edits: {
      'inv.number': { text: null, alt: 'Invoice No.', hidden: false },
      'inv.rep': { text: 'مندوب المبيعات', alt: 'Salesman', hidden: false },
      'cust.phone': { text: 'رقم الجوال', alt: 'Mobile', hidden: false },
      'col.qty': { text: null, alt: 'Qty.', hidden: false },
      'tot.paid': { text: null, alt: 'Amount paid', hidden: false },
      'h.email': { text: null, alt: null, hidden: true },
      'sig.rep': { text: null, alt: null, hidden: true },
      'foot.thanks': { text: 'نشكر زيارتكم', alt: 'Thank you for your visit', hidden: false },
      'rcp.method': { text: null, alt: 'Payment method', hidden: false },
      'rcp.sigCollector': { text: 'توقيع المحصّل', alt: 'Collector', hidden: false },
    },
  },
};

// ─── بيانات الشركة: أشكال الترويسة ولونها وشعارها ───
const COMPANIES: Record<string, Partial<Company>> = {
  'base': {},
  'banner': { headerStyle: 'banner' },
  'minimal': { headerStyle: 'minimal' },
  'coral': { primaryColor: '#E15A30' },
  'banner-coral-noLogo': { headerStyle: 'banner', primaryColor: '#E15A30', logo: null },
  'noLogo': { logo: null },
  'bare': { address: undefined, commercialReg: undefined, phone: undefined, email: undefined, logo: null },
  'nonSA': { countryCode: 'AE' },
};

// ─── بناء الحالات ───
type AnyDoc = InvoiceDoc | ReceiptDoc;
const ALL_DOCS: Record<string, AnyDoc> = { ...INVOICES, ...RECEIPTS };

function render(doc: AnyDoc, look: PrintLook | null): string {
  const el = doc.kind === 'invoice' ? createElement(PrintableInvoice, { doc }) : createElement(PrintableReceipt, { doc });
  return renderToStaticMarkup(look ? createElement(PrintLookContext.Provider, { value: look }, el) : el);
}
function withCompany(doc: AnyDoc, over: Partial<Company>, texts: unknown): AnyDoc {
  const company = { ...(doc.company ?? COMPANY), ...over } as Company;
  if (texts !== undefined) company.printTexts = texts;
  return { ...doc, company };
}

interface Case { name: string; doc: AnyDoc; look: PrintLook | null }
function buildCases(): Case[] {
  const out: Case[] = [];
  const add = (docName: string, lookName: string, textsName: string, companyName = 'base') => {
    const doc = withCompany(ALL_DOCS[docName], COMPANIES[companyName], TEXTS[textsName]);
    out.push({ name: `${docName}|${lookName}|${textsName}|${companyName}`, doc, look: LOOKS[lookName] });
  };
  // أ) كل مستند × بلا مزوّد/legacy-a4/page_plain/النقطيّتان × بلا نصوص
  for (const d of Object.keys(ALL_DOCS)) {
    for (const l of ['none', 'legacy-a4', 'page_plain-a4', 'impact_plain-ff_a4', 'impact_preprinted-ff_a4']) add(d, l, 'none');
  }
  // ب) كل مستند × النصوص المحفوظة الممثِّلة (الافتراضي، ومعها الأحادي والنقطية للغة الثانية)
  for (const d of Object.keys(ALL_DOCS)) {
    add(d, 'none', 'ar');
    add(d, 'none', 'bi');
    add(d, 'page_plain-a4', 'bi');
    add(d, 'impact_plain-ff_a4', 'bi');
  }
  // ج) كل خيار/مقاس × مستندات ممثِّلة (مبسّطة آجلة، ضريبية بتوقيعات، مختومة، إشعار دائن مختوم، سند)
  const REP = ['p1-simplified-credit', 'p1-standard', 'p2-simplified-reported', 'p2-credit-note', 'rcp-single'];
  for (const l of Object.keys(LOOKS)) for (const d of REP) add(d, l, 'none');
  for (const l of ['page_branded-noRepName', 'page_branded-noSignatures', 'page_branded-footerText', 'impact_plain-ff_a4-minimal-options']) {
    for (const d of REP) add(d, l, 'bi');
  }
  // د) بيانات الشركة × مستندات ممثِّلة × (بلا نصوص، لغة ثانية) — وعلى الأحادي والنقطية
  for (const c of Object.keys(COMPANIES)) {
    for (const d of ['p1-simplified-credit', 'p2-standard-cleared', 'rcp-single']) {
      add(d, 'none', 'none', c);
      add(d, 'none', 'bi', c);
      add(d, 'page_plain-a4', 'none', c);
      add(d, 'impact_plain-ff_a4', 'none', c);
    }
  }
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}

// ─── المخزن: a4.manifest.json (حالة ⇒ sha256، مقروء) وa4.markup.json.br (كل مخرَجٍ فريد مرّةً واحدة: {sha256: markup}) ───
// الحزمة مضغوطة brotli (نحو ٤ ميغابايت من الترميز المكرّر ⇒ عشرات الكيلوبايت)، وثنائيّةٌ فلا يمسّها تحويل نهايات الأسطر في git.
// لقراءتها: node -e "console.log(require('zlib').brotliDecompressSync(require('fs').readFileSync('a4.markup.json.br')).toString())"
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
interface Manifest { about: string; node: string; icu: string; cases: Record<string, string> }
const readManifest = (): Manifest => JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Manifest;
let bundle: Record<string, string> | null = null;
const readBundle = (): Record<string, string> =>
  (bundle ??= JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(BUNDLE)).toString('utf8')) as Record<string, string>);

function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}
const around = (s: string, i: number) => JSON.stringify(s.slice(Math.max(0, i - 80), i + 80));

const CASES = buildCases();

if (WRITE) {
  test('BASELINE_WRITE=1: تجديد النسخ المجمّدة لقوالب الصفحة', () => {
    assert.ok(!process.env.CI, 'التجديد ممنوع داخل CI');
    fs.mkdirSync(DIR, { recursive: true });
    const cases: Record<string, string> = {};
    const markup: Record<string, string> = {};
    for (const c of CASES) {
      const html = render(c.doc, c.look);
      const h = sha(html);
      cases[c.name] = h;
      markup[h] = html;
    }
    const sorted = Object.fromEntries(Object.keys(markup).sort().map((k) => [k, markup[k]]));
    const raw = Buffer.from(JSON.stringify(sorted), 'utf8');
    fs.writeFileSync(BUNDLE, zlib.brotliCompressSync(raw, { params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    } }));
    const manifest: Manifest = {
      about: 'خط أساس قوالب الصفحة (A4/النقطية) — f037417، ٣ نوفمبر ٢٠٢٦. يُجدَّد بـBASELINE_WRITE=1 وحده؛ لا يعدّله إلا كاتبه.',
      node: process.version, icu: process.versions.icu ?? '', cases,
    };
    fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 1)}\n`, 'utf8');
    console.log(`baseline A4: ${CASES.length} حالة، ${Object.keys(markup).length} مخرَجٍ فريد`);
  });
} else {
  test('خط الأساس: المخزن سليم — كل حالةٍ لها نسخة مجمّدة بصمتها مفتاحها، ولا حالة مفقودة ولا زائدة', () => {
    const m = readManifest();
    const b = readBundle();
    assert.deepEqual(Object.keys(m.cases).sort(), CASES.map((c) => c.name).sort(), 'قائمة الحالات تغيّرت — خط الأساس لا يُعدَّل إلا بكاتبه');
    assert.deepEqual(Object.keys(b).sort(), [...new Set(Object.values(m.cases))].sort(), 'نسخ مجمّدة يتيمة أو مفقودة');
    for (const [h, html] of Object.entries(b)) assert.equal(sha(html), h, `النسخة ${h.slice(0, 16)} عُدّلت يدوياً`);
  });

  const groups: [string, (n: string) => boolean][] = [
    ['الفواتير والمرتجعات — المرحلة الأولى', (n) => /^(p1-|nonSA-)/.test(n)],
    ['المرحلة الثانية — الرمز المختوم والإشعار الدائن وسند التسليم', (n) => n.startsWith('p2-')],
    ['سند القبض', (n) => n.startsWith('rcp-')],
  ];
  for (const [title, inGroup] of groups) {
    test(`خط الأساس حرفاً بحرف: ${title}`, () => {
      const m = readManifest();
      const b = readBundle();
      const mine = CASES.filter((x) => inGroup(x.name));
      assert.ok(mine.length > 0);
      const bad: string[] = [];
      for (const c of mine) {
        const html = render(c.doc, c.look);
        const want = m.cases[c.name];
        const got = sha(html);
        if (got === want) continue;
        const frozen = b[want] ?? '';
        const i = firstDiff(frozen, html);
        bad.push([
          c.name,
          `   sha256 ${String(want).slice(0, 16)} ⇒ ${got.slice(0, 16)}، أول اختلاف عند ${i} (الطول ${frozen.length} ⇒ ${html.length})`,
          `   كان:  ${around(frozen, i)}`,
          `   صار:  ${around(html, i)}`,
        ].join('\n'));
      }
      const env = m.icu !== (process.versions.icu ?? '')
        ? `\n(تنبيه: ICU ${process.versions.icu} غير ICU الالتقاط ${m.icu} — تنسيق التواريخ والأرقام قد يختلف)` : '';
      assert.equal(bad.length, 0, `${bad.length} من ${mine.length} ورقة تغيّرت عن خط الأساس:\n${bad.slice(0, 12).join('\n')}${env}`);
    });
  }

  test('خط الأساس يحمل ما يدّعيه: الرمز المختوم وعناوين الهيئة وسطر المنصّة واللغة الثانية والأحادي', () => {
    const m = readManifest();
    const b = readBundle();
    const at = (k: string) => { const h = m.cases[k]; assert.ok(h && b[h], k); return b[h]; };
    for (const k of Object.keys(m.cases)) assert.ok(b[m.cases[k]].includes('Field Sales · fieldsa.net'), `${k}: سطر المنصّة`);
    assert.ok(at('p2-simplified-reported|impact_plain-ff_a4|none|base').includes(`data-qr-value="${STAMPED_QR}"`), 'الرمز المختوم في خانة النقطية');
    assert.ok(at('p2-simplified-reported|none|none|base').includes('ICV 4127 · 3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c'));
    assert.match(at('p1-simplified-credit|impact_plain-ff_a4|none|base'), /data-qr-value="[A-Za-z0-9+/=]{40,}" data-qr-ec="M"/, 'رمز المرحلة الأولى');
    assert.ok(at('p1-simplified-credit|none|none|base').includes('فاتورة ضريبية مبسطة'));
    assert.ok(at('p1-standard|none|none|base').includes('>فاتورة ضريبية<') && at('p1-standard|none|none|base').includes('311111111111113'));
    assert.ok(at('p2-standard-cleared|none|none|base').includes('رمز الفاتورة المعتمد من هيئة الزكاة والضريبة والجمارك'));
    assert.ok(at('p2-credit-note|none|none|base').includes('إشعار دائن') && at('p2-credit-note|none|none|base').includes('INV-2610-000777'));
    assert.ok(at('p2-delivery-note|none|none|base').includes('سند تسليم — ليست فاتورة ضريبية'));
    assert.ok(at('p2-rehearsal|none|none|base').includes('بيئة محاكاة الهيئة'));
    assert.ok(at('rcp-single|none|none|base').includes('سند قبض') && at('rcp-single|none|none|base').includes('INV-2611-000123'));
    assert.ok(at('rcp-single|none|bi|base').includes('Test Distribution Co.') && at('rcp-single|none|bi|base').includes('Collector'));
    assert.ok(at('p1-simplified-credit|none|ar|base').includes('نشكر زيارتكم ونتطلع لخدمتكم دائماً') && !at('p1-simplified-credit|none|ar|base').includes('>النوع'));
    assert.ok(at('p1-simplified-credit|page_plain-a4|none|base').includes('data-print-look="mono"'));
    assert.ok(at('p1-simplified-credit|page_branded-a5|none|base').includes('data-pdf-format="a5"'));
    assert.ok(at('p1-standard|none|none|base').includes('١٢:١٥'), 'وقت الإصدار بتوقيت الرياض');
  });

  test('خط الأساس: الملف الافتراضي legacy-a4 وpage_branded بخياراته الافتراضية = غياب الإعداد حرفاً', () => {
    const m = readManifest();
    for (const d of Object.keys(ALL_DOCS)) {
      const none = m.cases[`${d}|none|none|base`];
      assert.ok(none, d);
      assert.equal(m.cases[`${d}|legacy-a4|none|base`], none, `${d}: legacy-a4`);
      assert.equal(sha(render(withCompany(ALL_DOCS[d], {}, undefined), LOOKS['page_branded-a4'])), none, `${d}: page_branded`);
    }
  });
}
