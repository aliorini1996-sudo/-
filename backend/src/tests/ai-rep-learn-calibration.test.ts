// حلقة التعلّم — معايرة الطلب التجريبي بأول طلبات العملاء الجدد: التقدير والانكماش والحصر، حدّ التفعيل،
// بوابة الاستبعاد الواحد، الرجوع التلقائي، اختبار LOO على العملاء الحديثين، وتقييم اللقطات (فوق Prisma مزيّف، بلا قاعدة).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import type { EngineInput, EstimateResult, PeerCustomer, PeerProductMonth, FirstOrderLine } from '../ai-rep/estimate';
import type { TenantEstimateData } from '../ai-rep/estimateData';
import type { CalParams, Learned } from '../ai-rep/learn/types';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ───────────── Prisma مزيّف ─────────────
let rawCalls: Prisma.Sql[] = [];
let rawRows: Array<{ sid: string; productId: string | null; qty: number | null }> = [];
let updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
let findArgs: Array<{ where: Record<string, unknown> }> = [];
let snapRows: unknown[] = [];
stub('config/database', {
  default: {
    $queryRaw: async (q: Prisma.Sql) => { rawCalls.push(q); return rawRows; },
    aiEstimateSnapshot: {
      updateMany: async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => { updates.push(a); return { count: 1 }; },
      findMany: async (a: { where: Record<string, unknown> }) => { findArgs.push(a); return snapRows; },
    },
  },
});

// جاسوس على المحرّك الحقيقي (لاختبار LOO): يسجّل كل نداء ويفوّض للمحرّك نفسه
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realEst = require('../ai-rep/estimate') as typeof import('../ai-rep/estimate');
const engineCalls: Array<{ input: EngineInput; result: EstimateResult }> = [];
stub('ai-rep/estimate', {
  ...realEst,
  estimateOutlet: (input: EngineInput, label: string) => {
    const result = realEst.estimateOutlet(input, label);
    engineCalls.push({ input, result });
    return result;
  },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cal = require('../ai-rep/learn/calibration') as typeof import('../ai-rep/learn/calibration');
const { fitCalibration, locoGate, checkCalRollback, calMetrics, resolveTuning, looPairs, evaluateSnapshots, loadSnapshotPairs, snapshotPairs } = cal;
type CalPair = import('../ai-rep/learn/calibration').CalPair;

// ───────────── أدوات الأزواج ─────────────
const pair = (c: string, t: string, pred: number, actual: number, extra: Partial<CalPair> = {}): CalPair =>
  ({ customerId: c, outletType: t, pred, actual, w: 1, source: 'SNAPSHOT', ...extra });
/** زوج بلوغاريتم نسبة r محدّد: a = (pred+1)·e^r − 1 */
const withR = (c: string, t: string, pred: number, r: number): CalPair => pair(c, t, pred, (pred + 1) * Math.exp(r) - 1);
/** n عميلاً، لكلٍّ منهم صنفان، الفعلي = ratio × المقترح */
function ratioPairs(n: number, t: string, ratio: number, prefix = t): CalPair[] {
  const out: CalPair[] = [];
  for (let i = 0; i < n; i++) for (const pred of [12 + i, 40 + i]) out.push(pair(`${prefix}${i}`, t, pred, ratio * pred));
  return out;
}
const learnedWith = (params: CalParams | null, version = 3): Learned =>
  ({ mode: 'AUTO', policy: null, calibration: params ? { version, params } : null, field: null, lessons: [] });

// ───────────── التقدير ─────────────

test('فعليٌّ = ٠٫٦ × المقترح ⇒ المعامل ≈ ٠٫٦ (±١٠٪) ويُفعَّل', () => {
  const { params, active, customers } = fitCalibration(ratioPairs(30, 'GROCERY', 0.6), 5);
  assert.equal(active, true);
  assert.equal(customers, 30);
  assert.equal(params.v, 1);
  assert.equal(params.pairs, 60);
  assert.ok(Math.abs(params.trial.tenant - 0.6) <= 0.06, `tenant ${params.trial.tenant}`);
  assert.ok(Math.abs(params.trial.byType.GROCERY - 0.6) <= 0.06, `GROCERY ${params.trial.byType.GROCERY}`);
});

test('الحصر في [٠٫٥، ١٫٥]', () => {
  const low = fitCalibration(ratioPairs(20, 'GROCERY', 0.1), 5).params;
  assert.equal(low.trial.tenant, 0.5);
  assert.equal(low.trial.byType.GROCERY, 0.5);
  const high = fitCalibration(ratioPairs(20, 'GROCERY', 5), 5).params;
  assert.equal(high.trial.tenant, 1.5);
  assert.equal(high.trial.byType.GROCERY, 1.5);
});

test('لا تفعيل تحت max(8, minPeers) عميلاً مميّزاً (حدّ خصوصية)', () => {
  assert.equal(fitCalibration(ratioPairs(7, 'GROCERY', 0.6), 5).active, false);
  assert.equal(fitCalibration(ratioPairs(8, 'GROCERY', 0.6), 5).active, true);
  assert.equal(fitCalibration(ratioPairs(9, 'GROCERY', 0.6), 10).active, false);
  assert.equal(fitCalibration(ratioPairs(10, 'GROCERY', 0.6), 10).active, true);
  assert.equal(cal.calNeeded(5), 8);
  assert.equal(cal.calNeeded(12), 12);
  // أزواج كثيرة لعميل واحد لا تعوّض قلّة العملاء
  const many = Array.from({ length: 50 }, (_, i) => pair('solo', 'GROCERY', 10 + i, 6 + i));
  assert.equal(fitCalibration([...many, ...ratioPairs(6, 'GROCERY', 0.6)], 5).active, false);
  // لا أزواج ⇒ معامل ١ بلا تفعيل
  const empty = fitCalibration([], 5);
  assert.equal(empty.active, false);
  assert.equal(empty.params.trial.tenant, 1);
});

test('نوعٌ بأقل من minPeers عميلاً يرث μ_T (معامل الشركة)، ونوعٌ كافٍ ينكمش نحوه', () => {
  const pairs = [...ratioPairs(20, 'GROCERY', 0.6), ...ratioPairs(3, 'CAFE', 1.4), ...ratioPairs(6, 'SUPERMARKET', 1.3)];
  const { params } = fitCalibration(pairs, 5);
  assert.ok(!('CAFE' in params.trial.byType), 'CAFE بثلاثة عملاء لا معامل خاصاً له');
  assert.ok('GROCERY' in params.trial.byType && 'SUPERMARKET' in params.trial.byType);
  assert.ok(params.trial.byType.SUPERMARKET > params.trial.tenant);
  assert.ok(params.trial.byType.GROCERY < params.trial.tenant);
  assert.equal(resolveTuning(learnedWith(params), 'CAFE', 'AUTO').trialFactor, params.trial.tenant);
  assert.equal(resolveTuning(learnedWith(params), 'BAKERY', 'AUTO').trialFactor, params.trial.tenant);
  assert.equal(resolveTuning(learnedWith(params), 'SUPERMARKET', 'AUTO').trialFactor, params.trial.byType.SUPERMARKET);
});

test('أقل من ١٢ عميلاً ⇒ المعامل لا يرفع الاقتراح (≤١)، ومن ١٢ يرفعه', () => {
  const under = fitCalibration(ratioPairs(10, 'GROCERY', 2), 5);
  assert.equal(under.active, true);
  assert.equal(under.params.trial.tenant, 1);
  assert.equal(under.params.trial.byType.GROCERY, 1);
  // الخفض مسموح تحت ١٢
  assert.ok(fitCalibration(ratioPairs(10, 'GROCERY', 0.6), 5).params.trial.tenant < 1);
  const full = fitCalibration(ratioPairs(12, 'GROCERY', 2), 5);
  assert.ok(full.params.trial.tenant > 1, `tenant ${full.params.trial.tenant}`);
});

test('تطبيع الوزن لكل عميل: عميلٌ كثير الأصناف لا يطغى على العشرين', () => {
  const big = Array.from({ length: 36 }, (_, i) => pair('big', 'GROCERY', 20 + i, 1.5 * (20 + i)));
  const { params } = fitCalibration([...ratioPairs(20, 'GROCERY', 0.6), ...big], 5);
  assert.ok(params.trial.tenant < 0.85, `tenant ${params.trial.tenant}`);
});

test('أزواج LOO لعميلٍ له لقطة حقيقية تُسقط (اللقطة أصدق، ولا عدّ مزدوج)؛ وزوج a=0 لا يدخل التقدير', () => {
  const base = ratioPairs(10, 'GROCERY', 0.6);
  const loo = [pair('GROCERY0', 'GROCERY', 30, 18, { source: 'LOO', w: 0.5 }), pair('x1', 'GROCERY', 30, 18, { source: 'LOO', w: 0.5 })];
  const zero = pair('GROCERY1', 'GROCERY', 9, 0);
  const f = fitCalibration([...base, ...loo, zero], 5);
  assert.equal(f.params.pairs, base.length + 1);
  assert.equal(f.customers, 11);
});

// ───────────── بوابة الاستبعاد الواحد ─────────────

// ضجيج حتمي بأرباع طبيعية تقريبية (٤٠ عميلاً)
const qn = (u: number) => {
  const t = Math.sqrt(-2 * Math.log(u < 0.5 ? u : 1 - u));
  const z = t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
  return u < 0.5 ? -z : z;
};
const EPS = Array.from({ length: 40 }, (_, i) => 0.4 * qn((i + 0.5) / 40));
const biased = (b: number) => EPS.map((e, i) => withR(`c${i}`, 'GROCERY', 20, b + e));

test('بوابة LOCO: انحياز واضح ⇒ ترقية؛ تحسّن أقل من ٣٪ ⇒ رفض', () => {
  const clear = locoGate(biased(0.4), 5, null);
  assert.equal(clear.ok, true);
  assert.equal(clear.locoPairs, 40);
  assert.equal(clear.Ecur, null);
  assert.ok(clear.E <= 0.97 * clear.E0);

  const small = locoGate(biased(0.1), 5, null);
  assert.ok(small.E < small.E0, 'فيه تحسّن فعلاً');
  assert.ok(small.E > 0.97 * small.E0, `لكنه أقل من ٣٪: ${small.E}/${small.E0}`);
  assert.equal(small.ok, false);

  // ضجيج متماثل بلا انحياز ⇒ لا ترقية
  assert.equal(locoGate(biased(0), 5, null).ok, false);
});

test('بوابة LOCO بمعايرة نشطة: المرجع Ecur — نموذجٌ جيد لكنه ليس أفضل بـ٣٪ من النشط يُرفض', () => {
  const pairs = biased(0.4);
  const current = fitCalibration(pairs, 5).params;
  const g = locoGate(pairs, 5, current);
  assert.ok(g.E <= 0.97 * g.E0, 'أفضل بكثير من الخام');
  assert.ok(g.Ecur != null && g.E > 0.97 * g.Ecur);
  assert.equal(g.ok, false);
  // معايرة نشطة رديئة (عكس الاتجاه) ⇒ الجديد يتفوّق عليها
  const bad: CalParams = { v: 1, trial: { tenant: 0.6, byType: {} }, customers: 40, pairs: 40 };
  assert.equal(locoGate(pairs, 5, bad).ok, true);
});

test('بوابة LOCO: لا ترقية تحت حدّ التفعيل ولو كان الانحياز واضحاً، ولا أزواج ⇒ رفض', () => {
  assert.equal(locoGate(biased(0.4).slice(0, 7), 5, null).ok, false);
  const none = locoGate([], 5, null);
  assert.deepEqual(none, { ok: false, E0: 0, E: 0, Ecur: null, locoPairs: 0 });
});

// ───────────── الرجوع التلقائي ─────────────

test('الرجوع: المعروض أسوأ من الخام باحتمال ≥ ٠٫٩ مع n ≥ ١٠ ⇒ رجوع؛ وإلا لا', () => {
  // المعروض أسوأ: الفعلي = الخام، والمعروض مخفَّض
  const worse = (c: string) => pair(c, 'GROCERY', 10, 10, { shown: 6, calVersion: 3 });
  const better = (c: string) => pair(c, 'GROCERY', 10, 6, { shown: 6, calVersion: 3 });
  const set = [...Array.from({ length: 10 }, (_, i) => worse(`w${i}`)), better('b1'), better('b2')];
  assert.deepEqual(checkCalRollback(set, 3), { rollback: true, k: 2, n: 12 });

  // n < 10 ⇒ لا رجوع ولو كانت كلها أسوأ
  assert.equal(checkCalRollback(set.slice(0, 9), 3).rollback, false);
  // ٤ من ١٠ أفضل ⇒ P ≈ ٠٫٧٣ < ٠٫٩
  const mixed = [...Array.from({ length: 6 }, (_, i) => worse(`w${i}`)), ...Array.from({ length: 4 }, (_, i) => better(`b${i}`))];
  assert.equal(checkCalRollback(mixed, 3).rollback, false);
  // نسخة أخرى، وأزواج LOO، والتعادل — لا تُحتسب
  const other = [...set.map(p => ({ ...p, calVersion: 2 })), ...set.map(p => ({ ...p, source: 'LOO' as const })),
    pair('tie', 'GROCERY', 10, 8, { shown: 10, calVersion: 3 })];
  assert.deepEqual(checkCalRollback(other, 3), { rollback: false, k: 0, n: 0 });
});

// ───────────── المؤشرات ─────────────

test('calMetrics: buyThrough ومقارنة اللقطات المعكوسة والخطأ النموذجي', () => {
  const pairs: CalPair[] = [
    pair('cA', 'GROCERY', 8, 6, { shown: 5, calVersion: 2 }), // المعروض أقرب
    pair('cA', 'GROCERY', 3, 0, { shown: 2, calVersion: 2 }), // اقتُرح ولم يُشترَ
    pair('cB', 'GROCERY', 7, 9, { shown: 5, calVersion: 2 }), // الخام أقرب
    pair('cC', 'GROCERY', 7, 7, { shown: 7, calVersion: null }), // بلا معايرة ⇒ خارج المقارنة
    pair('cA', 'GROCERY', 8, 6, { source: 'LOO', w: 0.5 }), // له لقطة ⇒ يسقط
    pair('cD', 'GROCERY', 8, 4, { source: 'LOO', w: 0.5 }),
    pair('cD', 'GROCERY', 2, 0, { source: 'LOO', w: 0.5 }),
  ];
  const m = calMetrics(pairs, null);
  assert.deepEqual(m.buyThrough, { suggested: 6, taken: 4 });
  assert.deepEqual(m.snapshot, { n: 2, calBetter: 1, rawBetter: 1 });
  assert.equal(m.E, null);
  assert.equal(m.typicalErrorCalX, null);
  assert.ok(m.E0 != null && m.E0 > 0);
  assert.equal(m.typicalErrorRawX, Math.round(Math.exp(m.E0!) * 100) / 100);

  const g = locoGate(biased(0.4), 5, null);
  const m2 = calMetrics(biased(0.4), g);
  assert.equal(m2.E, g.E);
  assert.equal(m2.E0, g.E0);
  assert.equal(m2.locoPairs, 40);
  assert.equal(m2.typicalErrorX, Math.round(Math.exp(g.E) * 100) / 100);
  assert.equal(m2.typicalErrorCalX, m2.typicalErrorX);
  assert.ok(m2.typicalErrorCalX! < m2.typicalErrorRawX!);
  assert.doesNotThrow(() => JSON.stringify(m2));
});

// ───────────── الاستعمال الحيّ ─────────────

test('resolveTuning: OFF أو بلا معايرة ⇒ {1, null}؛ وإلا معامل النوع ونسخته', () => {
  const params: CalParams = { v: 1, trial: { tenant: 0.8, byType: { GROCERY: 0.7 } }, customers: 20, pairs: 40 };
  assert.deepEqual(resolveTuning(learnedWith(params), 'GROCERY', 'OFF'), { trialFactor: 1, calibrationVersion: null });
  assert.deepEqual(resolveTuning(learnedWith(null), 'GROCERY', 'AUTO'), { trialFactor: 1, calibrationVersion: null });
  assert.deepEqual(resolveTuning(learnedWith(params, 4), 'GROCERY', 'AUTO'), { trialFactor: 0.7, calibrationVersion: 4 });
  assert.deepEqual(resolveTuning(learnedWith(params, 4), 'CAFE', 'REVIEW'), { trialFactor: 0.8, calibrationVersion: 4 });
  // معامل = ١ لا يغيّر الرقم ⇒ لا نسخة
  const one: CalParams = { v: 1, trial: { tenant: 1, byType: {} }, customers: 10, pairs: 20 };
  assert.deepEqual(resolveTuning(learnedWith(one), 'CAFE', 'AUTO'), { trialFactor: 1, calibrationVersion: null });
  // Json تالف أو خارج الحدود ⇒ آمن ومحصور
  const junk = { v: 1, trial: { tenant: 9, byType: { GROCERY: 'x' } } } as unknown as CalParams;
  assert.equal(resolveTuning(learnedWith(junk), 'CAFE', 'AUTO').trialFactor, 1.5);
  assert.equal(resolveTuning(learnedWith({} as CalParams), 'CAFE', 'AUTO').trialFactor, 1);
});

// ───────────── اختبار LOO على العملاء الحديثين ─────────────

const NOW = new Date('2026-09-20T09:00:00Z');
const WINDOW = { from: '2026-03', to: '2026-08' };
const BASE = { lat: 24.7136, lng: 46.6753 };
const YMS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
const peer = (id: string, dxKm: number, opts: Partial<PeerCustomer> = {}): PeerCustomer => ({
  id, lat: BASE.lat, lng: BASE.lng + dxKm / 101, outletType: 'GROCERY', firstYm: '2025-01', lastInvoiceAt: new Date('2026-09-10T00:00:00Z'), ...opts,
});

function looData(nRecent: number): TenantEstimateData {
  const peers: PeerCustomer[] = [], monthly: PeerProductMonth[] = [], firstOrders: FirstOrderLine[] = [];
  for (let i = 0; i < 12; i++) {
    const id = `old${i}`;
    peers.push(peer(id, i * 0.05));
    for (const ym of YMS) monthly.push({ customerId: id, productId: 'water', ym, qty: 10 + (i % 3), value: 100 });
    firstOrders.push({ customerId: id, productId: 'water', qty: 8 + (i % 3) });
  }
  for (let i = 0; i < nRecent; i++) {
    const id = `new${String(i).padStart(3, '0')}`;
    peers.push(peer(id, 0.3 + i * 0.001, { firstYm: '2026-04' }));
    for (const ym of YMS.slice(1)) monthly.push({ customerId: id, productId: 'water', ym, qty: 6, value: 60 });
    firstOrders.push({ customerId: id, productId: 'water', qty: 5 }, { customerId: id, productId: 'juice', qty: 2 });
  }
  // حديث لكن من نوع خارج الأهداف
  peers.push(peer('cafe1', 0.2, { outletType: 'CAFE', firstYm: '2026-05' }));
  firstOrders.push({ customerId: 'cafe1', productId: 'water', qty: 3 });
  return {
    timezone: 'Asia/Riyadh', window: WINDOW, peers, monthly, firstOrders,
    products: [{ id: 'water', name: 'مياه', unit: 'كرتون' }, { id: 'juice', name: 'عصير', unit: 'كرتون' }],
  };
}
const S = { targetOutletTypes: ['GROCERY', 'MINIMARKET'], minPeers: 5, showMoney: true };

test('LOO: يستبعد الهدف نفسه، ويقتصر على العملاء الحديثين من الأنواع المستهدفة، بلا معايرة وبوزن ½', () => {
  engineCalls.length = 0;
  const data = looData(3);
  const pairs = looPairs(data, S, 'T1', '2026-09-20', NOW);
  const recent = new Set(['new000', 'new001', 'new002']);
  assert.equal(engineCalls.length, 3);
  for (const { input, result } of engineCalls) {
    const id = input.target.excludeCustomerId!;
    assert.ok(recent.has(id), `هدف غير حديث: ${id}`);
    const self = data.peers.find(p => p.id === id)!;
    assert.equal(input.target.lat, self.lat);
    assert.equal(input.target.lng, self.lng);
    assert.equal(input.trialFactor, 1);
    assert.ok(result.ok);
    // ١٢ قديماً + ٣ حديثين − الهدف نفسه
    assert.equal(result.ok && result.peers, 14);
  }
  assert.equal(pairs.length, 3, 'صنف واحد مقترح (الماء) لكل هدف؛ العصير بلا اقتراح');
  for (const p of pairs) {
    assert.ok(recent.has(p.customerId));
    assert.equal(p.source, 'LOO');
    assert.equal(p.w, 0.5);
    assert.equal(p.actual, 5);
    assert.ok(p.pred >= 8 && p.pred <= 10, `pred ${p.pred}`);
    assert.equal(p.shown, undefined);
  }
});

test('LOO: خلط بذري حتمي (tid+day) وسقف ٢٠٠ هدف', () => {
  const data = looData(250);
  engineCalls.length = 0;
  const a = looPairs(data, S, 'T1', '2026-09-20', NOW);
  assert.equal(engineCalls.length, 200);
  const b = looPairs(data, S, 'T1', '2026-09-20', NOW);
  assert.deepEqual(a.map(p => p.customerId), b.map(p => p.customerId));
  const c = looPairs(data, S, 'T1', '2026-09-21', NOW);
  assert.notDeepEqual(new Set(a.map(p => p.customerId)), new Set(c.map(p => p.customerId)));
  assert.ok(a.every(p => p.customerId.startsWith('new')));
});

// ───────────── المحرّك: trialFactor يمسّ الاقتراح وحده ─────────────

test('المحرّك: trialFactor يغيّر الطلب التجريبي وحده — أرقام المحلات المشابهة مطابقة بايتاً بايتاً، والمحجوب محجوب', () => {
  const peers: PeerCustomer[] = [], monthly: PeerProductMonth[] = [], firstOrders: FirstOrderLine[] = [];
  for (let i = 0; i < 10; i++) {
    const id = `p${i}`;
    peers.push(peer(id, i * 0.1));
    for (const ym of YMS) {
      monthly.push({ customerId: id, productId: 'water', ym, qty: 8 + i, value: 80 + 10 * i });
      monthly.push({ customerId: id, productId: 'gum', ym, qty: 1, value: 5 });
      if (i < 2) monthly.push({ customerId: id, productId: 'juice', ym, qty: 4, value: 40 }); // مشتريان ⇒ FEW_BUYERS
      if (i < 6) monthly.push({ customerId: id, productId: 'chips', ym, qty: i === 0 ? 1000 : 1, value: 10 }); // مهيمَن ⇒ DOMINANT
    }
    firstOrders.push({ customerId: id, productId: 'water', qty: 7 }, { customerId: id, productId: 'gum', qty: 1 });
  }
  const base: EngineInput = {
    target: { lat: BASE.lat, lng: BASE.lng, outletType: 'GROCERY' }, now: NOW, window: WINDOW, peers, monthly, firstOrders,
    products: ['water', 'gum', 'juice', 'chips'].map(id => ({ id, name: id, unit: 'كرتون' })), minPeers: 5, showMoney: true,
  };
  const r1 = realEst.estimateOutlet({ ...base, trialFactor: 1 }, 'بقالة');
  assert.ok(r1.ok);
  const peerFacts = (r: EstimateResult) => r.ok ? JSON.stringify({
    ringKm: r.ringKm, peers: r.peers, confidence: r.confidence, monthlyTotalValue: r.monthlyTotalValue, why: r.why,
    products: r.products.map(p => [p.productId, p.monthlyQty, p.monthlyValue, p.firstOrderQty, p.buyers, p.penetration, p.peers, p.hidden, p.confidence, p.trialQtyRaw]),
  }) : '';
  assert.equal(r1.ok && r1.products.find(p => p.productId === 'juice')!.hidden, 'FEW_BUYERS');
  assert.equal(r1.ok && r1.products.find(p => p.productId === 'chips')!.hidden, 'DOMINANT');
  assert.equal(r1.ok && r1.calibrationVersion, null);
  for (const f of [0.5, 0.6, 1.4, 1.5]) {
    const rf = realEst.estimateOutlet({ ...base, trialFactor: f, calibrationVersion: 7 }, 'بقالة');
    assert.ok(rf.ok);
    assert.equal(peerFacts(rf), peerFacts(r1), `f=${f}`);
    if (!rf.ok || !r1.ok) continue;
    assert.equal(rf.calibrationVersion, 7);
    for (const p of rf.products) {
      const p1 = r1.products.find(x => x.productId === p.productId)!;
      assert.equal(p.trialQtyRaw, p1.trialQtyRaw, 'الخام لا يتغيّر');
      if (p.hidden) {
        assert.equal(p.trialQty, null);
        assert.equal(p.trialQtyRaw, null);
        assert.equal(p.trialCalibrated, false);
        continue;
      }
      assert.ok(p.trialQty != null && p.trialQty >= 1);
      assert.equal(p.trialCalibrated, true);
    }
    const water = rf.products.find(p => p.productId === 'water')!;
    assert.equal(water.trialQty, Math.max(1, Math.round(7 * f)));
    assert.equal(rf.products.find(p => p.productId === 'gum')!.trialQty, Math.max(1, Math.round(f)), 'أساس ١ ⇒ لا ينزل تحت ١');
  }
});

// ───────────── تقييم اللقطات وتحميلها ─────────────

test('evaluateSnapshots: الاستعلام مقيّد بالشركة على كل جدول، ومسار «لا شراء»، والتحديث بـ{id, tenantId}', async () => {
  rawCalls = []; updates = [];
  rawRows = [
    { sid: 's1', productId: 'water', qty: 4 },
    { sid: 's1', productId: 'juice', qty: 2.5 },
    { sid: 's2', productId: null, qty: null },
  ];
  const now = new Date('2026-09-27T00:00:00Z');
  assert.equal(await evaluateSnapshots('T1', now), 2);
  assert.equal(rawCalls.length, 1);
  const q = rawCalls[0];
  // كل «"tenantId" =» يليه المعامل tid نفسه، وثلاث مرات (اللقطات + الفواتير في الربط الأول والثاني)
  let tenantParams = 0;
  q.strings.forEach((s, i) => {
    if (/"tenantId"\s*=\s*$/.test(s)) { assert.equal(q.values[i], 'T1'); tenantParams++; }
  });
  assert.equal(tenantParams, 3);
  const cutoff = q.values.find(v => v instanceof Date) as Date;
  assert.equal(cutoff.getTime(), now.getTime() - 45 * 86400000);
  assert.ok(q.values.every(v => v === 'T1' || v instanceof Date), 'لا قيم أخرى في الاستعلام');

  assert.deepEqual(updates, [
    { where: { id: 's1', tenantId: 'T1' }, data: { actual: { first: { water: 4, juice: 2.5 }, noPurchase: false }, evaluatedAt: now } },
    { where: { id: 's2', tenantId: 'T1' }, data: { actual: { first: {}, noPurchase: true }, evaluatedAt: now } },
  ]);
});

test('evaluateSnapshots: فحص نصّي ثابت — "tenantId" = ${tid} على كل جدول حقيقي، وinvoice_items عبر فاتورة مقيّدة', () => {
  const file = path.join(process.cwd(), 'src', 'ai-rep', 'learn', 'calibration.ts');
  assert.ok(fs.existsSync(file), file);
  const code = fs.readFileSync(file, 'utf8');
  const start = code.indexOf('prisma.$queryRaw');
  assert.ok(start > 0);
  assert.equal(code.indexOf('prisma.$queryRaw', start + 1), -1, 'استعلام خام واحد في الوحدة');
  const sql = code.slice(code.indexOf('Prisma.sql`', start), code.indexOf('`)', start));
  assert.ok(sql.includes('ai_estimate_snapshots') && sql.includes('invoice_items'));
  assert.match(sql, /FROM ai_estimate_snapshots\s+WHERE "tenantId" = \$\{tid\}/);
  const invoiceJoins = [...sql.matchAll(/JOIN invoices (\w+) ON ([^\n]+)/g)];
  assert.equal(invoiceJoins.length, 2);
  for (const [, alias, on] of invoiceJoins) assert.ok(on.includes(`${alias}."tenantId" = \${tid}`), `الربط ${alias} بلا عزل`);
  const items = sql.match(/JOIN invoice_items (\w+) ON \1\."invoiceId" = (\w+)\.id/);
  assert.ok(items, 'invoice_items تُربط بفاتورة');
  assert.ok(invoiceJoins.some(([, alias]) => alias === items![2]), 'والفاتورة مقيّدة بالشركة');
  assert.equal(sql.match(/"tenantId" = \$\{tid\}/g)?.length, 3);
  const interps = [...sql.matchAll(/\$\{([^}]+)\}/g)].map(m => m[1]);
  assert.ok(interps.every(x => x === 'tid' || x === 'cutoff'), interps.join(','));
  // كل نداء prisma في الوحدة يحمل tenantId
  const calls = [...code.matchAll(/prisma\.(\w+)\.(\w+)\(\{([\s\S]*?)\}\);/g)];
  assert.equal(calls.length, 2, 'findMany + updateMany');
  for (const m of calls) assert.ok(m[3].includes('tenantId'), `${m[1]}.${m[2]}`);
});

test('loadSnapshotPairs: مقيّد بالشركة؛ pred = trialQtyRaw ?? trialQty، shown = trialQty، ونسخة المعايرة من الصف', async () => {
  findArgs = [];
  snapRows = [
    {
      customerId: 'cA', outletType: 'GROCERY', calibrationVersion: 2, actual: { first: { water: 6 }, noPurchase: false },
      payload: { v: 2, calibrationVersion: 2, products: [
        { productId: 'water', trialQtyRaw: 8, trialQty: 5 },
        { productId: 'juice', trialQtyRaw: null, trialQty: null },
        { productId: 'chips', trialQtyRaw: 3, trialQty: 2 },
      ] },
    },
    { customerId: 'cB', outletType: 'CAFE', calibrationVersion: null, actual: { first: { water: 7 }, noPurchase: false }, payload: { products: [{ productId: 'water', trialQty: 7 }] } },
    { customerId: 'cC', outletType: 'GROCERY', calibrationVersion: null, actual: { first: {}, noPurchase: true }, payload: { products: [{ productId: 'water', trialQty: 7 }] } },
    { customerId: null, outletType: 'GROCERY', calibrationVersion: null, actual: { first: { water: 1 } }, payload: { products: [{ productId: 'water', trialQty: 7 }] } },
  ];
  const pairs = await loadSnapshotPairs('T1');
  assert.equal(findArgs.length, 1);
  assert.equal(findArgs[0].where.tenantId, 'T1');
  assert.deepEqual(findArgs[0].where.evaluatedAt, { not: null });
  assert.deepEqual(pairs, [
    { customerId: 'cA', outletType: 'GROCERY', pred: 8, actual: 6, w: 1, source: 'SNAPSHOT', shown: 5, calVersion: 2 },
    { customerId: 'cA', outletType: 'GROCERY', pred: 3, actual: 0, w: 1, source: 'SNAPSHOT', shown: 2, calVersion: 2 },
    { customerId: 'cB', outletType: 'CAFE', pred: 7, actual: 7, w: 1, source: 'SNAPSHOT', shown: 7, calVersion: null },
  ]);
  // حمولة تالفة لا تُسقط الليلة
  assert.deepEqual(snapshotPairs([{ customerId: 'x', outletType: 'GROCERY', calibrationVersion: null, actual: 'junk', payload: null }]), []);
});
