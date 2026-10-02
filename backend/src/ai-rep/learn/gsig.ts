/**
 * حلقة التعلّم — معايرة «الطلب المتوقع من ملف المحل في Google» (gsig-1) بأول طلب حقيقي.
 *
 * اللقطة: حين يصير محلٌّ عُرض توقّعه عميلاً، يُحفظ ما عُرض للمندوب (الخام قبل المعامل، والمعروض) بوسم gsig-1 في جدول
 * لقطات التوقّع نفسه — فلا تختلط أبداً بلقطات المحلات المشابهة (ai-est-1)، وتقيّمها الليلة بأول فاتورة كغيرها.
 * النموذج: لكل عميل صوتٌ واحد = وسيط ln(الفعلي ÷ الخام) لأصنافه التي اشتراها؛ ومعامل الشركة = وسيط أصوات العملاء
 * منكمشاً نحو ١ (K عملاء وهميون)، ولكل نوع محل وسيط عملائه منكمشاً نحو معامل الشركة (النوع بأقل من minPeers عميلاً يرث
 * معامل الشركة). المعامل محصور في [٠٫٥، ٢]. لا يُفعَّل من أقل من max(8, minPeers) عميلاً، ولا يُرقّى إلا إن خفّض الخطأ
 * ٣٪ على الأقل باستبعاد عميل واحد في كل مرة، ويُرجَع تلقائياً إن ثبت أن المعروض أسوأ من الخام (checkCalRollback).
 */
import prisma from '../../config/database';
import { calNeeded, type CalPair, type SnapActual } from './calibration';
import { clamp } from './stats';
import { GSIG_ENGINE, GSIG_F_MAX as CAL_MAX, GSIG_F_MIN as CAL_MIN, type GsigParams, type Learned } from './types';

export type { GsigParams };

/** عملاء وهميون عند المعامل ١ (الشركة) أو معامل الشركة (النوع). */
const K = 4;
const GATE_RATIO = 0.97;
const SNAPSHOT_TAKE = 3000;

const r4 = (x: number) => Math.round(x * 10000) / 10000;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return !n ? 0 : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

const factorOf = (p: GsigParams | null | undefined, t: string): number => {
  const f = Number(p?.byType?.[t] ?? p?.tenant);
  return Number.isFinite(f) && f > 0 ? f : 1;
};

/** معامل نوع المحل ونسخته من المعايرة النشطة. OFF أو لا معايرة أو معامل ١ ⇒ {1, null}. */
export function resolveGsigFactor(learned: Learned | null | undefined, outletType: string, mode: string): { factor: number; version: number | null } {
  const g = learned?.gsig;
  if (mode === 'OFF' || !g) return { factor: 1, version: null };
  const f = clamp(factorOf(g.params, outletType), CAL_MIN, CAL_MAX);
  return f === 1 ? { factor: 1, version: null } : { factor: f, version: g.version };
}

// ───────────── اللقطة ─────────────

/** ما عُرض للمندوب من «الطلب المتوقع» (في ذاكرة الخادم حتى التحويل). */
export interface ShownExpected {
  at: number;
  outletType: string;
  confidence: string;
  calVersion: number | null;
  factor: number;
  products: { productId: string; qty: number; raw: number }[];
}

const ym = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/** صفّ لقطة gsig-1 (جدول لقطات التوقّع) — النافذة أشهر المرساة الستة حتى لحظة العرض. */
export function gsigSnapshotData(tid: string, ids: { outletId: string; customerId: string }, s: ShownExpected) {
  const at = new Date(s.at);
  const from = new Date(at.getTime());
  from.setUTCMonth(from.getUTCMonth() - 6);
  return {
    tenantId: tid, outletId: ids.outletId, customerId: ids.customerId, engineVersion: GSIG_ENGINE, outletType: s.outletType,
    ringKm: null, peers: 0, confidence: s.confidence, windowFrom: ym(from), windowTo: ym(at), calibrationVersion: s.calVersion,
    payload: {
      v: 1, engine: GSIG_ENGINE, calibrationVersion: s.calVersion, factor: s.factor,
      products: s.products.map(p => ({ productId: p.productId, qty: p.qty, qtyRaw: p.raw })),
    },
  };
}

// ───────────── الأزواج ─────────────

export interface GsigSnapRow { customerId: string | null; outletType: string; payload: unknown; actual: unknown; calibrationVersion: number | null }

/** لقطات gsig-1 مُقيَّمة ← أزواج (pred = الخام قبل المعامل، shown = المعروض). */
export function gsigPairs(rows: GsigSnapRow[]): CalPair[] {
  const out: CalPair[] = [];
  for (const row of rows) {
    const act = row.actual as Partial<SnapActual> | null;
    if (!row.customerId || !act || act.noPurchase || !act.first || typeof act.first !== 'object') continue;
    const pay = row.payload as { products?: unknown; calibrationVersion?: unknown } | null;
    const calVersion = row.calibrationVersion ?? num(pay?.calibrationVersion);
    for (const p of Array.isArray(pay?.products) ? (pay!.products as Array<Record<string, unknown>>) : []) {
      const shown = num(p?.qty);
      const pred = num(p?.qtyRaw) ?? shown;
      if (typeof p?.productId !== 'string' || pred == null || !(pred > 0)) continue;
      out.push({
        customerId: row.customerId, outletType: row.outletType, pred, actual: Math.max(0, num(act.first[p.productId]) ?? 0),
        w: 1, source: 'SNAPSHOT', shown: shown ?? pred, calVersion,
      });
    }
  }
  return out;
}

export async function loadGsigPairs(tid: string): Promise<CalPair[]> {
  const rows = await prisma.aiEstimateSnapshot.findMany({
    where: { tenantId: tid, engineVersion: GSIG_ENGINE, evaluatedAt: { not: null }, customerId: { not: null } },
    select: { customerId: true, outletType: true, payload: true, actual: true, calibrationVersion: true },
    orderBy: { createdAt: 'desc' },
    take: SNAPSHOT_TAKE,
  });
  return gsigPairs(rows);
}

// ───────────── التقدير ─────────────

interface Vote { c: string; t: string; r: number; logs: number[] }

/** صوت لكل عميل: وسيط ln(الفعلي ÷ الخام) لأصنافه المشتراة (الصنف غير المشترى لا يدخل التقدير). */
function votes(pairs: CalPair[]): Vote[] {
  const by = new Map<string, Vote>();
  for (const p of pairs) {
    if (!(p.pred > 0) || !(p.actual > 0) || !Number.isFinite(p.pred) || !Number.isFinite(p.actual)) continue;
    const v = by.get(p.customerId) ?? { c: p.customerId, t: p.outletType, r: 0, logs: [] };
    v.logs.push(Math.log(p.actual / p.pred));
    by.set(p.customerId, v);
  }
  return [...by.values()].map(v => ({ ...v, r: median(v.logs) }));
}

const toF = (mu: number) => r4(Math.exp(clamp(mu, Math.log(CAL_MIN), Math.log(CAL_MAX))));

function fitVotes(vs: Vote[], minPeers: number): { params: GsigParams; active: boolean; customers: number } {
  const n = vs.length;
  const pairs = vs.reduce((a, v) => a + v.logs.length, 0);
  if (!n) return { params: { v: 1, tenant: 1, byType: {}, customers: 0, pairs: 0 }, active: false, customers: 0 };
  const muT = (n * median(vs.map(v => v.r))) / (n + K);
  const byT = new Map<string, number[]>();
  for (const v of vs) byT.set(v.t, [...(byT.get(v.t) ?? []), v.r]);
  const byType: Record<string, number> = {};
  for (const [t, rs] of byT) if (rs.length >= minPeers) byType[t] = toF((rs.length * median(rs) + K * muT) / (rs.length + K));
  return { params: { v: 1, tenant: toF(muT), byType, customers: n, pairs }, active: n >= calNeeded(minPeers), customers: n };
}

/** معامل الشركة ولكل نوع من الأزواج (وسيط أصوات العملاء منكمشاً). */
export function fitGsig(pairs: CalPair[], minPeers: number): { params: GsigParams; active: boolean; customers: number } {
  return fitVotes(votes(pairs), minPeers);
}

export interface GsigGate { ok: boolean; E0: number; E: number; Ecur: number | null; customers: number }

/**
 * بوابة الترقية باستبعاد عميل واحد: يُعاد التقدير بدونه ثم خطؤه = وسيط |ln(a÷p) − ln f̂| لأصنافه. E وسيط أخطاء العملاء،
 * E0 بلا معامل، Ecur بالمعامل الحالي. الترقية إن E ≤ 0.97 × (Ecur إن وُجد وإلا E0).
 */
export function gsigGate(pairs: CalPair[], minPeers: number, current: GsigParams | null): GsigGate {
  const vs = votes(pairs);
  if (!vs.length) return { ok: false, E0: 0, E: 0, Ecur: null, customers: 0 };
  const e: number[] = [], e0: number[] = [], ecur: number[] = [];
  for (const v of vs) {
    const lf = Math.log(factorOf(fitVotes(vs.filter(x => x.c !== v.c), minPeers).params, v.t));
    e.push(median(v.logs.map(l => Math.abs(l - lf))));
    e0.push(median(v.logs.map(l => Math.abs(l))));
    if (current) { const lc = Math.log(factorOf(current, v.t)); ecur.push(median(v.logs.map(l => Math.abs(l - lc)))); }
  }
  const E = median(e), E0 = median(e0), Ecur = current ? median(ecur) : null;
  const ref = Ecur ?? E0;
  return { ok: vs.length >= calNeeded(minPeers) && ref > 0 && E <= GATE_RATIO * ref, E0: r4(E0), E: r4(E), Ecur: Ecur == null ? null : r4(Ecur), customers: vs.length };
}
