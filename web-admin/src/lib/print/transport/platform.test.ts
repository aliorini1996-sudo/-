// طريق الطباعة المباشرة لكل جهاز بوكلاء حقيقيين: Web Serial ⇒ serial كاليوم؛ أندرويد بلا Web Serial (Chrome قديم،
// Samsung Internet ولو بوضع سطح المكتب، WebView، Firefox) ⇒ app؛ iOS وسطح المكتب بلا Web Serial ⇒ none كاليوم.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_BRIDGE_FOR_ALL, classifyPrintPlatform, type PlatformInput } from './platform';

const UA = {
  chrome140Android: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  chrome120Android: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  samsungDesktop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Safari/537.36',
  webView: 'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.0.0 Mobile Safari/537.36',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  windowsFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  linuxChrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};

// المصفوفة أدناه بعد فتح الجسر للجميع (bridgeForAll)؛ وبوّابة ما قبل النشر في اختبارها الأخير
const at = (i: Partial<PlatformInput> & { ua: string }) => classifyPrintPlatform({ hasSerial: false, bridgeForAll: true, ...i });

test('أندرويد: Web Serial ⇒ serial، وبدونه ⇒ app بأيّ متصفح', () => {
  assert.deepEqual(at({ ua: UA.chrome140Android, hasSerial: true }), { os: 'android', path: 'serial' });
  assert.deepEqual(at({ ua: UA.chrome140Android }), { os: 'android', path: 'app' });
  assert.deepEqual(at({ ua: UA.chrome120Android }), { os: 'android', path: 'app' });
  assert.deepEqual(at({ ua: UA.samsung }), { os: 'android', path: 'app' });
  assert.deepEqual(at({ ua: UA.samsungDesktop }), { os: 'android', path: 'app' }, 'وضع سطح المكتب في Samsung Internet');
  assert.deepEqual(at({ ua: UA.webView }), { os: 'android', path: 'app' });
  assert.deepEqual(at({ ua: UA.firefoxAndroid }), { os: 'android', path: 'app' });
});

test('iOS وسطح المكتب: كاليوم — serial إن وُجد وإلا none', () => {
  assert.deepEqual(at({ ua: UA.iphone, maxTouchPoints: 5 }), { os: 'ios', path: 'none' });
  assert.deepEqual(at({ ua: UA.ipadDesktop, maxTouchPoints: 5 }), { os: 'ios', path: 'none' }, 'iPad بوكيل Macintosh');
  assert.deepEqual(at({ ua: UA.ipadDesktop, maxTouchPoints: 0 }), { os: 'other', path: 'none' }, 'Mac حقيقي');
  assert.deepEqual(at({ ua: UA.windowsChrome, hasSerial: true }), { os: 'other', path: 'serial' });
  assert.deepEqual(at({ ua: UA.windowsFirefox }), { os: 'other', path: 'none' });
  assert.deepEqual(at({ ua: UA.linuxChrome }), { os: 'other', path: 'none' });
  assert.deepEqual(at({ ua: 'Node.js/24' }), { os: 'other', path: 'none' });
});

test('وكيلٌ مكتبيّ على أندرويد يُعرف من userAgentData أو مُحيل التطبيق أو علامة الجسر', () => {
  assert.deepEqual(at({ ua: UA.linuxChrome, uaDataPlatform: 'Android' }), { os: 'android', path: 'app' });
  assert.deepEqual(at({ ua: UA.linuxChrome, referrer: 'android-app://net.fieldsa.twa/' }), { os: 'android', path: 'app' });
  assert.deepEqual(at({ ua: UA.linuxChrome, bridgeFlag: true }), { os: 'android', path: 'app' });
  assert.deepEqual(at({ ua: UA.linuxChrome, referrer: 'https://www.google.com/', uaDataPlatform: 'Linux', bridgeFlag: false }), { os: 'other', path: 'none' });
});

test('iOS يبقى iOS ولو حمل علامة الجسر أو مُحيل التطبيق — Chrome وFirefox على iOS وEdge المكتبيّ وSamsung بـWeb Serial', () => {
  const crios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1';
  const fxios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/128.0 Mobile/15E148 Safari/605.1.15';
  const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';
  assert.deepEqual(at({ ua: crios, maxTouchPoints: 5 }), { os: 'ios', path: 'none' });
  assert.deepEqual(at({ ua: fxios, maxTouchPoints: 5 }), { os: 'ios', path: 'none' });
  assert.deepEqual(at({ ua: UA.iphone, bridgeFlag: true, referrer: 'android-app://net.fieldsa.twa/', uaDataPlatform: 'Android' }), { os: 'ios', path: 'none' });
  assert.deepEqual(at({ ua: UA.ipadDesktop, maxTouchPoints: 5, bridgeFlag: true }), { os: 'ios', path: 'none' });
  assert.deepEqual(at({ ua: edge, hasSerial: true, uaDataPlatform: 'Windows' }), { os: 'other', path: 'serial' });
  assert.deepEqual(at({ ua: edge }), { os: 'other', path: 'none' });
  assert.deepEqual(at({ ua: UA.samsung, hasSerial: true }), { os: 'android', path: 'serial' }, 'Web Serial حيث وُجد هو الطريق دائماً');
});

test('بوّابة النشر مفتوحة منذ نشر 1.2.0 في الإنتاج: أندرويد بلا Web Serial ⇒ app بلا علامة الجسر', () => {
  assert.equal(APP_BRIDGE_FOR_ALL, true, 'قُلب true في ١ نوفمبر ٢٠٢٦ بعد نشر الإصدار 6 للجميع');
  const open = (i: Partial<PlatformInput> & { ua: string }) => classifyPrintPlatform({ hasSerial: false, ...i });
  assert.deepEqual(open({ ua: UA.samsung }), { os: 'android', path: 'app' });
  assert.deepEqual(open({ ua: UA.chrome120Android, referrer: 'android-app://net.fieldsa.twa/' }), { os: 'android', path: 'app' });
  assert.deepEqual(open({ ua: UA.iphone, maxTouchPoints: 5 }), { os: 'ios', path: 'none' }, 'الآيفون كما هو');
  assert.deepEqual(open({ ua: UA.windowsFirefox }), { os: 'other', path: 'none' }, 'سطح المكتب كما هو');
});

test('منطق البوّابة إن أُطفئت: علامة الجسر وحدها تفتح التطبيق — والمُحيل وحده لا يكفي (النسخة 3 تضعه)', () => {
  const gated = (i: Partial<PlatformInput> & { ua: string }) => classifyPrintPlatform({ hasSerial: false, bridgeForAll: false, ...i });
  assert.deepEqual(gated({ ua: UA.samsung }), { os: 'android', path: 'none' });
  assert.deepEqual(gated({ ua: UA.chrome120Android, referrer: 'android-app://net.fieldsa.twa/' }), { os: 'android', path: 'none' });
  assert.deepEqual(gated({ ua: UA.samsung, bridgeFlag: true }), { os: 'android', path: 'app' });
  assert.deepEqual(gated({ ua: UA.chrome140Android, hasSerial: true }), { os: 'android', path: 'serial' }, 'Web Serial كاليوم');
  assert.deepEqual(gated({ ua: UA.samsung, bridgeForAll: true }), { os: 'android', path: 'app' });
  assert.deepEqual(gated({ ua: UA.iphone, maxTouchPoints: 5, bridgeForAll: true }), { os: 'ios', path: 'none' });
});
