/**
 * «نصوص المطبوعات» على بقية المستندات (طلب المالك ٤ نوفمبر ٢٠٢٦، C-G7): سجلّ استلام التحصيل وإشعار المستودع وطلب المخزون —
 * ترويستها تتبع نصوص الشركة كما كشف الحساب وإشعار التحميل (printTextsReflect.test.ts): صياغة كل تسمية h.* تُطبع، وحذف كل سطر
 * h.* يُسقط قيمته، واسم الشركة وعنوانها باللغة الثانية يُطبعان — وشركةٌ بلا نصوص (أو بنصوصٍ غير صالحة) ورقتها كما هي.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PrintableSettlementLog, PrintableStockRequest, PrintableWarehouseNotice,
  type Company, type SettlementLogDoc, type StockRequestDoc, type WarehouseNoticeDoc,
} from './RepDocuments';
import type { PrintTextsV1 } from '../lib/print/printTexts';
import { useLang } from '../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';

process.env.TZ = 'Asia/Riyadh';
useLang.setState({ lang: 'ar' });
setActiveNumerals('latin');
setActiveCurrency('SAR');

const COMPANY: Company = {
  name: 'شركة الاختبار للتوزيع', address: 'حي العليا شارع التحلية', taxNumber: '300000000000003', commercialReg: '1010101010',
  phone: '0501234567', email: 'info@example.sa', countryCode: 'SA',
} as Company;

/** قيمة كل سطر ترويسة — تسقط بحذف سطرها */
const VALUES: Record<string, string> = {
  'h.taxNumber': '300000000000003', 'h.commercialReg': '1010101010', 'h.address': 'حي العليا شارع التحلية',
  'h.phone': '0501234567', 'h.email': 'info@example.sa',
};
const KEYS = Object.keys(VALUES);

const texts = (edits: PrintTextsV1['edits'], o: Partial<PrintTextsV1> = {}): PrintTextsV1 =>
  ({ version: 1, secondLang: null, companyNameAlt: null, companyAddressAlt: null, edits, ...o });

const sl = (c: Company): SettlementLogDoc => ({
  kind: 'settlement', company: c, repName: 'أحمد', date: '2026-10-31T09:00:00',
  entries: [{ settledAt: '2026-10-30T09:00:00', amount: 50, by: 'مدير', method: 'CASH' }], total: 50, collected: 80, outstanding: 30,
});
const wn = (c: Company): WarehouseNoticeDoc => ({
  kind: 'warehouseNotice', company: c, entryType: 'RECEIVE', ref: 'WH-1', date: '2026-10-31T09:00:00', supplier: 'مورد', by: 'أمين',
  items: [{ name: 'ماء', qty: 5, unitCost: 2, lineCost: 10 }], totalCost: 10,
});
const sr = (c: Company): StockRequestDoc => ({
  kind: 'stockRequest', company: c, ref: 'SR-1', date: '2026-10-31T09:00:00', to: 'PURCHASING', by: 'مدير',
  items: [{ productId: 'p1', name: 'ماء', unit: 'كرتون', qty: 5, onHand: 2 }],
} as StockRequestDoc);

const DOCS: [string, (c: Company) => string][] = [
  ['سجل التحصيل', (c) => renderToStaticMarkup(createElement(PrintableSettlementLog, { doc: sl(c) }))],
  ['إشعار المستودع', (c) => renderToStaticMarkup(createElement(PrintableWarehouseNotice, { doc: wn(c) }))],
  ['طلب المخزون', (c) => renderToStaticMarkup(createElement(PrintableStockRequest, { doc: sr(c) }))],
];

test('C-G7 سجل التحصيل وإشعار المستودع وطلب المخزون: صياغة كل تسمية ترويسة واسم الشركة وعنوانها باللغة الثانية تُطبع', () => {
  const edits = Object.fromEntries(KEYS.map((k, i) => [k, { text: `«صياغة-${i}»`, alt: `«ALT-${i}»`, hidden: false }]));
  const c: Company = { ...COMPANY, printTexts: texts(edits, { secondLang: 'en', companyNameAlt: 'Test Distribution Co.', companyAddressAlt: 'Olaya St.' }) };
  for (const [name, render] of DOCS) {
    const html = render(c);
    KEYS.forEach((k, i) => {
      assert.ok(html.includes(`«صياغة-${i}»`), `${name}: صياغة ${k} غائبة`);
      assert.ok(html.includes(VALUES[k]), `${name}: قيمة ${k} سقطت مع الصياغة`);
    });
    assert.ok(html.includes('Test Distribution Co.'), `${name}: اسم الشركة باللغة الثانية غائب`);
    assert.ok(html.includes('Olaya St.'), `${name}: العنوان باللغة الثانية غائب`);
  }
});

test('C-G7 سجل التحصيل وإشعار المستودع وطلب المخزون: حذف كل سطر ترويسة يُسقط قيمته وحدها', () => {
  for (const [name, render] of DOCS) {
    const plain = render({ ...COMPANY });
    for (const k of KEYS) {
      assert.ok(plain.includes(VALUES[k]), `${name}: ${k} غير مطبوع أصلاً`);
      const html = render({ ...COMPANY, printTexts: texts({ [k]: { text: null, alt: null, hidden: true } }) });
      assert.ok(!html.includes(VALUES[k]), `${name}: ${k} المحذوف مطبوع`);
      for (const o of KEYS.filter((x) => x !== k && !VALUES[x].includes(VALUES[k]))) assert.ok(html.includes(VALUES[o]), `${name}: حذف ${k} أسقط ${o}`);
    }
  }
});

test('C-G7 بلا نصوص أو بنصوصٍ غير صالحة: الورقة الثلاث كما هي بلا حقل النصوص حرفاً بحرف', () => {
  for (const [name, render] of DOCS) {
    const plain = render({ ...COMPANY });
    for (const raw of [undefined, null, { version: 2 }]) assert.equal(render({ ...COMPANY, printTexts: raw } as Company), plain, `${name} ${JSON.stringify(raw)}`);
  }
});
