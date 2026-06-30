/**
 * محرّك مصادر العملاء المحتملين (Leads) — قابل للتوسّع بموصّل لكل مصدر.
 *
 * المصادر المدعومة:
 *  - osm    : OpenStreetMap (Nominatim للجيوكودنق + Overpass للأنشطة) — مجاني تماماً، بلا مفتاح، عالمي.
 *  - google : Google Places Text Search (New) — رسمي، يتطلّب GOOGLE_MAPS_API_KEY.
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
  source: 'osm' | 'google';
}

const UA = 'FieldSales-Leads/1.0 (https://fieldsa.net)';

// أوسمة Overpass الدالّة على شركات التوزيع/الجملة والأنشطة ذات المناديب الميدانيين
const OSM_TAG_FILTERS = [
  'shop=wholesale',
  'shop=trade',
  'office=company',
  'office=wholesale',
  'craft=distillery',
  'man_made=works',
  'industrial=warehouse',
  'landuse=industrial',
];

// خرائط أنواع شائعة → استعلام Overpass (نُبقيها بسيطة وواسعة)
function osmTagsFor(query: string): string[] {
  const q = query.toLowerCase();
  // كلمات دالّة على الجملة/التوزيع
  if (/whole|توزيع|جمل|distrib|موزّع|موزع|مستودع|warehouse|supply|توريد/.test(q)) {
    return ['shop=wholesale', 'shop=trade', 'office=wholesale', 'industrial=warehouse'];
  }
  if (/food|غذائ|بقال|مواد/.test(q)) {
    return ['shop=wholesale', 'shop=trade', 'shop=convenience'];
  }
  // افتراضي: كل الأوسمة الدالّة
  return OSM_TAG_FILTERS;
}

interface Bbox { south: number; west: number; north: number; east: number; cc?: string; country?: string }

// جيوكودنق الموقع (دولة/مدينة) → صندوق إحاطة عبر Nominatim (مجاني)
async function geocode(country?: string, city?: string): Promise<Bbox | null> {
  const q = [city, country].filter(Boolean).join(', ');
  if (!q) return null;
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ar,en' } });
  if (!r.ok) return null;
  const arr = (await r.json()) as Array<{
    boundingbox?: [string, string, string, string];
    address?: { country?: string; country_code?: string };
  }>;
  const hit = arr[0];
  if (!hit?.boundingbox) return null;
  const [s, n, w, e] = hit.boundingbox.map(Number); // Nominatim: [south, north, west, east]
  return {
    south: s, north: n, west: w, east: e,
    cc: hit.address?.country_code?.toUpperCase(),
    country: hit.address?.country,
  };
}

// ----------------------------- مصدر: OpenStreetMap ----------------------------- //
export async function searchOSM(query: string, country?: string, city?: string, limit = 60): Promise<RawLead[]> {
  const box = await geocode(country, city);
  if (!box) return [];
  const { south, west, north, east } = box;
  const bbox = `${south},${west},${north},${east}`;
  const tags = osmTagsFor(query);

  // بناء استعلام Overpass: عقد + طرق + علاقات لكل وسم ضمن الصندوق
  const parts = tags
    .map((t) => {
      const [k, v] = t.split('=');
      return `node["${k}"="${v}"](${bbox});way["${k}"="${v}"](${bbox});`;
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

// ----------------------------- موزّع المصادر ----------------------------- //
export type LeadProvider = 'osm' | 'google';

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
