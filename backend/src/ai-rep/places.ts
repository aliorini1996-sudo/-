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

// ───────────── تفاصيل محلٍّ ضغطه المندوب على الخريطة ─────────────

/** حقول Essentials/Pro فقط: النوع والموقع والاسم للعرض والحالة. */
export const PLACE_DETAILS_FIELD_MASK = 'id,displayName,location,primaryType,types,businessStatus';

/** معرّف مكان Google (كما يأتي من ضغطة على محلٍّ في Maps JavaScript API). */
export const isGooglePlaceId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{10,300}$/.test(s);

type GetFetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type PlaceDetailsResult =
  | { ok: true; place: NearbyPlace; closed: boolean }
  | { ok: false; code: 'PLACES_NOT_CONFIGURED' | 'PLACES_AUTH' | 'PLACES_QUOTA' | 'PLACES_NOT_FOUND' | 'PLACES_UNAVAILABLE'; message: string };

export async function placeDetails(opts: { apiKey: string | null; placeId: string; fetchImpl?: GetFetchLike; timeoutMs?: number }): Promise<PlaceDetailsResult> {
  if (!opts.apiKey) return { ok: false, code: 'PLACES_NOT_CONFIGURED', message: 'مفتاح خرائط Google لم يُضبط بعد — تواصل مع مزوّد الخدمة' };
  if (!isGooglePlaceId(opts.placeId)) return { ok: false, code: 'PLACES_NOT_FOUND', message: 'محل غير معروف' };
  const f: GetFetchLike = opts.fetchImpl ?? (fetch as unknown as GetFetchLike);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await f(`https://places.googleapis.com/v1/places/${encodeURIComponent(opts.placeId)}?languageCode=ar`, {
      method: 'GET',
      headers: { 'X-Goog-Api-Key': opts.apiKey, 'X-Goog-FieldMask': PLACE_DETAILS_FIELD_MASK },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) return { ok: false, code: 'PLACES_AUTH', message: 'مفتاح خرائط Google مرفوض أو غير مفعّل لخدمة الأماكن' };
      if (res.status === 429) return { ok: false, code: 'PLACES_QUOTA', message: 'بلغت خدمة الأماكن حدّها مؤقتاً — حاول بعد قليل' };
      if (res.status === 404 || res.status === 400) return { ok: false, code: 'PLACES_NOT_FOUND', message: 'تعذّر العثور على هذا المحل في خرائط Google' };
      return { ok: false, code: 'PLACES_UNAVAILABLE', message: 'خدمة الأماكن غير متاحة مؤقتاً' };
    }
    const raw = (await res.json()) as Record<string, unknown>;
    const status = typeof raw.businessStatus === 'string' ? raw.businessStatus : 'OPERATIONAL';
    const parsed = parsePlaces([{ ...raw, businessStatus: 'OPERATIONAL' }])[0];
    if (!parsed) return { ok: false, code: 'PLACES_NOT_FOUND', message: 'تعذّر العثور على هذا المحل في خرائط Google' };
    return { ok: true, place: parsed, closed: status === 'CLOSED_PERMANENTLY' || status === 'CLOSED_TEMPORARILY' };
  } catch {
    return { ok: false, code: 'PLACES_UNAVAILABLE', message: 'تعذّر الوصول لخدمة الأماكن — تحقّق من الاتصال' };
  } finally {
    clearTimeout(timer);
  }
}

// ───────────── ملف المحل في خرائط Google (للدراسة) ─────────────

/** حقول الدراسة (طلب واحد بفئة Enterprise + Atmosphere): المراجعات النصية والتقييم وساعات العمل — بلا صور. */
export const PLACE_PROFILE_FIELD_MASK =
  'id,displayName,primaryType,primaryTypeDisplayName,types,businessStatus,formattedAddress,location,googleMapsUri,rating,userRatingCount,regularOpeningHours,priceLevel,reviews';

export interface PlaceReview {
  rating: number | null;
  /** النص بلغته الأصلية (لا الترجمة الآلية) */
  text: string;
  when: string | null;
  publishTime: string | null;
  author: string | null;
  authorUri: string | null;
}

export interface PlaceProfile {
  placeId: string;
  name: string;
  typeLabel: string | null;
  primaryType: string | null;
  types: string[];
  address: string | null;
  lat: number;
  lng: number;
  mapsUri: string | null;
  rating: number | null;
  ratingCount: number;
  openNow: boolean | null;
  hours: string[];
  priceLevel: string | null;
  reviews: PlaceReview[];
  closed: boolean;
}

export type PlaceProfileResult =
  | { ok: true; profile: PlaceProfile }
  | { ok: false; code: 'PLACES_NOT_CONFIGURED' | 'PLACES_AUTH' | 'PLACES_QUOTA' | 'PLACES_NOT_FOUND' | 'PLACES_UNAVAILABLE'; message: string };

const str = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x.trim() : null);
const textOf = (x: unknown): string | null => str((x as { text?: unknown } | null | undefined)?.text);

/** ردّ Google ← ملف المحل (صرف، مختبَر). */
export function parsePlaceProfile(raw: Record<string, unknown>): PlaceProfile | null {
  const id = str(raw.id);
  const loc = raw.location as { latitude?: number; longitude?: number } | undefined;
  if (!id || typeof loc?.latitude !== 'number' || typeof loc?.longitude !== 'number') return null;
  const status = str(raw.businessStatus) ?? 'OPERATIONAL';
  const oh = raw.regularOpeningHours as { openNow?: boolean; weekdayDescriptions?: unknown[] } | undefined;
  const reviews: PlaceReview[] = (Array.isArray(raw.reviews) ? raw.reviews : []).map(r => {
    const rv = r as Record<string, unknown>;
    const author = rv.authorAttribution as { displayName?: unknown; uri?: unknown } | undefined;
    return {
      rating: typeof rv.rating === 'number' ? rv.rating : null,
      text: (textOf(rv.originalText) ?? textOf(rv.text) ?? '').slice(0, 1500),
      when: str(rv.relativePublishTimeDescription),
      publishTime: str(rv.publishTime),
      author: str(author?.displayName),
      authorUri: str(author?.uri),
    };
  }).filter(r => r.text || r.rating != null).slice(0, 5);
  return {
    placeId: id,
    name: textOf(raw.displayName) ?? 'محل بلا اسم',
    typeLabel: textOf(raw.primaryTypeDisplayName),
    primaryType: str(raw.primaryType),
    types: Array.isArray(raw.types) ? (raw.types as unknown[]).filter((t): t is string => typeof t === 'string') : [],
    address: str(raw.formattedAddress),
    lat: loc.latitude,
    lng: loc.longitude,
    mapsUri: str(raw.googleMapsUri),
    rating: typeof raw.rating === 'number' ? raw.rating : null,
    ratingCount: typeof raw.userRatingCount === 'number' ? raw.userRatingCount : 0,
    openNow: typeof oh?.openNow === 'boolean' ? oh.openNow : null,
    hours: Array.isArray(oh?.weekdayDescriptions) ? (oh!.weekdayDescriptions as unknown[]).filter((h): h is string => typeof h === 'string').slice(0, 7) : [],
    priceLevel: str(raw.priceLevel),
    reviews,
    closed: status === 'CLOSED_PERMANENTLY' || status === 'CLOSED_TEMPORARILY',
  };
}

/** ملف المحل من Google (في الخادم وحده — المفتاح لا يغادره). لا يُخزَّن شيء منه في القاعدة. */
export async function placeProfile(opts: { apiKey: string | null; placeId: string; fetchImpl?: GetFetchLike; timeoutMs?: number }): Promise<PlaceProfileResult> {
  if (!opts.apiKey) return { ok: false, code: 'PLACES_NOT_CONFIGURED', message: 'دراسة المحل من خرائط Google تحتاج مفتاح Google للمنصّة — لم يُضبط بعد' };
  if (!isGooglePlaceId(opts.placeId)) return { ok: false, code: 'PLACES_NOT_FOUND', message: 'محل غير معروف' };
  const f: GetFetchLike = opts.fetchImpl ?? (fetch as unknown as GetFetchLike);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await f(`https://places.googleapis.com/v1/places/${encodeURIComponent(opts.placeId)}?languageCode=ar&regionCode=SA`, {
      method: 'GET',
      headers: { 'X-Goog-Api-Key': opts.apiKey, 'X-Goog-FieldMask': PLACE_PROFILE_FIELD_MASK },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) return { ok: false, code: 'PLACES_AUTH', message: 'مفتاح خرائط Google مرفوض أو غير مفعّل لخدمة الأماكن' };
      if (res.status === 429) return { ok: false, code: 'PLACES_QUOTA', message: 'بلغت خدمة الأماكن حدّها مؤقتاً — حاول بعد قليل' };
      if (res.status === 404 || res.status === 400) return { ok: false, code: 'PLACES_NOT_FOUND', message: 'تعذّر العثور على هذا المحل في خرائط Google' };
      return { ok: false, code: 'PLACES_UNAVAILABLE', message: 'خدمة الأماكن غير متاحة مؤقتاً' };
    }
    const profile = parsePlaceProfile((await res.json()) as Record<string, unknown>);
    return profile ? { ok: true, profile } : { ok: false, code: 'PLACES_NOT_FOUND', message: 'تعذّر العثور على هذا المحل في خرائط Google' };
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
