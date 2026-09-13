import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contactPhoneDisplay, contactPhoneTel } from './contactPhone';

/**
 * أرقام التواصل كما يخزّنها الخادم (normContactPhone): أرقامٌ بلا «+». الرابط والعرض يجب أن
 * يُعيدا «+» للجوال والدولي — وإلا يطلب المالك `tel:966551234567` فتفشل المكالمة.
 */

test('رابط tel: من الصيغة المخزّنة', () => {
  const table: Array<[string | null | undefined, string | null]> = [
    ['966551234567', 'tel:+966551234567'],   // جوال سعودي
    ['971501234567', 'tel:+971501234567'],   // دولي
    ['447911123456', 'tel:+447911123456'],
    ['0112345678', 'tel:0112345678'],        // ثابت يبدأ بصفر
    ['920012345', 'tel:920012345'],          // موحّد قصير
    ['12345678', 'tel:12345678'],            // قصيرٌ بلا صفر: لا يُفترض دولياً
    ['+971 50 123 4567', 'tel:+971501234567'], // إدخالٌ قديم بـ+ يُحترم
    ['٩٦٦٥٥١٢٣٤٥٦٧', 'tel:+966551234567'],   // أرقام عربية-هندية
    ['９６６５５１２３４５６７', 'tel:+966551234567'], // أرقام عريضة
    ['', null],
    [null, null],
    [undefined, null],
    ['--', null],
  ];
  for (const [input, want] of table) assert.equal(contactPhoneTel(input), want, `contactPhoneTel(${input})`);
});

test('عرضٌ مقروء بالصيغة نفسها', () => {
  assert.equal(contactPhoneDisplay('966551234567'), '+966 55 123 4567');
  assert.equal(contactPhoneDisplay('966591234567'), '+966 59 123 4567');
  assert.equal(contactPhoneDisplay('971501234567'), '+971501234567');
  assert.equal(contactPhoneDisplay('0112345678'), '0112345678');
  assert.equal(contactPhoneDisplay('920012345'), '920012345');
  assert.equal(contactPhoneDisplay(''), '');
  assert.equal(contactPhoneDisplay(null), '');
});

test('«ترشيحاتي» في البوابة ولوحة المالك يعرضان الرقم بالصيغة المقروءة', () => {
  const claims = readFileSync(new URL('../affiliate/screens/ClaimsScreen.tsx', import.meta.url), 'utf8');
  assert.match(claims, /<bdi dir="ltr">\{contactPhoneDisplay\(c\.contactPhone\)\}<\/bdi>/);
  const logic = readFileSync(new URL('../components/affiliatesPanelLogic.ts', import.meta.url), 'utf8');
  assert.match(logic, /export const telHref = contactPhoneTel;/);
});
