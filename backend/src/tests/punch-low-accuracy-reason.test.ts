// «موقعك غير دقيق» بدل «بعيد» في منطقة الدقّة الميتة (تدقيق البصمة SM-3، ٧ نوفمبر ٢٠٢٦ — قرار المالك «أصلح الخلل فقط»).
// معالجا البصمة (/attendance/checkin) وإثبات التواجد (/presence/:id/respond) الحقيقيّان فوق Prisma مزيّف بلا قاعدة،
// وhaversine حقيقية. يثبت:
//   • الحكم بالقبول والرفض لا يتغيّر حرفاً: شبكةٌ من النطاقات والمسافات والدقّات (وREJECT/FLAG) تُقارن بنسخةٍ مجمّدة من
//     المنطق قبل الإصلاح — الحالة، والرمز، وكتابة النوبة أو الإثبات ووسمه ومسافته، و nearestM/radius في ردّ الإثبات.
//   • ما كان «غير دقيق» يبقى كذلك بالجسم نفسه بايتاً ببايت، وما سوى الحالات الجديدة جسمه كما كان بايتاً ببايت.
//   • الجديد وحده: رفضٌ خارج النطاق، دقّةٌ أرخى من ٢٥ م، وعميلٌ داخل النطاق + الدقّة ⇒ LOW_ACCURACY بنصّه.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Router } from 'express';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ═══ عالمٌ في الذاكرة ═══
const HERE = { lat: 24.7136, lng: 46.6753 };
let customer: { lat: number; lng: number } | null = null;
const rep = { id: 'rep1', tenantId: 't1', requirePunchAtCustomer: true, punchRadiusM: 50 as unknown, punchOutsideAction: 'REJECT', requireBoundDevice: false, boundDeviceId: null as string | null, boundDeviceName: null as string | null };
let shifts: Record<string, unknown>[] = [];
type Check = { id: string; tenantId: string; salesRepId: string; status: string; sentAt: Date | null; tappedAt: Date | null; lat: number | null; [k: string]: unknown };
let check: Check;

const pickSel = (row: Record<string, unknown>, sel?: Record<string, boolean>) =>
  (sel ? Object.fromEntries(Object.keys(sel).filter((k) => sel[k]).map((k) => [k, row[k]])) : { ...row });
const db: Record<string, unknown> = {
  tenant: { async findUnique() { return { attendanceEnabled: true }; } },
  salesRep: {
    async findFirst(a: { select?: Record<string, boolean> }) { return pickSel(rep as unknown as Record<string, unknown>, a.select); },
    async findUnique(a: { select?: Record<string, boolean> }) { return pickSel(rep as unknown as Record<string, unknown>, a.select); },
    async updateMany() { return { count: 0 }; },
  },
  repAttendance: {
    async findFirst() { return null; },
    async findMany() { return []; },
    async create(a: { data: Record<string, unknown> }) { const r = { id: `s${shifts.length + 1}`, ...a.data }; shifts.push(r); return r; },
  },
  presenceCheck: {
    async findFirst() { return { ...check }; },
    async updateMany(a: { where: { status?: string }; data: Record<string, unknown> }) {
      if (a.where.status && check.status !== a.where.status) return { count: 0 };
      Object.assign(check, a.data);
      return { count: 1 };
    },
  },
  // أقرب العملاء كما تحسبهم القاعدة: العميل الوحيد إن وُجد (المسافات في الشبكة دون مربّع البحث الأدنى ٢٠٠٠ م)
  async $queryRaw() { return customer ? [{ ...customer }] : []; },
  async $executeRaw() { return 0; },
};
db.$transaction = async (fn: (tx: unknown) => unknown) => fn(db);
stub('config/database', { default: db });
stub('middleware/auth', {
  authenticate: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireAdmin: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireAdminPermission: () => (_q: unknown, _s: unknown, next: () => void) => next(),
  tenantId: (req: { user?: { tenantId?: string } }) => req.user!.tenantId!,
  actorOf: () => 'x', isOwnerSession: () => false,
});
stub('services/adminScope', { adminRepFilter: async () => ({}), scopedRepRecordWhere: async () => ({}), scopedRecordWhere: async () => ({}), canAccessRep: async () => true, SHAPE_VISIT: {} });
stub('services/mapMatch', { snapToRoads: async () => [], routeThrough: async () => [] });
// haversineM الحقيقية — والمتوقَّع يُحسب بها نفسها فتتطابق المسافة بايتاً ببايت
const R_EARTH = 6371000; const toRad = (d: number) => (d * Math.PI) / 180;
const haversineM = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const s = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lng - a.lng) / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
};
stub('services/routeShape', { buildRouteShape: () => ({}), haversineM });
stub('services/repHeartbeat', { heartbeatClientState: () => ({}) });
stub('services/customerScope', { isolationEnabled: async () => false });
stub('services/webPush', { sendPushToRep: async () => 0, getVapidKeys: async () => ({ publicKey: 'k' }), pushEndpointAllowed: () => true, pushKeysValid: () => true });

/* eslint-disable @typescript-eslint/no-var-requires */
const tracking = require('../routes/tracking') as typeof import('../routes/tracking');
const router = tracking.default as Router;
/* eslint-enable @typescript-eslint/no-var-requires */

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => unknown }[] } }
function handler(method: 'post', p: string) {
  for (const l of (router as unknown as { stack: Layer[] }).stack) {
    const r = l.route;
    if (r && r.path === p && r.methods[method]) return r.stack[r.stack.length - 1].handle;
  }
  throw new Error(`نقطة غير مسجّلة: ${method} ${p}`);
}
const UA = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
async function call(p: string, body: unknown, params: Record<string, string> = {}) {
  const res = { statusCode: 200, body: null as Record<string, unknown> | null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b as Record<string, unknown>; return this; } };
  let err: unknown = null;
  await handler('post', p)({ user: { role: 'SALES_REP', id: 'rep1', tenantId: 't1' }, body, params, query: {}, headers: {}, get: (h: string) => (h.toLowerCase() === 'user-agent' ? UA : undefined) }, res, (e?: unknown) => { if (e) err = e; });
  if (err) throw err;
  return res;
}

// ═══ المنطق قبل الإصلاح — نسخةٌ مجمّدة حرفياً من tracking.ts عند b194d6f (المرجع الذي يُقارن به) ═══
const OLD_ALLOWANCE = 25;
const oldRadiusOf = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 10 && v <= 5000 ? v : 50);
const oldAllowance = (a: unknown) => (typeof a === 'number' && Number.isFinite(a) && a > 0 ? Math.min(a, OLD_ALLOWANCE) : 0);
const oldTooCoarse = (a: unknown, r: number) => typeof a === 'number' && Number.isFinite(a) && a > Math.max(r, 50);
function oldPlace(radiusRaw: unknown, nearest: number | null, accuracy?: number) {
  const radius = oldRadiusOf(radiusRaw);
  const acc = typeof accuracy === 'number' && Number.isFinite(accuracy) ? accuracy : null;
  const reach = radius + oldAllowance(accuracy);
  const inside = nearest != null && nearest <= reach;
  const lowAccuracy = !inside && nearest != null && oldTooCoarse(accuracy, radius) && nearest - acc! <= radius;
  return { inside, nearestM: nearest, radius, accuracy: acc, lowAccuracy };
}
type OldPlace = ReturnType<typeof oldPlace>;
const where = (p: OldPlace) => (p.nearestM != null ? ` — أقرب عملائك على بعد ${Math.round(p.nearestM)} مترا منك` : ' — لا عميل لك قريب من موقعك الحالي');
const lowText = (p: OldPlace) => `موقعك غير دقيق الآن (±${Math.round(p.accuracy!)} م) — انتظر لحظات أو اقترب من مكان مفتوح ثم أعد المحاولة`;
const punchBody = (p: OldPlace, low: boolean) => (low
  ? { success: false, code: 'PUNCH_AWAY_FROM_CUSTOMER', reason: 'LOW_ACCURACY', message: lowText(p) }
  : { success: false, code: 'PUNCH_AWAY_FROM_CUSTOMER', message: `البصمة مشروطة بأن تكون داخل ${p.radius} مترا من موقع أحد عملائك${where(p)}` });
const presenceBody = (p: OldPlace, low: boolean) => {
  const base = { success: false, code: 'PRESENCE_AWAY_FROM_CUSTOMER', nearestM: p.nearestM != null ? Math.round(p.nearestM) : null, radius: p.radius };
  return low
    ? { ...base, reason: 'LOW_ACCURACY', message: lowText(p) }
    : { ...base, reason: 'OUTSIDE', message: `إثبات تواجدك مشروط بأن تكون داخل ${p.radius} مترا من موقع أحد عملائك${where(p)}` };
};
/** الشرط الجديد (SM-3): رفضٌ، ودقّةٌ أرخى من السماحية، وعميلٌ في حدود النطاق + الدقّة */
const newLow = (p: OldPlace) => !p.inside && p.nearestM != null && p.accuracy != null && p.accuracy > OLD_ALLOWANCE && p.nearestM - p.accuracy <= p.radius;

// ═══ الشبكة ═══
const RADII: unknown[] = [10, 30, 50, 80, 120, 300, 1000, 5000, null];
const DISTS: (number | null)[] = [null, 0, 5, 20, 34, 49, 51, 60, 74, 76, 80, 95, 100, 150, 300, 330, 600, 1500, 1900];
const ACCS: (number | undefined)[] = [undefined, 0, 5, 20, 25, 25.4, 26, 30, 40, 45, 50, 51, 80, 120, 350, 1000, 2500];
const north = (m: number) => ({ lat: HERE.lat + m / 111320, lng: HERE.lng });

test('الشبكة — البصمة: القبول والرفض والكتابة كما قبل الإصلاح حرفاً، والجسم كما كان إلا الحالات الجديدة LOW_ACCURACY', async () => {
  let changed = 0; let lowKept = 0; let n = 0;
  for (const action of ['REJECT', 'FLAG']) for (const radiusRaw of RADII) for (const d of DISTS) for (const accuracy of ACCS) {
    rep.punchRadiusM = radiusRaw; rep.punchOutsideAction = action; shifts = [];
    customer = d == null ? null : north(d);
    const nearest = customer ? haversineM(HERE, customer) : null;
    const old = oldPlace(radiusRaw, nearest, accuracy);
    const tag = `${action} r=${String(radiusRaw)} d=${String(d)} acc=${String(accuracy)}`;
    const r = await call('/attendance/checkin', { ...HERE, ...(accuracy !== undefined && { accuracy }) });
    n++;
    const accepted = old.inside || action === 'FLAG';
    assert.equal(r.statusCode, accepted ? 200 : 409, `${tag}: الحالة`);
    assert.equal(shifts.length, accepted ? 1 : 0, `${tag}: النوبة`);
    if (accepted) {
      assert.equal(shifts[0].checkInOutside, !old.inside, `${tag}: وسم الخروج`);
      assert.equal(shifts[0].checkInDistanceM, nearest != null ? Math.round(nearest) : null, `${tag}: المسافة`);
      continue;
    }
    const before = JSON.stringify(punchBody(old, old.lowAccuracy));
    const after = JSON.stringify(r.body);
    if (old.lowAccuracy) { lowKept++; assert.equal(after, before, `${tag}: «غير دقيق» القديم بنصّه`); continue; }
    if (newLow(old)) {
      changed++;
      assert.equal(after, JSON.stringify(punchBody(old, true)), `${tag}: الجديد LOW_ACCURACY`);
    } else {
      assert.equal(after, before, `${tag}: الجسم بايتاً ببايت`);
    }
  }
  assert.ok(n > 3000, `الشبكة ${n}`);
  assert.ok(changed > 0 && lowKept > 0, `حالاتٌ جديدة ${changed} وقديمة ${lowKept}`);
});

test('الشبكة — إثبات التواجد: القبول والرفض و nearestM/radius كما قبل الإصلاح، والسبب وحده يتحوّل OUTSIDE → LOW_ACCURACY', async () => {
  let changed = 0;
  rep.punchOutsideAction = 'REJECT';
  for (const radiusRaw of RADII) for (const d of DISTS) for (const accuracy of ACCS) {
    rep.punchRadiusM = radiusRaw;
    customer = d == null ? null : north(d);
    const nearest = customer ? haversineM(HERE, customer) : null;
    const old = oldPlace(radiusRaw, nearest, accuracy);
    const tag = `r=${String(radiusRaw)} d=${String(d)} acc=${String(accuracy)}`;
    check = { id: 'p1', tenantId: 't1', salesRepId: 'rep1', status: 'SENT', sentAt: new Date(Date.now() - 5_000), tappedAt: null, lat: null };
    const r = await call('/presence/:id/respond', { ...HERE, ...(accuracy !== undefined && { accuracy }) }, { id: 'p1' });
    if (old.inside) {
      assert.equal(r.statusCode, 200, `${tag}: يُقبل`);
      assert.equal(check.status, 'PASSED', tag);
      assert.equal(check.distanceM, nearest != null ? Math.round(nearest) : null, `${tag}: المسافة`);
      continue;
    }
    assert.equal(r.statusCode, 409, `${tag}: يُرفض`);
    assert.equal(check.status, 'SENT', `${tag}: الطلب باقٍ مُرسَلاً`);
    const before = presenceBody(old, old.lowAccuracy);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.code, before.code, tag);
    assert.equal(body.nearestM, before.nearestM, tag);
    assert.equal(body.radius, before.radius, tag);
    if (!old.lowAccuracy && newLow(old)) {
      changed++;
      assert.equal(JSON.stringify(body), JSON.stringify(presenceBody(old, true)), `${tag}: الجديد LOW_ACCURACY`);
    } else {
      assert.equal(JSON.stringify(body), JSON.stringify(before), `${tag}: الجسم بايتاً ببايت`);
    }
  }
  assert.ok(changed > 0, `حالاتٌ جديدة ${changed}`);
});

test('سيناريو التدقيق: نطاق ٥٠، دقّة ٤٥، أقرب عميل ٨٠ م — يُرفض كما كان لكن «موقعك غير دقيق (±45 م)» لا «على بعد 80 مترا»', async () => {
  rep.punchRadiusM = 50; rep.punchOutsideAction = 'REJECT'; shifts = [];
  customer = north(80);
  const r = await call('/attendance/checkin', { ...HERE, accuracy: 45 });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body!.code, 'PUNCH_AWAY_FROM_CUSTOMER', 'الرمز الذي تعرفه الحزمة الأقدم');
  assert.equal(r.body!.reason, 'LOW_ACCURACY');
  assert.match(String(r.body!.message), /موقعك غير دقيق الآن \(±45 م\)/);
  assert.doesNotMatch(String(r.body!.message), /على بعد/);
  assert.equal(shifts.length, 0);
  // الدقّة نفسها داخل السماحية (٢٥) ⇒ بُعدٌ صريح كما كان
  const near = await call('/attendance/checkin', { ...HERE, accuracy: 25 });
  assert.equal(near.statusCode, 409);
  assert.equal(near.body!.reason, undefined);
  assert.match(String(near.body!.message), /أقرب عملائك على بعد 80 مترا منك/);
  // والبعيد خارج النطاق + الدقّة (٤٥ + ٥٠ < ١٥٠) يُقال له بُعده
  customer = north(150);
  const far = await call('/attendance/checkin', { ...HERE, accuracy: 45 });
  assert.equal(far.body!.reason, undefined);
  assert.match(String(far.body!.message), /على بعد 150 مترا/);
});

test('punchLowAccuracy: شرطٌ يشمل القديم كلّه ولا يمسّ المقبول ولا الدقّة الغائبة', () => {
  const { punchLowAccuracy, PUNCH_ACCURACY_ALLOWANCE_M } = tracking;
  assert.equal(PUNCH_ACCURACY_ALLOWANCE_M, 25, 'السماحية كما هي');
  assert.equal(punchLowAccuracy(true, 80, 45, 50), false, 'المقبول لا سبب لرفضه');
  assert.equal(punchLowAccuracy(false, null, 45, 50), false, 'لا عميل قريب');
  assert.equal(punchLowAccuracy(false, 80, undefined, 50), false, 'بلا دقّة');
  assert.equal(punchLowAccuracy(false, 80, Number.NaN, 50), false);
  assert.equal(punchLowAccuracy(false, 80, 25, 50), false, 'عند السماحية نفسها: بُعد');
  assert.equal(punchLowAccuracy(false, 80, 30, 50), true, '٨٠ − ٣٠ = ٥٠ ≤ ٥٠');
  assert.equal(punchLowAccuracy(false, 81, 30, 50), false, '٨١ − ٣٠ > ٥٠');
  for (const radius of [10, 50, 300, 5000]) for (const nearest of [0, 60, 400, 4000]) for (const acc of [26, 51, 301, 5001]) {
    const oldLow = acc > Math.max(radius, 50) && nearest - acc <= radius;
    if (oldLow) assert.equal(punchLowAccuracy(false, nearest, acc, radius), true, `r=${radius} d=${nearest} acc=${acc}: القديم محفوظ`);
  }
});
