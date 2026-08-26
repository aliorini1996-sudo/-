import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

/**
 * حارس إلزامية الجوال في التسجيل الذاتي (نسخة مطابقة لمخطط signupSchema في
 * routes/auth.ts). الجوال قناة التواصل المؤكَّدة الوحيدة مع صاحب التجربة —
 * البريد قد يكون مؤقّتاً، وعلى الجوال تقوم المتابعة والدعم.
 *
 * أي تخفيف مستقبلي لهذا الشرط يجب أن يكسر اختباراً لا أن يمرّ صامتاً.
 */
const phoneSchema = z.string()
  .transform((s) => s.replace(/[^\d+]/g, ''))
  .refine((s) => s.replace(/\D/g, '').length >= 8, 'رقم الجوال مطلوب ويجب ان يكون صحيحا');

const parse = (v: unknown) => z.object({ phone: phoneSchema }).safeParse(v);

test('التسجيل بلا حقل جوال يُرفض', () => {
  assert.equal(parse({}).success, false);
});

test('الجوال الفارغ يُرفض', () => {
  assert.equal(parse({ phone: '' }).success, false);
});

test('الرقم القصير يُرفض (ليس جوالاً)', () => {
  assert.equal(parse({ phone: '123' }).success, false);
  assert.equal(parse({ phone: '05' }).success, false);
});

test('النص بلا أرقام يُرفض', () => {
  assert.equal(parse({ phone: 'لا يوجد' }).success, false);
});

test('الجوال الصحيح يُقبل ويُنظَّف من المسافات والرموز', () => {
  const r = parse({ phone: '+966 50 123 4567' });
  assert.ok(r.success);
  assert.equal(r.data.phone, '+966501234567');
});

test('الصيغة المحلية تُقبل كما هي (الواجهة تضيف المفتاح الدولي)', () => {
  const r = parse({ phone: '0501234567' });
  assert.ok(r.success);
  assert.equal(r.data.phone, '0501234567');
});
