// «تتبّع اللوط» — استيراد المخزون الافتتاحي بأعمدة التشغيلة (§٤.٥): الويب يقرأ رقم التشغيلة وتاريخي الإنتاج والانتهاء ويرسلها
// بأسماء عقد الخادم (routes/import.ts openingStockRow: lotNumber وproductionDate وexpiryDate، والتاريخان YYYY-MM-DD).
// والقاعدة الحاكمة: الشركة المطفأة لها الميزة تحويلُها ومعاينتها كما كانا حرفياً (§١٠.١)، وملفٌّ بلا أعمدة تشغيلة يرسل الصفوف نفسها.
process.env.TZ = 'Asia/Riyadh';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  IMPORT_TYPES, DATE_ERROR_MESSAGE, DATE_ORDER_MDY_NOTICE, DATE_ORDER_AMBIGUOUS_NOTICE, DATE_ORDER_CONFLICT_BLOCKER, IMPORT_TEXT_MAX, TEXT_TOO_LONG,
  LOT_COLUMN_MISSING_NOTICE, LOT_DATES_UNREADABLE_NOTICE, LOT_DATES_WITHOUT_NUMBER_NOTICE, OPENING_STOCK_LOT_HINT,
} from './importData';
import {
  LOT_DATES_INVALID_MESSAGE, LOT_EXPIRY_REQUIRED_MESSAGE, importFieldLabel, importRowErrorFieldKey, previewCellValue,
} from './importRevert';
import { PHRASES } from '../i18n/strings';

const stock = IMPORT_TYPES.opening_stock.transform;
const lots = { lotTracking: true } as const;
const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8');
const fields = (cols: { field: string }[] | undefined) => (cols ?? []).map((c) => c.field);
const BASE_FIELDS = ['code', 'barcode', 'name', 'qty', 'unitCost', 'unit'];

test('الميزة مطفأة: أعمدة التشغيلة تُتجاهل والتحويل كما كان حرفياً — لا حقل ولا عمود معاينة ولا تنبيه', () => {
  const rows = [{ 'كود الصنف': 'P-1', 'الكمية': 2, 'التكلفة': 3, 'رقم التشغيلة': 'L1', 'تاريخ الانتهاء': '01/02/2027' }];
  const off = stock(rows);
  assert.deepEqual(off.valid, [{ productCode: 'P-1', qty: 2, unitCost: 3 }]);
  assert.deepEqual(fields(off.columns), BASE_FIELDS);
  assert.deepEqual(stock(rows, { lotTracking: false }), off);
  // ملفٌّ بلا أعمدة تشغيلة يعطي الصفوف نفسها مفعّلةً كانت الميزة أو مطفأة (والبصمة على الخادم معها)
  const plain = [{ 'كود الصنف': 'P-1', 'الكمية': 2, 'التكلفة': 3 }];
  assert.deepEqual(stock(plain, lots).valid, stock(plain).valid);
  assert.deepEqual(stock(plain, lots).errors, []);
});

test('الأعمدة العربية: الرقم كما كُتب، والتاريخان بصيغة الخادم، والصنف بتشغيلتين صفّان', () => {
  const r = stock([
    { 'كود الصنف': 'P-1', 'الكمية': 10, 'تكلفة الوحدة': 5, 'رقم التشغيلة': 'b-2026-01', 'تاريخ الإنتاج': '15/01/2026', 'تاريخ الانتهاء': '15/01/2027' },
    { 'كود الصنف': 'P-1', 'الكمية': 4, 'تكلفة الوحدة': 5, 'رقم التشغيلة': 'B-2026-02', 'تاريخ الإنتاج': '', 'تاريخ الانتهاء': '2027-03-31' },
    { 'كود الصنف': 'P-2', 'الكمية': 1, 'تكلفة الوحدة': 2, 'رقم التشغيلة': '', 'تاريخ الإنتاج': '', 'تاريخ الانتهاء': '' },
  ], lots);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.valid, [
    { productCode: 'P-1', qty: 10, unitCost: 5, lotNumber: 'b-2026-01', productionDate: '2026-01-15', expiryDate: '2027-01-15' },
    { productCode: 'P-1', qty: 4, unitCost: 5, lotNumber: 'B-2026-02', expiryDate: '2027-03-31' },
    { productCode: 'P-2', qty: 1, unitCost: 2 },
  ]);
  assert.deepEqual(r.fileRows, [2, 3, 4]);
  assert.deepEqual(fields(r.columns), [...BASE_FIELDS, 'lotNumber', 'productionDate', 'expiryDate']);
  const col = (f: string) => r.columns?.find((c) => c.field === f)?.header;
  assert.equal(col('lotNumber'), 'رقم التشغيلة');
  assert.equal(col('expiryDate'), 'تاريخ الانتهاء');
  assert.equal(r.notices?.some((n) => n.key === LOT_COLUMN_MISSING_NOTICE), false);
});

test('أعمدة أودو: «Lot/Serial Number» و«Expiration Date» (خلية تاريخ)، و«Production Date» ليس اسم الصنف، و«Lot Code» ليس كوده', () => {
  const odoo = stock([{
    'Internal Reference': 'A1', 'Product': 'Water', 'Lot/Serial Number': 'LOT-77', 'On Hand Quantity': 3, 'Unit Cost': 2.5,
    'Expiration Date': new Date(2027, 0, 15, 0, 0, 0), 'Removal Date': new Date(2026, 11, 15, 0, 0, 0),
  }], lots);
  assert.deepEqual(odoo.valid, [{ productCode: 'A1', productName: 'Water', qty: 3, unitCost: 2.5, lotNumber: 'LOT-77', expiryDate: '2027-01-15' }]);

  // بلا عمود اسمٍ مطابق تماماً: «Production Date» يحوي «product» فلا يُلتقط اسماً، و«Lot Code» يحوي «code» فلا يُلتقط كوداً
  const r = stock([{ 'Item Description': 'Juice', 'Lot Code': 'LC-1', 'Qty': 2, 'Cost': 4, 'Production Date': '2026-09-01', 'Best Before': '2027-09-01' }], lots);
  assert.deepEqual(r.valid, [{ productName: 'Juice', qty: 2, unitCost: 4, lotNumber: 'LC-1', productionDate: '2026-09-01', expiryDate: '2027-09-01' }]);
  // ورقمٌ رقميّ في Excel يُرسل نصّاً
  assert.equal(stock([{ 'كود الصنف': 'P', 'الكمية': 1, 'التكلفة': 1, 'Batch': 2026001 }], lots).valid[0].lotNumber, '2026001');
});

test('تاريخ تشغيلة غير مفهوم أو إنتاجٌ بعد الانتهاء: الصفّ يبقى ويُرسل نصّه كما كُتب بتنبيهٍ معدود — الحكم للخادم وحده', () => {
  // الويب لا يعرف أيّ الأصناف متتبَّع: الخادم يرفض صفّ المتتبَّع بـLOT_DATES_INVALID ويتجاهل الأعمدة لغيره (importLedger.openingStockLotOf)،
  // فإسقاط الصفّ هنا كان يُسقط رصيد صنفٍ غير متتبَّع بصمت
  const r = stock([
    { 'كود الصنف': 'A', 'الكمية': 1, 'التكلفة': 1, 'رقم التشغيلة': 'L1', 'تاريخ الانتهاء': '31/02/2027' },
    { 'كود الصنف': 'B', 'الكمية': 1, 'التكلفة': 1, 'رقم التشغيلة': 'L2', 'تاريخ الإنتاج': 'أمس' },
    { 'كود الصنف': 'C', 'الكمية': 1, 'التكلفة': 1, 'رقم التشغيلة': 'L3', 'تاريخ الإنتاج': '2027-02-01', 'تاريخ الانتهاء': '2027-01-01' },
    { 'كود الصنف': 'D', 'الكمية': 1, 'التكلفة': 1, 'رقم التشغيلة': 'L4', 'تاريخ الإنتاج': '2027-01-01', 'تاريخ الانتهاء': '2027-01-01' },
    { 'كود الصنف': 'E', 'الكمية': 1, 'التكلفة': 1, 'رقم التشغيلة': 'L5', 'تاريخ الإنتاج': 'x'.repeat(IMPORT_TEXT_MAX + 5) },
  ], lots);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.valid, [
    { productCode: 'A', qty: 1, unitCost: 1, lotNumber: 'L1', expiryDate: '31/02/2027' },
    { productCode: 'B', qty: 1, unitCost: 1, lotNumber: 'L2', productionDate: 'أمس' },
    { productCode: 'C', qty: 1, unitCost: 1, lotNumber: 'L3', productionDate: '2027-02-01', expiryDate: '2027-01-01' },
    { productCode: 'D', qty: 1, unitCost: 1, lotNumber: 'L4', productionDate: '2027-01-01', expiryDate: '2027-01-01' },
    // حدّ zod للنصّ (٢٠٠) لا يُتجاوز فلا يُرفض الملف كله، والمقطوع يبقى غير صالحٍ عند الخادم
    { productCode: 'E', qty: 1, unitCost: 1, lotNumber: 'L5', productionDate: 'x'.repeat(IMPORT_TEXT_MAX) },
  ]);
  assert.deepEqual(r.fileRows, [2, 3, 4, 5, 6]);
  const n = r.notices?.find((x) => x.key === LOT_DATES_UNREADABLE_NOTICE);
  assert.equal(n?.count, 4, 'الإنتاج يوم الانتهاء نفسه صالح');
  assert.deepEqual(n?.values?.slice(0, 3), ['2: 31/02/2027', '3: أمس', '4: 2027-02-01 > 2027-01-01']);
  assert.equal(r.notices?.some((x) => x.key === DATE_ERROR_MESSAGE), false);
});

test('صفوف الأصناف غير المتتبَّعة لا تسقط بتاريخٍ لا يُقرأ: بلا رقم تشغيلة لا تُقرأ تواريخها ولا تُرسل', () => {
  // ما وجده المراجعان: «-» و«لا يوجد» في عمود الانتهاء لصنفٍ بلا صلاحية كانا يُسقطان رصيده من الاستيراد
  const r = stock([
    { 'كود الصنف': 'NT-1', 'الكمية': 3, 'التكلفة': 2, 'رقم التشغيلة': '', 'تاريخ الانتهاء': '-' },
    { 'كود الصنف': 'NT-2', 'الكمية': 1, 'التكلفة': 2, 'رقم التشغيلة': '', 'تاريخ الإنتاج': '2027-05-01', 'تاريخ الانتهاء': 'لا يوجد' },
    { 'كود الصنف': 'T-1', 'الكمية': 2, 'التكلفة': 2, 'رقم التشغيلة': 'L1', 'تاريخ الانتهاء': '2027-01-01' },
  ], lots);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.valid, [
    { productCode: 'NT-1', qty: 3, unitCost: 2 },
    { productCode: 'NT-2', qty: 1, unitCost: 2 },
    { productCode: 'T-1', qty: 2, unitCost: 2, lotNumber: 'L1', expiryDate: '2027-01-01' },
  ]);
  // «-» ليس تاريخاً فلا يُعدّ «تاريخاً بلا رقم»، والتاريخ الحقيقي بلا رقمٍ يُعدّ
  assert.equal(r.notices?.find((x) => x.key === LOT_DATES_WITHOUT_NUMBER_NOTICE)?.count, 1);
  assert.equal(r.notices?.some((x) => x.key === LOT_DATES_UNREADABLE_NOTICE), false);
  // مثال المراجع الثاني بعناوين إنجليزية
  const en = stock([{ Product: 'A', Quantity: 5, 'Unit Cost': 2, Lot: '', 'Expiry Date': '-' }], lots);
  assert.deepEqual(en.valid, [{ productName: 'A', qty: 5, unitCost: 2 }]);
  assert.deepEqual(en.errors, []);
});

test('عنوان «lot» القصير يُطابَق في أول كلمة لا في وسطها: «Slot» و«Plot No» و«Allotment» ليست رقم التشغيلة', () => {
  const r = stock([{ 'كود الصنف': 'A', 'الكمية': 5, 'التكلفة': 2, 'Slot': 'S3', 'Plot No': 'P1', 'Allotment': 'X', 'Slot Number': 'N' }], lots);
  assert.deepEqual(r.valid, [{ productCode: 'A', qty: 5, unitCost: 2 }]);
  assert.equal(r.columns?.find((c) => c.field === 'lotNumber')?.header, null);
  // والعنوان الذي تبدأ إحدى كلماته بها يبقى
  const pick = (h: string) => stock([{ 'كود الصنف': 'A', 'الكمية': 1, 'التكلفة': 1, [h]: 'L-9' }], lots).valid[0].lotNumber;
  for (const h of ['Lot', 'Lot #', 'LotNo', 'Supplier Lot', 'supplier_lot_no', 'SupplierLotNumber', 'Lot/Serial', 'Batch', 'Batch Code', 'رقم التشغيلة الداخلي']) {
    assert.equal(pick(h), 'L-9', h);
  }
});

test('ترتيب اليوم/الشهر يُكشف من عمودي التاريخين معاً، والتعارض لا يمنع: كل تاريخٍ بدليله والملتبس يُرسل كما كُتب', () => {
  const mdy = stock([
    { 'كود الصنف': 'A', 'الكمية': 1, 'التكلفة': 1, 'رقم التشغيلة': 'L1', 'تاريخ الإنتاج': '01/02/2026', 'تاريخ الانتهاء': '12/25/2026' },
    { 'كود الصنف': 'B', 'الكمية': 1, 'التكلفة': 1, 'رقم التشغيلة': 'L2', 'تاريخ الانتهاء': '11/30/2026' },
  ], lots);
  assert.deepEqual(mdy.valid.map((v) => [v.productionDate, v.expiryDate]), [['2026-01-02', '2026-12-25'], [undefined, '2026-11-30']]);
  assert.ok(mdy.notices?.some((n) => n.key === DATE_ORDER_MDY_NOTICE));
  // الدليل من عمود الإنتاج يحسم الانتهاء الملتبس: العمودان صيغةٌ واحدة من نظامٍ واحد
  const cross = stock([
    { 'كود الصنف': 'A', 'الكمية': 1, 'التكلفة': 1, 'رقم التشغيلة': 'L1', 'تاريخ الإنتاج': '12/25/2025', 'تاريخ الانتهاء': '01/02/2027' },
    { 'كود الصنف': 'B', 'الكمية': 1, 'التكلفة': 1, 'رقم التشغيلة': 'L2', 'تاريخ الإنتاج': '11/30/2025', 'تاريخ الانتهاء': '03/04/2027' },
  ], lots);
  assert.deepEqual(cross.errors, []);
  assert.deepEqual(cross.valid.map((v) => v.expiryDate), ['2027-01-02', '2027-03-04']);

  // تعارض الصيغتين: لا مانع للملف كله (قد تكون أصنافه كلها غير متتبَّعة)، ولا قلب صامت —
  // ما يحسمه جزؤه (> 12) يُقرأ بدليله، والملتبس (جزآه ≤ 12) يُرسل نصّه فيرفضه الخادم للمتتبَّع وحده
  const conflict = stock([
    { 'كود الصنف': 'A', 'الكمية': 1, 'التكلفة': 1, 'رقم التشغيلة': 'L1', 'تاريخ الانتهاء': '25/01/2027' },
    { 'كود الصنف': 'B', 'الكمية': 1, 'التكلفة': 1, 'رقم التشغيلة': 'L2', 'تاريخ الانتهاء': '01/25/2027' },
    { 'كود الصنف': 'C', 'الكمية': 1, 'التكلفة': 1, 'رقم التشغيلة': 'L3', 'تاريخ الانتهاء': '05/01/2027' },
    { 'كود الصنف': 'D', 'الكمية': 1, 'التكلفة': 1, 'رقم التشغيلة': 'L4', 'تاريخ الانتهاء': '05/05/2027' },
  ], lots);
  assert.deepEqual(conflict.blockers, []);
  assert.deepEqual(conflict.errors, []);
  // «05/05/2027» يومه وشهره متساويان فلا التباس: يُقرأ ولا يدخل التنبيه
  assert.deepEqual(conflict.valid.map((v) => v.expiryDate), ['2027-01-25', '2027-01-25', '05/01/2027', '2027-05-05']);
  assert.deepEqual(conflict.notices?.find((n) => n.key === LOT_DATES_UNREADABLE_NOTICE)?.values, ['4: 05/01/2027']);
  assert.equal(conflict.notices?.some((n) => n.key === DATE_ORDER_AMBIGUOUS_NOTICE || n.key === DATE_ORDER_MDY_NOTICE), false);
  // تواريخ الصفوف بلا رقم تشغيلة لا تُقرأ أصلاً، فلا تدخل الكشف ولا تقلب ترتيب غيرها
  const noNum = stock([
    { 'كود الصنف': 'A', 'الكمية': 1, 'التكلفة': 1, 'رقم التشغيلة': '', 'تاريخ الانتهاء': '12/25/2026' },
    { 'كود الصنف': 'B', 'الكمية': 1, 'التكلفة': 1, 'رقم التشغيلة': '', 'تاريخ الانتهاء': '11/30/2026' },
    { 'كود الصنف': 'C', 'الكمية': 1, 'التكلفة': 1, 'رقم التشغيلة': 'L3', 'تاريخ الانتهاء': '03/04/2027' },
  ], lots);
  assert.deepEqual(noNum.blockers, []);
  assert.equal(noNum.valid[2].expiryDate, '2027-04-03', 'اليوم أولاً: لا دليل أمريكي من صفوفٍ لا تُقرأ تواريخها');
  assert.ok(!stock([
    { 'كود الصنف': 'A', 'الكمية': 1, 'التكلفة': 1, 'تاريخ الانتهاء': '25/01/2027' },
    { 'كود الصنف': 'B', 'الكمية': 1, 'التكلفة': 1, 'تاريخ الانتهاء': '01/25/2027' },
  ], lots).blockers?.includes(DATE_ORDER_CONFLICT_BLOCKER));

  const ambiguous = stock([{ 'كود الصنف': 'A', 'الكمية': 1, 'التكلفة': 1, 'رقم التشغيلة': 'L1', 'تاريخ الانتهاء': '05/01/2027' }], lots);
  assert.equal(ambiguous.valid[0].expiryDate, '2027-01-05', 'اليوم أولاً افتراضاً');
  assert.deepEqual(ambiguous.notices?.find((n) => n.key === DATE_ORDER_AMBIGUOUS_NOTICE)?.count, 1);
  // والميزة مطفأة: لا كشف ولا تنبيه ولا مانع من عمودٍ لا يُقرأ
  const off = stock([
    { 'كود الصنف': 'A', 'الكمية': 1, 'التكلفة': 1, 'تاريخ الانتهاء': '25/01/2027' },
    { 'كود الصنف': 'B', 'الكمية': 1, 'التكلفة': 1, 'تاريخ الانتهاء': '01/25/2027' },
  ]);
  assert.deepEqual(off.blockers, []);
  assert.deepEqual(off.notices, []);
});

test('تنبيهات غير مانعة: الملف بلا عمود رقم التشغيلة، وتاريخٌ بلا رقم — وحدّ ٢٠٠ حرف خطأ صفّ لا رفض ملف', () => {
  const noCol = stock([{ 'كود الصنف': 'A', 'الكمية': 1, 'التكلفة': 1 }], lots);
  assert.ok(noCol.notices?.some((n) => n.key === LOT_COLUMN_MISSING_NOTICE));
  assert.equal(noCol.valid.length, 1, 'تنبيهٌ لا مانع: الخادم يحكم للصنف المتتبَّع وحده');
  assert.equal(stock([{ 'كود الصنف': 'A', 'الكمية': 0, 'التكلفة': 1 }], lots).notices?.some((n) => n.key === LOT_COLUMN_MISSING_NOTICE), false, 'لا صفوف صالحة ⇒ لا تنبيه');

  const noNumber = stock([
    { 'كود الصنف': 'A', 'الكمية': 1, 'التكلفة': 1, 'رقم التشغيلة': '', 'تاريخ الانتهاء': '2027-01-01' },
    { 'كود الصنف': 'B', 'الكمية': 1, 'التكلفة': 1, 'رقم التشغيلة': 'L', 'تاريخ الانتهاء': '2027-01-01' },
  ], lots);
  assert.deepEqual(noNumber.notices?.find((n) => n.key === LOT_DATES_WITHOUT_NUMBER_NOTICE)?.count, 1);
  // تاريخٌ بلا رقم لا يُخزَّن أبداً (المتتبَّع يُرفض بـLOT_REQUIRED، وغيره تُتجاهل أعمدته) فلا يُرسل ولا تُريه المعاينة
  assert.deepEqual(noNumber.valid[0], { productCode: 'A', qty: 1, unitCost: 1 });

  const long = stock([{ 'كود الصنف': 'A', 'الكمية': 1, 'التكلفة': 1, 'رقم التشغيلة': 'x'.repeat(IMPORT_TEXT_MAX + 1) }], lots);
  assert.deepEqual(long.errors.map((e) => [e.message, e.field]), [[TEXT_TOO_LONG, 'lotNumber']]);
});

test('المعاينة ووسوم الخانات: الحقول الثلاثة بأسمائها المترجمة، وخطأ الخادم لا يُلصق وسم الانتهاء على رقم التشغيلة', () => {
  assert.equal(importFieldLabel('lotNumber'), 'رقم التشغيلة');
  assert.equal(importFieldLabel('productionDate'), 'تاريخ إنتاج التشغيلة');
  assert.equal(importFieldLabel('expiryDate'), 'تاريخ انتهاء التشغيلة');
  for (const k of ['رقم التشغيلة', 'تاريخ إنتاج التشغيلة', 'تاريخ انتهاء التشغيلة', LOT_COLUMN_MISSING_NOTICE, LOT_DATES_WITHOUT_NUMBER_NOTICE, LOT_DATES_UNREADABLE_NOTICE, OPENING_STOCK_LOT_HINT, LOT_DATES_INVALID_MESSAGE]) {
    const row = PHRASES[k];
    assert.ok(row && row.en && row.fr && row.tr && row.zh, `لا ترجمة كاملة: ${k}`);
  }
  const sent = { productCode: 'P', qty: 1, unitCost: 1, lotNumber: 'L1', expiryDate: '2027-01-01' };
  assert.equal(previewCellValue(sent, 'lotNumber'), 'L1');
  assert.equal(previewCellValue(sent, 'expiryDate'), '2027-01-01');
  assert.equal(previewCellValue(sent, 'productionDate'), undefined);
  // الخادم: LOT_EXPIRY_REQUIRED قيمته رقم التشغيلة وخانته expiryDate — رسالته تذكر الخانة فلا وسم
  assert.equal(importRowErrorFieldKey({ code: 'LOT_EXPIRY_REQUIRED', message: LOT_EXPIRY_REQUIRED_MESSAGE, value: 'L1', field: 'expiryDate' }), null);
  // LOT_DATES_INVALID بقيمة التاريخ المرفوض: وسم خانته ظاهر
  assert.equal(importRowErrorFieldKey({ code: 'LOT_DATES_INVALID', value: '2027-13-01', field: 'productionDate' }), 'تاريخ إنتاج التشغيلة');
  assert.equal(importRowErrorFieldKey({ code: 'LOT_DATES_MISMATCH', value: 'L1', field: 'lotNumber' }), 'رقم التشغيلة');
});

test('صفحة الاستيراد: العلم من /company يصل التحويل والميزة مفعّلة وحدها، وإرشاد المعاينة وتحذيرات الردّ خلفه', () => {
  const s = read('components', 'DataImportPanel.tsx');
  assert.ok(s.includes('const lotTracking = lotFlagsOf(companyCfg).on;'));
  assert.ok(s.includes('...(lotTracking ? { lotTracking: true } : {}),'), 'المطفأة: خيارات التحويل كما كانت');
  assert.match(s, /\}, \[preview, ledger, undatedDate, excludeAfter, forceUndated, serverActivated, lotTracking, zeroPriceAck, companyDecimals, priceInclTax\]\);/);
  assert.ok(s.includes('{lotTracking && <p data-opening-stock-lots="">{tr(OPENING_STOCK_LOT_HINT)}</p>}'));
  assert.match(s, /const lotWarnCodes = result\.kind === OPENING_STOCK\s*\? \[\.\.\.new Set\(lotWarningsOf\(/);
});
