/**
 * المندوب الذكي — منطق صرف لشاشة المندوب (بلا React ولا شبكة، مختبَر).
 *   - ترتيب المسار: أقرب جار ثم تحسين 2‑opt على مسار مفتوح يبدأ من موقع المندوب.
 *   - زمن تقديري: المسافة المستقيمة × ١٫٣ (تعرّج الشوارع) بسرعة ٢٥ كم/س داخل المدن — تقدير لا وعد.
 *   - روابط الملاحة: Google Maps بمعرّف المكان (الجوال يقبل ٣ نقاط وسيطة فقط).
 */

export interface Pt { lat: number; lng: number }
export interface Stop extends Pt { placeId: string; name: string }

export function distKm(a: Pt, b: Pt): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function pathLen(origin: Pt, seq: Pt[]): number {
  let d = 0, prev = origin;
  for (const p of seq) { d += distKm(prev, p); prev = p; }
  return d;
}

/** ترتيب المحطات: أقرب جار ثم 2‑opt حتى لا يتحسّن. حتمي لنفس المدخلات. */
export function orderRoute<T extends Pt>(origin: Pt, stops: T[]): T[] {
  if (stops.length <= 1) return [...stops];
  const left = [...stops];
  const seq: T[] = [];
  let cur: Pt = origin;
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((s, i) => { const d = distKm(cur, s); if (d < bd) { bd = d; bi = i; } });
    cur = left[bi];
    seq.push(left.splice(bi, 1)[0]);
  }
  let improved = true, guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < seq.length - 1; i++) {
      for (let k = i + 1; k < seq.length; k++) {
        const cand = [...seq.slice(0, i), ...seq.slice(i, k + 1).reverse(), ...seq.slice(k + 1)];
        if (pathLen(origin, cand) + 1e-9 < pathLen(origin, seq)) { seq.splice(0, seq.length, ...cand); improved = true; }
      }
    }
  }
  return seq;
}

export const DETOUR = 1.3;
export const CITY_KMH = 25;

/** محطات مرتّبة مع المسافة التراكمية والدقائق التقديرية للوصول. */
export function routeLegs<T extends Pt>(origin: Pt, ordered: T[]): Array<T & { legKm: number; cumKm: number; etaMin: number }> {
  let prev: Pt = origin, cum = 0;
  return ordered.map(s => {
    const leg = distKm(prev, s) * DETOUR;
    cum += leg; prev = s;
    return { ...s, legKm: leg, cumKm: cum, etaMin: Math.round((cum / CITY_KMH) * 60) };
  });
}

/** رابط ملاحة لمحطة واحدة (الأدق: بمعرّف المكان). */
export function navUrl(dest: { lat: number; lng: number; placeId?: string | null }): string {
  const q = new URLSearchParams({ api: '1', destination: `${dest.lat},${dest.lng}`, travelmode: 'driving', dir_action: 'navigate' });
  if (dest.placeId) q.set('destination_place_id', dest.placeId);
  return `https://www.google.com/maps/dir/?${q.toString()}`;
}

/** رابط مسار متعدد: أول ٤ محطات (٣ وسيطة + الوجهة) — حدّ متصفح الجوال. */
export function multiStopUrl(ordered: Array<{ lat: number; lng: number; placeId?: string | null }>): string | null {
  if (!ordered.length) return null;
  const take = ordered.slice(0, 4);
  const dest = take[take.length - 1];
  const mids = take.slice(0, -1);
  const q = new URLSearchParams({ api: '1', destination: `${dest.lat},${dest.lng}`, travelmode: 'driving' });
  if (dest.placeId) q.set('destination_place_id', dest.placeId);
  if (mids.length) {
    q.set('waypoints', mids.map(m => `${m.lat},${m.lng}`).join('|'));
    const ids = mids.map(m => m.placeId || '');
    if (ids.every(Boolean)) q.set('waypoint_place_ids', ids.join('|'));
  }
  return `https://www.google.com/maps/dir/?${q.toString()}`;
}

/** مسافة للعرض بالعربية. */
export function fmtDistance(m: number): string {
  if (!Number.isFinite(m)) return '—';
  return m < 1000 ? `${Math.round(m / 10) * 10} م` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} كم`;
}

/** مدى للعرض: «٦–١٢» أو رقم واحد حين يتساوى الطرفان. */
export function fmtRange(r: { low: number; high: number } | null | undefined, fmt: (n: number) => string = n => String(n)): string {
  if (!r) return '—';
  return r.low === r.high ? fmt(r.low) : `${fmt(r.low)}–${fmt(r.high)}`;
}

export const CONFIDENCE_LABEL: Record<string, string> = { HIGH: 'ثقة عالية', MEDIUM: 'ثقة متوسطة', LOW: 'ثقة منخفضة' };

export const OUTCOMES: { kind: string; label: string }[] = [
  { kind: 'INTERESTED', label: 'مهتم' },
  { kind: 'CALL_BACK', label: 'عُد لاحقاً' },
  { kind: 'QUOTE', label: 'طلب عرض سعر' },
  { kind: 'NOT_INTERESTED', label: 'غير مهتم' },
  { kind: 'EXCLUSIVE_SUPPLIER', label: 'عنده مورّد حصري' },
  { kind: 'CLOSED', label: 'مغلق أو لم أجده' },
];

export const OUTCOME_LABEL: Record<string, string> = Object.fromEntries([...OUTCOMES, { kind: 'CONVERTED', label: 'أصبح عميلاً' }].map(o => [o.kind, o.label]));

/** أنواع المنافذ (نسخة الواجهة من backend/src/ai-rep/taxonomy.ts — الخادم يتحقّق من الرموز). */
export const OUTLET_TYPE_OPTIONS: { code: string; label: string }[] = [
  { code: 'GROCERY', label: 'بقالة / تموينات' },
  { code: 'MINIMARKET', label: 'ميني ماركت' },
  { code: 'SUPERMARKET', label: 'سوبرماركت' },
  { code: 'HYPERMARKET', label: 'هايبر ماركت' },
  { code: 'WHOLESALE', label: 'جملة' },
  { code: 'PHARMACY', label: 'صيدلية' },
  { code: 'CAFE', label: 'مقهى / كوفي' },
  { code: 'CAFETERIA', label: 'كافتيريا / بوفيه' },
  { code: 'RESTAURANT', label: 'مطعم' },
  { code: 'BAKERY', label: 'مخبز' },
  { code: 'FUEL_SHOP', label: 'متجر محطة وقود' },
];
