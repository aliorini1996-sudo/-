import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

/**
 * «اشتراط تفعيل الموقع» (طلب المالك، ٤ أكتوبر ٢٠٢٦؛ وفي ٧ أكتوبر قصره على صفحة العميل): قيدٌ تقييديّ على المندوب — لا يدخل صفحة
 * أي عميل ولا يعمل على عميل إلا وموقعه المباشر ظاهرٌ على الخريطة، وبقية التطبيق (ومنها البصمة) متاحةٌ له.
 */
const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');

test('المخطط: عمودٌ تقييديّ مطفأ افتراضاً — لا يُقيَّد مندوبٌ قائم بنشرٍ', () => {
  const s = read('prisma', 'schema.prisma');
  const model = s.slice(s.indexOf('model SalesRep {'), s.indexOf('\n}', s.indexOf('model SalesRep {')));
  assert.match(model, /requireLocationOn Boolean @default\(false\)/);
});

test('يُحفظ من لوحة الإدارة ويصل التطبيق: مخطط المندوب وrepSelect و/auth/me', () => {
  const reps = read('src', 'routes', 'salesReps.ts');
  assert.match(reps, /requireLocationOn: z\.boolean\(\)\.optional\(\),/);
  const sel = reps.slice(reps.indexOf('const repSelect = {'), reps.indexOf('} as const;', reps.indexOf('const repSelect = {')));
  assert.match(sel, /requireLocationOn: true,/);
  const auth = read('src', 'routes', 'auth.ts');
  const me = auth.slice(auth.indexOf("if (req.user.role === 'SALES_REP') {"), auth.indexOf("res.json({ success: true, data: { ...rep, role: 'SALES_REP' } });"));
  assert.match(me, /requireLocationOn: true/, '/auth/me لا يحمل القيد فلا يتجدّد في التطبيق');
});

test('البصمة لا تُردّ بالقيد (أمر المالك ٧ أكتوبر): لا حارس موقعٍ في الحضور والانصراف، والموقع يُكتب إن أُرسل', () => {
  const t = read('src', 'routes', 'tracking.ts');
  assert.doesNotMatch(t, /refuseWithoutLocation|فعّل الموقع في جوالك ثم أعد تسجيل البصمة/);
  for (const route of ["router.post('/attendance/checkin'", "router.post('/attendance/checkout'"]) {
    const h = t.slice(t.indexOf(route), t.indexOf('\n});', t.indexOf(route)));
    assert.doesNotMatch(h, /requireLocationOn|LOCATION_REQUIRED/, route);
    assert.match(h, /(checkInLat|checkOutLat): lat \?\? null/, route);
  }
});
