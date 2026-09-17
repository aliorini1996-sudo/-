import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MANUAL_BALANCE_ISSUES, OPENING_BALANCE_TEMPLATE_COLUMNS, cleanManualRows, clampStep, compactBoxes, effectiveCutover, fiscalYearStart, initialStep1, isVatPeriodStart, manualTotalsMilli,
  milliText, needsMidPeriodConfirm, normalizeDueDate, openingDateOf, openingFieldOf, parseOpeningBalanceRecords,
} from './setupLogic';
import type { SetupEffective } from '../../../api/ledgerSetup';

/**
 * معالج الإعداد (M3، §5.6): منطق الواجهة الصرف، ومرآة ثوابت الخادم (أعمدة القالب وأسباب الصفوف وحد فترة الإقرار)،
 * وحراس نصية على الصفحات: الإقرار بالسجلات النظامية قبل التفعيل، والمعاينة لا تُرسل للاعتماد، والصلاحية.
 */

const backend = path.resolve(process.cwd(), '..', 'backend', 'src');
const webSrc = path.resolve(process.cwd(), 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');

test('ثوابت الأرصدة اليدوية مرآة services/gl/opening.ts', () => {
  const s = read(backend, 'services', 'gl', 'opening.ts');
  assert.match(read(backend, 'routes', 'ledger', 'setup.ts'), /rows: z\.array\(manualRowSchema\)\.max\(5000\)/, 'سقف الصفوف');
  const cols = /OPENING_BALANCE_TEMPLATE_COLUMNS\s*=\s*\[([^\]]*)\]/.exec(s)?.[1] ?? '';
  assert.deepEqual([...cols.matchAll(/'(\w+)'/g)].map(m => m[1]), [...OPENING_BALANCE_TEMPLATE_COLUMNS]);
  const issues = /MANUAL_BALANCE_ISSUES\s*=\s*\[([^\]]*)\]/.exec(s)?.[1] ?? '';
  assert.deepEqual([...issues.matchAll(/'(\w+)'/g)].map(m => m[1]), [...MANUAL_BALANCE_ISSUES]);
});

test('حد فترة الإقرار: تقويمي للدوريات، وبداية السنة المالية لـFISCAL_YEAR', () => {
  assert.equal(isVatPeriodStart('2026-01-01', 'QUARTERLY'), true);
  assert.equal(isVatPeriodStart('2026-04-01', 'QUARTERLY'), true);
  assert.equal(isVatPeriodStart('2026-05-01', 'QUARTERLY'), false);
  assert.equal(isVatPeriodStart('2026-05-01', 'MONTHLY'), true);
  assert.equal(isVatPeriodStart('2026-05-02', 'MONTHLY'), false);
  assert.equal(isVatPeriodStart('2026-07-01', 'SEMIANNUAL'), true);
  assert.equal(isVatPeriodStart('2026-06-01', 'FISCAL_YEAR', 5, 31), true);
  assert.equal(isVatPeriodStart('2026-01-01', 'FISCAL_YEAR', 5, 31), false);
  assert.equal(fiscalYearStart('2026-09-17', 12, 31), '2026-01-01');
  assert.equal(fiscalYearStart('2026-02-15', 2, 28), '2025-03-01');
  assert.equal(fiscalYearStart('2026-03-01', 2, 28), '2026-03-01');
  assert.equal(fiscalYearStart('2024-02-29', 2, 29), '2023-03-01', 'نهاية فبراير مقصوصة في السنة غير الكبيسة');
  assert.equal(needsMidPeriodConfirm('SA_6D', '2026-05-01', 'QUARTERLY', 12, 31), true);
  assert.equal(needsMidPeriodConfirm('GENERIC_6D', '2026-05-01', 'QUARTERLY', 12, 31), false, 'القالب العام بلا شرط');
  assert.equal(needsMidPeriodConfirm('SA_6D', '2026-04-01', 'QUARTERLY', 12, 31), false);
  // مطابقة مصدر الخادم: جدول الأشهر نفسه
  const s = read(backend, 'services', 'gl', 'opening.ts');
  assert.match(s, /MONTHLY: 1, BIMONTHLY: 2, QUARTERLY: 3, FOUR_MONTHS: 4, SEMIANNUAL: 6, ANNUAL: 12/);
});

test('التاريخ الفعلي والقيد الافتتاحي', () => {
  assert.equal(effectiveCutover('OPENING', '2026-07-01', '2024-01-01'), '2026-07-01');
  assert.equal(effectiveCutover('FULL_HISTORY', '2026-07-01', '2024-01-01'), '2024-01-01');
  assert.equal(effectiveCutover('FULL_HISTORY', '2026-07-01', null), '2026-07-01', 'بلا مستندات ⇒ تاريخ الطريقة (أ)');
  assert.equal(openingDateOf('2026-01-01'), '2025-12-31');
  assert.equal(clampStep(9), 1);
  assert.equal(clampStep('4'), 4);
  const eff: SetupEffective = {
    templateKey: 'SA_6D', countryCode: 'SA', timezone: 'Asia/Riyadh', fiscalYearEndMonth: 12, fiscalYearEndDay: 31, weekStartsOn: 0,
    taxPeriodicity: 'QUARTERLY', method: 'OPENING', cutoverDate: null, confirmMidVatPeriod: false, preCutoverBoxes: null,
  };
  assert.equal(initialStep1({}, eff, '2026-01-01').cutoverDate, '2026-01-01', 'المقترح حين لا مسودة');
  assert.equal(initialStep1({ step1: { cutoverDate: '2026-07-01', taxPeriodicity: 'MONTHLY' } }, eff, '2026-01-01').taxPeriodicity, 'MONTHLY');
  assert.deepEqual(compactBoxes({ 'SA_1.amount': ' 100 ', 'SA_1.tax': '' }), { 'SA_1.amount': '100' });
  assert.equal(compactBoxes({ 'SA_1.tax': ' ' }), null);
});

test('استيراد XLSX: عناوين عربية أو إنجليزية، وتواريخ، وتجاهل الفارغ، والأعمدة الناقصة', () => {
  assert.equal(openingFieldOf('رمز الحساب'), 'accountCode');
  assert.equal(openingFieldOf('Account Code'), 'accountCode');
  assert.equal(openingFieldOf('اسم المورّد'), 'vendorName');
  assert.equal(openingFieldOf('due_date'), 'dueDate');
  const r = parseOpeningBalanceRecords([
    { 'رمز الحساب': 111001, 'مدين': 1500.5, 'دائن': '', 'المورد': '', 'تاريخ الاستحقاق': '' },
    { 'رمز الحساب': '211001', 'مدين': '', 'دائن': '2,000', 'المورد': ' مؤسسة النور ', 'تاريخ الاستحقاق': new Date(Date.UTC(2026, 9, 31)) },
    { 'رمز الحساب': '', 'مدين': '', 'دائن': '', 'المورد': '', 'تاريخ الاستحقاق': '' },
    { 'رمز الحساب': '311001', 'مدين': '', 'دائن': '500', 'المورد': '', 'تاريخ الاستحقاق': '15/11/2026' },
  ]);
  assert.deepEqual(r.missingColumns, []);
  assert.equal(r.skippedEmpty, 1);
  assert.deepEqual(r.rows, [
    { accountCode: '111001', debit: '1500.5', credit: null },
    { accountCode: '211001', debit: null, credit: '2,000', vendorName: 'مؤسسة النور', dueDate: '2026-10-31' },
    { accountCode: '311001', debit: null, credit: '500', dueDate: '2026-11-15' },
  ]);
  assert.deepEqual(parseOpeningBalanceRecords([{ code: '1', label: 'x' }]).missingColumns, ['debit', 'credit']);
  assert.equal(normalizeDueDate('٢٠٢٦-١٢-٠١'), '2026-12-01');
  assert.equal(normalizeDueDate('غدا'), 'غدا', 'غير الصالح يمر ليرفضه الخادم بـINVALID_DUE_DATE');
});

test('الصفوف المرسلة ومجاميعها بالمللي', () => {
  const rows = cleanManualRows([
    { accountCode: ' 111001 ', debit: '١٬٢٥٠٫٥', credit: '' },
    { accountCode: '', debit: '', credit: '' },
    { accountCode: '211001', debit: '', credit: '1,250.50', vendorName: ' النور ' },
  ]);
  assert.deepEqual(rows, [
    { accountCode: '111001', debit: '1250.5', credit: null },
    { accountCode: '211001', debit: null, credit: '1250.50', vendorName: 'النور' },
  ]);
  const t = manualTotalsMilli(rows, 2);
  assert.equal(t.debit, 1_250_500n);
  assert.equal(t.credit, 1_250_500n);
  assert.equal(milliText(t.debit - t.credit - 5n), '-0.005');
  assert.equal(manualTotalsMilli([{ accountCode: 'x', debit: 'abc' }], 2).invalid, 1);
});

test('حراس الصفحات: الإقرار النظامي قبل التفعيل، والمعاينة للقراءة، والصلاحية', () => {
  const api = read(webSrc, 'api', 'ledgerSetup.ts');
  assert.match(api, /acknowledgeStatutory: true/, 'الاعتماد يرسل الإقرار بالسجلات النظامية');
  const review = read(webSrc, 'pages', 'ledger', 'setup', 'SetupReview.tsx');
  assert.ok(review.includes("tr('التفعيل يُنشئ سجلات محاسبية نظامية: بعد أول ترحيل لا تُحذف الدفاتر ولا يُعاد ضبطها، والتصحيح بقيود عكسية أو تسوية')"), 'نص G6 الحرفي من §5.6');
  assert.match(review, /disabled=\{[^}]*!ack/, 'زر التفعيل معطّل قبل الإقرار');
  const wizard = read(webSrc, 'pages', 'ledger', 'setup', 'SetupWizard.tsx');
  assert.match(wizard, /canLedger\(user, 'canConfigureLedger'\)|useLedgerCan\('canConfigureLedger'\)/);
  const home = read(webSrc, 'pages', 'ledger', 'LedgerHome.tsx');
  assert.match(home, /SetupWizard/);
  assert.match(home, /canConfigure\s*\?/, 'المعالج لمن يملك canConfigureLedger وإلا «بانتظار الإعداد»');
  // المعاينة لا تُخزَّن ولا تُمرَّر أرقامها إلى الاعتماد (§5.6 الخطوة 4)
  assert.doesNotMatch(review, /commit\([^)]*opening/);
});
