// مصدر موقع العميل حين يحمل الطلب إحداثياتٍ صريحة ورابطاً معاً (تدقيق البصمة PIN-3، ٧ نوفمبر ٢٠٢٦ — «أصلح الخلل فقط»).
// معالجا العملاء الحقيقيّان فوق Prisma مزيّف وحلّال روابط مزيّف (بلا قاعدة ولا شبكة). يثبت:
//   • الإنشاء: lat وlng رقمان مع locationUrl ⇒ تُكتب الصريحة ولا يُحلّ الرابط أصلاً (التقاط الباب لا يمحوه مركز خريطة).
//   • ما سوى ذلك كما كان حرفياً: رابطٌ وحده، أو مع إحداثيةٍ واحدة، أو مع null، أو مع (0،0) placeholder ⇒ يُحلّ ويكتب فوقها؛
//     ورابطٌ لا يُحلّ يُتجاهل.
//   • التعديل كما كان: الرابط مقدَّمٌ مع أيّ إحداثيات (صفٌّ قديم في نموذج الإدارة لا يُسقط الرابط الملصوق)، وتعديلٌ بلا حقول
//     موقع لا يكتب lat/lng ولا يسأل عن الموقع المحفوظ.
//   • حارس PIN_LOCKED للمندوب المقيَّد كما هو.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

let calls: string[] = [];
let scripted: Record<string, (args: any) => unknown> = {};
const defaultFor = (method: string): unknown =>
  (method === 'findMany' ? [] : method === 'count' ? 0 : method === 'updateMany' || method === 'deleteMany' ? { count: 0 } : null);
const modelProxy = (model: string): unknown => new Proxy({}, {
  get: (_t, method: string) => async (args: unknown) => {
    calls.push(`${model}.${method}`);
    const fn = scripted[`${model}.${method}`];
    return fn ? fn(args) : defaultFor(method);
  },
});
const prismaFake: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prismaFake) : Promise.all(arg as Promise<unknown>[]));
    }
    if (key === '$queryRaw' || key === '$executeRaw') return async () => (key === '$queryRaw' ? [] : 0);
    if (key === 'then') return undefined;
    return modelProxy(key);
  },
});

const TENANT = 'T1';
type User = { id: string; role: string; tenantId: string };
const ADMIN: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT };
const REP: User = { id: 'rep-1', role: 'SALES_REP', tenantId: TENANT };
let currentUser: User = ADMIN;
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();

stub('config/database', { default: prismaFake });
stub('middleware/auth', {
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
  requireAdmin: pass, requireAccounting: pass,
  requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
  isOwnerSession: () => false,
  actorOf: (req: { user?: { id?: string } }) => req.user?.id ?? '',
});
// حلّال الروابط بلا شبكة: «مركز الخريطة» المُزاح لكل رابطٍ إلا ما فيه «broken»
const MAP_CENTER = { lat: 24.7200, lng: 46.6800 };
let resolved: string[] = [];
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realGeo = require('../services/geoLink') as Record<string, unknown>;
stub('services/geoLink', {
  ...realGeo,
  resolveLocationUrl: async (u: string) => { resolved.push(u); return u.includes('broken') ? null : { ...MAP_CENTER }; },
});

/* eslint-disable @typescript-eslint/no-var-requires */
const customersModule = require('../routes/customers') as typeof import('../routes/customers');
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
const { explicitPinWins } = require('../services/customerPinSource') as typeof import('../services/customerPinSource');
/* eslint-enable @typescript-eslint/no-var-requires */

let server: { port: number; close: () => Promise<void> } | null = null;
async function startServer() {
  if (server) return server;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/customers', customersModule.default);
  app.use(errorHandler);
  const s = http.createServer(app);
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()); }) };
  return server;
}
after(async () => { await server?.close(); server = null; });

type Reply = { status: number; body: Record<string, any> };
async function call(method: 'POST' | 'PUT', url: string, body: unknown): Promise<Reply> {
  const s = await startServer();
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: s.port, method, path: url, agent: false,
      headers: { connection: 'close', 'Content-Type': 'application/json', 'Content-Length': String(payload.length) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : {} }); });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const STORED = { lat: 24.7136, lng: 46.6753 };
const DOOR = { lat: 24.71362, lng: 46.67531 };
const URL_ = 'https://maps.app.goo.gl/abc123';

/** عميلٌ واحد c1 بموقعه المحفوظ — يسجّل ما يُكتب وأسئلة الموقع المحفوظ */
function world(o: { user?: User; pinLocked?: boolean; stored?: { lat: number | null; lng: number | null } } = {}) {
  currentUser = o.user ?? ADMIN;
  calls = []; resolved = [];
  const written: Record<string, unknown>[] = [];
  const pinQueries: unknown[] = [];
  const stored = o.stored ?? STORED;
  scripted = {
    'salesRep.findUnique': () => ({ canAddCustomer: true, canEditCustomer: true, requireCustomerProximity: o.pinLocked === true }),
    'admin.findUnique': () => ({ scopeEnabled: false, isActive: true }),
    'customer.findFirst': (args) => {
      if (args?.select?.lat) { pinQueries.push(args); return args.where?.id === 'c1' ? { ...stored } : null; }
      return args?.where?.id === 'c1' ? { id: 'c1', phone: '0500000000' } : null;
    },
    'customer.create': (args) => { written.push(args.data); return { id: 'c-new', ...args.data }; },
    'customer.update': (args) => { written.push(args.data); return { id: 'c1', ...args.data }; },
  };
  return { written, pinQueries };
}

// ═══ الدالة الصرفة ═══

test('explicitPinWins: الإحداثيتان رقمان معاً ⇒ تُقدَّمان، و(0،0) معاً خانةٌ فارغة لا التقاط', () => {
  assert.equal(explicitPinWins({ lat: 24.7, lng: 46.6 }), true);
  assert.equal(explicitPinWins({ lat: 0.5, lng: 0 }), true, 'صفرٌ واحد رقمٌ صريح');
  assert.equal(explicitPinWins({ lat: 0, lng: 46.6 }), true);
  assert.equal(explicitPinWins({ lat: 0, lng: 0 }), false, '(0،0) placeholder: الرابط يُحلّ كما كان');
  assert.equal(explicitPinWins({ lat: 24.7 }), false, 'إحداثيةٌ واحدة: كما كان');
  assert.equal(explicitPinWins({ lng: 46.6 }), false);
  assert.equal(explicitPinWins({ lat: null, lng: null }), false, 'null: كما كان');
  assert.equal(explicitPinWins({ lat: 24.7, lng: null }), false);
  assert.equal(explicitPinWins({}), false);
  assert.equal(explicitPinWins({ lat: Number.NaN, lng: 46.6 }), false);
});

// ═══ الإنشاء ═══

test('الإنشاء: التقاط الباب (lat+lng) مع رابطٍ ملصوق ⇒ يُكتب الالتقاط ولا يُحلّ الرابط', async () => {
  for (const user of [REP, ADMIN]) {
    const w = world({ user });
    const r = await call('POST', '/api/customers', { name: 'بقالة', ...DOOR, locationUrl: URL_ });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(w.written[0].lat, DOOR.lat);
    assert.equal(w.written[0].lng, DOOR.lng);
    assert.equal('locationUrl' in w.written[0], false, 'الرابط لا يُكتب عموداً');
    assert.deepEqual(resolved, [], 'لا يُحلّ الرابط أصلاً');
  }
});

test('الإنشاء: الرفع المؤجَّل من صندوق المندوب (clientRef) بالالتقاط والرابط معاً ⇒ الالتقاط', async () => {
  const w = world({ user: REP });
  const r = await call('POST', '/api/customers', { name: 'بقالة', ...DOOR, locationUrl: URL_, clientRef: '6f1c2a9e-3b7d-4c2e-9a51-2f0e8d7c4b11' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(w.written[0].lat, DOOR.lat);
  assert.equal(w.written[0].lng, DOOR.lng);
  assert.deepEqual(resolved, []);
});

test('الإنشاء كما كان: رابطٌ وحده، أو مع إحداثيةٍ واحدة، أو مع null ⇒ يُحلّ ويكتب فوقها؛ ورابطٌ لا يُحلّ يُتجاهل', async () => {
  for (const extra of [{}, { lat: DOOR.lat }, { lng: DOOR.lng }, { lat: null, lng: null }, { lat: 0, lng: 0 }]) {
    const w = world();
    const r = await call('POST', '/api/customers', { name: 'بقالة', ...extra, locationUrl: URL_ });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(resolved, [URL_], JSON.stringify(extra));
    assert.equal(w.written[0].lat, MAP_CENTER.lat, JSON.stringify(extra));
    assert.equal(w.written[0].lng, MAP_CENTER.lng, JSON.stringify(extra));
  }
  // رابطٌ لا يُحلّ: الإحداثية المفردة تبقى كما أُرسلت (كما كان)
  const b = world();
  assert.equal((await call('POST', '/api/customers', { name: 'بقالة', lat: DOOR.lat, locationUrl: 'https://maps.google.com/broken' })).status, 201);
  assert.equal(b.written[0].lat, DOOR.lat);
  assert.equal(b.written[0].lng, undefined);
  // الإحداثيات وحدها كما كانت
  const c = world();
  assert.equal((await call('POST', '/api/customers', { name: 'بقالة', ...DOOR })).status, 201);
  assert.equal(c.written[0].lat, DOOR.lat);
  assert.deepEqual(resolved, []);
});

// ═══ التعديل ═══

test('التعديل كما كان: الرابط مع أيّ إحداثيات ⇒ يُحلّ ويكتب فوقها (صفٌّ قديم في نموذج الإدارة لا يُسقط الرابط الملصوق)', async () => {
  // صفّ الإدارة القديم (أعاد المندوب الالتقاط بعد تحميل القائمة) أو صدى المحفوظ نفسه: الرابط الملصوق هو التعديل المقصود
  for (const coords of [DOOR, STORED]) {
    const w = world();
    const r = await call('PUT', '/api/customers/c1', { name: 'بقالة', phone: '0500000000', ...coords, locationUrl: URL_ });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(resolved, [URL_]);
    assert.equal(w.written[0].lat, MAP_CENTER.lat);
    assert.equal(w.written[0].lng, MAP_CENTER.lng);
    assert.equal(w.pinQueries.length, 0, 'لا سؤال عن الموقع المحفوظ');
  }
  // ورابطٌ لا يُحلّ: تبقى الإحداثيات المرسلة كما كان
  const b = world();
  await call('PUT', '/api/customers/c1', { name: 'بقالة', ...STORED, locationUrl: 'https://maps.google.com/broken' });
  assert.equal(b.written[0].lat, STORED.lat);
  assert.equal(b.written[0].lng, STORED.lng);
});

test('التعديل كما كان: رابطٌ وحده أو مع null ⇒ يُحلّ، بلا سؤالٍ عن المحفوظ', async () => {
  for (const extra of [{}, { lat: null, lng: null }, { lat: DOOR.lat }]) {
    const w = world();
    const r = await call('PUT', '/api/customers/c1', { name: 'بقالة', ...extra, locationUrl: URL_ });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(resolved, [URL_], JSON.stringify(extra));
    assert.equal(w.written[0].lat, MAP_CENTER.lat);
    assert.equal(w.pinQueries.length, 0);
  }
});

test('التعديل بلا حقول موقع لا يمسّ الدبّوس: لا lat/lng في الكتابة ولا حلّ ولا سؤال عن المحفوظ', async () => {
  for (const user of [ADMIN, REP]) {
    const w = world({ user });
    const r = await call('PUT', '/api/customers/c1', { name: 'اسم جديد', address: 'شارع الملك فهد', city: 'الرياض' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal('lat' in w.written[0], false);
    assert.equal('lng' in w.written[0], false);
    assert.deepEqual(resolved, []);
    assert.equal(w.pinQueries.length, 0);
    // والرابط الفارغ (خانة نموذج الإدارة بلا لصق) كذلك
    const e = world({ user });
    await call('PUT', '/api/customers/c1', { name: 'اسم جديد', locationUrl: '' });
    assert.equal('lat' in e.written[0], false);
    assert.deepEqual(resolved, []);
  }
});

test('حارس PIN_LOCKED للمندوب المقيَّد كما هو: الإحداثيات أو الرابط ⇒ 403 بلا كتابة، وبلاهما يمرّ', async () => {
  for (const body of [{ ...DOOR }, { locationUrl: URL_ }, { ...DOOR, locationUrl: URL_ }]) {
    const w = world({ user: REP, pinLocked: true });
    const r = await call('PUT', '/api/customers/c1', { name: 'بقالة', ...body });
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.equal(r.body.code, 'PIN_LOCKED');
    assert.equal(w.written.length, 0);
    assert.deepEqual(resolved, []);
  }
  const ok = world({ user: REP, pinLocked: true });
  assert.equal((await call('PUT', '/api/customers/c1', { name: 'بقالة' })).status, 200);
  assert.equal(ok.written.length, 1);
});
