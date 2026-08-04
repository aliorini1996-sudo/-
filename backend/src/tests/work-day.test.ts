/**
 * محرّك «يوم العمل الميداني» — composeWorkDays وقصّ الجلسات على الأيام المحلية.
 *
 * الخلل الذي يحرسه: تقرير الساعات كان يجمع جلسات التطبيق وحدها (نبضة تشترط
 * اتصالاً) فيتناقض مع خريطة التتبّع التي ترى GPS يوماً كاملاً — والمشرف يقرأ
 * «ساعتين» لمندوبٍ مساره من الثامنة للرابعة. المقياس الموحَّد: أول أثر → آخر أثر.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { composeWorkDays, splitByLocalDay, dayKey } from '../services/workDay';

const KSA = 180; // الرياض UTC+3
const at = (iso: string) => new Date(iso);

test('مفتاح اليوم يتبع توقيت المندوب لا الخادم', () => {
  // 23:30 UTC = 02:30 فجر اليوم التالي بتوقيت الرياض
  assert.equal(dayKey(at('2026-08-03T23:30:00Z'), KSA), '2026-08-04');
  assert.equal(dayKey(at('2026-08-03T23:30:00Z'), 0), '2026-08-03');
});

test('جلسة تعبر منتصف الليل المحلي تتوزّع على يومين بحصّتيهما', () => {
  // 20:00→22:00 UTC = 23:00→01:00 بتوقيت الرياض
  const parts = splitByLocalDay({ start: at('2026-08-03T20:00:00Z'), end: at('2026-08-03T22:00:00Z') }, KSA);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map(p => p.day), ['2026-08-03', '2026-08-04']);
  assert.equal((parts[0].end.getTime() - parts[0].start.getTime()) / 60000, 60);
  assert.equal((parts[1].end.getTime() - parts[1].start.getTime()) / 60000, 60);
});

test('فترة فارغة أو معكوسة لا تنتج شيئاً', () => {
  assert.deepEqual(splitByLocalDay({ start: at('2026-08-03T10:00:00Z'), end: at('2026-08-03T10:00:00Z') }, KSA), []);
  assert.deepEqual(splitByLocalDay({ start: at('2026-08-03T10:00:00Z'), end: at('2026-08-03T09:00:00Z') }, KSA), []);
});

test('السيناريو الذي أبلغ عنه المالك: GPS يمتدّ أبعد من الجلسات', () => {
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
  assert.equal(days[0].appMinutes, 135);       // نشاط التطبيق: 2س15د فقط — الرقمان معاً يحكيان القصة
});

test('الزيارة أثرٌ يمدّ اليوم حتى بلا جلسات ولا GPS', () => {
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

test('مجموع مدد الزيارات يطابق حساب خريطة التتبّع (المؤقّتة وحدها)', () => {
  const days = composeWorkDays({
    sessions: [],
    pingRanges: [],
    visits: [
      { customerName: 'أ', at: at('2026-08-04T06:00:00Z'), durationSec: 300 },
      { customerName: 'ب', at: at('2026-08-04T07:00:00Z'), durationSec: null }, // زيارة ملاحظة — بلا مدّة
      { customerName: 'ج', at: at('2026-08-04T08:00:00Z'), durationSec: 450 },
    ],
    tzOffsetMin: KSA,
  });
  assert.equal(days[0].visitsSec, 750);   // كما تجمعها TrackingPage: durationSec > 0 فقط
  assert.equal(days[0].visitsCount, 3);   // لكن العدّ يشمل الجميع
});

test('الأيام تخرج مرتّبةً والزيارات داخل اليوم مرتّبة زمنياً', () => {
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

test('أثرٌ واحد يتيم = يومٌ بامتداد صفري لا انهيار', () => {
  const days = composeWorkDays({
    sessions: [],
    pingRanges: [],
    visits: [{ customerName: 'وحيدة', at: at('2026-08-04T09:00:00Z'), durationSec: null }],
    tzOffsetMin: KSA,
  });
  assert.equal(days[0].spanMinutes, 0);
  assert.equal(days[0].firstActivity.getTime(), days[0].lastActivity.getTime());
});
