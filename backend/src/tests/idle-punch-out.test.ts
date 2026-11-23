// «تذكير بالانصراف عند الخمول ثم انصراف تلقائي» (طلب المالك، ٢٣ نوفمبر ٢٠٢٦) — services/idlePunchOut.ts والمسارات الحقيقية
// (/api/sales-reps و/api/tracking) فوق Prisma مزيّف في الذاكرة — بلا قاعدة ولا شبكة. يثبت قرار المالك بمرحلتيه:
//   • قبل التذكير كلّ نشاطٍ يُحسب: النبضة (آخر ظهور) وأيّ نقطة موقعٍ تصل من جواله — الخلفية والصفحة، ساكنةً أو متحرّكة — بلحظة
//     استلامها في الخادم؛ فلا تذكير إلا بلا استخدامٍ للتطبيق ولا موقعٍ يصل منه طوال دقائق الخمول، ويُختم معه آخر نشاطٍ سبقه.
//   • بعد التذكير لا يلغي الانصراف إلا «ما زلت أعمل» أو تنقّلٌ فعلي (> ١٥٠ م وفوق هامشَي الخطأ، استُلم بعد التذكير بساعة الخادم
//     ولو التُقط قبله) أو مستندٌ أصدره المندوب (فاتورة أو مرتجع أو سند أو زيارة) — والنبضة والنقاط الساكنة بعده لا تلغيه. ما ألغاه
//     يمحوه وتبدأ دورةٌ جديدة من لحظته.
//   • بلا شيءٍ منها حتى المهلة ⇒ انصرافٌ تلقائي بوقت آخر نشاطٍ سبق التذكير، موسومٌ checkOutAuto وبسطر تدقيق AUTO_CHECKOUT
//     باسم «النظام» تحت قفل بصمات المندوب (ومستندٌ يصل حينها يُفحص تحت القفل).
//   • إعدادات المندوب: المدّتان خارج حدّيهما 400 IDLE_PUNCH_OUT_RANGE برسالةٍ عربية، والسليمة تُكتب وتُقرأ.
//   • ردّ النبضة و/attendance/today يحملان idlePunchOutReminder ببيانات العدّ التنازليّ (remindedAt وgraceMinutes وserverNow)،
//     و«ما زلت أعمل» يمحو التذكير ويكتب نشاطاً، وبعد انصرافٍ تلقائي 409 NO_OPEN_SHIFT ومعه autoCheckedOut.
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  id: string; tenantId: string; salesRepId: string; checkInAt: Date; checkOutAt: Date | null; idleRemindedAt: Date | null; idleLastActiveAt: Date | null;
  checkOutAuto: boolean; editedAt: Date | null; editedBy: string | null; checkInLat: number | null; checkInLng: number | null;
  checkInOutside: boolean | null; checkInDistanceM: number | null; checkOutOutside: boolean | null;
};
type Loc = { tenantId: string; salesRepId: string; lat: number; lng: number; accuracy: number | null; capturedAt: Date; createdAt: Date; source: string | null };
/** مستندات المندوب: الفواتير والمرتجعات (type) والسندات بتاريخ المستند ولحظة الإنشاء في الخادم، والزيارات بلحظة الجهاز ولحظة الوصول */
type Inv = { tenantId: string; salesRepId: string | null; type: string; invoiceDate: Date; createdAt: Date };
type Rcp = { tenantId: string; salesRepId: string | null; receiptDate: Date; createdAt: Date };
type Vis = { tenantId: string; salesRepId: string; createdAt: Date; receivedAt: Date };

let reps: Rep[] = [];
let shifts: Shift[] = [];
let locs: Loc[] = [];
let invoices: Inv[] = [];
let receipts: Rcp[] = [];
let visits: Vis[] = [];
/** استعلامات المستندات كما وصلت (where) — لفحص بقائها في مدى فهرس */
let docWheres: { model: string; where: any }[] = [];
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
  tenantId: TENANT, checkOutAt: null, idleRemindedAt: null, idleLastActiveAt: null, checkOutAuto: false, editedAt: null, editedBy: null,
  checkInLat: null, checkInLng: null, checkInOutside: null, checkInDistanceM: null, checkOutOutside: null, ...o,
});

const val = (x: unknown) => (x instanceof Date ? x.getTime() : x);
function matchWhere(row: Record<string, any>, where: Record<string, any> | undefined): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === 'OR') { if (!(v as any[]).some((w) => matchWhere(row, w))) return false; continue; }
    if (k === 'AND') { if (!(v as any[]).every((w) => matchWhere(row, w))) return false; continue; }
    // مرشّح العلاقة إلى المندوب (salesRep: { is: … }) كما يكتبه حجز التذكير
    if (k === 'salesRep' && v && typeof v === 'object' && 'is' in v) {
      const r = reps.find((x) => x.id === row.salesRepId);
      if (!r || !matchWhere(r, v.is)) return false;
      continue;
    }
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
            .slice(0, 1).map((s) => ({ id: s.id, checkInAt: s.checkInAt, idleRemindedAt: s.idleRemindedAt, idleLastActiveAt: s.idleLastActiveAt })),
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
  'invoice.findFirst': (a) => {
    docWheres.push({ model: 'invoice', where: a.where });
    const l = sortBy(invoices.filter((x) => matchWhere(x, a.where)), a.orderBy);
    return l[0] ? pick(l[0], a.select) : null;
  },
  'receipt.findFirst': (a) => {
    docWheres.push({ model: 'receipt', where: a.where });
    const l = sortBy(receipts.filter((x) => matchWhere(x, a.where)), a.orderBy);
    return l[0] ? pick(l[0], a.select) : null;
  },
  'repVisit.findFirst': (a) => {
    docWheres.push({ model: 'repVisit', where: a.where });
    const l = sortBy(visits.filter((x) => matchWhere(x, a.where)), a.orderBy);
    return l[0] ? pick(l[0], a.select) : null;
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
  reps = []; shifts = []; locs = []; invoices = []; receipts = []; visits = []; docWheres = []; audits = []; pushes = []; locks = []; calls = [];
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
/** نتيجة الدورة: لا شيء، أو ما تغيّر منه */
const R0 = { reminded: 0, autoOut: 0, cancelled: 0 };
const res = (o: Partial<typeof R0>) => ({ ...R0, ...o });
/** نقطة موقعٍ للمندوب عند الدقيقة m (التقاطاً واستلاماً) — dLat ٠٫٠٠٣ ≈ ٣٣٠ م، و٠٫٠٠٠٢ ≈ ٢٢ م انجراف */
const loc = (repId: string, m: number, dLat = 0, o: Partial<Loc> = {}): Loc => ({
  tenantId: TENANT, salesRepId: repId, lat: 24.7 + dLat, lng: 46.7, accuracy: 15, capturedAt: at(m), createdAt: at(m), source: 'device', ...o,
});

// ═══ (١) الحكم الصرف ═══

test('الحكم: لا شيء قبل دقائق الخمول، وتذكيرٌ عند بلوغها بالضبط', () => {
  assert.equal(decide({ lastActive: at(10), now: at(10 + 44) }).verdict, 'NONE');
  assert.equal(decide({ lastActive: at(10), now: at(10 + 44.99) }).verdict, 'NONE');
  const d = decide({ lastActive: at(10), now: at(10 + 45) });
  assert.equal(d.verdict, 'REMIND');
  assert.equal(d.checkOutAt, null);
  assert.equal(d.lastActive.getTime(), at(10).getTime(), 'يُختم مع التذكير');
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
  // والانصراف التلقائي بلا أيّ نشاطٍ بعد الحضور = لحظة الحضور، لا قبلها (ولو خُتم التذكير بما قبله)
  const out = decide({ lastActive: at(-300), idleRemindedAt: at(45), remindedActiveAt: at(-300), now: at(60) });
  assert.equal(out.verdict, 'AUTO_OUT');
  assert.equal(out.checkOutAt!.getTime(), T0.getTime());
  // ونشاطٌ «في المستقبل» (ساعةٌ منحرفة) لا يتجاوز الآن
  assert.equal(decide({ lastActive: at(500), now: at(50) }).lastActive.getTime(), at(50).getTime());
});

test('الحكم: الانصراف التلقائي بعد المهلة بالضبط وبوقت آخر نشاطٍ سبق التذكير — لا بوقت الدورة', () => {
  const pend = { idleRemindedAt: at(10 + 45), remindedActiveAt: at(10) };
  assert.equal(decide({ ...pend, now: at(10 + 45 + 14) }).verdict, 'NONE');
  assert.equal(decide({ ...pend, now: new Date(at(10 + 45 + 15).getTime() - 1) }).verdict, 'NONE');
  const d = decide({ ...pend, now: at(10 + 45 + 15) });
  assert.equal(d.verdict, 'AUTO_OUT');
  assert.equal(d.checkOutAt!.getTime(), at(10).getTime(), 'وقت الانصراف = آخر نشاطٍ سبق التذكير');
  // مهلةٌ أطول لكل مندوب
  assert.equal(decide({ ...pend, now: at(10 + 45 + 15), graceMinutes: 30 }).verdict, 'NONE');
  assert.equal(decide({ ...pend, now: at(10 + 45 + 30), graceMinutes: 30 }).verdict, 'AUTO_OUT');
});

test('الحكم بعد التذكير: النبضة ونقاط الموقع (نشاطٌ أحدث منه) لا تلغيه — الانصراف بوقت آخر نشاطٍ سبقه', () => {
  const pend = { idleRemindedAt: at(55), remindedActiveAt: at(10) };
  // فتح التطبيق من الإشعار عند ٦٠ ثم كل دقيقة حتى ٦٩: آخر نشاطٍ أحدث من التذكير، والتذكير قائم
  const mid = decide({ ...pend, lastActive: at(69), now: at(69) });
  assert.equal(mid.verdict, 'NONE');
  assert.equal(mid.lastActive.getTime(), at(10).getTime());
  const d = decide({ ...pend, lastActive: at(69), now: at(70) });
  assert.equal(d.verdict, 'AUTO_OUT');
  assert.equal(d.checkOutAt!.getTime(), at(10).getTime());
});

test('الحكم: تنقّلٌ فعليّ أو مستندٌ بعد التذكير يلغيه بلحظته، وما سبقه لا يلغيه — ثم دورةٌ جديدة من لحظته', () => {
  const pend = { idleRemindedAt: at(55), remindedActiveAt: at(10) };
  const c = decide({ ...pend, cancelAt: at(58), now: at(60) });
  assert.equal(c.verdict, 'CANCEL');
  assert.equal(c.lastActive.getTime(), at(58).getTime(), 'لحظته أرضيّة الدورة الجديدة');
  assert.equal(c.checkOutAt, null);
  // ولو رُصد بعد انقضاء المهلة والنوبة مفتوحة: الإلغاء يسبق الانصراف
  assert.equal(decide({ ...pend, cancelAt: at(69), now: at(75) }).verdict, 'CANCEL');
  // ما وقع عند التذكير أو قبله لا يلغيه
  assert.equal(decide({ ...pend, cancelAt: at(55), now: at(70) }).verdict, 'AUTO_OUT');
  assert.equal(decide({ ...pend, cancelAt: at(40), now: at(70) }).verdict, 'AUTO_OUT');
  // بعد الإلغاء (لا تذكير، والختم لحظة ما ألغاه): أرضيّةٌ للنشاط — لا تذكير قبل خمولٍ كاملٍ منها
  const after = { idleRemindedAt: null, remindedActiveAt: at(58) };
  assert.equal(decide({ ...after, lastActive: at(10), now: at(58 + 44) }).verdict, 'NONE');
  const r = decide({ ...after, lastActive: at(10), now: at(58 + 45) });
  assert.equal(r.verdict, 'REMIND');
  assert.equal(r.lastActive.getTime(), at(58).getTime());
  // ونشاطٌ بعدها يؤخّره كالعادة
  assert.equal(decide({ ...after, lastActive: at(80), now: at(58 + 45) }).verdict, 'NONE');
  assert.equal(decide({ ...after, lastActive: at(80), now: at(125) }).lastActive.getTime(), at(80).getTime());
});

test('الحكم: تذكيرٌ بلا ختم آخر نشاطٍ سبقه (صفٌّ شاذّ) لا يُعدّ قائماً — لا انصرافٌ بلا وقتٍ معروف، بل تذكيرٌ جديد بختمه', () => {
  const d = decide({ lastActive: at(10), idleRemindedAt: at(55), now: at(200) });
  assert.equal(d.verdict, 'REMIND');
  assert.equal(d.lastActive.getTime(), at(10).getTime());
  assert.equal(decide({ lastActive: at(190), idleRemindedAt: at(55), now: at(200) }).verdict, 'NONE');
});

test('الحكم: المطفأ والمعطّل والنوبة المفتوحة منذ أكثر من ٧ أيام لا تُمسّ', () => {
  assert.equal(decide({ lastActive: at(10), now: at(200), enabled: false }).verdict, 'NONE');
  assert.equal(decide({ lastActive: at(10), idleRemindedAt: at(55), remindedActiveAt: at(10), now: at(200), enabled: false }).verdict, 'NONE');
  assert.equal(decide({ lastActive: at(10), idleRemindedAt: at(55), remindedActiveAt: at(10), cancelAt: at(60), now: at(200), enabled: false }).verdict, 'NONE');
  assert.equal(decide({ lastActive: at(10), now: at(200), enabled: true }).verdict, 'REMIND');
  assert.equal(decide({ lastActive: at(10), now: at(200) }).verdict, 'REMIND', 'غائبٌ = مفعّل (الاستعلام يرشّح)');
  const day = 24 * 60;
  assert.equal(decide({ checkInAt: at(-8 * day), lastActive: at(-8 * day), now: T0 }).verdict, 'NONE');
  assert.equal(decide({ checkInAt: at(-8 * day), lastActive: at(-8 * day), idleRemindedAt: at(-8 * day + 50), remindedActiveAt: at(-8 * day), now: T0 }).verdict, 'NONE');
  assert.equal(decide({ checkInAt: at(-6 * day), lastActive: at(-6 * day), now: T0 }).verdict, 'REMIND');
});

test('الحكم: مدّةٌ رفعتها الإدارة بعد التذكير لا تصرف قبل أوانها، والمخزّن الفاسد يعود للافتراض', () => {
  const pend = { idleRemindedAt: at(45), remindedActiveAt: at(0) };
  assert.equal(decide({ ...pend, now: at(60), idleMinutes: 120 }).verdict, 'NONE');
  assert.equal(decide({ ...pend, now: at(120), idleMinutes: 120 }).verdict, 'AUTO_OUT');
  assert.equal(decide({ lastActive: at(0), now: at(1), idleMinutes: 0 }).verdict, 'NONE', 'صفرٌ في القاعدة لا يذكّر بعد دقيقة');
  assert.equal(decide({ lastActive: at(0), now: at(45), idleMinutes: 0 }).verdict, 'REMIND');
  assert.equal(decide({ ...pend, now: at(46), graceMinutes: -3 }).verdict, 'NONE');
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

test('التنقّل الفعلي: الساكن بانجرافه ليس تنقّلاً، والانتقال تنقّلٌ بوقته، والنقطة الرخوة لا تُحسب، والمسح يُكمَل', () => {
  const p = (m: number, dLat: number, accuracy: number | null = 10) => ({ lat: 24.7 + dLat, lng: 46.7, accuracy, at: at(m) });
  // انجراف ~٣٠ م ذهاباً وإياباً
  assert.equal(idle.scanMoves([p(0, 0), p(1, 0.0003), p(2, -0.0002), p(3, 0.0001)]).lastMove, null);
  // انتقال ~٣٣٠ م عند الدقيقة ٥، ثم سكونٌ هناك
  const s = idle.scanMoves([p(0, 0), p(1, 0.0001), p(5, 0.003), p(6, 0.0031)]);
  assert.equal(s.lastMove!.getTime(), at(5).getTime());
  // قفزة شبكةٍ خلوية رخوة الدقّة لا تشهد بتنقّل
  assert.equal(idle.scanMoves([p(0, 0), p(1, 0.01, 800)]).lastMove, null);
  // هامشا الخطأ معاً: ~١٩٠ م بين نقطتين دقّتهما ٩٠ و٩٠ (المجموع ١٨٠) تنقّل، وبدقّة ١٠٠ و١٠٠ (٢٠٠) ليست تنقّلاً
  assert.ok(idle.scanMoves([p(0, 0, 90), p(1, 0.0017, 90)]).lastMove);
  assert.equal(idle.scanMoves([p(0, 0, 100), p(1, 0.0017, 100)]).lastMove, null);
  // الإكمال من حالةٍ سابقة (القراءة التزايدية)
  const first = idle.scanMoves([p(0, 0), p(1, 0.0001)]);
  assert.equal(idle.scanMoves([p(9, 0.004)], first).lastMove!.getTime(), at(9).getTime());
  // نقاط دفعةٍ واحدة تتشارك لحظة استلامها: التنقّل بها
  assert.equal(idle.scanMoves([p(20, 0), p(20, 0.002), p(20, 0.004)]).lastMove!.getTime(), at(20).getTime());
  assert.equal(idle.IDLE_MOVE_M, 150);
  // لا تقييد للتنقّل بلحظة الالتقاط بعد اليوم: وقته لحظة الاستلام وحدها (قرار المالك)
  assert.ok(!('pointActivityAt' in idle) && !('IDLE_UPLOAD_LAG_MS' in idle));
});

test('الإشعار: نصّ التذكير بلغة الجهاز ودقائق المندوب، والعربية افتراضاً، وشاشة البصمة', () => {
  const ar = idle.idleRemindPayload('ar', 45);
  assert.equal(ar.body, 'لم يُرصد نشاط منذ 45 دقيقة — سجّل بصمة الانصراف إن انتهى عملك');
  assert.equal(ar.url, '/rep?screen=attendance');
  assert.equal(idle.idleRemindPayload(null, 60).body, 'لم يُرصد نشاط منذ 60 دقيقة — سجّل بصمة الانصراف إن انتهى عملك');
  assert.equal(idle.idleRemindPayload('xx', 45).title, ar.title);
  assert.match(idle.idleRemindPayload('en', 30).body, /No activity for 30 minutes/);
  assert.equal(idle.idleAutoOutPayload('ar').title, 'انصراف تلقائي');
  // وقت الانصراف آخر نشاطٍ سبق التذكير — لا «آخر نشاطٍ» مطلقاً (فتح التطبيق بعده نشاطٌ لا يلغيه)
  assert.equal(idle.idleAutoOutPayload('ar').body, 'سُجّل انصرافك تلقائياً بوقت آخر نشاطٍ لك قبل التذكير — سجّل حضورك من جديد إن كنت ما زلت تعمل');
  assert.match(idle.idleAutoOutPayload('en').body, /at your last activity time before the reminder/);
  assert.match(idle.idleAutoOutPayload('fr').body, /avant le rappel/);
  assert.match(idle.idleAutoOutPayload('tr').body, /Hatırlatmadan önceki/);
  assert.match(idle.idleAutoOutPayload('zh').body, /提醒前/);
  assert.doesNotMatch(idle.idleAutoOutPayload('fr').body, /'/, 'الفرنسية بلا فاصلة علوية ASCII');
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

test('التذكير المعلّق للتطبيق: للمفعّل وحده، داخل المهلة وهامشها — ومعه بيانات العدّ التنازليّ', () => {
  const r = { idlePunchOutEnabled: true, idlePunchOutMinutes: 45, idlePunchOutGraceMinutes: 15 };
  const p = idle.pendingIdleOf(r, at(0), at(3))!;
  assert.deepEqual({ ...p, serverNow: 0 }, { remindedAt: at(0).toISOString(), idleMinutes: 45, graceMinutes: 15, serverNow: 0 });
  // ساعة الخادم لحظة الردّ (يصحّح بها التطبيق ساعة الجوال)، والانصراف التلقائي عند remindedAt + المهلة ⇒ يتبقّى ١٢ دقيقة
  assert.equal(p.serverNow, at(3).getTime());
  assert.equal(Date.parse(p.remindedAt) + p.graceMinutes * MIN - p.serverNow, 12 * MIN);
  assert.ok(idle.pendingIdleOf(r, at(0), at(17)));
  assert.equal(idle.pendingIdleOf(r, at(0), at(18)), null, 'بعد المهلة وهامش دورتين');
  assert.equal(idle.pendingIdleOf({ ...r, idlePunchOutEnabled: false }, at(0), at(3)), null);
  assert.equal(idle.pendingIdleOf(r, null, at(3)), null);
  assert.equal(idle.pendingIdleOf(r, at(5), at(3)), null, 'تذكيرٌ في المستقبل');
});

// ═══ (٢) الدورة فوق Prisma مزيّف ═══

test('الدورة: تذكيرٌ واحد لكل فترة خمول — بإشعارٍ بلغة الجهاز وصلاحيته مهلة الردّ، ويُختم معه آخر نشاطٍ سبقه', async () => {
  reps = [rep({ id: 'r1', lastSeenAt: at(5), lang: 'ar' })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: T0 })];
  assert.deepEqual(await idle.runIdlePunchOut(at(5 + 44)), R0);
  assert.equal(pushes.length, 0);
  assert.deepEqual(await idle.runIdlePunchOut(at(50)), res({ reminded: 1 }));
  assert.equal(shifts[0].idleRemindedAt!.getTime(), at(50).getTime());
  assert.equal(shifts[0].idleLastActiveAt!.getTime(), at(5).getTime(), 'آخر نشاطٍ سبق التذكير = وقت الانصراف التلقائي');
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].repId, 'r1');
  assert.equal(pushes[0].payload.body, 'لم يُرصد نشاط منذ 45 دقيقة — سجّل بصمة الانصراف إن انتهى عملك');
  assert.equal(pushes[0].ttlSec, 15 * 60);
  // الدورات التالية داخل المهلة: لا تذكير ثانٍ
  assert.deepEqual(await idle.runIdlePunchOut(at(51)), R0);
  assert.deepEqual(await idle.runIdlePunchOut(at(64)), R0);
  assert.equal(pushes.length, 1);
  assert.equal(shifts[0].checkOutAt, null);
  // والاستعلام يرشّح المؤهّلين في القاعدة: القيد مفعّل، والمندوب والشركة نشطان والبصمة مفعّلة
  assert.ok(calls.includes('salesRep.findMany'));
});

test('الدورة: بلا ردٍّ خلال المهلة ⇒ انصرافٌ تلقائي بوقت آخر نشاط، موسومٌ وبسطر تدقيق «النظام» تحت القفل', async () => {
  reps = [rep({ id: 'r1', lastSeenAt: at(5) })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: T0 })];
  await idle.runIdlePunchOut(at(50));
  assert.deepEqual(await idle.runIdlePunchOut(at(64)), R0);
  assert.deepEqual(await idle.runIdlePunchOut(at(65)), res({ autoOut: 1 }));
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
  assert.deepEqual(await idle.runIdlePunchOut(at(200)), R0);
  assert.equal(audits.length, 1);
  // وتقرير الساعات يسمها «انصراف تلقائي» ولا يعدّ ختم النظام تعديلاً إدارياً
  const days = workDay.attendanceByDay([{ ...s, source: 'APP' }], 180);
  const period = [...days.values()][0].periods[0];
  assert.equal(period.outAuto, true);
  assert.equal(period.edited, false);
});

test('الدورة: النبضة (فتح التطبيق) ونقاط الموقع الساكنة بعد التذكير لا تلغيه — الانصراف بوقت آخر نشاطٍ سبقه', async () => {
  reps = [rep({ id: 'r1', lastSeenAt: at(5) })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: T0 })];
  assert.deepEqual(await idle.runIdlePunchOut(at(50)), res({ reminded: 1 }));
  // فتح التطبيق من الإشعار (نبضةٌ كل دقيقة)، وعاد جواله يرسل موقعه ساكناً بانجرافه
  for (let m = 51; m <= 64; m++) locs.push(loc('r1', m, (m % 2) * 0.0002));
  for (const m of [55, 58, 61, 64]) {
    reps[0].lastSeenAt = at(m);
    assert.deepEqual(await idle.runIdlePunchOut(at(m)), R0, `${m}`);
  }
  assert.equal(shifts[0].idleRemindedAt!.getTime(), at(50).getTime(), 'التذكير قائم');
  assert.equal(shifts[0].idleLastActiveAt!.getTime(), at(5).getTime());
  reps[0].lastSeenAt = at(65);
  assert.deepEqual(await idle.runIdlePunchOut(at(65)), res({ autoOut: 1 }));
  assert.equal(shifts[0].checkOutAt!.getTime(), at(5).getTime(), 'وقت آخر نشاطٍ سبق التذكير — لا النبضة بعده');
  assert.equal(shifts[0].checkOutAuto, true);
});

test('الدورة: قبل التذكير أيّ نقطة موقعٍ تصل من جواله نشاط — ساكنةً من الخلفية أو من الصفحة — بلحظة استلامها', async () => {
  reps = [rep({ id: 'still', lastSeenAt: T0 }), rep({ id: 'web', lastSeenAt: T0 }), rep({ id: 'silent', lastSeenAt: T0 })];
  shifts = [
    shift({ id: 'a', salesRepId: 'still', checkInAt: T0 }), shift({ id: 'b', salesRepId: 'web', checkInAt: T0 }),
    shift({ id: 'c', salesRepId: 'silent', checkInAt: T0 }),
  ];
  // الساكن: نقطة خلفيةٍ كل دقيقة في مكانه بانجرافه حتى ٤٤ ثم يتوقّف جواله عن الإرسال
  for (let m = 0; m <= 44; m++) locs.push(loc('still', m, (m % 2) * 0.0002));
  // نقاط الصفحة (بلا مصدر) كل ٥ دقائق حتى ٤٠
  for (let m = 0; m <= 40; m += 5) locs.push(loc('web', m, 0, { source: null }));
  // الصامت: لا تطبيق ولا موقع منذ الحضور
  assert.deepEqual(await idle.runIdlePunchOut(at(45)), res({ reminded: 1 }));
  assert.deepEqual(pushes.map((p) => p.repId), ['silent']);
  assert.equal(shifts[2].idleLastActiveAt!.getTime(), T0.getTime());
  assert.deepEqual(await idle.runIdlePunchOut(at(60)), res({ autoOut: 1 }));
  assert.equal(shifts[2].checkOutAt!.getTime(), T0.getTime());
  assert.deepEqual(await idle.runIdlePunchOut(at(84)), R0);
  assert.deepEqual(await idle.runIdlePunchOut(at(85)), res({ reminded: 1 }), 'الصفحة: ٤٠ + ٤٥');
  assert.equal(shifts[1].idleLastActiveAt!.getTime(), at(40).getTime());
  assert.deepEqual(await idle.runIdlePunchOut(at(88)), R0);
  assert.deepEqual(await idle.runIdlePunchOut(at(89)), res({ reminded: 1 }), 'الخلفية الساكنة: ٤٤ + ٤٥');
  assert.equal(shifts[0].idleLastActiveAt!.getTime(), at(44).getTime());
  // ثم الانصراف بعد كلٍّ مهلته بوقت آخر نقطةٍ وصلت قبل تذكيره
  assert.deepEqual(await idle.runIdlePunchOut(at(100)), res({ autoOut: 1 }));
  assert.equal(shifts[1].checkOutAt!.getTime(), at(40).getTime());
  assert.deepEqual(await idle.runIdlePunchOut(at(104)), res({ autoOut: 1 }));
  assert.equal(shifts[0].checkOutAt!.getTime(), at(44).getTime());
});

test('الدورة: تنقّلٌ فعليّ بعد التذكير (> ١٥٠ م) يلغيه ويمحوه — لا انصراف، ودورةٌ جديدة من لحظته', async () => {
  reps = [rep({ id: 'r1', lastSeenAt: T0 })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: T0 })];
  for (let m = 0; m <= 20; m++) locs.push(loc('r1', m, (m % 2) * 0.0002)); // ساكنٌ حتى ٢٠ ثم انقطع جواله
  assert.deepEqual(await idle.runIdlePunchOut(at(64)), R0);
  assert.deepEqual(await idle.runIdlePunchOut(at(65)), res({ reminded: 1 }));
  assert.equal(shifts[0].idleLastActiveAt!.getTime(), at(20).getTime());
  // عاد جواله عند ٧٠ في مكانه (ساكن: لا يلغيه)، ثم انتقل ~٣٣٠ م عند ٧٢
  locs.push(loc('r1', 70, 0.0001));
  assert.deepEqual(await idle.runIdlePunchOut(at(70)), R0);
  assert.equal(shifts[0].idleRemindedAt!.getTime(), at(65).getTime());
  locs.push(loc('r1', 72, 0.003));
  assert.deepEqual(await idle.runIdlePunchOut(at(72)), res({ cancelled: 1 }));
  assert.equal(shifts[0].idleRemindedAt, null, 'التذكير مُحي — تسقط النافذة من النبضة التالية');
  assert.equal(shifts[0].idleLastActiveAt!.getTime(), at(72).getTime(), 'لحظة التنقّل أرضيّة الدورة الجديدة');
  // لا انصراف عند انقضاء مهلة التذكير الملغى، ولا تذكير قبل خمولٍ كاملٍ من آخر ما وصل
  assert.deepEqual(await idle.runIdlePunchOut(at(80)), R0);
  assert.deepEqual(await idle.runIdlePunchOut(at(116)), R0);
  assert.equal(shifts[0].checkOutAt, null);
  assert.equal(audits.length, 0);
  assert.deepEqual(await idle.runIdlePunchOut(at(117)), res({ reminded: 1 }));
  assert.equal(shifts[0].idleLastActiveAt!.getTime(), at(72).getTime());
});

test('الدورة: انتقالٌ دون ١٥٠ م أو دون هامشَي الخطأ أو بدقّةٍ رخوة بعد التذكير ليس تنقّلاً — الانصراف قائم بوقته', async () => {
  reps = [rep({ id: 'r1', lastSeenAt: T0 })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: T0 })];
  locs.push(loc('r1', 10, 0, { accuracy: 100 }));
  assert.deepEqual(await idle.runIdlePunchOut(at(55)), res({ reminded: 1 }));
  assert.equal(shifts[0].idleLastActiveAt!.getTime(), at(10).getTime());
  locs.push(loc('r1', 58, 0.0012));                      // ~١٣٠ م
  locs.push(loc('r1', 60, 0.0017, { accuracy: 100 }));   // ~١٩٠ م وهامشا الخطأ ٢٠٠ م
  locs.push(loc('r1', 62, 0.01, { accuracy: 800 }));     // قفزة شبكةٍ خلوية ~١١٠٠ م
  assert.deepEqual(await idle.runIdlePunchOut(at(63)), R0);
  assert.deepEqual(await idle.runIdlePunchOut(at(70)), res({ autoOut: 1 }));
  assert.equal(shifts[0].checkOutAt!.getTime(), at(10).getTime());
});

test('الدورة: تنقّلٌ يُستلم بعد التذكير يلغيه بلحظة استلامه ولو كانت ساعة الجوال متأخّرةً ساعة (التقاطه «قبل» التذكير)', async () => {
  reps = [rep({ id: 'r1', lastSeenAt: T0 })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: T0 })];
  // ساكنٌ حتى ٢٠ ثم انقطع جواله — وساعته متأخّرة ٦٠ دقيقة عن الخادم
  for (let m = 0; m <= 20; m++) locs.push(loc('r1', m, (m % 2) * 0.0002, { capturedAt: at(m - 60) }));
  assert.deepEqual(await idle.runIdlePunchOut(at(65)), res({ reminded: 1 }));
  assert.equal(shifts[0].idleLastActiveAt!.getTime(), at(20).getTime());
  // قاد ~٣٣٠ م في دقيقةٍ بعد التذكير: نقطتان استُلمتا عند ٦٥٫٥ و٦٦ وساعة جواله تقول ٥٫٥ و٦ (قبل التذكير بساعة)
  locs.push(loc('r1', 65.5, 0.0015, { capturedAt: at(5.5) }));
  locs.push(loc('r1', 66, 0.003, { capturedAt: at(6) }));
  assert.deepEqual(await idle.runIdlePunchOut(at(66)), res({ cancelled: 1 }));
  assert.equal(shifts[0].idleRemindedAt, null);
  assert.equal(shifts[0].idleLastActiveAt!.getTime(), at(66).getTime(), 'لحظة استلام آخر تنقّلٍ أرضيّة الدورة الجديدة');
  // ثم وقف عند العميل بلا مستند: لا انصراف عند انقضاء مهلة التذكير الملغى
  assert.deepEqual(await idle.runIdlePunchOut(at(80)), R0);
  assert.equal(shifts[0].checkOutAt, null);
  assert.equal(audits.length, 0);
});

test('الدورة: دفعةٌ رُفعت بعد انقطاع — تنقّلٌ التُقط قبل التذكير واستُلم بعده بدقيقتين يلغيه بلحظة استلامه', async () => {
  reps = [rep({ id: 'r1', lastSeenAt: T0 })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: T0 })];
  for (let m = 0; m <= 10; m++) locs.push(loc('r1', m)); // يرسل موقعه حتى ١٠ ثم انقطعت شبكته
  assert.deepEqual(await idle.runIdlePunchOut(at(55)), res({ reminded: 1 }));
  assert.equal(shifts[0].idleLastActiveAt!.getTime(), at(10).getTime());
  assert.deepEqual(await idle.runIdlePunchOut(at(56)), R0);
  // قاد ~١ كم بين ٢٠ و٤٠ دون شبكة، ورُفعت الدفعة كلّها عند ٥٧ (التذكير + ٢) بلحظة استلامٍ واحدة
  for (let m = 20; m <= 40; m += 5) locs.push(loc('r1', m, (m - 15) * 0.0004, { createdAt: at(57) }));
  assert.deepEqual(await idle.runIdlePunchOut(at(57)), res({ cancelled: 1 }));
  assert.equal(shifts[0].idleRemindedAt, null);
  assert.equal(shifts[0].idleLastActiveAt!.getTime(), at(57).getTime(), 'لحظة استلام الدفعة أرضيّة الدورة الجديدة');
  assert.deepEqual(await idle.runIdlePunchOut(at(70)), R0);
  assert.equal(shifts[0].checkOutAt, null);
  assert.equal(audits.length, 0);
});

test('الدورة: مستندٌ أصدره المندوب بعد التذكير يلغيه — فاتورة أو مرتجع أو سند أو زيارة؛ وما سبقه أو لمندوبٍ آخر لا يلغيه', async () => {
  const kinds: Record<string, (m: number, repId?: string) => void> = {
    invoice: (m, repId = 'r1') => { invoices.push({ tenantId: TENANT, salesRepId: repId, type: 'CASH', invoiceDate: at(m), createdAt: at(m) }); },
    return: (m, repId = 'r1') => { invoices.push({ tenantId: TENANT, salesRepId: repId, type: 'RETURN', invoiceDate: at(m), createdAt: at(m) }); },
    receipt: (m, repId = 'r1') => { receipts.push({ tenantId: TENANT, salesRepId: repId, receiptDate: at(m), createdAt: at(m) }); },
    visit: (m, repId = 'r1') => { visits.push({ tenantId: TENANT, salesRepId: repId, createdAt: at(m), receivedAt: at(m) }); },
  };
  for (const [kind, add] of Object.entries(kinds)) {
    reps = [rep({ id: 'r1', lastSeenAt: at(5) }), rep({ id: 'r2', lastSeenAt: at(5), idlePunchOutEnabled: false })];
    shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: T0 })];
    invoices = []; receipts = []; visits = []; audits = [];
    idle._resetIdleLoop();
    add(40); // قبل التذكير
    assert.deepEqual(await idle.runIdlePunchOut(at(50)), res({ reminded: 1 }), kind);
    add(55, 'r2'); // لمندوبٍ آخر
    assert.deepEqual(await idle.runIdlePunchOut(at(56)), R0, kind);
    assert.equal(shifts[0].idleRemindedAt!.getTime(), at(50).getTime(), kind);
    add(57);
    assert.deepEqual(await idle.runIdlePunchOut(at(58)), res({ cancelled: 1 }), kind);
    assert.equal(shifts[0].idleRemindedAt, null, kind);
    assert.equal(shifts[0].idleLastActiveAt!.getTime(), at(57).getTime(), `${kind}: لحظة وصوله أرضيّة الدورة الجديدة`);
    assert.deepEqual(await idle.runIdlePunchOut(at(65)), R0, kind);
    assert.equal(shifts[0].checkOutAt, null, kind);
    assert.equal(audits.length, 0, kind);
  }
});

test('المستندات: findFirst لكلٍّ بلحظة الخادم وحدٍّ رخو على تاريخ المستند في مدى فهرس — ويتوقّف عند أوّل ما يجد', async () => {
  reps = [rep({ id: 'r1', lastSeenAt: at(5) })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: T0 })];
  await idle.runIdlePunchOut(at(50));
  docWheres = [];
  assert.deepEqual(await idle.runIdlePunchOut(at(51)), R0);
  assert.deepEqual(docWheres.map((w) => w.model), ['invoice', 'receipt', 'repVisit']);
  const [inv, rcp, vis] = docWheres.map((w) => w.where);
  const lo = at(50).getTime() - idle.IDLE_SKEW_WINDOW_MS;
  for (const w of [inv, rcp, vis]) { assert.equal(w.tenantId, TENANT); assert.equal(w.salesRepId, 'r1'); }
  assert.equal(inv.invoiceDate.gte.getTime(), lo);
  assert.equal(inv.createdAt.gt.getTime(), at(50).getTime());
  // السند في مدى فهرس (tenantId, salesRepId, createdAt) المضاف له — وreceiptDate مرشّحٌ على ما يجده وحده
  assert.equal(rcp.createdAt.gt.getTime(), at(50).getTime());
  assert.equal(rcp.receiptDate.gte.getTime(), lo);
  const schema = fs.readFileSync(path.join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8');
  const receiptModel = schema.slice(schema.indexOf('model Receipt {'), schema.indexOf('\n}', schema.indexOf('model Receipt {')));
  assert.match(receiptModel, /@@index\(\[tenantId, salesRepId, createdAt\]\)/, 'فهرس سندات المندوب بلحظة الإنشاء');
  assert.doesNotMatch(receiptModel, /@@unique\(\[tenantId, salesRepId/, 'فهرسٌ عاديّ لا قيد تفرّد على جدولٍ قائم');
  assert.equal(vis.createdAt.gte.getTime(), lo, 'الزيارة: فهرس (tenantId, salesRepId, createdAt)');
  assert.equal(vis.receivedAt.gt.getTime(), at(50).getTime(), 'وبلحظة وصولها للخادم — createdAt لحظة الجهاز');
  // فاتورةٌ التُقطت دون اتصال قبل التذكير بأكثر من الحدّ ووصلت بعده لا تشهد بعملٍ الآن
  invoices.push({ tenantId: TENANT, salesRepId: 'r1', type: 'CASH', invoiceDate: at(50 - 13 * 60), createdAt: at(51.5) });
  assert.deepEqual(await idle.runIdlePunchOut(at(52)), R0);
  // وزيارةٌ التُقطت دون اتصال قبل التذكير بقليل ووصلت بعده تلغيه (وصولها بساعة الخادم)
  visits.push({ tenantId: TENANT, salesRepId: 'r1', createdAt: at(30), receivedAt: at(52.5) });
  assert.deepEqual(await idle.runIdlePunchOut(at(53)), res({ cancelled: 1 }));
  // فاتورةٌ تكفي وحدها: لا سؤال عن السندات والزيارات بعدها
  Object.assign(shifts[0], { idleRemindedAt: at(50), idleLastActiveAt: at(5) });
  invoices.push({ tenantId: TENANT, salesRepId: 'r1', type: 'CASH', invoiceDate: at(53.5), createdAt: at(53.5) });
  docWheres = [];
  assert.deepEqual(await idle.runIdlePunchOut(at(54)), res({ cancelled: 1 }));
  assert.deepEqual(docWheres.map((w) => w.model), ['invoice']);
});

test('الدورة: مستندٌ يصل بين الحكم والقفل يمنع الانصراف (يُفحص تحت القفل)، و«ما زلت أعمل» كذلك؛ أمّا نبضةٌ حينها فلا', async () => {
  reps = [rep({ id: 'r1', lastSeenAt: at(5) })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: T0 })];
  await idle.runIdlePunchOut(at(50));
  onLock = () => { invoices.push({ tenantId: TENANT, salesRepId: 'r1', type: 'CASH', invoiceDate: at(64.9), createdAt: at(64.9) }); };
  assert.deepEqual(await idle.runIdlePunchOut(at(65)), R0);
  assert.equal(shifts[0].checkOutAt, null);
  assert.equal(audits.length, 0);
  onLock = null;
  assert.deepEqual(await idle.runIdlePunchOut(at(66)), res({ cancelled: 1 }), 'والدورة التالية تمحوه');
  // «ما زلت أعمل» بعد الحكم (التذكير مُحي تحت القفل)
  invoices = [];
  Object.assign(shifts[0], { idleRemindedAt: at(50), idleLastActiveAt: at(5) });
  onLock = () => { Object.assign(shifts[0], { idleRemindedAt: null, idleLastActiveAt: null }); };
  assert.deepEqual(await idle.runIdlePunchOut(at(67)), R0);
  assert.equal(shifts[0].checkOutAt, null);
  // نبضةٌ تصل حينها لا تمنعه (قرار المالك: فتح التطبيق بعد التذكير لا يلغيه)
  Object.assign(shifts[0], { idleRemindedAt: at(50), idleLastActiveAt: at(5) });
  onLock = () => { reps[0].lastSeenAt = at(67.9); };
  assert.deepEqual(await idle.runIdlePunchOut(at(68)), res({ autoOut: 1 }));
  assert.equal(shifts[0].checkOutAt!.getTime(), at(5).getTime());
});

test('الدورة: نبضةٌ أو «ما زلت أعمل» يصلان بين القراءة والحجز يمنعان التذكير (آخر ظهورٍ أحدث في شرط الحجز)', async () => {
  reps = [rep({ id: 'r1', lastSeenAt: at(5) })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: T0 })];
  const orig = handlers['repAttendance.updateMany'];
  handlers['repAttendance.updateMany'] = (a) => { reps[0].lastSeenAt = at(49.9); return orig(a); };
  try {
    assert.deepEqual(await idle.runIdlePunchOut(at(50)), R0);
  } finally {
    handlers['repAttendance.updateMany'] = orig;
  }
  assert.equal(shifts[0].idleRemindedAt, null);
  assert.equal(pushes.length, 0);
  // وبلا ذلك يُحجز التذكير كالعادة بعد خمولٍ كامل من النبضة
  assert.deepEqual(await idle.runIdlePunchOut(at(49.9 + 45)), res({ reminded: 1 }));
});

test('الدورة: جوالٌ ساعته متأخّرة ساعةً — نقاطه نشاطٌ بلحظة استلامها؛ يُذكَّر بعد توقّفها بخمولٍ كامل، وينصرف بوقت آخر استلام', async () => {
  reps = [rep({ id: 'driver', lastSeenAt: T0 })];
  shifts = [shift({ id: 'd', salesRepId: 'driver', checkInAt: T0 })];
  const seen: (typeof R0)[] = [];
  for (let m = 0; m <= 150; m++) {
    // ينتقل ~٣٣٠ م كل دقيقة، والتطبيق في الخلفية (لا آخر ظهور)، وساعة الجوال متأخّرة ٦٠ دقيقة عن الخادم
    locs.push(loc('driver', m, m * 0.003, { accuracy: 10, capturedAt: at(m - 60) }));
    if (m >= 45 && m % 5 === 0) seen.push(await idle.runIdlePunchOut(at(m)));
  }
  assert.ok(seen.length > 10);
  assert.ok(seen.every((r) => r.reminded === 0 && r.autoOut === 0 && r.cancelled === 0), JSON.stringify(seen));
  assert.equal(shifts[0].idleRemindedAt, null);
  assert.equal(pushes.length, 0);
  // ثم ينقطع جواله (لا نقاط): التذكير بعد خمولٍ كامل من آخر استلام (١٥٠) لا من ساعة الجوال (٩٠)
  assert.deepEqual(await idle.runIdlePunchOut(at(194)), R0);
  assert.deepEqual(await idle.runIdlePunchOut(at(195)), res({ reminded: 1 }));
  assert.equal(shifts[0].idleLastActiveAt!.getTime(), at(150).getTime());
  assert.deepEqual(await idle.runIdlePunchOut(at(209)), R0);
  assert.deepEqual(await idle.runIdlePunchOut(at(210)), res({ autoOut: 1 }));
  assert.equal(shifts[0].checkOutAt!.getTime(), at(150).getTime(), 'وقت الانصراف آخر استلامٍ بساعة الخادم');
});

test('الدورة: نقاط الموقع (الخلفية والصفحة) تُقرأ بلحظة استلامها — حدٌّ رخوٌ على الالتقاط يتبع المؤشّر، والترتيب والمؤشّر على createdAt', async () => {
  reps = [rep({ id: 'r1', lastSeenAt: T0 })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: T0 })];
  locs.push(loc('r1', 2));
  const wheres: any[] = [];
  const orig = handlers['repLocation.findMany'];
  handlers['repLocation.findMany'] = (a) => { wheres.push({ where: a.where, orderBy: a.orderBy }); return orig(a); };
  try {
    assert.deepEqual(await idle.runIdlePunchOut(at(45)), R0);
    assert.deepEqual(await idle.runIdlePunchOut(at(46)), R0);
    // آخر استلامٍ من القراءة الأولى محفوظٌ في الحالة التزايدية
    assert.deepEqual(await idle.runIdlePunchOut(at(47)), res({ reminded: 1 }));
  } finally {
    handlers['repLocation.findMany'] = orig;
  }
  assert.equal(shifts[0].idleLastActiveAt!.getTime(), at(2).getTime());
  assert.equal(wheres.length, 3);
  const [first, next] = wheres;
  assert.ok(!('source' in first.where), 'كل المصادر: الخلفية والصفحة');
  assert.equal(first.where.capturedAt.gte.getTime(), T0.getTime() - idle.IDLE_SKEW_WINDOW_MS);
  assert.equal(first.where.createdAt.gte.getTime(), T0.getTime(), 'القراءة الأولى: ما استُلم منذ الأرضيّة');
  assert.deepEqual(first.orderBy, [{ createdAt: 'desc' }, { capturedAt: 'desc' }]);
  assert.equal(next.where.createdAt.gt.getTime(), at(2).getTime(), 'ثم تزايدية بعد آخر استلامٍ قُرئ');
  assert.equal(next.where.capturedAt.gte.getTime(), at(2).getTime() - idle.IDLE_SKEW_WINDOW_MS, 'والحدّ الرخو يتبع المؤشّر');
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
  assert.deepEqual(r, res({ reminded: 1 }));
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

test('الإعدادات: إطفاء المفتاح ثم إعادته يمحو تذكير النوبة المفتوحة وختمه — أوّل حكمٍ بعدها تذكيرٌ جديد لا انصرافٌ صامت', async () => {
  // تذكيرٌ أُرسل عند ٥٠ ولا شيء يلغيه بعده، ثم أطفأت الإدارة القيد وأعادته بعد ساعات
  reps = [rep({ id: 'r1', lastSeenAt: at(5) })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: T0, idleRemindedAt: at(50), idleLastActiveAt: at(5) })];
  assert.equal((await call('PUT', '/api/sales-reps/r1', { idlePunchOutEnabled: false })).status, 200);
  assert.equal(reps[0].idlePunchOutEnabled, false);
  assert.equal(shifts[0].idleRemindedAt, null, 'الإطفاء يمحو التذكير');
  assert.equal(shifts[0].idleLastActiveAt, null, 'وختمه');
  Object.assign(shifts[0], { idleRemindedAt: at(50), idleLastActiveAt: at(5) }); // ولو بقي تذكيرٌ قديم (سبقت الدورةُ المحوَ)
  assert.equal((await call('PUT', '/api/sales-reps/r1', { idlePunchOutEnabled: true })).status, 200);
  assert.equal(reps[0].idlePunchOutEnabled, true);
  assert.equal(shifts[0].idleRemindedAt, null, 'إعادة التفعيل تمحو التذكير');
  assert.equal(shifts[0].idleLastActiveAt, null);
  assert.deepEqual(await idle.runIdlePunchOut(at(300)), res({ reminded: 1 }));
  assert.equal(shifts[0].checkOutAt, null);
  assert.equal(pushes.length, 1);
  // وحفظٌ لا يبدّل المفتاح (المفعّل يبقى مفعّلاً، أو تعديل الدقائق وحدها) لا يمسّ تذكيراً قائماً
  assert.equal((await call('PUT', '/api/sales-reps/r1', { idlePunchOutEnabled: true, idlePunchOutMinutes: 60 })).status, 200);
  assert.equal(shifts[0].idleRemindedAt!.getTime(), at(300).getTime());
  assert.equal((await call('PUT', '/api/sales-reps/r1', { name: 'خالد' })).status, 200);
  assert.equal(shifts[0].idleRemindedAt!.getTime(), at(300).getTime());
  assert.equal(shifts[0].idleLastActiveAt!.getTime(), at(5).getTime());
  // والنوبات المغلقة لا تُمسّ
  shifts.push(shift({ id: 's0', salesRepId: 'r1', checkInAt: at(-600), checkOutAt: at(-300), idleRemindedAt: at(-400), idleLastActiveAt: at(-450) }));
  await call('PUT', '/api/sales-reps/r1', { idlePunchOutEnabled: false });
  assert.equal(shifts[1].idleRemindedAt!.getTime(), at(-400).getTime());
  assert.equal(shifts[1].idleLastActiveAt!.getTime(), at(-450).getTime());
});

// ═══ (٤) تطبيق المندوب: النبضة و/attendance/today و«ما زلت أعمل» ═══

const REP_USER: User = { id: 'r1', role: 'SALES_REP', tenantId: TENANT, name: 'خالد' };
const ago = (m: number) => new Date(Date.now() - m * MIN);

test('النبضة: idlePunchOutReminder حاضرٌ دائماً — التذكير المعلّق للمقيَّد ببيانات العدّ التنازليّ، وnull لغيره', async () => {
  currentUser = REP_USER;
  reps = [rep({ id: 'r1' })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: ago(120), idleRemindedAt: ago(3), idleLastActiveAt: ago(48) })];
  const before = Date.now();
  const beat = await call('POST', '/api/tracking/heartbeat', {});
  assert.equal(beat.status, 200);
  const r = beat.body.data.idlePunchOutReminder;
  assert.equal(r.remindedAt, shifts[0].idleRemindedAt!.toISOString());
  assert.equal(r.idleMinutes, 45);
  assert.equal(r.graceMinutes, 15);
  // ساعة الخادم لحظة الردّ: بها يصحّح التطبيق ساعة الجوال — والمتبقّي إلى الانصراف التلقائي ~١٢ دقيقة
  assert.equal(typeof r.serverNow, 'number');
  assert.ok(r.serverNow >= before && r.serverNow <= Date.now());
  const left = Date.parse(r.remindedAt) + r.graceMinutes * MIN - r.serverNow;
  assert.ok(left > 11.9 * MIN && left <= 12 * MIN, String(left));
  assert.ok('presence' in beat.body.data);
  // النبضة تكتب آخر ظهورٍ الآن — ولا تمحو التذكير ولا ختمه (لا تلغي الانصراف التلقائي)
  assert.ok(Date.now() - reps[0].lastSeenAt!.getTime() < 5000);
  assert.ok(shifts[0].idleRemindedAt && shifts[0].idleLastActiveAt);
  // المطفأ: null (لا قراءة للتذكير)
  reps[0].idlePunchOutEnabled = false;
  assert.equal((await call('POST', '/api/tracking/heartbeat', {})).body.data.idlePunchOutReminder, null);
  // تذكيرٌ فاتت مهلته وهامشها: null
  reps[0].idlePunchOutEnabled = true;
  shifts[0].idleRemindedAt = ago(30);
  assert.equal((await call('POST', '/api/tracking/heartbeat', {})).body.data.idlePunchOutReminder, null);
});

test('النبضة بعد التذكير لا تلغيه: الدورة تصرفه بعد المهلة بوقت آخر نشاطٍ سبقه', async () => {
  currentUser = REP_USER;
  reps = [rep({ id: 'r1', lastSeenAt: ago(61) })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: ago(120), idleRemindedAt: ago(16), idleLastActiveAt: ago(61) })];
  const stamped = shifts[0].idleLastActiveAt!.getTime();
  const beat = await call('POST', '/api/tracking/heartbeat', {});
  assert.ok(beat.body.data.idlePunchOutReminder, 'النافذة تظهر بعدّها إلى انصرافٍ سيقع');
  assert.ok(Date.now() - reps[0].lastSeenAt!.getTime() < 5000);
  assert.deepEqual(await idle.runIdlePunchOut(new Date()), res({ autoOut: 1 }));
  assert.equal(shifts[0].checkOutAt!.getTime(), stamped, 'بوقت آخر نشاطٍ سبق التذكير لا بالنبضة');
  assert.equal(shifts[0].checkOutAuto, true);
});

test('/attendance/today: النوبة المفتوحة تحمل التذكير المعلّق، والمغلقة تلقائياً تحمل checkOutAuto', async () => {
  currentUser = REP_USER;
  reps = [rep({ id: 'r1' })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: ago(90), idleRemindedAt: ago(2), idleLastActiveAt: ago(47) })];
  const open = await call('GET', '/api/tracking/attendance/today?tzOffsetMin=180');
  assert.equal(open.body.data.status, 'in');
  assert.equal(open.body.data.idlePunchOutReminder.remindedAt, shifts[0].idleRemindedAt!.toISOString());
  assert.equal(typeof open.body.data.idlePunchOutReminder.serverNow, 'number');
  Object.assign(shifts[0], { checkOutAt: ago(60), checkOutAuto: true, editedAt: ago(1), editedBy: 'النظام' });
  const closed = await call('GET', '/api/tracking/attendance/today?tzOffsetMin=180');
  assert.equal(closed.body.data.status, 'out');
  assert.equal(closed.body.data.last.checkOutAuto, true);
  assert.equal(closed.body.data.shifts[0].checkOutAuto, true);
});

test('«ما زلت أعمل»: يمحو التذكير وختمه ويكتب نشاطاً تحت القفل فيلغي الانصراف؛ وبعد انصرافٍ تلقائي 409 NO_OPEN_SHIFT ومعه autoCheckedOut', async () => {
  currentUser = REP_USER;
  reps = [rep({ id: 'r1', lastSeenAt: ago(50) })];
  shifts = [shift({ id: 's1', salesRepId: 'r1', checkInAt: ago(120), idleRemindedAt: ago(16), idleLastActiveAt: ago(61) })];
  const ok = await call('POST', '/api/tracking/attendance/still-working', {});
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.status, 'in');
  assert.equal(ok.body.data.idlePunchOutReminder, null);
  assert.equal(shifts[0].idleRemindedAt, null);
  assert.equal(shifts[0].idleLastActiveAt, null);
  assert.ok(Date.now() - reps[0].lastSeenAt!.getTime() < 5000);
  assert.deepEqual(locks, ['rep-attendance:r1']);
  // ثمّ الدورة — والمهلة كانت قد انقضت: لا انصراف ولا تذكير حتى خمولٍ جديدٍ كامل
  assert.deepEqual(await idle.runIdlePunchOut(new Date()), R0);
  assert.equal(shifts[0].checkOutAt, null);

  // سبقه الانصراف التلقائي
  Object.assign(shifts[0], { checkOutAt: ago(60), checkOutAuto: true, editedAt: ago(1), editedBy: 'النظام' });
  const late = await call('POST', '/api/tracking/attendance/still-working', {});
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'NO_OPEN_SHIFT');
  assert.equal(late.body.autoCheckedOut, true);
  assert.equal(late.body.last.checkOutAuto, true);
  assert.match(late.body.message, /تلقائياً بوقت آخر نشاطٍ لك قبل التذكير/);
  // انصرافٌ تلقائي قديم (قبل أيام) لا يُنسب إليه الردّ، ولا انصرافٌ يدوي
  shifts[0].editedAt = ago(3 * 24 * 60);
  assert.equal((await call('POST', '/api/tracking/attendance/still-working', {})).body.autoCheckedOut, false);
  Object.assign(shifts[0], { checkOutAuto: false, editedAt: null });
  const manual = await call('POST', '/api/tracking/attendance/still-working', {});
  assert.equal(manual.status, 409);
  assert.equal(manual.body.code, 'NO_OPEN_SHIFT');
  assert.equal(manual.body.autoCheckedOut, false);
});
