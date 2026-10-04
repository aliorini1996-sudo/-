import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasPunchLocation, mapsUrl, punchDetailRows, punchInUrl, punchOutUrl, type WorkDayLike } from './workPeriods';
import { linkAreas } from './pdfLinks';
import { PHRASES } from '../i18n/strings';

// طلب المالك: «نعم اجعله يظهر بالتقرير» — أين حضر المندوب وأين انصرف، بلا تكرارٍ مزعج:
// الجدول صفٌّ واحد لليوم ووقتُ كل بصمةٍ رابطٌ لمكانها، وورقة «تفاصيل البصمات» صفٌّ لكل فترة بخلايا موحّدة.
// الدوام المتقطّع بالرياض: ٩ص–١ظ ثم ٥م–٩م = 06–10Z ثم 14–18Z.
const tr = (s: string) => s;
const clock = (iso: string) => iso.slice(11, 16);
const fx = { tr, clock, minutes: (m: number) => `${Math.floor(m / 60)}س${m % 60}د` };
const A = { lat: 24.7136, lng: 46.6753 };
const B = { lat: 24.6877, lng: 46.7219 };
const C = { lat: 24.7743, lng: 46.7386 };
const url = (p: { lat: number; lng: number }) => `https://www.google.com/maps?q=${p.lat},${p.lng}`;

const base = { appMinutes: 0, visitsCount: 0, visitsSec: 0, absent: false };
const splitDay: WorkDayLike & { date: string } = {
  ...base, date: '2026-10-04', firstActivity: '2026-10-04T06:00:00.000Z', lastActivity: '2026-10-04T10:00:00.000Z',
  spanMinutes: 240, breakMinutes: 240,
  periods: [
    { start: '2026-10-04T06:00:00.000Z', end: '2026-10-04T10:00:00.000Z', source: 'PUNCH', inLat: A.lat, inLng: A.lng, outLat: B.lat, outLng: B.lng },
    { start: '2026-10-04T14:00:00.000Z', end: null, source: 'PUNCH', inLat: C.lat, inLng: C.lng, outLat: null, outLng: null },
  ],
};
const activityDay: WorkDayLike & { date: string } = {
  ...base, date: '2026-10-05', firstActivity: '2026-10-05T06:00:00.000Z', lastActivity: '2026-10-05T15:00:00.000Z',
  spanMinutes: 540, breakMinutes: 0,
  periods: [{ start: '2026-10-05T06:00:00.000Z', end: '2026-10-05T15:00:00.000Z', source: 'ACTIVITY' }],
};
const absentDay: WorkDayLike & { date: string } = {
  ...base, absent: true, date: '2026-10-06', firstActivity: '2026-10-06T00:00:00.000Z', lastActivity: '2026-10-06T00:00:00.000Z',
  spanMinutes: 0, breakMinutes: 0, periods: [],
};
const noGpsDay: WorkDayLike & { date: string } = {
  ...base, date: '2026-10-04', firstActivity: '2026-10-04T05:00:00.000Z', lastActivity: '2026-10-04T13:30:00.000Z',
  spanMinutes: 510, breakMinutes: 0,
  periods: [{ start: '2026-10-04T05:00:00.000Z', end: '2026-10-04T13:30:00.000Z', source: 'PUNCH', inLat: null, inLng: null, outLat: null, outLng: null }],
};

test('رابط الخريطة: إحداثيان صالحان ⇒ رابط Google، وغيابُ أحدهما أو فسادُه ⇒ لا رابط', () => {
  assert.equal(mapsUrl(A.lat, A.lng), 'https://www.google.com/maps?q=24.7136,46.6753');
  assert.equal(mapsUrl(-33.86, 151.2), 'https://www.google.com/maps?q=-33.86,151.2');
  for (const [lat, lng] of [[null, 46.6], [24.7, null], [undefined, undefined], [Number.NaN, 46.6], [24.7, Infinity], [91, 46.6], [24.7, 181]] as const) {
    assert.equal(mapsUrl(lat as number | null | undefined, lng as number | null | undefined), null, `${lat},${lng}`);
  }
});

test('رابط كل بصمة: الحضور من موقعه، والانصراف من موقعه — والمفتوحة بلا رابط انصراف ولو حملت إحداثيات', () => {
  const [closed, open] = splitDay.periods!;
  assert.equal(punchInUrl(closed), url(A));
  assert.equal(punchOutUrl(closed), url(B));
  assert.equal(punchInUrl(open), url(C));
  assert.equal(punchOutUrl({ ...open, outLat: 1, outLng: 2 }), null);
  // خادمٌ أقدم بلا حقول المواقع، وامتدادٌ بلا بصمة ⇒ أوقاتٌ عادية بلا روابط
  assert.equal(punchInUrl({ start: closed.start, end: closed.end }), null);
  assert.equal(punchInUrl(activityDay.periods![0]), null);
  assert.equal(hasPunchLocation(splitDay), true);
  assert.equal(hasPunchLocation(activityDay), false);
  assert.equal(hasPunchLocation(noGpsDay), false);
  assert.equal(hasPunchLocation(absentDay), false);
});

test('ورقة «تفاصيل البصمات» لكل المناديب: صفٌّ لكل فترة، المندوب مرّةً والتاريخ مرّةً لكل يوم، وأيام البصمة وحدها', () => {
  const { rows, merges } = punchDetailRows([
    { name: 'أحمد', days: [splitDay, activityDay, absentDay] },
    { name: 'سالم', days: [noGpsDay] },
  ], true, fx);
  assert.equal(rows.length, 3, 'فترتا أحمد وفترة سالم — لا يوم الأثر ولا يوم الغياب');
  assert.deepEqual(Object.keys(rows[0]), ['المندوب', 'التاريخ', 'الحضور', 'موقع الحضور', 'الانصراف', 'موقع الانصراف', 'المدة']);
  assert.deepEqual(rows[0], {
    'المندوب': 'أحمد', 'التاريخ': '2026-10-04',
    'الحضور': '06:00', 'موقع الحضور': url(A), 'الانصراف': '10:00', 'موقع الانصراف': url(B), 'المدة': '4س0د',
  });
  // الصفّ الثاني: المندوب والتاريخ مُفرغان تحت الخلية الموحّدة، والنوبة المفتوحة بلا انصراف ولا موقعه ولا مدّة
  assert.deepEqual(rows[1], {
    'المندوب': '', 'التاريخ': '',
    'الحضور': '14:00', 'موقع الحضور': url(C), 'الانصراف': 'لم ينصرف', 'موقع الانصراف': '—', 'المدة': '—',
  });
  // بصمةٌ بلا موقع (الموقع مغلق) تُذكر صراحةً لا تُترك فارغة
  assert.equal(rows[2]['المندوب'], 'سالم');
  assert.equal(rows[2]['موقع الحضور'], 'بلا موقع');
  assert.equal(rows[2]['موقع الانصراف'], 'بلا موقع');
  assert.equal(rows[2]['المدة'], '8س30د');
  assert.deepEqual(merges, [
    { col: 'المندوب', from: 0, to: 1, value: 'أحمد' },
    { col: 'التاريخ', from: 0, to: 1, value: '2026-10-04' },
  ], 'يومٌ واحد لمندوبَين مختلفَين لا يتّحد تاريخه عبرهما');
  // روابط الخريطة نصٌّ عارٍ ⇒ excel.ts يجعلها قابلةً للنقر
  for (const r of rows) for (const c of ['موقع الحضور', 'موقع الانصراف']) {
    const v = String(r[c]);
    if (v.startsWith('http')) assert.match(v, /^https?:\/\/\S+$/);
  }
});

test('ورقة «تفاصيل البصمات» للمندوب الواحد: بلا عمود المندوب، والتاريخ موحّد لكل يوم، ومجموع المدد = إجمالي اليوم', () => {
  const closed: WorkDayLike & { date: string } = { ...splitDay, spanMinutes: 480,
    periods: [splitDay.periods![0], { ...splitDay.periods![1], end: '2026-10-04T18:00:00.000Z', outLat: A.lat, outLng: A.lng }] };
  const next: WorkDayLike & { date: string } = { ...noGpsDay, date: '2026-10-07' };
  const { rows, merges } = punchDetailRows([{ name: 'أحمد', days: [closed, next] }], false, fx);
  assert.deepEqual(Object.keys(rows[0]), ['التاريخ', 'الحضور', 'موقع الحضور', 'الانصراف', 'موقع الانصراف', 'المدة']);
  assert.deepEqual(rows.map(r => r['التاريخ']), ['2026-10-04', '', '2026-10-07']);
  assert.deepEqual(merges, [{ col: 'التاريخ', from: 0, to: 1, value: '2026-10-04' }]);
  assert.deepEqual(rows.map(r => r['المدة']), ['4س0د', '4س0د', '8س30د'], 'ثماني ساعات اليوم الأول = ٤ + ٤ بلا الاستراحة');
  assert.equal(punchDetailRows([{ name: 'أحمد', days: [activityDay, absentDay] }], false, fx).rows.length, 0, 'بلا بصمة ⇒ لا ورقة');
});

test('روابط PDF فوق الصورة الملتقطة: موضع الرابط بالبكسل ⇒ صفحته وموضعه بالنقاط', () => {
  // عنصرٌ بعرض 780px على صفحة A4 (595.28 × 841.89 نقطة)
  const k = 595.28 / 780;
  const [first, second] = linkAreas([
    { url: url(A), x: 100, y: 200, w: 60, h: 14 },
    { url: url(B), x: 300, y: 1200, w: 60, h: 14 },       // 1200px × k ≈ 916pt ⇒ الصفحة الثانية
    { url: 'javascript:alert(1)', x: 0, y: 0, w: 10, h: 10 },
    { url: url(C), x: 0, y: 0, w: 0, h: 14 },
  ], 780, 595.28, 841.89).map(l => ({ ...l, x: +l.x.toFixed(2), y: +l.y.toFixed(2), w: +l.w.toFixed(2), h: +l.h.toFixed(2) }));
  assert.deepEqual(first, { url: url(A), page: 0, x: +(100 * k).toFixed(2), y: +(200 * k).toFixed(2), w: +(60 * k).toFixed(2), h: +(14 * k).toFixed(2) });
  assert.equal(second.page, 1);
  assert.equal(second.y, +(1200 * k - 841.89).toFixed(2));
  assert.equal(linkAreas([{ url: url(A), x: 1, y: 1, w: 1, h: 1 }], 0, 595.28, 841.89).length, 0);
  assert.equal(linkAreas([
    { url: url(A), x: 1, y: 1, w: 1, h: 1 }, { url: 'javascript:alert(1)', x: 0, y: 0, w: 10, h: 10 },
  ], 780, 595.28, 841.89).length, 1, 'روابط http(s) وحدها');
});

test('النصوص الجديدة مترجمة للغات الأربع، واسم الورقة يسع حدّ Excel (٣١ حرفاً)', () => {
  for (const key of ['موقع الحضور', 'موقع الانصراف', 'فتح الخريطة', 'تفاصيل البصمات', 'الحضور', 'الانصراف', 'المدة', 'بلا موقع', 'لم ينصرف']) {
    const row = PHRASES[key];
    assert.ok(row, `لا ترجمة للنص: ${key}`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(row[lang]?.trim(), `${lang} فارغة: ${key}`);
  }
  for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(PHRASES['تفاصيل البصمات'][lang].length <= 31, `اسم الورقة بـ${lang} يُقصّ في Excel`);
});

test('حارس: أسماء أوراق التقارير صالحةٌ في Excel بكل لغة — حرفٌ من : \\ / ? * [ ] يُسقط التصدير كله', () => {
  // SheetJS يرمي «Sheet name cannot contain…» فلا يخرج الملف — كاد «Check-in/out details» يُسقط تصدير ساعات العمل بالإنجليزية
  const src = ['pages/ReportsPage.tsx', 'm/MReports.tsx']
    .map(f => fs.readFileSync(path.join(process.cwd(), 'src', f), 'utf8')).join('\n');
  const names = [...new Set([...src.matchAll(/name: tr\('([^']+)'\)/g)].map(m => m[1]))];
  assert.ok(names.includes('تفاصيل البصمات'));
  for (const ar of names) {
    const all: Array<[string, string]> = [['ar', ar], ...(['en', 'fr', 'tr', 'zh'] as const).map(l => [l, PHRASES[ar]?.[l] ?? ar] as [string, string])];
    for (const [lang, v] of all) {
      assert.doesNotMatch(v, /[:\\/?*[\]]/, `اسم الورقة «${ar}» بـ${lang} = «${v}» يرفضه Excel`);
    }
  }
});

test('حارس: الجدول صفٌّ لليوم بأوقاتٍ روابط، والتصديران (الكل والمندوب) يحملان «تفاصيل البصمات» بروابط مختصرة في PDF', () => {
  const page = fs.readFileSync(path.join(process.cwd(), 'src', 'pages', 'ReportsPage.tsx'), 'utf8');
  // الأوقات في خلية الفترات روابط لمواقعها — داخل صفّ اليوم نفسه، والنقر لا يطوي الصفّ
  assert.match(page, /punchTime\(p\.start, punchInUrl\(p\),/);
  assert.match(page, /punchTime\(p\.end, punchOutUrl\(p\),/);
  assert.match(page, /target="_blank" rel="noopener noreferrer" onClick=\{e => e\.stopPropagation\(\)\}/);
  // الورقتان من مصدرٍ واحد: كل المناديب بعمود المندوب، والمندوب الواحد بلا عموده
  assert.match(page, /punchDetailRows\(hoursRows, true, dayCellFx\)/);
  assert.match(page, /punchDetailRows\(\[r\], false, dayCellFx\)/);
  assert.equal(page.match(/name: tr\('تفاصيل البصمات'\)[^\n]*\n?[^\n]*pdfLinkLabel: tr\('فتح الخريطة'\)/g)?.length, 2, 'ورقةٌ بلا نصٍّ مختصر تملأ PDF بروابط طويلة');
  // ملف المندوب الواحد (Excel وPDF) يمرّ بالورقة الجديدة
  assert.match(page, /shareOrDownloadExcel\(repHoursSheetsAll\(r\)/);
  assert.match(page, /sheetsToPdf\(repHoursSheetsAll\(r\)/);
  // PDF يعرض الرابط نصّاً قصيراً قابلاً للنقر
  assert.match(page, /sh\.pdfLinkLabel && typeof v === 'string'/);
  const pdf = fs.readFileSync(path.join(process.cwd(), 'src', 'rep', 'pdf.ts'), 'utf8');
  assert.match(pdf, /pdf\.link\(l\.x, l\.y, l\.w, l\.h, \{ url: l\.url \}\)/, 'روابط PDF لا تُعاد فوق الصورة');
  // الجوال: الصفّ زرٌّ كامل لا يحمل روابط، فالمواقع في تفاصيل اليوم سطرٌ لكل فترة
  const m = fs.readFileSync(path.join(process.cwd(), 'src', 'm', 'MReports.tsx'), 'utf8');
  assert.match(m, /<PunchLine key=/);
  assert.match(m, /punchInUrl\(p\)/);
  assert.match(m, /punchOutUrl\(p\)/);
  assert.match(m, /const expandable = d\.visitsCount > 0 \|\| located/);
});
