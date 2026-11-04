// تتبّع الخلفية من التطبيق الأصلي (طلب المالك، ٤ نوفمبر ٢٠٢٦) — المسارات نفسها عبر HTTP محلي (127.0.0.1) فوق Prisma مزيّف في الذاكرة، بلا قاعدة:
//   • POST /api/track-device/ping برمز التتبّع وحده: بلا رمز أو بتوكن جلسة ⇒ 401 TRACK_TOKEN_INVALID؛ المندوب المعطّل أو الشركة
//     الموقوفة/المنتهي اشتراكها أو شركةٌ أخرى ⇒ 401؛ التتبّع مطفأ لغير المقيَّد ⇒ stop بلا تخزين؛ وإلا تُخزَّن بحكم /ping نفسه.
//   • رمز التتبّع لا يمرّ من authenticate على /api/tracking/ping.
//   • نقطة الويب والتتبّع الأصلي يعمل: لا تُخزَّن لغير المقيَّد (native) ويُلمس «آخر ظهور»، والمقيَّد يُخزَّن ويُحكم كما كان.
//   • POST /api/tracking/device-token: المندوب وحده، enabled:false حين يُطفأ التتبّع له، وإلا رمزٌ يتحقّق منه verifyTrackToken.
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'device-track-routes-test-secret';
const SECRET = process.env.JWT_SECRET;
const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ─── Prisma مزيّف ───
type Tenant = { isActive: boolean; subscriptionEndsAt: Date | null; attendanceEnabled?: boolean };
type Rep = { tenantId: string; isActive: boolean; canBeTracked: boolean; requireLocationOn: boolean; tenant: Tenant };
type Loc = { tenantId: string; salesRepId: string; lat: number; lng: number; accuracy: number | null; speed: number | null; capturedAt: Date; createdAt: Date };
let reps: Record<string, Rep> = {};
let trackingEnabled = true;
let locs: Loc[] = [];
let repRows: Record<string, Record<string, unknown>> = {};
/** نوبة الحضور المفتوحة لكل مندوب (بصمة حضورٍ بلا انصراف) */
let openShifts: Record<string, boolean> = {};
const repRow = (id: string) => (repRows[id] ??= {});

const prisma = {
  companySettings: { async findUnique() { return { trackingEnabled }; } },
  salesRep: {
    async findFirst(a: { where: { id: string; tenantId: string }; select: Record<string, unknown> }) {
      const r = reps[a.where.id];
      if (!r || r.tenantId !== a.where.tenantId) return null;
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(a.select)) o[k] = (r as unknown as Record<string, unknown>)[k];
      return o;
    },
    async update(a: { where: { id: string }; data: Record<string, unknown> }) { Object.assign(repRow(a.where.id), a.data); return {}; },
    async updateMany(a: { where: { id: string; OR: ({ lastLocAt: null } | { lastLocAt: { lt: Date } })[] }; data: Record<string, unknown> }) {
      const row = repRow(a.where.id);
      const cur = row.lastLocAt as Date | null | undefined;
      const lt = (a.where.OR.find((o) => 'lastLocAt' in o && o.lastLocAt !== null) as { lastLocAt: { lt: Date } }).lastLocAt.lt;
      if (cur == null || cur < lt) { Object.assign(row, a.data); return { count: 1 }; }
      return { count: 0 };
    },
  },
  repLocation: {
    async createMany(a: { data: Omit<Loc, 'createdAt'>[] }) {
      for (const d of a.data) {
        assert.ok(d.capturedAt instanceof Date && Number.isFinite(d.capturedAt.getTime()), 'لحظة التقاطٍ فاسدة وصلت القاعدة');
        locs.push({ ...d, createdAt: new Date() });
      }
      return { count: a.data.length };
    },
    async findFirst(a: { where: { tenantId: string; salesRepId: string; capturedAt: { gte: Date; lte: Date }; createdAt: { gte: Date } } }) {
      const l = locs.filter((x) => x.tenantId === a.where.tenantId && x.salesRepId === a.where.salesRepId
        && x.capturedAt >= a.where.capturedAt.gte && x.capturedAt <= a.where.capturedAt.lte && x.createdAt >= a.where.createdAt.gte)
        .sort((x, y) => y.capturedAt.getTime() - x.capturedAt.getTime())[0];
      return l ? { lat: l.lat, lng: l.lng, accuracy: l.accuracy, capturedAt: l.capturedAt, createdAt: l.createdAt } : null;
    },
  },
  repAttendance: {
    async findFirst(a: { where: { salesRepId: string; checkOutAt: null } }) {
      return openShifts[a.where.salesRepId] ? { id: 'shift-1', checkInAt: new Date() } : null;
    },
  },
  // مستخدم اللوحة (authenticate وrequireAdminPermission) — لاختبار أن /device-token للمندوب وحده
  admin: {
    async findUnique() { return { isActive: true, canDelete: true, lastSeenAt: new Date() }; },
    async updateMany() { return { count: 0 }; },
  },
};
stub('config/database', { default: prisma });
stub('services/adminScope', { adminRepFilter: async () => ({}), scopedRepRecordWhere: async () => ({}), scopedRecordWhere: async () => ({}), canAccessRep: async () => true, SHAPE_VISIT: {} });
stub('services/mapMatch', { snapToRoads: async () => [], routeThrough: async () => [] });
stub('services/routeShape', { buildRouteShape: () => ({}), haversineM: () => 0 });
stub('services/repHeartbeat', { heartbeatClientState: () => ({}) });

/* eslint-disable @typescript-eslint/no-var-requires */
const trackingRouter = require('../routes/tracking').default as express.Router;
const trackDeviceRouter = require('../routes/trackDevice').default as express.Router;
const dt = require('../services/deviceTrack') as typeof import('../services/deviceTrack');
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */

const realFetch = globalThis.fetch;
let server: { port: number; close: () => Promise<void> } | null = null;
after(async () => { await server?.close(); server = null; });
async function call(p: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, any> }> {
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use('/api/track-device', trackDeviceRouter);
    app.use('/api/tracking', trackingRouter);
    app.use(errorHandler);
    const s = http.createServer(app);
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
  }
  const r = await realFetch(`http://127.0.0.1:${server.port}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : {} };
}

const T_OK: Tenant = { isActive: true, subscriptionEndsAt: null };
beforeEach(() => {
  reps = {
    free: { tenantId: 't1', isActive: true, canBeTracked: true, requireLocationOn: false, tenant: T_OK },
    strict: { tenantId: 't1', isActive: true, canBeTracked: true, requireLocationOn: true, tenant: T_OK },
  };
  trackingEnabled = true;
  locs = [];
  repRows = {};
  openShifts = {};
  dt.resetNativeTrack();
});

const session = (id: string, role = 'SALES_REP') => jwt.sign({ id, role, name: 'م', tenantId: 't1' }, SECRET);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const trackTok = (id: string, tid = 't1') => dt.issueTrackToken(id, tid).token;
const pt = (o: Record<string, unknown> = {}) => ({ lat: 24.7136, lng: 46.6753, accuracy: 12, speed: null, capturedAt: new Date(Date.now() - 2_000).toISOString(), ...o });
const devicePing = (token: string | null, points: unknown[], headers: Record<string, string> = {}) =>
  call('/api/track-device/ping', { points }, { ...(token ? bearer(token) : {}), ...headers });

test('نقطة الجهاز بلا رمز، أو بتوكن جلسة، أو بنصٍّ عشوائي ⇒ 401 TRACK_TOKEN_INVALID ولا تخزين', async () => {
  for (const [label, headers] of [
    ['بلا ترويسة', {}],
    ['توكن جلسة المندوب', bearer(session('free'))],
    ['نصّ', bearer('a.b.c')],
    ['Basic', { authorization: 'Basic Zm9vOmJhcg==' }],
  ] as [string, Record<string, string>][]) {
    const r = await call('/api/track-device/ping', { points: [pt()] }, headers);
    assert.equal(r.status, 401, label);
    assert.deepEqual(r.body, { success: false, code: 'TRACK_TOKEN_INVALID', message: 'رمز التتبّع غير صالح' }, label);
  }
  assert.equal(locs.length, 0);
  assert.equal(dt.nativeTrackActive('free'), false);
});

test('رمز التتبّع لا يمرّ من authenticate: /api/tracking/ping و/device-token يردّانه 401', async () => {
  const tok = trackTok('free');
  for (const p of ['/api/tracking/ping', '/api/tracking/device-token']) {
    const r = await call(p, { points: [pt()] }, bearer(tok));
    assert.equal(r.status, 401, p);
  }
  assert.equal(locs.length, 0);
});

test('نقطة الجهاز والتتبّع مفعّل ⇒ تُخزَّن للمندوب في شركته، ويتحرّك الدبّوس، ويُعلَّم «التتبّع الأصلي يعمل»', async () => {
  const r = await devicePing(trackTok('free'), [pt({ lat: 24.70, capturedAt: new Date(Date.now() - 20_000).toISOString() }), pt({ lat: 24.71 })]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { success: true, data: { stored: 2 } });
  assert.equal(locs.length, 2);
  assert.ok(locs.every((l) => l.tenantId === 't1' && l.salesRepId === 'free'));
  assert.equal(repRows.free.lastLat, 24.71, 'الأحدث بين نقاط الدفعة');
  assert.ok(repRows.free.lastSeenAt instanceof Date);
  assert.equal(dt.nativeTrackActive('free'), true);
  assert.equal(dt.nativeTrackActive('strict'), false);
});

test('المقيَّد: ساعة جهازٍ متأخّرة بترويسة ISO-8601 (التطبيق الأصلي) تُصحَّح كترويسة الويب الرقمية', async () => {
  const skew = 10 * 60_000;
  const devNow = Date.now() - skew;
  for (const header of [new Date(devNow).toISOString(), String(devNow)]) {
    locs = [];
    const r = await devicePing(trackTok('strict'), [pt({ capturedAt: new Date(devNow - 2_000).toISOString() })], { 'x-fs-device-now': header });
    assert.deepEqual(r.body.data, { stored: 1 }, header);
    assert.ok(Math.abs(locs[0].capturedAt.getTime() - (Date.now() - 2_000)) < 1_500, `لم تُصحَّح: ${header}`);
  }
});

test('لحظة التقاطٍ فاسدة من الجهاز لا تُعلق الدفعة بخطأ خادم — تُخزَّن بلحظة الاستقبال', async () => {
  // «-5» يقبله Date.parse في V8 سنةَ ٢٠٠١ — لا يُخزَّن بها
  const r = await devicePing(trackTok('free'), [pt({ capturedAt: 'not-a-date' }), pt({ capturedAt: '-5' }), pt()]);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.stored, 3);
  assert.ok(Math.abs(locs[0].capturedAt.getTime() - Date.now()) < 2_000);
  assert.ok(Math.abs(locs[1].capturedAt.getTime() - Date.now()) < 2_000);
  assert.ok(Math.abs(locs[2].capturedAt.getTime() - (Date.now() - 2_000)) < 2_000, 'السليمة بلحظتها');
});

test('التتبّع أُطفئ للشركة أو استُثني المندوب بعد إصدار الرمز ⇒ stop بلا تخزين ولا علامة — والمقيَّد يُخزَّن', async () => {
  trackingEnabled = false;
  let r = await devicePing(trackTok('free'), [pt()]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { success: true, data: { stored: 0, stop: true } });
  trackingEnabled = true;
  reps.free.canBeTracked = false;
  r = await devicePing(trackTok('free'), [pt()]);
  assert.deepEqual(r.body.data, { stored: 0, stop: true });
  assert.equal(locs.length, 0);
  assert.equal(dt.nativeTrackActive('free'), false);
  // «اشتراط تفعيل الموقع»: موقع المقيَّد يُخزَّن دائماً
  trackingEnabled = false;
  reps.strict.canBeTracked = false;
  r = await devicePing(trackTok('strict'), [pt()]);
  assert.deepEqual(r.body.data, { stored: 1 });
});

test('المندوب المعطّل/المحذوف، والشركة الموقوفة أو المنتهي اشتراكها، والرمز لشركةٍ أخرى ⇒ 401 TRACK_TOKEN_INVALID', async () => {
  const tok = trackTok('free');
  const cases: [string, () => void, string?][] = [
    ['معطّل', () => { reps.free.isActive = false; }],
    ['محذوف', () => { delete reps.free; }],
    ['شركة موقوفة', () => { reps.free.tenant = { isActive: false, subscriptionEndsAt: null }; }],
    ['اشتراك منتهٍ', () => { reps.free.tenant = { isActive: true, subscriptionEndsAt: new Date(Date.now() - 60_000) }; }],
    ['شركة أخرى', () => {}, trackTok('free', 't2')],
  ];
  for (const [label, arrange, other] of cases) {
    reps.free = { tenantId: 't1', isActive: true, canBeTracked: true, requireLocationOn: false, tenant: T_OK };
    arrange();
    const r = await devicePing(other ?? tok, [pt()]);
    assert.equal(r.status, 401, label);
    assert.equal(r.body.code, 'TRACK_TOKEN_INVALID', label);
  }
  assert.equal(locs.length, 0);
});

test('جسمٌ فاسد من الجهاز ⇒ 400 بلا تخزين (المخطّط نفسه: ١–٢٠٠ نقطة)', async () => {
  const tok = trackTok('free');
  assert.equal((await devicePing(tok, [])).status, 400);
  assert.equal((await devicePing(tok, Array.from({ length: 201 }, () => pt()))).status, 400);
  assert.equal((await devicePing(tok, [{ lat: 95, lng: 46 }])).status, 400);
  assert.equal((await devicePing(tok, Array.from({ length: 200 }, () => pt()))).body.data.stored, 200);
});

test('نقطة الويب والتتبّع الأصلي يعمل: غير المقيَّد لا تُخزَّن (native) ويُلمس «آخر ظهور» — والمقيَّد يُخزَّن ويُحكم كما كان', async () => {
  // قبل أي نقطة من الجهاز: الويب كما كان
  let r = await call('/api/tracking/ping', { points: [pt()] }, bearer(session('free')));
  assert.deepEqual(r.body, { success: true, data: { stored: 1 } });
  await devicePing(trackTok('free'), [pt()]);
  await devicePing(trackTok('strict'), [pt()]);
  locs = [];
  delete repRows.free.lastSeenAt;
  r = await call('/api/tracking/ping', { points: [pt()] }, bearer(session('free')));
  assert.deepEqual(r.body, { success: true, data: { stored: 0, native: true } });
  assert.equal(locs.length, 0, 'أثر الجهاز هو المسار — لا أثرين متراكبين');
  assert.ok(repRows.free.lastSeenAt instanceof Date, '«آخر ظهور» يُلمس');
  // المقيَّد: نقطة الويب الطازجة قبل الإجراء هي ما يُبقي حكم «ظاهر الآن» صادقاً
  r = await call('/api/tracking/ping', { points: [pt()] }, { ...bearer(session('strict')), 'x-fs-device-now': String(Date.now()) });
  assert.equal(r.body.data.stored, 1);
  assert.deepEqual(r.body.data.live, { ok: true });
  assert.equal(r.body.data.native, true);
  assert.equal(locs.length, 1);
  // التتبّع مطفأ للشركة: الويب يُبلَّغ disabled كما كان، ولو كان الأصلي يعمل
  trackingEnabled = false;
  r = await call('/api/tracking/ping', { points: [pt()] }, bearer(session('free')));
  assert.deepEqual(r.body.data, { stored: 0, disabled: true });
});

test('/device-token: المندوب يأخذ رمزاً يتحقّق منه verifyTrackToken لنفسه وشركته، وعمره ٢٠ ساعة', async () => {
  const r = await call('/api/tracking/device-token', {}, bearer(session('free')));
  assert.equal(r.status, 200);
  assert.equal(r.body.data.enabled, true);
  assert.deepEqual(dt.verifyTrackToken(r.body.data.token), { repId: 'free', tenantId: 't1' });
  const life = new Date(r.body.data.expiresAt).getTime() - Date.now();
  assert.ok(life > 20 * 3600_000 - 10_000 && life <= 20 * 3600_000, String(life));
  // بلا «بصمة الحضور» للشركة: لا انتظار للمسة الحضور، والجهاز لم يرفع بعد
  assert.equal(r.body.data.waitPunch, false);
  assert.equal(r.body.data.nativeActive, false);
  // والرمز نفسه تقبله نقطة الجهاز
  assert.equal((await devicePing(r.body.data.token, [pt()])).body.data.stored, 1);
  // بعد أول رفعٍ من الجهاز: الصفحة تعرف أن التتبّع يعمل فلا تطلب بدءاً ثانياً
  assert.equal((await call('/api/tracking/device-token', {}, bearer(session('free')))).body.data.nativeActive, true);
});

test('/device-token: «بصمة الحضور» مفعّلة ولم يبصم ⇒ waitPunch (البدء بلمسة الحضور) — وبعد الحضور لا انتظار', async () => {
  reps.free.tenant = { ...T_OK, attendanceEnabled: true };
  assert.equal((await call('/api/tracking/device-token', {}, bearer(session('free')))).body.data.waitPunch, true);
  openShifts.free = true;
  assert.equal((await call('/api/tracking/device-token', {}, bearer(session('free')))).body.data.waitPunch, false);
  // الميزة مطفأة للشركة ولو بقيت نوبةٌ قديمة: لا انتظار
  openShifts.free = false;
  reps.free.tenant = { ...T_OK, attendanceEnabled: false };
  assert.equal((await call('/api/tracking/device-token', {}, bearer(session('free')))).body.data.waitPunch, false);
});

test('/device-token: التتبّع مطفأ أو المندوب مستثنى أو معطّل أو الشركة موقوفة ⇒ enabled:false بلا رمز — والمقيَّد يأخذ رمزه', async () => {
  const off = { success: true, data: { enabled: false } };
  trackingEnabled = false;
  assert.deepEqual((await call('/api/tracking/device-token', {}, bearer(session('free')))).body, off);
  const strict = await call('/api/tracking/device-token', {}, bearer(session('strict')));
  assert.equal(strict.body.data.enabled, true, 'موقع المقيَّد يُخزَّن دائماً');
  trackingEnabled = true;
  reps.free.canBeTracked = false;
  assert.deepEqual((await call('/api/tracking/device-token', {}, bearer(session('free')))).body, off);
  reps.free.canBeTracked = true;
  reps.free.isActive = false;
  assert.deepEqual((await call('/api/tracking/device-token', {}, bearer(session('free')))).body, off);
  reps.free.isActive = true;
  reps.free.tenant = { isActive: false, subscriptionEndsAt: null };
  assert.deepEqual((await call('/api/tracking/device-token', {}, bearer(session('free')))).body, off);
  delete reps.free;
  assert.deepEqual((await call('/api/tracking/device-token', {}, bearer(session('free')))).body, off);
});

test('/device-token لمستخدم اللوحة ⇒ 403، وبلا جلسة ⇒ 401', async () => {
  const admin = await call('/api/tracking/device-token', {}, bearer(session('a1', 'ADMIN')));
  assert.equal(admin.status, 403);
  assert.equal(admin.body.token, undefined);
  assert.equal((await call('/api/tracking/device-token', {})).status, 401);
});
