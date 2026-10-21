import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { encryptPushPayload, vapidAuthorization, generateVapidKeys, pushEndpointAllowed, pushKeysValid } from '../services/webPush';

// إشعارات الويب لتنبيهات الحضور (services/webPush.ts) — بلا مكتبة، فالمرجع المعيار نفسه.
const unb64u = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

test('تشفير الرسالة يطابق المثال الرسمي في RFC 8291 (القسم ٥ والملحق A) حرفاً حرفاً', () => {
  const plaintext = Buffer.from('When I grow up, I want to be a watermelon', 'ascii');
  const uaPublic = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
  const authSecret = 'BTBZMqHH6r4Tts7J_aSIgg';
  const out = encryptPushPayload(plaintext, uaPublic, authSecret, {
    asPrivate: unb64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
    salt: unb64u('DGv6ra1nlYgDCS1FRnbzlw'),
  });
  const expected = unb64u(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
    mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
    pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`);
  // ترويسة ٨٦ + نصّ مشفّر ٥٨ (الملحق A) = ١٤٤ بايتاً هي بايتات المثال نفسها — و«Content-Length: 145» في القسم ٥ سهوٌ في المعيار
  assert.equal(out.length, 144);
  assert.ok(out.equals(expected), 'الرسالة المشفّرة تطابق المعيار');
  assert.ok(out.subarray(86).equals(unb64u('8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ')), 'النصّ المشفّر كما في الملحق A');
});

test('المتصفّح يفكّ ما نشفّره بمفاتيح عشوائية (المسار الفعلي بلا قيم ثابتة)', () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const b64u = (b: Buffer) => b.toString('base64url');
  const msg = Buffer.from(JSON.stringify({ title: 'تنبيه', body: 'لم تسجّل انصرافك' }), 'utf8');
  const out = encryptPushPayload(msg, b64u(ua.getPublicKey()), b64u(auth));
  // فكّ وفق المعيار من جهة المتصفّح
  const salt = out.subarray(0, 16);
  assert.equal(out.readUInt32BE(16), 4096);
  const idlen = out.readUInt8(20);
  const asPublic = out.subarray(21, 21 + idlen);
  const secret = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));
  const ct = out.subarray(21 + idlen);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 0x02, 'فاصل السجلّ الأخير');
  assert.equal(plain.subarray(0, plain.length - 1).toString('utf8'), msg.toString('utf8'));
});

test('توقيع VAPID: JWT بـES256 يتحقّق بالمفتاح العامّ، وجمهوره أصل خدمة الإشعارات، وصلاحيته ١٢ ساعة', () => {
  const keys = generateVapidKeys();
  assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65);
  assert.equal(Buffer.from(keys.privateKey, 'base64url').length, 32);
  const h = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:support@fieldsa.net', 1_000_000);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
  assert.ok(m, h);
  assert.equal(m[4], keys.publicKey);
  const payload = JSON.parse(Buffer.from(m[2], 'base64url').toString());
  assert.deepEqual(payload, { aud: 'https://fcm.googleapis.com', exp: 1_000_000 + 43200, sub: 'mailto:support@fieldsa.net' });
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const pubKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
});

test('رابط الاشتراك: https لمزوّدي الإشعارات وحدهم — لا عناوين داخلية (SSRF)', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://web.push.apple.com/QOx', 'https://wns2-par02p.notify.windows.com/w/?token=1']) assert.ok(pushEndpointAllowed(ok), ok);
  for (const bad of ['http://fcm.googleapis.com/x', 'https://localhost/x', 'https://169.254.169.254/latest', 'https://evil.com/fcm.googleapis.com',
    'https://fcm.googleapis.com.evil.com/x', 'https://fcm.googleapis.com:8443/x', 'ftp://fcm.googleapis.com/x', 42, null, 'not a url'])
    assert.ok(!pushEndpointAllowed(bad), String(bad));
});

test('مفاتيح الاشتراك تُفحص عند الاشتراك: نقطةٌ على المنحنى وسرّ ١٦ بايتاً — والفاسد عند الإرسال يُحذف ولا يوقف دورة التنبيهات (مراجعة ٢١ أكتوبر)', () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const good = ua.getPublicKey().toString('base64url');
  const auth = crypto.randomBytes(16).toString('base64url');
  assert.equal(pushKeysValid(good, auth), true);
  assert.equal(pushKeysValid(crypto.randomBytes(45).toString('base64url'), auth), false, '٤٥ بايتاً');
  const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
  assert.equal(pushKeysValid(offCurve, auth), false, 'نقطةٌ خارج المنحنى');
  assert.equal(pushKeysValid(good, crypto.randomBytes(12).toString('base64url')), false, 'سرٌّ قصير');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'webPush.ts'), 'utf8');
  const send = src.slice(src.indexOf('export async function sendPush('), src.indexOf('export async function sendPushToRep('));
  assert.match(send, /try \{\s*body = encryptPushPayload\(/, 'التشفير داخل try');
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tracking.ts'), 'utf8');
  assert.match(route, /if \(!pushKeysValid\(b\.subscription\.keys\.p256dh, b\.subscription\.keys\.auth\)\)/);
  const alerts = fs.readFileSync(path.join(__dirname, '..', 'services', 'attendanceAlerts.ts'), 'utf8');
  assert.match(alerts, /sendPushToRep\(rep\.id, [^\n]*\)\.catch\(\(\) => 0\)/, 'عطل مندوبٍ لا يوقف من بعده');
  // «نسيت الانصراف» مرّةً واحدة: مفتاحه يبقى بعد نافذة النوبات المفتوحة، ولا يُحذف مع مفاتيح «قبل الدوام»
  assert.doesNotMatch(alerts, /key: \{ startsWith: 'att:' \}/);
  assert.match(alerts, /key: \{ startsWith: 'att:out:' \}, createdAt: \{ lt: new Date\(now\.getTime\(\) - \(FORGOT_LOOKBACK_DAYS \+ 3\) \* DAY\) \}/);
  assert.match(alerts, /checkOutAt: null, checkInAt: \{ gte: new Date\(now\.getTime\(\) - FORGOT_LOOKBACK_DAYS \* DAY\) \}/);
});

test('جوالٌ واحد لا يُربط بمندوبين: كل ربطٍ قائم يمنع ولو أُطفئ قيد صاحبه، وإطفاء القيد يفكّ الربط بسطر تدقيق', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tracking.ts'), 'utf8');
  assert.match(route, /where: \{ tenantId: tid, id: \{ not: repId \}, boundDeviceId: device\.id \},/);
  const reps = fs.readFileSync(path.join(__dirname, '..', 'routes', 'salesReps.ts'), 'utf8');
  assert.match(reps, /const unbind = rest\.requireBoundDevice === false && current\.boundDeviceId != null;/);
  assert.match(reps, /if \(unbind\) Object\.assign\(updateData, \{ boundDeviceId: null, boundDeviceName: null, boundDeviceAt: null \}\);/);
  assert.match(reps, /action: 'UNBIND_DEVICE', reason: 'أُطفئ قيد ربط البصمة بجهاز واحد'/);
});
