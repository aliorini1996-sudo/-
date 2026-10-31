// «إضافة وحدة فرعية أصغر» (convert-base) — من يُسمح له (مواصفة الوحدة الرئيسية §2.3، §2.4، §3 البند ١٤، D14، D15):
//   • المصفوفة بالبوابتين (الإطلاق في الكود وعلم الشركة) مغلقتين ومفتوحتين، والترتيب الملزم، وconvertBaseUiCode بلا البادئة.
//   • convertBaseRefusalFor: الصفّ من القاعدة لا من التوكن، والبوابة المغلقة لا تقرأ شيئاً.
//   • الحقلان canConvertBase وconvertBaseRefusalCode في ردّ POST /auth/login وردّ الانتحال (POST /tenants/:id/impersonate) و/me
//     من مصدرٍ واحد (adminPermissionFields / ownerSessionPermissionFields).
//   • علم الشركة convertBaseOpen: يكتبه المالك من PUT /tenants/:id، وموظف المنصّة لا يغيّره، والقراءة تحمل convertBaseReleased.
//   • الحارس قبل convertBaseSchema.parse حرفياً (ثابت).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

process.env.JWT_SECRET = 'convert-base-access-test-secret';
const SECRET = process.env.JWT_SECRET;
const SRC = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');

/* eslint-disable @typescript-eslint/no-explicit-any */
type Call = { op: string; args: any };
let calls: Call[] = [];
let scripted: Record<string, (args: any) => unknown> = {};
function defaultFor(method: string): unknown {
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (method === 'updateMany' || method === 'deleteMany' || method === 'createMany') return { count: 0 };
  return null;
}
const prismaFake: any = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (arg: unknown) => {
        calls.push({ op: '$transaction', args: null });
        return typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prismaFake) : Promise.all(arg as Promise<unknown>[]);
      };
    }
    if (key === '$queryRaw' || key === '$executeRaw') return async () => (key === '$queryRaw' ? [] : 0);
    if (key === 'then') return undefined;
    return new Proxy({}, {
      get: (_m, method: string) => async (args: unknown) => {
        calls.push({ op: `${key}.${method}`, args });
        const fn = scripted[`${key}.${method}`];
        return fn ? fn(args) : defaultFor(method);
      },
    });
  },
});

const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
stub('config/database', { default: prismaFake });
stub('services/mailer', { async sendMail() { return true; }, mailLayout: () => '' });

let meUser: Record<string, unknown> = { id: 'a1', role: 'ADMIN', tenantId: 'T1' };
/* eslint-disable @typescript-eslint/no-var-requires */
const realAuth = require('../middleware/auth') as Record<string, unknown>;
stub('middleware/auth', { ...realAuth, authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = meUser; next(); } });
const access = require('../services/convertBaseAccess') as typeof import('../services/convertBaseAccess');
const authModule = require('../routes/auth') as typeof import('../routes/auth');
const tenantsModule = require('../routes/tenants') as typeof import('../routes/tenants');
const limits = require('../middleware/rateLimits') as typeof import('../middleware/rateLimits');
const pa = require('../services/platformAccess') as typeof import('../services/platformAccess');
/* eslint-enable @typescript-eslint/no-var-requires */
const { convertBaseRefusal, convertBaseUiCode, convertBaseRefusalFor, CONVERT_BASE_OPEN_TO_COMPANY } = access;

let server: { port: number; close: () => Promise<void> } | null = null;
after(async () => { await server?.close(); server = null; });
async function call(method: string, url: string, body?: unknown, token?: string): Promise<{ status: number; body: Record<string, any> }> {
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authModule.default);
    app.use('/api/tenants', tenantsModule.default);
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ success: false, message: err.message }); });
    const s = http.createServer(app);
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
  }
  const r = await fetch(`http://127.0.0.1:${server.port}${url}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : {} };
}
const reset = (): void => {
  calls = [];
  // سجل نشاط المنصة: كتابات المالك والموظف تُسجَّل قبل التنفيذ (platformGate)
  scripted = { 'platformAuditLog.create': () => ({ id: 'aud-1' }) };
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1']) limits.authLimiter.resetKey(ip);
};
const ownerToken = (): string => jwt.sign({ id: 'o1', role: 'SUPER_ADMIN', name: 'المالك' }, SECRET);

// ═══ المصفوفة (§3) ═══

const FULL = { role: 'ADMIN', isActive: true, scopeEnabled: false, canManageProducts: true, canManageVanStock: true, canManageInvoices: true, tenantOpen: true };
const MATRIX: Array<[string, Record<string, unknown>, string | null]> = [
  ['المالك (impersonated)', { impersonated: true, role: 'ACCOUNTANT', isActive: false, scopeEnabled: true, canManageProducts: false, tenantOpen: false }, null],
  ['ADMIN غير مقيّد بالصلاحيات الثلاث', FULL, null],
  ['MANAGER غير مقيّد بالصلاحيات الثلاث', { ...FULL, role: 'MANAGER' }, null],
  ['الصلاحيات غائبة (افتراضها true في العمود)', { role: 'ADMIN', isActive: true, tenantOpen: true }, null],
  ['ACCOUNTANT', { ...FULL, role: 'ACCOUNTANT' }, 'CONVERT_BASE_ROLE_FORBIDDEN'],
  ['دورٌ مجهول', { ...FULL, role: 'SALES_REP' }, 'CONVERT_BASE_ROLE_FORBIDDEN'],
  ['حساب موقوف', { ...FULL, isActive: false }, 'CONVERT_BASE_ROLE_FORBIDDEN'],
  ['المقيّد بالنطاق', { ...FULL, scopeEnabled: true }, 'CONVERT_BASE_SCOPED_USER'],
  ['canManageProducts = false', { ...FULL, canManageProducts: false }, 'CONVERT_BASE_FORBIDDEN'],
  ['canManageVanStock = false', { ...FULL, canManageVanStock: false }, 'CONVERT_BASE_FORBIDDEN'],
  ['canManageInvoices = false', { ...FULL, canManageInvoices: false }, 'CONVERT_BASE_FORBIDDEN'],
  ['مفتاح API', { ...FULL, apiKeyId: 'k1' }, 'CONVERT_BASE_INTERACTIVE_ONLY'],
  ['مفتاح API ولو أصدره المالك بجلسته', { ...FULL, apiKeyId: 'k1', impersonated: true }, 'CONVERT_BASE_INTERACTIVE_ONLY'],
];

test('المصفوفة والبوابتان مفتوحتان (open = true، tenantOpen = true)', () => {
  for (const [name, actor, code] of MATRIX) {
    const r = convertBaseRefusal(actor, true);
    assert.equal(r?.code ?? null, code, name);
    if (r) {
      assert.equal(r.status, 403, name);
      assert.ok(r.message.length > 0);
    }
  }
});

test('أيّ بوابةٍ مغلقة: كل مستخدم شركة ⇒ OWNER_ONLY بالرسالة القائمة حرفياً، والمالك ✓، والمفتاح ⇒ INTERACTIVE_ONLY', () => {
  assert.equal(CONVERT_BASE_OPEN_TO_COMPANY, true, 'بوابة الإطلاق قُلبت في المرحلة ٥ (REVIEW.md «العنقود مغلق») — والمغلقة تُختبر بمعاملها الصريح');
  for (const [open, tenantOpen] of [[false, true], [true, false], [false, false]] as const) {
    for (const [name, actor] of MATRIX) {
      const a = { ...actor, ...(actor.impersonated ? {} : { tenantOpen }) };
      const r = convertBaseRefusal(a, open);
      const want = actor.apiKeyId ? 'CONVERT_BASE_INTERACTIVE_ONLY' : actor.impersonated ? null : 'CONVERT_BASE_OWNER_ONLY';
      assert.equal(r?.code ?? null, want, `${name} (open=${open}, tenantOpen=${tenantOpen})`);
    }
  }
  // الافتراض = بوابة الإطلاق (مفتوحة): الحكم لعلم الشركة وحده
  assert.equal(convertBaseRefusal(FULL)?.code ?? null, null, 'الافتراض = بوابة الإطلاق: المدير بعلم شركته المفتوح ✓');
  assert.equal(convertBaseRefusal({ ...FULL, tenantOpen: false })?.code, 'CONVERT_BASE_OWNER_ONLY', 'وعلم الشركة المطفأ ⇒ OWNER_ONLY');
  assert.equal(convertBaseRefusal({ ...FULL, tenantOpen: undefined })?.code, 'CONVERT_BASE_OWNER_ONLY', 'وعلمٌ غائب يُقرأ مطفأً');
  assert.equal(convertBaseRefusal(FULL, false)!.message, 'تحويل وحدة الأساس متاح عبر الدعم الفني مؤقتا — تواصل معنا، أو أنشئ الصنف بوحداته من البداية');
  assert.equal(convertBaseRefusal({ ...FULL, apiKeyId: 'k' }, true)!.message, 'إضافة وحدة فرعية أصغر تتم من لوحة الإدارة وحدها — لا عبر مفتاح API');
});

test('convertBaseUiCode = رمز الحارس نفسه بلا البادئة (والمفتاح لا يصل الواجهة)', () => {
  for (const open of [true, false]) {
    for (const [name, actor] of MATRIX) {
      if (actor.apiKeyId) continue;
      const r = convertBaseRefusal(actor, open);
      assert.equal(convertBaseUiCode(actor, open), r ? r.code.replace(/^CONVERT_BASE_/, '') : null, `${name} open=${open}`);
    }
  }
  assert.equal(convertBaseUiCode({ ...FULL, scopeEnabled: true }, true), 'SCOPED_USER');
  assert.equal(convertBaseUiCode({ ...FULL, canManageInvoices: false }, true), 'FORBIDDEN');
  assert.equal(convertBaseUiCode({ ...FULL, role: 'ACCOUNTANT' }, true), 'ROLE_FORBIDDEN');
  // الافتراض = بوابة الإطلاق (مفتوحة منذ المرحلة ٥)
  assert.equal(convertBaseUiCode(FULL), null);
  assert.equal(convertBaseUiCode({ ...FULL, tenantOpen: false }), 'OWNER_ONLY');
  assert.equal(convertBaseUiCode(FULL, false), 'OWNER_ONLY');
});

test('convertBaseRefusalFor: البوابة المغلقة لا تقرأ شيئاً؛ والمفتوحة تقرأ صفّ المدير وعلم شركته من القاعدة لا من التوكن', async () => {
  reset();
  const req = (user: Record<string, unknown>) => ({ user: { tenantId: 'T1', ...user } }) as any;
  assert.equal((await convertBaseRefusalFor(req({ id: 'a1', role: 'ADMIN' }), false))?.code, 'CONVERT_BASE_OWNER_ONLY');
  assert.equal((await convertBaseRefusalFor(req({ id: 'a1', role: 'ADMIN', impersonated: true }), false)), null);
  assert.equal((await convertBaseRefusalFor(req({ id: 'a1', role: 'ADMIN', impersonated: true }))), null, 'المالك بالافتراض أيضاً بلا قراءة');
  assert.equal((await convertBaseRefusalFor(req({ id: 'a1', role: 'ADMIN', apiKeyId: 'k1', impersonated: true }), true))?.code, 'CONVERT_BASE_INTERACTIVE_ONLY');
  assert.deepEqual(calls, [], 'لا استعلام');

  const row = { role: 'MANAGER', isActive: true, scopeEnabled: false, canManageProducts: true, canManageVanStock: true, canManageInvoices: true, tenant: { convertBaseOpen: true } };
  for (const [patch, code] of [
    [{}, null], [{ tenant: { convertBaseOpen: false } }, 'CONVERT_BASE_OWNER_ONLY'], [{ isActive: false }, 'CONVERT_BASE_ROLE_FORBIDDEN'],
    [{ scopeEnabled: true }, 'CONVERT_BASE_SCOPED_USER'], [{ canManageVanStock: false }, 'CONVERT_BASE_FORBIDDEN'],
  ] as const) {
    reset();
    scripted['admin.findFirst'] = () => ({ ...row, ...patch });
    // التوكن يقول ADMIN، والقاعدة تحكم
    const r = await convertBaseRefusalFor(req({ id: 'a1', role: 'ADMIN' }), true);
    assert.equal(r?.code ?? null, code, JSON.stringify(patch));
    assert.deepEqual(calls[0].args.where, { id: 'a1', tenantId: 'T1' });
  }
  reset();
  assert.equal((await convertBaseRefusalFor(req({ id: 'gone', role: 'ADMIN' }), true))?.code, 'CONVERT_BASE_OWNER_ONLY', 'صفٌّ غائب ⇒ مغلق');

  // المرحلة ٥: المسار يستدعيها بلا معامل، فالبوابة المفتوحة في الكود تُحيل الحكم إلى علم الشركة من القاعدة
  reset();
  scripted['admin.findFirst'] = () => ({ ...row, tenant: { convertBaseOpen: false } });
  assert.equal((await convertBaseRefusalFor(req({ id: 'a1', role: 'ADMIN' })))?.code, 'CONVERT_BASE_OWNER_ONLY', 'الافتراض: علم الشركة المطفأ');
  assert.deepEqual(calls.map((c) => c.op), ['admin.findFirst']);
  reset();
  scripted['admin.findFirst'] = () => row;
  assert.equal(await convertBaseRefusalFor(req({ id: 'a1', role: 'ADMIN' })), null, 'الافتراض: علم الشركة مفتوح والصلاحيات تامّة');
});

test('حارس ثابت: convertBaseRefusalFor(req) قبل convertBaseSchema.parse حرفياً، ولا isOwnerSession في المسار', () => {
  const src = read('routes/products.ts');
  const head = "router.post('/:id/convert-base'";
  const body = src.slice(src.indexOf(head), src.indexOf('\n});', src.indexOf(head)));
  const g = body.indexOf('const refusal = await convertBaseRefusalFor(req);\n    if (refusal) { res.status(refusal.status).json({ success: false, code: refusal.code, message: refusal.message }); return; }');
  const p = body.indexOf('convertBaseSchema.parse(req.body)');
  assert.ok(g > 0 && p > g, 'الحارس قبل الجسم');
  assert.doesNotMatch(body.slice(0, p), /isOwnerSession\(/);
});

// ═══ الحقلان في ردود الدخول والانتحال و/me ═══

const adminRow = (o: Record<string, unknown> = {}) => ({
  id: 'a1', tenantId: 'T1', name: 'مدير', email: 'm@co.sa', role: 'MANAGER', isActive: true, scopeEnabled: false, emailVerified: true,
  passwordHash: bcrypt.hashSync('Secret-123', 4), canManageProducts: true, canManageVanStock: true, canManageInvoices: true,
  tenant: { id: 'T1', name: 'شركة', isActive: true, subscriptionEndsAt: null, convertBaseOpen: true }, ...o,
});

test('POST /auth/login يحمل canConvertBase وconvertBaseRefusalCode من adminPermissionFields — وعلم الشركة المطفأ ⇒ OWNER_ONLY', async () => {
  // بوابة الإطلاق مفتوحة منذ المرحلة ٥: الحقلان يتبعان المصفوفة، وعلم الشركة من tenant المحمّل مع المدير (include: tenant)
  for (const [o, code] of [
    [{}, null], [{ scopeEnabled: true }, 'SCOPED_USER'], [{ role: 'ACCOUNTANT' }, 'ROLE_FORBIDDEN'], [{ canManageVanStock: false }, 'FORBIDDEN'],
    [{ tenant: { id: 'T1', name: 'ش', isActive: true, subscriptionEndsAt: null, convertBaseOpen: false } }, 'OWNER_ONLY'],
  ] as const) {
    reset();
    scripted['admin.findUnique'] = () => adminRow(o);
    const r = await call('POST', '/api/auth/login', { username: 'm@co.sa', password: 'Secret-123', role: 'admin' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.user.canConvertBase, code === null, JSON.stringify(o));
    assert.equal(r.body.data.user.convertBaseRefusalCode, code, JSON.stringify(o));
  }
  // والمصدر الواحد: الحقلان يتبعان المصفوفة
  const fields = authModule.adminPermissionFields(adminRow({ role: 'ACCOUNTANT' }));
  assert.deepEqual([fields.canConvertBase, fields.convertBaseRefusalCode], [false, 'ROLE_FORBIDDEN']);
  assert.deepEqual(convertBaseUiCode({ role: 'ACCOUNTANT', isActive: true, tenantOpen: true }, true), 'ROLE_FORBIDDEN');
  // التسجيل: لا شركة محمّلة ⇒ مغلق
  const signup = authModule.adminPermissionFields({ role: 'ADMIN', isActive: true });
  assert.deepEqual([signup.canConvertBase, signup.convertBaseRefusalCode], [false, 'OWNER_ONLY']);
  assert.deepEqual(
    (({ canConvertBase, convertBaseRefusalCode }) => ({ canConvertBase, convertBaseRefusalCode }))(authModule.ownerSessionPermissionFields()),
    { canConvertBase: true, convertBaseRefusalCode: null },
  );
});

test('الانتحال (POST /tenants/:id/impersonate): canConvertBase = true وconvertBaseRefusalCode = null فوق صلاحيات المدير', async () => {
  reset();
  scripted['superAdmin.findUnique'] = () => ({ isActive: true });
  scripted['tenant.findUnique'] = () => ({ id: 'T1', name: 'شركة' });
  scripted['admin.findFirst'] = () => adminRow({ role: 'ACCOUNTANT', scopeEnabled: true });
  const r = await call('POST', '/api/tenants/T1/impersonate', {}, ownerToken());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.user.canConvertBase, true);
  assert.equal(r.body.data.user.convertBaseRefusalCode, null);
});

test('/auth/me: الحقلان من المصدر نفسه، والنشاط وعلم الشركة يدخلان الحساب ولا يخرجان في الردّ', async () => {
  reset();
  meUser = { id: 'a1', role: 'ADMIN', tenantId: 'T1' };
  scripted['admin.findUnique'] = () => { const { passwordHash: _p, tenant: _t, ...rest } = adminRow(); return { ...rest, tenant: { convertBaseOpen: true } }; };
  const r = await call('GET', '/api/auth/me');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // بوابة الإطلاق مفتوحة (المرحلة ٥) وعلم الشركة مفتوح والصلاحيات تامّة ⇒ الزرّ
  assert.equal(r.body.data.canConvertBase, true);
  assert.equal(r.body.data.convertBaseRefusalCode, null);
  assert.ok(!('isActive' in r.body.data) && !('tenant' in r.body.data), 'شكل الردّ كما كان + الحقلان');
  const sel = calls.find((c) => c.op === 'admin.findUnique')!.args.select;
  assert.equal(sel.isActive, true);
  assert.deepEqual(sel.tenant, { select: { convertBaseOpen: true } });

  // وعلم الشركة المطفأ أو الحساب الموقوف من الصفّ نفسه ⇒ لا زرّ ورمز سببه
  for (const [patch, code] of [[{ tenant: { convertBaseOpen: false } }, 'OWNER_ONLY'], [{ isActive: false }, 'ROLE_FORBIDDEN']] as const) {
    reset();
    scripted['admin.findUnique'] = () => { const { passwordHash: _p, tenant: _t, ...rest } = adminRow(); return { ...rest, tenant: { convertBaseOpen: true }, ...patch }; };
    const off = await call('GET', '/api/auth/me');
    assert.equal(off.body.data.canConvertBase, false, JSON.stringify(patch));
    assert.equal(off.body.data.convertBaseRefusalCode, code, JSON.stringify(patch));
  }

  reset();
  meUser = { id: 'a1', role: 'ADMIN', tenantId: 'T1', impersonated: true };
  scripted['admin.findUnique'] = () => ({ id: 'a1', role: 'ACCOUNTANT', isActive: true, scopeEnabled: true, tenant: { convertBaseOpen: false } });
  const own = await call('GET', '/api/auth/me');
  assert.equal(own.body.data.canConvertBase, true);
  assert.equal(own.body.data.convertBaseRefusalCode, null);
});

// ═══ علم الشركة ═══

test('علم الشركة: المالك يكتبه من PUT /tenants/:id، والقراءة تحمل convertBaseReleased (للقراءة فقط)', async () => {
  reset();
  scripted['superAdmin.findUnique'] = () => ({ isActive: true });
  scripted['tenant.update'] = (a) => ({ id: 'T1', ...a.data });
  const r = await call('PUT', '/api/tenants/T1', { convertBaseOpen: true }, ownerToken());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(calls.find((c) => c.op === 'tenant.update')!.args.data.convertBaseOpen, true);
  // الإطلاق ليس حقلاً يُكتب
  reset();
  scripted['superAdmin.findUnique'] = () => ({ isActive: true });
  scripted['tenant.update'] = (a) => ({ id: 'T1', ...a.data });
  await call('PUT', '/api/tenants/T1', { convertBaseReleased: true }, ownerToken());
  const upd = calls.find((c) => c.op === 'tenant.update');
  assert.ok(!upd || !('convertBaseReleased' in upd.args.data));

  reset();
  scripted['superAdmin.findUnique'] = () => ({ isActive: true });
  scripted['tenant.findUnique'] = () => ({ id: 'T1', name: 'شركة', convertBaseOpen: true, admins: [], _count: {} });
  const one = await call('GET', '/api/tenants/T1', undefined, ownerToken());
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.data.convertBaseOpen, true);
  // convertBaseReleased مرآة بوابة الإطلاق (مفتوحة منذ المرحلة ٥) — تُفعَّل بها خانة العلم في صفحة المنصّة
  assert.equal(one.body.data.convertBaseReleased, CONVERT_BASE_OPEN_TO_COMPANY);
  assert.equal(one.body.data.convertBaseReleased, true);

  reset();
  scripted['superAdmin.findUnique'] = () => ({ isActive: true });
  scripted['tenant.findMany'] = () => [{ id: 'T1', name: 'شركة', convertBaseOpen: false, accountingSuiteEnabled: false, accountingEnabled: false, glSettings: null }];
  const list = await call('GET', '/api/tenants', undefined, ownerToken());
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.data[0].convertBaseReleased, CONVERT_BASE_OPEN_TO_COMPANY);
  assert.equal(list.body.data[0].convertBaseOpen, false, 'علم الشركة كما في صفّها (افتراضه false) — قلب البوابة لا يفتح شركة');
});

test('علم الشركة: موظف المنصّة بـtenants.edit لا يغيّره (403 بلا كتابة)، والجسم الذي يعيد القيمة نفسها يمرّ', async () => {
  const staff = { id: 's1', name: 'سارة', email: 's@x.co', isActive: true, permissions: ['tenants.edit'], tokenVersion: 0, mustChangePassword: false };
  const token = pa.signStaffToken(staff);
  reset();
  scripted['platformStaff.findUnique'] = () => staff;
  scripted['tenant.findUnique'] = () => ({ convertBaseOpen: false });
  const r = await call('PUT', '/api/tenants/T1', { convertBaseOpen: true }, token);
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.code, 'CONVERT_BASE_FLAG_OWNER_ONLY');
  assert.ok(!calls.some((c) => c.op === 'tenant.update'));

  reset();
  scripted['platformStaff.findUnique'] = () => staff;
  scripted['tenant.findUnique'] = () => ({ convertBaseOpen: true });
  scripted['tenant.update'] = (a) => ({ id: 'T1', ...a.data });
  const same = await call('PUT', '/api/tenants/T1', { name: 'شركة', convertBaseOpen: true }, token);
  assert.equal(same.status, 200, JSON.stringify(same.body));
});
