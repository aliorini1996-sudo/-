/**
 * طلبا حرّاس نافذة الصنف وحذفه (lib/productGuards.ts) — لا يرميان: فشلهما ⇒ null فتتابع النافذة كما كانت (والخادم يحذّر بنفسه).
 */
import api from '../api/client';
import { nameMatchesOf, productNameKey, type NameMatch, type StockSummary } from './productGuards';

/** أصنافٌ بالاسم نفسه (بلا الصنف المستثنى) — null إن تعذّر السؤال (الخادم يحذّر في ردّ الحفظ على كل حال) */
export async function fetchNameMatches(name: string, excludeId?: string | null): Promise<NameMatch[] | null> {
  if (!productNameKey(name)) return [];
  try {
    const res = await api.get('/products/name-check', { params: { name: name.trim(), ...(excludeId ? { excludeId } : {}) } });
    return nameMatchesOf(res.data?.data?.matches);
  } catch { return null; }
}

/** رصيد الصنف الآن — null إن تعذّر */
export async function fetchStockSummary(productId: string): Promise<StockSummary | null> {
  try {
    const d = (await api.get(`/products/${productId}/stock-summary`)).data?.data as Partial<StockSummary> | undefined;
    if (!d || typeof d.vansBase !== 'number') return null;
    return {
      productId, warehouseBase: typeof d.warehouseBase === 'number' ? d.warehouseBase : null, vansBase: d.vansBase,
      vansSellableBase: typeof d.vansSellableBase === 'number' ? d.vansSellableBase : undefined,
      unit: String(d.unit ?? ''), units: Array.isArray(d.units) ? d.units : [], primaryUnitId: d.primaryUnitId ?? null,
    };
  } catch { return null; }
}
