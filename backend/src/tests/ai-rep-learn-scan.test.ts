// حلقة التعلّم في المسح الحالي: دورة توجيه لكل مسح (مرّة لكل بحث وبحدّ دقيقتين للمندوب) بميزات Google، وتسميتها ليلاً
// بنتائج زيارات المندوب نفسه بمعرّف المكان خلال ٧٢ ساعة، والذراعان (الضابطة/المتعلّمة) يختلف ترتيبهما حين تختلف السياسة،
// والدروس في تعليمات العقل وسطر «من تجربة فريقك» بلا عقل. معالج المسار فوق وحدات مزيّفة، بلا قاعدة ولا Google.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Router } from 'express';
import type { Learned, AiLessonLite, PolicyParams } from '../ai-rep/learn/types';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

let aiTurnFound: { id: string } | null = null;
const aiTurnWhere: unknown[] = [];
stub('config/database', {
  default: {
    customer: { findMany: async () => [] },
    aiOutlet: { findMany: async () => [] },
    aiTurn: { findFirst: async (a: { where: unknown }) => { aiTurnWhere.push(a.where); return aiTurnFound; } },
  },
});
const pass = (_req: unknown, _res: unknown, next: () => void) => next();
stub('middleware/auth', {
  authenticate: pass, requireAdmin: pass, requireSalesRep: pass,
  requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user!.tenantId!,
});
stub('services/customerScope', { customerScope: async () => ({}), isolationEnabled: async () => false });
stub('services/adminScope', { adminScopeEnabled: async () => false });
stub('ai-rep/estimateData', { loadEstimateData: async () => ({}), invalidateEstimateData: () => undefined, tenantTimezone: async () => 'Asia/Riyadh' });
stub('ai-rep/usage', {
  usageDay: () => '2026-09-30', usageToday: async () => null, addUsage: async () => undefined,
  reserveUsage: async () => true, refundUsage: async () => undefined,
});

// العقل: غير مضبوط إلا في اختبار الدروس المحقونة (llmCfg)، ورده خطة من أقرب محل — قبل أي وحدة تستورده (publicMaps ← scanGuide)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realLlm = require('../ai-rep/llm') as typeof import('../ai-rep/llm');
let llmCfg: import('../ai-rep/llm').LlmConfig | null = null;
const llmSystems: string[] = [];
stub('ai-rep/llm', {
  ...realLlm, llmConfig: () => llmCfg,
  chatCompletion: async (_c: unknown, req: { messages: { content: string }[] }) => {
    llmSystems.push(req.messages[0].content);
    return { ok: true, content: JSON.stringify({ summary: 'ابدأ بالأقرب', plan: [{ ref: 'P1', why: 'الأقرب إليك' }] }), usage: { promptTokens: 5, completionTokens: 2, cachedTokens: 0 } };
  },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const realPlaces = require('../ai-rep/places') as typeof import('../ai-rep/places');
let placesKey: string | null = null;
let profile: Record<string, unknown> = {};
stub('ai-rep/places', { ...realPlaces, placesApiKey: () => placesKey, placeProfile: async () => ({ ok: true, profile }) });

// المسح العام (بلا مفتاح): ستة محلات بقالة على ١٠٠…٦٠٠ م وميني ماركت على ١٤٠٠ م — كلها بتقييم ٤ من ٥٠ مقيّماً
const O = { lat: 24.7, lng: 46.7 };
const at = (m: number) => ({ lat: O.lat + m / 111195, lng: O.lng });
const place = (id: string, m: number, type: string) => ({
  placeId: id, featureId: null, name: `محل ${id}`, rating: 4, ratingCount: 50, ...at(m), categories: [type === 'GROCERY' ? 'بقالة' : 'ميني ماركت'],
  address: null, openText: null, openNow: true, hours: [], closed: false, type,
});
const PLACES = [
  ...[100, 200, 300, 400, 500, 600].map((m, i) => place(`ChIJgrocery0${i + 1}`, m, 'GROCERY')),
  place('ChIJminimarket1', 1400, 'MINIMARKET'),
];
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realMaps = require('../ai-rep/publicMaps') as typeof import('../ai-rep/publicMaps');
stub('ai-rep/publicMaps', {
  ...realMaps, repRetryLeftMs: () => 0, notePublicScanShops: () => undefined, noteRepScanFailed: () => undefined,
  publicScan: async () => ({ ok: true, places: PLACES, partial: false, codes: [] }),
});

// حلقة التعلّم: ما تعلّمته الشركة (يضبطه كل اختبار) وسجلّ الدورات المسجّلة
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realStore = require('../ai-rep/learn/store') as typeof import('../ai-rep/learn/store');
const T = require('../ai-rep/learn/types') as typeof import('../ai-rep/learn/types');
let learned: Learned = { ...T.EMPTY_LEARNED };
const turns: import('../ai-rep/learn/store').TurnRecord[] = [];
// توجيه العقل يصل بنداء ثانٍ (/scan/guide) فيحدّث دورة المسح نفسها
stub('ai-rep/learn/store', {
  ...realStore, getLearned: async () => learned, recordTurn: async (t: import('../ai-rep/learn/store').TurnRecord) => { turns.push(t); },
  updateTurn: async (_tid: string, _rep: string, id: string, patch: Partial<import('../ai-rep/learn/store').TurnRecord>) => { const t = turns.find(x => x.id === id); if (t) Object.assign(t, patch); },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require('../routes/aiRep') as typeof import('../routes/aiRep');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SG = require('../ai-rep/scanGuide') as typeof import('../ai-rep/scanGuide');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const P = require('../ai-rep/learn/policy') as typeof import('../ai-rep/learn/policy');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const L = require('../ai-rep/learn/lessons') as typeof import('../ai-rep/learn/lessons');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PS = require('../ai-rep/profileStudy') as typeof import('../ai-rep/profileStudy');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const J = require('../ai-rep/learn/jobs') as typeof import('../ai-rep/learn/jobs');
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
const settings = (o: Record<string, unknown> = {}) => ({
  dailySearchesPerRep: 30, dailyChatTurnsPerRep: 30, searchRadiusM: 2000, targetOutletTypes: ['GROCERY', 'MINIMARKET'],
  advisorEnabled: false, playbook: null, learningMode: 'AUTO', holdoutPct: 0, ...o,
});
async function call(p: string, body: unknown, repId: string, s: Record<string, unknown> = {}) {
  const res = mockRes();
  let err: unknown = null;
  const ctx = { tid: 't1', repId, showMoney: false, countryCode: 'SA', settings: settings(s) };
  await handler('post', p)({ body, user: { role: 'SALES_REP', id: repId, tenantId: 't1' }, aiRep: ctx }, res, (e?: unknown) => { err = e ?? null; });
  if (err) throw err;
  return res;
}
type ScanBody = {
  data: {
    searchId: string; turnId: string | null;
    guide: { stops: { ref: string }[]; tip?: string | null; turnId: string | null; learned: boolean };
    items: { ref: string; placeId: string; outletType: string; study: { teamTip?: string | null } }[];
  };
};
const scan = async (repId: string, s: Record<string, unknown> = {}) => (await call('/scan', { lat: O.lat, lng: O.lng, accuracyM: 10 }, repId, s)).body as unknown as ScanBody;

const lesson = (o: Partial<AiLessonLite>): AiLessonLite => ({
  id: 'l1', key: 'OBJ:GROCERY:PRICE', kind: 'FIELD', origin: 'STATS', outletType: 'GROCERY', intent: null, status: 'ACTIVE', n: 40,
  textAr: 'في «بقالة» من أكثر الاعتراضات التي يواجهها مناديب شركتك: «السعر مرتفع» — ركّز على هامش ربحه.', ...o,
});
const policy = (o: Partial<PolicyParams>): PolicyParams => ({ ...T.SCAN_DEFAULT_POLICY, confW: { ...T.SCAN_DEFAULT_POLICY.confW }, ...o });

// ───────────── التسجيل ─────────────

test('كل مسح دورة توجيه بميزات Google (مرّة لكل بحث) — و«حدّث» خلال دقيقتين لا يسجّل دورة ثانية', async () => {
  learned = { ...T.EMPTY_LEARNED };
  turns.length = 0;
  const a = await scan('rep-rate');
  assert.equal(turns.length, 1, 'دورة واحدة للمسح الأول');
  const t = turns[0];
  assert.equal(t.kind, 'GUIDE');
  assert.equal(t.source, 'RULES');
  assert.equal(t.arm, 'LEARNED');
  assert.equal(t.policyVersion, 0);
  assert.equal(a.data.turnId, t.id);
  assert.equal(a.data.guide.turnId, t.id, 'معرّف الدورة داخل التوجيه (يُحفظ في جلسة الشاشة) لتقييم 👍/👎');
  const cands = t.candidates as import('../ai-rep/learn/types').CandFeature[];
  assert.equal(cands.length, 7);
  assert.ok(cands.every(f => f.fs === T.SCAN_FS && f.o === 1 && f.c === 'MEDIUM'), 'مخطّط المسح: الثقة من عدد المقيّمين والفتح الآن');
  assert.deepEqual(new Set(cands.map(f => f.p)), new Set(PLACES.map(p => p.placeId)), 'معرّف Google لكل مرشّح (للربط بالنتائج)');
  assert.deepEqual(cands.map(f => f.rr), [1, 2, 3, 4, 5, 6, 7]);
  const planned = cands.filter(f => f.fr > 0).sort((x, y) => x.fr - y.fr).map(f => f.p);
  const byRef = new Map(a.data.items.map(it => [it.ref, it.placeId]));
  assert.deepEqual(planned, a.data.guide.stops.map(s => byRef.get(s.ref)), 'fr = موضع المحل في الخطة المعروضة');
  assert.ok(!('lat' in cands[0]) && !('name' in cands[0]), 'بلا إحداثيات ولا أسماء');

  const b = await scan('rep-rate');
  assert.notEqual(b.data.searchId, a.data.searchId);
  assert.equal(turns.length, 1, 'المسح الثاني خلال دقيقتين لا يُسجَّل');
  assert.equal(b.data.turnId, null);
  assert.equal(b.data.guide.turnId, null, 'بلا دورة ⇒ لا تقييم');
  // مندوب آخر لا يشاركه الحدّ
  await scan('rep-other');
  assert.equal(turns.length, 2);
});

test('حدّ دورات المسح: دقيقتان لكل مندوب ثم يُسجَّل من جديد', () => {
  const t0 = 1_800_000_000_000;
  assert.equal(mod.claimScanTurn('t9|r9', t0), true);
  assert.equal(mod.claimScanTurn('t9|r9', t0 + 60_000), false);
  assert.equal(mod.claimScanTurn('t9|r8', t0 + 60_000), true, 'لكل مندوب حدّه');
  assert.equal(mod.claimScanTurn('t9|r9', t0 + mod.SCAN_TURN_GAP_MS), true);
});

// ───────────── التسمية الليلية ─────────────

test('التسمية الليلية: دورات المسح وحدها (لا دورات /guide القديمة) تُربط بنتائج المندوب نفسه بمعرّف المكان خلال ٧٢ ساعة', () => {
  const t0 = new Date('2026-09-01T08:00:00Z');
  const h = (x: number) => new Date(t0.getTime() + x * 3600_000);
  const f = (p: string, fr: number, rr: number) => ({ p, t: 'GROCERY', b: 0, c: 'HIGH', v: 1.1, lo: 'N', rr, fr, o: 1, fs: T.SCAN_FS });
  const rows = [
    { id: 'scan', salesRepId: 'r1', createdAt: t0, arm: 'LEARNED', policyVersion: 0, hourBand: 0, candidates: [f('A', 1, 1), f('B', 2, 2), f('C', 0, 3), f('D', 0, 4)] },
    // دورة /guide قديمة: v قيمة مالية من التوقّع وبلا مخطّط ⇒ لا تُسمّى
    { id: 'legacy', salesRepId: 'r1', createdAt: t0, arm: 'LEARNED', policyVersion: 0, hourBand: 0, candidates: [{ p: 'A', t: 'GROCERY', b: 0, c: 'HIGH', v: 5400, lo: 'N', rr: 1, fr: 1 }] },
    { id: 'mixed', salesRepId: 'r1', createdAt: t0, arm: 'LEARNED', policyVersion: 0, hourBand: 0, candidates: [f('A', 1, 1), { p: 'B', t: 'GROCERY', b: 0, c: 'HIGH', v: 9, lo: 'N', rr: 2, fr: 0 }] },
    { id: 'none', salesRepId: 'r1', createdAt: t0, arm: 'LEARNED', policyVersion: 0, hourBand: 0, candidates: null },
  ];
  const planTurns = P.scanPlanTurns(rows);
  assert.deepEqual(planTurns.map(t => t.id), ['scan']);
  assert.equal(planTurns[0].hb, 0, 'فترة اليوم كما خُدمت');
  const ev = (rep: string, placeId: string, kind: string, x: number, atDoor: boolean | null = null) => ({ rep, placeId, kind, occurredAt: h(x), atDoor, convertedAt: null });
  const events = [
    ev('r1', 'A', 'QUOTE', 5, true), // المندوب نفسه خلال ٧٢ ساعة عند الباب
    ev('r1', 'B', 'INTERESTED', 80), // بعد ٧٢ ساعة ⇒ المحطة المخطّطة «متخطّاة»
    ev('r2', 'C', 'INTERESTED', 1), // مندوب آخر ⇒ لا يُحسب
    ev('r1', 'D', 'NOT_INTERESTED', 10),
    ev('r1', 'A', 'INTERESTED', -1), // قبل الدورة ⇒ لا يُحسب
  ];
  const labels = P.buildPlanLabels(planTurns, events).get('scan')!;
  const byP = new Map(labels.map(l => [l.p, l]));
  assert.deepEqual(byP.get('A'), { p: 'A', u: 0.7, w: 1, wasted: false });
  assert.deepEqual(byP.get('B'), { p: 'B', u: 0, w: 0.5, wasted: false });
  assert.equal(byP.has('C'), false, 'غير مخطّط ولم يزره المندوب نفسه');
  assert.deepEqual(byP.get('D'), { p: 'D', u: 0, w: 0.7, wasted: false });
  // الأزواج تُبنى فتتعلّم السياسة: A (عرض سعر) فوق D (رفض)، والمتابعة والمغلق الآن من الميزات نفسها
  const c = P.concordance(planTurns, P.buildPlanLabels(planTurns, events), T.SCAN_DEFAULT_POLICY);
  assert.ok(c.pairs >= 2, `أزواج: ${c.pairs}`);
  const arms = P.armAggregates(planTurns, P.buildPlanLabels(planTurns, events));
  assert.equal(arms.LEARNED.planned, 2);
  assert.equal(arms.LEARNED.visited, 1);
});

test('نقاط الليلة على ميزات المسح = نقاط الترتيب الحيّ: المغلق الآن ×٠٫٣٥ والمتابعة ×١٫٢٥، وسياسة المسح الافتراضية = shopScore', () => {
  const shop = (o: Partial<import('../ai-rep/scanGuide').ScanShop>): import('../ai-rep/scanGuide').ScanShop => ({
    ref: 'P1', placeId: 'ChIJx', outletType: 'GROCERY', name: 'x', category: null, rating: 4.4, ratingCount: 300, openNow: true,
    distanceM: 450, lat: 0, lng: 0, relation: 'NEW', rejectedRecently: false, ...o,
  });
  const learnedDefault = SG.learnedScorer(T.SCAN_DEFAULT_POLICY, 2);
  for (const s of [shop({}), shop({ openNow: false }), shop({ rating: null, ratingCount: null }), shop({ lastOutcome: 'QUOTE', lastOutcomeAt: '2026-01-01T00:00:00Z' })]) {
    assert.ok(Math.abs(learnedDefault(s) - SG.baselineScore(s)) < 1e-12, JSON.stringify(s));
    // منتصف الشريحة (٤٥٠ م = الشريحة ١) هو المسافة نفسها هنا ⇒ الليلة تطابق الحيّ
    const f = { ...SG.scanFeature(s), rr: 1, fr: 0 };
    assert.ok(Math.abs(P.scoreFeature(f, T.SCAN_DEFAULT_POLICY, 2) - SG.baselineScore(s)) < 1e-12);
  }
  // تقييم ٣ من خمسة مقيّمين يُشدّ نحو المتوسّط (درجة ١)، ومن ٤٠٠ مقيّم يبقى (٠٫٨٥)؛ الفتح المجهول بلا o
  assert.deepEqual(SG.scanFeature(shop({ rating: 3, ratingCount: 5, openNow: null })), { p: 'ChIJx', t: 'GROCERY', b: 1, c: 'LOW', v: 1, lo: 'N', fs: T.SCAN_FS });
  assert.equal(SG.scanFeature(shop({ rating: 3, ratingCount: 400 })).v, 0.85);
  assert.equal(SG.ratingConf({ rating: 4, ratingCount: 0 }), 'NONE');
  assert.equal(SG.ratingConf({ rating: 4, ratingCount: 150 }), 'HIGH');
});

// ───────────── الذراعان ─────────────

test('الذراعان: بلا سياسة متعلَّمة الترتيب واحد، وبسياسة مرقّاة تختلف الخطة في الذراع المتعلّمة وحدها', async () => {
  turns.length = 0;
  learned = { ...T.EMPTY_LEARNED };
  const plain = await scan('rep-arm-1');
  // سياسة مرقّاة تضاعف قبول الميني ماركت ثلاثاً (من نتائج الزيارات) ⇒ البعيد يدخل الخطة
  learned = { ...T.EMPTY_LEARNED, policy: { version: 3, params: policy({ typeMult: { MINIMARKET: 3 } }) } };
  const learnedArm = await scan('rep-arm-2');
  const baseline = await scan('rep-arm-3', { learningMode: 'OFF' });
  const stopsOf = (b: ScanBody) => {
    const byRef = new Map(b.data.items.map(it => [it.ref, it]));
    return new Set(b.data.guide.stops.map(s => byRef.get(s.ref)!.placeId));
  };
  assert.ok(!stopsOf(plain).has('ChIJminimarket1'));
  assert.ok(stopsOf(learnedArm).has('ChIJminimarket1'), 'الذراع المتعلّمة: الميني ماركت في الخطة');
  assert.ok(!stopsOf(learnedArm).has('ChIJgrocery06'));
  assert.deepEqual(stopsOf(baseline), stopsOf(plain), 'الذراع الضابطة: ترتيب ما قبل التعلّم');
  assert.equal(learnedArm.data.guide.learned, true);
  assert.equal(baseline.data.guide.learned, false);
  const [tPlain, tLearned, tBase] = turns;
  assert.deepEqual([tPlain.arm, tLearned.arm, tBase.arm], ['LEARNED', 'LEARNED', 'BASELINE']);
  assert.deepEqual([tPlain.policyVersion, tLearned.policyVersion, tBase.policyVersion], [0, 3, 0]);
  const rrOf = (t: typeof tPlain, p: string) => (t.candidates as { p: string; rr: number }[]).find(f => f.p === p)!.rr;
  assert.equal(rrOf(tBase, 'ChIJminimarket1'), 7);
  assert.equal(rrOf(tLearned, 'ChIJminimarket1'), 3, 'rr = الرتبة بسياسة الذراع');

  // وحدةً: ترتيب المرشّحين بالسياستين
  const shops = PLACES.map((p, i) => ({
    ref: `P${i + 1}`, placeId: p.placeId, outletType: p.type, name: p.name, category: null, rating: 4, ratingCount: 50, openNow: true,
    distanceM: Math.round((p.lat - O.lat) * 111195), lat: p.lat, lng: p.lng, relation: 'NEW' as const, rejectedRecently: false,
  }));
  const now = new Date();
  const base = SG.rankedPool(shops, now, SG.baselineScore).map(x => x.s.ref);
  const same = SG.rankedPool(shops, now, SG.learnedScorer(T.SCAN_DEFAULT_POLICY, 0)).map(x => x.s.ref);
  const diff = SG.rankedPool(shops, now, SG.learnedScorer(policy({ typeMult: { MINIMARKET: 3 } }), 0)).map(x => x.s.ref);
  assert.deepEqual(same, base, 'السياسة نفسها ⇒ الترتيب نفسه');
  assert.notDeepEqual(diff, base, 'سياسة مختلفة ⇒ ترتيب مختلف');
  assert.equal(diff[2], 'P7');
  // أُسّ المسافة المتعلَّم يغيّر الترتيب أيضاً: أثر مسافة أضعف ⇒ الأعلى تقييماً البعيد يتقدّم
  const mixed = [{ ...shops[0], rating: 3, ratingCount: 400 }, { ...shops[3], rating: 4.6, ratingCount: 400 }];
  assert.deepEqual(SG.rankedPool(mixed, now, SG.baselineScore).map(x => x.s.ref), ['P1', 'P4']);
  assert.deepEqual(SG.rankedPool(mixed, now, SG.learnedScorer(policy({ alpha: 0.6 }), 0)).map(x => x.s.ref), ['P4', 'P1']);
});

// ───────────── الدروس ─────────────

test('درس إحصاء فعّال يظهر للمندوب بلا عقل: سطر «من تجربة فريقك» في التوجيه وفي دراسة كل محل من نوعه — والذراع الضابطة بلا دروس', async () => {
  turns.length = 0;
  const obj = lesson({});
  learned = { ...T.EMPTY_LEARNED, lessons: [obj, lesson({ id: 'l2', key: 'REVISIT:MINIMARKET', outletType: 'MINIMARKET', textAr: 'في «ميني ماركت» كثير ممن طلبوا العودة لاحقاً تجاوبوا عند العودة — عُد إليهم في موعدهم ولا تُسقطهم.' })] };
  const r = await scan('rep-tip');
  assert.equal(r.data.guide.tip, obj.textAr);
  const g = r.data.items.find(it => it.outletType === 'GROCERY')!;
  const m = r.data.items.find(it => it.outletType === 'MINIMARKET')!;
  assert.equal(g.study.teamTip, obj.textAr);
  assert.match(m.study.teamTip ?? '', /ميني ماركت/);
  assert.deepEqual(new Set(turns[0].lessonIds), new Set(['l1', 'l2']), 'الدروس المعروضة مسجّلة (مطبَّق على المسح)');
  const off = await scan('rep-tip-2', { learningMode: 'OFF' });
  assert.equal(off.data.guide.tip, null);
  assert.equal(off.data.items[0].study.teamTip, null);
  assert.deepEqual(turns[1].lessonIds, []);
});

test('«مطبَّق على المسح» صادق: بلا عقل لا تُسجَّل إلا دروس السطر المعروض، وبالعقل تُسجَّل المحقونة في تعليماته', async () => {
  turns.length = 0;
  const obj = lesson({});
  // درس «العودة» للبقالة لا يظهر سطراً (الاعتراض أولى في الخطة والدراسة)
  const revisit = lesson({ id: 'l3', key: 'REVISIT:GROCERY', textAr: 'في «بقالة» كثير ممن طلبوا العودة لاحقاً تجاوبوا عند العودة — عُد إليهم في موعدهم ولا تُسقطهم.' });
  learned = { ...T.EMPTY_LEARNED, lessons: [obj, revisit] };
  await scan('rep-applied-1');
  assert.deepEqual(turns[0].lessonIds, ['l1'], 'بلا عقل: السطر المعروض وحده — لا ما اختير لتعليمات عقلٍ لم يُنادَ');
  assert.deepEqual(turns[0].heldOutIds, []);
  llmCfg = { provider: 'groq', apiKey: 'k', model: 'm', baseUrl: 'http://x' } as never;
  llmSystems.length = 0;
  try {
    const sc = await scan('rep-applied-2', { advisorEnabled: true });
    assert.equal(turns[1].source, 'RULES', 'المسح يعود بالخطة الحتمية فوراً');
    assert.equal((sc.data as unknown as { aiGuidePending: boolean }).aiGuidePending, true);
    await call('/scan/guide', { searchId: sc.data.searchId }, 'rep-applied-2', { advisorEnabled: true });
    assert.equal(turns[1].source, 'AI');
    assert.equal(turns[1].guard, 'PASS');
    assert.deepEqual(new Set(turns[1].lessonIds), new Set(['l1', 'l3']), 'بالعقل: الدروس المحقونة في تعليماته والسطر المعروض');
    assert.ok(llmSystems[0].includes(revisit.textAr), 'الدرس المسجَّل وصل تعليمات العقل فعلاً');
  } finally { llmCfg = null; }
});

test('الدراسة: دورة STUDY بلا مرشّحين، ومعرّفها في الرد للتقييم، وسطر «من تجربة فريقك» لنوع المحل', async () => {
  turns.length = 0;
  placesKey = 'test-key';
  profile = {
    placeId: 'ChIJstudyShop01', name: 'بقالة الحي', typeLabel: 'بقالة', primaryType: 'grocery_store', types: ['grocery_store'], address: null, ...at(120),
    mapsUri: null, rating: 4.2, ratingCount: 90, openNow: true, hours: [], priceLevel: null, reviews: [], closed: false,
  };
  learned = { ...T.EMPTY_LEARNED, lessons: [lesson({})] };
  try {
    const res = await call('/study', { placeId: 'ChIJstudyShop01', gps: O }, 'rep-study');
    const d = (res.body as { data: { turnId: string; study: { teamTip: string | null } } }).data;
    assert.equal(turns.length, 1);
    assert.equal(turns[0].kind, 'STUDY');
    assert.equal(turns[0].intent, 'STUDY');
    assert.equal(turns[0].source, 'RULES');
    assert.equal(turns[0].candidates, undefined);
    assert.deepEqual(turns[0].lessonIds, ['l1']);
    assert.equal(d.turnId, turns[0].id);
    assert.equal(d.study.teamTip, lesson({}).textAr);
  } finally { placesKey = null; }
});

test('الدروس تصل تعليمات العقل: التوجيه (مع الترتيب الموصى به) والدراسة — وبلا دروس التعليمات كما هي', async () => {
  const cfg = { provider: 'groq', apiKey: 'k', model: 'm', baseUrl: 'http://x' } as never;
  const block = L.renderLessonsBlock([lesson({})]);
  const shops = [
    { ref: 'P1', name: 'أ', category: null, rating: 4, openNow: true, distanceM: 100, lat: 0, lng: 0, relation: 'NEW' as const, rejectedRecently: false },
    { ref: 'P2', name: 'ب', category: null, rating: 4.5, openNow: true, distanceM: 300, lat: 0, lng: 0, relation: 'NEW' as const, rejectedRecently: false },
    { ref: 'P3', name: 'ج', category: null, rating: 4.5, openNow: true, distanceM: 300, lat: 0, lng: 0, relation: 'CUSTOMER' as const, rejectedRecently: false },
  ];
  const seen: { system: string; user: string }[] = [];
  const llm = (content: string) => (async (_c: unknown, req: { messages: { content: string }[] }) => {
    seen.push({ system: req.messages[0].content, user: req.messages[1].content });
    return { ok: true as const, content, usage: { promptTokens: 7, completionTokens: 3 } };
  }) as never;
  const reply = JSON.stringify({ summary: 'ابدأ بالأقرب', plan: [{ ref: 'P2', why: 'تقييمه 4.5' }, { ref: 'P1', why: 'يبيع 900 كرتون' }, { ref: 'P3', why: 'عميل' }] });
  const r = await SG.aiGuide(shops, { cfg, playbook: null, origin: { lat: 0, lng: 0 }, recommended: ['P2', 'P1', 'P3'], lessonsBlock: block, llm: llm(reply) });
  assert.ok(seen[0].system.startsWith(SG.GUIDE_SYSTEM_AR));
  assert.ok(seen[0].system.includes(lesson({}).textAr), 'الدرس في تعليمات التوجيه');
  assert.match(seen[0].system, /ما تعلّمته من تجارب شركتك/);
  assert.match(seen[0].user, /"recommended_order":\["P2","P1"\]/, 'الترتيب الموصى به من الفرص وحدها');
  // الحارس للحلقة: رقمٌ مخترع حُذف ⇒ TRIM، ومرجع غير مؤهّل ⇒ INELIGIBLE_REF
  assert.equal(r.source, 'AI');
  assert.equal(r.guard, 'TRIM');
  assert.deepEqual(r.badKinds, ['OTHER']);
  assert.deepEqual(r.flags, ['INELIGIBLE_REF']);
  await SG.aiGuide(shops, { cfg, playbook: null, origin: { lat: 0, lng: 0 }, llm: llm(reply) });
  assert.equal(seen[1].system, SG.GUIDE_SYSTEM_AR, 'بلا دروس ⇒ التعليمات الثابتة وحدها');
  const fail = await SG.aiGuide(shops, { cfg, playbook: null, origin: { lat: 0, lng: 0 }, llm: (async () => ({ ok: false, code: 'LLM_RATE_LIMIT' })) as never });
  assert.deepEqual([fail.guide, fail.source, fail.flags], [null, 'ERROR', ['LLM_ERROR']]);

  const p = {
    placeId: 'ChIJs', name: 'بقالة', typeLabel: 'بقالة', primaryType: null, types: [], address: null, lat: 0, lng: 0, mapsUri: null,
    rating: 4.2, ratingCount: 90, openNow: true, hours: [], priceLevel: null, reviews: [], closed: false,
  };
  const study = await PS.aiStudy(p, { cfg, products: [], playbook: null, lessonsBlock: block, llm: llm(JSON.stringify({ summary: 'محل متوسط النشاط', opening_line: 'السلام عليكم' })) });
  assert.ok(seen[2].system.startsWith(PS.STUDY_SYSTEM_AR));
  assert.ok(seen[2].system.includes(lesson({}).textAr), 'الدرس في تعليمات الدراسة');
  assert.equal(study.guard, 'PASS');
  assert.equal(study.source, 'AI');
  assert.equal(PS.ruleStudy(p, 'نص').teamTip, 'نص');
  assert.equal(PS.ruleStudy(p).teamTip, null);
});

test('اختيار الدروس للمسح والدراسة: ما يسمّي أداة المستشار لا يُحقن، وسطر «من تجربة فريقك» بأولوية الخطة والدراسة', () => {
  const tool = lesson({ id: 'tool', key: 'SELF:X', origin: 'SELF', kind: 'PROCESS', outletType: null, textAr: 'قبل أن تقترح كمية استدعِ outlet_estimate وانقل الطلب التجريبي كما ورد.' });
  const q = { turnId: 't', intent: 'GUIDE', types: new Set(['GROCERY']) };
  assert.ok(L.selectLessons([tool], q).injected.length === 1, 'المستشار القديم يبقى كما هو');
  assert.deepEqual(L.selectLessons([tool, lesson({})], { ...q, noTools: true }).injected.map(l => l.id), ['l1']);
  const obj = lesson({});
  const timeNow = lesson({ id: 'time2', key: 'TIME:GROCERY:2', textAr: 'محلات «بقالة» تُوجد مغلقة كثيراً في بعد الظهر — رتّب زيارتها في وقت آخر.' });
  const timeOther = lesson({ id: 'time0', key: 'TIME:GROCERY:0', textAr: 'محلات «بقالة» تُوجد مغلقة كثيراً في الصباح — رتّب زيارتها في وقت آخر.' });
  const mm = lesson({ id: 'mm', key: 'OBJ:MINIMARKET:PRICE', outletType: 'MINIMARKET' });
  const all = [mm, timeOther, obj, timeNow];
  assert.equal(L.statsHint(all, { types: ['GROCERY'], hb: 2, prefer: 'GUIDE' })?.id, 'time2', 'الخطة: الإغلاق في فترة الآن أولاً');
  assert.equal(L.statsHint(all, { types: ['GROCERY'], hb: 1, prefer: 'GUIDE' })?.id, 'l1', 'درس وقتٍ لفترة أخرى لا يُعرض');
  assert.equal(L.statsHint(all, { types: ['GROCERY'], hb: 2, prefer: 'STUDY' })?.id, 'l1', 'الدراسة: الاعتراض أولاً');
  assert.equal(L.statsHint(all, { types: ['MINIMARKET', 'GROCERY'], hb: 2, prefer: 'GUIDE' })?.id, 'mm', 'نوع أول محطة أولى');
  assert.equal(L.statsHint([{ ...obj, status: 'TRIAL' }, { ...obj, id: 'r', origin: 'REFLECTION' }], { types: ['GROCERY'], hb: 0, prefer: 'STUDY' }), null, 'الإحصاء الفعّال وحده');
  // نصوص القوالب لا تسمّي أدوات المستشار بعد الآن
  for (const t of [...Object.values(L.TACTIC), ...L.SELF_LIBRARY.filter(x => x.key === 'SELF:QTY_GROUNDING').map(x => x.textAr)]) {
    assert.ok(!/outlet_estimate|field_insights/.test(t), t);
    assert.deepEqual(L.validateLessonText(`في «بقالة» من أكثر الاعتراضات: ${t}`, { origin: 'STATS', playbook: null }), { ok: true }, t);
  }
});

test('المراجعة الذاتية تُتخطّى بلا ردود للعقل: الفحص على دورات العقل وحدها للشركة نفسها', async () => {
  aiTurnWhere.length = 0;
  aiTurnFound = null;
  const since = new Date('2026-09-01T00:00:00Z');
  assert.equal(await J.hasAiTurns('t1', since), false);
  assert.deepEqual(aiTurnWhere[0], { tenantId: 't1', source: 'AI', createdAt: { gte: since } });
  aiTurnFound = { id: 'x' };
  assert.equal(await J.hasAiTurns('t1', since), true);
});
