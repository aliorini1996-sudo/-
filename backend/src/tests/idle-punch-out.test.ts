// «تذكير بالانصراف عند الخمول ثم انصراف تلقائي» (طلب المالك، ٢٣ نوفمبر ٢٠٢٦) — services/idlePunchOut.ts والمسارات الحقيقية
// (/api/sales-reps و/api/tracking) فوق Prisma مزيّف في الذاكرة — بلا قاعدة ولا شبكة. يثبت:
//   • الحكم الصرف idleDecision: تذكيرٌ عند بلوغ الخمول، وانصرافٌ تلقائي بعد المهلة بوقت آخر نشاط (لا قبل الحضور أبداً)، وحدّ
//     المهلة بالدقيقة، ونشاطٌ بعد التذكير يعيد الدورة، والمطفأ والنوبة القديمة (> ٧ أيام) لا يُمسّان.
//   • الدورة runIdlePunchOut: تذكيرٌ واحد لكل فترة خمول بإشعارٍ بلغة الجهاز، ثم انصرافٌ تلقائي بوقت آخر نشاط موسومٌ checkOutAuto
//     وسطر تدقيق AUTO_CHECKOUT باسم «النظام» تحت قفل بصمات المندوب — ونقاط الخلفية الساكنة ليست نشاطاً وحركتها نشاط.
//   • إعدادات المندوب: المدّتان خارج حدّيهما 400 IDLE_PUNCH_OUT_RANGE برسالةٍ عربية، والسليمة تُكتب وتُقرأ.
//   • ردّ النبضة و/attendance/today يحملان idlePunchOutReminder، و«ما زلت أعمل» يمحو التذكير ويكتب نشاطاً، وبعد انصرافٍ تلقائي
//     409 NO_OPEN_SHIFT ومعه autoCheckedOut.
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'idle-punch-out-test-secret';
const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
// ═══ عالمٌ في الذاكرة ═══
const MIN = 60_000;
const TENANT = 'T1';
type Rep = {
  id: string; tenantId: string; isActive: boolean; tenantOn: boolean; lastSeenAt: Date | null;
  idlePunchOutEnabled: boolean; idlePunchOutMinutes: number; idlePunchOutGraceMinutes: number; requirePresenceCheck: boolean; lang: string | null;
};
type Shift = {
  id: string; tenantId: string; salesRepId: string; checkInAt: Date; checkOutAt: Date | null; idleRemindedAt: Date | null;
  checkOutAuto: boolean; editedAt: Date | null; editedBy: string | null; checkInLat: number | null; checkInLng: number | null;
  checkInOutside: boolean | null; checkInDistanceM: number | null; checkOutOutside: boolean | null;
};
type Loc = { tenantId: string; salesRepId: string; lat: number; lng: number; accuracy: number | null; capturedAt: Date; createdAt: Date; source: string | null };

let reps: Rep[] = [];
let shifts: Shift[] = [];
let locs: Loc[] = [];
let audits: any[] = [];
let pushes: { repId: string; payload: any; ttlSec?: number }[] = [];
let locks: string[] = [];
let calls: string[] = [];
/** الدورة تختار المؤهّلين في الاستعلام — false يعيد كل المناديب كأن القاعدة لم تُرشّح (يختبر الحارس الثاني الصرف) */
let honorWhere = true;
/** يُنادى عند أخذ القفل — يمثّل نشاطاً يصل بين الحكم والقفل */
let onLock: (() => void) | null = null;
/** إعدادات المسار: ما كُتب وما قُرئ */
let repCreates: any[] = [];
let repUpdates: any[] = [];
let repSelects: any[] = [];
let failLocFor: string | null = null;

const rep = (o: Partial<Rep> & { id: string }): Rep => ({
  tenantId: TENANT, isActive: true, tenantOn: true, lastSeenAt: null, idlePunchOutEnabled: true, idlePunchOutMinutes: 45,
  idlePunchOutGraceMinutes: 15, requirePresenceCheck: false, lang: 'ar', ...o,
});
const shift = (o: Partial<Shift> & { id: string; salesRepId: string; checkInAt: Date }): Shift => ({
  tenantId: TENANT, checkOutAt: null, idleRemindedAt: null, checkOutAuto: false, editedAt: null, editedBy: null,
  checkInLat: null, checkInLng: null, checkInOutside: null, checkInDistanceM: null, checkOutOutside: null, ...o,
});

const val = (x: unknown) => (x instanceof Date ? x.getTime() : x);
function matchWhere(row: Record<string, any>, where: Record<string, any> | undefined): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === 'OR') { if (!(v as any[]).some((w) => matchWhere(row, w))) return false; continue; }
    if (k === 'AND') { if (!(v as any[]).every((w) => matchWhere(row, w))) return false; continue; }
    const x = row[k];
    if (v === null) { if (x != null) return false; continue; }
    if (v instanceof Date) { if (val(x) !== v.getTime()) return false; continue; }
    if (v && typeof v === 'object') {
      if ('not' in v && (v.not === null ? x == null : x === v.not)) return false;
      if ('in' in v && !v.in.includes(x)) return false;
      if (v.gte != null && !(x != null && (val(x) as number) >= (val(v.gte) as number))) return false;
      if (v.gt != null && !(x != null && (val(x) as number) > (val(v.gt) as number))) return false;
      if (v.lt != null && !(x != null && (val(x) as number) < (val(v.lt) as number))) return false;
      if (v.lte != null && !(x != null && (val(x) as number) <= (val(v.lte) as number))) return false;
      continue;
    }
    if (x !== v) return false;
  }
  return true;
}
const pick = (row: Record<string, any>, select?: Record<string, any>) => {
  if (!select) return { ...row };
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(select)) {
    if (!v) continue;
    if (k === 'salesRep' && typeof v === 'object') { out.salesRep = pick(reps.find((r) => r.id === row.salesRepId)!, v.select); continue; }
    out[k] = row[k];
  }
  return out;
};
// orderBy كائنٌ أو مصفوفة كائنات (ترتيبٌ بمفاتيح متتالية) كما في Prisma
const sortBy = <T extends Record<string, any>>(l: T[], orderBy: any): T[] => {
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy ?? { id: 'asc' }]).map((o: any) => {
    const [[k, dir]] = Object.entries(o) as [string, any][];
    return { k, d: (typeof dir === 'object' ? dir.sort : dir) === 'desc' ? -1 : 1 };
  });
  return [...l].sort((a, b) => {
    for (const { k, d } of keys) {
      const diff = ((val(a[k]) as number) - (val(b[k]) as number)) * d;
      if (diff) return diff;
    }
    return 0;
  });
};

const handlers: Record<string, (a: any) => unknown> = {
  // الدورة: المؤهّلون ولهم نوبةٌ مفتوحة حديثة
  'salesRep.findMany': (a) => {
    if (a?.select?.attendance) {
      const since: Date = a.where.attendance.some.checkInAt.gte;
      return reps
        .filter((r) => !honorWhere || (r.idlePunchOutEnabled && r.isActive && r.tenantOn))
        .map((r) => ({
          id: r.id, tenantId: r.tenantId, isActive: r.isActive, lastSeenAt: r.lastSeenAt, idlePunchOutEnabled: r.idlePunchOutEnabled,
          idlePunchOutMinutes: r.idlePunchOutMinutes, idlePunchOutGraceMinutes: r.idlePunchOutGraceMinutes,
          attendance: sortBy(shifts.filter((s) => s.salesRepId === r.id && !s.checkOutAt && (!honorWhere || s.checkInAt >= since)), { checkInAt: 'desc' })
            .slice(0, 1).map((s) => ({ id: s.id, checkInAt: s.checkInAt, idleRemindedAt: s.idleRemindedAt })),
          pushSubscriptions: r.lang ? [{ lang: r.lang }] : [],
        }))
        .filter((r) => r.attendance.length);
    }
    repSelects.push(a?.select);
    return [];
  },
  'salesRep.findFirst': (a) => {
    if (a?.where && ('username' in a.where || 'phone' in a.where || 'email' in a.where)) return null;
    const r = reps.find((x) => x.id === a?.where?.id);
    if (a?.select && r) repSelects.push(a.select);
    return r ? pick(r, a.select) : null;
  },
  'salesRep.findUnique': (a) => { const r = reps.find((x) => x.id === a.where.id); return r ? pick(r, a.select) : null; },
  'salesRep.update': (a) => {
    const r = reps.find((x) => x.id === a.where.id);
    if (r) Object.assign(r, Object.fromEntries(Object.entries(a.data).filter(([k]) => k in r)));
    repUpdates.push(a);
    return r ? pick(r, a.select) : { id: a.where.id, name: 'م', phone: '0', username: 'u', isActive: true };
  },
  'salesRep.create': (a) => { repCreates.push(a); return { id: 'rep-new', name: a.data.name, phone: a.data.phone, username: a.data.username, isActive: true }; },
  'salesRep.count': () => 0,
  'repAttendance.findFirst': (a) => {
    const l = sortBy(shifts.filter((s) => matchWhere(s, a.where)), a.orderBy);
    return l[0] ? pick(l[0], a.select) : null;
  },
  'repAttendance.findMany': (a) => sortBy(shifts.filter((s) => matchWhere(s, a.where)), a.orderBy).slice(0, a.take ?? 1e9).map((s) => pick(s, a.select)),
  'repAttendance.updateMany': (a) => {
    const l = shifts.filter((s) => matchWhere(s, a.where));
    for (const s of l) Object.assign(s, a.data);
    return { count: l.length };
  },
  'repAttendance.update': (a) => { const s = shifts.find((x) => x.id === a.where.id)!; Object.assign(s, a.data); return pick(s, a.select); },
  'attendanceAudit.create': (a) => { audits.push(a.data); return { id: `au${audits.length}` }; },
  'repLocation.findMany': (a) => {
    if (failLocFor && a.where.salesRepId === failLocFor) throw new Error('boom');
    return sortBy(locs.filter((l) => matchWhere(l, a.where)), a.orderBy).slice(0, a.take ?? 1e9).map((l) => pick(l, a.select));
  },
  'repSession.findFirst': () => null,
  'repSession.create': () => ({}),
  'tenant.findUnique': () => ({ attendanceEnabled: true }),
  'admin.findUnique': () => ({ id: 'admin-1', isActive: true, scopeEnabled: false }),
};
const defaultFor = (method: string): unknown => {
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
  return null;
};
const prismaFake: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (arg: unknown) => {
        calls.push('$transaction');
        if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
        return (arg as (tx: unknown) => Promise<unknown>)(prismaFake);
      };
    }
    if (key === '$executeRaw' || key === '$queryRaw') {
      return async (_s: TemplateStringsArray, ...values: unknown[]) => {
        if (String(values[0]).startsWith('rep-attendance:')) { locks.push(String(values[0])); onLock?.(); }
        return key === '$queryRaw' ? [] : 0;
      };
    }
    if (key === 'then') return undefined;
    return new Proxy({}, {
      get: (_m, method: string) => async (args: unknown) => {
        calls.push(`${key}.${method}`);
        const fn = handlers[`${key}.${method}`];
        return fn ? fn(args) : defaultFor(method);
      },
    });
  },
});

type User = { id: string; role: string; tenantId: string; name?: string };
const ADMIN: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, name: 'مدير' };
let currentUser: User = ADMIN;

stub('config/database', { default: prismaFake });
stub('services/mailer', { async sendMail() { return true; }, mailLayout: () => '' });
stub('services/webPush', {
  sendPushToRep: async (repId: string, payload: unknown, opts: { ttlSec?: number } = {}) => { pushes.push({ repId, payload, ttlSec: opts.ttlSec }); return 1; },
  getVapidKeys: async () => ({ publicKey: 'k' }), pushEndpointAllowed: () => true, pushKeysValid: () => true,
});
/* eslint-disable @typescript-eslint/no-var-requires */
const realAuth = require('../middleware/auth') as Record<string, unknown>;
stub('middleware/auth', {
  ...realAuth,
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
});
const idle = require('../services/idlePunchOut') as typeof import('../services/idlePunchOut');
const workDay = require('../services/workDay') as typeof import('../services/workDay');
const salesRepsRouter = (require('../routes/salesReps') as typeof import('../routes/salesReps')).default;
const trackingRouter = (require('../routes/tracking') as typeof import('../routes/tracking')).default;
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */

beforeEach(() => {
  reps = []; shifts = []; locs = []; audits = []; pushes = []; locks = []; calls = [];
  honorWhere = true; onLock = null; repCreates = []; repUpdates = []; repSelects = []; failLocFor = null;
  currentUser = ADMIN;
  idle._resetIdleLoop();
});

// ═══ العُدّة: خادمٌ محلّي للمسارات ═══
let server: { port: number; close: () => Promise<void> } | null = null;
async function startServer() {
  if (server) return server;
  const app = express();
  app.use(express.json());
  app.use('/api/sales-reps', salesRepsRouter);
  app.use('/api/tracking', trackingRouter);
  app.use(errorHandler);
  const s = http.createServer(app);
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
  return server;
}
after(async () => { await server?.close(); server = null; });
type Reply = { status: number; body: Record<string, any> };
async function call(method: 'POST' | 'GET' | 'PUT', url: string, body?: unknown): Promise<Reply> {
  const s = await startServer();
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: s.port, method, path: url, agent: false,
      headers: { connection: 'close', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : {} }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const T0 = new Date(Date.UTC(2026, 10, 23, 6, 0)); // ٩ صباحاً بالرياض
const at = (m: number) => new Date(T0.getTime() + m * MIN);
const decide = (o: Partial<import('../services/idlePunchOut').IdleInput>) => idle.idleDecision({
  checkInAt: T0, lastActive: null, idleRemindedAt: null, now: T0, idleMinutes: 45, graceMinutes: 15, ...o,
});

// ═══ (١) الحكم الصرف ═══

test('الحكم: لا شيء قبل دقائق الخمول، وتذكيرٌ عند بلوغها بالضبط', () => {
  assert.equal(decide({ lastActive: at(10), now: at(10 + 44) }).verdict, 'NONE');
  assert.equal(decide({ lastActive: at(10), now: at(10 + 44.99) }).verdict, 'NONE');
  const d = decide({ lastActive: at(10), now: at(10 + 45) });
  assert.equal(d.verdict, 'REMIND');
  assert.equal(d.checkOutAt, null);
  assert.equal(d.lastActive.getTime(), at(10).getTime());
  // المدّة لكل مندوب: ٩٠ دقيقة ⇒ لا تذكير عند ٤٥
  assert.equal(decide({ lastActive: at(10), now: at(10 + 45), idleMinutes: 90 }).verdict, 'NONE');
  assert.equal(decide({ lastActive: at(10), now: at(10 + 90), idleMinutes: 90 }).verdict, 'REMIND');
});

test('الحكم: النشاط قبل الحضور لا يُحسب أبداً — الحضور أرضيّته، وبلا أثرٍ أصلاً الحضور نفسه', () => {
  // نبضة الأمس (قبل الحضور بساعات) لا تجعل النوبة خاملةً منذ الأمس
  const old = decide({ lastActive: at(-300), now: at(30) });
  assert.equal(old.verdict, 'NONE');
  assert.equal(old.lastActive.getTime(), T0.getTime());
  assert.equal(decide({ lastActive: at(-300), now: at(45) }).verdict, 'REMIND');
  assert.equal(decide({ lastActive: null, now: at(44) }).verdict, 'NONE');
  assert.equal(decide({ lastActive: null, now: at(45) }).verdict, 'REMIND');
  // والانصراف التلقائي بلا أيّ نشاطٍ بعد الحضور = لحظة الحضور، لا قبلها
  const out = decide({ lastActive: at(-300), idleRemindedAt: at(45), now: at(60) });
  assert.equal(out.verdict, 'AUTO_OUT');
  assert.equal(out.checkOutAt!.getTime(), T0.getTime());
  // ونشاطٌ «في المستقبل» (ساعةٌ منحرفة) لا يتجاوز الآن
  assert.equal(decide({ lastActive: at(500), now: at(50) }).lastActive.getTime(), at(50).getTime());
});

test('الحكم: الانصراف التلقائي بعد المهلة بالضبط وبوقت آخر نشاط — لا بوقت الدورة', () => {
  const remindedAt = at(10 + 45);
  assert.equal(decide({ lastActive: at(10), idleRemindedAt: remindedAt, now: at(10 + 45 + 14) }).verdict, 'NONE');
  assert.equal(decide({ lastActive: at(10), idleRemindedAt: remindedAt, now: new Date(at(10 + 45 + 15).getTime() - 1) }).verdict, 'NONE');
  const d = decide({ lastActive: at(10), idleRemindedAt: remindedAt, now: at(10 + 45 + 15) });
  assert.equal(d.verdict, 'AUTO_OUT');
  assert.equal(d.checkOutAt!.getTime(), at(10).getTime(), 'وقت الانصراف = آخر نشاط');
  // مهلةٌ أطول لكل مندوب
  assert.equal(decide({ lastActive: at(10), idleRemindedAt: remindedAt, now: at(10 + 45 + 15), graceMinutes: 30 }).verdict, 'NONE');
  assert.equal(decide({ lastActive: at(10), idleRemindedAt: remindedAt, now: at(10 + 45 + 30), graceMinutes: 30 }).verdict, 'AUTO_OUT');
});

test('الحكم: نشاطٌ بعد التذكير يعيد الدورة — لا انصراف، وتذكيرٌ جديد بعد خمولٍ جديد كامل', () => {
  const remindedAt = at(55);
  // نبضةٌ عند ٦٠ (بعد التذكير): التذكير صار سابقاً لآخر نشاط
  assert.equal(decide({ lastActive: at(60), idleRemindedAt: remindedAt, now: at(75) }).verdict, 'NONE');
  assert.equal(decide({ lastActive: at(60), idleRemindedAt: remindedAt, now: at(104) }).verdict, 'NONE');
  assert.equal(decide({ lastActive: at(60), idleRemindedAt: remindedAt, now: at(105) }).verdict, 'REMIND');
  // والتذكير الجديد يبدأ مهلةً جديدة
  assert.equal(decide({ lastActive: at(60), idleRemindedAt: at(105), now: at(119) }).verdict, 'NONE');
  const d = decide({ lastActive: at(60), idleRemindedAt: at(105), now: at(120) });
  assert.equal(d.verdict, 'AUTO_OUT');
  assert.equal(d.checkOutAt!.getTime(), at(60).getTime());
});

test('الحكم: المطفأ والمعطّل والنوبة المفتوحة منذ أكثر من ٧ أيام لا تُمسّ', () => {
  assert.equal(decide({ lastActive: at(10), now: at(200), enabled: false }).verdict, 'NONE');
  assert.equal(decide({ lastActive: at(10), idleRemindedAt: at(55), now: at(200), enabled: false }).verdict, 'NONE');
  assert.equal(decide({ lastActive: at(10), now: at(200), enabled: true }).verdict, 'REMIND');
  assert.equal(decide({ lastActive: at(10), now: at(200) }).verdict, 'REMIND', 'غائبٌ = مفعّل (الاستعلام يرشّح)');
  const day = 24 * 60;
  assert.equal(decide({ checkInAt: at(-8 * day), lastActive: at(-8 * day), now: T0 }).verdict, 'NONE');
  assert.equal(decide({ checkInAt: at(-8 * day), lastActive: at(-8 * day), idleRemindedAt: at(-8 * day + 50), now: T0 }).verdict, 'NONE');
  assert.equal(decide({ checkInAt: at(-6 * day), lastActive: at(-6 * day), now: T0 }).verdict, 'REMIND');
});

test('الحكم: مدّةٌ رفعتها الإدارة بعد التذكير لا تصرف قبل أوانها، والمخزّن الفاسد يعود للافتراض', () => {
  assert.equal(decide({ lastActive: at(0), idleRemindedAt: at(45), now: at(60), idleMinutes: 120 }).verdict, 'NONE');
  assert.equal(decide({ lastActive: at(0), idleRemindedAt: at(45), now: at(120), idleMinutes: 120 }).verdict, 'AUTO_OUT');
  assert.equal(decide({ lastActive: at(0), now: at(1), idleMinutes: 0 }).verdict, 'NONE', 'صفرٌ في القاعدة لا يذكّر بعد دقيقة');
  assert.equal(decide({ lastActive: at(0), now: at(45), idleMinutes: 0 }).verdict, 'REMIND');
  assert.equal(decide({ lastActive: at(0), idleRemindedAt: at(45), now: at(46), graceMinutes: -3 }).verdict, 'NONE');
  assert.equal(idle.idleMinutesOf(9), 45);
  assert.equal(idle.idleMinutesOf(480), 480);
  assert.equal(idle.idleGraceOf(121), 15);
  assert.equal(idle.idleGraceOf(5), 5);
});

test('حدود الإعدادات: ١٠–٤٨٠ و٥–١٢٠ أعداداً صحيحة برسالةٍ عربية، والغائب لا يُفحص', () => {
  for (const ok of [{}, { idlePunchOutMinutes: 10 }, { idlePunchOutMinutes: 480 }, { idlePunchOutGraceMinutes: 5 }, { idlePunchOutGraceMinutes: 120 },
    { idlePunchOutMinutes: 45, idlePunchOutGraceMinutes: 15 }]) {
    assert.equal(idle.idleSettingsError(ok), null, JSON.stringify(ok));
  }
  for (const bad of [{ idlePunchOutMinutes: 9 }, { idlePunchOutMinutes: 481 }, { idlePunchOutMinutes: 45.5 }, { idlePunchOutMinutes: '45' }, { idlePunchOutMinutes: null }]) {
    assert.match(idle.idleSettingsError(bad as any) ?? '', /دقائق الخمول قبل التذكير.*10.*480/, JSON.stringify(bad));
  }
  for (const bad of [{ idlePunchOutGraceMinutes: 4 }, { idlePunchOutGraceMinutes: 121 }, { idlePunchOutGraceMinutes: Number.NaN }]) {
    assert.match(idle.idleSettingsError(bad) ?? '', /مهلة الرد قبل الانصراف التلقائي.*5.*120/, JSON.stringify(bad));
  }
});

test('نقاط الخلفية: الساكن بانجرافه ليس حركة، والانتقال حركةٌ بوقته، والنقطة الرخوة لا تُحسب، والمسح يُكمَل', () => {
  const p = (m: number, dLat: number, accuracy: number | null = 10) => ({ lat: 24.7 + dLat, lng: 46.7, accuracy, at: at(m) });
  // انجراف ~٣٠ م ذهاباً وإياباً
  assert.equal(idle.scanMoves([p(0, 0), p(1, 0.0003), p(2, -0.0002), p(3, 0.0001)]).lastMove, null);
  // انتقال ~٣٣٠ م عند الدقيقة ٥، ثم سكونٌ هناك
  const s = idle.scanMoves([p(0, 0), p(1, 0.0001), p(5, 0.003), p(6, 0.0031)]);
  assert.equal(s.lastMove!.getTime(), at(5).getTime());
  // قفزة شبكةٍ خلوية رخوة الدقّة لا تشهد بحركة
  assert.equal(idle.scanMoves([p(0, 0), p(1, 0.01, 800)]).lastMove, null);
  // هامشا الخطأ معاً: ~١٩٠ م بين نقطتين دقّتهما ٩٠ و٩٠ (المجموع ١٨٠) حركة، وبدقّة ١٠٠ و١٠٠ (٢٠٠) ليست حركة
  assert.ok(idle.scanMoves([p(0, 0, 90), p(1, 0.0017, 90)]).lastMove);
  assert.equal(idle.scanMoves([p(0, 0, 100), p(1, 0.0017, 100)]).lastMove, null);
  // الإكمال من حالةٍ سابقة (القراءة التزايدية)
  const first = idle.scanMoves([p(0, 0), p(1, 0.0001)]);
  assert.equal(idle.scanMoves([p(9, 0.004)], first).lastMove!.getTime(), at(9).getTime());
  // وقت النقطة بساعة الخادم: لحظة التقاطها محصورةً بين [الاستلام − ٥د، الاستلام]
  assert.equal(idle.pointActivityAt(at(10), at(8)).getTime(), at(8).getTime(), 'ساعة جهازٍ متقدّمة لا تمدّ النشاط إلى المستقبل');
  assert.equal(idle.pointActivityAt(at(10), at(11)).getTime(), at(10).getTime(), 'رفعٌ عاديّ بعد دقيقة: لحظة الالتقاط');
  assert.equal(idle.pointActivityAt(at(7), at(10)).getTime(), at(7).getTime());
  assert.equal(idle.pointActivityAt(at(-50), at(10)).getTime(), at(5).getTime(), 'ساعة جهازٍ متأخّرة ساعةً: لا تُقدَّم الحركة أكثر من ٥د');
  assert.equal(idle.IDLE_UPLOAD_LAG_MS, 5 * MIN);
});

test('الإشعار: نصّ التذكير بلغة الجهاز ودقائق المندوب، والعربية افتراضاً، وشاشة البصمة', () => {
  const ar = idle.idleRemindPayload('ar', 45);
  assert.equal(ar.body, 'لم يُرصد نشاط منذ 45 دقيقة — سجّل بصمة الانصراف إن انتهى عملك');
  assert.equal(ar.url, '/rep?screen=attendance');
  assert.equal(idle.idleRemindPayload(null, 60).body, 'لم يُرصد نشاط منذ 60 دقيقة — سجّل بصمة الانصراف إن انتهى عملك');
  assert.equal(idle.idleRemindPayload('xx', 45).title, ar.title);
  assert.match(idle.idleRemindPayload('en', 30).body, /No activity for 30 minutes/);
  assert.equal(idle.idleAutoOutPayload('ar').title, 'انصراف تلقائي');
  assert.equal(idle.idleAutoOutPayload('en').tag, ar.tag, 'الوسم نفسه فيحلّ محلّ التذكير');
  // مصطلحات التطبيق نفسها (web-admin/src/i18n/strings.ts): «انصراف تلقائي» و«هل ما زلت تعمل؟» و«بصمة الانصراف»
  assert.equal(idle.idleRemindPayload('en', 45).body, 'No activity for 45 minutes — check out if your work is done');
  assert.equal(idle.idleAutoOutPayload('en').title, 'Automatic check-out');
  assert.equal(idle.idleRemindPayload('fr', 45).title, 'Travaillez-vous toujours ?');
  assert.equal(idle.idleAutoOutPayload('fr').title, 'Sortie automatique');
  assert.equal(idle.idleAutoOutPayload('tr').title, 'Otomatik çıkış');
  assert.equal(idle.idleAutoOutPayload('zh').title, '自动签退');
  assert.match(idle.idleRemindPayload('zh', 45).body, /签退/);
  for (const l of ['en', 'fr', 'tr', 'zh']) {
    assert.doesNotMatch(`${idle.idleRemindPayload(l, 45).body} ${idle.idleAutoOutPayload(l).body}`, /punch|Départ|départ|打卡/, l);
  }
});

test('التذكير المعلّق للتطبيق: للمفعّل وحده، داخل المهلة وهامشها', () => {
  const r = { idlePunchOutEnabled: true, idlePunchOutMinutes: 45, idlePunchOutGraceMinutes: 15 };
  const p = idle.pendingIdleOf(r, at(0), at(3))!;
  assert.deepEqual({ ...p, serverNow: 0 }, { remindedAt: at(0).toISOString(), idleMinutes: 45, graceMinutes: 15, serverNow: 0 });
  assert.ok(idle.pendingIdleOf(r, at(0), at(17)));
  assert.equal(idle.pendingIdleOf(r, at(0), at(18)), null, 'بعد المهلة وهامش دورتين');
  assert.equal(idle.pendingIdleOf({ ...r, idlePunchOutEnabled: false }, at(0), at(3)), null);
  assert.equal(idle.pendingIdleOf(r, null, at(3)), null);
  assert.equal(idle.pendingIdleOf(r, at(5), at(3)), null, 'تذكيرٌ في المستقبل');
});

// ═══ (٢) الدورة فوق Prisma مزيّف ═══

test('الدورة: تذكيرٌ واحد لكل فترة خمول — بإشعارٍ بلغة الجهاز وصلاحيته مهلة الردّ', async () => {
  reps = [rep({ id: 'r1', lastSeenAt: at(5), lang: 'ar' })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: T0 })];
  assert.deepEqual(await idle.runIdlePunchOut(at(5 + 44)), { reminded: 0, autoOut: 0 });
  assert.equal(pushes.length, 0);
  assert.deepEqual(await idle.runIdlePunchOut(at(50)), { reminded: 1, autoOut: 0 });
  assert.equal(shifts[0].idleRemindedAt!.getTime(), at(50).getTime());
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].repId, 'r1');
  assert.equal(pushes[0].payload.body, 'لم يُرصد نشاط منذ 45 دقيقة — سجّل بصمة الانصراف إن انتهى عملك');
  assert.equal(pushes[0].ttlSec, 15 * 60);
  // الدورات التالية داخل المهلة: لا تذكير ثانٍ
  assert.deepEqual(await idle.runIdlePunchOut(at(51)), { reminded: 0, autoOut: 0 });
  assert.deepEqual(await idle.runIdlePunchOut(at(64)), { reminded: 0, autoOut: 0 });
  assert.equal(pushes.length, 1);
  assert.equal(shifts[0].checkOutAt, null);
  // والاستعلام يرشّح المؤهّلين في القاعدة: القيد مفعّل، والمندوب والشركة نشطان والبصمة مفعّلة
  assert.ok(calls.includes('salesRep.findMany'));
});

test('الدورة: بلا ردٍّ خلال المهلة ⇒ انصرافٌ تلقائي بوقت آخر نشاط، موسومٌ وبسطر تدقيق «النظام» تحت القفل', async () => {
  reps = [rep({ id: 'r1', lastSeenAt: at(5) })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: T0 })];
  await idle.runIdlePunchOut(at(50));
  assert.deepEqual(await idle.runIdlePunchOut(at(64)), { reminded: 0, autoOut: 0 });
  assert.deepEqual(await idle.runIdlePunchOut(at(65)), { reminded: 0, autoOut: 1 });
  const s = shifts[0];
  assert.equal(s.checkOutAt!.getTime(), at(5).getTime(), 'وقت آخر نشاط لا وقت الدورة');
  assert.equal(s.checkOutAuto, true);
  assert.equal(s.editedBy, 'النظام');
  assert.equal(s.editedAt!.getTime(), at(65).getTime(), 'ختم لحظة القرار — تلتقطه المزامنة');
  assert.deepEqual(locks, ['rep-attendance:r1']);
  assert.equal(audits.length, 1);
  const a = audits[0];
  assert.equal(a.action, 'AUTO_CHECKOUT');
  assert.equal(a.reason, 'انصراف تلقائي بعد خمول');
  assert.equal(a.actorId, 'system');
  assert.equal(a.actorName, 'النظام');
  assert.equal(a.attendanceId, 's1');
  assert.equal(a.salesRepId, 'r1');
  assert.deepEqual(a.before, { checkInAt: T0.toISOString(), checkOutAt: null });
  assert.equal(a.after.checkOutAt, at(5).toISOString());
  assert.equal(a.after.idleRemindedAt, at(50).toISOString());
  // إشعار الانصراف التلقائي بعد التذكير
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1].payload.title, 'انصراف تلقائي');
  // النوبة أُغلقت: لا شيء بعدها
  assert.deepEqual(await idle.runIdlePunchOut(at(200)), { reminded: 0, autoOut: 0 });
  assert.equal(audits.length, 1);
  // وتقرير الساعات يسمها «انصراف تلقائي» ولا يعدّ ختم النظام تعديلاً إدارياً
  const days = workDay.attendanceByDay([{ ...s, source: 'APP' }], 180);
  const period = [...days.values()][0].periods[0];
  assert.equal(period.outAuto, true);
  assert.equal(period.edited, false);
});

test('الدورة: نشاطٌ بعد التذكير يلغي الانصراف ويبدأ دورةً جديدة كاملة', async () => {
  reps = [rep({ id: 'r1', lastSeenAt: at(5) })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: T0 })];
  await idle.runIdlePunchOut(at(50));
  reps[0].lastSeenAt = at(55); // فتح التطبيق من الإشعار (نبضة)
  assert.deepEqual(await idle.runIdlePunchOut(at(66)), { reminded: 0, autoOut: 0 });
  assert.deepEqual(await idle.runIdlePunchOut(at(99)), { reminded: 0, autoOut: 0 });
  assert.equal(shifts[0].checkOutAt, null);
  assert.deepEqual(await idle.runIdlePunchOut(at(100)), { reminded: 1, autoOut: 0 });
  assert.equal(shifts[0].idleRemindedAt!.getTime(), at(100).getTime());
  assert.deepEqual(await idle.runIdlePunchOut(at(115)), { reminded: 0, autoOut: 1 });
  assert.equal(shifts[0].checkOutAt!.getTime(), at(55).getTime());
});

test('الدورة: نشاطٌ يصل بين الحكم والقفل يمنع الانصراف (الفحص يُعاد تحت القفل)', async () => {
  reps = [rep({ id: 'r1', lastSeenAt: at(5) })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: T0 })];
  await idle.runIdlePunchOut(at(50));
  onLock = () => { reps[0].lastSeenAt = at(64.9); };
  assert.deepEqual(await idle.runIdlePunchOut(at(65)), { reminded: 0, autoOut: 0 });
  assert.equal(shifts[0].checkOutAt, null);
  assert.equal(audits.length, 0);
  // وانصرافٌ يدويّ أو «ما زلت أعمل» بعد الحكم (التذكير مُسح): لا انصراف تلقائي
  onLock = () => { shifts[0].idleRemindedAt = null; };
  reps[0].lastSeenAt = at(5);
  assert.deepEqual(await idle.runIdlePunchOut(at(66)), { reminded: 0, autoOut: 0 });
  assert.equal(shifts[0].checkOutAt, null);
});

test('الدورة: نقاط الخلفية الساكنة ليست نشاطاً، وحركتها نشاطٌ يؤخّر التذكير', async () => {
  reps = [rep({ id: 'still', lastSeenAt: T0 }), rep({ id: 'moving', lastSeenAt: T0 })];
  shifts = [shift({ id: 'a', salesRepId: 'still', checkInAt: T0 }), shift({ id: 'b', salesRepId: 'moving', checkInAt: T0 })];
  for (let m = 0; m <= 44; m++) {
    // الساكن: نقطةٌ كل دقيقة بانجرافٍ صغير
    locs.push({ tenantId: TENANT, salesRepId: 'still', lat: 24.7 + (m % 2) * 0.0002, lng: 46.7, accuracy: 15, capturedAt: at(m), createdAt: at(m), source: 'device' });
    // المتحرّك: ينتقل ~٣٣٠ م عند الدقيقة ٣٠
    locs.push({ tenantId: TENANT, salesRepId: 'moving', lat: m >= 30 ? 24.703 : 24.7, lng: 46.7, accuracy: 15, capturedAt: at(m), createdAt: at(m), source: 'device' });
  }
  // ونقطة صفحةٍ (لا مصدر) لا تُقرأ هنا — «آخر ظهور» يمثّلها
  locs.push({ tenantId: TENANT, salesRepId: 'still', lat: 25, lng: 47, accuracy: 5, capturedAt: at(40), createdAt: at(40), source: null });
  assert.deepEqual(await idle.runIdlePunchOut(at(45)), { reminded: 1, autoOut: 0 });
  assert.deepEqual(pushes.map((p) => p.repId), ['still']);
  assert.equal(shifts[1].idleRemindedAt, null);
  // الساكن يُصرف بعد مهلته (٦٠) بوقت حضوره — لا نشاط بعده؛ والمتحرّك لم يُذكَّر بعد
  assert.deepEqual(await idle.runIdlePunchOut(at(74)), { reminded: 0, autoOut: 1 });
  assert.equal(shifts[0].checkOutAt!.getTime(), T0.getTime());
  assert.equal(shifts[1].idleRemindedAt, null);
  // المتحرّك: آخر حركة ٣٠ ⇒ تذكيره عند ٧٥ (والقراءة تزايدية بعد الأولى)
  assert.deepEqual(await idle.runIdlePunchOut(at(75)), { reminded: 1, autoOut: 0 });
  assert.equal(shifts[1].idleRemindedAt!.getTime(), at(75).getTime());
});

test('الدورة: جوالٌ ساعته متأخّرة ساعةً ومندوبه يقود طوال الوقت — لا تذكير ولا انصراف (ساعة الخادم هي الحَكَم)', async () => {
  reps = [rep({ id: 'driver', lastSeenAt: T0 })];
  shifts = [shift({ id: 'd', salesRepId: 'driver', checkInAt: T0 })];
  const seen: { reminded: number; autoOut: number }[] = [];
  for (let m = 0; m <= 150; m++) {
    // ينتقل ~٣٣٠ م كل دقيقة، والتطبيق في الخلفية (لا آخر ظهور)، وساعة الجوال متأخّرة ٦٠ دقيقة عن الخادم
    locs.push({ tenantId: TENANT, salesRepId: 'driver', lat: 24.7 + m * 0.003, lng: 46.7, accuracy: 10, capturedAt: at(m - 60), createdAt: at(m), source: 'device' });
    if (m >= 45 && m % 5 === 0) seen.push(await idle.runIdlePunchOut(at(m)));
  }
  assert.ok(seen.length > 10);
  assert.ok(seen.every((r) => r.reminded === 0 && r.autoOut === 0), JSON.stringify(seen));
  assert.equal(shifts[0].idleRemindedAt, null);
  assert.equal(shifts[0].checkOutAt, null);
  assert.equal(pushes.length, 0);
  // ثم يتوقّف (نقاطٌ ساكنة): التذكير بعد خمولٍ كامل من آخر حركةٍ بوقت استلامها (لا بساعة الجوال)
  for (let m = 151; m <= 200; m++) {
    locs.push({ tenantId: TENANT, salesRepId: 'driver', lat: 24.7 + 150 * 0.003, lng: 46.7, accuracy: 10, capturedAt: at(m - 60), createdAt: at(m), source: 'device' });
  }
  // آخر حركة: استُلمت عند ١٥٠ وتُحسب ١٤٥ (الاستلام − ٥د) ⇒ التذكير عند ١٩٠ لا قبله
  assert.deepEqual(await idle.runIdlePunchOut(at(189)), { reminded: 0, autoOut: 0 });
  assert.deepEqual(await idle.runIdlePunchOut(at(190)), { reminded: 1, autoOut: 0 });
  assert.deepEqual(await idle.runIdlePunchOut(at(205)), { reminded: 0, autoOut: 1 });
  assert.equal(shifts[0].checkOutAt!.getTime(), at(145).getTime(), 'وقت الانصراف آخر حركةٍ بساعة الخادم');
});

test('الدورة: نقاط الجهاز تُقرأ بلحظة استلامها — حدٌّ رخوٌ على الالتقاط في مدى الفهرس، والترتيب والمؤشّر على createdAt', async () => {
  reps = [rep({ id: 'r1', lastSeenAt: T0 })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: T0 })];
  const wheres: any[] = [];
  const orig = handlers['repLocation.findMany'];
  handlers['repLocation.findMany'] = (a) => { wheres.push({ where: a.where, orderBy: a.orderBy }); return orig(a); };
  try {
    await idle.runIdlePunchOut(at(45));
    await idle.runIdlePunchOut(at(46));
  } finally {
    handlers['repLocation.findMany'] = orig;
  }
  assert.equal(wheres.length, 2);
  const [first, next] = wheres;
  assert.equal(first.where.source, 'device');
  assert.equal(first.where.capturedAt.gte.getTime(), T0.getTime() - idle.IDLE_SKEW_WINDOW_MS);
  assert.equal(first.where.createdAt.gte.getTime(), T0.getTime(), 'القراءة الأولى: ما استُلم منذ الأرضيّة');
  assert.deepEqual(first.orderBy, [{ createdAt: 'desc' }, { capturedAt: 'desc' }]);
  assert.ok(next.where.createdAt.gt instanceof Date, 'ثم تزايدية بعد آخر استلامٍ قُرئ');
});

test('الدورة: المطفأ والمعطّل والنوبة القديمة لا تُمسّ ولو أعادتهم القاعدة (حارسٌ ثانٍ)، وخطأ مندوبٍ لا يوقف غيره', async () => {
  honorWhere = false;
  reps = [
    rep({ id: 'off', idlePunchOutEnabled: false, lastSeenAt: at(0) }),
    rep({ id: 'inactive', isActive: false, lastSeenAt: at(0) }),
    rep({ id: 'stale', lastSeenAt: at(-9 * 24 * 60) }),
    rep({ id: 'broken', lastSeenAt: at(0) }),
    rep({ id: 'ok', lastSeenAt: at(0) }),
  ];
  shifts = [
    shift({ id: 's-off', salesRepId: 'off', checkInAt: T0 }),
    shift({ id: 's-inactive', salesRepId: 'inactive', checkInAt: T0 }),
    shift({ id: 's-stale', salesRepId: 'stale', checkInAt: at(-9 * 24 * 60) }),
    shift({ id: 's-broken', salesRepId: 'broken', checkInAt: T0 }),
    shift({ id: 's-ok', salesRepId: 'ok', checkInAt: T0 }),
  ];
  failLocFor = 'broken';
  const r = await idle.runIdlePunchOut(at(300));
  assert.deepEqual(r, { reminded: 1, autoOut: 0 });
  assert.deepEqual(pushes.map((p) => p.repId), ['ok']);
  assert.deepEqual(shifts.filter((s) => s.idleRemindedAt).map((s) => s.id), ['s-ok']);
  assert.ok(shifts.every((s) => s.checkOutAt === null));
});

test('الدورة: الاستعلام يرشّح المؤهّلين — المفعّل النشط في شركةٍ نشطة مفعّلةٍ بصمتها، والنوبات المفتوحة خلال ٧ أيام', async () => {
  let where: any = null;
  const orig = handlers['salesRep.findMany'];
  handlers['salesRep.findMany'] = (a) => { where = a.where; return []; };
  try {
    await idle.runIdlePunchOut(T0);
  } finally {
    handlers['salesRep.findMany'] = orig;
  }
  assert.equal(where.idlePunchOutEnabled, true);
  assert.equal(where.isActive, true);
  assert.deepEqual(where.tenant, { attendanceEnabled: true, isActive: true });
  assert.equal(where.attendance.some.checkOutAt, null);
  assert.equal(where.attendance.some.checkInAt.gte.getTime(), T0.getTime() - 7 * 24 * 60 * MIN);
});

// ═══ (٣) إعدادات المندوب في /api/sales-reps ═══

const NEW_REP = { name: 'خالد', phone: '0551234567', username: 'khalid.rep', password: 'Rep2026secure' };

test('الإعدادات: المدّتان خارج حدّيهما 400 IDLE_PUNCH_OUT_RANGE برسالةٍ عربية — إنشاءً وتعديلاً، ولا كتابة', async () => {
  reps = [rep({ id: 'rep-1' })];
  for (const body of [{ idlePunchOutMinutes: 9 }, { idlePunchOutMinutes: 481 }, { idlePunchOutMinutes: 30.5 }, { idlePunchOutGraceMinutes: 4 }, { idlePunchOutGraceMinutes: 121 }]) {
    const created = await call('POST', '/api/sales-reps', { ...NEW_REP, idlePunchOutEnabled: true, ...body });
    assert.equal(created.status, 400, JSON.stringify(body));
    assert.equal(created.body.code, 'IDLE_PUNCH_OUT_RANGE');
    assert.match(created.body.message, /(دقائق الخمول قبل التذكير|مهلة الرد قبل الانصراف التلقائي)/);
    const updated = await call('PUT', '/api/sales-reps/rep-1', { idlePunchOutEnabled: true, ...body });
    assert.equal(updated.status, 400, JSON.stringify(body));
    assert.equal(updated.body.code, 'IDLE_PUNCH_OUT_RANGE');
  }
  assert.equal(repCreates.length, 0);
  assert.equal(repUpdates.length, 0);
});

test('الإعدادات: السليمة تُكتب كما أُرسلت، وقراءة المندوب تحملها', async () => {
  reps = [rep({ id: 'rep-1', idlePunchOutEnabled: false })];
  const created = await call('POST', '/api/sales-reps', { ...NEW_REP, idlePunchOutEnabled: true, idlePunchOutMinutes: 10, idlePunchOutGraceMinutes: 120 });
  assert.equal(created.status, 201);
  assert.equal(repCreates[0].data.idlePunchOutEnabled, true);
  assert.equal(repCreates[0].data.idlePunchOutMinutes, 10);
  assert.equal(repCreates[0].data.idlePunchOutGraceMinutes, 120);
  const updated = await call('PUT', '/api/sales-reps/rep-1', { idlePunchOutEnabled: true, idlePunchOutMinutes: 480, idlePunchOutGraceMinutes: 5 });
  assert.equal(updated.status, 200);
  const data = repUpdates.at(-1).data;
  assert.equal(data.idlePunchOutEnabled, true);
  assert.equal(data.idlePunchOutMinutes, 480);
  assert.equal(data.idlePunchOutGraceMinutes, 5);
  // الإطفاء وحده لا يمسّ المدّتين المحفوظتين
  await call('PUT', '/api/sales-reps/rep-1', { idlePunchOutEnabled: false });
  assert.equal(repUpdates.at(-1).data.idlePunchOutEnabled, false);
  assert.ok(!('idlePunchOutMinutes' in repUpdates.at(-1).data));
  // القائمة والتفاصيل
  repSelects = [];
  await call('GET', '/api/sales-reps');
  await call('GET', '/api/sales-reps/rep-1');
  assert.equal(repSelects.length, 2);
  for (const sel of repSelects) {
    assert.equal(sel.idlePunchOutEnabled, true);
    assert.equal(sel.idlePunchOutMinutes, true);
    assert.equal(sel.idlePunchOutGraceMinutes, true);
  }
});

test('الإعدادات: إطفاء المفتاح ثم إعادته يمحو تذكير النوبة المفتوحة — أوّل حكمٍ بعدها تذكيرٌ جديد لا انصرافٌ صامت', async () => {
  // تذكيرٌ أُرسل عند ٥٠ ولا نشاط بعده، ثم أطفأت الإدارة القيد وأعادته بعد ساعات
  reps = [rep({ id: 'r1', lastSeenAt: at(5) })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: T0, idleRemindedAt: at(50) })];
  assert.equal((await call('PUT', '/api/sales-reps/r1', { idlePunchOutEnabled: false })).status, 200);
  assert.equal(reps[0].idlePunchOutEnabled, false);
  assert.equal(shifts[0].idleRemindedAt, null, 'الإطفاء يمحو التذكير');
  shifts[0].idleRemindedAt = at(50); // ولو بقي تذكيرٌ قديم (سبقت الدورةُ المحوَ)
  assert.equal((await call('PUT', '/api/sales-reps/r1', { idlePunchOutEnabled: true })).status, 200);
  assert.equal(reps[0].idlePunchOutEnabled, true);
  assert.equal(shifts[0].idleRemindedAt, null, 'إعادة التفعيل تمحو التذكير');
  assert.deepEqual(await idle.runIdlePunchOut(at(300)), { reminded: 1, autoOut: 0 });
  assert.equal(shifts[0].checkOutAt, null);
  assert.equal(pushes.length, 1);
  // وحفظٌ لا يبدّل المفتاح (المفعّل يبقى مفعّلاً، أو تعديل الدقائق وحدها) لا يمسّ تذكيراً قائماً
  assert.equal((await call('PUT', '/api/sales-reps/r1', { idlePunchOutEnabled: true, idlePunchOutMinutes: 60 })).status, 200);
  assert.equal(shifts[0].idleRemindedAt!.getTime(), at(300).getTime());
  assert.equal((await call('PUT', '/api/sales-reps/r1', { name: 'خالد' })).status, 200);
  assert.equal(shifts[0].idleRemindedAt!.getTime(), at(300).getTime());
  // والنوبات المغلقة لا تُمسّ
  shifts.push(shift({ id: 's0', salesRepId: 'r1', checkInAt: at(-600), checkOutAt: at(-300), idleRemindedAt: at(-400) }));
  await call('PUT', '/api/sales-reps/r1', { idlePunchOutEnabled: false });
  assert.equal(shifts[1].idleRemindedAt!.getTime(), at(-400).getTime());
});

// ═══ (٤) تطبيق المندوب: النبضة و/attendance/today و«ما زلت أعمل» ═══

const REP_USER: User = { id: 'r1', role: 'SALES_REP', tenantId: TENANT, name: 'خالد' };
const ago = (m: number) => new Date(Date.now() - m * MIN);

test('النبضة: idlePunchOutReminder حاضرٌ دائماً — التذكير المعلّق للمقيَّد، وnull لغيره', async () => {
  currentUser = REP_USER;
  reps = [rep({ id: 'r1' })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: ago(120), idleRemindedAt: ago(3) })];
  const beat = await call('POST', '/api/tracking/heartbeat', {});
  assert.equal(beat.status, 200);
  const r = beat.body.data.idlePunchOutReminder;
  assert.equal(r.remindedAt, shifts[0].idleRemindedAt!.toISOString());
  assert.equal(r.idleMinutes, 45);
  assert.equal(r.graceMinutes, 15);
  assert.equal(typeof r.serverNow, 'number');
  assert.ok('presence' in beat.body.data);
  // النبضة نشاط: آخر ظهورٍ الآن
  assert.ok(Date.now() - reps[0].lastSeenAt!.getTime() < 5000);
  // المطفأ: null (لا قراءة للتذكير)
  reps[0].idlePunchOutEnabled = false;
  assert.equal((await call('POST', '/api/tracking/heartbeat', {})).body.data.idlePunchOutReminder, null);
  // تذكيرٌ فاتت مهلته وهامشها: null
  reps[0].idlePunchOutEnabled = true;
  shifts[0].idleRemindedAt = ago(30);
  assert.equal((await call('POST', '/api/tracking/heartbeat', {})).body.data.idlePunchOutReminder, null);
});

test('/attendance/today: النوبة المفتوحة تحمل التذكير المعلّق، والمغلقة تلقائياً تحمل checkOutAuto', async () => {
  currentUser = REP_USER;
  reps = [rep({ id: 'r1' })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: ago(90), idleRemindedAt: ago(2) })];
  const open = await call('GET', '/api/tracking/attendance/today?tzOffsetMin=180');
  assert.equal(open.body.data.status, 'in');
  assert.equal(open.body.data.idlePunchOutReminder.remindedAt, shifts[0].idleRemindedAt!.toISOString());
  Object.assign(shifts[0], { checkOutAt: ago(60), checkOutAuto: true, editedAt: ago(1), editedBy: 'النظام' });
  const closed = await call('GET', '/api/tracking/attendance/today?tzOffsetMin=180');
  assert.equal(closed.body.data.status, 'out');
  assert.equal(closed.body.data.last.checkOutAuto, true);
  assert.equal(closed.body.data.shifts[0].checkOutAuto, true);
});

test('«ما زلت أعمل»: يمحو التذكير ويكتب نشاطاً تحت القفل؛ وبعد انصرافٍ تلقائي 409 NO_OPEN_SHIFT ومعه autoCheckedOut', async () => {
  currentUser = REP_USER;
  reps = [rep({ id: 'r1', lastSeenAt: ago(50) })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: ago(120), idleRemindedAt: ago(5) })];
  const ok = await call('POST', '/api/tracking/attendance/still-working', {});
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.status, 'in');
  assert.equal(ok.body.data.idlePunchOutReminder, null);
  assert.equal(shifts[0].idleRemindedAt, null);
  assert.ok(Date.now() - reps[0].lastSeenAt!.getTime() < 5000);
  assert.deepEqual(locks, ['rep-attendance:r1']);
  // ثمّ الدورة: لا تذكير ولا انصراف حتى خمولٍ جديدٍ كامل
  assert.deepEqual(await idle.runIdlePunchOut(new Date()), { reminded: 0, autoOut: 0 });

  // سبقه الانصراف التلقائي
  Object.assign(shifts[0], { checkOutAt: ago(60), checkOutAuto: true, editedAt: ago(1), editedBy: 'النظام' });
  const late = await call('POST', '/api/tracking/attendance/still-working', {});
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'NO_OPEN_SHIFT');
  assert.equal(late.body.autoCheckedOut, true);
  assert.equal(late.body.last.checkOutAuto, true);
  assert.match(late.body.message, /تلقائياً/);
  // انصرافٌ تلقائي قديم (قبل أيام) لا يُنسب إليه الردّ، ولا انصرافٌ يدوي
  shifts[0].editedAt = ago(3 * 24 * 60);
  assert.equal((await call('POST', '/api/tracking/attendance/still-working', {})).body.autoCheckedOut, false);
  Object.assign(shifts[0], { checkOutAuto: false, editedAt: null });
  const manual = await call('POST', '/api/tracking/attendance/still-working', {});
  assert.equal(manual.status, 409);
  assert.equal(manual.body.code, 'NO_OPEN_SHIFT');
  assert.equal(manual.body.autoCheckedOut, false);
});
