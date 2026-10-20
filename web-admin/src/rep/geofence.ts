// ============================================================================
// «البيع داخل نطاق العميل» — منطق القرار الجغرافي، صرفٌ بلا DOM ولا شبكة.
//
// وحدةٌ مستقلّة عمداً (كنمط visitTimer.ts): القرار الذي يمنع مندوباً من العمل
// يجب أن يكون قابلاً للاختبار وحده، لا مدفوناً في مكوّن React.
//
// الخادم يملك haversineM في services/routeShape.ts، لكن التطبيقين مشروعان
// منفصلان بلا حزمة مشتركة، فهذه نسخة الواجهة.
// ============================================================================

/** نصف قطر النطاق الافتراضيّ بالأمتار — والإدارة تحدّد لكلّ مندوبٍ مسافته (`proximityRadiusM`، ١٠–٥٠٠٠).
 *  اختير ٥٠ لا ٣٠: قياس الجوّال يأتي بهامش خطأ يبلغ عشرات الأمتار داخل سوق
 *  مغطّى أو بين مبانٍ، وعتبةٌ أضيق كانت ستمنع مندوباً صادقاً على باب المحلّ. */
export const GEOFENCE_RADIUS_M = 50;

/** مسافة المندوب كما وصلت من الخادم — وغائبةٌ أو فاسدة تعود إلى الافتراض (لا تُسقط القيد ولا تُغلقه) */
export function radiusOf(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 10 && v <= 5000 ? v : GEOFENCE_RADIUS_M;
}

export interface LatLng { lat: number; lng: number }

/** المسافة بالأمتار بين نقطتين (هافرساين، R = نصف قطر الأرض بالأمتار). */
export function distanceM(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export type GeoReason =
  | 'ok'            // داخل النطاق — أو الصلاحية غير مفعّلة أصلاً
  | 'no_customer_pin' // العميل بلا إحداثيات مسجَّلة
  | 'too_far'       // خارج النطاق
  | 'no_fix';       // تعذّر تحديد موقع المندوب

export interface GeoVerdict {
  allowed: boolean;
  reason: GeoReason;
  /** المسافة بالأمتار حين تكون معروفة — تُعرض للمندوب فمنعٌ بلا رقم يصير مكالمة للإدارة. */
  distanceM: number | null;
  /** المسافة المسموحة التي حُكم بها — تُعرض في رسالة «اقترب» */
  radiusM?: number;
}

const PASS: GeoVerdict = { allowed: true, reason: 'ok', distanceM: null };

/**
 * حكم البوّابة.
 *
 * @param enforced   هل الصلاحية مفعّلة على هذا المندوب؟ حين تكون false يمرّ كل شيء
 *                   بلا قيد كما هو الحال اليوم — ولذلك تُقرأ بـ`=== true` لا `!== false`:
 *                   عَلَمٌ تقييديّ افتراضه «غير مقيَّد»، فغيابه يعني السماح.
 * @param customer   إحداثيات العميل المسجَّلة (قد تكون غائبة — الحقلان اختياريان).
 * @param rep        موقع المندوب اللحظي، أو null إن تعذّر التقاطه.
 * @param radiusM    المسافة التي حدّدتها الإدارة لهذا المندوب (تُصفّى بـradiusOf).
 */
export function judgeProximity(
  enforced: boolean,
  customer: { lat?: number | null; lng?: number | null } | null | undefined,
  rep: LatLng | null,
  radiusM: unknown = GEOFENCE_RADIUS_M,
): GeoVerdict {
  if (enforced !== true) return PASS;
  const radius = radiusOf(radiusM);

  const cLat = customer?.lat;
  const cLng = customer?.lng;
  // `typeof === 'number'` لا `!cLat`: خط الاستواء وخط غرينتش إحداثيّتان صالحتان
  // وقيمتهما صفر، فالفحص الساذج يمنع عميلاً موقعه سليم.
  if (typeof cLat !== 'number' || typeof cLng !== 'number' || Number.isNaN(cLat) || Number.isNaN(cLng)) {
    return { allowed: false, reason: 'no_customer_pin', distanceM: null, radiusM: radius };
  }
  if (!rep) return { allowed: false, reason: 'no_fix', distanceM: null, radiusM: radius };

  const d = distanceM(rep, { lat: cLat, lng: cLng });
  return d <= radius
    ? { allowed: true, reason: 'ok', distanceM: d, radiusM: radius }
    : { allowed: false, reason: 'too_far', distanceM: d, radiusM: radius };
}
