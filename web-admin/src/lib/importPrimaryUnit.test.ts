// «الوحدة الرئيسية» §2.11 (الحزمة B3b) — الويب: عمود «الوحدة الرئيسية» في ملف المنتجات (مطابقة تامة، ومرآة فحص الخادم importPrimaryOf)،
// والملف القديم بلا العمود كما كان حرفياً، ومعاينة الجرد بالرئيسية («= 2 كرتون و3 قارورة») وتنبيه D17 حين تكون الأصناف في اليد.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  IMPORT_TYPES, PRIMARY_UNIT_INVALID, PRIMARY_PRICE_REQUIRED, QTY_UNIT_REQUIRED, openingStockPrimaryPreview, openingStockUnitRequiredRows, type ImportPreviewProduct,
} from './importData';
import { importFieldLabel, importRowErrorFieldKey } from './importRevert';

const prod = IMPORT_TYPES.products.transform;
const stock = IMPORT_TYPES.opening_stock.transform;

test('المنتجات: عمود «الوحدة الرئيسية» باسم إحدى وحدات الصفّ يُرسل primaryUnit، وسعر الصغرى الغائب لا يُملأ (يشتقّه الخادم)', () => {
  const r = prod([
    { 'اسم الصنف': 'ماء', 'الوحدة': 'قارورة', 'الوحدة الثانية': 'كرتون', 'معامل الوحدة الثانية': 24, 'سعر الوحدة الثانية': 48, 'الوحدة الرئيسية': 'كرتون' },
  ]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.valid, [{ code: 'ماء', name: 'ماء', unit: 'قارورة', basePrice: undefined, taxPct: undefined, barcode: undefined, category: undefined,
    units: [{ name: 'كرتون', factor: 24, price: 48 }], primaryUnit: 'كرتون' }]);
  assert.equal(r.columns?.find((c) => c.field === 'primaryUnit')?.header, 'الوحدة الرئيسية');
  assert.equal(r.columns?.find((c) => c.field === 'unit')?.header, 'الوحدة', '«الوحدة الرئيسية» لا تُلتقط وحدةً صغرى');
});

test('المنتجات: الرئيسية باسم «الوحدة» نفسها أو فارغة ⇒ بلا مفتاح، وغير وحدات الصفّ أو بلا سعرين ⇒ خطأ صفّ بنصّ الخادم', () => {
  const r = prod([
    { 'اسم الصنف': 'أ', 'الوحدة': 'قارورة', 'سعر البيع': 1, 'الوحدة الرئيسية': 'قارورة' },
    { 'اسم الصنف': 'ب', 'الوحدة': 'قارورة', 'سعر البيع': 1, 'الوحدة الثانية': 'كرتون', 'معامل الوحدة الثانية': 24, 'الوحدة الرئيسية': 'شدة' },
    { 'اسم الصنف': 'ج', 'الوحدة': 'قارورة', 'الوحدة الثانية': 'كرتون', 'معامل الوحدة الثانية': 24, 'الوحدة الرئيسية': 'كرتون' },
    { 'اسم الصنف': 'د', 'الوحدة': 'قارورة', 'سعر البيع': 2, 'الوحدة الثانية': 'كرتون', 'معامل الوحدة الثانية': 24, 'الوحدة الرئيسية': 'كرتون' },
  ]);
  assert.deepEqual(r.errors.map((e) => [e.row, e.message, e.field]), [[3, PRIMARY_UNIT_INVALID, 'primaryUnit'], [4, PRIMARY_PRICE_REQUIRED, 'primaryUnit']]);
  assert.equal(r.valid.length, 2);
  assert.ok(!('primaryUnit' in r.valid[0]), 'باسم الصغرى نفسها ⇒ بلا رئيسية');
  assert.equal(r.valid[1].primaryUnit, 'كرتون');
});

test('المنتجات: ملفٌّ بلا العمود كما كان حرفياً، وصفّان بالكود نفسه يختلفان في الرئيسية وحدها خطأ صفّ لا تخطٍّ صامت', () => {
  const old = prod([{ 'كود الصنف': 'W', 'اسم الصنف': 'ماء', 'الوحدة': 'حبة', 'سعر البيع': 1, 'الوحدة الثانية': 'كرتون', 'معامل الوحدة الثانية': 24 }]);
  assert.deepEqual(old.valid, [{ code: 'W', name: 'ماء', unit: 'حبة', basePrice: 1, taxPct: undefined, barcode: undefined, category: undefined, units: [{ name: 'كرتون', factor: 24 }] }]);
  assert.equal(old.columns?.find((c) => c.field === 'primaryUnit')?.header ?? null, null);
  const dup = prod([
    { 'كود الصنف': 'W', 'اسم الصنف': 'ماء', 'الوحدة': 'حبة', 'سعر البيع': 1, 'الوحدة الثانية': 'كرتون', 'معامل الوحدة الثانية': 24, 'الوحدة الرئيسية': 'كرتون' },
    { 'كود الصنف': 'W', 'اسم الصنف': 'ماء', 'الوحدة': 'حبة', 'سعر البيع': 1, 'الوحدة الثانية': 'كرتون', 'معامل الوحدة الثانية': 24, 'الوحدة الرئيسية': '' },
  ]);
  assert.equal(dup.valid.length, 1);
  assert.deepEqual(dup.errors.map((e) => e.row), [3]);
});

test('مرآة الخادم: نصّا الخطأين حرفياً كما في routes/import.ts، ونصّ D17 للجرد كما في QTY_UNIT_REQUIRED_MESSAGE', () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), '..', 'backend', 'src', 'routes', 'import.ts'), 'utf8');
  assert.ok(src.includes(`export const PRIMARY_UNIT_INVALID_MESSAGE = '${PRIMARY_UNIT_INVALID}';`));
  assert.ok(src.includes(`export const PRIMARY_PRICE_REQUIRED_MESSAGE = '${PRIMARY_PRICE_REQUIRED}';`));
  assert.ok(src.includes(`export const QTY_UNIT_REQUIRED_MESSAGE = '${QTY_UNIT_REQUIRED}';`));
  // والنصوص مترجمة (الويب يعرض er.message عبر tr)
  const strings = fs.readFileSync(path.resolve(process.cwd(), 'src', 'i18n', 'strings.ts'), 'utf8');
  for (const m of [PRIMARY_UNIT_INVALID, PRIMARY_PRICE_REQUIRED, QTY_UNIT_REQUIRED]) assert.ok(strings.includes(`'${m}': {`), m);
  const price = /export const PRICE_UNIT_REQUIRED_MESSAGE = '([^']+)';/.exec(src)?.[1];
  assert.ok(price && strings.includes(`'${price}': {`));
});

const PRODUCTS: ImportPreviewProduct[] = [
  { code: 'A-1', name: 'ماء', unit: 'قارورة', primaryUnitId: 'U-CT', units: [{ id: 'U-CT', name: 'كرتون', factor: 24, isActive: true }] },
  { code: 'B-2', barcode: '628', name: 'عصير', unit: 'قارورة', baseConvertedAt: '2026-10-30T10:00:00.000Z', units: [{ id: 'U-B', name: 'كرتون', factor: 12 }] },
  { code: 'C-3', name: 'سكر', unit: 'كيس', units: [] },
];

test('معاينة الجرد: المعادل بالرئيسية للصنف ذي الرئيسية وحده، وD17 للخانة الفارغة، والصنف القديم بلا شيء', () => {
  const { valid } = stock([
    { 'كود الصنف': 'A-1', 'الكمية': 2, 'تكلفة الوحدة': 48, 'الوحدة': 'كرتون' },
    { 'كود الصنف': 'A-1', 'الكمية': 51, 'تكلفة الوحدة': 2, 'الوحدة': 'قارورة' },
    { 'كود الصنف': 'A-1', 'الكمية': 3, 'تكلفة الوحدة': 2 },
    { 'الباركود': '628', 'الكمية': 5, 'تكلفة الوحدة': 2 },
    { 'كود الصنف': 'C-3', 'الكمية': 7, 'تكلفة الوحدة': 1 },
    { 'كود الصنف': 'Z-9', 'الكمية': 1, 'تكلفة الوحدة': 1, 'الوحدة': 'كرتون' },
  ]);
  assert.deepEqual(openingStockPrimaryPreview(valid, PRODUCTS), [
    { text: '= 2 كرتون', unitRequired: false },
    { text: '= 2 كرتون و3 قارورة', unitRequired: false },
    { text: null, unitRequired: true },
    { text: null, unitRequired: true },
    { text: null, unitRequired: false },
    { text: null, unitRequired: false },
  ]);
  // بلا أصناف في اليد ⇒ لا شيء (الخادم يحكم)
  assert.deepEqual(openingStockPrimaryPreview(valid.slice(0, 1), []), [{ text: null, unitRequired: false }]);
});

test('B3b ٢: عمود «الوحدة الرئيسية» موسومٌ بالعربية في المعاينة وخطأ الصفّ — لا اسم الحقل الخام primaryUnit', () => {
  assert.equal(importFieldLabel('primaryUnit'), 'الوحدة الرئيسية');
  // رسالة الخادم تذكر الخانة سلفاً فلا يُكرَّر وسمها، وغيرها يُلصق الوسم بقيمتها
  assert.equal(importRowErrorFieldKey({ code: 'PRIMARY_UNIT_INVALID', message: PRIMARY_UNIT_INVALID, value: 'صندوق', field: 'primaryUnit' }), null);
  assert.equal(importRowErrorFieldKey({ message: 'قيمة غير صالحة', value: 'صندوق', field: 'primaryUnit' }), 'الوحدة الرئيسية');
});

test('B3b ٣: صفوف الجرد التي سيرفضها الخادم QTY_UNIT_REQUIRED تُقال بأرقامها في الملف قبل الإرسال، والمعاينة موصولة بالشاشة', () => {
  const previews = [{ text: '= 2 كرتون', unitRequired: false }, { text: null, unitRequired: true }, { text: null, unitRequired: true }];
  assert.deepEqual(openingStockUnitRequiredRows(previews, [4, 7, 9]), [7, 9]);
  assert.deepEqual(openingStockUnitRequiredRows(previews), [3, 4], 'بلا خريطة الصفوف: الموضع + ٢');
  assert.deepEqual(openingStockUnitRequiredRows([]), []);
  const panel = fs.readFileSync(path.resolve(process.cwd(), 'src', 'components', 'DataImportPanel.tsx'), 'utf8');
  assert.match(panel, /queryKey: \['products-min'\],\s*queryFn: async \(\) => \(await productApi\.list\(\{ limit: 1000 \}\)\)\.data\.data as ImportPreviewProduct\[\],\s*enabled: preview\?\.kind === OPENING_STOCK,/);
  assert.match(panel, /openingStockPrimaryPreview\(view\.rows, stockProdQ\.data\)/);
  assert.match(panel, /openingStockUnitRequiredRows\(stockPrimary, view\?\.sentFileRows\)/);
  assert.match(panel, /\{tr\(QTY_UNIT_REQUIRED\)\}/);
  assert.match(panel, /\{tr\('الكمية بوحداتها'\)\}/);
});
