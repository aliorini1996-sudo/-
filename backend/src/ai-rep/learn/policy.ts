/**
 * حلقة التعلّم — «يتعلّم من خططه»: يقارن ترتيب الفرص الذي اقترحه بما حدث فعلاً عند الباب، ويعيد وزن معاملات الترتيب
 * (أُسّ المسافة، وأوزان الثقة، ومضاعف قبول نوع المحل، وخطر الإغلاق في فترة اليوم) داخل منطقة ثقة ضيّقة كل ليلة.
 *
 * - التسمية: زيارات **المندوب نفسه** لمرشّحي دورته خلال ٧٢ ساعة (لا زيارات غيره — مقاومةً للتسميم). المحطّة المخطّطة
 *   غير المزورة تُحسب تخطّياً (u=0 بوزن ½)، والمغلق وحده «رحلة ضائعة» تُستبعد من الأزواج.
 * - الهدف: التوافق الزوجي الموزون — هل رتّبت السياسة المحلَّ الذي تجاوب فوق الذي لم يتجاوب؟ بسقف ٣٥٪ لحصة أي مندوب.
 * - النقاط تُعاد من الميزات المخزّنة (AiTurn.candidates) بلا كيلومترات: km = منتصف شريحة المسافة.
 * - لا ترقية إلا على الدورات المحجوبة (أحدث ٣٠٪) بفرق ≥ ٠٫٠٢ ومئين إقلاع عاشر > ٠ وبلا زيادة في المحلات المغلقة،
 *   وتراجع تلقائي إن ساء الترتيب بعد الترقية أو خسرت الذراع المتعلّمة أمام الضابطة حيّاً.
 * كل ما هنا صرف عدا loadPlanEvents (استعلام واحد مقيّد بالشركة على طرفي الربط).
 */
import { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { PLAN_MAX_STOPS } from '../guide';
import { outletTypeLabel } from '../taxonomy';
import { BAND_MID_KM, hourBand } from './signals';
import { bootstrapQuantile, clamp, hashPct, pGreater } from './stats';
import { DEFAULT_POLICY, type Arm, type CandFeature, type ConfLevel, type FieldStats, type PolicyParams } from './types';

const TZ = 'Asia/Riyadh';
const LABEL_WINDOW_MS = 72 * 3600_000;
const CONVERT_WINDOW_MS = 30 * 86400_000;
/** وزن المحطّة المخطّطة غير المزورة — أوزان الزيارة ١ / ٠٫٧ / ٠٫٤ فلا التباس. */
const SKIP_W = 0.5;
const POS_U = 0.6;
const REP_CAP = 0.35;
const U_BY_KIND: Record<string, number> = { CONVERTED: 1, QUOTE: 0.7, INTERESTED: 0.6, CALL_BACK: 0.3, NOT_INTERESTED: 0, EXCLUSIVE_SUPPLIER: 0 };

export const ALPHA_GRID = [0.6, 0.8, 1, 1.2, 1.5];
export const CONF_GRID = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

// ───────────── الذراع ─────────────

/** ذراع المندوب في يومه: الإيقاف ⇒ الأساس، والمجموعة الضابطة صفر ⇒ المتعلَّمة، وإلا تجزئة حتمية (شركة|مندوب|يوم). */
export function assignArm(tid: string, repId: string, day: string, s: { learningMode: string; holdoutPct: number }): Arm {
  if (s.learningMode === 'OFF') return 'BASELINE';
  if (!(s.holdoutPct > 0)) return 'LEARNED';
  return hashPct(`${tid}|${repId}|${day}`) < s.holdoutPct ? 'BASELINE' : 'LEARNED';
}

// ───────────── البيانات والتسميات ─────────────

export interface PlanTurn { id: string; salesRepId: string; createdAt: Date; arm: string; policyVersion: number; candidates: CandFeature[] }
export interface PlanEvent { rep: string; placeId: string; kind: string; occurredAt: Date; atDoor: boolean | null; convertedAt: Date | null }
/** تسمية مرشّح: u قيمة النتيجة (٠…١)، w وزنها، wasted = وُجد مغلقاً فقط (خارج الأزواج). */
export interface Label { p: string; u: number; w: number; wasted: boolean }

/** نتائج الزيارات منذ `since` (بمعرّف المكان) — مقيّدة بالشركة على طرفي الربط. */
export async function loadPlanEvents(tid: string, since: Date): Promise<PlanEvent[]> {
  const rows = await prisma.$queryRaw<Array<{ rep: string; placeId: string; kind: string; occurredAt: Date; atDoor: boolean | null; convertedAt: Date | null }>>(Prisma.sql`
    SELECT e."salesRepId" AS rep, o."placeId" AS "placeId", e.kind AS kind, e."occurredAt" AS "occurredAt",
           e."atDoor" AS "atDoor", o."convertedAt" AS "convertedAt"
    FROM ai_outlet_events e JOIN ai_outlets o ON o.id = e."outletId" AND o."tenantId" = ${tid}
    WHERE e."tenantId" = ${tid} AND e."occurredAt" >= ${since} AND o."placeId" IS NOT NULL
    ORDER BY e."occurredAt" LIMIT 60000`);
  return rows.map(r => ({
    rep: r.rep, placeId: r.placeId, kind: r.kind, occurredAt: new Date(r.occurredAt),
    atDoor: r.atDoor ?? null, convertedAt: r.convertedAt ? new Date(r.convertedAt) : null,
  }));
}

/** زيارة فعلية (ولو وُجد مغلقاً)، لا محطّة مخطّطة تُخطّيت. */
const isVisit = (l: Label): boolean => l.wasted || l.w !== SKIP_W;

/**
 * تسميات كل دورة توجيه: لكل مرشّح، نتائج المندوب نفسه على المكان نفسه خلال [لحظة الدورة، +٧٢ ساعة].
 * u = أفضل نتيجة (تحويل ١، عرض سعر ٠٫٧، مهتم ٠٫٦، عُد لاحقاً ٠٫٣، رفض ٠) أو ١ إن تحوّل خلال ٣٠ يوماً،
 * و w = عند الباب ١ / غير معروف ٠٫٧ / بعيد ٠٫٤. مخطّط غير مزور: u=0 و w=½. غير ذلك لا تسمية.
 */
export function buildPlanLabels(turns: PlanTurn[], events: PlanEvent[]): Map<string, Label[]> {
  const byKey = new Map<string, PlanEvent[]>();
  for (const e of events) {
    const k = `${e.rep}\u0000${e.placeId}`;
    const arr = byKey.get(k);
    if (arr) arr.push(e); else byKey.set(k, [e]);
  }
  const out = new Map<string, Label[]>();
  for (const t of turns) {
    const t0 = t.createdAt.getTime();
    const labels: Label[] = [];
    for (const f of t.candidates ?? []) {
      const evs = (byKey.get(`${t.salesRepId}\u0000${f.p}`) ?? []).filter(e => {
        const x = e.occurredAt.getTime();
        return x >= t0 && x <= t0 + LABEL_WINDOW_MS;
      });
      if (!evs.length) {
        if (f.fr > 0) labels.push({ p: f.p, u: 0, w: SKIP_W, wasted: false });
        continue;
      }
      const w = evs.some(e => e.atDoor === true) ? 1 : evs.every(e => e.atDoor == null) ? 0.7 : 0.4;
      const real = evs.filter(e => e.kind !== 'CLOSED');
      if (!real.length) { labels.push({ p: f.p, u: 0, w, wasted: true }); continue; }
      let u = Math.max(...real.map(e => U_BY_KIND[e.kind] ?? 0));
      const conv = evs.find(e => e.convertedAt)?.convertedAt?.getTime();
      if (conv != null && conv >= t0 && conv <= t0 + CONVERT_WINDOW_MS) u = 1;
      labels.push({ p: f.p, u, w, wasted: false });
    }
    if (labels.length) out.set(t.id, labels);
  }
  return out;
}

// ───────────── النقاط والتوافق ─────────────

/** نقاط مرشّح من ميزاته المخزّنة — مطابقة لـguide.scoreWith (V=v، km=منتصف الشريحة، الثقة، النوع). */
export function scoreFeature(f: CandFeature, p: PolicyParams, hb: number): number {
  const w = p.confW[f.c] ?? (f.c === 'NONE' ? 0.4 : 0.5);
  const tm = p.typeMult[f.t] ?? 1;
  const risk = p.useClosed && p.closedRisk?.[f.t] ? 1 - (p.closedRisk[f.t][hb] ?? 0) : 1;
  const km = BAND_MID_KM[f.b] ?? BAND_MID_KM[BAND_MID_KM.length - 1];
  const denom = p.alpha === 1 ? 0.3 + km : Math.pow(0.3 + km, p.alpha);
  return (f.v * w * tm * risk) / denom;
}

const bandCache = new Map<number, number>();
/** فترة اليوم بتوقيت الرياض لدورة — مخزّنة لكل ساعة (إزاحة الرياض ساعات كاملة بلا توقيت صيفي، وبناء المنسّق مكلف). */
function turnBand(d: Date): number {
  const key = Math.floor(d.getTime() / 3600_000);
  let b = bandCache.get(key);
  if (b === undefined) {
    if (bandCache.size > 10_000) bandCache.clear();
    b = hourBand(d, TZ);
    bandCache.set(key, b);
  }
  return b;
}

interface Prepared { rep: string; hb: number; items: { f: CandFeature; u: number; w: number }[] }
interface TurnStat { rep: string; num: number; den: number; n: number }

function prepare(turns: PlanTurn[], labels: Map<string, Label[]>): Prepared[] {
  const out: Prepared[] = [];
  for (const t of turns) {
    const ls = labels.get(t.id);
    if (!ls?.length) continue;
    const byP = new Map((t.candidates ?? []).map(f => [f.p, f]));
    const items: Prepared['items'] = [];
    for (const l of ls) {
      if (l.wasted || !(l.w > 0)) continue;
      const f = byP.get(l.p);
      if (f) items.push({ f, u: l.u, w: l.w });
    }
    if (items.length >= 2) out.push({ rep: t.salesRepId, hb: turnBand(t.createdAt), items });
  }
  return out;
}

const sameScore = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));

function turnStat(pt: Prepared, p: PolicyParams): TurnStat {
  const s = pt.items.map(x => scoreFeature(x.f, p, pt.hb));
  let num = 0, den = 0, n = 0;
  for (let i = 0; i < pt.items.length; i++) {
    for (let j = i + 1; j < pt.items.length; j++) {
      const a = pt.items[i], b = pt.items[j];
      if (a.u === b.u) continue;
      const [hi, lo] = a.u > b.u ? [i, j] : [j, i];
      const pw = a.w * b.w;
      den += pw;
      n++;
      num += pw * (sameScore(s[hi], s[lo]) ? 0.5 : s[hi] > s[lo] ? 1 : 0);
    }
  }
  return { rep: pt.rep, num, den, n };
}

/** تجميع التوافق بسقف حصة المندوب (مرّة واحدة): مندوبٌ وزنُ أزواجه > ٣٥٪ يُقيَّس إلى ٠٫٣٥·W. */
function aggregate(stats: TurnStat[]): { c: number; pairs: number; turns: number; reps: number } {
  const byRep = new Map<string, { num: number; den: number }>();
  let W = 0, pairs = 0, turns = 0;
  for (const s of stats) {
    if (!s.n) continue;
    pairs += s.n;
    turns++;
    W += s.den;
    const r = byRep.get(s.rep) ?? { num: 0, den: 0 };
    r.num += s.num;
    r.den += s.den;
    byRep.set(s.rep, r);
  }
  if (!(W > 0)) return { c: 0.5, pairs, turns, reps: byRep.size };
  let num = 0, den = 0;
  for (const r of byRep.values()) {
    const k = r.den / W > REP_CAP ? (REP_CAP * W) / r.den : 1;
    num += k * r.num;
    den += k * r.den;
  }
  return { c: num / den, pairs, turns, reps: byRep.size };
}

/** التوافق الزوجي الموزون: Σ pw·([s_i>s_j] + ½[s_i=s_j]) / Σ pw على أزواج u_i > u_j، pw = w_i·w_j (٠٫٥ بلا أزواج). */
export function concordance(turns: PlanTurn[], labels: Map<string, Label[]>, p: PolicyParams): { c: number; pairs: number; turns: number; reps: number } {
  return aggregate(prepare(turns, labels).map(pt => turnStat(pt, p)));
}

// ───────────── الملاءمة ─────────────

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** قيم منطقة الثقة: قيمة البطل وأقرب نقطتي شبكة تحته وفوقه (خطوة واحدة). */
function trustOpts(grid: number[], champ: number): number[] {
  const lower = [...grid].reverse().find(g => g < champ - 1e-9);
  const upper = grid.find(g => g > champ + 1e-9);
  return [champ, ...(lower != null ? [lower] : []), ...(upper != null ? [upper] : [])];
}

const confOk = (w: Record<ConfLevel, number>): boolean =>
  w.HIGH === 1 && w.MEDIUM <= 1 + 1e-9 && w.MEDIUM >= w.LOW - 1e-9 && w.LOW >= w.NONE - 1e-9 && w.NONE > 0;

/** مضاعف النوع من إحصاء اليوم (الخلايا المكشوفة فقط)، محصوراً في ±٠٫٢ من البطل. */
function fieldTypeMult(champion: PolicyParams, field: FieldStats | null): Record<string, number> {
  if (!field) return { ...champion.typeMult };
  const out: Record<string, number> = {};
  for (const t of new Set([...Object.keys(champion.typeMult), ...Object.keys(field.byType)])) {
    const ch = champion.typeMult[t] ?? 1;
    const cell = field.byType[t];
    const target = cell?.exposed && Number.isFinite(cell.typeMult) ? cell.typeMult : ch;
    const v = round3(clamp(target, ch - 0.2, ch + 0.2));
    if (Math.abs(v - 1) > 1e-9) out[t] = v;
  }
  return out;
}

/** خطر الإغلاق لكل نوع × فترة من إحصاء الميدان — للأنواع التي رُصد لها ٣٠ نتيجة فأكثر فقط. */
function fieldClosedRisk(field: FieldStats): Record<string, number[]> | null {
  const out: Record<string, number[]> = {};
  for (const [t, s] of Object.entries(field.byType)) {
    const n = (s.closed?.nByBand ?? []).reduce((a, b) => a + (b || 0), 0);
    if (n >= 30 && s.closed.byBand?.length) out[t] = s.closed.byBand.map(x => round3(clamp(x || 0, 0, 0.9)));
  }
  return Object.keys(out).length ? out : null;
}

/**
 * ملاءمة سياسة متحدّية بنزول إحداثي (مرّتان) على [alpha، MEDIUM، LOW، NONE، useClosed]، كل معامل بقيمة البطل أو خطوة
 * شبكة واحدة عنها، مع 1 = HIGH ≥ MEDIUM ≥ LOW ≥ NONE. مضاعف النوع وخطر الإغلاق من إحصاء الميدان لا من الملاءمة.
 */
export function fitPolicy(train: PlanTurn[], labels: Map<string, Label[]>, champion: PolicyParams, field: FieldStats | null): PolicyParams {
  const closedRisk = field ? fieldClosedRisk(field) : champion.closedRisk;
  const closedOpts = field ? (closedRisk ? [false, true] : [false]) : [!!(champion.useClosed && champion.closedRisk)];
  let cur: PolicyParams = {
    v: 1, alpha: champion.alpha, confW: { ...champion.confW, HIGH: 1 },
    typeMult: fieldTypeMult(champion, field), closedRisk, useClosed: closedOpts.includes(champion.useClosed) ? champion.useClosed : closedOpts[0],
  };
  const prep = prepare(train, labels);
  if (!prep.length) return cur;
  const evalC = (p: PolicyParams) => aggregate(prep.map(pt => turnStat(pt, p))).c;

  const coords: Array<{ opts: (number | boolean)[]; set: (p: PolicyParams, v: number | boolean) => PolicyParams }> = [
    { opts: trustOpts(ALPHA_GRID, champion.alpha), set: (p, v) => ({ ...p, alpha: v as number }) },
    ...(['MEDIUM', 'LOW', 'NONE'] as const).map(k => ({
      opts: trustOpts(CONF_GRID, champion.confW[k]),
      set: (p: PolicyParams, v: number | boolean) => ({ ...p, confW: { ...p.confW, [k]: v as number } }),
    })),
    { opts: closedOpts, set: (p, v) => ({ ...p, useClosed: v as boolean }) },
  ];
  let curC = evalC(cur);
  for (let pass = 0; pass < 2; pass++) {
    for (const co of coords) {
      for (const v of co.opts) {
        const cand = co.set(cur, v);
        if (samePolicy(cand, cur) || !confOk(cand.confW)) continue;
        const c = evalC(cand);
        if (c > curC + 1e-12) { cur = cand; curC = c; }
      }
    }
  }
  return cur;
}

// ───────────── البوابة ─────────────

/** تقسيم زمني: أقدم ٧٠٪ للتدريب وأحدث ٣٠٪ محجوبة. */
export function splitTrainHeldOut(turns: PlanTurn[]): { train: PlanTurn[]; heldOut: PlanTurn[] } {
  const sorted = [...turns].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const cut = Math.floor(sorted.length * 0.7);
  return { train: sorted.slice(0, cut), heldOut: sorted.slice(cut) };
}

/** حصة «المغلق فقط» بين المزورين الواقعين في أعلى خمسة بترتيب السياسة. */
function closedShare(turns: PlanTurn[], labels: Map<string, Label[]>, p: PolicyParams): number {
  let visited = 0, closed = 0;
  for (const t of turns) {
    const ls = labels.get(t.id);
    if (!ls?.length) continue;
    const hb = turnBand(t.createdAt);
    const top = new Set((t.candidates ?? [])
      .map(f => ({ f, s: scoreFeature(f, p, hb) }))
      .sort((a, b) => b.s - a.s || a.f.rr - b.f.rr)
      .slice(0, PLAN_MAX_STOPS)
      .map(x => x.f.p));
    for (const l of ls) {
      if (!top.has(l.p) || !isVisit(l)) continue;
      visited++;
      if (l.wasted) closed++;
    }
  }
  return visited ? closed / visited : 0;
}

/** فرق التوافق (المتحدّي − البطل) على الدورات نفسها، وتوزيعه بإقلاع مقترن على مستوى الدورة. */
function pairedLift(turns: PlanTurn[], labels: Map<string, Label[]>, base: PolicyParams, next: PolicyParams) {
  const prep = prepare(turns, labels);
  const b = prep.map(pt => turnStat(pt, base)), n = prep.map(pt => turnStat(pt, next));
  const cb = aggregate(b), cn = aggregate(n);
  const idx = prep.map((_, i) => i).filter(i => b[i].n > 0);
  const stat = (s: number[]) => aggregate(s.map(i => n[i])).c - aggregate(s.map(i => b[i])).c;
  const q = (quant: number, seed: number) => (idx.length ? bootstrapQuantile(idx, stat, quant, 300, seed) : 0);
  return { cBase: cb.c, cNext: cn.c, dC: cn.c - cb.c, pairs: cn.pairs, turns: cn.turns, reps: cn.reps, q };
}

/**
 * بوابة الترقية على الدورات المحجوبة: أزواج ≥ ٤٠ (٨٠ لمندوب واحد)، دورات ≥ ١٥، مناديب ≥ min(3, النشطين)،
 * ΔC ≥ ٠٫٠٢، ومئين الإقلاع العاشر لـΔC > ٠، وحصة المغلق في أعلى الخمسة لا تزيد أكثر من ٠٫٠٢.
 */
export function shouldPromote(heldOut: PlanTurn[], labels: Map<string, Label[]>, champion: PolicyParams, challenger: PolicyParams, seed: number, activeReps: number):
  { ok: boolean; reason: string; dC: number; lo10: number; pairs: number; turns: number; reps: number } {
  const L = pairedLift(heldOut, labels, champion, challenger);
  const lo10 = L.q(0.1, seed);
  const res = (ok: boolean, reason: string) => ({ ok, reason, dC: L.dC, lo10, pairs: L.pairs, turns: L.turns, reps: L.reps });
  if (samePolicy(champion, challenger)) return res(false, 'SAME_PARAMS');
  if (L.pairs < (activeReps <= 1 ? 80 : 40)) return res(false, 'FEW_PAIRS');
  if (L.turns < 15) return res(false, 'FEW_TURNS');
  if (L.reps < Math.min(3, Math.max(1, activeReps))) return res(false, 'FEW_REPS');
  if (!(L.dC >= 0.02)) return res(false, 'SMALL_LIFT');
  if (!(lo10 > 0)) return res(false, 'UNCERTAIN_LIFT');
  if (closedShare(heldOut, labels, challenger) > closedShare(heldOut, labels, champion) + 0.02) return res(false, 'MORE_CLOSED');
  return res(true, 'PASS');
}

// ───────────── الأذرع الحيّة والتراجع ─────────────

export interface ArmStats { planned: number; visited: number; pos: number; conv30: number; closed: number }
export interface ArmAgg { LEARNED: ArmStats; BASELINE: ArmStats; pLearnedBetter: number; adherence: number; wastedRate: number }

/**
 * مؤشرات الذراعين على المحطّات المخطّطة (fr > 0): المزورة، والإيجابية بينها (مهتم فأعلى)، والمحوَّلة، والمغلقة.
 * الالتزام = المزورة / المخطّطة، والرحلات الضائعة = المغلقة / المزورة.
 */
export function armAggregates(turns: PlanTurn[], labels: Map<string, Label[]>): ArmAgg {
  const zero = (): ArmStats => ({ planned: 0, visited: 0, pos: 0, conv30: 0, closed: 0 });
  const agg = { LEARNED: zero(), BASELINE: zero() };
  for (const t of turns) {
    const a = t.arm === 'LEARNED' ? agg.LEARNED : t.arm === 'BASELINE' ? agg.BASELINE : null;
    if (!a) continue;
    const byP = new Map((labels.get(t.id) ?? []).map(l => [l.p, l]));
    for (const f of t.candidates ?? []) {
      if (!(f.fr > 0)) continue;
      a.planned++;
      const l = byP.get(f.p);
      if (!l || !isVisit(l)) continue;
      a.visited++;
      if (l.wasted) { a.closed++; continue; }
      if (l.u >= POS_U) a.pos++;
      if (l.u >= 1) a.conv30++;
    }
  }
  const { LEARNED: Lr, BASELINE: Bs } = agg;
  const planned = Lr.planned + Bs.planned, visited = Lr.visited + Bs.visited;
  return {
    ...agg,
    pLearnedBetter: pGreater(Lr.pos, Lr.visited, Bs.pos, Bs.visited),
    adherence: planned ? visited / planned : 0,
    wastedRate: visited ? (Lr.closed + Bs.closed) / visited : 0,
  };
}

/**
 * تراجع تلقائي بعد الترقية: (ب) الذراع الضابطة أفضل حيّاً (≥ ٦٠ محطّة مزورة لكل ذراع و P ≥ ٠٫٩) ⇒ AB_WORSE (الافتراضي)،
 * أو (أ) على دورات ما بعد الترقية بأزواج ≥ ٣٠: C_النشطة < C_السابقة − ٠٫٠٣ ⇒ AUTO_REGRESSION (تعود السابقة).
 * يُفحص (ب) أولاً لأنه دليل حيّ ونتيجته الأحوط (لا سياسة متعلَّمة).
 */
export function checkPolicyRollback(i: { sincePromotion: PlanTurn[]; labels: Map<string, Label[]>; active: PolicyParams; previous: PolicyParams; arms: ArmAgg }):
  { rollback: false } | { rollback: true; reason: 'AUTO_REGRESSION' | 'AB_WORSE' } {
  const { LEARNED: Lr, BASELINE: Bs } = i.arms;
  if (Lr.visited >= 60 && Bs.visited >= 60 && pGreater(Bs.pos, Bs.visited, Lr.pos, Lr.visited) >= 0.9) return { rollback: true, reason: 'AB_WORSE' };
  const prep = prepare(i.sincePromotion, i.labels);
  const ca = aggregate(prep.map(pt => turnStat(pt, i.active)));
  if (ca.pairs >= 30) {
    const cp = aggregate(prep.map(pt => turnStat(pt, i.previous)));
    if (ca.c < cp.c - 0.03) return { rollback: true, reason: 'AUTO_REGRESSION' };
  }
  return { rollback: false };
}

/** مقياس الأثر الأساسي للإدارة: توافق السياسة النشطة مقابل الافتراضية على الزيارات نفسها، بفاصل إقلاع ٩٠٪. */
export function counterfactualLift(turns: PlanTurn[], labels: Map<string, Label[]>, active: PolicyParams, seed: number):
  { cDefault: number; cActive: number; dC: number; lo90: number; hi90: number; pairs: number; turns: number } {
  const L = pairedLift(turns, labels, DEFAULT_POLICY, active);
  return { cDefault: L.cBase, cActive: L.cNext, dC: L.dC, lo90: L.q(0.05, seed), hi90: L.q(0.95, seed), pairs: L.pairs, turns: L.turns };
}

// ───────────── العرض والمقارنة ─────────────

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const arNum = (x: number): string => String(Math.round(x * 100) / 100).replace(/\d/g, d => AR_DIGITS[+d]).replace('.', '٫').replace('-', '−');
const onOff = (b: boolean): string => (b ? 'مفعّلة' : 'موقوفة');
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9;

const CONF_LABEL_AR: Record<ConfLevel, string> = {
  HIGH: 'وزن الفرص عالية الثقة', MEDIUM: 'وزن الفرص متوسطة الثقة', LOW: 'وزن الفرص منخفضة الثقة', NONE: 'وزن الفرص بلا توقّع كافٍ',
};

/** ملخّص عربي للإدارة بما تغيّر بين نسختين، مثل «وزن الفرص منخفضة الثقة ٠٫٥ ← ٠٫٤». */
export function describePolicy(prev: PolicyParams, next: PolicyParams): string {
  const parts: string[] = [];
  if (!near(prev.alpha, next.alpha)) parts.push(`أثر المسافة في الترتيب ${arNum(prev.alpha)} ← ${arNum(next.alpha)}`);
  for (const k of ['HIGH', 'MEDIUM', 'LOW', 'NONE'] as const) {
    if (!near(prev.confW[k], next.confW[k])) parts.push(`${CONF_LABEL_AR[k]} ${arNum(prev.confW[k])} ← ${arNum(next.confW[k])}`);
  }
  for (const t of [...new Set([...Object.keys(prev.typeMult), ...Object.keys(next.typeMult)])].sort()) {
    const a = prev.typeMult[t] ?? 1, b = next.typeMult[t] ?? 1;
    if (!near(a, b)) parts.push(`مضاعف قبول «${outletTypeLabel(t)}» ${arNum(a)} ← ${arNum(b)}`);
  }
  if (prev.useClosed !== next.useClosed) parts.push(`مراعاة أوقات إغلاق المحلات: ${onOff(prev.useClosed)} ← ${onOff(next.useClosed)}`);
  else if (next.useClosed && !sameClosed(prev.closedRisk, next.closedRisk)) parts.push('تحديث تقدير أوقات إغلاق المحلات');
  return parts.length ? parts.join('، ') : 'بلا تغيير في معاملات الترتيب';
}

function sameClosed(a: PolicyParams['closedRisk'], b: PolicyParams['closedRisk']): boolean {
  const A = a ?? {}, B = b ?? {};
  for (const t of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const x = A[t] ?? [], y = B[t] ?? [];
    if (x.length !== y.length || x.some((v, i) => !near(v, y[i]))) return false;
  }
  return true;
}

/** تطابق سياستين (فرق ≤ 1e-9؛ مضاعف النوع الغائب = ١). */
export function samePolicy(a: PolicyParams, b: PolicyParams): boolean {
  if (!near(a.alpha, b.alpha) || a.useClosed !== b.useClosed) return false;
  if ((['HIGH', 'MEDIUM', 'LOW', 'NONE'] as const).some(k => !near(a.confW[k], b.confW[k]))) return false;
  for (const t of new Set([...Object.keys(a.typeMult), ...Object.keys(b.typeMult)])) {
    if (!near(a.typeMult[t] ?? 1, b.typeMult[t] ?? 1)) return false;
  }
  return sameClosed(a.closedRisk, b.closedRisk);
}
