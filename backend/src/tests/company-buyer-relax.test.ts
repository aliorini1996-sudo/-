// «فك قيد الرقم الضريبي والعنوان الوطني» (طلب المالك ٣١ أكتوبر ٢٠٢٦) — GET|PATCH /api/company/buyer-relax بقاعدة مزيّفة في الذاكرة
// وخادم على 127.0.0.1 (لا قاعدة ولا شبكة): القراءة لكل مستخدم شركة، والتغيير لمدير الشركة غير المقيّد أو جلسة المالك وحدهما بلا
// مفتاح API وبسطر تدقيق — مع حرّاس نصّية على التركيب في company.ts (الـBOM، وcompanySchema بلا المفتاح) وعلى SELLER_SELECT.
import { guardHits } from '../compliance/zatca/__fixtures__/z3-netguard';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { NextFunction, Request, Response } from 'express';
import { BUYER_RELAX_AUDIT_EVENT, BUYER_RELAX_CODES, buyerRelaxAuditLine, createBuyerRelaxRouter, type BuyerRelaxDeps } from '../routes/companyBuyerRelax';
import { errorHandler } from '../middleware/errorHandler';
import type { AuthRequest } from '../types';

after(() => { assert.equal(guardHits(), 0, 'محاولة شبكة حقيقية'); });

const SRC = path.join(__dirname, '..');
const raw = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const TENANT = 'tenant-relax';
type AdminRow = { id: string; role: string; tenantId: string; isActive: boolean };

function fakeDb(o: { settings?: { buyerVatAddressRelaxed: boolean } | null; admins?: AdminRow[] } = {}) {
  const calls: string[] = [];
  let row = o.settings === undefined ? { buyerVatAddressRelaxed: false } : o.settings;
  const admins = o.admins ?? [];
  const db = {
    companySettings: {
      findUnique: async (a: { where: { tenantId: string }; select: Record<string, boolean> }) => {
        calls.push(`companySettings.findUnique:${Object.keys(a.select).join(',')}`);
        return a.where.tenantId === TENANT && row ? { ...row } : null;
      },
      updateMany: async (a: { where: { tenantId: string }; data: { buyerVatAddressRelaxed: boolean } }) => {
        calls.push(`companySettings.updateMany:${Object.keys(a.data).join(',')}`);
        if (a.where.tenantId !== TENANT || !row) return { count: 0 };
        row = { ...row, ...a.data };
        return { count: 1 };
      },
    },
    admin: {
      findUnique: async (a: { where: { id: string }; select: Record<string, boolean> }) => {
        calls.push('admin.findUnique');
        const r = admins.find(x => x.id === a.where.id);
        return r ? Object.fromEntries(Object.keys(a.select).map(k => [k, (r as Record<string, unknown>)[k]])) : null;
      },
    },
  };
  return { db: db as unknown as BuyerRelaxDeps['db'], calls, current: () => row };
}

const ADMIN = { id: 'admin-1', role: 'ADMIN', name: 'مدير', tenantId: TENANT };
const MANAGER = { id: 'mgr-1', role: 'MANAGER', name: 'مشرف', tenantId: TENANT };
const REP = { id: 'rep-1', role: 'SALES_REP', name: 'مندوب', tenantId: TENANT };
const ADMINS: AdminRow[] = [
  { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, isActive: true },
  { id: 'admin-scoped', role: 'ADMIN', tenantId: TENANT, isActive: true },
  { id: 'mgr-1', role: 'MANAGER', tenantId: TENANT, isActive: true },
  { id: 'admin-off', role: 'ADMIN', tenantId: TENANT, isActive: false },
  // مديرُ شركةٍ أخرى بتوكنٍ يحمل هذه الشركة (نُقل بعد إصداره) — العزل من صفّه في القاعدة لا من التوكن
  { id: 'admin-moved', role: 'ADMIN', tenantId: 'tenant-other', isActive: true },
];

async function serve(db: BuyerRelaxDeps['db'], user: () => object, o: { scoped?: string[]; audit?: string[]; permitted?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => { (req as AuthRequest).user = user() as AuthRequest['user']; next(); });
  app.use('/api/company/buyer-relax', createBuyerRelaxRouter({
    db,
    scopeEnabled: async req => req.user?.impersonated !== true && (o.scoped ?? []).includes(req.user?.id ?? ''),
    tenantId: req => req.user!.tenantId!,
    audit: line => o.audit?.push(line),
    // حارس صلاحية «إعدادات الشركة» محقون (الإنتاج: requireAdminPermission يقرأ القاعدة)
    permission: (_req, res, next) => {
      if (o.permitted === false) { res.status(403).json({ success: false, message: 'لا تملك صلاحية الوصول لهذا القسم' }); return; }
      next();
    },
  }));
  app.use(errorHandler);
  const server = http.createServer(app);
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  const call = (method: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: '/api/company/buyer-relax', headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {} }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
  return { call, close: () => new Promise(r => server.close(r)) };
}

test('GET: مطفأ افتراضاً لكل مستخدم شركة (ولمفتاح القراءة)، وبلا صفّ إعدادات enabled:false — والمندوب 403', async () => {
  const f = fakeDb();
  let user: object = MANAGER;
  const s = await serve(f.db, () => user);
  try {
    let res = await s.call('GET');
    assert.deepEqual([res.status, res.body], [200, { success: true, data: { enabled: false } }]);
    assert.deepEqual(f.calls, ['companySettings.findUnique:buyerVatAddressRelaxed']);
    user = { ...ADMIN, apiKeyId: 'key-ro' };
    res = await s.call('GET');
    assert.equal(res.status, 200);
    user = REP;
    res = await s.call('GET');
    assert.equal(res.status, 403);
  } finally { await s.close(); }
  const none = fakeDb({ settings: null });
  const s2 = await serve(none.db, () => ADMIN);
  try {
    assert.deepEqual((await s2.call('GET')).body, { success: true, data: { enabled: false } });
  } finally { await s2.close(); }
});

test('PATCH بمدير الشركة: يكتب العمود وحده ويعيد الحالة، وسطر تدقيق بالحدث والمعرّفات والحالة — ثم الإطفاء', async () => {
  const f = fakeDb({ admins: ADMINS });
  const audit: string[] = [];
  const s = await serve(f.db, () => ADMIN, { audit });
  try {
    let res = await s.call('PATCH', { enabled: true });
    assert.deepEqual([res.status, res.body], [200, { success: true, data: { enabled: true } }]);
    assert.deepEqual(f.current(), { buyerVatAddressRelaxed: true });
    assert.ok(f.calls.includes('companySettings.updateMany:buyerVatAddressRelaxed'));
    assert.deepEqual(JSON.parse(audit[0]), { event: BUYER_RELAX_AUDIT_EVENT, tenantId: TENANT, actorId: 'admin-1', role: 'ADMIN', impersonated: false, enabled: true });
    assert.equal(BUYER_RELAX_AUDIT_EVENT, 'ZATCA_BUYER_RELAX');
    assert.deepEqual((await s.call('GET')).body.data, { enabled: true });
    res = await s.call('PATCH', { enabled: false });
    assert.deepEqual(res.body.data, { enabled: false });
    assert.equal(JSON.parse(audit[1]).enabled, false);
  } finally { await s.close(); }
});

test('PATCH مرفوض: مشرف بالصلاحية 403 BUYER_RELAX_ADMIN_ONLY، مدير مقيّد 403 BUYER_RELAX_SCOPED، مفتاح API 403 API_KEY_FORBIDDEN، ومدير معطّل — بلا كتابة ولا تدقيق', async () => {
  const f = fakeDb({ admins: ADMINS });
  const audit: string[] = [];
  let user: object = MANAGER;
  const s = await serve(f.db, () => user, { scoped: ['admin-scoped'], audit });
  try {
    let res = await s.call('PATCH', { enabled: true });
    assert.deepEqual([res.status, res.body.code, res.body.message], [403, 'BUYER_RELAX_ADMIN_ONLY', BUYER_RELAX_CODES.BUYER_RELAX_ADMIN_ONLY]);
    user = { ...ADMIN, id: 'admin-scoped' };
    res = await s.call('PATCH', { enabled: true });
    assert.deepEqual([res.status, res.body.code], [403, 'BUYER_RELAX_SCOPED']);
    user = { ...ADMIN, apiKeyId: 'key-1' };
    res = await s.call('PATCH', { enabled: true });
    assert.deepEqual([res.status, res.body.code, res.body.message], [403, 'API_KEY_FORBIDDEN', 'هذا الإجراء غير متاح بمفتاح API']);
    user = { ...ADMIN, id: 'admin-off' };
    res = await s.call('PATCH', { enabled: true });
    assert.deepEqual([res.status, res.body.code], [403, 'BUYER_RELAX_ADMIN_ONLY']);
    // دور التوكن لا يكفي: معرّف غير موجود في القاعدة
    user = { ...ADMIN, id: 'ghost' };
    res = await s.call('PATCH', { enabled: true });
    assert.deepEqual([res.status, res.body.code], [403, 'BUYER_RELAX_ADMIN_ONLY']);
    // عزل الشركة: صفّ المدير في القاعدة لشركةٍ أخرى ⇒ لا يكتب على هذه ولو حمل توكنه معرّفها
    user = { ...ADMIN, id: 'admin-moved' };
    res = await s.call('PATCH', { enabled: true });
    assert.deepEqual([res.status, res.body.code], [403, 'BUYER_RELAX_ADMIN_ONLY']);
    user = REP;
    assert.equal((await s.call('PATCH', { enabled: true })).status, 403);
  } finally { await s.close(); }
  assert.deepEqual(f.current(), { buyerVatAddressRelaxed: false });
  assert.equal(f.calls.filter(c => c.startsWith('companySettings.updateMany')).length, 0);
  assert.deepEqual(audit, []);
  // بلا صلاحية «إعدادات الشركة»: حارس الصلاحية قبل كل شيء
  const g = fakeDb({ admins: ADMINS });
  const s2 = await serve(g.db, () => ADMIN, { permitted: false });
  try {
    assert.equal((await s2.call('PATCH', { enabled: true })).status, 403);
  } finally { await s2.close(); }
  assert.deepEqual(g.calls, []);
});

test('PATCH بجلسة مالك المنصة: مسموح (ولو عبر حساب مشرف أو مقيّد) وسطر التدقيق impersonated:true', async () => {
  const f = fakeDb({ admins: ADMINS });
  const audit: string[] = [];
  const s = await serve(f.db, () => ({ ...MANAGER, impersonated: true }), { scoped: ['mgr-1'], audit });
  try {
    const res = await s.call('PATCH', { enabled: true });
    assert.deepEqual([res.status, res.body.data], [200, { enabled: true }]);
    assert.deepEqual(JSON.parse(audit[0]), { event: 'ZATCA_BUYER_RELAX', tenantId: TENANT, actorId: 'mgr-1', role: 'MANAGER', impersonated: true, enabled: true });
  } finally { await s.close(); }
});

test('PATCH: بلا صفّ إعدادات 409 COMPANY_SETTINGS_MISSING بلا إنشاء؛ وجسمٌ خاطئ 400 بلا كتابة', async () => {
  const none = fakeDb({ settings: null, admins: ADMINS });
  const audit: string[] = [];
  let s = await serve(none.db, () => ADMIN, { audit });
  try {
    const res = await s.call('PATCH', { enabled: true });
    assert.deepEqual([res.status, res.body.code, res.body.message], [409, 'COMPANY_SETTINGS_MISSING', 'احفظ إعدادات الشركة أولاً']);
    assert.deepEqual(audit, []);
  } finally { await s.close(); }
  const f = fakeDb({ admins: ADMINS });
  s = await serve(f.db, () => ADMIN);
  try {
    for (const body of [{}, { enabled: 'true' }, { enabled: 1 }, { enabled: null }]) {
      const res = await s.call('PATCH', body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  } finally { await s.close(); }
  assert.equal(f.calls.filter(c => c.startsWith('companySettings.updateMany')).length, 0);
});

test('سطر التدقيق: معرّفات مقصوصة وحالة منطقية فقط', () => {
  const line = JSON.parse(buyerRelaxAuditLine({ tenantId: 't'.repeat(300), actorId: '', role: 'ADMIN', impersonated: false, enabled: true }));
  assert.equal(line.tenantId.length, 128);
  assert.equal(line.actorId, null);
  assert.deepEqual(Object.keys(line), ['event', 'tenantId', 'actorId', 'role', 'impersonated', 'enabled']);
});

test('حرّاس نصّية: التركيب في company.ts بـBOM، وcompanySchema بلا المفتاح، والموجّه بحارس الصلاحية والرموز، وSELLER_SELECT يقرأ الإعداد', () => {
  const company = raw('routes/company.ts');
  assert.equal(company.charCodeAt(0), 0xfeff, 'company.ts يبدأ بـBOM');
  assert.ok(company.includes("import companyBuyerRelaxRouter from './companyBuyerRelax';"));
  assert.ok(company.includes("router.use('/buyer-relax', companyBuyerRelaxRouter);"));
  const schema = company.slice(company.indexOf('const companySchema'), company.indexOf('});', company.indexOf('const companySchema')));
  assert.ok(schema.length > 0);
  assert.doesNotMatch(schema, /buyerVatAddressRelaxed/);
  const route = raw('routes/companyBuyerRelax.ts');
  assert.ok(route.includes("deps.permission ?? requireAdminPermission('canManageCompanySettings')"));
  assert.ok(route.includes('router.use(requireAdmin);'));
  for (const code of ['BUYER_RELAX_ADMIN_ONLY', 'BUYER_RELAX_SCOPED', 'API_KEY_FORBIDDEN']) assert.ok(route.includes(`'${code}'`), code);
  // الإنتاج: النطاق من القاعدة، والقاعدة الحقيقية، وتدقيقٌ إلى السجلّ
  assert.match(route, /export default createBuyerRelaxRouter\(\{\s*db: prisma,\s*scopeEnabled: adminScopeEnabled,/);
  const store = raw('compliance/zatca/onboardingStore.ts');
  const sel = store.slice(store.indexOf('const SELLER_SELECT = {'), store.indexOf('} satisfies Prisma.CompanySettingsSelect;'));
  assert.match(sel, /buyerVatAddressRelaxed: true,/);
  const schemaPrisma = fs.readFileSync(path.join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8');
  assert.match(schemaPrisma, /\n {2}buyerVatAddressRelaxed {3}Boolean @default\(false\)\n/);
});
