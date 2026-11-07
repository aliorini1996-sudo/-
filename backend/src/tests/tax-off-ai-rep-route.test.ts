// «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — المندوب الذكي موصولٌ بعلم الشركة: POST /rep/guide و/rep/chat يقرآن
// CompanySettings.taxDisabled من قراءة اسم الشركة نفسها (بلا استعلام زائد) فلا «قبل الضريبة» لشركةٍ بلا ضريبة لا في الخطة
// الحتمية ولا في تعليمات العقل؛ والشركة بضريبتها (false أو صفٌّ بلا العمود) نصّها حرفاً كما كان.
// المعالج الحقيقي فوق وحدات مزيّفة، بلا قاعدة ولا Google ولا نموذج.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Router } from 'express';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// ───────────── القاعدة: صفّ الشركة وحده ─────────────
/** العلم في صفّ الشركة: true ⇒ بلا ضريبة، false ⇒ بضريبتها، undefined ⇒ صفٌّ قبل العمود */
let taxDisabled: boolean | undefined;
const csCalls: Row[] = [];
const empty = { findUnique: async () => null, findFirst: async () => null, findMany: async () => [], count: async () => 0, groupBy: async () => [] };
const db = new Proxy({
  companySettings: {
    findUnique: async (a: Row) => {
      csCalls.push(a);
      const row: Row = { name: 'شركة النور', countryCode: 'SA', ...(taxDisabled !== undefined && { taxDisabled }) };
      return Object.fromEntries(Object.keys(a.select ?? row).filter((k) => k in row).map((k) => [k, row[k]]));
    },
  },
} as Row, { get: (t, k: string) => (k in t ? t[k] : k === 'then' ? undefined : empty) });
stub('config/database', { default: db });
const pass = (_req: unknown, _res: unknown, next: () => void) => next();
stub('middleware/auth', {
  authenticate: pass, requireAdmin: pass, requireSalesRep: pass,
  requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user!.tenantId!,
  actorOf: (req: { user?: { id?: string } }) => req.user?.id ?? '',
});
stub('services/customerScope', { customerScope: async () => ({}), isolationEnabled: async () => false });
stub('services/adminScope', { adminScopeEnabled: async () => false });

// ───────────── بيانات التوقّع: محلٌّ واحد بقيمة شهرية ─────────────
const DATA = { timezone: 'Asia/Riyadh', window: { from: '2026-05-01', to: '2026-10-31' }, peers: [], monthly: [], firstOrders: [], products: [] };
stub('ai-rep/estimateData', { loadEstimateData: async () => DATA, invalidateEstimateData: () => undefined, tenantTimezone: async () => 'Asia/Riyadh' });
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realEstimate = require('../ai-rep/estimate') as typeof import('../ai-rep/estimate');
stub('ai-rep/estimate', {
  ...realEstimate,
  estimateOutlet: (_i: unknown, label: string) => ({
    ok: true, engineVersion: 'test', outletType: label, ringKm: 2, peers: 6, medianTenureMonths: 8, confidence: 'MEDIUM',
    window: DATA.window, monthlyTotalValue: { low: 800, median: 1000, high: 1200 }, products: [], why: 'test',
  }),
});

stub('ai-rep/usage', {
  usageDay: () => '2026-11-07', usageToday: async () => ({ searches: 0 }), addUsage: async () => undefined,
  reserveUsage: async () => '2026-11-07', refundUsage: async () => undefined,
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realStore = require('../ai-rep/learn/store') as typeof import('../ai-rep/learn/store');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const T = require('../ai-rep/learn/types') as typeof import('../ai-rep/learn/types');
stub('ai-rep/learn/store', { ...realStore, getLearned: async () => ({ ...T.EMPTY_LEARNED }), recordTurn: async () => undefined, updateTurn: async () => undefined });

// ───────────── العقل: يُلتقط نصّ التعليمات ─────────────
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realLlm = require('../ai-rep/llm') as typeof import('../ai-rep/llm');
let llmOn = false;
const systems: string[] = [];
stub('ai-rep/llm', {
  ...realLlm,
  llmConfig: () => (llmOn ? { baseUrl: 'http://llm.invalid', apiKey: 'k', model: 'm', extraBody: {}, timeoutMs: 1000, maxTokens: 100 } : null),
  chatCompletion: async (_c: unknown, req: { messages: { role: string; content: string }[] }) => {
    systems.push(req.messages[0]?.content ?? '');
    return { ok: true, content: 'ابدأ بالمحل P1 فهو الأقرب.', toolCalls: [], usage: { promptTokens: 5, completionTokens: 2, cachedTokens: 0 }, finishReason: 'stop' };
  },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const session = require('../ai-rep/session') as typeof import('../ai-rep/session');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const settingsMod = require('../ai-rep/settings') as typeof import('../ai-rep/settings');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = (require('../routes/aiRep') as typeof import('../routes/aiRep')).default as unknown as Router;

type Handle = (req: unknown, res: unknown, next: (e?: unknown) => void) => unknown;
interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handle }[] }; handle?: { stack?: Layer[] } }
function handler(p: string): Handle {
  const walk = (stack: Layer[]): Handle | null => {
    for (const l of stack) {
      if (l.route && l.route.path === p && l.route.methods.post) return l.route.stack[l.route.stack.length - 1].handle;
      if (l.handle?.stack) { const h = walk(l.handle.stack); if (h) return h; }
    }
    return null;
  };
  const h = walk((router as unknown as { stack: Layer[] }).stack);
  if (!h) throw new Error(`نقطة غير مسجّلة: ${p}`);
  return h;
}
const O = { lat: 24.7, lng: 46.7 };
async function call(p: string, body: (searchId: string) => Row, flag: boolean | undefined, advisorEnabled: boolean) {
  taxDisabled = flag;
  csCalls.length = 0;
  systems.length = 0;
  llmOn = advisorEnabled;
  const repId = `rep-${randomUUID()}`;
  const searchId = randomUUID();
  session.saveSession('t1', repId, {
    searchId, createdAt: Date.now(), origin: O, radiusM: 2000,
    outlets: [{ ref: 'P1', placeId: 'ChIJtaxoff000001', outletType: 'GROCERY', lat: O.lat + 0.001, lng: O.lng, distanceM: 111, relation: 'NEW', lastOutcome: null, customerId: null }],
  });
  const settings = { ...settingsMod.settingsView(null), advisorEnabled, holdoutPct: 0 };
  const ctx = { tid: 't1', repId, showMoney: true, countryCode: 'SA', settings };
  let status = 200;
  let out: Row | null = null;
  let err: unknown = null;
  const res = { status(c: number) { status = c; return this; }, json(b: Row) { out = b; return this; } };
  await handler(p)({ body: body(searchId), user: { role: 'SALES_REP', id: repId, tenantId: 't1' }, aiRep: ctx }, res, (e?: unknown) => { err = e ?? null; });
  assert.equal(err, null, String(err));
  return { status, body: out as unknown as Row };
}
const guideBody = (searchId: string) => ({ searchId });
const chatBody = (searchId: string) => ({ searchId, messages: [{ role: 'user', text: 'بماذا أبدأ اليوم؟' }] });

test('/rep/guide (الخطة الحتمية): الشركة بلا ضريبة ⇒ «شهرياً» بلا «قبل الضريبة»، بقراءة الشركة نفسها', async () => {
  const r = await call('/guide', guideBody, true, false);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.source, 'RULES');
  const text = r.body.data.text as string;
  assert.ok(text.includes('متوقع 800–1200 SAR شهرياً.'), text);
  assert.doesNotMatch(text, /ضريب/);
  assert.equal(csCalls.length, 1, 'قراءة واحدة لصفّ الشركة — لا استعلام زائد');
  assert.deepEqual(csCalls[0].select, { name: true, taxDisabled: true });
});

test('/rep/guide (الخطة الحتمية): الشركة بضريبتها (false أو صفٌّ بلا العمود) ⇒ النصّ حرفاً كما كان', async () => {
  const on = await call('/guide', guideBody, false, false);
  const legacy = await call('/guide', guideBody, undefined, false);
  assert.ok((on.body.data.text as string).includes('متوقع 800–1200 SAR شهرياً قبل الضريبة.'));
  assert.equal(legacy.body.data.text, on.body.data.text);
  const off = await call('/guide', guideBody, true, false);
  assert.equal(off.body.data.text, (on.body.data.text as string).replace(' قبل الضريبة', ''), 'العبارة وحدها تسقط');
});

test('/rep/guide بالعقل: تعليمات القيم المالية بلا «قبل الضريبة» للشركة بلا ضريبة — وبضريبتها كما كانت', async () => {
  const off = await call('/guide', guideBody, true, true);
  assert.equal(off.status, 200);
  assert.ok(systems.length >= 1, 'العقل نودي');
  assert.ok(systems[0].includes('القيم المالية بعملة SAR.'));
  for (const s of systems) assert.doesNotMatch(s, /ضريب/);
  assert.equal(csCalls.length, 1);

  await call('/guide', guideBody, false, true);
  assert.ok(systems[0].includes('القيم المالية بعملة SAR وقبل الضريبة.'));
});

test('/rep/chat: تعليمات المستشار بلا «قبل الضريبة» للشركة بلا ضريبة — وبضريبتها كما كانت', async () => {
  const off = await call('/chat', chatBody, true, true);
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.ok(systems.length >= 1);
  assert.ok(systems[0].includes('القيم المالية بعملة SAR.'));
  for (const s of systems) assert.doesNotMatch(s, /ضريب/);
  assert.equal(csCalls.length, 1, 'قراءة واحدة لصفّ الشركة');

  const on = await call('/chat', chatBody, false, true);
  assert.equal(on.status, 200);
  assert.ok(systems[0].includes('القيم المالية بعملة SAR وقبل الضريبة.'));
  const legacy = await call('/chat', chatBody, undefined, true);
  assert.equal(legacy.status, 200);
  assert.ok(systems[0].includes('القيم المالية بعملة SAR وقبل الضريبة.'));
});
