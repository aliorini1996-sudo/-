/**
 * حلقة التعلّم — معايرة الطلب التجريبي: يتعلّم من مقارنة ما اقترحه بأول طلب حقيقي للعملاء الجدد.
 *
 * الأزواج (المقترح مقابل الفعلي، بشرط أن يكون الصنف في الطلب الأول):
 *   - لقطات التحويل الناضجة (≥٤٥ يوماً) بعد تقييمها بأول فاتورة بيع — وزن ١، والمقترح هو الخام قبل المعايرة.
 *   - اختبار «استبعاد واحد» على العملاء الحديثين من بيانات المحرّك المخزّنة مؤقتاً — وزن ½، بلا استعلام إضافي.
 *   - الوزن يُقسم على √(عدد أزواج العميل) كي لا يطغى عميل كثير الأصناف.
 * النموذج: طبيعي–طبيعي على لوغاريتم النسبة r = ln(a+1) − ln(pred+1) بانكماش نحو الصفر (= بلا معايرة)،
 * ولكل نوع محل انكماش نحو معامل الشركة. المعامل محصور في [٠٫٥، ١٫٥]، ولا يتجاوز ١ قبل ١٢ عميلاً.
 * لا تُفعَّل المعايرة من أقل من max(8, minPeers) عميلاً (حدّ خصوصية)، ولا تُرقّى إلا إن خفّضت الخطأ
 * ٣٪ على الأقل باستبعاد عميل واحد في كل مرة، وتُرجَع تلقائياً إن ثبت أن المعروض أسوأ من الخام.
 * المعايرة لا تمسّ أرقام المحلات المشابهة (الشهري، أول طلب، المشترون، الانتشار) — الاقتراح وحده.
 */
import { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { estimateOutlet } from '../estimate';
import type { TenantEstimateData } from '../estimateData';
import { outletTypeLabel } from '../taxonomy';
import { betaMeanVar, clamp, fnv1a32, mulberry32, normalCdf, shrinkNormal, weightedMedian, weightedVar } from './stats';
import type { CalParams, Learned } from './types';

const DAY_MS = 86400000;
/** عمر اللقطة قبل تقييمها (يطابق نافذة ٤٥ يوماً في الاستعلام). */
const MATURE_DAYS = 45;
const SNAPSHOT_TAKE = 3000;
const LOO_CAP = 200;
const LOO_WEIGHT = 0.5;
const F_MIN = 0.5, F_MAX = 1.5;
const SIGMA_MIN = 0.35, TAU_TENANT = 0.3, TAU_TYPE = 0.2;
/** دون هذا العدد من العملاء لا يرفع المعامل الاقتراح (≤١). */
const FULL_CUSTOMERS = 12;
const GATE_RATIO = 0.97;

/** حدّ التفعيل: عدد العملاء المميّزين اللازم (خصوصية: لا معامل من أقل من minPeers عميلاً). */
export const calNeeded = (minPeers: number): number => Math.max(8, minPeers);

/**
 * زوج معايرة. actual = 0 يعني «اقتُرح ولم يكن في الطلب الأول» — لا يدخل التقدير، ويُحتسب في buyThrough وحده.
 */
export interface CalPair {
  customerId: string;
  outletType: string;
  /** الطلب التجريبي الخام (قبل المعايرة) */
  pred: number;
  actual: number;
  w: number;
  source: 'SNAPSHOT' | 'LOO';
  /** ما عُرض فعلاً للمندوب (لقطات فقط) */
  shown?: number;
  /** نسخة المعايرة المعروضة (لقطات فقط) */
  calVersion?: number | null;
}

// ───────────── تقييم اللقطات ─────────────

export interface SnapActualRow { sid: string; productId: string | null; qty: number | null }
export type SnapActual = { first: Record<string, number>; noPurchase: boolean };

/** صفوف الاستعلام ← الطلب الأول لكل لقطة؛ noPurchase = لا صفّ بصنف (لا فاتورة خلال النافذة). */
export function buildActuals(rows: SnapActualRow[]): Map<string, SnapActual> {
  const out = new Map<string, SnapActual>();
  for (const r of rows) {
    const a = out.get(r.sid) ?? { first: {}, noPurchase: true };
    if (r.productId) {
      a.noPurchase = false;
      const q = Number(r.qty) || 0;
      if (q > 0) a.first[r.productId] = Math.round(((a.first[r.productId] ?? 0) + q) * 1000) / 1000;
    }
    out.set(r.sid, a);
  }
  return out;
}

/**
 * تقييم اللقطات الناضجة (≥٤٥ يوماً، ≤٥٠ في الليلة) بأول فاتورة بيع مؤكَّدة للعميل خلال ٤٥ يوماً من اللقطة.
 * العزل: كل جدول حقيقي مقيّد بـ"tenantId" = tid؛ invoice_items بلا tenantId فتُبلَغ عبر فاتورةٍ مقيّدة بالشركة.
 */
export async function evaluateSnapshots(tid: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - MATURE_DAYS * DAY_MS);
  const rows = await prisma.$queryRaw<SnapActualRow[]>(Prisma.sql`
    WITH s AS (
      SELECT id, "customerId", "createdAt" FROM ai_estimate_snapshots
      WHERE "tenantId" = ${tid} AND "evaluatedAt" IS NULL AND "customerId" IS NOT NULL AND "createdAt" <= ${cutoff}
      ORDER BY "createdAt" LIMIT 50
    ),
    f AS (
      SELECT DISTINCT ON (s.id) s.id AS sid, i.id AS iid
      FROM s
      JOIN invoices i ON i."tenantId" = ${tid} AND i."customerId" = s."customerId" AND i.status = 'CONFIRMED'
        AND i.type IN ('CASH', 'CREDIT') AND i."invoiceDate" >= s."createdAt" - interval '10 minutes'
        AND i."invoiceDate" < s."createdAt" + interval '45 days'
      ORDER BY s.id, i."invoiceDate", i.id
    )
    SELECT s.id AS sid, ii."productId" AS "productId", SUM(ii.qty)::float8 AS qty
    FROM s
    LEFT JOIN f ON f.sid = s.id
    LEFT JOIN invoices fi ON fi.id = f.iid AND fi."tenantId" = ${tid}
    LEFT JOIN invoice_items ii ON ii."invoiceId" = fi.id AND ii."productId" IS NOT NULL
    GROUP BY 1, 2`);
  let n = 0;
  for (const [sid, actual] of buildActuals(rows)) {
    const r = await prisma.aiEstimateSnapshot.updateMany({ where: { id: sid, tenantId: tid }, data: { actual: actual as Prisma.InputJsonObject, evaluatedAt: now } });
    n += r.count;
  }
  return n;
}

// ───────────── الأزواج ─────────────

export interface SnapRow { customerId: string | null; outletType: string; payload: unknown; actual: unknown; calibrationVersion: number | null }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** لقطات مُقيَّمة ← أزواج (pred = trialQtyRaw ?? trialQty؛ الحمولة القديمة trialQty فيها خام). */
export function snapshotPairs(rows: SnapRow[]): CalPair[] {
  const out: CalPair[] = [];
  for (const row of rows) {
    const act = row.actual as Partial<SnapActual> | null;
    if (!row.customerId || !act || act.noPurchase || !act.first || typeof act.first !== 'object') continue;
    const pay = row.payload as { products?: unknown; calibrationVersion?: unknown } | null;
    const calVersion = row.calibrationVersion ?? num(pay?.calibrationVersion);
    const products = Array.isArray(pay?.products) ? (pay!.products as Array<Record<string, unknown>>) : [];
    for (const p of products) {
      const shown = num(p?.trialQty);
      const pred = num(p?.trialQtyRaw) ?? shown;
      if (typeof p?.productId !== 'string' || pred == null || !(pred > 0)) continue;
      out.push({
        customerId: row.customerId, outletType: row.outletType, pred, actual: Math.max(0, num(act.first[p.productId]) ?? 0),
        w: 1, source: 'SNAPSHOT', shown: shown ?? pred, calVersion,
      });
    }
  }
  return out;
}

export async function loadSnapshotPairs(tid: string): Promise<CalPair[]> {
  const rows = await prisma.aiEstimateSnapshot.findMany({
    where: { tenantId: tid, evaluatedAt: { not: null }, customerId: { not: null } },
    select: { customerId: true, outletType: true, payload: true, actual: true, calibrationVersion: true },
    orderBy: { createdAt: 'desc' },
    take: SNAPSHOT_TAKE,
  });
  return snapshotPairs(rows);
}

/**
 * اختبار «استبعاد واحد» على العملاء الحديثين (أول فاتورة داخل النافذة): يُقدَّر كل منهم كأنه محلّ جديد
 * (مستبعداً نفسه) بلا معايرة، ويُقارن الطلب التجريبي الخام بطلبه الأول الفعلي. خلط بذري ثم سقف ٢٠٠.
 */
export function looPairs(
  data: TenantEstimateData, s: { targetOutletTypes: string[]; minPeers: number; showMoney: boolean }, tid: string, day: string, now: Date,
): CalPair[] {
  const types = new Set(s.targetOutletTypes);
  const targets = data.peers
    .filter(p => types.has(p.outletType) && p.firstYm != null && p.firstYm >= data.window.from && Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rnd = mulberry32(fnv1a32(tid + day));
  for (let i = targets.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [targets[i], targets[j]] = [targets[j], targets[i]];
  }
  const first = new Map<string, Map<string, number>>();
  for (const f of data.firstOrders) {
    const m = first.get(f.customerId) ?? new Map<string, number>();
    m.set(f.productId, (m.get(f.productId) ?? 0) + f.qty);
    first.set(f.customerId, m);
  }
  const out: CalPair[] = [];
  for (const t of targets.slice(0, LOO_CAP)) {
    const bought = first.get(t.id);
    if (!bought) continue;
    const r = estimateOutlet({
      target: { lat: t.lat, lng: t.lng, outletType: t.outletType, excludeCustomerId: t.id },
      now, window: data.window, peers: data.peers, monthly: data.monthly, firstOrders: data.firstOrders,
      products: data.products, minPeers: s.minPeers, showMoney: s.showMoney, trialFactor: 1,
    }, outletTypeLabel(t.outletType));
    if (!r.ok) continue;
    for (const p of r.products) {
      if (p.trialQtyRaw == null) continue;
      out.push({ customerId: t.id, outletType: t.outletType, pred: p.trialQtyRaw, actual: Math.max(0, bought.get(p.productId) ?? 0), w: LOO_WEIGHT, source: 'LOO' });
    }
  }
  return out;
}

/** أزواج صالحة؛ ويُسقط أزواج LOO لعميلٍ له لقطة حقيقية (اللقطة أصدق، ولا عدّ مزدوج). */
function usablePairs(pairs: CalPair[]): CalPair[] {
  const snap = new Set(pairs.filter(p => p.source === 'SNAPSHOT').map(p => p.customerId));
  return pairs.filter(p => Number.isFinite(p.pred) && p.pred > 0 && Number.isFinite(p.actual) && p.actual >= 0 && p.w > 0
    && !(p.source === 'LOO' && snap.has(p.customerId)));
}

interface Obs { c: string; t: string; r: number; w: number }

/** مشاهدات التقدير (a > 0) بوزن مُطبَّع لكل عميل: w/√(أزواجه). */
function observations(pairs: CalPair[]): Obs[] {
  const fit = usablePairs(pairs).filter(p => p.actual > 0);
  const per = new Map<string, number>();
  for (const p of fit) per.set(p.customerId, (per.get(p.customerId) ?? 0) + 1);
  return fit.map(p => ({ c: p.customerId, t: p.outletType, r: Math.log(p.actual + 1) - Math.log(p.pred + 1), w: p.w / Math.sqrt(per.get(p.customerId)!) }));
}

// ───────────── التقدير ─────────────

const r4 = (x: number): number => Math.round(x * 10000) / 10000;

/** معامل نوعٍ من المعاملات (النوع إن وُجد وإلا الشركة) — دفاعي أمام Json قديم. */
function factorFor(p: CalParams | null | undefined, outletType: string): number {
  const f = Number(p?.trial?.byType?.[outletType] ?? p?.trial?.tenant);
  return Number.isFinite(f) && f > 0 ? f : 1;
}

function fitObs(obs: Obs[], minPeers: number): { params: CalParams; active: boolean; customers: number } {
  const customers = new Set(obs.map(o => o.c)).size;
  if (!obs.length) return { params: { v: 1, trial: { tenant: 1, byType: {} }, customers: 0, pairs: 0 }, active: false, customers: 0 };
  const toF = (mu: number) => {
    const f = Math.exp(clamp(mu, Math.log(F_MIN), Math.log(F_MAX)));
    return r4(customers < FULL_CUSTOMERS ? Math.min(f, 1) : f);
  };
  const sigma2 = Math.max(SIGMA_MIN ** 2, weightedVar(obs.map(o => o.r), obs.map(o => o.w)));
  let swr = 0, sw = 0;
  const byT = new Map<string, { swr: number; sw: number; cust: Set<string> }>();
  for (const o of obs) {
    swr += o.w * o.r; sw += o.w;
    const g = byT.get(o.t) ?? { swr: 0, sw: 0, cust: new Set<string>() };
    g.swr += o.w * o.r; g.sw += o.w; g.cust.add(o.c);
    byT.set(o.t, g);
  }
  const muT = shrinkNormal(swr, sw, sigma2, TAU_TENANT ** 2, 0);
  const byType: Record<string, number> = {};
  for (const [t, g] of byT) if (g.cust.size >= minPeers) byType[t] = toF(shrinkNormal(g.swr, g.sw, sigma2, TAU_TYPE ** 2, muT));
  return {
    params: { v: 1, trial: { tenant: toF(muT), byType }, customers, pairs: obs.length },
    active: customers >= calNeeded(minPeers),
    customers,
  };
}

/** معايرة من الأزواج (نوعٌ بأقل من minPeers عميلاً يرث معامل الشركة — غيابه من byType). */
export function fitCalibration(pairs: CalPair[], minPeers: number): { params: CalParams; active: boolean; customers: number } {
  return fitObs(observations(pairs), minPeers);
}

export interface LocoGate { ok: boolean; E0: number; E: number; Ecur: number | null; locoPairs: number }

/**
 * بوابة الترقية باستبعاد عميل واحد: يُعاد التقدير بدونه ثم يُقاس خطؤه |r − ln f̂|.
 * E وسيط موزون؛ E0 بلا معايرة؛ Ecur بالمعايرة الحالية. الترقية إن E ≤ 0.97 × (Ecur إن وُجدت وإلا E0).
 */
export function locoGate(pairs: CalPair[], minPeers: number, current: CalParams | null): LocoGate {
  const obs = observations(pairs);
  if (!obs.length) return { ok: false, E0: 0, E: 0, Ecur: null, locoPairs: 0 };
  const byC = new Map<string, Obs[]>();
  for (const o of obs) {
    const g = byC.get(o.c);
    if (g) g.push(o); else byC.set(o.c, [o]);
  }
  const e: number[] = [], e0: number[] = [], ecur: number[] = [], w: number[] = [];
  for (const [c, own] of byC) {
    const fit = fitObs(obs.filter(o => o.c !== c), minPeers).params;
    for (const o of own) {
      e.push(Math.abs(o.r - Math.log(factorFor(fit, o.t))));
      e0.push(Math.abs(o.r));
      if (current) ecur.push(Math.abs(o.r - Math.log(factorFor(current, o.t))));
      w.push(o.w);
    }
  }
  const E = weightedMedian(e, w), E0 = weightedMedian(e0, w);
  const Ecur = current ? weightedMedian(ecur, w) : null;
  const ref = Ecur ?? E0;
  return {
    ok: byC.size >= calNeeded(minPeers) && ref > 0 && E <= GATE_RATIO * ref,
    E0: r4(E0), E: r4(E), Ecur: Ecur == null ? null : r4(Ecur), locoPairs: obs.length,
  };
}

/**
 * رجوع تلقائي: على لقطات عُرضت بالنسخة النشطة، هل المعروض أقرب للفعلي من الخام؟
 * **صوت واحد لكل عميل** (مجموع فروق أصنافه) — طلبٌ كبير واحد بأصناف كثيرة لا يُسقط المعايرة وحده.
 * k = عملاء فاز فيهم المعروض، n = غير المتعادلين. رجوع إن n ≥ max(٨، الحدّ الأدنى) و P(Beta(1+k,1+n−k) < ½) ≥ 0.9.
 */
export function checkCalRollback(pairs: CalPair[], activeVersion: number, minPeers = 8): { rollback: boolean; k: number; n: number } {
  const byCustomer = new Map<string, { cal: number; raw: number }>();
  for (const p of pairs) {
    if (p.source !== 'SNAPSHOT' || p.calVersion !== activeVersion || p.shown == null || !(p.actual > 0) || !(p.pred > 0)) continue;
    const la = Math.log(p.actual + 1);
    const c = byCustomer.get(p.customerId) ?? { cal: 0, raw: 0 };
    c.cal += Math.abs(la - Math.log(p.shown + 1));
    c.raw += Math.abs(la - Math.log(p.pred + 1));
    byCustomer.set(p.customerId, c);
  }
  let k = 0, n = 0;
  for (const c of byCustomer.values()) {
    if (Math.abs(c.cal - c.raw) < 1e-12) continue;
    n++;
    if (c.cal < c.raw) k++;
  }
  if (n < calNeeded(minPeers)) return { rollback: false, k, n };
  const { mean, v } = betaMeanVar(k, n);
  return { rollback: normalCdf((0.5 - mean) / Math.sqrt(v)) >= 0.9, k, n };
}

export interface CalMetrics {
  E0: number | null;
  E: number | null;
  Ecur: number | null;
  locoPairs: number;
  /** الخطأ النموذجي كمضاعف (×1.4): خاماً وبعد المعايرة */
  typicalErrorRawX: number | null;
  typicalErrorCalX: number | null;
  typicalErrorX: number | null;
  /** مقارنة معكوسة على اللقطات المعروضة معايَرةً: كم مرة كان المعروض أقرب من الخام */
  snapshot: { n: number; calBetter: number; rawBetter: number };
  /** حصة الأصناف المقترحة التي ظهرت في الطلب الأول (لقطات + LOO) */
  buyThrough: { suggested: number; taken: number };
}

export function calMetrics(pairs: CalPair[], gate: ReturnType<typeof locoGate> | null): CalMetrics {
  const usable = usablePairs(pairs);
  const x = (v: number | null) => (v == null || !Number.isFinite(v) ? null : Math.round(Math.exp(v) * 100) / 100);
  let E0: number | null = null, E: number | null = null;
  if (gate && gate.locoPairs > 0) { E0 = gate.E0; E = gate.E; }
  else {
    const obs = observations(pairs);
    if (obs.length) E0 = r4(weightedMedian(obs.map(o => Math.abs(o.r)), obs.map(o => o.w)));
  }
  let n = 0, calBetter = 0, rawBetter = 0;
  for (const p of usable) {
    if (p.source !== 'SNAPSHOT' || p.calVersion == null || p.shown == null || !(p.actual > 0)) continue;
    const la = Math.log(p.actual + 1);
    const dCal = Math.abs(la - Math.log(p.shown + 1)), dRaw = Math.abs(la - Math.log(p.pred + 1));
    n++;
    if (dCal < dRaw - 1e-12) calBetter++;
    else if (dRaw < dCal - 1e-12) rawBetter++;
  }
  return {
    E0, E, Ecur: gate?.Ecur ?? null, locoPairs: gate?.locoPairs ?? 0,
    typicalErrorRawX: x(E0), typicalErrorCalX: x(E), typicalErrorX: x(E),
    snapshot: { n, calBetter, rawBetter },
    buyThrough: { suggested: usable.length, taken: usable.filter(p => p.actual > 0).length },
  };
}

/**
 * معامل الطلب التجريبي لنوع محل من المعايرة النشطة. OFF أو لا معايرة ⇒ {1, null}.
 * نسخة المعايرة تُعاد فقط إن غيّرت الرقم فعلاً (معامل ≠ ١).
 */
export function resolveTuning(learned: Learned, outletType: string, mode: string): { trialFactor: number; calibrationVersion: number | null } {
  const cal = learned?.calibration;
  if (mode === 'OFF' || !cal) return { trialFactor: 1, calibrationVersion: null };
  const f = clamp(factorFor(cal.params, outletType), F_MIN, F_MAX);
  return f === 1 ? { trialFactor: 1, calibrationVersion: null } : { trialFactor: f, calibrationVersion: cal.version };
}
