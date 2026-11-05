// اشتراك آيفون — POST /tracking/push/apns (routes/tracking.ts) فوق Prisma مزيّف في الذاكرة، بلا قاعدة ولا شبكة.
// نثبت: المندوب وحده وبميزة البصمة، والرمز يُفحص ويُصغَّر، والصفّ apns:<البيئة>:<الرمز> بمفتاحين فارغين، وينتقل الجهاز إلى
// من سجّل دخوله، والأحدث خمسة، وإزاحة التوقيت تُحفظ، وactive يعكس ضبط المفتاح — والخروج بالمسار القائم /push/unsubscribe.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { ZodError } from 'zod';
import type { Router } from 'express';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ─── rep_push_subscriptions في الذاكرة (endpoint فريد كما في المخطط) ───
type Sub = { id: string; tenantId: string; salesRepId: string; endpoint: string; p256dh: string; auth: string; lang: string | null; updatedAt: Date };
let subs: Sub[] = [];
let seq = 0;
let clock = 0;
const tick = () => new Date(1_700_000_000_000 + ++clock * 1000);
let upserts: unknown[] = [];
let deletes: unknown[] = [];
let repUpdates: unknown[] = [];
const repPushSubscription = {
  async upsert(args: { where: { endpoint: string }; create: Omit<Sub, 'id' | 'updatedAt'>; update: Partial<Sub> }) {
    upserts.push(args);
    const cur = subs.find((s) => s.endpoint === args.where.endpoint);
    if (cur) { Object.assign(cur, args.update, { updatedAt: tick() }); return { ...cur }; }
    const row: Sub = { id: `p${++seq}`, ...args.create, updatedAt: tick() };
    subs.push(row);
    return { ...row };
  },
  async findMany(args: { where: { salesRepId: string }; orderBy: { updatedAt: 'desc' }; skip?: number; select: { id: true } }) {
    assert.deepEqual(args.orderBy, { updatedAt: 'desc' });
    return subs.filter((s) => s.salesRepId === args.where.salesRepId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(args.skip ?? 0)
      .map((s) => ({ id: s.id }));
  },
  async deleteMany(args: { where: { id?: { in: string[] }; endpoint?: string; salesRepId?: string } }) {
    deletes.push(args);
    const w = args.where;
    const hit = (s: Sub) => (w.id ? w.id.in.includes(s.id) : true) && (w.endpoint === undefined || s.endpoint === w.endpoint)
      && (w.salesRepId === undefined || s.salesRepId === w.salesRepId);
    const before = subs.length;
    subs = subs.filter((s) => !hit(s));
    return { count: before - subs.length };
  },
};
let featureOn = true;
const tenant = { async findUnique() { return { attendanceEnabled: featureOn }; } };
const salesRep = { async update(args: unknown) { repUpdates.push(args); return {}; } };
const db: Record<string, unknown> = { repPushSubscription, tenant, salesRep, $queryRaw: async () => [], $executeRaw: async () => 0 };
db.$transaction = async (fn: (tx: unknown) => unknown) => fn(db);
stub('config/database', { default: db });
stub('middleware/auth', {
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdminPermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  tenantId: (req: { user?: { tenantId?: string } }) => req.user!.tenantId!,
});
stub('services/adminScope', { adminRepFilter: async () => ({}), scopedRepRecordWhere: async () => ({}), scopedRecordWhere: async () => ({}), canAccessRep: async () => true, SHAPE_VISIT: {} });
stub('services/mapMatch', { snapToRoads: async () => [], routeThrough: async () => [] });
stub('services/routeShape', { buildRouteShape: () => ({}), haversineM: () => 0 });
stub('services/repHeartbeat', { heartbeatClientState: () => ({}) });

/* eslint-disable @typescript-eslint/no-var-requires */
const router = require('../routes/tracking').default as Router;
const { _resetApns } = require('../services/apnsPush') as typeof import('../services/apnsPush');
/* eslint-enable @typescript-eslint/no-var-requires */

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => unknown }[] } }
function handler(method: 'get' | 'post', p: string) {
  for (const l of (router as unknown as { stack: Layer[] }).stack) {
    const r = l.route;
    if (r && r.path === p && r.methods[method]) return r.stack[r.stack.length - 1].handle;
  }
  throw new Error(`نقطة غير مسجّلة: ${method} ${p}`);
}
function mockRes() {
  const res = { statusCode: 200, body: null as Record<string, unknown> | null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b as Record<string, unknown>; return this; } };
  return res;
}
const REP = { role: 'SALES_REP', id: 'rep1', tenantId: 't1' };
const REP2 = { role: 'SALES_REP', id: 'rep2', tenantId: 't2' };
async function call(method: 'get' | 'post', p: string, opts: { user?: unknown; body?: unknown } = {}) {
  const res = mockRes();
  await handler(method, p)({ user: 'user' in opts ? opts.user : REP, body: opts.body ?? {}, query: {}, get: () => undefined }, res, (e?: unknown) => { if (e) throw e; });
  return res;
}
const data = (res: { body: Record<string, unknown> | null }) => (res.body!.data as Record<string, unknown>);
const clearEnv = () => { for (const k of ['APNS_KEY_P8', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_TOPIC']) delete process.env[k]; };
const T = (n: number) => n.toString(16).padStart(2, '0').repeat(32); // رمزٌ صالح مختلف لكل n

beforeEach(() => {
  subs = []; seq = 0; clock = 0; upserts = []; deletes = []; repUpdates = []; featureOn = true;
  clearEnv(); _resetApns();
});
after(() => { clearEnv(); _resetApns(); });

test('غير المندوب ممنوع (403)، والميزة المطفأة 403 ATTENDANCE_DISABLED — ولا حفظ', async () => {
  const admin = await call('post', '/push/apns', { user: { role: 'COMPANY_ADMIN', id: 'u1', tenantId: 't1' }, body: { token: T(1), env: 'production' } });
  assert.equal(admin.statusCode, 403);
  const anon = await call('post', '/push/apns', { user: undefined, body: { token: T(1), env: 'production' } });
  assert.equal(anon.statusCode, 403);
  featureOn = false;
  const off = await call('post', '/push/apns', { body: { token: T(1), env: 'production' } });
  assert.equal(off.statusCode, 403);
  assert.equal(off.body!.code, 'ATTENDANCE_DISABLED');
  assert.equal(upserts.length, 0);
});

test('البصمة مطفأة لشركة من دخل: الجهاز يُطلَق — صفّه يُحذف أيّاً كان صاحبه (خروجٌ بلا شبكة، ولو من شركةٍ أخرى) والردّ 403 كما هو', async () => {
  await call('post', '/push/apns', { body: { token: T(1), env: 'production' } }); // rep1 (t1) على الجهاز
  await call('post', '/push/apns', { body: { token: T(2), env: 'production' } }); // جهازٌ آخر لـrep1
  await call('post', '/push/apns', { body: { token: T(1), env: 'sandbox' } }); // الرمز نفسه في البيئة الأخرى صفٌّ آخر
  featureOn = false;
  const n = upserts.length;
  const res = await call('post', '/push/apns', { user: REP2, body: { token: ` ${T(1).toUpperCase()}\n`, env: 'production' } });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { success: false, code: 'ATTENDANCE_DISABLED', message: 'ميزة بصمة الحضور غير مفعّلة' });
  assert.deepEqual(deletes.at(-1), { where: { endpoint: `apns:production:${T(1)}` } }, 'بالعنوان وحده: أيّاً كان المندوب والشركة');
  assert.deepEqual(subs.map((s) => s.endpoint).sort(), [`apns:production:${T(2)}`, `apns:sandbox:${T(1)}`].sort(), 'جهاز rep1 الآخر وبيئةٌ أخرى لا يُمسّان');
  assert.equal(upserts.length, n, 'لا أخذ للجهاز والبصمة مطفأة');
  // جسمٌ فاسد أو رمزٌ فاسد أو غير مندوب: الـ403 نفسه بلا حذف
  const d = deletes.length;
  for (const body of [{ token: 'z'.repeat(64), env: 'production' }, { token: T(2) }, { token: T(2), env: 'development' }, {}, { token: `${'a'.repeat(32)}:${'a'.repeat(31)}`, env: 'production' }]) {
    const r = await call('post', '/push/apns', { user: REP2, body });
    assert.equal(r.statusCode, 403, JSON.stringify(body));
    assert.equal(r.body!.code, 'ATTENDANCE_DISABLED');
  }
  const admin = await call('post', '/push/apns', { user: { role: 'COMPANY_ADMIN', id: 'u1', tenantId: 't2' }, body: { token: T(2), env: 'production' } });
  assert.equal(admin.statusCode, 403);
  assert.equal(deletes.length, d);
  assert.equal(subs.length, 2);
});

test('رمزٌ فاسد ⇒ 400 «رمز الإشعارات غير صالح» بلا حفظ', async () => {
  for (const token of [`${'a'.repeat(63)} `, 'z'.repeat(64), 'a'.repeat(65), `${'a'.repeat(32)}:${'a'.repeat(31)}`, `${'a'.repeat(32)}/${'a'.repeat(31)}`,
    `${'a'.repeat(62)}\n\n`, 'é'.repeat(64)]) {
    const res = await call('post', '/push/apns', { body: { token, env: 'production' } });
    assert.equal(res.statusCode, 400, JSON.stringify(token));
    assert.deepEqual(res.body, { success: false, message: 'رمز الإشعارات غير صالح' });
  }
  assert.equal(upserts.length, 0);
});

test('جسمٌ خارج المخطط ⇒ ZodError إلى معالج الأخطاء (400): البيئة إلزامية ومن القيمتين، والطول ٦٤–٢٠٠، والإزاحة ±٨٤٠', async () => {
  for (const body of [{ token: T(1) }, { token: T(1), env: 'development' }, { token: T(1), env: 'PRODUCTION' }, { token: 'a'.repeat(63), env: 'production' },
    { token: 'a'.repeat(202), env: 'production' }, { token: 42, env: 'production' }, {}, { token: T(1), env: 'production', tzOffsetMin: 841 },
    { token: T(1), env: 'production', tzOffsetMin: 1.5 }, { token: T(1), env: 'production', lang: 'x'.repeat(9) }])
    await assert.rejects(call('post', '/push/apns', { body }), (e: unknown) => e instanceof ZodError, JSON.stringify(body));
  assert.equal(upserts.length, 0);
});

test('رمزٌ بحروفٍ كبيرة ومسافات: يُصغَّر في العنوان، والمفتاحان فارغان، واللغة حرفان صغيران أو null — والردّ endpoint وactive:false بلا مفتاح', async () => {
  const token = ` ${'AB'.repeat(32)}\n`;
  const res = await call('post', '/push/apns', { body: { token, env: 'production', lang: 'ar' } });
  const endpoint = `apns:production:${'ab'.repeat(32)}`;
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, data: { endpoint, active: false } });
  assert.deepEqual(upserts[0], {
    where: { endpoint },
    create: { tenantId: 't1', salesRepId: 'rep1', endpoint, p256dh: '', auth: '', lang: 'ar' },
    update: { tenantId: 't1', salesRepId: 'rep1', lang: 'ar' },
  });
  assert.equal(subs.length, 1, 'يُحفظ ولو لم يُضبط المفتاح بعد');
  for (const [lang, want] of [['EN', null], ['arabic', null], [undefined, null], ['tr', 'tr']] as const) {
    await call('post', '/push/apns', { body: { token: T(9), env: 'sandbox', ...(lang ? { lang } : {}) } });
    assert.equal(subs.find((s) => s.endpoint === `apns:sandbox:${T(9)}`)!.lang, want, String(lang));
  }
});

test('مكرّرٌ بلا ازدواج (الصفّ نفسه، updatedAt يتقدّم)، ومندوبٌ آخر بالجهاز نفسه يأخذ الصفّ', async () => {
  await call('post', '/push/apns', { body: { token: T(1), env: 'production' } });
  const at1 = subs[0].updatedAt.getTime();
  await call('post', '/push/apns', { body: { token: T(1), env: 'production' } });
  assert.equal(subs.length, 1);
  assert.ok(subs[0].updatedAt.getTime() > at1);
  const res = await call('post', '/push/apns', { user: REP2, body: { token: T(1), env: 'production' } });
  assert.equal(data(res).endpoint, `apns:production:${T(1)}`);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].salesRepId, 'rep2');
  assert.equal(subs[0].tenantId, 't2');
  assert.equal(subs[0].p256dh, '');
});

test('أكثر من خمسة أجهزة: يبقى الأحدث خمسة (والاشتراكات الأخرى للمندوب نفسه تُعدّ معها) — ومندوبٌ آخر لا يُمسّ', async () => {
  subs.push({ id: 'web', tenantId: 't1', salesRepId: 'rep1', endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'k', auth: 'a', lang: null, updatedAt: tick() });
  subs.push({ id: 'other', tenantId: 't2', salesRepId: 'rep2', endpoint: `apns:production:${T(99)}`, p256dh: '', auth: '', lang: null, updatedAt: tick() });
  for (let n = 1; n <= 6; n++) await call('post', '/push/apns', { body: { token: T(n), env: 'production' } });
  const mine = subs.filter((s) => s.salesRepId === 'rep1').map((s) => s.endpoint).sort();
  assert.deepEqual(mine, [2, 3, 4, 5, 6].map((n) => `apns:production:${T(n)}`).sort());
  assert.ok(subs.some((s) => s.id === 'other'));
  assert.ok(deletes.every((d) => Array.isArray((d as { where: { id?: { in: unknown } } }).where.id?.in)), 'الحذف بالمعرّفات وحدها');
});

test('إزاحة التوقيت تُحفظ للمندوب (لحساب «قبل الدوام» بتوقيته)، وبدونها لا كتابة', async () => {
  await call('post', '/push/apns', { body: { token: T(1), env: 'production', tzOffsetMin: 180 } });
  assert.deepEqual(repUpdates, [{ where: { id: 'rep1' }, data: { tzOffsetMin: 180 } }]);
  await call('post', '/push/apns', { body: { token: T(1), env: 'production' } });
  assert.equal(repUpdates.length, 1);
  await call('post', '/push/apns', { body: { token: T(1), env: 'production', tzOffsetMin: -300 } });
  assert.deepEqual(repUpdates[1], { where: { id: 'rep1' }, data: { tzOffsetMin: -300 } });
});

test('active يعكس ضبط مفاتيح APNs في الخادم: false بلا متغيّرات، true بمفتاح P-256 صالح', async () => {
  assert.equal(data(await call('post', '/push/apns', { body: { token: T(1), env: 'production' } })).active, false);
  const pem = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  Object.assign(process.env, { APNS_KEY_P8: pem, APNS_KEY_ID: 'KEYID12345', APNS_TEAM_ID: 'QKD58WVK2R' });
  assert.equal(data(await call('post', '/push/apns', { body: { token: T(1), env: 'production' } })).active, true);
  process.env.APNS_KEY_ID = 'bad';
  assert.equal(data(await call('post', '/push/apns', { body: { token: T(1), env: 'production' } })).active, false, 'إعدادٌ فاسد = غير مفعّل');
  assert.equal(subs.length, 1);
});

test('الخروج بالمسار القائم /push/unsubscribe: يحذف عنوان الآيفون لصاحب الجلسة وحده', async () => {
  await call('post', '/push/apns', { body: { token: T(1), env: 'production' } });
  await call('post', '/push/apns', { user: REP2, body: { token: T(2), env: 'production' } });
  const mine = `apns:production:${T(1)}`;
  const theirs = `apns:production:${T(2)}`;
  const stray = await call('post', '/push/unsubscribe', { body: { endpoint: theirs } });
  assert.equal(stray.statusCode, 200);
  assert.deepEqual(deletes.at(-1), { where: { endpoint: theirs, salesRepId: 'rep1' } });
  assert.ok(subs.some((s) => s.endpoint === theirs), 'جهاز مندوبٍ آخر باقٍ');
  await call('post', '/push/unsubscribe', { body: { endpoint: mine } });
  assert.deepEqual(deletes.at(-1), { where: { endpoint: mine, salesRepId: 'rep1' } });
  assert.deepEqual(subs.map((s) => s.endpoint), [theirs]);
  const admin = await call('post', '/push/unsubscribe', { user: { role: 'COMPANY_ADMIN', id: 'u1', tenantId: 't1' }, body: { endpoint: theirs } });
  assert.equal(admin.statusCode, 403);
});
