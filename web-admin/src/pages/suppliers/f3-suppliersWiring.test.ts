import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AGING_COLUMNS, PAYMENT_METHOD_LABELS, PAYMENT_PROBLEM_TEXT, STATEMENT_KIND_LABELS, SUPPLIER_ERROR_TEXT, SUPPLIER_PROBLEM_TEXT, paymentDaysText,
  referenceLabel,
} from './supplierLogic';

/**
 * «الموردون» في لوحة الويب (/app/suppliers) — توصيلٌ يُحرس نصّاً: المسار والقائمة خلف شرط «مخزون الشركة» نفسه، والصفحة لا
 * تجلب قبل المحاسبة وعَلَم المستودع، وورقة سند الصرف بعناصرها الإلزامية، والعقد في api/suppliers.ts بدواله وأنواعه.
 */

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
/** المصدر بلا تعليقات — الحارس على الكود لا على شرحه */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

test('App.tsx: الصفحة كسولة خلف صلاحية المستودع (canManageVanStock) كمسار /app/warehouse', () => {
  const s = code(read('App.tsx'));
  assert.match(s, /const SuppliersPage = lazy\(\(\) => import\('\.\/pages\/suppliers\/SuppliersPage'\)\);/);
  assert.match(s, /<Route path="suppliers" element=\{<PermissionRoute permission="canManageVanStock"><SuppliersPage \/><\/PermissionRoute>\} \/>/);
});

test('MainLayout: البند بصلاحية المستودع وخلف عَلَم مخزون الشركة (true صريحة) والمحاسبة — والتشغيلات تبقى بعد المستودع مباشرة', () => {
  const s = code(read('layouts', 'MainLayout.tsx'));
  assert.ok(s.includes("{ to: '/app/suppliers', icon: Handshake, label: 'nav.suppliers', permission: 'canManageVanStock' }"));
  const pages = /const ACCOUNTING_PAGES = \[([^\]]*)\];/.exec(s)?.[1] ?? '';
  assert.ok(pages.includes("'/app/suppliers'"), 'المحاسبة المطفأة تُخفي البند');
  assert.match(s, /\(\(item\.to !== '\/app\/warehouse' && item\.to !== '\/app\/suppliers'\) \|\| companyCfg\?\.warehouseEnabled === true\)/);
  const wh = s.indexOf("{ to: '/app/warehouse'");
  const lots = s.indexOf("{ to: '/app/lots'");
  const sup = s.indexOf("{ to: '/app/suppliers'");
  assert.ok(wh > 0 && lots > wh && sup > lots, 'الموردون بعد المستودع والتشغيلات');
});

test('SuppliersPage: لا عرض قبل المحاسبة وعَلَم المستودع، ولافتةٌ صريحة لا جدولٌ فارغ', () => {
  const s = code(read('pages', 'suppliers', 'SuppliersPage.tsx'));
  assert.match(s, /useAccountingOn\(\)/);
  assert.match(s, /if \(!accountingOn\) return <AccountingOffNotice \/>;/);
  assert.match(s, /const warehouseOn = company\?\.warehouseEnabled === true;/);
  assert.match(s, /if \(!warehouseOn\) \{/);
  // الحذف بتاريخٍ يعرض الأرشفة بديلاً (رمز الخادم لا نصّه)
  assert.match(s, /serverCodeOf\(e\) === 'SUPPLIER_HAS_HISTORY'/);
  // الكتابة لمن يملك صلاحية المستودع
  assert.match(s, /const canEdit = me\?\.canManageVanStock !== false;/);
});

test('ورقة سند الصرف: SP- والمستفيد والمبلغ والطريقة والتخصيصات وتوقيعان، والملغى بختمه — وبلا رقمٍ ضريبي لشركةٍ بلا ضريبة', () => {
  const s = code(read('pages', 'suppliers', 'SupplierPaymentVoucher.tsx'));
  for (const needle of ["p.displayNumber", "tr('صرفنا إلى')", "formatCurrency(p.amount)", "paymentMethodLabel(p.method)", "p.allocations.map",
    "tr('توقيع المستلم')", "tr('توقيع المحاسب')", "tr('ملغى')", "tr('دفعة مقدمة غير مخصصة لفاتورة')"]) {
    assert.ok(s.includes(needle), needle);
  }
  assert.match(s, /isTaxOff\(company\) \? \{ \.\.\.company, taxNumber: undefined \} : company/);
  assert.match(s, /!taxOff && supplier\?\.vatNumber/);
});

test('كشف الحساب: المرفقات بنافذة المستودع القائمة، والتصدير بأدوات المشروع (Excel وPDF) وCSV', () => {
  const s = code(read('pages', 'suppliers', 'SupplierStatementTab.tsx'));
  assert.match(s, /import EntryAttachmentsModal/);
  assert.match(s, /exportExcel\(\[statementSheet/);
  assert.match(s, /elementsToPdfBlob\(slices\)/);
  assert.match(s, /toCsv\(statementRows/);
});

test('سند الصرف الجديد: مرجع المحاولة من الجسم (إعادةٌ آمنة) ويُبطل كاش المستودع بعد الحفظ', () => {
  const s = code(read('pages', 'suppliers', 'SupplierPaymentModal.tsx'));
  assert.match(s, /const next = entryAttempt\(attempt, body\);/);
  assert.match(s, /supplierPaymentsApi\.create\(\{ \.\.\.body, clientRef: next\.ref \}\)/);
  assert.match(s, /invalidateQueries\(\{ queryKey: \['warehouse-entries'\] \}\)/);
});

test('api/suppliers.ts: دوال العقد كلها بمساراتها', () => {
  const s = code(read('api', 'suppliers.ts'));
  for (const needle of [
    "api.get('/suppliers'", "api.get(`/suppliers/${id}`)", "api.post('/suppliers', body)", "api.put(`/suppliers/${id}`, body)",
    "api.delete(`/suppliers/${id}`)", "api.get(`/suppliers/${id}/statement`", "api.get(`/suppliers/${id}/open-bills`)", "api.get('/suppliers/aging'",
    "api.get('/supplier-payments'", "api.get(`/supplier-payments/${id}`)", "api.post('/supplier-payments', body)", "api.post(`/supplier-payments/${id}/cancel`",
  ]) assert.ok(s.includes(needle), needle);
  for (const t of ['interface Supplier ', 'interface SupplierStatementLine', 'interface SupplierStatement ', 'interface OpenBill', 'interface SupplierPaymentView']) {
    assert.ok(s.includes(`export ${t}`), t);
  }
});

test('كل نصٍّ يمرّ إلى tr بمتغيّر مترجَمٌ في القاموس (يُدمج من i18n/F3.json)', () => {
  const dict = read('i18n', 'strings.ts');
  const have = new Set([...dict.matchAll(/^\s*'((?:[^'\\]|\\.)*)'\s*:\s*\{/gm)].map(m => m[1]));
  const tr = (x: string) => x;
  const keys = [
    ...Object.values(STATEMENT_KIND_LABELS), ...Object.values(PAYMENT_METHOD_LABELS), ...Object.values(SUPPLIER_ERROR_TEXT),
    ...Object.values(SUPPLIER_PROBLEM_TEXT), ...Object.values(PAYMENT_PROBLEM_TEXT), ...AGING_COLUMNS.map(c => c.label),
    referenceLabel('CHEQUE'), referenceLabel('BANK_TRANSFER'), referenceLabel('CASH'), paymentDaysText(null, tr), paymentDaysText(0, tr),
  ];
  // تسميات الشاشات الثابتة التي تمرّ بمتغيّر (أوضاع التخصيص وتبويبات المورّد)
  for (const f of ['SupplierPaymentModal.tsx', 'SuppliersPage.tsx']) {
    for (const m of read('pages', 'suppliers', f).matchAll(/(?:label|hint): '([^']+)'/g)) keys.push(m[1]);
    for (const m of read('pages', 'suppliers', f).matchAll(/(?:statement|bills|payments): '([^']+)'/g)) keys.push(m[1]);
  }
  const missing = [...new Set(keys)].filter(k => /[؀-ۿ]/.test(k) && !have.has(k));
  assert.deepEqual(missing, [], `بلا ترجمة: ${missing.join(' | ')}`);
});
