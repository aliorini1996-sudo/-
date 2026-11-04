// إشعارات آيفون (APNs) لتطبيق المندوب — services/apnsPush.ts (طلب المالك، ٤ نوفمبر ٢٠٢٦).
// كلّه بلا شبكة ولا أسرار: مفتاح P-256 يُولَّد هنا، و«خادم Apple» خادم HTTP/2 محلّي بلا TLS (h2c) على 127.0.0.1.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import http2 from 'http2';
import path from 'path';
import type { AddressInfo } from 'net';
import {
  apnsTokenValid, apnsEndpoint, isApnsEndpoint, parseApnsEndpoint, parseP8, apnsConfigFromEnv, apnsConfigured, apnsProviderToken,
  apnsRequest, classifyApns, sendApns, _apnsTestHooks, _resetApns, apnsStatus, PRESENCE_SOUND, APNS_MAX_PAYLOAD,
} from '../services/apnsPush';
import { pushEndpointAllowed } from '../services/webPush';

const SRC = path.join(__dirname, '..');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const TOKEN = 'a'.repeat(64);
const ENV = { APNS_KEY_P8: PEM, APNS_KEY_ID: 'ABC123DEFG', APNS_TEAM_ID: 'TEAM123456' };
const clearEnv = () => { for (const k of ['APNS_KEY_P8', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_TOPIC']) delete process.env[k]; };

// rst: يُغلق التيار برمزٍ قبل أي ردّ · goawayErr: GOAWAY بخطأ وآخر تيارٍ «عولج» = هذا التيار (self) أو ما قبله (before)
// delayMs: الردّ يتأخّر
type Reply = { status: number; reason?: string; hang?: boolean; goaway?: boolean; rst?: number; goawayErr?: 'self' | 'before'; delayMs?: number };
let replies: Reply[] = [];
let seen: { headers: http2.IncomingHttpHeaders; body: string }[] = [];
let sessionsOpened = 0;
/** اتصالاتٌ ما زالت مفتوحة عند الخادم — اتصالٌ يتيم يبقى فيها */
const serverOpen = new Set<http2.ServerHttp2Session>();
const server = http2.createServer(); // h2c: HTTP/2 بلا TLS — لا شهادة تُولَّد
server.on('session', (s) => { sessionsOpened++; serverOpen.add(s); s.on('close', () => serverOpen.delete(s)); s.on('error', () => { /* العميل هدمه */ }); });
server.on('stream', (stream, headers) => {
  const chunks: Buffer[] = [];
  stream.on('error', () => { /* العميل ألغاه */ });
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => {
    seen.push({ headers, body: Buffer.concat(chunks).toString('utf8') });
    const r = replies.shift() ?? { status: 200 };
    if (r.hang) return;
    if (r.goaway) { stream.session?.goaway(http2.constants.NGHTTP2_NO_ERROR, 0, Buffer.from('{"reason":"Shutdown"}')); return; }
    if (r.rst) { stream.close(r.rst); return; }
    if (r.goawayErr) { stream.session?.goaway(http2.constants.NGHTTP2_PROTOCOL_ERROR, r.goawayErr === 'self' ? stream.id : stream.id - 2); return; }
    if (r.delayMs) { setTimeout(() => { if (!stream.destroyed) stream.respond({ ':status': 200 }, { endStream: true }); }, r.delayMs); return; }
    if (r.status === 200) { stream.respond({ ':status': 200, 'apns-id': String(headers['apns-id']) }, { endStream: true }); return; }
    stream.respond({ ':status': r.status, 'content-type': 'application/json' });
    stream.end(JSON.stringify({ reason: r.reason }));
  });
});
let origin = '';
const ready = new Promise<void>((res) => server.listen(0, '127.0.0.1', () => { origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }));
after(() => { _resetApns(); clearEnv(); server.close(); });

beforeEach(async () => {
  await ready;
  _resetApns();
  for (const s of serverOpen) s.destroy(); // طرف الخادم بعد GOAWAY بخطأ قد يبقى مفتوحاً (سلوك خادم Node) — لا يعبر إلى الاختبار التالي
  clearEnv();
  Object.assign(process.env, ENV);
  _apnsTestHooks({ origins: { production: origin, sandbox: origin }, timeoutMs: 400 });
  replies = []; seen = []; sessionsOpened = 0;
});

test('رمز الجهاز وعنوانه: ست عشريّ صغير زوجيّ ٦٤–٢٠٠، والعنوان apns:<البيئة>:<الرمز> ذهاباً وإياباً', () => {
  assert.ok(apnsTokenValid(TOKEN));
  assert.ok(apnsTokenValid('ab'.repeat(50)), 'أطول من ٦٤ مقبول (Apple: لا تفترض الطول)');
  for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'a'.repeat(62), 'g'.repeat(64), 'a'.repeat(202),
    `${'a'.repeat(32)}:${'a'.repeat(31)}`, `${'a'.repeat(32)}/${'a'.repeat(31)}`, `${'a'.repeat(62)}:a`, ` ${'a'.repeat(64)}`, '', 42, null, undefined])
    assert.ok(!apnsTokenValid(bad), JSON.stringify(bad));
  assert.equal(apnsEndpoint('production', TOKEN.toUpperCase()), `apns:production:${TOKEN}`, 'العنوان بالحروف الصغيرة');
  for (const env of ['production', 'sandbox'] as const)
    for (const tok of [TOKEN, 'ab'.repeat(50), crypto.randomBytes(32).toString('hex')])
      assert.deepEqual(parseApnsEndpoint(apnsEndpoint(env, tok)), { env, token: tok });
  assert.equal(parseApnsEndpoint(`apns:staging:${TOKEN}`), null);
  assert.equal(parseApnsEndpoint(`apns:production:${'A'.repeat(64)}`), null);
  assert.equal(parseApnsEndpoint(`apns:production:${'a'.repeat(63)}`), null);
  assert.equal(parseApnsEndpoint(`apns:production:${TOKEN}/x`), null);
  assert.equal(parseApnsEndpoint('https://web.push.apple.com/x'), null);
  assert.ok(isApnsEndpoint(`apns:production:${TOKEN}`));
  for (const no of ['https://web.push.apple.com/x', 'APNS:production:x', '', 42, null]) assert.ok(!isApnsEndpoint(no), String(no));
  // حارس SSRF في الويب لا يقبل عنوان آيفون أبداً: لا يُرسل إليه fetch ولا يُقبل في /push/subscribe
  assert.equal(pushEndpointAllowed(apnsEndpoint('production', TOKEN)), false);
  assert.equal(pushEndpointAllowed(apnsEndpoint('sandbox', TOKEN)), false);
});

test('المفتاح: PEM وbase64 وDER وسطرٌ واحد بـ\\n وبين علامتي اقتباس — وغير P-256 مرفوض، والإعداد الناقص خامل', () => {
  assert.ok(parseP8(PEM));
  assert.ok(parseP8(Buffer.from(PEM).toString('base64')));
  assert.ok(parseP8(PEM.replace(/\n/g, '\\n')));
  assert.ok(parseP8(PEM.replace(/\n/g, '\\r\\n')));
  assert.ok(parseP8(`"${PEM.trim()}"`));
  assert.ok(parseP8(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')));
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  assert.equal(parseP8(rsa), null);
  const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  assert.equal(parseP8(p384), null, 'ES256 يشترط P-256');
  assert.equal(parseP8('garbage'), null);
  assert.equal(parseP8(''), null);
  assert.equal(apnsConfigFromEnv({}), null, 'بلا متغيّرات: خامل');
  assert.equal(apnsConfigFromEnv({ ...ENV, APNS_KEY_ID: 'short' }), null);
  assert.equal(apnsConfigFromEnv({ ...ENV, APNS_TEAM_ID: '' }), null, 'ناقص');
  assert.equal(apnsConfigFromEnv({ ...ENV, APNS_KEY_P8: 'garbage' }), null);
  assert.equal(apnsConfigFromEnv({ ...ENV })?.topic, 'net.fieldsa.rep');
  assert.equal(apnsConfigFromEnv({ ...ENV, APNS_TOPIC: '' })?.topic, 'net.fieldsa.rep', 'APNS_TOPIC="" كما في env.example');
  assert.equal(apnsConfigFromEnv({ ...ENV, APNS_TOPIC: 'net.example.other' })?.topic, 'net.example.other');
  assert.equal(apnsConfigured(), true);
  clearEnv(); _resetApns();
  assert.equal(apnsConfigured(), false);
});

test('JWT: ES256 بـkid وiss وiat ويتحقّق بالمفتاح العامّ', () => {
  const t = apnsProviderToken({ keyId: 'ABC123DEFG', teamId: 'TEAM123456', key: privateKey }, 1_700_000_000);
  const [h, c, s] = t.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'ES256', kid: 'ABC123DEFG' });
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url').toString()), { iss: 'TEAM123456', iat: 1_700_000_000 });
  assert.equal(Buffer.from(s, 'base64url').length, 64, 'r||s (IEEE P1363) لا DER');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('جسم «أثبت تواجدك» حرفياً كما في العقد: tag وurl وcheckId في المستوى الأعلى بعد aps، بصوته وtime-sensitive', () => {
  assert.equal(PRESENCE_SOUND, 'presence-alarm.wav');
  const r = apnsRequest({ title: 'أثبت تواجدك', body: 'افتح التطبيق', url: '/rep?screen=presence', tag: 'presence', checkId: 'c1' }, 900, 1_000_000_000);
  assert.ok(r);
  assert.equal(r!.body.toString('utf8'),
    '{"aps":{"alert":{"title":"أثبت تواجدك","body":"افتح التطبيق"},"sound":"presence-alarm.wav","interruption-level":"time-sensitive","relevance-score":1,"thread-id":"presence"},"tag":"presence","url":"/rep?screen=presence","checkId":"c1"}');
  const j = JSON.parse(r!.body.toString());
  assert.deepEqual(Object.keys(j), ['aps', 'tag', 'url', 'checkId']);
  assert.equal(j.fs, undefined, 'لا غلاف fs');
  assert.equal(j.aps['interruption-level'], 'time-sensitive');
  assert.equal(j.aps['thread-id'], 'presence');
  assert.equal(j.aps['relevance-score'], 1);
  assert.equal(r!.expiration, 1_000_000 + 900, 'الانتهاء = الآن + المدّة');
  assert.equal(r!.collapseId, 'presence');
});

test('جسم تنبيهات الحضور: الصوت الافتراضي وactive وخيط attendance وبلا checkId — وبلا وسمٍ لا مفتاح tag ومعرّف الطيّ fieldsales', () => {
  const r = apnsRequest({ title: 'تذكير', body: 'دوامك يبدأ', url: '/rep?screen=attendance', tag: 'att-PRE_SHIFT' }, 3600, 2_000_000_000)!;
  assert.equal(r.body.toString('utf8'),
    '{"aps":{"alert":{"title":"تذكير","body":"دوامك يبدأ"},"sound":"default","interruption-level":"active","relevance-score":0.5,"thread-id":"attendance"},"tag":"att-PRE_SHIFT","url":"/rep?screen=attendance"}');
  assert.equal(r.collapseId, 'att-PRE_SHIFT');
  assert.equal(r.expiration, 2_000_000 + 3600);
  const j = JSON.parse(r.body.toString());
  assert.ok(!('checkId' in j) && !('fs' in j));
  const bare = JSON.parse(apnsRequest({ title: 't', body: 'b', checkId: 5 }, 60, 0)!.body.toString());
  assert.deepEqual(Object.keys(bare), ['aps', 'url'], 'checkId غير النصّي يُترك، ولا tag');
  assert.equal(bare.url, '/rep');
  assert.equal(apnsRequest({ title: 't', body: 'b' }, 60, 0)!.collapseId, 'fieldsales');
  assert.equal(apnsRequest({ title: 't', body: 'b', tag: 'x'.repeat(100) }, 60, 0)!.collapseId.length, 64, 'معرّف الطيّ ≤ ٦٤ بايتاً');
});

test('حدّ ٤٠٩٦ بايتاً: يُقصّ نصّ الرسالة بلا كسر حرف (عربي، رموز تعبيرية، علامات تُهرَّب في JSON) — وعنوانٌ يتجاوز الحدّ وحده ⇒ لا رسالة', () => {
  for (const body of ['ب'.repeat(5000), '😀'.repeat(2000), '"\\'.repeat(3000), 'a\n'.repeat(3000)]) {
    const r = apnsRequest({ title: 't', body, tag: 'presence', checkId: 'c1', url: '/rep?screen=presence' }, 60, 0)!;
    assert.ok(r, 'يُقصّ ولا يُرفض');
    assert.ok(r.body.length <= APNS_MAX_PAYLOAD, String(r.body.length));
    assert.ok(r.body.length > APNS_MAX_PAYLOAD - 16, 'أطول ما يتّسع');
    const j = JSON.parse(r.body.toString('utf8'));
    assert.ok(body.startsWith(j.aps.alert.body) && j.aps.alert.body.length > 0);
    assert.doesNotMatch(j.aps.alert.body, /[\uD800-\uDBFF]$/, 'لا نصف زوجٍ بديل');
    assert.equal(j.checkId, 'c1', 'المفاتيح الأخرى سليمة');
  }
  assert.equal(apnsRequest({ title: 'ب'.repeat(3000), body: 'b' }, 60, 0), null);
});

test('تصنيف الردود', () => {
  assert.deepEqual(classifyApns(200, undefined, false), { result: 'sent' });
  assert.equal(classifyApns(410, 'Unregistered', false).result, 'gone');
  assert.equal(classifyApns(410, 'ExpiredToken', false).result, 'gone');
  assert.equal(classifyApns(400, 'BadDeviceToken', false).result, 'failed', 'قبل أول نجاح: قد يكون إعدادنا لا الرمز');
  assert.equal(classifyApns(400, 'BadDeviceToken', true).result, 'gone');
  assert.equal(classifyApns(400, 'DeviceTokenNotForTopic', true).result, 'gone');
  assert.equal(classifyApns(400, 'DeviceTokenNotForTopic', false).result, 'failed');
  assert.deepEqual(classifyApns(403, 'ExpiredProviderToken', true), { result: 'failed', action: 'refresh-jwt' });
  for (const re of ['InvalidProviderToken', 'BadEnvironmentKeyIdInToken', 'UnrelatedKeyIdInToken', 'MissingProviderToken', 'Forbidden',
    'TopicDisallowed', 'BadTopic', 'MissingTopic', 'BadCertificate', 'BadCertificateEnvironment'])
    assert.deepEqual(classifyApns(re === 'BadTopic' || re === 'MissingTopic' ? 400 : 403, re, true), { result: 'failed', action: 'config' }, re);
  assert.deepEqual(classifyApns(503, 'ServiceUnavailable', true), { result: 'failed', action: 'drop-session' });
  for (const [st, re] of [[429, 'TooManyProviderTokenUpdates'], [429, 'TooManyRequests'], [500, 'InternalServerError'], [413, 'PayloadTooLarge'], [404, 'BadPath'], [405, 'MethodNotAllowed']] as const)
    assert.deepEqual(classifyApns(st, re, true), { result: 'failed' }, re);
});

const P = { title: 'أثبت تواجدك', body: 'افتح التطبيق', url: '/rep?screen=presence', tag: 'presence', checkId: 'c1' };

test('الإرسال عبر HTTP/2 حقيقي: الترويسات والمسار والجسم، واتصالٌ واحد يُعاد استعماله', async () => {
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P, { ttlSec: 900 }), 'sent');
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P, { ttlSec: 900 }), 'sent');
  assert.equal(sessionsOpened, 1);
  const h = seen[0].headers;
  assert.equal(h[':path'], `/3/device/${TOKEN}`);
  assert.equal(h[':method'], 'POST');
  assert.equal(h['apns-topic'], 'net.fieldsa.rep');
  assert.equal(h['apns-push-type'], 'alert');
  assert.equal(h['apns-priority'], '10');
  assert.equal(h['apns-collapse-id'], 'presence');
  assert.equal(h['content-type'], 'application/json');
  assert.match(String(h['apns-id']), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(seen[0].headers['apns-id'], seen[1].headers['apns-id']);
  assert.match(String(h.authorization), /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  const [jh] = String(h.authorization).slice(7).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(jh, 'base64url').toString()), { alg: 'ES256', kid: 'ABC123DEFG' });
  assert.ok(Math.abs(Number(h['apns-expiration']) - (Math.floor(Date.now() / 1000) + 900)) <= 2);
  assert.equal(seen[0].headers.authorization, seen[1].headers.authorization, 'الرمز نفسه يُعاد (لا TooManyProviderTokenUpdates)');
  const j = JSON.parse(seen[0].body);
  assert.equal(j.aps.alert.title, 'أثبت تواجدك');
  assert.equal(j.aps.sound, 'presence-alarm.wav');
  assert.equal(j.checkId, 'c1');
  // تنبيه الحضور بلا ttlSec: ساعة
  assert.equal(await sendApns(`apns:sandbox:${TOKEN}`, { title: 't', body: 'b', url: '/rep?screen=attendance', tag: 'att-FORGOT_CHECKOUT' }), 'sent');
  assert.ok(Math.abs(Number(seen[2].headers['apns-expiration']) - (Math.floor(Date.now() / 1000) + 3600)) <= 2);
  assert.equal(seen[2].headers['apns-collapse-id'], 'att-FORGOT_CHECKOUT');
  assert.equal(JSON.parse(seen[2].body).aps['interruption-level'], 'active');
});

test('410 يحذف، وBadDeviceToken يحذف بعد أول نجاحٍ في البيئة نفسها فقط', async () => {
  replies = [{ status: 410, reason: 'Unregistered' }];
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'gone');
  replies = [{ status: 400, reason: 'BadDeviceToken' }];
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'failed');
  replies = [{ status: 200 }, { status: 400, reason: 'BadDeviceToken' }, { status: 400, reason: 'BadDeviceToken' }];
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'sent');
  assert.equal(await sendApns(`apns:production:${'b'.repeat(64)}`, P), 'gone');
  assert.equal(await sendApns(`apns:sandbox:${'b'.repeat(64)}`, P), 'failed', 'نجاح الإنتاج لا يثبت بيئة التجربة');
  assert.deepEqual(apnsStatus().proven, ['production']);
});

test('ExpiredProviderToken: رمزٌ جديد على اتصالٍ جديد ومحاولةٌ ثانية واحدة — ورمزٌ أصغر من ٢٠ دقيقة لا يتجدّد', async () => {
  let now = Date.now();
  _apnsTestHooks({ now: () => now });
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'sent');
  now += 25 * 60_000;
  replies = [{ status: 403, reason: 'ExpiredProviderToken' }, { status: 200 }];
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'sent');
  assert.notEqual(seen[1].headers.authorization, seen[2].headers.authorization);
  assert.equal(sessionsOpened, 2);
  // رمزٌ عمره ٥ دقائق: محاولةٌ ثانية واحدة على اتصالٍ جديد بالرمز نفسه، ثمّ failed (لا حلقة)
  now += 5 * 60_000;
  replies = [{ status: 403, reason: 'ExpiredProviderToken' }, { status: 403, reason: 'ExpiredProviderToken' }];
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'failed');
  assert.equal(seen.length, 5, 'طلبان لا أكثر');
  assert.equal(seen[3].headers.authorization, seen[4].headers.authorization);
  assert.equal(seen[2].headers.authorization, seen[3].headers.authorization);
});

test('JWT يتجدّد عند ٥٠ دقيقة ويبقى قبلها', async () => {
  let now = Date.now();
  _apnsTestHooks({ now: () => now });
  await sendApns(`apns:production:${TOKEN}`, P);
  now += 49 * 60_000;
  await sendApns(`apns:production:${TOKEN}`, P);
  now += 2 * 60_000;
  await sendApns(`apns:production:${TOKEN}`, P);
  assert.equal(seen[0].headers.authorization, seen[1].headers.authorization);
  assert.notEqual(seen[1].headers.authorization, seen[2].headers.authorization);
});

test('رفض الإعداد (InvalidProviderToken) يوقف البيئة مؤقتاً ولا يحذف — والأخرى تعمل', async () => {
  replies = [{ status: 403, reason: 'InvalidProviderToken' }];
  assert.equal(await sendApns(`apns:sandbox:${TOKEN}`, P), 'failed');
  const before = seen.length;
  assert.equal(await sendApns(`apns:sandbox:${TOKEN}`, P), 'failed');
  assert.equal(seen.length, before, 'لا طلب أثناء التبريد');
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'sent');
  assert.deepEqual(apnsStatus().cooling, ['sandbox']);
  assert.equal(apnsStatus().lastError?.reason, 'InvalidProviderToken');
  assert.doesNotMatch(JSON.stringify(apnsStatus()), new RegExp(TOKEN), 'لا رموز في الحالة');
});

test('بلا إعداد: لا شبكة، والاشتراك يبقى (failed لا gone) — وعنوانٌ فاسد gone بلا شبكة', async () => {
  delete process.env.APNS_KEY_P8;
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'failed');
  clearEnv();
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'failed');
  assert.equal(await sendApns(`apns:sandbox:${TOKEN}`, P), 'failed');
  assert.equal(seen.length, 0);
  assert.equal(sessionsOpened, 0);
  Object.assign(process.env, ENV);
  assert.equal(await sendApns('apns:production:zz', P), 'gone');
  assert.equal(await sendApns(`apns:production:${TOKEN}`, { title: 1, body: 'b' }), 'failed', 'رسالةٌ بلا عنوان نصّي');
  assert.equal(await sendApns(`apns:production:${TOKEN}`, { title: 'ب'.repeat(3000), body: 'b' }), 'failed', 'أكبر من الحدّ');
  assert.equal(seen.length, 0);
});

test('المهلة: خادمٌ لا يردّ ⇒ failed دون تعليق', async () => {
  replies = [{ status: 0, hang: true }];
  const t0 = Date.now();
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'failed');
  assert.ok(Date.now() - t0 < 2000);
});

test('GOAWAY: الاتصال يُترك والإرسال التالي يفتح اتصالاً جديداً', async () => {
  replies = [{ status: 0, goaway: true }, { status: 200 }];
  const r = await sendApns(`apns:production:${TOKEN}`, P);
  assert.ok(r === 'sent' || r === 'failed', r);
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'sent');
  assert.ok(sessionsOpened >= 2);
});

test('ثلاث مهلٍ متتالية تُبرِّد البيئة: الرابع فوري بلا شبكة', async () => {
  replies = [{ status: 0, hang: true }, { status: 0, hang: true }, { status: 0, hang: true }];
  for (let i = 0; i < 3; i++) assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'failed');
  const n = seen.length; const t0 = Date.now();
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'failed');
  assert.ok(Date.now() - t0 < 50); assert.equal(seen.length, n);
  assert.ok(sessionsOpened >= 3, 'كل مهلةٍ تهدم اتصالها');
});

test('خادمٌ مغلق (ECONNREFUSED): failed لا يرمي', async () => {
  const dead = http2.createServer();
  const port = await new Promise<number>((res) => dead.listen(0, '127.0.0.1', () => res((dead.address() as AddressInfo).port)));
  await new Promise<void>((res) => dead.close(() => res()));
  _apnsTestHooks({ origins: { production: `http://127.0.0.1:${port}` } });
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'failed');
});

// ─── مراجعة النقل (٤ نوفمبر ٢٠٢٦): لا إعادة لطلبٍ ربما عولج، ولا اتصالٌ يتيم، ومهلة تيارٍ لا تقتل غيره ───
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test('RST قبل الردّ (INTERNAL_ERROR): failed بلا إعادة (ربما عولج)، والاتصال السليم يبقى ويُعاد استعماله — ثلاثٌ متتالية تُبرِّد وتعتزله', async () => {
  await settle();
  replies = [{ status: 0, rst: http2.constants.NGHTTP2_INTERNAL_ERROR }];
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'failed');
  assert.equal(seen.length, 1, 'طلبٌ وصل كاملاً لا يُرسَل ثانيةً (منبّهٌ يرنّ مرّتين)');
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'sent');
  await settle();
  assert.equal(sessionsOpened, 1, 'خطأ تيارٍ لا يُسقط الاتصال');
  assert.equal(serverOpen.size, 1, 'ولا اتصالٌ يتيم مفتوح');
  replies = [1, 2, 3].map(() => ({ status: 0, rst: http2.constants.NGHTTP2_INTERNAL_ERROR }));
  for (let i = 0; i < 3; i++) assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'failed');
  assert.equal(seen.length, 5);
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'failed', 'مُبرَّدة: بلا شبكة');
  assert.equal(seen.length, 5);
  await settle();
  assert.equal(serverOpen.size, 0, 'الاتصال الذي رفض كل تيار يُعتزل');
  assert.equal(sessionsOpened, 1);
});

test('REFUSED_STREAM: يُعاد مرّةً على الاتصال السليم نفسه ⇒ sent', async () => {
  replies = [{ status: 0, rst: http2.constants.NGHTTP2_REFUSED_STREAM }, { status: 200 }];
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'sent');
  assert.equal(seen.length, 2);
  assert.equal(sessionsOpened, 1);
});

test('GOAWAY بخطأ: التيار فوق آخر ما عالجه الخادم يُعاد على اتصالٍ جديد، وما عالجه لا يُعاد', async () => {
  replies = [{ status: 200 }, { status: 0, goawayErr: 'before' }, { status: 200 }];
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'sent');
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'sent', 'لم يُعالَج ⇒ يُعاد');
  assert.equal(seen.length, 3);
  assert.equal(sessionsOpened, 2);
  replies = [{ status: 0, goawayErr: 'self' }];
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'failed', 'عولج ولم يُجب ⇒ لا يُعاد');
  assert.equal(seen.length, 4);
});

test('مهلة تيارٍ معلّق لا تقتل تياراً سليماً من الدورة الأخرى على الاتصال نفسه — والاتصال يُعتزل: التالي على جديد والقديم يُغلق بعد أن يكمل', async () => {
  await settle();
  _apnsTestHooks({ timeoutMs: 1000 });
  replies = [{ status: 0, hang: true }, { status: 200, delayMs: 700 }];
  const a = sendApns(`apns:production:${TOKEN}`, P);
  await settle(600);
  const b = sendApns(`apns:production:${TOKEN}`, { title: 'نسيت الانصراف', body: 'سجّل انصرافك', tag: 'att-FORGOT_CHECKOUT', url: '/rep?screen=attendance' });
  assert.equal(await a, 'failed');
  assert.equal(await b, 'sent', 'وصل الخادمَ وأُجيب بعد مهلة الأوّل: لا «لم يصل»');
  assert.equal(seen.length, 2);
  assert.equal(sessionsOpened, 1);
  assert.equal(await sendApns(`apns:production:${TOKEN}`, P), 'sent');
  assert.equal(sessionsOpened, 2, 'الاتصال المشكوك فيه لا يُبنى عليه جديد');
  await settle();
  assert.equal(serverOpen.size, 1, 'القديم أُغلق بعد أن أكمل تياره');
});

// ─── حرّاس ثابتة على المصدر ───
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name);
  if (d.isDirectory()) return d.name === 'tests' ? [] : walk(p);
  return /\.(ts|js|mjs|cjs|json)$/.test(d.name) && !/\.test\.ts$/.test(d.name) ? [p] : [];
});
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join('/');

test('حرّاس: دورتا التنبيهات كما هما (تصلهما صفوف الآيفون تلقائياً)، ولا مسار مفتاحٍ ولا مجلّد أسرار، والبيئة في apnsPush وحده', () => {
  const presence = fs.readFileSync(path.join(SRC, 'services', 'presenceChecks.ts'), 'utf8');
  assert.match(presence, /sendPushToRep\(/);
  const alerts = fs.readFileSync(path.join(SRC, 'services', 'attendanceAlerts.ts'), 'utf8');
  assert.match(alerts, /pushSubscriptions: \{ some: \{\} \}/);
  const files = walk(SRC);
  assert.ok(files.length > 50, 'المسح يرى المصدر');
  const SECRET_DIR = ['bdr', 'secrets'].join('-');
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!s.includes('.p8'), `${rel(f)}: مسار ملف مفتاح`);
    assert.ok(!s.includes(SECRET_DIR), `${rel(f)}: مجلّد الأسرار`);
  }
  const readers = files.filter((f) => /process\.env\.APNS_|APNS_(KEY_P8|KEY_ID|TEAM_ID|TOPIC)/.test(fs.readFileSync(f, 'utf8'))).map(rel);
  assert.deepEqual(readers, ['services/apnsPush.ts']);
  const apns = fs.readFileSync(path.join(SRC, 'services', 'apnsPush.ts'), 'utf8');
  assert.match(apns, /import type \{ PushResult \} from '\.\/webPush';/, 'نوعٌ فقط: لا حلقة استيراد وقت التشغيل');
  const logs = apns.split('\n').filter((l) => /console\.\w+\(/.test(l));
  assert.equal(logs.length, 2, 'سطرا سجلّ فقط: إعدادٌ غير صالح، ورفضٌ للإعداد');
  for (const line of logs) // لا رمز جهاز ولا JWT ولا مفتاح ولا عنوان اشتراك في السجلّ
    assert.doesNotMatch(line, /\$\{(?:token|jwt|cfg|key|endpoint|parsed|headers|msg|p\b)|\$\{raw\}|authorization|bearer|APNS_KEY_P8/, line);
  for (const host of ["'https://api.push.apple.com'", "'https://api.sandbox.push.apple.com'"]) assert.ok(apns.includes(host), host);
});
