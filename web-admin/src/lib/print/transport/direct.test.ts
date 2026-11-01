// الموزّع: الطريق من تصنيف الجهاز، وفي Node (وكيل «Node.js» بلا Web Serial ولا أندرويد) لا طباعة مباشرة كاليوم —
// printerForJob يرفض unsupported برسالته المعروفة؛ وطابعة مسار التطبيق تُعرف من شكلها لا من منفذ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentPlatformInput, directOnAndroid, directOnIos, directPath, directPrintAvailable, isAppLink, isIosLink, linkPrinter, linkedPrinter, printerForJob } from './direct';
import { appPrinterLink } from './appBridge';
import type { SerialPortLike } from './btSerial';
import { DIRECT_PRINT_MESSAGES, DirectPrintError } from '../printErrors';

const ANDROID_SAMSUNG = 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36';

test('directPath يلفّ التصنيف', () => {
  assert.equal(directPath({ ua: ANDROID_SAMSUNG, hasSerial: false, bridgeForAll: true }), 'app');
  assert.equal(directPath({ ua: ANDROID_SAMSUNG, hasSerial: false }), 'app', 'بوّابة النشر مفتوحة: بلا علامة الجسر');
  assert.equal(directPath({ ua: ANDROID_SAMSUNG, hasSerial: false, bridgeForAll: false }), 'none', 'لو أُطفئت البوّابة: بلا علامة الجسر');
  assert.equal(directPath({ ua: ANDROID_SAMSUNG, hasSerial: false, bridgeFlag: true }), 'app');
  assert.equal(directOnAndroid({ ua: ANDROID_SAMSUNG, hasSerial: false }), true);
  assert.equal(directOnAndroid({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0', hasSerial: false }), false);
  assert.equal(directPath({ ua: ANDROID_SAMSUNG, hasSerial: true }), 'serial');
  assert.equal(directPath({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0', hasSerial: false }), 'none');
});

test('Node: لا Web Serial ولا أندرويد ⇒ none — printerForJob وlinkPrinter يرفضان unsupported، وlinkedPrinter = null', async () => {
  const input = currentPlatformInput();
  assert.equal(input.hasSerial, false);
  assert.equal(input.bridgeFlag, false);
  assert.equal(directPath(), 'none');
  assert.equal(directPrintAvailable(), false);
  await assert.rejects(printerForJob(), (e: unknown) => e instanceof DirectPrintError && e.kind === 'unsupported' && e.message === DIRECT_PRINT_MESSAGES.unsupported);
  await assert.rejects(linkPrinter(), (e: unknown) => e instanceof DirectPrintError && e.kind === 'unsupported');
  assert.equal(await linkedPrinter(), null);
});

test('isAppLink: طابعة التطبيق نعم، ومنفذ Web Serial لا', () => {
  const port: SerialPortLike = { open: async () => undefined, close: async () => undefined, writable: null, getInfo: () => ({ bluetoothServiceClassId: 0x1101 }) };
  assert.equal(isAppLink(appPrinterLink()), true);
  assert.equal(isAppLink(port), false);
  assert.equal(isAppLink(null), false);
  assert.equal(isAppLink(undefined), false);
});

/** صفحةٌ مزيّفة: navigator وdocument وwindow (localStorage) — تُعاد الأصول بعد كل حالة */
function withPage(page: { navigator: unknown; document?: unknown; window?: unknown }, run: () => Promise<void> | void) {
  const g = globalThis as Record<string, unknown>;
  const keys = ['navigator', 'document', 'window'] as const;
  const saved = keys.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  for (const k of keys) {
    if (page[k] !== undefined) Object.defineProperty(g, k, { value: page[k], configurable: true, writable: true });
  }
  const restore = () => { for (const [k, d] of saved) { if (d) Object.defineProperty(g, k, d); else delete g[k]; } };
  try {
    const r = run();
    if (r) return r.finally(restore);
    restore();
  } catch (e) { restore(); throw e; }
  return undefined;
}
const store = (m: Record<string, string>) => ({ getItem: (k: string) => m[k] ?? null, setItem: () => undefined, removeItem: () => undefined });
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FLAG = JSON.stringify({ v: 1, k: 'Ab3_Cd4-Ef5Gh6Ij7Kl8Mn', at: 1 });

test('currentPlatformInput يجمع إشارات أندرويد من الصفحة: userAgentData والمُحيل وعلامة الجسر واللمس', async () => {
  await withPage({
    navigator: { userAgent: LINUX, userAgentData: { platform: 'Android' }, maxTouchPoints: 5 },
    document: { referrer: 'android-app://net.fieldsa.twa/' },
    window: { localStorage: store({ fs_print_bridge: FLAG }), isSecureContext: true },
  }, async () => {
    assert.deepEqual(currentPlatformInput(), {
      ua: LINUX, uaDataPlatform: 'Android', maxTouchPoints: 5, hasSerial: false, referrer: 'android-app://net.fieldsa.twa/', bridgeFlag: true,
      iosBridge: null, iosWrapper: false,
    });
    assert.equal(directPath(), 'app');
    assert.equal(directPrintAvailable(), true);
    assert.equal(await linkedPrinter(), null, 'مسار التطبيق لا يعرف طابعته في الصفحة');
    const before = Date.now();
    const link = await printerForJob();
    assert.ok(isAppLink(link));
    assert.ok(link.tappedAt >= before && link.tappedAt <= Date.now(), 'وقت اللمسة الآن — لصلاحية الإيماءة');
  });
  // كلّ إشارةٍ وحدها تكفي، وبلا أيٍّ منها ⇒ none كاليوم
  for (const [name, page] of [
    ['uaData', { navigator: { userAgent: LINUX, userAgentData: { platform: 'Android' } } }],
    ['referrer', { navigator: { userAgent: LINUX }, document: { referrer: 'android-app://net.fieldsa.twa/' } }],
    ['flag', { navigator: { userAgent: LINUX }, window: { localStorage: store({ fs_print_bridge: FLAG }) } }],
  ] as const) {
    // بوّابة النشر مفتوحة: كل إشارة أندرويد وحدها تفتح مسار التطبيق
    withPage(page, () => { assert.equal(directPath(), 'app', name); assert.equal(directOnAndroid(), true, name); });
  }
  withPage({ navigator: { userAgent: LINUX }, document: { referrer: '' }, window: { localStorage: store({}) } }, () => {
    assert.equal(directPath(), 'none');
  });
  // Web Serial حيث وُجد ⇒ serial ولو على أندرويد بعلامة الجسر
  const serial = { requestPort: async () => { throw new Error('x'); }, getPorts: async () => [] };
  withPage({ navigator: { userAgent: LINUX, userAgentData: { platform: 'Android' }, serial }, window: { localStorage: store({ fs_print_bridge: FLAG }), isSecureContext: true } }, () => {
    assert.equal(directPath(), 'serial');
  });
});

// ─── تطبيق فيلد سيلز على الآيفون (1.1.0): معالج fsPrint بردّ وعلامة __fsIosBridge ───

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const IOS_APP = `${IPHONE} FieldSales`;

/** نافذة تطبيق الآيفون المزيّفة: المعالج يجيب بما في replies[op] ويحفظ الرسائل؛ وبلا علامة = معالجٌ وحده */
function iosWindow(replies: Record<string, unknown>, opts: { marker?: unknown } = {}) {
  const posted: Array<Record<string, unknown>> = [];
  const w: Record<string, unknown> = {
    localStorage: store({}),
    webkit: { messageHandlers: { fsPrint: { postMessage(msg: Record<string, unknown>) { posted.push(msg); return Promise.resolve(replies[msg.op as string]); } } } },
    addEventListener() {}, removeEventListener() {},
  };
  if (opts.marker !== undefined) w.__fsIosBridge = opts.marker;
  return { w, posted };
}
const HELLO = (printer: { name: string } | null, busy = false) => ({ v: 1, app: '1.1.0', build: '7', auth: 'allowed', printer, busy, caps: ['print', 'pick', 'cancel', 'systemPrint'] });

test('تطبيق الآيفون بجسره ⇒ ios-app: الطابعة المحفوظة باسمها، والربط شاشة التطبيق ثم \'linked\'', async () => {
  const { w, posted } = iosWindow({ hello: HELLO({ name: 'RPP04' }), pick: { ok: true, printer: { name: 'XP-80' } } }, { marker: { v: 1, caps: ['print', 'pick', 'cancel', 'systemPrint'] } });
  await withPage({ navigator: { userAgent: IOS_APP, maxTouchPoints: 5 }, document: { referrer: '', cookie: 'app-platform=iOS App Store' }, window: w }, async () => {
    const input = currentPlatformInput();
    assert.equal(input.iosBridge, 1);
    assert.equal(input.iosWrapper, true);
    assert.equal(directPath(), 'ios-app');
    assert.equal(directOnIos(), true);
    assert.equal(directOnAndroid(), false);
    assert.equal(directPrintAvailable(), true);
    const link = await printerForJob();
    assert.ok(isIosLink(link));
    assert.ok(!isAppLink(link));
    assert.deepEqual(link, { via: 'fs-ios', name: 'RPP04' });
    assert.deepEqual(await linkedPrinter(), { via: 'fs-ios', name: 'RPP04' });
    assert.equal(await linkPrinter(), 'linked');
    assert.deepEqual(posted.map((m) => m.op), ['hello', 'hello', 'pick']);
    assert.deepEqual(posted[0], { op: 'hello', v: 1 });
  });
});

test('تطبيق الآيفون بلا طابعة محفوظة: printerForJob يفتح شاشة الاختيار، وlinkedPrinter = null', async () => {
  const { w, posted } = iosWindow({ hello: HELLO(null), pick: { ok: true, printer: { name: 'MPT-II' } } }, { marker: { v: 1, caps: [] } });
  await withPage({ navigator: { userAgent: IOS_APP, maxTouchPoints: 5 }, window: w }, async () => {
    assert.equal(await linkedPrinter(), null);
    assert.deepEqual(await printerForJob(), { via: 'fs-ios', name: 'MPT-II' });
    assert.deepEqual(posted.map((m) => m.op), ['hello', 'hello', 'pick']);
  });
});

test('معالجٌ بلا علامة، أو علامةٌ بلا معالج، أو تطبيق 1.0، أو سفاري ⇒ none كاليوم (unsupported)', async () => {
  const cases: Array<[string, { navigator: unknown; document?: unknown; window?: unknown }]> = [
    ['معالج بلا علامة', { navigator: { userAgent: IOS_APP, maxTouchPoints: 5 }, window: iosWindow({ hello: HELLO(null) }).w }],
    ['علامة بلا معالج', { navigator: { userAgent: IOS_APP, maxTouchPoints: 5 }, window: { localStorage: store({}), __fsIosBridge: { v: 1, caps: [] } } }],
    ['علامة v:0', { navigator: { userAgent: IOS_APP, maxTouchPoints: 5 }, window: iosWindow({}, { marker: { v: 0 } }).w }],
    ['تطبيق 1.0 (معالج print وحده)', { navigator: { userAgent: IOS_APP, maxTouchPoints: 5 }, document: { cookie: 'app-platform=iOS App Store' }, window: { localStorage: store({}), webkit: { messageHandlers: { print: { postMessage() {} } } } } }],
    ['سفاري', { navigator: { userAgent: IPHONE, maxTouchPoints: 5 }, window: { localStorage: store({}) } }],
  ];
  for (const [name, page] of cases) {
    await withPage(page, async () => {
      assert.equal(directPath(), 'none', name);
      assert.equal(directOnIos(), false, name);
      await assert.rejects(printerForJob(), (e: unknown) => e instanceof DirectPrintError && e.kind === 'unsupported', name);
      assert.equal(await linkedPrinter(), null, name);
    });
  }
  // تطبيق 1.0 يُعرف (لتلميح التحديث) بلا جسر
  await withPage(cases[3][1], () => { assert.deepEqual([currentPlatformInput().iosBridge, currentPlatformInput().iosWrapper], [null, true]); });
  await withPage(cases[4][1], () => { assert.deepEqual([currentPlatformInput().iosBridge, currentPlatformInput().iosWrapper], [null, false]); });
});

test('أندرويد بعلامة الآيفون لا يصير ios-app — الجسر على iOS وحده', async () => {
  const { w } = iosWindow({ hello: HELLO(null) }, { marker: { v: 1, caps: [] } });
  await withPage({ navigator: { userAgent: ANDROID_SAMSUNG }, window: w }, () => {
    const input = currentPlatformInput();
    assert.equal(input.iosBridge, 1);
    assert.notEqual(directPath(), 'ios-app');
    assert.equal(directOnIos(), false);
    assert.equal(directOnAndroid(), true);
    // بوّابة أندرويد وحدها تحكم، أيّاً كان APP_BRIDGE_FOR_ALL
    assert.equal(directPath({ ...input, bridgeForAll: false }), 'none', 'بوّابة أندرويد مغلقة: بلا علامة الجسر');
    assert.equal(directPath({ ...input, bridgeForAll: true }), 'app', 'بوّابة أندرويد مفتوحة');
  });
});
