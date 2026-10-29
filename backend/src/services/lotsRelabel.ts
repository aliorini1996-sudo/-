/**
 * «تتبّع اللوط» — تسمية الرصيد القائم وإعادة التصنيف (بُعد اللوط وحده: لا يغيّر رصيد الصنف ولا التقييم، R9).
 * هيكلٌ بتوقيعه من الأساس (المواصفة §٤.٠)؛ التنفيذ للحزمة B2 (§٤.٦). لا يستورد إعداد القاعدة.
 */
import type { LotTx } from './lotsDb';
import type { RelabelInput } from './lots';

/**
 * داخل المعاملة بعد lockLotProducts: قيود المصدر (D27: الموقوف LOT_BLOCKED، والمنتهي LOT_EXPIRED، والفارغ ≤ unknownUsable
 * (I2)، واللوط ≤ صالحه (I1))، ثم الوجهة (حلّ أو إنشاء بمصدر RELABEL؛ null تتطلب CORRECTION وملاحظة)، ثم صفّ LotRelabel لكل
 * سطر وLotEvent RELABEL. from == to أو غياب الطرفين ⇒ LOT_RELABEL_INVALID.
 */
export async function relabelInTx(tx: LotTx, input: RelabelInput): Promise<{ rows: number }> {
  void tx; void input;
  throw new Error('NOT_IMPLEMENTED');
}
