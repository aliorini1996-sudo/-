import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createGeoReconnect, SILENT_MS, COOLDOWN_MS, BLOCKED_MAX_MS, DRAIN_MAX_MS, TICK_MS, RESUME_DELAY_MS, type ReconnectEnv } from './geoReconnect';

/**
 * إنعاش اتصال الموقع داخل تطبيق أندرويد (بلاغ المالك ٣ نوفمبر ٢٠٢٦، الحالة النادرة بعد 1.2.3): Chrome يرسل «ابدأ» للتطبيق مع كل
 * اتصال Geolocation جديد وحده، فإن ماتت عملية التطبيق والصفحة مفتوحة بقي الاتصال صامتاً (مثبتٌ على المحاكي). المالك يغلقه بمسح
 * المراقبات في لحظةٍ بلا طلب مفرد ثم يعيدها في تكةٍ لاحقة. Blink هنا مُحاكى: اتصالٌ مفتوح ما دام فيه مستمع، ويُغلق حين يخلو.
 */

type Pos = GeolocationPosition;
const pos = (lat: number, timestamp = 0): Pos => ({ coords: { latitude: lat, longitude: 46, accuracy: 5 }, timestamp } as unknown as Pos);

function fakeBlink() {
  let nextId = 100;
  const watches = new Map<number, { s: PositionCallback; e?: PositionErrorCallback | null }>();
  const oneShots: Array<{ s: PositionCallback; e?: PositionErrorCallback | null; o?: PositionOptions; done: boolean }> = [];
  let connections = 0; // عدد الاتصالات التي فُتحت (كل واحد = «ابدأ» جديد للتطبيق)
  let open = false;
  const listeners = () => watches.size + oneShots.filter(o => !o.done).length;
  const ensureOpen = () => { if (!open) { open = true; connections += 1; } };
  const maybeClose = () => { if (listeners() === 0) open = false; };
  return {
    native: {
      watchPosition(s: PositionCallback, e?: PositionErrorCallback | null) { ensureOpen(); nextId += 1; watches.set(nextId, { s, e }); return nextId; },
      clearWatch(id: number) { watches.delete(id); maybeClose(); },
      getCurrentPosition(s: PositionCallback, e?: PositionErrorCallback | null, o?: PositionOptions) { ensureOpen(); oneShots.push({ s, e, o, done: false }); },
    },
    emit(p: Pos) { for (const w of [...watches.values()]) w.s(p); for (const o of oneShots.filter(x => !x.done)) { o.done = true; o.s(p); } maybeClose(); },
    timeoutOneShots() { for (const o of oneShots.filter(x => !x.done)) { o.done = true; o.e?.({ code: 3, message: 'Timeout expired' } as GeolocationPositionError); } maybeClose(); },
    /** Blink يُسقط المراقبات عند رفض الإذن */
    denyWatches() { for (const [id, w] of [...watches]) { watches.delete(id); w.e?.({ code: 1, message: 'User denied Geolocation', PERMISSION_DENIED: 1 } as GeolocationPositionError); } maybeClose(); },
    get connections() { return connections; },
    get open() { return open; },
    get nativeWatchIds() { return [...watches.keys()]; },
    get pendingOneShots() { return oneShots.filter(o => !o.done); },
  };
}

function fakeEnv(start = 1_000_000) {
  let now = start;
  let visible = true;
  const timers: Array<{ at: number; fn: () => void; every?: number }> = [];
  const remove = (h: unknown) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); };
  const env: ReconnectEnv = {
    now: () => now,
    visible: () => visible,
    setTimeout: (fn, ms) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
    clearTimeout: remove,
    setInterval: (fn, ms) => { const t = { at: now + ms, fn, every: ms }; timers.push(t); return t; },
    clearInterval: remove,
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      if (due.every) due.at += due.every; else timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
    now = end;
  };
  return { env, advance, setVisible: (v: boolean) => { visible = v; }, now: () => now };
}

test('يمرّر كما هو: المعرّفات للمستدعي، والقراءات تصل، ولا إنعاش ما دامت القراءات تتدفق', () => {
  const b = fakeBlink(); const { env, advance } = fakeEnv();
  const hub = createGeoReconnect(b.native, env);
  const got: number[] = [];
  const id = hub.watchPosition((p) => got.push(p.coords.latitude));
  assert.equal(b.connections, 1);
  for (let i = 0; i < 20; i++) { advance(5_000); b.emit(pos(i)); }
  assert.equal(got.length, 20);
  assert.equal(hub.reconnects(), 0);
  assert.equal(b.connections, 1, 'لا اتصال جديد والقراءات تصل');
  hub.clearWatch(id);
  assert.equal(b.open, false, 'مسح آخر مراقبة يغلق الاتصال كما في Blink');
});

test('السكوت ٣٠ث والصفحة ظاهرة: يُغلق الاتصال ويُفتح غيره، والقراءات تعود إلى ردّ المستدعي نفسه', () => {
  const b = fakeBlink(); const { env, advance } = fakeEnv();
  const hub = createGeoReconnect(b.native, env);
  const got: number[] = [];
  const id = hub.watchPosition((p) => got.push(p.coords.latitude));
  const firstNative = b.nativeWatchIds[0];
  advance(SILENT_MS + TICK_MS); // لا قراءة: التطبيق مات
  advance(RESUME_DELAY_MS);
  assert.equal(hub.reconnects(), 1);
  assert.equal(b.connections, 2, 'اتصالٌ جديد = «ابدأ» جديد للتطبيق');
  assert.notEqual(b.nativeWatchIds[0], firstNative);
  b.emit(pos(24.7));
  assert.deepEqual(got, [24.7]);
  hub.clearWatch(id);
  assert.equal(b.nativeWatchIds.length, 0, 'معرّف المستدعي القديم يمسح المراقبة الجديدة');
});

test('طلبٌ مفرد معلّق: لا تعليق ولا تأخير لأحد — يُنتظر أول فجوة بلا طلب ثم يُنعش فوراً', () => {
  const b = fakeBlink(); const { env, advance } = fakeEnv();
  const hub = createGeoReconnect(b.native, env);
  hub.watchPosition(() => {});
  advance(SILENT_MS - 1_000);
  const results: string[] = [];
  hub.getCurrentPosition(() => results.push('old-ok'), (e) => results.push('old-' + e.code), { timeout: 20_000 });
  advance(2 * TICK_MS); // سكوتٌ والطلب معلّق: لا تعليق
  assert.equal(hub.reconnects(), 0);
  assert.equal(b.nativeWatchIds.length, 1, 'المراقبة باقية: لا شيء مُعلَّق');
  hub.getCurrentPosition((p) => results.push('mid-' + p.coords.latitude)); // يُرسل فوراً (لا تعليق)
  assert.equal(b.pendingOneShots.length, 2);
  b.timeoutOneShots();
  advance(TICK_MS + RESUME_DELAY_MS); // أول تكة بعد الفجوة
  assert.equal(hub.reconnects(), 1);
  assert.equal(b.connections, 2);
  assert.deepEqual(results, ['old-3'], 'الطلبان أُجيبا من Blink نفسه بلا تأخير من المالك');
});

test('طلبٌ يصل أثناء الإنعاش (٥٠م‌ث): مهلته تجري منذ طلبه، ويُرسل على الاتصال الجديد بما بقي منها', () => {
  const b = fakeBlink(); const { env, advance } = fakeEnv();
  const hub = createGeoReconnect(b.native, env);
  hub.watchPosition(() => {});
  advance(SILENT_MS); // تكة الثلاثين: تعليقٌ الآن، والإعادة بعد RESUME_DELAY_MS
  advance(20);
  const got: number[] = [];
  hub.getCurrentPosition((p) => got.push(p.coords.latitude), null, { timeout: 8_000 });
  assert.equal(b.pendingOneShots.length, 0, 'مؤجَّل حتى الإعادة');
  advance(RESUME_DELAY_MS);
  const sent = b.pendingOneShots[0];
  assert.ok(sent, 'أُرسل على الاتصال الجديد');
  assert.ok((sent.o?.timeout ?? 0) <= 8_000 - 30 && (sent.o?.timeout ?? 0) >= 8_000 - 60, 'ما بقي من المهلة لا مهلة كاملة جديدة');
  b.emit(pos(24.9));
  assert.deepEqual(got, [24.9]);
});

test('طلبٌ مؤجَّل تنتهي مهلته قبل الإعادة: خطأ TIMEOUT بشكل خطأ المتصفح، ولا يُرسل بعدها', () => {
  const b = fakeBlink(); const { env, advance } = fakeEnv();
  const hub = createGeoReconnect(b.native, env);
  hub.watchPosition(() => {});
  hub.getCurrentPosition(() => {}); // بلا مهلة: يمسك الاتصال فيطول التعليق
  advance(SILENT_MS + TICK_MS);
  advance(BLOCKED_MAX_MS); // طلبٌ لا ينتهي: يُعلَّق بعد BLOCKED_MAX_MS
  const errs: GeolocationPositionError[] = [];
  hub.getCurrentPosition(() => assert.fail('لا قراءة'), (e) => errs.push(e), { timeout: 1_000 });
  advance(1_000);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, errs[0].TIMEOUT);
  advance(DRAIN_MAX_MS + TICK_MS);
  assert.equal(b.pendingOneShots.length, 1, 'الطلب المنتهي لم يُرسل بعد الإعادة (الباقي هو القديم بلا مهلة)');
});

test('أثناء الإنعاش: طلبٌ ضمن maximumAge يُجاب من آخر قراءة فوراً كما يفعل Blink', () => {
  const b = fakeBlink(); const { env, advance, now } = fakeEnv();
  const hub = createGeoReconnect(b.native, env);
  hub.watchPosition(() => {});
  b.emit(pos(24.5, now()));
  advance(SILENT_MS); // تكة الثلاثين: تعليقٌ الآن
  let got: number | null = null;
  hub.getCurrentPosition((p) => { got = p.coords.latitude; }, null, { maximumAge: 300_000 });
  advance(0);
  assert.equal(got, 24.5);
});

test('طلبٌ مفرد لا ينتهي أبداً وطلباتٌ متداخلة بلا فجوة: يُعلَّق بعد BLOCKED_MAX_MS وتُعاد المراقبات بعد DRAIN_MAX_MS', () => {
  const b = fakeBlink(); const { env, advance } = fakeEnv();
  const hub = createGeoReconnect(b.native, env);
  const got: number[] = [];
  hub.watchPosition((p) => got.push(p.coords.latitude));
  hub.getCurrentPosition(() => {}); // بلا مهلة
  advance(SILENT_MS + TICK_MS);
  assert.equal(b.nativeWatchIds.length, 1, 'لا تعليق قبل BLOCKED_MAX_MS');
  advance(BLOCKED_MAX_MS);
  assert.equal(b.nativeWatchIds.length, 0, 'عُلّق');
  advance(DRAIN_MAX_MS + TICK_MS);
  assert.equal(b.nativeWatchIds.length, 1, 'أُعيدت المراقبة');
  b.emit(pos(1));
  assert.deepEqual(got, [1]);
});

test('رفض الإذن: Blink أسقط المراقبة، فلا تُعاد ولا يُطلب الإذن كل دقيقة', () => {
  const b = fakeBlink(); const { env, advance } = fakeEnv();
  const hub = createGeoReconnect(b.native, env);
  const errs: number[] = [];
  hub.watchPosition(() => {}, (e) => errs.push(e.code));
  b.denyWatches();
  assert.deepEqual(errs, [1]);
  advance(10 * COOLDOWN_MS);
  assert.equal(hub.reconnects(), 0);
  assert.equal(b.connections, 1, 'لا اتصال جديد = لا سؤال إذن متكرر');
});

test('الصفحة مخفية: لا إنعاش، وبعد ظهورها مهلةٌ كاملة من جديد', () => {
  const b = fakeBlink(); const { env, advance, setVisible } = fakeEnv();
  const hub = createGeoReconnect(b.native, env);
  hub.watchPosition(() => {});
  setVisible(false);
  advance(5 * SILENT_MS);
  assert.equal(hub.reconnects(), 0);
  setVisible(true);
  advance(TICK_MS);
  assert.equal(hub.reconnects(), 0, 'أول تكة بعد الظهور تبدأ المهلة');
  advance(SILENT_MS - TICK_MS);
  assert.equal(hub.reconnects(), 0);
  advance(2 * TICK_MS + RESUME_DELAY_MS);
  assert.equal(hub.reconnects(), 1);
});

test('لا إنعاشين أقرب من COOLDOWN_MS (داخل مبنى بلا إشارة)، ولا إنعاش بلا مراقبة', () => {
  const b = fakeBlink(); const { env, advance } = fakeEnv();
  const hub = createGeoReconnect(b.native, env);
  advance(5 * SILENT_MS);
  assert.equal(hub.reconnects(), 0, 'بلا مراقبة لا شيء يُنعش');
  hub.watchPosition(() => {});
  advance(SILENT_MS + TICK_MS + RESUME_DELAY_MS);
  assert.equal(hub.reconnects(), 1);
  advance(COOLDOWN_MS - TICK_MS - 1);
  assert.equal(hub.reconnects(), 1);
  advance(2 * TICK_MS + RESUME_DELAY_MS);
  assert.equal(hub.reconnects(), 2);
});

test('مراقبةٌ تُمسح أثناء التعليق لا تُعاد', () => {
  const b = fakeBlink(); const { env, advance } = fakeEnv();
  const hub = createGeoReconnect(b.native, env);
  const a = hub.watchPosition(() => {});
  hub.watchPosition(() => {});
  advance(SILENT_MS + TICK_MS); // تعليقٌ فوري (لا طلب مفرد)
  hub.clearWatch(a);
  advance(RESUME_DELAY_MS);
  assert.equal(b.nativeWatchIds.length, 1);
});

test('حارس ثابت: يُعلَّم تبويب التطبيق قبل حذف fsbridge، ويُركَّب المالك في RepApp قبل أي طلب موقع وفي تبويب التطبيق وحده', () => {
  const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
  const main = read('main.tsx');
  assert.ok(main.indexOf('markAppLaunch();') > 0 && main.indexOf('markAppLaunch();') < main.indexOf('captureBridgeLaunch();'), 'العلامة قبل حذف المعامل');
  const app = read('rep', 'RepApp.tsx');
  assert.match(app, /import \{ installGeoReconnect \} from '\.\/geoReconnect';/);
  assert.match(app, /\ninstallGeoReconnect\(\);\n/);
  const src = read('rep', 'geoReconnect.ts');
  assert.match(src, /window\.sessionStorage\.getItem\(IN_APP_KEY\) !== '1'/, 'تبويب التطبيق وحده لا علامة الجسر المشتركة');
  assert.doesNotMatch(src, /readBridgeFlag/);
});
