/**
 * «أفضل المناديب» — الترتيب قبل القصّ (تدقيق دقّة التقارير، طلب المالك ١٣ نوفمبر ٢٠٢٦).
 *
 * لوحة الشركة (routes/dashboard.ts) ولوحة مالك المنصة (routes/tenants.ts) كانتا تجلبان خمسة مناديب بـ`take: 5` بلا
 * `orderBy` — أقدم الصفوف في الجدول عملياً، والموقوف معهم — ثم ترتّبان هؤلاء الخمسة وحدهم. فيغيب أعلى المناديب مبيعاً
 * عن «أفضل المناديب» متى لم يكن بين أول خمسة صفوف، ويخالف «تقييم الأداء» بمعيار المبيعات للشهر نفسه.
 *
 * الآن: المبلغ من تجميعٍ واحد في القاعدة (`invoice.groupBy` بالمندوب والنوع) لا من فواتير كل مندوب، ويُطوى هنا صافياً
 * (البيع − المرتجع، services/netSales.ts)، ثم يُرتَّب **كل** المناديب النشطين الذين مُرّروا تنازلياً بالصافي ثم بالاسم،
 * ويؤخذ أول `limit`. فالمندوب بلا مبيعات (صفر) لا يدخل القائمة إلا إن قلّ أصحاب المبيعات عن الحدّ.
 */
import { cleanMoney, isReturnInvoice, signedAmount } from './netSales';

/** صفّ `invoice.groupBy({ by: ['salesRepId', 'type'], _sum: { total }, _count: { _all } })` كما تردّه Prisma */
export interface RepTypeGroup {
  salesRepId: string | null;
  type: string | null;
  _sum: { total: unknown };
  _count?: { _all?: number | null } | null;
}

export interface TopRep { id: string; name: string; salesTotal: number; invoicesCount: number }

export const TOP_REPS_LIMIT = 5;

/**
 * يرتّب المناديب المرشّحين بصافي مبيعاتهم من صفوف التجميع ويأخذ أولهم.
 *
 * `reps` هم المرشّحون وحدهم (النشطون في نطاق المستخدم أو فريقه — يقرّرهم المستدعي)، فمندوبٌ له مستندات في التجميع وليس
 * بينهم (موقوف، أو خارج النطاق) لا يظهر. و`invoicesCount` عدد فواتير البيع وحدها كما كان (المرتجع لا يُعدّ فاتورة).
 * فاصل التعادل الأخير المعرّف: اسمان متطابقان لا يتبادلان مكانيهما بين نداءين.
 */
export function rankTopReps(
  reps: readonly { id: string; name: string }[],
  groups: readonly RepTypeGroup[],
  limit: number = TOP_REPS_LIMIT,
): TopRep[] {
  const net = new Map<string, number>();
  const count = new Map<string, number>();
  for (const g of groups) {
    if (!g.salesRepId) continue;
    net.set(g.salesRepId, (net.get(g.salesRepId) ?? 0) + signedAmount(g, g._sum?.total));
    if (!isReturnInvoice(g)) count.set(g.salesRepId, (count.get(g.salesRepId) ?? 0) + Number(g._count?._all ?? 0));
  }
  return reps
    .map((r) => ({ id: r.id, name: r.name, salesTotal: cleanMoney(net.get(r.id) ?? 0), invoicesCount: count.get(r.id) ?? 0 }))
    .sort((a, b) => b.salesTotal - a.salesTotal
      || a.name.localeCompare(b.name, 'ar')
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, limit));
}
