// «موظفو المنصة» (طلب المالك، ٢٣ أكتوبر ٢٠٢٦): حساباتٌ منفصلة عن مالك المنصة بصلاحيات يمنحها من قدرات لوحته، عدا المالية
// وإدارة الموظفين. نثبت فوق Prisma مزيّف في الذاكرة (بلا قاعدة): كل مسارٍ في لوحة المالك مصنَّف (مفتاح أو للمالك وحده)،
// والحارس يمنع افتراضاً، وتوكن الموظف لا يصلح لأي مسارٍ آخر، والتعطيل والإخراج وسحب الصلاحية تسري فوراً — ومعها جلسات
// «دخول» أصدرها — وسجل النشاط قبل الفعل، وقفل الدخول، ومحتوى الموقع بلا HTML من الموظف.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import express, { Router } from 'express';

process.env.JWT_SECRET = 'platform-staff-test-secret';
delete process.env.STAFF_JWT_SECRET;
const SECRET = process.env.JWT_SECRET;
const SRC = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ─── Prisma مزيّف ───
type Staff = {
  id: string; name: string; email: string; passwordHash: string; isActive: boolean; permissions: string[]; tokenVersion: number;
  mustChangePassword: boolean; failedLogins: number; lastFailedAt?: Date | null; lockedUntil: Date | null; lastLoginAt: Date | null; lastSeenAt: Date | null; createdAt: Date;
};
type Audit = { id: string; at: Date; actorType: string; actorId: string; actorName: string | null; action: string; method: string | null; path: string | null; status?: number | null; targetId: string | null; detail: string | null; ip: string | null };
const staff = new Map<string, Staff>();
const owners = new Map<string, { id: string; isActive: boolean }>();
let audits: Audit[] = [];
let auditFails = false;
let seq = 0;

const pick = <T extends Record<string, unknown>>(row: T | undefined | null, select?: Record<string, unknown>) => {
  if (!row) return null;
  if (!select) return { ...row };
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(select)) o[k] = row[k];
  return o;
};
const applyData = (row: Staff, data: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as object)) (row as unknown as Record<string, number>)[k] += (v as { increment: number }).increment;
    else (row as unknown as Record<string, unknown>)[k] = v;
  }
};
/** where لـupdateMany: مساواة وnull وlt/lte/gt/gte (أرقام وتواريخ) وOR — ما يستعمله قفل الدخول الذرّي */
const num = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean => Object.entries(where).every(([k, c]) => {
  if (k === 'OR') return (c as Record<string, unknown>[]).some((w) => matches(row, w));
  const v = row[k] ?? null;
  if (c === null || typeof c !== 'object' || c instanceof Date) return c instanceof Date ? v instanceof Date && v.getTime() === c.getTime() : v === c;
  if (v === null) return false;
  const o = c as { lt?: unknown; lte?: unknown; gt?: unknown; gte?: unknown };
  return (o.lt === undefined || num(v) < num(o.lt)) && (o.lte === undefined || num(v) <= num(o.lte))
    && (o.gt === undefined || num(v) > num(o.gt)) && (o.gte === undefined || num(v) >= num(o.gte));
});
const prisma = {
  superAdmin: { async findUnique(a: { where: { id: string } }) { return owners.get(a.where.id) ?? null; } },
  platformStaff: {
    async findUnique(a: { where: { id?: string; email?: string }; select?: Record<string, unknown> }) {
      const row = a.where.id ? staff.get(a.where.id) : [...staff.values()].find((s) => s.email === a.where.email);
      return pick(row as unknown as Record<string, unknown>, a.select);
    },
    async findMany(a: { select?: Record<string, unknown> }) { return [...staff.values()].map((s) => pick(s as unknown as Record<string, unknown>, a.select)); },
    async create(a: { data: Partial<Staff>; select?: Record<string, unknown> }) {
      const row: Staff = {
        id: `s${++seq}`, name: '', email: '', passwordHash: '', isActive: true, permissions: [], tokenVersion: 0, mustChangePassword: true,
        failedLogins: 0, lockedUntil: null, lastLoginAt: null, lastSeenAt: null, createdAt: new Date(), ...a.data,
      } as Staff;
      staff.set(row.id, row);
      return pick(row as unknown as Record<string, unknown>, a.select);
    },
    async update(a: { where: { id: string }; data: Record<string, unknown>; select?: Record<string, unknown> }) {
      const row = staff.get(a.where.id);
      if (!row) throw new Error('not found');
      applyData(row, a.data);
      return pick(row as unknown as Record<string, unknown>, a.select);
    },
    async updateMany(a: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      let count = 0;
      for (const row of staff.values()) if (matches(row as unknown as Record<string, unknown>, a.where)) { applyData(row, a.data); count++; }
      return { count };
    },
    async delete(a: { where: { id: string } }) { staff.delete(a.where.id); return {}; },
  },
  platformAuditLog: {
    async create(a: { data: Omit<Audit, 'id' | 'at'> }) {
      if (auditFails) throw new Error('audit down');
      const row = { id: `a${++seq}`, at: new Date(), ...a.data } as Audit;
      audits.push(row);
      return { id: row.id };
    },
    async update(a: { where: { id: string }; data: { status: number } }) {
      const row = audits.find((x) => x.id === a.where.id);
      if (row) row.status = a.data.status;
      return {};
    },
    async findMany() { return [...audits].reverse(); },
  },
  // authenticate لمستخدم الشركة (جلسة «دخول»)
  admin: {
    async findUnique() { return { isActive: true, lastSeenAt: new Date() }; },
    async updateMany() { return { count: 0 }; },
  },
};
stub('config/database', { default: prisma });

/* eslint-disable @typescript-eslint/no-var-requires */
const pa = require('../services/platformAccess') as typeof import('../services/platformAccess');
const { staffAuthRouter, platformStaffRouter, STAFF_MAX_FAILED } = require('../routes/platformStaff') as typeof import('../routes/platformStaff');
const { authenticate } = require('../middleware/auth') as typeof import('../middleware/auth');
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
const { staffUnsafeChange } = require('../routes/siteContent') as typeof import('../routes/siteContent');
/* eslint-enable @typescript-eslint/no-var-requires */

// ─── خادمٌ صغير: موجّهات الموظفين ومسارات تمثيلية خلف الحارس ───
const hits: { path: string; user: unknown; auditsAtNext: number }[] = [];
function owned(): Router {
  const r = Router();
  r.use(pa.platformGate);
  r.all('*', (req, res) => { hits.push({ path: req.originalUrl, user: (req as { user?: unknown }).user, auditsAtNext: audits.length }); res.json({ success: true }); });
  return r;
}
const app = express();
app.use(express.json());
app.use('/api/staff-auth', staffAuthRouter);
app.use('/api/platform-staff', platformStaffRouter);
for (const m of ['/api/tenants', '/api/leads', '/api/finance', '/api/affiliate-admin', '/api/wa-inbox']) app.use(m, owned());
app.get('/api/company-thing', authenticate, (req, res) => { res.json({ success: true, user: (req as { user?: unknown }).user }); });
app.use(errorHandler);

let base = '';
const server = http.createServer(app);
const ready = new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); }));
test.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(method: string, url: string, token?: string | null, body?: unknown, headers: Record<string, string> = {}) {
  await ready;
  const r = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { /* نصّ */ }
  return { status: r.status, body: json };
}

const ownerToken = (id = 'o1') => jwt.sign({ id, role: 'SUPER_ADMIN', name: 'المالك' }, SECRET, { expiresIn: '1h' });
function addStaff(o: Partial<Staff> = {}): Staff {
  const row: Staff = {
    id: `s${++seq}`, name: 'موظف', email: `e${seq}@x.co`, passwordHash: bcrypt.hashSync('Secret123', 4), isActive: true, permissions: [],
    tokenVersion: 0, mustChangePassword: false, failedLogins: 0, lockedUntil: null, lastLoginAt: null, lastSeenAt: null, createdAt: new Date(), ...o,
  };
  staff.set(row.id, row);
  return row;
}
const tokenOf = (s: Staff) => pa.signStaffToken(s);
const reset = () => { staff.clear(); owners.clear(); owners.set('o1', { id: 'o1', isActive: true }); audits = []; auditFails = false; hits.length = 0; };

// ═══════════════════ التصنيف: كل مسارٍ في لوحة المالك له مفتاح أو هو للمالك وحده ═══════════════════

/** مسارات الملفات خلف الحارس — من النصّ (كحرّاس المستودع الأخرى) بلا تحميل الموجّهات وتبعياتها */
function ownerRoutes(): { method: string; path: string; file: string }[] {
  const files: { file: string; mount: string; all?: boolean; after?: string }[] = [
    { file: 'tenants.ts', mount: '/api/tenants', all: true },
    { file: 'leads.ts', mount: '/api/leads', all: true },
    { file: 'affiliateAdmin.ts', mount: '/api/affiliate-admin', all: true },
    { file: 'finance.ts', mount: '/api/finance', all: true },
    { file: 'promoVideos.ts', mount: '/api/promo-videos', all: true },
    { file: 'waInbox.ts', mount: '/api/wa-inbox', all: true },
    { file: 'waBridge.ts', mount: '/api/wa-bridge', after: 'router.use(platformGate);' },
    { file: 'paylink.ts', mount: '/api/paylink' },
    { file: 'analytics.ts', mount: '/api/analytics' },
    { file: 'payments.ts', mount: '/api/payments' },
    { file: 'profileDeck.ts', mount: '/api/profile-deck' },
    { file: 'quotes.ts', mount: '/api/quotes' },
    { file: 'siteContent.ts', mount: '/api/site-content' },
  ];
  const out: { method: string; path: string; file: string }[] = [];
  for (const f of files) {
    let src = read('routes', f.file);
    if (f.after) src = src.slice(src.indexOf(f.after));
    const re = /router\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,([^\n]*)/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const guarded = f.all || f.after || /\bplatformGate\b/.test(m[3]) || (f.file === 'paylink.ts' && m[2].startsWith('/owner/'));
      if (!guarded) continue;
      out.push({ method: m[1].toUpperCase(), path: `${f.mount}${m[2] === '/' ? '' : m[2]}`.replace(/:[A-Za-z]+/g, 'p1'), file: f.file });
    }
  }
  return out;
}

/** للمالك وحده بقراره أو للأمان — لا قاعدة لها (الحارس يمنع الموظف) */
const OWNER_ONLY = [/^\/api\/finance(\/|$)/, /^\/api\/paylink\/owner\//, /^\/api\/tenants\/ops\//, /^\/api\/promo-videos(\/|$)/];

test('كل مسارٍ خلف حارس لوحة المالك مصنَّف: مفتاح صلاحية أو للمالك وحده — ومسارٌ جديد بلا تصنيف يُفشل هذا', () => {
  const routes = ownerRoutes();
  assert.ok(routes.length >= 125, `مسارات المالك المقروءة ${routes.length}`);
  const missing = routes.filter((rt) => !pa.ruleFor(rt.method, rt.path.toLowerCase()) && !OWNER_ONLY.some((re) => re.test(rt.path)));
  assert.deepEqual(missing, [], 'مسارٌ بلا قاعدة وليس من قائمة المالك وحده');
  const leaked = routes.filter((rt) => OWNER_ONLY.some((re) => re.test(rt.path)) && pa.ruleFor(rt.method, rt.path.toLowerCase()));
  assert.deepEqual(leaked, [], 'المالية والأمانات وMRR والفيديوهات لا تُمنح');
  // لا قاعدة ميتة: كل قاعدةٍ تطابق مساراً حقيقياً (خطأٌ إملائي فيها يمنع صاحب الصلاحية بصمت)
  for (const rule of pa.ROUTE_RULES) {
    assert.ok(routes.some((rt) => rt.method === rule.method && rule.path.test(rt.path.toLowerCase())), `قاعدة بلا مسار: ${rule.method} ${rule.path}`);
  }
});

test('مفاتيح المسارات الحساسة كما وُصفت للمالك', () => {
  const key = (m: string, p: string) => pa.ruleFor(m, p)?.key ?? null;
  assert.equal(key('POST', '/api/tenants/t1/impersonate'), 'tenants.impersonate');
  assert.equal(key('POST', '/api/tenants/t1/reset-admin'), 'tenants.resetPassword');
  assert.equal(key('DELETE', '/api/tenants/t1'), 'tenants.delete');
  assert.equal(key('PUT', '/api/tenants/t1'), 'tenants.edit');
  assert.equal(key('POST', '/api/tenants'), 'tenants.create');
  assert.equal(key('GET', '/api/tenants/platform-totals'), 'tenants.totals');
  assert.equal(key('GET', '/api/tenants/t1/performance'), 'tenants.performance');
  assert.equal(key('POST', '/api/tenants/t1/ledger-reset'), 'tenants.ledger');
  assert.equal(key('GET', '/api/tenants/ops/cards'), null);
  assert.equal(key('POST', '/api/tenants/ops/weekly-report'), null);
  assert.equal(key('GET', '/api/leads/invoice-tool'), 'invoiceTool.view');
  assert.equal(key('GET', '/api/leads/l1'), 'leads.view');
  assert.equal(key('POST', '/api/leads/whatsapp-send'), 'leads.message');
  assert.equal(key('POST', '/api/leads/email'), 'leads.message');
  assert.equal(key('GET', '/api/leads/export/csv'), 'leads.export');
  assert.equal(key('DELETE', '/api/leads/l1'), 'leads.delete');
  assert.equal(key('POST', '/api/affiliate-admin/affiliates/a1/reveal-iban'), 'affiliates.iban');
  assert.equal(key('POST', '/api/affiliate-admin/payouts/p1/record'), 'affiliates.payouts');
  assert.equal(key('PUT', '/api/site-content'), 'content.edit');
  assert.equal(key('GET', '/api/analytics/request-stats'), 'live.requests');
  assert.equal(key('GET', '/api/finance/snapshot'), null);
  assert.equal(key('GET', '/api/platform-staff'), null);
  assert.equal(key('POST', '/api/platform-staff'), null);
  // قراءات حساسة تُسجَّل
  for (const p of ['/api/tenants/t1/performance', '/api/leads/invoice-tool', '/api/leads/export/csv', '/api/wa-inbox/thread/966500', '/api/analytics/request-stats']) {
    assert.equal(pa.ruleFor('GET', p)?.auditRead, true, p);
  }
});

test('المطابقة بلا حساسية حالة كتوجيه Express: الحرفيّ يغلب المعامِل مهما كُتبت الأحرف', () => {
  const at = (baseUrl: string, p: string) => pa.ruleFor('GET', pa.requestPath({ baseUrl, path: p }))?.key;
  assert.equal(at('/API/Leads', '/INVOICE-TOOL'), 'invoiceTool.view', 'لا leads.view عبر /:id');
  assert.equal(at('/api/tenants', '/Platform-Totals'), 'tenants.totals');
  assert.equal(at('/api/tenants', '/OPS'), undefined, '/ops ليس شركة');
  assert.equal(at('/api/leads', '/l1/'), 'leads.view', 'الشرطة الأخيرة');
  assert.equal(pa.ruleFor('HEAD', '/api/leads'), pa.ruleFor('GET', '/api/leads'));
});

test('الكتالوج: مفاتيح القواعد كلها فيه، ولا مفتاح للمالية ولا لإدارة الموظفين', () => {
  const keys = new Set(pa.STAFF_PERMISSIONS.map((p) => p.key));
  for (const rule of pa.ROUTE_RULES) assert.ok(keys.has(rule.key), rule.key);
  assert.ok(![...keys].some((k) => /^(finance|staff|platformStaff|paylink)\b/.test(k)));
  assert.equal(keys.size, pa.STAFF_PERMISSIONS.length, 'بلا تكرار');
  for (const k of keys) assert.ok([...pa.ROUTE_RULES].some((r) => r.key === k), `مفتاحٌ لا يفتح شيئاً: ${k}`);
});

// ═══════════════════ الحارس ═══════════════════

test('الحارس: بلا توكن ٤٠١، والمالك يمرّ ما دام حسابه نشطاً، وتوكن الشركة ومفتاح API ٤٠٣', async () => {
  reset();
  assert.equal((await call('GET', '/api/tenants')).status, 401);
  assert.equal((await call('GET', '/api/tenants', ownerToken())).status, 200);
  assert.equal((await call('GET', '/api/finance/snapshot', ownerToken())).status, 200, 'المالية للمالك كما كانت');
  owners.set('o1', { id: 'o1', isActive: false });
  assert.equal((await call('GET', '/api/tenants', ownerToken())).status, 401, 'المالك المعطَّل لا يمرّ');
  owners.set('o1', { id: 'o1', isActive: true });
  const company = jwt.sign({ id: 'a1', role: 'ADMIN', name: 'مدير', tenantId: 't1' }, SECRET);
  assert.equal((await call('GET', '/api/tenants', company)).status, 403);
  const imp = jwt.sign({ id: 'a1', role: 'SUPER_ADMIN', name: 'x', impersonated: true }, SECRET);
  assert.equal((await call('GET', '/api/tenants', imp)).status, 403, 'لا انتحال بدور المالك');
  assert.equal((await call('GET', '/api/tenants', null, undefined, { 'x-api-key': `fsk_${'a'.repeat(40)}` })).status, 403);
});

test('الموظف: يمنع افتراضاً، ويمرّ بالمفتاح وحده، والمالية وإدارة الموظفين ٤٠٣ ولو بكل المفاتيح', async () => {
  reset();
  const s = addStaff({ permissions: ['leads.view'] });
  const t = tokenOf(s);
  const ok = await call('GET', '/api/leads', t);
  assert.equal(ok.status, 200);
  assert.deepEqual(hits.at(-1)!.user, { id: s.id, role: 'PLATFORM_STAFF', name: s.name });
  const denied = await call('DELETE', '/api/leads/l1', t);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'STAFF_FORBIDDEN');
  assert.equal((await call('GET', '/api/tenants', t)).status, 403, 'قسمٌ لم يُمنح');
  s.permissions = pa.STAFF_PERMISSIONS.map((p) => p.key);
  for (const [m, u] of [['GET', '/api/finance/snapshot'], ['GET', '/api/tenants/ops/cards'], ['GET', '/api/platform-staff'], ['POST', '/api/platform-staff'], ['GET', '/api/platform-staff/audit']] as const) {
    assert.equal((await call(m, u, t, m === 'POST' ? { name: 'x y', email: 'z@z.co' } : undefined)).status, 403, `${m} ${u}`);
  }
  assert.equal(staff.size, 1, 'لم يُنشئ موظفاً');
});

test('توكن الموظف لا يصلح لأي مسارٍ آخر في المنصة: authenticate يردّه كتوكنٍ غريب', async () => {
  reset();
  const s = addStaff({ permissions: pa.STAFF_PERMISSIONS.map((p) => p.key) });
  assert.equal((await call('GET', '/api/company-thing', tokenOf(s))).status, 401);
  assert.throws(() => jwt.verify(tokenOf(s), SECRET), 'موقَّع بسرٍّ آخر');
});

test('التعطيل و«إخراج من كل الأجهزة» وسحب الصلاحية تسري على الطلب التالي', async () => {
  reset();
  const s = addStaff({ permissions: ['leads.view'] });
  const t = tokenOf(s);
  assert.equal((await call('GET', '/api/leads', t)).status, 200);
  s.permissions = [];
  assert.equal((await call('GET', '/api/leads', t)).status, 403);
  s.permissions = ['leads.view'];
  s.tokenVersion += 1;
  assert.equal((await call('GET', '/api/leads', t)).status, 401, 'توكنٌ صدر قبل الإخراج');
  assert.equal((await call('GET', '/api/leads', tokenOf(s))).status, 200);
  s.isActive = false;
  assert.equal((await call('GET', '/api/leads', tokenOf(s))).status, 401);
});

test('كلمة المرور المؤقتة: لا قسم حتى يغيّرها', async () => {
  reset();
  const s = addStaff({ permissions: ['leads.view'], mustChangePassword: true });
  const r = await call('GET', '/api/leads', tokenOf(s));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'STAFF_MUST_CHANGE_PASSWORD');
});

test('سجل النشاط: كتابة الموظف وقراءته الحساسة تُسجَّلان قبل التنفيذ، وتعذّر السجل يمنع الفعل، والقراءة العادية بلا سطر', async () => {
  reset();
  const s = addStaff({ permissions: ['leads.view', 'leads.edit', 'invoiceTool.view', 'waInbox.view'] });
  const t = tokenOf(s);
  await call('GET', '/api/leads', t);
  assert.equal(audits.length, 0, 'قراءةٌ عادية');
  await call('PUT', '/api/leads/3f2b9c1e-0000-4000-8000-000000000001', t, { stage: 'WON' });
  assert.equal(audits.length, 1);
  assert.equal(hits.at(-1)!.auditsAtNext, 1, 'السطر قبل المعالج');
  assert.deepEqual(
    { actorType: audits[0].actorType, actorId: audits[0].actorId, action: audits[0].action, method: audits[0].method, targetId: audits[0].targetId },
    { actorType: 'STAFF', actorId: s.id, action: 'leads.edit', method: 'PUT', targetId: '3f2b9c1e-0000-4000-8000-000000000001' },
  );
  await call('GET', '/api/wa-inbox/thread/966500000000', t);
  assert.equal(audits.at(-1)!.action, 'waInbox.view', 'محادثة واتساب قراءةٌ حساسة');
  auditFails = true;
  const before = hits.length;
  const r = await call('POST', '/api/leads', t, { name: 'x' });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'AUDIT_UNAVAILABLE');
  assert.equal(hits.length, before, 'لم يُنفَّذ');
});

test('أفعال المالك الحساسة تُسجَّل، وقراءاته وتعديلاته العادية لا', async () => {
  reset();
  await call('GET', '/api/tenants', ownerToken());
  await call('PUT', '/api/leads/l1', ownerToken(), {});
  assert.equal(audits.length, 0);
  await call('POST', '/api/tenants/t1/impersonate', ownerToken());
  await call('POST', '/api/tenants/t1/reset-admin', ownerToken(), { newPassword: 'x' });
  await call('DELETE', '/api/tenants/t1', ownerToken());
  assert.deepEqual(audits.map((a) => [a.actorType, a.action]), [['OWNER', 'tenants.impersonate'], ['OWNER', 'tenants.resetPassword'], ['OWNER', 'tenants.delete']]);
  assert.ok(audits.every((a) => a.detail === null), 'لا يُخزَّن جسم الطلب (كلمات المرور)');
});

// ═══════════════════ جلسة «دخول» إلى حساب شركة ═══════════════════

test('«دخول»: التوكن يحمل مُصدِره، ويسقط بتعطيله أو إخراجه أو سحب صلاحية الدخول منه — وتوكنٌ بلا مُصدِر لا يُقبل', async () => {
  reset();
  assert.deepEqual(pa.impersonationIssuer({ user: { id: 'o1', role: 'SUPER_ADMIN', name: 'م' } } as never), { by: 'o1', byKind: 'OWNER' });
  const s = addStaff({ permissions: ['tenants.view', 'tenants.impersonate'] });
  const issuer = pa.impersonationIssuer({ user: { id: s.id, role: 'PLATFORM_STAFF', name: s.name }, platformStaff: { id: s.id, name: s.name, permissions: s.permissions, tokenVersion: s.tokenVersion } } as never);
  assert.deepEqual(issuer, { by: s.id, byKind: 'STAFF', btv: 0 });
  const sign = (extra: Record<string, unknown>) => jwt.sign({ id: 'a1', role: 'ADMIN', name: 'مدير', tenantId: 't1', impersonated: true, ...extra }, SECRET);
  const viaStaff = sign(issuer);
  assert.equal((await call('GET', '/api/company-thing', viaStaff)).status, 200);
  s.permissions = ['tenants.view'];
  assert.equal((await call('GET', '/api/company-thing', viaStaff)).status, 401, 'سُحبت صلاحية الدخول');
  s.permissions = ['tenants.view', 'tenants.impersonate'];
  s.tokenVersion = 1;
  assert.equal((await call('GET', '/api/company-thing', viaStaff)).status, 401, 'أُخرج من أجهزته');
  s.tokenVersion = 0;
  s.isActive = false;
  assert.equal((await call('GET', '/api/company-thing', viaStaff)).status, 401, 'عُطّل');
  const viaOwner = sign({ by: 'o1', byKind: 'OWNER' });
  assert.equal((await call('GET', '/api/company-thing', viaOwner)).status, 200);
  owners.set('o1', { id: 'o1', isActive: false });
  assert.equal((await call('GET', '/api/company-thing', viaOwner)).status, 401);
  const legacy = await call('GET', '/api/company-thing', sign({}));
  assert.equal(legacy.status, 401);
  assert.equal(legacy.body.code, 'IMPERSONATION_ENDED');
  // غير الانتحال لا يُقرأ له مُصدِر
  assert.equal((await call('GET', '/api/company-thing', jwt.sign({ id: 'a1', role: 'ADMIN', name: 'م', tenantId: 't1' }, SECRET))).status, 200);
});

test('tenants.ts يوقّع «دخول» بمُصدِره', () => {
  const src = read('routes', 'tenants.ts');
  assert.match(src, /impersonated: true, \.\.\.impersonationIssuer\(req\) \}/);
  assert.match(read('middleware', 'auth.ts'), /if \(payload\.impersonated\) \{\n\s+try \{\n\s+const issuer = await liveImpersonationIssuer\(payload\);\n\s+if \(!issuer\) \{/);
});

// ═══════════════════ الدخول وكلمة المرور ═══════════════════

test('الدخول: بريدٌ بلا حالة أحرف، وقفلٌ بعد خمس محاولات خاطئة، والمعطَّل لا يدخل، والنجاح يصفّر العدّاد', async () => {
  reset();
  const s = addStaff({ email: 'sara@fieldsa.net', permissions: ['leads.view'] });
  const ok = await call('POST', '/api/staff-auth/login', null, { email: 'Sara@FieldSa.net', password: 'Secret123' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.user.role, 'PLATFORM_STAFF');
  assert.deepEqual(ok.body.data.user.permissions, ['leads.view']);
  assert.equal((await call('GET', '/api/leads', ok.body.data.token)).status, 200);
  assert.equal(audits.at(-1)!.action, 'staff.login');
  for (let i = 0; i < STAFF_MAX_FAILED; i++) {
    assert.equal((await call('POST', '/api/staff-auth/login', null, { email: s.email, password: 'wrong' })).status, 401);
  }
  // المقفل يُردّ بالـ٤٠١ نفسه ونصّه — ٤٢٣ كان يكشف أن البريد لموظفٍ حقيقي (platform-staff-auth.test.ts للتفاصيل)
  const locked = await call('POST', '/api/staff-auth/login', null, { email: s.email, password: 'Secret123' });
  assert.equal(locked.status, 401);
  assert.ok(s.lockedUntil && s.lockedUntil.getTime() > Date.now(), 'قُفل بعد الخامسة');
  s.lockedUntil = null;
  s.isActive = false;
  assert.equal((await call('POST', '/api/staff-auth/login', null, { email: s.email, password: 'Secret123' })).status, 401);
  assert.equal((await call('POST', '/api/staff-auth/login', null, { email: 'nobody@x.co', password: 'Secret123' })).status, 401);
});

test('تغيير كلمة المرور المؤقتة: يفتح الأقسام، ويُسقط التوكن القديم، ويرفض الحالية الخاطئة', async () => {
  reset();
  const s = addStaff({ permissions: ['leads.view'], mustChangePassword: true });
  const t = tokenOf(s);
  assert.equal((await call('GET', '/api/staff-auth/me', t)).body.data.mustChangePassword, true, '/me يعمل قبل التغيير');
  assert.equal((await call('POST', '/api/staff-auth/change-password', t, { currentPassword: 'nope', newPassword: 'NewSecret99' })).status, 400);
  const r = await call('POST', '/api/staff-auth/change-password', t, { currentPassword: 'Secret123', newPassword: 'NewSecret99' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.user.mustChangePassword, false);
  assert.equal((await call('GET', '/api/leads', t)).status, 401, 'التوكن القديم سقط');
  assert.equal((await call('GET', '/api/leads', r.body.data.token)).status, 200);
});

// ═══════════════════ إدارة الموظفين (المالك) ═══════════════════

test('إدارة الموظفين: المالك ينشئ بكلمة مرورٍ مؤقتة تظهر مرة، والمفاتيح من الكتالوج وحده، وإعادة كلمة المرور والإخراج والتعطيل تُسقط الجلسات', async () => {
  reset();
  const bad = await call('POST', '/api/platform-staff', ownerToken(), { name: 'سارة', email: 'sara@x.co', permissions: ['finance.view'] });
  assert.equal(bad.status, 400, 'مفتاحٌ ليس في الكتالوج');
  const c = await call('POST', '/api/platform-staff', ownerToken(), { name: 'سارة', email: 'Sara@X.co', permissions: ['leads.view', 'leads.view'] });
  assert.equal(c.status, 201);
  const id = c.body.data.staff.id as string;
  assert.equal(c.body.data.staff.email, 'sara@x.co');
  assert.deepEqual(c.body.data.staff.permissions, ['leads.view']);
  assert.ok(!('passwordHash' in c.body.data.staff));
  assert.equal(staff.get(id)!.mustChangePassword, true);
  assert.ok(await bcrypt.compare(c.body.data.password, staff.get(id)!.passwordHash));
  assert.equal((await call('POST', '/api/platform-staff', ownerToken(), { name: 'أخرى', email: 'sara@x.co' })).status, 409);
  const list = await call('GET', '/api/platform-staff', ownerToken());
  assert.ok(list.body.data.every((x: Record<string, unknown>) => !('passwordHash' in x)), 'القائمة بلا تجزئة');
  const tv0 = staff.get(id)!.tokenVersion;
  await call('POST', `/api/platform-staff/${id}/revoke-sessions`, ownerToken());
  assert.equal(staff.get(id)!.tokenVersion, tv0 + 1);
  const rp = await call('POST', `/api/platform-staff/${id}/reset-password`, ownerToken());
  assert.equal(rp.status, 200);
  assert.equal(staff.get(id)!.tokenVersion, tv0 + 2);
  assert.equal(staff.get(id)!.mustChangePassword, true);
  await call('PUT', `/api/platform-staff/${id}`, ownerToken(), { isActive: false });
  assert.equal(staff.get(id)!.tokenVersion, tv0 + 3, 'التعطيل يُسقط الجلسات');
  assert.deepEqual(audits.map((a) => a.action), ['staff.create', 'staff.revokeSessions', 'staff.resetPassword', 'staff.update']);
  const cat = await call('GET', '/api/platform-staff/catalog', ownerToken());
  assert.equal(cat.body.data.length, pa.STAFF_PERMISSIONS.length);
  assert.equal((await call('DELETE', `/api/platform-staff/${id}`, ownerToken())).status, 200);
  assert.equal(staff.has(id), false);
});

// ═══════════════════ محتوى الموقع ومولد الفواتير ═══════════════════

test('محتوى الموقع من الموظف: نصوص وروابط فقط — لا وسم ولا علامة تنصيص مزدوجة ولا مخطّط سكربت، وما لم يتغيّر لا يُفحص', () => {
  const prev = { hero: { title: 'قديم <b>غامق</b>' }, social: { x: 'https://x.com/fs' } };
  assert.equal(staffUnsafeChange({ hero: { title: 'قديم <b>غامق</b>' }, social: { x: 'https://x.com/fs' } }, prev), null, 'محتوى المالك القائم');
  assert.equal(staffUnsafeChange({ hero: { title: 'عنوانٌ جديد للمندوب\'s app' } }, prev), null, 'نصٌّ عادي وفاصلةٌ عليا');
  assert.equal(staffUnsafeChange({ heroImage: 'data:image/png;base64,iVBORw0KGgo=' }, prev), null);
  assert.equal(staffUnsafeChange({ hero: { title: 'x<img src=x onerror=alert(1)>' } }, prev), 'hero.title');
  assert.equal(staffUnsafeChange({ social: { x: 'https://x.com/" onmouseover="alert(1)' } }, prev), 'social.x');
  assert.equal(staffUnsafeChange({ social: { x: 'javascript:alert(1)' } }, prev), 'social.x');
  assert.equal(staffUnsafeChange({ heroImage: 'data:text/html;base64,PHNjcmlwdD4=' }, prev), 'heroImage');
  assert.equal(staffUnsafeChange({ items: [{ t: 'ok' }, { t: '{{hero.title}}' }] }, prev), 'items.1.t');
  const src = read('routes', 'siteContent.ts');
  assert.match(src, /if \(req\.platformStaff\) \{[\s\S]*staffUnsafeChange\(req\.body \?\? \{\}, prev\)[\s\S]*STAFF_CONTENT_UNSAFE/);
});

test('مولد الفواتير صلاحيةٌ مستقلة: القائمة والتصدير لا يصلانهم بمرشّح المصدر، والتفاصيل كأنهم غير موجودين', () => {
  const src = read('routes', 'leads.ts');
  assert.match(src, /if \(where\.source === 'invoice-tool' && !staffHas\(req, 'invoiceTool\.view'\)\) where\.source = \{ not: 'invoice-tool' \};/);
  assert.equal((src.match(/const where = leadWhereFor\(req\);/g) ?? []).length, 2, 'القائمة والتصدير');
  assert.equal((src.match(/buildLeadWhere\(/g) ?? []).length, 2, 'التعريف واستعماله في leadWhereFor وحده');
  assert.match(src, /if \(!lead \|\| \(lead\.source === 'invoice-tool' && !staffHas\(req, 'invoiceTool\.view'\)\)\)/);
  assert.equal(pa.staffHas({} as never, 'invoiceTool.view'), true, 'المالك');
  assert.equal(pa.staffHas({ platformStaff: { id: 's', name: 'm', permissions: ['leads.view'], tokenVersion: 0 } } as never, 'invoiceTool.view'), false);
});

test('روابط الدفع: مسارات /owner خلف حارس اللوحة قبل مصادقة الشركة — الموظف ٤٠٣ لا ٤٠١', () => {
  const src = read('routes', 'paylink.ts');
  const gate = src.indexOf("router.use('/owner', platformGate);");
  assert.ok(gate > 0 && gate < src.indexOf('router.use(authenticate);'));
});

// ═══════════════════ قنوات دائمة من جلسة «دخول» وإنشاء الشركة (جولة التحقق الثانية) ═══════════════════

test('قنوات تبقى بعد سقوط جلسة الموظف مغلقة: هاتف الشركة وERP وسرّ ويبهوك هاتف، وكلمة مرور مدير الشركة الجديدة إلى بريده', () => {
  const company = read('routes', 'company.ts');
  assert.match(company, /if \(isStaffImpersonation\(req\) && await staffChangesPhone\(tid, data\.phone\) && refuseStaffCredentials\(req, res\)\) return;/);
  const erp = read('routes', 'erp.ts');
  const put = erp.slice(erp.indexOf("router.put('/settings'"));
  assert.ok(put.indexOf('if (refuseStaffCredentials(req, res)) return;') > 0 && put.indexOf('if (refuseStaffCredentials(req, res)) return;') < put.indexOf('settingsSchema.parse'));
  const wn = read('routes', 'workNumbers.ts');
  assert.equal((wn.match(/publicIntegration\([^)]*isStaffImpersonation\(req\)\)/g) ?? []).length, 2, 'القراءة والحفظ');
  assert.match(wn, /hideSecret \? '••••••' : webhookSecret/);
  const tenants = read('routes', 'tenants.ts');
  const create = tenants.slice(tenants.indexOf("router.post('/', async"), tenants.indexOf("router.put('/:id'"));
  assert.match(create, /if \(byStaff && body\.adminPassword !== undefined\)/);
  assert.match(create, /const password = byStaff \? tempPassword\(\) : body\.adminPassword!;/);
  assert.ok(create.indexOf('await sendMail(') < create.indexOf('prisma.$transaction'), 'البريد قبل الإنشاء');
  assert.doesNotMatch(create.slice(create.indexOf('res.status(201)')), /password[,:} ]/i, 'لا كلمة مرور في الردّ');
});

test('العملاء المحتملون: لا صفّ بمصدر المولد من موظفٍ بلا صلاحيته، والبريد الآلي من يده لا يراسلهم', () => {
  const leads = read('routes', 'leads.ts');
  assert.match(leads, /source: sourceFor\(req, body\.source\) \|\| 'manual'/);
  assert.match(leads, /source: sourceFor\(req, l\.source\) \|\| 'csv'/);
  assert.match(leads, /runAutoEmailBatch\(\{ excludeTool: !staffHas\(req, 'invoiceTool\.view'\) \}\)/);
  assert.match(read('services', 'leadEmailer.ts'), /if \(opts\.excludeTool\) base\.source = cfg\.source === 'invoice-tool' \? \{ in: \[\] \} : \(cfg\.source \|\| \{ not: 'invoice-tool' \}\);/);
});

test('حارس /auth/change-password لجلسة الموظف يطابق مسار التوجيه لا originalUrl (الرابط المطلق)', () => {
  const auth = read('middleware', 'auth.ts');
  assert.match(auth, /return `\$\{req\.baseUrl \?\? ''\}\$\{req\.path \?\? ''\}`\.toLowerCase\(\)/);
  assert.doesNotMatch(auth.slice(auth.indexOf('function normalizedUrlPath'), auth.indexOf('function normalizedUrlPath') + 400), /originalUrl \?\?/);
});

test('عدد عملاء الشركات للمالك وحده: لا يُقرأ لموظف المنصة في القائمة ولا في الشركة المفردة، ولا عمود له في لوحته', () => {
  const tenants = read('routes', 'tenants.ts');
  assert.equal((tenants.match(/customers: !req\.platformStaff/g) ?? []).length, 2);
  assert.doesNotMatch(tenants, /_count: \{ select: \{[^}]*customers: true/, 'لا عدّ عملاء بلا شرط في مسارات الشركات');
  const page = fs.readFileSync(path.join(SRC, '..', '..', 'web-admin', 'src', 'pages', 'PlatformPage.tsx'), 'utf8');
  assert.match(page, /customers: isOwner,/);
  assert.match(page, /\{perms\.customers && <th className="text-center">\{tr\('عملاء'\)\}<\/th>\}/);
  assert.match(page, /\{perms\.customers && <td className="text-center text-gray-600">\{t\._count\?\.customers \?\? 0\}<\/td>\}/);
});
