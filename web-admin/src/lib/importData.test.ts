// التواريخ المحلية تُختبر بتوقيت الرياض (UTC+3) — حيث كانت toISOString تُرجع اليوم السابق
process.env.TZ = 'Asia/Riyadh';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';
import {
  IMPORT_TYPES, normDate, addDaysYmd, classifyImportRowsByCutover, parseExcelFile,
  DATE_ERROR_MESSAGE, CUSTOMER_BALANCE_WARNING,
  classifyImportFailure, openingStockGate, todayInZone, openingStockNoteKey, openingStockAckState,
  OPENING_STOCK_ACTIVE_NOTE, OPENING_STOCK_FULL_HISTORY_NOTE, OPENING_STOCK_AFTER_CUTOVER_NOTE, OPENING_STOCK_OPEN_NOTE,
  STOCK_ID_MISSING, STOCK_QTY_INVALID, STOCK_COST_INVALID, STOCK_ZERO_QTY_WARNING,
  fileRowOf, importContextTimezone, localizedServerMessage, listSeparator,
} from './importData';

const bal = IMPORT_TYPES.balances.transform;
const led = IMPORT_TYPES.ledger.transform;

test('TZ الاختبار هو الرياض فعلاً', () => {
  assert.equal(new Date(2026, 0, 1).getTimezoneOffset(), -180);
});

test('normDate: yyyy-mm-dd كما هو، وd/m/yyyy اليوم أولاً، ورفض غير الحقيقي', () => {
  assert.equal(normDate('2026-01-01'), '2026-01-01');
  assert.equal(normDate('2026/1/5'), '2026-01-05');
  assert.equal(normDate('01/02/2026'), '2026-02-01');
  assert.equal(normDate('31/12/2025'), '2025-12-31');
  assert.equal(normDate('1-9-2026'), '2026-09-01');
  assert.equal(normDate('1.9.2026'), '2026-09-01');
  assert.equal(normDate('٣١/١٢/٢٠٢٥'), '2025-12-31');
  assert.equal(normDate('2026-09-01 00:00:00'), '2026-09-01');
  assert.equal(normDate(''), '');
  assert.equal(normDate('31/02/2026'), null);
  assert.equal(normDate('2026-13-01'), null);
  assert.equal(normDate('29/02/2025'), null);
  assert.equal(normDate('29/02/2024'), '2024-02-29');
  assert.equal(normDate('أمس'), null);
  assert.equal(normDate('45292'), null);
});

test('خلية تاريخ 2026-01-01 (Date محلي) تعطي «2026-01-01» لا اليوم السابق', () => {
  const r = bal([{ 'الاسم': 'أ', 'الرصيد': 100, 'التاريخ': new Date(2026, 0, 1) }]);
  assert.equal(r.valid[0].date, '2026-01-01');
  // انزياح ثوانٍ من SheetJS (23:59:50 من اليوم السابق) يُقرَّب لأقرب دقيقة
  const r2 = bal([{ 'الاسم': 'أ', 'الرصيد': 100, 'التاريخ': new Date(2025, 11, 31, 23, 59, 50) }]);
  assert.equal(r2.valid[0].date, '2026-01-01');
});

test('ملف Excel حقيقي بخلية تاريخ: القراءة ثم التحويل تعطي اليوم نفسه', async () => {
  const ws = XLSX.utils.aoa_to_sheet([['الاسم', 'الرصيد', 'التاريخ'], ['أ', 50, new Date(2026, 8, 1)]], { cellDates: true });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const file = new File([buf], 't.xlsx');
  const rows = await parseExcelFile(file);
  const r = bal(rows);
  assert.equal(r.errors.length, 0);
  assert.equal(r.valid[0].date, '2026-09-01');
});

test('نص «01/02/2026» في الأرصدة والكشوف يعطي 2026-02-01، و«31/02/2026» خطأ يُستبعد', () => {
  const r = bal([
    { 'الاسم': 'أ', 'الرصيد': 10, 'التاريخ': '01/02/2026' },
    { 'الاسم': 'ب', 'الرصيد': 10, 'التاريخ': '31/12/2025' },
    { 'الاسم': 'ج', 'الرصيد': 10, 'التاريخ': '31/02/2026' },
  ]);
  assert.deepEqual(r.valid.map((v) => v.date), ['2026-02-01', '2025-12-31']);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].row, 4);
  assert.equal(r.errors[0].message, DATE_ERROR_MESSAGE);
  assert.equal(r.errors[0].value, '31/02/2026');

  const l = led([
    { 'الاسم': 'أ', 'مدين': 5, 'التاريخ': '01/02/2026' },
    { 'الاسم': 'ب', 'مدين': 5, 'التاريخ': '31/02/2026' },
  ]);
  assert.deepEqual(l.valid.map((v) => v.date), ['2026-02-01']);
  assert.equal(l.errors.length, 1);
  assert.equal(l.errors[0].row, 3);
});

test('الصفوف بلا تاريخ: تُعدّ في المعاينة، وundatedDate يملأ الفارغ فقط', () => {
  const rows = [
    { 'الاسم': 'أ', 'الرصيد': 10 },
    { 'الاسم': 'ب', 'الرصيد': 20, 'التاريخ': '2026-07-15' },
    { 'الاسم': 'ج', 'الرصيد': 0 },
  ];
  const plain = bal(rows);
  assert.equal(plain.undated, 1);
  assert.equal(plain.valid[0].date, undefined);
  assert.equal(plain.valid[1].date, '2026-07-15');

  const filled = bal(rows, { undatedDate: '2026-08-31' });
  assert.equal(filled.undated, 1);
  assert.deepEqual(filled.valid.map((v) => v.date), ['2026-08-31', '2026-07-15']);

  const l = led([{ 'الاسم': 'أ', 'دائن': 7 }, { 'الاسم': 'ب', 'دائن': 7, 'التاريخ': '2026-01-01' }], { undatedDate: '2026-08-31' });
  assert.equal(l.undated, 1);
  assert.deepEqual(l.valid.map((v) => v.date), ['2026-08-31', '2026-01-01']);
});

test('addDaysYmd: اليوم السابق لتاريخ البدء عبر حدود الشهر والسنة', () => {
  assert.equal(addDaysYmd('2026-09-01', -1), '2026-08-31');
  assert.equal(addDaysYmd('2026-01-01', -1), '2025-12-31');
  assert.equal(addDaysYmd('2024-03-01', -1), '2024-02-29');
});

test('classifyImportRowsByCutover: قبل البدء، يوم البدء، بعده، بلا تاريخ', () => {
  const s = classifyImportRowsByCutover(
    [{ date: '2026-08-31' }, { date: '2026-09-01' }, { date: '2026-10-15' }, {}, { date: '' }],
    '2026-09-01', 'Asia/Riyadh',
  );
  assert.deepEqual(s.classes, ['before', 'onOrAfter', 'onOrAfter', 'undated', 'undated']);
  assert.equal(s.before, 1);
  assert.equal(s.onOrAfter, 2);
  assert.equal(s.undated, 2);
});

test('classifyImportRowsByCutover: الحد عند منتصف الليل بتوقيت الرياض لا UTC', () => {
  // 2026-08-31T21:00Z = 2026-09-01 00:00 بالرياض ⇒ يوم البدء؛ و20:59:59Z = 23:59:59 من 08-31 ⇒ قبل
  const s = classifyImportRowsByCutover(
    [{ date: '2026-08-31T21:00:00.000Z' }, { date: '2026-08-31T20:59:59.000Z' }, { date: new Date('2026-08-31T21:00:00Z') }],
    '2026-09-01', 'Asia/Riyadh',
  );
  assert.deepEqual(s.classes, ['onOrAfter', 'before', 'onOrAfter']);
  // المنطقة نفسها تحسم: في UTC اللحظة الأولى ما زالت 08-31
  assert.deepEqual(classifyImportRowsByCutover([{ date: '2026-08-31T21:00:00.000Z' }], '2026-09-01', 'UTC').classes, ['before']);
});

test('toCustomers: عمود «الرصيد» غير صفري يعطي تحذيراً غير مانع، والصفري لا شيء', () => {
  const warn = IMPORT_TYPES.customers.transform([
    { 'الاسم': 'أ', 'الجوال': '0500000000', 'الرصيد': 0 },
    { 'الاسم': 'ب', 'الجوال': '0500000001', 'الرصيد': '1,250.00' },
  ]);
  assert.equal(warn.valid.length, 2);
  assert.deepEqual(warn.warnings, [CUSTOMER_BALANCE_WARNING]);

  const quiet = IMPORT_TYPES.customers.transform([{ 'الاسم': 'أ', 'الجوال': '0500000000', 'الرصيد': 0 }, { 'الاسم': 'ب' }]);
  assert.deepEqual(quiet.warnings, []);
});

test('normDate: أسماء الأشهر (إنجليزية وعربية) اليوم أولاً أو الشهر أولاً، ورفض غير الحقيقي', () => {
  assert.equal(normDate('15-Jan-2025'), '2025-01-15');
  assert.equal(normDate('Jan 15, 2025'), '2025-01-15');
  assert.equal(normDate('15 يناير 2025'), '2025-01-15');
  assert.equal(normDate('15 January 2025 10:00'), '2025-01-15');
  assert.equal(normDate('3 Sept 2025'), '2025-09-03');
  assert.equal(normDate('1 إبريل 2025'), '2025-04-01'); // الهمزة تُوحَّد ⇒ ابريل
  assert.equal(normDate('1 أبريل 2025'), '2025-04-01');
  assert.equal(normDate('٥ أكتوبر ٢٠٢٥'), '2025-10-05');
  assert.equal(normDate('31-Feb-2025'), null);
  assert.equal(normDate('Foo 1, 2025'), null);
  assert.equal(normDate('2025-01-15T10:00Z'), '2025-01-15');
  assert.equal(normDate('01/15/2025'), null);
  assert.equal(normDate('45292'), null);
  assert.equal(normDate('أمس'), null);
});

test('ملف CSV بتواريخ اليوم أولاً: 05/01/2025 تبقى 5 يناير لا 1 مايو', async () => {
  const csv = 'الاسم,الرصيد,التاريخ\nأ,10,05/01/2025\nب,20,13/01/2025\n';
  const rows = await parseExcelFile(new File([csv], 'balances.csv', { type: 'text/csv' }));
  const r = bal(rows);
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.valid.map((v) => v.date), ['2025-01-05', '2025-01-13']);
  assert.deepEqual(r.valid.map((v) => v.balance), [10, 20]);
});

test('CSV بـBOM وبلا BOM: العناوين العربية تُقرأ سليمة والتواريخ اليوم أولاً', async () => {
  for (const bom of ['﻿', '']) {
    const rows = await parseExcelFile(new File([`${bom}الاسم,مدين,التاريخ\nأ,5,01/02/2026\n`], 'ledger.CSV'));
    const l = led(rows);
    assert.deepEqual(l.valid.map((v) => [v.customerName, v.debit, v.date]), [['أ', 5, '2026-02-01']]);
  }
});

// ═══ المخزون الافتتاحي ═══
const stock = IMPORT_TYPES.opening_stock.transform;

test('opening_stock: المسار والتسمية، والأعمدة العربية تُحوَّل لعقد الخادم', () => {
  assert.equal(IMPORT_TYPES.opening_stock.endpoint, '/import/opening-stock');
  const r = stock([
    { 'كود الصنف': 'P-1', 'اسم الصنف': 'ماء 330', 'الكمية': '12', 'تكلفة الوحدة': '10' },
    { 'كود الصنف': '', 'الباركود': 6281000000001, 'اسم الصنف': 'عصير', 'الكمية': 5, 'تكلفة الوحدة': '1,250.50' },
  ]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.valid, [
    { productCode: 'P-1', productName: 'ماء 330', qty: 12, unitCost: 10 },
    { barcode: '6281000000001', productName: 'عصير', qty: 5, unitCost: 1250.5 },
  ]);
  assert.equal(r.totalCost, 12 * 10 + 5 * 1250.5);
});

test('opening_stock: أعمدة أودو الإنجليزية، و«إجمالي التكلفة» لا يُلتقط تكلفةً للوحدة، و«كود الصنف» ليس اسماً', () => {
  const odoo = stock([{ 'Internal Reference': 'A1', 'Product': 'Water', 'On Hand Quantity': 3, 'Reserved Quantity': 1, 'Total Value': 900, 'Unit Cost': 2.5 }]);
  assert.deepEqual(odoo.valid, [{ productCode: 'A1', productName: 'Water', qty: 3, unitCost: 2.5 }]);

  // لا عمود تكلفة وحدة: «إجمالي التكلفة» وحده ⇒ خطأ التكلفة لا تكلفة خاطئة
  const totalOnly = stock([{ 'كود الصنف': 'P-1', 'الكمية': 4, 'إجمالي التكلفة': 400 }]);
  assert.equal(totalOnly.valid.length, 0);
  assert.equal(totalOnly.errors[0].message, STOCK_COST_INVALID);

  // «كود الصنف» وحده: لا يُنسخ إلى productName
  assert.deepEqual(stock([{ 'كود الصنف': 'P-9', 'الكمية': 1, 'التكلفة': 3 }]).valid, [{ productCode: 'P-9', qty: 1, unitCost: 3 }]);
});

test('opening_stock: الأخطاء بأرقام أسطر الملف، والكمية الصفرية تُتجاهل بتنبيه', () => {
  const r = stock([
    { 'الكمية': 2, 'التكلفة': 1 },
    { 'كود الصنف': 'A', 'الكمية': -3, 'التكلفة': 1 },
    { 'كود الصنف': 'B', 'الكمية': 2, 'التكلفة': 0 },
    { 'كود الصنف': 'C', 'الكمية': 2, 'التكلفة': 2e9 },
    { 'كود الصنف': 'D', 'الكمية': 0, 'التكلفة': 5 },
    { 'كود الصنف': 'E', 'الكمية': 1, 'التكلفة': 7 },
  ]);
  assert.deepEqual(r.errors.map((e) => [e.row, e.message]), [
    [2, STOCK_ID_MISSING], [3, STOCK_QTY_INVALID], [4, STOCK_COST_INVALID], [5, STOCK_COST_INVALID],
  ]);
  assert.deepEqual(r.valid, [{ productCode: 'E', qty: 1, unitCost: 7 }]);
  assert.deepEqual(r.warnings, [STOCK_ZERO_QTY_WARNING]);
  assert.deepEqual(stock([{ 'كود الصنف': 'E', 'الكمية': 1, 'التكلفة': 7 }]).warnings, []);
});

// ═══ تصنيف ردود الخادم ═══
const httpErr = (status: number, data: unknown) => ({ isAxiosError: true, response: { status, data } });

test('classifyImportFailure: بلا response ⇒ network، والإلغاء والخطأ البرمجي ليسا انقطاعاً', () => {
  assert.deepEqual(classifyImportFailure({ isAxiosError: true, code: 'ERR_NETWORK', request: {} }), { type: 'network' });
  assert.deepEqual(classifyImportFailure({ code: 'ECONNABORTED' }), { type: 'network' });
  assert.equal(classifyImportFailure({ isAxiosError: true, code: 'ERR_CANCELED' }).type, 'other');
  assert.equal(classifyImportFailure(new TypeError('x')).type, 'other');
  assert.deepEqual(classifyImportFailure(httpErr(500, { message: 'خطأ' })), { type: 'other', status: 500, message: 'خطأ' });
});

test('classifyImportFailure: التكرار الجاري لا يُعرض كتكرار منتهٍ، والاستيراد الجاري والتداخل', () => {
  const at = '2026-09-17T08:00:00.000Z';
  assert.deepEqual(
    classifyImportFailure(httpErr(409, { success: false, code: 'IMPORT_DUPLICATE_BATCH', message: 'm', batchId: 'b1', createdAt: at, running: true })),
    { type: 'duplicate', batchId: 'b1', createdAt: at, running: true },
  );
  assert.equal((classifyImportFailure(httpErr(409, { code: 'IMPORT_DUPLICATE_BATCH', batchId: 'b1', createdAt: at })) as { running: boolean }).running, false);
  assert.equal((classifyImportFailure(httpErr(409, { code: 'IMPORT_DUPLICATE_BATCH', details: { batchId: 'b2', running: true } })) as { batchId: string }).batchId, 'b2');
  assert.deepEqual(
    classifyImportFailure(httpErr(409, { code: 'IMPORT_IN_PROGRESS', batchId: 'b3', kind: 'ledger', createdAt: at })),
    { type: 'inProgress', batchId: 'b3', kind: 'ledger', createdAt: at },
  );
  assert.deepEqual(classifyImportFailure(httpErr(409, { code: 'IMPORT_OVERLAP_CONFIRM', warnings: { overlap: [{ customerId: 'c' }] } })), { type: 'overlap', overlap: [{ customerId: 'c' }] });
  assert.deepEqual(classifyImportFailure(httpErr(400, { code: 'UNDATED_ROWS_LEDGER_ACTIVE', count: 3 })), { type: 'undated' });
});

test('classifyImportFailure: IMPORT_INVALID_DATE بالأسطر أو بتاريخ الصفوف بلا تاريخ', () => {
  assert.deepEqual(
    classifyImportFailure(httpErr(400, { code: 'IMPORT_INVALID_DATE', rows: [{ row: 4, date: '2026-02-31' }, { bad: 1 }] })),
    { type: 'invalidDate', rows: [{ row: 4, date: '2026-02-31' }], undatedDate: undefined },
  );
  assert.deepEqual(
    classifyImportFailure(httpErr(400, { code: 'IMPORT_INVALID_DATE', undatedDate: '2026-02-31' })),
    { type: 'invalidDate', rows: [], undatedDate: '2026-02-31' },
  );
  assert.deepEqual(classifyImportFailure(httpErr(400, { code: 'IMPORT_INVALID_DATE', date: 'x' })), { type: 'invalidDate', rows: [{ row: 0, date: 'x' }], undatedDate: undefined });
});

test('classifyImportFailure: رموز المخزون الافتتاحي', () => {
  assert.deepEqual(classifyImportFailure(httpErr(409, { code: 'OPENING_STOCK_LEDGER_ACTIVE', activatedAt: 'x' })), { type: 'openingStockActive' });
  assert.deepEqual(classifyImportFailure(httpErr(409, { code: 'OPENING_STOCK_REVERT_LEDGER_ACTIVE', activatedAt: 'x' })), { type: 'openingStockActive' });
  assert.deepEqual(
    classifyImportFailure(httpErr(409, {
      code: 'OPENING_STOCK_AFTER_CUTOVER', cutoverDate: '2026-09-01', today: '2026-09-17', timezone: 'Asia/Riyadh', minCutoverDate: '2026-09-18', field: 'acknowledgeCutoverChange',
    })),
    { type: 'openingStockAfterCutover', cutoverDate: '2026-09-01', today: '2026-09-17', minCutoverDate: '2026-09-18', timezone: 'Asia/Riyadh' },
  );
  // خادم بلا minCutoverDate ⇒ اليوم التالي لـtoday
  assert.equal((classifyImportFailure(httpErr(409, { code: 'OPENING_STOCK_AFTER_CUTOVER', today: '2026-12-31' })) as { minCutoverDate?: string }).minCutoverDate, '2027-01-01');
  assert.equal((classifyImportFailure(httpErr(409, { code: 'OPENING_STOCK_AFTER_CUTOVER' })) as { minCutoverDate?: string }).minCutoverDate, undefined);
  assert.deepEqual(classifyImportFailure(httpErr(409, { code: 'OPENING_STOCK_FULL_HISTORY', method: 'FULL_HISTORY' })), { type: 'openingStockFullHistory' });
  assert.deepEqual(classifyImportFailure(httpErr(409, { code: 'OPENING_STOCK_LEDGER_BUSY' })), { type: 'ledgerBusy' });
  assert.deepEqual(classifyImportFailure(httpErr(403, { code: 'WAREHOUSE_NOT_ENABLED' })), { type: 'warehouseDisabled' });
});

test('classifyImportFailure: قفل الدفاتر وتغيّر حالتها والدفعة الجارية', () => {
  assert.deepEqual(classifyImportFailure(httpErr(409, { code: 'IMPORT_LEDGER_BUSY' })), { type: 'ledgerBusy' });
  assert.deepEqual(classifyImportFailure(httpErr(409, { code: 'IMPORT_REVERT_LEDGER_BUSY' })), { type: 'ledgerBusy' });
  assert.deepEqual(classifyImportFailure(httpErr(409, { code: 'IMPORT_LEDGER_STATE_CHANGED', activatedAt: '2026-09-17T08:00:00.000Z' })), { type: 'ledgerStateChanged' });
  assert.deepEqual(classifyImportFailure(httpErr(409, { code: 'IMPORT_BATCH_RUNNING', batchId: 'b9' })), { type: 'batchRunning', batchId: 'b9' });
});

test('كل رمز يرده مسار الاستيراد مصنَّف (لا يسقط إلى other)', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), '..', 'backend', 'src', p), 'utf8');
  const src = read('routes/import.ts') + read('services/importLedger.ts');
  const codes = new Set<string>();
  for (const m of src.matchAll(/ImportHttpError\(\s*\d{3},\s*'([A-Z_]+)'/g)) codes.add(m[1]);
  for (const m of src.matchAll(/code: '([A-Z_]+)'/g)) codes.add(m[1]);
  assert.ok(codes.has('OPENING_STOCK_FULL_HISTORY') && codes.has('IMPORT_LEDGER_STATE_CHANGED') && codes.has('IMPORT_REVERT_LEDGER_BUSY'), [...codes].join(','));
  const unclassified = [...codes].filter((code) => classifyImportFailure(httpErr(409, { code })).type === 'other');
  assert.deepEqual(unclassified, []);
});

test('openingStockGate: مخفية بلا مستودع، ومحجوبة بعد التفعيل وفي التاريخ الكامل، وإقرار حين تاريخ البدء ≤ اليوم بتوقيت الشركة', () => {
  // 2026-09-16T21:30Z = 17 سبتمبر 00:30 بالرياض، وما زال 16 سبتمبر في UTC
  const now = new Date('2026-09-16T21:30:00Z');
  assert.equal(todayInZone(now, 'Asia/Riyadh'), '2026-09-17');
  assert.equal(todayInZone(now, 'Not/AZone'), '2026-09-17');
  const ctx = (o: Partial<{ activated: boolean; cutoverDate: string | null; timezone: string; method: string | null }>) =>
    ({ activated: false, cutoverDate: null, timezone: 'Asia/Riyadh', method: 'OPENING', ...o });

  assert.deepEqual(openingStockGate({ warehouseEnabled: false, ctx: null, serverBlock: null, now }), { state: 'hidden' });
  assert.deepEqual(openingStockGate({ warehouseEnabled: true, ctx: null, serverBlock: null, now }), { state: 'open' });
  assert.deepEqual(openingStockGate({ warehouseEnabled: true, ctx: ctx({ activated: true, cutoverDate: '2026-01-01' }), serverBlock: null, now }),
    { state: 'blocked', reason: 'active', cutoverDate: '2026-01-01' });
  // تاريخ بدء اليوم أو قبله ⇒ إقرار، وأقرب تاريخ بدء الغد بتوقيت الشركة
  assert.deepEqual(openingStockGate({ warehouseEnabled: true, ctx: ctx({ cutoverDate: '2026-09-17' }), serverBlock: null, now }),
    { state: 'ack', cutoverDate: '2026-09-17', minCutoverDate: '2026-09-18' });
  assert.deepEqual(openingStockGate({ warehouseEnabled: true, ctx: ctx({ cutoverDate: '2026-09-01' }), serverBlock: null, now }),
    { state: 'ack', cutoverDate: '2026-09-01', minCutoverDate: '2026-09-18' });
  assert.deepEqual(openingStockGate({ warehouseEnabled: true, ctx: ctx({ cutoverDate: '2026-09-17', timezone: 'UTC' }), serverBlock: null, now }), { state: 'open' });
  assert.deepEqual(openingStockGate({ warehouseEnabled: true, ctx: ctx({ cutoverDate: '2026-10-01' }), serverBlock: null, now }), { state: 'open' });
  // التاريخ الكامل في المسودة ⇒ محجوبة (الخادم 409 OPENING_STOCK_FULL_HISTORY) برسالة tr
  const fh = openingStockGate({ warehouseEnabled: true, ctx: ctx({ cutoverDate: '2024-01-01', method: 'FULL_HISTORY' }), serverBlock: null, now });
  assert.deepEqual(fh, { state: 'blocked', reason: 'fullHistory', cutoverDate: '2024-01-01' });
  assert.equal(openingStockNoteKey(fh), OPENING_STOCK_FULL_HISTORY_NOTE);
  assert.deepEqual(openingStockGate({ warehouseEnabled: true, ctx: null, serverBlock: { reason: 'fullHistory' }, now }),
    { state: 'blocked', reason: 'fullHistory', cutoverDate: null });
  // رفض الخادم يغلب سياقاً غائباً، وminCutoverDate من الخادم
  assert.deepEqual(openingStockGate({ warehouseEnabled: true, ctx: null, serverBlock: { reason: 'afterCutover', cutoverDate: '2026-09-01', minCutoverDate: '2026-09-18' }, now }),
    { state: 'ack', cutoverDate: '2026-09-01', minCutoverDate: '2026-09-18' });
  assert.deepEqual(openingStockGate({ warehouseEnabled: true, ctx: null, serverBlock: { reason: 'afterCutover', cutoverDate: '2026-09-01' }, now }),
    { state: 'ack', cutoverDate: '2026-09-01', minCutoverDate: '2026-09-18' });
  assert.deepEqual(openingStockGate({ warehouseEnabled: true, ctx: null, serverBlock: { reason: 'active' }, now }),
    { state: 'blocked', reason: 'active', cutoverDate: null });
});

test('نصوص بطاقة المخزون الافتتاحي تطابق الشرط الفعلي، والإقرار يُرسل عند طلبه فقط', () => {
  assert.equal(openingStockNoteKey({ state: 'hidden' }), null);
  assert.equal(openingStockNoteKey({ state: 'open' }), OPENING_STOCK_OPEN_NOTE);
  assert.equal(openingStockNoteKey({ state: 'blocked', reason: 'active', cutoverDate: null }), OPENING_STOCK_ACTIVE_NOTE);
  assert.equal(openingStockNoteKey({ state: 'ack', cutoverDate: '2026-09-01', minCutoverDate: '2026-09-18' }), OPENING_STOCK_AFTER_CUTOVER_NOTE);
  // لا وعد بالدخول «عند التفعيل» مطلقاً: الدخول مشروط بتاريخ بدء بعد يوم الاستيراد
  assert.doesNotMatch(OPENING_STOCK_OPEN_NOTE, /وتدخل قيمتها القيد الافتتاحي عند تفعيل/);
  assert.match(OPENING_STOCK_OPEN_NOTE, /إلا إذا كان تاريخ البدء بعد يوم الاستيراد/);
  assert.match(OPENING_STOCK_AFTER_CUTOVER_NOTE, /في يوم لاحق/);

  const ack = { state: 'ack', cutoverDate: '2026-09-01', minCutoverDate: '2026-09-18' } as const;
  assert.deepEqual(openingStockAckState(ack, false), { required: true, blocksImport: true, body: {} });
  assert.deepEqual(openingStockAckState(ack, true), { required: true, blocksImport: false, body: { acknowledgeCutoverChange: true } });
  assert.deepEqual(openingStockAckState({ state: 'open' }, true), { required: false, blocksImport: false, body: {} });
});

// ============ مواءمة الويب مع عقد الخادم ============
test('fileRows: أخطاء الخادم (موضع الصف المرسل + 2) تُحوَّل إلى صف الملف بعد حذف الصفوف الصفرية والخاطئة', () => {
  const r = IMPORT_TYPES.opening_stock.transform([
    { 'كود الصنف': 'A', 'الكمية': '0', 'تكلفة الوحدة': '5' },      // صف 2: كمية صفر ⇒ يُحذف بصمت
    { 'كود الصنف': 'MISSING', 'الكمية': '3', 'تكلفة الوحدة': '5' }, // صف 3: أول مرسل ⇒ الخادم row=2
    { 'الكمية': '3', 'تكلفة الوحدة': '5' },                         // صف 4: خطأ محلي
    { 'كود الصنف': 'C', 'الكمية': '1', 'تكلفة الوحدة': '2' },      // صف 5: ثاني مرسل ⇒ الخادم row=3
  ]);
  assert.equal(r.valid.length, 2);
  assert.deepEqual(r.fileRows, [3, 5]);
  assert.equal(fileRowOf(r.fileRows, 2), 3);
  assert.equal(fileRowOf(r.fileRows, 3), 5);
  assert.equal(fileRowOf(r.fileRows, 0), 0);     // تاريخ عام بلا صف
  assert.equal(fileRowOf(r.fileRows, 9), 9);     // خارج النطاق يبقى
  assert.equal(fileRowOf(undefined, 4), 4);
  const b = IMPORT_TYPES.balances.transform([
    { 'الاسم': 'x', 'الرصيد': '0' }, { 'الاسم': 'y', 'الرصيد': '10' },
  ]);
  assert.deepEqual(b.fileRows, [3]);
  for (const k of Object.keys(IMPORT_TYPES) as (keyof typeof IMPORT_TYPES)[]) {
    const t = IMPORT_TYPES[k].transform([{ 'الاسم': 'n', 'كود الصنف': 'p', 'السعر': '1', 'الرصيد': '1', 'المدين': '1', 'الكمية': '1', 'تكلفة الوحدة': '1' }]);
    assert.equal(t.fileRows.length, t.valid.length, k);
  }
});

test('importContextTimezone: قبل التفعيل منطقة المسودة مقدَّمة على الإعدادات (كما importTimezone)، وبعده الإعدادات', () => {
  assert.equal(importContextTimezone(false, 'Asia/Riyadh', 'Asia/Tokyo'), 'Asia/Tokyo');
  assert.equal(importContextTimezone(false, 'Asia/Riyadh', undefined), 'Asia/Riyadh');
  assert.equal(importContextTimezone(true, 'Asia/Dubai', 'Asia/Tokyo'), 'Asia/Dubai');
  assert.equal(importContextTimezone(false, null, null), 'Asia/Riyadh');
  // اليوم وأقرب تاريخ بدء بمنطقة طوكيو: 2026-09-17 20:00 UTC هو 18 في طوكيو و17 في الرياض
  const now = new Date('2026-09-17T20:00:00Z');
  assert.equal(todayInZone(now, importContextTimezone(false, 'Asia/Riyadh', 'Asia/Tokyo')), '2026-09-18');
});

test('localizedServerMessage وlistSeparator: رسالة الخادم العربية لا تُعرض في واجهة غير عربية بلا ترجمة', () => {
  const tr = (s: string) => (s === 'مترجمة' ? 'Translated' : s);
  assert.equal(localizedServerMessage('خطأ عام', 'ar', tr), 'خطأ عام');
  assert.equal(localizedServerMessage('خطأ عام', 'en', tr), null);
  assert.equal(localizedServerMessage('مترجمة', 'fr', tr), 'Translated');
  assert.equal(localizedServerMessage(undefined, 'ar', tr), null);
  assert.equal(listSeparator('ar'), '، ');
  assert.equal(listSeparator('en'), ', ');
});
