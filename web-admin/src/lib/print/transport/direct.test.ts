// الموزّع: الطريق من تصنيف الجهاز، وفي Node (وكيل «Node.js» بلا Web Serial ولا أندرويد) لا طباعة مباشرة كاليوم —
// printerForJob يرفض unsupported برسالته المعروفة؛ وطابعة مسار التطبيق تُعرف من شكلها لا من منفذ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentPlatformInput, directOnAndroid, directPath, directPrintAvailable, isAppLink, linkPrinter, linkedPrinter, printerForJob } from './direct';
import { appPrinterLink } from './appBridge';
import type { SerialPortLike } from './btSerial';
import { DIRECT_PRINT_MESSAGES, DirectPrintError } from '../printErrors';

const ANDROID_SAMSUNG = 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36';

test('directPath يلفّ التصنيف', () => {
  assert.equal(directPath({ ua: ANDROID_SAMSUNG, hasSerial: false, bridgeForAll: true }), 'app');
  assert.equal(directPath({ ua: ANDROID_SAMSUNG, hasSerial: false }), 'none', 'بوّابة النشر مغلقة: بلا علامة الجسر');
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
    // بوّابة النشر مغلقة: علامة الجسر وحدها تفتح مسار التطبيق؛ userAgentData والمُحيل يعرّفان أندرويد فقط
    withPage(page, () => { assert.equal(directPath(), name === 'flag' ? 'app' : 'none', name); assert.equal(directOnAndroid(), true, name); });
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
