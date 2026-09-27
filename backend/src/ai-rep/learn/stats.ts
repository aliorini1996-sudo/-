/**
 * حلقة التعلّم — أدوات إحصائية صرفة (بلا قاعدة ولا شبكة): تجزئة حتمية، ومولّد عشوائي بذري، وتوزيع طبيعي وبيتا،
 * ووسيط موزون، وانكماش طبيعي–طبيعي، وإقلاع (bootstrap) بذري. كل عشوائية هنا بذرية ليُعاد إنتاج أي قرار ليلي.
 */
import { usageDay } from '../usage';

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** FNV-1a 32 بت — تجزئة حتمية سريعة (للذراع الضابطة وتقسيم الدروس). */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const hashPct = (s: string): number => fnv1a32(s) % 100;

/** مولّد mulberry32 بذري. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** دالة التوزيع الطبيعي المعياري (Abramowitz–Stegun 7.1.26 لـerf). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** متوسط وتباين لاحق بيتا(a0+x, b0+n−x). */
export function betaMeanVar(x: number, n: number, a0 = 1, b0 = 1): { mean: number; v: number } {
  const a = a0 + x, b = b0 + Math.max(0, n - x);
  const s = a + b;
  return { mean: a / s, v: (a * b) / (s * s * (s + 1)) };
}

/** P(p1 > p2) لنسبتين (تقريب طبيعي للاحقين بيتا(1,1)). */
export function pGreater(x1: number, n1: number, x2: number, n2: number): number {
  const a = betaMeanVar(x1, n1), b = betaMeanVar(x2, n2);
  const sd = Math.sqrt(a.v + b.v);
  if (!(sd > 0)) return a.mean > b.mean ? 1 : a.mean < b.mean ? 0 : 0.5;
  return normalCdf((a.mean - b.mean) / sd);
}

/** وسيط موزون (أول قيمة يبلغ عندها الوزن التراكمي النصف). */
export function weightedMedian(vals: number[], w: number[]): number {
  const idx = vals.map((_, i) => i).filter(i => Number.isFinite(vals[i]) && (w[i] ?? 0) > 0).sort((a, b) => vals[a] - vals[b]);
  if (!idx.length) return NaN;
  const total = idx.reduce((s, i) => s + w[i], 0);
  let acc = 0;
  for (const i of idx) {
    acc += w[i];
    if (acc >= total / 2) return vals[i];
  }
  return vals[idx[idx.length - 1]];
}

/** تباين موزون (حول المتوسط الموزون). */
export function weightedVar(vals: number[], w: number[]): number {
  let sw = 0, sx = 0;
  vals.forEach((v, i) => { const wi = w[i] ?? 0; sw += wi; sx += wi * v; });
  if (!(sw > 0)) return 0;
  const m = sx / sw;
  let ss = 0;
  vals.forEach((v, i) => { ss += (w[i] ?? 0) * (v - m) ** 2; });
  return ss / sw;
}

/** انكماش طبيعي–طبيعي: متوسط لاحق = (Σwr + μ0·σ²/τ²) / (Σw + σ²/τ²). */
export function shrinkNormal(sumWR: number, sumW: number, sigma2: number, tau2: number, priorMean: number): number {
  const k = sigma2 / tau2;
  return (sumWR + priorMean * k) / (sumW + k);
}

/** مئين إحصاءٍ ما عبر إعادة المعاينة بالإحلال على مستوى المجموعات (بذري). */
export function bootstrapQuantile<T>(groups: T[], stat: (g: T[]) => number, q: number, B = 300, seed = 1): number {
  if (!groups.length) return NaN;
  const rnd = mulberry32(seed);
  const vals: number[] = [];
  for (let b = 0; b < B; b++) {
    const sample: T[] = [];
    for (let i = 0; i < groups.length; i++) sample.push(groups[Math.floor(rnd() * groups.length)]);
    const v = stat(sample);
    if (Number.isFinite(v)) vals.push(v);
  }
  if (!vals.length) return NaN;
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.max(0, Math.floor(q * (vals.length - 1))))];
}

/** يوم الرياض YYYY-MM-DD. */
export function riyadhDay(now: Date = new Date()): string { return usageDay(now); }

/** تشابه ثلاثيات المحارف (Jaccard) — لإسقاط الدروس المكرّرة. */
export function trigramJaccard(a: string, b: string): number {
  const grams = (s: string) => {
    const t = ` ${s.replace(/\s+/g, ' ').trim()} `;
    const set = new Set<string>();
    for (let i = 0; i + 3 <= t.length; i++) set.add(t.slice(i, i + 3));
    return set;
  };
  const A = grams(a), B = grams(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}
