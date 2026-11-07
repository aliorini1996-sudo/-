import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUSTOMER_PHONE_MAX, customerPhoneValue, customerSubline, customerWaHref, hasWaTarget, waDigits } from './customerPhone';

/**
 * جوال العميل حرٌّ تماماً في تطبيق المندوب (أمر المالك، ٧ نوفمبر ٢٠٢٦: «فك القيد بالكامل» و«اجعل تسجيل
 * الجوال ليس اجباري»): يُحفظ بلا جوال وبأيّ صيغة، والفارغ أو العبث لا يُستهدف برسالة ولا يُعرض بفاصلٍ يتيم.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repApp = fs.readFileSync(path.join(here, 'RepApp.tsx'), 'utf8');
const strings = fs.readFileSync(path.join(here, '..', 'i18n', 'strings.ts'), 'utf8');

test('القيمة المرسلة: مقصوصة الأطراف و\'\' للفارغ — بلا حدّ أدنى ولا صيغة ولا اقتطاع صامت', () => {
  assert.equal(customerPhoneValue(''), '');
  assert.equal(customerPhoneValue('   '), '');
  assert.equal(customerPhoneValue(null), '');
  assert.equal(customerPhoneValue(undefined), '');
  assert.equal(customerPhoneValue(' 123 '), '123');
  assert.equal(customerPhoneValue('ext 5'), 'ext 5');
  assert.equal(customerPhoneValue('٠٥٥١٢٣٤٥٦٧'), '٠٥٥١٢٣٤٥٦٧');
  const long = '1'.repeat(40);
  assert.equal(customerPhoneValue(long), long, 'الخادم حَكَم الطول — لا يُقتطع رقمٌ قديم بصمت عند التعديل');
  assert.equal(CUSTOMER_PHONE_MAX, 30);
});

test('أرقام واتساب: تطبيع السعودي المحلي، و00 الدولية، والأرقام العربية تُقرأ', () => {
  assert.equal(waDigits('0551234567'), '966551234567');
  assert.equal(waDigits('551234567'), '966551234567');
  assert.equal(waDigits('00971501234567'), '971501234567');
  assert.equal(waDigits('+966 55 123 4567'), '966551234567');
  assert.equal(waDigits('٠٥٥١٢٣٤٥٦٧'), '966551234567');
  assert.equal(waDigits('۰۵۵۱۲۳۴۵۶۷'), '966551234567');
  assert.equal(waDigits(''), '');
  assert.equal(waDigits(null), '');
  assert.equal(waDigits('بلا رقم'), '');
});

test('الفارغ والعبث لا يُستهدفان: رابط واتساب بلا رقم فيختار المندوب جهة الاتصال', () => {
  const text = encodeURIComponent('مرحبا');
  for (const junk of ['', '   ', null, undefined, '12', '٠١٢', 'abc', '123456']) {
    assert.equal(hasWaTarget(junk), false, String(junk));
    assert.equal(customerWaHref(junk, text), `https://wa.me/?text=${text}`, String(junk));
  }
  assert.equal(hasWaTarget('0551234567'), true);
  assert.equal(customerWaHref('0551234567', text), `https://wa.me/966551234567?text=${text}`);
  assert.equal(customerWaHref('+971 50 123 4567', text), `https://wa.me/971501234567?text=${text}`);
});

test('سطر بطاقة العميل: الفارغ يسقط بفاصله', () => {
  assert.equal(customerSubline('', ''), '');
  assert.equal(customerSubline(null, undefined), '');
  assert.equal(customerSubline('', 'الرياض'), 'الرياض');
  assert.equal(customerSubline('0551234567', ''), '0551234567');
  assert.equal(customerSubline('0551234567', null), '0551234567');
  assert.equal(customerSubline(' 0551234567 ', 'جدة'), '0551234567 • جدة');
  // «—» القديمة (استيرادٌ سابق) لا تُعرض جوالاً بفاصل
  assert.equal(customerSubline('—', 'الرياض'), 'الرياض');
  assert.equal(customerSubline(' - ', ''), '');
});

test('RepApp: لا قيد «9 أرقام» ولا نجمة إلزام على جوال العميل في الإضافة والتعديل', () => {
  assert.ok(!repApp.includes('رقم جوال صحيح مطلوب 9 أرقام على الأقل'), 'رسالة القيد القديمة باقية');
  assert.ok(!/form\.phone\.trim\(\)\.length\s*</.test(repApp), 'فحص طولٍ أدنى للجوال باقٍ');
  const phoneFields = repApp.match(/field\(tr\('رقم الجوال'\), 'phone', \{[^}]*\}\)/g) ?? [];
  assert.equal(phoneFields.length, 2, 'حقلا الجوال في الإضافة والتعديل');
  for (const f of phoneFields) {
    assert.ok(!f.includes('required'), `الجوال ليس إلزامياً: ${f}`);
    assert.ok(f.includes('maxLength: CUSTOMER_PHONE_MAX'), `حدّ الأمان الأقصى وحده: ${f}`);
  }
  // الإرسال: '' للفارغ (العمود NOT NULL) لا null ولا undefined — في الإضافة (والطابور دون اتصال) وفي التعديل
  assert.equal((repApp.match(/phone: customerPhoneValue\(form\.phone\)/g) ?? []).length, 2);
});

test('RepApp: الجوال الفارغ لا يُعرض بفاصل يتيم ولا يُستهدف برابط الدفع', () => {
  assert.ok(!repApp.includes("{c.phone} • {c.city || ''}"), 'سطر «الجوال • المدينة» القديم باقٍ');
  assert.ok(repApp.includes('customerSubline(c.phone, c.city)'));
  assert.ok(repApp.includes('customerWaHref(customer.phone, waText)'));
  assert.ok(!/const waDigits = /.test(repApp), 'تطبيع واتساب المحلي المكرَّر باقٍ');
  assert.ok(repApp.includes("tr('لا يوجد جوال صالح للعميل اختر جهة الاتصال في واتساب')"));
  assert.ok(strings.includes("'لا يوجد جوال صالح للعميل اختر جهة الاتصال في واتساب': { en:"), 'ترجمة التنبيه في strings.ts');
  assert.ok(repApp.includes('{customer.phone && <p className="text-[#E8C9BC] text-xs">{customer.phone}</p>}'));
});
