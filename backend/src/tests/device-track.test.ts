// تتبّع الخلفية من التطبيق الأصلي (طلب المالك، ٤ نوفمبر ٢٠٢٦) — services/deviceTrack.ts صرفاً بلا قاعدة ولا Express:
//   • رمز التتبّع يُصدَر ويُتحقَّق منه ذهاباً وإياباً، بمفتاحٍ مشتقٍّ مختلف: توكن الجلسة لا يقبله verifyTrackToken، ورمز التتبّع
//     لا يقبله jwt.verify بمفتاح الجلسات (فلا يمرّ من authenticate في أي مسار) — والنوع الخاطئ والمنتهي يُرفضان.
//   • «التتبّع الأصلي يعمل الآن» نافذة ٩٠ث لكل مندوب، و«رُئي مؤخّراً» ٥ دقائق لسؤال التحقّق، و«أُغلقت للتوّ» بعد رفع الإغلاق،
//     وحكم نقطة الجهاز (gone/off/on) كحكم /tracking/ping والدخول.
//   • حراسٌ ثابتة: index.ts يركّب /api/track-device بلا authenticate (وقبل محدِّد المعدّل العام)، وtracking.ts يعرض /device-token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'device-track-test-secret';
const SECRET = process.env.JWT_SECRET;
const SRC = path.join(__dirname, '..');

/* eslint-disable @typescript-eslint/no-var-requires */
const dt = require('../services/deviceTrack') as typeof import('../services/deviceTrack');
/* eslint-enable @typescript-eslint/no-var-requires */

test('رمز التتبّع ذهاباً وإياباً: المندوب والشركة، والنوع fs-track، والانتهاء بعد ٢٠ ساعة', () => {
  const before = Date.now();
  const { token, expiresAt } = dt.issueTrackToken('rep1', 't1');
  assert.deepEqual(dt.verifyTrackToken(token), { repId: 'rep1', tenantId: 't1' });
  const p = jwt.decode(token) as { sub: string; tid: string; typ: string; exp: number; iat: number };
  assert.equal(p.sub, 'rep1');
  assert.equal(p.tid, 't1');
  assert.equal(p.typ, 'fs-track');
  assert.equal(p.exp - p.iat, 20 * 3600);
  assert.equal(new Date(expiresAt).getTime(), p.exp * 1000);
  const life = new Date(expiresAt).getTime() - before;
  assert.ok(life > 20 * 3600_000 - 5_000 && life <= 20 * 3600_000 + 1_000, String(life));
  // ثلاثة أجزاء base64url كما يفحصها التطبيق قبل قبوله
  assert.match(token, /^[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.ok(token.length <= 4096);
});

test('توكن الجلسة (مفتاح JWT_SECRET) لا يقبله verifyTrackToken — ولو حمل sub/tid/typ نفسها', () => {
  const session = jwt.sign({ id: 'rep1', role: 'SALES_REP', name: 'م', tenantId: 't1' }, SECRET);
  assert.equal(dt.verifyTrackToken(session), null);
  const forged = jwt.sign({ sub: 'rep1', tid: 't1', typ: 'fs-track' }, SECRET, { expiresIn: '20h' });
  assert.equal(dt.verifyTrackToken(forged), null, 'مفتاح الجلسات ليس مفتاح التتبّع');
});

test('رمز التتبّع لا يقبله jwt.verify بمفتاح الجلسات — فلا يمرّ من authenticate ولا يعدّه isRepPing جلسة', () => {
  const { token } = dt.issueTrackToken('rep1', 't1');
  assert.throws(() => jwt.verify(token, SECRET), /invalid signature/);
});

test('النوع الخاطئ أو الغائب، والهويّة الناقصة، والخوارزمية none، والرمز الضخم ⇒ null', () => {
  const k = `${SECRET}:device-track`;
  assert.equal(dt.verifyTrackToken(jwt.sign({ sub: 'rep1', tid: 't1', typ: 'session' }, k)), null);
  assert.equal(dt.verifyTrackToken(jwt.sign({ sub: 'rep1', tid: 't1' }, k)), null);
  assert.equal(dt.verifyTrackToken(jwt.sign({ sub: 'rep1', typ: 'fs-track' }, k)), null);
  assert.equal(dt.verifyTrackToken(jwt.sign({ tid: 't1', typ: 'fs-track' }, k)), null);
  assert.equal(dt.verifyTrackToken(jwt.sign({ sub: '', tid: 't1', typ: 'fs-track' }, k)), null);
  assert.equal(dt.verifyTrackToken(jwt.sign({ sub: 'rep1', tid: 5, typ: 'fs-track' }, k)), null);
  // المفتاح الصحيح بالنوع الصحيح يمرّ — الفرق النوع وحده
  assert.deepEqual(dt.verifyTrackToken(jwt.sign({ sub: 'rep1', tid: 't1', typ: 'fs-track' }, k)), { repId: 'rep1', tenantId: 't1' });
  const none = jwt.sign({ sub: 'rep1', tid: 't1', typ: 'fs-track' }, '', { algorithm: 'none' } as jwt.SignOptions);
  assert.equal(dt.verifyTrackToken(none), null);
  assert.equal(dt.verifyTrackToken(jwt.sign({ sub: 'rep1', tid: 't1', typ: 'fs-track', pad: 'x'.repeat(5000) }, k)), null);
  for (const bad of ['', 'abc', 'a.b.c', undefined as unknown as string, 7 as unknown as string]) assert.equal(dt.verifyTrackToken(bad), null);
});

test('الرمز المنتهي ⇒ null', () => {
  const k = `${SECRET}:device-track`;
  const expired = jwt.sign({ sub: 'rep1', tid: 't1', typ: 'fs-track', exp: Math.floor(Date.now() / 1000) - 10 }, k);
  assert.equal(dt.verifyTrackToken(expired), null);
});

test('بلا JWT_SECRET: الإصدار يرمي والتحقّق null (لا مفتاح فارغ يوقّع)', () => {
  const { token } = dt.issueTrackToken('rep1', 't1');
  delete process.env.JWT_SECRET;
  try {
    assert.throws(() => dt.issueTrackToken('rep1', 't1'), /JWT_SECRET/);
    assert.equal(dt.verifyTrackToken(token), null);
  } finally { process.env.JWT_SECRET = SECRET; }
});

test('Bearer: الرمز من الترويسة — وغيره null', () => {
  assert.equal(dt.bearerToken('Bearer a.b.c'), 'a.b.c');
  assert.equal(dt.bearerToken('bearer  a.b.c '), 'a.b.c');
  assert.equal(dt.bearerToken(['Bearer x.y.z']), 'x.y.z');
  for (const bad of [undefined, '', 'Bearer', 'Basic abc', 'Bearer a b', 5]) assert.equal(dt.bearerToken(bad), null, String(bad));
});

test('ساعة الجهاز: رقمٌ كالويب أو ISO-8601 كالتطبيق الأصلي — والفاسدة null', () => {
  assert.equal(dt.deviceNowMs('1762250000000'), 1762250000000);
  assert.equal(dt.deviceNowMs('2026-11-04T10:00:00.000Z'), Date.parse('2026-11-04T10:00:00.000Z'));
  assert.equal(dt.deviceNowMs(['2026-11-04T10:00:00Z']), Date.parse('2026-11-04T10:00:00Z'));
  for (const bad of [undefined, '', 'غد', '0', '-5', 5, '2026-11-04', 'Tue Nov 04 2026']) assert.equal(dt.deviceNowMs(bad), null, String(bad));
  // لحظة الالتقاط من الجهاز: ISO-8601 بمنطقتها وحدها
  assert.equal(dt.isoInstantMs('2026-11-04T10:00:00.123Z'), Date.parse('2026-11-04T10:00:00.123Z'));
  assert.equal(dt.isoInstantMs('2026-11-04T13:00:00+03:00'), Date.parse('2026-11-04T10:00:00Z'));
  for (const bad of ['-5', '2026-11-04T10:00:00', '1762250000000', 'x', null]) assert.equal(dt.isoInstantMs(bad), null, String(bad));
});

test('«التتبّع الأصلي يعمل الآن»: نافذة ٩٠ث لكل مندوب، ولا تتسرّب إلى غيره', () => {
  dt.resetNativeTrack();
  const t0 = 1_000_000_000_000;
  assert.equal(dt.NATIVE_TRACK_WINDOW_MS, 90_000);
  assert.equal(dt.nativeTrackActive('rep1', t0), false);
  dt.markNativeTrack('rep1', t0);
  assert.equal(dt.nativeTrackActive('rep1', t0), true);
  assert.equal(dt.nativeTrackActive('rep1', t0 + 90_000), true);
  assert.equal(dt.nativeTrackActive('rep2', t0 + 1_000), false);
  assert.equal(dt.nativeTrackActive('rep1', t0 + 90_001), false);
  // نقطةٌ جديدة تمدّ النافذة
  dt.markNativeTrack('rep1', t0 + 100_000);
  assert.equal(dt.nativeTrackActive('rep1', t0 + 150_000), true);
  dt.resetNativeTrack();
  assert.equal(dt.nativeTrackActive('rep1', t0 + 150_000), false);
});

test('رفع الإغلاق: الترويسة المشتركة x-fs-track-final بقيمة 1 وحدها، وclearNativeTrack ينسى المندوب وحده', () => {
  // قيمةٌ مشتركة مع أندرويد (TrackService.onDestroy) وآيفون (send(closing:true)) — تغييرها في جهةٍ يُبقي العلامة ٩٠ث بصمت
  assert.equal(dt.TRACK_FINAL_HEADER, 'x-fs-track-final');
  assert.equal(dt.isTrackFinal('1'), true);
  assert.equal(dt.isTrackFinal(' 1 '), true);
  assert.equal(dt.isTrackFinal(['1']), true);
  for (const v of [undefined, '', '0', 'true', 'yes', '11', 1, true, ['0']]) assert.equal(dt.isTrackFinal(v), false, String(v));

  dt.resetNativeTrack();
  const t0 = 1_000_000_000_000;
  dt.markNativeTrack('rep1', t0);
  dt.markNativeTrack('rep2', t0);
  dt.clearNativeTrack('rep1');
  assert.equal(dt.nativeTrackActive('rep1', t0 + 1_000), false, 'الخدمة توقّفت — لا انتظار للنافذة');
  assert.equal(dt.nativeTrackActive('rep2', t0 + 1_000), true, 'لا يمسّ غيره');
  // مندوبٌ لم يُعلَّم أصلاً: لا خطأ
  dt.clearNativeTrack('nobody');
  // بدءٌ جديد بعد الإغلاق يعلّمه من جديد
  dt.markNativeTrack('rep1', t0 + 5_000);
  assert.equal(dt.nativeTrackActive('rep1', t0 + 6_000), true);
  dt.resetNativeTrack();
});

test('«رُئي مؤخّراً» (nativeTrackSeenAt/nativeTrackFlags): الذاكرة تحفظ آخر رفعٍ ٥ دقائق — «يرفع الآن» ٩٠ث منها، والأوسع لسؤال التحقّق', () => {
  // فجوة رفعٍ عادية لجهازٍ سليم (ثلاث محاولاتٍ فاشلة ٢٨٥ث) أوسع من ٩٠ث: سؤال التحقّق بها وحدها أظهر زرّ البدء لخدمةٍ تعمل
  dt.resetNativeTrack();
  const t0 = 1_000_000_000_000;
  assert.equal(dt.NATIVE_RECENT_WINDOW_MS, 5 * 60_000);
  assert.ok(dt.NATIVE_RECENT_WINDOW_MS > 30_000 + 15_000 + 30_000 + 15_000 + 60_000 + 15_000 + 120_000, 'أسوأ فجوةٍ عادية');
  assert.ok(dt.NATIVE_RECENT_WINDOW_MS < dt.NATIVE_ROW_LOOKBACK_MS, 'داخل مدى الفهرس');
  assert.equal(dt.nativeTrackSeenAt('rep1', t0), null);
  dt.markNativeTrack('rep1', t0);
  assert.equal(dt.nativeTrackSeenAt('rep1', t0 + 1_000), t0);
  // بعد ٩٠ث: لا «يرفع الآن» (البدء ونقاط الصفحة كما كانا) — واللحظة باقية لـ«رُئي مؤخّراً»
  assert.equal(dt.nativeTrackActive('rep1', t0 + 120_000), false);
  assert.equal(dt.nativeTrackSeenAt('rep1', t0 + 120_000), t0, '«يرفع الآن» لا يمحو اللحظة');
  assert.deepEqual(dt.nativeTrackFlags(dt.nativeTrackSeenAt('rep1', t0 + 120_000), t0 + 120_000), { nativeActive: false, nativeRecent: true });
  assert.equal(dt.nativeTrackSeenAt('rep2', t0 + 1_000), null, 'لا يتسرّب إلى غيره');
  assert.equal(dt.nativeTrackSeenAt('rep1', t0 + dt.NATIVE_RECENT_WINDOW_MS), t0);
  assert.equal(dt.nativeTrackSeenAt('rep1', t0 + dt.NATIVE_RECENT_WINDOW_MS + 1), null);
  assert.equal(dt.nativeTrackSeenAt('rep1', t0 + 1_000), null, 'خرجت من الذاكرة');
  // الحكمان من لحظةٍ معروفة (ذاكرة، أو أحدث صفّ جهازٍ بعد نشر)
  assert.deepEqual(dt.nativeTrackFlags(null, t0), { nativeActive: false, nativeRecent: false });
  assert.deepEqual(dt.nativeTrackFlags(NaN, t0), { nativeActive: false, nativeRecent: false });
  assert.deepEqual(dt.nativeTrackFlags(t0, t0 + dt.NATIVE_TRACK_WINDOW_MS), { nativeActive: true, nativeRecent: true });
  assert.deepEqual(dt.nativeTrackFlags(t0, t0 + dt.NATIVE_TRACK_WINDOW_MS + 1), { nativeActive: false, nativeRecent: true });
  assert.deepEqual(dt.nativeTrackFlags(t0, t0 + dt.NATIVE_RECENT_WINDOW_MS + 1), { nativeActive: false, nativeRecent: false });
  // رفع الإغلاق ينسى اللحظة فوراً
  dt.markNativeTrack('rep1', t0 + 10_000);
  dt.clearNativeTrack('rep1', t0 + 11_000);
  assert.equal(dt.nativeTrackSeenAt('rep1', t0 + 12_000), null);
  dt.resetNativeTrack();
});

test('«أُغلقت للتوّ» (nativeTrackStopped): ٥ دقائق بعد رفع الإغلاق لكل مندوب، ورفعٌ عاديّ بعده يمحوها', () => {
  // صفوف دفعة الإغلاق «حديثة» في القاعدة NATIVE_RECENT_WINDOW_MS بعدها — /device-token لا يقرأ منها «يعمل» ولا «رُئي مؤخّراً»
  dt.resetNativeTrack();
  const t0 = 1_000_000_000_000;
  assert.equal(dt.nativeTrackStopped('rep1', t0), false, 'لم يُغلَق قط');
  dt.markNativeTrack('rep1', t0);
  dt.clearNativeTrack('rep1', t0 + 1_000);
  assert.equal(dt.nativeTrackStopped('rep1', t0 + 1_000), true);
  assert.equal(dt.nativeTrackStopped('rep1', t0 + 1_000 + dt.NATIVE_RECENT_WINDOW_MS), true);
  assert.equal(dt.nativeTrackStopped('rep2', t0 + 2_000), false, 'لا يتسرّب إلى غيره');
  assert.equal(dt.nativeTrackStopped('rep1', t0 + 1_001 + dt.NATIVE_RECENT_WINDOW_MS), false, 'صفوفه خرجت من النافذة');
  // خدمةٌ جديدة ترفع بعد الإغلاق: لا «أُغلقت»
  dt.clearNativeTrack('rep1', t0 + 200_000);
  dt.markNativeTrack('rep1', t0 + 210_000);
  assert.equal(dt.nativeTrackStopped('rep1', t0 + 211_000), false);
  assert.equal(dt.nativeTrackActive('rep1', t0 + 211_000), true);
  dt.clearNativeTrack('rep1', t0 + 220_000);
  dt.resetNativeTrack();
  assert.equal(dt.nativeTrackStopped('rep1', t0 + 221_000), false, 'التفريغ يشملها');
  assert.equal(dt.NATIVE_ROW_LOOKBACK_MS, 15 * 60_000);
});

test('حكم نقطة الجهاز: المندوب/الشركة ⇒ gone، التتبّع مطفأ لغير المقيَّد ⇒ off، وإلا on', () => {
  const now = Date.now();
  const tenant = { isActive: true, subscriptionEndsAt: null as Date | null };
  const rep = (o: Partial<import('../services/deviceTrack').TrackRepState> = {}) =>
    ({ isActive: true, canBeTracked: true, requireLocationOn: false, tenant, ...o });
  assert.equal(dt.deviceTrackDecision(rep(), true, now), 'on');
  assert.equal(dt.deviceTrackDecision(null, true, now), 'gone');
  assert.equal(dt.deviceTrackDecision(rep({ isActive: false }), true, now), 'gone');
  assert.equal(dt.deviceTrackDecision(rep({ tenant: null }), true, now), 'gone');
  assert.equal(dt.deviceTrackDecision(rep({ tenant: { isActive: false, subscriptionEndsAt: null } }), true, now), 'gone');
  assert.equal(dt.deviceTrackDecision(rep({ tenant: { isActive: true, subscriptionEndsAt: new Date(now - 1000) } }), true, now), 'gone');
  assert.equal(dt.deviceTrackDecision(rep({ tenant: { isActive: true, subscriptionEndsAt: new Date(now + 86_400_000) } }), true, now), 'on');
  // التتبّع مطفأ للشركة أو المندوب مستثنى
  assert.equal(dt.deviceTrackDecision(rep(), false, now), 'off');
  assert.equal(dt.deviceTrackDecision(rep(), null, now), 'off');
  assert.equal(dt.deviceTrackDecision(rep({ canBeTracked: false }), true, now), 'off');
  // المقيَّد: موقعه يُخزَّن دائماً كما في /tracking/ping — ولو أُطفئ التتبّع واستُثني
  assert.equal(dt.deviceTrackDecision(rep({ requireLocationOn: true, canBeTracked: false }), false, now), 'on');
  // ومعطّلٌ مقيَّد يبقى gone
  assert.equal(dt.deviceTrackDecision(rep({ requireLocationOn: true, isActive: false }), true, now), 'gone');
});

test('repTrackingOff = حكم /tracking/ping حرفياً (المندوب الغائب يتبع إعداد الشركة)', () => {
  assert.equal(dt.repTrackingOff(true, null), false);
  assert.equal(dt.repTrackingOff(false, null), true);
  assert.equal(dt.repTrackingOff(true, { canBeTracked: false, requireLocationOn: false }), true);
  assert.equal(dt.repTrackingOff(false, { canBeTracked: false, requireLocationOn: true }), false);
  assert.equal(dt.repTrackingOff(undefined, { canBeTracked: true, requireLocationOn: null }), true);
});

test('حارس ثابت: index.ts يركّب /api/track-device بلا authenticate وقبل محدِّد المعدّل العام وحارس الموقع', () => {
  const idx = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8');
  assert.match(idx, /^import trackDeviceRouter from '\.\/routes\/trackDevice';$/m);
  const mounts = idx.split('\n').filter((l) => l.includes("'/api/track-device'"));
  assert.deepEqual(mounts, ["app.use('/api/track-device', trackDeviceRouter);"], 'سطر تركيبٍ واحد بلا authenticate');
  const at = idx.indexOf("app.use('/api/track-device', trackDeviceRouter);");
  assert.ok(at > idx.indexOf('app.use(express.json('), 'بعد قارئ الجسم');
  assert.ok(at < idx.indexOf("app.use('/api', apiLimiter);"), 'قبل محدِّد المعدّل العام — دلواه الخاصّان');
  assert.ok(at < idx.indexOf("app.use('/api', requireRepLiveLocation);"));
  // والموجّه نفسه لا يستعمل جلسة الويب
  const route = fs.readFileSync(path.join(SRC, 'routes', 'trackDevice.ts'), 'utf8');
  assert.doesNotMatch(route, /import[^;]*\bauthenticate\b/, 'لا يستورد authenticate');
  assert.doesNotMatch(route, /router\.use\(/, 'لا حارس عامّ على الموجّه — كل مسارٍ بحرّاسه');
  assert.match(route, /router\.post\('\/ping', deviceIpLimiter, requireTrackToken, pingLimiter,/);
});

test('حارس ثابت: tracking.ts يعرض POST /device-token للمندوب ويشارك /ping دالة التخزين', () => {
  const src = fs.readFileSync(path.join(SRC, 'routes', 'tracking.ts'), 'utf8');
  assert.match(src, /router\.post\('\/device-token', async/);
  assert.match(src, /export async function storeRepPings\(/);
  // المسار تحت router.use(authenticate) وrequireAdminPermission الذي يمرّر المندوب
  assert.ok(src.indexOf("router.post('/device-token'") > src.indexOf("router.use(requireAdminPermission('canManageTracking'));"));
  const auth = fs.readFileSync(path.join(SRC, 'middleware', 'auth.ts'), 'utf8');
  assert.match(auth, /if \(req\.user\?\.role === 'SALES_REP'\) \{ next\(\); return; \}/, 'requireAdminPermission يمرّر المندوب');
});
