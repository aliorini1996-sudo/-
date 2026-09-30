// المندوب الذكي — معالجا المسح والدراسة الحيّان وتوجيه العقل المؤجَّل (/rep/scan، /rep/scan/guide، /rep/study): نطاق ×١٫٢٥
// والأنواع، والعزل (لا «ربما عميل» من عميل زميل ولا معرّف عميلٍ غير مرئي)، وردّ الحصة حين يتعذّر المسح أو النموذج قبل
// أي كلفة، والخطة الحتمية حين تنفد تحليلات العقل، والدراسة المجانية لمحلات المسح. معالج المسار فوق وحدات مزيّفة، بلا
// قاعدة ولا Google ولا نموذج.
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

// ───────────── القاعدة: عملاء حول المحلات، ومنتجات للدراسة ─────────────
type Cust = { id: string; lat: number | null; lng: number | null; outletType: string | null; aiPlaceId: string | null };
const db = { customers: [] as Cust[], visible: new Set<string>(), throwOnCustomers: false };
stub('config/database', {
  default: {
    customer: {
      findMany: async (a: { where: Record<string, unknown> }) => {
        if (db.throwOnCustomers) throw new Error('db down');
        const w = a.where;
        // استعلام الرؤية: المعرّفات بقيد النطاق (scoped ⇒ المرئيون وحدهم)
        if (w.id && typeof w.id === 'object' && 'in' in (w.id as object)) {
          const ids = (w.id as { in: string[] }).in;
          return ids.filter(id => !('scoped' in w) || db.visible.has(id)).map(id => ({ id }));
        }
        return db.customers;
      },
    },
    aiOutlet: { findMany: async () => [] },
    product: { findMany: async () => [{ id: 'p1', name: 'مياه' }] },
    invoiceItem: { groupBy: async () => [] },
  },
});
const pass = (_req: unknown, _res: unknown, next: () => void) => next();
stub('middleware/auth', {
  authenticate: pass, requireAdmin: pass, requireSalesRep: pass,
  requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user!.tenantId!,
  actorOf: (req: { user?: { id?: string } }) => req.user?.id ?? '',
});
let isolation = false;
let scope: Record<string, unknown> = {};
stub('services/customerScope', { customerScope: async () => scope, isolationEnabled: async () => isolation });
stub('services/adminScope', { adminScopeEnabled: async () => false });
stub('ai-rep/estimateData', { loadEstimateData: async () => ({}), invalidateEstimateData: () => undefined, tenantTimezone: async () => 'Asia/Riyadh' });

// ───────────── الحصص: الحجز يعيد يومه، والردّ يُسجَّل بحقله ويومه ─────────────
const DAY = '2026-09-30';
const usage = {
  log: [] as { op: 'reserve' | 'refund'; field: string; day?: string }[],
  deny: new Set<string>(),
  added: [] as Record<string, number>[],
  reset() { this.log = []; this.deny = new Set(); this.added = []; },
  count(op: 'reserve' | 'refund', field: string) { return this.log.filter(x => x.op === op && x.field === field).length; },
};
stub('ai-rep/usage', {
  usageDay: () => DAY,
  usageToday: async () => ({ searches: 3 }),
  addUsage: async (_t: string, _r: string, inc: Record<string, number>) => { usage.added.push(inc); },
  reserveUsage: async (_t: string, _r: string, field: string) => { usage.log.push({ op: 'reserve', field }); return usage.deny.has(field) ? null : DAY; },
  refundUsage: async (_t: string, _r: string, field: string, _n = 1, day?: string) => { usage.log.push({ op: 'refund', field, day }); },
});

// ───────────── العقل ─────────────
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realLlm = require('../ai-rep/llm') as typeof import('../ai-rep/llm');
let llmCfg: import('../ai-rep/llm').LlmConfig | null = null;
let llmCalls = 0;
let llmSent = '';
let llmSystem = '';
let llmReply: () => import('../ai-rep/llm').LlmResult = () => ({
  ok: true, content: JSON.stringify({ summary: 'ابدأ بالأقرب', plan: [{ ref: 'P1', why: 'الأقرب إليك' }] }),
  toolCalls: [], usage: { promptTokens: 5, completionTokens: 2, cachedTokens: 0 }, finishReason: 'stop',
});
stub('ai-rep/llm', {
  ...realLlm, llmConfig: () => llmCfg,
  chatCompletion: async (_c: unknown, req: { messages: { content: string }[] }) => {
    llmCalls++; llmSystem = req.messages[0]?.content ?? ''; llmSent = req.messages[1]?.content ?? ''; return llmReply();
  },
});

// ───────────── Google: البحث الرسمي والملف (بمفتاح) والمسح العام (بلا مفتاح) ─────────────
const O = { lat: 24.7, lng: 46.7 };
const north = (m: number) => ({ lat: O.lat + m / 111195, lng: O.lng });
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realPlaces = require('../ai-rep/places') as typeof import('../ai-rep/places');
let placesKey: string | null = null;
let nearby: () => Promise<unknown> = async () => ({ ok: true, places: [] });
const profileOf = (placeId: string) => ({
  placeId, name: `محل ${placeId.slice(-2)}`, typeLabel: 'بقالة', primaryType: 'grocery_store', types: ['grocery_store'], address: null,
  ...north(100), mapsUri: null, rating: 4.2, ratingCount: 30, openNow: true, hours: [], priceLevel: null, reviews: [], closed: false,
});
let profileFail: { code: string; message: string } | null = null;
stub('ai-rep/places', {
  ...realPlaces, placesApiKey: () => placesKey, searchNearby: () => nearby(),
  placeProfile: async (o: { placeId: string }) => (profileFail ? { ok: false, ...profileFail } : { ok: true, profile: profileOf(o.placeId) }),
});

type Pub = import('../ai-rep/publicMaps').PublicPlace & { type: string };
const pub = (id: string, m: number, type = 'GROCERY'): Pub => ({
  placeId: id, featureId: null, name: `محل ${id}`, rating: 4, ratingCount: 50, ...north(m), categories: ['بقالة'],
  address: null, openText: null, openNow: true, hours: [], closed: false, type,
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realMaps = require('../ai-rep/publicMaps') as typeof import('../ai-rep/publicMaps');
let publicResult: import('../ai-rep/publicMaps').PublicScanResult = { ok: true, places: [], partial: false, codes: [] };
const publicCalls: { types: readonly string[]; targets: readonly string[]; radiusM: number; country?: string | null }[] = [];
stub('ai-rep/publicMaps', {
  ...realMaps, repRetryLeftMs: () => 0, notePublicScanShops: () => undefined, noteRepScanFailed: () => undefined,
  publicScan: async (o: { types: readonly string[]; targets: readonly string[]; radiusM: number; country?: string | null }) => { publicCalls.push(o); return publicResult; },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const realStore = require('../ai-rep/learn/store') as typeof import('../ai-rep/learn/store');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const T = require('../ai-rep/learn/types') as typeof import('../ai-rep/learn/types');
stub('ai-rep/learn/store', { ...realStore, getLearned: async () => ({ ...T.EMPTY_LEARNED }), recordTurn: async () => undefined, updateTurn: async () => undefined });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require('../routes/aiRep') as typeof import('../routes/aiRep');
const router = mod.default as unknown as Router;

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
function mockRes() {
  return { statusCode: 200, body: null as Record<string, unknown> | null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b as Record<string, unknown>; return this; } };
}
const settings = (o: Record<string, unknown> = {}) => ({
  dailySearchesPerRep: 30, dailyChatTurnsPerRep: 30, searchRadiusM: 2000, targetOutletTypes: ['GROCERY', 'MINIMARKET'], priorityProductIds: [],
  advisorEnabled: false, playbook: null, learningMode: 'AUTO', holdoutPct: 0, ...o,
});
async function call(p: string, body: unknown, repId: string, s: Record<string, unknown> = {}, countryCode = 'SA') {
  const res = mockRes();
  let err: unknown = null;
  const ctx = { tid: 't1', repId, showMoney: false, countryCode, settings: settings(s) };
  await handler(p)({ body, user: { role: 'SALES_REP', id: repId, tenantId: 't1' }, aiRep: ctx }, res, (e?: unknown) => { err = e ?? null; });
  return { res, err };
}
interface ScanItem { ref: string; placeId: string; outletType: string; relation: string; customerId: string | null; distanceM: number }
interface ScanData { searchId: string; source: string; items: ScanItem[]; guide: { source: string; stops: { ref: string }[] }; aiGuidePending: boolean; searchesLeft: number }
const scan = async (repId: string, s: Record<string, unknown> = {}) => call('/scan', { ...O, accuracyM: 10 }, repId, s);
const dataOf = <D>(r: { res: { body: Record<string, unknown> | null } }) => (r.res.body as { data: D }).data;

function reset() {
  usage.reset();
  db.customers = []; db.visible = new Set(); db.throwOnCustomers = false;
  isolation = false; scope = {};
  llmCfg = null; llmCalls = 0;
  placesKey = null; nearby = async () => ({ ok: true, places: [] }); profileFail = null;
  publicResult = { ok: true, places: [], partial: false, codes: [] };
  publicCalls.length = 0;
}

// ───────────── المسح ─────────────

test('المسح: أول ثلاثة أنواع يُبحث بها والدمج بكل المستهدَف، وحتى ×١٫٢٥ من النطاق، والنوع غير المستهدف يُسقط، والأقرب أولاً', async () => {
  reset();
  publicResult = {
    ok: true, partial: false, codes: [],
    places: [pub('ChIJfar00000001', 2600), pub('ChIJedge0000001', 2400), pub('ChIJnear0000001', 150), pub('ChIJpharm000001', 300, 'PHARMACY'), pub('ChIJmini0000001', 900, 'MINIMARKET')],
  };
  const r = await scan('rep-types', { targetOutletTypes: ['GROCERY', 'MINIMARKET', 'SUPERMARKET', 'BAKERY'] });
  assert.equal(r.err, null);
  assert.deepEqual(publicCalls[0].types, ['GROCERY', 'MINIMARKET', 'SUPERMARKET'], 'حدّ الطلبات: ثلاثة أنواع');
  assert.deepEqual(publicCalls[0].targets, ['GROCERY', 'MINIMARKET', 'SUPERMARKET', 'BAKERY']);
  const d = dataOf<ScanData>(r);
  assert.equal(d.source, 'PUBLIC');
  assert.deepEqual(d.items.map(i => i.placeId), ['ChIJnear0000001', 'ChIJmini0000001', 'ChIJedge0000001'], '٢٦٠٠ م خارج ×١٫٢٥ والصيدلية غير مستهدفة');
  assert.deepEqual(d.items.map(i => i.ref), ['P1', 'P2', 'P3']);
  assert.equal(d.items[1].outletType, 'MINIMARKET');
  assert.equal(d.guide.source, 'RULES');
  assert.equal(d.aiGuidePending, false, 'بلا عقل لا نداء ثانٍ');
  assert.equal(d.searchesLeft, 27, 'المتبقّي من حدّ الشركة');
  assert.equal(usage.count('reserve', 'searches'), 1);
  assert.equal(usage.count('refund', 'searches'), 0);
});

test('المسح والعزل: عميل الزميل لا يصير «ربما عميل» ولا يُكشف معرّفه، وبلا عزل «ربما عميل» بلا معرّف غير المرئي', async () => {
  reset();
  publicResult = { ok: true, partial: false, codes: [], places: [pub('ChIJmine0000001', 200), pub('ChIJpeer0000001', 500)] };
  db.customers = [
    { id: 'c-mine', ...north(200), outletType: 'GROCERY', aiPlaceId: 'ChIJmine0000001' },
    { id: 'c-peer', ...north(500), outletType: 'GROCERY', aiPlaceId: null },
  ];
  db.visible = new Set(['c-mine']);
  scope = { scoped: true };
  isolation = true;
  const iso = dataOf<ScanData>(await scan('rep-iso'));
  const byId = new Map(iso.items.map(i => [i.placeId, i]));
  assert.deepEqual([byId.get('ChIJmine0000001')?.relation, byId.get('ChIJmine0000001')?.customerId], ['CUSTOMER', 'c-mine']);
  assert.deepEqual([byId.get('ChIJpeer0000001')?.relation, byId.get('ChIJpeer0000001')?.customerId], ['NEW', null], 'مع العزل: كأن لا عميل هناك');
  isolation = false;
  const open = dataOf<ScanData>(await scan('rep-open'));
  const peer = open.items.find(i => i.placeId === 'ChIJpeer0000001')!;
  assert.deepEqual([peer.relation, peer.customerId], ['POSSIBLE_CUSTOMER', null], 'بلا عزل: موسوم ولا معرّف لعميلٍ خارج نطاقه');
});

test('المسح: تعذّر البحث العام كله ⇒ الوحدة تُردّ بيوم حجزها ولا «لا محلات حولك»؛ بحث الأماكن المُفوتَر لا يُردّ', async () => {
  reset();
  publicResult = { ok: false, code: 'SCAN_FAILED', message: 'تعذّر', codes: ['BLOCKED' as never] };
  const r = await scan('rep-fail');
  assert.equal(r.res.statusCode, 502);
  assert.equal(r.res.body?.code, 'SCAN_FAILED');
  assert.deepEqual(usage.log.filter(x => x.op === 'refund'), [{ op: 'refund', field: 'searches', day: DAY }]);
  // بمفتاح: بحثٌ رسمي ناجح خالٍ (مُفوتَر) ثم تعذّر العام ⇒ لا ردّ
  usage.reset();
  placesKey = 'k';
  nearby = async () => ({ ok: true, places: [] });
  const billed = await scan('rep-fail-billed');
  assert.equal(billed.res.statusCode, 502);
  assert.equal(usage.count('refund', 'searches'), 0);
  // استثناءٌ قبل أي بحث ⇒ يُردّ ويصل معالج الأخطاء
  usage.reset();
  nearby = async () => { throw new Error('network'); };
  const thrown = await scan('rep-throw');
  assert.ok(thrown.err instanceof Error);
  assert.deepEqual(usage.log.filter(x => x.op === 'refund'), [{ op: 'refund', field: 'searches', day: DAY }]);
});

// ───────────── توجيه العقل المؤجَّل ─────────────

test('توجيه العقل: المسح يعود بالحتمي فوراً، والنداء الثاني يستبدله مرّة واحدة لكل مسح (الإعادة بلا حصة ولا نموذج)', async () => {
  reset();
  llmCfg = { baseUrl: 'https://x', apiKey: 'k', model: 'm', extraBody: {}, timeoutMs: 1000, maxTokens: 100 };
  publicResult = { ok: true, partial: false, codes: [], places: [pub('ChIJaa00000001', 100), pub('ChIJbb00000001', 300)] };
  const s = dataOf<ScanData>(await scan('rep-ai', { advisorEnabled: true }));
  assert.equal(s.guide.source, 'RULES');
  assert.equal(s.aiGuidePending, true);
  assert.equal(llmCalls, 0, 'المسح لا ينتظر النموذج');
  assert.equal(usage.count('reserve', 'chatTurns'), 0, 'الحصة تُحجز في النداء الثاني');
  const g1 = await call('/scan/guide', { searchId: s.searchId }, 'rep-ai', { advisorEnabled: true });
  const d1 = dataOf<{ guide: { source: string; stops: { ref: string }[] } | null; reason: string | null }>(g1);
  assert.equal(d1.guide?.source, 'AI');
  assert.deepEqual(d1.guide?.stops.map(x => x.ref), ['P1']);
  assert.equal(d1.reason, null);
  const g2 = await call('/scan/guide', { searchId: s.searchId }, 'rep-ai', { advisorEnabled: true });
  assert.deepEqual(dataOf(g2), d1, 'النتيجة نفسها');
  assert.equal(llmCalls, 1);
  assert.equal(usage.count('reserve', 'chatTurns'), 1);
  assert.equal(usage.count('refund', 'chatTurns'), 0);
  // مسحٌ لا تعرفه الجلسة ⇒ 409 (الشاشة تبقي الحتمي)
  const stale = await call('/scan/guide', { searchId: randomUUID() }, 'rep-ai', { advisorEnabled: true });
  assert.equal(stale.res.statusCode, 409);
});

test('توجيه العقل: نفاد تحليلات اليوم ⇒ الحتمي بسببه بلا نداء؛ وتعذّر النموذج ⇒ الدورة تُردّ بيومها ولا تُعدّ «احتياطاً»', async () => {
  reset();
  llmCfg = { baseUrl: 'https://x', apiKey: 'k', model: 'm', extraBody: {}, timeoutMs: 1000, maxTokens: 100 };
  publicResult = { ok: true, partial: false, codes: [], places: [pub('ChIJaa00000001', 100)] };
  usage.deny.add('chatTurns');
  const s = dataOf<ScanData>(await scan('rep-quota', { advisorEnabled: true }));
  const q = dataOf<{ guide: unknown; reason: string }>(await call('/scan/guide', { searchId: s.searchId }, 'rep-quota', { advisorEnabled: true }));
  assert.deepEqual([q.guide, q.reason], [null, 'AI_QUOTA']);
  assert.equal(llmCalls, 0);

  reset();
  llmCfg = { baseUrl: 'https://x', apiKey: 'k', model: 'm', extraBody: {}, timeoutMs: 1000, maxTokens: 100 };
  publicResult = { ok: true, partial: false, codes: [], places: [pub('ChIJaa00000001', 100)] };
  llmReply = () => ({ ok: false, code: 'LLM_RATE_LIMIT', status: 429 });
  try {
    const s2 = dataOf<ScanData>(await scan('rep-llm-err', { advisorEnabled: true }));
    const e = dataOf<{ guide: unknown; reason: string }>(await call('/scan/guide', { searchId: s2.searchId }, 'rep-llm-err', { advisorEnabled: true }));
    assert.deepEqual([e.guide, e.reason], [null, 'AI_UNAVAILABLE']);
    assert.deepEqual(usage.log.filter(x => x.field === 'chatTurns'), [{ op: 'reserve', field: 'chatTurns' }, { op: 'refund', field: 'chatTurns', day: DAY }]);
    assert.equal(usage.added.reduce((n, a) => n + (a.guardFallback ?? 0), 0), 0, 'تعذّر النداء ليس رفضاً من الحارس');
  } finally {
    llmReply = () => ({
      ok: true, content: JSON.stringify({ summary: 'ابدأ بالأقرب', plan: [{ ref: 'P1', why: 'الأقرب إليك' }] }),
      toolCalls: [], usage: { promptTokens: 5, completionTokens: 2, cachedTokens: 0 }, finishReason: 'stop',
    });
  }
});

test('توجيه العقل: منطقة بلا فرصة ولا متابعة ⇒ لا نداء ثانٍ', async () => {
  reset();
  llmCfg = { baseUrl: 'https://x', apiKey: 'k', model: 'm', extraBody: {}, timeoutMs: 1000, maxTokens: 100 };
  publicResult = { ok: true, partial: false, codes: [], places: [pub('ChIJmine0000001', 200)] };
  db.customers = [{ id: 'c1', ...north(200), outletType: 'GROCERY', aiPlaceId: 'ChIJmine0000001' }];
  const s = dataOf<ScanData>(await scan('rep-no-cands', { advisorEnabled: true }));
  assert.equal(s.items[0].relation, 'CUSTOMER');
  assert.equal(s.aiGuidePending, false);
});

// ───────────── الدراسة ─────────────

test('الدراسة: محلٌّ من المسح بمرجعه وبلا خصم من المسح اليومي (حتى عشرة لكل مسح)، وغيره بحصة تُردّ إن تعذّرت Google', async () => {
  reset();
  placesKey = 'k';
  const ids = Array.from({ length: 12 }, (_, i) => `ChIJshop${String(i).padStart(6, '0')}`);
  nearby = async () => ({ ok: true, places: ids.map((id, i) => ({ placeId: id, name: `محل ${i}`, address: null, ...north(100 + i * 50), primaryType: 'grocery_store', types: ['grocery_store'] })) });
  const s = dataOf<ScanData>(await scan('rep-study'));
  assert.equal(s.source, 'PLACES');
  usage.reset();
  const first = await call('/study', { placeId: ids[3], searchId: s.searchId, gps: O }, 'rep-study');
  assert.equal(first.err, null);
  const d = dataOf<{ searchId: string; item: { ref: string }; study: { source: string }; aiQuota: boolean; searchesLeft: number; profile: { rating: number } }>(first);
  assert.equal(d.searchId, s.searchId, 'الجلسة نفسها');
  assert.equal(d.item.ref, s.items.find(i => i.placeId === ids[3])!.ref, 'مرجع المسح (خطة التوجيه تشير إليه)');
  assert.equal(d.study.source, 'RULES');
  assert.equal(d.profile.rating, 4.2);
  assert.equal(d.aiQuota, false);
  assert.equal(typeof d.searchesLeft, 'number');
  assert.equal(usage.count('reserve', 'searches'), 0, 'محل المسح لا يُخصم');
  // إعادة دراسته لا تُحسب، وعشرة محلات مجاناً ثم الحادي عشر بالحصة
  await call('/study', { placeId: ids[3], searchId: s.searchId }, 'rep-study');
  for (const id of ids.slice(0, 10)) await call('/study', { placeId: id, searchId: s.searchId }, 'rep-study');
  assert.equal(usage.count('reserve', 'searches'), 0);
  await call('/study', { placeId: ids[10], searchId: s.searchId }, 'rep-study');
  assert.equal(usage.count('reserve', 'searches'), 1, 'فوق العشرة بحصة المسح');
  // محلٌّ خارج المسح وتعذّرت Google ⇒ حجزٌ ثم ردٌّ بيومه
  usage.reset();
  profileFail = { code: 'PLACES_UNAVAILABLE', message: 'غير متاحة' };
  const off = await call('/study', { placeId: 'ChIJoutside00001', searchId: s.searchId }, 'rep-study');
  assert.equal(off.res.statusCode, 502);
  assert.deepEqual(usage.log.filter(x => x.field === 'searches'), [{ op: 'reserve', field: 'searches' }, { op: 'refund', field: 'searches', day: DAY }]);
});

test('الدراسة بالعقل: نفاد تحليلات اليوم ⇒ الدراسة الحتمية وaiQuota للمندوب؛ وبالحصة منتجات الأولوية تصل النموذج', async () => {
  reset();
  placesKey = 'k';
  llmCfg = { baseUrl: 'https://x', apiKey: 'k', model: 'm', extraBody: {}, timeoutMs: 1000, maxTokens: 100 };
  usage.deny.add('chatTurns');
  const q = dataOf<{ study: { source: string }; aiQuota: boolean }>(await call('/study', { placeId: 'ChIJquota000001' }, 'rep-study-q', { advisorEnabled: true }));
  assert.equal(q.study.source, 'RULES');
  assert.equal(q.aiQuota, true);
  assert.equal(llmCalls, 0);
  // بالحصة: دراسة العقل، ومنتجات الأولوية في حقلها من مدخله
  usage.reset();
  const prev = llmReply;
  llmReply = () => ({
    ok: true, content: JSON.stringify({ summary: 'بقالة حيّ نشطة', offer: ['مياه'] }),
    toolCalls: [], usage: { promptTokens: 5, completionTokens: 2, cachedTokens: 0 }, finishReason: 'stop',
  });
  try {
    const a = dataOf<{ study: { source: string; offer: string[] }; aiQuota: boolean }>(
      await call('/study', { placeId: 'ChIJquota000002' }, 'rep-study-q', { advisorEnabled: true, priorityProductIds: ['p1'] }));
    assert.deepEqual([a.study.source, a.study.offer, a.aiQuota], ['AI', ['مياه'], false]);
    assert.match(llmSent, /"priority_products":\["مياه"\]/);
    assert.equal(usage.count('refund', 'chatTurns'), 0);
  } finally { llmReply = prev; }
});

// ───────────── لغة المندوب وبلد الشركة ─────────────

test('لغة المندوب: المسح يحمل وقائع التوجيه والدراسة الحتميين، وتوجيه العقل يُطلب بلغة المسح (غير المعروفة عربية)، والبحث العام ببلد الشركة', async () => {
  reset();
  llmCfg = { baseUrl: 'https://x', apiKey: 'k', model: 'm', extraBody: {}, timeoutMs: 1000, maxTokens: 100 };
  publicResult = { ok: true, partial: false, codes: [], places: [pub('ChIJaa00000001', 100), pub('ChIJbb00000001', 300)] };
  const r = await call('/scan', { ...O, accuracyM: 10, lang: 'tr' }, 'rep-lang', { advisorEnabled: true }, 'AE');
  const s = dataOf<ScanData & { guide: { facts?: { shops: number }; stops: { f?: { distanceM: number } }[] }; items: { study: { facts?: { activityN?: number } } }[] }>(r);
  assert.equal(publicCalls[0].country, 'AE');
  assert.equal(s.guide.facts?.shops, 2);
  assert.ok(s.guide.stops.every(st => st.f && st.f.distanceM > 0), 'لكل محطة وقائعها');
  assert.equal(s.items[0].study.facts?.activityN, 50);
  await call('/scan/guide', { searchId: s.searchId }, 'rep-lang', { advisorEnabled: true });
  assert.match(llmSystem, /لغة الإجابة: اكتب كل نصوص الرد بـالتركية/);
  // لغة غير معروفة ⇒ العربية السعودية (بلا سطر لغة)، لا رفض للمسح
  const x = dataOf<ScanData>(await call('/scan', { ...O, accuracyM: 10, lang: 'xx' }, 'rep-lang-x', { advisorEnabled: true }));
  await call('/scan/guide', { searchId: x.searchId }, 'rep-lang-x', { advisorEnabled: true });
  assert.doesNotMatch(llmSystem, /لغة الإجابة/);
});

test('أخطاء برموزها: حدّ المسح اليومي يحمل الحدّ نفسه (limit) لتركّب الواجهة رسالته بلغة المندوب، والدراسة بالعقل بلغته', async () => {
  reset();
  usage.deny.add('searches');
  const r = await scan('rep-limit', { dailySearchesPerRep: 12 });
  assert.equal(r.res.statusCode, 429);
  assert.deepEqual([r.res.body?.code, r.res.body?.limit], ['AI_REP_DAILY_LIMIT', 12]);
  placesKey = 'k';
  const st = await call('/study', { placeId: 'ChIJlimit00001' }, 'rep-limit', { dailySearchesPerRep: 12 });
  assert.deepEqual([st.res.statusCode, st.res.body?.code, st.res.body?.limit], [429, 'AI_REP_DAILY_LIMIT', 12]);

  reset();
  placesKey = 'k';
  llmCfg = { baseUrl: 'https://x', apiKey: 'k', model: 'm', extraBody: {}, timeoutMs: 1000, maxTokens: 100 };
  const prev = llmReply;
  llmReply = () => ({
    ok: true, content: JSON.stringify({ summary: '杂货店，营业中。' }),
    toolCalls: [], usage: { promptTokens: 5, completionTokens: 2, cachedTokens: 0 }, finishReason: 'stop',
  });
  try {
    const d = dataOf<{ study: { source: string; summary: string; teamTipKey: string | null } }>(
      await call('/study', { placeId: 'ChIJlang000001', lang: 'zh' }, 'rep-study-zh', { advisorEnabled: true }));
    assert.match(llmSystem, /لغة الإجابة: اكتب كل نصوص الرد بـالصينية المبسّطة/);
    assert.deepEqual([d.study.source, d.study.summary, d.study.teamTipKey], ['AI', '杂货店，营业中。', null]);
  } finally { llmReply = prev; placesKey = null; }
});
