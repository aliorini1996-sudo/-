// إشعارات آيفون عبر المسار الفعلي (webPush.sendPushToRep → sendPush → apnsPush.sendApns) فوق Prisma مزيّف في الذاكرة وخادم
// HTTP/2 محلّي بلا TLS (h2c) — بلا قاعدة ولا شبكة ولا أسرار (مفتاح P-256 يُولَّد هنا). الرسائل من presencePayload
// وalertPayload الحقيقيتين، فما يصل الجهاز هو ما تبنيه دورتا التنبيهات اليوم بلا تغيير فيهما.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http2 from 'node:http2';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ─── rep_push_subscriptions في الذاكرة ───
type Row = { id: string; salesRepId: string; endpoint: string; p256dh: string; auth: string };
let rows: Row[] = [];
let deleted: string[] = [];
const repPushSubscription = {
  async findMany(args: { where: { salesRepId: string }; select: Record<string, boolean> }) {
    return rows.filter((r) => r.salesRepId === args.where.salesRepId).map((r) => ({ id: r.id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
  },
  async delete(args: { where: { id: string } }) {
    deleted.push(args.where.id);
    rows = rows.filter((r) => r.id !== args.where.id);
    return {};
  },
};
const opsMarker = { async findUnique() { throw new Error('لا قراءة لمفاتيح VAPID في هذا المسار'); }, async create() { throw new Error('لا كتابة'); } };
stub('config/database', { default: { repPushSubscription, opsMarker } });

/* eslint-disable @typescript-eslint/no-var-requires */
const { sendPushToRep } = require('../services/webPush') as typeof import('../services/webPush');
const { _apnsTestHooks, _resetApns } = require('../services/apnsPush') as typeof import('../services/apnsPush');
const { presencePayload } = require('../services/presenceChecks') as typeof import('../services/presenceChecks');
const { alertPayload } = require('../services/attendanceAlerts') as typeof import('../services/attendanceAlerts');
/* eslint-enable @typescript-eslint/no-var-requires */

const PEM = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const ENV = { APNS_KEY_P8: PEM, APNS_KEY_ID: 'KEYID12345', APNS_TEAM_ID: 'QKD58WVK2R' };
const clearEnv = () => { for (const k of ['APNS_KEY_P8', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_TOPIC']) delete process.env[k]; };
const TOK_OK = 'a'.repeat(64);
const TOK_GONE = 'b'.repeat(64);
const TOK_BAD = 'c'.repeat(64);

// «Apple»: الرمز يقرّر الردّ — a ⇒ 200، b ⇒ 410 Unregistered، c ⇒ 400 BadDeviceToken
let seen: { headers: http2.IncomingHttpHeaders; body: string }[] = [];
let sessionsOpened = 0;
const server = http2.createServer();
server.on('session', () => { sessionsOpened++; });
server.on('stream', (stream, headers) => {
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => {
    seen.push({ headers, body: Buffer.concat(chunks).toString('utf8') });
    const p = String(headers[':path']);
    if (p.endsWith(TOK_OK)) { stream.respond({ ':status': 200 }, { endStream: true }); return; }
    const [status, reason] = p.endsWith(TOK_GONE) ? [410, 'Unregistered'] : [400, 'BadDeviceToken'];
    stream.respond({ ':status': status, 'content-type': 'application/json' });
    stream.end(JSON.stringify({ reason }));
  });
});
let origin = '';
const ready = new Promise<void>((res) => server.listen(0, '127.0.0.1', () => { origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }));
after(() => { _resetApns(); clearEnv(); server.close(); });

beforeEach(async () => {
  await ready;
  _resetApns(); clearEnv();
  _apnsTestHooks({ origins: { production: origin, sandbox: origin }, timeoutMs: 1000 });
  seen = []; sessionsOpened = 0; deleted = [];
  rows = [
    { id: 'ok', salesRepId: 'rep1', endpoint: `apns:production:${TOK_OK}`, p256dh: '', auth: '' },
    { id: 'gone', salesRepId: 'rep1', endpoint: `apns:production:${TOK_GONE}`, p256dh: '', auth: '' },
    { id: 'evil', salesRepId: 'rep1', endpoint: 'https://evil.example/x', p256dh: 'x', auth: 'y' },
    { id: 'other', salesRepId: 'rep2', endpoint: `apns:production:${TOK_GONE}`, p256dh: '', auth: '' },
  ];
});

test('«أثبت تواجدك» لآيفون: يصل الرمز الحيّ بجسم العقد حرفياً، ويُحذف 410 والرابط المرفوض وحدهما', async () => {
  Object.assign(process.env, ENV);
  const payload = presencePayload('ar', 'chk-1');
  const sent = await sendPushToRep('rep1', payload, { ttlSec: 900 });
  assert.equal(sent, 1);
  assert.deepEqual(deleted.sort(), ['evil', 'gone']);
  assert.deepEqual(rows.map((r) => r.id).sort(), ['ok', 'other'], 'صفّ مندوبٍ آخر لا يُمسّ');
  assert.equal(seen.length, 2, 'الرابط المرفوض لا يُطلب أبداً');
  const ok = seen.find((s) => String(s.headers[':path']).endsWith(TOK_OK))!;
  assert.equal(ok.headers[':path'], `/3/device/${TOK_OK}`);
  assert.equal(ok.body, JSON.stringify({
    aps: { alert: { title: payload.title, body: payload.body }, sound: 'presence-alarm.wav', 'interruption-level': 'time-sensitive', 'relevance-score': 1, 'thread-id': 'presence' },
    tag: 'presence', url: '/rep?screen=presence', checkId: 'chk-1',
  }));
  assert.match(ok.body, /^\{"aps":\{"alert":\{"title":"أثبت تواجدك",/);
  assert.equal(ok.headers['apns-collapse-id'], 'presence');
  assert.equal(ok.headers['apns-topic'], 'net.fieldsa.rep');
  assert.ok(Math.abs(Number(ok.headers['apns-expiration']) - (Math.floor(Date.now() / 1000) + 900)) <= 2, 'ينتهي مع نافذة الردّ');
  assert.equal(sessionsOpened, 1, 'جلسةٌ واحدة للبيئة');
});

test('تنبيه الحضور لآيفون: الصوت الافتراضي وactive وبلا checkId، وساعةٌ افتراضاً', async () => {
  Object.assign(process.env, ENV);
  rows = rows.filter((r) => r.id === 'ok');
  const payload = alertPayload('PRE_SHIFT', new Date(), 180, 'ar');
  assert.equal(await sendPushToRep('rep1', payload), 1);
  const j = JSON.parse(seen[0].body);
  assert.deepEqual(Object.keys(j), ['aps', 'tag', 'url']);
  assert.equal(j.tag, 'att-PRE_SHIFT');
  assert.equal(j.url, '/rep?screen=attendance');
  assert.deepEqual(j.aps, { alert: { title: payload.title, body: payload.body }, sound: 'default', 'interruption-level': 'active', 'relevance-score': 0.5, 'thread-id': 'attendance' });
  assert.equal(seen[0].headers['apns-collapse-id'], 'att-PRE_SHIFT');
  assert.ok(Math.abs(Number(seen[0].headers['apns-expiration']) - (Math.floor(Date.now() / 1000) + 3600)) <= 2);
});

test('BadDeviceToken قبل أي نجاح في البيئة لا يحذف (موضوعٌ أو بيئةٌ خاطئة لا تمسح كل الرموز)، وبعده يحذف', async () => {
  Object.assign(process.env, ENV);
  rows = [{ id: 'bad', salesRepId: 'rep1', endpoint: `apns:production:${TOK_BAD}`, p256dh: '', auth: '' }];
  assert.equal(await sendPushToRep('rep1', presencePayload('ar', 'chk-2')), 0);
  assert.deepEqual(deleted, []);
  rows = [
    { id: 'ok', salesRepId: 'rep1', endpoint: `apns:production:${TOK_OK}`, p256dh: '', auth: '' },
    { id: 'bad', salesRepId: 'rep1', endpoint: `apns:production:${TOK_BAD}`, p256dh: '', auth: '' },
  ];
  assert.equal(await sendPushToRep('rep1', presencePayload('ar', 'chk-3')), 1);
  assert.deepEqual(deleted, ['bad']);
});

test('بلا متغيّرات APNs: لا طلب ولا حذف، والصفوف باقية حتى يلصق المالك المفتاح', async () => {
  rows = rows.filter((r) => r.endpoint.startsWith('apns:'));
  const before = rows.length;
  assert.equal(await sendPushToRep('rep1', presencePayload('ar', 'chk-4'), { ttlSec: 900 }), 0);
  assert.equal(await sendPushToRep('rep1', alertPayload('FORGOT_CHECKOUT', new Date(), 180, 'ar')), 0);
  assert.deepEqual(deleted, []);
  assert.equal(rows.length, before);
  assert.equal(seen.length, 0);
  assert.equal(sessionsOpened, 0);
});
