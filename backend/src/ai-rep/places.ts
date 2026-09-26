/**
 * المندوب الذكي — محوّل Google Places API (New): البحث القريب.
 *
 * شروط Google (تصميم محافظ):
 *   - الاسم والعنوان يمرّان إلى جهاز المندوب للعرض **ولا يُخزَّنان** في قاعدتنا.
 *   - place_id وحده يُخزَّن بلا حدّ (مسموح)، والإحداثيات لا تُخزَّن إلا من GPS المندوب نفسه.
 *   - يُعرض مع النتائج نسبُ «Google Maps» في الواجهة.
 * المفتاح في متغير البيئة GOOGLE_PLACES_API_KEY (مفتاح خادم مقيّد بـPlaces API (New)).
 */

export interface NearbyPlace {
  placeId: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  primaryType: string | null;
  types: string[];
}

export type NearbyResult =
  | { ok: true; places: NearbyPlace[] }
  | { ok: false; code: 'PLACES_NOT_CONFIGURED' | 'PLACES_AUTH' | 'PLACES_QUOTA' | 'PLACES_BAD_REQUEST' | 'PLACES_UNAVAILABLE'; message: string };

export const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:searchNearby';
// حقول Pro فقط (الاسم والعنوان المختصر والموقع والنوع والحالة) — لا تقييمات ولا هواتف (Enterprise أغلى)
export const PLACES_FIELD_MASK = 'places.id,places.displayName,places.shortFormattedAddress,places.location,places.primaryType,places.types,places.businessStatus';

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function placesApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const k = (env.GOOGLE_PLACES_API_KEY || '').trim();
  return k || null;
}

export async function searchNearby(opts: {
  apiKey: string | null;
  lat: number;
  lng: number;
  radiusM: number;
  includedTypes: string[];
  regionCode?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<NearbyResult> {
  if (!opts.apiKey) return { ok: false, code: 'PLACES_NOT_CONFIGURED', message: 'مفتاح خرائط Google لم يُضبط بعد — تواصل مع مزوّد الخدمة' };
  const f: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await f(PLACES_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': opts.apiKey,
        'X-Goog-FieldMask': PLACES_FIELD_MASK,
      },
      body: JSON.stringify({
        includedTypes: opts.includedTypes.slice(0, 50),
        maxResultCount: 20,
        rankPreference: 'DISTANCE',
        languageCode: 'ar',
        regionCode: (opts.regionCode || 'SA').toUpperCase(),
        locationRestriction: { circle: { center: { latitude: opts.lat, longitude: opts.lng }, radius: Math.min(50000, Math.max(100, opts.radiusM)) } },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) return { ok: false, code: 'PLACES_AUTH', message: 'مفتاح خرائط Google مرفوض أو غير مفعّل لخدمة الأماكن' };
      if (res.status === 429) return { ok: false, code: 'PLACES_QUOTA', message: 'بلغ البحث عن المحلات حدّه المسموح مؤقتاً — حاول بعد قليل' };
      if (res.status === 400) return { ok: false, code: 'PLACES_BAD_REQUEST', message: 'طلب بحث غير صالح' };
      return { ok: false, code: 'PLACES_UNAVAILABLE', message: 'خدمة الأماكن غير متاحة مؤقتاً' };
    }
    const body = (await res.json()) as { places?: Array<Record<string, unknown>> };
    return { ok: true, places: parsePlaces(body.places ?? []) };
  } catch {
    return { ok: false, code: 'PLACES_UNAVAILABLE', message: 'تعذّر الوصول لخدمة الأماكن — تحقّق من الاتصال' };
  } finally {
    clearTimeout(timer);
  }
}

/** تحويل ردّ Google إلى شكلنا — يُسقط المغلق وما لا موقع له. */
export function parsePlaces(raw: Array<Record<string, unknown>>): NearbyPlace[] {
  const out: NearbyPlace[] = [];
  for (const p of raw) {
    const status = typeof p.businessStatus === 'string' ? p.businessStatus : 'OPERATIONAL';
    if (status === 'CLOSED_PERMANENTLY' || status === 'CLOSED_TEMPORARILY') continue;
    const loc = p.location as { latitude?: number; longitude?: number } | undefined;
    const id = typeof p.id === 'string' ? p.id : null;
    if (!id || typeof loc?.latitude !== 'number' || typeof loc?.longitude !== 'number') continue;
    const dn = p.displayName as { text?: string } | undefined;
    out.push({
      placeId: id,
      name: (dn?.text || '').trim() || 'محل بلا اسم',
      address: typeof p.shortFormattedAddress === 'string' ? p.shortFormattedAddress : null,
      lat: loc.latitude,
      lng: loc.longitude,
      primaryType: typeof p.primaryType === 'string' ? p.primaryType : null,
      types: Array.isArray(p.types) ? (p.types as unknown[]).filter((t): t is string => typeof t === 'string') : [],
    });
  }
  return out;
}
