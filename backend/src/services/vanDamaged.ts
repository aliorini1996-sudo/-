/**
 * «المرتجع التالف» في سيارة المندوب (طلب المالك ١٥ أكتوبر ٢٠٢٦): كل مرتجعٍ سببه «بضاعة تالفة» يدخل السيارة رصيداً تالفاً
 * لا يُباع — مهما كانت returnToStock أو سياسة الصنف القديمة (damagedReturnToStock) — حتى تزيله الإدارة (DAMAGED_OUT).
 * الطيّ في routes/vanStock.ts (foldStock)، والوسم في التقارير وصفحة الفواتير من هنا.
 *
 * «من اليوم فصاعداً» (قرار المالك): قبل هذه اللحظة لم يكن التالف يدخل السيارة إلا قابلاً للبيع، والقديم غالباً تُخلّص منه
 * فعلاً — فلا يظهر رصيداً وهمياً بأثرٍ رجعي ويبقى حسابه كما كان. يُقاس بلحظة تسجيل المرتجع في الخادم (createdAt): مرتجعٌ
 * أوف-لاين يُرفع بعدها في السيارة الآن. ونسخته في الواجهة web-admin/src/lib/vanDamaged.ts (اختبارٌ يثبّت تطابقهما).
 */
export const DAMAGED_VAN_SINCE = new Date('2026-10-15T10:45:00.000Z');

/** مرتجعٌ تالفٌ يدخل رصيد «المرتجع التالف» (لا المتاح للبيع) */
export const isDamagedVanReturn = (inv: { returnReason?: string | null; createdAt?: Date | null }) =>
  inv.returnReason === 'DAMAGED' && !!inv.createdAt && inv.createdAt >= DAMAGED_VAN_SINCE;
