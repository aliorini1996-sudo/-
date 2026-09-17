// اختبارات مسارات /api/zatca (ربط وحدة EGS لمدير الشركة): الصلاحيات والتسييج (علم المالك، الدولة، النطاق، الانتحال)،
// عزل الشركات (IDOR)، البيئات المسموحة ورفض sandbox على خادم الإنتاج، غياب مفتاح التشفير (503)، OTP لا يظهر في أي ردّ
// أو سجلّ أو نتيجة مهمّة، القفل وحدّ المعدّل، التفعيل (409)، فحص بيانات البائع وتحذيراتها، بدء المهمّة (202) واستطلاعها.
// لا قاعدة بيانات (مخزن ذاكرة Z4) ولا شبكة خارجية: حارس Z3 يُستورد أولاً، و«فاتورة» مزيّفة تُحقن في العميل؛ الطلبات
// تصل الموجّه عبر خادم HTTP على 127.0.0.1 داخل العملية (http.request لا fetch).
import { guardHits } from '../compliance/zatca/__fixtures__/z3-netguard';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { NextFunction, Response } from 'express';
import jwt from 'jsonwebtoken';
import morgan from 'morgan';
import { errorHandler } from '../middleware/errorHandler';
import {
  Harness, TENANT, assertNoLeaks, create, fakeSleep, harness, newOtp, otpPattern, sellerSettings,
} from '../compliance/zatca/__fixtures__/z4-harness';
import { EgsUnitView, ONBOARDING_CODES, RETIRE_CONFIRMATION_TEXT } from '../compliance/zatca/onboarding';
import { keyringFromEnv } from '../compliance/zatca/secrets';
import { z3Body } from '../compliance/zatca/__fixtures__/z3-fixtures';
import {
  AdminAccessRecord, ZATCA_ROUTE_CODES, ZatcaRouteDeps, companyZatcaFieldChanges, createZatcaRouter, csrDefaultLocation, csrTextProblem, httpStatusForCode, jobOutcomeOf, latinDigits,
  sellerReadiness, sellerWarnings, unitActivity, unitChecklist, validateSellerBody, zatcaEnvConfig, zatcaErrorGuard,
} from '../routes/zatca';
import { AuthRequest } from '../types';

const OTHER = 'tenant-2';
const ARABIC = /[؀-ۿ]/;

// ─── التقاط كل ما يُطبع (console) طوال الملف — يُمسح بحثاً عن OTP ───
const consoleLines: string[] = [];
for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const orig = console[m].bind(console);
  console[m] = (...args: unknown[]) => {
    consoleLines.push(args.map(a => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}` : JSON.stringify(a))).join(' '));
    orig(...args);
  };
}
after(() => {
  assert.equal(guardHits(), 0, 'محاولة شبكة حقيقية من اختبارات المسارات');
});

// ─── العُدّة ───

interface User {
  id: string;
  role: string;
  name: string;
  tenantId?: string;
  impersonated?: boolean;
  canManageCompanySettings?: boolean;
  scopeEnabled?: boolean;
}

const ADMIN: User = { id: 'admin-7', role: 'ADMIN', name: 'a', tenantId: TENANT };
const ADMIN2: User = { id: 'admin-9', role: 'ADMIN', name: 'b', tenantId: OTHER };

interface Rig {
  h: Harness;
  deps: ZatcaRouteDeps;
  router: ReturnType<typeof createZatcaRouter>;
  port: number;
  server: http.Server;
  flags: Map<string, boolean>;
  /** صفوف الحسابات في «القاعدة» بالمعرّف (null = محذوف) — غيابه = مطابق للتوكن. */
  admins: Map<string, AdminAccessRecord | null>;
  logs: string[];
  morganLines: string[];
  texts: string[];
  close: () => Promise<void>;
}

async function rig(o: {
  env?: 'simulation' | 'production';
  nodeEnv?: string;
  allowed?: string;
  deps?: Partial<ZatcaRouteDeps>;
  otpRateLimit?: { windowMs: number; limit: number };
  resumeRateLimit?: { windowMs: number; limit: number };
  /** مسارات إضافية تُركَّب قبل /api/zatca على التطبيق نفسه (مثل /api/auth الحقيقي). */
  mount?: (app: express.Express) => void;
} = {}): Promise<Rig> {
  const h = harness({ env: o.env ?? 'simulation' });
  h.store.settings.set(OTHER, sellerSettings({ tenantId: OTHER }));
  const flags = new Map<string, boolean>([[TENANT, true], [OTHER, true]]);
  const admins = new Map<string, AdminAccessRecord | null>();
  const logs: string[] = [];
  const morganLines: string[] = [];
  const deps: ZatcaRouteDeps = {
    authenticate: (req: AuthRequest, res: Response, next: NextFunction) => {
      const raw = req.headers['x-test-user'];
      if (typeof raw !== 'string') { res.status(401).json({ success: false, message: 'غير مصرح' }); return; }
      req.user = JSON.parse(raw);
      next();
    },
    // صفّ الحساب «في القاعدة»: افتراضياً مطابق للتوكن، وrig.admins يغيّره (مدير خُفِّض دوره وتوكنه ما زال ADMIN)
    loadAdmin: async req => {
      const u = req.user as User;
      if (admins.has(u.id)) return admins.get(u.id) ?? null;
      return { isActive: true, role: u.role, tenantId: u.tenantId ?? null, canManageCompanySettings: u.canManageCompanySettings ?? true };
    },
    isScopeRestricted: async req => (req.user as User).scopeEnabled === true,
    loadTenantFlag: async tid => flags.get(tid) === true,
    store: h.store,
    writeSeller: async (tid, patch) => {
      const s = h.store.settings.get(tid);
      if (!s) return false;
      Object.assign(s, patch);
      return true;
    },
    loadKeyring: () => h.keyring,
    clientFactory: h.client,
    now: h.clock.now,
    config: zatcaEnvConfig({ NODE_ENV: o.nodeEnv ?? 'production', ZATCA_ALLOWED_ENVS: o.allowed ?? 'simulation' }),
    sleep: fakeSleep(h),
    log: (event, fields) => logs.push(`${event} ${JSON.stringify(fields)}`),
    ...(o.otpRateLimit ? { otpRateLimit: o.otpRateLimit } : {}),
    ...(o.resumeRateLimit ? { resumeRateLimit: o.resumeRateLimit } : {}),
    ...o.deps,
  };
  const router = createZatcaRouter(deps);
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(morgan('combined', { stream: { write: (s: string) => { morganLines.push(s); } } }));
  o.mount?.(app);
  app.use('/api/zatca', router, zatcaErrorGuard);
  app.use(errorHandler);
  const server = http.createServer(app);
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  const r: Rig = {
    h, deps, router, port, server, flags, admins, logs, morganLines, texts: [],
    close: async () => {
      await router.idle();
      await new Promise(res => server.close(res));
    },
  };
  return r;
}

interface Reply {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
}

function call(r: Rig, method: string, url: string, opts: { user?: User | null; body?: unknown; raw?: string } = {}): Promise<Reply> {
  const user = opts.user === undefined ? ADMIN : opts.user;
  const payload = opts.raw !== undefined ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: r.port, method, path: `/api/zatca${url}`,
      headers: {
        ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...(user ? { 'x-test-user': JSON.stringify(user) } : {}),
      },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        r.texts.push(text);
        let body: unknown = null;
        try { body = JSON.parse(text); } catch { /* ليس JSON */ }
        resolve({ status: res.statusCode ?? 0, body, text });
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function createSimUnit(r: Rig, user: User = ADMIN): Promise<EgsUnitView> {
  const res = await call(r, 'POST', '/units', { user, body: { environment: 'simulation' } });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.data.unit.status, 'CSR_READY');
  return res.body.data.unit as EgsUnitView;
}

async function poll(r: Rig, unitId: string, user: User = ADMIN): Promise<Reply> {
  await r.router.idle();
  return call(r, 'GET', `/units/${unitId}`, { user });
}

/** كل ما خرج: الردود، سجلّ الموجّه، سطور morgan، وكل ما طُبع — مع المخزن ونتائج «الهيئة» (assertNoLeaks). */
function assertNothingLeaked(r: Rig) {
  const everything = [...r.texts, ...r.logs, ...r.morganLines, ...consoleLines];
  assertNoLeaks(r.h, everything);
  const joined = everything.join('\n');
  for (const k of ['privateKeyEnc', 'complianceSecretEnc', 'productionSecretEnc', 'complianceToken', 'productionToken', 'csrPem', 'PRIVATE KEY']) {
    assert.ok(!r.texts.join('\n').includes(k), `الردّ يحمل ${k}`);
  }
  return joined;
}

async function activeSimUnit(r: Rig): Promise<EgsUnitView> {
  const u = await createSimUnit(r);
  const start = await call(r, 'POST', `/units/${u.id}/onboard`, { body: { otp: r.h.otps.shift() } });
  assert.equal(start.status, 202, start.text);
  const done = await poll(r, u.id);
  assert.equal(done.body.data.unit.status, 'ACTIVE', done.text);
  return done.body.data.unit;
}

// ─────────────────────────────────────────────────────────────────────────────
// إعداد البيئات
// ─────────────────────────────────────────────────────────────────────────────

test('ZATCA_ALLOWED_ENVS: الافتراض simulation وحدها، القائمة تُحلَّل، قيمة مجهولة ⇒ لا بيئة، sandbox تُسقط على الإنتاج', () => {
  assert.deepEqual(zatcaEnvConfig({}).allowedEnvs, ['simulation']);
  assert.deepEqual(zatcaEnvConfig({ ZATCA_ALLOWED_ENVS: '  ' }).allowedEnvs, ['simulation']);
  assert.deepEqual(zatcaEnvConfig({ ZATCA_ALLOWED_ENVS: 'Simulation, production,simulation' }).allowedEnvs, ['simulation', 'production']);
  const typo = zatcaEnvConfig({ ZATCA_ALLOWED_ENVS: 'producton,simulation' });
  assert.deepEqual(typo.allowedEnvs, [], 'قيمة غير معروفة يجب أن تغلق كل البيئات');
  assert.equal(typo.issues[0].code, 'UNKNOWN_ENV');
  const prod = zatcaEnvConfig({ NODE_ENV: 'production', ZATCA_ALLOWED_ENVS: 'sandbox,simulation' });
  assert.deepEqual(prod.allowedEnvs, ['simulation']);
  assert.equal(prod.productionBackend, true);
  assert.deepEqual(prod.issues, [{ code: 'SANDBOX_IN_PRODUCTION', value: 'sandbox' }]);
  assert.deepEqual(zatcaEnvConfig({ NODE_ENV: 'production', ZATCA_ALLOWED_ENVS: 'sandbox' }).allowedEnvs, []);
  assert.deepEqual(zatcaEnvConfig({ NODE_ENV: 'development', ZATCA_ALLOWED_ENVS: 'sandbox' }).allowedEnvs, ['sandbox']);
});

// ─────────────────────────────────────────────────────────────────────────────
// الصلاحيات والتسييج
// ─────────────────────────────────────────────────────────────────────────────

test('الصلاحيات: بلا جلسة 401، مندوب ومالك المنصّة 403، مدير بلا صلاحية إعدادات الشركة 403، مقيّد النطاق 403، والمشرف 403', async () => {
  const r = await rig();
  try {
    assert.equal((await call(r, 'GET', '/overview', { user: null })).status, 401);
    const rep = await call(r, 'GET', '/overview', { user: { id: 'rep-1', role: 'SALES_REP', name: 'r', tenantId: TENANT } });
    assert.equal(rep.status, 403);
    assert.equal(rep.body.code, 'FORBIDDEN');
    const owner = await call(r, 'GET', '/overview', { user: { id: 'owner', role: 'SUPER_ADMIN', name: 'o' } });
    assert.equal(owner.status, 403);
    const noPerm = await call(r, 'POST', '/units', { user: { ...ADMIN, canManageCompanySettings: false }, body: { environment: 'simulation' } });
    assert.equal(noPerm.status, 403, 'صلاحية إعدادات الشركة تُنزع من المدير أيضاً');
    assert.equal(noPerm.body.message, 'لا تملك صلاحية الوصول لهذا القسم');
    const scoped = await call(r, 'POST', '/units', { user: { ...ADMIN, scopeEnabled: true }, body: { environment: 'simulation' } });
    assert.equal(scoped.status, 403);
    assert.equal(scoped.body.code, 'SCOPED_ADMIN');
    assert.match(scoped.body.message, ARABIC);
    const manager = await call(r, 'GET', '/overview', { user: { ...ADMIN, role: 'MANAGER' } });
    assert.equal(manager.status, 403, 'مدير الشركة وحده — لا قاعدة إعدادات الشركة (المشرف والمحاسب)');
    assert.equal(manager.body.code, 'COMPANY_ADMIN_ONLY');
    assert.equal((await call(r, 'GET', '/overview')).status, 200);
    assert.equal(r.h.store.received.length, 0, 'طلب مرفوض كتب في المخزن');
    assert.equal(r.h.zatca.calls.length, 0);
  } finally {
    await r.close();
  }
});

test('مدير الشركة وحده (قرار المالك): المشرف والمحاسب 403 COMPANY_ADMIN_ONLY على كل مسار ولو بصلاحية الإعدادات — قبل قراءة الصلاحية وبلا أي كتابة أو طلب للهيئة، والمدير يمرّ، وانتحال المالك للاطلاع فقط', async () => {
  let permissionReads = 0;
  const r = await rig({
    deps: {
      loadAdmin: async req => {
        permissionReads++;
        const u = req.user as User;
        return { isActive: true, role: u.role, tenantId: u.tenantId ?? null, canManageCompanySettings: u.canManageCompanySettings ?? true };
      },
    },
  });
  try {
    const unit = await createSimUnit(r);
    const writes = r.h.store.received.length;
    const readsBefore = permissionReads;
    const calls = r.h.zatca.calls.length;
    const otpsBefore = r.h.otps.length;
    for (const role of ['MANAGER', 'ACCOUNTANT']) {
      for (const extra of [{}, { canManageCompanySettings: true }, { impersonated: true }] as Array<Partial<User>>) {
        const user: User = { ...ADMIN, id: `${role.toLowerCase()}-1`, role, ...extra };
        const otp = newOtp();
        const attempts: Array<[string, string, unknown]> = [
          ['GET', '/overview', undefined], ['GET', `/units/${unit.id}`, undefined], ['PUT', '/seller', { legalName: 'x' }],
          ['POST', '/units', { environment: 'simulation' }], ['POST', `/units/${unit.id}/onboard`, { otp }], ['POST', `/units/${unit.id}/onboard`, {}],
          ['POST', `/units/${unit.id}/renew`, { otp }], ['POST', `/units/${unit.id}/abort-renewal`, {}],
          ['POST', `/units/${unit.id}/retire`, { confirmation: RETIRE_CONFIRMATION_TEXT, reason: 'abandoned' }], ['POST', '/go-live', {}],
        ];
        for (const [m, u, b] of attempts) {
          const res = await call(r, m, u, { user, body: b });
          assert.equal(res.status, 403, `${role} ${m} ${u}: ${res.text}`);
          assert.equal(res.body.code, 'COMPANY_ADMIN_ONLY', `${role} ${m} ${u}`);
          assert.equal(res.body.message, 'ربط الفوترة الإلكترونية متاح لمدير الشركة فقط');
          assert.equal(res.body.message, ZATCA_ROUTE_CODES.COMPANY_ADMIN_ONLY);
          assert.equal(res.body.data, undefined, 'لا بيانات مع الرفض');
          assert.ok(!res.text.includes(otp), 'صدى الرمز في ردّ الرفض');
        }
      }
    }
    assert.equal(permissionReads, readsBefore, 'دور التوكن يُرفض قبل قراءة الحساب من القاعدة');
    assert.equal(r.h.store.received.length, writes, 'طلب مرفوض لمشرف أو محاسب لمس المخزن');
    assert.equal(r.h.zatca.calls.length, calls, 'طلب مرفوض لمشرف أو محاسب وصل «فاتورة»');
    assert.equal(r.h.otps.length, otpsBefore);
    assert.equal(r.h.store.settings.get(TENANT)?.legalName, sellerSettings().legalName);

    // مدير الشركة يمرّ (بالصلاحية وبلا تقييد نطاق)
    const overview = await call(r, 'GET', '/overview');
    assert.equal(overview.status, 200, overview.text);
    assert.deepEqual(overview.body.data.units.map((p: { unit: { id: string } }) => p.unit.id), [unit.id]);
    assert.equal((await call(r, 'GET', `/units/${unit.id}`)).status, 200);
    assert.ok(permissionReads > readsBefore, 'مسار المدير يقرأ حسابه (الدور والصلاحية) من القاعدة');

    // انتحال المالك (توكن ADMIN مع impersonated): القراءة كاملة والكتابة 403 IMPERSONATION_READ_ONLY — لا يُلتفّ عليه بالدور
    const imp: User = { ...ADMIN, impersonated: true };
    assert.equal((await call(r, 'GET', '/overview', { user: imp })).status, 200);
    assert.equal((await call(r, 'GET', `/units/${unit.id}`, { user: imp })).status, 200);
    for (const [m, u, b] of [
      ['PUT', '/seller', { legalName: 'x' }], ['POST', '/units', { environment: 'simulation' }], ['POST', `/units/${unit.id}/onboard`, { otp: newOtp() }],
      ['POST', `/units/${unit.id}/retire`, { confirmation: RETIRE_CONFIRMATION_TEXT, reason: 'abandoned' }],
    ] as Array<[string, string, unknown]>) {
      const w = await call(r, m, u, { user: imp, body: b });
      assert.equal(w.status, 403, `${m} ${u}: ${w.text}`);
      assert.equal(w.body.code, 'IMPERSONATION_READ_ONLY');
    }
    assert.equal(r.h.store.received.length, writes);
    assert.equal(r.h.zatca.calls.length, calls);
    assertNothingLeaked(r);
  } finally {
    await r.close();
  }
});

test('الدور من القاعدة لا من التوكن: مدير خُفِّض إلى مشرف أو محاسب (توكنه ما زال ADMIN) 403 COMPANY_ADMIN_ONLY على كل مسار — ولا إيقاف ولا ربط برمز؛ والمعطَّل والمحذوف ومنزوع الصلاحية وحساب شركة أخرى 403', async () => {
  const r = await rig();
  try {
    const unit = await activeSimUnit(r);
    const writes = r.h.store.received.length;
    const calls = r.h.zatca.calls.length;
    const otpsBefore = r.h.otps.length;
    const everyRoute = (otp: string): Array<[string, string, unknown]> => [
      ['GET', '/overview', undefined], ['GET', `/units/${unit.id}`, undefined], ['PUT', '/seller', { legalName: 'x' }],
      ['POST', '/units', { environment: 'simulation' }], ['POST', `/units/${unit.id}/onboard`, { otp }], ['POST', `/units/${unit.id}/renew`, { otp }],
      ['POST', `/units/${unit.id}/abort-renewal`, {}], ['POST', `/units/${unit.id}/retire`, { confirmation: RETIRE_CONFIRMATION_TEXT, reason: 'abandoned' }],
      ['POST', '/go-live', {}],
    ];
    const cases: Array<[string, AdminAccessRecord | null, string]> = [
      ['خُفِّض إلى مشرف', { isActive: true, role: 'MANAGER', tenantId: TENANT, canManageCompanySettings: true }, 'COMPANY_ADMIN_ONLY'],
      ['خُفِّض إلى محاسب', { isActive: true, role: 'ACCOUNTANT', tenantId: TENANT, canManageCompanySettings: true }, 'COMPANY_ADMIN_ONLY'],
      ['نُزعت صلاحية الإعدادات', { isActive: true, role: 'ADMIN', tenantId: TENANT, canManageCompanySettings: false }, 'PERMISSION_DENIED'],
      ['عُطِّل', { isActive: false, role: 'ADMIN', tenantId: TENANT, canManageCompanySettings: true }, 'PERMISSION_DENIED'],
      ['حُذف', null, 'PERMISSION_DENIED'],
      ['صفّه لشركة أخرى', { isActive: true, role: 'ADMIN', tenantId: OTHER, canManageCompanySettings: true }, 'FORBIDDEN'],
    ];
    for (const [label, row, code] of cases) {
      r.admins.set(ADMIN.id, row);
      const otp = newOtp();
      for (const [m, u, b] of everyRoute(otp)) {
        // التوكن نفسه (ADMIN بلا انتحال) كما وُقِّع عند الدخول
        const res = await call(r, m, u, { body: b });
        assert.equal(res.status, 403, `${label} ${m} ${u}: ${res.text}`);
        assert.equal(res.body.code, code, `${label} ${m} ${u}`);
        assert.equal(res.body.message, ZATCA_ROUTE_CODES[code as keyof typeof ZATCA_ROUTE_CODES]);
        assert.equal(res.body.data, undefined);
        assert.ok(!res.text.includes(otp), 'صدى الرمز في ردّ الرفض');
      }
    }
    assert.equal(r.h.store.received.length, writes, 'مدير مخفَّض كتب في المخزن (إيقاف أو ربط أو إلغاء تجديد)');
    assert.equal(r.h.zatca.calls.length, calls, 'مدير مخفَّض وصل «فاتورة»');
    assert.equal(r.h.otps.length, otpsBefore);
    assert.equal(r.h.store.units.get(unit.id)?.status, 'ACTIVE', 'الوحدة أُوقفت بتوكن مدير مخفَّض');
    assert.equal(r.h.store.settings.get(TENANT)?.legalName, sellerSettings().legalName);

    // ضبط: الصفّ نفسه مديراً من جديد ⇒ يمرّ
    r.admins.set(ADMIN.id, { isActive: true, role: 'ADMIN', tenantId: TENANT, canManageCompanySettings: true });
    assert.equal((await call(r, 'GET', '/overview')).status, 200);
    // والعكس: صفّ مدير لا يفتح لتوكن مشرف (المسار السريع قبل القراءة)
    assert.equal((await call(r, 'GET', '/overview', { user: { ...ADMIN, role: 'MANAGER' } })).body.code, 'COMPANY_ADMIN_ONLY');
    assertNothingLeaked(r);
  } finally {
    await r.close();
  }
});

test('علم المالك مطفأ ⇒ 403 على كل مسار (قراءة وكتابة وتفعيل) بلا أي كتابة', async () => {
  const r = await rig();
  try {
    r.flags.set(TENANT, false);
    const unit = { id: '00000000-0000-4000-8000-000000000000' };
    const attempts: Array<[string, string, unknown]> = [
      ['GET', '/overview', undefined], ['GET', `/units/${unit.id}`, undefined], ['PUT', '/seller', { legalName: 'x' }],
      ['POST', '/units', { environment: 'simulation' }], ['POST', `/units/${unit.id}/onboard`, { otp: newOtp() }],
      ['POST', `/units/${unit.id}/renew`, { otp: newOtp() }], ['POST', `/units/${unit.id}/abort-renewal`, {}],
      ['POST', `/units/${unit.id}/retire`, { confirmation: RETIRE_CONFIRMATION_TEXT, reason: 'abandoned' }], ['POST', '/go-live', {}],
    ];
    for (const [m, u, b] of attempts) {
      const res = await call(r, m, u, { body: b });
      assert.equal(res.status, 403, `${m} ${u}: ${res.text}`);
      assert.equal(res.body.code, 'ZATCA_PHASE2_NOT_ALLOWED');
      assert.equal(res.body.message, ZATCA_ROUTE_CODES.ZATCA_PHASE2_NOT_ALLOWED);
    }
    assert.equal(r.h.store.received.length, 0);
    assert.equal(r.h.store.settings.get(TENANT)?.legalName, sellerSettings().legalName);
    assertNothingLeaked(r);
  } finally {
    await r.close();
  }
});

test('شركة غير سعودية ⇒ 403 ZATCA_COUNTRY_NOT_SUPPORTED حتى مع العلم', async () => {
  const r = await rig();
  try {
    r.h.store.settings.get(TENANT)!.countryCode = 'AE';
    for (const [m, u, b] of [['GET', '/overview', undefined], ['POST', '/units', { environment: 'simulation' }], ['POST', '/go-live', {}]] as const) {
      const res = await call(r, m, u, { body: b });
      assert.equal(res.status, 403, res.text);
      assert.equal(res.body.code, 'ZATCA_COUNTRY_NOT_SUPPORTED');
      assert.match(res.body.message, ARABIC);
    }
    r.h.store.settings.delete(TENANT);
    assert.equal((await call(r, 'GET', '/overview')).body.code, 'ZATCA_COUNTRY_NOT_SUPPORTED');
    assert.equal(r.h.store.received.length, 0);
  } finally {
    await r.close();
  }
});

test('جلسة انتحال المالك: القراءة مسموحة والكتابة 403 (design §5.3 — لا ربط نيابةً عن الشركة)', async () => {
  const r = await rig();
  try {
    const imp: User = { ...ADMIN, impersonated: true };
    assert.equal((await call(r, 'GET', '/overview', { user: imp })).status, 200);
    const w = await call(r, 'POST', '/units', { user: imp, body: { environment: 'simulation' } });
    assert.equal(w.status, 403);
    assert.equal(w.body.code, 'IMPERSONATION_READ_ONLY');
    assert.equal((await call(r, 'PUT', '/seller', { user: imp, body: { legalName: 'x' } })).status, 403);
    assert.equal(r.h.store.received.length, 0);
  } finally {
    await r.close();
  }
});

test('IDOR: وحدة شركة أخرى ⇒ 404 على القراءة والربط والتجديد والإلغاء والإيقاف، ولا تظهر في النظرة العامّة، ولا يُستهلك OTP', async () => {
  const r = await rig();
  try {
    const foreign = await createSimUnit(r, ADMIN2);
    const receivedBefore = r.h.store.received.length;
    const otp = r.h.otps[0];
    const tries: Array<[string, string, unknown]> = [
      ['GET', `/units/${foreign.id}`, undefined], ['POST', `/units/${foreign.id}/onboard`, { otp }], ['POST', `/units/${foreign.id}/renew`, { otp }],
      ['POST', `/units/${foreign.id}/abort-renewal`, {}], ['POST', `/units/${foreign.id}/retire`, { confirmation: RETIRE_CONFIRMATION_TEXT, reason: 'abandoned' }],
      ['GET', '/units/..%2F..%2Fetc', undefined],
    ];
    for (const [m, u, b] of tries) {
      const res = await call(r, m, u, { body: b });
      assert.equal(res.status, 404, `${m} ${u}: ${res.text}`);
      assert.equal(res.body.code, 'UNIT_NOT_FOUND');
      assert.ok(!res.text.includes(foreign.id), 'الردّ كشف معرّف وحدة الشركة الأخرى');
    }
    const ov = await call(r, 'GET', '/overview');
    assert.equal(ov.body.data.units.length, 0);
    assert.equal(r.h.zatca.calls.length, 0, 'طلب على وحدة شركة أخرى وصل «الهيئة»');
    assert.equal(r.h.store.received.length, receivedBefore, 'طلب على وحدة شركة أخرى كتب في المخزن');
    assert.equal(r.h.store.units.get(foreign.id)?.status, 'CSR_READY');
    // صاحبها يراها
    assert.equal((await call(r, 'GET', `/units/${foreign.id}`, { user: ADMIN2 })).status, 200);
  } finally {
    await r.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// البيئات ومفتاح التشفير
// ─────────────────────────────────────────────────────────────────────────────

test('البيئات: production غير مسموحة افتراضياً، sandbox مرفوضة على خادم الإنتاج ولو أُدرجت، وبيئة مجهولة 400', async () => {
  const r = await rig({ allowed: 'sandbox,simulation' });
  try {
    const ov = await call(r, 'GET', '/overview');
    assert.deepEqual(ov.body.data.allowedEnvs, ['simulation']);
    assert.deepEqual(ov.body.data.envConfigIssues, ['SANDBOX_IN_PRODUCTION']);
    const prod = await call(r, 'POST', '/units', { body: { environment: 'production' } });
    assert.equal(prod.status, 403);
    assert.equal(prod.body.code, 'ENV_NOT_ALLOWED');
    assert.match(prod.body.message, ARABIC);
    const sandbox = await call(r, 'POST', '/units', { body: { environment: 'sandbox' } });
    assert.equal(sandbox.status, 403);
    assert.equal(sandbox.body.code, 'ENV_NOT_ALLOWED');
    const bad = await call(r, 'POST', '/units', { body: { environment: 'staging' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_INPUT');
    assert.equal(r.h.store.units.size, 0);
  } finally {
    await r.close();
  }
});

test('البيئات: وحدة قائمة في بيئة لم تعد مسموحة ⇒ الربط والتجديد 403 ENV_NOT_ALLOWED قبل أي طلب للهيئة', async () => {
  const r = await rig({ env: 'production', allowed: 'simulation' });
  try {
    const unit = (await create(r.h)) as { ok: true; unit: EgsUnitView };
    assert.equal(unit.ok, true);
    const onboard = await call(r, 'POST', `/units/${unit.unit.id}/onboard`, { body: { otp: r.h.otps[0] } });
    assert.equal(onboard.status, 403, onboard.text);
    assert.equal(onboard.body.code, 'ENV_NOT_ALLOWED');
    const renew = await call(r, 'POST', `/units/${unit.unit.id}/renew`, { body: { otp: r.h.renewalOtps[0] } });
    assert.equal(renew.status, 403);
    assert.equal(renew.body.code, 'ENV_NOT_ALLOWED');
    assert.equal(r.h.zatca.calls.length, 0);
    // الإيقاف لا يكلّم الهيئة: يبقى متاحاً لتنظيف وحدة بيئة أُغلقت
    const retire = await call(r, 'POST', `/units/${unit.unit.id}/retire`, { body: { confirmation: RETIRE_CONFIRMATION_TEXT, reason: 'abandoned' } });
    assert.equal(retire.status, 200, retire.text);
    assert.equal(retire.body.data.unit.status, 'REVOKED');
  } finally {
    await r.close();
  }
});

test('ZATCA_SECRETS_KEY مفقود أو تالف ⇒ 503 SECRETS_UNAVAILABLE برسالة عربية، بلا وحدة ولا طلب للهيئة ولا مفتاح بديل', async () => {
  for (const env of [{}, { ZATCA_SECRETS_KEY: 'short' }, { ZATCA_SECRETS_KEY: '00'.repeat(32) }]) {
    const r = await rig({ deps: { loadKeyring: () => keyringFromEnv(env) } });
    try {
      const ov = await call(r, 'GET', '/overview');
      assert.equal(ov.status, 200);
      assert.equal(ov.body.data.secretsReady, false);
      const create1 = await call(r, 'POST', '/units', { body: { environment: 'simulation' } });
      assert.equal(create1.status, 503, create1.text);
      assert.equal(create1.body.code, 'SECRETS_UNAVAILABLE');
      assert.equal(create1.body.message, ONBOARDING_CODES.SECRETS_UNAVAILABLE.messageAr);
      assert.ok(!create1.text.includes('ZATCA_SECRETS'), 'الردّ كشف تفاصيل إعداد الخادم');
      assert.equal(r.h.store.units.size, 0);
      assert.ok(r.logs.some(l => l.startsWith('zatca.secrets.unavailable')));
      // وحدة قائمة (أُنشئت بمفتاح سابقاً) ثم غاب المفتاح: الربط 503 ولا يصل OTP للهيئة
      const existing = (await create(r.h)) as { ok: true; unit: EgsUnitView };
      assert.equal(existing.ok, true);
      const onboard = await call(r, 'POST', `/units/${existing.unit.id}/onboard`, { body: { otp: r.h.otps[0] } });
      assert.equal(onboard.status, 503, onboard.text);
      assert.equal(onboard.body.code, 'SECRETS_UNAVAILABLE');
      assert.equal(r.h.zatca.calls.length, 0);
    } finally {
      await r.close();
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// الربط: مهمّة خلفية 202 واستطلاع
// ─────────────────────────────────────────────────────────────────────────────

test('الربط كاملاً: إنشاء 201 ⇒ onboard 202 بعرض الوحدة ⇒ الاستطلاع حتى ACTIVE بقائمة تقدّم 6/6 ونتيجة مهمّة ناجحة — بلا OTP في أي مكان', async () => {
  const r = await rig();
  try {
    const u = await createSimUnit(r);
    const otp = r.h.otps.shift() as string;
    const start = await call(r, 'POST', `/units/${u.id}/onboard`, { body: { otp } });
    assert.equal(start.status, 202, start.text);
    assert.equal(start.body.data.unit.id, u.id);
    assert.equal(start.body.data.job.state, 'running');
    assert.equal(start.body.data.activity.busy, true);
    assert.equal(start.body.data.job.kind, 'onboard');

    const done = await poll(r, u.id);
    assert.equal(done.status, 200);
    const d = done.body.data;
    assert.equal(d.unit.status, 'ACTIVE');
    assert.equal(d.job.state, 'finished');
    assert.equal(d.job.outcome.ok, true);
    assert.match(d.job.outcome.messageAr, ARABIC);
    assert.equal(d.activity.busy, false);
    assert.equal(d.checklist.checksPassed, 6);
    assert.equal(d.checklist.checksTotal, 6);
    assert.ok(d.checklist.items.every((i: { status: string }) => i.status === 'done' || i.status === 'warning'), JSON.stringify(d.checklist));
    assert.ok(d.unit.certNotAfter, 'تاريخ صلاحية الشهادة');

    const ov = await call(r, 'GET', '/overview');
    assert.equal(ov.body.data.units.length, 1);
    assert.equal(ov.body.data.goLiveAvailable, false);
    assert.equal(ov.body.data.regime, 'PHASE1');
    assert.equal(ov.body.data.units[0].unit.status, 'ACTIVE');

    const all = assertNothingLeaked(r);
    assert.doesNotMatch(all, otpPattern(otp));
    assert.ok(r.h.zatca.calls.some(c => c.headers.otp === otp), 'الرمز وصل «الهيئة» في الترويسة وحدها');
  } finally {
    await r.close();
  }
});

test('رمز مرفوض من الهيئة ⇒ نتيجة المهمّة NEW_OTP_REQUIRED (needsNewOtp) برسالة عربية ورسائل الهيئة منقّحة، والوحدة تبقى CSR_READY', async () => {
  const r = await rig();
  try {
    const u = await createSimUnit(r);
    const wrong = newOtp();
    r.h.leakOtps.add(wrong);
    const start = await call(r, 'POST', `/units/${u.id}/onboard`, { body: { otp: wrong } });
    assert.equal(start.status, 202);
    const done = await poll(r, u.id);
    const out = done.body.data.job.outcome;
    assert.equal(out.ok, false);
    assert.equal(out.code, 'NEW_OTP_REQUIRED');
    assert.equal(out.needsNewOtp, true);
    assert.equal(out.retryable, false);
    assert.match(out.messageAr, ARABIC);
    assert.ok(Array.isArray(out.zatcaMessages));
    assert.equal(done.body.data.unit.status, 'CSR_READY');
    assert.equal(done.body.data.checklist.items.find((i: { key: string }) => i.key === 'ccsid').status, 'pending');
    assertNothingLeaked(r);
  } finally {
    await r.close();
  }
});

test('OTP: صيغة خاطئة 400 بلا صدى للقيمة، غيابه في CSR_READY ⇒ OTP_REQUIRED، والأرقام العربية تُقبل', async () => {
  const r = await rig();
  try {
    const u = await createSimUnit(r);
    const junk = '98765x';
    const bad = await call(r, 'POST', `/units/${u.id}/onboard`, { body: { otp: junk } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'OTP_INVALID_FORMAT');
    assert.ok(!bad.text.includes(junk) && !bad.text.includes('98765'), 'الردّ أعاد الرمز');
    const numeric = await call(r, 'POST', `/units/${u.id}/onboard`, { body: { otp: 123456 } });
    assert.equal(numeric.body.code, 'OTP_INVALID_FORMAT');
    const missing = await call(r, 'POST', `/units/${u.id}/onboard`, { body: {} });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'OTP_REQUIRED');
    assert.equal(r.h.zatca.calls.length, 0);

    const otp = r.h.otps.shift() as string;
    const arabic = otp.replace(/[0-9]/g, d => String.fromCharCode(0x0660 + Number(d)));
    const start = await call(r, 'POST', `/units/${u.id}/onboard`, { body: { otp: arabic } });
    assert.equal(start.status, 202, start.text);
    assert.equal((await poll(r, u.id)).body.data.unit.status, 'ACTIVE');
    assert.ok(!r.texts.join('\n').includes(arabic));
    assertNothingLeaked(r);
  } finally {
    await r.close();
  }
});

test('JSON تالف يحمل OTP ⇒ 400 INVALID_JSON ولا يصل الرمز لأي سجلّ أو ردّ (لا معالج الأخطاء العامّ ولا morgan)', async () => {
  const r = await rig();
  try {
    const u = await createSimUnit(r);
    const otp = newOtp();
    r.h.leakOtps.add(otp);
    const before = consoleLines.length;
    // رسالة body-parser لأجسام كهذه تحمل الجسم نفسه ("Unexpected token 'x', "x{"otp":"…"}" is not valid JSON")،
    // ومعالج الأخطاء العامّ يطبع err.message — الحارس يمنع وصولها إليه
    for (const raw of [`x{"otp":"${otp}"}`, `{"otp":"${otp}","a":x}`, `{"otp":"${otp}",`]) {
      const res = await call(r, 'POST', `/units/${u.id}/onboard`, { raw });
      assert.equal(res.status, 400, res.text);
      assert.equal(res.body.code, 'INVALID_JSON');
      assert.match(res.body.message, ARABIC);
    }
    assert.equal(r.h.zatca.calls.length, 0);
    const printed = consoleLines.slice(before).join('\n');
    assert.doesNotMatch(printed, otpPattern(otp), 'رسالة خطأ التحليل (بمقطع من الجسم) طُبعت');
    assertNothingLeaked(r);
  } finally {
    await r.close();
  }
});

test('القفل: مهمّة جارية ⇒ ربط ثانٍ وإيقاف وإلغاء تجديد 409 JOB_RUNNING، والاستطلاع يعرض busy حتى تنتهي', async () => {
  const r = await rig();
  let release!: () => void;
  const gate = new Promise<void>(res => { release = res; });
  try {
    const u = await createSimUnit(r);
    r.h.fetchWrap = inner => async (url, init) => { await gate; return inner(url, init); };
    const otp = r.h.otps.shift() as string;
    const first = await call(r, 'POST', `/units/${u.id}/onboard`, { body: { otp } });
    assert.equal(first.status, 202);
    const second = await call(r, 'POST', `/units/${u.id}/onboard`, { body: { otp: r.h.otps[0] } });
    assert.equal(second.status, 409, second.text);
    assert.equal(second.body.code, 'JOB_RUNNING');
    assert.match(second.body.message, ARABIC);
    const retire = await call(r, 'POST', `/units/${u.id}/retire`, { body: { confirmation: RETIRE_CONFIRMATION_TEXT, reason: 'abandoned' } });
    assert.equal(retire.status, 409);
    assert.equal(retire.body.code, 'JOB_RUNNING');
    const abort = await call(r, 'POST', `/units/${u.id}/abort-renewal`, { body: {} });
    assert.equal(abort.status, 409);
    const mid = await call(r, 'GET', `/units/${u.id}`);
    assert.equal(mid.body.data.activity.busy, true);
    assert.equal(mid.body.data.job.state, 'running');
    release();
    const done = await poll(r, u.id);
    assert.equal(done.body.data.unit.status, 'ACTIVE');
    assert.equal(done.body.data.activity.busy, false);
    assert.equal(r.h.zatca.calls.filter(c => c.endpoint === 'compliance').length, 1, 'OTP أُرسل مرتين');
    assertNothingLeaked(r);
  } finally {
    release?.();
    r.h.fetchWrap = null;
    await r.close();
  }
});

test('عقد إيجار عامل آخر (CHECKS_RUNNING حديث) ⇒ الربط 409 IN_PROGRESS بلا مهمّة، والاستطلاع busy حتى تنقضي المهلة', async () => {
  const r = await rig({ deps: { leaseMs: 60_000 } });
  try {
    const u = await createSimUnit(r);
    const row = r.h.store.units.get(u.id)!;
    row.status = 'CHECKS_RUNNING';
    row.updatedAt = r.h.clock.now();
    const res = await call(r, 'POST', `/units/${u.id}/onboard`, { body: {} });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.body.code, 'IN_PROGRESS');
    assert.match(res.body.message, ARABIC);
    const busy = await call(r, 'GET', `/units/${u.id}`);
    assert.equal(busy.body.data.job, null, 'لم تُنشأ مهمّة');
    assert.deepEqual(busy.body.data.activity, { busy: true, reason: 'checks' });
    r.h.clock.advance(60_001);
    const stale = await call(r, 'GET', `/units/${u.id}`);
    assert.deepEqual(stale.body.data.activity, { busy: false, reason: null }, 'عامل مات: الواجهة لا تستطلع إلى الأبد');
    assert.equal(r.h.zatca.calls.length, 0);
  } finally {
    await r.close();
  }
});

test('حدّ المعدّل: طلبات OTP لكل شركة (والصيغة الخاطئة تُحتسب) ⇒ 429 OTP_RATE_LIMITED برسالة عربية، وشركة أخرى غير متأثّرة', async () => {
  const r = await rig({ otpRateLimit: { windowMs: 60_000, limit: 2 } });
  try {
    const u = await createSimUnit(r);
    for (let i = 0; i < 2; i++) assert.equal((await call(r, 'POST', `/units/${u.id}/onboard`, { body: { otp: 'bad' } })).status, 400);
    const limited = await call(r, 'POST', `/units/${u.id}/renew`, { body: { otp: r.h.otps[0] } });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, 'OTP_RATE_LIMITED');
    assert.match(limited.body.message, ARABIC);
    const other = await call(r, 'POST', '/units/whatever/onboard', { user: ADMIN2, body: { otp: 'bad' } });
    assert.equal(other.status, 400, 'حدّ شركة استُهلك من شركة أخرى');
    assert.equal(r.h.zatca.calls.length, 0);
  } finally {
    await r.close();
  }
});

test('حدّ المعدّل: «متابعة الربط» بلا رمز لا تُحتسب في حدّ OTP ولا يحجبها استنفاده، ولها حدّها ورسالتها RESUME_RATE_LIMITED', async () => {
  const r = await rig({ otpRateLimit: { windowMs: 60_000, limit: 2 }, resumeRateLimit: { windowMs: 60_000, limit: 3 } });
  try {
    const u = await createSimUnit(r);
    for (let i = 0; i < 2; i++) assert.equal((await call(r, 'POST', `/units/${u.id}/onboard`, { body: { otp: 'bad' } })).status, 400);
    const otpLimited = await call(r, 'POST', `/units/${u.id}/onboard`, { body: { otp: r.h.otps[0] } });
    assert.equal(otpLimited.status, 429);
    assert.equal(otpLimited.body.code, 'OTP_RATE_LIMITED');
    // حدّ الرمز مستنفد: المتابعة بلا رمز تصل المعالج (CSR_READY ⇒ 400 OTP_REQUIRED) لا 429 «محاولات كثيرة لإدخال رمز التحقق»
    for (let i = 0; i < 3; i++) {
      const resume = await call(r, 'POST', `/units/${u.id}/onboard`, { body: {} });
      assert.equal(resume.status, 400, resume.text);
      assert.equal(resume.body.code, 'OTP_REQUIRED');
    }
    const resumeLimited = await call(r, 'POST', `/units/${u.id}/onboard`, { body: {} });
    assert.equal(resumeLimited.status, 429);
    assert.equal(resumeLimited.body.code, 'RESUME_RATE_LIMITED');
    assert.match(resumeLimited.body.message, ARABIC);
    assert.notEqual(resumeLimited.body.message, ZATCA_ROUTE_CODES.OTP_RATE_LIMITED, 'رسالة حدّ الرمز لطلب بلا رمز');
    // حقل otp فارغ = بلا رمز ⇒ حدّ المتابعة لا حدّ الرمز
    assert.equal((await call(r, 'POST', `/units/${u.id}/onboard`, { body: { otp: '' } })).body.code, 'RESUME_RATE_LIMITED');
    assert.equal(r.h.zatca.calls.length, 0);
  } finally {
    await r.close();
  }
});

test('التفعيل: POST /go-live ⇒ 409 «غير متاح قبل اكتمال ربط إصدار الفواتير» حتى مع وحدة مفعّلة، ولا يُضبط zatcaPhase2StartedAt', async () => {
  const r = await rig();
  try {
    await activeSimUnit(r);
    const res = await call(r, 'POST', '/go-live', { body: { repsSynced: true, typedConfirmation: 'تفعيل' } });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'GO_LIVE_UNAVAILABLE');
    assert.equal(res.body.message, 'غير متاح قبل اكتمال ربط إصدار الفواتير');
    assert.equal(r.h.store.settings.get(TENANT)?.zatcaPhase2StartedAt, null);
    const ov = await call(r, 'GET', '/overview');
    assert.equal(ov.body.data.goLiveAvailable, false);
    assert.equal(ov.body.data.goLiveUnavailableMessage, 'غير متاح قبل اكتمال ربط إصدار الفواتير');
    assertNothingLeaked(r);
  } finally {
    await r.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// التجديد والإلغاء والإيقاف
// ─────────────────────────────────────────────────────────────────────────────

test('التجديد: بلا OTP 400، ثم 202 والاستطلاع حتى ACTIVE بمفتاح جديد؛ إلغاء تجديد لوحدة غير RENEWING ⇒ 409 INVALID_STATE', async () => {
  const r = await rig();
  try {
    const u = await activeSimUnit(r);
    const noOtp = await call(r, 'POST', `/units/${u.id}/renew`, { body: {} });
    assert.equal(noOtp.status, 400);
    assert.equal(noOtp.body.code, 'OTP_REQUIRED');
    const abort = await call(r, 'POST', `/units/${u.id}/abort-renewal`, { body: {} });
    assert.equal(abort.status, 409);
    assert.equal(abort.body.code, 'INVALID_STATE');
    const start = await call(r, 'POST', `/units/${u.id}/renew`, { body: { otp: r.h.renewalOtps.shift() } });
    assert.equal(start.status, 202, start.text);
    assert.equal(start.body.data.job.kind, 'renew');
    const done = await poll(r, u.id);
    assert.equal(done.body.data.unit.status, 'ACTIVE');
    assert.equal(done.body.data.unit.keyVersion, 2);
    assert.equal(done.body.data.job.outcome.ok, true);
    // الربط لوحدة مفعّلة غير مسموح (409) لا «نجاح صامت»
    const onboardActive = await call(r, 'POST', `/units/${u.id}/onboard`, { body: { otp: r.h.otps[0] } });
    assert.equal(onboardActive.status, 409);
    assert.equal(onboardActive.body.code, 'INVALID_STATE');
    assertNothingLeaked(r);
  } finally {
    await r.close();
  }
});

test('الإيقاف: بلا «إيقاف» أو بسبب مجهول 400، وبالتأكيد ⇒ REVOKED ثم يُتاح إنشاء وحدة جديدة', async () => {
  const r = await rig();
  try {
    const u = await activeSimUnit(r);
    const noConfirm = await call(r, 'POST', `/units/${u.id}/retire`, { body: { reason: 'abandoned', confirmation: 'نعم' } });
    assert.equal(noConfirm.status, 400);
    assert.equal(noConfirm.body.code, 'RETIRE_CONFIRMATION_REQUIRED');
    assert.match(noConfirm.body.message, ARABIC);
    const badReason = await call(r, 'POST', `/units/${u.id}/retire`, { body: { reason: 'whatever', confirmation: RETIRE_CONFIRMATION_TEXT } });
    assert.equal(badReason.status, 400);
    const blocked = await call(r, 'POST', '/units', { body: { environment: 'simulation' } });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'UNIT_EXISTS');
    const ok = await call(r, 'POST', `/units/${u.id}/retire`, { body: { reason: 'revoked-in-portal', confirmation: ` ${RETIRE_CONFIRMATION_TEXT} ` } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.data.unit.status, 'REVOKED');
    assert.equal(ok.body.data.alreadyRetired, false);
    await createSimUnit(r);
    assertNothingLeaked(r);
  } finally {
    await r.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// بيانات البائع
// ─────────────────────────────────────────────────────────────────────────────

test('PUT /seller: الصيغ تُفحص حين تُدخل قيمة فقط (VAT 15 يبدأ وينتهي بـ3، مبنى 4، بريد 5، TIN المجموعة 10)، والفراغ يُفرغ، والأرقام العربية تُطبَّع', async () => {
  const r = await rig();
  try {
    const bad = await call(r, 'PUT', '/seller', { body: { taxNumber: '123456789012345', addrBuildingNo: '12', addrPostalCode: '1234', vatGroupTin: '123', sellerIdScheme: 'XYZ' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'SELLER_INVALID');
    const fields = bad.body.fieldErrors.map((e: { field: string }) => e.field).sort();
    assert.deepEqual(fields, ['addrBuildingNo', 'addrPostalCode', 'sellerIdScheme', 'taxNumber', 'vatGroupTin']);
    for (const e of bad.body.fieldErrors) assert.match(e.messageAr, ARABIC);
    assert.equal(r.h.store.settings.get(TENANT)?.addrBuildingNo, sellerSettings().addrBuildingNo, 'طلب مرفوض كتب جزئياً');

    const ok = await call(r, 'PUT', '/seller', { body: { addrBuildingNo: '٧٧٨٨', addrAdditionalNo: '', legalName: '  شركة الاختبار  ' } });
    assert.equal(ok.status, 200, ok.text);
    const s = r.h.store.settings.get(TENANT)!;
    assert.equal(s.addrBuildingNo, '7788');
    assert.equal(s.addrAdditionalNo, null);
    assert.equal(s.legalName, 'شركة الاختبار');
    assert.deepEqual(ok.body.data.warnings, []);
    assert.equal(ok.body.data.seller.addrBuildingNo, '7788');

    // مجموعة ضريبية بلا TIN: تحذير لا منع، ومسألة جاهزية
    const group = await call(r, 'PUT', '/seller', { body: { taxNumber: '399999999910003' } });
    assert.equal(group.status, 200);
    assert.ok(group.body.data.warnings.some((w: { code: string }) => w.code === 'VAT_GROUP_TIN_MISSING'));
    assert.ok(group.body.data.sellerIssues.some((i: { settingsField: string }) => i.settingsField === 'vatGroupTin'));
    // مسح الاسم القانوني: مسموح، ويظهر في الجاهزية
    const cleared = await call(r, 'PUT', '/seller', { body: { legalName: null, vatGroupTin: '1234567890' } });
    assert.equal(cleared.status, 200);
    assert.ok(cleared.body.data.sellerIssues.some((i: { settingsField: string; severity: string }) => i.settingsField === 'legalName' && i.severity === 'error'));
  } finally {
    await r.close();
  }
});

test('PUT /seller بعد تفعيل وحدة: تعديل العنوان يحذّر CSR_MAY_BE_STALE وتغيير الرقم الضريبي يحذّر SELLER_VAT_CHANGED — دون منع الحفظ', async () => {
  const r = await rig();
  try {
    const u = await activeSimUnit(r);
    const addr = await call(r, 'PUT', '/seller', { body: { addrStreet: 'شارع جديد' } });
    assert.equal(addr.status, 200);
    assert.deepEqual(addr.body.data.warnings.map((w: { code: string; unitId: string }) => [w.code, w.unitId]), [['CSR_MAY_BE_STALE', u.id]]);
    const same = await call(r, 'PUT', '/seller', { body: { addrStreet: 'شارع جديد' } });
    assert.deepEqual(same.body.data.warnings, [], 'لا تغيير فعلي ⇒ لا تحذير');
    const vat = await call(r, 'PUT', '/seller', { body: { taxNumber: '311111111111113' } });
    assert.equal(vat.status, 200);
    assert.equal(vat.body.data.warnings[0].code, 'SELLER_VAT_CHANGED');
    assert.equal(r.h.store.settings.get(TENANT)?.taxNumber, '311111111111113');
  } finally {
    await r.close();
  }
});

test('جاهزية طلب الشهادة: اسم قانوني أطول من 64 محرفاً أو فيه «&» ⇒ خطأ جاهزية على legalName (لا «مكتملة للربط»)، مطابقاً لرفض الإنشاء 422 CSR_PARAMS_INVALID', async () => {
  const r = await rig();
  try {
    const longArabic = 'شركة المؤسسة الوطنية الحديثة للتجارة والتوزيع والمقاولات والخدمات اللوجستية المحدودة';
    assert.ok(Array.from(longArabic).length > 64);
    for (const name of [longArabic, 'ABC Trading & Contracting Co.']) {
      const put = await call(r, 'PUT', '/seller', { body: { legalName: name } });
      assert.equal(put.status, 200, 'الحفظ لا يُمنع (الاسم القانوني يُقبل كما هو)');
      const issue = put.body.data.sellerIssues.find((i: { settingsField: string; rule: string }) => i.settingsField === 'legalName' && i.rule.startsWith('CSR-O-'));
      assert.ok(issue, `لا مسألة جاهزية لاسم يرفضه طلب الشهادة: ${put.text}`);
      assert.equal(issue.severity, 'error');
      assert.match(issue.messageAr, ARABIC);
      const ov = await call(r, 'GET', '/overview');
      assert.ok(ov.body.data.sellerIssues.some((i: { settingsField: string; severity: string }) => i.settingsField === 'legalName' && i.severity === 'error'));
      const created = await call(r, 'POST', '/units', { body: { environment: 'simulation' } });
      assert.equal(created.status, 422, created.text);
      assert.equal(created.body.code, 'CSR_PARAMS_INVALID');
      assert.equal(created.body.field, 'orgName');
    }
    const fixed = await call(r, 'PUT', '/seller', { body: { legalName: 'شركة التوزيع الميداني التجريبية المحدودة' } });
    assert.ok(!fixed.body.data.sellerIssues.some((i: { settingsField: string }) => i.settingsField === 'legalName'));
    await createSimUnit(r);
  } finally {
    await r.close();
  }
});

test('csrTextProblem وcsrReadinessIssues: قواعد validateCsrParams نفسها (64 نقطة يونيكود، ! @ # $ % & * _ <، علامات الاتجاه)، والعنوان المشتقّ تحذير لا منع', async () => {
  assert.equal(csrTextProblem('orgName', 'ش'.repeat(64)), null);
  assert.equal(csrTextProblem('orgName', 'ش'.repeat(65))?.reason, 'TOO_LONG');
  assert.equal(csrTextProblem('orgName', 'X Trading & Co')?.reason, 'FORBIDDEN_CHARACTER');
  assert.equal(csrTextProblem('orgName', 'شركة‏الاختبار')?.reason, 'CONTROL_CHARACTER');
  assert.equal(csrTextProblem('orgName', 'شركة الاختبار'), null);
  assert.ok(sellerReadiness(sellerSettings({ legalName: null })).every(i => !i.rule.startsWith('CSR-')), 'الاسم الفارغ تغطّيه قاعدة الإلزام وحدها');

  const hashStreet = sellerReadiness(sellerSettings({ addrStreet: 'Olaya St #4' }));
  const w = hashStreet.find(i => i.rule.startsWith('CSR-REGISTERED-ADDRESS-'));
  assert.ok(w, JSON.stringify(hashStreet));
  assert.equal(w.severity, 'warning', 'للمدير عنوان مختصر بديل عند الإنشاء ⇒ لا منع');
  assert.equal(w.settingsField, 'addrStreet');

  // مطابقة العنوان المشتقّ لما تكتبه الخدمة فعلاً في الوحدة (قصير، ثم طويل يُختصر)
  for (const settings of [{}, { addrStreet: 'طريق الملك عبدالعزيز الفرعي الشرقي المتفرع من الدائري الشمالي' }]) {
    const h = harness({ env: 'simulation', settings });
    const created = (await create(h)) as { ok: true; unit: EgsUnitView };
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(csrDefaultLocation(h.store.settings.get(TENANT)!), created.unit.locationAddress);
  }
  // عنوان يرفضه الطلب: الخدمة ترفض الإنشاء بلا عنوان مختصر وتقبله به
  const r = await rig();
  try {
    assert.equal((await call(r, 'PUT', '/seller', { body: { addrStreet: 'Olaya St #4' } })).status, 200);
    const refused = await call(r, 'POST', '/units', { body: { environment: 'simulation' } });
    assert.equal(refused.status, 422, refused.text);
    assert.equal(refused.body.field, 'locationAddress');
    const withOverride = await call(r, 'POST', '/units', { body: { environment: 'simulation', locationAddress: 'Olaya Riyadh' } });
    assert.equal(withOverride.status, 201, withOverride.text);
  } finally {
    await r.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// أدوات نقيّة
// ─────────────────────────────────────────────────────────────────────────────

test('jobOutcomeOf: يمحو OTP من كل نصّ (detail ورسائل الهيئة والمسائل) ولا يحمل الوحدة', () => {
  const otp = '482913';
  const out = jobOutcomeOf('onboard', {
    ok: false, code: 'NEW_OTP_REQUIRED', messageAr: `رمز ${otp} مرفوض`, retryable: false, needsNewOtp: true,
    unit: { id: 'u' } as unknown as EgsUnitView, detail: `Invalid-OTP:${otp}`,
    zatcaMessages: [{ type: 'ERROR', code: 'Invalid-OTP', message: `OTP ${otp} is not valid` }],
    issues: [{ rule: 'X', field: 'f', messageAr: `قيمة ${otp}`, severity: 'error' }],
  }, otp);
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, otpPattern(otp));
  assert.ok(!('unit' in out));
  assert.equal(out.needsNewOtp, true);
  assert.equal(out.code, 'NEW_OTP_REQUIRED');
  // أرقام ملاصقة لرقم أطول (requestID مثلاً) لا تُمسح
  const kept = jobOutcomeOf('onboard', { ok: false, code: 'ZATCA_CONFIG', messageAr: 'x', retryable: false, needsNewOtp: false, unit: null, detail: `req:1${otp}9` }, otp);
  assert.equal(kept.detail, `req:1${otp}9`);
  assert.equal(jobOutcomeOf('renew', { ok: true }, otp).ok, true);
});

test('unitChecklist وunitActivity: خطوات بترتيب الخريطة، الجارية أثناء الفحوص، وعقد الإيجار الحديث busy', () => {
  const now = new Date('2026-09-16T08:00:00.000Z');
  const base = {
    id: 'u1', tenantId: TENANT, environment: 'simulation', status: 'CHECKS_RUNNING', commonName: 'c', serialNumber: 's', functionMap: '1100', orgName: 'o',
    orgUnit: 'ou', vatNumber: '399999999900003', locationAddress: 'l', industry: 'i', keyVersion: 1, publicKeyPem: null, complianceRequestId: '1',
    complianceProgress: {
      v: 1, phase: 'onboarding', keyVersion: 1, requestId: '1',
      steps: { 'standard-compliant': { status: 'PASS', at: now.toISOString(), warnings: [], errors: [], priorEmpty400: 0, priorPayload413: 0, detail: null } },
    },
    certSerial: null, certNotBefore: null, certNotAfter: null, lastIcv: 0, activatedAt: null, revokedAt: null, lastError: null, createdAt: now, updatedAt: now,
  } as unknown as EgsUnitView;
  const c = unitChecklist(base, unitActivity(base, false, now, 600_000));
  assert.deepEqual(c.items.map(i => i.key), ['key', 'csr', 'ccsid', 'standard-compliant', 'standard-credit-note-compliant', 'standard-debit-note-compliant', 'simplified-compliant', 'simplified-credit-note-compliant', 'simplified-debit-note-compliant', 'pcsid']);
  assert.deepEqual(c.items.map(i => i.status), ['done', 'done', 'done', 'done', 'running', 'pending', 'pending', 'pending', 'pending', 'pending']);
  assert.equal(c.checksPassed, 1);
  assert.deepEqual(unitActivity(base, false, now, 600_000), { busy: true, reason: 'checks' });
  assert.deepEqual(unitActivity(base, false, new Date(now.getTime() + 600_001), 600_000), { busy: false, reason: null }, 'عامل مات: لا استطلاع أبدي');
  assert.deepEqual(unitActivity({ ...base, status: 'CSR_READY' }, true, now, 600_000), { busy: true, reason: 'job' });
  const unconfirmed = { ...base, status: 'RENEWING', complianceProgress: { ...base.complianceProgress!, renewal: { origin: 'ACTIVE', stage: 'unconfirmed', uncertain: true, at: now.toISOString() } } } as EgsUnitView;
  assert.equal(unitActivity(unconfirmed, false, now, 600_000).busy, false);
  assert.equal(unitChecklist(unconfirmed, unitActivity(unconfirmed, false, now, 600_000)).renewal?.stage, 'unconfirmed');
  const failed = unitChecklist({ ...base, status: 'ERROR_NEEDS_OTP', complianceProgress: { ...base.complianceProgress!, steps: { ...base.complianceProgress!.steps, 'standard-credit-note-compliant': { status: 'REJECTED', at: '', warnings: [], errors: [{ type: 'ERROR', code: 'BR-1', message: 'x' }], priorEmpty400: 0, priorPayload413: 0, detail: null } } } } as EgsUnitView, { busy: false, reason: null });
  assert.equal(failed.items[4].status, 'failed');
  assert.equal(failed.items[4].errors[0].code, 'BR-1');
});

test('unitChecklist بعد موت العامل: CHECKS_RUNNING أو علامة inFlight بعد انقضاء عقد الإيجار لا تُعرض «جارية» (والحديثة تُعرض)', () => {
  const now = new Date('2026-09-16T08:00:00.000Z');
  const lease = 600_000;
  const later = new Date(now.getTime() + lease + 1);
  const view = (over: Record<string, unknown>) => ({
    id: 'u1', tenantId: TENANT, environment: 'simulation', status: 'CHECKS_RUNNING', commonName: 'c', serialNumber: 's', functionMap: '1100', orgName: 'o',
    orgUnit: 'ou', vatNumber: '399999999900003', locationAddress: 'l', industry: 'i', keyVersion: 1, publicKeyPem: null, complianceRequestId: '1',
    complianceProgress: { v: 1, phase: 'onboarding', keyVersion: 1, requestId: '1', steps: {} },
    certSerial: null, certNotBefore: null, certNotAfter: null, lastIcv: 0, activatedAt: null, revokedAt: null, lastError: null, createdAt: now, updatedAt: now,
    ...over,
  }) as unknown as EgsUnitView;
  const statusOf = (u: EgsUnitView, at: Date, key: string) => unitChecklist(u, unitActivity(u, false, at, lease)).items.find(i => i.key === key)?.status;
  const running = (u: EgsUnitView, at: Date) => unitChecklist(u, unitActivity(u, false, at, lease)).items.filter(i => i.status === 'running').map(i => i.key);

  const checks = view({});
  assert.deepEqual(running(checks, now), ['standard-compliant'], 'فحوص حيّة: أول خطوة جارية');
  assert.deepEqual(running(checks, later), [], 'عامل مات أثناء الفحوص: لا مؤشّر يدور');
  assert.equal(statusOf(checks, later, 'standard-compliant'), 'pending');

  const ccsid = view({ status: 'CSR_READY', complianceRequestId: null, complianceProgress: { v: 1, phase: 'onboarding', keyVersion: 1, requestId: null, steps: {}, inFlight: { op: 'compliance', at: now.toISOString() } } });
  assert.equal(statusOf(ccsid, now, 'ccsid'), 'running');
  assert.equal(statusOf(ccsid, later, 'ccsid'), 'pending', 'طلب شهادة الامتثال انقطع: الخانة تعود «بانتظار الرمز» لا «جارية»');

  const pcsid = view({ status: 'CHECKS_PASSED', complianceProgress: { v: 1, phase: 'onboarding', keyVersion: 1, requestId: '1', steps: {}, inFlight: { op: 'production-csid', at: now.toISOString() } } });
  assert.equal(statusOf(pcsid, now, 'pcsid'), 'running');
  assert.equal(statusOf(pcsid, later, 'pcsid'), 'pending');

  // مهمّة هنا: جارية مهما كان عمر آخر كتابة
  assert.deepEqual(unitChecklist(checks, unitActivity(checks, true, later, lease)).items.filter(i => i.status === 'running').map(i => i.key), ['standard-compliant']);
});

test('العنوان المختصر في الشهادة لا يضيع: وحدة أُنشئت به (عنوان المنشأة يرفضه الطلب) تجدَّد وتُعاد بنائها بعد رفض عبر csrFields، وبدونه CSR_PARAMS_INVALID بلا استهلاك الرمز', async () => {
  const r = await rig();
  try {
    assert.equal((await call(r, 'PUT', '/seller', { body: { addrStreet: 'King Fahd Road #12' } })).status, 200);
    const ov = await call(r, 'GET', '/overview');
    assert.equal(ov.body.data.csrDefaultLocation, csrDefaultLocation(r.h.store.settings.get(TENANT)!), 'النظرة العامّة تعرض العنوان المشتقّ');
    assert.ok(ov.body.data.sellerIssues.some((i: { rule: string }) => i.rule.startsWith('CSR-REGISTERED-ADDRESS-')));
    const short = 'Olaya Riyadh 12345';
    const created = await call(r, 'POST', '/units', { body: { environment: 'simulation', locationAddress: short } });
    assert.equal(created.status, 201, created.text);
    const id = created.body.data.unit.id as string;
    assert.equal((await call(r, 'POST', `/units/${id}/onboard`, { body: { otp: r.h.otps.shift() } })).status, 202);
    const active = await poll(r, id);
    assert.equal(active.body.data.unit.status, 'ACTIVE', active.text);
    assert.equal(active.body.data.unit.locationAddress, short);

    // التجديد بلا العنوان: الخدمة تعيد اشتقاقه من عنوان المنشأة فيُرفض قبل أي طلب للهيئة
    const renewOtp = r.h.renewalOtps[0];
    assert.equal((await call(r, 'POST', `/units/${id}/renew`, { body: { otp: renewOtp } })).status, 202);
    const refused = (await poll(r, id)).body.data;
    assert.equal(refused.job.outcome.code, 'CSR_PARAMS_INVALID');
    assert.equal(refused.job.outcome.field, 'locationAddress');
    assert.equal(refused.unit.status, 'ACTIVE');
    assert.ok(r.h.zatca.renewalOtps.has(renewOtp), 'الرمز لم يُرسل للهيئة');
    // التجديد بالعنوان المختصر (ما ترسله الواجهة): يكتمل بالرمز نفسه ويبقى العنوان
    assert.equal((await call(r, 'POST', `/units/${id}/renew`, { body: { otp: renewOtp, csrFields: { locationAddress: short } } })).status, 202);
    const renewed = (await poll(r, id)).body.data;
    assert.equal(renewed.job.outcome.ok, true, JSON.stringify(renewed.job.outcome));
    assert.equal(renewed.unit.keyVersion, 2);
    assert.equal(renewed.unit.locationAddress, short);
    assertNothingLeaked(r);
  } finally {
    await r.close();
  }

  const r2 = await rig();
  try {
    assert.equal((await call(r2, 'PUT', '/seller', { body: { addrStreet: 'King Fahd Road #12' } })).status, 200);
    const short = 'Olaya Riyadh 12345';
    const created = await call(r2, 'POST', '/units', { body: { environment: 'simulation', locationAddress: short } });
    assert.equal(created.status, 201, created.text);
    const id = created.body.data.unit.id as string;
    r2.h.zatca.opts.onCheck = (_c, n) => (n === 1 ? { status: 400, body: z3Body('compliance-invoices-400') } : undefined);
    assert.equal((await call(r2, 'POST', `/units/${id}/onboard`, { body: { otp: r2.h.otps.shift() } })).status, 202);
    const rejected = (await poll(r2, id)).body.data;
    assert.equal(rejected.unit.status, 'ERROR_NEEDS_OTP', JSON.stringify(rejected.job.outcome));
    r2.h.zatca.opts.onCheck = undefined;

    const otp = r2.h.otps[0];
    assert.equal((await call(r2, 'POST', `/units/${id}/onboard`, { body: { otp } })).status, 202);
    const noAddress = (await poll(r2, id)).body.data;
    assert.equal(noAddress.job.outcome.code, 'CSR_PARAMS_INVALID');
    assert.equal(noAddress.job.outcome.field, 'locationAddress');
    assert.equal(noAddress.unit.status, 'ERROR_NEEDS_OTP');
    assert.ok(r2.h.zatca.otps.has(otp), 'الرمز لم يُرسل للهيئة');
    assert.equal((await call(r2, 'POST', `/units/${id}/onboard`, { body: { otp, csrFields: { locationAddress: short } } })).status, 202);
    const done = (await poll(r2, id)).body.data;
    assert.equal(done.unit.status, 'ACTIVE', JSON.stringify(done.job.outcome));
    assert.equal(done.unit.locationAddress, short);
    assertNothingLeaked(r2);
  } finally {
    await r2.close();
  }
});

test('validateSellerBody وsellerWarnings وhttpStatusForCode وlatinDigits', () => {
  assert.equal(latinDigits('٠١٢٣٤٥٦٧٨٩ ۰۱۲'), '0123456789 012');
  const v = validateSellerBody({ taxNumber: ' ٣٩٩٩٩٩٩٩٩٩٠٠٠٠٣ ', addrPostalCode: '', sellerIdScheme: 'crn', legalName: 5 });
  assert.equal(v.patch.taxNumber, '399999999900003');
  assert.equal(v.patch.addrPostalCode, null);
  assert.equal(v.patch.sellerIdScheme, 'CRN');
  assert.deepEqual(v.errors.map(e => e.field), ['legalName']);
  assert.equal(validateSellerBody(null).errors.length, 1);
  assert.equal(validateSellerBody({ sellerIdValue: '10 10' }).errors[0].field, 'sellerIdValue');
  const before = sellerSettings();
  assert.deepEqual(sellerWarnings(before, { ...before, addrCity: 'جدة' }, [{ id: 'x', status: 'CSR_READY', vatNumber: before.taxNumber as string }]), [], 'وحدة بلا شهادة لا تحذير');
  assert.equal(sellerWarnings(before, { ...before, addrCity: 'جدة' }, [{ id: 'x', status: 'EXPIRED', vatNumber: before.taxNumber as string }])[0].code, 'CSR_MAY_BE_STALE');
  assert.equal(httpStatusForCode('UNIT_NOT_FOUND'), 404);
  assert.equal(httpStatusForCode('SECRETS_UNAVAILABLE'), 503);
  assert.equal(httpStatusForCode('IN_PROGRESS'), 409);
  assert.equal(httpStatusForCode('NEW_OTP_REQUIRED'), 422);
  assert.ok(sellerReadiness(sellerSettings()).every(i => i.severity !== 'error'), 'بيانات العُدّة الكاملة بلا أخطاء جاهزية');
});

test('companyZatcaFieldChanges (PUT /api/company بعلم المالك): التغيير الفعلي بعد التطبيع وحده يحتاج المدير، والصيغ كـPUT /seller، ولا قيد لمنشأة غير سعودية', () => {
  const cur = { taxNumber: '399999999900003', commercialReg: '1010010101', countryCode: 'SA' };
  // حفظ عاديّ (شعار أو اسم) يرسل القيم نفسها — بمسافات أو أرقام عربية — ليس تغييراً ولا يُكتب
  const same = companyZatcaFieldChanges(cur, { taxNumber: ' ٣٩٩٩٩٩٩٩٩٩٠٠٠٠٣ ', commercialReg: '1010010101', countryCode: 'SA' });
  assert.deepEqual(same, { changed: [], write: {}, unchanged: ['taxNumber', 'commercialReg'], errors: [] });
  assert.deepEqual(companyZatcaFieldChanges(cur, {}), { changed: [], write: {}, unchanged: [], errors: [] }, 'لم يُرسل شيء');
  assert.deepEqual(companyZatcaFieldChanges({ ...cur, commercialReg: null }, { commercialReg: '' }).changed, [], 'فراغ مكان null ليس تغييراً');

  const vat = companyZatcaFieldChanges(cur, { taxNumber: '٣١١١١١١١١١١١١١٣', commercialReg: '1010010101' });
  assert.deepEqual(vat.changed, ['taxNumber']);
  assert.deepEqual(vat.write, { taxNumber: '311111111111113' }, 'يُكتب مطبَّعاً كـPUT /api/zatca/seller');
  assert.deepEqual(vat.errors, []);
  const bad = companyZatcaFieldChanges(cur, { taxNumber: '12345', commercialReg: 'x'.repeat(65) });
  assert.deepEqual(bad.changed, ['taxNumber', 'commercialReg']);
  assert.deepEqual(bad.errors.map(e => e.field).sort(), ['commercialReg', 'taxNumber']);
  assert.deepEqual(companyZatcaFieldChanges(cur, { taxNumber: '' }).write, { taxNumber: null }, 'الإفراغ تغيير يُكتب null');
  assert.deepEqual(companyZatcaFieldChanges(cur, { taxNumber: '' }).errors, []);

  // الدولة: الخروج من SA يغلق /api/zatca ⇒ تغيير؛ والصيغ السعودية لا تُفرض على منشأة صارت غير سعودية
  const away = companyZatcaFieldChanges(cur, { countryCode: 'AE', taxNumber: '100000000000003' });
  assert.deepEqual(away.changed, ['countryCode', 'taxNumber']);
  assert.deepEqual(away.errors, []);
  assert.deepEqual(companyZatcaFieldChanges({ ...cur, countryCode: 'AE' }, { countryCode: 'SA' }).changed, ['countryCode'], 'الدخول إلى SA تغيير أيضاً');
  assert.deepEqual(companyZatcaFieldChanges({ ...cur, countryCode: 'AE' }, { countryCode: 'AE', taxNumber: '1' }), { changed: [], write: {}, unchanged: [], errors: [] }, 'منشأة غير سعودية قبل وبعد: لا قيد');
  assert.deepEqual(companyZatcaFieldChanges(null, { taxNumber: '399999999900003', countryCode: 'SA' }).changed, ['countryCode', 'taxNumber'], 'بلا صفّ إعدادات: كل قيمة تغيير');
});

// ─────────────────────────────────────────────────────────────────────────────
// حرّاس ثابتة على التوصيل
// ─────────────────────────────────────────────────────────────────────────────

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('التوصيل: العمود مطفأ افتراضياً، في مخطّط التحديث وحده، /company بـ=== true، والموجّه مركّب بعد المحدّد مع zatcaErrorGuard', () => {
  const schema = read('prisma', 'schema.prisma');
  assert.match(schema, /zatcaPhase2Enabled\s+Boolean\s+@default\(false\)/);
  const tenants = read('src', 'routes', 'tenants.ts');
  const cStart = tenants.indexOf('const createTenantSchema');
  const uStart = tenants.indexOf('const updateTenantSchema');
  assert.doesNotMatch(tenants.slice(cStart, uStart), /zatcaPhase2Enabled/, 'لا يُقبل العلم عند إنشاء الشركة');
  assert.match(tenants.slice(uStart), /zatcaPhase2Enabled: z\.boolean\(\)\.optional\(\)/);
  const company = read('src', 'routes', 'company.ts');
  assert.match(company, /zatcaPhase2Enabled: true/);
  assert.match(company, /zatcaPhase2Enabled: tenant\?\.zatcaPhase2Enabled === true/);
  const index = read('src', 'index.ts');
  const limiter = index.indexOf("app.use('/api', apiLimiter)");
  const mount = index.indexOf("app.use('/api/zatca', createZatcaRouter(productionZatcaDeps()), zatcaErrorGuard)");
  const handler = index.indexOf('app.use(errorHandler)');
  assert.ok(limiter > 0 && mount > limiter && handler > mount, 'الموجّه غير مركّب بعد محدّد المعدّل أو بعد معالج الأخطاء العامّ');
  const deps = read('src', 'routes', 'zatcaDeps.ts');
  // الدور من القاعدة لا من التوكن: صفّ الحساب بالمعرّف (لا requireAdminPermission الذي لا يفحص الدور)
  assert.doesNotMatch(deps, /requireAdminPermission|requirePermission/);
  assert.ok(deps.includes('prisma.admin.findUnique({ where: { id: req.user.id }, select: { isActive: true, role: true, tenantId: true, canManageCompanySettings: true } })'), 'loadAdmin لا يقرأ الدور والشركة والصلاحية من القاعدة');
  assert.match(deps, /isScopeRestricted: adminScopeEnabled/);
  assert.match(deps, /zatcaPhase2Enabled === true/);
  assert.match(deps, /loadKeyring: \(\) => keyringFromEnv\(env\)/);
  assert.match(deps, /config: zatcaEnvConfig\(env\)/);
  const route = read('src', 'routes', 'zatca.ts');
  assert.doesNotMatch(route, /config\/database/, 'الموجّه لا يستورد قاعدة البيانات (الاختبارات بلا اتصال)');
  assert.doesNotMatch(route, /console\.(log|error)\([^)]*(req\.body|otp)/i, 'تسجيل جسم الطلب أو OTP');
});

// ─────────────────────────────────────────────────────────────────────────────
// انتحال المالك وتجديد التوكن (آخر الملف: يحمّل موجّه /api/auth الحقيقي وPrisma — بلا أي اتصال بقاعدة البيانات)
// ─────────────────────────────────────────────────────────────────────────────

test('انتحال المالك: /api/auth/renew يرفض تجديد توكن الانتحال قبل أي قراءة للحساب، فيبقى ربط الفوترة للاطلاع فقط (IMPERSONATION_READ_ONLY)', async () => {
  // قاعدة بيانات مستحيلة: عنوان حلقة محلية مغلق يُضبط قبل تحميل Prisma (ملف .env لا يطغى على متغيّر مضبوط)،
  // وكل مفوَّض نموذج يُستبدل بفخّ يسجّل ويرمي — فلو وصل التجديد إلى prisma لفشل الاختبار بلا أي اتصال.
  process.env.DATABASE_URL = 'postgresql://offline:offline@127.0.0.1:9/offline?connect_timeout=1';
  const SECRET = 'zatca-routes-test-jwt-secret';
  process.env.JWT_SECRET = SECRET;
  const prisma = (await import('../config/database')).default as unknown as Record<string, unknown>;
  const dbHits: string[] = [];
  for (const model of ['admin', 'salesRep', 'superAdmin', 'tenant', 'companySettings']) {
    prisma[model] = new Proxy({}, { get: (_t, op) => { dbHits.push(`${model}.${String(op)}`); throw new Error('database access in test'); } });
  }
  const authRouter = (await import('../routes/auth')).default;

  // مصادقة الموجّه بالتوقيع الحقيقي (كـauthenticate بلا قراءة الحساب): req.user = حمولة التوكن كما هي
  const jwtAuthenticate = (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      req.user = jwt.verify(req.headers.authorization?.split(' ')[1] ?? '', SECRET) as AuthRequest['user'];
      next();
    } catch {
      res.status(401).json({ success: false, message: 'غير مصرح' });
    }
  };
  const r = await rig({ deps: { authenticate: jwtAuthenticate }, mount: app => app.use('/api/auth', authRouter) });
  const send = (method: string, url: string, token: string | null, body?: unknown): Promise<Reply> => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: r.port, method, path: url,
      headers: {
        ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = null;
        try { parsed = JSON.parse(text); } catch { /* ليس JSON */ }
        resolve({ status: res.statusCode ?? 0, body: parsed, text });
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
  try {
    // كما يوقّعه POST /api/tenants/:id/impersonate
    const claims = { id: ADMIN.id, role: 'ADMIN', name: ADMIN.name, tenantId: TENANT, impersonated: true };
    const impToken = jwt.sign(claims, SECRET, { expiresIn: '2h' });
    const expiredImp = jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 3600 }, SECRET);

    const before = await send('POST', '/api/zatca/units', impToken, { environment: 'simulation' });
    assert.equal(before.status, 403, before.text);
    assert.equal(before.body.code, 'IMPERSONATION_READ_ONLY');

    for (const attempt of [
      () => send('POST', '/api/auth/renew', impToken, {}),
      () => send('POST', '/api/auth/renew', null, { token: impToken }),
      () => send('POST', '/api/auth/renew', expiredImp, {}),
    ]) {
      const renew = await attempt();
      assert.equal(renew.status, 401, renew.text);
      assert.equal(renew.body.code, 'IMPERSONATION_RENEW_REFUSED');
      assert.match(renew.body.message, ARABIC);
      assert.equal(renew.body.data, undefined, 'التجديد أصدر توكناً');
      assert.doesNotMatch(renew.text, /eyJ[A-Za-z0-9_-]+\./, 'الردّ يحمل JWT');
    }

    const after = await send('POST', '/api/zatca/units', impToken, { environment: 'simulation' });
    assert.equal(after.status, 403, after.text);
    assert.equal(after.body.code, 'IMPERSONATION_READ_ONLY');
    assert.equal((await send('PUT', '/api/zatca/seller', impToken, { legalName: 'x' })).body.code, 'IMPERSONATION_READ_ONLY');
    assert.equal(r.h.store.received.length, 0, 'جلسة الانتحال كتبت في المخزن');

    // ضبط: توكن مدير الشركة نفسه بلا علم الانتحال يمرّ — فالرفض أعلاه بسبب الانتحال وحده
    const plain = jwt.sign({ id: ADMIN.id, role: 'ADMIN', name: ADMIN.name, tenantId: TENANT }, SECRET, { expiresIn: '1h' });
    const own = await send('POST', '/api/zatca/units', plain, { environment: 'simulation' });
    assert.equal(own.status, 201, own.text);
    assert.deepEqual(dbHits, [], 'مسار التجديد قرأ قاعدة البيانات لتوكن انتحال');
  } finally {
    await r.close();
  }
});
