// فوترة ZATCA (Z5.0، z5_plan §2.1 + نقد الخطة 5) — بوابة /api/zatca لشركة فُعّلت حيّاً: إطفاء علم المالك بعد التفعيل لا يُغلق
// الربط والتجديد (العمليات)، وبلا تفعيل يبقى العلم شرطاً كما اليوم. الموجّه الحقيقي بمخزن ذاكرة Z4 عبر HTTP على 127.0.0.1.
import { guardHits } from '../compliance/zatca/__fixtures__/z3-netguard';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { NextFunction, Response } from 'express';
import { TENANT, fakeSleep, harness } from '../compliance/zatca/__fixtures__/z4-harness';
import { ZATCA_ROUTE_CODES, createZatcaRouter, zatcaEnvConfig, zatcaErrorGuard } from '../routes/zatca';
import { AuthRequest } from '../types';

after(() => { assert.equal(guardHits(), 0, 'محاولة شبكة حقيقية'); });

const ADMIN = { id: 'admin-7', role: 'ADMIN', name: 'a', tenantId: TENANT };
const LIVE = new Date('2026-11-20T06:00:00.000Z');

async function rig(flag: boolean) {
  const h = harness({ env: 'simulation' });
  const flagReads: string[] = [];
  const router = createZatcaRouter({
    authenticate: (req: AuthRequest, _res: Response, next: NextFunction) => { req.user = ADMIN as AuthRequest['user']; next(); },
    loadAdmin: async () => ({ isActive: true, role: 'ADMIN', tenantId: TENANT, canManageCompanySettings: true }),
    isScopeRestricted: async () => false,
    loadTenantFlag: async tid => { flagReads.push(tid); return flag; },
    store: h.store,
    writeSeller: async () => true,
    loadKeyring: () => h.keyring,
    clientFactory: h.client,
    now: h.clock.now,
    config: zatcaEnvConfig({ NODE_ENV: 'production', ZATCA_ALLOWED_ENVS: 'simulation' }),
    sleep: fakeSleep(h),
    log: () => {},
    audit: () => {},
  });
  const app = express();
  app.use(express.json());
  app.use('/api/zatca', router, zatcaErrorGuard);
  const server = http.createServer(app);
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  const get = (url: string) => new Promise<{ status: number; body: any }>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    http.get({ host: '127.0.0.1', port, path: `/api/zatca${url}` }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    }).on('error', reject);
  });
  return { h, get, flagReads, close: async () => { await router.idle(); await new Promise(r => server.close(r)); } };
}

test('العلم مطفأ بلا تفعيل ⇒ 403 ZATCA_PHASE2_NOT_ALLOWED كما اليوم', async () => {
  const r = await rig(false);
  try {
    const res = await r.get('/overview');
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'ZATCA_PHASE2_NOT_ALLOWED');
    assert.equal(res.body.message, ZATCA_ROUTE_CODES.ZATCA_PHASE2_NOT_ALLOWED);
    assert.equal(r.h.store.received.length, 0);
  } finally { await r.close(); }
});

test('شركة فُعّلت حيّاً والعلم مطفأ بعدها ⇒ البوابة تعبر (النظرة العامة PHASE2 والعلم الحقيقي false)', async () => {
  const r = await rig(false);
  try {
    r.h.store.settings.get(TENANT)!.zatcaPhase2StartedAt = LIVE;
    const res = await r.get('/overview');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.regime, 'PHASE2');
    assert.equal(res.body.data.gate.zatcaPhase2Enabled, false);
    assert.equal(res.body.data.goLiveAvailable, false);
    // الدولة ما زالت شرطاً
    r.h.store.settings.get(TENANT)!.countryCode = 'AE';
    assert.equal((await r.get('/overview')).body.code, 'ZATCA_COUNTRY_NOT_SUPPORTED');
    assert.equal(r.h.store.received.length, 0);
  } finally { await r.close(); }
});

test('العلم مفعّل ⇒ كما اليوم (gate.zatcaPhase2Enabled true، PHASE1 قبل التفعيل)', async () => {
  const r = await rig(true);
  try {
    const res = await r.get('/overview');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.gate.zatcaPhase2Enabled, true);
    assert.equal(res.body.data.regime, 'PHASE1');
    assert.deepEqual(r.flagReads, [TENANT]);
  } finally { await r.close(); }
});
