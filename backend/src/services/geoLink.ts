/**
 * استخراج إحداثيات (lat,lng) من رابط موقع أو نصّ يلصقه المندوب.
 * يدعم روابط خرائط Google المباشرة (تحوي الإحداثيات) والمختصرة (تتبع التحويل)،
 * وكذلك لصق «lat,lng» مباشرة. يرجع null بأمان عند التعذّر (الميزة اختيارية).
 *
 * الجلب من الخادم محروس (SSRF): لا عنوان داخلي (loopback/خاص/link-local/بيانات السحابة) في أي تحويلة، وجسم الرد
 * يُقرأ حتى ٢ م.ب ثم يُقطع، ومهلة كلية للتحويلات كلها — ومسارات المستخدمين تجلب روابط Google وحدها (googleOnly).
 */
import { lookup } from 'dns/promises';
import { isIP } from 'net';

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
  // (أفسد «تنظيف نصوص المنصة» aa0c3be هذا النمط فلم يُقرأ لصق «lat,lng» منذئذ — مختبَر الآن)
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
 * استخراج نقطة المكان الدقيقة من بيانات خرائط Google. نفضّل هندسة المكان
 * `[null,null,[lat,lng]]` ثم مركز الخريطة القانوني `/@lat,lng` ثم `!3d!4d` —
 * كلها أدقّ من حدود العرض (viewport) التي تظهر في مقدّمة الاستجابة.
 */
function coordsFromGoogleData(text: string): LatLng | null {
  if (!text) return null;
  const m = text.match(/\[null,null,\[(-?\d{1,3}\.\d{4,}),(-?\d{1,3}\.\d{4,})\]/)
    || text.match(/\/@(-?\d{1,3}\.\d{4,}),(-?\d{1,3}\.\d{4,})/)
    || text.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  return m ? valid(parseFloat(m[1]), parseFloat(m[2])) : null;
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
/** أقصى ما يُقرأ من جسم صفحة (صفحة مكانٍ في خرائط Google أقلّ من ذلك بكثير). */
export const MAX_BODY_BYTES = 2_000_000;
/** مهلة كلية لحلّ رابط واحد بكل تحويلاته. */
export const RESOLVE_TOTAL_MS = 15_000;

/** هل العنوان عامّ؟ لا loopback ولا شبكة خاصة ولا link-local (ومنه بيانات السحابة 169.254.169.254) ولا متعدّد البثّ. */
export function isPublicIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    return true;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]);
    if (s === '::' || s === '::1') return false;
    return !/^(fe[89ab]|fc|fd|ff)/.test(s);
  }
  return false;
}

/** المضيف يُحلّ إلى عناوين عامة وحدها (يُفحص قبل كل تحويلة). */
async function publicHost(u: string): Promise<boolean> {
  try {
    const host = new URL(u).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) return isPublicIp(host);
    const addrs = await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every(a => isPublicIp(a.address));
  } catch { return false; }
}

/** جسم الرد حتى الحدّ ثم يُقطع (لا r.text() على جسمٍ يتدفّق بلا نهاية). */
async function readCapped(r: Response, max = MAX_BODY_BYTES): Promise<string> {
  const reader = r.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.byteLength;
      if (size >= max) { await reader.cancel().catch(() => undefined); break; }
    }
  } catch { /* جسم مقطوع: ما وصل يكفي */ }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).subarray(0, max).toString('utf8');
}

// جلب مع مهلة نظيفة (AbortSignal.timeout جديد لكل طلب — بلا إعادة استخدام متحكّم)، ولمضيفٍ عامّ وحده
async function fetchMaps(u: string, ms = 8000): Promise<Response | null> {
  if (ms < 500 || !(await publicHost(u))) return null;
  try {
    return await fetch(u, {
      method: 'GET',
      redirect: 'manual',
      // Cookie=CONSENT يتخطّى صفحة موافقة Google في أوروبا (Render فرانكفورت)
      headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': 'CONSENT=YES+', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(ms),
    });
  } catch { return null; }
}

/** نطاقات خرائط Google (للمسارات التي لا تجلب إلا روابط Google في كل تحويلة). */
export function isGoogleMapsUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return /^(maps\.app\.goo\.gl|goo\.gl|maps\.google\.(com|[a-z]{2}|com?\.[a-z]{2})|(www\.)?google\.(com|[a-z]{2}|com?\.[a-z]{2}))$/.test(url.hostname.toLowerCase());
  } catch { return false; }
}

export async function resolveLocationUrl(input: string, opts: { googleOnly?: boolean } = {}): Promise<LatLng | null> {
  if (!input) return null;

  // محاولة مباشرة أولاً
  const direct = parseCoords(input);
  if (direct) return direct;

  const s = input.trim();
  if (!/^https?:\/\//i.test(s)) return null; // ليس رابطاً

  let cur = s;
  let placeName: string | null = null;
  const deadline = Date.now() + RESOLVE_TOTAL_MS;
  const left = () => Math.min(8000, deadline - Date.now());
  // روابط maps.app.goo.gl قد تمرّ بـ4 تحويلات قبل صفحة الخرائط — نسمح بعدد كافٍ
  for (let hop = 0; hop < 6; hop++) {
    if (opts.googleOnly && !isGoogleMapsUrl(cur)) break; // لا يتبع تحويلةً خارج Google
    const r = await fetchMaps(cur, left());
    if (!r) break;

    const fromUrl = parseCoords(cur);
    if (fromUrl) return fromUrl;
    // التقط اسم المكان من q= (لترميزه جغرافياً كخطة بديلة إن لزم)
    const qm = cur.match(/[?&](?:q|query)=([^&]+)/i);
    if (qm) {
      const q = decodeURIComponent(qm[1].replace(/\+/g, ' ')).trim();
      if (q && !/^-?\d+(\.\d+)?\s*[,،]/.test(q)) placeName = q; // ليس إحداثيات
    }

    // تحويل: تابع الوجهة
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) {
      cur = loc.startsWith('http') ? loc : new URL(loc, cur).toString();
      continue;
    }

    // صفحة نهائية: صفحة المكان تُحمّل إحداثياتها عبر JS فلا تظهر في HTML؛ لكن رابط
    // المعاينة الداخلي /maps/preview/place يعيد بيانات المكان (وفيها نقطته الدقيقة) كنصّ
    const body = await readCapped(r);
    let coords = coordsFromGoogleData(body);
    if (!coords) {
      const prevHref = (body.match(/\/maps\/preview\/place\?[^"']+/) || [])[0];
      if (prevHref) {
        const pr = await fetchMaps('https://www.google.com' + prevHref.replace(/&amp;/g, '&'), left());
        if (pr) coords = coordsFromGoogleData(await readCapped(pr));
      }
    }
    if (coords) return coords;
    break;
  }

  // خطة بديلة أخيرة: رمّز اسم المكان جغرافياً (تقريبيّ لكن أفضل من لا شيء)
  return placeName ? geocodePlace(placeName) : null;
}
