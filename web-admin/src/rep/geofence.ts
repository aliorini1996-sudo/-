// ============================================================================
// «البيع داخل نطاق العميل» — منطق القرار الجغرافي، صرفٌ بلا DOM ولا شبكة.
//
// وحدةٌ مستقلّة عمداً (كنمط visitTimer.ts): القرار الذي يمنع مندوباً من العمل
// يجب أن يكون قابلاً للاختبار وحده، لا مدفوناً في مكوّن React.
//
// الخادم يملك haversineM في services/routeShape.ts، لكن التطبيقين مشروعان
// منفصلان بلا حزمة مشتركة، فهذه نسخة الواجهة.
// ============================================================================

/** نصف قطر النطاق بالأمتار.
 *  اختير ٥٠ لا ٣٠: قياس الجوّال يأتي بهامش خطأ يبلغ عشرات الأمتار داخل سوق
 *  مغطّى أو بين مبانٍ، وعتبةٌ أضيق كانت ستمنع مندوباً صادقاً على باب المحلّ. */
export const GEOFENCE_RADIUS_M = 50;

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
 */
export function judgeProximity(
  enforced: boolean,
  customer: { lat?: number | null; lng?: number | null } | null | undefined,
  rep: LatLng | null
): GeoVerdict {
  if (enforced !== true) return PASS;

  const cLat = customer?.lat;
  const cLng = customer?.lng;
  // `typeof === 'number'` لا `!cLat`: خط الاستواء وخط غرينتش إحداثيّتان صالحتان
  // وقيمتهما صفر، فالفحص الساذج يمنع عميلاً موقعه سليم.
  if (typeof cLat !== 'number' || typeof cLng !== 'number' || Number.isNaN(cLat) || Number.isNaN(cLng)) {
    return { allowed: false, reason: 'no_customer_pin', distanceM: null };
  }
  if (!rep) return { allowed: false, reason: 'no_fix', distanceM: null };

  const d = distanceM(rep, { lat: cLat, lng: cLng });
  return d <= GEOFENCE_RADIUS_M
    ? { allowed: true, reason: 'ok', distanceM: d }
    : { allowed: false, reason: 'too_far', distanceM: d };
}
