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

export interface PlanCandidate {
  ref: string;
  lat: number;
  lng: number;
  distanceM: number;
  relation: 'NEW' | 'CUSTOMER' | 'POSSIBLE_CUSTOMER';
  lastOutcome: string | null;
  closed?: boolean;
  estimate: EstimateResult;
}

const REJECTED = new Set(['NOT_INTERESTED', 'EXCLUSIVE_SUPPLIER', 'CLOSED', 'CONVERTED']);
const CONF_WEIGHT: Record<string, number> = { HIGH: 1, MEDIUM: 0.8, LOW: 0.5 };
export const PLAN_MAX_STOPS = 5;

/** قيمة الفرصة: الوسيط الشهري المتوقّع إن ظهر المال، وإلا متوسط انتشار أعلى الأصناف (مقياس نسبي). */
export function opportunityScore(c: PlanCandidate): number {
  const e = c.estimate;
  let value = 1;
  let w = 0.4;
  if (e.ok) {
    w = CONF_WEIGHT[e.confidence] ?? 0.5;
    if (e.monthlyTotalValue) value = 1 + e.monthlyTotalValue.median;
    else {
      const top = e.products.filter(p => (p.buyers ?? 0) > 0 && p.penetration != null).slice(0, 3);
      value = 1 + (top.length ? (top.reduce((s, p) => s + (p.penetration ?? 0), 0) / top.length) * 100 : 0);
    }
  }
  return (value * w) / (0.3 + c.distanceM / 1000);
}

/** الخطة الحتمية: أفضل الفرص الجديدة ثم أقصر ترتيب من موقع المندوب. */
export function rulePlan(cands: PlanCandidate[], origin: { lat: number; lng: number } | null, maxStops = PLAN_MAX_STOPS): string[] {
  const pool = cands
    .filter(c => c.relation === 'NEW' && !c.closed && !(c.lastOutcome && REJECTED.has(c.lastOutcome)))
    .map(c => ({ c, s: opportunityScore(c) }))
    .sort((a, b) => b.s - a.s || a.c.distanceM - b.c.distanceM)
    .slice(0, maxStops)
    .map(x => x.c);
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

/** مراجع الخطة من نص العقل: بترتيب أول ظهور، مقصورةً على الفرص الجديدة المعروفة. */
export function planFromText(text: string, allowed: Set<string>, max = PLAN_MAX_STOPS): string[] {
  const out: string[] = [];
  const take = (ref: string) => { if (allowed.has(ref) && !out.includes(ref) && out.length < max) out.push(ref); };
  // الخطوات المرقّمة أولاً («1) P4 …»): أول مرجع في كل سطر مرقّم هو محطّته — فالمذكور للتجنّب في آخر السطر لا يدخل
  // أرقام هندية وترقيم مُبرَز (**1.** أو ### 2)) يُوحَّدان قبل المطابقة
  const plain = normalizeDigits(text);
  const numbered = [...plain.matchAll(/^\s*[*#>\s]*\d{1,2}\s*[).\-–:]\**\s*(.*)$/gm)];
  for (const line of numbered) {
    const m = line[1].match(/\bP\d{1,3}\b/);
    if (m) take(m[0]);
  }
  if (out.length) return out;
  // بلا ترقيم: بترتيب أول ظهور
  for (const m of plain.matchAll(/\bP\d{1,3}\b/g)) take(m[0]);
  return out;
}

/** الفرص المسموح دخولها خطة العقل: جديدة، وغير مرفوضة، وغير مغلقة. */
export function planEligible(cands: Array<Pick<PlanCandidate, 'ref' | 'relation' | 'lastOutcome'> & { closed?: boolean }>): Set<string> {
  return new Set(cands.filter(c => c.relation === 'NEW' && !c.closed && !(c.lastOutcome && REJECTED.has(c.lastOutcome))).map(c => c.ref));
}
