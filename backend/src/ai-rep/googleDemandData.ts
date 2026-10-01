/**
 * المندوب الذكي — بيانات «الطلب المتوقع من ملف المحل في Google» (قراءة فقط، معزولة بالشركة دائماً):
 *   - مرساة كل صنف (وحدة القياس وحدها): وسيط كميته في بند فاتورة بيع مؤكَّدة (نقدي/آجل) خلال ٦ أشهر، وسعر وحدته
 *     المعتاد بلا ضريبة، وعدد فواتيره — استعلامٌ مجمَّع واحد لكل شركة بذاكرة ١٠ دقائق (كبيانات التوقّع). صنفٌ في أقل من
 *     ٣ فواتير بلا مرساة (لا يكشف الرقمُ طلبَ عميلٍ بعينه).
 *     العزل: invoice_items بلا tenantId ⇒ عبر فاتورةٍ مقيّدة بـinvoices."tenantId".
 *   - «الأصناف التي مع المندوب»: مخزون سيارته الآن (computeStock — المتبقّي > ٠، الفعّال غير المؤرشف) بترتيب الكمية؛
 *     سيارةٌ فارغة ⇒ المنتجات ذات الأولوية، ثم أكثر الأصناف فواتيراً — والمصدر يُقال للمندوب.
 */
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import type { Anchor, DemandProduct, ProductsSource } from './googleDemand';

export const ANCHOR_MONTHS = 6;
export const MIN_ANCHOR_INVOICES = 3;
const TTL_MS = 10 * 60 * 1000;
const MAX_PRODUCTS = 40;
const cache = new Map<string, { at: number; data: Promise<Map<string, Anchor>> }>();

/** للاختبارات. */
export function clearAnchorCache(): void { cache.clear(); }

export interface AnchorRow { productId: string; qty: number | null; price: number | null; invoices: number | null }

/** صفوف الاستعلام ← مرساة لكل صنف (أقل من MIN_ANCHOR_INVOICES فاتورة أو كمية غير موجبة ⇒ بلا مرساة). */
export function anchorsFrom(rows: AnchorRow[]): Map<string, Anchor> {
  const out = new Map<string, Anchor>();
  for (const r of rows) {
    const qty = Number(r.qty), invoices = Number(r.invoices) || 0, price = r.price == null ? null : Number(r.price);
    if (!r.productId || !Number.isFinite(qty) || qty <= 0 || invoices < MIN_ANCHOR_INVOICES) continue;
    out.set(r.productId, { qty, price: price != null && Number.isFinite(price) && price > 0 ? price : null, invoices });
  }
  return out;
}

/** مرساة كل صنف للشركة (بذاكرة ١٠ دقائق؛ الفشل لا يُحفظ). */
export async function loadAnchors(tid: string, now = new Date()): Promise<Map<string, Anchor>> {
  const hit = cache.get(tid);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const since = new Date(now.getTime());
  since.setUTCMonth(since.getUTCMonth() - ANCHOR_MONTHS);
  const data = prisma.$queryRaw<AnchorRow[]>(Prisma.sql`
    SELECT ii."productId" AS "productId",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ii.qty)::float8 AS qty,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY (ii."lineTotal" - ii."taxAmt") / ii.qty)::float8 AS price,
           COUNT(DISTINCT i.id)::int AS invoices
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii."invoiceId" AND i."tenantId" = ${tid}
    WHERE i.status = 'CONFIRMED' AND i.type IN ('CASH', 'CREDIT')
      AND ii."productId" IS NOT NULL AND ii.qty > 0
      AND i."invoiceDate" >= ${since}
    GROUP BY 1`).then(anchorsFrom);
  if (cache.size > 500) cache.clear();
  cache.set(tid, { at: Date.now(), data });
  data.catch(() => cache.delete(tid));
  return data;
}

type StockOf = (tid: string, repId: string) => Promise<{ productId: string; remaining: number }[]>;

/** مخزون سيارة المندوب الآن — مسار مخزون السيارة يُحمَّل عند الحاجة (موجّهه يحمل حرّاس المحاسبة). */
const vanStockOf: StockOf = async (tid, repId) => (await import('../routes/vanStock')).computeStock(tid, repId);

/** أصناف «الطلب المتوقع» للمندوب: سيارته أولاً، وإلا ذات الأولوية، وإلا الأكثر فواتيراً — فعّالة غير مؤرشفة. */
export async function loadDemandProducts(tid: string, repId: string, priorityIds: string[], anchors: Map<string, Anchor>,
  stockOf: StockOf = vanStockOf): Promise<{ products: DemandProduct[]; source: ProductsSource }> {
  const live = async (ids: string[]): Promise<DemandProduct[]> => {
    if (!ids.length) return [];
    const rows = await prisma.product.findMany({ where: { tenantId: tid, id: { in: ids }, status: 'ACTIVE', deletedAt: null }, select: { id: true, name: true, unit: true } });
    const byId = new Map(rows.map(r => [r.id, r]));
    return ids.map(id => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r).slice(0, MAX_PRODUCTS)
      .map(r => ({ productId: r.id, name: r.name, unit: r.unit }));
  };
  const stock = (await stockOf(tid, repId)).filter(r => r.remaining > 0).sort((a, b) => b.remaining - a.remaining);
  const van = await live(stock.map(r => r.productId));
  if (van.length) return { products: van, source: 'VAN' };
  const pri = await live(priorityIds);
  if (pri.length) return { products: pri, source: 'PRIORITY' };
  const top = [...anchors.entries()].sort((a, b) => b[1].invoices - a[1].invoices).map(([id]) => id).slice(0, MAX_PRODUCTS);
  return { products: await live(top), source: 'CATALOG' };
}
