/**
 * خرائط Google داخل تطبيق المندوب — تحميل Maps JavaScript API مرّة واحدة، والبحث عن المحلات القريبة
 * من الجهاز (Places API (New) عبر مكتبة places). المفتاح مفتاح متصفّح مقيَّد بنطاق الموقع، يصل من الخادم
 * للمندوب المفعّل له فقط. الأسماء والعناوين تبقى على الجهاز للعرض ولا تُرسل للخادم ولا تُخزَّن.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type G = any;

let loading: Promise<G> | null = null;

export function loadGoogleMaps(key: string): Promise<G> {
  const w = window as unknown as { google?: G; __fsGmapsReady?: () => void };
  if (w.google?.maps?.importLibrary) return Promise.resolve(w.google);
  if (loading) return loading;
  loading = new Promise<G>((resolve, reject) => {
    w.__fsGmapsReady = () => resolve(w.google);
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=ar&region=SA&loading=async&callback=__fsGmapsReady`;
    s.async = true;
    s.onerror = () => { loading = null; reject(new Error('maps-load-failed')); };
    document.head.appendChild(s);
  });
  return loading;
}

export interface ClientPlace {
  placeId: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  primaryType: string | null;
  types: string[];
}

/** البحث القريب من الجهاز: حتى 20 محلاً مرتّبة بالمسافة، بلا المغلق. */
export async function searchNearbyOnDevice(g: G, q: { lat: number; lng: number; radiusM: number; includedTypes: string[] }): Promise<ClientPlace[]> {
  const { Place, SearchNearbyRankPreference } = await g.maps.importLibrary('places');
  const { places } = await Place.searchNearby({
    fields: ['id', 'displayName', 'formattedAddress', 'location', 'primaryType', 'types', 'businessStatus'],
    locationRestriction: { center: { lat: q.lat, lng: q.lng }, radius: Math.min(50000, Math.max(100, q.radiusM)) },
    includedTypes: q.includedTypes.slice(0, 50),
    maxResultCount: 20,
    rankPreference: SearchNearbyRankPreference.DISTANCE,
    language: 'ar',
    region: 'sa',
  });
  const out: ClientPlace[] = [];
  for (const p of places ?? []) {
    if (p.businessStatus === 'CLOSED_PERMANENTLY' || p.businessStatus === 'CLOSED_TEMPORARILY') continue;
    const loc = p.location;
    if (!p.id || !loc) continue;
    out.push({
      placeId: p.id,
      name: (typeof p.displayName === 'string' ? p.displayName : p.displayName?.text) || '',
      address: p.formattedAddress ?? null,
      lat: typeof loc.lat === 'function' ? loc.lat() : loc.lat,
      lng: typeof loc.lng === 'function' ? loc.lng() : loc.lng,
      primaryType: p.primaryType ?? null,
      types: Array.isArray(p.types) ? p.types : [],
    });
  }
  return out;
}
