/**
 * نافذة «استلام / تسوية» المستودع (الويب والجوال) — منطقٌ صرف بلا React ولا شبكة، يُختبر وحده (warehouseEntry.test.ts).
 * مراجعة المخزون (طلب المالك ٤ نوفمبر ٢٠٢٦):
 *  · D8 مفتاح المحاولة `clientRef`: مرجعٌ لكل محاولة حفظ يُعاد مع الإعادة (ضاع الردّ بعد أن بلغ الخادم ⇒ يردّ الحركة نفسها
 *    ولا يكتب ثانية)، وتغيّرُ محتوى النموذج ⇒ مرجعٌ جديد. نمط مستندات المندوب نفسه (attemptClientRef).
 *  · D3: ردّ 422 PRODUCT_ARCHIVED للوارد على صنفٍ محذوف — يُقرأ بصنفه وموضع سطره.
 *  · D1: «اجعل الرصيد صفراً» لصفّ تسوية — الكمية التي تُعيد الرصيد صفراً بالرئيسية حين ينقسم عليها، وإلّا بالأساس.
 */
import { attemptClientRef } from '../rep/liveGate';
import { newUuid } from './uuid';
import { QTY_EPS, primaryUnitOf, roundQty, type UnitDef } from './units';

/** مفتاح المحاولة السابق للنموذج (key = محتوى الجسم بلا المرجع) */
export type EntryAttempt = { key: string; ref: string } | null;

/**
 * مرجع المحاولة لجسمٍ بلا clientRef: المحتوى نفسه ⇒ المرجع نفسه، وغيره ⇒ مرجعٌ جديد. `fresh` للاختبار.
 * المرجع UUID (٣٦ حرفاً من [0-9a-f-]) داخل قيد الخادم (≤ ٦٤، [A-Za-z0-9_-]).
 */
export function entryAttempt(prev: EntryAttempt, body: unknown, fresh: () => string = newUuid): { key: string; ref: string } {
  return attemptClientRef(prev, body, fresh);
}

/** الخادم ردّ حركةً محفوظة من قبل بالمرجع نفسه (200) — `replay` في العقد، و`idempotent` نمط الفواتير والسندات */
export function isReplayResponse(body: unknown): boolean {
  const b = body as { replay?: unknown; idempotent?: unknown; data?: { replay?: unknown } } | null | undefined;
  return b?.replay === true || b?.idempotent === true || b?.data?.replay === true;
}

/** ردّ 422 PRODUCT_ARCHIVED: الصنف وموضع سطره في items كما أُرسلت (من الصفر) ورسالة الخادم العربية */
export interface ArchivedRefusal { productId: string; index: number | null; message: string | null }

export function productArchivedOf(e: unknown): ArchivedRefusal | null {
  const d = (e as { response?: { status?: number; data?: { code?: unknown; productId?: unknown; index?: unknown; message?: unknown } } })?.response?.data;
  if (!d || d.code !== 'PRODUCT_ARCHIVED' || typeof d.productId !== 'string') return null;
  return {
    productId: d.productId,
    index: typeof d.index === 'number' && Number.isInteger(d.index) && d.index >= 0 ? d.index : null,
    message: typeof d.message === 'string' && d.message.trim() ? d.message : null,
  };
}

/**
 * سطر التسوية الذي يُعيد الرصيد صفراً: الكمية عكس الرصيد — بالوحدة الرئيسية الصالحة حين ينقسم الرصيد عليها تماماً
 * (رصيد ٩٠٠٠ بيضة وكرتونه ٣٦٠ ⇒ −٢٥ كرتون)، وإلّا بالأساس كما هو (−٢٥ لصنفٍ أساسه الكرتون ⇒ +٢٥). رصيدٌ صفر ⇒ null.
 * `unitId` null = الأساس. عرضٌ وتعبئةٌ فقط: الخادم يحسب الأساس من المعامل كأي سطرٍ مكتوب.
 */
export function zeroAdjustStart(
  row: { unit?: string | null; units?: UnitDef[] | null; primaryUnitId?: string | null },
  onHand: number,
): { unitId: string | null; qty: number } | null {
  const q = roundQty(-(Number(onHand) || 0));
  if (Math.abs(q) <= QTY_EPS) return null;
  const prim = primaryUnitOf(row);
  const f = Number(prim?.factor);
  if (prim?.id && Number.isFinite(f) && f > 1) {
    const n = Math.abs(q) / f;
    if (n >= 1 - QTY_EPS && Math.abs(n - Math.round(n)) < QTY_EPS) return { unitId: prim.id, qty: Math.sign(q) * Math.round(n) };
  }
  return { unitId: null, qty: q };
}
