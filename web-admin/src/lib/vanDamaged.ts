/**
 * «المرتجع التالف» في سيارة المندوب — مرآة backend/src/services/vanDamaged.ts (اختبارٌ في الخادم يثبّت تطابق اللحظة):
 * كل مرتجعٍ سببه «بضاعة تالفة» سُجّل منذ هذه اللحظة يدخل السيارة رصيداً تالفاً لا يُباع، مهما كانت «يعود للمخزون» — فلا
 * يُعرض له مبدّل العودة للمخزون. وما قبلها حسابه كما كان (قرار المالك: «من اليوم فصاعداً»).
 */
export const DAMAGED_VAN_SINCE = new Date('2026-10-15T10:45:00.000Z');

export const isDamagedVanReturn = (inv: { returnReason?: string | null; createdAt?: string | Date | null }) =>
  inv.returnReason === 'DAMAGED' && !!inv.createdAt && new Date(inv.createdAt).getTime() >= DAMAGED_VAN_SINCE.getTime();
