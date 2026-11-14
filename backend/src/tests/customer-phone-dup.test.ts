import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { phoneDupExempt } from '../services/customerPhoneDup';

// «منع تكرار جوال العميل داخل الشركة» (27d8ce1، ١٣ نوفمبر ٢٠٢٦) — فكّ المالك قيده ١٤ نوفمبر ٢٠٢٦: جوال العميل حرّ

test('القيد مفكوك: لا فحص تكرار جوال في إنشاء العميل ولا تعديله، ولا رمز CUSTOMER_PHONE_EXISTS', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'routes', 'customers.ts'), 'utf8');
  assert.doesNotMatch(s, /findPhoneDuplicate|phoneDupBody|CUSTOMER_PHONE_EXISTS/);
  const svc = fs.readFileSync(path.join(__dirname, '..', 'services', 'customerPhoneDup.ts'), 'utf8');
  assert.doesNotMatch(svc, /findPhoneDuplicate|phoneDupBody|CUSTOMER_PHONE_EXISTS|prisma/);
});

test('الإعفاء باقٍ لمنع تكرار الموقع: مفتاح API وإعادة رفع صندوق المندوب وحدهما', () => {
  assert.equal(phoneDupExempt({ headers: {}, user: { apiKeyId: 'k1' } }), true, 'مفتاح API — «الخادم لا يرفض في النقل»');
  assert.equal(phoneDupExempt({ headers: { 'x-fs-replay': '1' }, user: {} }), true, 'صندوق المندوب');
  assert.equal(phoneDupExempt({ headers: {}, user: {} }), false, 'الإدخال الحيّ يُفحص موقعه');
  assert.equal(phoneDupExempt({ headers: { 'x-fs-replay': '0' }, user: null }), false);
});
