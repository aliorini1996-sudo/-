import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

/**
 * «اشتراط تفعيل الموقع» (طلب المالك، ٤ أكتوبر ٢٠٢٦): قيدٌ تقييديّ على المندوب — والموقع مطفأ لا يقبل التطبيق منه
 * إجراءً ولا زيارةً ولا فتح عميل ولا بصمة. التطبيق يحجب شاشته، والخادم يردّ البصمة بلا إحداثيات.
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

test('الخادم يردّ بصمة الحضور والانصراف بلا إحداثيات من مندوبٍ مقيَّد — قبل أي كتابة', () => {
  const t = read('src', 'routes', 'tracking.ts');
  const fn = t.slice(t.indexOf('async function refuseWithoutLocation('), t.indexOf('\n}', t.indexOf('async function refuseWithoutLocation(')));
  assert.match(fn, /if \(lat != null && lng != null\) return false;/, 'بإحداثيات لا يُقرأ المندوب أصلاً');
  assert.match(fn, /select: \{ requireLocationOn: true \}/);
  assert.match(fn, /if \(rep\?\.requireLocationOn !== true\) return false;/, 'غير المقيَّد لا يُردّ');
  assert.match(fn, /res\.status\(409\)\.json\(\{ success: false, code: 'LOCATION_REQUIRED'/);
  for (const route of ["router.post('/attendance/checkin'", "router.post('/attendance/checkout'"]) {
    const h = t.slice(t.indexOf(route), t.indexOf('\n});', t.indexOf(route)));
    const parse = h.indexOf('punchSchema.parse(');
    const guard = h.indexOf('if (await refuseWithoutLocation(res, repId, lat, lng)) return;');
    const write = h.search(/prisma\.repAttendance\.(create|update)\(/);
    assert.ok(parse > 0 && guard > parse && write > guard, `${route}: الحارس بعد قراءة الإحداثيات وقبل الكتابة`);
  }
  // الحضور المكرّر (نوبةٌ مفتوحة) يُعاد قبل الحارس: لا كتابة فيه فلا يُردّ
  const ci = t.slice(t.indexOf("router.post('/attendance/checkin'"), t.indexOf('\n});', t.indexOf("router.post('/attendance/checkin'")));
  assert.ok(ci.indexOf('already: true') < ci.indexOf('refuseWithoutLocation('));
});
