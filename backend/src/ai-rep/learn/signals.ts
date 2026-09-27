/**
 * حلقة التعلّم — الإشارات (صرفة): نيّة سؤال المندوب، وسبب الاعتراض من زرّه أو من كلمات ملاحظته، وفترات اليوم وشرائح
 * المسافة، و«هل كان عند الباب»، وميزات مرشّحي التوجيه، والفحص الذاتي لكل رد.
 *
 * مبدأ: **لا نص حرّ من المندوب يصل للعقل أو للدروس** — الملاحظة تُختزل إلى رمز اعتراض، والسؤال إلى رمز نيّة.
 * المطابقة على نصٍّ موحَّد (بلا تشكيل، والهمزات ألفاً، والتاء المربوطة هاءً) وبحدّ كلمة عربي يدوي
 * (\b في JavaScript لاتيني فقط).
 */
import { normalizeDigits } from '../advisor';
import { haversineKm } from '../estimate';
import { candidateConf, candidateValue, numberedStepRefs, planFromText, type PlanCandidate } from '../guide';
import type { CandFeature, Intent, ObjectionCode } from './types';

// ───────────── التوحيد ─────────────

export function normalizeAr(s: string): string {
  return normalizeDigits(s || '')
    .replace(/[ً-ْٰ]/g, '')
    .replace(/ـ/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

/** كلمات تبدأ بعد حدّ (بداية، أو محرف غير عربي) مع سابقة اختيارية (و، ف، ب، ل، ال، بال، وال، لل) — بلا حدّ نهاية (تُقبل اللواحق). */
function words(list: string[]): RegExp {
  const alts = list.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?:^|[^\\u0621-\\u064A])(?:وال|بال|فال|لل|ال|و|ف|ب|ل)?(?:${alts})`);
}

// ───────────── النيّة ─────────────

export const INTENTS: readonly Intent[] = ['GUIDE', 'WHERE_START', 'ROUTE', 'WHAT_OFFER', 'HOW_MUCH', 'OBJ_PRICE', 'OBJ_SUPPLIER', 'OBJ_SHELF',
  'OBJ_CREDIT', 'OPENING', 'PRODUCT', 'TEAM_EXPERIENCE', 'OTHER'];

const INTENT_RULES: [Exclude<Intent, 'GUIDE' | 'OTHER'>, RegExp][] = [
  ['TEAM_EXPERIENCE', /تعلمت|وش تعلم|زيارات فريق|تجارب الفريق|وش لاحظت/],
  ['OBJ_SUPPLIER', /مورد|عنده شركه|متعامل مع/],
  ['OBJ_PRICE', /غالي|السعر|اسعار|ارخص/],
  ['OBJ_SHELF', /الرف|رفوف|مساحه/],
  ['OBJ_CREDIT', words(['اجل', 'بالدين', 'تقسيط'])],
  ['ROUTE', /مسار|رتب|ترتيب|الطريق/],
  ['WHERE_START', /ابدا|من وين|من اين|اي محل|اول محل/],
  ['HOW_MUCH', /(^| )كم( |$|[؟?])|كميه|كم كرتون/],
  ['WHAT_OFFER', /وش اعرض|ماذا اعرض|ايش اعرض|اعرض عليه|وش ابيع/],
  ['OPENING', /افتح الحديث|اول كلام|كيف اكلم|اسلوب/],
  ['PRODUCT', /منتج|صنف|اصناف/],
];

/** نيّة سؤال المندوب (بعد حجب البيانات الشخصية) — أول قاعدة تطابق. */
export function classifyIntent(scrubbed: string): Intent {
  const t = normalizeAr(scrubbed);
  for (const [intent, re] of INTENT_RULES) if (re.test(t)) return intent;
  return 'OTHER';
}

// ───────────── الاعتراضات ─────────────

export const OBJECTION_CODES: readonly ObjectionCode[] = ['PRICE', 'HAS_SUPPLIER', 'NO_SHELF_SPACE', 'NEEDS_CREDIT', 'SLOW_MOVING',
  'DECISION_MAKER_ABSENT', 'WANTS_SAMPLE', 'UNKNOWN_BRAND', 'TIMING', 'OTHER'];

export { OBJECTION_LABEL_AR, HOUR_BAND_LABEL_AR } from './labels';

/** النتائج التي يُسأل فيها عن سبب التردّد (المغلق والتحويل لا). */
export const OBJECTION_KINDS = new Set(['INTERESTED', 'CALL_BACK', 'QUOTE', 'NOT_INTERESTED', 'EXCLUSIVE_SUPPLIER']);

const OBJECTION_RULES: [ObjectionCode, (t: string) => boolean][] = [
  ['NEEDS_CREDIT', t => words(['اجل', 'بالدين', 'تقسيط', 'يدفع بعدين']).test(t)],
  ['HAS_SUPPLIER', t => /مورد|يوردون|عنده شركه|مندوب ثاني|متعامل مع/.test(t)],
  ['PRICE', t => /غالي|السعر|اسعار|ارخص|مرتفع/.test(t)],
  ['NO_SHELF_SPACE', t => /الرف|رفوف|مساحه|ما فيه مكان|ما عنده مكان/.test(t)],
  ['SLOW_MOVING', t => /ما يمشي|ما ينباع|راكد|ما عليه طلب/.test(t)],
  ['DECISION_MAKER_ABSENT', t => /صاحب المحل|المالك|الكفيل|المسؤول/.test(t) && /مو موجود|غير موجود|ما هو موجود|مسافر|غايب/.test(t)],
  ['WANTS_SAMPLE', t => /عينه|عينات|يجرب|تجربه|كميه قليله/.test(t)],
  ['UNKNOWN_BRAND', t => /ما يعرف|ما سمع|الماركه|العلامه/.test(t)],
  ['TIMING', t => /مشغول|وقت ثاني|بعدين|زحمه|تعال بكره/.test(t)],
];

/** سبب الاعتراض من ملاحظة المندوب بكلمات مفتاحية (النص لا يُخزَّن خارج القاعدة ولا يصل للعقل). */
export function classifyObjectionNote(note: string | null | undefined): ObjectionCode | null {
  const t = normalizeAr(note || '');
  if (!t) return null;
  for (const [code, test] of OBJECTION_RULES) if (test(t)) return code;
  return null;
}

/** الأولوية: زرّ المندوب ← المورّد الحصري ضمناً ← كلمات الملاحظة. */
export function outcomeObjection(kind: string, chip: ObjectionCode | null | undefined, note: string | null | undefined):
  { objection: ObjectionCode | null; source: 'REP' | 'KW' | 'IMPLIED' | null } {
  if (!OBJECTION_KINDS.has(kind)) return { objection: null, source: null };
  if (chip) return { objection: chip, source: 'REP' };
  if (kind === 'EXCLUSIVE_SUPPLIER') return { objection: 'HAS_SUPPLIER', source: 'IMPLIED' };
  const kw = classifyObjectionNote(note);
  return kw ? { objection: kw, source: 'KW' } : { objection: null, source: null };
}

// ───────────── الزمن والمسافة ─────────────

/** فترة اليوم بالساعة المحلية: [6,11)→0 [11,14)→1 [14,17)→2 [17,21)→3 وإلا 4. */
export function hourBand(d: Date, tz: string): 0 | 1 | 2 | 3 | 4 {
  let h: number;
  try {
    h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(d));
  } catch {
    h = (d.getUTCHours() + 3) % 24; // الرياض احتياطاً
  }
  if (!Number.isFinite(h)) h = (d.getUTCHours() + 3) % 24;
  return hourOfDayBand(h);
}

export function hourOfDayBand(h: number): 0 | 1 | 2 | 3 | 4 {
  if (h >= 6 && h < 11) return 0;
  if (h >= 11 && h < 14) return 1;
  if (h >= 14 && h < 17) return 2;
  if (h >= 17 && h < 21) return 3;
  return 4;
}

/** شريحة المسافة: <300، <600، <1000، <2000، <4000، ≥4000 م. */
export function distanceBand(m: number): 0 | 1 | 2 | 3 | 4 | 5 {
  if (m < 300) return 0;
  if (m < 600) return 1;
  if (m < 1000) return 2;
  if (m < 2000) return 3;
  if (m < 4000) return 4;
  return 5;
}
export const BAND_MID_KM = [0.2, 0.45, 0.8, 1.5, 3, 5];

/** إحداثيات محلٍّ أُضيف يدوياً من معرّفه «man:lat,lng». */
export function parseManPlace(placeId: string | null | undefined): { lat: number; lng: number } | null {
  const m = /^man:(-?\d+\.\d+),(-?\d+\.\d+)$/.exec(placeId || '');
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/**
 * هل سجّل المندوب النتيجة وهو عند المحل؟ ≤١٥٠ م نعم، >٤٠٠ م لا، وبينهما أو بدقّة >١٠٠ م أو بلا بيانات: غير معروف.
 * موقع المحل من جلسة البحث في الذاكرة أو من معرّف man: — **لا** من AiOutlet.lat/lng (يُكتب فوقه موقع المندوب).
 */
export function atDoor(gps: { lat: number; lng: number; accuracyM?: number | null } | null | undefined, outlet: { lat: number; lng: number } | null | undefined): boolean | null {
  if (!gps || !outlet) return null;
  if (gps.accuracyM != null && gps.accuracyM > 100) return null;
  const m = haversineKm(gps.lat, gps.lng, outlet.lat, outlet.lng) * 1000;
  if (m <= 150) return true;
  if (m > 400) return false;
  return null;
}

// ───────────── ميزات مرشّحي التوجيه ─────────────

export type RankedCand = PlanCandidate & { placeId: string };

const sig3 = (x: number): number => (x === 0 || !Number.isFinite(x) ? 0 : Number(x.toPrecision(3)));

/** المرشّحون المؤهّلون بترتيب الذراع (≤٢٠) — بلا كيلومترات ولا إحداثيات ولا أسماء ولا عناوين. */
export function candidateFeatures(ranked: RankedCand[], finalPlanRefs: string[]): CandFeature[] {
  return ranked.slice(0, 20).map((c, i) => ({
    p: c.placeId,
    t: c.outletType,
    b: distanceBand(c.distanceM),
    c: candidateConf(c),
    v: sig3(candidateValue(c)),
    lo: c.lastOutcome && ['CALL_BACK', 'QUOTE', 'INTERESTED'].includes(c.lastOutcome) ? 'S' : 'N',
    rr: i + 1,
    fr: finalPlanRefs.indexOf(c.ref) + 1,
  }));
}

// ───────────── الفحص الذاتي لكل رد ─────────────

export const FEEDBACK_REASONS = ['WRONG_OUTLET', 'WRONG_QTY', 'NOT_PRACTICAL', 'WRONG_INFO', 'TOO_LONG'] as const;
export type FeedbackReason = typeof FEEDBACK_REASONS[number];

const DATA_INTENTS = new Set<Intent>(['WHERE_START', 'ROUTE', 'WHAT_OFFER', 'HOW_MUCH']);

export function selfCheckFlags(i: {
  kind: 'GUIDE' | 'CHAT'; source: 'AI' | 'RULES' | 'ERROR'; intent: Intent; text: string;
  toolNames: string[]; toolErrors: number; eligibleRefs?: Set<string>;
}): string[] {
  const flags: string[] = [];
  if (i.source === 'ERROR') return ['LLM_ERROR'];
  if (i.source === 'AI') {
    if (i.kind === 'GUIDE' && i.eligibleRefs) {
      if (numberedStepRefs(i.text).some(r => !i.eligibleRefs!.has(r))) flags.push('INELIGIBLE_REF');
      if (!planFromText(i.text, i.eligibleRefs).length) flags.push('EMPTY_PLAN');
    }
    if (i.kind === 'CHAT' && DATA_INTENTS.has(i.intent) && i.toolNames.length === 0) flags.push('NO_TOOL');
    if (i.text.split('\n').filter(l => l.trim()).length > 10) flags.push('OVER_LENGTH');
    if (i.toolErrors > 0) flags.push('TOOL_ERRORS');
  }
  return flags;
}
