import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  bestFix, fixGoodEnough, fixIsCoarse, pinAccuracyLevel, precisePinFix, precisePunchFix, startPunchWarmup,
  PIN_WARN_M, PUNCH_FIX_COARSE_M, PUNCH_FIX_GOOD_M, PUNCH_FIX_SETTLE_M, PUNCH_FIX_STALE_MS,
} from './punchFix';

// بلاغ المالك (٢١ أكتوبر ٢٠٢٦): «قيد بصمة الحضور بموقع العميل لا يعمل إلا بـ٣٠٠ متر». البصمة كانت تقرأ موقعاً مخبّأً
// عمره حتى ٣٠ ثانية بلا نظرٍ في دقّته، فالمندوب الواصل بسيارته يُرفض عند باب المحلّ.
// وتدقيق ٧ نوفمبر ٢٠٢٦ (R1 وR3 وR5 وR2/PIN-6): قراءةٌ مخبّأة لا تُنهي المراقبة، والتحسين يمتدّ داخل المحلّ، والخشنة تُصنَّف.

/** ساعة الاختبار — لحظة بدء المراقبة؛ القراءات الطازجة بلحظتها والمخبّأة قبلها */
const NOW = Date.parse('2026-11-07T08:00:00Z');
const now = () => NOW;

const fix = (accuracy?: number, lat = 24.7) => ({ lat, lng: 46.6, at: '2026-10-21T08:00:00.000Z', ...(accuracy != null ? { accuracy } : {}) });
const pos = (accuracy: number | null, lat = 24.7, timestamp = NOW) => ({ coords: { latitude: lat, longitude: 46.6, accuracy }, timestamp });
/** قراءةٌ مخبّأة: آخر موقعٍ معروف من السيارة قبل ٤٠ ث */
const old = (accuracy: number, lat = 24.7) => pos(accuracy, lat, NOW - 40_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** يرصد انتهاء الوعد دون انتظاره */
function track<T>(p: Promise<T>) {
  const s = { done: false, value: undefined as T | undefined };
  void p.then((v) => { s.done = true; s.value = v; });
  return s;
}

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

test('مستوى الدقّة: good ≤ ٢٠ · fair ≤ ٣٠ · poor فوقها · coarse من ١٠٠٠ م (R5) — وغير المعلومة لا تُعرض دقيقة', () => {
  assert.equal(PIN_WARN_M, 30);
  assert.equal(pinAccuracyLevel(0), 'good');
  assert.equal(pinAccuracyLevel(20), 'good');
  assert.equal(pinAccuracyLevel(20.4), 'fair');
  assert.equal(pinAccuracyLevel(30), 'fair');
  assert.equal(pinAccuracyLevel(31), 'poor');
  assert.equal(pinAccuracyLevel(PUNCH_FIX_COARSE_M - 1), 'poor');
  assert.equal(pinAccuracyLevel(PUNCH_FIX_COARSE_M), 'coarse');
  assert.equal(pinAccuracyLevel(2000), 'coarse', 'إذن «الموقع التقريبي»: «فعّل الموقع الدقيق» لا «انتظر»');
  assert.equal(pinAccuracyLevel(null), 'poor');
  assert.equal(pinAccuracyLevel(Number.NaN), 'poor');
  assert.equal(pinAccuracyLevel(-5), 'poor');
  assert.equal(fixIsCoarse({ accuracy: 1500 }), true);
  assert.equal(fixIsCoarse({ accuracy: 45 }), false);
  assert.equal(fixIsCoarse({ accuracy: null }), false);
  assert.equal(fixIsCoarse(fix(undefined)), false);
  assert.equal(fixIsCoarse(null), false);
});

/** جهاز تحديد موقعٍ مزيّف: يسجّل خيارات المراقبة ويُطلق القراءات والأخطاء حين يُطلب — وsync قراءةٌ تصل قبل أن يعود المعرّف */
function fakeGeo(sync?: unknown) {
  const g = {
    opts: null as PositionOptions | null, cleared: [] as number[], watches: 0,
    onPos: null as ((p: unknown) => void) | null, onErr: null as ((e: { code: number }) => void) | null,
    watchPosition(ok: (p: unknown) => void, err: (e: { code: number }) => void, opts: PositionOptions) {
      g.onPos = ok; g.onErr = err; g.opts = opts; g.watches++;
      if (sync) ok(sync);
      return 7;
    },
    clearWatch(id: number) { g.cleared.push(id); },
  };
  return g;
}
const G = (g: ReturnType<typeof fakeGeo>) => g as unknown as Geolocation;

test('المراقبة بلا مخبّأ وبأعلى دقّة ومهلتها بعد الإذن، وتتوقّف فور قراءةٍ دقيقة بما يكفي وتغلق المراقبة', async () => {
  const g = fakeGeo();
  const p = precisePunchFix(G(g), { waitMs: 5000, refineMs: 5000, capMs: 5000, now });
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

test('قراءةٌ دقيقة وصلت متزامنةً قبل معرّف المراقبة: تنتهي وتُغلق المراقبة', async () => {
  const g = fakeGeo(pos(8, 24.55));
  const r = await precisePunchFix(G(g), { capMs: 5000, now });
  assert.equal(r.fix!.lat, 24.55);
  assert.deepEqual(g.cleared, [7]);
});

test('بلا قراءةٍ دقيقة بما يكفي: مهلة التحسين من أوّل قراءة ثم أدقّ ما وصل', async () => {
  const g = fakeGeo();
  const p = precisePunchFix(G(g), { refineMs: 30, extendMs: 60, capMs: 5000, now });
  g.onPos!(pos(300, 24.0));
  g.onPos!(pos(45, 24.6));
  g.onErr!({ code: 2 }); // خطأٌ عابر بعد قراءة لا يُسقطها
  g.onPos!(pos(90, 24.8));
  const r = await p;
  assert.equal(r.fix!.lat, 24.6);
  assert.equal(r.reason, 'ok');
  assert.deepEqual(g.cleared, [7]);
});

test('R1: بعد مهلة التحسين والدقّة أضعف من ٢٥ م تستمرّ المراقبة، وتنتهي فور بلوغها ٢٥ م', async () => {
  const g = fakeGeo();
  const s = track(precisePunchFix(G(g), { refineMs: 20, extendMs: 5000, capMs: 10_000, now }));
  g.onPos!(pos(45, 24.6));
  await sleep(80);
  assert.equal(s.done, false, 'داخل المحلّ: ±٤٥ م بعد ٨ ث لا تكفي — نواصل حتى ~٢٠ ث');
  g.onPos!(pos(PUNCH_FIX_SETTLE_M + 5, 24.61));
  await sleep(10);
  assert.equal(s.done, false, '٣٠ م ما زالت أضعف من السماحية');
  g.onPos!(pos(PUNCH_FIX_SETTLE_M, 24.62));
  await sleep(10);
  assert.equal(s.done, true, 'بلغت ٢٥ م في التمديد: تنتهي فوراً');
  assert.equal(s.value!.fix!.lat, 24.62);
  assert.deepEqual(g.cleared, [7]);
});

test('R1: أدقّ الطازجة ضمن ٢٥ م عند نهاية مهلة التحسين: لا تمديد', async () => {
  const g = fakeGeo();
  const s = track(precisePunchFix(G(g), { refineMs: 20, extendMs: 5000, capMs: 10_000, now }));
  g.onPos!(pos(60, 24.6));
  g.onPos!(pos(22, 24.63));
  await sleep(150);
  assert.equal(s.done, true);
  assert.equal(s.value!.fix!.accuracy, 22);
});

test('R1: التمديد ينتهي بمدّته من أوّل قراءة بأدقّ ما وصل، والسقف العام يحدّه', async () => {
  const g1 = fakeGeo();
  const s1 = track(precisePunchFix(G(g1), { refineMs: 20, extendMs: 120, capMs: 10_000, now }));
  g1.onPos!(pos(45, 24.6));
  await sleep(60);
  assert.equal(s1.done, false);
  await sleep(250);
  assert.equal(s1.done, true);
  assert.deepEqual(s1.value, { fix: { lat: 24.6, lng: 46.6, accuracy: 45, at: new Date(NOW).toISOString() }, reason: 'ok' });

  const g2 = fakeGeo();
  const s2 = track(precisePunchFix(G(g2), { refineMs: 20, extendMs: 60_000, capMs: 120, now }));
  g2.onPos!(pos(70, 24.7));
  await sleep(400);
  assert.equal(s2.done, true, 'السقف يُنهي التمديد');
  assert.equal(s2.value!.reason, 'ok', 'بقراءةٍ وصلت: ok لا timeout');
  assert.equal(s2.value!.fix!.accuracy, 70);
  assert.deepEqual(g2.cleared, [7]);
});

test('R3: قراءةٌ مخبّأة دقيقة (آخر موقعٍ من السيارة) لا تُنهي المراقبة، والطازجة تُقدَّم عليها ولو أضعف', async () => {
  const g = fakeGeo();
  const s = track(precisePunchFix(G(g), { refineMs: 20, extendMs: 60, capMs: 10_000, now }));
  g.onPos!(old(5, 24.0));
  await sleep(5);
  assert.equal(s.done, false, '±٥ م عمرها ٤٠ ث: لا تُنهي');
  g.onPos!(pos(40, 24.6));
  await sleep(300);
  assert.equal(s.done, true);
  assert.equal(s.value!.fix!.lat, 24.6, 'الطازجة ±٤٠ م لا المخبّأة ±٥ م من الشارع');
});

test('R3: الطازجة الدقيقة بعد المخبّأة تُنهي فوراً — وحدّ الطزاجة ٥ ث قبل البدء', async () => {
  const g = fakeGeo();
  const p = precisePunchFix(G(g), { refineMs: 5000, capMs: 10_000, now });
  g.onPos!(old(3, 24.0));
  g.onPos!(pos(12, 24.5, NOW - PUNCH_FIX_STALE_MS)); // على الحدّ تماماً: طازجة
  const r = await p;
  assert.equal(r.fix!.lat, 24.5);
  const g2 = fakeGeo();
  const s2 = track(precisePunchFix(G(g2), { refineMs: 5000, capMs: 10_000, now }));
  g2.onPos!(pos(12, 24.5, NOW - PUNCH_FIX_STALE_MS - 1));
  await sleep(10);
  assert.equal(s2.done, false, 'أقدم من الحدّ بلحظة: مخبّأة');
  g2.onPos!(pos(10, 24.52));
  await sleep(10);
  assert.equal(s2.done, true);
  assert.equal(s2.value!.fix!.lat, 24.52);
});

test('R3: بلا قراءةٍ طازجة أبداً تُرسل أدقّ المخبّأة احتياطاً، وبلا لحظة قراءة = طازجة', async () => {
  const g = fakeGeo();
  const p = precisePunchFix(G(g), { refineMs: 20, extendMs: 40, capMs: 10_000, now });
  g.onPos!(old(30, 24.1));
  g.onPos!(old(9, 24.2));
  const r = await p;
  assert.equal(r.reason, 'ok');
  assert.equal(r.fix!.lat, 24.2);
  const g2 = fakeGeo();
  const p2 = precisePunchFix(G(g2), { refineMs: 5000, capMs: 10_000, now });
  g2.onPos!({ coords: { latitude: 24.3, longitude: 46.6, accuracy: 10 } });
  assert.equal((await p2).fix!.lat, 24.3);
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

test('دبوس العميل (R2/PIN-6): المراقبة نفسها بلا مخبّأ، والدقّة تعود معه وnull إن لم تُعرف', async () => {
  const g = fakeGeo();
  const p = precisePinFix({ geolocation: G(g), capMs: 5000, now });
  assert.deepEqual(g.opts, { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 });
  g.onPos!(pos(80, 24.0));
  g.onPos!(pos(14.6, 24.5));
  assert.deepEqual(await p, { fix: { lat: 24.5, lng: 46.6, accuracy: 15 }, reason: 'ok' });

  const g2 = fakeGeo();
  const p2 = precisePinFix({ geolocation: G(g2), refineMs: 20, extendMs: 40, capMs: 5000, now });
  g2.onPos!(pos(null, 24.4));
  assert.deepEqual(await p2, { fix: { lat: 24.4, lng: 46.6, accuracy: null }, reason: 'ok' });

  const g3 = fakeGeo();
  const s3 = track(precisePinFix({ geolocation: G(g3), goodM: 10, refineMs: 5000, capMs: 5000, now }));
  g3.onPos!(pos(15, 24.5));
  await sleep(10);
  assert.equal(s3.done, false, 'goodM أضيق: ١٥ م لا تُنهي');
  g3.onPos!(pos(9, 24.51));
  await sleep(10);
  assert.equal(s3.value!.fix!.accuracy, 9);

  const deny = fakeGeo();
  const p4 = precisePinFix({ geolocation: G(deny), capMs: 5000 });
  deny.onErr!({ code: 1 });
  assert.deepEqual(await p4, { fix: null, reason: 'denied' });
  assert.deepEqual(await precisePinFix({ geolocation: undefined }), { fix: null, reason: 'no-geo' });
  assert.deepEqual(await precisePinFix(), { fix: null, reason: 'no-geo' }, 'بلا navigator.geolocation في Node');
});

/** Permissions API مزيّف: حالة إذن الموقع كما يعيدها المتصفّح */
const perms = (state: string) => ({ asked: 0, query(this: { asked: number }) { this.asked++; return Promise.resolve({ state }); } });

test('تسخين الـGPS (R1): مراقبةٌ دقيقة بلا مخبّأ ودالّة إيقافٍ تُغلقها مرّة واحدة', async () => {
  const g = fakeGeo();
  const stop = startPunchWarmup(G(g), { permissions: perms('granted') });
  await sleep(0);
  assert.equal(g.watches, 1);
  assert.deepEqual(g.opts, { enableHighAccuracy: true, maximumAge: 0 });
  g.onPos!(pos(500)); // القراءات تُهمَل
  assert.deepEqual(g.cleared, []);
  stop();
  stop();
  assert.deepEqual(g.cleared, [7], 'الإيقاف مرّتين لا يضرّ');
  startPunchWarmup(undefined)(); // بلا تحديد موقع: لا شيء
});

test('تسخين الـGPS: يتوقّف وحده برفض الإذن وبعد السقف', async () => {
  const deny = fakeGeo();
  const stop = startPunchWarmup(G(deny), { maxMs: 5000, permissions: perms('granted') });
  await sleep(0);
  deny.onErr!({ code: 3 });
  assert.deepEqual(deny.cleared, [], 'مهلةٌ عابرة لا توقفه');
  deny.onErr!({ code: 1 });
  assert.deepEqual(deny.cleared, [7]);
  stop();
  assert.deepEqual(deny.cleared, [7]);
  const forgot = fakeGeo();
  startPunchWarmup(G(forgot), { maxMs: 20, permissions: perms('granted') });
  await sleep(80);
  assert.deepEqual(forgot.cleared, [7], 'السقف يُغلق مراقبةً نُسيت مفتوحة');
});

test('تسخين الـGPS لا يسأل الإذن أبداً: إذنٌ غير ممنوح سلفاً أو متصفّحٌ بلا Permissions API ⇒ بلا مراقبة', async () => {
  for (const state of ['prompt', 'denied']) {
    const g = fakeGeo();
    const p = perms(state);
    startPunchWarmup(G(g), { permissions: p });
    await sleep(0);
    assert.equal(p.asked, 1);
    assert.equal(g.watches, 0, `${state}: لا نافذة إذنٍ قبل ضغطة المندوب`);
  }
  // بلا Permissions API (وفي Node بلا navigator.permissions)
  const none = fakeGeo();
  startPunchWarmup(G(none), { permissions: undefined });
  startPunchWarmup(G(none));
  await sleep(0);
  assert.equal(none.watches, 0);
  // سؤالٌ يرمي أو يُرفض
  const bad = fakeGeo();
  startPunchWarmup(G(bad), { permissions: { query: () => { throw new Error('x'); } } });
  startPunchWarmup(G(bad), { permissions: { query: () => Promise.reject(new Error('x')) } });
  await sleep(0);
  assert.equal(bad.watches, 0);
  // أُوقف قبل أن يُعرف الإذن (غادر الشاشة فوراً): لا مراقبة تُفتح بعده
  const early = fakeGeo();
  startPunchWarmup(G(early), { permissions: perms('granted') })();
  await sleep(0);
  assert.equal(early.watches, 0);
});

test('R3 وساعة الجوال: قراءةٌ أحدث من سابقتها في المراقبة نفسها طازجة — جوالٌ ساعته متقدّمة ١٠ ث لا ينتظر نافذة التحسين كلّها', async () => {
  // لحظات القراءة من ساعة GPS متأخّرةٌ ١٠ ث عن ساعة الجوال: كل قراءة تبدو «أقدم من البدء بأكثر من ٥ ث»
  const SKEW = 10_000;
  const g = fakeGeo();
  const s = track(precisePunchFix(G(g), { refineMs: 5000, extendMs: 20_000, capMs: 60_000, now }));
  g.onPos!(pos(5, 24.5, NOW - SKEW));
  await sleep(5);
  assert.equal(s.done, false, 'الأولى وحدها تُقارن بساعة الجوال');
  g.onPos!(pos(5, 24.51, NOW - SKEW + 1000));
  await sleep(5);
  assert.equal(s.done, true, 'الثانية أحدث من الأولى: طازجة فتُنهي فوراً');
  assert.equal(s.value!.fix!.lat, 24.51);
  // قراءةٌ لا تتقدّم (اللحظة نفسها مكرّرة) تبقى مخبّأة: آخر موقعٍ من السيارة مرّتين لا يُنهي
  const g2 = fakeGeo();
  const s2 = track(precisePunchFix(G(g2), { refineMs: 5000, capMs: 60_000, now }));
  g2.onPos!(old(4, 24.0));
  g2.onPos!(old(3, 24.01));
  await sleep(5);
  assert.equal(s2.done, false);
  g2.onPos!(pos(15, 24.6));
  await sleep(5);
  assert.equal(s2.done, true);
  assert.equal(s2.value!.fix!.lat, 24.6, 'الطازجة تُقدَّم على المخبّأة الأدقّ');
});

test('حارس الشاشة: المقيَّد بالبصمة عند عميل يقرأ بدقّة ويُقال له «تعذّر تحديد موقعك» لا «فعّل الموقع»، والشاشة تتمرّر والزرّ فوق قائمة الفترات', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'rep', 'RepApp.tsx'), 'utf8');
  assert.match(src, /\{screen === 'attendance' && <RepAttendance atCustomer=\{user\.requirePunchAtCustomer === true\} boundDevice=\{user\.requireBoundDevice === true\} presenceOn=\{user\.requirePresenceCheck === true\} \/>\}/);
  const a = src.indexOf('function RepAttendance(');
  const screen = src.slice(a, src.indexOf('function RepWorkNumber()'));
  assert.match(screen, /if \(atCustomer\) \{[\s\S]*?const r = await precisePunchFix\(\);\s*loc = r\.fix;\s*noFix = !r\.fix && r\.reason !== 'denied';/);
  assert.match(screen, /else if \(noFix && resp\?\.data\?\.code === 'PUNCH_AWAY_FROM_CUSTOMER' && resp\.data\.reason !== 'DEVICE'\) setErr\(tr\(VISIT_NOFIX_MSG\)\);/);
  // الحاوية تقصّ ما يفيض: بلا تمريرٍ هنا تختفي الأزرار بعد الفترة السادسة («فترات العمل ستّ فقط»)
  assert.match(screen, /<div className="h-full overflow-y-auto p-4 pb-8 space-y-4">/);
  const list = screen.indexOf('shifts.map((sh, i) =>');
  assert.ok(screen.indexOf("onClick={() => punch('checkin')}") < list, 'زرّ الحضور فوق القائمة');
  assert.ok(screen.indexOf("onClick={() => punch('checkout')}") < list, 'زرّ الانصراف فوق القائمة');
});
