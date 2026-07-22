/**
 * استخراج إحداثيات (lat,lng) من رابط موقع أو نصّ يلصقه المندوب.
 * يدعم روابط خرائط Google المباشرة (تحوي الإحداثيات) والمختصرة (تتبع التحويل)،
 * وكذلك لصق «lat,lng» مباشرة. يرجع null بأمان عند التعذّر (الميزة اختيارية).
 */

export interface LatLng { lat: number; lng: number }

function valid(lat: number, lng: number): LatLng | null {
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return { lat, lng };
  }
  return null;
}

/** يحاول استخراج الإحداثيات من نصّ/رابط بلا أي طلب شبكة */
export function parseCoords(input: string): LatLng | null {
  if (!input) return null;
  const s = input.trim();

  // 1) لصق مباشر: "24.7136, 46.6753" أو "24.7136،46.6753"
  const plain = s.match(/^(-?\d{1,3}(?:\.\d+)?)\s*[,،]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (plain) { const r = valid(parseFloat(plain[1]), parseFloat(plain[2])); if (r) return r; }

  // 2) روابط Google: ...@lat,lng,zoom  |  ?q=lat,lng  |  ?ll=lat,lng  |  &destination=lat,lng
  const at = s.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (at) { const r = valid(parseFloat(at[1]), parseFloat(at[2])); if (r) return r; }

  const q = s.match(/[?&](?:q|ll|query|destination|center|sll)=(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/i);
  if (q) { const r = valid(parseFloat(q[1]), parseFloat(q[2])); if (r) return r; }

  // 3) الصيغة الداخلية !3dLAT!4dLNG (تظهر في بعض روابط place)
  const bang = s.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (bang) { const r = valid(parseFloat(bang[1]), parseFloat(bang[2])); if (r) return r; }

  return null;
}

/**
 * ترميز جغرافي لاسم مكان عبر Geoapify — خطة بديلة عندما يتعذّر استخراج الإحداثيات من
 * الرابط نفسه (مثلاً صفحة موافقة Google في أوروبا لا تُظهر الإحداثيات).
 */
async function geocodePlace(query: string): Promise<LatLng | null> {
  const key = (process.env.GEOAPIFY_API_KEY || '').trim();
  if (!key || !query) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const resp = await fetch(`https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(query)}&limit=1&apiKey=${encodeURIComponent(key)}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const j = await resp.json() as { features?: { geometry?: { coordinates?: unknown } }[] };
    const c = j.features?.[0]?.geometry?.coordinates;
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') return valid(c[1], c[0]);
  } catch { /* */ }
  return null;
}

/**
 * يحلّ رابط موقع إلى إحداثيات. يتبع تحويلات الروابط المختصرة (maps.app.goo.gl...)، ويستخرج
 * الإحداثيات من الروابط أو جسم صفحة الخرائط. عند التعذّر (صفحة موافقة أوروبا مثلاً) يرمّز
 * اسم المكان جغرافياً عبر Geoapify. أفضل جهد، يرجع null عند الفشل.
 */
export async function resolveLocationUrl(input: string): Promise<LatLng | null> {
  if (!input) return null;

  // محاولة مباشرة أولاً
  const direct = parseCoords(input);
  if (direct) return direct;

  const s = input.trim();
  if (!/^https?:\/\//i.test(s)) return null; // ليس رابطاً

  let url = s;
  let placeName: string | null = null;
  try {
    // روابط maps.app.goo.gl قد تمرّ بـ4 تحويلات قبل صفحة الخرائط — نسمح بعدد كافٍ
    for (let hop = 0; hop < 6; hop++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      // Cookie=CONSENT يتخطّى صفحة موافقة Google في أوروبا (Render فرانكفورت) فتظهر الإحداثيات
      const resp = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': 'CONSENT=YES+', 'Accept-Language': 'en' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      const fromUrl = parseCoords(url);
      if (fromUrl) return fromUrl;
      // التقط اسم المكان من q= (لترميزه جغرافياً كخطة بديلة إن لزم)
      const qm = url.match(/[?&](?:q|query)=([^&]+)/i);
      if (qm) {
        const q = decodeURIComponent(qm[1].replace(/\+/g, ' ')).trim();
        if (q && !/^-?\d+(\.\d+)?\s*[,،]/.test(q)) placeName = q; // ليس إحداثيات
      }

      // تحويل: تابع الوجهة
      const loc = resp.headers.get('location');
      if (resp.status >= 300 && resp.status < 400 && loc) {
        const hit = parseCoords(loc);
        if (hit) return hit;
        url = loc.startsWith('http') ? loc : new URL(loc, url).toString();
        continue;
      }

      // صفحة نهائية: ابحث في جسمها عن الإحداثيات
      const body = await resp.text().catch(() => '');
      const fromBody = parseCoords(body);
      if (fromBody) return fromBody;
      break;
    }
  } catch { /* نتابع للخطة البديلة */ }

  // خطة بديلة: رمّز اسم المكان جغرافياً (يعمل حتى عند حجب Google للإحداثيات)
  return placeName ? geocodePlace(placeName) : null;
}
