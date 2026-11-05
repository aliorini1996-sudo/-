// تتبّع الخلفية من التطبيق الأصلي (طلب المالك، ٤ نوفمبر ٢٠٢٦) — المسارات نفسها عبر HTTP محلي (127.0.0.1) فوق Prisma مزيّف في الذاكرة، بلا قاعدة:
//   • POST /api/track-device/ping برمز التتبّع وحده: بلا رمز أو بتوكن جلسة ⇒ 401 TRACK_TOKEN_INVALID؛ المندوب المعطّل أو الشركة
//     الموقوفة/المنتهي اشتراكها أو شركةٌ أخرى ⇒ 401؛ التتبّع مطفأ لغير المقيَّد ⇒ stop بلا تخزين؛ وإلا تُخزَّن بحكم /ping نفسه.
//   • رمز التتبّع لا يمرّ من authenticate على /api/tracking/ping.
//   • نقطة الويب والتتبّع الأصلي يعمل: لا تُخزَّن لغير المقيَّد (native) ويُلمس «آخر ظهور»، والمقيَّد يُخزَّن ويُحكم كما كان.
//   • POST /api/tracking/device-token: المندوب وحده، enabled:false حين يُطفأ التتبّع له، وإلا رمزٌ يتحقّق منه verifyTrackToken.
//   • رفع الإغلاق (x-fs-track-final: 1): نقاطه تُخزَّن ثم يُنسى «التتبّع الأصلي يعمل» — ويُقبل فارغاً بالترويسة وحدها.
//   • nativeActive بعد نشرٍ يمسح الذاكرة: صفّ جهازٍ استُقبل خلال ٩٠ث يكفي — لا صفّ صفحة ولا مندوبٌ آخر ولا صفوف رفع الإغلاق.
//   • nativeRecent (سؤال التحقّق): آخر رفعٍ خلال ٥ دقائق من الذاكرة أو أحدث صفّ جهاز — ولا يشهد به رفع الإغلاق.
//   • GET /api/tracking/route: يومٌ فوق سقف ٥٠٠٠ نقطة يعيد أحدثها تصاعدياً، لا أولاها.
//   • مصدر الصفّ (قرار المالك ٤ نوفمبر): نقطة الجهاز source='device' من المسار لا من الجسم، ونقطة الصفحة بلا مصدر؛ والجهاز
//     يحرّك الدبّوس ولحظته ولا يلمس «آخر ظهور».
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
type Loc = { tenantId: string; salesRepId: string; lat: number; lng: number; accuracy: number | null; speed: number | null; capturedAt: Date; createdAt: Date; source?: string | null };
let reps: Record<string, Rep> = {};
let trackingEnabled = true;
let locs: Loc[] = [];
let repRows: Record<string, Record<string, unknown>> = {};
/** استعلامات repLocation.findFirst كما وصلت — شكل استعلام «جهازٌ يرفع» ومتى يُستغنى عنه */
let locReads: { where: Record<string, unknown>; orderBy: unknown; select: Record<string, true> }[] = [];
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
    // قارئان: حكم «ظاهر الآن» للمقيَّد (readLivePoint: capturedAt بين حدّين) و«جهازٌ يرفع» في /device-token (source وحدٌّ أدنى،
    // وأحدث استقبال) — كل شرطٍ غائب لا يُطبَّق، والترتيب بحسب orderBy (تنازلياً)، والحقول بحسب select
    async findFirst(a: {
      where: { tenantId: string; salesRepId: string; source?: string; capturedAt: { gte: Date; lte?: Date }; createdAt?: { gte: Date } };
      orderBy: { capturedAt: 'desc' } | { createdAt: 'desc' }; select: Record<string, true>;
    }) {
      locReads.push(a);
      const w = a.where;
      const key: 'capturedAt' | 'createdAt' = 'createdAt' in a.orderBy ? 'createdAt' : 'capturedAt';
      const l = locs.filter((x) => x.tenantId === w.tenantId && x.salesRepId === w.salesRepId
        && (w.source === undefined || x.source === w.source)
        && x.capturedAt >= w.capturedAt.gte && (w.capturedAt.lte === undefined || x.capturedAt <= w.capturedAt.lte)
        && (w.createdAt === undefined || x.createdAt >= w.createdAt.gte))
        .sort((x, y) => y[key].getTime() - x[key].getTime())[0];
      if (!l) return null;
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(a.select)) o[k] = (l as unknown as Record<string, unknown>)[k];
      return o;
    },
    // خطّ السير (GET /tracking/route): الترتيب والسقف كما يطلبهما المسار — لا كما أُدرجت النقاط
    async findMany(a: { where: { tenantId: string; salesRepId: string; capturedAt: { gte: Date; lt: Date } }; orderBy: { capturedAt: 'asc' | 'desc' }; take?: number }) {
      const dir = a.orderBy.capturedAt === 'desc' ? -1 : 1;
      return locs.filter((x) => x.tenantId === a.where.tenantId && x.salesRepId === a.where.salesRepId
        && x.capturedAt >= a.where.capturedAt.gte && x.capturedAt < a.where.capturedAt.lt)
        .sort((x, y) => dir * (x.capturedAt.getTime() - y.capturedAt.getTime()))
        .slice(0, a.take ?? Infinity)
        .map((x) => ({ lat: x.lat, lng: x.lng, accuracy: x.accuracy, speed: x.speed, capturedAt: x.capturedAt }));
    },
  },
  repAttendance: {
    async findFirst(a: { where: { salesRepId: string; checkOutAt: null } }) {
      return openShifts[a.where.salesRepId] ? { id: 'shift-1', checkInAt: new Date() } : null;
    },
    async findMany() { return []; },
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
async function base(): Promise<string> {
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
  return `http://127.0.0.1:${server.port}`;
}
async function call(p: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, any> }> {
  const r = await realFetch(`${await base()}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : {} };
}
async function get(p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, any> }> {
  const r = await realFetch(`${await base()}${p}`, { headers });
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
  locReads = [];
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
  assert.ok(repRows.free.lastLocAt instanceof Date, 'لحظة الدبّوس تتحرّك بنقطة الجهاز');
  // «آخر ظهور» = التطبيق مفتوحٌ أمامه كما كان — الخلفية ترفع حتى منتصف الليل فلا تُبقيه «متصلاً» في عدّاد المالك
  assert.equal(repRows.free.lastSeenAt, undefined, 'نقطة الجهاز لمست «آخر ظهور»');
  // مصدر الصفّ من المسار: نقطة الجهاز 'device' (LOCATION_SOURCE_DEVICE)
  assert.ok(locs.every((l) => l.source === dt.LOCATION_SOURCE_DEVICE), 'نقطة جهازٍ بلا مصدرها');
  assert.equal(dt.LOCATION_SOURCE_DEVICE, 'device');
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
  // قبل أي نقطة من الجهاز: الويب كما كان — وصفّه بلا مفتاح المصدر أصلاً (العمود null كما قبل الميزة)
  let r = await call('/api/tracking/ping', { points: [pt()] }, bearer(session('free')));
  assert.deepEqual(r.body, { success: true, data: { stored: 1 } });
  assert.equal('source' in locs[0], false, 'نقطة الصفحة حملت مصدراً');
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
  assert.equal('source' in locs[0], false, 'نقطة صفحة المقيَّد حملت مصدراً');
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

// ─── رفع الإغلاق: الخدمة توقّفت (خروج المندوب أو منتصف الليل) — مراجعة ٤ نوفمبر ───
test('رفع الإغلاق (x-fs-track-final: 1): نقاطه تُخزَّن ثم يُنسى «التتبّع الأصلي يعمل» — /device-token يطلب بدءاً ونقاط الويب تُخزَّن', async () => {
  const tok = trackTok('free');
  // رفعٌ عاديّ يعلّم: الصفحة لا تطلب بدءاً ثانياً، ونقطة ويبها لا تُخزَّن
  assert.deepEqual((await devicePing(tok, [pt()])).body.data, { stored: 1 });
  assert.equal(dt.nativeTrackActive('free'), true);
  assert.equal((await call('/api/tracking/device-token', {}, bearer(session('free')))).body.data.nativeActive, true);
  assert.deepEqual((await call('/api/tracking/ping', { points: [pt()] }, bearer(session('free')))).body.data, { stored: 0, native: true });

  locs = [];
  const r = await devicePing(tok, [pt({ lat: 24.70 }), pt({ lat: 24.71 })], { 'x-fs-track-final': '1' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { success: true, data: { stored: 2 } });
  assert.equal(locs.length, 2, 'نقاط الإغلاق تُخزَّن كغيرها');
  assert.ok(locs.every((l) => l.source === 'device'), 'نقاط الإغلاق نقاط جهاز');
  assert.equal(dt.nativeTrackActive('free'), false, 'لا ٩٠ث عن خدمةٍ توقّفت');
  // مندوبٌ خرج ثم عاد خلال النافذة: الصفحة تُبلَّغ أن لا جهاز يرفع فتطلب بدءاً، ونقاط صفحته تُخزَّن فوراً
  assert.equal((await call('/api/tracking/device-token', {}, bearer(session('free')))).body.data.nativeActive, false);
  assert.deepEqual((await call('/api/tracking/ping', { points: [pt()] }, bearer(session('free')))).body, { success: true, data: { stored: 1 } });
  assert.equal(locs.length, 3);
  assert.equal(locs[2].source, undefined, 'نقطة الصفحة بعد الإغلاق بلا مصدر');
  // بدءٌ جديد: أول رفعٍ عاديّ يعلّمه من جديد
  await devicePing(tok, [pt()]);
  assert.equal(dt.nativeTrackActive('free'), true);
});

test('الترويسة بغير 1 رفعٌ عاديّ يعلّم — ورفع الإغلاق الفارغ يُقبل بالترويسة وحدها فينسى بلا تخزين', async () => {
  const tok = trackTok('free');
  for (const v of ['0', 'true', '']) {
    dt.resetNativeTrack();
    assert.deepEqual((await devicePing(tok, [pt()], { 'x-fs-track-final': v })).body.data, { stored: 1 }, v);
    assert.equal(dt.nativeTrackActive('free'), true, `«${v}» ليست إغلاقاً`);
  }
  locs = [];
  // طابور الجهاز فارغٌ لحظة التوقّف
  const r = await devicePing(tok, [], { 'x-fs-track-final': '1' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { success: true, data: { stored: 0 } });
  assert.equal(locs.length, 0);
  assert.equal(dt.nativeTrackActive('free'), false);
  // الفارغ بلا الترويسة يبقى 400 (مخطّط /ping)، والفاسد 400 ولو بها، وبلا رمز 401
  assert.equal((await devicePing(tok, [])).status, 400);
  assert.equal((await devicePing(tok, [{ lat: 95, lng: 46 }], { 'x-fs-track-final': '1' })).status, 400);
  assert.equal((await devicePing(tok, Array.from({ length: 201 }, () => pt()), { 'x-fs-track-final': '1' })).status, 400);
  assert.equal((await call('/api/track-device/ping', { points: [] }, { 'x-fs-track-final': '1' })).status, 401);
  // والتتبّع مطفأ: stop كما كان
  trackingEnabled = false;
  assert.deepEqual((await devicePing(tok, [], { 'x-fs-track-final': '1' })).body.data, { stored: 0, stop: true });
  assert.equal(locs.length, 0);
});

// ─── nativeActive بعد نشرٍ أو إعادة تشغيل (الذاكرة فارغة): الصفحة تسأل دورياً لتكتشف خدمةً قُتلت — جهازٌ سليم لا يبدو ميتاً ───
const tokenReply = async (id = 'free') => (await call('/api/tracking/device-token', {}, bearer(session(id)))).body.data;
/** حكما «يرفع الآن» (البدء ونقاط الصفحة، ٩٠ث) و«رُئي مؤخّراً» (سؤال التحقّق، ٥ دقائق) من ردّ /device-token */
const pick = (d: Record<string, unknown>) => ({ nativeActive: d.nativeActive, nativeRecent: d.nativeRecent });

test('/device-token بعد نشرٍ مسح الذاكرة: صفّ جهازٍ استُقبل خلال ٩٠ث ⇒ nativeActive باستعلامٍ واحد في مدى الفهرس — والذاكرة تُغني عنه', async () => {
  await devicePing(trackTok('free'), [pt()]);
  locReads = [];
  assert.deepEqual(pick(await tokenReply()), { nativeActive: true, nativeRecent: true });
  assert.equal(locReads.length, 0, 'الذاكرة تعرفه: لا استعلام');
  dt.resetNativeTrack(); // نشرٌ على Render
  const before = Date.now();
  assert.deepEqual(pick(await tokenReply()), { nativeActive: true, nativeRecent: true }, 'جهازٌ سليم بدا ميتاً بعد النشر');
  assert.equal(locReads.length, 1);
  const q = locReads[0];
  const w = q.where as { tenantId: string; salesRepId: string; source: string; capturedAt: { gte: Date; lte?: Date }; createdAt: { gte: Date } };
  assert.deepEqual(Object.keys(w).sort(), ['capturedAt', 'createdAt', 'salesRepId', 'source', 'tenantId']);
  assert.equal(w.tenantId, 't1');
  assert.equal(w.salesRepId, 'free');
  assert.equal(w.source, dt.LOCATION_SOURCE_DEVICE);
  assert.equal(dt.NATIVE_ROW_LOOKBACK_MS, 15 * 60_000);
  assert.deepEqual(Object.keys(w.capturedAt), ['gte'], 'حدٌّ أدنى وحده: ساعة جهازٍ متقدّمة لا تُخفيه');
  assert.ok(Math.abs(w.capturedAt.gte.getTime() - (before - dt.NATIVE_ROW_LOOKBACK_MS)) < 2_000);
  // الحكم بلحظة الاستقبال (ساعة الخادم) لا بلحظة الالتقاط (ساعة الجهاز)، وبالنافذة الأوسع فيُعرف «رُئي مؤخّراً» من الاستعلام نفسه
  assert.ok(Math.abs(w.createdAt.gte.getTime() - (before - dt.NATIVE_RECENT_WINDOW_MS)) < 2_000);
  assert.deepEqual(q.orderBy, { createdAt: 'desc' }, 'أحدث استقبال — لا أحدث التقاط');
  assert.deepEqual(q.select, { createdAt: true });
  // استُقبل قبل أكثر من ٩٠ث ودون ٥ دقائق (فجوة رفعٍ عادية بعد انقطاع): لا «يرفع الآن»، و«رُئي مؤخّراً» لسؤال التحقّق
  for (const l of locs) l.createdAt = new Date(Date.now() - dt.NATIVE_TRACK_WINDOW_MS - 1_000);
  assert.deepEqual(pick(await tokenReply()), { nativeActive: false, nativeRecent: true });
  // أكثر من ٥ دقائق: خدمةٌ لا ترفع
  for (const l of locs) l.createdAt = new Date(Date.now() - dt.NATIVE_RECENT_WINDOW_MS - 1_000);
  assert.deepEqual(pick(await tokenReply()), { nativeActive: false, nativeRecent: false });
});

test('/device-token: «رُئي مؤخّراً» من الذاكرة ٥ دقائق بعد آخر رفع (فجوةٌ عادية لجهازٍ سليم) بلا استعلام — ونقاط الصفحة تُخزَّن بعد ٩٠ث كما كانت', async () => {
  // آخر رفعٍ مقبول قبل دقيقتين (الجهاز في تراجعه بعد انقطاع تغطية أو 503)
  dt.markNativeTrack('free', Date.now() - dt.NATIVE_TRACK_WINDOW_MS - 30_000);
  assert.deepEqual(pick(await tokenReply()), { nativeActive: false, nativeRecent: true });
  assert.equal(locReads.length, 0, 'الذاكرة تعرفه');
  // حكم «يرفع الآن» لنقاط الصفحة لم يتّسع
  assert.equal(dt.nativeTrackActive('free'), false);
  assert.deepEqual((await call('/api/tracking/ping', { points: [pt()] }, bearer(session('free')))).body.data, { stored: 1 });
  // أكثر من ٥ دقائق: الذاكرة تنساه، ولا صفّ جهازٍ في النافذة
  locs = [];
  locReads = [];
  dt.markNativeTrack('free', Date.now() - dt.NATIVE_RECENT_WINDOW_MS - 1_000);
  assert.deepEqual(pick(await tokenReply()), { nativeActive: false, nativeRecent: false });
  assert.equal(locReads.length, 1);
});

test('رفع الإغلاق ثم /device-token: لا «رُئي مؤخّراً» عن خدمةٍ توقّفت ما دامت صفوف دفعتها الأخيرة في النافذة الأوسع', async () => {
  const now = Date.now();
  // دفعة الإغلاق استُقبلت قبل دقيقتين: صفوفها داخل الخمس دقائق
  const fresh = (o: Partial<Loc>): Loc => ({ tenantId: 't1', salesRepId: 'free', lat: 24.7, lng: 46.6, accuracy: 10, speed: null, capturedAt: new Date(now - 125_000), createdAt: new Date(now - 120_000), source: 'device', ...o });
  locs.push(fresh({}));
  dt.markNativeTrack('free', now - 121_000);
  dt.clearNativeTrack('free', now - 120_000);
  assert.deepEqual(pick(await tokenReply()), { nativeActive: false, nativeRecent: false });
  assert.equal(locReads.length, 0, 'الإغلاق معروف ٥ دقائق: لا استعلام يقرأ صفوفه');
  // بعد ٥ دقائق من الإغلاق تُقرأ القاعدة من جديد (صفوفه خرجت من النافذة عادةً)
  dt.clearNativeTrack('free', now - dt.NATIVE_RECENT_WINDOW_MS - 1_000);
  assert.deepEqual(pick(await tokenReply()), { nativeActive: false, nativeRecent: true });
  assert.equal(locReads.length, 1);
});

test('/device-token والذاكرة فارغة: صفّ الصفحة، وصفّ مندوبٍ آخر أو شركةٍ أخرى، ونقطةٌ قديمة أُعيد رفعها ⇒ لا «يرفع الآن»', async () => {
  const fresh = (o: Partial<Loc>): Loc => ({ tenantId: 't1', salesRepId: 'free', lat: 24.7, lng: 46.6, accuracy: 10, speed: null, capturedAt: new Date(), createdAt: new Date(), ...o });
  // نقطة صفحته الآن (بلا مصدر)
  assert.deepEqual((await call('/api/tracking/ping', { points: [pt()] }, bearer(session('free')))).body.data, { stored: 1 });
  locs.push(
    fresh({ source: 'device', salesRepId: 'strict' }),
    fresh({ source: 'device', tenantId: 't2' }),
    // التُقطت قبل ١٦ دقيقة ووصلت الآن (طابورٌ بعد انقطاع): خارج مدى الفهرس — بدءٌ ثانٍ لا يضرّ
    fresh({ source: 'device', capturedAt: new Date(Date.now() - 16 * 60_000) }),
  );
  assert.equal((await tokenReply()).nativeActive, false);
  // نقطة جهازه هو وصلت الآن ولو بساعةٍ متقدّمة
  locs.push(fresh({ source: 'device', capturedAt: new Date(Date.now() + 10 * 60_000) }));
  assert.equal((await tokenReply()).nativeActive, true);
});

test('رفع الإغلاق ثم /device-token: صفوف دفعته الأخيرة الحديثة لا تشهد بخدمةٍ توقّفت — ورفعٌ عاديّ بعده يعيدها', async () => {
  const tok = trackTok('free');
  await devicePing(tok, [pt()]);
  await devicePing(tok, [pt()], { 'x-fs-track-final': '1' });
  assert.ok(locs.length === 2 && locs.every((l) => l.source === 'device' && Date.now() - l.createdAt.getTime() < 5_000));
  locReads = [];
  assert.equal((await tokenReply()).nativeActive, false, 'منتصف الليل أو سحب الإذن: الصفحة تصدّق nativeActive فتعلّم يومها بلا خدمة');
  assert.equal(locReads.length, 0, 'الإغلاق معروف: لا استعلام');
  assert.equal(dt.nativeTrackStopped('free'), true);
  // بدءٌ جديد يرفع: «يعمل» من الذاكرة، وعلامة الإغلاق تزول
  await devicePing(tok, [pt()]);
  assert.equal(dt.nativeTrackStopped('free'), false);
  assert.equal((await tokenReply()).nativeActive, true);
  // ونشرٌ بعد الإغلاق ينساه: الصفوف الحديثة وحدها تحكم (أقصاه ٩٠ث بعد الإغلاق، والصفحة تحرس الخروج بـ«أُرسل بدءٌ»)
  await devicePing(tok, [], { 'x-fs-track-final': '1' });
  dt.resetNativeTrack();
  assert.equal((await tokenReply()).nativeActive, true);
});

// ─── مصدر النقطة (قرار المالك ٤ نوفمبر): الخلفية تسجّل حتى منتصف الليل، فالتقارير تفرّق نقطة الجهاز عن نقطة الصفحة ───
test('المصدر من المسار لا من الجسم: نقطة الجهاز «device» ولو ادّعى الجسم غيره، ونقطة الصفحة بلا مصدر ولو ادّعت «device»', async () => {
  let r = await devicePing(trackTok('free'), [{ ...pt(), source: null }, { ...pt(), source: 'web' }]);
  assert.equal(r.body.data.stored, 2);
  r = await call('/api/track-device/ping', { points: [pt()], source: 'web' }, bearer(trackTok('free')));
  assert.equal(r.body.data.stored, 1);
  assert.deepEqual(locs.map((l) => l.source), ['device', 'device', 'device']);
  locs = [];
  dt.resetNativeTrack();
  r = await call('/api/tracking/ping', { points: [{ ...pt(), source: 'device' }], source: 'device' }, bearer(session('free')));
  assert.deepEqual(r.body.data, { stored: 1 });
  assert.equal(locs.length, 1);
  assert.equal('source' in locs[0], false, 'جسم الصفحة صنع نقطة جهاز');
});

test('نقطة الجهاز لا تلمس «آخر ظهور» أبداً — دفعةٌ أحدث تحرّك الدبّوس ولحظته، والأقدم لا تكتب شيئاً، والصفحة تكتبه كما كانت', async () => {
  const tok = trackTok('free');
  await devicePing(tok, [pt({ lat: 24.71, capturedAt: new Date(Date.now() - 5_000).toISOString() })]);
  const loc1 = repRows.free.lastLocAt as Date;
  assert.ok(loc1 instanceof Date);
  assert.equal(repRows.free.lastSeenAt, undefined);
  // دفعةٌ أقدم أعاد الجهاز رفعها بعد انقطاع: تُخزَّن في المسار ولا يُكتب على المندوب شيء
  await devicePing(tok, [pt({ lat: 24.50, capturedAt: new Date(Date.now() - 600_000).toISOString() })]);
  assert.equal(repRows.free.lastLat, 24.71);
  assert.equal((repRows.free.lastLocAt as Date).getTime(), loc1.getTime());
  assert.equal(repRows.free.lastSeenAt, undefined, 'الدفعة الأقدم من الجهاز لمست «آخر ظهور»');
  assert.equal(locs.length, 2);
  // الصفحة مفتوحة أمامه (والجهاز يرفع ⇒ native): «آخر ظهور» يُلمس كما كان
  assert.deepEqual((await call('/api/tracking/ping', { points: [pt()] }, bearer(session('free')))).body.data, { stored: 0, native: true });
  // (قراءةٌ جديدة من الصفّ: التأكيدان السابقان ضيّقا النوع إلى undefined)
  assert.ok(repRow('free').lastSeenAt instanceof Date);
  // المقيَّد من الجهاز كذلك: موقعه يُخزَّن ويتحرّك دبّوسه، و«آخر ظهور» لصفحته وحدها
  await devicePing(trackTok('strict'), [pt()]);
  assert.ok(repRows.strict.lastLocAt instanceof Date);
  assert.equal(repRows.strict.lastSeenAt, undefined);
});

// ─── خطّ السير: أحدث ٥٠٠٠ نقطة لا أولاها (مراجعة ٤ نوفمبر) ───
test('/tracking/route: يومٌ فوق سقف ٥٠٠٠ نقطة يعيد أحدثها تصاعدياً — لا يُقطع آخر اليوم، والردّ بشكله', async () => {
  const day = '2026-11-03';
  const t0 = Date.parse(`${day}T00:00:00.000Z`);
  const n = 5003;
  const loc = (i: number, o: Partial<Loc> = {}): Loc => ({
    tenantId: 't1', salesRepId: 'strict', lat: 24.7, lng: 46.6, accuracy: 10, speed: null, capturedAt: new Date(t0 + i * 10_000), createdAt: new Date(), ...o,
  });
  // تُدرج مقلوبةً: الترتيب من الاستعلام لا من الإدراج
  for (let i = n - 1; i >= 0; i--) locs.push(loc(i));
  // يومٌ آخر ومندوبٌ آخر خارج الخطّ
  locs.push(loc(n + 9_000), loc(n - 1, { salesRepId: 'free' }));
  const admin = bearer(session('a1', 'ADMIN'));
  const r = await get(`/api/tracking/route?salesRepId=strict&date=${day}&snap=0`, admin);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['checkIn', 'checkOut', 'data', 'routeHidden', 'shape', 'snapped', 'success']);
  const at = (r.body.data as { capturedAt: string }[]).map((p) => Date.parse(p.capturedAt));
  assert.equal(at.length, 5000);
  assert.equal(at[0], t0 + 3 * 10_000, 'المقطوع أوّل اليوم');
  assert.equal(at[at.length - 1], t0 + (n - 1) * 10_000, 'آخر نقطةٍ في اليوم حاضرة');
  assert.ok(at.every((t, i) => i === 0 || t > at[i - 1]), 'تصاعدياً كما كان الردّ');
  assert.deepEqual(Object.keys(r.body.data[0]).sort(), ['accuracy', 'capturedAt', 'lat', 'lng', 'speed']);
  assert.equal(r.body.shape, null);
  assert.equal(r.body.snapped, null);
  assert.equal(r.body.routeHidden, false);

  // تحت السقف: اليوم كلّه تصاعدياً كما كان
  locs = [loc(7), loc(2), loc(5)];
  const small = await get(`/api/tracking/route?salesRepId=strict&date=${day}&snap=0`, admin);
  assert.deepEqual((small.body.data as { capturedAt: string }[]).map((p) => Date.parse(p.capturedAt)), [2, 5, 7].map((i) => t0 + i * 10_000));
});
