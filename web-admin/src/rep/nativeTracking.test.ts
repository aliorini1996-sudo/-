// التتبّع الخلفي في تطبيق الجوال (طلب المالك، ٤ نوفمبر ٢٠٢٦) ببيئةٍ مزيّفة: روابط intent حرفاً بحرف، والتقاط fstrack
// وحذفه وحده، وتمييز المنصّة، ويوم البدء لكل مندوب، و«لا تتبّع» ⇒ إيقافٌ هادئ، وبلا تطبيق لا شيء، وزرّ البدء بلمسته وحدها (لا تُستعار
// لمسة الطباعة أو التحصيل، ولا يُنتظر إخفاء الصفحة)، والإيقاف أثناء طلب الرمز، ولا رمي أبداً — وحارس العقد مع TrackContract.kt
// (android-rep، قراءةً فقط) وتوصيل main.tsx وuseRepTracking وRepApp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IOS_TRACK_HANDLER, TRACK_HOST_START, TRACK_HOST_STOP, TRACK_LAUNCH_PARAM, TRACK_LAUNCH_VALUE, TRACK_PACKAGE, TRACK_PARAM_DEBUG_URL,
  TRACK_PARAM_TOKEN, TRACK_PING_URL, TRACK_SCHEME, TRACK_TOKEN_PATH, browserTrackEnv, captureTrackLaunch, isTrackToken,
  nativeTrackPlatform, showStartChip, startNativeTracking, startNativeTrackingOnPunch, stopNativeTracking, trackIntentUrl,
  trackTokenReplyOf, PUNCH_RETURN_MAX_MS, type NativeTrackEnv,
  type TrackTokenPost,
} from './nativeTracking';
import { deviceDay } from './deviceDay';
import type { AppEnv } from '../lib/print/transport/appBridge';

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJyZXAtMSIsInRpZCI6InQtMSIsInR5cCI6ImZzLXRyYWNrIn0.c2lnbmF0dXJlLXZhbHVlX2hlcmU';
const ON = { success: true, data: { enabled: true, token: TOKEN, expiresAt: '2026-11-05T05:00:00.000Z' } };
const OFF = { success: true, data: { enabled: false } };
/** «بصمة الحضور» مفعّلة ولم يبصم: البدء ينتظر لمسة الحضور */
const PUNCH = { success: true, data: { ...ON.data, waitPunch: true } };
/** الجهاز يرفع الآن (بدأ من تبويبٍ سابق) */
const ACTIVE = { success: true, data: { ...ON.data, nativeActive: true } };
const START_URL = `intent://start?t=${TOKEN}#Intent;scheme=fieldsatrack;package=net.fieldsa.twa;end`;
const STOP_URL = 'intent://stop#Intent;scheme=fieldsatrack;package=net.fieldsa.twa;end';
const TODAY = new Date(2026, 10, 4, 9, 30, 0);
/** علامة يوم البدء: «اليوم|المندوب» */
const mark = (d: Date, rep = 'rep-A') => `${deviceDay(d)}|${rep}`;

type Store = NonNullable<NativeTrackEnv['session']>;
function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m };
}
const throwingStorage: Store = {
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('SecurityError'); },
  removeItem: () => { throw new Error('SecurityError'); },
};

/** بيئة فتح الروابط (نظير appBridge.test.ts): مؤقّتاتٌ يدوية ومستمعون، وكل href يُسجَّل */
function fakeApp() {
  let clock = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; f: () => void }>();
  const ls = new Map<string, Set<() => void>>();
  const on = (prefix: string) => ({
    addEventListener: (t: string, f: () => void) => { const k = prefix + t; if (!ls.has(k)) ls.set(k, new Set()); ls.get(k)!.add(f); },
    removeEventListener: (t: string, f: () => void) => { ls.get(prefix + t)?.delete(f); },
  });
  const hrefs: string[] = [];
  const app = {
    doc: { ...on('doc:'), visibilityState: 'visible' },
    win: {
      ...on('win:'),
      location: {
        get href() { return 'https://fieldsa.net/rep'; },
        set href(v: string) { hrefs.push(v); app.onHref?.(); },
      },
    },
    storage: null,
    now: () => clock,
    setTimeout: (f: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: clock + ms, f }); return id; },
    clearTimeout: (h: unknown) => { timers.delete(h as number); },
    activation: () => app.act,
    frame: null as AppEnv['frame'],
    // ─── أدوات الاختبار ───
    /** navigator.userActivation?.isActive — null حيث لا يُعرف */
    act: null as boolean | null,
    onHref: null as null | (() => void),
    hrefs,
    hide() { app.doc.visibilityState = 'hidden'; for (const f of [...(ls.get('doc:visibilitychange') ?? [])]) f(); },
    show() { app.doc.visibilityState = 'visible'; for (const f of [...(ls.get('doc:visibilitychange') ?? [])]) f(); },
    listeners: () => [...ls.values()].reduce((n, s) => n + s.size, 0),
    advance(ms: number) {
      const end = clock + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        clock = next[1].at;
        next[1].f();
      }
      clock = end;
    },
  };
  return app;
}

/**
 * صفحةٌ في تطبيق أندرويد (cap) أو الآيفون (ios) أو متصفح. شاشة التطبيق شفّافة: فتح الرابط لا يُخفي الصفحة (handOff يحاكي شاشةً
 * معتمة تُخفيها). وزرّ البدء يُحاكى بقائمة (tap = لمسته).
 */
function harness(o: { cap?: boolean; ios?: boolean | 'throws'; handOff?: boolean; session?: Store; local?: Store; now?: Date } = {}) {
  const app = fakeApp();
  if (o.handOff) app.onHref = () => { app.hide(); app.show(); };
  const session = o.session ?? memStorage(o.cap ? { fs_track_cap: 'android' } : {});
  const local = o.local ?? memStorage();
  const iosMsgs: unknown[] = [];
  const handler = o.ios ? { postMessage: (m: unknown) => { if (o.ios === 'throws') throw new Error('gone'); iosMsgs.push(m); } } : null;
  let taps: Array<() => void> = [];
  let date = o.now ?? TODAY;
  let sessionKey: string | null = 'rep-session-A';
  let rep: string | null = 'rep-A';
  const env: NativeTrackEnv = {
    session, local, ios: () => handler, app: app as unknown as AppEnv, now: () => date,
    askTap: (f) => { taps.push(f); return () => { taps = taps.filter((x) => x !== f); }; },
    sessionKey: () => sessionKey,
    repId: () => rep,
  };
  return {
    env, app, session, local, iosMsgs,
    /** جلسةٌ (rep_token) ومندوبها (rep_user.id) — المندوب يبقى إن لم يُذكر */
    login(k: string | null, r?: string | null) { sessionKey = k; if (r !== undefined) rep = r; },
    /** لمسة زرّ البدء */
    tap() { const t = taps; taps = []; for (const f of t) f(); },
    armed: () => taps.length,
    setNow(d: Date) { date = d; },
    day: () => (session as ReturnType<typeof memStorage>).m?.get('fs_track_day') ?? null,
    sent: () => (local as ReturnType<typeof memStorage>).m?.get('fs_track_native') ?? null,
  };
}

function poster(reply: unknown) {
  const calls: unknown[][] = [];
  const post: TrackTokenPost = async (...a) => {
    calls.push(a);
    if (reply instanceof Error) throw reply;
    return { data: reply };
  };
  return { post, calls };
}

const tick = () => new Promise<void>((r) => setImmediate(r));
async function until(cond: () => boolean) {
  for (let i = 0; i < 5000 && !cond(); i++) await tick();
  assert.ok(cond(), 'لم يحدث');
}

test('روابط intent حرفاً بحرف: البدء بالرمز مرمَّزاً، والإيقاف بلا معاملات — بلا رابطٍ بديل ومع package', () => {
  assert.equal(trackIntentUrl(TRACK_HOST_START, TOKEN), START_URL);
  assert.equal(trackIntentUrl(TRACK_HOST_STOP), STOP_URL);
  assert.equal(trackIntentUrl(TRACK_HOST_START, 'a+b/c=d&e'), 'intent://start?t=a%2Bb%2Fc%3Dd%26e#Intent;scheme=fieldsatrack;package=net.fieldsa.twa;end');
  for (const u of [START_URL, STOP_URL]) assert.ok(!u.includes('browser_fallback_url') && !u.includes(`${TRACK_PARAM_DEBUG_URL}=`));
  assert.equal(TRACK_PACKAGE, 'net.fieldsa.twa');
  assert.equal(TRACK_TOKEN_PATH, '/tracking/device-token');
});

test('شكل الرمز وردّ الخادم: JWT بثلاثة أجزاء base64url ≤ 4096 — وغيره لا يُسلَّم للتطبيق', () => {
  assert.ok(isTrackToken(TOKEN));
  for (const bad of ['', 'a.b', 'a.b.c.d', 'a.b.c d', 'a.b.c\n', 'a.b.c?x=1', `a.b.${'c'.repeat(4096)}`, null, 42]) assert.ok(!isTrackToken(bad), String(bad));
  assert.deepEqual(trackTokenReplyOf(ON), { enabled: true, token: TOKEN, waitPunch: false, nativeActive: false }, 'خادمٌ أقدم بلا الحقلين');
  assert.deepEqual(trackTokenReplyOf(PUNCH), { enabled: true, token: TOKEN, waitPunch: true, nativeActive: false });
  assert.deepEqual(trackTokenReplyOf(ACTIVE), { enabled: true, token: TOKEN, waitPunch: false, nativeActive: true });
  assert.equal((trackTokenReplyOf({ data: { ...ON.data, waitPunch: 'yes' } }) as { waitPunch: boolean }).waitPunch, false);
  assert.deepEqual(trackTokenReplyOf(OFF), { enabled: false });
  for (const bad of [null, {}, { data: null }, { data: { enabled: true } }, { data: { enabled: true, token: 'x' } }, { data: { enabled: 'yes', token: TOKEN } }]) {
    assert.equal(trackTokenReplyOf(bad), null, JSON.stringify(bad));
  }
});

test('captureTrackLaunch: fstrack=1 ⇒ علامة القدرة، ويُحذف المعامل وحده — fsbridge وcardpay والمرساة وhistory.state باقية', () => {
  const st = memStorage();
  const state = { __fsDepth: 2 };
  const calls: unknown[][] = [];
  captureTrackLaunch({
    location: { search: '?cardpay=8f1c-uuid&fstrack=1&fsbridge=2.Ab3_Cd4-Ef5Gh6Ij7Kl8Mn&tab=a%20b', pathname: '/rep', hash: '#docs' },
    history: { state, replaceState: (...a: unknown[]) => { calls.push(a); } },
    storage: st,
  });
  assert.equal(st.m.get('fs_track_cap'), 'android');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], state);
  assert.equal(calls[0][1], '');
  assert.equal(calls[0][2], '/rep?cardpay=8f1c-uuid&fsbridge=2.Ab3_Cd4-Ef5Gh6Ij7Kl8Mn&tab=a%20b#docs');
  // المعامل وحده ⇒ بلا علامة استفهام؛ وقيمةٌ غير 1 تُحذف بلا علامة
  const c2: unknown[][] = [];
  const st2 = memStorage();
  captureTrackLaunch({ location: { search: '?fstrack=0', pathname: '/rep', hash: '' }, history: { state: null, replaceState: (...a: unknown[]) => { c2.push(a); } }, storage: st2 });
  assert.equal(c2[0][2], '/rep');
  assert.equal(st2.m.has('fs_track_cap'), false);
  // بلا المعامل: لا مساس بالعنوان ولا بالتخزين
  const c3: unknown[][] = [];
  const st3 = memStorage();
  captureTrackLaunch({ location: { search: '?fstrackx=1&a=fstrack', pathname: '/rep', hash: '#x' }, history: { state: null, replaceState: (...a: unknown[]) => { c3.push(a); } }, storage: st3 });
  assert.equal(c3.length, 0);
  assert.equal(st3.m.size, 0);
  // تخزينٌ محجوب: يُحذف المعامل ولا يرمي — واستبدالٌ يرمي لا يمنع الإقلاع
  const c4: unknown[][] = [];
  captureTrackLaunch({ location: { search: '?fstrack=1&x=1', pathname: '/rep', hash: '' }, history: { state: null, replaceState: (...a: unknown[]) => { c4.push(a); } }, storage: throwingStorage });
  assert.equal(c4[0][2], '/rep?x=1');
  assert.doesNotThrow(() => captureTrackLaunch({ location: { search: '?fstrack=1', pathname: '/rep', hash: '' }, history: { state: null, replaceState: () => { throw new Error('x'); } }, storage: memStorage() }));
  assert.doesNotThrow(() => captureTrackLaunch()); // خارج المتصفح
});

test('المنصّة: الآيفون بمعالجه (يُقدَّم)، وأندرويد بعلامة القدرة، وغيرهما لا تطبيق', () => {
  assert.equal(nativeTrackPlatform(harness().env), null);
  assert.equal(nativeTrackPlatform(harness({ cap: true }).env), 'android');
  assert.equal(nativeTrackPlatform(harness({ ios: true }).env), 'ios');
  assert.equal(nativeTrackPlatform(harness({ ios: true, cap: true }).env), 'ios');
  assert.equal(nativeTrackPlatform(harness({ session: memStorage({ fs_track_cap: 'ios' }) }).env), null);
  assert.equal(nativeTrackPlatform(harness({ session: throwingStorage }).env), null);
  assert.equal(nativeTrackPlatform(null), null);
  assert.equal(nativeTrackPlatform(), null, 'خارج المتصفح');
  assert.equal(browserTrackEnv(), null);
  // معالجٌ بلا postMessage، أو معالج تطبيقٍ آخر، لا يكفي
  const w = { webkit: { messageHandlers: { fsPrint: { postMessage() {} }, [IOS_TRACK_HANDLER]: { postMessage: 1 } } } };
  const g = globalThis as unknown as { window?: unknown; document?: unknown };
  g.window = w; g.document = {};
  try {
    // browserTrackEnv يقرأ window.sessionStorage وnavigator — الغائب يُحتمل
    const env = browserTrackEnv();
    assert.equal(env === null || env.ios() === null, true);
  } finally { delete g.window; delete g.document; }
});

test('بلا تطبيق: لا طلب رمز ولا زرّ ولا رابط ولا رسالة — وخارج المتصفح لا شيء', async () => {
  const h = harness();
  const p = poster(ON);
  await startNativeTracking(p.post, h.env);
  stopNativeTracking(h.env);
  assert.equal(p.calls.length, 0);
  assert.equal(h.armed(), 0);
  assert.equal(h.app.hrefs.length, 0);
  assert.equal(h.day(), null);
  const p2 = poster(ON);
  await startNativeTracking(p2.post);
  stopNativeTracking();
  assert.equal(p2.calls.length, 0);
});

test('أندرويد: الرمز بطلبٍ خلفيّ ثم زرّ البدء — لمسته تفتح الرابط وتعلّم اليوم (الشاشة الشفّافة لا تُخفي الصفحة) فلا يُعاد في اليوم نفسه', async () => {
  const h = harness({ cap: true });
  const p = poster(ON);
  await startNativeTracking(p.post, h.env);
  assert.deepEqual(p.calls, [[TRACK_TOKEN_PATH, {}, { background: true }]]);
  assert.equal(h.app.hrefs.length, 0, 'لا رابط قبل لمسة الزرّ');
  assert.equal(h.armed(), 1);
  assert.equal(h.day(), null);
  h.tap();
  assert.deepEqual(h.app.hrefs, [START_URL], 'داخل اللمسة نفسها');
  assert.equal(h.day(), mark(TODAY));
  assert.equal(h.sent(), '1');
  h.app.advance(15_000); // لا إخفاء أبداً: لا محاولة ثانية ولا ما يُلغي العلامة
  assert.equal(h.app.listeners(), 0, 'المراقبة انتهت');
  assert.deepEqual(h.app.hrefs, [START_URL]);
  assert.equal(h.day(), mark(TODAY));
  await startNativeTracking(p.post, h.env);
  assert.equal(p.calls.length, 1, 'اليوم نفسه بلا طلب');
  assert.equal(h.armed(), 0, 'ولا زرّ');
  // يومٌ جديد (العودة للتطبيق بعد منتصف الليل) ⇒ رمزٌ جديد وزرٌّ جديد
  h.setNow(new Date(2026, 10, 5, 7, 0, 0));
  await startNativeTracking(p.post, h.env);
  assert.equal(p.calls.length, 2);
  h.tap();
  assert.equal(h.app.hrefs.length, 2);
  assert.equal(h.day(), '2026-11-05|rep-A');
});

test('يوم البدء بتوقيت الجهاز المحلي، ويومٌ محفوظ سابق (أو بصيغةٍ قديمة) لا يمنع البدء', async () => {
  for (const old of [mark(new Date(2026, 10, 3, 23, 59)), deviceDay(TODAY)]) {
    const h = harness({ cap: true, session: memStorage({ fs_track_cap: 'android', fs_track_day: old }) });
    const p = poster(ON);
    await startNativeTracking(p.post, h.env);
    assert.equal(p.calls.length, 1, old);
    h.tap();
    assert.equal(h.day(), '2026-11-04|rep-A');
  }
});

test('أندرويد: لمسة الزرّ وحدها — إيماءةٌ قائمة أو لمسةٌ أخرى (الطباعة، التحصيل) لا تُستعار، ولا يُنتظر إخفاء الصفحة', async () => {
  const h = harness({ cap: true });
  h.app.act = true; // إيماءةٌ حيّة لحظة الردّ (لمسة «طباعة» قبل لحظة) — ليست للبدء
  await startNativeTracking(poster(ON).post, h.env);
  assert.equal(h.app.hrefs.length, 0, 'لا رابط على إيماءةٍ ليست له');
  // الطباعة تفتح التطبيق وتعود: لا أثر على الزرّ
  h.app.hide();
  h.app.show();
  h.app.advance(15_000);
  assert.equal(h.app.hrefs.length, 0);
  assert.equal(h.armed(), 1);
  assert.equal(h.day(), null);
  h.tap();
  assert.deepEqual(h.app.hrefs, [START_URL]);
  assert.equal(h.day(), mark(TODAY));
  assert.equal(h.armed(), 0);
  // بدأ هذا الجهاز: «لا تتبّع» لاحقاً يُرسل الإيقاف
  stopNativeTracking(h.env, { ifStarted: true });
  assert.deepEqual(h.app.hrefs, [START_URL, STOP_URL]);
});

test('زرٌّ معروض: العودة لا تطلب رمزاً ولا زرّاً ثانياً؛ ولمسةٌ بعد منتصف الليل تطلب رمز اليوم الجديد ولا تفتح رابط الأمس', async () => {
  const h = harness({ cap: true });
  const p = poster(ON);
  await startNativeTracking(p.post, h.env);
  await startNativeTracking(p.post, h.env);
  assert.equal(p.calls.length, 1);
  assert.equal(h.armed(), 1);
  h.setNow(new Date(2026, 10, 5, 0, 1));
  h.tap();
  assert.equal(h.app.hrefs.length, 0, 'لا رابط برمز الأمس');
  await until(() => p.calls.length === 2 && h.armed() === 1);
  h.tap();
  assert.deepEqual(h.app.hrefs, [START_URL]);
  assert.equal(h.day(), '2026-11-05|rep-A');
  // عودةٌ في يومٍ جديد والزرّ القديم معروض: يُزال ويُطلب رمزٌ جديد بزرٍّ واحد
  const g = harness({ cap: true });
  const pg = poster(ON);
  await startNativeTracking(pg.post, g.env);
  g.setNow(new Date(2026, 10, 5, 8, 0));
  await startNativeTracking(pg.post, g.env);
  assert.equal(pg.calls.length, 2);
  assert.equal(g.armed(), 1, 'زرٌّ واحد لليوم الجديد');
});

test('جهازٌ مشترك: مندوبٌ آخر في اليوم نفسه (ولو بعد خروجٍ قسريّ بلا إيقاف) يبدأ برمزه — وتجديد الجلسة لا يعيد البدء', async () => {
  const session = memStorage({ fs_track_cap: 'android' });
  const local = memStorage();
  const a = harness({ cap: true, session, local });
  await startNativeTracking(poster(ON).post, a.env);
  a.tap();
  assert.equal(a.day(), mark(TODAY, 'rep-A'));
  // خروجٌ قسريّ (repApi): تُمسح الجلسة وتُحمَّل الصفحة من جديد بلا stopNativeTracking — وsessionStorage باقٍ
  const b = harness({ cap: true, session, local });
  b.login('rep-session-B', 'rep-B');
  const pb = poster(ON);
  await startNativeTracking(pb.post, b.env);
  assert.equal(pb.calls.length, 1, 'رمز المندوب الجديد');
  b.tap();
  assert.deepEqual(b.app.hrefs, [START_URL]);
  assert.equal(b.day(), mark(TODAY, 'rep-B'));
  // تجديد الجلسة للمندوب نفسه (رمز جلسةٍ جديد) لا يطلب رمزاً ولا يُظهر زرّاً
  b.login('rep-session-B2');
  await startNativeTracking(pb.post, b.env);
  assert.equal(pb.calls.length, 1);
  assert.equal(b.armed(), 0);
  // زرٌّ معروضٌ لمندوبٍ تبدّل بلا إيقاف: يُلغى ويُطلب رمز الجديد
  const c = harness({ cap: true });
  const pc = poster(ON);
  await startNativeTracking(pc.post, c.env);
  c.login('rep-session-C', 'rep-C');
  await startNativeTracking(pc.post, c.env);
  assert.equal(pc.calls.length, 2);
  assert.equal(c.armed(), 1);
  // ولمسة زرّ مندوبٍ سابق بعد التبدّل لا تفتح رابطه — يُطلب رمز صاحب الجلسة
  const d = harness({ cap: true });
  const pd = poster(ON);
  await startNativeTracking(pd.post, d.env);
  d.login('rep-session-D', 'rep-D');
  d.tap();
  assert.equal(d.app.hrefs.length, 0, 'لا رابط برمز غيره');
  await until(() => pd.calls.length === 2 && d.armed() === 1);
});

test('بصمة الحضور (أندرويد): لا زرّ — لمسة «تسجيل الحضور» تفتح الرابط داخلها وتعلّم اليوم، والبصمة تنتظر عودة الصفحة', async () => {
  const h = harness({ cap: true, handOff: true });
  await startNativeTracking(poster(PUNCH).post, h.env);
  assert.equal(h.armed(), 0, 'لا زرّ عائم');
  assert.equal(h.app.hrefs.length, 0);
  // لمسة الحضور: الرابط يُفتح متزامناً قبل أيّ انتظار (الإيماءة حيّة)
  let resumed = false;
  const wait = startNativeTrackingOnPunch(h.env).then(() => { resumed = true; });
  assert.deepEqual(h.app.hrefs, [START_URL], 'داخل لمسة الحضور نفسها');
  assert.equal(h.day(), mark(TODAY));
  assert.equal(h.sent(), '1');
  await wait;
  assert.ok(resumed, 'الصفحة عادت فتُكمل البصمة');
  // لمسة الحضور التالية (فترة عمل جديدة) لا تفتح شيئاً، والعودة للتطبيق لا تطلب رمزاً
  await startNativeTrackingOnPunch(h.env);
  assert.deepEqual(h.app.hrefs, [START_URL]);
});

test('بصمة الحضور: الصفحة أُخفيت ولم تعد (شاشة الإفصاح مفتوحة) ⇒ البصمة تُكمل بعد الحدّ الأقصى لا إلى الأبد', async () => {
  const h = harness({ cap: true });
  h.app.onHref = () => h.app.hide();
  await startNativeTracking(poster(PUNCH).post, h.env);
  let resumed = false;
  void startNativeTrackingOnPunch(h.env).then(() => { resumed = true; });
  await tick();
  assert.equal(resumed, false);
  h.app.advance(PUNCH_RETURN_MAX_MS - 1);
  await tick();
  assert.equal(resumed, false, 'ما زالت تنتظر');
  h.app.advance(1);
  await until(() => resumed);
  assert.equal(h.app.listeners(), 0, 'لا مستمع باقٍ');
});

test('بصمة الحضور: لمسةٌ قبل وصول الرمز ⇒ الحضور مضى فيُعرض الزرّ؛ وزرٌّ معروض تبدؤه لمسة الحضور وتُزيله', async () => {
  const h = harness({ cap: true });
  // الرمز في الطريق ولمسة الحضور وقعت: لا رابط (لا رمز بعد)، والردّ waitPunch يعرض الزرّ
  await startNativeTrackingOnPunch(h.env);
  await startNativeTracking(poster(PUNCH).post, h.env);
  assert.equal(h.armed(), 1, 'الزرّ: لا لمسة حضورٍ قادمة اليوم');
  assert.equal(h.app.hrefs.length, 0);
  // والزرّ المعروض تبدؤه لمسة الحضور (فترة جديدة) ويُزال
  void startNativeTrackingOnPunch(h.env);
  assert.deepEqual(h.app.hrefs, [START_URL]);
  assert.equal(h.armed(), 0, 'الزرّ أُزيل');
  h.tap();
  assert.deepEqual(h.app.hrefs, [START_URL], 'لا بدء ثانٍ');
});

test('بصمة الحضور: لمسةٌ بعد منتصف الليل تطلب رمز اليوم الجديد ولا تفتح رابط الأمس؛ وبلا تطبيق لا شيء', async () => {
  const h = harness({ cap: true });
  const p = poster(PUNCH);
  await startNativeTracking(p.post, h.env);
  h.setNow(new Date(2026, 10, 5, 7, 0));
  await startNativeTrackingOnPunch(h.env);
  assert.equal(h.app.hrefs.length, 0, 'لا رابط برمز الأمس');
  await until(() => p.calls.length === 2);
  // بلا تطبيق: تعود فوراً بلا رابط ولا رسالة
  const b = harness();
  await startNativeTrackingOnPunch(b.env);
  await startNativeTrackingOnPunch(null);
  assert.equal(b.app.hrefs.length, 0);
});

test('بصمة الحضور (الآيفون): لا رسالة عند الفتح — رسالة start مع لمسة الحضور ليتّفق الجوالان', async () => {
  const h = harness({ ios: true });
  await startNativeTracking(poster(PUNCH).post, h.env);
  assert.deepEqual(h.iosMsgs, []);
  assert.equal(h.day(), null);
  await startNativeTrackingOnPunch(h.env);
  assert.deepEqual(h.iosMsgs, [{ action: 'start', token: TOKEN }]);
  assert.equal(h.day(), mark(TODAY));
  assert.equal(h.armed(), 0);
});

test('الجهاز يرفع الآن (nativeActive) على أندرويد ⇒ يُعلَّم اليوم بلا زرّ ولا رابط؛ والآيفون يُرسل بلا لمسة كما هو', async () => {
  const h = harness({ cap: true });
  const p = poster(ACTIVE);
  await startNativeTracking(p.post, h.env);
  assert.equal(h.armed(), 0);
  assert.equal(h.app.hrefs.length, 0);
  assert.equal(h.day(), mark(TODAY));
  await startNativeTracking(p.post, h.env);
  assert.equal(p.calls.length, 1, 'اليوم نفسه بلا طلب');
  // الخروج يوقفه: أُعلم اليوم من هذا الجهاز
  stopNativeTracking(h.env);
  assert.deepEqual(h.app.hrefs, [STOP_URL]);
  const i = harness({ ios: true });
  await startNativeTracking(poster(ACTIVE).post, i.env);
  assert.deepEqual(i.iosMsgs, [{ action: 'start', token: TOKEN }]);
});

test('حارس ثابت: لمسة «تسجيل الحضور» تبدأ التتبّع الخلفي قبل أيّ انتظار في البصمة — والانصراف لا', () => {
  const app = read(SRC, 'rep', 'RepApp.tsx');
  const body = app.slice(app.indexOf("const punch = async (kind: 'checkin' | 'checkout') => {"), app.indexOf('const shifts = state ? shiftsOf(state) : [];'));
  const call = body.indexOf("if (kind === 'checkin') await startNativeTrackingOnPunch();");
  assert.ok(call > 0, 'الاستدعاء في البصمة');
  assert.equal(body.slice(0, call).includes('await '), false, 'لا انتظار قبله: الإيماءة حيّة');
  assert.ok(call < body.indexOf('grabLocation()') && call < body.indexOf('precisePunchFix()'), 'قبل قراءة موقع البصمة');
});

test('الآيفون: رسالة start بالرمز ثم stop — بلا روابط ولا زرّ', async () => {
  const h = harness({ ios: true });
  const p = poster(ON);
  await startNativeTracking(p.post, h.env);
  assert.deepEqual(h.iosMsgs, [{ action: 'start', token: TOKEN }]);
  assert.equal(h.armed(), 0);
  assert.equal(h.day(), mark(TODAY));
  await startNativeTracking(p.post, h.env);
  assert.equal(p.calls.length, 1);
  stopNativeTracking(h.env);
  assert.deepEqual(h.iosMsgs[1], { action: 'stop' });
  assert.equal(h.day(), null, 'الإيقاف يمسح يوم البدء');
  assert.equal(h.app.hrefs.length, 0);
  // بعد الإيقاف: الجلسة نفسها لا تبدأ (الخروج جارٍ)، ودخولٌ جديد يبدأ
  await startNativeTracking(p.post, h.env);
  assert.equal(p.calls.length, 1);
  h.login(null);
  await startNativeTracking(p.post, h.env);
  assert.equal(p.calls.length, 1, 'خرج ولم يدخل أحد');
  h.login('rep-session-B', 'rep-B');
  await startNativeTracking(p.post, h.env);
  assert.equal(p.calls.length, 2);
  assert.deepEqual(h.iosMsgs[2], { action: 'start', token: TOKEN });
  assert.equal(h.day(), mark(TODAY, 'rep-B'));
});

test('«لا تتبّع» من الخادم ⇒ إيقاف: على أندرويد بعد بدءٍ سابق وحده (لا وميض عند كل فتح)، وعلى الآيفون دائماً', async () => {
  // بدأ هذا الجهاز من قبل (يومٌ سابق) ثم أطفأت الشركة التتبّع
  const h = harness({ cap: true, local: memStorage({ fs_track_native: '1' }) });
  await startNativeTracking(poster(OFF).post, h.env);
  assert.deepEqual(h.app.hrefs, [STOP_URL]);
  assert.equal(h.armed(), 0);
  assert.equal(h.sent(), null);
  assert.equal(h.day(), null, 'لا يُعلَّم اليوم: تفعيلٌ لاحق يبدأ');
  // لم يبدأ قط: لا رابط
  const h2 = harness({ cap: true });
  await startNativeTracking(poster(OFF).post, h2.env);
  assert.equal(h2.app.hrefs.length, 0);
  stopNativeTracking(h2.env, { ifStarted: true });
  assert.equal(h2.app.hrefs.length, 0);
  // الخروج يوقف دائماً
  stopNativeTracking(h2.env);
  assert.deepEqual(h2.app.hrefs, [STOP_URL]);
  // الآيفون: الرسالة لا تُرى فتُرسل دائماً
  const h3 = harness({ ios: true });
  await startNativeTracking(poster(OFF).post, h3.env);
  assert.deepEqual(h3.iosMsgs, [{ action: 'stop' }]);
});

test('لا رمي أبداً: الشبكة والردّ المختلّ والتخزين المحجوب ومعالجٌ يرمي وزرٌّ يتعذّر عرضه — والفاشل يُعاد في المرّة التالية', async () => {
  const h = harness({ cap: true });
  await assert.doesNotReject(startNativeTracking(poster(new Error('Network Error')).post, h.env));
  assert.equal(h.armed(), 0);
  assert.equal(h.day(), null);
  // الطلب الفاشل لا يُبقي القفل: المحاولة التالية تمضي
  await startNativeTracking(poster(ON).post, h.env);
  h.tap();
  assert.deepEqual(h.app.hrefs, [START_URL]);
  // ردٌّ بلا رمزٍ صالح / بلا جسم / دالةٌ ترمي متزامنةً
  for (const reply of [{ success: true, data: { enabled: true, token: 'not-a-jwt' } }, { success: false }, 'html']) {
    const hx = harness({ cap: true });
    await startNativeTracking(poster(reply).post, hx.env);
    assert.equal(hx.armed(), 0, JSON.stringify(reply));
    assert.equal(hx.app.hrefs.length, 0, JSON.stringify(reply));
  }
  const hy = harness({ cap: true });
  const syncThrow = (() => { throw new Error('boom'); }) as unknown as TrackTokenPost;
  await assert.doesNotReject(startNativeTracking(syncThrow, hy.env));
  const nothing = (async () => undefined) as TrackTokenPost;
  await assert.doesNotReject(startNativeTracking(nothing, hy.env));
  // زرٌّ يتعذّر عرضه: لا رمي ولا انتظارٌ معلّق — العودة التالية تطلب من جديد
  const hz = harness({ cap: true });
  hz.env.askTap = () => { throw new Error('no body'); };
  const pz = poster(ON);
  await assert.doesNotReject(startNativeTracking(pz.post, hz.env));
  await startNativeTracking(pz.post, hz.env);
  assert.equal(pz.calls.length, 2);
  // تخزينٌ محجوب على الآيفون: يبدأ ولا يرمي
  const hi = harness({ ios: true, session: throwingStorage, local: throwingStorage });
  await assert.doesNotReject(startNativeTracking(poster(ON).post, hi.env));
  assert.deepEqual(hi.iosMsgs, [{ action: 'start', token: TOKEN }]);
  assert.doesNotThrow(() => stopNativeTracking(hi.env));
  // معالج الآيفون يرمي
  const ht = harness({ ios: 'throws' });
  await assert.doesNotReject(startNativeTracking(poster(ON).post, ht.env));
  assert.doesNotThrow(() => stopNativeTracking(ht.env));
  assert.doesNotThrow(() => stopNativeTracking(null));
});

test('الإيقاف أثناء طلب الرمز أو والزرّ معروض (خروج المندوب): رمزه لا يُسلَّم والزرّ يُزال، ومن دخل بعده يبدأ', async () => {
  const h = harness({ cap: true });
  let release: (v: { data: unknown }) => void = () => {};
  const calls: unknown[][] = [];
  const post: TrackTokenPost = (...a) => { calls.push(a); return new Promise((r) => { release = r; }); };
  const run = startNativeTracking(post, h.env);
  await until(() => calls.length === 1);
  stopNativeTracking(h.env);
  release({ data: ON });
  await run;
  assert.equal(h.armed(), 0, 'لا زرّ بعد الإيقاف');
  assert.deepEqual(h.app.hrefs, [STOP_URL], 'لا رابط بدء بعد الإيقاف');
  assert.equal(h.day(), null);
  // عادت الصفحة من شاشة التطبيق قبل مسح الجلسة (إنهاء الزيارة/التنبيهات): لا يُعاد التشغيل لمن يخرج
  const again = poster(ON);
  await startNativeTracking(again.post, h.env);
  assert.equal(again.calls.length, 0);
  h.login('rep-session-B'); // دخل مندوبٌ (أو هو نفسه) بجلسةٍ جديدة
  await startNativeTracking(again.post, h.env);
  h.tap();
  assert.deepEqual(h.app.hrefs, [STOP_URL, START_URL]);
  // الإيقاف الهادئ («لا تتبّع») لا يُقفل البدء
  const q = harness({ cap: true });
  stopNativeTracking(q.env, { ifStarted: true });
  await startNativeTracking(poster(ON).post, q.env);
  q.tap();
  assert.deepEqual(q.app.hrefs, [START_URL]);
  // والإيقاف والزرّ معروض يزيله — داخل لمسة «الخروج»
  const g = harness({ cap: true });
  await startNativeTracking(poster(ON).post, g.env);
  assert.equal(g.armed(), 1);
  stopNativeTracking(g.env);
  assert.equal(g.armed(), 0);
  assert.deepEqual(g.app.hrefs, [STOP_URL]);
  assert.equal(g.day(), null);
  g.app.advance(12_000);
  assert.equal(g.app.listeners(), 0, 'لا مستمع باقٍ');
});

test('زرّ البدء في الصفحة: زرٌّ (type=button) بلغة الواجهة فوق الأشرطة السفلية وتحت النوافذ — لمسته تُزيله وتبدأ مرّةً، ومُزيله يكفي', () => {
  interface FakeEl {
    tag: string; type: string; dir: string; innerHTML: string; style: { cssText: string }; attrs: Record<string, string>; removed: boolean;
    setAttribute(k: string, v: string): void; addEventListener(t: string, f: (e: unknown) => void): void; remove(): void; click(): void;
  }
  function fakeDoc(lang: string) {
    const appended: FakeEl[] = [];
    const doc = {
      documentElement: { lang },
      body: { appendChild: (el: FakeEl) => { appended.push(el); return el; } },
      createElement: (tag: string): FakeEl => {
        const ls: Record<string, (e: unknown) => void> = {};
        const el: FakeEl = {
          tag, type: '', dir: '', innerHTML: '', style: { cssText: '' }, attrs: {}, removed: false,
          setAttribute(k, v) { el.attrs[k] = v; },
          addEventListener(t, f) { ls[t] = f; },
          remove() { el.removed = true; },
          click() { ls.click?.({ stopPropagation() {}, preventDefault() {} }); },
        };
        return el;
      },
    };
    return { doc: doc as unknown as Document, appended };
  }
  const ar = fakeDoc('ar');
  let n = 0;
  showStartChip(ar.doc, () => { n += 1; });
  const b = ar.appended[0];
  assert.equal(b.tag, 'button');
  assert.equal(b.type, 'button');
  assert.equal(b.dir, 'rtl');
  assert.ok('data-fs-track-start' in b.attrs);
  assert.match(b.innerHTML, /<span>اضغط لتشغيل تسجيل الموقع<\/span>/);
  assert.match(b.style.cssText, /position:fixed/);
  assert.match(b.style.cssText, /z-index:45/);
  assert.match(b.style.cssText, /safe-area-inset-bottom/);
  b.click();
  b.click();
  assert.equal(n, 1, 'مرّةً واحدة');
  assert.equal(b.removed, true);
  // لغةٌ أخرى، ومُزيلٌ قبل اللمس
  const en = fakeDoc('en-US');
  const remove = showStartChip(en.doc, () => { n += 1; });
  assert.equal(en.appended[0].dir, 'ltr');
  assert.match(en.appended[0].innerHTML, /<span>Tap to start location recording<\/span>/);
  remove();
  en.appended[0].click();
  assert.equal(n, 1, 'أُزيل قبل لمسه');
  assert.equal(en.appended[0].removed, true);
  // لغةٌ لا نصّ لها ⇒ العربية
  const xx = fakeDoc('xx');
  showStartChip(xx.doc, () => {});
  assert.match(xx.appended[0].innerHTML, /اضغط لتشغيل تسجيل الموقع/);
});

// ─── حرّاس ثابتة ───
const SRC = fileURLToPath(new URL('../', import.meta.url));
const ROOT = path.join(SRC, '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n');

test('TrackContract.kt = nativeTracking.ts: المخطّط والمضيفان والمعاملات ومعامل الإقلاع وعنوان الرفع', () => {
  const ktPath = path.join(ROOT, 'android-rep', 'app', 'src', 'main', 'java', 'net', 'fieldsa', 'twa', 'track', 'TrackContract.kt');
  // الفرع يشحن الطرفين معاً: صفحةٌ تفتح fieldsatrack:// بلا TrackActivity في التطبيق لا تتتبّع شيئاً
  assert.ok(fs.existsSync(ktPath), `غائب: ${ktPath} — جزء أندرويد من عقد التتبّع الخلفي (TRACK_CONTRACT) لم يُضَف بعد`);
  const kt = read(ktPath).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const got = new Map<string, string | number>();
  for (const m of kt.matchAll(/const val (\w+)\s*(?::\s*\w+)?\s*=\s*("([^"]*)"|[\d_]+L?)/g)) {
    got.set(m[1], m[3] !== undefined ? m[3] : Number(m[2].replace(/[_L]/g, '')));
  }
  // الأسماء مرنةٌ قليلاً (TRACK_ اختياريّة، والمعامل قبل اسمه أو بعده) — والقيمة حرفية
  const want: Array<[string, RegExp, string]> = [
    ['المخطّط', /^(TRACK_)?SCHEME$/, TRACK_SCHEME],
    ['مضيف البدء', /^(TRACK_)?(HOST_START|START_HOST)$/, TRACK_HOST_START],
    ['مضيف الإيقاف', /^(TRACK_)?(HOST_STOP|STOP_HOST)$/, TRACK_HOST_STOP],
    ['معامل الرمز', /^(TRACK_)?(PARAM_TOKEN|TOKEN_PARAM)$/, TRACK_PARAM_TOKEN],
    ['معامل عنوان التطوير', /^(TRACK_)?(PARAM_(DEBUG_)?(URL|ENDPOINT)(_OVERRIDE)?|(DEBUG_)?(URL|ENDPOINT)(_OVERRIDE)?_PARAM)$/, TRACK_PARAM_DEBUG_URL],
    ['معامل الإقلاع', /^(TRACK_)?(LAUNCH_PARAM|PARAM_LAUNCH)(_NAME)?$/, TRACK_LAUNCH_PARAM],
    ['عنوان الرفع', /^(TRACK_)?PING_(URL|ENDPOINT)$/, TRACK_PING_URL],
  ];
  for (const [label, name, value] of want) {
    const hits = [...got.entries()].filter(([k]) => name.test(k));
    assert.ok(hits.length > 0, `TrackContract.kt بلا ثابت ${label} (${name})`);
    // معامل الإقلاع قد يُكتب بقيمته («fstrack=1»)
    for (const [k, v] of hits) assert.ok(v === value || (label === 'معامل الإقلاع' && v === `${value}=${TRACK_LAUNCH_VALUE}`), `TrackContract.${k} = ${String(v)}`);
  }
  // قيمة معامل الإقلاع: ثابتٌ مستقلّ إن وُجد
  for (const [k, v] of got) if (/^(TRACK_)?LAUNCH_VALUE$/.test(k)) assert.equal(v, TRACK_LAUNCH_VALUE, `TrackContract.${k}`);
  // ثوابت الويب نفسها متّسقة
  assert.equal(TRACK_LAUNCH_PARAM, 'fstrack');
  assert.equal(TRACK_LAUNCH_VALUE, '1');
  assert.equal(IOS_TRACK_HANDLER, 'fsTrack');
  assert.equal(TRACK_PING_URL, 'https://api.fieldsa.net/api/track-device/ping');
});

test('حارس ثابت: main.tsx يلتقط fstrack بعد markAppLaunch وقبل جسر الطباعة وأوّل رسم', () => {
  const s = read(SRC, 'main.tsx');
  assert.match(s, /import \{ captureTrackLaunch \} from '\.\/rep\/nativeTracking';/);
  const mark = s.indexOf('\nmarkAppLaunch();');
  const cap = s.indexOf('\ncaptureTrackLaunch();');
  const bridge = s.indexOf('\ncaptureBridgeLaunch();');
  assert.ok(mark > 0 && mark < cap && cap < bridge && bridge < s.indexOf('ReactDOM.createRoot('));
  // nativeTracking لا يستورد repApi (حزمة الإقلاع خفيفة، ويُختبر في node:test)، ولا يعدّل جسر الطباعة
  const src = read(SRC, 'rep', 'nativeTracking.ts');
  assert.doesNotMatch(src, /from '\.\/repApi'/);
  assert.match(src, /import \{ browserAppEnv, launchIntent, type AppEnv \} from '\.\.\/lib\/print\/transport\/appBridge';/);
  assert.doesNotMatch(src, /BridgeFlag/);
  // البيئة الحقيقية: المندوب من rep_user، والبدء بزرّه وحده — لا تُعلَّق على لمسات الصفحة ولا على إيماءةٍ قائمة
  assert.match(src, /window\.localStorage\.getItem\('rep_user'\)/);
  assert.match(src, /askTap: \(f\) => showStartChip\(document, f\),/);
  assert.doesNotMatch(src, /addEventListener\('click', [^)]*capture/);
  assert.doesNotMatch(src, /\.activation\(\)/);
});

test('حارس ثابت: useRepTracking يبدأ بعد حكم التفعيل ويوقف هادئاً عند الحكم القاطع بالإطفاء، والعودة تبدأ يوماً جديداً', () => {
  const t = read(SRC, 'rep', 'useRepTracking.ts');
  assert.match(t, /import \{ startNativeTracking, stopNativeTracking, type TrackTokenPost \} from '\.\/nativeTracking';/);
  assert.match(t, /const postTrackToken: TrackTokenPost = \(url, body, config\) => repApi\.post\(url, body, config\);/);
  const start = t.slice(t.indexOf('const start = async () => {'), t.indexOf('start();'));
  assert.match(start, /\.data\.data\.enabled; known = true; \} catch/);
  assert.match(start, /if \(!cancelled && known\) stopNativeTracking\(undefined, \{ ifStarted: true \}\);\s*return;\s*\}/);
  // البدء بعد الحكم وقبل فحص geolocation في الصفحة (التطبيق يتتبّع ولو غاب موقع المتصفح)
  const on = start.indexOf('nativeOn = true;\n      void startNativeTracking(postTrackToken);');
  assert.ok(on > start.indexOf('if (cancelled || !enabled) {') && on < start.indexOf("if (!('geolocation' in navigator))"));
  const vis = t.slice(t.indexOf('const onVisibility = () => {'), t.indexOf('const onOnline'));
  assert.match(vis, /if \(document\.hidden\) \{ flush\(true\); return; \}[\s\S]*if \(nativeOn\) void startNativeTracking\(postTrackToken\);/);
});

test('حارس ثابت: الخروج يوقف التتبّع الخلفي أوّلاً — داخل لمسة الخروج وقبل مسح الجلسة', () => {
  const app = read(SRC, 'rep', 'RepApp.tsx');
  assert.match(app, /import \{ startNativeTrackingOnPunch, stopNativeTracking \} from '\.\/nativeTracking';/);
  const body = app.slice(app.indexOf('const logout = async () => {'), app.indexOf('setToken(null); setUser(null);', app.indexOf('const logout = async () => {')));
  assert.match(body, /^const logout = async \(\) => \{\n\s*\/\/[^\n]*\n\s*stopNativeTracking\(\);\n/);
  assert.ok(body.indexOf('stopNativeTracking();') < body.indexOf("localStorage.removeItem('rep_token')"));
});
