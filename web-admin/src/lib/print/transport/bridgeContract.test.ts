// حارس عقد جسر الطباعة: ملفات تطبيق أندرويد (android-rep، قراءةً فقط) تحمل الثوابت نفسها وتعلن ما يعتمده الويب —
// PrintActivity بمخطّط fieldsaprint ومضيفَيه وأذونات البلوتوث، ووحدة التحصيل بالبطاقة في مكانها كما هي (main) يُزيلها
// src/printonly من البناء بلا رمز NearPay، وLauncherActivity يضيف fsbridge، والإصدار 8 / 1.2.2 (تفويض الموقع — ٣ نوفمبر ٢٠٢٦). وعقد التحصيل بالبطاقة
// في الخادم لم يتغيّر. افتراقُ أيٍّ منها يكسر الطباعة بصمت على الجوال — فيُكسر هنا أوّلاً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './bridgeContract';
import { SPP_UUID } from './btSerial';

const SRC = fileURLToPath(new URL('../../../', import.meta.url));
const ROOT = path.join(SRC, '..', '..');
const APP = path.join(ROOT, 'android-rep', 'app');
const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n');
const noXmlComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '');
const noGroovyComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** عناصر وسمٍ واحد بصفاتها */
function elements(xml: string, tag: string): Array<Record<string, string>> {
  return [...xml.matchAll(new RegExp(`<${tag}\\b([^>]*?)/?>`, 'g'))].map((m) => Object.fromEntries([...m[1].matchAll(/([\w:.]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])));
}
const permissions = (xml: string) => elements(xml, 'uses-permission').map((e) => e['android:name']);

test('BridgeContract.kt = bridgeContract.ts قيمةً بقيمة', () => {
  const kt = read(APP, 'src', 'main', 'java', 'net', 'fieldsa', 'twa', 'print', 'BridgeContract.kt');
  const got = new Map<string, string | number>();
  for (const m of kt.matchAll(/const val (\w+)(?:: \w+)? = ("([^"]*)"|[\d_]+)/g)) {
    got.set(m[1], m[3] !== undefined ? m[3] : Number(m[2].replace(/_/g, '')));
  }
  const want: Array<[string, string | number]> = [
    ['SCHEME', C.BRIDGE_SCHEME], ['HOST_PRINT', C.BRIDGE_HOST_PRINT], ['HOST_PRINTER', C.BRIDGE_HOST_PRINTER],
    ['PARAM_PAYLOAD', C.BRIDGE_PARAM_PAYLOAD], ['PARAM_KEY', C.BRIDGE_PARAM_KEY], ['LAUNCH_PARAM', C.BRIDGE_LAUNCH_PARAM],
    ['PROTOCOL_VERSION', C.BRIDGE_PROTOCOL_VERSION], ['PACKAGE', C.BRIDGE_PACKAGE], ['FORMAT_VERSION', C.PAYLOAD_FORMAT_VERSION],
    ['HEADER_BYTES', C.PAYLOAD_HEADER_BYTES], ['MAX_PAYLOAD_CHARS', C.MAX_PAYLOAD_CHARS], ['MAX_INNER_BYTES', C.MAX_INNER_BYTES],
    ['MAX_JOB_BYTES', C.MAX_JOB_BYTES], ['MAX_MARKS', C.MAX_MARKS], ['MAX_LABEL_BYTES', C.MAX_LABEL_BYTES],
    ['MAX_CANCEL_BYTES', C.MAX_CANCEL_BYTES], ['KEY_LENGTH', C.BRIDGE_KEY_LENGTH],
  ];
  for (const [name, value] of want) assert.equal(got.get(name), value, `BridgeContract.${name}`);
  assert.equal(String(got.get('SPP_UUID') ?? '').toLowerCase(), SPP_UUID.toLowerCase(), 'BridgeContract.SPP_UUID');
  // ثوابت الويب نفسها متّسقة
  assert.equal(C.PLAY_STORE_URL, `https://play.google.com/store/apps/details?id=${C.BRIDGE_PACKAGE}`);
  assert.ok(C.BRIDGE_KEY_RE.test('A'.repeat(C.BRIDGE_KEY_LENGTH)) && !C.BRIDGE_KEY_RE.test('A'.repeat(C.BRIDGE_KEY_LENGTH + 1)));
});

test('عقد تطبيق الآيفون (FieldSales/PrintPayload.swift enum FSP): القيم المثبّتة في المواصفة §C.1', () => {
  assert.equal(C.IOS_HANDLER, 'fsPrint');
  assert.equal(C.IOS_MARKER, '__fsIosBridge');
  assert.equal(C.IOS_BRIDGE_VERSION, 1);
  assert.equal(C.IOS_PROGRESS_EVENT, 'fs-ios-print');
  assert.equal(C.IOS_MAX_PAYLOAD_CHARS, 1_572_864);
  assert.equal(C.IOS_MAX_JOB_BYTES, 1_048_576);
  assert.equal(C.APP_STORE_URL, 'https://apps.apple.com/app/id6797991968');
  assert.equal(C.IOS_SYSTEM_PRINT_VIA_APP, true);
  assert.equal(C.IOS_JOB_ID_RE.source, '^[A-Za-z0-9_-]{8,64}$');
  for (const ok of ['A'.repeat(8), 'a_b-C9'.padEnd(64, 'x')]) assert.ok(C.IOS_JOB_ID_RE.test(ok), ok);
  for (const bad of ['A'.repeat(7), 'A'.repeat(65), 'abc def12', 'abcdefg+', 'abcdefg=']) assert.ok(!C.IOS_JOB_ID_RE.test(bad), bad);
  // الحمولة الخام تتسع لأكبر مهمة آيفون مع الرأس وحاشية الداخل (علامات ووسمٌ وإلغاء) — والسقفان فوق أندرويد وتحت حدود الصيغة
  assert.ok(C.IOS_MAX_PAYLOAD_CHARS >= Math.ceil(((C.IOS_MAX_JOB_BYTES + 200 + C.PAYLOAD_HEADER_BYTES) * 4) / 3));
  assert.ok(C.IOS_MAX_PAYLOAD_CHARS > C.MAX_PAYLOAD_CHARS);
  assert.ok(C.IOS_MAX_JOB_BYTES <= C.MAX_JOB_BYTES);
  assert.ok(Math.floor((C.IOS_MAX_PAYLOAD_CHARS * 3) / 4) <= C.MAX_INNER_BYTES + C.PAYLOAD_HEADER_BYTES);
});

test('AndroidManifest (main): PrintActivity بمخطّط fieldsaprint، وأذونات البلوتوث بلا بحثٍ ولا إدارة', () => {
  const xml = noXmlComments(read(APP, 'src', 'main', 'AndroidManifest.xml'));
  const block = /<activity\b[^>]*android:name="net\.fieldsa\.twa\.print\.PrintActivity"[^>]*>[\s\S]*?<\/activity>/.exec(xml)?.[0];
  assert.ok(block, 'PrintActivity');
  const tag = block.slice(0, block.indexOf('>') + 1);
  for (const attr of ['android:exported="true"', 'android:launchMode="singleTask"', 'android:taskAffinity="net.fieldsa.twa.print"',
    'android:excludeFromRecents="true"', 'android:autoRemoveFromRecents="true"', 'android:persistableMode="persistNever"',
    'android:theme="@style/Theme.FieldSales.Print"']) {
    assert.ok(tag.includes(attr), `PrintActivity ${attr}`);
  }
  const filter = /<intent-filter\b[\s\S]*?<\/intent-filter>/.exec(block)?.[0] ?? '';
  for (const s of ['android.intent.action.VIEW', 'android.intent.category.DEFAULT', 'android.intent.category.BROWSABLE']) assert.ok(filter.includes(`"${s}"`), s);
  const data = elements(filter, 'data');
  assert.ok(data.length >= 2 && data.every((d) => d['android:scheme'] === undefined || d['android:scheme'] === C.BRIDGE_SCHEME));
  assert.ok(data.some((d) => d['android:scheme'] === C.BRIDGE_SCHEME), 'scheme fieldsaprint');
  const hosts = data.map((d) => d['android:host']).filter(Boolean).sort();
  assert.deepEqual(hosts, [C.BRIDGE_HOST_PRINT, C.BRIDGE_HOST_PRINTER]);

  const perms = elements(xml, 'uses-permission');
  const bt = perms.find((p) => p['android:name'] === 'android.permission.BLUETOOTH');
  assert.equal(bt?.['android:maxSdkVersion'], '30', 'BLUETOOTH حتى أندرويد 11');
  assert.ok(permissions(xml).includes('android.permission.BLUETOOTH_CONNECT'));
  const feature = elements(xml, 'uses-feature').find((f) => f['android:name'] === 'android.hardware.bluetooth');
  assert.equal(feature?.['android:required'], 'false', 'البلوتوث غير لازم للتثبيت');
  for (const p of ['BLUETOOTH_SCAN', 'BLUETOOTH_ADMIN']) {
    assert.ok(!permissions(xml).includes(`android.permission.${p}`), `main يطلب ${p}`);
  }
});

// أذونات وحدة التحصيل بالبطاقة الست (main كما في الأصل، وsrc/printonly يُزيلها بلا الرمز)
const CARDPAY_PERMS = ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION', 'ACCESS_NETWORK_STATE', 'INTERNET', 'READ_PHONE_STATE', 'NFC'];

test('وحدة التحصيل بالبطاقة في مكانها (main) كما هي، وsrc/printonly يُزيل نشاطها وأذوناتها الست وميزة NFC بلا الرمز', () => {
  const main = noXmlComments(read(APP, 'src', 'main', 'AndroidManifest.xml'));
  assert.ok(main.includes('net.fieldsa.twa.cardpay.CardPayActivity'));
  assert.ok(main.includes('android:scheme="fieldsapay"'));
  assert.ok(main.includes('android:host="cardpay"'));
  for (const p of CARDPAY_PERMS) assert.ok(permissions(main).includes(`android.permission.${p}`), `main ${p}`);
  for (const f of ['CardPayActivity.kt', 'LaunchApi.kt', 'NearpaySession.kt']) {
    assert.ok(fs.existsSync(path.join(APP, 'src', 'main', 'java', 'net', 'fieldsa', 'twa', 'cardpay', f)), `cardpay/${f}`);
  }

  const only = noXmlComments(read(APP, 'src', 'printonly', 'AndroidManifest.xml'));
  const removed = (tag: string) => elements(only, tag).filter((e) => e['tools:node'] === 'remove').map((e) => e['android:name']).sort();
  assert.deepEqual(removed('uses-permission'), CARDPAY_PERMS.map((p) => `android.permission.${p}`).sort());
  assert.deepEqual(removed('uses-feature'), ['android.hardware.nfc']);
  assert.deepEqual(removed('activity'), ['net.fieldsa.twa.cardpay.CardPayActivity']);
  // لا يُزيل شيئاً من جسر الطباعة
  assert.ok(!only.includes('PrintActivity') && !only.includes('BLUETOOTH'), 'printonly يمسّ جسر الطباعة');
});

test('LauncherActivity يضيف علامة الجسر بعد تنظيف cardpay', () => {
  const java = read(APP, 'src', 'main', 'java', 'net', 'fieldsa', 'twa', 'LauncherActivity.java');
  assert.ok(java.includes('appendPrintBridge(stripStaleCardPay('));
  assert.ok(java.includes('BridgeContract.LAUNCH_PARAM'));
  assert.ok(java.includes('BridgeContract.PROTOCOL_VERSION'));
});

test('app/build.gradle: الإصدار 8 / 1.2.2، ويُبنى بلا رمز NearPay — واعتمادا NearPay داخل if (cardPayBuild) وحدها', () => {
  const g = noGroovyComments(read(APP, 'build.gradle'));
  assert.match(g, /\bversionCode 8\b/);
  assert.ok(g.includes('versionName "1.2.2"'));
  assert.ok(!g.includes('throw new GradleException'), 'البناء بلا الرمز يفشل');
  assert.match(g, /def cardPayBuild = rootProject\.ext\.nearpayTokenPresent/);
  // مدى كل كتلة «رأس { … }» بموازنة الأقواس
  const blocks = (head: RegExp): Array<[number, number]> => [...g.matchAll(head)].map((m) => {
    let depth = 0;
    const start = (m.index as number) + m[0].length - 1;
    let i = start;
    for (; i < g.length; i++) {
      if (g[i] === '{') depth++;
      else if (g[i] === '}' && --depth === 0) break;
    }
    return [start, i];
  });
  const ranges = blocks(/if \(cardPayBuild\) \{/g);
  for (const dep of ['io.nearpay:terminalsdk-release:0.2.6', 'com.google.android.gms:play-services-location:20.0.0']) {
    const at = [...g.matchAll(new RegExp(dep.replace(/[.:]/g, (c) => `\\${c}`), 'g'))].map((m) => m.index as number);
    assert.ok(at.length >= 1, `${dep} غائب`);
    for (const i of at) assert.ok(ranges.some(([a, b]) => i > a && i < b), `${dep} خارج if (cardPayBuild)`);
  }
  // بلا الرمز: بيان printonly لـdebug وrelease، ومصادر cardpay خارج الترجمة — داخل if (!cardPayBuild) وحدها
  const notRanges = blocks(/if \(!cardPayBuild\) \{/g);
  for (const needle of ["debug.manifest.srcFile 'src/printonly/AndroidManifest.xml'", "release.manifest.srcFile 'src/printonly/AndroidManifest.xml'", "exclude 'net/fieldsa/twa/cardpay/**'"]) {
    const i = g.indexOf(needle);
    assert.ok(i >= 0, `${needle} غائب`);
    assert.ok(notRanges.some(([a, b]) => i > a && i < b), `${needle} خارج if (!cardPayBuild)`);
  }
});

test('twa-manifest.json بالإصدار نفسه، وعقد التحصيل بالبطاقة في الخادم لم يتغيّر', () => {
  const twa = JSON.parse(read(ROOT, 'android-rep', 'twa-manifest.json')) as Record<string, unknown>;
  assert.equal(twa.appVersionCode, 8);
  assert.equal(twa.appVersionName, '1.2.2');
  assert.equal(twa.appVersion, '1.2.2');
  assert.ok(read(ROOT, 'backend', 'src', 'services', 'cardPayment.ts').includes('scheme=fieldsapay;package=net.fieldsa.twa'));
});
