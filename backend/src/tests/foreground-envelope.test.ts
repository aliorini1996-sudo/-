// غلاف يوم العمل لنقاط الخلفية (قرار المالك، ٤ نوفمبر ٢٠٢٦) — services/foregroundEnvelope.ts:
//   • الغلاف لكل يومٍ محلي من الأثر الأمامي (نقاط الصفحة، الجلسات، الزيارات، البصمات): من أوله إلى آخره.
//   • الأثر من صفوفه (foregroundEvidenceByRep): الجلسة فترة، والبصمة لحظتها، ونهاية الزيارة في يومها وحده.
//   • نقطة الجهاز تُعدّ في المسافة داخل غلاف يومها وحده؛ نقطة الصفحة دائماً كما كانت.
//   • شرط SQL (deviceEnvelopeSql) بالمعنى نفسه، بلحظاتٍ معاملاتٍ لا نصّ.
//   • المسافة: قيادة النهار والشاشة مقفلة تُحسب، والمساء بعد الانصراف لا.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  foregroundEnvelopes, foregroundEvidenceByRep, withinEnvelope, countsTowardDistance, deviceEnvelopeSql, type EnvelopeWindow,
} from '../services/foregroundEnvelope';
import { trackedMeters } from '../services/repRanking';
import { LOCATION_SOURCE_DEVICE } from '../services/deviceTrack';

const KSA = 180;
const iso = (s: string) => new Date(s);
/** لحظة بتوقيت الرياض: '2026-11-04 09:30' ⇒ 06:30Z */
const ksa = (s: string) => new Date(Date.parse(s.replace(' ', 'T') + ':00.000Z') - KSA * 60_000);

test('الغلاف لكل يومٍ محلي: من أول أثرٍ أمامي إلى آخره، والأيام مرتّبة', () => {
  const w = foregroundEnvelopes([
    { start: ksa('2026-11-04 10:00'), end: ksa('2026-11-04 12:00') },  // جلسة
    { start: ksa('2026-11-04 08:15') },                                 // بصمة حضور مفتوحة / نقطة صفحة
    { start: ksa('2026-11-04 16:30'), end: ksa('2026-11-04 16:50') },  // زيارة بمؤقّت
    { start: ksa('2026-11-03 09:00'), end: ksa('2026-11-03 17:00') },  // نوبة مغلقة في اليوم السابق
  ], KSA);
  assert.deepEqual(w, [
    { day: '2026-11-03', start: ksa('2026-11-03 09:00'), end: ksa('2026-11-03 17:00') },
    { day: '2026-11-04', start: ksa('2026-11-04 08:15'), end: ksa('2026-11-04 16:50') },
  ]);
});

test('اليوم المحلي لا يوم UTC: أثرٌ بعد منتصف ليل الرياض (٢١:٣٠Z) ليومه التالي', () => {
  const w = foregroundEnvelopes([{ start: iso('2026-11-03T21:30:00Z') }, { start: iso('2026-11-04T05:00:00Z') }], KSA);
  assert.deepEqual(w.map((x) => x.day), ['2026-11-04']);
  assert.equal(w[0].start.toISOString(), '2026-11-03T21:30:00.000Z');
});

test('فترةٌ عابرةٌ لمنتصف الليل تمدّ كل يومٍ بحصّته — لا يوم بدايتها كلّه', () => {
  const w = foregroundEnvelopes([{ start: ksa('2026-11-04 22:00'), end: ksa('2026-11-05 01:30') }], KSA);
  assert.deepEqual(w, [
    { day: '2026-11-04', start: ksa('2026-11-04 22:00'), end: ksa('2026-11-05 00:00') },
    { day: '2026-11-05', start: ksa('2026-11-05 00:00'), end: ksa('2026-11-05 01:30') },
  ]);
});

test('النوبة المفتوحة (بلا انصراف) لحظة حضورها وحدها، والفترة الفاسدة لحظتان، والتاريخ الفاسد يُهمل', () => {
  assert.deepEqual(foregroundEnvelopes([{ start: ksa('2026-11-04 08:00'), end: null }], KSA),
    [{ day: '2026-11-04', start: ksa('2026-11-04 08:00'), end: ksa('2026-11-04 08:00') }]);
  assert.deepEqual(foregroundEnvelopes([{ start: ksa('2026-11-04 12:00'), end: ksa('2026-11-04 09:00') }], KSA),
    [{ day: '2026-11-04', start: ksa('2026-11-04 09:00'), end: ksa('2026-11-04 12:00') }]);
  assert.deepEqual(foregroundEnvelopes([{ start: new Date('x') }, { start: ksa('2026-11-04 08:00'), end: new Date('x') }], KSA),
    [{ day: '2026-11-04', start: ksa('2026-11-04 08:00'), end: ksa('2026-11-04 08:00') }]);
  assert.deepEqual(foregroundEnvelopes([], KSA), []);
});

test('المدى يُسقط أغلفة الأيام التي لا تمسّه — جلسة اليوم السابق لا تضيف معاملاتٍ بلا طائل', () => {
  const from = ksa('2026-11-04 00:00');
  const to = ksa('2026-11-05 00:00');
  const w = foregroundEnvelopes([
    { start: ksa('2026-11-03 09:00'), end: ksa('2026-11-03 17:00') },
    { start: ksa('2026-11-03 23:00'), end: ksa('2026-11-04 00:40') }, // تعبر إلى أول أيام المدى
    { start: ksa('2026-11-04 15:00') },
    { start: ksa('2026-11-05 09:00') },
  ], KSA, { from, to });
  assert.deepEqual(w, [{ day: '2026-11-04', start: ksa('2026-11-04 00:00'), end: ksa('2026-11-04 15:00') }]);
});

test('نقطة الصفحة تُعدّ دائماً، ونقطة الجهاز داخل غلاف يومها وحده (شاملاً الطرفين)', () => {
  const w = foregroundEnvelopes([{ start: ksa('2026-11-04 08:00'), end: ksa('2026-11-04 17:00') }], KSA);
  const dev = (s: string) => ({ capturedAt: ksa(s), source: LOCATION_SOURCE_DEVICE });
  assert.equal(countsTowardDistance(dev('2026-11-04 12:00'), w), true, 'القيادة نهاراً والشاشة مقفلة');
  assert.equal(countsTowardDistance(dev('2026-11-04 08:00'), w), true);
  assert.equal(countsTowardDistance(dev('2026-11-04 17:00'), w), true);
  assert.equal(countsTowardDistance(dev('2026-11-04 17:01'), w), false, 'المساء بعد الانصراف');
  assert.equal(countsTowardDistance(dev('2026-11-04 07:30'), w), false, 'قبل أول أثرٍ أمامي');
  assert.equal(countsTowardDistance(dev('2026-11-05 10:00'), w), false, 'يومٌ بلا أثرٍ أمامي');
  for (const source of [null, undefined]) {
    assert.equal(countsTowardDistance({ capturedAt: ksa('2026-11-04 22:00'), source }, w), true, 'نقطة الصفحة كما كانت');
    assert.equal(countsTowardDistance({ capturedAt: ksa('2026-11-04 22:00'), source }, []), true);
  }
  assert.equal(withinEnvelope(ksa('2026-11-04 12:00'), []), false);
});

/** يقيّم شرط deviceEnvelopeSql على صفٍّ كما تقيّمه القاعدة — بنصّه ومعاملاته الفعليّة لا بنسخةٍ منه */
function evalSql(sql: { text: string; values: unknown[] }, row: { capturedAt: Date; source: string | null }): boolean {
  if (row.source === null) return true;
  const n = (sql.text.match(/"capturedAt" >= \$\d+ AND "capturedAt" <= \$\d+/g) ?? []).length;
  for (let i = 0; i < n; i++) {
    const a = sql.values[2 * i] as Date;
    const b = sql.values[2 * i + 1] as Date;
    if (row.capturedAt >= a && row.capturedAt <= b) return true;
  }
  return false;
}

test('deviceEnvelopeSql: نقطة الصفحة أو لحظةٌ داخل أحد الأغلفة، بمعاملاتٍ لا نصّ — وبلا غلافٍ نقاط الصفحة وحدها', () => {
  const w: EnvelopeWindow[] = [
    { day: '2026-11-03', start: ksa('2026-11-03 09:00'), end: ksa('2026-11-03 17:00') },
    { day: '2026-11-04', start: ksa('2026-11-04 08:15'), end: ksa('2026-11-04 16:50') },
  ];
  const s = deviceEnvelopeSql(w);
  assert.equal(s.text, '("source" IS NULL OR ("capturedAt" >= $1 AND "capturedAt" <= $2) OR ("capturedAt" >= $3 AND "capturedAt" <= $4))');
  assert.deepEqual(s.values, [w[0].start, w[0].end, w[1].start, w[1].end]);
  const none = deviceEnvelopeSql([]);
  assert.equal(none.text, '("source" IS NULL)');
  assert.deepEqual(none.values, []);

  // الشرط والمرجع الصرف متطابقان على كل حالة
  const rows = [
    ...['2026-11-03 08:59', '2026-11-03 09:00', '2026-11-03 13:00', '2026-11-03 17:00', '2026-11-03 21:00',
      '2026-11-04 08:00', '2026-11-04 12:00', '2026-11-04 16:50', '2026-11-04 23:59', '2026-11-05 10:00']
      .flatMap((t) => [{ capturedAt: ksa(t), source: LOCATION_SOURCE_DEVICE as string | null }, { capturedAt: ksa(t), source: null }]),
  ];
  for (const sql of [s, none]) {
    const wins = sql === s ? w : [];
    for (const r of rows) assert.equal(evalSql(sql, r), countsTowardDistance(r, wins), `${r.source} ${r.capturedAt.toISOString()}`);
  }
});

test('المسافة: قيادة النهار والشاشة مقفلة تُحسب، والطريق إلى البيت بعد الانصراف لا — ونقاط الصفحة كما كانت', () => {
  // يوم مندوب: حضور ٨:٠٠، الصفحة مفتوحة ٨:٠٠–٨:٣٠، ثم الشاشة مقفلة يقود (نقاط جهاز) حتى زيارةٍ ١٠:٠٠–١٠:٢٠،
  // وانصراف ١٦:٠٠، ثم يقود إلى البيت ١٨:٠٠–١٨:٣٠ (نقاط جهاز) والخدمة تعمل حتى منتصف الليل
  const evidence = foregroundEvidenceByRep({
    webDays: [],
    shifts: [{ salesRepId: 'r', checkInAt: ksa('2026-11-04 08:00'), checkOutAt: ksa('2026-11-04 16:00') }],
    sessions: [{ salesRepId: 'r', startedAt: ksa('2026-11-04 08:00'), lastBeatAt: ksa('2026-11-04 08:30') }],
    visits: [{ salesRepId: 'r', createdAt: ksa('2026-11-04 10:20'), startedAt: ksa('2026-11-04 10:00'), durationSec: 20 * 60 }],
  }, KSA).get('r') ?? [];
  const w = foregroundEnvelopes(evidence, KSA);
  assert.deepEqual(w, [{ day: '2026-11-04', start: ksa('2026-11-04 08:00'), end: ksa('2026-11-04 16:00') }]);
  // كل دقيقةٍ ٠٫٠٠٥ درجة عرض (~٥٥٥ م ⇒ ~٣٣ كم/س) — حركةٌ معقولة تحت سقف السرعة
  const drive = (from: string, minutes: number, lat0: number) =>
    Array.from({ length: minutes + 1 }, (_, i) => ({
      lat: lat0 + i * 0.005, lng: 46.7, accuracy: 10, capturedAt: new Date(ksa(from).getTime() + i * 60_000), source: LOCATION_SOURCE_DEVICE as string | null,
    }));
  const day = drive('2026-11-04 08:40', 30, 24.6);    // ~١٦٫٧ كم نهاراً
  const evening = drive('2026-11-04 18:00', 30, 24.9); // ~١٦٫٧ كم بعد الانصراف
  const all = [...day, ...evening];
  const kept = all.filter((p) => countsTowardDistance(p, w));
  const km = (pts: typeof all) => trackedMeters(pts) / 1000;
  assert.equal(kept.length, day.length, 'المساء تسرّب');
  assert.ok(Math.abs(km(kept) - km(day)) < 0.001);
  assert.ok(km(all) > 2 * km(day) - 0.5, 'بلا الغلاف كان المساء سيُضاعف الكيلو');
  // نقاط الصفحة نفسها في المساء (المندوب فتح التطبيق) تُعدّ كما كانت
  const webEvening = evening.map((p) => ({ ...p, source: null }));
  assert.equal(webEvening.filter((p) => countsTowardDistance(p, w)).length, webEvening.length);
});

// ─── الأثر من صفوفه (foregroundEvidenceByRep) ───
const rows = (o: Partial<Parameters<typeof foregroundEvidenceByRep>[0]>) =>
  ({ webDays: [], sessions: [], visits: [], shifts: [], ...o });
const envOf = (o: Partial<Parameters<typeof foregroundEvidenceByRep>[0]>, rep = 'r') =>
  foregroundEnvelopes(foregroundEvidenceByRep(rows(o), KSA).get(rep) ?? [], KSA);

test('الأثر لكل مندوب على حدة: طرفا نقاط الصفحة لحظتان (نصّاً أو تاريخاً)، والجلسة فترة تعبر منتصف الليل بحصّتها', () => {
  const ev = foregroundEvidenceByRep(rows({
    webDays: [
      { salesRepId: 'a', min: ksa('2026-11-04 07:50'), max: ksa('2026-11-04 15:10') },
      { salesRepId: 'b', min: ksa('2026-11-04 09:00').toISOString(), max: ksa('2026-11-04 11:00').toISOString() },
    ],
    sessions: [{ salesRepId: 'a', startedAt: ksa('2026-11-04 23:30'), lastBeatAt: ksa('2026-11-05 00:20') }],
  }), KSA);
  assert.deepEqual([...ev.keys()].sort(), ['a', 'b']);
  assert.deepEqual(foregroundEnvelopes(ev.get('a')!, KSA), [
    { day: '2026-11-04', start: ksa('2026-11-04 07:50'), end: ksa('2026-11-05 00:00') },
    { day: '2026-11-05', start: ksa('2026-11-05 00:00'), end: ksa('2026-11-05 00:20') },
  ]);
  assert.deepEqual(foregroundEnvelopes(ev.get('b')!, KSA),
    [{ day: '2026-11-04', start: ksa('2026-11-04 09:00'), end: ksa('2026-11-04 11:00') }]);
});

test('البصمة لحظتها: نوبةٌ نُسي انصرافها حتى صباح الغد لا تفتح المساء والليل لنقاط الجهاز', () => {
  // حضر ٨:٠٠ وانصرف ٧:٥٠ من الغد (نسي الانصراف)، وآخر زيارةٍ له ١٥:٠٠–١٥:٢٠
  const w = envOf({
    shifts: [{ salesRepId: 'r', checkInAt: ksa('2026-11-04 08:00'), checkOutAt: ksa('2026-11-05 07:50') }],
    visits: [{ salesRepId: 'r', createdAt: ksa('2026-11-04 15:00'), startedAt: ksa('2026-11-04 15:00'), durationSec: 20 * 60 }],
  });
  assert.deepEqual(w, [
    { day: '2026-11-04', start: ksa('2026-11-04 08:00'), end: ksa('2026-11-04 15:20') },
    { day: '2026-11-05', start: ksa('2026-11-05 07:50'), end: ksa('2026-11-05 07:50') },
  ]);
  const dev = (s: string) => ({ capturedAt: ksa(s), source: LOCATION_SOURCE_DEVICE });
  assert.equal(countsTowardDistance(dev('2026-11-04 12:00'), w), true);
  assert.equal(countsTowardDistance(dev('2026-11-04 21:00'), w), false, 'المساء دخل بانصرافٍ من الغد');
  assert.equal(countsTowardDistance(dev('2026-11-05 03:00'), w), false, 'الليل دخل بانصرافٍ من الغد');
  // النوبة المفتوحة: لحظة الحضور وحدها
  assert.deepEqual(envOf({ shifts: [{ salesRepId: 'r', checkInAt: ksa('2026-11-04 08:00'), checkOutAt: null }] }),
    [{ day: '2026-11-04', start: ksa('2026-11-04 08:00'), end: ksa('2026-11-04 08:00') }]);
});

test('الزيارة: بدايتها (startedAt || createdAt) ونهاية مؤقّتها في يومها وحده — كما يمدّ composeWorkDays اليوم', () => {
  assert.deepEqual(envOf({ visits: [
    { salesRepId: 'r', createdAt: ksa('2026-11-04 10:40'), startedAt: ksa('2026-11-04 10:00'), durationSec: 30 * 60 },
    { salesRepId: 'r', createdAt: ksa('2026-11-04 13:00'), startedAt: null, durationSec: null }, // زيارة ملاحظة بوقت تسجيلها
  ] }), [{ day: '2026-11-04', start: ksa('2026-11-04 10:00'), end: ksa('2026-11-04 13:00') }]);
  // مؤقّتٌ عالق بمدّة ١٨ ساعة يعبر الليل: بدايته وحدها، لا المساء والليل كلّه
  assert.deepEqual(envOf({ visits: [
    { salesRepId: 'r', createdAt: ksa('2026-11-04 16:00'), startedAt: ksa('2026-11-04 16:00'), durationSec: 18 * 3600 },
  ] }), [{ day: '2026-11-04', start: ksa('2026-11-04 16:00'), end: ksa('2026-11-04 16:00') }]);
  // مدّة صفرٌ أو سالبة: لحظة البداية وحدها
  assert.deepEqual(envOf({ visits: [
    { salesRepId: 'r', createdAt: ksa('2026-11-04 16:00'), startedAt: null, durationSec: 0 },
    { salesRepId: 'r', createdAt: ksa('2026-11-04 16:30'), startedAt: null, durationSec: -60 },
  ] }), [{ day: '2026-11-04', start: ksa('2026-11-04 16:00'), end: ksa('2026-11-04 16:30') }]);
});

test('المدى: الطرف عند «من» تماماً يبقى ليومه — لحظةٌ واحدة عند منتصف الليل المحلي لا تُسقط', () => {
  const from = ksa('2026-11-04 00:00');
  const to = ksa('2026-11-05 00:00');
  assert.deepEqual(foregroundEnvelopes([{ start: from }], KSA, { from, to }), [{ day: '2026-11-04', start: from, end: from }]);
  assert.deepEqual(foregroundEnvelopes([{ start: to }], KSA, { from, to }), [], '«إلى» خارج المدى');
});

test('حارس نصّي: الخدمة صرفةٌ بلا قاعدة — شرط SQL يبنيه Prisma.sql وحده (وقصّ التقرير في tests/rep-ranking.test.ts)', () => {
  const svc = fs.readFileSync(path.join(__dirname, '..', 'services', 'foregroundEnvelope.ts'), 'utf8');
  assert.doesNotMatch(svc, /config\/database|\$queryRaw|findMany/, 'الخدمة صرفة بلا قاعدة');
});
