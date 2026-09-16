import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importFieldOf, parseAccountType, parseBool, parseImportRows } from './accountImport';

test('مطابقة أعمدة الملف بالعربية والإنجليزية وتصدير Odoo', () => {
  assert.equal(importFieldOf('الرمز'), 'code');
  assert.equal(importFieldOf(' Account Code '), 'code');
  assert.equal(importFieldOf('اسم الحساب'), 'name');
  assert.equal(importFieldOf('الاسم الانجليزي'), 'nameEn');
  assert.equal(importFieldOf('Allow Reconciliation'), 'reconcile');
  assert.equal(importFieldOf('غير معروف'), null);
});

test('تحليل النوع: المفتاح والتسمية وتسميات Odoo', () => {
  assert.equal(parseAccountType('asset_cash'), 'asset_cash');
  assert.equal(parseAccountType('Bank and Cash'), 'asset_cash');
  assert.equal(parseAccountType('المدينون', [{ asset_receivable: 'المدينون' } as never]), 'asset_receivable');
  assert.equal(parseAccountType('???'), null);
  assert.equal(parseBool('نعم'), true);
  assert.equal(parseBool(''), false);
});

test('التحقق المبكر: رمز وأسماء عربية وتكرار وتسوية النقد', () => {
  const { rows, missingColumns } = parseImportRows([
    { 'الرمز': 611099, 'الاسم': 'مصروفات متنوعة', 'النوع': 'expense' },
    { 'الرمز': '611099', 'الاسم': 'مكرر', 'النوع': 'expense' },
    { 'الرمز': '12', 'الاسم': 'Misc', 'النوع': 'expense' },
    { 'الرمز': '111009', 'الاسم': 'صندوق فرعي', 'النوع': 'asset_cash', 'التسوية': 'نعم' },
    { 'الرمز': '319009', 'الاسم': 'أرباح', 'النوع': 'equity_unaffected' },
  ]);
  assert.deepEqual(missingColumns, []);
  assert.deepEqual(rows[0].row, { code: '611099', name: 'مصروفات متنوعة', nameEn: null, type: 'expense' });
  assert.deepEqual(rows[1].issues, ['DUPLICATE_IN_FILE']);
  assert.deepEqual(rows[2].issues, ['CODE_INVALID', 'NAME_NOT_ARABIC']);
  assert.deepEqual(rows[3].issues, ['RECONCILE_CASH']);
  assert.deepEqual(rows[4].issues, ['EQUITY_UNAFFECTED']);
  assert.equal(rows[0].line, 2);
  assert.deepEqual(parseImportRows([{ code: '1' }]).missingColumns, ['name', 'type']);
});
