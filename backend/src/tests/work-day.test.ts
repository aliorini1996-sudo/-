/**
 * محرك «يوم العمل الميداني» — composeWorkDays وقص الجلسات على الأيام المحلية.
 *
 * الخلل الذي يحرسه: تقرير الساعات كان يجمع جلسات التطبيق وحدها (نبضة تشترط
 * اتصالا) فيتناقض مع خريطة التتبع التي ترى GPS يوما كاملا — والمشرف يقرأ
 * «ساعتين» لمندوب مساره من الثامنة للرابعة. المقياس الموحد: أول أثر → آخر أثر.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { composeWorkDays, splitByLocalDay, dayKey, mergeVisits, mergeVisitsByRep, countStopsByRep, MERGE_TOLERANCE_MS } from '../services/workDay';

const KSA = 180; // الرياض UTC+3
const at = (iso: string) => new Date(iso);

test('مفتاح اليوم يتبع توقيت المندوب لا الخادم', () => {
  // 23:30 UTC = 02:30 فجر اليوم التالي بتوقيت الرياض
  assert.equal(dayKey(at('2026-08-03T23:30:00Z'), KSA), '2026-08-04');
  assert.equal(dayKey(at('2026-08-03T23:30:00Z'), 0), '2026-08-03');
});

test('جلسة تعبر منتصف الليل المحلي تتوزع على يومين بحصتيهما', () => {
  // 20:00→22:00 UTC = 23:00→01:00 بتوقيت الرياض
  const parts = splitByLocalDay({ start: at('2026-08-03T20:00:00Z'), end: at('2026-08-03T22:00:00Z') }, KSA);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map(p => p.day), ['2026-08-03', '2026-08-04']);
  assert.equal((parts[0].end.getTime() - parts[0].start.getTime()) / 60000, 60);
  assert.equal((parts[1].end.getTime() - parts[1].start.getTime()) / 60000, 60);
});

test('فترة فارغة أو معكوسة لا تنتج شيئا', () => {
  assert.deepEqual(splitByLocalDay({ start: at('2026-08-03T10:00:00Z'), end: at('2026-08-03T10:00:00Z') }, KSA), []);
  assert.deepEqual(splitByLocalDay({ start: at('2026-08-03T10:00:00Z'), end: at('2026-08-03T09:00:00Z') }, KSA), []);
});

test('السيناريو الذي أبلغ عنه المالك: GPS يمتد أبعد من الجلسات', () => {
  // جلستا تطبيق قصيرتان (ساعة + ٧٥ دقيقة) لكن GPS من 5:00 إلى 13:00 UTC
  const days = composeWorkDays({
    sessions: [
      { start: at('2026-08-04T06:00:00Z'), end: at('2026-08-04T07:00:00Z') },
      { start: at('2026-08-04T10:30:00Z'), end: at('2026-08-04T11:45:00Z') },
    ],
    pingRanges: [{ day: '2026-08-04', min: at('2026-08-04T05:00:00Z'), max: at('2026-08-04T13:00:00Z') }],
    visits: [],
    tzOffsetMin: KSA,
  });
  assert.equal(days.length, 1);
  assert.equal(days[0].spanMinutes, 8 * 60);   // يوم العمل: 8 ساعات (من GPS)
  assert.equal(days[0].appMinutes, 135);       // نشاط التطبيق: 2س15د فقط — الرقمان معا يحكيان القصة
});

test('الزيارة أثر يمد اليوم حتى بلا جلسات ولا GPS', () => {
  const days = composeWorkDays({
    sessions: [],
    pingRanges: [],
    visits: [
      { customerName: 'بقالة النور', at: at('2026-08-04T05:00:00Z'), durationSec: 900 },
      { customerName: 'أسواق الخير', at: at('2026-08-04T12:00:00Z'), durationSec: 600 },
    ],
    tzOffsetMin: KSA,
  });
  assert.equal(days.length, 1);
  // آخر أثر = نهاية الزيارة الأخيرة (12:00 + 10د) لا بدايتها
  assert.equal(days[0].spanMinutes, 7 * 60 + 10);
  assert.equal(days[0].visitsSec, 1500);
  assert.equal(days[0].visitsCount, 2);
  assert.equal(days[0].appMinutes, 0);
});

test('مجموع مدد الزيارات يطابق حساب خريطة التتبع (المؤقتة وحدها)', () => {
  const days = composeWorkDays({
    sessions: [],
    pingRanges: [],
    visits: [
      { customerName: 'أ', at: at('2026-08-04T06:00:00Z'), durationSec: 300 },
      { customerName: 'ب', at: at('2026-08-04T07:00:00Z'), durationSec: null }, // زيارة ملاحظة — بلا مدة
      { customerName: 'ج', at: at('2026-08-04T08:00:00Z'), durationSec: 450 },
    ],
    tzOffsetMin: KSA,
  });
  assert.equal(days[0].visitsSec, 750);   // كما تجمعها TrackingPage: durationSec > 0 فقط
  assert.equal(days[0].visitsCount, 3);   // لكن العد يشمل الجميع
});

test('الأيام تخرج مرتبة والزيارات داخل اليوم مرتبة زمنيا', () => {
  const days = composeWorkDays({
    sessions: [],
    pingRanges: [
      { day: '2026-08-05', min: at('2026-08-05T05:00:00Z'), max: at('2026-08-05T10:00:00Z') },
      { day: '2026-08-03', min: at('2026-08-03T05:00:00Z'), max: at('2026-08-03T10:00:00Z') },
    ],
    visits: [
      { customerName: 'ثانية', at: at('2026-08-03T08:00:00Z'), durationSec: null },
      { customerName: 'أولى', at: at('2026-08-03T06:00:00Z'), durationSec: null },
    ],
    tzOffsetMin: KSA,
  });
  assert.deepEqual(days.map(d => d.date), ['2026-08-03', '2026-08-05']);
  assert.deepEqual(days[0].visits.map(v => v.customerName), ['أولى', 'ثانية']);
});

test('أثر واحد يتيم = يوم بامتداد صفري لا انهيار', () => {
  const days = composeWorkDays({
    sessions: [],
    pingRanges: [],
    visits: [{ customerName: 'وحيدة', at: at('2026-08-04T09:00:00Z'), durationSec: null }],
    tzOffsetMin: KSA,
  });
  assert.equal(days[0].spanMinutes, 0);
  assert.equal(days[0].firstActivity.getTime(), days[0].lastActivity.getTime());
});

/* ───────── دمج سجلي الزيارة الواحدة ───────── */

test('المؤقت + الملاحظة لنفس العميل = وقفة واحدة ببداية ونهاية', () => {
  // الحالة من ملف المالك: ١١:٢١ بمدة ١٦د٣٨ث، ثم سجل بلا توقيت ١١:٣٨
  const start = at('2026-08-05T11:21:00Z');
  const out = mergeVisits([
    { customerName: 'قولدن سنت', at: start, durationSec: 998 },
    { customerName: 'قولدن سنت', at: at('2026-08-05T11:38:00Z'), durationSec: null },
  ]);
  assert.equal(out.length, 1, 'وقفة واحدة لا سجلان');
  assert.equal(out[0].parts, 2);
  assert.equal(out[0].hasNote, true);
  assert.equal(out[0].durationSec, 998);
  assert.equal(out[0].end!.toISOString(), new Date(start.getTime() + 998000).toISOString());
});

test('ملاحظة داخل نافذة المؤقت تندمج ولو سبقت نهايته', () => {
  const out = mergeVisits([
    { customerName: 'أسواق المزرعة', at: at('2026-08-05T10:22:00Z'), durationSec: 3585 },
    { customerName: 'أسواق المزرعة', at: at('2026-08-05T10:23:00Z'), durationSec: null },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].parts, 2);
});

test('ملاحظة بعيدة عن أي مؤقت تبقى وقفة مستقلة بلا توقيت', () => {
  const out = mergeVisits([
    { customerName: 'عميل', at: at('2026-08-05T08:00:00Z'), durationSec: 600 },
    { customerName: 'عميل', at: at('2026-08-05T15:00:00Z'), durationSec: null },
  ]);
  assert.equal(out.length, 2, 'زيارتان في يومين مختلفي الوقت لا تدمجان');
  assert.equal(out[1].durationSec, null);
  assert.equal(out[1].end, null);
});

test('عميلان مختلفان لا يندمجان ولو تزامنا', () => {
  const t = at('2026-08-05T09:00:00Z');
  const out = mergeVisits([
    { customerName: 'أ', at: t, durationSec: 600 },
    { customerName: 'ب', at: new Date(t.getTime() + 60000), durationSec: null },
  ]);
  assert.equal(out.length, 2);
});

test('هامش الدمج معقول: لا يبتلع زيارة ثانية بعد ساعة', () => {
  assert.ok(MERGE_TOLERANCE_MS <= 10 * 60 * 1000);
  const out = mergeVisits([
    { customerName: 'عميل', at: at('2026-08-05T09:00:00Z'), durationSec: 300 },
    { customerName: 'عميل', at: at('2026-08-05T10:00:00Z'), durationSec: 300 },
  ]);
  assert.equal(out.length, 2, 'زيارتان مؤقتتان تبقيان اثنتين');
});

test('عدد الزيارات في اليوم = عدد الوقفات لا السجلات', () => {
  const days = composeWorkDays({
    sessions: [], pingRanges: [],
    visits: [
      { customerName: 'أسواق المزرعة', at: at('2026-08-05T07:22:00Z'), durationSec: 3585 },
      { customerName: 'أسواق المزرعة', at: at('2026-08-05T07:23:00Z'), durationSec: null },
      { customerName: 'قولدن سنت', at: at('2026-08-05T08:21:00Z'), durationSec: 998 },
      { customerName: 'قولدن سنت', at: at('2026-08-05T08:38:00Z'), durationSec: null },
    ],
    tzOffsetMin: KSA,
  });
  assert.equal(days.length, 1);
  assert.equal(days[0].visitsCount, 2, 'أربعة سجلات = وقفتان');
  assert.equal(days[0].visitsSec, 3585 + 998, 'ومجموع المدد لا يتغير بالدمج');
});

/* ───────── الأيام الغائبة ───────── */

test('يوم بلا أثر داخل المدى يظهر صفا فارغا لا يحذف', () => {
  const days = composeWorkDays({
    sessions: [], pingRanges: [],
    visits: [{ customerName: 'عميل', at: at('2026-08-03T07:00:00Z'), durationSec: 600 }],
    tzOffsetMin: KSA,
    range: { from: '2026-08-01', to: '2026-08-05' },
  });
  assert.equal(days.length, 5, 'خمسة أيام في المدى');
  assert.deepEqual(days.map(d => d.date), ['2026-08-01','2026-08-02','2026-08-03','2026-08-04','2026-08-05']);
  assert.equal(days.filter(d => d.absent).length, 4, 'أربعة أيام غياب معلنة');
  assert.equal(days[2].absent, false);
});

test('شكوى المالك: تحديد يومٍ واحد لا يُظهر يوماً آخر (أثرٌ خارج المدى يُقصّ)', () => {
  // زيارةٌ عالقة بدأت ١٧ سبتمبر (at=startedAt) وسجلٌّ آخر في ١٩، والمشرف حدّد ١٩
  const days = composeWorkDays({
    sessions: [{ start: at('2026-09-19T05:00:00Z'), end: at('2026-09-19T13:00:00Z') }],
    pingRanges: [],
    visits: [
      { customerName: 'عالق', at: at('2026-09-17T06:00:00Z'), durationSec: 1200 }, // خارج المدى
      { customerName: 'اليوم', at: at('2026-09-19T07:00:00Z'), durationSec: 900 },  // داخله
    ],
    tzOffsetMin: KSA,
    range: { from: '2026-09-19', to: '2026-09-19' },
  });
  assert.deepEqual(days.map(d => d.date), ['2026-09-19'], 'ظهر يومٌ خارج المدى الذي حدّده المشرف');
  assert.equal(days[0].visitsCount, 1, 'زيارة اليوم وحدها — لا زيارة اليوم العالق');
  assert.equal(days[0].visits[0].customerName, 'اليوم');
});

test('جلسةٌ تعبر منتصف ليل آخر يومٍ لا تُظهر اليوم التالي خارج المدى', () => {
  const days = composeWorkDays({
    sessions: [{ start: at('2026-09-19T20:00:00Z'), end: at('2026-09-19T22:00:00Z') }], // ١٩ ٢٣:٠٠ → ٢٠ ٠١:٠٠ بالرياض
    pingRanges: [], visits: [],
    tzOffsetMin: KSA,
    range: { from: '2026-09-19', to: '2026-09-19' },
  });
  assert.deepEqual(days.map(d => d.date), ['2026-09-19'], 'ظهر يوم ٢٠ من جلسةٍ عبرت منتصف الليل');
});

test('بلا مدى ⇒ أيام النشاط وحدها (سلوك سابق محفوظ)', () => {
  const days = composeWorkDays({
    sessions: [], pingRanges: [],
    visits: [{ customerName: 'ع', at: at('2026-08-03T07:00:00Z'), durationSec: 600 }],
    tzOffsetMin: KSA,
  });
  assert.equal(days.length, 1);
  assert.equal(days[0].absent, false);
});

test('اليوم الغائب لا يضخم أي مجموع', () => {
  const days = composeWorkDays({
    sessions: [], pingRanges: [], visits: [],
    tzOffsetMin: KSA, range: { from: '2026-08-01', to: '2026-08-03' },
  });
  assert.equal(days.length, 3);
  assert.equal(days.reduce((a, d) => a + d.spanMinutes, 0), 0);
  assert.equal(days.reduce((a, d) => a + d.visitsCount, 0), 0);
});

// ═══ بصمة الحضور والانصراف (بديل حساب الساعات) ═══
import { attendanceByDay, overlayAttendance, type WorkDay } from '../services/workDay';

const RIY = 180; // الرياض +3
const iso = (s: string) => new Date(s);

test('attendanceByDay: نوبة مغلقة ⇒ بداية ونهاية ومجموع الدقائق بينهما', () => {
  const m = attendanceByDay([{ checkInAt: iso('2026-09-25T05:00:00Z'), checkOutAt: iso('2026-09-25T13:30:00Z') }], RIY);
  const d = m.get('2026-09-25')!;
  assert.strictEqual(d.start.toISOString(), '2026-09-25T05:00:00.000Z');
  assert.strictEqual(d.end!.toISOString(), '2026-09-25T13:30:00.000Z');
  assert.strictEqual(d.minutes, 510); // 8 ساعات ونصف
});

test('attendanceByDay: نوبتان في يوم ⇒ أول حضور وآخر انصراف ومجموع النوبتين', () => {
  const m = attendanceByDay([
    { checkInAt: iso('2026-09-25T05:00:00Z'), checkOutAt: iso('2026-09-25T08:00:00Z') },   // 180د
    { checkInAt: iso('2026-09-25T10:00:00Z'), checkOutAt: iso('2026-09-25T12:00:00Z') },   // 120د
  ], RIY);
  const d = m.get('2026-09-25')!;
  assert.strictEqual(d.start.toISOString(), '2026-09-25T05:00:00.000Z');
  assert.strictEqual(d.end!.toISOString(), '2026-09-25T12:00:00.000Z');
  assert.strictEqual(d.minutes, 300);
});

test('attendanceByDay: نوبة مفتوحة ⇒ بداية بلا نهاية ولا دقائق حتى الانصراف', () => {
  const m = attendanceByDay([{ checkInAt: iso('2026-09-25T06:00:00Z'), checkOutAt: null }], RIY);
  const d = m.get('2026-09-25')!;
  assert.strictEqual(d.end, null);
  assert.strictEqual(d.minutes, 0);
});

test('attendanceByDay: النوبة تُنسب ليوم بصمة الحضور المحلي (الرياض)', () => {
  // 2026-09-25T21:30Z = 26 سبتمبر 00:30 بالرياض ⇒ يوم 26، لا 25
  const m = attendanceByDay([{ checkInAt: iso('2026-09-25T21:30:00Z'), checkOutAt: iso('2026-09-25T22:30:00Z') }], RIY);
  assert.ok(m.has('2026-09-26'));
  assert.ok(!m.has('2026-09-25'));
});

test('overlayAttendance: يومٌ ببصمة يأخذ البداية/النهاية/الإجمالي منها، ويُرفع الغياب، ويبقى نشاط التطبيق', () => {
  const base: WorkDay = {
    date: '2026-09-25', firstActivity: iso('2026-09-25T04:00:00Z'), lastActivity: iso('2026-09-25T15:00:00Z'),
    spanMinutes: 660, periods: [{ start: iso('2026-09-25T04:00:00Z'), end: iso('2026-09-25T15:00:00Z'), source: 'ACTIVITY' }], breakMinutes: 0,
    appMinutes: 42, visits: [], visitsCount: 3, visitsSec: 900, absent: false,
  };
  const m = attendanceByDay([{ checkInAt: iso('2026-09-25T05:00:00Z'), checkOutAt: iso('2026-09-25T13:00:00Z') }], RIY);
  const [d] = overlayAttendance([base], m);
  assert.strictEqual(d.firstActivity.toISOString(), '2026-09-25T05:00:00.000Z'); // الحضور
  assert.strictEqual(d.lastActivity.toISOString(), '2026-09-25T13:00:00.000Z');  // الانصراف
  assert.strictEqual(d.spanMinutes, 480); // 8 ساعات بين البصمتين
  assert.strictEqual(d.appMinutes, 42);   // نشاط التطبيق كما هو
  assert.strictEqual(d.visitsCount, 3);
});

test('overlayAttendance: بصمةٌ في يومٍ كان غياباً ⇒ يصير حاضراً', () => {
  const absentDay: WorkDay = {
    date: '2026-09-25', firstActivity: iso('2026-09-25T00:00:00Z'), lastActivity: iso('2026-09-25T00:00:00Z'),
    spanMinutes: 0, periods: [], breakMinutes: 0, appMinutes: 0, visits: [], visitsCount: 0, visitsSec: 0, absent: true,
  };
  const m = attendanceByDay([{ checkInAt: iso('2026-09-25T06:00:00Z'), checkOutAt: iso('2026-09-25T14:00:00Z') }], RIY);
  const [d] = overlayAttendance([absentDay], m);
  assert.strictEqual(d.absent, false);
  assert.strictEqual(d.spanMinutes, 480);
});

test('overlayAttendance: يومٌ بلا بصمة يبقى على مقياسه القديم (توافق ما قبل الميزة)', () => {
  const base: WorkDay = {
    date: '2026-09-17', firstActivity: iso('2026-09-17T09:00:00Z'), lastActivity: iso('2026-09-17T20:00:00Z'),
    spanMinutes: 660, periods: [{ start: iso('2026-09-17T09:00:00Z'), end: iso('2026-09-17T20:00:00Z'), source: 'ACTIVITY' }], breakMinutes: 0,
    appMinutes: 40, visits: [], visitsCount: 11, visitsSec: 6000, absent: false,
  };
  const [d] = overlayAttendance([base], new Map());
  assert.strictEqual(d.spanMinutes, 660);
  assert.strictEqual(d.firstActivity.toISOString(), '2026-09-17T09:00:00.000Z');
});

/* ───────── الدمج الموحّد لكل شاشات الزيارات ───────── */

// الحالة من صورة المالك (٤ أكتوبر): مؤقّت ١س١٩د بدأ ٠٦:٠٧ م وانتهى ٠٧:٢٦ م،
// وملاحظة «تسجيل نواقص» ٠٦:٣٧ م داخله — ظهرا صفّين، والصحيح صفٌّ واحد
test('صورة المالك: ملاحظة داخل المؤقت تندمج وتحمل الوقفة مصدريها بالترتيب', () => {
  const timer = { customerName: 'عالم التوفير', at: at('2026-10-03T15:07:00Z'), durationSec: 4740, id: 't' };
  const note = { customerName: 'عالم التوفير', at: at('2026-10-03T15:37:00Z'), durationSec: null, id: 'n' };
  const out = mergeVisits([note, timer]);
  assert.equal(out.length, 1, 'وقفة واحدة لا صفّان');
  assert.deepEqual(out[0].sources.map(v => v.id), ['t', 'n'], 'المؤقت أولاً ثم الملاحظة');
  assert.equal(out[0].durationSec, 4740);
});

test('ملاحظة مندوب لا تُلصق بمؤقت زميل زار العميل نفسه في الوقت نفسه', () => {
  const t = at('2026-10-03T09:00:00Z');
  const out = mergeVisitsByRep([
    { salesRepId: 'A', customerName: 'عميل', customerId: 'c1', at: t, durationSec: 1800 },
    { salesRepId: 'B', customerName: 'عميل', customerId: 'c1', at: new Date(t.getTime() + 300000), durationSec: null },
  ]);
  assert.equal(out.length, 2, 'المندوب B زار وحده — لا يذوب في وقفة A');
});

test('عميلان بالاسم نفسه لا يندمجان حين يُمرَّر معرّف العميل', () => {
  const t = at('2026-10-03T09:00:00Z');
  const out = mergeVisits([
    { customerName: 'بقالة النور', customerId: 'c1', at: t, durationSec: 1800 },
    { customerName: 'بقالة النور', customerId: 'c2', at: new Date(t.getTime() + 60000), durationSec: null },
  ]);
  assert.equal(out.length, 2, 'فرعان مختلفان بالاسم نفسه');
});

test('عدّاد الوقفات: مؤقت وملاحظته زيارة واحدة لا اثنتان', () => {
  const t = at('2026-10-03T09:00:00Z');
  const counts = countStopsByRep([
    { salesRepId: 'A', customerName: 'س', at: t, durationSec: 900 },
    { salesRepId: 'A', customerName: 'س', at: new Date(t.getTime() + 120000), durationSec: null },
    { salesRepId: 'A', customerName: 'ص', at: new Date(t.getTime() + 3600000), durationSec: 600 },
    { salesRepId: 'B', customerName: 'س', at: t, durationSec: null },
  ]);
  assert.deepEqual(counts, { A: 2, B: 1 });
});

/**
 * حارس نصّ: لا شاشة تعدّ سجلّات الزيارات خاماً.
 *
 * المؤقّت وملاحظته سجلّان ووقفةٌ واحدة؛ مسارٌ واحد يعدّ السجلّات بـ`groupBy`
 * أو `count` يكفي ليُناقض رقمُه رقمَ أخته — وهو ما كان: الخريطة تقول سبعاً
 * وتقرير ساعات العمل يقول أربعاً للمندوب نفسه في اليوم نفسه.
 */
test('حارس ثابت: مسارات الزيارات تعدّ الوقفات المدموجة لا السجلّات', () => {
  const dir = path.join(process.cwd(), 'src', 'routes');
  const offenders: string[] = [];
  for (const f of ['reports.ts', 'visits.ts', 'tracking.ts']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (/repVisit\.groupBy\(/.test(src)) offenders.push(`${f}: repVisit.groupBy`);
    if (/repVisit\.count\(/.test(src)) offenders.push(`${f}: repVisit.count`);
  }
  assert.deepEqual(offenders, [], `عدٌّ خام للزيارات:\n${offenders.join('\n')}`);
});

// ═══ الدوام المتقطّع: كل دخولٍ يُسجَّل وكل خروجٍ يُسجَّل ═══
// قرار المالك: «لا تحدد الفترات بزمن معين وإنما كل دخول يسجل وكل خروج يسجل». فترات اليوم من البصمات وحدها،
// ويومٌ بلا بصمة يبقى امتداداً واحداً من أول أثر إلى آخره بأرقامه القديمة — لا عتبة صمتٍ تخترع استراحة.
// التوقيتات بالرياض (+3): ٩ص = 06:00Z، ١ظ = 10:00Z، ٥م = 14:00Z، ٩م = 18:00Z.
import fs from 'node:fs';
import path from 'node:path';
import * as workDayModule from '../services/workDay';

const hhmm = (d: Date | null) => (d ? d.toISOString().slice(11, 16) : null);
const punches = (...pairs: Array<[string, string | null]>) =>
  pairs.map(([i, o]) => ({ checkInAt: iso(`2026-10-04T${i}:00Z`), checkOutAt: o ? iso(`2026-10-04T${o}:00Z`) : null }));

test('دوام متقطّع: دخولان وخروجان ⇒ فترتان، الإجمالي ٨ ساعات والاستراحة ٤', () => {
  const m = attendanceByDay(punches(['06:00', '10:00'], ['14:00', '18:00']), RIY);
  const att = m.get('2026-10-04')!;
  assert.deepStrictEqual(att.periods.map(p => [hhmm(p.start), hhmm(p.end), p.source]),
    [['06:00', '10:00', 'PUNCH'], ['14:00', '18:00', 'PUNCH']]);
  assert.strictEqual(att.minutes, 480);
  assert.strictEqual(att.breakMinutes, 240);

  // فوق يومٍ رأى أثره ١٢ ساعة متّصلة (GPS بقي يعمل في الاستراحة): البصمة تعلو
  const [base] = composeWorkDays({
    sessions: [], pingRanges: [{ day: '2026-10-04', min: at('2026-10-04T05:50:00Z'), max: at('2026-10-04T18:10:00Z') }],
    visits: [], tzOffsetMin: RIY,
  });
  const [d] = overlayAttendance([base], m);
  assert.strictEqual(d.spanMinutes, 480, 'إجمالي وقت العمل بلا الاستراحة');
  assert.strictEqual(d.breakMinutes, 240);
  assert.strictEqual(d.periods.length, 2);
  assert.strictEqual(hhmm(d.firstActivity), '06:00');
  assert.strictEqual(hhmm(d.lastActivity), '18:00');
});

test('ثلاث فترات: كل خروجٍ يُسجَّل ولو قصر — عشر دقائق استراحةٌ كما هي، لا عتبة تبتلعها', () => {
  const att = attendanceByDay(punches(['06:00', '09:00'], ['09:10', '12:00'], ['14:00', '18:00']), RIY).get('2026-10-04')!;
  assert.deepStrictEqual(att.periods.map(p => [hhmm(p.start), hhmm(p.end)]),
    [['06:00', '09:00'], ['09:10', '12:00'], ['14:00', '18:00']]);
  assert.strictEqual(att.minutes, 180 + 170 + 240);
  assert.strictEqual(att.breakMinutes, 10 + 120);
  assert.strictEqual(hhmm(att.start), '06:00');
  assert.strictEqual(hhmm(att.end), '18:00');
});

test('البصمات تُرتَّب مهما وصلت', () => {
  const att = attendanceByDay(punches(['14:00', '18:00'], ['06:00', '10:00']), RIY).get('2026-10-04')!;
  assert.deepStrictEqual(att.periods.map(p => hhmm(p.start)), ['06:00', '14:00']);
  assert.strictEqual(att.breakMinutes, 240);
});

test('نوبةٌ مفتوحة: فترةٌ بلا نهاية لا تُضاف دقائقها، والاستراحة قبلها تُحسب', () => {
  const att = attendanceByDay(punches(['06:00', '10:00'], ['14:00', null]), RIY).get('2026-10-04')!;
  assert.deepStrictEqual(att.periods.map(p => [hhmm(p.start), hhmm(p.end)]), [['06:00', '10:00'], ['14:00', null]]);
  assert.strictEqual(att.minutes, 240, 'النوبة المفتوحة لا تُحسب حتى الانصراف');
  assert.strictEqual(att.breakMinutes, 240, 'خرج ١ظ وعاد ٥م — الاستراحة معلومة ولو لم ينصرف بعد');
  assert.strictEqual(hhmm(att.end), '10:00', 'آخر انصرافٍ معلوم كما كان');

  const only = attendanceByDay(punches(['06:00', null]), RIY).get('2026-10-04')!;
  assert.strictEqual(only.periods.length, 1);
  assert.strictEqual(only.periods[0].end, null);
  assert.strictEqual(only.minutes, 0);
  assert.strictEqual(only.breakMinutes, 0);
});

test('نوبتان متداخلتان (بيانات مكرّرة) تتّحدان فلا تُعدّ ساعاتهما مرّتين', () => {
  const att = attendanceByDay(punches(['06:00', '10:00'], ['09:00', '11:00']), RIY).get('2026-10-04')!;
  assert.strictEqual(att.periods.length, 1);
  assert.strictEqual(hhmm(att.periods[0].end), '11:00');
  assert.strictEqual(att.minutes, 300, 'لا ٢٤٠ + ١٢٠');
  assert.strictEqual(att.breakMinutes, 0);
  // ونوبةٌ داخل أخرى لا تقصّرها
  const inner = attendanceByDay(punches(['06:00', '12:00'], ['07:00', '08:00']), RIY).get('2026-10-04')!;
  assert.deepStrictEqual(inner.periods.map(p => [hhmm(p.start), hhmm(p.end)]), [['06:00', '12:00']]);
  assert.strictEqual(inner.minutes, 360);
});

// ═══ أين حضر وأين انصرف: موقع كل بصمة يرافق فترتها (طلب المالك: «اجعله يظهر بالتقرير») ═══
const RIYADH_A = { lat: 24.7136, lng: 46.6753 };   // حضور الصباح
const RIYADH_B = { lat: 24.6877, lng: 46.7219 };   // انصراف الظهر
const RIYADH_C = { lat: 24.7743, lng: 46.7386 };   // حضور المساء
const RIYADH_D = { lat: 24.8000, lng: 46.6000 };
const located = (i: string, o: string | null, inn: { lat: number; lng: number } | null, out: { lat: number; lng: number } | null) => ({
  checkInAt: iso(`2026-10-04T${i}:00Z`), checkOutAt: o ? iso(`2026-10-04T${o}:00Z`) : null,
  checkInLat: inn?.lat ?? null, checkInLng: inn?.lng ?? null,
  checkOutLat: out?.lat ?? null, checkOutLng: out?.lng ?? null,
});
const locs = (p: { inLat?: number | null; inLng?: number | null; outLat?: number | null; outLng?: number | null }) =>
  [p.inLat, p.inLng, p.outLat, p.outLng];

test('مواقع البصمات: لكل فترةٍ موقع حضورها وموقع انصرافها، والغائب null', () => {
  const att = attendanceByDay([
    located('14:00', '18:00', RIYADH_C, null),          // انصرف والموقع مغلق
    located('06:00', '10:00', RIYADH_A, RIYADH_B),
  ], RIY).get('2026-10-04')!;
  assert.deepStrictEqual(att.periods.map(locs), [
    [RIYADH_A.lat, RIYADH_A.lng, RIYADH_B.lat, RIYADH_B.lng],
    [RIYADH_C.lat, RIYADH_C.lng, null, null],
  ], 'الموقع يتبع فترته بعد الترتيب');

  // وتصل كما هي بعد التركيب فوق يوم الأثر
  const [base] = composeWorkDays({
    sessions: [], pingRanges: [{ day: '2026-10-04', min: at('2026-10-04T05:50:00Z'), max: at('2026-10-04T18:10:00Z') }],
    visits: [], tzOffsetMin: RIY,
  });
  const [d] = overlayAttendance([base], new Map([['2026-10-04', att]]));
  assert.deepStrictEqual(d.periods.map(locs)[0], [RIYADH_A.lat, RIYADH_A.lng, RIYADH_B.lat, RIYADH_B.lng]);
  // يومٌ بلا بصمة: امتدادٌ بلا مفاتيح مواقع (لا مكان «حضور» لمن لم يبصم)
  assert.ok(!('inLat' in base.periods[0]));
});

test('مواقع البصمات: النوبة المفتوحة بلا موقع انصراف — ولو حمل سجلّها إحداثياتٍ عالقة', () => {
  const att = attendanceByDay([
    located('06:00', '10:00', RIYADH_A, RIYADH_B),
    { ...located('14:00', null, RIYADH_C, null), checkOutLat: 1, checkOutLng: 2 },
  ], RIY).get('2026-10-04')!;
  assert.deepStrictEqual(att.periods.map(locs), [
    [RIYADH_A.lat, RIYADH_A.lng, RIYADH_B.lat, RIYADH_B.lng],
    [RIYADH_C.lat, RIYADH_C.lng, null, null],
  ]);
  assert.strictEqual(att.periods[1].end, null);
});

test('مواقع البصمات: المتّحدة تأخذ موقع أول حضورٍ وموقع الانصراف الذي أنهاها', () => {
  // ٩ص–١ظ ثم ١٢ظ–٢ظ متداخلتان ⇒ فترةٌ واحدة ٩ص–٢ظ: الحضور من الأولى، والانصراف من الثانية (هي التي أنهت)
  const extended = attendanceByDay([
    located('06:00', '10:00', RIYADH_A, RIYADH_B),
    located('09:00', '11:00', RIYADH_C, RIYADH_D),
  ], RIY).get('2026-10-04')!;
  assert.strictEqual(extended.periods.length, 1);
  assert.deepStrictEqual(locs(extended.periods[0]), [RIYADH_A.lat, RIYADH_A.lng, RIYADH_D.lat, RIYADH_D.lng]);

  // نوبةٌ داخل أخرى لا تُنهي المتّحدة ⇒ يبقى انصراف الأولى وموقعه
  const inner = attendanceByDay([
    located('06:00', '12:00', RIYADH_A, RIYADH_B),
    located('07:00', '08:00', RIYADH_C, RIYADH_D),
  ], RIY).get('2026-10-04')!;
  assert.deepStrictEqual(locs(inner.periods[0]), [RIYADH_A.lat, RIYADH_A.lng, RIYADH_B.lat, RIYADH_B.lng]);

  // والمُنهية بلا موقع ⇒ انصرافٌ بلا موقع، لا موقعُ انصرافٍ سابقٍ لم يُنهِ الفترة
  const lost = attendanceByDay([
    located('06:00', '10:00', RIYADH_A, RIYADH_B),
    located('09:00', '11:00', RIYADH_C, null),
  ], RIY).get('2026-10-04')!;
  assert.deepStrictEqual(locs(lost.periods[0]), [RIYADH_A.lat, RIYADH_A.lng, null, null]);
});

test('مواقع البصمات: نصفُ إحداثيٍّ لا يُعدّ موقعاً، وسجلّاتٌ بلا حقول المواقع تبقى صالحة', () => {
  const att = attendanceByDay([
    { ...located('06:00', '10:00', RIYADH_A, RIYADH_B), checkInLng: null, checkOutLat: Number.NaN },
  ], RIY).get('2026-10-04')!;
  assert.deepStrictEqual(locs(att.periods[0]), [null, null, null, null]);
  const bare = attendanceByDay(punches(['06:00', '10:00']), RIY).get('2026-10-04')!;
  assert.deepStrictEqual(locs(bare.periods[0]), [null, null, null, null]);
});

test('حارس: تقرير ساعات العمل يقرأ إحداثيات البصمتين — والعزل والنطاق كما هما', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/reports.ts'), 'utf8');
  const from = src.indexOf('prisma.repAttendance.findMany');
  const q = src.slice(from, src.indexOf('const byRep =', from));
  for (const f of ['checkInLat', 'checkInLng', 'checkOutLat', 'checkOutLng']) {
    assert.match(q, new RegExp(`\\b${f}: true`),`${f} لا يُقرأ — التقرير لا يعرف أين بصم المندوب`);
  }
  assert.match(q, /where: \{ tenantId: tid, checkInAt: \{ gte: fromDate, lt: toEnd \}, \.\.\.\(await scopedRepRecordWhere\(req\)\) \}/,
    'بصمات التقرير خرجت عن عزل الشركة أو نطاق مستخدمها');
});

test('صمت الأثر داخل نوبةٍ لا يقسمها: الفترة من البصمة لا من GPS', () => {
  // GPS صمت أربع ساعات منتصف النوبة (هاتفٌ مقفل) — المندوب لم يبصم خروجاً، فالنوبة فترةٌ واحدة
  const [base] = composeWorkDays({
    sessions: [{ start: at('2026-10-04T06:00:00Z'), end: at('2026-10-04T08:00:00Z') }],
    pingRanges: [{ day: '2026-10-04', min: at('2026-10-04T12:00:00Z'), max: at('2026-10-04T18:00:00Z') }],
    visits: [], tzOffsetMin: RIY,
  });
  const [d] = overlayAttendance([base], attendanceByDay(punches(['06:00', '18:00']), RIY));
  assert.deepStrictEqual(d.periods.map(p => [hhmm(p.start), hhmm(p.end), p.source]), [['06:00', '18:00', 'PUNCH']]);
  assert.strictEqual(d.spanMinutes, 720);
  assert.strictEqual(d.breakMinutes, 0);
});

test('يومٌ بلا بصمة = أرقام ما قبل الفترات حرفياً: امتدادٌ واحد ACTIVITY ولو صمت الأثر ساعات', () => {
  // المقياس القديم: أصغر بداية وأكبر نهاية من كل المصادر، والامتداد بينهما — بلا تقسيمٍ ولا استراحة
  const sessions = [
    { start: at('2026-10-04T05:12:30Z'), end: at('2026-10-04T06:40:10Z') },
    { start: at('2026-10-04T14:05:00Z'), end: at('2026-10-04T14:50:45Z') },
  ];
  const pings = [{ day: '2026-10-04', min: at('2026-10-04T05:00:00Z'), max: at('2026-10-04T17:20:00Z') }];
  const visits = [
    { customerName: 'أ', at: at('2026-10-04T10:00:00Z'), durationSec: 777 },
    { customerName: 'ب', at: at('2026-10-04T17:25:00Z'), durationSec: 1234 },    // تمدّ آخر الأثر
    { customerName: 'ب', at: at('2026-10-04T17:40:00Z'), durationSec: null },
  ];
  const [d] = composeWorkDays({ sessions, pingRanges: pings, visits, tzOffsetMin: KSA });
  const first = at('2026-10-04T05:00:00Z');
  const last = new Date(at('2026-10-04T17:25:00Z').getTime() + 1234 * 1000);
  assert.strictEqual(d.firstActivity.toISOString(), first.toISOString());
  assert.strictEqual(d.lastActivity.toISOString(), last.toISOString());
  assert.strictEqual(d.spanMinutes, Math.round((last.getTime() - first.getTime()) / 60000));
  assert.deepStrictEqual(d.periods, [{ start: first, end: last, source: 'ACTIVITY' }]);
  assert.strictEqual(d.breakMinutes, 0);

  // زيارتان بينهما سبع ساعات بلا أي أثر: يومٌ واحد ٧س١٠د كما كان — الصمت لا يُقرأ استراحة
  const [gap] = composeWorkDays({
    sessions: [], pingRanges: [], tzOffsetMin: KSA,
    visits: [
      { customerName: 'بقالة النور', at: at('2026-08-04T05:00:00Z'), durationSec: 900 },
      { customerName: 'أسواق الخير', at: at('2026-08-04T12:00:00Z'), durationSec: 600 },
    ],
  });
  assert.strictEqual(gap.periods.length, 1);
  assert.strictEqual(gap.spanMinutes, 7 * 60 + 10);
  assert.strictEqual(gap.breakMinutes, 0);

  // وبلا بصمة يبقى كما هو بعد التركيب
  const [same] = overlayAttendance([d], attendanceByDay([], RIY));
  assert.strictEqual(same, d);
});

test('جلسةٌ تعبر منتصف الليل بلا بصمة: امتدادٌ لكل يوم بحصّته ولا استراحة', () => {
  // 19:00Z → 23:00Z = ١٠م → ٢ص بالرياض
  const days = composeWorkDays({
    sessions: [{ start: at('2026-10-04T19:00:00Z'), end: at('2026-10-04T23:00:00Z') }],
    pingRanges: [], visits: [], tzOffsetMin: KSA,
  });
  assert.deepStrictEqual(days.map(d => d.date), ['2026-10-04', '2026-10-05']);
  for (const d of days) {
    assert.strictEqual(d.periods.length, 1);
    assert.strictEqual(d.periods[0].source, 'ACTIVITY');
    assert.strictEqual(d.spanMinutes, 120);
    assert.strictEqual(d.breakMinutes, 0);
  }
  assert.strictEqual(days[1].periods[0].start.toISOString(), '2026-10-04T21:00:00.000Z', 'يبدأ اليوم الثاني من منتصف ليله المحلي');
});

test('الأيام الغائبة بلا فترات ولا استراحة', () => {
  const days = composeWorkDays({
    sessions: [], pingRanges: [], visits: [],
    tzOffsetMin: KSA, range: { from: '2026-10-01', to: '2026-10-03' },
  });
  assert.strictEqual(days.length, 3);
  for (const d of days) {
    assert.strictEqual(d.absent, true);
    assert.deepStrictEqual(d.periods, []);
    assert.strictEqual(d.breakMinutes, 0);
    assert.strictEqual(d.spanMinutes, 0);
  }
});

test('شكل الاستجابة: الفترات بتوقيت ISO والحقول القديمة باقية للعملاء الأقدم', () => {
  const days = composeWorkDays({
    sessions: [{ start: at('2026-10-04T06:00:00Z'), end: at('2026-10-04T10:00:00Z') }],
    pingRanges: [], visits: [], tzOffsetMin: KSA, range: { from: '2026-10-04', to: '2026-10-05' },
  });
  const withPunch = overlayAttendance(days, attendanceByDay([
    { checkInAt: iso('2026-10-05T06:00:00Z'), checkOutAt: iso('2026-10-05T10:00:00Z') },
    { checkInAt: iso('2026-10-05T14:00:00Z'), checkOutAt: null },
  ], KSA));
  // ما يرسله res.json حرفياً
  const wire = JSON.parse(JSON.stringify(withPunch)) as Array<Record<string, unknown>>;
  for (const d of wire) {
    for (const k of ['date', 'firstActivity', 'lastActivity', 'spanMinutes', 'appMinutes', 'visits', 'visitsCount', 'visitsSec', 'absent', 'periods', 'breakMinutes']) {
      assert.ok(k in d, `الحقل ${k} غائب`);
    }
  }
  assert.deepStrictEqual(wire[0].periods, [{ start: '2026-10-04T06:00:00.000Z', end: '2026-10-04T10:00:00.000Z', source: 'ACTIVITY' }]);
  // فترات البصمة تحمل مواقعها دائماً (null بلا التقاط) — والامتداد ACTIVITY بلا مفاتيح مواقع
  const noLoc = { inLat: null, inLng: null, outLat: null, outLng: null };
  assert.deepStrictEqual(wire[1].periods, [
    { start: '2026-10-05T06:00:00.000Z', end: '2026-10-05T10:00:00.000Z', source: 'PUNCH', ...noLoc },
    { start: '2026-10-05T14:00:00.000Z', end: null, source: 'PUNCH', ...noLoc },
  ]);
  assert.strictEqual(wire[1].breakMinutes, 240);
});

test('حارس: لا عتبة زمنية تقسم اليوم، وGPS يُجمَّع في القاعدة لطرفي اليوم وحدهما وبلا make_interval', () => {
  // قرار المالك: الفترات من البصمات لا من صمت الأثر — لا ثابت عتبةٍ ولا مُقسِّم أثرٍ يعود خلسة
  const exported = Object.keys(workDayModule);
  for (const k of ['BREAK_GAP_MIN', 'activityPeriods', 'PING_BUCKET_MIN']) {
    assert.ok(!exported.includes(k), `${k} عاد: الفترات تُستنتج من الزمن بدل البصمة`);
  }
  const engine = fs.readFileSync(path.join(__dirname, '../services/workDay.ts'), 'utf8');
  assert.doesNotMatch(engine, /BREAK_GAP|GAP_MS/, 'عتبة فراغٍ في المحرّك');

  const src = fs.readFileSync(path.join(__dirname, '../routes/reports.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const q = src.slice(src.indexOf('FROM "rep_locations"'), src.indexOf('prisma.repAttendance.findMany'));
  assert.match(q, /GROUP BY 1, 2`/, 'GPS لكل (مندوب × يوم محلي) وحده — الدلاء لم يعد لها مستهلك');
  assert.doesNotMatch(src, /make_interval/, 'make_interval مع bigint أسقط المسار على الإنتاج (42883)');
});
