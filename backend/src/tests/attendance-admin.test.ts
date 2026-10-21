// التعديل الإداري لبصمات الحضور ورفعها من Excel، وتوقيت تنبيهات الحضور، ووصف جهاز البصمة (طلب المالك، ٢١ أكتوبر ٢٠٢٦).
// المسارات فوق Prisma مزيّف في الذاكرة — بلا قاعدة.
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

type Row = { id: string; tenantId: string; salesRepId: string; checkInAt: Date; checkOutAt: Date | null; source: string; editedAt: Date | null; editedBy: string | null };
let rows: Row[] = [];
let audits: Array<Record<string, unknown>> = [];
let seq = 0;
let inScope = true;
const REPS = new Set(['rep1', 'rep2']);

const inRange = (v: Date | null, c: Record<string, Date>) => v != null && (!c.gte || v >= c.gte) && (!c.gt || v > c.gt) && (!c.lt || v < c.lt);
const repAttendance = {
  async findMany(args: { where: Record<string, unknown> }) {
    const w = args.where as { tenantId: string; salesRepId: string; checkInAt?: Record<string, Date>; OR?: Array<Record<string, unknown>> };
    return rows.filter((r) => r.tenantId === w.tenantId && r.salesRepId === w.salesRepId
      && (!w.checkInAt || inRange(r.checkInAt, w.checkInAt))
      && (!w.OR || w.OR.some((o) => (o.checkOutAt === null ? r.checkOutAt === null : inRange(r.checkOutAt, o.checkOutAt as Record<string, Date>)))))
      .map((r) => ({ ...r }));
  },
  async findFirst(args: { where: { id: string; tenantId: string } }) {
    const r = rows.find((x) => x.id === args.where.id && x.tenantId === args.where.tenantId);
    return r ? { ...r } : null;
  },
  async create(args: { data: Partial<Row> }) {
    const r = { id: `a${++seq}`, checkOutAt: null, source: 'APP', editedAt: null, editedBy: null, ...args.data } as Row;
    rows.push(r); return { ...r };
  },
  async update(args: { where: { id: string }; data: Partial<Row> }) {
    const r = rows.find((x) => x.id === args.where.id)!; Object.assign(r, args.data); return { ...r };
  },
  async delete(args: { where: { id: string } }) { rows = rows.filter((x) => x.id !== args.where.id); return {}; },
  async createMany(args: { data: Partial<Row>[] }) {
    for (const d of args.data) rows.push({ id: `a${++seq}`, checkOutAt: null, source: 'APP', editedAt: null, editedBy: null, ...d } as Row);
    return { count: args.data.length };
  },
};
const attendanceAudit = {
  async create(args: { data: Record<string, unknown> }) { audits.push(args.data); return args.data; },
  async findMany() { return audits; },
};
const salesRep = {
  async findFirst(args: { where: { id: string; tenantId: string } }) { return REPS.has(args.where.id) && args.where.tenantId === 't1' ? { id: args.where.id } : null; },
  async findMany(args: { where: { id?: { in: string[] }; tenantId: string } }) {
    if (!args.where.id) return args.where.tenantId === 't1' ? [...REPS].filter((id) => inScope || id !== 'rep2').map((id) => ({ id, name: id, username: id })) : [];
    return args.where.id.in.filter((id) => REPS.has(id) && (inScope || id !== 'rep2')).map((id) => ({ id }));
  },
};
const tenant = { async findUnique() { return { attendanceEnabled: true }; } };
const db: Record<string, unknown> = { repAttendance, attendanceAudit, salesRep, tenant, $executeRaw: async () => 0 };
db.$transaction = async (fn: (tx: unknown) => unknown) => fn(db);
stub('config/database', { default: db });
stub('middleware/auth', {
  authenticate: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireAdmin: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireAdminPermission: () => (_q: unknown, _s: unknown, next: () => void) => next(),
  tenantId: (req: { user?: { tenantId?: string } }) => req.user!.tenantId!,
  actorOf: (req: { user?: { id?: string } }) => req.user?.id ?? '',
  isOwnerSession: (req: { user?: { impersonated?: boolean } }) => req.user?.impersonated === true,
});
stub('services/adminScope', { adminRepFilter: async () => ({}), canAccessRep: async (_r: unknown, _t: string, id: string) => inScope || id !== 'rep2' });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../routes/attendanceAdmin').default as Router;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const edit = require('../services/attendanceEdit') as typeof import('../services/attendanceEdit');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const alerts = require('../services/attendanceAlerts') as typeof import('../services/attendanceAlerts');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dev = require('../services/punchDevice') as typeof import('../services/punchDevice');

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => unknown }[] } }
function handler(method: string, p: string) {
  for (const l of (router as unknown as { stack: Layer[] }).stack) {
    if (l.route && l.route.path === p && l.route.methods[method]) return l.route.stack[l.route.stack.length - 1].handle;
  }
  throw new Error(`نقطة غير مسجّلة: ${method} ${p}`);
}
const ADMIN = { role: 'ADMIN', id: 'adm1', name: 'مدير الشركة', tenantId: 't1' };
async function call(method: string, p: string, opts: { body?: unknown; query?: unknown; params?: unknown; user?: unknown } = {}) {
  const res = { statusCode: 200, body: null as Record<string, unknown> | null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b as Record<string, unknown>; return this; } };
  let err: unknown = null;
  await handler(method, p)({ user: opts.user ?? ADMIN, body: opts.body ?? {}, query: opts.query ?? {}, params: opts.params ?? {} }, res, (e?: unknown) => { err = e ?? null; });
  if (err) throw err;
  return res;
}
const H = (h: number, d = 5) => new Date(Date.UTC(2026, 9, d, h, 0, 0)).toISOString();
const reset = () => { rows = []; audits = []; seq = 0; inScope = true; };

// ═══ الحدود والتداخل — منطق صرف ═══
test('حدود الفترة: لا مستقبل، الانصراف بعد الحضور، لا فوق ٢٤ ساعة، ولا أقدم من ٤٠٠ يوم', () => {
  const now = new Date('2026-10-21T12:00:00Z');
  const p = (a: string, b: string | null) => edit.shiftProblem({ checkInAt: new Date(a), checkOutAt: b ? new Date(b) : null }, now);
  assert.equal(p('2026-10-21T05:00:00Z', '2026-10-21T11:00:00Z'), null);
  assert.equal(p('2026-10-21T05:00:00Z', null), null, 'حضورٌ مفتوح');
  assert.match(String(p('2026-10-21T13:00:00Z', null)), /المستقبل/);
  assert.match(String(p('2026-10-21T05:00:00Z', '2026-10-21T12:30:00Z')), /المستقبل/);
  assert.match(String(p('2026-10-21T05:00:00Z', '2026-10-21T05:00:00Z')), /بعد وقت الحضور/);
  assert.match(String(p('2026-10-19T05:00:00Z', '2026-10-20T06:00:00Z')), /٢٤ ساعة/);
  // مراجعة ٢١ أكتوبر: حضورٌ يساوي انصرافه في كشف جهاز البصمة يصير ٢٤ ساعةً بالضبط — يُرفض
  assert.match(String(p('2026-10-19T08:00:00Z', '2026-10-20T08:00:00Z')), /٢٤ ساعة/);
  // وفترةٌ مفتوحة في تاريخٍ مضى تمتدّ إلى الآن فتبتلع ما بعدها وتصير نوبة المندوب الحالية — يُطلب انصرافها
  assert.match(String(p('2026-10-02T05:00:00Z', null)), /أدخل وقت الانصراف/);
  assert.match(String(p('2026-10-20T12:00:00Z', null)), /أدخل وقت الانصراف/, '٢٤ ساعة بالضبط');
  assert.equal(p('2026-10-20T12:30:00Z', null), null, 'نوبةٌ ليلية ما زالت جارية');
  assert.match(String(p('2025-01-01T05:00:00Z', '2025-01-01T06:00:00Z')), /أقدم/);
  assert.match(String(p('nonsense', null)), /غير صالح/);
});

test('التداخل: المفتوحة تمتدّ إلى الآن، والتلامس ليس تداخلاً، والفترة نفسها تُستثنى عند تعديلها', () => {
  const now = new Date('2026-10-05T20:00:00Z');
  const others = [
    { id: 'x', checkInAt: new Date('2026-10-05T06:00:00Z'), checkOutAt: new Date('2026-10-05T10:00:00Z') },
    { id: 'o', checkInAt: new Date('2026-10-05T14:00:00Z'), checkOutAt: null },
  ];
  const s = (a: string, b: string | null) => ({ checkInAt: new Date(a), checkOutAt: b ? new Date(b) : null });
  assert.equal(edit.overlappingShift(s('2026-10-05T10:00:00Z', '2026-10-05T12:00:00Z'), others, now), null, 'تلامس');
  assert.equal(edit.overlappingShift(s('2026-10-05T09:00:00Z', '2026-10-05T11:00:00Z'), others, now)?.id, 'x');
  assert.equal(edit.overlappingShift(s('2026-10-05T18:00:00Z', '2026-10-05T19:00:00Z'), others, now)?.id, 'o', 'المفتوحة حتى الآن');
  assert.equal(edit.overlappingShift(s('2026-10-05T07:00:00Z', '2026-10-05T09:00:00Z'), others, now, 'x'), null, 'تعديل الفترة نفسها');
  assert.equal(edit.overlappingShift(s('2026-10-05T12:00:00Z', null), others, now)?.id, 'o', 'نوبتان مفتوحتان لا تجتمعان');
});

// ═══ المسارات ═══
test('إضافة فترة: مصدرها ADMIN باسم من أضافها، وسطرٌ في سجلّ التدقيق بسببه', async () => {
  reset();
  const r = await call('post', '/rows', { body: { salesRepId: 'rep1', checkInAt: H(5), checkOutAt: H(13), reason: 'نسي البصمة صباحاً' } });
  assert.equal(r.statusCode, 201);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'ADMIN');
  assert.equal(rows[0].editedBy, 'مدير الشركة');
  assert.equal(audits[0].action, 'CREATE');
  assert.equal(audits[0].reason, 'نسي البصمة صباحاً');
  assert.deepEqual(audits[0].after, { checkInAt: H(5), checkOutAt: H(13) });
});

test('إضافة فترة: السبب إلزامي، والمتداخلة 409 بالفترة المتعارضة، ومندوبٌ خارج النطاق 404', async () => {
  reset();
  await assert.rejects(call('post', '/rows', { body: { salesRepId: 'rep1', checkInAt: H(5), checkOutAt: H(6) } }));
  await call('post', '/rows', { body: { salesRepId: 'rep1', checkInAt: H(5), checkOutAt: H(13), reason: 'سبب أول' } });
  const clash = await call('post', '/rows', { body: { salesRepId: 'rep1', checkInAt: H(12), checkOutAt: H(14), reason: 'سبب ثان' } });
  assert.equal(clash.statusCode, 409);
  assert.equal(clash.body!.code, 'ATTENDANCE_OVERLAP');
  assert.deepEqual(clash.body!.conflict, { checkInAt: H(5), checkOutAt: H(13) });
  inScope = false;
  assert.equal((await call('post', '/rows', { body: { salesRepId: 'rep2', checkInAt: H(5), checkOutAt: H(6), reason: 'خارج النطاق' } })).statusCode, 404);
});

test('تعديل فترة: إغلاق نوبةٍ مفتوحة على وقتها الحقيقي — بقيمتين قبل وبعد في السجلّ، وتبقى بصمة التطبيق موسومةً «معدّلة»', async () => {
  reset();
  rows.push({ id: 'p1', tenantId: 't1', salesRepId: 'rep1', checkInAt: new Date(H(5)), checkOutAt: null, source: 'APP', editedAt: null, editedBy: null });
  const r = await call('put', '/rows/:id', { params: { id: 'p1' }, body: { checkInAt: H(5), checkOutAt: H(14), reason: 'نسي الانصراف' } });
  assert.equal(r.statusCode, 200);
  assert.equal(rows[0].checkOutAt!.toISOString(), H(14));
  assert.equal(rows[0].source, 'APP');
  assert.ok(rows[0].editedAt);
  assert.equal(audits[0].action, 'UPDATE');
  assert.deepEqual(audits[0].before, { checkInAt: H(5), checkOutAt: null });
  assert.deepEqual(audits[0].after, { checkInAt: H(5), checkOutAt: H(14) });
});

test('حذف فترة: تختفي ويبقى وقتاها ومصدرها في السجلّ — وصفٌّ من شركةٍ أخرى 404', async () => {
  reset();
  rows.push({ id: 'p1', tenantId: 't1', salesRepId: 'rep1', checkInAt: new Date(H(5)), checkOutAt: new Date(H(6)), source: 'APP', editedAt: null, editedBy: null });
  rows.push({ id: 'z9', tenantId: 't2', salesRepId: 'rep1', checkInAt: new Date(H(5)), checkOutAt: new Date(H(6)), source: 'APP', editedAt: null, editedBy: null });
  assert.equal((await call('delete', '/rows/:id', { params: { id: 'p1' }, body: { reason: 'بصمة مكررة' } })).statusCode, 200);
  assert.equal(rows.filter((r) => r.tenantId === 't1').length, 0);
  assert.equal(audits[0].action, 'DELETE');
  assert.deepEqual(audits[0].before, { checkInAt: H(5), checkOutAt: H(6), source: 'APP' });
  assert.equal((await call('delete', '/rows/:id', { params: { id: 'z9' }, body: { reason: 'من شركة أخرى' } })).statusCode, 404);
});

test('رفع Excel: يُكتب الصالح بمصدر IMPORT، ويعود المرفوض برقمه وسببه (تداخلٌ داخل الملف، مستقبل، خارج النطاق)', async () => {
  reset(); inScope = false;
  const future = new Date(Date.now() + 3 * 3600_000).toISOString();
  const r = await call('post', '/import', {
    body: {
      reason: 'كشف الحضور اليدوي لشهر أكتوبر',
      rows: [
        { salesRepId: 'rep1', checkInAt: H(5, 1), checkOutAt: H(13, 1) },
        { salesRepId: 'rep1', checkInAt: H(12, 1), checkOutAt: H(15, 1) }, // يتداخل مع الأول
        { salesRepId: 'rep1', checkInAt: H(5, 2), checkOutAt: H(13, 2) },
        { salesRepId: 'rep2', checkInAt: H(5, 1), checkOutAt: H(13, 1) }, // خارج النطاق
        { salesRepId: 'rep1', checkInAt: future, checkOutAt: null },
      ],
    },
  });
  assert.equal(r.statusCode, 200);
  const d = r.body!.data as { created: number; rejected: Array<{ index: number; message: string }> };
  assert.equal(d.created, 2);
  assert.deepEqual(d.rejected.map((x) => x.index), [1, 3, 4]);
  assert.match(d.rejected[0].message, /تتداخل/);
  assert.match(d.rejected[1].message, /غير موجود/);
  assert.match(d.rejected[2].message, /المستقبل/);
  assert.ok(rows.every((x) => x.source === 'IMPORT'));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'IMPORT');
  assert.equal((audits[0].after as { count: number }).count, 2);
});

test('رفع Excel: صفٌّ مفتوح في تاريخٍ مضى يُرفض بسببه ولا يبتلع صفوف الملف بعده', async () => {
  reset();
  const r = await call('post', '/import', {
    body: {
      reason: 'كشف جهاز البصمة',
      rows: [
        { salesRepId: 'rep1', checkInAt: H(5, 2), checkOutAt: null },
        { salesRepId: 'rep1', checkInAt: H(5, 3), checkOutAt: H(13, 3) },
        { salesRepId: 'rep1', checkInAt: H(5, 4), checkOutAt: H(13, 4) },
      ],
    },
  });
  const d = r.body!.data as { created: number; rejected: Array<{ index: number; message: string }> };
  assert.equal(d.created, 2);
  assert.deepEqual(d.rejected.map((x) => x.index), [0]);
  assert.match(d.rejected[0].message, /أدخل وقت الانصراف/);
  assert.ok(rows.every((x) => x.checkOutAt !== null), 'لا نوبة مفتوحة قديمة');
});

test('رفع Excel يرى كل فترات المدى: ستون بصمةً قائمة في الشهر لا يُكتب فوق أيٍّ منها', async () => {
  reset();
  for (let d = 1; d <= 30; d++) {
    for (const [a, b] of [[5, 9], [11, 15]]) {
      rows.push({ id: `e${d}-${a}`, tenantId: 't1', salesRepId: 'rep1', checkInAt: new Date(H(a, d)), checkOutAt: new Date(H(b, d)), source: 'APP', editedAt: null, editedBy: null });
    }
  }
  const r = await call('post', '/import', {
    body: { reason: 'كشف أكتوبر', rows: Array.from({ length: 30 }, (_, i) => ({ salesRepId: 'rep1', checkInAt: H(11, i + 1), checkOutAt: H(15, i + 1) })) },
  });
  const d = r.body!.data as { created: number; rejected: unknown[] };
  assert.equal(d.created, 0);
  assert.equal(d.rejected.length, 30);
  const src = fs.readFileSync(path.join(SRC, 'services', 'attendanceEdit.ts'), 'utf8');
  const around = src.slice(src.indexOf('export async function shiftsAround('), src.indexOf('\n}', src.indexOf('export async function shiftsAround(')));
  assert.doesNotMatch(around, /take:/, 'سقفٌ يُخفي فتراتٍ فيُكتب فوقها');
});

test('رفع Excel: معاملةٌ واحدة بمهلةٍ تتّسع لألفي صفّ، وإدراجٌ دفعةً لا صفّاً صفّاً', () => {
  const src = fs.readFileSync(path.join(SRC, 'routes', 'attendanceAdmin.ts'), 'utf8');
  const h = src.slice(src.indexOf("router.post('/import'"), src.indexOf('\n});', src.indexOf("router.post('/import'")));
  assert.equal((h.match(/prisma\.\$transaction\(/g) ?? []).length, 1);
  assert.match(h, /\}, IMPORT_TX\);/);
  assert.match(h, /tx\.repAttendance\.createMany\(/);
  assert.doesNotMatch(h, /tx\.repAttendance\.create\(/);
});

test('ملفٌ فوق حدّ الصفوف يُرفض برسالةٍ تذكر الحدّ، والمعاملات تحت القفل تنتظر رفعاً طويلاً بدل السقوط بـ500', async () => {
  reset();
  const r = await call('post', '/import', { body: { reason: 'كشف كبير', rows: Array.from({ length: 2001 }, () => ({ salesRepId: 'rep1', checkInAt: H(5), checkOutAt: H(6) })) } });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body!.code, 'IMPORT_TOO_MANY_ROWS');
  assert.match(String(r.body!.message), /2000/);
  assert.ok(edit.REP_LOCK_TX.timeout > edit.IMPORT_TX.timeout + edit.IMPORT_TX.maxWait, 'البصمة تنتظر أطول رفع');
  const admin = fs.readFileSync(path.join(SRC, 'routes', 'attendanceAdmin.ts'), 'utf8');
  const tracking = fs.readFileSync(path.join(SRC, 'routes', 'tracking.ts'), 'utf8');
  for (const [src, n] of [[admin, 4], [tracking, 2]] as const) {
    const all = src.split('prisma.$transaction(async (tx) => {').length - 1;
    assert.equal(all, n);
    assert.equal((src.match(/\n    \}, (REP_LOCK_TX|IMPORT_TX)\);/g) ?? []).length, n, 'كل معاملةٍ تحت القفل بمهلتها');
  }
  const alerts = fs.readFileSync(path.join(SRC, 'services', 'attendanceAlerts.ts'), 'utf8');
  assert.match(alerts, /if \(a\.kind === 'PRE_SHIFT' && staleOpen\.has\(rep\.id\)\) continue;/, 'لا تذكير بالحضور لمن نوبته المنسيّة ما زالت مفتوحة');
});

test('مناديب ملف الرفع بصلاحية التتبّع وحدها وفي نطاق المستخدم', async () => {
  reset();
  const r = await call('get', '/reps');
  assert.deepEqual((r.body!.data as Array<{ id: string }>).map((x) => x.id).sort(), ['rep1', 'rep2']);
  inScope = false;
  assert.deepEqual((await call('get', '/reps')).body!.data, [{ id: 'rep1', name: 'rep1', username: 'rep1' }]);
});

test('معرّف الجهاز المربوط لا يصل المندوب: الدخول والتجديد يحذفانه، و/auth/me لا يختاره', () => {
  const src = fs.readFileSync(path.join(SRC, 'routes', 'auth.ts'), 'utf8');
  assert.match(src, /const \{ passwordHash: _ph, tenant: _t, boundDeviceId: _bd, tzOffsetMin: _tz, \.\.\.repData \} = rep;/);
  assert.equal((src.match(/user: \{ \.\.\.repSessionUser\(rep\), role: 'SALES_REP'/g) ?? []).length, 2, 'الدخول والتجديد');
  assert.doesNotMatch(src, /\.\.\.repData, role: 'SALES_REP'/);
  const me = src.slice(src.indexOf("if (req.user.role === 'SALES_REP') {"), src.indexOf('teamMemberships: { where'));
  assert.doesNotMatch(me, /boundDeviceId/);
  assert.match(me, /requireBoundDevice: true/, 'التطبيق يعرف القيد ليشرح آيفون');
});

test('حرّاس الموجّه: مستخدم الشركة بصلاحية التتبّع، والميزة مفعّلة، وكل كتابةٍ تحت قفل المندوب وفي سجلّ التدقيق', () => {
  const src = fs.readFileSync(path.join(SRC, 'routes', 'attendanceAdmin.ts'), 'utf8');
  assert.match(src, /router\.use\(authenticate, requireAdmin, requireAdminPermission\('canManageTracking'\)\);/);
  assert.match(src, /if \(!\(await attendanceEnabled\(tenantId\(req\)\)\)\)/);
  for (const sig of ["router.post('/rows'", "router.put('/rows/:id'", "router.delete('/rows/:id'", "router.post('/import'"]) {
    const h = src.slice(src.indexOf(sig), src.indexOf('\n});', src.indexOf(sig)));
    assert.match(h, /await lockRepAttendance\(tx, /, `${sig} بلا قفل`);
    assert.match(h, /tx\.attendanceAudit\.create\(/, `${sig} بلا تدقيق`);
  }
  const idx = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8');
  assert.match(idx, /app\.use\('\/api\/attendance-admin', attendanceAdminRouter\);/);
});

test('جلسة المالك ومفتاحه يُدوَّنان «الدعم الفني» لا باسم مدير الشركة', () => {
  assert.equal(edit.auditActorName({ user: { ...ADMIN, impersonated: true } } as never), 'الدعم الفني');
  assert.equal(edit.auditActorName({ user: { ...ADMIN, ownerIssuedKey: true } } as never), 'الدعم الفني');
  assert.equal(edit.auditActorName({ user: ADMIN } as never), 'مدير الشركة');
});

// ═══ تنبيهات الحضور ═══
const KSA = 180;
const rep = (o: Partial<import('../services/attendanceAlerts').AlertRep> = {}) => ({ id: 'r1', shiftStart: '08:00', shiftEnd: '17:00', shiftDays: 31, tzOffsetMin: KSA, ...o });
const riyadh = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2026, 9, day, hh - 3, mm)); // ١٨ أكتوبر ٢٠٢٦ أحد

test('تنبيه «قبل الدوام»: في الربع ساعة قبل بدايته، في يوم عمل، ولمن لم يبصم بعد', () => {
  const due = alerts.dueAlerts(rep(), [], riyadh(18, 7, 50));
  assert.equal(due.length, 1);
  assert.equal(due[0].kind, 'PRE_SHIFT');
  assert.equal(due[0].key, 'att:pre:r1:2026-10-18');
  assert.deepEqual(alerts.dueAlerts(rep(), [], riyadh(18, 7, 40)), [], 'قبل النافذة');
  assert.deepEqual(alerts.dueAlerts(rep(), [], riyadh(18, 8, 0)), [], 'بدأ الدوام');
  assert.deepEqual(alerts.dueAlerts(rep(), [], riyadh(23, 7, 50)), [], 'الجمعة ليست يوم عمل');
  assert.deepEqual(alerts.dueAlerts(rep(), [{ id: 's', checkInAt: riyadh(18, 7, 30), checkOutAt: riyadh(18, 7, 45) }], riyadh(18, 7, 50)), [], 'بصم اليوم');
  assert.deepEqual(alerts.dueAlerts(rep({ tzOffsetMin: null }), [], riyadh(18, 7, 50)), [], 'بلا توقيت الجوال');
  assert.deepEqual(alerts.dueAlerts(rep({ shiftStart: null }), [], riyadh(18, 7, 50)), [], 'بلا موعد');
});

test('تنبيه «قبل الدوام» لدوامٍ يبدأ بعد منتصف الليل: نافذته من مساء أمس ويومه الغد', () => {
  const due = alerts.dueAlerts(rep({ shiftStart: '00:05', shiftDays: 127 }), [], riyadh(18, 23, 55));
  assert.equal(due[0]?.key, 'att:pre:r1:2026-10-19');
});

test('تنبيه «نسيت الانصراف»: نصف ساعة بعد نهاية الدوام، وبلا موعدٍ بعد ١٠ ساعات، ودوامٌ ليليّ ينتهي غداً — مرّةً لكل نوبة', () => {
  const open = [{ id: 'sh1', checkInAt: riyadh(18, 8, 0), checkOutAt: null }];
  assert.deepEqual(alerts.dueAlerts(rep(), open, riyadh(18, 17, 20)), []);
  const d = alerts.dueAlerts(rep(), open, riyadh(18, 17, 31));
  assert.equal(d[0].kind, 'FORGOT_CHECKOUT');
  assert.equal(d[0].key, 'att:out:sh1');
  assert.deepEqual(alerts.dueAlerts(rep({ shiftEnd: null }), open, riyadh(18, 17, 59)), []);
  assert.equal(alerts.dueAlerts(rep({ shiftEnd: null }), open, riyadh(18, 18, 0))[0]?.kind, 'FORGOT_CHECKOUT');
  const night = [{ id: 'n1', checkInAt: riyadh(18, 22, 0), checkOutAt: null }];
  assert.deepEqual(alerts.dueAlerts(rep({ shiftStart: '22:00', shiftEnd: '06:00', shiftDays: 127 }), night, riyadh(19, 6, 20)), []);
  assert.equal(alerts.dueAlerts(rep({ shiftStart: '22:00', shiftEnd: '06:00', shiftDays: 127 }), night, riyadh(19, 6, 31))[0]?.key, 'att:out:n1');
});

test('نصّ التنبيه بلغة الجهاز ووقته بتوقيت المندوب، ويفتح شاشة البصمة', () => {
  const p = alerts.alertPayload('PRE_SHIFT', riyadh(18, 8, 0), KSA, 'ar');
  assert.match(p.body, /08:00/);
  assert.equal(p.url, '/rep?screen=attendance');
  assert.match(alerts.alertPayload('FORGOT_CHECKOUT', riyadh(18, 8, 0), KSA, 'en').title, /checked out/);
  assert.match(alerts.alertPayload('PRE_SHIFT', riyadh(18, 8, 0), KSA, 'xx').title, /تذكير/, 'لغةٌ مجهولة ⇒ العربية');
  assert.equal(alerts.parseHM('24:00'), null);
  assert.equal(alerts.parseHM('07:05'), 425);
});

test('حلقة التنبيهات تبدأ مع الخادم ويطفئها ATTENDANCE_ALERTS_ENABLED=false، وكل تنبيهٍ يُحجز بمفتاحٍ فريد قبل إرساله', () => {
  const src = fs.readFileSync(path.join(SRC, 'services', 'attendanceAlerts.ts'), 'utf8');
  assert.match(src, /=== 'false'\) return;/);
  assert.match(src, /const claimed = await prisma\.opsMarker\.create\(\{ data: \{ key: a\.key, value: a\.kind \} \}\)/);
  assert.ok(src.indexOf('const claimed') < src.indexOf('sendPushToRep(rep.id'), 'الحجز قبل الإرسال');
  assert.match(fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8'), /startAttendanceAlerts\(\);/);
});

// ═══ وصف الجهاز ═══
test('وصف الجهاز من User-Agent: الجوال بنظامه والكمبيوتر موسوماً، والوصف المرسل يُنقّى ويُقصّ', () => {
  assert.equal(dev.describeUserAgent('Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'), 'Android 14 · Chrome');
  assert.equal(dev.describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'), 'iPhone · iOS 17.4 · Safari');
  assert.equal(dev.describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'), 'Windows · Chrome · كمبيوتر');
  assert.equal(dev.describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'), 'macOS · Safari · كمبيوتر');
  assert.equal(dev.describeUserAgent(''), 'جهاز غير معروف');
  assert.equal(dev.cleanDeviceName('  SM-S918B\u0000 <b>x</b> '), 'SM-S918B b x /b');
  assert.equal(dev.cleanDeviceName('x'.repeat(300))!.length, dev.DEVICE_NAME_MAX);
  assert.equal(dev.deviceIdOf('0b7f2a8c-1d2e-4f3a-9b8c-7d6e5f4a3b2c'), '0b7f2a8c-1d2e-4f3a-9b8c-7d6e5f4a3b2c');
  for (const bad of ['short', 'has space inside!', 42, null, 'x'.repeat(65)]) assert.equal(dev.deviceIdOf(bad), null, String(bad));
});
