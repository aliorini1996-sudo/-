/**
 * «تتبّع اللوط» — حركات السيارة ولقطة المندوب.
 * هيكلٌ بتواقيعه من الأساس (المواصفة §٤.٠)؛ التنفيذ للحزمة B4 (§٤.٧، §٧.١، D30). لا يستورد إعداد القاعدة.
 */
import type { LotDb, LotTx } from './lotsDb';
import type { VanLotSnapshotDto, VanMovementPlan, VanMovementPlanInput } from './lots';

/**
 * داخل معاملة الحركة بعد lockLotProducts (وبعد قفل الدلو وassertOutAvailable للإزالة): LOAD بالمستودع ⇒ allocateOut على عرض
 * المستودع (viaWarehouse)؛ بلا مستودع ⇒ لوطٌ صريح أو رقمٌ جديد أو null (D4)؛ UNLOAD/ADJUST− ⇒ pickOutSources على SELLABLE؛
 * EXPIRED_OUT/DAMAGED_OUT ⇒ pickOutSources على دلوهما؛ ADJUST+ ⇒ لوط أو رقم أو null. الكمية السالبة ⇒ LOT_QTY_INVALID (I7).
 */
export async function planVanMovementInTx(tx: LotTx, input: VanMovementPlanInput): Promise<VanMovementPlan> {
  void tx; void input;
  throw new Error('NOT_IMPLEMENTED');
}

/** لقطة سيارة المندوب (GET /van-stock/lot-balances) بلا قفل — الأصناف ذات الرصيد ومعها قائمة tracked كاملة */
export async function vanLotSnapshot(db: LotDb, tid: string, repId: string): Promise<VanLotSnapshotDto> {
  void db; void tid; void repId;
  throw new Error('NOT_IMPLEMENTED');
}
