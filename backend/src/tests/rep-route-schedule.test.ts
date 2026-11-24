// «طريقة توزيع الخطوط» (طلب المالك ٢٢ نوفمبر ٢٠٢٦): مندوبٌ له عدّة خطوطٍ دائمة وكل يومٍ يُوجَّه إلى واحدٍ منها —
// حسب أيام الأسبوع أو تناوباً بالترتيب. أوّلاً الدالّة النقيّة pickRouteForDay (services/routeSchedule.ts)، ثم
// المعالجات الحقيقية في routes/repRoutes.ts فوق Prisma مزيّف في الذاكرة (أسلوب rep-routes-real-delete.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import {
  pickRouteForDay, workDaysBetween, weekdayOf, orderRoutes, weekdayConflict, firstInternalConflict, isValidDay, dayMs,
  type PickableRoute,
} from '../services/routeSchedule';

// ═══════════════════════ الدالّة النقيّة ═══════════════════════

const at = (iso: string) => new Date(iso);
const perm = (id: string, o: Partial<PickableRoute> = {}): PickableRoute =>
  ({ id, isPermanent: true, routeDate: null, isActive: true, createdAt: at('2026-11-01T08:00:00Z'), weekdays: [], rotationOrder: 0, ...o });
const dated = (id: string, routeDate: string, o: Partial<PickableRoute> = {}): PickableRoute =>
  ({ id, isPermanent: false, routeDate, isActive: true, createdAt: at('2026-11-01T08:00:00Z'), weekdays: [], rotationOrder: 0, ...o });
const id = (r: PickableRoute | null) => r?.id ?? null;
/** 'YYYY-MM-DD' بعد n يوماً — بالحساب على UTC */
const plus = (day: string, n: number) => new Date(dayMs(day)! + n * 86400000).toISOString().slice(0, 10);

test('يوم الأسبوع من نصّ التاريخ نفسه (UTC) — بلا انزلاق منطقة زمنية، والتاريخ المستحيل مرفوض', () => {
  // ٢٢ نوفمبر ٢٠٢٦ أحد
  assert.deepEqual(['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28'].map(weekdayOf), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(weekdayOf('2024-02-29'), 4, 'سنةٌ كبيسة');
  assert.equal(weekdayOf('2026-02-30'), -1);
  assert.equal(isValidDay('2026-02-30'), false);
  assert.equal(isValidDay('2026-13-01'), false);
  assert.equal(isValidDay('2026-11-22'), true);
  // منطقة الخادم لا تغيّر الجواب: الحساب بـDate.UTC وgetUTCDay وحدهما
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'routeSchedule.ts'), 'utf8');
  assert.doesNotMatch(src, /\.getDay\(\)|new Date\(\s*day\s*\)|new Date\(`\$\{day\}`\)/, 'يوم الأسبوع بتوقيت الخادم المحلّي');
});

test('حسب أيام الأسبوع: الخطّ الذي أيّامه تشمل يوم الأسبوع، ويومٌ بلا خطّ ⇒ لا خطّ', () => {
  const routes = [perm('A', { weekdays: [0, 1] }), perm('B', { weekdays: [2, 3], rotationOrder: 1 }), perm('C', { weekdays: [] , rotationOrder: 2 })];
  const s = { mode: 'weekdays', rotationStart: null, offDays: [5] };
  assert.equal(id(pickRouteForDay('2026-11-22', s, routes)), 'A'); // أحد
  assert.equal(id(pickRouteForDay('2026-11-23', s, routes)), 'A'); // اثنين
  assert.equal(id(pickRouteForDay('2026-11-24', s, routes)), 'B'); // ثلاثاء
  assert.equal(id(pickRouteForDay('2026-11-25', s, routes)), 'B'); // أربعاء
  assert.equal(pickRouteForDay('2026-11-26', s, routes), null, 'الخميس بلا خطّ');
  assert.equal(pickRouteForDay('2026-11-27', s, routes), null, 'الجمعة بلا خطّ');
  // خطٌّ بلا أيام لا يُختار في هذا النمط أبداً
  for (let i = 0; i < 7; i++) assert.notEqual(id(pickRouteForDay(plus('2026-11-22', i), s, routes)), 'C');
});

test('تناوب بالترتيب: يومٌ لكل خطّ بترتيب rotationOrder، والجمعة (راحة) بلا خطّ ولا تأخذ دوراً، ثم تعود الدورة', () => {
  // المدخل مخلوط عمداً: الترتيب من rotationOrder لا من موضع المصفوفة ولا من تاريخ الإنشاء
  const routes = [perm('C', { rotationOrder: 2, createdAt: at('2026-10-01T00:00:00Z') }), perm('A', { rotationOrder: 0 }), perm('B', { rotationOrder: 1 })];
  const s = { mode: 'rotation', rotationStart: '2026-11-22', offDays: [5] };
  const week = Array.from({ length: 8 }, (_, i) => id(pickRouteForDay(plus('2026-11-22', i), s, routes)));
  //            أحد  اثنين ثلاثاء أربعاء خميس  جمعة  سبت  أحد
  assert.deepEqual(week, ['A', 'B', 'C', 'A', 'B', null, 'C', 'A']);
  assert.equal(pickRouteForDay('2026-11-21', s, routes), null, 'قبل بداية التناوب لا خطّ');
  // يوما راحة
  const s2 = { ...s, offDays: [5, 6] };
  const week2 = Array.from({ length: 8 }, (_, i) => id(pickRouteForDay(plus('2026-11-22', i), s2, routes)));
  assert.deepEqual(week2, ['A', 'B', 'C', 'A', 'B', null, null, 'C']);
  // بلا أيام راحة: كل يومٍ يأخذ دوراً
  const s3 = { ...s, offDays: [] };
  assert.deepEqual(Array.from({ length: 7 }, (_, i) => id(pickRouteForDay(plus('2026-11-22', i), s3, routes))), ['A', 'B', 'C', 'A', 'B', 'C', 'A']);
  // التساوي في rotationOrder ⇒ الأقدم إنشاءً أوّلاً
  const tie = [perm('Y', { createdAt: at('2026-11-02T00:00:00Z') }), perm('X', { createdAt: at('2026-11-01T00:00:00Z') })];
  assert.deepEqual(orderRoutes(tie).map(r => r.id), ['X', 'Y']);
  assert.equal(id(pickRouteForDay('2026-11-22', { ...s, offDays: [] }, tie)), 'X');
  assert.equal(id(pickRouteForDay('2026-11-23', { ...s, offDays: [] }, tie)), 'Y');
});

test('تناوب: الحساب بالأسابيع الكاملة يطابق العدّ يوماً بيوم على سنتين ولكل أيام راحة', () => {
  const brute = (start: string, day: string, off: number[]) => {
    let n = 0;
    for (let d = start; d < day; d = plus(d, 1)) if (!off.includes(weekdayOf(d))) n++;
    return n;
  };
  for (const off of [[], [5], [5, 6], [0, 3, 5], [0, 1, 2, 3, 4, 5]]) {
    for (let i = 0; i < 730; i += 13) {
      const day = plus('2026-11-19', i);
      assert.equal(workDaysBetween('2026-11-19', day, off), brute('2026-11-19', day, off), `${off} ${day}`);
    }
  }
  assert.equal(workDaysBetween('2026-11-22', '2026-11-22', [5]), 0);
  assert.equal(workDaysBetween('2026-11-22', '2026-11-20', [5]), 0, 'يومٌ قبل البداية');
  // بعد سنة: الدورة مستمرّة بلا حلقة على الأيام
  const routes = [perm('A'), perm('B', { rotationOrder: 1 }), perm('C', { rotationOrder: 2 })];
  const day = '2027-11-23';
  const want = ['A', 'B', 'C'][brute('2026-11-22', day, [5]) % 3];
  assert.equal(id(pickRouteForDay(day, { mode: 'rotation', rotationStart: '2026-11-22', offDays: [5] }, routes)), want);
});

test('المؤقّت ليومه يفوز دائماً — في كل نمط، ولو في يوم الراحة أو قبل بداية التناوب — ولا يُزيح الدورة', () => {
  const routes = [perm('A', { weekdays: [0] }), perm('B', { rotationOrder: 1, weekdays: [1] }), dated('D', '2026-11-27'), dated('E', '2026-11-23')];
  const rot = { mode: 'rotation', rotationStart: '2026-11-22', offDays: [5] };
  assert.equal(id(pickRouteForDay('2026-11-27', rot, routes)), 'D', 'يوم راحة');
  assert.equal(id(pickRouteForDay('2026-11-27', { mode: 'weekdays', rotationStart: null, offDays: [5] }, routes)), 'D');
  assert.equal(id(pickRouteForDay('2026-11-27', null, routes)), 'D', 'بلا جدول');
  assert.equal(id(pickRouteForDay('2026-11-27', { ...rot, rotationStart: '2026-12-01' }, routes)), 'D', 'قبل البداية');
  // الاثنين مؤقّتٌ (E)، والثلاثاء يعود إلى الدورة في موضعها: أحد A، اثنين (B يأخذه E)، ثلاثاء A
  assert.equal(id(pickRouteForDay('2026-11-23', rot, routes)), 'E');
  assert.equal(id(pickRouteForDay('2026-11-24', rot, routes)), 'A');
  // المؤقّت ليومٍ آخر أو الموقوف لا يُقرأ
  assert.equal(id(pickRouteForDay('2026-11-24', null, [perm('A'), dated('X', '2026-11-25')])), 'A');
  assert.equal(id(pickRouteForDay('2026-11-25', null, [perm('A'), dated('X', '2026-11-25', { isActive: false })])), 'A');
});

test('الدائم لا يسري على يومٍ سبق إنشاءه (نهاية اليوم هي الحدّ)، والموقوف لا يُقرأ', () => {
  const late = perm('L', { createdAt: at('2026-11-24T21:00:00Z') });
  assert.equal(pickRouteForDay('2026-11-23', null, [late]), null);
  assert.equal(id(pickRouteForDay('2026-11-24', null, [late])), 'L', 'أُنشئ في يومه ⇒ يسري عليه');
  // التناوب ليومٍ ماضٍ يدور على ما كان موجوداً فيه — لا يُتّهم المندوب بخطّةٍ لم تكن
  const routes = [perm('A'), perm('B', { rotationOrder: 1, createdAt: at('2026-11-24T09:00:00Z') })];
  const s = { mode: 'rotation', rotationStart: '2026-11-22', offDays: [] };
  assert.equal(id(pickRouteForDay('2026-11-23', s, routes)), 'A', 'B لم يكن موجوداً');
  assert.equal(id(pickRouteForDay('2026-11-24', s, routes)), 'A', 'اليوم الثالث: 2 % 2 = 0');
  assert.equal(id(pickRouteForDay('2026-11-25', s, routes)), 'B');
  // حسب الأيام: خطّ اليوم أُنشئ بعده ⇒ لا خطّ
  assert.equal(pickRouteForDay('2026-11-23', { mode: 'weekdays', rotationStart: null, offDays: [] }, [perm('W', { weekdays: [1], createdAt: at('2026-11-30T00:00:00Z') })]), null);
  // الموقوف
  assert.equal(id(pickRouteForDay('2026-11-24', s, [perm('A', { isActive: false }), perm('B', { rotationOrder: 1 })])), 'B');
});

test('بلا جدول ⇒ السلوك القديم: أوّل دائمٍ بالترتيب كل يوم — والنمط المجهول كذلك، وتناوبٌ بلا بداية ⇒ لا خطّ', () => {
  const routes = [perm('B', { rotationOrder: 1 }), perm('A')];
  for (let i = 0; i < 7; i++) assert.equal(id(pickRouteForDay(plus('2026-11-22', i), null, routes)), 'A');
  assert.equal(id(pickRouteForDay('2026-11-27', null, routes)), 'A', 'الجمعة ليست راحةً في السلوك القديم');
  assert.equal(id(pickRouteForDay('2026-11-22', { mode: 'monthly', rotationStart: null }, routes)), 'A');
  assert.equal(pickRouteForDay('2026-11-22', { mode: 'rotation', rotationStart: null, offDays: [] }, routes), null);
  assert.equal(pickRouteForDay('2026-11-22', null, []), null);
  assert.equal(pickRouteForDay('not-a-day', null, routes), null);
});

test('تعارض الأيام: أوّل يومٍ يستعمله خطٌّ آخر، والتعارض الداخلي بين خطوط المندوب', () => {
  const others = [{ id: 'A', name: 'خط الشمال', weekdays: [0, 1] }, { id: 'B', name: 'خط الجنوب', weekdays: [4] }];
  assert.deepEqual(weekdayConflict(others, [3, 4, 1]), { day: 1, routeId: 'A', name: 'خط الشمال' });
  assert.equal(weekdayConflict(others, [2, 3]), null);
  assert.equal(weekdayConflict(others, []), null);
  assert.equal(firstInternalConflict(others), null);
  assert.deepEqual(firstInternalConflict([...others, { id: 'C', name: 'خط الوسط', weekdays: [6, 4] }]), { day: 4, a: 'خط الجنوب', b: 'خط الوسط' });
});

// ═══════════════════════ المعالجات الحقيقية فوق Prisma مزيّف ═══════════════════════

type Row = Record<string, any>;
const SRC = path.join(__dirname, '..');
const T = 'T1';
const REP1 = '11111111-1111-4111-8111-111111111111';
const REP2 = '22222222-2222-4222-8222-222222222222';
const REPX = '99999999-9999-4999-8999-999999999999'; // مندوب شركةٍ أخرى
const C1 = 'c1111111-1111-4111-8111-111111111111';
const C2 = 'c2222222-2222-4222-8222-222222222222';
const RA = 'a1111111-1111-4111-8111-111111111111'; // دائم REP1 أوّل الدورة، الأحد والاثنين
const RB = 'a2222222-2222-4222-8222-222222222222'; // دائم REP1 ثانيها، الثلاثاء والأربعاء
const RD = 'a3333333-3333-4333-8333-333333333333'; // مؤقّت REP1 ليوم 2026-11-25
const R2 = 'a5555555-5555-4555-8555-555555555555'; // دائم REP2
const RX = 'a7777777-7777-4777-8777-777777777777'; // خطّ شركةٍ أخرى

const stub = (r: string, exports: Record<string, unknown>): void => {
  const p = require.resolve(path.join(SRC, r));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

let st: { routes: Row[]; stops: Row[]; reps: Row[]; customers: Row[]; schedules: Row[]; admins: Row[]; visits: Row[] };
let scope: Set<string> | null = null; // null = مستخدمٌ بلا نطاق
let n = 0;
function reset(): void {
  n = 0;
  scope = null;
  const route = (rid: string, tenantId: string, salesRepId: string, o: Row = {}) => ({
    id: rid, tenantId, salesRepId, name: `خط ${rid.slice(0, 2)}`, isPermanent: true, routeDate: null, isActive: true,
    weekdays: [], rotationOrder: 0, createdAt: new Date('2026-11-01T00:00:00Z'), ...o,
  });
  st = {
    reps: [{ id: REP1, tenantId: T, name: 'مندوب ١' }, { id: REP2, tenantId: T, name: 'مندوب ٢' }, { id: REPX, tenantId: 'OTHER', name: 'غريب' }],
    customers: [{ id: C1, tenantId: T }, { id: C2, tenantId: T }],
    routes: [
      route(RA, T, REP1, { weekdays: [0, 1], rotationOrder: 0 }),
      route(RB, T, REP1, { weekdays: [2, 3], rotationOrder: 1, createdAt: new Date('2026-11-02T00:00:00Z') }),
      route(RD, T, REP1, { isPermanent: false, routeDate: '2026-11-25' }),
      route(R2, T, REP2),
      route(RX, 'OTHER', REPX),
    ],
    stops: [],
    schedules: [],
    admins: [{ id: 'ADM', tenantId: T, isActive: true, canManageTracking: true }, { id: 'NOTRACK', tenantId: T, isActive: true, canManageTracking: false }],
    visits: [],
  };
  for (const r of st.routes) {
    st.stops.push({ id: `s-${r.id}-1`, tenantId: r.tenantId, routeId: r.id, customerId: C1, seq: 1, note: null });
    st.stops.push({ id: `s-${r.id}-2`, tenantId: r.tenantId, routeId: r.id, customerId: C2, seq: 2, note: null });
  }
}
reset();

const match = (row: Row, w: Row = {}): boolean => Object.entries(w).every(([k, v]) => {
  if (k === 'OR') return (v as Row[]).some((x) => match(row, x));
  if (v instanceof Date) return row[k] instanceof Date && row[k].getTime() === v.getTime();
  if (v && typeof v === 'object' && 'in' in v) return (v.in as unknown[]).includes(row[k]);
  if (v && typeof v === 'object' && 'gte' in v) return true; // حدود اليوم في الزيارات — خارج هذا الاختبار
  if (v && typeof v === 'object' && 'lt' in v) return row[k] < v.lt; // createdAt < نهاية اليوم
  return row[k] === v;
});
const withStops = (r: Row, a: Row) => (a?.include?.stops
  ? { ...r, stops: st.stops.filter((s) => s.routeId === r.id).sort((x, y) => x.seq - y.seq).map((s) => ({ ...s, customer: { id: s.customerId, name: s.customerId, businessName: null, phone: null, address: null, lat: null, lng: null } })) }
  : { ...r });

const db: Row = {
  salesRep: {
    async findFirst(a: Row) { return st.reps.find((r) => match(r, a.where)) ?? null; },
    async findMany(a: Row) { return st.reps.filter((r) => match(r, a.where)); },
  },
  customer: { async findMany(a: Row) { return st.customers.filter((c) => match(c, a.where)).map((c) => ({ id: c.id })); } },
  admin: {
    async findUnique(a: Row) { return st.admins.find((x) => x.id === a.where.id) ?? null; },
    async findFirst(a: Row) { return st.admins.find((x) => match(x, a.where)) ?? null; },
  },
  repVisit: { async findMany(a: Row) { return st.visits.filter((v) => match(v, a.where)); } },
  repRoute: {
    async findFirst(a: Row) { const r = st.routes.find((x) => match(x, a.where)); return r ? withStops(r, a) : null; },
    async findMany(a: Row) {
      return st.routes.filter((x) => match(x, a.where)).map((x) => ({
        ...withStops(x, a),
        ...(a.include?.salesRep ? { salesRep: st.reps.find((p) => p.id === x.salesRepId) } : {}),
      }));
    },
    async create(a: Row) {
      const row = { id: `NEW-${++n}`, isActive: true, createdAt: new Date(), weekdays: [], rotationOrder: 0, ...a.data };
      st.routes.push(row);
      return { ...row };
    },
    async deleteMany(a: Row) {
      const before = st.routes.length;
      st.routes = st.routes.filter((x) => !match(x, a.where));
      return { count: before - st.routes.length };
    },
    // الكتابة الوحيدة المسموحة على رأس الخطّ: موضعه في الدورة
    async updateMany(a: Row) {
      assert.deepEqual(Object.keys(a.data), ['rotationOrder'], 'كتابةٌ على رأس الخطّ غير موضعه في الدورة');
      let count = 0;
      for (const r of st.routes) if (match(r, a.where)) { Object.assign(r, a.data); count++; }
      return { count };
    },
    async update() { throw new Error('repRoute.update ممنوع'); },
  },
  repRouteStop: {
    async create(a: Row) { const row = { id: `NS-${++n}`, ...a.data }; st.stops.push(row); return row; },
    async deleteMany(a: Row) {
      const before = st.stops.length;
      st.stops = st.stops.filter((x) => !match(x, a.where));
      return { count: before - st.stops.length };
    },
  },
  repRouteSchedule: {
    async findFirst(a: Row) { const x = st.schedules.find((s) => match(s, a.where)); return x ? { ...x } : null; },
    async findMany(a: Row) { return st.schedules.filter((s) => match(s, a.where)).map((s) => ({ ...s })); },
    async upsert(a: Row) {
      const cur = st.schedules.find((s) => s.salesRepId === a.where.salesRepId);
      if (cur) { Object.assign(cur, a.update, { updatedAt: new Date() }); return { ...cur }; }
      const row = { id: `SCH-${++n}`, ...a.create, updatedAt: new Date() };
      st.schedules.push(row);
      return { ...row };
    },
    async deleteMany(a: Row) {
      const before = st.schedules.length;
      st.schedules = st.schedules.filter((s) => !match(s, a.where));
      return { count: before - st.schedules.length };
    },
  },
};
db.$transaction = async (fn: (tx: Row) => Promise<unknown>) => {
  const snap = { routes: st.routes.map((r) => ({ ...r })), stops: st.stops.map((s) => ({ ...s })) };
  try { return await fn(db); } catch (e) { st.routes = snap.routes; st.stops = snap.stops; throw e; }
};
stub('config/database', { default: db });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const realScope = require('../services/adminScope') as typeof import('../services/adminScope');
stub('services/adminScope', {
  ...realScope,
  canAccessRep: async (_req: unknown, _tid: string, rid: string) => scope === null || scope.has(rid),
  canAccessCustomerAsAdmin: async () => true,
  adminRepFilter: async () => (scope === null ? {} : { id: { in: [...scope] } }),
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realCustomerScope = require('../services/customerScope') as typeof import('../services/customerScope');
stub('services/customerScope', { ...realCustomerScope, canAccessCustomer: async () => true });
// المصادقة نفسها (JWT) خارج الاختبار — وحارسا الأدمن وصلاحية التتبّع حقيقيّان
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realAuth = require('../middleware/auth') as typeof import('../middleware/auth');
stub('middleware/auth', { ...realAuth, authenticate: (_req: unknown, _res: unknown, next: () => void) => next() });
// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = (require('../routes/repRoutes') as typeof import('../routes/repRoutes')).default;

/**
 * يشغّل مكدّس الراوتر كاملاً كما يشغّله Express: الوسائط العامّة (حارس الأدمن وصلاحية التتبّع) ثم المسار المطابق.
 * خطأٌ يُمرَّر إلى next يُرمى — فـZodError يصل الاختبار كما يصل errorHandler.
 */
async function call(method: string, url: string, req: Row = {}): Promise<{ status: number; body: Row }> {
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  const full: Row = { method: method.toUpperCase(), url, path: url, query: {}, params: {}, body: {}, headers: {}, user: { id: 'ADM', role: 'ADMIN', tenantId: T }, ...req };
  for (const layer of (router as unknown as { stack: Row[] }).stack) {
    if (!layer.match(url)) continue;
    if (layer.route) {
      if (!layer.route.methods[method]) continue;
      full.params = { ...layer.params };
      for (const h of layer.route.stack as Row[]) {
        let passed = false; let err: unknown;
        await h.handle(full, res, (e?: unknown) => { if (e) err = e; else passed = true; });
        if (err) throw err;
        if (!passed) break;
      }
      return { status: res.statusCode, body: res.body };
    }
    let passed = false; let err: unknown;
    await layer.handle(full, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err) throw err;
    if (!passed) return { status: res.statusCode, body: res.body };
  }
  return { status: 404, body: { route: 'لا مسار' } };
}

const sched = (salesRepId: string, o: Row) => st.schedules.push({ id: `SCH-${salesRepId}`, tenantId: T, salesRepId, offDays: [5], rotationStart: null, updatedBy: null, ...o });
const permsOf = (rep: string) => st.routes.filter((r) => r.salesRepId === rep && r.isPermanent);
const stopsOf = (rid: string) => st.stops.filter((s) => s.routeId === rid).length;

test('المسارات الجديدة خلف حارس الأدمن وصلاحية التتبّع: المندوب ومن مُنع التتبّع ⇒ 403، ولا كتابة', async () => {
  reset();
  const s = fs.readFileSync(path.join(SRC, 'routes', 'repRoutes.ts'), 'utf8');
  const guard = s.indexOf("router.use(requireAdmin, requireAdminPermission('canManageTracking'))");
  for (const r of ["router.get('/schedule/:salesRepId'", "router.put('/schedule/:salesRepId'", "router.put('/order/:salesRepId'"]) {
    assert.ok(guard > 0 && s.indexOf(r) > guard, `${r} قبل الحارس`);
  }
  const rep = { user: { id: REP1, role: 'SALES_REP', tenantId: T } };
  assert.equal((await call('put', `/schedule/${REP1}`, { ...rep, body: { mode: 'rotation' } })).status, 403);
  assert.equal((await call('put', `/order/${REP1}`, { ...rep, body: { ids: [RB, RA] } })).status, 403);
  assert.equal((await call('get', `/schedule/${REP1}`, rep)).status, 403);
  const noTrack = { user: { id: 'NOTRACK', role: 'ADMIN', tenantId: T } };
  assert.equal((await call('put', `/schedule/${REP1}`, { ...noTrack, body: { mode: 'rotation' } })).status, 403);
  assert.equal((await call('put', `/order/${REP1}`, { ...noTrack, body: { ids: [RB, RA] } })).status, 403);
  assert.equal(st.schedules.length, 0);
  assert.deepEqual(permsOf(REP1).map((r) => r.rotationOrder), [0, 1]);
  // والمخوَّل يمرّ
  assert.equal((await call('get', `/schedule/${REP1}`)).status, 200);
});

test('نطاق المندوب: خارج النطاق أو لشركةٍ أخرى أو معرّفٌ غير صالح ⇒ 404 «المندوب غير موجود» ولا كتابة', async () => {
  reset();
  scope = new Set([REP2]);
  for (const [m, u, body] of [['get', `/schedule/${REP1}`, {}], ['put', `/schedule/${REP1}`, { mode: 'rotation' }], ['put', `/order/${REP1}`, { ids: [RB, RA] }]] as [string, string, Row][]) {
    const r = await call(m, u, { body });
    assert.equal(r.status, 404, `${m} ${u}`);
    assert.equal(r.body.message, 'المندوب غير موجود');
  }
  scope = null;
  assert.equal((await call('put', `/schedule/${REPX}`, { body: { mode: 'rotation' } })).status, 404, 'شركةٌ أخرى');
  assert.equal((await call('put', `/order/${REPX}`, { body: { ids: [RX] } })).status, 404);
  assert.equal((await call('get', '/schedule/not-a-uuid')).status, 404);
  assert.equal(st.schedules.length, 0);
  assert.deepEqual(permsOf(REP1).map((r) => r.rotationOrder), [0, 1]);
});

test('PUT /schedule: التناوب يبدأ افتراضاً من يوم الطلب والجمعة راحة، والتحقّق يرفض التاريخ المستحيل وأيام الراحة السبعة والمكرّرة والطريقة المجهولة', async () => {
  reset();
  const r = await call('put', `/schedule/${REP1}`, { query: { date: '2026-11-22' }, body: { mode: 'rotation' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(st.schedules.length, 1);
  assert.deepEqual([st.schedules[0].mode, st.schedules[0].rotationStart, st.schedules[0].offDays, st.schedules[0].updatedBy], ['rotation', '2026-11-22', [5], 'ADM']);
  assert.deepEqual(r.body.data.routes.map((x: Row) => x.id), [RA, RB], 'الدوائم بترتيب الدورة — لا المؤقّت');
  assert.deepEqual(r.body.data.today, { routeId: RA, name: 'خط a1', isPermanent: true });
  // تعديلٌ جزئيّ يُبقي ما لم يُرسَل
  await call('put', `/schedule/${REP1}`, { query: { date: '2026-11-22' }, body: { mode: 'rotation', offDays: [6, 5] } });
  assert.deepEqual([st.schedules[0].rotationStart, st.schedules[0].offDays], ['2026-11-22', [5, 6]]);
  for (const body of [
    { mode: 'rotation', rotationStart: '2026-02-30' },
    { mode: 'rotation', rotationStart: '22-11-2026' },
    { mode: 'rotation', offDays: [0, 1, 2, 3, 4, 5, 6] },
    { mode: 'rotation', offDays: [5, 5] },
    { mode: 'rotation', offDays: [7] },
    { mode: 'monthly' },
    {},
  ]) {
    await assert.rejects(() => call('put', `/schedule/${REP1}`, { body }), ZodError, JSON.stringify(body));
  }
  assert.deepEqual([st.schedules[0].rotationStart, st.schedules[0].offDays], ['2026-11-22', [5, 6]], 'المرفوض لا يكتب');
});

test('PUT /schedule: «خط واحد يومياً» يحذف الجدول فعلياً — ويُرفض (409) وللمندوب أكثر من دائمٍ واحد؛ وأيام الأسبوع تُرفض بتعارضٍ داخليّ', async () => {
  reset();
  sched(REP1, { mode: 'rotation', rotationStart: '2026-11-22' });
  const many = await call('put', `/schedule/${REP1}`, { body: { mode: 'single' } });
  assert.equal(many.status, 409);
  assert.equal(many.body.code, 'MULTIPLE_PERMANENT');
  assert.match(many.body.message, /2 خطوط دائمة/);
  assert.equal(st.schedules.length, 1, 'لا حذف');
  // تعارضٌ بين خطّين على يومٍ واحد يمنع التحويل إلى أيام الأسبوع
  st.routes.find((r) => r.id === RB)!.weekdays = [1, 2];
  const clash = await call('put', `/schedule/${REP1}`, { body: { mode: 'weekdays' } });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.code, 'WEEKDAY_CONFLICT');
  assert.match(clash.body.message, /الاثنين/);
  assert.equal(st.schedules[0].mode, 'rotation');
  // المندوب الثاني بدائمٍ واحد: «خط واحد» يحذف جدوله
  sched(REP2, { mode: 'weekdays' });
  const one = await call('put', `/schedule/${REP2}`, { body: { mode: 'single' } });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.data.schedule, null);
  assert.deepEqual(st.schedules.map((s) => s.salesRepId), [REP1]);
});

test('PUT /order: يكتب 0..ن-1 بالترتيب المرسَل — ويرفض الناقص والزائد وخطّ غيره والمؤقّت (400 ORDER_MISMATCH) والمكرّر', async () => {
  reset();
  sched(REP1, { mode: 'rotation', rotationStart: '2026-11-22' });
  const ok = await call('put', `/order/${REP1}`, { query: { date: '2026-11-22' }, body: { ids: [RB, RA] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([st.routes.find((r) => r.id === RB)!.rotationOrder, st.routes.find((r) => r.id === RA)!.rotationOrder], [0, 1]);
  assert.deepEqual(ok.body.data.routes.map((x: Row) => x.id), [RB, RA]);
  assert.equal(ok.body.data.today.routeId, RB, 'أوّل الترتيب الجديد يوم البداية');
  for (const ids of [[RB], [RB, RA, R2], [RB, R2], [RB, RA, RD]]) {
    const r = await call('put', `/order/${REP1}`, { body: { ids } });
    assert.equal(r.status, 400, JSON.stringify(ids));
    assert.equal(r.body.code, 'ORDER_MISMATCH');
  }
  await assert.rejects(() => call('put', `/order/${REP1}`, { body: { ids: [RA, RA] } }), ZodError);
  await assert.rejects(() => call('put', `/order/${REP1}`, { body: { ids: [] } }), ZodError);
  await assert.rejects(() => call('put', `/order/${REP1}`, { body: { ids: ['x'] } }), ZodError);
  assert.deepEqual([st.routes.find((r) => r.id === RB)!.rotationOrder, st.routes.find((r) => r.id === RA)!.rotationOrder], [0, 1], 'المرفوض لا يكتب');
  assert.equal(st.routes.find((r) => r.id === R2)!.rotationOrder, 0, 'خطّ المندوب الآخر لا يُمسّ');
});

test('POST دائم لمندوبٍ له جدول: دوائمه الأخرى باقية، والجديد آخر الدورة (الأكبر + 1) بأيامه', async () => {
  reset();
  sched(REP1, { mode: 'rotation', rotationStart: '2026-11-22' });
  const r = await call('post', '/', { body: { salesRepId: REP1, name: 'خط ثالث', isPermanent: true, weekdays: [6, 4], stops: [{ customerId: C2 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const nw = st.routes.find((x) => x.id === r.body.data.id)!;
  assert.deepEqual([nw.isPermanent, nw.rotationOrder, nw.weekdays], [true, 2, [4, 6]]);
  assert.deepEqual(permsOf(REP1).map((x) => x.id).sort(), [RA, RB, nw.id].sort(), 'دائمٌ آخر حُذف');
  assert.equal(stopsOf(RA), 2);
  assert.equal(stopsOf(RB), 2);
  assert.ok(st.routes.some((x) => x.id === RD), 'المؤقّت باقٍ');
});

test('POST تعديل دائمٍ (replacesId) لمندوبٍ له جدول: يُحذف المُحرَّر وحده فعلياً، ويبقى موضعه في الدورة وأيامه ما لم تُرسَل أيام', async () => {
  reset();
  sched(REP1, { mode: 'weekdays' });
  const r = await call('post', '/', { body: { salesRepId: REP1, name: 'أ معدَّل', isPermanent: true, replacesId: RA, stops: [{ customerId: C1 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(!st.routes.some((x) => x.id === RA), 'المُحرَّر باقٍ');
  assert.equal(stopsOf(RA), 0);
  const nw = st.routes.find((x) => x.id === r.body.data.id)!;
  assert.deepEqual([nw.rotationOrder, nw.weekdays], [0, [0, 1]]);
  assert.ok(st.routes.some((x) => x.id === RB) && stopsOf(RB) === 2, 'الدائم الآخر حُذف');
  // تعديل B إلى أيامٍ جديدة لا تتعارض مع نفسه
  const b = await call('post', '/', { body: { salesRepId: REP1, name: 'ب', isPermanent: true, replacesId: RB, weekdays: [2, 3, 4], stops: [{ customerId: C1 }] } });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.deepEqual(st.routes.find((x) => x.id === b.body.data.id)!.rotationOrder, 1);
});

test('POST بأيام الأسبوع: يومٌ يستعمله خطٌّ آخر للمندوب ⇒ 409 WEEKDAY_CONFLICT بالعربية ولا يُكتب شيء', async () => {
  reset();
  sched(REP1, { mode: 'weekdays' });
  const before = { routes: st.routes.length, stops: st.stops.length };
  const r = await call('post', '/', { body: { salesRepId: REP1, name: 'خط الأحد', isPermanent: true, weekdays: [0, 4], stops: [{ customerId: C1 }] } });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'WEEKDAY_CONFLICT');
  assert.match(r.body.message, /يوم الأحد مستخدمٌ في خط «خط a1»/);
  assert.deepEqual(r.body.conflict, { day: 0, routeId: RA, name: 'خط a1' });
  assert.deepEqual({ routes: st.routes.length, stops: st.stops.length }, before);
  // تعديل B إلى يوم A ⇒ مرفوض كذلك (التعارض مع غيره لا مع نفسه)
  const b = await call('post', '/', { body: { salesRepId: REP1, name: 'ب', isPermanent: true, replacesId: RB, weekdays: [1, 2], stops: [{ customerId: C1 }] } });
  assert.equal(b.status, 409);
  assert.ok(st.routes.some((x) => x.id === RB), 'المرفوض لا يحذف المُحرَّر');
  // والأيام المكرّرة أو خارج 0..6 مرفوضة بالتحقّق
  await assert.rejects(() => call('post', '/', { body: { salesRepId: REP1, name: 'د', isPermanent: true, weekdays: [1, 1], stops: [{ customerId: C1 }] } }), ZodError);
  await assert.rejects(() => call('post', '/', { body: { salesRepId: REP1, name: 'د', isPermanent: true, weekdays: [7], stops: [{ customerId: C1 }] } }), ZodError);
});

test('مراجعة ٢٢ نوفمبر: WEEKDAY_CONFLICT يُفحص متى أُرسلت الأيام أيّاً كانت الطريقة — في التناوب كذلك، وبلا جدولٍ لا تعارض لأن دائمه يُستبدل', async () => {
  reset();
  sched(REP1, { mode: 'rotation', rotationStart: '2026-11-22' });
  const before = { routes: st.routes.length, stops: st.stops.length };
  // التناوب: أيامٌ تُحدَّد تمهيداً لـ«حسب أيام الأسبوع» لا تُخزَّن متعارضة فيُرفض التحويل بعدها
  const clash = await call('post', '/', { body: { salesRepId: REP1, name: 'ج', isPermanent: true, weekdays: [0], stops: [{ customerId: C1 }] } });
  assert.equal(clash.status, 409, JSON.stringify(clash.body));
  assert.equal(clash.body.code, 'WEEKDAY_CONFLICT');
  assert.deepEqual(clash.body.conflict, { day: 0, routeId: RA, name: 'خط a1' });
  assert.deepEqual({ routes: st.routes.length, stops: st.stops.length }, before, 'المرفوض لا يكتب');
  // يومٌ حرّ يُقبل في التناوب ويبقى الدائمان الآخران
  const free = await call('post', '/', { body: { salesRepId: REP1, name: 'ج', isPermanent: true, weekdays: [6], stops: [{ customerId: C1 }] } });
  assert.equal(free.status, 201, JSON.stringify(free.body));
  assert.equal(permsOf(REP1).length, 3);
  // تعديل B في التناوب بلا أيامٍ مرسَلة: أيامه الباقية لا تُفحص (ليست إدخالاً جديداً)
  st.routes.find((r) => r.id === RB)!.weekdays = [1]; // تعارضٌ قديم مع A كتبه مسارٌ سابق
  const keep = await call('post', '/', { body: { salesRepId: REP1, name: 'ب', isPermanent: true, replacesId: RB, stops: [{ customerId: C1 }] } });
  assert.equal(keep.status, 201, JSON.stringify(keep.body));
  assert.deepEqual(st.routes.find((x) => x.id === keep.body.data.id)!.weekdays, [1]);
  // بلا جدول («خط واحد يومياً»): الحفظ يستبدل دوائم المندوب كلّها، فيوم A ليس محجوزاً
  reset();
  const single = await call('post', '/', { body: { salesRepId: REP1, name: 'وحيد', isPermanent: true, weekdays: [0, 1], stops: [{ customerId: C1 }] } });
  assert.equal(single.status, 201, JSON.stringify(single.body));
  assert.deepEqual(permsOf(REP1).map((x) => [x.id, x.weekdays]), [[single.body.data.id, [0, 1]]]);
});

test('مراجعة ٢٢ نوفمبر: PUT /schedule إلى «حسب أيام الأسبوع» ودوائم المندوب كلّها بلا أيام ⇒ 409 NO_WEEKDAYS بأسمائها ولا كتابة', async () => {
  reset();
  sched(REP1, { mode: 'rotation', rotationStart: '2026-11-22' });
  for (const r of permsOf(REP1)) r.weekdays = [];
  const r = await call('put', `/schedule/${REP1}`, { body: { mode: 'weekdays' } });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'NO_WEEKDAYS');
  assert.match(r.body.message, /«حسب أيام الأسبوع» يحتاج أياماً لكل خط/);
  assert.match(r.body.message, /«خط a1»/);
  assert.match(r.body.message, /«خط a2»/);
  assert.doesNotMatch(r.body.message, /[A-Za-z]{4,}/, 'رسالةٌ بالعربية');
  assert.deepEqual(r.body.routes.map((x: Row) => x.id), [RA, RB]);
  assert.equal(st.schedules[0].mode, 'rotation', 'المرفوض لا يكتب');
  // مندوبٌ بلا جدولٍ ودائمُه الوحيد بلا أيام: كذلك — ولا يُنشأ جدول
  const two = await call('put', `/schedule/${REP2}`, { body: { mode: 'weekdays' } });
  assert.equal(two.status, 409);
  assert.equal(two.body.code, 'NO_WEEKDAYS');
  assert.deepEqual(st.schedules.map((s) => s.salesRepId), [REP1]);
  // بعضها بأيام: يُقبل (النافذة تسأل المالك وتسمّي الباقي)
  st.routes.find((x) => x.id === RA)!.weekdays = [0];
  const some = await call('put', `/schedule/${REP1}`, { body: { mode: 'weekdays' } });
  assert.equal(some.status, 200, JSON.stringify(some.body));
  assert.equal(st.schedules[0].mode, 'weekdays');
  // بلا دوائم أصلاً: لا خطّة تُطفأ — تُعدّ الطريقة قبل الخطوط
  st.routes = st.routes.filter((x) => x.id !== R2);
  const none = await call('put', `/schedule/${REP2}`, { body: { mode: 'weekdays' } });
  assert.equal(none.status, 200, JSON.stringify(none.body));
  assert.equal(st.schedules.find((s) => s.salesRepId === REP2)?.mode, 'weekdays');
});

test('مراجعة ٢٢ نوفمبر: تعديل دائمٍ يرث تاريخ إنشاء سلفه — فخطّة الأيام الماضية في التناوب وأيام الأسبوع لا تنتقل إلى خطٍّ آخر', async () => {
  reset();
  // التناوب من الثلاثاء ٣ نوفمبر بلا راحة: ٣ ⇒ A، ٤ ⇒ B، ٥ ⇒ A (والخطّان موجودان منذ ١ و٢ نوفمبر)
  sched(REP1, { mode: 'rotation', rotationStart: '2026-11-03', offDays: [] });
  const rep = { user: { id: REP1, role: 'SALES_REP', tenantId: T } };
  const mine = async (date: string) => (await call('get', '/mine', { ...rep, query: { date } })).body.data?.id ?? null;
  assert.deepEqual([await mine('2026-11-03'), await mine('2026-11-04'), await mine('2026-11-05')], [RA, RB, RA]);
  const born = st.routes.find((x) => x.id === RA)!.createdAt as Date;
  const r = await call('post', '/', { body: { salesRepId: REP1, name: 'أ معدَّل', isPermanent: true, replacesId: RA, stops: [{ customerId: C2 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const nw = st.routes.find((x) => x.id === r.body.data.id)!;
  assert.equal((nw.createdAt as Date).getTime(), born.getTime(), 'تاريخ الإنشاء لم يُورَث');
  assert.equal(nw.rotationOrder, 0);
  // بتاريخٍ جديد كان ٥ نوفمبر يصير لـB (الخطّ المعدَّل «لم يكن موجوداً») — الآن يبقى للخطّ نفسه
  assert.deepEqual([await mine('2026-11-03'), await mine('2026-11-04'), await mine('2026-11-05')], [nw.id, RB, nw.id]);
  // «حسب أيام الأسبوع»: الأحد الماضي (٨ نوفمبر) يبقى للخطّ المعدَّل
  st.schedules[0] = { ...st.schedules[0], mode: 'weekdays' };
  assert.equal(await mine('2026-11-08'), nw.id);
  // وبلا جدول (دائمٌ واحد): تعديل دائم REP2 يرث تاريخه كذلك
  const born2 = st.routes.find((x) => x.id === R2)!.createdAt as Date;
  const r2 = await call('post', '/', { body: { salesRepId: REP2, name: 'م٢', isPermanent: true, replacesId: R2, stops: [{ customerId: C1 }] } });
  assert.equal((st.routes.find((x) => x.id === r2.body.data.id)!.createdAt as Date).getTime(), born2.getTime());
  // خطٌّ جديد (لا replacesId) أو مؤقّتٌ صار دائماً لا يرث شيئاً
  const fresh = await call('post', '/', { body: { salesRepId: REP1, name: 'جديد', isPermanent: true, weekdays: [6], stops: [{ customerId: C1 }] } });
  assert.ok((st.routes.find((x) => x.id === fresh.body.data.id)!.createdAt as Date).getTime() > born.getTime());
  const fromDated = await call('post', '/', { body: { salesRepId: REP1, name: 'من مؤقّت', isPermanent: true, replacesId: RD, weekdays: [4], stops: [{ customerId: C1 }] } });
  assert.equal(fromDated.status, 201, JSON.stringify(fromDated.body));
  assert.ok((st.routes.find((x) => x.id === fromDated.body.data.id)!.createdAt as Date).getTime() > born.getTime());
  // ولا يرث خطٌّ نُقل إلى مندوبٍ آخر تاريخَ سلفه
  const moved = await call('post', '/', { body: { salesRepId: REP2, name: 'منقول', isPermanent: true, replacesId: RB, stops: [{ customerId: C1 }] } });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  assert.ok((st.routes.find((x) => x.id === moved.body.data.id)!.createdAt as Date).getTime() > born.getTime());
});

test('POST دائم بلا جدول: السلوك القديم — دائمٌ واحد للمندوب، والسابق يُحذف فعلياً', async () => {
  reset();
  const r = await call('post', '/', { body: { salesRepId: REP1, name: 'وحيد', isPermanent: true, stops: [{ customerId: C1 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(permsOf(REP1).map((x) => x.id), [r.body.data.id]);
  assert.equal(stopsOf(RA) + stopsOf(RB), 0);
  assert.equal(st.routes.find((x) => x.id === r.body.data.id)!.rotationOrder, 0);
});

test('GET /mine يتبع الجدول: أيام الأسبوع والتناوب ويوم الراحة والمؤقّت — تطبيق المندوب وخريطة التتبّع يقرآنه', async () => {
  reset();
  const rep = { user: { id: REP1, role: 'SALES_REP', tenantId: T } };
  const mine = async (date: string) => (await call('get', '/mine', { ...rep, query: { date } })).body.data?.id ?? null;
  // بلا جدول: أوّل دائم
  assert.equal(await mine('2026-11-24'), RA);
  sched(REP1, { mode: 'weekdays' });
  assert.equal(await mine('2026-11-22'), RA); // أحد
  assert.equal(await mine('2026-11-24'), RB); // ثلاثاء
  assert.equal(await mine('2026-11-26'), null, 'الخميس بلا خطّ');
  assert.equal(await mine('2026-11-25'), RD, 'المؤقّت يفوز');
  st.schedules[0] = { ...st.schedules[0], mode: 'rotation', rotationStart: '2026-11-22', offDays: [5] };
  assert.equal(await mine('2026-11-22'), RA);
  assert.equal(await mine('2026-11-23'), RB);
  assert.equal(await mine('2026-11-24'), RA);
  assert.equal(await mine('2026-11-27'), null, 'الجمعة راحة');
  // السبت: أيام العمل قبله أحد..خميس = 5 (المؤقّت يوم الأربعاء لا يُزيح الدورة) ⇒ 5 % 2 = 1
  assert.equal(await mine('2026-11-28'), RB);
});

test('GET / : علامة «اليوم» و«أنجز اليوم» لخطّ اليوم بجدول كل مندوب وحده، ومعها النمط والأيام والترتيب', async () => {
  reset();
  sched(REP1, { mode: 'rotation', rotationStart: '2026-11-22', offDays: [5] });
  st.visits.push({ tenantId: T, salesRepId: REP1, customerId: C1 }, { tenantId: T, salesRepId: REP2, customerId: C2 });
  const r = await call('get', '/', { query: { date: '2026-11-23' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = (rid: string) => r.body.data.find((x: Row) => x.id === rid);
  assert.deepEqual([row(RA).isToday, row(RA).doneToday], [false, null], 'الاثنين دور B');
  assert.deepEqual([row(RB).isToday, row(RB).doneToday], [true, 1]);
  assert.deepEqual([row(RD).isToday, row(RD).doneToday], [false, null], 'مؤقّت يومٍ آخر');
  assert.deepEqual([row(R2).isToday, row(R2).doneToday, row(R2).scheduleMode], [true, 1, null], 'بلا جدول: دائمه خطّ يومه');
  assert.deepEqual([row(RB).scheduleMode, row(RB).weekdays, row(RB).rotationOrder], ['rotation', [2, 3], 1]);
  assert.ok(!r.body.data.some((x: Row) => x.id === RX), 'شركةٌ أخرى');
  // يوم المؤقّت: هو خطّ اليوم لا الدائم
  const d = await call('get', '/', { query: { date: '2026-11-25' } });
  const dr = (rid: string) => d.body.data.find((x: Row) => x.id === rid);
  assert.deepEqual([dr(RD).isToday, dr(RA).isToday, dr(RB).isToday], [true, false, false]);
});

test('GET /:id يعيد أيام الخطّ وموضعه — ليملأ المحرّر أيامه', async () => {
  reset();
  const r = await call('get', `/${RB}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.data.weekdays, r.body.data.rotationOrder], [[2, 3], 1]);
});
