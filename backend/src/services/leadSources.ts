/**
 * محرّك مصادر العملاء المحتملين (Leads) — قابل للتوسّع بموصّل لكل مصدر.
 *
 * المصادر المدعومة:
 *  - osm      : OpenStreetMap (Nominatim للجيوكودنق + Overpass للأنشطة) — مجاني تماماً، بلا مفتاح، عالمي.
 *  - geoapify : Geoapify Places — مجاني 3000/يوم بمفتاح بلا بطاقة وبلا موزّع، عالمي، هواتف/مواقع أنظف (مبني على OSM).
 *  - here     : HERE Discover — يتطلّب HERE_API_KEY (مفتاح بلا موزّع)، عالمي.
 *  - google   : Google Places Text Search (New) — رسمي، يتطلّب GOOGLE_MAPS_API_KEY (في السعودية عبر موزّع CNTXT).
 *
 * إضافة مصدر جديد = دالة search تُعيد RawLead[] ثم تسجيلها في SEARCH_PROVIDERS.
 *
 * ملاحظة امتثال: بيانات أعمال عامّة فقط (اسم/هاتف عمل/عنوان/موقع). لا بيانات شخصية،
 * ولا تواصل آلي — قائمة لمراجعة فريق المبيعات والتواصل المهني B2B يدوياً.
 */

export interface RawLead {
  sourceId: string; // مفتاح فريد لإزالة التكرار (مثل "osm:node/123" أو "google:ChIJ...")
  name: string;
  phone?: string;
  email?: string;
  website?: string;
  address?: string;
  city?: string;
  country?: string;
  countryCode?: string;
  category?: string;
  lat?: number;
  lng?: number;
  mapsUrl?: string;
  source: 'osm' | 'geoapify' | 'here' | 'google' | 'apollo' | 'tomtom' | 'serper' | 'linkedin';
}

function domainFromUrl(url: string): string {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

const UA = 'FieldSales-Leads/1.0 (https://fieldsa.net)';

// أوسمة Overpass الدالّة على شركات التوزيع/الجملة والأنشطة ذات المناديب الميدانيين
const OSM_TAG_FILTERS = [
  'shop=wholesale', 'shop=trade', 'shop=doityourself', 'shop=hardware',
  'office=company', 'office=wholesale', 'office=it', 'office=logistics',
  'craft=distillery', 'man_made=works', 'industrial=warehouse', 'industrial=factory',
  'building=warehouse', 'building=industrial', 'amenity=marketplace',
];

// خرائط أنواع شائعة → أوسمة Overpass (وسّعناها لجلب نتائج أوفر)
function osmTagsFor(query: string): string[] {
  const q = query.toLowerCase();
  // الجملة/التوزيع/التوريد
  if (/whole|توزيع|جمل|distrib|موزّع|موزع|مستودع|warehouse|supply|توريد|logistic|لوجست/.test(q)) {
    return ['shop=wholesale', 'shop=trade', 'office=wholesale', 'office=logistics', 'office=company',
      'industrial=warehouse', 'building=warehouse', 'amenity=marketplace'];
  }
  // مواد غذائية/بقالة
  if (/food|غذائ|بقال|مواد|drink|مشروب|بيع/.test(q)) {
    return ['shop=wholesale', 'shop=trade', 'shop=convenience', 'shop=supermarket', 'amenity=marketplace'];
  }
  // مصانع/صناعة
  if (/factor|مصنع|صناع|manufact|produc|إنتاج/.test(q)) {
    return ['man_made=works', 'industrial=factory', 'industrial=warehouse', 'building=industrial', 'office=company'];
  }
  // افتراضي: كل الأوسمة الدالّة
  return OSM_TAG_FILTERS;
}

interface Bbox { south: number; west: number; north: number; east: number; cc?: string; country?: string }

// كاش جيوكودنق (المواقع ثابتة) — يمنع تكرار طلبات Nominatim عند البحث بعدّة مصادر/أنشطة (حدّ 1/ث)
const geocodeCache = new Map<string, Bbox | null>();

// جيوكودنق الموقع (دولة/مدينة) → صندوق إحاطة عبر Nominatim (مجاني)
async function geocode(country?: string, city?: string): Promise<Bbox | null> {
  const q = [city, country].filter(Boolean).join(', ');
  if (!q) return null;
  const cacheKey = q.toLowerCase();
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey)!;

  let result: Bbox | null = null;
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ar,en' } });
  if (r.ok) {
    const arr = (await r.json()) as Array<{
      boundingbox?: [string, string, string, string];
      address?: { country?: string; country_code?: string };
    }>;
    const hit = arr[0];
    if (hit?.boundingbox) {
      const [s, n, w, e] = hit.boundingbox.map(Number); // Nominatim: [south, north, west, east]
      result = {
        south: s, north: n, west: w, east: e,
        cc: hit.address?.country_code?.toUpperCase(),
        country: hit.address?.country,
      };
    }
  }
  geocodeCache.set(cacheKey, result); // نُخزّن حتى النتيجة الفارغة لتجنّب إعادة المحاولة الفورية
  return result;
}

// ----------------------------- مصدر: OpenStreetMap ----------------------------- //
export async function searchOSM(query: string, country?: string, city?: string, limit = 60): Promise<RawLead[]> {
  const box = await geocode(country, city);
  if (!box) return [];
  const { south, west, north, east } = box;
  const bbox = `${south},${west},${north},${east}`;
  const tags = osmTagsFor(query);

  // بناء استعلام Overpass: nwr = عقد + طرق + علاقات معاً لكل وسم ضمن الصندوق (تغطية أوفر)
  const parts = tags
    .map((t) => {
      const [k, v] = t.split('=');
      return `nwr["${k}"="${v}"](${bbox});`;
    })
    .join('');
  const ql = `[out:json][timeout:50];(${parts});out center ${limit};`;

  const r = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: `data=${encodeURIComponent(ql)}`,
  });
  if (!r.ok) throw new Error(`Overpass ${r.status}`);
  const data = (await r.json()) as { elements?: OsmElement[] };

  const out: RawLead[] = [];
  for (const el of data.elements ?? []) {
    const tg = el.tags ?? {};
    const name = tg.name || tg['name:en'] || tg['name:ar'];
    if (!name) continue; // نتجاهل العناصر بلا اسم
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    const addr = [tg['addr:street'], tg['addr:city'], tg['addr:country']].filter(Boolean).join('، ');
    out.push({
      sourceId: `osm:${el.type}/${el.id}`,
      name,
      phone: tg.phone || tg['contact:phone'] || undefined,
      email: tg.email || tg['contact:email'] || undefined,
      website: tg.website || tg['contact:website'] || undefined,
      address: addr || undefined,
      city: tg['addr:city'] || city || undefined,
      country: box.country || country || undefined,
      countryCode: box.cc || undefined,
      category: tg.shop || tg.office || tg.industrial || tg.craft || 'business',
      lat, lng,
      mapsUrl: lat && lng ? `https://www.openstreetmap.org/${el.type}/${el.id}` : undefined,
      source: 'osm',
    });
  }
  return out;
}

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

// ----------------------------- مصدر: Geoapify Places ----------------------------- //
export async function searchGeoapify(query: string, country?: string, city?: string, limit = 80): Promise<RawLead[]> {
  const key = (process.env.GEOAPIFY_API_KEY || '').trim();
  if (!key) throw new Error('GEOAPIFY_API_KEY غير مضبوط — أضِفه في إعدادات الخادم لتفعيل مصدر Geoapify.');
  const box = await geocode(country, city);
  if (!box) return [];
  // Geoapify يتطلّب تصنيفاً + صندوق إحاطة (rect:lon1,lat1,lon2,lat2 = west,south,east,north)
  const url = new URL('https://api.geoapify.com/v2/places');
  url.searchParams.set('categories', geoapifyCategoriesFor(query));
  url.searchParams.set('filter', `rect:${box.west},${box.south},${box.east},${box.north}`);
  url.searchParams.set('limit', String(Math.min(limit, 200)));
  url.searchParams.set('lang', 'ar');
  url.searchParams.set('apiKey', key);

  const r = await fetch(url.toString(), { headers: { 'User-Agent': UA } });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Geoapify ${r.status}: ${t.slice(0, 160)}`);
  }
  const data = (await r.json()) as { features?: GeoapifyFeature[] };
  const out: RawLead[] = [];
  for (const f of data.features ?? []) {
    const p = f.properties;
    if (!p?.name || !p.place_id) continue;
    const raw = p.datasource?.raw || {};
    out.push({
      sourceId: `geoapify:${p.place_id}`,
      name: p.name,
      phone: p.contact?.phone || raw['contact:phone'] || raw.phone || undefined,
      email: p.contact?.email || raw['contact:email'] || raw.email || undefined,
      website: p.website || raw.website || raw['contact:website'] || undefined,
      address: p.formatted || undefined,
      city: p.city || city || undefined,
      country: p.country || box.country || country || undefined,
      countryCode: (p.country_code || box.cc || '').toUpperCase() || undefined,
      category: (p.categories || []).find((c) => c.startsWith('commercial')) || (p.categories || [])[0] || undefined,
      lat: p.lat,
      lng: p.lon,
      mapsUrl: p.lat && p.lon ? `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=18/${p.lat}/${p.lon}` : undefined,
      source: 'geoapify',
    });
  }
  return out;
}

// نُبقي التصنيف عند الأب «commercial» (يشمل المتاجر/الأسواق/الجملة) لتفادي أخطاء التصنيفات الفرعية غير الصالحة
function geoapifyCategoriesFor(_query: string): string {
  return 'commercial';
}

interface GeoapifyFeature {
  properties?: {
    name?: string;
    country?: string;
    country_code?: string;
    city?: string;
    formatted?: string;
    lat?: number;
    lon?: number;
    website?: string;
    categories?: string[];
    place_id?: string;
    contact?: { phone?: string; email?: string };
    datasource?: { raw?: Record<string, string> };
  };
}

// ----------------------------- مصدر: HERE Discover ----------------------------- //
export async function searchHERE(query: string, country?: string, city?: string, limit = 80): Promise<RawLead[]> {
  const key = (process.env.HERE_API_KEY || '').trim();
  if (!key) throw new Error('HERE_API_KEY غير مضبوط — أضِفه في إعدادات الخادم لتفعيل مصدر HERE.');
  const box = await geocode(country, city);
  if (!box) return [];
  // HERE Discover يتطلّب سياق موقع: نستخدم صندوق الإحاطة (bbox:west,south,east,north)
  const url = new URL('https://discover.search.hereapi.com/v1/discover');
  url.searchParams.set('q', query);
  url.searchParams.set('in', `bbox:${box.west},${box.south},${box.east},${box.north}`);
  url.searchParams.set('limit', String(Math.min(limit, 100)));
  url.searchParams.set('lang', 'ar');
  url.searchParams.set('apiKey', key);

  const r = await fetch(url.toString(), { headers: { 'User-Agent': UA } });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`HERE ${r.status}: ${t.slice(0, 160)}`);
  }
  const data = (await r.json()) as { items?: HereItem[] };
  const out: RawLead[] = [];
  for (const it of data.items ?? []) {
    if (!it.id || !it.title) continue;
    const c = (it.contacts || [])[0] || {};
    const pos = it.position;
    out.push({
      sourceId: `here:${it.id}`,
      name: it.title,
      phone: ((c.phone || [])[0] || {}).value || undefined,
      website: ((c.www || [])[0] || {}).value || undefined,
      email: ((c.email || [])[0] || {}).value || undefined,
      address: it.address?.label || undefined,
      city: it.address?.city || city || undefined,
      country: it.address?.countryName || box.country || country || undefined,
      countryCode: box.cc || undefined, // alpha-2 من الجيوكودنق (اتساقاً مع OSM)
      category: (it.categories || [])[0]?.name || undefined,
      lat: pos?.lat,
      lng: pos?.lng,
      mapsUrl: pos ? `https://www.google.com/maps/search/?api=1&query=${pos.lat},${pos.lng}` : undefined,
      source: 'here',
    });
  }
  return out;
}

interface HereItem {
  id?: string;
  title?: string;
  position?: { lat: number; lng: number };
  address?: { label?: string; city?: string; countryName?: string; countryCode?: string };
  categories?: Array<{ name?: string }>;
  contacts?: Array<{
    phone?: Array<{ value?: string }>;
    www?: Array<{ value?: string }>;
    email?: Array<{ value?: string }>;
  }>;
}

// ----------------------------- مصدر: Google Places (New) ----------------------------- //
export async function searchGoogle(query: string, country?: string, city?: string, limit = 20): Promise<RawLead[]> {
  const key = (process.env.GOOGLE_MAPS_API_KEY || '').trim();
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY غير مضبوط — أضِفه في إعدادات الخادم لتفعيل مصدر Google.');
  const textQuery = [query, city, country].filter(Boolean).join(' ');
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask':
        'places.id,places.displayName,places.formattedAddress,places.internationalPhoneNumber,' +
        'places.nationalPhoneNumber,places.websiteUri,places.googleMapsUri,places.primaryTypeDisplayName,' +
        'places.location,places.addressComponents',
    },
    body: JSON.stringify({ textQuery, languageCode: 'ar', maxResultCount: Math.min(limit, 20) }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Google Places ${r.status}: ${t.slice(0, 160)}`);
  }
  const data = (await r.json()) as { places?: GooglePlace[] };
  const out: RawLead[] = [];
  for (const p of data.places ?? []) {
    if (!p.id) continue;
    const cc = p.addressComponents?.find((c) => c.types?.includes('country'))?.shortText;
    const cityComp = p.addressComponents?.find((c) =>
      c.types?.includes('locality') || c.types?.includes('administrative_area_level_2'),
    )?.longText;
    out.push({
      sourceId: `google:${p.id}`,
      name: p.displayName?.text || '',
      phone: p.internationalPhoneNumber || p.nationalPhoneNumber || undefined,
      website: p.websiteUri || undefined,
      address: p.formattedAddress || undefined,
      city: cityComp || city || undefined,
      country: country || undefined,
      countryCode: cc || undefined,
      category: p.primaryTypeDisplayName?.text || undefined,
      lat: p.location?.latitude,
      lng: p.location?.longitude,
      mapsUrl: p.googleMapsUri || undefined,
      source: 'google',
    });
  }
  return out.filter((l) => l.name);
}

interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  internationalPhoneNumber?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  googleMapsUri?: string;
  primaryTypeDisplayName?: { text?: string };
  location?: { latitude?: number; longitude?: number };
  addressComponents?: Array<{ longText?: string; shortText?: string; types?: string[] }>;
}

// ----------------------------- مصدر: Apollo.io (شركات + LinkedIn) ----------------------------- //
// بحث شركات عبر واجهة Apollo الرسمية — بديل قانوني لبيانات LinkedIn (اسم/موقع/هاتف/رابط LinkedIn/قطاع).
export async function searchApollo(query: string, country?: string, city?: string, limit = 25): Promise<RawLead[]> {
  const key = (process.env.APOLLO_API_KEY || '').trim();
  if (!key) throw new Error('APOLLO_API_KEY غير مضبوط — أضِفه في إعدادات الخادم لتفعيل مصدر Apollo.');
  const location = [city, country].filter(Boolean).join(', ');
  const reqBody: Record<string, unknown> = {
    page: 1,
    per_page: Math.min(limit, 100),
    q_organization_keyword_tags: [query],
  };
  if (location) reqBody.organization_locations = [location];

  const r = await fetch('https://api.apollo.io/api/v1/mixed_companies/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': key },
    body: JSON.stringify(reqBody),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Apollo ${r.status}: ${t.slice(0, 160)}`);
  }
  const data = (await r.json()) as { organizations?: ApolloOrg[]; accounts?: ApolloOrg[] };
  const orgs = [...(data.organizations || []), ...(data.accounts || [])];
  const out: RawLead[] = [];
  const seen = new Set<string>();
  for (const o of orgs) {
    if (!o?.id || !o?.name || seen.has(o.id)) continue;
    seen.add(o.id);
    const website = o.website_url || (o.primary_domain ? `https://${o.primary_domain}` : undefined) || o.linkedin_url;
    out.push({
      sourceId: `apollo:${o.id}`,
      name: o.name,
      phone: o.primary_phone?.number || o.phone || o.sanitized_phone || undefined,
      website,
      address: [o.street_address, o.city, o.state, o.country].filter(Boolean).join('، ') || undefined,
      city: o.city || city || undefined,
      country: o.country || country || undefined,
      category: o.industry || undefined,
      mapsUrl: o.linkedin_url || undefined, // رابط LinkedIn (مرجعي)
      source: 'apollo',
    });
  }
  return out;
}

interface ApolloOrg {
  id?: string;
  name?: string;
  website_url?: string;
  primary_domain?: string;
  linkedin_url?: string;
  phone?: string;
  sanitized_phone?: string;
  primary_phone?: { number?: string };
  street_address?: string;
  city?: string;
  state?: string;
  country?: string;
  industry?: string;
}

// ----------------------------- مصدر: TomTom Search ----------------------------- //
export async function searchTomTom(query: string, country?: string, city?: string, limit = 60): Promise<RawLead[]> {
  const key = (process.env.TOMTOM_API_KEY || '').trim();
  if (!key) throw new Error('TOMTOM_API_KEY غير مضبوط — أضِفه في إعدادات الخادم لتفعيل مصدر TomTom.');
  const box = await geocode(country, city);
  const params = new URLSearchParams({ key, limit: String(Math.min(limit, 100)) });
  if (box?.cc) params.set('countrySet', box.cc);
  if (box) {
    params.set('lat', String((box.north + box.south) / 2));
    params.set('lon', String((box.east + box.west) / 2));
    params.set('radius', '200000');
  }
  const url = `https://api.tomtom.com/search/2/search/${encodeURIComponent(query)}.json?${params.toString()}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`TomTom ${r.status}: ${t.slice(0, 160)}`);
  }
  const data = (await r.json()) as { results?: TomTomResult[] };
  const out: RawLead[] = [];
  for (const it of data.results || []) {
    const poi = it.poi;
    if (!poi?.name) continue;
    const pos = it.position;
    out.push({
      sourceId: `tomtom:${it.id || poi.name}:${pos?.lat ?? ''}`,
      name: poi.name,
      phone: poi.phone || undefined,
      website: poi.url ? (poi.url.startsWith('http') ? poi.url : `https://${poi.url}`) : undefined,
      address: it.address?.freeformAddress || undefined,
      city: it.address?.municipality || city || undefined,
      country: it.address?.country || box?.country || country || undefined,
      countryCode: it.address?.countryCode || box?.cc || undefined,
      category: poi.categories?.[0] || undefined,
      lat: pos?.lat, lng: pos?.lon,
      mapsUrl: pos ? `https://www.google.com/maps/search/?api=1&query=${pos.lat},${pos.lon}` : undefined,
      source: 'tomtom',
    });
  }
  return out;
}

interface TomTomResult {
  id?: string;
  poi?: { name?: string; phone?: string; url?: string; categories?: string[] };
  address?: { freeformAddress?: string; municipality?: string; country?: string; countryCode?: string };
  position?: { lat?: number; lon?: number };
}

// ----------------------------- بحث الويب عبر Serper (Google) ----------------------------- //
async function serperSearch(q: string, gl?: string, num = 20): Promise<Array<{ title: string; link: string }>> {
  const key = (process.env.SERPER_API_KEY || '').trim();
  if (!key) throw new Error('SERPER_API_KEY غير مضبوط — أضِفه في إعدادات الخادم لتفعيل بحث الويب/LinkedIn.');
  const r = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, num, ...(gl ? { gl } : {}) }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Serper ${r.status}: ${t.slice(0, 160)}`);
  }
  const data = (await r.json()) as { organic?: Array<{ title?: string; link?: string }> };
  return (data.organic || []).filter((o) => o.title && o.link).map((o) => ({ title: o.title!, link: o.link! }));
}

const SERPER_SKIP = ['facebook.com', 'instagram.com', 'linkedin.com', 'youtube.com', 'twitter.com', 'x.com', 'tripadvisor', 'wikipedia', 'yelp.', 'pinterest', '.gov', 'google.com'];

// اكتشاف مواقع الشركات عبر نتائج Google
export async function searchSerper(query: string, country?: string, city?: string, limit = 20): Promise<RawLead[]> {
  const box = await geocode(country, city);
  const loc = [city, country].filter(Boolean).join(' ');
  const results = await serperSearch(`${query} ${loc} شركة`, box?.cc?.toLowerCase(), Math.min(limit, 20));
  const seen = new Set<string>();
  const out: RawLead[] = [];
  for (const res of results) {
    if (SERPER_SKIP.some((s) => res.link.includes(s))) continue;
    const domain = domainFromUrl(res.link);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push({
      sourceId: `serper:${domain}`,
      name: res.title.split('|')[0].split('–')[0].trim() || res.title,
      website: `https://${domain}`,
      city: city || undefined,
      country: box?.country || country || undefined,
      countryCode: box?.cc || undefined,
      category: 'business',
      source: 'serper',
    });
  }
  return out;
}

// اكتشاف صفحات شركات LinkedIn العامة عبر Google (بلا سحب من LinkedIn نفسه)
export async function searchLinkedIn(query: string, country?: string, city?: string, limit = 20): Promise<RawLead[]> {
  const box = await geocode(country, city);
  const loc = [city, country].filter(Boolean).join(' ');
  const results = await serperSearch(`site:linkedin.com/company ${query} ${loc}`, box?.cc?.toLowerCase(), Math.min(limit, 20));
  const seen = new Set<string>();
  const out: RawLead[] = [];
  for (const res of results) {
    if (!res.link.includes('linkedin.com/company')) continue;
    const slug = (res.link.match(/linkedin\.com\/company\/([^/?#]+)/) || [])[1];
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      sourceId: `linkedin:${slug}`,
      name: res.title.split('|')[0].trim() || res.title,
      city: city || undefined,
      country: box?.country || country || undefined,
      countryCode: box?.cc || undefined,
      category: 'company',
      mapsUrl: res.link.startsWith('http') ? res.link : `https://${res.link}`,
      source: 'linkedin',
    });
  }
  return out;
}

// ----------------------------- موزّع المصادر ----------------------------- //
export type LeadProvider = 'osm' | 'geoapify' | 'here' | 'google' | 'apollo' | 'tomtom' | 'serper' | 'linkedin';

// أي المصادر جاهزة (لها مفتاح مضبوط)؟ OSM لا يتطلّب مفتاحاً
export function providersReady(): Record<LeadProvider, boolean> {
  const has = (k: string) => !!(process.env[k] || '').trim();
  return {
    osm: true,
    geoapify: has('GEOAPIFY_API_KEY'),
    here: has('HERE_API_KEY'),
    google: has('GOOGLE_MAPS_API_KEY'),
    apollo: has('APOLLO_API_KEY'),
    tomtom: has('TOMTOM_API_KEY'),
    serper: has('SERPER_API_KEY'),
    linkedin: has('SERPER_API_KEY'),
  };
}

export async function runSearch(
  provider: LeadProvider,
  query: string,
  country?: string,
  city?: string,
  limit?: number,
): Promise<RawLead[]> {
  switch (provider) {
    case 'google':
      return searchGoogle(query, country, city, limit);
    case 'apollo':
      return searchApollo(query, country, city, limit);
    case 'tomtom':
      return searchTomTom(query, country, city, limit);
    case 'serper':
      return searchSerper(query, country, city, limit);
    case 'linkedin':
      return searchLinkedIn(query, country, city, limit);
    case 'geoapify':
      return searchGeoapify(query, country, city, limit);
    case 'here':
      return searchHERE(query, country, city, limit);
    case 'osm':
    default:
      return searchOSM(query, country, city, limit);
  }
}

// ----------------------------- تأهيل بـ Claude (اختياري) ----------------------------- //
// يُقيّم ملاءمة كل عميل محتمل لمنصّة Field Sales (1-10) مع سبب موجز.
export async function qualifyLeads(
  leads: Array<{ name: string; category?: string | null; city?: string | null; country?: string | null }>,
): Promise<Map<number, { score: number; note: string }>> {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  const result = new Map<number, { score: number; note: string }>();
  if (!key || leads.length === 0) return result;

  const items = leads.map((l, i) => ({ i, name: l.name, type: l.category || '', city: l.city || '', country: l.country || '' }));
  const system =
    'أنت محلّل مبيعات لمنصّة Field Sales (نظام إدارة مبيعات مناديب التوزيع الميدانيين، عالمي). ' +
    'قيّم ملاءمة كل نشاط كعميل محتمل للمنصّة: شركات التوزيع/الجملة التي لديها مناديب ميدانيون = الأعلى؛ ' +
    'التجزئة الصغيرة/غير المتعلّق = الأقل. أعِد JSON فقط: مصفوفة ' +
    '{"i":رقم,"score":1-10,"note":"سبب موجز جداً بالعربية"}.';

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 3000,
        system,
        messages: [{ role: 'user', content: 'النشاطات:\n' + JSON.stringify(items) }],
      }),
    });
    if (!r.ok) return result;
    const j = (await r.json()) as { content?: Array<{ text?: string }> };
    const text = j.content?.[0]?.text || '';
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return result;
    const arr = JSON.parse(m[0]) as Array<{ i: number; score: number; note: string }>;
    for (const x of arr) {
      if (typeof x.i === 'number') result.set(x.i, { score: Number(x.score) || 0, note: String(x.note || '') });
    }
  } catch {
    // التأهيل اختياري — نتجاهل أي خطأ بصمت
  }
  return result;
}
