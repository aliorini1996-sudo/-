import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attendanceDayCells, breakOf, compactMinutes, dayEnd, formatPeriods, periodsOf, type WorkDayLike } from './workPeriods';

// الدوام المتقطّع (بلاغ المالك): ٩ص–١ظ ثم ٥م–٩م بالرياض = 06–10Z ثم 14–18Z. صفٌّ واحد لليوم لا صفٌّ لكل فترة.
// والفترات من البصمات وحدها (كل دخولٍ يُسجَّل وكل خروجٍ يُسجَّل) — يومٌ بلا بصمة امتدادٌ واحد ACTIVITY.
const tr = (s: string) => s;
const clock = (iso: string) => iso.slice(11, 16);   // ساعة UTC تكفي للاختبار
const fx = { tr, clock, minutes: (m: number) => `${Math.floor(m / 60)}س${m % 60}د`, visitDur: (s: number | null) => (s ? `${s}ث` : null) };

const split: WorkDayLike = {
  firstActivity: '2026-10-04T06:00:00.000Z', lastActivity: '2026-10-04T18:00:00.000Z', absent: false,
  spanMinutes: 480, appMinutes: 130, visitsCount: 3, visitsSec: 1200, breakMinutes: 240,
  periods: [
    { start: '2026-10-04T06:00:00.000Z', end: '2026-10-04T10:00:00.000Z', source: 'PUNCH' },
    { start: '2026-10-04T14:00:00.000Z', end: '2026-10-04T18:00:00.000Z', source: 'PUNCH' },
  ],
};

test('الفترات في سطرٍ واحد مفصولةً بنقطة، والمفتوحة بلا انصراف', () => {
  assert.equal(formatPeriods(split.periods!, clock, 'لم ينصرف'), '06:00 – 10:00 · 14:00 – 18:00');
  assert.equal(formatPeriods([{ start: '2026-10-04T14:00:00.000Z', end: null }], clock, 'لم ينصرف'), '14:00 – لم ينصرف');
  assert.equal(formatPeriods([], clock, '…'), '');
});

test('خادمٌ أقدم بلا فترات ⇒ فترةٌ واحدة من أول أثر إلى آخره (كما كان العرض)، والغائب بلا فترات', () => {
  const old: WorkDayLike = { ...split, periods: undefined, breakMinutes: undefined };
  assert.deepEqual(periodsOf(old), [{ start: split.firstActivity, end: split.lastActivity, source: 'ACTIVITY' }]);
  assert.equal(breakOf(old), 0);
  assert.deepEqual(periodsOf({ ...split, absent: true }), []);
  assert.equal(breakOf({ ...split, absent: true }), 0);
});

test('مدّة الاستراحة مختصرة بلا أصفار', () => {
  assert.equal(compactMinutes(240, tr), '4 س');
  assert.equal(compactMinutes(270, tr), '4 س 30 د');
  assert.equal(compactMinutes(45, tr), '45 د');
});

test('نهاية اليوم غير معلومة متى كانت آخر فترة نوبةً مفتوحة', () => {
  const open: WorkDayLike = { ...split, lastActivity: '2026-10-04T10:00:00.000Z',
    periods: [split.periods![0], { start: '2026-10-04T14:00:00.000Z', end: null, source: 'PUNCH' }] };
  assert.equal(dayEnd(open), null);
  assert.equal(dayEnd(split), split.lastActivity);
  assert.equal(attendanceDayCells(open, fx)['نهاية العمل'], 'لم ينصرف');
});

test('ورقة «الحضور اليومي»: عمودا «فترات العمل» و«الاستراحة» بعد البداية والنهاية، والإجمالي بلا الاستراحة', () => {
  const row = attendanceDayCells(split, fx);
  assert.deepEqual(Object.keys(row), [
    'بداية العمل', 'نهاية العمل', 'فترات العمل', 'الاستراحة',
    'إجمالي وقت العمل', 'نشاط التطبيق', 'عدد الزيارات', 'وقت داخل الزيارات',
  ]);
  assert.equal(row['فترات العمل'], '06:00 – 10:00 · 14:00 – 18:00');
  assert.equal(row['الاستراحة'], '4 س');
  assert.equal(row['إجمالي وقت العمل'], '8س0د', 'ثماني ساعات عمل لا اثنتا عشرة');
  assert.equal(row['بداية العمل'], '06:00');
  assert.equal(row['نهاية العمل'], '18:00');

  // يومٌ بلا بصمة: امتدادٌ واحد من أول أثرٍ إلى آخره كما كان، ولا استراحة تُعرض ولو صمت الأثر ساعات
  const single = attendanceDayCells({ ...split, breakMinutes: 0, spanMinutes: 720,
    periods: [{ start: split.firstActivity, end: split.lastActivity, source: 'ACTIVITY' }] }, fx);
  assert.equal(single['الاستراحة'], '—');
  assert.equal(single['فترات العمل'], '06:00 – 18:00');
  assert.equal(single['إجمالي وقت العمل'], '12س0د', 'آخر أثر − أوله كما كان');

  // يومٌ غائب: صفٌّ فارغ لا يُحذف
  const absent = attendanceDayCells({ ...split, absent: true, periods: [], breakMinutes: 0 }, fx);
  assert.equal(absent['فترات العمل'], '—');
  assert.equal(absent['الاستراحة'], '—');
  assert.equal(absent['بداية العمل'], 'لا نشاط');
});

test('حارس: الورقتان (كل المناديب والمندوب الواحد) تبنيان خلايا اليوم من مصدرٍ واحد، والعرض صفٌّ لكل يوم', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'pages', 'ReportsPage.tsx'), 'utf8');
  assert.equal(src.match(/\.\.\.attendanceDayCells\(d, dayCellFx\)/g)?.length, 2, 'ورقةٌ تبني خلايا اليوم بنفسها ستنحرف عن الأخرى');
  // عرض الأعمدة يطابق عددها: ورقة الكل = المندوب + التاريخ + ٨، وورقة المندوب = التاريخ + ٨
  assert.match(src, /name: tr\('الحضور اليومي'\), rows: daily\.rows, merges: daily\.merges, colWidths: \[(\d+, ){9}\d+\]/);
  assert.match(src, /name: tr\('الحضور اليومي'\), colWidths: \[(\d+, ){8}\d+\]/);
  // الجدول يعرض الفترات في خليةٍ واحدة (periodsOf داخل صفّ اليوم) لا صفّاً لكل فترة
  assert.match(src, /periodsOf\(d\)\.map\(\(p, i\) => \(\s*<Fragment key=\{i\}>/);
  const m = fs.readFileSync(path.join(process.cwd(), 'src', 'm', 'MReports.tsx'), 'utf8');
  assert.match(m, /formatPeriods\(periodsOf\(d\), formatTime, tr\('لم ينصرف'\)\)/, 'الجوال لا يعرض فترات اليوم');
});

test('ثلاث بصمات حضور وانصراف ⇒ ثلاث فترات في خليةٍ واحدة، والاستراحة مجموع ما بينها كما أرسله الخادم', () => {
  const three: WorkDayLike = { ...split, spanMinutes: 590, breakMinutes: 130,
    periods: [
      { start: '2026-10-04T06:00:00.000Z', end: '2026-10-04T09:00:00.000Z', source: 'PUNCH' },
      { start: '2026-10-04T09:10:00.000Z', end: '2026-10-04T12:00:00.000Z', source: 'PUNCH' },
      { start: '2026-10-04T14:00:00.000Z', end: '2026-10-04T18:00:00.000Z', source: 'PUNCH' },
    ] };
  const row = attendanceDayCells(three, fx);
  assert.equal(row['فترات العمل'], '06:00 – 09:00 · 09:10 – 12:00 · 14:00 – 18:00');
  assert.equal(row['الاستراحة'], '2 س 10 د', 'عشر دقائق خروجٍ مسجَّل تُعدّ — لا عتبة تبتلعها');
  assert.equal(row['إجمالي وقت العمل'], '9س50د');
});

test('حارس: لا صياغة توحي بكشفٍ آلي للاستراحة بالزمن — الشرح يذكر البصمة، والامتداد بلا بصمة موسومٌ بمصدره', () => {
  const page = fs.readFileSync(path.join(process.cwd(), 'src', 'pages', 'ReportsPage.tsx'), 'utf8');
  const m = fs.readFileSync(path.join(process.cwd(), 'src', 'm', 'MReports.tsx'), 'utf8');
  const dict = fs.readFileSync(path.join(process.cwd(), 'src', 'i18n', 'strings.ts'), 'utf8');
  for (const [name, src] of [['ReportsPage', page], ['MReports', m], ['strings', dict]] as const) {
    assert.doesNotMatch(src, /ساعة ونصفا|غياب كل أثر/, `${name}: نصّ عتبة الصمت عاد`);
  }
  const punchHint = /tr\('ومع بصمة الحضور والانصراف يسجل كل دخول وكل خروج فترة عمل ويحسب الإجمالي من مجموع الفترات بلا ما بينها'\)/;
  assert.match(page, punchHint, 'الويب لا يشرح أن الفترات من البصمة');
  assert.match(m, punchHint, 'الجوال لا يشرح أن الفترات من البصمة');
  assert.match(page, /p\.source === 'PUNCH' \? tr\('من بصمة الحضور والانصراف'\) : tr\('من أول أثر مرصود إلى آخره بلا بصمة'\)/);
});
