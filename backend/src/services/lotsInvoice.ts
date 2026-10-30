/**
 * «تتبّع اللوط» — توزيع بنود الفواتير (المرحلة الأولى والثانية) وحرّاس الإلغاء وإعادة المرتجع للمخزون.
 * هيكلٌ بتواقيعه من الأساس (المواصفة §٤.٠)؛ التنفيذ للحزمة B5 (§٤.٨، §٤.١٠–٤.١٣، §٤.١٨). لا يستورد إعداد القاعدة.
 */
import type { LotDb, LotTx } from './lotsDb';
import type { InvoiceLotAllocation, InvoiceLotPlan, ItemExpiryStamp, LotError } from './lots';

/**
 * داخل معاملة الإصدار، بعد assertReturnLinks وقبل tx.invoice.create: lockLotProducts ثم ClientRefRace ثم placeViews ثم
 * allocateOutLines لكل صنفٍ بأسطره (البيع: لكل سطرٍ كميته الأساسية ومعامل وحدته وصريحه أو تلميحه — D22، D16، D26) أو
 * allocateReturnFromSale (المرتجع المرتبط) أو الصريح/الفارغ (المرتجع الحرّ)، ثم stampFromRows لكل سطر، وإشعار LOT_REPLAY_FLAGGED.
 */
export async function allocateInvoiceLotsInTx(tx: LotTx, plan: InvoiceLotPlan): Promise<InvoiceLotAllocation> {
  void tx; void plan;
  throw new Error('NOT_IMPLEMENTED');
}

/** فحصٌ رخيص بلا قفل قبل openIssuanceSigning (ن٢-٣): ما سيُرفض حتماً لا يُوقَّع */
export async function precheckInvoiceLots(db: LotDb, plan: InvoiceLotPlan): Promise<LotError | null> {
  void db; void plan;
  throw new Error('NOT_IMPLEMENTED');
}

/** طلب لقطة «آخر بيع» للمرتجع الحرّ (§٤.٢٢): العميل وتاريخ الفاتورة ولحظة المرتجع، وأسطر الأصناف بفهارسها */
export interface FreeReturnStampsQuery {
  customerId: string; invoiceDate: Date; returnAt: Date;
  items: { idx: number; productId: string }[];
}

/** لقطة «آخر بيع» للمرتجع الحرّ محسوبةً قبل المعاملة — تغلّف freeReturnStamps في invoiceExpiry.ts */
export async function freeReturnStamps(db: LotDb, tid: string, q: FreeReturnStampsQuery): Promise<Map<number, ItemExpiryStamp>> {
  void db; void tid; void q;
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * إلغاء مرتجع (§٤.١٢): بنود المرتجع وصفوفها ⇒ lotRemovalsOf (البند بلا صفوف والصفّ قبل الحقبة على غير المسمّى، والمحجوز بلا
 * فحص؛ since = max(Tenant.lotTrackingSince, Product.lotTrackedSince)) ⇒ removalKeepsLots على عرض السيارة لكل صنف — الصالح بعد
 * الطرح ≥ −EPS للمسمّى (I1) و≥ min(0, قبله) − EPS للفارغ (I2)، وإلا 409 LOT_STOCK_INSUFFICIENT
 */
export async function assertReturnCancelKeepsLots(tx: LotTx, tid: string, invoiceId: string): Promise<void> {
  void tx; void tid; void invoiceId;
  throw new Error('NOT_IMPLEMENTED');
}

/** إعادة المرتجع للمخزون إلى false (§٤.١٣): القاعدة نفسها (lotRemovalsOf ثم removalKeepsLots) بدلو SELLABLE للبنود التي يوجّهها invEffect إليه */
export async function assertRestockOffKeepsLots(tx: LotTx, tid: string, invoiceId: string): Promise<void> {
  void tx; void tid; void invoiceId;
  throw new Error('NOT_IMPLEMENTED');
}
