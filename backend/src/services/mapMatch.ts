/**
 * مطابقة المسار مع الطرق (Map Matching) — يحوّل نقاط GPS الخام (التي قد تقفز فوق
 * المباني بسبب خطأ الإشارة) إلى خطّ سير يتبع الطرق الفعلية. يعتمد Geoapify، ويرجع
 * دائماً بأمان: عند غياب المفتاح أو أي خطأ/بطء يُعيد null فيسقط النظام للنقاط الخام.
 */

export interface GeoPoint { lat: number; lng: number; accuracy?: number | null; capturedAt?: Date | string }

// كاش بسيط بالذاكرة يمنع استنزاف حصّة Geoapify عند إعادة فتح نفس المسار
const cache = new Map<string, { at: number; snapped: { lat: number; lng: number }[] }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 دقائق
const CACHE_MAX = 200;

function cacheGet(key: string) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return undefined; }
  return hit.snapped;
}
function cacheSet(key: string, snapped: { lat: number; lng: number }[]) {
  if (cache.size >= CACHE_MAX) { const first = cache.keys().next().value; if (first) cache.delete(first); }
  cache.set(key, { at: Date.now(), snapped });
}

// تخفيض كثافة النقاط إلى حدّ آمن للطلب مع الحفاظ على شكل المسار (أخذ عيّنة متساوية)
function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  const last = arr[arr.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * يُعيد خطّ سير مطابَقاً للطرق، أو null للسقوط على النقاط الخام.
 * @param cacheKey مفتاح تخزين (مثلاً salesRepId:date:count)
 */
export async function snapToRoads(points: GeoPoint[], cacheKey?: string): Promise<{ lat: number; lng: number }[] | null> {
  const key = (process.env.GEOAPIFY_API_KEY || '').trim();
  if (!key) return null;
  if (points.length < 3) return null;

  if (cacheKey) { const cached = cacheGet(cacheKey); if (cached) return cached; }

  // استبعاد النقاط ذات الدقّة السيّئة جداً (تشوّش المطابقة)، ثم تخفيف الكثافة
  const clean = points.filter(p => p.accuracy == null || p.accuracy <= 150);
  const src = downsample(clean.length >= 3 ? clean : points, 400);

  const waypoints = src.map(p => ({
    location: [p.lng, p.lat] as [number, number],
    ...(p.capturedAt ? { timestamp: new Date(p.capturedAt).toISOString() } : {}),
  }));

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(`https://api.geoapify.com/v1/mapmatching?apiKey=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'drive', waypoints }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;

    const json = await resp.json() as { features?: { geometry?: { type?: string; coordinates?: unknown } }[] };
    const geom = json.features?.[0]?.geometry;
    if (!geom || !Array.isArray(geom.coordinates)) return null;

    // النتيجة قد تكون LineString ([[lng,lat],...]) أو MultiLineString ([[[lng,lat],...],...])
    const flat: { lat: number; lng: number }[] = [];
    const pushPair = (pair: unknown) => {
      if (Array.isArray(pair) && typeof pair[0] === 'number' && typeof pair[1] === 'number') {
        flat.push({ lat: pair[1], lng: pair[0] });
      }
    };
    for (const item of geom.coordinates as unknown[]) {
      if (Array.isArray(item) && Array.isArray(item[0])) { for (const pair of item) pushPair(pair); }
      else pushPair(item);
    }
    if (flat.length < 2) return null;

    if (cacheKey) cacheSet(cacheKey, flat);
    return flat;
  } catch {
    return null; // مهلة/خطأ شبكة → سقوط آمن على الخام
  }
}
