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
  NUMERIC_ERROR, TAX_FRACTION_NOTICE, ZERO_BALANCE_NOTICE, DUPLICATE_CUSTOMERS_NOTICE, TOTALS_ROWS_NOTICE,
  BALANCE_DC_CONFLICT_BLOCKER, AMBIGUOUS_COLUMN_BLOCKER, PARTIAL_NO_PAID_COLUMN, DRAFT_ROWS_NOTICE, CANCELLED_ROWS_NOTICE,
  UNKNOWN_STATUS_NOTICE, NEGATIVE_PRICE, NEGATIVE_CREDIT_LIMIT, PAYMENT_DAYS_INVALID, PAID_OUT_OF_RANGE, NO_CUSTOMER_ROWS_NOTICE,
  resolveColumns, type ImportNotice,
  AMBIGUOUS_AMOUNT_ERROR, BALANCE_SIDE_INVALID, BALANCE_SIDE_UNRESOLVED_BLOCKER, BALANCE_DC_IGNORED_NOTICE, BALANCE_DC_MISMATCH_NOTICE,
  LEDGER_NO_AMOUNT_COLUMN_BLOCKER, CUSTOMER_OPTIONAL_IGNORED_NOTICE, isTotalsName, BALANCE_FROM_DC_NOTICE,
  LEDGER_OPENING_ROW_NOTICE, LEDGER_CARRIED_BALANCE_NOTICE, LEDGER_BALANCE_ONLY_ROW, OPENING_ROW_LABELS,
  LEDGER_CLOSING_ROW_NOTICE, LEDGER_BALANCE_ONLY_NOTICE, CARRIED_ROW_LABELS, TRUE_OPENING_ROW_LABELS,
  LEDGER_NO_AMOUNT_ROW_NOTICE, CLOSING_ROW_LABELS,
  PRODUCT_DUPLICATE_ROWS_NOTICE, PRODUCT_SAME_NAME_NO_CODE, PRODUCT_DUPLICATE_CODE,
  PRODUCT_BLANK_TAX_DUPLICATE_NOTICE, PRODUCT_DEFAULT_UNIT, PRODUCT_DEFAULT_PRICE,
} from './importData';
import { importResultView, importRowErrorKey, customerSkipReasonKey, classifyRevertFailure, CUSTOMER_CODE_NOT_FOUND_MESSAGE } from './importRevert';

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
  // التقريب لأقرب ثانية (البند 29): 23:59:50 و23:59:30 و23:59:59 من 31 ديسمبر تبقى 31 ديسمبر
  for (const [h, m, s] of [[23, 59, 50], [23, 59, 30], [23, 59, 59]]) {
    const r2 = bal([{ 'الاسم': 'أ', 'الرصيد': 100, 'التاريخ': new Date(2025, 11, 31, h, m, s) }]);
    assert.equal(r2.valid[0].date, '2025-12-31', `${h}:${m}:${s}`);
  }
  // انزياح SheetJS الفعلي −1ms من منتصف الليل ⇒ اليوم نفسه
  const r3 = bal([{ 'الاسم': 'أ', 'الرصيد': 100, 'التاريخ': new Date(new Date(2026, 0, 1).getTime() - 1) }]);
  assert.equal(r3.valid[0].date, '2026-01-01');
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

const backendSrc = (p: string) => fs.readFileSync(path.resolve(process.cwd(), '..', 'backend', 'src', p), 'utf8');
/** مفاتيح PHRASES في strings.ts نصاً (بلا استيراد الوحدة ومتجر اللغة) */
const phraseKeys = (): Set<string> => {
  const src = fs.readFileSync(path.resolve(process.cwd(), 'src', 'i18n', 'strings.ts'), 'utf8');
  return new Set([...src.matchAll(/^\s*'([^'\n]+)'\s*:\s*\{/gm)].map((m) => m[1]));
};
/** أعضاء نوع اتحاد نصي مصدَّر: export type Name = 'A' | 'B' */
const unionMembers = (src: string, name: string): string[] => {
  const m = src.match(new RegExp(`export type ${name}\\s*=([^;]+);`));
  assert.ok(m, `النوع ${name} غير موجود`);
  return [...m![1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
};
/** رموز أخطاء الصفوف (errors[].code) ليست ردوداً فاشلة، وتُعرض في نافذة النتيجة */
const ROW_CODES = new Set(['CUSTOMER_NOT_FOUND', 'CUSTOMER_AMBIGUOUS', 'CUSTOMER_CODE_NOT_FOUND', 'CUSTOMER_CODE_UNREGISTERED', 'PRODUCT_NOT_FOUND', 'ZERO_PRICE', 'TAX_PCT_FRACTION', 'ROW_CONFLICT', 'ROW_WRITE_FAILED',
  // الدفعة 2: رموز صفوف المخزون الافتتاحي والمنتجات (البنود 15 و16 و24 و30)
  'PRODUCT_INACTIVE', 'PRODUCT_AMBIGUOUS', 'OPENING_STOCK_ALREADY_IMPORTED', 'PRODUCT_HAS_STOCK_MOVEMENTS',
  'STOCK_QTY_INVALID', 'STOCK_COST_INVALID', 'STOCK_NET_COST_ZERO', 'PRODUCT_CODE_ARCHIVED', 'PRODUCT_DUPLICATE_IN_FILE']);
/** رموز مسار التراجع وحده: تُصنَّف في classifyRevertFailure لا classifyImportFailure (وتُتحقَّق هناك) */
const REVERT_ONLY_CODES = new Set(['IMPORT_BATCH_GONE']);

test('كل رمز يرده مسار الاستيراد مصنَّف (لا يسقط إلى other)', () => {
  const src = backendSrc('routes/import.ts') + backendSrc('services/importLedger.ts') + backendSrc('services/importAccess.ts');
  const codes = new Set<string>();
  for (const m of src.matchAll(/ImportHttpError\(\s*\d{3},\s*'([A-Z_]+)'/g)) codes.add(m[1]);
  for (const m of src.matchAll(/code: '([A-Z_]+)'/g)) codes.add(m[1]);
  // رموز الصفوف: importRowError(row, 'CODE') حرفياً، وأعضاء ImportRowErrorCode (المُمرَّرة بمتغيّر كـ taxIssue)
  for (const m of src.matchAll(/importRowError\(\s*[^,()]+,\s*'([A-Z_]+)'/g)) codes.add(m[1]);
  const rowUnion = unionMembers(backendSrc('services/importLedger.ts'), 'ImportRowErrorCode');
  for (const c of rowUnion) codes.add(c);
  assert.ok(codes.has('OPENING_STOCK_FULL_HISTORY') && codes.has('IMPORT_LEDGER_STATE_CHANGED') && codes.has('IMPORT_REVERT_LEDGER_BUSY'), [...codes].join(','));
  assert.ok(codes.has('IMPORT_SCOPED_ADMIN') && codes.has('IMPORT_PERMISSION_DENIED') && codes.has('ACCOUNTING_NOT_ALLOWED'), [...codes].join(','));
  assert.ok(codes.has('CUSTOMER_CODE_NOT_FOUND') && codes.has('TAX_PCT_FRACTION'), [...codes].join(','));
  // رمز صف جديد في الخادم لا يمر صامتاً: يُضاف إلى ROW_CODES ويُصنَّف في importResultView
  assert.deepEqual(rowUnion.filter((c) => !ROW_CODES.has(c)), []);
  const unclassified = [...codes].filter((code) => !ROW_CODES.has(code) && !REVERT_ONLY_CODES.has(code)
    && classifyImportFailure(httpErr(409, { code })).type === 'other');
  assert.deepEqual(unclassified, []);
  // رموز التراجع وحدها لا تسقط هي الأخرى: مصنَّفة في classifyRevertFailure
  for (const code of REVERT_ONLY_CODES) {
    assert.ok(codes.has(code), `رمز التراجع ${code} لم يعد في الخادم، احذفه من REVERT_ONLY_CODES`);
    assert.notEqual(classifyRevertFailure(httpErr(404, { code })).type, 'other', code);
  }
});

test('رموز الصفوف: رسائلها مترجمة، ورموز مطابقة العميل في خانتها لا «خطأ»', () => {
  const ledger = backendSrc('services/importLedger.ts');
  const keys = phraseKeys();
  const block = ledger.match(/export const IMPORT_ROW_MESSAGES[^{]*\{([\s\S]*?)\r?\n\};/);
  assert.ok(block, 'IMPORT_ROW_MESSAGES غير موجود');
  const messages = new Map([...block![1].matchAll(/^\s*([A-Z_]+):\s*'([^'\n]+)'/gm)].map((m) => [m[1], m[2]]));
  for (const code of unionMembers(ledger, 'ImportRowErrorCode')) {
    if (code === 'ROW_WRITE_FAILED') continue; // رسالة الخطأ الخام
    const message = messages.get(code);
    assert.ok(message, `لا رسالة للرمز ${code}`);
    const key = importRowErrorKey({ code, message: message! });
    assert.ok(keys.has(key), `رسالة ${code} بلا ترجمة: ${key}`);
    if (code.startsWith('CUSTOMER_')) {
      const v = importResultView({ created: 1, errors: [{ row: 2, code, message: message! }] });
      assert.equal(v.counts.otherErrors, 0, `${code} سقط إلى otherErrors`);
    }
  }
  assert.equal(importRowErrorKey({ code: 'CUSTOMER_CODE_NOT_FOUND', message: messages.get('CUSTOMER_CODE_NOT_FOUND')! }), CUSTOMER_CODE_NOT_FOUND_MESSAGE);
  assert.equal(importResultView({ created: 1, errors: [{ row: 2, code: 'CUSTOMER_CODE_NOT_FOUND', message: 'm', value: '1001' }] }).counts.notFound, 1);
});

test('أسباب التخطي في importMatch وimportLedger معروفة ومترجمة', () => {
  const keys = phraseKeys();
  const match = backendSrc('services/importMatch.ts');
  const customerReasons = new Set(unionMembers(match, 'CustomerSkipReason'));
  for (const m of match.matchAll(/reason: '([A-Z_]+)'/g)) customerReasons.add(m[1]);
  assert.ok(customerReasons.has('CODE_ATTACHABLE'), [...customerReasons].join(','));
  const fallback = customerSkipReasonKey(undefined);
  for (const r of customerReasons) {
    const key = customerSkipReasonKey(r);
    assert.notEqual(key, fallback, `سبب تخطي العملاء ${r} غير معروف في customerSkipReasonKey`);
    assert.ok(keys.has(key), `سبب ${r} بلا ترجمة: ${key}`);
  }
  // أسباب تخطي الأرصدة تُرسل نصاً (BALANCE_SKIP_MESSAGES) وتمر عبر tr
  const ledger = backendSrc('services/importLedger.ts');
  const block = ledger.match(/export const BALANCE_SKIP_MESSAGES[^{]*\{([\s\S]*?)\r?\n\};/);
  assert.ok(block, 'BALANCE_SKIP_MESSAGES غير موجود');
  const messages = new Map([...block![1].matchAll(/^\s*([A-Z_]+):\s*'([^'\n]+)'/gm)].map((m) => [m[1], m[2]]));
  for (const r of unionMembers(ledger, 'BalanceSkipReason')) {
    assert.ok(messages.has(r), `لا رسالة لسبب ${r}`);
    assert.ok(keys.has(messages.get(r)!), `سبب ${r} بلا ترجمة`);
  }
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

// ═══ دفعة الإصلاحات 1 (مراجعة 2026-09-17) ═══
const cust = IMPORT_TYPES.customers.transform;
const prod = IMPORT_TYPES.products.transform;
const prc = IMPORT_TYPES.prices.transform;
const notice = (ns: ImportNotice[] | undefined, key: string) => ns?.find((n) => n.key === key);

test('البند 1: المبالغ النصية لا تصير صفراً ولا تنقلب إشارتها، وغير المفهوم خطأ صف بقيمته', () => {
  const b = bal([
    { 'الاسم': 'أ', 'الرصيد': '١٥٠٠' },
    { 'الاسم': 'ب', 'الرصيد': '(1,500.00)' },
    { 'الاسم': 'ج', 'الرصيد': '1500 دائن' },
    { 'الاسم': 'د', 'الرصيد': '500-' },
    { 'الاسم': 'هـ', 'الرصيد': 'N/A' },
    { 'الاسم': 'و', 'الرصيد': '1٬500٫50' },
  ]);
  assert.deepEqual(b.valid.map((v) => v.balance), [1500, -1500, -1500, -500, 1500.5]);
  assert.deepEqual(b.errors.map((e) => [e.row, e.message, e.value, e.field]), [[6, NUMERIC_ERROR, 'N/A', 'balance']]);
  assert.deepEqual(b.fileRows, [2, 3, 4, 5, 7]);

  const p = prod([
    { 'اسم الصنف': 'ماء', 'سعر البيع': 'ر.س 12', 'الضريبة': '15' },
    { 'اسم الصنف': 'عصير', 'سعر البيع': '12,5' },
    { 'اسم الصنف': 'خبز', 'سعر البيع': 'مجاني' },
    { 'اسم الصنف': 'حليب', 'سعر البيع': '-3' },
  ]);
  assert.deepEqual(p.valid.map((v) => [v.name, v.basePrice, v.taxPct]), [['ماء', 12, 15], ['عصير', 12.5, undefined]]);
  assert.deepEqual(p.errors.map((e) => [e.row, e.message]), [[4, NUMERIC_ERROR], [5, NEGATIVE_PRICE]]);

  const pr = prc([
    { 'كود العميل': 'C1', 'كود الصنف': 'P1', 'السعر الخاص': '0' },
    { 'كود العميل': 'C1', 'كود الصنف': 'P2', 'السعر الخاص': 'N/A' },
    { 'كود العميل': 'C1', 'كود الصنف': 'P3', 'السعر الخاص': '(5)' },
    { 'كود العميل': 'C1', 'كود الصنف': 'P4', 'السعر الخاص': '٧' },
  ]);
  assert.deepEqual(pr.valid.map((v) => v.price), [0, 7]);
  assert.equal(pr.zeroPriceRows, 1);
  assert.deepEqual(pr.errors.map((e) => [e.row, e.message]), [[3, NUMERIC_ERROR], [4, NEGATIVE_PRICE]]);

  const c = cust([
    { 'الاسم': 'أ', 'حد الائتمان': '5,000', 'فترة السداد': '30' },
    { 'الاسم': 'ب', 'حد الائتمان': '-1' },
    { 'الاسم': 'ج', 'حد الائتمان': 'كبير' },
    { 'الاسم': 'د', 'فترة السداد': '7.5' },
  ]);
  // «كبير» حقل ثانوي غير رقمي: العميل يُنشأ بالافتراضي وتنبيه (البند 1 مراجعة ثانية)، والسالب وكسر الأيام خطأ صف
  assert.deepEqual(c.valid.map((v) => [v.name, v.creditLimit, v.paymentDays]), [['أ', 5000, 30], ['ج', undefined, undefined]]);
  assert.deepEqual(c.errors.map((e) => e.message), [NEGATIVE_CREDIT_LIMIT, PAYMENT_DAYS_INVALID]);

  // الكشوف: مدين سالب ينتقل دائناً والعكس
  const l = led([{ 'الاسم': 'أ', 'مدين': '-200', 'دائن': '' }, { 'الاسم': 'ب', 'مدين': '', 'دائن': '(50)' }]);
  assert.deepEqual(l.valid.map((v) => [v.debit, v.credit]), [[0, 200], [50, 0]]);

  // المخزون: الكمية غير المفهومة خطأ لا تجاهل صامت
  const s = stock([{ 'كود الصنف': 'A', 'الكمية': 'كثير', 'التكلفة': 1 }, { 'كود الصنف': 'B', 'الكمية': '١٢', 'التكلفة': '٢٫٥' }]);
  assert.deepEqual(s.valid, [{ productCode: 'B', qty: 12, unitCost: 2.5 }]);
  assert.deepEqual(s.errors.map((e) => [e.row, e.message, e.value]), [[2, NUMERIC_ERROR, 'كثير']]);
});

test('البند 1: الأرصدة الصفرية أو الفارغة تُتجاهل بتنبيه معدود', () => {
  const b = bal([{ 'الاسم': 'أ', 'الرصيد': 0 }, { 'الاسم': 'ب', 'الرصيد': '' }, { 'الاسم': 'ج', 'الرصيد': 5 }]);
  assert.equal(b.valid.length, 1);
  assert.deepEqual(notice(b.notices, ZERO_BALANCE_NOTICE), { key: ZERO_BALANCE_NOTICE, count: 2 });
});

test('البند 14: ضريبة 0.15 ⇒ 15 بتنبيه، و«15%» نصاً ⇒ 15', () => {
  const p = prod([
    { 'اسم الصنف': 'أ', 'الضريبة': 0.15 },
    { 'اسم الصنف': 'ب', 'الضريبة': '15%' },
    { 'اسم الصنف': 'ج', 'الضريبة': '0.15' },
    { 'اسم الصنف': 'د', 'الضريبة': 0 },
    { 'اسم الصنف': 'هـ', 'الضريبة': 15 },
  ]);
  assert.deepEqual(p.valid.map((v) => v.taxPct), [15, 15, 15, 0, 15]);
  assert.deepEqual(notice(p.notices, TAX_FRACTION_NOTICE), { key: TAX_FRACTION_NOTICE, count: 2 });
});

test('البند 13: مطابقة الأعمدة تستثني الأعمدة الخاطئة ولا تنتقل للاحتواء حين يوجد تطابق تام', () => {
  // «اسم المحل، رصيد العميل» ⇒ الاسم ليس 1500
  const a = cust([{ 'اسم المحل': 'بقالة النور', 'رصيد العميل': 1500 }]);
  assert.equal(a.valid[0].name, 'بقالة النور');
  // «رقم العميل، اسم الزبون» ⇒ الاسم ليس الكود
  const b = cust([{ 'رقم العميل': '1001', 'اسم الزبون': 'مؤسسة الفجر' }]);
  assert.deepEqual([b.valid[0].name, b.valid[0].code], ['مؤسسة الفجر', '1001']);
  // «Salesperson Name, Customer Name»
  const c = cust([{ 'Salesperson Name': 'Ali', 'Customer Name': 'Store A' }, { 'Salesperson Name': 'Ali', 'Customer Name': 'Store B' }]);
  assert.deepEqual(c.valid.map((v) => v.name), ['Store A', 'Store B']);
  // «هاتف المندوب» مع جوال فارغ ⇒ الجوال فارغ
  const d = cust([{ 'الاسم': 'أ', 'الجوال': '', 'هاتف المندوب': '0555555555' }]);
  assert.equal(d.valid[0].phone, '');
  const d2 = cust([{ 'الاسم': 'أ', 'هاتف المندوب': '0555555555' }]);
  assert.equal(d2.valid[0].phone, '');
  // «Cost Price, Sale Price» ⇒ سعر البيع
  const e = prod([{ 'Name': 'Water', 'Cost Price': 5, 'Sale Price': 8 }]);
  assert.equal(e.valid[0].basePrice, 8);
  const e2 = prod([{ 'Name': 'Water', 'Cost Price': 5, 'Selling Price': 8 }]);
  assert.equal(e2.valid[0].basePrice, 8);
  // «Barcode» مع مرجع فارغ ⇒ الكود لا يأخذ الباركود
  const f = prod([{ 'الاسم': 'ماء', 'مرجع': '', 'Barcode': '628123' }]);
  assert.equal(f.valid[0].code, 'ماء');
  assert.equal(f.valid[0].barcode, '628123');
  const f2 = prod([{ 'Product': 'Water', 'Product Barcode': '628123' }]);
  assert.equal(f2.valid[0].code, 'Water');
  // «السعر شامل الضريبة» لا يصير نسبة ضريبة
  const g = prod([{ 'الاسم': 'ماء', 'السعر شامل الضريبة': 11.5 }]);
  assert.equal(g.valid[0].taxPct, undefined);
  // خريطة الأعمدة
  assert.deepEqual(e.columns?.find((x) => x.field === 'basePrice'), { field: 'basePrice', header: 'Sale Price' });
  assert.deepEqual(e.columns?.find((x) => x.field === 'unit'), { field: 'unit', header: null });
});

test('البند 13: عمودان رقميان بالاحتواء بلا تطابق تام ⇒ مانع بالرؤوس، والرؤوس اتحاد أول 50 صفاً', () => {
  const p = prod([{ 'الاسم': 'ماء', 'Retail Price': 3, 'Wholesale Price': 2 }]);
  assert.deepEqual(p.blockers, [AMBIGUOUS_COLUMN_BLOCKER]);
  assert.deepEqual(notice(p.notices, AMBIGUOUS_COLUMN_BLOCKER)?.values, ['Retail Price', 'Wholesale Price']);
  // التطابق التام الفارغ لا يسقط إلى الاحتواء
  const r = resolveColumns(['الاسم', 'اسم المندوب'], { name: { aliases: ['الاسم'] } });
  assert.deepEqual(r.candidates.name, ['الاسم']);
  // العمود الذي يظهر في الصف الثاني فقط يُحل أيضاً
  const c = cust([{ 'الاسم': 'أ' }, { 'الاسم': 'ب', 'حد الائتمان': 100 }]);
  assert.deepEqual(c.valid.map((v) => v.creditLimit), [undefined, 100]);
});

test('البند 9: أرصدة بعمودي مدين/دائن', () => {
  // «الرصيد المدين» أولاً
  const a = bal([{ 'الاسم': 'أ', 'الرصيد المدين': 500, 'الرصيد الدائن': '' }, { 'الاسم': 'ب', 'الرصيد المدين': '', 'الرصيد الدائن': 700 }]);
  assert.deepEqual(a.valid.map((v) => [v.customerName, v.balance]), [['أ', 500], ['ب', -700]]);
  assert.deepEqual(a.blockers, []);
  // «الرصيد الدائن» أولاً
  const b = bal([{ 'الاسم': 'أ', 'الرصيد الدائن': 700, 'الرصيد المدين': '' }, { 'الاسم': 'ب', 'الرصيد الدائن': '', 'الرصيد المدين': 500 }]);
  assert.deepEqual(b.valid.map((v) => v.balance), [-700, 500]);
  // «مدين/دائن» فقط
  const c = bal([{ 'الاسم': 'أ', 'مدين': 5000, 'دائن': 1200 }]);
  assert.deepEqual(c.valid.map((v) => v.balance), [3800]);
  // «الرصيد السابق» و«الرصيد الحالي» ⇒ الحالي
  const d = bal([{ 'الاسم': 'أ', 'الرصيد السابق': 100, 'الرصيد الحالي': 250 }]);
  assert.deepEqual(d.valid.map((v) => v.balance), [250]);
  // الثلاثة معاً وعمود الرصيد تام ⇒ الرصيد بلا مانع (مراجعة ثانية)، وتعدد «رصيد» بالاحتواء ⇒ مانع
  assert.deepEqual(bal([{ 'الاسم': 'أ', 'الرصيد': 1, 'مدين': 1, 'دائن': 0 }]).blockers, []);
  assert.ok(bal([{ 'الاسم': 'أ', 'رصيد العميل': 1, 'رصيد المندوب': 2 }]).blockers?.includes(AMBIGUOUS_COLUMN_BLOCKER));
});

test('البند 10: العميل المتكرر في ملف الأرصدة يُكشف في المعاينة', () => {
  const r = bal([
    { 'الاسم': 'X', 'الرصيد': 1000 }, { 'الاسم': 'X', 'الرصيد': 2500 }, { 'الاسم': 'Y', 'الرصيد': 5 }, { 'الاسم': 'X', 'الرصيد': 700 },
  ]);
  assert.equal(r.valid.length, 4);
  assert.deepEqual(notice(r.notices, DUPLICATE_CUSTOMERS_NOTICE), { key: DUPLICATE_CUSTOMERS_NOTICE, count: 1, values: ['X'] });
  // الكود يحسم: فرعان بالاسم نفسه وكودين مختلفين ليسا تكراراً
  const b = bal([{ 'الاسم': 'النهدي', 'كود العميل': 'C1', 'الرصيد': 1 }, { 'الاسم': 'النهدي', 'كود العميل': 'C2', 'الرصيد': 1 }]);
  assert.equal(notice(b.notices, DUPLICATE_CUSTOMERS_NOTICE), undefined);
});

test('البند 11: صف «الإجمالي/Total» بلا كود ولا جوال يُستبعد بتنبيه', () => {
  const r = bal([{ 'الاسم': 'أ', 'الرصيد': 1000 }, { 'الاسم': 'ب', 'الرصيد': 2500 }, { 'الاسم': 'الإجمالي', 'الرصيد': 3500 }]);
  assert.deepEqual(r.valid.map((v) => v.customerName), ['أ', 'ب']);
  assert.deepEqual(r.fileRows, [2, 3]);
  assert.deepEqual(notice(r.notices, TOTALS_ROWS_NOTICE), { key: TOTALS_ROWS_NOTICE, count: 1, values: ['الإجمالي'] });
  const c = cust([{ 'الاسم': 'أ' }, { 'الاسم': 'Grand Total' }, { 'الاسم': 'المجموع الكلي' }]);
  assert.deepEqual(c.valid.map((v) => v.name), ['أ']);
  assert.equal(notice(c.notices, TOTALS_ROWS_NOTICE)?.count, 2);
  // بكود ⇒ عميل حقيقي اسمه «الإجمالي»
  assert.equal(cust([{ 'الاسم': 'الإجمالي', 'كود العميل': 'C9' }]).valid.length, 1);
  assert.equal(led([{ 'الاسم': 'Total', 'مدين': 9 }]).valid.length, 0);
  assert.equal(prc([{ 'الاسم': 'Subtotal', 'كود الصنف': 'P', 'السعر': 1 }]).valid.length, 0);
});

test('البند 2: حالة الدفع في ملف الفواتير', () => {
  const r = led([
    { 'الاسم': 'أ', 'المبلغ': 1000, 'الحالة': 'غير مدفوعة' },
    { 'الاسم': 'ب', 'المبلغ': 1000, 'الحالة': 'Not Paid' },
    { 'الاسم': 'ج', 'المبلغ': 1000, 'الحالة': 'unpaid' },
    { 'الاسم': 'د', 'المبلغ': 1000, 'الحالة': 'مدفوعة' },
    { 'الاسم': 'هـ', 'المبلغ': 1000, 'الحالة': 'مسودة' },
    { 'الاسم': 'و', 'المبلغ': 1000, 'الحالة': 'ملغاة' },
    { 'الاسم': 'ز', 'المبلغ': 1000, 'الحالة': 'Partially Paid' },
    { 'الاسم': 'ح', 'المبلغ': 1000, 'الحالة': 'بانتظار المبلغ' },
    { 'الاسم': 'ط', 'المبلغ': -300, 'الحالة': 'paid' },
    { 'الاسم': 'ي', 'المبلغ': -300, 'الحالة': '' },
  ]);
  assert.deepEqual(r.valid.map((v) => [v.customerName, v.debit, v.credit]), [
    ['أ', 1000, 0], ['ب', 1000, 0], ['ج', 1000, 0], ['د', 1000, 1000], ['ح', 1000, 0], ['ط', 300, 300], ['ي', 0, 300],
  ]);
  assert.deepEqual(r.errors.map((e) => [e.row, e.message, e.value]), [[8, PARTIAL_NO_PAID_COLUMN, 'Partially Paid']]);
  assert.equal(notice(r.notices, DRAFT_ROWS_NOTICE)?.count, 1);
  assert.equal(notice(r.notices, CANCELLED_ROWS_NOTICE)?.count, 1);
  assert.deepEqual(notice(r.notices, UNKNOWN_STATUS_NOTICE)?.values, ['بانتظار المبلغ']);

  // جزئي بعمود «المدفوع»
  const p = led([
    { 'الاسم': 'أ', 'المبلغ': 1000, 'المدفوع': 300, 'الحالة': 'Partially Paid' },
    { 'الاسم': 'ب', 'المبلغ': 1000, 'المدفوع': 1300, 'الحالة': 'Partially Paid' },
  ]);
  assert.deepEqual(p.valid.map((v) => [v.debit, v.credit]), [[1000, 300]]);
  assert.deepEqual(p.errors.map((e) => [e.row, e.message]), [[3, PAID_OUT_OF_RANGE]]);
  // عمود «المتبقي» (أودو Amount Due)
  const q = led([{ 'Customer': 'A', 'Total': 1000, 'Amount Due': 400, 'Payment Status': 'partial', 'Status': 'posted' }]);
  assert.deepEqual(q.valid.map((v) => [v.debit, v.credit]), [[1000, 600]]);
  // أودو: Status=cancel يغلب Payment Status=not_paid
  const o = led([{ 'Customer': 'A', 'Total': 1000, 'Payment Status': 'not_paid', 'Status': 'cancel' }]);
  assert.equal(o.valid.length, 0);
});

test('البند 12 (التحويل): «مدين/دائن» الحركة لا الرصيد', () => {
  const l = led([{ 'العميل': 'أ', 'الحركة مدين': 100, 'الحركة دائن': 200, 'الرصيد مدين': 5000, 'الرصيد دائن': 0 }]);
  assert.deepEqual(l.valid.map((v) => [v.debit, v.credit]), [[100, 200]]);
  assert.deepEqual(l.blockers, []);
  // بلا تمييز: مدينان بالاحتواء ⇒ مانع
  assert.ok(led([{ 'العميل': 'أ', 'مدين أول': 1, 'مدين ثان': 2 }]).blockers?.includes(AMBIGUOUS_COLUMN_BLOCKER));
});

test('البند 3 (الويب): الجوال يُرسل كما هو بلا تطبيع', () => {
  const c = cust([{ 'الاسم': 'أ', 'الجوال': '+966 50-123 4567' }, { 'الاسم': 'ب', 'الجوال': '0' }]);
  assert.deepEqual(c.valid.map((v) => v.phone), ['+966 50-123 4567', '0']);
});

test('البند 8 (الويب): صفوف الكشف بلا عميل تُعدّ في تنبيه لا تسقط بصمت', () => {
  const l = led([{ 'البيان': 'مصروف', 'مدين': 5 }, { 'الاسم': 'أ', 'مدين': 5 }]);
  assert.equal(l.valid.length, 1);
  assert.equal(notice(l.notices, NO_CUSTOMER_ROWS_NOTICE)?.count, 1);
});

test('classifyImportFailure: المستخدم المقيّد والصلاحية والمحاسبة', () => {
  assert.deepEqual(classifyImportFailure(httpErr(403, { success: false, code: 'IMPORT_SCOPED_ADMIN', message: 'm' })), { type: 'scopedAdmin' });
  assert.deepEqual(
    classifyImportFailure(httpErr(403, { success: false, code: 'IMPORT_PERMISSION_DENIED', message: 'm', kind: 'prices', permission: 'canManageProducts' })),
    { type: 'permissionDenied', kind: 'prices', permission: 'canManageProducts' },
  );
  assert.deepEqual(
    classifyImportFailure(httpErr(403, { code: 'IMPORT_PERMISSION_DENIED', details: { kind: 'customers', permission: null } })),
    { type: 'permissionDenied', kind: 'customers', permission: undefined },
  );
  assert.deepEqual(classifyImportFailure(httpErr(403, { code: 'ACCOUNTING_NOT_ALLOWED', message: 'm' })), { type: 'accountingDisabled' });
});

// ═══ دفعة الإصلاحات 1 — مراجعة ثانية (ما بقي مُصلحاً جزئياً) ═══
test('البند 11 (ثانية): صيغ صف المجاميع الشائعة تُستبعد في كل الأنواع، و«مجموعة النور» تبقى', () => {
  const words = ['إجمالي', 'الإجمالي:', 'Total:', 'المجموع العام', 'إجمالي الأرصدة', 'Grand Total', 'Subtotal:', 'Sub-Total'];
  for (const w of words) {
    const b = bal([{ 'العميل': 'أ', 'الرصيد': 1000 }, { 'العميل': w, 'الرصيد': 1000 }]);
    assert.deepEqual(b.valid.map((v) => v.customerName), ['أ'], `balances ${w}`);
    assert.equal(notice(b.notices, TOTALS_ROWS_NOTICE)?.count, 1, w);
    const c = cust([{ 'الاسم': 'أ' }, { 'الاسم': w }]);
    assert.deepEqual(c.valid.map((v) => v.name), ['أ'], `customers ${w}`);
    assert.equal(notice(c.notices, TOTALS_ROWS_NOTICE)?.count, 1, w);
    const l = led([{ 'الاسم': 'أ', 'مدين': 5 }, { 'الاسم': w, 'مدين': 5 }]);
    assert.equal(l.valid.length, 1, `ledger ${w}`);
    assert.equal(notice(l.notices, TOTALS_ROWS_NOTICE)?.count, 1, w);
    const p = prc([{ 'الاسم': 'أ', 'كود الصنف': 'P', 'السعر': 1 }, { 'الاسم': w, 'كود الصنف': 'P', 'السعر': 1 }]);
    assert.equal(p.valid.length, 1, `prices ${w}`);
    assert.equal(notice(p.notices, TOTALS_ROWS_NOTICE)?.count, 1, w);
  }
  // عملاء حقيقيون لا يُستبعدون
  for (const name of ['مجموعة النور', 'مجموعات الخليج', 'المجموعة الذهبية', 'بقالة الإجمالي']) assert.equal(isTotalsName(name), false, name);
  assert.equal(cust([{ 'الاسم': 'مجموعة النور' }]).valid.length, 1);
  // بكود ⇒ عميل حقيقي
  assert.equal(bal([{ 'العميل': 'إجمالي الأرصدة', 'كود العميل': 'C1', 'الرصيد': 5 }]).valid.length, 1);
});

test('البند 9 (ثانية): عمود نوع الرصيد المنفصل يقلب الإشارة، وغير المفهوم خطأ صف', () => {
  assert.deepEqual(bal([{ 'العميل': 'أ', 'الرصيد': 1500, 'نوع الرصيد': 'دائن' }]).valid.map((v) => v.balance), [-1500]);
  assert.deepEqual(bal([{ 'العميل': 'أ', 'الرصيد': 1500, 'طبيعة الرصيد': 'دائن' }]).valid.map((v) => v.balance), [-1500]);
  const e = bal([{ 'Customer': 'A', 'Balance': 1500, 'Dr/Cr': 'Cr' }]);
  assert.deepEqual(e.valid.map((v) => v.balance), [-1500]);
  assert.deepEqual(e.blockers, []);
  assert.deepEqual(e.columns?.find((x) => x.field === 'balanceSide'), { field: 'balanceSide', header: 'Dr/Cr' });
  assert.deepEqual(bal([{ 'العميل': 'أ', 'الرصيد': -1500, 'نوع الرصيد': 'مدين' }]).valid.map((v) => v.balance), [1500]);
  assert.deepEqual(bal([{ 'العميل': 'أ', 'الرصيد': 1500, 'م/د': 'د' }, { 'العميل': 'ب', 'الرصيد': 20, 'م/د': 'م' }]).valid.map((v) => v.balance), [-1500, 20]);
  assert.deepEqual(bal([{ 'العميل': 'أ', 'الرصيد': 1500, 'نوع الرصيد': '' }]).valid.map((v) => v.balance), [1500]);
  const x = bal([{ 'العميل': 'أ', 'الرصيد': 1500, 'نوع الرصيد': 'x' }]);
  assert.equal(x.valid.length, 0);
  assert.deepEqual(x.errors.map((r) => [r.row, r.message, r.value, r.field]), [[2, BALANCE_SIDE_INVALID, 'x', 'balanceSide']]);
  // «مدين/دائن» عمود إشارة لا عمودا مبلغ
  const md = bal([{ 'العميل': 'أ', 'الرصيد': 1500, 'مدين/دائن': 'دائن' }]);
  assert.deepEqual([md.valid.map((v) => v.balance), md.blockers], [[-1500], []]);
  // رأس نوع رصيد غير معروف ⇒ مانع
  assert.ok(bal([{ 'العميل': 'أ', 'الرصيد': 1500, 'نوع رصيد العميل': 'دائن' }]).blockers?.includes(BALANCE_SIDE_UNRESOLVED_BLOCKER));
});

test('البند 9/13 (ثانية): أكثر من عمود رقمي مطابق تماماً ⇒ مانع، لا سقوط الخلية الفارغة إلى الرصيد الافتتاحي', () => {
  const a = bal([{ 'العميل': 'أ', 'الرصيد الحالي': '', 'الرصيد الافتتاحي': 5000 }, { 'العميل': 'ب', 'الرصيد الحالي': 300, 'الرصيد الافتتاحي': 100 }]);
  assert.ok(a.blockers?.includes(AMBIGUOUS_COLUMN_BLOCKER));
  assert.deepEqual(notice(a.notices, AMBIGUOUS_COLUMN_BLOCKER)?.values, ['الرصيد الحالي', 'الرصيد الافتتاحي']);
  const b = bal([{ 'Customer': 'A', 'Opening Balance': 5000, 'Closing Balance': '' }]);
  assert.ok(b.blockers?.includes(AMBIGUOUS_COLUMN_BLOCKER));
  // مرادف مفضّل واحد يحسم بلا مانع: «السعر الخاص» الفارغ لا يأخذ «السعر» الأساسي
  const pr = prc([{ 'كود العميل': 'C1', 'كود الصنف': 'P1', 'السعر': 10, 'السعر الخاص': '' }, { 'كود العميل': 'C1', 'كود الصنف': 'P2', 'السعر': 10, 'السعر الخاص': 8 }]);
  assert.deepEqual([pr.blockers, pr.valid.map((v) => v.price), pr.errors.map((e) => e.row)], [[], [8], [2]]);
  // الحقول النصية تبقى متعددة المرشحين بلا مانع
  const c = cust([{ 'الاسم': '', 'اسم العميل': 'أ' }]);
  assert.deepEqual([c.valid.map((v) => v.name), c.blockers], [['أ'], []]);
});

test('البند 9 (ثانية): ملف أرصدة بمدين ودائن ورصيد صريح يُستورد الرصيد بتنبيه، والتعارض يُعدّ', () => {
  const e = bal([{ 'Partner': 'A', 'Debit': 5000, 'Credit': 1200, 'Balance': 3800 }]);
  assert.deepEqual(e.blockers, []);
  assert.deepEqual(e.valid.map((v) => v.balance), [3800]);
  assert.ok(notice(e.notices, BALANCE_DC_IGNORED_NOTICE));
  assert.equal(notice(e.notices, BALANCE_DC_MISMATCH_NOTICE), undefined);
  const a = bal([{ 'اسم العميل': 'أ', 'مدين': 5000, 'دائن': 1200, 'الرصيد': 3800 }, { 'اسم العميل': 'ب', 'مدين': 100, 'دائن': 0, 'الرصيد': 900 }]);
  assert.deepEqual([a.blockers, a.valid.map((v) => v.balance)], [[], [3800, 900]]);
  assert.deepEqual(notice(a.notices, BALANCE_DC_MISMATCH_NOTICE), { key: BALANCE_DC_MISMATCH_NOTICE, count: 1, values: ['ب'] });
  // الدفعة 2 (الانحدار 1): الرصيد بالاحتواء مع مدين/دائن يُستورد الرصيد بلا مانع
  const ct = bal([{ 'الاسم': 'أ', 'رصيد العميل': 3800, 'مدين': 5000, 'دائن': 1200 }]);
  assert.deepEqual([ct.blockers, ct.valid.map((v) => v.balance)], [[], [3800]]);
  assert.equal(ct.blockers?.includes(BALANCE_DC_CONFLICT_BLOCKER), false);
  // الرصيد فارغ كله مع مدين/دائن بقيم ⇒ مدين − دائن بتنبيه، لا مانع
  const em = bal([{ 'الاسم': 'أ', 'الرصيد': '', 'مدين': 5000, 'دائن': 1200 }]);
  assert.deepEqual([em.blockers, em.valid.map((v) => v.balance)], [[], [3800]]);
});

test('البند 10 (ثانية): فواتير بعمود «الإجمالي شامل الضريبة» تُستورد، وبلا عمود مبلغ مانع صريح', () => {
  const z = led([{ 'رقم الفاتورة': 'INV1', 'التاريخ': '2025-01-05', 'اسم العميل': 'أ', 'المبلغ قبل الضريبة': 100, 'قيمة الضريبة': 15, 'الإجمالي شامل الضريبة': 115, 'حالة الدفع': 'غير مدفوعة' }]);
  assert.deepEqual([z.valid.map((v) => [v.debit, v.credit]), z.blockers], [[[115, 0]], []]);
  const en = led([{ 'Customer': 'A', 'Date': '2025-01-05', 'Total incl. Tax': 115, 'Status': 'Unpaid' }]);
  assert.deepEqual(en.valid.map((v) => [v.debit, v.credit]), [[115, 0]]);
  const both = led([{ 'اسم العميل': 'أ', 'الإجمالي': 100, 'الإجمالي شامل الضريبة': 115 }]);
  assert.deepEqual([both.valid.map((v) => v.debit), both.blockers], [[115], []]);
  const none = led([{ 'اسم العميل': 'أ', 'التاريخ': '2025-01-05', 'البيان': 'x' }]);
  assert.ok(none.blockers?.includes(LEDGER_NO_AMOUNT_COLUMN_BLOCKER));
});

test('البند 2 (ثانية): «مدفوعة بالكامل» و«قيد الدفع» مدفوعة لا ذمة كاملة، و«unknown» تنبيه', () => {
  const r = led([
    { 'الاسم': 'أ', 'الإجمالي': 1000, 'الحالة': 'مدفوعة بالكامل' },
    { 'الاسم': 'ب', 'الإجمالي': 1000, 'الحالة': 'Paid in full' },
    { 'الاسم': 'ج', 'الإجمالي': 1000, 'الحالة': 'قيد الدفع' },
    { 'الاسم': 'د', 'الإجمالي': 1000, 'الحالة': 'unknown' },
    { 'الاسم': 'ه', 'الإجمالي': 1000, 'الحالة': 'partly paid' },
    { 'الاسم': 'و', 'الإجمالي': 1000, 'الحالة': 'معكوس' },
  ]);
  assert.deepEqual(r.valid.map((v) => [v.customerName, v.debit, v.credit]), [['أ', 1000, 1000], ['ب', 1000, 1000], ['ج', 1000, 1000], ['د', 1000, 0]]);
  assert.deepEqual(r.errors.map((e) => [e.row, e.message]), [[6, PARTIAL_NO_PAID_COLUMN]]);
  assert.deepEqual(notice(r.notices, UNKNOWN_STATUS_NOTICE)?.values, ['unknown']);
  assert.equal(notice(r.notices, CANCELLED_ROWS_NOTICE)?.count, 1);
});

test('البند 1 (ثانية): «1.500» يُحسم بعمود فيه «1.500.000» أو «2.750,00»، ووحده خطأ صف ظاهر', () => {
  const eu = bal([{ 'Customer': 'A', 'Balance': '1.500' }, { 'Customer': 'B', 'Balance': '1.500.000' }, { 'Customer': 'C', 'Balance': '2.750,00' }]);
  assert.deepEqual(eu.valid.map((v) => v.balance), [1500, 1500000, 2750]);
  const alone = bal([{ 'Customer': 'A', 'Balance': '1.500' }]);
  assert.equal(alone.valid.length, 0);
  assert.deepEqual(alone.errors.map((e) => [e.message, e.value]), [[AMBIGUOUS_AMOUNT_ERROR, '1.500']]);
  const dot = bal([{ 'Customer': 'A', 'Balance': '1.500' }, { 'Customer': 'B', 'Balance': '12.25' }]);
  assert.deepEqual(dot.valid.map((v) => v.balance), [1.5, 12.25]);
  const ar = bal([{ 'Customer': 'A', 'Balance': '15٬00' }]);
  assert.deepEqual(ar.errors.map((e) => e.message), [NUMERIC_ERROR]);
});

test('البند 14 (ثانية): ضريبة باسمها «VAT 15%» تُقرأ 15، وضرائب المورد لا تلتبس بضرائب العميل', () => {
  const p = prod([{ 'Internal Reference': 'P1', 'Name': 'X', 'Sales Price': 5, 'Customer Taxes': 'VAT 15%' }]);
  assert.deepEqual([p.valid.map((v) => v.taxPct), p.errors], [[15], []]);
  const q = prod([{ 'Internal Reference': 'P1', 'Name': 'X', 'Sales Price': 5, 'Customer Taxes': '15% S', 'Vendor Taxes': '15% P' }]);
  assert.deepEqual([q.blockers, q.valid.map((v) => v.taxPct)], [[], [15]]);
  const bad = prod([{ 'Name': 'X', 'Tax': '5% + 15%' }]);
  assert.deepEqual(bad.errors.map((e) => [e.message, e.field]), [[NUMERIC_ERROR, 'taxPct']]);
});

test('البند 1 (ثانية): حد الائتمان وفترة السداد النصيان لا يُسقطان العميل', () => {
  const c = cust([{ 'اسم العميل': 'علي', 'الجوال': '0551234567', 'حد الائتمان': 'غير محدود', 'فترة السداد': '30 يوم' }]);
  assert.deepEqual(c.valid.map((v) => [v.name, v.creditLimit, v.paymentDays]), [['علي', undefined, 30]]);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(notice(c.notices, CUSTOMER_OPTIONAL_IGNORED_NOTICE), { key: CUSTOMER_OPTIONAL_IGNORED_NOTICE, count: 1, values: ['غير محدود'] });
  assert.deepEqual(cust([{ 'الاسم': 'أ', 'فترة السداد': 'Net 30' }]).valid.map((v) => v.paymentDays), [30]);
  assert.deepEqual(cust([{ 'الاسم': 'أ', 'فترة السداد': '٣٠ يوماً' }]).valid.map((v) => v.paymentDays), [30]);
  const neg = cust([{ 'الاسم': 'أ', 'حد الائتمان': '-5' }]);
  assert.deepEqual([neg.valid.length, neg.errors.map((e) => e.message)], [0, [NEGATIVE_CREDIT_LIMIT]]);
});

// ═══ دفعة الإصلاحات 2 — ما بقي بعد المراجعة الثالثة ═══
test('البند 11 (ثالثة): صف المجاميع بخانات «—» أو «0»، وصيغ الأسماء الشائعة، و«الإجمالي» في عمود الكود', () => {
  // الخانات المملوءة بشرطة أو صفر لا تجعل «الإجمالي» عميلاً
  for (const [code, phone] of [['', '—'], ['', '-'], ['', '0'], ['—', ''], ['—', '—'], ['-', '0000']]) {
    const c = cust([{ 'الاسم': 'أ', 'كود العميل': 'C1', 'الجوال': '0501234567' }, { 'الاسم': 'الإجمالي', 'كود العميل': code, 'الجوال': phone }]);
    assert.deepEqual(c.valid.map((v) => v.name), ['أ'], `customers code=${code} phone=${phone}`);
    const b = bal([{ 'العميل': 'أ', 'كود العميل': 'C1', 'الجوال': '0501234567', 'الرصيد': 1000 }, { 'العميل': 'الإجمالي', 'كود العميل': code, 'الجوال': phone, 'الرصيد': 3500 }]);
    assert.deepEqual(b.valid.map((v) => v.balance), [1000], `balances code=${code} phone=${phone}`);
    assert.equal(notice(b.notices, TOTALS_ROWS_NOTICE)?.count, 1);
  }
  const names = ['الجملة', 'جملة', '(الإجمالي)', '«الإجمالي»', '"Total"', '[Total]', 'Net Total', 'صافي الإجمالي', 'Report Total', 'Balance Total',
    'Overall Total', 'Sum', 'المجاميع', 'إجمالي/Total', 'Toplam', 'Genel Toplam', 'Sous-total', 'Sous total', 'Ara Toplam', '合计'];
  for (const w of names) {
    assert.equal(isTotalsName(w), true, w);
    const b = bal([{ 'العميل': 'أ', 'الرصيد': 1000 }, { 'العميل': w, 'الرصيد': 1000 }]);
    assert.deepEqual(b.valid.map((v) => v.customerName), ['أ'], `balances ${w}`);
    assert.equal(cust([{ 'الاسم': 'أ' }, { 'الاسم': w }]).valid.length, 1, `customers ${w}`);
  }
  // أسماء حقيقية لا تُستبعد: «جملة» و«Sum» بادئة اسم، و«صافي» وحده، و«Net» اسم متجر
  for (const n of ['جملة الخير', 'سوق الجملة', 'Sum Trading', 'صافي', 'Net Store', 'Balance Foods', 'بقالة الإجمالي', 'مجموعة النور']) {
    assert.equal(isTotalsName(n), false, n);
  }
  // «الإجمالي» في عمود الكود والاسم فارغ ⇒ صف مجاميع لا customerCode='الإجمالي'
  const k = bal([{ 'العميل': 'أ', 'كود العميل': 'C1', 'الرصيد': 1000 }, { 'العميل': '', 'كود العميل': 'الإجمالي', 'الرصيد': 1000 }]);
  assert.deepEqual([k.valid.map((v) => v.customerCode), k.errors], [['C1'], []]);
  assert.deepEqual(notice(k.notices, TOTALS_ROWS_NOTICE)?.values, ['الإجمالي']);
  // بكود حقيقي أو جوال صالح ⇒ عميل حقيقي
  assert.equal(cust([{ 'الاسم': 'الإجمالي', 'كود العميل': 'C9', 'الجوال': '—' }]).valid.length, 1);
  assert.equal(cust([{ 'الاسم': 'الإجمالي', 'الجوال': '0501234567' }]).valid.length, 1);
});

test('البند 9 (ثالثة): عمود نوع الرصيد بعناوين قريبة يقلب الإشارة، و«النوع» العام بقيم غير مدين/دائن لا يُلتقط', () => {
  const heads = ['Cr/Dr', 'CR/DR', 'دائن/مدين', 'د/م', 'D/C', 'C/D', 'Debit/Credit', 'مدين أو دائن', 'النوع', 'Type', 'Nature',
    'طبيعة الحساب', 'نوع الحساب', 'Balance Nature', 'Balance (Dr/Cr)', 'رصيد (مدين/دائن)', 'نوع الرصيد', 'Dr/Cr', 'م/د'];
  for (const h of heads) {
    const r = bal([{ 'العميل': 'أ', 'الرصيد': 700, [h]: 'دائن' }, { 'العميل': 'ب', 'الرصيد': 300, [h]: 'مدين' }]);
    assert.deepEqual([r.valid.map((v) => v.balance), r.blockers], [[-700, 300], []], h);
    const e = bal([{ 'Customer': 'A', 'Balance': 700, [h]: 'Cr' }, { 'Customer': 'B', 'Balance': 300, [h]: 'Dr' }]);
    assert.deepEqual(e.valid.map((v) => v.balance), [-700, 300], `en ${h}`);
  }
  // «Type» بقيم تصنيف العميل ليس عمود إشارة
  const t = bal([{ 'العميل': 'أ', 'الرصيد': 700, 'Type': 'Retail' }]);
  assert.deepEqual([t.valid.map((v) => v.balance), t.errors, t.blockers], [[700], [], []]);
  // «Type» بقيمة مدين/دائن وقيمة أخرى ⇒ خطأ صف ظاهر للقيمة غير المفهومة
  const m = bal([{ 'العميل': 'أ', 'الرصيد': 700, 'Type': 'Cr' }, { 'العميل': 'ب', 'الرصيد': 300, 'Type': 'Retail' }]);
  assert.deepEqual([m.valid.map((v) => v.balance), m.errors.map((x) => [x.row, x.message])], [[-700], [[3, BALANCE_SIDE_INVALID]]]);
  // رأس فيه مدين ودائن معاً بصيغة غير معروفة ⇒ مانع لا رصيد موجب صامت
  assert.ok(bal([{ 'العميل': 'أ', 'الرصيد': 700, 'مدين-دائن العميل': 'دائن' }]).blockers?.includes(BALANCE_SIDE_UNRESOLVED_BLOCKER));
  assert.ok(bal([{ 'Customer': 'A', 'Balance': 700, 'Debit or Credit flag': 'Cr' }]).blockers?.includes(BALANCE_SIDE_UNRESOLVED_BLOCKER));
});

test('البند 2 (ثالثة): «تم السداد بالكامل» و«Paid.» و«Paid (Full)» مدفوعة في ملف الفواتير', () => {
  const sts = ['تم السداد بالكامل', 'تم الدفع بالكامل', 'مدفوعة كاملة', 'مدفوع كامل', 'مدفوعة.', 'Paid.', 'مدفوع بالكامل.', 'Paid (Full)',
    'مدفوعة (كاملة)', 'Paid - Full', 'Payment in progress', 'reconciled'];
  const r = led(sts.map((s, i) => ({ 'الاسم': `ع${i}`, 'الإجمالي': 1000, 'الحالة': s })));
  assert.deepEqual(r.valid.map((v) => [v.debit, v.credit]), sts.map(() => [1000, 1000]));
  assert.equal(notice(r.notices, UNKNOWN_STATUS_NOTICE), undefined);
});

test('البند 1 (ثالثة): «١٫٥٠٠» بالفاصل العربي صريح لا يُقرأ بنمط العمود، وعملة الشركة بثلاث منازل تحسم «12.500»', () => {
  const mix = bal([{ 'Customer': 'A', 'Balance': '١٫٥٠٠' }, { 'Customer': 'B', 'Balance': '1.500.000' }]);
  assert.deepEqual([mix.valid.map((v) => v.balance), mix.errors], [[1.5, 1500000], []]);
  const alone = bal([{ 'Customer': 'A', 'Balance': '١٫٥٠٠' }]);
  assert.deepEqual([alone.valid.map((v) => v.balance), alone.errors], [[1.5], []]);
  // عمود دينار كويتي «12.500» و«150.750»: بلا سياق ملتبس، وبعملة الشركة بثلاث منازل عشري
  const kwd = [{ 'Customer': 'A', 'Balance': '12.500' }, { 'Customer': 'B', 'Balance': '150.750' }];
  assert.deepEqual(bal(kwd).errors.map((e) => e.message), [AMBIGUOUS_AMOUNT_ERROR, AMBIGUOUS_AMOUNT_ERROR]);
  assert.deepEqual(bal(kwd, { currencyDecimals: 3 }).valid.map((v) => v.balance), [12.5, 150.75]);
  // الدليل في العمود يغلب افتراض العملة: «1.500.000» ⇒ فاصلة عشرية
  assert.deepEqual(bal([{ 'Customer': 'A', 'Balance': '1.500' }, { 'Customer': 'B', 'Balance': '1.500.000' }], { currencyDecimals: 3 }).valid.map((v) => v.balance), [1500, 1500000]);
  // عملة بمنزلتين لا تغيّر السلوك
  assert.equal(bal(kwd, { currencyDecimals: 2 }).valid.length, 0);
  // رمز الدينار في الخلية يحسمها
  assert.deepEqual(bal([{ 'Customer': 'A', 'Balance': '12.500 KWD' }, { 'Customer': 'B', 'Balance': 'KD 1,500.000' }]).valid.map((v) => v.balance), [12.5, 1500]);
});

test('الانحدار 1 (ثالثة): رصيد بالاحتواء مع مدين/دائن يُستورد، والخانة الفارغة تُحسب مدين − دائن لا تسقط', () => {
  for (const h of ['الرصيد النهائي', 'Ending Balance', 'Balance (SAR)']) {
    const r = bal([{ 'Customer': 'A', 'Debit': 5000, 'Credit': 1200, [h]: 3800 }]);
    assert.deepEqual([r.blockers, r.valid.map((v) => v.balance)], [[], [3800]], h);
    assert.ok(notice(r.notices, BALANCE_DC_IGNORED_NOTICE), h);
  }
  // عمود رصيد فارغ كله
  const empty = bal([{ 'الاسم': 'أ', 'مدين': 1000, 'دائن': 200, 'الرصيد': '' }]);
  assert.deepEqual([empty.blockers, empty.valid.map((v) => v.balance)], [[], [800]]);
  assert.deepEqual(notice(empty.notices, BALANCE_FROM_DC_NOTICE), { key: BALANCE_FROM_DC_NOTICE, count: 1 });
  assert.equal(notice(empty.notices, BALANCE_DC_IGNORED_NOTICE), undefined);
  // فارغ في بعض الصفوف: لا يسقط صامتاً ضمن الصفرية
  const part = bal([{ 'الاسم': 'أ', 'مدين': 1000, 'دائن': 200, 'الرصيد': '' }, { 'الاسم': 'ب', 'مدين': 50, 'دائن': 0, 'الرصيد': 50 }]);
  assert.deepEqual(part.valid.map((v) => [v.customerName, v.balance]), [['أ', 800], ['ب', 50]]);
  assert.equal(notice(part.notices, ZERO_BALANCE_NOTICE), undefined);
  assert.equal(notice(part.notices, BALANCE_FROM_DC_NOTICE)?.count, 1);
  // خانات فارغة كلها ⇒ صفرية بتنبيه كما كانت
  assert.equal(notice(bal([{ 'الاسم': 'أ', 'مدين': '', 'دائن': '', 'الرصيد': '' }]).notices, ZERO_BALANCE_NOTICE)?.count, 1);
});

test('الانحدار 4 (ثالثة): اسم ضريبة معفاة أو صفرية بلا رقم ⇒ 0، و«VAT 5% 2018» ⇒ 5', () => {
  for (const t of ['Exempt', 'معفى', 'معفاة', 'Zero Rated', 'خاضعة للصفر', 'VAT Exempt', 'ضريبة صفرية', 'Tax Exempt']) {
    const p = prod([{ 'Internal Reference': 'P1', 'Name': 'X', 'Sales Price': 5, 'Customer Taxes': t }]);
    assert.deepEqual([p.valid.map((v) => v.taxPct), p.errors], [[0], []], t);
  }
  assert.deepEqual(prod([{ 'Name': 'X', 'Customer Taxes': 'VAT 5% 2018' }]).valid.map((v) => v.taxPct), [5]);
  // «S» وحدها (قياسية بلا نسبة) و«ضريبة ما» تبقى خطأ صف ظاهر
  for (const t of ['S', 'ضريبة ما']) assert.deepEqual(prod([{ 'Name': 'X', 'Customer Taxes': t }]).errors.map((e) => e.message), [NUMERIC_ERROR], t);
});

test('الدفعة 2: نص CUSTOMER_CODE_UNREGISTERED في الويب يطابق الخادم حرفياً، وسبب CODE_AMBIGUOUS_NAME مترجم', async () => {
  const { CUSTOMER_CODE_UNREGISTERED_MESSAGE, attachedCodeKey } = await import('./importRevert');
  assert.ok(backendSrc('services/importLedger.ts').includes(`CUSTOMER_CODE_UNREGISTERED: '${CUSTOMER_CODE_UNREGISTERED_MESSAGE}'`));
  const keys = phraseKeys();
  for (const k of [attachedCodeKey('phone'), attachedCodeKey('name'), BALANCE_FROM_DC_NOTICE, 'ربط كود']) assert.ok(keys.has(k), k);
});

// ═══ دفعة الإصلاحات 2 (مراجعة 2026-09-17) ═══

test('البند 23: صف «رصيد سابق» في الكشف يُستورد بإشارته، والمنقول يُتجاهل، وبلا تسمية خطأ صف ظاهر', () => {
  // التسميات مصدَّرة مطبّعة (بلا مسافات) لتُطابَق بـincludes على البيان المطبَّع
  assert.ok(OPENING_ROW_LABELS.includes('رصيدسابق') && OPENING_ROW_LABELS.includes('openingbalance'));
  assert.ok(OPENING_ROW_LABELS.every((l) => !!l && !/[\s.()/]/.test(l)));
  // سيناريو التقرير: رصيد سابق 7000 ثم فاتورة ثم سند — كان يسقط بصمت فيصير الرصيد ناقصاً 7000
  const r = led([
    { 'التاريخ': '2026-01-01', 'اسم العميل': 'أ', 'البيان': 'رصيد سابق', 'مدين': '', 'دائن': '', 'الرصيد': 7000 },
    { 'التاريخ': '2026-01-05', 'اسم العميل': 'أ', 'البيان': 'فاتورة 1', 'مدين': 500, 'دائن': '', 'الرصيد': 7500 },
    { 'التاريخ': '2026-01-07', 'اسم العميل': 'أ', 'البيان': 'سند قبض', 'مدين': '', 'دائن': 2000, 'الرصيد': 5500 },
  ]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.valid.map((v) => [v.debit, v.credit, v.description, v.date]), [
    [7000, 0, 'رصيد سابق', '2026-01-01'], [500, 0, 'فاتورة 1', '2026-01-05'], [0, 2000, 'سند قبض', '2026-01-07'],
  ]);
  assert.equal(notice(r.notices, LEDGER_OPENING_ROW_NOTICE)?.count, 1);
  assert.deepEqual(r.blockers, []);

  // رصيد سابق دائن: بالأقواس أو بالسالب اللاحق
  const cr = led([
    { 'اسم العميل': 'ب', 'البيان': 'الرصيد السابق', 'مدين': '', 'دائن': '', 'الرصيد': '(7000)' },
    { 'اسم العميل': 'ج', 'البيان': 'رصيد افتتاحي', 'مدين': '', 'دائن': '', 'الرصيد': '7000-' },
    { 'اسم العميل': 'د', 'البيان': 'Opening Balance', 'مدين': '', 'دائن': '', 'الرصيد': '1500' },
  ]);
  assert.deepEqual(cr.errors, []);
  assert.deepEqual(cr.valid.map((v) => [v.debit, v.credit]), [[0, 7000], [0, 7000], [1500, 0]]);

  // «رصيد منقول» بعد حركات العميل (بين صفحات الكشف) ⇒ يُتجاهل بتنبيه لا يُضاعف الرصيد
  const carried = led([
    { 'اسم العميل': 'أ', 'البيان': 'فاتورة', 'مدين': 500, 'دائن': '', 'الرصيد': 500 },
    { 'اسم العميل': 'أ', 'البيان': 'رصيد منقول', 'مدين': '', 'دائن': '', 'الرصيد': 500 },
    { 'اسم العميل': 'أ', 'البيان': 'فاتورة 2', 'مدين': 300, 'دائن': '', 'الرصيد': 800 },
  ]);
  assert.deepEqual([carried.errors, carried.valid.map((v) => v.debit)], [[], [500, 300]]);
  assert.equal(notice(carried.notices, LEDGER_CARRIED_BALANCE_NOTICE)?.count, 1);

  // صف رصيد فقط بلا تسمية افتتاحية في ملفٍ عمودُ الرصيد فيه مصدر المبلغ الوحيد ⇒ خطأ صف ظاهر بقيمته لا سقوط صامت
  const bare = led([{ 'اسم العميل': 'هـ', 'البيان': 'تسوية', 'الرصيد': 900 }]);
  assert.deepEqual(bare.errors.map((e) => [e.row, e.message, e.value, e.field]), [[2, LEDGER_BALANCE_ONLY_ROW, '900', 'balance']]);
  assert.equal(bare.valid.length, 0);
  // بلا بيان أصلاً ⇒ الخطأ نفسه
  assert.deepEqual(led([{ 'اسم العميل': 'و', 'الرصيد': 900 }]).errors.map((e) => e.message), [LEDGER_BALANCE_ONLY_ROW]);

  // قيمة رصيد غير مفهومة في صف بلا مدين ولا دائن ⇒ خطأ غير المفهوم لا صفر
  const bad = led([{ 'اسم العميل': 'ز', 'البيان': 'رصيد سابق', 'مدين': '', 'دائن': '', 'الرصيد': 'N/A' }]);
  assert.deepEqual(bad.errors.map((e) => [e.message, e.value, e.field]), [[NUMERIC_ERROR, 'N/A', 'balance']]);

  // رصيد صفري في صف بلا حركة: يبقى مُهمَلاً كما كان (لا خطأ ولا صف)
  assert.deepEqual(led([{ 'اسم العميل': 'ح', 'البيان': 'رصيد سابق', 'مدين': '', 'دائن': '', 'الرصيد': 0 }]).errors, []);

  // انحدار: كشف عادي فيه عمود رصيد تراكمي على كل الصفوف ⇒ النتيجة كما قبل التعديل
  const running = led([
    { 'اسم العميل': 'أ', 'البيان': 'فاتورة', 'مدين': 500, 'دائن': '', 'الرصيد': 500 },
    { 'اسم العميل': 'أ', 'البيان': 'سند', 'مدين': '', 'دائن': 200, 'الرصيد': 300 },
    { 'اسم العميل': 'أ', 'البيان': 'فاتورة', 'مدين': 100, 'دائن': '', 'الرصيد': 400 },
  ]);
  assert.deepEqual([running.valid.length, running.errors, running.blockers], [3, [], []]);
  assert.equal(notice(running.notices, LEDGER_OPENING_ROW_NOTICE), undefined);
  // عمود الرصيد لا يُضيف مانع أعمدة ملتبسة لملف فيه رصيد حالي وافتتاحي
  assert.deepEqual(led([{ 'اسم العميل': 'أ', 'مدين': 5, 'الرصيد الحالي': 5, 'الرصيد الافتتاحي': 0 }]).blockers, []);
});

test('البند 23: صف الرصيد السابق يُلتقط أياً كان موضعه — صف عنوان قبله، كشف تنازلي، صف صفري', () => {
  // مجموعتان لا واحدة: «رصيد منقول» منقولٌ صريح، و«رصيد سابق» افتتاحيٌّ حقيقي
  assert.ok(CARRIED_ROW_LABELS.includes('رصيدمنقول') && !CARRIED_ROW_LABELS.includes('رصيدسابق'));
  assert.ok(TRUE_OPENING_ROW_LABELS.includes('رصيدسابق') && !TRUE_OPENING_ROW_LABELS.includes('رصيدمنقول'));
  for (const l of [...CARRIED_ROW_LABELS, ...TRUE_OPENING_ROW_LABELS]) assert.ok(OPENING_ROW_LABELS.includes(l), l);

  // (أ) صف عنوان للعميل بلا مبالغ قبل رصيده السابق: كان يستهلك «أول صف للعميل» فيسقط الـ7000
  const titled = led([
    { 'اسم العميل': 'أ', 'البيان': 'كشف حساب العميل', 'مدين': '', 'دائن': '', 'الرصيد': '' },
    { 'التاريخ': '2026-01-01', 'اسم العميل': 'أ', 'البيان': 'رصيد سابق', 'مدين': '', 'دائن': '', 'الرصيد': 7000 },
    { 'التاريخ': '2026-01-05', 'اسم العميل': 'أ', 'البيان': 'فاتورة 1', 'مدين': 1000, 'دائن': '', 'الرصيد': 8000 },
  ]);
  assert.deepEqual(titled.errors, []);
  assert.deepEqual(titled.valid.map((v) => [v.debit, v.credit]), [[7000, 0], [1000, 0]]);
  assert.equal(notice(titled.notices, LEDGER_OPENING_ROW_NOTICE)?.count, 1);
  assert.equal(notice(titled.notices, LEDGER_CARRIED_BALANCE_NOTICE), undefined);

  // (ب) كشف تنازلي (الأحدث أولاً) ورصيده السابق آخر صف ⇒ صافي المدين ناقص الدائن = 6000
  const desc = led([
    { 'التاريخ': '2026-01-07', 'اسم العميل': 'ب', 'البيان': 'سند قبض', 'مدين': '', 'دائن': 2000, 'الرصيد': 6000 },
    { 'التاريخ': '2026-01-05', 'اسم العميل': 'ب', 'البيان': 'فاتورة 1', 'مدين': 1000, 'دائن': '', 'الرصيد': 8000 },
    { 'التاريخ': '2026-01-01', 'اسم العميل': 'ب', 'البيان': 'رصيد سابق', 'مدين': '', 'دائن': '', 'الرصيد': 7000 },
  ]);
  assert.deepEqual(desc.errors, []);
  assert.equal(desc.valid.reduce((s, v) => s + Number(v.debit) - Number(v.credit), 0), 6000);
  assert.equal(notice(desc.notices, LEDGER_OPENING_ROW_NOTICE)?.count, 1);

  // (ج) صف مدين 0/دائن 0 مكتوبَين قبل صف الرصيد ⇒ قيد صفري يُهمل بهدوء والرصيد يُستورد
  const zero = led([
    { 'اسم العميل': 'ج', 'البيان': 'بداية', 'مدين': 0, 'دائن': 0, 'الرصيد': 0 },
    { 'اسم العميل': 'ج', 'البيان': 'رصيد سابق', 'مدين': '', 'دائن': '', 'الرصيد': 7000 },
  ]);
  assert.deepEqual([zero.errors, zero.valid.length, zero.valid[0]?.debit], [[], 1, 7000]);

  // انحدار: صفّا «رصيد سابق» لعميل واحد ⇒ الأول يُستورد والثاني رصيد مكرر بتنبيه
  const twice = led([
    { 'اسم العميل': 'د', 'البيان': 'رصيد سابق', 'مدين': '', 'دائن': '', 'الرصيد': 7000 },
    { 'اسم العميل': 'د', 'البيان': 'رصيد سابق', 'مدين': '', 'دائن': '', 'الرصيد': 7000 },
  ]);
  assert.deepEqual([twice.errors, twice.valid.length], [[], 1]);
  assert.equal(notice(twice.notices, LEDGER_CARRIED_BALANCE_NOTICE)?.count, 1);
});

test('البند 23: صفوف الرصيد الختامي والصفرية وعمود «رصيد المورد» لا تولّد أخطاء صفوف على ملفات سليمة', () => {
  // (أ) ذيل «الرصيد الختامي» في كشف مدين/دائن/رصيد ⇒ تنبيه معدود لا خطأ
  const closing = led([
    { 'اسم العميل': 'أ', 'البيان': 'فاتورة', 'مدين': 1000, 'دائن': '', 'الرصيد': 1000 },
    { 'اسم العميل': 'أ', 'البيان': 'سند', 'مدين': '', 'دائن': 400, 'الرصيد': 600 },
    { 'اسم العميل': 'أ', 'البيان': 'الرصيد الختامي', 'مدين': '', 'دائن': '', 'الرصيد': 600 },
  ]);
  assert.deepEqual([closing.errors, closing.valid.length], [[], 2]);
  assert.equal(notice(closing.notices, LEDGER_CLOSING_ROW_NOTICE)?.count, 1);

  // (ب) قيد صفري صريح (مدين 0 ودائن 0) مع رصيد تراكمي ⇒ لا خطأ
  const zeroEntry = led([
    { 'اسم العميل': 'ب', 'البيان': 'فاتورة', 'مدين': 1000, 'دائن': '', 'الرصيد': 1000 },
    { 'اسم العميل': 'ب', 'البيان': 'قيد صفري', 'مدين': 0, 'دائن': 0, 'الرصيد': 1000 },
  ]);
  assert.deepEqual([zeroEntry.errors, zeroEntry.valid.length], [[], 1]);

  // (ج) ملف فواتير فيه عمود رصيد وصفٌّ مبلغه فارغ ⇒ تنبيه معدود لا خطأ
  const inv = led([
    { 'اسم العميل': 'ج', 'الإجمالي': 500, 'الرصيد': 500 },
    { 'اسم العميل': 'ج', 'الإجمالي': '', 'الرصيد': 500 },
  ]);
  assert.deepEqual([inv.errors, inv.valid.length], [[], 1]);
  assert.equal(notice(inv.notices, LEDGER_BALANCE_ONLY_NOTICE)?.count, 1);

  // (د) «رصيد المورد» ليس عمود رصيد العميل ⇒ لا يُلتقط ولا يولّد خطأ
  const sup = led([{ 'اسم العميل': 'د', 'مدين': 100, 'دائن': '', 'رصيد المورد': 900 }]);
  assert.deepEqual([sup.errors, sup.valid.length], [[], 1]);
  assert.equal(sup.columns?.find((x) => x.field === 'balance')?.header ?? null, null);
});

// ═══ إغلاقة الدفعة 2 (البندان 23 و30) ═══

test('البند 23: تسميات الرصيد السابق الشائعة («ما قبل الفترة»، «بداية المدة»، «b/d»، «مدور») تُستورد لا تسقط', () => {
  const opening = (desc: string) => led([
    { 'التاريخ': '2026-01-01', 'اسم العميل': 'أ', 'البيان': desc, 'مدين': '', 'دائن': '', 'الرصيد': 7000 },
    { 'التاريخ': '2026-01-05', 'اسم العميل': 'أ', 'البيان': 'فاتورة', 'مدين': 500, 'دائن': '', 'الرصيد': 7500 },
  ]);
  for (const desc of ['رصيد ما قبل الفترة', 'رصيد ما قبل المدة', 'رصيد بداية المدة', 'رصيد بداية الفترة',
    'رصيد أول الفترة', 'Beginning Balance', 'Balance b/d', 'Brought Down', 'رصيد مدور', 'الرصيد المدور']) {
    const r = opening(desc);
    assert.deepEqual(r.errors, [], desc);
    assert.deepEqual(r.valid.map((v) => [v.debit, v.credit]), [[7000, 0], [500, 0]], desc);
    assert.equal(notice(r.notices, LEDGER_OPENING_ROW_NOTICE)?.count, 1, desc);
    assert.equal(notice(r.notices, LEDGER_BALANCE_ONLY_NOTICE), undefined, desc);
  }
  // الصيغ المؤكَّدة من قبل تبقى: «رصيد سابق مدور» و«Previous Balance b/d»
  for (const desc of ['رصيد سابق مدور', 'Previous Balance b/d', 'رصيد أول المدة']) {
    assert.equal(opening(desc).valid[0]?.debit, 7000, desc);
  }
  // «مدور» ترحيلٌ لا افتتاحيّ: بعد حركة مقبولة يُستبعد رصيداً مكرراً (كـ«منقول») لا يُضاعف الرصيد
  const after = led([
    { 'اسم العميل': 'ب', 'البيان': 'فاتورة', 'مدين': 500, 'دائن': '', 'الرصيد': 500 },
    { 'اسم العميل': 'ب', 'البيان': 'رصيد مدور', 'مدين': '', 'دائن': '', 'الرصيد': 500 },
  ]);
  assert.deepEqual([after.errors, after.valid.length], [[], 1]);
  assert.equal(notice(after.notices, LEDGER_CARRIED_BALANCE_NOTICE)?.count, 1);
  assert.ok(CARRIED_ROW_LABELS.includes('رصيدمدور') && CARRIED_ROW_LABELS.includes('balancebd'));
  assert.ok(TRUE_OPENING_ROW_LABELS.includes('رصيدماقبل') && TRUE_OPENING_ROW_LABELS.includes('رصيدبدايه'));
  // «b/d» وحدها (حرفان) لا تُدرج: «عبد الله» وأمثاله لا يصير رصيداً سابقاً
  assert.ok(!CARRIED_ROW_LABELS.includes('bd'));
  assert.equal(led([{ 'اسم العميل': 'ج', 'البيان': 'عبدالله', 'مدين': '', 'دائن': '', 'الرصيد': 900 }])
    .valid.length, 0);
});

test('البند 23: صفّ بلا مبلغ في أي عمود متعرَّف عليه يُعدّ في تنبيه لا يسقط بصمت (عمود رصيد باسم غير ملتقَط)', () => {
  // «الرصيد المتبقي» يُلتقط عمود «المتبقي» لا رصيد العميل ⇒ صف الرصيد السابق كان يسقط بلا خطأ ولا تنبيه
  const residual = led([
    { 'اسم العميل': 'أ', 'البيان': 'رصيد سابق', 'مدين': '', 'دائن': '', 'الرصيد المتبقي': 7000 },
    { 'اسم العميل': 'أ', 'البيان': 'فاتورة', 'مدين': 500, 'دائن': '', 'الرصيد المتبقي': 7500 },
  ]);
  assert.deepEqual([residual.errors, residual.valid.length], [[], 1]);
  assert.equal(notice(residual.notices, LEDGER_NO_AMOUNT_ROW_NOTICE)?.count, 1);
  // صف عنوان الكشف (بلا أي مبلغ) يُعدّ هو الآخر، ولا يمنع استيراد الرصيد السابق بعده
  const titled = led([
    { 'اسم العميل': 'ب', 'البيان': 'كشف حساب العميل', 'مدين': '', 'دائن': '', 'الرصيد': '' },
    { 'اسم العميل': 'ب', 'البيان': 'رصيد سابق', 'مدين': '', 'دائن': '', 'الرصيد': 7000 },
  ]);
  assert.deepEqual([titled.errors, titled.valid.map((v) => v.debit)], [[], [7000]]);
  assert.equal(notice(titled.notices, LEDGER_NO_AMOUNT_ROW_NOTICE)?.count, 1);
  // قيد صفري صريح (مدين 0 ودائن 0) ليس صفاً بلا مبلغ: لا يُعدّ في التنبيه
  const zero = led([{ 'اسم العميل': 'ج', 'البيان': 'قيد صفري', 'مدين': 0, 'دائن': 0 }]);
  assert.equal(notice(zero.notices, LEDGER_NO_AMOUNT_ROW_NOTICE), undefined);
  // وكشف سليم كل صفوفه حركات ⇒ لا تنبيه أصلاً
  const clean = led([
    { 'اسم العميل': 'د', 'البيان': 'فاتورة', 'مدين': 500, 'دائن': '' },
    { 'اسم العميل': 'د', 'البيان': 'سند', 'مدين': '', 'دائن': 200 },
  ]);
  assert.deepEqual([clean.errors, clean.valid.length], [[], 2]);
  assert.equal(notice(clean.notices, LEDGER_NO_AMOUNT_ROW_NOTICE), undefined);
});

test('البند 23: صيغ كشوف أخرى فُحصت ولم يثبت فيها إسقاط صامت (حراسة انحدار)', () => {
  // (أ) كشف بلا عمود رصيد أصلاً ورصيده السابق في عمود المبلغ بلا حالة دفع ⇒ يُستورد مديناً
  const amountOnly = led([
    { 'التاريخ': '2026-01-01', 'اسم العميل': 'أ', 'البيان': 'رصيد سابق', 'المبلغ': 7000 },
    { 'التاريخ': '2026-01-05', 'اسم العميل': 'أ', 'البيان': 'فاتورة', 'المبلغ': 500 },
  ]);
  assert.deepEqual([amountOnly.errors, amountOnly.valid.map((v) => [v.debit, v.credit])], [[], [[7000, 0], [500, 0]]]);
  assert.equal(notice(amountOnly.notices, LEDGER_NO_AMOUNT_ROW_NOTICE), undefined);
  // (ب) أسماء أعمدة الرصيد الشائعة تُلتقط فعلاً
  for (const h of ['الرصيد التراكمي', 'Running Balance', 'الرصيد بعد الحركة', 'الرصيد الجاري']) {
    const r = led([
      { 'اسم العميل': 'ب', 'البيان': 'رصيد سابق', 'مدين': '', 'دائن': '', [h]: 7000 },
      { 'اسم العميل': 'ب', 'البيان': 'فاتورة', 'مدين': 500, 'دائن': '', [h]: 7500 },
    ]);
    assert.equal(r.columns?.find((x) => x.field === 'balance')?.header, h);
    assert.deepEqual([r.errors, r.valid.map((v) => v.debit)], [[], [7000, 500]], h);
  }
  // (ج) رصيد سابق نصاً بفاصل آلاف ⇒ يُقرأ كاملاً
  const text = led([
    { 'اسم العميل': 'ج', 'البيان': 'رصيد سابق', 'مدين': '', 'دائن': '', 'الرصيد': '7,000.50' },
    { 'اسم العميل': 'ج', 'البيان': 'فاتورة', 'مدين': 500, 'دائن': '', 'الرصيد': '7,500.50' },
  ]);
  assert.deepEqual([text.errors, text.valid[0]?.debit], [[], 7000.5]);
  // (د) رصيد سابق صفر: لا مبلغ فيه ⇒ لا خطأ ولا صف (ويُعدّ صفاً بلا مبلغ)
  const zero = led([{ 'اسم العميل': 'د', 'البيان': 'رصيد سابق', 'مدين': '', 'دائن': '', 'الرصيد': 0 }]);
  assert.deepEqual([zero.errors, zero.valid.length], [[], 0]);
  // (هـ) صف رصيد سابق بلا اسم عميل (الاسم في ترويسة الكشف) ليس إسقاطاً صامتاً: يُعدّ في تنبيه «صفوف بلا عميل»
  const noName = led([
    { 'اسم العميل': 'هـ', 'البيان': 'فاتورة', 'مدين': 500, 'دائن': '', 'الرصيد': 7500 },
    { 'اسم العميل': '', 'البيان': 'رصيد سابق', 'مدين': '', 'دائن': '', 'الرصيد': 7000 },
  ]);
  assert.deepEqual([noName.errors, noName.valid.length], [[], 1]);
  assert.equal(notice(noName.notices, NO_CUSTOMER_ROWS_NOTICE)?.count, 1);
});

test('البند 23 (انحدار): ذيل الكشف بأي تسمية مجاميع أو ختام يُستبعد بتنبيه معدود لا بخطأ صف', () => {
  const tails = ['المجموع العام', 'Grand Total', 'الرصيد كما في 31/12/2025', 'الرصيد النهائي', 'صافي الرصيد',
    'الرصيد الختامي', 'إجمالي الحركة', 'Net Total', 'Balance as of 31/12/2025', 'Final Balance'];
  for (const t of tails) {
    // (أ) ملف مدين/دائن + رصيد تراكمي: الذيل تنبيه ختام لا «رصيد بلا مدين ولا دائن»
    const dc = led([
      { 'اسم العميل': 'أ', 'البيان': 'فاتورة', 'مدين': 500, 'دائن': '', 'الرصيد': 500 },
      { 'اسم العميل': 'أ', 'البيان': t, 'مدين': '', 'دائن': '', 'الرصيد': 500 },
    ]);
    assert.deepEqual([dc.errors, dc.valid.length], [[], 1], t);
    assert.equal(notice(dc.notices, LEDGER_CLOSING_ROW_NOTICE)?.count, 1, t);
    // (ب) ملف عمود الرصيد فيه وحده: الذيل نفسه لا يولّد خطأ صف
    const only = led([
      { 'اسم العميل': 'ب', 'البيان': 'رصيد سابق', 'الرصيد': 500 },
      { 'اسم العميل': 'ب', 'البيان': t, 'الرصيد': 500 },
    ]);
    assert.deepEqual([only.errors, only.valid.length], [[], 1], t);
    assert.equal(notice(only.notices, LEDGER_CLOSING_ROW_NOTICE)?.count, 1, t);
  }
  // صفّ رصيده صفر في ملف بلا مدين/دائن: لا خطأ صف (لا مبلغ يضيع)
  const zero = led([
    { 'اسم العميل': 'ج', 'البيان': 'رصيد سابق', 'الرصيد': 500 },
    { 'اسم العميل': 'ج', 'البيان': 'تسوية', 'الرصيد': 0 },
  ]);
  assert.deepEqual([zero.errors, zero.valid.length], [[], 1]);
  // القاعدة: خطأ الصف محجوز لمبلغ حقيقي بلا مصدر آخر — وكل ملف يبلغه محجوبٌ أصلاً بمانع «لا عمود مبلغ»،
  // فلا ملفَ كان يمرّ نظيفاً صار يُظهر أخطاء صفوف
  const lost = led([{ 'اسم العميل': 'د', 'البيان': 'تسوية يدوية', 'الرصيد': 900 }]);
  assert.deepEqual(lost.errors.map((e) => [e.row, e.message, e.value, e.field]), [[2, LEDGER_BALANCE_ONLY_ROW, '900', 'balance']]);
  assert.ok(lost.blockers?.includes(LEDGER_NO_AMOUNT_COLUMN_BLOCKER));
  for (const rows of [
    [{ 'اسم العميل': 'هـ', 'البيان': 'تسوية', 'الرصيد': 900, 'مدين': '', 'دائن': '' }],
    [{ 'اسم العميل': 'و', 'البيان': 'تسوية', 'الرصيد': 900, 'الإجمالي': '' }],
  ]) {
    const r = led(rows as Record<string, unknown>[]);
    assert.deepEqual(r.errors, []);
    assert.equal(notice(r.notices, LEDGER_BALANCE_ONLY_NOTICE)?.count, 1);
  }
  assert.ok(CLOSING_ROW_LABELS.includes('الرصيدكمافي') && CLOSING_ROW_LABELS.includes('صافيالرصيد'));
});

test('البند 30: تكرار كود الصنف داخل ملف المنتجات — المطابق يُرسل مرة، والمختلف خطأ صف', () => {
  // ملف بلا عمود كود: «ماء» حبة و«ماء» كرتون — كان الثانيان يُرسلان بالكود نفسه فيُتخطى الثاني بصمت
  const p = prod([
    { 'اسم الصنف': 'ماء', 'الوحدة': 'حبة', 'سعر البيع': 1 },
    { 'اسم الصنف': 'ماء', 'الوحدة': 'كرتون', 'سعر البيع': 20 },
  ]);
  assert.deepEqual(p.valid.map((v) => [v.code, v.unit, v.basePrice]), [['ماء', 'حبة', 1]]);
  assert.deepEqual(p.errors.map((e) => [e.row, e.message]), [[3, PRODUCT_SAME_NAME_NO_CODE]]);
  assert.deepEqual(p.fileRows, [2]);

  // صف مطابق تماماً ⇒ يُرسل مرة واحدة بتنبيه غير مانع
  const same = prod([
    { 'كود الصنف': 'P1', 'اسم الصنف': 'ماء', 'الوحدة': 'حبة', 'سعر البيع': 1, 'الضريبة': 15 },
    { 'كود الصنف': 'P1', 'اسم الصنف': 'ماء', 'الوحدة': 'حبة', 'سعر البيع': 1, 'الضريبة': 15 },
  ]);
  assert.deepEqual([same.valid.length, same.errors], [1, []]);
  assert.equal(notice(same.notices, PRODUCT_DUPLICATE_ROWS_NOTICE)?.count, 1);

  // الكود نفسه ببيانات مختلفة ⇒ خطأ صف بقيمة الكود
  const diff = prod([
    { 'كود الصنف': 'P1', 'اسم الصنف': 'ماء', 'سعر البيع': 1 },
    { 'كود الصنف': 'P1', 'اسم الصنف': 'ماء', 'سعر البيع': 9 },
  ]);
  assert.deepEqual(diff.errors.map((e) => [e.row, e.message, e.value, e.field]), [[3, PRODUCT_DUPLICATE_CODE, 'P1', 'code']]);
  assert.equal(diff.valid.length, 1);

  // أصناف مختلفة الأكواد لا تتأثر
  assert.equal(prod([{ 'كود الصنف': 'P1', 'اسم الصنف': 'ماء' }, { 'كود الصنف': 'P2', 'اسم الصنف': 'ماء' }]).valid.length, 2);

  // التوقيع يطبّق افتراضيّي الكتابة كما يطبّقهما الخادم: خانة وحدة فارغة و«حبة» تكتبان الصنف نفسه
  const unitDefault = prod([
    { 'كود الصنف': 'P1', 'اسم الصنف': 'ماء', 'الوحدة': '', 'سعر البيع': 1 },
    { 'كود الصنف': 'P1', 'اسم الصنف': 'ماء', 'الوحدة': 'حبة', 'سعر البيع': 1 },
  ]);
  assert.deepEqual([unitDefault.errors, unitDefault.valid.length], [[], 1]);
  assert.equal(notice(unitDefault.notices, PRODUCT_DUPLICATE_ROWS_NOTICE)?.count, 1);

  // وسعر فارغ مقابل صفر صريح كذلك
  const priceDefault = prod([
    { 'كود الصنف': 'P2', 'اسم الصنف': 'رز', 'سعر البيع': '' },
    { 'كود الصنف': 'P2', 'اسم الصنف': 'رز', 'سعر البيع': 0 },
  ]);
  assert.deepEqual([priceDefault.errors, priceDefault.valid.length], [[], 1]);
  assert.equal(notice(priceDefault.notices, PRODUCT_DUPLICATE_ROWS_NOTICE)?.count, 1);
});

test('البند 30: افتراضيا توقيع صف المنتجات في الويب هما نفساهما في الخادم حرفياً', () => {
  // productRowSignature(r, defaultVat): [normImportName(name), unit || 'حبة', basePrice ?? 0, taxPct ?? defaultVat ?? null, …]
  const ledgerSrc = backendSrc('services/importLedger.ts');
  const sig = ledgerSrc.match(/function productRowSignature[\s\S]*?return JSON\.stringify\(\[([^\]]*)\]\)/);
  assert.ok(sig, 'productRowSignature غير موجود في الخادم');
  assert.match(sig![1], new RegExp(`r\\.unit \\|\\| '${PRODUCT_DEFAULT_UNIT}'`));
  assert.match(sig![1], new RegExp(`r\\.basePrice \\?\\? ${PRODUCT_DEFAULT_PRICE}`));
  // خانة الضريبة الفارغة تأخذ ضريبة الشركة على الخادم: توقيعه `r.taxPct ?? defaultVat ?? null`
  assert.match(sig![1], /r\.taxPct \?\? defaultVat \?\? null/);
  assert.match(ledgerSrc, /function productRowSignature\([^)]*defaultVat: number \| null\)/);
  // وافتراضيا الكتابة في import.ts هما المصدر لكليهما
  const write = backendSrc('routes/import.ts');
  assert.ok(write.includes(`unit: r.unit || '${PRODUCT_DEFAULT_UNIT}'`), 'افتراضي الوحدة في import.ts تغيّر: حدّث PRODUCT_DEFAULT_UNIT');
  assert.ok(write.includes(`basePrice: r.basePrice ?? ${PRODUCT_DEFAULT_PRICE}`), 'افتراضي السعر في import.ts تغيّر: حدّث PRODUCT_DEFAULT_PRICE');
  assert.ok(write.includes('taxPct: r.taxPct ?? defaultVat'), 'ضريبة الصف الفارغة في import.ts تغيّرت: راجع تساهل الويب في خانة الضريبة');
});

test('البند 30: خانة ضريبة فارغة مقابل قيمة صريحة لصنفين بالكود نفسه ⇒ تخطٍّ معدود لا خطأ صف', () => {
  // الخادم يكتب للفارغة ضريبة الشركة (defaultVat) ويعدّ الصفّين متطابقين؛ وdefaultVat غير متاح للويب ⇒ تساهل
  const blankFirst = prod([
    { 'كود الصنف': 'P1', 'اسم الصنف': 'ماء', 'سعر البيع': 1, 'الضريبة': '' },
    { 'كود الصنف': 'P1', 'اسم الصنف': 'ماء', 'سعر البيع': 1, 'الضريبة': 15 },
  ]);
  assert.deepEqual([blankFirst.errors, blankFirst.valid.length], [[], 1]);
  assert.equal(notice(blankFirst.notices, PRODUCT_BLANK_TAX_DUPLICATE_NOTICE)?.count, 1);
  assert.deepEqual(blankFirst.fileRows, [2]);
  // والعكس: الصريحة أولاً والفارغة بعدها
  const blankSecond = prod([
    { 'كود الصنف': 'P1', 'اسم الصنف': 'ماء', 'سعر البيع': 1, 'الضريبة': 15 },
    { 'كود الصنف': 'P1', 'اسم الصنف': 'ماء', 'سعر البيع': 1, 'الضريبة': '' },
  ]);
  assert.deepEqual([blankSecond.errors, blankSecond.valid.map((v) => v.taxPct)], [[], [15]]);
  assert.equal(notice(blankSecond.notices, PRODUCT_BLANK_TAX_DUPLICATE_NOTICE)?.count, 1);
  // وبلا عمود كود (الكود مولَّد من الاسم) كذلك: لا «صنفان بالاسم نفسه»
  const byName = prod([
    { 'اسم الصنف': 'ماء', 'الوحدة': 'حبة', 'الضريبة': '' },
    { 'اسم الصنف': 'ماء', 'الوحدة': 'حبة', 'الضريبة': 15 },
  ]);
  assert.deepEqual([byName.errors, byName.valid.length], [[], 1]);
  assert.equal(notice(byName.notices, PRODUCT_BLANK_TAX_DUPLICATE_NOTICE)?.count, 1);

  // التساهل في خانة الضريبة وحدها: ضريبتان صريحتان مختلفتان تبقيان خطأ صف
  const twoTax = prod([
    { 'كود الصنف': 'P1', 'اسم الصنف': 'ماء', 'سعر البيع': 1, 'الضريبة': 5 },
    { 'كود الصنف': 'P1', 'اسم الصنف': 'ماء', 'سعر البيع': 1, 'الضريبة': 15 },
  ]);
  assert.deepEqual(twoTax.errors.map((e) => [e.row, e.message, e.value]), [[3, PRODUCT_DUPLICATE_CODE, 'P1']]);
  // واختلاف حقل آخر مع الضريبة الفارغة يبقى خطأ صف (سعر مختلف)
  const priceDiff = prod([
    { 'كود الصنف': 'P1', 'اسم الصنف': 'ماء', 'سعر البيع': 1, 'الضريبة': '' },
    { 'كود الصنف': 'P1', 'اسم الصنف': 'ماء', 'سعر البيع': 9, 'الضريبة': 15 },
  ]);
  assert.deepEqual(priceDiff.errors.map((e) => [e.row, e.message]), [[3, PRODUCT_DUPLICATE_CODE]]);
  // والمطابق تماماً يبقى تنبيه التكرار القديم لا تنبيه الضريبة
  const same = prod([
    { 'كود الصنف': 'P2', 'اسم الصنف': 'رز', 'الضريبة': '' },
    { 'كود الصنف': 'P2', 'اسم الصنف': 'رز', 'الضريبة': '' },
  ]);
  assert.equal(notice(same.notices, PRODUCT_DUPLICATE_ROWS_NOTICE)?.count, 1);
  assert.equal(notice(same.notices, PRODUCT_BLANK_TAX_DUPLICATE_NOTICE), undefined);
  // وضريبة 0 صريحة ليست خانة فارغة: مقابل 15 خطأ صف
  const zeroTax = prod([
    { 'كود الصنف': 'P3', 'اسم الصنف': 'خبز', 'الضريبة': 0 },
    { 'كود الصنف': 'P3', 'اسم الصنف': 'خبز', 'الضريبة': 15 },
  ]);
  assert.deepEqual(zeroTax.errors.map((e) => e.message), [PRODUCT_DUPLICATE_CODE]);
});
