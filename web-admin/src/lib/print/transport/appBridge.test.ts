// جسر الطباعة إلى تطبيق أندرويد ببيئةٍ مزيّفة (مؤقّتات وتخزين ومستمعون): روابط intent حرفاً بحرف، والتقاط fsbridge وحذفه
// بلا مساسٍ ببقية العنوان، والتسليم يُعرف بإخفاء الصفحة خلال 3 ثوانٍ (والمتأخّر يعيد العلامة)، والمفتاح ⇒ 'done' وبدونه
// 'handed'، والتعذّر ⇒ appUpdate، والكبير ⇒ tooLarge قبل أيّ فتح، واللمسة الثانية حين انقضت صلاحية الإيماءة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appPrinterLink, browserAppEnv, captureBridgeLaunch, clearBridgeFlag, isAndroidWebView, launchIntent, onLateHandoff, openAppPicker,
  pickerIntentUrl, printIntentUrl, readBridgeFlag, sendViaApp, writeBridgeFlag, type AppEnv,
} from './appBridge';
import { decodeBridgePayload, type BridgeJob } from './bridgePayload';
import { DirectPrintError } from '../printErrors';
import type { DirectUi } from '../../../rep/printDirect';

const KEY = 'Ab3_Cd4-Ef5Gh6Ij7Kl8Mn';
const FLAG = JSON.stringify({ v: 1, k: KEY, at: 1000 });

function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m };
}
const throwingStorage = {
  getItem: (): string | null => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('SecurityError'); },
  removeItem: () => { throw new Error('SecurityError'); },
};

type Ls = Map<string, Set<() => void>>;
function fakeEnv(o: { activation?: boolean | null; storage?: AppEnv['storage']; onHref?: (env: { hide(): void; pagehide(): void }) => void; now?: number } = {}) {
  let clock = o.now ?? 0;
  let seq = 0;
  const timers = new Map<number, { at: number; f: () => void }>();
  const docLs: Ls = new Map();
  const winLs: Ls = new Map();
  const on = (ls: Ls) => ({
    addEventListener: (t: string, f: () => void) => { if (!ls.has(t)) ls.set(t, new Set()); ls.get(t)!.add(f); },
    removeEventListener: (t: string, f: () => void) => { ls.get(t)?.delete(f); },
  });
  const hrefs: string[] = [];
  const log: string[] = [];
  const env = {
    doc: { ...on(docLs), visibilityState: 'visible' },
    win: {
      ...on(winLs),
      location: {
        get href() { return hrefs[hrefs.length - 1] ?? 'https://fieldsa.net/rep'; },
        set href(v: string) { hrefs.push(v); log.push('href'); o.onHref?.(env); },
      },
    },
    storage: o.storage === undefined ? memStorage() : o.storage,
    now: () => clock,
    setTimeout: (f: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: clock + ms, f }); return id; },
    clearTimeout: (h: unknown) => { timers.delete(h as number); },
    activation: () => (o.activation === undefined ? true : o.activation),
    frame: null as AppEnv['frame'],
    // ─── أدوات الاختبار ───
    hrefs, log,
    listeners: () => [...docLs.values(), ...winLs.values()].reduce((n, s) => n + s.size, 0),
    hide() { env.doc.visibilityState = 'hidden'; for (const f of [...(docLs.get('visibilitychange') ?? [])]) f(); },
    show() { env.doc.visibilityState = 'visible'; for (const f of [...(docLs.get('visibilitychange') ?? [])]) f(); },
    pagehide() { for (const f of [...(winLs.get('pagehide') ?? [])]) f(); },
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
  return env;
}

const tick = () => new Promise<void>((r) => setImmediate(r));
async function until(cond: () => boolean) {
  for (let i = 0; i < 5000 && !cond(); i++) await tick();
  assert.ok(cond(), 'لم يحدث');
}
const job = (over: Partial<BridgeJob> = {}): BridgeJob => ({
  kind: 'escpos', bytes: Uint8Array.from([0x1b, 0x40, 0x0a, 0x0a]), marks: [2, 4], cancel: [0x1b, 0x40], slow: false, label: 'الفاتورة — INV-12', ...over,
});
const ui = (over: Partial<DirectUi> = {}): DirectUi => ({ pageLabel: () => '', ...over });
const settled = async <T>(p: Promise<T>) => {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  await tick();
  return done;
};

test('روابط intent حرفاً بحرف — بمفتاحٍ وبدونه، ورابط اختيار الطابعة', () => {
  assert.equal(printIntentUrl('RlNQ_-', KEY), `intent://print?k=${KEY}&p=RlNQ_-#Intent;scheme=fieldsaprint;package=net.fieldsa.twa;end`);
  assert.equal(printIntentUrl('RlNQ_-', null), 'intent://print?p=RlNQ_-#Intent;scheme=fieldsaprint;package=net.fieldsa.twa;end');
  assert.equal(printIntentUrl('RlNQ', 'short'), 'intent://print?p=RlNQ#Intent;scheme=fieldsaprint;package=net.fieldsa.twa;end', 'مفتاحٌ مختلّ يُحذف');
  assert.equal(pickerIntentUrl(), 'intent://printer#Intent;scheme=fieldsaprint;package=net.fieldsa.twa;end');
  for (const u of [printIntentUrl('x', KEY), pickerIntentUrl()]) assert.ok(!u.includes('browser_fallback_url'));
  assert.deepEqual(appPrinterLink(42), { via: 'fs-app', tappedAt: 42 });
});

test('captureBridgeLaunch: يحفظ القيمة الصالحة ويحذف المعامل وحده — cardpay وبقية المعاملات والمرساة وhistory.state باقية', () => {
  const st = memStorage();
  const state = { __fsDepth: 2 };
  const calls: unknown[][] = [];
  captureBridgeLaunch({
    location: { search: `?cardpay=8f1c-uuid&fsbridge=1.${KEY}&tab=a%20b`, pathname: '/rep', hash: '#docs' },
    history: { state, replaceState: (...a: unknown[]) => { calls.push(a); } },
    storage: st, now: () => 1234,
  });
  assert.equal(st.m.get('fs_print_bridge'), JSON.stringify({ v: 1, k: KEY, at: 1234 }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], state);
  assert.equal(calls[0][1], '');
  assert.equal(calls[0][2], '/rep?cardpay=8f1c-uuid&tab=a%20b#docs');
  // المعامل وحده ⇒ بلا علامة استفهام
  const c2: unknown[][] = [];
  captureBridgeLaunch({ location: { search: `?fsbridge=12.${KEY}`, pathname: '/rep', hash: '' }, history: { state: null, replaceState: (...a: unknown[]) => { c2.push(a); } }, storage: st, now: () => 9 });
  assert.equal(c2[0][2], '/rep');
  assert.equal(readBridgeFlag(st)?.v, 12);
});

test('captureBridgeLaunch: القيمة المختلّة تُحذف ولا تُحفظ، وبلا معاملٍ لا يمسّ العنوان، والتخزين الرامي لا يرمي', () => {
  for (const bad of ['abc', `0.${KEY}`, `1.${KEY}x`, `1.${KEY.slice(1)}`, `1234.${KEY}`, '']) {
    const st = memStorage();
    const calls: unknown[][] = [];
    captureBridgeLaunch({ location: { search: `?a=1&fsbridge=${bad}`, pathname: '/rep', hash: '' }, history: { state: null, replaceState: (...a: unknown[]) => { calls.push(a); } }, storage: st });
    assert.equal(st.m.size, 0, bad);
    assert.equal(calls[0][2], '/rep?a=1', bad);
  }
  const none: unknown[][] = [];
  captureBridgeLaunch({ location: { search: '?cardpay=x', pathname: '/rep', hash: '' }, history: { state: null, replaceState: (...a: unknown[]) => { none.push(a); } }, storage: memStorage() });
  assert.equal(none.length, 0);
  const c3: unknown[][] = [];
  assert.doesNotThrow(() => captureBridgeLaunch({ location: { search: `?fsbridge=1.${KEY}`, pathname: '/rep', hash: '' }, history: { state: null, replaceState: (...a: unknown[]) => { c3.push(a); } }, storage: throwingStorage }));
  assert.equal(c3.length, 1, 'يُحذف ولو تعذّر الحفظ');
  assert.doesNotThrow(() => captureBridgeLaunch({ location: { search: `?fsbridge=1.${KEY}`, pathname: '/rep', hash: '' }, history: { state: null, replaceState: () => { throw new Error('SecurityError'); } }, storage: null }));
  assert.doesNotThrow(() => captureBridgeLaunch()); // Node: لا window
});

test('readBridgeFlag يرفض JSON المعطوب والشكل المختلّ — والكتابة والمسح محروسان', () => {
  for (const raw of ['{', 'null', '1', '[]', '{"v":1,"k":"short","at":1}', `{"v":0,"k":"${KEY}","at":1}`, `{"v":1.5,"k":"${KEY}","at":1}`, `{"k":"${KEY}","at":1}`, `{"v":1,"k":"${KEY}"}`, `{"v":"1","k":"${KEY}","at":1}`]) {
    assert.equal(readBridgeFlag(memStorage({ fs_print_bridge: raw })), null, raw);
  }
  assert.deepEqual(readBridgeFlag(memStorage({ fs_print_bridge: FLAG })), { v: 1, k: KEY, at: 1000 });
  assert.equal(readBridgeFlag(null), null);
  assert.equal(readBridgeFlag(throwingStorage), null);
  assert.doesNotThrow(() => { writeBridgeFlag({ v: 1, k: KEY, at: 1 }, throwingStorage); clearBridgeFlag(throwingStorage); });
});

test('launchIntent: الإخفاء قبل المهلة أو pagehide ⇒ handed، والرابط يُسند مرّةً واحدة والمستمعون يُزالون', async () => {
  const a = fakeEnv();
  const pa = launchIntent('intent://x', a);
  assert.deepEqual(a.hrefs, ['intent://x']);
  assert.equal(a.listeners(), 2);
  a.advance(1000);
  a.show(); // ظهورٌ لا يُعدّ
  assert.equal(await settled(pa), false);
  a.hide();
  assert.equal(await pa, 'handed');
  assert.equal(a.listeners(), 0);
  a.advance(20_000);
  assert.deepEqual(a.hrefs, ['intent://x']);

  const b = fakeEnv();
  const pb = launchIntent('intent://y', b);
  b.pagehide();
  assert.equal(await pb, 'handed');
  assert.equal(b.listeners(), 0);
});

test('launchIntent: لا إخفاء ⇒ failed عند 3000 بالضبط؛ والإخفاء عند 5000 ⇒ onLate مرّةً واحدة؛ والنافذة تنتهي عند 12000', async () => {
  const e = fakeEnv();
  let late = 0;
  const p = launchIntent('intent://x', e, { onLate: () => { late++; } });
  e.advance(2999);
  assert.equal(await settled(p), false);
  e.advance(1);
  assert.equal(await p, 'failed');
  assert.equal(e.listeners(), 2, 'يبقى يستمع للمتأخّر');
  e.advance(2000);
  e.hide();
  e.hide();
  assert.equal(late, 1);
  assert.equal(e.listeners(), 0);

  const f = fakeEnv();
  let lateF = 0;
  const pf = launchIntent('intent://x', f, { onLate: () => { lateF++; } });
  f.advance(3000);
  assert.equal(await pf, 'failed');
  f.advance(9000); // 12000 من الفتح
  assert.equal(f.listeners(), 0);
  f.hide();
  assert.equal(lateF, 0);
  assert.deepEqual(f.hrefs, ['intent://x']);
});

const UA = {
  webView: 'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.0.0 Mobile Safari/537.36',
  fbIab: 'Mozilla/5.0 (Linux; Android 14; SM-A546E Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.107 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/489.0.0.66.81;]',
  chrome: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0',
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};

test('WebView: الرابط من إطارٍ مخفيّ لا من الإطار الأعلى (صفحة خطأ مكان الصفحة) — والإطار يُزال حين تنتهي المراقبة', async () => {
  assert.equal(isAndroidWebView(UA.webView), true);
  assert.equal(isAndroidWebView(UA.fbIab), true);
  for (const ua of [UA.chrome, UA.samsung, UA.firefox, UA.desktop]) assert.equal(isAndroidWebView(ua), false, ua);

  const frames: string[] = [];
  let removed = 0;
  const a = fakeEnv();
  a.frame = (u) => { frames.push(u); return () => { removed++; }; };
  const pa = launchIntent('intent://x', a);
  assert.deepEqual(frames, ['intent://x']);
  assert.deepEqual(a.hrefs, [], 'الإطار الأعلى لا يُمسّ');
  assert.equal(removed, 0);
  a.hide();
  assert.equal(await pa, 'handed');
  assert.equal(removed, 1);
  assert.equal(a.listeners(), 0);

  // الإخفاء أثناء الفتح نفسه: يُزال الإطار ولو لم يُعرف مُزيله بعد
  let removedSync = 0;
  const s = fakeEnv();
  s.frame = () => { s.hide(); return () => { removedSync++; }; };
  assert.equal(await launchIntent('intent://y', s), 'handed');
  assert.equal(removedSync, 1);

  // لا تسليم: يبقى الإطار حتى نهاية نافذة المتأخّر (12000) ثم يُزال مرّةً واحدة
  let removedLate = 0;
  const f = fakeEnv();
  f.frame = () => () => { removedLate++; };
  const pf = launchIntent('intent://z', f);
  f.advance(3000);
  assert.equal(await pf, 'failed');
  assert.equal(removedLate, 0, 'الإطار باقٍ للتسليم المتأخّر');
  f.advance(9000);
  assert.equal(removedLate, 1);
  f.hide();
  assert.equal(removedLate, 1);
  assert.deepEqual(f.hrefs, []);
});

test('browserAppEnv: WebView ⇒ إطارٌ مخفيّ (display:none، src بعد الإلحاق)، وغيره ⇒ الإطار الأعلى', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { document: Object.getOwnPropertyDescriptor(g, 'document'), window: Object.getOwnPropertyDescriptor(g, 'window'), navigator: Object.getOwnPropertyDescriptor(g, 'navigator') };
  const log: string[] = [];
  const iframe = {
    style: {} as Record<string, string>, attrs: {} as Record<string, string>, _src: '',
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
    set src(v: string) { log.push(`src:${v}`); this._src = v; },
    get src() { return this._src; },
    remove() { log.push('remove'); },
  };
  const put = (k: string, v: unknown) => Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  try {
    put('document', { createElement: (t: string) => { log.push(`create:${t}`); return iframe; }, body: { appendChild: () => { log.push('append'); } } });
    put('window', { localStorage: null, setTimeout, clearTimeout });
    put('navigator', { userAgent: UA.webView });
    const wv = browserAppEnv();
    assert.equal(typeof wv.frame, 'function');
    const remove = wv.frame!('intent://print?p=AA#Intent;end');
    assert.deepEqual(log, ['create:iframe', 'append', 'src:intent://print?p=AA#Intent;end']);
    assert.equal(iframe.style.display, 'none');
    assert.equal(iframe.attrs['aria-hidden'], 'true');
    remove();
    assert.equal(log[log.length - 1], 'remove');
    for (const ua of [UA.chrome, UA.samsung, UA.firefox]) {
      put('navigator', { userAgent: ua });
      assert.equal(browserAppEnv().frame, null, ua);
    }
  } finally {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(g, k, d); else delete g[k];
    }
  }
});

test('sendViaApp: المفتاح ⇒ done ورابطٌ فيه k، والحمولة هي المهمة نفسها؛ وonHandoff قبل الفتح', async () => {
  const e = fakeEnv({ storage: memStorage({ fs_print_bridge: FLAG }), onHref: (env) => env.hide() });
  const r = await sendViaApp(appPrinterLink(0), job(), ui({ onHandoff: () => e.log.push('handoff') }), e);
  assert.equal(r, 'done');
  assert.deepEqual(e.log, ['handoff', 'href']);
  assert.equal(e.hrefs.length, 1);
  const m = /^intent:\/\/print\?k=([A-Za-z0-9_-]{22})&p=([A-Za-z0-9_-]+)#Intent;scheme=fieldsaprint;package=net\.fieldsa\.twa;end$/.exec(e.hrefs[0]);
  assert.ok(m, e.hrefs[0]);
  assert.equal(m[1], KEY);
  const d = await decodeBridgePayload(m[2]);
  assert.deepEqual([d.kind, [...d.bytes], d.marks, d.cancel, d.label, d.slow], ['escpos', [0x1b, 0x40, 0x0a, 0x0a], [2, 4], [0x1b, 0x40], 'الفاتورة — INV-12', false]);
});

test('sendViaApp: بلا مفتاح ⇒ handed ورابطٌ بلا k', async () => {
  const e = fakeEnv({ onHref: (env) => env.pagehide() });
  assert.equal(await sendViaApp(appPrinterLink(0), job(), ui(), e), 'handed');
  assert.match(e.hrefs[0], /^intent:\/\/print\?p=/);
  assert.ok(!e.hrefs[0].includes('k='));
});

test('sendViaApp: الإيماءة الحيّة لا تطلب لمسة، والمنقضية تطلبها قبل الفتح، ورفضها ⇒ cancelled بلا فتح', async () => {
  const live = fakeEnv({ activation: true, onHref: (env) => env.hide() });
  let taps = 0;
  await sendViaApp(appPrinterLink(0), job(), ui({ requestTap: async () => { taps++; } }), live);
  assert.equal(taps, 0);

  const dead = fakeEnv({ activation: false, onHref: (env) => env.hide() });
  await sendViaApp(appPrinterLink(0), job(), ui({ requestTap: async () => { dead.log.push('tap'); } }), dead);
  assert.deepEqual(dead.log, ['tap', 'href']);

  // بلا userActivation: الوقت منذ اللمسة
  const fresh = fakeEnv({ activation: null, now: 5000, onHref: (env) => env.hide() });
  await sendViaApp(appPrinterLink(2000), job(), ui({ requestTap: async () => { fresh.log.push('tap'); } }), fresh);
  assert.deepEqual(fresh.log, ['href']);
  const old = fakeEnv({ activation: null, now: 5001, onHref: (env) => env.hide() });
  await sendViaApp(appPrinterLink(2000), job(), ui({ requestTap: async () => { old.log.push('tap'); } }), old);
  assert.deepEqual(old.log, ['tap', 'href']);

  const no = fakeEnv({ activation: false });
  assert.equal(await sendViaApp(appPrinterLink(0), job(), ui({ requestTap: () => Promise.reject(new Error('cancelled')) }), no), 'cancelled');
  assert.equal(no.hrefs.length, 0);

  const ac = new AbortController(); ac.abort();
  const ab = fakeEnv();
  assert.equal(await sendViaApp(appPrinterLink(0), job(), ui({ signal: ac.signal }), ab), 'cancelled');
  assert.equal(ab.hrefs.length, 0);
});

test('sendViaApp: لا تسليم ⇒ DirectPrintError(appUpdate) وتُمسح العلامة، والتسليم المتأخّر يعيدها', async () => {
  const st = memStorage({ fs_print_bridge: FLAG });
  const e = fakeEnv({ storage: st });
  const p = sendViaApp(appPrinterLink(0), job(), ui(), e);
  p.catch(() => undefined);
  await until(() => e.hrefs.length === 1);
  e.advance(3000);
  await assert.rejects(p, (x: unknown) => x instanceof DirectPrintError && x.kind === 'appUpdate'
    && x.message === 'لتفعيل الطباعة المباشرة حدث تطبيق فيلد سيلز من Google Play');
  assert.equal(st.m.has('fs_print_bridge'), false);
  e.advance(4000);
  e.hide();
  assert.equal(st.m.get('fs_print_bridge'), FLAG);
});

test('onLateHandoff: التسليم المتأخّر يُبلَّغ مرّةً واحدة بحصيلته (done بمفتاح، handed بدونه) — لا في التسليم في وقته ولا بعد إلغاء الاشتراك', async () => {
  const seen: string[] = [];
  const off = onLateHandoff((o) => seen.push(o));
  try {
    // في وقته ⇒ لا بلاغ
    const okEnv = fakeEnv({ storage: memStorage({ fs_print_bridge: FLAG }), onHref: (env) => env.hide() });
    assert.equal(await sendViaApp(appPrinterLink(0), job(), ui(), okEnv), 'done');
    assert.deepEqual(seen, []);
    // متأخّرٌ بمفتاح ⇒ done مرّةً واحدة
    const keyed = fakeEnv({ storage: memStorage({ fs_print_bridge: FLAG }) });
    const p1 = sendViaApp(appPrinterLink(0), job(), ui(), keyed);
    p1.catch(() => undefined);
    await until(() => keyed.hrefs.length === 1);
    keyed.advance(3000);
    await assert.rejects(p1);
    assert.deepEqual(seen, []);
    keyed.advance(1000);
    keyed.hide();
    keyed.hide();
    assert.deepEqual(seen, ['done']);
    // متأخّرٌ بلا مفتاح (والمستمع الرامي لا يمنع غيره) ⇒ handed
    const offBad = onLateHandoff(() => { throw new Error('boom'); });
    const bare = fakeEnv();
    const p2 = openAppPicker(bare);
    p2.catch(() => undefined);
    await until(() => bare.hrefs.length === 1);
    bare.advance(3000);
    await assert.rejects(p2);
    bare.hide();
    offBad();
    assert.deepEqual(seen, ['done', 'handed']);
  } finally { off(); }
  // بعد الإلغاء ⇒ لا بلاغ
  const after = fakeEnv();
  const p3 = openAppPicker(after);
  p3.catch(() => undefined);
  await until(() => after.hrefs.length === 1);
  after.advance(3000);
  await assert.rejects(p3);
  after.hide();
  assert.deepEqual(seen, ['done', 'handed']);
});

test('sendViaApp: المستند الأكبر من الرابط ⇒ tooLarge بلا أيّ فتح', async () => {
  const bytes = new Uint8Array(150_000);
  let x = 1;
  for (let i = 0; i < bytes.length; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; bytes[i] = x >>> 24; }
  const e = fakeEnv({ onHref: (env) => env.hide() });
  await assert.rejects(sendViaApp(appPrinterLink(0), job({ bytes, marks: [bytes.length] }), ui(), e), (err: unknown) => err instanceof DirectPrintError && err.kind === 'tooLarge');
  assert.equal(e.hrefs.length, 0);
  // ومهمةٌ مختلّة ⇒ failed بلا فتح
  await assert.rejects(sendViaApp(appPrinterLink(0), job({ marks: [3] }), ui(), e), (err: unknown) => err instanceof DirectPrintError && err.kind === 'failed');
  assert.equal(e.hrefs.length, 0);
});

test('openAppPicker: رابط الاختيار ⇒ handed، والتعذّر ⇒ appUpdate ومسح العلامة', async () => {
  const ok = fakeEnv({ onHref: (env) => env.hide() });
  assert.equal(await openAppPicker(ok), 'handed');
  assert.deepEqual(ok.hrefs, [pickerIntentUrl()]);
  const st = memStorage({ fs_print_bridge: FLAG });
  const bad = fakeEnv({ storage: st });
  const p = openAppPicker(bad);
  p.catch(() => undefined);
  await until(() => bad.hrefs.length === 1);
  bad.advance(3000);
  await assert.rejects(p, (x: unknown) => x instanceof DirectPrintError && x.kind === 'appUpdate');
  assert.equal(st.m.has('fs_print_bridge'), false);
});
