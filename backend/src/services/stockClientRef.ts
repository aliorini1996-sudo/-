// ============================================================================
// مفتاح منع التكرار لحركات المخزون (مراجعة المخزون D8): POST /van-stock/loads وPOST /warehouse/entries.
// العميل يولّد clientRef واحداً لكل محاولة حفظ ويعيده عند إعادتها (ضاع الردّ بعد الحفظ)، فيردّ الخادم الحركة القائمة 200 بلا كتابة.
// ⚠️ بلا @@unique في القاعدة (القيد على جدولٍ مأهول يوقف db push): التفرّد في التطبيق — قفلٌ استشاري على (الشركة، المرجع) داخل
// معاملة الكتابة، ثم البحث بالمرجع، فلا يُنشئ طلبان متزامنان بالمرجع نفسه حركتين.
// ============================================================================
import { z } from 'zod';
import type { Prisma } from '@prisma/client';

/** المرجع: حتى ٦٤ حرفاً لاتينياً أو رقماً أو - أو _ (uuid يكفي) */
export const CLIENT_REF_SCHEMA = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'clientRef: حروف لاتينية وأرقام و - و _ حتى 64');

/** نوع الحركة في مفتاح القفل — فلا يتزاحم مرجع تحميلٍ ومرجع وارد */
export type StockRefKind = 'van-load' | 'warehouse-entry';

/** قفل المرجع داخل المعاملة (قفل معاملة لا جلسة) — أول ما في المعاملة، قبل أقفال الأصناف والمستودع */
export async function lockClientRef(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, kind: StockRefKind, tid: string, ref: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${kind}-ref:${tid}:${ref}`}))`;
}

/** فلتر ?clientRef= في القراءة: نصٌّ صالح وحده (qs قد يجعله كائناً) — وغيره يُهمل */
export function clientRefQuery(v: unknown): string | undefined {
  return typeof v === 'string' && CLIENT_REF_SCHEMA.safeParse(v).success ? v : undefined;
}

/**
 * وُجدت الحركة بمرجعها تحت القفل — يُرمى من داخل المعاملة فتُجهَض بلا كتابة، ويردّ المسار الحركة القائمة 200.
 * (طلبٌ مكرَّر تزامن مع الأصل فلم يجده البحث الأول خارج المعاملة)
 */
export class ClientRefReplay<T> extends Error {
  constructor(readonly row: T) { super('clientRef replay'); this.name = 'ClientRefReplay'; }
}
