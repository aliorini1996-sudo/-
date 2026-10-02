// المندوب الذكي — حرّاس نقطتي المسح والدراسة قبل الحجز وبعده: الموقع التقريبي جداً لا يُمسح حوله ولا يستهلك حصة،
// والمحل المغلق نهائياً حسب Google يعيد وحدة الدراسة. معالج المسار نفسه فوق وحدات مزيّفة، بلا قاعدة ولا Google.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Router } from 'express';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

stub('config/database', { default: {} });
const pass = (_req: unknown, _res: unknown, next: () => void) => next();
stub('middleware/auth', {
  authenticate: pass, requireAdmin: pass, requireSalesRep: pass,
  requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user!.tenantId!,
});
stub('services/customerScope', { customerScope: async () => ({}), isolationEnabled: async () => false });
stub('services/adminScope', { adminScopeEnabled: async () => false });
stub('ai-rep/estimateData', { loadEstimateData: async () => ({}), invalidateEstimateData: () => undefined });

const usage = { reserved: 0, refunded: 0, allow: true };
stub('ai-rep/usage', {
  usageDay: () => '2026-09-30',
  usageToday: async () => null,
  addUsage: async () => undefined,
  reserveUsage: async () => { usage.reserved++; return usage.allow; },
  refundUsage: async () => { usage.refunded++; },
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realPlaces = require('../ai-rep/places') as typeof import('../ai-rep/places');
let profile: Record<string, unknown> = {};
stub('ai-rep/places', { ...realPlaces, placesApiKey: () => 'test-key', placeProfile: async () => ({ ok: true, profile }) });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require('../routes/aiRep') as typeof import('../routes/aiRep');
const router = mod.default as unknown as Router;

type Handle = (req: unknown, res: unknown, next: (e?: unknown) => void) => unknown;
interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handle }[] }; handle?: { stack?: Layer[] } }
function handler(method: 'post', p: string): Handle {
  const walk = (stack: Layer[]): Handle | null => {
    for (const l of stack) {
      if (l.route && l.route.path === p && l.route.methods[method]) return l.route.stack[l.route.stack.length - 1].handle;
      if (l.handle?.stack) { const h = walk(l.handle.stack); if (h) return h; }
    }
    return null;
  };
  const h = walk((router as unknown as { stack: Layer[] }).stack);
  if (!h) throw new Error(`نقطة غير مسجّلة: ${method} ${p}`);
  return h;
}
function mockRes() {
  return { statusCode: 200, body: null as Record<string, unknown> | null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b as Record<string, unknown>; return this; } };
}
const ctx = { tid: 't1', repId: 'r1', showMoney: false, countryCode: 'SA', settings: { dailySearchesPerRep: 30, searchRadiusM: 2000, targetOutletTypes: ['GROCERY'], advisorEnabled: false } };
async function call(p: string, body: unknown) {
  const res = mockRes();
  let err: unknown = null;
  await handler('post', p)({ body, user: { role: 'SALES_REP', id: 'r1', tenantId: 't1' }, aiRep: ctx }, res, (e?: unknown) => { err = e ?? null; });
  if (err) throw err;
  return res;
}

test('المسح: الموقع التقريبي جداً (الموقع الدقيق مطفأ) ⇒ GPS_INACCURATE قبل الحجز — لا حصة ولا طلبات Google', async () => {
  usage.reserved = 0; usage.refunded = 0; usage.allow = false;
  const res = await call('/scan', { lat: 24.7, lng: 46.7, accuracyM: 2500 });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body?.code, 'GPS_INACCURATE');
  assert.equal(usage.reserved, 0, 'لا حجز لوحدة المسح');
  // دون الحدّ يمضي إلى الحجز (هنا مرفوض بالحدّ اليومي ⇒ يتوقّف قبل Google)
  const ok = await call('/scan', { lat: 24.7, lng: 46.7, accuracyM: mod.SCAN_MAX_ACCURACY_M });
  assert.equal(ok.body?.code, 'AI_REP_DAILY_LIMIT');
  assert.equal(usage.reserved, 1);
  const noAcc = await call('/scan', { lat: 24.7, lng: 46.7 });
  assert.equal(noAcc.body?.code, 'AI_REP_DAILY_LIMIT', 'بلا دقّة مُرسلة لا يُرفض');
});

test('الدراسة: المحل المغلق نهائياً حسب Google ⇒ PLACE_CLOSED وتُعاد وحدة الدراسة', async () => {
  usage.reserved = 0; usage.refunded = 0; usage.allow = true;
  profile = {
    placeId: 'ChIJclosedShop01', name: 'بقالة', typeLabel: null, primaryType: null, types: [], address: null, lat: 24.7, lng: 46.7,
    mapsUri: null, rating: null, ratingCount: 0, openNow: null, hours: [], priceLevel: null, reviews: [], closed: true,
  };
  const res = await call('/study', { placeId: 'ChIJclosedShop01' });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body?.code, 'PLACE_CLOSED');
  assert.equal(usage.reserved, 1);
  assert.equal(usage.refunded, 1, 'الوحدة المحجوزة أُعيدت');
});
