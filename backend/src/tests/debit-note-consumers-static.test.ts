// ZATCA المرحلة الثانية (Z5.5) — حارس مستهلكي بنود الفواتير أمام **بندٍ بلا صنف** (z5_plan §3 Z5.5 «قبل الشحن»).
//
// الإشعار المدين (383) صفٌّ من نوع CREDIT بنودُه وصفيّة: `productId = null`. وهو أوّل مستندٍ في المنصّة يكتب بنداً
// بلا صنف عن قصد، فكلّ قارئٍ لبنود الفواتير يمرّ عليه: مخزون السيارة، والتقارير، وكشف العميل، وتصدير ERP، والدفاتر.
// قارئٌ يفترض وجود الصنف يُسقط الصفحة بـ500 أو يفتح صفّاً بمفتاح فارغ يلوّث كل الأرصدة — وهو ما حرسه هذا الملف:
// إمّا استبعاد الصفوف بلا صنف في الاستعلام (`productId: { not: null }`)، وإمّا تخطّيها/تسميتها في الذاكرة.
// نصّي على المصدر: لا قاعدة بيانات ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

/** مقطعٌ من المصدر بين علامتين (لتحديد القارئ المقصود بدقّة). */
function between(src: string, from: string, to: string, label: string): string {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `${label}: بداية المقطع مفقودة (${from})`);
  const j = src.indexOf(to, i + from.length);
  assert.ok(j > i, `${label}: نهاية المقطع مفقودة (${to})`);
  return src.slice(i, j);
}

test('مخزون السيارة: بندٌ بلا صنف يُتخطّى ولا يفتح صفّاً بمفتاح فارغ', () => {
  const van = read('routes/vanStock.ts');
  const fold = between(van, 'export function foldStock(', 'export async function computeStock(', 'foldStock');
  assert.match(fold, /if \(!it\.productId\) continue;/, 'foldStock يجمع بنداً بلا صنف — يلوّث كل الأرصدة');
  // القارئان التنبّؤيّان يستبعدانه في الاستعلام نفسه
  assert.ok(van.split('productId: { not: null }').length - 1 >= 2, 'قارئ تنبّؤيّ بلا استبعاد البنود بلا صنف');
  // الصفّ المعروض يُبنى من بطاقة الصنف: بندٌ بلا بطاقة لا يظهر
  assert.match(van, /const p = prodById\.get\(pid\);\s*\n\s*if \(!p\) continue;/, 'صفّ مخزون بلا بطاقة صنف');
});

test('تقرير المبيعات: بندٌ بلا صنف يُجمَع تحت مفتاح واحد ولا يُسقط التقرير', () => {
  const reports = read('routes/reports.ts');
  const group = between(reports, "if (groupBy === 'product')", "if (groupBy === 'rep')", 'تجميع الأصناف');
  assert.match(group, /const ref = item\.product;/, 'التقرير يقرأ الصنف بلا وسيط');
  assert.match(group, /ref\?\.id \?\? 'unknown'/, 'مفتاح التجميع يفترض وجود الصنف (يسقط بـ500)');
  assert.match(group, /ref\?\.name \?\? /, 'اسم الصنف يُقرأ بلا حارس');
});

test('تصدير ERP: بنود الفاتورة تُقرأ بحقولها لا ببطاقة صنفها', () => {
  const erp = read('services/erp.ts');
  const invoices = between(erp, "if (resource === 'invoices')", 'return prisma.receipt.findMany', 'تصدير الفواتير');
  assert.doesNotMatch(invoices, /it\.product\.[a-zA-Z]/, 'التصدير يقرأ بطاقة الصنف بلا حارس — بندُ إشعارٍ مدين يسقطه');
  assert.match(invoices, /unitPriceNet: incl \? roundDecimal\(netFromInclusive\(it\.unitPrice, it\.taxPct\)/, 'حساب الصافي تغيّر');
});

test('حذف الصنف: العدّ لا يقع على بنود بلا صنف (لا يمنع حذفاً بسبب إشعار مدين)', () => {
  const products = read('routes/products.ts');
  assert.match(products, /prisma\.invoiceItem\.count\(\{ where: \{ productId: req\.params\.id \} \}\)/, 'عدّ بنود الصنف تغيّر');
});

test('الإشعار المدين نفسه: بنوده بلا صنف وصفّه لا يحمل مرتجعاً', () => {
  const notes = read('routes/invoicesNotes.ts');
  assert.match(notes, /productId: kind === 'CREDIT_NOTE' \? \(line\?\.productId \?\? null\) : null/, 'بند المدين قد يحمل صنفاً');
  const zatcaNotes = read('compliance/zatca/notes.ts');
  assert.match(zatcaNotes, /export function debitNoteLegacyColumns\(total: number\) \{\s*\n\s*return \{ type: 'CREDIT' as const/, 'صفّ المدين ليس آجلاً');
});
