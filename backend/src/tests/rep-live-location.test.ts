// «اشتراط تفعيل الموقع» — القفل الكامل على الخادم (أمر المالك، ٦ أكتوبر ٢٠٢٦): المندوب المقيَّد لا يغيّر بياناً إلا ظاهراً على
// الخريطة الآن بموقعٍ دقيق. الحارس (middleware/repLiveLocation.ts) ونقطة الموقع (POST /tracking/ping) فوق Prisma مزيّف في
// الذاكرة، بلا قاعدة. نثبت: النقطة الطازجة الدقيقة وحدها تفتح، والقديمة/الغائبة/غير الدقيقة تُردّ بسببها، والقراءة والمستثنى
// يمرّان، وغير المقيَّد كما كان، وعزل الشركات، والحزمة القديمة «حدّث التطبيق» بلا إعدام مستندها المصفوف.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import type { Router } from 'express';

process.env.JWT_SECRET = 'live-location-test-secret';
const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ─── Prisma مزيّف ───
type Loc = { tenantId: string; salesRepId: string; lat: number; lng: number; accuracy: number | null; speed?: number | null; capturedAt: Date; createdAt: Date };
let locs: Loc[] = [];
let repReads: Record<string, unknown>[] = [];
let locQueries = 0;
const reps: Record<string, { tenantId: string; requireLocationOn: boolean; canBeTracked?: boolean }> = {
  strict: { tenantId: 't1', requireLocationOn: true },
  free: { tenantId: 't1', requireLocationOn: false },
};
let trackingEnabled = true;

type Range = { gte?: Date; lte?: Date };
const inRange = (d: Date, r?: Range) => !r || ((!r.gte || d >= r.gte) && (!r.lte || d <= r.lte));
const prisma = {
  salesRep: {
    async findFirst(a: { where: { id: string; tenantId: string }; select: Record<string, boolean> }) {
      repReads.push(a.where);
      const r = reps[a.where.id];
      if (!r || r.tenantId !== a.where.tenantId) return null;
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(a.select)) o[k] = (r as Record<string, unknown>)[k];
      return o;
    },
    async update() { return {}; },
  },
  repLocation: {
    async findFirst(a: { where: { tenantId: string; salesRepId: string; capturedAt?: Range; createdAt?: Range }; orderBy: { capturedAt: 'desc' } }) {
      locQueries++;
      assert.deepEqual(a.orderBy, { capturedAt: 'desc' });
      const list = locs.filter((l) => l.tenantId === a.where.tenantId && l.salesRepId === a.where.salesRepId
        && inRange(l.capturedAt, a.where.capturedAt) && inRange(l.createdAt, a.where.createdAt))
        .sort((x, y) => y.capturedAt.getTime() - x.capturedAt.getTime());
      return list[0] ? { lat: list[0].lat, lng: list[0].lng, accuracy: list[0].accuracy, capturedAt: list[0].capturedAt, createdAt: list[0].createdAt } : null;
    },
    async createMany(a: { data: Omit<Loc, 'createdAt'>[] }) {
      const now = new Date();
      for (const d of a.data) locs.push({ ...d, createdAt: now });
      return { count: a.data.length };
    },
  },
  companySettings: { async findUnique() { return { trackingEnabled }; } },
};
stub('config/database', { default: prisma });
stub('middleware/auth', {
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdminPermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  tenantId: (req: { user?: { tenantId?: string } }) => req.user!.tenantId!,
});
stub('services/adminScope', { adminRepFilter: async () => ({}), scopedRepRecordWhere: async () => ({}), scopedRecordWhere: async () => ({}), canAccessRep: async () => true, SHAPE_VISIT: {} });
stub('services/mapMatch', { snapToRoads: async () => [], routeThrough: async () => [] });
stub('services/routeShape', { buildRouteShape: () => ({}) });
stub('services/repHeartbeat', { heartbeatClientState: () => ({}) });

/* eslint-disable @typescript-eslint/no-var-requires */
const live = require('../services/liveLocation') as typeof import('../services/liveLocation');
const { requireRepLiveLocation } = require('../middleware/repLiveLocation') as typeof import('../middleware/repLiveLocation');
const trackingRouter = require('../routes/tracking').default as Router;
/* eslint-enable @typescript-eslint/no-var-requires */

const tok = (p: Record<string, unknown>) => jwt.sign(p, process.env.JWT_SECRET!);
const STRICT = tok({ id: 'strict', role: 'SALES_REP', name: 'م', tenantId: 't1' });
const FREE = tok({ id: 'free', role: 'SALES_REP', name: 'ح', tenantId: 't1' });
const ADMIN = tok({ id: 'a1', role: 'ADMIN', name: 'مدير', tenantId: 't1' });

interface Res { statusCode: number; body: Record<string, unknown> | null; headers: Record<string, string>; status(c: number): Res; json(b: unknown): Res; setHeader(k: string, v: string): void }
async function guard(method: string, p: string, opts: { token?: string | null; caps?: string | null; replay?: boolean } = {}) {
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? STRICT : opts.token;
  if (token) headers.authorization = `Bearer ${token}`;
  const caps = opts.caps === undefined ? 'zatca2,liveloc' : opts.caps;
  if (caps) headers['x-fs-caps'] = caps;
  if (opts.replay) headers['x-fs-replay'] = '1';
  const res: Res = {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b as Record<string, unknown>; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  };
  let passed = false; let error: unknown = null;
  await requireRepLiveLocation({ method, path: p, headers } as never, res as never, (e?: unknown) => { if (e) error = e; else passed = true; });
  if (error) throw error;
  return { passed, res };
}
const reset = () => { locs = []; repReads = []; locQueries = 0; trackingEnabled = true; };
const ago = (ms: number) => new Date(Date.now() - ms);
const point = (o: Partial<Loc> = {}): Loc => ({ tenantId: 't1', salesRepId: 'strict', lat: 24.7136, lng: 46.6753, accuracy: 20, capturedAt: ago(5_000), createdAt: ago(3_000), ...o });

test('القيم الموثّقة: النافذة ٩٠ث والدقّة ١٠٠م — ويطابقها التطبيق حرفياً', () => {
  assert.equal(live.LIVE_WINDOW_MS, 90_000);
  assert.equal(live.LIVE_MAX_ACCURACY_M, 100);
  assert.equal(live.LIVE_CAP, 'liveloc');
  const web = fs.readFileSync(path.join(SRC, '..', '..', 'web-admin', 'src', 'rep', 'liveGate.ts'), 'utf8');
  assert.match(web, /export const LIVE_WINDOW_MS = 90_000;/);
  assert.match(web, /export const LIVE_MAX_ACCURACY_M = 100;/);
});

test('نقطةٌ طازجة دقيقة ⇒ يمرّ الإجراء (فاتورة، سند، زيارة، عميل، بصمة، تحميل، مرتجع، إلغاء…)', async () => {
  reset();
  locs.push(point());
  for (const [m, p] of [['POST', '/invoices'], ['POST', '/receipts'], ['POST', '/visits'], ['POST', '/customers'], ['PUT', '/customers/c1'],
    ['POST', '/tracking/attendance/checkin'], ['POST', '/van-stock/loads'], ['PATCH', '/invoices/i1/cancel'], ['PATCH', '/receipts/r1/cancel'],
    ['POST', '/ai-rep/rep/outcomes'], ['POST', '/daily-reports'], ['POST', '/auth/change-password'], ['PATCH', '/notifications/read-all']]) {
    const { passed, res } = await guard(m, p);
    assert.equal(passed, true, `${m} ${p}`);
    assert.equal(res.body, null);
  }
});

test('لا نقطة / نقطة قديمة الاستقبال أو الالتقاط ⇒ 409 LOCATION_REQUIRED برسالة المالك ولا يمرّ', async () => {
  for (const [label, pts] of [
    ['لا نقطة', []],
    ['استُقبلت قبل دقيقتين', [point({ createdAt: ago(120_000), capturedAt: ago(121_000) })]],
    ['التُقطت قبل دقيقتين وإن وصلت الآن (قراءة مخبّأة)', [point({ capturedAt: ago(120_000), createdAt: ago(1_000) })]],
    ['(0،0)', [point({ lat: 0, lng: 0 })]],
  ] as [string, Loc[]][]) {
    reset();
    locs.push(...pts);
    const { passed, res } = await guard('POST', '/visits');
    assert.equal(passed, false, label);
    assert.equal(res.statusCode, 409, label);
    assert.equal(res.body!.code, 'LOCATION_REQUIRED', label);
    assert.equal(res.body!.message, 'فعّل الموقع وانتظر تحديد موقعك ثم أعد المحاولة');
    assert.equal(res.body!.reason, 'NO_FIX', label);
  }
});

test('الدقّة: ١٠٠م تمرّ، و١٥٠م أو غائبة ⇒ INACCURATE — والأحدث يحكم لا الأفضل', async () => {
  reset(); locs.push(point({ accuracy: 100 }));
  assert.equal((await guard('POST', '/invoices')).passed, true);
  for (const accuracy of [150, null, -1, 5000]) {
    reset(); locs.push(point({ accuracy }));
    const { passed, res } = await guard('POST', '/invoices');
    assert.equal(passed, false, String(accuracy));
    assert.equal(res.body!.reason, 'INACCURATE', String(accuracy));
  }
  // دقيقةٌ قبل ٢٠ث ثم تقريبيةٌ الآن: الدبّوس على الخريطة هو الأحدث — لا مكان بعينه
  reset();
  locs.push(point({ accuracy: 10, capturedAt: ago(20_000), createdAt: ago(19_000) }), point({ accuracy: 3000, capturedAt: ago(2_000), createdAt: ago(1_000) }));
  assert.equal((await guard('POST', '/invoices')).res.body!.reason, 'INACCURATE');
});

test('القراءة والمستثنى يمرّان بلا قراءة قاعدة: GET والدخول والتجديد ورمز الإشعارات ونقطة الموقع ونبضة الحضور', async () => {
  reset();
  for (const [m, p] of [['GET', '/invoices'], ['HEAD', '/customers'], ['OPTIONS', '/visits'], ['GET', '/auth/me'],
    ['POST', '/auth/login'], ['POST', '/auth/renew'], ['POST', '/auth/refresh-fcm'], ['POST', '/tracking/ping'], ['POST', '/tracking/heartbeat'],
    ['POST', '/Tracking/Ping/'], ['post', '/tracking/heartbeat']]) {
    const { passed } = await guard(m, p);
    assert.equal(passed, true, `${m} ${p}`);
  }
  assert.equal(repReads.length, 0, 'لا قراءة للمندوب في المستثنى');
  // ما يشبه المستثنى ولا يطابقه يُحرس (الاتجاه الآمن)
  for (const [m, p] of [['POST', '/tracking/ping/x'], ['PATCH', '/tracking/ping'], ['POST', '/tracking/attendance/checkout'], ['DELETE', '/auth/login'], ['POST', '/auth/change-password']]) {
    const { passed } = await guard(m, p);
    assert.equal(passed, false, `${m} ${p}`);
  }
});

test('غير المقيَّد والإدارة والتوكن الغائب/الفاسد: يمرّ كما كان (والمصادقة في الموجّه تحكم)', async () => {
  reset();
  for (const token of [FREE, ADMIN, null, 'not-a-jwt', tok({ id: 'strict', role: 'SALES_REP', tenantId: 't1' }).slice(0, -2) + 'xx']) {
    const { passed, res } = await guard('POST', '/invoices', { token, caps: null });
    assert.equal(passed, true, String(token));
    assert.equal(res.body, null);
  }
  assert.equal(locQueries, 0, 'لا استعلام موقعٍ لغير المقيَّد');
});

test('عزل الشركات: القيد ونقاط الموقع تُقرأ بمعرّف المندوب وشركة التوكن معاً', async () => {
  reset();
  // نقطةٌ طازجة للمعرّف نفسه في شركةٍ أخرى لا تفتح له
  locs.push(point({ tenantId: 't2' }));
  const a = await guard('POST', '/receipts');
  assert.equal(a.passed, false);
  assert.deepEqual(repReads[0], { id: 'strict', tenantId: 't1' });
  // توكنٌ بالمعرّف نفسه لشركةٍ ليس فيها هذا المندوب: لا يُعدّ مقيَّداً من قيد شركةٍ أخرى
  reset();
  const other = tok({ id: 'strict', role: 'SALES_REP', name: 'م', tenantId: 't2' });
  const b = await guard('POST', '/receipts', { token: other });
  assert.equal(b.passed, true);
  assert.deepEqual(repReads[0], { id: 'strict', tenantId: 't2' });
  assert.equal(locQueries, 0);
});

test('حزمةٌ لا تعلن liveloc (تطبيقٌ قديم أو Flutter): 426 للحيّ، و503 لإعادة الرفع فيبقى المستند مصفوفاً لا يُعدم', async () => {
  reset();
  locs.push(point()); // ولو كان حيّاً — الحزمة القديمة لا ترسل نقطةً قبل الإجراء وتصفّ دون اتصال
  const liveReq = await guard('POST', '/invoices', { caps: 'zatca2' });
  assert.equal(liveReq.passed, false);
  assert.equal(liveReq.res.statusCode, 426);
  assert.equal(liveReq.res.body!.code, 'LOCATION_APP_UPDATE');
  const replay = await guard('POST', '/invoices', { caps: null, replay: true });
  assert.equal(replay.res.statusCode, 503, 'offlineSync القديم يتوقّف عند 5xx ويُبقي المستند');
  assert.equal(replay.res.headers['retry-after'], '300');
  // الحزمة الحديثة بإعادة الرفع وهو حيّ ⇒ يمرّ (مستندٌ مصفوفٌ من قبل القيد لا يضيع)
  assert.equal((await guard('POST', '/invoices', { replay: true })).passed, true);
});

test('liveVerdict صرف: STALE لقديم الاستقبال/الالتقاط ولالتقاطٍ في المستقبل، وNaN يُرفض لا يُقبل', () => {
  const now = Date.now();
  const p = (o: Partial<Loc> = {}) => ({ lat: 24.7, lng: 46.6, accuracy: 30, capturedAt: new Date(now - 1000), createdAt: new Date(now - 500), ...o });
  assert.deepEqual(live.liveVerdict(p(), now), { ok: true });
  assert.deepEqual(live.liveVerdict(p({ createdAt: new Date(now - 90_001) }), now), { ok: false, reason: 'STALE' });
  assert.deepEqual(live.liveVerdict(p({ capturedAt: new Date(now - 90_001) }), now), { ok: false, reason: 'STALE' });
  assert.deepEqual(live.liveVerdict(p({ capturedAt: new Date(now + 60_000) }), now), { ok: false, reason: 'STALE' });
  assert.deepEqual(live.liveVerdict(p({ capturedAt: new Date('x') }), now), { ok: false, reason: 'STALE' });
  assert.deepEqual(live.liveVerdict(p({ accuracy: Number.NaN }), now), { ok: false, reason: 'INACCURATE' });
  assert.deepEqual(live.liveVerdict(null, now), { ok: false, reason: 'NO_FIX' });
  assert.deepEqual(live.liveVerdict(p({ lat: Number.NaN }), now), { ok: false, reason: 'NO_FIX' });
});

test('correctCapturedAt: إزاحة ساعة الجهاز إلى ساعة الخادم ولا مستقبل، وبلا ترويسة القصّ وحده', () => {
  const server = Date.UTC(2026, 9, 6, 9, 0, 0);
  const dev = server - 10 * 60_000; // ساعة الجهاز متأخّرة ١٠ دقائق
  const capturedDev = new Date(dev - 4_000).toISOString(); // التُقطت قبل ٤ث بساعته
  assert.equal(live.correctCapturedAt(capturedDev, String(dev), server).getTime(), server - 4_000);
  // ساعةٌ متقدّمة ساعةً: قراءةٌ قبل ٢٠ث بساعتها ليست «الآن + ساعة»
  const ahead = server + 3_600_000;
  assert.equal(live.correctCapturedAt(new Date(ahead - 20_000).toISOString(), String(ahead), server).getTime(), server - 20_000);
  // بلا ترويسة: المستقبل يُقصّ إلى الآن، والماضي كما هو
  assert.equal(live.correctCapturedAt(new Date(server + 999_999).toISOString(), undefined, server).getTime(), server);
  assert.equal(live.correctCapturedAt(new Date(server - 7_000).toISOString(), 'garbage', server).getTime(), server - 7_000);
  // غائبة أو فاسدة ⇒ لحظة الاستقبال
  assert.equal(live.correctCapturedAt(undefined, undefined, server).getTime(), server);
  assert.equal(live.correctCapturedAt('not-a-date', String(dev), server).getTime(), server);
});

// ─── POST /tracking/ping ───
interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => unknown }[] } }
function pingHandler() {
  for (const l of (trackingRouter as unknown as { stack: Layer[] }).stack) {
    const r = l.route;
    if (r && r.path === '/ping' && r.methods.post) return r.stack[r.stack.length - 1].handle;
  }
  throw new Error('POST /tracking/ping غير مسجّل');
}
async function ping(repId: string, points: Record<string, unknown>[], headers: Record<string, string> = {}) {
  const res = { statusCode: 200, body: null as Record<string, unknown> | null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b as Record<string, unknown>; return this; } };
  let error: unknown = null;
  await pingHandler()({ user: { role: 'SALES_REP', id: repId, tenantId: 't1' }, body: { points }, headers }, res, (e?: unknown) => { if (e) error = e; });
  if (error) throw error;
  return res.body!.data as { stored: number; disabled?: boolean; live?: { ok: boolean; reason?: string } };
}

test('نقطة المقيَّد تُخزَّن ولو أُطفئ التتبّع للشركة أو استُثني، ويعود حكم الخادم معها — وبها يمرّ الإجراء', async () => {
  reset();
  trackingEnabled = false;
  reps.strict.canBeTracked = false;
  try {
    const d = await ping('strict', [{ lat: 24.71, lng: 46.67, accuracy: 15, capturedAt: new Date(Date.now() - 3_000).toISOString() }], { 'x-fs-device-now': String(Date.now()) });
    assert.equal(d.stored, 1);
    assert.equal(d.disabled, undefined);
    assert.deepEqual(d.live, { ok: true });
    assert.equal(locs.length, 1);
    assert.equal((await guard('POST', '/invoices')).passed, true, 'النقطة نفسها تفتح الإجراء التالي');
    // غير الدقيقة تُخزَّن (أثر المسار) لكن حكمها INACCURATE
    const bad = await ping('strict', [{ lat: 24.71, lng: 46.67, accuracy: 900, capturedAt: new Date().toISOString() }]);
    assert.deepEqual(bad.live, { ok: false, reason: 'INACCURATE' });
  } finally {
    delete reps.strict.canBeTracked;
  }
});

test('غير المقيَّد كما كان: التتبّع المطفأ لا يُخزّن، ولا حكم في الردّ، ولا تصحيح للحظة', async () => {
  reset();
  trackingEnabled = false;
  const off = await ping('free', [{ lat: 24.71, lng: 46.67, accuracy: 15 }]);
  assert.deepEqual(off, { stored: 0, disabled: true });
  assert.equal(locs.length, 0);
  trackingEnabled = true;
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const on = await ping('free', [{ lat: 24.71, lng: 46.67, accuracy: 15, capturedAt: future }], { 'x-fs-device-now': '1' });
  assert.deepEqual(on, { stored: 1 });
  assert.equal(locs[0].capturedAt.toISOString(), future);
});

test('نقطة المقيَّد بساعة جهازٍ متأخّرة تُصحَّح فتُعدّ طازجة، وبساعةٍ متقدّمة لا تُخزَّن في المستقبل', async () => {
  reset();
  const skew = 15 * 60_000;
  const devNow = Date.now() - skew;
  const d = await ping('strict', [{ lat: 24.71, lng: 46.67, accuracy: 15, capturedAt: new Date(devNow - 2_000).toISOString() }], { 'x-fs-device-now': String(devNow) });
  assert.deepEqual(d.live, { ok: true }, 'لولا التصحيح لبدت قبل ربع ساعة');
  assert.ok(Math.abs(locs[0].capturedAt.getTime() - (Date.now() - 2_000)) < 1_000);
  reset();
  await ping('strict', [{ lat: 24.71, lng: 46.67, accuracy: 15, capturedAt: new Date(Date.now() + 3_600_000).toISOString() }]);
  assert.ok(locs[0].capturedAt.getTime() <= Date.now());
});

test('حارس ثابت: الحارس مركَّب مرةً على /api بعد محدِّد المعدّل وقبل أول موجّه', () => {
  const idx = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8');
  const limiter = idx.indexOf("app.use('/api', apiLimiter);");
  const guardAt = idx.indexOf("app.use('/api', requireRepLiveLocation);");
  const firstRouter = idx.indexOf("app.use('/api/auth', authRouter);");
  assert.ok(limiter > 0 && guardAt > limiter && firstRouter > guardAt);
  assert.equal(idx.split('requireRepLiveLocation);').length - 1, 1);
  // كل موجّهٍ يصله المندوب بعده (لا شيء منها مركَّب قبل الحارس)
  for (const r of ['invoicesRouter', 'receiptsRouter', 'customersRouter', 'visitsRouter', 'trackingRouter', 'vanStockRouter', 'dailyReportsRouter', 'aiRepRouter', 'paylinkRouter', 'notificationsRouter']) {
    const at = idx.indexOf(`, ${r})`);
    assert.ok(at > guardAt, `${r} قبل الحارس`);
  }
});
