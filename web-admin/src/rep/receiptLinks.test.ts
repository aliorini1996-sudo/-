import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { receiptInvoicesFrom, receiptLinkView } from './receiptLinks';

/**
 * «مقابل الفاتورة رقم …» داخل سند القبض (قرار المالك).
 *
 * الورقة تُسلَّم للعميل، فالحرّاس هنا على أمرين: أن يُطبع رقم الفاتورة من
 * روابط الخادم فعلاً في كل قالب (A4 والحراري) وكل شاشة إصدار، وألّا يُطبع
 * ادّعاءٌ كاذب حين لا تُعرف الفاتورة.
 */

const SRC = path.join(process.cwd(), 'src');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');

test('روابط الخادم تُقرأ رقماً ومبلغاً — والصفوف الناقصة تُسقَط', () => {
  const links = receiptInvoicesFrom([
    { amount: 300, invoice: { id: 'a', number: 'INV-1' } },
    { amount: '200.5', invoice: { id: 'b', number: 'INV-2' } },
    { amount: 50, invoice: null },                    // فاتورة غير مقروءة
    { amount: 0, invoice: { number: 'INV-3' } },      // مبلغ صفريّ
    null,
  ]);
  assert.deepEqual(links, [{ number: 'INV-1', amount: 300 }, { number: 'INV-2', amount: 200.5 }]);
});

test('غياب الحقل «غير معروف» لا «بلا فاتورة»', () => {
  assert.equal(receiptInvoicesFrom(undefined), undefined);
  assert.deepEqual(receiptInvoicesFrom([]), []);
  assert.deepEqual(receiptLinkView({ amount: 100 }), { kind: 'unknown' });
  assert.deepEqual(receiptLinkView({ amount: 100, invoices: [] }), { kind: 'onAccount' });
});

test('فاتورة واحدة بكامل المبلغ — بلا فائض', () => {
  const v = receiptLinkView({ amount: 500, invoices: [{ number: 'INV-9', amount: 500 }] });
  assert.deepEqual(v, { kind: 'invoices', links: [{ number: 'INV-9', amount: 500 }], unallocated: 0 });
});

test('الفائض عن الفواتير يُسمّى رصيداً دائناً — وغبار العائمة لا يُحسب فائضاً', () => {
  const v = receiptLinkView({ amount: 344.85, invoices: [
    { number: 'A', amount: 114.95 }, { number: 'B', amount: 114.95 }, { number: 'C', amount: 114.95 },
  ] });
  assert.equal(v.kind, 'invoices');
  assert.equal(v.kind === 'invoices' && v.unallocated, 0);
  const over = receiptLinkView({ amount: 700, invoices: [{ number: 'A', amount: 500 }] });
  assert.equal(over.kind === 'invoices' && over.unallocated, 200);
});

test('الفائض يُحكم عليه بخانات العملة — كسرٌ دون أصغر وحدة ليس رصيداً دائناً', () => {
  // 100.004 ريال مكتوبةً توزَّع 100.00 — لا «رصيد دائن 0.00» على الورق
  const sar = receiptLinkView({ amount: 100.004, invoices: [{ number: 'A', amount: 100 }] }, 2);
  assert.equal(sar.kind === 'invoices' && sar.unallocated, 0);
  // وفي العملات الثلاثية الكسر نفسه فائضٌ حقيقي يُطبع
  const kwd = receiptLinkView({ amount: 100.004, invoices: [{ number: 'A', amount: 100 }] }, 3);
  assert.equal(kwd.kind === 'invoices' && kwd.unallocated, 0.004);
});

test('الحراري يختار المفرد بعدد الفواتير وحده كقالب A4', () => {
  const thermal = read('rep/thermal.ts');
  const fn = thermal.slice(thermal.indexOf('function receiptInvoiceRows'), thermal.indexOf('export async function printThermalReceipt'));
  assert.match(fn, /const single = view\.links\.length === 1;/, 'فاتورة واحدة بفائض تُطبع «مقابل الفواتير» بالجمع');
  assert.match(fn, /currencyDecimals\(getActiveCurrency\(\)\)/, 'الحراري يحكم على الفائض بغير خانات العملة');
});

test('سند دون اتصال بلا توزيع ⇒ «يُحدَّد عند المزامنة» لا «دفعة على الحساب»', () => {
  assert.deepEqual(receiptLinkView({ amount: 100, offline: true }), { kind: 'pending' });
  assert.deepEqual(receiptLinkView({ amount: 100, offline: true, invoices: [] }), { kind: 'pending' });
  const withLocal = receiptLinkView({ amount: 100, offline: true, invoices: [{ number: 'INV-4', amount: 100 }] });
  assert.equal(withLocal.kind, 'invoices');
});

test('القالبان يطبعان روابط الفاتورة — A4 والحراري من القرار نفسه', () => {
  const docs = read('rep/RepDocuments.tsx');
  const printable = docs.slice(docs.indexOf('export const PrintableReceipt'), docs.indexOf("PrintableReceipt.displayName"));
  assert.match(printable, /<ReceiptInvoicesBox doc=\{doc\} \/>/, 'قالب A4 لا يطبع فاتورة السند');
  assert.match(docs, /function ReceiptInvoicesBox[\s\S]*?receiptLinkView\(doc, currencyDecimals\(getActiveCurrency\(\)\)\)/, 'صندوق الفواتير لا يقرأ القرار الموحّد');

  const thermal = read('rep/thermal.ts');
  const fn = thermal.slice(thermal.indexOf('export async function printThermalReceipt'));
  assert.match(fn, /\$\{receiptInvoiceRows\(doc\)\}/, 'الطباعة الحرارية لا تطبع فاتورة السند');
  assert.match(thermal, /function receiptInvoiceRows[\s\S]*?receiptLinkView\(doc, currencyDecimals\(getActiveCurrency\(\)\)\)/, 'الحراري يقرّر وحده بمعزل عن A4');
});

test('كل مصدرٍ للمستند يمرّر روابط الخادم', () => {
  const docs = read('rep/RepDocuments.tsx');
  const detail = docs.slice(docs.indexOf('export function receiptDocFromDetail'));
  assert.match(detail.slice(0, 900), /invoices: receiptInvoicesFrom\(rcp\.invoiceItems\)/,
    'فتح السند لاحقاً (القائمة، كشف الحساب، الجوال) يُسقط فواتيره');

  assert.match(read('components/forms/ReceiptModal.tsx'), /invoices: receiptInvoicesFrom\(rcp\.invoiceItems\)/,
    'لوحة الإدارة تطبع السند فور إصداره بلا فاتورته');
  assert.match(read('rep/RepApp.tsx'), /invoices: receiptInvoicesFrom\(rcp\.invoiceItems\)/,
    'تطبيق المندوب يطبع السند فور إصداره بلا فاتورته');
});
