// «احجز اجتماع» (طلب المالك ٨ نوفمبر ٢٠٢٦) — POST /api/contact/meeting: الاسم والجوال الدولي فقط.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetingSchema } from '../routes/contact';

test('المخطط: الاسم والجوال الدولي E.164 من أي دولة، والدولة رمز ISO اختياري', () => {
  for (const ok of [
    { name: 'علي', phone: '+966512345678' },
    { name: 'John', phone: '+14155550100', country: 'US', lang: 'en' },
    { name: 'Niue', phone: '+6834002', country: 'NU' },
    { name: 'Max', phone: '+491701234567890' },
  ]) assert.ok(meetingSchema.safeParse(ok).success, JSON.stringify(ok));
  for (const bad of [
    { name: '', phone: '+966512345678' },
    { name: 'a', phone: '0512345678' },
    { name: 'a', phone: '+0512345678' },
    { name: 'a', phone: '+96651234567890123' },
    { name: 'a', phone: '+966 51 234' },
    { name: 'a', phone: '+966512345678', country: 'sa' },
    { name: 'a', phone: '+966512345678', lang: 'de' },
    { name: 'x'.repeat(121), phone: '+966512345678' },
  ]) assert.equal(meetingSchema.safeParse(bad).success, false, JSON.stringify(bad));
});
