import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closedMinutes, dayMinutes, nextPunch, shiftMinutes, shiftsOf, type AttendanceState } from './attendanceDay';

// قرار المالك: كل دخولٍ يُسجَّل وكل خروجٍ يُسجَّل. المندوب يخرج ظهراً ويعود مساءً فيبصم فترةً ثانية،
// ويرى بصمات يومه كلها. التوقيتات UTC تكفي للاختبار (06–10Z ثم 14–18Z = ٩ص–١ظ ثم ٥م–٩م بالرياض).
const T = (hm: string) => `2026-10-04T${hm}:00.000Z`;

test('بعد الانصراف الزرّ التالي «بدء فترة عمل جديدة» لا «انتهى عملك»، وأثناء العمل الانصراف', () => {
  const none: AttendanceState = { status: 'none', shifts: [] };
  assert.equal(nextPunch(none), 'checkin');

  const inFirst: AttendanceState = { status: 'in', shift: { checkInAt: T('06:00'), checkInLat: null, checkInLng: null },
    shifts: [{ checkInAt: T('06:00'), checkOutAt: null }] };
  assert.equal(nextPunch(inFirst), 'checkout');

  const out: AttendanceState = { status: 'out', last: { checkInAt: T('06:00'), checkOutAt: T('10:00') },
    shifts: [{ checkInAt: T('06:00'), checkOutAt: T('10:00') }] };
  assert.equal(nextPunch(out), 'checkin-again');

  // عاد مساءً: نوبةٌ ثانية مفتوحة ⇒ الانصراف مجدّداً
  const inSecond: AttendanceState = { status: 'in', shift: { checkInAt: T('14:00'), checkInLat: null, checkInLng: null },
    shifts: [{ checkInAt: T('06:00'), checkOutAt: T('10:00') }, { checkInAt: T('14:00'), checkOutAt: null }] };
  assert.equal(nextPunch(inSecond), 'checkout');
});

test('بصمات اليوم كلها مرتّبةً من الأقدم، ومجموعها النوبات المغلقة وحدها (كما يحسبه التقرير)', () => {
  const s: AttendanceState = { status: 'in', shift: { checkInAt: T('14:00'), checkInLat: 24.7, checkInLng: 46.6 },
    shifts: [{ checkInAt: T('14:00'), checkOutAt: null }, { checkInAt: T('06:00'), checkOutAt: T('10:00') }] };
  const list = shiftsOf(s);
  assert.deepEqual(list.map(x => [x.checkInAt.slice(11, 16), x.checkOutAt?.slice(11, 16) ?? null]), [['06:00', '10:00'], ['14:00', null]]);
  assert.equal(shiftMinutes(list[0]), 240);
  assert.equal(shiftMinutes(list[1]), 0, 'المفتوحة لا تُحسب حتى الانصراف');
  assert.equal(closedMinutes(list), 240);

  const day: AttendanceState = { status: 'out', last: { checkInAt: T('14:00'), checkOutAt: T('18:00') },
    shifts: [{ checkInAt: T('06:00'), checkOutAt: T('10:00') }, { checkInAt: T('14:00'), checkOutAt: T('18:00') }] };
  assert.equal(closedMinutes(shiftsOf(day)), 480, 'ثماني ساعات لا اثنتا عشرة');
});

test('مجموع اليوم بنسبة التقرير: نوبة أمسٍ التي انصرف عنها صباحاً تظهر في القائمة ولا تُضاف لليوم', () => {
  // نسي الانصراف أمس ٩ص (06:00Z) فانصرف اليوم ٨ص (05:00Z)، ثم حضر ٩ص وانصرف ١ظ
  const s: AttendanceState = { status: 'out', last: { checkInAt: T('06:00'), checkOutAt: T('10:00') },
    shifts: [{ checkInAt: '2026-10-03T06:00:00.000Z', checkOutAt: T('05:00') }, { checkInAt: T('06:00'), checkOutAt: T('10:00') }] };
  const list = shiftsOf(s);
  assert.equal(list.length, 2, 'كل خروجٍ سُجّل اليوم يُعرض — ولو لنوبة أمس');
  assert.equal(closedMinutes(list), 23 * 60 + 240);
  // منتصف ليل الرياض = 21:00Z من اليوم السابق — التقرير ينسب النوبة ليوم حضورها
  assert.equal(dayMinutes(list, new Date('2026-10-03T21:00:00.000Z')), 240, 'لا ٢٧ ساعة «لليوم»');
});

test('خادمٌ أقدم بلا قائمة: البصمة المعروفة في الحالة نفسها لا تختفي', () => {
  assert.deepEqual(shiftsOf({ status: 'in', shift: { checkInAt: T('06:00'), checkInLat: null, checkInLng: null } }),
    [{ checkInAt: T('06:00'), checkOutAt: null }]);
  const out: AttendanceState = { status: 'out', last: { checkInAt: T('06:00'), checkOutAt: T('10:00') } };
  assert.deepEqual(shiftsOf(out), [{ checkInAt: T('06:00'), checkOutAt: T('10:00') }]);
  assert.equal(nextPunch(out), 'checkin-again');
  assert.deepEqual(shiftsOf({ status: 'none' }), []);
});

test('حارس الشاشة: لا «انتهى عملك اليوم»، والقائمة والزرّ الجديد حاضران، والضغط المزدوج محروس', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'rep', 'RepApp.tsx'), 'utf8');
  const a = src.indexOf('function RepAttendance(');
  const screen = src.slice(a, src.indexOf('function RepWorkNumber()'));
  assert.ok(a > 0 && screen.length > 0);
  assert.doesNotMatch(screen, /انتهى عملك اليوم/, 'الانصراف ليس نهاية اليوم — الدوام المتقطّع يعود');
  assert.match(screen, /tr\('بدء فترة عمل جديدة'\)/);
  assert.match(screen, /shifts\.map\(\(sh, i\) =>/, 'بصمات اليوم لا تُعرض قائمة');
  assert.match(screen, /if \(inFlight\.current\) return;/, 'ضغطتان سريعتان ترسلان بصمتين');
  assert.match(screen, /disabled=\{busy\}/);
  assert.match(screen, /dayMinutes\(shifts, todayStart\)/, 'مجموع اليوم يضيف نوبة أمس');
  // انصرافٌ نجح وضاع ردّه ⇒ 409 عند الإعادة: تُحدَّث الحالة لا يعلق زرّ الانصراف
  // …إلا رفض «اشتراط تفعيل الموقع» (409 أيضاً): رسالته تُعرض ولا تُبتلع بإعادة التحميل
  assert.match(screen, /if \(resp\?\.status === 409 && resp\.data\?\.code !== 'LOCATION_REQUIRED'\) load\(\);/);
  // الخادم يعيد بصمات اليوم مع كل بصمة متى عرف يوم المندوب
  assert.match(screen, /repApi\.post\(`\/tracking\/attendance\/\$\{kind\}`, loc \?\? \{\}, \{ params: \{ tzOffsetMin \} \}\)/);
});
