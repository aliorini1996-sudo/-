/**
 * المندوب الذكي — تحويل محلٍّ مقترح إلى عميل.
 *
 * حين يُنشأ عميل ومعه aiPlaceId (من شاشة المندوب الذكي):
 *   1) يُعلَّم المحل في سجلّ الشركة «محوَّلاً» ويُربط بالعميل.
 *   2) تُحفظ **لقطة التوقّع** كما عُرضت للمندوب — تُقارن لاحقاً بمشترياته الفعلية لقياس دقّة المحرّك.
 * أي فشل هنا لا يُسقط إنشاء العميل (المستدعي يلتقطه).
 */
import prisma from '../config/database';
import { estimateOutlet, ENGINE_VERSION } from './estimate';
import { loadEstimateData } from './estimateData';
import { settingsView, AiRepSettingsView } from './settings';
import { isOutletType, outletTypeLabel } from './taxonomy';

export async function linkConvertedCustomer(
  tid: string,
  customer: { id: string; lat: number | null; lng: number | null; outletType: string | null; aiPlaceId: string | null },
  salesRepId: string | null,
): Promise<void> {
  if (!customer.aiPlaceId) return;
  const t = await prisma.tenant.findUnique({ where: { id: tid }, select: { aiRepEnabled: true, accountingEnabled: true } });
  if (t?.aiRepEnabled !== true) return;
  const outletType = isOutletType(customer.outletType) ? customer.outletType : null;
  const now = new Date();

  const outlet = await prisma.aiOutlet.upsert({
    where: { tenantId_placeId: { tenantId: tid, placeId: customer.aiPlaceId } },
    create: {
      tenantId: tid, placeId: customer.aiPlaceId, outletType: outletType ?? 'GROCERY', status: 'CONVERTED',
      lastOutcome: 'CONVERTED', lastOutcomeAt: now, lastSalesRepId: salesRepId, createdBySalesRepId: salesRepId,
      convertedCustomerId: customer.id, lat: customer.lat, lng: customer.lng,
    },
    update: { status: 'CONVERTED', lastOutcome: 'CONVERTED', lastOutcomeAt: now, lastSalesRepId: salesRepId, convertedCustomerId: customer.id },
  });

  if (!outletType || customer.lat == null || customer.lng == null) return;
  const row = await prisma.aiRepSettings.findUnique({ where: { tenantId: tid } });
  const settings = settingsView(row as Partial<AiRepSettingsView> | null);
  const data = await loadEstimateData(tid, { windowMonths: settings.estimateWindowMonths, priorityProductIds: settings.priorityProductIds });
  const r = estimateOutlet({
    target: { lat: customer.lat, lng: customer.lng, outletType, excludeCustomerId: customer.id },
    now, window: data.window, peers: data.peers, monthly: data.monthly, firstOrders: data.firstOrders,
    products: data.products, minPeers: settings.minPeers, showMoney: settings.showMoney && t.accountingEnabled !== false,
  }, outletTypeLabel(outletType));
  if (!r.ok) return;
  await prisma.aiEstimateSnapshot.create({
    data: {
      tenantId: tid, outletId: outlet.id, customerId: customer.id, engineVersion: ENGINE_VERSION, outletType,
      ringKm: r.ringKm, peers: r.peers, confidence: r.confidence, windowFrom: r.window.from, windowTo: r.window.to,
      payload: {
        monthlyTotalValue: r.monthlyTotalValue,
        products: r.products.map(p => ({
          productId: p.productId, penetration: p.penetration, monthlyQty: p.monthlyQty, firstOrderQty: p.firstOrderQty, trialQty: p.trialQty, confidence: p.confidence,
        })),
      } as object,
    },
  });
}
