// بصمة الحضور والانصراف — منطق المسار (checkin/checkout/today) فوق Prisma مزيّف في الذاكرة، بلا قاعدة.
// نثبت: نوبة واحدة مفتوحة، والحضور المكرّر لا يفتح ثانية، والانصراف يغلق ويعيد مدّة، وانصرافٌ بلا حضور ⇒ 409.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Router } from 'express';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// جدول rep_attendance في الذاكرة
type Shift = { id: string; tenantId: string; salesRepId: string; checkInAt: Date; checkInLat: number | null; checkInLng: number | null; checkOutAt: Date | null; checkOutLat: number | null; checkOutLng: number | null; createdAt: Date };
let rows: Shift[] = [];
let seq = 0;

const matches = (r: Shift, w: Record<string, unknown>): boolean =>
  Object.entries(w).every(([k, v]) => {
    if (v && typeof v === 'object' && 'gte' in (v as object)) return (r[k as keyof Shift] as Date | null) != null && (r[k as keyof Shift] as Date) >= (v as { gte: Date }).gte;
    return (r[k as keyof Shift] as unknown) === v;
  });
const pick = (r: Shift, sel?: Record<string, boolean>): Record<string, unknown> => {
  if (!sel) return { ...r };
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(sel)) o[k] = r[k as keyof Shift];
  return o;
};
const sortDesc = (a: Shift, b: Shift, key: keyof Shift): number =>
  ((b[key] as Date | null)?.getTime() ?? 0) - ((a[key] as Date | null)?.getTime() ?? 0);

const repAttendance = {
  async findFirst(args: { where: Record<string, unknown>; orderBy?: Record<string, 'asc' | 'desc'>; select?: Record<string, boolean> }) {
    let list = rows.filter((r) => matches(r, args.where));
    if (args.orderBy) { const [k, dir] = Object.entries(args.orderBy)[0]; list = [...list].sort((a, b) => (dir === 'desc' ? sortDesc(a, b, k as keyof Shift) : -sortDesc(a, b, k as keyof Shift))); }
    return list[0] ? pick(list[0], args.select) : null;
  },
  async create(args: { data: Partial<Shift>; select?: Record<string, boolean> }) {
    const r: Shift = { id: `s${++seq}`, checkInLat: null, checkInLng: null, checkOutAt: null, checkOutLat: null, checkOutLng: null, createdAt: new Date(), ...(args.data as Shift) };
    rows.push(r);
    return pick(r, args.select);
  },
  async update(args: { where: { id: string }; data: Partial<Shift>; select?: Record<string, boolean> }) {
    const r = rows.find((x) => x.id === args.where.id)!;
    Object.assign(r, args.data);
    return pick(r, args.select);
  },
};

stub('config/database', { default: { repAttendance } });
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../routes/tracking').default as Router;

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
async function call(method: 'get' | 'post', p: string, opts: { user?: unknown; body?: unknown; query?: unknown } = {}) {
  const res = mockRes();
  await handler(method, p)({ user: 'user' in opts ? opts.user : REP, body: opts.body ?? {}, query: opts.query ?? {} }, res, (e?: unknown) => { if (e) throw e; });
  return res;
}
const data = (res: { body: Record<string, unknown> | null }) => (res.body!.data as Record<string, unknown>);

test('قبل أي بصمة: اليوم status=none', async () => {
  rows = []; seq = 0;
  const res = await call('get', '/attendance/today');
  assert.equal(res.statusCode, 200);
  assert.equal(data(res).status, 'none');
});

test('الحضور يفتح نوبة واحدة، ويسجّل الموقع', async () => {
  rows = []; seq = 0;
  const res = await call('post', '/attendance/checkin', { body: { lat: 24.7, lng: 46.6 } });
  assert.equal(data(res).status, 'in');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].checkInLat, 24.7);
  assert.equal(rows[0].checkOutAt, null);
});

test('الحضور المكرّر لا يفتح نوبة ثانية (already)', async () => {
  rows = []; seq = 0;
  await call('post', '/attendance/checkin', {});
  const res2 = await call('post', '/attendance/checkin', {});
  assert.equal(rows.length, 1, 'نوبة واحدة فقط');
  assert.equal((data(res2) as { already?: boolean }).already, true);
});

test('اليوم يعكس النوبة المفتوحة', async () => {
  rows = []; seq = 0;
  await call('post', '/attendance/checkin', {});
  const res = await call('get', '/attendance/today');
  assert.equal(data(res).status, 'in');
});

test('الانصراف يغلق النوبة ويعيد وقتَي الحضور والانصراف', async () => {
  rows = []; seq = 0;
  await call('post', '/attendance/checkin', {});
  const res = await call('post', '/attendance/checkout', { body: { lat: 24.8, lng: 46.7 } });
  assert.equal(data(res).status, 'out');
  assert.equal(rows[0].checkOutAt instanceof Date, true);
  assert.equal(rows[0].checkOutLat, 24.8);
  const last = (data(res).last as { checkInAt: Date; checkOutAt: Date });
  assert.ok(last.checkInAt && last.checkOutAt);
});

test('انصراف بلا حضور مفتوح ⇒ 409 NO_OPEN_SHIFT', async () => {
  rows = []; seq = 0;
  const res = await call('post', '/attendance/checkout', {});
  assert.equal(res.statusCode, 409);
  assert.equal(res.body!.code, 'NO_OPEN_SHIFT');
});

test('غير المندوب ممنوع (403) من كل النقاط', async () => {
  rows = []; seq = 0;
  const admin = { role: 'ADMIN', id: 'a1', tenantId: 't1' };
  for (const [m, p] of [['get', '/attendance/today'], ['post', '/attendance/checkin'], ['post', '/attendance/checkout']] as const) {
    const res = await call(m, p, { user: admin });
    assert.equal(res.statusCode, 403, `${m} ${p}`);
  }
});
