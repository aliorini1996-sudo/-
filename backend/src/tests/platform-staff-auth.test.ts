// «موظفو المنصة» — إصلاحات المراجعة الأمنية (٢٤ أكتوبر ٢٠٢٦): إعادة كلمة مرور المدير بيد الموظف تذهب إلى بريد المدير لا إليه،
// وقفل الدخول ذرّي بردٍّ واحد وعدّاد يتقادم وحدٍّ مستقل عن دخول المالك، وسحب «الدخول» يُسقط جلساته، والإسناد في السجلات
// الثابتة (تدقيق الدفاتر وسجلّ السفراء) باسم الموظف لا المالك. فوق Prisma مزيّف في الذاكرة وخادم express محلي (بلا قاعدة).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import express from 'express';

process.env.JWT_SECRET = 'platform-staff-auth-test-secret';
delete process.env.STAFF_JWT_SECRET;
const SECRET = process.env.JWT_SECRET;
const SRC = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const strip = (s: string) => s.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ─── Prisma مزيّف ───
type Row = Record<string, unknown>;
type Staff = {
  id: string; name: string; email: string; passwordHash: string; isActive: boolean; permissions: string[]; tokenVersion: number;
  mustChangePassword: boolean; failedLogins: number; lastFailedAt: Date | null; lockedUntil: Date | null; lastLoginAt: Date | null;
  lastSeenAt: Date | null; createdAt: Date;
};
type Admin = { id: string; tenantId: string; name: string; email: string; passwordHash: string; createdAt: Date };
type Audit = { id: string; at: Date; actorType: string; actorId: string; actorName: string | null; action: string; targetId: string | null; detail: string | null; status?: number };
const staff = new Map<string, Staff>();
const owners = new Map<string, { id: string; isActive: boolean }>();
const admins = new Map<string, Admin>();
const tenants = new Map<string, { id: string; name: string; accountingSuiteEnabled: boolean }>();
let audits: Audit[] = [];
let glAudits: Row[] = [];
let auditFailOn: ((action: string) => boolean) | null = null;
let seq = 0;

const pick = (row: Row | undefined | null, select?: Row) => {
  if (!row) return null;
  if (!select) return { ...row };
  const o: Row = {};
  for (const k of Object.keys(select)) o[k] = row[k];
  return o;
};
const applyData = (row: Row, data: Row) => {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as object)) (row as Record<string, number>)[k] += (v as { increment: number }).increment;
    else row[k] = v;
  }
};
const num = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
/** where: مساواة وnull وlt/lte/gt/gte وOR — وكل عبارة updateMany تُنفَّذ كاملةً قبل غيرها (كالقاعدة) */
const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([k, c]) => {
  if (k === 'OR') return (c as Row[]).some((w) => matches(row, w));
  const v = row[k] ?? null;
  if (c === null || typeof c !== 'object' || c instanceof Date) return c instanceof Date ? v instanceof Date && v.getTime() === c.getTime() : v === c;
  if (v === null) return false;
  const o = c as { lt?: unknown; lte?: unknown; gt?: unknown; gte?: unknown };
  return (o.lt === undefined || num(v) < num(o.lt)) && (o.lte === undefined || num(v) <= num(o.lte))
    && (o.gt === undefined || num(v) > num(o.gt)) && (o.gte === undefined || num(v) >= num(o.gte));
});

const glAuditLog = {
  async findFirst(a: { where: { tenantId: string }; select?: Row }) {
    const rows = glAudits.filter((r) => r.tenantId === a.where.tenantId).sort((x, y) => (y.seq as number) - (x.seq as number));
    return pick(rows[0], a.select);
  },
  async create(a: { data: Row; select?: Row }) {
    const row = { id: `g${++seq}`, ...a.data };
    glAudits.push(row);
    return pick(row, a.select);
  },
};
const tenantDelegate = {
  async findUnique(a: { where: { id: string }; select?: Row }) { return pick(tenants.get(a.where.id), a.select); },
  async update(a: { where: { id: string }; data: Row }) {
    const t = tenants.get(a.where.id);
    if (!t) throw new Error('not found');
    applyData(t, a.data);
    return { ...t };
  },
};
const prisma = {
  superAdmin: { async findUnique(a: { where: { id: string } }) { return owners.get(a.where.id) ?? null; } },
  platformStaff: {
    async findUnique(a: { where: { id?: string; email?: string }; select?: Row }) {
      const row = a.where.id ? staff.get(a.where.id) : [...staff.values()].find((s) => s.email === a.where.email);
      return pick(row, a.select);
    },
    async update(a: { where: { id: string }; data: Row; select?: Row }) {
      const row = staff.get(a.where.id);
      if (!row) throw new Error('not found');
      applyData(row, a.data);
      return pick(row, a.select);
    },
    async updateMany(a: { where: Row; data: Row }) {
      let count = 0;
      for (const row of staff.values()) if (matches(row, a.where)) { applyData(row, a.data); count++; }
      return { count };
    },
  },
  platformAuditLog: {
    async create(a: { data: Omit<Audit, 'id' | 'at'> }) {
      if (auditFailOn?.(a.data.action)) throw new Error('audit down');
      const row = { id: `a${++seq}`, at: new Date(), ...a.data } as Audit;
      audits.push(row);
      return { id: row.id };
    },
    async update(a: { where: { id: string }; data: { status: number } }) {
      const row = audits.find((x) => x.id === a.where.id);
      if (row) row.status = a.data.status;
      return {};
    },
  },
  admin: {
    async findFirst(a: { where: { id?: string; tenantId: string } }) {
      const rows = [...admins.values()].filter((x) => x.tenantId === a.where.tenantId && (!a.where.id || x.id === a.where.id))
        .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
      return rows[0] ? { ...rows[0] } : null;
    },
    async update(a: { where: { id: string }; data: Row }) {
      const row = admins.get(a.where.id);
      if (!row) throw new Error('not found');
      applyData(row, a.data);
      return { ...row };
    },
  },
  tenant: tenantDelegate,
  // تبديل العَلَم: معاملة tenants.ts PUT /:id وappendAudit (قفل استشاري ثم آخر seq ثم الإدراج)
  async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    return fn({ tenant: tenantDelegate, glAuditLog, async $executeRaw() { return 0; } });
  },
};
stub('config/database', { default: prisma });

// ─── البريد المزيّف: ما أُرسل، ومن رأى التجزئة لحظة الإرسال ───
type Mail = { to?: string; subject: string; html: string; hashAtSend?: string };
let mails: Mail[] = [];
let mailOk = true;
let hashAtSendOf: (() => string) | null = null;
stub('services/mailer', {
  async sendMail(m: Mail) { mails.push({ ...m, hashAtSend: hashAtSendOf?.() }); return mailOk; },
  mailLayout(title: string, rows: [string, string][], extra = '') { return [title, ...rows.map(([k, v]) => `${k}=${v}`), extra].join('\n'); },
});

// ─── عدّاد مقارنات bcrypt بتجزئة الحساب الحقيقية (لا الوهمية) ───
const realCompare = bcrypt.compare.bind(bcrypt);
const realHashCompares = new Map<string, number>();
(bcrypt as unknown as { compare: (p: string, h: string) => Promise<boolean> }).compare = async (p: string, h: string) => {
  realHashCompares.set(h, (realHashCompares.get(h) ?? 0) + 1);
  return realCompare(p, h);
};

/* eslint-disable @typescript-eslint/no-var-requires */
const pa = require('../services/platformAccess') as typeof import('../services/platformAccess');
const ps = require('../routes/platformStaff') as typeof import('../routes/platformStaff');
const limits = require('../middleware/rateLimits') as typeof import('../middleware/rateLimits');
const tenantsMod = require('../routes/tenants') as typeof import('../routes/tenants');
const glAudit = require('../services/gl/audit') as typeof import('../services/gl/audit');
const review = require('../routes/ledger/review') as typeof import('../routes/ledger/review');
const affCore = require('../services/affiliate/core') as typeof import('../services/affiliate/core');
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */

const app = express();
app.use(express.json());
app.use('/api/staff-auth', ps.staffAuthRouter);
app.use('/api/platform-staff', ps.platformStaffRouter);
app.use('/api/tenants', tenantsMod.default);
// دخول المالك تمثيلاً: authLimiter نفسه الذي على /api/auth/login
app.post('/api/auth/login', limits.authLimiter, (_req, res) => { res.json({ success: true }); });
app.use(errorHandler);

let base = '';
const server = http.createServer(app);
const ready = new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); }));
test.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(method: string, url: string, token?: string | null, body?: unknown) {
  await ready;
  const r = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { /* نصّ */ }
  return { status: r.status, body: json, text };
}

const ownerToken = () => jwt.sign({ id: 'o1', role: 'SUPER_ADMIN', name: 'المالك' }, SECRET, { expiresIn: '1h' });
const HASH = bcrypt.hashSync('Secret123', 4);
function addStaff(o: Partial<Staff> = {}): Staff {
  const row: Staff = {
    id: `s${++seq}`, name: 'سارة', email: `e${seq}@x.co`, passwordHash: HASH, isActive: true, permissions: [], tokenVersion: 0,
    mustChangePassword: false, failedLogins: 0, lastFailedAt: null, lockedUntil: null, lastLoginAt: null, lastSeenAt: null, createdAt: new Date(), ...o,
  };
  staff.set(row.id, row);
  return row;
}
function addAdmin(o: Partial<Admin> = {}): Admin {
  const row: Admin = { id: `ad${++seq}`, tenantId: 't1', name: 'مدير', email: 'manager@co.sa', passwordHash: 'old-hash', createdAt: new Date(Date.now() + seq), ...o };
  admins.set(row.id, row);
  return row;
}
const reset = () => {
  staff.clear(); owners.clear(); admins.clear(); tenants.clear();
  owners.set('o1', { id: 'o1', isActive: true });
  tenants.set('t1', { id: 't1', name: 'شركة <الاختبار>', accountingSuiteEnabled: false });
  audits = []; glAudits = []; mails = []; mailOk = true; auditFailOn = null; hashAtSendOf = null; realHashCompares.clear();
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1']) { limits.staffAuthLimiter.resetKey(ip); limits.authLimiter.resetKey(ip); }
};
const login = (email: string, password: string) => call('POST', '/api/staff-auth/login', null, { email, password });

// ═══════════════════ (أ) إعادة كلمة مرور المدير ═══════════════════

test('الموظف لا يضع كلمة مرور المدير: newPassword في الجسم ٤٠٠ بلا بريد ولا تغيير', async () => {
  reset();
  const s = addStaff({ permissions: ['tenants.resetPassword'] });
  const a = addAdmin();
  const r = await call('POST', '/api/tenants/t1/reset-admin', pa.signStaffToken(s), { newPassword: 'IKnowThis123' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'STAFF_RESET_NO_PASSWORD');
  assert.equal(admins.get(a.id)!.passwordHash, 'old-hash');
  assert.equal(mails.length, 0);
  // ولا بقيمة فارغة: المفتاح نفسه مرفوض
  assert.equal((await call('POST', '/api/tenants/t1/reset-admin', pa.signStaffToken(s), { newPassword: '' })).status, 400);
});

test('الموظف: كلمة مؤقتة يولّدها الخادم إلى بريد المدير وحده قبل حفظ تجزئتها، والردّ بلا كلمة المرور، وسطر سجل بمعرّف المدير', async () => {
  reset();
  const s = addStaff({ permissions: ['tenants.resetPassword'] });
  const a = addAdmin();
  hashAtSendOf = () => admins.get(a.id)!.passwordHash;
  const r = await call('POST', '/api/tenants/t1/reset-admin', pa.signStaffToken(s), {});
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body, { success: true, data: { sent: true, email: 'ma***@co.sa' } });
  assert.equal(mails.length, 1);
  const m = mails[0];
  assert.equal(m.to, 'manager@co.sa', 'إلى المدير لا إلى MAIL_TO ولا إلى الموظف');
  assert.equal(m.hashAtSend, 'old-hash', 'الإرسال قبل الحفظ');
  const password = /<bdi dir="ltr">([A-Za-z0-9]{12})<\/bdi>/.exec(m.html)?.[1];
  assert.ok(password, 'كلمة مؤقتة في البريد');
  assert.ok(!r.text.includes(password), 'لا تعود في الردّ');
  assert.ok(await realCompare(password, admins.get(a.id)!.passwordHash), 'حُفظت تجزئتها بعد الإرسال');
  assert.match(m.html, /شركة &lt;الاختبار&gt;/, 'اسم الشركة مُهرَّب في البريد');
  const line = audits.find((x) => x.action === 'tenants.resetPassword.admin');
  assert.ok(line, 'سطر بمعرّف المدير');
  assert.deepEqual([line.actorType, line.actorId, line.targetId], ['STAFF', s.id, a.id]);
  assert.ok(!JSON.stringify(audits).includes(password), 'ولا في السجل');
  assert.ok(audits.findIndex((x) => x.action === 'tenants.resetPassword') < audits.indexOf(line), 'سطر الحارس ثم سطر المدير');
});

test('الموظف: تعذّر البريد ٥٠٢ ولا تتغيّر التجزئة، وتعذّر سطر السجل ٥٠٣ بلا بريد، وبريدٌ غير صالح لا يُرسل لغير صاحبه', async () => {
  reset();
  const s = addStaff({ permissions: ['tenants.resetPassword'] });
  const a = addAdmin();
  mailOk = false;
  const r = await call('POST', '/api/tenants/t1/reset-admin', pa.signStaffToken(s), {});
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'RESET_MAIL_FAILED');
  assert.equal(admins.get(a.id)!.passwordHash, 'old-hash');
  mailOk = true; mails = [];
  auditFailOn = (action) => action === 'tenants.resetPassword.admin';
  const r2 = await call('POST', '/api/tenants/t1/reset-admin', pa.signStaffToken(s), {});
  assert.equal(r2.status, 503);
  assert.equal(mails.length, 0, 'لا فعل بلا أثر');
  assert.equal(admins.get(a.id)!.passwordHash, 'old-hash');
  auditFailOn = null;
  admins.get(a.id)!.email = '';
  const r3 = await call('POST', '/api/tenants/t1/reset-admin', pa.signStaffToken(s), {});
  assert.equal(r3.status, 409, 'sendMail بلا to يذهب إلى بريد المالك');
  assert.equal(mails.length, 0);
});

test('الموظف: adminId من شركةٍ أخرى ٤٠٤، ومن الشركة نفسها يذهب البريد إليه', async () => {
  reset();
  const s = addStaff({ permissions: ['tenants.resetPassword'] });
  addAdmin();
  const other = addAdmin({ tenantId: 't2', email: 'x@other.sa' });
  const second = addAdmin({ email: 'acc@co.sa' });
  assert.equal((await call('POST', '/api/tenants/t1/reset-admin', pa.signStaffToken(s), { adminId: other.id })).status, 404);
  const r = await call('POST', '/api/tenants/t1/reset-admin', pa.signStaffToken(s), { adminId: second.id });
  assert.equal(r.status, 200);
  assert.equal(mails.at(-1)!.to, 'acc@co.sa');
  assert.notEqual(admins.get(second.id)!.passwordHash, 'old-hash');
});

test('المالك كما كان: يضع كلمة المرور بنفسه بلا بريد ولا سطرٍ إضافي', async () => {
  reset();
  const a = addAdmin();
  const r = await call('POST', '/api/tenants/t1/reset-admin', ownerToken(), { newPassword: 'OwnerSet123' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { success: true });
  assert.ok(await realCompare('OwnerSet123', admins.get(a.id)!.passwordHash));
  assert.equal(mails.length, 0);
  assert.deepEqual(audits.map((x) => x.action), ['tenants.resetPassword']);
  assert.equal((await call('POST', '/api/tenants/t1/reset-admin', ownerToken(), {})).status, 400, 'المالك بلا كلمة ⇒ ٤٠٠ كما كان');
});

test('maskEmail', () => {
  assert.equal(tenantsMod.maskEmail('manager@co.sa'), 'ma***@co.sa');
  assert.equal(tenantsMod.maskEmail('ab@x.co'), 'a***@x.co');
  assert.equal(tenantsMod.maskEmail('a@x.co'), 'a***@x.co');
  assert.equal(tenantsMod.maskEmail('bad'), '***');
});

// ═══════════════════ (ب) الدخول: قفلٌ ذرّي، ردٌّ واحد، تقادم، حدٌّ مستقل ═══════════════════

test('عشرون دخولاً خاطئاً متوازياً: خمس مقارناتٍ بتجزئة الحساب لا أكثر، ثم قفل — والصحيحة بعده مرفوضة بلا مقارنة', async () => {
  reset();
  const s = addStaff({ email: 'sara@fieldsa.net', passwordHash: bcrypt.hashSync('Secret123', 6) });
  const rs = await Promise.all(Array.from({ length: 20 }, () => login(s.email, 'wrong-pass')));
  assert.ok(rs.every((r) => r.status === 401), rs.map((r) => r.status).join(','));
  assert.equal(realHashCompares.get(s.passwordHash), ps.STAFF_MAX_FAILED, 'المحاولة تُحجز قبل bcrypt');
  assert.ok(s.lockedUntil && s.lockedUntil.getTime() > Date.now() + ps.STAFF_LOCK_MS - 60_000, 'قفل ربع ساعة');
  assert.equal(s.failedLogins, 0);
  limits.staffAuthLimiter.resetKey('127.0.0.1');
  const locked = await login(s.email, 'Secret123');
  assert.equal(locked.status, 401);
  assert.equal(realHashCompares.get(s.passwordHash), ps.STAFF_MAX_FAILED, 'المقفل لا يُقارَن');
});

test('لا ٤٢٣: غير موجود وخاطئ ومقفل ومعطَّل — الحالة والجسم نفسهما حرفاً', async () => {
  reset();
  const s = addStaff({ email: 'ok@x.co' });
  addStaff({ email: 'locked@x.co', lockedUntil: new Date(Date.now() + 60_000) });
  addStaff({ email: 'off@x.co', isActive: false });
  const outs = [
    await login('nobody@x.co', 'Secret123'), await login(s.email, 'wrong'),
    await login('locked@x.co', 'Secret123'), await login('off@x.co', 'Secret123'),
  ];
  for (const o of outs) {
    assert.equal(o.status, 401);
    assert.equal(o.text, outs[0].text);
  }
  assert.deepEqual(outs[0].body, ps.STAFF_LOGIN_FAIL);
  assert.match(String(outs[0].body.message), /تقفل الدخول مؤقتا/, 'الرسالة العامة تذكر القفل المؤقت');
  assert.doesNotMatch(strip(read('routes', 'platformStaff.ts')), /status\(423\)|STAFF_LOCKED/);
});

test('العدّاد يتقادم: أخطاءٌ قديمة لا تتراكم إلى قفل، والحديثة تقفل، والقفل المنقضي يُفتح، والنجاح يصفّر كل شيء', async () => {
  reset();
  const old = new Date(Date.now() - ps.STAFF_FAIL_WINDOW_MS - 60_000);
  const s = addStaff({ email: 'a@x.co', failedLogins: ps.STAFF_MAX_FAILED - 1, lastFailedAt: old });
  assert.equal((await login(s.email, 'wrong')).status, 401);
  assert.equal(s.failedLogins, 1, 'بدأ من الصفر');
  assert.equal(s.lockedUntil, null);

  const t = addStaff({ email: 'b@x.co', failedLogins: ps.STAFF_MAX_FAILED - 1, lastFailedAt: new Date(Date.now() - 5 * 60_000) });
  assert.equal((await login(t.email, 'wrong')).status, 401);
  assert.ok(t.lockedUntil && t.lockedUntil.getTime() > Date.now(), 'الخامسة خلال ربع الساعة تقفل');

  // عدّادٌ بلغ الحدّ بلا قفل (انقطاعٌ بين الحجز والقفل) لا يحجب صاحبه إلى الأبد
  const u = addStaff({ email: 'c@x.co', failedLogins: ps.STAFF_MAX_FAILED, lastFailedAt: old });
  assert.equal((await login(u.email, 'Secret123')).status, 200);

  const v = addStaff({ email: 'd@x.co', lockedUntil: new Date(Date.now() - 1000), failedLogins: 2, lastFailedAt: new Date() });
  const ok = await login(v.email, 'Secret123');
  assert.equal(ok.status, 200, 'القفل المنقضي لا يمنع');
  assert.deepEqual([v.failedLogins, v.lastFailedAt, v.lockedUntil], [0, null, null]);
});

test('حدّ الموظف مستقل عن دخول المالك: استنفاده من الـIP نفسه لا يحجب /api/auth/login', async () => {
  reset();
  assert.notEqual(limits.staffAuthLimiter, limits.authLimiter);
  for (let i = 0; i < 20; i++) assert.equal((await login(`nobody${i}@x.co`, 'x')).status, 401);
  assert.equal((await login('nobody@x.co', 'x')).status, 429, 'الحادي والعشرون');
  assert.equal((await call('POST', '/api/auth/login', null, {})).status, 200, 'المالك يدخل');
  const src = strip(read('routes', 'platformStaff.ts'));
  assert.match(src, /staffAuthRouter\.post\('\/login', staffAuthLimiter,/);
  assert.match(src, /staffAuthRouter\.post\('\/change-password', staffAuthLimiter,/);
  assert.doesNotMatch(src, /\bauthLimiter\b/);
});

test('المخطّط: lastFailedAt في PlatformStaff', () => {
  const schema = read('..', 'prisma', 'schema.prisma');
  const model = schema.slice(schema.indexOf('model PlatformStaff {'), schema.indexOf('}', schema.indexOf('model PlatformStaff {')));
  assert.match(model, /lastFailedAt\s+DateTime\?/);
});

// ═══════════════════ (ج) سحب «الدخول» يُسقط الجلسات ═══════════════════

test('سحب tenants.impersonate يرفع tokenVersion مرةً واحدة، وإعادة منحها لا تُحيي جلسة «دخول» قديمة', async () => {
  reset();
  const s = addStaff({ permissions: ['tenants.view', 'tenants.impersonate'] });
  const put = (body: unknown) => call('PUT', `/api/platform-staff/${s.id}`, ownerToken(), body);
  assert.equal((await put({ permissions: ['tenants.view', 'tenants.impersonate', 'leads.view'] })).status, 200);
  assert.equal(s.tokenVersion, 0, 'تعديلٌ لا يمسّ «الدخول»');
  const oldSession = { by: s.id, byKind: 'STAFF', btv: 0 };
  assert.equal(await pa.impersonationIssuerOk(oldSession), true);
  await put({ permissions: ['tenants.view'] });
  assert.equal(s.tokenVersion, 1);
  await put({ permissions: ['tenants.view', 'tenants.impersonate'] });
  assert.equal(s.tokenVersion, 1, 'المنح لا يرفع');
  assert.equal(await pa.impersonationIssuerOk(oldSession), false, 'الجلسة القديمة لا تعود');
  await put({ permissions: [], isActive: false });
  assert.equal(s.tokenVersion, 2, 'السحب مع التعطيل: رفعٌ واحد');
  const t = addStaff({ permissions: ['leads.view'] });
  await call('PUT', `/api/platform-staff/${t.id}`, ownerToken(), { isActive: false });
  assert.equal(t.tokenVersion, 1, 'التعطيل كما كان');
  await call('PUT', `/api/platform-staff/${t.id}`, ownerToken(), { isActive: true });
  assert.equal(t.tokenVersion, 1);
});

// ═══════════════════ (د) الإسناد في السجلات الثابتة ═══════════════════

test('ownerActor: الموظف STAFF باسمه ومعرّفه، والمالك OWNER كما كان', () => {
  const asStaff = { user: { id: 's9', role: 'PLATFORM_STAFF', name: 'سارة' }, platformStaff: { id: 's9', name: 'سارة', permissions: [], tokenVersion: 0 }, ip: '1.2.3.4' };
  assert.deepEqual(tenantsMod.ownerActor(asStaff as never), { actorType: 'STAFF', actorId: 's9', actorName: 'موظف المنصة: سارة', impersonated: false, requestIp: '1.2.3.4' });
  const asOwner = { user: { id: 'o1', role: 'SUPER_ADMIN', name: 'المالك' }, ip: '5.6.7.8' };
  assert.deepEqual(tenantsMod.ownerActor(asOwner as never), { actorType: 'OWNER', actorId: 'o1', actorName: 'المالك', impersonated: false, requestIp: '5.6.7.8' });
  assert.ok((glAudit.AUDIT_ACTOR_TYPES as readonly string[]).includes('STAFF'));
  assert.deepEqual([...review.AUDIT_ACTOR_TYPES], [...glAudit.AUDIT_ACTOR_TYPES], 'نسخة المرشّح مطابقة');
  assert.deepEqual(review.auditWhere('t1', { actorType: 'STAFF,HACKER' }, 'Asia/Riyadh').actorType, { in: ['STAFF'] });
});

test('FLAG_TOGGLE من موظفٍ بـtenants.edit يُدوَّن STAFF باسمه، والسلسلة المجزّأة سليمة بالقيمة الجديدة', async () => {
  reset();
  const s = addStaff({ permissions: ['tenants.edit'] });
  const r = await call('PUT', '/api/tenants/t1', pa.signStaffToken(s), { accountingSuiteEnabled: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(glAudits.length, 1);
  const g = glAudits[0];
  assert.deepEqual([g.action, g.actorType, g.actorId, g.actorName, g.impersonated], ['FLAG_TOGGLE', 'STAFF', s.id, 'موظف المنصة: سارة', false]);
  const r2 = await call('PUT', '/api/tenants/t1', ownerToken(), { accountingSuiteEnabled: false });
  assert.equal(r2.status, 200);
  assert.deepEqual([glAudits[1].actorType, glAudits[1].actorName], ['OWNER', 'المالك']);
  const chain = glAudit.verifyAuditChain(glAudits as unknown as Parameters<typeof glAudit.verifyAuditChain>[0]);
  assert.deepEqual(chain, { ok: true, count: 2, lastSeq: 2, lastHash: glAudits[1].hash });
});

test('tenants.ts: FLAG_TOGGLE وإعادة ضبط الدفاتر ورسوم الدفع عبر ownerActor، والتجاوز يذكر الموظف', () => {
  const src = strip(read('routes', 'tenants.ts'));
  assert.equal((src.match(/actorType: 'OWNER'/g) ?? []).length, 1, 'الحرفيّ في ownerActor وحده');
  const put = src.slice(src.indexOf("router.put('/:id'"), src.indexOf("router.post('/:id/impersonate'"));
  assert.match(put, /actor: ownerActor\(req\)/);
  const resetBody = src.slice(src.indexOf("router.post('/:id/ledger-reset'"), src.indexOf("router.put('/:id/ledger-paylink-fee-invoice-from'"));
  assert.match(resetBody, /const actor = ownerActor\(req\)/);
  assert.match(resetBody, /req\.platformStaff \? `موظف المنصّة \$\{req\.platformStaff\.name\}` : 'مالك المنصّة'/);
  assert.match(resetBody, /\(تجاوز \$\{overrider\}:/);
});

test('سجلّ السفراء: الموظف staff لا owner — دالةٌ واحدة في اللوحة وربط الدفعة ودوال الدفتر', () => {
  assert.deepEqual(affCore.platformActor({ user: { id: 's1' }, platformStaff: { id: 's1' } }), { actorType: 'staff', actorId: 's1' });
  assert.deepEqual(affCore.platformActor({ user: { id: 'o1' } }), { actorType: 'owner', actorId: 'o1' });
  assert.match(strip(read('services', 'affiliate', 'core.ts')), /actorType: 'system' \| 'affiliate' \| 'owner' \| 'staff' \| 'company';/);

  const admin = strip(read('routes', 'affiliateAdmin.ts'));
  assert.doesNotMatch(admin, /actorType: 'owner'/);
  const ledgerFns = 'approveCommission|holdCommission|releaseCommission|declineCommission|createOwnerAttribution|voidAttribution|activateAttribution|reassignAttribution|adjustAttributionWindow|linkClaimToTenant|createPayout|recordPayout|voidPayout';
  /** معاملات الاستدعاء بموازنة الأقواس */
  const argsAt = (s: string, open: number): string => {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')' && --depth === 0) return s.slice(open + 1, i);
    }
    throw new Error('أقواس غير متوازنة');
  };
  const calls = [...admin.matchAll(new RegExp(`await (${ledgerFns})\\(`, 'g'))];
  assert.equal(calls.length, 13);
  for (const c of calls) {
    const args = argsAt(admin, c.index! + c[0].length - 1);
    assert.match(args, /platformActor\(req\)/, `${c[1]} بمنفّذ اللوحة`);
    assert.doesNotMatch(args, /owner\(req\)/, c[1]);
  }
  assert.ok((admin.match(/\.\.\.platformActor\(req\)/g) ?? []).length >= 7, 'أحداث اللوحة نفسها');

  const ledger = strip(read('services', 'affiliate', 'ledger.ts'));
  assert.doesNotMatch(ledger, /actorType: 'owner'|type: 'owner'|ownerId/);
  for (const fn of ledgerFns.split('|')) {
    const sig = new RegExp(`export async function ${fn}\\([^)]*by: PlatformActor`);
    assert.match(ledger, sig, fn);
  }

  const pay = strip(read('routes', 'payments.ts'));
  const link = pay.slice(pay.indexOf("router.post('/:id/link-tenant'"), pay.indexOf('function tokenMatches'));
  assert.match(link, /action: 'linked_tenant', \.\.\.platformActor\(req\)/);
  assert.doesNotMatch(pay, /actorType: 'owner'/);
});

test('واجهة سجل التدقيق تعرض STAFF وتصفّي به (بنصٍّ مترجَم)', (t) => {
  const file = path.join(SRC, '../../web-admin/src/pages/ledger/review/AuditLogPage.tsx');
  if (!fs.existsSync(file)) { t.skip('web-admin غير موجود'); return; }
  const page = fs.readFileSync(file, 'utf8');
  assert.match(page, /\{ key: 'actor:STAFF', label: tr\('موظف المنصة'\), group: 'actor' \}/);
  assert.match(page, /r\.actorType === 'STAFF' \? \[tr\('موظف المنصة'\)/);
  const strings = fs.readFileSync(path.join(SRC, '../../web-admin/src/i18n/strings.ts'), 'utf8');
  assert.match(strings, /\n\s+'موظف المنصة': \{ en: /, 'الترجمة موجودة');
});
