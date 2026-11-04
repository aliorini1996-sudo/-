// «التحصيل بالبطاقة» على الآيفون مخفيٌّ كما هو اليوم (قرار المالك ١ نوفمبر ٢٠٢٦ — تحديث الآيفون 1.1.0 للطباعة وحدها): الزرّ
// يظهر بوحدة الدفع في تطبيق أندرويد وحده. وكيل تطبيق فيلد سيلز على الآيفون (… FieldSales) وسفاري لا يحملان «Android» — فلا زرّ؛
// وأندرويد يبقى كما هو. يقفل هذا الحارس «مخفيٌّ على iOS» فلا يظهر الزرّ خطأً.
//
// CardPay.tsx لا يُستورد في Node (repApi ⇒ import.meta.env لـVite) — فالدالة نفسها تُقتطع من المصدر كما هي وتُترجم وتُشغَّل
// بـnavigator مزيّف: ما يُختبر هو ما يُشحن حرفاً بحرف، لا نسخةٌ عنه.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC = fileURLToPath(new URL('../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

const UA = {
  iosApp: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1 FieldSales',
  iosSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  androidWebView: 'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.0.0 Mobile Safari/537.36',
  windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};

/** cardPayDeviceSupported كما في CardPay.tsx — مقتطعةً ومترجمةً، وnavigator معاملٌ يحلّ محلّ العامّ */
function shippedPredicate(): (navigator: unknown) => boolean {
  const s = read('rep/CardPay.tsx');
  const start = s.indexOf('export function cardPayDeviceSupported(): boolean {');
  assert.ok(start >= 0, 'cardPayDeviceSupported غائبة من CardPay.tsx');
  const end = s.indexOf('\n}\n', start);
  assert.ok(end > start);
  const fnTs = s.slice(start, end + 2).replace(/^export /, '');
  const js = ts.transpileModule(fnTs, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  return new Function('navigator', `${js}\nreturn cardPayDeviceSupported();`) as (navigator: unknown) => boolean;
}

test('زرّ «تحصيل بالبطاقة» مخفيٌّ على الآيفون: تطبيق فيلد سيلز (1.0 و1.1.0) وسفاري وChrome على iOS وiPad', () => {
  const supported = shippedPredicate();
  assert.equal(supported({ userAgent: UA.iosApp }), false, 'تطبيق الآيفون');
  assert.equal(supported({ userAgent: UA.iosSafari }), false, 'سفاري');
  assert.equal(supported({ userAgent: UA.iosChrome }), false, 'Chrome على iOS');
  assert.equal(supported({ userAgent: UA.ipadDesktop }), false, 'iPad بوكيل Macintosh');
  assert.equal(supported(undefined), false, 'بلا navigator');
});

test('أندرويد كما هو: الزرّ ممكنٌ في Chrome والتطبيق — وسطح المكتب لا', () => {
  const supported = shippedPredicate();
  assert.equal(supported({ userAgent: UA.androidChrome }), true);
  assert.equal(supported({ userAgent: UA.androidWebView }), true);
  assert.equal(supported({ userAgent: UA.windowsChrome }), false);
});

test('الزرّ في RepApp لا يظهر إلا بشرط الجهاز — وجسر الطباعة على الآيفون لا يُدخل التحصيل بالبطاقة', () => {
  const app = read('rep/RepApp.tsx');
  assert.match(app, /\{accountingOn && cardPayOn && cardPayDeviceSupported\(\) && \(/);
  // مسار الآيفون للطباعة وحدها: لا ذكر للتحصيل بالبطاقة في جسره ولا في عقده — ولا في جسر إشعاراته (iosPush.ts)
  for (const f of ['lib/print/transport/iosBridge.ts', 'lib/print/transport/bridgeContract.ts', 'lib/print/transport/platform.ts', 'rep/iosPush.ts']) {
    assert.doesNotMatch(read(f), /cardpay|card-pay|cardPay|fsCardPay/i, f);
  }
});
