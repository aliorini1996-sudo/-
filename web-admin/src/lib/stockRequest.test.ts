import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseRequestQty, isInvalidRequestQty, stockRequestLines, stockRequestTotalQty, stockRequestRef,
  stockRequestToLabel, stockRequestApproverLabel, shortFirst,
} from './stockRequest';

/**
 * «طلب مخزون» (طلب المالك، ١١ أكتوبر ٢٠٢٦): من صفحة مخزون الشركة يصدر المسؤول ورقة PDF
 * فيها الكمية المطلوبة لكل صنف، ويرسلها لإدارة المشتريات أو الإنتاج.
 */

test('الكمية المطلوبة: الموجب وحده طلب — والفارغ والصفر لا يدخلان الورقة', () => {
  assert.equal(parseRequestQty('12'), 12);
  assert.equal(parseRequestQty(' 2.5 '), 2.5);
  assert.equal(parseRequestQty('١٢٫٥'), 12.5, 'الأرقام الهندية والفاصلة العربية');
  assert.equal(parseRequestQty('1.256'), 1.26, 'خانتان عشريتان كالجدول');
  for (const v of ['', '   ', '0', '-3', 'abc', undefined]) assert.equal(parseRequestQty(v), null, String(v));
});

test('الخانة غير المفهومة توقف الإصدار ولا تسقط صامتة — والصفر ليس خطأ', () => {
  for (const v of ['-3', 'abc', '1e', '--']) assert.equal(isInvalidRequestQty(v), true, v);
  for (const v of ['', '0', '٠', '5', '0.5', undefined]) assert.equal(isInvalidRequestQty(v), false, String(v));
});

test('أسطر الطلب: بترتيب الأصناف المعطى، والصنف بلا كمية خارجها، والرصيد السالب يُحمل بإشارته', () => {
  const rows = [
    { productId: 'a', name: 'ماء', code: 'W1', unit: 'كرتون', onHand: 5 },
    { productId: 'b', name: 'بيض', code: 'E1', unit: 'كرتون', onHand: -4 },
    { productId: 'c', name: 'حليب', code: '', unit: 'علبة', onHand: 0 },
  ];
  const lines = stockRequestLines(rows, { a: '10', b: '20', c: '' });
  assert.deepEqual(lines.map(l => [l.productId, l.qty, l.onHand]), [['a', 10, 5], ['b', 20, -4]]);
  assert.equal(lines[0].code, 'W1');
  assert.equal(stockRequestTotalQty([{ qty: 0.1 }, { qty: 0.2 }]), 0.3, 'لا ذيل عشري من جمع الكسور');
  assert.equal(stockRequestTotalQty(lines), 30);
});

test('الناقص (صفر أو سالب) أولاً ثم البقية، وكلٌّ بترتيبه', () => {
  const r = shortFirst([{ id: 1, onHand: 3 }, { id: 2, onHand: 0 }, { id: 3, onHand: 7 }, { id: 4, onHand: -1 }]);
  assert.deepEqual(r.map(x => x.id), [2, 4, 1, 3]);
});

test('مرجع الطلب من لحظة الإصدار SR-سنةشهريوم-ساعةدقيقة', () => {
  assert.equal(stockRequestRef(new Date(2026, 9, 11, 9, 5)), 'SR-261011-0905');
});

test('الجهة وخانة اعتمادها مفاتيح ترجمة موجودة في القاموس بلغاتها', () => {
  const dict = fs.readFileSync(path.resolve(process.cwd(), 'src', 'i18n', 'strings.ts'), 'utf8');
  for (const to of ['PURCHASING', 'PRODUCTION'] as const) {
    for (const key of [stockRequestToLabel(to), stockRequestApproverLabel(to)]) {
      assert.match(dict, new RegExp(`'${key}': \\{ en: `), `مفتاح غائب: ${key}`);
    }
  }
  assert.notEqual(stockRequestToLabel('PURCHASING'), stockRequestToLabel('PRODUCTION'));
});

test('حارس ثابت: الزر بجانب «استلام / تسوية»، والورقة نوع مستند معروف يُرسم ويُسمّى', () => {
  const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...p), 'utf8');
  const page = read('pages', 'CompanyWarehousePage.tsx');
  const head = page.slice(page.indexOf("{tr('مخزون الشركة')}</h1>"), page.indexOf("{tr('استلام / تسوية')}"));
  assert.match(head, /onClick=\{\(\) => setShowRequest\(true\)\}/, 'زر طلب المخزون ليس في رأس الصفحة قبل زر الاستلام');
  assert.match(page, /<StockRequestModal rows=\{rows\}/);
  const docs = read('rep', 'RepDocuments.tsx');
  assert.match(docs, /\| StockRequestDoc;/, 'النوع خارج AnyDoc');
  assert.match(docs, /if \(doc\.kind === 'stockRequest'\) return <PrintableStockRequest/);
  assert.match(docs, /doc\.kind === 'stockRequest' \? `\$\{tr\('طلب مخزون'\)\}-\$\{doc\.ref\}`/, 'اسم الملف');
});
