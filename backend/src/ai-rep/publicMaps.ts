/**
 * المندوب الذكي — مسح المحلات حول المندوب من بحث خرائط Google **العام** (بلا مفتاح ولا حساب) — وضع تجربة بقرار المالك.
 *
 * طلب واحد لكل نوع محل (مثل «بقالة») حول موقع المندوب يعيد حتى ٢٠ محلاً: الاسم، التقييم، النوع، الموقع، معرّف
 * المكان، وحالة الفتح. **لا مراجعات نصية**: Google تحمي طلب المراجعات (403) ولا نتحايل على ذلك — المراجعات بالمفتاح
 * الرسمي (places.ts). لا حلّ لاختبارات «لست روبوتاً» ولا تبديل عناوين: إن حجبت Google الطلب يفشل المسح بوضوح.
 * لا يُخزَّن شيء من النتائج في القاعدة (الذاكرة وحدها، طوال جلسة المندوب).
 * ⚠️ مخالف لشروط Google — للتجربة فقط؛ الإطلاق عبر Places API الرسمية.
 */

/** قالب معاملات البحث كما تستعملها صفحة الخرائط نفسها: {Q} الاستعلام (base64)، {SPAN} عرض النافذة بالمتر، {LNG}/{LAT}. */
export const PUBLIC_SEARCH_PB = "!1z{Q}!4m8!1m3!1d{SPAN}!2d{LNG}!3d{LAT}!3m2!1i1024!2i768!4f13.1!7i20!10b1!12m61!1m5!18b1!30b1!31m1!1b1!34e1!2m4!5m1!6e2!20e3!39b1!6m32!32i1!49b1!63m0!66b1!85b1!114b1!149b1!206b1!209b1!212b1!215b1!216b1!222b1!223b1!232b1!234b1!235b1!246b1!253b1!260b1!262b1!266b1!270b1!271b1!273b1!277b1!280b1!281b1!291m0!294b1!302i300!303i100!10b1!12b1!13b1!14b1!16b1!17m1!3e1!20m3!5e2!6b1!14b1!46m1!1b0!96b1!97m1!2b1!99b1!19m4!2m3!1i360!2i120!4i8!20m57!2m2!1i203!2i100!3m2!2i4!5b1!6m6!1m2!1i86!2i86!1m2!1i408!2i240!7m33!1m3!1e1!2b0!3e3!1m3!1e2!2b1!3e2!1m3!1e2!2b0!3e3!1m3!1e8!2b0!3e3!1m3!1e10!2b0!3e3!1m3!1e10!2b1!3e2!1m3!1e10!2b0!3e4!1m3!1e9!2b1!3e2!2b1!9b0!15m8!1m7!1m2!1m1!1e2!2m2!1i195!2i195!3i20!22m5!1sUdq8avyrL9GO-d8PgJq3kA0!7e81!14m1!3sUdq8avyrL9GO-d8PgJq3kA0!15i9937!24m107!1m25!13m9!2b1!3b1!4b1!6i1!8b1!9b1!14b1!20b1!25b1!18m14!3b1!4b1!5b1!6b1!13b1!14b1!17b1!21b1!22b1!32b1!33m1!1b1!34b1!36e2!10m1!8e3!11m1!3e1!17b1!20m2!1e3!1e6!24b1!25b1!26b1!27b1!29b1!30m1!2b1!36b1!37b1!39m3!2m2!2i1!3i1!43b1!52b1!54m1!1b1!55b1!56m1!1b1!61m2!1m1!1e1!65m5!3m4!1m3!1m2!1i224!2i298!72m22!1m8!2b1!5b1!7b1!12m4!1b1!2b1!4m1!1e1!4b1!8m10!1m6!4m1!1e1!4m1!1e3!4m1!1e4!3sother_user_google_review_posts__and__hotel_and_vr_partner_review_posts!6m1!1e1!9b1!89b1!90m2!1m1!1e2!98m3!1b1!2b1!3b1!103b1!113b1!114m3!1b1!2m1!1b1!117b1!122m1!1b1!126b1!127b1!128m1!1b1!26m4!2m3!1i80!2i92!4i8!30m28!1m6!1m2!1i0!2i0!2m2!1i122!2i768!1m6!1m2!1i494!2i0!2m2!1i1024!2i768!1m6!1m2!1i0!2i0!2m2!1i1024!2i20!1m6!1m2!1i0!2i748!2m2!1i1024!2i768!34m19!2b1!3b1!4b1!6b1!8m6!1b1!3b1!4b1!5b1!6b1!7b1!9b1!12b1!14b1!20b1!23b1!25b1!26b1!31b1!37m1!1e81!42b1!49m10!3b1!6m2!1b1!2b1!7m2!1e3!2b1!8b1!9b1!10e2!50m3!2e2!3m1!3b1!61b1!67m5!7b1!10b1!14b1!15m1!1b0!69i797!77b1";

export interface PublicPlace {
  placeId: string;
  featureId: string | null;
  name: string;
  rating: number | null;
  lat: number;
  lng: number;
  categories: string[];
  address: string | null;
  /** «مفتوح · يغلق عند …» أو «مغلق · …» كما تعرضه Google */
  openText: string | null;
  openNow: boolean | null;
}

export type PublicSearchResult =
  | { ok: true; places: PublicPlace[] }
  | { ok: false; code: 'BLOCKED' | 'UNAVAILABLE'; message: string };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

type FetchText = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export function publicSearchUrl(query: string, lat: number, lng: number, spanM: number): string {
  const q = Buffer.from(query, 'utf8').toString('base64').replace(/=+$/, '');
  const pb = PUBLIC_SEARCH_PB
    .replace('{Q}', q)
    .replace('{SPAN}', String(Math.round(Math.min(20000, Math.max(500, spanM)))))
    .replace('{LNG}', lng.toFixed(6))
    .replace('{LAT}', lat.toFixed(6));
  return `https://www.google.com/search?tbm=map&authuser=0&hl=ar&gl=sa&q=${encodeURIComponent(query)}&pb=${encodeURIComponent(pb)}`;
}

const at = (x: unknown, ...path: number[]): unknown => {
  let cur = x;
  for (const i of path) { if (!Array.isArray(cur)) return undefined; cur = cur[i]; }
  return cur;
};
const str = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x.trim() : null);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** أول نص حالة فتح («مفتوح…»/«مغلق…») داخل جزء ساعات العمل. */
function findOpenText(x: unknown, depth = 0): string | null {
  if (depth > 8) return null;
  if (typeof x === 'string') return /^(مفتوح|مغلق|يفتح|يغلق|مفتوحة|مغلقة)/.test(x.trim()) ? x.trim() : null;
  if (Array.isArray(x)) for (const y of x) { const t = findOpenText(y, depth + 1); if (t) return t; }
  return null;
}

/** ردّ البحث العام ← محلات (صرف ومتسامح: أي مدخل غير متوقّع يُتجاوز). null = ليس ردّ بحث (حجب/صفحة موافقة). */
export function parsePublicSearch(body: string): PublicPlace[] | null {
  let data: unknown;
  try {
    const o = JSON.parse(body.replace(/^\)\]\}'\n?/, '')) as unknown;
    const d = (o as { d?: unknown } | null)?.d;
    data = typeof d === 'string' ? JSON.parse(d.replace(/^\)\]\}'\n?/, '')) : o;
  } catch { return null; }
  if (!Array.isArray(data)) return null;
  const list = at(data, 64);
  if (!Array.isArray(list)) return [];
  const out: PublicPlace[] = [];
  for (const e of list) {
    const x = at(e, 1);
    if (!Array.isArray(x)) continue;
    const name = str(x[11]);
    const lat = num(at(x, 9, 2)), lng = num(at(x, 9, 3));
    const placeId = str(x[78]);
    if (!name || lat == null || lng == null || !placeId) continue;
    const openText = findOpenText(x[203]);
    out.push({
      placeId,
      featureId: str(x[10]),
      name,
      rating: num(at(x, 4, 7)),
      lat, lng,
      categories: Array.isArray(x[13]) ? (x[13] as unknown[]).filter((c): c is string => typeof c === 'string').slice(0, 4) : [],
      address: str(x[39]) ?? str(x[18]),
      openText,
      openNow: openText ? /^مفتوح/.test(openText) ? true : /^مغلق/.test(openText) ? false : null : null,
    });
  }
  return out;
}

/** بحث عام واحد حول نقطة. */
export async function publicSearch(opts: { query: string; lat: number; lng: number; spanM: number; fetchImpl?: FetchText; timeoutMs?: number }): Promise<PublicSearchResult> {
  const f: FetchText = opts.fetchImpl ?? (fetch as unknown as FetchText);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 9000);
  try {
    const res = await f(publicSearchUrl(opts.query, opts.lat, opts.lng, opts.spanM), {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.8', Cookie: 'CONSENT=YES+' },
      signal: ctrl.signal,
    });
    const body = await res.text();
    if (!res.ok) return { ok: false, code: res.status === 429 || res.status === 403 ? 'BLOCKED' : 'UNAVAILABLE', message: 'خرائط Google رفضت البحث الآن — حاول بعد قليل' };
    const places = parsePublicSearch(body);
    if (places == null) return { ok: false, code: 'BLOCKED', message: 'خرائط Google لم تُعِد نتائج (قد تكون حجبت الطلب) — حاول بعد قليل' };
    return { ok: true, places };
  } catch {
    return { ok: false, code: 'UNAVAILABLE', message: 'تعذّر الوصول لخرائط Google — تحقّق من الاتصال' };
  } finally {
    clearTimeout(timer);
  }
}
