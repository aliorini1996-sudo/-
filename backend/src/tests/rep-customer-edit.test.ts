import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * حرّاس «تعديل بيانات العميل» من تطبيق المندوب — اختبارٌ ثابت يقرأ المصدر.
 *
 * الصلاحية تفتح البيانات الوصفية لا الشروط المالية: مندوبٌ يرفع الحدّ الائتمانيّ لعميله
 * يتجاوز ضابط الائتمان الذي وُضع ليحاسبه. والتطبيق يرسل تعديلاً جزئياً (بلا بريد)،
 * فكتابة `email: data.email || null` دون شرطٍ كانت ستمحو بريد العميل مع كل تعديل.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

const putHandler = () => {
  const src = read('src', 'routes', 'customers.ts');
  const start = src.indexOf("router.put('/:id',");
  assert.ok(start >= 0, 'مسار تعديل العميل غير موجود');
  const end = src.indexOf('router.', start + 20);
  return src.slice(start, end);
};

test('المندوب يحتاج canEditCustomer صريحة لتعديل العميل', () => {
  const h = putHandler();
  assert.match(h, /select: \{ canEditCustomer: true/);
  assert.match(h, /if \(!rep\?\.canEditCustomer\)/);
});

test('الشروط المالية وحالة العميل تُنزع من تعديل المندوب قبل الكتابة', () => {
  const h = putHandler();
  const strip = h.indexOf('delete data.creditLimit; delete data.paymentDays; delete data.status;');
  assert.ok(strip > 0, 'لا نزع للحقول المالية من تعديل المندوب');
  assert.ok(h.slice(Math.max(0, strip - 200), strip).includes("req.user?.role === 'SALES_REP'"), 'النزع ليس مقصوراً على المندوب');
  assert.ok(strip < h.indexOf('prisma.customer.update'), 'النزع بعد الكتابة لا قبلها');
});

test('التعديل الجزئيّ لا يمحو البريد: يُكتب فقط إن أُرسل', () => {
  const h = putHandler();
  assert.doesNotMatch(h, /data: \{ \.\.\.data, email: data\.email \|\| null/, 'البريد يُكتب null مع كل تعديل جزئيّ');
  assert.match(h, /data\.email !== undefined && \{ email: data\.email \|\| null \}/);
});

test('تطبيق المندوب: زرّ التعديل خلف الصلاحية الصريحة، والشاشة لا ترسل حقلاً مالياً', () => {
  const app = read('..', 'web-admin', 'src', 'rep', 'RepApp.tsx');
  assert.match(app, /perms\.canEditCustomer === true && !unassigned/);
  const start = app.indexOf('function EditCustomer(');
  assert.ok(start > 0, 'شاشة تعديل العميل غير موجودة');
  const body = app.slice(start, app.indexOf('\nfunction ', start + 30));
  for (const f of ['creditLimit', 'paymentDays', 'status:']) assert.ok(!body.includes(f), `الشاشة ترسل ${f}`);
  assert.match(body, /repApi\.put\(`\/customers\/\$\{customer\.id\}`/);
  // المقيَّد بنطاق العميل لا يحرّك نقطة العميل من الواجهة أيضاً
  assert.match(body, /if \(!pinLocked\)/);
});
