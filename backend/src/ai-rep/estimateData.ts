/**
 * المندوب الذكي — تحميل بيانات المحرّك من القاعدة (قراءة فقط، معزولة بالشركة دائماً).
 *
 * ثلاثة استعلامات مجمّعة في القاعدة (لا تحميل بنود خام إلى الذاكرة):
 *   1) صافي كل (عميل، صنف، شهر) داخل النافذة — المرتجع سالب، والقيمة بلا ضريبة.
 *   2) أول وآخر فاتورة بيع لكل عميل (الأقدمية والنشاط).
 *   3) بنود الفاتورة الأولى لكل عميل (أول طلب).
 * العزل: كل استعلام مقيّد بـ`invoices.tenantId` لأن invoice_items لا تحمل tenantId.
 * ذاكرة مؤقتة لكل شركة ١٠ دقائق (البيانات شهرية، والرقم لا يتغيّر بفاتورة اليوم).
 */
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { importTimezone } from '../services/importLedger';
import { completeWindow, ymInTz, EngineProduct, FirstOrderLine, PeerCustomer, PeerProductMonth } from './estimate';

export interface TenantEstimateData {
  timezone: string;
  window: { from: string; to: string };
  peers: PeerCustomer[];
  monthly: PeerProductMonth[];
  firstOrders: FirstOrderLine[];
  products: EngineProduct[];
}

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; data: Promise<TenantEstimateData> }>();

/** يُستدعى بعد تغيير الإعدادات أو تصنيف العملاء كي لا يُعرض توقّع قديم. */
export function invalidateEstimateData(tenantId: string): void {
  for (const k of cache.keys()) if (k.startsWith(`${tenantId}|`)) cache.delete(k);
}

export async function loadEstimateData(tenantId: string, opts: { windowMonths: number; priorityProductIds: string[]; now?: Date }): Promise<TenantEstimateData> {
  const now = opts.now ?? new Date();
  const gl = await prisma.glSettings.findUnique({ where: { tenantId }, select: { timezone: true, activatedAt: true, setupDraft: true } });
  const timezone = importTimezone(gl);
  const window = completeWindow(ymInTz(now, timezone), opts.windowMonths);
  const key = `${tenantId}|${window.from}|${window.to}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return withPriority(await hit.data, opts.priorityProductIds);
  const data = fetchData(tenantId, timezone, window);
  cache.set(key, { at: Date.now(), data });
  data.catch(() => cache.delete(key));
  return withPriority(await data, opts.priorityProductIds);
}

function withPriority(d: TenantEstimateData, priority: string[]): TenantEstimateData {
  const set = new Set(priority);
  return { ...d, products: d.products.map(p => ({ ...p, priority: set.has(p.id) })) };
}

/** حدود UTC واسعة بيوم من كل طرف؛ التصفية الدقيقة بالشهر المحلي في المحرّك. */
function utcBounds(window: { from: string; to: string }): { from: Date; to: Date } {
  const [fy, fm] = window.from.split('-').map(Number);
  const [ty, tm] = window.to.split('-').map(Number);
  return { from: new Date(Date.UTC(fy, fm - 1, 1) - 86400000), to: new Date(Date.UTC(ty, tm, 1) + 86400000) };
}

async function fetchData(tenantId: string, timezone: string, window: { from: string; to: string }): Promise<TenantEstimateData> {
  const b = utcBounds(window);
  const [customers, tenure, monthlyRows, firstRows, products] = await Promise.all([
    prisma.customer.findMany({
      where: { tenantId, status: 'ACTIVE', outletType: { not: null }, lat: { not: null }, lng: { not: null } },
      select: { id: true, lat: true, lng: true, outletType: true },
    }),
    prisma.$queryRaw<Array<{ customerId: string; first: Date; last: Date }>>(Prisma.sql`
      SELECT "customerId", MIN("invoiceDate") AS "first", MAX("invoiceDate") AS "last"
      FROM invoices
      WHERE "tenantId" = ${tenantId} AND status = 'CONFIRMED' AND type IN ('CASH', 'CREDIT')
      GROUP BY "customerId"`),
    prisma.$queryRaw<Array<{ customerId: string; productId: string; ym: string; qty: number; value: number }>>(Prisma.sql`
      SELECT i."customerId" AS "customerId", ii."productId" AS "productId",
             to_char((i."invoiceDate" AT TIME ZONE 'UTC') AT TIME ZONE ${timezone}, 'YYYY-MM') AS ym,
             SUM(CASE WHEN i.type = 'RETURN' THEN -ii.qty ELSE ii.qty END)::float8 AS qty,
             SUM(CASE WHEN i.type = 'RETURN' THEN -(ii."lineTotal" - ii."taxAmt") ELSE (ii."lineTotal" - ii."taxAmt") END)::float8 AS value
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii."invoiceId"
      WHERE i."tenantId" = ${tenantId} AND i.status = 'CONFIRMED' AND i.type IN ('CASH', 'CREDIT', 'RETURN')
        AND ii."productId" IS NOT NULL
        AND i."invoiceDate" >= ${b.from} AND i."invoiceDate" < ${b.to}
      GROUP BY 1, 2, 3`),
    prisma.$queryRaw<Array<{ customerId: string; productId: string; qty: number }>>(Prisma.sql`
      WITH f AS (
        SELECT DISTINCT ON (i."customerId") i.id, i."customerId"
        FROM invoices i
        WHERE i."tenantId" = ${tenantId} AND i.status = 'CONFIRMED' AND i.type IN ('CASH', 'CREDIT')
        ORDER BY i."customerId", i."invoiceDate" ASC, i.id ASC
      )
      SELECT f."customerId" AS "customerId", ii."productId" AS "productId", SUM(ii.qty)::float8 AS qty
      FROM f JOIN invoice_items ii ON ii."invoiceId" = f.id
      WHERE ii."productId" IS NOT NULL
      GROUP BY 1, 2`),
    prisma.product.findMany({
      where: { tenantId, status: 'ACTIVE', deletedAt: null },
      select: { id: true, name: true, unit: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const byCustomer = new Map(tenure.map(t => [t.customerId, t]));
  const peers: PeerCustomer[] = customers.map(c => {
    const t = byCustomer.get(c.id);
    return {
      id: c.id, lat: c.lat as number, lng: c.lng as number, outletType: c.outletType as string,
      firstYm: t ? ymInTz(new Date(t.first), timezone) : null,
      lastInvoiceAt: t ? new Date(t.last) : null,
    };
  });

  return {
    timezone,
    window,
    peers,
    monthly: monthlyRows.map(r => ({ customerId: r.customerId, productId: r.productId, ym: r.ym, qty: Number(r.qty) || 0, value: Number(r.value) || 0 })),
    firstOrders: firstRows.map(r => ({ customerId: r.customerId, productId: r.productId, qty: Number(r.qty) || 0 })),
    products: products.map(p => ({ id: p.id, name: p.name, unit: p.unit })),
  };
}
