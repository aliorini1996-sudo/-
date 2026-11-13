import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { CUSTOMER_PHONE_EXISTS, phoneDupBody, phoneDupExempt } from '../services/customerPhoneDup';
import { normImportPhone } from '../services/importMatch';

// «منع تكرار جوال العميل داخل الشركة» (طلب المالك ١٣ نوفمبر ٢٠٢٦)

test('الإعفاء: مفتاح API وإعادة رفع صندوق المندوب وحدهما', () => {
  assert.equal(phoneDupExempt({ headers: {}, user: { apiKeyId: 'k1' } }), true, 'مفتاح API — «الخادم لا يرفض في النقل»');
  assert.equal(phoneDupExempt({ headers: { 'x-fs-replay': '1' }, user: {} }), true, 'صندوق المندوب');
  assert.equal(phoneDupExempt({ headers: {}, user: {} }), false, 'الإدخال الحيّ يُمنع');
  assert.equal(phoneDupExempt({ headers: { 'x-fs-replay': '0' }, user: null }), false);
});

test('ردّ 409: اسم العميل الآخر لمن يراه وحده', () => {
  const seen = phoneDupBody({ id: 'c9', name: 'بقالة النور' }, true);
  assert.equal(seen.code, CUSTOMER_PHONE_EXISTS);
  assert.match(seen.message, /«بقالة النور»/);
  assert.equal((seen as { existingId?: string }).existingId, 'c9');
  const hidden = phoneDupBody({ id: 'c9', name: 'بقالة النور' }, false);
  assert.doesNotMatch(hidden.message, /بقالة/);
  assert.equal((hidden as { existingId?: string }).existingId, undefined, 'لا يُكشف عميلٌ غير مُسنَد');
});

test('المطابقة بالرقم المطبَّع: الصيغ الدولية والمحلية والأرقام الهندية رقمٌ واحد، والفارغ والتافه لا يُطابَق', () => {
  const k = normImportPhone('0551234567');
  for (const v of ['+966 55 123 4567', '00966551234567', '966551234567', '٠٥٥١٢٣٤٥٦٧', '551234567']) assert.equal(normImportPhone(v), k, v);
  for (const v of ['', '   ', '0000000000', '123']) assert.equal(normImportPhone(v), null, v);
});

test('الحارس موصول في الإنشاء قبل الكتابة، وفي التعديل حين يتغيّر الجوال وحده', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'routes', 'customers.ts'), 'utf8').replace(/\r\n/g, '\n');
  const post = s.indexOf('const dup = await findPhoneDuplicate(tid, rest.phone);');
  assert.ok(post > 0 && post < s.indexOf('const customer = await prisma.customer.create({', post), 'قبل الإنشاء');
  assert.ok(s.includes("&& data.phone.trim() !== String(exists.phone ?? '').trim()) {"), 'التعديل: الجوال نفسه لا يُفحص');
  assert.ok(s.includes('const dup = await findPhoneDuplicate(tid, data.phone, req.params.id);'), 'التعديل يستثني العميل نفسه');
  assert.equal((s.match(/!phoneDupExempt\(req\)/g) ?? []).length, 2);
  const svc = fs.readFileSync(path.join(__dirname, '..', 'services', 'customerPhoneDup.ts'), 'utf8');
  assert.match(svc, /"tenantId" = \$\{tid\} AND status <> 'DELETED'/, 'داخل الشركة، والمحذوف لا يُعدّ');
});
