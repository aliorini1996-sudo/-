// «الربط البرمجي API» (أمر المالك، ١١ أكتوبر ٢٠٢٦): مفتاحٌ لكل شركة «حرّ يستخدمونه فيما يريدون» —
// يُصادِق على مسارات اللوحة نفسها بهوية من أصدره، ولا يبلغ ما يملك به الحسابَ نفسه.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-api-keys';
const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// —— قاعدة مزيّفة: صفّ مفتاح واحد يُعدَّل لكل حالة ——
type KeyRow = {
  id: string; tenantId: string; readOnly: boolean; revokedAt: Date | null; lastUsedAt: Date | null; keyHash: string; createdBy?: string | null;
  admin: { id: string; name: string; role: string; isActive: boolean; tenantId: string };
  tenant: { apiEnabled: boolean; isActive: boolean; subscriptionEndsAt: Date | null };
};
let keyRow: KeyRow | null = null;
let touched = 0;
const apiKey = {
  async findUnique(args: { where: { keyHash?: string } }) { return keyRow && args.where.keyHash === keyRow.keyHash ? keyRow : null; },
  async updateMany() { touched += 1; return { count: 1 }; },
};
const admin = {
  async findUnique() { return { isActive: true, lastSeenAt: new Date() }; },
  async updateMany() { return { count: 0 }; },
};
stub('config/database', { default: { apiKey, admin } });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const keys = require('../services/apiKeys') as typeof import('../services/apiKeys');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { authenticate } = require('../middleware/auth') as typeof import('../middleware/auth');

function mockRes() {
  const res = {
    statusCode: 200, body: null as Record<string, unknown> | null, headers: {} as Record<string, string>,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b as Record<string, unknown>; return this; },
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; },
  };
  return res;
}
async function run(opts: { auth?: string; xKey?: string; method?: string; url?: string }) {
  const req: Record<string, unknown> = {
    headers: { ...(opts.auth ? { authorization: opts.auth } : {}), ...(opts.xKey ? { 'x-api-key': opts.xKey } : {}) },
    method: opts.method ?? 'GET', originalUrl: opts.url ?? '/api/customers', url: opts.url ?? '/api/customers',
  };
  const res = mockRes();
  let nextCalled = false;
  await authenticate(req as never, res as never, (e?: unknown) => { if (e) throw e; nextCalled = true; });
  return { req, res, nextCalled };
}

const fresh = keys.generateApiKey();
const freshRow = (over: Partial<KeyRow> = {}): KeyRow => ({
  id: 'k1', tenantId: 't1', readOnly: false, revokedAt: null, lastUsedAt: null, keyHash: fresh.hash,
  admin: { id: 'a1', name: 'مدير', role: 'ADMIN', isActive: true, tenantId: 't1' },
  tenant: { apiEnabled: true, isActive: true, subscriptionEndsAt: null },
  ...over,
});

test('المفتاح: بادئة fsk_ و٢٤٠ بتاً عشوائياً، والمخزَّن بصمته SHA-256 لا نصّه، والظاهر ١٢ محرفاً', () => {
  assert.match(fresh.key, /^fsk_[A-Za-z0-9_-]{40}$/);
  assert.equal(fresh.prefix, fresh.key.slice(0, 12));
  assert.match(fresh.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(fresh.hash, fresh.key);
  assert.equal(keys.hashApiKey(fresh.key), fresh.hash);
  assert.notEqual(keys.generateApiKey().key, fresh.key);
});

test('يُقرأ من Authorization: Bearer أو X-API-Key — وتوكن الجلسة (JWT) لا يُحسب مفتاحاً', () => {
  assert.equal(keys.apiKeyFromHeaders({ authorization: `Bearer ${fresh.key}` }), fresh.key);
  assert.equal(keys.apiKeyFromHeaders({ 'x-api-key': fresh.key }), fresh.key);
  assert.equal(keys.apiKeyFromHeaders({ authorization: 'Bearer eyJhbGciOi.x.y' }), null);
  assert.equal(keys.apiKeyFromHeaders({}), null);
});

test('المسارات الممنوعة على المفتاح — ولا يُتحايل عليها بحالة الأحرف أو الترميز أو الشرطات', () => {
  for (const p of ['/auth/me', '/AUTH/me', '/Auth', '/api-keys', '/api-keys/x/revoke', '//auth/login', '/%61uth/me', '/company-users/1', '/tenants', '/payments/x', '/finance/']) {
    assert.ok(keys.apiKeyRouteDecision('GET', p, false), `غير ممنوع: ${p}`);
  }
  for (const p of ['/customers', '/invoices/1', '/products?x=1', '/v1/sync/customers', '/company', '/authors-like-but-not']) {
    assert.equal(keys.apiKeyRouteDecision('GET', p, false), null, `ممنوع خطأً: ${p}`);
  }
  assert.equal(keys.pathAfterApi('/api/Customers/?a=1'), '/customers');
  assert.equal(keys.pathAfterApi('/API/auth/me'), '/auth/me');
});

test('«قراءة فقط» لا تكتب: GET/HEAD وحدهما', () => {
  assert.equal(keys.apiKeyRouteDecision('GET', '/customers', true), null);
  assert.equal(keys.apiKeyRouteDecision('HEAD', '/customers', true), null);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.ok(keys.apiKeyRouteDecision(m, '/customers', true), m);
  assert.equal(keys.apiKeyRouteDecision('POST', '/customers', false), null);
});

test('حدّ الدقيقة لكل مفتاح: ١٢٠ ثم 429 بموعد الفتح، ونافذة جديدة بعد الدقيقة', () => {
  keys._resetApiKeyWindows();
  const t0 = 1_000_000;
  for (let i = 0; i < keys.API_KEY_RATE_PER_MINUTE; i++) assert.equal(keys.takeApiKeyToken('k', t0 + i).ok, true);
  const over = keys.takeApiKeyToken('k', t0 + 30_000);
  assert.equal(over.ok, false);
  assert.ok(!over.ok && over.retryAfterSec >= 1 && over.retryAfterSec <= 60);
  assert.equal(keys.takeApiKeyToken('k', t0 + 60_000).ok, true);
  assert.equal(keys.takeApiKeyToken('other', t0).ok, true, 'لكل مفتاح عدّاده');
});

test('اشتراك الشركة: موقوف أو منتهٍ يمنع المفتاح كما يمنع الدخول', () => {
  assert.equal(keys.tenantBlockedReason({ isActive: true, subscriptionEndsAt: null }), null);
  assert.ok(keys.tenantBlockedReason({ isActive: false, subscriptionEndsAt: null }));
  assert.ok(keys.tenantBlockedReason({ isActive: true, subscriptionEndsAt: new Date(Date.now() - 1000) }));
  assert.equal(keys.tenantBlockedReason({ isActive: true, subscriptionEndsAt: new Date(Date.now() + 86_400_000) }), null);
});

test('authenticate بمفتاح صالح: الطلب طلبُ صاحبه بدوره وشركته — بلا انتحال مالك — ورؤوس الحدّ', async () => {
  keys._resetApiKeyWindows(); keyRow = freshRow(); touched = 0;
  const { req, res, nextCalled } = await run({ auth: `Bearer ${fresh.key}` });
  assert.equal(nextCalled, true);
  const u = req.user as Record<string, unknown>;
  assert.deepEqual(u, { id: 'a1', role: 'ADMIN', name: 'مدير', tenantId: 't1', apiKeyId: 'k1' });
  assert.equal(u.impersonated, undefined, 'المفتاح لا يرث تجاوزات جلسة المالك');
  assert.equal(res.headers['x-ratelimit-limit'], '120');
  assert.equal(touched, 1, 'آخر استعمال يُلمس');
  const viaHeader = await run({ xKey: fresh.key });
  assert.equal(viaHeader.nextCalled, true);
});

test('authenticate يردّ: مفتاح مجهول أو ملغى أو مشوّه 401، والميزة مطفأة أو الاشتراك موقوف 403، وصاحبه معطّل 401', async () => {
  keys._resetApiKeyWindows();
  keyRow = freshRow();
  const unknownKey = keys.generateApiKey().key;
  let r = await run({ auth: `Bearer ${unknownKey}` });
  assert.equal(r.res.statusCode, 401); assert.equal(r.nextCalled, false);
  r = await run({ auth: 'Bearer fsk_short' });
  assert.equal(r.res.statusCode, 401);

  keyRow = freshRow({ revokedAt: new Date() });
  r = await run({ auth: `Bearer ${fresh.key}` });
  assert.equal(r.res.statusCode, 401); assert.equal(r.res.body!.code, 'API_KEY_INVALID');

  keyRow = freshRow({ tenant: { apiEnabled: false, isActive: true, subscriptionEndsAt: null } });
  r = await run({ auth: `Bearer ${fresh.key}` });
  assert.equal(r.res.statusCode, 403); assert.equal(r.res.body!.code, 'API_NOT_ALLOWED');

  keyRow = freshRow({ tenant: { apiEnabled: true, isActive: false, subscriptionEndsAt: null } });
  r = await run({ auth: `Bearer ${fresh.key}` });
  assert.equal(r.res.statusCode, 403); assert.equal(r.res.body!.code, 'TENANT_BLOCKED');

  keyRow = freshRow({ admin: { id: 'a1', name: 'x', role: 'ADMIN', isActive: false, tenantId: 't1' } });
  r = await run({ auth: `Bearer ${fresh.key}` });
  assert.equal(r.res.statusCode, 401); assert.equal(r.res.body!.code, 'API_KEY_OWNER_INACTIVE');

  // صاحبٌ نُقل لشركة أخرى (أو صفٌّ عابر للشركات) لا يُقبل
  keyRow = freshRow({ admin: { id: 'a1', name: 'x', role: 'ADMIN', isActive: true, tenantId: 't2' } });
  r = await run({ auth: `Bearer ${fresh.key}` });
  assert.equal(r.res.statusCode, 401);
});

test('authenticate بمفتاح: المسار الممنوع و«قراءة فقط» تكتب ⇒ 403 قبل أي موجّه', async () => {
  keys._resetApiKeyWindows();
  keyRow = freshRow();
  let r = await run({ auth: `Bearer ${fresh.key}`, url: '/api/auth/me' });
  assert.equal(r.res.statusCode, 403); assert.equal(r.res.body!.code, 'API_KEY_FORBIDDEN');
  r = await run({ auth: `Bearer ${fresh.key}`, url: '/api/API-KEYS', method: 'POST' });
  assert.equal(r.res.statusCode, 403);
  keyRow = freshRow({ readOnly: true });
  r = await run({ auth: `Bearer ${fresh.key}`, url: '/api/customers', method: 'POST' });
  assert.equal(r.res.statusCode, 403);
  r = await run({ auth: `Bearer ${fresh.key}`, url: '/api/customers', method: 'GET' });
  assert.equal(r.nextCalled, true);
});

test('authenticate بمفتاح: تجاوز ١٢٠ في الدقيقة ⇒ 429 مع Retry-After', async () => {
  keys._resetApiKeyWindows();
  keyRow = freshRow();
  for (let i = 0; i < keys.API_KEY_RATE_PER_MINUTE; i++) await run({ auth: `Bearer ${fresh.key}` });
  const r = await run({ auth: `Bearer ${fresh.key}` });
  assert.equal(r.res.statusCode, 429);
  assert.ok(Number(r.res.headers['retry-after']) >= 1);
});

test('جلسة اللوحة (JWT) كما كانت: المفتاح لا يغيّر مسارها', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jwt = require('jsonwebtoken');
  const token = jwt.sign({ id: 'a9', role: 'ADMIN', name: 'م', tenantId: 't1' }, process.env.JWT_SECRET);
  const r = await run({ auth: `Bearer ${token}` });
  assert.equal(r.nextCalled, true);
  assert.equal((r.req.user as Record<string, unknown>).apiKeyId, undefined);
});

// —— حرّاس ثابتة على المخطط والتركيب ——
const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');

test('المخطط: جدول api_keys جديد ببصمة فريدة، وعَلَم الشركة مطفأ افتراضاً — إضافيّ خالص على db push', () => {
  const s = read('prisma', 'schema.prisma');
  const model = s.slice(s.indexOf('model ApiKey {'), s.indexOf('\n}', s.indexOf('model ApiKey {')));
  assert.match(model, /keyHash\s+String\s+@unique/);
  assert.match(model, /readOnly\s+Boolean\s+@default\(false\)/);
  assert.match(model, /onDelete: Cascade/);
  assert.doesNotMatch(model, /\bkey\s+String\b/, 'لا عمود للمفتاح نفسه');
  assert.match(s, /apiEnabled\s+Boolean\s+@default\(false\)/);
});

test('العَلَم في التحديث وحده (لا في الإنشاء)، ويُكشف للواجهة بـ === true', () => {
  const t = read('src', 'routes', 'tenants.ts');
  const create = t.slice(t.indexOf('const createTenantSchema'), t.indexOf('const updateTenantSchema'));
  const update = t.slice(t.indexOf('const updateTenantSchema'), t.indexOf('});', t.indexOf('const updateTenantSchema')));
  assert.doesNotMatch(create, /apiEnabled/);
  assert.match(update, /apiEnabled: z\.boolean\(\)\.optional\(\)/);
  assert.match(read('src', 'routes', 'company.ts'), /apiEnabled: tenant\?\.apiEnabled === true/);
});

test('موجّه المفاتيح: الصلاحية ثم «مدير الشركة وحده» قبل أي مسار، والعَلَم على الإصدار وحده، والتركيب في index', () => {
  const r = read('src', 'routes', 'apiKeys.ts');
  const firstRoute = r.search(/router\.(get|post)\(/);
  assert.ok(r.indexOf("router.use(authenticate, requireAdmin, requireAdminPermission('canManageCompanySettings'))") < firstRoute);
  // العرض والإلغاء والإصدار للمدير (الدور من القاعدة) — لا لمدير مبيعات أو محاسب يقطع مزامنة الشركة
  assert.ok(r.indexOf("me.role !== 'ADMIN' || me.scopeEnabled") > 0 && r.indexOf("me.role !== 'ADMIN' || me.scopeEnabled") < firstRoute);
  // العَلَم يمنع الإصدار وحده: إطفاؤه يعلّق المفاتيح ولا يمنع الشركة من إلغائها
  assert.match(r, /router\.post\('\/', requireApiEnabled,/);
  assert.match(r, /if \(t\?\.apiEnabled !== true\)/);
  assert.doesNotMatch(r, /router\.post\('\/:id\/revoke', requireApiEnabled/);
  assert.match(r, /createdBy: actorOf\(req\)/, 'جلسة المالك تُوسم OWNER:');
  assert.match(r, /if \(owner\.role !== 'ADMIN'\)/, 'المدير وحده يصدر — والدور من القاعدة');
  assert.match(r, /if \(owner\.scopeEnabled\)/, 'المقيَّد النطاق لا يصدر');
  assert.match(r, /const where = \{ id: String\(req\.params\.id\), tenantId: tid, revokedAt: null \};/, 'الإلغاء داخل الشركة وحدها');
  assert.match(r, /forgetLiveKey\(target\.keyHash\)/, 'الإلغاء يُخرج المفتاح من ذاكرة الحيّة فوراً');
  const idx = read('src', 'index.ts');
  assert.match(idx, /app\.use\('\/api\/api-keys', apiKeysRouter\)/);
  assert.match(idx, /app\.use\('\/api\/v1', apiV1Router\)/);
  assert.ok(keys.API_KEY_DENIED_PREFIXES.includes('/api-keys'), 'مفتاحٌ لا يلد مفتاحاً');
});

test('الحدّ العام: طلب المفتاح الحيّ يُعدّ في دلو مفتاحه لا يُعفى، والمجهول تحت حدّ IP — ولا قاعدة في الحدّ', () => {
  const rl = read('src', 'middleware', 'rateLimits.ts');
  const block = rl.slice(rl.indexOf('function liveKeyHashOf'), rl.indexOf('});', rl.indexOf('export const apiLimiter')));
  assert.doesNotMatch(block, /skip:/, 'لا إعفاء من العدّ — المسارات العامة والمرفوضة تُحسب على المفتاح');
  assert.match(block, /keyGenerator: \(req\) =>/);
  assert.match(block, /return h \? `key:\$\{h\}` : \(req\.ip \?\? ''\);/);
  assert.doesNotMatch(block, /prisma\./, 'لا استعلام في الحدّ: سيل مفاتيح عشوائية لا يصير سيل استعلامات');
  // الحيّ = أجازه authenticate للتوّ (بلا قاعدة)، والإلغاء يمحوه فوراً
  keys._resetApiKeyWindows();
  const h = keys.generateApiKey().hash;
  assert.equal(keys.isLiveKeyHash(h), false);
  keys.markLiveKey(h);
  assert.equal(keys.isLiveKeyHash(h), true);
  keys.forgetLiveKey(h);
  assert.equal(keys.isLiveKeyHash(h), false);
  keys.markLiveKey(h, 0);
  assert.equal(keys.isLiveKeyHash(h, 61_000), false, 'تسقط بمرور دقيقة');
});

test('سطر الطلب برابطٍ مطلق (GET http://host/api/auth/me) يُردّ 400 — والحكم على المسار الذي طابقه Express', async () => {
  keys._resetApiKeyWindows(); keyRow = freshRow();
  const r = await run({ auth: `Bearer ${fresh.key}`, url: 'http://x/api/auth/me' });
  assert.equal(r.res.statusCode, 400); assert.equal(r.nextCalled, false);
  // baseUrl + path هما ما يوجّه Express — نصّ originalUrl البريء لا يُنقذ مساراً ممنوعاً طابقه
  const req: Record<string, unknown> = { headers: { authorization: `Bearer ${fresh.key}` }, method: 'GET', originalUrl: '/api/customers', url: '/me', baseUrl: '/api/auth', path: '/me' };
  const res = mockRes();
  await authenticate(req as never, res as never, () => { throw new Error('مرّ'); });
  assert.equal(res.statusCode, 403);
  assert.ok(keys.API_KEY_DENIED_PREFIXES.includes('/live'), 'بثّ اللوحة اللحظي ممنوع على المفتاح');
});

test('الطلب المرفوض يُحسب على حدّ مفتاحه — تكرار المسار الممنوع لا يكون بلا سقف', async () => {
  keys._resetApiKeyWindows(); keyRow = freshRow();
  for (let i = 0; i < keys.API_KEY_RATE_PER_MINUTE; i++) {
    const r = await run({ auth: `Bearer ${fresh.key}`, url: '/api/tenants' });
    assert.equal(r.res.statusCode, 403);
  }
  const over = await run({ auth: `Bearer ${fresh.key}`, url: '/api/tenants' });
  assert.equal(over.res.statusCode, 429);
});

test('صفحة قوائم اللوحة للمفتاح ٢٠٠ على الأكثر — والمزامنة /v1 بحدودها', async () => {
  keys._resetApiKeyWindows(); keyRow = freshRow();
  const mk = (url: string, limit: unknown) => ({ headers: { authorization: `Bearer ${fresh.key}` }, method: 'GET', originalUrl: url, url, query: { limit } as Record<string, unknown> });
  for (const [limit, want] of [['1000000', '200'], ['50', '50'], ['abc', '200']] as const) {
    const req = mk('/api/invoices', limit);
    await authenticate(req as never, mockRes() as never, () => undefined);
    assert.equal(req.query.limit, want, String(limit));
  }
  const v1 = mk('/api/v1/sync/invoices', '500');
  await authenticate(v1 as never, mockRes() as never, () => undefined);
  assert.equal(v1.query.limit, '500');
});

test('مفتاحٌ أصدره الدعم الفني: أفعاله تُسجَّل OWNER: — بلا تجاوزات جلسة المالك', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const auth = require('../middleware/auth') as typeof import('../middleware/auth');
  keys._resetApiKeyWindows(); keyRow = { ...freshRow(), createdBy: 'OWNER:a1' } as KeyRow;
  const { req } = await run({ auth: `Bearer ${fresh.key}` });
  assert.equal(auth.actorOf(req as never), 'OWNER:a1');
  assert.equal(auth.isOwnerSession(req as never), false, 'لا يرث تجاوزات الانتحال');
  keyRow = freshRow();
  const plain = await run({ auth: `Bearer ${fresh.key}` });
  assert.equal(auth.actorOf(plain.req as never), 'a1');
});

test('خطأ الخادم لطلب المفتاح رسالةٌ عامة — والتفصيل في سجلّ الخادم', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
  const orig = console.error; console.error = () => undefined;
  try {
    const keyRes = mockRes();
    errorHandler(new Error('Invalid prisma.invoice.findMany() invocation: secret detail'), { user: { id: 'a', apiKeyId: 'k' } } as never, keyRes as never, () => undefined);
    assert.equal(keyRes.statusCode, 500); assert.equal(keyRes.body!.message, 'خطأ في الخادم');
    const sessRes = mockRes();
    errorHandler(new Error('تفصيل'), { user: { id: 'a' } } as never, sessRes as never, () => undefined);
    assert.equal(sessRes.body!.message, 'تفصيل', 'جلسة اللوحة كما كانت');
  } finally { console.error = orig; }
});
