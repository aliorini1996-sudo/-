/**
 * «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — المستندات التي لا ختم لها تتبع علم الشركة الآن (`company.taxDisabled`):
 * سند القبض (الورقة الافتراضية، والصفحة بتخطيط، والقالب ثنائي اللغة)، وكشف الحساب، وسجل استلام التحصيل، وإشعارات التحميل والتنزيل
 * والتسوية، وإشعار المستودع (وارد وتسوية)، وطلب المخزون — وشاشة النتيجة لكلٍّ منها.
 *   • الشركة بلا ضريبة ⇒ لا رقم ضريبيّ للبائع (الترويسة) ولا للعميل، ولا «قبل الضريبة» في قيم الوارد، ولا أيّ ذكرٍ للضريبة.
 *   • taxDisabled غائب أو false ⇒ الورقة نفسها حرفاً.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DocumentResult, PrintableLoadNotice, PrintableReceipt, PrintableSettlementLog, PrintableStatement, PrintableStockRequest,
  PrintableWarehouseNotice, docTaxOff, type AnyDoc, type Company, type LoadNoticeDoc, type ReceiptDoc, type SettlementLogDoc,
  type StatementDoc, type StockRequestDoc, type WarehouseNoticeDoc,
} from './RepDocuments';
import { PrintLookContext, lookFor } from './printLook';
import { defaultPrintLayout, defaultPrintOptions, presetPaper, type LayoutDesign, type PaperPresetId, type PrintProfile, type PrinterType, type TemplateId } from '../lib/print/printSettings';
import { useLang } from '../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';

process.env.TZ = 'Asia/Riyadh';
useLang.setState({ lang: 'ar' });
setActiveNumerals('latin');
setActiveCurrency('SAR');

const SELLER_VAT = '300000000000003';
const BUYER_VAT = '311111111111113';
const COMPANY: Company = {
  name: 'شركة الاختبار للتوزيع', address: 'حي العليا', taxNumber: SELLER_VAT, commercialReg: '1010101010', phone: '0501234567',
  email: 'info@example.sa', primaryColor: '#1e3a8a', headerStyle: null, countryCode: 'SA',
};
const TEXTS = { version: 1, secondLang: 'en', companyNameAlt: 'Test Distribution Co', companyAddressAlt: 'Olaya', edits: {} };
const CUSTOMER = { name: 'بقالة النور', businessName: 'مؤسسة النور', commercialReg: '2020202020', taxNumber: BUYER_VAT, phone: '0533333333', address: 'طريق الملك فهد' };

const receipt = (company: Company): ReceiptDoc => ({
  kind: 'receipt', number: 'RC-55', date: '2026-11-07T11:00:00.000Z', company, customer: CUSTOMER, repName: 'أحمد السالم',
  amount: 150, paymentMethod: 'CASH', invoices: [{ number: 'INV-777', amount: 150 }],
});
const statement = (company: Company): StatementDoc => ({
  kind: 'statement', company, customer: { ...CUSTOMER, balance: 300, totalSales: 450, totalCollected: 150 }, repName: 'أحمد السالم',
  date: '2026-11-07T11:00:00.000Z', fromDate: '2026-11-01', toDate: '2026-11-07', openingBalance: 0, timezone: 'Asia/Riyadh',
  entries: [
    { date: '2026-11-02T09:00:00.000Z', description: 'فاتورة بيع', ref: 'INV-777', debit: 450, credit: 0, balance: 450, type: 'INVOICE_DEBIT', items: [{ name: 'مياه معدنية', qty: 2, unit: 'كرتون' }] },
    { date: '2026-11-03T09:00:00.000Z', description: 'سند قبض', ref: 'RC-55', debit: 0, credit: 150, balance: 300, type: 'RECEIPT_CREDIT' },
  ],
  totalDebit: 450, totalCredit: 150, finalBalance: 300,
});
const settlement = (company: Company): SettlementLogDoc => ({
  kind: 'settlement', company, repName: 'أحمد السالم', date: '2026-11-07T11:00:00.000Z',
  entries: [{ settledAt: '2026-11-06T15:00:00.000Z', amount: 500, by: 'المحاسب', method: 'CASH' }], total: 500, collected: 700, outstanding: 200,
});
const load = (company: Company): LoadNoticeDoc => ({
  kind: 'loadNotice', company, repName: 'أحمد السالم', date: '2026-11-07T07:00:00.000Z', movementKind: 'LOAD',
  items: [{ name: 'مياه معدنية', qty: 10, unit: 'كرتون' }],
});
const warehouse = (company: Company, entryType: 'RECEIVE' | 'ADJUST'): WarehouseNoticeDoc => ({
  kind: 'warehouseNotice', company, entryType, ref: 'WH-1A2B', date: '2026-11-07T07:00:00.000Z', supplier: 'مصنع المياه', by: 'أمين المستودع',
  items: [
    { name: 'مياه معدنية', productId: 'p1', unit: 'كرتون', qty: entryType === 'RECEIVE' ? 40 : -2, unitCost: 12.5, lineCost: 500 },
    { name: 'عصير برتقال', productId: 'p2', unit: 'حبة', qty: 24, unitCost: null, lineCost: null },
  ],
  totalCost: 500,
});
const stockRequest = (company: Company): StockRequestDoc => ({
  kind: 'stockRequest', company, ref: 'SR-77', date: '2026-11-07T07:00:00.000Z', to: 'PURCHASING', by: 'مدير المستودع',
  items: [{ productId: 'p1', name: 'مياه معدنية', code: 'W-1', unit: 'كرتون', qty: 50, onHand: 3 }],
} as StockRequestDoc);

interface Case { name: string; mk: (c: Company) => AnyDoc; render: (d: AnyDoc) => ReactElement }
const CASES: Case[] = [
  { name: 'receipt', mk: receipt, render: (d) => createElement(PrintableReceipt, { doc: d as ReceiptDoc }) },
  { name: 'statement', mk: statement, render: (d) => createElement(PrintableStatement, { doc: d as StatementDoc }) },
  { name: 'settlement', mk: settlement, render: (d) => createElement(PrintableSettlementLog, { doc: d as SettlementLogDoc }) },
  { name: 'loadNotice', mk: load, render: (d) => createElement(PrintableLoadNotice, { doc: d as LoadNoticeDoc }) },
  { name: 'warehouseReceive', mk: (c) => warehouse(c, 'RECEIVE'), render: (d) => createElement(PrintableWarehouseNotice, { doc: d as WarehouseNoticeDoc }) },
  { name: 'warehouseAdjust', mk: (c) => warehouse(c, 'ADJUST'), render: (d) => createElement(PrintableWarehouseNotice, { doc: d as WarehouseNoticeDoc }) },
  { name: 'stockRequest', mk: stockRequest, render: (d) => createElement(PrintableStockRequest, { doc: d as StockRequestDoc }) },
];

const plain = (printer: PrinterType, template: TemplateId, preset: PaperPresetId, design: LayoutDesign = 'standard'): PrintProfile => ({
  id: `p-${template.replace(/_/g, '-')}`, name: template, printer, template, paper: presetPaper(preset)!,
  options: { ...defaultPrintOptions(printer), showLogo: true, layout: defaultPrintLayout(printer, design) },
});
/** مظاهر السند: بلا إعدادات، والصفحة بتخطيط، والنقطية، والقالب ثنائي اللغة على الصفحة والنقطية */
const LOOKS: Array<[string, PrintProfile | null]> = [
  ['today', null],
  ['page_standard', plain('page', 'page_branded', 'a4')],
  ['impact_standard', plain('impact', 'impact_plain', 'ff_a4')],
  ['page_grid', plain('page', 'page_branded', 'a4', 'grid_bilingual')],
  ['impact_grid', plain('impact', 'impact_plain', 'ff_a4', 'grid_bilingual')],
];

const html = (el: ReactElement, p: PrintProfile | null = null): string =>
  renderToStaticMarkup((p ? createElement(PrintLookContext.Provider, { value: lookFor(p) }, el) : el) as ReactElement);
const visible = (h: string): string => h.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
const TAX_WORDS: RegExp[] = [/ضريب/, /الضرائب/, /ض\.ق\.م/, /مبسطة/, /هيئة الزكاة/, /\bVAT\b/i, /\btax/i, /\bTVA\b/, /\bKDV\b/, /Vergi/i, /税/];
function taxMentions(h: string): string[] {
  const text = visible(h);
  const out = TAX_WORDS.filter((re) => re.test(text)).map((re) => `نصّ ${re}`);
  for (const v of [SELLER_VAT, BUYER_VAT]) if (h.includes(v)) out.push(`رقم ضريبي ${v}`);
  return out;
}
const OFF: Company = { ...COMPANY, taxDisabled: true };
const withTexts = (c: Company): Company => ({ ...c, printTexts: TEXTS });

test('شركةٌ أُزيلت ضريبتها: لا ذكر للضريبة ولا رقم ضريبيّ في أيّ مستندٍ بلا ختم — بنصوص مطبوعاتٍ وبلاها', () => {
  const errors: string[] = [];
  for (const c of CASES) {
    for (const [cn, company] of [['plain', OFF], ['textsEn', withTexts(OFF)]] as const) {
      const looks = c.name === 'receipt' ? LOOKS : LOOKS.slice(0, 1);
      for (const [ln, p] of looks) {
        const h = html(c.render(c.mk(company)), p);
        const bad = taxMentions(h);
        if (bad.length) errors.push(`${c.name}/${cn}/${ln}: ${bad.join(' · ')}`);
        if (!h.includes(COMPANY.name)) errors.push(`${c.name}/${cn}/${ln}: اسم الشركة غائب`);
        if (!h.includes(COMPANY.commercialReg!)) errors.push(`${c.name}/${cn}/${ln}: السجل التجاري سقط مع الرقم الضريبي`);
      }
    }
  }
  assert.deepEqual(errors, []);
});

test('برهان الفشل: الشركة بضريبتها تطبع رقمها الضريبيّ (ورقم العميل في السند والكشف) و«قبل الضريبة» في الوارد', () => {
  for (const c of CASES) {
    const h = html(c.render(c.mk(COMPANY)));
    assert.ok(h.includes(SELLER_VAT), `${c.name}: رقم البائع غائب اليوم`);
    if (c.name === 'receipt' || c.name === 'statement') assert.ok(h.includes(BUYER_VAT), `${c.name}: رقم العميل غائب اليوم`);
  }
  const wh = visible(html(CASES.find((c) => c.name === 'warehouseReceive')!.render(warehouse(COMPANY, 'RECEIVE'))));
  for (const s of ['سعر الوحدة قبل الضريبة', 'القيمة قبل الضريبة', 'قيمة البضاعة قبل الضريبة']) assert.ok(wh.includes(s), s);
});

test('إشعار الوارد بلا ضريبة: «سعر الوحدة» و«القيمة» و«قيمة البضاعة» — والقيم من الخادم كما هي', () => {
  const h = visible(html(createElement(PrintableWarehouseNotice, { doc: warehouse(OFF, 'RECEIVE') })));
  for (const s of ['سعر الوحدة', 'القيمة', 'قيمة البضاعة', '500.00', '12.5']) assert.ok(h.includes(s), s);
  assert.doesNotMatch(h, /قبل الضريبة/);
});

test('taxDisabled غائب أو false ⇒ كل مستندٍ بلا ختم كما هو حرفاً', () => {
  for (const c of CASES) {
    const looks = c.name === 'receipt' ? LOOKS : LOOKS.slice(0, 1);
    for (const [ln, p] of looks) {
      for (const base of [COMPANY, withTexts(COMPANY)]) {
        const today = html(c.render(c.mk(base)), p);
        assert.equal(html(c.render(c.mk({ ...base, taxDisabled: false })), p), today, `${c.name}/${ln}`);
        assert.equal(html(c.render(c.mk({ ...base, taxDisabled: undefined })), p), today, `${c.name}/${ln}`);
      }
    }
  }
});

test('docTaxOff: ما لا ختم له يتبع علم الشركة الآن، صريحاً true وحده', () => {
  for (const c of CASES) {
    assert.equal(docTaxOff(c.mk(OFF)), true, c.name);
    assert.equal(docTaxOff(c.mk(COMPANY)), false, c.name);
    assert.equal(docTaxOff(c.mk({ ...COMPANY, taxDisabled: false })), false, c.name);
    assert.equal(docTaxOff({ ...c.mk(COMPANY), company: null } as AnyDoc), false, c.name);
  }
});

test('شاشة النتيجة لكل مستندٍ بلا ختم لشركةٍ بلا ضريبة: لا ذكر للضريبة — وبالعلم false كما اليوم حرفاً', () => {
  const screen = (doc: AnyDoc) => renderToStaticMarkup(createElement(DocumentResult, { doc, onClose: () => {} }));
  for (const c of CASES) {
    assert.deepEqual(taxMentions(screen(c.mk(OFF))), [], c.name);
    assert.equal(screen(c.mk({ ...COMPANY, taxDisabled: false })), screen(c.mk(COMPANY)), c.name);
  }
});
