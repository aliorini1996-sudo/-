/**
 * سجلّ تحويلات وحدة أساس الصنف (ProductBaseConversion) كما تقرؤه إعادة الرفع دون اتصال (D16 في مواصفة «الوحدة الرئيسية» §2.14).
 * نقيّ تماماً: لا قاعدة ولا Prisma — المسار يقرأ الصفوف (لصنفٍ baseConvertedAt ≠ null وفي إعادة الرفع وحدها، I8) ويمرّرها.
 *
 * صفٌّ بمعامل F > 1 تحويلٌ (كرتون ⇒ قارورة: كرتون = F قارورة)، وبمعامل ١ إعادة تسمية للأساس تُبقي السلسلة متّصلة.
 * «السلسلة المتّصلة» = آخر الصفوف بترتيب convertedAt، كلٌّ fromUnit فيه = toUnit سابقه، وآخرها toUnit = الأساس الحالي.
 * كل مقارنة أسماء بـbaseNameKey على الطرفين (D20-أ)، وD20-ب يضمن أن اسماً تقاعد لا يعود أساساً.
 */
import { baseNameKey } from './units';

export interface BaseConversionRow { fromUnit: string; toUnit: string; factor: number; fromUnitId: string | null; convertedAt: Date }

/** انحراف ساعة الجهاز المقبول حول لحظة التحويل — داخله تُفسَّر الكمية ويُبلَّغ المدير */
export const REPLAY_CLOCK_MARGIN_MS = 10 * 60_000;

/** نافذة إشارة السعر (±٢٥٪): كل معامل تحويل ≥ ٢ فلا تتداخل نافذتا مرشّحين */
export const PRICE_MATCH_TOL = 0.25;

/** D18/D9: مفاتيح العرض التي لا تخرج في حمولة ERP — يستوردها erpPayload.ts فلا يظهر الاسم نصاً فيه (I2) */
export const PRODUCT_DISPLAY_ONLY_KEYS = ['primaryUnitId', 'baseConvertedAt'] as const;

const factorOfRow = (r: BaseConversionRow): number => {
  const f = Number(r.factor);
  return Number.isFinite(f) && f >= 1 ? Math.round(f) : 1;
};
const timeOf = (d: unknown): number => {
  const t = d instanceof Date ? d.getTime() : new Date(d as string).getTime();
  return Number.isFinite(t) ? t : NaN;
};

/** السلسلة المتّصلة حتى الأساس الحالي، بترتيبها الزمني — [] حين لا يصل آخر صفٍّ إلى الأساس الحالي */
function connectedChain(rows: readonly BaseConversionRow[], currentBase: string): BaseConversionRow[] {
  const sorted = rows
    .map((r, i) => ({ r, i, t: timeOf(r.convertedAt) }))
    .sort((a, b) => ((a.t || 0) - (b.t || 0)) || (a.i - b.i))
    .map((x) => x.r);
  const out: BaseConversionRow[] = [];
  let want = baseNameKey(currentBase);
  for (let k = sorted.length - 1; k >= 0; k--) {
    const r = sorted[k];
    if (baseNameKey(r.toUnit) !== want) break;
    out.unshift(r);
    want = baseNameKey(r.fromUnit);
  }
  return out;
}

/**
 * السلسلة من أساس الجهاز إلى الأساس الحالي: يُبدأ من **آخر** صفٍّ fromUnit = devBase تصل سلسلته، ثم كل صفٍّ تالٍ fromUnit = toUnit
 * السابق (ومنه صفوف إعادة التسمية بمعامل ١)، حتى toUnit = currentBase. factor = ΠF. وإلا null.
 */
export function chainFrom(rows: readonly BaseConversionRow[], devBase: string, currentBase: string): { factor: number; first: BaseConversionRow } | null {
  const chain = connectedChain(rows, currentBase);
  const want = baseNameKey(devBase);
  if (!want) return null;
  for (let k = chain.length - 1; k >= 0; k--) {
    if (baseNameKey(chain[k].fromUnit) !== want) continue;
    let factor = 1;
    for (let i = k; i < chain.length; i++) factor *= factorOfRow(chain[i]);
    return { factor, first: chain[k] };
  }
  return null;
}

/**
 * التحويلات التي وقعت بعد لحظة المستند (convertedAt > docAt) ومتّصلة حتى الأساس الحالي: rebase بـΠF وأوّلها؛ لا شيء ⇒ none.
 * nearConversion = |convertedAt − docAt| ≤ الهامش لأيّ صفّ بمعامل > ١. docAt null ⇒ none + nearConversion: true.
 */
export function conversionsSince(rows: readonly BaseConversionRow[], docAt: Date | null, currentBase: string, marginMs = REPLAY_CLOCK_MARGIN_MS):
  { kind: 'none'; nearConversion: boolean } | { kind: 'rebase'; factor: number; first: BaseConversionRow; nearConversion: boolean } {
  const at = docAt == null ? NaN : timeOf(docAt);
  if (!Number.isFinite(at)) return { kind: 'none', nearConversion: true };
  const chain = connectedChain(rows, currentBase);
  const nearConversion = chain.some((r) => factorOfRow(r) > 1 && Math.abs(timeOf(r.convertedAt) - at) <= marginMs);
  const k = chain.findIndex((r) => timeOf(r.convertedAt) > at);
  if (k < 0) return { kind: 'none', nearConversion };
  let factor = 1;
  for (let i = k; i < chain.length; i++) factor *= factorOfRow(chain[i]);
  // ما بعد المستند إعادات تسمية وحدها: الكمية بالأساس نفسه (اسمه تغيّر)
  if (factor === 1) return { kind: 'none', nearConversion };
  return { kind: 'rebase', factor, first: chain[k], nearConversion };
}

/** مرشّحات إعادة الأساس للسلسلة المتّصلة حتى الأساس الحالي: [{factor: 1}، ثم لكل صفّ k بمعامل > ١: {factor: Π_{i≥k} F_i, first: صفّ k}] */
export function rebaseCandidates(rows: readonly BaseConversionRow[], currentBase: string): Array<{ factor: number; first: BaseConversionRow | null }> {
  const chain = connectedChain(rows, currentBase);
  const out: Array<{ factor: number; first: BaseConversionRow | null }> = [{ factor: 1, first: null }];
  for (let k = chain.length - 1; k >= 0; k--) {
    if (factorOfRow(chain[k]) <= 1) continue;
    let factor = 1;
    for (let i = k; i < chain.length; i++) factor *= factorOfRow(chain[i]);
    out.push({ factor, first: chain[k] });
  }
  return out;
}

/** المرشّح الوحيد الذي يقع سعر البند ضمن ±TOL من مرجعه، أو null (لا شيء، أو أكثر من واحد، أو سعر ≤ ٠، أو مرجع ≤ ٠) */
export function pickByPrice<C>(netUnitPrice: number, candidates: readonly C[], refOf: (c: C) => number | null): C | null {
  const p = Number(netUnitPrice);
  if (!Number.isFinite(p) || p <= 0) return null;
  const hits = candidates.filter((c) => {
    const ref = Number(refOf(c));
    return Number.isFinite(ref) && ref > 0 && Math.abs(p - ref) <= PRICE_MATCH_TOL * ref;
  });
  return hits.length === 1 ? hits[0] : null;
}

/** المرشّح الوحيد الذي يساوي فيه devFactor × c.factor المعامل الحالي للوحدة بالاسم، أو null */
export function pickByFactor<C extends { factor: number }>(devFactor: number, currentFactor: number | null | undefined, candidates: readonly C[]): C | null {
  const cur = Number(currentFactor);
  const dev = Number(devFactor);
  if (currentFactor == null || !Number.isFinite(cur) || !Number.isFinite(dev) || dev <= 0) return null;
  const hits = candidates.filter((c) => Math.abs(dev * Number(c.factor) - cur) < 1e-9);
  return hits.length === 1 ? hits[0] : null;
}
