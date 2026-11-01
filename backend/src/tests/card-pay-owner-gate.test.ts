// «التحصيل بالبطاقة لأي شركة» (طلب المالك ١ نوفمبر ٢٠٢٦) — ما يبقى بعد إسقاط قائمة الخادم: بوابة المالك وحدها، فتُختبر
// سلوكاً عبر PUT /api/tenants/:id الحقيقي (Prisma مزيّف بلا قاعدة):
//   • موظف المنصة — ولو بـtenants.edit — لا يفعّل التحصيل ولا يغيّر التاجر (403 بلا كتابة)، ورسالته بلا اسم مزوّد الدفع
//     (الموظف يحادث الشركات)؛ والجسم الذي يعيد القيم نفسها يمرّ.
//   • تاجرٌ واحد لشركة واحدة: تاجرٌ مربوطٌ بشركة أخرى ⇒ 409 بلا كتابة.
//   • المالك يفعّل ويربط تاجراً حرّاً ⇒ يُكتب، وتسقط نقاط البيع القديمة لمناديب الشركة — بلا أي متغيّر خادم لكل شركة.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'card-pay-owner-gate-test-secret';
const SECRET = process.env.JWT_SECRET;
const SRC = path.join(__dirname, '..');
const BRAND = /near[\s_-]*pay|نير[\s_-]*باي/i;

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
      return async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prismaFake) : Promise.all(arg as Promise<unknown>[]));
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
/* eslint-disable @typescript-eslint/no-var-requires */
const tenantsModule = require('../routes/tenants') as typeof import('../routes/tenants');
const pa = require('../services/platformAccess') as typeof import('../services/platformAccess');
/* eslint-enable @typescript-eslint/no-var-requires */

const realFetch = globalThis.fetch;
let server: { port: number; close: () => Promise<void> } | null = null;
after(async () => { await server?.close(); server = null; });
async function put(body: unknown, token: string): Promise<{ status: number; body: Record<string, any> }> {
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use('/api/tenants', tenantsModule.default);
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ success: false, message: err.message }); });
    const s = http.createServer(app);
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
  }
  const r = await realFetch(`http://127.0.0.1:${server.port}/api/tenants/T1`, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : {} };
}

const MERCHANT = '7d0b1c2e-3f40-4a5b-8c6d-7e8f90a1b2c3';
const OTHER = '9e1c2d3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const ownerToken = (): string => jwt.sign({ id: 'o1', role: 'SUPER_ADMIN', name: 'المالك' }, SECRET);
const staff = { id: 's1', name: 'سارة', email: 's@x.co', isActive: true, permissions: ['tenants.edit'], tokenVersion: 0, mustChangePassword: false };

/** بيئة الخادم كما على Render اليوم: اختبار المزوّد على خادم إنتاج — وبلا قائمة شركات (NEARPAY_SANDBOX_TENANTS) */
async function withServerEnv(fn: () => Promise<void>): Promise<void> {
  const keys = ['NEARPAY_ENV', 'NODE_ENV', 'NEARPAY_SANDBOX_TENANTS', 'NEARPAY_API_KEY', 'NEARPAY_API_BASE'] as const;
  const prev = keys.map((k) => process.env[k]);
  const prevFetch = globalThis.fetch;
  process.env.NEARPAY_ENV = 'sandbox';
  process.env.NODE_ENV = 'production';
  process.env.NEARPAY_API_KEY = 'test-key';
  delete process.env.NEARPAY_SANDBOX_TENANTS;
  delete process.env.NEARPAY_API_BASE;
  // تجّار حسابنا لدى المزوّد: التاجران كلاهما معروفان
  globalThis.fetch = (async () => new Response(JSON.stringify({ merchants: [{ id: MERCHANT, name: 'A' }, { id: OTHER, name: 'B' }], pages: { total: 1 } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
  try { await fn(); } finally {
    globalThis.fetch = prevFetch;
    keys.forEach((k, i) => { if (prev[i] === undefined) delete process.env[k]; else process.env[k] = prev[i]; });
  }
}
function reset(current: { cardPayEnabled: boolean; nearpayMerchantId: string | null }, linkedElsewhere: string | null = null): void {
  calls = [];
  scripted = {
    'platformAuditLog.create': () => ({ id: 'aud-1' }),
    'superAdmin.findUnique': () => ({ isActive: true }),
    'platformStaff.findUnique': () => staff,
    'tenant.findUnique': () => ({ ...current }),
    'tenant.findFirst': (a) => (linkedElsewhere && a?.where?.nearpayMerchantId === linkedElsewhere ? { name: 'شركة أخرى' } : null),
    'tenant.update': (a) => ({ id: 'T1', ...a.data }),
  };
}
const wrote = (): boolean => calls.some((c) => c.op === 'tenant.update');

test('موظف المنصة لا يفعّل التحصيل بالبطاقة ولا يغيّر التاجر — 403 بلا كتابة ورسالةٌ بلا اسم المزوّد؛ والقيم نفسها تمرّ', async () => {
  const token = pa.signStaffToken(staff);
  await withServerEnv(async () => {
    for (const body of [{ cardPayEnabled: true }, { nearpayMerchantId: MERCHANT }, { cardPayEnabled: true, nearpayMerchantId: MERCHANT }]) {
      reset({ cardPayEnabled: false, nearpayMerchantId: null });
      const r = await put(body, token);
      assert.equal(r.status, 403, `${JSON.stringify(body)} ⇒ ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'STAFF_CARDPAY_FORBIDDEN');
      assert.doesNotMatch(String(r.body.message), BRAND);
      assert.ok(!wrote(), 'لا كتابة');
    }
    // إطفاءٌ أو فكّ تاجرٍ قائم كذلك للمالك وحده
    for (const body of [{ cardPayEnabled: false }, { nearpayMerchantId: null }]) {
      reset({ cardPayEnabled: true, nearpayMerchantId: MERCHANT });
      const r = await put(body, token);
      assert.equal(r.status, 403, `${JSON.stringify(body)} ⇒ ${JSON.stringify(r.body)}`);
      assert.ok(!wrote());
    }
    // نموذج الحفظ يعيد القيمتين كما هما مع تعديلٍ آخر — يمرّ
    reset({ cardPayEnabled: true, nearpayMerchantId: MERCHANT });
    const same = await put({ name: 'شركة', cardPayEnabled: true, nearpayMerchantId: MERCHANT }, token);
    assert.equal(same.status, 200, JSON.stringify(same.body));
  });
});

test('تاجرٌ واحد لشركة واحدة: ربط تاجرٍ مربوطٍ بشركة أخرى يُرفض 409 بلا كتابة — والمالك يفعّل بتاجرٍ حرّ بلا قائمة الخادم', async () => {
  await withServerEnv(async () => {
    reset({ cardPayEnabled: false, nearpayMerchantId: null }, OTHER);
    const taken = await put({ cardPayEnabled: true, nearpayMerchantId: OTHER }, ownerToken());
    assert.equal(taken.status, 409, JSON.stringify(taken.body));
    assert.match(String(taken.body.message), /شركة أخرى/);
    assert.ok(!wrote(), 'لا كتابة');

    reset({ cardPayEnabled: false, nearpayMerchantId: null }, OTHER);
    const ok = await put({ cardPayEnabled: true, nearpayMerchantId: MERCHANT }, ownerToken());
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const upd = calls.find((c) => c.op === 'tenant.update')!.args.data;
    assert.equal(upd.cardPayEnabled, true);
    assert.equal(upd.nearpayMerchantId, MERCHANT);
    // تغيّر التاجر ⇒ تسقط نقاط البيع القديمة لمناديب الشركة
    assert.ok(calls.some((c) => c.op === 'salesRep.updateMany' && c.args.data.nearpayTid === null));
  });
});
