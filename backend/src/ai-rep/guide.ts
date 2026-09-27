/**
 * المندوب الذكي — «التوجيه»: فحص كل المحلات المجاورة وإخراج خطة زيارة (بأي محل يبدأ، والترتيب، وماذا يعرض).
 *
 * طبقتان:
 *   1) **خطة حتمية دائماً** (rulePlan): الفرص الجديدة غير المرفوضة، مرتّبة بقيمتها المتوقّعة وثقتها مقسومةً على المسافة،
 *      ثم ترتيب مسار أقصر من موقع المندوب. تعمل ولو لم يُضبط النموذج اللغوي.
 *   2) **صياغة العقل** (إن كان مفعّلاً): النموذج يفحص القائمة بالأدوات ويكتب التوجيه بلغة المندوب، والأرقام محروسة.
 * النص يشير إلى المحلات بمراجع P1… والتطبيق يعرض أسماءها.
 */
import { haversineKm, EstimateResult } from './estimate';
import { orderStops } from './advisorTools';
import { normalizeDigits } from './advisor';
import { DEFAULT_POLICY, type ConfLevel, type PolicyParams } from './learn/types';

export interface PlanCandidate {
  ref: string;
  lat: number;
  lng: number;
  distanceM: number;
  relation: 'NEW' | 'CUSTOMER' | 'POSSIBLE_CUSTOMER';
  lastOutcome: string | null;
  closed?: boolean;
  estimate: EstimateResult;
  outletType: string;
}

const REJECTED = new Set(['NOT_INTERESTED', 'EXCLUSIVE_SUPPLIER', 'CLOSED', 'CONVERTED']);
export const PLAN_MAX_STOPS = 5;

/** قيمة الفرصة V: الوسيط الشهري المتوقّع إن ظهر المال، وإلا متوسط انتشار أعلى الأصناف (مقياس نسبي). */
export function candidateValue(c: Pick<PlanCandidate, 'estimate'>): number {
  const e = c.estimate;
  if (!e.ok) return 1;
  if (e.monthlyTotalValue) return 1 + e.monthlyTotalValue.median;
  const top = e.products.filter(p => (p.buyers ?? 0) > 0 && p.penetration != null).slice(0, 3);
  return 1 + (top.length ? (top.reduce((s, p) => s + (p.penetration ?? 0), 0) / top.length) * 100 : 0);
}

export function candidateConf(c: Pick<PlanCandidate, 'estimate'>): ConfLevel {
  return c.estimate.ok ? c.estimate.confidence : 'NONE';
}

/**
 * نقاط الفرصة بسياسة ترتيب (متعلَّمة أو افتراضية):
 *   V · confW[conf] · typeMult[type] · (1 − خطر الإغلاق في فترة اليوم) / (0.3 + km)^alpha
 * بالسياسة الافتراضية = معادلة ما قبل التعلّم حرفياً (اختبار انحدار يقفلها).
 */
export function scoreWith(c: Pick<PlanCandidate, 'estimate' | 'distanceM' | 'outletType'>, p: PolicyParams, hb: number): number {
  const conf = candidateConf(c);
  const w = p.confW[conf] ?? (conf === 'NONE' ? 0.4 : 0.5);
  const tm = p.typeMult[c.outletType] ?? 1;
  const risk = p.useClosed && p.closedRisk?.[c.outletType] ? 1 - (p.closedRisk[c.outletType][hb] ?? 0) : 1;
  const km = c.distanceM / 1000;
  const denom = p.alpha === 1 ? 0.3 + km : Math.pow(0.3 + km, p.alpha);
  return (candidateValue(c) * w * tm * risk) / denom;
}

/** النقاط بالسياسة الافتراضية (توافقاً مع ما قبل التعلّم). */
export function opportunityScore(c: PlanCandidate): number { return scoreWith(c, DEFAULT_POLICY, 0); }

const eligible = (c: Pick<PlanCandidate, 'relation' | 'lastOutcome'> & { closed?: boolean }) =>
  c.relation === 'NEW' && !c.closed && !(c.lastOutcome && REJECTED.has(c.lastOutcome));

/** المؤهّلون مرتّبين بالنقاط ثم الأقرب. */
export function rankCandidates<T extends PlanCandidate>(cands: T[], p: PolicyParams = DEFAULT_POLICY, hb = 0): T[] {
  return cands
    .filter(eligible)
    .map(c => ({ c, s: scoreWith(c, p, hb) }))
    .sort((a, b) => b.s - a.s || a.c.distanceM - b.c.distanceM)
    .map(x => x.c);
}

/** الخطة الحتمية: أفضل الفرص الجديدة (بسياسة الترتيب) ثم أقصر ترتيب من موقع المندوب. */
export function rulePlan(cands: PlanCandidate[], origin: { lat: number; lng: number } | null, maxStops = PLAN_MAX_STOPS, p: PolicyParams = DEFAULT_POLICY, hb = 0): string[] {
  const pool = rankCandidates(cands, p, hb).slice(0, maxStops);
  if (!origin) return pool.sort((a, b) => a.distanceM - b.distanceM).map(c => c.ref);
  return orderStops(origin, pool).map(c => c.ref);
}

/** نص التوجيه الحتمي (يُستعمل حين لا نموذج، أو إن تعثّر). */
export function ruleGuideText(plan: string[], byRef: Map<string, PlanCandidate & { typeLabel: string }>, origin: { lat: number; lng: number } | null, currency: string): string {
  if (!plan.length) return 'لا توجد فرص جديدة غير مزورة حولك الآن. جرّب نطاقاً أوسع أو نوع محل آخر.';
  const lines: string[] = ['خطة الزيارة المقترحة من بيانات شركتك:'];
  let prev = origin, km = 0;
  plan.forEach((ref, i) => {
    const c = byRef.get(ref);
    if (!c) return;
    if (prev) { km += haversineKm(prev.lat, prev.lng, c.lat, c.lng) * 1.3; }
    prev = c;
    const e = c.estimate;
    let line = `${i + 1}) ${ref} — ${c.typeLabel} على بعد ${c.distanceM} م`;
    if (e.ok) {
      if (e.monthlyTotalValue) line += `: متوقع ${e.monthlyTotalValue.low}–${e.monthlyTotalValue.high} ${currency} شهرياً قبل الضريبة`;
      const trial = e.products.filter(p => p.trialQty).slice(0, 2).map(p => `${p.name} ${p.trialQty} ${p.unit}`);
      const top = e.products.find(p => (p.buyers ?? 0) > 0);
      if (trial.length) line += `؛ اعرض طلباً تجريبياً: ${trial.join('، ')}`;
      else if (top) line += `؛ ابدأ بعرض ${top.name}`;
    } else {
      line += ' (لا تكفي بيانات شركتك لتوقّع رقم)';
    }
    lines.push(line + '.');
  });
  if (origin && km > 0) lines.push(`المسار كله نحو ${Math.round(km * 10) / 10} كم بهذا الترتيب.`);
  return lines.join('\n');
}

/** سؤال التوجيه للعقل. */
export const GUIDE_QUESTION =
  'افحص كل المحلات المجاورة (استدعِ list_opportunities)، ثم اختر أفضل الفرص الجديدة (حتى ٥) واستدعِ outlet_estimate لكل واحدة، ثم plan_route لترتيبها. ' +
  'أعطني توجيهاً عملياً مرقّماً: بأي محل أبدأ ولماذا، والترتيب، وماذا أعرض على كل محل وكم (الطلب التجريبي)، وجملة افتتاحية قصيرة للحديث مع صاحب المحل. ' +
  'اذكر كل محل بمرجعه (مثل P3).';

/** سؤال التوجيه في الذراع المتعلّمة (ترتيب موصى به من نتائج زيارات الشركة + الاعتراض الأرجح). */
export const GUIDE_QUESTION_LEARNED =
  'افحص كل المحلات المجاورة (استدعِ list_opportunities)، وابدأ من الترتيب الموصى به recommended_order المتعلَّم من نتائج زيارات شركتك، ثم استدعِ outlet_estimate لأفضل الفرص الجديدة (حتى ٥)، ثم plan_route لترتيبها. ' +
  'التزم بالترتيب الموصى به ما لم تذكر سبباً ظاهراً في نتائج الأدوات. أعطني توجيهاً عملياً مرقّماً: بأي محل أبدأ ولماذا، وماذا أعرض على كل محل وكم (الطلب التجريبي)، وجملة افتتاحية، والاعتراض الأرجح common_objection إن ظهر وكيف أردّ عليه من دليل البيع. ' +
  'اذكر كل محل بمرجعه (مثل P3).';

/**
 * أول مرجع في كل سطر مرقّم («1) P4 …») بترتيبه — محطّات الخطة كما كتبها العقل (قد تتكرّر أو تكون غير مؤهّلة).
 * أرقام هندية وترقيم مُبرَز (**1.** أو ### 2)) يُوحَّدان قبل المطابقة.
 */
export function numberedStepRefs(text: string): string[] {
  const out: string[] = [];
  for (const line of normalizeDigits(text).matchAll(/^\s*[*#>\s]*\d{1,2}\s*[).\-–:]\**\s*(.*)$/gm)) {
    const m = line[1].match(/\bP\d{1,3}\b/);
    if (m) out.push(m[0]);
  }
  return out;
}

/** مراجع الخطة من نص العقل: بترتيب أول ظهور، مقصورةً على الفرص الجديدة المعروفة. */
export function planFromText(text: string, allowed: Set<string>, max = PLAN_MAX_STOPS): string[] {
  const out: string[] = [];
  const take = (ref: string) => { if (allowed.has(ref) && !out.includes(ref) && out.length < max) out.push(ref); };
  // الخطوات المرقّمة أولاً: أول مرجع في كل سطر مرقّم هو محطّته — فالمذكور للتجنّب في آخر السطر لا يدخل
  const plain = normalizeDigits(text);
  for (const ref of numberedStepRefs(plain)) take(ref);
  if (out.length) return out;
  // بلا ترقيم: بترتيب أول ظهور
  for (const m of plain.matchAll(/\bP\d{1,3}\b/g)) take(m[0]);
  return out;
}

/** الفرص المسموح دخولها خطة العقل: جديدة، وغير مرفوضة، وغير مغلقة. */
export function planEligible(cands: Array<Pick<PlanCandidate, 'ref' | 'relation' | 'lastOutcome'> & { closed?: boolean }>): Set<string> {
  return new Set(cands.filter(eligible).map(c => c.ref));
}
