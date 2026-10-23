// جلسة «دخول» أصدرها موظف منصة إلى حساب شركة (مراجعة أمنية، ٢٤ أكتوبر ٢٠٢٦). نثبت فوق Prisma مزيّف في الذاكرة (بلا قاعدة)
// وبالموجّهات الحقيقية (authenticate، /api/company-users، /api/sales-reps، /api/api-keys، platformGate، قناة البث):
//   أ) لا اعتماد يبقى بعد سقوطها: لا مستخدم ولا مندوب ولا كلمة مرور ولا بريد دخول ولا ترقية إلى مدير ولا مفتاح API — وجلسة المالك كما هي.
//   ب) كل كتابةٍ فيها سطرٌ باسم الموظف في سجل نشاط المنصة قبل المعالج، وتعذّره ٥٠٣ بلا فعل.
//   ج) قناة البث تُغلق متى سقط مُصدِرها وعند انتهاء التوكن.
//   د) القراءة الحساسة المسجَّلة سطرٌ واحد في ربع الساعة للرابط نفسه، والتعذّر يبقى يمنع، والكتابات كلها تُسجَّل.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import express, { Router } from 'express';

process.env.JWT_SECRET = 'platform-staff-impersonation-test-secret';
delete process.env.STAFF_JWT_SECRET;
const SECRET = process.env.JWT_SECRET;
const SRC = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ─── Prisma مزيّف ───
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Staff = { id: string; name: string; isActive: boolean; permissions: string[]; tokenVersion: number; mustChangePassword: boolean; lastSeenAt: Date | null };
type Audit = { id: string; actorType: string; actorId: string; actorName: string | null; action: string; method: string | null; path: string | null; targetId: string | null; status?: number | null };
const staff = new Map<string, Staff>();
const owners = new Map<string, { id: string; isActive: boolean }>();
const admins = new Map<string, Row>();
const tenants = new Map<string, Row>();
const reps = new Map<string, Row>();
let audits: Audit[] = [];
let auditFails = false;
let staffReadFails = false;
let writes: string[] = [];
let seq = 0;

const pick = (row: Row | undefined | null, select?: Row) => {
  if (!row) return null;
  if (!select) return { ...row };
  const o: Row = {};
  for (const k of Object.keys(select)) o[k] = row[k];
  return o;
};
const prisma = {
  superAdmin: { async findUnique(a: { where: { id: string } }) { return owners.get(a.where.id) ?? null; } },
  platformStaff: {
    async findUnique(a: { where: { id: string }; select?: Row }) {
      if (staffReadFails) throw new Error('db down');
      return pick(staff.get(a.where.id), a.select);
    },
    async update(a: { where: { id: string }; data: Row }) { const s = staff.get(a.where.id); if (s) Object.assign(s, a.data); return {}; },
  },
  platformAuditLog: {
    async create(a: { data: Omit<Audit, 'id'> }) {
      if (auditFails) throw new Error('audit down');
      const row = { id: `a${++seq}`, ...a.data };
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
    async findUnique(a: { where: { id?: string; email?: string }; select?: Row }) {
      const row = a.where.id ? admins.get(a.where.id) : [...admins.values()].find((x) => x.email === a.where.email);
      return pick(row, a.select);
    },
    async findFirst(a: { where: Row }) { return pick([...admins.values()].find((x) => x.id === a.where.id && x.tenantId === a.where.tenantId)); },
    async count() { return admins.size; },
    async updateMany() { return { count: 0 }; },
    async create(a: { data: Row; select?: Row }) {
      writes.push('admin.create');
      const row = { id: `u${++seq}`, ...a.data };
      admins.set(row.id, row);
      return pick(row, a.select);
    },
    async update(a: { where: { id: string }; data: Row; select?: Row }) {
      writes.push('admin.update');
      const row = admins.get(a.where.id)!;
      Object.assign(row, a.data);
      return pick(row, a.select);
    },
  },
  tenant: { async findUnique(a: { where: { id: string }; select?: Row }) { return pick(tenants.get(a.where.id), a.select); } },
  salesRep: {
    async findFirst(a: { where: Row }) {
      if ('username' in a.where || 'phone' in a.where || 'email' in a.where) return null; // فحص التكرار
      return pick([...reps.values()].find((x) => x.id === a.where.id && x.tenantId === a.where.tenantId));
    },
    async count() { return reps.size; },
    async create(a: { data: Row; select?: Row }) {
      writes.push('salesRep.create');
      const row = { id: `r${++seq}`, ...a.data };
      reps.set(row.id, row);
      return pick(row, a.select);
    },
    async update(a: { where: { id: string }; data: Row; select?: Row }) {
      writes.push('salesRep.update');
      const row = reps.get(a.where.id)!;
      Object.assign(row, a.data);
      return pick(row, a.select);
    },
  },
  apiKey: {
    async count() { return 0; },
    async create(a: { data: Row }) {
      writes.push('apiKey.create');
      return {
        id: `k${++seq}`, name: a.data.name, prefix: a.data.prefix, readOnly: a.data.readOnly, createdAt: new Date(), lastUsedAt: null, revokedAt: null,
        createdBy: a.data.createdBy, admin: { id: 'a1', name: 'مدير', email: 'boss@co.sa' },
      };
    },
  },
};
stub('config/database', { default: prisma });

/* eslint-disable @typescript-eslint/no-var-requires */
const pa = require('../services/platformAccess') as typeof import('../services/platformAccess');
const { authenticate } = require('../middleware/auth') as typeof import('../middleware/auth');
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
const companyUsersRouter = (require('../routes/companyUsers') as typeof import('../routes/companyUsers')).default;
const salesRepsRouter = (require('../routes/salesReps') as typeof import('../routes/salesReps')).default;
const apiKeysRouter = (require('../routes/apiKeys') as typeof import('../routes/apiKeys')).default;
const { liveStreamHandler } = require('../routes/live') as typeof import('../routes/live');
const { liveListenerCount, HEARTBEAT_MS } = require('../services/liveEvents') as typeof import('../services/liveEvents');
/* eslint-enable @typescript-eslint/no-var-requires */

// ─── الخادم ───
const hits: { path: string; auditsAtNext: number }[] = [];
const record = (req: express.Request, res: express.Response) => { hits.push({ path: req.originalUrl, auditsAtNext: audits.length }); res.json({ success: true }); };
function owned(): Router {
  const r = Router();
  r.use(pa.platformGate);
  r.all('*', record);
  return r;
}
const app = express();
app.use(express.json());
app.use('/api/company-users', companyUsersRouter);
app.use('/api/sales-reps', salesRepsRouter);
app.use('/api/api-keys', apiKeysRouter);
app.all('/api/company-thing', authenticate, record);
// authenticate مركّبٌ مرتين على الطلب نفسه (موجّهان على بادئةٍ واحدة) — سطرٌ واحد
app.put('/api/twice', authenticate, authenticate, record);
// مسار تغيير كلمة المرور كما في routes/auth.ts (authenticate في المسار)
app.post('/api/auth/change-password', authenticate, record);
for (const m of ['/api/analytics', '/api/leads']) app.use(m, owned());
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
  let json: Row = {};
  try { json = JSON.parse(text); } catch { /* نصّ */ }
  return { status: r.status, body: json };
}
/** حالة الطلب تُختم على سطره عند «finish» — دورةٌ قصيرة بعد الرد */
const settle = () => new Promise((r) => setTimeout(r, 20));

function addStaff(o: Partial<Staff> = {}): Staff {
  const row: Staff = { id: `s${++seq}`, name: 'سارة الدعم', isActive: true, permissions: ['tenants.view', 'tenants.impersonate'], tokenVersion: 0, mustChangePassword: false, lastSeenAt: null, ...o };
  staff.set(row.id, row);
  return row;
}
const sessionAs = (extra: Row) => jwt.sign({ id: 'a1', role: 'ADMIN', name: 'مدير', tenantId: 't1', impersonated: true, ...extra }, SECRET, { expiresIn: '2h' });
const staffSession = (s: Staff) => sessionAs({ by: s.id, byKind: 'STAFF', btv: s.tokenVersion });
const ownerSession = () => sessionAs({ by: 'o1', byKind: 'OWNER' });
const staffPanelToken = (s: Staff) => pa.signStaffToken(s);

function reset(): void {
  staff.clear(); owners.clear(); admins.clear(); tenants.clear(); reps.clear();
  owners.set('o1', { id: 'o1', isActive: true });
  admins.set('a1', { id: 'a1', tenantId: 't1', name: 'مدير', email: 'boss@co.sa', role: 'ADMIN', isActive: true, canManageCompanyUsers: true, canReceiveUserCollections: false, scopeEnabled: false, lastSeenAt: new Date() });
  admins.set('u2', { id: 'u2', tenantId: 't1', name: 'مشرف', email: 'sup@co.sa', role: 'MANAGER', isActive: true, canManageCompanyUsers: false, canReceiveUserCollections: false, scopeEnabled: false, lastSeenAt: null });
  admins.set('u3', { id: 'u3', tenantId: 't1', name: 'مدير ثان', email: 'boss2@co.sa', role: 'ADMIN', isActive: true, canManageCompanyUsers: true, canReceiveUserCollections: false, scopeEnabled: false, lastSeenAt: null });
  tenants.set('t1', { id: 't1', maxAdminUsers: null, maxSalesReps: null, accountingSuiteEnabled: false, accountingEnabled: true, apiEnabled: true, zatcaPhase2Enabled: false });
  reps.set('r1', { id: 'r1', tenantId: 't1', name: 'مندوب', phone: '0500000001', username: 'rep1', email: null, isActive: true, boundDeviceId: null });
  audits = []; auditFails = false; staffReadFails = false; writes = []; hits.length = 0;
  pa.resetReadAuditThrottle();
}

const NO_CREDS = 'STAFF_SESSION_NO_CREDENTIALS';

// ═══════════════════ أ) لا اعتمادات دائمة من جلسة الموظف ═══════════════════

test('أ) الحارس المشترك: جلسة «دخول» الموظف وحدها — لا جلسة المالك ولا المستخدم العادي', () => {
  assert.equal(pa.isStaffImpersonation({ user: { impersonated: true, byKind: 'STAFF' } }), true);
  assert.equal(pa.isStaffImpersonation({ user: { impersonated: true, byKind: 'OWNER' } }), false);
  assert.equal(pa.isStaffImpersonation({ user: { byKind: 'STAFF' } }), false, 'byKind بلا انتحال لا يُعتدّ به');
  assert.equal(pa.isStaffImpersonation({}), false);
});

test('أ) إنشاء مستخدم شركة: ٤٠٣ لجلسة الموظف بلا كتابة، وجلسة المالك تنشئ كما كانت', async () => {
  reset();
  const s = addStaff();
  const body = { name: 'مستخدم جديد', email: 'new@co.sa', role: 'ADMIN', password: 'Secret123' };
  const r = await call('POST', '/api/company-users', staffSession(s), body);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, NO_CREDS);
  assert.equal(r.body.message, pa.STAFF_SESSION_NO_CREDENTIALS);
  assert.equal((await call('POST', '/api/company-users', staffSession(s), { ...body, role: 'MANAGER' })).status, 403, 'ولو مشرفاً');
  assert.deepEqual(writes, []);
  const ok = await call('POST', '/api/company-users', ownerSession(), { ...body, role: 'MANAGER' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(writes, ['admin.create']);
});

test('أ) تعديل مستخدم شركة: كلمة مرور أو بريد آخر أو ترقية إلى مدير ٤٠٣ للموظف — وغيرها يمرّ، والمالك يفعل كل ذلك', async () => {
  reset();
  const s = addStaff();
  const t = staffSession(s);
  for (const [why, body] of [
    ['كلمة مرور', { password: 'NewSecret99' }],
    ['بريد آخر', { email: 'staff-owned@x.co' }],
    ['ترقية إلى مدير', { role: 'ADMIN' }],
  ] as const) {
    const r = await call('PUT', '/api/company-users/u2', t, body);
    assert.equal(r.status, 403, why);
    assert.equal(r.body.code, NO_CREDS, why);
  }
  assert.deepEqual(writes, [], 'لم يُكتب شيء');
  // نموذج الواجهة يرسل الحقول كلها: البريد نفسه (بحالة أحرفٍ أخرى) والدور نفسه ليسا تغييراً
  assert.equal((await call('PUT', '/api/company-users/u2', t, { name: 'مشرف المبيعات', email: 'SUP@co.sa', role: 'MANAGER' })).status, 200);
  assert.equal((await call('PUT', '/api/company-users/u3', t, { name: 'مدير المبيعات', role: 'ADMIN' })).status, 200, 'مديرٌ قائم ليس ترقية');
  assert.equal((await call('PUT', '/api/company-users/u2', t, { password: '' })).status, 200, 'كلمة مرور فارغة = بلا تغيير');
  writes = [];
  const owner = await call('PUT', '/api/company-users/u2', ownerSession(), { password: 'NewSecret99', email: 'sup2@co.sa' });
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
  assert.deepEqual(writes, ['admin.update']);
  assert.ok(String(admins.get('u2')!.passwordHash).startsWith('$2'), 'كلمة مرور المالك كُتبت');
});

test('أ) المناديب: الإنشاء وكلمة المرور ٤٠٣ للموظف، وتعديلٌ بلا كلمة مرور يمرّ، والمالك كما كان', async () => {
  reset();
  const s = addStaff();
  const t = staffSession(s);
  const repBody = { name: 'مندوب جديد', phone: '0500000002', username: 'rep2', password: 'Secret123' };
  const c = await call('POST', '/api/sales-reps', t, repBody);
  assert.equal(c.status, 403);
  assert.equal(c.body.code, NO_CREDS);
  const p = await call('PUT', '/api/sales-reps/r1', t, { password: 'NewSecret99' });
  assert.equal(p.status, 403);
  assert.equal(p.body.code, NO_CREDS);
  assert.deepEqual(writes, []);
  assert.equal((await call('PUT', '/api/sales-reps/r1', t, { isActive: false })).status, 200, 'تعديلٌ عادي');
  assert.equal(reps.get('r1')!.passwordHash, undefined);
  writes = [];
  assert.equal((await call('POST', '/api/sales-reps', ownerSession(), repBody)).status, 201);
  assert.equal((await call('PUT', '/api/sales-reps/r1', ownerSession(), { password: 'NewSecret99' })).status, 200);
  assert.deepEqual(writes, ['salesRep.create', 'salesRep.update']);
});

test('أ) مفتاح API: ٤٠٣ للموظف قبل الإصدار، والمالك يصدر كما كان', async () => {
  reset();
  const s = addStaff();
  const r = await call('POST', '/api/api-keys', staffSession(s), { name: 'مزامنة' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, NO_CREDS);
  assert.deepEqual(writes, []);
  const ok = await call('POST', '/api/api-keys', ownerSession(), { name: 'مزامنة' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.match(ok.body.data.key, /^fsk_/);
  assert.deepEqual(writes, ['apiKey.create']);
});

test('أ) تغيير كلمة مرور الحساب نفسه (/api/auth/change-password) ٤٠٣ للموظف بأي كتابةٍ للمسار، والمالك يمرّ', async () => {
  reset();
  const s = addStaff();
  for (const url of ['/api/auth/change-password', '/API/Auth/Change-Password/', '/api/auth/change-password?x=1']) {
    const r = await call('POST', url, staffSession(s), { currentPassword: 'x', newPassword: 'NewSecret99' });
    assert.equal(r.status, 403, url);
    assert.equal(r.body.code, NO_CREDS, url);
  }
  assert.equal(hits.length, 0, 'لم يبلغ المعالج');
  assert.equal((await call('POST', '/api/auth/change-password', ownerSession(), {})).status, 200);
  assert.equal(hits.length, 1);
});

test('أ) تركيب الحارس في كل مسارٍ يُنشئ اعتماداً — ولا مسار آخر في الملفات الثلاثة يضع كلمة مرور أو يصدر مفتاحاً', () => {
  const handler = (src: string, start: string) => {
    const i = src.indexOf(start);
    assert.ok(i >= 0, start);
    const j = src.indexOf('\nrouter.', i + start.length);
    return src.slice(i, j < 0 ? undefined : j);
  };
  const users = read('routes', 'companyUsers.ts');
  assert.match(users, /router\.post\('\/', noStaffCredentials, async/);
  assert.match(handler(users, "router.put('/:id',"), /if \(refuseStaffCredentials\(req, res, !!password \|\| emailChanges \|\| \(data\.role === 'ADMIN' && current\.role !== 'ADMIN'\)\)\) return;/);
  assert.equal((users.match(/bcrypt\.hash\(/g) ?? []).length, 2, 'كلمة المرور في الإنشاء والتعديل وحدهما');
  const repsSrc = read('routes', 'salesReps.ts');
  assert.match(repsSrc, /router\.post\('\/', noStaffCredentials, async/);
  assert.match(handler(repsSrc, "router.put('/:id',"), /if \(refuseStaffCredentials\(req, res, !!password\)\) return;/);
  assert.equal((repsSrc.match(/bcrypt\.hash\(/g) ?? []).length, 2);
  const keys = read('routes', 'apiKeys.ts');
  assert.match(keys, /router\.post\('\/', requireApiEnabled, noStaffCredentials, async/);
  assert.equal((keys.match(/generateApiKey\(\)/g) ?? []).length, 1);
  // مسار تغيير كلمة المرور يمرّ بـauthenticate في مساره والموجّه على /api/auth — فيبلغه الحارس هناك
  assert.match(read('routes', 'auth.ts'), /router\.post\('\/change-password', authenticate,/);
  assert.match(read('index.ts'), /app\.use\('\/api\/auth', authRouter\);/);
});

// ═══════════════════ ب) سجل كتابات جلسة الموظف ═══════════════════

test('ب) كتابة جلسة الموظف سطرٌ باسمه قبل المعالج بلا الاستعلام وبحالته، والقراءة بلا سطر، وجلسة المالك والمستخدم بلا سطر', async () => {
  reset();
  const s = addStaff();
  const t = staffSession(s);
  assert.equal((await call('GET', '/api/company-thing', t)).status, 200);
  assert.equal(audits.length, 0, 'قراءة');
  assert.equal((await call('POST', '/api/company-thing?token=secret', t, { x: 1 })).status, 200);
  await settle();
  assert.equal(audits.length, 1);
  assert.equal(hits.at(-1)!.auditsAtNext, 1, 'السطر قبل المعالج');
  const a = audits[0];
  assert.deepEqual(
    { actorType: a.actorType, actorId: a.actorId, actorName: a.actorName, action: a.action, method: a.method, path: a.path, targetId: a.targetId, status: a.status },
    { actorType: 'STAFF', actorId: s.id, actorName: 'سارة الدعم', action: 'tenants.impersonate.write', method: 'POST', path: '/api/company-thing', targetId: 't1', status: 200 },
  );
  assert.equal((await call('PUT', '/api/twice', t, {})).status, 200);
  assert.equal(audits.length, 2, 'authenticate مرتين ⇒ سطرٌ واحد');
  assert.equal((await call('DELETE', '/api/company-thing', ownerSession())).status, 200);
  assert.equal((await call('POST', '/api/company-thing', jwt.sign({ id: 'a1', role: 'ADMIN', name: 'مدير', tenantId: 't1' }, SECRET), {})).status, 200);
  assert.equal(audits.length, 2, 'المالك والمستخدم العادي كما كانا');
});

test('ب) تعذّر السجل ⇒ ٥٠٣ AUDIT_UNAVAILABLE ولا يبلغ المعالج — والقراءة لا تتأثر', async () => {
  reset();
  const s = addStaff();
  auditFails = true;
  const r = await call('PATCH', '/api/company-thing', staffSession(s), {});
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'AUDIT_UNAVAILABLE');
  assert.equal(hits.length, 0);
  // المنع في السجل قبل حارس الاعتمادات: الإنشاء الممنوع أصلاً لا يصل الكتابة ولا يُنفَّذ
  assert.equal((await call('POST', '/api/company-users', staffSession(s), { name: 'xx', email: 'x@x.co', role: 'MANAGER', password: 'Secret123' })).status, 503);
  assert.deepEqual(writes, []);
  assert.equal((await call('GET', '/api/company-thing', staffSession(s))).status, 200);
  assert.equal((await call('POST', '/api/company-thing', ownerSession(), {})).status, 200, 'جلسة المالك لا تُكتب فلا تُمنع');
});

test('ب) محاولة الاعتماد الممنوعة نفسها مسجَّلة بحالتها ٤٠٣', async () => {
  reset();
  const s = addStaff();
  await call('POST', '/api/api-keys', staffSession(s), { name: 'x' });
  await settle();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].path, '/api/api-keys');
  assert.equal(audits[0].status, 403);
});

test('ب) المُصدِر يُقرأ مرة: liveImpersonationIssuer تعيد اسم الموظف، وnull لما يُسقط الجلسة، وimpersonationIssuerOk مطابقة لها', async () => {
  reset();
  const s = addStaff();
  const p = { by: s.id, byKind: 'STAFF', btv: 0 };
  assert.deepEqual(await pa.liveImpersonationIssuer(p), { name: 'سارة الدعم' });
  assert.deepEqual(await pa.liveImpersonationIssuer({ by: 'o1', byKind: 'OWNER' }), { name: null });
  assert.equal(await pa.impersonationIssuerOk(p), true);
  s.permissions = ['tenants.view'];
  assert.equal(await pa.liveImpersonationIssuer(p), null);
  assert.equal(await pa.impersonationIssuerOk(p), false);
  assert.equal(await pa.liveImpersonationIssuer({ byKind: 'STAFF' }), null);
});

// ═══════════════════ ج) قناة البث ═══════════════════

type FakeRes = EventEmitter & { statusCode: number; ended: boolean; chunks: string[]; body?: unknown; destroyed: boolean };
function openStream(user: Row): { req: EventEmitter; res: FakeRes } {
  const req = Object.assign(new EventEmitter(), { user, destroyed: false, socket: { destroyed: false } });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 0, ended: false, chunks: [] as string[], destroyed: false,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; this.ended = true; return this; },
    setHeader() { /* */ }, flushHeaders() { /* */ },
    write(c: string) { this.chunks.push(c); return true; },
    end() { this.ended = true; this.emit('close'); },
  }) as unknown as FakeRes;
  liveStreamHandler(req as never, res as never);
  return { req, res };
}
const flush = () => new Promise((r) => setImmediate(r));

test('ج) قناة البث: تُغلق في النبضة التالية متى سقط مُصدِر «دخول» — وتعذّر قراءته يُغلقها أيضاً', async (t) => {
  reset();
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Math.floor(Date.now() / 1000) * 1000 });
  const s = addStaff();
  const nowSec = Math.floor(Date.now() / 1000);
  const user = { id: 'a1', role: 'ADMIN', name: 'مدير', tenantId: 't-live', impersonated: true, by: s.id, byKind: 'STAFF', btv: 0, exp: nowSec + 7200 };
  const { res } = openStream(user);
  assert.equal(res.statusCode, 200);
  assert.equal(liveListenerCount('t-live'), 1);
  t.mock.timers.tick(HEARTBEAT_MS);
  await flush();
  assert.equal(res.ended, false, 'المُصدِر حيّ');
  assert.equal(res.chunks.filter((c) => c.startsWith(': ping')).length, 1);
  s.isActive = false;
  t.mock.timers.tick(HEARTBEAT_MS);
  await flush();
  assert.equal(res.ended, true, 'عُطّل المُصدِر ⇒ أُغلقت');
  assert.equal(liveListenerCount('t-live'), 0, 'أُلغي الاشتراك');

  s.isActive = true;
  const second = openStream(user);
  assert.equal(liveListenerCount('t-live'), 1);
  staffReadFails = true;
  t.mock.timers.tick(HEARTBEAT_MS);
  await flush();
  assert.equal(second.res.ended, true, 'تعذّر قراءة المُصدِر ⇒ أُغلقت');
  assert.equal(liveListenerCount('t-live'), 0);
});

test('ج) قناة البث: تُغلق عند انتهاء التوكن لكل جلسة، ولا تُقرأ لغير الانتحال قاعدةٌ في النبضة', async (t) => {
  reset();
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Math.floor(Date.now() / 1000) * 1000 });
  const nowSec = Math.floor(Date.now() / 1000);
  staffReadFails = true; // أي قراءة للمُصدِر كانت ستُغلق القناة
  const { res } = openStream({ id: 'a1', role: 'ADMIN', name: 'مدير', tenantId: 't-exp', exp: nowSec + 60 });
  t.mock.timers.tick(HEARTBEAT_MS);
  await flush();
  assert.equal(res.ended, false, 'جلسة عادية بلا مُصدِر يُقرأ');
  t.mock.timers.tick(60_000 - HEARTBEAT_MS - 1);
  await flush();
  assert.equal(res.ended, false);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(res.ended, true, 'انتهى التوكن ⇒ أُغلقت');
  assert.equal(liveListenerCount('t-exp'), 0);
  // إغلاق العميل قبلها يُلغي المؤقّتين — لا إنهاء لاحق ولا خطأ
  const other = openStream({ id: 'a1', role: 'ADMIN', name: 'مدير', tenantId: 't-exp', exp: nowSec + 600 });
  other.req.emit('close');
  assert.equal(liveListenerCount('t-exp'), 0);
  t.mock.timers.tick(700_000);
  await flush();
  assert.equal(other.res.ended, false);
});

// ═══════════════════ د) تخفيف القراءات المسجَّلة ═══════════════════

test('د) القراءة الحساسة سطرٌ واحد لكل (موظف|مفتاح|رابط) في ربع الساعة، والكتابات كلها تُسجَّل', async () => {
  reset();
  const s = addStaff({ permissions: ['live.requests', 'leads.view', 'leads.edit'] });
  const t = staffPanelToken(s);
  for (let i = 0; i < 4; i++) assert.equal((await call('GET', '/api/analytics/request-stats?range=today', t)).status, 200);
  assert.equal(audits.length, 1, 'استطلاع كل ٣٠ث لا يُغرق السجل');
  assert.equal(audits[0].action, 'live.requests');
  await call('GET', '/api/analytics/request-stats?range=week', t);
  assert.equal(audits.length, 2, 'رابطٌ آخر سطرٌ آخر');
  const other = addStaff({ permissions: ['live.requests'] });
  await call('GET', '/api/analytics/request-stats?range=today', staffPanelToken(other));
  assert.equal(audits.length, 3, 'موظفٌ آخر سطرٌ آخر');
  await call('GET', '/api/leads', t);
  assert.equal(audits.length, 3, 'القراءة العادية بلا سطر');
  await call('PUT', '/api/leads/l1', t, {});
  await call('PUT', '/api/leads/l1', t, {});
  assert.equal(audits.length, 5, 'الكتابات كلها');
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + pa.READ_AUDIT_WINDOW_MS - 5_000;
    await call('GET', '/api/analytics/request-stats?range=today', t);
    assert.equal(audits.length, 5, 'ما زال في النافذة');
    Date.now = () => realNow() + pa.READ_AUDIT_WINDOW_MS + 1_000;
    await call('GET', '/api/analytics/request-stats?range=today', t);
    assert.equal(audits.length, 6, 'بعد ربع الساعة سطرٌ جديد');
  } finally {
    Date.now = realNow;
  }
});

test('د) تعذّر سطر القراءة يمنعها ولا يحسبها مسجَّلة: المحاولة التالية تُكتب', async () => {
  reset();
  const s = addStaff({ permissions: ['live.requests'] });
  const t = staffPanelToken(s);
  auditFails = true;
  const r = await call('GET', '/api/analytics/request-stats?range=today', t);
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'AUDIT_UNAVAILABLE');
  assert.equal(hits.length, 0);
  assert.equal((await call('GET', '/api/analytics/request-stats?range=today', t)).status, 503, 'ما زال يمنع');
  auditFails = false;
  assert.equal((await call('GET', '/api/analytics/request-stats?range=today', t)).status, 200);
  assert.equal(audits.length, 1);
  assert.equal(hits.length, 1);
});
