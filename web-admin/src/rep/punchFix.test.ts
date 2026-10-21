import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bestFix, fixGoodEnough, precisePunchFix, PUNCH_FIX_GOOD_M } from './punchFix';

// بلاغ المالك (٢١ أكتوبر ٢٠٢٦): «قيد بصمة الحضور بموقع العميل لا يعمل إلا بـ٣٠٠ متر». البصمة كانت تقرأ موقعاً مخبّأً
// عمره حتى ٣٠ ثانية بلا نظرٍ في دقّته، فالمندوب الواصل بسيارته يُرفض عند باب المحلّ.

const fix = (accuracy?: number, lat = 24.7) => ({ lat, lng: 46.6, at: '2026-10-21T08:00:00.000Z', ...(accuracy != null ? { accuracy } : {}) });
const pos = (accuracy: number, lat = 24.7) => ({ coords: { latitude: lat, longitude: 46.6, accuracy }, timestamp: Date.parse('2026-10-21T08:00:00Z') });

test('أدقّ قراءة: أصغر هامش خطأ، وبلا دقّةٍ معلومة لا تتقدّم على معلومتها', () => {
  assert.equal(bestFix([]), null);
  assert.equal(bestFix([fix(120), fix(35, 24.71), fix(60)])!.lat, 24.71);
  assert.equal(bestFix([fix(undefined, 24.72), fix(80, 24.73)])!.lat, 24.73);
  assert.equal(bestFix([fix(undefined, 24.74)])!.lat, 24.74, 'قراءةٌ وحيدة بلا دقّة خيرٌ من لا شيء');
});

test('الدقّة الكافية تُنهي المراقبة: عشرون متراً فما دون', () => {
  assert.equal(fixGoodEnough(fix(PUNCH_FIX_GOOD_M)), true);
  assert.equal(fixGoodEnough(fix(PUNCH_FIX_GOOD_M + 1)), false);
  assert.equal(fixGoodEnough(fix(undefined)), false);
  assert.equal(fixGoodEnough(null), false);
});

/** جهاز تحديد موقعٍ مزيّف: يسجّل خيارات المراقبة ويُطلق القراءات والأخطاء حين يُطلب */
function fakeGeo() {
  const g = {
    opts: null as PositionOptions | null, cleared: [] as number[],
    onPos: null as ((p: unknown) => void) | null, onErr: null as ((e: { code: number }) => void) | null,
    watchPosition(ok: (p: unknown) => void, err: (e: { code: number }) => void, opts: PositionOptions) { g.onPos = ok; g.onErr = err; g.opts = opts; return 7; },
    clearWatch(id: number) { g.cleared.push(id); },
  };
  return g;
}
const G = (g: ReturnType<typeof fakeGeo>) => g as unknown as Geolocation;

test('المراقبة بلا مخبّأ وبأعلى دقّة ومهلتها بعد الإذن، وتتوقّف فور قراءةٍ دقيقة بما يكفي وتغلق المراقبة', async () => {
  const g = fakeGeo();
  const p = precisePunchFix(G(g), { waitMs: 5000, refineMs: 5000, capMs: 5000 });
  // timeout المراقبة لا يحسب وقت نافذة الإذن — بخلاف مؤقّتٍ يبدأ قبلها فيُضيّع البصمة الأولى
  assert.deepEqual(g.opts, { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }, 'لا قراءة مخبّأة');
  g.onPos!(pos(400, 24.0));
  g.onPos!(pos(15, 24.5));
  const r = await p;
  assert.equal(r.reason, 'ok');
  assert.equal(r.fix!.lat, 24.5);
  assert.equal(r.fix!.accuracy, 15, 'هامش الخطأ يُرسل ليحكم به الخادم');
  assert.deepEqual(g.cleared, [7]);
});

test('بلا قراءةٍ دقيقة بما يكفي: مهلة التحسين من أوّل قراءة ثم أدقّ ما وصل', async () => {
  const g = fakeGeo();
  const p = precisePunchFix(G(g), { refineMs: 30, capMs: 5000 });
  g.onPos!(pos(300, 24.0));
  g.onPos!(pos(45, 24.6));
  g.onErr!({ code: 2 }); // خطأٌ عابر بعد قراءة لا يُسقطها
  g.onPos!(pos(90, 24.8));
  const r = await p;
  assert.equal(r.fix!.lat, 24.6);
  assert.equal(r.reason, 'ok');
  assert.deepEqual(g.cleared, [7]);
});

test('بلا أيّ قراءة: الرفض «denied» فوراً، والمهلة «timeout»، والموقع المتعذّر «unavailable»، ونافذةٌ لا يُجاب عنها حتى السقف', async () => {
  const deny = fakeGeo();
  const p1 = precisePunchFix(G(deny), { capMs: 5000 });
  deny.onErr!({ code: 1 });
  assert.deepEqual(await p1, { fix: null, reason: 'denied' });
  const slow = fakeGeo();
  const p2 = precisePunchFix(G(slow), { capMs: 5000 });
  slow.onErr!({ code: 3 });
  assert.deepEqual(await p2, { fix: null, reason: 'timeout' });
  const off = fakeGeo();
  const p3 = precisePunchFix(G(off), { capMs: 5000 });
  off.onErr!({ code: 2 });
  assert.deepEqual(await p3, { fix: null, reason: 'unavailable' });
  const prompt = fakeGeo();
  assert.deepEqual(await precisePunchFix(G(prompt), { capMs: 20 }), { fix: null, reason: 'timeout' });
  assert.deepEqual(prompt.cleared, [7], 'المراقبة تُغلق عند السقف');
  assert.deepEqual(await precisePunchFix(undefined), { fix: null, reason: 'no-geo' });
});

test('حارس الشاشة: المقيَّد بالبصمة عند عميل يقرأ بدقّة ويُقال له «تعذّر تحديد موقعك» لا «فعّل الموقع»، والشاشة تتمرّر والزرّ فوق قائمة الفترات', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'rep', 'RepApp.tsx'), 'utf8');
  assert.match(src, /\{screen === 'attendance' && <RepAttendance atCustomer=\{user\.requirePunchAtCustomer === true\} \/>\}/);
  const a = src.indexOf('function RepAttendance(');
  const screen = src.slice(a, src.indexOf('function RepWorkNumber()'));
  assert.match(screen, /if \(atCustomer\) \{[\s\S]*?const r = await precisePunchFix\(\);\s*loc = r\.fix;\s*noFix = !r\.fix && r\.reason !== 'denied';/);
  assert.match(screen, /else if \(noFix && resp\?\.data\?\.code === 'PUNCH_AWAY_FROM_CUSTOMER'\) setErr\(tr\(VISIT_NOFIX_MSG\)\);/);
  // الحاوية تقصّ ما يفيض: بلا تمريرٍ هنا تختفي الأزرار بعد الفترة السادسة («فترات العمل ستّ فقط»)
  assert.match(screen, /<div className="h-full overflow-y-auto p-4 pb-8 space-y-4">/);
  const list = screen.indexOf('shifts.map((sh, i) =>');
  assert.ok(screen.indexOf("onClick={() => punch('checkin')}") < list, 'زرّ الحضور فوق القائمة');
  assert.ok(screen.indexOf("onClick={() => punch('checkout')}") < list, 'زرّ الانصراف فوق القائمة');
});
