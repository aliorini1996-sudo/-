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
    if (k === 'OR') return (v as Record<string, unknown>[]).some((sub) => matches(r, sub));
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
  async findMany(args: { where: Record<string, unknown>; orderBy?: Record<string, 'asc' | 'desc'>; take?: number; select?: Record<string, boolean> }) {
    let list = rows.filter((r) => matches(r, args.where));
    if (args.orderBy) { const [k, dir] = Object.entries(args.orderBy)[0]; list = [...list].sort((a, b) => (dir === 'desc' ? sortDesc(a, b, k as keyof Shift) : -sortDesc(a, b, k as keyof Shift))); }
    return list.slice(0, args.take ?? list.length).map((r) => pick(r, args.select));
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

let featureOn = true;
const tenant = { async findUnique() { return { attendanceEnabled: featureOn }; } };
// «اشتراط تفعيل الموقع» على المندوب (مطفأ افتراضاً كما في المخطط)
let locationRequired = false;
// «بصمة الحضور بموقع عميل» (مطفأ افتراضاً): مفعّلٌ ⇒ يُبحث عن عميلٍ قريب
let punchAtCustomer = false;
// مسافة البصمة كما حدّدتها الإدارة للمندوب (٥٠ افتراضاً كما في المخطط)
let punchRadius: unknown = 50;
let nearCustomers: { lat: number; lng: number }[] = [];
const salesRep = {
  async findUnique() { return { requireLocationOn: locationRequired }; },
  async findFirst() { return { requireLocationOn: locationRequired, requirePunchAtCustomer: punchAtCustomer, punchRadiusM: punchRadius }; },
};
const customer = { async findMany() { return nearCustomers; } };
const companySettings = { async findUnique() { return { customerIsolationEnabled: false }; } };
stub('config/database', { default: { repAttendance, tenant, salesRep, customer, companySettings } });
stub('middleware/auth', {
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdminPermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  tenantId: (req: { user?: { tenantId?: string } }) => req.user!.tenantId!,
});
stub('services/adminScope', { adminRepFilter: async () => ({}), scopedRepRecordWhere: async () => ({}), scopedRecordWhere: async () => ({}), canAccessRep: async () => true, SHAPE_VISIT: {} });
stub('services/mapMatch', { snapToRoads: async () => [], routeThrough: async () => [] });
// haversineM الحقيقية: حارس «البصمة بموقع عميل» يحكم بها، وتزييفها يُفرغ اختباره من معناه
const R_EARTH = 6371000; const toRad = (d: number) => (d * Math.PI) / 180;
stub('services/routeShape', {
  buildRouteShape: () => ({}),
  haversineM: (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
    const s = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lng - a.lng) / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
  },
});
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
  rows = []; seq = 0; featureOn = true;
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
  rows = []; seq = 0; featureOn = true;
  const admin = { role: 'ADMIN', id: 'a1', tenantId: 't1' };
  for (const [m, p] of [['get', '/attendance/today'], ['post', '/attendance/checkin'], ['post', '/attendance/checkout']] as const) {
    const res = await call(m, p, { user: admin });
    assert.equal(res.statusCode, 403, `${m} ${p}`);
  }
});

test('الميزة مطفأة للشركة ⇒ 403 ATTENDANCE_DISABLED ولا كتابة', async () => {
  rows = []; seq = 0; featureOn = false;
  const res = await call('post', '/attendance/checkin', {});
  assert.equal(res.statusCode, 403);
  assert.equal(res.body!.code, 'ATTENDANCE_DISABLED');
  assert.equal(rows.length, 0, 'لم تُفتح نوبة والميزة مطفأة');
  featureOn = true;
});

test('«اشتراط تفعيل الموقع» لا يحرس البصمة (أمر المالك ٧ أكتوبر: القيد على صفحة العميل وحدها) — تُسجَّل بموقعها إن وُجد وبدونه', async () => {
  rows = []; seq = 0; featureOn = true; locationRequired = true;
  try {
    assert.equal(data(await call('post', '/attendance/checkin', {})).status, 'in', 'حضورٌ بلا موقع يُسجَّل');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].checkInLat, null);
    assert.equal(data(await call('post', '/attendance/checkout', {})).status, 'out', 'انصرافٌ بلا موقع يُسجَّل');
    assert.ok(rows[0].checkOutAt instanceof Date);
    assert.equal(data(await call('post', '/attendance/checkin', { body: { lat: 24.7, lng: 46.6 } })).status, 'in');
    assert.equal(rows[1].checkInLat, 24.7, 'والموقع يُسجَّل إن أرسله الجوال');
  } finally { locationRequired = false; }
});

// ═══ «بصمة الحضور بموقع عميل» (طلب المالك، ١٩ أكتوبر) ═══
// موقعٌ في الرياض، وعميلٌ على بعد ~٣٠م شمالاً، وآخر في زاوية مربّع البحث (~٧٠م قطرياً)
const HERE = { lat: 24.7136, lng: 46.6753 };
const NEAR = { lat: 24.7136 + 30 / 111320, lng: 46.6753 };
const CORNER = { lat: 24.7136 + 49 / 111320, lng: 46.6753 + 49 / (111320 * Math.cos(24.7136 * Math.PI / 180)) };
const codeOf = (res: { body: Record<string, unknown> | null }) => (res.body as { code?: string } | null)?.code;

test('بصمة بموقع عميل: بلا موقع ⇒ 409 برسالة تُعرض، ولا تُكتب نوبة', async () => {
  rows = []; seq = 0; featureOn = true; punchAtCustomer = true; nearCustomers = [NEAR];
  try {
    const r = await call('post', '/attendance/checkin', {});
    assert.equal(r.statusCode, 409);
    assert.equal(codeOf(r), 'PUNCH_AWAY_FROM_CUSTOMER');
    assert.match(String((r.body as { message?: string }).message), /الموقع/);
    assert.equal(rows.length, 0, 'لا نوبة تُفتح');
  } finally { punchAtCustomer = false; nearCustomers = []; }
});

test('بصمة بموقع عميل: لا عميل في النطاق ⇒ 409', async () => {
  rows = []; seq = 0; featureOn = true; punchAtCustomer = true; nearCustomers = [];
  try {
    const r = await call('post', '/attendance/checkin', { body: HERE });
    assert.equal(r.statusCode, 409);
    assert.equal(codeOf(r), 'PUNCH_AWAY_FROM_CUSTOMER');
    assert.equal(rows.length, 0);
  } finally { punchAtCustomer = false; }
});

test('بصمة بموقع عميل: عميل على ٣٠م ⇒ تُقبل بموقعها', async () => {
  rows = []; seq = 0; featureOn = true; punchAtCustomer = true; nearCustomers = [NEAR];
  try {
    assert.equal(data(await call('post', '/attendance/checkin', { body: HERE })).status, 'in');
    assert.equal(rows[0].checkInLat, HERE.lat);
  } finally { punchAtCustomer = false; nearCustomers = []; }
});

/** المربّع تقريبٌ للبحث لا للحكم: زاويته أبعد من ٥٠م فتُرفض بالمسافة الدقيقة */
test('بصمة بموقع عميل: عميل في زاوية مربّع البحث (~٧٠م) ⇒ يُرفض بالمسافة الدقيقة', async () => {
  rows = []; seq = 0; featureOn = true; punchAtCustomer = true; nearCustomers = [CORNER];
  try {
    const r = await call('post', '/attendance/checkin', { body: HERE });
    assert.equal(r.statusCode, 409, 'الزاوية ~٦٩م — خارج الخمسين');
    assert.equal(rows.length, 0);
  } finally { punchAtCustomer = false; nearCustomers = []; }
});

test('بصمة بموقع عميل: الانصراف محروس كالحضور', async () => {
  rows = []; seq = 0; featureOn = true; nearCustomers = [NEAR];
  await call('post', '/attendance/checkin', { body: HERE });   // القيد مطفأ عند الحضور
  punchAtCustomer = true; nearCustomers = [];
  try {
    const r = await call('post', '/attendance/checkout', { body: HERE });
    assert.equal(r.statusCode, 409);
    assert.equal(codeOf(r), 'PUNCH_AWAY_FROM_CUSTOMER');
    assert.equal(rows[0].checkOutAt, null, 'النوبة باقية مفتوحة');
    nearCustomers = [NEAR];
    assert.equal(data(await call('post', '/attendance/checkout', { body: HERE })).status, 'out');
  } finally { punchAtCustomer = false; nearCustomers = []; }
});

const FAR_150 = { lat: 24.7136 + 150 / 111320, lng: 46.6753 };
const FAR_250 = { lat: 24.7136 + 250 / 111320, lng: 46.6753 };

test('مسافة البصمة تحدّدها الإدارة: ٢٠٠م تقبل عميلاً على ١٥٠م وترفض ٢٥٠م برسالةٍ تذكر ٢٠٠', async () => {
  rows = []; seq = 0; featureOn = true; punchAtCustomer = true; punchRadius = 200;
  try {
    nearCustomers = [FAR_250];
    const r = await call('post', '/attendance/checkin', { body: HERE });
    assert.equal(r.statusCode, 409);
    assert.match(String((r.body as { message?: string }).message), /200/);
    assert.equal(rows.length, 0);
    nearCustomers = [FAR_150];
    assert.equal(data(await call('post', '/attendance/checkin', { body: HERE })).status, 'in');
  } finally { punchAtCustomer = false; punchRadius = 50; nearCustomers = []; }
});

test('مسافة البصمة ٢٠٠م: عميلٌ على ١٥٠م كان يُرفض بالخمسين — والافتراض ٥٠ كما كان', async () => {
  rows = []; seq = 0; featureOn = true; punchAtCustomer = true; nearCustomers = [FAR_150];
  try {
    punchRadius = 50;
    assert.equal((await call('post', '/attendance/checkin', { body: HERE })).statusCode, 409, 'بالخمسين يُرفض');
  } finally { punchAtCustomer = false; nearCustomers = []; }
});

test('مسافةٌ فاسدة في القاعدة لا تُسقط القيد: تعود إلى ٥٠', async () => {
  for (const bad of [null, 0, -5, 3, 99999, 12.5, 'x']) {
    rows = []; seq = 0; featureOn = true; punchAtCustomer = true; punchRadius = bad; nearCustomers = [FAR_150];
    try {
      assert.equal((await call('post', '/attendance/checkin', { body: HERE })).statusCode, 409, `${String(bad)} ⇒ ٥٠`);
    } finally { punchAtCustomer = false; punchRadius = 50; nearCustomers = []; }
  }
});

test('بصمة بموقع عميل: الضغط المكرّر على نوبة مفتوحة لا يُرفض — لا كتابة فلا حكم', async () => {
  rows = []; seq = 0; featureOn = true; nearCustomers = [NEAR];
  await call('post', '/attendance/checkin', { body: HERE });
  punchAtCustomer = true; nearCustomers = [];
  try {
    const r = await call('post', '/attendance/checkin', {});
    assert.equal(data(r).status, 'in');
    assert.equal((data(r) as { already?: boolean }).already, true);
  } finally { punchAtCustomer = false; }
});

// ═══ الدوام المتقطّع: كل دخولٍ يُسجَّل وكل خروجٍ يُسجَّل ═══
type Punch = { checkInAt: Date; checkOutAt: Date | null };
const shiftsOf = (res: { body: Record<string, unknown> | null }) => data(res).shifts as Punch[];

test('بعد الانصراف يُفتح حضورٌ جديد في اليوم نفسه — نوبةٌ ثانية لا إعادةٌ للأولى', async () => {
  rows = []; seq = 0; featureOn = true;
  await call('post', '/attendance/checkin', {});
  await call('post', '/attendance/checkout', {});
  const again = await call('post', '/attendance/checkin', {});
  assert.equal(data(again).status, 'in');
  assert.equal((data(again) as { already?: boolean }).already, undefined, 'ليس «حاضراً سلفاً» — فترةٌ جديدة');
  assert.equal(rows.length, 2, 'نوبتان: الأولى مغلقة والثانية مفتوحة');
  assert.ok(rows[0].checkOutAt instanceof Date);
  assert.equal(rows[1].checkOutAt, null);
});

test('بصمات اليوم كلها تعود مع الحالة ومع كل بصمة: كل دخولٍ وكل خروج بترتيب وقوعها', async () => {
  rows = []; seq = 0; featureOn = true;
  const none = await call('get', '/attendance/today');
  assert.deepEqual(shiftsOf(none), []);

  const in1 = await call('post', '/attendance/checkin', {});
  assert.equal(shiftsOf(in1).length, 1);
  assert.equal(shiftsOf(in1)[0].checkOutAt, null);

  const out1 = await call('post', '/attendance/checkout', {});
  assert.equal(shiftsOf(out1).length, 1);
  assert.ok(shiftsOf(out1)[0].checkOutAt instanceof Date, 'الخروج سُجّل في القائمة');

  await call('post', '/attendance/checkin', {});
  await call('post', '/attendance/checkout', {});
  const today = await call('get', '/attendance/today');
  assert.equal(data(today).status, 'out');
  const list = shiftsOf(today);
  assert.equal(list.length, 2, 'فترتان في اليوم');
  assert.ok(list.every((s) => s.checkInAt instanceof Date && s.checkOutAt instanceof Date));
  assert.ok(list[0].checkInAt <= list[1].checkInAt, 'مرتّبة من الأقدم');
});

test('قائمة اليوم: نوبةُ أمسٍ المغلقة خارجها، والمفتوحة من أمس داخلها (نسي الانصراف)', async () => {
  rows = []; seq = 0; featureOn = true;
  const day = 24 * 60 * 60 * 1000;
  const y = (h: number) => new Date(Date.now() - day - h * 60 * 60 * 1000);
  rows.push({ id: 'old', tenantId: 't1', salesRepId: 'rep1', checkInAt: y(6), checkInLat: null, checkInLng: null, checkOutAt: y(2), checkOutLat: null, checkOutLng: null, createdAt: y(6) });
  assert.deepEqual(shiftsOf(await call('get', '/attendance/today')), [], 'نوبة أمس المغلقة ليست من اليوم');
  rows.push({ id: 'open', tenantId: 't1', salesRepId: 'rep1', checkInAt: y(1), checkInLat: null, checkInLng: null, checkOutAt: null, checkOutLat: null, checkOutLng: null, createdAt: y(1) });
  const res = await call('get', '/attendance/today');
  assert.equal(data(res).status, 'in');
  assert.equal(shiftsOf(res).length, 1);
  assert.equal(shiftsOf(res)[0].checkOutAt, null);
  // ومندوبٌ آخر لا تظهر بصماته
  rows.push({ id: 'other', tenantId: 't1', salesRepId: 'rep2', checkInAt: new Date(), checkInLat: null, checkInLng: null, checkOutAt: null, checkOutLat: null, checkOutLng: null, createdAt: new Date() });
  assert.equal(shiftsOf(await call('get', '/attendance/today')).length, 1);
});

test('مسافتا القيدين: عمودان بافتراض ٥٠، وتحقّق ١٠–٥٠٠٠ صحيحاً، وتصلان التطبيق والمزامنة', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
  const schema = fs.readFileSync(path.join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8');
  assert.match(schema, /proximityRadiusM Int @default\(50\)/);
  assert.match(schema, /punchRadiusM     Int @default\(50\)/);
  const reps = read('routes', 'salesReps.ts');
  assert.match(reps, /export const RADIUS_MIN_M = 10;/);
  assert.match(reps, /export const RADIUS_MAX_M = 5000;/);
  assert.match(reps, /proximityRadiusM: z\.number\(\)\.int\(\)\.min\(RADIUS_MIN_M\)\.max\(RADIUS_MAX_M\)\.optional\(\),/);
  assert.match(reps, /punchRadiusM: z\.number\(\)\.int\(\)\.min\(RADIUS_MIN_M\)\.max\(RADIUS_MAX_M\)\.optional\(\),/);
  assert.match(reps, /proximityRadiusM: true,\n  punchRadiusM: true,/, 'القائمة تحملهما فلا تعود نافذة التعديل إلى الافتراض');
  assert.match(read('routes', 'auth.ts'), /proximityRadiusM: true, punchRadiusM: true,/, '/auth/me يحمل المسافة فتتجدّد في التطبيق');
  assert.match(read('services', 'apiSync.ts'), /'proximityRadiusM', 'punchRadiusM',/);
});
