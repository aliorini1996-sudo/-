// تقارير المشتريات والربح والضرائب — إصلاحات الواجهة (١٨ نوفمبر ٢٠٢٦):
// ١) اسم ورقة Excel يُنظَّف في موضعٍ واحد (utils/sheetName عبر utils/excel buildBlob): ترجمةٌ فيها «:» كالتركية لا تُسقط التصدير.
// ٢) ما يُعرض صفراً بلا إشارة: نفي سطر المرتجعات الصفري (lib/money negAmount)، وformatCurrency وnum لا يطبعان «‎-0».
// ٣) تبويب «الربح» بشرطَي المشتريات: مخزون الشركة مفعّل وصلاحية المستودع — وإلا لا تبويب ولا طلب.
// ٤) سقف تقرير الربح المعلَن (meta.truncated) يظهر على الشاشة وفي ملاحظة الملف.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as XLSX from 'xlsx';
import { sheetNameOf, SHEET_NAME_MAX } from '../../utils/sheetName';
import { negAmount } from '../../lib/money';
import { formatCurrency } from '../../utils/format';
import { num } from '../../utils/excel';

const read = (rel: string) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** يبني مصنَّفاً بالأسماء كما يفعل buildBlob ويكتبه — يرمي إن رفضت المكتبة اسماً */
function writeBook(names: string[], clean: boolean): string[] {
  const wb = XLSX.utils.book_new();
  const taken = new Set<string>();
  for (const n of names) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ a: 1 }]), clean ? sheetNameOf(n, taken) : n);
  XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return wb.SheetNames;
}

test('اسم الورقة: الترجمة التركية «KDV dağılımı: Ay» كانت ترمي في SheetJS، والمنظَّف يُكتب ملفاً', () => {
  assert.throws(() => writeBook(['KDV dağılımı: Ay'], false), /Sheet name cannot contain/);
  assert.deepEqual(writeBook(['Beyanname özeti', 'KDV dağılımı: Ay'], true), ['Beyanname özeti', 'KDV dağılımı Ay']);
  assert.deepEqual(writeBook(['KDV dağılımı: Çeyrek', 'KDV dağılımı: Vergi oranı'], true), ['KDV dağılımı Çeyrek', 'KDV dağılımı Vergi oranı']);
});

test('اسم الورقة: كل المحارف الممنوعة والفاصلة العليا على الحافة و«History» والفارغ والطول والتكرار — والمكتبة تقبل الناتج', () => {
  const t = new Set<string>();
  assert.equal(sheetNameOf('a/b\\c?d*e[f]g:h', t), 'a b c d e f g h');
  assert.equal(sheetNameOf("'مقتبس'", t), 'مقتبس');
  assert.equal(sheetNameOf('history', t), 'History (1)');
  assert.equal(sheetNameOf('   ', t), 'Sheet');
  assert.equal(sheetNameOf('::', t), 'Sheet (2)', 'الفارغ بعد التنظيف مكرَّرٌ فيُرقَّم');
  const long = 'تقرير المشتريات حسب المورد والصنف والشهر';
  const a = sheetNameOf(long, t);
  const b = sheetNameOf(long, t);
  assert.ok(a.length <= SHEET_NAME_MAX && b.length <= SHEET_NAME_MAX);
  assert.notEqual(a.toLowerCase(), b.toLowerCase(), 'اسمان يتطابقان بعد القصّ يُفرَّقان');
  assert.ok(b.endsWith(' (2)'));
  assert.equal(sheetNameOf('Summary', t), 'Summary');
  assert.equal(sheetNameOf('SUMMARY', t), 'SUMMARY (2)', 'بلا تمييز حالة الأحرف كما يقارن Excel');
  // محرفٌ مزدوج عند الحدّ لا يُشطر
  const emoji = sheetNameOf(`${'x'.repeat(30)}😀`, new Set());
  assert.equal(emoji, 'x'.repeat(30));
  writeBook([long, long, long, 'a/b', "'q'", 'History', '', 'KDV dağılımı: Ay', `${'x'.repeat(30)}😀`], true);
});

test('صفرٌ بلا إشارة: نفي سطر المرتجعات الصفري، وformatCurrency وnum لا يطبعان «‎-0»', () => {
  assert.ok(Object.is(negAmount(0), 0), 'نفي الصفر صفرٌ موجب');
  assert.equal(negAmount(15), -15);
  assert.equal(negAmount(-3), 3);
  assert.ok(Object.is(-0, -(0)), 'عين الخلل: النفي الساذج ‎-0');
  for (const z of [-0, -0.001, '-0']) {
    assert.equal(formatCurrency(z as number, 'SAR'), formatCurrency(0, 'SAR'), `formatCurrency(${String(z)})`);
  }
  assert.notEqual(formatCurrency(-0.01, 'SAR'), formatCurrency(0, 'SAR'), 'سالبٌ حقيقي يبقى سالباً');
  assert.notEqual(formatCurrency(-0.005, 'SAR'), formatCurrency(0, 'SAR'), 'نصف الهللة يُقرَّب لا يُصفَّر');
  assert.equal(formatCurrency(-0.0004, 'KWD'), formatCurrency(0, 'KWD'), 'بمنازل العملة (٣ للدينار)');
  assert.ok(Object.is(num(-0, 2), 0));
  assert.ok(Object.is(num(-0.001, 2), 0));
  assert.equal(num(-1.005, 2), -1);
});

test('ملخص الإقرار وتصديره: المطروح بـnegAmount لا بالنفي الساذج', () => {
  const src = read('components/reports/TaxReport.tsx');
  assert.match(src, /base: negAmount\(s\.output\.returns\.base\), tax: negAmount\(s\.output\.returns\.tax\)/);
  assert.match(src, /base: negAmount\(s\.input\.returns\.base\), tax: negAmount\(s\.input\.returns\.tax\)/);
  assert.match(src, /n\(negAmount\(r\.output\.returnsTax\)\)/);
  assert.doesNotMatch(src, /[:(]\s*-(s|r)\.(output|input)\./, 'لا نفي ساذج باقٍ');
  // واسم الورقة لا يُقصّ هنا (ينظّفه buildBlob) — والتصدير يمرّ بالمنظِّف
  const excel = read('utils/excel.ts');
  assert.match(excel, /XLSX\.utils\.book_append_sheet\(wb, ws, sheetNameOf\(s\.name, taken\)\)/);
});

test('تبويب «الربح» بشرطَي المشتريات: مخزون الشركة وصلاحية المستودع — في القائمة والسماح والطلب', () => {
  const src = read('pages/ReportsPage.tsx');
  assert.match(src, /const profitOn = accountingOn && companyQ\.data\?\.warehouseEnabled === true && me\?\.canManageVanStock !== false;/);
  assert.match(src, /t === 'profit' \? profitOn/);
  assert.doesNotMatch(src, /t === 'sales' \|\| t === 'collections' \|\| t === 'profit'/, 'لا يكفي المحاسبة وحدها');
  assert.match(src, /\.\.\.\(profitOn \? \[\{ id: 'profit' as Tab/);
  assert.match(src, /onExportRows=\{setProfitExport\} enabled=\{accountingReady && profitOn\}/);
});

test('سقف تقرير الربح: meta.truncated يُقرأ ويُعلَن على الشاشة وفي ملاحظة الملف', () => {
  const src = read('components/reports/ProfitReport.tsx');
  assert.match(src, /trunc: truncationOf\(res\.data\)/);
  assert.equal(src.split("truncationNote(data.trunc, tr, formatNumber, 'newest')").length - 1, 1, 'ملاحظة الملف');
  assert.match(src, /const truncNote = truncationNote\(data\?\.trunc, tr, formatNumber, 'newest'\);/);
  assert.match(src, /\{truncNote && <div className=\{noteCls\}>\{truncNote\}<\/div>\}/);
});
