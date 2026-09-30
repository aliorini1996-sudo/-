/**
 * المندوب الذكي — مسح المحلات حول المندوب من بحث خرائط Google **العام** (بلا مفتاح ولا حساب) — وضع تجربة بقرار المالك.
 *
 * كل طلب لنوع محل (مثل «بقالة») حول موقع المندوب يعيد حتى ٢٠ محلاً: الاسم، التقييم وعدد المقيّمين، التصنيف، الموقع،
 * معرّف المكان، حالة الفتح الآن، وساعات الأسبوع. **لا مراجعات نصية**: Google تحمي طلب المراجعات (403) ولا نتحايل على
 * ذلك — المراجعات بالمفتاح الرسمي (places.ts). لا حلّ لاختبارات «لست روبوتاً» ولا تبديل عناوين: إن حجبت Google الطلب
 * يفشل المسح بوضوح، وإن تغيّرت صيغة الردّ فشل بـSOURCE_CHANGED (لا «لا محلات حولك»).
 * حماية المصدر على مستوى العملية كلها: ذاكرة مؤقتة مشتركة بين المناديب والشركات (الاستعلام، الموقع مقرَّباً ~٢٠٠ م،
 * النافذة؛ ١٥ دقيقة)، وحدّ تزامن، وقاطع يوقف الطلبات بعد رفضٍ متكرّر، ومهلة للمندوب بعد مسحٍ فاشل.
 * لا يُخزَّن شيء من النتائج في القاعدة (الذاكرة وحدها).
 * ⚠️ مخالف لشروط Google — للتجربة فقط؛ الإطلاق عبر Places API الرسمية.
 */
import { publicOutletType, searchTermsFor } from './taxonomy';
import { countAr, MINUTE_AR } from './scanGuide';

/** قالب معاملات البحث كما تستعملها صفحة الخرائط نفسها: {Q} الاستعلام (base64)، {SPAN} عرض النافذة بالمتر، {LNG}/{LAT}. */
export const PUBLIC_SEARCH_PB = "!1z{Q}!4m8!1m3!1d{SPAN}!2d{LNG}!3d{LAT}!3m2!1i1024!2i768!4f13.1!7i20!10b1!12m61!1m5!18b1!30b1!31m1!1b1!34e1!2m4!5m1!6e2!20e3!39b1!6m32!32i1!49b1!63m0!66b1!85b1!114b1!149b1!206b1!209b1!212b1!215b1!216b1!222b1!223b1!232b1!234b1!235b1!246b1!253b1!260b1!262b1!266b1!270b1!271b1!273b1!277b1!280b1!281b1!291m0!294b1!302i300!303i100!10b1!12b1!13b1!14b1!16b1!17m1!3e1!20m3!5e2!6b1!14b1!46m1!1b0!96b1!97m1!2b1!99b1!19m4!2m3!1i360!2i120!4i8!20m57!2m2!1i203!2i100!3m2!2i4!5b1!6m6!1m2!1i86!2i86!1m2!1i408!2i240!7m33!1m3!1e1!2b0!3e3!1m3!1e2!2b1!3e2!1m3!1e2!2b0!3e3!1m3!1e8!2b0!3e3!1m3!1e10!2b0!3e3!1m3!1e10!2b1!3e2!1m3!1e10!2b0!3e4!1m3!1e9!2b1!3e2!2b1!9b0!15m8!1m7!1m2!1m1!1e2!2m2!1i195!2i195!3i20!22m5!1sUdq8avyrL9GO-d8PgJq3kA0!7e81!14m1!3sUdq8avyrL9GO-d8PgJq3kA0!15i9937!24m107!1m25!13m9!2b1!3b1!4b1!6i1!8b1!9b1!14b1!20b1!25b1!18m14!3b1!4b1!5b1!6b1!13b1!14b1!17b1!21b1!22b1!32b1!33m1!1b1!34b1!36e2!10m1!8e3!11m1!3e1!17b1!20m2!1e3!1e6!24b1!25b1!26b1!27b1!29b1!30m1!2b1!36b1!37b1!39m3!2m2!2i1!3i1!43b1!52b1!54m1!1b1!55b1!56m1!1b1!61m2!1m1!1e1!65m5!3m4!1m3!1m2!1i224!2i298!72m22!1m8!2b1!5b1!7b1!12m4!1b1!2b1!4m1!1e1!4b1!8m10!1m6!4m1!1e1!4m1!1e3!4m1!1e4!3sother_user_google_review_posts__and__hotel_and_vr_partner_review_posts!6m1!1e1!9b1!89b1!90m2!1m1!1e2!98m3!1b1!2b1!3b1!103b1!113b1!114m3!1b1!2m1!1b1!117b1!122m1!1b1!126b1!127b1!128m1!1b1!26m4!2m3!1i80!2i92!4i8!30m28!1m6!1m2!1i0!2i0!2m2!1i122!2i768!1m6!1m2!1i494!2i0!2m2!1i1024!2i768!1m6!1m2!1i0!2i0!2m2!1i1024!2i20!1m6!1m2!1i0!2i748!2m2!1i1024!2i768!34m19!2b1!3b1!4b1!6b1!8m6!1b1!3b1!4b1!5b1!6b1!7b1!9b1!12b1!14b1!20b1!23b1!25b1!26b1!31b1!37m1!1e81!42b1!49m10!3b1!6m2!1b1!2b1!7m2!1e3!2b1!8b1!9b1!10e2!50m3!2e2!3m1!3b1!61b1!67m5!7b1!10b1!14b1!15m1!1b0!69i797!77b1";

export interface PublicPlace {
  placeId: string;
  featureId: string | null;
  name: string;
  rating: number | null;
  /** عدد المقيّمين — null = لم يُعرض */
  ratingCount: number | null;
  lat: number;
  lng: number;
  categories: string[];
  address: string | null;
  /** «مفتوح · يغلق عند …» أو «مغلق · يفتح …» أو «سيغلق قريبًا: …» كما تعرضه Google الآن */
  openText: string | null;
  openNow: boolean | null;
  /** ساعات الأسبوع («الجمعة: مغلق») — فارغة إن لم تُعرض */
  hours: string[];
  /** مغلق نهائياً أو مؤقتاً حسب Google — يُسقَط من المسح */
  closed: boolean;
}

export type PublicSearchCode = 'BLOCKED' | 'UNAVAILABLE' | 'SOURCE_CHANGED' | 'COOLDOWN';

export type PublicSearchResult =
  | { ok: true; places: PublicPlace[]; cached?: boolean }
  | { ok: false; code: PublicSearchCode; message: string; retryAfterS?: number };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

type FetchText = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * بلدان يُبحث فيها بكلمات البحث العربية؛ وغيرها بالإنجليزية (تفهمها Google في كل بلد). أما لغة الردّ فعربية دائماً
 * (hl=ar): قراءة حالة الفتح («مفتوح/مغلق/يغلق…») والإغلاق النهائي وتصنيف المحل (publicOutletType) كلها بالعربية.
 */
const ARABIC_SEARCH = new Set(['SA', 'EG', 'AE', 'KW', 'QA', 'BH', 'OM', 'MA', 'DZ', 'TN', 'JO', 'IQ', 'LB', 'LY', 'PS', 'SD', 'YE', 'SY', 'MR', 'DJ', 'SO', 'KM']);

/** بلد الشركة ← gl للبحث العام (حرفان؛ غيرهما ⇒ السعودية). */
export function searchCountry(code: string | null | undefined): string {
  const c = (code ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : 'SA';
}

/** لغة كلمات البحث في بلد الشركة. */
export const searchLang = (country: string | null | undefined): 'ar' | 'en' => (ARABIC_SEARCH.has(searchCountry(country)) ? 'ar' : 'en');

export function publicSearchUrl(query: string, lat: number, lng: number, spanM: number, country = 'SA'): string {
  const q = Buffer.from(query, 'utf8').toString('base64').replace(/=+$/, '');
  const pb = PUBLIC_SEARCH_PB
    .replace('{Q}', q)
    .replace('{SPAN}', String(Math.round(Math.min(20000, Math.max(500, spanM)))))
    .replace('{LNG}', lng.toFixed(6))
    .replace('{LAT}', lat.toFixed(6));
  return `https://www.google.com/search?tbm=map&authuser=0&hl=ar&gl=${searchCountry(country).toLowerCase()}&q=${encodeURIComponent(query)}&pb=${encodeURIComponent(pb)}`;
}

const at = (x: unknown, ...path: number[]): unknown => {
  let cur = x;
  for (const i of path) { if (!Array.isArray(cur)) return undefined; cur = cur[i]; }
  return cur;
};
const str = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x.trim() : null);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

const STATUS_RE = /^(مفتوح|مغلق|س?يفتح|س?يغلق)/;
const CLOSED_FOR_GOOD = /مغلقة?\s*(نهائي|مؤقت)/;
const PLACE_ID_RE = /^ChIJ[\w-]{10,}$/;

/** أول نصّ يطابق re داخل جزء (بعمق محدود). */
function findText(x: unknown, re: RegExp, depth = 0): string | null {
  if (depth > 8) return null;
  if (typeof x === 'string') return re.test(x.trim()) ? x.trim() : null;
  if (Array.isArray(x)) for (const y of x) { const t = findText(y, re, depth + 1); if (t) return t; }
  return null;
}

/** نصّ حالة ← مفتوح الآن؟ «سيغلق قريبًا» مفتوح بعد، و«سيفتح قريبًا» مغلق بعد. */
export function openFlag(t: string | null): boolean | null {
  if (!t) return null;
  if (/^(مفتوح|س?يغلق)/.test(t)) return true;
  if (/^(مغلق|س?يفتح)/.test(t)) return false;
  return null;
}

/**
 * جزء ساعات العمل x[203]: [0] جدول الأسبوع، و[1] حالة الآن ([4][0] سطرها، و[8][0] «مفتوح/مغلق»).
 * الحالة من خانتها لا من الجدول — وإلا وسَم يومُ عطلةٍ فيه («الجمعة: مغلق») المحلَّ «مغلق الآن» كل يوم.
 */
export function openStatus(h: unknown): { openText: string | null; openNow: boolean | null } {
  const cur = at(h, 1);
  const openText = str(at(cur, 4, 0)) ?? str(at(cur, 5, 0)) ?? (Array.isArray(h) ? findText(h.slice(1), STATUS_RE) : null);
  return { openText, openNow: openFlag(str(at(cur, 8, 0))) ?? openFlag(openText) };
}

/** جدول الأسبوع x[203][0] ← «اليوم: الساعات». */
export function weeklyHours(h: unknown): string[] {
  const days = at(h, 0);
  if (!Array.isArray(days)) return [];
  const out: string[] = [];
  for (const d of days.slice(0, 7)) {
    const day = str(at(d, 0));
    const slots = at(d, 3);
    const times = Array.isArray(slots) ? slots.map(s => str(at(s, 0))).filter((t): t is string => !!t) : [];
    if (day && times.length) out.push(`${day}: ${times.join('، ')}`);
  }
  return out;
}

/**
 * ردّ البحث العام ← محلات (صرف ومتسامح: أي مدخل غير متوقّع يُتجاوز).
 * null = ليس ردّ بحث (حجب/صفحة موافقة). 'CHANGED' = ردّ بحث بشكل لا نعرفه (غيّرت Google صيغتها) — لا يُعرض كمنطقة خالية.
 * المنطقة الخالية فعلاً: الردّ يعيد الاستعلام في [0][0] بلا قائمة [64] ولا معرّف مكان خارج [0] (فيه مكان المنطقة
 * نفسها) ⇒ []. معرّفات أماكن في موضع آخر = القائمة انتقلت ⇒ CHANGED (لا «لا محلات حولك» بصمت).
 */
export function parsePublicSearch(body: string): PublicPlace[] | 'CHANGED' | null {
  let data: unknown;
  try {
    const o = JSON.parse(body.replace(/^\)\]\}'\n?/, '')) as unknown;
    const d = (o as { d?: unknown } | null)?.d;
    data = typeof d === 'string' ? JSON.parse(d.replace(/^\)\]\}'\n?/, '')) : o;
  } catch { return null; }
  if (!Array.isArray(data)) return null;
  const list = at(data, 64);
  if (!Array.isArray(list)) return typeof at(data, 0, 0) === 'string' && !findText(data.slice(1), PLACE_ID_RE) ? [] : 'CHANGED';
  const out: PublicPlace[] = [];
  for (const e of list) {
    const x = at(e, 1);
    if (!Array.isArray(x)) continue;
    const name = str(x[11]);
    const lat = num(at(x, 9, 2)), lng = num(at(x, 9, 3));
    const placeId = str(x[78]);
    if (!name || lat == null || lng == null || !placeId) continue;
    const { openText, openNow } = openStatus(x[203]);
    out.push({
      placeId,
      featureId: str(x[10]),
      name,
      rating: num(at(x, 4, 7)),
      ratingCount: num(at(x, 4, 8)),
      lat, lng,
      categories: Array.isArray(x[13]) ? (x[13] as unknown[]).filter((c): c is string => typeof c === 'string').slice(0, 4) : [],
      address: str(x[39]) ?? str(x[18]),
      openText,
      openNow,
      hours: weeklyHours(x[203]),
      closed: CLOSED_FOR_GOOD.test(openText ?? '') || !!findText(x[34], CLOSED_FOR_GOOD)
        || !!findText(Array.isArray(x[203]) ? x[203].slice(1) : null, CLOSED_FOR_GOOD),
    });
  }
  return list.length && !out.length ? 'CHANGED' : out;
}

// ───────────── حماية المصدر (حالة العملية كلها، مشتركة بين الشركات) ─────────────

const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX = 500;
/** شبكة تقريب الموقع (~٢٢٠ م): مفتاح الذاكرة ونقطة الطلب معاً، فيتشارك المندوبان المتجاوران النتيجة نفسها. */
const GRID_DEG = 0.002;
const MAX_CONCURRENT = 4;
const MAX_QUEUED = 24;
/** القاطع: ٣ رفضات (حجب أو صيغة مجهولة) خلال ٥ دقائق ⇒ لا طلبات إلى Google ١٢ دقيقة (الذاكرة المؤقتة تبقى تخدم). */
const TRIP_WINDOW_MS = 5 * 60_000;
const TRIP_COUNT = 3;
export const BREAKER_OPEN_MS = 12 * 60_000;
/** مهلة المندوب بعد مسحٍ فشل كلّه: الحصة تُعاد فلا كلفة تردعه، و«حدّث» المتكرّر يُبقي عنوان الخادم موسوماً. */
export const REP_RETRY_MS = 30_000;

const cache = new Map<string, { at: number; places: PublicPlace[] }>();
let rejects: number[] = [];
let openUntil = 0;
let active = 0;
const queue: (() => void)[] = [];
const repFailedAt = new Map<string, number>();
/** صحّة المصدر للنبضة (health.yml): آخر صيغة مجهولة، ومناديب متتالون (عبر الشركات) نجح مسحهم بلا محل واحد. */
const CHANGED_ALERT_MS = 30 * 60_000;
const EMPTY_REPS_ALERT = 3;
let changedAt = 0;
const emptyReps = new Set<string>();

/** للاختبارات: حالة نظيفة. */
export function resetPublicSearchState(): void {
  cache.clear(); rejects = []; openUntil = 0; active = 0; queue.length = 0; repFailedAt.clear();
  changedAt = 0; emptyReps.clear();
}

/**
 * نتيجة مسحٍ عام نجح: صفرُ محلات لمناديب مختلفين تباعاً (بلا مسحٍ مثمر بينهم) علامةُ صيغةٍ تغيّرت بصمت — لا منطقة
 * خالية؛ مندوبٌ واحد يحدّث في صحراء لا يكفي.
 */
export function notePublicScanShops(repKey: string, shops: number): void {
  if (shops > 0) emptyReps.clear();
  else if (emptyReps.size < 100) emptyReps.add(repKey);
}

/**
 * حالة المسح العام لنبضة الصحة: source_changed (صيغة مجهولة خلال نصف ساعة)، empty (مناديب متتالون بلا محلات)،
 * blocked (القاطع مفتوح — للعرض؛ الحجب عابر فلا يُنذر به)، وإلا ok. تعطّله يصيب الشركات كلها معاً.
 */
export function publicScanHealth(now = Date.now()): 'ok' | 'blocked' | 'source_changed' | 'empty' {
  if (changedAt && now - changedAt < CHANGED_ALERT_MS) return 'source_changed';
  if (emptyReps.size >= EMPTY_REPS_ALERT) return 'empty';
  return breakerLeftMs(now) ? 'blocked' : 'ok';
}

/** ما بقي من القاطع بالملّي ثانية (0 = الطلبات تمرّ). */
export function breakerLeftMs(now = Date.now()): number {
  return Math.max(0, openUntil - now);
}

function noteReject(code: PublicSearchCode, now: number): void {
  rejects = rejects.filter(t => now - t < TRIP_WINDOW_MS);
  rejects.push(now);
  if (rejects.length >= TRIP_COUNT && openUntil <= now) {
    openUntil = now + BREAKER_OPEN_MS;
    rejects = [];
    console.error('[ai-rep] قاطع المسح العام فُتح', BREAKER_OPEN_MS / 60_000, 'دقيقة — آخر رفض:', code);
  }
}

/** حدّ التزامن: من ينهي يسلّم مكانه لأول المنتظرين مباشرةً (فلا يتجاوز الحدَّ داخلٌ جديد في الأثناء). */
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active < MAX_CONCURRENT) active++;
  else await new Promise<void>(resolve => queue.push(resolve));
  try { return await fn(); } finally {
    const next = queue.shift();
    if (next) next(); else active--;
  }
}

const cooldown = (leftMs: number): PublicSearchResult => ({
  ok: false, code: 'COOLDOWN', retryAfterS: Math.ceil(leftMs / 1000), message: 'خرائط Google تحدّ من البحث الآن — أعد المحاولة بعد قليل',
});

/** ما بقي من مهلة المندوب بعد مسحٍ فاشل (0 = يمسح). المفتاح «شركة|مندوب». */
export function repRetryLeftMs(key: string, now = Date.now()): number {
  const t = repFailedAt.get(key);
  if (t == null) return 0;
  const left = t + REP_RETRY_MS - now;
  if (left > 0) return left;
  repFailedAt.delete(key);
  return 0;
}

export function noteRepScanFailed(key: string, now = Date.now()): void {
  repFailedAt.delete(key);
  repFailedAt.set(key, now);
  if (repFailedAt.size > 5000) repFailedAt.delete(repFailedAt.keys().next().value!);
}

/** طلب واحد إلى Google (بلا ذاكرة ولا قاطع). */
async function fetchSearch(query: string, lat: number, lng: number, spanM: number, country: string, f: FetchText, timeoutMs: number): Promise<PublicSearchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(publicSearchUrl(query, lat, lng, spanM, country), {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.8', Cookie: 'CONSENT=YES+' },
      signal: ctrl.signal,
    });
    const body = await res.text();
    if (!res.ok) return { ok: false, code: res.status === 429 || res.status === 403 ? 'BLOCKED' : 'UNAVAILABLE', message: 'خرائط Google رفضت البحث الآن — حاول بعد قليل' };
    const places = parsePublicSearch(body);
    if (places == null) return { ok: false, code: 'BLOCKED', message: 'خرائط Google لم تُعِد نتائج (قد تكون حجبت الطلب) — حاول بعد قليل' };
    if (places === 'CHANGED') return { ok: false, code: 'SOURCE_CHANGED', message: 'تعذّرت قراءة نتائج خرائط Google الآن (تغيّرت صيغتها) — حاول لاحقاً' };
    return { ok: true, places };
  } catch {
    return { ok: false, code: 'UNAVAILABLE', message: 'تعذّر الوصول لخرائط Google — تحقّق من الاتصال' };
  } finally {
    clearTimeout(timer);
  }
}

export type PublicScanResult =
  | { ok: true; places: (PublicPlace & { type: string })[]; partial: boolean; codes: PublicSearchCode[] }
  | { ok: false; code: 'SCAN_FAILED' | 'SOURCE_CHANGED' | 'SCAN_COOLDOWN'; message: string; retryAfterS?: number; codes: PublicSearchCode[] };

/**
 * المسح العام حول المندوب: لكل نوع نافذة واسعة (٢٫٥× نصف القطر) ونافذة صغيرة على المندوب (Google ترتّب بالشهرة لا
 * بالقرب، فأقرب البقالات الصغيرة تغيب عن الواسعة) بصياغتين مختلفتين، كلها عبر الذاكرة المؤقتة والقاطع وحدّ التزامن.
 * بلا تكرار، والمغلق نهائياً/مؤقتاً يُسقط، والنوع من تصنيف Google للمحل (publicOutletType) لا من البحث الذي وجده.
 * البلد (gl) بلد الشركة، وكلمات البحث بلغته (searchLang). فشل الطلبات كلها ⇒ خطأ بسببه؛ فشل بعضها ⇒ partial.
 */
export async function publicScan(opts: {
  types: readonly string[]; targets: readonly string[]; lat: number; lng: number; radiusM: number;
  /** بلد الشركة (CompanySettings.countryCode) — غيابه ⇒ السعودية */
  country?: string | null;
  search?: (o: { query: string; lat: number; lng: number; spanM: number; country: string }) => Promise<PublicSearchResult>;
}): Promise<PublicScanResult> {
  const search = opts.search ?? publicSearch;
  const country = searchCountry(opts.country);
  const lang = searchLang(country);
  const nearSpan = Math.max(600, Math.min(1500, opts.radiusM * 0.5));
  const jobs = opts.types.flatMap(t => {
    const [wide, near = wide] = searchTermsFor(t, lang);
    return wide ? [{ t, query: wide, spanM: opts.radiusM * 2.5 }, { t, query: near, spanM: nearSpan }] : [];
  });
  const results = await Promise.all(jobs.map(j => search({ query: j.query, lat: opts.lat, lng: opts.lng, spanM: j.spanM, country }).then(r => ({ t: j.t, r }))));
  const codes = results.flatMap(x => (x.r.ok ? [] : [x.r.code]));
  if (!results.length || codes.length === results.length) {
    const cool = results.map(x => x.r).find(r => !r.ok && r.code === 'COOLDOWN');
    if (cool && !cool.ok) {
      const mins = Math.max(1, Math.ceil((cool.retryAfterS ?? 60) / 60));
      return { ok: false, code: 'SCAN_COOLDOWN', retryAfterS: cool.retryAfterS, codes, message: `خرائط Google تحدّ من البحث الآن — أعد المحاولة بعد ${countAr(mins, MINUTE_AR)}` };
    }
    const first = results[0]?.r;
    return {
      ok: false, codes,
      code: codes.length && codes.every(x => x === 'SOURCE_CHANGED') ? 'SOURCE_CHANGED' : 'SCAN_FAILED',
      message: first && !first.ok ? first.message : 'تعذّر مسح المحلات حولك — حاول بعد قليل',
    };
  }
  const seen = new Set<string>();
  const places: (PublicPlace & { type: string })[] = [];
  for (const { t, r } of results) {
    if (!r.ok) continue;
    for (const p of r.places) {
      if (p.closed || seen.has(p.placeId)) continue;
      seen.add(p.placeId);
      // تصنيف Google نوعٌ لا تستهدفه الشركة (كسلاسل الهايبر لشركة بقالات) ⇒ يُسقط
      const type = publicOutletType(p, t, opts.targets);
      if (type) places.push({ ...p, type });
    }
  }
  return { ok: true, places, partial: codes.length > 0, codes };
}

/** بحث عام واحد حول نقطة: من الذاكرة المؤقتة إن وُجد، وإلا عبر القاطع وحدّ التزامن. */
export async function publicSearch(opts: {
  query: string; lat: number; lng: number; spanM: number; country?: string | null; fetchImpl?: FetchText; timeoutMs?: number; now?: () => number;
}): Promise<PublicSearchResult> {
  const clock = opts.now ?? Date.now;
  const lat = Math.round(opts.lat / GRID_DEG) * GRID_DEG, lng = Math.round(opts.lng / GRID_DEG) * GRID_DEG;
  const span = Math.round(opts.spanM / 100) * 100;
  const country = searchCountry(opts.country);
  const key = `${opts.query}|${country}|${lat.toFixed(3)}|${lng.toFixed(3)}|${span}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    if (clock() - hit.at < CACHE_TTL_MS) { cache.set(key, hit); return { ok: true, places: hit.places, cached: true }; }
  }
  const left = breakerLeftMs(clock());
  if (left) return cooldown(left);
  if (active >= MAX_CONCURRENT && queue.length >= MAX_QUEUED) return { ok: false, code: 'UNAVAILABLE', message: 'خرائط Google مشغولة الآن — حاول بعد قليل' };
  return withSlot(async () => {
    // القاطع قد يُفتح أثناء الانتظار
    const l2 = breakerLeftMs(clock());
    if (l2) return cooldown(l2);
    const r = await fetchSearch(opts.query, lat, lng, span, country, opts.fetchImpl ?? (fetch as unknown as FetchText), opts.timeoutMs ?? 9000);
    if (r.ok) {
      cache.set(key, { at: clock(), places: r.places });
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    } else if (r.code === 'BLOCKED' || r.code === 'SOURCE_CHANGED') {
      if (r.code === 'SOURCE_CHANGED') changedAt = clock();
      noteReject(r.code, clock());
    }
    return r;
  });
}
