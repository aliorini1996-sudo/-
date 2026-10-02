/**
 * المندوب الذكي — «الطلب المتوقع من ملف المحل في Google» (دالة صرفة، بلا قاعدة ولا نموذج لغوي).
 *
 * لكل محلٍّ حول المندوب ولكل صنفٍ في سيارته: كم يُتوقَّع أن يطلب منه — من إشارات ملفه في خرائط Google وحدها (عدد
 * المقيّمين مقارنةً بمحلات نوعه في المسح نفسه، وتقييمه، وما تقوله مراجعاته عن المحل وعن الصنف). فواتير الشركة تدخل
 * **وحدةَ قياسٍ فقط** (حجم الطلب المعتاد للصنف) — لا من «عملاء مشابهين» (المالك رفض ذلك الأساس لهذا الرقم).
 *
 *   الكمية = المرساة × T × Q × R × M × C
 *   - المرساة: وسيط كمية الصنف في بند فاتورة بيع (٦ أشهر). بلا مرساة (لم يُبع أو بيع قليلاً) ⇒ لا رقم، بسببه.
 *   - T الحركة: √((n+5)/(m+5)) محصوراً في [0.5، 2] — n مقيّمو المحل، m وسيط مقيّمي نوعه في المسح (أو 40 حين عُرف أقل
 *     من ٣). عدد مجهول ⇒ 1 (والثقة أدنى).
 *   - Q الجودة: التقييم مشدوداً بعدد مقيّميه (shrunkRating) ≥4.5 ⇒ 1.15، ≥4 ⇒ 1.05، ≥3.5 ⇒ 1، ≥3 ⇒ 0.9، وإلا 0.8.
 *   - R حديث المراجعات عن المحل (حين تُقرأ نصوصها): زحمة أو تنوّع ⇒ حتى 1.1، شكوى نقص أصناف ⇒ 1.1 وفرصة،
 *     سلبية غالبة أو حديث عن إغلاقه ⇒ 0.8.
 *   - M ذكر الصنف في المراجعات (بكلماته المميِّزة بعد تطبيع العربية): مذكور ⇒ 1.3، مذكورٌ بشكوى وحدها ⇒ 1.2 وتلميح.
 *   - C معامل متعلَّم لنوع المحل من مقارنة المعروض بأول طلب حقيقي (حلقة التعلّم، gsig-1) — 1 افتراضاً.
 *   المدى ×0.7–×1.3. الثقة: عالية بـ١٠٠ مقيّم فأكثر ومراجعات مقروءة، متوسطة بـ٢٠ فأكثر، وإلا منخفضة.
 * العرض: المذكور في المراجعات أولاً، ثم بالقيمة المتوقعة (الكمية × السعر المعتاد حين تُعرض المبالغ، وإلا الكمية)، حتى ٦.
 * الاقتباس من المراجعة قصيرٌ بلا هواتف ولا روابط ولا أسماء مراجعين (النص وحده يُقرأ). لا يُخزَّن شيء من ملف المحل.
 */
import { normalizeDigits, scrubPii } from './advisor';
import { cleanName } from './learn/lessons';
import { normalizeAr as normalizeBase } from './learn/signals';
import { GSIG_ENGINE, GSIG_F_MAX, GSIG_F_MIN } from './learn/types';
import type { ShownExpected } from './learn/gsig';
import { reviewPolarity, reviewThemeCodes } from './profileStudy';
import { countAr, RATER_AR, shrunkRating, type ArNoun } from './scanGuide';

export { GSIG_ENGINE };
/** وسيط مقيّمي النوع المسبق حين عُرف أقل من ٣ محلات منه في المسح. */
export const TYPE_PRIOR_COUNT = 40;
export const MIN_TYPE_KNOWN = 3;
export const MAX_EXPECTED_PRODUCTS = 6;

export type ExpConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type ProductsSource = 'VAN' | 'PRIORITY' | 'CATALOG';
/** حديث المراجعات عن المحل: زحمة، تنوّع، نقص أصناف، سلبية غالبة، إغلاق. */
export type TalkCode = 'BUSY' | 'VARIETY' | 'SHORTAGE' | 'NEGATIVE' | 'CLOSING';
export type ComplaintKind = 'QUALITY' | 'SHORTAGE';

export interface DemandProduct { productId: string; name: string; unit: string }
/** حجم الطلب المعتاد للصنف: وسيط كميته في بند فاتورة، وسعر الوحدة المعتاد (بلا ضريبة)، وعدد الفواتير. */
export interface Anchor { qty: number; price: number | null; invoices: number }
export interface DemandReview { rating: number | null; text: string }
/** وسيط مقيّمي نوعٍ في المسح وما عُرف منه (counts مرتّبة). */
export interface TypeBaseline { median: number; known: number; counts: number[] }

export interface ExpectedProduct {
  productId: string;
  name: string;
  unit: string;
  /** null = لا رقم (reason) */
  qty: number | null;
  low: number | null;
  high: number | null;
  mentioned: boolean;
  /** عدد المراجعات التي ذكرته */
  mentions?: number;
  /** ذُكر بشكوى وحدها: جودته أو نقصه — تلميحٌ للمندوب */
  complaint?: ComplaintKind;
  /** جملة قصيرة من مراجعة تذكره (بلا هواتف ولا روابط) */
  quote?: string;
  reason?: 'NO_ANCHOR';
  /** الرقم قبل المعامل المتعلَّم وقبل التقريب — للّقطة وحدها (لا يُرسل للجهاز) */
  raw?: number;
}

export interface ExpectedBasis {
  rating: number | null;
  /** null = غير معروف */
  ratingCount: number | null;
  /** حصة محلات نوعه في المسح بمقيّمين أقل (لأسفل لأقرب ١٠) — null حين عُرف أقل من ٣ أو عدده مجهول */
  trafficPct: number | null;
  typeMedianCount: number;
  /** الوسيط من المسح (لا المسبق) */
  typeMedianKnown: boolean;
  T: number; Q: number; R: number; cal: number;
  /** قُرئت المراجعات النصية (المفتاح الرسمي) — ولو لم يكن فيها نص */
  reviewsRead: boolean;
  reviews: number;
  /** أبرز صنفين مذكورين في المراجعات وعدد مراجعاتهما */
  mentions: { name: string; reviews: number }[];
  talk: TalkCode[];
  source: ProductsSource;
  /** السطر بالعربية (الواجهة تركّب غيرها من الوقائع أعلاه) */
  text: string;
}

export interface ExpectedShop {
  v: 1;
  confidence: ExpConfidence;
  basis: ExpectedBasis;
  products: ExpectedProduct[];
  /** نسخة المعامل المتعلَّم المطبّقة (null = بلا) — للّقطة وحدها */
  calVersion?: number | null;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

// ───────────── تطبيع العربية ومطابقة الأصناف ─────────────

/** علامات قرآنية وما بقي من التشكيل خارج توحيد التعلّم. */
const MARKS = /[ؐ-ؚٓ-ٟۖ-ۭ]/g;

/**
 * تطبيع للمطابقة: توحيد التعلّم (الأرقام، التشكيل والتطويل، أإآ←ا، ة←ه، ى←ي) ومعه ٱ←ا وؤ←و وئ←ي (عصائر ← عصاير)،
 * واللاتينية صغيرة، وعلامات الترقيم مسافات.
 */
export function normalizeAr(s: string): string {
  return normalizeBase(s ?? '').toLowerCase()
    .replace(MARKS, '')
    .replace(/ٱ/g, 'ا').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const PREFIXES = ['وال', 'بال', 'فال', 'كال', 'لل', 'ال'];
const stem = (t: string): string => {
  for (const p of PREFIXES) if (t.startsWith(p) && t.length - p.length >= 2) return t.slice(p.length);
  return t;
};

/** كلمات النص مطبَّعةً بلا «ال» وأخواتها. */
export const tokensAr = (s: string): string[] => normalizeAr(s).split(' ').filter(Boolean).map(stem);

/** لواحق تُقبل بعد الكلمة (بيضه، بيضات، حليبها) — لا «ون/ين/ي» (زيت ⇏ زيتون، تمر ⇏ تمرين). */
const SUFFIXES = ['', 'ه', 'ات', 'ها'];

/**
 * هل الكلمة صيغةٌ للمفتاح؟ مع حرف عطف/جرّ ملتصق (وبيض، بحليب) — للمفتاح من ثلاثة أحرف فأكثر وحده، وبلا الكاف
 * (رز ⇏ برز/فرز/كرز، روب ⇏ كروب).
 */
export function tokenMatches(token: string, kw: string): boolean {
  const cands = [token];
  if (kw.length >= 3 && token.length > kw.length && 'وبفل'.includes(token[0])) cands.push(stem(token.slice(1)));
  return cands.some(t => t.startsWith(kw) && SUFFIXES.includes(t.slice(kw.length)));
}

/** مرادفات الأصناف العامة (مطبَّعة) — الصنف الذي يحمل اسمه إحداها يُطابَق بها وحدها (لا بعلامته التجارية). «بطاطس» خضار لا شيبس. */
const SYNONYMS: string[][] = [
  ['بيض'], ['حليب', 'لبن'], ['خبز', 'صامولي', 'توست', 'صمون'], ['ماء', 'مياه', 'مويه'], ['دجاج', 'فراخ', 'دواجن'],
  ['ارز', 'رز'], ['جبن'], ['زبادي', 'روب'], ['عصير', 'عصاير'], ['سكر'], ['زيت'], ['شاي'], ['قهوه'], ['طحين', 'دقيق'],
  ['تمر', 'تمور'], ['مكرونه', 'معكرونه', 'باستا'], ['مناديل'], ['ايسكريم', 'بوظه'], ['شيبس'], ['بسكويت'],
  ['شوكولاته', 'شوكولا', 'شكولاته'], ['منظف', 'منظفات'],
].map(g => g.map(w => normalizeAr(w)));

/** كلمات الدوام والإغلاق (مطبَّعة بلا «ال») — بالكلمة كاملةً لا بجزئها (قليل ⇏ ليل، عشان ⇏ عشا). */
const HOURS_WORDS = new Set([
  'يفتح', 'فتح', 'يفتحون', 'فاتح', 'دوام', 'ساعه', 'بدري', 'مبكر', 'متاخر', 'وقت', 'ليل', 'صبح', 'صباح', 'ظهر', 'عصر', 'مغرب',
  'عشا', 'عشاء', 'فجر', 'صلاه', 'قافل', 'مقفل', 'مسكر', 'يسكر', 'يسكرون', 'مغلق', 'اغلق', 'لقيته', 'لقيناه',
].map(w => normalizeAr(w)));

/**
 * مفاتيح لها معنى آخر في سياقٍ معروف: «سكر» فعلُ إغلاقٍ في اللهجة («لقيته سكر بدري»، «المحل سكر») — جملةٌ عن الدوام
 * والإغلاق لا تُحسب ذكراً للسكّر. toks كلمات الجملة بلا «ال».
 */
const AMBIGUOUS: Record<string, (toks: string[]) => boolean> = {
  [normalizeAr('سكر')]: toks => toks.some((t, k) => HOURS_WORDS.has(t) || (t === 'سكر' && toks[k - 1] === 'محل')),
};

/** وحدات وأحجام وأوصاف لا تميّز الصنف (مطبَّعة) — تُسقط من كلماته المميِّزة. */
const NOISE = new Set([
  'مل', 'ملل', 'لتر', 'ل', 'جم', 'جرام', 'غرام', 'غ', 'كجم', 'كغ', 'كيلو', 'كلغ', 'حبه', 'حبات', 'كرتون', 'كراتين', 'علبه', 'علب',
  'عبوه', 'عبوات', 'باكيت', 'باكت', 'بكت', 'شد', 'ربطه', 'كيس', 'اكياس', 'قطعه', 'حزمه', 'درزن', 'دزن', 'صندوق', 'طبق',
  'كامل', 'دسم', 'قليل', 'خالي', 'طازج', 'طبيعي', 'كبير', 'صغير', 'وسط', 'عايلي', 'اقتصادي', 'حجم', 'نكهه', 'بنكهه', 'مع', 'بدون',
  'جديد', 'عرض', 'اصلي', 'ابيض', 'احمر', 'بني', 'اسمر', 'سعودي', 'محلي', 'مستورد', 'ممتاز', 'فاخر', 'نوع', 'صنف', 'منتج',
  'خاص', 'هديه', 'مجاني', 'مجانا',
  'x', 'ml', 'l', 'g', 'kg', 'gm', 'pcs', 'pc', 'pack', 'ctn', 'box',
].map(w => normalizeAr(w)));

/**
 * كلمات الصنف المميِّزة: مرادفات الصنف العام إن حمل اسمه إحداها (بيض المراعي ⇒ بيض)، وإلا كلماته بلا وحدات ولا أحجام
 * ولا أرقام ولا أوصاف (ببسي ٣٣٠ مل ⇒ ببسي).
 */
export function productKeywords(name: string): string[] {
  const toks = tokensAr(name);
  const groups = SYNONYMS.filter(g => g.some(kw => toks.some(t => tokenMatches(t, kw))));
  if (groups.length) return [...new Set(groups.flat())];
  return [...new Set(toks.filter(t => t.length >= 3 && !/\d/.test(t) && !NOISE.has(t)))];
}

// «قديم» وصفٌ للمحل («محل قديم»، «من قديم») لا شكوى من الصنف
const QUALITY_RE = /(غير|مو|مش|ما هو|ماهو|مب) ?طازج|خربان|منتهي|فاسد|خايس|معفن|متعفن|(?<!(محل|من) )قديم/;
const SHORTAGE_RE = /(^| )ما ?فيه?( |$)|ناقص|نواقص|ينقص|نفد|نفذ|خلصان|(ما|مو|مش|غير) ?(يتوفر|متوفر|موجود)|ما ?لقيت|ما ?عندهم/;
/**
 * نقص الأصناف في حديث المحل عموماً: مراجعةٌ سلبية بعبارة نقصٍ عن البضاعة نفسها — لا موضوع «توفّر الأصناف» في
 * profileStudy وحده («ما فيه مواقف» يطابقه لكنه ليس نقص أصناف).
 */
const TALK_SHORTAGE_RE = /ناقص|نواقص|ينقص|نفد|نفذ|خلصان|(ما|مو|مش|غير) ?(يتوفر|متوفر|موجود)|ما ?لقيت|ما ?عندهم|ما ?فيه? (شي|شيء|اغراض|بضاعه|اصناف|منتجات|حاجات)|(اصناف|بضاعه|منتجات|اغراض)[^ ]* (قليل|محدود)|(قليل|محدود)[^ ]* (الاصناف|البضاعه|المنتجات)/;
const BUSY_RE = /زحمه|زحام|مزدحم|طابور|اقبال|دايم مليان|دايما مليان/;
const CLOSING_RE = /(مغلق|مسكر|مقفل|سكر|قفل|اغلق|تسكر|يقفل) ?(نهايي|للابد|تماما)|للتقبيل|للايجار|ما ?عاد يفتح/;

/** جمل المراجعة (عند علامات الوقف و«بس/لكن») — ذكر الصنف وشكواه في الجملة نفسها لا في المراجعة كلها. */
const clauses = (text: string): string[] => text.split(/[.!؟?\n،,؛;]+|\s+(?:بس|لكن|ولكن)\s+/).map(x => x.trim()).filter(Boolean);

/** اقتباس قصير آمن: بلا روابط ولا هواتف ولا محارف خفية. */
export function safeQuote(s: string, max = 90): string {
  const t = cleanName(scrubPii(s.replace(/https?:\/\/\S+|www\.\S+/gi, ' ')), 400);
  return t.length > max ? `${t.slice(0, max - 1).trim()}…` : t;
}

export interface Mention { reviews: number; plain: boolean; complaint: ComplaintKind | null; quote: string | null }

/** ذكر كل صنف في المراجعات: عدد المراجعات، وهل ذُكر بلا شكوى، وأول شكوى، واقتباس أول جملة تذكره. */
export function findMentions(products: DemandProduct[], reviews: DemandReview[]): Map<string, Mention> {
  const keyed = products.map(p => ({ id: p.productId, kws: productKeywords(p.name) })).filter(x => x.kws.length);
  const out = new Map<string, Mention>();
  for (const r of reviews) {
    const seen = new Set<string>();
    for (const cl of clauses(r.text ?? '')) {
      const toks = tokensAr(cl);
      if (!toks.length) continue;
      const norm = normalizeAr(cl);
      const kind: ComplaintKind | null = QUALITY_RE.test(norm) ? 'QUALITY' : SHORTAGE_RE.test(norm) ? 'SHORTAGE' : null;
      for (const { id, kws } of keyed) {
        if (!kws.some(k => toks.some(t => tokenMatches(t, k)) && !AMBIGUOUS[k]?.(toks))) continue;
        const m = out.get(id) ?? { reviews: 0, plain: false, complaint: null, quote: null };
        if (!seen.has(id)) { m.reviews++; seen.add(id); }
        if (kind) m.complaint ??= kind; else m.plain = true;
        m.quote ??= safeQuote(cl) || null;
        out.set(id, m);
      }
    }
  }
  return out;
}

/** معامل ذكر الصنف: مذكور ⇒ 1.3، مذكورٌ بشكوى وحدها ⇒ 1.2 (طلبٌ قائم يُخدم سيئاً)، وإلا 1. */
export const mentionFactor = (m: Mention | undefined): number => (!m ? 1 : m.plain ? 1.3 : m.complaint ? 1.2 : 1);

/** حديث المراجعات عن المحل عموماً ومعامله R. */
export function reviewTalk(reviews: DemandReview[]): { codes: TalkCode[]; R: number } {
  const texts = reviews.filter(r => (r.text ?? '').trim());
  if (!texts.length) return { codes: [], R: 1 };
  const norm = texts.map(r => normalizeAr(r.text));
  const { praise } = reviewThemeCodes({ reviews: texts.map(r => ({ rating: r.rating, text: r.text, when: null, publishTime: null, author: null, authorUri: null })) });
  const isNeg = texts.map(r => reviewPolarity(r.rating, normalizeDigits(r.text)) < 0);
  const neg = isNeg.filter(Boolean).length;
  const closing = norm.some(t => CLOSING_RE.test(t));
  const negative = texts.length >= 3 && neg / texts.length >= 0.6;
  const busy = norm.some(t => BUSY_RE.test(t));
  const variety = praise.includes('STOCK');
  const shortage = norm.some((t, k) => isNeg[k] && TALK_SHORTAGE_RE.test(t));
  const codes: TalkCode[] = [
    ...(busy ? ['BUSY' as const] : []), ...(variety ? ['VARIETY' as const] : []), ...(shortage ? ['SHORTAGE' as const] : []),
    ...(negative ? ['NEGATIVE' as const] : []), ...(closing ? ['CLOSING' as const] : []),
  ];
  if (closing || negative) return { codes, R: 0.8 };
  return { codes, R: Math.min(1.1, Math.max(1 + (busy ? 0.05 : 0) + (variety ? 0.05 : 0), shortage ? 1.1 : 1)) };
}

// ───────────── إشارات ملف المحل ─────────────

const knownCount = (n: number | null | undefined): number | null => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);

/** وسيط مقيّمي كل نوع في المسح (عدد معروف > 0 وحده) — المسبق ٤٠ حين عُرف أقل من ٣. */
export function typeBaselines(shops: { outletType: string; ratingCount: number | null | undefined }[]): Map<string, TypeBaseline> {
  const by = new Map<string, number[]>();
  for (const s of shops) {
    const list = by.get(s.outletType) ?? [];
    const n = knownCount(s.ratingCount);
    if (n != null) list.push(n);
    by.set(s.outletType, list);
  }
  const out = new Map<string, TypeBaseline>();
  for (const [t, list] of by) {
    const counts = [...list].sort((a, b) => a - b);
    const k = counts.length;
    const med = k % 2 ? counts[(k - 1) / 2] : (counts[k / 2 - 1] + counts[k / 2]) / 2;
    out.set(t, { median: k >= MIN_TYPE_KNOWN ? med : TYPE_PRIOR_COUNT, known: k, counts });
  }
  return out;
}

/** T: √((n+5)/(m+5)) في [0.5، 2]؛ عدد مجهول ⇒ 1. */
export function trafficFactor(n: number | null | undefined, m: number): number {
  const k = knownCount(n);
  return k == null ? 1 : clamp(Math.sqrt((k + 5) / (m + 5)), 0.5, 2);
}

/** حصة محلات نوعه بمقيّمين أقل منه، لأسفل لأقرب ١٠ — null حين عُرف أقل من ٣ أو عدده مجهول. */
export function trafficPct(n: number | null | undefined, base: TypeBaseline | undefined): number | null {
  const k = knownCount(n);
  if (k == null || !base || base.known < MIN_TYPE_KNOWN) return null;
  const below = base.counts.filter(c => c < k).length;
  return Math.floor((100 * below) / base.counts.length / 10) * 10;
}

/** Q: التقييم مشدوداً بعدد مقيّميه؛ بلا تقييم ⇒ 1. */
export function qualityFactor(rating: number | null | undefined, n: number | null | undefined): number {
  const r = shrunkRating(rating ?? null, knownCount(n));
  if (r == null) return 1;
  return r >= 4.5 ? 1.15 : r >= 4 ? 1.05 : r >= 3.5 ? 1 : r >= 3 ? 0.9 : 0.8;
}

export function expectedConfidence(n: number | null | undefined, reviewsRead: boolean): ExpConfidence {
  const k = knownCount(n) ?? 0;
  if (k >= 100 && reviewsRead) return 'HIGH';
  return k >= 20 ? 'MEDIUM' : 'LOW';
}

/** تقريب للعرض: صنفٌ يُباع بالوحدة الكاملة (مرساته ≥ ١) عددٌ صحيح لا يقلّ عن ١، وغيره بمنزلة عشرية لا تقلّ عن ٠٫١. */
export function qtyRound(v: number, anchor: number): number {
  if (!Number.isFinite(v) || v <= 0) return anchor >= 1 ? 1 : 0.1;
  return anchor >= 1 ? Math.max(1, Math.round(v)) : Math.max(0.1, Math.round(v * 10) / 10);
}

/** ترتيب العرض: المذكور أولاً، ثم ذو الرقم بالقيمة (الكمية × السعر حين تُعرض المبالغ، وإلا الكمية)، وبلا رقم آخراً. */
export function rankExpected(list: ExpectedProduct[], value: (p: ExpectedProduct) => number): ExpectedProduct[] {
  const tier = (p: ExpectedProduct) => (p.mentioned ? 0 : 1) * 2 + (p.qty == null ? 1 : 0);
  return [...list].sort((a, b) => tier(a) - tier(b) || value(b) - value(a) || a.name.localeCompare(b.name, 'ar'));
}

export const REVIEW_AR: ArNoun = { one: 'مراجعة واحدة', two: 'مراجعتين', few: 'مراجعات', many: 'مراجعة', hundred: 'مراجعة' };
export const TALK_AR: Record<TalkCode, string> = {
  BUSY: 'المراجعات تتحدّث عن زحمة وإقبال',
  VARIETY: 'يُمدح بتنوّع أصنافه',
  SHORTAGE: 'شكاوى من نقص الأصناف — فرصة توريد',
  NEGATIVE: 'أغلب المراجعات سلبية',
  CLOSING: 'في المراجعات حديث عن إغلاق المحل',
};

/** سطر الأساس بالعربية: «165 مقيّماً (أكثر من 80٪ من محلات المنطقة) · تقييم 4.2 · يُذكر «بيض» في مراجعتين». */
export function basisTextAr(b: Omit<ExpectedBasis, 'text'>): string {
  const parts: string[] = [];
  if (b.ratingCount != null) {
    const rel = b.trafficPct != null
      ? (b.trafficPct >= 50 ? ` (أكثر من ${b.trafficPct}٪ من محلات المنطقة)` : ` (وسيط المنطقة ${b.typeMedianCount})`)
      : '';
    parts.push(`${countAr(b.ratingCount, RATER_AR)}${rel}`);
  } else parts.push('عدد المقيّمين غير معروف');
  if (b.rating != null) parts.push(`تقييم ${b.rating}`);
  for (const m of b.mentions) parts.push(`يُذكر «${m.name}» في ${countAr(m.reviews, REVIEW_AR)}`);
  for (const c of b.talk) parts.push(TALK_AR[c]);
  return parts.join(' · ');
}

export interface ExpectInput {
  outletType: string;
  rating: number | null;
  ratingCount: number | null;
  /** نصوص المراجعات حين قُرئت (المفتاح الرسمي) — null/غائب = لم تُقرأ */
  reviews?: DemandReview[] | null;
  base?: TypeBaseline;
  products: DemandProduct[];
  anchors: Map<string, Anchor>;
  source: ProductsSource;
  showMoney: boolean;
  /** المعامل المتعلَّم لنوع المحل ونسخته */
  cal?: { factor: number; version: number | null };
}

/** الطلب المتوقع لمحلٍّ واحد — كل عامل يُفسَّر بجملة (basis) والأرقام لكل صنف حتى ٦. */
export function expectedFor(i: ExpectInput): ExpectedShop {
  const n = knownCount(i.ratingCount);
  const m = i.base?.median ?? TYPE_PRIOR_COUNT;
  const T = trafficFactor(n, m);
  const Q = qualityFactor(i.rating, n);
  const read = Array.isArray(i.reviews);
  const reviews = read ? i.reviews!.filter(r => (r.text ?? '').trim()) : [];
  const talk = read ? reviewTalk(reviews) : { codes: [] as TalkCode[], R: 1 };
  const mentions = read ? findMentions(i.products, reviews) : new Map<string, Mention>();
  const C = clamp(Number.isFinite(i.cal?.factor) && (i.cal?.factor ?? 0) > 0 ? i.cal!.factor : 1, GSIG_F_MIN, GSIG_F_MAX);
  const all: ExpectedProduct[] = i.products.map(p => {
    const mt = mentions.get(p.productId);
    const mention = mt ? {
      mentioned: true, mentions: mt.reviews, ...(mt.complaint && !mt.plain && { complaint: mt.complaint }), ...(mt.quote && { quote: mt.quote }),
    } : { mentioned: false };
    const a = i.anchors.get(p.productId);
    if (!a || !(a.qty > 0)) return { productId: p.productId, name: p.name, unit: p.unit, qty: null, low: null, high: null, ...mention, reason: 'NO_ANCHOR' as const };
    const raw = a.qty * T * Q * talk.R * mentionFactor(mt);
    const v = raw * C;
    return {
      productId: p.productId, name: p.name, unit: p.unit,
      qty: qtyRound(v, a.qty), low: qtyRound(v * 0.7, a.qty), high: qtyRound(v * 1.3, a.qty), ...mention, raw: r3(raw),
    };
  });
  const price = new Map(i.products.map(p => [p.productId, i.anchors.get(p.productId)?.price ?? null]));
  const products = rankExpected(all, p => (p.qty ?? 0) * (i.showMoney ? price.get(p.productId) ?? 1 : 1)).slice(0, MAX_EXPECTED_PRODUCTS);
  const mentioned = [...all].filter(p => p.mentioned).sort((a, b) => (b.mentions ?? 0) - (a.mentions ?? 0)).slice(0, 2);
  const basis: Omit<ExpectedBasis, 'text'> = {
    rating: i.rating ?? null, ratingCount: n, trafficPct: trafficPct(n, i.base),
    typeMedianCount: Math.round(m), typeMedianKnown: !!i.base && i.base.known >= MIN_TYPE_KNOWN,
    T: r3(T), Q, R: talk.R, cal: r3(C),
    reviewsRead: read, reviews: reviews.length,
    mentions: mentioned.map(p => ({ name: cleanName(p.name, 40), reviews: p.mentions ?? 1 })),
    talk: talk.codes, source: i.source,
  };
  return {
    // الثقة العالية بنصوص مقروءة فعلاً — محلٌّ بلا مراجعات نصية لم يُقرأ منه شيء
    v: 1, confidence: expectedConfidence(n, reviews.length > 0), basis: { ...basis, text: basisTextAr(basis) }, products,
    calVersion: C !== 1 ? i.cal?.version ?? null : null,
  };
}

/** ما يُرسل للجهاز: بلا الرقم الخام ولا نسخة المعامل (للّقطة وحدها). */
export function expectedView(e: ExpectedShop): ExpectedShop {
  const { calVersion: _v, ...rest } = e;
  return { ...rest, products: e.products.map(({ raw: _r, ...p }) => p) };
}

/** ما عُرض للمندوب بصيغة اللقطة (حلقة التعلّم): الأصناف ذات الرقم بالمعروض والخام، والنوع والثقة والمعامل. */
export function shownOf(e: ExpectedShop, outletType: string, at = Date.now()): ShownExpected | null {
  const products = e.products.filter(p => p.qty != null && p.raw != null).map(p => ({ productId: p.productId, qty: p.qty!, raw: p.raw! }));
  return products.length ? { at, outletType, confidence: e.confidence, calVersion: e.calVersion ?? null, factor: e.basis.cal, products } : null;
}

/**
 * هل في ملف المحل إشارةٌ تخصّه (تقييم أو عدد مقيّمين أو مراجعات مقروءة)؟ بدونها الرقم حجم الطلب المعتاد للصنف نفسه لكل
 * المحلات (المسح بالمفتاح الرسمي بلا تقييمات) — يبقى في بطاقة المحل بأساسه، ولا يُعرض سطراً في القائمة ولا يصل العقل
 * كأنه رقم هذا المحل.
 */
export const hasShopSignal = (b: Pick<ExpectedBasis, 'rating' | 'ratingCount' | 'reviewsRead'>): boolean =>
  b.ratingCount != null || b.rating != null || b.reviewsRead;

/** أبرز صنفٍ برقم (المذكور أولاً بترتيب العرض) لتوجيه العقل — null بلا إشارة تخصّ المحل (hasShopSignal). */
export function topExpected(e: ExpectedShop | null | undefined): { product: string; unit: string; qty: number; mentioned: boolean } | null {
  if (!e || !hasShopSignal(e.basis)) return null;
  const p = e.products.find(x => x.qty != null);
  return p ? { product: cleanName(p.name, 40), unit: p.unit, qty: p.qty!, mentioned: p.mentioned } : null;
}

/** حتى ثلاثة أصناف برقم لمدخل دراسة العقل (أرقامها مسموحة لحارسه). */
export function studyExpected(e: ExpectedShop | null | undefined): { product: string; unit: string; qty: number; low: number; high: number; mentioned: boolean }[] {
  return (e?.products ?? []).filter(p => p.qty != null).slice(0, 3)
    .map(p => ({ product: cleanName(p.name, 40), unit: p.unit, qty: p.qty!, low: p.low ?? p.qty!, high: p.high ?? p.qty!, mentioned: p.mentioned }));
}
