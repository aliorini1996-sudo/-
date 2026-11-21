import crypto from 'crypto';
import { routeThrough, GeoPoint } from './mapMatch';

type RouteFn = (wps: GeoPoint[], cacheKey?: string) => Promise<{ lat: number; lng: number }[] | null>;

const ttCache = new Map<string, { at: number; pts: { lat: number; lng: number }[] }>();
const TT_TTL_MS = 6 * 60 * 60_000;

/**
 * بديل TomTom (TOMTOM_API_KEY على الخادم أصلاً): يقبل محطّةً بعيدةً عن الطريق ويوجّه من أقرب شارعٍ إليها، حيث يرفض
 * Geoapify الطلب كلّه («No suitable edges near location»). اختُبر ٢١ نوفمبر: نقطةٌ في أرضٍ فضاء شمال الرياض ⇒ ٧٣٤ نقطة على الطرق.
 */
export async function tomtomRoute(waypoints: GeoPoint[], cacheKey?: string): Promise<{ lat: number; lng: number }[] | null> {
  const key = (process.env.TOMTOM_API_KEY || '').trim();
  if (!key || waypoints.length < 2) return null;
  if (cacheKey) { const hit = ttCache.get(cacheKey); if (hit && Date.now() - hit.at < TT_TTL_MS) return hit.pts; }
  const loc = waypoints.map((p) => `${p.lat},${p.lng}`).join(':');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(`https://api.tomtom.com/routing/1/calculateRoute/${encodeURIComponent(loc)}/json?travelMode=car&routeRepresentation=polyline&key=${encodeURIComponent(key)}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const json = await resp.json() as { routes?: { legs?: { points?: { latitude: number; longitude: number }[] }[] }[] };
    const pts = (json.routes?.[0]?.legs ?? []).flatMap((l) => (l.points ?? []).map((p) => ({ lat: p.latitude, lng: p.longitude })));
    if (pts.length < 2) return null;
    if (cacheKey) { if (ttCache.size > 1500) ttCache.clear(); ttCache.set(cacheKey, { at: Date.now(), pts }); }
    return pts;
  } catch { return null; }
}
import { MAX_BRIDGE_WAYPOINTS } from './routeShape';

/**
 * «خط السير المخطَّط» على الشوارع (طلب المالك ٢١ نوفمبر ٢٠٢٦): كان يُرسم خطوطاً مستقيمة بين محطّات العملاء،
 * والآن طريقُ قيادةٍ حقيقي يمرّ بالمحطّات بترتيبها — بمحرّك التوجيه نفسه الذي يملأ فراغات أثر المندوب
 * (`routeThrough` في mapMatch.ts، Geoapify routing).
 *
 * هو **خطّةٌ لا أثر**: الطريق المقترح بين العملاء، لا ما سلكه المندوب — فيبقى بنفسجياً متقطّعاً في الواجهة.
 * المحطّات تُقسَّم دفعاتٍ ≤ MAX_BRIDGE_WAYPOINTS تتشارك نقطة الوصل، وما تعذّر توجيهه (لا مفتاح/حصّة/مهلة)
 * يبقى خطّاً مستقيماً بين محطّاته ويُرفع `degraded` — يُعلَن ولا يُبتلع.
 */
export interface PlanRoadPath {
  points: { lat: number; lng: number }[];
  /** مقطعٌ واحدٌ على الأقل بقي مستقيماً (تعذّر التوجيه) */
  degraded: boolean;
}

/** سقف المحطّات التي تُوجَّه في الطلب الواحد — ما زاد يبقى مستقيماً (حماية حصّة المزوّد) */
export const MAX_PLAN_STOPS = 80;

/** دفعاتٌ متتالية ≤ max تتشارك كلُّ دفعةٍ آخرَ محطّةٍ في سابقتها فيتّصل الخطّ */
export function chunkWaypoints<T>(wps: T[], max = MAX_BRIDGE_WAYPOINTS): T[][] {
  if (wps.length < 2) return [];
  const size = Math.max(2, max);
  const out: T[][] = [];
  for (let i = 0; i < wps.length - 1; i += size - 1) out.push(wps.slice(i, i + size));
  return out;
}

const keyOf = (prefix: string, chunk: GeoPoint[]) =>
  `${prefix}:plan:${crypto.createHash('sha1').update(chunk.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|')).digest('hex')}`;

export async function planRoadPath(
  stops: GeoPoint[],
  keyPrefix: string,
  route: RouteFn = routeThrough,
  fallback: RouteFn = tomtomRoute,
): Promise<PlanRoadPath | null> {
  const pts = stops.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (pts.length < 2) return null;
  const routed = pts.slice(0, MAX_PLAN_STOPS);
  const rest = pts.slice(MAX_PLAN_STOPS - 1); // المحطّات بعد السقف: مستقيمة من آخر محطّةٍ موجَّهة
  const chunks = chunkWaypoints(routed);
  let pairDegraded = false;
  const tryRoute = (c: GeoPoint[]) => route(c, keyOf(keyPrefix, c)).catch(() => null);
  /*
   * Geoapify يرفض الدفعة **كلّها** إن كانت محطّةٌ واحدة بعيدةً عن أي طريق («No suitable edges near location» —
   * عميلٌ في أرضٍ فضاء أو موقعٌ مُدخَلٌ تقريبياً). فإن فشلت الدفعة نوجّه أزواجها المتتالية واحداً واحداً: يتبع
   * الشوارعَ كلُّ ما أمكن، ويبقى المستقيم للزوج المتعذّر وحده — لا للخطّ كلّه (اكتُشف حيّاً ٢١ نوفمبر).
   */
  const ok = (r: { lat: number; lng: number }[] | null | undefined): r is { lat: number; lng: number }[] => !!r && r.length >= 2;
  const results = await Promise.all(chunks.map(async (c) => {
    const whole = await tryRoute(c);
    if (ok(whole)) return whole;
    // البديل يقبل المحطّة البعيدة عن الطريق — الدفعة كاملةً بطلبٍ واحد
    const alt = await fallback(c, `${keyOf(keyPrefix, c)}:tt`).catch(() => null);
    if (ok(alt)) return alt;
    if (c.length <= 2) return null;
    const pairs = await Promise.all(c.slice(0, -1).map((a, i) => tryRoute([a, c[i + 1]])));
    if (pairs.every((r) => !r || r.length < 2)) return null;
    const joined: { lat: number; lng: number }[] = [];
    let partial = false;
    pairs.forEach((r, i) => {
      const seg = r && r.length >= 2 ? r : (partial = true, [c[i], c[i + 1]].map((p) => ({ lat: p.lat, lng: p.lng })));
      joined.push(...(joined.length ? seg.slice(1) : seg));
    });
    if (partial) pairDegraded = true;
    return joined;
  }));
  let degraded = rest.length > 1 || pairDegraded;
  const points: { lat: number; lng: number }[] = [];
  results.forEach((r, i) => {
    const seg = r && r.length >= 2 ? r : chunks[i].map((p) => ({ lat: p.lat, lng: p.lng }));
    if (!r || r.length < 2) degraded = true;
    points.push(...(points.length ? seg.slice(1) : seg));
  });
  if (rest.length > 1) points.push(...rest.slice(1).map((p) => ({ lat: p.lat, lng: p.lng })));
  return { points, degraded };
}
