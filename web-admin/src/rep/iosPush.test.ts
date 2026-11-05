// تنبيهات الآيفون في تطبيق فيلد سيلز الأصلي (جسر fsPush ⇒ APNs، ٤ نوفمبر ٢٠٢٦): كشف الجسر، والرسائل المرسلة حرفياً، وتطبيع
// كل ردٍّ وحدث (الخارج عن العقد لا يمرّ)، والشاشة التي يفتحها الحدث، وحالة البطاقة — بنوافذ مزيّفة بلا DOM. ثمّ حرّاس التوصيل
// في pushAlerts وpushKey وRepApp وPresenceCheck: ما يُشحن هو ما يُختبر، وبلا الجسر يبقى أندرويد والويب كما هما.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APNS_TOKEN_RE, IOS_PUSH_APP_RELEASED, IOS_PUSH_EVENT, IOS_PUSH_HANDLER, IOS_PUSH_MARKER, IOS_PUSH_TIMEOUT_MS, IOS_PUSH_VERSION,
  PUSH_APNS_KEY, apnsEndpointOf, iosPushAvailable, iosPushClear, iosPushClearAll, iosPushEventDetail, iosPushReady,
  iosPushRegister, iosPushScreen, iosPushStateOf, iosPushStatus, type IosPushEvent, type IosPushStatus,
} from './iosPush';
import { unsubscribeLocalPush, PUSH_OWNER_KEY } from './pushKey';

const SRC = fileURLToPath(new URL('../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

type Obj = Record<string, unknown>;
type Reply = unknown | ((msg: Obj) => unknown);
const TOKEN = 'a1'.repeat(32);
const TOKEN_LONG = '0f'.repeat(100);
const MARKER = Object.freeze({ v: 1, caps: Object.freeze(['status', 'register', 'clear', 'ready']) });
/** نافذةٌ بلا علامةٍ أصلاً (تطبيقٌ بالمعالج وحده) */
const NO_MARKER = Symbol('no-marker');

/** نافذة تطبيقٍ مزيّفة: الردّ لكل op (قيمة، أو دالة، وError يُرفض به الوعد)، والرسائل المرسلة، وهل نودي المعالج بـthis */
function fakeWin(replies: Record<string, Reply> = {}, marker: unknown = MARKER) {
  const posted: Obj[] = [];
  const asMethod: boolean[] = [];
  const handler = {
    postMessage(this: unknown, msg: Obj): Promise<unknown> {
      asMethod.push(this === handler);
      posted.push(msg);
      const r = replies[msg.op as string];
      let v: unknown;
      try { v = typeof r === 'function' ? (r as (m: Obj) => unknown)(msg) : r; } catch (e) { return Promise.reject(e); }
      if (v instanceof Error) return Promise.reject(v);
      return Promise.resolve(v);
    },
  };
  const w: Obj = { webkit: { messageHandlers: { [IOS_PUSH_HANDLER]: handler, fsPrint: { postMessage: () => Promise.resolve(null) } } } };
  if (marker !== NO_MARKER) w[IOS_PUSH_MARKER] = marker;
  return { w, posted, asMethod, handler };
}
const never = () => new Promise(() => undefined);
const ev = (over: Obj = {}): Obj => ({ v: 1, kind: 'open', id: 'open:req-1:1730700000000', tag: 'presence', checkId: 'c1', url: '/rep?screen=presence', at: 1730700000000, ...over });

/* ─── الثوابت والكشف ─────────────────────────────────────────────────────────── */

test('ثوابت العقد v1 حرفياً — والدعوة «حدّث التطبيق» مطفأة حتى يصدر الإصدار', () => {
  assert.equal(IOS_PUSH_HANDLER, 'fsPush');
  assert.equal(IOS_PUSH_MARKER, '__fsIosPush');
  assert.equal(IOS_PUSH_VERSION, 1);
  assert.equal(IOS_PUSH_EVENT, 'fs-ios-push');
  assert.equal(IOS_PUSH_TIMEOUT_MS, 5000);
  assert.equal(PUSH_APNS_KEY, 'fs_push_apns');
  assert.equal(IOS_PUSH_APP_RELEASED, false);
  assert.equal(String(APNS_TOKEN_RE), String(/^(?:[0-9a-f]{2}){32,100}$/));
  assert.ok(APNS_TOKEN_RE.test(TOKEN) && APNS_TOKEN_RE.test(TOKEN_LONG));
  for (const bad of ['a1'.repeat(31), 'a1'.repeat(101), 'A1'.repeat(32), 'a'.repeat(65), 'g1'.repeat(32), `${TOKEN}:`, `${TOKEN}/x`, '']) {
    assert.equal(APNS_TOKEN_RE.test(bad), false, bad);
  }
});

test('iosPushAvailable: المعالج بدالة postMessage والعلامة v صحيحةٌ ≥ 1 معاً — وما سوى ذلك لا', () => {
  assert.equal(iosPushAvailable(fakeWin().w), true, 'المعالج والعلامة');
  assert.equal(iosPushAvailable(fakeWin({}, { v: 2, caps: [] }).w), true, 'إصدارٌ أحدث');
  assert.equal(iosPushAvailable(fakeWin({}, NO_MARKER).w), false, 'المعالج وحده (تطبيقٌ بلا العلامة)');
  assert.equal(iosPushAvailable({ [IOS_PUSH_MARKER]: MARKER }), false, 'العلامة وحدها');
  assert.equal(iosPushAvailable({ webkit: { messageHandlers: { fsPush: { postMessage: 'x' } } }, [IOS_PUSH_MARKER]: MARKER }), false, 'postMessage ليست دالة');
  assert.equal(iosPushAvailable({ webkit: { messageHandlers: { fsPush: () => null } }, [IOS_PUSH_MARKER]: MARKER }), false, 'المعالج دالة لا كائن');
  assert.equal(iosPushAvailable({ webkit: { messageHandlers: { fsPrint: { postMessage: () => null } } }, [IOS_PUSH_MARKER]: MARKER }), false, 'جسر الطباعة وحده');
  for (const v of [0, 1.5, '1', null, -1, Number.NaN]) assert.equal(iosPushAvailable(fakeWin({}, { v, caps: [] }).w), false, `v=${String(v)}`);
  assert.equal(iosPushAvailable(fakeWin({}, null).w), false, 'علامة null');
  assert.equal(iosPushAvailable(undefined), false, 'بلا نافذة');
  assert.equal(iosPushAvailable(), false, 'Node: لا window — ولا وصول عند التحميل');
  const throwing = Object.defineProperty({}, 'webkit', { get() { throw new Error('boom'); } });
  assert.equal(iosPushAvailable(throwing), false, 'نافذةٌ ترمي لا تُسقط الصفحة');
});

/* ─── status ─────────────────────────────────────────────────────────────────── */

test('iosPushStatus: يرسل {op:status} على المعالج نفسه، ويطبّع الردّ — والخارج عن العقد null', async () => {
  const ok = { ok: true, v: 1, perm: 'granted', token: TOKEN, env: 'production', error: null };
  const f = fakeWin({ status: ok });
  assert.deepEqual(await iosPushStatus(f.w), { perm: 'granted', token: TOKEN, env: 'production', error: null });
  assert.deepEqual(f.posted, [{ op: 'status' }]);
  assert.deepEqual(f.asMethod, [true], 'WebKit يرفض postMessage المفصولة');
  const st = (r: unknown) => iosPushStatus(fakeWin({ status: r }).w);
  assert.deepEqual(await st({ ...ok, perm: 'default', token: null, env: 'sandbox', error: 'apns_3000' }), { perm: 'default', token: null, env: 'sandbox', error: 'apns_3000' });
  assert.deepEqual(await st({ ...ok, perm: 'denied', token: TOKEN_LONG }), { perm: 'denied', token: TOKEN_LONG, env: 'production', error: null });
  assert.equal(await st({ ...ok, perm: 'provisional' }), null, 'perm خارج التعداد');
  assert.equal(await st({ ...ok, perm: undefined }), null);
  assert.equal(await st({ ...ok, env: 'development' }), null, 'env خارج التعداد');
  assert.equal(await st({ ...ok, env: undefined }), null);
  assert.equal(await st({ ...ok, ok: false }), null);
  assert.equal(await st(null), null);
  assert.equal(await st([ok]), null);
  for (const t of ['ABC', 'A1'.repeat(32), 'a1'.repeat(31), 42, `${TOKEN}\n`]) assert.equal((await st({ ...ok, token: t }))?.token, null, `رمزٌ غير صالح ⇒ null: ${String(t)}`);
  assert.equal((await st({ ...ok, error: 'x'.repeat(10) }))?.error, null, 'خطأٌ بلا بادئة apns_');
  assert.equal((await st({ ...ok, error: 'apns_-1001' }))?.error, 'apns_-1001');
  assert.equal(await st(new Error('forbidden')), null, 'الرفض ⇒ null');
});

test('iosPushStatus: وعدٌ لا يُحلّ ⇒ null بعد المهلة المحقونة — وبلا جسرٍ لا رسالة أصلاً', async () => {
  const f = fakeWin({ status: never });
  const t0 = Date.now();
  assert.equal(await iosPushStatus(f.w, 20), null);
  assert.ok(Date.now() - t0 < 1000, 'لا يعلق');
  assert.deepEqual(f.posted, [{ op: 'status' }]);
  const noMarker = fakeWin({ status: { ok: true, perm: 'granted', token: TOKEN, env: 'production', error: null } }, NO_MARKER);
  assert.equal(await iosPushStatus(noMarker.w), null);
  assert.deepEqual(noMarker.posted, [], 'بلا علامةٍ لا نداء');
  assert.equal(await iosPushStatus(undefined), null);
});

/* ─── register ───────────────────────────────────────────────────────────────── */

test('iosPushRegister: {op:register} بلا مهلة من الصفحة، والرموز denied/unavailable/timeout كما هي، وما سواها failed', async () => {
  const f = fakeWin({ register: { ok: true, perm: 'granted', token: TOKEN, env: 'sandbox' } });
  assert.deepEqual(await iosPushRegister(f.w), { ok: true, token: TOKEN, env: 'sandbox' });
  assert.deepEqual(f.posted, [{ op: 'register' }]);
  assert.deepEqual(f.asMethod, [true]);
  const reg = (r: unknown) => iosPushRegister(fakeWin({ register: r }).w);
  assert.deepEqual(await reg({ ok: true, perm: 'granted', token: 'A1'.repeat(32), env: 'production' }), { ok: false, code: 'bad_reply' }, 'رمزٌ كبير الحروف');
  assert.deepEqual(await reg({ ok: true, perm: 'granted', token: TOKEN, env: 'development' }), { ok: false, code: 'bad_reply' }, 'بيئةٌ خارج العقد');
  assert.deepEqual(await reg({ ok: true, perm: 'granted', env: 'production' }), { ok: false, code: 'bad_reply' }, 'بلا رمز');
  for (const code of ['denied', 'unavailable', 'timeout'] as const) {
    assert.deepEqual(await reg({ ok: false, code, perm: code === 'denied' ? 'denied' : 'granted', detail: 'apns_3000' }), { ok: false, code });
  }
  assert.deepEqual(await reg({ ok: false, code: 'failed' }), { ok: false, code: 'failed' });
  assert.deepEqual(await reg({ ok: false, code: 'weird' }), { ok: false, code: 'failed' }, 'رمزٌ لا يُعرف');
  assert.deepEqual(await reg({ ok: false, code: 'bad_reply' }), { ok: false, code: 'failed' }, 'bad_reply حكم الصفحة لا التطبيق');
  assert.deepEqual(await reg(undefined), { ok: false, code: 'failed' });
  assert.deepEqual(await reg(new Error('forbidden')), { ok: false, code: 'failed' }, 'الرفض ⇒ failed');
  assert.deepEqual(await iosPushRegister(undefined), { ok: false, code: 'failed' }, 'بلا جسر');
  // بلا مهلةٍ من الصفحة: نافذة الإذن تنتظر المندوب — الوعد يبقى معلّقاً ما بعد مهلة النداءات الأخرى
  let release: (v: unknown) => void = () => undefined;
  const slow = fakeWin({ register: () => new Promise((r) => { release = r; }) });
  let settled = false;
  const p = iosPushRegister(slow.w).then((r) => { settled = true; return r; });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(settled, false);
  release({ ok: false, code: 'denied', perm: 'denied' });
  assert.deepEqual(await p, { ok: false, code: 'denied' });
});

/* ─── clear ──────────────────────────────────────────────────────────────────── */

test('iosPushClear وiosPushClearAll: الرسالة حرفياً، والرفض والمهلة يُبتلعان، وما يرفضه التطبيق لا يُرسل', async () => {
  const f = fakeWin({ clear: { ok: true, removed: 1 } });
  await iosPushClear('presence', 'c1', f.w);
  await iosPushClear('presence', null, f.w);
  await iosPushClearAll(f.w);
  assert.deepEqual(f.posted, [
    { op: 'clear', tag: 'presence', checkId: 'c1' },
    { op: 'clear', tag: 'presence', checkId: null },
    { op: 'clear', all: true },
  ]);
  assert.deepEqual(f.asMethod, [true, true, true]);
  const rej = fakeWin({ clear: new Error('forbidden') });
  await assert.doesNotReject(iosPushClear('presence', 'c1', rej.w));
  await assert.doesNotReject(iosPushClearAll(rej.w));
  const thrower = fakeWin({ clear: () => { throw new Error('sync'); } });
  await assert.doesNotReject(iosPushClearAll(thrower.w));
  const hang = fakeWin({ clear: never });
  const t0 = Date.now();
  await iosPushClear('presence', 'c1', hang.w, 20);
  await iosPushClearAll(hang.w, 20);
  assert.ok(Date.now() - t0 < 1000, 'المهلة تحدّه');
  const bad = fakeWin({ clear: { ok: true, removed: 0 } });
  await iosPushClear('bad tag', 'c1', bad.w);
  await iosPushClear('presence', 'c/1', bad.w);
  await iosPushClear('x'.repeat(65), null, bad.w);
  assert.deepEqual(bad.posted, [], 'وسمٌ أو معرّفٌ خارج /^[A-Za-z0-9_-]{1,64}$/ لا يُرسل — ولا يصير null فيمسح طلباً أحدث');
  await assert.doesNotReject(iosPushClear('presence', 'c1', undefined));
  await assert.doesNotReject(iosPushClearAll(undefined));
});

/* ─── الأحداث وready ─────────────────────────────────────────────────────────── */

test('iosPushEventDetail: مفاتيح العقد وحدها، والنوع والمعرّف والوسم والوقت بشروطها، والرابط داخل /rep وإلا ‎/rep', () => {
  const det = (detail: unknown) => iosPushEventDetail(new CustomEvent(IOS_PUSH_EVENT, { detail }));
  assert.deepEqual(det({ ...ev(), extra: 'x', token: TOKEN, __proto__x: 1 }), {
    kind: 'open', id: 'open:req-1:1730700000000', tag: 'presence', checkId: 'c1', url: '/rep?screen=presence', at: 1730700000000,
  });
  const r = det(ev({ kind: 'receive', tag: 'att-PRE_SHIFT', checkId: null, url: '/rep?screen=attendance' }));
  assert.deepEqual(r, { kind: 'receive', id: 'open:req-1:1730700000000', tag: 'att-PRE_SHIFT', checkId: null, url: '/rep?screen=attendance', at: 1730700000000 });
  assert.deepEqual(det(ev({ kind: 'token', id: 'token:1730700000000', tag: 'presence', checkId: 'c1', url: '/rep?screen=presence' })),
    { kind: 'token', id: 'token:1730700000000', tag: null, checkId: null, url: null, at: 1730700000000 }, 'token بلا وسمٍ ولا رابط');
  assert.equal(det(ev({ kind: 'push' })), null, 'نوعٌ خارج التعداد');
  assert.equal(det(ev({ kind: undefined })), null);
  assert.equal(det(ev({ v: 2 })), null, 'إصدارٌ آخر');
  assert.equal(det(ev({ v: undefined })), null);
  assert.equal(det(ev({ id: '' })), null);
  assert.equal(det(ev({ id: 'x'.repeat(129) })), null);
  assert.ok(det(ev({ id: 'x'.repeat(128) })));
  assert.equal(det(ev({ id: 7 })), null);
  assert.equal(det(ev({ at: Number.NaN })), null);
  assert.equal(det(ev({ at: Number.POSITIVE_INFINITY })), null);
  assert.equal(det(ev({ at: '1730700000000' })), null);
  assert.equal(det(ev({ tag: 'bad tag' })), null, 'وسمٌ غير صالح');
  assert.equal(det(ev({ tag: 'x'.repeat(65) })), null);
  assert.equal(det(ev({ tag: undefined }))?.tag, null, 'بلا وسم ⇒ null');
  assert.equal(det(ev({ checkId: '../x' }))?.checkId, null, 'معرّفٌ غير صالح ⇒ null');
  assert.equal(det(ev({ checkId: 5 }))?.checkId, null);
  // الرابط: داخل التطبيق وحده
  const url = (u: unknown) => det(ev({ url: u }))?.url;
  assert.equal(url('/rep'), '/rep');
  assert.equal(url('/rep?screen=attendance'), '/rep?screen=attendance');
  assert.equal(url('/rep/x?screen=presence'), '/rep/x?screen=presence');
  assert.equal(url(null), null);
  assert.equal(url(undefined), null);
  for (const evil of ['https://evil/x', '//evil/rep', '/rep//evil', 'https://fieldsa.net/rep', '/repx', '/app', 'javascript:alert(1)',
    '/rep\\evil', '', 7, `/rep?${'a'.repeat(2050)}`, ' /rep']) {
    assert.equal(url(evil), '/rep', `رابطٌ غريب ⇒ ‎/rep: ${String(evil).slice(0, 30)}`);
  }
  assert.equal(iosPushEventDetail(new Event(IOS_PUSH_EVENT)), null, 'حدثٌ بلا detail');
  assert.equal(det(null), null);
  assert.equal(det('open'), null);
  assert.equal(det([ev()]), null);
});

test('iosPushReady: {op:ready} بعد المستمع، والصالح وحده — و[] لغير المصفوفة والرفض والمهلة وبلا جسر', async () => {
  const good = ev({ kind: 'open', id: 'open:a:1' });
  const good2 = ev({ kind: 'receive', id: 'receive:b:2', url: 'https://evil/x' });
  const f = fakeWin({ ready: { ok: true, events: [good, { ...good, kind: 'bad' }, null, 'x', good2, { ...good, v: 9 }] } });
  const out = await iosPushReady(f.w);
  assert.deepEqual(f.posted, [{ op: 'ready' }]);
  assert.deepEqual(f.asMethod, [true]);
  assert.deepEqual(out.map((e) => e.id), ['open:a:1', 'receive:b:2']);
  assert.equal(out[1].url, '/rep', 'المعقّم نفسه');
  const many = Array.from({ length: 15 }, (_, i) => ev({ id: `open:${i}:1` }));
  assert.equal((await iosPushReady(fakeWin({ ready: { ok: true, events: many } }).w)).length, 10, 'سقف الطابور');
  const rd = (r: unknown) => iosPushReady(fakeWin({ ready: r }).w);
  assert.deepEqual(await rd({ ok: true, events: { 0: good } }), []);
  assert.deepEqual(await rd({ ok: true }), []);
  assert.deepEqual(await rd({ ok: false, events: [good] }), []);
  assert.deepEqual(await rd(null), []);
  assert.deepEqual(await rd(new Error('forbidden')), []);
  assert.deepEqual(await iosPushReady(fakeWin({ ready: never }).w, 20), []);
  assert.deepEqual(await iosPushReady(undefined), []);
  const noMarker = fakeWin({ ready: { ok: true, events: [good] } }, NO_MARKER);
  assert.deepEqual(await iosPushReady(noMarker.w), []);
  assert.deepEqual(noMarker.posted, []);
});

test('iosPushScreen: الوصول والتطبيق ظاهر يفتح «أثبت تواجدك» وحده، واللمس يفتح شاشة رابطه، وتغيّر الرمز لا شاشة', () => {
  const e = (over: Partial<IosPushEvent>): IosPushEvent => ({ kind: 'open', id: 'i', tag: null, checkId: null, url: null, at: 1, ...over });
  assert.equal(iosPushScreen(e({ kind: 'receive', tag: 'presence', url: '/rep?screen=presence' })), 'presence');
  assert.equal(iosPushScreen(e({ kind: 'receive', tag: 'att-PRE_SHIFT', url: '/rep?screen=attendance' })), null, 'تنبيه الحضور والتطبيق ظاهر: لا ينقله');
  assert.equal(iosPushScreen(e({ kind: 'receive', tag: null })), null);
  assert.equal(iosPushScreen(e({ kind: 'open', tag: 'presence', url: '/rep?screen=presence' })), 'presence');
  assert.equal(iosPushScreen(e({ kind: 'open', tag: 'att-FORGOT_CHECKOUT', url: '/rep?screen=attendance' })), 'attendance');
  assert.equal(iosPushScreen(e({ kind: 'open', url: '/rep?x=1&screen=attendance' })), 'attendance');
  assert.equal(iosPushScreen(e({ kind: 'open', url: '/rep?screen=home' })), null);
  assert.equal(iosPushScreen(e({ kind: 'open', url: '/rep' })), null);
  assert.equal(iosPushScreen(e({ kind: 'open', url: null })), null);
  assert.equal(iosPushScreen(e({ kind: 'token', tag: 'presence', url: '/rep?screen=presence' })), null);
});

test('iosPushStateOf: بلا جسرٍ «غير مدعوم»، والرفض «مرفوضة»، و«مفعّلة» بإذنٍ ورمزٍ محفوظٍ لهذا المندوب نفسه', () => {
  const st = (perm: IosPushStatus['perm'], token: string | null = TOKEN): IosPushStatus => ({ perm, token, env: 'production', error: null });
  assert.equal(iosPushStateOf(null, 'r1', 'r1'), 'unsupported');
  assert.equal(iosPushStateOf(st('denied'), 'r1', 'r1'), 'denied');
  assert.equal(iosPushStateOf(st('granted'), 'r1', 'r1'), 'on');
  assert.equal(iosPushStateOf(st('granted', null), 'r1', 'r1'), 'on', 'الرمز يصل بعد الإقلاع — صاحبه محفوظ');
  assert.equal(iosPushStateOf(st('granted'), 'r2', 'r1'), 'off', 'محفوظٌ لمندوبٍ قبله على الجوال');
  assert.equal(iosPushStateOf(st('granted'), null, 'r1'), 'off');
  assert.equal(iosPushStateOf(st('granted'), null, null), 'off');
  assert.equal(iosPushStateOf(st('granted'), '', ''), 'off');
  assert.equal(iosPushStateOf(st('default'), 'r1', 'r1'), 'off');
});

test('apnsEndpointOf: عنوان الاشتراك كما يخزّنه الخادم', () => {
  assert.equal(apnsEndpointOf('production', TOKEN), `apns:production:${TOKEN}`);
  assert.equal(apnsEndpointOf('sandbox', TOKEN_LONG), `apns:sandbox:${TOKEN_LONG}`);
});

test('unsubscribeLocalPush (الخروج القسري ودخول حسابٍ آخر) يمسح درج تطبيق الآيفون — وبلا الجسر لا نداء', async () => {
  const g = globalThis as { window?: unknown };
  const had = 'window' in g;
  const prev = g.window;
  const f = fakeWin({ clear: { ok: true, removed: 2 } });
  try {
    g.window = f.w;
    await unsubscribeLocalPush(500);
    assert.deepEqual(f.posted, [{ op: 'clear', all: true }]);
    g.window = fakeWin({}, NO_MARKER).w;
    await unsubscribeLocalPush(500);
    assert.equal(f.posted.length, 1);
  } finally {
    if (had) g.window = prev; else delete g.window;
  }
  assert.equal(PUSH_OWNER_KEY, 'fs_push_rep');
});

/* ─── حرّاس التوصيل ─────────────────────────────────────────────────────────── */

/** جسم الدالة من توقيعها إلى أوّل «\n}\n» */
const fnSlice = (src: string, sig: string) => {
  const at = src.indexOf(sig);
  assert.ok(at >= 0, `غائبة: ${sig}`);
  const end = src.indexOf('\n}\n', at);
  assert.ok(end > at, sig);
  return src.slice(at, end + 2);
};

test('حارس ثابت: iosPush.ts نقيّ — لا repApi ولا React ولا ترجمة، ولا ذكر للتحصيل بالبطاقة', () => {
  const s = read('rep/iosPush.ts');
  assert.doesNotMatch(s, /from '\.\/repApi'|from 'react'|from '\.\.\/i18n/);
  assert.doesNotMatch(s, /^import /m, 'لا استيراد أصلاً');
  assert.doesNotMatch(s, /cardpay|card-pay|cardPay|fsCardPay/i);
  assert.match(s, /export const IOS_PUSH_APP_RELEASED = false;/);
});

test('حارس ثابت: pushAlerts — فرع الآيفون أوّلاً في كل مدخل، وبلا الجسر يبقى مسار الويب حرفياً', () => {
  const s = read('rep/pushAlerts.ts');
  assert.match(s, /export type PushState = 'unsupported' \| 'ios-install' \| 'ios-update' \| 'denied' \| 'off' \| 'on';/);
  assert.match(s, /const tr = \(ar: string\): string => \{ const l = lang\(\); return l === 'ar' \? ar : \(PHRASES\[ar\]\?\.\[l\] \?\? ar\); \};/);
  assert.match(s, /import \{ isIosWrapper \} from '\.\.\/lib\/print\/transport\/iosBridge';/);
  // pushState: الجسر ⇒ حالته؛ تطبيق 1.1.0 بلا الجسر ⇒ لا «أضف إلى الشاشة الرئيسية»؛ ثمّ سطر الويب كما كان
  const st = fnSlice(s, 'export async function pushState(');
  assert.match(st, /^export async function pushState\(\): Promise<PushState> \{\n {2}if \(iosPushAvailable\(\)\) return iosPushStateOf\(await iosPushStatus\(\), pushOwner\(\), currentRepId\(\)\);/);
  assert.ok(st.indexOf('iosPushAvailable()') < st.indexOf('isIosWrapper(') && st.indexOf('isIosWrapper(') < st.indexOf("'ios-install'"));
  assert.match(st, /return IOS_PUSH_APP_RELEASED \? 'ios-update' : 'unsupported';\n {4}return isIos\(\) && !standalone\(\) \? 'ios-install' : 'unsupported';/);
  // enablePush: فرع الآيفون قبل إذن الويب
  const en = fnSlice(s, 'export async function enablePush(');
  assert.match(en, /^export async function enablePush\(\): Promise<PushState> \{\n {2}if \(iosPushAvailable\(\)\) return enableIosPush\(\);\n {2}if \(!supported\(\)\) return pushState\(\);/);
  assert.ok(en.indexOf('enableIosPush()') < en.indexOf('Notification.requestPermission()'));
  // saveIos: الحفظ بـ/push/apns، و«مفعّلة» بعد active وحدها
  const sv = fnSlice(s, 'async function saveIos(');
  assert.match(sv, /repApi\.post\('\/tracking\/push\/apns', \{/);
  assert.match(sv, /localStorage\.setItem\(PUSH_APNS_KEY, d\.endpoint\)/);
  assert.ok(sv.indexOf('if (d?.active !== true)') < sv.indexOf('localStorage.setItem(PUSH_OWNER_KEY'), 'لا «مفعّلة» قبل active');
  assert.match(sv, /throw userError\(tr\('تنبيهات آيفون غير متاحة الآن حاول لاحقا'\)\);/);
  const ei = fnSlice(s, 'async function enableIosPush(');
  assert.match(ei, /if \(r\.code === 'denied'\) return 'denied';\n {4}throw new Error\('ios-push ' \+ r\.code\);/);
  // saveIos: المندوب وجلسته قبل الطلب، وعلامات الجهاز لا تُكتب لجلسةٍ انتهت في أثنائه، وصفّها المتأخّر يُحذف بجلستها
  assert.ok(sv.indexOf('const epoch = iosEpoch;') < sv.indexOf('const repId = currentRepId();') && sv.indexOf('const repId = currentRepId();') < sv.indexOf("repApi.post('/tracking/push/apns'"), 'قبل الطلب');
  assert.match(sv, /\.finally\(\(\) => \(epoch !== iosEpoch && session && repId \? dropIosRow\(session, repId, apnsEndpointOf\(env, token\)\) : undefined\)\);\n {2}if \(epoch !== iosEpoch\) return;/);
  assert.ok(sv.indexOf('if (epoch !== iosEpoch) return;') < sv.indexOf('localStorage.setItem(PUSH_APNS_KEY'), 'لا علامات لجلسةٍ انتهت');
  assert.match(sv, /localStorage\.setItem\(PUSH_OWNER_KEY, repId\)/, 'صاحب الجلسة التي حُفظ لها لا من دخل بعدها');
  // refreshIosPush: الإذن الممنوح شرطٌ قبل register — لا نافذة إذنٍ بلا نقرة؛ نداءٌ واحد لكل جلسة؛ وما سبقها يُنتظر
  const rf = fnSlice(s, 'export function refreshIosPush(');
  assert.match(rf, /if \(!iosPushAvailable\(\)\) return Promise\.resolve\(\);\n {2}if \(iosRefreshing\?\.epoch === iosEpoch\) return iosRefreshing\.run;/);
  const permAt = rf.indexOf("if (st.perm !== 'granted') { await forgetIosEndpoint(epoch); return; }");
  assert.ok(permAt > 0 && permAt < rf.indexOf('iosPushRegister('), 'الإذن قبل register، والمُطفأ من الإعدادات يُحذف صفّه');
  assert.ok(rf.indexOf('if (!sessionToken()) return;') < rf.indexOf('iosPushStatus('), 'بلا جلسةٍ لا شيء');
  assert.ok(rf.indexOf('if (iosStale) await within(iosStale, 30_000);') < rf.indexOf('iosPushStatus('), 'مزامنة جلسةٍ سابقة تُنتظر أوّلاً');
  assert.ok(rf.indexOf('if (!r.ok || epoch !== iosEpoch) return;') < rf.indexOf('await saveIos('), 'جلسةٌ انتهت أثناء الرمز لا تُرسل');
  assert.match(rf, /void run\.finally\(\(\) => \{ if \(iosRefreshing === entry\) iosRefreshing = null; \}\);/, 'نداءٌ واحد في الطريق');
  // إطفاء الإشعارات من الإعدادات: الحذف من الخادم أوّلاً، والعلامات تبقى إن تعذّر
  const fe = fnSlice(s, 'async function forgetIosEndpoint(');
  assert.ok(fe.indexOf("repApi.post('/tracking/push/unsubscribe'") > 0 && fe.indexOf("repApi.post('/tracking/push/unsubscribe'") < fe.indexOf('localStorage.removeItem(PUSH_APNS_KEY)'));
  // الخروج والدخول ينهيان الجلسة: الجارية لا تُعاد لمن بعدها
  assert.match(fnSlice(s, 'function endIosSession('), /iosEpoch\+\+;\n {2}const cur = iosRefreshing;\n {2}iosRefreshing = null;/);
  // حذف الصفّ لجلسةٍ خرجت: برمزها صريحاً لا بمعترض repApi (يضع رمز من دخل الآن)، والإعادة تكفّ إن عاد صاحبها
  const ua = fnSlice(s, 'async function unsubscribeIosAs(');
  assert.match(ua, /Authorization: `Bearer \$\{session\}`/);
  assert.match(ua, /\/tracking\/push\/unsubscribe`/);
  assert.doesNotMatch(ua, /repApi\.post/);
  assert.match(fnSlice(s, 'function dropIosRowLater('), /if \(currentRepId\(\) === repId\) return;\n {4}void dropIosRow\(/);
  assert.match(fnSlice(s, 'export async function refreshPush('), /^export async function refreshPush\(\): Promise<void> \{\n {2}if \(iosPushAvailable\(\)\) return refreshIosPush\(\);\n {2}if \(!supported\(\) \|\| Notification\.permission !== 'granted'\) return;/);
  const fg = fnSlice(s, 'export async function forgetForeignPush(');
  assert.match(fg, /^export async function forgetForeignPush\(repId: string\): Promise<void> \{\n {2}if \(iosPushAvailable\(\)\) endIosSession\(\);/);
  assert.match(fg, /if \(owner === repId\) return;\n {2}if \(iosPushAvailable\(\)\) \{ await unsubscribeLocalPush\(\); return; \}/);
  // الخروج: dropIosPush فوق dropPush (المقطع المثبّت يبدأ عند dropPush)، محلياً أوّلاً ثمّ الخادم — الآيفون لا يُلغى محلياً
  // كالويب فمهلته أطول، وما لم يبلغ الخادم يُعاد في الخلفية بجلسة الخارج، وعنوان الجهاز يبقى حتى يُحذف الصفّ
  const dropIosAt = s.indexOf('async function dropIosPush(');
  const dropAt = s.indexOf('export async function dropPush(');
  assert.ok(dropIosAt > 0 && dropIosAt < dropAt);
  const di = s.slice(dropIosAt, dropAt);
  assert.ok(di.indexOf('iosPushClearAll()') > 0 && di.indexOf('iosPushClearAll()') < di.indexOf("repApi.post('/tracking/push/unsubscribe'"), 'محلياً أوّلاً');
  assert.ok(di.indexOf('if (sync) await within(sync, 3000);') < di.indexOf('endIosSession();') && di.indexOf('endIosSession();') < di.indexOf('const session = sessionToken();'), 'الحفظ الجاري يُنتظر ثمّ تنتهي الجلسة');
  assert.match(di, /\{ background: true, timeout: 8000 \}\)\.then\(\(\) => true, \(\) => false\);/);
  assert.match(di, /localStorage\.removeItem\(PUSH_OWNER_KEY\)/);
  assert.match(di, /if \(ok\) \{ try \{ localStorage\.removeItem\(PUSH_APNS_KEY\); \}/);
  assert.match(di, /else if \(session && repId\) dropIosRowLater\(session, repId, endpoint\);/);
  assert.match(di, /\} catch \{ \/\* لا يمنع الخروج \*\/ \}/);
  assert.match(s.slice(dropAt), /^export async function dropPush\(\): Promise<void> \{\n {2}if \(iosPushAvailable\(\)\) return dropIosPush\(\);\n {2}try \{\n {4}const sub = await localPushSubscription\(\);/);
});

test('حارس ثابت: pushKey يمسح درج الآيفون أوّل ما يفعل، وrepApi (الخروج القسري) بلا تغيير', () => {
  const k = read('rep/pushKey.ts');
  assert.match(k, /^import \{ iosPushAvailable, iosPushClearAll \} from '\.\/iosPush';/);
  const un = fnSlice(k, 'export async function unsubscribeLocalPush(');
  assert.match(un, /const work = \(async \(\) => \{\n {4}if \(iosPushAvailable\(\)\) await iosPushClearAll\(\);/);
  assert.ok(un.indexOf('iosPushClearAll()') < un.indexOf('localPushSubscription()'));
  assert.match(read('rep/repApi.ts'), /await unsubscribeLocalPush\(1500\);/);
  assert.doesNotMatch(read('rep/repApi.ts'), /iosPush/);
});

test('حارس ثابت: RepApp — المستمع قبل ready ويُقرّ بالحدث، والتنظيف يزيل الاثنين، والتزامن الصامت لكل جلسة، ودعوة التحديث', () => {
  const app = read('rep/RepApp.tsx');
  assert.match(app, /import \{ pushState, enablePush, refreshPush, refreshIosPush, dropPush, forgetForeignPush, isIos, standalone, type PushState \} from '\.\/pushAlerts';\nimport \{ IOS_PUSH_EVENT, iosPushEventDetail, iosPushReady, iosPushScreen, type IosPushEvent \} from '\.\/iosPush';/);
  const addAt = app.indexOf('window.addEventListener(IOS_PUSH_EVENT, onIos);');
  assert.ok(addAt > 0 && addAt < app.indexOf('iosPushReady()'), 'المستمع أوّلاً ثمّ ready');
  assert.ok(app.indexOf("navigator.serviceWorker?.addEventListener('message', onMsg);") < addAt, 'في أثر رسالة العامل نفسه');
  assert.match(app, /const onIos = \(e: Event\) => \{ const d = iosPushEventDetail\(e\); if \(!d\) return; e\.preventDefault\(\); onIosEvent\(d\); \};/);
  assert.match(app, /if \(d\.kind === 'token'\) \{ void refreshPush\(\); return; \}/);
  assert.match(app, /if \(screen\) onMsg\(\{ data: \{ type: 'OPEN_SCREEN', screen \} \} as MessageEvent\);/, 'بالرسالة نفسها التي يرسلها العامل');
  assert.match(app, /void iosPushReady\(\)\.then\(\(evs\) => evs\.forEach\(onIosEvent\)\);/);
  assert.match(app, /return \(\) => \{ navigator\.serviceWorker\?\.removeEventListener\('message', onMsg\); window\.removeEventListener\(IOS_PUSH_EVENT, onIos\); \};/);
  assert.match(app, /else if \(e\.data\.screen === 'presence'\) fetchPresence\(\);/);
  // بلا شرط البصمة (٤ نوفمبر ٢٠٢٦): شركةٌ أطفأتها يردّ خادمها 403 ويُطلق الجهاز (releaseApnsDevice) — والإعادة حين تصل إعداداتها
  assert.match(app, /useEffect\(\(\) => \{ if \(token && user\?\.id\) void refreshIosPush\(\); \}, \[token, user\?\.id, attendanceOn\]\);/);
  assert.doesNotMatch(app, /attendanceOn\) void refreshIosPush\(\)/, 'شرط البصمة يُبقي صفّ مندوبٍ سابق على جوال من دخل بعده');
  assert.match(app, /\{pushSt === 'ios-update' && <p className="text-\[11px\] text-\[#5C5346\] bg-\[#FBF7F0\] rounded-xl px-3 py-2 text-center">\{tr\('لتصلك تنبيهات الحضور على آيفون حدث تطبيق فيلد سيلز من App Store'\)\}<\/p>\}/);
  assert.ok(app.indexOf("pushSt === 'ios-install'") < app.indexOf("pushSt === 'ios-update'"));
});

test('حارس ثابت: PresenceCheck — درج الآيفون يُمسح بالشرط نفسه (الصفحة ظاهرة) ولهذا الطلب وحده، قبل مسار عامل الخدمة', () => {
  const m = read('rep/PresenceCheck.tsx');
  assert.match(m, /import \{ iosPushAvailable, iosPushClear \} from '\.\/iosPush';/);
  const guard = m.indexOf("if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;");
  const ios = m.indexOf("if (iosPushAvailable()) { void iosPushClear('presence', checkId); return; }");
  const sw = m.indexOf('getNotifications(');
  assert.ok(guard > 0 && guard < ios && ios < sw);
  assert.doesNotMatch(m, /OPEN_SCREEN/);
  assert.doesNotMatch(m, /addEventListener\('visibilitychange'/);
  assert.doesNotMatch(m, /^\s*seen\(\);\s*$/m);
});

test('حارس ثابت: عامل الخدمة وجرس الطلب وجسر الطباعة بلا تغيير — لا ذكر لجسر الإشعارات فيها', () => {
  for (const f of ['../public/sw.js', 'rep/presenceAlarm.ts', 'lib/print/transport/iosBridge.ts', 'lib/print/transport/bridgeContract.ts']) {
    assert.doesNotMatch(read(f), /fsPush|__fsIosPush|fs-ios-push|iosPush/, f);
  }
});
