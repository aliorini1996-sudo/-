/**
 * «مخزون سيارتي» عند المندوب دون اتصال (مراجعة المخزون نوفمبر ٢٠٢٦، البند ١٣).
 *
 * كانت الشاشة تجلب /van-stock/current بلا ذاكرة: بلا تغطية تقول «لا توجد بضاعة في سيارتك» وتدعو لتسجيل تحميل، ومع الاتصال تعرض
 * الكمية قبل البيع ما دامت فواتيرٌ في الصندوق لم تُرفع بعد — فيَعِد المندوب عميله ببضاعةٍ خرجت فعلاً.
 *
 * الآن: آخر ردٍّ يُحفظ لكل مندوب (جهازٌ مشترك: لا يرى مندوبٌ سيارة زميله) بلحظة بدء الطلب، ودون اتصال يُعرض بوسم «غير متصل —
 * آخر تحديث». ويُطرح من «المتبقّي» ما في الصندوق من فواتير البيع — المنتظرة والمرفوضة والمحجوزة، والمرفوعة بعد بدء الجلب — بقاعدة
 * لقطة اللوط نفسها (vanLots.ts pendingOut: الكمية بالأساس، وإعادة الأساس بعد تحويل الصنف). والمرتجع المعلّق لا يُضاف: قد يكون
 * منتهياً أو تالفاً لا يُباع، والخادم يحكم عند الرفع. الصنف المتتبَّع باللوط يُعرض من لقطته (تطرح المعلّق بنفسها) فلا يُطرح مرتين.
 * نقيّ (بلا IndexedDB ولا شبكة) كي يُختبر.
 */
import type { OutboxDoc } from './offlineDb';
import { pendingOut, type PendingCatalogProduct } from './vanLots';

/** مفتاح الكاش المرجعي لكل مندوب — يمسحه refClear عند تبديل المندوب مع بقية البيانات المرجعية */
export const VAN_CURRENT_CACHE_PREFIX = 'van-current:';

/** ما يُحفظ: صفوف الردّ كما هي، وصاحبها، ولحظة بدء الطلب (ما رُفع بعدها لا تعرفه الصفوف) */
export interface VanCurrentCache<Row> { v: 1; repId: string; fetchedAt: number; rows: Row[] }

/** قراءة الكاش — لصاحب الجلسة وحده، وبشكلٍ صالح؛ وإلا null */
export function vanCurrentCacheOf<Row>(raw: unknown, repId: string | null | undefined): VanCurrentCache<Row> | null {
  if (!raw || typeof raw !== 'object' || !repId) return null;
  const c = raw as Partial<VanCurrentCache<Row>>;
  if (c.v !== 1 || c.repId !== repId || typeof c.fetchedAt !== 'number' || !Number.isFinite(c.fetchedAt) || !Array.isArray(c.rows)) return null;
  return c as VanCurrentCache<Row>;
}

/**
 * «المتبقّي» بعد طرح فواتير البيع في الصندوق (بالأساس) — pendingBase ما طُرح من كل صفّ، وpendingDocs عدد الفواتير التي طُرحت.
 * `skip`: أصنافٌ تُعرض من لقطة اللوط (لا تُطرح هنا). صنفٌ في الصندوق غائبٌ عن الصفوف لا يُخترع له صف.
 */
export function vanRowsWithPending<Row extends { productId: string; remaining: number }>(
  rows: readonly Row[], outbox: readonly OutboxDoc[], fetchedAt: number, repId: string | null | undefined,
  catalog?: readonly PendingCatalogProduct[] | null, skip?: ReadonlySet<string>,
): { rows: (Row & { pendingBase: number })[]; pendingDocs: number } {
  const pend = pendingOut(outbox, [], fetchedAt, repId, catalog);
  const ids = new Set(rows.map((r) => r.productId).filter((id) => !skip?.has(id) && (pend.get(id)?.total ?? 0) > 0));
  const out = rows.map((r) => {
    const p = ids.has(r.productId) ? Math.round((pend.get(r.productId)?.total ?? 0) * 10_000) / 10_000 : 0;
    return { ...r, remaining: p ? Math.round((r.remaining - p) * 10_000) / 10_000 : r.remaining, pendingBase: p };
  });
  // الفواتير التي طرحت شيئاً من هذه الصفوف — بالقاعدة نفسها (صاحب الجلسة، والبيع لا المرتجع)
  const pendingDocs = ids.size ? outbox.filter((d) => {
    if (d.kind !== 'invoice' || (d.repId && repId && d.repId !== repId)) return false;
    const p = d.payload as { type?: unknown; items?: unknown } | null;
    if (!p || p.type === 'RETURN' || !Array.isArray(p.items)) return false;
    const counted = d.status === 'queued' || d.status === 'rejected' || !!d.reviewCode
      || (d.status === 'sent' && !!d.sentAt && Date.parse(d.sentAt) >= fetchedAt);
    return counted && (p.items as { productId?: unknown }[]).some((it) => typeof it?.productId === 'string' && ids.has(it.productId));
  }).length : 0;
  return { rows: out, pendingDocs };
}
