/**
 * «تتبّع اللوط» — وارد المستودع وتسوياته، والتراجع عن الاستيراد الافتتاحي.
 * هيكلٌ بتواقيعه من الأساس (المواصفة §٤.٠)؛ التنفيذ للحزمة B3 (§٤.٤، §٤.٥). لا يستورد إعداد القاعدة.
 */
import type { LotTx } from './lotsDb';
import type { WarehouseEntryPlan, WarehouseEntryPlanInput } from './lots';

/**
 * داخل معاملة الحركة بعد lockLotProducts: RECEIVE ⇒ lotId أو lotNumber إلزامي (LOT_REQUIRED) وresolveOrCreateLot بمصدر RECEIVE؛
 * ADJUST+ ⇒ لوط أو رقم أو null صريح؛ ADJUST− ⇒ pickOutSources على المستودع بعد aggregateRequest.
 */
export async function planWarehouseEntryInTx(tx: LotTx, input: WarehouseEntryPlanInput): Promise<WarehouseEntryPlan> {
  void tx; void input;
  throw new Error('NOT_IMPLEMENTED');
}

/** حركة المستودع الافتتاحية المراد التراجع عنها */
export interface OpeningEntryRef { id: string; createdAt: Date; productIds: string[] }

/**
 * يُمنع التراجع إن وُجد بعد الحركة: VanLoadItemLot على لوطاتها، أو LotRelabel منها أو إليها، أو أسطر مستودع سالبة عليها،
 * أو نقصٌ يجعل صالح أي لوط منها سالباً — «استُعملت تشغيلات المخزون الافتتاحي بعد الاستيراد».
 */
export async function assertOpeningRevertKeepsLots(tx: LotTx, tid: string, entry: OpeningEntryRef): Promise<void> {
  void tx; void tid; void entry;
  throw new Error('NOT_IMPLEMENTED');
}

/** بعد حذف الحركة: لوطات sourceEntryId = entryId بلا أي مرجع تُحذف مع LotEvent DELETE — يعيد عددها */
export async function deleteOrphanOpeningLots(tx: LotTx, tid: string, entryId: string): Promise<number> {
  void tx; void tid; void entryId;
  throw new Error('NOT_IMPLEMENTED');
}
