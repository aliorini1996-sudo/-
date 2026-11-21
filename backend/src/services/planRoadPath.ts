import crypto from 'crypto';
import { routeThrough, GeoPoint } from './mapMatch';
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
  route: (wps: GeoPoint[], cacheKey?: string) => Promise<{ lat: number; lng: number }[] | null> = routeThrough,
): Promise<PlanRoadPath | null> {
  const pts = stops.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (pts.length < 2) return null;
  const routed = pts.slice(0, MAX_PLAN_STOPS);
  const rest = pts.slice(MAX_PLAN_STOPS - 1); // المحطّات بعد السقف: مستقيمة من آخر محطّةٍ موجَّهة
  const chunks = chunkWaypoints(routed);
  const results = await Promise.all(chunks.map((c) => route(c, keyOf(keyPrefix, c)).catch(() => null)));
  let degraded = rest.length > 1;
  const points: { lat: number; lng: number }[] = [];
  results.forEach((r, i) => {
    const seg = r && r.length >= 2 ? r : chunks[i].map((p) => ({ lat: p.lat, lng: p.lng }));
    if (!r || r.length < 2) degraded = true;
    points.push(...(points.length ? seg.slice(1) : seg));
  });
  if (rest.length > 1) points.push(...rest.slice(1).map((p) => ({ lat: p.lat, lng: p.lng })));
  return { points, degraded };
}
