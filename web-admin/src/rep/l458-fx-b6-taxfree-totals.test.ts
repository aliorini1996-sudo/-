/**
 * «ربط الدفاتر» B6 — إصلاح مراجعة ١٤ نوفمبر ٢٠٢٦: مرتجع فاتورة بيعٍ خاضعة في شركةٍ مربوطة أزالت ضريبتها.
 *
 * السجلّ (صحيحٌ للدفاتر): subtotal = 100 (الصافي) وtaxAmt = 15 وtotal = 115، مختومٌ taxFree. كان القالب الافتراضي (A4 الكلاسيكي)
 * والورق المطبوع مسبقاً وشاشة تفاصيل الفاتورة تعرض «المجموع قبل الخصم 100.00» ثم «الإجمالي 115.00» بلا سطرٍ يفسّر الـ15.
 * الاختبار الذهبي: ورقة مرتجع B6 في القوالب الثلاثة (الافتراضي، والثنائي، والمطبوع مسبقاً) = ورقة المرتجع نفسه كما كان يُخزَّن قبل
 * B6 (نسبة صفر، subtotal = total) حرفاً بحرف — ولا «100.00» ولا ذكرٌ للضريبة. وشاشة التفاصيل كذلك. وكل مستندٍ آخر كما هو حرفاً.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintableInvoice, taxFreeView, type Company, type InvoiceDoc } from './RepDocuments';
import { PrintLookContext, lookFor } from './printLook';
import { formFieldValues, formValueKit } from './printPreprinted';
import { defaultPrintLayout, defaultPrintOptions, presetPaper, withDesign, type PrintProfile } from '../lib/print/printSettings';
import { firstTaxMention } from '../lib/print/taxFreePrint';
import { makePrintTexts } from '../lib/print/printTexts';
import { zatcaPrintDecision } from '../lib/zatca/docPrint';
import { taxFreeCarriesVat, taxFreeShownAmounts, taxFreeShownSubtotal } from '../lib/taxFreeTotals';
import InvoiceDetailModal from '../components/forms/InvoiceDetailModal';
import type { Invoice } from '../types';
import { useLang } from '../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';

process.env.TZ = 'Asia/Riyadh';
useLang.setState({ lang: 'ar' });
setActiveNumerals('latin');
setActiveCurrency('SAR');

const OFF: Company = {
  name: 'شركة الاختبار للتوزيع', address: 'حي العليا', taxNumber: '300000000000003', commercialReg: '1010101010', phone: '0501234567',
  countryCode: 'SA', addrCity: 'الرياض', addrPostalCode: '12345', taxDisabled: true,
};
const BUYER = { name: 'بقالة الحي', phone: '0533333333' };

/** E4.9: مرتجع RET-901 من INV-900 (كرتون بـ115 شاملاً = 100 + 15) كما يخزّنه الخادم في المربوطة بعد B6 */
const b6 = (o: Partial<InvoiceDoc> = {}): InvoiceDoc => ({
  kind: 'invoice', taxFree: true, isReturn: true, number: 'RET-901', date: '2026-11-14T09:15:00.000Z', type: 'CREDIT', company: OFF,
  customer: BUYER, repName: 'أحمد السالم', billingReference: 'INV-900',
  items: [{ name: 'مياه معدنية', unit: 'كرتون', qty: 1, unitPrice: 115, discountPct: 0, taxPct: 15, lineTotal: 115, taxAmt: 15 }],
  subtotal: 100, discount: 0, tax: 15, total: 115, pricesIncludeTax: true,
  einvoice: { provider: 'none', status: null, uuid: null, qr: null }, zatca: null, ...o,
});
/** المرتجع نفسه كما كان يُخزَّن قبل B6 (ومسار غير المربوطة اليوم): نسبة صفر وsubtotal = total */
const today = (o: Partial<InvoiceDoc> = {}): InvoiceDoc => b6({
  items: [{ name: 'مياه معدنية', unit: 'كرتون', qty: 1, unitPrice: 115, discountPct: 0, taxPct: 0, lineTotal: 115, taxAmt: 0 }],
  subtotal: 115, tax: 0, ...o,
});

const page = (): PrintProfile => ({
  id: 'p-page', name: 'A4', printer: 'page', template: 'page_branded', paper: presetPaper('a4')!,
  options: { ...defaultPrintOptions('page'), layout: defaultPrintLayout('page', 'standard') },
});
const TEMPLATES: { name: string; profile: PrintProfile | null }[] = [
  { name: 'الافتراضي (A4 الكلاسيكي بلا إعدادات)', profile: null },
  { name: 'A4 القياسي بتخطيط', profile: page() },
  { name: 'الثنائي (كلاسيكي بإطارات)', profile: withDesign(page(), 'grid_bilingual') },
  { name: 'المطبوع مسبقاً', profile: withDesign(page(), 'preprinted') },
];
const sheet = (p: PrintProfile | null, doc: InvoiceDoc): string => {
  const el = createElement(PrintableInvoice, { doc });
  return renderToStaticMarkup((p ? createElement(PrintLookContext.Provider, { value: lookFor(p) }, el) : el) as ReactElement);
};

test('ذهبي: مرتجع B6 في كل قالب = ورقته قبل B6 حرفاً — «المجموع قبل الخصم» 115 لا 100، ولا ذكر للضريبة', () => {
  assert.equal(withDesign(page(), 'preprinted').options.layout?.design, 'preprinted');
  for (const t of TEMPLATES) {
    const got = sheet(t.profile, b6());
    assert.equal(got, sheet(t.profile, today()), `${t.name}: ورقة B6 تخالف ورقة المرتجع قبله`);
    assert.ok(!got.includes('100.00'), `${t.name}: الصافي 100.00 على ورقة بلا ضريبة`);
    assert.ok(got.includes('115.00'), `${t.name}: الإجمالي غائب`);
    assert.equal(firstTaxMention(got.replace(/<[^>]+>/g, ' ')), null, `${t.name}: ذكرٌ للضريبة`);
  }
  // القالب الافتراضي: سطر «المجموع قبل الخصم» يطبع 115.00 (كان 100.00)
  const def = sheet(null, b6());
  assert.match(def, /المجموع قبل الخصم[\s\S]{0,200}?115\.00/);
});

test('ذهبي بخصم: B6 مع خصم فاتورة (دفاعاً) — المجموع = الإجمالي + الخصم فيتّزن «المجموع − الخصم = الإجمالي»', () => {
  const doc = b6({ subtotal: 90, discount: 10, tax: 13.5, total: 103.5, items: [{ name: 'مياه معدنية', unit: 'كرتون', qty: 1, unitPrice: 115, discountPct: 0, taxPct: 15, lineTotal: 115, taxAmt: 13.5 }] });
  const v = taxFreeShownAmounts(doc);
  assert.deepEqual([v.subtotal, v.discount, v.tax, v.total], [113.5, 10, 0, 103.5]);
  assert.equal(v.subtotal - v.discount, v.total);
  assert.deepEqual(v.items.map((i) => [i.taxPct, i.taxAmt]), [[0, 0]]);
});

test('المطبوع مسبقاً: حقل subtotal = 115 ولو رُسم FormInvoice مباشرةً بلا taxFreeView (دفاعاً)', () => {
  const doc = b6();
  const zDecision = zatcaPrintDecision({ isReturn: true, buyerHasTaxNumber: false, saudi: true, taxFree: true }, null);
  const pt = makePrintTexts(null, (s) => s);
  const facts = { pt, zDecision, title: { text: 'فاتورة مرتجع', alt: null }, inclusiveDoc: true };
  const k = formValueKit(doc, facts, { latinDigits: true, valueLang: 'ar' });
  const values = formFieldValues(doc, facts, k);
  assert.equal(values.subtotal?.text, '115.00');
  assert.equal(values.totalDue?.text, '115.00');
  assert.equal(values.vatAmount, undefined, 'لا حقل ضريبة على مستندٍ بلا ضريبة');
  // والمستند بضريبته (غير مختوم): الصافي كما كان
  const taxed = { ...doc, taxFree: undefined };
  assert.equal(formFieldValues(taxed, facts, formValueKit(taxed, facts, { latinDigits: true, valueLang: 'ar' })).subtotal?.text, '100.00');
});

test('لا تغيير لغير B6: المختوم ضريبته صفر، وغير المختوم بضريبته، والمرجع نفسه بلا نسخ', () => {
  const free = today();
  assert.equal(taxFreeCarriesVat(free), false);
  assert.equal(taxFreeShownAmounts(free), free, 'المختوم بضريبة صفر: المرجع نفسه');
  const taxed = b6({ taxFree: undefined, company: { ...OFF, taxDisabled: false } });
  assert.equal(taxFreeShownAmounts(taxed), taxed, 'غير المختوم: المرجع نفسه');
  assert.equal(taxFreeView(taxed), taxed, 'taxFreeView لغير المختوم كما كان: المرجع نفسه');
  assert.equal(taxFreeShownSubtotal({ subtotal: 100, discountAmt: 0, taxAmt: 15, total: 115 }), 100, 'المستند بضريبته: الصافي كما كان');
  // والفاتورة المختومة بضريبة صفر: الورقة كما كانت (المجموع = subtotal المخزَّن)
  assert.equal(taxFreeShownSubtotal({ taxFree: true, subtotal: 53.5, discountAmt: 0.75, taxAmt: 0, total: 52.75 }), 53.5);
  // والمستند غير المختوم يُطبع بضريبته حرفاً (صافي 100 وسطر الضريبة)
  const html = sheet(null, taxed);
  assert.match(html, /المجموع قبل الخصم[\s\S]{0,200}?100\.00/);
});

const row = (o: Record<string, unknown> = {}): Invoice => ({
  id: 'i-901', number: 'RET-901', invoiceDate: '2026-11-14T09:15:00.000Z', type: 'CREDIT', status: 'CONFIRMED', taxFree: true,
  einvoiceProvider: 'none', customer: { id: 'c-1', name: 'بقالة الحي', phone: '0533333333' }, salesRep: { id: 'r-1', name: 'أحمد' },
  items: [{ id: 'it-1', product: { name: 'مياه معدنية', unit: 'كرتون' }, unitName: 'كرتون', qty: 1, unitPrice: 115, discountPct: 0, taxPct: 15, lineTotal: 115 }],
  subtotal: 100, discountAmt: 0, taxAmt: 15, total: 115, paidAmt: 0, remainingAmt: 0, ...o,
} as unknown as Invoice);

test('شاشة تفاصيل الفاتورة: «قبل الخصم» لمرتجع B6 = 115.00 لا 100.00، ولا سطر ضريبة — والمستند بضريبته كما كان', () => {
  const html = renderToStaticMarkup(createElement(InvoiceDetailModal, { invoice: row(), onClose: () => undefined }));
  assert.match(html, /قبل الخصم<\/span><span>[^<]*115\.00/);
  assert.ok(!html.includes('100.00'), 'الصافي على شاشة مستندٍ بلا ضريبة');
  assert.equal(firstTaxMention(html.replace(/<[^>]+>/g, ' ')), null);
  const before = renderToStaticMarkup(createElement(InvoiceDetailModal, { invoice: row({ taxFree: false, einvoiceProvider: null }), onClose: () => undefined }));
  assert.match(before, /قبل الخصم<\/span><span>[^<]*100\.00/, 'المستند بضريبته: الصافي كما كان');
});
