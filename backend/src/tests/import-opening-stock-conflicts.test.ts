// البنود 15 و16 و24 وK وL (مراجعة استيراد البيانات 2026-09-17): المخزون الافتتاحي لا يُضاف فوق حركات سابقة، ولا يتكرر بدفعة
// ثانية (تصحيح صف أو تبديل «شاملة الضريبة»)، ولا يطابق صنفاً موقوفاً أو مؤرشفاً، وأخطاء صفوفه تدلّ على الصنف وعلى تاريخ
// الدفعة السابقة التي يتراجع عنها المالك. منطق صرف + حراس ثابتة، بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  IMPORT_ROW_MESSAGES, importBatchDateLabel, openingStockContentHash, openingStockMovementConflicts, openingStockProductFinder,
  openingStockProductMatcher, resolveOpeningStockRows, type OpeningStockLine, type OpeningStockPriorBatch,
} from '../services/importLedger';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const ARCHIVED = new Date('2026-08-01T00:00:00Z');
const products = [
  { id: 'p1', code: 'A-1', barcode: '111', name: 'أرز', taxPct: 15, status: 'ACTIVE', deletedAt: null },
  { id: 'p2', code: 'B-2', barcode: '222', name: 'سكر', taxPct: 15, status: 'ACTIVE', deletedAt: null },
  { id: 'old', code: 'OLD-1', barcode: '999', name: 'زيت', taxPct: 15, status: 'ACTIVE', deletedAt: ARCHIVED },
  { id: 'p3', code: 'C-3', barcode: '333', name: 'زيت', taxPct: 15, status: 'ACTIVE', deletedAt: null },
  { id: 'off', code: 'OFF-1', barcode: '444', name: 'ملح', taxPct: 15, status: 'INACTIVE', deletedAt: null },
  { id: 'd1', code: 'D-1', barcode: null, name: 'شاي', taxPct: 15, status: 'ACTIVE', deletedAt: null },
  { id: 'd2', code: 'D-2', barcode: null, name: 'شاي', taxPct: 15, status: 'ACTIVE', deletedAt: null },
];
const noMovements = { movedProductIds: new Set<string>(), openingBatchOf: new Map<string, OpeningStockPriorBatch>() };
// الدفعة السابقة: أُنشئت 30 أغسطس 21:30 UTC = 31 أغسطس 00:30 بتوقيت الرياض ⇒ المالك يقرأ 2026-08-31 لا معرّف b1
const PRIOR_BATCH: OpeningStockPriorBatch = { id: 'b1', createdAt: new Date('2026-08-30T21:30:00Z') };

test('سيناريو البند 15: 5000 LOAD بلا وارد ثم ملف الجرد ⇒ PRODUCT_HAS_STOCK_MOVEMENTS ولا يُكتب البند', () => {
  const { lines, errors } = resolveOpeningStockRows([{ productCode: 'A-1', qty: 3000, unitCost: 10 }, { productCode: 'B-2', qty: 5, unitCost: 2 }], openingStockProductMatcher(products), false);
  assert.equal(errors.length, 0);
  const out = openingStockMovementConflicts(lines, { ...noMovements, movedProductIds: new Set(['p1']) });
  assert.deepEqual(out.lines.map((l) => l.productId), ['p2']);
  assert.deepEqual(out.errors, [{ row: 2, code: 'PRODUCT_HAS_STOCK_MOVEMENTS', message: IMPORT_ROW_MESSAGES.PRODUCT_HAS_STOCK_MOVEMENTS }]);
  assert.equal(IMPORT_ROW_MESSAGES.PRODUCT_HAS_STOCK_MOVEMENTS,
    'للصنف حركات مستودع أو تحميل سيارات سابقة، فلا يُضاف جرده الافتتاحي فوق رصيد محسوب منها. صحّح رصيده بتسوية من شاشة المستودع');
  // وارد يدوي سابق (بند مستودع خارج دفعات الاستيراد) كذلك
  const manual = openingStockMovementConflicts(lines, { ...noMovements, movedProductIds: new Set(['p2']) });
  assert.deepEqual(manual.errors.map((e) => [e.row, e.code]), [[3, 'PRODUCT_HAS_STOCK_MOVEMENTS']]);
});

test('سيناريو البند 16: دفعة سابقة غير متراجع عنها + إعادة الملف بتصحيح صف أو بتبديل «شاملة الضريبة» ⇒ الداخل سابقاً مرفوض والمصحح وحده مقبول', () => {
  const first = [{ productCode: 'A-1', qty: 10, unitCost: 5 }, { productCode: 'X-BAD', qty: 4, unitCost: 5 }];
  // البصمة لا تتغير بتبديل الخيار (الملف نفسه)
  assert.equal(openingStockContentHash(first), openingStockContentHash([...first].reverse()));
  const src = read('routes/import.ts');
  assert.match(src, /openingStockContentHash\(rows\)/);
  assert.doesNotMatch(src, /openingStockContentHash\(rows, /);

  // الدفعة الأولى: p1=10 في الحركة e1 (دفعة b1 المنشأة 2026-08-31 بتوقيت الشركة)
  const state = { movedProductIds: new Set<string>(), openingBatchOf: new Map([['p1', PRIOR_BATCH]]), timezone: 'Asia/Riyadh' };
  const corrected = [{ productCode: 'A-1', qty: 10, unitCost: 5 }, { productCode: 'B-2', qty: 4, unitCost: 5 }];
  for (const inclusive of [false, true]) {
    const { lines } = resolveOpeningStockRows(corrected, openingStockProductMatcher(products), inclusive);
    const out = openingStockMovementConflicts(lines, state);
    assert.deepEqual(out.lines.map((l) => l.productId), ['p2'], 'p1 لا يتضاعف إلى 20 أو 30');
    // البند K: value = تاريخ الدفعة السابقة YYYY-MM-DD، فالمالك يعرف أيّ دفعة يتراجع عنها — لا معرّف UUID تخفيه الواجهة
    assert.deepEqual(out.errors, [{ row: 2, code: 'OPENING_STOCK_ALREADY_IMPORTED', message: IMPORT_ROW_MESSAGES.OPENING_STOCK_ALREADY_IMPORTED, value: '2026-08-31' }]);
  }
  assert.equal(IMPORT_ROW_MESSAGES.OPENING_STOCK_ALREADY_IMPORTED, 'للصنف مخزون افتتاحي في دفعة استيراد سابقة، تراجع عنها أولاً لتصحيحه');
  // دفعة ثالثة بالملف نفسه ثلاث مرات: كل الصفوف مرفوضة ⇒ لا بنود
  const all: OpeningStockLine[] = [{ row: 2, productId: 'p1', qty: 10, unitCost: 5 }];
  assert.equal(openingStockMovementConflicts(all, state).lines.length, 0);
});

test('سيناريو البند 24: كود مؤرشف أو موقوف ⇒ PRODUCT_INACTIVE؛ اسم مشترك بين نشط ومؤرشف ⇒ النشط؛ بين نشطين ⇒ PRODUCT_AMBIGUOUS', () => {
  const m = openingStockProductMatcher(products);
  assert.deepEqual(m({ productCode: 'OLD-1' }), { error: 'INACTIVE' });
  assert.deepEqual(m({ productCode: 'OFF-1' }), { error: 'INACTIVE' });
  assert.deepEqual(m({ barcode: '999' }), { error: 'INACTIVE' });
  assert.equal((m({ productName: 'زيت' }) as { id: string }).id, 'p3');
  assert.deepEqual(m({ productName: 'شاي' }), { error: 'AMBIGUOUS' });
  assert.deepEqual(m({ productCode: 'nope' }), { error: 'NOT_FOUND' });
  assert.equal((m({ productCode: 'nope', barcode: '111' }) as { id: string }).id, 'p1');
  // الواجهة المتوافقة تعيد المنتج أو null وتتجاهل المؤرشف
  const find = openingStockProductFinder(products);
  assert.equal(find({ productCode: 'OLD-1' }), null);
  assert.equal(find({ productName: 'زيت' })?.id, 'p3');

  const { lines, errors } = resolveOpeningStockRows([
    { productCode: 'OLD-1', qty: 1, unitCost: 1 },
    { productName: 'شاي', qty: 1, unitCost: 1 },
    { productCode: 'nope', qty: 1, unitCost: 1 },
    { productName: 'زيت', qty: 2, unitCost: 3 },
    { productCode: 'A-1', qty: 0, unitCost: 3 },
    { productCode: 'A-1', qty: 1, unitCost: 0 },
    { productCode: 'A-1', qty: 1, unitCost: 0.00001 },
  ], m, false);
  assert.deepEqual(lines.map((l) => l.productId), ['p3']);
  assert.deepEqual(errors.map((e) => [e.row, e.code]), [
    [2, 'PRODUCT_INACTIVE'], [3, 'PRODUCT_AMBIGUOUS'], [4, 'PRODUCT_NOT_FOUND'], [6, 'STOCK_QTY_INVALID'], [7, 'STOCK_COST_INVALID'], [8, 'STOCK_NET_COST_ZERO'],
  ]);
  assert.equal(errors[0].message, 'الصنف موقوف أو مؤرشف، فعّله أو استخدم صنفاً آخر');
  assert.equal(errors[1].message, 'الباركود أو الاسم مشترك بين أكثر من صنف، استخدم الكود');
  assert.equal(errors[2].message, 'الصنف غير موجود استورد المنتجات أولا');
  assert.equal(errors[3].message, 'الكمية يجب أن تكون أكبر من صفر');
  assert.equal(errors[4].message, 'تكلفة الوحدة يجب أن تكون أكبر من صفر');
  assert.equal(errors[5].message, 'تكلفة الوحدة الصافية صفرية بعد التقريب');
  // البند L: كل خطأ يحمل معرّف الصنف (كود ⇒ باركود ⇒ اسم) وعموده، وإلا وقف المالك أمام «صف 137» في ملف 5000 صف
  assert.deepEqual(errors.map((e) => e.value), ['OLD-1', 'شاي', 'nope', 'A-1', 'A-1', 'A-1']);
  assert.deepEqual(errors.map((e) => e.field), ['productCode', 'productName', 'productCode', 'productCode', 'productCode', 'productCode']);
  const byBarcode = resolveOpeningStockRows([{ barcode: '999', qty: 1, unitCost: 1 }], m, false);
  assert.deepEqual([byBarcode.errors[0].value, byBarcode.errors[0].field], ['999', 'barcode']);
  // الكود يسبق الباركود والاسم في التعريف كما في المطابقة
  const byCode = resolveOpeningStockRows([{ productCode: 'nope', barcode: '888', productName: 'س', qty: 0, unitCost: 1 }], m, false);
  assert.deepEqual([byCode.errors[0].value, byCode.errors[0].field], ['nope', 'productCode']);
  // صف بلا أي معرّف ⇒ الحقلان محذوفان لا نص فارغ
  const bare = resolveOpeningStockRows([{ qty: 1, unitCost: 1 }], m, false);
  assert.equal('value' in bare.errors[0], false);
  assert.equal('field' in bare.errors[0], false);
});

// البند K (عقد مشترك): الواجهة تقول للمالك «تراجع عن دفعة كذا» — فالخادم يضع تاريخها لا معرّفها
test('البند K: value في OPENING_STOCK_ALREADY_IMPORTED تاريخ الدفعة السابقة YYYY-MM-DD بتوقيت الشركة، ولا معرّف UUID أبداً', () => {
  const line: OpeningStockLine[] = [{ row: 2, productId: 'p1', qty: 1, unitCost: 1 }];
  const at = (tz: string | null | undefined) => openingStockMovementConflicts(line, {
    movedProductIds: new Set<string>(), openingBatchOf: new Map([['p1', PRIOR_BATCH]]), timezone: tz,
  }).errors[0].value;
  // 21:30 UTC = اليوم التالي بتوقيت الرياض (+3)، والتوقيت هو المستعمل في بقية الاستيراد
  assert.equal(at('Asia/Riyadh'), '2026-08-31');
  assert.equal(at('UTC'), '2026-08-30');
  assert.equal(at(undefined), '2026-08-31', 'بلا توقيت ⇒ توقيت المنصة الافتراضي');
  assert.equal(at('لا-توقيت'), '2026-08-31', 'توقيت غير صالح ⇒ الافتراضي لا انهيار');
  assert.equal(importBatchDateLabel(PRIOR_BATCH.createdAt, 'Asia/Riyadh'), '2026-08-31');
  assert.equal(importBatchDateLabel(new Date('invalid'), 'Asia/Riyadh'), undefined);
  assert.equal(importBatchDateLabel(null), undefined);
  // المعرّف الخام (UUID) لا يصل إلى المالك: يُحذف value بدل عرض ما لا يدلّه على شيء
  const uuid = openingStockMovementConflicts(line, {
    movedProductIds: new Set<string>(), openingBatchOf: new Map([['p1', 'b1e0c4de-0000-4000-8000-000000000001']]),
  }).errors[0];
  assert.equal('value' in uuid, false);
  assert.equal(uuid.code, 'OPENING_STOCK_ALREADY_IMPORTED');
  // وتاريخ جاهز YYYY-MM-DD يمرّ كما هو
  const ready = openingStockMovementConflicts(line, {
    movedProductIds: new Set<string>(), openingBatchOf: new Map([['p1', '2026-08-31']]),
  }).errors[0];
  assert.equal(ready.value, '2026-08-31');
});

// البند 15 (متابعة): الفحص لا يقرأ كل بنود المستودع التاريخية إلى الذاكرة داخل معاملة تمسك قفل gl-post
test('حارس ثابت: فحص الحركات السابقة بـgroupBy محدود بعدد الأصناف، والقراءة التفصيلية لحركات دفعات الجرد وحدها', () => {
  const src = read('routes/import.ts');
  const start = src.indexOf("router.post('/opening-stock'");
  const body = src.slice(start, src.indexOf('\nrouter.', start + 10));
  assert.match(body, /tx\.warehouseEntryItem\.groupBy\(/, 'لا groupBy لفحص الحركات السابقة');
  assert.match(body, /tx\.vanLoadItem\.groupBy\(/, 'تحميلات السيارات ما زالت findMany');
  assert.doesNotMatch(body, /tx\.vanLoadItem\.findMany\(/);
  // القراءة الوحيدة الباقية لبنود المستودع محدودة بمعرّفات حركات دفعات opening_stock
  const idx = body.indexOf('tx.warehouseEntryItem.findMany(');
  assert.ok(idx > 0, 'لا قراءة لبنود دفعات الجرد');
  assert.match(body.slice(idx, idx + 260), /entryId: \{ in: openingEntryIds \}/, 'قراءة بنود المستودع بلا حدّ على entryId');
  assert.equal(body.indexOf('tx.warehouseEntryItem.findMany(', idx + 1), -1, 'قراءة ثانية غير محدودة');
  // دفعات الجرد تُقرأ قبل الفحص لتُستثنى حركاتها من groupBy
  assert.ok(body.indexOf('kind: OPENING_STOCK_KIND, reverted: false') < body.indexOf('tx.warehouseEntryItem.groupBy('));
  assert.match(body, /entryId: \{ notIn: openingEntryIds \}/);
});

test('حارس ثابت: فحص الحركات السابقة بين acquirePostLock وwarehouseEntry.create، والمطابقة تجلب status وdeletedAt', () => {
  const src = read('routes/import.ts');
  const start = src.indexOf("router.post('/opening-stock'");
  const body = src.slice(start, src.indexOf('\nrouter.', start + 10));
  let pos = -1;
  for (const n of [
    'status: true, deletedAt: true', 'openingStockProductMatcher(products)', 'acquirePostLock(tx, tid)', 'assertNotDuplicateBatch(',
    'kind: OPENING_STOCK_KIND, reverted: false', 'tx.warehouseEntryItem.groupBy(', 'tx.vanLoadItem.groupBy(', "type: { in: ['LOAD', 'UNLOAD'] }",
    'tx.warehouseEntryItem.findMany(', 'openingStockMovementConflicts(', 'tx.warehouseEntry.create(', 'count: checked.lines.length',
  ]) {
    const k = body.indexOf(n, pos + 1);
    assert.ok(k > pos, `/opening-stock: ${n} خارج الترتيب`);
    pos = k;
  }
  assert.match(body, /totalCost: entryTotalCost\(out\.accepted\)/);
});
