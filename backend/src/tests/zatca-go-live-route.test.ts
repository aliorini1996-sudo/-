// ZATCA المرحلة الثانية (Z5.8) — اختبارات مسار التفعيل عبر الموجّه الحقيقي (مخزن ذاكرة Z4 + مخزن تفعيل + وحدة مفعّلة).
// يثبت: التسليح، الجاهزية، التفعيل (نجاحاً ورفضاً بكلّ سبب)، ومراجعة الانتقال (D11) قبولاً ورفضاً وعزلاً — على 127.0.0.1.
import { guardHits } from '../compliance/zatca/__fixtures__/z3-netguard';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { NextFunction, Response } from 'express';
import { ACTOR, TENANT, activeUnit, harness } from '../compliance/zatca/__fixtures__/z4-harness';
import { memoryGoLiveStore, type MemoryGoLiveStore } from '../compliance/zatca/goLiveStore';
import type { RepSyncRow } from '../compliance/zatca/goLive';
import { createZatcaRouter, zatcaEnvConfig, zatcaErrorGuard } from '../routes/zatca';
import { AuthRequest } from '../types';

after(() => { assert.equal(guardHits(), 0, 'محاولة شبكة حقيقية'); });

const CONFIRM = 'تفعيل';
type Body = Record<string, unknown>;
type Reply = { status: number; body: Body };

interface RigOpts {
  goLiveEnv?: string;
  store?: MemoryGoLiveStore;
  role?: string; // دور الحساب من القاعدة (loadAdmin)
  countryCode?: string;
}

async function rig(o: RigOpts = {}) {
  const h = harness({ env: 'production', productionBackend: true, settings: o.countryCode ? { countryCode: o.countryCode } : {} });
  const store = o.store ?? memoryGoLiveStore();
  const ADMIN = { id: ACTOR, role: 'ADMIN', name: 'a', tenantId: TENANT };
  const router = createZatcaRouter({
    authenticate: (req: AuthRequest, _res: Response, next: NextFunction) => { req.user = ADMIN as AuthRequest['user']; next(); },
    loadAdmin: async () => ({ isActive: true, role: o.role ?? 'ADMIN', tenantId: TENANT, canManageCompanySettings: true }),
    isScopeRestricted: async () => false,
    loadTenantFlag: async () => true,
    store: h.store,
    writeSeller: async () => true,
    loadKeyring: () => h.keyring,
    clientFactory: h.client,
    now: h.clock.now,
    config: zatcaEnvConfig({ NODE_ENV: 'production', ZATCA_ALLOWED_ENVS: 'production' }),
    log: () => {},
    audit: () => {},
    goLiveStore: store,
    goLiveEnv: { ZATCA_GO_LIVE: o.goLiveEnv ?? 'off' },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/zatca', router, zatcaErrorGuard);
  const server = http.createServer(app);
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  const req = (method: string, url: string, body?: Body): Promise<Reply> => new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    // agent:false + Connection: close ⇒ لا مقبس keep-alive يبقى مفتوحاً فيؤخّر server.close
    const r = http.request({ host: '127.0.0.1', port, path: `/api/zatca${url}`, method, agent: false, headers: { connection: 'close', 'content-type': 'application/json', ...(payload ? { 'content-length': payload.length } : {}) } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
  return {
    h, store,
    get: (url: string) => req('GET', url),
    post: (url: string, body?: Body) => req('POST', url, body),
    close: async () => { await router.idle(); server.closeAllConnections?.(); await new Promise(r => server.close(r)); },
  };
}

/** مندوب مُزامَن: نشط، ظهر الآن، وأبلغ صندوقاً فارغاً بعد التسليح. */
function syncedRep(now: number, armed: number, over: Partial<RepSyncRow> = {}): RepSyncRow {
  return {
    id: 'r1', name: 'مندوب', isActive: true, lastSeenAt: new Date(now),
    outboxPending: 0, outboxTaxPending: 0, outboxReportedAt: new Date(armed + 1000), ...over,
  };
}

// ─── التسليح والجاهزية ───

test('غير مُسلَّح ⇒ overview.goLiveAvailable = false', async () => {
  const r = await rig({ goLiveEnv: 'on' });
  try {
    await activeUnit(r.h);
    const res = await r.get('/overview');
    assert.equal(res.status, 200);
    assert.equal((res.body.data as Body).goLiveAvailable, false);
    assert.equal((res.body.data as Body).phase2StartedAt, null);
  } finally { await r.close(); }
});

test('التسليح يضبط armedAt مرّة واحدة (idempotent)', async () => {
  const r = await rig({ goLiveEnv: 'on' });
  try {
    const a = await r.post('/go-live/arm');
    assert.equal(a.status, 200);
    const armedAt = (a.body.data as Body).armedAt as string;
    assert.ok(armedAt, 'armedAt غير مضبوط');
    assert.equal((a.body.data as Body).applied, true);
    const b = await r.post('/go-live/arm');
    assert.equal((b.body.data as Body).applied, false);
    assert.equal((b.body.data as Body).armedAt, armedAt, 'التسليح تغيّر عند الإعادة');
  } finally { await r.close(); }
});

test('الجاهزية تُدرج المناديب غير المزامنين بالاسم', async () => {
  const now = new Date('2026-09-16T08:00:00.000Z').getTime();
  const armed = now - 60_000;
  const store = memoryGoLiveStore({
    armed: { [TENANT]: new Date(armed) },
    reps: { [TENANT]: [syncedRep(now, armed, { id: 'ok', name: 'سالم' }), syncedRep(now, armed, { id: 'busy', name: 'خالد', outboxTaxPending: 3 })] },
  });
  const r = await rig({ goLiveEnv: 'on', store });
  try {
    await activeUnit(r.h);
    const res = await r.get('/go-live/readiness');
    assert.equal(res.status, 200);
    const data = res.body.data as Body;
    assert.equal((data.checks as Body).repsSynced, false);
    const unsynced = (data.reps as Body).unsynced as Body[];
    assert.equal(unsynced.length, 1);
    assert.equal(unsynced[0].name, 'خالد');
  } finally { await r.close(); }
});

test('التسليح مرفوض: علم البيئة مطفأ ⇒ 409 GO_LIVE_UNAVAILABLE ولا تسليح (نقد 2/4)', async () => {
  const r = await rig({ goLiveEnv: 'off' });
  try {
    const a = await r.post('/go-live/arm');
    assert.equal(a.status, 409);
    assert.equal(a.body.code, 'GO_LIVE_UNAVAILABLE');
    assert.equal(await r.store.loadArmedAt(TENANT), null, 'سُلِّحت رغم إطفاء علم البيئة');
  } finally { await r.close(); }
});

test('التسليح مرفوض: القائمة لا تشمل الشركة ⇒ 409 (نقد 2/4)', async () => {
  const r = await rig({ goLiveEnv: 'allowlist:other-tenant' });
  try {
    const a = await r.post('/go-live/arm');
    assert.equal(a.status, 409);
    assert.equal(a.body.code, 'GO_LIVE_UNAVAILABLE');
    assert.equal(await r.store.loadArmedAt(TENANT), null);
  } finally { await r.close(); }
});

test('نزع التسليح: يمسح armedAt حتى بعلمٍ مطفأ (تعافٍ من تسليحٍ خاطئ)', async () => {
  const armedAt = new Date('2026-09-16T07:00:00.000Z');
  const store = memoryGoLiveStore({ armed: { [TENANT]: armedAt } });
  const r = await rig({ goLiveEnv: 'off', store });
  try {
    const d = await r.post('/go-live/disarm');
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal((d.body.data as Body).applied, true);
    assert.equal((d.body.data as Body).armedAt, null);
    assert.equal(await store.loadArmedAt(TENANT), null, 'بقي مُسلَّحاً بعد النزع');
    // إعادة النزع ⇒ applied=false (لا شيء لنزعه) دون خطأ
    const again = await r.post('/go-live/disarm');
    assert.equal(again.status, 200);
    assert.equal((again.body.data as Body).applied, false);
  } finally { await r.close(); }
});

test('نزع التسليح مرفوض بعد التفعيل الحيّ ⇒ 409 GO_LIVE_ALREADY_LIVE', async () => {
  const r = await readyRig('on');
  try {
    const go = await r.post('/go-live', { typedConfirmation: CONFIRM, repsSynced: true });
    assert.equal(go.status, 200, JSON.stringify(go.body));
    const d = await r.post('/go-live/disarm');
    assert.equal(d.status, 409);
    assert.equal(d.body.code, 'GO_LIVE_ALREADY_LIVE');
    // ما زالت الشركة حيّة (لم يُمسّ التفعيل)
    assert.ok((await r.h.store.loadSellerSettings(TENANT))?.zatcaPhase2StartedAt);
  } finally { await r.close(); }
});

// ─── التفعيل: نجاح ورفض ───

async function readyRig(goLiveEnv: string, extra: RigOpts = {}) {
  const now = new Date('2026-09-16T08:00:00.000Z').getTime();
  const armed = now - 60_000;
  const store = memoryGoLiveStore({ armed: { [TENANT]: new Date(armed) }, reps: { [TENANT]: [syncedRep(now, armed)] } });
  const r = await rig({ goLiveEnv, store, ...extra });
  await activeUnit(r.h);
  return r;
}

test('التفعيل: مُسلَّح + جاهز + علم مفتوح + تأكيد «تفعيل» + repsSynced ⇒ 200 ويضبط زمن التفعيل (idempotent)', async () => {
  const r = await readyRig('on');
  try {
    const res = await r.post('/go-live', { typedConfirmation: CONFIRM, repsSynced: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body.data as Body;
    assert.ok(data.startedAt, 'زمن التفعيل غير مضبوط');
    assert.equal(data.alreadyLive, false);
    // القيمة كُتبت فعلاً في الإعدادات
    const settings = await r.h.store.loadSellerSettings(TENANT);
    assert.ok(settings?.zatcaPhase2StartedAt, 'zatcaPhase2StartedAt لم يُكتب');
    // إعادة الاستدعاء ⇒ نجاح نفسه دون كتابة (idempotent)
    const again = await r.post('/go-live', { typedConfirmation: CONFIRM, repsSynced: true });
    assert.equal(again.status, 200);
    assert.equal((again.body.data as Body).alreadyLive, true);
  } finally { await r.close(); }
});

test('التفعيل مرفوض: علم البيئة مطفأ ⇒ 409 GO_LIVE_UNAVAILABLE (كما اليوم)', async () => {
  const r = await readyRig('off');
  try {
    const res = await r.post('/go-live', { typedConfirmation: CONFIRM, repsSynced: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'GO_LIVE_UNAVAILABLE');
    assert.equal((await r.h.store.loadSellerSettings(TENANT))?.zatcaPhase2StartedAt ?? null, null);
  } finally { await r.close(); }
});

test('التفعيل مرفوض: القائمة لا تشمل الشركة (عزل) ⇒ 409 GO_LIVE_UNAVAILABLE', async () => {
  const r = await readyRig('allowlist:other-tenant');
  try {
    const res = await r.post('/go-live', { typedConfirmation: CONFIRM, repsSynced: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'GO_LIVE_UNAVAILABLE');
  } finally { await r.close(); }
});

test('التفعيل مرفوض: مندوب غير مزامَن ⇒ 409 GO_LIVE_NOT_READY', async () => {
  const now = new Date('2026-09-16T08:00:00.000Z').getTime();
  const armed = now - 60_000;
  const store = memoryGoLiveStore({ armed: { [TENANT]: new Date(armed) }, reps: { [TENANT]: [syncedRep(now, armed, { outboxTaxPending: 2 })] } });
  const r = await rig({ goLiveEnv: 'on', store });
  try {
    await activeUnit(r.h);
    const res = await r.post('/go-live', { typedConfirmation: CONFIRM, repsSynced: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'GO_LIVE_NOT_READY');
    assert.ok(((res.body.readiness as Body).reps as Body).unsynced);
    assert.equal((await r.h.store.loadSellerSettings(TENANT))?.zatcaPhase2StartedAt ?? null, null);
  } finally { await r.close(); }
});

test('التفعيل مرفوض: لا وحدة إنتاج مفعّلة ⇒ 409 GO_LIVE_NOT_READY', async () => {
  const now = new Date('2026-09-16T08:00:00.000Z').getTime();
  const armed = now - 60_000;
  const store = memoryGoLiveStore({ armed: { [TENANT]: new Date(armed) }, reps: { [TENANT]: [syncedRep(now, armed)] } });
  const r = await rig({ goLiveEnv: 'on', store }); // لا activeUnit
  try {
    const res = await r.post('/go-live', { typedConfirmation: CONFIRM, repsSynced: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'GO_LIVE_NOT_READY');
    assert.equal((res.body.readiness as Body).checks && ((res.body.readiness as Body).checks as Body).unitActive, false);
  } finally { await r.close(); }
});

test('التفعيل مرفوض: تأكيد خاطئ ⇒ CONFIRMATION_REQUIRED (بعد اجتياز الجاهزية)', async () => {
  const r = await readyRig('on');
  try {
    const res = await r.post('/go-live', { typedConfirmation: 'خطأ', repsSynced: true });
    assert.equal(res.body.code, 'CONFIRMATION_REQUIRED');
    assert.equal((await r.h.store.loadSellerSettings(TENANT))?.zatcaPhase2StartedAt ?? null, null);
  } finally { await r.close(); }
});

test('التفعيل مرفوض: repsSynced غير مؤكَّد ⇒ CONFIRMATION_REQUIRED', async () => {
  const r = await readyRig('on');
  try {
    const res = await r.post('/go-live', { typedConfirmation: CONFIRM, repsSynced: false });
    assert.equal(res.body.code, 'CONFIRMATION_REQUIRED');
  } finally { await r.close(); }
});

test('التفعيل مرفوض: دور غير ADMIN (من القاعدة) ⇒ 403 قبل أيّ منطق تفعيل', async () => {
  const r = await readyRig('on', { role: 'MANAGER' });
  try {
    const res = await r.post('/go-live', { typedConfirmation: CONFIRM, repsSynced: true });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'COMPANY_ADMIN_ONLY');
  } finally { await r.close(); }
});

test('التفعيل مرفوض: شركة غير سعودية ⇒ 403 من البوابة', async () => {
  // شركة غير سعودية لا تعبر البوابة أصلاً — لا حاجة (ولا يمكن) لإنشاء وحدة إنتاج لها
  const r = await rig({ goLiveEnv: 'on', countryCode: 'AE' });
  try {
    const res = await r.post('/go-live', { typedConfirmation: CONFIRM, repsSynced: true });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'ZATCA_COUNTRY_NOT_SUPPORTED');
  } finally { await r.close(); }
});

// ─── مراجعة الانتقال (D11) ───

test('مراجعة الانتقال: قائمة + قبول + رفض + حسم مكرَّر 409 + عزل الشركات', async () => {
  const now = new Date('2026-09-16T08:00:00.000Z');
  const store = memoryGoLiveStore();
  const mine1 = (await store.recordCutover({ tenantId: TENANT, clientRef: 'ref-1', clientCreatedAt: now, reason: 'WINDOW_EXPIRED', payload: { x: 1 }, at: now })).row;
  const mine2 = (await store.recordCutover({ tenantId: TENANT, clientRef: 'ref-2', clientCreatedAt: now, reason: 'TOO_OLD', payload: { x: 2 }, at: now })).row;
  await store.recordCutover({ tenantId: 'other-tenant', clientRef: 'ref-x', clientCreatedAt: now, reason: 'NO_CLIENT_TIME', payload: {}, at: now });
  const r = await rig({ goLiveEnv: 'off', store }); // المراجعة لا تعتمد على علم التفعيل
  try {
    const list = await r.get('/cutover');
    assert.equal(list.status, 200);
    const items = (list.body.data as Body).items as Body[];
    assert.equal(items.length, 2, 'ظهرت مستندات شركة أخرى (فشل العزل)');
    assert.ok(items.every(i => i.id === mine1.id || i.id === mine2.id));

    const acc = await r.post(`/cutover/${mine1.id}/accept`, { mode: 'PHASE1', note: 'مقبولة يدوياً' });
    assert.equal(acc.status, 200);
    assert.equal(((acc.body.data as Body).item as Body).status, 'ACCEPTED_PHASE1');
    assert.equal(((acc.body.data as Body).item as Body).reviewedBy, ACTOR);

    // حسم مكرَّر ⇒ 409
    const dup = await r.post(`/cutover/${mine1.id}/accept`, { mode: 'PHASE2' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, 'CUTOVER_ALREADY_RESOLVED');

    const rej = await r.post(`/cutover/${mine2.id}/reject`);
    assert.equal(((rej.body.data as Body).item as Body).status, 'REJECTED');

    // معرّف مجهول ⇒ 404
    const nf = await r.post('/cutover/nope/accept', { mode: 'PHASE1' });
    assert.equal(nf.status, 404);

    // قائمة PENDING فقط ⇒ صفر بعد الحسم
    const pend = await r.get('/cutover?status=PENDING');
    assert.equal(((pend.body.data as Body).items as Body[]).length, 0);
  } finally { await r.close(); }
});

test('مراجعة الانتقال: بلا مخزن تفعيل ⇒ 404 (لا تسريب)', async () => {
  const h = harness({ env: 'production', productionBackend: true });
  const ADMIN = { id: ACTOR, role: 'ADMIN', name: 'a', tenantId: TENANT };
  const router = createZatcaRouter({
    authenticate: (req: AuthRequest, _res: Response, next: NextFunction) => { req.user = ADMIN as AuthRequest['user']; next(); },
    loadAdmin: async () => ({ isActive: true, role: 'ADMIN', tenantId: TENANT, canManageCompanySettings: true }),
    isScopeRestricted: async () => false,
    loadTenantFlag: async () => true,
    store: h.store,
    writeSeller: async () => true,
    loadKeyring: () => h.keyring,
    clientFactory: h.client,
    now: h.clock.now,
    config: zatcaEnvConfig({ NODE_ENV: 'production', ZATCA_ALLOWED_ENVS: 'production' }),
    log: () => {},
    audit: () => {},
    // بلا goLiveStore ولا goLiveEnv
  });
  const app = express();
  app.use(express.json());
  app.use('/api/zatca', router, zatcaErrorGuard);
  const server = http.createServer(app);
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  const get = (url: string): Promise<Reply> => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/api/zatca${url}`, agent: false, headers: { connection: 'close' } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    }).on('error', reject);
  });
  try {
    const list = await get('/cutover');
    assert.equal(list.status, 404);
    const ready = await get('/go-live/readiness');
    assert.equal(ready.status, 404);
  } finally { await router.idle(); server.closeAllConnections?.(); await new Promise(r => server.close(r)); }
});
