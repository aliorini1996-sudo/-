/**
 * ترتيب خط السير حسب المسافة — العملاء متتابعين جغرافياً بأقصر مسارٍ تقريبيّ يمرّ بكلٍّ منهم مرّة.
 *
 * **يعتمد على مواقع العملاء وحدها** (أمر المالك): لا موقع المندوب ولا عميلٌ مثبَّت في البداية. المسار
 * مفتوح يبدأ من أحد طرفي مجموعة العملاء وينتهي في الآخر، فيمرّ المندوب بهم واحداً بعد الآخر كما يقعون.
 *
 * الطريقة: «الأقرب فالأقرب» من **كل** نقطة بداية ممكنة، ثم «2-opt» (بطرفين حرّين) يقلب أيّ مقطعٍ يتقاطع فيه
 * المسار مع نفسه، ويُختار الأقصر. المسافات خطٌّ مستقيم (haversine) لا طرق — تكفي للترتيب، وتُعرض «تقريبية».
 * واتجاه المسار (أيّ الطرفين أولاً) يتبع موضع أول عميلٍ في القائمة الحالية كي لا ينقلب الخط على المشرف بلا سبب.
 * والعميل بلا موقعٍ على الخريطة يبقى آخر القائمة بترتيبه الذي كان.
 */

export interface RoutePoint { id: string; lat?: number | null; lng?: number | null }

const hasCoord = (p: RoutePoint): p is RoutePoint & { lat: number; lng: number } =>
  typeof p.lat === 'number' && typeof p.lng === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng)
  && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && !(p.lat === 0 && p.lng === 0);

/** المسافة بالكيلومتر على سطح الأرض بين نقطتين */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** طول مسارٍ مفتوح يمرّ بالنقاط ذات الموقع بترتيبها (النقاط بلا موقع تُتخطّى) */
export function pathKm(points: RoutePoint[]): number {
  const located = points.filter(hasCoord);
  let km = 0;
  for (let i = 1; i < located.length; i++) km += haversineKm(located[i - 1], located[i]);
  return km;
}

export interface RouteOrderResult<T extends RoutePoint> {
  ordered: T[];
  /** طول المسار قبل وبعد (كم، خط مستقيم، للعملاء ذوي الموقع وحدهم) */
  beforeKm: number;
  afterKm: number;
  /** عملاء بلا موقع بقوا في آخر القائمة */
  missing: number;
  /** هل تغيّر الترتيب فعلاً */
  changed: boolean;
}

/** كم مساراً من «الأقرب فالأقرب» يُحسَّن بـ2-opt — يكفي لنتيجة ممتازة ويُبقي خطاً من مئات العملاء سريعاً */
const REFINE_CANDIDATES = 6;

/**
 * يرتّب العملاء ذوي الموقع متتابعين بأقصر مسارٍ مفتوح تقريبيّ، ويُلحق بلا-موقع آخراً.
 * دالّة نقيّة: لا تغيّر المصفوفة المُعطاة. وإن لم تُقصّر الترتيب الحاليّ تُبقيه كما هو.
 */
export function orderByDistance<T extends RoutePoint>(stops: T[]): RouteOrderResult<T> {
  const located = stops.filter((s): s is T & { lat: number; lng: number } => hasCoord(s));
  const without = stops.filter(s => !hasCoord(s));
  const beforeKm = pathKm(stops);
  const keep = (): RouteOrderResult<T> => ({ ordered: [...stops], beforeKm, afterKm: beforeKm, missing: without.length, changed: false });
  // أقل من ثلاثة بموقع: نقطتان مرتّبتان دائماً — والقائمة تبقى كما هي
  if (located.length < 3) return keep();

  const n = located.length;
  const dist: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : haversineKm(located[i], located[j]))));
  const len = (p: number[]) => { let s = 0; for (let i = 1; i < p.length; i++) s += dist[p[i - 1]][p[i]]; return s; };

  // ١) «الأقرب فالأقرب» من كل نقطة بداية
  const nn = (start: number): number[] => {
    const route = [start];
    const used = new Uint8Array(n); used[start] = 1;
    for (let step = 1; step < n; step++) {
      const last = route[route.length - 1];
      let best = -1, bestD = Infinity;
      for (let j = 0; j < n; j++) {
        if (used[j]) continue;
        // التعادل يُحسم بالترتيب الأصلي — فالنتيجة ثابتة لا تتأرجح بين ضغطتين
        if (dist[last][j] < bestD) { best = j; bestD = dist[last][j]; }
      }
      route.push(best); used[best] = 1;
    }
    return route;
  };
  const candidates = Array.from({ length: n }, (_, s) => nn(s)).sort((a, b) => len(a) - len(b)).slice(0, REFINE_CANDIDATES);

  // ٢) 2-opt على مسارٍ مفتوح بطرفين حرّين: قلب المقطع [i..k] (ومنه ما يمسّ أحد الطرفين) إن قصّر المسار
  const twoOpt = (route: number[]): number[] => {
    const p = [...route];
    let improved = true, passes = 0;
    while (improved && passes < 50) {
      improved = false; passes += 1;
      for (let i = 0; i < n - 1; i++) {
        for (let k = i + 1; k < n; k++) {
          const before = (i > 0 ? dist[p[i - 1]][p[i]] : 0) + (k < n - 1 ? dist[p[k]][p[k + 1]] : 0);
          const after = (i > 0 ? dist[p[i - 1]][p[k]] : 0) + (k < n - 1 ? dist[p[i]][p[k + 1]] : 0);
          if (after + 1e-9 < before) {
            for (let a = i, b = k; a < b; a++, b--) [p[a], p[b]] = [p[b], p[a]];
            improved = true;
          }
        }
      }
    }
    return p;
  };
  let best = candidates.map(twoOpt).reduce((a, b) => (len(b) < len(a) ? b : a));

  // ٣) الاتجاه: يبدأ المسار من الطرف الأقرب إلى أول عميلٍ في القائمة الحالية (المسار نفسه بالطول نفسه)
  const anchor = 0; // أول عميلٍ ذي موقع بترتيب القائمة
  if (dist[anchor][best[best.length - 1]] < dist[anchor][best[0]]) best = [...best].reverse();

  const ordered = [...best.map(i => located[i]), ...without];
  const afterKm = pathKm(ordered);
  // الطريقة تقريبية: إن لم تُقصِّر ترتيباً وضعه المشرف بيده فترتيبه أولى — لا نغيّر ما لا نحسّنه
  if (afterKm >= beforeKm - 1e-9) return keep();
  return { ordered, beforeKm, afterKm, missing: without.length, changed: !sameOrder(ordered, stops) };
}

function sameOrder(a: RoutePoint[], b: RoutePoint[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i].id);
}
