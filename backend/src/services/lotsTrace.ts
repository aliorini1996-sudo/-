/**
 * «تتبّع اللوط» — شاشة التتبّع وخطة التنزيل وسلامة الأرصدة (قراءات بلا قفل).
 * هيكلٌ بتواقيعه من الأساس (المواصفة §٤.٠)؛ التنفيذ للحزمة B2 (§٤.١٦، §٤.١٧، و/lots/health). لا يستورد إعداد القاعدة.
 */
import type { LotDb } from './lotsDb';
import type { BucketQty, LotBucket, LotPlace, LotTraceDto } from './lots';

export interface LotTraceOptions {
  scope: 'STRICT' | 'BROAD';
  /** canManageCustomers — وإلا customersHidden */
  canSeeCustomers: boolean;
  /** شرط نطاق المستخدم المقيّد على الفواتير (scopedRecordWhere) — null لغير المقيّد */
  scopeWhere: Record<string, unknown> | null;
}

/** مصدر اللوط وأماكنه وعملاؤه (STRICT يُدرج صافي الصفر؛ BROAD يضيف نافذة رصيد الصنف) وسجلّه — كل التاريخ بلا حقبة */
export async function lotTrace(db: LotDb, tid: string, lotId: string, opts: LotTraceOptions): Promise<LotTraceDto> {
  void db; void tid; void lotId; void opts;
  throw new Error('NOT_IMPLEMENTED');
}

export interface UnloadPlanRow { salesRepId: string; repName: string | null; deleted: boolean; usable: BucketQty; held: BucketQty }

/** لكل سيارة فيها اللوط (ومنها المحذوفة): صالحه ومحجوزه — لتنزيله بعد الإيقاف أو السحب */
export async function unloadPlan(db: LotDb, tid: string, lotId: string): Promise<UnloadPlanRow[]> {
  void db; void tid; void lotId;
  throw new Error('NOT_IMPLEMENTED');
}

export interface LotHealthDto {
  deficits: { productId: string; place: LotPlace; salesRepId: string | null; lotId: string | null; bucket: LotBucket; qty: number }[];
}

/** العجوزات لكل الأصناف المتتبَّعة والأماكن (بدل مهمة مجدولة: القاعدة هي العنق الضيّق) */
export async function lotHealth(db: LotDb, tid: string): Promise<LotHealthDto> {
  void db; void tid;
  throw new Error('NOT_IMPLEMENTED');
}
