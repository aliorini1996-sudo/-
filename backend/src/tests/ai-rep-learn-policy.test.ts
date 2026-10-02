// المندوب الذكي — حلقة التعلّم: «يتعلّم من خططه» (ترتيب الفرص): قفل الانحدار، والتسميات، والتوافق، والملاءمة،
// والبوابة، والتراجع، والذراع. فوق Prisma مزيّف، بلا قاعدة ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { EstimateResult } from '../ai-rep/estimate';
import type { PlanCandidate } from '../ai-rep/guide';
import type { CandFeature, FieldStats, FieldTypeStats, PolicyParams } from '../ai-rep/learn/types';
import type { ArmAgg, Label, PlanEvent, PlanTurn } from '../ai-rep/learn/policy';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
let rawCalls: Array<{ strings: readonly string[]; values: unknown[] }> = [];
let rawRows: unknown[] = [];
stub('config/database', { default: { $queryRaw: async (q: { strings: readonly string[]; values: unknown[] }) => { rawCalls.push(q); return rawRows; } } });

/* eslint-disable @typescript-eslint/no-var-requires */
const P = require('../ai-rep/learn/policy') as typeof import('../ai-rep/learn/policy');
const G = require('../ai-rep/guide') as typeof import('../ai-rep/guide');
const { orderStops } = require('../ai-rep/advisorTools') as typeof import('../ai-rep/advisorTools');
const { DEFAULT_POLICY } = require('../ai-rep/learn/types') as typeof import('../ai-rep/learn/types');
const { BAND_MID_KM } = require('../ai-rep/learn/signals') as typeof import('../ai-rep/learn/signals');
const { mulberry32 } = require('../ai-rep/learn/stats') as typeof import('../ai-rep/learn/stats');
/* eslint-enable @typescript-eslint/no-var-requires */

const pol = (o: Partial<PolicyParams> = {}): PolicyParams => ({ ...JSON.parse(JSON.stringify(DEFAULT_POLICY)), ...o });

// ───────────── قفل الانحدار: السياسة الافتراضية = معادلة ما قبل التعلّم ─────────────

const est = (confidence: 'HIGH' | 'MEDIUM' | 'LOW', median: number | null, pens: number[] = []): EstimateResult => ({
  ok: true, engineVersion: 'ai-est-1', outletType: 'GROCERY', ringKm: 2, peers: 12, medianTenureMonths: 6, confidence,
  window: { from: '2026-03', to: '2026-08' },
  monthlyTotalValue: median == null ? null : { low: median * 0.6, median, high: median * 1.5 },
  products: pens.map((p, i) => ({
    productId: `p${i}`, name: 'منتج', unit: 'كرتون', priority: false, buyers: 5, peers: 12, penetration: p,
    monthlyQty: null, monthlyValue: null, firstOrderQty: null, trialQty: null, trialQtyRaw: null, trialCalibrated: false, confidence, hidden: null,
  })),
  why: '',
});
const noEst = (): EstimateResult => ({
  ok: false, engineVersion: 'ai-est-1', outletType: 'GROCERY', reason: 'INSUFFICIENT_PEERS', eligiblePeers: 2, minPeers: 5,
  window: { from: '2026-03', to: '2026-08' }, why: '',
});
let seq = 0;
const cand = (ref: string, distanceM: number, estimate: EstimateResult, o: Partial<PlanCandidate> = {}): PlanCandidate => {
  seq++;
  return { ref, lat: 24.7 + (seq % 4) * 0.004, lng: 46.7 + (seq % 5) * 0.003, distanceM, relation: 'NEW', lastOutcome: null, estimate, outletType: seq % 2 ? 'GROCERY' : 'CAFE', ...o };
};

const FIX: PlanCandidate[] = [
  cand('P1', 250, est('HIGH', 900)),
  cand('P2', 400, est('MEDIUM', 1500)),
  cand('P3', 800, est('LOW', 3000), { lastOutcome: 'CALL_BACK' }),
  cand('P4', 1200, est('HIGH', 2500)),
  cand('P5', 150, noEst()),
  cand('P6', 600, est('MEDIUM', null, [0.4, 0.3, 0.2, 0.1]), { lastOutcome: 'INTERESTED' }),
  cand('P7', 2000, est('HIGH', 6000)),
  cand('P8', 300, est('HIGH', 9000), { relation: 'CUSTOMER' }),
  cand('P9', 350, est('HIGH', 9000), { lastOutcome: 'NOT_INTERESTED' }),
  cand('P10', 450, est('HIGH', 8000), { closed: true }),
  cand('P11', 3500, est('LOW', 500)),
  cand('P12', 700, est('MEDIUM', 4000), { relation: 'POSSIBLE_CUSTOMER' }),
];

// معادلة ما قبل التعلّم كما كانت: V · w / (0.3 + km)، w = {HIGH 1، MEDIUM 0.8، LOW 0.5} وبلا توقّع 0.4
const OLD_W: Record<string, number> = { HIGH: 1, MEDIUM: 0.8, LOW: 0.5 };
function oldValue(e: EstimateResult): number {
  if (!e.ok) return 1;
  if (e.monthlyTotalValue) return 1 + e.monthlyTotalValue.median;
  const top = e.products.filter(p => (p.buyers ?? 0) > 0 && p.penetration != null).slice(0, 3);
  return 1 + (top.length ? (top.reduce((s, p) => s + (p.penetration ?? 0), 0) / top.length) * 100 : 0);
}
const oldScore = (c: PlanCandidate): number => (oldValue(c.estimate) * (c.estimate.ok ? OLD_W[c.estimate.confidence] : 0.4)) / (0.3 + c.distanceM / 1000);
const OLD_REJECTED = new Set(['NOT_INTERESTED', 'EXCLUSIVE_SUPPLIER', 'CLOSED', 'CONVERTED']);
const oldEligible = (c: PlanCandidate) => c.relation === 'NEW' && !c.closed && !(c.lastOutcome && OLD_REJECTED.has(c.lastOutcome));
const oldRank = (cs: PlanCandidate[]) => cs.filter(oldEligible).sort((a, b) => oldScore(b) - oldScore(a) || a.distanceM - b.distanceM);

test('قفل الانحدار: scoreWith/rankCandidates/rulePlan بالسياسة الافتراضية = معادلة ما قبل التعلّم على ١٢ مرشّحاً', () => {
  for (const c of FIX) {
    assert.equal(G.opportunityScore(c), oldScore(c), c.ref);
    for (let hb = 0; hb < 5; hb++) assert.equal(G.scoreWith(c, DEFAULT_POLICY, hb), oldScore(c), `${c.ref}@${hb}`);
  }
  const ranked = oldRank(FIX);
  assert.equal(ranked.length, 8);
  assert.equal(new Set(ranked.map(oldScore)).size, ranked.length, 'بلا تعادل في النقاط');
  assert.deepEqual(G.rankCandidates(FIX, DEFAULT_POLICY, 0).map(c => c.ref), ranked.map(c => c.ref));
  assert.deepEqual(G.rankCandidates(FIX).map(c => c.ref), ranked.map(c => c.ref));
  const pool = ranked.slice(0, 5);
  const noOrigin = [...pool].sort((a, b) => a.distanceM - b.distanceM).map(c => c.ref);
  assert.deepEqual(G.rulePlan(FIX, null), noOrigin);
  assert.deepEqual(G.rulePlan(FIX, null, 5, DEFAULT_POLICY, 3), noOrigin);
  const origin = { lat: 24.7, lng: 46.7 };
  assert.deepEqual(G.rulePlan(FIX, origin, 5, DEFAULT_POLICY, 2), orderStops(origin, pool).map(c => c.ref));
  assert.deepEqual(G.rulePlan(FIX, origin, 3), orderStops(origin, ranked.slice(0, 3)).map(c => c.ref));
});

test('مضاعف النوع الأعلى يقدّم النوع، وخطر الإغلاق يؤخّر النوع المغلق عادةً في الفترة الحالية فقط', () => {
  const a = cand('A', 500, est('HIGH', 1000), { outletType: 'GROCERY' });
  const b = cand('B', 500, est('HIGH', 700), { outletType: 'CAFE' });
  assert.deepEqual(G.rankCandidates([a, b], DEFAULT_POLICY).map(c => c.ref), ['A', 'B']);
  assert.deepEqual(G.rankCandidates([a, b], pol({ typeMult: { CAFE: 1.5 } })).map(c => c.ref), ['B', 'A']);
  assert.deepEqual(G.rankCandidates([a, b], pol({ typeMult: { GROCERY: 0.6 } })).map(c => c.ref), ['B', 'A']);

  const closed = pol({ useClosed: true, closedRisk: { GROCERY: [0, 0, 0.5, 0, 0] } });
  assert.deepEqual(G.rankCandidates([a, b], closed, 2).map(c => c.ref), ['B', 'A'], 'بعد الظهر: البقالة مغلقة غالباً');
  assert.deepEqual(G.rankCandidates([a, b], closed, 0).map(c => c.ref), ['A', 'B'], 'الصباح: بلا خطر');
  assert.deepEqual(G.rankCandidates([a, b], { ...closed, useClosed: false }, 2).map(c => c.ref), ['A', 'B'], 'مطفأ ⇒ بلا أثر');
});

test('scoreFeature على الميزات المخزّنة يطابق scoreWith (km = منتصف الشريحة)', () => {
  const policies = [
    DEFAULT_POLICY,
    pol({ alpha: 1.2, confW: { HIGH: 1, MEDIUM: 0.7, LOW: 0.6, NONE: 0.3 }, typeMult: { CAFE: 1.3 } }),
    pol({ alpha: 0.6, useClosed: true, closedRisk: { GROCERY: [0.1, 0.2, 0.3, 0.4, 0.5] } }),
  ];
  const confs = ['HIGH', 'MEDIUM', 'LOW', 'NONE'] as const;
  for (const p of policies) {
    for (let b = 0; b < BAND_MID_KM.length; b++) {
      for (const c of confs) {
        for (const t of ['GROCERY', 'CAFE']) {
          const v = 250 + b;
          const e = c === 'NONE' ? noEst() : est(c, v - 1);
          const pc = cand('X', BAND_MID_KM[b] * 1000, e, { outletType: t });
          const f: CandFeature = { p: 'x', t, b, c, v: c === 'NONE' ? 1 : v, lo: 'N', rr: 1, fr: 0 };
          for (let hb = 0; hb < 5; hb++) {
            const want = G.scoreWith(pc, p, hb), got = P.scoreFeature(f, p, hb);
            assert.ok(Math.abs(want - got) <= 1e-12 * Math.abs(want), `${t}/${c}/b${b}/hb${hb}: ${got} ≠ ${want}`);
          }
        }
      }
    }
  }
});

// ───────────── أدوات بناء الدورات ─────────────

const T0 = new Date('2026-09-01T07:00:00Z'); // ١٠ صباحاً بالرياض ⇒ الفترة ٠
const HOUR = 3600_000;
const feat = (p: string, o: Partial<CandFeature> = {}): CandFeature => ({ p, t: 'GROCERY', b: 1, c: 'HIGH', v: 100, lo: 'N', rr: 1, fr: 0, ...o });
const turn = (id: string, rep: string, candidates: CandFeature[], o: Partial<PlanTurn> = {}): PlanTurn =>
  ({ id, salesRepId: rep, createdAt: T0, arm: 'LEARNED', policyVersion: 0, candidates, ...o });
const ev = (rep: string, placeId: string, kind: string, hours: number, o: Partial<PlanEvent> = {}): PlanEvent =>
  ({ rep, placeId, kind, occurredAt: new Date(T0.getTime() + hours * HOUR), atDoor: null, convertedAt: null, ...o });
const lab = (p: string, u: number, w = 1, wasted = false): Label => ({ p, u, w, wasted });

// ───────────── التسميات ─────────────

test('buildPlanLabels: زيارات المندوب نفسه فقط، ضمن ٧٢ ساعة، والمخطّط غير المزور تخطٍّ، والمغلق ضائع، والتحويل خلال ٣٠ يوماً = ١', () => {
  const t = turn('t1', 'r1', [
    feat('a', { fr: 1 }), feat('b', { fr: 2 }), feat('c', { fr: 3 }), feat('d', { fr: 0 }),
    feat('e', { fr: 0 }), feat('f', { fr: 4 }), feat('g', { fr: 0 }), feat('h', { fr: 5 }), feat('i', { fr: 0 }),
  ]);
  const labels = P.buildPlanLabels([t], [
    ev('r2', 'a', 'INTERESTED', 2),                              // مندوب آخر ⇒ لا يُحسب
    ev('r1', 'b', 'QUOTE', 50, { atDoor: true }),                // ٥٠ ساعة ⇒ يُحسب
    ev('r1', 'c', 'INTERESTED', 80),                             // ٨٠ ساعة ⇒ لا
    ev('r1', 'd', 'CLOSED', 1, { atDoor: true }),                // مغلق فقط ⇒ ضائع
    ev('r1', 'e', 'CLOSED', 1), ev('r1', 'e', 'CALL_BACK', 30, { atDoor: false }), // مغلق ثم عُد لاحقاً ⇒ ٠٫٣، بعيد ٠٫٤
    ev('r1', 'f', 'NOT_INTERESTED', 3, { convertedAt: new Date(T0.getTime() + 20 * 24 * HOUR) }), // تحوّل خلال ٣٠ يوماً ⇒ ١
    ev('r1', 'g', 'INTERESTED', 5, { convertedAt: new Date(T0.getTime() + 40 * 24 * HOUR) }),     // بعد ٣٠ يوماً ⇒ ٠٫٦
    ev('r1', 'i', 'INTERESTED', -1),                             // قبل الدورة ⇒ لا
  ]);
  const by = new Map(labels.get('t1')!.map(l => [l.p, l]));
  assert.deepEqual(by.get('a'), { p: 'a', u: 0, w: 0.5, wasted: false }, 'مخطّط، وزيارة مندوب آخر لا تُحسب');
  assert.deepEqual(by.get('b'), { p: 'b', u: 0.7, w: 1, wasted: false });
  assert.deepEqual(by.get('c'), { p: 'c', u: 0, w: 0.5, wasted: false }, '٨٠ ساعة خارج النافذة ⇒ تخطٍّ');
  assert.equal(by.get('d')!.wasted, true);
  assert.deepEqual(by.get('e'), { p: 'e', u: 0.3, w: 0.4, wasted: false });
  assert.deepEqual(by.get('f'), { p: 'f', u: 1, w: 0.7, wasted: false });
  assert.deepEqual(by.get('g'), { p: 'g', u: 0.6, w: 0.7, wasted: false });
  assert.deepEqual(by.get('h'), { p: 'h', u: 0, w: 0.5, wasted: false });
  assert.equal(by.has('i'), false, 'غير مخطّط وغير مزور ⇒ مستبعد');

  const empty = P.buildPlanLabels([turn('t2', 'r1', [feat('z')])], []);
  assert.equal(empty.has('t2'), false);

  // المغلق مستبعد من الأزواج: وحده مع مرشّح إيجابي ⇒ لا أزواج
  const only = new Map([['x', [lab('a', 0.6), lab('d', 0, 1, true)]]]);
  assert.equal(P.concordance([turn('x', 'r1', [feat('a'), feat('d')])], only, DEFAULT_POLICY).pairs, 0);
});

// ───────────── التوافق ─────────────

test('concordance: مثال محسوب يدوياً (التعادل ½، أوزان الباب، سقف ٣٥٪ للمندوب)', () => {
  // المندوب A: a1 نقاطه ٢٠٠، a2 و a3 نقاطهما ١٠٠ (تعادل)
  const tA = turn('tA', 'A', [feat('a1', { v: 100, b: 0 }), feat('a2', { v: 50, b: 0 }), feat('a3', { v: 50, b: 0 })]);
  const tB = turn('tB', 'B', [feat('b1', { v: 100, b: 0 }), feat('b2', { v: 10, b: 0, fr: 2 })]);
  const tC = turn('tC', 'C', [feat('c1', { v: 100, b: 0 }), feat('c2', { v: 10, b: 0 })]);
  const labels = new Map<string, Label[]>([
    ['tA', [lab('a1', 0, 1), lab('a2', 0.6, 0.7), lab('a3', 0.3, 0.4)]],
    ['tB', [lab('b1', 0.6, 1), lab('b2', 0, 0.5)]],
    ['tC', [lab('c1', 0.7, 1), lab('c2', 0, 1)]],
  ]);
  // A: (a2>a1) 0.7×0 + (a2>a3) 0.28×½ + (a3>a1) 0.4×0 ⇒ num 0.14، den 1.38
  const numA = 0.28 * 0.5, denA = 0.7 + 0.28 + 0.4;
  // B: b2 محطّة مخطّطة غير مزورة (تخطٍّ، w=½) و b1 ليس في الخطة المسجّلة (fr=0) ⇒ الزوج يُسقط (تحيّز الاختيار):
  //    لا يُقارن المتخطّى إلا بمحطّة مخطّطة زارها المندوب ⇒ B بلا أزواج ولا يدخل التجميع.
  // C: (c1>c2) 1×1 ⇒ num 1، den 1.
  // W = 1.38 + 1 = 2.38: حصة A = 0.58 وحصة C = 0.42 — كلاهما > 0.35 ⇒ كلاهما يُقيَّس إلى 0.35·W، فيتساوى وزناهما:
  // C = (0.35W·numA/denA + 0.35W·1) / (0.35W + 0.35W) = (0.14/1.38 + 1) / 2 = 0.5507
  const W = denA + 1;
  const kA = (0.35 * W) / denA, kC = 0.35 * W;
  const want = (kA * numA + kC * 1) / (kA * denA + kC * 1);
  assert.ok(Math.abs(want - (numA / denA + 1) / 2) < 1e-12);
  const r = P.concordance([tA, tB, tC], labels, DEFAULT_POLICY);
  assert.ok(Math.abs(r.c - want) < 1e-12, `${r.c} ≠ ${want}`);
  assert.ok(Math.abs(r.c - 0.5507) < 1e-3);
  assert.deepEqual({ pairs: r.pairs, turns: r.turns, reps: r.reps }, { pairs: 4, turns: 2, reps: 2 });

  // b1 في الخطة وزاره المندوب (fr=1) ⇒ زوج التخطّي يُقارن من جديد (0.5×1 متوافق)، فتعود قيمة المثال الأصلية:
  // W = 1.38 + 0.5 + 1 = 2.88، حصة A = 0.479 > 0.35 ⇒ تُقيَّس وحدها
  const tB1 = turn('tB', 'B', [feat('b1', { v: 100, b: 0, fr: 1 }), feat('b2', { v: 10, b: 0, fr: 2 })]);
  const W1 = denA + 0.5 + 1;
  const k1 = (0.35 * W1) / denA;
  const want1 = (k1 * numA + 0.5 + 1) / (k1 * denA + 0.5 + 1);
  const r1 = P.concordance([tA, tB1, tC], labels, DEFAULT_POLICY);
  assert.ok(Math.abs(r1.c - want1) < 1e-12, `${r1.c} ≠ ${want1}`);
  assert.ok(Math.abs(r1.c - 0.6389) < 1e-3);
  assert.deepEqual({ pairs: r1.pairs, turns: r1.turns, reps: r1.reps }, { pairs: 5, turns: 3, reps: 3 });

  // مندوب واحد: السقف مقياس موحّد لا يغيّر النسبة
  const solo = P.concordance([tA], labels, DEFAULT_POLICY);
  assert.ok(Math.abs(solo.c - numA / denA) < 1e-12);
  // بلا أزواج ⇒ ٠٫٥
  assert.equal(P.concordance([], labels, DEFAULT_POLICY).c, 0.5);
  assert.equal(P.concordance([tB], labels, DEFAULT_POLICY).c, 0.5, 'زوج التخطّي مع غير المخطّط وحده ⇒ بلا أزواج');
});

test('concordance: المتخطّى لا يُقارن بمحلٍّ خارج الخطة المسجّلة (fr=0)، ويُقارن بالمحطّة المخطّطة المزورة', () => {
  // x مخطّط ومزور وإيجابي، y مخطّط ومتخطّى (نقاطه الأعلى)، z مزور وإيجابي أكثر
  const mk = (zfr: number) => turn('sb', 'r1', [feat('x', { v: 100, fr: 1 }), feat('y', { v: 300, fr: 2 }), feat('z', { v: 200, fr: zfr })]);
  const labels = new Map<string, Label[]>([['sb', [lab('x', 0.6, 1), lab('y', 0, 0.5), lab('z', 0.7, 1)]]]);
  // z خارج الخطة: (x>y) 0.5×0 + (z>x) 1×1، و(z>y) يُسقط ⇒ ١ / ١٫٥
  const out = P.concordance([mk(0)], labels, DEFAULT_POLICY);
  assert.equal(out.pairs, 2);
  assert.ok(Math.abs(out.c - 1 / 1.5) < 1e-12, String(out.c));
  // z في الخطة: يُضاف (z>y) 0.5×0 ⇒ ١ / ٢
  const inPlan = P.concordance([mk(3)], labels, DEFAULT_POLICY);
  assert.equal(inPlan.pairs, 3);
  assert.ok(Math.abs(inPlan.c - 0.5) < 1e-12, String(inPlan.c));
});

test('concordance: فترة اليوم المخزّنة في الدورة (hb) تُفضَّل على إعادة حسابها بتوقيت الرياض', () => {
  // T0 = ١٠ صباحاً بالرياض (الفترة ٠)؛ البقالة مغلقة غالباً في الفترة ٢ فقط
  const p = pol({ useClosed: true, closedRisk: { GROCERY: [0, 0, 0.9, 0, 0] } });
  const cs = [feat('g', { t: 'GROCERY', v: 100 }), feat('k', { t: 'CAFE', v: 50 })];
  const labels = new Map<string, Label[]>([['h', [lab('g', 0), lab('k', 0.6)]]]);
  assert.equal(P.concordance([turn('h', 'r1', cs)], labels, p).c, 0, 'بلا hb ⇒ الفترة ٠: البقالة (١٠٠) فوق المقهى (٥٠)');
  assert.equal(P.concordance([turn('h', 'r1', cs, { hb: null })], labels, p).c, 0, 'hb فارغ ⇒ الرياض');
  assert.equal(P.concordance([turn('h', 'r1', cs, { hb: 2 })], labels, p).c, 1, 'hb = ٢ ⇒ البقالة ١٠ تحت المقهى ٥٠');
});

// ───────────── الملاءمة ─────────────

const cell = (o: Partial<FieldTypeStats> = {}): FieldTypeStats => ({
  n: 40, reps: 3, topRepShare: 0.4, exposed: true, posRate: 0.3, typeMult: 1, convRate: null, objections: null, callback: null,
  closed: { rate: 0.1, byBand: [0.1, 0.1, 0.1, 0.1, 0.1], nByBand: [2, 2, 2, 2, 2] }, ...o,
});
const fieldOf = (byType: Record<string, FieldTypeStats>): FieldStats => ({ v: 1, computedAt: T0.toISOString(), windowDays: 90, activeReps: 3, tenantPosRate: 0.3, byType });

function randomTurns(seed: number, n: number): { turns: PlanTurn[]; labels: Map<string, Label[]> } {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const turns: PlanTurn[] = [], labels = new Map<string, Label[]>();
  for (let i = 0; i < n; i++) {
    const cs = Array.from({ length: 6 }, (_, j) => feat(`p${i}_${j}`, {
      t: pick(['GROCERY', 'CAFE'] as const), b: Math.floor(rnd() * 6), c: pick(['HIGH', 'MEDIUM', 'LOW', 'NONE'] as const), v: 10 + Math.round(rnd() * 500), rr: j + 1,
    }));
    turns.push(turn(`r${i}`, `rep${i % 3}`, cs, { createdAt: new Date(T0.getTime() + i * HOUR) }));
    labels.set(`r${i}`, cs.map(c => lab(c.p, pick([0, 0.3, 0.6, 0.7, 1]), pick([1, 0.7, 0.4, 0.5]))));
  }
  return { turns, labels };
}

test('fitPolicy: خطوة شبكة واحدة على الأكثر لكل معامل، و 1 = HIGH ≥ MEDIUM ≥ LOW ≥ NONE', () => {
  const champs = [
    DEFAULT_POLICY,
    pol({ alpha: 0.6, confW: { HIGH: 1, MEDIUM: 0.5, LOW: 0.5, NONE: 0.2 } }),
    pol({ alpha: 1.5, confW: { HIGH: 1, MEDIUM: 1, LOW: 0.3, NONE: 0.3 } }),
    pol({ alpha: 1.2, confW: { HIGH: 1, MEDIUM: 0.4, LOW: 0.4, NONE: 0.4 } }),
  ];
  for (let seed = 1; seed <= 6; seed++) {
    const { turns, labels } = randomTurns(seed, 40);
    for (const ch of champs) {
      const next = P.fitPolicy(turns, labels, ch, null);
      const ia = P.ALPHA_GRID.indexOf(ch.alpha), ib = P.ALPHA_GRID.indexOf(next.alpha);
      assert.ok(ib >= 0 && Math.abs(ia - ib) <= 1, `alpha ${ch.alpha} → ${next.alpha}`);
      for (const k of ['MEDIUM', 'LOW', 'NONE'] as const) assert.ok(Math.abs(next.confW[k] - ch.confW[k]) <= 0.1 + 1e-9, `${k} ${ch.confW[k]} → ${next.confW[k]}`);
      const w = next.confW;
      assert.ok(w.HIGH === 1 && w.MEDIUM <= 1 && w.MEDIUM >= w.LOW && w.LOW >= w.NONE && w.NONE > 0, JSON.stringify(w));
      assert.equal(next.useClosed, false, 'بلا إحصاء ميدان ⇒ بلا مراعاة الإغلاق');
      assert.ok(P.concordance(turns, labels, next).c >= P.concordance(turns, labels, ch).c - 1e-12, 'لا يسوء التدريب');
    }
  }
});

test('fitPolicy: يتّجه نحو الإشارة داخل منطقة الثقة (alpha ١←١٫٢، LOW ٠٫٥←٠٫٦) ويحصر مضاعف النوع في ±٠٫٢', () => {
  const turns: PlanTurn[] = [], labels = new Map<string, Label[]>();
  for (let i = 0; i < 12; i++) {
    // المسافة: القريب (v 100، ٢٠٠ م) يتجاوب والبعيد الأعلى قيمة (v 400، ١٫٥ كم) لا ⇒ alpha أعلى
    turns.push(turn(`d${i}`, `rep${i % 3}`, [feat(`n${i}`, { b: 0, v: 100 }), feat(`f${i}`, { b: 3, v: 400 })]));
    labels.set(`d${i}`, [lab(`n${i}`, 0.6), lab(`f${i}`, 0)]);
    // الثقة: منخفضة الثقة (v 150) تتجاوب ومتوسطة الثقة (v 110) لا ⇒ LOW ٠٫٦ يصحّح (٩٠ > ٨٨) و MEDIUM ٠٫٧ وحده لا (٧٧ > ٧٥)
    turns.push(turn(`c${i}`, `rep${i % 3}`, [feat(`l${i}`, { c: 'LOW', v: 150 }), feat(`m${i}`, { c: 'MEDIUM', v: 110 })]));
    labels.set(`c${i}`, [lab(`l${i}`, 0.7), lab(`m${i}`, 0)]);
  }
  const field = fieldOf({
    GROCERY: cell({ typeMult: 1.6 }), CAFE: cell({ typeMult: 0.6 }), BAKERY: cell({ typeMult: 1.5, exposed: false }),
  });
  const next = P.fitPolicy(turns, labels, DEFAULT_POLICY, field);
  assert.equal(next.alpha, 1.2);
  assert.equal(next.confW.LOW, 0.6);
  assert.ok(next.confW.MEDIUM >= next.confW.LOW);
  assert.deepEqual(next.typeMult, { GROCERY: 1.2, CAFE: 0.8 }, 'محصور ±٠٫٢، وغير المكشوف لا يُستعمل');
  assert.equal(next.closedRisk, null, 'أقل من ٣٠ نتيجة ⇒ بلا خطر إغلاق');
  assert.equal(next.useClosed, false);

  const again = P.fitPolicy(turns, labels, { ...next, typeMult: { GROCERY: 1.1 } }, field);
  assert.equal(again.typeMult.GROCERY, 1.3);
  assert.equal(again.alpha, 1.2, 'بلا تحسّن صارم ⇒ تبقى قيمة البطل');
  assert.equal(again.confW.LOW, 0.6);
});

test('fitPolicy: مراعاة الإغلاق لا تُفعَّل إلا بخلية إغلاق ≥ ٣٠ نتيجة وحين تحسّن الترتيب', () => {
  const turns: PlanTurn[] = [], labels = new Map<string, Label[]>();
  for (let i = 0; i < 12; i++) {
    // المقهى أعلى قيمة لكنه لا يتجاوب صباحاً (مغلق غالباً)، والبقالة تتجاوب
    turns.push(turn(`k${i}`, `rep${i % 3}`, [feat(`cafe${i}`, { t: 'CAFE', v: 200 }), feat(`gro${i}`, { t: 'GROCERY', v: 100 })]));
    labels.set(`k${i}`, [lab(`cafe${i}`, 0), lab(`gro${i}`, 0.6)]);
  }
  const busy = { rate: 0.5, byBand: [0.8, 0.3, 0.2, 0.1, 0.9], nByBand: [10, 10, 10, 5, 5] };
  const yes = P.fitPolicy(turns, labels, DEFAULT_POLICY, fieldOf({ CAFE: cell({ closed: busy }), GROCERY: cell() }));
  assert.equal(yes.useClosed, true);
  assert.deepEqual(yes.closedRisk, { CAFE: [0.8, 0.3, 0.2, 0.1, 0.9] });
  const few = P.fitPolicy(turns, labels, DEFAULT_POLICY, fieldOf({ CAFE: cell({ closed: { ...busy, nByBand: [10, 5, 5, 5, 4] } }), GROCERY: cell() }));
  assert.equal(few.useClosed, false);
  assert.equal(few.closedRisk, null);
});

// ───────────── البوابة ─────────────

/** دورات بمقهيين متجاوبين (v 80) وبقالتين لا (v 100): البطل الافتراضي يخطئ دائماً، والمتحدّي CAFE×3 يصيب. */
function liftTurns(n: number, reps: string[], o: { cafePos?: number; groNeg?: number; start?: number } = {}) {
  const turns: PlanTurn[] = [], labels = new Map<string, Label[]>();
  for (let i = 0; i < n; i++) {
    const id = `L${(o.start ?? 0) + i}`;
    const cafes = Array.from({ length: o.cafePos ?? 2 }, (_, j) => feat(`${id}c${j}`, { t: 'CAFE', v: 80 }));
    const gros = Array.from({ length: o.groNeg ?? 2 }, (_, j) => feat(`${id}g${j}`, { t: 'GROCERY', v: 100 }));
    const cs = [...cafes, ...gros].map((f, k) => ({ ...f, rr: k + 1 }));
    turns.push(turn(id, reps[i % reps.length], cs, { createdAt: new Date(T0.getTime() + ((o.start ?? 0) + i) * HOUR) }));
    labels.set(id, [...cafes.map(c => lab(c.p, 0.6)), ...gros.map(g => lab(g.p, 0))]);
  }
  return { turns, labels };
}
const merge = (...xs: Array<{ turns: PlanTurn[]; labels: Map<string, Label[]> }>) =>
  ({ turns: xs.flatMap(x => x.turns), labels: new Map(xs.flatMap(x => [...x.labels])) });
const CHAL = pol({ typeMult: { CAFE: 3 } });
const R3 = ['r1', 'r2', 'r3'];

test('shouldPromote: يرقّي عند تحسّن واضح، ويرفض لقلّة الأزواج أو الدورات أو المناديب أو صغر الفرق', () => {
  const clear = liftTurns(18, R3); // ٧٢ زوجاً
  const ok = P.shouldPromote(clear.turns, clear.labels, DEFAULT_POLICY, CHAL, 7, 3);
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.reason, 'PASS');
  assert.equal(ok.dC, 1);
  assert.ok(ok.lo10 > 0);
  assert.deepEqual({ pairs: ok.pairs, turns: ok.turns, reps: ok.reps }, { pairs: 72, turns: 18, reps: 3 });

  const few = liftTurns(9, R3);
  assert.equal(P.shouldPromote(few.turns, few.labels, DEFAULT_POLICY, CHAL, 7, 3).reason, 'FEW_PAIRS');
  const fewTurns = liftTurns(10, R3, { cafePos: 3, groNeg: 3 }); // ٩٠ زوجاً في ١٠ دورات
  assert.equal(P.shouldPromote(fewTurns.turns, fewTurns.labels, DEFAULT_POLICY, CHAL, 7, 3).reason, 'FEW_TURNS');
  const twoReps = liftTurns(18, ['r1', 'r2']);
  assert.equal(P.shouldPromote(twoReps.turns, twoReps.labels, DEFAULT_POLICY, CHAL, 7, 3).reason, 'FEW_REPS');
  assert.equal(P.shouldPromote(twoReps.turns, twoReps.labels, DEFAULT_POLICY, CHAL, 7, 2).ok, true, 'مندوبان نشطان فقط ⇒ يكفيان');
  const small = P.shouldPromote(clear.turns, clear.labels, DEFAULT_POLICY, pol({ typeMult: { CAFE: 1.1 } }), 7, 3);
  assert.equal(small.reason, 'SMALL_LIFT');
  assert.equal(small.dC, 0);
  assert.equal(P.shouldPromote(clear.turns, clear.labels, DEFAULT_POLICY, pol(), 7, 3).reason, 'SAME_PARAMS');

  // مندوب واحد نشط ⇒ ٨٠ زوجاً
  const solo = liftTurns(18, ['r1']);
  assert.equal(P.shouldPromote(solo.turns, solo.labels, DEFAULT_POLICY, CHAL, 7, 1).reason, 'FEW_PAIRS');
  const solo2 = liftTurns(21, ['r1']);
  assert.equal(P.shouldPromote(solo2.turns, solo2.labels, DEFAULT_POLICY, CHAL, 7, 1).ok, true);
});

test('shouldPromote: فرق ≥ ٠٫٠٢ من دورتين كبيرتين فقط ⇒ مئين الإقلاع العاشر ≤ ٠ ⇒ رفض', () => {
  // دورتان يربح فيهما المتحدّي (١٠×١٠ أزواج)، و١٦ دورة يربح فيها البطل (٢×٥)
  const A = liftTurns(2, ['r1', 'r2'], { cafePos: 10, groNeg: 10 });
  const turns = [...A.turns], labels = new Map(A.labels);
  for (let i = 0; i < 16; i++) {
    const id = `B${i}`;
    const gros = [0, 1].map(j => feat(`${id}g${j}`, { t: 'GROCERY', v: 100 }));
    const cafes = [0, 1, 2, 3, 4].map(j => feat(`${id}c${j}`, { t: 'CAFE', v: 80 }));
    turns.push(turn(id, R3[i % 3], [...gros, ...cafes]));
    labels.set(id, [...gros.map(g => lab(g.p, 0.6)), ...cafes.map(c => lab(c.p, 0))]);
  }
  const r = P.shouldPromote(turns, labels, DEFAULT_POLICY, CHAL, 11, 3);
  assert.ok(r.dC >= 0.02, `dC=${r.dC}`);
  assert.ok(r.lo10 <= 0, `lo10=${r.lo10}`);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'UNCERTAIN_LIFT');
  // حتمي بالبذرة
  assert.equal(P.shouldPromote(turns, labels, DEFAULT_POLICY, CHAL, 11, 3).lo10, r.lo10);
});

test('shouldPromote: حارس الرحلات الضائعة — المتحدّي يقدّم محلات وُجدت مغلقة ⇒ رفض', () => {
  const turns: PlanTurn[] = [], labels = new Map<string, Label[]>();
  for (let i = 0; i < 18; i++) {
    const id = `W${i}`;
    const cafes = Array.from({ length: 6 }, (_, j) => feat(`${id}c${j}`, { t: 'CAFE', v: 80, rr: j + 1 }));
    const gros = Array.from({ length: 5 }, (_, j) => feat(`${id}g${j}`, { t: 'GROCERY', v: 100, rr: 7 + j }));
    turns.push(turn(id, R3[i % 3], [...cafes, ...gros]));
    labels.set(id, [
      ...cafes.map((c, j) => (j < 2 ? lab(c.p, 0.6) : lab(c.p, 0, 1, true))),
      ...gros.map(g => lab(g.p, 0)),
    ]);
  }
  const r = P.shouldPromote(turns, labels, DEFAULT_POLICY, CHAL, 3, 3);
  assert.equal(r.dC, 1);
  assert.equal(r.reason, 'MORE_CLOSED');
  assert.equal(r.ok, false);
});

test('splitTrainHeldOut: أقدم ٧٠٪ تدريب وأحدث ٣٠٪ محجوبة', () => {
  const ts = Array.from({ length: 10 }, (_, i) => turn(`s${i}`, 'r1', [], { createdAt: new Date(T0.getTime() + ((i * 7) % 10) * HOUR) }));
  const { train, heldOut } = P.splitTrainHeldOut(ts);
  assert.equal(train.length, 7);
  assert.equal(heldOut.length, 3);
  const maxTrain = Math.max(...train.map(t => t.createdAt.getTime()));
  assert.ok(heldOut.every(t => t.createdAt.getTime() > maxTrain));
});

// ───────────── الأذرع والتراجع ─────────────

test('armAggregates: المخطّط والمزور والإيجابي والمحوَّل والمغلق لكل ذراع، والالتزام والرحلات الضائعة', () => {
  const tL = turn('aL', 'r1', [feat('x1', { fr: 1 }), feat('x2', { fr: 2 }), feat('x3', { fr: 3 }), feat('x4', { fr: 0 })], { arm: 'LEARNED' });
  const tB = turn('aB', 'r2', [feat('y1', { fr: 1 }), feat('y2', { fr: 2 })], { arm: 'BASELINE' });
  const labels = P.buildPlanLabels([tL, tB], [
    ev('r1', 'x1', 'INTERESTED', 1, { atDoor: true }),
    ev('r1', 'x2', 'CLOSED', 2),
    ev('r1', 'x4', 'QUOTE', 2), // غير مخطّط ⇒ خارج مؤشرات الذراع
    ev('r2', 'y1', 'CONVERTED', 3),
    ev('r2', 'y2', 'NOT_INTERESTED', 3),
  ]);
  const a = P.armAggregates([tL, tB], labels);
  assert.deepEqual(a.LEARNED, { planned: 3, visited: 2, pos: 1, conv30: 0, closed: 1 });
  assert.deepEqual(a.BASELINE, { planned: 2, visited: 2, pos: 1, conv30: 1, closed: 0 });
  assert.equal(a.adherence, 4 / 5);
  assert.equal(a.wastedRate, 1 / 4);
  assert.ok(Math.abs(a.pLearnedBetter - 0.5) < 1e-6);
});

const zeroArms = (): ArmAgg => ({
  LEARNED: { planned: 0, visited: 0, pos: 0, conv30: 0, closed: 0 }, BASELINE: { planned: 0, visited: 0, pos: 0, conv30: 0, closed: 0 },
  pLearnedBetter: 0.5, adherence: 0, wastedRate: 0,
});

test('checkPolicyRollback: تراجع عند الانحدار وحين تخسر الذراع المتعلّمة حيّاً، ولا تراجع بعيّنة صغيرة', () => {
  // في liftTurns تصيب CHAL وتخطئ الافتراضية ⇒ نشطة افتراضية بعد سابقة CHAL = انحدار
  const big = liftTurns(8, R3); // ٣٢ زوجاً
  const reg = P.checkPolicyRollback({ sincePromotion: big.turns, labels: big.labels, active: DEFAULT_POLICY, previous: CHAL, arms: zeroArms() });
  assert.deepEqual(reg, { rollback: true, reason: 'AUTO_REGRESSION' });
  const better = P.checkPolicyRollback({ sincePromotion: big.turns, labels: big.labels, active: CHAL, previous: DEFAULT_POLICY, arms: zeroArms() });
  assert.deepEqual(better, { rollback: false });
  const smallN = liftTurns(7, R3); // ٢٨ زوجاً
  assert.deepEqual(P.checkPolicyRollback({ sincePromotion: smallN.turns, labels: smallN.labels, active: DEFAULT_POLICY, previous: CHAL, arms: zeroArms() }), { rollback: false });

  const arms = zeroArms();
  arms.LEARNED = { planned: 90, visited: 60, pos: 10, conv30: 1, closed: 3 };
  arms.BASELINE = { planned: 90, visited: 60, pos: 30, conv30: 4, closed: 3 };
  assert.deepEqual(P.checkPolicyRollback({ sincePromotion: [], labels: new Map(), active: CHAL, previous: DEFAULT_POLICY, arms }), { rollback: true, reason: 'AB_WORSE' });
  arms.LEARNED.visited = 59;
  assert.deepEqual(P.checkPolicyRollback({ sincePromotion: [], labels: new Map(), active: CHAL, previous: DEFAULT_POLICY, arms }), { rollback: false }, 'أقل من ٦٠ زيارة');
  arms.LEARNED = { planned: 90, visited: 60, pos: 30, conv30: 4, closed: 3 };
  arms.BASELINE = { planned: 90, visited: 60, pos: 10, conv30: 1, closed: 3 };
  assert.deepEqual(P.checkPolicyRollback({ sincePromotion: [], labels: new Map(), active: CHAL, previous: DEFAULT_POLICY, arms }), { rollback: false });
});

test('counterfactualLift: النشطة مقابل الافتراضية على الزيارات نفسها بفاصل ٩٠٪ حتمي', () => {
  const good = liftTurns(12, R3);
  const noisy = liftTurns(6, R3, { start: 100 });
  for (const [id, ls] of noisy.labels) good.labels.set(id, ls.map(l => ({ ...l, u: l.u ? 0 : 0.6 }))); // دورات معاكسة
  const all = { turns: [...good.turns, ...noisy.turns], labels: good.labels };
  const r = P.counterfactualLift(all.turns, all.labels, CHAL, 42);
  assert.ok(Math.abs(r.cDefault - 1 / 3) < 1e-12 && Math.abs(r.cActive - 2 / 3) < 1e-12, JSON.stringify(r));
  assert.ok(Math.abs(r.dC - 1 / 3) < 1e-12);
  assert.ok(r.lo90 <= r.dC && r.dC <= r.hi90 && r.lo90 < r.hi90);
  assert.deepEqual({ pairs: r.pairs, turns: r.turns }, { pairs: 72, turns: 18 });
  assert.deepEqual(P.counterfactualLift(all.turns, all.labels, CHAL, 42), r, 'حتمي بالبذرة');
  const same = P.counterfactualLift(all.turns, all.labels, DEFAULT_POLICY, 42);
  assert.deepEqual([same.dC, same.lo90, same.hi90], [0, 0, 0]);
  const none = P.counterfactualLift([], new Map(), CHAL, 1);
  assert.deepEqual(none, { cDefault: 0.5, cActive: 0.5, dC: 0, lo90: 0, hi90: 0, pairs: 0, turns: 0 });
});

// ───────────── الذراع ─────────────

test('assignArm: حتمي لكل (شركة، مندوب، يوم)، ونحو ٢٠٪ أساس، والإيقاف أساس دائماً، وصفر متعلَّمة دائماً', () => {
  const s = { learningMode: 'AUTO', holdoutPct: 20 };
  assert.equal(P.assignArm('t1', 'r1', '2026-09-27', s), P.assignArm('t1', 'r1', '2026-09-27', s));
  let base = 0, off = 0, zero = 0;
  for (let i = 0; i < 10000; i++) {
    if (P.assignArm('t1', `rep-${i}`, '2026-09-27', s) === 'BASELINE') base++;
    if (P.assignArm('t1', `rep-${i}`, '2026-09-27', { learningMode: 'OFF', holdoutPct: 20 }) === 'BASELINE') off++;
    if (P.assignArm('t1', `rep-${i}`, '2026-09-27', { learningMode: 'REVIEW', holdoutPct: 0 }) === 'LEARNED') zero++;
  }
  assert.ok(base >= 1800 && base <= 2200, `base=${base}`);
  assert.equal(off, 10000);
  assert.equal(zero, 10000);
  // يتغيّر مع اليوم (ليس ثابتاً للمندوب إلى الأبد)
  const days = new Set(Array.from({ length: 30 }, (_, d) => P.assignArm('t1', 'r1', `2026-09-${String(d + 1).padStart(2, '0')}`, s)));
  assert.equal(days.size, 2);
});

// ───────────── العرض والمقارنة ─────────────

test('describePolicy بالعربية وبأرقام عربية، و samePolicy', () => {
  const next = pol({ alpha: 1.2, confW: { HIGH: 1, MEDIUM: 0.8, LOW: 0.4, NONE: 0.4 }, typeMult: { GROCERY: 1.2 }, useClosed: true, closedRisk: { CAFE: [0.3, 0, 0, 0, 0] } });
  const s = P.describePolicy(DEFAULT_POLICY, next);
  assert.ok(s.includes('وزن المحلات قليلة المقيّمين ٠٫٥ ← ٠٫٤'), s);
  assert.ok(s.includes('١ ← ١٫٢'), s);
  assert.ok(s.includes('«بقالة / تموينات» ١ ← ١٫٢'), s);
  assert.ok(s.includes('مراعاة أوقات إغلاق المحلات: موقوفة ← مفعّلة'), s);
  assert.ok(!/[0-9]/.test(s), 'بلا أرقام لاتينية');
  assert.equal(P.describePolicy(DEFAULT_POLICY, pol()), 'بلا تغيير في معاملات الترتيب');

  assert.equal(P.samePolicy(DEFAULT_POLICY, pol()), true);
  assert.equal(P.samePolicy(DEFAULT_POLICY, pol({ typeMult: { GROCERY: 1 } })), true, 'الغائب = ١');
  assert.equal(P.samePolicy(DEFAULT_POLICY, pol({ alpha: 1 + 1e-12 })), true);
  assert.equal(P.samePolicy(DEFAULT_POLICY, pol({ alpha: 1.2 })), false);
  assert.equal(P.samePolicy(DEFAULT_POLICY, pol({ confW: { HIGH: 1, MEDIUM: 0.7, LOW: 0.5, NONE: 0.4 } })), false);
  assert.equal(P.samePolicy(DEFAULT_POLICY, pol({ typeMult: { CAFE: 0.9 } })), false);
  assert.equal(P.samePolicy(next, { ...next, closedRisk: { CAFE: [0.3, 0.1, 0, 0, 0] } }), false);
  assert.equal(P.samePolicy(next, JSON.parse(JSON.stringify(next))), true);
});

// ───────────── الاستعلام ─────────────

test('loadPlanEvents: مقيّد بالشركة على طرفي الربط، وبمعرّف مكان، وبحدّ ٦٠٠٠٠ للأحدث، ثم بالترتيب الزمني', async () => {
  rawCalls = [];
  const at = new Date('2026-09-02T08:00:00Z'), later = new Date('2026-09-03T08:00:00Z'), conv = new Date('2026-09-05T08:00:00Z');
  // القاعدة تعيد الأحدث أولاً (DESC) — والدالة تعكسها إلى الترتيب الزمني
  rawRows = [
    { rep: 'r2', placeId: 'man:24.7,46.7', kind: 'CLOSED', occurredAt: later, atDoor: null, convertedAt: null },
    { rep: 'r1', placeId: 'gp1', kind: 'INTERESTED', occurredAt: at, atDoor: true, convertedAt: conv },
  ];
  const since = new Date('2026-07-29T00:00:00Z');
  const out = await P.loadPlanEvents('tenant-A', since);
  assert.equal(rawCalls.length, 1);
  const q = rawCalls[0];
  const text = q.strings.join('?').replace(/\s+/g, ' ');
  assert.match(text, /FROM ai_outlet_events e JOIN ai_outlets o ON o\.id = e\."outletId" AND o\."tenantId" = \? WHERE e\."tenantId" = \?/);
  assert.match(text, /e\."occurredAt" >= \? AND o\."placeId" IS NOT NULL/, 'بلا حدّ أعلى ⇒ لا قيد إضافي');
  assert.match(text, /ORDER BY e\."occurredAt" DESC LIMIT 60000$/);
  assert.deepEqual(q.values, ['tenant-A', 'tenant-A', since]);
  assert.deepEqual(out, [
    { rep: 'r1', placeId: 'gp1', kind: 'INTERESTED', occurredAt: at, atDoor: true, convertedAt: conv },
    { rep: 'r2', placeId: 'man:24.7,46.7', kind: 'CLOSED', occurredAt: later, atDoor: null, convertedAt: null },
  ]);

  // حدّ أعلى اختياري (مقطع Prisma.sql بلا جداول): قيد الشركة على الطرفين باقٍ
  rawCalls = [];
  rawRows = [];
  const until = new Date('2026-09-10T00:00:00Z');
  assert.deepEqual(await P.loadPlanEvents('tenant-A', since, until), []);
  const q2 = rawCalls[0];
  const text2 = q2.strings.join('?').replace(/\s+/g, ' ');
  assert.match(text2, /JOIN ai_outlets o ON o\.id = e\."outletId" AND o\."tenantId" = \? WHERE e\."tenantId" = \?/);
  assert.match(text2, /e\."occurredAt" >= \? AND e\."occurredAt" < \? AND o\."placeId" IS NOT NULL/);
  assert.match(text2, /ORDER BY e\."occurredAt" DESC LIMIT 60000$/);
  assert.deepEqual(q2.values, ['tenant-A', 'tenant-A', since, until]);
});
