import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repLiveState, repLiveText, repSeenAt, relativeAge, noteServerNow, serverClockNow, CONNECTED_MS, LOCATION_FRESH_MS } from './liveRepStatus';
import { LIVE_LOCATIONS } from './livePolicy';

// «متصل الآن» على دبّوسٍ عمره ساعة كان يوهم المدير أن المندوب عند العميل (النبضة تمدّ الاتصال بلا GPS). الآن: موقعٌ
// مباشر، ومتصلٌ وموقعه متوقف، وغير متصل — بلحظة الموقع نفسها (lastLocAt).

const NOW = Date.parse('2026-10-22T10:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const tr = (s: string) => s;
const rep = (o: Partial<Parameters<typeof repLiveState>[0]> = {}) => ({ lastLat: 24.7, lastLng: 46.6, lastSeenAt: ago(10_000), lastLocAt: ago(20_000), ...o });

test('موقعٌ لُقط خلال دقيقتين والمندوب متصل ⇒ مباشر', () => {
  assert.equal(repLiveState(rep(), NOW), 'live');
  assert.equal(repLiveText(rep(), tr, () => '', NOW), 'موقع مباشر · الآن');
});

test('متصلٌ (نبضة حديثة) وموقعه عمره دقائق ⇒ «متصل وموقعه متوقف» لا «متصل الآن»', () => {
  const r = rep({ lastLocAt: ago(LOCATION_FRESH_MS + 1_000) });
  assert.equal(repLiveState(r, NOW), 'stale');
  assert.equal(repLiveText(r, tr, () => '', NOW), 'متصل وموقعه متوقف · قبل 2 د');
  assert.equal(repLiveText(rep({ lastLat: null, lastLng: null, lastLocAt: null }), tr, () => '', NOW), 'متصل بلا موقع');
  assert.equal(repLiveText(rep({ lastLocAt: null }), tr, () => '', NOW), 'متصل وموقعه غير محدث', 'موقعٌ قبل الترقية بلا لحظة');
});

test('غير متصل منذ ٥ دقائق ⇒ «آخر ظهور» بأسلوب الشاشة، ولم يظهر قط ⇒ «لم يحدد موقعه بعد»', () => {
  const r = rep({ lastSeenAt: ago(CONNECTED_MS), lastLocAt: ago(CONNECTED_MS) });
  assert.equal(repLiveState(r, NOW), 'offline');
  assert.equal(repLiveText(r, tr, (iso) => `@${iso}`, NOW), `آخر ظهور @${ago(CONNECTED_MS)}`);
  assert.equal(repLiveState(rep({ lastSeenAt: null, lastLocAt: null }), NOW), 'none');
  // لحظة موقعٍ بلا «آخر ظهور» لم تكن ممكنة قبل تتبّع الخلفية (الطابعان معاً): نقطة جهازٍ سبقت أول نبضة ⇒ ظهر فعلاً
  assert.equal(repLiveState(rep({ lastSeenAt: null }), NOW), 'live');
});

test('خادمٌ أقدم بلا lastLocAt (الواجهة نُشرت قبله): كما كان، «متصل» = موقعه الآن', () => {
  const legacy = { lastLat: 24.7, lastLng: 46.6, lastSeenAt: ago(10_000) };
  assert.equal(repLiveState(legacy, NOW), 'live');
  assert.equal(repLiveText(legacy, tr, () => '', NOW), 'متصل الآن');
});

test('تتبّع الخلفية: نقطة الجهاز تحرّك lastLocAt وحده — «متصل» بأحدث الطابعين، فالقائد والشاشة مقفلة «موقع مباشر»', () => {
  // قرار المالك ٤ نوفمبر ٢٠٢٦: الخادم لا يكتب lastSeenAt من نقاط الخلفية (عدّاد «الزيارات الحية» يبقى للتطبيق المفتوح)
  const driving = rep({ lastSeenAt: ago(40 * 60_000), lastLocAt: ago(20_000) });
  assert.equal(repSeenAt(driving), driving.lastLocAt);
  assert.equal(repLiveState(driving, NOW), 'live');
  assert.equal(repLiveText(driving, tr, () => '', NOW), 'موقع مباشر · الآن');
  // توقّفت الخدمة (منتصف الليل): «آخر ظهور» بلحظة آخر موقع لا بآخر فتحٍ للصفحة
  const stopped = rep({ lastSeenAt: ago(5 * 3_600_000), lastLocAt: ago(CONNECTED_MS + 60_000) });
  assert.equal(repLiveState(stopped, NOW), 'offline');
  assert.equal(repLiveText(stopped, tr, (iso) => `@${iso}`, NOW), `آخر ظهور @${stopped.lastLocAt}`);
  // بين دقيقتين وخمسٍ بلا نقطة: «متصل وموقعه متوقف» كما للصفحة
  assert.equal(repLiveState(rep({ lastSeenAt: ago(40 * 60_000), lastLocAt: ago(LOCATION_FRESH_MS + 1_000) }), NOW), 'stale');
});

test('نقاط الصفحة كما كانت: الطابعان معاً و«آخر ظهور» lastSeenAt — ولا طابع ⇒ «لم يحدد موقعه بعد»', () => {
  const r = rep();
  assert.equal(repSeenAt(r), r.lastSeenAt, 'lastSeenAt (وقت الاستقبال) هو الأحدث لنقطة الصفحة');
  assert.equal(repSeenAt({ lastLat: null, lastLng: null, lastSeenAt: ago(10_000) }), ago(10_000), 'خادمٌ أقدم بلا lastLocAt');
  assert.equal(repSeenAt({ lastLat: null, lastLng: null, lastSeenAt: null, lastLocAt: null }), null);
  assert.equal(repLiveState({ lastLat: null, lastLng: null, lastSeenAt: null, lastLocAt: null }, NOW), 'none');
  const old = rep({ lastSeenAt: ago(CONNECTED_MS + 1_000), lastLocAt: ago(CONNECTED_MS + 30_000) });
  assert.equal(repLiveText(old, tr, (iso) => `@${iso}`, NOW), `آخر ظهور @${old.lastSeenAt}`);
});

test('العمر النسبي', () => {
  assert.equal(relativeAge(ago(59_000), tr, NOW), 'الآن');
  assert.equal(relativeAge(ago(5 * 60_000), tr, NOW), 'قبل 5 د');
  assert.equal(relativeAge(ago(3 * 3_600_000), tr, NOW), 'قبل 3 س');
  assert.equal(relativeAge(ago(50 * 3_600_000), tr, NOW), 'قبل 2 يوم');
});

test('حارس ثابت: الشاشتان بالحالة الجديدة، وحدث «locations» يعيد قراءة قائمتيهما بمفتاحيهما', () => {
  const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...p), 'utf8');
  const web = read('pages', 'TrackingPage.tsx');
  const m = read('m', 'MTracking.tsx');
  for (const src of [web, m]) {
    assert.doesNotMatch(src, /isOnline\(/, 'مؤشر «متصل» القديم ما زال يحكم');
    assert.match(src, /icon=\{repIcon\(repLiveState\(r, now\), /);
  }
  assert.match(web, /queryKey: \['track-live'\],/);
  for (const src of [web, m]) {
    // الإطار مرةً لكل سياق عرض لا مع كل تحديث للمواقع (كان يلغي تكبير المدير كل ثوانٍ)
    assert.match(src, /if \(!points\.length \|\| done\.current === fitKey\) return;/);
    assert.match(src, /<FitBounds points=\{focusPoints\} fitKey=\{fitKey\} \/>/);
    // الحالة الزمنية تتقدّم ولو لم تصل بيانات
    assert.match(src, /const now = useNow\(15_000, serverClockNow\);/);
    // الطبقات بوصولها أول مرة (data) لا بنجاح آخر قراءة (isSuccess ينقلب مع فشلٍ عابر فيعيد التأطير)
    assert.doesNotMatch(src.slice(src.indexOf('const fitKey')), /isSuccess/);
    assert.match(src, /liveQ\.data !== undefined, routeQ\.data !== undefined/);
    assert.match(src, /noteServerNow\((data|r\.data\?)\.serverNow\);/);
    assert.match(src, /repLiveState\(r, now\)/);
    assert.match(src, /readLiveReps\('(web|m)', qc\.getQueryData<LiveRep\[\]>/);
  }
  assert.match(m, /queryKey: \['m-track-live'\],/);
  assert.deepEqual(LIVE_LOCATIONS.map((k) => k.join('/')), ['track-live', 'm-track-live']);
  const live = read('lib', 'liveInvoices.ts');
  assert.match(live, /\} else if \(ev\.event === 'locations'\) \{\s*refreshLocations\(\);/);
  assert.match(live, /for \(const queryKey of LIVE_LOCATIONS\) void qc\.invalidateQueries\(\{ queryKey \}\);/);
});

test('ساعة جهاز المدير المنحرفة لا تقلب «موقع مباشر»: «الآن» بساعة الخادم من ردّ /tracking/live', () => {
  const ahead = 3 * 60_000; // جهاز المدير متقدّم ثلاث دقائق
  const deviceNow = Date.now();
  noteServerNow(deviceNow - ahead, deviceNow);
  const serverNow = serverClockNow();
  assert.ok(Math.abs(serverNow - (Date.now() - ahead)) < 1_000);
  const r = { lastLat: 24.7, lastLng: 46.6, lastSeenAt: new Date(serverNow - 10_000).toISOString(), lastLocAt: new Date(serverNow - 20_000).toISOString() };
  assert.equal(repLiveState(r, serverNow), 'live');
  assert.equal(repLiveState(r, Date.now()), 'stale', 'بساعة الجهاز المنحرفة كان «متوقفاً»');
  noteServerNow(undefined); // خادمٌ أقدم بلا serverNow: يبقى آخر تقدير
  assert.ok(Math.abs(serverClockNow() - (Date.now() - ahead)) < 1_000);
  noteServerNow(Date.now()); // إعادة للاختبارات التالية
});
