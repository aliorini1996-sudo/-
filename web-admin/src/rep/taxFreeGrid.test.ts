/**
 * «إزالة الضريبة» في القالب «كلاسيكي بإطارات — ثنائي اللغة» (rep/printGrid.tsx) ومحلِّل «نصوص المطبوعات» ونواته
 * (lib/print/printTexts.ts + printTextsCore.ts) — طلب المالك ٧ نوفمبر ٢٠٢٦: «لا يكون لها ذكر في اي سطر في النظام ولا في اي مستند».
 *
 * ١) فاتورةٌ مختومة بلا ضريبة (قرار الطباعة taxFree ⇒ hideTaxIds) ⇒ لا عمود ضريبة ولا صفّ ولا ملاحظة أسعارٍ شاملة ولا ملاحظة أقساط
 *    ضريبية، ولا الرقم الضريبي للبائع أو المشتري، ولا رمز QR ولو مُرِّرت عقدته — بأيّ لغةٍ ثانية، والعنوان «فاتورة»/«فاتورة مرتجع».
 * ٢) السند: علم الشركة (taxDisabled) يُسقط رقمها الضريبيّ من الترويسة ورقم العميل من صندوقه.
 * ٣) بلا ختمٍ ولا علم: الورقة حرفاً كما كانت (layout6 والحرّاس الذهبية).
 * ٤) النواة: TAX_PHRASE_KEYS تغطّي كل عبارةٍ ضريبية في القائمة، وتنبيهات المحرّر بلا ضريبة لشركةٍ أزالتها، والنسختان متطابقتان.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GridInvoice, GridReceipt, type GridInvoiceFacts } from './printGrid';
import type { InvoiceDoc, ReceiptDoc } from './RepDocuments';
import { DEFAULT_PRINT_LOOK, lookFor, type PrintLook } from './printLook';
import { zatcaPrintDecision } from '../lib/zatca/docPrint';
import { makePrintTexts, normalizePrintTexts, phraseIn, titleKeyOf, type PrintTexts } from '../lib/print/printTexts';
import {
  PRINT_TEXT_CATALOG, TAX_FREE_TITLE_TEXTS, TAX_PHRASE_KEYS, isTaxPhraseKey, printTextEntry, printTextWarning, printTextWarningFor,
  type PrintSecondLang,
} from '../lib/print/printTextsCore';
import { DEFAULT_SECTIONS, type ResolvedLayout } from '../lib/print/layout';
import { defaultPrintOptions, presetPaper, type PrintProfile } from '../lib/print/printSettings';
import { TAX_FREE_FORBIDDEN, firstTaxMention, isTaxFreePrint } from '../lib/print/taxFreePrint';
import { TAX_FREE_TITLES, isDocTaxFree } from '../lib/taxMode';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const SELLER_VAT = '300123456700003';
const BUYER_VAT = '310987654300003';
const company = {
  name: 'مؤسسة مروج الخليج للتجارة', address: 'حي السلي، شارع الخرج', taxNumber: SELLER_VAT, commercialReg: '1010456789',
  phone: '0551234567', email: 'info@murouj.sa', logo: PNG, countryCode: 'SA', primaryColor: '#0F766E',
  addrCity: 'الرياض', addrPostalCode: '14322', taxDisabled: true,
};
const customer = {
  name: 'سوبرماركت النخبة', businessName: 'مؤسسة النخبة', commercialReg: '1010999888', taxNumber: BUYER_VAT,
  phone: '0500000000', address: 'طريق أنس بن مالك', district: 'حي الملقا', city: 'جدة', postalCode: '13524',
};
/** بنود فاتورةٍ صدرت بلا ضريبة: 0% وtaxAmt صفر، والإجمالي = الصافي */
const items = [
  { name: 'مياه نوفا 330 مل', code: 'P-1001', unit: 'كرتون', multiUnit: true, qty: 5, unitPrice: 14.5, discountPct: 0, taxPct: 0, lineTotal: 72.5, taxAmt: 0 },
  { name: 'عصير برتقال', code: 'P-1002', unit: 'حبة', multiUnit: true, qty: 12.5, unitPrice: 4, discountPct: 10, taxPct: 0, lineTotal: 45, taxAmt: 0 },
];
const freeInv = (extra: Partial<InvoiceDoc> = {}): InvoiceDoc => ({
  kind: 'invoice', number: 'SI-2026-009001', date: '2026-11-07T10:42:00', type: 'CREDIT', paymentPlan: 'INSTALLMENT',
  installments: [{ seq: 1, dueDate: '2026-12-01', amount: 60 }, { seq: 2, dueDate: '2027-01-01', amount: 52.5 }],
  deliveryDate: '2026-11-08', recipientSignature: PNG, repSignature: PNG,
  company: company as InvoiceDoc['company'], customer: customer as InvoiceDoc['customer'], repName: 'خالد العتيبي',
  items: items as InvoiceDoc['items'],
  subtotal: 122.5, discount: 5, tax: 0, total: 117.5, pricesIncludeTax: false, paidAmt: 17.5, remainingAmt: 100,
  taxFree: true, zatca: null, ...extra,
});
const freeReturn = (extra: Partial<InvoiceDoc> = {}) =>
  freeInv({ isReturn: true, billingReference: 'SI-2026-009001', noteReason: 'تلف في العبوة', paymentPlan: null, installments: [], ...extra });
/** المستند القديم بضريبته — صدر قبل الإزالة */
const oldInv = () => freeInv({
  taxFree: undefined, pricesIncludeTax: true, tax: 15.33,
  items: items.map((it) => ({ ...it, taxPct: 15, taxAmt: 7 })) as InvoiceDoc['items'],
});
const receipt = (extra: Partial<ReceiptDoc> = {}): ReceiptDoc => ({
  kind: 'receipt', number: 'RC-77', date: '2026-11-07T11:00:00', company: company as ReceiptDoc['company'],
  customer: customer as ReceiptDoc['customer'], repName: 'خالد العتيبي', amount: 300, paymentMethod: 'CASH', notes: 'دفعة نوفمبر',
  invoices: [{ number: 'SI-1', amount: 100 }, { number: 'SI-2', amount: 150 }], ...extra,
});

const layout = (o: Partial<ResolvedLayout> = {}): ResolvedLayout => ({
  design: 'grid_bilingual', logo: 'center', logoSize: 'm', accent: null, tableStyle: 'grid', fontScale: 1,
  order: DEFAULT_SECTIONS.grid, printer: 'page', ...o,
} as ResolvedLayout);
/** المسار الحرّ (logoMm + أقسام) — والرمز اليتيم بإخفاء «البيانات» */
const freeLayout = (): ResolvedLayout => layout({ logoMm: 18, sections: { info: { visible: false } } } as Partial<ResolvedLayout>);
const QR = createElement('div', { 'data-test-qr': '1' }, createElement('img', { alt: 'QR', src: PNG }));

const textsOf = (lang: PrintSecondLang | null, edits: Record<string, unknown> = {}) =>
  normalizePrintTexts({ version: 1, secondLang: lang, companyNameAlt: null, companyAddressAlt: null, edits });
const ptOf = (lang: PrintSecondLang | null, edits: Record<string, unknown> = {}): PrintTexts =>
  makePrintTexts(lang === null && Object.keys(edits).length === 0 ? null : textsOf(lang, edits), (s) => s);

function factsFor(doc: InvoiceDoc, pt: PrintTexts): GridInvoiceFacts {
  const zDecision = zatcaPrintDecision(
    { isReturn: !!doc.isReturn, buyerHasTaxNumber: !!doc.customer.taxNumber, saudi: true, taxFree: isDocTaxFree(doc) }, doc.zatca,
  );
  return {
    pt, zDecision, title: pt.title(zDecision.title, { isReturn: !!doc.isReturn, phase2: false }),
    inclusiveDoc: !!doc.pricesIncludeTax, vatRate: '0%',
    noteRefs: doc.isReturn ? { ref: doc.billingReference ?? null, reason: doc.noteReason ?? null } : { ref: null, reason: null },
  };
}
const gridInv = (doc: InvoiceDoc, pt: PrintTexts, o: { look?: PrintLook; lay?: ResolvedLayout; qr?: ReactNode | null } = {}) =>
  renderToStaticMarkup(createElement(GridInvoice, {
    doc, facts: factsFor(doc, pt), look: o.look ?? DEFAULT_PRINT_LOOK, layout: o.lay ?? layout(), qr: o.qr === undefined ? QR : o.qr,
  }));
const gridRcp = (doc: ReceiptDoc, pt: PrintTexts, o: { look?: PrintLook; lay?: ResolvedLayout } = {}) =>
  renderToStaticMarkup(createElement(GridReceipt, {
    doc, pt, title: { text: pt.hidden('rcp.title') ? '' : pt.text('rcp.title', 'سند قبض'), alt: null },
    look: o.look ?? DEFAULT_PRINT_LOOK, layout: o.lay ?? layout(),
  }));

const impact: PrintProfile = {
  id: 'mip', name: 'MIP480', printer: 'impact', template: 'impact_plain', paper: presetPaper('ff_a4')!, options: defaultPrintOptions('impact'),
};
const LOOKS: readonly { name: string; look: PrintLook; lay: ResolvedLayout }[] = [
  { name: 'page', look: DEFAULT_PRINT_LOOK, lay: layout() },
  { name: 'impact', look: lookFor(impact), lay: layout({ printer: 'impact' } as Partial<ResolvedLayout>) },
  { name: 'free', look: DEFAULT_PRINT_LOOK, lay: freeLayout() },
];
const LANGS: readonly (PrintSecondLang | null)[] = [null, 'en', 'fr', 'tr', 'zh'];

function assertNoTax(html: string, label: string): void {
  assert.equal(firstTaxMention(html), null, `${label}: ذكرٌ للضريبة`);
  assert.ok(!html.includes(SELLER_VAT), `${label}: الرقم الضريبي للبائع`);
  assert.ok(!html.includes(BUYER_VAT), `${label}: الرقم الضريبي للمشتري`);
  assert.ok(!html.includes('data-test-qr') && !html.includes('data-grid-qr'), `${label}: رمز QR`);
  // وحدات عبارات الضريبة غائبة (عمود السعر يحمل مفتاحيه col.price col.priceIncl سمةً داخلية — ونصّه «السعر»)
  for (const k of TAX_PHRASE_KEYS.filter((x) => x !== 'col.priceIncl')) assert.ok(!new RegExp(`data-line="[^"]*\\b${k.replace('.', '\\.')}\\b`).test(html), `${label}: وحدة ${k}`);
}

test('فاتورة البيع المختومة بلا ضريبة في القالب ثنائي اللغة: لا ضريبة ولا رقم ضريبيّ ولا رمز — بكل لغةٍ ثانية ومظهر', () => {
  for (const { name, look, lay } of LOOKS) {
    for (const lang of LANGS) {
      const html = gridInv(freeInv(), ptOf(lang), { look, lay });
      const label = `${name}/${lang ?? 'none'}`;
      assertNoTax(html, label);
      assert.match(html, />فاتورة</, `${label}: العنوان «فاتورة»`);
      assert.ok(html.includes('117.50') && html.includes('72.50') && html.includes('45.00'), `${label}: المبالغ`);
      assert.ok(html.includes('جدول الأقساط'), `${label}: جدول الأقساط باقٍ بلا ملاحظته الضريبية`);
      assert.ok(html.includes(company.commercialReg) && html.includes(customer.commercialReg), `${label}: السجل التجاري باقٍ`);
      if (lang === null || lang === 'en') assert.ok(html.includes('>Invoice<'), `${label}: «Invoice»`);
    }
  }
});

test('المرتجع المختوم بلا ضريبة: «فاتورة مرتجع» و«Return Invoice» — لا «إشعار دائن» ولا «Credit Note»', () => {
  for (const { name, look, lay } of LOOKS) {
    for (const lang of LANGS) {
      const html = gridInv(freeReturn(), ptOf(lang), { look, lay });
      const label = `${name}/${lang ?? 'none'}`;
      assertNoTax(html, label);
      assert.ok(html.includes('فاتورة مرتجع'), `${label}: العنوان`);
      if (lang === null || lang === 'en') assert.ok(html.includes('Return Invoice'), `${label}: «Return Invoice»`);
    }
  }
});

test('الرمز لا يُطبع على المستند بلا ضريبة ولو مرّره القالب الأصليّ — ولا الكتلة اليتيمة', () => {
  for (const { name, look, lay } of LOOKS) {
    const html = gridInv(freeInv(), ptOf(null), { look, lay, qr: QR });
    assert.ok(!html.includes('data-test-qr') && !html.includes('data-section="qr"'), name);
  }
});

test('سند القبض لشركةٍ أزالت الضريبة: لا رقمٌ ضريبيّ في الترويسة ولا في صندوق العميل — وبلا العلم كاليوم', () => {
  for (const { name, look, lay } of LOOKS) {
    for (const lang of LANGS) {
      const html = gridRcp(receipt(), ptOf(lang), { look, lay });
      assertNoTax(html, `${name}/${lang ?? 'none'}`);
      assert.ok(html.includes('300.00'), `${name}: المبلغ`);
    }
    const on = { ...company, taxDisabled: false } as ReceiptDoc['company'];
    const today = gridRcp(receipt({ company: on }), ptOf(null), { look, lay });
    assert.ok(today.includes(SELLER_VAT) && today.includes(BUYER_VAT), `${name}: الرقمان للشركة ذات الضريبة`);
    const absent = { ...company, taxDisabled: undefined } as ReceiptDoc['company'];
    assert.equal(gridRcp(receipt({ company: absent }), ptOf(null), { look, lay }), today, `${name}: العلم الغائب = false`);
  }
});

test('المستند القديم بضريبته يُطبع كما صدر (الختم يحكم لا علم الشركة) — وبلا ختمٍ الورقة حرفاً', () => {
  for (const { name, look, lay } of LOOKS) {
    const old = gridInv(oldInv(), ptOf(null), { look, lay });
    assert.ok(old.includes(SELLER_VAT) && old.includes('ضريبة القيمة المضافة') && old.includes('data-test-qr'), `${name}: القديم بضريبته ورمزه`);
    const base = oldInv();
    for (const variant of [{ ...base, taxFree: false }, { ...base, company: { ...company, taxDisabled: false } as InvoiceDoc['company'] }]) {
      assert.equal(gridInv(variant, ptOf(null), { look, lay }), old, `${name}: taxFree:false/العلم لا يغيّر الورقة`);
    }
  }
});

test('صياغة الشركة للعنوانين تسري على المستند بلا ضريبة — وترجمةٌ كُتبت لعنوان «فاتورة ضريبية مبسطة» لا تُطبع تحت «فاتورة»', () => {
  const edits = {
    'inv.title': { text: 'فاتورة مبيعات', alt: null, hidden: false },
    'inv.returnTitle': { text: 'مرتجع مبيعات', alt: 'Sales Return', hidden: false },
  };
  assert.ok(gridInv(freeInv(), ptOf('en', edits)).includes('فاتورة مبيعات'));
  const ret = gridInv(freeReturn(), ptOf('en', edits));
  assert.ok(ret.includes('مرتجع مبيعات') && ret.includes('Sales Return'));
  const altOnly = ptOf('en', { 'inv.title': { text: null, alt: 'Simplified Tax Invoice', hidden: false } });
  const t = altOnly.title(TAX_FREE_TITLES.sale, { isReturn: false, phase2: false });
  assert.deepEqual(t, { text: 'فاتورة', alt: 'Invoice' });
  const altOnlyRet = ptOf('en', { 'inv.returnTitle': { text: null, alt: 'Credit Note', hidden: false } });
  assert.deepEqual(altOnlyRet.title(TAX_FREE_TITLES.return, { isReturn: true, phase2: false }), { text: 'فاتورة مرتجع', alt: 'Return Invoice' });
});

test('المحلِّل: «فاتورة مرتجع» عنوانٌ يصوغه inv.returnTitle، وسطره الثاني بكل لغة بلا «إشعار دائن» — والعناوين القائمة كما هي', () => {
  assert.equal(titleKeyOf(TAX_FREE_TITLES.return, true), 'inv.returnTitle');
  assert.equal(titleKeyOf(TAX_FREE_TITLES.sale, false), 'inv.title');
  // القائمة القديمة بلا تغيير
  assert.equal(titleKeyOf('إشعار دائن مرتجع', true), 'inv.returnTitle');
  assert.equal(titleKeyOf('فاتورة ضريبية مبسطة', false), 'inv.title');
  assert.equal(titleKeyOf('إشعار مدين', false), 'inv.debitTitle');
  for (const lang of ['en', 'fr', 'tr', 'zh'] as const) {
    for (const [title, isReturn] of [[TAX_FREE_TITLES.sale, false], [TAX_FREE_TITLES.return, true]] as const) {
      const t = ptOf(lang).title(title, { isReturn, phase2: false });
      assert.equal(t.text, title, `${lang}: ${title}`);
      assert.ok(t.alt, `${lang}: ${title} بلا سطرٍ ثانٍ`);
      assert.equal(firstTaxMention(t.alt as string), null, `${lang}: ${t.alt}`);
      assert.ok(!/Avoir|Dekont|通知单/.test(t.alt as string), `${lang}: ${t.alt}`);
    }
    assert.ok(phraseIn(TAX_FREE_TITLES.return, lang));
  }
  // بلا نصوص: العنوان مترجماً بـtr كاليوم ولا سطر ثانٍ
  assert.deepEqual(makePrintTexts(null, (s) => s).title(TAX_FREE_TITLES.return, { isReturn: true, phase2: false }), { text: 'فاتورة مرتجع', alt: null });
});

test('النواة: كل عبارةٍ ضريبية في قائمة «نصوص المطبوعات» إمّا في TAX_PHRASE_KEYS أو أحد العنوانين بنصّهما بلا ضريبة', () => {
  const keys = new Set(PRINT_TEXT_CATALOG.map((e) => e.key));
  for (const k of TAX_PHRASE_KEYS) assert.ok(keys.has(k), `مفتاحٌ مجهول: ${k}`);
  assert.equal(new Set(TAX_PHRASE_KEYS).size, TAX_PHRASE_KEYS.length, 'مفتاحٌ مكرّر');
  assert.ok(Object.isFrozen(TAX_PHRASE_KEYS) && Object.isFrozen(TAX_FREE_TITLE_TEXTS));
  for (const e of PRINT_TEXT_CATALOG) {
    const taxy = firstTaxMention(e.ar) !== null;
    if (!taxy) { assert.ok(!isTaxPhraseKey(e.key) || /taxNumber|Title$|col\.tax|tot\.vat/.test(e.key) || e.key === 'qr.caption', e.key); continue; }
    assert.ok(isTaxPhraseKey(e.key) || e.key in TAX_FREE_TITLE_TEXTS, `عبارةٌ ضريبية خارج القائمة: ${e.key} «${e.ar}»`);
  }
  // العنوانان بلا ضريبة = TAX_FREE_TITLES (lib/taxMode.ts) ومفتاحاهما ليسا من عبارات الضريبة
  assert.deepEqual({ ...TAX_FREE_TITLE_TEXTS }, { 'inv.title': TAX_FREE_TITLES.sale, 'inv.returnTitle': TAX_FREE_TITLES.return });
  for (const [k, v] of Object.entries(TAX_FREE_TITLE_TEXTS)) {
    assert.ok(!isTaxPhraseKey(k) && printTextEntry(k), k);
    assert.equal(firstTaxMention(v), null, v);
  }
  assert.equal(isTaxPhraseKey('cust.name'), false);
});

test('تنبيهات المحرّر لشركةٍ أزالت الضريبة: لا تنبيه يذكر الضريبة أو الهيئة — وللشركة ذات الضريبة كما هي حرفاً', () => {
  for (const e of PRINT_TEXT_CATALOG) {
    assert.equal(printTextWarningFor(e, false), printTextWarning(e), e.key);
    const off = printTextWarningFor(e, true);
    assert.ok(off === null || off === 'platform', `${e.key}: ${off}`);
  }
  assert.equal(printTextWarningFor(printTextEntry('foot.platform')!, true), 'platform');
  assert.equal(printTextWarningFor(printTextEntry('h.taxNumber')!, true), null);
});

test('isTaxFreePrint: القرار (hideTaxIds) أو الختم — وقرار المرحلة الأولى والثانية بلا الحقل لا يُخفي شيئاً', () => {
  const p1 = zatcaPrintDecision({ saudi: true }, null);
  assert.equal(isTaxFreePrint(p1, {}), false);
  assert.equal(isTaxFreePrint(p1, { taxFree: false }), false);
  assert.equal(isTaxFreePrint(p1, { taxFree: true }), true);
  assert.equal(isTaxFreePrint({ showTaxBreakdown: false, hideTaxIds: true }, null), true);
  assert.equal(isTaxFreePrint(null, null), false);
  const free = zatcaPrintDecision({ taxFree: true, isReturn: true }, null);
  assert.equal(isTaxFreePrint(free, null), true);
  assert.ok(TAX_FREE_FORBIDDEN.every((re) => re instanceof RegExp));
});
