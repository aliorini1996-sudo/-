/**
 * موصّلات مصادر صيد العملاء المحتملين (أداة lead-hunter) — مصدر واحد لكلّ الموصّلات.
 *
 * المصادر الخمسة:
 *  - osm      : OpenStreetMap/Nominatim — مجاني بلا مفتاح، عالميّ، لكنّه محكوم بسياسة طلب/ثانية.
 *  - geoapify : Geoapify Places — 3000/يوم بمفتاح بلا بطاقة (يتطلّب منطقة لأنّ بحثه بدائرة لا بنصّ حرّ).
 *  - tomtom   : TomTom Search — 2500/يوم، بحث POI بالنصّ الحرّ مع تقييد بالدولة.
 *  - serper   : بحث ويب عبر Google — لا يعطي هاتفاً/عنواناً، لكنّه يكشف مواقع شركات لا تظهر في الخرائط.
 *  - google   : Google Places (New) — الأدقّ، لكنّه يتطلّب بطاقة وغالباً موزّعاً محلّياً.
 *
 * لماذا ملفّ واحد: الموصّلات صغيرة ومتشابهة الشكل، وتوزيعها على خمسة ملفّات + ملفّ شبكة
 * يضاعف التنقّل بلا فائدة؛ ما يهمّ التوسّع هو ثبات الواجهة (RawLead + runSearch) لا عدد الملفّات.
 *
 * ملاحظة امتثال: بيانات أعمال عامّة فقط (اسم/هاتف عمل/عنوان/موقع)؛ لا مراسلة من هنا.
 */

export interface RawLead {
  name: string;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  countryCode?: string | null;
  category?: string | null;
  lat?: number | null;
  lng?: number | null;
  mapsUrl?: string | null;
  source: string; // معرّف المصدر (osm/geoapify/...)
  sourceId: string; // معرّف فريد من المصدر (يُستعمل لإزالة التكرار)
}

export type SourceId = 'osm' | 'geoapify' | 'tomtom' | 'serper' | 'google';

export interface SearchOptions {
  country?: string | null;
  city?: string | null;
  limit?: number;
}

/* ------------------------------------------------------------------ */
/* طبقة الشبكة (خاصّة بهذا الملفّ)                                      */
/* ------------------------------------------------------------------ */

const UA = 'FieldSales-Hunter/1.0 (https://fieldsa.net)';

const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

// حاجز معدّل لكلّ «مضيف منطقيّ»: Nominatim يحظر من يتجاوز طلباً/ثانية، فنؤخّر بدل أن نُحظر.
const lastHit = new Map<string, number>();
async function rateLimit(host: string, minGapMs: number): Promise<void> {
  const prev = lastHit.get(host) ?? 0;
  const wait = prev + minGapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

interface FetchJsonOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retries?: number;
}

// نعيد المحاولة على 429/5xx فقط: هذه أخطاء عابرة (ضغط/حدّ معدّل)، أمّا 4xx الأخرى فخطأ في الطلب
// وإعادتها تحرق الحصّة بلا فائدة.
async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { method = 'GET', headers = {}, body, timeoutMs = 15000, retries = 2 } = options;
  let lastErr: Error = new Error('فشل غير معروف');

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
        body,
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(500 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch((): string => '');
        throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`);
      }
      return (await res.json()) as T;
    } catch (e) {
      const err = e as Error;
      // AbortError رسالته مبهمة، فنستبدلها برسالة تقول للمشغّل ما الذي انتهى فعلاً.
      lastErr = err.name === 'AbortError' ? new Error(`مهلة (${timeoutMs}ms)`) : err;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function domainOf(website: string | null | undefined): string {
  if (!website) return '';
  try {
    const u = new URL(website.startsWith('http') ? website : `https://${website}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return String(website).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  }
}

function envKey(name: string): string {
  return (process.env[name] || '').trim();
}

function area(city?: string | null, country?: string | null, sep = ', '): string {
  return [city, country].filter((v): v is string => !!v).join(sep);
}

/* ------------------------------------------------------------------ */
/* المصدر: OpenStreetMap (Nominatim)                                    */
/* ------------------------------------------------------------------ */

// خوادم بديلة: الرسميّ يسقط أحياناً تحت الضغط، فننتقل للتالي بدل أن تفشل الجولة كلّها.
const NOMINATIM_HOSTS = ['https://nominatim.openstreetmap.org', 'https://nominatim.geocoding.ai'];

interface NominatimRow {
  name?: string;
  display_name?: string;
  lat?: string;
  lon?: string;
  type?: string;
  category?: string;
  osm_type?: string;
  osm_id?: number | string;
  place_id?: number | string;
  extratags?: Record<string, string> | null;
  address?: Record<string, string> | null;
}

async function searchOsm(query: string, opts: SearchOptions): Promise<RawLead[]> {
  const { country = null, city = null, limit = 40 } = opts;
  const region = area(city, country);
  const q = region ? `${query} ${region}` : query;
  let lastErr: Error | null = null;

  for (const host of NOMINATIM_HOSTS) {
    try {
      await rateLimit('nominatim', 1100); // ≥1 ثانية بين النداءات (سياسة الاستخدام)
      const url =
        `${host}/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&extratags=1` +
        `&limit=${Math.min(limit, 50)}`;
      const rows = await fetchJson<NominatimRow[]>(url, { timeoutMs: 20000, retries: 1 });
      if (!Array.isArray(rows)) return [];

      return rows
        .map((r: NominatimRow): RawLead => {
          const ex: Record<string, string> = r.extratags || {};
          const addr: Record<string, string> = r.address || {};
          return {
            name: ex.name || r.name || (r.display_name || '').split(',')[0],
            phone: ex.phone || ex['contact:phone'] || null,
            email: ex.email || ex['contact:email'] || null,
            website: ex.website || ex['contact:website'] || null,
            address: r.display_name || null,
            city: addr.city || addr.town || addr.village || city || null,
            country: addr.country || country || null,
            countryCode: (addr.country_code || '').toUpperCase() || null,
            category: ex.shop || ex.office || ex.amenity || r.type || r.category || null,
            lat: r.lat ? Number(r.lat) : null,
            lng: r.lon ? Number(r.lon) : null,
            mapsUrl: r.lat ? `https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lon}` : null,
            source: 'osm',
            sourceId: `osm:${r.osm_type || 'x'}/${r.osm_id || r.place_id}`,
          };
        })
        .filter((l: RawLead): boolean => !!l.name);
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw lastErr || new Error('فشل كل خوادم Nominatim');
}

/* ------------------------------------------------------------------ */
/* المصدر: Geoapify Places                                              */
/* ------------------------------------------------------------------ */

interface GeoapifyPoint {
  lon: number;
  lat: number;
}

interface GeoapifyGeocodeResponse {
  features?: Array<{ properties?: { lon?: number; lat?: number } }>;
}

interface GeoapifyPlaceProps {
  name?: string;
  phone?: string;
  website?: string;
  formatted?: string;
  city?: string;
  country?: string;
  country_code?: string;
  categories?: string[];
  lat?: number;
  lon?: number;
  place_id?: string;
  contact?: { phone?: string; email?: string };
  datasource?: { raw?: { website?: string } };
}

interface GeoapifyPlacesResponse {
  features?: Array<{ properties?: GeoapifyPlaceProps }>;
}

// الجيوكودنق ثابت لكلّ منطقة، فنخزّنه لأنّ كلّ استعلام في الجولة يعيد سؤاله بلا داعٍ.
const geocodeCache = new Map<string, GeoapifyPoint | null>();

async function geocodeArea(region: string, key: string): Promise<GeoapifyPoint | null> {
  const cached = geocodeCache.get(region);
  if (cached !== undefined) return cached;
  const url = `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(region)}&limit=1&apiKey=${key}`;
  const data = await fetchJson<GeoapifyGeocodeResponse>(url, { timeoutMs: 12000 });
  const f = data.features?.[0];
  const point: GeoapifyPoint | null =
    f && typeof f.properties?.lon === 'number' && typeof f.properties?.lat === 'number'
      ? { lon: f.properties.lon, lat: f.properties.lat }
      : null;
  geocodeCache.set(region, point);
  return point;
}

async function searchGeoapify(query: string, opts: SearchOptions): Promise<RawLead[]> {
  const { country = null, city = null, limit = 40 } = opts;
  const key = envKey('GEOAPIFY_API_KEY');
  if (!key) throw new Error('GEOAPIFY_API_KEY غير مضبوط');
  const region = area(city, country);
  // بحث Geoapify بدائرة لا بنصّ حرّ، فبلا منطقة لا مركز للدائرة أصلاً.
  if (!region) throw new Error('Geoapify يتطلب مدينة أو دولة لتحديد المنطقة');

  const point = await geocodeArea(region, key);
  if (!point) return [];
  const radius = city ? 25000 : 60000; // متر: مدينة أضيق من دولة

  const url =
    `https://api.geoapify.com/v2/places?categories=commercial` +
    `&filter=circle:${point.lon},${point.lat},${radius}` +
    `&bias=proximity:${point.lon},${point.lat}` +
    `&name=${encodeURIComponent(query)}&limit=${Math.min(limit, 100)}&apiKey=${key}`;

  const data = await fetchJson<GeoapifyPlacesResponse>(url, { timeoutMs: 15000 });
  const feats = data.features || [];

  return feats
    .map((f): RawLead => {
      const p: GeoapifyPlaceProps = f.properties || {};
      return {
        name: p.name || '',
        phone: p.contact?.phone || p.phone || null,
        email: p.contact?.email || null,
        website: p.website || p.datasource?.raw?.website || null,
        address: p.formatted || null,
        city: p.city || city || null,
        country: p.country || country || null,
        countryCode: (p.country_code || '').toUpperCase() || null,
        category: (p.categories && p.categories[0]) || null,
        lat: p.lat ?? null,
        lng: p.lon ?? null,
        mapsUrl: p.lat ? `https://www.google.com/maps?q=${p.lat},${p.lon}` : null,
        source: 'geoapify',
        sourceId: `geoapify:${p.place_id || `${p.name}:${p.lat}`}`,
      };
    })
    .filter((l: RawLead): boolean => !!l.name);
}

/* ------------------------------------------------------------------ */
/* المصدر: TomTom Search                                                */
/* ------------------------------------------------------------------ */

// أسماء الدول العربية → ISO alpha-2؛ المستخدم يكتب «السعودية» وTomTom لا يفهم إلّا countrySet=SA.
const COUNTRY_ISO: Record<string, string> = {
  'السعودية': 'SA', 'الإمارات': 'AE', 'الكويت': 'KW', 'قطر': 'QA', 'البحرين': 'BH',
  'عُمان': 'OM', 'عمان': 'OM', 'مصر': 'EG', 'الأردن': 'JO', 'المغرب': 'MA',
  'الجزائر': 'DZ', 'تونس': 'TN', 'العراق': 'IQ', 'لبنان': 'LB', 'ليبيا': 'LY',
  'السودان': 'SD', 'اليمن': 'YE', 'سوريا': 'SY', 'فلسطين': 'PS', 'موريتانيا': 'MR',
};

interface TomTomResult {
  id?: string;
  poi?: { name?: string; phone?: string; url?: string; categories?: string[] };
  address?: { freeformAddress?: string; municipality?: string; country?: string; countryCode?: string };
  position?: { lat?: number; lon?: number };
}

interface TomTomResponse {
  results?: TomTomResult[];
}

async function searchTomtom(query: string, opts: SearchOptions): Promise<RawLead[]> {
  const { country = null, city = null, limit = 40 } = opts;
  const key = envKey('TOMTOM_API_KEY');
  if (!key) throw new Error('TOMTOM_API_KEY غير مضبوط');

  const text = [query, city].filter((v): v is string => !!v).join(' ');
  const cc: string = COUNTRY_ISO[country || ''] || (country && country.length === 2 ? country.toUpperCase() : '');

  let url =
    `https://api.tomtom.com/search/2/search/${encodeURIComponent(text)}.json` +
    `?key=${key}&limit=${Math.min(limit, 100)}`;
  if (cc) url += `&countrySet=${cc}`;

  const data = await fetchJson<TomTomResponse>(url, { timeoutMs: 15000 });
  const results = data.results || [];

  return results
    .map((r: TomTomResult): RawLead => {
      const poi = r.poi || {};
      const a = r.address || {};
      return {
        name: poi.name || a.freeformAddress || '',
        phone: poi.phone || null,
        email: null,
        // TomTom يعيد الموقع أحياناً بلا بروتوكول، وبلا https يصبح الرابط غير قابل للنقر.
        website: poi.url ? (poi.url.startsWith('http') ? poi.url : `https://${poi.url}`) : null,
        address: a.freeformAddress || null,
        city: a.municipality || city || null,
        country: a.country || country || null,
        countryCode: (a.countryCode || cc || '').toUpperCase() || null,
        category: (poi.categories && poi.categories[0]) || null,
        lat: r.position?.lat ?? null,
        lng: r.position?.lon ?? null,
        mapsUrl: r.position ? `https://www.google.com/maps?q=${r.position.lat},${r.position.lon}` : null,
        source: 'tomtom',
        sourceId: `tomtom:${r.id}`,
      };
    })
    .filter((l: RawLead): boolean => !!l.name);
}

/* ------------------------------------------------------------------ */
/* المصدر: بحث الويب (Serper/Google)                                    */
/* ------------------------------------------------------------------ */

// مضيفات نستبعدها: منصّات ودلائل، لا مواقع شركات — إدخالها يملأ القائمة ضجيجاً.
const SERPER_SKIP_HOSTS = [
  'google.', 'facebook.', 'instagram.', 'linkedin.', 'youtube.', 'twitter.', 'x.com',
  'wikipedia.', 'maps.', 'yelp.', 'tripadvisor.', 'amazon.', 'pinterest.',
];

interface SerperResponse {
  organic?: Array<{ link?: string; title?: string }>;
}

async function searchSerper(query: string, opts: SearchOptions): Promise<RawLead[]> {
  const { country = null, city = null, limit = 40 } = opts;
  const key = envKey('SERPER_API_KEY');
  if (!key) throw new Error('SERPER_API_KEY غير مضبوط');

  const region = area(city, country, ' ');
  const q = region ? `${query} ${region}` : query;

  const data = await fetchJson<SerperResponse>('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, num: Math.min(limit, 40) }),
    timeoutMs: 15000,
  });

  const results = data.organic || [];
  const seen = new Set<string>();
  const out: RawLead[] = [];

  for (const r of results) {
    const link = r.link;
    if (!link) continue;
    const dom = domainOf(link);
    if (!dom || SERPER_SKIP_HOSTS.some((s: string): boolean => dom.includes(s))) continue;
    // النطاق نفسه يظهر بصفحات كثيرة في نتائج البحث؛ نأخذ الشركة مرّة واحدة.
    if (seen.has(dom)) continue;
    seen.add(dom);
    out.push({
      // عناوين نتائج البحث تُذيَّل باسم الموقع بعد | أو -، وهو ليس من اسم الشركة.
      name: (r.title || dom).replace(/\s*[|\-–—].*$/, '').trim(),
      phone: null,
      email: null,
      website: `https://${dom}`,
      address: null,
      city: city || null,
      country: country || null,
      countryCode: null,
      category: null,
      lat: null,
      lng: null,
      mapsUrl: null,
      source: 'serper',
      sourceId: `serper:${dom}`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* المصدر: Google Places (New)                                          */
/* ------------------------------------------------------------------ */

interface GoogleAddressComponent {
  types?: string[];
  longText?: string;
  shortText?: string;
}

interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  primaryType?: string;
  location?: { latitude?: number; longitude?: number };
  addressComponents?: GoogleAddressComponent[];
}

interface GooglePlacesResponse {
  places?: GooglePlace[];
}

async function searchGoogle(query: string, opts: SearchOptions): Promise<RawLead[]> {
  const { country = null, city = null, limit = 40 } = opts;
  const key = envKey('GOOGLE_MAPS_API_KEY');
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY غير مضبوط');

  const region = area(city, country);
  const textQuery = region ? `${query} في ${region}` : query;

  const data = await fetchJson<GooglePlacesResponse>('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      // FieldMask إلزاميّ هنا، وكلّ حقل زائد فيه يرفع فاتورة الطلب — نطلب ما نستعمله فقط.
      'X-Goog-FieldMask':
        'places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.websiteUri,' +
        'places.location,places.primaryType,places.id,places.addressComponents',
    },
    body: JSON.stringify({ textQuery, pageSize: Math.min(limit, 20) }),
    timeoutMs: 15000,
  });

  const places = data.places || [];

  return places
    .map((p: GooglePlace): RawLead => {
      const cc = (p.addressComponents || []).find((a: GoogleAddressComponent): boolean =>
        (a.types || []).includes('country'),
      );
      return {
        name: p.displayName?.text || '',
        phone: p.internationalPhoneNumber || null,
        email: null,
        website: p.websiteUri || null,
        address: p.formattedAddress || null,
        city: city || null,
        country: country || cc?.longText || null,
        countryCode: (cc?.shortText || '').toUpperCase() || null,
        category: p.primaryType || null,
        lat: p.location?.latitude ?? null,
        lng: p.location?.longitude ?? null,
        mapsUrl: p.id ? `https://www.google.com/maps/place/?q=place_id:${p.id}` : null,
        source: 'google',
        sourceId: `google:${p.id}`,
      };
    })
    .filter((l: RawLead): boolean => !!l.name);
}

/* ------------------------------------------------------------------ */
/* السجلّ                                                               */
/* ------------------------------------------------------------------ */

interface SourceConnector {
  label: string; // اسم العرض بالعربية
  ready: () => boolean; // هل مفتاحه مضبوط
  search: (query: string, opts: SearchOptions) => Promise<RawLead[]>;
}

// لإضافة مصدر: أضف معرّفه إلى SourceId ثمّ سطراً هنا؛ لا شيء آخر في المنظومة يحتاج تعديلاً.
const REGISTRY: Record<SourceId, SourceConnector> = {
  osm: {
    label: 'OpenStreetMap (Nominatim)',
    ready: (): boolean => true, // لا يحتاج مفتاحاً
    search: searchOsm,
  },
  geoapify: {
    label: 'Geoapify Places',
    ready: (): boolean => !!envKey('GEOAPIFY_API_KEY'),
    search: searchGeoapify,
  },
  tomtom: {
    label: 'TomTom Search',
    ready: (): boolean => !!envKey('TOMTOM_API_KEY'),
    search: searchTomtom,
  },
  serper: {
    label: 'بحث الويب (Serper/Google)',
    ready: (): boolean => !!envKey('SERPER_API_KEY'),
    search: searchSerper,
  },
  google: {
    label: 'Google Places (New)',
    ready: (): boolean => !!envKey('GOOGLE_MAPS_API_KEY'),
    search: searchGoogle,
  },
};

const SOURCE_IDS: SourceId[] = ['osm', 'geoapify', 'tomtom', 'serper', 'google'];

/** أيّ المصادر جاهزة (مفتاحها مضبوط) — تُقرأ عند كلّ نداء لأنّ البيئة قد تتغيّر بين النشرات. */
export function providersReady(): Record<SourceId, boolean> {
  const out = {} as Record<SourceId, boolean>;
  for (const id of SOURCE_IDS) out[id] = REGISTRY[id].ready();
  return out;
}

/** اسم المصدر كما يُعرض للمالك. */
export function sourceLabel(id: SourceId): string {
  return REGISTRY[id]?.label || id;
}

/** ينفّذ بحثاً على مصدر واحد. يرمي عند غياب المفتاح أو فشل الشبكة؛ المنادي يقرّر التسامح. */
export async function runSearch(id: SourceId, query: string, opts: SearchOptions): Promise<RawLead[]> {
  const connector = REGISTRY[id];
  if (!connector) throw new Error(`مصدر غير معروف: ${id}`);
  return connector.search(query, opts);
}
