import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billContentHash, extractArray } from '../services/petroapp';

/**
 * حرّاس تكامل بترو آب:
 * ١) المحلّل المتسامح يقرأ أشكال الاستجابة الشائعة كلّها — صيغة الـAPI غير موثّقة
 *    علنياً فأي تضييق مستقبلي يجب أن يكسر اختباراً لا الإنتاج.
 * ٢) بصمة إزالة التكرار مستقرّة وحسّاسة للنوع — تكرار الفاتورة نفسها لا يضاعف
 *    المصروف، وفاتورتا وقود وغسيل بنفس المبلغ لا تتصادمان.
 */

test('extractArray: يقبل المصفوفة المباشرة', () => {
  assert.deepEqual(extractArray([{ id: 1 }]), [{ id: 1 }]);
});

test('extractArray: يقبل {data:[...]}', () => {
  assert.deepEqual(extractArray({ data: [{ id: 2 }] }), [{ id: 2 }]);
});

test('extractArray: يقبل {data:{items:[...]}} المتداخل', () => {
  assert.deepEqual(extractArray({ data: { items: [{ id: 3 }] } }), [{ id: 3 }]);
});

test('extractArray: يقبل {result:[...]} و{bills:[...]}', () => {
  assert.deepEqual(extractArray({ result: [{ id: 4 }] }), [{ id: 4 }]);
  assert.deepEqual(extractArray({ bills: [{ id: 5 }] }), [{ id: 5 }]);
});

test('extractArray: يرجع فارغة لا يرمي عند شكل مجهول', () => {
  assert.deepEqual(extractArray(null), []);
  assert.deepEqual(extractArray('nope'), []);
  assert.deepEqual(extractArray({ weird: true }), []);
});

test('البصمة: نفس الفاتورة نفس البصمة (استقرار إعادة المزامنة)', () => {
  const row = { id: 987, amount: 150.5, date: '2026-08-24' };
  assert.equal(billContentHash('FUEL', row), billContentHash('FUEL', { ...row }));
});

test('البصمة: النوع جزء منها — وقود وغسيل بنفس المعرف لا يتصادمان', () => {
  const row = { id: 987 };
  assert.notEqual(billContentHash('FUEL', row), billContentHash('WASH', row));
});

test('البصمة بلا معرف خارجي: تُبنى من الحقول الثابتة وتبقى مستقرة', () => {
  const row = { date: '2026-08-24T10:00:00Z', amount: 80, vehicle_id: 'V1', station_name: 'NAFT' };
  const h1 = billContentHash('FUEL', row);
  const h2 = billContentHash('FUEL', { ...row });
  assert.equal(h1, h2);
  // تغيّر المبلغ يغيّر البصمة — فاتورة أخرى فعلاً
  assert.notEqual(h1, billContentHash('FUEL', { ...row, amount: 81 }));
});

test('البصمة: قيم رقمية كسلاسل تُطبَّع (id رقم أو نص سواء)', () => {
  assert.equal(billContentHash('FUEL', { id: 42 }), billContentHash('FUEL', { id: '42' }));
});
