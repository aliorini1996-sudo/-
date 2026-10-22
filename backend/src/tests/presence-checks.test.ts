// «التحقق العشوائي من التواجد» (طلب المالك، ٢٢ أكتوبر ٢٠٢٦): مرّتان إلى ثلاث في اليوم بأوقاتٍ عشوائية متفرّقة أثناء النوبة،
// والردّ خلال دقيقتين بموقعٍ طازج. التخطيط والإرسال والتأجيل والانتهاء والردّ فوق Prisma مزيّف في الذاكرة — بلا قاعدة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Router } from 'express';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ─── Prisma مزيّف ───
type Check = {
  id: string; tenantId: string; salesRepId: string; day: string; dueAt: Date; windowEndAt: Date; status: string;
  sentAt: Date | null; pushSent: number | null; respondedAt?: Date | null; [k: string]: unknown;
};
type Rep = {
  id: string; tenantId: string; requirePresenceCheck: boolean; isActive: boolean; tenantOn: boolean;
  shiftStart: string | null; shiftEnd: string | null; tzOffsetMin: number | null; requireBoundDevice?: boolean; boundDeviceId?: string | null;
  shiftDays?: number;
};
let checks: Check[] = [];
let reps: Rep[] = [];
let shifts: { id?: string; salesRepId: string; checkInAt: Date; checkOutAt: Date | null }[] = [];
let markers = new Set<string>();
let pushes: { repId: string; payload: Record<string, unknown>; ttlSec?: number }[] = [];
let pushDevices = 1;
let seq = 0;

const eligible = (r: Rep) => r.requirePresenceCheck && r.isActive && r.tenantOn;
const matches = (c: Check, w: Record<string, unknown>): boolean => Object.entries(w).every(([k, v]) => {
  if (v === null) return c[k] == null;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o = v as { lte?: Date; lt?: Date; gt?: Date; gte?: Date; not?: string; in?: string[] };
    if (o.in) return o.in.includes(c[k] as string);
    const x = c[k] as Date | string;
    return (o.lte == null || (x as Date) <= o.lte) && (o.lt == null || (x as Date) < o.lt) && (o.gt == null || (x as Date) > o.gt)
      && (o.gte == null || (x as Date) >= o.gte) && (o.not == null || x !== o.not);
  }
  return c[k] === v;
});
const prisma = {
  presenceCheck: {
    async count(a: { where: Record<string, unknown> }) { return checks.filter((c) => matches(c, a.where)).length; },
    async createMany(a: { data: Omit<Check, 'id' | 'status' | 'sentAt' | 'pushSent'>[] }) {
      for (const d of a.data) checks.push({ id: `c${++seq}`, status: 'SCHEDULED', sentAt: null, pushSent: null, ...d } as Check);
      return { count: a.data.length };
    },
    async findMany(a: { where: Record<string, unknown> }) {
      const w = { ...a.where } as Record<string, unknown>;
      const ids = (w.salesRepId as { in?: string[] } | undefined)?.in;
      if (ids) delete w.salesRepId;
      return checks.filter((c) => (!ids || ids.includes(c.salesRepId)) && matches(c, w)).sort((x, y) => +x.dueAt - +y.dueAt).map((c) => ({ ...c }));
    },
    async findFirst(a: { where: Record<string, unknown> }) {
      const l = checks.filter((c) => matches(c, a.where)).sort((x, y) => +(y.sentAt ?? 0) - +(x.sentAt ?? 0));
      return l[0] ? { ...l[0] } : null;
    },
    async updateMany(a: { where: Record<string, unknown>; data: Partial<Check> }) {
      const w = { ...a.where } as Record<string, unknown>;
      const or = w.OR as Record<string, unknown>[] | undefined;
      delete w.OR;
      const l = checks.filter((c) => matches(c, w) && (!or || or.some((o) => (o.tappedAt === null ? c.tappedAt == null : matches(c, o)))));
      for (const c of l) Object.assign(c, a.data);
      return { count: l.length };
    },
    async update(a: { where: { id: string }; data: Partial<Check> }) { const c = checks.find((x) => x.id === a.where.id)!; Object.assign(c, a.data); return c; },
  },
  salesRep: {
    async findMany(a: { where: { id?: { in: string[] } }; select: Record<string, unknown> }) {
      if (a.where.id) {
        return reps.filter((r) => a.where.id!.in.includes(r.id) && eligible(r)).map((r) => ({ id: r.id, pushSubscriptions: [{ lang: 'ar' }] }));
      }
      // التخطيط: المؤهّلون ولهم نوبةٌ مفتوحة
      return reps.filter(eligible).map((r) => ({
        ...r, shiftDays: r.shiftDays ?? 31,
        attendance: shifts.filter((s) => s.salesRepId === r.id && !s.checkOutAt).sort((x, y) => +y.checkInAt - +x.checkInAt).slice(0, 1)
          .map((s) => ({ id: s.id ?? `sh-${r.id}`, checkInAt: s.checkInAt })),
      })).filter((r) => r.attendance.length);
    },
    async findFirst(a: { where: { id: string } }) { const r = reps.find((x) => x.id === a.where.id); return r ? { ...r } : null; },
  },
  repAttendance: {
    async findFirst(a: { where: { salesRepId: string; checkOutAt: { lte: Date } } }) {
      const l = shifts.filter((x) => x.salesRepId === a.where.salesRepId && x.checkOutAt && x.checkOutAt <= a.where.checkOutAt.lte)
        .sort((x, y) => +y.checkOutAt! - +x.checkOutAt!);
      return l[0] ? { checkOutAt: l[0].checkOutAt } : null;
    },
    async findMany(a: { where: { salesRepId: { in: string[] } } }) {
      return [...new Set(shifts.filter((s) => a.where.salesRepId.in.includes(s.salesRepId) && !s.checkOutAt).map((s) => s.salesRepId))].map((salesRepId) => ({ salesRepId }));
    },
  },
  opsMarker: {
    async create(a: { data: { key: string } }) { if (markers.has(a.data.key)) throw new Error('unique'); markers.add(a.data.key); return {}; },
    async findUnique(a: { where: { key: string } }) { return markers.has(a.where.key) ? { key: a.where.key } : null; },
    async deleteMany() { return { count: 0 }; },
  },
  tenant: { async findUnique() { return { attendanceEnabled: true }; } },
  // أقرب العملاء (nearestCustomersM): عميلٌ على بعد ~٣٣ م من نقطة الردّ
  async $queryRaw() { return [{ lat: 24.7139, lng: 46.6753 }]; },
};
stub('config/database', { default: prisma });
stub('services/webPush', {
  sendPushToRep: async (repId: string, payload: Record<string, unknown>, opts: { ttlSec?: number } = {}) => { pushes.push({ repId, payload, ttlSec: opts.ttlSec }); return pushDevices; },
  getVapidKeys: async () => ({ publicKey: 'k' }), pushEndpointAllowed: () => true, pushKeysValid: () => true,
});
stub('middleware/auth', {
  authenticate: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireAdmin: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireAdminPermission: () => (_q: unknown, _s: unknown, next: () => void) => next(),
  tenantId: (req: { user?: { tenantId?: string } }) => req.user!.tenantId!,
  actorOf: () => 'x', isOwnerSession: () => false,
});
stub('services/adminScope', { adminRepFilter: async () => ({}), scopedRepRecordWhere: async () => ({}), scopedRecordWhere: async () => ({}), canAccessRep: async () => true, SHAPE_VISIT: {} });
stub('services/mapMatch', { snapToRoads: async () => [], routeThrough: async () => [] });
stub('services/routeShape', { buildRouteShape: () => ({}), haversineM: (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => Math.round(Math.hypot((a.lat - b.lat) * 111320, (a.lng - b.lng) * 101000)) });
stub('services/repHeartbeat', { heartbeatClientState: () => ({}) });
stub('services/customerScope', { isolationEnabled: async () => false });

/* eslint-disable @typescript-eslint/no-var-requires */
const pc = require('../services/presenceChecks') as typeof import('../services/presenceChecks');
const trackingRouter = require('../routes/tracking').default as Router;
/* eslint-enable @typescript-eslint/no-var-requires */

const MIN = 60_000;
const reset = () => { checks = []; reps = []; shifts = []; markers = new Set(); pushes = []; pushDevices = 1; seq = 0; pc._resetPresenceLoop(); };
/** مولّدٌ ببذرة (mulberry32) — قابلٌ للتكرار ومتنوّع (السحب المستقل يرفض المواعيد المتطابقة) */
const prng = (seed: number) => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
/** القيمة الأولى لعدد اليوم (< ٠٫٥ ⇒ ٢، وإلّا ٣) ثم مولّدٌ ببذرة */
const countThen = (first: number, seed = 7) => { const r = prng(seed); let used = false; return () => (used ? r() : ((used = true), first)); };
const riyadh = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 22, h - 3, m)); // ٢٢ أكتوبر ٢٠٢٦

// ═══ التخطيط — منطقٌ صرف ═══
test('المواعيد مستقلة على الدوام كله: داخل النافذة، مرتّبة، بفاصلٍ أدنى قصير — ولا أقسام تكشف «فترةً آمنة» أو نهاية اليوم', () => {
  const start = +riyadh(8, 20);
  const end = +riyadh(16, 40);
  const span = end - start;
  let firstTwoInFirstThird = 0;
  let firstAfterTwoThirds = 0;
  let shortGap = 0;
  for (let seed = 1; seed <= 3000; seed++) {
    const t = pc.planTimes(start, end, 3, prng(seed));
    assert.equal(t.length, 3);
    t.forEach((x) => assert.ok(x >= start && x < end, 'خارج النافذة'));
    for (let i = 1; i < t.length; i++) {
      assert.ok(t[i] - t[i - 1] >= pc.PRESENCE_MIN_GAP_MS, 'فاصلٌ أقلّ من الأدنى');
      if (t[i] - t[i - 1] < 40 * MIN) shortGap++;
    }
    if (t[1] < start + span / 3) firstTwoInFirstThird++;
    if (t[0] >= start + (2 * span) / 3) firstAfterTwoThirds++;
  }
  // التقسيم القديم كان يمنع هذه كلها حتماً — فكانت فترةٌ آمنة بعد كل طلب ويُعرف من الثاني أن اليوم انتهى
  assert.ok(firstTwoInFirstThird > 0, 'طلبان في الثلث الأول ممكنان');
  assert.ok(firstAfterTwoThirds > 0, 'أول طلبٍ في الثلث الأخير ممكن');
  assert.ok(shortGap > 0, 'طلبٌ بعد سابقه بأقلّ من ٤٠ دقيقة ممكن');
  assert.equal(pc.PRESENCE_MIN_GAP_MS, 20 * MIN);
});

test('النافذة الضيّقة تُنقص العدد، والأضيق من عشر دقائق بلا تحقّق، والعدد اليومي ٢ أو ٣', () => {
  const s = +riyadh(15);
  for (let seed = 1; seed <= 200; seed++) {
    const t = pc.planTimes(s, s + 30 * MIN, 3, prng(seed));
    assert.ok(t.length >= 1 && t.length <= 2, 'نصف ساعة لا تتّسع لثلاثة بفاصل عشرين دقيقة');
  }
  assert.equal(pc.planTimes(s, s + 9 * MIN, 3, prng(1)).length, 0);
  assert.equal(pc.planTimes(s, s + 90 * MIN, 3, () => 0.5).length, 1, 'مولّدٌ ثابت: المواعيد متطابقة فيُنقص العدد');
  assert.equal(pc.dailyCount(() => 0.1), 2);
  assert.equal(pc.dailyCount(() => 0.9), 3);
  const seen = new Set(Array.from({ length: 200 }, () => pc.dailyCount()));
  assert.deepEqual([...seen].sort(), [2, 3], 'المولّد الآمن يعطي الاثنين');
});

test('النافذة: بعد الحضور بعشرين دقيقة إلى قبل نهاية الدوام بعشرين — وبلا نهاية تسع ساعات، ويوم المندوب بتوقيت جواله', () => {
  const rep = { shiftStart: '08:00', shiftEnd: '17:00', tzOffsetMin: 180 };
  const w = pc.presenceWindow(rep, riyadh(8), riyadh(8, 1));
  assert.equal(w.day, '2026-10-22');
  assert.equal(w.start, +riyadh(8, 20));
  assert.equal(w.end, +riyadh(16, 40));
  assert.equal(w.windowEndAt, +riyadh(17));
  const free = pc.presenceWindow({ ...rep, shiftEnd: null }, riyadh(8), riyadh(8, 1));
  assert.equal(free.windowEndAt, +riyadh(17), 'تسع ساعات من الحضور');
  const overtime = pc.presenceWindow(rep, riyadh(18), riyadh(18, 1));
  assert.equal(overtime.windowEndAt, +riyadh(18) + 9 * 60 * MIN, 'حضورٌ مسائي بعد موعد النهاية: تسع ساعات');
  const dayNoEnd = pc.presenceWindow({ ...rep, shiftEnd: null }, riyadh(16, 0), riyadh(16, 1));
  assert.equal(dayNoEnd.windowEndAt, +riyadh(23), 'حضورٌ نهاري بلا موعد نهاية: لا طلب بعد ١١ ليلاً');
  const evening = pc.presenceWindow({ ...rep, shiftEnd: null }, riyadh(20), riyadh(20, 1));
  assert.equal(evening.windowEndAt, +riyadh(20) + 9 * 60 * MIN, 'دوامٌ مسائي بلا موعد نهاية: تسع ساعات (لا ساعاتٌ آمنة بعد ١١ ليلاً)');
  const lastMinutes = pc.presenceWindow(rep, riyadh(16, 30), riyadh(16, 31));
  assert.equal(lastMinutes.windowEndAt, +riyadh(17), 'حضورٌ في آخر دقائق الدوام: نافذته إلى نهايته لا إلى الليل');
  assert.ok(lastMinutes.end <= lastMinutes.start, 'نافذةٌ أضيق من أن يُخطَّط فيها');
  const afterMidnight = pc.presenceWindow({ shiftStart: '22:00', shiftEnd: '06:00', tzOffsetMin: 180 }, riyadh(0, 30), riyadh(0, 31));
  assert.equal(afterMidnight.day, '2026-10-21', 'دوامٌ ليلي: الحضور بعد منتصف الليل من ليلة أمس');
  assert.equal(afterMidnight.windowEndAt, +riyadh(6));
  const night = pc.presenceWindow({ shiftStart: '22:00', shiftEnd: '06:00', tzOffsetMin: 180 }, riyadh(22), riyadh(22, 1));
  assert.equal(night.windowEndAt, +riyadh(22) + 8 * 60 * MIN, 'دوامٌ يعبر منتصف الليل');
  const enabledLate = pc.presenceWindow(rep, riyadh(8), riyadh(14));
  assert.equal(enabledLate.start, +riyadh(14, 5), 'فُعّل القيد أثناء النوبة: من الآن');
});

test('حكم الردّ: دقيقتان (وهامش شبكة) في الوقت، ثم متأخر حتى ربع ساعة، ثم فات', () => {
  const sent = riyadh(10);
  assert.equal(pc.presenceOutcome(sent, new Date(+sent + 119_000)), 'PASSED');
  assert.equal(pc.presenceOutcome(sent, new Date(+sent + pc.PRESENCE_RESPONSE_MS + pc.PRESENCE_GRACE_MS)), 'PASSED');
  assert.equal(pc.presenceOutcome(sent, new Date(+sent + pc.PRESENCE_RESPONSE_MS + pc.PRESENCE_GRACE_MS + 1)), 'LATE');
  assert.equal(pc.presenceOutcome(sent, new Date(+sent + pc.PRESENCE_LATE_MS)), 'LATE');
  assert.equal(pc.presenceOutcome(sent, new Date(+sent + pc.PRESENCE_LATE_MS + 1)), null);
});

test('نصّ الإشعار بلغة الجهاز ويفتح طلب التحقق', () => {
  const p = pc.presencePayload('ar');
  assert.equal(p.title, 'أثبت تواجدك');
  assert.equal(p.url, '/rep?screen=presence');
  assert.equal(p.tag, 'presence');
  assert.match(pc.presencePayload('en').title, /on site/);
  assert.equal(pc.presencePayload('xx').title, 'أثبت تواجدك');
  assert.equal(pc.presencePayload('ar', 'c9').checkId, 'c9', 'يحمل معرّف الطلب فيُغلق التطبيق إشعاره وحده');
});

// ═══ الحلقة ═══
const addRep = (o: Partial<Rep> = {}): Rep => {
  const r: Rep = { id: `r${reps.length + 1}`, tenantId: 't1', requirePresenceCheck: true, isActive: true, tenantOn: true, shiftStart: '08:00', shiftEnd: '17:00', tzOffsetMin: 180, ...o };
  reps.push(r);
  return r;
};

test('التخطيط مرّةً لكل يوم عند أول نوبةٍ مفتوحة، ولا تخطيط لغير المقيَّد أو لمن لا نوبة له', async () => {
  reset();
  const a = addRep();
  addRep({ requirePresenceCheck: false });
  addRep(); // بلا نوبة
  shifts.push({ salesRepId: a.id, checkInAt: riyadh(8), checkOutAt: null }, { salesRepId: 'r2', checkInAt: riyadh(8), checkOutAt: null });
  const r1 = await pc.runPresenceChecks(riyadh(8, 1), countThen(0.4));
  assert.equal(r1.planned, 2, 'مرّتان بمولّدٍ < ٠٫٥');
  assert.ok(checks.every((c) => c.salesRepId === a.id && c.status === 'SCHEDULED' && c.day === '2026-10-22'));
  // انصرف وعاد في اليوم نفسه: لا تخطيط ثانٍ
  pc._resetPresenceLoop();
  assert.equal((await pc.runPresenceChecks(riyadh(8, 10), countThen(0.9))).planned, 0);
  assert.equal(checks.length, 2);
});

test('الموعد يُرسل للنوبة المفتوحة بإشعارٍ صلاحيته ربع ساعة، ويُؤجَّل عشوائياً في الاستراحة، ويسقط بعد نافذته', async () => {
  reset();
  const a = addRep();
  shifts.push({ salesRepId: a.id, checkInAt: riyadh(8), checkOutAt: null });
  checks.push(
    { id: 'due', tenantId: 't1', salesRepId: a.id, day: '2026-10-22', dueAt: riyadh(10), windowEndAt: riyadh(17), status: 'SCHEDULED', sentAt: null, pushSent: null },
    { id: 'later', tenantId: 't1', salesRepId: a.id, day: '2026-10-22', dueAt: riyadh(13), windowEndAt: riyadh(17), status: 'SCHEDULED', sentAt: null, pushSent: null },
  );
  markers.add(`pc:plan:${a.id}:2026-10-22`);
  const r = await pc.runPresenceChecks(riyadh(10, 0), () => 0.5);
  assert.equal(r.sent, 1);
  const due = checks.find((c) => c.id === 'due')!;
  assert.equal(due.status, 'SENT');
  assert.equal(due.pushSent, 1);
  assert.equal(pushes[0].payload.tag, 'presence');
  assert.equal(pushes[0].ttlSec, pc.PRESENCE_LATE_MS / 1000);
  assert.equal(checks.find((c) => c.id === 'later')!.status, 'SCHEDULED', 'لم يحن بعد');
  // انصرف للاستراحة: الموعد التالي يُؤجَّل لا يُرسل
  shifts[0].checkOutAt = riyadh(12, 50);
  await pc.runPresenceChecks(riyadh(13, 0), () => 0.5);
  const later = checks.find((c) => c.id === 'later')!;
  assert.equal(later.status, 'SCHEDULED');
  assert.ok(+later.dueAt >= +riyadh(13, 10) && +later.dueAt <= +riyadh(13, 40), 'تأجيلٌ بين ١٠ و٤٠ دقيقة');
  // لم يعد حتى قبيل نهاية النافذة: يسقط
  await pc.runPresenceChecks(riyadh(16, 55), () => 0.5);
  assert.equal(later.status, 'SKIPPED');
});

test('بلا ردٍّ ربع ساعة ⇒ MISSED، وقيدٌ أُطفئ أو شركةٌ أوقفت الميزة ⇒ SKIPPED، والجهاز بلا تنبيهات pushSent=0', async () => {
  reset();
  const a = addRep();
  shifts.push({ salesRepId: a.id, checkInAt: riyadh(8), checkOutAt: null });
  checks.push({ id: 'old', tenantId: 't1', salesRepId: a.id, day: '2026-10-22', dueAt: riyadh(9), windowEndAt: riyadh(17), status: 'SENT', sentAt: riyadh(9), pushSent: 1 });
  checks.push({ id: 'now', tenantId: 't1', salesRepId: a.id, day: '2026-10-22', dueAt: riyadh(9, 30), windowEndAt: riyadh(17), status: 'SCHEDULED', sentAt: null, pushSent: null });
  markers.add(`pc:plan:${a.id}:2026-10-22`);
  pushDevices = 0;
  const r = await pc.runPresenceChecks(riyadh(9, 30), () => 0.5);
  assert.equal(r.missed, 1);
  assert.equal(checks.find((c) => c.id === 'old')!.status, 'MISSED');
  assert.equal(checks.find((c) => c.id === 'now')!.pushSent, 0, 'لا تنبيهات مفعّلة على جهازه — تراه الإدارة');
  a.requirePresenceCheck = false;
  checks.push({ id: 'off', tenantId: 't1', salesRepId: a.id, day: '2026-10-22', dueAt: riyadh(11), windowEndAt: riyadh(17), status: 'SCHEDULED', sentAt: null, pushSent: null });
  await pc.runPresenceChecks(riyadh(11), () => 0.5);
  assert.equal(checks.find((c) => c.id === 'off')!.status, 'SKIPPED');
});

// ═══ المسارات ═══
interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => unknown }[] } }
function handler(method: string, p: string) {
  for (const l of (trackingRouter as unknown as { stack: Layer[] }).stack) {
    if (l.route && l.route.path === p && l.route.methods[method]) return l.route.stack[l.route.stack.length - 1].handle;
  }
  throw new Error(`نقطة غير مسجّلة: ${method} ${p}`);
}
async function call(method: string, p: string, o: { params?: unknown; body?: unknown; user?: unknown } = {}) {
  const res = { statusCode: 200, body: null as Record<string, unknown> | null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b as Record<string, unknown>; return this; } };
  let err: unknown = null;
  await handler(method, p)({ user: o.user ?? { role: 'SALES_REP', id: 'r1', tenantId: 't1' }, params: o.params ?? {}, body: o.body ?? {}, query: {}, headers: {}, get: () => 'Mozilla/5.0 (Linux; Android 14)' }, res, (e?: unknown) => { err = e ?? null; });
  if (err) throw err;
  return res;
}

test('الطلب المعلّق وحده يصل التطبيق — لا موعدٌ قادم — والردّ في دقيقتين PASSED بموقعه وأقرب عميل وجهازه، والضغطة الثانية تُردّ', async () => {
  reset();
  addRep({ requireBoundDevice: true, boundDeviceId: 'dev-A' });
  const sentAt = new Date(Date.now() - 60_000);
  checks.push(
    { id: 'p1', tenantId: 't1', salesRepId: 'r1', day: '2026-10-22', dueAt: sentAt, windowEndAt: new Date(Date.now() + 3600_000), status: 'SENT', sentAt, pushSent: 1 },
    { id: 'future', tenantId: 't1', salesRepId: 'r1', day: '2026-10-22', dueAt: new Date(Date.now() + 1800_000), windowEndAt: new Date(Date.now() + 3600_000), status: 'SCHEDULED', sentAt: null, pushSent: null },
  );
  const pending = await call('get', '/presence');
  assert.equal((pending.body!.data as { id: string }).id, 'p1');
  assert.ok(!JSON.stringify(pending.body).includes('future'), 'موعدٌ قادم لا يصل التطبيق');
  const r = await call('post', '/presence/:id/respond', { params: { id: 'p1' }, body: { lat: 24.7136, lng: 46.6753, accuracy: 12, deviceId: 'dev-B', deviceName: 'SM-S918B · Android 14' } });
  assert.deepEqual(r.body!.data, { status: 'PASSED', located: true });
  const c = checks.find((x) => x.id === 'p1')!;
  assert.equal(c.status, 'PASSED');
  assert.equal(c.lat, 24.7136);
  assert.equal(c.accuracy, 12);
  assert.ok(typeof c.distanceM === 'number' && (c.distanceM as number) < 60);
  assert.equal(c.otherDevice, true, 'ردٌّ من غير الجهاز المربوط يُوسم');
  assert.ok((c.delaySec as number) >= 59 && (c.delaySec as number) <= 61);
  // ضغطةٌ ثانية (أو ردٌّ أُعيد بعد ضياع جوابه): حكم الأول كما سُجّل — لا تُكتب ثانية
  const again = await call('post', '/presence/:id/respond', { params: { id: 'p1' }, body: { lat: 1, lng: 1 } });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.body!.data, { status: 'PASSED', located: true });
  assert.equal(c.lat, 24.7136, 'لم يُكتب الثاني');
});

test('الردّ بعد الدقيقتين LATE، وبلا موقع يُقبل ويُعرف، وبعد ربع ساعة يُردّ، وطلب مندوبٍ آخر 404', async () => {
  reset();
  addRep();
  const mk = (id: string, agoMs: number, repId = 'r1') => checks.push({ id, tenantId: 't1', salesRepId: repId, day: '2026-10-22', dueAt: new Date(Date.now() - agoMs), windowEndAt: new Date(Date.now() + 3600_000), status: 'SENT', sentAt: new Date(Date.now() - agoMs), pushSent: 1 });
  mk('late', 5 * MIN);
  mk('gone', 16 * MIN);
  mk('other', MIN, 'r9');
  const late = await call('post', '/presence/:id/respond', { params: { id: 'late' }, body: {} });
  assert.deepEqual(late.body!.data, { status: 'LATE', located: false });
  assert.equal(checks.find((c) => c.id === 'late')!.lat, null);
  const gone = await call('post', '/presence/:id/respond', { params: { id: 'gone' }, body: { lat: 24.7, lng: 46.6 } });
  assert.equal(gone.statusCode, 409);
  assert.equal(gone.body!.code, 'PRESENCE_EXPIRED');
  assert.equal((await call('post', '/presence/:id/respond', { params: { id: 'other' }, body: {} })).statusCode, 404);
});

test('حارس ثابت: الحلقة تبدأ مع الخادم وتُطفأ بمتغيّر، والنبضة تحمل الطلب المعلّق للمقيَّد وحده، والإدارة لا ترى المواعيد القادمة', () => {
  const idx = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8');
  assert.match(idx, /startPresenceChecks\(\);/);
  const svc = fs.readFileSync(path.join(SRC, 'services', 'presenceChecks.ts'), 'utf8');
  assert.match(svc, /PRESENCE_CHECKS_ENABLED/);
  assert.match(svc, /crypto\.randomInt/);
  const tr = fs.readFileSync(path.join(SRC, 'routes', 'tracking.ts'), 'utf8');
  assert.match(tr, /const presence = beat\.requirePresenceCheck && \(await attendanceEnabled\(tid\)\) \? await pendingPresence\(tid, repId, now\) : null;/);
  const admin = fs.readFileSync(path.join(SRC, 'routes', 'attendanceAdmin.ts'), 'utf8');
  assert.match(admin, /status: \{ not: 'SCHEDULED' \}, day: \{ gte: q\.from, lte: q\.to \}/);
  const reps = fs.readFileSync(path.join(SRC, 'routes', 'salesReps.ts'), 'utf8');
  assert.match(reps, /requirePresenceCheck: z\.boolean\(\)\.optional\(\),/);
});

// ═══ إصلاحات المراجعة ═══
test('نوبةٌ منسيّة مفتوحة من أمس: يومٌ جديد يُخطَّط له من موعد بداية الدوام لا منتصف الليل — وترك الانصراف لا يُعفي', async () => {
  reset();
  const a = addRep();
  shifts.push({ id: 'old', salesRepId: a.id, checkInAt: riyadh(8 - 24), checkOutAt: null }); // حضر أمس ولم ينصرف
  checks.push({ id: 'y', tenantId: 't1', salesRepId: a.id, day: '2026-10-21', dueAt: riyadh(10 - 24), windowEndAt: riyadh(17 - 24), status: 'MISSED', sentAt: riyadh(10 - 24), pushSent: 1 });
  assert.equal((await pc.runPresenceChecks(riyadh(2, 0), countThen(0.9))).planned, 0, 'لا تخطيط قبل بداية دوامه');
  pc._resetPresenceLoop();
  const r = await pc.runPresenceChecks(riyadh(8, 5), countThen(0.9));
  assert.equal(r.planned, 3);
  const today = checks.filter((c) => c.day === '2026-10-22');
  assert.equal(today.length, 3);
  assert.ok(today.every((c) => +c.dueAt >= +riyadh(8, 25) && +c.dueAt < +riyadh(16, 40)), 'داخل دوام اليوم');
});

test('دوامٌ على فترتين: بعد استراحةٍ طويلة يُوزَّع ما لم يُرسل على نافذة المساء — لا يتكدّس فور العودة ولا بعد منتصف الليل', async () => {
  reset();
  const a = addRep({ shiftEnd: null });
  shifts.push({ id: 'morning', salesRepId: a.id, checkInAt: riyadh(8), checkOutAt: riyadh(12) }, { id: 'evening', salesRepId: a.id, checkInAt: riyadh(16), checkOutAt: null });
  const row = (id: string, status: string): Check => ({ id, tenantId: 't1', salesRepId: a.id, day: '2026-10-22', dueAt: riyadh(13), windowEndAt: riyadh(17), status, sentAt: status === 'PASSED' ? riyadh(9) : null, pushSent: 1 });
  checks.push(row('m1', 'PASSED'), row('s1', 'SKIPPED'), row('s2', 'SCHEDULED'));
  const r = await pc.runPresenceChecks(riyadh(16, 2), prng(3));
  assert.equal(r.planned, 2);
  for (const id of ['s1', 's2']) {
    const c = checks.find((x) => x.id === id)!;
    assert.equal(c.status, 'SCHEDULED');
    assert.ok(+c.dueAt >= +riyadh(16, 3) && +c.dueAt < +riyadh(22, 40), 'داخل نافذة المساء (بلا هامشٍ بعد العودة)، قبل الحادية عشرة ليلاً');
    assert.equal(+c.windowEndAt, +riyadh(23));
  }
  pc._resetPresenceLoop();
  assert.equal((await pc.runPresenceChecks(riyadh(16, 10), prng(4))).planned, 0, 'مرّةً لكل نوبة');
});

test('استراحةٌ قصيرة (انصرافٌ وحضورٌ متتاليان) لا تعيد سحب المواعيد', async () => {
  reset();
  const a = addRep();
  shifts.push({ id: 'n1', salesRepId: a.id, checkInAt: riyadh(8), checkOutAt: riyadh(11) }, { id: 'n2', salesRepId: a.id, checkInAt: riyadh(11, 10), checkOutAt: null });
  checks.push({ id: 'q', tenantId: 't1', salesRepId: a.id, day: '2026-10-22', dueAt: riyadh(14), windowEndAt: riyadh(17), status: 'SCHEDULED', sentAt: null, pushSent: null });
  await pc.runPresenceChecks(riyadh(11, 12), prng(5));
  assert.equal(+checks[0].dueAt, +riyadh(14), 'لم يُعد سحبه');
});

test('موعدان حلّا معاً (تأجّلا في استراحةٍ واحدة): يُرسل أحدهما ويُؤجَّل الآخر — لا طلبان متلاصقان يُحسب أحدهما «بلا ردّ»', async () => {
  reset();
  const a = addRep();
  shifts.push({ salesRepId: a.id, checkInAt: riyadh(8), checkOutAt: null });
  markers.add(`pc:plan:${a.id}:2026-10-22`);
  for (const id of ['x1', 'x2']) checks.push({ id, tenantId: 't1', salesRepId: a.id, day: '2026-10-22', dueAt: riyadh(13), windowEndAt: riyadh(17), status: 'SCHEDULED', sentAt: null, pushSent: null });
  const r = await pc.runPresenceChecks(riyadh(13, 1), () => 0.5);
  assert.equal(r.sent, 1);
  const later = checks.find((c) => c.status === 'SCHEDULED')!;
  assert.ok(+later.dueAt > +riyadh(13, 1), 'الثاني مؤجَّل');
});

test('الضغط ثم المشي: ردٌّ وصل بعد الضغط بأكثر من ٧٥ ثانية يُحكم بلحظة وصوله لا بالضغط', async () => {
  reset();
  addRep();
  const sentAt = new Date(Date.now() - 200_000);
  checks.push({ id: 'walk', tenantId: 't1', salesRepId: 'r1', day: '2026-10-22', dueAt: sentAt, windowEndAt: new Date(Date.now() + 3600_000), status: 'SENT', sentAt, pushSent: 1, tappedAt: new Date(Date.now() - 90_000) });
  const r = await call('post', '/presence/:id/respond', { params: { id: 'walk' }, body: { lat: 24.7136, lng: 46.6753 } });
  assert.deepEqual(r.body!.data, { status: 'LATE', located: true });
  assert.equal(pc.PRESENCE_TAP_HOLD_MS, 75_000);
});

test('لحظة الضغط يُحكم بها: ضغطٌ في الدقيقتين وقراءةٌ بطيئة وصلت بعدهما ⇒ في الوقت، ومن ضغط لا يُكنس «بلا ردّ» وردُّه في الطريق', async () => {
  reset();
  addRep();
  const sentAt = new Date(Date.now() - 110_000);
  checks.push({ id: 't1c', tenantId: 't1', salesRepId: 'r1', day: '2026-10-22', dueAt: sentAt, windowEndAt: new Date(Date.now() + 3600_000), status: 'SENT', sentAt, pushSent: 1 });
  const tap = await call('post', '/presence/:id/tap', { params: { id: 't1c' } });
  assert.deepEqual(tap.body!.data, { tapped: true });
  // القراءة والشبكة أخذتا ٤٠ ثانية: الوصول بعد الدقيقتين وهامشهما
  checks[0].tappedAt = new Date(Date.now() - 40_000);
  checks[0].sentAt = new Date(Date.now() - 150_000);
  const r = await call('post', '/presence/:id/respond', { params: { id: 't1c' }, body: { lat: 24.7136, lng: 46.6753, accuracy: 9 } });
  assert.deepEqual(r.body!.data, { status: 'PASSED', located: true });
  assert.equal(checks[0].delaySec, 110, 'التأخّر حتى لحظة الضغط');
  // ردٌّ وصل وضاع جوابه فأُعيد: حكمه كما سُجّل لا «انتهى»
  const again = await call('post', '/presence/:id/respond', { params: { id: 't1c' }, body: {} });
  assert.deepEqual(again.body!.data, { status: 'PASSED', located: true });
  // من ضغط قبل نهاية الربع ساعة وردُّه لم يصل بعد: لا يُكنس MISSED حتى تمضي مهلة الضغط
  reset();
  const old = new Date(Date.now() - pc.PRESENCE_LATE_MS - 30_000);
  checks.push({ id: 'held', tenantId: 't1', salesRepId: 'r1', day: '2026-10-22', dueAt: old, windowEndAt: new Date(Date.now() + 3600_000), status: 'SENT', sentAt: old, pushSent: 1, tappedAt: new Date(Date.now() - 60_000) });
  await pc.runPresenceChecks(new Date(), () => 0.5);
  assert.equal(checks[0].status, 'SENT');
  await pc.runPresenceChecks(new Date(Date.now() + pc.PRESENCE_TAP_HOLD_MS), () => 0.5);
  assert.equal(checks[0].status, 'MISSED');
});

test('حضورٌ وانصرافٌ متناوبان (٢٠ دقيقة حضور ثم ٣٠ انصراف) لا يُعفيان من التحقق: لا «فترة آمنة» بعد العودة', async () => {
  reset();
  const a = addRep();
  let sent = 0;
  for (let day = 0; day < 20; day++) {
    checks = []; shifts = []; markers = new Set(); pushes = []; pc._resetPresenceLoop();
    const base = +riyadh(8) + day * 24 * 60 * MIN;
    const rand = prng(100 + day);
    let t = base;
    let n = 0;
    while (t < base + 9 * 60 * MIN) {
      shifts.push({ id: `s${day}-${n}`, salesRepId: a.id, checkInAt: new Date(t), checkOutAt: null });
      for (let k = t; k < t + 20 * MIN; k += 30_000) await pc.runPresenceChecks(new Date(k), rand);
      shifts[shifts.length - 1].checkOutAt = new Date(t + 20 * MIN);
      for (let k = t + 20 * MIN; k < t + 50 * MIN; k += 120_000) await pc.runPresenceChecks(new Date(k), rand);
      t += 50 * MIN;
      n++;
    }
    sent += checks.filter((c) => c.sentAt != null).length;
  }
  assert.ok(sent / 20 >= 0.5, `المُرسل يومياً ${sent / 20} — نمطٌ يكاد يُعفي من التحقق`);
});
