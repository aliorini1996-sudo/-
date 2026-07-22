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
 * يحلّ رابط موقع إلى إحداثيات. للروابط المختصرة (maps.app.goo.gl / goo.gl/maps / g.co)
 * يتبع التحويل مرّة/مرّتين ثم يحلّل الوجهة النهائية. أفضل جهد، يرجع null عند الفشل.
 */
export async function resolveLocationUrl(input: string): Promise<LatLng | null> {
  if (!input) return null;

  // محاولة مباشرة أولاً
  const direct = parseCoords(input);
  if (direct) return direct;

  const s = input.trim();
  if (!/^https?:\/\//i.test(s)) return null; // ليس رابطاً

  let url = s;
  try {
    // روابط maps.app.goo.gl قد تمرّ بـ4 تحويلات قبل صفحة الخرائط — نسمح بعدد كافٍ
    for (let hop = 0; hop < 6; hop++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const resp = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      // تحويل: تابع الوجهة
      const loc = resp.headers.get('location');
      if (resp.status >= 300 && resp.status < 400 && loc) {
        const hit = parseCoords(loc);
        if (hit) return hit;
        url = loc.startsWith('http') ? loc : new URL(loc, url).toString();
        continue;
      }

      // وصلنا للصفحة: حلّل الرابط النهائي، ثم ابحث في جسم الصفحة عن الإحداثيات
      const fromUrl = parseCoords(url);
      if (fromUrl) return fromUrl;
      const body = await resp.text().catch(() => '');
      return parseCoords(body);
    }
  } catch {
    return null; // مهلة/خطأ شبكة → سقوط آمن
  }
  return null;
}
