import prisma from '../config/database';

/**
 * «منع تكرار موقع العميل داخل الشركة» (طلب المالك ١٣ نوفمبر ٢٠٢٦): لا يُفتح عميلٌ (ولا يُنقل موقعه) ضمن ٣٠ متراً من موقع عميلٍ
 * آخر في الشركة نفسها — العميل نفسه لا يُكرَّر بموقعه. العميل بلا موقع لا يُطابَق، والمحذوف لا يُعدّ.
 * الاستثناءات كمنع الجوال (services/customerPhoneDup.ts phoneDupExempt): مفتاح API وإعادة رفع صندوق المندوب.
 */
export const CUSTOMER_LOCATION_EXISTS = 'CUSTOMER_LOCATION_EXISTS';
export const LOCATION_DUP_RADIUS_M = 30;

const EARTH_M = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

/** المسافة بالأمتار بين نقطتين (هافرسين) */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** إحداثيان صالحان (لا ٠،٠ — قيمة جهازٍ بلا التقاط) */
export const validPoint = (lat: unknown, lng: unknown): lat is number =>
  typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)
  && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

/**
 * أقرب عميلٍ آخر في الشركة ضمن نصف القطر، أو null. يُرشَّح في القاعدة بمربّعٍ حول النقطة (درجات العرض ثابتة، والطول مصحَّحٌ
 * بجيب تمام العرض) ثم يُقاس بالهافرسين هنا. و`exceptId` العميل نفسه عند التعديل: صفّه يُقرأ في الاستعلام ذاته — موقعه المحفوظ
 * على متر من النقطة ⇒ لم يتحرّك (صدى النموذج) فلا منع، فتكرارٌ قديم لا يمنع تعديل بياناتٍ أخرى.
 */
export async function findLocationDuplicate(tid: string, lat: unknown, lng: unknown, exceptId?: string | null,
  radiusM: number = LOCATION_DUP_RADIUS_M): Promise<{ id: string; name: string; distanceM: number } | null> {
  if (!validPoint(lat, lng)) return null;
  const p = { lat: lat as number, lng: lng as number };
  const dLat = (radiusM / EARTH_M) * (180 / Math.PI) * 1.2;
  const dLng = dLat / Math.max(0.01, Math.cos(rad(p.lat)));
  const rows = await prisma.customer.findMany({
    where: {
      tenantId: tid, status: { not: 'DELETED' },
      lat: { gte: p.lat - dLat, lte: p.lat + dLat }, lng: { gte: p.lng - dLng, lte: p.lng + dLng },
    },
    select: { id: true, name: true, lat: true, lng: true },
    take: 200,
  });
  const self = exceptId ? (rows ?? []).find((r) => r.id === exceptId) : undefined;
  if (self && validPoint(self.lat, self.lng) && distanceM(p, { lat: self.lat as number, lng: self.lng as number }) <= 1) return null;
  let best: { id: string; name: string; distanceM: number } | null = null;
  for (const r of rows ?? []) {
    if (r.id === exceptId || !validPoint(r.lat, r.lng)) continue;
    const d = distanceM(p, { lat: r.lat as number, lng: r.lng as number });
    if (d <= radiusM && (!best || d < best.distanceM)) best = { id: r.id, name: r.name, distanceM: Math.round(d) };
  }
  return best;
}

/** جسم ردّ 409 — اسم العميل الآخر لمن يراه وحده (عزل عملاء المناديب لا يُكشف به عميلٌ غير مُسنَد) */
export function locationDupBody(dup: { id: string; name: string; distanceM: number }, canSee: boolean) {
  return {
    success: false as const,
    code: CUSTOMER_LOCATION_EXISTS,
    message: canSee
      ? `يوجد عميل مسجل في نفس الموقع (على بعد ${dup.distanceM} متر): «${dup.name}»`
      : `يوجد عميل آخر مسجل في نفس الموقع (ضمن ${LOCATION_DUP_RADIUS_M} متر)`,
    ...(canSee && { existingId: dup.id, existingName: dup.name, distanceM: dup.distanceM }),
  };
}
